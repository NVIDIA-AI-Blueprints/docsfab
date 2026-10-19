// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { frozenHostCompositionIdForEndpoint } from "../config/execution-profile.js";
import { redactCredentialMaterial } from "../security/credential-material.js";
import { limit, limitDefinition } from "../config/limits.js";
import { parseAnswerSubmissionOption } from "../config/answer-submission.js";
import type { ProviderTransport } from "../config/model-providers.js";
import {
  endpointOriginDisplay,
  isOperatorOverride,
  reasoningEffortDecision,
  type ModelSettingKey,
  type ModelSlotSettingsV1,
} from "../config/model-settings.js";
import {
  assertInstalledDeploymentBaseUrl,
  listInstalledModelCompositions,
  loadInstalledModelCompositionAuthority,
  measuredReasoningControlForModel,
  recordedAnswerSubmissionForModel,
  resolveInstalledDeploymentEndpoint,
  resolveInstalledExecutableComposition,
  type BoundExecutableComposition,
  type BoundInstalledComposition,
  type InstalledModelCompositionAuthority,
  type InstalledModelCompositionSummary,
  type CompositionModelLimits,
} from "../model-composition/index.js";
import {
  deriveAnswerSubmissionRecordsFit,
  deriveAnswerSubmissionRecordsMessageBudget,
  type AnswerSubmissionRecordsFit,
} from "../model-composition/answer-submission-record-fit.js";
import { ModelCompositionError } from "../model-composition/types.js";
import { carriesReasoning, reasoningWireNotes } from "./reasoning-wire.js";
import {
  bindModelExecutionProfile,
  bindModelExecutionIdentity,
  type BoundModelExecutionProfile,
  type ModelEndpointConfig,
  type ModelProfile,
  type ProviderCredential,
  requestedReasoning,
} from "./configuration.js";

/** Workflow used only to satisfy the installed resolver when the caller has none. */
export const OPERATOR_COMPOSITION_BIND_WORKFLOW_ID = "review-documentation";

/** Single NEXT for unknown YAML provenance that does not uniquely match. */
export const UNMATCHED_BYO_NEXT_COMMAND = "docsfab profile probe";

export type OperatorExecutionMatch = "installed-composition" | "unmatched-byo";

export interface ResolveOperatorExecutionBindingInput {
  readonly model: ModelEndpointConfig;
  /** Explicit `--composition` selection. */
  readonly compositionId?: string;
  readonly workflowId?: string;
  readonly environment?: NodeJS.ProcessEnv;
  /** Host limit vector. The composition path supplies the real host env clamps. */
  readonly configuredLimits?: CompositionModelLimits;
  /** Attach compositionPolicy ceilings. Only the composition path sets this. */
  readonly attachCompositionPolicy?: boolean;
  /** Credential already resolved from the composition's declared sources. */
  readonly credential?: ProviderCredential;
  /** Pre-resolved executable composition; skips a second installed resolve. */
  readonly bound?: BoundExecutableComposition;
}

export interface OperatorExecutionBinding extends OperatorExecutionIdentityBinding {
  readonly credential: ProviderCredential;
}

/** Resolved route/profile identity without resolving or attaching a credential. */
export interface OperatorExecutionIdentityBinding {
  readonly profile: BoundModelExecutionProfile;
  readonly match: OperatorExecutionMatch;
  readonly bound?: BoundExecutableComposition;
  /** Present when unmatched YAML/config skips DocsFab context admission. */
  readonly operatorNotice?: string;
  /**
   * The loaded settings with their sources, and every warning the binding
   * adds. Absent for a configuration built in code.
   */
  readonly modelSettings?: ModelSlotSettingsV1;
  /** Warnings about values that differ from the preset; recorded, never refused. */
  readonly notes: readonly string[];
}

let authorityCache:
  | Promise<{
      authority: InstalledModelCompositionAuthority;
    }>
  | undefined;

function loadAuthority(): Promise<{ authority: InstalledModelCompositionAuthority }> {
  authorityCache ??= loadInstalledModelCompositionAuthority();
  return authorityCache;
}

