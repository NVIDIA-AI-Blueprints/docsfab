#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sequential canonical-catalog scorecard harness.
 *
 * Default mode is offline / fixture-first (`PI_OFFLINE=1`). It writes a
 * machine-readable scorecard covering the runnable catalog workflows plus
 * `auto --dry-run`, `multi-unit-campaign` dry-run, and `docsfab do --route-only`.
 * Evidence defaults to a trusted temp directory outside the source checkout.
 *
 * `--execute` invokes those CLI surfaces sequentially without live inference.
 * `--live` is a documented opt-in (DOCSFAB_CATALOG_SCORECARD_LIVE=1) and is
 * not required for CI or `npm run check`.
 *
 * Do not print credentials, host home paths, or raw model transcripts into
 * the scorecard artifacts. This helper is not a product job queue.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const MAX_BUFFER = 4 * 1024 * 1024;
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const LIVE_GATE = "DOCSFAB_CATALOG_SCORECARD_LIVE";
const GOLDEN_OUTCOME_REQUEST = "Review the documentation";
const LEAK = /(?:\/Users\/|\/home\/|glpat-|sk-)/u;

/** Canonical operator-runnable names from packages/runtime/workflows/. */
export const CATALOG_WORKFLOWS = Object.freeze([
  { id: "review-documentation", role: "primary" },
  { id: "create-documentation", role: "primary" },
  { id: "update-documentation", role: "primary" },
  { id: "restructure-documentation", role: "primary" },
]);

const OPERATOR_MODES = Object.freeze([
  {
    id: "auto-dry-run",
    command: "docsfab auto --dry-run --json",
    argv: (repo, revision) => [
      "auto",
      "--dry-run",
      "--repo",
      repo,
      "--revision",
      revision,
      "--json",
    ],
  },
  {
    id: "multi-unit-campaign-dry-run",
    command: "docsfab multi-unit-campaign --dry-run --json",
    argv: (repo, revision, campaignDir) => [
      "multi-unit-campaign",
      "--campaign-dir",
      campaignDir,
      "--repo",
      repo,
      "--revision",
      revision,
      "--dry-run",
      "--json",
    ],
  },
  {
    id: "do-route-only",
    command: "docsfab do --route-only --json",
    argv: (repo, revision) => [
      "do",
      GOLDEN_OUTCOME_REQUEST,
      "--repo",
      repo,
      "--revision",
      revision,
      "--route-only",
      "--json",
    ],
  },
]);

const WRITE_WORKFLOWS = new Set([
  "create-documentation",
  "update-documentation",
  "restructure-documentation",
]);

function fail(message) {
  throw new Error(`Catalog scorecard failed: ${message}`);
}

function parseArgs(argv) {
  const values = new Map();
  let executeMode = false;
  let live = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      return { help: true };
    }
    if (argument === "--execute") {
      if (executeMode) fail("duplicated --execute");
      executeMode = true;
      continue;
    }
    if (argument === "--live") {
      if (live) fail("duplicated --live");
      live = true;
      continue;
    }
    if (argument === "--evidence-dir" || argument === "--repo" || argument === "--revision") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`${argument} requires a value`);
      if (values.has(argument)) fail(`duplicated ${argument}`);
      values.set(argument, value);
      index += 1;
      continue;
    }
    fail(`unknown option ${argument}`);
  }
  if (executeMode && live) fail("pass only one of --execute or --live");
  return {
    help: false,
    executeMode,
    live,
    evidenceDir: values.get("--evidence-dir") ?? null,
    repo: values.get("--repo") ?? null,
    revision: values.get("--revision") ?? null,
  };
}

