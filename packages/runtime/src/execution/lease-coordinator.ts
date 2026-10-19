// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import {
  createExecutionCheckpoint,
  createExecutionLeaseIdentity,
  createExecutionLeasePolicy,
  createExecutionLeasePolicyV2,
  createExecutionLeaseRecord,
  createExecutionLeaseState,
  decodeExecutionLeasePolicyV2,
  decideExecutionLeaseRenewal,
  EXECUTION_STOP_REASON_PRECEDENCE,
  EXECUTION_LEASE_DEFAULTS,
  executionLeaseChargeableAttemptCeiling,
  currentLeaseToolCallAllowance,
  leaseToolCallsCharged,
  resolveCompositionBoundCallsPerLease,
  resolveLeaseShapeForTurns,
  type CompositionBoundExecutionLeaseOverrideV1,
  type CreateExecutionLeasePolicyInput,
  type ExecutionCheckpointV1,
  type ExecutionCostStateV1,
  type ExecutionLeaseDecisionV1,
  type ExecutionLeaseIdentityV1,
  type ExecutionLeasePolicyV1,
  type ExecutionLeasePolicyV2,
  type AnyExecutionLeasePolicyV1OrV2,
  type ExecutionLeaseStateV1,
  type ExecutionStopReason,
  type ExecutionToolCallScopeV1,
  type ExecutionTerminalReason,
  answerRecordToolCallsAdmitted,
  readingToolCallsExecuted,
  remainingScopedToolCalls,
} from "./lease-contracts.js";

import {
  digest,
  exact,
  freeze,
  hash,
  inert,
  nonnegative,
  positive,
  reject,
  uniqueReasons,
  withoutDigest,
} from "./lease-coordinator/protocol.js";
import {
  advanceChargeableAttempts,
  createChargeableAttemptState,
  createCoordinatorCheckpoint,
  decodeAnyChargeableAttemptPolicy,
  decodeChargeableAttemptPolicy,
  remainingChargeableAttempts,
} from "./lease-coordinator/chargeable-attempt.js";
import { validateCommand } from "./lease-coordinator/command-codec.js";
import {
  validateCoordinator,
  validateCoordinatorDecision,
} from "./lease-coordinator/coordinator-codec.js";
import {
  costForTokens,
  createExecutionProgressObservation,
  decodeContext,
  decodeEnvelope,
  decodeGrantedEnvelope,
  decodeObservation,
  decodePricing,
  requireExecutableEnvelope,
  requireRenewalEnvelope,
} from "./lease-coordinator/value-codec.js";
import type {
  AnyExecutionChargeableAttemptPolicy,
  AnyExecutionCoordinatorDecision,
  BoundExecutionPricingV1,
  CheckpointRequestV1,
  ExecutionChargeableAttemptPolicyV1,
  ExecutionChargeableAttemptPolicyV2,
  ExecutionChargeableAttemptStateV1,
  ExecutionContextObservationV1,
  ExecutionCoordinatorCommandV1,
  ExecutionCoordinatorDecisionFields,
  ExecutionCoordinatorDecisionV1,
  ExecutionCoordinatorDecisionV2,
  ExecutionCoordinatorPhase,
  ExecutionLeaseCoordinatorPolicyInputV1,
  ExecutionLeaseCoordinatorV1,
  ExecutionLeasePolicyOverrideV1,
  ExecutionProgressObservationV1,
  ExecutionResourceEnvelopeV1,
  ExecutionToolBatchCallV1,
  ExecutionToolBatchResultV1,
  GrantedExecutionResourceEnvelopeV1,
  PendingExecutionBatchV1,
} from "./lease-coordinator/types.js";
export { ExecutionLeaseCoordinatorError } from "./lease-coordinator/protocol.js";
export {
  createAbsentChargeableAttemptPolicyV2,
  createExecutionChargeableAttemptPolicy,
} from "./lease-coordinator/chargeable-attempt.js";
export { createExecutionProgressObservation } from "./lease-coordinator/value-codec.js";
export type {
  AnyExecutionChargeableAttemptPolicy,
  AnyExecutionCoordinatorDecision,
  BoundExecutionPricingV1,
  ExecutionChargeableAttemptPolicyV1,
  ExecutionChargeableAttemptPolicyV2,
  ExecutionChargeableAttemptStateV1,
  ExecutionContextObservationV1,
  ExecutionCoordinatorCommandV1,
  ExecutionCoordinatorDecisionV1,
  ExecutionCoordinatorDecisionV2,
  ExecutionCoordinatorPhase,
  ExecutionLeaseCoordinatorPolicyInputV1,
  ExecutionLeaseCoordinatorV1,
  ExecutionLeasePolicyOverrideV1,
  ExecutionProgressObservationV1,
  ExecutionResourceEnvelopeV1,
  ExecutionToolBatchCallV1,
  ExecutionToolBatchResultV1,
  GrantedExecutionResourceEnvelopeV1,
} from "./lease-coordinator/types.js";

export function createAnswerRecordDiscoveryLeasePolicyV2(input: {
  readonly callsPerLease: number;
}): ExecutionLeasePolicyV2 {
  inert(input);
  exact(input, ["callsPerLease"]);
  return createExecutionLeasePolicyV2({
    callsPerLease: positive(input.callsPerLease),
    sharedToolCallCapacity: true,
    aggregatePolicy: { kind: "absent" },
  });
}

function resolveRecordModeLeaseShape(input: {
  maxProviderTurns: number;
  answerRecordCallCeiling: number;
  callsPerLease: number;
  hardToolCallCeiling: number;
  maxLeases: number;
  hardToolCallCeilingIsOverride: boolean;
  maxLeasesIsOverride: boolean;
}): { hardToolCallCeiling: number; maxLeases: number } {
  const readingCapacity = (maxLeases: number): number =>
    Math.min(
      input.hardToolCallCeiling,
      input.callsPerLease * maxLeases - input.answerRecordCallCeiling,
      input.maxProviderTurns - maxLeases,
    );
  if (input.hardToolCallCeilingIsOverride) {
    const leaseCandidates = input.maxLeasesIsOverride
      ? [input.maxLeases]
      : Array.from({ length: input.maxLeases }, (_, index) => index + 1);
    const maxLeases = leaseCandidates.find(
      (candidate) => readingCapacity(candidate) >= input.hardToolCallCeiling,
    );
    if (maxLeases === undefined) reject();
    return { hardToolCallCeiling: input.hardToolCallCeiling, maxLeases };
  }
  if (input.maxLeasesIsOverride) {
    const hardToolCallCeiling = readingCapacity(input.maxLeases);
    if (hardToolCallCeiling <= 0) reject();
    return { hardToolCallCeiling, maxLeases: input.maxLeases };
  }
  let selected: { hardToolCallCeiling: number; maxLeases: number } | undefined;
  const leaseCandidates = Array.from(
    { length: Math.min(EXECUTION_LEASE_DEFAULTS.maxLeases, input.maxProviderTurns - 1) },
    (_, index) => index + 1,
  );
  for (const maxLeases of leaseCandidates) {
    const hardToolCallCeiling = Math.min(
      EXECUTION_LEASE_DEFAULTS.hardToolCallCeiling,
      input.callsPerLease * maxLeases - input.answerRecordCallCeiling,
      input.maxProviderTurns - maxLeases,
    );
    if (
      hardToolCallCeiling > 0 &&
      (!selected || hardToolCallCeiling > selected.hardToolCallCeiling)
    ) {
      selected = { hardToolCallCeiling, maxLeases };
    }
  }
  if (!selected) reject();
  return selected;
}

