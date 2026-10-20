// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isInferenceAnswerSubmissionEvidence } from "../records/answer-submission-evidence.js";
import {
  isInferenceConcludeNowEvidence,
  isInferenceFailureCondition,
  isRetryRuleId,
} from "../records/inference-retry-rule-vocabulary.js";
import { createHash } from "node:crypto";
import {
  migrateLegacyInferenceAttemptEvidence,
  parseLegacyExecutionLeaseCompatibility,
  serializeLegacyExecutionLeaseCompatibility,
} from "./lease-contracts/legacy-codecs.js";
export {
  migrateLegacyInferenceAttemptEvidence,
  parseLegacyExecutionLeaseCompatibility,
  serializeLegacyExecutionLeaseCompatibility,
};

import {
  ExecutionLeaseContractError,
  EXECUTION_STOP_REASON_PRECEDENCE,
  CHECKPOINT_REASONS,
  COST_UNAVAILABLE_REASONS,
  TERMINAL_REASONS,
  INFERENCE_OUTCOMES,
  INFERENCE_TURN_DECISIONS,
  INFERENCE_TURN_REASONS,
  SHA256,
  REVISION,
  array,
  assertPlainJsonData,
  booleanValue,
  digest,
  enumValue,
  exact,
  fail,
  legacyIdentifier,
  nonnegative,
  nullableDigest,
  object,
  positive,
  revision,
  safeId,
  sha256,
  withCode,
  deepFreeze,
  type ErrorCode,
} from "./lease-contracts/codec-helpers.js";
export { ExecutionLeaseContractError, EXECUTION_STOP_REASON_PRECEDENCE };

import {
  answerRecordToolCallsAdmitted,
  answerRecordToolCallsExecuted,
  currentLeaseToolCallAllowance,
  executionLeaseChargeableAttemptCeiling,
  leaseToolCallsCharged,
  readingToolCallsExecuted,
  remainingScopedToolCalls,
  renewalToolCallGrant,
} from "./lease-contracts/accounting.js";
export {
  answerRecordToolCallsAdmitted,
  answerRecordToolCallsExecuted,
  currentLeaseToolCallAllowance,
  executionLeaseChargeableAttemptCeiling,
  leaseToolCallsCharged,
  readingToolCallsExecuted,
  remainingScopedToolCalls,
  renewalToolCallGrant,
};

import {
  decodeAnyExecutionLeasePolicy,
  decodeExecutionLeaseAggregatePolicyV2,
  decodeExecutionLeaseIdentity,
  decodeExecutionLeasePolicy,
  decodeExecutionLeasePolicyV1,
  decodeExecutionLeasePolicyV2,
} from "./lease-contracts/policy-identity-codecs.js";
export {
  decodeAnyExecutionLeasePolicy,
  decodeExecutionLeaseAggregatePolicyV2,
  decodeExecutionLeaseIdentity,
  decodeExecutionLeasePolicy,
  decodeExecutionLeasePolicyV1,
  decodeExecutionLeasePolicyV2,
};

import {
  isLegacyHostPathDisclosure,
  isProviderResponseEvidenceV1,
  type InferenceAttemptEvidence,
  type InferenceEvidenceIdentity,
  type InferenceTurnEvidence,
} from "../records/contracts.js";
import {
  INFERENCE_CONDITION_RETRYABILITIES,
  INFERENCE_RETRY_DECISIONS,
} from "../records/inference-retry-disposition.js";
import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import { LIMIT_DEFINITION_BY_NAME } from "../config/limits.generated.js";
import {
  isRetainableInferenceRejection,
  MAX_INFERENCE_REJECTION_REASON_LENGTH,
} from "../config/inference-rejection-limits.js";
import { decodeModelEvidence, decodeTools, decodeUsage } from "./inference-evidence.js";
import { isRejectedReplyExcerptOf } from "./rejected-reply-excerpt.js";
import { isInferenceRejectionSubject } from "./rejection-subject.js";
import { isInferenceRejectedReplyShape } from "./rejected-reply-shape.js";
import { isJudgmentRowKeyAudit } from "./judgment-row-key-audit-contract.js";
import { isInferenceAttemptModelTelemetry } from "../records/model-telemetry.js";
import {
  INFERENCE_ATTEMPT_SUCCESS_OUTCOME,
  isMalformedResponseCategory,
} from "../inference-attempt-taxonomy.js";

function canonicalLimitValue(name: string): number {
  const definition = LIMIT_DEFINITION_BY_NAME[name];
  if (!definition) {
    throw new Error(`Execution lease limit ${name} is missing from config/limits.yaml.`);
  }
  return definition.value;
}

/**
 * Base execution-lease policy from the limits catalog. Workflow and operator
 * overrides may only lower these (`decodeOverride`); the composition tranche
 * override may raise `callsPerLease` alone. A lane's actual shape is
 * `resolveLeaseShapeForTurns` over its sealed `maxProviderTurns`. The tool
 * budget is not in the digest-sealed `CompositionModelLimits` vector, so it
 * cannot be raised for one lane alone.
 */
export const EXECUTION_LEASE_DEFAULTS = Object.freeze({
  callsPerLease: canonicalLimitValue("compositionExecution.callsPerLease"),
  maxLeases: canonicalLimitValue("compositionExecution.maxLeases"),
  hardToolCallCeiling: canonicalLimitValue("compositionExecution.maxToolCallsPerStep"),
  maxProviderTurns: canonicalLimitValue("compositionExecution.maxProviderTurns"),
} as const);

/**
 * Composition-data tranche override. Not an operator env knob and not a
 * workflow/operator tightening. Hard ceiling and maxLeases stay compiled.
 */
export interface CompositionBoundExecutionLeaseOverrideV1 {
  callsPerLease?: number;
}

/**
 * Fit a lease shape inside a given provider-turn budget.
 *
 * `decodeExecutionLeasePolicy` enforces three invariants at once:
 *
 *   callsPerLease <= hardToolCallCeiling
 *   hardToolCallCeiling <= callsPerLease * maxLeases
 *   maxProviderTurns >= hardToolCallCeiling + maxLeases
 *
 * The third ties the tool budget to the turn budget, so fixed defaults are
 * valid only at or above `ceiling + maxLeases` turns; shrinking to fit keeps
 * them usable for smaller turn budgets.
 *
 * The lease count is searched: more leases raise `callsPerLease * maxLeases`
 * but each costs a turn. Taking the maximum is wrong when turns are scarce.
 * Ties keep the smaller count.
 */
export function resolveLeaseShapeForTurns(
  bounds: {
    readonly callsPerLease: number;
    readonly maxLeases: number;
    readonly hardToolCallCeiling: number;
  },
  maxProviderTurns: number,
): { callsPerLease: number; maxLeases: number; hardToolCallCeiling: number } {
  const ceilingFor = (leases: number): number =>
    Math.max(
      1,
      Math.min(
        bounds.hardToolCallCeiling,
        bounds.callsPerLease * leases,
        maxProviderTurns - leases,
      ),
    );
  let maxLeases = 1;
  for (let leases = 2; leases <= Math.min(bounds.maxLeases, maxProviderTurns - 1); leases += 1) {
    if (ceilingFor(leases) > ceilingFor(maxLeases)) maxLeases = leases;
  }
  const hardToolCallCeiling = ceilingFor(maxLeases);
  const callsPerLease = Math.max(1, Math.min(bounds.callsPerLease, hardToolCallCeiling));
  if (
    callsPerLease > hardToolCallCeiling ||
    hardToolCallCeiling > callsPerLease * maxLeases ||
    maxProviderTurns < hardToolCallCeiling + maxLeases
  ) {
    throw new Error(
      `Lease shape violates the execution-lease policy invariants: ` +
        `callsPerLease=${callsPerLease}, maxLeases=${maxLeases}, ` +
        `hardToolCallCeiling=${hardToolCallCeiling}, maxProviderTurns=${maxProviderTurns}.`,
    );
  }
  return { callsPerLease, maxLeases, hardToolCallCeiling };
}

export interface ExecutionLeaseCumulativePolicyV1 {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxElapsedMs: number;
  /** Omitted means no cost ceiling; zero is never a substitute for unknown cost. */
  maxKnownCostMicrousd?: number;
}

export interface ExecutionLeasePolicyV1 {
  schemaVersion: 1;
  kind: "docsfab-execution-lease-policy";
  callsPerLease: number;
  maxLeases: number;
  hardToolCallCeiling: number;
  /** Host-derived per-step ceiling; absent on non-record executions. */
  answerRecordCallCeiling?: number;
  /** Discovery-only policy: reading and record scopes draw from one aggregate pool. */
  sharedToolCallCapacity?: true;
  maxProviderTurns: number;
  maxCompactions: number;
  cumulative: ExecutionLeaseCumulativePolicyV1;
  policySha256: string;
}

