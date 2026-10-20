// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The repository-aware host inputs of the request interpretation at their
 * shipped call site: every admission input, the existence matrix over the
 * real collision oracle, the per-operation write scope, the empty navigation
 * set, the operation question, the host question bound, and suffix grounding.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.hoisted(() => ({ invocations: [] as unknown[] }));
const admissions = vi.hoisted(() => [] as unknown[]);
const asked = vi.hoisted(() => [] as string[][]);
const STOP_AT_EXECUTION = "test sentinel: the run reached workflow execution";

// First-pass binding after an admitted interpretation is unchanged by these
// inputs; stopping short of it keeps each cell about the interpretation.
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

vi.mock("../src/request-intent/admit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/request-intent/admit.js")>();
  return {
    ...actual,
    admitRequestIntent: (...args: Parameters<typeof actual.admitRequestIntent>) => {
      admissions.push(args[1]);
      return actual.admitRequestIntent(...args);
    },
  };
});

vi.mock("../src/workflow-execution/authoring-workspace-host.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/workflow-execution/authoring-workspace-host.js")>();
  return {
    ...actual,
    plannedTargetCollisions: (
      ...args: Parameters<typeof actual.plannedTargetCollisions>
    ): ReturnType<typeof actual.plannedTargetCollisions> => {
      asked.push([...args[1]]);
      return actual.plannedTargetCollisions(...args);
    },
  };
});

