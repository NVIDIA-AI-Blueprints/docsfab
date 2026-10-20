#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live create-documentation dogfood against a throwaway no-doc fixture.
 *
 * Default is --dry-run (copy + git + print argv; no init apply; no model).
 * --live runs init apply on the throwaway copy and create-documentation --allow-write.
 * The throwaway copy's origin is --remote-url, else this checkout's origin. A dry
 * run needs neither; --live refuses without one, since init needs a GitLab remote.
 *
 *   node scripts/dogfood/create-documentation-no-doc/cli.mjs
 *   node scripts/dogfood/create-documentation-no-doc/cli.mjs --live [--remote-url <url>]
 *
 * Requires a built launcher (`npm run build`) and, for --live, gitignored
 * packages/runtime/.env with MODEL_PROVIDER, MODEL_BASE_URL, MODEL_ID, and
 * MODEL_API_KEY set (the template picks no model). Run records stay in a temp
 * state directory. Never apply init to this factory.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  CREATE_DOCUMENTATION_INSTRUCTION,
  LAUNCHER_MAX_BUFFER_LIMIT,
  assertCrateSteps,
  assertNotFactoryPath,
  captureBounded,
  copyNoDocFixture,
  crateStepStatuses,
  createDocumentationArgv,
  extractInitPlanSha256,
  extractRunResult,
  factoryInitWritePorcelain,
  factoryRootFromRuntime,
  initApplyArgv,
  initPreviewArgv,
  initializeThrowawayGit,
  launcherPath,
  parseCliArgs,
  provisionRuntimeEnv,
  readCatalogLimit,
  redactSecrets,
  remoteReport,
  requireLiveRemote,
  resolveThrowawayRemote,
  runtimeRootFromHere,
} from "./plan.mjs";

const execute = promisify(execFile);

function fail(message) {
  throw new Error(`create-documentation no-doc dogfood failed: ${message}`);
}

/** `launcher.maxBuffer` is the catalogued output bound; past it the run refuses by name. */
async function spawnLauncher(launcher, argv) {
  const { runtimeRoot, env, maxBuffer } = launcher;
  const argvWithLauncher = [launcherPath(runtimeRoot), ...argv];
  const result = await captureBounded(
    process.execPath,
    argvWithLauncher,
    { cwd: runtimeRoot, env },
    maxBuffer,
  );
  const stdout = redactSecrets(String(result.stdout ?? ""));
  const stderr = redactSecrets(String(result.stderr ?? ""));
  return { stdout, stderr, code: result.code };
}

async function requireLauncher(launcher, argv) {
  const spawned = await spawnLauncher(launcher, argv);
  if (spawned.code !== 0) {
    fail(
      `docsfab ${argv[0]} exited ${spawned.code}: ${spawned.stderr || spawned.stdout || "no output"}`,
    );
  }
  return spawned.stdout;
}

async function listIncludesCreateDocumentation(launcher) {
  const stdout = await requireLauncher(launcher, ["list"]);
  if (!stdout.includes("create-documentation")) {
    fail("`docsfab list` did not print create-documentation.");
  }
}

async function canonicalDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  return realpath(path);
}

async function provisionConfigRoot(runtimeRoot, scratch) {
  const configRoot = await canonicalDirectory(join(scratch, "config"));
  await provisionRuntimeEnv(runtimeRoot, configRoot);
  return configRoot;
}

