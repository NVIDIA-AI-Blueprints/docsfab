#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Installed-CLI proof for date-scoped merged-MR UPDATE.
 *
 * `--mode live` invokes the installed `docsfab run update-documentation` shape
 * with the reproduction instruction and authentic read-only GitLab access.
 * Injected MR lists and hand-built `--reader-source` bindings are forbidden.
 *
 * If glab, authentication, or an approved same-project fixture is unavailable,
 * the script writes `status: "pending"` and exits 0. Mocks do not satisfy live.
 * Credentials never enter the results file.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const runtimeRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPRODUCTION_INSTRUCTION =
  "Review the MRs merged into main on September 14, 2026, using America/Los_Angeles time. Collect the related code changes and existing documentation. Identify changes affecting end users, including commands, configuration, defaults, installation, workflows, and observable behavior. Update only the affected user documentation, preserving unrelated content. Skip internal changes with no user impact. Report which MRs require documentation changes, what you updated, and any evidence gaps. If merge records or diffs are unavailable, report that limitation rather than claiming complete coverage.";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function redact(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/glpat-[A-Za-z0-9_-]+/gu, "[redacted-glpat]")
    .replace(/(?:Bearer|token|password)\s+\S+/giu, "[redacted-secret]");
}

function gitlabHostFromRemote(url) {
  const trimmed = String(url).trim();
  const scp = trimmed.match(/^git@([^:]+):/u);
  if (scp) return scp[1];
  try {
    return new URL(trimmed.replace(/^ssh:\/\//u, "https://")).hostname || null;
  } catch {
    return null;
  }
}

function combinedProcessText(result) {
  return `${result?.stdout ?? ""}\n${result?.stderr ?? result?.message ?? ""}`;
}

async function originHost(repoPath) {
  try {
    const remote = (
      await execute("git", ["remote", "get-url", "origin"], {
        cwd: repoPath,
        timeout: 10_000,
      })
    ).stdout.trim();
    return gitlabHostFromRemote(remote);
  } catch {
    return null;
  }
}

async function writeResults(path, body) {
  await mkdir(dirname(path), { recursive: true });
  const payload = {
    schemaVersion: 1,
    kind: "docsfab-merged-mr-update-live-proof",
    recordedAt: new Date().toISOString(),
    instruction: REPRODUCTION_INSTRUCTION,
    patchOnly: true,
    ...body,
  };
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function parseJsonObject(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  try {
    const value = JSON.parse(trimmed);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const value = JSON.parse(trimmed.slice(start, end + 1));
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }
}

function stepById(record, id) {
  return (record?.steps ?? []).find((step) => step?.id === id);
}

function selectedMrIids(record) {
  const iids = new Set();
  for (const match of JSON.stringify(record ?? {}).matchAll(/\bMR !(\d+)\b/gu)) {
    iids.add(Number(match[1]));
  }
  return [...iids].sort((left, right) => left - right);
}

async function checkoutDirty(repoPath) {
  const status = (
    await execute("git", ["status", "--porcelain"], {
      cwd: repoPath,
      timeout: 10_000,
    })
  ).stdout;
  return status.trim().length > 0;
}

function evaluateLiveProof({ record, dirty, command }) {
  const forbidden = command.some(
    (part) => String(part).includes("--reader-source") || /^[0-9a-f]{40}$/iu.test(String(part)),
  );
  const plan = stepById(record, "plan-documentation");
  const write = stepById(record, "write-documentation");
  const verify = stepById(record, "verify-technical-accuracy");
  const lint = stepById(record, "lint-documentation");
  const iids = selectedMrIids(record);
  const sourceBound = Boolean(plan?.planBinding?.sourceBindingSha256) || iids.length > 0;
  const wrote =
    write?.status === "succeeded" &&
    Array.isArray(record?.changes?.files) &&
    record.changes.files.length > 0;
  const noChangePath = write === undefined && plan?.status === "succeeded" && verify !== undefined;
  const reasons = [];
  if (forbidden) reasons.push("Proof command included pasted SHAs or --reader-source.");
  if (dirty) reasons.push("Target checkout was left dirty.");
  if (plan?.status !== "succeeded") reasons.push("plan-documentation did not succeed.");
  if (/missing-source/iu.test(String(plan?.error ?? record?.error ?? ""))) {
    reasons.push("Run stopped at missing-source during plan.");
  }
  if (!sourceBound) {
    reasons.push("No merged-MR identities or sourceBindingSha256 were retained.");
  }
  if (!wrote && !noChangePath) {
    reasons.push("Neither a documentation patch nor a no-change assessment path was produced.");
  }
  return {
    ok: reasons.length === 0,
    reasons,
    selectedMergeRequestIids: iids,
    planStatus: plan?.status ?? null,
    writeStatus: write?.status ?? null,
    lintStatus: lint?.status ?? null,
    verifyStatus: verify?.status ?? null,
    sourceBound,
    patchPath: record?.changes?.patch?.artifactPath ?? null,
    changedFiles: record?.changes?.files ?? [],
    runId: record?.id ?? null,
    repositoryRevision: record?.repository?.revision ?? null,
    runError: record?.error ?? null,
  };
}

async function pending(resultsPath, reason) {
  await writeResults(resultsPath, {
    status: "pending",
    pendingReason: reason,
    selectedMergeRequestIids: null,
    excludedMergeRequestIids: null,
    checkoutDirty: false,
    liveGitLabAccess: false,
  });
  console.log(`Merged-MR UPDATE live proof pending: ${reason}`);
}

const mode = argValue("--mode") ?? "live";
const resultsPath = argValue("--results");
if (mode !== "live") {
  throw new Error("verify-merged-mr-update.mjs accepts only --mode live.");
}
if (!resultsPath || resultsPath.startsWith("-")) {
  throw new Error("verify-merged-mr-update.mjs requires --results <json-path>.");
}

const repo = argValue("--repo") ?? process.env.DOCSFAB_MERGED_MR_UPDATE_REPO;
if (!repo) {
  await pending(
    resultsPath,
    "No approved same-project GitLab fixture checkout was supplied (--repo or DOCSFAB_MERGED_MR_UPDATE_REPO).",
  );
  process.exit(0);
}

let glabVersion;
try {
  glabVersion = (await execute("glab", ["version"], { timeout: 10_000 })).stdout.trim();
} catch {
  await pending(resultsPath, "glab is not installed on this host.");
  process.exit(0);
}

const host = await originHost(repo);
const authArgs = host ? ["auth", "status", "--hostname", host] : ["auth", "status"];
let authCombined = "";
try {
  const status = await execute("glab", authArgs, {
    timeout: 15_000,
    cwd: repo,
    env: process.env,
  });
  authCombined = combinedProcessText(status);
} catch (error) {
  authCombined = combinedProcessText(error);
}
if (!/Logged in to/iu.test(authCombined)) {
  await pending(
    resultsPath,
    host
      ? `glab is not authenticated for origin host ${host}.`
      : "glab is installed but not authenticated for a GitLab host.",
  );
  process.exit(0);
}

let cli = "docsfab";
try {
  await execute(cli, ["--help"], { timeout: 15_000 });
} catch {
  cli = resolve(runtimeRoot, "dist", "cli.js");
  try {
    await execute(process.execPath, [cli, "--help"], { timeout: 15_000 });
  } catch {
    await pending(
      resultsPath,
      "An installed docsfab CLI was not found. Pack and install the runtime, then retry.",
    );
    process.exit(0);
  }
}

const args = [
  "run",
  "update-documentation",
  "--repo",
  repo,
  "--patch-only",
  "--instruction",
  REPRODUCTION_INSTRUCTION,
  "--json",
];
const invocation = cli === "docsfab" ? ["docsfab", ...args] : [process.execPath, cli, ...args];
let stdout = "";
let stderr = "";
let exitCode = 0;
try {
  const result = await execute(invocation[0], invocation.slice(1), {
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
    cwd: repo,
    env: process.env,
  });
  stdout = result.stdout;
  stderr = result.stderr ?? "";
} catch (error) {
  exitCode = typeof error?.code === "number" ? error.code : 1;
  stdout = String(error?.stdout ?? "");
  stderr = String(error?.stderr ?? error?.message ?? "");
}

const runResult = parseJsonObject(stdout) ?? parseJsonObject(stderr);
const progressRunId = `${stdout}\n${stderr}`.match(/\brun ([0-9a-f-]{36}):/u)?.[1];
const recordPath =
  (typeof runResult?.execution?.recordPath === "string" && runResult.execution.recordPath) ||
  (progressRunId
    ? resolve(`${process.env.HOME ?? ""}/.config/docsfab/.docsfab/runs/${progressRunId}.json`)
    : "");
let record = null;
if (recordPath) {
  try {
    record = parseJsonObject(await readFile(recordPath, "utf8"));
  } catch {
    record = null;
  }
}
const dirty = await checkoutDirty(repo);
const proof = evaluateLiveProof({
  record,
  dirty,
  command: invocation,
});
const independentVerifyFailed =
  proof.verifyStatus === "failed" &&
  /malformed assessment envelope/iu.test(String(proof.runError ?? ""));
await writeResults(resultsPath, {
  status: proof.ok ? "ran" : "failed",
  pendingReason: null,
  liveGitLabAccess: true,
  glabVersion: redact(glabVersion),
  command: invocation.map(redact),
  exitCode,
  checkoutDirty: dirty,
  selectedMergeRequestIids: proof.selectedMergeRequestIids,
  excludedMergeRequestIids: null,
  runId: proof.runId,
  repositoryRevision: proof.repositoryRevision,
  planStatus: proof.planStatus,
  writeStatus: proof.writeStatus,
  lintStatus: proof.lintStatus,
  verifyStatus: proof.verifyStatus,
  sourceBound: proof.sourceBound,
  patchPath: proof.patchPath,
  changedFiles: proof.changedFiles,
  independentVerifyFailed,
  proofErrors: proof.reasons,
  runError: proof.runError,
  stdout: redact(stdout).slice(0, 32_000),
  stderr: redact(stderr).slice(0, 32_000),
  note: "Selected MR IDs, revision, patch path, and checkout dirtiness are copied from the run record and git status. This script does not invent them. Independent verify-technical-accuracy envelope failures are recorded and do not undo a completed instruction-only discovery/write proof.",
});
process.exit(proof.ok ? 0 : 1);
