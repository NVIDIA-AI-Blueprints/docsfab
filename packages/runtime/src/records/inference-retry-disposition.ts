// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Keeps two facts about an inference attempt apart: whether the failure
 * condition can be retried at all, and what the run's retry policy did about
 * it. Only the first is a property of the error.
 *
 * This module declares no category or policy; the eligible set comes from
 * `inference-attempt-taxonomy.ts` and the budget from the caller's resolved
 * policy. It describes a decision already made. A record without these fields
 * reads `unavailable`, never a value reconstructed from `retryable` or
 * `retryScheduled`.
 */
import {
  INFERENCE_ATTEMPT_SUCCESS_OUTCOME,
  isConfigurableRetryCategory,
  NON_RETRYABLE_INFERENCE_FAILURE_CATEGORIES,
  type InferenceAttemptOutcome,
} from "../inference-attempt-taxonomy.js";
import type {
  InferenceAttemptEvidence,
  InferenceConditionRetryability,
  InferenceExecutionEvidence,
  InferenceFailureCategory,
  InferenceRetryDecision,
  ProviderErrorTelemetryV1,
  InferenceTransportRetryEvidence,
  ProviderTurnReplayVeto,
} from "./contracts.js";
import { isHttpStatus } from "./model-telemetry.js";

export const INFERENCE_CONDITION_RETRYABILITIES = Object.freeze([
  "eligible",
  "not-eligible",
  "not-applicable",
] as const satisfies readonly InferenceConditionRetryability[]);

export const INFERENCE_RETRY_DECISIONS = Object.freeze([
  "retried",
  "declined",
  "exhausted",
  "not-applicable",
] as const satisfies readonly InferenceRetryDecision[]);

/**
 * Declared here, not beside the replay wrapper, so the record decoder does not
 * import the provider transport or limits catalog just to read saved JSON.
 */
export const PROVIDER_TURN_REPLAY_VETOES = Object.freeze([
  "partial-stream",
  "condition-not-retryable",
  "attempts-exhausted",
  "step-physical-attempts-exhausted",
  "blank-attempts-exhausted",
  "local-denial",
  "backoff-budget-exhausted",
  "attempt-deadline",
  "cancelled",
] as const satisfies readonly ProviderTurnReplayVeto[]);

/** Fails to typecheck when `ProviderTurnReplayVeto` gains a member not listed above. */
export const PROVIDER_TURN_REPLAY_VETO_COVERAGE: [ProviderTurnReplayVeto] extends [
  (typeof PROVIDER_TURN_REPLAY_VETOES)[number],
]
  ? true
  : never = true;

export function isProviderTurnReplayVeto(value: unknown): value is ProviderTurnReplayVeto {
  return (PROVIDER_TURN_REPLAY_VETOES as readonly unknown[]).includes(value);
}

/**
 * A reading, never a stored value: the record contract has no `unavailable`
 * member, so a writer cannot claim it.
 */
export const INFERENCE_RETRY_DISPOSITION_UNAVAILABLE = "unavailable";

export interface InferenceRetryDispositionReading {
  conditionRetryability:
    | InferenceConditionRetryability
    | typeof INFERENCE_RETRY_DISPOSITION_UNAVAILABLE;
  retryDecision: InferenceRetryDecision | typeof INFERENCE_RETRY_DISPOSITION_UNAVAILABLE;
}

/**
 * Whether a record's own retry policy could retry a `no-progress` stop: only
 * one that applied a no-progress budget. A record written before that budget
 * existed recorded the stop as not eligible, and still reads that way.
 */
export function recordRetriesNoProgress(execution: {
  readonly conditionRetry?: { readonly maxNoProgressRetries?: number };
}): boolean {
  return execution.conditionRetry?.maxNoProgressRetries !== undefined;
}

/**
 * The failure categories no retry may follow in this record: the taxonomy's
 * non-retryable set, plus `no-progress` when the record had no budget for it.
 */
export function terminalInferenceCategories(execution: {
  readonly conditionRetry?: { readonly maxNoProgressRetries?: number };
}): readonly InferenceFailureCategory[] {
  return recordRetriesNoProgress(execution)
    ? NON_RETRYABLE_INFERENCE_FAILURE_CATEGORIES
    : [...NON_RETRYABLE_INFERENCE_FAILURE_CATEGORIES, "no-progress"];
}

/**
 * Eligible means the outcome is one of the taxonomy's configurable retry
 * categories, whether or not a particular policy lists it. `no-progress` is
 * eligible only under a policy that has a budget for it; a reader passes
 * `recordRetriesNoProgress` of the record it judges.
 */
