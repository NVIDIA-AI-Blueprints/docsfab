// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { editorialInputAskPresentationV1 } from "../src/artifacts/editorial-input-ask.js";
import {
  LiveAgentActivityRenderer,
  liveAgentInputAskSlotsFromRecord,
  renderLiveAgentInputAskResume,
} from "../src/live-agent/activity-renderer.js";
import {
  assembleLiveAgentHost,
  continueLiveAgentEditorialInputAsk,
  liveAgentContinueRunRequest,
  liveAgentWorkflowRunRequest,
  liveWorkflowFailureTerminalOptions,
  runTerminalConversation,
} from "../src/live-agent/host.js";
import {
  createLiveWorkflowFailureGate,
  LIVE_WORKFLOW_FAILURE_GATE_MESSAGES,
} from "../src/live-agent/workflow-failure-gate.js";
import { createSavedRunReadTool } from "../src/live-agent/saved-run-tool.js";
import {
  LiveWorkflowDelivery,
  planLiveAgentEditorialInputAskTurn,
} from "../src/live-agent/workflow-delivery.js";
import {
  listOpenEditorialRuns,
  recordOperatorInputSupersession,
  selectOpenEditorialRun,
  type OperatorInputResumePlanV1,
} from "../src/inputs/operator-input-fill.js";
import type { RunRecord } from "../src/records/contracts.js";
import { retainedReaderEvidenceRequest } from "../src/records/reader-evidence-request.js";
import { validModelConfig } from "./helpers.js";
import { git as fixtureGit } from "./helpers/orbit-option-change-fixture.js";
import { advisoryIntent, recordedIntent } from "./helpers/first-pass-intent.js";
import { installedLiveAgentCapabilities } from "./support/live-agent-installed-capabilities.js";
import {
  createWorkflowOutcome,
  workflowOutcomeStepEvidence,
} from "../src/workflow-contracts/outcome.js";

const SNAPSHOT = "c".repeat(64);
const PLAN_DIGEST = "d".repeat(64);
const REVISION = "b".repeat(40);
const INSTRUCTION = "Update docs/cli.md so it documents the current public option.";
const REPLY = "Admit the product requirements: the CLI prints --help on the public do surface.";
const ROUTING_CLARIFICATION = "Which documentation job should I run?";

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const activityOptions = {
  environment: { NO_COLOR: "1" },
  skillIds: ["review-documentation"],
  workflowIds: ["review-documentation", "update-documentation"],
};

function renderer(
  extra: { inputAskInputIdsForRun?: (runId: string) => readonly string[] | undefined } = {},
) {
  const chunks: string[] = [];
  const activity = new LiveAgentActivityRenderer({
    ...activityOptions,
    ...extra,
    tty: true,
    columns: () => 120,
    write: (text) => chunks.push(text),
  });
  return { activity, output: () => chunks.join("") };
}

function start(toolName: string, args: unknown = {}, toolCallId = "tool-1"): AgentSessionEvent {
  return { type: "tool_execution_start", toolName, args, toolCallId };
}

function end(
  toolName: string,
  result: unknown = {},
  isError = false,
  toolCallId = "tool-1",
): AgentSessionEvent {
  return { type: "tool_execution_end", toolName, result, isError, toolCallId };
}

