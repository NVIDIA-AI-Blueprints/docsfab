// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The run entry hands a continuing first pass's evidence-gap lines (#2113),
 * with first pass's other notices, to the runner, whose queued record keeps
 * them. The harness and the runner are replaced so the test reads the options
 * `executeWorkflowRun` built.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { executeWorkflowRun } from "../src/cli/run/execution.js";
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
vi.mock("../src/records/composition-execution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/records/composition-execution.js")>()),
  createCompositionExecutionEvidence: () => undefined,
}));

afterEach(async () => {
  seen.runnerOptions.length = 0;
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.dispose()));
  await roots.cleanup();
});

const LINES = [
  "first-pass-evidence-gaps: first pass continued after 2 assessment rounds with 1 mandatory obligation its repository evidence did not support. It ended no-progress: its last round either did not reduce the number of open obligations or found no new evidence, so reading further was not expected to close one. The run used the evidence first pass gathered; to give an obligation its evidence, name its source by path in the request or with --source <path>.",
  "first-pass-evidence-gaps: obligation decomposed-new-key-rule is missing.",
];

/** The runner options `executeWorkflowRun` built for one invocation. */
async function runnerOptions(firstPassNotices?: readonly string[]) {
  const repository = await roots.create("docsfab-first-pass-gaps-runner-");
  await initFixtureRepo(repository, { "README.md": "# Guide\n" });
  const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
  workspaces.push(workspace);
  const stateDirectory = join(repository, "runs");
  await mkdir(stateDirectory, { recursive: true });
  const workflow = getWorkflow("readiness");
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
          model: validModelConfig,
        } as never,
        options: { silent: true },
        output: { log: vi.fn(), error: vi.fn() },
        ...(firstPassNotices ? { firstPassNotices } : {}),
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
  return seen.runnerOptions[0]!;
}

describe("the run entry hands first-pass evidence gaps to the runner", () => {
  it("passes the lines into the runner options the queued record reads", async () => {
    expect((await runnerOptions(LINES)).firstPassNotices).toEqual(LINES);
  });

  it("passes none for a first pass without gaps (control)", async () => {
    expect(await runnerOptions()).not.toHaveProperty("firstPassNotices");
  });
});
