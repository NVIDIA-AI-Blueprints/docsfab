// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  AnyExecutionLeasePolicyV1OrV2,
  ExecutionLeasePolicyV1,
  ExecutionLeasePolicyV2,
  ExecutionLeaseStateV1,
} from "../lease-contracts.js";
import { fail } from "./codec-helpers.js";

export function readingToolCallsExecuted(
  state: Pick<ExecutionLeaseStateV1, "toolCalls" | "toolCallsByScope">,
): number {
  return state.toolCallsByScope?.reading ?? state.toolCalls.executed;
}

export function answerRecordToolCallsExecuted(
  state: Pick<ExecutionLeaseStateV1, "toolCallsByScope">,
): number {
  return state.toolCallsByScope?.answerRecord ?? 0;
}

export function answerRecordToolCallsAdmitted(
  state: Pick<ExecutionLeaseStateV1, "answerRecordCallsAdmitted">,
): number {
  return state.answerRecordCallsAdmitted ?? 0;
}

export function leaseToolCallsCharged(
  policy: AnyExecutionLeasePolicyV1OrV2,
  state: ExecutionLeaseStateV1,
): number {
  return policy.schemaVersion === 2
    ? state.leaseExecutedToolCalls +
        (state.leaseAdmittedAnswerRecordCalls ?? 0) -
        (state.leaseExecutedAnswerRecordCalls ?? 0)
    : policy.answerRecordCallCeiling === undefined
      ? state.leaseExecutedToolCalls
      : state.leaseExecutedToolCalls +
        (state.leaseAdmittedAnswerRecordCalls ?? 0) -
        (state.leaseExecutedAnswerRecordCalls ?? 0);
}

export function remainingScopedToolCalls(
  policy: AnyExecutionLeasePolicyV1OrV2,
  state: ExecutionLeaseStateV1,
): number {
  if (policy.schemaVersion === 2) {
    return Math.max(
      0,
      currentLeaseToolCallAllowance(policy, state) - leaseToolCallsCharged(policy, state),
    );
  }
  if (policy.sharedToolCallCapacity) {
    return Math.max(
      0,
      executionLeaseChargeableAttemptCeiling(policy)! -
        readingToolCallsExecuted(state) -
        answerRecordToolCallsAdmitted(state),
    );
  }
  return (
    Math.max(0, policy.hardToolCallCeiling - readingToolCallsExecuted(state)) +
    Math.max(0, (policy.answerRecordCallCeiling ?? 0) - answerRecordToolCallsAdmitted(state))
  );
}

/** The exact combined-call allowance for the current lease, based on its start. */
export function currentLeaseToolCallAllowance(
  policy: AnyExecutionLeasePolicyV1OrV2,
  state: Pick<
    ExecutionLeaseStateV1,
    | "leaseNumber"
    | "toolCalls"
    | "toolCallsByScope"
    | "answerRecordCallsAdmitted"
    | "leaseExecutedToolCalls"
    | "leaseExecutedAnswerRecordCalls"
    | "leaseAdmittedAnswerRecordCalls"
    | "leaseToolCallAllowance"
  >,
): number {
  if (policy.schemaVersion === 2) return state.leaseToolCallAllowance ?? policy.callsPerLease;
  if (policy.answerRecordCallCeiling !== undefined && state.leaseToolCallAllowance !== undefined) {
    return state.leaseToolCallAllowance;
  }
  const hasAnswerRecordScope = policy.answerRecordCallCeiling !== undefined;
  if (!hasAnswerRecordScope) {
    const callsBeforeLease = state.toolCalls.executed - state.leaseExecutedToolCalls;
    return Math.min(policy.callsPerLease, policy.hardToolCallCeiling - callsBeforeLease);
  }
  const leaseRecords = state.leaseAdmittedAnswerRecordCalls ?? 0;
  const recordsBeforeLease = answerRecordToolCallsAdmitted(state) - leaseRecords;
  const readingBeforeLease =
    readingToolCallsExecuted(state) -
    (state.leaseExecutedToolCalls - (state.leaseExecutedAnswerRecordCalls ?? 0));
  return Math.min(
    policy.callsPerLease,
    Math.max(0, policy.hardToolCallCeiling - readingBeforeLease) +
      Math.max(0, (policy.answerRecordCallCeiling ?? 0) - recordsBeforeLease),
  );
}

/** Maximum number of admitted or chargeable calls under both independent caps. */
export function executionLeaseChargeableAttemptCeiling(policy: ExecutionLeasePolicyV1): number;
export function executionLeaseChargeableAttemptCeiling(policy: ExecutionLeasePolicyV2): null;
export function executionLeaseChargeableAttemptCeiling(
  policy: AnyExecutionLeasePolicyV1OrV2,
): number | null;
export function executionLeaseChargeableAttemptCeiling(
  policy: AnyExecutionLeasePolicyV1OrV2,
): number | null {
  if (policy.schemaVersion === 2) return null;
  const aggregate = policy.sharedToolCallCapacity
    ? Math.min(
        policy.callsPerLease * policy.maxLeases,
        Math.max(policy.hardToolCallCeiling, policy.answerRecordCallCeiling ?? 0),
      )
    : Math.min(
        Number.MAX_SAFE_INTEGER,
        policy.hardToolCallCeiling + (policy.answerRecordCallCeiling ?? 0),
      );
  return Math.min(policy.callsPerLease * policy.maxLeases, aggregate);
}

/**
 * Tool calls a renewal at this settled state would grant.
 *
 * `renew` rejects a requested tranche whose `toolCalls` differs from this, so
 * the host building the request uses this one definition. The subtracted turn
 * is the final provider turn the terminal answer still needs.
 */
export function renewalToolCallGrant(
  policy: AnyExecutionLeasePolicyV1OrV2,
  state: Pick<
    ExecutionLeaseStateV1,
    "toolCalls" | "providerTurns" | "toolCallsByScope" | "answerRecordCallsAdmitted"
  >,
): number {
  if (policy.schemaVersion === 2) return policy.callsPerLease;
  const readingRemaining = Math.max(
    0,
    policy.hardToolCallCeiling - readingToolCallsExecuted(state),
  );
  const recordsRemaining = Math.max(
    0,
    (policy.answerRecordCallCeiling ?? 0) - answerRecordToolCallsAdmitted(state),
  );
  const turnsForToolTurns = Math.max(0, policy.maxProviderTurns - state.providerTurns - 1);
  if (policy.sharedToolCallCapacity) {
    const ceiling = executionLeaseChargeableAttemptCeiling(policy);
    if (ceiling === null) fail("invalid-policy");
    return Math.min(
      policy.callsPerLease,
      Math.max(0, ceiling - readingToolCallsExecuted(state) - answerRecordToolCallsAdmitted(state)),
    );
  }
  const readingGrant = Math.min(readingRemaining, turnsForToolTurns);
  const recordGrant =
    policy.answerRecordCallCeiling === undefined || turnsForToolTurns === 0 ? 0 : recordsRemaining;
  return Math.min(policy.callsPerLease, readingGrant + recordGrant);
}
