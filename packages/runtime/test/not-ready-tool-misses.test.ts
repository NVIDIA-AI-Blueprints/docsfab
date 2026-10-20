// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A write run that finished every step keeps its `not-ready` outcome and patch
 * when the model's tools refused some of its calls: the confined tools record
 * Pi's misses as `recoverable-miss`, and the outcome names them with the
 * `tool-misses-recorded` limitation. Material tool failures still fail
 * admission with a code.
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { loadSavedRunEditorialDecodeOptions } from "../src/cli/run/editorial-replay.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import { observeReaderTaskContextAdmissionV1 } from "../src/execution/reader-task-admission.js";
import { createReaderTaskContextSupplier } from "../src/execution/task-context.js";
import {
  classifyGrepFailure,
  createConfinedToolSet,
  GREP_FAILURE_MESSAGES,
  type GrepFailureKind,
  RECOVERABLE_MISS_MESSAGES,
  type RecoverableMissKind,
  safeFailureMessage,
} from "../src/harness/confined-tools.js";
import { summarizeToolFailureCategories } from "../src/harness/pi-tool-confine.js";
import { DocumentationScope } from "../src/live-agent/documentation-scope.js";
import { LiveWorkflowDelivery } from "../src/live-agent/workflow-delivery.js";
import {
  buildRunHumanNextCommand,
  collectRunResultNextSteps,
} from "../src/operator/run-next-action.js";
import { renderWorkflowOutcome } from "../src/operator/run-summary.js";
import { verifyQualityPackContext } from "../src/quality-pack/manifest.js";
import type { RunRecord, ToolActivitySummary } from "../src/records/contracts.js";
import type {
  WorkflowOutcomeCandidateV1,
  WorkflowOutcomeProjector,
} from "../src/workflow-contracts/contracts.js";
import {
  createWorkflowOutcome,
  decodeRunRecordEditorialEvidence,
  recordNotReadyToolMisses,
  TOOL_MISSES_RECORDED_LIMITATION,
  WorkflowOutcomeError,
  workflowOutcomeState,
  workflowOutcomeStepEvidence,
} from "../src/workflow-contracts/outcome.js";
import { documentationPlanWritePaths } from "../src/workflow-execution/plan-binding.js";
import { applyWorkflowOutcome } from "../src/workflow-execution/runner-evidence.js";
import { EditorialProtocolHarness } from "./helpers/editorial-protocol-harness.js";
import {
  orbitOptionChangeRepository,
  orbitReaderContextInput,
} from "./helpers/orbit-option-change-fixture.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const temporaryDirectories = temporaryRoots();
const fixtureDirectories: string[] = [];

afterEach(async () => {
  process.exitCode = undefined;
  for (const path of fixtureDirectories.splice(0)) temporaryDirectories.track(path);
  await temporaryDirectories.cleanup();
});

const GUIDE = "alpha beta\nalpha gamma\n";
const WRITE_STEP = "write-documentation";
const EVALUATE_STEP = "evaluate-document-quality";
const REJECTED = "workflow-outcome-admission-execution-product-mismatch";

type ToolSet = Awaited<ReturnType<typeof createConfinedToolSet>>;

async function workspace(): Promise<string> {
  const root = await temporaryDirectories.create("docsfab-tool-misses-");
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "guide.md"), GUIDE);
  return root;
}

function caller(toolSet: ToolSet) {
  return (name: string, parameters: Record<string, unknown>) => {
    const tool = toolSet.definitions.find((definition) => definition.name === name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    return tool.execute(`call-${name}`, parameters, undefined, undefined, undefined as never);
  };
}

/** The model-facing message of a refused call. */
async function refusal(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("Expected the tool call to be refused.");
}

/** The text a successful call returned to the model. */
function resultText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((block) => block.text ?? "").join("\n");
}

const MISSES: readonly {
  name: string;
  tool: string;
  parameters: Record<string, unknown>;
  kind: RecoverableMissKind;
}[] = [
  {
    name: "an edit whose oldText is absent",
    tool: "edit",
    parameters: { path: "docs/guide.md", edits: [{ oldText: "absent", newText: "x" }] },
    kind: "edit-text-not-found",
  },
  {
    name: "one of several edits whose oldText is absent",
    tool: "edit",
    parameters: {
      path: "docs/guide.md",
      edits: [
        { oldText: "beta", newText: "B" },
        { oldText: "absent", newText: "x" },
      ],
    },
    kind: "edit-text-not-found",
  },
  {
    name: "an edit whose oldText occurs twice",
    tool: "edit",
    parameters: { path: "docs/guide.md", edits: [{ oldText: "alpha", newText: "A" }] },
    kind: "edit-text-not-unique",
  },
  {
    name: "one of several edits whose oldText occurs twice",
    tool: "edit",
    parameters: {
      path: "docs/guide.md",
      edits: [
        { oldText: "beta", newText: "B" },
        { oldText: "alpha", newText: "A" },
      ],
    },
    kind: "edit-text-not-unique",
  },
  {
    name: "an edit with an empty oldText",
    tool: "edit",
    parameters: { path: "docs/guide.md", edits: [{ oldText: "", newText: "x" }] },
    kind: "edit-text-empty",
  },
  {
    name: "one of several edits with an empty oldText",
    tool: "edit",
    parameters: {
      path: "docs/guide.md",
      edits: [
        { oldText: "beta", newText: "B" },
        { oldText: "", newText: "x" },
      ],
    },
    kind: "edit-text-empty",
  },
  {
    name: "overlapping edits",
    tool: "edit",
    parameters: {
      path: "docs/guide.md",
      edits: [
        { oldText: "alpha beta", newText: "1" },
        { oldText: "beta", newText: "2" },
      ],
    },
    kind: "edit-overlap",
  },
  {
    name: "an edit that changes nothing",
    tool: "edit",
    parameters: { path: "docs/guide.md", edits: [{ oldText: "beta", newText: "beta" }] },
    kind: "edit-no-change",
  },
  {
    name: "several edits that change nothing",
    tool: "edit",
    parameters: {
      path: "docs/guide.md",
      edits: [
        { oldText: "beta", newText: "beta" },
        { oldText: "gamma", newText: "gamma" },
      ],
    },
    kind: "edit-no-change",
  },
  {
    name: "an edit of a missing file",
    tool: "edit",
    parameters: { path: "docs/missing.md", edits: [{ oldText: "a", newText: "b" }] },
    kind: "edit-missing-file",
  },
  {
    name: "an edit of a directory",
    tool: "edit",
    parameters: { path: "docs", edits: [{ oldText: "a", newText: "b" }] },
    kind: "directory-not-file",
  },
  {
    name: "a read past the end of the file",
    tool: "read",
    parameters: { path: "docs/guide.md", offset: 99 },
    kind: "read-past-end",
  },
  {
    name: "a read of a directory",
    tool: "read",
    parameters: { path: "docs" },
    kind: "directory-not-file",
  },
  {
    name: "a read through a file",
    tool: "read",
    parameters: { path: "docs/guide.md/child.md" },
    kind: "file-not-directory",
  },
  {
    name: "a listing of a file",
    tool: "ls",
    parameters: { path: "docs/guide.md" },
    kind: "file-not-directory",
  },
  {
    name: "a write through a file",
    tool: "write",
    parameters: { path: "docs/guide.md/child.md", content: "x\n" },
    kind: "file-not-directory",
  },
];

