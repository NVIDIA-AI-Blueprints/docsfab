// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The request interpretation at its shipped call site (#1825): order before
 * first-pass binding, port precedence and the offline predicate, the not-run
 * cases, every stop arm through `executeRunRequest`, the write-grant order,
 * the recorded field, `runs show` INTENT, and the publication gate.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const order = vi.hoisted(() => [] as string[]);
const capture = vi.hoisted(() => ({ intercept: true, invocations: [] as unknown[] }));
const production = vi.hoisted(() => ({
  port: undefined as
    | undefined
    | import("../src/request-intent/interpret.js").RequestIntentInterpreterPort,
  created: 0,
}));
const STOP_AT_EXECUTION = "test sentinel: the run reached workflow execution";

vi.mock("../src/cli/first-pass.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/first-pass.js")>();
  return {
    ...actual,
    bindFirstRunProposalScope: async (
      ...args: Parameters<typeof actual.bindFirstRunProposalScope>
    ) => {
      order.push("proposal-scope");
      return actual.bindFirstRunProposalScope(...args);
    },
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
    executeWorkflowRun: async (...args: Parameters<typeof actual.executeWorkflowRun>) => {
      if (!capture.intercept) return actual.executeWorkflowRun(...args);
      order.push("execute");
      capture.invocations.push(args[0]);
      throw new Error(STOP_AT_EXECUTION);
    },
  };
});

vi.mock("../src/request-intent/interpret-model.js", () => ({
  createRequestIntentModelPort: () => {
    production.created += 1;
    if (!production.port) throw new Error("this test builds no production port");
    return production.port;
  },
}));

