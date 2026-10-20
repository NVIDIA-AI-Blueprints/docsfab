// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { repositoryVirtualCwd } from "../src/harness/pi-session.js";
import { restoreLocalContinuation } from "../src/live-agent/local-continuation.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type { RunRecord } from "../src/records/contracts.js";
import { FileRunStore } from "../src/records/file-store.js";
import { canonicalDigest } from "../src/contract-kit/index.js";
import { RunRecordInstructionContextError } from "../src/records/instruction-context.js";
import { createFirstPassChoice } from "../src/records/first-pass-choice.js";
import { decodeSavedRunRecord } from "../src/records/saved-run-record.js";
import { FirstPassChoiceClaimStore } from "../src/records/first-pass-choice-store.js";
import {
  firstPassContradictionRecord,
  persistFirstPassContradictionStop,
} from "../src/cli/run/first-pass-contradiction-stop.js";
import { FirstPassChoiceContinuationError } from "../src/cli/run/first-pass-choice-continuation.js";
import { firstPassContradictionAdmission } from "../src/records/first-pass-contradiction-admission.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { WORKFLOW_CANCELLED } from "../src/execution/cancellation.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import { planLiveFirstPassChoice } from "../src/live-agent/first-pass-choice.js";
import { projectLiveWorkflowOutcome } from "../src/live-agent/capabilities.js";
import { createLiveAgentSourceSelection } from "../src/live-agent/source-commands.js";
import { LIVE_DELIVERY_FAILURES } from "../src/live-agent/workflow-delivery.js";
import {
  assembleLiveAgentHost,
  continueLiveFirstPassChoice,
  liveAgentWorkflowRunRequest,
  runTerminalConversation,
} from "../src/live-agent/host.js";
import { initFixtureRepo } from "./helpers/git.js";
import { recordedIntent } from "./helpers/first-pass-intent.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { validModelConfig } from "./helpers.js";
import { installedLiveAgentCapabilities } from "./support/live-agent-installed-capabilities.js";

const roots = temporaryRoots();
afterEach(async () => {
  vi.restoreAllMocks();
  await roots.cleanup();
});

async function fixture(instructionContext?: string, onPrepared?: (stateDirectory: string) => void) {
  const root = await roots.create("choice-cancellation-");
  const repositoryPath = join(root, "repo");
  const revision = await initFixtureRepo(repositoryPath, {
    "README.md": "# Fixture\n",
    "docs/guide.md": "# Original\n",
    "src/server.ts": "// Port 9090.\nexport const port = 8088;\n",
  });
  const instruction = "Create docs/new.md for the port.";
  const config = {
    projectRoot: process.cwd(),
    stateDirectory: join(root, "runs"),
    model: validModelConfig,
  } as DocsFabConfig;
  onPrepared?.(config.stateDirectory);
  const source = await persistFirstPassContradictionStop({
    request: {
      workflow: "create-documentation",
      repositoryPath,
      revision,
      instruction,
      ...(instructionContext !== undefined ? { instructionContext } : {}),
      allowWrite: true,
      releaseGate: false,
      patchOnly: true,
      requestIntent: recordedIntent(instruction, {
        operation: "create",
        targets: [{ path: "docs/new.md", quote: "docs/new.md" }],
      }),
    } as never,
    config,
    workspace: { sourcePath: repositoryPath, revision, requestedRevision: revision } as never,
    contradictions: [
      {
        obligationId: "port",
        targetPaths: ["docs/new.md"],
        condition: "listening port",
        sides: [
          { path: "src/server.ts", lineStart: 1, lineEnd: 1, value: "9090" },
          { path: "src/server.ts", lineStart: 2, lineEnd: 2, value: "8088" },
        ],
      },
    ],
  });
  const selected = await planLiveFirstPassChoice({
    stateDirectory: config.stateDirectory,
    repositoryPath,
    pendingRunId: source.id,
    replyText: "Use the implementation",
  });
  if (selected.kind !== "choice") throw new Error("Expected eligible fixture choice.");
  const store = new FileRunStore(config.stateDirectory);
  const parent = await store.getWithDigest(source.id);
  const options = {
    repositoryPath,
    allowWrite: true,
    config,
    persist: vi.fn(async () => ({ status: "not-needed" as const })),
  };
  return {
    root,
    repositoryPath,
    revision,
    config,
    source,
    plan: selected.plan,
    store,
    parent,
    options,
  };
}