async function commitProjectConfig(repositoryPath) {
  await execute("git", ["add", ".docsfab.json"], { cwd: repositoryPath });
  const { stdout } = await execute("git", ["status", "--porcelain", "--", ".docsfab.json"], {
    cwd: repositoryPath,
  });
  if (stdout.trim()) {
    await execute("git", ["commit", "-q", "-m", "DocsFab init"], { cwd: repositoryPath });
  }
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const runtimeRoot = runtimeRootFromHere();
  const factoryRoot = factoryRootFromRuntime(runtimeRoot);
  const maxBuffer = await readCatalogLimit(factoryRoot, LAUNCHER_MAX_BUFFER_LIMIT);
  const beforeFactory = await factoryInitWritePorcelain(factoryRoot);
  const remote = await resolveThrowawayRemote(factoryRoot, options.remoteUrl);
  if (options.live) requireLiveRemote(remote);
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "docsfab-no-doc-dogfood-")));
  const repositoryPath = join(scratch, "fixture");
  const stateDirectory = await canonicalDirectory(join(scratch, "state"));

  try {
    assertNotFactoryPath(repositoryPath, factoryRoot);
    await copyNoDocFixture(runtimeRoot, repositoryPath);
    await initializeThrowawayGit(repositoryPath, remote.url);
    const repo = await realpath(repositoryPath);

    const previewArgv = initPreviewArgv(repo);
    const applyArgvPlaceholder = initApplyArgv(repo, "a".repeat(64)).map((part) =>
      /^[a-f0-9]{64}$/u.test(part) ? "<plan-sha256>" : part,
    );
    const runArgv = createDocumentationArgv(repo);
    const envelope = {
      kind: "docsfab-create-documentation-no-doc-dogfood",
      mode: options.live ? "live" : "dry-run",
      factory: "this checkout (paths withheld from secrets)",
      instruction: CREATE_DOCUMENTATION_INSTRUCTION,
      remote: remoteReport(remote),
      argv: {
        initPreview: previewArgv,
        initApply: applyArgvPlaceholder,
        run: runArgv,
      },
    };

    if (!options.live) {
      console.log(JSON.stringify(envelope, null, 2));
      return;
    }

    const configRoot = await provisionConfigRoot(runtimeRoot, scratch);
    const xdgHome = await canonicalDirectory(join(scratch, "xdg"));
    const env = {
      ...process.env,
      DOCSFAB_CONFIG_ROOT: configRoot,
      DOCSFAB_STATE_DIR: stateDirectory,
      XDG_STATE_HOME: xdgHome,
    };
    const launcher = { runtimeRoot, env, maxBuffer };
    await listIncludesCreateDocumentation(launcher);
    const preview = await requireLauncher(launcher, previewArgv);
    const planSha256 = extractInitPlanSha256(preview);
    await requireLauncher(launcher, initApplyArgv(repo, planSha256));
    await commitProjectConfig(repo);
    const spawnedRun = await spawnLauncher(launcher, runArgv);
    const run = extractRunResult(spawnedRun.stdout || spawnedRun.stderr);
    const record = JSON.parse(await readFile(run.recordPath, "utf8"));
    const steps = assertCrateSteps(record);
    const afterFactory = await factoryInitWritePorcelain(factoryRoot);
    if (afterFactory !== beforeFactory) {
      fail("factory checkout gained init/write artifacts; throwaway target leaked.");
    }
    if (spawnedRun.code !== 0 || run.exitCode !== 0 || record.status !== "succeeded") {
      fail(
        `create-documentation status=${record.status} exit=${spawnedRun.code}: ${JSON.stringify(crateStepStatuses(record))}`,
      );
    }
    const summary = {
      ...envelope,
      mode: "live",
      argv: {
        initPreview: previewArgv,
        initApply: initApplyArgv(repo, planSha256),
        run: runArgv,
      },
      runId: run.runId,
      steps,
      status: record.status,
    };
    await writeFile(join(scratch, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(
      JSON.stringify(
        {
          kind: summary.kind,
          mode: "live",
          instruction: CREATE_DOCUMENTATION_INSTRUCTION,
          runId: run.runId,
          steps,
          status: record.status,
          factoryInitWritePorcelainUnchanged: true,
        },
        null,
        2,
      ),
    );
  } finally {
    if (!options.keep) await rm(scratch, { recursive: true, force: true });
    else console.error(redactSecrets(`kept scratch: ${scratch}`));
  }
}

main().catch((error) => {
  console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
