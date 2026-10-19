// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { executeWorkflowRun } from "../src/cli/run/execution.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";

const REVISION = "a".repeat(40);
const HASH = "b".repeat(64);
const SOURCE_HASH = "c".repeat(64);

const state = vi.hoisted(() => ({
  observedInputs: [] as unknown[],
  completedInputs: [] as unknown[],
  runInputs: [] as unknown[],
}));

vi.mock("../src/quality-pack/manifest.js", () => ({
  verifyQualityPackContext: async () => ({ evidence: {} }),
}));
vi.mock("../src/harness/pi.js", () => ({ PiHarness: class {} }));
vi.mock("../src/workflow-contracts/outcome.js", () => ({
  workflowOutcomeExitCode: () => 0,
  interactiveWorkflowOutcomePolicy: () => ({}),
  releaseGateWorkflowOutcomePolicy: () => ({}),
}));
vi.mock("../src/workflow-execution/runner.js", () => ({
  WorkflowRunner: class {
    async run(input: unknown) {
      state.runInputs.push(input);
      return {
        workflow: "update-documentation",
        status: "succeeded",
        steps: [],
      };
    }
  },
}));
vi.mock("../src/execution/reader-task-admission.js", () => ({
  observeReaderTaskContextAdmissionV1: async (input: unknown) => {
    state.observedInputs.push(input);
    return {
      admission: {
        admittedRevision: REVISION,
        workspaceSnapshotSha256: HASH,
        repositoryIdentitySha256: HASH,
        comparison: {
          kind: "base-head",
          base_revision: REVISION,
          head_revision: REVISION,
        },
        sources: [
          {
            uri: "docs/guide.md",
            role: "current-documentation",
            sha256: SOURCE_HASH,
          },
          {
            uri: "src/public.ts",
            role: "public-contract",
            sha256: SOURCE_HASH,
          },
          { uri: "request:instruction", role: "request", sha256: SOURCE_HASH },
        ],
        provenanceLimitations: ["changed-source-not-applicable-identical-revisions"],
      },
      sourceBytes: [],
      changedPaths: [],
    };
  },
}));
vi.mock("../src/execution/task-context.js", () => ({
  conservativeReaderContextInput: ({ instruction }: { instruction: string }) =>
    readerContextInput(instruction),
  createStyleTaskContext: async () => ({ prompt: "" }),
  createReaderTaskContextSupplier: async () => ({
    baseline: { path: "baseline.md", sha256: HASH, content: "baseline" },
    policy: { id: "policy", version: "v1", sha256: HASH },
    validateHandoff: (value: unknown) => value,
    projectInput: (
      value: unknown,
      options: {
        inputOrigin?: "explicit" | "conservative-fallback";
        handoff?: { noChangeAssessment: "requires-evidence" };
      } = {},
    ) => ({
      schemaVersion: 1,
      kind: "docsfab-reader-task-context-input",
      inputOrigin: options.inputOrigin ?? "explicit",
      noChangeAssessment: options.handoff?.noChangeAssessment ?? "ineligible",
      readerContextInput: value,
      baseline: { path: "baseline.md", sha256: HASH, content: "baseline" },
      policy: { id: "policy", version: "v1", sha256: HASH },
      prompt: "input",
    }),
    projectCompleted: (input: Record<string, unknown>) => {
      state.completedInputs.push(input);
      const context = input.readerContext as Record<string, unknown>;
      return {
        schemaVersion: 1,
        kind: "docsfab-reader-task-context-completed",
        inputOrigin: input.inputOrigin,
        noChangeAssessment: "requires-evidence",
        readerContextInput: readerContextInput("Update the guide."),
        baseline: { path: "baseline.md", sha256: HASH, content: "baseline" },
        policy: { id: "policy", version: "v1", sha256: HASH },
        readerContext: context,
        provenance: input.provenance,
        prompt: "completed",
      };
    },
  }),
}));

