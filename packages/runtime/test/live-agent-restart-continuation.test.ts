// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { repositoryVirtualCwd } from "../src/harness/pi-session.js";
import { createLiveAgentSourceSelection } from "../src/live-agent/source-commands.js";
import {
  invalidateLocalContinuation,
  LIVE_AGENT_CONTINUATION_ENTRY,
  LIVE_AGENT_CONTINUATION_NOTICE,
  persistLocalContinuation,
  persistLocalContinuationDelta,
  restoreLocalContinuation,
} from "../src/live-agent/local-continuation.js";
import {
  assembleLiveAgentSessionHost,
  bindLiveWorkflowRequest,
  runTerminalConversation,
} from "../src/live-agent/host.js";
import { createLiveWorkflowFailureGate } from "../src/live-agent/workflow-failure-gate.js";
import { parseChangeRequestSelector } from "../src/inputs/change-request-selector.js";
import { LIVE_WORKFLOW_REQUEST_FAILURES } from "../src/live-agent/workflow-failure-gate.js";
import { OperatorInputFillError } from "../src/inputs/operator-input-fill.js";
import { initFixtureRepo } from "./helpers/git.js";
import { installedLiveAgentCapabilities } from "./support/live-agent-installed-capabilities.js";
import { parseLiveAgentArguments } from "../src/cli/commands/live-agent.js";