describe("assembled live-agent named InputAsk answer binding (#2342)", () => {
  async function hostFor(inputIds: readonly string[]) {
    const fixture = await writeOpenEditorialRun({ runId: "explicit-live-fill", inputIds });
    const host = await assembleLiveAgentHost({
      repositoryPath: fixture.repositoryPath,
      allowWrite: false,
      environment: { PATH: process.env.PATH },
      config: {
        model: validModelConfig,
        stateDirectory: fixture.stateDirectory,
        qualityDirectory: join(import.meta.dirname, "../quality"),
      } as never,
      capabilities: await installedLiveAgentCapabilities([fixture.record.workflow]),
      onNotice: () => undefined,
      writeError: () => undefined,
    });
    return { fixture, host, plan: host.terminalOptions.planEditorialInputAskTurn! };
  }

  it("keeps a question and an ordinary paragraph out of open text slots", async () => {
    const { fixture, plan } = await hostFor(["prd", "accepted-decision"]);
    const before = await readFile(join(fixture.stateDirectory, `${fixture.runId}.json`), "utf8");
    for (const reply of [
      "Explain the supported recovery without editing files or starting another workflow.",
      "Do not continue yet.",
      "retry",
      "https://example.test/evidence",
    ]) {
      expect(await plan(reply)).toEqual({ kind: "routing-turn", openInputAsk: true });
    }
    expect(await readFile(join(fixture.stateDirectory, `${fixture.runId}.json`), "utf8")).toBe(
      before,
    );
  });

  it("holds direct changes after an invalid named fill and keeps conversation separate", async () => {
    const { fixture, host } = await hostFor(["prd"]);
    const gate = createLiveWorkflowFailureGate({ allowDirectEdits: true });
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk) => {
      transcript += chunk.toString();
    });
    const prompted: string[] = [];
    const continued: OperatorInputResumePlanV1[] = [];
    const gateOptions = liveWorkflowFailureTerminalOptions(gate);
    const conversation = runTerminalConversation(
      {
        sessionFile: undefined,
        subscribe: () => () => {},
        abort: async () => {},
        prompt: async (message) => {
          prompted.push(String(message));
        },
      },
      input,
      output,
      {
        ...host.terminalOptions,
        ...gateOptions,
        onUserTurn: (message) => {
          host.terminalOptions.onUserTurn?.(message);
          gateOptions.onUserTurn(message);
        },
        onOpenInputAskTurn: () => {
          host.terminalOptions.onOpenInputAskTurn?.();
          gateOptions.onOpenInputAskTurn();
        },
        turnNotices: () => [
          ...(host.terminalOptions.turnNotices?.() ?? []),
          ...gateOptions.turnNotices(),
        ],
        continueEditorialInputAsk: async (plan) => {
          continued.push(plan);
          return undefined;
        },
      },
    );
    input.write("not-open: answer\n");
    await vi.waitFor(() => expect(transcript).toContain("Next:"));
    expect(continued).toHaveLength(0);
    expect(() => gate.admitDirectChange()).toThrow(
      LIVE_WORKFLOW_FAILURE_GATE_MESSAGES.openInputAsk,
    );
    input.write("Explain the recovery without starting another workflow.\n");
    await vi.waitFor(() => expect(prompted).toHaveLength(1));
    expect(continued).toHaveLength(0);
    expect(() => gate.admitDirectChange()).toThrow(
      LIVE_WORKFLOW_FAILURE_GATE_MESSAGES.openInputAsk,
    );
    input.write("prd: The public option is --new.\n");
    await vi.waitFor(() => expect(continued).toHaveLength(1));
    expect(continued[0]).toMatchObject({ originalRunId: fixture.runId, instruction: INSTRUCTION });
    input.write("/exit\n");
    await conversation;
  });

  it("binds the explicitly named slot and preserves its literal retry answer", async () => {
    const { fixture, plan } = await hostFor(["accepted-decision", "prd"]);
    const result = await plan("prd: retry");
    expect(result.kind).toBe("input-ask-resume");
    if (result.kind !== "input-ask-resume") return;
    expect(result.plan.originalRunId).toBe(fixture.runId);
    expect(result.plan.instruction).toBe(INSTRUCTION);
    expect(result.plan.fills).toHaveLength(1);
    expect(result.plan.fills[0]).toMatchObject({
      inputId: "prd",
      byteLength: Buffer.byteLength("retry"),
      sha256: createHash("sha256").update("retry").digest("hex"),
    });
  });

  it("keeps exact tracked path fills separate from text-only slots", async () => {
    for (const inputIds of [["current-documentation", "prd"], ["prd"]]) {
      const { fixture, plan } = await hostFor(inputIds);
      await mkdir(join(fixture.repositoryPath, "docs"));
      await writeFile(join(fixture.repositoryPath, "docs/cli.md"), "# CLI\n");
      await fixtureGit(fixture.repositoryPath, "init", "--quiet", "--initial-branch=main");
      await fixtureGit(fixture.repositoryPath, "add", "--all");
      await fixtureGit(
        fixture.repositoryPath,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "input fixture",
      );
      const result = await plan("docs/cli.md");
      if (inputIds.includes("current-documentation")) {
        expect(result.kind).toBe("input-ask-resume");
        if (result.kind !== "input-ask-resume") continue;
        expect(result.plan.fills[0]).toMatchObject({
          inputId: "current-documentation",
          source: "tracked-path",
        });
      } else {
        expect(result).toEqual({ kind: "routing-turn", openInputAsk: true });
      }
    }
  });

  it("does not turn missing, untracked, directory or symlink path answers into text fills", async () => {
    const { fixture, plan } = await hostFor(["current-documentation", "prd"]);
    const path = join(fixture.repositoryPath, "docs/cli.md");
    await mkdir(join(fixture.repositoryPath, "docs"));
    await writeFile(path, "# CLI\n");
    await fixtureGit(fixture.repositoryPath, "init", "--quiet", "--initial-branch=main");
    await fixtureGit(fixture.repositoryPath, "add", "--all");
    await fixtureGit(
      fixture.repositoryPath,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "input fixture",
    );
    await writeFile(join(fixture.repositoryPath, "docs/untracked.md"), "# Untracked\n");
    expect(await plan("docs/untracked.md")).toEqual({ kind: "routing-turn", openInputAsk: true });
    await rm(path);
    expect(await plan("docs/cli.md")).toEqual({ kind: "routing-turn", openInputAsk: true });
    await mkdir(path);
    expect(await plan("docs/cli.md")).toEqual({ kind: "routing-turn", openInputAsk: true });
    await rm(path, { recursive: true });
    await symlink(join(fixture.repositoryPath, "docs/untracked.md"), path);
    expect(await plan("docs/cli.md")).toEqual({ kind: "routing-turn", openInputAsk: true });
  });

  it("refuses an unknown named slot and text addressed to a file slot", async () => {
    const { plan } = await hostFor(["prd", "public-contract"]);
    await expect(plan("prd:")).rejects.toThrow("Next:");
    await expect(plan("not-open: arbitrary answer")).rejects.toThrow("Next:");
    await expect(plan("public-contract: arbitrary answer")).rejects.toThrow("Next:");
  });
});

