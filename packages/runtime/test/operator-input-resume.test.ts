// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleDoCommand, parseDoArguments, type DoRunArguments } from "../src/cli/commands/do.js";
import { doHelp, runHelp, usage } from "../src/cli/usage.js";
import {
  evaluateResumeSkip,
  OperatorInputFillError,
  planOperatorInputResume,
  textFillForbidsVerifiedNoChange,
} from "../src/inputs/operator-input-fill.js";
import {
  classifyRunResumability,
  isEditorialInputAskRecord,
} from "../src/operator/run-resumability.js";
import { buildRunHumanNextCommand } from "../src/operator/run-summary.js";
import type { RunRecord } from "../src/records/contracts.js";
import {
  createWorkflowOutcome,
  workflowOutcomeStepEvidence,
} from "../src/workflow-contracts/outcome.js";
import { temporaryRoots } from "./helpers/temp.js";

const SNAPSHOT = "c".repeat(64);
const PLAN_DIGEST = "d".repeat(64);
const RESPONSE_DIGEST = "e".repeat(64);
const REVISION = "b".repeat(40);
const INSTRUCTION = "Update docs/cli.md so it documents the current public option.";
const REPLY = "Admit the product requirements: the CLI prints --help on the public do surface.";
// An active composition in model-compositions/composition-registry.json.
const CONTINUATION_COMPOSITION = "nvidia-inference-gpt-6-sol-pi";

const roots = temporaryRoots();

afterEach(async () => {
  process.exitCode = undefined;
});

