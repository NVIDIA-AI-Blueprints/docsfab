// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  isRetainableInferenceRejection,
  MAX_INFERENCE_REJECTION_REASON_LENGTH,
} from "../config/inference-rejection-limits.js";
import { attemptEndedAtToolCallCeiling } from "../config/execution-limit-stops.js";
import type {
  ExecutionLeaseRuntimeEvidenceV1,
  InferenceRejectionReasonV1,
} from "../execution/contracts.js";
import { decodeModelEvidence, decodeTools, decodeUsage } from "../execution/inference-evidence.js";
import { isRejectedReplyExcerptOf } from "../execution/rejected-reply-excerpt.js";
import { isInferenceRejectionSubject } from "../execution/rejection-subject.js";
import { isInferenceRejectedReplyShape } from "../execution/rejected-reply-shape.js";
import { isJudgmentRowKeyAudit } from "../execution/judgment-row-key-audit-contract.js";
import { isInferenceAttemptModelTelemetry } from "../records/model-telemetry.js";
import { producedTurnOutputTokenLimit } from "../model/context-budget.js";
import {
  REQUEST_POLICY_REFUSAL_IDS,
  isAdmissibleRequestPolicyRefusal,
} from "../model/request-policy-refusals.js";
import {
  CONFIGURABLE_RETRY_CATEGORIES,
  INFERENCE_FAILURE_CATEGORIES,
  isMalformedResponseCategory,
} from "../inference-attempt-taxonomy.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import {
  isLegacyHostPathDisclosure,
  isProviderResponseEvidenceV1,
  isInferenceEfficiencyEvidenceV1,
  type InferenceAttemptEvidence,
  type InferenceTransportRetryEvidence,
  type InferenceCompactionEvidence,
  type InferenceEvidenceIdentity,
  type InferenceExecutionEvidence,
  type InferenceConditionRetryEvidence,
  type InferenceFailureCategory,
  type InferenceOutputAuthorityEvidence,
  type InferenceTurnEvidence,
  type ModelProfileEvidence,
  type ToolActivitySummary,
} from "../records/contracts.js";
import {
  INFERENCE_CONDITION_RETRYABILITIES,
  INFERENCE_RETRY_DECISIONS,
  PROVIDER_TURN_REPLAY_VETOES,
  inferenceConditionRetryability,
  inferenceAttemptBudgetPositions,
  recordRetriesNoProgress,
  inferenceAttemptsWithinBudgets,
  isInferenceTransportRetryEvidence,
  isTransportRetryCategory,
  isRecordedInferenceRetryBackoff,
  projectBudgetedInferenceRetryDecision,
} from "../records/inference-retry-disposition.js";
import { isInferenceAnswerSubmissionEvidence } from "../records/answer-submission-evidence.js";
import {
  inferenceAttemptRulesConsistent,
  isInferenceConcludeNowEvidence,
  isInferenceDeadlineTurn,
  isInferenceConditionRetryEvidence,
  isInferenceFailureCondition,
  isRetryRuleId,
} from "../records/inference-retry-rule.js";
import {
  effectiveInferenceRetryCategories,
  replayKeepsConfiguredBudget,
} from "../records/inference-replay.js";
import {
  array,
  boolean,
  canonical,
  evidenceDigest,
  exact,
  executionTerminalPairIsValid,
  nonnegativeInteger,
  object,
  oneOf,
  optionalNonnegativeInteger,
  pattern,
  positiveInteger,
  requireCondition,
  requireEqual,
  safeSum,
  safeText,
  timestamp,
  uniqueEnumArray,
  uniqueSortedIdentifiers,
  REVISION,
  SHA256,
} from "../scorecard-record-parse.js";

// The retry/attempt vocabulary has one owner. Re-declaring either set here lets
// the decoder and the runtime drift apart silently.
const FAILURE_CATEGORIES: readonly InferenceFailureCategory[] = INFERENCE_FAILURE_CATEGORIES;

const RETRYABLE_CATEGORIES: readonly InferenceFailureCategory[] = CONFIGURABLE_RETRY_CATEGORIES;

const TURN_REASONS = [
  "context-exhausted",
  "provider-turn-limit",
  "tool-call-limit",
  "compaction-limit",
  "compaction-ineffective",
  "evidence-preservation-required",
  "output-authority-exhausted",
] as const;

const EXECUTION_TERMINAL_REASONS = [
  "completed",
  "needs-input",
  "needs-human-decision",
  "security-denied",
  "authorization-denied",
  "cancellation-requested",
  "evidence-preservation-required",
  "context-exhausted",
  "hard-tool-call-ceiling",
  "cumulative-input-limit",
  "cumulative-output-limit",
  "output-authority-exhausted",
  "cumulative-time-limit",
  "cost-unavailable",
  "cumulative-cost-limit",
  "provider-turn-limit",
  "lease-limit",
  "checkpoint-not-renewable",
  "provider-terminal",
  "provider-unavailable",
] as const;

const EXECUTION_TERMINAL_DISPOSITIONS = [
  "completed",
  "needs-input",
  "needs-human-decision",
  "cancelled",
  "provider-failed",
  "context-exhausted",
  "blank",
  "malformed",
  "progress-stopped",
  "authorization-denied",
  "evidence-invalid",
  "budget-stopped",
] as const;

function supplementalGovernanceStops(categories: ToolActivitySummary["failureCategories"]): number {
  return categories?.find((entry) => entry.category === "governance-stop")?.count ?? 0;
}

