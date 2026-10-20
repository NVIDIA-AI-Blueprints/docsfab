#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared derived-generation step that build, typecheck, and tests run
 * first.
 *
 * It checks the generating machine products without a lock and without
 * writing, so a current tree costs one check pass and stays untouched. That
 * includes read-only release trees and CI jobs that cannot write. Only on a
 * mismatch does it take one checkout-level lock, re-check under it, and
 * regenerate the stale products and those built from them through the
 * coordinator, whose rollback restores the runtime-relative targets if a step
 * fails.
 *
 * Usage:
 *   node scripts/ensure-derived.mjs
 *   node scripts/ensure-derived.mjs --steps model-output
 *
 * `--steps` limits the run to the named steps and the steps built from them,
 * for a package that reads only some of the products.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { DERIVED_PRODUCT_BY_ID } from "./derived-products.mjs";
import { MACHINE_DERIVED_STEPS, MACHINE_DERIVED_TARGETS, runDerived } from "./generate-derived.mjs";
import { DEPLOY_ROOT_CONFIG_PATH } from "./limits-deploy-root.mjs";

const defaultRuntimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The machine steps that write derived products. The two composition steps
 * only verify, need git, and generate nothing, so they stay in `check:pins`.
 */
export const ENSURE_DERIVED_STEPS = Object.freeze(
  MACHINE_DERIVED_STEPS.filter((step) => Object.hasOwn(DERIVED_PRODUCT_BY_ID, step.id)),
);

/**
 * The repository-relative canonical inputs of the products this step
 * regenerates, as declared paths and recursive directory globs. The
 * source-checkout launcher watches them so an edit to any of them rebuilds
 * through this step.
 */
export const ENSURE_DERIVED_INPUTS = Object.freeze([
  ...new Set(ENSURE_DERIVED_STEPS.flatMap((step) => DERIVED_PRODUCT_BY_ID[step.id].inputs)),
]);

/**
 * The repository paths a run of this hook reads or writes for the named
 * steps: their products' inputs and outputs, plus the hook's own modules. A
 * CI job that runs the hook before its tests lists them in its trigger paths.
 */
export function ensureDerivedCiPathPatterns(stepIds) {
  const paths = new Set();
  for (const step of selectEnsureDerivedSteps(stepIds)) {
    const product = DERIVED_PRODUCT_BY_ID[step.id];
    for (const path of [...product.inputs, ...product.outputs]) paths.add(path);
  }
  for (const module of ENSURE_DERIVED_MODULES) paths.add(module);
  // derived-products.mjs reads the deploy-root config when it loads.
  paths.add(DEPLOY_ROOT_CONFIG_PATH);
  return [...paths];
}

/**
 * The hook's own module closure, static and dynamic imports, as
 * repository-relative paths. A test checks it against an import walk.
 */
export const ENSURE_DERIVED_MODULES = Object.freeze([
  "packages/runtime/scripts/ensure-derived.mjs",
  "packages/runtime/scripts/generate-derived.mjs",
  "packages/runtime/scripts/derived-products.mjs",
  "packages/runtime/src/config/private-content-paths.js",
  "packages/runtime/scripts/limits-deploy-root.mjs",
  "packages/runtime/src/skills/catalog-ids.js",
  "packages/runtime/src/skills/catalog-ids.ts",
  // Imported on demand for the lock-wait bound.
  "packages/runtime/scripts/check-limits.mjs",
  // Imported on demand before source-importing model-composition checks.
  "packages/runtime/scripts/check-model-output.mjs",
  "packages/runtime/scripts/lib/yaml-subset.mjs",
  "packages/runtime/scripts/docs-limits-table.mjs",
  "packages/runtime/scripts/limits-allowlist-shards.mjs",
  "packages/runtime/src/config/limit-resolution.js",
  "packages/runtime/src/execution/response-contract-keys.js",
]);

export const ENSURE_DERIVED_REMEDIATION = "npm --prefix packages/runtime run generate:pins";

