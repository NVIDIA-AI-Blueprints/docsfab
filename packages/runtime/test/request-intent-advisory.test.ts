// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The request interpretation's reading is advisory except where authority or
 * publication decides. Each case is driven as a run that goes on: a request
 * that names no page, a request that reads as another operation than the
 * run's workflow (`run` and `do`), a question the model asks, a restructure
 * that names a new destination page, a page `.docsfab.json` grants as a file,
 * and a repository with hundreds of documentation pages. Authority refusals
 * and `do`'s publication prohibition still stop the run.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.hoisted(() => ({ invocations: [] as unknown[] }));
const STOP_AT_EXECUTION = "test sentinel: the run reached workflow execution";

// First-pass binding is not what these cells decide; stopping short of it
// keeps each cell about the interpretation, as the host-input cells do.
vi.mock("../src/cli/first-pass.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/first-pass.js")>();
  return {
    ...actual,
    bindFirstRunProposalScope: async () => undefined,
    needsFirstPassKnowledgeForExecution: async () => false,
  };
});

vi.mock("../src/cli/run/execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/run/execution.js")>();
  return {
    ...actual,
    executeWorkflowRun: async (...args: Parameters<typeof actual.executeWorkflowRun>) => {
      capture.invocations.push(args[0]);
      throw new Error(STOP_AT_EXECUTION);
    },
  };
});