/** Default discovery carries no aggregate execution budget. */
export type ExecutionLeaseAggregatePolicyV2 = { readonly kind: "absent" };

/**
 * V2 separates renewable lease cadence from aggregate budgets. V1 remains the
 * finite compatibility contract for ordinary runs.
 */
export interface ExecutionLeasePolicyV2 {
  readonly schemaVersion: 2;
  readonly kind: "docsfab-execution-lease-policy";
  readonly callsPerLease: number;
  readonly sharedToolCallCapacity: true;
  readonly aggregatePolicy: ExecutionLeaseAggregatePolicyV2;
  readonly policySha256: string;
}

export type AnyExecutionLeasePolicyV1OrV2 = ExecutionLeasePolicyV1 | ExecutionLeasePolicyV2;

export interface ExecutionLeaseIdentityV1 {
  schemaVersion: 1;
  kind: "docsfab-execution-lease-identity";
  inferenceAttempt: number;
  retriesConsumed: number;
  authorizationSha256: string | null;
  repositoryRevision: string;
  contextPacketSha256: string | null;
  evidenceSha256: string;
  toolPolicySha256: string;
  contextAuthoritySha256: string;
  policySha256: string;
  identitySha256: string;
}

export interface ExecutionToolCallCountersV1 {
  requested: number;
  executed: number;
  succeeded: number;
  failed: number;
  denied: number;
  governanceBlocked: number;
}

export type ExecutionCostStateV1 =
  | { status: "known"; microusd: number }
  | { status: "unavailable"; reason: "pricing-unknown" | "pricing-stale" };

export interface ExecutionLeaseStateV1 {
  schemaVersion: 1;
  kind: "docsfab-execution-lease-state";
  leaseNumber: number;
  leaseExecutedToolCalls: number;
  /** Exact host-granted call allowance for this lease; absent on legacy leases. */
  leaseToolCallAllowance?: number;
  /** Record calls within the current lease; present only for record-enabled policies. */
  leaseExecutedAnswerRecordCalls?: number;
  /** All answer-record IDs admitted by the host, including a drained authorized suffix. */
  leaseAdmittedAnswerRecordCalls?: number;
  providerTurns: number;
  compactions: number;
  toolCalls: ExecutionToolCallCountersV1;
  /** Executed-call subset counters; their sum must equal toolCalls.executed. */
  toolCallsByScope?: { reading: number; answerRecord: number };
  /** QAR authorized-prefix count; unlike executed outcomes this includes drained IDs. */
  answerRecordCallsAdmitted?: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  elapsedMs: number;
  cost: ExecutionCostStateV1;
  lastCheckpointSha256: string | null;
  stateSha256: string;
}

export type ExecutionToolCallScopeV1 = "reading" | "answer-record";

export type ExecutionCheckpointReason =
  | "lease-exhausted"
  | "budget-boundary"
  | "host-requested"
  | "provider-requested"
  | "workflow-completed";

export interface ExecutionCheckpointV1 {
  schemaVersion: 1;
  kind: "docsfab-execution-checkpoint";
  sequence: number;
  reason: ExecutionCheckpointReason;
  identitySha256: string;
  policySha256: string;
  previousCheckpointSha256: string | null;
  state: ExecutionLeaseStateV1;
  checkpointSha256: string;
}

export type ExecutionStopReason =
  | "security-denied"
  | "authorization-denied"
  | "cancellation-requested"
  | "evidence-preservation-required"
  | "context-exhausted"
  | "hard-tool-call-ceiling"
  | "cumulative-input-limit"
  | "cumulative-output-limit"
  /**
   * Host-requested: the cumulative output authority left less than one useful
   * turn. Unlike `cumulative-output-limit`, spend did not reach the limit.
   */
  | "output-authority-exhausted"
  | "cumulative-time-limit"
  | "cost-unavailable"
  | "cumulative-cost-limit"
  | "provider-turn-limit"
  | "lease-limit"
  | "checkpoint-not-renewable"
  | "provider-terminal"
  | "provider-unavailable";

export interface ExecutionLeaseGrantV1 {
  schemaVersion: 1;
  kind: "docsfab-execution-lease-decision";
  decision: "granted";
  leaseNumber: number;
  grantedToolCalls: number;
  remainingProviderTurns: number;
  remainingInputTokens: number;
  remainingOutputTokens: number;
  remainingElapsedMs: number;
  remainingKnownCostMicrousd?: number;
  identitySha256: string;
  policySha256: string;
  checkpointSha256: string;
  consideredStopReasons: [];
  decisionSha256: string;
}

/** V2 records cadence only; aggregate headroom fields do not exist. */
export interface ExecutionLeaseGrantV2 {
  schemaVersion: 2;
  kind: "docsfab-execution-lease-decision";
  decision: "granted";
  leaseNumber: number;
  grantedToolCalls: number;
  identitySha256: string;
  policySha256: string;
  checkpointSha256: string;
  consideredStopReasons: [];
  decisionSha256: string;
}

export interface ExecutionLeaseDenialV1 {
  schemaVersion: 1;
  kind: "docsfab-execution-lease-decision";
  decision: "denied";
  leaseNumber: number;
  reason: ExecutionStopReason;
  identitySha256: string;
  policySha256: string;
  checkpointSha256: string;
  consideredStopReasons: ExecutionStopReason[];
  decisionSha256: string;
}

export interface ExecutionLeaseDenialV2 extends Omit<ExecutionLeaseDenialV1, "schemaVersion"> {
  schemaVersion: 2;
}

export type ExecutionLeaseDecisionV1 =
  | ExecutionLeaseGrantV1
  | ExecutionLeaseGrantV2
  | ExecutionLeaseDenialV1
  | ExecutionLeaseDenialV2;

/** Validated causal prefix required when renewing from a checkpoint after sequence one. */
export interface ExecutionLeaseRenewalHistoryV1 {
  checkpoints: readonly ExecutionCheckpointV1[];
  decisions: readonly ExecutionLeaseDecisionV1[];
}

export type ExecutionTerminalReason =
  | "completed"
  | "needs-input"
  | "needs-human-decision"
  | ExecutionStopReason;

export interface ExecutionLeaseRecordV1 {
  schemaVersion: 1;
  kind: "docsfab-execution-lease-record";
  policy: AnyExecutionLeasePolicyV1OrV2;
  identity: ExecutionLeaseIdentityV1;
  initialState: ExecutionLeaseStateV1;
  checkpoints: ExecutionCheckpointV1[];
  decisions: ExecutionLeaseDecisionV1[];
  finalState: ExecutionLeaseStateV1;
  /** Separate attempt guard required to replay a chargeable-attempt terminal stop. */
  chargeableAttemptCeiling?: number;
  terminalReason?: ExecutionTerminalReason;
  recordSha256: string;
}

/** Compatibility evidence never grants renewable authority to a legacy run. */
export interface LegacyFixedGovernorCompatibilityV1 {
  schemaVersion: 1;
  kind: "docsfab-fixed-governor-compatibility";
  renewable: false;
  reason: "legacy-record-no-lease-authority";
  attempt: number;
  outcome: InferenceAttemptEvidence["outcome"];
  identity: InferenceEvidenceIdentity | null;
  providerTurns: number;
  toolCalls: number;
  compactions: number;
  turnEvidenceSha256: string;
  compatibilitySha256: string;
}

export interface CreateExecutionLeasePolicyInput {
  callsPerLease?: number;
  maxLeases?: number;
  hardToolCallCeiling?: number;
  answerRecordCallCeiling?: number;
  sharedToolCallCapacity?: true;
  maxProviderTurns?: number;
  maxCompactions: number;
  cumulative: ExecutionLeaseCumulativePolicyV1;
}

/**
 * Resolve the composition-data tranche override against the lease shape actually
 * in force.
 *
 * `baseCallsPerLease` is the run's host-selected per-lease call cap. In
 * non-record mode it is constrained by the reading shape; in record mode it
 * may exceed the reading ceiling because the two scopes have independent
 * ceilings.
 *
 * Composition data may raise `callsPerLease`, never lower it, and never break
 * `reading ceiling <= callsPerLease * maxLeases`.
 */
