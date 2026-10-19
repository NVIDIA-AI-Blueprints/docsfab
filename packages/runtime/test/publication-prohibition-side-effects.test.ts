// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The publication-prohibition refusal through the shipped CLI entry point
 * (`main`) for `docsfab run` and `docsfab do`, with a read-only fake `glab`
 * first on PATH that answers the draft-MR preflight reads. A refused request
 * makes no glab call, no model request, no run record, and no worktree or
 * branch. The controls show the same harness observes each of those when the
 * request is not refused: the run reaches the preflight and the request
 * interpretation, which the scripted model answers with an unreadable reply,
 * so the run stops there with a record.
 */
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ stateDirectory: "", modelRequests: 0 }));

vi.mock("../src/config/runtime-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/runtime-loader.js")>();
  const { validModelConfig } = await import("./helpers.js");
  const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return {
    ...actual,
    loadConfig: () => ({
      projectRoot: runtimeRoot,
      skillCrateDirectory: join(runtimeRoot, "skill-crate"),
      qualityDirectory: join(runtimeRoot, "quality"),
      qualityPackDirectory: join(runtimeRoot, "quality-pack"),
      stateDirectory: host.stateDirectory,
      retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
      model: validModelConfig,
    }),
  };
});

// The interpretation's production port: each call is one model request.
vi.mock("../src/request-intent/interpret-model.js", () => ({
  createRequestIntentModelPort: () => ({
    async call() {
      host.modelRequests += 1;
      return { text: "not a reading", usage: { inputTokens: 3, outputTokens: 2 } };
    },
  }),
}));

import { DeliveryFlagOperatorError } from "../src/cli/delivery-grants.js";
import { main } from "../src/cli/router.js";
import { git, initFixtureRepo } from "./helpers/git.js";

const BASE = "Create docs/cli-reference.md for developers using Sprout from src/sprout.mjs.";
const originalArgv = process.argv;
const roots: string[] = [];

/** Answers only the preflight's reads for docs/sprout; refuses and logs everything else. */
const FAKE_GLAB = String.raw`#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_GLAB_LOG, JSON.stringify(args) + "\n");
function reply(value) {
  process.stdout.write(JSON.stringify(value));
  process.exit(0);
}
if (args[0] === "version") reply("glab 1.0.0 (fake)");
if (args[0] === "auth" && args[1] === "status") process.exit(0);
if (args[0] === "api") {
  const path = args[1] === "--hostname" ? args[3] : args[1];
  if (path === "graphql") reply({ data: { project: { id: "gid://gitlab/Project/4242", fullPath: "docs/sprout" } } });
  if (path === "projects/4242") {
    reply({ id: 4242, path_with_namespace: "docs/sprout", default_branch: "main", permissions: { project_access: { access_level: 30 }, group_access: null } });
  }
  if (path === "projects/4242/repository/branches/main") {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    reply({ name: "main", protected: false, commit: { id: head } });
  }
}
process.stderr.write("fake glab: refused\n");
process.exit(1);
`;

interface Fixture {
  readonly repositoryPath: string;
  readonly glabLog: string;
}

async function temporary(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

async function fixture(): Promise<Fixture> {
  const repositoryPath = join(await temporary("docsfab-prohibition-repo-"), "repo");
  await initFixtureRepo(
    repositoryPath,
    {
      "README.md": "# Sprout\n",
      "src/sprout.mjs": "export function greet(name = 'world') {\n  return `Hello, ${name}`;\n}\n",
      "docs/guide.md": "# Guide\n\nRun sprout greet.\n",
      ".docsfab.json": `${JSON.stringify({
        schemaVersion: 1,
        gitlab: { remote: "origin", defaultBranch: "main" },
        provider: { configuration: "host" },
        storage: { scope: "user-private" },
      })}\n`,
    },
    { branch: "main" },
  );
  await git(repositoryPath, [
    "remote",
    "add",
    "origin",
    "git@gitlab.example.invalid:docs/sprout.git",
  ]);
  const bin = await temporary("docsfab-prohibition-bin-");
  const glabLog = join(bin, "calls.jsonl");
  await writeFile(glabLog, "");
  await writeFile(join(bin, "glab"), FAKE_GLAB);
  await chmod(join(bin, "glab"), 0o755);
  vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
  vi.stubEnv("FAKE_GLAB_LOG", glabLog);
  return { repositoryPath, glabLog };
}

interface Observed {
  readonly error: unknown;
  readonly exitCode: number | string | undefined;
  readonly glabCalls: readonly string[][];
  readonly modelRequests: number;
  readonly fetchCalls: number;
  readonly runRecords: readonly string[];
  readonly worktrees: number;
  readonly branches: readonly string[];
}

/** Run the CLI in process with `args` and report every side effect it left. */
async function cli(repo: Fixture, args: readonly string[]): Promise<Observed> {
  const fetchCalls: string[] = [];
  vi.stubGlobal("fetch", async (request: RequestInfo | URL) => {
    fetchCalls.push(String(request));
    throw new Error("no provider is reachable from this test");
  });
  host.modelRequests = 0;
  process.argv = [originalArgv[0]!, originalArgv[1]!, ...args];
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  let error: unknown;
  try {
    await main();
  } catch (thrown) {
    error = thrown;
  }
  const exitCode = process.exitCode;
  vi.restoreAllMocks();
  const log = await readFile(repo.glabLog, "utf8");
  const worktrees = (await git(repo.repositoryPath, ["worktree", "list", "--porcelain"]))
    .split("\n")
    .filter((line) => line.startsWith("worktree "));
  return {
    error,
    exitCode,
    glabCalls: log
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]),
    modelRequests: host.modelRequests,
    fetchCalls: fetchCalls.length,
    runRecords: (await readdir(host.stateDirectory)).filter((name) => name.endsWith(".json")),
    worktrees: worktrees.length,
    branches: (
      await git(repo.repositoryPath, ["for-each-ref", "--format=%(refname)", "refs/heads"])
    ).split("\n"),
  };
}

