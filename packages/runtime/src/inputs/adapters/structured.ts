// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Inert structured repository evidence adapters.
 *
 * Every adapter consumes bytes already admitted by a host producer. It never
 * opens a path, follows a URL, executes notebook code, or mutates the supplied
 * evidence. The source-set helper resolves only references among the exact
 * in-memory files supplied by its caller.
 */
import { posix } from "node:path";

import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";

import {
  SOURCE_EXTRACTION_MAX_DERIVATIVE_BYTES_LIMIT,
  SOURCE_EXTRACTION_MAX_SPANS_LIMIT,
} from "../../config/source-read-limits.js";
import {
  extractSourceRepresentation,
  normalizeMediaType,
  sourceSegmentSpanCount,
  type ExtractSourceRepresentationResult,
  type SourceExtractionRequestV1,
  type SourceExtractionResultV1,
  type SourceExtractionSegmentV1,
  type SourceExtractorAdapterV1,
} from "../source-extraction.js";
import type { SourceRepresentationLimitation } from "../source-evidence.js";

export type StructuredSourceErrorCode =
  | "cyclic-reference"
  | "duplicate-key"
  | "duplicate-notebook-cell-id"
  | "invalid-notebook"
  | "invalid-reference"
  | "invalid-source-path"
  | "malformed-source"
  | "missing-reference"
  | "reference-budget-exceeded"
  | "remote-reference"
  | "source-budget-exceeded"
  | "unsafe-number"
  | "unsupported-encoding"
  | "unsupported-yaml-alias"
  | "unsupported-yaml-key"
  | "unsupported-yaml-tag";

export class StructuredSourceError extends Error {
  public constructor(public readonly code: StructuredSourceErrorCode) {
    super(`The structured source adapter rejected this original: ${code}.`);
    this.name = "StructuredSourceError";
  }
}

function fail(code: StructuredSourceErrorCode): never {
  throw new StructuredSourceError(code);
}

const MAX_STRUCTURED_SOURCES = 64;
const MAX_STRUCTURED_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_STRUCTURED_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_STRUCTURED_REFERENCES = 2_048;
const MAX_STRUCTURED_REFERENCE_DEPTH = 32;
const MAX_STRUCTURED_DEPTH = 64;
const SAFE_PATH = /^(?!\.)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u;
const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u;
const JSON_NUMBER_BRAND = Symbol("docsfab-json-number-token");

type JsonNumberLeaf = {
  readonly [JSON_NUMBER_BRAND]: true;
  readonly token: string;
};
type StructuredRecord = { [key: string]: StructuredValue } & { [JSON_NUMBER_BRAND]?: undefined };
type StructuredValue =
  | null
  | boolean
  | string
  | JsonNumberLeaf
  | StructuredValue[]
  | StructuredRecord;

function isJsonNumberLeaf(value: unknown): value is JsonNumberLeaf {
  return value !== null && typeof value === "object" && JSON_NUMBER_BRAND in value;
}

function isPlainRecord(value: unknown): value is StructuredRecord {
  return (
    value !== null && typeof value === "object" && !Array.isArray(value) && !isJsonNumberLeaf(value)
  );
}

function jsonNumberLeaf(token: string): JsonNumberLeaf {
  const value = Number(token);
  if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
    fail("unsafe-number");
  }
  return Object.freeze({ [JSON_NUMBER_BRAND]: true as const, token });
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("unsupported-encoding");
  }
}

function rethrowStructured(error: unknown): never {
  if (error instanceof StructuredSourceError) throw error;
  fail("malformed-source");
}

