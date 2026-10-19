// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The answer path's run-entry thread: `executeWorkflowRun` reads the
 * capability from the bound profile it hands the harness, and
 * `createLocalWorkflowApplicationServices` passes it, with the operator's
 * option, into the runner options the step loop resolves from. The runner and
 * the harness are replaced here so the test reads exactly what reached them;
 * the runner-to-harness half runs in `quality-artifact-staging.test.ts`.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadCompositionRunRuntime } from "../src/cli/run/composition-runtime.js";
import { executeWorkflowRun } from "../src/cli/run/execution.js";
import type { CompositionRunRuntime } from "../src/cli/run/composition-runtime.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type { BoundModelExecutionProfile } from "../src/model/configuration.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { validModelConfig } from "./helpers.js";
import { initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const roots = temporaryRoots();
const workspaces: RepositoryWorkspace[] = [];

const { seen, RECORDED_CAPABILITY, COMPOSITION_CAPABILITY } = vi.hoisted(() => ({
  seen: {
    harnessProfiles: [] as unknown[],
    runnerOptions: [] as Array<Record<string, unknown>>,
  },
  /** The capability a borrow attaches to the bound profile; the digest is a fixture value. */
  RECORDED_CAPABILITY: Object.freeze({
    kind: "host-tool-call" as const,
    argumentShell: "untyped" as const,
    duplicateKeys: "forwarded" as const,
    reportTurnToolChoice: "none" as const,
    evidenceSha256: "e".repeat(64),
  }),
  /**
   * The capability a `--composition` run's bound profile carries. Distinct from
   * the borrowed one, so a test can tell which profile the runner read.
   */
  COMPOSITION_CAPABILITY: Object.freeze({
    kind: "host-tool-call" as const,
    argumentShell: "typed" as const,
    duplicateKeys: "unobserved" as const,
    reportTurnToolChoice: "auto" as const,
    evidenceSha256: "c".repeat(64),
  }),
}));

vi.mock("../src/harness/pi.js", () => ({
  PiHarness: class {
    constructor(options: { executionProfile: unknown }) {
      seen.harnessProfiles.push(options.executionProfile);
    }
  },
}));
vi.mock("../src/workflow-execution/runner.js", () => ({
  WorkflowRunner: class {
    constructor(options: Record<string, unknown>) {
      seen.runnerOptions.push(options);
    }
    async run() {
      return { workflow: "review-documentation", status: "failed", steps: [] };
    }
  },
}));
// The composition evidence is projected for the runner, which is replaced
// here; its own suite covers the projection.
vi.mock("../src/records/composition-execution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/records/composition-execution.js")>()),
  createCompositionExecutionEvidence: () => ({}),
}));
// The real operator binding, with the capability a borrow would attach.
vi.mock("../src/model/operator-execution-binding.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/model/operator-execution-binding.js")>();
  return {
    ...actual,
    resolveOperatorExecutionBinding: async (
      input: Parameters<typeof actual.resolveOperatorExecutionBinding>[0],
    ) => {
      const binding = await actual.resolveOperatorExecutionBinding(input);
      return { ...binding, profile: { ...binding.profile, answerSubmission: RECORDED_CAPABILITY } };
    },
  };
});

afterEach(async () => {
  seen.harnessProfiles.length = 0;
  seen.runnerOptions.length = 0;
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.dispose()));
  await roots.cleanup();
});