export function createExecutionLeaseCoordinatorPolicy(
  input: ExecutionLeaseCoordinatorPolicyInputV1,
): ExecutionLeasePolicyV1 {
  inert(input);
  exact(
    input,
    [
      "maxCompactions",
      "cumulative",
      "providerLimits",
      "answerRecordCallCeiling",
      "sharedToolCallCapacity",
      "workflowOverrides",
      "operatorOverrides",
      "compositionOverrides",
    ],
    [
      "answerRecordCallCeiling",
      "sharedToolCallCapacity",
      "workflowOverrides",
      "operatorOverrides",
      "compositionOverrides",
    ],
  );
  exact(input.providerLimits, ["maxProviderTurns", "maxCompactions"]);
  const base: Required<Omit<ExecutionLeasePolicyOverrideV1, "cumulative">> & {
    cumulative: CreateExecutionLeasePolicyInput["cumulative"];
  } = {
    // Derived, never re-listed: `decodeOverride` clamps every override against
    // this base, so a hardcoded copy of the defaults silently caps the system at
    // the smaller of the two. Small-turn fixtures would not catch that.
    ...(input.sharedToolCallCapacity === true
      ? {
          callsPerLease: EXECUTION_LEASE_DEFAULTS.callsPerLease,
          maxLeases: EXECUTION_LEASE_DEFAULTS.maxLeases,
          hardToolCallCeiling: EXECUTION_LEASE_DEFAULTS.hardToolCallCeiling,
        }
      : resolveLeaseShapeForTurns(
          EXECUTION_LEASE_DEFAULTS,
          Math.min(
            EXECUTION_LEASE_DEFAULTS.maxProviderTurns,
            positive(input.providerLimits.maxProviderTurns),
          ),
        )),
    maxProviderTurns: Math.min(
      EXECUTION_LEASE_DEFAULTS.maxProviderTurns,
      positive(input.providerLimits.maxProviderTurns),
    ),
    maxCompactions: Math.min(
      nonnegative(input.maxCompactions),
      nonnegative(input.providerLimits.maxCompactions),
    ),
    cumulative: decodeCumulative(input.cumulative),
  };
  if (input.answerRecordCallCeiling !== undefined) {
    // Grouped records also consume lease slots, so allow the record-aware
    // fitting pass below to select up to the catalog maximum after overrides
    // and the plan-derived ceiling are known.
    base.callsPerLease = EXECUTION_LEASE_DEFAULTS.callsPerLease;
    base.maxLeases = EXECUTION_LEASE_DEFAULTS.maxLeases;
  }
  const workflow = decodeOverride(input.workflowOverrides, base);
  const operator = decodeOverride(input.operatorOverrides, base);
  const choose = (field: keyof Omit<ExecutionLeasePolicyOverrideV1, "cumulative">): number =>
    Math.min(base[field], workflow[field] ?? base[field], operator[field] ?? base[field]);
  let hardToolCallCeiling = choose("hardToolCallCeiling");
  let maxLeases = choose("maxLeases");
  // A composition raises from the shape-resolved base, not the compiled default:
  // under a scarce turn budget the base shrinks below the compiled
  // `callsPerLease`, which would then exceed this run's own ceiling.
  const compositionCalls = resolveCompositionBoundCallsPerLease({
    ...(input.compositionOverrides === undefined
      ? {}
      : { composition: input.compositionOverrides }),
    baseCallsPerLease: base.callsPerLease,
    hardToolCallCeiling,
    maxLeases,
    ...(input.answerRecordCallCeiling === undefined
      ? {}
      : { answerRecordCallCeiling: input.answerRecordCallCeiling }),
    ...(input.sharedToolCallCapacity === true ? { sharedToolCallCapacity: true as const } : {}),
  });
  const callsPerLease = Math.min(
    compositionCalls,
    workflow.callsPerLease ?? compositionCalls,
    operator.callsPerLease ?? compositionCalls,
  );
  if (input.sharedToolCallCapacity === true) {
    hardToolCallCeiling = Math.min(hardToolCallCeiling, callsPerLease * maxLeases);
  }
  if (input.answerRecordCallCeiling !== undefined && input.sharedToolCallCapacity !== true) {
    const shape = resolveRecordModeLeaseShape({
      maxProviderTurns: choose("maxProviderTurns"),
      answerRecordCallCeiling: positive(input.answerRecordCallCeiling),
      callsPerLease,
      hardToolCallCeiling,
      maxLeases,
      hardToolCallCeilingIsOverride:
        workflow.hardToolCallCeiling !== undefined || operator.hardToolCallCeiling !== undefined,
      maxLeasesIsOverride: workflow.maxLeases !== undefined || operator.maxLeases !== undefined,
    });
    hardToolCallCeiling = shape.hardToolCallCeiling;
    maxLeases = shape.maxLeases;
  }
  const cumulative = {
    maxInputTokens: Math.min(
      base.cumulative.maxInputTokens,
      workflow.cumulative?.maxInputTokens ?? base.cumulative.maxInputTokens,
      operator.cumulative?.maxInputTokens ?? base.cumulative.maxInputTokens,
    ),
    maxOutputTokens: Math.min(
      base.cumulative.maxOutputTokens,
      workflow.cumulative?.maxOutputTokens ?? base.cumulative.maxOutputTokens,
      operator.cumulative?.maxOutputTokens ?? base.cumulative.maxOutputTokens,
    ),
    maxElapsedMs: Math.min(
      base.cumulative.maxElapsedMs,
      workflow.cumulative?.maxElapsedMs ?? base.cumulative.maxElapsedMs,
      operator.cumulative?.maxElapsedMs ?? base.cumulative.maxElapsedMs,
    ),
    ...knownCostCeiling(base.cumulative, workflow.cumulative, operator.cumulative),
  };
  return createExecutionLeasePolicy({
    callsPerLease,
    maxLeases,
    hardToolCallCeiling,
    ...(input.answerRecordCallCeiling === undefined
      ? {}
      : { answerRecordCallCeiling: input.answerRecordCallCeiling }),
    ...(input.sharedToolCallCapacity === true ? { sharedToolCallCapacity: true as const } : {}),
    maxProviderTurns: choose("maxProviderTurns"),
    maxCompactions: choose("maxCompactions"),
    cumulative,
  });
}