export function resolveCompositionBoundCallsPerLease(input: {
  composition?: CompositionBoundExecutionLeaseOverrideV1;
  baseCallsPerLease: number;
  hardToolCallCeiling: number;
  maxLeases: number;
  answerRecordCallCeiling?: number;
  sharedToolCallCapacity?: true;
}): number {
  assertPlainJsonData(input, "invalid-policy");
  exact(
    object(input, "invalid-policy"),
    [
      "composition",
      "baseCallsPerLease",
      "hardToolCallCeiling",
      "maxLeases",
      "answerRecordCallCeiling",
      "sharedToolCallCapacity",
    ],
    "invalid-policy",
    ["composition", "answerRecordCallCeiling", "sharedToolCallCapacity"],
  );
  const base = positive(input.baseCallsPerLease, "invalid-policy");
  const hardToolCallCeiling = positive(input.hardToolCallCeiling, "invalid-policy");
  const maxLeases = positive(input.maxLeases, "invalid-policy");
  const recordsEnabled =
    input.answerRecordCallCeiling === undefined
      ? false
      : positive(input.answerRecordCallCeiling, "invalid-policy") > 0;
  if (!Object.hasOwn(input, "composition") || input.composition === undefined) {
    return base;
  }
  const composition = object(input.composition, "invalid-policy");
  exact(composition, ["callsPerLease"], "invalid-policy", ["callsPerLease"]);
  if (!Object.hasOwn(composition, "callsPerLease")) return base;
  const callsPerLease = positive(composition.callsPerLease, "invalid-policy");
  if (
    callsPerLease < base ||
    (!recordsEnabled && callsPerLease > hardToolCallCeiling) ||
    (!input.sharedToolCallCapacity && hardToolCallCeiling > callsPerLease * maxLeases) ||
    !Number.isSafeInteger(callsPerLease * maxLeases)
  ) {
    fail("invalid-policy");
  }
  return callsPerLease;
}

export function createExecutionLeasePolicy(
  input: CreateExecutionLeasePolicyInput,
): ExecutionLeasePolicyV1 {
  assertPlainJsonData(input, "invalid-policy");
  exact(
    object(input, "invalid-policy"),
    [
      "callsPerLease",
      "maxLeases",
      "hardToolCallCeiling",
      "answerRecordCallCeiling",
      "sharedToolCallCapacity",
      "maxProviderTurns",
      "maxCompactions",
      "cumulative",
    ],
    "invalid-policy",
    [
      "callsPerLease",
      "maxLeases",
      "hardToolCallCeiling",
      "answerRecordCallCeiling",
      "sharedToolCallCapacity",
      "maxProviderTurns",
    ],
  );
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-execution-lease-policy" as const,
    callsPerLease: Object.hasOwn(input, "callsPerLease")
      ? positive(input.callsPerLease, "invalid-policy")
      : EXECUTION_LEASE_DEFAULTS.callsPerLease,
    maxLeases: Object.hasOwn(input, "maxLeases")
      ? positive(input.maxLeases, "invalid-policy")
      : EXECUTION_LEASE_DEFAULTS.maxLeases,
    hardToolCallCeiling: Object.hasOwn(input, "hardToolCallCeiling")
      ? positive(input.hardToolCallCeiling, "invalid-policy")
      : EXECUTION_LEASE_DEFAULTS.hardToolCallCeiling,
    ...(input.answerRecordCallCeiling === undefined
      ? {}
      : { answerRecordCallCeiling: positive(input.answerRecordCallCeiling, "invalid-policy") }),
    ...(input.sharedToolCallCapacity === true ? { sharedToolCallCapacity: true as const } : {}),
    maxProviderTurns: Object.hasOwn(input, "maxProviderTurns")
      ? positive(input.maxProviderTurns, "invalid-policy")
      : EXECUTION_LEASE_DEFAULTS.maxProviderTurns,
    maxCompactions: input.maxCompactions,
    cumulative: { ...input.cumulative },
  };
  return decodeExecutionLeasePolicyV1({
    ...body,
    policySha256: sha256(body, "invalid-policy"),
  });
}

export function createExecutionLeasePolicyV2(input: {
  readonly callsPerLease: number;
  readonly sharedToolCallCapacity: true;
  readonly aggregatePolicy: ExecutionLeaseAggregatePolicyV2;
}): ExecutionLeasePolicyV2 {
  assertPlainJsonData(input, "invalid-policy");
  exact(
    object(input, "invalid-policy"),
    ["callsPerLease", "sharedToolCallCapacity", "aggregatePolicy"],
    "invalid-policy",
  );
  if (input.sharedToolCallCapacity !== true) fail("invalid-policy");
  const aggregatePolicy = decodeExecutionLeaseAggregatePolicyV2(input.aggregatePolicy);
  const body = {
    schemaVersion: 2 as const,
    kind: "docsfab-execution-lease-policy" as const,
    callsPerLease: positive(input.callsPerLease, "invalid-policy"),
    sharedToolCallCapacity: input.sharedToolCallCapacity as true,
    aggregatePolicy,
  };
  return deepFreeze({
    ...body,
    policySha256: sha256(body, "invalid-policy"),
  });
}

export function createExecutionLeaseIdentity(
  input: Omit<ExecutionLeaseIdentityV1, "schemaVersion" | "kind" | "identitySha256">,
): ExecutionLeaseIdentityV1 {
  assertPlainJsonData(input, "invalid-identity");
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-execution-lease-identity" as const,
    ...input,
  };
  return decodeExecutionLeaseIdentity({
    ...body,
    identitySha256: sha256(body, "invalid-identity"),
  });
}

export function createExecutionLeaseState(
  input: Omit<ExecutionLeaseStateV1, "schemaVersion" | "kind" | "stateSha256">,
  policy: AnyExecutionLeasePolicyV1OrV2,
  previous?: ExecutionLeaseStateV1,
): ExecutionLeaseStateV1 {
  assertPlainJsonData(input, "invalid-state");
  assertPlainJsonData(policy, "invalid-policy");
  if (previous !== undefined) assertPlainJsonData(previous, "invalid-state");
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-execution-lease-state" as const,
    ...input,
    toolCalls: { ...input.toolCalls },
    ...(input.toolCallsByScope === undefined
      ? {}
      : { toolCallsByScope: { ...input.toolCallsByScope } }),
    cost: { ...input.cost },
  };
  return decodeExecutionLeaseState(
    { ...body, stateSha256: sha256(body, "invalid-state") },
    policy,
    previous,
  );
}

export function createExecutionCheckpoint(input: {
  policy: AnyExecutionLeasePolicyV1OrV2;
  identity: ExecutionLeaseIdentityV1;
  state: ExecutionLeaseStateV1;
  reason: ExecutionCheckpointReason;
  previous?: ExecutionCheckpointV1;
}): ExecutionCheckpointV1 {
  assertPlainJsonData(input, "invalid-checkpoint");
  exact(
    object(input, "invalid-checkpoint"),
    ["policy", "identity", "state", "reason", "previous"],
    "invalid-checkpoint",
    ["previous"],
  );
  if (input.identity.policySha256 !== input.policy.policySha256) {
    fail("invalid-checkpoint");
  }
  decodeExecutionLeaseState(input.state, input.policy, input.previous?.state);
  if (input.state.lastCheckpointSha256 !== (input.previous?.checkpointSha256 ?? null)) {
    fail("invalid-checkpoint");
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-execution-checkpoint" as const,
    sequence: (input.previous?.sequence ?? 0) + 1,
    reason: input.reason,
    identitySha256: input.identity.identitySha256,
    policySha256: input.policy.policySha256,
    previousCheckpointSha256: input.previous?.checkpointSha256 ?? null,
    state: input.state,
  };
  return decodeExecutionCheckpoint(
    { ...body, checkpointSha256: sha256(body, "invalid-checkpoint") },
    input.policy,
    input.identity,
    input.previous,
  );
}

export function selectExecutionStopReason(
  reasons: readonly ExecutionStopReason[],
): ExecutionStopReason | undefined {
  assertPlainJsonData(reasons, "invalid-decision");
  const unique = new Set(reasons);
  if (
    unique.size !== reasons.length ||
    reasons.some((reason) => !EXECUTION_STOP_REASON_PRECEDENCE.includes(reason))
  ) {
    fail("invalid-decision");
  }
  return EXECUTION_STOP_REASON_PRECEDENCE.find((reason) => unique.has(reason));
}

export function decideExecutionLeaseRenewal(input: {
  policy: AnyExecutionLeasePolicyV1OrV2;
  identity: ExecutionLeaseIdentityV1;
  checkpoint: ExecutionCheckpointV1;
  stopReasons?: readonly ExecutionStopReason[];
  history?: ExecutionLeaseRenewalHistoryV1;
}): ExecutionLeaseDecisionV1 {
  assertPlainJsonData(input, "invalid-decision");
  exact(
    object(input, "invalid-decision"),
    ["policy", "identity", "checkpoint", "stopReasons", "history"],
    "invalid-decision",
    ["stopReasons", "history"],
  );
  const policy = decodeAnyExecutionLeasePolicy(input.policy);
  const identity = decodeExecutionLeaseIdentity(input.identity);
  if (identity.policySha256 !== policy.policySha256) fail("invalid-decision");
  const checkpoint = decodeRenewalCheckpoint(input.checkpoint, policy, identity, input.history);
  return createRenewalDecision(policy, identity, checkpoint, input.stopReasons ?? []);
}