function usage() {
  return `Canonical catalog scorecard (#285)

Default (offline / fixture-first, CI-safe stub):
  node scripts/catalog-scorecard.mjs
  node scripts/catalog-scorecard.mjs --evidence-dir /absolute/private/dir

Offline execute (no live model; not required for npm run check):
  PI_OFFLINE=1 node scripts/catalog-scorecard.mjs --execute --repo <path> [--revision <sha>]

Live model (opt-in, not CI):
  ${LIVE_GATE}=1 node scripts/catalog-scorecard.mjs --live --repo <path> [--revision <sha>]

Evidence defaults outside the source checkout. Do not commit credentials,
host paths, or raw transcripts. Polish is regression-only in the matrix.
`;
}

function scrubEnv(base, live) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (/(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|CREDENTIAL)/iu.test(key)) {
      delete env[key];
    }
  }
  if (!live) {
    env.PI_OFFLINE = "1";
    env.CI = env.CI ?? "1";
  }
  delete env.DOCSFAB_ROADMAP_GITLAB_HOST;
  return env;
}

function isInsideRoot(candidate, root) {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(prefix);
}

async function git(cwd, args) {
  const { stdout } = await execute("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    maxBuffer: MAX_BUFFER,
  });
  return stdout.trim();
}

async function createFixtureRepository() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-catalog-fixture-")));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "catalog-scorecard@example.test"]);
  await git(root, ["config", "user.name", "Catalog Scorecard"]);
  await git(root, ["config", "commit.gpgSign", "false"]);
  await writeFile(join(root, "README.md"), "# Catalog scorecard fixture\n");
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "guide.md"), "# Guide\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "catalog scorecard fixture"]);
  const revision = await git(root, ["rev-parse", "HEAD"]);
  return { root, revision, ephemeral: true };
}

async function resolveTarget(options) {
  if (options.revision && !options.repo) {
    fail("--revision requires --repo");
  }
  if (options.repo) {
    const root = await realpath(resolve(options.repo));
    const revision = options.revision ?? (await git(root, ["rev-parse", "HEAD"]));
    if (!/^[0-9a-f]{7,64}$/iu.test(revision) && revision !== "HEAD") {
      fail("revision must be a git object name");
    }
    const resolved = revision === "HEAD" ? await git(root, ["rev-parse", "HEAD"]) : revision;
    return { root, revision: resolved, ephemeral: false };
  }
  return createFixtureRepository();
}

async function resolveEvidenceDir(requested) {
  if (requested) {
    if (!requested.startsWith("/") || requested.includes("\0")) {
      fail("--evidence-dir must be an absolute path");
    }
    const candidate = resolve(requested);
    if (isInsideRoot(candidate, projectRoot)) {
      fail("evidence directory must be outside the source checkout");
    }
    await mkdir(candidate, { recursive: true, mode: 0o700 });
    const resolved = await realpath(candidate);
    if (isInsideRoot(resolved, projectRoot)) {
      fail("evidence directory must be outside the source checkout");
    }
    return resolved;
  }
  const created = await mkdtemp(join(tmpdir(), "docsfab-catalog-scorecard-"));
  const resolved = await realpath(created);
  if (isInsideRoot(resolved, projectRoot)) {
    fail("default evidence directory resolved inside the source checkout");
  }
  return resolved;
}

async function generatorRevision() {
  try {
    return await git(projectRoot, ["rev-parse", "HEAD"]);
  } catch {
    return "unknown";
  }
}

function stubEntries() {
  const workflows = CATALOG_WORKFLOWS.map((workflow) => ({
    id: workflow.id,
    surface: "catalog-workflow",
    role: workflow.role,
    command: `docsfab plan ${workflow.id}`,
    status: "stub",
    exitCode: null,
    disposition: "offline-fixture",
  }));
  const modes = OPERATOR_MODES.map((mode) => ({
    id: mode.id,
    surface: "operator-mode",
    role: "primary",
    command: mode.command,
    status: "stub",
    exitCode: null,
    disposition: "offline-fixture",
  }));
  return [...workflows, ...modes];
}

function extractJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function sanitizedDisposition(id, stdout, stderr, exitCode) {
  const combined = `${stdout}\n${stderr}`;
  const rejected = combined.match(/rejected: ([a-z0-9-]+)/iu);
  if (rejected) return `fail-closed:${rejected[1]}`;
  const json = extractJsonObject(stdout) ?? extractJsonObject(stderr);
  if (json && typeof json === "object") {
    const decision = json.decision;
    if (json.kind === "docsfab-outcome-route" && decision && typeof decision === "object") {
      const status = typeof decision.status === "string" ? decision.status : "recorded";
      const workflow = typeof decision.workflow === "string" ? decision.workflow : null;
      const reason = typeof decision.reason === "string" ? decision.reason : null;
      return ["route", status, workflow, reason].filter(Boolean).join(":");
    }
    if (json.kind === "docsfab-auto-dry-run" && decision && typeof decision === "object") {
      const disposition =
        typeof decision.disposition === "string" ? decision.disposition : "recorded";
      const reason = typeof decision.reasonCode === "string" ? decision.reasonCode : null;
      return ["auto", disposition, reason].filter(Boolean).join(":");
    }
    if (json.kind === "multi-unit-doc-improvement-campaign-dry-run-result") {
      const stop = typeof json.stopReason === "string" ? json.stopReason : "recorded";
      return `multi-unit:${stop}`;
    }
  }
  if (id !== "auto-dry-run" && id !== "multi-unit-campaign-dry-run" && id !== "do-route-only") {
    if (exitCode === 0 && /Outcome:/u.test(stdout)) return "plan-ok";
  }
  return exitCode === 0 ? "ok" : "nonzero-exit";
}

async function runDocsFab(args, live, timeoutMs) {
  try {
    const result = await execute(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: projectRoot,
      env: scrubEnv(process.env, live),
      maxBuffer: MAX_BUFFER,
      timeout: timeoutMs,
    });
    return {
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
      exitCode: 0,
    };
  } catch (error) {
    const failure = error;
    return {
      stdout: String(failure.stdout ?? ""),
      stderr: String(failure.stderr ?? ""),
      exitCode: typeof failure.code === "number" ? failure.code : 1,
    };
  }
}

async function assertCatalogList(live) {
  const listed = await runDocsFab(["list"], live, 30_000);
  if (listed.exitCode !== 0) fail("docsfab list failed");
  const names = new Set(
    listed.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/u)[0])
      .filter(Boolean),
  );
  for (const workflow of CATALOG_WORKFLOWS) {
    if (!names.has(workflow.id)) fail(`docsfab list missing ${workflow.id}`);
  }
}

function liveSkipDisposition(workflow) {
  if (workflow.role === "regression-only") return "regression-only-skipped";
  if (WRITE_WORKFLOWS.has(workflow.id)) return "write-skipped-no-allow-write";
  return null;
}

function liveRunArgv(workflowId, repo, revision) {
  const args = ["run", workflowId, "--repo", repo, "--revision", revision, "--json"];
  if (workflowId === "ia-analysis" || workflowId === "ia-plan") {
    args.push("--scope", "site", "--mode", "create");
  }
  return args;
}

