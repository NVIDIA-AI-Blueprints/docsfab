// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import type { ExecutionLeaseRuntimeEvidenceV1 } from "./execution/contracts.js";
import { ScorecardRecordError } from "./execution/inference-evidence.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "./json-evidence.js";

export const SHA256 = /^[a-f0-9]{64}$/u;
export const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
export const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export function object(value: unknown): Record<string, unknown> {
  requireCondition(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !nodeUtilTypes.isProxy(value),
  );
  const proto = Object.getPrototypeOf(value);
  requireCondition(proto === Object.prototype || proto === null);
  requireCondition(Object.getOwnPropertySymbols(value).length === 0);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireCondition(
    Object.values(descriptors).every(
      (descriptor) =>
        Object.hasOwn(descriptor, "value") &&
        descriptor.enumerable === true &&
        descriptor.value !== undefined,
    ),
  );
  return value as Record<string, unknown>;
}

export function array(value: unknown): unknown[] {
  requireCondition(Array.isArray(value) && !nodeUtilTypes.isProxy(value));
  requireCondition(
    Object.getPrototypeOf(value) === Array.prototype &&
      Object.getOwnPropertySymbols(value).length === 0,
  );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = new Set([
    "length",
    ...Array.from({ length: value.length }, (_, index) => String(index)),
  ]);
  requireCondition(
    Object.keys(descriptors).every((key) => expected.has(key)) &&
      Object.keys(descriptors).length === expected.size &&
      Object.entries(descriptors).every(
        ([key, descriptor]) =>
          Object.hasOwn(descriptor, "value") &&
          descriptor.value !== undefined &&
          (key === "length" || descriptor.enumerable === true),
      ),
  );
  return value;
}

export function exact(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  requireCondition(Object.keys(value).every((key) => allowedSet.has(key)));
}

export function requireEqual<T>(value: unknown, expected: T): asserts value is T {
  requireCondition(value === expected);
}

export function requireCondition(condition: unknown): asserts condition {
  if (!condition) throw new ScorecardRecordError();
}

export function boolean(value: unknown): boolean {
  requireCondition(typeof value === "boolean");
  return value;
}

export function safeText(value: unknown, maxLength: number): string {
  requireCondition(typeof value === "string" && value.length > 0 && value.length <= maxLength);
  requireCondition(!UNSAFE_TEXT.test(value) && !hasUnpairedSurrogate(value));
  return value;
}

export function optionalText(value: unknown, maxLength: number): string | undefined {
  return value === undefined ? undefined : safeText(value, maxLength);
}

export function identifier(value: unknown): string {
  const decoded = safeText(value, 512);
  requireCondition(SAFE_ID.test(decoded));
  return decoded;
}

export function pattern(value: unknown, expression: RegExp): string {
  requireCondition(typeof value === "string" && expression.test(value));
  return value;
}

export function repositoryRelativePath(value: unknown): string {
  const decoded = safeText(value, 16_384);
  requireCondition(
    decoded === "." ||
      (!decoded.startsWith("/") &&
        !decoded.startsWith("\\") &&
        !/^[A-Za-z]:[\\/]/u.test(decoded) &&
        !decoded.split(/[\\/]/u).includes("..")),
  );
  return decoded;
}

export function nonnegativeInteger(value: unknown): number {
  requireCondition(Number.isSafeInteger(value) && Number(value) >= 0);
  return Number(value);
}

export function positiveInteger(value: unknown): number {
  const decoded = nonnegativeInteger(value);
  requireCondition(decoded > 0);
  return decoded;
}

export function optionalNonnegativeInteger(value: unknown): number | undefined {
  return value === undefined ? undefined : nonnegativeInteger(value);
}

export function nonnegativeFinite(value: unknown): number {
  requireCondition(
    typeof value === "number" && Number.isFinite(value) && value >= 0 && !Object.is(value, -0),
  );
  return value;
}

function nullableNonnegativeFinite(value: unknown): number | null {
  return value === null ? null : nonnegativeFinite(value);
}

export function timestamp(value: unknown): string {
  requireCondition(
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value),
  );
  requireCondition(new Date(value).toISOString() === value);
  return value;
}

export function optionalTimestamp(value: unknown): string | undefined {
  return value === undefined ? undefined : timestamp(value);
}

function date(value: unknown): string {
  requireCondition(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value));
  requireCondition(new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value);
  return value;
}

export function oneOf<const T extends readonly unknown[]>(value: unknown, values: T): T[number] {
  requireCondition(values.includes(value));
  return value as T[number];
}

export function uniqueArray<T>(value: unknown, decoder: (item: unknown) => T): T[] {
  const decoded = array(value).map(decoder);
  requireCondition(new Set(decoded.map((item) => canonical(item))).size === decoded.length);
  return decoded;
}

export function uniqueEnumArray<const T extends readonly string[]>(
  value: unknown,
  values: T,
): T[number][] {
  const decoded = array(value).map((item) => oneOf(item, values));
  requireCondition(new Set(decoded).size === decoded.length);
  return decoded;
}

function uniqueSortedEnumArray<const T extends readonly string[]>(
  value: unknown,
  values: T,
): T[number][] {
  const decoded = uniqueEnumArray(value, values);
  requireCondition(canonical(decoded) === canonical([...decoded].sort()));
  requireCondition(decoded.length > 0);
  return decoded;
}

export function uniqueSortedIdentifiers(value: unknown): string[] {
  const decoded = uniqueIdentifiers(value);
  requireCondition(canonical(decoded) === canonical([...decoded].sort()));
  return decoded;
}

function uniqueIdentifiers(value: unknown): string[] {
  const decoded = array(value).map(identifier);
  requireCondition(new Set(decoded).size === decoded.length);
  return decoded;
}

export function uniqueToolPolicyEntries(value: unknown): string[] {
  const decoded = array(value).map((entry) => safeText(entry, 512));
  requireCondition(new Set(decoded).size === decoded.length);
  return decoded;
}

export function safeSum(values: number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  requireCondition(Number.isSafeInteger(total));
  return total;
}

export function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const item = object(value);
  return `{${Object.keys(item)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`)
    .join(",")}}`;
}

export function evidenceDigest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeJsonEvidence(value as JsonEvidenceValue))
    .digest("hex");
}

export function executionTerminalPairIsValid(
  reason: NonNullable<ExecutionLeaseRuntimeEvidenceV1["terminalReason"]>,
  disposition: NonNullable<ExecutionLeaseRuntimeEvidenceV1["terminalDisposition"]>,
): boolean {
  if (reason === "completed") return disposition === "completed";
  if (reason === "needs-input") return disposition === "needs-input";
  if (reason === "needs-human-decision") return disposition === "needs-human-decision";
  if (reason === "cancellation-requested") return disposition === "cancelled";
  if (reason === "context-exhausted") return disposition === "context-exhausted";
  if (reason === "provider-terminal") {
    return disposition === "provider-failed" || disposition === "blank";
  }
  if (reason === "provider-unavailable") return disposition === "provider-failed";
  if (reason === "authorization-denied" || reason === "security-denied") {
    return disposition === "authorization-denied";
  }
  if (reason === "evidence-preservation-required") return disposition === "evidence-invalid";
  if (reason === "checkpoint-not-renewable") {
    return (
      disposition === "blank" || disposition === "malformed" || disposition === "progress-stopped"
    );
  }
  return disposition === "budget-stopped";
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || following < 0xdc00 || following > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