export function prepareExecutionLeaseCoordinator(input: {
  policy: AnyExecutionLeasePolicyV1OrV2;
  chargeableAttemptPolicy: AnyExecutionChargeableAttemptPolicy;
  identity: Omit<
    ExecutionLeaseIdentityV1,
    "schemaVersion" | "kind" | "policySha256" | "identitySha256"
  >;
  pricing: BoundExecutionPricingV1;
  context: ExecutionContextObservationV1;
}): { coordinator: ExecutionLeaseCoordinatorV1; decision: AnyExecutionCoordinatorDecision } {
  inert(input);
  exact(input, ["policy", "chargeableAttemptPolicy", "identity", "pricing", "context"]);
  exact(input.identity, [
    "inferenceAttempt",
    "retriesConsumed",
    "authorizationSha256",
    "repositoryRevision",
    "contextPacketSha256",
    "evidenceSha256",
    "toolPolicySha256",
    "contextAuthoritySha256",
  ]);
  const policy: AnyExecutionLeasePolicyV1OrV2 =
    input.policy.schemaVersion === 2
      ? decodeExecutionLeasePolicyV2(input.policy)
      : createExecutionLeasePolicy({
          callsPerLease: input.policy.callsPerLease,
          maxLeases: input.policy.maxLeases,
          hardToolCallCeiling: input.policy.hardToolCallCeiling,
          ...(input.policy.answerRecordCallCeiling === undefined
            ? {}
            : { answerRecordCallCeiling: input.policy.answerRecordCallCeiling }),
          ...(input.policy.sharedToolCallCapacity === true
            ? { sharedToolCallCapacity: true as const }
            : {}),
          maxProviderTurns: input.policy.maxProviderTurns,
          maxCompactions: input.policy.maxCompactions,
          cumulative: input.policy.cumulative,
        });
  if (policy.policySha256 !== input.policy.policySha256) reject();
  const chargeableAttemptPolicy =
    policy.schemaVersion === 2
      ? decodeAnyChargeableAttemptPolicy(input.chargeableAttemptPolicy)
      : decodeChargeableAttemptPolicy(
          input.chargeableAttemptPolicy as ExecutionChargeableAttemptPolicyV1,
          executionLeaseChargeableAttemptCeiling(policy),
        );
  if (policy.schemaVersion === 2 && chargeableAttemptPolicy.schemaVersion !== 2) reject();
  if (policy.schemaVersion === 1 && chargeableAttemptPolicy.schemaVersion !== 1) reject();
  const identity = createExecutionLeaseIdentity({
    ...input.identity,
    policySha256: policy.policySha256,
  });
  const pricing = decodePricing(input.pricing);
  const context = decodeContext(input.context);
  if (identity.contextAuthoritySha256 !== context.authoritySha256) reject();
  const cost: ExecutionCostStateV1 =
    pricing.status === "known"
      ? { status: "known", microusd: 0 }
      : { status: "unavailable", reason: pricing.reason };
  const initialState = createExecutionLeaseState(
    {
      leaseNumber: 1,
      leaseExecutedToolCalls: 0,
      ...(policy.schemaVersion === 2
        ? {
            leaseToolCallAllowance: policy.callsPerLease,
            leaseExecutedAnswerRecordCalls: 0,
            leaseAdmittedAnswerRecordCalls: 0,
            toolCallsByScope: { reading: 0, answerRecord: 0 },
            answerRecordCallsAdmitted: 0,
          }
        : policy.answerRecordCallCeiling === undefined
          ? {}
          : {
              leaseToolCallAllowance: Math.min(
                policy.callsPerLease,
                executionLeaseChargeableAttemptCeiling(policy),
              ),
              leaseExecutedAnswerRecordCalls: 0,
              leaseAdmittedAnswerRecordCalls: 0,
              toolCallsByScope: { reading: 0, answerRecord: 0 },
              answerRecordCallsAdmitted: 0,
            }),
      providerTurns: 0,
      compactions: 0,
      toolCalls: zeroCounters(),
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      elapsedMs: 0,
      cost,
      lastCheckpointSha256: null,
    },
    policy,
  );
  const initialChargeableAttemptState = createChargeableAttemptState(
    {
      chargeableAttempts: 0,
      lastCheckpointSha256: null,
    },
    chargeableAttemptPolicy,
  );
  const initialReason =
    policy.schemaVersion === 1 &&
    policy.cumulative.maxKnownCostMicrousd !== undefined &&
    pricing.status === "unavailable"
      ? ("cost-unavailable" as const)
      : context.status === "exhausted" || context.availableInputTokens < context.requiredInputTokens
        ? ("context-exhausted" as const)
        : undefined;
  const coordinator = sealCoordinator({
    schemaVersion: 1,
    kind: "docsfab-execution-lease-coordinator",
    policy,
    identity,
    initialState,
    state: initialState,
    checkpoints: [],
    decisions: [],
    chargeableAttemptPolicy,
    initialChargeableAttemptState,
    chargeableAttemptState: initialChargeableAttemptState,
    coordinatorCheckpoints: [],
    phase: initialReason ? "terminal" : "active",
    pricing,
    context,
    lastObservation: null,
    ...(initialReason ? { terminalReason: initialReason } : {}),
  });
  return {
    coordinator,
    decision: decisionEvidence(null, coordinator, initialReason ? "terminal" : "grant", {
      ...(initialReason ? { reason: initialReason } : {}),
    }),
  };
}

export function reduceExecutionLeaseCoordinator(input: {
  coordinator: ExecutionLeaseCoordinatorV1;
  expectedCoordinatorSha256: string;
  command: ExecutionCoordinatorCommandV1;
}): { coordinator: ExecutionLeaseCoordinatorV1; decision: AnyExecutionCoordinatorDecision } {
  inert(input);
  exact(input, ["coordinator", "expectedCoordinatorSha256", "command"]);
  const coordinator = validateCoordinator(input.coordinator);
  if (
    input.expectedCoordinatorSha256 !== coordinator.coordinatorSha256 ||
    coordinator.phase === "terminal"
  )
    reject();
  validateCommand(input.command);
  switch (input.command.kind) {
    case "observe-provider-turn":
      return observe(coordinator, input.command.observation);
    case "observe-checkpoint-turn":
      return observeCheckpointTurn(coordinator, input.command.observation);
    case "request-tool-batch":
      return requestBatch(coordinator, input.command.calls, input.command.envelope);
    case "settle-tool-batch":
      return settleBatch(coordinator, input.command.results, input.command.observation);
    case "fail-tool-batch":
      return failBatch(
        coordinator,
        input.command.results,
        input.command.observation,
        input.command.reason,
        input.command.lateDeniedCallSha256,
      );
    case "renew":
      return renew(coordinator, input.command.nextTranche);
    case "complete":
      return terminate(coordinator, "completed");
    case "stop":
      return terminate(coordinator, input.command.reason);
  }
}

export function serializeExecutionCoordinatorDecision(
  decision: AnyExecutionCoordinatorDecision,
): string {
  inert(decision);
  const validated = validateCoordinatorDecision(decision);
  return canonicalizeJsonEvidence(validated as unknown as JsonEvidenceValue);
}

function observe(
  coordinator: ExecutionLeaseCoordinatorV1,
  observationValue: ExecutionProgressObservationV1,
): { coordinator: ExecutionLeaseCoordinatorV1; decision: AnyExecutionCoordinatorDecision } {
  if (coordinator.phase !== "active") reject();
  const observation = decodeObservation(
    observationValue,
    coordinator.identity.contextAuthoritySha256,
  );
  const replay = coordinator.lastObservation;
  if (replay && observation.sequence === replay.sequence) {
    if (observation.observationSha256 !== replay.observationSha256) reject();
    return transition(coordinator, coordinator, "grant");
  }
  if (observation.sequence !== (replay?.sequence ?? 0) + 1) reject();
  const state = stateFromProgress(coordinator, coordinator.state, observation);
  return afterProgress(coordinator, state, observation, coordinator.chargeableAttemptState);
}

/**
 * Account for the schema-constrained, tool-free provider turn used to produce
 * a renewal checkpoint. The turn consumes the same cumulative authority as an
 * ordinary provider turn, but it cannot alter tool accounting or make the
 * coordinator active. Renewal remains a separate host-owned transition.
 */
function observeCheckpointTurn(
  coordinator: ExecutionLeaseCoordinatorV1,
  observationValue: ExecutionProgressObservationV1,
): { coordinator: ExecutionLeaseCoordinatorV1; decision: AnyExecutionCoordinatorDecision } {
  if (
    coordinator.phase !== "checkpoint-required" ||
    coordinator.pendingBatch ||
    !coordinator.checkpointRequest
  )
    reject();
  const observation = decodeObservation(
    observationValue,
    coordinator.identity.contextAuthoritySha256,
  );
  if (observation.sequence !== (coordinator.lastObservation?.sequence ?? 0) + 1) reject();
  const state = stateFromProgress(coordinator, coordinator.state, observation);
  const reasons = uniqueReasons([
    ...coordinator.checkpointRequest.stopReasons,
    ...stateStopReasons(
      coordinator,
      state,
      observation.context,
      coordinator.chargeableAttemptState,
    ),
  ]);
  const next = sealCoordinator({
    ...coordinatorCore(coordinator),
    state,
    context: observation.context,
    lastObservation: observation,
    phase: "checkpoint-required",
    checkpointRequest: {
      ...coordinator.checkpointRequest,
      stopReasons: reasons,
      observationSha256: observation.observationSha256,
    },
  });
  return transition(coordinator, next, "checkpoint-required", {
    ...(reasons[0] ? { reason: reasons[0] } : {}),
  });
}