function decodeRenewalCheckpoint(
  checkpointValue: ExecutionCheckpointV1,
  policy: AnyExecutionLeasePolicyV1OrV2,
  identity: ExecutionLeaseIdentityV1,
  historyValue?: ExecutionLeaseRenewalHistoryV1,
): ExecutionCheckpointV1 {
  if (historyValue === undefined) {
    return decodeExecutionCheckpoint(checkpointValue, policy, identity);
  }
  const history = object(historyValue, "invalid-decision");
  exact(history, ["checkpoints", "decisions"], "invalid-decision");
  const checkpoints: ExecutionCheckpointV1[] = [];
  for (const raw of array(history.checkpoints, "invalid-decision")) {
    checkpoints.push(decodeExecutionCheckpoint(raw, policy, identity, checkpoints.at(-1)));
  }
  const checkpoint = decodeExecutionCheckpoint(
    checkpointValue,
    policy,
    identity,
    checkpoints.at(-1),
  );
  const checkpointByDigest = new Map(checkpoints.map((entry) => [entry.checkpointSha256, entry]));
  const decisions = array(history.decisions, "invalid-decision").map((raw) =>
    decodeDecision(raw, policy, identity, checkpointByDigest),
  );
  if (new Set(decisions.map((decision) => decision.checkpointSha256)).size !== decisions.length)
    fail("invalid-decision");
  const checkpointOrder = new Map(
    checkpoints.map((entry, index) => [entry.checkpointSha256, index]),
  );
  for (let index = 1; index < decisions.length; index += 1) {
    if (
      (checkpointOrder.get(decisions[index - 1]!.checkpointSha256) ?? -1) >=
      (checkpointOrder.get(decisions[index]!.checkpointSha256) ?? -1)
    ) {
      fail("invalid-decision");
    }
  }
  const decisionByCheckpoint = new Map(
    decisions.map((decision) => [decision.checkpointSha256, decision]),
  );
  const grantByLease = new Map<number, ExecutionLeaseGrantV1 | ExecutionLeaseGrantV2>();
  for (const decision of decisions) {
    if (decision.decision !== "granted") continue;
    if (grantByLease.has(decision.leaseNumber)) fail("invalid-decision");
    grantByLease.set(decision.leaseNumber, decision);
  }
  const chain = [...checkpoints, checkpoint];
  for (let index = 1; index < chain.length; index += 1) {
    const previous = chain[index - 1]!;
    const next = chain[index]!;
    assertCausalLeaseTransition(
      previous.state,
      next.state,
      previous,
      decisionByCheckpoint,
      "invalid-decision",
    );
    const decision = decisionByCheckpoint.get(previous.checkpointSha256);
    if (
      decision?.decision === "denied" ||
      (decision?.decision === "granted" && next.state.leaseNumber !== decision.leaseNumber)
    ) {
      fail("invalid-decision");
    }
  }
  for (const entry of chain) {
    if (entry.state.leaseNumber === 1) continue;
    const grant = grantByLease.get(entry.state.leaseNumber);
    if (!grant || entry.state.leaseExecutedToolCalls > grant.grantedToolCalls) {
      fail("invalid-decision");
    }
  }
  return checkpoint;
}

function createRenewalDecision(
  policy: AnyExecutionLeasePolicyV1OrV2,
  identity: ExecutionLeaseIdentityV1,
  checkpoint: ExecutionCheckpointV1,
  requestedStopReasons: readonly ExecutionStopReason[],
): ExecutionLeaseDecisionV1 {
  const state = checkpoint.state;
  // Validate callers before de-duplicating with Set. Silently collapsing duplicate or
  // open-ended reasons would make the persisted decision differ from the request.
  selectExecutionStopReason(requestedStopReasons);
  const considered = new Set<ExecutionStopReason>(requestedStopReasons);
  const currentLeaseAllowance = currentLeaseToolCallAllowance(policy, state);
  if (leaseToolCallsCharged(policy, state) !== currentLeaseAllowance) {
    considered.add("checkpoint-not-renewable");
  }
  if (checkpoint.reason !== "lease-exhausted" && checkpoint.reason !== "budget-boundary") {
    considered.add("checkpoint-not-renewable");
  }
  if (
    policy.schemaVersion === 1 &&
    readingToolCallsExecuted(state) >= policy.hardToolCallCeiling &&
    remainingScopedToolCalls(policy, state) === 0
  ) {
    considered.add("hard-tool-call-ceiling");
  }
  if (policy.schemaVersion === 1 && state.leaseNumber >= policy.maxLeases)
    considered.add("lease-limit");
  if (
    policy.schemaVersion === 1 &&
    state.cumulativeInputTokens >= policy.cumulative.maxInputTokens
  ) {
    considered.add("cumulative-input-limit");
  }
  if (
    policy.schemaVersion === 1 &&
    state.cumulativeOutputTokens >= policy.cumulative.maxOutputTokens
  ) {
    considered.add("cumulative-output-limit");
  }
  if (policy.schemaVersion === 1 && state.elapsedMs >= policy.cumulative.maxElapsedMs) {
    considered.add("cumulative-time-limit");
  }
  if (policy.schemaVersion === 1 && policy.cumulative.maxKnownCostMicrousd !== undefined) {
    if (state.cost.status === "unavailable") considered.add("cost-unavailable");
    else if (state.cost.microusd >= policy.cumulative.maxKnownCostMicrousd) {
      considered.add("cumulative-cost-limit");
    }
  }
  const remainingProviderTurns =
    policy.schemaVersion === 1 ? policy.maxProviderTurns - state.providerTurns : null;
  if (remainingProviderTurns !== null && remainingProviderTurns <= 1)
    considered.add("provider-turn-limit");

  const orderedReasons = EXECUTION_STOP_REASON_PRECEDENCE.filter((reason) =>
    considered.has(reason),
  );
  const reason = selectExecutionStopReason(orderedReasons);
  if (reason) {
    const body = {
      schemaVersion: policy.schemaVersion,
      kind: "docsfab-execution-lease-decision" as const,
      decision: "denied" as const,
      leaseNumber: state.leaseNumber,
      reason,
      identitySha256: identity.identitySha256,
      policySha256: policy.policySha256,
      checkpointSha256: checkpoint.checkpointSha256,
      consideredStopReasons: orderedReasons,
    };
    return deepFreeze({ ...body, decisionSha256: sha256(body, "invalid-decision") });
  }

  const grantedToolCalls = renewalToolCallGrant(policy, state);
  if (grantedToolCalls <= 0) fail("invalid-decision");
  if (policy.schemaVersion === 2) {
    const body = {
      schemaVersion: 2 as const,
      kind: "docsfab-execution-lease-decision" as const,
      decision: "granted" as const,
      leaseNumber: state.leaseNumber + 1,
      grantedToolCalls,
      identitySha256: identity.identitySha256,
      policySha256: policy.policySha256,
      checkpointSha256: checkpoint.checkpointSha256,
      consideredStopReasons: [] as [],
    };
    return deepFreeze({ ...body, decisionSha256: sha256(body, "invalid-decision") });
  }
  if (remainingProviderTurns === null) fail("invalid-decision");
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-execution-lease-decision" as const,
    decision: "granted" as const,
    leaseNumber: state.leaseNumber + 1,
    grantedToolCalls,
    remainingProviderTurns,
    remainingInputTokens: policy.cumulative.maxInputTokens - state.cumulativeInputTokens,
    remainingOutputTokens: policy.cumulative.maxOutputTokens - state.cumulativeOutputTokens,
    remainingElapsedMs: policy.cumulative.maxElapsedMs - state.elapsedMs,
    ...(policy.cumulative.maxKnownCostMicrousd !== undefined && state.cost.status === "known"
      ? { remainingKnownCostMicrousd: policy.cumulative.maxKnownCostMicrousd - state.cost.microusd }
      : {}),
    identitySha256: identity.identitySha256,
    policySha256: policy.policySha256,
    checkpointSha256: checkpoint.checkpointSha256,
    consideredStopReasons: [] as [],
  };
  return deepFreeze({ ...body, decisionSha256: sha256(body, "invalid-decision") });
}

export function createExecutionLeaseRecord(
  input: Omit<ExecutionLeaseRecordV1, "schemaVersion" | "kind" | "recordSha256">,
): ExecutionLeaseRecordV1 {
  assertPlainJsonData(input, "invalid-record");
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-execution-lease-record" as const,
    ...input,
  };
  return decodeExecutionLeaseRecord({
    ...body,
    recordSha256: sha256(body, "invalid-record"),
  });
}

