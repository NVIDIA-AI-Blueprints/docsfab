// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  screenCredentialText,
  tokenPrefixRuleIds,
} from "../../security/credential-shape-findings.js";
import { dnsHostnamePattern } from "../../shared/dns-hostname.js";
import { compareText } from "../../shared/primitives.js";

export interface RoadmapSchemaMigrationRule {
  kind: "roadmap-schema-migration";
  fromVersion: number;
  toVersion: number;
  compatibility: "additive" | "breaking";
  defaultsDigest?: string;
  migratorId?: string;
  rationaleDigest: string;
}

export type RoadmapContractErrorCode =
  | "invalid-type"
  | "unknown-field"
  | "missing-field"
  | "invalid-value"
  | "invalid-time"
  | "unsafe-path"
  | "duplicate-id"
  | "unresolved-reference"
  | "invalid-transition"
  | "unresolved-dependency"
  | "dependency-cycle"
  | "digest-mismatch"
  | "repository-mismatch"
  | "project-mismatch"
  | "tracker-drift"
  | "expired"
  | "operation-expansion"
  | "replan-required"
  | "ambiguous-effect"
  | "invalid-migration";

export class RoadmapContractError extends Error {
  public constructor(
    public readonly code: RoadmapContractErrorCode,
    public readonly path: string,
  ) {
    super(`Roadmap contract validation failed: ${code} at ${path}`);
    this.name = "RoadmapContractError";
  }
}

const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const IDENTIFIER = /^[a-z0-9](?:[a-z0-9._:/-]{0,255})$/u;
const PROVIDER_IDENTIFIER = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/u;
const EXTERNAL_IDENTIFIER = /^(?:[1-9][0-9]{0,19}|[a-f0-9]{40}|[a-f0-9]{64})$/u;
/**
 * Whether a roadmap identifier carries DocsFab's own configured credential,
 * matched exactly, which refuses (#1807). An identifier that only starts like
 * an issuer token, such as `sk-`, is recorded as a `credential-like-content`
 * finding at its path and continues.
 */
function identifierCarriesConfiguredCredential(value: string, path: string): boolean {
  return (
    screenCredentialText(value, `roadmap:${path}`, (text) =>
      tokenPrefixRuleIds(text, { anchored: true }),
    ) !== null
  );
}
const HOST = dnsHostnamePattern({ singleLabel: true });
const ROADMAP_SET_FIELDS = new Set([
  "tracker",
  "evidence",
  "findings",
  "workstreams",
  "dedup",
  "transitions",
  "sweeps",
  "closeouts",
  "affectedPaths",
  "evidenceIds",
  "dependsOnFindingIds",
  "findingIds",
  "dependsOnWorkstreamIds",
  "collidesWithWorkstreamIds",
  "findingFingerprints",
  "newFindingIds",
  "operations",
  "dependsOnOperationKeys",
  "authorizedOperationKeys",
  "labelNames",
  "changedFields",
  "add",
  "remove",
]);

export type JsonObject = Record<string, unknown>;

export function roadmapCanonicalJson(value: unknown): string {
  return JSON.stringify(canonicalRoadmapValue(value, "$", new WeakSet<object>()));
}

export function roadmapDigest(value: object): string {
  const { digest: _digest, ...digestible } = value as Record<string, unknown>;
  return createHash("sha256").update(roadmapCanonicalJson(digestible)).digest("hex");
}

export function validateRoadmapSchemaMigrationRule(value: unknown): RoadmapSchemaMigrationRule {
  const root = closed(
    value,
    "$",
    [
      "kind",
      "fromVersion",
      "toVersion",
      "compatibility",
      "defaultsDigest",
      "migratorId",
      "rationaleDigest",
    ],
    ["kind", "fromVersion", "toVersion", "compatibility", "rationaleDigest"],
  );
  requireValue(root.kind === "roadmap-schema-migration", "invalid-migration", "$.kind");
  const rule: RoadmapSchemaMigrationRule = {
    kind: "roadmap-schema-migration",
    fromVersion: positiveInteger(root.fromVersion, "$.fromVersion"),
    toVersion: positiveInteger(root.toVersion, "$.toVersion"),
    compatibility: enumeration(
      root.compatibility,
      ["additive", "breaking"] as const,
      "$.compatibility",
    ),
    ...(root.defaultsDigest === undefined
      ? {}
      : { defaultsDigest: digest(root.defaultsDigest, "$.defaultsDigest") }),
    ...(root.migratorId === undefined
      ? {}
      : { migratorId: identifier(root.migratorId, "$.migratorId") }),
    rationaleDigest: digest(root.rationaleDigest, "$.rationaleDigest"),
  };
  requireValue(rule.toVersion === rule.fromVersion + 1, "invalid-migration", "$.toVersion");
  if (rule.compatibility === "additive") {
    requireValue(
      rule.defaultsDigest !== undefined && rule.migratorId === undefined,
      "invalid-migration",
      "$",
    );
  } else {
    requireValue(
      rule.migratorId !== undefined && rule.defaultsDigest === undefined,
      "invalid-migration",
      "$",
    );
  }
  return freeze(rule);
}

function closed(
  value: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): JsonObject {
  requireValue(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
    "invalid-type",
    path,
  );
  const item = value as JsonObject;
  for (const key of Object.keys(item))
    requireValue(allowed.includes(key), "unknown-field", `${path}.${key}`);
  for (const key of required)
    requireValue(Object.hasOwn(item, key), "missing-field", `${path}.${key}`);
  return item;
}

function array(value: unknown, path: string): unknown[] {
  requireValue(Array.isArray(value), "invalid-type", path);
  return value;
}

function safeText(value: unknown, path: string): string {
  requireValue(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 4_096 &&
      value === value.normalize("NFC") &&
      !/[\0\r\n]/u.test(value),
    "invalid-value",
    path,
  );
  return value;
}