export function decodeInference(
  value: unknown,
  expectedReplay: InferenceExecutionEvidence["replay"] = "read-only",
): InferenceExecutionEvidence {
  const item = object(value);
  exact(item, [
    "configuredMaxRetries",
    "effectiveMaxRetries",
    "baseDelayMs",
    "maxDelayMs",
    "retryableCategories",
    "replay",
    "attempts",
    "maxRetriesSource",
    // Optional: absent on records written before the transport budget.
    "transportRetry",
    // Optional: absent on records written before retry rules were recorded.
    "conditionRetry",
  ]);
  const configuredMaxRetries = nonnegativeInteger(item.configuredMaxRetries);
  const effectiveMaxRetries = nonnegativeInteger(item.effectiveMaxRetries);
  requireCondition(effectiveMaxRetries <= configuredMaxRetries);
  const baseDelayMs = nonnegativeInteger(item.baseDelayMs);
  const maxDelayMs = nonnegativeInteger(item.maxDelayMs);
  requireCondition(baseDelayMs <= maxDelayMs);
  const retryableCategories = uniqueEnumArray(item.retryableCategories, RETRYABLE_CATEGORIES);
  requireEqual(item.replay, expectedReplay);
  // The policy that actually decided, not the one that was configured: a
  // read-only record's effective policy is its configured policy (asserted
  // below), a write-capable step declined every category rather than running
  // out of a budget it never had, and a host-reset writer retries only a
  // malformed reply.
  const effectiveRetryableCategories = effectiveInferenceRetryCategories(
    expectedReplay,
    retryableCategories,
    item.transportRetry !== undefined,
  );
  if (item.transportRetry !== undefined) {
    requireCondition(
      isInferenceTransportRetryEvidence(item.transportRetry, effectiveRetryableCategories),
    );
  }
  const transportRetry = item.transportRetry as InferenceTransportRetryEvidence | undefined;
  if (item.conditionRetry !== undefined) {
    requireCondition(isInferenceConditionRetryEvidence(item.conditionRetry, effectiveMaxRetries));
  }
  const conditionRetry = item.conditionRetry as InferenceConditionRetryEvidence | undefined;
  const budgets = { effectiveMaxRetries, baseDelayMs, maxDelayMs, transportRetry };
  // A no-progress stop is eligible only where the record had a budget for it.
  const noProgressRetry = recordRetriesNoProgress({
    ...(conditionRetry === undefined ? {} : { conditionRetry }),
  });
  const attempts = array(item.attempts).map((attempt) => decodeAttempt(attempt, noProgressRetry));
  // A record that applied condition budgets carries the retry rule of every
  // attempt, and each must be the rule the one decider derives.
  requireCondition(
    inferenceAttemptRulesConsistent(
      {
        ...budgets,
        retryableCategories,
        replay: expectedReplay,
        ...(conditionRetry === undefined ? {} : { conditionRetry }),
      },
      attempts,
    ),
  );
  // Each attempt's decision is re-derived from the budget that judged it.
  const positions = inferenceAttemptBudgetPositions(budgets, attempts);
  for (const [index, attempt] of attempts.entries()) {
    if (attempt.conditionRetryability === undefined || conditionRetry !== undefined) continue;
    requireEqual(
      attempt.retryDecision,
      projectBudgetedInferenceRetryDecision({
        outcome: attempt.outcome,
        position: positions[index]!,
        policyRetryableCategories: effectiveRetryableCategories,
        retryScheduled: attempt.retryScheduled,
        retryable: attempt.retryable,
      }),
    );
  }
  requireCondition(
    replayKeepsConfiguredBudget(expectedReplay)
      ? effectiveMaxRetries === configuredMaxRetries
      : effectiveMaxRetries === 0,
  );
  requireCondition(attempts.length >= 1 && inferenceAttemptsWithinBudgets(budgets, attempts));
  for (const [index, attempt] of attempts.entries()) {
    requireCondition(attempt.attempt === index + 1);
    const position = positions[index]!;
    const final = index === attempts.length - 1;
    if (final) {
      requireCondition(!attempt.retryScheduled && attempt.backoffMs === undefined);
    } else {
      requireCondition(
        attempt.outcome !== "succeeded" &&
          attempt.outcome !== "context-exhausted" &&
          attempt.retryable &&
          attempt.retryScheduled &&
          effectiveRetryableCategories.includes(attempt.outcome),
      );
      // The exponential wait, or the attempt's recorded Retry-After when
      // longer, bounded by maxDelayMs: the writer's own formula.
      requireCondition(
        isRecordedInferenceRetryBackoff(position.backoff, attempt, position.ordinal),
      );
    }
  }
  requireCondition(attempts.slice(0, -1).every((attempt) => attempt.outcome !== "succeeded"));
  if (expectedReplay === "disabled-write-step") {
    requireCondition(
      attempts
        .slice(0, -1)
        .every(
          (attempt) =>
            isTransportRetryCategory(attempt.outcome) &&
            attempt.writeSettlement === "no-write" &&
            attempt.retryScheduled,
        ),
    );
  }
  const maxRetriesSource =
    item.maxRetriesSource === undefined
      ? undefined
      : oneOf(item.maxRetriesSource, ["config/limits.yaml", "host", "project"] as const);
  return {
    configuredMaxRetries,
    effectiveMaxRetries,
    baseDelayMs,
    maxDelayMs,
    retryableCategories,
    replay: expectedReplay,
    attempts,
    ...(maxRetriesSource !== undefined ? { maxRetriesSource } : {}),
    ...(transportRetry !== undefined ? { transportRetry: structuredClone(transportRetry) } : {}),
    ...(conditionRetry !== undefined ? { conditionRetry: structuredClone(conditionRetry) } : {}),
  };
}