export function serializeExecutionLeaseRecord(record: ExecutionLeaseRecordV1): string {
  return canonicalizeJsonEvidence(
    decodeExecutionLeaseRecord(record) as unknown as JsonEvidenceValue,
  );
}

export function parseExecutionLeaseRecord(
  input: string | Uint8Array | unknown,
): ExecutionLeaseRecordV1 {
  const value =
    typeof input === "string" || input instanceof Uint8Array
      ? parseJsonEvidence(input, { requireCanonical: true })
      : input;
  return decodeExecutionLeaseRecord(value);
}

export function decodeExecutionLeaseState(
  value: unknown,
  policyValue: AnyExecutionLeasePolicyV1OrV2,
  previousValue?: ExecutionLeaseStateV1,
): ExecutionLeaseStateV1 {
  assertPlainJsonData(value, "invalid-state");
  assertPlainJsonData(policyValue, "invalid-policy");
  if (previousValue !== undefined) assertPlainJsonData(previousValue, "invalid-state");
  const policy = decodeAnyExecutionLeasePolicy(policyValue);
  const item = object(value, "invalid-state");
  exact(
    item,
    [
      "schemaVersion",
      "kind",
      "leaseNumber",
      "leaseExecutedToolCalls",
      "leaseToolCallAllowance",
      "leaseExecutedAnswerRecordCalls",
      "leaseAdmittedAnswerRecordCalls",
      "providerTurns",
      "compactions",
      "toolCalls",
      "toolCallsByScope",
      "answerRecordCallsAdmitted",
      "cumulativeInputTokens",
      "cumulativeOutputTokens",
      "elapsedMs",
      "cost",
      "lastCheckpointSha256",
      "stateSha256",
    ],
    "invalid-state",
    [
      "leaseToolCallAllowance",
      "leaseExecutedAnswerRecordCalls",
      "leaseAdmittedAnswerRecordCalls",
      "toolCallsByScope",
      "answerRecordCallsAdmitted",
    ],
  );
  if (item.schemaVersion !== 1 || item.kind !== "docsfab-execution-lease-state") {
    fail("migration-required");
  }
  const leaseNumber = positive(item.leaseNumber, "invalid-state");
  const leaseExecutedToolCalls = nonnegative(item.leaseExecutedToolCalls, "invalid-state");
  const leaseToolCallAllowance =
    item.leaseToolCallAllowance === undefined
      ? undefined
      : positive(item.leaseToolCallAllowance, "invalid-state");
  const leaseExecutedAnswerRecordCalls =
    item.leaseExecutedAnswerRecordCalls === undefined
      ? undefined
      : nonnegative(item.leaseExecutedAnswerRecordCalls, "invalid-state");
  const leaseAdmittedAnswerRecordCalls =
    item.leaseAdmittedAnswerRecordCalls === undefined
      ? undefined
      : nonnegative(item.leaseAdmittedAnswerRecordCalls, "invalid-state");
  const providerTurns = nonnegative(item.providerTurns, "invalid-state");
  const compactions = nonnegative(item.compactions, "invalid-state");
  if (
    (policy.schemaVersion === 1 && leaseNumber > policy.maxLeases) ||
    leaseExecutedToolCalls > policy.callsPerLease ||
    (policy.schemaVersion === 1 && providerTurns > policy.maxProviderTurns) ||
    (policy.schemaVersion === 1 && compactions > policy.maxCompactions)
  ) {
    fail("invalid-state");
  }
  const toolCalls = decodeCounters(item.toolCalls);
  const toolCallsByScope =
    item.toolCallsByScope === undefined ? undefined : decodeToolCallsByScope(item.toolCallsByScope);
  const answerRecordCallsAdmitted =
    item.answerRecordCallsAdmitted === undefined
      ? undefined
      : nonnegative(item.answerRecordCallsAdmitted, "invalid-state");
  const hasAnswerRecordScope =
    policy.schemaVersion === 2 || policy.answerRecordCallCeiling !== undefined;
  if (!hasAnswerRecordScope) {
    if (
      leaseExecutedAnswerRecordCalls !== undefined ||
      leaseToolCallAllowance !== undefined ||
      leaseAdmittedAnswerRecordCalls !== undefined ||
      toolCallsByScope !== undefined ||
      answerRecordCallsAdmitted !== undefined ||
      leaseExecutedToolCalls > toolCalls.executed ||
      (policy.schemaVersion === 1 && toolCalls.executed > policy.hardToolCallCeiling)
    )
      fail("invalid-state");
  } else {
    if (
      leaseExecutedAnswerRecordCalls === undefined ||
      leaseToolCallAllowance === undefined ||
      leaseAdmittedAnswerRecordCalls === undefined ||
      toolCallsByScope === undefined ||
      answerRecordCallsAdmitted === undefined
    )
      fail("invalid-state");
    if (
      leaseExecutedAnswerRecordCalls > leaseExecutedToolCalls ||
      leaseToolCallAllowance > policy.callsPerLease ||
      leaseExecutedAnswerRecordCalls > toolCallsByScope.answerRecord ||
      toolCallsByScope.reading + toolCallsByScope.answerRecord !== toolCalls.executed ||
      (policy.schemaVersion === 1 && toolCallsByScope.reading > policy.hardToolCallCeiling) ||
      (policy.schemaVersion === 1 &&
        policy.answerRecordCallCeiling !== undefined &&
        toolCallsByScope.answerRecord > policy.answerRecordCallCeiling) ||
      leaseExecutedToolCalls > policy.callsPerLease ||
      leaseExecutedAnswerRecordCalls > leaseAdmittedAnswerRecordCalls ||
      leaseExecutedToolCalls + leaseAdmittedAnswerRecordCalls - leaseExecutedAnswerRecordCalls >
        leaseToolCallAllowance ||
      answerRecordCallsAdmitted < toolCallsByScope.answerRecord ||
      (policy.schemaVersion === 1 &&
        policy.answerRecordCallCeiling !== undefined &&
        answerRecordCallsAdmitted > policy.answerRecordCallCeiling) ||
      (policy.schemaVersion === 1 &&
        policy.sharedToolCallCapacity === true &&
        toolCallsByScope.reading + answerRecordCallsAdmitted >
          executionLeaseChargeableAttemptCeiling(policy)!) ||
      answerRecordCallsAdmitted > toolCalls.requested ||
      leaseAdmittedAnswerRecordCalls > answerRecordCallsAdmitted
    )
      fail("invalid-state");
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-execution-lease-state" as const,
    leaseNumber,
    leaseExecutedToolCalls,
    ...(leaseToolCallAllowance === undefined ? {} : { leaseToolCallAllowance }),
    ...(leaseExecutedAnswerRecordCalls === undefined ? {} : { leaseExecutedAnswerRecordCalls }),
    ...(leaseAdmittedAnswerRecordCalls === undefined ? {} : { leaseAdmittedAnswerRecordCalls }),
    providerTurns,
    compactions,
    toolCalls,
    ...(toolCallsByScope === undefined ? {} : { toolCallsByScope }),
    ...(answerRecordCallsAdmitted === undefined ? {} : { answerRecordCallsAdmitted }),
    cumulativeInputTokens: nonnegative(item.cumulativeInputTokens, "invalid-state"),
    cumulativeOutputTokens: nonnegative(item.cumulativeOutputTokens, "invalid-state"),
    elapsedMs: nonnegative(item.elapsedMs, "invalid-state"),
    cost: decodeCost(item.cost),
    lastCheckpointSha256: nullableDigest(item.lastCheckpointSha256, "invalid-state"),
  };
  if (
    policy.schemaVersion === 1 &&
    policy.cumulative.maxKnownCostMicrousd !== undefined &&
    body.cost.status === "unavailable" &&
    (body.leaseExecutedToolCalls !== 0 ||
      (body.leaseAdmittedAnswerRecordCalls ?? 0) !== 0 ||
      body.providerTurns !== 0 ||
      body.compactions !== 0 ||
      body.toolCalls.executed !== 0 ||
      (body.answerRecordCallsAdmitted ?? 0) !== 0 ||
      body.cumulativeInputTokens !== 0 ||
      body.cumulativeOutputTokens !== 0)
  ) {
    fail("invalid-state");
  }
  digest(item.stateSha256, "invalid-state");
  if (item.stateSha256 !== sha256(body, "invalid-state")) fail("invalid-state");
  const decoded = deepFreeze({ ...body, stateSha256: item.stateSha256 });
  if (previousValue) assertStateProgression(previousValue, decoded, policy);
  return decoded;
}

