// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Structural shape fingerprint of a rejected model reply.
 *
 * Rejected model prose is not retained, so the fingerprint carries only the
 * reply's structure: whether and where parsing stopped, which keys it used, the
 * type at each key path, and array and string lengths.
 *
 * Content-free by construction:
 *
 * - String values are never read beyond their length: no prefix, suffix,
 *   digest, or sample reaches the fingerprint.
 * - A key is named only when a host response contract declares it, it is a
 *   plain identifier within the segment bound, and it matches no credential
 *   rule. Every other key is written as `<undeclared>`.
 * - Numbers, booleans, and nulls are recorded by type only.
 *
 * Depth and distinct entries are bounded by catalog entries; whatever a bound
 * leaves out is counted in `truncation` with the limit that left it out.
 */

import {
  MAX_INFERENCE_REJECTION_SEGMENT_LENGTH,
  MAX_REJECTED_REPLY_SHAPE_DEPTH,
  MAX_REJECTED_REPLY_SHAPE_ENTRIES,
  REJECTED_REPLY_SHAPE_DECODE_CEILINGS,
} from "../config/inference-rejection-limits.js";
import {
  JsonEvidenceError,
  parseJsonEvidence,
  type JsonEvidenceErrorCode,
  type JsonEvidenceSyntaxDetail,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import { detectCredentialRuleIds } from "../security/repository-scanner.js";

export const REJECTED_REPLY_VALUE_TYPES = [
  "object",
  "array",
  "string",
  "number",
  "boolean",
  "null",
] as const;
export type RejectedReplyValueType = (typeof REJECTED_REPLY_VALUE_TYPES)[number];

/**
 * Current fingerprint schema. Readers that cannot validate a fingerprint in
 * full (the local-workflows report) print keys only from this version.
 */
export { REJECTED_REPLY_SHAPE_SCHEMA_VERSION } from "./response-contract-keys.js";

export const UNDECLARED_REPLY_KEY = "<undeclared>";

export const REJECTED_REPLY_SHAPE_LIMITS = {
  depth: "inference.rejectedReplyShapeMaxDepth",
  entries: "inference.rejectedReplyShapeMaxEntries",
} as const;

/** One distinct (key path, value type) pair seen in the reply. */
export interface RejectedReplyShapePathV1 {
  /**
   * `$`-rooted key path. Array members share one `[]` segment and an unlisted
   * key reads `.<undeclared>`, so a path never copies a value.
   */
  readonly path: string;
  readonly type: RejectedReplyValueType;
  readonly count: number;
  /** Strings: characters. Arrays: members. Absent for every other type. */
  readonly minLength?: number;
  readonly maxLength?: number;
}

/** What one bound left out. Present only when that bound was reached. */
export interface RejectedReplyShapeTruncationV1 {
  readonly limit: (typeof REJECTED_REPLY_SHAPE_LIMITS)[keyof typeof REJECTED_REPLY_SHAPE_LIMITS];
  /** The bound in force when the fingerprint was written. */
  readonly bound: number;
  /**
   * `containers`: objects or arrays at the depth bound whose members were not
   * described. `paths`: distinct path/type pairs not listed. `top-level-keys`:
   * top-level keys not listed because the entry bound was reached.
   */
  readonly scope: "containers" | "paths" | "top-level-keys";
  readonly omitted: number;
}

export type RejectedReplyParseV1 =
  | { readonly status: "parsed" }
  | {
      readonly status: "failed";
      readonly code: JsonEvidenceErrorCode;
      readonly detail?: JsonEvidenceSyntaxDetail;
      /** Character index where the strict parser stopped, when it reported one. */
      readonly offset?: number;
    };

export interface InferenceRejectedReplyShapeV1 {
  readonly schemaVersion: 1;
  /** Characters in the reply the decoder saw, after surrounding whitespace was trimmed. */
  readonly replyChars: number;
  readonly parse: RejectedReplyParseV1;
  /** Present exactly when the reply parsed. */
  readonly root?: RejectedReplyValueType;
  /** Present exactly when the root is an object: every top-level key, listed ones by name. */
  readonly topLevelKeyCount?: number;
  /** Present exactly when the root is an object: the listed top-level keys, in reply order. */
  readonly topLevelKeys?: readonly string[];
  /**
   * Keys at any depth written as `<undeclared>`: not declared by a host
   * response contract, not a plain identifier, or credential-shaped. Kept
   * apart from keys a bound left out, which `truncation` counts.
   */
  readonly undeclaredKeys: number;
  /** Distinct path/type pairs in first-seen (document) order; empty when the reply did not parse. */
  readonly paths: readonly RejectedReplyShapePathV1[];
  readonly truncation?: readonly RejectedReplyShapeTruncationV1[];
}

const LISTED_KEY = new RegExp(
  `^[A-Za-z][A-Za-z0-9_]{0,${MAX_INFERENCE_REJECTION_SEGMENT_LENGTH - 1}}$`,
  "u",
);

/** Decides whether a host response contract declares a key. */
export type DeclaredReplyKey = (key: string) => boolean;

function listedKey(key: string, isDeclared: DeclaredReplyKey): string | undefined {
  return LISTED_KEY.test(key) && isDeclared(key) && detectCredentialRuleIds(key).length === 0
    ? key
    : undefined;
}

function valueType(value: JsonEvidenceValue): RejectedReplyValueType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
}