describe("recoverable tool misses in the confined tools (#1916)", () => {
  it.each(MISSES)(
    "records $name as recoverable-miss with a content-free sentence",
    async ({ tool, parameters, kind }) => {
      const root = await workspace();
      const toolSet = await createConfinedToolSet({ workspacePath: root, allowWrite: true });
      const message = await refusal(caller(toolSet)(tool, parameters));

      expect(message).toBe(RECOVERABLE_MISS_MESSAGES[kind]);
      expect(message).not.toContain(root);
      expect(toolSet.getFailureCategories()).toEqual([{ category: "recoverable-miss", count: 1 }]);
      expect(toolSet.getMutationBoundaryDenials()).toBe(0);
      expect(await readFile(join(root, "docs", "guide.md"), "utf8")).toBe(GUIDE);
    },
  );

  it("tells misses apart from refusals, missing probes, and failed writes", async () => {
    // Root writes through a read-only mode, which would hide the failed write.
    expect(process.getuid?.()).not.toBe(0);
    const root = await workspace();
    await writeFile(join(root, "docs", "locked.md"), "locked\n");
    await chmod(join(root, "docs", "locked.md"), 0o444);
    const toolSet = await createConfinedToolSet({
      workspacePath: root,
      allowWrite: true,
      allowedWritePaths: ["docs/guide.md", "docs/locked.md"],
    });
    const call = caller(toolSet);

    // Positive control: a well-formed edit lands and records nothing.
    await call("edit", { path: "docs/guide.md", edits: [{ oldText: "beta", newText: "BETA" }] });
    expect(await readFile(join(root, "docs", "guide.md"), "utf8")).toBe(
      "alpha BETA\nalpha gamma\n",
    );
    expect(toolSet.getFailureCategories()).toEqual([]);

    await refusal(call("read", { path: "docs/absent.md" }));
    // A write outside the grant stays a refused mutation.
    await refusal(call("write", { path: "docs/other.md", content: "x\n" }));
    // The write itself failed: an internal failure, not a model miss.
    expect(
      await refusal(
        call("edit", { path: "docs/locked.md", edits: [{ oldText: "locked", newText: "x" }] }),
      ),
    ).toBe("DocsFab tool failed internally.");
    // The same tool's miss beside them is still a miss.
    await refusal(
      call("edit", { path: "docs/locked.md", edits: [{ oldText: "absent", newText: "x" }] }),
    );

    expect(toolSet.getFailureCategories()).toEqual([
      { category: "denied-path", count: 1 },
      { category: "expected-missing-probe", count: 1 },
      { category: "recoverable-miss", count: 1 },
      { category: "tool-defect", count: 1 },
    ]);
    expect(toolSet.getMutationBoundaryDenials()).toBe(1);
  });
});

/** Where Pi looks for its own ripgrep, before PATH. */
const PI_BIN_RIPGREP = join(
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
  "bin",
  "rg",
);

/** Searches ripgrep refuses for their pattern or glob, through the real confined grep. */
const GREP_PATTERN_MISSES: readonly {
  name: string;
  parameters: Record<string, unknown>;
  kind: GrepFailureKind;
}[] = [
  {
    name: "a call-shaped pattern with an unclosed group",
    parameters: { pattern: "run(", path: "docs" },
    kind: "regex-rejected",
  },
  {
    name: "a template brace",
    parameters: { pattern: "{{ include", path: "docs" },
    kind: "regex-rejected",
  },
  { name: "a look-ahead", parameters: { pattern: "alpha(?= beta)" }, kind: "regex-rejected" },
  {
    name: "a pattern with a line break",
    parameters: { pattern: "alpha beta\nalpha gamma", path: "docs" },
    kind: "line-break",
  },
  {
    name: "a glob ripgrep cannot parse",
    parameters: { pattern: "alpha", glob: "{guide.md" },
    kind: "glob-rejected",
  },
];

