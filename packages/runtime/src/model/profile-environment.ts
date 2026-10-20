// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { deepFreeze } from "../contract-kit/freeze.js";
import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import type { ModelProfile } from "./configuration.js";
import { detectCredentialRuleIdsInValue } from "../security/repository-scanner.js";
import type { ModelProfilePurpose } from "./catalog-contracts.js";
import { sha256 } from "../content-ir/canonical.js";

export const PROFILE_ENVIRONMENT_SCHEMA_VERSION = 1 as const;

export type ProfileEnvironmentPrefix = "MODEL" | "JUDGE";

export interface ProfileEnvironmentChangeV1 {
  key: string;
  before: string | null;
  after: string;
}

/**
 * Credential-free evidence for a deterministic dotenv projection. The
 * rendered dotenv bytes are deliberately returned beside, rather than inside,
 * this artifact so callers cannot accidentally retain unrelated settings or
 * credentials as approval evidence.
 */
export interface ProfileEnvironmentPatchV1 {
  schemaVersion: typeof PROFILE_ENVIRONMENT_SCHEMA_VERSION;
  kind: "docsfab-profile-environment-patch";
  purpose: ModelProfilePurpose;
  prefix: ProfileEnvironmentPrefix;
  beforeSha256: string;
  afterSha256: string;
  changedKeys: string[];
  changes: ProfileEnvironmentChangeV1[];
  reverse: {
    operations: Array<{
      start: number;
      end: number;
      beforeToken: string;
      afterToken: string;
    }>;
    appended: { start: number; end: number; sha256: string } | null;
  };
  sha256: string;
}

export interface ProfileEnvironmentPatchResult {
  /** Exact post-image. This is mutation input, not durable evidence. */
  bytes: Uint8Array;
  patch: ProfileEnvironmentPatchV1;
}

export class ProfileEnvironmentError extends Error {
  readonly code = "invalid-profile-environment" as const;

  constructor(options?: ErrorOptions) {
    super("The dotenv input is malformed, ambiguous, or contains an accessor expression.", options);
    this.name = "ProfileEnvironmentError";
  }
}

export function decodeProfileEnvironmentPatch(
  value: string | Uint8Array | unknown,
): ProfileEnvironmentPatchV1 {
  try {
    const parsed =
      typeof value === "string" || value instanceof Uint8Array ? parseJsonEvidence(value) : value;
    assertPlainTree(parsed);
    const patch = structuredClone(parsed) as ProfileEnvironmentPatchV1;
    const record = plainRecord(patch);
    exactKeys(record, [
      "schemaVersion",
      "kind",
      "purpose",
      "prefix",
      "beforeSha256",
      "afterSha256",
      "changedKeys",
      "changes",
      "reverse",
      "sha256",
    ]);
    if (
      patch.schemaVersion !== 1 ||
      patch.kind !== "docsfab-profile-environment-patch" ||
      (patch.purpose !== "policy" && patch.purpose !== "judge") ||
      patch.prefix !== prefixFor(patch.purpose) ||
      !hexDigest(patch.beforeSha256) ||
      !hexDigest(patch.afterSha256) ||
      !hexDigest(patch.sha256) ||
      !Array.isArray(patch.changedKeys) ||
      !Array.isArray(patch.changes)
    )
      invalid();
    const allowed = new Set(profileEnvironmentKeys(patch.purpose));
    if (
      patch.changedKeys.length !== patch.changes.length ||
      new Set(patch.changedKeys).size !== patch.changedKeys.length
    )
      invalid();
    for (let index = 0; index < patch.changes.length; index += 1) {
      const change = required(patch.changes[index]);
      exactKeys(plainRecord(change), ["key", "before", "after"]);
      if (
        change.key !== patch.changedKeys[index] ||
        !allowed.has(change.key) ||
        (change.before !== null && typeof change.before !== "string") ||
        typeof change.after !== "string" ||
        change.before === change.after
      )
        invalid();
      if (change.before !== null) safeOriginalValue(change.before);
      safeProjectedValue(change.after);
    }
    const reverse = plainRecord(patch.reverse);
    exactKeys(reverse, ["operations", "appended"]);
    if (!Array.isArray(patch.reverse.operations)) invalid();
    const replaced = patch.changes.filter((change) => change.before !== null);
    if (patch.reverse.operations.length !== replaced.length) invalid();
    let priorEnd = 0;
    for (let index = 0; index < patch.reverse.operations.length; index += 1) {
      const operation = required(patch.reverse.operations[index]);
      exactKeys(plainRecord(operation), ["start", "end", "beforeToken", "afterToken"]);
      const change = required(replaced[index]);
      if (
        !Number.isSafeInteger(operation.start) ||
        !Number.isSafeInteger(operation.end) ||
        operation.start < priorEnd ||
        operation.start < 0 ||
        operation.end < operation.start ||
        typeof operation.beforeToken !== "string" ||
        typeof operation.afterToken !== "string" ||
        Buffer.byteLength(operation.afterToken) !== operation.end - operation.start ||
        tokenValue(operation.beforeToken) !== change.before ||
        tokenValue(operation.afterToken) !== change.after
      )
        invalid();
      priorEnd = operation.end;
    }
    const inserted = patch.changes.some((change) => change.before === null);
    if (patch.reverse.appended === null) {
      if (inserted) invalid();
    } else {
      const appended = patch.reverse.appended;
      exactKeys(plainRecord(appended), ["start", "end", "sha256"]);
      if (
        !inserted ||
        !Number.isSafeInteger(appended.start) ||
        !Number.isSafeInteger(appended.end) ||
        appended.start < priorEnd ||
        appended.end <= appended.start ||
        !hexDigest(appended.sha256)
      )
        invalid();
    }
    const unsigned = { ...record };
    delete unsigned.sha256;
    if (
      sha256(Buffer.from(canonicalizeJsonEvidence(unsigned as unknown as JsonEvidenceValue))) !==
        patch.sha256 ||
      detectCredentialRuleIdsInValue(patch).length > 0
    )
      invalid();
    return deepFreeze(patch);
  } catch (error) {
    rethrowPreservedOrWrap(error);
  }
}