function expectRefusedWithoutSideEffects(observed: Observed, label: string): void {
  const { error: _error, exitCode: _exitCode, ...sideEffects } = observed;
  expect(sideEffects, label).toEqual({
    glabCalls: [],
    modelRequests: 0,
    fetchCalls: 0,
    runRecords: [],
    worktrees: 1,
    branches: ["refs/heads/main"],
  });
  expect(observed.error, label).toBeInstanceOf(DeliveryFlagOperatorError);
  expect(observed.error, label).toMatchObject({
    code: "publication-prohibition-conflict",
    nextAction: "Pass --patch-only to retain a local patch without publishing.",
  });
}

beforeEach(async () => {
  host.stateDirectory = await temporary("docsfab-prohibition-state-");
  vi.stubEnv("DOCSFAB_STATE_DIR", host.stateDirectory);
  vi.stubEnv("DOCSFAB_CONFIG_ROOT", await temporary("docsfab-prohibition-config-"));
  // The suite sets PI_OFFLINE=1, which skips the interpretation's model call.
  vi.stubEnv("PI_OFFLINE", "0");
});

afterEach(async () => {
  process.argv = originalArgv;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("a refused publication leaves no trace", () => {
  it.each([
    ["default delivery", []],
    ["--draft-mr", ["--draft-mr"]],
    ["--dry-run", ["--dry-run"]],
  ])(
    "docsfab run refuses with %s before any glab call, model request, or record",
    async (_label, flags) => {
      const repo = await fixture();
      for (const phrase of [
        "Do not publish.",
        "Do not push anything.",
        "Do not open an MR.",
        "Do not\npublish.",
        "**Do not push.**",
        'Use a 3" margin. Do not publish. Add a "Usage" section.',
        'Explain that a " is doubled. Do not publish. Note that " wraps fields.',
        "Cover every option, don't push.",
      ]) {
        const observed = await cli(repo, [
          "run",
          "create-documentation",
          "--repo",
          repo.repositoryPath,
          "--instruction",
          `${BASE} ${phrase}`,
          ...flags,
        ]);
        expectRefusedWithoutSideEffects(observed, `run ${phrase}`);
      }
    },
  );

  it.each([
    ["default delivery", []],
    ["--draft-mr", ["--draft-mr"]],
  ])(
    "docsfab do refuses with %s before any glab call, model request, or record",
    async (_label, flags) => {
      const repo = await fixture();
      for (const phrase of [
        "Do not push anything.",
        "Do not commit or push.",
        "Do not open an MR.",
        "Never\npost anything.",
        "- Skip the MR.",
      ]) {
        const observed = await cli(repo, [
          "do",
          `${BASE} ${phrase}`,
          "--repo",
          repo.repositoryPath,
          ...flags,
        ]);
        expectRefusedWithoutSideEffects(observed, `do ${phrase}`);
      }
    },
  );
});

describe("the harness observes the side effects it asserts are absent", () => {
  it("runs the draft-MR preflight, the interpretation, and saves a record without a prohibition", async () => {
    const repo = await fixture();
    const observed = await cli(repo, [
      "run",
      "create-documentation",
      "--repo",
      repo.repositoryPath,
      "--instruction",
      `${BASE} Cover commands, options, defaults, output examples, and errors.`,
    ]);
    expect(observed.error).toBeUndefined();
    expect(observed.exitCode).toBe(1);
    expect(observed.glabCalls.map((call) => call.slice(0, 2))).toContainEqual(["auth", "status"]);
    expect(observed.glabCalls.at(-1)).toContain("projects/4242/repository/branches/main");
    expect(observed.modelRequests).toBe(1);
    expect(observed.runRecords).toHaveLength(1);
    expect(observed.fetchCalls).toBe(0);
  });

  it("runs --patch-only under a prohibition with no glab call, worktree, or branch", async () => {
    const repo = await fixture();
    for (const command of [
      ["run", "create-documentation", "--instruction", `${BASE} Do not push anything.`],
      ["do", `${BASE} Do not push anything.`],
    ]) {
      const observed = await cli(repo, [...command, "--repo", repo.repositoryPath, "--patch-only"]);
      expect(observed.error, command[0]).toBeUndefined();
      expect(observed.glabCalls, command[0]).toEqual([]);
      expect(observed.modelRequests, command[0]).toBe(1);
      expect(observed.worktrees, command[0]).toBe(1);
      expect(observed.branches, command[0]).toEqual(["refs/heads/main"]);
    }
    expect(await readdir(host.stateDirectory)).toEqual(
      expect.arrayContaining([expect.stringMatching(/\.json$/u)]),
    );
  });
});