function parseFailure(error: unknown): RejectedReplyParseV1 {
  if (!(error instanceof JsonEvidenceError)) return { status: "failed", code: "malformed-json" };
  return {
    status: "failed",
    code: error.code,
    ...(error.detail ? { detail: error.detail } : {}),
    ...(error.offset !== undefined ? { offset: error.offset } : {}),
  };
}

interface MutablePath {
  path: string;
  type: RejectedReplyValueType;
  count: number;
  minLength?: number;
  maxLength?: number;
}

/** Resolved catalog bounds; each falls back to the catalog value when absent. */
export interface RejectedReplyShapeBounds {
  readonly maxDepth?: number;
  readonly maxEntries?: number;
}

/**
 * Project a rejected reply onto its content-free structural fingerprint.
 *
 * `reply` is the text the response decoders saw. The result never contains a
 * character of any string value in it. Total: every input yields a
 * fingerprint, so describing a failure cannot itself fail.
 */
export function fingerprintRejectedReply(
  reply: string,
  isDeclared: DeclaredReplyKey,
  bounds: RejectedReplyShapeBounds = {},
): InferenceRejectedReplyShapeV1 {
  const maxDepth = bounds.maxDepth ?? MAX_REJECTED_REPLY_SHAPE_DEPTH;
  const maxEntries = bounds.maxEntries ?? MAX_REJECTED_REPLY_SHAPE_ENTRIES;
  const text = reply.trim();
  let parsed: JsonEvidenceValue;
  try {
    parsed = parseJsonEvidence(text);
  } catch (error) {
    return {
      schemaVersion: 1,
      replyChars: text.length,
      parse: parseFailure(error),
      undeclaredKeys: 0,
      paths: [],
    };
  }

  const entries = new Map<string, MutablePath>();
  const omittedPaths = new Set<string>();
  let undescribedContainers = 0;
  let undeclaredKeys = 0;

  const record = (path: string, value: JsonEvidenceValue): void => {
    const type = valueType(value);
    const id = `${type}\u0000${path}`;
    let entry = entries.get(id);
    if (!entry) {
      if (entries.size >= maxEntries) {
        omittedPaths.add(id);
        return;
      }
      entry = { path, type, count: 0 };
      entries.set(id, entry);
    }
    entry.count += 1;
    const length =
      typeof value === "string" ? value.length : Array.isArray(value) ? value.length : undefined;
    if (length !== undefined) {
      entry.minLength = entry.minLength === undefined ? length : Math.min(entry.minLength, length);
      entry.maxLength = entry.maxLength === undefined ? length : Math.max(entry.maxLength, length);
    }
  };

  // Iterative pre-order walk, so a deeply nested reply cannot exhaust the stack
  // and paths keep document order.
  const stack: Array<{ path: string; value: JsonEvidenceValue; depth: number }> = [
    { path: "$", value: parsed, depth: 0 },
  ];
  while (stack.length > 0) {
    const { path, value, depth } = stack.pop()!;
    record(path, value);
    if (value === null || typeof value !== "object") continue;
    const members: Array<{ path: string; value: JsonEvidenceValue }> = [];
    if (Array.isArray(value)) {
      for (const member of value) members.push({ path: `${path}[]`, value: member });
    } else {
      for (const [key, member] of Object.entries(value)) {
        const listed = listedKey(key, isDeclared);
        if (listed === undefined) undeclaredKeys += 1;
        members.push({ path: `${path}.${listed ?? UNDECLARED_REPLY_KEY}`, value: member });
      }
    }
    if (members.length === 0) continue;
    if (depth >= maxDepth) {
      undescribedContainers += 1;
      continue;
    }
    for (let index = members.length - 1; index >= 0; index -= 1) {
      stack.push({ ...members[index]!, depth: depth + 1 });
    }
  }

  const root = valueType(parsed);
  let topLevel: { count: number; listed: string[]; omitted: number } | undefined;
  if (root === "object") {
    const keys = Object.keys(parsed as Record<string, JsonEvidenceValue>);
    const named = keys.flatMap((key) => {
      const listed = listedKey(key, isDeclared);
      return listed === undefined ? [] : [listed];
    });
    const listed = named.slice(0, maxEntries);
    topLevel = { count: keys.length, listed, omitted: named.length - listed.length };
  }

  const truncation: RejectedReplyShapeTruncationV1[] = [];
  if (undescribedContainers > 0) {
    truncation.push({
      limit: REJECTED_REPLY_SHAPE_LIMITS.depth,
      bound: maxDepth,
      scope: "containers",
      omitted: undescribedContainers,
    });
  }
  if (omittedPaths.size > 0) {
    truncation.push({
      limit: REJECTED_REPLY_SHAPE_LIMITS.entries,
      bound: maxEntries,
      scope: "paths",
      omitted: omittedPaths.size,
    });
  }
  if (topLevel && topLevel.omitted > 0) {
    truncation.push({
      limit: REJECTED_REPLY_SHAPE_LIMITS.entries,
      bound: maxEntries,
      scope: "top-level-keys",
      omitted: topLevel.omitted,
    });
  }

  return {
    schemaVersion: 1,
    replyChars: text.length,
    parse: { status: "parsed" },
    root,
    ...(topLevel ? { topLevelKeyCount: topLevel.count, topLevelKeys: topLevel.listed } : {}),
    undeclaredKeys,
    paths: [...entries.values()].map((entry) => ({
      path: entry.path,
      type: entry.type,
      count: entry.count,
      ...(entry.minLength === undefined
        ? {}
        : { minLength: entry.minLength, maxLength: entry.maxLength! }),
    })),
    ...(truncation.length > 0 ? { truncation } : {}),
  };
}