describe("live-agent InputAsk projection (#912)", () => {
  it("shows named InputAsk slots for workflow needs-input without doctor as the continuation", () => {
    const record = editorialInputAskRecord("live-inputask-001", {
      inputIds: ["prd", "current-documentation"],
    });
    const remembered = new Map<string, readonly string[]>([
      ["live-inputask-001", ["prd", "current-documentation"]],
    ]);
    const { activity, output } = renderer({
      inputAskInputIdsForRun: (runId) => remembered.get(runId),
    });
    activity.begin();
    activity.handle(start("docsfab_run_workflow", { workflow: "update-documentation" }));
    activity.handle(
      end("docsfab_run_workflow", {
        details: {
          kind: "docsfab-live-workflow-result",
          runId: "live-inputask-001",
          workflow: "update-documentation",
          status: "needs-input",
          workflowStatus: "needs-input",
          steps: [
            {
              id: "plan-documentation",
              status: "needs-input",
              summary: "The planner asked for named InputAsk fills.",
            },
          ],
        },
      }),
    );
    activity.interrupt();
    const text = output();
    const prd = editorialInputAskPresentationV1("prd")!;
    const docs = editorialInputAskPresentationV1("current-documentation")!;
    expect(text).toContain("[Needs input] Running workflow: update-documentation");
    expect(text).toContain("Named InputAsk slots are open");
    expect(text).toContain(`- ${prd.label} (prd; ${prd.fillKind}): ${prd.why}`);
    expect(text).toContain(
      `- ${docs.label} (current-documentation; ${docs.fillKind}): ${docs.why}`,
    );
    expect(text).not.toContain("docsfab doctor");
    expect(text).not.toMatch(/\bdoctor\b/iu);
    expect(text).not.toContain("Provide the missing task details before retrying the workflow.");
    expect(
      liveAgentInputAskSlotsFromRecord(record)
        .map((slot) => slot.inputId)
        .sort(),
    ).toEqual(["current-documentation", "prd"]);
  });

  it("projects catalog slots from workflowOutcome details without using doctor", () => {
    const record = editorialInputAskRecord("live-inputask-outcome", {
      inputIds: ["accepted-decision"],
    });
    const { activity, output } = renderer();
    activity.begin();
    activity.handle(start("docsfab_run_workflow", { workflow: "update-documentation" }));
    activity.handle(
      end("docsfab_run_workflow", {
        details: {
          runId: "live-inputask-outcome",
          workflow: record.workflow,
          status: "needs-input",
          workflowStatus: "needs-input",
          workflowOutcome: record.workflowOutcome,
        },
      }),
    );
    activity.interrupt();
    const decision = editorialInputAskPresentationV1("accepted-decision")!;
    expect(output()).toContain(
      `- ${decision.label} (accepted-decision; ${decision.fillKind}): ${decision.why}`,
    );
    expect(output()).not.toMatch(/\bdoctor\b/iu);
  });

  it("keeps saved-run reads projecting the same InputAsk slots", async () => {
    const fixture = await writeOpenEditorialRun({
      runId: "saved-inputask-001",
      inputIds: ["prd"],
    });
    const tool = createSavedRunReadTool({
      repositoryPath: fixture.repositoryPath,
      stateDirectory: fixture.stateDirectory,
    });
    const result = await tool.execute(
      "read-1",
      { runId: fixture.runId },
      undefined,
      undefined,
      {} as never,
    );
    const prd = editorialInputAskPresentationV1("prd")!;
    expect(result.details).toMatchObject({
      runId: fixture.runId,
      executionStatus: "needs-input",
      inputAsk: {
        slots: [
          {
            inputId: "prd",
            label: prd.label,
            why: prd.why,
            fillKind: prd.fillKind,
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/\bdoctor\b/iu);
  });
});

describe("live-agent InputAsk fill and same-run resume (#912)", () => {
  it("reports unavailable quality after an InputAsk continuation instead of silently omitting it", async () => {
    const fixture = await writeOpenEditorialRun({ runId: "continued-quality", inputIds: ["prd"] });
    const handled = vi.spyOn(LiveAgentActivityRenderer.prototype, "handle");
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk) => {
      transcript += chunk.toString();
    });
    const conversation = runTerminalConversation(
      {
        sessionFile: undefined,
        subscribe: () => () => {},
        abort: async () => {},
        prompt: async () => {},
      },
      input,
      output,
      {
        ...activityOptions,
        planEditorialInputAskTurn: (replyText) =>
          planLiveAgentEditorialInputAskTurn({
            stateDirectory: fixture.stateDirectory,
            repositoryPath: fixture.repositoryPath,
            revision: "HEAD",
            replyText,
          }),
        continueEditorialInputAsk: async () => ({
          ...fixture.record,
          status: "succeeded",
          workflowOutcome: undefined,
          workflowBranchCoverage: undefined,
          artifacts: [],
          steps: [
            {
              id: "evaluate-document-quality",
              title: "Evaluate",
              skill: "evaluate-document-quality",
              kind: "evaluate",
              mode: "read-only",
              status: "succeeded",
              summary: "Advisory quality assessment.",
            },
          ],
        }),
      },
    );
    input.write(`${REPLY}\n`);
    await vi.waitFor(() =>
      expect(transcript).toContain("Quality unavailable: quality-validation-unavailable"),
    );
    expect(transcript).not.toContain("Quality decision: pass");
    input.write("/exit\n");
    await conversation;
    const completion = handled.mock.calls.find(
      ([event]) => event.type === "tool_execution_end" && event.toolCallId === "input-ask-continue",
    );
    handled.mockRestore();
    expect(completion?.[0]).toMatchObject({
      result: {
        details: { quality: null, qualityLimitations: ["quality-validation-unavailable"] },
      },
    });
  });

  it("holds a bare retry without filling a text slot, then binds the explicit answer (#2342)", async () => {
    const fixture = await writeOpenEditorialRun({ runId: "retry-text-input", inputIds: ["prd"] });
    const gate = createLiveWorkflowFailureGate({ allowDirectEdits: false });
    const prompted: string[] = [];
    const continued: OperatorInputResumePlanV1[] = [];
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk) => {
      transcript += chunk.toString();
    });
    const done = runTerminalConversation(
      {
        sessionFile: undefined,
        subscribe: () => () => {},
        abort: async () => {},
        prompt: async (message) => {
          prompted.push(String(message));
        },
      },
      input,
      output,
      {
        ...activityOptions,
        ...liveWorkflowFailureTerminalOptions(gate),
        planEditorialInputAskTurn: (replyText) =>
          planLiveAgentEditorialInputAskTurn({
            stateDirectory: fixture.stateDirectory,
            repositoryPath: fixture.repositoryPath,
            revision: "HEAD",
            replyText,
          }),
        continueEditorialInputAsk: async (plan) => {
          continued.push(plan);
          return undefined;
        },
      },
    );
    input.write("retry\n");
    await vi.waitFor(() => expect(transcript).toContain("still needs its named input"));
    expect(() => gate.admitDirectChange()).toThrow(
      LIVE_WORKFLOW_FAILURE_GATE_MESSAGES.openInputAsk,
    );
    expect(continued).toEqual([]);
    expect(prompted).toEqual([]);
    input.write(`${REPLY}\n`);
    await vi.waitFor(() => expect(continued).toHaveLength(1));
    expect(continued[0]).toMatchObject({ originalRunId: fixture.runId, instruction: INSTRUCTION });
    expect(continued[0]!.fills[0]).toMatchObject({ source: "reply-text", inputId: "prd" });
    expect(prompted).toEqual([]);
    input.write("/exit\n");
    await done;
    // Outside terminal reserved-word routing, explicit input fills retain literal text.
    const explicit = await planLiveAgentEditorialInputAskTurn({
      stateDirectory: fixture.stateDirectory,
      repositoryPath: fixture.repositoryPath,
      revision: "HEAD",
      replyText: "retry",
    });
    expect(explicit.kind).toBe("input-ask-resume");
  });

  it("binds the next user message to open inputIds and continues the same run when snapshot matches", async () => {
    const fixture = await writeOpenEditorialRun({
      runId: "open-live-editorial-001",
      inputIds: ["prd"],
      snapshot: SNAPSHOT,
      planDigest: PLAN_DIGEST,
    });
    const delivery = new LiveWorkflowDelivery({
      repositoryPath: fixture.repositoryPath,
      stateDirectory: fixture.stateDirectory,
      allowWrite: false,
      confirmPublication: async () => false,
    });
    delivery.rememberEditorialInputAsk(fixture.record);
    expect(delivery.inputAskInputIdsForRun(fixture.runId)).toEqual(["prd"]);
    expect(await delivery.persist(fixture.record)).toEqual({ status: "not-needed" });
    expect(delivery.inputAskInputIdsForRun(fixture.runId)).toEqual(["prd"]);

    const turn = await planLiveAgentEditorialInputAskTurn({
      stateDirectory: fixture.stateDirectory,
      repositoryPath: fixture.repositoryPath,
      revision: "HEAD",
      replyText: REPLY,
      currentWorkspaceSnapshotSha256: SNAPSHOT,
      now: () => new Date("2026-09-16T19:00:00.000Z"),
    });
    expect(turn.kind).toBe("input-ask-resume");
    if (turn.kind !== "input-ask-resume") return;
    expect(turn.plan.originalRunId).toBe(fixture.runId);
    expect(turn.plan.instruction).toBe(INSTRUCTION);
    expect(turn.plan.instructionSha256).toBe(digestInstruction(INSTRUCTION));
    expect(turn.plan.skipPlanner).toBe(true);
    expect(turn.plan.skipSearchObserve).toBe(true);
    expect(turn.plan.revalidate).toBe(false);
    expect(turn.plan.verifiedNoChange).toBe(false);
    expect(turn.plan.fills).toEqual([
      expect.objectContaining({
        inputId: "prd",
        fillKind: "text",
        source: "reply-text",
        attribution: { who: "operator", what: "prd", when: "2026-09-16T19:00:00.000Z" },
      }),
    ]);

    const prompted: string[] = [];
    const continued: OperatorInputResumePlanV1[] = [];
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 100 });
    let transcript = "";
    output.on("data", (chunk) => {
      transcript += chunk.toString();
    });
    const conversation = runTerminalConversation(
      {
        sessionFile: undefined,
        subscribe: () => () => {},
        prompt: async (message) => {
          prompted.push(String(message));
        },
        abort: async () => {},
      },
      input,
      output,
      {
        ...activityOptions,
        planEditorialInputAskTurn: (replyText) =>
          planLiveAgentEditorialInputAskTurn({
            stateDirectory: fixture.stateDirectory,
            repositoryPath: fixture.repositoryPath,
            revision: "HEAD",
            replyText,
            currentWorkspaceSnapshotSha256: SNAPSHOT,
            now: () => new Date("2026-09-16T19:00:00.000Z"),
          }),
        continueEditorialInputAsk: async (plan) => {
          continued.push(plan);
          return undefined;
        },
      },
    );
    input.write(`${REPLY}\n`);
    await vi.waitFor(() => expect(continued).toHaveLength(1));
    expect(prompted).toEqual([]);
    expect(continued[0]?.originalRunId).toBe(fixture.runId);
    expect(continued[0]?.fills.map((fill) => fill.inputId)).toEqual(["prd"]);
    expect(transcript).toContain(renderLiveAgentInputAskResume(continued[0]!));
    expect(transcript).not.toMatch(/\bdoctor\b/iu);
    input.write("/exit\n");
    await conversation;
  });

  it("threads operatorInputResume through production continue for a text-only reply", async () => {
    const fixture = await writeOpenEditorialRun({
      runId: "live-inputask-text-continue",
      inputIds: ["prd"],
      snapshot: SNAPSHOT,
      planDigest: PLAN_DIGEST,
    });
    const turn = await planLiveAgentEditorialInputAskTurn({
      stateDirectory: fixture.stateDirectory,
      repositoryPath: fixture.repositoryPath,
      revision: "HEAD",
      replyText: REPLY,
      currentWorkspaceSnapshotSha256: SNAPSHOT,
      now: () => new Date("2026-09-16T19:00:00.000Z"),
    });
    expect(turn.kind).toBe("input-ask-resume");
    if (turn.kind !== "input-ask-resume") return;
    expect(turn.plan.readerSources).toEqual([]);
    expect(liveAgentContinueRunRequest(turn.plan).operatorInputResume).toBe(turn.plan);
    expect(liveAgentContinueRunRequest(turn.plan)).not.toHaveProperty("readerSources");

    const captured: Array<{ operatorInputResume?: OperatorInputResumePlanV1; runId?: string }> = [];
    const continuedRecord = editorialInputAskRecord("live-inputask-text-continued");
    const result = await continueLiveAgentEditorialInputAsk(turn.plan, {
      repositoryPath: fixture.repositoryPath,
      allowWrite: false,
      config: { stateDirectory: fixture.stateDirectory } as never,
      persist: async () => ({ status: "not-needed" }),
      runWorkflow: async (request) => {
        captured.push(request);
        return continuedRecord;
      },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.operatorInputResume).toBe(turn.plan);
    // The continuation runs under the id its stop was superseded by.
    expect(captured[0]?.runId).toBe(turn.plan.continuationRunId);
    expect(captured[0]?.operatorInputResume?.fills).toEqual([
      expect.objectContaining({ inputId: "prd", source: "reply-text", fillKind: "text" }),
    ]);
    expect(result.id).toBe("live-inputask-text-continued");
    expect(result.livePersistence).toEqual({ status: "not-needed" });
  });
});