describe("grep failures in the confined tools (#2041)", () => {
  it.each(GREP_PATTERN_MISSES)(
    "records $name as unsupported-pattern with a sentence that names the fix",
    async ({ parameters, kind }) => {
      const root = await workspace();
      const toolSet = await createConfinedToolSet({ workspacePath: root, allowWrite: false });
      const message = await refusal(caller(toolSet)("grep", parameters));

      expect(toolSet.getFailureCategories()).toEqual([
        { category: "unsupported-pattern", count: 1 },
      ]);
      expect(message).toBe(GREP_FAILURE_MESSAGES[kind]);
      expect(message).not.toContain(root);
      for (const value of Object.values(parameters)) expect(message).not.toContain(String(value));
    },
    15_000,
  );

  it("records a search over an unreadable file as tool-defect with a sentence that names the fix", async () => {
    // Root reads through a mode-000 file, which would hide the failed search.
    expect(process.getuid?.()).not.toBe(0);
    const root = await workspace();
    await writeFile(join(root, "docs", "locked.md"), "alpha locked\n");
    await chmod(join(root, "docs", "locked.md"), 0o000);
    const toolSet = await createConfinedToolSet({ workspacePath: root, allowWrite: false });
    const call = caller(toolSet);

    // Ripgrep matched guide.md, but the unreadable file makes it exit 2.
    const message = await refusal(call("grep", { pattern: "alpha", path: "docs" }));
    expect(toolSet.getFailureCategories()).toEqual([{ category: "tool-defect", count: 1 }]);
    expect(message).not.toBe(safeFailureMessage("tool-defect"));
    expect(message).toBe(GREP_FAILURE_MESSAGES["unreadable-path"]);
    expect(message).not.toContain(root);
    // The narrower path the sentence asks for succeeds.
    expect(resultText(await call("grep", { pattern: "alpha", path: "docs/guide.md" }))).toContain(
      "alpha beta",
    );
    expect(toolSet.getFailureCategories()).toEqual([{ category: "tool-defect", count: 1 }]);
  }, 15_000);

  it("returns a search with no match as a result, not a failed call", async () => {
    const root = await workspace();
    await writeFile(join(root, "docs", "api.md"), "Call run(path) first.\n");
    const toolSet = await createConfinedToolSet({ workspacePath: root, allowWrite: false });
    const call = caller(toolSet);

    // Ripgrep exits 1 when nothing matched, and Pi returns that as a result.
    expect(resultText(await call("grep", { pattern: "absent text", path: "docs" }))).toBe(
      "No matches found",
    );
    expect(resultText(await call("grep", { pattern: "alpha", path: "docs" }))).toContain(
      "guide.md:1: alpha beta",
    );
    // The rejected-pattern sentence's fix: the same text, searched as written.
    expect(resultText(await call("grep", { pattern: "run(", literal: true }))).toContain(
      "api.md:1: Call run(path) first.",
    );
    expect(toolSet.getFailureCategories()).toEqual([]);
  }, 15_000);

  it("records a grep failure the classifier does not recognize as a tool defect with the generic sentence", async () => {
    const root = await workspace();
    const toolSet = await createConfinedToolSet({ workspacePath: root, allowWrite: false });
    // Node refuses to spawn ripgrep with a NUL byte in an argument, so Pi
    // rejects with Node's coded error, not ripgrep's text.
    const message = await refusal(
      caller(toolSet)("grep", { pattern: "alpha\u0000beta", path: "docs" }),
    );

    expect(toolSet.getFailureCategories()).toEqual([{ category: "tool-defect", count: 1 }]);
    expect(message).toBe(safeFailureMessage("tool-defect"));
    expect(message).not.toContain("alpha");
  });

  it("records an ignore-file warning beside an unreadable file as a tool defect with the generic sentence", async () => {
    // Root reads through a mode-000 file, which would hide the failed search.
    expect(process.getuid?.()).not.toBe(0);
    const root = await workspace();
    // Ripgrep warns about the ignore file it cannot parse, then exits 2 for the
    // unreadable file: not every stderr line names an unreadable path.
    await writeFile(join(root, "docs", ".gitignore"), "{a\n");
    await writeFile(join(root, "docs", "locked.md"), "alpha locked\n");
    await chmod(join(root, "docs", "locked.md"), 0o000);
    const toolSet = await createConfinedToolSet({ workspacePath: root, allowWrite: false });
    const message = await refusal(caller(toolSet)("grep", { pattern: "alpha", path: "." }));

    expect(toolSet.getFailureCategories()).toEqual([{ category: "tool-defect", count: 1 }]);
    expect(message).toBe(safeFailureMessage("tool-defect"));
  });

  // Pi takes ripgrep from its own bin directory before PATH, so a host whose
  // Pi downloaded one there cannot run without ripgrep.
  it.skipIf(existsSync(PI_BIN_RIPGREP))(
    "records a host without ripgrep as a tool defect, not a pattern miss",
    async () => {
      const root = await workspace();
      const empty = await temporaryDirectories.create("docsfab-no-rg-");
      const toolSet = await createConfinedToolSet({ workspacePath: root, allowWrite: false });
      // No ripgrep on PATH, and offline Pi does not download one.
      vi.stubEnv("PATH", empty);
      vi.stubEnv("PI_OFFLINE", "1");
      const message = await refusal(
        caller(toolSet)("grep", { pattern: "alpha", path: "docs" }),
      ).finally(() => vi.unstubAllEnvs());

      expect(toolSet.getFailureCategories()).toEqual([{ category: "tool-defect", count: 1 }]);
      expect(message).toBe(GREP_FAILURE_MESSAGES["ripgrep-unavailable"]);
    },
  );

  it.each([
    [
      "ripgrep 13's rejected regex",
      "regex parse error:\n    (?:run()\n    ^\nerror: unclosed group",
      "regex-rejected",
    ],
    [
      "ripgrep 15's rejected regex",
      "rg: regex parse error:\n    (?:run()\n    ^\nerror: unclosed group",
      "regex-rejected",
    ],
    ["ripgrep 13's line break", `the literal '"\\n"' is not allowed in a regex`, "line-break"],
    [
      "ripgrep 15's line break",
      'rg: the literal "\n" is not allowed in a regex\n\nConsider enabling multiline mode with the --multiline flag (or -U for short).',
      "line-break",
    ],
    [
      "ripgrep 13's rejected glob",
      "error parsing glob '{a': unclosed alternate group; missing '}' (maybe escape '{' with '[{]'?)",
      "glob-rejected",
    ],
    [
      "ripgrep 15's unreadable paths",
      "rg: /w/docs/locked.md: Permission denied (os error 13)\nrg: /w/private: Operation not permitted (os error 1)",
      "unreadable-path",
    ],
    [
      "ripgrep 13's unreadable path",
      "/w/docs/locked.md: Permission denied (os error 13)",
      "unreadable-path",
    ],
    [
      "a host with no ripgrep",
      "ripgrep (rg) is not available and could not be downloaded",
      "ripgrep-unavailable",
    ],
    [
      "a ripgrep that cannot start",
      "Failed to run ripgrep: spawn rg EACCES",
      "ripgrep-unavailable",
    ],
  ] as const)("classifies %s from the text Pi rejects with", (_name, message, kind) => {
    expect(classifyGrepFailure(new Error(message))).toBe(kind);
  });

  it.each([
    [
      "an ignore-file warning beside an unreadable path",
      "rg: ./.gitignore: line 2: error parsing glob '[': unclosed character class; missing ']'\nrg: /w/docs/locked.md: Permission denied (os error 13)",
    ],
    ["an exit with no stderr", "ripgrep exited with code null"],
    ["an aborted call", "Operation aborted"],
    ["a search path that vanished", "Path not found: /w/docs"],
  ] as const)("leaves %s unclassified, so it stays a tool defect", (_name, message) => {
    expect(classifyGrepFailure(new Error(message))).toBeUndefined();
  });
});

type Call = (name: string, parameters: Record<string, unknown>) => Promise<unknown>;

/**
 * A writer's calls through the real confined tools, summarized as the Pi
 * harness summarizes an attempt: per-tool outcomes, and the recorded categories
 * with any unattributed failure left as `tool-defect`.
 */
