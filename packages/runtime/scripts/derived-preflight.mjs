#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Read-only, affected-output preflight for derived runtime products.
 *
 * Usage:
 *   node scripts/derived-preflight.mjs
 *   node scripts/derived-preflight.mjs --paths packages/quality/checks/example.py
 *   node scripts/derived-preflight.mjs --paths path/one path/two
 *
 * With no explicit paths, CI diff variables are used when available. An
 * unavailable or shallow diff base deliberately falls back to checking every
 * product. This command never invokes a generator without --check.
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  DERIVED_PRODUCTS,
  DERIVED_PRODUCT_BY_ID,
  productRepairCommands,
} from "./derived-products.mjs";
import { committedOnlySkips, stepArguments } from "./generate-derived.mjs";

const execute = promisify(execFile);
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(runtimeRoot, "../..");
const SHA_PATTERN = /^[0-9a-f]{7,64}$/iu;

function usageError(message) {
  throw new Error(
    `${message}\nUsage: node scripts/derived-preflight.mjs [--paths <path...>] [--base <sha>]`,
  );
}

function normalizePath(path) {
  const normalized = path.replace(/^(?:\.\/)+/u, "");
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    usageError(`Invalid repository-relative path: ${path}`);
  }
  return normalized;
}

function addPaths(options, paths) {
  options.paths = [...new Set([...(options.paths ?? []), ...paths.map(normalizePath)])];
}

export function parseArgs(argv) {
  const options = { paths: null, base: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--paths") {
      const paths = [];
      while (index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
        paths.push(...argv[++index].split(",").filter(Boolean));
      }
      if (paths.length === 0) usageError("--paths requires at least one path");
      addPaths(options, paths);
      continue;
    }
    if (argument.startsWith("--paths=")) {
      const paths = argument.slice("--paths=".length).split(",").filter(Boolean);
      if (paths.length === 0) usageError("--paths requires at least one path");
      addPaths(options, paths);
      continue;
    }
    if (argument === "--base") {
      const base = argv[++index];
      if (!base || base.startsWith("--")) usageError("--base requires a commit SHA");
      options.base = base;
      continue;
    }
    if (argument.startsWith("--base=")) {
      options.base = argument.slice("--base=".length);
      if (!options.base) usageError("--base requires a commit SHA");
      continue;
    }
    usageError(`Unknown argument: ${argument}`);
  }
  return options;
}

function pathMatches(path, pattern) {
  if (pattern.endsWith("/**/*")) return path.startsWith(pattern.slice(0, -4));
  return path === pattern;
}

export function affectedProductIds(paths) {
  if (paths.length === 0) return [];
  const selected = new Set();
  for (const product of DERIVED_PRODUCTS) {
    if (
      paths.some((path) =>
        [...product.inputs, ...product.outputs].some((pattern) => pathMatches(path, pattern)),
      )
    ) {
      selected.add(product.id);
    }
  }
  // Unrelated product changes do not need to revalidate derived payloads. The
  // CI renderer separately makes sure changes to this graph remain visible to
  // the package jobs.
  if (selected.size === 0) return [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const product of DERIVED_PRODUCTS) {
      const prerequisite = product.dependencies.some((dependency) => selected.has(dependency));
      const dependent = [...selected].some((id) =>
        DERIVED_PRODUCT_BY_ID[id].dependencies.includes(product.id),
      );
      if ((prerequisite || dependent) && !selected.has(product.id)) {
        selected.add(product.id);
        changed = true;
      }
    }
  }
  return DERIVED_PRODUCTS.filter((product) => selected.has(product.id)).map(
    (product) => product.id,
  );
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function gitChangedPaths(base, root = repositoryRoot) {
  if (!base || /^0+$/u.test(base) || !SHA_PATTERN.test(base)) return null;
  try {
    const { stdout } = await execute(
      "git",
      ["diff", "--no-renames", "--name-only", "-z", "--diff-filter=ACDMRTUXB", base, "HEAD"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return stdout.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

async function changedPaths(options, root = repositoryRoot) {
  if (options.paths) return { paths: options.paths, source: "explicit" };
  const base =
    options.base ?? process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA ?? process.env.CI_COMMIT_BEFORE_SHA;
  if (!base) return { paths: null, source: "all (no diff base)" };
  const paths = await gitChangedPaths(base, root);
  return paths
    ? { paths, source: `git diff ${base}..HEAD` }
    : { paths: null, source: "all (diff base unavailable)" };
}

async function checkProduct(product, root = { runtime: runtimeRoot }) {
  const script = resolve(root.runtime, "scripts", product.script);
  if (!(await pathExists(script))) {
    throw new Error(`derived product ${product.id} generator is missing: ${product.script}`);
  }
  try {
    // The checkout's committed outputs: this runs before any install or
    // generation, so a build-generated mirror is absent here by design.
    const { stdout } = await execute(
      process.execPath,
      [script, ...stepArguments(product, true, "committed")],
      {
        cwd: root.runtime,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return committedOnlySkips(stdout);
  } catch (error) {
    const detail = (
      [error?.stderr, error?.stdout, error?.message].find(
        (value) => typeof value === "string" && value.trim(),
      ) ?? "unknown generator failure"
    )
      .replaceAll(/\s+/gu, " ")
      .trim();
    const repair = productRepairCommands(product.id).join(" then ");
    throw new Error(`derived product ${product.id} is stale: ${detail}. Repair with ${repair}.`);
  }
}

export async function runPreflight(options = {}) {
  const roots = {
    repository: options.repositoryRoot ?? repositoryRoot,
    runtime: options.runtimeRoot ?? runtimeRoot,
  };
  const resolved = await changedPaths(options, roots.repository);
  const ids =
    resolved.paths === null
      ? DERIVED_PRODUCTS.map((product) => product.id)
      : affectedProductIds(resolved.paths);
  const report = {
    schemaVersion: 1,
    kind: "docsfab-derived-product-preflight",
    source: resolved.source,
    paths: resolved.paths,
    products: ids,
    status: "passed",
    firstFailure: null,
    skipped: [],
  };
  for (const id of ids) {
    const product = DERIVED_PRODUCT_BY_ID[id];
    try {
      report.skipped.push(...(await checkProduct(product, roots)));
    } catch (error) {
      report.status = "failed";
      report.firstFailure = { id, message: error.message };
      return report;
    }
  }
  return report;
}

async function main() {
  try {
    const report = await runPreflight(parseArgs(process.argv.slice(2)));
    if (report.status === "passed") {
      console.log(
        report.products.length === 0
          ? `Derived-product preflight passed: no affected products (${report.source})`
          : `Derived-product preflight passed: ${report.products.join(", ")} (${report.source})`,
      );
      for (const line of report.skipped) console.log(`  ${line}`);
    }
    if (report.firstFailure) {
      console.error(
        `Derived-product preflight failed at ${report.firstFailure.id}: ${report.firstFailure.message}`,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`Derived-product preflight argument/error: ${error.message}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
