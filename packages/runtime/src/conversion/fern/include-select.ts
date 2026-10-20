// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { LineRange } from "../contracts.js";
import { normalizeNewlines } from "./escape.js";

export interface IncludeSelectionOptions {
  pyobject?: string;
  startAfter?: string;
  endBefore?: string;
  lines?: readonly LineRange[];
}

export type IncludeSelection =
  | { ok: true; text: string; linesBeyondEnd: boolean }
  | { ok: false; reason: string };

const DEFINITION = /^([ \t]*)(?:async[ \t]+def|def|class)[ \t]+([A-Za-z_][A-Za-z0-9_]*)\b/u;

function indentOf(line: string): number {
  return (/^[ \t]*/u.exec(line)?.[0] ?? "").length;
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

/**
 * Lines `[start, end)` of the named Python object, decorators included, as
 * Sphinx `:pyobject:` selects it. The block ends at the first non-blank line
 * indented no deeper than the definition; trailing blank lines are dropped.
 */
function pythonObjectRange(lines: readonly string[], dotted: string): [number, number] | undefined {
  let start = 0;
  let end = lines.length;
  let indent = -1;
  const names = dotted.split(".");
  for (const [position, name] of names.entries()) {
    let found: number | undefined;
    let bodyIndent: number | undefined;
    for (let index = start; index < end; index += 1) {
      const line = lines[index] as string;
      if (isBlank(line)) continue;
      const lineIndent = indentOf(line);
      if (bodyIndent === undefined) {
        if (lineIndent <= indent) break;
        bodyIndent = lineIndent;
      }
      if (lineIndent !== bodyIndent) continue;
      const match = DEFINITION.exec(line);
      if (match?.[2] === name) {
        found = index;
        break;
      }
    }
    if (found === undefined || bodyIndent === undefined) return undefined;
    indent = bodyIndent;
    let blockEnd = found + 1;
    while (blockEnd < end) {
      const line = lines[blockEnd] as string;
      if (!isBlank(line) && indentOf(line) <= indent) break;
      blockEnd += 1;
    }
    while (blockEnd > found + 1 && isBlank(lines[blockEnd - 1] as string)) blockEnd -= 1;
    let blockStart = found;
    while (blockStart > start) {
      const previous = lines[blockStart - 1] as string;
      if (indentOf(previous) !== indent || !previous.trimStart().startsWith("@")) break;
      blockStart -= 1;
    }
    start = position === names.length - 1 ? blockStart : found + 1;
    end = blockEnd;
  }
  return [start, end];
}

/**
 * Apply literal-include selections in Sphinx's order: `:pyobject:`, then
 * `:start-after:` and `:end-before:` (first line containing the marker), then
 * `:lines:`.
 */
export function selectIncludeText(
  source: string,
  options: IncludeSelectionOptions,
): IncludeSelection {
  let lines = normalizeNewlines(source).split("\n");
  if (lines.at(-1) === "") lines = lines.slice(0, -1);
  if (options.pyobject !== undefined) {
    const range = pythonObjectRange(lines, options.pyobject);
    if (range === undefined) {
      return { ok: false, reason: `No Python object ${options.pyobject} in the file.` };
    }
    lines = lines.slice(range[0], range[1]);
  }
  if (options.startAfter !== undefined) {
    const marker = options.startAfter;
    const at = lines.findIndex((line) => line.includes(marker));
    if (at < 0) return { ok: false, reason: `No line contains the start-after marker ${marker}.` };
    lines = lines.slice(at + 1);
  }
  if (options.endBefore !== undefined) {
    const marker = options.endBefore;
    const at = lines.findIndex((line) => line.includes(marker));
    if (at < 0) return { ok: false, reason: `No line contains the end-before marker ${marker}.` };
    lines = lines.slice(0, at);
  }
  let linesBeyondEnd = false;
  if (options.lines !== undefined) {
    const selected: string[] = [];
    for (const range of options.lines) {
      if (range.start < 1 || range.end < range.start || range.start > lines.length) {
        return {
          ok: false,
          reason: `Line range ${range.start}-${range.end} is outside the ${lines.length} selected lines.`,
        };
      }
      if (range.end > lines.length) linesBeyondEnd = true;
      selected.push(...lines.slice(range.start - 1, Math.min(range.end, lines.length)));
    }
    lines = selected;
  }
  return { ok: true, text: lines.join("\n"), linesBeyondEnd };
}