/** One attempt's closed shape; `decodeInference` checks its retry decision. */
function decodeAttempt(value: unknown, noProgressRetry: boolean): InferenceAttemptEvidence {
  const item = object(value);
  exact(item, [
    "attempt",
    "outcome",
    // Optional only for records predating this host-origin category.
    "hostFailureOrigin",
    "retryable",
    "retryScheduled",
    "writeSettlement",
    "conditionRetryability",
    "retryDecision",
    // Optional for older records; closed vocabularies, re-derived by decodeInference.
    "retryRule",
    "condition",
    // Succeeded attempts only; the admitted reply span's UTF-8 byte length.
    "answerBytes",
    // A conclude-now retry's trigger and turn; decodeInference checks its rule.
    "concludeNow",
    // Where the attempt timer found the attempt; closed, attempt-deadline only.
    "deadlineTurn",
    // The final quality evaluator's answer path and states; closed, checked below.
    "answerSubmission",
    // Optional so older records decode unchanged; closed and shape-checked below.
    "rejection",
    // Optional for older records. Closed and content-free: the shared validator
    // admits keys, types, and lengths only.
    "rejectedReplyShape",
    // Optional; bounded redacted reply text, only beside the fingerprint.
    "rejectedReplyExcerpt",
    // Optional; host-known paths only, beside the coded refusal.
    "rejectionSubject",
    // Closed host-path match metadata older hosts wrote; checked below.
    "hostPathDisclosure",
    // Accepted judgment replies only; closed, content-free counts.
    "judgmentRowKeyAudit",
    // Optional for older records. Closed enumerations and integers, checked by
    // the shared validator below.
    "modelTelemetry",
    // Optional for older records; closed content-free physical response measurements.
    "providerResponses",
    "efficiency",
    "durationMs",
    "backoffMs",
    "model",
    "usage",
    "tools",
    "identity",
    "turns",
    "executionLease",
  ]);
  const attempt = positiveInteger(item.attempt);
  const outcome = oneOf(item.outcome, ["succeeded", ...FAILURE_CATEGORIES] as const);
  const hostFailureOrigin = decodeHostFailureOrigin(item.hostFailureOrigin);
  requireCondition((outcome === "host-runtime-failure") === (hostFailureOrigin !== undefined));
  const retryable = boolean(item.retryable);
  const retryScheduled = boolean(item.retryScheduled);
  const writeSettlement =
    item.writeSettlement === undefined
      ? undefined
      : oneOf(item.writeSettlement, ["no-write", "write-executed", "unavailable"] as const);
  // Optional so records written before the condition/decision split decode
  // unchanged. When present, the pair is checked against the shipped taxonomy
  // and this record's own policy, so a decision copied into the retryability
  // field, or a guessed value, is rejected rather than read as evidence.
  const conditionRetryability =
    item.conditionRetryability === undefined
      ? undefined
      : oneOf(item.conditionRetryability, INFERENCE_CONDITION_RETRYABILITIES);
  const retryDecision =
    item.retryDecision === undefined
      ? undefined
      : oneOf(item.retryDecision, INFERENCE_RETRY_DECISIONS);
  requireCondition((conditionRetryability === undefined) === (retryDecision === undefined));
  if (conditionRetryability !== undefined) {
    requireEqual(
      conditionRetryability,
      inferenceConditionRetryability(outcome, { noProgressRetry }),
    );
  }
  if (item.retryRule !== undefined) requireCondition(isRetryRuleId(item.retryRule));
  if (item.condition !== undefined) requireCondition(isInferenceFailureCondition(item.condition));
  const answerBytes = optionalNonnegativeInteger(item.answerBytes);
  if (answerBytes !== undefined) requireCondition(outcome === "succeeded");
  if (item.concludeNow !== undefined) {
    requireCondition(isInferenceConcludeNowEvidence(item.concludeNow));
  }
  if (item.deadlineTurn !== undefined) {
    requireCondition(
      isInferenceDeadlineTurn(item.deadlineTurn) && item.condition === "attempt-deadline",
    );
  }
  if (item.answerSubmission !== undefined) {
    requireCondition(isInferenceAnswerSubmissionEvidence(item.answerSubmission));
  }
  const rejection = decodeRejectionReason(item.rejection);
  const rejectedReplyShape = decodeRejectedReplyShape(item.rejectedReplyShape, outcome);
  if (item.rejectedReplyExcerpt !== undefined) {
    requireCondition(isRejectedReplyExcerptOf(item.rejectedReplyExcerpt, rejectedReplyShape));
  }
  if (item.rejectionSubject !== undefined) {
    requireCondition(
      isMalformedResponseCategory(outcome) &&
        rejection !== undefined &&
        isInferenceRejectionSubject(item.rejectionSubject),
    );
  }
  // Closed host-path match metadata, only on a response-contract refusal.
  if (item.hostPathDisclosure !== undefined) {
    requireCondition(
      isMalformedResponseCategory(outcome) && isLegacyHostPathDisclosure(item.hostPathDisclosure),
    );
  }
  if (item.judgmentRowKeyAudit !== undefined) {
    requireCondition(outcome === "succeeded" && isJudgmentRowKeyAudit(item.judgmentRowKeyAudit));
  }
  if (item.modelTelemetry !== undefined) {
    requireCondition(isInferenceAttemptModelTelemetry(item.modelTelemetry, outcome));
  }
  if (item.providerResponses !== undefined) {
    requireCondition(isProviderResponseEvidenceV1(item.providerResponses));
  }
  if (item.efficiency !== undefined) {
    requireCondition(isInferenceEfficiencyEvidenceV1(item.efficiency));
  }
  const durationMs = nonnegativeInteger(item.durationMs);
  const backoffMs = optionalNonnegativeInteger(item.backoffMs);
  const model = decodeModelEvidence(item.model);
  const usage = item.usage === undefined ? undefined : decodeUsage(item.usage);
  const tools = decodeTools(item.tools);
  const identity = decodeEvidenceIdentity(item.identity);
  const turns = array(item.turns).map(decodeTurn);
  // A request-policy refusal ends its attempt, so only the last turn carries one.
  requireCondition(turns.slice(0, -1).every((turn) => turn.requestPolicyRefusal === undefined));
  const executionLease =
    item.executionLease === undefined
      ? undefined
      : decodeExecutionLeaseRuntimeEvidence(item.executionLease);
  requireCondition(turns.length > 0);
  validateTurnLedger(
    turns,
    identity,
    outcome,
    retryable,
    retryScheduled,
    model.profile,
    tools,
    executionLease,
    item.answerSubmission as InferenceAttemptEvidence["answerSubmission"],
    rejection,
  );
  // A tool-call ceiling stop names the ceiling its lease actually ended at.
  if (item.condition === "tool-call-ceiling") {
    requireCondition(
      outcome === "no-progress" && attemptEndedAtToolCallCeiling(executionLease, turns.at(-1)),
    );
  }
  if (executionLease !== undefined) {
    requireCondition(usage !== undefined);
    validateExecutionLeaseAttemptBinding({
      executionLease,
      attempt,
      outcome,
      repositoryRevision: identity.repositoryRevision,
      turns,
      usage,
      tools,
    });
  }
  if (usage !== undefined) {
    requireCondition(usage.turns === turns.filter((turn) => turn.decision !== "stop").length);
    requireCondition((model.profile.pricing === "known") === (usage.cost !== undefined));
  }
  if (outcome === "succeeded")
    requireCondition(!retryable && !retryScheduled && usage !== undefined);
  if (outcome === "context-exhausted") requireCondition(!retryable && !retryScheduled);
  return {
    attempt,
    outcome,
    ...(hostFailureOrigin === undefined ? {} : { hostFailureOrigin }),
    retryable,
    retryScheduled,
    ...(writeSettlement === undefined ? {} : { writeSettlement }),
    ...(conditionRetryability === undefined ? {} : { conditionRetryability }),
    ...(retryDecision === undefined ? {} : { retryDecision }),
    ...(item.retryRule === undefined
      ? {}
      : { retryRule: item.retryRule as NonNullable<InferenceAttemptEvidence["retryRule"]> }),
    ...(item.condition === undefined
      ? {}
      : { condition: item.condition as NonNullable<InferenceAttemptEvidence["condition"]> }),
    ...(answerBytes === undefined ? {} : { answerBytes }),
    ...(item.deadlineTurn === undefined
      ? {}
      : {
          deadlineTurn: item.deadlineTurn as NonNullable<InferenceAttemptEvidence["deadlineTurn"]>,
        }),
    ...(item.concludeNow === undefined
      ? {}
      : {
          concludeNow: structuredClone(
            item.concludeNow as NonNullable<InferenceAttemptEvidence["concludeNow"]>,
          ),
        }),
    ...(item.answerSubmission === undefined
      ? {}
      : {
          answerSubmission: structuredClone(
            item.answerSubmission as NonNullable<InferenceAttemptEvidence["answerSubmission"]>,
          ),
        }),
    ...(rejection === undefined ? {} : { rejection }),
    ...(rejectedReplyShape === undefined ? {} : { rejectedReplyShape }),
    ...(item.rejectedReplyExcerpt === undefined
      ? {}
      : {
          rejectedReplyExcerpt: structuredClone(
            item.rejectedReplyExcerpt as NonNullable<
              InferenceAttemptEvidence["rejectedReplyExcerpt"]
            >,
          ),
        }),
    ...(item.rejectionSubject === undefined
      ? {}
      : {
          rejectionSubject: structuredClone(
            item.rejectionSubject as NonNullable<InferenceAttemptEvidence["rejectionSubject"]>,
          ),
        }),
    ...(item.hostPathDisclosure === undefined
      ? {}
      : {
          hostPathDisclosure: structuredClone(
            item.hostPathDisclosure as NonNullable<InferenceAttemptEvidence["hostPathDisclosure"]>,
          ),
        }),
    ...(item.judgmentRowKeyAudit === undefined
      ? {}
      : {
          judgmentRowKeyAudit: structuredClone(
            item.judgmentRowKeyAudit as NonNullable<
              InferenceAttemptEvidence["judgmentRowKeyAudit"]
            >,
          ),
        }),
    ...(item.modelTelemetry === undefined
      ? {}
      : {
          modelTelemetry: structuredClone(
            item.modelTelemetry as NonNullable<InferenceAttemptEvidence["modelTelemetry"]>,
          ),
        }),
    ...(item.providerResponses === undefined
      ? {}
      : { providerResponses: structuredClone(item.providerResponses) }),
    ...(item.efficiency === undefined ? {} : { efficiency: structuredClone(item.efficiency) }),
    durationMs,
    ...(backoffMs === undefined ? {} : { backoffMs }),
    model,
    ...(usage === undefined ? {} : { usage }),
    tools,
    identity,
    turns,
    ...(executionLease === undefined ? {} : { executionLease }),
  };
}

/**
 * Decode an attempt's coded rejection reason.
 *
 * Checks shape only: the vocabularies live with their decoders, and a second
 * copy here could drift. The bound and the safe-text rule keep a forged record
 * from smuggling response bytes through a field that must be content-free.
 */
function decodeRejectionReason(value: unknown): InferenceRejectionReasonV1 | undefined {
  if (value === undefined) return undefined;
  const item = object(value);
  exact(item, ["code", "location"]);
  const reason = {
    code: safeText(item.code, MAX_INFERENCE_REJECTION_REASON_LENGTH),
    location: safeText(item.location, MAX_INFERENCE_REJECTION_REASON_LENGTH),
  };
  // Grammar, not vocabulary: refuses free prose in `code` and an indexed or
  // path-shaped `location`, the two shapes that would break the content-free
  // promise without any decoder's vocabulary being copied here.
  requireCondition(isRetainableInferenceRejection(reason));
  return reason;
}

function decodeHostFailureOrigin(value: unknown): InferenceAttemptEvidence["hostFailureOrigin"] {
  if (value === undefined) return undefined;
  const item = object(value);
  exact(item, ["schemaVersion", "origin", "code"]);
  requireCondition(
    item.schemaVersion === 1 &&
      item.origin === "execution-lease-coordinator" &&
      item.code === "invalid-execution-lease-coordinator",
  );
  return {
    schemaVersion: 1,
    origin: "execution-lease-coordinator",
    code: "invalid-execution-lease-coordinator",
  };
}

/**
 * Decode an attempt's reply shape fingerprint.
 *
 * Only a response-contract rejection describes a reply, so the fingerprint is
 * refused on any other outcome. Uses the shared validator rather than a second
 * copy of the grammar.
 */
function decodeRejectedReplyShape(
  value: unknown,
  outcome: InferenceAttemptEvidence["outcome"],
): InferenceAttemptEvidence["rejectedReplyShape"] {
  if (value === undefined) return undefined;
  requireCondition(isMalformedResponseCategory(outcome) && isInferenceRejectedReplyShape(value));
  return structuredClone(value as NonNullable<InferenceAttemptEvidence["rejectedReplyShape"]>);
}

