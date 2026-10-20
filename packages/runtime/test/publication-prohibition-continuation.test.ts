// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `do` continuing an open editorial needs-input run: the reply joins the
 * original instruction, so a reply that forbids publication refuses a
 * delivery that publishes, as a fresh request would, before the claim, the
 * workflow, or any model call. The continuation skips the interpretation, so
 * the reply text is the only signal.
 */
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleDoCommand, type DoRunArguments } from "../src/cli/commands/do.js";
import { DeliveryFlagOperatorError } from "../src/cli/delivery-grants.js";
import type { RunRecord } from "../src/records/contracts.js";
import {
  createWorkflowOutcome,
  workflowOutcomeStepEvidence,
} from "../src/workflow-contracts/outcome.js";
import { temporaryRoots } from "./helpers/temp.js";

const SNAPSHOT = "c".repeat(64);
const REVISION = "b".repeat(40);
const INSTRUCTION = "Update docs/cli.md so it documents the current public option.";
const REPLY = "Admit the product requirements: the CLI prints --help on the public do surface.";
const BASE = "Create docs/cli-reference.md for developers using Sprout from src/sprout.mjs.";

const roots = temporaryRoots();

afterEach(() => {
  process.exitCode = undefined;
});

/** One open editorial needs-input run that asks for a `prd` text fill. */
async function openEditorialRun(runId: string): Promise<{
  readonly repositoryPath: string;
  readonly stateDirectory: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-prohibition-continuation-"));
  roots.track(root);
  const repositoryPath = join(root, "repo");
  const stateDirectory = join(root, "state");
  await mkdir(repositoryPath, { recursive: true, mode: 0o700 });
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const record: RunRecord = {
    schemaVersion: 2,
    id: runId,
    workflow: "update-documentation",
    repository: { sourcePath: repositoryPath, requestedRevision: "HEAD", revision: REVISION },
    workspace: { strategy: "tracked-export", disposable: true },
    instruction: INSTRUCTION,
    status: "needs-input",
    createdAt: "2026-09-16T12:00:00.000Z",
    completedAt: "2026-09-16T12:00:01.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "plan-documentation",
        title: "Plan documentation",
        skill: "plan-documentation",
        mode: "read-only",
        status: "needs-input",
        summary: "The planner asked for named InputAsk fills.",
      },
    ],
  };
  const evidence = workflowOutcomeStepEvidence(record, "plan-documentation");
  record.workflowOutcome = createWorkflowOutcome(
    {
      disposition: "needs-input",
      findings: [
        {
          id: "finding:editorial:prd",
          kind: "missing-governed-input",
          severity: "warning",
          code: "independent-rejection",
          inputId: "prd",
          evidenceIds: [evidence.id],
        },
      ],
      evidence: [evidence],
      limitations: [],
      openDecisions: [
        {
          id: "decision:editorial:prd",
          kind: "governed-input",
          inputId: "prd",
          evidenceIds: [evidence.id],
        },
      ],
      producedArtifacts: [],
    },
    record,
  );
  await writeFile(join(stateDirectory, `${runId}.json`), `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
  });
  return { repositoryPath, stateDirectory };
}

/** Continue with `args`: the refusal code, or the request the workflow received. */
async function continueWith(
  runId: string,
  args: (repositoryPath: string) => readonly string[],
): Promise<{ readonly code?: string; readonly run?: DoRunArguments; readonly state: string[] }> {
  const fixture = await openEditorialRun(runId);
  const runs: DoRunArguments[] = [];
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    await handleDoCommand([...args(fixture.repositoryPath), "--repo", fixture.repositoryPath], {
      stateDirectory: fixture.stateDirectory,
      currentWorkspaceSnapshotSha256: SNAPSHOT,
      admitCatalogWorkflow: async () => {
        throw new Error("a continuation must not ask the admission model");
      },
      runWorkflow: async (request) => {
        runs.push(request);
        return undefined;
      },
    });
    expect(runs).toHaveLength(1);
    return { run: runs[0], state: await readdir(fixture.stateDirectory) };
  } catch (error) {
    expect(error).toBeInstanceOf(DeliveryFlagOperatorError);
    expect(runs).toEqual([]);
    return {
      code: (error as DeliveryFlagOperatorError).code,
      state: await readdir(fixture.stateDirectory),
    };
  } finally {
    console.log = originalLog;
  }
}

describe("a continuation reply that forbids publication", () => {
  it.each([
    ["a reply to the only open run", () => [`${REPLY} Do not publish.`]],
    ["a reply naming the run", () => [`${REPLY} Do not push anything.`, "--continue", "open-run"]],
    ["a fresh request taken as a reply", () => [`${BASE} Keep the result local.`]],
  ])("refuses the default draft MR before the claim or the workflow: %s", async (_label, args) => {
    const result = await continueWith("open-run", args);
    expect(result.code).toBe("publication-prohibition-conflict");
    // Only the stopped run's own record: no supersession claim was written.
    expect(result.state).toEqual(["open-run.json"]);
  });

  it("refuses --draft-mr on a continuation whose reply forbids publication", async () => {
    const result = await continueWith("open-run", () => [
      `${REPLY} Do not open a merge request.`,
      "--draft-mr",
    ]);
    expect(result.code).toBe("publication-prohibition-conflict");
  });

  it("continues under --patch-only with no draft merge request", async () => {
    const result = await continueWith("open-run", () => [
      `${REPLY} Do not publish.`,
      "--patch-only",
    ]);
    expect(result.run?.operatorInputResume?.originalRunId).toBe("open-run");
    expect(result.run?.allowWrite).toBe(true);
    expect(result.run?.draftMr).toBeUndefined();
    expect(result.run?.remoteName).toBeUndefined();
  });

  it("keeps the default draft MR for a reply without a prohibition", async () => {
    const result = await continueWith("open-run", () => [REPLY]);
    expect(result.run).toMatchObject({ draftMr: true, remoteName: "origin" });
  });
});
