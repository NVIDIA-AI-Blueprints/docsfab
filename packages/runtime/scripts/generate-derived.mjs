#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generate (or verify) all runtime-derived products in dependency order.
 *
 * The individual generators remain the source of truth for each product. This
 * coordinator gives CI and maintainers one entry point, makes the dependency
 * order explicit, and rolls generated trees back when a later stage fails.
 * Reports are deliberately small and credential-free so they can be uploaded
 * as CI diagnostics without exposing command output or environment state.
 *
 * Usage:
 *   node scripts/generate-derived.mjs
 *   node scripts/generate-derived.mjs --machine
 *   node scripts/generate-derived.mjs --check
 *   node scripts/generate-derived.mjs --report-json /tmp/derived.json --report-junit /tmp/derived.xml
 */
import { execFileSync } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PRIVATE_CONTENT_PATHS } from "../src/config/private-content-paths.js";
import { DERIVED_PRODUCTS } from "./derived-products.mjs";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptRoot = resolve(runtimeRoot, "scripts");

/**
 * Stages are ordered by their actual package edges:
 * canonical skills -> skill crate -> quality pack, then the optional campaign
 * kit, then composition pin.
 *
 * The campaign kit is not a machine pin. Skill and quality factory MRs repair
 * crate and quality-pack only; relocatable kit export is `check:kit`.
 */
export const DERIVED_STEPS = Object.freeze([
  ...DERIVED_PRODUCTS.map((product) =>
    Object.freeze({
      id: product.id,
      label: product.label,
      script: product.script,
      ...(product.committedCheckArguments === undefined
        ? {}
        : { committedCheckArguments: product.committedCheckArguments }),
    }),
  ),
  Object.freeze({
    id: "model-compositions",
    label: "Installed model-composition policy",
    script: "check-model-compositions.mjs",
    nodeArguments: ["--import", "tsx"],
    checkArgument: false,
    // It imports runtime source, which reads build-generated limits and model-output mirrors.
    importsRuntimeSource: true,
  }),
  Object.freeze({
    id: "composition-digests",
    label: "Model-composition digest chain",
    script: "verify-composition-digests.mts",
    nodeArguments: ["--import", "tsx"],
    checkArgument: false,
  }),
]);

function derivedStep(id) {
  const step = DERIVED_STEPS.find((entry) => entry.id === id);
  if (!step) throw new Error(`Unknown derived-state step: ${id}`);
  return step;
}

/**
 * `--machine` (`npm run check:pins`) omits `model-comparison-kit` on purpose:
 * `npm run check:kit` and path-gated `runtime:kit` cover the heavier kit, so
 * `check:derived` can fail on a stale kit while `check:pins` passes. Folding
 * the kit in means changing that CI split and the tests that encode it.
 */
export const MACHINE_DERIVED_STEPS = Object.freeze([
  derivedStep("skill-crate"),
  derivedStep("quality-pack"),
  derivedStep("limits"),
  derivedStep("env-admission"),
  derivedStep("model-output"),
  derivedStep("model-compositions"),
  derivedStep("composition-digests"),
]);

// The generators write directly to these roots; copying them first lets a
// later failure restore the last known-good state. This list is only the
// coordinator's rollback boundary.
export const MACHINE_DERIVED_TARGETS = Object.freeze([
  "skill-crate",
  "quality",
  "quality-pack",
  "governed-assets/lock.json",
  "src/config/limits.generated.ts",
  "src/config/env-admission.generated.ts",
  "scripts/offline-test-env.generated.mjs",
  "src/contracts/model-output.generated.ts",
  "src/execution/response-contract-vocabulary.generated.json",
  "docs/reference/contracts/model-output-rules.md",
]);

export const DERIVED_TARGETS = Object.freeze([
  ...MACHINE_DERIVED_TARGETS,
  ...(PRIVATE_CONTENT_PATHS.modelComparisonInstalled
    ? [`${PRIVATE_CONTENT_PATHS.modelComparisonInstalled}/routing-task-guide-v1`]
    : []),
]);

const MAX_FAILURE_MESSAGE_LENGTH = 500;