/**
 * Steps whose generator lists every file it writes (`--print-mirror-paths`).
 * A product declaration can omit some of those files, so the rewrite line
 * hashes the listed files as well as the declared outputs. The other steps
 * write only inside their declared output directories.
 */
export const ENSURE_DERIVED_LISTING_STEPS = Object.freeze(["limits", "model-output"]);

/** The checkout-level lock, under the package's ignored `.cache/`. */
export const ENSURE_DERIVED_LOCK_PATH = join(".cache", "ensure-derived.lock");

// Execution plumbing, not a bound: how often a waiter re-reads the lock while
// a live holder regenerates. derived.lockWaitMs bounds the wait itself.
export const ENSURE_DERIVED_LOCK_POLL_INTERVAL_MS = 100;

/** The catalogued bound on one wait for another process's generation lock. */
export const ENSURE_DERIVED_LOCK_WAIT_LIMIT = "derived.lockWaitMs";

/** A refusal the hook reports with its code and remediation instead of a stack. */
export class EnsureDerivedRefusal extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "EnsureDerivedRefusal";
    this.code = code;
  }
}

/** The owner record, `null` when the file is absent, or `undefined` when it is unreadable. */
function readLockOwner(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    // Handles exactly a lock released between the failed publish and this read.
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const owner = JSON.parse(text);
    if (Number.isInteger(owner?.pid) && owner.pid > 0 && typeof owner.token === "string") {
      return { pid: owner.pid, token: owner.token };
    }
  } catch {
    // Handles exactly text that is not JSON; the caller refuses it like a malformed record.
  }
  return undefined;
}

function pidIsLive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists under another user.
    return error.code !== "ESRCH";
  }
}

/** Write the complete owner record, then hard-link it into place so no reader sees a partial lock. */
function publishExclusive(path, record) {
  const stagingPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(
      stagingPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    writeSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(stagingPath, path);
      return true;
    } catch (error) {
      // Handles exactly an existing record; every other link failure propagates.
      if (error.code !== "EEXIST") throw error;
      return false;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(stagingPath, { force: true });
  }
}

/**
 * Remove a lock whose holder has stopped. Returns whether it was removed and,
 * when another live process is already reclaiming it, that process's marker.
 * Only the process that wins this holder's reclaim marker removes the lock,
 * and only while the lock still names that holder, so a waiter that read the
 * stopped holder late never removes a newer lock.
 */
export function reclaimStoppedLock(lockPath, holder) {
  const markerPath = `${lockPath}.reclaim-${holder.token}`;
  if (!publishExclusive(markerPath, { pid: process.pid, token: randomUUID() })) {
    const reclaimer = readLockOwner(markerPath);
    if (reclaimer === null) return { reclaimed: false };
    // Handles exactly a reclaimer that stopped mid-reclaim; a live one is waited on.
    if (reclaimer === undefined || !pidIsLive(reclaimer.pid)) {
      throw new EnsureDerivedRefusal(
        "DERIVED_LOCK_ABANDONED",
        `${lockPath} names stopped process ${holder.pid}, and the process reclaiming it also stopped (${markerPath}). Verify that no derived generation is running in this checkout, remove both files, and rerun.`,
      );
    }
    return { reclaimed: false, waitOn: { pid: reclaimer.pid, path: markerPath } };
  }
  try {
    if (readLockOwner(lockPath)?.token !== holder.token) return { reclaimed: false };
    rmSync(lockPath, { force: true });
    return { reclaimed: true };
  } finally {
    rmSync(markerPath, { force: true });
  }
}

function prepareLockDirectory(lockPath) {
  const directory = dirname(lockPath);
  try {
    mkdirSync(directory, { recursive: true });
    accessSync(directory, fsConstants.W_OK);
  } catch (error) {
    // Handles exactly a lock directory this process cannot create or write.
    throw new EnsureDerivedRefusal(
      "DERIVED_LOCK_UNAVAILABLE",
      `derived outputs are stale and the generation lock directory ${directory} is not writable (${error.code ?? error.message}). Regenerate from a writable checkout: ${ENSURE_DERIVED_REMEDIATION}`,
    );
  }
}

