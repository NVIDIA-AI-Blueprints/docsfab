// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ConversionContractError, type SubstitutionEntry } from "../contracts.js";

/**
 * Reads `myst_substitutions` from a Sphinx `conf.py` without executing it.
 * A top-level dictionary literal gives one entry per key: string literals
 * (including implicit concatenation) become literal values and anything else
 * is recorded as a computed expression for the host to enumerate as a unit.
 * A non-literal assignment, a second assignment, or a later mutation of the
 * dictionary is refused, because the reader could not name every value.
 */
export function readMystSubstitutions(confText: string, confPath: string): SubstitutionEntry[] {
  const source = confText.replace(/\r\n?/gu, "\n");
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") lineStarts.push(index + 1);
  }
  const lineAt = (offset: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (lineStarts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  const refuse = (detail: string, offset: number): never => {
    throw new ConversionContractError(
      "conversion-configuration-not-static",
      `${confPath}:${lineAt(offset)}: myst_substitutions ${detail}.`,
      { construct: "configuration:myst_substitutions" },
    );
  };

  const scanner = new PythonScanner(source);
  const statements = scanner.topLevelStatements();
  const occurrences = scanner.identifierOccurrences("myst_substitutions");
  const assignments: number[] = [];
  for (const statement of statements) {
    const text = source.slice(statement.start, statement.end);
    if (/^myst_substitutions\s*=(?!=)/u.test(text)) assignments.push(statement.start);
    else if (/^myst_substitutions\b/u.test(text)) {
      refuse("is changed after its assignment, so its values are not static", statement.start);
    }
  }
  if (assignments.length === 0) {
    if (occurrences.length > 0) {
      refuse("is referenced or changed without a static assignment", occurrences[0]!);
    }
    return [];
  }
  if (assignments.length > 1) refuse("is assigned more than once", assignments[1]!);
  const assignment = assignments[0]!;
  const assignmentStatement = statements.find((statement) => statement.start === assignment)!;
  if (occurrences.length !== 1 || occurrences[0] !== assignment) {
    const unexpected = occurrences.find((offset) => offset !== assignment) ?? assignment;
    refuse(
      "is referenced or changed outside its single assignment, so its values are not static",
      unexpected,
    );
  }
  let cursor = source.indexOf("=", assignment) + 1;
  cursor = scanner.skipInlineSpace(cursor);
  if (source[cursor] !== "{") refuse("is not a dictionary literal", assignment);
  const close = scanner.matchingBracket(cursor);
  if (close === undefined) refuse("has an unterminated dictionary literal", assignment);
  if (!scanner.onlyWhitespaceAndComments(close! + 1, assignmentStatement.end)) {
    refuse(
      "has an expression after its dictionary literal, so its values are not static",
      close! + 1,
    );
  }

  const entries: SubstitutionEntry[] = [];
  const seen = new Set<string>();
  for (const item of scanner.splitTopLevel(cursor + 1, close!)) {
    const colon = scanner.topLevelColon(item.start, item.end);
    if (colon === undefined) refuse("has an entry that is not `key: value`", item.start);
    const key = scanner.stringLiteral(item.start, colon!);
    if (key === undefined) refuse("has a key that is not a string literal", item.start);
    if (seen.has(key!)) refuse(`repeats the key ${JSON.stringify(key)}`, item.start);
    seen.add(key!);
    const expression = source.slice(colon! + 1, item.end).trim();
    const literal = scanner.stringLiteral(colon! + 1, item.end);
    entries.push({
      name: key!,
      value:
        literal !== undefined
          ? { kind: "literal", text: literal }
          : { kind: "computed", expression },
      origin: {
        kind: "configuration",
        path: confPath,
        span: {
          startLine: lineAt(item.start),
          endLine: lineAt(Math.max(item.start, item.end - 1)),
        },
      },
    });
  }
  return entries;
}

interface Range {
  start: number;
  end: number;
}

const OPENERS: Readonly<Record<string, string>> = Object.freeze({ "{": "}", "[": "]", "(": ")" });

/** Just enough Python lexing to find statements, brackets, and string literals. */
class PythonScanner {
  public constructor(private readonly source: string) {}

  /** End offset of the string literal starting at `index`, or undefined when none starts there. */
  private stringEnd(
    index: number,
  ):
    | { end: number; raw: boolean; formatted: boolean; quote: string; bodyStart: number }
    | undefined {
    const match = /^([rRuUbBfF]{0,2})('''|"""|'|")/u.exec(this.source.slice(index, index + 5));
    if (!match) return undefined;
    const prefix = match[1]!.toLowerCase();
    const quote = match[2]!;
    const bodyStart = index + match[0].length;
    const raw = prefix.includes("r");
    let cursor = bodyStart;
    while (cursor < this.source.length) {
      const character = this.source[cursor]!;
      if (character === "\\") {
        cursor += 2;
        continue;
      }
      if (quote.length === 1 && character === "\n") return undefined;
      if (this.source.startsWith(quote, cursor)) {
        return {
          end: cursor + quote.length,
          raw,
          formatted: prefix.includes("f") || prefix.includes("b"),
          quote,
          bodyStart,
        };
      }
      cursor += 1;
    }
    return undefined;
  }

  /** Offset after a comment, string, or single character starting at `index`. */
  private advance(index: number): number {
    const character = this.source[index]!;
    if (character === "#") {
      const newline = this.source.indexOf("\n", index);
      return newline < 0 ? this.source.length : newline;
    }
    const literal = /[rRuUbBfF'"]/u.test(character) ? this.stringEnd(index) : undefined;
    if (
      literal &&
      (character === "'" || character === '"' || !/[\w]/u.test(this.source[index - 1] ?? ""))
    ) {
      return literal.end;
    }
    return index + 1;
  }

  public topLevelStatements(): Range[] {
    const statements: Range[] = [];
    let depth = 0;
    let start: number | undefined;
    let index = 0;
    while (index < this.source.length) {
      const next = this.advance(index);
      if (next !== index + 1) {
        index = next;
        continue;
      }
      const character = this.source[index]!;
      const lineStart = index === 0 || this.source[index - 1] === "\n";
      if (lineStart && depth === 0 && start === undefined && /[A-Za-z_]/u.test(character))
        start = index;
      if (character === "\n" && depth === 0 && this.source[index - 1] !== "\\") {
        if (start !== undefined) statements.push({ start, end: index });
        start = undefined;
        index += 1;
        continue;
      }
      if (character in OPENERS) depth += 1;
      else if (character === "}" || character === "]" || character === ")")
        depth = Math.max(0, depth - 1);
      index = this.advance(index);
    }
    if (start !== undefined) statements.push({ start, end: this.source.length });
    return statements;
  }

  /** All code-token occurrences of an identifier, excluding comments and strings. */
  public identifierOccurrences(identifier: string): number[] {
    const occurrences: number[] = [];
    let index = 0;
    while (index < this.source.length) {
      const next = this.advance(index);
      if (next !== index + 1) {
        index = next;
        continue;
      }
      if (/[A-Za-z_]/u.test(this.source[index]!)) {
        const start = index;
        index += 1;
        while (index < this.source.length && /[\w]/u.test(this.source[index]!)) index += 1;
        if (this.source.slice(start, index) === identifier) occurrences.push(start);
      } else {
        index = this.advance(index);
      }
    }
    return occurrences;
  }

  /** True only when the suffix contains whitespace and comments, not more Python syntax. */
  public onlyWhitespaceAndComments(start: number, end: number): boolean {
    let index = start;
    while (index < end) {
      if (/\s/u.test(this.source[index]!)) {
        index += 1;
      } else if (this.source[index] === "#") {
        const newline = this.source.indexOf("\n", index);
        index = newline < 0 || newline >= end ? end : newline;
      } else {
        return false;
      }
    }
    return true;
  }

  public skipInlineSpace(index: number): number {
    let cursor = index;
    while (this.source[cursor] === " " || this.source[cursor] === "\t") cursor += 1;
    return cursor;
  }

  public matchingBracket(open: number): number | undefined {
    const stack: string[] = [];
    let index = open;
    while (index < this.source.length) {
      const next = this.advance(index);
      if (next !== index + 1) {
        index = next;
        continue;
      }
      const character = this.source[index]!;
      if (character in OPENERS) stack.push(OPENERS[character]!);
      else if (character === "}" || character === "]" || character === ")") {
        if (stack.pop() !== character) return undefined;
        if (stack.length === 0) return index;
      }
      index = this.advance(index);
    }
    return undefined;
  }

  /** Comma-separated items between `start` and `end` at bracket depth zero, without blanks. */
  public splitTopLevel(start: number, end: number): Range[] {
    const items: Range[] = [];
    let depth = 0;
    let itemStart = start;
    let index = start;
    const push = (itemEnd: number): void => {
      const text = this.source.slice(itemStart, itemEnd);
      const leading = /^(?:\s|#[^\n]*)*/u.exec(text)![0].length;
      if (leading < text.length) items.push({ start: itemStart + leading, end: itemEnd });
    };
    while (index < end) {
      const next = this.advance(index);
      if (next !== index + 1) {
        index = next;
        continue;
      }
      const character = this.source[index]!;
      if (character in OPENERS) depth += 1;
      else if (character === "}" || character === "]" || character === ")") depth -= 1;
      else if (character === "," && depth === 0) {
        push(index);
        itemStart = index + 1;
      }
      index = this.advance(index);
    }
    push(end);
    return items;
  }

  public topLevelColon(start: number, end: number): number | undefined {
    let depth = 0;
    let index = start;
    while (index < end) {
      const next = this.advance(index);
      if (next !== index + 1) {
        index = next;
        continue;
      }
      const character = this.source[index]!;
      if (character in OPENERS) depth += 1;
      else if (character === "}" || character === "]" || character === ")") depth -= 1;
      else if (character === ":" && depth === 0) return index;
      index = this.advance(index);
    }
    return undefined;
  }

  /** The value of one or more adjacent plain string literals spanning `start..end`, else undefined. */
  public stringLiteral(start: number, end: number): string | undefined {
    let index = start;
    let value = "";
    let found = false;
    for (;;) {
      while (index < end && /\s/u.test(this.source[index]!)) index += 1;
      if (index < end && this.source[index] === "#") {
        const newline = this.source.indexOf("\n", index);
        index = newline < 0 || newline > end ? end : newline;
        continue;
      }
      if (index >= end) break;
      const literal = this.stringEnd(index);
      if (!literal || literal.formatted || literal.end > end) return undefined;
      const body = this.source.slice(literal.bodyStart, literal.end - literal.quote.length);
      value += literal.raw ? body : unescapePython(body);
      found = true;
      index = literal.end;
    }
    return found ? value : undefined;
  }
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  "\n": "",
  "\\": "\\",
  "'": "'",
  '"': '"',
  a: "\u0007",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
});

function unescapePython(body: string): string {
  return body.replace(
    /\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{1,3}|[\s\S])/gu,
    (whole, sequence: string) => {
      if (/^[xuU]/u.test(sequence) && sequence.length > 1) {
        const code = Number.parseInt(sequence.slice(1), 16);
        return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      if (/^[0-7]+$/u.test(sequence)) return String.fromCodePoint(Number.parseInt(sequence, 8));
      return SIMPLE_ESCAPES[sequence] ?? whole;
    },
  );
}
