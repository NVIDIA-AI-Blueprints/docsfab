// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Fail-closed field codecs for hosted-runtime wire packets.
 *
 * Kind-owned modules import these helpers. This file is not a public
 * host-invoker export; `contracts.ts` re-exports only `canonicalJson`,
 * `containsCredentialDeep` and `digest`.
 */
import { createHash } from "node:crypto";

import { findConfiguredCredentialInValue } from "../security/configured-credentials.js";
import {
  documentShapeRuleIds,
  ruleIdsInValue,
  screenCredentialValue,
} from "../security/credential-shape-findings.js";
import { HostRuntimeContractError } from "./contract-error.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SAFE_TOOL = /^[a-z][a-z0-9_-]{0,63}$/u;

export function recordWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    bad("invalid-shape");
  const root = value as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(root, key)) ||
    Object.keys(root).some((key) => !required.includes(key) && !optional.includes(key))
  )
    bad("invalid-shape");
  return root;
}

/**
 * True when the value carries one of DocsFab's own configured credentials, in
 * any string key or value, matched exactly; the caller refuses with its code.
 *
 * Text that only looks like a credential is not refused (#1807). Given a
 * `location`, each `DOCUMENT_CREDENTIAL_SHAPES` rule that matches a string
 * value is recorded there as a `credential-like-content` finding. Patches and
 * run records quote example credentials in documentation, which is why the
 * document list flags them. Without a location, nothing is recorded.
 */
export function containsCredentialDeep(value: unknown, location?: string): boolean {
  if (location === undefined) return findConfiguredCredentialInValue(value) !== null;
  return (
    screenCredentialValue(value, location, (screened) =>
      ruleIdsInValue(screened, documentShapeRuleIds),
    ) !== null
  );
}

export function httpsUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) bad("invalid-url");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    bad("invalid-url");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash)
    bad("invalid-url");
  return parsed.href.replace(/\/$/u, "");
}

export function boundedString(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.includes("\0")
  )
    bad("invalid-string");
  return value;
}
export function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") bad("invalid-boolean");
  return value;
}

export function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    bad("invalid-shape");
  const root = value as Record<string, unknown>;
  if (Object.keys(root).length !== keys.length || keys.some((key) => !Object.hasOwn(root, key)))
    bad("invalid-shape");
  return root;
}
export function id(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) bad("invalid-identifier");
  return value;
}
export function segment(value: unknown): string {
  if (typeof value !== "string" || !SAFE_SEGMENT.test(value)) bad("invalid-path-segment");
  return value;
}
export function sha(value: unknown): string {
  if (typeof value !== "string" || !SHA.test(value)) bad("invalid-digest");
  return value;
}
export function objectId(value: unknown): string {
  if (typeof value !== "string" || !OBJECT_ID.test(value)) bad("invalid-revision");
  return value;
}
export function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) bad("invalid-number");
  return value as number;
}
export function counter(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) bad("invalid-number");
  return value as number;
}

export function writePath(value: unknown, allowDirectoryPrefix: boolean): string {
  if (typeof value === "string" && containsCredentialDeep(value, "hosted-write-path"))
    bad("credential-material");
  if (typeof value !== "string" || value.length < 1 || value.length > 512)
    bad("invalid-write-path");
  const directory = value.endsWith("/");
  if (directory && !allowDirectoryPrefix) bad("invalid-write-path");
  const body = directory ? value.slice(0, -1) : value;
  if (
    body.length < 1 ||
    body.normalize("NFC") !== body ||
    body.startsWith("/") ||
    body.startsWith("~") ||
    body.includes("\\") ||
    // eslint-disable-next-line no-control-regex
    /[\x00-]/u.test(body) ||
    body.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    bad("invalid-write-path");
  return value;
}

/**
 * Prefix containment that cannot be satisfied by a sibling name.
 *
 * A ceiling entry ending in `/` covers its subtree; any other entry covers
 * exactly itself. Without the explicit separator, a `docs` ceiling would admit
 * `docs-internal/secret.md`.
 */
export function withinWriteCeiling(path: string, ceiling: readonly string[]): boolean {
  return ceiling.some((entry) =>
    entry.endsWith("/") ? path.startsWith(entry) && path.length > entry.length : path === entry,
  );
}
export function nonnegative(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) bad("invalid-number");
  return value as number;
}
export function absolutePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.includes("\0") ||
    value.includes("..")
  )
    bad("invalid-path");
  return value;
}
export function timestamp(value: unknown): string {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) bad("invalid-time");
  return value;
}
export function tool(value: unknown): string {
  if (typeof value !== "string" || !SAFE_TOOL.test(value)) bad("invalid-tool");
  return value;
}
export function enumeration<const T extends readonly string[]>(
  value: unknown,
  values: T,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) bad("invalid-enum");
  return value as T[number];
}
export function bad(code: string): never {
  throw new HostRuntimeContractError(code);
}