import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { handleDoCommand } from "../src/cli/commands/do.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import {
  requestInterpretationStep,
  type RequestInterpretationStep,
} from "../src/cli/run/request-intent-stop.js";
import type { CliRunInvocation, RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import {
  decodeSuccessfulPublicationRunRecord,
  PublicationRunRecordDecodeError,
} from "../src/delivery/run-record.js";
import { WORKFLOW_CANCELLED } from "../src/execution/cancellation.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import { runBoundedWorkflow } from "../src/live-agent/host.js";
import type { RunRecord } from "../src/records/contracts.js";
import { RequestIntentContractError } from "../src/request-intent/kit.js";
import {
  interpretRequest,
  RequestIntentModelUnavailableError,
  type RequestIntentInterpreterCall,
  type RequestIntentInterpreterPort,
} from "../src/request-intent/interpret.js";
import { resolveRequestIntentLimits } from "../src/request-intent/limits.js";
import { createQueuedRunRecord } from "../src/workflow-execution/runner-admission.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { validModelConfig } from "./helpers.js";
import { git, initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = temporaryRoots();
const INSTRUCTION = "Update docs/a.md to document the new --profile flag.";
const QUESTION = {
  question: "Which flag should docs/a.md document?",
  options: ["--profile", "--config"],
  recommendedDefault: "--profile",
  consequence: "The page documents --profile only.",
};
const PI_OFFLINE = process.env.PI_OFFLINE;

beforeEach(() => {
  order.length = 0;
  capture.intercept = true;
  capture.invocations.length = 0;
  production.port = undefined;
  production.created = 0;
});

afterEach(() => {
  process.exitCode = undefined;
  if (PI_OFFLINE === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = PI_OFFLINE;
  delete process.env.DOCSFAB_REQUEST_INTENT_INTERPRETATION_TIMEOUT_MS;
});

function stubConfig(stateDirectory: string, maxRetries = 0): DocsFabConfig {
  return {
    projectRoot: runtimeRoot,
    skillCrateDirectory: join(runtimeRoot, "skill-crate"),
    qualityDirectory: join(runtimeRoot, "quality"),
    qualityPackDirectory: join(runtimeRoot, "quality-pack"),
    stateDirectory,
    retryPolicy: { maxRetries, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
    model: validModelConfig,
  };
}

function proposal(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    operation: "update",
    targets: [{ path: "docs/a.md", role: "write", chosenFrom: "named", quote: "docs/a.md" }],
    authorityPreference: { preference: "unspecified", quote: null },
    ...extra,
  });
}

/**
 * A request naming a page the fixture lacks: the host asks
 * request-intent-target-absent, a question that still stops the run. The
 * model's own question is an advisory the run goes on with.
 */
const ABSENT_INSTRUCTION = "Update docs/missing.md to document the new --profile flag.";
const ABSENT_TARGET = {
  path: "docs/missing.md",
  role: "write",
  chosenFrom: "named",
  quote: "docs/missing.md",
};
const ABSENT_QUESTION = (operation: string) =>
  `The request asks to ${operation} docs/missing.md, which does not exist. What should happen?`;

/** The same reading for a run whose workflow declares review. */
function reviewProposal(extra: Record<string, unknown> = {}): string {
  return proposal({ operation: "review", ...extra });
}

/** The proposal each workflow's declared operation admits in the fixture. */
function proposalFor(workflow: RunRequestWithPublishProjection["workflow"]): string {
  switch (workflow) {
    case "create-documentation":
      return proposal({
        operation: "create",
        targets: [
          {
            path: "docs/new.md",
            role: "write",
            chosenFrom: "proposed-new",
            quote: "document the new --profile flag",
          },
        ],
      });
    case "restructure-documentation":
      return proposal({ operation: "restructure" });
    case "review-documentation":
      return reviewProposal();
    default:
      return proposal();
  }
}

function stubPort(replies: readonly (string | Error)[]): RequestIntentInterpreterPort & {
  readonly calls: RequestIntentInterpreterCall[];
} {
  const calls: RequestIntentInterpreterCall[] = [];
  return {
    calls,
    async call(request) {
      calls.push(request);
      order.push("interpret");
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
      if (reply instanceof Error) throw reply;
      return { text: reply, usage: { inputTokens: 3, outputTokens: 2 } };
    },
  };
}

async function fixture(): Promise<{ repositoryPath: string; stateDirectory: string }> {
  const root = await roots.create("docsfab-intent-run-");
  const repositoryPath = join(root, "repo");
  await initFixtureRepo(repositoryPath, {
    "README.md": "# Fixture\n",
    "docs/a.md": "# Alpha\n\nThe CLI.\n",
    "docs/b.md": "---\ntitle: Beta\n---\nBody.\n",
    ".docsfab.json": `${JSON.stringify({
      schemaVersion: 1,
      gitlab: { remote: "origin", defaultBranch: "main" },
      provider: { configuration: "host" },
      storage: { scope: "user-private" },
    })}\n`,
  });
  return { repositoryPath, stateDirectory: await roots.create("docsfab-intent-state-") };
}

/** The pilot shape: tracked reStructuredText under its declared documentation root. */
async function tensorrtFixture(unrelatedMarkdown: boolean) {
  const root = await roots.create("docsfab-intent-tensorrt-");
  const repositoryPath = join(root, "repo");
  await initFixtureRepo(repositoryPath, {
    "README.md": "# TensorRT fixture\n",
    "documentation/tensorrt/getting-started/index.rst": "Getting started\n===============\n",
    "documentation/tensorrt/11.4.0/c-api/index.rst": "C API\n=====\n",
    ...(unrelatedMarkdown ? { "documentation/other-product.md": "# Other product\n" } : {}),
    ".docsfab.json": `${JSON.stringify({
      schemaVersion: 1,
      gitlab: { remote: "origin", defaultBranch: "main" },
      provider: { configuration: "host" },
      storage: { scope: "user-private" },
      documentationRoots: ["documentation"],
    })}\n`,
  });
  return { repositoryPath, stateDirectory: await roots.create("docsfab-intent-state-") };
}

function runRequest(
  repositoryPath: string,
  workflow: RunRequestWithPublishProjection["workflow"],
  extra: Partial<RunRequestWithPublishProjection> = {},
): RunRequestWithPublishProjection {
  return {
    workflow,
    repositoryPath,
    revision: "HEAD",
    instruction: INSTRUCTION,
    allowWrite: false,
    releaseGate: false,
    verbose: false,
    json: false,
    showScan: false,
    patchOnly: true,
    ...extra,
  } as RunRequestWithPublishProjection;
}

async function captured<T>(run: () => Promise<T>): Promise<{
  result?: T;
  error?: unknown;
  logs: string[];
}> {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message?: unknown) => logs.push(String(message ?? ""));
  console.error = (message?: unknown) => logs.push(String(message ?? ""));
  try {
    return { result: await run(), logs };
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

function capturedRequest(): RunRequestWithPublishProjection {
  expect(capture.invocations).toHaveLength(1);
  return (capture.invocations[0] as CliRunInvocation).request;
}

/** The NEXT section's command and reason lines from a human footer. */
function nextSection(logs: readonly string[]): string[] {
  const text = logs.join("\n").split("\n");
  const start = text.findIndex((line) => line.trim() === "NEXT");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.findIndex((line, index) => index > start && line.trim() === "");
  return text.slice(start + 1, end).map((line) => line.trim());
}

describe("interpretation order and port precedence (row 1)", () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const)(
    "admits the pilot's absent named Markdown create target with unrelated Markdown=%s and quoted path=%s",
    async (unrelatedMarkdown, quotedPath) => {
      const { repositoryPath, stateDirectory } = await tensorrtFixture(unrelatedMarkdown);
      const path = "documentation/tensorrt/getting-started/python-environment-prerequisites.md";
      const instruction = quotedPath ? `Create \"${path}\"` : `Create ${path}`;
      const port = stubPort([
        JSON.stringify({
          operation: "create",
          targets: [{ path, role: "write", chosenFrom: "named", quote: path }],
          authorityPreference: { preference: "unspecified", quote: null },
        }),
      ]);
      const run = await captured(() =>
        executeRunRequest(
          runRequest(repositoryPath, "create-documentation", { allowWrite: true, instruction }),
          stubConfig(stateDirectory),
          { requestInterpreter: port },
        ),
      );
      expect((run.error as Error).message).toBe(STOP_AT_EXECUTION);
      expect(port.calls).toHaveLength(1);
      expect(port.calls[0]!.prompt).toContain(`Operator request, verbatim:\n${instruction}`);
      expect(port.calls[0]!.prompt).toContain("Documentation roots a new page must sit under");
      expect(port.calls[0]!.prompt).toContain(
        "A literal create destination remains a named write target even when it is absent from the repository inventory.",
      );
      expect(port.calls[0]!.prompt.includes('"path":"documentation/other-product.md"')).toBe(
        unrelatedMarkdown,
      );
      expect(capturedRequest().requestIntent!.admission.outcome).toBe("admitted");
      expect(capturedRequest().requestIntent!.intent!.targets).toMatchObject([
        { path, role: "write", chosenFrom: "named" },
      ]);
    },
  );

  it("admits a safe create whose source context names an unconfigured README", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const port = stubPort([
      JSON.stringify({
        operation: "create",
        targets: [
          { path: "docs/new.md", role: "write", chosenFrom: "named", quote: "docs/new.md" },
        ],
        authorityPreference: { preference: "unspecified", quote: null },
      }),
    ]);
    const run = await captured(() =>
      executeRunRequest(
        runRequest(repositoryPath, "create-documentation", {
          allowWrite: true,
          instruction: "Create docs/new.md. Consult README.md only as source evidence.",
        }),
        stubConfig(stateDirectory),
        { requestInterpreter: port },
      ),
    );
    expect((run.error as Error).message).toBe(STOP_AT_EXECUTION);
    expect(port.calls).toHaveLength(1);
    expect(capturedRequest().requestIntent!.admission.outcome).toBe("admitted");
  });

  it("interprets a read-only review before first-pass binding, then proceeds with the admitted intent", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const port = stubPort([reviewProposal()]);
    const run = await captured(() =>
      executeRunRequest(
        runRequest(repositoryPath, "review-documentation"),
        stubConfig(stateDirectory),
        {
          requestInterpreter: port,
        },
      ),
    );
    expect((run.error as Error).message).toBe(STOP_AT_EXECUTION);
    expect(order).toEqual(["interpret", "proposal-scope", "first-pass-gate", "execute"]);
    const admission = capturedRequest().requestIntent!.admission;
    expect(admission.outcome).toBe("admitted");
    expect(admission.outcome).not.toBe("offline");
    expect(capturedRequest().requestIntent!.intent!.targets[0]!.path).toBe("docs/a.md");
    expect(port.calls[0]!.prompt).toContain('{"path":"docs/a.md","title":"Alpha","navLabel":null}');
    expect(port.calls[0]!.prompt).toContain('{"path":"docs/b.md","title":"Beta","navLabel":null}');
  });

  it("calls an injected port under PI_OFFLINE=1", async () => {
    process.env.PI_OFFLINE = "1";
    const { repositoryPath, stateDirectory } = await fixture();
    const port = stubPort([reviewProposal()]);
    await captured(() =>
      executeRunRequest(
        runRequest(repositoryPath, "review-documentation"),
        stubConfig(stateDirectory),
        {
          requestInterpreter: port,
        },
      ),
    );
    expect(port.calls).toHaveLength(1);
    expect(capturedRequest().requestIntent!.admission.outcome).toBe("admitted");
  });

  it("records offline without a port when PI_OFFLINE is 1, and builds no production port", async () => {
    process.env.PI_OFFLINE = "1";
    const { repositoryPath, stateDirectory } = await fixture();
    await captured(() =>
      executeRunRequest(
        runRequest(repositoryPath, "review-documentation"),
        stubConfig(stateDirectory),
      ),
    );
    expect(production.created).toBe(0);
    expect(capturedRequest().requestIntent!.admission).toMatchObject({
      outcome: "offline",
      reason: "pi-offline",
      calls: [],
    });
  });

  // 0 is the live value the CI live jobs and the dogfood host export.
  it.each([undefined, "0", ""])(
    "builds the production port when PI_OFFLINE is %j and no port is injected",
    async (value) => {
      if (value === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = value;
      const { repositoryPath, stateDirectory } = await fixture();
      const port = stubPort([reviewProposal()]);
      production.port = port;
      await captured(() =>
        executeRunRequest(
          runRequest(repositoryPath, "review-documentation"),
          stubConfig(stateDirectory),
        ),
      );
      expect(production.created).toBe(1);
      expect(port.calls).toHaveLength(1);
      expect(capturedRequest().requestIntent!.admission.outcome).toBe("admitted");
    },
  );

  it("interprets once on the do path, through runWorkflow", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const port = stubPort([proposal()]);
    await captured(() =>
      handleDoCommand([INSTRUCTION, "--repo", repositoryPath, "--patch-only"], {
        runWorkflow: (request) =>
          executeRunRequest(request, stubConfig(stateDirectory), { requestInterpreter: port }),
      }),
    );
    expect(port.calls).toHaveLength(1);
    expect(order.indexOf("interpret")).toBeLessThan(order.indexOf("proposal-scope"));
    expect(capturedRequest().requestIntent!.admission.outcome).toBe("admitted");
  });

  it("stops a fresh live-agent turn at its first hop with the question record", async () => {
    delete process.env.PI_OFFLINE;
    const { repositoryPath, stateDirectory } = await fixture();
    const port = stubPort([proposal({ targets: [ABSENT_TARGET] })]);
    production.port = port;
    const record = await runBoundedWorkflow({
      workflow: "update-documentation",
      instruction: ABSENT_INSTRUCTION,
      repositoryPath,
      allowWrite: true,
      config: stubConfig(stateDirectory),
    });
    expect(port.calls).toHaveLength(1);
    expect(record.status).toBe("needs-input");
    expect(record.requestIntent!.admission).toMatchObject({
      outcome: "question",
      code: "request-intent-target-absent",
    });
  });

  it("interprets a run whose only continuation-like signal is its run id", async () => {
    delete process.env.PI_OFFLINE;
    const { repositoryPath, stateDirectory } = await fixture();
    const port = stubPort([proposal({ targets: [ABSENT_TARGET] })]);
    production.port = port;
    const record = await runBoundedWorkflow({
      workflow: "update-documentation",
      instruction: ABSENT_INSTRUCTION,
      repositoryPath,
      allowWrite: true,
      config: stubConfig(stateDirectory),
      runId: "11111111-2222-4333-8444-555555555555",
    });
    expect(port.calls).toHaveLength(1);
    expect(record.id).toBe("11111111-2222-4333-8444-555555555555");
  });
});