/** Reject valid lease evidence transplanted into another attempt or artifact set. */
function validateExecutionLeaseAttemptBinding(input: {
  executionLease: ExecutionLeaseRuntimeEvidenceV1;
  attempt: number;
  outcome: InferenceAttemptEvidence["outcome"];
  repositoryRevision: string;
  turns: readonly { decision: string }[];
  usage: unknown;
  tools: { totalCalls: number; failedCalls: number };
}): void {
  const { executionLease, attempt, outcome, repositoryRevision, turns, usage, tools } = input;
  // A completed provider turn can still fail the host's response contract.
  // Preserve that failed attempt when a read-only retry later succeeds.
  const completionMatches =
    outcome === "malformed-response" ||
    (outcome === "succeeded") === (executionLease.terminalDisposition === "completed");
  const interruptedHostCheckpoint =
    outcome === "host-runtime-failure" && executionLease.phase === "checkpoint-required";
  requireCondition(
    (executionLease.phase === "terminal" || interruptedHostCheckpoint) &&
      completionMatches &&
      executionLease.binding.inferenceAttempt === attempt &&
      executionLease.binding.retriesConsumed === attempt - 1 &&
      executionLease.binding.repositoryRevision === repositoryRevision &&
      executionLease.binding.providerTurnLedgerSha256 === evidenceDigest(turns) &&
      executionLease.binding.usageSha256 === evidenceDigest(usage) &&
      executionLease.binding.toolsSha256 === evidenceDigest(tools) &&
      executionLease.providerTurns === turns.filter((turn) => turn.decision !== "stop").length &&
      executionLease.toolCalls.executed === tools.totalCalls &&
      executionLease.toolCalls.failed === tools.failedCalls &&
      executionLease.toolCalls.succeeded === tools.totalCalls - tools.failedCalls,
  );
}

export function decodeExecutionLeaseRuntimeEvidence(
  value: unknown,
): ExecutionLeaseRuntimeEvidenceV1 {
  const item = object(value);
  exact(item, [
    "schemaVersion",
    "kind",
    "policySha256",
    "identitySha256",
    "coordinatorSha256",
    "phase",
    "terminalReason",
    "terminalDisposition",
    "providerTurns",
    "checkpointProviderTurns",
    "compactions",
    "cumulativeInputTokens",
    "cumulativeOutputTokens",
    "elapsedMs",
    "toolCalls",
    "toolCallsByScope",
    "answerRecordCallsAdmitted",
    "toolCallCeilings",
    "toolCallCapacityMode",
    "chargeableAttemptCeiling",
    "checkpoints",
    "resume",
    "binding",
    "evidenceSha256",
    "policyVersion",
    "aggregatePolicy",
  ]);
  requireEqual(item.schemaVersion, 1);
  requireEqual(item.kind, "docsfab-pi-execution-lease-evidence");
  const policyVersion =
    item.policyVersion === undefined ? 1 : oneOf(item.policyVersion, [2] as const);
  if (policyVersion === 2) {
    const aggregatePolicy = object(item.aggregatePolicy);
    exact(aggregatePolicy, ["kind"]);
    requireEqual(aggregatePolicy.kind, "absent");
    requireCondition(
      item.toolCallCeilings === undefined && item.chargeableAttemptCeiling === undefined,
    );
  } else {
    requireCondition(item.aggregatePolicy === undefined);
  }
  const phase = oneOf(item.phase, [
    "active",
    "batch-pending",
    "checkpoint-required",
    "terminal",
  ] as const);
  const terminalReason =
    item.terminalReason === undefined
      ? undefined
      : oneOf(item.terminalReason, EXECUTION_TERMINAL_REASONS);
  const terminalDisposition =
    item.terminalDisposition === undefined
      ? undefined
      : oneOf(item.terminalDisposition, EXECUTION_TERMINAL_DISPOSITIONS);
  requireCondition(
    (phase === "terminal") === (terminalReason !== undefined && terminalDisposition !== undefined),
  );
  if (terminalReason !== undefined && terminalDisposition !== undefined) {
    requireCondition(executionTerminalPairIsValid(terminalReason, terminalDisposition));
  }
  const toolCallsValue = object(item.toolCalls);
  exact(toolCallsValue, [
    "requested",
    "executed",
    "succeeded",
    "failed",
    "denied",
    "governanceBlocked",
  ]);
  const toolCalls = {
    requested: nonnegativeInteger(toolCallsValue.requested),
    executed: nonnegativeInteger(toolCallsValue.executed),
    succeeded: nonnegativeInteger(toolCallsValue.succeeded),
    failed: nonnegativeInteger(toolCallsValue.failed),
    denied: nonnegativeInteger(toolCallsValue.denied),
    governanceBlocked: nonnegativeInteger(toolCallsValue.governanceBlocked),
  };
  requireCondition(toolCalls.succeeded + toolCalls.failed === toolCalls.executed);
  requireCondition(
    toolCalls.executed + toolCalls.denied + toolCalls.governanceBlocked === toolCalls.requested,
  );
  const toolCallsByScope =
    item.toolCallsByScope === undefined ? undefined : decodeCallScopes(item.toolCallsByScope);
  const answerRecordCallsAdmitted =
    item.answerRecordCallsAdmitted === undefined
      ? undefined
      : nonnegativeInteger(item.answerRecordCallsAdmitted);
  const toolCallCeilings =
    item.toolCallCeilings === undefined ? undefined : decodeCallCeilings(item.toolCallCeilings);
  const toolCallCapacityMode =
    item.toolCallCapacityMode === undefined
      ? undefined
      : oneOf(item.toolCallCapacityMode, ["partitioned", "shared"] as const);
  const chargeableAttemptCeiling =
    item.chargeableAttemptCeiling === undefined
      ? undefined
      : positiveInteger(item.chargeableAttemptCeiling);
  requireCondition(
    toolCallsByScope === undefined
      ? answerRecordCallsAdmitted === undefined &&
          toolCallCeilings === undefined &&
          toolCallCapacityMode === undefined &&
          chargeableAttemptCeiling === undefined
      : policyVersion === 2
        ? answerRecordCallsAdmitted !== undefined &&
          toolCallCeilings === undefined &&
          chargeableAttemptCeiling === undefined
        : answerRecordCallsAdmitted !== undefined &&
          toolCallCeilings !== undefined &&
          chargeableAttemptCeiling !== undefined,
  );
  if (policyVersion === 2 && toolCallsByScope && answerRecordCallsAdmitted !== undefined) {
    requireCondition(
      toolCallsByScope.reading + toolCallsByScope.answerRecord === toolCalls.executed &&
        answerRecordCallsAdmitted <= toolCalls.requested &&
        answerRecordCallsAdmitted >= toolCallsByScope.answerRecord,
    );
  }
  if (
    toolCallsByScope &&
    answerRecordCallsAdmitted !== undefined &&
    toolCallCeilings &&
    chargeableAttemptCeiling !== undefined
  ) {
    requireCondition(
      toolCallsByScope.reading + toolCallsByScope.answerRecord === toolCalls.executed &&
        answerRecordCallsAdmitted <= toolCalls.requested &&
        toolCallsByScope.reading <= toolCallCeilings.reading &&
        answerRecordCallsAdmitted >= toolCallsByScope.answerRecord &&
        answerRecordCallsAdmitted <= toolCallCeilings.answerRecord &&
        (toolCallCapacityMode === "shared"
          ? chargeableAttemptCeiling <=
            Math.max(toolCallCeilings.reading, toolCallCeilings.answerRecord)
          : chargeableAttemptCeiling <= toolCallCeilings.reading + toolCallCeilings.answerRecord) &&
        toolCalls.executed + toolCalls.denied <= chargeableAttemptCeiling,
    );
  }
  const checkpoints = array(item.checkpoints).map((value, index) => {
    const checkpoint = object(value);
    exact(checkpoint, [
      "sequence",
      "leaseNumber",
      "disposition",
      "outputSha256",
      "inputTokens",
      "outputTokens",
      "elapsedMs",
      "progressObservationSha256",
      "progressRecommendationSha256",
      "coordinatorSha256",
    ]);
    const outputSha256 =
      checkpoint.outputSha256 === null ? null : pattern(checkpoint.outputSha256, SHA256);
    const progressObservationSha256 =
      checkpoint.progressObservationSha256 === null
        ? null
        : pattern(checkpoint.progressObservationSha256, SHA256);
    const progressRecommendationSha256 =
      checkpoint.progressRecommendationSha256 === null
        ? null
        : pattern(checkpoint.progressRecommendationSha256, SHA256);
    return {
      sequence: positiveInteger(checkpoint.sequence),
      leaseNumber: positiveInteger(checkpoint.leaseNumber),
      disposition: oneOf(checkpoint.disposition, [
        "accepted",
        "cancelled",
        "blank",
        "malformed",
        "context-exhausted",
        "provider-failed",
        "progress-stopped",
      ] as const),
      outputSha256,
      inputTokens: nonnegativeInteger(checkpoint.inputTokens),
      outputTokens: nonnegativeInteger(checkpoint.outputTokens),
      elapsedMs: nonnegativeInteger(checkpoint.elapsedMs),
      progressObservationSha256,
      progressRecommendationSha256,
      coordinatorSha256: pattern(checkpoint.coordinatorSha256, SHA256),
    } satisfies ExecutionLeaseRuntimeEvidenceV1["checkpoints"][number];
  });
  requireCondition(checkpoints.every((checkpoint, index) => checkpoint.sequence === index + 1));
  const resumeValue = object(item.resume);
  exact(resumeValue, [
    "coordinatorSha256",
    "stateSha256",
    "leaseCheckpointSha256",
    "coordinatorCheckpointSha256",
    "decisionSha256",
  ]);
  const nullableDigest = (candidate: unknown): string | null =>
    candidate === null ? null : pattern(candidate, SHA256);
  const bindingValue = object(item.binding);
  exact(bindingValue, [
    "inferenceAttempt",
    "retriesConsumed",
    "repositoryRevision",
    "providerTurnLedgerSha256",
    "usageSha256",
    "toolsSha256",
  ]);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-pi-execution-lease-evidence" as const,
    ...(policyVersion === 2
      ? { policyVersion: 2 as const, aggregatePolicy: { kind: "absent" as const } }
      : {}),
    policySha256: pattern(item.policySha256, SHA256),
    identitySha256: pattern(item.identitySha256, SHA256),
    coordinatorSha256: pattern(item.coordinatorSha256, SHA256),
    phase,
    ...(terminalReason === undefined ? {} : { terminalReason }),
    ...(terminalDisposition === undefined ? {} : { terminalDisposition }),
    providerTurns: nonnegativeInteger(item.providerTurns),
    checkpointProviderTurns: nonnegativeInteger(item.checkpointProviderTurns),
    compactions: nonnegativeInteger(item.compactions),
    cumulativeInputTokens: nonnegativeInteger(item.cumulativeInputTokens),
    cumulativeOutputTokens: nonnegativeInteger(item.cumulativeOutputTokens),
    elapsedMs: nonnegativeInteger(item.elapsedMs),
    toolCalls,
    ...(toolCallsByScope === undefined ? {} : { toolCallsByScope }),
    ...(answerRecordCallsAdmitted === undefined ? {} : { answerRecordCallsAdmitted }),
    ...(toolCallCeilings === undefined ? {} : { toolCallCeilings }),
    ...(toolCallCapacityMode === undefined ? {} : { toolCallCapacityMode }),
    ...(chargeableAttemptCeiling === undefined ? {} : { chargeableAttemptCeiling }),
    checkpoints,
    resume: {
      coordinatorSha256: pattern(resumeValue.coordinatorSha256, SHA256),
      stateSha256: pattern(resumeValue.stateSha256, SHA256),
      leaseCheckpointSha256: nullableDigest(resumeValue.leaseCheckpointSha256),
      coordinatorCheckpointSha256: nullableDigest(resumeValue.coordinatorCheckpointSha256),
      decisionSha256: nullableDigest(resumeValue.decisionSha256),
    },
    binding: {
      inferenceAttempt: positiveInteger(bindingValue.inferenceAttempt),
      retriesConsumed: nonnegativeInteger(bindingValue.retriesConsumed),
      repositoryRevision: pattern(bindingValue.repositoryRevision, REVISION),
      providerTurnLedgerSha256: pattern(bindingValue.providerTurnLedgerSha256, SHA256),
      usageSha256: pattern(bindingValue.usageSha256, SHA256),
      toolsSha256: pattern(bindingValue.toolsSha256, SHA256),
    },
  };
  requireCondition(body.binding.retriesConsumed === body.binding.inferenceAttempt - 1);
  requireCondition(body.coordinatorSha256 === body.resume.coordinatorSha256);
  const evidenceSha256 = pattern(item.evidenceSha256, SHA256);
  requireCondition(
    evidenceSha256 ===
      createHash("sha256")
        .update(canonicalizeJsonEvidence(body as unknown as JsonEvidenceValue))
        .digest("hex"),
  );
  return { ...body, evidenceSha256 };
}

