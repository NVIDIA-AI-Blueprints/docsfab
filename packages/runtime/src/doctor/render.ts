// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  describeSource,
  endpointOriginDisplay,
  formatModelSlotSettingsLines,
  type ModelSlotSettingsV1,
} from "../config/model-settings.js";
import { createHash } from "node:crypto";
import type { ResolveLimitsOptions } from "../config/limits.js";
import type { DocsFabConfig } from "../config/runtime-loader.js";
import { CONFIGURABLE_RETRY_CATEGORIES } from "../inference-attempt-taxonomy.js";
import {
  answerNowFlipAtMs,
  answerNowReserveMs,
  answerNowStepIds,
  stepAnswerNowPlan,
  resolveAnswerNowPolicy,
} from "../harness/answer-now.js";
import { retryBudgetForCategory } from "../workflow-execution/retry.js";
import { isTransportRetryCategory } from "../records/inference-retry-disposition.js";
import { providerAttemptLimit } from "../model/provider-attempt.js";
import type {
  InstalledAnswerSubmission,
  MeasuredReasoningControl,
} from "../model-composition/types.js";
import {
  ANSWER_SUBMISSION_ENVIRONMENT,
  DEFAULT_ANSWER_SUBMISSION_OPTION,
  type AnswerSubmissionOption,
} from "../config/answer-submission.js";
import { isReviewOverdue, modelProfileLimitClampIssues } from "../model/configuration.js";
import { formatEndpointCompatibility } from "../profile/endpoint-compatibility.js";
import { containsConfiguredCredential } from "../security/configured-credentials.js";
import { detectCredentialRuleIdsInValue } from "../security/repository-scanner.js";
import type { ResolvedResourceSetV1 } from "../records/contracts.js";
import type { DoctorResult } from "../doctor.js";

/**
 * One accurate operator-readable line per `effectiveLimitReason`. The switch is
 * exhaustive: a fifth union member fails the `never` assignment at typecheck,
 * and any value that still reaches this function at runtime throws instead of
 * borrowing another reason's text.
 */
function limitReasonText(
  reason: DocsFabConfig["model"]["profile"]["effectiveLimitReason"],
): string {
  switch (reason) {
    case "none":
      return "none (approved metadata is current)";
    case "metadata-unknown":
      return "metadata-unknown (no operator-approved provenance; DocsFab does not invent a host context ceiling)";
    case "metadata-stale":
      return "metadata-stale (review date passed; DocsFab does not invent a host context ceiling)";
    case "composition-candidate":
      // src/cli/run/composition-runtime.ts clamps each limit to the lowest of the
      // configured profile, the bound candidate's proposed limits, the
      // composition's own limits, and the packaged composition ceiling.
      // Profile metadata is unrelated and may still be current.
      return "composition-candidate (bound executable composition; the preset's windows apply unless a setting replaces them)";
    default: {
      const unhandled: never = reason;
      throw new Error(
        `Unhandled effective limit reason "${String(unhandled)}". Add a doctor rendering branch for this value.`,
      );
    }
  }
}

/**
 * The reductions that actually bound this profile, one line each. "none" is
 * printed explicitly so the absence of a reduction is stated rather than
 * inferred from a missing line.
 */
export function modelProfileClampLines(
  profile: DocsFabConfig["model"]["profile"],
  prefix: "MODEL" | "JUDGE",
  indent = "  ",
): string[] {
  const issues = modelProfileLimitClampIssues(profile, prefix);
  if (issues.length === 0) {
    return [`${indent}Limit clamps: none (no configured limit was reduced)`];
  }
  return issues.map((issue) => `${indent}Limit clamp: ${issue.field}: ${issue.message}`);
}

/**
 * The advisory line for an attested profile whose review date has passed as
 * of `asOf`; empty on or before that date and for unknown metadata. It is
 * display only: the date changes no runtime behavior.
 */
export function reviewOverdueLines(
  reviewAfter: string | null | undefined,
  asOf: Date,
  indent = "  ",
): string[] {
  if (!isReviewOverdue(reviewAfter, asOf)) return [];
  return [
    `${indent}Review overdue: the profile review date ${reviewAfter} has passed. This is a reminder only; configured limits, capabilities, and prices still apply. Compare with provider metadata: docsfab profile inspect --catalog`,
  ];
}