describe("runs that do not interpret (row 2)", () => {
  it("never interprets a dry run", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const port = stubPort([proposal()]);
    await captured(() =>
      executeRunRequest(
        runRequest(repositoryPath, "update-documentation", { dryRun: true }),
        stubConfig(stateDirectory),
        { requestInterpreter: port },
      ),
    );
    expect(port.calls).toHaveLength(0);
  });

  it.each([["--route-only"], ["--dry-run"]])("never interprets do %s", async (flag) => {
    const { repositoryPath, stateDirectory } = await fixture();
    const port = stubPort([proposal()]);
    const runWorkflow = vi.fn();
    const run = await captured(() =>
      handleDoCommand([INSTRUCTION, "--repo", repositoryPath, flag], {
        runWorkflow: (request) =>
          runWorkflow(request) ??
          executeRunRequest(request, stubConfig(stateDirectory), { requestInterpreter: port }),
      }),
    );
    expect(run.error).toBeUndefined();
    expect((run.result as { status?: string }).status).toBe("selected");
    expect(runWorkflow).not.toHaveBeenCalled();
    expect(port.calls).toHaveLength(0);
    expect(order).not.toContain("execute");
  });

  it("records an InputAsk resume as a continuation and calls nothing", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const port = stubPort([proposal()]);
    await captured(() =>
      executeRunRequest(
        runRequest(repositoryPath, "review-documentation", {
          operatorInputResume: {} as never,
        }),
        stubConfig(stateDirectory),
        { requestInterpreter: port },
      ),
    );
    expect(port.calls).toHaveLength(0);
    expect(capturedRequest().requestIntent!.admission).toMatchObject({
      outcome: "continuation",
      reason: "operator-input-resume",
    });
  });

  it("stamps not-applicable from the first queued save through the real runner", async () => {
    capture.intercept = false;
    const { repositoryPath, stateDirectory } = await fixture();
    const port = stubPort([proposal()]);
    const queued: unknown[] = [];
    await captured(() =>
      executeRunRequest(
        runRequest(repositoryPath, "readiness", { instruction: undefined }),
        stubConfig(stateDirectory),
        {
          requestInterpreter: port,
          onProgress: (event) => {
            if (event.type === "run-status" && event.status === "running") {
              queued.push(event.runId);
            }
          },
          executionHarness: {
            inspectSkill: async (input: HarnessStepInput) => ({
              id: input.step.skill,
              contentSha256: "a".repeat(64),
            }),
            runStep: async (input: HarnessStepInput) => ({
              summary: `Completed ${input.step.id}.`,
              model: { provider: "fixture", model: "fixture" },
              skill: { id: input.step.skill, contentSha256: "a".repeat(64) },
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
              tools: { totalCalls: 0, failedCalls: 0, byTool: [], failureCategories: [] },
            }),
          },
          skillResolver: {
            resolveSkill: async (input: HarnessStepInput) => ({
              id: input.step.skill,
              contentSha256: "a".repeat(64),
            }),
          },
        },
      ),
    );
    expect(port.calls).toHaveLength(0);
    expect(queued).toHaveLength(1);
    const [record] = await savedRecords(stateDirectory);
    expect(record!.requestIntent).toEqual({
      schemaVersion: 1,
      admission: {
        outcome: "not-applicable",
        code: null,
        location: null,
        reason: "workflow-without-operation",
        boundary: null,
        calls: [],
        clippedTitles: 0,
      },
      intent: null,
    });
  });

  it("copies the payload onto the queued record", () => {
    const requestIntent = requestInterpretationStep(
      { outcome: "unavailable", code: "request-intent-model-unavailable", calls: [] },
      0,
    ).recorded;
    const record = createQueuedRunRecord(
      { timestamp: () => "2026-10-05T00:00:00.000Z", options: {}, id: () => "run-1" } as never,
      {
        workflow: "review-documentation",
        workspacePath: "/w",
        repository: { sourcePath: "/r", requestedRevision: "HEAD", revision: "a".repeat(40) },
        allowWrite: false,
        requestIntent,
      },
      { workflow: getWorkflow("review-documentation"), runId: "run-1" } as never,
    );
    expect(record.status).toBe("queued");
    expect(record.requestIntent).toEqual(requestIntent);
    expect(record.requestIntent).not.toBe(requestIntent);
  });
});