function parseJsonDocument(text: string): StructuredValue {
  let offset = 0;
  const whitespace = (): void => {
    while (/[\t\n\r ]/u.test(text[offset] ?? "")) offset += 1;
  };
  const parseString = (): string => {
    if (text[offset] !== '"') fail("malformed-source");
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      const character = text[offset];
      if (character === '"') {
        offset += 1;
        try {
          return JSON.parse(text.slice(start, offset)) as string;
        } catch {
          fail("malformed-source");
        }
      }
      if (character === "\\") offset += 1;
      offset += 1;
    }
    fail("malformed-source");
  };
  const parseNumber = (): JsonNumberLeaf => {
    const match = text.slice(offset).match(JSON_NUMBER);
    if (!match) fail("malformed-source");
    offset += match[0].length;
    return jsonNumberLeaf(match[0]);
  };
  const parseValue = (depth: number): StructuredValue => {
    if (depth > MAX_STRUCTURED_DEPTH) fail("malformed-source");
    whitespace();
    const character = text[offset];
    if (character === '"') return parseString();
    if (character === "{") {
      offset += 1;
      whitespace();
      const result = Object.create(null) as StructuredRecord;
      const keys = new Set<string>();
      if (text[offset] === "}") {
        offset += 1;
        return result;
      }
      while (offset < text.length) {
        const key = parseString();
        if (keys.has(key)) fail("duplicate-key");
        keys.add(key);
        whitespace();
        if (text[offset] !== ":") fail("malformed-source");
        offset += 1;
        Object.defineProperty(result, key, {
          configurable: false,
          enumerable: true,
          value: parseValue(depth + 1),
          writable: false,
        });
        whitespace();
        if (text[offset] === "}") {
          offset += 1;
          return result;
        }
        if (text[offset] !== ",") fail("malformed-source");
        offset += 1;
        whitespace();
      }
      fail("malformed-source");
    }
    if (character === "[") {
      offset += 1;
      whitespace();
      const result: StructuredValue[] = [];
      if (text[offset] === "]") {
        offset += 1;
        return result;
      }
      while (offset < text.length) {
        result.push(parseValue(depth + 1));
        whitespace();
        if (text[offset] === "]") {
          offset += 1;
          return result;
        }
        if (text[offset] !== ",") fail("malformed-source");
        offset += 1;
        whitespace();
      }
      fail("malformed-source");
    }
    for (const literal of ["true", "false", "null"] as const) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length;
        return literal === "null" ? null : literal === "true";
      }
    }
    if (character === "-" || (character !== undefined && character >= "0" && character <= "9")) {
      return parseNumber();
    }
    fail("malformed-source");
  };
  whitespace();
  const value = parseValue(0);
  whitespace();
  if (offset !== text.length) fail("malformed-source");
  return value;
}

function parseJson(bytes: Uint8Array): StructuredValue {
  try {
    return parseJsonDocument(decodeUtf8(bytes));
  } catch (error) {
    rethrowStructured(error);
  }
}

function inspectYamlNode(value: unknown, seen = new Set<object>(), depth = 0): void {
  if (!value || typeof value !== "object") return;
  if (depth > MAX_STRUCTURED_DEPTH) fail("malformed-source");
  if (seen.has(value)) fail("unsupported-yaml-alias");
  seen.add(value);
  if (isAlias(value)) fail("unsupported-yaml-alias");
  const node = value as { tag?: unknown; items?: unknown[]; key?: unknown; value?: unknown };
  // Implicit core values do not carry a tag. Any explicit tag, including an
  // explicit core tag, is outside this deterministic subset.
  if (typeof node.tag === "string" && node.tag.length > 0) fail("unsupported-yaml-tag");
  if (isMap(value)) {
    for (const pair of value.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
        fail("unsupported-yaml-key");
      }
      if (pair.key.value === "<<") fail("unsupported-yaml-key");
    }
  }
  if (Array.isArray(node.items)) {
    for (const item of node.items) inspectYamlNode(item, seen, depth + 1);
  }
  if ("key" in node) inspectYamlNode(node.key, seen, depth + 1);
  if ("value" in node) inspectYamlNode(node.value, seen, depth + 1);
  seen.delete(value);
}

function yamlScalarToken(
  scalar: { source?: unknown; range?: readonly number[] | null },
  text: string,
): string {
  if (typeof scalar.source === "string" && scalar.source.length > 0) return scalar.source;
  const range = scalar.range;
  if (
    range &&
    Number.isInteger(range[0]) &&
    Number.isInteger(range[1]) &&
    (range[1] as number) > (range[0] as number)
  ) {
    return text.slice(range[0], range[1]);
  }
  fail("malformed-source");
}

