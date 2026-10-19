// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type JsonEvidencePrimitive = string | number | boolean | null;

export type JsonEvidenceValue =
  | JsonEvidencePrimitive
  | JsonEvidenceValue[]
  | { [key: string]: JsonEvidenceValue };

export type JsonEvidenceErrorCode =
  | "invalid-utf8"
  | "malformed-json"
  | "duplicate-key"
  | "unsafe-number"
  | "noncanonical-json";

export interface JsonEvidenceParseOptions {
  requireCanonical?: boolean;
}

/** Finite parser diagnostics; never carry rejected input or offsets. */
export type JsonEvidenceSyntaxDetail =
  | "unexpected-end"
  | "unexpected-token"
  | "invalid-escape"
  | "unescaped-control"
  | "unpaired-surrogate";

const MAX_NESTING_DEPTH = 256;

export class JsonEvidenceError extends Error {
  readonly detail?: JsonEvidenceSyntaxDetail;
  readonly code: JsonEvidenceErrorCode;
  /**
   * Character index where the strict parser stopped, when it raised the error
   * itself. A position, never text: the message above stays offset-free, and a
   * caller that records this number (the reply shape fingerprint) records where
   * a reply broke without copying any of it.
   */
  readonly offset?: number;
  constructor(code: JsonEvidenceErrorCode, detail?: JsonEvidenceSyntaxDetail, offset?: number) {
    super(`JSON evidence rejected: ${code}`);
    this.detail = detail;
    this.name = "JsonEvidenceError";
    this.code = code;
    if (offset !== undefined) this.offset = offset;
  }
}

export function parseJsonEvidence(
  input: string | Uint8Array,
  options: JsonEvidenceParseOptions = {},
): JsonEvidenceValue {
  const source = decodeInput(input);

  try {
    const value = new StrictJsonParser(source).parse();
    if (options.requireCanonical && canonicalizeJsonEvidence(value) !== source) {
      throw new JsonEvidenceError("noncanonical-json");
    }
    return value;
  } catch (error) {
    if (error instanceof JsonEvidenceError) {
      throw error;
    }
    throw new JsonEvidenceError("malformed-json");
  }
}

export function isJsonEvidence(
  input: string | Uint8Array,
  options: JsonEvidenceParseOptions = {},
): boolean {
  try {
    parseJsonEvidence(input, options);
    return true;
  } catch {
    return false;
  }
}

export function canonicalizeJsonEvidence(value: JsonEvidenceValue): string {
  return `${serializeCanonical(value, 0, new Set<object>())}\n`;
}

function decodeInput(input: string | Uint8Array): string {
  if (typeof input === "string") {
    if (input.startsWith("\uFEFF")) {
      throw new JsonEvidenceError("malformed-json");
    }
    return input;
  }

  if (input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
    throw new JsonEvidenceError("malformed-json");
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw new JsonEvidenceError("invalid-utf8");
  }
}

class StrictJsonParser {
  private readonly source: string;
  private index = 0;
  constructor(source: string) {
    this.source = source;
  }