function decodeCallScopes(value: unknown): { reading: number; answerRecord: number } {
  const item = object(value);
  exact(item, ["reading", "answerRecord"]);
  return {
    reading: nonnegativeInteger(item.reading),
    answerRecord: nonnegativeInteger(item.answerRecord),
  };
}

function decodeCallCeilings(value: unknown): { reading: number; answerRecord: number } {
  const item = object(value);
  exact(item, ["reading", "answerRecord"]);
  return {
    reading: positiveInteger(item.reading),
    answerRecord: positiveInteger(item.answerRecord),
  };
}

function decodeEvidenceIdentity(value: unknown): InferenceEvidenceIdentity {
  const item = object(value);
  exact(item, [
    "repositoryRevision",
    "contextPacketDigest",
    "consultedNodeIds",
    "searchEvidenceSha256",
    "technicalVerificationSha256",
    "provisionalRichCandidateSha256",
    "authoringPhaseSha256",
  ]);
  requireCondition(Object.hasOwn(item, "repositoryRevision"));
  const repositoryRevision = pattern(item.repositoryRevision, REVISION);
  const contextPacketDigest =
    item.contextPacketDigest === undefined ? undefined : pattern(item.contextPacketDigest, SHA256);
  const consultedNodeIds =
    item.consultedNodeIds === undefined
      ? undefined
      : uniqueSortedIdentifiers(item.consultedNodeIds);
  const searchEvidenceSha256 =
    item.searchEvidenceSha256 === undefined
      ? undefined
      : pattern(item.searchEvidenceSha256, SHA256);
  const technicalVerificationSha256 =
    item.technicalVerificationSha256 === undefined
      ? undefined
      : pattern(item.technicalVerificationSha256, SHA256);
  const provisionalRichCandidateSha256 =
    item.provisionalRichCandidateSha256 === undefined
      ? undefined
      : pattern(item.provisionalRichCandidateSha256, SHA256);
  const authoringPhaseSha256 =
    item.authoringPhaseSha256 === undefined
      ? undefined
      : pattern(item.authoringPhaseSha256, SHA256);
  requireCondition((contextPacketDigest === undefined) === (consultedNodeIds === undefined));
  if (consultedNodeIds !== undefined) requireCondition(consultedNodeIds.length > 0);
  return {
    repositoryRevision,
    ...(contextPacketDigest === undefined ? {} : { contextPacketDigest }),
    ...(consultedNodeIds === undefined ? {} : { consultedNodeIds }),
    ...(searchEvidenceSha256 === undefined ? {} : { searchEvidenceSha256 }),
    ...(technicalVerificationSha256 === undefined ? {} : { technicalVerificationSha256 }),
    ...(provisionalRichCandidateSha256 === undefined ? {} : { provisionalRichCandidateSha256 }),
    ...(authoringPhaseSha256 === undefined ? {} : { authoringPhaseSha256 }),
  };
}

