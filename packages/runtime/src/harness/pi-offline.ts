// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pi adapter helpers shared by live and PI_OFFLINE settlement: the attempt-scoped
 * lease controller factory and provider-turn parsers. Neither retains model
 * content in evidence.
 */
import { createHash } from "node:crypto";
import { limit, resolveLimits, type ResolveLimitsOptions } from "../config/limits.js";
import { resolveTurnRecoveryPolicy } from "../model/turn-recovery-policy.js";

import type {
  ExecutionCheckpointTurnDisposition,
  ExecutionLeaseRuntimeTerminalDisposition,
  HarnessStepInput,
  InferenceRejectionReasonV1,
} from "../execution/contracts.js";
import type { BoundModelExecutionProfile } from "../model/configuration.js";
import type { InferenceFailureCondition } from "../records/contracts.js";
import {
  classifyModelFailure,
  localStopReason,
  type ModelFailureDisposition,
} from "../model/context-budget.js";
import { describeBlankProviderTurn, isLengthStop } from "../model/provider-turn-retry.js";
import {
  createExecutionLeaseCoordinatorPolicy,
  createAnswerRecordDiscoveryLeasePolicyV2,
  EXECUTION_LEASE_DEFAULTS,
  renewalToolCallGrant,
  resolveLeaseShapeForTurns,
  type ExecutionContextObservationV1,
  type ExecutionResourceEnvelopeV1,
} from "../execution/index.js";
import {
  PiExecutionLeaseController,
  type PiProviderTurnReservationV1,
  type PiProviderTurnUsageV1,
} from "./pi-lease.js";
import { canonicalDigest } from "../content-ir/canonical.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import { QUALITY_ANSWER_RECORD_TOOL_NAME } from "./answer-submission.js";

/**
 * Context basis shared by admission and settlement. Provider-owned context has no
 * attested host window, so it uses the cumulative input budget as a stable
 * ceiling; host-window admission uses the governor's post-reserve allowance.
 */
export function leaseAvailableInputTokens(
  model: {
    profile: { maxInputTokens: number };
    requestPolicy: { reservedContextTokens: number };
    contextAdmission?: BoundModelExecutionProfile["contextAdmission"];
  },
  maxCumulativeInputTokens: number,
  observedAvailableInputTokens?: number,
): number {
  if (model.contextAdmission === "provider") return maxCumulativeInputTokens;
  return (
    observedAvailableInputTokens ??
    Math.max(0, model.profile.maxInputTokens - model.requestPolicy.reservedContextTokens)
  );
}

/**
 * Fit the composition envelope inside the sealed turn budget, using the same
 * `resolveLeaseShapeForTurns` as the coordinator so both agree.
 */
export function resolveCompositionLeaseShape(
  envelope: {
    readonly callsPerLease: number;
    readonly maxLeases: number;
    readonly maxToolCallsPerStep: number;
  },
  maxProviderTurns: number,
): { callsPerLease: number; maxLeases: number; hardToolCallCeiling: number } {
  return resolveLeaseShapeForTurns(
    {
      callsPerLease: envelope.callsPerLease,
      maxLeases: envelope.maxLeases,
      hardToolCallCeiling: envelope.maxToolCallsPerStep,
    },
    maxProviderTurns,
  );
}