function requestBatch(
  coordinator: ExecutionLeaseCoordinatorV1,
  calls: ExecutionToolBatchCallV1[],
  envelopeValue: ExecutionResourceEnvelopeV1,
): { coordinator: ExecutionLeaseCoordinatorV1; decision: AnyExecutionCoordinatorDecision } {
  if (coordinator.phase !== "active" || calls.length === 0) reject();
  const envelope = decodeEnvelope(envelopeValue);
  for (const call of calls) {
    exact(call, ["callSha256", "authorization", "scope"], ["scope"]);
    digest(call.callSha256);
    if (call.authorization !== "execute" && call.authorization !== "denied") reject();
    if (
      (call.scope !== undefined && call.scope !== "reading" && call.scope !== "answer-record") ||
      (coordinator.policy.schemaVersion === 2 && call.scope === undefined) ||
      (coordinator.policy.schemaVersion === 1 &&
        coordinator.policy.answerRecordCallCeiling !== undefined &&
        call.scope === undefined) ||
      (coordinator.policy.schemaVersion === 1 &&
        coordinator.policy.answerRecordCallCeiling === undefined &&
        call.scope === "answer-record")
    )
      reject();
  }
  const executableRequested = calls.filter((call) => call.authorization === "execute").length;
  if (envelope.toolCalls !== executableRequested) reject();
  if (executableRequested > 0) requireExecutableEnvelope(envelope);
  else if (
    envelope.providerTurns !== 0 ||
    envelope.inputTokens !== 0 ||
    envelope.compactions !== 0 ||
    envelope.outputTokens !== 0 ||
    envelope.elapsedMs !== 0 ||
    envelope.contextInputTokens !== 0
  )
    reject();
  const remaining = remainingLeaseCalls(coordinator);
  let chargeableRemaining = remainingChargeableAttempts(coordinator);
  const authorized: string[] = [];
  const authorizedScopes: ExecutionToolCallScopeV1[] = [];
  let readingAllowance = Math.max(
    0,
    coordinator.policy.schemaVersion === 2
      ? remaining
      : coordinator.policy.hardToolCallCeiling - readingToolCallsExecuted(coordinator.state),
  );
  let recordAllowance = Math.max(
    0,
    coordinator.policy.schemaVersion === 2
      ? remaining
      : (coordinator.policy.answerRecordCallCeiling ?? 0) -
          answerRecordToolCallsAdmitted(coordinator.state),
  );
  let denied = 0;
  let blocked = 0;
  let scopeBlocked = false;
  for (const call of calls) {
    if (chargeableRemaining === 0) {
      blocked += 1;
    } else if (call.authorization === "denied") {
      denied += 1;
      if (chargeableRemaining !== null) chargeableRemaining -= 1;
    } else if (authorized.length < remaining) {
      const scope = call.scope ?? "reading";
      const available = scope === "answer-record" ? recordAllowance : readingAllowance;
      if (scopeBlocked || available === 0) {
        blocked += 1;
        scopeBlocked = true;
      } else {
        authorized.push(call.callSha256);
        authorizedScopes.push(scope);
        if (scope === "answer-record") recordAllowance -= 1;
        else readingAllowance -= 1;
        if (chargeableRemaining !== null) chargeableRemaining -= 1;
      }
    } else {
      blocked += 1;
    }
  }
  const boundedEnvelope = freeze({ ...envelope, toolCalls: authorized.length });
  const preflightReasons =
    authorized.length === 0 ? [] : envelopeStopReasons(coordinator, boundedEnvelope);
  if (preflightReasons.length > 0) {
    const next = sealCoordinator({
      ...coordinatorCore(coordinator),
      phase: "checkpoint-required",
      checkpointRequest: {
        reason: "budget-boundary",
        stopReasons: preflightReasons,
        observationSha256:
          coordinator.lastObservation?.observationSha256 ?? coordinator.state.stateSha256,
        chargeableAttemptStateSha256: coordinator.chargeableAttemptState.stateSha256,
      },
    });
    return transition(coordinator, next, "checkpoint-required", {
      reason: preflightReasons[0],
    });
  }
  const grantedEnvelope: GrantedExecutionResourceEnvelopeV1 = freeze({
    ...boundedEnvelope,
    knownCostMicrousd:
      authorized.length === 0
        ? 0
        : coordinator.pricing.status === "known"
          ? costForTokens(coordinator.pricing, envelope.inputTokens, envelope.outputTokens)
          : // No monetary authority is represented when pricing is unavailable.
            // That is valid only when policy did not configure a known-cost ceiling;
            // the unavailable cost state remains explicit in coordinator evidence.
            0,
  });
  const projection = {
    calls,
    requestedEnvelope: envelope,
    grantedEnvelope,
    coordinatorSha256: coordinator.coordinatorSha256,
  };
  const pendingBatch: PendingExecutionBatchV1 = {
    batchSha256: hash(projection),
    requestedToolCalls: calls.length,
    authorizedCallSha256: authorized,
    ...(coordinator.policy.schemaVersion === 2 ||
    coordinator.policy.answerRecordCallCeiling !== undefined
      ? { authorizedCallScopes: authorizedScopes }
      : {}),
    deniedToolCalls: denied,
    governanceBlockedToolCalls: blocked,
    grantedEnvelope,
  };
  if (authorized.length === 0) {
    const state = applyToolAccounting(coordinator, denied, blocked, coordinator.state);
    const chargeableAttemptState = advanceChargeableAttempts(
      coordinator,
      denied,
      coordinator.chargeableAttemptState,
    );
    return afterAccountingWithoutProgress(coordinator, state, chargeableAttemptState, pendingBatch);
  }
  const next = sealCoordinator({
    ...coordinatorCore(coordinator),
    phase: "batch-pending",
    pendingBatch,
  });
  return transition(coordinator, next, "grant", {
    authorizedToolCalls: authorized.length,
    deniedToolCalls: denied,
    governanceBlockedToolCalls: blocked,
    grantedEnvelope,
    batchSha256: pendingBatch.batchSha256,
  });
}

function settleBatch(
  coordinator: ExecutionLeaseCoordinatorV1,
  results: ExecutionToolBatchResultV1[],
  observationValue: ExecutionProgressObservationV1,
): { coordinator: ExecutionLeaseCoordinatorV1; decision: AnyExecutionCoordinatorDecision } {
  if (coordinator.phase !== "batch-pending" || !coordinator.pendingBatch) reject();
  const pending = coordinator.pendingBatch;
  if (results.length !== pending.authorizedCallSha256.length) reject();
  let succeeded = 0;
  let failed = 0;
  results.forEach((result, index) => {
    inert(result);
    exact(result, ["callSha256", "outcome"]);
    if (result.callSha256 !== pending.authorizedCallSha256[index]) reject();
    if (result.outcome === "succeeded") succeeded += 1;
    else if (result.outcome === "failed") failed += 1;
    else reject();
  });
  const observation = decodeObservation(
    observationValue,
    coordinator.identity.contextAuthoritySha256,
  );
  if (observation.sequence !== (coordinator.lastObservation?.sequence ?? 0) + 1) reject();
  assertObservationWithinGrant(coordinator, observation, pending.grantedEnvelope);
  const additions = {
    requested: pending.requestedToolCalls,
    executed: results.length,
    succeeded,
    failed,
    denied: pending.deniedToolCalls,
    governanceBlocked: pending.governanceBlockedToolCalls,
    ...(pending.authorizedCallScopes === undefined
      ? {}
      : {
          answerRecordCalls: pending.authorizedCallScopes
            .slice(0, results.length)
            .filter((scope) => scope === "answer-record").length,
          admittedAnswerRecordCalls: pending.authorizedCallScopes.filter(
            (scope) => scope === "answer-record",
          ).length,
        }),
  };
  const accounted = applyToolAccounting(
    coordinator,
    pending.deniedToolCalls,
    pending.governanceBlockedToolCalls,
    coordinator.state,
    additions,
  );
  const state = stateFromProgress(coordinator, accounted, observation);
  const chargeableAttemptState = advanceChargeableAttempts(
    coordinator,
    results.length + pending.deniedToolCalls,
    coordinator.chargeableAttemptState,
  );
  return afterProgress(coordinator, state, observation, chargeableAttemptState, pending);
}

