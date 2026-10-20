// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";

export const SHA256 = /^[a-f0-9]{64}$/u;
export const REVISION = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;

export const CONTRACT_CODE = /^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
export const INVALID_SHAPE = "invalid-shape";
export const NO_DOCUMENT_CHANGE = "no-document-change";

export class PublicationRunRecordDecodeError extends Error {
  public constructor(
    public readonly code: string,
    options?: ErrorOptions,
  ) {
    super("Publication run record rejected.", options);
    this.name = "PublicationRunRecordDecodeError";
  }
}

export function canonical(value: unknown): string {
  return value === undefined ? "undefined" : canonicalizeJsonEvidence(value as JsonEvidenceValue);
}

export function object(value: unknown): Record<string, unknown> {
  expect(value !== null && typeof value === "object" && !Array.isArray(value));
  const proto = Object.getPrototypeOf(value);
  expect(proto === Object.prototype || proto === null);
  return value as Record<string, unknown>;
}

export function array(value: unknown): unknown[] {
  expect(Array.isArray(value));
  return value;
}

export function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  expect(Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"));
}

export function allowed(value: Record<string, unknown>, keys: readonly string[]): void {
  expect(Object.keys(value).every((key) => keys.includes(key)));
}

export function required(value: Record<string, unknown>, keys: readonly string[]): void {
  expect(keys.every((key) => Object.hasOwn(value, key)));
}

export function identifier(value: unknown): string {
  expect(typeof value === "string" && SAFE_ID.test(value));
  return value as string;
}

export function digest(value: unknown): string {
  expect(typeof value === "string" && SHA256.test(value));
  return value as string;
}

export function safeText(value: unknown, limit: number): string {
  expect(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= limit &&
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
  );
  return value as string;
}

export function integer(value: unknown): number {
  expect(typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  return value as number;
}

export function timestamp(value: unknown): string {
  expect(
    typeof value === "string" &&
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString() === value,
  );
  return value as string;
}

export function repositoryPath(value: unknown): string {
  expect(
    typeof value === "string" &&
      value.length > 0 &&
      value === value.normalize("NFC") &&
      !value.startsWith("/") &&
      !value.startsWith("~") &&
      !value.includes("\\") &&
      value.split("/").every((segment) => Boolean(segment) && segment !== "." && segment !== ".."),
  );
  return value as string;
}

export function expect(condition: unknown): asserts condition {
  if (!condition) throw new PublicationRunRecordDecodeError(INVALID_SHAPE);
}
