#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Assert ci-heavy domain manifests stay aligned with ci-heavy-tests.txt.
 * Invoked from npm run check and from scripts/vitest-ci.mjs before CI tiers run.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const heavyRoot = join(root, "scripts/ci-heavy");

export const isolationDomains = ["delivery", "profile", "docs"];

export function readList(filePath) {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export function allHeavyFiles() {
  return isolationDomains.flatMap((domain) => readList(join(heavyRoot, `${domain}.txt`)));
}

/** Keep scripts/ci-heavy-tests.txt as the union for contract tests / humans. */
export function assertHeavyManifestMatchesDomains() {
  const manifestPath = join(root, "scripts/ci-heavy-tests.txt");
  const manifest = new Set(readList(manifestPath));
  const union = new Set(allHeavyFiles());
  for (const path of union) {
    if (!manifest.has(path)) {
      throw new Error(`${path} is in ci-heavy/*.txt but missing from ci-heavy-tests.txt`);
    }
  }
  for (const path of manifest) {
    if (!union.has(path)) {
      throw new Error(`${path} is in ci-heavy-tests.txt but missing from ci-heavy/*.txt`);
    }
  }
  const listed = readdirSync(heavyRoot)
    .filter((name) => name.endsWith(".txt"))
    .sort();
  const expected = isolationDomains.map((domain) => `${domain}.txt`).sort();
  if (listed.join(",") !== expected.join(",")) {
    throw new Error(`ci-heavy domain files mismatch: ${listed.join(",")} vs ${expected.join(",")}`);
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    assertHeavyManifestMatchesDomains();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