describe("stop arms through executeRunRequest (row 3)", () => {
  async function stop(
    port: RequestIntentInterpreterPort,
    options: {
      json?: boolean;
      maxRetries?: number;
      signal?: AbortSignal;
      instruction?: string;
    } = {},
  ) {
    const { repositoryPath, stateDirectory } = await fixture();
    const head = await git(repositoryPath, ["rev-parse", "HEAD"]);
    const run = await captured(() =>
      executeRunRequest(
        runRequest(repositoryPath, "review-documentation", {
          json: options.json ?? false,
          ...(options.instruction ? { instruction: options.instruction } : {}),
        }),
        stubConfig(stateDirectory, options.maxRetries ?? 0),
        { requestInterpreter: port, ...(options.signal ? { signal: options.signal } : {}) },
      ),
    );
    expect(await git(repositoryPath, ["status", "--porcelain"])).toBe("");
    expect(await git(repositoryPath, ["rev-parse", "HEAD"])).toBe(head);
    return {
      ...run,
      exitCode: process.exitCode,
      records: await savedRecords(stateDirectory),
      stateDirectory,
    };
  }

  it("stops on the host's question with needs-input, exit 2, and the question as NEXT", async () => {
    const run = await stop(stubPort([reviewProposal({ targets: [ABSENT_TARGET] })]), {
      instruction: ABSENT_INSTRUCTION,
    });
    expect(run.error).toBeUndefined();
    expect(run.exitCode).toBe(2);
    expect(order).not.toContain("proposal-scope");
    expect(order).not.toContain("execute");
    const [record] = run.records;
    expect(record).toMatchObject({ status: "needs-input", steps: [] });
    expect(record!.requestIntent!.admission.outcome).toBe("question");
    expect(record!.requestIntent!.admission.outcome).not.toBe("offline");
    const output = run.logs.join("\n");
    expect(output).not.toContain("--resume-from");
    expect(output).not.toContain("--canon-snapshot");
    const next = nextSection(run.logs);
    expect(next[0]).toMatch(/^docsfab run review-documentation --repo /u);
    expect(next[0]).not.toContain("docsfab doctor");
    expect(next[1]).toContain(`Question: ${ABSENT_QUESTION("review")}`);
    expect(next[1]).toContain("Recommended: stop");
  });

  it("goes on past the model's own question, recorded unanswered as an advisory", async () => {
    const run = await stop(stubPort([reviewProposal({ questions: [QUESTION] })]));
    expect((run.error as Error | undefined)?.message).toBe(STOP_AT_EXECUTION);
    expect(run.exitCode).toBeUndefined();
    expect(run.records).toEqual([]);
    expect(capturedRequest().requestIntent!.admission).toMatchObject({
      outcome: "advisory",
      code: "request-intent-model-question",
      location: "$.questions[0]",
    });
    expect(capturedRequest().requestIntent!.intent!.question).toEqual(QUESTION);
  });

  it("emits the question stop as RunResultV1 with the question in nextSteps", async () => {
    const run = await stop(stubPort([reviewProposal({ targets: [ABSENT_TARGET] })]), {
      json: true,
      instruction: ABSENT_INSTRUCTION,
    });
    const result = JSON.parse(run.logs.join("\n")) as {
      kind: string;
      execution: { exitCode: number; status: string };
      nextSteps: string[];
    };
    expect(result.kind).toBe("docsfab-run-result");
    expect(result.execution).toMatchObject({ exitCode: 2, status: "needs-input" });
    expect(run.exitCode).toBe(2);
    expect(result.nextSteps[0]).toMatch(/^docsfab run review-documentation /u);
    expect(result.nextSteps[1]).toContain(ABSENT_QUESTION("review"));
    expect(JSON.stringify(result)).not.toContain("--resume-from");
  });

  it("refuses an internal path with failed, exit 1, the boundary in NEXT, and no question", async () => {
    const port = stubPort([
      proposal({
        targets: [
          { path: ".git/config", role: "write", chosenFrom: "named", quote: ".git/config" },
        ],
        questions: [QUESTION],
      }),
    ]);
    const run = await stop(port, { instruction: "Update .git/config to add the docs remote." });
    expect(run.exitCode).toBe(1);
    const [record] = run.records;
    expect(record).toMatchObject({
      status: "failed",
      failure: { class: "model-content", layer: "inference", code: "request-intent-internal-path" },
    });
    const next = nextSection(run.logs);
    expect(next[1]).toContain("names .git/config, inside .git, which no grant covers");
    expect(next[1]).toContain("Remove the path from the request");
    expect(next.join("\n")).not.toContain("Question:");
  });

  it("stops rejected after 1 + retry.maxRetries calls with the last code", async () => {
    const port = stubPort([proposal({ extra: 1 }), proposal({ extra: 2 }), "not json at all"]);
    const run = await stop(port, { maxRetries: 2 });
    expect(port.calls).toHaveLength(3);
    expect(run.exitCode).toBe(1);
    expect(run.records[0]).toMatchObject({
      status: "failed",
      failure: { class: "contract-shape", code: "request-intent-shape" },
    });
    expect(run.records[0]!.requestIntent!.admission.calls).toHaveLength(3);
    const next = nextSection(run.logs);
    expect(next[0]).toMatch(/^docsfab runs show .* --json$/u);
    expect(next[1]).toContain("do not retry unchanged");
  });

  it("stops unavailable on a port-reported provider failure", async () => {
    const run = await stop(stubPort([new RequestIntentModelUnavailableError()]));
    expect(run.exitCode).toBe(1);
    expect(run.records[0]).toMatchObject({
      status: "failed",
      failure: { class: "infrastructure", code: "request-intent-model-unavailable" },
      requestIntent: { admission: { outcome: "unavailable" } },
    });
  });

  it("stops at its own deadline with the deadline code", async () => {
    process.env.DOCSFAB_REQUEST_INTENT_INTERPRETATION_TIMEOUT_MS = "30";
    const port: RequestIntentInterpreterPort = {
      call: (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    const run = await stop(port);
    expect(run.records[0]).toMatchObject({
      status: "failed",
      failure: { code: "request-intent-model-deadline" },
    });
  });

  it("takes the cancellation path on an operator abort and saves no intent record", async () => {
    const operator = new AbortController();
    const port: RequestIntentInterpreterPort = {
      call: (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () =>
            reject(new RequestIntentModelUnavailableError()),
          );
          operator.abort();
        }),
    };
    const run = await stop(port, { signal: operator.signal });
    expect((run.error as Error).message).toBe(WORKFLOW_CANCELLED);
    expect(run.records).toEqual([]);
  });

  it.each([
    ["a host contract fault", () => new RequestIntentContractError("host-input-invalid", "x")],
    ["an unrelated error", () => new TypeError("port defect")],
  ])("propagates %s and saves no unavailable record", async (_name, make) => {
    const error = make();
    const run = await stop(stubPort([error]));
    expect(run.error).toBe(error);
    expect(run.records).toEqual([]);
  });
});

