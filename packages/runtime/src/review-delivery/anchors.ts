// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { sha256 } from "../content-ir/canonical.js";

export type ReviewDiffState = "complete" | "absent" | "truncated";
export type ReviewDiffSide = "before" | "after";
export type ReviewDiffLineKind = "context" | "added" | "removed";

/** One line from a provider-neutral parsed diff. Line numbers are one-based. */
export interface ReviewDiffLine {
  readonly kind: ReviewDiffLineKind;
  readonly text: string;
  readonly beforeLine: number | null;
  readonly afterLine: number | null;
}

export interface ReviewDiffHunk {
  readonly lines: readonly ReviewDiffLine[];
}

/** Immutable bytes and parsed diff facts for one changed path, including renames and deletions. */
export interface ReviewDiffFile {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly beforeBytes: Uint8Array | null;
  readonly afterBytes: Uint8Array | null;
  readonly beforeSha256: string | null;
  readonly afterSha256: string | null;
  readonly state: ReviewDiffState;
  readonly hunks: readonly ReviewDiffHunk[];
}

export interface ReviewSourceLocation {
  readonly path: string;
  /** Explicit provider/canonical diff side; omitted locations require a unique source side. */
  readonly side?: ReviewDiffSide;
  /** Exact source line when canonical evidence has one. */
  readonly line?: number;
  /** Exact source line range when canonical evidence has one. */
  readonly endLine?: number;
  /** Optional exact source text for legacy locators without line numbers. */
  readonly text?: string;
}

export interface ReviewResolvedAnchor {
  readonly status: "anchored";
  readonly side: ReviewDiffSide;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly sourceSha256: string;
}

export interface ReviewUnresolvedAnchor {
  readonly status: "summary";
  readonly reason:
    | "diff-absent"
    | "diff-truncated"
    | "path-not-in-diff"
    | "deleted-location"
    | "source-missing"
    | "source-digest-mismatch"
    | "invalid-range"
    | "location-not-in-diff"
    | "ambiguous-text"
    | "ambiguous-side"
    | "diff-invalid"
    | "source-invalid-encoding";
}

export type ReviewAnchorResolution = ReviewResolvedAnchor | ReviewUnresolvedAnchor;

interface SourceLine {
  readonly text: string;
  /** Preserve terminators so unchanged spans cannot hide edits to CRLF or final LF. */
  readonly raw: string;
}

function sourceLines(bytes: Uint8Array): readonly SourceLine[] | null {
  try {
    // The canonical diff parser retains a content BOM and removes CR from CRLF rows.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text === "") return [];
    const parts = text.split("\n");
    if (parts.at(-1) === "") parts.pop();
    return parts.map((part, index) => ({
      text: part.endsWith("\r") ? part.slice(0, -1) : part,
      raw: index < parts.length - 1 || text.endsWith("\n") ? `${part}\n` : part,
    }));
  } catch {
    return null;
  }
}