/**
 * Bind model-profile YAML/config or an explicit executable composition to one
 * executable installed record. Unique `(providerId, baseUrl, modelId)` match
 * attaches that composition's route, transport, request policy, and operational
 * limits without resolving a credential. Ambiguous or required-policy-missing
 * matches fail closed. Unmatched unattested YAML skips DocsFab context admission.
 */
export async function resolveOperatorExecutionIdentity(
  input: ResolveOperatorExecutionBindingInput,
): Promise<OperatorExecutionIdentityBinding> {
  const workflowId = input.workflowId ?? OPERATOR_COMPOSITION_BIND_WORKFLOW_ID;
  const environment = input.environment ?? process.env;
  // The preset is selected by id: an explicit `--composition`, then the
  // preset the loaded settings name (the `--composition` a configuration was
  // loaded with), then the host selection the loaded endpoint carries; never
  // inferred from an overridden URL.
  const selectedCompositionId =
    input.compositionId ??
    input.model.modelSettings?.presetId ??
    input.model.compositionId ??
    frozenHostCompositionIdForEndpoint(input.model, environment);
  const { authority } = await loadAuthority();
  if (input.bound) {
    return bindExplicitComposition({
      ...input,
      authority,
      workflowId,
      environment,
      bound: input.bound,
    });
  }
  if (selectedCompositionId) {
    return bindExplicitComposition({
      ...input,
      authority,
      workflowId,
      environment,
      bound: resolveInstalledExecutableComposition({
        authority,
        compositionId: selectedCompositionId,
        workflowId,
      }),
    });
  }

  const matches = findUniqueInstalledMatches(authority, input.model);
  if (matches.length > 1) {
    const ids = matches.map((entry) => entry.compositionId).join(", ");
    // hygiene: envelope
    throw new ModelCompositionError(
      "contract-invalid-value",
      `Configured provider, endpoint, and model match ${String(matches.length)} installed compositions (${ids}); DocsFab requires a unique match.`,
      "Set MODEL_PROVIDER, MODEL_BASE_URL, and MODEL_ID to one listed composition from `docsfab composition list`.",
    );
  }
  if (matches.length === 1) {
    return bindExplicitComposition({
      ...input,
      authority,
      workflowId,
      bound: resolveInstalledExecutableComposition({
        authority,
        compositionId: matches[0]!.compositionId,
        workflowId,
      }),
    });
  }
  return unmatchedByoIdentityBinding(input.model, authority);
}

/** Resolve the same execution identity and then attach its live request credential. */
export async function resolveOperatorExecutionBinding(
  input: ResolveOperatorExecutionBindingInput,
): Promise<OperatorExecutionBinding> {
  const identity = await resolveOperatorExecutionIdentity(input);
  const credential =
    input.credential ??
    (identity.bound
      ? resolveCompositionCredential(identity.bound, input.model, input.environment ?? process.env)
      : bindModelExecutionProfile(input.model).credential);
  return { ...identity, credential };
}

export function formatUnmatchedByoOperatorNotice(
  profile: ModelProfile | undefined,
): string | undefined {
  if (
    profile?.effectiveLimitReason !== "metadata-unknown" &&
    profile?.effectiveLimitReason !== "metadata-stale"
  ) {
    return undefined;
  }
  return [
    "DocsFab is not applying a host context ceiling: this YAML/config does not uniquely match an installed composition, so the provider enforces the window.",
    `NEXT ${UNMATCHED_BYO_NEXT_COMMAND}`,
  ].join("\n");
}

/**
 * The operator named a credential variable the selected preset does not read.
 * Refused before any request: a preset names the variables its key comes from.
 */
export class CompositionCredentialSourceError extends Error {
  readonly code = "invalid-model-profile-configuration" as const;
  readonly nextAction: string;

  constructor(input: {
    readonly named: string;
    readonly compositionId: string;
    readonly reads: readonly string[];
  }) {
    const reads = input.reads.join(" or ");
    super(
      `MODEL_CREDENTIAL_ENV (the credentialEnv setting) names ${input.named}, which composition ${input.compositionId} does not read; it reads ${reads}.`,
    );
    this.name = "CompositionCredentialSourceError";
    this.nextAction = `Set credentialEnv to ${reads}, or remove it, keep the key in that variable, and retry.`;
  }
}