export function assertStateProgression(
  previousValue: ExecutionLeaseStateV1,
  nextValue: ExecutionLeaseStateV1,
  policyValue: AnyExecutionLeasePolicyV1OrV2,
): void {
  const policy = decodeAnyExecutionLeasePolicy(policyValue);
  const previous = decodeExecutionLeaseState(previousValue, policy);
  const next = decodeExecutionLeaseState(nextValue, policy);
  const sameLease = next.leaseNumber === previous.leaseNumber;
  const renewal = next.leaseNumber === previous.leaseNumber + 1;
  if (!sameLease && !renewal) fail("counter-regression");
  if (sameLease && next.leaseToolCallAllowance !== previous.leaseToolCallAllowance) {
    fail("counter-regression");
  }
  if (sameLease && next.leaseExecutedToolCalls < previous.leaseExecutedToolCalls) {
    fail("counter-regression");
  }
  if (
    sameLease &&
    (next.leaseExecutedAnswerRecordCalls ?? 0) < (previous.leaseExecutedAnswerRecordCalls ?? 0)
  ) {
    fail("counter-regression");
  }
  if (
    (policy.schemaVersion === 2 || policy.answerRecordCallCeiling !== undefined) &&
    sameLease &&
    (next.leaseAdmittedAnswerRecordCalls ?? 0) < (previous.leaseAdmittedAnswerRecordCalls ?? 0)
  ) {
    fail("counter-regression");
  }
  if (
    sameLease &&
    next.toolCalls.executed - previous.toolCalls.executed !==
      next.leaseExecutedToolCalls - previous.leaseExecutedToolCalls
  ) {
    fail("counter-regression");
  }
  if (policy.schemaVersion === 2 || policy.answerRecordCallCeiling !== undefined) {
    const previousRecord = previous.toolCallsByScope?.answerRecord ?? -1;
    const nextRecord = next.toolCallsByScope?.answerRecord ?? -1;
    if (
      previousRecord < 0 ||
      nextRecord < previousRecord ||
      (sameLease &&
        nextRecord - previousRecord !==
          (next.leaseExecutedAnswerRecordCalls ?? -1) -
            (previous.leaseExecutedAnswerRecordCalls ?? -1))
    ) {
      fail("counter-regression");
    }
    if (
      (next.answerRecordCallsAdmitted ?? -1) < (previous.answerRecordCallsAdmitted ?? -1) ||
      (sameLease &&
        next.answerRecordCallsAdmitted! - previous.answerRecordCallsAdmitted! !==
          (next.leaseAdmittedAnswerRecordCalls ?? -1) -
            (previous.leaseAdmittedAnswerRecordCalls ?? -1))
    ) {
      fail("counter-regression");
    }
  }
  if (renewal) {
    const allowance = renewalToolCallGrant(policy, previous);
    if (
      leaseToolCallsCharged(policy, previous) !== currentLeaseToolCallAllowance(policy, previous) ||
      ((policy.schemaVersion === 2 || policy.answerRecordCallCeiling !== undefined) &&
        next.leaseToolCallAllowance !== allowance) ||
      next.toolCalls.executed - previous.toolCalls.executed !== next.leaseExecutedToolCalls
    ) {
      fail("counter-regression");
    }
    if (policy.schemaVersion === 2 || policy.answerRecordCallCeiling !== undefined) {
      const previousRecord = previous.toolCallsByScope?.answerRecord ?? -1;
      const nextRecord = next.toolCallsByScope?.answerRecord ?? -1;
      if (
        nextRecord - previousRecord !== next.leaseExecutedAnswerRecordCalls ||
        next.answerRecordCallsAdmitted! - previous.answerRecordCallsAdmitted! !==
          next.leaseAdmittedAnswerRecordCalls
      ) {
        fail("counter-regression");
      }
    }
  }
  for (const field of [
    "requested",
    "executed",
    "succeeded",
    "failed",
    "denied",
    "governanceBlocked",
  ] as const) {
    if (next.toolCalls[field] < previous.toolCalls[field]) fail("counter-regression");
  }
  if (
    next.providerTurns < previous.providerTurns ||
    next.compactions < previous.compactions ||
    next.cumulativeInputTokens < previous.cumulativeInputTokens ||
    next.cumulativeOutputTokens < previous.cumulativeOutputTokens ||
    next.elapsedMs < previous.elapsedMs
  )
    fail("counter-regression");
  if (
    previous.cost.status !== next.cost.status ||
    (previous.cost.status === "unavailable" &&
      (next.cost.status !== "unavailable" || next.cost.reason !== previous.cost.reason)) ||
    (previous.cost.status === "known" &&
      (next.cost.status !== "known" || next.cost.microusd < previous.cost.microusd))
  ) {
    fail("counter-regression");
  }
}

export function decodeExecutionCheckpoint(
  value: unknown,
  policyValue: AnyExecutionLeasePolicyV1OrV2,
  identityValue: ExecutionLeaseIdentityV1,
  previous?: ExecutionCheckpointV1,
): ExecutionCheckpointV1 {
  assertPlainJsonData(value, "invalid-checkpoint");
  assertPlainJsonData(policyValue, "invalid-policy");
  assertPlainJsonData(identityValue, "invalid-identity");
  if (previous !== undefined) assertPlainJsonData(previous, "invalid-checkpoint");
  const policy = decodeAnyExecutionLeasePolicy(policyValue);
  const identity = decodeExecutionLeaseIdentity(identityValue);
  if (identity.policySha256 !== policy.policySha256) fail("invalid-checkpoint");
  const item = object(value, "invalid-checkpoint");
  exact(
    item,
    [
      "schemaVersion",
      "kind",
      "sequence",
      "reason",
      "identitySha256",
      "policySha256",
      "previousCheckpointSha256",
      "state",
      "checkpointSha256",
    ],
    "invalid-checkpoint",
  );
  if (item.schemaVersion !== 1 || item.kind !== "docsfab-execution-checkpoint") {
    fail("migration-required");
  }
  const sequence = positive(item.sequence, "invalid-checkpoint");
  const reason = enumValue(item.reason, CHECKPOINT_REASONS, "invalid-checkpoint");
  if (
    sequence !== (previous?.sequence ?? 0) + 1 ||
    item.identitySha256 !== identity.identitySha256 ||
    item.policySha256 !== policy.policySha256 ||
    item.previousCheckpointSha256 !== (previous?.checkpointSha256 ?? null)
  ) {
    fail("invalid-checkpoint");
  }
  const state = decodeExecutionLeaseState(item.state, policy, previous?.state);
  if (!previous && state.leaseNumber !== 1) fail("invalid-checkpoint");
  if (state.lastCheckpointSha256 !== (previous?.checkpointSha256 ?? null)) {
    fail("invalid-checkpoint");
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-execution-checkpoint" as const,
    sequence,
    reason,
    identitySha256: identity.identitySha256,
    policySha256: policy.policySha256,
    previousCheckpointSha256: previous?.checkpointSha256 ?? null,
    state,
  };
  digest(item.checkpointSha256, "invalid-checkpoint");
  if (item.checkpointSha256 !== sha256(body, "invalid-checkpoint")) {
    fail("invalid-checkpoint");
  }
  return deepFreeze({ ...body, checkpointSha256: item.checkpointSha256 });
}