function yamlToStructured(node: unknown, text: string, depth: number): StructuredValue {
  if (depth > MAX_STRUCTURED_DEPTH) fail("malformed-source");
  if (node == null) return null;
  if (isScalar(node)) {
    const value = node.value;
    if (typeof value === "number") return jsonNumberLeaf(yamlScalarToken(node, text));
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    fail("malformed-source");
  }
  if (isSeq(node)) {
    return node.items.map((item) => yamlToStructured(item, text, depth + 1));
  }
  if (isMap(node)) {
    const result = Object.create(null) as StructuredRecord;
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") fail("unsupported-yaml-key");
      const key = pair.key.value;
      if (key === "<<") fail("unsupported-yaml-key");
      Object.defineProperty(result, key, {
        configurable: false,
        enumerable: true,
        value: yamlToStructured(pair.value, text, depth + 1),
        writable: false,
      });
    }
    return result;
  }
  fail("malformed-source");
}

function parseYaml(bytes: Uint8Array): StructuredValue {
  const text = decodeUtf8(bytes);
  try {
    const document = parseDocument(text, { strict: true, uniqueKeys: true });
    if (document.errors.some((error) => error.code === "DUPLICATE_KEY")) fail("duplicate-key");
    if (
      [...document.errors, ...document.warnings].some(
        (error) => error.code === "TAG_RESOLVE_FAILED",
      )
    ) {
      fail("unsupported-yaml-tag");
    }
    if (document.errors.length > 0 || document.warnings.length > 0) fail("malformed-source");
    inspectYamlNode(document.contents);
    return yamlToStructured(document.contents, text, 0);
  } catch (error) {
    rethrowStructured(error);
  }
}

function pointerToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function appendPointer(pointer: string, token: string): string {
  return `${pointer}/${pointerToken(token)}`;
}

function structuredLeafText(
  value: Exclude<StructuredValue, StructuredValue[] | StructuredRecord>,
): string {
  if (isJsonNumberLeaf(value)) return value.token;
  return JSON.stringify(value);
}

function structuredSegments(value: StructuredValue): SourceExtractionSegmentV1[] {
  const result: SourceExtractionSegmentV1[] = [];
  const visit = (child: StructuredValue, pointer: string, depth: number): void => {
    if (depth > MAX_STRUCTURED_DEPTH) fail("malformed-source");
    if (Array.isArray(child)) {
      if (child.length === 0) {
        result.push({ text: "[]", locator: { kind: "json-pointer", pointer } });
        return;
      }
      child.forEach((entry, index) =>
        visit(entry, appendPointer(pointer, String(index)), depth + 1),
      );
      return;
    }
    if (isPlainRecord(child)) {
      const entries = Object.entries(child);
      if (entries.length === 0) {
        result.push({ text: "{}", locator: { kind: "json-pointer", pointer } });
        return;
      }
      for (const [key, entry] of entries) visit(entry, appendPointer(pointer, key), depth + 1);
      return;
    }
    result.push({ text: structuredLeafText(child), locator: { kind: "json-pointer", pointer } });
  };
  visit(value, "", 0);
  return result;
}

function extractJson(request: SourceExtractionRequestV1): SourceExtractionResultV1 {
  return { segments: structuredSegments(parseJson(request.bytes)), limitations: [] };
}

function extractYaml(request: SourceExtractionRequestV1): SourceExtractionResultV1 {
  return { segments: structuredSegments(parseYaml(request.bytes)), limitations: [] };
}

