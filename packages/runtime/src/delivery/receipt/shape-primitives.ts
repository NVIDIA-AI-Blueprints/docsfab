// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";
import { containsConfiguredCredentialText } from "../contracts.js";
import { isDnsHostname } from "../../shared/dns-hostname.js";

export class ScmDeliveryContractError extends Error {
  public constructor(
    public readonly code:
      | "invalid-record"
      | "invalid-transition"
      | "identity-mismatch"
      | "external-drift"
      | "invalid-authorization",
    public readonly path: string,
  ) {
    super(`SCM delivery contract failed (${code}) at ${path}.`);
    this.name = "ScmDeliveryContractError";
  }
}

export function object(
  value: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Record<string, unknown> {
  requireCondition(
    typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
    "invalid-record",
    path,
  );
  const item = value as Record<string, unknown>;
  for (const key of Object.keys(item))
    requireCondition(allowed.includes(key), "invalid-record", `${path}.${key}`);
  for (const key of required)
    requireCondition(Object.hasOwn(item, key), "invalid-record", `${path}.${key}`);
  return item;
}

export function array(value: unknown, path: string): unknown[] {
  requireCondition(Array.isArray(value), "invalid-record", path);
  return value;
}

export function exact<T extends string | number | boolean>(
  value: unknown,
  expected: T,
  path: string,
): T {
  requireCondition(value === expected, "invalid-record", path);
  return expected;
}

export function enumeration<T extends string>(
  value: unknown,
  options: readonly T[],
  path: string,
): T {
  requireCondition(
    typeof value === "string" && options.includes(value as T),
    "invalid-record",
    path,
  );
  return value as T;
}

export function requireSha(value: unknown, path: string): string {
  requireCondition(
    typeof value === "string" && /^[a-f0-9]{64}$/u.test(value),
    "invalid-record",
    path,
  );
  return value;
}

export function token(value: unknown, path: string): string {
  requireCondition(
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value),
    "invalid-record",
    path,
  );
  return value;
}

export function revision(value: unknown, path: string): string {
  requireCondition(
    typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value),
    "invalid-record",
    path,
  );
  return value;
}

export function positiveInteger(value: unknown, path: string): number {
  requireCondition(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    "invalid-record",
    path,
  );
  return value;
}

export function timestamp(value: unknown, path: string): string {
  requireCondition(typeof value === "string" && value.length <= 40, "invalid-record", path);
  const parsed = new Date(value as string);
  requireCondition(
    !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value,
    "invalid-record",
    path,
  );
  return value as string;
}

export function safeId(value: unknown, path: string): string {
  requireCondition(
    typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) &&
      !containsConfiguredCredentialText(value, `delivery-receipt:${path}`),
    "invalid-record",
    path,
  );
  return value;
}

export function safeHost(value: unknown, path: string): string {
  requireCondition(isDnsHostname(value, { anyCase: true }), "invalid-record", path);
  return value;
}

export function safeProject(value: unknown, path: string): string {
  requireCondition(
    typeof value === "string" &&
      value.split("/").length >= 2 &&
      value.split("/").every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part)),
    "invalid-record",
    path,
  );
  return value;
}

export function branch(value: unknown, path: string): string {
  requireCondition(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 200 &&
      value === value.normalize("NFC") &&
      !/[\0-\x20\x7f~^:?*[\\]/u.test(value) &&
      !containsConfiguredCredentialText(value, `delivery-receipt:${path}`) &&
      !/(?:[A-Za-z]:\\|\/(?:Users|home|private|tmp)\/)/u.test(value) &&
      !value.startsWith("-") &&
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !value.includes("//") &&
      !value.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock")),
    "invalid-record",
    path,
  );
  return value;
}

export function safeUrl(value: unknown, path: string): string {
  requireCondition(
    typeof value === "string" && value.length <= 1024 && !/[\0\r\n]/u.test(value),
    "invalid-record",
    path,
  );
  let url: URL;
  try {
    url = new URL(value as string);
  } catch {
    throw new ScmDeliveryContractError("invalid-record", path);
  }
  requireCondition(
    url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash,
    "invalid-record",
    path,
  );
  return value as string;
}

export function sha256(value: unknown): string {
  const text =
    typeof value === "string" ? value : canonicalizeJsonEvidence(value as JsonEvidenceValue);
  return createHash("sha256").update(text).digest("hex");
}

export function requireCondition(
  condition: unknown,
  code: ScmDeliveryContractError["code"],
  path: string,
): asserts condition {
  if (!condition) throw new ScmDeliveryContractError(code, path);
}

export function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}