export function createPiExecutionLeaseController(
  input: HarnessStepInput,
  model: Pick<
    BoundModelExecutionProfile,
    "profile" | "requestPolicy" | "compositionPolicy" | "contextAdmission"
  >,
  grantedTools: readonly string[],
  limits?: ResolveLimitsOptions,
): PiExecutionLeaseController {
  const answerRecordCallCeiling =
    input.qualityAnswerRecordCallCeiling ?? input.sourceObligationAnswerRecordCallCeiling;
  if (
    (answerRecordCallCeiling !== undefined &&
      (!Number.isSafeInteger(answerRecordCallCeiling) || answerRecordCallCeiling < 1)) ||
    grantedTools.includes(QUALITY_ANSWER_RECORD_TOOL_NAME) !==
      (answerRecordCallCeiling !== undefined)
  ) {
    throw new Error(
      "Pi answer-record tool authority does not match its host-derived call ceiling.",
    );
  }
  const callsPerLeaseLimit = limit("compositionExecution.callsPerLease", limits);
  let policy;
  if (input.experimentalAnswerRecordDiscoveryRenewal === true) {
    const applicableAggregateLimitNames = [
      "compositionExecution.maxLeases",
      "compositionExecution.maxToolCallsPerStep",
      "compositionExecution.maxCumulativeInputTokens",
      "compositionExecution.maxCumulativeOutputTokens",
      "governance.maxCompactions",
      "governance.maxConsecutiveLengthStoppedToolTurns",
      "inference.maxLengthStopContinuations",
      ...(model.compositionPolicy
        ? ["compositionExecution.maxProviderTurns", "compositionExecution.timeoutMs"]
        : []),
    ];
    const resolvedLimits = new Map(resolveLimits(limits).map((entry) => [entry.name, entry]));
    const explicitAggregateOverrides = applicableAggregateLimitNames.flatMap((name) => {
      const configured = resolvedLimits.get(name);
      return configured && configured.source !== "config/limits.yaml" ? [configured] : [];
    });
    if (explicitAggregateOverrides.length > 0) {
      const names = explicitAggregateOverrides
        .map((entry) => `${entry.name} (${entry.source})`)
        .join(", ");
      throw new Error(
        `Experimental answer-record discovery requires absent aggregate limits, but explicit overrides are configured for ${names}. Remove those overrides or use the ordinary finite-policy route.`,
      );
    }
    // The only finite value in this policy is a renewal cadence. Do not derive
    // execution ceilings from defaults for this explicit experimental journey.
    policy = createAnswerRecordDiscoveryLeasePolicyV2({ callsPerLease: callsPerLeaseLimit.value });
  } else {
    const maxProviderTurns =
      model.compositionPolicy?.maxProviderTurns ?? EXECUTION_LEASE_DEFAULTS.maxProviderTurns;
    // More turn headroom must not multiply normal mode's token spend. Use `limit()`,
    // not `limitDefinition()`, which ignores host overrides.
    const normalModeTokenBudgetTurns = limit("execution.normalModeTokenBudgetTurns", limits).value;
    const maxElapsedMs =
      model.compositionPolicy?.timeoutMs ?? limit("execution.normalModeMaxElapsedMs", limits).value;
    const { maxCompactions } = resolveTurnRecoveryPolicy(maxProviderTurns, limits);
    const multiplyBounded = (value: number, multiplier: number): number =>
      Math.min(Number.MAX_SAFE_INTEGER, value * multiplier);
    const maxLeasesLimit = limit("compositionExecution.maxLeases", limits);
    const maxToolCallsPerStepLimit = limit("compositionExecution.maxToolCallsPerStep", limits);
    const envelope = {
      callsPerLease: callsPerLeaseLimit.value,
      maxLeases: maxLeasesLimit.value,
      maxToolCallsPerStep: maxToolCallsPerStepLimit.value,
      maxCumulativeInputTokens: limit("compositionExecution.maxCumulativeInputTokens", limits)
        .value,
      maxCumulativeOutputTokens: limit("compositionExecution.maxCumulativeOutputTokens", limits)
        .value,
    };
    // `decodeExecutionLeasePolicy` rejects `maxProviderTurns < hardToolCallCeiling +
    // maxLeases`, so clamp the envelope's tool shape to the turn budget: a small turn
    // budget then degrades instead of yielding a policy rejected mid-run.
    const leaseShape = resolveCompositionLeaseShape(envelope, maxProviderTurns);
    policy = createExecutionLeaseCoordinatorPolicy({
      maxCompactions,
      providerLimits: { maxProviderTurns, maxCompactions },
      ...(model.compositionPolicy
        ? {
            workflowOverrides:
              answerRecordCallCeiling === undefined
                ? { ...leaseShape, maxProviderTurns }
                : {
                    // In record mode, the coordinator must fit the plan ceiling
                    // together with the derived reading ceiling and lease count.
                    // Passing the legacy turn-clamped shape here would turn those
                    // derived values into explicit overrides and make the full
                    // record allowance impossible to fit. Carry only actual host
                    // overrides; defaults remain derivable by the record fitter.
                    callsPerLease: envelope.callsPerLease,
                    ...(maxToolCallsPerStepLimit.source === "config/limits.yaml"
                      ? {}
                      : { hardToolCallCeiling: envelope.maxToolCallsPerStep }),
                    ...(maxLeasesLimit.source === "config/limits.yaml"
                      ? {}
                      : { maxLeases: envelope.maxLeases }),
                    maxProviderTurns,
                  },
          }
        : {}),
      ...(answerRecordCallCeiling === undefined ? {} : { answerRecordCallCeiling }),
      ...(input.qualityAnswerRecordSharedToolCapacity === true
        ? { sharedToolCallCapacity: true as const }
        : {}),
      // The flat envelope was sized for the composition path; the model-profile
      // path keeps its per-profile budget.
      cumulative: model.compositionPolicy
        ? {
            maxInputTokens: envelope.maxCumulativeInputTokens,
            maxOutputTokens: envelope.maxCumulativeOutputTokens,
            maxElapsedMs,
          }
        : {
            maxInputTokens: multiplyBounded(
              model.profile.maxInputTokens,
              normalModeTokenBudgetTurns,
            ),
            maxOutputTokens: multiplyBounded(
              model.profile.maxOutputTokens,
              normalModeTokenBudgetTurns,
            ),
            maxElapsedMs,
          },
    });
  }
  const contextAuthoritySha256 = canonicalDigest({
    kind: "docsfab-pi-context-authority",
    ...(model.contextAdmission === "provider" ? { contextAdmission: "provider" } : {}),
    configuredContextWindow: model.profile.configuredLimits.contextWindow,
    effectiveContextWindow: model.profile.contextWindow,
    maxInputTokens: model.profile.maxInputTokens,
    maxOutputTokens: model.profile.maxOutputTokens,
    reservedTokens: model.requestPolicy.reservedContextTokens,
    minimumOutputTokens: model.requestPolicy.minimumOutputTokens,
  });
  const contextPacketSha256 =
    input.evidenceIdentity?.contextPacketDigest ??
    canonicalDigest({ kind: "docsfab-empty-context-packet" });
  const authorizationSha256 =
    input.task?.kind === "bounded-doc-improvement"
      ? input.task.authorization.sha256
      : canonicalDigest({
          kind: "docsfab-step-authorization",
          runId: input.runId ?? null,
          workflow: input.workflow.name,
          step: input.step.id,
          mode: input.step.mode,
        });
  const rates = model.profile.costPerMillionTokens;
  const pricingCurrent =
    model.profile.metadata.status === "current" && rates.input !== null && rates.output !== null;
  return new PiExecutionLeaseController({
    policy,
    requestCapacity: {
      maxInputTokens: model.profile.maxInputTokens,
      maxOutputTokens: model.profile.maxOutputTokens,
    },
    identity: {
      inferenceAttempt: input.inferenceAttempt ?? 1,
      retriesConsumed: input.retriesConsumed ?? 0,
      authorizationSha256,
      repositoryRevision: input.evidenceIdentity!.repositoryRevision,
      contextPacketSha256,
      evidenceSha256: canonicalDigest({
        repositoryRevision: input.evidenceIdentity!.repositoryRevision,
        contextPacketSha256,
        consultedNodeIds: [...(input.evidenceIdentity!.consultedNodeIds ?? [])].sort(),
        // Optional bindings are omitted when absent so steps without them keep
        // their digests; present, they stop a scope swap passing as the same evidence.
        ...(input.reviewScope ? { reviewScopeSha256: input.reviewScope.scopeSha256 } : {}),
        ...(input.evidenceIdentity!.searchEvidenceSha256
          ? { searchEvidenceSha256: input.evidenceIdentity!.searchEvidenceSha256 }
          : {}),
        ...(input.evidenceIdentity!.technicalVerificationSha256
          ? {
              technicalVerificationSha256: input.evidenceIdentity!.technicalVerificationSha256,
            }
          : {}),
        ...(input.evidenceIdentity!.provisionalRichCandidateSha256
          ? {
              provisionalRichCandidateSha256:
                input.evidenceIdentity!.provisionalRichCandidateSha256,
            }
          : {}),
        ...(input.evidenceIdentity!.authoringPhaseSha256
          ? { authoringPhaseSha256: input.evidenceIdentity!.authoringPhaseSha256 }
          : {}),
      }),
      toolPolicySha256: canonicalDigest({
        mode: input.step.mode,
        grantedTools: [...grantedTools].sort(),
      }),
      contextAuthoritySha256,
    },
    pricing: pricingCurrent
      ? {
          status: "known",
          inputMicrousdPerMillionTokens: Math.round(rates.input! * 1_000_000),
          outputMicrousdPerMillionTokens: Math.round(rates.output! * 1_000_000),
          authoritySha256: canonicalDigest({
            status: model.profile.metadata.status,
            effectiveDate: model.profile.metadata.effectiveDate,
            reviewAfter: model.profile.metadata.reviewAfter,
            input: rates.input,
            output: rates.output,
          }),
        }
      : {
          status: "unavailable",
          reason: model.profile.metadata.status === "stale" ? "pricing-stale" : "pricing-unknown",
          authoritySha256: canonicalDigest({
            status: model.profile.metadata.status,
            inputKnown: rates.input !== null,
            outputKnown: rates.output !== null,
          }),
        },
    context: {
      status: "ready",
      availableInputTokens: leaseAvailableInputTokens(
        model,
        policy.schemaVersion === 1
          ? policy.cumulative.maxInputTokens
          : model.profile.maxInputTokens,
      ),
      requiredInputTokens: model.requestPolicy.minimumOutputTokens,
      authoritySha256: contextAuthoritySha256,
    },
  });
}