const PROFILE_SUFFIXES = [
  "CONTEXT_WINDOW",
  "MAX_INPUT_TOKENS",
  "MAX_OUTPUT_TOKENS",
  "REASONING",
  "INPUT_TYPES",
  "SUPPORTS_DEVELOPER_ROLE",
  "SUPPORTS_REASONING_EFFORT",
  "COMPATIBLE_API_FORMATS",
  "INPUT_COST_PER_MILLION",
  "OUTPUT_COST_PER_MILLION",
  "CACHE_READ_COST_PER_MILLION",
  "CACHE_WRITE_COST_PER_MILLION",
  "PROFILE_APPROVED_SOURCE",
  "PROFILE_EFFECTIVE_DATE",
  "PROFILE_REVIEW_AFTER",
] as const;

interface ParsedLine {
  content: string;
  ending: string;
  offset: number;
  assignment?: {
    key: string;
    prefix: string;
    value: string;
    suffix: string;
    token: string;
  };
  reverseToken?: { beforeToken: string; afterToken: string; start: number };
}

export function profileEnvironmentKeys(purpose: ModelProfilePurpose): string[] {
  const prefix = prefixFor(purpose);
  return PROFILE_SUFFIXES.map((suffix) => `${prefix}_${suffix}`);
}

/** Project an already validated runtime profile onto the profile-only allowlist. */
export function projectProfileEnvironment(
  purpose: ModelProfilePurpose,
  profile: ModelProfile,
): Readonly<Record<string, string>> {
  const prefix = prefixFor(purpose);
  const limits = profile.configuredLimits;
  const projected: Record<string, string> = {
    [`${prefix}_CONTEXT_WINDOW`]: positiveInteger(limits.contextWindow),
    [`${prefix}_MAX_INPUT_TOKENS`]: positiveInteger(limits.maxInputTokens),
    [`${prefix}_MAX_OUTPUT_TOKENS`]: positiveInteger(limits.maxOutputTokens),
    [`${prefix}_REASONING`]: boolean(profile.reasoning),
    [`${prefix}_INPUT_TYPES`]: stringList(profile.input),
    [`${prefix}_SUPPORTS_DEVELOPER_ROLE`]: boolean(profile.compatibility.supportsDeveloperRole),
    [`${prefix}_SUPPORTS_REASONING_EFFORT`]: boolean(profile.compatibility.supportsReasoningEffort),
    [`${prefix}_COMPATIBLE_API_FORMATS`]: stringList(profile.compatibility.apiFormats),
    [`${prefix}_INPUT_COST_PER_MILLION`]: price(profile.costPerMillionTokens.input),
    [`${prefix}_OUTPUT_COST_PER_MILLION`]: price(profile.costPerMillionTokens.output),
    [`${prefix}_CACHE_READ_COST_PER_MILLION`]: price(profile.costPerMillionTokens.cacheRead),
    [`${prefix}_CACHE_WRITE_COST_PER_MILLION`]: price(profile.costPerMillionTokens.cacheWrite),
    [`${prefix}_PROFILE_APPROVED_SOURCE`]: profile.metadata.approvedSource ?? "unknown",
    [`${prefix}_PROFILE_EFFECTIVE_DATE`]: profile.metadata.effectiveDate ?? "unknown",
    [`${prefix}_PROFILE_REVIEW_AFTER`]: profile.metadata.reviewAfter ?? "unknown",
  };
  for (const value of Object.values(projected)) safeProjectedValue(value);
  return projected;
}