describe("a live-agent continuation carries no interpretation outcome into its plan scope", () => {
  // Every local run, continuations included, keeps its plan inside the roots
  // (plan-write-scope-continue.test.ts), so the resume plan carries nothing
  // about how the chain's first run was read.
  it.each([
    [
      "an advisory",
      advisoryIntent(
        INSTRUCTION,
        { operation: "review", targets: [] },
        "request-intent-operation-mismatch",
      ),
    ],
    [
      "an admitted",
      recordedIntent(INSTRUCTION, {
        operation: "update",
        targets: [{ path: "docs/cli.md", quote: "docs/cli.md" }],
      }),
    ],
  ])("plans the same resume for %s run", async (_name, requestIntent) => {
    const fixture = await writeOpenEditorialRun({
      runId: "live-inputask-scope-continue",
      inputIds: ["prd"],
      snapshot: SNAPSHOT,
      planDigest: PLAN_DIGEST,
    });
    await writeFile(
      join(fixture.stateDirectory, `${fixture.runId}.json`),
      `${JSON.stringify({ ...fixture.record, requestIntent }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const turn = await planLiveAgentEditorialInputAskTurn({
      stateDirectory: fixture.stateDirectory,
      repositoryPath: fixture.repositoryPath,
      revision: "HEAD",
      replyText: REPLY,
      currentWorkspaceSnapshotSha256: SNAPSHOT,
    });
    if (turn.kind !== "input-ask-resume") throw new Error("no InputAsk resume was planned");
    expect(Object.keys(turn.plan).sort()).toEqual([
      "continuationRunId",
      "fills",
      "instruction",
      "instructionSha256",
      "originalRunId",
      "readerSources",
      "repositoryPath",
      "revalidate",
      "revision",
      "skipPlanner",
      "skipSearchObserve",
      "slots",
      "verifiedNoChange",
      "workflow",
    ]);
  });
});

describe("live-agent context survives an InputAsk continuation (#1177)", () => {
  it("carries the original run's never-parsed context into the continued request", async () => {
    const fixture = await writeOpenEditorialRun({
      runId: "live-inputask-context-continue",
      inputIds: ["prd"],
      snapshot: SNAPSHOT,
      planDigest: PLAN_DIGEST,
    });
    const context = "MR !42 evidence: the default name changed to friend.";
    await writeFile(
      join(fixture.stateDirectory, `${fixture.runId}.json`),
      `${JSON.stringify({ ...fixture.record, instructionContext: context }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const turn = await planLiveAgentEditorialInputAskTurn({
      stateDirectory: fixture.stateDirectory,
      repositoryPath: fixture.repositoryPath,
      revision: "HEAD",
      replyText: REPLY,
      currentWorkspaceSnapshotSha256: SNAPSHOT,
      now: () => new Date("2026-09-16T19:00:00.000Z"),
    });
    expect(turn.kind).toBe("input-ask-resume");
    if (turn.kind !== "input-ask-resume") return;
    expect(turn.plan.instructionContext).toBe(context);
    const captured: Array<{ instruction?: string; instructionContext?: string }> = [];
    await continueLiveAgentEditorialInputAsk(turn.plan, {
      repositoryPath: fixture.repositoryPath,
      allowWrite: false,
      config: { stateDirectory: fixture.stateDirectory } as never,
      persist: async () => ({ status: "not-needed" }),
      runWorkflow: async (request) => {
        captured.push(request);
        return editorialInputAskRecord("live-inputask-context-continued");
      },
    });
    expect(captured).toEqual([
      expect.objectContaining({ instruction: INSTRUCTION, instructionContext: context }),
    ]);
  });
});

describe("a live-agent continuation carries the original comparison", () => {
  it("forwards the retained comparison and nominations at the pinned head revision", async () => {
    const fixture = await writeOpenEditorialRun({
      runId: "live-inputask-comparison-continue",
      inputIds: ["prd"],
      snapshot: SNAPSHOT,
      planDigest: PLAN_DIGEST,
    });
    const head = "2".repeat(40);
    const comparisonRequest = {
      kind: "base-head" as const,
      baseRevision: "1".repeat(40),
      headRevision: head,
    };
    const readerSources = [{ role: "public-contract" as const, path: "src/orbit.ts" }];
    await writeFile(
      join(fixture.stateDirectory, `${fixture.runId}.json`),
      `${JSON.stringify({
        ...fixture.record,
        readerEvidenceRequest: retainedReaderEvidenceRequest({ comparisonRequest, readerSources }),
      })}\n`,
      { mode: 0o600 },
    );
    const turn = await planLiveAgentEditorialInputAskTurn({
      stateDirectory: fixture.stateDirectory,
      repositoryPath: fixture.repositoryPath,
      revision: "HEAD",
      replyText: REPLY,
      currentWorkspaceSnapshotSha256: SNAPSHOT,
    });
    expect(turn.kind).toBe("input-ask-resume");
    if (turn.kind !== "input-ask-resume") return;
    const captured: Parameters<typeof liveAgentWorkflowRunRequest>[0][] = [];
    await continueLiveAgentEditorialInputAsk(turn.plan, {
      repositoryPath: fixture.repositoryPath,
      allowWrite: false,
      config: { stateDirectory: fixture.stateDirectory } as never,
      persist: async () => ({ status: "not-needed" }),
      runWorkflow: async (request) => {
        captured.push(request);
        return editorialInputAskRecord("live-inputask-comparison-continued");
      },
    });
    expect(captured).toHaveLength(1);
    // The request the shared execution assembly receives, as runBoundedWorkflow builds it.
    const request = liveAgentWorkflowRunRequest(captured[0]!);
    expect(request.comparisonRequest).toEqual(comparisonRequest);
    expect(request.readerSources).toEqual(readerSources);
    expect(request.revision).toBe(head);
  });
});

describe("a live-agent reply finds its open run through a symbolic link to the repository", () => {
  it("resumes the run recorded under the canonical path and routes another repository", async () => {
    // The runner records the canonical repository path; the session's --repo is a link to it.
    const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-live-inputask-link-")));
    roots.push(root);
    const fixture = await writeOpenEditorialRun({
      runId: "live-inputask-symlinked-repo",
      inputIds: ["prd"],
      snapshot: SNAPSHOT,
      planDigest: PLAN_DIGEST,
      repositoryPath: join(root, "repo"),
      stateDirectory: join(root, "state"),
    });
    const link = join(root, "repo-link");
    await symlink(fixture.repositoryPath, link, "dir");
    const turn = (repositoryPath: string) =>
      planLiveAgentEditorialInputAskTurn({
        stateDirectory: fixture.stateDirectory,
        repositoryPath,
        revision: "HEAD",
        replyText: REPLY,
        currentWorkspaceSnapshotSha256: SNAPSHOT,
      });

    const linked = await turn(link);
    expect(linked.kind).toBe("input-ask-resume");
    if (linked.kind !== "input-ask-resume") return;
    expect(linked.plan.originalRunId).toBe(fixture.runId);

    // Adjacent: a different repository beside it never matches the run.
    const other = join(root, "other-repo");
    await mkdir(other, { mode: 0o700 });
    expect(await turn(other)).toEqual({ kind: "routing-turn" });
  });
});

describe("live-agent routing-time clarification stays distinct from InputAsk (#912)", () => {
  it("does not treat a routing-time follow-up as InputAsk when no editorial run is open", async () => {
    const fixture = await writeOpenEditorialRun({
      runId: "unrelated-repo-run",
      inputIds: ["prd"],
    });
    const otherRepo = join(fixture.repositoryPath, "other");
    await mkdir(otherRepo, { recursive: true, mode: 0o700 });
    const turn = await planLiveAgentEditorialInputAskTurn({
      stateDirectory: fixture.stateDirectory,
      repositoryPath: otherRepo,
      revision: "HEAD",
      replyText: ROUTING_CLARIFICATION,
    });
    expect(turn).toEqual({ kind: "routing-turn" });

    const prompted: string[] = [];
    const continued: OperatorInputResumePlanV1[] = [];
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 100 });
    const conversation = runTerminalConversation(
      {
        sessionFile: undefined,
        subscribe: () => () => {},
        prompt: async (message) => {
          prompted.push(String(message));
        },
        abort: async () => {},
      },
      input,
      output,
      {
        ...activityOptions,
        planEditorialInputAskTurn: (replyText) =>
          planLiveAgentEditorialInputAskTurn({
            stateDirectory: fixture.stateDirectory,
            repositoryPath: otherRepo,
            revision: "HEAD",
            replyText,
          }),
        continueEditorialInputAsk: async (plan) => {
          continued.push(plan);
          return undefined;
        },
      },
    );
    input.write(`${ROUTING_CLARIFICATION}\n`);
    await vi.waitFor(() => expect(prompted).toEqual([ROUTING_CLARIFICATION]));
    expect(continued).toEqual([]);
    input.write("/exit\n");
    await conversation;
  });

  it("keeps planner diagnostic needs-input off the InputAsk continuation", () => {
    const { activity, output } = renderer();
    activity.begin();
    activity.handle(start("docsfab_run_workflow", { workflow: "review-documentation" }));
    activity.handle(
      end("docsfab_run_workflow", {
        details: {
          status: "needs-input",
          workflow: "review-documentation",
          steps: [
            {
              status: "needs-input",
              summary: "Planner planBinding has missing, unexpected, or incorrectly typed fields.",
            },
          ],
        },
      }),
    );
    activity.interrupt();
    expect(output()).toContain(
      "Planner planBinding has missing, unexpected, or incorrectly typed fields.",
    );
    expect(output()).not.toContain("Named InputAsk slots are open");
    expect(output()).not.toContain("docsfab doctor");
  });
});

describe("live-agent source-support fill (#1297)", () => {
  const SOURCE_SLOT = "source-support:environment-prerequisite:docs/cli-reference.md";

  it("supersedes a stopped run only while its continuation is live or has advanced", async () => {
    const fixture = await writeOpenEditorialRun({
      runId: "live-source-support-superseded",
      inputIds: [SOURCE_SLOT],
      workflow: "create-documentation",
    });
    const plan = {
      originalRunId: fixture.runId,
      continuationRunId: "live-source-support-continuation",
      fills: [],
    };
    const openIds = async () =>
      (await listOpenEditorialRuns(fixture.stateDirectory)).map((run) => run.runId);
    const successorPath = join(fixture.stateDirectory, `${plan.continuationRunId}.json`);
    const successor = (record: object) => writeFile(successorPath, `${JSON.stringify(record)}\n`);
    const markerPath = join(
      fixture.stateDirectory,
      "input-ask-supersession",
      `${fixture.runId}.1.json`,
    );
    const claim = await recordOperatorInputSupersession({
      stateDirectory: fixture.stateDirectory,
      plan,
    });
    // A claim with no record yet and a live owner (this process) is running.
    expect(await openIds()).toEqual([]);
    // Released after its continuation ended without a record: open again.
    await claim.release();
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await openIds()).toEqual([fixture.runId]);

    const reclaimed = await recordOperatorInputSupersession({
      stateDirectory: fixture.stateDirectory,
      plan,
    });
    // Live owner: superseded while queued or running.
    await successor({ id: plan.continuationRunId, status: "running" });
    expect(await openIds()).toEqual([]);
    // Release never drops a claim whose continuation saved a record.
    await reclaimed.release();
    expect(await readFile(markerPath, "utf8")).toContain(plan.continuationRunId);
    // Stopped again as a continuable input stop, or succeeded: the chain moved on.
    await successor(
      editorialInputAskRecord(plan.continuationRunId, {
        repositoryPath: fixture.repositoryPath,
        inputIds: [SOURCE_SLOT],
        workflow: "create-documentation",
      }),
    );
    expect(await openIds()).toEqual([plan.continuationRunId]);
    await successor({ id: plan.continuationRunId, status: "succeeded" });
    expect(await openIds()).toEqual([]);
    // Every other end reopens the stop: failed, cancelled, a needs-input stop
    // that is not a continuable input stop (no outcome), and a
    // needs-human-decision stop.
    for (const status of ["failed", "cancelled", "needs-input", "needs-human-decision"]) {
      await successor({ id: plan.continuationRunId, status, workflow: "create-documentation" });
      expect(await openIds()).toEqual([fixture.runId]);
    }
    await expect(
      selectOpenEditorialRun({
        stateDirectory: fixture.stateDirectory,
        continueFrom: fixture.runId,
      }),
    ).resolves.toMatchObject({ runId: fixture.runId });

    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    const rewriteOwner = (processBirthIdentity: string | null) =>
      writeFile(
        markerPath,
        JSON.stringify({ ...marker, owner: { ...marker.owner, processBirthIdentity } }),
      );
    await successor({ id: plan.continuationRunId, status: "running" });
    // An owner whose start identity was unknown counts as alive (busy).
    await rewriteOwner(null);
    expect(await openIds()).toEqual([]);
    // Left running by an owner that is no longer this process: open again.
    await rewriteOwner("0".repeat(64));
    expect(await openIds()).toEqual([fixture.runId]);
  });

  it.each([
    [
      "a #1055-style needs-input stop with no outcome",
      { status: "needs-input", error: "The write step changed files outside the plan." },
    ],
    ["a needs-human-decision stop", { status: "needs-human-decision" }],
  ])("reopens the stop when its continuation ends as %s", async (_label, ending) => {
    const fixture = await writeOpenEditorialRun({
      runId: "live-source-support-uncontinuable",
      inputIds: [SOURCE_SLOT],
      workflow: "create-documentation",
    });
    const plan = {
      originalRunId: fixture.runId,
      continuationRunId: "live-source-support-uncontinuable-next",
      fills: [],
    };
    await recordOperatorInputSupersession({ stateDirectory: fixture.stateDirectory, plan });
    await writeFile(
      join(fixture.stateDirectory, `${plan.continuationRunId}.json`),
      `${JSON.stringify({
        id: plan.continuationRunId,
        workflow: "create-documentation",
        steps: [{ id: "write-documentation", status: ending.status }],
        ...ending,
      })}\n`,
    );

    // The successor is not a continuable input stop, so the chain's input
    // would otherwise be lost: the stop is open and continue selects it.
    expect((await listOpenEditorialRuns(fixture.stateDirectory)).map((run) => run.runId)).toEqual([
      fixture.runId,
    ]);
    await expect(
      selectOpenEditorialRun({
        stateDirectory: fixture.stateDirectory,
        continueFrom: fixture.runId,
      }),
    ).resolves.toMatchObject({ runId: fixture.runId });
    await expect(
      selectOpenEditorialRun({
        stateDirectory: fixture.stateDirectory,
        continueFrom: plan.continuationRunId,
      }),
    ).rejects.toThrow(
      `No open editorial needs-input run named ${plan.continuationRunId} is available to continue.`,
    );
  });

  it("names the run that now holds the chain when a continued stop is continued again", async () => {
    const fixture = await writeOpenEditorialRun({
      runId: "live-chain-a",
      inputIds: [SOURCE_SLOT],
      workflow: "create-documentation",
    });
    const stop = (runId: string) =>
      writeFile(
        join(fixture.stateDirectory, `${runId}.json`),
        `${JSON.stringify(
          editorialInputAskRecord(runId, {
            repositoryPath: fixture.repositoryPath,
            inputIds: [SOURCE_SLOT],
            workflow: "create-documentation",
          }),
        )}\n`,
      );
    const chain = (originalRunId: string, continuationRunId: string) =>
      recordOperatorInputSupersession({
        stateDirectory: fixture.stateDirectory,
        plan: { originalRunId, continuationRunId, fills: [] },
      });
    await chain(fixture.runId, "live-chain-b");
    await stop("live-chain-b");
    await chain("live-chain-b", "live-chain-c");
    await stop("live-chain-c");

    expect((await listOpenEditorialRuns(fixture.stateDirectory)).map((run) => run.runId)).toEqual([
      "live-chain-c",
    ]);
    const refusal = `Run ${fixture.runId} was already continued; live-chain-c is the open run in that chain. Continue live-chain-c instead.`;
    await expect(
      selectOpenEditorialRun({
        stateDirectory: fixture.stateDirectory,
        continueFrom: fixture.runId,
      }),
    ).rejects.toThrow(refusal);
    await expect(chain(fixture.runId, "live-chain-d")).rejects.toThrow(refusal);
  });

  it("reads claim sequences as strict unpadded integers", async () => {
    const fixture = await writeOpenEditorialRun({
      runId: "live-source-support-sequence",
      inputIds: [SOURCE_SLOT],
      workflow: "create-documentation",
    });
    const directory = join(fixture.stateDirectory, "input-ask-supersession");
    await mkdir(directory, { recursive: true });
    const claim = {
      schemaVersion: 1,
      kind: "docsfab-input-ask-supersession",
      originalRunId: fixture.runId,
      supersededBy: "live-sequence-next",
      sequence: 1,
      owner: { pid: process.pid, processBirthIdentity: null },
      inputIds: [],
      recordedAt: "2026-09-24T12:00:00.000Z",
    };
    // A padded name is not a claim, however well-formed its body.
    await writeFile(join(directory, `${fixture.runId}.01.json`), JSON.stringify(claim));
    expect((await listOpenEditorialRuns(fixture.stateDirectory)).map((run) => run.runId)).toEqual([
      fixture.runId,
    ]);
    await writeFile(join(directory, `${fixture.runId}.1.json`), JSON.stringify(claim));
    expect(await listOpenEditorialRuns(fixture.stateDirectory)).toEqual([]);
  });

  it("refuses a second continuation of the same stop by name instead of overwriting it", async () => {
    const fixture = await writeOpenEditorialRun({
      runId: "live-source-support-exclusive",
      inputIds: [SOURCE_SLOT],
      workflow: "create-documentation",
    });
    const first = {
      originalRunId: fixture.runId,
      continuationRunId: "live-exclusive-first",
      fills: [],
    };
    const second = { ...first, continuationRunId: "live-exclusive-second" };
    await recordOperatorInputSupersession({ stateDirectory: fixture.stateDirectory, plan: first });
    // The first continuation is still in preflight: no record yet, live owner.
    const refusal = `Run ${fixture.runId} is being continued as ${first.continuationRunId}. Wait for that run to finish.`;
    await expect(
      recordOperatorInputSupersession({ stateDirectory: fixture.stateDirectory, plan: second }),
    ).rejects.toThrow(refusal);
    await writeFile(
      join(fixture.stateDirectory, `${first.continuationRunId}.json`),
      `${JSON.stringify({ id: first.continuationRunId, status: "running" })}\n`,
    );
    await expect(
      recordOperatorInputSupersession({ stateDirectory: fixture.stateDirectory, plan: second }),
    ).rejects.toThrow(refusal);

    // Two continuations racing for the same claim: the loser is refused by name.
    const racing = await writeOpenEditorialRun({
      runId: "live-source-support-race",
      inputIds: [SOURCE_SLOT],
      workflow: "create-documentation",
    });
    const directory = join(racing.stateDirectory, "input-ask-supersession");
    await expect(
      recordOperatorInputSupersession({
        stateDirectory: racing.stateDirectory,
        plan: { originalRunId: racing.runId, continuationRunId: "race-loser", fills: [] },
        processes: {
          // Runs after this continuation read the claims and before it links its
          // own: a concurrent winner takes sequence 1 in between.
          inspect: () => {
            writeFileSync(join(directory, `${racing.runId}.1.json`), "{}\n");
            return { alive: true, identity: "a".repeat(64) };
          },
        },
      }),
    ).rejects.toThrow(`Run ${racing.runId} is already being continued by another continuation.`);
    expect(await readFile(join(directory, `${racing.runId}.1.json`), "utf8")).toBe("{}\n");
  });

  it("passes a sentence to the model while a source slot is open, with direct changes held", async () => {
    const fixture = await writeOpenEditorialRun({
      runId: "live-source-support-sentence",
      inputIds: [SOURCE_SLOT],
      workflow: "create-documentation",
      snapshot: SNAPSHOT,
      planDigest: PLAN_DIGEST,
    });
    const prompted: string[] = [];
    const continued: OperatorInputResumePlanV1[] = [];
    const held: string[] = [];
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 100 });
    let transcript = "";
    output.on("data", (chunk) => {
      transcript += chunk.toString();
    });
    const conversation = runTerminalConversation(
      {
        sessionFile: undefined,
        subscribe: () => () => {},
        prompt: async (message) => {
          prompted.push(String(message));
        },
        abort: async () => {},
      },
      input,
      output,
      {
        ...activityOptions,
        onUserTurn: (message) => held.push(`turn:${message}`),
        onOpenInputAskTurn: () => held.push("hold"),
        planEditorialInputAskTurn: (replyText) =>
          planLiveAgentEditorialInputAskTurn({
            stateDirectory: fixture.stateDirectory,
            repositoryPath: fixture.repositoryPath,
            revision: "HEAD",
            replyText,
            currentWorkspaceSnapshotSha256: SNAPSHOT,
          }),
        continueEditorialInputAsk: async (plan) => {
          continued.push(plan);
          return undefined;
        },
      },
    );
    input.write("What does the stopped page still need?\n");
    await vi.waitFor(() => expect(prompted).toHaveLength(1));
    expect(prompted).toEqual(["What does the stopped page still need?"]);
    expect(held).toEqual(["turn:What does the stopped page still need?", "hold"]);
    expect(continued).toEqual([]);
    expect(transcript).not.toContain("Text cannot fill");
    input.write("/exit\n");
    await conversation;
  });

  it("fills a source slot from a reply naming a repository file and continues the same job", async () => {
    const fixture = await writeOpenEditorialRun({
      runId: "live-source-support",
      inputIds: [SOURCE_SLOT],
      workflow: "create-documentation",
      snapshot: SNAPSHOT,
      planDigest: PLAN_DIGEST,
    });
    await writeFile(join(fixture.repositoryPath, "README.md"), "Requires Node.js 22 or later.\n");
    expect(liveAgentInputAskSlotsFromRecord(fixture.record)).toEqual([
      {
        inputId: SOURCE_SLOT,
        label: "Source for environment prerequisite on docs/cli-reference.md",
        why: expect.stringContaining("a paragraph cannot certify source support"),
        fillKind: "path",
      },
    ]);
    // A prose reply cannot certify source support and names no file, so it is
    // an ordinary turn while the slot stays open.
    expect(
      await planLiveAgentEditorialInputAskTurn({
        stateDirectory: fixture.stateDirectory,
        repositoryPath: fixture.repositoryPath,
        revision: "HEAD",
        replyText: "Node 22 is required.",
        currentWorkspaceSnapshotSha256: SNAPSHOT,
      }),
    ).toEqual({ kind: "routing-turn", openInputAsk: true });

    const prompted: string[] = [];
    const continued: OperatorInputResumePlanV1[] = [];
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 100 });
    let transcript = "";
    output.on("data", (chunk) => {
      transcript += chunk.toString();
    });
    const conversation = runTerminalConversation(
      {
        sessionFile: undefined,
        subscribe: () => () => {},
        prompt: async (message) => {
          prompted.push(String(message));
        },
        abort: async () => {},
      },
      input,
      output,
      {
        ...activityOptions,
        planEditorialInputAskTurn: (replyText) =>
          planLiveAgentEditorialInputAskTurn({
            stateDirectory: fixture.stateDirectory,
            repositoryPath: fixture.repositoryPath,
            revision: "HEAD",
            replyText,
            currentWorkspaceSnapshotSha256: SNAPSHOT,
            now: () => new Date("2026-09-24T19:00:00.000Z"),
          }),
        continueEditorialInputAsk: async (plan) => {
          continued.push(plan);
          return undefined;
        },
      },
    );
    input.write("README.md\n");
    await vi.waitFor(() => expect(continued).toHaveLength(1));
    // The reply went to the continuation, not to the model.
    expect(prompted).toEqual([]);
    const plan = continued[0]!;
    expect(plan.originalRunId).toBe(fixture.runId);
    expect(plan.workflow).toBe("create-documentation");
    expect(plan.fills).toEqual([
      expect.objectContaining({
        inputId: SOURCE_SLOT,
        fillKind: "path",
        role: "approved-source",
        source: "tracked-path",
        locator: "README.md",
        attribution: { who: "operator", what: SOURCE_SLOT, when: "2026-09-24T19:00:00.000Z" },
      }),
    ]);
    // A new approved source must be planned, so the retained plan revalidates.
    expect(plan.skipPlanner).toBe(false);
    expect(plan.revalidate).toBe(true);
    expect(plan.readerSources).toEqual([]);
    const request = liveAgentContinueRunRequest(plan);
    expect(request.instruction).toBe(INSTRUCTION);
    expect(request.instructionContext).toBe(
      `InputAsk fill ${SOURCE_SLOT}: the operator supplied the tracked repository file README.md as an approved source for environment prerequisite on docs/cli-reference.md. Bind it to that page and verify the page against it.`,
    );
    expect(transcript).toContain(renderLiveAgentInputAskResume(plan));
    input.write("/exit\n");
    await conversation;
  });
});

