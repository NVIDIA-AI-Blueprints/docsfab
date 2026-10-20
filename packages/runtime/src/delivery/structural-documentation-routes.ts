// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  FernStructuralParseError,
  fernHasVersionIndex,
  fernNavigationTargets,
  fernRoutePrefixes,
  fernVersionNavigationPaths,
} from "../repository/fern-navigation.js";

export {
  FernStructuralParseError,
  fernHasVersionIndex,
  fernNavigationTargets,
  fernRoutePrefixes,
  fernVersionNavigationPaths,
} from "../repository/fern-navigation.js";
export {
  fernCanonicalTargets,
  fernRouteAliases,
} from "../repository/documentation-source-support.js";

export type FernProjectionMapping = Readonly<{
  fernPatterns: readonly string[];
  canonicalPatterns: readonly string[];
}>;

/** Parse explicit Fern-to-canonical area ownership from fern/SOURCE_MAP.md. */
export function fernProjectionMappings(source: string): readonly FernProjectionMapping[] {
  const lines = source.split(/\r?\n/u);
  const headerIndex = lines.findIndex(
    (line) =>
      line.includes("| Fern area |") &&
      line.includes("Current Fern files") &&
      line.includes("Canonical sources"),
  );
  if (headerIndex < 0 || !/^\s*\|(?:\s*:?-+:?\s*\|){3,}/u.test(lines[headerIndex + 1] ?? ""))
    throw new FernStructuralParseError("Fern source map is missing its supported ownership table.");
  const mappings: FernProjectionMapping[] = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!/^\s*\|/u.test(line)) break;
    const cells = line.split("|").slice(1, -1);
    if (cells.length !== 5)
      throw new FernStructuralParseError("Fern source map contains a malformed ownership row.");
    const fernPatterns = codePaths(cells[1] ?? "", "fern");
    const canonicalPatterns = codePaths(cells[2] ?? "", "canonical");
    if (fernPatterns.length === 0 || canonicalPatterns.length === 0)
      throw new FernStructuralParseError("Fern source map ownership rows require both path sets.");
    mappings.push({ fernPatterns, canonicalPatterns });
  }
  if (mappings.length === 0)
    throw new FernStructuralParseError("Fern source map must contain at least one ownership row.");
  return mappings;
}

export function matchesFernProjectionPattern(path: string, pattern: string): boolean {
  const pathParts = path.split("/");
  const patternParts = pattern.split("/");
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index];
    if (expected === "**") return index === patternParts.length - 1;
    const actual = pathParts[index];
    if (
      actual === undefined ||
      (expected !== "*" &&
        (!expected?.startsWith("*.") || !actual.endsWith(expected.slice(1))) &&
        actual !== expected)
    )
      return false;
  }
  return pathParts.length === patternParts.length;
}

function codePaths(cell: string, kind: "fern" | "canonical"): string[] {
  const delimiterCount = [...cell].filter((character) => character === "`").length;
  if (delimiterCount === 0 || delimiterCount % 2 !== 0)
    throw new FernStructuralParseError(
      "Fern source map contains malformed or unbalanced path ownership delimiters.",
    );
  const result: string[] = [];
  for (const match of cell.matchAll(/`([^`]+)`/gu)) {
    const raw = match[1];
    if (!raw) continue;
    const path = kind === "fern" ? `fern/${raw}` : raw;
    assertSourceMapPattern(path);
    result.push(path);
  }
  return [...new Set(result)];
}

function assertSourceMapPattern(path: string): void {
  const segments = path.split("/");
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    segments.some(
      (part, index) =>
        part === "" ||
        part === "." ||
        part === ".." ||
        (part.includes("*") &&
          part !== "*" &&
          part !== "**" &&
          !/^\*\.[A-Za-z0-9]+$/u.test(part)) ||
        (part === "**" && index !== segments.length - 1),
    )
  )
    throw new FernStructuralParseError("Fern source map contains an unsafe or unsupported path.");
}
