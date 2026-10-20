#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Classify a change-set as docs-only (CI fast path) or full verify graph.
 *
 * Fast path applies only when *every* path is docs-shaped.
 * Any denylist / unknown / empty set is fail-closed: full.
 *
 * Usage:
 *   node scripts/classify-ci-changes.mjs --self-test
 *   node scripts/classify-ci-changes.mjs path [path ...]
 *   git diff --name-only origin/main...HEAD | node scripts/classify-ci-changes.mjs --stdin
 *
 * Prints `docs-only` or `full` on stdout (except `--self-test`, which prints a summary).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DOCS_ONLY = "docs-only";
export const FULL = "full";

function normalizePath(input) {
  return String(input).trim().replaceAll("\\", "/").replace(/^\.\//u, "");
}

export function isDocsShaped(path) {
  const normalized = normalizePath(path);
  if (!normalized || normalized.includes("\0")) {
    return false;
  }
  if (normalized === "docs" || normalized.startsWith("docs/")) {
    return true;
  }
  if (!normalized.includes("/") && normalized.endsWith(".md")) {
    return true;
  }
  if (
    normalized === ".gitlab/issue_templates" ||
    normalized.startsWith(".gitlab/issue_templates/")
  ) {
    return true;
  }
  if (
    normalized === ".gitlab/merge_request_templates" ||
    normalized.startsWith(".gitlab/merge_request_templates/")
  ) {
    return true;
  }
  return false;
}

export function classifyCiChanges(paths) {
  const normalized = paths.map(normalizePath).filter(Boolean);
  if (normalized.length === 0) {
    return FULL;
  }
  return normalized.every(isDocsShaped) ? DOCS_ONLY : FULL;
}

/** Fixtures proving both CI paths. */
export const CLASSIFY_FIXTURES = [
  {
    name: "docs tree only → fast",
    paths: ["docs/index.md", "docs/plan/issue-lifecycle.md"],
    expect: DOCS_ONLY,
  },
  {
    name: "repo-root markdown → fast",
    paths: ["README.md", "CONTRIBUTING.md", "AGENTS.md"],
    expect: DOCS_ONLY,
  },
  {
    name: "issue templates → fast",
    paths: [".gitlab/issue_templates/Task.md"],
    expect: DOCS_ONLY,
  },
  {
    name: "MR templates → fast",
    paths: [".gitlab/merge_request_templates/Default.md"],
    expect: DOCS_ONLY,
  },
  {
    name: "mixed docs + src → full",
    paths: ["docs/index.md", "src/cli.ts"],
    expect: FULL,
  },
  {
    name: "package.json → full",
    paths: ["package.json"],
    expect: FULL,
  },
  {
    name: "scripts → full",
    paths: ["scripts/classify-ci-changes.mjs"],
    expect: FULL,
  },
  {
    name: ".gitlab-ci.yml → full",
    paths: [".gitlab-ci.yml"],
    expect: FULL,
  },
  {
    name: "unknown root file → full",
    paths: ["LICENSE"],
    expect: FULL,
  },
  {
    name: "empty change set → full",
    paths: [],
    expect: FULL,
  },
  {
    name: "security tree → full",
    paths: ["security/README.md"],
    expect: FULL,
  },
  {
    name: "nested markdown outside docs → full",
    paths: ["src/README.md"],
    expect: FULL,
  },
];

export function runSelfTest() {
  const failures = [];
  for (const fixture of CLASSIFY_FIXTURES) {
    const actual = classifyCiChanges(fixture.paths);
    if (actual !== fixture.expect) {
      failures.push(`${fixture.name}: expected ${fixture.expect}, got ${actual}`);
    }
  }
  return failures;
}

function readStdinPaths() {
  const text = readFileSync(0, "utf8");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function main(argv) {
  if (argv.includes("--self-test")) {
    const failures = runSelfTest();
    if (failures.length > 0) {
      console.error("classify-ci-changes self-test failed:");
      for (const failure of failures) {
        console.error(`  ${failure}`);
      }
      process.exit(1);
    }
    console.log(`classify-ci-changes: ${CLASSIFY_FIXTURES.length} fixtures passed`);
    return;
  }

  const paths = argv.includes("--stdin")
    ? readStdinPaths()
    : argv.filter((arg) => !arg.startsWith("--"));
  console.log(classifyCiChanges(paths));
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2));
}