describe("write grant order (row 10)", () => {
  it.each(["restructure-documentation", "create-documentation"] as const)(
    "refuses %s without --allow-write with the existing message and no model call",
    async (workflow) => {
      capture.intercept = false;
      const { repositoryPath, stateDirectory } = await fixture();
      const port = stubPort([proposal()]);
      const run = await captured(() =>
        executeRunRequest(runRequest(repositoryPath, workflow), stubConfig(stateDirectory), {
          requestInterpreter: port,
        }),
      );
      expect(port.calls).toHaveLength(0);
      expect((run.error as Error).message).toBe(
        `Workflow "${workflow}" can modify files. Re-run with --allow-write after reviewing the plan.`,
      );
    },
  );

  it("interprets update without --allow-write and leaves its grant stop to the runner", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const port = stubPort([proposal()]);
    await captured(() =>
      executeRunRequest(
        runRequest(repositoryPath, "update-documentation"),
        stubConfig(stateDirectory),
        {
          requestInterpreter: port,
        },
      ),
    );
    expect(port.calls).toHaveLength(1);
    expect(capturedRequest()).toMatchObject({
      allowWrite: false,
      requestIntent: { admission: { outcome: "admitted" } },
    });
  });

  it.each(["restructure-documentation", "create-documentation", "update-documentation"] as const)(
    "interprets %s with --allow-write and proceeds",
    async (workflow) => {
      const { repositoryPath, stateDirectory } = await fixture();
      const port = stubPort([proposalFor(workflow)]);
      await captured(() =>
        executeRunRequest(
          runRequest(repositoryPath, workflow, { allowWrite: true }),
          stubConfig(stateDirectory),
          { requestInterpreter: port },
        ),
      );
      expect(port.calls).toHaveLength(1);
      expect(capturedRequest().requestIntent!.admission.outcome).toBe("admitted");
    },
  );

  // Real first-pass binding, not a stub: the binding gate takes an advisory
  // reading as it takes a run with no intent, so a gate that refused one, or
  // bound its reading, fails here.
  it.each([
    [
      "names no page",
      "Update the docs for the new --profile flag.",
      proposal({ targets: [] }),
      "request-intent-target-missing",
    ],
    [
      "reads as a review",
      "Check whether the docs need any change for the new --profile flag, and update them only if they do.",
      reviewProposal({ targets: [] }),
      "request-intent-operation-mismatch",
    ],
  ] as const)(
    "binds first pass for real after an advisory update that %s, and reaches execution",
    async (_name, instruction, reply, code) => {
      const { repositoryPath, stateDirectory } = await fixture();
      const run = await captured(() =>
        executeRunRequest(
          runRequest(repositoryPath, "update-documentation", { allowWrite: true, instruction }),
          stubConfig(stateDirectory),
          { requestInterpreter: stubPort([reply]) },
        ),
      );
      expect((run.error as Error | undefined)?.message).toBe(STOP_AT_EXECUTION);
      expect(order).toEqual(["interpret", "proposal-scope", "first-pass-gate", "execute"]);
      expect(capturedRequest().requestIntent!.admission).toMatchObject({
        outcome: "advisory",
        code,
      });
    },
  );
});

