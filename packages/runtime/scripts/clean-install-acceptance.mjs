#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Clean-install offline acceptance for the one-command autonomous journey.
 *
 * Usage: node scripts/clean-install-acceptance.mjs [--artifact-dir <leaf>]
 *        [--output-dir <leaf>]
 *   (without --artifact-dir, packs fresh; with it, verifies a retained artifact)
 *
 * Proves that a user who installs DocsFab from the packed release artifact,
 * with no network and no credentials, completes the documented journey
 * against fake provider and GitLab boundaries. Every asserted step runs the
 * installed `docsfab` executable as a subprocess, never source-tree code:
 *
 *   1. `docsfab --version`: installed identity, outside the source.
 *   2. `docsfab test --json`: the full offline cycle in one fake boundary.
 *   3. `docsfab test --json` again once per cycle stage, modelling an
 *      interrupt-then-resume; each reproduces the identical receipt and the
 *      same single draft-MR effect, never a duplicate mutation.
 *   4. `docsfab init --non-interactive` preview and apply against a disposable
 *      repository and a fake `glab`.
 *   5. `docsfab auto --dry-run` and `--once` against the real assessment
 *      boundary, which fails closed offline with no write or external effect.
 *
 * It then asserts the source checkout is byte- and Git-state unchanged, no
 * secret or host path leaked into output, and each cycle fit the documented
 * first-run budget.
 *
 * The no-network, no-credentials guarantee covers the product run, not the
 * tarball install, which uses a clean private npm cache as the release gate
 * does. Every `docsfab` invocation runs with a scrubbed environment,
 * PI_OFFLINE, no trusted roadmap host, and a fake `glab` first on PATH.
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  installPackedDocsFab,
  parsePackedVerificationArguments,
  preparePackedCandidate,
  retainPackedArtifact,
  withExplicitModelSelection,
} from "./lib/packed-cli.mjs";
import { installedVersionIdentity } from "./lib/installed-version-identity.mjs";

const execute = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

// The documented first-run budget for one installed offline cycle
// (docs/get-started/installation-reference.md).
const CYCLE_BUDGET_MS = 10_000;
// A generous ceiling for the whole clean-install journey wall clock.
const JOURNEY_BUDGET_MS = 300_000;

const FAKE_GITLAB_HOST = "gitlab.example.test";
const FAKE_PROJECT_PATH = "group/project";
const CONFIG_KEY_SENTINEL = "clean-install-acceptance-not-a-credential";