/**
 * The answer path the final quality evaluator takes on this configuration:
 * the operator option, what the bound route recorded, and the path
 * that follows from both, with the reason a run records.
 */
export function answerSubmissionLine(
  option: AnswerSubmissionOption | undefined,
  capability: InstalledAnswerSubmission | undefined,
): string {
  const effectiveOption = option ?? DEFAULT_ANSWER_SUBMISSION_OPTION;
  const route = capability
    ? `recorded (${capability.kind}, ${capability.argumentShell} arguments, duplicate keys ${capability.duplicateKeys}, report tool_choice ${capability.reportTurnToolChoice})`
    : "not-recorded";
  const path =
    effectiveOption === "text-final"
      ? "text-final (operator-override)"
      : capability
        ? "tool-call (recorded-route)"
        : "text-final (not-recorded)";
  return `Answer submission: ${ANSWER_SUBMISSION_ENVIRONMENT}=${effectiveOption}; route ${route}; the final quality evaluator answers by ${path}`;
}

function reasoningControlLines(measured: MeasuredReasoningControl | undefined): string[] {
  if (!measured) return [];
  const control =
    measured.control.kind === "chat-template-kwarg"
      ? `chat_template_kwargs.thinking=${measured.control.thinking}`
      : `system directive ${measured.control.directive}`;
  return [
    `  Reasoning control: ${control} (measured for this model by ${measured.compositionIds.map(safeDoctorIdentity).join(", ")})`,
  ];
}

function profileLines(
  label: "Policy model" | "Judge model",
  endpoint: {
    provider: string;
    endpoint: string;
    model: string;
    profile: DocsFabConfig["model"]["profile"];
    requestPolicy: DocsFabConfig["model"]["requestPolicy"];
    reasoningControl?: MeasuredReasoningControl;
    modelSettings?: ModelSlotSettingsV1;
  },
  asOf: Date,
): string[] {
  const { profile } = endpoint;
  const reduction = limitReasonText(profile.effectiveLimitReason);
  const endpointSource = endpoint.modelSettings?.settings.baseUrl;
  return [
    `${label}:`,
    `  Provider: ${safeDoctorIdentity(endpoint.provider)}`,
    // The scheme and host only: a path can carry a deployment name.
    `  Endpoint: ${endpointOriginDisplay(endpoint.endpoint)} (path withheld${endpointSource ? `; from ${describeSource(endpointSource.source, endpointSource.origin)}` : ""})`,
    `  Model: ${safeDoctorIdentity(endpoint.model)}`,
    "  API key: configured",
    `  Limits: configured-context=${profile.configuredLimits.contextWindow}, configured-input=${profile.configuredLimits.maxInputTokens}, configured-output=${profile.configuredLimits.maxOutputTokens}, effective-context=${profile.contextWindow}, effective-input=${profile.maxInputTokens}, effective-output=${profile.maxOutputTokens}`,
    `  Request policy: minimum-output=${endpoint.requestPolicy.minimumOutputTokens}, context-reserve=${endpoint.requestPolicy.reservedContextTokens}`,
    `  Limit reason: ${reduction}`,
    ...modelProfileClampLines(profile, label === "Judge model" ? "JUDGE" : "MODEL"),
    `  Capabilities: reasoning=${profile.reasoning}, developer-role=${profile.compatibility.supportsDeveloperRole}, reasoning-effort=${profile.compatibility.supportsReasoningEffort}`,
    ...reasoningControlLines(endpoint.reasoningControl),
    `  API compatibility: ${profile.compatibility.apiFormats.join(",")}`,
    `  Profile metadata: status=${profile.metadata.status}, source-sha256=${profile.metadata.approvedSource ? createHash("sha256").update(profile.metadata.approvedSource).digest("hex") : "unknown"}, verification=not-performed, effective=${profile.metadata.effectiveDate ?? "unknown"}, review-after=${profile.metadata.reviewAfter ?? "unknown"}`,
    ...reviewOverdueLines(profile.metadata.reviewAfter, asOf),
    `  Cost per million tokens: input=${profile.costPerMillionTokens.input ?? "unknown"}, output=${profile.costPerMillionTokens.output ?? "unknown"}, cache-read=${profile.costPerMillionTokens.cacheRead ?? "unknown"}, cache-write=${profile.costPerMillionTokens.cacheWrite ?? "unknown"}`,
    ...(endpoint.modelSettings
      ? ["  Model settings:", ...formatModelSlotSettingsLines(endpoint.modelSettings, "    ")]
      : []),
  ];
}

