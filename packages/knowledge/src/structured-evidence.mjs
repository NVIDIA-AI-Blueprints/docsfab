// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Portable structured-source projection over the validated handoff from
 * evidence-source.mjs. It imports no runtime implementation and grants no source
 * access. Output keeps exact locators on quotations and marks notebook outputs
 * as historical evidence, not fresh execution results.
 */
import { createHash } from "node:crypto";

export class StructuredEvidenceError extends Error {
  constructor(code) {
    super(`Structured evidence rejected: ${code}.`);
    this.name = "StructuredEvidenceError";
    this.code = code;
  }
}

function fail(code) {
  throw new StructuredEvidenceError(code);
}

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-shape");
  return value;
}

function exact(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length) fail("invalid-locator");
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) fail("invalid-locator");
  }
}

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid-locator");
  return value;
}

function locator(value) {
  const entry = record(value);
  if (entry.kind === "text") {
    exact(entry, ["kind", "startByte", "endByte"]);
    if (count(entry.endByte) <= count(entry.startByte)) fail("invalid-locator");
  } else if (entry.kind === "json-pointer") {
    exact(entry, ["kind", "pointer"]);
    if (
      typeof entry.pointer !== "string" ||
      (entry.pointer !== "" && !/^(?:\/(?:[^~/]|~[01])*)+$/u.test(entry.pointer))
    ) {
      fail("invalid-locator");
    }
  } else if (entry.kind === "notebook-cell") {
    exact(entry, [
      "kind",
      "cellId",
      "cellOrdinal",
      "part",
      "outputOrdinal",
      "startByte",
      "endByte",
    ]);
    if (entry.cellId !== null && (typeof entry.cellId !== "string" || entry.cellId.length === 0)) {
      fail("invalid-locator");
    }
    count(entry.cellOrdinal);
    if (entry.part !== "source" && entry.part !== "output") fail("invalid-locator");
    if ((entry.part === "output") !== (entry.outputOrdinal !== null)) fail("invalid-locator");
    if (entry.outputOrdinal !== null) count(entry.outputOrdinal);
    if (count(entry.endByte) <= count(entry.startByte)) fail("invalid-locator");
  } else {
    fail("unsupported-structured-locator");
  }
  return Object.freeze({ ...entry });
}

/** Preserve each exact structured locator while making historical evidence explicit. */
export function projectStructuredEvidenceSource(source) {
  const input = record(source);
  if (!Array.isArray(input.spans) || input.spans.length === 0) fail("invalid-shape");
  const spans = input.spans.map((candidate) => {
    const span = record(candidate);
    exact(span, ["spanId", "locator", "text"]);
    if (typeof span.spanId !== "string" || span.spanId.length === 0 || typeof span.text !== "string") {
      fail("invalid-shape");
    }
    const normalized = locator(span.locator);
    return Object.freeze({
      spanId: span.spanId,
      locator: normalized,
      text: span.text,
      evidenceClass:
        normalized.kind === "notebook-cell" && normalized.part === "output"
          ? "historical-notebook-output"
          : "source-content",
    });
  });
  const seen = new Set();
  for (const span of spans) {
    if (seen.has(span.spanId)) fail("duplicate-span");
    seen.add(span.spanId);
  }
  return Object.freeze({
    observationId: input.observationId,
    representationId: input.representationId,
    location: input.location,
    required: input.required === true,
    completeness: input.completeness,
    limitations: Object.freeze(Array.isArray(input.limitations) ? [...input.limitations] : []),
    spans: Object.freeze(spans),
    historicalOutputSpanIds: Object.freeze(
      spans
        .filter((span) => span.evidenceClass === "historical-notebook-output")
        .map((span) => span.spanId),
    ),
  });
}

function originalBytes(input) {
  const bytes =
    input.originalBytes instanceof Uint8Array
      ? input.originalBytes
      : typeof input.originalText === "string"
        ? Buffer.from(input.originalText, "utf8")
        : fail("invalid-original");
  if (
    typeof input.originalSha256 !== "string" ||
    createHash("sha256").update(bytes).digest("hex") !== input.originalSha256
  ) {
    fail("original-mismatch");
  }
  return bytes;
}

function decodeOriginal(bytes, preserveLeadingBom = false) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: preserveLeadingBom }).decode(bytes);
  } catch {
    fail("invalid-original");
  }
}

function parseJsonOriginal(bytes) {
  const text = decodeOriginal(bytes);
  validateJsonSubset(text);
  try {
    return JSON.parse(text);
  } catch {
    fail("invalid-original");
  }
}

function validateJsonSubset(text) {
  let offset = 0;
  const whitespace = () => {
    while (/[\t\n\r ]/u.test(text[offset] ?? "")) offset += 1;
  };
  const string = () => {
    if (text[offset] !== '"') fail("invalid-original");
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      const character = text[offset];
      if (character === '"') {
        offset += 1;
        try {
          return JSON.parse(text.slice(start, offset));
        } catch {
          fail("invalid-original");
        }
      }
      if (character === "\\") offset += 1;
      offset += 1;
    }
    fail("invalid-original");
  };
  const value = () => {
    whitespace();
    const character = text[offset];
    if (character === '"') {
      string();
      return;
    }
    if (character === "{") {
      offset += 1;
      whitespace();
      const keys = new Set();
      if (text[offset] === "}") {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        const key = string();
        if (keys.has(key)) fail("invalid-original");
        keys.add(key);
        whitespace();
        if (text[offset] !== ":") fail("invalid-original");
        offset += 1;
        value();
        whitespace();
        if (text[offset] === "}") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") fail("invalid-original");
        offset += 1;
        whitespace();
      }
      fail("invalid-original");
    }
    if (character === "[") {
      offset += 1;
      whitespace();
      if (text[offset] === "]") {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        value();
        whitespace();
        if (text[offset] === "]") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") fail("invalid-original");
        offset += 1;
      }
      fail("invalid-original");
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length;
        return;
      }
    }
    const match = text.slice(offset).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
    if (!match) fail("invalid-original");
    const number = Number(match[0]);
    if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) {
      fail("invalid-original");
    }
    offset += match[0].length;
  };
  whitespace();
  value();
  whitespace();
  if (offset !== text.length) fail("invalid-original");
}

