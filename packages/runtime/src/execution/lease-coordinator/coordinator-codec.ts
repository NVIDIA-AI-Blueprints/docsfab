// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createExecutionLeasePolicy,
  createExecutionLeaseRecord,
  decodeExecutionLeasePolicyV2,
  executionLeaseChargeableAttemptCeiling,
  EXECUTION_STOP_REASON_PRECEDENCE,
} from "../lease-contracts.js";
import type { AnyExecutionLeasePolicyV1OrV2, ExecutionStopReason } from "../lease-contracts.js";
import {
  decodeAnyChargeableAttemptPolicy,
  decodeChargeableAttemptPolicy,
  decodeChargeableAttemptState,
  validateCoordinatorCheckpoints,
} from "./chargeable-attempt.js";
import { validateCheckpointRequest } from "./command-codec.js";
import {
  digest,
  exact,
  hash,
  inert,
  nonnegative,
  positive,
  reject,
  withoutDigest,
} from "./protocol.js";
import {
  decodeContext,
  decodeGrantedEnvelope,
  decodeObservation,
  decodePricing,
  costForTokens,
} from "./value-codec.js";
import type {
  AnyExecutionCoordinatorDecision,
  ExecutionChargeableAttemptPolicyV1,
  ExecutionCoordinatorDecisionV1,
  ExecutionCoordinatorDecisionV2,
  ExecutionLeaseCoordinatorV1,
  PendingExecutionBatchV1,
} from "./types.js";

export function validateCoordinator(
  value: ExecutionLeaseCoordinatorV1,
): ExecutionLeaseCoordinatorV1 {
  inert(value);
  exact(
    value,
    [
      "schemaVersion",
      "kind",
      "policy",
      "identity",
      "initialState",
      "state",
      "checkpoints",
      "decisions",
      "chargeableAttemptPolicy",
      "initialChargeableAttemptState",
      "chargeableAttemptState",
      "coordinatorCheckpoints",
      "phase",
      "pricing",
      "context",
      "lastObservation",
      "pendingBatch",
      "checkpointRequest",
      "terminalReason",
      "coordinatorSha256",
    ],
    ["pendingBatch", "checkpointRequest", "terminalReason"],
  );
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "docsfab-execution-lease-coordinator" ||
    !["active", "batch-pending", "checkpoint-required", "terminal"].includes(value.phase)
  ) {
    reject();
  }
  if (value.coordinatorSha256 !== hash(withoutCoordinatorDigest(value))) reject();
  validateRecordProjection(value);
  const policy: AnyExecutionLeasePolicyV1OrV2 =
    value.policy.schemaVersion === 2
      ? decodeExecutionLeasePolicyV2(value.policy)
      : createExecutionLeasePolicy({
          callsPerLease: value.policy.callsPerLease,
          maxLeases: value.policy.maxLeases,
          hardToolCallCeiling: value.policy.hardToolCallCeiling,
          ...(value.policy.answerRecordCallCeiling === undefined
            ? {}
            : { answerRecordCallCeiling: value.policy.answerRecordCallCeiling }),
          ...(value.policy.sharedToolCallCapacity === true
            ? { sharedToolCallCapacity: true as const }
            : {}),
          maxProviderTurns: value.policy.maxProviderTurns,
          maxCompactions: value.policy.maxCompactions,
          cumulative: value.policy.cumulative,
        });
  if (policy.policySha256 !== value.policy.policySha256) reject();
  const chargeableAttemptPolicy =
    policy.schemaVersion === 2
      ? decodeAnyChargeableAttemptPolicy(value.chargeableAttemptPolicy)
      : decodeChargeableAttemptPolicy(
          value.chargeableAttemptPolicy as ExecutionChargeableAttemptPolicyV1,
          executionLeaseChargeableAttemptCeiling(policy),
        );
  const initialChargeableAttemptState = decodeChargeableAttemptState(
    value.initialChargeableAttemptState,
    chargeableAttemptPolicy,
  );
  const chargeableAttemptState = decodeChargeableAttemptState(
    value.chargeableAttemptState,
    chargeableAttemptPolicy,
  );
  if (
    initialChargeableAttemptState.chargeableAttempts !== 0 ||
    initialChargeableAttemptState.lastCheckpointSha256 !== null ||
    chargeableAttemptState.chargeableAttempts !==
      value.state.toolCalls.executed + value.state.toolCalls.denied
  )
    reject();
  validateCoordinatorCheckpoints(value);
  const pricing = decodePricing(value.pricing);
  const context = decodeContext(value.context);
  if (value.identity.contextAuthoritySha256 !== context.authoritySha256) reject();
  if (pricing.status === "known") {
    if (
      value.state.cost.status !== "known" ||
      value.state.cost.microusd !==
        costForTokens(
          pricing,
          value.state.cumulativeInputTokens,
          value.state.cumulativeOutputTokens,
        )
    )
      reject();
  } else if (
    value.state.cost.status !== "unavailable" ||
    value.state.cost.reason !== pricing.reason
  )
    reject();
  if (value.lastObservation !== null) {
    const observation = decodeObservation(
      value.lastObservation,
      value.identity.contextAuthoritySha256,
    );
    if (
      observation.providerTurns !== value.state.providerTurns ||
      observation.compactions !== value.state.compactions ||
      observation.cumulativeInputTokens !== value.state.cumulativeInputTokens ||
      observation.cumulativeOutputTokens !== value.state.cumulativeOutputTokens ||
      observation.elapsedMs !== value.state.elapsedMs ||
      hash(observation.context) !== hash(context)
    )
      reject();
  } else if (
    value.state.providerTurns !== 0 ||
    value.state.compactions !== 0 ||
    value.state.cumulativeInputTokens !== 0 ||
    value.state.cumulativeOutputTokens !== 0 ||
    value.state.elapsedMs !== 0
  )
    reject();
  if (value.pendingBatch !== undefined) {
    validatePendingBatch(
      value.pendingBatch,
      policy.schemaVersion === 2 || policy.answerRecordCallCeiling !== undefined,
    );
    if (pricing.status === "known") {
      if (
        value.pendingBatch.grantedEnvelope.knownCostMicrousd !==
        costForTokens(
          pricing,
          value.pendingBatch.grantedEnvelope.inputTokens,
          value.pendingBatch.grantedEnvelope.outputTokens,
        )
      )
        reject();
    } else if (
      (value.policy.schemaVersion === 1 &&
        value.policy.cumulative.maxKnownCostMicrousd !== undefined) ||
      value.pendingBatch.grantedEnvelope.knownCostMicrousd !== 0
    )
      reject();
  }
  if (value.checkpointRequest !== undefined) {
    validateCheckpointRequest(value.checkpointRequest);
    const progressDigest = value.lastObservation?.observationSha256 ?? value.state.stateSha256;
    if (
      value.checkpointRequest.observationSha256 !== progressDigest ||
      value.checkpointRequest.chargeableAttemptStateSha256 !== chargeableAttemptState.stateSha256
    )
      reject();
  }
  if (
    (value.phase === "batch-pending") !== (value.pendingBatch !== undefined) ||
    (value.phase === "checkpoint-required") !== (value.checkpointRequest !== undefined) ||
    (value.phase === "terminal") !== (value.terminalReason !== undefined) ||
    (value.phase === "active" &&
      chargeableAttemptPolicy.schemaVersion === 1 &&
      chargeableAttemptState.chargeableAttempts >= chargeableAttemptPolicy.maxChargeableAttempts)
  )
    reject();
  return value;
}