/** A timer and output ceiling from an execution profile that actually carries a composition policy. */
export interface EffectiveDoctorAttempt {
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
}

/** Report retry counts and only the timing supplied by an effective execution profile. */
export function retryEnvelopeLine(
  retryPolicy: DoctorResult["retryPolicy"],
  options?: ResolveLimitsOptions,
  effectiveAttempt?: EffectiveDoctorAttempt,
): string {
  const attempts = retryPolicy.maxRetries + 1;
  const timeoutAttempts = retryBudgetForCategory(retryPolicy, "timeout") + 1;
  const cutAnswerRetries = Math.min(retryPolicy.maxCutAnswerRetries ?? 0, retryPolicy.maxRetries);
  const noProgressRetries = Math.min(retryPolicy.maxNoProgressRetries ?? 0, retryPolicy.maxRetries);
  if (!effectiveAttempt) {
    return (
      `Retry envelope: attempts=${attempts}, timeout attempts=${timeoutAttempts},` +
      ` cut-answer retries=${cutAnswerRetries}, no-progress retries=${noProgressRetries};` +
      ` attempt-timeout=not configured, judgment answer-now=not armed (no attempt timer),` +
      ` step worst case=not derivable from retry counts (workflow deadlines still apply)`
    );
  }

  const attemptTimeoutMs = effectiveAttempt.timeoutMs;
  const answerNowPolicy = resolveAnswerNowPolicy(options);
  const judgmentPlans = answerNowStepIds().map((stepId) =>
    stepAnswerNowPlan(stepId, effectiveAttempt.maxOutputTokens, options),
  );
  const flips = judgmentPlans.map((plan) =>
    answerNowFlipAtMs(attemptTimeoutMs, answerNowPolicy, plan),
  );
  const largestReserveMs = Math.max(
    ...judgmentPlans.map((plan) => answerNowReserveMs(plan, answerNowPolicy)),
  );
  const answerNow = flips.some((flip) => flip === undefined)
    ? `not armed (attempt timeout ${attemptTimeoutMs}ms is not above the ${largestReserveMs}ms answer reserve)`
    : `${Math.min(...(flips as number[]))}ms`;
  const contractMs = attempts * attemptTimeoutMs;
  const transportMs = transportEnvelopeMs(retryPolicy, attemptTimeoutMs);
  const envelope =
    transportMs === undefined
      ? `${contractMs}ms`
      : `${contractMs}ms + transport<=${transportMs}ms = step worst case ${contractMs + transportMs}ms`;
  return `Retry envelope: attempts=${attempts} x attempt-timeout=${attemptTimeoutMs}ms = ${envelope} (timeout attempts=${timeoutAttempts}, cut-answer retries=${cutAnswerRetries}, no-progress retries=${noProgressRetries}, judgment answer-now at ${answerNow})`;
}

/**
 * Names a pinned category list that equals the default minus `no-progress`,
 * since that list turns off the no-progress retry without saying so. Any
 * other narrowed list is the operator's choice and is not flagged.
 */
export function retryCategoriesPinLine(
  retryPolicy: DoctorResult["retryPolicy"],
): string | undefined {
  const omitted = CONFIGURABLE_RETRY_CATEGORIES.filter(
    (category) => !retryPolicy.retryableCategories.includes(category),
  );
  if (omitted.length !== 1 || omitted[0] !== "no-progress") return undefined;
  return "Retry categories: the configured list is the former default and omits no-progress, which the default now retries once with a conclude-now ask. Delete DOCSFAB_RETRYABLE_CATEGORIES (or host.yaml retryPolicy.retryableCategories) to use the default, or add no-progress.";
}

/** The most wall clock a step's transport-failed attempts and waits can add, if it has a budget. */
function transportEnvelopeMs(
  retryPolicy: DoctorResult["retryPolicy"],
  attemptTimeoutMs: number,
): number | undefined {
  const transport = retryPolicy.transport;
  if (!transport || !retryPolicy.retryableCategories.some(isTransportRetryCategory)) {
    return undefined;
  }
  const byCount =
    (transport.maxRetries + 1) * attemptTimeoutMs + transport.maxRetries * transport.maxDelayMs;
  return Math.min(transport.maxElapsedMs + attemptTimeoutMs, byCount);
}

