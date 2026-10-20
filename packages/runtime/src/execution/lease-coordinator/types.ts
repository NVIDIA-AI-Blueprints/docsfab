// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  CompositionBoundExecutionLeaseOverrideV1,
  CreateExecutionLeasePolicyInput,
  ExecutionCheckpointV1,
  ExecutionCostStateV1,
  ExecutionLeaseDecisionV1,
  ExecutionLeaseIdentityV1,
  ExecutionLeasePolicyV1,
  ExecutionLeasePolicyV2,
  AnyExecutionLeasePolicyV1OrV2,
  ExecutionLeaseStateV1,
  ExecutionStopReason,
  ExecutionToolCallScopeV1,
  ExecutionTerminalReason,
} from "../lease-contracts.js";

export interface ExecutionLeasePolicyOverrideV1 {
  callsPerLease?: number;
  maxLeases?: number;
  hardToolCallCeiling?: number;
  maxProviderTurns?: number;
  maxCompactions?: number;
  cumulative?: Partial<CreateExecutionLeasePolicyInput["cumulative"]>;
}

export interface ExecutionLeaseCoordinatorPolicyInputV1 {
  maxCompactions: number;
  cumulative: CreateExecutionLeasePolicyInput["cumulative"];
  providerLimits: { maxProviderTurns: number; maxCompactions: number };
  /** Host-derived from the active answer-record plan; never an override. */
  answerRecordCallCeiling?: number;
  /** Discovery-only shared aggregate pool for reading and answer-record calls. */
  sharedToolCallCapacity?: true;
  workflowOverrides?: ExecutionLeasePolicyOverrideV1;
  operatorOverrides?: ExecutionLeasePolicyOverrideV1;
  compositionOverrides?: CompositionBoundExecutionLeaseOverrideV1;
}

/** Renewable discovery scheduling policy: lease size is a checkpoint cadence. */
export interface ExecutionChargeableAttemptPolicyV1 {
  schemaVersion: 1;
  kind: "docsfab-execution-chargeable-attempt-policy";
  maxChargeableAttempts: number;
  policySha256: string;
}

export interface ExecutionChargeableAttemptPolicyV2 {
  schemaVersion: 2;
  kind: "docsfab-execution-chargeable-attempt-policy";
  aggregateLimit: { kind: "absent" };
  policySha256: string;
}

export type AnyExecutionChargeableAttemptPolicy =
  | ExecutionChargeableAttemptPolicyV1
  | ExecutionChargeableAttemptPolicyV2;

export interface ExecutionChargeableAttemptStateV1 {
  schemaVersion: 1;
  kind: "docsfab-execution-chargeable-attempt-state";
  chargeableAttempts: number;
  lastCheckpointSha256: string | null;
  policySha256: string;
  stateSha256: string;
}

export type BoundExecutionPricingV1 =
  | {
      status: "known";
      inputMicrousdPerMillionTokens: number;
      outputMicrousdPerMillionTokens: number;
      authoritySha256: string;
    }
  | {
      status: "unavailable";
      reason: "pricing-unknown" | "pricing-stale";
      authoritySha256: string;
    };

export interface ExecutionContextObservationV1 {
  status: "ready" | "exhausted";
  availableInputTokens: number;
  requiredInputTokens: number;
  authoritySha256: string;
}

export interface ExecutionProgressObservationV1 {
  schemaVersion: 1;
  kind: "docsfab-execution-progress-observation";
  sequence: number;
  providerTurns: number;
  compactions: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  elapsedMs: number;
  context: ExecutionContextObservationV1;
  observationSha256: string;
}

export interface ExecutionResourceEnvelopeV1 {
  toolCalls: number;
  providerTurns: number;
  compactions: number;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  contextInputTokens: number;
}

export interface GrantedExecutionResourceEnvelopeV1 extends ExecutionResourceEnvelopeV1 {
  knownCostMicrousd: number;
}

export interface ExecutionToolBatchCallV1 {
  callSha256: string;
  authorization: "execute" | "denied";
  /** Host-classified from the exposed tool name, never its arguments. */
  scope?: ExecutionToolCallScopeV1;
}

export interface ExecutionToolBatchResultV1 {
  callSha256: string;
  outcome: "succeeded" | "failed";
}