function verifyDiffFile(file: ReviewDiffFile):
  | ReviewUnresolvedAnchor
  | {
      before: readonly SourceLine[] | null;
      after: readonly SourceLine[] | null;
    } {
  if (
    (file.oldPath !== null && file.beforeBytes === null) ||
    (file.newPath !== null && file.afterBytes === null)
  )
    return { status: "summary", reason: "source-missing" };
  if (
    (file.oldPath === null && file.beforeBytes !== null) ||
    (file.newPath === null && file.afterBytes !== null)
  )
    return { status: "summary", reason: "diff-invalid" };
  for (const side of ["before", "after"] as const) {
    const bytes = side === "before" ? file.beforeBytes : file.afterBytes;
    const digest = side === "before" ? file.beforeSha256 : file.afterSha256;
    if ((bytes === null) !== (digest === null))
      return { status: "summary", reason: "source-missing" };
    if (bytes !== null && sha256(bytes) !== digest)
      return { status: "summary", reason: "source-digest-mismatch" };
  }
  const before = file.beforeBytes === null ? null : sourceLines(file.beforeBytes);
  const after = file.afterBytes === null ? null : sourceLines(file.afterBytes);
  if (
    (file.beforeBytes !== null && before === null) ||
    (file.afterBytes !== null && after === null)
  )
    return { status: "summary", reason: "source-invalid-encoding" };
  const beforeLines = before ?? [];
  const afterLines = after ?? [];
  let beforeCursor = 0;
  let afterCursor = 0;
  for (const hunk of file.hunks) {
    const first = hunk.lines[0];
    if (first === undefined) return { status: "summary", reason: "diff-invalid" };
    const firstNumber = first.beforeLine ?? first.afterLine;
    const cursor = first.beforeLine === null ? afterCursor : beforeCursor;
    if (firstNumber === null || !Number.isSafeInteger(firstNumber) || firstNumber < 1)
      return { status: "summary", reason: "diff-invalid" };
    const gap = firstNumber - cursor - 1;
    if (gap < 0 || beforeCursor + gap > beforeLines.length || afterCursor + gap > afterLines.length)
      return { status: "summary", reason: "diff-invalid" };
    for (let offset = 0; offset < gap; offset++) {
      if (beforeLines[beforeCursor + offset]!.raw !== afterLines[afterCursor + offset]!.raw)
        return { status: "summary", reason: "diff-invalid" };
    }
    beforeCursor += gap;
    afterCursor += gap;
    for (const line of hunk.lines) {
      if (!(["context", "added", "removed"] as readonly string[]).includes(line.kind))
        return { status: "summary", reason: "diff-invalid" };
      if (
        (line.kind === "context" && (line.beforeLine === null || line.afterLine === null)) ||
        (line.kind === "added" && (line.beforeLine !== null || line.afterLine === null)) ||
        (line.kind === "removed" && (line.beforeLine === null || line.afterLine !== null))
      )
        return { status: "summary", reason: "diff-invalid" };
      for (const side of ["before", "after"] as const) {
        const number = side === "before" ? line.beforeLine : line.afterLine;
        if (number === null) continue;
        const next = side === "before" ? beforeCursor + 1 : afterCursor + 1;
        if (!Number.isSafeInteger(number) || number !== next)
          return { status: "summary", reason: "diff-invalid" };
        const sourceLine = (side === "before" ? beforeLines : afterLines)[number - 1];
        if (sourceLine === undefined || sourceLine.text !== line.text)
          return { status: "summary", reason: "source-digest-mismatch" };
        if (side === "before") beforeCursor++;
        else afterCursor++;
      }
      if (
        line.kind === "context" &&
        beforeLines[beforeCursor - 1]!.raw !== afterLines[afterCursor - 1]!.raw
      )
        return { status: "summary", reason: "diff-invalid" };
    }
  }
  if (beforeLines.length - beforeCursor !== afterLines.length - afterCursor)
    return { status: "summary", reason: "diff-invalid" };
  while (beforeCursor < beforeLines.length) {
    if (beforeLines[beforeCursor]!.raw !== afterLines[afterCursor]!.raw)
      return { status: "summary", reason: "diff-invalid" };
    beforeCursor++;
    afterCursor++;
  }
  return { before, after };
}

/** Validate the full retained file before using any one location from it. */
export function validateReviewDiffFile(file: ReviewDiffFile): ReviewUnresolvedAnchor | null {
  const verified = verifyDiffFile(file);
  return "status" in verified ? verified : null;
}

