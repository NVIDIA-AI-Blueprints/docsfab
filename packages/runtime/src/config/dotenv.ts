// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The runtime's one dotenv grammar, shared by every reader of a
 * configuration-root .env or secrets.env and by the secrets.env writer.
 *
 * An assignment is 'KEY=value' with an optional 'export' prefix, whitespace
 * around '=', and an upper-case name. A value is one of:
 * - double-quoted, where only '\\' and '\"' are escapes (any other backslash
 *   stays literal) and '#' is part of the value;
 * - single-quoted, taken literally;
 * - bare, ending at a '#' that starts the value or follows whitespace (a
 *   comment), with trailing whitespace removed.
 * A quoted value followed by anything but whitespace or a comment, or one that
 * is not closed on its line, is read as a bare value. Blank lines, comments,
 * and lines that are not an upper-case assignment are skipped, never refused.
 */
const ASSIGNMENT_PREFIX = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*/u;
const COMMENT_OR_BLANK = /^\s*(?:#.*)?$/u;

export interface DotenvLine {
  readonly key: string;
  readonly value: string;
  /** True when a quoted value is not closed on its line, as in a multi-line value. */
  readonly unterminated: boolean;
}

export interface DotenvAssignment {
  readonly value: string;
  /** One-based line number of the assignment that wins (the last one). */
  readonly line: number;
}

/** Split text into lines without their terminators ('\r\n', '\n', or '\r'). */
export function splitDotenvLines(source: string): string[] {
  return source.split(/\r\n|\n|\r/u);
}

/** Parse one line; undefined when the line assigns nothing. */
export function parseDotenvLine(raw: string): DotenvLine | undefined {
  if (COMMENT_OR_BLANK.test(raw)) return undefined;
  const match = ASSIGNMENT_PREFIX.exec(raw);
  if (!match) return undefined;
  const rest = raw.slice(match[0].length);
  const quoted = readQuotedValue(rest);
  if (quoted?.complete) return { key: match[1]!, value: quoted.value, unterminated: false };
  return {
    key: match[1]!,
    value: readBareValue(rest),
    unterminated: quoted?.unterminated ?? false,
  };
}

export function parseDotenvAssignmentLines(source: string): Map<string, DotenvAssignment> {
  const assignments = new Map<string, DotenvAssignment>();
  splitDotenvLines(source).forEach((raw, index) => {
    const parsed = parseDotenvLine(raw);
    if (parsed) assignments.set(parsed.key, { value: parsed.value, line: index + 1 });
  });
  return assignments;
}

export function parseDotenvAssignments(source: string): Map<string, string> {
  return new Map(
    [...parseDotenvAssignmentLines(source)].map(([key, assignment]) => [key, assignment.value]),
  );
}

/**
 * Serialize one assignment so that parseDotenvLine reads back exactly
 * 'value'. Returns undefined when this line grammar cannot hold the value
 * (a line break or NUL); callers must refuse rather than write it.
 */
export function serializeDotenvAssignment(key: string, value: string): string | undefined {
  if (/[\r\n\0]/u.test(value)) return undefined;
  const encoded = /^[^\s#"'\\]*$/u.test(value)
    ? value
    : `"${value.replace(/[\\"]/gu, (character) => `\\${character}`)}"`;
  const line = `${key}=${encoded}`;
  const parsed = parseDotenvLine(line);
  return parsed?.key === key && parsed.value === value && !parsed.unterminated ? line : undefined;
}

function readQuotedValue(
  rest: string,
):
  | { readonly value: string; readonly complete: boolean; readonly unterminated: boolean }
  | undefined {
  const quote = rest[0];
  if (quote !== '"' && quote !== "'") return undefined;
  let value = "";
  for (let index = 1; index < rest.length; index += 1) {
    const character = rest[index]!;
    const next = rest[index + 1];
    if (quote === '"' && character === "\\" && (next === "\\" || next === '"')) {
      value += next;
      index += 1;
      continue;
    }
    if (character === quote) {
      const complete = COMMENT_OR_BLANK.test(rest.slice(index + 1));
      return { value, complete, unterminated: false };
    }
    value += character;
  }
  return { value, complete: false, unterminated: true };
}

function readBareValue(rest: string): string {
  const comment = rest.search(/(?:^|\s)#/u);
  const value = (comment === -1 ? rest : rest.slice(0, comment)).trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