function identifier(value: unknown, path: string): string {
  const result = safeText(value, path);
  requireValue(
    IDENTIFIER.test(result) && !identifierCarriesConfiguredCredential(result, path),
    "invalid-value",
    path,
  );
  return result;
}

function externalIdentifier(value: unknown, path: string): string {
  const result = safeText(value, path);
  requireValue(EXTERNAL_IDENTIFIER.test(result), "invalid-value", path);
  return result;
}

function timestamp(value: unknown, path: string): string {
  const result = safeText(value, path);
  const parsed = new Date(result);
  requireValue(
    !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === result,
    "invalid-time",
    path,
  );
  return result;
}

function dateOnly(value: unknown, path: string): string {
  const result = safeText(value, path);
  requireValue(
    /^\d{4}-\d{2}-\d{2}$/u.test(result) &&
      new Date(`${result}T00:00:00.000Z`).toISOString().startsWith(result),
    "invalid-time",
    path,
  );
  return result;
}

function digest(value: unknown, path: string): string {
  const result = safeText(value, path);
  requireValue(SHA256.test(result), "invalid-value", path);
  return result;
}

function revision(value: unknown, path: string): string {
  const result = safeText(value, path);
  requireValue(REVISION.test(result), "invalid-value", path);
  return result;
}

function positiveInteger(value: unknown, path: string): number {
  requireValue(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    "invalid-value",
    path,
  );
  return value;
}

function enumeration<T extends string>(value: unknown, values: readonly T[], path: string): T {
  requireValue(typeof value === "string" && values.includes(value as T), "invalid-value", path);
  return value as T;
}

function safePath(value: unknown, path: string): string {
  const result = safeText(value, path);
  requireValue(
    !isAbsolute(result) &&
      !/^[A-Za-z]:/u.test(result) &&
      !result.includes("\\") &&
      result.split("/").every((part) => part && part !== "." && part !== ".."),
    "unsafe-path",
    path,
  );
  return result;
}

function idArray(value: unknown, path: string): string[] {
  const result = array(value, path).map((item, index) => identifier(item, `${path}[${index}]`));
  requireUnique(result, path);
  return result;
}

function identifierArray(value: unknown, path: string): string[] {
  return idArray(value, path).sort(compareText);
}

function enumerationArray<T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
): T[] {
  const result = array(value, path).map((item, index) =>
    enumeration(item, values, `${path}[${index}]`),
  );
  requireUnique(result, path);
  return result.sort(compareText);
}

function digestArray(value: unknown, path: string): string[] {
  const result = array(value, path).map((item, index) => digest(item, `${path}[${index}]`));
  requireUnique(result, path);
  return result;
}

function pathArray(value: unknown, path: string): string[] {
  const result = array(value, path).map((item, index) => safePath(item, `${path}[${index}]`));
  requireUnique(result, path);
  return result;
}

function requireUnique(values: readonly string[], path: string): void {
  requireValue(new Set(values).size === values.length, "duplicate-id", path);
}

function requireReferences(
  values: readonly string[],
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const value of values) requireValue(allowed.has(value), "unresolved-reference", path);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function assertAcyclic(
  ids: readonly string[],
  dependencies: (id: string) => readonly string[],
  path: string,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    requireValue(!visiting.has(id), "dependency-cycle", path);
    visiting.add(id);
    for (const dependency of dependencies(id)) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  ids.forEach(visit);
}

function requireValue(
  condition: unknown,
  code: RoadmapContractErrorCode,
  path: string,
): asserts condition {
  if (!condition) throw new RoadmapContractError(code, path);
}

function compareRoadmap(left: unknown, right: unknown): number {
  const leftJson = roadmapCanonicalJson(left);
  const rightJson = roadmapCanonicalJson(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}

function canonicalRoadmapValue(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
  parentField?: string,
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    requireValue(Number.isFinite(value), "invalid-type", path);
    return Object.is(value, -0) ? 0 : value;
  }
  requireValue(typeof value === "object", "invalid-type", path);
  requireValue(!seen.has(value), "invalid-type", path);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      requireValue(Object.keys(value).length === value.length, "invalid-type", path);
      const entries = value.map((item, index) =>
        canonicalRoadmapValue(item, `${path}[${index}]`, seen),
      );
      return ROADMAP_SET_FIELDS.has(parentField ?? "") ? entries.sort(compareRoadmap) : entries;
    }
    requireValue(Object.getPrototypeOf(value) === Object.prototype, "invalid-type", path);
    requireValue(
      !Reflect.ownKeys(value).some((key) => typeof key === "symbol"),
      "invalid-type",
      path,
    );
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, canonicalRoadmapValue(child, `${path}.${key}`, seen, key)]),
    );
  } finally {
    seen.delete(value);
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}

/**
 * @internal Shared, frozen decoder primitives for focused roadmap contract owners.
 * This surface is intentionally absent from the public roadmap entrypoint.
 */
export const internalRoadmapDecode = Object.freeze({
  closed,
  array,
  safeText,
  identifier,
  externalIdentifier,
  timestamp,
  dateOnly,
  digest,
  revision,
  positiveInteger,
  enumeration,
  safePath,
  idArray,
  identifierArray,
  enumerationArray,
  digestArray,
  pathArray,
  requireUnique,
  requireReferences,
  sameStringSet,
  assertAcyclic,
  requireValue,
  compareRoadmap,
  compareText,
  freeze,
  constants: Object.freeze({
    SHA256,
    REVISION,
    IDENTIFIER,
    PROVIDER_IDENTIFIER,
    EXTERNAL_IDENTIFIER,
    HOST,
  }),
  identifierCarriesConfiguredCredential,
});