/**
 * Rewrite a decoded fingerprint so it names only keys `isDeclared` accepts.
 * Display and envelope surfaces call this before a stored fingerprint reaches
 * an operator, so a hand-edited record cannot put an undeclared key on the
 * terminal or into `--json`. Paths that collapse onto one `<undeclared>` path
 * are merged.
 */
export function canonicalizeRejectedReplyShape(
  shape: InferenceRejectedReplyShapeV1,
  isDeclared: DeclaredReplyKey,
): InferenceRejectedReplyShapeV1 {
  const topLevelKeys = shape.topLevelKeys?.filter((key) => isDeclared(key));
  const dropped = (shape.topLevelKeys?.length ?? 0) - (topLevelKeys?.length ?? 0);
  const merged = new Map<string, MutablePath>();
  for (const entry of shape.paths) {
    const path = entry.path.replace(/\.([A-Za-z][A-Za-z0-9_]*)/gu, (segment, name: string) =>
      isDeclared(name) ? segment : `.${UNDECLARED_REPLY_KEY}`,
    );
    const id = `${entry.type}\u0000${path}`;
    const prior = merged.get(id);
    if (!prior) {
      merged.set(id, { ...entry, path });
      continue;
    }
    prior.count += entry.count;
    if (entry.minLength !== undefined && prior.minLength !== undefined) {
      prior.minLength = Math.min(prior.minLength, entry.minLength);
      prior.maxLength = Math.max(prior.maxLength!, entry.maxLength!);
    }
  }
  return {
    ...shape,
    ...(topLevelKeys ? { topLevelKeys } : {}),
    undeclaredKeys: shape.undeclaredKeys + dropped,
    paths: [...merged.values()],
  };
}

// Decoding: one closed validator every record decoder shares.

const JSON_EVIDENCE_ERROR_CODES: readonly JsonEvidenceErrorCode[] = [
  "invalid-utf8",
  "malformed-json",
  "duplicate-key",
  "unsafe-number",
  "noncanonical-json",
];
const JSON_EVIDENCE_SYNTAX_DETAILS: readonly JsonEvidenceSyntaxDetail[] = [
  "unexpected-end",
  "unexpected-token",
  "invalid-escape",
  "unescaped-control",
  "unpaired-surrogate",
];
const TRUNCATION_SCOPES = ["containers", "paths", "top-level-keys"] as const;

const PATH_SEGMENT = new RegExp(
  `^(?:\\.(?:[A-Za-z][A-Za-z0-9_]{0,${MAX_INFERENCE_REJECTION_SEGMENT_LENGTH - 1}}|${UNDECLARED_REPLY_KEY})|\\[\\])`,
  "u",
);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isShapePath(path: unknown): boolean {
  if (typeof path !== "string" || !path.startsWith("$")) return false;
  let rest = path.slice(1);
  let segments = 0;
  while (rest.length > 0) {
    const match = PATH_SEGMENT.exec(rest);
    if (!match) return false;
    // The reader applies the writer's credential-key policy, so a forged
    // record cannot restore a key the writer would have suppressed.
    const name = match[0].startsWith(".") ? match[0].slice(1) : undefined;
    if (
      name !== undefined &&
      name !== UNDECLARED_REPLY_KEY &&
      detectCredentialRuleIds(name).length > 0
    ) {
      return false;
    }
    rest = rest.slice(match[0].length);
    segments += 1;
    if (segments > REJECTED_REPLY_SHAPE_DECODE_CEILINGS.depth) return false;
  }
  return true;
}