export function compositionCredentialFamily(value: string): ProviderCredential["family"] {
  if (
    value !== "nvidia-inference-api" &&
    value !== "nvidia-api-catalog" &&
    value !== "openai-api" &&
    value !== "anthropic-api"
  ) {
    throw new Error("The selected composition credential family is not executable here.");
  }
  return value;
}

function findUniqueInstalledMatches(
  authority: InstalledModelCompositionAuthority,
  model: ModelEndpointConfig,
): InstalledModelCompositionSummary[] {
  const matches: InstalledModelCompositionSummary[] = [];
  for (const summary of listInstalledModelCompositions(authority)) {
    if (
      summary.executionClass !== "pi-provider" ||
      summary.routeId !== model.providerId ||
      (model.transport !== undefined && summary.transport !== model.transport) ||
      summary.modelId !== model.modelId
    ) {
      continue;
    }
    try {
      assertInstalledDeploymentBaseUrl({
        authority,
        compositionId: summary.compositionId,
        baseUrl: model.baseUrl,
      });
    } catch (error) {
      if (error instanceof ModelCompositionError && error.code === "deployment-binding-mismatch") {
        continue;
      }
      throw error;
    }
    matches.push(summary);
  }
  return matches;
}

/** The transports each route is known to serve; another one runs and is warned about. */
const KNOWN_ROUTE_TRANSPORTS: Readonly<Record<string, readonly ProviderTransport[]>> = {
  "nvidia-inference-api": ["openai-chat-completions"],
  "nvidia-api-catalog": ["openai-chat-completions"],
  "openai-api": ["openai-responses", "openai-chat-completions"],
  "anthropic-api": ["anthropic-messages"],
};