export function inferenceConditionRetryability(
  outcome: InferenceAttemptOutcome,
  options: { readonly noProgressRetry: boolean },
): InferenceConditionRetryability {
  if (outcome === INFERENCE_ATTEMPT_SUCCESS_OUTCOME) return "not-applicable";
  if (outcome === "no-progress" && !options.noProgressRetry) return "not-eligible";
  return isConfigurableRetryCategory(outcome) ? "eligible" : "not-eligible";
}

export interface InferenceRetryDecisionInput {
  outcome: InferenceAttemptOutcome;
  /** 1-based. */
  attempt: number;
  /** Retries the effective policy permits after the first attempt. */
  effectiveMaxRetries: number;
  /**
   * Categories the effective policy lists. A write-capable step lists none,
   * however the run was configured; passing the configured list would claim a
   * retry window the step never had.
   */
  policyRetryableCategories: readonly InferenceFailureCategory[];
  retryScheduled: boolean;
  /**
   * True when a nonzero budget's other bound stopped the retry before its
   * count did: the transport wall clock (`retry.transportMaxElapsedMs`).
   */
  budgetExhausted?: boolean;
  /** See {@link recordRetriesNoProgress}. */
  noProgressRetry: boolean;
}

/**
 * `exhausted` only when a listed eligible condition occurs past the last retry
 * a nonzero budget allowed, or that budget's wall clock ran out first. Any
 * other non-retry of an eligible condition is `declined`. A zero budget is a
 * decline because no retry window ever opened; `DOCSFAB_READ_ONLY_MAX_RETRIES`
 * can resolve to 0.
 */
export function projectInferenceRetryDecision(
  input: InferenceRetryDecisionInput,
): InferenceRetryDecision {
  if (input.retryScheduled) return "retried";
  if (
    inferenceConditionRetryability(input.outcome, { noProgressRetry: input.noProgressRetry }) !==
    "eligible"
  ) {
    return "not-applicable";
  }
  const listed = input.policyRetryableCategories.includes(
    input.outcome as InferenceFailureCategory,
  );
  if (!listed) return "declined";
  if (input.effectiveMaxRetries < 1) return "declined";
  // On the boundary attempt a retry was still available, so something else declined it.
  return input.attempt > input.effectiveMaxRetries || input.budgetExhausted === true
    ? "exhausted"
    : "declined";
}

export interface RemainingRetryBudgetInput {
  /** 1-based. */
  attempt: number;
  /** Retries the effective policy permits after the first attempt. */
  effectiveMaxRetries: number;
  retryScheduled: boolean;
}

/**
 * Retries still available after this attempt's decision. A declined first
 * attempt with budget 3 still reports 3; a scheduled retry on attempt 1
 * reports 2.
 */
export function remainingRetryBudget(input: RemainingRetryBudgetInput): number {
  const spent = input.retryScheduled ? input.attempt : Math.max(0, input.attempt - 1);
  return Math.max(0, input.effectiveMaxRetries - spent);
}

export function isInferenceConditionRetryability(
  value: unknown,
): value is InferenceConditionRetryability {
  return (INFERENCE_CONDITION_RETRYABILITIES as readonly unknown[]).includes(value);
}

export function isInferenceRetryDecision(value: unknown): value is InferenceRetryDecision {
  return (INFERENCE_RETRY_DECISIONS as readonly unknown[]).includes(value);
}

/**
 * Read both facts off a recorded attempt without guessing either. A
 * half-present pair is malformed and also reads unavailable. Never consult
 * `retryable` or `retryScheduled` here.
 */
export function readInferenceRetryDisposition(
  attempt: Pick<InferenceAttemptEvidence, "conditionRetryability" | "retryDecision">,
): InferenceRetryDispositionReading {
  const conditionRetryability = attempt.conditionRetryability;
  const retryDecision = attempt.retryDecision;
  if (
    !isInferenceConditionRetryability(conditionRetryability) ||
    !isInferenceRetryDecision(retryDecision)
  ) {
    return {
      conditionRetryability: INFERENCE_RETRY_DISPOSITION_UNAVAILABLE,
      retryDecision: INFERENCE_RETRY_DISPOSITION_UNAVAILABLE,
    };
  }
  return { conditionRetryability, retryDecision };
}

export interface InferenceRetryBackoffPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * The provider's requested wait in milliseconds, or 0. A `Retry-After` is
 * honoured only beside the HTTP status of the response that carried it; a
 * recorded wait without one is not something any response stated.
 */