function extractText(request: SourceExtractionRequestV1): SourceExtractionResultV1 {
  const text = decodeUtf8(request.bytes);
  const segments: SourceExtractionSegmentV1[] = [];
  let fullDerivativeBytes = 0;
  let fullSpanCount = 0;
  let keptDerivativeBytes = 0;
  let keptSpanCount = 0;
  let truncation: "span-budget-truncated" | "byte-budget-truncated" | undefined;
  let characterStart = 0;
  // TextDecoder strips a leading UTF-8 BOM. Keep the original byte offset
  // explicit so the first visible character still points after those 3 bytes.
  let byteStart =
    request.bytes[0] === 0xef && request.bytes[1] === 0xbb && request.bytes[2] === 0xbf ? 3 : 0;
  const appendLine = (line: string, lineBytes: number): void => {
    if (line.length === 0) return;
    const lineSpans =
      lineBytes <= request.limits.maxSpanBytes
        ? 1
        : sourceSegmentSpanCount(line, request.limits.maxSpanBytes);
    fullDerivativeBytes += lineBytes + (fullSpanCount === 0 ? 0 : 1);
    fullSpanCount += lineSpans;
    // Keep the same whole-segment prefix as host admission. Continue counting
    // omitted content so the operator sees the full observed overflow.
    if (truncation !== undefined) return;
    const prefixBytes = segments.length === 0 ? 0 : 1;
    if (keptSpanCount + lineSpans > request.limits.maxSpans) {
      truncation = "span-budget-truncated";
    } else if (keptDerivativeBytes + prefixBytes + lineBytes > request.limits.maxDerivativeBytes) {
      truncation = "byte-budget-truncated";
    } else {
      segments.push({
        text: line,
        locator: { kind: "text", startByte: byteStart, endByte: byteStart + lineBytes },
      });
      keptSpanCount += lineSpans;
      keptDerivativeBytes += prefixBytes + lineBytes;
    }
  };
  for (const match of text.matchAll(/\r\n|\n|\r/gu)) {
    const line = text.slice(characterStart, match.index);
    const lineBytes = Buffer.byteLength(line, "utf8");
    appendLine(line, lineBytes);
    const separator = match[0];
    characterStart = (match.index ?? 0) + separator.length;
    byteStart += lineBytes + Buffer.byteLength(separator, "utf8");
  }
  const tail = text.slice(characterStart);
  appendLine(tail, Buffer.byteLength(tail, "utf8"));
  if (truncation !== undefined) {
    return {
      segments,
      limitations: [truncation],
      overflows: [
        {
          limitation: truncation,
          limitName:
            truncation === "span-budget-truncated"
              ? SOURCE_EXTRACTION_MAX_SPANS_LIMIT
              : SOURCE_EXTRACTION_MAX_DERIVATIVE_BYTES_LIMIT,
          observed: truncation === "span-budget-truncated" ? fullSpanCount : fullDerivativeBytes,
        },
      ],
    };
  }
  return { segments, limitations: [] };
}

function notebookText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value.join("");
  }
  return undefined;
}

function outputDroppedNonText(rawOutput: StructuredRecord, retained: string | undefined): boolean {
  if (
    isPlainRecord(rawOutput.data) &&
    Object.keys(rawOutput.data).some((key) => key !== "text/plain")
  ) {
    return true;
  }
  return retained === undefined;
}

function cellHasAttachments(cell: StructuredRecord): boolean {
  return isPlainRecord(cell.attachments) && Object.keys(cell.attachments).length > 0;
}