function isShapePathEntry(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, ["path", "type", "count", "minLength", "maxLength"])) return false;
  if (!isShapePath(value.path)) return false;
  if (!(REJECTED_REPLY_VALUE_TYPES as readonly unknown[]).includes(value.type)) return false;
  if (!isCount(value.count) || value.count === 0) return false;
  const measured = value.type === "string" || value.type === "array";
  if (measured) {
    return (
      isCount(value.minLength) && isCount(value.maxLength) && value.minLength <= value.maxLength
    );
  }
  return value.minLength === undefined && value.maxLength === undefined;
}

function isTruncation(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, ["limit", "bound", "scope", "omitted"])) return false;
  if (!(TRUNCATION_SCOPES as readonly unknown[]).includes(value.scope)) return false;
  if (!isCount(value.omitted) || value.omitted === 0 || !isCount(value.bound)) return false;
  return value.scope === "containers"
    ? value.limit === REJECTED_REPLY_SHAPE_LIMITS.depth &&
        value.bound <= REJECTED_REPLY_SHAPE_DECODE_CEILINGS.depth
    : value.limit === REJECTED_REPLY_SHAPE_LIMITS.entries &&
        value.bound <= REJECTED_REPLY_SHAPE_DECODE_CEILINGS.entries;
}

function isParse(value: unknown): value is RejectedReplyParseV1 {
  if (!isPlainObject(value)) return false;
  if (value.status === "parsed") return hasOnlyKeys(value, ["status"]);
  if (value.status !== "failed") return false;
  if (!hasOnlyKeys(value, ["status", "code", "detail", "offset"])) return false;
  if (!(JSON_EVIDENCE_ERROR_CODES as readonly unknown[]).includes(value.code)) return false;
  if (
    value.detail !== undefined &&
    !(JSON_EVIDENCE_SYNTAX_DETAILS as readonly unknown[]).includes(value.detail)
  ) {
    return false;
  }
  return value.offset === undefined || isCount(value.offset);
}

/**
 * Whether `value` is a well-formed, content-free fingerprint.
 *
 * Closed keys, closed vocabularies, and the path grammar leave a forged record
 * no free-form field to carry reply text. Bounds are checked against each
 * catalog entry's ceiling, so lowering a value later leaves older records
 * readable.
 */
export function isInferenceRejectedReplyShape(
  value: unknown,
): value is InferenceRejectedReplyShapeV1 {
  if (!isPlainObject(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "schemaVersion",
      "replyChars",
      "parse",
      "root",
      "topLevelKeyCount",
      "topLevelKeys",
      "undeclaredKeys",
      "paths",
      "truncation",
    ])
  ) {
    return false;
  }
  if (value.schemaVersion !== 1 || !isCount(value.replyChars) || !isCount(value.undeclaredKeys)) {
    return false;
  }
  if (!isParse(value.parse)) return false;
  if (!Array.isArray(value.paths) || !value.paths.every(isShapePathEntry)) return false;
  if (value.paths.length > REJECTED_REPLY_SHAPE_DECODE_CEILINGS.entries) return false;
  if (
    value.truncation !== undefined &&
    (!Array.isArray(value.truncation) ||
      value.truncation.length === 0 ||
      !value.truncation.every(isTruncation))
  ) {
    return false;
  }
  if (value.parse.status === "failed") {
    return (
      value.root === undefined &&
      value.topLevelKeyCount === undefined &&
      value.topLevelKeys === undefined &&
      value.undeclaredKeys === 0 &&
      value.paths.length === 0 &&
      value.truncation === undefined
    );
  }
  if (!(REJECTED_REPLY_VALUE_TYPES as readonly unknown[]).includes(value.root)) return false;
  if (value.root !== "object") {
    return value.topLevelKeyCount === undefined && value.topLevelKeys === undefined;
  }
  return (
    isCount(value.topLevelKeyCount) &&
    Array.isArray(value.topLevelKeys) &&
    value.topLevelKeys.length <= value.topLevelKeyCount &&
    value.topLevelKeys.length <= REJECTED_REPLY_SHAPE_DECODE_CEILINGS.entries &&
    value.topLevelKeys.every(
      (key) => isShapePath(`$.${String(key)}`) && key !== UNDECLARED_REPLY_KEY,
    )
  );
}
