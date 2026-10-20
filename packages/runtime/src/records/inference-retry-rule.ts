// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one decider for what a step does about a failed inference attempt.
 *
 * Every rule, its decision, its budget, and its retry feedback are declared in
 * `config/model-output/retry-policy.yaml` (`RETRY_RULES`). This module only
 * orders them. The writer (`executeInferenceStep`) and every record validator
 * call {@link projectRetryRules} over the same attempt sequence, so a recorded
 * `retryRule` is always one this function would have chosen, and the recorded
 * `retryDecision` is the rule's own decision.
 *
 * Raise sites classify (`retryable`, `condition`); they never decide. A refusal
 * whose raiser marked it terminal (security, authority, host) stays terminal.
 */
import type { RetryRuleId } from "../contracts/model-output.generated.js";
import {
  INFERENCE_ATTEMPT_SUCCESS_OUTCOME,
  type InferenceAttemptOutcome,
} from "../inference-attempt-taxonomy.js";
import type {
  InferenceAttemptEvidence,
  InferenceConditionRetryEvidence,
  InferenceExecutionEvidence,
  InferenceFailureCategory,
  InferenceFailureCondition,
} from "./contracts.js";
import { effectiveInferenceRetryCategories } from "./inference-replay.js";
import {
  inferenceAttemptBudgetPositions,
  inferenceConditionRetryability,
  recordRetriesNoProgress,
} from "./inference-retry-disposition.js";

export {
  concludesNow,
  isInferenceConcludeNowEvidence,
  isInferenceDeadlineTurn,
  INFERENCE_FAILURE_CONDITIONS,
  isInferenceFailureCondition,
  isRetryRuleId,
  RETRY_RULES,
  retryRuleDecision,
  type RetryRuleId,
} from "./inference-retry-rule-vocabulary.js";
import {
  isInferenceConcludeNowEvidence,
  RETRY_RULES,
  retriedRuleForCondition,
  retryRuleDecision,
} from "./inference-retry-rule-vocabulary.js";

/**
 * The subset of the contract count a condition spends, when it has one.
 * `timed-out` covers both timeout conditions.
 */
type ConditionBudget = "timed-out" | "cut-answer" | "no-progress";

const TIMEOUT_RETRY_RULES: readonly RetryRuleId[] = [
  "retried-attempt-deadline",
  "retried-provider-timeout",
];

/** The retries that spend the no-progress subset: a read loop and a tool-call ceiling stop. */
const NO_PROGRESS_RETRY_RULES: readonly RetryRuleId[] = [
  "retried-no-progress",
  "retried-tool-call-ceiling",
];

export type RetryRuleExecution = Pick<
  InferenceExecutionEvidence,
  | "effectiveMaxRetries"
  | "baseDelayMs"
  | "maxDelayMs"
  | "retryableCategories"
  | "replay"
  | "transportRetry"
  | "conditionRetry"
>;

export type RetryRuleAttempt = Pick<InferenceAttemptEvidence, "outcome" | "retryable"> &
  Partial<
    Pick<
      InferenceAttemptEvidence,
      | "condition"
      | "durationMs"
      | "backoffMs"
      | "modelTelemetry"
      | "concludeNow"
      | "writeSettlement"
    >
  >;

function conditionBudgetOf(attempt: RetryRuleAttempt): ConditionBudget | undefined {
  if (attempt.outcome === "timeout") return "timed-out";
  if (attempt.outcome === "no-progress") return "no-progress";
  if (attempt.outcome === "malformed-response" && attempt.condition === "cut-answer") {
    return "cut-answer";
  }
  return undefined;
}

function retriedRuleFor(attempt: RetryRuleAttempt): RetryRuleId {
  // A condition its outcome may carry names its own retry, from one table.
  if (attempt.condition !== undefined && conditionFitsOutcome(attempt.condition, attempt.outcome)) {
    return retriedRuleForCondition(attempt.condition);
  }
  switch (attempt.outcome) {
    case "timeout":
      return "retried-provider-timeout";
    case "blank-response":
      return "retried-blank-reply";
    case "no-progress":
      return "retried-no-progress";
    case "throttled":
    case "provider-transient":
      // Only a policy without a transport budget charges these to the contract
      // count; the rule still names what happened.
      return "retried-transport";
    default:
      return "retried-contract-correction";
  }
}