function extractNotebook(request: SourceExtractionRequestV1): SourceExtractionResultV1 {
  const parsed = parseJson(request.bytes);
  if (!isPlainRecord(parsed)) fail("invalid-notebook");
  const cells = parsed.cells;
  if (!Array.isArray(cells)) fail("invalid-notebook");
  const ids = new Set<string>();
  const segments: SourceExtractionSegmentV1[] = [];
  const limitations = new Set<SourceRepresentationLimitation>();

  cells.forEach((candidate, cellOrdinal) => {
    if (!isPlainRecord(candidate)) fail("invalid-notebook");
    const cellId = candidate.id === undefined ? null : candidate.id;
    if (cellId !== null && (typeof cellId !== "string" || cellId.length === 0)) {
      fail("invalid-notebook");
    }
    if (typeof cellId === "string") {
      if (ids.has(cellId)) fail("duplicate-notebook-cell-id");
      ids.add(cellId);
    }
    if (cellHasAttachments(candidate)) limitations.add("non-text-content-excluded");
    const source = notebookText(candidate.source);
    if (source === undefined) fail("invalid-notebook");
    if (source.length > 0) {
      segments.push({
        text: source,
        locator: {
          kind: "notebook-cell",
          cellId,
          cellOrdinal,
          part: "source",
          outputOrdinal: null,
          startByte: 0,
          endByte: Buffer.byteLength(source, "utf8"),
        },
      });
    }
    if (candidate.cell_type !== "code") return;
    if (!Array.isArray(candidate.outputs)) fail("invalid-notebook");
    candidate.outputs.forEach((rawOutput, outputOrdinal) => {
      if (!isPlainRecord(rawOutput)) fail("invalid-notebook");
      let output = notebookText(rawOutput.text);
      if (output === undefined && isPlainRecord(rawOutput.data)) {
        output = notebookText(rawOutput.data["text/plain"]);
      }
      if (output === undefined && Array.isArray(rawOutput.traceback)) {
        output = rawOutput.traceback.every((entry) => typeof entry === "string")
          ? rawOutput.traceback.join("\n")
          : undefined;
      }
      if (outputDroppedNonText(rawOutput, output)) {
        limitations.add("non-text-content-excluded");
      }
      if (output === undefined || output.length === 0) return;
      segments.push({
        text: output,
        locator: {
          kind: "notebook-cell",
          cellId,
          cellOrdinal,
          part: "output",
          outputOrdinal,
          startByte: 0,
          endByte: Buffer.byteLength(output, "utf8"),
        },
      });
    });
  });
  return { segments, limitations: [...limitations].sort() };
}

const TEXT_MEDIA_TYPES = Object.freeze([
  "application/javascript",
  "application/toml",
  "application/typescript",
  "text/javascript",
  "text/markdown",
  "text/mdx",
  "text/plain",
  "text/x-c",
  "text/x-c++",
  "text/x-ini",
  "text/x-java-source",
  "text/x-python",
  "text/x-rust",
  "text/x-shellscript",
  "text/x-typescript",
]);

export const textSourceExtractorAdapter: SourceExtractorAdapterV1 = Object.freeze({
  id: "docsfab-text-bytes",
  version: "1",
  locatorKind: "text",
  mediaTypes: TEXT_MEDIA_TYPES,
  defaultOptions: Object.freeze({ preserveOriginalByteRanges: true }),
  extract: extractText,
});

export const jsonSourceExtractorAdapter: SourceExtractorAdapterV1 = Object.freeze({
  id: "docsfab-json-pointer",
  version: "1",
  locatorKind: "json-pointer",
  mediaTypes: Object.freeze([
    "application/json",
    "application/schema+json",
    "application/vnd.oai.openapi+json",
  ]),
  defaultOptions: Object.freeze({ maxDepth: MAX_STRUCTURED_DEPTH, rejectDuplicateKeys: true }),
  extract: extractJson,
});

export const yamlSourceExtractorAdapter: SourceExtractorAdapterV1 = Object.freeze({
  id: "docsfab-yaml-pointer",
  version: "1",
  locatorKind: "json-pointer",
  mediaTypes: Object.freeze([
    "application/vnd.oai.openapi",
    "application/x-yaml",
    "application/yaml",
    "text/yaml",
  ]),
  defaultOptions: Object.freeze({
    maxDepth: MAX_STRUCTURED_DEPTH,
    rejectAliases: true,
    rejectDuplicateKeys: true,
    rejectExplicitTags: true,
  }),
  extract: extractYaml,
});

export const notebookSourceExtractorAdapter: SourceExtractorAdapterV1 = Object.freeze({
  id: "docsfab-notebook-text",
  version: "1",
  locatorKind: "notebook-cell",
  mediaTypes: Object.freeze(["application/x-ipynb+json"]),
  defaultOptions: Object.freeze({ execute: false, includeHistoricalTextOutputs: true }),
  extract: extractNotebook,
});