function bindExplicitComposition(input: {
  readonly model: ModelEndpointConfig;
  readonly authority: InstalledModelCompositionAuthority;
  readonly bound: BoundExecutableComposition;
  readonly workflowId: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly configuredLimits?: CompositionModelLimits;
  readonly attachCompositionPolicy?: boolean;
  readonly credential?: ProviderCredential;
}): OperatorExecutionIdentityBinding {
  const { bound, model } = input;
  const composition = bound.composition;
  const compositionId = composition.compositionId;
  const routeId = composition.deployment.routeId;
  const settings = model.modelSettings;
  const notes: string[] = [];
  // The route is the preset itself; choosing another route means choosing another preset.
  if (model.providerId !== routeId) {
    notes.push(
      `The configured provider route ${model.providerId} is not preset ${compositionId}'s route; the run uses the preset's route ${routeId}. Select a preset for that route to change it.`,
    );
  }
  if (model.modelId.includes(":")) {
    // hygiene: envelope
    throw new ModelCompositionError(
      "contract-invalid-value",
      `The configured model id "${model.modelId}" contains ":", which DocsFab run records cannot hold yet.`,
      'Set the model id without ":" through MODEL_ID or --set modelId, then retry.',
    );
  }
  const transport = model.transport ?? composition.deployment.transport;
  if (
    transport !== composition.deployment.transport &&
    !(KNOWN_ROUTE_TRANSPORTS[routeId] ?? []).includes(transport)
  ) {
    notes.push(
      `Transport ${transport} is not one route ${routeId} is known to serve (preset ${compositionId} uses ${composition.deployment.transport}); DocsFab sends it as configured.`,
    );
  }
  const apiFormat =
    transport === "anthropic-messages" ? ("messages" as const) : ("chat_completions" as const);
  const deployment = resolveInstalledDeploymentEndpoint({
    authority: input.authority,
    compositionId,
    baseUrl: model.baseUrl,
    transport,
  });
  // A loaded configuration's settings record already names each difference
  // and its source; a configuration built in code is warned about here.
  if (settings === undefined) {
    const presetEndpoint = resolveInstalledDeploymentEndpoint({
      authority: input.authority,
      compositionId,
      baseUrl: model.baseUrl,
    }).presetDeployment;
    if (!presetEndpoint) {
      notes.push(
        `The configured endpoint ${endpointOriginDisplay(model.baseUrl)} differs from preset ${compositionId}'s own; DocsFab runs it as configured.`,
      );
    }
    if (model.modelId !== composition.model.resolvedId) {
      notes.push(
        `The configured model ${model.modelId} differs from preset ${compositionId}'s ${composition.model.resolvedId}; DocsFab runs it as configured.`,
      );
    }
  }
  const policy = composition.requestPolicy;
  // The request policy turns reasoning off. The effective decision alone
  // decides whether it applies: reasoning on, from an operator's `reasoning:
  // true` or an effort it keeps, runs without the policy; an operator's
  // `reasoning: false` drops any effort, with a note, and keeps the policy.
  const reasoningSetByOperator =
    settings !== undefined &&
    (isOperatorOverride(settings.settings.reasoning) ||
      isOperatorOverride(settings.settings.reasoningEffort)) &&
    reasoningEffortDecision(settings).reasoning === true;
  const policyApplies =
    policy !== undefined &&
    policy.modelId === model.modelId &&
    transport === "openai-chat-completions" &&
    !reasoningSetByOperator;
  if (policy !== undefined && !policyApplies) {
    notes.push(
      `Preset ${compositionId}'s request policy fixes model ${policy.modelId} over openai-chat-completions with reasoning off; this run's ${policy.modelId !== model.modelId ? "model" : transport !== "openai-chat-completions" ? "transport" : "reasoning setting"} differs, so requests are sent without it.`,
    );
  } else if (policy === undefined && routeId === "nvidia-api-catalog") {
    notes.push(
      `Preset ${compositionId} on nvidia-api-catalog declares no request policy; requests are sent without one.`,
    );
  }
  const configuredLimits = input.configuredLimits ?? omittedModeHostLimits(model);
  const profile = compositionExecutionProfile({
    model,
    bound,
    configuredLimits,
    hostLimitsGiven: input.configuredLimits !== undefined,
    normalizedBaseUrl: deployment.normalizedBaseUrl,
    transport,
    apiFormat,
    attachCompositionPolicy: input.attachCompositionPolicy === true,
    policyApplies,
  });
  if (profile.answerSubmission === undefined && composition.answerSubmission !== undefined) {
    notes.push(
      `Preset ${compositionId} recorded its answer submission for model ${composition.model.resolvedId}; model ${model.modelId} answers in text instead.`,
    );
  }
  const environment = input.environment ?? process.env;
  if (
    composition.answerSubmissionRecords &&
    parseAnswerSubmissionOption(environment) === "recorded"
  ) {
    assertAnswerSubmissionRecordsFit({
      bound,
      effectiveLimits: {
        maxOutputTokens: profile.profile.maxOutputTokens,
        maxProviderTurns:
          profile.compositionPolicy?.maxProviderTurns ??
          minimum(
            limit("compositionExecution.maxProviderTurns", { environment }).value,
            bound.candidate.proposedLimits.maxProviderTurns,
            composition.compositionLimits.maxProviderTurns,
            bound.compositionCeiling.maxProviderTurns,
          ),
        timeoutMs:
          profile.compositionPolicy?.timeoutMs ??
          minimum(
            limit("compositionExecution.timeoutMs", { environment }).value,
            bound.candidate.proposedLimits.timeoutMs,
            composition.compositionLimits.timeoutMs,
            bound.compositionCeiling.timeoutMs,
          ),
      },
      environment,
    });
  }
  // What the request sends for reasoning, where it is not the effort as written.
  notes.push(...reasoningWireNotes(profile, requestedReasoning(model)));
  // A note can name a configured value; credential material in it is never
  // shown or recorded.
  const allNotes = [...(settings?.notes ?? []), ...notes].map(redactCredentialMaterial);
  return {
    profile,
    match: "installed-composition",
    bound,
    ...(settings ? { modelSettings: { ...settings, notes: allNotes } } : {}),
    notes: allNotes,
  };
}

/**
 * Compute the fit for already sealed records evidence and the effective
 * composition clamps. No probe or corpus files are read at runtime.
 */