function validatePendingBatch(value: PendingExecutionBatchV1, recordsEnabled: boolean): void {
  exact(
    value,
    [
      "batchSha256",
      "requestedToolCalls",
      "authorizedCallSha256",
      "authorizedCallScopes",
      "deniedToolCalls",
      "governanceBlockedToolCalls",
      "grantedEnvelope",
    ],
    ["authorizedCallScopes"],
  );
  digest(value.batchSha256);
  positive(value.requestedToolCalls);
  nonnegative(value.deniedToolCalls);
  nonnegative(value.governanceBlockedToolCalls);
  for (const callSha256 of value.authorizedCallSha256) digest(callSha256);
  if (recordsEnabled !== (value.authorizedCallScopes !== undefined)) reject();
  if (value.authorizedCallScopes !== undefined) {
    if (value.authorizedCallScopes.length !== value.authorizedCallSha256.length) reject();
    for (const scope of value.authorizedCallScopes) {
      if (scope !== "reading" && scope !== "answer-record") reject();
    }
  }
  const grantedEnvelope = decodeGrantedEnvelope(value.grantedEnvelope);
  if (grantedEnvelope.toolCalls !== value.authorizedCallSha256.length) reject();
  if (
    value.requestedToolCalls !==
    value.authorizedCallSha256.length + value.deniedToolCalls + value.governanceBlockedToolCalls
  )
    reject();
}

export function validateCoordinatorDecision(
  value: AnyExecutionCoordinatorDecision,
): AnyExecutionCoordinatorDecision {
  if (value.schemaVersion === 1) return validateCoordinatorDecisionV1(value);
  if (value.schemaVersion === 2) return validateCoordinatorDecisionV2(value);
  reject();
}