/**
 * The lock-wait bound, read from the canonical catalog rather than from a
 * limits mirror this step may itself be regenerating.
 */
export async function loadLockWaitLimit(repositoryRoot) {
  const { loadLimitDefinitions } = await import("./check-limits.mjs");
  const limit = loadLimitDefinitions({ repoRoot: repositoryRoot }).find(
    (definition) => definition.name === ENSURE_DERIVED_LOCK_WAIT_LIMIT,
  );
  if (limit === undefined) {
    throw new EnsureDerivedRefusal(
      "DERIVED_LOCK_WAIT_UNDECLARED",
      `another process holds the derived-generation lock and config/limits does not declare ${ENSURE_DERIVED_LOCK_WAIT_LIMIT}, so the wait would have no bound. Restore it in config/limits/derived.yaml, run npm --prefix packages/runtime run generate:limits, and rerun.`,
    );
  }
  return limit;
}

async function acquireLock(lockPath, { onWait, loadWaitLimit }) {
  prepareLockDirectory(lockPath);
  let waitLimit;
  let waitStarted;
  for (;;) {
    const owner = { pid: process.pid, token: randomUUID() };
    if (publishExclusive(lockPath, owner)) return { path: lockPath, owner };
    const holder = readLockOwner(lockPath);
    if (holder === null) continue;
    if (holder === undefined) {
      throw new EnsureDerivedRefusal(
        "DERIVED_LOCK_UNREADABLE",
        `${lockPath} has no readable owner record. Verify that no derived generation is running in this checkout, remove the file, and rerun.`,
      );
    }
    let waitOn = { pid: holder.pid, path: lockPath };
    if (!pidIsLive(holder.pid)) {
      const reclaim = reclaimStoppedLock(lockPath, holder);
      if (reclaim.reclaimed) continue;
      waitOn = reclaim.waitOn;
    }
    // Handles exactly the first wait on a holder that looks live: a process
    // that reused a stopped holder's pid looks live too, so the bound starts here.
    if (waitOn !== undefined && waitLimit === undefined) {
      waitLimit = await loadWaitLimit();
      waitStarted = performance.now();
      onWait(waitOn, waitLimit);
    }
    const waited = waitStarted === undefined ? 0 : Math.round(performance.now() - waitStarted);
    // Handles exactly a wait past the bound; a holder that releases sooner is acquired above.
    if (waitLimit !== undefined && waited > waitLimit.value) {
      const on = waitOn ?? { pid: holder.pid, path: lockPath };
      throw new EnsureDerivedRefusal(
        waitLimit.refusal,
        `waited ${waited} ${waitLimit.unit} for process ${on.pid}, which holds ${on.path}; ${waited} exceeds ${waitLimit.name} = ${waitLimit.value} ${waitLimit.unit}. ${waitLimit.remediation} Follow the named remediation.`,
      );
    }
    await sleep(ENSURE_DERIVED_LOCK_POLL_INTERVAL_MS);
  }
}

/** Remove the lock only while it still carries this process's token. */
export function releaseLock(lock) {
  if (readLockOwner(lock.path)?.token === lock.owner.token) rmSync(lock.path, { force: true });
}

function filesUnder(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else files.push(path);
  }
  return files;
}

/**
 * The files each step writes, as repository-relative paths and directory
 * globs: its declared outputs plus, for a listing step, its generator's own
 * list. Taken before generation, so a step that cannot list refuses before any
 * write.
 */