describe("live-agent restart continuation", () => {
  it("lists a GitHub PR selected on the CLI after live host assembly", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-live-pr-selection-"));
    try {
      const sessionDirectory = join(root, "sessions");
      await mkdir(sessionDirectory, { recursive: true });
      const manager = SessionManager.create(repositoryVirtualCwd(root), sessionDirectory);
      const selected = parseLiveAgentArguments([
        "--repo",
        root,
        "--pr",
        "https://github.com/voice-team/agent-docs/pull/161",
      ]);
      const host = await makeHost(
        root,
        manager,
        sessionDirectory,
        async () => undefined,
        [],
        undefined,
        () => undefined,
        selected.changeSource,
      );

      expect(await host.terminalOptions.dispatchSourceCommand("/sources list")).toMatchObject({
        kind: "listing",
        changeReview: { label: "voice-team/agent-docs#161", sourceRead: "not-read" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains only a run locator and clears it on a later metadata-only checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-restart-choice-locator-"));
    try {
      const manager = SessionManager.create(repositoryVirtualCwd(root), root);
      const sources = createLiveAgentSourceSelection().snapshotState();
      const request = "Create docs/guide.md for developers.";
      const reply = "Use the implementation";
      persistLocalContinuation(
        manager,
        root,
        { operatorMessages: [request] },
        sources,
        "run-original",
      );
      expect(restoreLocalContinuation(manager, root)?.pending_first_pass_run_id).toBe(
        "run-original",
      );
      persistLocalContinuationDelta(
        manager,
        root,
        { baseCount: 1, operatorMessagesAdded: [reply], messageCount: 2 },
        sources,
        "run-successor",
      );
      const continued = restoreLocalContinuation(manager, root);
      expect(continued?.pending_first_pass_run_id).toBe("run-successor");
      expect(continued?.continuation.operatorMessages).toEqual([request, reply]);
      persistLocalContinuationDelta(
        manager,
        root,
        { baseCount: 2, operatorMessagesAdded: [], messageCount: 2 },
        sources,
      );
      const cleared = restoreLocalContinuation(manager, root);
      expect(cleared?.pending_first_pass_run_id).toBeUndefined();
      expect(cleared?.continuation.operatorMessages).toEqual([request, reply]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    "malformed",
    "mismatched",
    "interrupted",
    "unsupported-status",
    "malformed-first-pass-selector",
  ])(
    "blocks both InputAsk callbacks before a claim or run when saved state is %s",
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), "docsfab-restart-invalid-continuation-"));
      try {
        const sessionDirectory = join(root, "sessions");
        await mkdir(sessionDirectory, { recursive: true });
        const manager = SessionManager.create(repositoryVirtualCwd(root), sessionDirectory);
        persistLocalContinuation(
          manager,
          root,
          { operatorMessages: [] },
          { schema_version: 1, entries: [] },
        );
        const latest = manager.getBranch().at(-1);
        if (!latest || latest.type !== "custom") throw new Error("Missing checkpoint.");
        if (kind === "malformed") {
          manager.appendCustomEntry(LIVE_AGENT_CONTINUATION_ENTRY, { schema_version: 1 });
        } else if (kind === "mismatched") {
          manager.appendCustomEntry(LIVE_AGENT_CONTINUATION_ENTRY, {
            ...(latest.data as Record<string, unknown>),
            repository_binding: "wrong-repository",
          });
        } else if (kind === "malformed-first-pass-selector") {
          manager.appendCustomEntry(LIVE_AGENT_CONTINUATION_ENTRY, {
            ...(latest.data as Record<string, unknown>),
            pending_first_pass_run_id: "../foreign-run",
          });
        } else {
          if (kind === "interrupted") {
            invalidateLocalContinuation(manager);
          } else {
            const gate = createLiveWorkflowFailureGate();
            gate.beginUserTurn("Update docs/guide.md.");
            gate.noteBoundRequest(1);
            gate.recordFailure({
              kind: "run",
              workflow: "update-documentation",
              runId: "run-unsupported",
              status: "failed",
            });
            gate.endTurn();
            persistLocalContinuation(
              manager,
              root,
              gate.continuationState(),
              createLiveAgentSourceSelection().snapshotState(),
            );
            if (kind === "unsupported-status") {
              const persisted = manager.getBranch().at(-1);
              if (!persisted || persisted.type !== "custom")
                throw new Error("Missing persisted continuation.");
              const data = persisted.data as Record<string, unknown>;
              const continuation = data.continuation as Record<string, unknown>;
              const pendingRetry = continuation.pendingRetry as Record<string, unknown>;
              const failure = pendingRetry.failure as Record<string, unknown>;
              manager.appendCustomEntry(LIVE_AGENT_CONTINUATION_ENTRY, {
                ...data,
                continuation: {
                  ...continuation,
                  pendingRetry: {
                    ...pendingRetry,
                    failure: { ...failure, status: "rejected" },
                  },
                },
              });
            }
          }
        }
        const before = manager.getBranch().length;
        const runWorkflow = vi.fn(async () => needsInputRecord());
        const notices: string[] = [];
        const host = await makeHost(
          root,
          manager,
          sessionDirectory,
          runWorkflow,
          [],
          undefined,
          (notice) => notices.push(notice),
        );
        expect(notices).toEqual([LIVE_AGENT_CONTINUATION_NOTICE]);
        expect(() => host.terminalOptions.planEditorialInputAskTurn?.("prd: answer")).toThrow(
          LIVE_AGENT_CONTINUATION_NOTICE,
        );
        await expect(host.terminalOptions.continueEditorialInputAsk?.({} as never)).rejects.toThrow(
          LIVE_AGENT_CONTINUATION_NOTICE,
        );
        expect(() =>
          host.terminalOptions.planFirstPassChoiceTurn?.("Use the implementation"),
        ).toThrow(LIVE_AGENT_CONTINUATION_NOTICE);
        await expect(host.terminalOptions.continueFirstPassChoice?.({} as never)).rejects.toThrow(
          LIVE_AGENT_CONTINUATION_NOTICE,
        );
        expect(runWorkflow).not.toHaveBeenCalled();
        expect(manager.getBranch()).toHaveLength(before);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("restores the bound failed instruction for an exact full retry", () => {
    const first = createLiveWorkflowFailureGate();
    const request = "Update docs/guide.md using src/guide.ts.";
    first.beginUserTurn(request);
    first.noteBoundRequest(1);
    first.recordFailure({
      kind: "run",
      workflow: "update-documentation",
      runId: "run-1",
      status: "needs-input",
    });
    first.endTurn();
    const persisted = first.continuationState();

    const resumed = createLiveWorkflowFailureGate();
    resumed.restoreContinuationState(persisted);
    expect(resumed.resolveChoice("retry")).toContain(request);
    resumed.beginUserTurn("retry");
    expect(resumed.replayInstruction).toBe(request);
    expect(resumed.verbatimMessages).toEqual([request]);
    expect(resumed.turnOperatorMessages).toEqual([]);
  });

  it("does not restore pending retry after a successful workflow", () => {
    const gate = createLiveWorkflowFailureGate();
    gate.beginUserTurn("Change docs/guide.md");
    gate.recordFailure({
      kind: "run",
      workflow: "update-documentation",
      runId: "run-1",
      status: "failed",
    });
    gate.endTurn();
    gate.beginUserTurn("Continue");
    gate.recordSuccess();
    gate.endTurn();
    expect(gate.continuationState().pendingRetry).toBeUndefined();
  });

  it.each([
    { name: "bare retry", message: "retry", plannerReply: "" },
    { name: "invalid fill", message: "not-a-valid-fill", plannerReply: "not-a-valid-fill" },
  ])(
    "persists a handled $name InputAsk turn before terminal close",
    async ({ message, plannerReply }) => {
      const root = await mkdtemp(join(tmpdir(), "docsfab-restart-inputask-terminal-"));
      try {
        const sessionDirectory = join(root, "sessions");
        await mkdir(sessionDirectory, { recursive: true });
        const manager = SessionManager.create(repositoryVirtualCwd(root), sessionDirectory);
        const host = await makeHost(root, manager, sessionDirectory, async () =>
          needsInputRecord(),
        );
        const input = new PassThrough();
        const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
        let transcript = "";
        output.on("data", (chunk) => (transcript += chunk.toString()));
        let plannerCalls = 0;
        const terminalOptions = {
          ...host.terminalOptions,
          planEditorialInputAskTurn: async (replyText: string) => {
            plannerCalls += 1;
            expect(replyText).toBe(plannerReply);
            if (replyText === "")
              return { kind: "routing-turn" as const, openInputAsk: true as const };
            throw new OperatorInputFillError("The supplied answer did not match an open input.");
          },
        };
        let modelPrompts = 0;
        const done = runTerminalConversation(
          {
            sessionFile: undefined,
            subscribe: () => () => {},
            abort: async () => {},
            prompt: async () => {
              modelPrompts += 1;
            },
          } as never,
          input,
          output,
          {
            ...terminalOptions,
            environment: { NO_COLOR: "1" },
            skillIds: [],
            workflowIds: [],
          },
        );
        input.write(`${message}\n`);
        await vi.waitFor(() =>
          expect(transcript).toContain("A stopped workflow still needs its named input."),
        );
        if (message === "not-a-valid-fill") {
          await vi.waitFor(() =>
            expect(transcript).toContain("The supplied answer did not match an open input."),
          );
        }
        await vi.waitFor(() => expect(plannerCalls).toBe(1));
        expect(
          (transcript.match(/A stopped workflow still needs its named input\./gu) ?? []).length,
        ).toBe(1);
        input.write("/exit\n");
        await done;
        expect(modelPrompts).toBe(0);

        manager.appendMessage({
          role: "assistant",
          content: "Handled input routing.",
          api: "openai-completions",
          provider: "fixture",
          model: "fixture",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
        } as never);
        const reopened = SessionManager.continueRecent(
          repositoryVirtualCwd(root),
          sessionDirectory,
        );
        const saved = restoreLocalContinuation(reopened, root);
        expect(saved).toBeDefined();
        expect(saved?.continuation.operatorMessages).toEqual([message]);
        expect(saved?.sources).toEqual({ schema_version: 1, entries: [] });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("saves a real needs-input turn and restores details, retry, and sources through host assembly", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-restart-continuation-"));
    try {
      await initFixtureRepo(root, {
        "docs/guide.md": "# Guide\n",
        "docs/source.md": "# Source\n",
        "src/guide.ts": "export const guide = true;\n",
      });
      const sessionDirectory = join(root, "sessions");
      await mkdir(sessionDirectory, { recursive: true });
      const manager = SessionManager.create(repositoryVirtualCwd(root), sessionDirectory);
      const instruction = "Update docs/guide.md using src/guide.ts.";
      const sourcePaths = ["docs/source.md"];
      const selector = parseChangeRequestSelector(
        "https://gitlab.example/team/project/-/merge_requests/19",
      );
      const observed: Array<{
        instruction: string;
        sourcePaths?: readonly string[];
        selector?: unknown;
      }> = [];
      const firstHost = await makeHost(
        root,
        manager,
        sessionDirectory,
        async (request) => {
          observed.push(request);
          return needsInputRecord();
        },
        sourcePaths,
        selector,
      );
      firstHost.terminalOptions.onUserTurn?.(instruction);
      const firstTool = firstHost.customTools.find(
        (candidate) => candidate.name === "docsfab_run_workflow",
      );
      expect(firstTool).toBeDefined();
      await firstTool!.execute(
        "workflow",
        { workflow: "update-documentation", instruction },
        undefined,
        undefined,
        {} as never,
      );
      firstHost.workflowFailure.recordFailure({
        kind: "run",
        workflow: "update-documentation",
        runId: "run-durable",
        status: "needs-input",
        code: "request-intent-target-missing",
      });
      firstHost.terminalOptions.turnNotices?.();
      expect(observed[0]).toMatchObject({
        instruction,
        sourcePaths,
        changeRequestSelector: selector,
      });
      manager.appendMessage({ role: "user", content: "The workflow stopped.", timestamp: 1 });
      manager.appendMessage({
        role: "assistant",
        content: "The workflow needs input.",
        api: "openai-completions",
        provider: "fixture",
        model: "fixture",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      } as never);
      const reopened = SessionManager.continueRecent(repositoryVirtualCwd(root), sessionDirectory);
      const saved = restoreLocalContinuation(reopened, root);
      expect(saved?.continuation.pendingRetry?.instruction).toBe(instruction);
      expect(saved?.continuation.pendingRetry?.failure).toMatchObject({
        code: "request-intent-target-missing",
      });
      const resumedHost = await makeHost(root, reopened, sessionDirectory, async (request) => {
        observed.push(request);
        return needsInputRecord();
      });
      expect(resumedHost.systemPrompt).toContain("docs/source.md");
      expect(resumedHost.tools).not.toContain("edit");
      expect(resumedHost.tools).not.toContain("write");
      expect(resumedHost.tools).not.toContain("bash");
      const details = "The requested target is docs/guide.md.";
      resumedHost.terminalOptions.onUserTurn?.(details);
      const resumedTool = resumedHost.customTools.find(
        (candidate) => candidate.name === "docsfab_run_workflow",
      );
      await resumedTool!.execute(
        "workflow",
        { workflow: "update-documentation", instruction: `${instruction}\n\n${details}` },
        undefined,
        undefined,
        {} as never,
      );
      expect(observed.at(-1)).toMatchObject({
        instruction: `${instruction}\n\n${details}`,
        sourcePaths,
        changeRequestSelector: selector,
      });
      resumedHost.terminalOptions.turnNotices?.();
      reopened.appendMessage({ role: "user", content: details, timestamp: 3 });
      reopened.appendMessage({
        role: "assistant",
        content: "I still need the requested detail.",
        api: "openai-completions",
        provider: "fixture",
        model: "fixture",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 4,
      } as never);
      const reopenedAgain = SessionManager.continueRecent(
        repositoryVirtualCwd(root),
        sessionDirectory,
      );
      const retryHost = await makeHost(root, reopenedAgain, sessionDirectory, async (request) => {
        observed.push(request);
        return needsInputRecord();
      });
      const retryPrompt = retryHost.terminalOptions.resolveChoice?.("retry");
      expect(retryPrompt).toContain(`${instruction}\n\n${details}`);
      retryHost.terminalOptions.onUserTurn?.("retry");
      expect(retryHost.workflowFailure.replayInstruction).toBe(`${instruction}\n\n${details}`);
      const retryTool = retryHost.customTools.find(
        (candidate) => candidate.name === "docsfab_run_workflow",
      );
      expect(() =>
        bindLiveWorkflowRequest(
          retryHost.workflowFailure,
          { contextMaxChars: 4096 },
          { workflow: "update-documentation", instruction: details },
        ),
      ).toThrow(LIVE_WORKFLOW_REQUEST_FAILURES.notVerbatim);
      await retryTool!.execute(
        "workflow",
        { workflow: "update-documentation", instruction: `${instruction}\n\n${details}` },
        undefined,
        undefined,
        {} as never,
      );
      expect(observed.at(-1)).toMatchObject({
        instruction: `${instruction}\n\n${details}`,
        sourcePaths,
        changeRequestSelector: selector,
      });
      retryHost.workflowFailure.recordSuccess();
      retryHost.terminalOptions.turnNotices?.();
      reopenedAgain.appendMessage({
        role: "assistant",
        content: "The workflow completed successfully.",
        api: "openai-completions",
        provider: "fixture",
        model: "fixture",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 5,
      } as never);
      const completed = SessionManager.continueRecent(repositoryVirtualCwd(root), sessionDirectory);
      const completedHost = await makeHost(root, completed, sessionDirectory, async () =>
        needsInputRecord(),
      );
      expect(completedHost.workflowFailure.resolveChoice("retry")).toBeUndefined();
      retryHost.terminalOptions.onUserTurn?.("A later request was interrupted.");
      reopenedAgain.appendMessage({
        role: "assistant",
        content: "Interrupted before the turn completed.",
        api: "openai-completions",
        provider: "fixture",
        model: "fixture",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 6,
      } as never);
      const interrupted = SessionManager.continueRecent(
        repositoryVirtualCwd(root),
        sessionDirectory,
      );
      expect(() => restoreLocalContinuation(interrupted, root)).toThrow(
        /Start a new session with --new/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function makeHost(
  repositoryPath: string,
  sessionManager: SessionManager,
  sessionDirectory: string,
  runWorkflow: (request: {
    instruction: string;
    sourcePaths?: readonly string[];
    changeRequestSelector?: unknown;
  }) => Promise<unknown>,
  sourcePaths: readonly string[] = [],
  changeRequestSelector?: ReturnType<typeof parseChangeRequestSelector>,
  onNotice: (notice: string) => void = () => undefined,
  changeSource?: NonNullable<ReturnType<typeof parseLiveAgentArguments>["changeSource"]>,
) {
  const host = await assembleLiveAgentSessionHost({
    repositoryPath,
    allowWrite: false,
    environment: { PATH: process.env.PATH },
    config: {
      projectRoot: process.cwd(),
      stateDirectory: join(repositoryPath, "state"),
      model: { provider: "none", model: "none" },
    } as never,
    capabilities: await installedLiveAgentCapabilities(["update-documentation"]),
    sessionDirectory,
    sessionManager,
    ...(sourcePaths.length > 0 ? { sourcePaths } : {}),
    ...(changeRequestSelector ? { changeRequestSelector } : {}),
    ...(changeSource ? { changeSource } : {}),
    sourcePorts: {
      identityPort: {
        async resolveProjectIdentity(reference: { host: string; projectPath: string }) {
          return { ...reference, projectId: 41 };
        },
      },
    } as never,
    onNotice,
    writeError: () => undefined,
    runWorkflow: runWorkflow as never,
  });
  return host;
}

function needsInputRecord(): never {
  return {
    id: "run-durable",
    workflow: "update-documentation",
    status: "needs-input",
    repository: { revision: "f".repeat(40) },
    steps: [{ id: "plan", status: "needs-input" }],
    workflowOutcome: { disposition: "needs-input", findings: [] },
  } as never;
}

describe("closed source-choice retry denial across checkpoints", () => {
  it("retains only the denial and ordinary history, then clears it for a new turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-restart-choice-denial-"));
    try {
      const manager = SessionManager.create(repositoryVirtualCwd(root), root);
      const sources = createLiveAgentSourceSelection().snapshotState();
      const instruction = "Create docs/guide.md for developers.";
      const reply = "Use the implementation";
      persistLocalContinuation(manager, root, { operatorMessages: [instruction] }, sources);
      persistLocalContinuationDelta(
        manager,
        root,
        {
          baseCount: 1,
          operatorMessagesAdded: [reply],
          messageCount: 2,
          firstPassChoiceRetryBlocked: true,
        },
        sources,
      );
      const saved = restoreLocalContinuation(manager, root)!;
      expect(saved.continuation).toEqual({
        operatorMessages: [instruction, reply],
        firstPassChoiceRetryBlocked: true,
      });
      expect(saved.pending_first_pass_run_id).toBeUndefined();
      const gate = createLiveWorkflowFailureGate();
      gate.restoreContinuationState(saved.continuation);
      expect(gate.resolveChoice("retry")).toBeUndefined();
      expect(gate.refuseChoice("retry")).toContain("cannot be retried as a task");
      gate.beginUserTurn("Explain the documentation workflow.");
      expect(gate.refuseChoice("retry")).toBeUndefined();
      persistLocalContinuationDelta(manager, root, gate.continuationStateSince(2), sources);
      expect(
        restoreLocalContinuation(manager, root)?.continuation.firstPassChoiceRetryBlocked,
      ).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([false, null, "Use the implementation", { runId: "untrusted" }])(
    "refuses a malformed retry denial without deriving choice authority (%j)",
    async (value) => {
      const root = await mkdtemp(join(tmpdir(), "docsfab-restart-invalid-choice-denial-"));
      try {
        const manager = SessionManager.create(repositoryVirtualCwd(root), root);
        persistLocalContinuation(
          manager,
          root,
          { operatorMessages: [] },
          createLiveAgentSourceSelection().snapshotState(),
        );
        const latest = manager.getBranch().at(-1)!;
        if (latest.type !== "custom") throw new Error("Missing fixture checkpoint.");
        manager.appendCustomEntry(LIVE_AGENT_CONTINUATION_ENTRY, {
          ...(latest.data as object),
          continuation: { operatorMessages: [], firstPassChoiceRetryBlocked: value },
        });
        expect(() => restoreLocalContinuation(manager, root)).toThrow(
          "Local continuation rejected: invalid-value. Start a new session and restate the request.",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