/**
 * The retry rule of every attempt, in order. Rule `i` reads attempts `0..i`
 * only, so the writer gets the current attempt's rule by passing the attempts
 * so far plus the current one.
 *
 * Order, first match wins:
 * 1. success or an ineligible condition: `not-applicable`;
 * 2. the replay mode never replays this condition: `declined-write-step`,
 *    `declined-reset-write-step`;
 * 3. the configured categories omit it: `declined-terminal-policy`;
 * 4. the judging budget (transport for a transport fault; otherwise
 *    the contract count) allows no retry, or was already spent;
 * 5. the raiser marked it terminal: `declined-host-refusal`;
 * 6. a transport wall clock spent, or the condition's own subset of the
 *    contract count (timeout, cut answer, no-progress), counted in retries of
 *    that condition already scheduled. A read-loop stop and a tool-call
 *    ceiling stop share the no-progress subset.
 *
 * A `no-progress` stop is eligible only in a record whose policy applied a
 * no-progress budget (`recordRetriesNoProgress`).
 */
export function projectRetryRules(
  execution: RetryRuleExecution,
  attempts: readonly RetryRuleAttempt[],
): RetryRuleId[] {
  const positions = inferenceAttemptBudgetPositions(execution, attempts);
  const effective = effectiveInferenceRetryCategories(
    execution.replay,
    execution.retryableCategories,
    execution.transportRetry !== undefined,
  );
  const transport = execution.transportRetry;
  const subsetMax: Record<ConditionBudget, number> = {
    "timed-out": Math.min(
      execution.conditionRetry?.maxTimeoutRetries ?? 0,
      execution.effectiveMaxRetries,
    ),
    "cut-answer": Math.min(
      execution.conditionRetry?.maxCutAnswerRetries ?? 0,
      execution.effectiveMaxRetries,
    ),
    "no-progress": Math.min(
      execution.conditionRetry?.maxNoProgressRetries ?? 0,
      execution.effectiveMaxRetries,
    ),
  };
  const subsetUsed: Record<ConditionBudget, number> = {
    "timed-out": 0,
    "cut-answer": 0,
    "no-progress": 0,
  };
  const noProgressRetry = recordRetriesNoProgress(execution);
  const ruleFor = (
    current: RetryRuleAttempt,
    position: (typeof positions)[number],
  ): RetryRuleId => {
    const outcome = current.outcome as InferenceAttemptOutcome;
    if (outcome === INFERENCE_ATTEMPT_SUCCESS_OUTCOME) return "not-applicable";
    if (inferenceConditionRetryability(outcome, { noProgressRetry }) !== "eligible") {
      return "not-applicable";
    }
    const category = outcome as InferenceFailureCategory;
    if (
      execution.replay === "disabled-write-step" &&
      (position.budget !== "transport" || current.writeSettlement !== "no-write")
    ) {
      return "declined-write-step";
    }
    if (execution.replay === "reset-write-step" && !effective.includes(category)) {
      return "declined-reset-write-step";
    }
    if (!effective.includes(category)) return "declined-terminal-policy";
    if (position.budget === "transport" && transport) {
      if (transport.maxRetries < 1) return "declined-no-transport-allowance";
      if (position.ordinal > transport.maxRetries) return "exhausted-transport-count";
      if (!current.retryable) return "declined-host-refusal";
      if (position.elapsedExhausted) return "exhausted-transport-elapsed";
      return "retried-transport";
    }
    if (execution.effectiveMaxRetries < 1) return "declined-no-allowance";
    if (position.ordinal > execution.effectiveMaxRetries) return "exhausted";
    if (!current.retryable) return "declined-host-refusal";
    const subset = conditionBudgetOf(current);
    if (subset === "timed-out") {
      if (subsetMax["timed-out"] < 1) return "declined-no-timeout-allowance";
      if (subsetUsed["timed-out"] >= subsetMax["timed-out"]) return "exhausted-timeout-budget";
    }
    if (subset === "cut-answer") {
      if (subsetMax["cut-answer"] < 1) return "declined-no-cut-answer-allowance";
      if (subsetUsed["cut-answer"] >= subsetMax["cut-answer"]) {
        return "exhausted-cut-answer-budget";
      }
    }
    if (subset === "no-progress") {
      if (subsetMax["no-progress"] < 1) return "declined-no-progress-allowance";
      if (subsetUsed["no-progress"] >= subsetMax["no-progress"]) {
        return "exhausted-no-progress-budget";
      }
    }
    return retriedRuleFor(current);
  };
  return attempts.map((attempt, index) => {
    const rule = ruleFor(attempt, positions[index]!);
    if (rule === "retried-cut-answer") subsetUsed["cut-answer"] += 1;
    if (NO_PROGRESS_RETRY_RULES.includes(rule)) subsetUsed["no-progress"] += 1;
    if (TIMEOUT_RETRY_RULES.includes(rule)) subsetUsed["timed-out"] += 1;
    return rule;
  });
}

/** The rule for the last attempt in `attempts`. */
export function projectLastRetryRule(
  execution: RetryRuleExecution,
  attempts: readonly RetryRuleAttempt[],
): RetryRuleId {
  const rules = projectRetryRules(execution, attempts);
  const last = rules.at(-1);
  if (last === undefined) throw new Error("A retry rule needs at least one attempt.");
  return last;
}