function writtenPatterns(steps, runtimeRoot) {
  const patterns = [];
  for (const step of steps) {
    for (const pattern of DERIVED_PRODUCT_BY_ID[step.id].outputs) {
      patterns.push({ step: step.id, pattern });
    }
    if (!ENSURE_DERIVED_LISTING_STEPS.includes(step.id)) continue;
    let listing;
    try {
      listing = execFileSync(
        process.execPath,
        [resolve(runtimeRoot, "scripts", step.script), "--print-mirror-paths"],
        { cwd: runtimeRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      // Handles exactly a listing generator that exits nonzero or cannot start.
      const detail = `${error.stderr ?? ""}`.trim() || error.message;
      throw new EnsureDerivedRefusal(
        "DERIVED_OUTPUTS_UNLISTED",
        `derived outputs are stale and ${step.id} could not list the files it writes (${detail}), so a regeneration could not name every rewritten path. Nothing was regenerated. Fix the cause, then run: ${ENSURE_DERIVED_REMEDIATION}`,
      );
    }
    for (const line of listing.split("\n")) {
      if (line.trim() !== "") patterns.push({ step: step.id, pattern: line.trim() });
    }
  }
  return patterns;
}

/** Hash every file the patterns name, keyed by repository-relative path. */
function outputDigests(patterns, repositoryRoot) {
  const digests = new Map();
  for (const { step, pattern } of patterns) {
    const base = pattern.endsWith("/**/*") ? pattern.slice(0, -"/**/*".length) : pattern;
    const absolute = resolve(repositoryRoot, base);
    const files =
      pattern === base ? (existsSync(absolute) ? [absolute] : []) : filesUnder(absolute);
    for (const file of files) {
      const key = relative(repositoryRoot, file).split(sep).join("/");
      // Handles exactly a file both declared and listed: hashed once.
      if (digests.has(key)) continue;
      const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
      digests.set(key, { step, digest });
    }
  }
  return digests;
}

function rewrittenPaths(before, after) {
  const byStep = new Map();
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const previous = before.get(path);
    const current = after.get(path);
    if (previous?.digest === current?.digest) continue;
    const step = (current ?? previous).step;
    const label =
      current === undefined
        ? `${path} (removed)`
        : previous === undefined
          ? `${path} (added)`
          : path;
    byStep.set(step, [...(byStep.get(step) ?? []), label]);
  }
  return [...byStep].map(([step, paths]) => ({ step, paths: paths.sort() }));
}

/**
 * The steps whose check fails, plus every step built from one of them, in
 * step order. Each step is checked on its own so one stale family does not
 * hide another.
 */
async function staleSteps(steps, executeStep) {
  const stale = new Map();
  for (const step of steps) {
    // Every output, the untracked build-generated mirrors included: a missing
    // one is what this hook exists to regenerate.
    const result = await runDerived({
      checkOnly: true,
      checkOutputs: "all",
      steps: [step],
      executeStep,
    });
    if (result.status !== "passed") stale.set(step.id, result.firstFailure.message);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const step of steps) {
      if (stale.has(step.id)) continue;
      const source = DERIVED_PRODUCT_BY_ID[step.id].dependencies.find((id) => stale.has(id));
      if (source === undefined) continue;
      stale.set(step.id, `built from stale ${source}`);
      grew = true;
    }
  }
  return steps
    .filter((step) => stale.has(step.id))
    .map((step) => ({ step, reason: stale.get(step.id) }));
}

/**
 * Make the generating machine products current: check first without a lock or
 * a write, and only when a check fails regenerate the stale products and the
 * products built from them, under one checkout-level lock.
 *
 * @param {{
 *   runtimeRoot?: string,
 *   steps?: readonly object[],
 *   executeStep?: (step: object, checkOnly: boolean, checkOutputs?: string) => Promise<object> | object,
 *   lockPath?: string,
 *   log?: (line: string) => void,
 * }} [options]
 */