/**
 * Produce an exact dotenv post-image and a credential-free description of the
 * changes. This function performs no filesystem access or mutation.
 */
export function createProfileEnvironmentPatch(
  input: string | Uint8Array,
  purpose: ModelProfilePurpose,
  profile: ModelProfile,
): ProfileEnvironmentPatchResult {
  const before = typeof input === "string" ? Buffer.from(input) : Buffer.from(input);
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(before);
  } catch {
    return invalid();
  }
  if (source.includes("\0")) invalid();

  const values = projectProfileEnvironment(purpose, profile);
  const targeted = new Set(Object.keys(values));
  const lines = splitLines(source).map(parseLine);
  const occurrences = new Map<string, number>();
  for (const line of lines) {
    if (!line.assignment) continue;
    const count = occurrences.get(line.assignment.key) ?? 0;
    occurrences.set(line.assignment.key, count + 1);
    if (targeted.has(line.assignment.key) && count !== 0) invalid();
  }

  const changes: ProfileEnvironmentChangeV1[] = [];
  const seen = new Set<string>();
  const rewritten = lines.map((line) => {
    const assignment = line.assignment;
    if (!assignment || !targeted.has(assignment.key)) return line;
    seen.add(assignment.key);
    const after = required(values[assignment.key]);
    if (assignment.value === after) return line;
    changes.push({ key: assignment.key, before: assignment.value, after });
    const afterToken = encodeValue(after);
    return {
      ...line,
      content: `${assignment.prefix}${afterToken}${assignment.suffix}`,
      assignment: { ...assignment, value: after },
      reverseToken: {
        beforeToken: assignment.token,
        afterToken,
        start: assignment.prefix.length,
      },
    };
  });

  const missing = profileEnvironmentKeys(purpose).filter((key) => !seen.has(key));
  for (const key of missing) {
    changes.push({ key, before: null, after: required(values[key]) });
  }

  let rendered = joinLines(rewritten);
  const appendStart = Buffer.byteLength(rendered);
  if (missing.length > 0) {
    rendered = appendBlock(rendered, lines, purpose, missing, values);
  }
  const after = Buffer.from(rendered);
  const beforeSha256 = sha256(before);
  const afterSha256 = sha256(after);
  const changedKeys = changes.map((change) => change.key);
  let renderedOffset = 0;
  const operations = rewritten.flatMap((line) => {
    const reverse = line.reverseToken;
    const lineStart = renderedOffset;
    renderedOffset += Buffer.byteLength(line.content + line.ending);
    if (!reverse) return [];
    const start = lineStart + Buffer.byteLength(line.content.slice(0, reverse.start));
    return [
      {
        start,
        end: start + Buffer.byteLength(reverse.afterToken),
        beforeToken: reverse.beforeToken,
        afterToken: reverse.afterToken,
      },
    ];
  });
  const appended =
    missing.length === 0
      ? null
      : {
          start: appendStart,
          end: after.length,
          sha256: sha256(after.subarray(appendStart)),
        };
  const unsigned = {
    schemaVersion: PROFILE_ENVIRONMENT_SCHEMA_VERSION,
    kind: "docsfab-profile-environment-patch" as const,
    purpose,
    prefix: prefixFor(purpose),
    beforeSha256,
    afterSha256,
    changedKeys,
    changes,
    reverse: { operations, appended },
  };
  if (detectCredentialRuleIdsInValue(unsigned).length > 0) invalid();
  const digest = sha256(
    Buffer.from(canonicalizeJsonEvidence(unsigned as unknown as JsonEvidenceValue)),
  );
  return { bytes: after, patch: { ...unsigned, sha256: digest } };
}