export function answerSubmissionRecordsFitForEffectiveLimits(input: {
  readonly bound: BoundInstalledComposition;
  readonly effectiveLimits: {
    readonly maxOutputTokens: number;
    readonly maxProviderTurns: number;
    readonly timeoutMs: number;
  };
  readonly environment?: NodeJS.ProcessEnv;
}):
  | (AnswerSubmissionRecordsFit & {
      readonly effectiveMaxMessageBytes: number;
      readonly largestRecordEnvelopeBytes: number;
      readonly maxProviderTurns: number;
      readonly minimumQualifiedMessageBytes: number;
    })
  | undefined {
  const environment = input.environment ?? process.env;
  const record = input.bound.composition.answerSubmissionRecords;
  if (!record || parseAnswerSubmissionOption(environment) === "text-final") {
    return undefined;
  }
  const samples = record.step8TurnEvidence.samples;
  if (samples.length === 0) return undefined;
  const d3ResidualFires = samples.some((sample) => sample.d3ResidualFires === true)
    ? true
    : samples.every((sample) => sample.d3ResidualFires === false)
      ? false
      : "unknown";
  const effectiveMaxMessageBytes = deriveAnswerSubmissionRecordsMessageBudget({
    effectiveMaxOutputTokens: input.effectiveLimits.maxOutputTokens,
    allowanceShareBasisPoints: limit("inference.answerRecordAllowanceShareBasisPoints", {
      environment,
    }).value,
    bytesPerTokenFloorMilli: limit("inference.answerRecordBytesPerTokenFloorMilli", {
      environment,
    }).value,
    qualifiedMessageBytes: record.phaseBMaxAdmittedMessageBytes,
    minimumQualifiedMessageBytes: record.minimumQualifiedMessageBytes,
    sealedMessageCeiling: record.maxMessageBytes,
  });
  const fit = deriveAnswerSubmissionRecordsFit({
    groupEnvelopeBytes: record.groupEnvelopeBytes,
    maxMessageBytes: effectiveMaxMessageBytes,
    minimumQualifiedMessageBytes: record.minimumQualifiedMessageBytes,
    fullPlanEnvelopeBytes: record.fullPlanEnvelopeBytes,
    largestRecordEnvelopeBytes: record.largestRecordEnvelopeBytes,
    bytesPerTokenFloorMilli: limit("inference.answerRecordBytesPerTokenFloorMilli", { environment })
      .value,
    decodeTokensPerSecond: record.decodeTokensPerSecond,
    projectedReportTokens: record.step8TurnEvidence.projectedReportTokens,
    lturnMs: record.lturnMs,
    d3ResidualFires,
    readingTurnsP90: record.readingTurnsP90,
    maxProviderTurns: input.effectiveLimits.maxProviderTurns,
    effectiveTimeoutMs: input.effectiveLimits.timeoutMs,
    timerReviewLimitMs: limit("sealed.answerSubmission.maxPredictedTimerMs", {
      environment,
    }).value,
    answerNowElapsedShareBasisPoints: limit(
      "compositionExecution.answerNowElapsedShareBasisPoints",
      { environment },
    ).value,
  });
  return {
    ...fit,
    effectiveMaxMessageBytes,
    largestRecordEnvelopeBytes: record.largestRecordEnvelopeBytes,
    maxProviderTurns: input.effectiveLimits.maxProviderTurns,
    minimumQualifiedMessageBytes: record.minimumQualifiedMessageBytes,
  };
}