function childRecord(
  f: Awaited<ReturnType<typeof fixture>>,
  request: Parameters<typeof liveAgentWorkflowRunRequest>[0],
): RunRecord {
  const {
    firstPassContradiction: _question,
    firstPassContradictionAdmission: _admission,
    error: _error,
    completedAt: _completed,
    ...base
  } = f.source;
  return {
    ...base,
    id: request.runId!,
    firstPassChoices: request.firstPassChoices,
    status: "running",
  };
}

async function child(f: Awaited<ReturnType<typeof fixture>>) {
  const id = f.plan.choices.at(-1)!.successorRunId;
  const saved = await f.store.getWithDigest(id);
  return decodeSavedRunRecord(saved.record as never, id);
}

describe("first-pass choice cancellation at the host boundary", {
  timeout: testTimeoutMs(30_000),
}, () => {
  it("refuses an earlier first-pass choice after a review source is attached", async () => {
    const f = await fixture();
    const selection = createLiveAgentSourceSelection();
    await selection.dispatch("/sources review https://github.com/voice-team/agent-docs/pull/161");
    const runWorkflow = vi.fn(async () => {
      throw new Error("A stale choice must not start a workflow.");
    });

    await expect(
      continueLiveFirstPassChoice(f.plan, { ...f.options, selection, runWorkflow }),
    ).rejects.toThrow(
      "This conversation now has attached evidence. Start a new run with that evidence rather than continuing the earlier contradiction.",
    );
    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    "failed",
    "applied",
    "already-applied",
    "not-needed",
    "legacy",
    "missing-checkout",
  ] as const)(
    "reports the existing child's recorded checkout without retrying (%s)",
    async (outcome) => {
      const f = await fixture();
      const choice = f.plan.choices.at(-1)!;
      await new FirstPassChoiceClaimStore(f.config.stateDirectory).claim({
        choice,
        childExists: async () => false,
      });
      const record = childRecord(f, {
        workflow: f.plan.workflow,
        repositoryPath: f.repositoryPath,
        instruction: f.plan.instruction,
        revision: f.plan.revision,
        allowWrite: true,
        runId: choice.successorRunId,
        firstPassChoices: f.plan.choices,
      });
      record.status = "succeeded";
      record.completedAt = new Date().toISOString();
      if (outcome === "missing-checkout") {
        record.changes = { files: [{ path: "docs/new.md", status: "added" }] };
      } else if (outcome !== "legacy") {
        record.checkoutPersistence =
          outcome === "failed"
            ? {
                schemaVersion: 1,
                kind: "checkout-persistence",
                outcome,
                errorCode: "patch-conflict",
              }
            : { schemaVersion: 1, kind: "checkout-persistence", outcome };
      }
      await f.store.save(record);
      const before = await f.store.getWithDigest(record.id);
      const runWorkflow = vi.fn(async () => {
        throw new Error("A cached reply must not start another workflow.");
      });
      const cached = await continueLiveFirstPassChoice(f.plan, { ...f.options, runWorkflow });
      expect(cached.id).toBe(record.id);
      expect(cached.livePersistence?.status).toBe(
        outcome === "legacy" ? "not-needed" : outcome === "missing-checkout" ? "failed" : outcome,
      );
      if (outcome === "failed") {
        expect(projectLiveWorkflowOutcome(cached)).toMatchObject({
          status: "failed",
          workflowStatus: "succeeded",
          persistence: { status: "failed", error: LIVE_DELIVERY_FAILURES.conflict },
        });
      } else if (outcome === "missing-checkout") {
        expect(projectLiveWorkflowOutcome(cached)).toMatchObject({
          status: "failed",
          workflowStatus: "succeeded",
          persistence: { status: "failed", error: expect.stringContaining("unverified") },
        });
      }
      expect(runWorkflow).not.toHaveBeenCalled();
      expect(f.options.persist).not.toHaveBeenCalled();
      expect((await f.store.getWithDigest(record.id)).sha256).toBe(before.sha256);
      expect((await f.store.getWithDigest(f.source.id)).sha256).toBe(f.parent.sha256);
      expect(await readdir(join(f.root, "first-pass-choice-claims"))).toHaveLength(1);
      expect(await readFile(join(f.repositoryPath, "docs/guide.md"), "utf8")).toBe("# Original\n");
    },
  );

  it.each([
    ["failed", "implementation"],
    ["failed", "exact"],
    ["remaining-question", "implementation"],
    ["remaining-question", "exact"],
    ["stale", "implementation"],
    ["stale", "exact"],
  ] as const)(
    "reports its settled %s successor after %s without retrying the answer as a task",
    async (mode, replyKind) => {
      const f = await fixture();
      let allocated = "";
      const runWorkflow = vi.fn(async (request) => {
        if (!request.firstPassChoices?.length) return f.source;
        allocated = request.runId;
        if (mode === "stale") throw new FirstPassChoiceContinuationError("stale");
        const record = childRecord(f, request);
        record.status = mode === "remaining-question" ? "needs-input" : "failed";
        record.error = mode === "remaining-question" ? "contradicted" : "fixture-workflow-failed";
        record.completedAt = new Date().toISOString();
        if (mode === "remaining-question") {
          record.firstPassContradiction = firstPassContradictionRecord([
            {
              ...f.source.firstPassContradiction!.contradictions[0]!,
              obligationId: "remaining-condition",
              condition: "Another unresolved condition.",
            },
          ]);
          record.firstPassContradictionAdmission = firstPassContradictionAdmission({
            runId: record.id,
            repositoryRevision: f.revision,
            instruction: f.plan.instruction,
            contradiction: record.firstPassContradiction,
          });
        }
        await f.store.save(record);
        return record;
      });
      let errorTranscript = "";
      const sessions = join(f.root, "sessions");
      await mkdir(sessions);
      const manager = SessionManager.create(repositoryVirtualCwd(f.repositoryPath), sessions);
      const capabilities = await installedLiveAgentCapabilities(["create-documentation"]);
      const makeHost = (sessionManager: SessionManager) =>
        assembleLiveAgentHost({
          sessionManager,
          sessionDirectory: sessions,
          repositoryPath: f.repositoryPath,
          allowWrite: true,
          environment: { PATH: process.env.PATH, NO_COLOR: "1" },
          config: f.config,
          capabilities,
          sourcePorts: {} as never,
          onNotice: () => {},
          writeError: (text) => {
            errorTranscript += text;
          },
          runWorkflow,
        });
      const host = await makeHost(manager);
      host.terminalOptions.onUserTurn!(f.plan.instruction);
      await host.customTools
        .find((tool) => tool.name === "docsfab_run_workflow")!
        .execute(
          "initial",
          { workflow: "create-documentation", instruction: f.plan.instruction } as never,
          undefined,
          undefined,
          {} as never,
        );
      host.terminalOptions.turnNotices!();
      const input = new PassThrough();
      const output = new PassThrough();
      let transcript = "";
      let checkingRetry = false;
      let retryFinished!: () => void;
      const retried = new Promise<void>((resolve) => {
        retryFinished = resolve;
      });
      output.on("data", (chunk) => {
        transcript += chunk.toString();
        if (checkingRetry && chunk.toString().includes("cannot be retried as a task"))
          retryFinished();
      });
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const prompt = vi.fn(async () => {
        if (checkingRetry) retryFinished();
      });
      const done = runTerminalConversation(
        { sessionFile: undefined, subscribe: () => () => {}, abort: async () => {}, prompt },
        input,
        output,
        {
          ...host.terminalOptions,
          environment: { NO_COLOR: "1" },
          turnNotices: () => {
            try {
              return host.terminalOptions.turnNotices!();
            } finally {
              if (allocated) finish();
            }
          },
        },
      );
      const reply =
        replyKind === "implementation"
          ? "Use the implementation"
          : f.source.firstPassContradiction!.question.options[1]!;
      input.write(reply + "\n");
      await finished;
      checkingRetry = true;
      input.write("retry\n");
      await retried;
      input.end();
      await done;
      expect(prompt).not.toHaveBeenCalled();
      expect(runWorkflow).toHaveBeenCalledTimes(2);
      expect(transcript).toContain(allocated);
      expect(errorTranscript).not.toContain("Check connectivity");
      expect(errorTranscript).not.toContain("Model or session request failed");
      expect(host.workflowFailure.continuationState().pendingRetry).toBeUndefined();
      expect(host.terminalOptions.resolveChoice!("retry")).toBeUndefined();
      expect(host.terminalOptions.resolveChoice!("edit anyway")).toBeUndefined();
      expect(host.terminalOptions.refuseChoice!("edit anyway")).toContain(
        "cannot be retried as a task",
      );
      if (mode === "remaining-question") {
        expect(transcript).toContain("Another unresolved condition.");
        expect(host.terminalOptions.hasPendingFirstPassChoice!()).toBe(true);
        const saved = await f.store.get(allocated);
        expect(
          (
            await host.terminalOptions.planFirstPassChoiceTurn!(
              saved.firstPassContradiction!.question.options[0]!,
            )
          ).kind,
        ).toBe("choice");
      } else {
        expect(transcript).toContain("Start a new request with your complete documentation task");
        const saved = await f.store.get(allocated);
        expect(saved.status).toBe("failed");
        if (mode === "stale") {
          expect(saved.error).toContain("cannot continue this run (stale)");
          expect(transcript).toContain("cannot continue this run (stale)");
          expect(transcript).toContain("Start a new run with the current repository evidence");
        }
      }
      manager.appendMessage({
        role: "assistant",
        content: "The source-choice result was retained.",
        api: "openai-completions",
        provider: "fixture",
        model: "fixture",
        stopReason: "stop",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });
      const reopened = SessionManager.continueRecent(
        repositoryVirtualCwd(f.repositoryPath),
        sessions,
      );
      expect(reopened.getSessionId()).toBe(manager.getSessionId());
      const checkpoint = restoreLocalContinuation(reopened, f.repositoryPath)!;
      expect(checkpoint.continuation.operatorMessages).toEqual([f.plan.instruction, reply]);
      expect(checkpoint.continuation.pendingRetry).toBeUndefined();
      expect(checkpoint.continuation.firstPassChoiceRetryBlocked).toBe(true);
      const restored = await makeHost(reopened);
      expect(restored.terminalOptions.resolveChoice!("retry")).toBeUndefined();
      const retryInput = new PassThrough();
      const retryOutput = new PassThrough();
      let retryText = "";
      let retryDone!: () => void;
      const retryReported = new Promise<void>((resolve) => {
        retryDone = resolve;
      });
      retryOutput.on("data", (chunk) => {
        retryText += chunk.toString();
        if (retryText.includes("cannot be retried as a task")) retryDone();
      });
      const restoredPrompt = vi.fn(async () => {
        retryDone();
      });
      const restoredTerminal = runTerminalConversation(
        {
          sessionFile: undefined,
          subscribe: () => () => {},
          abort: async () => {},
          prompt: restoredPrompt,
        },
        retryInput,
        retryOutput,
        { ...restored.terminalOptions, environment: { NO_COLOR: "1" } },
      );
      retryInput.write("retry\n");
      await retryReported;
      retryInput.end();
      await restoredTerminal;
      expect(restoredPrompt).not.toHaveBeenCalled();
      expect(runWorkflow).toHaveBeenCalledTimes(2);
      expect(retryText).toContain("cannot be retried as a task");
      restored.terminalOptions.onUserTurn!("Explain the documentation workflow.");
      expect(restored.terminalOptions.refuseChoice!("retry")).toBeUndefined();
      expect(
        restored.workflowFailure.continuationState().firstPassChoiceRetryBlocked,
      ).toBeUndefined();
      expect((await f.store.getWithDigest(f.source.id)).sha256).toBe(f.parent.sha256);
      const claims = await readdir(join(f.root, "first-pass-choice-claims"));
      expect(claims).toHaveLength(1);
      expect(
        await readFile(join(f.root, "first-pass-choice-claims", claims[0]!), "utf8"),
      ).not.toContain(reply);
      expect(await readFile(join(f.repositoryPath, "docs/guide.md"), "utf8")).toBe("# Original\n");
    },
  );

  it("returns a safe settled non-cancellation failure with its actual partial patch", async () => {
    const f = await fixture();
    let patchBytes = "";
    const error = new FirstPassChoiceContinuationError("stale");
    error.message = "private-error-body-must-not-reach-the-record-or-terminal";
    const runWorkflow = vi.fn(async (request) => {
      request.onProgress?.({ type: "run-status", runId: request.runId!, status: "running" }, {
        name: "create-documentation",
      } as never);
      const collector = await GitPatchEvidenceCollector.create(
        f.repositoryPath,
        join(f.root, "artifacts"),
      );
      try {
        await writeFile(join(f.repositoryPath, "docs/guide.md"), "# Retained partial change\n");
        const changes = await collector.capture({
          runId: request.runId!,
          repository: f.source.repository,
          workspacePath: f.repositoryPath,
          persistPatch: true,
        });
        patchBytes = await readFile(changes.patch!.artifactPath, "utf8");
        await f.store.save({ ...childRecord(f, request), changes });
      } finally {
        await collector.dispose();
      }
      throw error;
    });
    const result = await continueLiveFirstPassChoice(f.plan, { ...f.options, runWorkflow });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("cannot continue this run (stale)");
    expect(result.error).toContain("Start a new run with the current repository evidence");
    expect(JSON.stringify(result)).not.toContain(error.message);
    expect(await readFile(join(f.repositoryPath, "docs/guide.md"), "utf8")).toBe(
      "# Retained partial change\n",
    );
    expect(await readFile(result.changes!.patch!.artifactPath, "utf8")).toBe(patchBytes);
    expect(f.options.persist).not.toHaveBeenCalled();
    const repeated = await continueLiveFirstPassChoice(f.plan, { ...f.options, runWorkflow });
    expect(repeated.id).toBe(result.id);
    expect(runWorkflow).toHaveBeenCalledTimes(1);
    expect((await f.store.getWithDigest(f.source.id)).sha256).toBe(f.parent.sha256);
  });

  it.each(["missing", "failed", "applied"] as const)(
    "conserves saved %s checkout evidence after a terminal-result interruption",
    async (retained) => {
      const f = await fixture();
      const collector = await GitPatchEvidenceCollector.create(
        f.repositoryPath,
        join(f.root, "artifacts"),
      );
      let changes: NonNullable<RunRecord["changes"]>;
      try {
        await writeFile(join(f.repositoryPath, "docs/guide.md"), "# Saved writer change\n");
        changes = await collector.capture({
          runId: f.plan.choices.at(-1)!.successorRunId,
          repository: f.source.repository,
          workspacePath: f.repositoryPath,
          persistPatch: true,
        });
      } finally {
        await writeFile(join(f.repositoryPath, "docs/guide.md"), "# Original\n");
        await collector.dispose();
      }
      let childDigest = "";
      const runWorkflow = vi.fn(async (request) => {
        const record = childRecord(f, request);
        record.status = "succeeded";
        record.completedAt = new Date().toISOString();
        record.changes = changes;
        if (retained !== "missing")
          record.checkoutPersistence =
            retained === "failed"
              ? {
                  schemaVersion: 1,
                  kind: "checkout-persistence",
                  outcome: "failed",
                  errorCode: "patch-conflict",
                }
              : { schemaVersion: 1, kind: "checkout-persistence", outcome: "applied" };
        await f.store.save(record);
        childDigest = (await f.store.getWithDigest(record.id)).sha256;
        throw new Error("private-post-terminal-error-body");
      });
      const first = await continueLiveFirstPassChoice(f.plan, { ...f.options, runWorkflow });
      const repeated = await continueLiveFirstPassChoice(f.plan, { ...f.options, runWorkflow });
      expect(first.livePersistence?.status).toBe(retained === "applied" ? "applied" : "failed");
      expect(repeated.livePersistence).toEqual(first.livePersistence);
      expect(projectLiveWorkflowOutcome(first).status).toBe(
        projectLiveWorkflowOutcome(repeated).status,
      );
      expect(first.id).toBe(repeated.id);
      expect(first.status).toBe("succeeded");
      expect(
        first.evidenceWarnings?.some(
          (line) =>
            line.includes(first.id) && line.includes("interrupted") && line.includes("Inspect"),
        ),
      ).toBe(true);
      expect(JSON.stringify(first)).not.toContain("private-post-terminal-error-body");
      expect((await f.store.getWithDigest(first.id)).sha256).toBe(childDigest);
      expect((await f.store.getWithDigest(f.source.id)).sha256).toBe(f.parent.sha256);
      expect(runWorkflow).toHaveBeenCalledTimes(1);
      expect(f.options.persist).not.toHaveBeenCalled();
      expect(await readdir(join(f.root, "first-pass-choice-claims"))).toHaveLength(1);
      expect(await readFile(first.changes!.patch!.artifactPath, "utf8")).not.toBe("");
      expect(await readFile(join(f.repositoryPath, "docs/guide.md"), "utf8")).toBe("# Original\n");
    },
  );

  it("refuses an unclaimed serialized choice at the actual request entry", async () => {
    const f = await fixture();
    await expect(
      executeRunRequest(
        liveAgentWorkflowRunRequest({
          repositoryPath: f.repositoryPath,
          allowWrite: true,
          workflow: f.plan.workflow,
          instruction: f.plan.instruction,
          revision: f.plan.revision,
          firstPassChoices: f.plan.choices,
          runId: f.plan.choices.at(-1)!.successorRunId,
        }),
        f.config,
      ),
    ).rejects.toThrow("The saved first-pass choice cannot continue this run (ineligible).");
  });

  it.each(["second:port/path", "second port/path"])(
    "accepts an exact offered option with its original opaque obligation prefix %s",
    async (obligationId) => {
      const f = await fixture();
      const base = f.source.firstPassContradiction!.contradictions[0]!;
      const source = await persistFirstPassContradictionStop({
        request: {
          ...liveAgentWorkflowRunRequest({
            repositoryPath: f.repositoryPath,
            revision: f.revision,
            workflow: f.plan.workflow,
            instruction: f.plan.instruction,
            allowWrite: true,
          }),
          requestIntent: f.source.requestIntent,
        },
        config: f.config,
        workspace: {
          sourcePath: f.repositoryPath,
          revision: f.revision,
          requestedRevision: f.revision,
        } as never,
        contradictions: [
          { ...base, obligationId: "first:port/path" },
          { ...base, obligationId },
        ],
      });
      const replyText = source.firstPassContradiction!.question.options.find(
        (option) => option.startsWith(`${obligationId}: `) && option.includes("8088"),
      )!;
      const selected = await planLiveFirstPassChoice({
        repositoryPath: f.repositoryPath,
        stateDirectory: f.config.stateDirectory,
        pendingRunId: source.id,
        replyText,
      });
      expect(selected.kind).toBe("choice");
      if (selected.kind === "choice")
        expect(selected.plan.choices.at(-1)!.obligationId).toBe(obligationId);
    },
  );

  it("accepts the closed implementation reply case insensitively", async () => {
    const f = await fixture();
    const selected = await planLiveFirstPassChoice({
      repositoryPath: f.repositoryPath,
      stateDirectory: f.config.stateDirectory,
      pendingRunId: f.source.id,
      replyText: "use the implementation",
    });
    expect(selected.kind).toBe("choice");
    if (selected.kind === "choice")
      expect(selected.plan.choices.at(-1)!.optionIndex).toBe(f.plan.choices.at(-1)!.optionIndex);
  });

  it("refuses an injected unsupported Withhold choice before claim or provider", async () => {
    const f = await fixture();
    const {
      schemaVersion: _schema,
      kind: _kind,
      choiceSha256: _digest,
      ...body
    } = f.plan.choices.at(-1)!;
    const question = f.source.firstPassContradiction!.question;
    const withhold = createFirstPassChoice({
      ...body,
      selection: "withhold",
      optionIndex: question.options.length - 1,
      optionSha256: canonicalDigest(question.recommendedDefault),
    });
    const runWorkflow = vi.fn(async () => {
      throw new Error("provider invoked");
    });
    await expect(
      continueLiveFirstPassChoice(
        { ...f.plan, choices: [withhold] },
        { ...f.options, runWorkflow },
      ),
    ).rejects.toThrow("The saved first-pass choice cannot continue this run (ineligible).");
    expect(runWorkflow).not.toHaveBeenCalled();
    await expect(lstat(join(f.root, "first-pass-choice-claims"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["legacy external", "missing context binding"] as const)(
    "keeps a contextual stop ineligible with %s admission",
    async (mode) => {
      const f = await fixture("Original non-authoritative context.");
      const {
        instructionContextSha256: _context,
        admissionSha256: _digest,
        ...body
      } = f.source.firstPassContradictionAdmission!;
      const legacy =
        mode === "legacy external"
          ? { ...body, outcome: "external-binding-unsupported", reasons: ["context"] }
          : body;
      const record = {
        ...f.source,
        firstPassContradictionAdmission: { ...legacy, admissionSha256: canonicalDigest(legacy) },
      };
      await writeFile(
        join(f.config.stateDirectory, `${f.source.id}.json`),
        `${JSON.stringify(record)}\n`,
      );
      expect(
        await planLiveFirstPassChoice({
          repositoryPath: f.repositoryPath,
          stateDirectory: f.config.stateDirectory,
          pendingRunId: f.source.id,
          replyText: "Use the implementation",
        }),
      ).toEqual({
        kind: "refused",
        reason:
          mode === "legacy external"
            ? "This stopped run bound external or non-replayable evidence. Start a new run with those sources."
            : "The stopped run could not be verified. Start a new run.",
      });
    },
  );

  it("rejects context changed on the stopped record before a fresh choice is planned", async () => {
    const f = await fixture("Original non-authoritative context.");
    const changed = {
      ...f.source,
      instructionContext: "Context replaced after the host recorded the stop.",
    };
    await writeFile(
      join(f.config.stateDirectory, `${f.source.id}.json`),
      `${JSON.stringify(changed)}\n`,
    );
    expect(
      await planLiveFirstPassChoice({
        repositoryPath: f.repositoryPath,
        stateDirectory: f.config.stateDirectory,
        pendingRunId: f.source.id,
        replyText: "Use the implementation",
      }),
    ).toEqual({
      kind: "refused",
      reason: "The stopped run could not be verified. Start a new run.",
    });
  });

  it.each([undefined, "Changed context without a new source stop."])(
    "refuses a changed or dropped saved context before claim (%s)",
    async (instructionContext) => {
      const f = await fixture("The live agent retained this non-authoritative context.");
      expect(f.plan.instructionContext).toBe(f.source.instructionContext);
      const runWorkflow = vi.fn(async () => {
        throw new Error("provider invoked");
      });
      await expect(
        continueLiveFirstPassChoice(
          { ...f.plan, instructionContext },
          { ...f.options, runWorkflow },
        ),
      ).rejects.toThrow("The saved first-pass choice cannot continue this run (stale).");
      expect(runWorkflow).not.toHaveBeenCalled();
      await expect(lstat(join(f.root, "first-pass-choice-claims"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await f.store.getWithDigest(f.source.id)).sha256).toBe(f.parent.sha256);
    },
  );

  it.each(["", " untrimmed context "])(
    "rejects unsupported context before saving a stop or offering choices (%s)",
    async (context) => {
      let stateDirectory = "";
      await expect(
        fixture(context, (path) => {
          stateDirectory = path;
        }),
      ).rejects.toBeInstanceOf(RunRecordInstructionContextError);
      expect(stateDirectory).not.toBe("");
      await expect(lstat(stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("honors an abort before claim without provider, persistence, or repository writes", async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort("private-abort-reason");
    const runWorkflow = vi.fn(async () => {
      throw new Error("provider invoked");
    });
    await expect(
      continueLiveFirstPassChoice(f.plan, { ...f.options, signal: controller.signal, runWorkflow }),
    ).rejects.toThrow(WORKFLOW_CANCELLED);
    expect(runWorkflow).not.toHaveBeenCalled();
    expect(f.options.persist).not.toHaveBeenCalled();
    await expect(lstat(join(f.root, "first-pass-choice-claims"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(f.repositoryPath, "docs/guide.md"), "utf8")).toBe("# Original\n");
    expect((await f.store.getWithDigest(f.source.id)).sha256).toBe(f.parent.sha256);
  });

  it("settles an abort after claim before provider as its one truthful cancelled child", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const original = FirstPassChoiceClaimStore.prototype.claim;
    vi.spyOn(FirstPassChoiceClaimStore.prototype, "claim").mockImplementationOnce(
      async function (input) {
        const claimed = await original.call(this, input);
        controller.abort("private-after-claim-reason");
        return claimed;
      },
    );
    const runWorkflow = vi.fn(async () => {
      throw new Error("provider invoked");
    });
    const result = await continueLiveFirstPassChoice(f.plan, {
      ...f.options,
      signal: controller.signal,
      runWorkflow,
    });
    expect(result).toMatchObject({ status: "failed", error: WORKFLOW_CANCELLED, steps: [] });
    expect(result.failure).toMatchObject({ class: "cancelled" });
    expect(runWorkflow).not.toHaveBeenCalled();
    expect(f.options.persist).not.toHaveBeenCalled();
    expect(JSON.stringify(await child(f))).not.toContain("private-after-claim-reason");
    const duplicate = await continueLiveFirstPassChoice(f.plan, { ...f.options, runWorkflow });
    expect(duplicate.id).toBe(result.id);
    expect(duplicate.error).toBe(WORKFLOW_CANCELLED);
    expect(runWorkflow).not.toHaveBeenCalled();
    expect((await f.store.getWithDigest(f.source.id)).sha256).toBe(f.parent.sha256);
  });

  it("propagates active cancellation and retains real partial bytes and patch evidence", async () => {
    const f = await fixture();
    const controller = new AbortController();
    let started!: () => void;
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    let patchBytes = "";
    const runWorkflow = vi.fn(async (request) => {
      expect(request.signal).toBe(controller.signal);
      request.onProgress?.({ type: "run-status", runId: request.runId!, status: "running" }, {
        name: "create-documentation",
      } as never);
      const collector = await GitPatchEvidenceCollector.create(
        f.repositoryPath,
        join(f.root, "artifacts"),
      );
      try {
        await writeFile(join(f.repositoryPath, "docs/guide.md"), "# Partial work\n");
        const changes = await collector.capture({
          runId: request.runId!,
          repository: f.source.repository,
          workspacePath: f.repositoryPath,
          persistPatch: true,
        });
        patchBytes = await readFile(changes.patch!.artifactPath, "utf8");
        await f.store.save({ ...childRecord(f, request), changes });
      } finally {
        await collector.dispose();
      }
      started();
      await new Promise<void>((resolve) =>
        request.signal!.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw new Error(WORKFLOW_CANCELLED);
    });
    const running = continueLiveFirstPassChoice(f.plan, {
      ...f.options,
      signal: controller.signal,
      runWorkflow,
    });
    await Promise.race([
      active,
      running.then(() => {
        throw new Error("The successor ended before active-work observation.");
      }),
    ]);
    controller.abort("private-active-reason");
    const result = await running;
    expect(result).toMatchObject({ status: "failed", error: WORKFLOW_CANCELLED });
    expect(await readFile(join(f.repositoryPath, "docs/guide.md"), "utf8")).toBe(
      "# Partial work\n",
    );
    expect(await readFile(result.changes!.patch!.artifactPath, "utf8")).toBe(patchBytes);
    expect((await child(f)).changes).toEqual(result.changes);
    expect(f.options.persist).not.toHaveBeenCalled();
    const duplicate = await continueLiveFirstPassChoice(f.plan, { ...f.options, runWorkflow });
    expect(duplicate.id).toBe(result.id);
    expect(runWorkflow).toHaveBeenCalledTimes(1);
    expect((await f.store.getWithDigest(f.source.id)).sha256).toBe(f.parent.sha256);
  });

  it("refuses to invent zero-step evidence after reported workflow work", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const runWorkflow = vi.fn(async (request) => {
      request.onProgress?.({ type: "run-status", runId: request.runId!, status: "running" }, {
        name: "create-documentation",
      } as never);
      controller.abort();
      throw new Error(WORKFLOW_CANCELLED);
    });
    await expect(
      continueLiveFirstPassChoice(f.plan, { ...f.options, signal: controller.signal, runWorkflow }),
    ).rejects.toThrow("reported workflow work, but its saved evidence is unavailable");
    await expect(child(f)).rejects.toMatchObject({ code: "record-not-found" });
    expect(f.options.persist).not.toHaveBeenCalled();
  });

  it("keeps ordinary terminal turns outside choice admission when no stop is pending", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const planChoice = vi.fn(async () => ({ kind: "routing" as const }));
    const prompt = vi.fn(async () => undefined);
    const done = runTerminalConversation(
      { sessionFile: undefined, subscribe: () => () => {}, abort: async () => {}, prompt },
      input,
      output,
      {
        environment: { NO_COLOR: "1" },
        skillIds: [],
        workflowIds: [],
        hasPendingFirstPassChoice: () => false,
        planFirstPassChoiceTurn: planChoice,
      },
    );
    input.write("Explain the documentation workflow.\n");
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    input.end();
    await done;
    expect(planChoice).not.toHaveBeenCalled();
  });

  it("propagates terminal EOF to an active choice and reports interruption", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk) => {
      transcript += chunk.toString();
    });
    let observed: AbortSignal | undefined;
    const continueChoice = vi.fn(async (_plan, signal?: AbortSignal) => {
      observed = signal;
      if (signal)
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      return {
        id: "cancelled-child",
        workflow: "create-documentation",
        status: "failed",
        error: WORKFLOW_CANCELLED,
        steps: [],
        livePersistence: { status: "not-needed" },
      } as never;
    });
    const abort = vi.fn(async () => undefined);
    const prompt = vi.fn(async () => undefined);
    const done = runTerminalConversation(
      { sessionFile: undefined, subscribe: () => () => {}, abort, prompt },
      input,
      output,
      {
        environment: { NO_COLOR: "1" },
        skillIds: [],
        workflowIds: ["create-documentation"],
        planFirstPassChoiceTurn: async () =>
          ({ kind: "choice", plan: { workflow: "create-documentation" } }) as never,
        continueFirstPassChoice: continueChoice,
      },
    );
    try {
      input.write("Use the implementation\n");
      await vi.waitFor(() => expect(continueChoice).toHaveBeenCalledTimes(1));
      expect(observed).toBeInstanceOf(AbortSignal);
      input.end();
      await done;
      expect(observed!.aborted).toBe(true);
      expect(abort).toHaveBeenCalledTimes(1);
      expect(transcript).toContain("[Interrupted]");
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      input.end();
      await done;
    }
  });
});
