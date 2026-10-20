// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The closed vocabularies a retry decision records: the catalog retry-rule ids
 * and the failure conditions. A leaf, so record decoders can check a saved
 * attempt without importing the decider or the replay policy.
 */
import { RETRY_RULES, type RetryRuleId } from "../contracts/model-output.generated.js";
import type {
  InferenceConcludeNowEvidenceV1,
  InferenceConcludeNowTrigger,
  InferenceDeadlineTurn,
  InferenceFailureCondition,
  InferenceRetryDecision,
} from "./contracts.js";

export { RETRY_RULES, type RetryRuleId };

export const INFERENCE_FAILURE_CONDITIONS = Object.freeze([
  "unframed-reply",
  "cut-answer",
  "attempt-deadline",
  "provider-timeout",
  "tool-call-ceiling",
] as const satisfies readonly InferenceFailureCondition[]);

/** Fails to typecheck when `InferenceFailureCondition` gains a member not listed above. */
export const INFERENCE_FAILURE_CONDITION_COVERAGE: [InferenceFailureCondition] extends [
  (typeof INFERENCE_FAILURE_CONDITIONS)[number],
]
  ? true
  : never = true;

export function isInferenceFailureCondition(value: unknown): value is InferenceFailureCondition {
  return (INFERENCE_FAILURE_CONDITIONS as readonly unknown[]).includes(value);
}

export function isRetryRuleId(value: unknown): value is RetryRuleId {
  return typeof value === "string" && Object.hasOwn(RETRY_RULES, value);
}

/** The record's decision for a rule; the catalog declares it once. */
export function retryRuleDecision(rule: RetryRuleId): InferenceRetryDecision {
  return RETRY_RULES[rule].decision;
}

/**
 * The retried rule each condition's retry follows. The decider reads it for
 * every attempt that records a condition, and a correction's statement falls
 * back to it.
 */
const RETRIED_RULE_BY_CONDITION = Object.freeze({
  "unframed-reply": "retried-unframed-reply",
  "cut-answer": "retried-cut-answer",
  "attempt-deadline": "retried-attempt-deadline",
  "provider-timeout": "retried-provider-timeout",
  "tool-call-ceiling": "retried-tool-call-ceiling",
} as const satisfies Record<InferenceFailureCondition, RetryRuleId>);

/** The retried rule a retry after `condition` follows. */
export function retriedRuleForCondition(condition: InferenceFailureCondition): RetryRuleId {
  return RETRIED_RULE_BY_CONDITION[condition];
}

/**
 * The catalog feedback a retry after `condition` carries, or `undefined` when
 * its rule has none. Host-authored text only.
 */
export function retryConditionStatement(condition: unknown): string | undefined {
  if (!isInferenceFailureCondition(condition)) return undefined;
  return RETRY_RULES[RETRIED_RULE_BY_CONDITION[condition]].statement ?? undefined;
}

/** Every recorded place the host's attempt timer can find an attempt. */
export const INFERENCE_DEADLINE_TURNS = Object.freeze([
  "awaiting-first-byte",
  "streaming-answer",
  "streaming-tool-call",
  "streaming",
  "between-requests",
] as const satisfies readonly InferenceDeadlineTurn[]);

export function isInferenceDeadlineTurn(value: unknown): value is InferenceDeadlineTurn {
  return (INFERENCE_DEADLINE_TURNS as readonly unknown[]).includes(value);
}

/** Every recorded reason the host asked for the answer inside an attempt. */
export const INFERENCE_CONCLUDE_NOW_TRIGGERS = Object.freeze([
  "read-loop",
  "reading-budget",
  "attempt-deadline",
] as const satisfies readonly InferenceConcludeNowTrigger[]);

/** The closed shape of a conclude-now record: its trigger and a positive turn. */
export function isInferenceConcludeNowEvidence(
  value: unknown,
): value is InferenceConcludeNowEvidenceV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    Object.keys(item).sort().join(",") === "trigger,turn" &&
    (INFERENCE_CONCLUDE_NOW_TRIGGERS as readonly unknown[]).includes(item.trigger) &&
    Number.isSafeInteger(item.turn) &&
    Number(item.turn) >= 1
  );
}

/** Whether a correction's retry rule asks the harness to conclude now. */
export function concludesNow(rule: unknown): boolean {
  return isRetryRuleId(rule) && RETRY_RULES[rule].concludeNow;
}

/**
 * The catalog feedback a correction carries: its retry rule's statement when
 * it names a rule that has one, otherwise its condition's.
 */
export function retryCorrectionStatement(correction: {
  readonly retryRule?: unknown;
  readonly condition?: unknown;
}): string | undefined {
  const rule = correction.retryRule;
  const ruleStatement = isRetryRuleId(rule) ? RETRY_RULES[rule].statement : null;
  return ruleStatement ?? retryConditionStatement(correction.condition);
}