function failBatch(
  coordinator: ExecutionLeaseCoordinatorV1,
  results: ExecutionToolBatchResultV1[],
  observationValue: ExecutionProgressObservationV1,
  reason: ExecutionTerminalReason,
  lateDeniedCallSha256?: string,
): { coordinator: ExecutionLeaseCoordinatorV1; decision: AnyExecutionCoordinatorDecision } {
  if (coordinator.phase !== "batch-pending" || !coordinator.pendingBatch || reason === "completed")
    reject();
  const pending = coordinator.pendingBatch;
  if (results.length > pending.authorizedCallSha256.length) reject();
  let succeeded = 0;
  let failed = 0;
  results.forEach((result, index) => {
    inert(result);
    exact(result, ["callSha256", "outcome"]);
    if (result.callSha256 !== pending.authorizedCallSha256[index]) reject();
    if (result.outcome === "succeeded") succeeded += 1;
    else if (result.outcome === "failed") failed += 1;
    else reject();
  });
  const lateDenied = lateDeniedCallSha256 === undefined ? 0 : 1;
  if (
    lateDeniedCallSha256 !== undefined &&
    lateDeniedCallSha256 !== pending.authorizedCallSha256[results.length]
  )
    reject();
  const observation = decodeObservation(
    observationValue,
    coordinator.identity.contextAuthoritySha256,
  );
  if (observation.sequence !== (coordinator.lastObservation?.sequence ?? 0) + 1) reject();
  assertObservationWithinGrant(coordinator, observation, pending.grantedEnvelope);
  const missing = pending.authorizedCallSha256.length - results.length - lateDenied;
  const additions = {
    requested: pending.requestedToolCalls,
    executed: results.length,
    succeeded,
    failed,
    denied: pending.deniedToolCalls + lateDenied,
    governanceBlocked: pending.governanceBlockedToolCalls + missing,
    ...(pending.authorizedCallScopes === undefined
      ? {}
      : {
          answerRecordCalls: pending.authorizedCallScopes
            .slice(0, results.length)
            .filter((scope) => scope === "answer-record").length,
          admittedAnswerRecordCalls: pending.authorizedCallScopes.filter(
            (scope) => scope === "answer-record",
          ).length,
        }),
  };
  const accounted = applyToolAccounting(
    coordinator,
    pending.deniedToolCalls + lateDenied,
    pending.governanceBlockedToolCalls + missing,
    coordinator.state,
    additions,
  );
  const state = stateFromProgress(coordinator, accounted, observation);
  const chargeableAttemptState = advanceChargeableAttempts(
    coordinator,
    results.length + pending.deniedToolCalls + lateDenied,
    coordinator.chargeableAttemptState,
  );
  const next = sealCoordinator({
    ...coordinatorCore(coordinator),
    state,
    chargeableAttemptState,
    context: observation.context,
    lastObservation: observation,
    phase: "terminal",
    terminalReason: reason,
  });
  return transition(coordinator, next, "terminal", {
    authorizedToolCalls: results.length,
    deniedToolCalls: pending.deniedToolCalls + lateDenied,
    governanceBlockedToolCalls: pending.governanceBlockedToolCalls + missing,
    grantedEnvelope:
      results.length > 0 ? { ...pending.grantedEnvelope, toolCalls: results.length } : undefined,
    batchSha256: pending.batchSha256,
    reason,
  });
}

function afterProgress(
  coordinator: ExecutionLeaseCoordinatorV1,
  state: ExecutionLeaseStateV1,
  observation: ExecutionProgressObservationV1,
  chargeableAttemptState: ExecutionChargeableAttemptStateV1,
  pending?: PendingExecutionBatchV1,
): { coordinator: ExecutionLeaseCoordinatorV1; decision: AnyExecutionCoordinatorDecision } {
  const reasons = stateStopReasons(coordinator, state, observation.context, chargeableAttemptState);
  const exhausted =
    leaseToolCallsCharged(coordinator.policy, state) === activeAllowance(coordinator);
  const needsCheckpoint = exhausted || reasons.length > 0;
  const next = sealCoordinator({
    ...coordinatorCore(coordinator),
    state,
    chargeableAttemptState,
    context: observation.context,
    lastObservation: observation,
    phase: needsCheckpoint ? "checkpoint-required" : "active",
    ...(needsCheckpoint
      ? {
          checkpointRequest: {
            reason: exhausted ? "lease-exhausted" : "budget-boundary",
            stopReasons: reasons,
            observationSha256: observation.observationSha256,
            chargeableAttemptStateSha256: chargeableAttemptState.stateSha256,
          } as CheckpointRequestV1,
        }
      : {}),
  });
  return transition(coordinator, next, needsCheckpoint ? "checkpoint-required" : "grant", {
    ...(pending
      ? {
          authorizedToolCalls: pending.authorizedCallSha256.length,
          deniedToolCalls: pending.deniedToolCalls,
          governanceBlockedToolCalls: pending.governanceBlockedToolCalls,
          grantedEnvelope: pending.grantedEnvelope,
          batchSha256: pending.batchSha256,
        }
      : {}),
    ...(reasons[0] ? { reason: reasons[0] } : {}),
  });
}

function afterAccountingWithoutProgress(
  coordinator: ExecutionLeaseCoordinatorV1,
  state: ExecutionLeaseStateV1,
  chargeableAttemptState: ExecutionChargeableAttemptStateV1,
  batch: PendingExecutionBatchV1,
): { coordinator: ExecutionLeaseCoordinatorV1; decision: AnyExecutionCoordinatorDecision } {
  const reasons = stateStopReasons(coordinator, state, coordinator.context, chargeableAttemptState);
  const needsCheckpoint = reasons.length > 0;
  const next = sealCoordinator({
    ...coordinatorCore(coordinator),
    state,
    chargeableAttemptState,
    phase: needsCheckpoint ? "checkpoint-required" : "active",
    ...(needsCheckpoint
      ? {
          checkpointRequest: {
            reason: "budget-boundary" as const,
            stopReasons: reasons,
            observationSha256: coordinator.lastObservation?.observationSha256 ?? state.stateSha256,
            chargeableAttemptStateSha256: chargeableAttemptState.stateSha256,
          },
        }
      : {}),
  });
  return transition(coordinator, next, needsCheckpoint ? "checkpoint-required" : "grant", {
    deniedToolCalls: batch.deniedToolCalls,
    governanceBlockedToolCalls: batch.governanceBlockedToolCalls,
    batchSha256: batch.batchSha256,
    ...(reasons[0] ? { reason: reasons[0] } : {}),
  });
}