async function writeOpenEditorialRun(options: {
  readonly runId: string;
  readonly inputIds: readonly string[];
  readonly workflow?: RunRecord["workflow"];
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
      : await mkdtemp(join(tmpdir(), "docsfab-live-inputask-"));
  if (root) roots.push(root);
  const repositoryPath = options.repositoryPath ?? join(root!, "repo");
  const stateDirectory = options.stateDirectory ?? join(root!, "state");
  await mkdir(repositoryPath, { recursive: true, mode: 0o700 });
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const record = editorialInputAskRecord(options.runId, {
    repositoryPath,
    inputIds: options.inputIds,
    ...(options.workflow ? { workflow: options.workflow } : {}),
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
    readonly workflow?: RunRecord["workflow"];
    readonly snapshot?: string;
    readonly planDigest?: string;
  } = {},
): RunRecord {
  const inputIds = options.inputIds ?? ["prd"];
  const record: RunRecord = {
    schemaVersion: 2,
    id: runId,
    workflow: options.workflow ?? "update-documentation",
    repository: {
      sourcePath: options.repositoryPath ?? "/tmp/docsfab-live-inputask",
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

function digestInstruction(instruction: string): string {
  return createHash("sha256").update(instruction.normalize("NFC"), "utf8").digest("hex");
}