import { handleDoCommand, type DoCommandOptions } from "../src/cli/commands/do.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { firstPassDocumentationWriteRoots } from "../src/cli/first-pass.js";
import { requestIntentRootScope } from "../src/cli/run/request-intent-stop.js";
import type { CliRunInvocation, RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import { limit, limitDefinition, OperationalLimitError } from "../src/config/limits.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import { toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";
import { buildRunHumanNextCommand } from "../src/operator/run-summary.js";
import type { RunRecord } from "../src/records/contracts.js";
import type { RequestIntentOperation } from "../src/request-intent/contract.js";
import { buildRequestIntentPromptInventory } from "../src/request-intent/interpret-inventory.js";
import {
  decodeRunRecordRequestIntent,
  formatRequestIntentLines,
  type RunRecordRequestIntentV1,
} from "../src/request-intent/interpret-record.js";
import {
  buildRequestIntentHostInputs,
  type RequestIntentInterpreterCall,
  type RequestIntentInterpreterPort,
} from "../src/request-intent/interpret.js";
import { RequestIntentContractError } from "../src/request-intent/kit.js";
import { resolveRequestIntentLimits } from "../src/request-intent/limits.js";
import { sealRequestIntent } from "../src/request-intent/seal.js";
import { validModelConfig } from "./helpers.js";
import { initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = temporaryRoots();
const RUN_BUDGET = { timeout: testTimeoutMs(30_000) };

/** Documentation pages under docs/ in a FastMCP checkout. */
const FASTMCP_PAGES = 598;

/** A request to check whether the docs need updating, and to update them only if so. */
const CHECK_REQUEST =
  "Pull request 42 changes how the settings file is loaded. Check whether the documentation needs any change because of it, and update the documentation only if it does.";

beforeEach(() => {
  capture.invocations.length = 0;
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

interface Target {
  readonly path: string;
  readonly role?: "write" | "companion-nav" | "companion-index";
  readonly chosenFrom?: "named" | "inventory" | "proposed-new";
  readonly quote?: string;
}

function reply(operation: RequestIntentOperation, targets: readonly Target[]): string {
  return JSON.stringify({
    operation,
    targets: targets.map((target) => ({
      path: target.path,
      role: target.role ?? "write",
      chosenFrom: target.chosenFrom ?? "named",
      quote: target.quote ?? target.path,
    })),
    authorityPreference: { preference: "unspecified", quote: null },
  });
}

function stubPort(replies: readonly string[]): RequestIntentInterpreterPort & {
  readonly calls: RequestIntentInterpreterCall[];
} {
  const calls: RequestIntentInterpreterCall[] = [];
  return {
    calls,
    async call(request) {
      calls.push(request);
      const text = replies[Math.min(calls.length - 1, replies.length - 1)]!;
      return { text, usage: { inputTokens: 3, outputTokens: 2 } };
    },
  };
}

const BASE_FILES: Readonly<Record<string, string>> = {
  "README.md": "# Fixture\n",
  "docs/a.md": "# Alpha\n",
  "docs/guide.md": "# Guide\n\n## Requirements\n\n## Errors\n\n## More help\n",
  "site/content/old.md": "# Old\n",
};

async function fixture(
  input: {
    readonly documentationRoots?: readonly string[];
    readonly files?: Readonly<Record<string, string>>;
  } = {},
): Promise<{ repositoryPath: string; stateDirectory: string }> {
  const root = await roots.create("docsfab-intent-advisory-");
  const repositoryPath = join(root, "repo");
  await initFixtureRepo(repositoryPath, {
    ...BASE_FILES,
    ...input.files,
    ".docsfab.json": `${JSON.stringify({
      schemaVersion: 1,
      gitlab: { remote: "origin", defaultBranch: "main" },
      provider: { configuration: "host" },
      storage: { scope: "user-private" },
      ...(input.documentationRoots ? { documentationRoots: input.documentationRoots } : {}),
    })}\n`,
  });
  return { repositoryPath, stateDirectory: await roots.create("docsfab-intent-advisory-state-") };
}

function runRequest(
  repositoryPath: string,
  workflow: RunRequestWithPublishProjection["workflow"],
  instruction: string,
): RunRequestWithPublishProjection {
  return {
    workflow,
    repositoryPath,
    revision: "HEAD",
    instruction,
    allowWrite: workflow !== "review-documentation",
    releaseGate: false,
    verbose: false,
    json: false,
    showScan: false,
    patchOnly: true,
  } as RunRequestWithPublishProjection;
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

/** The request the run reached workflow execution with, when it got that far. */
function executedRequest(): RunRequestWithPublishProjection | undefined {
  return (capture.invocations[0] as CliRunInvocation | undefined)?.request;
}

/** The outcome of one run: whether it reached execution, and the interpretation it recorded. */
async function settled(
  run: { error?: unknown; logs: string[] },
  stateDirectory: string,
): Promise<{
  readonly proceeded: boolean;
  readonly records: RunRecord[];
  readonly requestIntent: RunRecordRequestIntentV1 | undefined;
}> {
  const proceeded = (run.error as Error | undefined)?.message === STOP_AT_EXECUTION;
  const records = await savedRecords(stateDirectory);
  const requestIntent = (
    proceeded ? executedRequest()?.requestIntent : records[0]?.requestIntent
  ) as RunRecordRequestIntentV1 | undefined;
  return { proceeded, records, requestIntent };
}

async function interpretedRun(input: {
  readonly workflow: RunRequestWithPublishProjection["workflow"];
  readonly instruction: string;
  readonly replies: readonly string[];
  readonly documentationRoots?: readonly string[];
  readonly files?: Readonly<Record<string, string>>;
}) {
  const { repositoryPath, stateDirectory } = await fixture(input);
  const port = stubPort(input.replies);
  const run = await captured(() =>
    executeRunRequest(
      runRequest(repositoryPath, input.workflow, input.instruction),
      stubConfig(stateDirectory),
      { requestInterpreter: port },
    ),
  );
  return {
    ...run,
    ...(await settled(run, stateDirectory)),
    port,
    exitCode: process.exitCode,
  };
}

/** `docsfab do` with the interpretation's model stubbed; the run itself is the shipped one. */
async function doRun(input: {
  readonly args: readonly string[];
  readonly replies: readonly string[];
  readonly admitCatalogWorkflow?: DoCommandOptions["admitCatalogWorkflow"];
}) {
  const { repositoryPath, stateDirectory } = await fixture();
  const port = stubPort(input.replies);
  const routed: string[] = [];
  const run = await captured(() =>
    handleDoCommand([input.args[0]!, "--repo", repositoryPath, ...input.args.slice(1)], {
      stateDirectory,
      ...(input.admitCatalogWorkflow ? { admitCatalogWorkflow: input.admitCatalogWorkflow } : {}),
      runWorkflow: (request) => {
        routed.push(request.workflow);
        return executeRunRequest(request, stubConfig(stateDirectory), {
          requestInterpreter: port,
        });
      },
    }),
  );
  return {
    ...run,
    ...(await settled(run, stateDirectory)),
    port,
    routed,
    exitCode: process.exitCode,
  };
}

/** The INTENT lines `runs show` prints for a recorded interpretation. */
function intentLines(requestIntent: RunRecordRequestIntentV1 | undefined, instruction: string) {
  return formatRequestIntentLines({ requestIntent, instruction });
}

// ---------------------------------------------------------------------------
// request-intent-target-missing: advisory for an update or a restructure; a
// create run asks which page, because only the operator can name a new page.

describe("a request that names no page goes on, and the workflow chooses the pages", () => {
  it.each([
    [
      "update-documentation",
      "update",
      "Check whether pull request 42, the retry fix, needs a documentation update, and update the docs if it does.",
    ],
    [
      "restructure-documentation",
      "restructure",
      "Restructure the documentation so that the tasks a new operator follows come first.",
    ],
  ] as const)(
    "%s with no page records the reading as advisory and reaches execution",
    RUN_BUDGET,
    async (workflow, operation, instruction) => {
      const run = await interpretedRun({ workflow, instruction, replies: [reply(operation, [])] });
      expect(run.requestIntent?.admission).toMatchObject({
        outcome: "advisory",
        code: "request-intent-target-missing",
        location: "$.targets",
        boundary: null,
      });
      expect(run.proceeded, String(run.error)).toBe(true);
      expect(run.records).toEqual([]);
      expect(run.exitCode).toBeUndefined();
      expect(run.port.calls).toHaveLength(1);
      expect(run.requestIntent!.intent).toMatchObject({ operation, targets: [], question: null });
      expect(intentLines(run.requestIntent, instruction)).toEqual([
        "Admission: advisory (request-intent-target-missing)",
        "Advisory: The request asks to write documentation but names no page. An update or a restructure records the reading as advisory, and the workflow chooses the pages.",
        `Operation: ${operation}`,
        "Authority preference: unspecified",
        "Model calls: 1",
        "Model tokens: 3 input, 2 output (not in the run's usage)",
        "Clipped titles: 0",
      ]);
    },
  );
});

describe("a create request that names no page stops and asks which page", () => {
  const CREATE_REQUEST =
    "Add a configuration guide that explains how the settings file can reference environment variables.";
  const QUESTION = "The request names no page to create. Which page is meant?";

  /** The question stop as main records it: needs-input, exit 2, no step, nothing executed. */
  function expectCreateQuestion(run: {
    readonly proceeded: boolean;
    readonly exitCode: typeof process.exitCode;
    readonly records: RunRecord[];
    readonly requestIntent: RunRecordRequestIntentV1 | undefined;
  }) {
    expect(run.requestIntent?.admission).toMatchObject({
      outcome: "question",
      code: "request-intent-target-missing",
      location: "$.targets",
    });
    expect(run.proceeded).toBe(false);
    expect(capture.invocations).toHaveLength(0);
    expect(run.exitCode).toBe(2);
    expect(run.records[0]).toMatchObject({
      status: "needs-input",
      error: "request-intent-target-missing",
      steps: [],
    });
    expect(run.requestIntent!.intent!.question).toEqual({
      question: QUESTION,
      options: ["name-a-target", "stop"],
      recommendedDefault: "stop",
      consequence: "Nothing is written; the run stops until the operator reruns it.",
    });
    // NEXT is main's, word for word: nothing about an update or a restructure.
    const record = run.records[0]!;
    expect(
      buildRunHumanNextCommand({
        record,
        recordPath: join("/state", `${record.id}.json`),
        exitCode: 2,
      })?.reason,
    ).toBe(
      `The request interpretation needs one answer before any step runs. Question: ${QUESTION} Options: name-a-target | stop. Recommended: stop. If you take it: Nothing is written; the run stops until the operator reruns it. Answer the question: rerun naming the page, or stop.`,
    );
  }

  it("asks under run create-documentation when the reading names no page", RUN_BUDGET, async () => {
    const run = await interpretedRun({
      workflow: "create-documentation",
      instruction: CREATE_REQUEST,
      replies: [reply("create", [])],
    });
    expectCreateQuestion(run);
    expect(intentLines(run.requestIntent, CREATE_REQUEST)).toContain(`Question: ${QUESTION}`);
  });

  it("asks under a do routed to create-documentation", RUN_BUDGET, async () => {
    const run = await doRun({
      args: [CREATE_REQUEST, "--patch-only"],
      replies: [reply("create", [])],
    });
    expect(run.routed).toEqual(["create-documentation"]);
    expectCreateQuestion(run);
  });

  it(
    "asks under create-documentation even when the reading names another operation",
    RUN_BUDGET,
    async () => {
      // The run creates; a review reading with no page does not turn it into a review.
      const run = await interpretedRun({
        workflow: "create-documentation",
        instruction: CREATE_REQUEST,
        replies: [reply("review", [])],
      });
      expectCreateQuestion(run);
      expect(run.requestIntent!.intent!.operation).toBe("review");
    },
  );
});

// ---------------------------------------------------------------------------
// request-intent-operation-mismatch: mostly "check whether the docs need
// updating" under update-documentation, which can end in a verified no-change.

describe("a request that reads as another operation keeps the run's workflow", () => {
  it(
    "goes on with an explicit run update-documentation when the request reads as a review",
    RUN_BUDGET,
    async () => {
      const run = await interpretedRun({
        workflow: "update-documentation",
        instruction: CHECK_REQUEST,
        replies: [reply("review", [])],
      });
      expect(run.requestIntent?.admission).toMatchObject({
        outcome: "advisory",
        code: "request-intent-operation-mismatch",
        location: "$.operation",
      });
      expect(run.proceeded, String(run.error)).toBe(true);
      expect(executedRequest()?.workflow).toBe("update-documentation");
      expect(run.requestIntent!.intent!.operation).toBe("review");
      expect(intentLines(run.requestIntent, CHECK_REQUEST)).toContain(
        "Advisory: The request reads as a different operation than the workflow this run declared. DocsFab recorded the reading as advisory and ran the declared workflow.",
      );
    },
  );

  it(
    "goes on with update-documentation when the request reads as a create of a new page",
    RUN_BUDGET,
    async () => {
      const instruction =
        "No page documents the settings file yet. Add a settings guide at docs/guides/settings.md.";
      const run = await interpretedRun({
        workflow: "update-documentation",
        instruction,
        replies: [reply("create", [{ path: "docs/guides/settings.md" }])],
      });
      expect(run.requestIntent?.admission).toMatchObject({
        outcome: "advisory",
        code: "request-intent-operation-mismatch",
      });
      expect(run.proceeded, String(run.error)).toBe(true);
      expect(executedRequest()?.workflow).toBe("update-documentation");
    },
  );

  it(
    "routes a check-whether do request to update-documentation through the table and goes on",
    RUN_BUDGET,
    async () => {
      const run = await doRun({
        args: [CHECK_REQUEST, "--patch-only"],
        replies: [reply("review", [])],
      });
      expect(run.routed).toEqual(["update-documentation"]);
      expect(run.requestIntent?.admission).toMatchObject({
        outcome: "advisory",
        code: "request-intent-operation-mismatch",
      });
      expect(run.proceeded, String(run.error)).toBe(true);
      expect(run.port.calls).toHaveLength(1);
    },
  );

  it(
    "goes on when do's admission model routes a check-whether request to update-documentation",
    RUN_BUDGET,
    async () => {
      const request = "Check whether the docs need updating for the new --timeout flag.";
      const offered: string[][] = [];
      const run = await doRun({
        args: [request, "--patch-only"],
        replies: [reply("review", [])],
        admitCatalogWorkflow: async (_request, offer) => {
          offered.push([...offer.workflows]);
          return "update-documentation";
        },
      });
      expect(offered).toHaveLength(1);
      expect(run.routed).toEqual(["update-documentation"]);
      expect(run.requestIntent?.admission).toMatchObject({
        outcome: "advisory",
        code: "request-intent-operation-mismatch",
      });
      expect(run.proceeded, String(run.error)).toBe(true);
    },
  );

  it(
    "still refuses a reading outside the documentation roots when it also reads as another operation",
    RUN_BUDGET,
    async () => {
      const instruction = "Add a new page notes/timeout.md about the timeout flag.";
      const run = await interpretedRun({
        workflow: "update-documentation",
        instruction,
        replies: [reply("create", [{ path: "notes/timeout.md" }])],
      });
      expect(run.proceeded).toBe(false);
      expect(run.exitCode).toBe(1);
      expect(run.requestIntent?.admission).toMatchObject({
        outcome: "refused",
        code: "request-intent-outside-docs-root",
      });
      expect(run.records[0]).toMatchObject({ status: "failed", steps: [] });
    },
  );
});

// ---------------------------------------------------------------------------
// The declared workflow's write scope decides, whatever operation the reading
// names: an advisory never lets a writing run aim at a page it cannot write.

describe("a reading of another operation is checked against the declared write scope", () => {
  it.each([
    ["review", "AGENTS.md", "Review AGENTS.md and fix whatever is stale."],
    ["restructure", "src/notes.md", "Restructure src/notes.md so the notes read in order."],
  ] as const)(
    "refuses a %s reading of %s under update-documentation, outside its write scope",
    RUN_BUDGET,
    async (operation, path, instruction) => {
      const run = await interpretedRun({
        workflow: "update-documentation",
        instruction,
        files: { "AGENTS.md": "# Agents\n", "src/notes.md": "# Notes\n" },
        replies: [reply(operation, [{ path }])],
      });
      expect(run.requestIntent?.admission).toMatchObject({
        outcome: "refused",
        code: "request-intent-outside-write-scope",
        boundary: {
          kind: "write-scope",
          observed: path,
          grant: [
            { kind: "root", path: "docs" },
            { kind: "root", path: "fern" },
          ],
        },
      });
      expect(run.proceeded).toBe(false);
      expect(run.exitCode).toBe(1);
      expect(run.records[0]).toMatchObject({
        status: "failed",
        error: "request-intent-outside-write-scope",
        steps: [],
      });
    },
  );

  it(
    "lets a review-documentation run go on when the reading names an update outside any scope",
    RUN_BUDGET,
    async () => {
      const instruction = "Update README.md for the 2.0 release.";
      const run = await interpretedRun({
        workflow: "review-documentation",
        instruction,
        replies: [reply("update", [{ path: "README.md" }])],
      });
      // A review writes nothing, so no write check applies, whatever the reading names.
      expect(run.requestIntent?.admission).toMatchObject({
        outcome: "advisory",
        code: "request-intent-operation-mismatch",
        boundary: null,
      });
      expect(run.proceeded, String(run.error)).toBe(true);
      expect(executedRequest()?.workflow).toBe("review-documentation");
    },
  );

  it("grants every reading the roots only, whatever operation it names", () => {
    const targets = [
      { path: "src/notes.md", role: "write", chosenFrom: "named", quote: "src/notes.md" },
    ] as const;
    const roots = [{ kind: "root", path: "docs" }] as const;
    const scope = (declaredOperation: RequestIntentOperation, operation: RequestIntentOperation) =>
      buildRequestIntentHostInputs(
        {
          instruction: "Restructure src/notes.md.",
          inventory: [],
          limits: resolveRequestIntentLimits(),
          declaredOperation,
          docsRoot: roots,
          writeRoots: roots,
          navigationSet: [],
        },
        {
          proposal: {
            operation,
            targets,
            sources: [],
            preserve: [],
            exclusions: [],
            constraints: [],
            authorityPreference: { preference: "unspecified", quote: null },
            questions: [],
          },
          existence: [],
        },
      ).grantedWriteScope;
    // Every plan writes only inside the roots, so no reading earns a file
    // entry beyond them: a mismatched reading, and a matched one too.
    expect(scope("update", "restructure")).toEqual(roots);
    expect(scope("restructure", "update")).toEqual(roots);
    expect(scope("restructure", "restructure")).toEqual(roots);
    expect(scope("update", "update")).toEqual(roots);
  });

  it.each([
    [
      "an update reading of src/notes.md under restructure-documentation",
      "restructure-documentation",
      "Restructure the notes in src/notes.md.",
      { operation: "update", path: "src/notes.md", chosenFrom: "named" },
    ],
    [
      "a review reading of AGENTS.md chosen from the inventory under update-documentation",
      "update-documentation",
      "Review the agent guide and fix whatever is stale.",
      { operation: "review", path: "AGENTS.md", chosenFrom: "inventory" },
    ],
  ] as const)(
    "refuses %s: a reading of another operation gets no grant beyond the roots",
    RUN_BUDGET,
    async (_name, workflow, instruction, target) => {
      const run = await interpretedRun({
        workflow,
        instruction,
        files: { "AGENTS.md": "# Agents\n", "src/notes.md": "# Notes\n" },
        replies: [
          reply(target.operation, [
            {
              path: target.path,
              chosenFrom: target.chosenFrom,
              quote: target.chosenFrom === "inventory" ? "the agent guide" : target.path,
            },
          ]),
        ],
      });
      expect(run.requestIntent?.admission).toMatchObject({
        outcome: "refused",
        code: "request-intent-outside-write-scope",
        boundary: { kind: "write-scope", observed: target.path },
      });
      expect(run.proceeded).toBe(false);
      expect(run.exitCode).toBe(1);
    },
  );

  it(
    "refuses a matched restructure of an existing page outside the roots before any step",
    RUN_BUDGET,
    async () => {
      const run = await interpretedRun({
        workflow: "restructure-documentation",
        instruction: "Restructure site/content/old.md into sections.",
        replies: [reply("restructure", [{ path: "site/content/old.md" }])],
      });
      expect(run.requestIntent?.admission).toMatchObject({
        outcome: "refused",
        code: "request-intent-outside-write-scope",
        boundary: {
          kind: "write-scope",
          observed: "site/content/old.md",
          remediation:
            "This run may write only docs, fern; name only paths inside it. To write a Markdown or MDX page outside it, add the page, or its directory, to documentationRoots in .docsfab.json; source, CI, and agent instruction files stay read-only.",
        },
      });
      expect(run.proceeded).toBe(false);
      expect(run.exitCode).toBe(1);
      // NEXT names the remedy a local run has, never an embedder's API, and
      // names it once: the refusal's remediation carries it, and the catalog
      // sentence after it adds only the commit and the new run.
      const record = run.records[0]!;
      const next = buildRunHumanNextCommand({
        record,
        recordPath: join("/state", `${record.id}.json`),
        exitCode: 1,
      })?.reason;
      expect(next).toContain(
        "To write a Markdown or MDX page outside it, add the page, or its directory, to documentationRoots in .docsfab.json; source, CI, and agent instruction files stay read-only. Commit any change to .docsfab.json, then start a new run once every path the request names is inside the write scope; nothing was written.",
      );
      expect(next?.split("documentationRoots")).toHaveLength(2);
      expect(next).not.toContain("authorizedWriteRoots");
    },
  );

  it(
    "admits the same restructure once documentationRoots lists the page's directory (control)",
    RUN_BUDGET,
    async () => {
      const run = await interpretedRun({
        workflow: "restructure-documentation",
        instruction: "Restructure site/content/old.md into sections.",
        documentationRoots: ["site/content"],
        replies: [reply("restructure", [{ path: "site/content/old.md" }])],
      });
      expect(run.requestIntent?.admission).toMatchObject({ outcome: "admitted", code: null });
      expect(run.proceeded, String(run.error)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// The CLI hands every run the write scope its plan must keep to, whatever the
// reading; runner plan admission enforces that scope, as plan-write-scope.test.ts
// and plan-write-scope-run.test.ts show.

describe("the plan rule the CLI hands every write run", () => {
  function handedRule() {
    return (capture.invocations[0] as CliRunInvocation | undefined)?.planWriteScope;
  }

  it(
    "confines an advisory update's plan to the documentation write roots",
    RUN_BUDGET,
    async () => {
      const run = await interpretedRun({
        workflow: "update-documentation",
        instruction: "Fix whatever is stale in the docs.",
        replies: [reply("update", [])],
      });
      expect(run.proceeded, String(run.error)).toBe(true);
      const rule = handedRule();
      expect(rule?.roots).toEqual(["docs/", "fern/"]);
      expect(rule?.rule("AGENTS.md")).toBeDefined();
      expect(rule?.rule("src/notes.md")).toBeDefined();
      expect(rule?.rule("docs/a.md")).toBeUndefined();
    },
  );

  it("uses the configured documentationRoots for the rule", RUN_BUDGET, async () => {
    const run = await interpretedRun({
      workflow: "restructure-documentation",
      instruction: "Restructure the documentation so the tasks come first.",
      documentationRoots: ["site/content"],
      replies: [reply("restructure", [])],
    });
    expect(run.proceeded, String(run.error)).toBe(true);
    const rule = handedRule();
    expect(rule?.roots).toEqual(["site/content/"]);
    expect(rule?.rule("site/content/new.md")).toBeUndefined();
    expect(rule?.rule("docs/a.md")).toBeDefined();
  });

  it.each([
    [
      "an admitted update",
      "update-documentation",
      "Update docs/a.md for the release.",
      reply("update", [{ path: "docs/a.md" }]),
    ],
    [
      "an admitted restructure",
      "restructure-documentation",
      "Restructure docs/guide.md so the requirements come first.",
      reply("restructure", [{ path: "docs/guide.md" }]),
    ],
  ] as const)(
    "hands the same rule to %s",
    RUN_BUDGET,
    async (_name, workflow, instruction, answer) => {
      const run = await interpretedRun({ workflow, instruction, replies: [answer] });
      expect(run.requestIntent?.admission.outcome).toBe("admitted");
      expect(run.proceeded, String(run.error)).toBe(true);
      expect(capture.invocations).toHaveLength(1);
      const rule = handedRule();
      expect(rule?.roots).toEqual(["docs/", "fern/"]);
      expect(rule?.rule("AGENTS.md")).toBeDefined();
      expect(rule?.rule("docs/a.md")).toBeUndefined();
    },
  );

  it("hands a file root as exactly that file", RUN_BUDGET, async () => {
    const run = await interpretedRun({
      workflow: "update-documentation",
      instruction: "Update README.md for the 2.0 release.",
      documentationRoots: ["docs", "README.md"],
      replies: [reply("update", [{ path: "README.md" }])],
    });
    expect(run.proceeded, String(run.error)).toBe(true);
    const rule = handedRule();
    expect(rule?.roots).toEqual(["README.md", "docs/"]);
    expect(rule?.rule("README.md")).toBeUndefined();
    for (const path of ["README.md.md", "README.md/x.md", "readme.md", "RELEASE.md"]) {
      expect(rule?.rule(path), path).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// request-intent-model-question: the model's own question.

describe("a question the model asks goes unanswered, and the run goes on", () => {
  const instruction =
    "Create a support section. Add docs/support/overview.md, and link the new section from docs/a.md.";
  const question = {
    question:
      "Linking the new section means editing an existing page, which this create run cannot write. How should the link be handled?",
    options: ["Create the page now and link it in a later update.", "Use an update run."],
    recommendedDefault: "Create the page now and link it in a later update.",
    consequence: "docs/a.md stays unchanged in this run.",
  };

  it("records the model's question as an advisory and reaches execution", RUN_BUDGET, async () => {
    const reading = JSON.parse(reply("create", [{ path: "docs/support/overview.md" }]));
    const run = await interpretedRun({
      workflow: "create-documentation",
      instruction,
      replies: [JSON.stringify({ ...reading, questions: [question] })],
    });
    expect(run.requestIntent?.admission).toMatchObject({
      outcome: "advisory",
      code: "request-intent-model-question",
      location: "$.questions[0]",
    });
    expect(run.proceeded, String(run.error)).toBe(true);
    expect(run.records).toEqual([]);
    expect(run.exitCode).toBeUndefined();
    // Kept on the record, unanswered.
    expect(run.requestIntent!.intent!.question).toEqual(question);
    expect(intentLines(run.requestIntent, instruction)).toEqual([
      "Admission: advisory (request-intent-model-question)",
      "Advisory: The request interpretation found a choice only the operator can make. DocsFab recorded its question as advisory, unanswered, and the run went on.",
      "Operation: create",
      "Target: docs/support/overview.md · write · named",
      "Authority preference: unspecified",
      `Question: ${question.question}`,
      `Options: ${question.options.join(" | ")}`,
      `Recommended: ${question.recommendedDefault}`,
      "Model calls: 1",
      "Model tokens: 3 input, 2 output (not in the run's usage)",
      "Clipped titles: 0",
    ]);
  });
});

// ---------------------------------------------------------------------------
// request-intent-target-absent for a restructure's new destination page.

describe("a restructure may name new destination pages when its source page exists", () => {
  it(
    "admits a split into a new page under the documentation roots and goes on",
    RUN_BUDGET,
    async () => {
      const instruction =
        "Split docs/guide.md into two pages: keep Requirements in docs/guide.md, and move Errors and More help into a new page docs/errors.md linked from docs/guide.md.";
      const run = await interpretedRun({
        workflow: "restructure-documentation",
        instruction,
        replies: [reply("restructure", [{ path: "docs/guide.md" }, { path: "docs/errors.md" }])],
      });
      expect(run.requestIntent?.admission).toMatchObject({ outcome: "admitted", code: null });
      expect(run.proceeded, String(run.error)).toBe(true);
      expect(run.requestIntent!.intent!.targets.map((target) => target.path)).toEqual([
        "docs/guide.md",
        "docs/errors.md",
      ]);
    },
  );

  it("still asks when no page the restructure names exists", RUN_BUDGET, async () => {
    const instruction = "Move the Errors section into a new page docs/errors.md.";
    const run = await interpretedRun({
      workflow: "restructure-documentation",
      instruction,
      replies: [reply("restructure", [{ path: "docs/errors.md" }])],
    });
    expect(run.proceeded).toBe(false);
    expect(run.exitCode).toBe(2);
    expect(run.requestIntent?.admission).toMatchObject({
      outcome: "question",
      code: "request-intent-target-absent",
      location: "$.targets[0].path",
    });
  });

  it("refuses a new page outside the documentation roots", RUN_BUDGET, async () => {
    const instruction = "Split docs/guide.md and move Errors into a new page notes/errors.md.";
    const run = await interpretedRun({
      workflow: "restructure-documentation",
      instruction,
      replies: [reply("restructure", [{ path: "docs/guide.md" }, { path: "notes/errors.md" }])],
    });
    // The restructure could never write it, so no existence question is asked.
    expect(run.proceeded).toBe(false);
    expect(run.exitCode).toBe(1);
    expect(run.requestIntent?.admission).toMatchObject({
      outcome: "refused",
      code: "request-intent-outside-write-scope",
      location: "$.targets[1].path",
      boundary: { kind: "write-scope", observed: "notes/errors.md" },
    });
  });
});

// ---------------------------------------------------------------------------
// request-intent-outside-write-scope for a README documentationRoots lists.

describe("a page that documentationRoots lists as a file is in the write scope", () => {
  it(
    "admits a package README that documentationRoots lists, named in the request, and goes on",
    RUN_BUDGET,
    async () => {
      const run = await interpretedRun({
        workflow: "update-documentation",
        instruction:
          "Update the pages under site/pages and packages/widget-config/README.md so that every example uses the current model.",
        documentationRoots: ["site/pages", "packages/widget-config/README.md"],
        files: {
          "site/pages/models.md": "# Models\n",
          "packages/widget-config/README.md": "# Widget config\n",
        },
        replies: [reply("update", [{ path: "packages/widget-config/README.md" }])],
      });
      expect(run.requestIntent?.admission).toMatchObject({
        outcome: "admitted",
        code: null,
        boundary: null,
      });
      expect(run.proceeded, String(run.error)).toBe(true);
      // The prompt still lists the file among the documentation roots.
      expect(run.port.calls[0]!.prompt).toContain(
        '["packages/widget-config/README.md","site/pages"]',
      );
    },
  );

  it("maps a root to a file entry only where the revision tracks a regular page", () => {
    const configured = [
      "packages/widget-config/README.md",
      "README.md",
      "docs/index.MDX",
      "docs/api.md",
      "docs",
      "docs/config.yaml",
    ];
    // What preflight lists: the configured entries the revision tracks as regular files.
    const tracked = ["packages/widget-config/README.md", "README.md", "docs/index.MDX"];
    const resolved = firstPassDocumentationWriteRoots(configured, "local-widen", [
      ...tracked,
      "docs/config.yaml",
    ]);
    expect(resolved.roots.map((root) => requestIntentRootScope(root))).toEqual([
      { kind: "file", path: "README.md" },
      { kind: "root", path: "docs" },
      // A directory named like a page, which nothing tracks as a file, stays a directory.
      { kind: "root", path: "docs/api.md" },
      { kind: "file", path: "packages/widget-config/README.md" },
    ]);
    // A tracked file that is not a page in the page alphabet grants nothing.
    expect(resolved.dropped).toEqual(["docs/index.MDX", "docs/config.yaml"]);
  });

  it(
    "admits a page under a documentationRoots directory named like a page (docs/api.md/)",
    RUN_BUDGET,
    async () => {
      const run = await interpretedRun({
        workflow: "update-documentation",
        instruction: "Update docs/api.md/intro.md for the 2.0 release.",
        documentationRoots: ["docs/api.md"],
        files: { "docs/api.md/intro.md": "# Intro\n" },
        replies: [reply("update", [{ path: "docs/api.md/intro.md" }])],
      });
      expect(run.requestIntent?.admission).toMatchObject({ outcome: "admitted", code: null });
      expect(run.proceeded, String(run.error)).toBe(true);
    },
  );

  it("admits a root README.md that documentationRoots lists beside docs", RUN_BUDGET, async () => {
    const run = await interpretedRun({
      workflow: "update-documentation",
      instruction: "Update README.md for the 2.0 release.",
      documentationRoots: ["docs", "README.md"],
      replies: [reply("update", [{ path: "README.md" }])],
    });
    expect(run.requestIntent?.admission).toMatchObject({ outcome: "admitted", code: null });
    expect(run.proceeded, String(run.error)).toBe(true);
  });

  it.each([["README.md", "Update README.md for the 2.0 release."]])(
    "refuses a unique root update basename %s before interpretation or a saved record",
    RUN_BUDGET,
    async (path, instruction) => {
      const run = await interpretedRun({
        workflow: "update-documentation",
        instruction,
        replies: [reply("update", [{ path }])],
      });
      expect(run.proceeded).toBe(false);
      expect(run.port.calls).toHaveLength(0);
      expect(run.requestIntent).toBeUndefined();
      expect(run.records).toEqual([]);
      expect(run.error).toMatchObject({
        name: "ExplicitDocumentationWriteScopeError",
        code: "request-intent-outside-write-scope",
      });
      expect((run.error as Error).message).toContain(path);
      expect(toOperatorErrorEnvelope(run.error)).toMatchObject({
        failure: { class: "planning-refusal", code: "request-intent-outside-write-scope" },
      });
    },
  );

  it(
    "retains the post-interpretation refusal for an ambiguous README basename outside roots",
    RUN_BUDGET,
    async () => {
      const path = "README.md";
      const run = await interpretedRun({
        workflow: "update-documentation",
        instruction: "Update README.md for the 2.0 release.",
        files: { "docs/README.md": "# Nested documentation\n" },
        replies: [reply("update", [{ path }])],
      });
      expect(run.port.calls).toHaveLength(1);
      expect(run.proceeded).toBe(false);
      expect(run.exitCode).toBe(1);
      expect(run.requestIntent?.admission).toMatchObject({
        outcome: "refused",
        code: "request-intent-outside-write-scope",
        boundary: {
          kind: "write-scope",
          observed: path,
          grant: [
            { kind: "root", path: "docs" },
            { kind: "root", path: "fern" },
          ],
        },
      });
      expect(run.records[0]).toMatchObject({
        status: "failed",
        error: "request-intent-outside-write-scope",
      });
    },
  );

  it(
    "refuses an explicit page outside configured roots before interpretation",
    RUN_BUDGET,
    async () => {
      const run = await interpretedRun({
        workflow: "update-documentation",
        instruction: "Update site/content/old.md for the 2.0 release.",
        replies: [reply("update", [{ path: "site/content/old.md" }])],
      });
      expect(run.port.calls).toHaveLength(0);
      expect(run.proceeded).toBe(false);
      expect(run.records).toEqual([]);
      expect(run.error).toMatchObject({
        name: "ExplicitDocumentationWriteScopeError",
        code: "request-intent-outside-write-scope",
        nextAction: expect.stringContaining("documentationRoots"),
      });
      expect(toOperatorErrorEnvelope(run.error)).toMatchObject({
        code: "request-intent-outside-write-scope",
        failure: { class: "planning-refusal", code: "request-intent-outside-write-scope" },
        nextAction: expect.stringContaining("documentationRoots"),
      });
    },
  );
});

// ---------------------------------------------------------------------------
// request-intent-max-prompt-inventory-entries-bound for a large repository.

describe("the prompt inventory bound fits a 600-page repository and can be raised", () => {
  const NAME = "requestIntent.maxPromptInventoryEntries";
  const OVERRIDE = "DOCSFAB_REQUEST_INTENT_MAX_PROMPT_INVENTORY_ENTRIES";

  const pages = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      path: `docs/p-${String(index).padStart(5, "0")}.md`,
      kind: "regular",
      byteLength: 0,
    }));

  it("defaults above FastMCP's page count and declares a maximum above its default", () => {
    const definition = limitDefinition(NAME);
    expect(definition.value).toBeGreaterThan(FASTMCP_PAGES);
    expect(definition.max).toBeGreaterThan(definition.value);
    expect(definition.override).toBe(OVERRIDE);
    expect(definition.scope).not.toBe("sealed");
  });

  it("admits a raised bound at the limit and refuses the limit plus one", async () => {
    const raised = limitDefinition(NAME).value * 2;
    const bound = limit(NAME, {
      environment: { [OVERRIDE]: String(raised) },
      hostFile: null,
      projectFile: null,
    });
    expect(bound).toMatchObject({ value: raised, source: "host" });
    const limits = {
      maxPromptInventoryEntries: bound,
      maxInventoryTitleChars: limit("requestIntent.maxInventoryTitleChars"),
      maxInventoryPathChars: limit("requestIntent.maxInventoryPathChars"),
      maxPageBytes: limit("authoring.plannedPageMaxBytes"),
    };
    const read = async () => new Uint8Array();
    const at = await buildRequestIntentPromptInventory({
      entries: pages(raised),
      readTrackedBytes: read,
      docsRoots: ["docs/"],
      limits,
    });
    expect(at.entries).toHaveLength(raised);
    const over = buildRequestIntentPromptInventory({
      entries: pages(raised + 1),
      readTrackedBytes: read,
      docsRoots: ["docs/"],
      limits,
    });
    await expect(over).rejects.toMatchObject({
      code: "request-intent-max-prompt-inventory-entries-bound",
      observed: raised + 1,
    });
    await expect(over).rejects.toBeInstanceOf(OperationalLimitError);
  });

  it(
    "interprets a repository with FastMCP's 598 documentation pages and goes on",
    RUN_BUDGET,
    async () => {
      const files = Object.fromEntries(
        pages(FASTMCP_PAGES).map((page, index) => [page.path, `# Page ${String(index)}\n`]),
      );
      const run = await interpretedRun({
        workflow: "update-documentation",
        instruction: "Update docs/a.md for the new retention settings.",
        files,
        replies: [reply("update", [{ path: "docs/a.md" }])],
      });
      expect(run.error).not.toBeInstanceOf(OperationalLimitError);
      expect(run.proceeded, String(run.error)).toBe(true);
      expect(run.requestIntent?.admission.outcome).toBe("admitted");
      // Every page under the roots is listed, with docs/a.md and docs/guide.md.
      const listed = run.port.calls[0]!.prompt.split("\n").filter((line) =>
        line.startsWith('{"path":"docs/'),
      );
      expect(listed).toHaveLength(FASTMCP_PAGES + 2);
    },
  );
});

// ---------------------------------------------------------------------------
// Publication prohibitions stay fail-closed for do.

describe("a do request that says not to publish is still refused when it would publish", () => {
  const request = `${CHECK_REQUEST} Do not publish.`;

  it(
    "refuses publication-prohibition-conflict before any run or interpretation",
    RUN_BUDGET,
    async () => {
      const run = await doRun({ args: [request], replies: [reply("review", [])] });
      expect(run.error).toMatchObject({
        code: "publication-prohibition-conflict",
        nextAction: "Pass --patch-only to retain a local patch without publishing.",
      });
      expect(toOperatorErrorEnvelope(run.error)).toMatchObject({
        code: "publication-prohibition-conflict",
        failure: { class: "operator-input" },
      });
      expect(run.routed).toEqual([]);
      expect(run.port.calls).toHaveLength(0);
      expect(run.records).toEqual([]);
    },
  );

  it(
    "lets the same request run with --patch-only, its reading still advisory",
    RUN_BUDGET,
    async () => {
      const run = await doRun({ args: [request, "--patch-only"], replies: [reply("review", [])] });
      expect(run.routed).toEqual(["update-documentation"]);
      expect(run.proceeded, String(run.error)).toBe(true);
      expect(run.requestIntent?.admission.outcome).toBe("advisory");
    },
  );
});

// ---------------------------------------------------------------------------
// The recorded field: an advisory reading continues and never carries a question.

describe("the recorded advisory reading", () => {
  async function advisoryRecord(): Promise<RunRecordRequestIntentV1> {
    const run = await interpretedRun({
      workflow: "update-documentation",
      instruction: CHECK_REQUEST,
      replies: [reply("review", [])],
    });
    expect(run.requestIntent?.admission.outcome).toBe("advisory");
    return JSON.parse(JSON.stringify(run.requestIntent)) as RunRecordRequestIntentV1;
  }

  it("decodes from the record and verifies its sealed reading", RUN_BUDGET, async () => {
    const recorded = await advisoryRecord();
    expect(decodeRunRecordRequestIntent(recorded, CHECK_REQUEST)).toEqual(recorded);
  });

  it.each([
    [
      "without a code",
      (recorded: RunRecordRequestIntentV1) => ({
        ...recorded,
        admission: { ...recorded.admission, code: null },
      }),
    ],
    [
      "without a model call",
      (recorded: RunRecordRequestIntentV1) => ({
        ...recorded,
        admission: { ...recorded.admission, calls: [] },
      }),
    ],
    [
      "without its reading",
      (recorded: RunRecordRequestIntentV1) => ({ ...recorded, intent: null }),
    ],
    [
      "for the model's question without the question",
      (recorded: RunRecordRequestIntentV1) => ({
        ...recorded,
        admission: { ...recorded.admission, code: "request-intent-model-question" },
      }),
    ],
    [
      "under a refusal code",
      (recorded: RunRecordRequestIntentV1) => ({
        ...recorded,
        admission: { ...recorded.admission, code: "request-intent-outside-write-scope" },
      }),
    ],
    [
      "whose host finding carries a question",
      (recorded: RunRecordRequestIntentV1) => {
        const { schemaVersion: _version, kind: _kind, digest: _digest, ...body } = recorded.intent!;
        const question = {
          question: "Which workflow is meant?",
          options: ["update", "stop"],
          recommendedDefault: "stop",
          consequence: "Nothing is written.",
        };
        // Sealed again, so only the advisory rule, not the digest, refuses it.
        return { ...recorded, intent: sealRequestIntent({ ...body, question }) };
      },
    ],
  ])("refuses an advisory record %s", RUN_BUDGET, async (_name, edit) => {
    const recorded = await advisoryRecord();
    expect(() => decodeRunRecordRequestIntent(edit(recorded), CHECK_REQUEST)).toThrow(
      RequestIntentContractError,
    );
  });
});