/** A real `--composition` runtime for the sealed Super lane, bound offline. */
async function superCompositionRuntime(): Promise<CompositionRunRuntime> {
  const modelConfig = {
    ...validModelConfig,
    providerId: "nvidia-api-catalog",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    modelId: "nvidia/nemotron-3-super-120b-a12b",
    apiFormat: "chat_completions" as const,
    apiKey: "selected-test-credential",
    profile: {
      ...validModelConfig.profile,
      compatibility: {
        ...validModelConfig.profile.compatibility,
        apiFormats: ["chat_completions" as const],
      },
    },
  };
  return loadCompositionRunRuntime(
    {
      workflow: "review-documentation",
      repositoryPath: "/tmp/docsfab-composition-target",
      revision: "HEAD",
      allowWrite: false,
      releaseGate: false,
      verbose: false,
      json: false,
      showScan: false,
      compositionId: "nvidia-nemotron-3-super-120b-a12b-pi",
    },
    {
      projectRoot: runtimeRoot,
      skillCrateDirectory: join(runtimeRoot, "skill-crate"),
      qualityDirectory: join(runtimeRoot, "quality"),
      qualityPackDirectory: join(runtimeRoot, "quality-pack"),
      stateDirectory: "/tmp/docsfab-state/runs",
      retryPolicy: {
        maxRetries: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
        retryableCategories: ["timeout"],
      },
      model: modelConfig,
    } as DocsFabConfig,
    {},
  );
}

async function reviewRun(
  answerSubmission?: "recorded" | "text-final",
  compositionRuntime?: CompositionRunRuntime,
) {
  const repository = await roots.create("docsfab-answer-path-binding-");
  await initFixtureRepo(repository, {
    "docs/guide.md": "# Guide\n\nDeterministic documentation.\n",
  });
  const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
  workspaces.push(workspace);
  const stateDirectory = join(repository, "runs");
  await mkdir(stateDirectory, { recursive: true });
  const workflow = getWorkflow("review-documentation");
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    await executeWorkflowRun(
      {
        request: { workflow: workflow.name, verbose: false, allowWrite: false } as never,
        ...(compositionRuntime ? { compositionRuntime } : {}),
        config: {
          skillCrateDirectory: join(runtimeRoot, "skill-crate"),
          qualityDirectory: join(runtimeRoot, "quality"),
          qualityPackDirectory: join(runtimeRoot, "quality-pack"),
          stateDirectory,
          model: validModelConfig,
          ...(answerSubmission ? { answerSubmission } : {}),
        } as never,
        options: { silent: true },
        output: { log: vi.fn(), error: vi.fn() },
      },
      workspace,
      {} as never,
      { workflow } as never,
      {} as never,
    );
  } finally {
    stderr.mockRestore();
  }
}

describe("the answer path from the run entry point to the runner", () => {
  it("passes the bound profile's capability and the default option to the runner", async () => {
    await reviewRun();

    // The harness and the runner read one capability: the bound profile's.
    expect(seen.harnessProfiles).toHaveLength(1);
    expect((seen.harnessProfiles[0] as BoundModelExecutionProfile).answerSubmission).toBe(
      RECORDED_CAPABILITY,
    );
    expect(seen.runnerOptions).toHaveLength(1);
    expect(seen.runnerOptions[0]!.answerSubmission).toEqual({
      option: "recorded",
      capability: RECORDED_CAPABILITY,
    });
  });

  it("reads a --composition run's capability from the composition's bound profile", async () => {
    const runtime = await superCompositionRuntime();
    const compositionRuntime = {
      ...runtime,
      executionProfile: { ...runtime.executionProfile, answerSubmission: COMPOSITION_CAPABILITY },
    };
    await reviewRun(undefined, compositionRuntime);

    // No operator binding is resolved on a composition run, so the borrowed
    // capability cannot reach either side; both read the composition's.
    expect(seen.harnessProfiles).toHaveLength(1);
    expect(seen.harnessProfiles[0]).toBe(compositionRuntime.executionProfile);
    expect(seen.runnerOptions).toHaveLength(1);
    expect(seen.runnerOptions[0]!.answerSubmission).toEqual({
      option: "recorded",
      capability: COMPOSITION_CAPABILITY,
    });
  });

  it("passes the operator's text-final option with the capability", async () => {
    await reviewRun("text-final");

    expect(seen.runnerOptions[0]!.answerSubmission).toEqual({
      option: "text-final",
      capability: RECORDED_CAPABILITY,
    });
  });
});