function pointerTokens(pointer) {
  if (pointer === "") return [];
  if (!/^(?:\/(?:[^~/]|~[01])*)+$/u.test(pointer)) fail("invalid-locator");
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function pointerValue(document, pointer) {
  let value = document;
  for (const token of pointerTokens(pointer)) {
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(token)) fail("locator-mismatch");
      value = value[Number(token)];
    } else if (value && typeof value === "object") {
      if (!Object.prototype.hasOwnProperty.call(value, token)) fail("locator-mismatch");
      value = value[token];
    } else {
      fail("locator-mismatch");
    }
    if (value === undefined) fail("locator-mismatch");
  }
  return value;
}

function pathsEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Return the original JSON number token at `pointer`, or undefined. */
function jsonNumberTokenAt(text, pointer) {
  const want = pointerTokens(pointer);
  let offset = 0;
  let token;
  const whitespace = () => {
    while (/[\t\n\r ]/u.test(text[offset] ?? "")) offset += 1;
  };
  const string = () => {
    if (text[offset] !== '"') fail("invalid-original");
    offset += 1;
    while (offset < text.length) {
      const character = text[offset];
      if (character === '"') {
        offset += 1;
        return;
      }
      if (character === "\\") offset += 1;
      offset += 1;
    }
    fail("invalid-original");
  };
  const value = (path) => {
    whitespace();
    const character = text[offset];
    if (character === '"') {
      string();
      return;
    }
    if (character === "{") {
      offset += 1;
      whitespace();
      if (text[offset] === "}") {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        if (text[offset] !== '"') fail("invalid-original");
        const start = offset;
        string();
        let key;
        try {
          key = JSON.parse(text.slice(start, offset));
        } catch {
          fail("invalid-original");
        }
        whitespace();
        if (text[offset] !== ":") fail("invalid-original");
        offset += 1;
        value([...path, key]);
        whitespace();
        if (text[offset] === "}") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") fail("invalid-original");
        offset += 1;
        whitespace();
      }
      fail("invalid-original");
    }
    if (character === "[") {
      offset += 1;
      whitespace();
      if (text[offset] === "]") {
        offset += 1;
        return;
      }
      let index = 0;
      while (offset < text.length) {
        value([...path, String(index)]);
        index += 1;
        whitespace();
        if (text[offset] === "]") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") fail("invalid-original");
        offset += 1;
        whitespace();
      }
      fail("invalid-original");
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length;
        return;
      }
    }
    const match = text.slice(offset).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
    if (!match) fail("invalid-original");
    if (pathsEqual(path, want)) token = match[0];
    offset += match[0].length;
  };
  whitespace();
  value([]);
  whitespace();
  if (offset !== text.length) fail("invalid-original");
  return token;
}

function notebookText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value.join("");
  }
  return undefined;
}

function notebookOutput(output) {
  let value = notebookText(output?.text);
  if (value === undefined && output?.data && !Array.isArray(output.data)) {
    value = notebookText(output.data["text/plain"]);
  }
  if (value === undefined && Array.isArray(output?.traceback)) {
    value = output.traceback.every((entry) => typeof entry === "string")
      ? output.traceback.join("\n")
      : undefined;
  }
  return value;
}

function quotedRange(value, startByte, endByte) {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  if (endByte > bytes.byteLength || endByte <= startByte) fail("locator-mismatch");
  return decodeOriginal(bytes.subarray(startByte, endByte), true);
}

/**
 * Independently match one text, JSON, or notebook quotation to original bytes.
 * YAML pointer production stays runtime-parser owned because this package does
 * not import the runtime or add a second YAML parser dependency.
 */
export function verifyStructuredQuotation(input) {
  const bytes = originalBytes(input);
  const normalized = locator(input.locator);
  if (typeof input.quotedText !== "string") fail("invalid-shape");
  if (normalized.kind === "text") {
    decodeOriginal(bytes);
    return quotedRange(bytes, normalized.startByte, normalized.endByte) === input.quotedText;
  }
  const parsed = parseJsonOriginal(bytes);
  if (normalized.kind === "json-pointer") {
    const actual = pointerValue(parsed, normalized.pointer);
    if (typeof actual === "number") {
      return jsonNumberTokenAt(decodeOriginal(bytes), normalized.pointer) === input.quotedText;
    }
    return JSON.stringify(actual) === input.quotedText;
  }
  if (!Array.isArray(parsed?.cells)) fail("invalid-original");
  const ids = new Set();
  for (const cell of parsed.cells) {
    if (typeof cell?.id !== "string") continue;
    if (ids.has(cell.id)) fail("duplicate-notebook-cell-id");
    ids.add(cell.id);
  }
  const cell = parsed.cells[normalized.cellOrdinal];
  if (!cell || (cell.id ?? null) !== normalized.cellId) fail("notebook-cell-ordinal-mismatch");
  const value =
    normalized.part === "source"
      ? notebookText(cell.source)
      : notebookOutput(cell.outputs?.[normalized.outputOrdinal]);
  if (value === undefined) fail("locator-mismatch");
  return quotedRange(value, normalized.startByte, normalized.endByte) === input.quotedText;
}
