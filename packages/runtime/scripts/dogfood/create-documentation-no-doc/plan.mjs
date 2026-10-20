// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Throwaway-fixture helpers for the live create-documentation dogfood.
 * Does not call a model. Credentials never belong in argv, logs, or records.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { noDocFixturePath } from "./fixture-source.mjs";

const execute = promisify(execFile);

export const CREATE_DOCUMENTATION_INSTRUCTION =
  "Create a Getting Started page at docs/get-started.md. Use only facts from package.json: the package name and the docs:check script. Do not invent APIs, architecture, or deployment.";

/** The template picks no model, so a live run needs all four fields set. */
export const RUNTIME_ENV_REMEDIATION =
  "copy packages/runtime/.env.example to packages/runtime/.env and set MODEL_PROVIDER, MODEL_BASE_URL, MODEL_ID, and MODEL_API_KEY.";

/**
 * Copies the gitignored runtime `.env` into an existing scratch config root as
 * an owner-only file. Only an absent `.env` gets the template remediation; any
 * other copy failure keeps its own cause.
 */
export async function provisionRuntimeEnv(runtimeRoot, configRoot) {
  const source = join(runtimeRoot, ".env");
  if (!existsSync(source)) {
    throw new Error(`create-documentation no-doc dogfood failed: ${RUNTIME_ENV_REMEDIATION}`);
  }
  const target = join(configRoot, ".env");
  await copyFile(source, target);
  await chmod(target, 0o600);
  return target;
}

export const CRATE_STEPS = Object.freeze([
  "plan-documentation",
  "write-documentation",
  "lint-documentation",
  "verify-technical-accuracy",
  "review-documentation",
  "evaluate-document-quality",
]);

const SHA256 = /^[a-f0-9]{64}$/u;
const SECRET_PATTERN =
  /nvapi-[A-Za-z0-9_-]+|ihub_api_[A-Za-z0-9_-]+|glpat-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+/gu;

export function runtimeRootFromHere(here = dirname(fileURLToPath(import.meta.url))) {
  return resolve(here, "../../..");
}

export function factoryRootFromRuntime(runtimeRoot) {
  return resolve(runtimeRoot, "../..");
}

export { noDocFixturePath } from "./fixture-source.mjs";

export function launcherPath(runtimeRoot) {
  return join(runtimeRoot, "dist/launcher.js");
}

export function redactSecrets(text) {
  return String(text).replace(SECRET_PATTERN, "[redacted]");
}

export function initPreviewArgv(repositoryPath) {
  return ["init", "--repo", repositoryPath, "--non-interactive", "--json"];
}

export function initApplyArgv(repositoryPath, planSha256) {
  if (!SHA256.test(planSha256)) {
    throw new Error("init apply requires one lowercase SHA-256 digest.");
  }
  return [
    "init",
    "--repo",
    repositoryPath,
    "--non-interactive",
    "--apply",
    "--approve-plan-sha256",
    planSha256,
    "--json",
  ];
}

export function createDocumentationArgv(repositoryPath) {
  return [
    "run",
    "create-documentation",
    "--repo",
    repositoryPath,
    "--allow-write",
    "--instruction",
    CREATE_DOCUMENTATION_INSTRUCTION,
    "--json",
  ];
}

export function extractInitPlanSha256(stdout) {
  const plan = parseJsonObject(stdout, "init preview");
  if (plan.kind !== "docsfab-init-plan" || !SHA256.test(String(plan.sha256 ?? ""))) {
    throw new Error("init preview JSON did not include a DocsFab plan digest.");
  }
  return plan.sha256;
}

export function extractRunResult(stdout) {
  const result = parseJsonObject(stdout, "create-documentation run");
  if (result.kind !== "docsfab-run-result") {
    throw new Error("create-documentation JSON was not a DocsFab run result.");
  }
  const runId = result.execution?.runId;
  const recordPath = result.execution?.recordPath;
  const exitCode = result.execution?.exitCode;
  if (typeof runId !== "string" || typeof recordPath !== "string") {
    throw new Error("create-documentation JSON did not include runId and recordPath.");
  }
  return { runId, recordPath, exitCode };
}

export function crateStepIds(record) {
  if (!record || !Array.isArray(record.steps)) {
    throw new Error("Run record is missing steps.");
  }
  return record.steps.map((step) => step.id);
}

