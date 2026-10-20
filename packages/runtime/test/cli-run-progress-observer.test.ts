// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { executeWorkflowRun } from "../src/cli/run/execution.js";
import { verifyQualityPackContext } from "../src/quality-pack/manifest.js";
import type { ProgressEvent } from "../src/records/contracts.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { validModelConfig } from "./helpers.js";
import { initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const roots = temporaryRoots();
const workspaces: RepositoryWorkspace[] = [];

vi.mock("../src/quality-pack/manifest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/quality-pack/manifest.js")>();
  return {
    ...actual,
    verifyQualityPackContext: vi.fn(
      (options: Parameters<typeof actual.verifyQualityPackContext>[0]) =>
        actual.verifyQualityPackContext(options),
    ),
  };
});
vi.mock("../src/harness/pi.js", () => ({ PiHarness: class {} }));
vi.mock("../src/workflow-execution/runner.js", () => ({
  WorkflowRunner: class {
    constructor(private readonly options: { onProgress?: (event: ProgressEvent) => void }) {}
    async run() {
      for (const [index, status] of ["running", "failed"].entries()) {
        this.options.onProgress?.({
          type: "step-status",
          runId: "run-observer",
          stepId: "audit-docs",
          status: status as "running" | "failed",
          sequence: index + 1,
        });
      }
      return { workflow: "review-documentation", status: "failed", steps: [] };
    }
  },
}));

afterEach(async () => {
  vi.mocked(verifyQualityPackContext).mockClear();
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.dispose()));
  await roots.cleanup();
});

async function reviewWorkspace(): Promise<{
  workspace: RepositoryWorkspace;
  stateDirectory: string;
}> {
  const repository = await roots.create("docsfab-progress-observer-");
  await initFixtureRepo(repository, {
    "docs/guide.md": "# Guide\n\nDeterministic documentation.\n",
  });
  const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
  workspaces.push(workspace);
  const stateDirectory = join(repository, "runs");
  await mkdir(stateDirectory, { recursive: true });
  return { workspace, stateDirectory };
}

describe("CLI workflow progress observer", () => {
  it.each([true, false])(
    "forwards runner events and the resolved definition while silent=%s",
    async (silent) => {
      const observer = vi.fn();
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const workflow = getWorkflow("review-documentation");
      const fixture = await reviewWorkspace();
      try {
        const result = await executeWorkflowRun(
          {
            request: { workflow: workflow.name, verbose: false, allowWrite: false } as never,
            config: {
              skillCrateDirectory: join(runtimeRoot, "skill-crate"),
              qualityDirectory: join(runtimeRoot, "quality"),
              qualityPackDirectory: join(runtimeRoot, "quality-pack"),
              stateDirectory: fixture.stateDirectory,
              model: validModelConfig,
            } as never,
            options: { silent, onProgress: observer },
            output: { log: vi.fn(), error: vi.fn() },
          },
          fixture.workspace,
          {} as never,
          { workflow } as never,
          {} as never,
        );
        expect(result.exitCode).toBe(1);
        expect(vi.mocked(verifyQualityPackContext)).toHaveBeenCalled();
        const sealed = await vi.mocked(verifyQualityPackContext).mock.results[0]?.value;
        expect(sealed).toMatchObject({
          evidence: expect.objectContaining({
            id: "docsfab-default",
            version: "1.0.0",
            bindingSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          }),
        });
        expect(observer).toHaveBeenCalledTimes(2);
        expect(observer).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({ type: "step-status", status: "running" }),
          workflow,
        );
        expect(observer).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ type: "step-status", status: "failed" }),
          workflow,
        );
        expect(stderr).not.toHaveBeenCalled();
      } finally {
        stderr.mockRestore();
      }
    },
  );
});
