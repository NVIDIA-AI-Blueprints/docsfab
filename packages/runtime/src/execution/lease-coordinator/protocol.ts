// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { createContractKit, deepFreeze } from "../../contract-kit/index.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";

import type { ExecutionStopReason } from "../lease-contracts.js";

const SHA256 = /^[a-f0-9]{64}$/u;

export class ExecutionLeaseCoordinatorError extends Error {
  readonly code = "invalid-execution-lease-coordinator";

  constructor() {
    super("Execution lease coordinator rejected the transition.");
    this.name = "ExecutionLeaseCoordinatorError";
  }
}

export function reject(): never {
  throw new ExecutionLeaseCoordinatorError();
}

const { assertInert: inert, exact: kitExact } = createContractKit({
  fail: () => reject(),
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-execution-lease-coordinator",
    invalidValue: "invalid-execution-lease-coordinator",
    digestMismatch: "invalid-execution-lease-coordinator",
    credentialMaterial: "invalid-execution-lease-coordinator",
    schemaMismatch: "migration-required",
  },
});

export { inert };

export function exact(
  value: object,
  allowed: readonly string[],
  optional: readonly string[] = [],
): void {
  kitExact(value as Record<string, unknown>, allowed, optional);
}

export function freeze<T>(value: T): T {
  return deepFreeze(value);
}

export function uniqueReasons(reasons: readonly ExecutionStopReason[]): ExecutionStopReason[] {
  return [...new Set(reasons)];
}

export function withoutDigest<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const clone = { ...value };
  delete clone[key];
  return clone;
}

export function hash(value: unknown): string {
  inert(value);
  return createHash("sha256")
    .update(canonicalizeJsonEvidence(value as JsonEvidenceValue))
    .digest("hex");
}

export function digest(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) reject();
  return value;
}

export function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) reject();
  return value as number;
}

export function nonnegative(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) reject();
  return value as number;
}