export function crateStepStatuses(record) {
  return crateStepIds(record).map((id, index) => ({
    id,
    status: record.steps[index]?.status ?? "unknown",
  }));
}

export function assertCrateSteps(record) {
  const ids = crateStepIds(record);
  const missing = CRATE_STEPS.filter((id) => !ids.includes(id));
  if (missing.length > 0) {
    throw new Error(`Run record is missing crate steps: ${missing.join(", ")}.`);
  }
  return ids;
}

export function assertNotFactoryPath(repositoryPath, factoryRoot) {
  const repo = resolve(repositoryPath);
  const factory = resolve(factoryRoot);
  if (repo === factory || repo.startsWith(`${factory}/`)) {
    throw new Error("Dogfood target must be a throwaway copy, not this factory checkout.");
  }
}

export function parseCliArgs(argv) {
  const flags = new Set();
  let remoteUrl;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--live" || argument === "--dry-run" || argument === "--keep") {
      if (flags.has(argument)) throw new Error(`Duplicated option: ${argument}`);
      flags.add(argument);
      continue;
    }
    if (argument === "--remote-url") {
      if (remoteUrl !== undefined) throw new Error("Duplicated option: --remote-url");
      const value = argv[index + 1];
      // A following option is not a URL; git would read it as one of its own flags.
      // The value is trimmed before use, so the check reads it trimmed too.
      if (value === undefined || value.trim().startsWith("-")) {
        throw new Error("--remote-url needs one Git remote URL.");
      }
      remoteUrl = value;
      index += 1;
      continue;
    }
    if (argument === "--canon-snapshot") {
      throw new Error("#154 does not pass --canon-snapshot.");
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  if (flags.has("--live") && flags.has("--dry-run")) {
    throw new Error("Choose --live or --dry-run, not both.");
  }
  return {
    live: flags.has("--live"),
    keep: flags.has("--keep"),
    ...(remoteUrl === undefined ? {} : { remoteUrl }),
  };
}

export async function copyNoDocFixture(runtimeRoot, destination) {
  await mkdir(destination, { recursive: true });
  await cp(noDocFixturePath(runtimeRoot), destination, { recursive: true });
}

/** `remoteUrl` null leaves the throwaway repository without a remote, as a dry run allows. */
export async function initializeThrowawayGit(repositoryPath, remoteUrl) {
  await execute("git", ["init", "-q", "-b", "main"], { cwd: repositoryPath });
  await execute("git", ["config", "user.email", "dogfood@example.test"], { cwd: repositoryPath });
  await execute("git", ["config", "user.name", "DocsFab dogfood"], { cwd: repositoryPath });
  await execute("git", ["add", "."], { cwd: repositoryPath });
  await execute("git", ["commit", "-q", "-m", "no-doc fixture"], { cwd: repositoryPath });
  if (remoteUrl !== null) {
    await execute("git", ["remote", "add", "origin", remoteUrl], { cwd: repositoryPath });
  }
}

