// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A temporary copy of a checkout that the shared derived-generation step and
 * the package build can run in.
 */
import { existsSync } from "node:fs";
import { cp, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  QUALITY_RUNTIME_POLICY_ROOT,
  QUALITY_SOURCE_ROOTS,
} from "../../scripts/derived-products.mjs";
import type { TemporaryRoots } from "./temp.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = resolve(runtimeRoot, "../..");

const DERIVED_CHECKOUT_RUNTIME_COPIES = [
  ".gitignore",
  "README.md",
  "SECURITY.md",
  "bin",
  "docs",
  "governed-assets",
  "model-compositions",
  "npm-shrinkwrap.json",
  "package.json",
  "quality",
  "quality-pack",
  "scripts",
  "skill-crate",
  "src",
  "test/fixtures/model-output",
  "test/review-delivery-plan.test.ts",
  "test/helpers",
  "tsconfig.json",
  "tsconfig.test.json",
  "tsconfig.review-delivery-plan.test.json",
  "vitest.config.ts",
  "workflows",
];

const DERIVED_CHECKOUT_REPOSITORY_COPIES = [
  "LICENSE",
  "LICENSE-CC-BY-4.0",
  "NOTICE",
  "config",
  "docs/reference/status-and-configuration/operational-limits-tables",
  "packages/knowledge/skills",
  "packages/knowledge/src",
  "packages/skills",
  ...QUALITY_SOURCE_ROOTS.map((root: string) => `packages/quality/${root}`),
  `packages/quality/${QUALITY_RUNTIME_POLICY_ROOT}`,
];

/** A copy of the canonical inputs, generator scripts, and committed outputs, with no git, CI, or deploy tree. */
export async function copiedDerivedCheckout(
  roots: TemporaryRoots,
  prefix = "docsfab-ensure-derived-",
): Promise<string> {
  const root = await roots.create(prefix, { realpath: true });
  const copies = [
    ...DERIVED_CHECKOUT_REPOSITORY_COPIES,
    ...DERIVED_CHECKOUT_RUNTIME_COPIES.map((path) => `packages/runtime/${path}`),
  ].map(async (path) => {
    const source = resolve(repositoryRoot, path);
    // The public export omits some repository files; the copy mirrors whichever tree runs it.
    if (existsSync(source)) await cp(source, join(root, path), { recursive: true });
  });
  // Every root has a distinct destination. Wait for all copies even if one fails,
  // so test cleanup cannot race a copy still writing into the temporary tree.
  const results = await Promise.allSettled(copies);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  await symlink(
    join(runtimeRoot, "node_modules"),
    join(root, "packages/runtime/node_modules"),
    "dir",
  );
  return root;
}