import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { DocumentationRootsOutsideWriteRootsError } from "../src/cli/first-pass.js";
import { handleDoCommand } from "../src/cli/commands/do.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import {
  droppedRootsConfigurationRefusal,
  persistRequestIntentStop,
  requestIntentRootScope,
  requestInterpretationStep,
} from "../src/cli/run/request-intent-stop.js";
import type { CliRunInvocation, RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import { limit, OperationalLimitError } from "../src/config/limits.js";
import { assertDocsFabProjectConfig } from "../src/init/project-config.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type { RunRecord } from "../src/records/contracts.js";
import { withRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import type {
  RequestIntentExistenceKind,
  RequestIntentOperation,
  RequestIntentPathScope,
  RequestIntentQuestion,
} from "../src/request-intent/contract.js";
import {
  requestIntentExistenceAnswers,
  requestIntentExistenceKind,
} from "../src/request-intent/interpret-existence.js";
import {
  decodeRunRecordRequestIntent,
  formatRequestIntentLines,
} from "../src/request-intent/interpret-record.js";
import {
  buildRequestIntentHostInputs,
  enforceRequestIntentQuestionBounds,
  interpretRequest,
  type RequestIntentInterpreterCall,
  type RequestIntentInterpreterPort,
} from "../src/request-intent/interpret.js";
import { RequestIntentContractError } from "../src/request-intent/kit.js";
import { toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";
import { resolveRequestIntentLimits } from "../src/request-intent/limits.js";
import {
  targetAbsent,
  targetCaseAmbiguous,
  targetMissing,
  targetNotFile,
  targetPresent,
} from "../src/request-intent/supply.js";
import { plannedTargetCollisions } from "../src/workflow-execution/authoring-workspace-host.js";
import type { PlannedTargetCollisionV1 } from "../src/workflow-execution/plan-binding.js";
import { validModelConfig } from "./helpers.js";
import { git, initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = temporaryRoots();
const DEFAULT_ROOTS: readonly RequestIntentPathScope[] = [
  { kind: "root", path: "docs" },
  { kind: "root", path: "fern" },
];
const SHA = "a".repeat(64);

beforeEach(() => {
  capture.invocations.length = 0;
  admissions.length = 0;
  asked.length = 0;
});

afterEach(() => {
  process.exitCode = undefined;
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
  "docs/b.md": "# Beta\n",
  "docs/CLI.md": "# CLI\n",
  "docs/index.md": "# Index\n",
  "docs/guide/start.md": "# Start\n",
  "site/content/old.md": "# Old\n",
};

/** Real tracked duplicates let a case reach the interpreter's later admission check. */
async function fixture(
  documentationRoots?: readonly string[],
  extraFiles: Readonly<Record<string, string>> = {},
): Promise<{ repositoryPath: string; stateDirectory: string }> {
  const root = await roots.create("docsfab-intent-host-");
  const repositoryPath = join(root, "repo");
  await initFixtureRepo(repositoryPath, {
    ...BASE_FILES,
    ...extraFiles,
    ".docsfab.json": `${JSON.stringify({
      schemaVersion: 1,
      gitlab: { remote: "origin", defaultBranch: "main" },
      provider: { configuration: "host" },
      storage: { scope: "user-private" },
      ...(documentationRoots ? { documentationRoots } : {}),
    })}\n`,
  });
  return { repositoryPath, stateDirectory: await roots.create("docsfab-intent-host-state-") };
}

function runRequest(
  repositoryPath: string,
  workflow: RunRequestWithPublishProjection["workflow"],
  instruction: string,
  extra: Partial<RunRequestWithPublishProjection> = {},
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
    ...extra,
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

async function trackedPaths(repositoryPath: string): Promise<string[]> {
  return (await git(repositoryPath, ["ls-files"])).split("\n").sort();
}

/** One interpreted run: its outcome, the record or captured request, and every admission input. */
async function interpretedRun(input: {
  readonly workflow: RunRequestWithPublishProjection["workflow"];
  readonly instruction: string;
  readonly replies: readonly string[];
  readonly documentationRoots?: readonly string[];
  readonly files?: Readonly<Record<string, string>>;
  readonly maxRetries?: number;
  readonly extra?: Partial<RunRequestWithPublishProjection>;
}) {
  const { repositoryPath, stateDirectory } = await fixture(input.documentationRoots, input.files);
  const head = await git(repositoryPath, ["rev-parse", "HEAD"]);
  const port = stubPort(input.replies);
  const run = await captured(() =>
    executeRunRequest(
      runRequest(repositoryPath, input.workflow, input.instruction, input.extra),
      stubConfig(stateDirectory, input.maxRetries ?? 0),
      { requestInterpreter: port },
    ),
  );
  expect(await git(repositoryPath, ["status", "--porcelain"])).toBe("");
  expect(await git(repositoryPath, ["rev-parse", "HEAD"])).toBe(head);
  const proceeded = (run.error as Error | undefined)?.message === STOP_AT_EXECUTION;
  const records = await savedRecords(stateDirectory);
  const requestIntent = proceeded
    ? (capture.invocations[0] as CliRunInvocation).request.requestIntent
    : records[0]?.requestIntent;
  return {
    ...run,
    port,
    proceeded,
    exitCode: process.exitCode,
    records,
    requestIntent,
    repositoryPath,
    stateDirectory,
  };
}

/** The full admission input the last attempt passed, the inventory compared separately. */
async function expectAdmissionInput(
  repositoryPath: string,
  expected: {
    readonly instruction: string;
    readonly declaredOperation: RequestIntentOperation;
    readonly docsRoot: readonly RequestIntentPathScope[];
    readonly grantedWriteScope: readonly RequestIntentPathScope[];
    readonly existence: readonly { path: string; existing: RequestIntentExistenceKind }[];
  },
): Promise<void> {
  const input = admissions.at(-1) as { inventory: readonly string[] };
  expect([...input.inventory].sort()).toEqual(await trackedPaths(repositoryPath));
  expect(input).toEqual({
    ...expected,
    inventory: input.inventory,
    limits: resolveRequestIntentLimits(),
    navigationSet: [],
  });
}

// ---------------------------------------------------------------------------
// Row 6: host inputs and the existence matrix.

const MATRIX_PATHS: Readonly<
  Record<Exclude<RequestIntentExistenceKind, "file-not-granted">, string>
> = {
  file: "docs/a.md",
  // Tracked as docs/CLI.md: only a case fold reaches it, so the oracle gives no base.
  "case-fold": "docs/cli.md",
  directory: "docs/guide",
  "parent-file": "docs/a.md/child.md",
  absent: "docs/new.md",
};

const WORKFLOW_OF: Readonly<
  Record<RequestIntentOperation, RunRequestWithPublishProjection["workflow"]>
> = {
  create: "create-documentation",
  update: "update-documentation",
  restructure: "restructure-documentation",
  review: "review-documentation",
};

/** The arm admission gives each cell: undefined admits, a code is the Supply question. */
function expectedArm(
  operation: RequestIntentOperation,
  existing: Exclude<RequestIntentExistenceKind, "file-not-granted">,
): string | undefined {
  if (operation === "create") {
    return existing === "absent" ? undefined : "request-intent-target-present";
  }
  return {
    file: undefined,
    "case-fold": "request-intent-target-case-ambiguous",
    directory: "request-intent-target-not-file",
    "parent-file": "request-intent-target-not-file",
    absent: "request-intent-target-absent",
  }[existing];
}

const MATRIX = (["create", "update", "restructure", "review"] as const).flatMap((operation) =>
  (Object.keys(MATRIX_PATHS) as (keyof typeof MATRIX_PATHS)[]).map(
    (existing) => [operation, existing] as const,
  ),
);

describe("host inputs and the existence matrix (row 6)", () => {
  it.each(MATRIX)("%s of a target that is %s", async (operation, existing) => {
    const path = MATRIX_PATHS[existing];
    const instruction = `Work on ${path} for the release.`;
    const run = await interpretedRun({
      workflow: WORKFLOW_OF[operation],
      instruction,
      replies: [reply(operation, [{ path }])],
    });
    expect(run.requestIntent!.admission.outcome).not.toBe("offline");
    expect(run.port.calls).toHaveLength(1);
    expect(asked).toEqual([[path]]);
    await expectAdmissionInput(run.repositoryPath, {
      instruction,
      declaredOperation: operation,
      docsRoot: DEFAULT_ROOTS,
      // Every operation's targets stay under the roots its plan keeps to.
      grantedWriteScope: DEFAULT_ROOTS,
      existence: [{ path, existing }],
    });
    const code = expectedArm(operation, existing);
    if (code === undefined) {
      expect(run.proceeded).toBe(true);
      expect(run.requestIntent!.admission.outcome).toBe("admitted");
      return;
    }
    expect(run.proceeded).toBe(false);
    expect(run.exitCode).toBe(2);
    const [record] = run.records;
    expect(record).toMatchObject({ status: "needs-input", steps: [], error: code });
    expect(record!.requestIntent!.admission).toMatchObject({ outcome: "question", code });
    // runs show renders the Supply question: code, question, options, default.
    const lines = formatRequestIntentLines(record!);
    expect(lines[0]).toBe(`Admission: question (${code})`);
    expect(lines).toContain(`Question: ${record!.requestIntent!.intent!.question!.question}`);
    expect(lines).toContain(
      `Options: ${record!.requestIntent!.intent!.question!.options.join(" | ")}`,
    );
    expect(lines).toContain("Recommended: stop");
    expect(record!.requestIntent!.intent!.question!.question).toContain(path);
  });

  it("passes the roots to an update without --allow-write, which keeps the runner's grant stop", async () => {
    const instruction = "Update docs/a.md for the release.";
    const run = await interpretedRun({
      workflow: "update-documentation",
      instruction,
      replies: [reply("update", [{ path: "docs/a.md" }])],
      extra: { allowWrite: false },
    });
    expect(run.requestIntent!.admission.outcome).toBe("admitted");
    expect(run.proceeded).toBe(true);
    expect((capture.invocations[0] as CliRunInvocation).request.allowWrite).toBe(false);
    await expectAdmissionInput(run.repositoryPath, {
      instruction,
      declaredOperation: "update",
      docsRoot: DEFAULT_ROOTS,
      grantedWriteScope: DEFAULT_ROOTS,
      existence: [{ path: "docs/a.md", existing: "file" }],
    });
  });

  it("reads a local-widen site/content root from .docsfab.json for the prompt and admission", async () => {
    const instruction = "Create site/content/new.md for the release.";
    const run = await interpretedRun({
      workflow: "create-documentation",
      instruction,
      documentationRoots: ["site/content"],
      replies: [reply("create", [{ path: "site/content/new.md" }])],
    });
    expect(run.requestIntent!.admission.outcome).toBe("admitted");
    expect(run.proceeded).toBe(true);
    const siteRoot = [{ kind: "root", path: "site/content" }] as const;
    await expectAdmissionInput(run.repositoryPath, {
      instruction,
      declaredOperation: "create",
      docsRoot: siteRoot,
      grantedWriteScope: siteRoot,
      existence: [{ path: "site/content/new.md", existing: "absent" }],
    });
    // The prompt lists the configured root and its pages, not docs/ and fern/.
    const prompt = run.port.calls[0]!.prompt;
    expect(prompt).toContain('["site/content"]');
    expect(prompt).toContain('{"path":"site/content/old.md","title":"Old","navLabel":null}');
    expect(prompt).not.toContain('"path":"docs/a.md"');
  });

  it("refuses a create whose configuration leaves no documentation root before any model call", async () => {
    const run = await interpretedRun({
      workflow: "create-documentation",
      instruction: "Create docs/new.md for the release.",
      documentationRoots: ["src"],
      replies: [reply("create", [{ path: "docs/new.md" }])],
    });
    expect(run.port.calls).toHaveLength(0);
    expect(run.proceeded).toBe(false);
    expect((run.error as { code?: string }).code).toBe("documentation-roots-outside-write-roots");
    expect(run.records).toEqual([]);
  });

  it("refuses an update's inventory page as configuration when no documentation root is left", async () => {
    const instruction = "Refresh the alpha page for the release.";
    const run = await interpretedRun({
      workflow: "update-documentation",
      instruction,
      documentationRoots: ["src"],
      replies: [reply("update", [{ path: "docs/a.md", chosenFrom: "inventory", quote: "alpha" }])],
    });
    // No root is left for any page the plan could write, the inventory page included.
    expect(run.port.calls).toHaveLength(1);
    expect(run.proceeded).toBe(false);
    expect(run.error).toBeInstanceOf(DocumentationRootsOutsideWriteRootsError);
    await expectAdmissionInput(run.repositoryPath, {
      instruction,
      declaredOperation: "update",
      docsRoot: [],
      grantedWriteScope: [],
      existence: [{ path: "docs/a.md", existing: "file" }],
    });
  });

  // Configuration dropped every root, so a page the request names has no root
  // to sit under. The destination probe reaches the same configuration refusal
  // before inference, never a model-content write-scope or docs-root stop.
  it.each([
    [
      "names an existing page to update",
      "Update docs/a.md for the release.",
      "update",
      "docs/a.md",
    ],
    [
      "names an absent page, before its question",
      "Update docs/new.md now.",
      "update",
      "docs/new.md",
    ],
    ["reads a new page on a declared update", "Update docs/new.md now.", "create", "docs/new.md"],
  ] as const)(
    "refuses a reading that %s as configuration when no documentation root is left",
    async (_label, instruction, operation, path) => {
      const run = await interpretedRun({
        workflow: "update-documentation",
        instruction,
        documentationRoots: ["src"],
        replies: [reply(operation, [{ path }])],
      });
      expect(run.port.calls).toHaveLength(0);
      expect(run.proceeded).toBe(false);
      expect(run.records).toEqual([]);
      expect(run.error).toBeInstanceOf(DocumentationRootsOutsideWriteRootsError);
      const envelope = toOperatorErrorEnvelope(run.error);
      expect(envelope.code).toBe("documentation-roots-outside-write-roots");
      expect(envelope.message).toBe(
        new DocumentationRootsOutsideWriteRootsError(["src"], "local-widen").message,
      );
      expect(envelope.failure).toMatchObject({
        class: "planning-refusal",
        code: "documentation-roots-outside-write-roots",
      });
      expect(envelope.nextAction).toMatch(/^Fix documentationRoots in \.docsfab\.json/u);
      expect(run.logs.join("\n")).not.toContain("authorizedWriteRoots");
    },
  );

  it.each([
    ["restructure-documentation", "restructure", "named"],
    ["update-documentation", "update", "inventory"],
  ] as const)(
    "refuses a %s reading as configuration when no documentation root is left",
    async (workflow, operation, chosenFrom) => {
      const run = await interpretedRun({
        workflow,
        instruction: "Work on docs/a.md for the release.",
        documentationRoots: ["src"],
        replies: [reply(operation, [{ path: "docs/a.md", chosenFrom }])],
      });
      expect(run.proceeded).toBe(false);
      expect(run.error).toBeInstanceOf(DocumentationRootsOutsideWriteRootsError);
    },
  );

  it("keeps a review reading going when no documentation root is left (adjacent)", async () => {
    const run = await interpretedRun({
      workflow: "review-documentation",
      instruction: "Work on docs/a.md for the release.",
      documentationRoots: ["src"],
      replies: [reply("review", [{ path: "docs/a.md" }])],
    });
    expect(run.requestIntent!.admission.outcome).toBe("admitted");
    expect(run.proceeded).toBe(true);
  });

  it("refuses an update's inventory page outside the roots, as plan admission would", async () => {
    const instruction = "Refresh the project readme for the release.";
    const run = await interpretedRun({
      workflow: "update-documentation",
      instruction,
      replies: [reply("update", [{ path: "README.md", chosenFrom: "inventory", quote: "readme" }])],
    });
    expect(run.proceeded).toBe(false);
    expect(run.exitCode).toBe(1);
    expect(run.requestIntent!.admission).toMatchObject({
      outcome: "refused",
      code: "request-intent-outside-write-scope",
      boundary: { kind: "write-scope", grant: DEFAULT_ROOTS, observed: "README.md" },
    });
    await expectAdmissionInput(run.repositoryPath, {
      instruction,
      declaredOperation: "update",
      docsRoot: DEFAULT_ROOTS,
      grantedWriteScope: DEFAULT_ROOTS,
      existence: [{ path: "README.md", existing: "file" }],
    });
  });

  it("admits the same inventory page once documentationRoots lists it as a file (control)", async () => {
    const run = await interpretedRun({
      workflow: "update-documentation",
      instruction: "Refresh the project readme for the release.",
      documentationRoots: ["docs", "README.md"],
      replies: [reply("update", [{ path: "README.md", chosenFrom: "inventory", quote: "readme" }])],
    });
    expect(run.requestIntent!.admission.outcome).toBe("admitted");
    expect(run.proceeded).toBe(true);
  });

  it("refuses an interpreted ambiguous basename outside the roots (adjacent)", async () => {
    const run = await interpretedRun({
      workflow: "update-documentation",
      instruction: "Update README.md for the release.",
      files: { "docs/README.md": "# Nested documentation\n" },
      replies: [reply("update", [{ path: "README.md" }])],
    });
    expect(run.proceeded).toBe(false);
    expect(run.exitCode).toBe(1);
    expect(run.requestIntent!.admission).toMatchObject({
      outcome: "refused",
      code: "request-intent-outside-write-scope",
      boundary: { kind: "write-scope", grant: DEFAULT_ROOTS, observed: "README.md" },
    });
    expect(formatRequestIntentLines(run.records[0]!)).toContain(
      "Refused path: README.md (outside the run's write scope (docs/, fern/))",
    );
  });

  it("refuses a restructure of a page under an unconfigured site/content root", async () => {
    const instruction = "Restructure site/content/old.md into task pages.";
    const run = await interpretedRun({
      workflow: "restructure-documentation",
      instruction,
      replies: [reply("restructure", [{ path: "site/content/old.md" }])],
    });
    expect(run.proceeded).toBe(false);
    expect(run.exitCode).toBe(1);
    expect(run.requestIntent!.admission).toMatchObject({
      outcome: "refused",
      code: "request-intent-outside-write-scope",
      boundary: { kind: "write-scope", observed: "site/content/old.md" },
    });
    await expectAdmissionInput(run.repositoryPath, {
      instruction,
      declaredOperation: "restructure",
      docsRoot: DEFAULT_ROOTS,
      grantedWriteScope: DEFAULT_ROOTS,
      existence: [{ path: "site/content/old.md", existing: "file" }],
    });
  });

  it("asks existence again for a re-ask whose targets changed", async () => {
    const instruction = "Update docs/a.md, or docs/b.md if that is the one, and the index.";
    const run = await interpretedRun({
      workflow: "update-documentation",
      instruction,
      maxRetries: 1,
      replies: [
        reply("update", [
          { path: "docs/a.md" },
          { path: "docs/index.md", role: "companion-nav", quote: "index" },
        ]),
        reply("update", [{ path: "docs/b.md" }]),
      ],
    });
    expect(run.port.calls).toHaveLength(2);
    expect(asked).toEqual([["docs/a.md"], ["docs/b.md"]]);
    expect(run.requestIntent!.admission.outcome).toBe("admitted");
    expect(run.requestIntent!.intent!.targets.map((target) => target.path)).toEqual(["docs/b.md"]);
    await expectAdmissionInput(run.repositoryPath, {
      instruction,
      declaredOperation: "update",
      docsRoot: DEFAULT_ROOTS,
      grantedWriteScope: DEFAULT_ROOTS,
      existence: [{ path: "docs/b.md", existing: "file" }],
    });
  });
});

describe("the empty navigation set (row 6, navigation)", () => {
  const instruction = "Create docs/new.md and list it in docs/index.md.";
  const withCompanion = reply("create", [
    { path: "docs/new.md" },
    { path: "docs/index.md", role: "companion-nav" },
  ]);

  it("corrects a companion on the re-ask and proceeds after two calls", async () => {
    const run = await interpretedRun({
      workflow: "create-documentation",
      instruction,
      maxRetries: limit("retry.maxRetries").value,
      replies: [withCompanion, reply("create", [{ path: "docs/new.md" }])],
    });
    expect(run.requestIntent!.admission.outcome).toBe("admitted");
    expect(run.requestIntent!.admission.calls).toHaveLength(2);
    expect(run.proceeded).toBe(true);
    expect(run.port.calls[1]!.prompt).toContain(
      "Correction (request-intent-companion-not-navigation at $.targets[1].path)",
    );
    // The prompt shows the empty navigation set and the rule.
    expect(run.port.calls[0]!.prompt).toContain("name no companion target:\n[]");
  });

  it("rejects a companion the model keeps through every re-ask", async () => {
    const maxRetries = limit("retry.maxRetries").value;
    const run = await interpretedRun({
      workflow: "create-documentation",
      instruction,
      maxRetries,
      replies: [withCompanion],
    });
    expect(run.port.calls).toHaveLength(1 + maxRetries);
    expect(run.proceeded).toBe(false);
    expect(run.exitCode).toBe(1);
    expect(run.requestIntent!.admission).toMatchObject({
      outcome: "rejected",
      code: "request-intent-companion-not-navigation",
    });
    expect(run.records[0]).toMatchObject({ status: "failed" });
  });
});

// ---------------------------------------------------------------------------
// Row 7: an assessment on a declared update goes on with the declared workflow.

describe("the operation advisory on a declared update (row 7)", () => {
  const instruction = "Assess whether docs/a.md is current.";

  it("goes on with update-documentation and records the operation advisory", async () => {
    const run = await interpretedRun({
      workflow: "update-documentation",
      instruction,
      replies: [reply("review", [{ path: "docs/a.md" }])],
    });
    expect(run.requestIntent!.admission).toMatchObject({
      outcome: "advisory",
      code: "request-intent-operation-mismatch",
      location: "$.operation",
    });
    expect(run.proceeded).toBe(true);
    expect(run.exitCode).toBeUndefined();
    expect(run.records).toEqual([]);
    // Never rerouted: the run keeps its workflow, and the reading keeps its operation.
    expect((capture.invocations[0] as CliRunInvocation).request.workflow).toBe(
      "update-documentation",
    );
    expect(run.requestIntent!.intent).toMatchObject({ operation: "review", question: null });
    expect(formatRequestIntentLines({ requestIntent: run.requestIntent, instruction })).toContain(
      "Advisory: The request reads as a different operation than the workflow this run declared. DocsFab recorded the reading as advisory and ran the declared workflow.",
    );
  });

  it("admits the same request read as an update and proceeds (positive control)", async () => {
    const run = await interpretedRun({
      workflow: "update-documentation",
      instruction,
      replies: [reply("update", [{ path: "docs/a.md" }])],
    });
    expect(run.requestIntent!.admission.outcome).toBe("admitted");
    expect(run.proceeded).toBe(true);
  });

  it("is not routed to update by do, so the run command is the shipped arm", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const port = stubPort([reply("review", [{ path: "docs/a.md" }])]);
    const routed: string[] = [];
    const doRun = await captured(() =>
      handleDoCommand([instruction, "--repo", repositoryPath, "--patch-only"], {
        runWorkflow: (request) => {
          routed.push(request.workflow);
          return executeRunRequest(request, stubConfig(stateDirectory), {
            requestInterpreter: port,
          });
        },
      }),
    );
    // The do table matches no fixed workflow for an assessment and asks
    // which one is meant; no run starts and nothing is interpreted.
    expect(routed).toEqual([]);
    expect(port.calls).toHaveLength(0);
    expect(doRun.logs.join("\n")).toContain("Outcome route: needs-input");
  });
});

// ---------------------------------------------------------------------------
// Row 11 items 5-6: the host question bound and suffix grounding.

/** A named path under docs/ that makes the target-absent question exactly `length` characters. */
function absentPathForQuestionLength(length: number): string {
  const probe = targetAbsent("update", "").question.question.length;
  const stem = length - probe - "docs/".length - ".md".length;
  // Segments stay short so the path is a valid path on every file system.
  const segments = Math.ceil(stem / 100);
  const parts = Array.from({ length: segments }, (_, index) =>
    "s".repeat(index < segments - 1 ? 99 : stem - (segments - 1) * 100),
  );
  return `docs/${parts.join("/")}.md`;
}

describe("the host question bound (row 11, item 5)", () => {
  const maxQuestionChars = limit("requestIntent.maxQuestionChars").value;

  it.each([
    [0, true],
    [1, false],
  ] as const)("asks a host question %i characters over the bound: asked %s", async (over, ok) => {
    const path = absentPathForQuestionLength(maxQuestionChars + over);
    expect(targetAbsent("update", path).question.question).toHaveLength(maxQuestionChars + over);
    const run = await interpretedRun({
      workflow: "update-documentation",
      instruction: `Update ${path} for the release.`,
      replies: [reply("update", [{ path }])],
    });
    if (ok) {
      expect(run.exitCode).toBe(2);
      expect(run.requestIntent!.admission).toMatchObject({
        outcome: "question",
        code: "request-intent-target-absent",
      });
      return;
    }
    expect(run.error).toBeInstanceOf(OperationalLimitError);
    expect(run.error).toMatchObject({
      limitName: "requestIntent.maxQuestionChars",
      observed: maxQuestionChars + 1,
      code: limit("requestIntent.maxQuestionChars").refusal,
    });
    expect(run.records).toEqual([]);
  });

  const limits = resolveRequestIntentLimits();
  const within = (overrides: Partial<RequestIntentQuestion> = {}): RequestIntentQuestion => ({
    question: "q".repeat(limits.maxQuestionChars.value),
    consequence: "c".repeat(limits.maxQuestionChars.value),
    options: Array.from({ length: limits.maxQuestionOptions.value }, (_, index) =>
      `${index}`.padEnd(limits.maxOptionChars.value, "o"),
    ),
    recommendedDefault: "0".padEnd(limits.maxOptionChars.value, "o"),
    ...overrides,
  });

  it("admits a question with every field at its bound (positive control)", () => {
    expect(() => enforceRequestIntentQuestionBounds(within(), limits)).not.toThrow();
  });

  it.each([
    ["question", { question: "q".repeat(limits.maxQuestionChars.value + 1) }, "maxQuestionChars"],
    [
      "consequence",
      { consequence: "c".repeat(limits.maxQuestionChars.value + 1) },
      "maxQuestionChars",
    ],
    [
      "option count",
      {
        options: Array.from(
          { length: limits.maxQuestionOptions.value + 1 },
          (_, index) => `${index}`,
        ),
      },
      "maxQuestionOptions",
    ],
    ["option", { options: ["o".repeat(limits.maxOptionChars.value + 1)] }, "maxOptionChars"],
  ] as const)("refuses a %s one over its bound", (_field, overrides, name) => {
    expect(() =>
      enforceRequestIntentQuestionBounds(
        within(overrides as Partial<RequestIntentQuestion>),
        limits,
      ),
    ).toThrow(
      expect.objectContaining({
        limitName: `requestIntent.${name}`,
        code: limits[name].refusal,
      }),
    );
  });

  it("keeps every host question's options and consequence within their bounds at any path", () => {
    const longest = "p".repeat(limit("requestIntent.maxQuoteChars").value);
    const questions = [
      targetMissing("create"),
      targetAbsent("restructure", longest),
      targetPresent(longest, "case-fold"),
      targetCaseAmbiguous("restructure", longest),
      targetNotFile("restructure", longest, "parent-file"),
    ].map((decision) => decision.question);
    for (const question of questions) {
      expect(question.consequence.length).toBeLessThanOrEqual(limits.maxQuestionChars.value);
      expect(question.options.length).toBeLessThanOrEqual(limits.maxQuestionOptions.value);
      for (const option of question.options) {
        expect(option.length).toBeLessThanOrEqual(limits.maxOptionChars.value);
      }
    }
  });
});

describe("suffix grounding with the real documentation roots (row 11, item 6)", () => {
  const instruction = "请创建参考docs/x.md";

  it("rejects a named 参考docs/x.md as ungrounded, before the root check: Han to Han is no token edge", async () => {
    const run = await interpretedRun({
      workflow: "create-documentation",
      instruction,
      replies: [reply("create", [{ path: "参考docs/x.md" }])],
    });
    expect(run.exitCode).toBe(1);
    expect(run.requestIntent!.admission).toMatchObject({
      outcome: "rejected",
      code: "request-intent-named-ungrounded",
    });
  });

  it("grounds a named docs/x.md at the Han-to-Latin edge (start-side residue, pinned)", async () => {
    const run = await interpretedRun({
      workflow: "create-documentation",
      instruction,
      replies: [reply("create", [{ path: "docs/x.md" }])],
    });
    expect(run.requestIntent!.admission.outcome).toBe("admitted");
  });

  it("refuses the proposed-new suffix path outside the documentation roots", async () => {
    const run = await interpretedRun({
      workflow: "create-documentation",
      instruction,
      replies: [
        reply("create", [
          { path: "参考docs/x.md", chosenFrom: "proposed-new", quote: "参考docs/x.md" },
        ]),
      ],
    });
    expect(run.exitCode).toBe(1);
    expect(run.requestIntent!.admission).toMatchObject({
      outcome: "refused",
      code: "request-intent-outside-docs-root",
      boundary: { kind: "docs-root", roots: DEFAULT_ROOTS, observed: "参考docs/x.md" },
    });
    expect(formatRequestIntentLines(run.records[0]!)).toContain(
      "Refused path: 参考docs/x.md (outside the documentation roots (docs/, fern/))",
    );
  });

  it("admits docs/x.md named after a space (positive control)", async () => {
    const run = await interpretedRun({
      workflow: "create-documentation",
      instruction: "请创建 docs/x.md",
      replies: [reply("create", [{ path: "docs/x.md" }])],
    });
    expect(run.requestIntent!.admission.outcome).toBe("admitted");
    expect(run.proceeded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Units: the existence mapping, the write scope, and the recorded boundaries.

describe("the existence mapping", () => {
  const collision = (
    fields: Omit<PlannedTargetCollisionV1, "path">,
    path = "docs/a.md",
  ): PlannedTargetCollisionV1 => ({ path, ...fields });

  it.each([
    [undefined, "absent"],
    [collision({ existing: "file", base: { sha256: SHA } }), "file"],
    [collision({ existing: "file" }), "case-fold"],
    [collision({ existing: "directory" }), "directory"],
    [collision({ existing: "parent-file" }), "parent-file"],
    [collision({ existing: "file", updateRefused: "write-grant" }), "file-not-granted"],
    // A refused grant wins over a base, whatever the oracle sets beside it.
    [
      collision({ existing: "file", base: { sha256: SHA }, updateRefused: "write-grant" }),
      "file-not-granted",
    ],
  ] as const)("maps %j to %s", (input, kind) => {
    expect(requestIntentExistenceKind(input)).toBe(kind);
  });

  it("answers every asked path in asked order, absent when the oracle lists none", () => {
    expect(
      requestIntentExistenceAnswers(
        ["docs/z.md", "docs/a.md", "docs/m.md"],
        [collision({ existing: "directory" }, "docs/m.md"), collision({ existing: "file" })],
      ),
    ).toEqual([
      { path: "docs/z.md", existing: "absent" },
      { path: "docs/a.md", existing: "case-fold" },
      { path: "docs/m.md", existing: "directory" },
    ]);
  });

  it.each([
    ["a path nobody asked about", [collision({ existing: "directory" }, "docs/other.md")]],
    [
      "one path twice",
      [collision({ existing: "directory" }), collision({ existing: "parent-file" })],
    ],
  ])("refuses an oracle answer for %s as a host fault", (_case, collisions) => {
    expect(() => requestIntentExistenceAnswers(["docs/a.md"], collisions)).toThrow(
      expect.objectContaining({ code: "host-input-invalid" }),
    );
    expect(() => requestIntentExistenceAnswers(["docs/a.md"], collisions)).toThrow(
      RequestIntentContractError,
    );
  });
});

describe("the existence oracle inside the interpretation", () => {
  function unitInput(
    replies: readonly string[],
    existence: Parameters<typeof interpretRequest>[0]["existence"],
  ): Parameters<typeof interpretRequest>[0] {
    return {
      port: stubPort(replies),
      workflow: "update-documentation",
      operation: "update",
      instruction: "Update docs/a.md for the release.",
      promptInventory: { entries: [], clippedTitles: 0 },
      admissionInventory: ["docs/a.md"],
      documentationRoots: DEFAULT_ROOTS,
      writeRoots: DEFAULT_ROOTS,
      navigationSet: [],
      existence,
      limits: resolveRequestIntentLimits(),
      maxRetries: 1,
      window: { maxInputTokens: validModelConfig.profile.maxInputTokens, maxOutputTokens: 1 },
      deadlineMs: limit("requestIntent.interpretationTimeoutMs").value,
    };
  }

  it("asks nothing for a reply that does not decode, then asks for the one that does", async () => {
    const calls: string[][] = [];
    const outcome = await interpretRequest(
      unitInput(["not json", reply("update", [{ path: "docs/a.md" }])], async (paths) => {
        calls.push([...paths]);
        return [{ path: "docs/a.md", existing: "file", base: { sha256: SHA } }];
      }),
    );
    expect(outcome.outcome).toBe("admitted");
    expect(outcome.calls).toHaveLength(2);
    expect(calls).toEqual([["docs/a.md"]]);
  });

  it("propagates an oracle failure unchanged, never as unavailable", async () => {
    const failure = new Error("git failed");
    await expect(
      interpretRequest(
        unitInput([reply("update", [{ path: "docs/a.md" }])], async () => {
          throw failure;
        }),
      ),
    ).rejects.toBe(failure);
  });

  it("keeps a resolved root's kind: a directory ends in a slash, a file root does not", () => {
    expect(requestIntentRootScope("docs/")).toEqual({ kind: "root", path: "docs" });
    expect(requestIntentRootScope("site/content/")).toEqual({
      kind: "root",
      path: "site/content",
    });
    expect(requestIntentRootScope("README.md")).toEqual({ kind: "file", path: "README.md" });
  });
});

describe("the write scope per operation", () => {
  const targets = [
    { path: "docs/a.md", role: "write", chosenFrom: "named", quote: "a" },
    { path: "README.md", role: "write", chosenFrom: "inventory", quote: "readme" },
    { path: "site/x.md", role: "write", chosenFrom: "named", quote: "x" },
    { path: "nav.yml", role: "companion-nav", chosenFrom: "named", quote: "nav" },
  ] as const;

  const grantedScope = (operation: RequestIntentOperation, writeRoots = DEFAULT_ROOTS) =>
    buildRequestIntentHostInputs(
      {
        instruction: "Work on the pages.",
        inventory: [],
        limits: resolveRequestIntentLimits(),
        declaredOperation: operation,
        docsRoot: writeRoots,
        writeRoots,
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

  // Every plan writes only inside the roots, so no target earns a file entry
  // beyond them, an inventory update page and every restructure target included.
  it.each(["create", "review", "update", "restructure"] as const)(
    "grants %s the roots and nothing beyond them",
    (operation) => {
      expect(grantedScope(operation)).toEqual(DEFAULT_ROOTS);
    },
  );

  it("fits the write-scope bound at the most roots .docsfab.json admits", () => {
    const scopeBound = limit("requestIntent.maxWriteScopeEntries").value;
    const maxTargets = limit("requestIntent.maxTargets").value;
    const rootPaths = (count: number) =>
      Array.from({ length: count }, (_, index) => `site/r${index}`);
    const config = (documentationRoots: readonly string[]) => ({
      schemaVersion: 1,
      gitlab: { remote: "origin", defaultBranch: "main" },
      provider: { configuration: "host" },
      storage: { scope: "user-private" },
      documentationRoots,
    });
    const mostRoots = scopeBound - maxTargets;
    expect(() => assertDocsFabProjectConfig(config(rootPaths(mostRoots)))).not.toThrow();
    expect(() => assertDocsFabProjectConfig(config(rootPaths(mostRoots + 1)))).toThrow();
    const roots = rootPaths(mostRoots).map((path) => ({ kind: "root" as const, path }));
    const scope = grantedScope("restructure", roots);
    expect(scope).toEqual(roots);
    expect(scope.length).toBeLessThanOrEqual(scopeBound);
  });
});

describe("the configuration refusal for roots configuration dropped", () => {
  const calls = [{ promptSha256: SHA, responseSha256: SHA, inputTokens: 1, outputTokens: 1 }];
  const refused = (boundary: unknown) =>
    ({
      outcome: "refused",
      code: "request-intent-outside-write-scope",
      at: "$.targets[0].path",
      boundary: boundary as never,
      calls,
    }) as const;
  const writeScope = refused({
    kind: "write-scope",
    grant: [],
    observed: "docs/a.md",
    remediation: "Nothing.",
  });
  const docsRoot = refused({
    kind: "docs-root",
    roots: [],
    observed: "docs/new.md",
    remediation: "None.",
  });
  const noRoot = { roots: [], dropped: ["src"] } as const;

  it.each([
    ["write-scope", writeScope],
    ["docs-root", docsRoot],
  ])("turns a %s refusal under no root into the configuration refusal", (_kind, outcome) => {
    const error = droppedRootsConfigurationRefusal(outcome, noRoot, "local-widen");
    expect(error).toBeInstanceOf(DocumentationRootsOutsideWriteRootsError);
    expect(error!.droppedRoots).toEqual(["src"]);
    expect(error!.message).toBe(
      new DocumentationRootsOutsideWriteRootsError(["src"], "local-widen").message,
    );
  });

  // Adjacent conditions the branch must leave alone.
  it.each([
    ["a root is left", writeScope, { roots: ["docs/"], dropped: ["src"] }],
    ["no root was dropped", writeScope, { roots: [], dropped: [] }],
    [
      "the refusal is the update grant, which no root decides",
      refused({ kind: "write-grant", observed: "docs/a.md", remediation: "Grant it." }),
      noRoot,
    ],
    [
      "the refusal is an internal segment",
      refused({
        kind: "internal-segment",
        segment: ".git",
        observed: ".git/x",
        remediation: "Name another path.",
      }),
      noRoot,
    ],
    ["the refusal carries no boundary", refused(null), noRoot],
    [
      "the outcome is a rejection",
      { outcome: "rejected", code: "request-intent-shape", at: "$", calls } as const,
      noRoot,
    ],
  ] as const)("leaves the outcome alone when %s (adjacent)", (_label, outcome, resolved) => {
    expect(droppedRootsConfigurationRefusal(outcome, resolved, "local-widen")).toBeUndefined();
  });
});

describe("the recorded authority boundaries", () => {
  async function refusedRecord(boundary: unknown, instruction = "Update docs/a.md now.") {
    const recorded = requestInterpretationStep(
      {
        outcome: "refused",
        code: "request-intent-outside-write-scope",
        at: "$.targets[0].path",
        boundary: boundary as never,
        calls: [{ promptSha256: SHA, responseSha256: SHA, inputTokens: 1, outputTokens: 1 }],
      },
      0,
    ).recorded;
    return { requestIntent: recorded, instruction };
  }

  it.each([
    [
      { kind: "write-grant", observed: "docs/a.md", remediation: "Grant it." },
      "Refused path: docs/a.md (an existing page the run's update grant does not cover)",
    ],
    [
      {
        kind: "docs-root",
        roots: DEFAULT_ROOTS,
        observed: "site/a.md",
        remediation: "Name a new page under docs or fern.",
      },
      "Refused path: site/a.md (outside the documentation roots (docs/, fern/))",
    ],
    [
      {
        kind: "write-scope",
        grant: [...DEFAULT_ROOTS, { kind: "file", path: "README.md" }],
        observed: "site/a.md",
        remediation: "Name only paths inside it.",
      },
      "Refused path: site/a.md (outside the run's write scope (docs/, fern/, README.md))",
    ],
    [
      { kind: "write-scope", grant: [], observed: "docs/a.md", remediation: "Nothing." },
      "Refused path: docs/a.md (outside the run's write scope (none))",
    ],
    [
      { kind: "internal-segment", segment: ".git", observed: ".git/x", remediation: "Remove it." },
      "Refused path: .git/x (inside .git, which no grant covers)",
    ],
  ])("decodes and renders %j", async (boundary, line) => {
    const record = await refusedRecord(boundary);
    expect(
      decodeRunRecordRequestIntent(record.requestIntent, record.instruction).admission.boundary,
    ).toEqual(boundary);
    const lines = formatRequestIntentLines(record);
    expect(lines).toContain(line);
    expect(lines).toContain(`Remediation: ${(boundary as { remediation: string }).remediation}`);
  });

  it.each([
    ["an unknown kind", { kind: "write-root", observed: "docs/a.md", remediation: "x" }],
    ["a docs-root without roots", { kind: "docs-root", observed: "docs/a.md", remediation: "x" }],
    [
      "a write-grant with another kind's key",
      { kind: "write-grant", segment: ".git", observed: "docs/a.md", remediation: "x" },
    ],
    [
      "a scope entry with a trailing slash",
      {
        kind: "write-scope",
        grant: [{ kind: "root", path: "docs/" }],
        observed: "a.md",
        remediation: "x",
      },
    ],
    [
      "a scope entry of an unknown kind",
      {
        kind: "docs-root",
        roots: [{ kind: "glob", path: "docs" }],
        observed: "a.md",
        remediation: "x",
      },
    ],
  ])("refuses %s as a shape fault", async (_case, boundary) => {
    const record = await refusedRecord(boundary);
    expect(() => decodeRunRecordRequestIntent(record.requestIntent, record.instruction)).toThrow(
      expect.objectContaining({ code: "sealed-shape" }),
    );
    expect(formatRequestIntentLines(record)).toEqual(["Admission: unverified (sealed-shape)"]);
  });

  it("refuses an existing page outside a stub update grant, through the real oracle, and shows it", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const instruction = "Update docs/a.md for the release.";
    const outcome = await withRepositoryWorkspace(repositoryPath, "HEAD", async (workspace) =>
      interpretRequest({
        port: stubPort([reply("update", [{ path: "docs/a.md" }])]),
        workflow: "update-documentation",
        operation: "update",
        instruction,
        promptInventory: { entries: [], clippedTitles: 0 },
        admissionInventory: await trackedPaths(repositoryPath),
        documentationRoots: DEFAULT_ROOTS,
        writeRoots: DEFAULT_ROOTS,
        navigationSet: [],
        // Only the hosted invoker builds an update grant; this one covers nothing.
        existence: (paths) => plannedTargetCollisions(workspace, paths, () => false),
        limits: resolveRequestIntentLimits(),
        maxRetries: 0,
        window: { maxInputTokens: validModelConfig.profile.maxInputTokens, maxOutputTokens: 1 },
        deadlineMs: limit("requestIntent.interpretationTimeoutMs").value,
      }),
    );
    expect(outcome).toMatchObject({
      outcome: "refused",
      code: "request-intent-target-not-granted",
      boundary: { kind: "write-grant", observed: "docs/a.md" },
    });
    const step = requestInterpretationStep(outcome, 0);
    if (step.kind !== "stop") throw new Error("expected a stop");
    const record = await withRepositoryWorkspace(repositoryPath, "HEAD", (workspace) =>
      persistRequestIntentStop({
        request: runRequest(repositoryPath, "update-documentation", instruction),
        config: stubConfig(stateDirectory),
        workspace,
        step,
      }),
    );
    const shown = await captured(() =>
      handleRunsCommand(["show", record.id, "--state-dir", stateDirectory]),
    );
    expect(shown.error).toBeUndefined();
    const text = shown.logs.join("\n");
    expect(text).toContain("Admission: refused (request-intent-target-not-granted)");
    expect(text).toContain(
      "Refused path: docs/a.md (an existing page the run's update grant does not cover)",
    );
  });
});