export interface PendingExecutionBatchV1 {
  batchSha256: string;
  requestedToolCalls: number;
  authorizedCallSha256: string[];
  authorizedCallScopes?: ExecutionToolCallScopeV1[];
  deniedToolCalls: number;
  governanceBlockedToolCalls: number;
  grantedEnvelope: GrantedExecutionResourceEnvelopeV1;
}

export interface CheckpointRequestV1 {
  reason: "lease-exhausted" | "budget-boundary";
  stopReasons: ExecutionStopReason[];
  observationSha256: string;
  chargeableAttemptStateSha256: string;
}

export interface ExecutionCoordinatorCheckpointV1 {
  schemaVersion: 1;
  kind: "docsfab-execution-coordinator-checkpoint";
  sequence: number;
  previousCheckpointSha256: string | null;
  leaseCheckpointSha256: string;
  chargeableAttemptState: ExecutionChargeableAttemptStateV1;
  chargeableAttemptPolicySha256: string;
  checkpointSha256: string;
}

export type ExecutionCoordinatorPhase =
  | "active"
  | "batch-pending"
  | "checkpoint-required"
  | "terminal";

export interface ExecutionLeaseCoordinatorV1 {
  schemaVersion: 1;
  kind: "docsfab-execution-lease-coordinator";
  policy: AnyExecutionLeasePolicyV1OrV2;
  identity: ExecutionLeaseIdentityV1;
  initialState: ExecutionLeaseStateV1;
  state: ExecutionLeaseStateV1;
  checkpoints: ExecutionCheckpointV1[];
  decisions: ExecutionLeaseDecisionV1[];
  chargeableAttemptPolicy: AnyExecutionChargeableAttemptPolicy;
  initialChargeableAttemptState: ExecutionChargeableAttemptStateV1;
  chargeableAttemptState: ExecutionChargeableAttemptStateV1;
  coordinatorCheckpoints: ExecutionCoordinatorCheckpointV1[];
  phase: ExecutionCoordinatorPhase;
  pricing: BoundExecutionPricingV1;
  context: ExecutionContextObservationV1;
  lastObservation: ExecutionProgressObservationV1 | null;
  pendingBatch?: PendingExecutionBatchV1;
  checkpointRequest?: CheckpointRequestV1;
  terminalReason?: ExecutionTerminalReason;
  coordinatorSha256: string;
}

export interface ExecutionCoordinatorDecisionFields {
  kind: "docsfab-execution-coordinator-decision";
  decision: "grant" | "checkpoint-required" | "renewed" | "denied" | "terminal";
  previousCoordinatorSha256: string | null;
  coordinatorSha256: string;
  leaseNumber: number;
  remainingLeaseToolCalls: number;
  remainingChargeableAttempts: number;
  authorizedToolCalls: number;
  deniedToolCalls: number;
  governanceBlockedToolCalls: number;
  grantedEnvelope?: GrantedExecutionResourceEnvelopeV1;
  batchSha256?: string;
  reason?: ExecutionTerminalReason;
  decisionSha256: string;
}

export interface ExecutionCoordinatorDecisionV1 extends ExecutionCoordinatorDecisionFields {
  schemaVersion: 1;
}

export interface ExecutionCoordinatorDecisionV2
  extends Omit<ExecutionCoordinatorDecisionV1, "schemaVersion" | "remainingChargeableAttempts"> {
  schemaVersion: 2;
}

export type AnyExecutionCoordinatorDecision =
  | ExecutionCoordinatorDecisionV1
  | ExecutionCoordinatorDecisionV2;

export type ExecutionCoordinatorCommandV1 =
  | { kind: "observe-provider-turn"; observation: ExecutionProgressObservationV1 }
  | { kind: "observe-checkpoint-turn"; observation: ExecutionProgressObservationV1 }
  | {
      kind: "request-tool-batch";
      calls: ExecutionToolBatchCallV1[];
      envelope: ExecutionResourceEnvelopeV1;
    }
  | {
      kind: "settle-tool-batch";
      results: ExecutionToolBatchResultV1[];
      observation: ExecutionProgressObservationV1;
    }
  | {
      kind: "fail-tool-batch";
      results: ExecutionToolBatchResultV1[];
      observation: ExecutionProgressObservationV1;
      reason: ExecutionTerminalReason;
      /** One previously authorized call denied by a later host preflight. */
      lateDeniedCallSha256?: string;
    }
  | { kind: "renew"; nextTranche: ExecutionResourceEnvelopeV1 }
  | { kind: "complete" }
  | { kind: "stop"; reason: ExecutionTerminalReason };