export function honouredRetryAfterMs(
  providerError: Pick<ProviderErrorTelemetryV1, "httpStatus" | "retryAfterMs"> | undefined,
): number {
  const requested = providerError?.retryAfterMs;
  return isHttpStatus(providerError?.httpStatus) &&
    requested !== undefined &&
    Number.isSafeInteger(requested) &&
    requested > 0
    ? requested
    : 0;
}

/**
 * The wait a step-level retry schedules after `failedAttempt` (1-based): the
 * exponential wait, lengthened to an honoured `Retry-After` and capped at
 * `maxDelayMs`. Replaying sooner than the provider asked spends the retry on
 * the same refusal.
 *
 * The scheduler and every validator that re-derives `backoffMs` share this
 * function so the formula cannot drift.
 */
export function inferenceRetryBackoffMs(
  policy: InferenceRetryBackoffPolicy,
  failedAttempt: number,
  providerError?: Pick<ProviderErrorTelemetryV1, "httpStatus" | "retryAfterMs">,
): number {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, failedAttempt - 1);
  return Math.min(policy.maxDelayMs, Math.max(exponential, honouredRetryAfterMs(providerError)));
}

/**
 * True when a scheduled attempt's `backoffMs` matches
 * {@link inferenceRetryBackoffMs}. The plain exponential wait is also admitted
 * because older records scheduled it even when a longer `Retry-After` was
 * recorded.
 */
export function isRecordedInferenceRetryBackoff(
  policy: InferenceRetryBackoffPolicy,
  attempt: Pick<InferenceAttemptEvidence, "attempt" | "backoffMs" | "modelTelemetry">,
  /** The attempt's position in its own budget; the raw attempt number when omitted. */
  ordinal: number = attempt.attempt,
): boolean {
  const honoured = inferenceRetryBackoffMs(policy, ordinal, attempt.modelTelemetry?.providerError);
  const legacy = inferenceRetryBackoffMs(policy, ordinal);
  return (
    Number.isSafeInteger(honoured) &&
    (attempt.backoffMs === honoured || attempt.backoffMs === legacy)
  );
}

/**
 * Categories a step may retry from its transport budget instead of its
 * contract-correction count: the provider answered nothing the contract could
 * judge. `throttled` is a 429; `provider-transient` is a 5xx, a network fault,
 * or a stream that closed before it finished. `timeout` is excluded because an
 * expired attempt already spent its whole attempt timer; it keeps its own
 * smaller budget inside the contract count.
 */
export const TRANSPORT_RETRY_CATEGORIES = Object.freeze([
  "throttled",
  "provider-transient",
] as const satisfies readonly InferenceFailureCategory[]);

export function isTransportRetryCategory(value: unknown): value is InferenceFailureCategory {
  return (TRANSPORT_RETRY_CATEGORIES as readonly unknown[]).includes(value);
}

/**
 * Whether a record's transport block is well formed against the categories the
 * step's effective policy retried. Closed: integers, and a non-empty,
 * duplicate-free category list drawn from both sets.
 */
export function isInferenceTransportRetryEvidence(
  value: unknown,
  effectiveRetryableCategories: readonly InferenceFailureCategory[],
): value is InferenceTransportRetryEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item).sort();
  if (keys.join(",") !== "categories,maxDelayMs,maxElapsedMs,maxRetries") return false;
  const integers = [item.maxRetries, item.maxDelayMs, item.maxElapsedMs];
  if (!integers.every((entry) => Number.isSafeInteger(entry) && Number(entry) >= 0)) return false;
  const categories = item.categories;
  return (
    Array.isArray(categories) &&
    categories.length > 0 &&
    new Set(categories).size === categories.length &&
    categories.every(
      (category) =>
        isTransportRetryCategory(category) && effectiveRetryableCategories.includes(category),
    )
  );
}

/** Which budget judged one attempt, and where the attempt sits in it. */
export interface InferenceAttemptBudgetPosition {
  readonly budget: "contract" | "transport";
  /** 1-based position among the attempts this budget judged. */
  readonly ordinal: number;
  /** Retries this budget permits after its first attempt. */
  readonly maxRetries: number;
  /** The wait formula a retry scheduled from this budget used. */
  readonly backoff: InferenceRetryBackoffPolicy;
  /**
   * Transport wall clock this attempt would spend if retried: every earlier
   * transport attempt's duration and wait, this attempt's duration, and the
   * wait the formula gives it. Zero for a contract attempt.
   */
  readonly transportElapsedMs: number;
  /** True when that wall clock passes `retry.transportMaxElapsedMs`. */
  readonly elapsedExhausted: boolean;
}

