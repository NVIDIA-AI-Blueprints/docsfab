#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Ratchet: forbid new closed-schema contract dialect islands.
 *
 * New `*authority-internal.ts` files and new local seal/exact/inert bottoms
 * outside `src/contract-kit/` must either use `createContractKit` /
 * `createHostAuthorityFactory` or be added to the allowlist with justification.
 *
 * Allowlist: scripts/contract-dialect-allowlist.json
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcRoot = join(root, "src");
const allowlistPath = join(root, "scripts/contract-dialect-allowlist.json");

const AUTHORITY_SUFFIX = "authority-internal.ts";
const INERT_RE = /\bfunction\s+(assertInert|assertPlainJsonData|assertInertPlainData|inert)\s*\(/u;
const EXACT_OR_SEAL_RE = /\bfunction\s+(exact|seal)\s*[(<]/u;
const USES_KIT_RE =
  /from\s+["'](?:\.\.\/)*contract-kit(?:\/index\.js)?["']|createContractKit|createHostAuthorityFactory/u;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...walk(path));
    else if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

function loadAllowlist() {
  const raw = JSON.parse(readFileSync(allowlistPath, "utf8"));
  if (!raw || typeof raw !== "object") {
    throw new Error("contract-dialect-allowlist.json must be an object");
  }
  const authorityInternal = new Set(raw.authorityInternal ?? []);
  const dialectBottoms = new Set(raw.dialectBottoms ?? []);
  return {
    authorityInternal,
    dialectBottoms,
    notes: raw.notes ?? "",
  };
}

function rel(path) {
  return relative(root, path).split("\\").join("/");
}

const allowlist = loadAllowlist();
const failures = [];
const seenAuthority = new Set();
const seenBottoms = new Set();

for (const path of walk(srcRoot)) {
  const file = rel(path);
  if (file.startsWith("src/contract-kit/")) continue;
  const source = readFileSync(path, "utf8");
  const usesKit = USES_KIT_RE.test(source);

  if (file.endsWith(AUTHORITY_SUFFIX) || file.includes(`/${AUTHORITY_SUFFIX}`)) {
    seenAuthority.add(file);
    if (!allowlist.authorityInternal.has(file)) {
      failures.push(
        `${file}: new authority-internal module is not allowlisted; use createHostAuthorityFactory from contract-kit or justify an allowlist entry.`,
      );
    } else if (
      allowlist.authorityInternal.has(file) &&
      !usesKit &&
      !file.includes("/roadmap/") &&
      !file.includes("/maturity/")
    ) {
      // Migrated host authorities must consume the kit factory.
      failures.push(
        `${file}: allowlisted authority-internal module must import createHostAuthorityFactory from contract-kit.`,
      );
    }
  }

  const hasDialectBottom = INERT_RE.test(source) && EXACT_OR_SEAL_RE.test(source);
  if (hasDialectBottom) {
    seenBottoms.add(file);
    if (usesKit) continue;
    if (!allowlist.dialectBottoms.has(file)) {
      failures.push(
        `${file}: local seal/exact/inert dialect bottom is not allowlisted; migrate onto createContractKit or justify an allowlist entry.`,
      );
    }
  }
}

for (const entry of allowlist.authorityInternal) {
  if (!seenAuthority.has(entry)) {
    failures.push(`allowlist authorityInternal entry missing on disk: ${entry}`);
  }
}
for (const entry of allowlist.dialectBottoms) {
  if (!seenBottoms.has(entry)) {
    failures.push(
      `allowlist dialectBottoms entry no longer matches a dialect island (remove stale entry): ${entry}`,
    );
  }
}

if (failures.length > 0) {
  console.error("Contract dialect island check failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(
    "\nNew contract MRs must use src/contract-kit/ (createContractKit / createHostAuthorityFactory).",
  );
  console.error(`Allowlist: ${relative(root, allowlistPath)}`);
  process.exit(1);
}

console.log(
  `Contract dialect island check passed (${seenAuthority.size} authority-internal, ${
    [...seenBottoms].filter((file) => {
      const source = readFileSync(join(root, file), "utf8");
      return !USES_KIT_RE.test(source);
    }).length
  } baseline dialect bottoms).`,
);