export function assistantToolCalls(message: object): Array<{ id: string; name: string }> {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const item = block as Record<string, unknown>;
    return item.type === "toolCall" && typeof item.id === "string" && typeof item.name === "string"
      ? [{ id: item.id, name: item.name }]
      : [];
  });
}

/**
 * Extract the assistant's text from a Pi `AssistantMessage`.
 *
 * pi-ai folds `reasoning_content` deltas into `{type:"thinking"}` blocks, so
 * only block shapes reach here. Text blocks win; thinking is the fallback, and
 * never displaces real text. Returning "" for a message that contains text
 * would report a blank turn and fold a constant hash into the turn identity,
 * so turns with the same tool calls would be rejected as replays.
 */
export function assistantText(
  message: object,
  options: { thinkingFallback?: boolean } = {},
): string {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";

  const blocks = (kind: string, key: string): string =>
    content
      .flatMap((block) => {
        if (!block || typeof block !== "object") return [];
        const item = block as Record<string, unknown>;
        return item.type === kind && typeof item[key] === "string" ? [item[key] as string] : [];
      })
      .join("");

  const thinking = blocks("thinking", "thinking");
  const text = blocks("text", "text");
  // A reasoning parser that never saw the end of reasoning, for example at a
  // length stop, can flush the whole reasoning again as `content`. Text that
  // only repeats the turn's reasoning is not an answer.
  const answer = text.length > 0 && text === thinking ? "" : text;
  if (options.thinkingFallback === false) return answer;
  return answer.trim() ? answer : thinking;
}