function assertObservationWithinGrant(
  coordinator: ExecutionLeaseCoordinatorV1,
  observation: ExecutionProgressObservationV1,
  grant: GrantedExecutionResourceEnvelopeV1,
): void {
  const deltas = {
    providerTurns: observation.providerTurns - coordinator.state.providerTurns,
    compactions: observation.compactions - coordinator.state.compactions,
    inputTokens: observation.cumulativeInputTokens - coordinator.state.cumulativeInputTokens,
    outputTokens: observation.cumulativeOutputTokens - coordinator.state.cumulativeOutputTokens,
    elapsedMs: observation.elapsedMs - coordinator.state.elapsedMs,
    contextInputTokens: Math.max(
      0,
      coordinator.context.availableInputTokens - observation.context.availableInputTokens,
    ),
  };
  if (coordinator.policy.schemaVersion === 2) {
    if (
      deltas.contextInputTokens > grant.contextInputTokens ||
      (observation.context.availableInputTokens > coordinator.context.availableInputTokens &&
        deltas.compactions === 0) ||
      observation.context.requiredInputTokens > grant.contextInputTokens
    )
      reject();
    return;
  }
  if (
    Object.values(deltas).some((value) => value < 0) ||
    deltas.providerTurns > grant.providerTurns ||
    deltas.compactions > grant.compactions ||
    deltas.inputTokens > grant.inputTokens ||
    deltas.outputTokens > grant.outputTokens ||
    deltas.elapsedMs > grant.elapsedMs ||
    deltas.contextInputTokens > grant.contextInputTokens ||
    (observation.context.availableInputTokens > coordinator.context.availableInputTokens &&
      deltas.compactions === 0) ||
    observation.context.requiredInputTokens > grant.contextInputTokens
  )
    reject();
  if (coordinator.pricing.status === "unavailable") {
    if (
      (coordinator.policy.schemaVersion === 1 &&
        coordinator.policy.cumulative.maxKnownCostMicrousd !== undefined) ||
      coordinator.state.cost.status !== "unavailable" ||
      grant.knownCostMicrousd !== 0
    )
      reject();
    return;
  }
  if (coordinator.state.cost.status !== "known") reject();
  const grantedCost = costForTokens(coordinator.pricing, grant.inputTokens, grant.outputTokens);
  const observedCost = costForTokens(
    coordinator.pricing,
    observation.cumulativeInputTokens,
    observation.cumulativeOutputTokens,
  );
  if (
    grant.knownCostMicrousd !== grantedCost ||
    observedCost - coordinator.state.cost.microusd < 0 ||
    observedCost - coordinator.state.cost.microusd > grant.knownCostMicrousd
  )
    reject();
}

function renew(
  coordinator: ExecutionLeaseCoordinatorV1,
  envelopeValue: ExecutionResourceEnvelopeV1,
): { coordinator: ExecutionLeaseCoordinatorV1; decision: AnyExecutionCoordinatorDecision } {
  if (
    coordinator.phase !== "checkpoint-required" ||
    coordinator.pendingBatch ||
    !coordinator.checkpointRequest
  )
    reject();
  const checkpoint = createExecutionCheckpoint({
    policy: coordinator.policy,
    identity: coordinator.identity,
    state: coordinator.state,
    reason: coordinator.checkpointRequest.reason,
    ...(coordinator.checkpoints.length > 0 ? { previous: coordinator.checkpoints.at(-1)! } : {}),
  });
  const coordinatorCheckpoint = createCoordinatorCheckpoint(coordinator, checkpoint);
  const checkpointedChargeableAttemptState = createChargeableAttemptState(
    {
      chargeableAttempts: coordinator.chargeableAttemptState.chargeableAttempts,
      lastCheckpointSha256: coordinatorCheckpoint.checkpointSha256,
    },
    coordinator.chargeableAttemptPolicy,
    coordinator.chargeableAttemptState,
  );
  const nextTranche = decodeEnvelope(envelopeValue);
  requireRenewalEnvelope(nextTranche, coordinator.policy);
  const stopReasons = uniqueReasons([
    ...coordinator.checkpointRequest.stopReasons,
    ...envelopeStopReasons(coordinator, nextTranche),
  ]);
  const decision = decideExecutionLeaseRenewal({
    policy: coordinator.policy,
    identity: coordinator.identity,
    checkpoint,
    stopReasons,
    ...(coordinator.checkpoints.length > 0
      ? { history: { checkpoints: coordinator.checkpoints, decisions: coordinator.decisions } }
      : {}),
  });
  if (decision.decision === "granted" && decision.grantedToolCalls !== nextTranche.toolCalls) {
    reject();
  }
  if (decision.decision === "denied") {
    const finalState = createExecutionLeaseState(
      {
        ...stateInput(coordinator.state),
        lastCheckpointSha256: checkpoint.checkpointSha256,
      },
      coordinator.policy,
      checkpoint.state,
    );
    const next = sealCoordinator({
      ...coordinatorCore(coordinator),
      state: finalState,
      chargeableAttemptState: checkpointedChargeableAttemptState,
      checkpoints: [...coordinator.checkpoints, checkpoint],
      coordinatorCheckpoints: [...coordinator.coordinatorCheckpoints, coordinatorCheckpoint],
      decisions: [...coordinator.decisions, decision],
      phase: "terminal",
      terminalReason: decision.reason,
    });
    return transition(coordinator, next, "denied", { reason: decision.reason });
  }
  const state = createExecutionLeaseState(
    {
      ...stateInput(coordinator.state),
      leaseNumber: decision.leaseNumber,
      leaseExecutedToolCalls: 0,
      ...(coordinator.policy.schemaVersion === 2
        ? {
            leaseToolCallAllowance: decision.grantedToolCalls,
            leaseExecutedAnswerRecordCalls: 0,
            leaseAdmittedAnswerRecordCalls: 0,
          }
        : coordinator.policy.answerRecordCallCeiling !== undefined
          ? {
              leaseToolCallAllowance: decision.grantedToolCalls,
              leaseExecutedAnswerRecordCalls: 0,
              leaseAdmittedAnswerRecordCalls: 0,
            }
          : {}),
      lastCheckpointSha256: checkpoint.checkpointSha256,
    },
    coordinator.policy,
    checkpoint.state,
  );
  const next = sealCoordinator({
    ...coordinatorCore(coordinator),
    state,
    chargeableAttemptState: checkpointedChargeableAttemptState,
    checkpoints: [...coordinator.checkpoints, checkpoint],
    coordinatorCheckpoints: [...coordinator.coordinatorCheckpoints, coordinatorCheckpoint],
    decisions: [...coordinator.decisions, decision],
    phase: "active",
  });
  return transition(coordinator, next, "renewed");
}

function terminate(
  coordinator: ExecutionLeaseCoordinatorV1,
  reason: ExecutionTerminalReason,
): { coordinator: ExecutionLeaseCoordinatorV1; decision: AnyExecutionCoordinatorDecision } {
  if (coordinator.phase === "batch-pending") reject();
  const checkpoint = createExecutionCheckpoint({
    policy: coordinator.policy,
    identity: coordinator.identity,
    state: coordinator.state,
    reason: reason === "completed" ? "workflow-completed" : "host-requested",
    ...(coordinator.checkpoints.length > 0 ? { previous: coordinator.checkpoints.at(-1)! } : {}),
  });
  const coordinatorCheckpoint = createCoordinatorCheckpoint(coordinator, checkpoint);
  const checkpointedChargeableAttemptState = createChargeableAttemptState(
    {
      chargeableAttempts: coordinator.chargeableAttemptState.chargeableAttempts,
      lastCheckpointSha256: coordinatorCheckpoint.checkpointSha256,
    },
    coordinator.chargeableAttemptPolicy,
    coordinator.chargeableAttemptState,
  );
  const state = createExecutionLeaseState(
    {
      ...stateInput(coordinator.state),
      lastCheckpointSha256: checkpoint.checkpointSha256,
    },
    coordinator.policy,
    checkpoint.state,
  );
  const next = sealCoordinator({
    ...coordinatorCore(coordinator),
    state,
    chargeableAttemptState: checkpointedChargeableAttemptState,
    checkpoints: [...coordinator.checkpoints, checkpoint],
    coordinatorCheckpoints: [...coordinator.coordinatorCheckpoints, coordinatorCheckpoint],
    phase: "terminal",
    terminalReason: reason,
  });
  return transition(coordinator, next, "terminal", { reason });
}

