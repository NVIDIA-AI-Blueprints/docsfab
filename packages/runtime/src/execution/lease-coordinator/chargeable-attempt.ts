// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EXECUTION_LEASE_DEFAULTS } from "../lease-contracts.js";
import type { ExecutionCheckpointV1 } from "../lease-contracts.js";
import {
  digest,
  exact,
  freeze,
  hash,
  inert,
  nonnegative,
  positive,
  reject,
  withoutDigest,
} from "./protocol.js";
import type {
  AnyExecutionChargeableAttemptPolicy,
  ExecutionChargeableAttemptPolicyV1,
  ExecutionChargeableAttemptPolicyV2,
  ExecutionChargeableAttemptStateV1,
  ExecutionCoordinatorCheckpointV1,
  ExecutionLeaseCoordinatorV1,
} from "./types.js";

export function createExecutionChargeableAttemptPolicy(
  input: {
    maxChargeableAttempts: number;
  },
  maxAllowed = EXECUTION_LEASE_DEFAULTS.hardToolCallCeiling,
): ExecutionChargeableAttemptPolicyV1 {
  inert(input);
  exact(input, ["maxChargeableAttempts"]);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-execution-chargeable-attempt-policy" as const,
    maxChargeableAttempts: positive(input.maxChargeableAttempts),
  };
  // Derived, not a literal: pi-lease.ts defaults maxChargeableAttempts to the
  // policy's hardToolCallCeiling, so a literal here would silently cap the
  // composition path regardless of what the policy grants.
  if (body.maxChargeableAttempts > maxAllowed) {
    reject();
  }
  return freeze({ ...body, policySha256: hash(body) });
}

export function createAbsentChargeableAttemptPolicyV2(): ExecutionChargeableAttemptPolicyV2 {
  const body = {
    schemaVersion: 2 as const,
    kind: "docsfab-execution-chargeable-attempt-policy" as const,
    aggregateLimit: { kind: "absent" as const },
  };
  return freeze({ ...body, policySha256: hash(body) });
}

export function decodeAnyChargeableAttemptPolicy(
  value: AnyExecutionChargeableAttemptPolicy,
): AnyExecutionChargeableAttemptPolicy {
  inert(value);
  if (value.schemaVersion === 1) return decodeChargeableAttemptPolicy(value);
  exact(value, ["schemaVersion", "kind", "aggregateLimit", "policySha256"]);
  exact(value.aggregateLimit, ["kind"]);
  const body = {
    schemaVersion: 2 as const,
    kind: "docsfab-execution-chargeable-attempt-policy" as const,
    aggregateLimit: { kind: "absent" as const },
  };
  if (
    value.schemaVersion !== 2 ||
    value.kind !== body.kind ||
    value.aggregateLimit.kind !== "absent" ||
    value.policySha256 !== hash(body)
  )
    reject();
  return freeze({ ...body, policySha256: value.policySha256 });
}

export function decodeChargeableAttemptPolicy(
  value: ExecutionChargeableAttemptPolicyV1,
  maxAllowed = EXECUTION_LEASE_DEFAULTS.hardToolCallCeiling,
): ExecutionChargeableAttemptPolicyV1 {
  inert(value);
  exact(value, ["schemaVersion", "kind", "maxChargeableAttempts", "policySha256"]);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-execution-chargeable-attempt-policy" as const,
    maxChargeableAttempts: positive(value.maxChargeableAttempts),
  };
  if (
    // The same derived ceiling as the creator's check; a literal would drift.
    body.maxChargeableAttempts > maxAllowed ||
    value.schemaVersion !== body.schemaVersion ||
    value.kind !== body.kind ||
    value.policySha256 !== hash(body)
  )
    reject();
  return freeze({ ...body, policySha256: value.policySha256 });
}

export function createChargeableAttemptState(
  input: { chargeableAttempts: number; lastCheckpointSha256: string | null },
  policy: AnyExecutionChargeableAttemptPolicy,
  previous?: ExecutionChargeableAttemptStateV1,
): ExecutionChargeableAttemptStateV1 {
  inert(input);
  exact(input, ["chargeableAttempts", "lastCheckpointSha256"]);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-execution-chargeable-attempt-state" as const,
    chargeableAttempts: nonnegative(input.chargeableAttempts),
    lastCheckpointSha256:
      input.lastCheckpointSha256 === null ? null : digest(input.lastCheckpointSha256),
    policySha256: policy.policySha256,
  };
  if (
    (policy.schemaVersion === 1 && body.chargeableAttempts > policy.maxChargeableAttempts) ||
    (previous &&
      (body.chargeableAttempts < previous.chargeableAttempts ||
        (body.chargeableAttempts !== previous.chargeableAttempts &&
          body.lastCheckpointSha256 !== previous.lastCheckpointSha256) ||
        (body.lastCheckpointSha256 !== previous.lastCheckpointSha256 &&
          body.chargeableAttempts !== previous.chargeableAttempts)))
  )
    reject();
  return freeze({ ...body, stateSha256: hash(body) });
}