export function assistantAuthoritySha256(message: object): string {
  return canonicalDigest({
    kind: "docsfab-pi-assistant-turn",
    calls: assistantToolCalls(message).map((call, ordinal) => ({
      ordinal,
      idSha256: createHash("sha256").update(call.id).digest("hex"),
      nameSha256: createHash("sha256").update(call.name).digest("hex"),
    })),
    textSha256: createHash("sha256").update(assistantText(message)).digest("hex"),
    provider: (message as { provider?: unknown }).provider ?? null,
    model: (message as { model?: unknown }).model ?? null,
    timestamp: (message as { timestamp?: unknown }).timestamp ?? null,
    stopReason: (message as { stopReason?: unknown }).stopReason ?? null,
  });
}

export function attemptArtifactSha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeJsonEvidence(value as JsonEvidenceValue))
    .digest("hex");
}

export interface PiAssistantTurnFailure {
  disposition: Exclude<ExecutionLeaseRuntimeTerminalDisposition, "completed">;
  checkpointDisposition: Exclude<
    ExecutionCheckpointTurnDisposition,
    "accepted" | "progress-stopped"
  >;
  reason:
    | "cancellation-requested"
    | "context-exhausted"
    | "output-authority-exhausted"
    | "provider-terminal"
    | "checkpoint-not-renewable";
  /** Truncated provider errorMessage; omitted when the turn had none. */
  detail?: string;
  /** The turn governor refused before any provider traffic; no turn to charge. */
  localStop?: true;
  /**
   * Classification of the raw provider text, carried structurally because
   * `classifyModelFailure` matches a leading status that `detail` may not keep.
   */
  classification?: ModelFailureDisposition;
  /** Set only for a turn cut at the output limit. */
  rejection?: InferenceRejectionReasonV1;
  /** `cut-answer` for an answer turn cut at the output limit. */
  condition?: InferenceFailureCondition;
}