export function decodeExecutionLeaseRecord(value: unknown): ExecutionLeaseRecordV1 {
  assertPlainJsonData(value, "invalid-record");
  const item = object(value, "invalid-record");
  exact(
    item,
    [
      "schemaVersion",
      "kind",
      "policy",
      "identity",
      "initialState",
      "checkpoints",
      "decisions",
      "finalState",
      "chargeableAttemptCeiling",
      "terminalReason",
      "recordSha256",
    ],
    "invalid-record",
    ["chargeableAttemptCeiling", "terminalReason"],
  );
  if (item.schemaVersion !== 1 || item.kind !== "docsfab-execution-lease-record") {
    fail("migration-required");
  }
  const policy = decodeAnyExecutionLeasePolicy(item.policy);
  const chargeableAttemptCeiling =
    item.chargeableAttemptCeiling === undefined
      ? undefined
      : positive(item.chargeableAttemptCeiling, "invalid-record");
  if (
    (policy.schemaVersion === 1 &&
      (policy.answerRecordCallCeiling === undefined) !==
        (chargeableAttemptCeiling === undefined)) ||
    (policy.schemaVersion === 2 && chargeableAttemptCeiling !== undefined) ||
    (chargeableAttemptCeiling !== undefined &&
      executionLeaseChargeableAttemptCeiling(policy) !== null &&
      chargeableAttemptCeiling > executionLeaseChargeableAttemptCeiling(policy)!)
  ) {
    fail("invalid-record");
  }
  const identity = decodeExecutionLeaseIdentity(item.identity);
  if (identity.policySha256 !== policy.policySha256) fail("invalid-record");
  const initialState = decodeExecutionLeaseState(item.initialState, policy);
  assertAuthoritativeInitialState(initialState, policy);
  const rawCheckpoints = array(item.checkpoints, "invalid-record");
  const checkpoints: ExecutionCheckpointV1[] = [];
  for (const raw of rawCheckpoints) {
    const checkpoint = decodeExecutionCheckpoint(raw, policy, identity, checkpoints.at(-1));
    if (checkpoints.length === 0) {
      assertStateProgression(initialState, checkpoint.state, policy);
    }
    checkpoints.push(checkpoint);
  }
  const checkpointByDigest = new Map(
    checkpoints.map((checkpoint) => [checkpoint.checkpointSha256, checkpoint]),
  );
  const decisions = array(item.decisions, "invalid-record").map((raw) =>
    decodeDecision(raw, policy, identity, checkpointByDigest),
  );
  if (new Set(decisions.map((decision) => decision.checkpointSha256)).size !== decisions.length)
    fail("invalid-record");
  const checkpointOrder = new Map(
    checkpoints.map((checkpoint, index) => [checkpoint.checkpointSha256, index]),
  );
  for (let index = 1; index < decisions.length; index += 1) {
    if (
      (checkpointOrder.get(decisions[index - 1]!.checkpointSha256) ?? -1) >=
      (checkpointOrder.get(decisions[index]!.checkpointSha256) ?? -1)
    ) {
      fail("invalid-record");
    }
  }
  const lastCheckpoint = checkpoints.at(-1);
  const finalState = decodeExecutionLeaseState(
    item.finalState,
    policy,
    lastCheckpoint?.state ?? initialState,
  );
  if (finalState.lastCheckpointSha256 !== (lastCheckpoint?.checkpointSha256 ?? null)) {
    fail("invalid-record");
  }
  const terminalReason =
    item.terminalReason === undefined
      ? undefined
      : enumValue(item.terminalReason, TERMINAL_REASONS, "invalid-record");
  const decisionByCheckpoint = new Map(
    decisions.map((decision) => [decision.checkpointSha256, decision]),
  );
  const grantByLease = new Map<number, ExecutionLeaseDecisionV1>();
  for (const decision of decisions) {
    if (decision.decision !== "granted") continue;
    if (grantByLease.has(decision.leaseNumber)) fail("invalid-record");
    grantByLease.set(decision.leaseNumber, decision);
  }
  assertCausalLeaseTransition(initialState, checkpoints[0]?.state, undefined, decisionByCheckpoint);
  for (let index = 1; index < checkpoints.length; index += 1) {
    assertCausalLeaseTransition(
      checkpoints[index - 1]!.state,
      checkpoints[index]!.state,
      checkpoints[index - 1],
      decisionByCheckpoint,
    );
  }
  assertCausalLeaseTransition(
    lastCheckpoint?.state ?? initialState,
    finalState,
    lastCheckpoint,
    decisionByCheckpoint,
  );
  for (const state of [...checkpoints.map((checkpoint) => checkpoint.state), finalState]) {
    if (state.leaseNumber === 1) continue;
    const grant = grantByLease.get(state.leaseNumber);
    if (
      grant?.decision !== "granted" ||
      leaseToolCallsCharged(policy, state) > grant.grantedToolCalls
    ) {
      fail("invalid-record");
    }
  }
  for (let index = 0; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index]!;
    const decision = decisionByCheckpoint.get(checkpoint.checkpointSha256);
    const nextBoundaryState = checkpoints[index + 1]?.state ?? finalState;
    if (
      decision?.decision === "granted" &&
      nextBoundaryState.leaseNumber === checkpoint.state.leaseNumber
    ) {
      if (
        index + 1 < checkpoints.length ||
        !sameExecutionPosition(checkpoint.state, finalState) ||
        terminalReason !== undefined
      )
        fail("invalid-record");
    }
    if (
      decision?.decision === "denied" &&
      (index + 1 < checkpoints.length ||
        !sameExecutionPosition(checkpoint.state, finalState) ||
        terminalReason !== decision.reason)
    )
      fail("invalid-record");
    if (
      checkpoint.reason === "workflow-completed" &&
      (index + 1 < checkpoints.length ||
        decision !== undefined ||
        !sameExecutionPosition(checkpoint.state, finalState) ||
        terminalReason !== "completed")
    )
      fail("invalid-record");
  }
  if (terminalReason === "completed" && lastCheckpoint?.reason !== "workflow-completed") {
    fail("invalid-record");
  }
  assertTerminalCausality(
    terminalReason,
    finalState,
    policy,
    lastCheckpoint,
    decisions.at(-1),
    chargeableAttemptCeiling,
  );
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-execution-lease-record" as const,
    policy,
    identity,
    initialState,
    checkpoints,
    decisions,
    finalState,
    ...(chargeableAttemptCeiling === undefined ? {} : { chargeableAttemptCeiling }),
    ...(terminalReason ? { terminalReason } : {}),
  };
  digest(item.recordSha256, "invalid-record");
  if (item.recordSha256 !== sha256(body, "invalid-record")) fail("invalid-record");
  return deepFreeze({ ...body, recordSha256: item.recordSha256 });
}

function decodeDecision(
  value: unknown,
  policy: AnyExecutionLeasePolicyV1OrV2,
  identity: ExecutionLeaseIdentityV1,
  checkpoints: Map<string, ExecutionCheckpointV1>,
): ExecutionLeaseDecisionV1 {
  assertPlainJsonData(value, "invalid-decision");
  const item = object(value, "invalid-decision");
  if (policy.schemaVersion === 2) {
    const allowed =
      item.decision === "granted"
        ? [
            "schemaVersion",
            "kind",
            "decision",
            "leaseNumber",
            "grantedToolCalls",
            "identitySha256",
            "policySha256",
            "checkpointSha256",
            "consideredStopReasons",
            "decisionSha256",
          ]
        : [
            "schemaVersion",
            "kind",
            "decision",
            "leaseNumber",
            "reason",
            "identitySha256",
            "policySha256",
            "checkpointSha256",
            "consideredStopReasons",
            "decisionSha256",
          ];
    exact(item, allowed, "invalid-decision");
    if (
      item.schemaVersion !== 2 ||
      item.kind !== "docsfab-execution-lease-decision" ||
      item.identitySha256 !== identity.identitySha256 ||
      item.policySha256 !== policy.policySha256
    )
      fail("invalid-decision");
    const checkpointDigest = digest(item.checkpointSha256, "invalid-decision");
    const checkpoint = checkpoints.get(checkpointDigest);
    if (!checkpoint) fail("invalid-decision");
    const expected = createRenewalDecision(
      policy,
      identity,
      checkpoint,
      item.decision === "denied"
        ? (array(item.consideredStopReasons, "invalid-decision") as ExecutionStopReason[])
        : [],
    );
    if (
      canonicalizeJsonEvidence(expected as unknown as JsonEvidenceValue) !==
      canonicalizeJsonEvidence(item as unknown as JsonEvidenceValue)
    )
      fail("invalid-decision");
    return expected;
  }
  const decision = item.decision;
  const allowed =
    decision === "granted"
      ? [
          "schemaVersion",
          "kind",
          "decision",
          "leaseNumber",
          "grantedToolCalls",
          "remainingProviderTurns",
          "remainingInputTokens",
          "remainingOutputTokens",
          "remainingElapsedMs",
          "remainingKnownCostMicrousd",
          "identitySha256",
          "policySha256",
          "checkpointSha256",
          "consideredStopReasons",
          "decisionSha256",
        ]
      : [
          "schemaVersion",
          "kind",
          "decision",
          "leaseNumber",
          "reason",
          "identitySha256",
          "policySha256",
          "checkpointSha256",
          "consideredStopReasons",
          "decisionSha256",
        ];
  exact(
    item,
    allowed,
    "invalid-decision",
    decision === "granted" ? ["remainingKnownCostMicrousd"] : [],
  );
  if (item.schemaVersion !== 1 || item.kind !== "docsfab-execution-lease-decision") {
    fail("migration-required");
  }
  if (
    (decision !== "granted" && decision !== "denied") ||
    item.identitySha256 !== identity.identitySha256 ||
    item.policySha256 !== policy.policySha256
  )
    fail("invalid-decision");
  const checkpointDigest = digest(item.checkpointSha256, "invalid-decision");
  const checkpoint = checkpoints.get(checkpointDigest);
  if (!checkpoint) fail("invalid-decision");
  const expected = createRenewalDecision(
    policy,
    identity,
    checkpoint,
    decision === "denied"
      ? (array(item.consideredStopReasons, "invalid-decision") as ExecutionStopReason[])
      : [],
  );
  if (
    canonicalizeJsonEvidence(expected as unknown as JsonEvidenceValue) !==
    canonicalizeJsonEvidence(item as unknown as JsonEvidenceValue)
  )
    fail("invalid-decision");
  return expected;
}