/** Which conditions each outcome may record. */
export function conditionFitsOutcome(
  condition: InferenceFailureCondition | undefined,
  outcome: InferenceAttemptEvidence["outcome"],
): boolean {
  if (outcome === "timeout") {
    // A timeout always names which timer fired.
    return condition === "attempt-deadline" || condition === "provider-timeout";
  }
  if (condition === undefined) return true;
  if (condition === "tool-call-ceiling") return outcome === "no-progress";
  return (
    outcome === "malformed-response" &&
    (condition === "unframed-reply" || condition === "cut-answer")
  );
}

/** Whether a record's applied condition budgets are well formed: integers held under the count. */
export function isInferenceConditionRetryEvidence(
  value: unknown,
  effectiveMaxRetries: number,
): value is InferenceConditionRetryEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item).sort().join(",");
  // The no-progress budget is absent on records written before it existed.
  if (
    keys !== "maxCutAnswerRetries,maxTimeoutRetries" &&
    keys !== "maxCutAnswerRetries,maxNoProgressRetries,maxTimeoutRetries"
  ) {
    return false;
  }
  return [item.maxTimeoutRetries, item.maxCutAnswerRetries, item.maxNoProgressRetries]
    .filter((entry) => entry !== undefined)
    .every(
      (entry) =>
        Number.isSafeInteger(entry) && Number(entry) >= 0 && Number(entry) <= effectiveMaxRetries,
    );
}

/**
 * The rule whose correction attempt `index` runs under. A transport retry
 * re-sends the same correction, because a transport fault produced no answer
 * to correct, so it is skipped and the last judged rule before it applies.
 * `correctionAfter` in `workflow-execution/retry.ts` makes the same choice.
 */
export function correctionRuleBefore(
  rules: readonly RetryRuleId[],
  index: number,
): RetryRuleId | undefined {
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    if (rules[previous] !== "retried-transport") return rules[previous];
  }
  return undefined;
}

/**
 * Whether every attempt of a record that applied condition budgets carries the
 * rule {@link projectRetryRules} derives, the decision that rule declares, a
 * `retryScheduled` that matches it, and a condition its outcome may have. A
 * record without `conditionRetry` carries no rule; its decision is checked the
 * older way, by the caller.
 */
export function inferenceAttemptRulesConsistent(
  execution: RetryRuleExecution,
  attempts: readonly (RetryRuleAttempt &
    Pick<InferenceAttemptEvidence, "retryScheduled" | "retryRule" | "retryDecision">)[],
): boolean {
  if (execution.replay === "disabled-write-step") {
    const positions = inferenceAttemptBudgetPositions(execution, attempts);
    if (
      attempts.some(
        (attempt, index) =>
          attempt.retryScheduled &&
          (positions[index]?.budget !== "transport" || attempt.writeSettlement !== "no-write"),
      )
    ) {
      return false;
    }
  }
  if (execution.conditionRetry === undefined) {
    return attempts.every((attempt) => attempt.retryRule === undefined);
  }
  if (!attempts.every((attempt) => conditionFitsOutcome(attempt.condition, attempt.outcome))) {
    return false;
  }
  const rules = projectRetryRules(execution, attempts);
  return attempts.every((attempt, index) => {
    const rule = rules[index]!;
    // Only an attempt whose correction came from a conclude-now rule may record
    // that a read loop made the host withdraw the tools; the reading-budget and
    // attempt-deadline asks are timed, so any attempt may record them.
    const scheduling = correctionRuleBefore(rules, index);
    const concludeNowAllowed = scheduling !== undefined && RETRY_RULES[scheduling].concludeNow;
    return (
      attempt.retryRule === rule &&
      attempt.retryDecision === retryRuleDecision(rule) &&
      attempt.retryScheduled === (retryRuleDecision(rule) === "retried") &&
      (attempt.concludeNow === undefined ||
        (isInferenceConcludeNowEvidence(attempt.concludeNow) &&
          (attempt.concludeNow.trigger !== "read-loop" || concludeNowAllowed)))
    );
  });
}

/**
 * The condition the writer records for a failure: the raiser's, when its
 * outcome may carry it, and `provider-timeout` for a timeout nobody marked as
 * the host's own deadline.
 */
export function recordedFailureCondition(
  outcome: InferenceFailureCategory,
  raised: InferenceFailureCondition | undefined,
): InferenceFailureCondition | undefined {
  const condition = raised ?? (outcome === "timeout" ? "provider-timeout" : undefined);
  if (condition === undefined) return undefined;
  if (conditionFitsOutcome(condition, outcome)) return condition;
  return outcome === "timeout" ? "provider-timeout" : undefined;
}