describe("recorded intent: runs show and publication (rows 4 and 9-show)", () => {
  async function questionRecord() {
    const { repositoryPath, stateDirectory } = await fixture();
    await captured(() =>
      executeRunRequest(
        runRequest(repositoryPath, "review-documentation", { instruction: ABSENT_INSTRUCTION }),
        stubConfig(stateDirectory),
        {
          requestInterpreter: stubPort([reviewProposal({ targets: [ABSENT_TARGET] })]),
        },
      ),
    );
    process.exitCode = undefined;
    const [record] = await savedRecords(stateDirectory);
    return { record: record!, stateDirectory, path: join(stateDirectory, `${record!.id}.json`) };
  }

  async function show(stateDirectory: string, id: string): Promise<string[]> {
    const run = await captured(() =>
      handleRunsCommand(["show", id, "--state-dir", stateDirectory]),
    );
    expect(run.error).toBeUndefined();
    return run.logs
      .join("\n")
      .split("\n")
      .map((line) => line.trim());
  }

  function intentSection(lines: readonly string[]): string[] {
    const start = lines.indexOf("INTENT");
    if (start < 0) return [];
    const end = lines.findIndex((line, index) => index > start && line === "");
    return lines.slice(start + 1, end < 0 ? undefined : end);
  }

  it("shows a verified question record's INTENT", async () => {
    const { record, stateDirectory } = await questionRecord();
    expect(intentSection(await show(stateDirectory, record.id))).toEqual([
      "Admission: question (request-intent-target-absent)",
      "Intent: not admitted",
      "Operation: review",
      "Target: docs/missing.md · write · named",
      "Authority preference: unspecified",
      `Question: ${ABSENT_QUESTION("review")}`,
      "Options: rerun-as-create | name-an-existing-page | stop",
      "Recommended: stop",
      "Model calls: 1",
      "Model tokens: 3 input, 2 output (not in the run's usage)",
      "Clipped titles: 0",
    ]);
  });

  it("replays a producer question through the saved record and runs show in both modes", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const produced = await captured(() =>
      executeRunRequest(
        runRequest(repositoryPath, "review-documentation", { instruction: ABSENT_INSTRUCTION }),
        stubConfig(stateDirectory),
        { requestInterpreter: stubPort([reviewProposal({ targets: [ABSENT_TARGET] })]) },
      ),
    );
    expect(produced.error).toBeUndefined();
    expect(process.exitCode).toBe(2);
    const [record] = await savedRecords(stateDirectory);
    expect(record).toMatchObject({ status: "needs-input", steps: [] });

    process.exitCode = undefined;
    const human = await captured(() =>
      handleRunsCommand(["show", record!.id, "--state-dir", stateDirectory]),
    );
    expect(human.error).toBeUndefined();
    expect(human.logs.join("\n")).toContain("Exit code: 2");
    expect(process.exitCode).toBe(2);

    process.exitCode = undefined;
    const json = await captured(() =>
      handleRunsCommand(["show", record!.id, "--json", "--state-dir", stateDirectory]),
    );
    expect(json.error).toBeUndefined();
    const result = JSON.parse(json.logs.join("\n")) as {
      execution: { status: string; exitCode: number };
    };
    expect(result.execution).toMatchObject({ status: "needs-input", exitCode: 2 });
    expect(process.exitCode).toBe(2);
  });

  it.each([
    ["the digest", (intent: Record<string, unknown>) => ({ ...intent, digest: "0".repeat(64) })],
    [
      "a quote",
      (intent: Record<string, unknown>) => {
        const targets = structuredClone(intent.targets) as { quote: { text: string } }[];
        targets[0]!.quote.text = "docs/b.md";
        return { ...intent, targets };
      },
    ],
  ])("prints unverified and no content when %s is edited on disk", async (_name, edit) => {
    const { record, stateDirectory, path } = await questionRecord();
    const onDisk = JSON.parse(await readFile(path, "utf8")) as {
      requestIntent: { intent: Record<string, unknown> };
    };
    onDisk.requestIntent.intent = edit(onDisk.requestIntent.intent);
    await writeFile(path, JSON.stringify(onDisk));
    const lines = await show(stateDirectory, record.id);
    const intent = intentSection(lines);
    expect(intent).toHaveLength(1);
    expect(intent[0]).toMatch(/^Admission: unverified \(sealed-[a-z-]+\)$/u);
    expect(lines.join("\n")).not.toContain(ABSENT_QUESTION("review"));
  });

  it("shows a pre-feature record without an INTENT section or an error", async () => {
    const { record, stateDirectory, path } = await questionRecord();
    const onDisk = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    delete onDisk.requestIntent;
    await writeFile(path, JSON.stringify(onDisk));
    expect(intentSection(await show(stateDirectory, record.id))).toEqual([]);
  });

  async function admittedStep(instruction: string): Promise<RequestInterpretationStep> {
    const outcome = await interpretRequest({
      port: stubPort([
        proposal({
          targets: [{ path: "README.md", role: "write", chosenFrom: "inventory", quote: "README" }],
        }),
      ]),
      workflow: "update-documentation",
      operation: "update",
      instruction,
      promptInventory: { entries: [], clippedTitles: 0 },
      admissionInventory: ["README.md"],
      // documentationRoots lists README.md as a file root, so the reading is admitted.
      documentationRoots: [
        { kind: "root", path: "docs" },
        { kind: "file", path: "README.md" },
      ],
      writeRoots: [
        { kind: "root", path: "docs" },
        { kind: "file", path: "README.md" },
      ],
      navigationSet: [],
      // README.md is the one exact-case tracked file it names.
      existence: async (paths) =>
        paths.map((path) => ({ path, existing: "file", base: { sha256: "c".repeat(64) } })),
      limits: resolveRequestIntentLimits(),
      maxRetries: 0,
      window: { maxInputTokens: 128_000, maxOutputTokens: 8_192 },
      deadlineMs: 60_000,
    });
    return requestInterpretationStep(outcome, 0);
  }

  it("admits a writer-produced requestIntent at the publication gate and refuses a tampered or stopped one", async () => {
    const instruction = "Refresh the README for the new release.";
    const recorded = (await admittedStep(instruction)).recorded;
    expect(recorded.admission.outcome).toBe("admitted");
    const record = publicationRecord(instruction);
    expect(
      decodeSuccessfulPublicationRunRecord({ ...record, requestIntent: recorded }).requestIntent,
    ).toEqual(recorded);
    const tampered = { ...recorded, intent: { ...recorded.intent!, digest: "0".repeat(64) } };
    expect(() =>
      decodeSuccessfulPublicationRunRecord({ ...record, requestIntent: tampered }),
    ).toThrow(PublicationRunRecordDecodeError);
    const stopped = requestInterpretationStep(
      { outcome: "unavailable", code: "request-intent-model-unavailable", calls: [] },
      0,
    ).recorded;
    expect(() =>
      decodeSuccessfulPublicationRunRecord({ ...record, requestIntent: stopped }),
    ).toThrow(PublicationRunRecordDecodeError);
  });

  it("admits an advisory reading at the publication gate, because the run went on past it", async () => {
    const instruction = "Check whether the README needs any change, and update it only if it does.";
    const outcome = await interpretRequest({
      port: stubPort([proposal({ operation: "review", targets: [] })]),
      workflow: "update-documentation",
      operation: "update",
      instruction,
      promptInventory: { entries: [], clippedTitles: 0 },
      admissionInventory: ["README.md"],
      documentationRoots: [{ kind: "root", path: "docs" }],
      writeRoots: [{ kind: "root", path: "docs" }],
      navigationSet: [],
      existence: async () => [],
      limits: resolveRequestIntentLimits(),
      maxRetries: 0,
      window: { maxInputTokens: 128_000, maxOutputTokens: 8_192 },
      deadlineMs: 60_000,
    });
    const step = requestInterpretationStep(outcome, 0);
    expect(step.kind).toBe("continue");
    const recorded = step.recorded!;
    expect(recorded.admission).toMatchObject({
      outcome: "advisory",
      code: "request-intent-operation-mismatch",
    });
    expect(
      decodeSuccessfulPublicationRunRecord({
        ...publicationRecord(instruction),
        requestIntent: recorded,
      }).requestIntent,
    ).toEqual(recorded);
  });
});

