// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";
import { createContractKit, deepFreeze } from "../../contract-kit/index.js";
import type { ExecutionStopReason } from "../lease-contracts.js";

export { deepFreeze };

export const SHA256 = /^[a-f0-9]{64}$/u;
export const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export class ExecutionLeaseContractError extends Error {
  public readonly code:
    | "invalid-policy"
    | "invalid-identity"
    | "invalid-state"
    | "counter-regression"
    | "invalid-checkpoint"
    | "invalid-decision"
    | "invalid-record"
    | "migration-required"
    | "credential-material";
  constructor(
    code:
      | "invalid-policy"
      | "invalid-identity"
      | "invalid-state"
      | "counter-regression"
      | "invalid-checkpoint"
      | "invalid-decision"
      | "invalid-record"
      | "migration-required"
      | "credential-material",
  ) {
    super(`Execution lease contract rejected: ${code}.`);
    this.code = code;
    this.name = "ExecutionLeaseContractError";
  }
}

export const EXECUTION_STOP_REASON_PRECEDENCE: readonly ExecutionStopReason[] = Object.freeze([
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
] as const);

export type ErrorCode = ExecutionLeaseContractError["code"];

export function fail(code: ErrorCode): never {
  throw new ExecutionLeaseContractError(code);
}

let activeCode: ErrorCode = "invalid-record";

const kit = createContractKit({
  fail: (code) =>
    fail(code === "credential-material" || code === "migration-required" ? code : activeCode),
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-record",
    invalidValue: "invalid-record",
    digestMismatch: "invalid-record",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

export function withCode<T>(code: ErrorCode, run: () => T): T {
  const previous = activeCode;
  activeCode = code;
  try {
    return run();
  } finally {
    activeCode = previous;
  }
}

export function object(value: unknown, code: ErrorCode): Record<string, unknown> {
  return withCode(code, () => kit.object(value));
}

export function array(value: unknown, code: ErrorCode): unknown[] {
  return withCode(code, () => kit.array(value));
}

export function assertPlainJsonData(value: unknown, code: ErrorCode): void {
  withCode(code, () => {
    kit.assertInert(value);
    kit.rejectCredentials(value);
  });
}

export function exact(
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: ErrorCode,
  optional: readonly string[] = [],
): void {
  withCode(code, () => {
    kit.exact(value, allowed, optional);
  });
}

export function positive(value: unknown, code: ErrorCode): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail(code);
  return value as number;
}

export function nonnegative(value: unknown, code: ErrorCode): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(code);
  return value as number;
}

export function booleanValue(value: unknown, code: ErrorCode): boolean {
  if (typeof value !== "boolean") fail(code);
  return value;
}

export function legacyIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /[\p{Cc}\\]/u.test(value)
  )
    fail("invalid-record");
  return value;
}

export function digest(value: unknown, code: ErrorCode): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code);
  return value;
}

export function nullableDigest(value: unknown, code: ErrorCode): string | null {
  return value === null ? null : digest(value, code);
}

export function revision(value: unknown, code: ErrorCode): string {
  if (typeof value !== "string" || !REVISION.test(value)) fail(code);
  return value;
}

export function safeId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 256 ||
    /[\p{Cc}\\]/u.test(value) ||
    value.startsWith("/") ||
    value.includes("..")
  ) {
    fail("invalid-record");
  }
  return value;
}

export function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  code: ErrorCode,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) fail(code);
  return value as T[number];
}

export function sha256(value: unknown, code: ErrorCode): string {
  try {
    assertPlainJsonData(value, code);
    return createHash("sha256")
      .update(canonicalizeJsonEvidence(value as JsonEvidenceValue))
      .digest("hex");
  } catch {
    fail(code);
  }
}

export const CHECKPOINT_REASONS = Object.freeze([
  "lease-exhausted",
  "budget-boundary",
  "host-requested",
  "provider-requested",
  "workflow-completed",
] as const);
export const COST_UNAVAILABLE_REASONS = Object.freeze([
  "pricing-unknown",
  "pricing-stale",
] as const);
export const TERMINAL_REASONS = Object.freeze([
  "completed",
  "needs-input",
  "needs-human-decision",
  ...EXECUTION_STOP_REASON_PRECEDENCE,
] as const);
export const INFERENCE_OUTCOMES = Object.freeze([
  "succeeded",
  "blank-response",
  "malformed-response",
  "context-exhausted",
  "timeout",
  "throttled",
  "provider-transient",
  "invalid-request",
  "provider-terminal",
  "host-runtime-failure",
  "no-progress",
] as const);
export const INFERENCE_TURN_DECISIONS = Object.freeze(["proceed", "compact", "stop"] as const);
export const INFERENCE_TURN_REASONS = Object.freeze([
  "context-exhausted",
  "provider-turn-limit",
  "tool-call-limit",
  "compaction-limit",
  "compaction-ineffective",
  "evidence-preservation-required",
  "output-authority-exhausted",
] as const);