/**
 * The coded rejection for a reply cut at the output limit. The location is the
 * whole reply because the cut says nothing about which contract member it hit.
 */
export function lengthStopRejection(shape: LengthStoppedTurnShape): InferenceRejectionReasonV1 {
  return { code: shape, location: "$response" };
}

const PROVIDER_ERROR_DETAIL_MAX = 300;

/** ", last turn consumed N output tokens", or "" when the provider reported none. */
function lengthStopConsumption(output: unknown): string {
  return Number.isSafeInteger(output) && Number(output) > 0
    ? `, last turn consumed ${Number(output).toLocaleString("en-US")} output tokens`
    : "";
}

export function formatAssistantTurnFailure(failure: PiAssistantTurnFailure): string {
  return failure.detail ? `${failure.disposition}: ${failure.detail}` : failure.disposition;
}

/**
 * The cumulative output lease that clamped the governed request: the remainder it
 * was clamped to and the per-step lease total.
 */
export interface OutputLeaseClamp {
  remainingOutputTokens: number;
  maxOutputTokens: number;
}

/**
 * The remedy sentence for a turn cut at the output limit. Under a lease clamp,
 * raising `maxOutputTokens` cannot move the cut, so the sentence names the lease.
 */
export function outputLimitRemedy(action: string, clamp?: OutputLeaseClamp): string {
  if (clamp === undefined) return `${action} or raise maxOutputTokens.`;
  const remaining = clamp.remainingOutputTokens.toLocaleString("en-US");
  const lease = clamp.maxOutputTokens.toLocaleString("en-US");
  return `${action}; the limit was the ${remaining} output tokens left of the ${lease}-token cumulative output lease, not maxOutputTokens.`;
}

function providerErrorDetail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!compact) return undefined;
  return compact.length > PROVIDER_ERROR_DETAIL_MAX
    ? `${compact.slice(0, PROVIDER_ERROR_DETAIL_MAX)}…`
    : compact;
}

/**
 * Shapes of a turn stopped at the output limit:
 *
 *   - `text-truncated`: partial text is kept, never accepted as complete.
 *   - `output-truncated`: nothing surfaced; the provider billed the output budget
 *     and withheld the cut answer.
 *   - `tool-arguments-truncated`: a tool call cut mid-arguments; Pi re-issues it
 *     once and `pi.ts` names the repeat.
 */
export type LengthStoppedTurnShape =
  | "output-truncated"
  | "text-truncated"
  | "tool-arguments-truncated";

/**
 * Classify a completed assistant turn; undefined means no failure.
 *
 * `blankProviderTurns` counts the empty turns the in-turn replay observed, ending
 * with this one. A length stop with tool calls is left to Pi's re-issue loop,
 * which `pi.ts` bounds; without them it is `text-truncated` or
 * `output-truncated`, and the detail names the step, limit, tokens, and remedy.
 */