async function executeEntries(target, live) {
  await assertCatalogList(live);
  const campaignDir = await realpath(await mkdtemp(join(tmpdir(), "docsfab-catalog-campaign-")));
  await writeFile(join(campaignDir, ".keep"), "fixture campaign dir\n", { mode: 0o600 });
  const entries = [];
  try {
    for (const workflow of CATALOG_WORKFLOWS) {
      const skip = live ? liveSkipDisposition(workflow) : null;
      if (skip) {
        entries.push({
          id: workflow.id,
          surface: "catalog-workflow",
          role: workflow.role,
          command: live ? `docsfab run ${workflow.id} --json` : `docsfab plan ${workflow.id}`,
          status: "skipped",
          exitCode: null,
          disposition: skip,
        });
        continue;
      }
      const argv = live
        ? liveRunArgv(workflow.id, target.root, target.revision)
        : ["plan", workflow.id];
      const result = await runDocsFab(argv, live, live ? 120_000 : 30_000);
      entries.push({
        id: workflow.id,
        surface: "catalog-workflow",
        role: workflow.role,
        command: live ? `docsfab run ${workflow.id} --json` : `docsfab plan ${workflow.id}`,
        status: "recorded",
        exitCode: result.exitCode,
        disposition: sanitizedDisposition(
          workflow.id,
          result.stdout,
          result.stderr,
          result.exitCode,
        ),
      });
    }
    for (const mode of OPERATOR_MODES) {
      const argv = mode.argv(target.root, target.revision, campaignDir);
      const result = await runDocsFab(argv, live, live ? 180_000 : 120_000);
      entries.push({
        id: mode.id,
        surface: "operator-mode",
        role: "primary",
        command: mode.command,
        status: "recorded",
        exitCode: result.exitCode,
        disposition: sanitizedDisposition(mode.id, result.stdout, result.stderr, result.exitCode),
      });
    }
  } finally {
    await rm(campaignDir, { recursive: true, force: true });
  }
  return entries;
}

function renderMarkdown(scorecard) {
  const rows = scorecard.entries
    .map(
      (entry) =>
        `| ${entry.id} | ${entry.surface} | ${entry.role} | \`${entry.command}\` | ${entry.status} | ${entry.disposition} |`,
    )
    .join("\n");
  return `# Canonical catalog scorecard

- Mode: ${scorecard.mode}
- Live model: ${scorecard.liveModel ? "yes (opt-in, not CI)" : "no"}
- CI required: no
- Generator revision: ${scorecard.generatorRevision}
- Target revision: ${scorecard.targetRevision}
- Generated at: ${scorecard.generatedAt}

| Id | Surface | Role | Command | Status | Disposition |
| --- | --- | --- | --- | --- | --- |
${rows}
`;
}

function assertSanitized(raw) {
  if (LEAK.test(raw)) fail("scorecard leaked a host path or credential material");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (options.live && process.env[LIVE_GATE] !== "1") {
    fail(`live catalog runs require ${LIVE_GATE}=1 and are not CI`);
  }
  if (options.live && !options.repo) {
    fail("--live requires --repo <path>");
  }

  const evidenceDir = await resolveEvidenceDir(options.evidenceDir);
  const target = await resolveTarget(options);
  try {
    const mode = options.live
      ? "live-opt-in"
      : options.executeMode
        ? "offline-execute"
        : "offline-fixture";
    const entries =
      options.executeMode || options.live
        ? await executeEntries(target, options.live)
        : stubEntries();
    const scorecard = {
      schemaVersion: 1,
      kind: "docsfab-catalog-scorecard",
      mode,
      liveModel: Boolean(options.live),
      ciRequired: false,
      generatedAt: new Date().toISOString(),
      generatorRevision: await generatorRevision(),
      targetRevision: target.revision,
      queue: "not-implemented-see-279",
      entries,
    };
    const json = `${JSON.stringify(scorecard, null, 2)}\n`;
    const markdown = renderMarkdown(scorecard);
    assertSanitized(json);
    assertSanitized(markdown);
    const jsonPath = join(evidenceDir, "scorecard.json");
    const mdPath = join(evidenceDir, "scorecard.md");
    await writeFile(jsonPath, json, { mode: 0o600 });
    await writeFile(mdPath, markdown, { mode: 0o600 });
    process.stdout.write(
      `catalog scorecard: ${scorecard.kind} mode=${scorecard.mode} entries=${String(entries.length)} liveModel=${String(scorecard.liveModel)}\n`,
    );
    process.stdout.write(`evidence: ${evidenceDir}\n`);
  } finally {
    if (target.ephemeral) {
      await rm(target.root, { recursive: true, force: true });
    }
  }
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