function assertCausalLeaseTransition(
  previous: ExecutionLeaseStateV1,
  next: ExecutionLeaseStateV1 | undefined,
  previousCheckpoint: ExecutionCheckpointV1 | undefined,
  decisions: Map<string, ExecutionLeaseDecisionV1>,
  code: ErrorCode = "invalid-record",
): void {
  if (!next || next.leaseNumber === previous.leaseNumber) return;
  const decision = previousCheckpoint
    ? decisions.get(previousCheckpoint.checkpointSha256)
    : undefined;
  if (
    next.leaseNumber !== previous.leaseNumber + 1 ||
    decision?.decision !== "granted" ||
    decision.leaseNumber !== next.leaseNumber
  ) {
    fail(code);
  }
}

function assertAuthoritativeInitialState(
  state: ExecutionLeaseStateV1,
  policy: AnyExecutionLeasePolicyV1OrV2,
): void {
  if (
    state.leaseNumber !== 1 ||
    state.leaseExecutedToolCalls !== 0 ||
    (policy.schemaVersion === 2
      ? state.leaseToolCallAllowance !== policy.callsPerLease
      : policy.answerRecordCallCeiling === undefined
        ? state.leaseToolCallAllowance !== undefined
        : state.leaseToolCallAllowance !==
          Math.min(
            policy.callsPerLease,
            policy.hardToolCallCeiling + policy.answerRecordCallCeiling,
          )) ||
    (state.leaseExecutedAnswerRecordCalls !== undefined &&
      state.leaseExecutedAnswerRecordCalls !== 0) ||
    (state.leaseAdmittedAnswerRecordCalls !== undefined &&
      state.leaseAdmittedAnswerRecordCalls !== 0) ||
    (state.toolCallsByScope !== undefined &&
      (state.toolCallsByScope.reading !== 0 || state.toolCallsByScope.answerRecord !== 0)) ||
    (state.answerRecordCallsAdmitted !== undefined && state.answerRecordCallsAdmitted !== 0) ||
    state.providerTurns !== 0 ||
    state.compactions !== 0 ||
    Object.values(state.toolCalls).some((count) => count !== 0) ||
    state.cumulativeInputTokens !== 0 ||
    state.cumulativeOutputTokens !== 0 ||
    state.elapsedMs !== 0 ||
    state.lastCheckpointSha256 !== null ||
    (state.cost.status === "known" && state.cost.microusd !== 0)
  ) {
    fail("invalid-record");
  }
}

/**
 * The state-bound stop reasons a terminal record over `state` must account for,
 * given the reason of the checkpoint it ends on. A terminal record's state-bound
 * reason must be the highest-precedence one of these.
 */
export function deriveStateBoundStopReasons(
  policy: AnyExecutionLeasePolicyV1OrV2,
  state: ExecutionLeaseStateV1,
  checkpointReason?: ExecutionCheckpointV1["reason"],
  chargeableAttemptCeiling?: number,
): ExecutionStopReason[] {
  const derived: ExecutionStopReason[] = [];
  if (
    policy.schemaVersion === 1 &&
    readingToolCallsExecuted(state) >= policy.hardToolCallCeiling &&
    remainingScopedToolCalls(policy, state) === 0
  ) {
    derived.push("hard-tool-call-ceiling");
  }
  if (
    chargeableAttemptCeiling !== undefined &&
    state.toolCalls.executed + state.toolCalls.denied >= chargeableAttemptCeiling
  ) {
    derived.push("hard-tool-call-ceiling");
  }
  if (
    policy.schemaVersion === 1 &&
    state.cumulativeInputTokens >= policy.cumulative.maxInputTokens
  ) {
    derived.push("cumulative-input-limit");
  }
  if (
    policy.schemaVersion === 1 &&
    state.cumulativeOutputTokens >= policy.cumulative.maxOutputTokens
  ) {
    derived.push("cumulative-output-limit");
  }
  if (policy.schemaVersion === 1 && state.elapsedMs >= policy.cumulative.maxElapsedMs) {
    derived.push("cumulative-time-limit");
  }
  if (policy.schemaVersion === 1 && policy.cumulative.maxKnownCostMicrousd !== undefined) {
    if (state.cost.status === "unavailable") derived.push("cost-unavailable");
    else if (state.cost.microusd >= policy.cumulative.maxKnownCostMicrousd) {
      derived.push("cumulative-cost-limit");
    }
  }
  if (policy.schemaVersion === 1 && policy.maxProviderTurns - state.providerTurns <= 1) {
    derived.push("provider-turn-limit");
  }
  if (policy.schemaVersion === 1 && state.leaseNumber >= policy.maxLeases)
    derived.push("lease-limit");
  if (checkpointReason !== undefined) {
    const currentLeaseAllowance = currentLeaseToolCallAllowance(policy, state);
    if (
      leaseToolCallsCharged(policy, state) !== currentLeaseAllowance ||
      (checkpointReason !== "lease-exhausted" && checkpointReason !== "budget-boundary")
    ) {
      derived.push("checkpoint-not-renewable");
    }
  }
  return derived;
}

function assertTerminalCausality(
  terminalReason: ExecutionTerminalReason | undefined,
  state: ExecutionLeaseStateV1,
  policy: AnyExecutionLeasePolicyV1OrV2,
  checkpoint: ExecutionCheckpointV1 | undefined,
  lastDecision: ExecutionLeaseDecisionV1 | undefined,
  chargeableAttemptCeiling?: number,
): void {
  if (terminalReason === undefined || lastDecision?.decision === "denied") return;
  const derived = deriveStateBoundStopReasons(
    policy,
    state,
    checkpoint?.reason,
    chargeableAttemptCeiling,
  );
  const stateBoundReasons: readonly ExecutionStopReason[] = [
    "hard-tool-call-ceiling",
    "cumulative-input-limit",
    "cumulative-output-limit",
    "cumulative-time-limit",
    "cost-unavailable",
    "cumulative-cost-limit",
    "provider-turn-limit",
    "lease-limit",
    "checkpoint-not-renewable",
  ];
  if (
    stateBoundReasons.includes(terminalReason as ExecutionStopReason) &&
    selectExecutionStopReason(derived) !== terminalReason
  ) {
    fail("invalid-record");
  }
}

function sameExecutionPosition(left: ExecutionLeaseStateV1, right: ExecutionLeaseStateV1): boolean {
  const project = (state: ExecutionLeaseStateV1) => ({
    leaseNumber: state.leaseNumber,
    leaseExecutedToolCalls: state.leaseExecutedToolCalls,
    providerTurns: state.providerTurns,
    compactions: state.compactions,
    toolCalls: state.toolCalls,
    cumulativeInputTokens: state.cumulativeInputTokens,
    cumulativeOutputTokens: state.cumulativeOutputTokens,
    elapsedMs: state.elapsedMs,
    cost: state.cost,
  });
  return (
    canonicalizeJsonEvidence(project(left) as unknown as JsonEvidenceValue) ===
    canonicalizeJsonEvidence(project(right) as unknown as JsonEvidenceValue)
  );
}

function decodeCounters(value: unknown): ExecutionToolCallCountersV1 {
  const item = object(value, "invalid-state");
  exact(
    item,
    ["requested", "executed", "succeeded", "failed", "denied", "governanceBlocked"],
    "invalid-state",
  );
  const counters = {
    requested: nonnegative(item.requested, "invalid-state"),
    executed: nonnegative(item.executed, "invalid-state"),
    succeeded: nonnegative(item.succeeded, "invalid-state"),
    failed: nonnegative(item.failed, "invalid-state"),
    denied: nonnegative(item.denied, "invalid-state"),
    governanceBlocked: nonnegative(item.governanceBlocked, "invalid-state"),
  };
  if (
    counters.executed !== counters.succeeded + counters.failed ||
    counters.requested !== counters.executed + counters.denied + counters.governanceBlocked
  ) {
    fail("invalid-state");
  }
  return counters;
}

function decodeToolCallsByScope(value: unknown): { reading: number; answerRecord: number } {
  const item = object(value, "invalid-state");
  exact(item, ["reading", "answerRecord"], "invalid-state");
  return {
    reading: nonnegative(item.reading, "invalid-state"),
    answerRecord: nonnegative(item.answerRecord, "invalid-state"),
  };
}

function decodeCost(value: unknown): ExecutionCostStateV1 {
  const item = object(value, "invalid-state");
  if (item.status === "known") {
    exact(item, ["status", "microusd"], "invalid-state");
    return { status: "known", microusd: nonnegative(item.microusd, "invalid-state") };
  }
  if (item.status === "unavailable") {
    exact(item, ["status", "reason"], "invalid-state");
    return {
      status: "unavailable",
      reason: enumValue(item.reason, COST_UNAVAILABLE_REASONS, "invalid-state"),
    };
  }
  fail("invalid-state");
}