export function assistantTurnFailure(
  message: object,
  context: {
    blankProviderTurns?: number;
    providerAttempts?: number;
    outputTokenLimit?: number;
    outputLeaseClamp?: OutputLeaseClamp;
    stepId?: string;
  } = {},
): PiAssistantTurnFailure | undefined {
  const item = message as {
    stopReason?: unknown;
    errorMessage?: unknown;
    rawStopReason?: unknown;
    usage?: { output?: unknown };
  };
  if (item.stopReason === "aborted") {
    return {
      disposition: "cancelled",
      checkpointDisposition: "cancelled",
      reason: "cancellation-requested",
    };
  }
  if (item.stopReason === "error") {
    const errorMessage =
      typeof item.errorMessage === "string" ? item.errorMessage : "provider error";
    const classified = classifyModelFailure(errorMessage);
    const localReason = localStopReason(errorMessage);
    // Name the attempts spent so a first-shot failure and an exhausted replay
    // budget read differently.
    const attempts = Math.max(1, Math.floor(context.providerAttempts ?? 1));
    const observed = providerErrorDetail(item.errorMessage);
    const detail =
      attempts > 1
        ? providerErrorDetail(`${attempts} provider attempts: ${observed ?? "provider error"}`)
        : observed;
    // A host budget stop, not a provider or context fault. Not
    // `cumulative-output-limit`, which the lease binds to spend that reached the limit.
    if (localReason === "output-authority-exhausted") {
      return {
        disposition: "budget-stopped",
        checkpointDisposition: "context-exhausted",
        reason: "output-authority-exhausted",
        localStop: true,
        ...(detail ? { detail } : {}),
        classification: classified,
      };
    }
    return classified.category === "context-exhausted"
      ? {
          disposition: "context-exhausted",
          checkpointDisposition: "context-exhausted",
          reason: "context-exhausted",
          ...(localReason === undefined ? {} : { localStop: true }),
          ...(detail ? { detail } : {}),
          classification: classified,
        }
      : {
          disposition: "provider-failed",
          checkpointDisposition: "provider-failed",
          reason: "provider-terminal",
          ...(detail ? { detail } : {}),
          classification: classified,
        };
  }
  const toolCalls = assistantToolCalls(message).length;
  const text = assistantText(message);
  if (isLengthStop(item.stopReason, item.rawStopReason) && toolCalls === 0) {
    const shape: LengthStoppedTurnShape = text.trim() ? "text-truncated" : "output-truncated";
    const limit =
      Number.isSafeInteger(context.outputTokenLimit) && Number(context.outputTokenLimit) > 0
        ? `${Number(context.outputTokenLimit).toLocaleString("en-US")}-token`
        : "configured";
    const finishReason =
      typeof item.rawStopReason === "string" && item.rawStopReason.trim()
        ? item.rawStopReason.trim()
        : "length";
    const attempts = Math.max(
      1,
      Math.floor(
        shape === "output-truncated"
          ? (context.blankProviderTurns ?? 1)
          : (context.providerAttempts ?? 1),
      ),
    );
    const step = context.stepId?.trim() ? `step ${context.stepId.trim()}` : "the step";
    const consumed = lengthStopConsumption(item.usage?.output);
    // The cap bounds the description of the cut; the remedy is appended after
    // it so a lease clamp is never elided from the one line an operator reads.
    const cut =
      providerErrorDetail(
        shape === "text-truncated"
          ? [
              `text-truncated: ${step} answer cut at the ${limit} output limit`,
              `(finish_reason=${finishReason}) after ${text.length.toLocaleString("en-US")} characters${consumed};`,
              "partial text retained, not accepted as complete.",
            ].join(" ")
          : [
              `output-truncated: ${attempts} provider turn${attempts === 1 ? "" : "s"} of ${step}`,
              `hit the ${limit} output limit (finish_reason=${finishReason})${consumed},`,
              "no text or tool call surfaced; the provider withheld the cut answer.",
            ].join(" "),
      ) ?? shape;
    const detail = `${cut} ${outputLimitRemedy("Shorten the answer", context.outputLeaseClamp)}`;
    return {
      disposition: "provider-failed",
      checkpointDisposition: "provider-failed",
      reason: "provider-terminal",
      detail,
      // The retry rule, not this classifier, decides whether a fresh sample is
      // worth another output allowance: `cut-answer` has its own small budget,
      // and its retry asks for the complete answer well inside the limit.
      classification: { category: "malformed-response", retryable: true },
      rejection: lengthStopRejection(shape),
      condition: "cut-answer",
    };
  }
  if (toolCalls === 0 && !text.trim()) {
    const attempts = Math.max(1, Math.floor(context.blankProviderTurns ?? 1));
    const rawStopReason =
      typeof item.rawStopReason === "string" && item.rawStopReason.trim()
        ? item.rawStopReason.trim()
        : undefined;
    const providerError =
      typeof item.errorMessage === "string" && item.errorMessage.trim()
        ? item.errorMessage.trim()
        : undefined;
    const detail = providerErrorDetail(
      [
        `${attempts} blank provider turn${attempts === 1 ? "" : "s"}`,
        // One formatter, shared with the replay that observed the same fields,
        // so the message cannot drift from what the transport reported.
        describeBlankProviderTurn({
          stopReason: typeof item.stopReason === "string" ? item.stopReason : "absent",
          ...(rawStopReason ? { rawStopReason } : {}),
          ...(providerError ? { errorMessage: providerError } : {}),
        }),
      ].join(" "),
    );
    return {
      disposition: "blank",
      checkpointDisposition: "blank",
      reason: "provider-terminal",
      ...(detail ? { detail } : {}),
    };
  }
  return undefined;
}