export const STRUCTURED_SOURCE_EXTRACTOR_ADAPTERS = Object.freeze([
  textSourceExtractorAdapter,
  jsonSourceExtractorAdapter,
  yamlSourceExtractorAdapter,
  notebookSourceExtractorAdapter,
]);

export interface StructuredSourceInputV1 {
  path: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface StructuredSourceSetInputV1 {
  sources: readonly StructuredSourceInputV1[];
  entryPaths: readonly string[];
}

export interface StructuredSourceSetResultV1 {
  sources: readonly (StructuredSourceInputV1 & ExtractSourceRepresentationResult)[];
  references: readonly { fromPath: string; reference: string; toPath: string; pointer: string }[];
}

function sourceAdapter(mediaType: string): SourceExtractorAdapterV1 | undefined {
  const normalized = normalizeMediaType(mediaType);
  return STRUCTURED_SOURCE_EXTRACTOR_ADAPTERS.find((adapter) =>
    adapter.mediaTypes.includes(normalized),
  );
}

function canonicalSourcePath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    value.includes("\\") ||
    posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    !SAFE_PATH.test(value)
  ) {
    fail("invalid-source-path");
  }
  return value;
}

function referencesIn(value: StructuredValue): string[] {
  const result: string[] = [];
  const visit = (child: StructuredValue, depth: number): void => {
    if (depth > MAX_STRUCTURED_DEPTH) fail("malformed-source");
    if (Array.isArray(child)) {
      child.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    if (!isPlainRecord(child)) return;
    for (const [key, entry] of Object.entries(child)) {
      if (key === "$ref" && typeof entry === "string") result.push(entry);
      visit(entry, depth + 1);
    }
  };
  visit(value, 0);
  return result;
}

function decodePointer(value: string): string[] {
  if (value === "") return [];
  if (!/^(?:\/(?:[^~/]|~[01])*)+$/u.test(value)) fail("invalid-reference");
  return value
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function resolvePointer(document: StructuredValue, pointer: string): StructuredValue {
  let value: StructuredValue | undefined = document;
  for (const token of decodePointer(pointer)) {
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(token)) fail("missing-reference");
      value = value[Number(token)];
    } else if (isPlainRecord(value)) {
      value = Object.prototype.hasOwnProperty.call(value, token) ? value[token] : undefined;
    } else {
      value = undefined;
    }
    if (value === undefined) fail("missing-reference");
  }
  return value;
}

function resolveReference(fromPath: string, reference: string): { path: string; pointer: string } {
  if (reference.length === 0 || reference.length > 4_096) fail("invalid-reference");
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(reference) || reference.startsWith("//")) {
    fail("remote-reference");
  }
  const hash = reference.indexOf("#");
  const rawPath = hash === -1 ? reference : reference.slice(0, hash);
  const rawFragment = hash === -1 ? "" : reference.slice(hash + 1);
  let decodedPath: string;
  let pointer: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
    pointer = decodeURIComponent(rawFragment);
  } catch {
    fail("invalid-reference");
  }
  if (decodedPath.includes("\\") || decodedPath.includes("\0") || posix.isAbsolute(decodedPath)) {
    fail("invalid-reference");
  }
  const path =
    decodedPath.length === 0
      ? fromPath
      : posix.normalize(posix.join(posix.dirname(fromPath), decodedPath));
  canonicalSourcePath(path);
  decodePointer(pointer);
  return { path, pointer };
}

/**
 * Extract a bounded local reference closure from bytes already supplied by the
 * host. Unreferenced supplied files remain inert. Every reached file receives
 * its own original digest, derivative, and locator map.
 */