/**
 * Reconstruct the exact pre-image using only credential-free targeted spans.
 * The operation is accepted only for the exact installed post-image and must
 * reproduce the receipt-bound pre-image digest.
 */
export function createProfileEnvironmentRollback(
  input: string | Uint8Array,
  patch: ProfileEnvironmentPatchV1,
): Uint8Array {
  patch = decodeProfileEnvironmentPatch(patch);
  const current = Buffer.from(input);
  if (sha256(current) !== patch.afterSha256) invalid();
  let bytes = current;
  const appended = patch.reverse.appended;
  if (appended) {
    if (
      !safeOffset(appended.start, bytes.length) ||
      !safeOffset(appended.end, bytes.length) ||
      appended.start > appended.end ||
      appended.end !== bytes.length ||
      sha256(bytes.subarray(appended.start, appended.end)) !== appended.sha256
    )
      invalid();
    bytes = bytes.subarray(0, appended.start);
  }
  const operations = [...patch.reverse.operations].sort((left, right) => right.start - left.start);
  let previousStart = bytes.length;
  for (const operation of operations) {
    if (
      !safeOffset(operation.start, bytes.length) ||
      !safeOffset(operation.end, bytes.length) ||
      operation.start > operation.end ||
      operation.end > previousStart
    )
      invalid();
    const after = Buffer.from(operation.afterToken);
    if (!bytes.subarray(operation.start, operation.end).equals(after)) invalid();
    bytes = Buffer.concat([
      bytes.subarray(0, operation.start),
      Buffer.from(operation.beforeToken),
      bytes.subarray(operation.end),
    ]);
    previousStart = operation.start;
  }
  if (sha256(bytes) !== patch.beforeSha256) invalid();
  return Uint8Array.from(bytes);
}

function tokenValue(token: string): string {
  const parsed = splitValue(token);
  if (parsed.suffix !== "" || parsed.token !== token) invalid();
  return parsed.value;
}