function resolveReviewAnchorOnSide(
  location: ReviewSourceLocation,
  files: readonly ReviewDiffFile[],
  side: ReviewDiffSide,
): ReviewAnchorResolution {
  const matches = files.filter((file) =>
    side === "after" ? file.newPath === location.path : file.oldPath === location.path,
  );
  if (matches.length === 0) return { status: "summary", reason: "path-not-in-diff" };
  if (matches.length > 1) return { status: "summary", reason: "path-not-in-diff" };
  const file = matches[0]!;
  if (file.state === "absent") return { status: "summary", reason: "diff-absent" };
  if (file.state === "truncated") return { status: "summary", reason: "diff-truncated" };
  const verified = verifyDiffFile(file);
  if ("status" in verified) return verified;

  const after = side === "after";
  const content = after ? verified.after : verified.before;
  const digest = after ? file.afterSha256 : file.beforeSha256;
  const path = after ? file.newPath : file.oldPath;
  if (content === null || digest === null || path === null)
    return {
      status: "summary",
      reason: file.newPath === null ? "deleted-location" : "source-missing",
    };

  const selected = file.hunks
    .flatMap((hunk) => hunk.lines)
    .filter((line) => {
      if (side === "after") return line.afterLine !== null && line.kind !== "removed";
      return line.beforeLine !== null && line.kind !== "added";
    });
  const startLine = location.line;
  const endLine = location.endLine ?? startLine;
  if (startLine !== undefined && (!Number.isSafeInteger(startLine) || startLine < 1))
    return { status: "summary", reason: "invalid-range" };
  if (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < 1))
    return { status: "summary", reason: "invalid-range" };
  if (startLine === undefined && endLine !== undefined)
    return { status: "summary", reason: "invalid-range" };
  if (startLine !== undefined && endLine !== undefined && endLine < startLine)
    return { status: "summary", reason: "invalid-range" };

  let resolvedStart: number;
  let resolvedEnd: number;
  if (startLine !== undefined) {
    resolvedStart = startLine;
    resolvedEnd = endLine ?? startLine;
    const rangeLines = selected
      .filter((line) => {
        const number = side === "after" ? line.afterLine : line.beforeLine;
        return number !== null && number >= resolvedStart && number <= resolvedEnd;
      })
      .sort((left, right) => {
        const leftNumber = side === "after" ? left.afterLine : left.beforeLine;
        const rightNumber = side === "after" ? right.afterLine : right.beforeLine;
        return (leftNumber ?? 0) - (rightNumber ?? 0);
      });
    if (rangeLines.length !== resolvedEnd - resolvedStart + 1)
      return { status: "summary", reason: "location-not-in-diff" };
    for (const [index, diffLine] of rangeLines.entries()) {
      const number = side === "after" ? diffLine.afterLine : diffLine.beforeLine;
      if (number !== resolvedStart + index)
        return { status: "summary", reason: "location-not-in-diff" };
      if (number === null || content[number - 1]?.text !== diffLine.text)
        return { status: "summary", reason: "source-digest-mismatch" };
    }
    if (location.text !== undefined) {
      const first = rangeLines.find(
        (line) => (side === "after" ? line.afterLine : line.beforeLine) === resolvedStart,
      );
      if (first?.text !== location.text)
        return { status: "summary", reason: "location-not-in-diff" };
    }
  } else {
    if (location.text === undefined) return { status: "summary", reason: "invalid-range" };
    const occurrences = selected.filter((line) => line.text === location.text);
    if (occurrences.length > 1) return { status: "summary", reason: "ambiguous-text" };
    const only = occurrences[0];
    if (!only) return { status: "summary", reason: "location-not-in-diff" };
    const number = side === "after" ? only.afterLine : only.beforeLine;
    if (number === null) return { status: "summary", reason: "location-not-in-diff" };
    resolvedStart = number;
    resolvedEnd = number;
    if (content[number - 1]?.text !== only.text)
      return { status: "summary", reason: "source-digest-mismatch" };
  }

  return {
    status: "anchored",
    side,
    path,
    startLine: resolvedStart,
    endLine: resolvedEnd,
    oldPath: file.oldPath,
    newPath: file.newPath,
    sourceSha256: digest,
  };
}

/** Whether this path exists on this side; a line match alone cannot prove locator provenance. */
function possibleSourceSide(
  location: ReviewSourceLocation,
  files: readonly ReviewDiffFile[],
  side: ReviewDiffSide,
): boolean {
  return files.some((file) =>
    side === "after" ? file.newPath === location.path : file.oldPath === location.path,
  );
}

/**
 * Resolve only locations established by the retained diff and its immutable
 * source bytes. An unqualified locator can anchor only when one source side is
 * possible; this function never guesses the after side of a replacement.
 */
export function resolveReviewAnchor(
  location: ReviewSourceLocation,
  files: readonly ReviewDiffFile[],
): ReviewAnchorResolution {
  if (location.side !== undefined) return resolveReviewAnchorOnSide(location, files, location.side);
  for (const file of files) {
    if (file.oldPath !== location.path && file.newPath !== location.path) continue;
    if (file.state === "absent") return { status: "summary", reason: "diff-absent" };
    if (file.state === "truncated") return { status: "summary", reason: "diff-truncated" };
    const verified = verifyDiffFile(file);
    if ("status" in verified) return verified;
  }
  const before = possibleSourceSide(location, files, "before");
  const after = possibleSourceSide(location, files, "after");
  if (before && after) return { status: "summary", reason: "ambiguous-side" };
  if (after) return resolveReviewAnchorOnSide(location, files, "after");
  if (before) return resolveReviewAnchorOnSide(location, files, "before");
  const afterResult = resolveReviewAnchorOnSide(location, files, "after");
  if (afterResult.status === "anchored" || afterResult.reason !== "path-not-in-diff")
    return afterResult;
  return resolveReviewAnchorOnSide(location, files, "before");
}