function decodeTurn(value: unknown): InferenceTurnEvidence {
  const item = object(value);
  exact(item, [
    "contextBudgetSchemaVersion",
    "contextAdmission",
    "turn",
    "toolCalls",
    "toolResults",
    "terminalPreExecutionRejections",
    "maxProviderTurns",
    "maxToolCalls",
    "compactions",
    "maxCompactions",
    "aggregatePolicy",
    "configuredContextWindow",
    "effectiveContextWindow",
    "configuredMaxInputTokens",
    "effectiveMaxInputTokens",
    "configuredMaxOutputTokens",
    "effectiveMaxOutputTokens",
    "reservedTokens",
    "estimatedInputTokens",
    "availableInputTokens",
    "availableOutputTokens",
    "requiredMinimumOutputTokens",
    "requestedOutputTokens",
    "outputTokens",
    "outputAuthority",
    "decision",
    "reason",
    "requestDigest",
    "providerPayloadSchemaVersion",
    "requestPolicySha256",
    "finalPayloadSha256",
    "providerRetries",
    "providerBlankTurns",
    "providerReplayVeto",
    "replayedReasoningOmitted",
    "requestPolicyRefusal",
    "rawStopReason",
    "evidenceDigest",
    "compaction",
  ]);
  const contextBudgetSchemaVersion =
    item.contextBudgetSchemaVersion === undefined
      ? undefined
      : oneOf(item.contextBudgetSchemaVersion, [2] as const);
  const contextAdmission =
    item.contextAdmission === undefined
      ? undefined
      : oneOf(item.contextAdmission, ["provider"] as const);
  requireCondition(contextAdmission === undefined || contextBudgetSchemaVersion === 2);
  const turn = positiveInteger(item.turn);
  const toolCalls = nonnegativeInteger(item.toolCalls);
  const toolResults = nonnegativeInteger(item.toolResults);
  const terminalPreExecutionRejections =
    item.terminalPreExecutionRejections === undefined
      ? undefined
      : positiveInteger(item.terminalPreExecutionRejections);
  const aggregatePolicy =
    item.aggregatePolicy === undefined ? undefined : object(item.aggregatePolicy);
  if (aggregatePolicy !== undefined) {
    exact(aggregatePolicy, ["kind"]);
    requireEqual(aggregatePolicy.kind, "absent");
  }
  const maxProviderTurns =
    item.maxProviderTurns === undefined ? undefined : positiveInteger(item.maxProviderTurns);
  const maxToolCalls =
    item.maxToolCalls === undefined ? undefined : positiveInteger(item.maxToolCalls);
  const compactions = nonnegativeInteger(item.compactions);
  const maxCompactions =
    item.maxCompactions === undefined ? undefined : nonnegativeInteger(item.maxCompactions);
  requireCondition(
    aggregatePolicy === undefined
      ? maxProviderTurns !== undefined && maxToolCalls !== undefined && maxCompactions !== undefined
      : maxProviderTurns === undefined &&
          maxToolCalls === undefined &&
          maxCompactions === undefined,
  );
  const configuredContextWindow = positiveInteger(item.configuredContextWindow);
  const effectiveContextWindow = positiveInteger(item.effectiveContextWindow);
  const configuredMaxInputTokens =
    item.configuredMaxInputTokens === undefined
      ? undefined
      : positiveInteger(item.configuredMaxInputTokens);
  const effectiveMaxInputTokens =
    item.effectiveMaxInputTokens === undefined
      ? undefined
      : positiveInteger(item.effectiveMaxInputTokens);
  const configuredMaxOutputTokens = positiveInteger(item.configuredMaxOutputTokens);
  const effectiveMaxOutputTokens = positiveInteger(item.effectiveMaxOutputTokens);
  const reservedTokens = nonnegativeInteger(item.reservedTokens);
  const estimatedInputTokens = nonnegativeInteger(item.estimatedInputTokens);
  const availableInputTokens =
    item.availableInputTokens === undefined
      ? undefined
      : nonnegativeInteger(item.availableInputTokens);
  const availableOutputTokens = nonnegativeInteger(item.availableOutputTokens);
  const requiredMinimumOutputTokens = positiveInteger(item.requiredMinimumOutputTokens);
  const requestedOutputTokens = optionalNonnegativeInteger(item.requestedOutputTokens);
  const outputTokens = optionalNonnegativeInteger(item.outputTokens);
  const decision = oneOf(item.decision, ["proceed", "compact", "stop"] as const);
  const reason = item.reason === undefined ? undefined : oneOf(item.reason, TURN_REASONS);
  const requestDigest = pattern(item.requestDigest, SHA256);
  const providerPayloadSchemaVersion =
    item.providerPayloadSchemaVersion === undefined
      ? undefined
      : oneOf(item.providerPayloadSchemaVersion, [1] as const);
  const requestPolicySha256 =
    item.requestPolicySha256 === undefined ? undefined : pattern(item.requestPolicySha256, SHA256);
  const finalPayloadSha256 =
    item.finalPayloadSha256 === undefined ? undefined : pattern(item.finalPayloadSha256, SHA256);
  requireCondition(
    providerPayloadSchemaVersion === undefined
      ? requestPolicySha256 === undefined && finalPayloadSha256 === undefined
      : finalPayloadSha256 !== undefined,
  );
  const providerRetries =
    item.providerRetries === undefined ? undefined : positiveInteger(item.providerRetries);
  // A retry only exists for a turn whose payload was finalized and sent.
  requireCondition(providerRetries === undefined || finalPayloadSha256 !== undefined);
  const providerBlankTurns =
    item.providerBlankTurns === undefined ? undefined : positiveInteger(item.providerBlankTurns);
  // An empty turn also requires a sent payload, and every empty turn except the
  // last was replaced by a replay, so the count cannot outrun the retries.
  requireCondition(
    providerBlankTurns === undefined ||
      (finalPayloadSha256 !== undefined && providerBlankTurns <= (providerRetries ?? 0) + 1),
  );
  // The boundary that refused a replay. Written only when one was refused, and
  // never without a sent payload. An unknown value is refused: a veto this
  // build cannot name must not read as though it were understood.
  const providerReplayVeto =
    item.providerReplayVeto === undefined
      ? undefined
      : oneOf(item.providerReplayVeto, PROVIDER_TURN_REPLAY_VETOES);
  requireCondition(providerReplayVeto === undefined || finalPayloadSha256 !== undefined);
  // Only an installed request policy omits replayed reasoning, counted on the
  // payload its digest names, so never without both digests, and never 0.
  const replayedReasoningOmitted =
    item.replayedReasoningOmitted === undefined
      ? undefined
      : positiveInteger(item.replayedReasoningOmitted);
  requireCondition(
    replayedReasoningOmitted === undefined ||
      (requestPolicySha256 !== undefined && finalPayloadSha256 !== undefined),
  );
  // A refusal this build cannot name must not read as understood, and it must
  // fit the row's phase (`isAdmissibleRequestPolicyRefusal`).
  const requestPolicyRefusal =
    item.requestPolicyRefusal === undefined
      ? undefined
      : oneOf(item.requestPolicyRefusal, REQUEST_POLICY_REFUSAL_IDS);
  requireCondition(
    requestPolicyRefusal === undefined ||
      isAdmissibleRequestPolicyRefusal(requestPolicyRefusal, finalPayloadSha256 !== undefined),
  );
  const rawStopReason =
    item.rawStopReason === undefined ? undefined : closedStoredFinishReason(item.rawStopReason);
  const evidenceDigest = pattern(item.evidenceDigest, SHA256);
  const compaction = item.compaction === undefined ? undefined : decodeCompaction(item.compaction);
  requireCondition(
    toolResults <= toolCalls && (maxCompactions === undefined || compactions <= maxCompactions),
  );
  requireCondition(effectiveContextWindow <= configuredContextWindow);
  const hasInputEvidence = configuredMaxInputTokens !== undefined;
  requireCondition(
    hasInputEvidence === (effectiveMaxInputTokens !== undefined) &&
      hasInputEvidence === (availableInputTokens !== undefined),
  );
  requireCondition(contextBudgetSchemaVersion === 2 ? hasInputEvidence : !hasInputEvidence);
  if (
    configuredMaxInputTokens !== undefined &&
    effectiveMaxInputTokens !== undefined &&
    availableInputTokens !== undefined
  ) {
    requireCondition(configuredMaxInputTokens <= configuredContextWindow);
    requireCondition(effectiveMaxInputTokens <= effectiveContextWindow);
    requireCondition(effectiveMaxInputTokens <= configuredMaxInputTokens);
    requireCondition(
      availableInputTokens ===
        (contextAdmission === "provider"
          ? estimatedInputTokens
          : Math.max(0, effectiveMaxInputTokens - reservedTokens)),
    );
    if (decision !== "stop" && contextAdmission !== "provider") {
      requireCondition(
        reservedTokens <= effectiveMaxInputTokens &&
          estimatedInputTokens <= effectiveMaxInputTokens - reservedTokens,
      );
    }
  }
  requireCondition(effectiveMaxOutputTokens <= configuredMaxOutputTokens);
  requireCondition(requiredMinimumOutputTokens <= effectiveMaxOutputTokens);
  requireCondition(
    availableOutputTokens ===
      (contextAdmission === "provider"
        ? (requestedOutputTokens ?? effectiveMaxOutputTokens)
        : Math.max(0, effectiveContextWindow - estimatedInputTokens - reservedTokens)),
  );
  requireCondition(contextAdmission !== "provider" || decision !== "compact");
  if (decision === "stop") {
    requireCondition(
      reason !== undefined &&
        outputTokens === undefined &&
        compaction === undefined &&
        rawStopReason === undefined,
    );
  } else {
    requireCondition(reason === undefined);
    requireCondition(
      (maxProviderTurns === undefined || turn <= maxProviderTurns) &&
        (maxToolCalls === undefined || toolCalls <= maxToolCalls),
    );
    if (outputTokens !== undefined) {
      const producedLimit = producedTurnOutputTokenLimit({
        ...(requestedOutputTokens === undefined ? {} : { requestedOutputTokens }),
        effectiveMaxOutputTokens,
        availableOutputTokens,
        requiredMinimumOutputTokens,
        ...(providerRetries === undefined ? {} : { providerRetries }),
      });
      requireCondition(Number.isSafeInteger(producedLimit) && outputTokens <= producedLimit);
    }
  }
  if (decision === "compact") {
    requireCondition(compaction !== undefined && compaction.afterRequestDigest === requestDigest);
  } else {
    requireCondition(compaction === undefined);
  }
  // The lease's cumulative output authority is recorded only where it bound
  // the turn, and the record lets a reader redo the arithmetic: a clamp
  // requests exactly the remainder, an exhaustion had less than the floor, and
  // neither is claimed when the per-turn limit fit.
  const outputAuthority =
    item.outputAuthority === undefined ? undefined : decodeOutputAuthority(item.outputAuthority);
  requireCondition(reason !== "output-authority-exhausted" || outputAuthority !== undefined);
  if (outputAuthority !== undefined) {
    const remaining = outputAuthority.maxOutputTokens - outputAuthority.cumulativeOutputTokens;
    requireCondition(
      outputAuthority.floorOutputTokens > requiredMinimumOutputTokens &&
        remaining < effectiveMaxOutputTokens,
    );
    if (decision === "stop") {
      requireCondition(
        reason !== "output-authority-exhausted" || remaining < outputAuthority.floorOutputTokens,
      );
    } else {
      requireCondition(
        remaining >= outputAuthority.floorOutputTokens && requestedOutputTokens === remaining,
      );
    }
  }
  return {
    ...(contextBudgetSchemaVersion === undefined ? {} : { contextBudgetSchemaVersion }),
    ...(contextAdmission === undefined ? {} : { contextAdmission }),
    turn,
    toolCalls,
    toolResults,
    ...(terminalPreExecutionRejections === undefined ? {} : { terminalPreExecutionRejections }),
    ...(maxProviderTurns === undefined ? {} : { maxProviderTurns }),
    ...(maxToolCalls === undefined ? {} : { maxToolCalls }),
    compactions,
    ...(maxCompactions === undefined ? {} : { maxCompactions }),
    ...(aggregatePolicy === undefined ? {} : { aggregatePolicy: { kind: "absent" as const } }),
    configuredContextWindow,
    effectiveContextWindow,
    ...(configuredMaxInputTokens === undefined
      ? {}
      : {
          configuredMaxInputTokens,
          effectiveMaxInputTokens,
          availableInputTokens,
        }),
    configuredMaxOutputTokens,
    effectiveMaxOutputTokens,
    reservedTokens,
    estimatedInputTokens,
    availableOutputTokens,
    requiredMinimumOutputTokens,
    ...(requestedOutputTokens === undefined ? {} : { requestedOutputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(rawStopReason === undefined ? {} : { rawStopReason }),
    ...(outputAuthority === undefined ? {} : { outputAuthority }),
    decision,
    ...(reason === undefined ? {} : { reason }),
    requestDigest,
    ...(providerPayloadSchemaVersion === undefined ? {} : { providerPayloadSchemaVersion }),
    ...(requestPolicySha256 === undefined ? {} : { requestPolicySha256 }),
    ...(finalPayloadSha256 === undefined ? {} : { finalPayloadSha256 }),
    ...(providerRetries === undefined ? {} : { providerRetries }),
    ...(providerBlankTurns === undefined ? {} : { providerBlankTurns }),
    ...(providerReplayVeto === undefined ? {} : { providerReplayVeto }),
    ...(replayedReasoningOmitted === undefined ? {} : { replayedReasoningOmitted }),
    ...(requestPolicyRefusal === undefined ? {} : { requestPolicyRefusal }),
    evidenceDigest,
    ...(compaction === undefined ? {} : { compaction }),
  };
}

function decodeCompaction(value: unknown): InferenceCompactionEvidence {
  const item = object(value);
  exact(item, [
    "beforeRequestDigest",
    "afterRequestDigest",
    "estimatedInputTokensBefore",
    "estimatedInputTokensAfter",
    "removedMessages",
    "retainedMessages",
    "preservedCitationCount",
    "preservedCitationDigest",
  ]);
  const beforeRequestDigest = pattern(item.beforeRequestDigest, SHA256);
  const afterRequestDigest = pattern(item.afterRequestDigest, SHA256);
  const estimatedInputTokensBefore = positiveInteger(item.estimatedInputTokensBefore);
  const estimatedInputTokensAfter = nonnegativeInteger(item.estimatedInputTokensAfter);
  const removedMessages = positiveInteger(item.removedMessages);
  const retainedMessages = positiveInteger(item.retainedMessages);
  const preservedCitationCount = nonnegativeInteger(item.preservedCitationCount);
  const preservedCitationDigest = pattern(item.preservedCitationDigest, SHA256);
  requireCondition(estimatedInputTokensAfter < estimatedInputTokensBefore);
  return {
    beforeRequestDigest,
    afterRequestDigest,
    estimatedInputTokensBefore,
    estimatedInputTokensAfter,
    removedMessages,
    retainedMessages,
    preservedCitationCount,
    preservedCitationDigest,
  };
}

function validateTurnLedger(
  turns: InferenceTurnEvidence[],
  identity: InferenceEvidenceIdentity,
  outcome: InferenceAttemptEvidence["outcome"],
  retryable: boolean,
  retryScheduled: boolean,
  profile: ModelProfileEvidence,
  tools: ToolActivitySummary,
  executionLease: ExecutionLeaseRuntimeEvidenceV1 | undefined,
  answerSubmission: InferenceAttemptEvidence["answerSubmission"],
  rejection: InferenceAttemptEvidence["rejection"],
): void {
  const evidenceDigest = digestIdentity(identity);
  const first = turns[0]!;
  for (const [index, turn] of turns.entries()) {
    requireCondition(turn.turn === index + 1 && turn.evidenceDigest === evidenceDigest);
    requireCondition(
      turn.contextAdmission !== "provider" ||
        (profile.status !== "current" && profile.effectiveLimitReason !== "composition-candidate"),
    );
    requireCondition(
      (profile.schemaVersion === 2) === (turn.contextBudgetSchemaVersion === 2) &&
        turn.configuredContextWindow === profile.configuredContextWindow &&
        turn.effectiveContextWindow === profile.effectiveContextWindow &&
        turn.configuredMaxInputTokens === profile.configuredMaxInputTokens &&
        turn.effectiveMaxInputTokens === profile.effectiveMaxInputTokens &&
        turn.configuredMaxOutputTokens === profile.configuredMaxOutputTokens &&
        turn.effectiveMaxOutputTokens === profile.effectiveMaxOutputTokens &&
        turn.reservedTokens === profile.requestPolicy.reservedContextTokens &&
        turn.requiredMinimumOutputTokens === profile.requestPolicy.minimumOutputTokens,
    );
    requireCondition(sameTurnPolicy(first, turn));
    const previous = turns[index - 1];
    if (previous) {
      requireCondition(
        turn.toolCalls >= previous.toolCalls &&
          turn.toolResults >= previous.toolResults &&
          turn.compactions === previous.compactions + (previous.decision === "compact" ? 1 : 0),
      );
    }
  }
  const final = turns.at(-1)!;
  requireCondition(
    turns.slice(0, -1).every((turn) => turn.terminalPreExecutionRejections === undefined),
  );
  const governanceStops = supplementalGovernanceStops(tools.failureCategories);
  const accountedCalls = safeSum([
    tools.totalCalls,
    governanceStops,
    tools.preExecutionRejections?.count ?? 0,
  ]);
  const stopped = final.decision === "stop";
  const terminalRejections = final.terminalPreExecutionRejections;
  if (terminalRejections !== undefined) {
    requireCondition(
      outcome === "malformed-response" &&
        rejection?.code === "quality-submission-shape" &&
        answerSubmission?.path === "tool-call" &&
        answerSubmission.submission === "refused" &&
        answerSubmission.reportTurn === "not-asked" &&
        executionLease?.phase === "terminal" &&
        executionLease.terminalReason === "completed" &&
        final.decision !== "stop" &&
        terminalRejections <= (tools.preExecutionRejections?.count ?? 0) &&
        safeSum([final.toolCalls, terminalRejections]) === accountedCalls &&
        final.toolResults <= final.toolCalls,
    );
  } else if (outcome === "no-progress") {
    // The read-loop and tool-call ceiling stops end the attempt after a
    // settled tool turn, so no later turn record counts that turn's own calls.
    // The lease binding already pins the ledger, call totals and provider
    // turns to the lease.
    requireCondition(
      !stopped && final.toolCalls < accountedCalls && final.toolResults <= final.toolCalls,
    );
  } else if (outcome === "host-runtime-failure") {
    // A coordinator rejection at an accounted host checkpoint can end the
    // attempt after lease/tool accounting but before Pi opens the next turn
    // row. The paired origin is decoded above, and the lease binding below
    // validates the complete tool counters independently of this turn ledger.
    requireCondition(
      executionLease?.phase === "checkpoint-required" &&
        final.toolCalls < accountedCalls &&
        final.toolResults <= final.toolCalls,
    );
  } else {
    requireCondition(final.toolCalls === accountedCalls && final.toolResults <= accountedCalls);
  }
  requireCondition((outcome === "context-exhausted") === stopped);
  if (stopped) {
    requireCondition(!retryable && !retryScheduled && stopReasonMatches(final));
  }
}

function sameTurnPolicy(left: InferenceTurnEvidence, right: InferenceTurnEvidence): boolean {
  return (
    left.contextBudgetSchemaVersion === right.contextBudgetSchemaVersion &&
    left.contextAdmission === right.contextAdmission &&
    left.aggregatePolicy?.kind === right.aggregatePolicy?.kind &&
    left.maxProviderTurns === right.maxProviderTurns &&
    left.maxToolCalls === right.maxToolCalls &&
    left.maxCompactions === right.maxCompactions &&
    left.configuredContextWindow === right.configuredContextWindow &&
    left.effectiveContextWindow === right.effectiveContextWindow &&
    left.configuredMaxInputTokens === right.configuredMaxInputTokens &&
    left.effectiveMaxInputTokens === right.effectiveMaxInputTokens &&
    left.configuredMaxOutputTokens === right.configuredMaxOutputTokens &&
    left.effectiveMaxOutputTokens === right.effectiveMaxOutputTokens &&
    left.reservedTokens === right.reservedTokens &&
    left.requiredMinimumOutputTokens === right.requiredMinimumOutputTokens &&
    left.requestPolicySha256 === right.requestPolicySha256
  );
}

const CLOSED_PROVIDER_FINISH_REASON = /^[a-z][a-z0-9_]{0,31}$/u;

function closedStoredFinishReason(value: unknown): string {
  requireCondition(
    typeof value === "string" && CLOSED_PROVIDER_FINISH_REASON.test(value) && value !== "absent",
  );
  return value as string;
}

function decodeOutputAuthority(value: unknown): InferenceOutputAuthorityEvidence {
  const item = object(value);
  exact(item, ["maxOutputTokens", "cumulativeOutputTokens", "floorOutputTokens"]);
  return {
    maxOutputTokens: positiveInteger(item.maxOutputTokens),
    cumulativeOutputTokens: nonnegativeInteger(item.cumulativeOutputTokens),
    floorOutputTokens: positiveInteger(item.floorOutputTokens),
  };
}

/** The recorded output authority left less than one floor's worth of output. */
function outputAuthorityExhausted(turn: InferenceTurnEvidence): boolean {
  const authority = turn.outputAuthority;
  return (
    authority !== undefined &&
    authority.maxOutputTokens - authority.cumulativeOutputTokens < authority.floorOutputTokens
  );
}

function stopReasonMatches(turn: InferenceTurnEvidence): boolean {
  const providerLimitReached =
    turn.maxProviderTurns !== undefined && turn.turn > turn.maxProviderTurns;
  const toolLimitReached = turn.maxToolCalls !== undefined && turn.toolCalls > turn.maxToolCalls;
  const inputExhausted =
    turn.contextAdmission !== "provider" &&
    turn.effectiveMaxInputTokens !== undefined &&
    (turn.reservedTokens > turn.effectiveMaxInputTokens ||
      turn.estimatedInputTokens > turn.effectiveMaxInputTokens - turn.reservedTokens);
  const budgetExhausted =
    inputExhausted || turn.availableOutputTokens < turn.requiredMinimumOutputTokens;
  if (turn.reason === "provider-turn-limit") return providerLimitReached;
  if (providerLimitReached) return false;
  if (turn.reason === "tool-call-limit") return toolLimitReached;
  if (toolLimitReached) return false;
  // Raw call/result linkage is deliberately absent from run records. A fitting
  // evidence-preservation stop is therefore admissible, but only after the two
  // limits whose precedence is numerically observable have not fired.
  if (turn.reason === "evidence-preservation-required") return true;
  // The governor stops on an exhausted output authority before it looks at the
  // context budget, so an exhausted authority rules out every budget reason
  // below and is the only thing that admits its own.
  const authorityExhausted = outputAuthorityExhausted(turn);
  if (turn.reason === "output-authority-exhausted") return authorityExhausted;
  if (authorityExhausted) return false;
  if (turn.reason === "compaction-limit") {
    return (
      turn.maxCompactions !== undefined &&
      budgetExhausted &&
      turn.compactions >= turn.maxCompactions
    );
  }
  // A compaction the governor refused to authorize -- it could not free the
  // required share of the input budget -- stops before the budget is spent, so
  // unlike `compaction-limit` it is admissible with compactions still left.
  if (turn.reason === "context-exhausted" || turn.reason === "compaction-ineffective") {
    return (
      budgetExhausted &&
      (turn.maxCompactions === undefined || turn.compactions < turn.maxCompactions)
    );
  }
  return false;
}

function digestIdentity(identity: InferenceEvidenceIdentity): string {
  const normalized = {
    repositoryRevision: identity.repositoryRevision,
    ...(identity.contextPacketDigest ? { contextPacketDigest: identity.contextPacketDigest } : {}),
    ...(identity.consultedNodeIds
      ? { consultedNodeIds: [...new Set(identity.consultedNodeIds)].sort() }
      : {}),
    ...(identity.technicalVerificationSha256
      ? { technicalVerificationSha256: identity.technicalVerificationSha256 }
      : {}),
    ...(identity.authoringPhaseSha256
      ? { authoringPhaseSha256: identity.authoringPhaseSha256 }
      : {}),
    // Excludes `searchEvidenceSha256`: this reproduces the per-turn ledger
    // digest owned by `normalizeEvidenceIdentity` (model/turn-governor.ts) and
    // mirrored by quality-evaluation/structural.ts; all three must agree
    // byte-for-byte. The execution lease identity (harness/pi-offline.ts)
    // attests the search binding with a different digest.
  };
  return createHash("sha256").update(canonical(normalized)).digest("hex");
}
