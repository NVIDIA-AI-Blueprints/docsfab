// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CorpusValidationError } from "./errors.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SAFE_PATH = /^(?!\/)(?!.*\\)(?!.*\0)[^\r\n]+$/u;

export function exactObject(
  value: unknown,
  allowed: string[],
  code: string,
  required = allowed,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(object, key))
  )
    fail(code);
  return object;
}

export function array(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) fail(code);
  return value;
}

export function text(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.normalize("NFC") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    fail(code);
  return value;
}

export function safePath(value: unknown, code: string): string {
  const result = text(value, code);
  if (
    !SAFE_PATH.test(result) ||
    result.split("/").some((part) => part === "." || part === ".." || !part)
  )
    fail(code);
  return result;
}

export function stringArray(value: unknown, code: string): string[] {
  const result = array(value, code).map((item) => text(item, code));
  unique(result, code);
  return result;
}

export function stringRecord(value: unknown, code: string): Record<string, string> {
  const root = exactObject(value, Object.keys((value ?? {}) as object), code, []);
  return Object.fromEntries(
    Object.entries(root).map(([key, item]) => [text(key, code), safePath(item, code)]),
  );
}

export function textRecord(value: unknown, code: string): Record<string, string> {
  const root = exactObject(value, Object.keys((value ?? {}) as object), code, []);
  return Object.fromEntries(
    Object.entries(root).map(([key, item]) => [text(key, code), text(item, code)]),
  );
}

export function digestValue(value: unknown, code: string): string {
  const result = text(value, code);
  if (!SHA256.test(result)) fail(code);
  return result;
}

export function revisionValue(value: unknown, code: string): string {
  const result = text(value, code);
  if (!REVISION.test(result)) fail(code);
  return result;
}

export function positiveInteger(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}

export function nonnegativeInteger(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

export function unit(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) fail(code);
  return value;
}

export function timestamp(value: unknown, code: string): string {
  const result = text(value, code);
  const parsed = new Date(result);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) fail(code);
  return result;
}

export function unique(values: string[], code: string): void {
  if (new Set(values).size !== values.length) fail(code);
}

export function fail(code: string): never {
  throw new CorpusValidationError(code);
}
