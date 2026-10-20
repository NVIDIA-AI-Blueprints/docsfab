#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Fail when Vitest test cases lack titles or reuse the same title in one file.
 * Invoked from npm run check.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const testRoot = join(root, "test");

const testCallPattern = /(?<![.\w])(it|test)(\.(only|skip|todo|concurrent|fails|each))?\s*\(/gu;

function walkTestFiles(dir) {
  const paths = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      paths.push(...walkTestFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      paths.push(fullPath);
    }
  }
  return paths;
}

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}

function skipWhitespace(source, index) {
  while (index < source.length && /\s/u.test(source[index])) {
    index += 1;
  }
  return index;
}

function readStringLiteral(source, index) {
  index = skipWhitespace(source, index);
  const quote = source[index];
  if (quote !== "'" && quote !== '"') {
    return null;
  }

  index += 1;
  let value = "";
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      value += char;
      index += 1;
      if (index < source.length) {
        value += source[index];
        index += 1;
      }
      continue;
    }
    if (char === quote) {
      return { value, end: index + 1 };
    }
    value += char;
    index += 1;
  }
  return null;
}

function skipTemplateLiteral(source, index) {
  index += 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === "`") {
      return index + 1;
    }
    index += 1;
  }
  return source.length;
}

function skipStringLiteral(source, index) {
  const quote = source[index];
  index += 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === quote) {
      return index + 1;
    }
    index += 1;
  }
  return source.length;
}

function skipBalanced(source, openIndex) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const open = source[openIndex];
  const close = pairs[open];
  if (!close) {
    return openIndex + 1;
  }

  let depth = 0;
  let index = openIndex;
  while (index < source.length) {
    const char = source[index];
    if (char === "'" || char === '"') {
      index = skipStringLiteral(source, index);
      continue;
    }
    if (char === "`") {
      index = skipTemplateLiteral(source, index);
      continue;
    }
    if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    } else if (depth > 0 && pairs[char]) {
      index = skipBalanced(source, index);
      continue;
    }
    index += 1;
  }
  return source.length;
}

export function scanTestTitles(source) {
  const titles = [];
  const violations = [];

  for (const match of source.matchAll(testCallPattern)) {
    const modifier = match[3];
    const callLine = lineNumber(source, match.index);
    let index = match.index + match[0].length;

    if (modifier === "each") {
      index = skipBalanced(source, index - 1);
      index = skipWhitespace(source, index);
      if (source[index] !== "(") {
        violations.push({
          line: callLine,
          kind: "missing",
          detail: "it.each/test.each is missing a title template",
        });
        continue;
      }
      index += 1;
    }

    const literal = readStringLiteral(source, index);
    if (!literal) {
      violations.push({
        line: callLine,
        kind: "missing",
        detail: "test case has no string title",
      });
      continue;
    }
    if (literal.value.trim().length === 0) {
      violations.push({
        line: callLine,
        kind: "missing",
        detail: "test case title is empty",
      });
      continue;
    }
    titles.push({ title: literal.value, line: callLine });
  }

  const seen = new Map();
  for (const { title, line } of titles) {
    const prior = seen.get(title);
    if (prior !== undefined) {
      violations.push({
        line,
        kind: "duplicate",
        detail: `duplicate title "${title}" (first at line ${prior})`,
      });
    } else {
      seen.set(title, line);
    }
  }

  return violations;
}

export function collectTestTitleViolations(files = walkTestFiles(testRoot)) {
  const violations = [];
  for (const filePath of files) {
    const source = readFileSync(filePath, "utf8");
    const relativePath = filePath.slice(root.length + 1);
    for (const violation of scanTestTitles(source)) {
      violations.push({ file: relativePath, ...violation });
    }
  }
  return violations;
}

export function assertTestTitlesHygiene() {
  const violations = collectTestTitleViolations();
  if (violations.length === 0) {
    return;
  }

  const lines = violations.map((v) => `${v.file}:${v.line}: ${v.kind} — ${v.detail}`);
  throw new Error(`test title hygiene failed:\n${lines.join("\n")}`);
}

const isMain = process.argv[1] === import.meta.filename;
if (isMain) {
  try {
    assertTestTitlesHygiene();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