function assertAnswerSubmissionRecordsFit(input: {
  readonly bound: BoundExecutableComposition;
  readonly effectiveLimits: {
    readonly maxOutputTokens: number;
    readonly maxProviderTurns: number;
    readonly timeoutMs: number;
  };
  readonly environment: NodeJS.ProcessEnv;
}): void {
  const fit = answerSubmissionRecordsFitForEffectiveLimits(input);
  if (!fit) {
    const record = input.bound.composition.answerSubmissionRecords;
    if (record && parseAnswerSubmissionOption(input.environment) === "recorded") {
      // hygiene: envelope
      throw new ModelCompositionError(
        "timer-fit-predicted",
        `timer-fit-predicted: composition "${input.bound.composition.compositionId}" has no qualified step-8 run metrics for effective records fit.`,
        "Retain qualifying step-8 run metrics and reseal the records evidence, or set DOCSFAB_ANSWER_SUBMISSION=text-final.",
      );
    }
    return;
  }
  if (
    fit.fitsQualifiedMessageFloor &&
    fit.fitsRecordBoundary &&
    fit.fitsReadingTurns &&
    fit.fitsEffectiveTimer &&
    fit.withinReviewThreshold
  ) {
    return;
  }
  const timeoutName = "compositionExecution.timeoutMs";
  const turnsName = "compositionExecution.maxProviderTurns";
  const timeoutOverride = limitDefinition(timeoutName).override;
  const turnsOverride = limitDefinition(turnsName).override;
  let reason: string;
  let nextAction: string;
  if (!fit.fitsQualifiedMessageFloor) {
    reason = `The effective answer-message budget is ${fit.effectiveMaxMessageBytes} bytes, below the smallest qualified phase-B rung ${fit.minimumQualifiedMessageBytes} bytes.`;
    nextAction =
      "Set DOCSFAB_ANSWER_SUBMISSION=text-final or requalify the records capability at the effective message budget.";
  } else if (!fit.fitsRecordBoundary) {
    reason = `The effective answer-message budget is ${fit.effectiveMaxMessageBytes} bytes, below the largest indivisible record ${fit.largestRecordEnvelopeBytes} bytes.`;
    nextAction =
      "Increase the effective output allowance or set DOCSFAB_ANSWER_SUBMISSION=text-final.";
  } else if (!fit.fitsReadingTurns) {
    reason = `The effective provider-turn ceiling is ${fit.maxProviderTurns} turns, but records need ${fit.requiredReadingTurns}.`;
    nextAction = `Raise or unset ${turnsOverride ?? turnsName}, or set DOCSFAB_ANSWER_SUBMISSION=text-final.`;
  } else if (!fit.fitsEffectiveTimer) {
    reason = `The effective timeout is ${fit.effectiveTimeoutMs} ms, but records need ${fit.predictedTimerMs} ms.`;
    nextAction = fit.withinReviewThreshold
      ? `Raise or unset ${timeoutOverride ?? timeoutName}, or set DOCSFAB_ANSWER_SUBMISSION=text-final.`
      : "Set DOCSFAB_ANSWER_SUBMISSION=text-final or requalify the records capability after review.";
  } else {
    reason = `The predicted records timer ${fit.predictedTimerMs} ms exceeds the qualified review threshold ${fit.timerReviewLimitMs} ms.`;
    nextAction =
      "Set DOCSFAB_ANSWER_SUBMISSION=text-final or requalify the records capability after review.";
  }
  // hygiene: envelope
  throw new ModelCompositionError(
    "timer-fit-predicted",
    `timer-fit-predicted: composition "${input.bound.composition.compositionId}" does not fit the effective records limits. ${reason}`,
    nextAction,
  );
}

/**
 * A model that cannot carry reasoning binds it off, so the record says what
 * the request sends; the binding notes why (reasoning-wire.ts). It lives here,
 * not in the configuration module, because the catalog it reads is ESM-only
 * and the hosted terminal validation loads that module as CommonJS.
 */
function withUncarriedReasoningOff(
  profile: BoundModelExecutionProfile,
): BoundModelExecutionProfile {
  if (carriesReasoning(profile.transport, profile.modelId)) return profile;
  const { reasoningEffort: _notSent, reasoningSetByOperator: _notCarried, ...rest } = profile;
  return profile.profile?.reasoning === true
    ? { ...rest, profile: { ...profile.profile, reasoning: false } }
    : rest;
}

function unmatchedByoIdentityBinding(
  model: ModelEndpointConfig,
  authority: InstalledModelCompositionAuthority,
): OperatorExecutionIdentityBinding {
  const profile = withUncarriedReasoningOff(bindModelExecutionIdentity(model));
  const operatorNotice = formatUnmatchedByoOperatorNotice(profile.profile);
  // The same model behind another endpoint keeps the reasoning behavior the
  // installed compositions measured for it; without the control a reasoning
  // model spends its output allowance thinking. A profile that declares
  // reasoning on is left alone.
  const measuredReasoningControl =
    profile.transport === "openai-chat-completions" && profile.profile?.reasoning === false
      ? measuredReasoningControlForModel(authority, model.modelId)
      : undefined;
  // The answer submission a composition recorded for the same model on the
  // same serving origin, whatever the profile declares about reasoning: the
  // recorded argument fidelity belongs to that origin's tool-call parser.
  const answerSubmission = recordedAnswerSubmissionForModel(authority, {
    modelId: model.modelId,
    transport: profile.transport,
    endpointOrigin: endpointOrigin(profile.baseUrl),
  });
  const notes = [
    ...(model.modelSettings?.notes ?? []),
    ...reasoningWireNotes(profile, requestedReasoning(model)),
  ].map(redactCredentialMaterial);
  return {
    profile: {
      ...profile,
      ...(measuredReasoningControl ? { measuredReasoningControl } : {}),
      ...(answerSubmission ? { answerSubmission } : {}),
    },
    match: "unmatched-byo",
    ...(operatorNotice ? { operatorNotice } : {}),
    ...(model.modelSettings ? { modelSettings: { ...model.modelSettings, notes } } : {}),
    notes,
  };
}