export function providerUsage(
  message: object,
  elapsedMs: number,
  context: ExecutionContextObservationV1,
  compactions: number,
): PiProviderTurnUsageV1 {
  const usage = (message as { usage?: Record<string, unknown> }).usage;
  const integer = (value: unknown): number =>
    Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
  return {
    inputTokens: integer(usage?.input),
    outputTokens: integer(usage?.output),
    elapsedMs: Math.max(1, Math.floor(elapsedMs)),
    compactions,
    context,
  };
}

export function reservationForTurn(
  usage: PiProviderTurnUsageV1,
  toolCalls: number,
  kind: PiProviderTurnReservationV1["kind"] = "ordinary",
): PiProviderTurnReservationV1 {
  return {
    kind,
    toolCalls,
    providerTurns: 1,
    compactions: usage.compactions,
    inputTokens: Math.max(1, usage.inputTokens),
    outputTokens: Math.max(1, usage.outputTokens),
    elapsedMs: Math.max(1, usage.elapsedMs),
    contextInputTokens: Math.max(1, usage.context.requiredInputTokens),
  };
}

/**
 * The renewal request the host makes at a lease boundary. The coordinator checks
 * it against the attempt's remaining authority, so a larger request only makes
 * admission stricter.
 *
 * - For a grantable request, `toolCalls` must equal `renewalToolCallGrant`.
 *   At the final-turn boundary a separate record pool can yield zero calls;
 *   one denial-only call keeps the envelope executable so the coordinator
 *   records its `provider-turn-limit` refusal.
 * - Record-call batches can spend several calls in one provider turn. Reserve
 *   the final answer turn without shrinking the independently granted calls.
 * - Compactions cannot exceed the granted turns, since each spends a turn.
 * - Output and elapsed demands are a strict share of what remains, so a renewal
 *   never denies itself on authority it is not asking for.
 * - Input tokens take no share: `availableInputTokens` is already one turn's
 *   demand, which every turn makes in full.
 */
export function nextTranche(controller: PiExecutionLeaseController): ExecutionResourceEnvelopeV1 {
  const { policy, state, context } = controller.coordinator;
  if (policy.schemaVersion === 2) {
    const toolCalls = renewalToolCallGrant(policy, state);
    const request = controller.perRequestCapacity;
    return {
      toolCalls,
      providerTurns: toolCalls,
      compactions: toolCalls,
      inputTokens: request.maxInputTokens,
      outputTokens: request.maxOutputTokens,
      elapsedMs: 0,
      contextInputTokens: Math.max(1, context.requiredInputTokens),
    };
  }
  const remainingProviderTurns = policy.maxProviderTurns - state.providerTurns;
  const grantedCalls = renewalToolCallGrant(policy, state);
  // Separate record capacity has no turn-backed grant at the final-turn
  // boundary. A positive request still reaches the coordinator's named refusal.
  const toolCalls =
    policy.answerRecordCallCeiling !== undefined && remainingProviderTurns <= 1
      ? Math.max(1, grantedCalls)
      : grantedCalls;
  const providerTurns =
    policy.answerRecordCallCeiling === undefined
      ? toolCalls
      : remainingProviderTurns > 1
        ? Math.min(toolCalls, remainingProviderTurns - 1)
        : 1;
  // Floored at one unit so a spent budget is still refused. The denominator guard
  // avoids `0 / 0`, whose NaN survives `Math.max` and cannot be refused.
  const shareOfRemaining = (remaining: number): number =>
    Math.max(1, Math.floor((remaining * providerTurns) / Math.max(1, remainingProviderTurns)));
  return {
    toolCalls,
    providerTurns,
    compactions: Math.min(providerTurns, policy.maxCompactions - state.compactions),
    inputTokens: Math.max(
      1,
      Math.min(
        policy.cumulative.maxInputTokens - state.cumulativeInputTokens,
        context.availableInputTokens,
      ),
    ),
    outputTokens: shareOfRemaining(
      policy.cumulative.maxOutputTokens - state.cumulativeOutputTokens,
    ),
    elapsedMs: shareOfRemaining(policy.cumulative.maxElapsedMs - state.elapsedMs),
    contextInputTokens: Math.max(1, context.requiredInputTokens),
  };
}
