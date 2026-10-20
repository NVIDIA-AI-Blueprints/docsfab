// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parse } from "@babel/parser";

interface SourceQuotation {
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly value: string | null;
}

/** Syntax alone does not make compiler, legal or security metadata documentary. */
function ordinaryComment(value: string): boolean {
  const text = value.replace(/^[\t ]*\*[\t ]?/gmu, "").trim();
  return (
    /^\p{L}/u.test(text) &&
    !/^[\t ]*[@#!/]/mu.test(text) &&
    !/^[\t ]*(?:[\p{L}_][\p{L}\p{N}_.-]*:[\p{L}\p{N}_.-]+\b|(?:noinspection|nolint|noqa|region|endregion)\b)/imu.test(
      text,
    ) &&
    !/\b(?:spdx|copyright|licen[cs](?:e[ds]?|ing)|confidential|legal|warranty|patents?|trademarks?|rights|proprietary|liabilit(?:y|ies)|security|vulnerabilit\w*|authentication|authorization|credentials?|secrets?|permissions?|eslint|tslint|prettier|istanbul|jshint|jslint|jscs|globals?|generated|sourceMappingURL|sourceURL|(?:webpack|vite|rollup|babel|swc|esbuild|deno|biome|oxlint)\w*)\b/iu.test(
      text,
    ) &&
    !/\b(?:c8|v8)\s+ignore\b|@(?:ts-|__PURE__)|<\s*(?:reference|amd-module|amd-dependency)\b/iu.test(
      text,
    ) &&
    !/^(?:export\s+(?:default|function|const|let|var|class|type|interface|\{)|import\s|(?:return|throw|const|let|var|function|class|interface|declare|readonly)\b)/u.test(
      text,
    )
  );
}

/**
 * Read quote roles from one complete normalized, already verified source snapshot.
 * A failed parse or an ambiguous quote preserves the caller's existing source role.
 */
export function sourceCommentQuotationReader(
  path: string,
  source: string,
): (side: SourceQuotation) => boolean {
  if (!/\.[cm]?[jt]sx?$/iu.test(path)) return () => false;
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(source, { sourceType: "unambiguous", plugins: ["typescript", "jsx"] });
  } catch {
    return () => false;
  }
  const comments = (parsed.comments ?? []).filter(
    (comment) =>
      (comment.type === "CommentLine" || comment.type === "CommentBlock") &&
      typeof comment.start === "number" &&
      typeof comment.end === "number" &&
      /^(?:\/\/|\/\*)/u.test(source.slice(comment.start, comment.end)) &&
      ordinaryComment(comment.value),
  );
  const lineStarts = [0];
  for (let offset = 0; offset < source.length; offset += 1)
    if (source[offset] === "\n") lineStarts.push(offset + 1);
  return ({ lineStart, lineEnd, value }) => {
    if (
      value === null ||
      value.trim().length === 0 ||
      !Number.isSafeInteger(lineStart) ||
      !Number.isSafeInteger(lineEnd) ||
      lineStart < 1 ||
      lineEnd < lineStart ||
      lineEnd > lineStarts.length
    )
      return false;
    const start = lineStarts[lineStart - 1]!;
    const end = lineEnd < lineStarts.length ? lineStarts[lineEnd]! - 1 : source.length;
    const found = source.indexOf(value, start);
    if (found < 0 || found + value.length > end) return false;
    const repeated = source.indexOf(value, found + 1);
    if (repeated >= 0 && repeated + value.length <= end) return false;
    let covered = found;
    const quoteEnd = found + value.length;
    for (const comment of comments) {
      if (comment.end! <= covered || comment.start! >= quoteEnd) continue;
      if (/\S/u.test(source.slice(covered, comment.start!))) return false;
      covered = Math.max(covered, comment.end!);
      if (covered >= quoteEnd) return true;
    }
    return !/\S/u.test(source.slice(covered, quoteEnd));
  };
}