function validateCoordinatorDecisionV1(
  value: ExecutionCoordinatorDecisionV1,
): ExecutionCoordinatorDecisionV1 {
  exact(
    value,
    [
      "schemaVersion",
      "kind",
      "decision",
      "previousCoordinatorSha256",
      "coordinatorSha256",
      "leaseNumber",
      "remainingLeaseToolCalls",
      "remainingChargeableAttempts",
      "authorizedToolCalls",
      "deniedToolCalls",
      "governanceBlockedToolCalls",
      "grantedEnvelope",
      "batchSha256",
      "reason",
      "decisionSha256",
    ],
    ["grantedEnvelope", "batchSha256", "reason"],
  );
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "docsfab-execution-coordinator-decision" ||
    !["grant", "checkpoint-required", "renewed", "denied", "terminal"].includes(value.decision)
  ) {
    reject();
  }
  if (value.previousCoordinatorSha256 !== null) digest(value.previousCoordinatorSha256);
  digest(value.coordinatorSha256);
  digest(value.decisionSha256);
  if (value.batchSha256 !== undefined) digest(value.batchSha256);
  if (value.grantedEnvelope !== undefined) decodeGrantedEnvelope(value.grantedEnvelope);
  positive(value.leaseNumber);
  nonnegative(value.remainingLeaseToolCalls);
  nonnegative(value.remainingChargeableAttempts);
  nonnegative(value.authorizedToolCalls);
  nonnegative(value.deniedToolCalls);
  nonnegative(value.governanceBlockedToolCalls);
  const hasBatchAccounting =
    value.authorizedToolCalls + value.deniedToolCalls + value.governanceBlockedToolCalls > 0;
  if (
    value.authorizedToolCalls > 0 !== (value.grantedEnvelope !== undefined) ||
    (value.grantedEnvelope !== undefined &&
      value.grantedEnvelope.toolCalls !== value.authorizedToolCalls) ||
    hasBatchAccounting !== (value.batchSha256 !== undefined)
  )
    reject();
  if (
    value.reason !== undefined &&
    !EXECUTION_STOP_REASON_PRECEDENCE.includes(value.reason as ExecutionStopReason) &&
    value.reason !== "completed" &&
    value.reason !== "needs-input" &&
    value.reason !== "needs-human-decision"
  )
    reject();
  if (value.decisionSha256 !== hash(withoutDigest(value, "decisionSha256"))) reject();
  return value;
}

function validateCoordinatorDecisionV2(
  value: ExecutionCoordinatorDecisionV2,
): ExecutionCoordinatorDecisionV2 {
  exact(
    value,
    [
      "schemaVersion",
      "kind",
      "decision",
      "previousCoordinatorSha256",
      "coordinatorSha256",
      "leaseNumber",
      "remainingLeaseToolCalls",
      "authorizedToolCalls",
      "deniedToolCalls",
      "governanceBlockedToolCalls",
      "grantedEnvelope",
      "batchSha256",
      "reason",
      "decisionSha256",
    ],
    ["grantedEnvelope", "batchSha256", "reason"],
  );
  if (
    value.schemaVersion !== 2 ||
    value.kind !== "docsfab-execution-coordinator-decision" ||
    !["grant", "checkpoint-required", "renewed", "denied", "terminal"].includes(value.decision)
  ) {
    reject();
  }
  if (value.previousCoordinatorSha256 !== null) digest(value.previousCoordinatorSha256);
  digest(value.coordinatorSha256);
  digest(value.decisionSha256);
  if (value.batchSha256 !== undefined) digest(value.batchSha256);
  if (value.grantedEnvelope !== undefined) decodeGrantedEnvelope(value.grantedEnvelope);
  positive(value.leaseNumber);
  nonnegative(value.remainingLeaseToolCalls);
  nonnegative(value.authorizedToolCalls);
  nonnegative(value.deniedToolCalls);
  nonnegative(value.governanceBlockedToolCalls);
  const hasBatchAccounting =
    value.authorizedToolCalls + value.deniedToolCalls + value.governanceBlockedToolCalls > 0;
  if (
    value.authorizedToolCalls > 0 !== (value.grantedEnvelope !== undefined) ||
    (value.grantedEnvelope !== undefined &&
      value.grantedEnvelope.toolCalls !== value.authorizedToolCalls) ||
    hasBatchAccounting !== (value.batchSha256 !== undefined)
  )
    reject();
  if (
    value.reason !== undefined &&
    !EXECUTION_STOP_REASON_PRECEDENCE.includes(value.reason as ExecutionStopReason) &&
    value.reason !== "completed" &&
    value.reason !== "needs-input" &&
    value.reason !== "needs-human-decision"
  )
    reject();
  if (value.decisionSha256 !== hash(withoutDigest(value, "decisionSha256"))) reject();
  return value;
}

function validateRecordProjection(value: ExecutionLeaseCoordinatorV1): void {
  createExecutionLeaseRecord({
    policy: value.policy,
    identity: value.identity,
    initialState: value.initialState,
    checkpoints: value.checkpoints,
    decisions: value.decisions,
    finalState: value.state,
    ...(value.policy.schemaVersion === 2
      ? {}
      : value.policy.answerRecordCallCeiling === undefined
        ? {}
        : value.chargeableAttemptPolicy.schemaVersion === 1
          ? { chargeableAttemptCeiling: value.chargeableAttemptPolicy.maxChargeableAttempts }
          : {}),
    ...(value.terminalReason ? { terminalReason: value.terminalReason } : {}),
  });
}

function withoutCoordinatorDigest(value: ExecutionLeaseCoordinatorV1) {
  return withoutDigest(value, "coordinatorSha256") as Omit<
    ExecutionLeaseCoordinatorV1,
    "coordinatorSha256"
  >;
}
