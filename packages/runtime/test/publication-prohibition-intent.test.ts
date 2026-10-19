// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The request interpretation as the second publication-prohibition signal: a
 * reading with a `non-publication` constraint stops a run that would publish
 * before its first step, with a record that keeps the reading and names the
 * stop. The request text here forbids publication in words the phrase guard
 * does not recognize, so only the interpretation can catch it.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const order = vi.hoisted(() => [] as string[]);
const STOP_AT_EXECUTION = "test sentinel: the run reached workflow execution";

vi.mock("../src/cli/first-pass.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/first-pass.js")>();
  return {
    ...actual,
    needsFirstPassKnowledgeForExecution: async () => {
      order.push("first-pass-gate");
      return false;
    },
  };
});

vi.mock("../src/cli/run/execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/run/execution.js")>();
  return {
    ...actual,
    executeWorkflowRun: async () => {
      order.push("execute");
      throw new Error(STOP_AT_EXECUTION);
    },
  };
});

import { handleDoCommand } from "../src/cli/commands/do.js";
import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { runRequestPublishes } from "../src/cli/run/publication-prohibition-stop.js";
import type { CliRunOptions, RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type { RunRecord } from "../src/records/contracts.js";
import type { RequestIntentInterpreterPort } from "../src/request-intent/interpret.js";
import { validModelConfig } from "./helpers.js";
import { git, initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = temporaryRoots();
/** Forbids publication in words the phrase guard does not recognize. */
const INSTRUCTION = "Update docs/a.md to document the new --profile flag. Ship nothing to GitLab.";
const PROHIBITION_QUOTE = "Ship nothing to GitLab";
const NEXT_ACTION = "Pass --patch-only to retain a local patch without publishing.";

beforeEach(() => {
  order.length = 0;
});

afterEach(() => {
  process.exitCode = undefined;
});

function stubConfig(stateDirectory: string): DocsFabConfig {
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

/** The model's reading of INSTRUCTION, with or without its prohibition, for `operation`. */
function reading(operation: "update" | "review", nonPublication: boolean): string {
  return JSON.stringify({
    operation,
    targets: [{ path: "docs/a.md", role: "write", chosenFrom: "named", quote: "docs/a.md" }],
    constraints: nonPublication ? [{ kind: "non-publication", quote: PROHIBITION_QUOTE }] : [],
    authorityPreference: { preference: "unspecified", quote: null },
  });
}

function stubPort(reply: string): RequestIntentInterpreterPort & { calls: number } {
  const port = {
    calls: 0,
    async call() {
      port.calls += 1;
      order.push("interpret");
      return { text: reply, usage: { inputTokens: 3, outputTokens: 2 } };
    },
  };
  return port;
}

async function fixture(): Promise<{
  repositoryPath: string;
  stateDirectory: string;
  head: string;
}> {
  const repositoryPath = join(await roots.create("docsfab-intent-prohibition-"), "repo");
  const head = await initFixtureRepo(
    repositoryPath,
    {
      "README.md": "# Fixture\n",
      "docs/a.md": "# Alpha\n\nThe CLI.\n",
      "docs/b.md": "---\ntitle: Beta\n---\nBody.\n",
      ".docsfab.json": `${JSON.stringify({
        schemaVersion: 1,
        gitlab: { remote: "origin", defaultBranch: "main" },
        provider: { configuration: "host" },
        storage: { scope: "user-private" },
      })}\n`,
    },
    { branch: "main" },
  );
  return {
    repositoryPath,
    stateDirectory: await roots.create("docsfab-intent-prohibition-state-"),
    head,
  };
}

function runRequest(
  repositoryPath: string,
  extra: Partial<RunRequestWithPublishProjection>,
): RunRequestWithPublishProjection {
  return {
    workflow: "update-documentation",
    repositoryPath,
    revision: "HEAD",
    instruction: INSTRUCTION,
    allowWrite: true,
    releaseGate: false,
    verbose: false,
    json: false,
    showScan: false,
    ...extra,
  } as RunRequestWithPublishProjection;
}

/** The draft-MR freshness port, answering with the checkout's own head. */
function freshness(head: string): NonNullable<CliRunOptions["ensurePublicationFreshness"]> {
  return async () => ({ branch: "main", revision: head });
}

async function captured<T>(run: () => Promise<T>): Promise<{ error?: unknown; logs: string[] }> {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message?: unknown) => logs.push(String(message ?? ""));
  console.error = (message?: unknown) => logs.push(String(message ?? ""));
  try {
    await run();
    return { logs };
  } catch (error) {
    return { error, logs };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function savedRecords(stateDirectory: string): Promise<RunRecord[]> {
  const names = (await readdir(stateDirectory)).filter((name) => name.endsWith(".json"));
  return Promise.all(
    names.map(
      async (name) => JSON.parse(await readFile(join(stateDirectory, name), "utf8")) as RunRecord,
    ),
  );
}

/** The NEXT section's command and reason lines from a human footer. */
function nextSection(logs: readonly string[]): string[] {
  const text = logs.join("\n").split("\n");
  const start = text.findIndex((line) => line.trim() === "NEXT");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.findIndex((line, index) => index > start && line.trim() === "");
  return text.slice(start + 1, end < 0 ? undefined : end).map((line) => line.trim());
}

function expectInterpretationStop(record: RunRecord | undefined): void {
  expect(record).toMatchObject({
    status: "failed",
    error: "publication-prohibition-conflict",
    failure: {
      class: "operator-input",
      layer: "workflow",
      code: "publication-prohibition-conflict",
    },
    steps: [],
  });
  expect(record!.requestIntent!.admission.outcome).toBe("admitted");
  expect(record!.requestIntent!.intent!.constraints).toEqual([
    expect.objectContaining({
      kind: "non-publication",
      quote: expect.objectContaining({ text: PROHIBITION_QUOTE }),
    }),
  ]);
}

describe("the interpretation's non-publication reading stops a publishing run", () => {
  it("stops a draft-MR run before its first step with a record that keeps the reading", async () => {
    const { repositoryPath, stateDirectory, head } = await fixture();
    const port = stubPort(reading("update", true));
    const run = await captured(() =>
      executeRunRequest(
        runRequest(repositoryPath, { draftMr: true, revisionPolicy: "target-branch-head" }),
        stubConfig(stateDirectory),
        { requestInterpreter: port, ensurePublicationFreshness: freshness(head) },
      ),
    );
    expect(run.error).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(port.calls).toBe(1);
    expect(order).toEqual(["interpret"]);
    const records = await savedRecords(stateDirectory);
    expect(records).toHaveLength(1);
    expectInterpretationStop(records[0]);
    const next = nextSection(run.logs);
    expect(next[0]).toBe(
      "docsfab run update-documentation --repo '<original target checkout>' --instruction '<repeat the original approved instruction>' --patch-only",
    );
    expect(next[1]).toContain("request interpretation read the request as forbidding publication");
    expect(next[1]).toContain(NEXT_ACTION);
    expect(await git(repositoryPath, ["worktree", "list", "--porcelain"])).not.toContain(
      "\nworktree ",
    );
    expect(await git(repositoryPath, ["for-each-ref", "--format=%(refname)", "refs/heads"])).toBe(
      "refs/heads/main",
    );
  });

  it("emits the stop as a run result whose next steps pass --patch-only", async () => {
    const { repositoryPath, stateDirectory, head } = await fixture();
    const run = await captured(() =>
      executeRunRequest(
        runRequest(repositoryPath, {
          draftMr: true,
          revisionPolicy: "target-branch-head",
          json: true,
        }),
        stubConfig(stateDirectory),
        {
          requestInterpreter: stubPort(reading("update", true)),
          ensurePublicationFreshness: freshness(head),
        },
      ),
    );
    expect(run.error).toBeUndefined();
    const result = JSON.parse(run.logs.join("\n")) as {
      kind: string;
      execution: { exitCode: number; status: string };
      nextSteps: string[];
    };
    expect(result.kind).toBe("docsfab-run-result");
    expect(result.execution).toMatchObject({ exitCode: 1, status: "failed" });
    expect(result.nextSteps[0]).toMatch(/ --patch-only$/u);
    expect(result.nextSteps[1]).toContain(NEXT_ACTION);
  });

  it("shows the stop and the constraint that fired through runs show", async () => {
    const { repositoryPath, stateDirectory, head } = await fixture();
    await captured(() =>
      executeRunRequest(
        runRequest(repositoryPath, { draftMr: true, revisionPolicy: "target-branch-head" }),
        stubConfig(stateDirectory),
        {
          requestInterpreter: stubPort(reading("update", true)),
          ensurePublicationFreshness: freshness(head),
        },
      ),
    );
    process.exitCode = undefined;
    const records = await savedRecords(stateDirectory);
    expect(records).toHaveLength(1);
    const [record] = records;
    const shown = await captured(() =>
      handleRunsCommand(["show", record!.id, "--state-dir", stateDirectory]),
    );
    expect(shown.error).toBeUndefined();
    const lines = shown.logs
      .join("\n")
      .split("\n")
      .map((line) => line.trim());
    expect(lines).toContain("Constraint: non-publication");
    expect(lines).toContain(
      "Failure class: operator-input (layer workflow, code publication-prohibition-conflict).",
    );
  });

  it("stops a do run the table routed, through the same run path", async () => {
    const { repositoryPath, stateDirectory, head } = await fixture();
    const port = stubPort(reading("update", true));
    const run = await captured(() =>
      handleDoCommand([INSTRUCTION, "--repo", repositoryPath], {
        stateDirectory,
        admitCatalogWorkflow: async () => {
          throw new Error("a table hit must not ask the admission model");
        },
        runWorkflow: (request) =>
          executeRunRequest(request, stubConfig(stateDirectory), {
            requestInterpreter: port,
            ensurePublicationFreshness: freshness(head),
          }),
      }),
    );
    expect(run.error).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(order).toEqual(["interpret"]);
    const records = await savedRecords(stateDirectory);
    expect(records).toHaveLength(1);
    expectInterpretationStop(records[0]);
  });

  it("stops a review that would post on an existing merge request", async () => {
    const { repositoryPath, stateDirectory, head } = await fixture();
    const run = await captured(() =>
      executeRunRequest(
        runRequest(repositoryPath, {
          workflow: "review-documentation",
          allowWrite: false,
          commentMr: "88",
        }),
        stubConfig(stateDirectory),
        {
          requestInterpreter: stubPort(reading("review", true)),
          commentExistingMr: {
            mutations: { commits: 0, branches: 0, pushes: 0, mergeRequests: 0 },
            observe: async () => ({
              host: "gitlab.example.test",
              projectId: 17,
              mergeRequestIid: 88,
              sourceBranch: "docs/topic",
              targetBranch: "main",
              headSha: head,
              requestIdentitySha256: "a".repeat(64),
              proofStatus: "current" as const,
            }),
            project: async () => {
              throw new Error("a stopped review must not post");
            },
          },
        },
      ),
    );
    expect(run.error).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(order).toEqual(["interpret"]);
    const [record] = await savedRecords(stateDirectory);
    expect(record).toMatchObject({
      workflow: "review-documentation",
      error: "publication-prohibition-conflict",
    });
  });
});

describe("the interpretation signal refuses only publication", () => {
  it("counts a draft MR, a --comment-mr target, and a bound comment target, each alone", () => {
    const local = runRequest("/tmp/unused-repository", {});
    expect(runRequestPublishes(local)).toBe(false);
    expect(runRequestPublishes({ ...local, draftMr: true })).toBe(true);
    // Before the CLI binds the observed merge request, only the target names it.
    expect(runRequestPublishes({ ...local, commentMr: "88" })).toBe(true);
    const commentMrBinding = {} as NonNullable<RunRequestWithPublishProjection["commentMrBinding"]>;
    expect(runRequestPublishes({ ...local, commentMrBinding })).toBe(true);
  });

  it("runs --patch-only on the same reading", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const run = await captured(() =>
      executeRunRequest(runRequest(repositoryPath, {}), stubConfig(stateDirectory), {
        requestInterpreter: stubPort(reading("update", true)),
      }),
    );
    expect((run.error as Error).message).toBe(STOP_AT_EXECUTION);
    expect(order).toEqual(["interpret", "first-pass-gate", "execute"]);
    expect(await savedRecords(stateDirectory)).toEqual([]);
  });

  it("publishes a draft-MR run whose reading has no prohibition", async () => {
    const { repositoryPath, stateDirectory, head } = await fixture();
    const run = await captured(() =>
      executeRunRequest(
        runRequest(repositoryPath, { draftMr: true, revisionPolicy: "target-branch-head" }),
        stubConfig(stateDirectory),
        {
          requestInterpreter: stubPort(reading("update", false)),
          ensurePublicationFreshness: freshness(head),
        },
      ),
    );
    expect((run.error as Error).message).toBe(STOP_AT_EXECUTION);
    expect(order).toEqual(["interpret", "first-pass-gate", "execute"]);
  });
});