  parse(): JsonEvidenceValue {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.source.length) {
      this.fail("malformed-json");
    }
    return value;
  }

  private parseValue(depth: number): JsonEvidenceValue {
    if (depth > MAX_NESTING_DEPTH) {
      this.fail("malformed-json");
    }

    const token = this.source[this.index];
    switch (token) {
      case "{":
        return this.parseObject(depth);
      case "[":
        return this.parseArray(depth);
      case '"':
        return this.parseString();
      case "t":
        return this.parseLiteral("true", true);
      case "f":
        return this.parseLiteral("false", false);
      case "n":
        return this.parseLiteral("null", null);
      default:
        if (token === "-" || isDigit(token)) {
          return this.parseNumber();
        }
        return this.fail("malformed-json");
    }
  }

  private parseObject(depth: number): { [key: string]: JsonEvidenceValue } {
    this.index += 1;
    this.skipWhitespace();
    const output: { [key: string]: JsonEvidenceValue } = {};
    const keys = new Set<string>();

    if (this.consume("}")) {
      return output;
    }

    while (true) {
      if (this.source[this.index] !== '"') {
        this.fail("malformed-json");
      }
      const key = this.parseString();
      if (keys.has(key)) {
        this.fail("duplicate-key");
      }
      keys.add(key);

      this.skipWhitespace();
      if (!this.consume(":")) {
        this.fail("malformed-json");
      }
      this.skipWhitespace();
      const value = this.parseValue(depth + 1);
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });

      this.skipWhitespace();
      if (this.consume("}")) {
        return output;
      }
      if (!this.consume(",")) {
        this.fail("malformed-json");
      }
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): JsonEvidenceValue[] {
    this.index += 1;
    this.skipWhitespace();
    const output: JsonEvidenceValue[] = [];

    if (this.consume("]")) {
      return output;
    }

    while (true) {
      output.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      if (this.consume("]")) {
        return output;
      }
      if (!this.consume(",")) {
        this.fail("malformed-json");
      }
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;

    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === '"') {
        this.index += 1;
        const decoded = JSON.parse(this.source.slice(start, this.index)) as string;
        if (hasUnpairedSurrogate(decoded)) {
          this.fail("malformed-json", "unpaired-surrogate");
        }
        return decoded;
      }
      if (character === "\\") {
        this.index += 1;
        const escaped = this.source[this.index];
        if (escaped === "u") {
          const hex = this.source.slice(this.index + 1, this.index + 5);
          if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/u.test(hex)) {
            this.fail("malformed-json", "invalid-escape");
          }
          this.index += 5;
          continue;
        }
        if (escaped === undefined || !'"\\/bfnrt'.includes(escaped)) {
          this.fail("malformed-json", escaped === undefined ? "unexpected-end" : "invalid-escape");
        }
        this.index += 1;
        continue;
      }
      if (character === undefined || character.charCodeAt(0) < 0x20) {
        this.fail("malformed-json", "unescaped-control");
      }
      this.index += 1;
    }

    return this.fail("malformed-json");
  }

  private parseNumber(): number {
    const remainder = this.source.slice(this.index);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(remainder);
    const token = match?.[0];
    if (token === undefined) {
      return this.fail("malformed-json");
    }
    this.index += token.length;

    const value = Number(token);
    if (
      !Number.isFinite(value) ||
      Object.is(value, -0) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value)) ||
      (value === 0 && containsNonzeroMantissaDigit(token))
    ) {
      return this.fail("unsafe-number");
    }
    return value;
  }

  private parseLiteral<T extends boolean | null>(literal: string, value: T): T {
    if (!this.source.startsWith(literal, this.index)) {
      return this.fail("malformed-json");
    }
    this.index += literal.length;
    return value;
  }

  private skipWhitespace(): void {
    while (
      this.source[this.index] === " " ||
      this.source[this.index] === "\t" ||
      this.source[this.index] === "\n" ||
      this.source[this.index] === "\r"
    ) {
      this.index += 1;
    }
  }

  private consume(character: string): boolean {
    if (this.source[this.index] !== character) {
      return false;
    }
    this.index += 1;
    return true;
  }

  private fail(code: JsonEvidenceErrorCode, detail?: JsonEvidenceSyntaxDetail): never {
    throw new JsonEvidenceError(
      code,
      code === "malformed-json"
        ? (detail ?? (this.index >= this.source.length ? "unexpected-end" : "unexpected-token"))
        : undefined,
      this.index,
    );
  }
}

function serializeCanonical(
  value: JsonEvidenceValue,
  depth: number,
  ancestors: Set<object>,
): string {
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      Object.is(value, -0) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      throw new JsonEvidenceError("unsafe-number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (hasUnpairedSurrogate(value)) {
      throw new JsonEvidenceError("malformed-json");
    }
    return JSON.stringify(value);
  }
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (depth > MAX_NESTING_DEPTH || ancestors.has(value)) {
    throw new JsonEvidenceError("malformed-json");
  }

  ancestors.add(value);
  const indentation = "  ".repeat(depth);
  const childIndentation = "  ".repeat(depth + 1);
  let serialized: string;

  if (Array.isArray(value)) {
    serialized =
      value.length === 0
        ? "[]"
        : `[\n${value.map((item) => `${childIndentation}${serializeCanonical(item, depth + 1, ancestors)}`).join(",\n")}\n${indentation}]`;
  } else {
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      if (hasUnpairedSurrogate(key)) {
        ancestors.delete(value);
        throw new JsonEvidenceError("malformed-json");
      }
    }
    serialized =
      keys.length === 0
        ? "{}"
        : `{\n${keys.map((key) => `${childIndentation}${JSON.stringify(key)}: ${serializeCanonical(value[key]!, depth + 1, ancestors)}`).join(",\n")}\n${indentation}}`;
  }

  ancestors.delete(value);
  return serialized;
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

function containsNonzeroMantissaDigit(token: string): boolean {
  const mantissa = token.split(/[eE]/u, 1)[0] ?? "";
  return /[1-9]/u.test(mantissa);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || following < 0xdc00 || following > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