export function sanitizeOriginUrl(url, label = "Factory origin") {
  const trimmed = String(url ?? "").trim();
  if (!trimmed) {
    throw new Error(`${label} must be one Git remote URL.`);
  }
  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(`${label} must be one Git remote URL.`);
    }
    parsed.username = "";
    parsed.password = "";
    const sanitized = `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
    if (sanitized.includes("@")) {
      throw new Error(`${label} must be one uncredentialed Git remote URL.`);
    }
    return sanitized;
  }
  if (trimmed.includes("://") && trimmed.includes("@")) {
    throw new Error(`${label} must be one uncredentialed Git remote URL.`);
  }
  return trimmed;
}

export async function readFactoryOriginUrl(factoryRoot) {
  const { stdout } = await execute("git", ["remote", "get-url", "origin"], { cwd: factoryRoot });
  return sanitizeOriginUrl(stdout);
}

/** Refuses a --remote-url that carries credentials rather than stripping them. */
export function requireUncredentialedRemoteUrl(url) {
  const trimmed = String(url ?? "").trim();
  const parsed = /^https?:\/\//u.test(trimmed) && URL.canParse(trimmed) ? new URL(trimmed) : null;
  if (parsed && (parsed.username || parsed.password)) {
    throw new Error("--remote-url must be one uncredentialed Git remote URL.");
  }
  return sanitizeOriginUrl(trimmed, "--remote-url");
}

export const REMOTE_REQUIRED_CODE = "dogfood-no-doc-remote-required";

export const REMOTE_REQUIRED_REMEDIATION =
  "pass --remote-url with an uncredentialed GitLab project URL, or run from a checkout whose origin remote is one. docsfab init on the throwaway repository needs a GitLab remote.";

/**
 * The remote the throwaway repository gets: --remote-url, else this checkout's
 * origin, else none. A checkout without an origin remote, such as the public
 * export or a fresh clone of it, is a supported shape for a dry run.
 */
export async function resolveThrowawayRemote(factoryRoot, remoteUrl) {
  if (remoteUrl !== undefined) {
    return { source: "argument", url: requireUncredentialedRemoteUrl(remoteUrl) };
  }
  // Listing, not a failed get-url, decides absence: any other git failure still throws.
  const { stdout } = await execute("git", ["remote"], { cwd: factoryRoot });
  if (!stdout.split(/\r?\n/u).includes("origin")) return { source: "none", url: null };
  return { source: "factory-origin", url: await readFactoryOriginUrl(factoryRoot) };
}

/** A live run applies init to the throwaway repository, which needs a remote. */
export function requireLiveRemote(remote) {
  if (remote.url === null) {
    throw new Error(
      `create-documentation no-doc dogfood failed: ${REMOTE_REQUIRED_CODE}: ${REMOTE_REQUIRED_REMEDIATION}`,
    );
  }
  return remote.url;
}

/** The dry-run report of the remote: its source, never the URL. */
export function remoteReport(remote) {
  if (remote.url === null) {
    return {
      source: "none",
      liveRefusal: REMOTE_REQUIRED_CODE,
      remediation: REMOTE_REQUIRED_REMEDIATION,
    };
  }
  return { source: remote.source };
}

export const LAUNCHER_MAX_BUFFER_LIMIT = "dogfood.noDocLauncherMaxBufferBytes";

/**
 * Reads one bound from the generated catalog mirror of this checkout. An absent
 * or unparsable mirror, or an entry that is not a positive byte count, refuses.
 */
export async function readCatalogLimit(factoryRoot, name) {
  let catalog;
  try {
    catalog = JSON.parse(await readFile(join(factoryRoot, "config/limits.catalog.json"), "utf8"));
  } catch (error) {
    // Only an absent or corrupt mirror is fixed by regenerating it; other read errors keep their cause.
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    throw new Error(
      "config/limits.catalog.json is missing or unreadable; run `npm run generate:limits` from packages/runtime.",
    );
  }
  const entry = catalog?.limits?.[name];
  if (
    !Number.isSafeInteger(entry?.value) ||
    entry.value <= 0 ||
    typeof entry.refusal !== "string"
  ) {
    throw new Error(
      `${name} is not a registered byte bound in config/limits.catalog.json; declare it in config/limits/dogfood.yaml and run \`npm run generate:limits\` from packages/runtime.`,
    );
  }
  return { name, ...entry };
}

/**
 * Runs one command, capturing each output stream up to `bound.value` bytes.
 * Returns the exit status of a child that exited; output past the bound refuses
 * with the bound's code, and a spawn failure or a signal keeps its own cause.
 */
export async function captureBounded(command, argv, options, bound) {
  return execute(command, argv, { ...options, maxBuffer: bound.value }).then(
    ({ stdout, stderr }) => ({ stdout, stderr, code: 0 }),
    (error) => {
      // Node killed the child and truncated the stream, so there is no exit status to report.
      if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        throw new Error(
          `${bound.refusal}: ${error.message}; exceeded ${bound.name} = ${bound.value} ${bound.unit}. ${bound.remediation}`,
        );
      }
      // Only an exited child has a numeric code; a spawn failure or signal never produced one.
      if (typeof error?.code !== "number") throw error;
      return { stdout: error.stdout, stderr: error.stderr, code: error.code };
    },
  );
}

export async function factoryInitWritePorcelain(factoryRoot) {
  const { stdout } = await execute(
    "git",
    ["status", "--porcelain", "--", ".docsfab.json", ".docsfab", "docs"],
    { cwd: factoryRoot },
  );
  return stdout;
}

function parseJsonObject(text, label) {
  const trimmed = redactSecrets(text).trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`${label} did not print JSON.`);
  let parsed;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    throw new Error(`${label} JSON could not be parsed.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} JSON was not an object.`);
  }
  return parsed;
}