/** The origin of an endpoint URL, or `""` when it cannot be parsed (it then matches nothing). */
function endpointOrigin(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return "";
  }
}

function yamlWindowsAreAttested(profile: ModelProfile | undefined): boolean {
  return profile?.metadata?.status === "current";
}

function omittedModeHostLimits(model: ModelEndpointConfig): CompositionModelLimits {
  return {
    ...model.profile.configuredLimits,
    maxProviderTurns: Number.MAX_SAFE_INTEGER,
    timeoutMs: Number.MAX_SAFE_INTEGER,
    maxResponseBytes: Number.MAX_SAFE_INTEGER,
  };
}

/**
 * The window keys an operator value wins on. A preset slot's values are the
 * preset's own or an operator's; a model profile that matches a preset keeps
 * its value when it is attested or set by an operator source, and otherwise
 * takes the preset's window rather than an unattested fill-in.
 */
function operatorWindow(
  model: ModelEndpointConfig,
  key: Extract<ModelSettingKey, "contextWindow" | "maxInputTokens" | "maxOutputTokens">,
  hostLimitsGiven: boolean,
): boolean {
  const settings = model.modelSettings;
  if (settings?.presetId !== undefined && settings.presetId !== null) return true;
  if (settings && isOperatorOverride(settings.settings[key])) return true;
  return hostLimitsGiven || yamlWindowsAreAttested(model.profile);
}