export function decodeChargeableAttemptState(
  value: ExecutionChargeableAttemptStateV1,
  policy: AnyExecutionChargeableAttemptPolicy,
): ExecutionChargeableAttemptStateV1 {
  inert(value);
  exact(value, [
    "schemaVersion",
    "kind",
    "chargeableAttempts",
    "lastCheckpointSha256",
    "policySha256",
    "stateSha256",
  ]);
  const decoded = createChargeableAttemptState(
    {
      chargeableAttempts: value.chargeableAttempts,
      lastCheckpointSha256: value.lastCheckpointSha256,
    },
    policy,
  );
  if (
    value.schemaVersion !== decoded.schemaVersion ||
    value.kind !== decoded.kind ||
    value.policySha256 !== decoded.policySha256 ||
    value.stateSha256 !== decoded.stateSha256
  )
    reject();
  return decoded;
}

export function advanceChargeableAttempts(
  coordinator: ExecutionLeaseCoordinatorV1,
  additions: number,
  previous: ExecutionChargeableAttemptStateV1,
): ExecutionChargeableAttemptStateV1 {
  return createChargeableAttemptState(
    {
      chargeableAttempts: previous.chargeableAttempts + nonnegative(additions),
      lastCheckpointSha256: previous.lastCheckpointSha256,
    },
    coordinator.chargeableAttemptPolicy,
    previous,
  );
}

export function createCoordinatorCheckpoint(
  coordinator: ExecutionLeaseCoordinatorV1,
  leaseCheckpoint: ExecutionCheckpointV1,
): ExecutionCoordinatorCheckpointV1 {
  const previous = coordinator.coordinatorCheckpoints.at(-1);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-execution-coordinator-checkpoint" as const,
    sequence: (previous?.sequence ?? 0) + 1,
    previousCheckpointSha256: previous?.checkpointSha256 ?? null,
    leaseCheckpointSha256: leaseCheckpoint.checkpointSha256,
    chargeableAttemptState: coordinator.chargeableAttemptState,
    chargeableAttemptPolicySha256: coordinator.chargeableAttemptPolicy.policySha256,
  };
  return freeze({ ...body, checkpointSha256: hash(body) });
}

export function validateCoordinatorCheckpoints(value: ExecutionLeaseCoordinatorV1): void {
  let previous: ExecutionCoordinatorCheckpointV1 | undefined;
  let previousChargeableAttempts = value.initialChargeableAttemptState.chargeableAttempts;
  value.coordinatorCheckpoints.forEach((checkpoint, index) => {
    exact(checkpoint, [
      "schemaVersion",
      "kind",
      "sequence",
      "previousCheckpointSha256",
      "leaseCheckpointSha256",
      "chargeableAttemptState",
      "chargeableAttemptPolicySha256",
      "checkpointSha256",
    ]);
    const state = decodeChargeableAttemptState(
      checkpoint.chargeableAttemptState,
      value.chargeableAttemptPolicy,
    );
    const body = withoutDigest(checkpoint, "checkpointSha256");
    if (
      checkpoint.schemaVersion !== 1 ||
      checkpoint.kind !== "docsfab-execution-coordinator-checkpoint" ||
      checkpoint.sequence !== index + 1 ||
      checkpoint.previousCheckpointSha256 !== (previous?.checkpointSha256 ?? null) ||
      checkpoint.leaseCheckpointSha256 !== value.checkpoints[index]?.checkpointSha256 ||
      state.chargeableAttempts !==
        (value.checkpoints[index]?.state.toolCalls.executed ?? -1) +
          (value.checkpoints[index]?.state.toolCalls.denied ?? -1) ||
      checkpoint.chargeableAttemptPolicySha256 !== value.chargeableAttemptPolicy.policySha256 ||
      checkpoint.checkpointSha256 !== hash(body) ||
      state.chargeableAttempts < previousChargeableAttempts ||
      state.lastCheckpointSha256 !== (previous?.checkpointSha256 ?? null)
    )
      reject();
    previousChargeableAttempts = state.chargeableAttempts;
    previous = checkpoint;
  });
  if (
    value.coordinatorCheckpoints.length !== value.checkpoints.length ||
    value.chargeableAttemptState.chargeableAttempts < previousChargeableAttempts ||
    value.chargeableAttemptState.lastCheckpointSha256 !== (previous?.checkpointSha256 ?? null)
  ) {
    reject();
  }
}

export function remainingChargeableAttempts(value: ExecutionLeaseCoordinatorV1): number | null {
  if (value.chargeableAttemptPolicy.schemaVersion === 2) return null;
  return Math.max(
    0,
    value.chargeableAttemptPolicy.maxChargeableAttempts -
      value.chargeableAttemptState.chargeableAttempts,
  );
}