/**
 * The transport retry budget a step spends on throttles and transport faults
 * instead of its contract-correction count, and the wider in-turn window a
 * throttled turn gets first. `undefined` when the policy shares one count.
 */
export function transportBudgetLine(retryPolicy: DoctorResult["retryPolicy"]): string | undefined {
  const transport = retryPolicy.transport;
  if (!transport) return undefined;
  const categories = retryPolicy.retryableCategories.filter(isTransportRetryCategory);
  if (categories.length === 0) {
    return "Transport retry budget: none (no transport category is retryable)";
  }
  return (
    `Transport retry budget: transport-retries=${transport.maxRetries} outside max-retries` +
    ` (wait<=${transport.maxDelayMs}ms, elapsed<=${transport.maxElapsedMs}ms) for ${categories.join(",")};` +
    ` in-turn throttled requests=${providerAttemptLimit("maxThrottledAttemptsPerTurn")}` +
    ` (wait<=${providerAttemptLimit("maxThrottledTotalDelayMs")}ms)`
  );
}

export function formatDoctorResult(
  result: DoctorResult,
  options?: ResolveLimitsOptions,
  asOf: Date = new Date(),
): string {
  return [
    "DocsFab configuration: ready",
    `Read-only retry policy: max-retries=${result.retryPolicy.maxRetries}, exponential-backoff=${result.retryPolicy.baseDelayMs}-${result.retryPolicy.maxDelayMs}ms, retryable=${result.retryPolicy.retryableCategories.join(",")}`,
    retryEnvelopeLine(result.retryPolicy, options),
    ...[transportBudgetLine(result.retryPolicy), retryCategoriesPinLine(result.retryPolicy)].filter(
      (line) => line !== undefined,
    ),
    answerSubmissionLine(result.answerSubmissionOption, result.answerSubmission),
    ...profileLines(
      "Policy model",
      {
        provider: result.provider,
        endpoint: result.endpoint,
        model: result.model,
        profile: result.profile,
        requestPolicy: result.requestPolicy,
        ...(result.reasoningControl ? { reasoningControl: result.reasoningControl } : {}),
        ...(result.modelSettings ? { modelSettings: result.modelSettings } : {}),
      },
      asOf,
    ),
    ...(result.judge ? profileLines("Judge model", result.judge, asOf) : ["Judge model: disabled"]),
    `Skills (${result.skills.length}): ${result.skills.map(safeDoctorIdentity).join(", ")}`,
    `Context sources (${result.contextSources.length}): ${result.contextSources.map((source) => safeDoctorIdentity(source.id)).join(", ") || "none"}`,
    ...resolvedResourceLines(result.resolvedResources),
    liveInferenceLine(result),
    ...(result.live?.compatibility ? formatEndpointCompatibility(result.live.compatibility) : []),
  ].join("\n");
}

function liveInferenceLine(result: DoctorResult): string {
  if (result.live) return `Live inference: ready (${result.live.latencyMs} ms)`;
  switch (result.liveObservation ?? "not-requested") {
    case "passed":
      return "Live inference: passed (checked by --live)";
    case "failed":
      return "Live inference: failed (checked by --live; see the provider diagnostic)";
    case "not-attempted":
      return "Live inference: not attempted (offline readiness is blocked)";
    case "not-requested":
      return "Live inference: not requested (use --live)";
  }
}

/** The effective resource set, each part named with the layer that supplied it. */
function resolvedResourceLines(set: ResolvedResourceSetV1 | undefined): string[] {
  if (!set) return [];
  return [
    ...set.resources.map(
      (resource) =>
        `Resolved ${resource.kind}: ${safeDoctorIdentity(resource.id)}@${safeDoctorIdentity(resource.version)} (layer ${resource.layer}, sha256 ${resource.sha256})`,
    ),
    `Unresolved resource layers: ${set.unresolvedLayers.join(", ")} (not built; the product layer applies alone)`,
  ];
}

function safeDoctorIdentity(value: string): string {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/u.test(value) &&
    !value.startsWith("/") &&
    !value.includes("..") &&
    !value.includes("//") &&
    detectCredentialRuleIdsInValue(value).length === 0 &&
    // DocsFab's own configured credentials, such as the model key given as a
    // model id, by exact match.
    !containsConfiguredCredential(value)
    ? value
    : "withheld-unsafe-identity";
}
