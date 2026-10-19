// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ToolFailureCategory } from "../records/contracts.js";

/** Model-facing sentence per `grep` failure kind, each naming the fix. */
export const GREP_FAILURE_MESSAGES = Object.freeze({
  "regex-rejected":
    "DocsFab grep could not parse the pattern as a regular expression. To search for the text as written, set literal to true, or escape ( ) [ ] { } * + ? with a backslash; look-around and backreferences are not supported. Then call grep again.",
  "line-break":
    "DocsFab grep matches one line at a time, so the pattern cannot hold a line break. Search for one line of the text, then call grep again.",
  "glob-rejected":
    "DocsFab grep could not parse the glob. Send a file glob such as *.md or docs/**/*.md, or leave glob out, then call grep again.",
  "unreadable-path":
    "DocsFab grep could not read a file or directory under the searched path, so it returned no matches. Search a narrower path, or read the files you need with read.",
  "ripgrep-unavailable":
    "DocsFab grep cannot run on this host because ripgrep is unavailable. Use find to locate files and read to read them.",
} as const);

export type GrepFailureKind = keyof typeof GREP_FAILURE_MESSAGES;

export function isGrepFailureKind(value: unknown): value is GrepFailureKind {
  return typeof value === "string" && Object.hasOwn(GREP_FAILURE_MESSAGES, value);
}

export const GREP_FAILURE_CATEGORIES: Readonly<Record<GrepFailureKind, ToolFailureCategory>> =
  Object.freeze({
    "regex-rejected": "unsupported-pattern",
    "line-break": "unsupported-pattern",
    "glob-rejected": "unsupported-pattern",
    "unreadable-path": "tool-defect",
    "ripgrep-unavailable": "tool-defect",
  });

const GREP_FAILURE_PATTERNS: readonly (readonly [RegExp, GrepFailureKind])[] = [
  [/^(?:rg: )?regex parse error:/u, "regex-rejected"],
  [/^(?:rg: )?the literal [\s\S]+ is not allowed in a regex/u, "line-break"],
  [/^(?:rg: )?error parsing glob /u, "glob-rejected"],
  [/^ripgrep \(rg\) is not available and could not be downloaded$/u, "ripgrep-unavailable"],
  [/^Failed to run ripgrep: /u, "ripgrep-unavailable"],
];

const RIPGREP_UNREADABLE_PATH_LINE =
  /^(?:rg: )?.+: (?:Permission denied|Operation not permitted) \(os error \d+\)$/u;

/** Pure classifier shared with the isolated worker; it imports no credential state. */
export function classifyGrepFailure(error: unknown): GrepFailureKind | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.name === "ConfinedToolError") return undefined;
  const transported = (error as Error & { readonly docsfabGrepFailureKind?: unknown })
    .docsfabGrepFailureKind;
  if (isGrepFailureKind(transported)) return transported;
  if ((error as NodeJS.ErrnoException).code !== undefined) return undefined;
  const kind = GREP_FAILURE_PATTERNS.find(([pattern]) => pattern.test(error.message))?.[1];
  if (kind !== undefined) return kind;
  return error.message.split("\n").every((line) => RIPGREP_UNREADABLE_PATH_LINE.test(line))
    ? "unreadable-path"
    : undefined;
}