describe("editorial needs-input resume (#910)", () => {
  it("classifies InputAsk needs-input as resumable and NEXT is continue, not doctor", async () => {
    const record = editorialInputAskRecord("editorial-resume-001");
    expect(isEditorialInputAskRecord(record)).toBe(true);
    expect(await classifyRunResumability(record, "/tmp/unused-state")).toEqual({
      category: "resumable",
      reason: "needs-input",
    });
    const next = buildRunHumanNextCommand({
      record,
      recordPath: "/tmp/state/editorial-resume-001.json",
      repositoryPath: record.repository.sourcePath,
      exitCode: 2,
    });
    expect(next?.command).toBe("docsfab do --continue editorial-resume-001");
    expect(next?.command).not.toContain("docsfab doctor");
    expect(next?.reason).toContain("InputAsk");
    expect(next?.reason).not.toContain("docsfab doctor");
  });

  it("documents continue/attach/text fills on do --help and does not grow --reader-source", async () => {
    const help = doHelp();
    expect(help).toContain("Continue or start a documentation run from one quoted sentence");
    expect(help).toContain("Continue a stopped editorial needs-input run:");
    expect(help).not.toMatch(/\bjobs?\b/u);
    expect(help).toContain("--continue <run-id>");
    expect(help).toContain("--attach <path>");
    expect(help).toContain("reply sentence");
    expect(help).toContain("Text fills cannot");
    expect(help).toContain("certify verified no-change");
    expect(help).not.toMatch(/^\s*--reader-source /mu);
    expect(help).toContain("Do not pass --reader-source on do");
    const printed = await captureIo(() => handleDoCommand(["--help"]));
    expect(printed.stdout).toContain("--continue <run-id>");
    expect(printed.stdout).toContain("--attach <path>");
    expect(printed.stdout).not.toMatch(/docsfab do .*\s--reader-source /u);
    expect(() =>
      parseDoArguments(["Update the docs", "--repo", "/tmp/example-repo", "--reader-source", "x"]),
    ).toThrow(/Unknown do option "--reader-source"/u);
    expect(usage()).toContain(
      'docsfab do "<outcome request>" [--repo <path>] [--revision <ref>] [--instruction <text>] [--patch-only] [--dry-run] [--allow-write] [--draft-mr] [--remote <name>] [--comment-mr <iid-or-url>] [--route-only] [--quiet] [--json] [--study]',
    );
    expect(usage()).toContain("[--continue <run-id>] [--attach <path>]...");
    expect(usage()).toContain("a date-scoped instruction that names merge requests");
    expect(runHelp()).toContain("Review the MRs merged into main on September 14, 2026");
  });

  it("binds a reply and --attach to one open run and resumes the same run id and instruction digest", async () => {
    const fixture = await writeOpenEditorialRun({
      runId: "open-editorial-001",
      inputIds: ["current-documentation", "prd"],
      snapshot: SNAPSHOT,
      planDigest: PLAN_DIGEST,
    });
    const attachRelative = "docs/cli.md";
    await mkdir(join(fixture.repositoryPath, "docs"), { recursive: true });
    await writeFile(join(fixture.repositoryPath, attachRelative), "# CLI\n", { mode: 0o600 });
    const captured: DoRunArguments[] = [];
    const claimPath = join(
      fixture.stateDirectory,
      "input-ask-supersession",
      `${fixture.runId}.1.json`,
    );
    let claimDuringRun: unknown;
    await handleDoCommand(
      [
        REPLY,
        "--repo",
        fixture.repositoryPath,
        "--continue",
        fixture.runId,
        "--attach",
        attachRelative,
        "--patch-only",
      ],
      {
        stateDirectory: fixture.stateDirectory,
        currentWorkspaceSnapshotSha256: SNAPSHOT,
        now: () => new Date("2026-09-16T15:00:00.000Z"),
        runWorkflow: async (request) => {
          captured.push(request);
          claimDuringRun = JSON.parse(await readFile(claimPath, "utf8"));
          return undefined;
        },
      },
    );
    expect(captured).toHaveLength(1);
    const resume = captured[0]?.operatorInputResume;
    expect(resume).toBeDefined();
    expect(resume?.originalRunId).toBe(fixture.runId);
    expect(resume?.instruction).toBe(INSTRUCTION);
    expect(resume?.instructionSha256).toBe(digestInstruction(INSTRUCTION));
    expect(resume?.verifiedNoChange).toBe(false);
    expect(resume?.fills.map((fill) => fill.inputId).sort()).toEqual([
      "current-documentation",
      "prd",
    ]);
    const textFill = resume?.fills.find((fill) => fill.inputId === "prd");
    expect(textFill).toMatchObject({
      fillKind: "text",
      source: "reply-text",
      attribution: { who: "operator", what: "prd", when: "2026-09-16T15:00:00.000Z" },
    });
    expect(textFillForbidsVerifiedNoChange(resume?.fills ?? [])).toBe(true);
    const pathFill = resume?.fills.find((fill) => fill.inputId === "current-documentation");
    expect(pathFill).toMatchObject({
      fillKind: "path",
      source: "tracked-path",
      locator: attachRelative,
    });
    expect(captured[0]?.instruction).toBe(INSTRUCTION);
    // The continuation runs under the id the stopped run is superseded by.
    expect(captured[0]?.runId).toBe(resume?.continuationRunId);
    expect(claimDuringRun).toMatchObject({
      kind: "docsfab-input-ask-supersession",
      originalRunId: fixture.runId,
      supersededBy: resume?.continuationRunId,
    });
    // The stubbed run saved no record, so the host released its claim.
    await expect(readFile(claimPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a composition continuation local unless --draft-mr is passed", async () => {
    const continueWith = async (runId: string, extra: readonly string[]) => {
      const fixture = await writeOpenEditorialRun({ runId, inputIds: ["prd"] });
      const captured: DoRunArguments[] = [];
      await handleDoCommand(
        [REPLY, "--repo", fixture.repositoryPath, "--continue", fixture.runId, ...extra],
        {
          stateDirectory: fixture.stateDirectory,
          currentWorkspaceSnapshotSha256: SNAPSHOT,
          runWorkflow: async (request) => {
            captured.push(request);
            return undefined;
          },
        },
      );
      expect(captured).toHaveLength(1);
      expect(captured[0]?.operatorInputResume?.originalRunId).toBe(fixture.runId);
      return captured[0];
    };

    const local = await continueWith("open-editorial-composition-local", [
      "--composition",
      CONTINUATION_COMPOSITION,
    ]);
    expect(local).toMatchObject({
      workflow: "update-documentation",
      compositionId: CONTINUATION_COMPOSITION,
      allowWrite: true,
    });
    expect(local?.draftMr).toBeUndefined();
    expect(local?.remoteName).toBeUndefined();

    const published = await continueWith("open-editorial-composition-draft", [
      "--composition",
      CONTINUATION_COMPOSITION,
      "--draft-mr",
    ]);
    expect(published).toMatchObject({
      compositionId: CONTINUATION_COMPOSITION,
      allowWrite: true,
      draftMr: true,
      remoteName: "origin",
    });

    // Without --composition, a continuation keeps the first-use default and
    // opens a draft MR.
    const defaulted = await continueWith("open-editorial-default-draft", []);
    expect(defaulted).toMatchObject({ allowWrite: true, draftMr: true, remoteName: "origin" });
    expect(defaulted?.compositionId).toBeUndefined();
  });

  it("implicitly continues the only open run for the same repository", async () => {
    const fixture = await writeOpenEditorialRun({
      runId: "open-editorial-solo",
      inputIds: ["prd"],
    });
    const captured: DoRunArguments[] = [];
    await handleDoCommand([REPLY, "--repo", fixture.repositoryPath, "--patch-only"], {
      stateDirectory: fixture.stateDirectory,
      currentWorkspaceSnapshotSha256: SNAPSHOT,
      runWorkflow: async (request) => {
        captured.push(request);
        return undefined;
      },
    });
    expect(captured[0]?.operatorInputResume?.originalRunId).toBe("open-editorial-solo");
    expect(captured[0]?.operatorInputResume?.fills).toEqual([
      expect.objectContaining({ inputId: "prd", source: "reply-text" }),
    ]);
  });

  it("fails closed when two open editorial runs exist and --continue is omitted", async () => {
    const first = await writeOpenEditorialRun({
      runId: "open-editorial-a",
      inputIds: ["prd"],
    });
    await writeOpenEditorialRun({
      runId: "open-editorial-b",
      inputIds: ["accepted-decision"],
      repositoryPath: first.repositoryPath,
      stateDirectory: first.stateDirectory,
    });
    await expect(
      handleDoCommand([REPLY, "--repo", first.repositoryPath, "--patch-only"], {
        stateDirectory: first.stateDirectory,
        currentWorkspaceSnapshotSha256: SNAPSHOT,
        runWorkflow: async () => undefined,
      }),
    ).rejects.toThrow(OperatorInputFillError);
    await expect(
      planOperatorInputResume({
        stateDirectory: first.stateDirectory,
        repositoryPath: first.repositoryPath,
        revision: "HEAD",
        replyText: REPLY,
        currentWorkspaceSnapshotSha256: SNAPSHOT,
      }),
    ).rejects.toThrow(/open-editorial-a, open-editorial-b/u);
    await expect(
      planOperatorInputResume({
        stateDirectory: first.stateDirectory,
        repositoryPath: first.repositoryPath,
        revision: "HEAD",
        replyText: REPLY,
        currentWorkspaceSnapshotSha256: SNAPSHOT,
      }),
    ).rejects.toThrow(/Pass --continue <run-id>/u);
  });

  it("skips planner and search observe when snapshot and planBinding still match", async () => {
    const fixture = await writeOpenEditorialRun({
      runId: "open-editorial-skip",
      inputIds: ["prd"],
      snapshot: SNAPSHOT,
      planDigest: PLAN_DIGEST,
    });
    const skip = evaluateResumeSkip({
      record: fixture.record,
      currentWorkspaceSnapshotSha256: SNAPSHOT,
    });
    expect(skip).toEqual({ skipPlanner: true, skipSearchObserve: true, revalidate: false });
    const plan = await planOperatorInputResume({
      stateDirectory: fixture.stateDirectory,
      continueFrom: fixture.runId,
      repositoryPath: fixture.repositoryPath,
      revision: "HEAD",
      replyText: REPLY,
      currentWorkspaceSnapshotSha256: SNAPSHOT,
    });
    expect(plan.skipPlanner).toBe(true);
    expect(plan.skipSearchObserve).toBe(true);
    expect(plan.revalidate).toBe(false);
  });

  it("revalidates planner and search observe when the workspace snapshot changed", async () => {
    const fixture = await writeOpenEditorialRun({
      runId: "open-editorial-revalidate",
      inputIds: ["prd"],
      snapshot: SNAPSHOT,
      planDigest: PLAN_DIGEST,
    });
    const changed = "f".repeat(64);
    const skip = evaluateResumeSkip({
      record: fixture.record,
      currentWorkspaceSnapshotSha256: changed,
    });
    expect(skip).toEqual({ skipPlanner: false, skipSearchObserve: false, revalidate: true });
    const plan = await planOperatorInputResume({
      stateDirectory: fixture.stateDirectory,
      continueFrom: fixture.runId,
      repositoryPath: fixture.repositoryPath,
      revision: "HEAD",
      replyText: REPLY,
      currentWorkspaceSnapshotSha256: changed,
    });
    expect(plan.skipPlanner).toBe(false);
    expect(plan.skipSearchObserve).toBe(false);
    expect(plan.revalidate).toBe(true);
  });

  it("never lets a text fill certify verified no-change", async () => {
    const fixture = await writeOpenEditorialRun({
      runId: "open-editorial-text",
      inputIds: ["prd"],
    });
    const plan = await planOperatorInputResume({
      stateDirectory: fixture.stateDirectory,
      continueFrom: fixture.runId,
      repositoryPath: fixture.repositoryPath,
      revision: "HEAD",
      replyText: REPLY,
      currentWorkspaceSnapshotSha256: SNAPSHOT,
    });
    expect(plan.verifiedNoChange).toBe(false);
    expect(textFillForbidsVerifiedNoChange(plan.fills)).toBe(true);
    expect(plan.fills.some((fill) => fill.source === "reply-text")).toBe(true);
  });

  it("keeps failed inference and invalid-model-output on retry/new-run", async () => {
    const invalid = invalidModelOutputRecord("invalid-model-001");
    expect(isEditorialInputAskRecord(invalid)).toBe(false);
    expect(await classifyRunResumability(invalid, "/tmp/unused-state")).toEqual({
      category: "blocked",
      reason: "needs-input",
    });
    const invalidNext = buildRunHumanNextCommand({
      record: invalid,
      recordPath: "/tmp/state/invalid-model-001.json",
      repositoryPath: invalid.repository.sourcePath,
      exitCode: 2,
    });
    expect(invalidNext?.command).toContain("docsfab run update-documentation");
    expect(invalidNext?.command).not.toContain("docsfab do --continue");
    expect(invalidNext?.reason).toContain("invalid-json");
    expect(invalidNext?.reason).toContain("no missing user input was established");

    const failed = failedInferenceRecord("failed-inference-001");
    expect(isEditorialInputAskRecord(failed)).toBe(false);
    expect(await classifyRunResumability(failed, "/tmp/unused-state")).toEqual({
      category: "non-resumable",
      reason: "failed",
    });
    const failedNext = buildRunHumanNextCommand({
      record: failed,
      recordPath: "/tmp/state/failed-inference-001.json",
      repositoryPath: failed.repository.sourcePath,
      exitCode: 1,
    });
    expect(failedNext?.command).not.toContain("docsfab do --continue");
    expect(failedNext?.reason).toContain("wall: invalid-request");
    expect(failedNext?.reason).toContain("not missing input");
    expect(failedNext?.reason).toContain("Do not retry the unchanged request.");
  });
});

async function writeOpenEditorialRun(options: {
  readonly runId: string;
  readonly inputIds: readonly string[];
  readonly snapshot?: string;
  readonly planDigest?: string;
  readonly repositoryPath?: string;
  readonly stateDirectory?: string;
}): Promise<{
  readonly runId: string;
  readonly repositoryPath: string;
  readonly stateDirectory: string;
  readonly record: RunRecord;
}> {
  const root =
    options.repositoryPath && options.stateDirectory
      ? undefined
      : await mkdtemp(join(tmpdir(), "docsfab-operator-input-"));
  if (root) roots.track(root);
  const repositoryPath = options.repositoryPath ?? join(root!, "repo");
  const stateDirectory = options.stateDirectory ?? join(root!, "state");
  await mkdir(repositoryPath, { recursive: true, mode: 0o700 });
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const record = editorialInputAskRecord(options.runId, {
    repositoryPath,
    inputIds: options.inputIds,
    snapshot: options.snapshot,
    planDigest: options.planDigest,
  });
  await writeFile(
    join(stateDirectory, `${options.runId}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { runId: options.runId, repositoryPath, stateDirectory, record };
}

function editorialInputAskRecord(
  runId: string,
  options: {
    readonly repositoryPath?: string;
    readonly inputIds?: readonly string[];
    readonly snapshot?: string;
    readonly planDigest?: string;
  } = {},
): RunRecord {
  const inputIds = options.inputIds ?? ["prd"];
  const record: RunRecord = {
    schemaVersion: 2,
    id: runId,
    workflow: "update-documentation",
    repository: {
      sourcePath: options.repositoryPath ?? "/tmp/docsfab-editorial-resume",
      requestedRevision: "HEAD",
      revision: REVISION,
    },
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
        ...(options.snapshot
          ? {
              searchEvidence: {
                schemaVersion: 1 as const,
                kind: "docsfab-workflow-search-evidence" as const,
                planId: "plan-documentation",
                planVersion: "1",
                workspaceSnapshotSha256: options.snapshot,
                searches: [],
                evidenceSha256: options.snapshot,
              },
            }
          : {}),
        ...(options.planDigest
          ? {
              planBinding: {
                kind: "docsfab-documentation-plan" as const,
                schemaVersion: 1 as const,
                mode: "update" as const,
                pages: [{ path: "docs/cli.md", disposition: "update" as const }],
                sourceBindings: [{ pagePath: "docs/cli.md", sources: ["src/cli.ts@HEAD"] }],
                digest: options.planDigest,
              },
            }
          : {}),
      },
    ],
  };
  const evidence = workflowOutcomeStepEvidence(record, "plan-documentation");
  record.workflowOutcome = createWorkflowOutcome(
    {
      disposition: "needs-input",
      findings: inputIds.map((inputId) => ({
        id: `finding:editorial:${inputId}`,
        kind: "missing-governed-input" as const,
        severity: "warning" as const,
        code: "independent-rejection",
        inputId,
        evidenceIds: [evidence.id],
      })),
      evidence: [evidence],
      limitations: [],
      openDecisions: inputIds.map((inputId) => ({
        id: `decision:editorial:${inputId}`,
        kind: "governed-input" as const,
        inputId,
        evidenceIds: [evidence.id],
      })),
      producedArtifacts: [],
    },
    record,
  );
  return record;
}

function invalidModelOutputRecord(runId: string): RunRecord {
  return {
    schemaVersion: 2,
    id: runId,
    workflow: "update-documentation",
    repository: {
      sourcePath: "/tmp/docsfab-editorial-resume",
      requestedRevision: "HEAD",
      revision: REVISION,
    },
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
        kind: "evaluate",
        skill: "plan-documentation",
        mode: "read-only",
        status: "needs-input",
        inference: {
          attempts: [{ outcome: "succeeded", retryable: false, retryScheduled: false }] as never,
        } as never,
        planDiagnostic: {
          schemaVersion: 1,
          kind: "docsfab-documentation-plan-diagnostic",
          code: "invalid-json",
          responseSha256: RESPONSE_DIGEST,
          responseShape: "invalid-json",
        },
      },
    ],
  };
}

function failedInferenceRecord(runId: string): RunRecord {
  return {
    schemaVersion: 2,
    id: runId,
    workflow: "create-documentation",
    repository: {
      sourcePath: "/tmp/docsfab-editorial-resume",
      requestedRevision: "HEAD",
      revision: REVISION,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    instruction: INSTRUCTION,
    status: "failed",
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
        status: "failed",
        inference: {
          attempts: [
            { outcome: "invalid-request", retryable: false, retryScheduled: false },
          ] as never,
        } as never,
      },
    ],
  };
}

function digestInstruction(instruction: string): string {
  return createHash("sha256").update(instruction.normalize("NFC"), "utf8").digest("hex");
}

async function captureIo(fn: () => Promise<unknown>): Promise<{ stdout: string; stderr: string }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message?: unknown) => logs.push(String(message ?? ""));
  console.error = (message?: unknown) => errors.push(String(message ?? ""));
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { stdout: logs.join("\n"), stderr: errors.join("\n") };
}
