// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { failProcess } from "../pilot-process-contracts.js";
import type { NativePilotFailureCode } from "../pilot-contracts.js";

export function streamObject(
  value: unknown,
  code: NativePilotFailureCode,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    failProcess(code);
  }
  return value as Record<string, unknown>;
}

export function streamExact(
  value: Record<string, unknown>,
  keys: readonly string[],
  code: NativePilotFailureCode,
): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    failProcess(code);
  }
}

export function streamRequired(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  code: NativePilotFailureCode,
): void {
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    failProcess(code);
  }
}

export function exactStringList(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

export function emptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

export function boundedStreamString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !value.includes("\0") &&
    value === value.normalize("NFC")
  );
}

export function streamInteger(value: unknown, code: NativePilotFailureCode): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) failProcess(code);
  return value as number;
}

export function streamNonnegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function safeStreamAdditiveJson(value: unknown, depth: number): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value === "string") {
    return value.length <= 65_536 && !value.includes("\0") && value === value.normalize("NFC");
  }
  if (Array.isArray(value)) {
    return (
      value.length <= 1_024 && value.every((entry) => safeStreamAdditiveJson(entry, depth + 1))
    );
  }
  if (!value || typeof value !== "object" || Object.keys(value).length > 256) return false;
  return Object.entries(value).every(
    ([key, entry]) =>
      /^[A-Za-z0-9_.:-]{1,128}$/u.test(key) && safeStreamAdditiveJson(entry, depth + 1),
  );
}