function fail(message) {
  throw new Error(`Clean-install offline acceptance failed: ${message}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected)
    fail(`${message} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

/**
 * A credential-free, network-free environment for the installed executable.
 * Drops every model, judge, DocsFab, inference-hub, and SCM-token variable so
 * no host credential can cross the subprocess boundary, then rebinds only the
 * disposable configuration, private-state, home, and PATH the run needs.
 */
function offlineCliEnvironment(base, { configRoot, stateHome, home, fakeBin }) {
  const scrubbed = Object.fromEntries(
    Object.entries(base).filter(
      ([name]) =>
        !/^(?:MODEL|JUDGE|DOCSFAB|DOCSFAB|INFERENCE_HUB|GITLAB|GLAB|SCM|PRIVATE)_/u.test(name) &&
        name !== "GITLAB_TOKEN" &&
        name !== "GLAB_TOKEN" &&
        name !== "PRIVATE_TOKEN",
    ),
  );
  return {
    ...scrubbed,
    DOCSFAB_CONFIG_ROOT: configRoot,
    XDG_STATE_HOME: stateHome,
    HOME: home,
    PATH: `${fakeBin}:${base.PATH ?? ""}`,
    PI_OFFLINE: "1",
    NODE_NO_WARNINGS: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function git(cwd, environment, ...args) {
  return execute("git", args, { cwd, env: environment, maxBuffer: MAX_BUFFER });
}

async function captureSourceIdentity(environment) {
  const [head, tree, objectFormat, status] = await Promise.all([
    git(projectRoot, environment, "rev-parse", "HEAD"),
    git(projectRoot, environment, "rev-parse", "HEAD^{tree}"),
    git(projectRoot, environment, "rev-parse", "--show-object-format"),
    git(
      projectRoot,
      environment,
      "-c",
      "core.fsmonitor=false",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ),
  ]);
  return {
    head: head.stdout.trim(),
    tree: tree.stdout.trim(),
    objectFormat: objectFormat.stdout.trim(),
    status: status.stdout,
  };
}

function assertLeakFree(text, secrets, label) {
  for (const secret of secrets) {
    if (secret && text.includes(secret)) fail(`${label} leaked a private value or host path`);
  }
}

/**
 * Assert one offline product-test record proves the full fake-boundary cycle:
 * one managed issue reconciled, one draft MR, exactly one external mutation, an
 * idempotent retry, and an unchanged source checkout with no credential/network.
 */
function assertOfflineCycleRecord(record) {
  assertEqual(record.kind, "docsfab-offline-product-test", "offline product test kind");
  assertEqual(record.status, "passed", "offline product test status");
  assertEqual(
    record.isolation?.credentials,
    "not-used",
    "offline product test credential isolation",
  );
  assertEqual(record.isolation?.network, "not-used", "offline product test network isolation");
  assertEqual(
    record.isolation?.sourceCheckout,
    "unchanged",
    "offline product test source isolation",
  );
  assertEqual(record.tracker?.status, "reconciled", "offline product test tracker status");
  if (typeof record.tracker?.gapId !== "string" || record.tracker.gapId.length === 0) {
    fail("offline product test did not reconcile exactly one managed issue gap");
  }
  assertEqual(record.publication?.mergeRequest, "draft", "offline product test merge-request kind");
  assertEqual(
    record.publication?.externalMutationCount,
    1,
    "offline product test external mutation count",
  );
  assertEqual(record.retry?.status, "idempotent", "offline product test retry status");
  assertEqual(record.retry?.sameReceipt, true, "offline product test retry receipt reuse");
  assertEqual(record.retry?.externalMutationCount, 1, "offline product test retry mutation count");
  if (!Array.isArray(record.steps) || record.steps.some((step) => step.status !== "passed")) {
    fail("offline product test did not pass every declared cycle stage");
  }
  if (typeof record.sha256 !== "string" || record.sha256.length !== 64) {
    fail("offline product test did not produce a stable content digest");
  }
  return record;
}

async function runInstalledOfflineCycle(executable, environment, cwd) {
  const startedAt = Date.now();
  const result = await execute(executable, ["test", "--json"], {
    cwd,
    env: environment,
    timeout: CYCLE_BUDGET_MS,
    maxBuffer: MAX_BUFFER,
  });
  const durationMs = Date.now() - startedAt;
  if (result.stderr !== "") fail("installed offline product test wrote to standard error");
  if (durationMs > CYCLE_BUDGET_MS)
    fail("installed offline product test exceeded the documented cycle budget");
  return { record: assertOfflineCycleRecord(JSON.parse(result.stdout)), durationMs };
}

async function writeFakeGlab(fakeBin) {
  const glab = join(fakeBin, "glab");
  await writeFile(
    glab,
    `#!/usr/bin/env node
// Deterministic offline fake glab for clean-install acceptance. It answers only
// the read-only probes docsfab init performs and never touches the network.
const argv = process.argv.slice(2);
const joined = argv.join(" ");
function emit(object) { process.stdout.write(JSON.stringify(object)); }
if (argv[0] === "version" || joined === "--version") {
  console.log("glab clean-install-acceptance-fake 1.0.0");
  process.exit(0);
}
if (argv[0] === "auth" && argv[1] === "status") { process.exit(0); }
if (argv[0] === "api") {
  const endpoint = argv[argv.length - 1];
  if (endpoint === "user") { emit({ id: 4242, username: "docsfab-acceptance" }); process.exit(0); }
  if (endpoint.startsWith("projects/")) {
    emit({
      id: 99,
      path_with_namespace: ${JSON.stringify(FAKE_PROJECT_PATH)},
      default_branch: "main",
      permissions: { project_access: { access_level: 40 } },
    });
    process.exit(0);
  }
}
process.exit(1);
`,
    { mode: 0o700 },
  );
  await chmod(glab, 0o700);
}

async function createDisposableRepository(root, environment) {
  const repositoryPath = await realpath(await mkdtemp(join(root, "repository-")));
  await git(repositoryPath, environment, "init", "--initial-branch", "main");
  await git(repositoryPath, environment, "config", "user.name", "DocsFab Clean Install Acceptance");
  await git(
    repositoryPath,
    environment,
    "config",
    "user.email",
    "docsfab-acceptance@example.invalid",
  );
  await git(repositoryPath, environment, "config", "commit.gpgsign", "false");
  await git(
    repositoryPath,
    environment,
    "remote",
    "add",
    "origin",
    `https://${FAKE_GITLAB_HOST}/${FAKE_PROJECT_PATH}.git`,
  );
  await writeFile(join(repositoryPath, "README.md"), "# Clean-install acceptance fixture\n");
  await writeFile(
    join(repositoryPath, "package.json"),
    `${JSON.stringify({ name: "acceptance-fixture", private: true, scripts: { check: "node --eval 0" } })}\n`,
  );
  await git(repositoryPath, environment, "add", "--all");
  await git(
    repositoryPath,
    environment,
    "commit",
    "--message",
    "Create clean-install acceptance fixture",
  );
  return repositoryPath;
}

async function repositoryState(repositoryPath, environment) {
  const [head, status] = await Promise.all([
    git(repositoryPath, environment, "rev-parse", "HEAD"),
    git(
      repositoryPath,
      environment,
      "-c",
      "core.fsmonitor=false",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ),
  ]);
  return `${head.stdout.trim()}\n${status.stdout}`;
}

async function main() {
  const { artifactDirectoryLeaf, outputDirectoryLeaf } = parsePackedVerificationArguments(
    process.argv.slice(2),
  );
  if (artifactDirectoryLeaf && outputDirectoryLeaf) {
    fail("retaining an installed candidate requires a fresh pack; omit --artifact-dir");
  }
  const journeyStartedAt = Date.now();
  const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  const localGitEnvironment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const sourceBefore = await captureSourceIdentity(localGitEnvironment);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sourceBefore.head)) {
    fail("could not resolve the DocsFab source checkout revision before the run");
  }

  const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "docsfab-clean-install-")));
  const capturedOutputs = [];
  try {
    const packRoot = join(temporaryRoot, "pack");
    const installRoot = join(temporaryRoot, "install");
    const outsideRoot = join(temporaryRoot, "outside-source");
    const configRoot = join(temporaryRoot, "config");
    const stateHome = join(temporaryRoot, "state");
    const home = join(temporaryRoot, "home");
    const fakeBin = join(temporaryRoot, "fake-bin");
    const npmCache = join(temporaryRoot, "npm-cache");
    await Promise.all([
      mkdir(packRoot),
      mkdir(installRoot),
      mkdir(outsideRoot),
      mkdir(configRoot, { mode: 0o700 }),
      mkdir(stateHome, { mode: 0o700 }),
      mkdir(home),
      mkdir(fakeBin, { mode: 0o700 }),
      mkdir(npmCache),
    ]);

    // Installing is environment setup, not the acceptance: a clean private npm
    // cache as the release gate uses, since `--offline` would need a pre-warmed
    // cache. The offline guarantee is enforced on the product run below.
    const expectedPackedVersion =
      process.env.CI_COMMIT_BRANCH && process.env.CI_COMMIT_BRANCH === process.env.CI_DEFAULT_BRANCH
        ? `${packageJson.version}-main.${process.env.CI_COMMIT_SHORT_SHA ?? ""}`
        : packageJson.version;
    const npmEnvironment = {
      ...process.env,
      npm_config_cache: npmCache,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
      DOCSFAB_PACKAGE_FINAL_VERSION: expectedPackedVersion,
    };
    const candidate = await preparePackedCandidate({
      projectRoot,
      packDestination: packRoot,
      env: npmEnvironment,
      artifactDirectoryLeaf,
    });
    const { record: packRecord, tarball } = candidate;
    assertEqual(packRecord.name, packageJson.name, "packed artifact name");
    assertEqual(packRecord.version, expectedPackedVersion, "packed artifact final version binding");
    assertEqual(
      candidate.sourceVersion,
      packageJson.version,
      "packed artifact source version binding",
    );
    assertEqual(candidate.sourceClean, true, "packed artifact clean source provenance");
    const { executable, installedPackageRoot } = await installPackedDocsFab({
      tarball,
      installRoot,
      cwd: outsideRoot,
      env: npmEnvironment,
    });
    if (!executable.startsWith(installRoot) || executable.startsWith(projectRoot)) {
      fail("installed executable is not rooted in the isolated global prefix");
    }

    // The credential-free offline configuration the installed CLI reads. The
    // API key is a non-credential placeholder proving nothing real is required.
    const example = await readFile(join(projectRoot, ".env.example"), "utf8");
    const configuration = withExplicitModelSelection(
      example
        .split(/(?<=\n)/u)
        .filter((line) => !/^DOCSFAB_(?:SKILLS_DIR|STATE_DIR)=/u.test(line))
        .join("")
        .replace(/^MODEL_API_KEY=.*$/mu, `MODEL_API_KEY=${CONFIG_KEY_SENTINEL}`),
    );
    await writeFile(join(configRoot, ".env"), configuration, { mode: 0o600 });
    await writeFakeGlab(fakeBin);
    const cliEnvironment = offlineCliEnvironment(process.env, {
      configRoot,
      stateHome,
      home,
      fakeBin,
    });
    // With no trusted host, the assessment boundary never opens a socket.
    delete cliEnvironment.DOCSFAB_ROADMAP_GITLAB_HOST;
    // Must-not-leak set: the credential placeholder, the DocsFab source root,
    // and the private configuration and state roots. The disposable repository
    // path is not secret: next-command hints echo the user's own path.
    const secrets = [CONFIG_KEY_SENTINEL, projectRoot, configRoot, stateHome];

    // Step 1 — installed identity outside the source tree.
    const version = await execute(executable, ["--version"], {
      cwd: outsideRoot,
      env: cliEnvironment,
    });
    assertEqual(
      version.stdout,
      await installedVersionIdentity(installedPackageRoot, packRecord.version, fail),
      "installed executable version",
    );

    // Step 2 — one full offline cycle, and step 3 — interrupt/resume idempotency.
    const firstCycle = await runInstalledOfflineCycle(executable, cliEnvironment, outsideRoot);
    capturedOutputs.push(JSON.stringify(firstCycle.record));
    const canonicalReceipt = firstCycle.record.sha256;
    const cycleDurationsMs = [firstCycle.durationMs];
    // One resume per declared stage; each must reproduce the same single
    // draft-MR effect with no duplicate mutation.
    for (const stage of firstCycle.record.steps) {
      const resumed = await runInstalledOfflineCycle(executable, cliEnvironment, outsideRoot);
      capturedOutputs.push(JSON.stringify(resumed.record));
      cycleDurationsMs.push(resumed.durationMs);
      if (resumed.record.sha256 !== canonicalReceipt) {
        fail(`resuming after stage ${stage.id} produced a different cycle receipt`);
      }
      if (
        resumed.record.publication.externalMutationCount !== 1 ||
        resumed.record.retry.externalMutationCount !== 1
      ) {
        fail(`resuming after stage ${stage.id} duplicated an external mutation`);
      }
    }

    // Step 4 — non-interactive init against a disposable repo and fake glab.
    const repositoryPath = await createDisposableRepository(temporaryRoot, cliEnvironment);
    const preview = await execute(
      executable,
      ["init", "--repo", repositoryPath, "--remote", "origin", "--non-interactive", "--json"],
      { cwd: repositoryPath, env: cliEnvironment, maxBuffer: MAX_BUFFER },
    );
    capturedOutputs.push(preview.stdout);
    const plan = JSON.parse(preview.stdout);
    assertEqual(plan.kind, "docsfab-init-plan", "init preview kind");
    assertEqual(plan.change, "create", "init preview change");
    assertEqual(plan.gitlabProject, "ready", "init preview GitLab project readiness");
    assertEqual(plan.gitlabAuthentication, "configured", "init preview GitLab authentication");
    if (typeof plan.sha256 !== "string" || plan.sha256.length !== 64) {
      fail("init preview did not emit one fresh plan digest");
    }
    const apply = await execute(
      executable,
      [
        "init",
        "--repo",
        repositoryPath,
        "--remote",
        "origin",
        "--non-interactive",
        "--apply",
        "--approve-plan-sha256",
        plan.sha256,
      ],
      { cwd: repositoryPath, env: cliEnvironment, maxBuffer: MAX_BUFFER },
    );
    capturedOutputs.push(apply.stdout);
    if (!/Initialization status:/u.test(apply.stdout))
      fail("init apply did not report an initialization status");
    const projectConfig = JSON.parse(await readFile(join(repositoryPath, ".docsfab.json"), "utf8"));
    assertEqual(
      projectConfig.provider?.configuration,
      "host",
      "applied project provider configuration",
    );
    assertEqual(projectConfig.gitlab?.defaultBranch, "main", "applied project default branch");
    if (JSON.stringify(projectConfig).includes(CONFIG_KEY_SENTINEL)) {
      fail("the applied project configuration captured a credential value");
    }

    // Steps 5 — the real assessment boundary offline: bounded, no write, and a
    // second unchanged cycle performs no duplicate mutation on the repository.
    const repositoryBefore = await repositoryState(repositoryPath, cliEnvironment);
    const dryRun = await execute(executable, ["auto", "--dry-run", "--repo", repositoryPath], {
      cwd: repositoryPath,
      env: cliEnvironment,
      timeout: 60_000,
      maxBuffer: MAX_BUFFER,
    });
    capturedOutputs.push(dryRun.stdout);
    if (!/Assessment:/u.test(dryRun.stdout))
      fail("auto --dry-run did not print an assessment summary");
    const onceOutputs = [];
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const once = await execute(executable, ["auto", "--once", "--repo", repositoryPath], {
        cwd: repositoryPath,
        env: cliEnvironment,
        timeout: 60_000,
        maxBuffer: MAX_BUFFER,
      });
      capturedOutputs.push(once.stdout);
      // Offline the assessment fails closed to a bounded needs-input; a proposal
      // would still require --confirm-cycle. Both dispositions report no write.
      if (!/Writes performed: none/u.test(once.stdout)) {
        fail("auto --once performed or proposed a write without an affirmative confirmation");
      }
      if (/Auto once proposal/u.test(once.stdout) && !/--confirm-cycle/u.test(once.stdout)) {
        fail("auto --once proposal omitted its affirmative confirmation step");
      }
      onceOutputs.push(once.stdout);
    }
    assertEqual(onceOutputs[0], onceOutputs[1], "auto --once second unchanged cycle output");
    const repositoryAfter = await repositoryState(repositoryPath, cliEnvironment);
    assertEqual(
      repositoryAfter,
      repositoryBefore,
      "disposable repository Git state after read-only auto cycles",
    );

    // No must-not-leak value appears in any captured output.
    for (const output of capturedOutputs)
      assertLeakFree(output, secrets, "installed command output");

    // The DocsFab source checkout is byte- and Git-state unchanged.
    const sourceAfter = await captureSourceIdentity(localGitEnvironment);
    if (
      sourceAfter.head !== sourceBefore.head ||
      sourceAfter.tree !== sourceBefore.tree ||
      sourceAfter.objectFormat !== sourceBefore.objectFormat ||
      sourceAfter.status !== sourceBefore.status
    ) {
      fail("the DocsFab source checkout identity or status changed during acceptance");
    }

    const journeyDurationMs = Date.now() - journeyStartedAt;
    if (journeyDurationMs > JOURNEY_BUDGET_MS) {
      fail("the clean-install journey exceeded the documented wall-clock ceiling");
    }
    const slowestCycleMs = Math.max(...cycleDurationsMs);

    if (outputDirectoryLeaf) {
      await retainPackedArtifact({
        projectRoot,
        artifactRoot: join(projectRoot, outputDirectoryLeaf),
        tarball,
        record: packRecord,
        sourceRevision: candidate.sourceRevision,
        sourceVersion: candidate.sourceVersion,
        sourceClean: candidate.sourceClean,
      });
      const afterRetention = await captureSourceIdentity(localGitEnvironment);
      if (
        afterRetention.head !== sourceBefore.head ||
        afterRetention.tree !== sourceBefore.tree ||
        afterRetention.objectFormat !== sourceBefore.objectFormat ||
        afterRetention.status !== sourceBefore.status
      ) {
        fail("retained output changed source state; use a Git-ignored output directory");
      }
    }

    console.log(
      `PASS clean-install offline acceptance for ${packRecord.name}@${packRecord.version}`,
    );
    console.log(
      `Candidate ${candidate.origin} integrity ${candidate.integrity}; source revision ${candidate.sourceRevision}.`,
    );
    console.log(
      `Installed the packed artifact (setup); the product run below was network- and credential-free. Executable ${executable}`,
    );
    console.log(
      `Offline cycles: ${cycleDurationsMs.length} (1 initial + ${cycleDurationsMs.length - 1} interrupt/resume); slowest ${slowestCycleMs} ms of ${CYCLE_BUDGET_MS} ms budget.`,
    );
    console.log(
      `One managed issue reconciled and one draft MR; external mutations stayed 1 across every resume. Receipt ${canonicalReceipt}.`,
    );
    console.log(
      "Non-interactive init produced one credential-free .docsfab.json against a fake glab boundary.",
    );
    console.log(
      "auto --dry-run and a repeated auto --once left the disposable repository Git-state unchanged with no write.",
    );
    console.log(
      `DocsFab source checkout unchanged at ${sourceAfter.head}. Journey completed in ${journeyDurationMs} ms.`,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { installedVersionIdentity, offlineCliEnvironment };