type BudgetedInference = Pick<
  InferenceExecutionEvidence,
  "effectiveMaxRetries" | "baseDelayMs" | "maxDelayMs" | "transportRetry"
>;

type BudgetedAttempt = Pick<InferenceAttemptEvidence, "outcome"> &
  Partial<Pick<InferenceAttemptEvidence, "durationMs" | "backoffMs" | "modelTelemetry">>;

/**
 * Each attempt's budget position. A transport-failed attempt advances only the
 * transport ordinal, so the contract ordinal counts the attempts the model's
 * answer could be judged on. Without a transport block every attempt is a
 * contract attempt and its ordinal is its attempt number, as before.
 *
 * The writer (`executeInferenceStep`) and every record reader derive positions
 * here, through `projectRetryRules` in `inference-retry-rule.ts`, so the split
 * cannot drift between them.
 */
export function inferenceAttemptBudgetPositions(
  inference: BudgetedInference,
  attempts: readonly BudgetedAttempt[],
): InferenceAttemptBudgetPosition[] {
  const transport = inference.transportRetry;
  const contractBackoff = { baseDelayMs: inference.baseDelayMs, maxDelayMs: inference.maxDelayMs };
  let contract = 0;
  let transported = 0;
  let spentMs = 0;
  return attempts.map((attempt) => {
    if (transport?.categories.includes(attempt.outcome as InferenceFailureCategory)) {
      transported += 1;
      const backoff = { baseDelayMs: inference.baseDelayMs, maxDelayMs: transport.maxDelayMs };
      const durationMs = attempt.durationMs ?? 0;
      // The wait the writer weighed, whether or not it then scheduled it.
      const waitMs = inferenceRetryBackoffMs(
        backoff,
        transported,
        attempt.modelTelemetry?.providerError,
      );
      const transportElapsedMs = spentMs + durationMs + waitMs;
      spentMs += durationMs + (attempt.backoffMs ?? 0);
      return {
        budget: "transport",
        ordinal: transported,
        maxRetries: transport.maxRetries,
        backoff,
        transportElapsedMs,
        elapsedExhausted: transportElapsedMs > transport.maxElapsedMs,
      };
    }
    contract += 1;
    return {
      budget: "contract",
      ordinal: contract,
      maxRetries: inference.effectiveMaxRetries,
      backoff: contractBackoff,
      transportElapsedMs: 0,
      elapsedExhausted: false,
    };
  });
}

/**
 * The retry decision of an attempt in a record written before retry rules were
 * recorded (no `conditionRetry`), from its budget position. Readers use it
 * only for those records; a newer record's decision is its rule's.
 */
export function projectBudgetedInferenceRetryDecision(input: {
  outcome: InferenceAttemptOutcome;
  position: Pick<InferenceAttemptBudgetPosition, "ordinal" | "maxRetries" | "elapsedExhausted">;
  policyRetryableCategories: readonly InferenceFailureCategory[];
  retryScheduled: boolean;
  /** The attempt's recorded `retryable`; a condition nobody may retry spent no budget. */
  retryable: boolean;
}): InferenceRetryDecision {
  return projectInferenceRetryDecision({
    outcome: input.outcome,
    attempt: input.position.ordinal,
    effectiveMaxRetries: input.position.maxRetries,
    policyRetryableCategories: input.policyRetryableCategories,
    retryScheduled: input.retryScheduled,
    budgetExhausted: input.retryable && input.position.elapsedExhausted,
    // Only a record without condition budgets reaches here, and no such
    // record had a no-progress budget.
    noProgressRetry: false,
  });
}

/**
 * Whether a recorded attempt sequence stays inside both budgets: no more
 * attempts than the two allow together, every scheduled retry inside its own
 * budget, and every scheduled transport retry inside the transport wall clock.
 */
export function inferenceAttemptsWithinBudgets(
  inference: BudgetedInference,
  attempts: readonly (BudgetedAttempt & Pick<InferenceAttemptEvidence, "retryScheduled">)[],
): boolean {
  const transport = inference.transportRetry;
  if (attempts.length - 1 > inference.effectiveMaxRetries + (transport?.maxRetries ?? 0)) {
    return false;
  }
  const positions = inferenceAttemptBudgetPositions(inference, attempts);
  return attempts.every((attempt, index) => {
    const position = positions[index]!;
    return (
      !attempt.retryScheduled ||
      (position.ordinal <= position.maxRetries && !position.elapsedExhausted)
    );
  });
}
