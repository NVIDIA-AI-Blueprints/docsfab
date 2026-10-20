// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** A selected publication remote must reach real first-run bootstrap. */
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const observed = vi.hoisted(() => [] as Array<{ config: unknown | null; path: string }>);
const STOP_AT_EXECUTION = "test sentinel: reached workflow execution after bootstrap";

vi.mock("../src/cli/first-pass.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/first-pass.js")>();
  // Avoid a separate knowledge-model path; real bootstrap stays in the caller.
  return { ...actual, needsFirstPassKnowledgeForExecution: async () => false };
});

vi.mock("../src/cli/run/execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/run/execution.js")>();
  return {
    ...actual,
    executeWorkflowRun: async (_invocation: unknown, workspace: { path: string }) => {
      const { readFile: readWorkspaceFile } = await import("node:fs/promises");
      const bytes = await readWorkspaceFile(join(workspace.path, ".docsfab.json"), "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      observed.push({ config: bytes === null ? null : JSON.parse(bytes), path: workspace.path });
      throw new Error(STOP_AT_EXECUTION);
    },
  };
});

import { executeRunRequest } from "../src/cli/run-request.js";
import type { CliRunOptions, RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type { RequestIntentInterpreterPort } from "../src/request-intent/interpret.js";
import { validModelConfig } from "./helpers.js";
import { git, initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const instruction = "Update docs/a.md to document the new behavior.";
const publicationInstruction = "Update docs/a.md and .docsfab.json.";
const tracked = {
  schemaVersion: 1,
  gitlab: { remote: "alpha", defaultBranch: "main" },
  provider: { configuration: "host" },
  storage: { scope: "user-private" },
};

beforeEach(() => {
  observed.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

function config(stateDirectory: string): DocsFabConfig {
  const runtimeRoot = resolve(import.meta.dirname, "..");
  return {
    projectRoot: runtimeRoot,
    skillCrateDirectory: join(runtimeRoot, "skill-crate"),
    qualityDirectory: join(runtimeRoot, "quality"),
    qualityPackDirectory: join(runtimeRoot, "quality-pack"),
    stateDirectory,
    retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
    model: validModelConfig,
  };
}

async function fixture(input: { remotes: boolean; trackedConfig?: boolean }) {
  const repositoryPath = join(await roots.create("docsfab-selected-remote-"), "repo");
  const head = await initFixtureRepo(
    repositoryPath,
    {
      "README.md": "# Fixture\n",
      "docs/a.md": "# Alpha\n",
      ...(input.trackedConfig ? { ".docsfab.json": `${JSON.stringify(tracked)}\n` } : {}),
    },
    { branch: "main" },
  );
  if (input.remotes) {
    for (const remote of ["alpha", "beta"]) {
      await git(repositoryPath, [
        "remote",
        "add",
        remote,
        `https://gitlab.com/example/${remote}.git`,
      ]);
      await git(repositoryPath, ["update-ref", `refs/remotes/${remote}/main`, "HEAD"]);
      await git(repositoryPath, [
        "symbolic-ref",
        `refs/remotes/${remote}/HEAD`,
        `refs/remotes/${remote}/main`,
      ]);
    }
  }
  const stateDirectory = await roots.create("docsfab-selected-remote-state-");
  const privateHome = await roots.create("docsfab-selected-remote-home-");
  const shimDirectory = await roots.create("docsfab-selected-remote-shim-");
  const glabLog = join(shimDirectory, "glab.log");
  const glab = join(shimDirectory, "glab");
  await writeFile(
    glab,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${glabLog}"\nif [ "$1" = version ]; then exit 1; fi\nexit 91\n`,
  );
  await chmod(glab, 0o700);
  vi.stubEnv("PATH", `${shimDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}`);
  vi.stubEnv("HOME", privateHome);
  vi.stubEnv("XDG_CONFIG_HOME", privateHome);
  vi.stubEnv("GLAB_CONFIG_DIR", privateHome);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_TERMINAL_PROMPT", "0");
  for (const name of ["GLAB_TOKEN", "GITLAB_TOKEN", "GITLAB_HOST", "GIT_ASKPASS", "SSH_ASKPASS"]) {
    vi.stubEnv(name, undefined);
  }
  return { repositoryPath, stateDirectory, head, glabLog };
}

function request(repositoryPath: string, remoteName?: string): RunRequestWithPublishProjection {
  return {
    workflow: "update-documentation",
    repositoryPath,
    revision: "HEAD",
    instruction,
    allowWrite: true,
    releaseGate: false,
    verbose: false,
    json: false,
    showScan: false,
    ...(remoteName ? { draftMr: true, remoteName, revisionPolicy: "target-branch-head" } : {}),
  } as RunRequestWithPublishProjection;
}

function interpreter(): RequestIntentInterpreterPort {
  return {
    async call() {
      return {
        text: JSON.stringify({
          operation: "update",
          targets: [{ path: "docs/a.md", role: "write", chosenFrom: "named", quote: "docs/a.md" }],
          constraints: [],
          authorityPreference: { preference: "unspecified", quote: null },
        }),
        usage: { inputTokens: 3, outputTokens: 2 },
      };
    },
  };
}

async function run(
  input: Awaited<ReturnType<typeof fixture>>,
  remoteName?: string,
  publish = true,
) {
  const freshnessRemotes: Array<string | undefined> = [];
  const options: CliRunOptions = {
    requestInterpreter: interpreter(),
    ensurePublicationFreshness: async (freshness) => {
      freshnessRemotes.push(freshness.remoteName);
      return { branch: "main", revision: input.head };
    },
  };
  const effective = publish
    ? {
        ...request(input.repositoryPath, remoteName),
        // Explicit config proposal makes bootstrap's selected remote observable
        // in the real prepared workspace before the execution sentinel.
        instruction: publicationInstruction,
        draftMr: true,
        revisionPolicy: "target-branch-head" as const,
      }
    : request(input.repositoryPath);
  const error = await executeRunRequest(effective, config(input.stateDirectory), options).then(
    () => undefined,
    (failure: unknown) => failure,
  );
  const glabCalls = await readFile(input.glabLog, "utf8").catch(
    (failure: NodeJS.ErrnoException) => {
      if (failure.code === "ENOENT") return "";
      throw failure;
    },
  );
  expect(
    glabCalls
      .split("\n")
      .filter(Boolean)
      .every((call) => call === "version"),
  ).toBe(true);
  expect(await git(input.repositoryPath, ["status", "--porcelain"])).toBe("");
  return { error, freshnessRemotes, glabCalls: glabCalls.split("\n").filter(Boolean) };
}

describe("CLI run first-use bootstrap selected remote", () => {
  it("forwards selected beta into real bootstrap before workflow execution", async () => {
    const input = await fixture({ remotes: true });
    const result = await run(input, "beta");
    expect((result.error as Error)?.message).toBe(STOP_AT_EXECUTION);
    expect(result.freshnessRemotes).toEqual(["beta"]);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.config).toMatchObject({
      gitlab: { remote: "beta", defaultBranch: "main" },
    });
    expect(result.glabCalls).toEqual(["version"]);
  });

  it("also honors explicit alpha without a tracking or push-default preference", async () => {
    const input = await fixture({ remotes: true });
    const result = await run(input, "alpha");
    expect((result.error as Error)?.message).toBe(STOP_AT_EXECUTION);
    expect(result.freshnessRemotes).toEqual(["alpha"]);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.config).toMatchObject({
      gitlab: { remote: "alpha", defaultBranch: "main" },
    });
    expect(result.glabCalls).toEqual(["version"]);
  });

  it("keeps omitted publication selection an honest ambiguity", async () => {
    const input = await fixture({ remotes: true });
    const result = await run(input);
    expect((result.error as Error)?.message).toContain("More than one GitLab remote was found");
    expect(observed).toHaveLength(0);
  });

  it("retains remote-free local writes with two remotes and with zero remotes", async () => {
    for (const remotes of [true, false]) {
      observed.length = 0;
      const input = await fixture({ remotes });
      const result = await run(input, undefined, false);
      expect((result.error as Error)?.message).toBe(STOP_AT_EXECUTION);
      expect(result.freshnessRemotes).toEqual([]);
      expect(observed).toHaveLength(1);
      expect(observed[0]?.config).toBeNull();
      expect(result.glabCalls).toEqual([]);
      vi.unstubAllEnvs();
    }
  });

  it("keeps a committed project config authoritative over selected beta", async () => {
    const input = await fixture({ remotes: true, trackedConfig: true });
    const result = await run(input, "beta");
    expect((result.error as Error)?.message).toBe(STOP_AT_EXECUTION);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.config).toEqual(tracked);
    expect(result.glabCalls).toEqual([]);
  });
});