function parseLine(line: ParsedLine): ParsedLine {
  const content = line.content;
  if (/^\s*(?:#.*)?$/.test(content)) return line;
  const match = /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*)(.*)$/.exec(content);
  if (!match) return invalid();
  const prefix = required(match[1]);
  const keyMatch = /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*$/.exec(prefix);
  if (!keyMatch) return invalid();
  const { value, suffix, token } = splitValue(required(match[2]));
  if (/\$\{|\$\(|`/.test(value)) invalid();
  return { ...line, assignment: { key: required(keyMatch[1]), prefix, value, suffix, token } };
}

function splitValue(raw: string): { value: string; suffix: string; token: string } {
  if (raw.startsWith('"') || raw.startsWith("'")) {
    const quote = raw[0];
    let escaped = false;
    for (let index = 1; index < raw.length; index += 1) {
      const character = raw[index];
      if (quote === '"' && character === "\\" && !escaped) {
        escaped = true;
        continue;
      }
      if (character === quote && !escaped) {
        const encoded = raw.slice(0, index + 1);
        const suffix = raw.slice(index + 1);
        if (!/^\s*(?:#.*)?$/.test(suffix)) invalid();
        let value: unknown;
        if (quote === '"') {
          try {
            value = JSON.parse(encoded);
          } catch {
            return invalid();
          }
        } else {
          value = encoded.slice(1, -1);
        }
        if (typeof value !== "string") return invalid();
        return { value, suffix, token: encoded };
      }
      escaped = false;
    }
    return invalid();
  }
  const comment = raw.indexOf("#");
  const valuePart = comment === -1 ? raw : raw.slice(0, comment);
  const trailing = /\s*$/.exec(valuePart)?.[0] ?? "";
  const value = valuePart.slice(0, valuePart.length - trailing.length);
  const suffix = `${trailing}${comment === -1 ? "" : raw.slice(comment)}`;
  return { value, suffix, token: raw.slice(0, raw.length - suffix.length) };
}

function splitLines(source: string): ParsedLine[] {
  if (source.length === 0) return [];
  const lines: ParsedLine[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "\n" && source[index] !== "\r") continue;
    const width = source[index] === "\r" && source[index + 1] === "\n" ? 2 : 1;
    lines.push({
      content: source.slice(start, index),
      ending: source.slice(index, index + width),
      offset: start,
    });
    index += width - 1;
    start = index + 1;
  }
  if (start < source.length)
    lines.push({ content: source.slice(start), ending: "", offset: start });
  return lines;
}

function joinLines(lines: readonly ParsedLine[]): string {
  return lines.map((line) => line.content + line.ending).join("");
}

function appendBlock(
  rendered: string,
  originalLines: readonly ParsedLine[],
  purpose: ModelProfilePurpose,
  missing: readonly string[],
  values: Readonly<Record<string, string>>,
): string {
  const ending = originalLines.find((line) => line.ending)?.ending ?? "\n";
  const hadFinalEnding =
    originalLines.length > 0 && required(originalLines[originalLines.length - 1]).ending.length > 0;
  let separator = "";
  if (rendered.length > 0) {
    if (!hadFinalEnding) separator += ending;
    const lastContent =
      originalLines.length === 0 ? "" : required(originalLines[originalLines.length - 1]).content;
    if (lastContent.trim().length > 0) separator += ending;
  }
  const block = [
    `# DocsFab approved ${purpose} model profile.`,
    ...missing.map((key) => `${key}=${encodeValue(required(values[key]))}`),
  ].join(ending);
  return `${rendered}${separator}${block}${hadFinalEnding ? ending : ""}`;
}

function encodeValue(value: string): string {
  return /^[A-Za-z0-9_./,:+\-]+$/.test(value) ? value : JSON.stringify(value);
}

function prefixFor(purpose: ModelProfilePurpose): ProfileEnvironmentPrefix {
  if (purpose === "policy") return "MODEL";
  if (purpose === "judge") return "JUDGE";
  return invalid();
}

function positiveInteger(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) return invalid();
  return String(value);
}

function boolean(value: boolean): string {
  if (typeof value !== "boolean") return invalid();
  return String(value);
}

function stringList(values: readonly string[]): string {
  if (
    values.length === 0 ||
    new Set(values).size !== values.length ||
    values.some((value) => !/^[a-z][a-z0-9_\-]*$/.test(value))
  )
    return invalid();
  return values.join(",");
}

function price(value: number | null): string {
  if (value === null) return "unknown";
  if (!Number.isFinite(value) || value < 0) return invalid();
  return String(value);
}

function safeProjectedValue(value: string): void {
  if (value.length === 0 || value.length > 4_096 || /[\0\r\n]|\$\{|\$\(|`/.test(value)) invalid();
}

function safeOriginalValue(value: string): void {
  if (value.length > 4_096 || /[\0\r\n]|\$\{|\$\(|`/.test(value)) invalid();
}

function required<T>(value: T | undefined): T {
  if (value === undefined) return invalid();
  return value;
}

function safeOffset(value: number, length: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= length;
}

function hexDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  )
    invalid();
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor) || !descriptor.enumerable) invalid();
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    invalid();
}

function assertPlainTree(value: unknown, depth = 0, state: { count: number } = { count: 0 }): void {
  state.count += 1;
  if (depth > 128 || state.count > 100_000) invalid();
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0
    )
      invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !length ||
      !("value" in length) ||
      length.value !== value.length ||
      !Number.isSafeInteger(length.value) ||
      length.value > 100_000
    )
      invalid();
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== length.value + 1) invalid();
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
      assertPlainTree(descriptor.value, depth + 1, state);
    }
    return;
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(plainRecord(value)))) {
    if (!("value" in descriptor)) invalid();
    assertPlainTree(descriptor.value, depth + 1, state);
  }
}

const CONTRACT_CODE = /^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

function isContractErrorLike(error: unknown): error is Error & { readonly code: string } {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = error.code;
  return typeof code === "string" && CONTRACT_CODE.test(code);
}

function rethrowPreservedOrWrap(error: unknown): never {
  if (isContractErrorLike(error)) throw error;
  invalid(error);
}

function invalid(cause?: unknown): never {
  throw new ProfileEnvironmentError(cause === undefined ? undefined : { cause });
}