function applyToolAccounting(
  coordinator: ExecutionLeaseCoordinatorV1,
  denied: number,
  blocked: number,
  previous: ExecutionLeaseStateV1,
  additions?: {
    requested: number;
    executed: number;
    succeeded: number;
    failed: number;
    denied: number;
    governanceBlocked: number;
    answerRecordCalls?: number;
    admittedAnswerRecordCalls?: number;
  },
): ExecutionLeaseStateV1 {
  const executed = additions?.executed ?? 0;
  const succeeded = additions?.succeeded ?? 0;
  const failed = additions?.failed ?? 0;
  const requested = additions?.requested ?? denied + blocked;
  return createExecutionLeaseState(
    {
      ...stateInput(previous),
      leaseExecutedToolCalls: previous.leaseExecutedToolCalls + executed,
      ...(coordinator.policy.schemaVersion === 2 ||
      coordinator.policy.answerRecordCallCeiling !== undefined
        ? {
            leaseExecutedAnswerRecordCalls:
              (previous.leaseExecutedAnswerRecordCalls ?? 0) + (additions?.answerRecordCalls ?? 0),
            leaseAdmittedAnswerRecordCalls:
              (previous.leaseAdmittedAnswerRecordCalls ?? 0) +
              (additions?.admittedAnswerRecordCalls ?? 0),
            toolCallsByScope: {
              reading:
                (previous.toolCallsByScope?.reading ?? 0) +
                executed -
                (additions?.answerRecordCalls ?? 0),
              answerRecord:
                (previous.toolCallsByScope?.answerRecord ?? 0) +
                (additions?.answerRecordCalls ?? 0),
            },
            answerRecordCallsAdmitted:
              (previous.answerRecordCallsAdmitted ?? 0) +
              (additions?.admittedAnswerRecordCalls ?? 0),
          }
        : {}),
      toolCalls: {
        requested: previous.toolCalls.requested + requested,
        executed: previous.toolCalls.executed + executed,
        succeeded: previous.toolCalls.succeeded + succeeded,
        failed: previous.toolCalls.failed + failed,
        denied: previous.toolCalls.denied + denied,
        governanceBlocked: previous.toolCalls.governanceBlocked + blocked,
      },
    },
    coordinator.policy,
    previous,
  );
}

function stateFromProgress(
  coordinator: ExecutionLeaseCoordinatorV1,
  base: ExecutionLeaseStateV1,
  observation: ExecutionProgressObservationV1,
): ExecutionLeaseStateV1 {
  if (
    observation.providerTurns < base.providerTurns ||
    observation.compactions < base.compactions ||
    observation.cumulativeInputTokens < base.cumulativeInputTokens ||
    observation.cumulativeOutputTokens < base.cumulativeOutputTokens ||
    observation.elapsedMs < base.elapsedMs
  )
    reject();
  const cost = costAt(coordinator.pricing, observation);
  return createExecutionLeaseState(
    {
      ...stateInput(base),
      providerTurns: observation.providerTurns,
      compactions: observation.compactions,
      cumulativeInputTokens: observation.cumulativeInputTokens,
      cumulativeOutputTokens: observation.cumulativeOutputTokens,
      elapsedMs: observation.elapsedMs,
      cost,
    },
    coordinator.policy,
    base,
  );
}

function envelopeStopReasons(
  coordinator: ExecutionLeaseCoordinatorV1,
  envelope: ExecutionResourceEnvelopeV1,
): ExecutionStopReason[] {
  const { policy, state, context, pricing } = coordinator;
  const reasons: ExecutionStopReason[] = [];
  if (policy.schemaVersion === 1 && remainingScopedToolCalls(policy, state) < envelope.toolCalls) {
    reasons.push("hard-tool-call-ceiling");
  }
  if (
    remainingChargeableAttempts(coordinator) !== null &&
    remainingChargeableAttempts(coordinator)! < envelope.toolCalls
  ) {
    reasons.push("hard-tool-call-ceiling");
  }
  if (
    policy.schemaVersion === 1 &&
    policy.cumulative.maxInputTokens - state.cumulativeInputTokens < envelope.inputTokens
  ) {
    reasons.push("cumulative-input-limit");
  }
  if (
    policy.schemaVersion === 1 &&
    policy.cumulative.maxOutputTokens - state.cumulativeOutputTokens < envelope.outputTokens
  ) {
    reasons.push("cumulative-output-limit");
  }
  if (
    policy.schemaVersion === 1 &&
    policy.cumulative.maxElapsedMs - state.elapsedMs < envelope.elapsedMs
  ) {
    reasons.push("cumulative-time-limit");
  }
  if (
    policy.schemaVersion === 1 &&
    policy.maxCompactions - state.compactions < envelope.compactions
  ) {
    reasons.push("context-exhausted");
  }
  if (policy.schemaVersion === 1 && policy.cumulative.maxKnownCostMicrousd !== undefined) {
    if (pricing.status === "unavailable" || state.cost.status === "unavailable") {
      reasons.push("cost-unavailable");
    } else if (
      policy.cumulative.maxKnownCostMicrousd - state.cost.microusd <
      costForTokens(pricing, envelope.inputTokens, envelope.outputTokens)
    ) {
      reasons.push("cumulative-cost-limit");
    }
  }
  if (
    policy.schemaVersion === 1 &&
    policy.maxProviderTurns - state.providerTurns <= envelope.providerTurns
  ) {
    reasons.push("provider-turn-limit");
  }
  if (
    context.status === "exhausted" ||
    context.availableInputTokens < envelope.contextInputTokens
  ) {
    reasons.push("context-exhausted");
  }
  return uniqueReasons(reasons);
}

function stateStopReasons(
  coordinator: ExecutionLeaseCoordinatorV1,
  state: ExecutionLeaseStateV1,
  context: ExecutionContextObservationV1,
  chargeableAttemptState: ExecutionChargeableAttemptStateV1,
): ExecutionStopReason[] {
  const { policy } = coordinator;
  const reasons: ExecutionStopReason[] = [];
  if (
    (policy.schemaVersion === 1 && remainingScopedToolCalls(policy, state) === 0) ||
    (coordinator.chargeableAttemptPolicy.schemaVersion === 1 &&
      chargeableAttemptState.chargeableAttempts >=
        coordinator.chargeableAttemptPolicy.maxChargeableAttempts)
  ) {
    reasons.push("hard-tool-call-ceiling");
  }
  if (policy.schemaVersion === 1 && state.cumulativeInputTokens >= policy.cumulative.maxInputTokens)
    reasons.push("cumulative-input-limit");
  if (
    policy.schemaVersion === 1 &&
    state.cumulativeOutputTokens >= policy.cumulative.maxOutputTokens
  )
    reasons.push("cumulative-output-limit");
  if (policy.schemaVersion === 1 && state.elapsedMs >= policy.cumulative.maxElapsedMs)
    reasons.push("cumulative-time-limit");
  if (policy.schemaVersion === 1 && policy.cumulative.maxKnownCostMicrousd !== undefined) {
    if (state.cost.status === "unavailable") reasons.push("cost-unavailable");
    else if (state.cost.microusd >= policy.cumulative.maxKnownCostMicrousd) {
      reasons.push("cumulative-cost-limit");
    }
  }
  if (policy.schemaVersion === 1 && policy.maxProviderTurns - state.providerTurns <= 1)
    reasons.push("provider-turn-limit");
  if (context.status === "exhausted" || context.availableInputTokens < context.requiredInputTokens)
    reasons.push("context-exhausted");
  return uniqueReasons(reasons);
}

function transition(
  previous: ExecutionLeaseCoordinatorV1,
  next: ExecutionLeaseCoordinatorV1,
  decision: ExecutionCoordinatorDecisionV1["decision"],
  fields: Partial<
    Pick<
      ExecutionCoordinatorDecisionV1,
      | "authorizedToolCalls"
      | "deniedToolCalls"
      | "governanceBlockedToolCalls"
      | "grantedEnvelope"
      | "batchSha256"
      | "reason"
    >
  > = {},
): { coordinator: ExecutionLeaseCoordinatorV1; decision: AnyExecutionCoordinatorDecision } {
  return {
    coordinator: next,
    decision: decisionEvidence(previous.coordinatorSha256, next, decision, fields),
  };
}