async function writerToolEvidence(
  root: string,
  path: string,
  options: {
    misses: number;
    oldText: string;
    newText: string;
    allowedWritePaths: readonly string[];
    extra?: (call: Call) => Promise<unknown>;
  },
): Promise<{ tools: ToolActivitySummary; messages: string[]; mutationDenials: number }> {
  const toolSet = await createConfinedToolSet({
    workspacePath: root,
    allowWrite: true,
    allowedWritePaths: options.allowedWritePaths,
  });
  const execute = caller(toolSet);
  const activity = new Map<string, { calls: number; failures: number }>();
  const call: Call = async (name, parameters) => {
    const entry = activity.get(name) ?? { calls: 0, failures: 0 };
    activity.set(name, entry);
    entry.calls += 1;
    try {
      return await execute(name, parameters);
    } catch (error) {
      entry.failures += 1;
      throw error;
    }
  };
  const messages: string[] = [];
  for (let index = 0; index < options.misses; index += 1) {
    messages.push(
      await refusal(
        call("edit", { path, edits: [{ oldText: `absent text ${index}`, newText: "x" }] }),
      ),
    );
  }
  await call("edit", { path, edits: [{ oldText: options.oldText, newText: options.newText }] });
  await options.extra?.(call);
  const byTool = [...activity]
    .map(([name, counts]) => ({ name, ...counts }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const failedCalls = byTool.reduce((total, entry) => total + entry.failures, 0);
  return {
    tools: {
      totalCalls: byTool.reduce((total, entry) => total + entry.calls, 0),
      failedCalls,
      byTool,
      failureCategories: summarizeToolFailureCategories(
        failedCalls,
        toolSet.getFailureCategories(),
        0,
      ),
    },
    messages,
    mutationDenials: toolSet.getMutationBoundaryDenials(),
  };
}

function writeRecord(tools: ToolActivitySummary): RunRecord {
  const step = (id: string, mode: "read-only" | "write") => ({
    id,
    title: id,
    kind: "inference" as const,
    skill: id,
    mode,
    status: "succeeded" as const,
    startedAt: "2026-10-05T00:00:00.000Z",
    completedAt: "2026-10-05T00:00:01.000Z",
    durationMs: 1_000,
    summary: `${id} fixture summary.`,
  });
  return {
    schemaVersion: 2,
    id: "run-1916-tool-misses",
    workflow: "update-documentation",
    repository: {
      sourcePath: "/private/source",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-10-05T00:00:00.000Z",
    startedAt: "2026-10-05T00:00:00.000Z",
    completedAt: "2026-10-05T00:00:03.000Z",
    durationMs: 3_000,
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: structuredClone(tools),
    steps: [
      step("plan-documentation", "read-only"),
      { ...step(WRITE_STEP, "write"), tools: structuredClone(tools) },
      step(EVALUATE_STEP, "read-only"),
    ],
  };
}

/** The authoring projector's `not-ready` shape: a blocking product gap on the evaluator. */
function productGap(record: Readonly<RunRecord>): WorkflowOutcomeCandidateV1 {
  const evidence = workflowOutcomeStepEvidence(record as RunRecord, EVALUATE_STEP);
  return {
    disposition: "not-ready",
    findings: [
      {
        id: "finding:authoring-quality:product-gap.public-option-documentation-mismatch",
        kind: "product-gap",
        severity: "blocking",
        code: "product-gap.public-option-documentation-mismatch",
        evidenceIds: [evidence.id],
      },
    ],
    evidence: [evidence],
    limitations: [],
    openDecisions: [],
    producedArtifacts: [],
  };
}

function projecting(
  project: (record: Readonly<RunRecord>) => WorkflowOutcomeCandidateV1,
): WorkflowOutcomeProjector {
  return { project: async (record) => project(record) };
}

function outcomeRejection(run: () => unknown): { code: string; location: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof WorkflowOutcomeError) {
      return { code: error.code, location: error.location };
    }
    throw error;
  }
  throw new Error("Expected a workflow outcome refusal.");
}

describe("not-ready admission of recorded tool misses (#1916)", () => {
  it("admits a not-ready outcome whose writer missed six edits and names the misses", async () => {
    const root = await workspace();
    const { tools, messages } = await writerToolEvidence(root, "docs/guide.md", {
      misses: 6,
      oldText: "beta",
      newText: "BETA",
      allowedWritePaths: ["docs/guide.md"],
    });
    expect(messages).toEqual(Array(6).fill(RECOVERABLE_MISS_MESSAGES["edit-text-not-found"]));
    expect(tools.failureCategories).toEqual([{ category: "recoverable-miss", count: 6 }]);
    const record = writeRecord(tools);

    await applyWorkflowOutcome({ outcomeProjector: projecting(productGap), record });

    expect(record.workflowOutcomeRejection, JSON.stringify(record.workflowOutcomeRejection)).toBe(
      undefined,
    );
    expect(record.status).toBe("succeeded");
    expect(record.failure).toBeUndefined();
    expect(record.workflowOutcome).toMatchObject({
      disposition: "not-ready",
      limitations: [TOOL_MISSES_RECORDED_LIMITATION],
    });
    expect(record.workflowOutcome?.findings).toEqual([
      expect.objectContaining({
        kind: "product-gap",
        code: "product-gap.public-option-documentation-mismatch",
      }),
      {
        id: `finding:${TOOL_MISSES_RECORDED_LIMITATION}`,
        kind: "evidence-limitation",
        severity: "warning",
        code: TOOL_MISSES_RECORDED_LIMITATION,
        evidenceIds: [`step:${WRITE_STEP}`],
      },
    ]);
    // The saved outcome decodes, and the operator summary names the misses.
    expect(workflowOutcomeState(record).state).toBe("current");
    expect(renderWorkflowOutcome(record)).toEqual(
      expect.arrayContaining([
        `Product findings: product-gap.public-option-documentation-mismatch,${TOOL_MISSES_RECORDED_LIMITATION}`,
        `Product limitations: ${TOOL_MISSES_RECORDED_LIMITATION}`,
      ]),
    );
  });

  it.each([
    ["malformed-arguments", "read"],
    ["unsupported-pattern", "find"],
    ["citation-refused", "docsfab_cite_source"],
  ] as const)("records an attempt-level %s miss on not-ready", async (category, tool) => {
    const tools: ToolActivitySummary = {
      totalCalls: 2,
      failedCalls: 1,
      byTool: [{ name: tool, calls: 2, failures: 1 }],
      failureCategories: [{ category, count: 1 }],
    };
    const record = writeRecord(tools);
    // The same calls, recorded on the planner's one read-only attempt instead.
    delete record.steps[1]!.tools;
    record.steps[0]!.tools = structuredClone(tools);
    record.steps[0]!.inference = {
      configuredMaxRetries: 0,
      effectiveMaxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryableCategories: [],
      replay: "read-only",
      attempts: [
        {
          attempt: 1,
          outcome: "succeeded",
          retryable: false,
          retryScheduled: false,
          durationMs: 1,
          tools: structuredClone(tools),
        },
      ],
    };

    await applyWorkflowOutcome({ outcomeProjector: projecting(productGap), record });

    expect(record.status, JSON.stringify(record.workflowOutcomeRejection)).toBe("succeeded");
    expect(record.workflowOutcome?.limitations).toEqual([TOOL_MISSES_RECORDED_LIMITATION]);
    expect(
      record.workflowOutcome?.findings.find(
        (finding) => finding.code === TOOL_MISSES_RECORDED_LIMITATION,
      )?.evidenceIds,
    ).toEqual(["step:plan-documentation"]);
  });

  it.each([
    [
      "a write refused outside the plan",
      (call: Call) => refusal(call("write", { path: "docs/other.md", content: "x\n" })),
      "denied-path",
    ],
    [
      "an edit whose write failed",
      (call: Call) =>
        refusal(
          call("edit", { path: "docs/locked.md", edits: [{ oldText: "locked", newText: "x" }] }),
        ),
      "tool-defect",
    ],
  ] as const)("still rejects, coded, %s beside the misses", async (_name, extra, category) => {
    // Root writes through a read-only mode, which would hide the failed write.
    expect(process.getuid?.()).not.toBe(0);
    const root = await workspace();
    await writeFile(join(root, "docs", "locked.md"), "locked\n");
    await chmod(join(root, "docs", "locked.md"), 0o444);
    const { tools, mutationDenials } = await writerToolEvidence(root, "docs/guide.md", {
      misses: 6,
      oldText: "beta",
      newText: "BETA",
      allowedWritePaths: ["docs/guide.md", "docs/locked.md"],
      extra,
    });
    expect(tools.failureCategories).toEqual(
      [
        { category: "recoverable-miss" as const, count: 6 },
        { category, count: 1 },
      ].sort((left, right) => left.category.localeCompare(right.category)),
    );
    expect(mutationDenials).toBe(category === "denied-path" ? 1 : 0);
    const record = writeRecord(tools);

    await applyWorkflowOutcome({ outcomeProjector: projecting(productGap), record });

    expect(record.status).toBe("failed");
    expect(record.workflowOutcome).toBeUndefined();
    expect(record.workflowOutcomeRejection).toEqual({ code: REJECTED, location: "$.findings" });
    expect(record.failure).toEqual({ class: "contract-shape", layer: "workflow", code: REJECTED });
  });

  it("keeps ready strict and adds nothing to a not-ready run without misses", () => {
    const tools: ToolActivitySummary = {
      totalCalls: 2,
      failedCalls: 1,
      byTool: [{ name: "edit", calls: 2, failures: 1 }],
      failureCategories: [{ category: "recoverable-miss", count: 1 }],
    };
    const missed = writeRecord(tools);
    const ready = { ...productGap(missed), disposition: "ready" as const, findings: [] };
    expect(outcomeRejection(() => createWorkflowOutcome(ready, missed))).toEqual({
      code: "execution-product-mismatch",
      location: "$.disposition",
    });

    // Positive control: a clean not-ready run seals as before, with no limitation.
    const clean = writeRecord({ totalCalls: 0, failedCalls: 0, byTool: [] });
    const candidate = productGap(clean);
    expect(recordNotReadyToolMisses(candidate, clean)).toBe(candidate);
    expect(createWorkflowOutcome(candidate, clean).limitations).toEqual([]);
  });

  it("refuses a not-ready outcome that hides or invents recorded misses", () => {
    const tools: ToolActivitySummary = {
      totalCalls: 2,
      failedCalls: 1,
      byTool: [{ name: "edit", calls: 2, failures: 1 }],
      failureCategories: [{ category: "recoverable-miss", count: 1 }],
    };
    const record = writeRecord(tools);
    const recorded = recordNotReadyToolMisses(productGap(record), record);
    expect(createWorkflowOutcome(recorded, record).disposition).toBe("not-ready");

    // Hidden: the run recorded misses the outcome does not name.
    expect(outcomeRejection(() => createWorkflowOutcome(productGap(record), record))).toEqual({
      code: "execution-product-mismatch",
      location: "$.limitations",
    });
    // Unbound: the limitation does not cite the step that missed.
    const unbound = structuredClone(recorded);
    const evaluator = workflowOutcomeStepEvidence(record, EVALUATE_STEP).id;
    unbound.findings = unbound.findings.map((finding) =>
      finding.code === TOOL_MISSES_RECORDED_LIMITATION
        ? { ...finding, evidenceIds: [evaluator] }
        : finding,
    );
    unbound.evidence = unbound.evidence.filter((item) => item.id !== `step:${WRITE_STEP}`);
    expect(outcomeRejection(() => createWorkflowOutcome(unbound, record))).toEqual({
      code: "execution-product-mismatch",
      location: "$.findings[].evidenceIds",
    });
    // Invented: a run without misses cannot carry the limitation.
    const clean = writeRecord({ totalCalls: 0, failedCalls: 0, byTool: [] });
    const invented = recordNotReadyToolMisses(productGap(record), record);
    expect(outcomeRejection(() => createWorkflowOutcome(invented, clean))).toEqual({
      code: "execution-product-mismatch",
      location: "$.limitations[]",
    });
  });
});

/** `grep` calls on one step, `failures` of them recorded as tool defects. */
function grepDefects(calls: number, failures: number): ToolActivitySummary {
  return {
    totalCalls: calls,
    failedCalls: failures,
    byTool: [{ name: "grep", calls, failures }],
    failureCategories: [{ category: "tool-defect", count: failures }],
  };
}

describe("read-only tool defects on not-ready (#2041)", () => {
  it("labels grep defects on two read-only steps, citing each and not the writer", async () => {
    // The refused trials' shape: grep tool defects on the planner and on
    // derive-source-obligations, and a writer whose edit landed.
    const writer: ToolActivitySummary = {
      totalCalls: 1,
      failedCalls: 0,
      byTool: [{ name: "edit", calls: 1, failures: 0 }],
    };
    const record = writeRecord(writer);
    record.steps.unshift({
      ...structuredClone(record.steps[0]!),
      id: "derive-source-obligations",
      title: "derive-source-obligations",
      skill: "derive-source-obligations",
      tools: grepDefects(5, 2),
    });
    record.steps[1]!.tools = grepDefects(5, 5);
    record.tools = {
      totalCalls: 11,
      failedCalls: 7,
      byTool: [
        { name: "edit", calls: 1, failures: 0 },
        { name: "grep", calls: 10, failures: 7 },
      ],
      failureCategories: [{ category: "tool-defect", count: 7 }],
    };

    await applyWorkflowOutcome({ outcomeProjector: projecting(productGap), record });

    expect(record.status, JSON.stringify(record.workflowOutcomeRejection)).toBe("succeeded");
    expect(record.workflowOutcomeRejection).toBeUndefined();
    expect(record.workflowOutcome).toMatchObject({
      disposition: "not-ready",
      limitations: [TOOL_MISSES_RECORDED_LIMITATION],
    });
    expect(
      record.workflowOutcome?.findings.find(
        (finding) => finding.code === TOOL_MISSES_RECORDED_LIMITATION,
      )?.evidenceIds,
    ).toEqual(["step:derive-source-obligations", "step:plan-documentation"]);
    expect(workflowOutcomeState(record).state).toBe("current");
    // Hidden, the same defects still fail admission: the label is required.
    expect(outcomeRejection(() => createWorkflowOutcome(productGap(record), record))).toEqual({
      code: "execution-product-mismatch",
      location: "$.limitations",
    });
  });

  it("names the refusing write step, its category, its failed tools, and the patch in NEXT", async () => {
    // The planner's grep defects are labeled; the writer's failed write is not.
    const writer: ToolActivitySummary = {
      totalCalls: 3,
      failedCalls: 2,
      byTool: [
        { name: "edit", calls: 2, failures: 1 },
        { name: "read", calls: 1, failures: 1 },
      ],
      failureCategories: [
        { category: "recoverable-miss", count: 1 },
        { category: "tool-defect", count: 1 },
      ],
    };
    const record = writeRecord(writer);
    record.steps[0]!.tools = grepDefects(4, 4);
    record.tools = {
      totalCalls: 7,
      failedCalls: 6,
      byTool: [
        { name: "edit", calls: 2, failures: 1 },
        { name: "grep", calls: 4, failures: 4 },
        { name: "read", calls: 1, failures: 1 },
      ],
      failureCategories: [
        { category: "recoverable-miss", count: 1 },
        { category: "tool-defect", count: 5 },
      ],
    };
    const patchPath = "/state/runs/run-2041-patch/changes.patch";
    record.changes = {
      files: [{ path: "docs/guide.md", status: "modified" }],
      patch: {
        sha256: "b".repeat(64),
        byteLength: 42,
        lineCount: 3,
        artifactPath: patchPath,
        format: "git-diff",
      },
    };

    await applyWorkflowOutcome({ outcomeProjector: projecting(productGap), record });
    expect(record.workflowOutcomeRejection).toEqual({ code: REJECTED, location: "$.findings" });

    const context = {
      record,
      recordPath: `/state/runs/${record.id}.json`,
      repositoryPath: "/work/repository",
      exitCode: 1 as const,
    };
    const next = buildRunHumanNextCommand(context);
    expect(next?.command).toBe(`docsfab runs show ${record.id} --state-dir /state/runs --json`);
    expect(next?.reason).toContain(
      `${WRITE_STEP} recorded tool-defect (failed calls: edit 1, read 1)`,
    );
    expect(next?.reason).toContain(`Review the retained patch at ${patchPath}`);
    expect(next?.reason).toContain("do not retry unchanged inference");
    expect(next?.reason).not.toContain("plan-documentation");
    expect(next?.reason).not.toContain("tool-accounting producer");
    expect(collectRunResultNextSteps(context)).toEqual([next?.command, next?.reason]);

    // Positive control: a refusal NEXT cannot attribute keeps the generic action.
    const unattributed = structuredClone(record);
    unattributed.workflowOutcomeRejection = {
      code: "workflow-outcome-admission-execution-product-mismatch",
      location: "$.limitations",
    };
    expect(buildRunHumanNextCommand({ ...context, record: unattributed })?.reason).toContain(
      "correct the outcome projector or tool-accounting producer",
    );
  });
});

/** The writer's six edit misses and one landed edit, through the real confined tools. */
function missingWriter(messages: string[]) {
  return async (input: HarnessStepInput): Promise<ToolActivitySummary | undefined> => {
    if (input.step.id !== WRITE_STEP) return undefined;
    const evidence = await writerToolEvidence(input.repositoryPath, "docs/cli.md", {
      misses: 6,
      oldText: "The public option is --old.",
      newText: "The public option is now --new.",
      allowedWritePaths: documentationPlanWritePaths(input.planBinding!),
    });
    messages.push(...evidence.messages);
    return evidence.tools;
  };
}

async function updateFixture() {
  const fixture = await orbitOptionChangeRepository("docsfab-tool-misses", fixtureDirectories);
  const { repository, base, head, config } = fixture;
  const supplier = await createReaderTaskContextSupplier(
    await verifyQualityPackContext({
      skillCrateDirectory: config.skillCrateDirectory,
      qualityDirectory: config.qualityDirectory,
      qualityPackDirectory: config.qualityPackDirectory,
    }),
  );
  const readerContextInput = orbitReaderContextInput();
  const observation = await observeReaderTaskContextAdmissionV1({
    repositoryPath: repository,
    revision: head,
    observationMode: "workflow-export",
    readerContextInput,
    comparisonRequest: { kind: "base-head", baseRevision: base, headRevision: head },
    sourceHints: [{ role: "public-contract", path: "src/orbit.ts" }],
  });
  const publicContract = observation.admission.sources.find(
    (source) => source.role === "public-contract",
  );
  if (!publicContract) throw new Error("fixture public contract was not admitted");
  return {
    ...fixture,
    impactSource: { uri: publicContract.uri, sha256: publicContract.sha256 },
    handoff: supplier.createHandoff({
      readerContextInput,
      admission: observation.admission,
      inputOrigin: "explicit",
      sourceBinding: observation.sourceBinding,
    }),
  };
}

describe("an update run with model tool misses delivers its not-ready patch (#1916)", () => {
  it("keeps the outcome and patch, names the misses, and applies the patch", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const fixture = await updateFixture();
    const writerMessages: string[] = [];
    const harness = new EditorialProtocolHarness({
      candidate: "update",
      impactSource: fixture.impactSource,
      rejectedAssessmentStep: "review-documentation",
      rejectedRecommendation: "update",
      stepTools: missingWriter(writerMessages),
    });

    const record = await executeRunRequest(
      {
        workflow: "update-documentation",
        repositoryPath: fixture.repository,
        revision: fixture.head,
        instruction: "Update docs/cli.md for the changed public option.",
        readerTaskContext: fixture.handoff,
        canonSnapshotPath: fixture.canonSnapshotPath,
        allowWrite: true,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      fixture.config,
      { silent: true, harness },
    );

    expect(record?.steps.every((step) => step.status === "succeeded")).toBe(true);
    // The field failure names its recorded refusal here.
    expect(record?.status, JSON.stringify(record?.workflowOutcomeRejection)).toBe("succeeded");
    expect(writerMessages).toEqual(Array(6).fill(RECOVERABLE_MISS_MESSAGES["edit-text-not-found"]));
    expect(record?.steps.find((step) => step.id === WRITE_STEP)?.tools?.failureCategories).toEqual([
      { category: "recoverable-miss", count: 6 },
    ]);
    expect(record?.workflowOutcome).toMatchObject({
      disposition: "not-ready",
      limitations: [TOOL_MISSES_RECORDED_LIMITATION],
    });
    expect(record?.workflowOutcome?.findings.map((finding) => finding.code)).toEqual([
      "product-gap.public-option-documentation-mismatch",
      TOOL_MISSES_RECORDED_LIMITATION,
    ]);
    expect(record?.changes?.files).toEqual([{ path: "docs/cli.md", status: "modified" }]);
    expect(await readFile(record!.changes!.patch!.artifactPath, "utf8")).toContain(
      "The public option is now --new.",
    );

    // The operator summary and the saved JSON result both name the misses.
    const decodeOptions = await loadSavedRunEditorialDecodeOptions(
      record!,
      fixture.config.stateDirectory,
    );
    expect(renderWorkflowOutcome(record!, { decodeOptions })).toContain(
      `Product limitations: ${TOOL_MISSES_RECORDED_LIMITATION}`,
    );
    const output: string[] = [];
    const log = console.log;
    console.log = (message?: unknown): void => {
      output.push(String(message));
    };
    try {
      await handleRunsCommand([
        "show",
        record!.id,
        "--json",
        "--state-dir",
        fixture.config.stateDirectory,
      ]);
    } finally {
      console.log = log;
    }
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      execution: { status: "succeeded", patchPath: record!.changes!.patch!.artifactPath },
      product: {
        disposition: "not-ready",
        limitations: expect.arrayContaining([TOOL_MISSES_RECORDED_LIMITATION]),
      },
    });

    // Delivery applies the patch to the source checkout.
    const delivery = new LiveWorkflowDelivery({
      repositoryPath: fixture.repository,
      stateDirectory: fixture.config.stateDirectory,
      allowWrite: true,
      documentationScope: new DocumentationScope(),
      confirmPublication: async () => false,
    });
    const delivered = await delivery.persist(record!);
    expect(delivered, JSON.stringify(delivered)).toEqual({ status: "applied" });
    expect(await readFile(join(fixture.repository, "docs/cli.md"), "utf8")).toContain(
      "The public option is now --new.",
    );
  });

  it("keeps a not-ready patch when a read-only step's read and tool call were refused", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const fixture = await updateFixture();
    const REVIEW_STEP = "review-documentation";
    // A reviewer that read an absolute path and called a tool it was not
    // offered: each call was refused and changed nothing.
    const refusedReviewer = async (
      input: HarnessStepInput,
    ): Promise<ToolActivitySummary | undefined> => {
      if (input.step.id !== REVIEW_STEP) return undefined;
      const toolSet = await createConfinedToolSet({
        workspacePath: input.repositoryPath,
        allowWrite: false,
      });
      await refusal(caller(toolSet)("read", { path: "/etc/hosts" }));
      return {
        totalCalls: 2,
        failedCalls: 2,
        byTool: [
          { name: "read", calls: 1, failures: 1 },
          { name: "unknown-tool", calls: 1, failures: 1 },
        ],
        failureCategories: summarizeToolFailureCategories(2, toolSet.getFailureCategories(), 0, 1),
      };
    };
    const harness = new EditorialProtocolHarness({
      candidate: "update",
      impactSource: fixture.impactSource,
      rejectedAssessmentStep: REVIEW_STEP,
      rejectedRecommendation: "update",
      stepTools: refusedReviewer,
    });

    const record = await executeRunRequest(
      {
        workflow: "update-documentation",
        repositoryPath: fixture.repository,
        revision: fixture.head,
        instruction: "Update docs/cli.md for the changed public option.",
        readerTaskContext: fixture.handoff,
        canonSnapshotPath: fixture.canonSnapshotPath,
        allowWrite: true,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      fixture.config,
      { silent: true, harness },
    );

    const review = record?.steps.find((step) => step.id === REVIEW_STEP);
    expect(review?.mode).toBe("read-only");
    expect(review?.tools?.failureCategories).toEqual([
      { category: "denied-path", count: 1 },
      { category: "unknown-tool", count: 1 },
    ]);
    expect(record?.status, JSON.stringify(record?.workflowOutcomeRejection)).toBe("succeeded");
    expect(record?.workflowOutcomeRejection).toBeUndefined();
    expect(record?.workflowOutcome).toMatchObject({
      disposition: "not-ready",
      limitations: [TOOL_MISSES_RECORDED_LIMITATION],
    });
    expect(
      record?.workflowOutcome?.findings.find(
        (finding) => finding.code === TOOL_MISSES_RECORDED_LIMITATION,
      )?.evidenceIds,
    ).toEqual([`step:${REVIEW_STEP}`]);
    expect(record?.changes?.files).toEqual([{ path: "docs/cli.md", status: "modified" }]);
  });

  it("labels a read-only step's tool defect on not-ready and still refuses a write step's", async () => {
    // Root reads through a mode-000 file, which would hide the failed read.
    expect(process.getuid?.()).not.toBe(0);
    const root = await workspace();
    await writeFile(join(root, "docs", "locked.md"), "locked\n");
    await chmod(join(root, "docs", "locked.md"), 0o000);
    const toolSet = await createConfinedToolSet({ workspacePath: root, allowWrite: false });
    // The read itself failed inside the host: a tool defect, not a model miss.
    expect(await refusal(caller(toolSet)("read", { path: "docs/locked.md" }))).toBe(
      "DocsFab tool failed internally.",
    );
    const tools: ToolActivitySummary = {
      totalCalls: 1,
      failedCalls: 1,
      byTool: [{ name: "read", calls: 1, failures: 1 }],
      failureCategories: summarizeToolFailureCategories(1, toolSet.getFailureCategories(), 0),
    };
    expect(tools.failureCategories).toEqual([{ category: "tool-defect", count: 1 }]);
    const record = writeRecord({ totalCalls: 0, failedCalls: 0, byTool: [] });
    record.tools = structuredClone(tools);
    record.steps[0]!.tools = structuredClone(tools);
    delete record.steps[1]!.tools;

    // The read-only planner cannot change the patch: its defect is a label.
    const outcome = createWorkflowOutcome(
      recordNotReadyToolMisses(productGap(record), record),
      record,
    );
    expect(outcome.limitations).toEqual([TOOL_MISSES_RECORDED_LIMITATION]);
    expect(
      outcome.findings.find((finding) => finding.code === TOOL_MISSES_RECORDED_LIMITATION)
        ?.evidenceIds,
    ).toEqual(["step:plan-documentation"]);

    // The same defect on the write step can be a write that failed part-way.
    const write = writeRecord(structuredClone(tools));
    expect(
      outcomeRejection(() =>
        createWorkflowOutcome(recordNotReadyToolMisses(productGap(write), write), write),
      ),
    ).toEqual({ code: "execution-product-mismatch", location: "$.findings" });
  });

  it("keeps a not-ready patch when the planner's grep calls failed", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    // Root reads through a mode-000 file, which would hide the failed search.
    expect(process.getuid?.()).not.toBe(0);
    const fixture = await updateFixture();
    const PLANNER = "plan-documentation";
    const results: string[] = [];
    const messages: string[] = [];
    // The refused trials' planners searched with the real confined grep: here
    // one search matches nothing, one pattern is a regex ripgrep rejects, and
    // one search crosses a file the host cannot read.
    const grepPlanner = async (
      input: HarnessStepInput,
    ): Promise<ToolActivitySummary | undefined> => {
      if (input.step.id !== PLANNER) return undefined;
      const toolSet = await createConfinedToolSet({
        workspacePath: input.repositoryPath,
        allowWrite: false,
      });
      const call = caller(toolSet);
      results.push(resultText(await call("grep", { pattern: "--retired", path: "docs" })));
      messages.push(await refusal(call("grep", { pattern: "option(", path: "src" })));
      // An untracked file the host cannot read, removed before the step ends;
      // the run verifies its tracked files are unchanged.
      const locked = join(input.repositoryPath, "src", "locked.ts");
      await writeFile(locked, "export const locked = true;\n");
      await chmod(locked, 0o000);
      try {
        messages.push(await refusal(call("grep", { pattern: "option", path: "." })));
      } finally {
        await rm(locked, { force: true });
      }
      return {
        totalCalls: 3,
        failedCalls: 2,
        byTool: [{ name: "grep", calls: 3, failures: 2 }],
        failureCategories: summarizeToolFailureCategories(2, toolSet.getFailureCategories(), 0),
      };
    };
    const harness = new EditorialProtocolHarness({
      candidate: "update",
      impactSource: fixture.impactSource,
      rejectedAssessmentStep: "review-documentation",
      rejectedRecommendation: "update",
      stepTools: grepPlanner,
    });

    const record = await executeRunRequest(
      {
        workflow: "update-documentation",
        repositoryPath: fixture.repository,
        revision: fixture.head,
        instruction: "Update docs/cli.md for the changed public option.",
        readerTaskContext: fixture.handoff,
        canonSnapshotPath: fixture.canonSnapshotPath,
        allowWrite: true,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      fixture.config,
      { silent: true, harness },
    );

    // The trials' refusal: this code at $.findings, with the patch discarded.
    expect(record?.status, JSON.stringify(record?.workflowOutcomeRejection)).toBe("succeeded");
    expect(record?.workflowOutcomeRejection).toBeUndefined();
    expect(results).toEqual(["No matches found"]);
    expect(messages).toEqual([
      GREP_FAILURE_MESSAGES["regex-rejected"],
      GREP_FAILURE_MESSAGES["unreadable-path"],
    ]);
    const planner = record?.steps.find((step) => step.id === PLANNER);
    expect(planner?.mode).toBe("read-only");
    expect(planner?.tools?.failureCategories).toEqual([
      { category: "tool-defect", count: 1 },
      { category: "unsupported-pattern", count: 1 },
    ]);
    expect(record?.workflowOutcome).toMatchObject({
      disposition: "not-ready",
      limitations: [TOOL_MISSES_RECORDED_LIMITATION],
    });
    expect(
      record?.workflowOutcome?.findings.find(
        (finding) => finding.code === TOOL_MISSES_RECORDED_LIMITATION,
      )?.evidenceIds,
    ).toEqual([`step:${PLANNER}`]);
    expect(record?.changes?.files).toEqual([{ path: "docs/cli.md", status: "modified" }]);
    expect(await readFile(record!.changes!.patch!.artifactPath, "utf8")).toContain("docs/cli.md");
  });

  it("keeps a not-ready patch when the planner's get_section path was refused or missing", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const fixture = await updateFixture();
    const PLANNER = "plan-documentation";
    const messages: string[] = [];
    // The planner asks get_section for a page outside the workspace and for a
    // missing page, through the real confined observation tool.
    const missingPlanner = async (
      input: HarnessStepInput,
    ): Promise<ToolActivitySummary | undefined> => {
      if (input.step.id !== PLANNER) return undefined;
      const toolSet = await createConfinedToolSet({
        workspacePath: input.repositoryPath,
        allowWrite: false,
        repositoryRevision: fixture.head,
        search: input.step.search,
      });
      for (const path of ["../outside.md", "docs/missing.md"]) {
        messages.push(
          await refusal(caller(toolSet)("get_section", { path, headingId: "options" })),
        );
      }
      return {
        totalCalls: 2,
        failedCalls: 2,
        byTool: [{ name: "get_section", calls: 2, failures: 2 }],
        failureCategories: summarizeToolFailureCategories(2, toolSet.getFailureCategories(), 0),
      };
    };
    const harness = new EditorialProtocolHarness({
      candidate: "update",
      impactSource: fixture.impactSource,
      rejectedAssessmentStep: "review-documentation",
      rejectedRecommendation: "update",
      stepTools: missingPlanner,
    });

    const record = await executeRunRequest(
      {
        workflow: "update-documentation",
        repositoryPath: fixture.repository,
        revision: fixture.head,
        instruction: "Update docs/cli.md for the changed public option.",
        readerTaskContext: fixture.handoff,
        canonSnapshotPath: fixture.canonSnapshotPath,
        allowWrite: true,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      fixture.config,
      { silent: true, harness },
    );

    expect(messages.map((message) => message.slice(0, message.indexOf(":")))).toEqual([
      "DocsFab get_section refused (get-section-denied-path, path rule traversal)",
      "DocsFab get_section refused (get-section-not-found)",
    ]);
    expect(record?.steps.find((step) => step.id === PLANNER)?.tools?.failureCategories).toEqual([
      { category: "denied-path", count: 1 },
      { category: "expected-missing-probe", count: 1 },
    ]);
    expect(record?.status, JSON.stringify(record?.workflowOutcomeRejection)).toBe("succeeded");
    expect(record?.workflowOutcome).toMatchObject({
      disposition: "not-ready",
      limitations: [TOOL_MISSES_RECORDED_LIMITATION],
    });
    expect(
      record?.workflowOutcome?.findings.find(
        (finding) => finding.code === TOOL_MISSES_RECORDED_LIMITATION,
      )?.evidenceIds,
    ).toEqual([`step:${PLANNER}`]);
    expect(record?.changes?.files).toEqual([{ path: "docs/cli.md", status: "modified" }]);
  });

  it("reports a still-refused outcome by its recorded code, not as invalid evidence", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const fixture = await updateFixture();
    const harness = new EditorialProtocolHarness({
      candidate: "update",
      impactSource: fixture.impactSource,
      rejectedAssessmentStep: "review-documentation",
      rejectedRecommendation: "update",
      // The writer also read outside the workspace: refused, and still material.
      // The planner's grep defects are labeled, so NEXT names only the writer.
      stepTools: async (input) =>
        input.step.id === WRITE_STEP
          ? (
              await writerToolEvidence(input.repositoryPath, "docs/cli.md", {
                misses: 6,
                oldText: "The public option is --old.",
                newText: "The public option is now --new.",
                allowedWritePaths: documentationPlanWritePaths(input.planBinding!),
                extra: (call) => refusal(call("read", { path: "../outside.md" })),
              })
            ).tools
          : input.step.id === "plan-documentation"
            ? grepDefects(2, 2)
            : undefined,
    });

    const record = await executeRunRequest(
      {
        workflow: "update-documentation",
        repositoryPath: fixture.repository,
        revision: fixture.head,
        instruction: "Update docs/cli.md for the changed public option.",
        readerTaskContext: fixture.handoff,
        allowWrite: true,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      fixture.config,
      { silent: true, harness },
    );

    expect(record?.status).toBe("failed");
    expect(record?.workflowOutcome).toBeUndefined();
    expect(record?.workflowOutcomeRejection).toEqual({ code: REJECTED, location: "$.findings" });
    expect(record?.changes?.files).toEqual([{ path: "docs/cli.md", status: "modified" }]);
    const output: string[] = [];
    const log = console.log;
    console.log = (message?: unknown): void => {
      output.push(String(message));
    };
    try {
      await handleRunsCommand([
        "show",
        record!.id,
        "--json",
        "--state-dir",
        fixture.config.stateDirectory,
      ]);
    } finally {
      console.log = log;
    }
    const shown = JSON.parse(output.at(-1) ?? "{}");
    expect(shown).toMatchObject({
      execution: { status: "failed", patchPath: record!.changes!.patch!.artifactPath },
      failures: expect.arrayContaining([
        expect.objectContaining({ class: "contract-shape", code: REJECTED }),
      ]),
    });
    // NEXT names the step, category, and failed tools, and points at the patch.
    const reason = (shown.nextSteps as string[]).find((line) => line.includes(WRITE_STEP)) ?? "";
    expect(reason).toContain(`${WRITE_STEP} recorded denied-path (failed calls: edit 6, read 1)`);
    expect(reason).toContain(
      `Review the retained patch at ${record!.changes!.patch!.artifactPath}`,
    );
    expect(reason).not.toContain("plan-documentation");

    // Only that refusal keeps a failed run's final decision readable.
    const decodeOptions = await loadSavedRunEditorialDecodeOptions(
      record!,
      fixture.config.stateDirectory,
    );
    expect(decodeRunRecordEditorialEvidence(record!, decodeOptions)).toMatchObject({
      state: "current",
      validated: { candidate: "update" },
    });
    const unexplained = structuredClone(record!);
    delete unexplained.workflowOutcomeRejection;
    const stepFailed = structuredClone(record!);
    stepFailed.steps.at(-1)!.status = "failed";
    for (const failed of [unexplained, stepFailed]) {
      expect(
        outcomeRejection(() => decodeRunRecordEditorialEvidence(failed, decodeOptions)),
      ).toEqual({ code: "invalid-evidence", location: "$" });
    }
  });
});