export function parseArgs(argv) {
  const options = { checkOnly: false, scope: "full", reportJson: null, reportJunit: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      options.checkOnly = true;
      continue;
    }
    if (argument === "--machine") {
      options.scope = "machine";
      continue;
    }
    if (argument.startsWith("--report-json=") || argument.startsWith("--report-junit=")) {
      const [flag, path] = argument.split("=", 2);
      if (!path) throw new Error(`${flag} requires a destination path`);
      options[flag === "--report-json" ? "reportJson" : "reportJunit"] = resolve(path);
      continue;
    }
    if (argument === "--report-json" || argument === "--report-junit") {
      const path = argv[++index];
      if (!path || path.startsWith("--")) {
        throw new Error(`${argument} requires a destination path`);
      }
      options[argument === "--report-json" ? "reportJson" : "reportJunit"] = resolve(path);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function boundedFailureMessage(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr : "";
  const stdout = typeof error?.stdout === "string" ? error.stdout : "";
  const message =
    [stderr, stdout, error?.message].find((value) => value?.trim()) ?? "unknown failure";
  const compact = message.replaceAll(/\s+/gu, " ").trim();
  const rootCause = (/((?:^|\s)Error: .*)/u.exec(compact)?.[1] ?? compact).replace(
    /\s+at (?:file:\/\/|\/).*/u,
    "",
  );
  return rootCause.slice(0, MAX_FAILURE_MESSAGE_LENGTH);
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderJunit(report) {
  const failures = report.cases.filter((testCase) => testCase.status === "failed");
  const cases = report.cases
    .map((testCase) => {
      const failure =
        testCase.status === "failed"
          ? `<failure message="${xmlEscape(
              testCase.message ?? "derived-state stage failed",
            )}">${xmlEscape(testCase.message ?? "derived-state stage failed")}</failure>`
          : testCase.status === "skipped"
            ? "<skipped/>"
            : "";
      return `    <testcase classname="docsfab.derived-state" name="${xmlEscape(
        testCase.id,
      )}" time="${(testCase.durationMs / 1000).toFixed(3)}">${failure}</testcase>`;
    })
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="docsfab-derived-state" tests="${report.cases.length}" failures="${
      failures.length
    }" time="${(report.durationMs / 1000).toFixed(3)}">`,
    cases,
    "</testsuite>",
    "",
  ].join("\n");
}

async function writeAtomic(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, bytes, { mode: 0o644 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function snapshotTargets(targets, targetRoot) {
  const root = await mkdtemp(join(tmpdir(), "docsfab-derived-"));
  const snapshots = [];
  for (const relativePath of targets) {
    const target = resolve(targetRoot, relativePath);
    const present = await exists(target);
    const snapshot = resolve(root, relativePath);
    if (present) {
      await mkdir(dirname(snapshot), { recursive: true });
      await cp(target, snapshot, { recursive: true, force: true });
    }
    snapshots.push({ target, snapshot, present });
  }
  return { root, snapshots };
}

async function restoreTargets(transaction) {
  // Restore in reverse order so a parent directory never removes a child that
  // still needs to be restored.
  for (const item of [...transaction.snapshots].reverse()) {
    await rm(item.target, { recursive: true, force: true });
    if (item.present) {
      await mkdir(dirname(item.target), { recursive: true });
      await cp(item.snapshot, item.target, { recursive: true, force: true });
    }
  }
}

/**
 * What a check reads. `committed` (`--check`, `check:pins`, the derived
 * preflight) skips outputs the build generates and git does not track, which a
 * fresh checkout lacks; `all` (the build's own staleness test) checks them too,
 * so a missing one is regenerated.
 */
export const CHECK_OUTPUTS = Object.freeze(["committed", "all"]);

// The line a generator prints for each output a committed-only check skips.
const COMMITTED_ONLY_SKIP = /^\S+: not checked here, the build generates it /u;

/** The committed-only skip lines in a generator's standard output. */
export function committedOnlySkips(stdout) {
  return `${stdout ?? ""}`.split("\n").filter((line) => COMMITTED_ONLY_SKIP.test(line));
}

/** The generator arguments for one step in one mode. */
export function stepArguments(step, checkOnly, checkOutputs) {
  if (!checkOnly || step.checkArgument === false) return [];
  return checkOutputs === "committed" && step.committedCheckArguments !== undefined
    ? [...step.committedCheckArguments]
    : ["--check"];
}

async function runStep(step, checkOnly, checkOutputs) {
  const started = Date.now();
  if (step.importsRuntimeSource === true) {
    // Only the untracked build-generated mirrors, never a committed output, so
    // this cannot hide drift a committed-output check reports.
    try {
      const { writeBuildGeneratedMirrors: writeLimitsMirrors } = await import("./check-limits.mjs");
      writeLimitsMirrors();
      const { writeBuildGeneratedMirrors: writeModelOutputMirrors } = await import(
        "./check-model-output.mjs"
      );
      writeModelOutputMirrors();
    } catch (error) {
      // Handles exactly a catalog that cannot load or a mirror that cannot be
      // written: this step's failure, before its generator would fail to import.
      return {
        id: step.id,
        status: "failed",
        durationMs: Date.now() - started,
        message: `could not write the build-generated mirrors it imports: ${boundedFailureMessage(error)}`,
      };
    }
  }
  const args = [
    ...(step.nodeArguments ?? []),
    resolve(scriptRoot, step.script),
    ...stepArguments(step, checkOnly, checkOutputs),
  ];
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd: runtimeRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const skipped = committedOnlySkips(stdout);
    return {
      id: step.id,
      status: "passed",
      durationMs: Date.now() - started,
      ...(skipped.length === 0 ? {} : { skipped }),
    };
  } catch (error) {
    return {
      id: step.id,
      status: "failed",
      durationMs: Date.now() - started,
      message: boundedFailureMessage(error),
    };
  }
}

export async function runDerived(options = {}) {
  const checkOnly = options.checkOnly === true;
  const scope = options.scope ?? "full";
  if (scope !== "full" && scope !== "machine") {
    throw new Error(`Unknown derived-state scope: ${scope}`);
  }
  // No default: a check of the checkout and the build's staleness test read
  // different output sets, and each caller names its own.
  const checkOutputs = options.checkOutputs;
  if (checkOnly && !CHECK_OUTPUTS.includes(checkOutputs)) {
    throw new Error(
      `a derived-state check needs checkOutputs ${CHECK_OUTPUTS.join(" or ")}, got ${checkOutputs}`,
    );
  }
  const steps = options.steps ?? (scope === "machine" ? MACHINE_DERIVED_STEPS : DERIVED_STEPS);
  const targets =
    options.targets ?? (scope === "machine" ? MACHINE_DERIVED_TARGETS : DERIVED_TARGETS);
  const targetRoot = options.targetRoot ?? runtimeRoot;
  const executeStep = options.executeStep ?? runStep;
  const started = Date.now();
  const cases = [];
  const transaction = checkOnly ? null : await snapshotTargets(targets, targetRoot);
  let firstFailure = null;
  try {
    for (const step of steps) {
      const result = await executeStep(step, checkOnly, checkOutputs);
      cases.push(result);
      if (result.status === "failed") {
        firstFailure = result;
        for (const skipped of steps.slice(cases.length)) {
          cases.push({
            id: skipped.id,
            status: "skipped",
            durationMs: 0,
            message: "not run after the first derived-state failure",
          });
        }
        break;
      }
    }
    if (firstFailure && transaction) await restoreTargets(transaction);
  } finally {
    if (transaction) await rm(transaction.root, { recursive: true, force: true });
  }
  return {
    schemaVersion: 1,
    kind: "docsfab-derived-state-preflight",
    mode: checkOnly ? "check" : "generate",
    status: firstFailure ? "failed" : "passed",
    firstFailure: firstFailure ? { id: firstFailure.id, message: firstFailure.message } : null,
    durationMs: Date.now() - started,
    cases,
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Derived-state argument error: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  const report = await runDerived({ ...options, checkOutputs: "committed" });
  if (options.reportJson) {
    await writeAtomic(options.reportJson, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (options.reportJunit) {
    await writeAtomic(options.reportJunit, renderJunit(report));
  }
  for (const testCase of report.cases) {
    const marker =
      testCase.status === "passed" ? "PASS" : testCase.status === "skipped" ? "SKIP" : "FAIL";
    console.log(`${marker} ${testCase.id}${testCase.message ? `: ${testCase.message}` : ""}`);
    for (const line of testCase.skipped ?? []) console.log(`  ${line}`);
  }
  if (report.firstFailure) {
    console.error(
      `Derived-state preflight failed at ${report.firstFailure.id}: ${report.firstFailure.message}`,
    );
    process.exitCode = 1;
  }
}

// Realpath both sides: `import.meta.url` is symlink-resolved but argv[1] is
// not, and a mismatch would exit 0 having generated or checked nothing.
if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
  await main();
}