function compositionExecutionProfile(input: {
  readonly model: ModelEndpointConfig;
  readonly bound: BoundExecutableComposition;
  readonly configuredLimits: CompositionModelLimits;
  readonly hostLimitsGiven: boolean;
  readonly normalizedBaseUrl: string;
  readonly transport: ProviderTransport;
  readonly apiFormat: BoundModelExecutionProfile["apiFormat"];
  readonly attachCompositionPolicy: boolean;
  readonly policyApplies: boolean;
}): BoundModelExecutionProfile {
  const { bound, configuredLimits, model } = input;
  const composition = bound.composition;
  const presetWindow = (key: "contextWindow" | "maxInputTokens" | "maxOutputTokens"): number =>
    minimum(
      bound.candidate.proposedLimits[key],
      composition.compositionLimits[key],
      bound.compositionCeiling[key],
    );
  const window = (key: "contextWindow" | "maxInputTokens" | "maxOutputTokens"): number =>
    operatorWindow(model, key, input.hostLimitsGiven) ? configuredLimits[key] : presetWindow(key);
  const contextWindow = window("contextWindow");
  const maxInputTokens = minimum(window("maxInputTokens"), contextWindow);
  const maxOutputTokens = minimum(window("maxOutputTokens"), contextWindow);
  const includeConfigured = input.hostLimitsGiven || yamlWindowsAreAttested(model.profile);
  const decision = model.modelSettings ? reasoningEffortDecision(model.modelSettings) : undefined;
  // A model that cannot carry reasoning binds it off, so the record says what
  // the request sends; the binding notes why (reasoning-wire.ts).
  const carried = carriesReasoning(input.transport, model.modelId);
  const reasoning =
    input.policyApplies || !carried
      ? composition.deployment.routeId === "nvidia-api-catalog" || !carried
        ? false
        : model.profile.reasoning
      : (decision?.reasoning ?? model.profile.reasoning);
  const policyRoute =
    input.policyApplies && composition.deployment.routeId === "nvidia-api-catalog";
  const profile: ModelProfile = {
    configuredLimits: includeConfigured
      ? { ...model.profile.configuredLimits }
      : { contextWindow, maxInputTokens, maxOutputTokens },
    contextWindow,
    maxInputTokens,
    maxOutputTokens,
    effectiveLimitReason: "composition-candidate",
    reasoning,
    input: ["text"],
    compatibility: {
      supportsDeveloperRole: policyRoute
        ? false
        : model.profile.compatibility.supportsDeveloperRole,
      supportsReasoningEffort: policyRoute
        ? false
        : model.profile.compatibility.supportsReasoningEffort,
      apiFormats: model.profile.compatibility.apiFormats.includes(input.apiFormat)
        ? [...model.profile.compatibility.apiFormats]
        : [input.apiFormat],
    },
    costPerMillionTokens: {
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
    },
    metadata: { ...model.profile.metadata },
  };
  const presetModel = model.modelId === composition.model.resolvedId;
  return {
    routeId: composition.deployment.routeId,
    providerId: composition.deployment.routeId,
    baseUrl: input.normalizedBaseUrl,
    // The configured endpoint's source: the deployment URL above is that endpoint.
    ...(model.endpointSource !== undefined ? { endpointSource: model.endpointSource } : {}),
    modelId: model.modelId,
    transport: input.transport,
    apiFormat: input.apiFormat,
    profile,
    requestPolicy: { ...model.requestPolicy },
    ...(decision?.effort && !input.policyApplies && carried
      ? { reasoningEffort: decision.effort }
      : {}),
    ...(requestedReasoning(model).reasoning !== undefined && !input.policyApplies && carried
      ? { reasoningSetByOperator: true as const }
      : {}),
    contextAdmission: "host-window",
    ...(input.policyApplies && composition.requestPolicy
      ? { compositionRequestPolicy: { ...composition.requestPolicy } }
      : {}),
    // The recorded answer submission belongs to the preset's model on its stack.
    ...(composition.answerSubmission && presetModel
      ? { answerSubmission: { ...composition.answerSubmission } }
      : {}),
    ...(input.attachCompositionPolicy
      ? {
          compositionPolicy: {
            maxProviderTurns: minimum(
              configuredLimits.maxProviderTurns,
              bound.candidate.proposedLimits.maxProviderTurns,
              composition.compositionLimits.maxProviderTurns,
              bound.compositionCeiling.maxProviderTurns,
            ),
            timeoutMs: minimum(
              configuredLimits.timeoutMs,
              bound.candidate.proposedLimits.timeoutMs,
              composition.compositionLimits.timeoutMs,
              bound.compositionCeiling.timeoutMs,
            ),
            maxResponseBytes: minimum(
              configuredLimits.maxResponseBytes,
              bound.candidate.proposedLimits.maxResponseBytes,
              composition.compositionLimits.maxResponseBytes,
              bound.compositionCeiling.maxResponseBytes,
            ),
          },
        }
      : {}),
  };
}

function resolveCompositionCredential(
  bound: BoundExecutableComposition,
  model: ModelEndpointConfig,
  environment: NodeJS.ProcessEnv,
): ProviderCredential {
  if (model.credentialEnv !== undefined) {
    if (!bound.composition.authentication.sourceNames.includes(model.credentialEnv)) {
      throw new CompositionCredentialSourceError({
        named: model.credentialEnv,
        compositionId: bound.composition.compositionId,
        reads: bound.composition.authentication.sourceNames,
      });
    }
    return {
      family: compositionCredentialFamily(bound.composition.authentication.credentialFamily),
      apiKey: model.apiKey,
    };
  }
  const overlay: NodeJS.ProcessEnv = { ...environment, MODEL_API_KEY: model.apiKey };
  const available = bound.composition.authentication.sourceNames.flatMap((sourceName) => {
    const value = overlay[sourceName]?.trim();
    return value ? [{ sourceName, value }] : [];
  });
  if (available.length !== 1) {
    throw new Error(
      available.length === 0
        ? "The matched composition credential is unavailable."
        : "The matched composition has ambiguous credential sources.",
    );
  }
  return {
    family: compositionCredentialFamily(bound.composition.authentication.credentialFamily),
    apiKey: available[0]!.value,
  };
}

function minimum(...values: number[]): number {
  return Math.min(...values);
}
