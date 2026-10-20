// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** One source line without its line ending; `line` is the one-based line in the owning document. */
export interface SourceLine {
  readonly text: string;
  readonly line: number;
}

export const TAB_STOP = 4;

export function isBlank(text: string): boolean {
  return /^[ \t]*$/u.test(text);
}

/** Columns of leading whitespace, with tabs advancing to the next tab stop. */
export function indentOf(text: string): number {
  let columns = 0;
  for (const character of text) {
    if (character === " ") columns += 1;
    else if (character === "\t") columns += TAB_STOP - (columns % TAB_STOP);
    else break;
  }
  return columns;
}

/**
 * Remove up to `columns` columns of leading whitespace. A tab that spans the
 * cut keeps its remaining columns as spaces, so content alignment survives.
 */
export function stripIndent(text: string, columns: number): string {
  let consumed = 0;
  let index = 0;
  while (index < text.length && consumed < columns) {
    const character = text[index];
    if (character === " ") {
      consumed += 1;
      index += 1;
    } else if (character === "\t") {
      const width = TAB_STOP - (consumed % TAB_STOP);
      if (consumed + width > columns) {
        return " ".repeat(consumed + width - columns) + text.slice(index + 1);
      }
      consumed += width;
      index += 1;
    } else {
      break;
    }
  }
  return text.slice(index);
}

export function withText(line: SourceLine, text: string): SourceLine {
  return { text, line: line.line };
}

/** Split decoded page text into lines, normalizing CRLF and CR line endings. */
export function splitSourceLines(text: string, firstLine = 1): SourceLine[] {
  const parts = text.replace(/\r\n?/gu, "\n").split("\n");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts.map((part, index) => ({ text: part, line: firstLine + index }));
}

export interface FenceOpening {
  readonly indent: number;
  readonly marker: string;
  readonly info: string;
}

const BACKTICK_OR_TILDE_FENCE = /^(`{3,}|~{3,})(.*)$/u;
const COLON_FENCE = /^(:{3,})[ \t]*(\{[^\s{}]+\}(?:[ \t].*)?)$/u;

/** A code or directive fence opening at up to three columns of indentation. */
export function fenceOpening(text: string): FenceOpening | undefined {
  const indent = indentOf(text);
  if (indent > 3) return undefined;
  const rest = stripIndent(text, indent);
  const match = BACKTICK_OR_TILDE_FENCE.exec(rest) ?? COLON_FENCE.exec(rest);
  if (!match) return undefined;
  const marker = match[1]!;
  const info = match[2]!;
  if (marker.startsWith("`") && info.includes("`")) return undefined;
  return { indent, marker, info: info.trim() };
}

/** A closing fence: the opening character, at least as many of it, and nothing else. */
export function closesFence(text: string, marker: string): boolean {
  const indent = indentOf(text);
  if (indent > 3) return false;
  const rest = stripIndent(text, indent).trimEnd();
  const character = marker[0]!;
  if (rest.length < marker.length) return false;
  for (const each of rest) if (each !== character) return false;
  return true;
}

/**
 * Tracks whether a run of lines ends inside an open fence, so container
 * collection does not treat a fenced line as lazy paragraph continuation.
 */
export class FenceTracker {
  private open: string | undefined;

  public observe(text: string): void {
    if (this.open !== undefined) {
      if (closesFence(text, this.open)) this.open = undefined;
      return;
    }
    const opening = fenceOpening(text);
    if (opening) this.open = opening.marker;
  }

  public get inFence(): boolean {
    return this.open !== undefined;
  }
}