describe("CLI reader context projection", () => {
  it("passes the admitted input projection to the runner before branch selection", async () => {
    state.observedInputs.length = 0;
    state.completedInputs.length = 0;
    state.runInputs.length = 0;

    await executeWorkflowRun(
      invocation({
        comparisonRequest: {
          kind: "base-head",
          baseRevision: REVISION,
          headRevision: REVISION,
        },
        readerSources: [{ role: "public-contract", path: "src/public.ts" }],
      }),
      workspace(),
      {} as never,
      { workflow: getWorkflow("update-documentation") } as never,
      {} as never,
    );

    expect(state.observedInputs[0]).toMatchObject({
      comparisonRequest: {
        kind: "base-head",
        baseRevision: REVISION,
        headRevision: REVISION,
      },
      sourceHints: [{ role: "public-contract", path: "src/public.ts" }],
      requestText: "Update the guide.",
    });
    expect(state.completedInputs).toEqual([]);
    expect(state.runInputs[0]).toMatchObject({
      readerTaskContext: {
        kind: "docsfab-reader-task-context-input",
        inputOrigin: "conservative-fallback",
        noChangeAssessment: "ineligible",
        readerContextInput: readerContextInput("Update the guide."),
      },
    });
  });

  it("replays request evidence as virtual bytes instead of a repository path", async () => {
    state.observedInputs.length = 0;
    state.completedInputs.length = 0;
    state.runInputs.length = 0;
    const input = readerContextInput("Update the guide.");

    await executeWorkflowRun(
      invocation({
        readerTaskContext: {
          schemaVersion: 1,
          kind: "docsfab-reader-task-context-handoff",
          inputOrigin: "explicit",
          noChangeAssessment: "requires-evidence",
          readerContextInput: input,
          baselineSha256: HASH,
          policy: { id: "policy", version: "v1", sha256: HASH },
          admittedRevision: REVISION,
          workspaceSnapshotSha256: HASH,
          repositoryIdentitySha256: HASH,
          comparison: {
            kind: "base-head",
            base_revision: REVISION,
            head_revision: REVISION,
          },
          sources: [
            {
              uri: "docs/guide.md",
              role: "current-documentation",
              sha256: SOURCE_HASH,
            },
            {
              uri: "src/public.ts",
              role: "public-contract",
              sha256: SOURCE_HASH,
            },
            {
              uri: "request:instruction",
              role: "request",
              sha256: SOURCE_HASH,
            },
          ],
          provenanceLimitations: ["changed-source-not-applicable-identical-revisions"],
          sourceBinding: null,
          handoffSha256: HASH,
        },
      }),
      workspace(),
      {} as never,
      { workflow: getWorkflow("update-documentation") } as never,
      {} as never,
    );

    expect(state.observedInputs[0]).toMatchObject({
      sourceHints: [
        { role: "current-documentation", path: "docs/guide.md" },
        { role: "public-contract", path: "src/public.ts" },
      ],
      requestText: "Update the guide.",
    });
    expect(
      (state.observedInputs[0] as { sourceHints: Array<{ path: string }> }).sourceHints,
    ).not.toContainEqual(expect.objectContaining({ path: "request:instruction" }));
  });
});

function invocation(extra: Record<string, unknown> = {}) {
  return {
    request: {
      workflow: "update-documentation",
      instruction: "Update the guide.",
      allowWrite: false,
      ...extra,
    },
    config: {
      skillCrateDirectory: "/fixture/skills",
      qualityDirectory: "/fixture/quality",
      qualityPackDirectory: "/fixture/quality-pack",
      stateDirectory: "/fixture/runs",
      model: {},
      retryPolicy: {},
    },
    options: { quiet: true },
    output: { log: vi.fn(), error: vi.fn() },
  } as never;
}

function workspace() {
  return {
    sourcePath: "/fixture/repository",
    path: "/fixture/workspace",
    requestedRevision: REVISION,
    revision: REVISION,
  } as never;
}

function readerContextInput(instruction: string) {
  return {
    schema_version: 1 as const,
    target_audience: "documentation readers",
    reader_job: instruction,
    change_scope: ["docs/guide.md"],
    source_priority: ["request", "current documentation", "public contract"],
    required_content: [instruction],
    excluded_content: ["unrelated content"],
    unresolved_questions: ["Confirm the independently observed impact."],
    known_limitations: ["No independent impact decision exists yet."],
  };
}