export async function ensureDerived(options = {}) {
  const runtimeRoot = options.runtimeRoot ?? defaultRuntimeRoot;
  const repositoryRoot = resolve(runtimeRoot, "..", "..");
  const steps = options.steps ?? ENSURE_DERIVED_STEPS;
  const executeStep = options.executeStep;
  const lockPath = options.lockPath ?? join(runtimeRoot, ENSURE_DERIVED_LOCK_PATH);
  const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));

  const initiallyStale = await staleSteps(steps, executeStep);
  if (initiallyStale.length === 0) return { status: "current" };

  const lock = await acquireLock(lockPath, {
    onWait: ({ pid, path }, limit) =>
      log(
        `ensure-derived: waiting for process ${pid}, which holds ${path} while it regenerates derived outputs. Waiting at most ${limit.name} = ${limit.value} ${limit.unit}.`,
      ),
    loadWaitLimit: () => loadLockWaitLimit(repositoryRoot),
  });
  try {
    // Another process may have regenerated while this one waited.
    const stale = (await staleSteps(steps, executeStep)).map(({ step }) => step);
    if (stale.length === 0) return { status: "current" };
    const written = writtenPatterns(stale, runtimeRoot);
    const before = outputDigests(written, repositoryRoot);
    const generation = await runDerived({
      steps: stale,
      targets: MACHINE_DERIVED_TARGETS,
      targetRoot: runtimeRoot,
      executeStep,
    });
    if (generation.status !== "passed") {
      const { id, message } = generation.firstFailure;
      throw new EnsureDerivedRefusal(
        "DERIVED_GENERATION_FAILED",
        `derived outputs are stale and regenerating them failed at ${id}: ${message}. Runtime-relative outputs (${MACHINE_DERIVED_TARGETS.join(", ")}) were restored; repository-level outputs an earlier step wrote are not rolled back. Fix the cause, then run: ${ENSURE_DERIVED_REMEDIATION}`,
      );
    }
    const unsettled = await staleSteps(steps, executeStep);
    if (unsettled.length > 0) {
      const [{ step, reason }] = unsettled;
      throw new EnsureDerivedRefusal(
        "DERIVED_GENERATION_NOT_CURRENT",
        `regeneration finished but ${step.id} still fails its check: ${reason}. A generator that does not reproduce its own output would rewrite files on every run. Fix the cause, then run: ${ENSURE_DERIVED_REMEDIATION}`,
      );
    }
    const rewritten = rewrittenPaths(before, outputDigests(written, repositoryRoot));
    log(
      `ensure-derived: regenerated stale derived outputs: ${
        rewritten.length === 0
          ? "no output bytes changed"
          : rewritten.map(({ step, paths }) => `${step}: ${paths.join(", ")}`).join("; ")
      }`,
    );
    return { status: "regenerated", steps: stale.map((step) => step.id), rewritten };
  } finally {
    releaseLock(lock);
  }
}

/**
 * The named hook steps and every hook step built from one of them, in step
 * order. An unknown name refuses rather than checking less than was asked.
 */
export function selectEnsureDerivedSteps(ids, steps = ENSURE_DERIVED_STEPS) {
  const known = new Set(steps.map((step) => step.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new EnsureDerivedRefusal(
      "DERIVED_STEP_UNKNOWN",
      `--steps names ${unknown.join(", ")}, which is not a step of this hook. The steps are ${[...known].join(", ")}.`,
    );
  }
  const selected = new Set(ids);
  for (let grew = true; grew; ) {
    grew = false;
    for (const step of steps) {
      if (selected.has(step.id)) continue;
      if (!DERIVED_PRODUCT_BY_ID[step.id].dependencies.some((id) => selected.has(id))) continue;
      selected.add(step.id);
      grew = true;
    }
  }
  return steps.filter((step) => selected.has(step.id));
}

/** The hook's command-line options: none, or `--steps <id>[,<id>...]`. */
export function parseEnsureDerivedArgs(argv) {
  if (argv.length === 0) return {};
  const [flag, value, ...rest] = argv;
  const ids = (value ?? "").split(",").filter((id) => id !== "");
  if (flag !== "--steps" || ids.length === 0 || rest.length > 0) {
    throw new EnsureDerivedRefusal(
      "DERIVED_ARGUMENTS_INVALID",
      `expected no arguments or --steps <id>[,<id>...], got: ${argv.join(" ")}.`,
    );
  }
  return { steps: selectEnsureDerivedSteps(ids) };
}

async function main() {
  try {
    await ensureDerived(parseEnsureDerivedArgs(process.argv.slice(2)));
  } catch (error) {
    // Handles exactly the hook's own refusals; any other error keeps its stack.
    if (!(error instanceof EnsureDerivedRefusal)) throw error;
    process.stderr.write(`ensure-derived: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await main();
}