const PATCH = Buffer.from("diff --git a/README.md b/README.md\n", "utf8");

/** The shipped publication-gate record shape: a succeeded site-bootstrap write. */
function publicationRecord(instruction: string): Record<string, unknown> {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 };
  const tools = { totalCalls: 0, failedCalls: 0, byTool: [] };
  const revision = "a".repeat(40);
  const reference = {
    kind: "ia-plan",
    schemaVersion: 1,
    digest: "a".repeat(64),
    repositoryRevision: revision,
    repositoryContentDigest: "b".repeat(64),
  };
  const artifacts = [{ role: "input", stepId: "apply-site-bootstrap", reference }];
  return {
    schemaVersion: 2,
    id: "run-1825-publication",
    workflow: "site-bootstrap",
    repository: { sourcePath: "/fixtures/intent", requestedRevision: "HEAD", revision },
    workspace: { strategy: "tracked-export", disposable: true },
    instruction,
    task: { kind: "site-bootstrap", plan: reference },
    status: "succeeded",
    createdAt: "2026-10-05T00:00:00.000Z",
    startedAt: "2026-10-05T00:00:01.000Z",
    completedAt: "2026-10-05T00:00:02.000Z",
    durationMs: 1000,
    models: [],
    skills: [],
    usage,
    tools,
    securityScan: {
      ruleSet: "credential-rules-v1",
      status: "passed",
      scannedFiles: 1,
      binaryFiles: 0,
      findings: [],
    },
    securityScanEffectiveDisposition: { status: "passed" },
    artifacts,
    steps: [
      {
        id: "apply-site-bootstrap",
        title: "Apply approved site bootstrap",
        kind: "host-operation",
        operation: "site-bootstrap",
        skill: "template-scaffold-site",
        mode: "write",
        status: "succeeded",
        startedAt: "2026-10-05T00:00:01.000Z",
        completedAt: "2026-10-05T00:00:02.000Z",
        durationMs: 1000,
        usage,
        tools,
        contextPreflight: {
          status: "ready",
          packetDigest: "c".repeat(64),
          consultedNodeIds: ["node-a"],
          ontologyVersion: "ontology-v1",
          effectiveDecisionIds: [],
          measurements: {
            byteLength: 1,
            estimatedTokens: 1,
            latencyMs: 0,
            nodeCount: 1,
            edgeCount: 0,
            pathCount: 1,
          },
          cache: { disposition: "miss", keyDigest: "d".repeat(64), rebuildAttempted: true },
        },
        artifacts,
        summary: "Applied approved site plan.",
      },
    ],
    changes: {
      files: [{ path: "README.md", status: "modified" }],
      patch: {
        sha256: createHash("sha256").update(PATCH).digest("hex"),
        byteLength: PATCH.byteLength,
        lineCount: 1,
        artifactPath: "/fixtures/intent/run.patch",
        format: "git-diff",
      },
    },
  };
}