function decisionEvidence(
  previousCoordinatorSha256: string | null,
  coordinator: ExecutionLeaseCoordinatorV1,
  decision: ExecutionCoordinatorDecisionV1["decision"],
  fields: Partial<
    Pick<
      ExecutionCoordinatorDecisionV1,
      | "authorizedToolCalls"
      | "deniedToolCalls"
      | "governanceBlockedToolCalls"
      | "grantedEnvelope"
      | "batchSha256"
      | "reason"
    >
  > = {},
): AnyExecutionCoordinatorDecision {
  const common = {
    kind: "docsfab-execution-coordinator-decision" as const,
    decision,
    previousCoordinatorSha256,
    coordinatorSha256: coordinator.coordinatorSha256,
    leaseNumber: coordinator.state.leaseNumber,
    remainingLeaseToolCalls: remainingLeaseCalls(coordinator),
    authorizedToolCalls: fields.authorizedToolCalls ?? 0,
    deniedToolCalls: fields.deniedToolCalls ?? 0,
    governanceBlockedToolCalls: fields.governanceBlockedToolCalls ?? 0,
    ...(fields.grantedEnvelope ? { grantedEnvelope: fields.grantedEnvelope } : {}),
    ...(fields.batchSha256 ? { batchSha256: fields.batchSha256 } : {}),
    ...(fields.reason ? { reason: fields.reason } : {}),
  };
  const remaining = remainingChargeableAttempts(coordinator);
  const body =
    remaining === null
      ? { schemaVersion: 2 as const, ...common }
      : { schemaVersion: 1 as const, ...common, remainingChargeableAttempts: remaining };
  return freeze({ ...body, decisionSha256: hash(body) });
}

function sealCoordinator(
  value: Omit<ExecutionLeaseCoordinatorV1, "coordinatorSha256">,
): ExecutionLeaseCoordinatorV1 {
  inert(value);
  const coordinator = freeze({ ...value, coordinatorSha256: hash(value) });
  return validateCoordinator(coordinator);
}

function remainingLeaseCalls(value: ExecutionLeaseCoordinatorV1): number {
  return Math.min(
    Math.max(0, activeAllowance(value) - leaseToolCallsCharged(value.policy, value.state)),
    remainingScopedToolCalls(value.policy, value.state),
  );
}

function activeAllowance(value: ExecutionLeaseCoordinatorV1): number {
  if (value.policy.schemaVersion === 2 || value.policy.answerRecordCallCeiling !== undefined) {
    return currentLeaseToolCallAllowance(value.policy, value.state);
  }
  if (value.state.leaseNumber === 1)
    return currentLeaseToolCallAllowance(value.policy, value.state);
  const grant = [...value.decisions]
    .reverse()
    .find(
      (decision) =>
        decision.decision === "granted" && decision.leaseNumber === value.state.leaseNumber,
    );
  if (!grant || grant.decision !== "granted") reject();
  return grant.grantedToolCalls;
}

function costAt(
  pricing: BoundExecutionPricingV1,
  observation: ExecutionProgressObservationV1,
): ExecutionCostStateV1 {
  if (pricing.status === "unavailable") return { status: "unavailable", reason: pricing.reason };
  return {
    status: "known",
    microusd: costForTokens(
      pricing,
      observation.cumulativeInputTokens,
      observation.cumulativeOutputTokens,
    ),
  };
}

function decodeOverride(
  value: ExecutionLeasePolicyOverrideV1 | undefined,
  base: Required<Omit<ExecutionLeasePolicyOverrideV1, "cumulative">> & {
    cumulative: CreateExecutionLeasePolicyInput["cumulative"];
  },
): ExecutionLeasePolicyOverrideV1 {
  if (value === undefined) return {};
  inert(value);
  exact(
    value,
    [
      "callsPerLease",
      "maxLeases",
      "hardToolCallCeiling",
      "maxProviderTurns",
      "maxCompactions",
      "cumulative",
    ],
    [
      "callsPerLease",
      "maxLeases",
      "hardToolCallCeiling",
      "maxProviderTurns",
      "maxCompactions",
      "cumulative",
    ],
  );
  const decoded: ExecutionLeasePolicyOverrideV1 = {};
  for (const field of [
    "callsPerLease",
    "maxLeases",
    "hardToolCallCeiling",
    "maxProviderTurns",
  ] as const) {
    if (value[field] !== undefined) {
      const candidate = positive(value[field]);
      if (candidate > base[field]) reject();
      decoded[field] = candidate;
    }
  }
  if (value.maxCompactions !== undefined) {
    const candidate = nonnegative(value.maxCompactions);
    if (candidate > base.maxCompactions) reject();
    decoded.maxCompactions = candidate;
  }
  if (value.cumulative) {
    exact(
      value.cumulative,
      ["maxInputTokens", "maxOutputTokens", "maxElapsedMs", "maxKnownCostMicrousd"],
      ["maxInputTokens", "maxOutputTokens", "maxElapsedMs", "maxKnownCostMicrousd"],
    );
    const cumulative: Partial<CreateExecutionLeasePolicyInput["cumulative"]> = {};
    for (const field of ["maxInputTokens", "maxOutputTokens", "maxElapsedMs"] as const) {
      if (value.cumulative[field] !== undefined) {
        const candidate = positive(value.cumulative[field]);
        if (candidate > base.cumulative[field]) reject();
        cumulative[field] = candidate;
      }
    }
    if (value.cumulative.maxKnownCostMicrousd !== undefined) {
      const candidate = positive(value.cumulative.maxKnownCostMicrousd);
      if (
        base.cumulative.maxKnownCostMicrousd !== undefined &&
        candidate > base.cumulative.maxKnownCostMicrousd
      )
        reject();
      cumulative.maxKnownCostMicrousd = candidate;
    }
    decoded.cumulative = cumulative;
  }
  return decoded;
}

function decodeCumulative(
  value: CreateExecutionLeasePolicyInput["cumulative"],
): CreateExecutionLeasePolicyInput["cumulative"] {
  inert(value);
  exact(
    value,
    ["maxInputTokens", "maxOutputTokens", "maxElapsedMs", "maxKnownCostMicrousd"],
    ["maxKnownCostMicrousd"],
  );
  return {
    maxInputTokens: positive(value.maxInputTokens),
    maxOutputTokens: positive(value.maxOutputTokens),
    maxElapsedMs: positive(value.maxElapsedMs),
    ...(value.maxKnownCostMicrousd === undefined
      ? {}
      : { maxKnownCostMicrousd: positive(value.maxKnownCostMicrousd) }),
  };
}

function knownCostCeiling(
  base: CreateExecutionLeasePolicyInput["cumulative"],
  workflow?: Partial<CreateExecutionLeasePolicyInput["cumulative"]>,
  operator?: Partial<CreateExecutionLeasePolicyInput["cumulative"]>,
): { maxKnownCostMicrousd?: number } {
  const values = [
    base.maxKnownCostMicrousd,
    workflow?.maxKnownCostMicrousd,
    operator?.maxKnownCostMicrousd,
  ].filter((value): value is number => value !== undefined);
  return values.length === 0 ? {} : { maxKnownCostMicrousd: Math.min(...values) };
}

function stateInput(
  state: ExecutionLeaseStateV1,
): Omit<ExecutionLeaseStateV1, "schemaVersion" | "kind" | "stateSha256"> {
  const { schemaVersion: _schemaVersion, kind: _kind, stateSha256: _digest, ...input } = state;
  return input;
}

function zeroCounters() {
  return { requested: 0, executed: 0, succeeded: 0, failed: 0, denied: 0, governanceBlocked: 0 };
}

function coordinatorCore(
  value: ExecutionLeaseCoordinatorV1,
): Omit<
  ExecutionLeaseCoordinatorV1,
  "coordinatorSha256" | "pendingBatch" | "checkpointRequest" | "terminalReason"
> {
  const {
    coordinatorSha256: _digest,
    pendingBatch: _pendingBatch,
    checkpointRequest: _checkpointRequest,
    terminalReason: _terminalReason,
    ...core
  } = value;
  return core;
}
