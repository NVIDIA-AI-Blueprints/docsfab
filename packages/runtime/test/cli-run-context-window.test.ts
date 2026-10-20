// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The context packet window's run-entry thread (#1932): `executeWorkflowRun`
 * projects the input window of the profile the harness runs with, and the
 * local preflight sizes each packet from it. The harness and the runner are
 * replaced so the test reads the preflight service the runner received; the
 * preflight then compiles a real packet whose recorded budget shows the
 * window it was given.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { executeWorkflowRun } from "../src/cli/run/execution.js";
import { contextPacketBudget } from "../src/context/budget.js";
import type { ContextPacketV1, ContextPreflightService } from "../src/context/contracts.js";
import {
  bindModelExecutionProfile,
  CONSERVATIVE_MODEL_FALLBACK,
  type ModelEndpointConfig,
} from "../src/model/configuration.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { validModelConfig } from "./helpers.js";
import { initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const roots = temporaryRoots();
const workspaces: RepositoryWorkspace[] = [];

const { seen } = vi.hoisted(() => ({
  seen: { runnerOptions: [] as Array<Record<string, unknown>> },
}));

vi.mock("../src/harness/pi.js", () => ({
  PiHarness: class {},
}));
vi.mock("../src/workflow-execution/runner.js", () => ({
  WorkflowRunner: class {
    constructor(options: Record<string, unknown>) {
      seen.runnerOptions.push(options);
    }
    async run() {
      return { workflow: "readiness", status: "failed", steps: [] };
    }
  },
}));
// A composition run's evidence needs a sealed composition; the window needs
// only the execution profile, which reaches the harness and the preflight.
vi.mock("../src/records/composition-execution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/records/composition-execution.js")>()),
  createCompositionExecutionEvidence: () => undefined,
}));

afterEach(async () => {
  seen.runnerOptions.length = 0;
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.dispose()));
  await roots.cleanup();
});

/** The setup shape for an endpoint no installed composition matches. */
function unmatchedEndpoint(maxInputTokens: number): ModelEndpointConfig {
  const window = { contextWindow: maxInputTokens, maxInputTokens, maxOutputTokens: 4_096 };
  return {
    ...validModelConfig,
    providerId: "operator-configured-openai-compatible",
    baseUrl: "https://unmatched.example.test/v1",
    modelId: "operator/unmatched-model",
    profile: {
      ...validModelConfig.profile!,
      configuredLimits: window,
      ...window,
      effectiveLimitReason: "metadata-unknown",
      metadata: { approvedSource: null, effectiveDate: null, reviewAfter: null, status: "unknown" },
    },
  };
}

/**
 * Runs `readiness` through the CLI entry point, then compiles the corpus
 * packet with the preflight service the runner received and returns the
 * token budget the packet records.
 */
async function corpusPacketBudget(
  setup: { model: ModelEndpointConfig } | { compositionWindow: number },
): Promise<number> {
  seen.runnerOptions.length = 0;
  const repository = await roots.create("docsfab-cli-context-window-");
  await initFixtureRepo(repository, {
    "README.md": "# Guide\n\n- [Setup](docs/setup.md)\n",
    "docs/setup.md": "# Setup\n\n## Install\n\nRun the installer.\n",
  });
  const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
  workspaces.push(workspace);
  const stateDirectory = join(repository, "runs");
  await mkdir(stateDirectory, { recursive: true });
  const workflow = getWorkflow("readiness");
  const compositionRuntime =
    "compositionWindow" in setup
      ? (() => {
          const bound = bindModelExecutionProfile(validModelConfig);
          const profile = bound.profile.profile!;
          const { contextAdmission: _admission, ...executionProfile } = bound.profile;
          return {
            executionProfile: {
              ...executionProfile,
              profile: { ...profile, maxInputTokens: setup.compositionWindow },
            },
            credential: bound.credential,
            providerConnectionFactory: {},
            bound: {
              workflow: { workflowId: "readiness", sourceSha256: "a".repeat(64) },
              composition: {},
            },
            configuredLimits: {},
          };
        })()
      : undefined;
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    await executeWorkflowRun(
      {
        request: { workflow: workflow.name, verbose: false, allowWrite: false } as never,
        config: {
          skillCrateDirectory: join(runtimeRoot, "skill-crate"),
          qualityDirectory: join(runtimeRoot, "quality"),
          qualityPackDirectory: join(runtimeRoot, "quality-pack"),
          stateDirectory,
          model: "model" in setup ? setup.model : validModelConfig,
        } as never,
        options: { silent: true },
        output: { log: vi.fn(), error: vi.fn() },
        ...(compositionRuntime ? { compositionRuntime: compositionRuntime as never } : {}),
      },
      workspace,
      {} as never,
      { workflow } as never,
      {} as never,
    );
  } catch {
    // The stub runner's empty record may not settle as a run; the runner
    // options were captured before it ran.
  } finally {
    stderr.mockRestore();
  }
  expect(seen.runnerOptions).toHaveLength(1);
  const preflight = seen.runnerOptions[0]!.contextPreflight as ContextPreflightService;
  const result = await preflight.preflight({
    runId: "cli-context-window",
    repository: {
      sourcePath: workspace.sourcePath,
      requestedRevision: workspace.requestedRevision,
      revision: workspace.revision,
    },
    workspacePath: workspace.path,
    workflow,
    step: workflow.steps[0]!,
    policy: workflow.contextPolicy.steps[0]!,
  });
  expect(result.status).toBe("ready");
  return (result.packet as ContextPacketV1).provenance.budget.maxEstimatedTokens;
}

describe("the context packet window from the run entry point to the preflight", () => {
  it("sizes packets from an attested profile's window", async () => {
    expect(validModelConfig.profile!.metadata.status).toBe("current");
    expect(await corpusPacketBudget({ model: validModelConfig })).toBe(
      contextPacketBudget("corpus", validModelConfig.profile!.maxInputTokens).maxEstimatedTokens,
    );
    expect(contextPacketBudget("corpus", 128_000).maxEstimatedTokens).toBe(16_000);
  });

  it("sizes packets from a composition runtime's window", async () => {
    expect(await corpusPacketBudget({ compositionWindow: 1_050_000 })).toBe(131_250);
  });

  it("uses the fallback window, never the setup placeholder, for an endpoint that matches no composition", async () => {
    const fallback = contextPacketBudget("corpus").maxEstimatedTokens;
    expect(fallback).toBe(8_192);
    // The window setup writes for such an endpoint, half the fallback window.
    expect(CONSERVATIVE_MODEL_FALLBACK.contextWindow).toBe(32_768);
    expect(
      await corpusPacketBudget({
        model: unmatchedEndpoint(CONSERVATIVE_MODEL_FALLBACK.contextWindow),
      }),
    ).toBe(fallback);
    // An unattested window is not admitted against, however large it claims to be.
    expect(await corpusPacketBudget({ model: unmatchedEndpoint(200_000) })).toBe(fallback);
  });
});