export async function extractStructuredSourceSet(
  input: StructuredSourceSetInputV1,
): Promise<StructuredSourceSetResultV1> {
  if (
    !Array.isArray(input.sources) ||
    input.sources.length === 0 ||
    input.sources.length > MAX_STRUCTURED_SOURCES
  ) {
    fail("source-budget-exceeded");
  }
  if (
    !Array.isArray(input.entryPaths) ||
    input.entryPaths.length === 0 ||
    input.entryPaths.length > MAX_STRUCTURED_SOURCES
  ) {
    fail("source-budget-exceeded");
  }
  const sources = new Map<string, StructuredSourceInputV1>();
  let totalBytes = 0;
  for (const source of input.sources) {
    const path = canonicalSourcePath(source.path);
    if (sources.has(path)) fail("invalid-source-path");
    if (
      !(source.bytes instanceof Uint8Array) ||
      source.bytes.byteLength > MAX_STRUCTURED_SOURCE_BYTES
    ) {
      fail("source-budget-exceeded");
    }
    totalBytes += source.bytes.byteLength;
    if (totalBytes > MAX_STRUCTURED_TOTAL_BYTES) fail("source-budget-exceeded");
    if (!sourceAdapter(source.mediaType)) fail("malformed-source");
    sources.set(path, { ...source, path });
  }
  const entries = input.entryPaths.map(canonicalSourcePath);
  if (new Set(entries).size !== entries.length) fail("invalid-source-path");
  for (const entry of entries) if (!sources.has(entry)) fail("missing-reference");

  const values = new Map<string, StructuredValue>();
  const parsedValue = (source: StructuredSourceInputV1): StructuredValue | undefined => {
    const mediaType = normalizeMediaType(source.mediaType);
    if (jsonSourceExtractorAdapter.mediaTypes.includes(mediaType)) return parseJson(source.bytes);
    if (yamlSourceExtractorAdapter.mediaTypes.includes(mediaType)) return parseYaml(source.bytes);
    return undefined;
  };
  const parsed = new Set<string>();
  const valueFor = (path: string): StructuredValue | undefined => {
    if (parsed.has(path)) return values.get(path);
    parsed.add(path);
    const source = sources.get(path);
    if (!source) fail("missing-reference");
    const value = parsedValue(source);
    if (value !== undefined) values.set(path, value);
    return value;
  };

  const state = new Map<string, "visiting" | "visited">();
  const reached = new Set<string>();
  const references: Array<{
    fromPath: string;
    reference: string;
    toPath: string;
    pointer: string;
  }> = [];
  let referenceCount = 0;
  const visit = (path: string, pointer: string, depth: number): void => {
    if (depth > MAX_STRUCTURED_REFERENCE_DEPTH) fail("reference-budget-exceeded");
    const nodeKey = `${path}#${pointer}`;
    if (state.get(nodeKey) === "visiting") fail("cyclic-reference");
    if (state.get(nodeKey) === "visited") return;
    state.set(nodeKey, "visiting");
    reached.add(path);
    const document = valueFor(path);
    if (document !== undefined) {
      const value = resolvePointer(document, pointer);
      for (const reference of referencesIn(value)) {
        referenceCount += 1;
        if (referenceCount > MAX_STRUCTURED_REFERENCES) fail("reference-budget-exceeded");
        const resolved = resolveReference(path, reference);
        const target = sources.get(resolved.path);
        if (!target) fail("missing-reference");
        const targetValue = valueFor(resolved.path);
        if (targetValue === undefined) fail("invalid-reference");
        resolvePointer(targetValue, resolved.pointer);
        references.push({
          fromPath: path,
          reference,
          toPath: resolved.path,
          pointer: resolved.pointer,
        });
        visit(resolved.path, resolved.pointer, depth + 1);
      }
    }
    state.set(nodeKey, "visited");
  };
  for (const entry of entries) visit(entry, "", 0);

  const extracted: Array<StructuredSourceInputV1 & ExtractSourceRepresentationResult> = [];
  for (const source of sources.values()) {
    if (!reached.has(source.path)) continue;
    const adapter = sourceAdapter(source.mediaType);
    if (!adapter) fail("malformed-source");
    extracted.push({
      ...source,
      ...(await extractSourceRepresentation({
        adapter,
        bytes: source.bytes,
        mediaType: source.mediaType,
        limits: { maxOriginalBytes: MAX_STRUCTURED_SOURCE_BYTES },
      })),
    });
  }
  return Object.freeze({
    sources: Object.freeze(extracted),
    references: Object.freeze(references.map((entry) => Object.freeze(entry))),
  });
}
