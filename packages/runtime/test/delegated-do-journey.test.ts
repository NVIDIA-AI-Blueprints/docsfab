// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  handleDoCommand,
  parseDoArguments,
  type DoCommandOptions,
} from "../src/cli/commands/do.js";
import { DELEGATED_TASK_UNSUPPORTED_HOST } from "../src/delegated-task/driver.js";
import { inspectPauseDelegatedTask } from "../src/delegated-task/continuation.js";
import { decodeDelegatedTaskResult } from "../src/delegated-task/result-contract.js";
import { delegatedTaskExitIntent } from "../src/delegated-task/result-format.js";
import {
  DELEGATED_TASK_GENERIC_PROMPT,
  DelegatedTaskStateStore,
  delegatedTaskStoreRecordId,
} from "../src/delegated-task/task-state.js";
import { DELEGATED_WRITE_BLOCKED_ISSUES } from "../src/delegated-task/authority-adapter.js";
import type { OperatorOutputCoordinator } from "../src/operator/index.js";
import { temporaryRoots } from "./helpers/temp.js";

const directories = temporaryRoots();
const SOURCE_QUESTION = "Which flag enables JSON output?";
const REVISION = "a".repeat(40);
const NOW = () => new Date("2026-09-17T20:00:00.000Z");
const CHECK_MANIFEST = JSON.stringify({
  scripts: { test: "node -e 0", "docs:check": "node -e 0" },
});
const CHECK_FLAGS = ["--check", "test", "--check", "docs:check"];

afterEach(async () => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

async function fixture(options: { operators?: boolean } = {}): Promise<{
  repositoryPath: string;
  stateDirectory: string;
}> {
  const root = await directories.create("docsfab-delegated-do-");
  const repositoryPath = join(root, "repo");
  await mkdir(join(repositoryPath, "docs"), { recursive: true });
  await writeFile(join(repositoryPath, "docs", "reference.md"), "json_flag=--json\n", "utf8");
  await writeFile(join(repositoryPath, "README.md"), "operators live under docs/operators/\n");
  if (options.operators) {
    await mkdir(join(repositoryPath, "docs", "operators"), { recursive: true });
    await writeFile(join(repositoryPath, "docs", "operators", "index.md"), "# Operators\n");
  }
  return { repositoryPath, stateDirectory: join(root, "state") };
}

function basis(repositoryPath: string) {
  return async () => ({
    canonicalRepositoryPath: repositoryPath,
    committedHeadRevision: REVISION,
    dirtyPaths: [],
    workspace: {
      strategy: "tracked-export" as const,
      disposable: true as const,
      origin: "committed-head" as const,
      revision: REVISION,
    },
  });
}

function completedReadResult(answer = "The JSON output flag is --json ([source-line 1]).") {
  return {
    kind: "docsfab-delegated-task-result" as const,
    status: "completed" as const,
    answer,
    transcript: [
      {
        kind: "tool-call" as const,
        name: "read",
        arguments: { path: "docs/reference.md" },
      },
      {
        kind: "tool-result" as const,
        name: "read",
        isError: false,
        text: "json_flag=--json\n[source-line 1]",
      },
    ],
    childWorkflows: [],
  };
}

function delegatedOptions(
  repositoryPath: string,
  stateDirectory: string,
  extras: DoCommandOptions = {},
): DoCommandOptions {
  return {
    stateDirectory,
    now: NOW,
    inspectDelegatedWorkspaceBasis: basis(repositoryPath),
    createDelegatedTaskAuthority: async () =>
      ({ kind: "docsfab-delegated-task-authority" }) as never,
    runDelegatedTask: async () => completedReadResult(),
    inspectPauseDelegatedTask: async () => ({
      status: "finished" as const,
      result: {} as never,
      completedReads: [],
      genericPrompt: false as const,
    }),
    runWorkflow: async () => {
      throw new Error("catalog runner must not run");
    },
    admitCatalogWorkflow: async () => {
      throw new Error("catalog admission must not run");
    },
    signal: new AbortController().signal,
    ...extras,
  };
}

async function captureIo<T>(fn: () => Promise<T>): Promise<{
  stdout: string;
  stderr: string;
  value: T;
}> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message?: unknown) => logs.push(String(message ?? ""));
  console.error = (message?: unknown) => errors.push(String(message ?? ""));
  try {
    const value = await fn();
    return { stdout: logs.join("\n"), stderr: errors.join("\n"), value };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe("delegated do journey (#880)", () => {
  it("creates a fresh finite task, projects source-backed evidence, exits 0, and emits no You: prompt", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const printed = await captureIo(() =>
      handleDoCommand(
        ["--delegate", SOURCE_QUESTION, "--repo", repositoryPath, "--no-input", "--json"],
        delegatedOptions(repositoryPath, stateDirectory, { taskId: "task:source-question" }),
      ),
    );
    expect(printed.stdout).not.toContain(DELEGATED_TASK_GENERIC_PROMPT);
    expect(printed.stdout).not.toContain("Outcome route:");
    expect(process.exitCode ?? 0).toBe(0);
    const decoded = decodeDelegatedTaskResult(JSON.parse(printed.stdout));
    expect(decoded.taskId).toBe("task:source-question");
    expect(decoded.fulfillment).toBe("complete");
    expect(decoded.stopReason).toBe("finished");
    expect(decoded.artifacts.map((artifact) => artifact.locator)).toEqual([
      "docs/reference.md",
      "answer",
    ]);
    expect(delegatedTaskExitIntent(decoded)).toMatchObject({ exitCode: 0, reason: "complete" });
    expect(printed.value).toMatchObject({
      fulfillment: "complete",
      stopReason: "finished",
    });
  });

  it("denies mutation without --allow-write and keeps --allow-write blocked on #758", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const activate = vi.fn(async () => ({
      status: "denied" as const,
      code: "write-activation-blocked" as const,
      message: "blocked",
      blockedOn: DELEGATED_WRITE_BLOCKED_ISSUES,
      branchReady: false as const,
      granted: {
        write: false as const,
        commit: false as const,
        push: false as const,
        mergeRequest: false as const,
        merge: false as const,
      },
    }));
    await captureIo(() =>
      handleDoCommand(
        ["--delegate", SOURCE_QUESTION, "--repo", repositoryPath, "--no-input", "--json"],
        delegatedOptions(repositoryPath, stateDirectory, {
          attemptDelegatedWriteActivation: activate,
        }),
      ),
    );
    expect(activate).not.toHaveBeenCalled();

    const runDelegatedTask = vi.fn(async () => completedReadResult());
    const denied = await captureIo(() =>
      handleDoCommand(
        [
          "--delegate",
          SOURCE_QUESTION,
          "--repo",
          repositoryPath,
          "--allow-write",
          "--no-input",
          "--json",
        ],
        delegatedOptions(repositoryPath, stateDirectory, {
          attemptDelegatedWriteActivation: activate,
          runDelegatedTask,
          taskId: "task:write-denied",
        }),
      ),
    );
    expect(activate).toHaveBeenCalledTimes(1);
    expect(runDelegatedTask).not.toHaveBeenCalled();
    expect(DELEGATED_WRITE_BLOCKED_ISSUES).toContain("#758");
    expect(process.exitCode).toBe(1);
    const decoded = decodeDelegatedTaskResult(JSON.parse(denied.stdout));
    expect(decoded.fulfillment).not.toBe("complete");
    expect(decoded.stopReason).toBe("failed");

    process.exitCode = undefined;
    const humanDenied = await captureIo(() =>
      handleDoCommand(
        ["--delegate", SOURCE_QUESTION, "--repo", repositoryPath, "--allow-write", "--no-input"],
        delegatedOptions(repositoryPath, stateDirectory, {
          attemptDelegatedWriteActivation: activate,
          runDelegatedTask,
        }),
      ),
    );
    expect(humanDenied.stdout).toContain("#758");
    expect(runDelegatedTask).not.toHaveBeenCalled();
  });

  it("pauses one essential clarification at needs-input exit 2 and resumes that exact task", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const paused = await captureIo(() =>
      handleDoCommand(
        [
          "--delegate",
          "Document docs/operators/index.md.",
          "--repo",
          repositoryPath,
          "--no-input",
          "--json",
        ],
        delegatedOptions(repositoryPath, stateDirectory, {
          taskId: "task:missing-target",
          inspectPauseDelegatedTask,
          runDelegatedTask: async () => {
            throw new Error("driver must not run when pause needs-input");
          },
        }),
      ),
    );
    expect(process.exitCode).toBe(2);
    expect(paused.stdout).not.toContain(DELEGATED_TASK_GENERIC_PROMPT);
    const pausedResult = decodeDelegatedTaskResult(JSON.parse(paused.stdout));
    expect(pausedResult.stopReason).toBe("needs-input");
    expect(pausedResult.pendingQuestionIds).toEqual(["q-target"]);
    expect(pausedResult.nextAction.command).toBe(
      "docsfab do --resume task:missing-target --answers <json-file>",
    );

    const answersPath = join(stateDirectory, "answers.json");
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(answersPath, '{"q-target":"docs/operators/"}', "utf8");
    const pausedState = await new DelegatedTaskStateStore({
      directory: join(stateDirectory, "delegated-tasks"),
    }).getExact("task:missing-target");
    expect(pausedState.phase).toBe("pending-input");
    expect(pausedState.outcome).toBe("Document docs/operators/index.md.");
    process.exitCode = undefined;
    const runDelegatedTask = vi.fn(async (input) => {
      expect(input.outcome).toContain("Document docs/operators/index.md.");
      expect(input.outcome).toContain("q-target: docs/operators/");
      expect(input.sessionLifetime).toEqual({ kind: "fresh" });
      return completedReadResult();
    });
    const resumed = await captureIo(() =>
      handleDoCommand(
        [
          "--resume",
          "task:missing-target",
          "--answers",
          answersPath,
          "--repo",
          repositoryPath,
          "--json",
        ],
        delegatedOptions(repositoryPath, stateDirectory, {
          taskId: "task:must-not-mint",
          runDelegatedTask,
        }),
      ),
    );
    expect(runDelegatedTask).toHaveBeenCalledTimes(1);
    const resumedResult = decodeDelegatedTaskResult(JSON.parse(resumed.stdout));
    expect(resumedResult.taskId).toBe("task:missing-target");
    expect(resumedResult.taskId).not.toBe("task:must-not-mint");
    expect(resumedResult.request.requestSha256).toBe(pausedState.request.requestSha256);
    expect(resumedResult.stopReason).toBe("finished");
    expect(resumedResult.fulfillment).toBe("complete");
    expect(resumed.stdout).not.toContain(DELEGATED_TASK_GENERIC_PROMPT);
    expect(delegatedTaskExitIntent(resumedResult)).toMatchObject({
      exitCode: 0,
      reason: "complete",
    });
    expect(process.exitCode ?? 0).toBe(0);
    const finished = await new DelegatedTaskStateStore({
      directory: join(stateDirectory, "delegated-tasks"),
    }).getExact("task:missing-target");
    expect(finished.phase).toBe("finished");
    expect(finished.request.requestSha256).toBe(pausedState.request.requestSha256);
    expect(finished.request.taskSha256).toBe(resumedResult.request.taskSha256);
    expect(finished.request.taskSha256).not.toBe(pausedState.request.taskSha256);
    expect(finished.sourceSha256).toBe(pausedState.sourceSha256);
    expect(finished.planSha256).not.toBe(pausedState.planSha256);
    expect(finished.outcome).toBe(pausedState.outcome);
  });

  it("rejects a mismatched retained outcome before consuming the paused task", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    await captureIo(() =>
      handleDoCommand(
        [
          "--delegate",
          "Document docs/operators/index.md.",
          "--repo",
          repositoryPath,
          "--no-input",
          "--json",
        ],
        delegatedOptions(repositoryPath, stateDirectory, {
          taskId: "task:mismatch-sidecar",
          inspectPauseDelegatedTask,
          runDelegatedTask: async () => {
            throw new Error("driver must not run when pause needs-input");
          },
        }),
      ),
    );
    const recordPath = join(
      stateDirectory,
      "delegated-tasks",
      `${delegatedTaskStoreRecordId("task:mismatch-sidecar")}.json`,
    );
    const record = JSON.parse(await readFile(recordPath, "utf8")) as { outcome: string };
    record.outcome = "tampered retained outcome";
    await writeFile(recordPath, `${JSON.stringify(record)}\n`);
    await chmod(recordPath, 0o600);
    const answersPath = join(stateDirectory, "answers.json");
    await writeFile(answersPath, '{"q-target":"docs/operators/"}', "utf8");
    const runDelegatedTask = vi.fn(async () => {
      throw new Error("driver must not run after a mismatched sidecar");
    });
    await expect(
      handleDoCommand(
        [
          "--resume",
          "task:mismatch-sidecar",
          "--answers",
          answersPath,
          "--repo",
          repositoryPath,
          "--json",
        ],
        delegatedOptions(repositoryPath, stateDirectory, { runDelegatedTask }),
      ),
    ).rejects.toMatchObject({
      name: "DelegatedResumeOperatorError",
      message:
        "Delegated resume cannot re-enter the driver because the retained outcome does not match that task.",
    });
    expect(runDelegatedTask).not.toHaveBeenCalled();
    const retained = JSON.parse(await readFile(recordPath, "utf8")) as {
      phase: string;
      outcome: string;
    };
    expect(retained.phase).toBe("pending-input");
    expect(retained.outcome).toBe("tampered retained outcome");
  });

  it("leaves the pause in place when the resumed driver throws", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    await captureIo(() =>
      handleDoCommand(
        [
          "--delegate",
          "Document docs/operators/index.md.",
          "--repo",
          repositoryPath,
          "--no-input",
          "--json",
        ],
        delegatedOptions(repositoryPath, stateDirectory, {
          taskId: "task:driver-throws",
          inspectPauseDelegatedTask,
          runDelegatedTask: async () => {
            throw new Error("driver must not run when pause needs-input");
          },
        }),
      ),
    );
    const answersPath = join(stateDirectory, "answers.json");
    await writeFile(answersPath, '{"q-target":"docs/operators/"}', "utf8");
    await expect(
      handleDoCommand(
        [
          "--resume",
          "task:driver-throws",
          "--answers",
          answersPath,
          "--repo",
          repositoryPath,
          "--json",
        ],
        delegatedOptions(repositoryPath, stateDirectory, {
          runDelegatedTask: async () => {
            throw new Error("driver failed before dispatch settled");
          },
        }),
      ),
    ).rejects.toThrow("driver failed before dispatch settled");
    const paused = await new DelegatedTaskStateStore({
      directory: join(stateDirectory, "delegated-tasks"),
    }).getExact("task:driver-throws");
    expect(paused.phase).toBe("pending-input");
    expect(paused.pendingQuestions.map((question) => question.questionId)).toEqual(["q-target"]);
  });

  it("does not mark the retained task finished when the resumed driver is cancelled", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    await captureIo(() =>
      handleDoCommand(
        [
          "--delegate",
          "Document docs/operators/index.md.",
          "--repo",
          repositoryPath,
          "--no-input",
          "--json",
        ],
        delegatedOptions(repositoryPath, stateDirectory, {
          taskId: "task:driver-cancelled",
          inspectPauseDelegatedTask,
          runDelegatedTask: async () => {
            throw new Error("driver must not run when pause needs-input");
          },
        }),
      ),
    );
    const answersPath = join(stateDirectory, "answers.json");
    await writeFile(answersPath, '{"q-target":"docs/operators/"}', "utf8");
    process.exitCode = undefined;
    const cancelled = await captureIo(() =>
      handleDoCommand(
        [
          "--resume",
          "task:driver-cancelled",
          "--answers",
          answersPath,
          "--repo",
          repositoryPath,
          "--json",
        ],
        delegatedOptions(repositoryPath, stateDirectory, {
          runDelegatedTask: async () => ({
            ...completedReadResult("partial answer"),
            status: "cancelled" as const,
            error: "Workflow cancelled.",
          }),
        }),
      ),
    );
    const cancelledResult = decodeDelegatedTaskResult(JSON.parse(cancelled.stdout));
    expect(cancelledResult.stopReason).toBe("cancelled");
    expect(cancelledResult.fulfillment).not.toBe("complete");
    const paused = await new DelegatedTaskStateStore({
      directory: join(stateDirectory, "delegated-tasks"),
    }).getExact("task:driver-cancelled");
    expect(paused.phase).toBe("pending-input");
  });

  it("does not claim complete when confined reads exist without a source-backed answer", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const printed = await captureIo(() =>
      handleDoCommand(
        ["--delegate", SOURCE_QUESTION, "--repo", repositoryPath, "--no-input", "--json"],
        delegatedOptions(repositoryPath, stateDirectory, {
          runDelegatedTask: async () => completedReadResult("   "),
        }),
      ),
    );
    const decoded = decodeDelegatedTaskResult(JSON.parse(printed.stdout));
    expect(decoded.fulfillment).not.toBe("complete");
    expect(decoded.artifacts.map((artifact) => artifact.locator)).toEqual(["docs/reference.md"]);
    expect(process.exitCode).toBe(1);
  });

  it("does not pause a review request whose path tokens include trailing punctuation", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    await writeFile(join(repositoryPath, "docs", "api.md"), "# API\n", "utf8");
    await writeFile(join(repositoryPath, "package.json"), CHECK_MANIFEST, "utf8");
    const request =
      "Review docs/api.md. Run npm test and npm run docs:check. Keep the result local.";
    const printed = await captureIo(() =>
      handleDoCommand(
        ["--delegate", request, "--repo", repositoryPath, ...CHECK_FLAGS, "--no-input", "--json"],
        delegatedOptions(repositoryPath, stateDirectory, {
          inspectPauseDelegatedTask,
          runRequestedDelegatedChecks: async () => [
            {
              checkId: "npm-run-test",
              state: "passed" as const,
              receiptSha256: "a".repeat(64),
            },
            {
              checkId: "npm-run-docs:check",
              state: "passed" as const,
              receiptSha256: "b".repeat(64),
            },
          ],
        }),
      ),
    );
    const decoded = decodeDelegatedTaskResult(JSON.parse(printed.stdout));
    expect(decoded.stopReason).not.toBe("needs-input");
    expect(decoded.checkState).toBe("passed");
    expect(decoded.fulfillment).toBe("complete");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("keeps --check checks from completing the task until bound evidence exists", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    await writeFile(join(repositoryPath, "package.json"), CHECK_MANIFEST, "utf8");
    const request = SOURCE_QUESTION;
    const missing = await captureIo(() =>
      handleDoCommand(
        ["--delegate", request, "--repo", repositoryPath, ...CHECK_FLAGS, "--no-input", "--json"],
        delegatedOptions(repositoryPath, stateDirectory, {
          runRequestedDelegatedChecks: async () => [],
        }),
      ),
    );
    const missingResult = decodeDelegatedTaskResult(JSON.parse(missing.stdout));
    expect(missingResult.checkState).toBe("not-run");
    expect(missingResult.fulfillment).not.toBe("complete");
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    const bound = await captureIo(() =>
      handleDoCommand(
        ["--delegate", request, "--repo", repositoryPath, ...CHECK_FLAGS, "--no-input", "--json"],
        delegatedOptions(repositoryPath, stateDirectory, {
          runRequestedDelegatedChecks: async () => [
            {
              checkId: "npm-run-test",
              state: "passed" as const,
              receiptSha256: "a".repeat(64),
            },
            {
              checkId: "npm-run-docs:check",
              state: "passed" as const,
              receiptSha256: "b".repeat(64),
            },
          ],
        }),
      ),
    );
    const boundResult = decodeDelegatedTaskResult(JSON.parse(bound.stdout));
    expect(boundResult.checkState).toBe("passed");
    expect(boundResult.fulfillment).toBe("complete");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("projects cancelled and budget-exhausted terminals as typed nonzero incomplete results", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const cancelled = await captureIo(() =>
      handleDoCommand(
        ["--delegate", SOURCE_QUESTION, "--repo", repositoryPath, "--no-input", "--json"],
        delegatedOptions(repositoryPath, stateDirectory, {
          runDelegatedTask: async () => ({
            ...completedReadResult("partial answer"),
            status: "cancelled",
            error: "Workflow cancelled.",
          }),
        }),
      ),
    );
    const cancelledResult = decodeDelegatedTaskResult(JSON.parse(cancelled.stdout));
    expect(cancelledResult.stopReason).toBe("cancelled");
    expect(cancelledResult.fulfillment).not.toBe("complete");
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    const exhausted = await captureIo(() =>
      handleDoCommand(
        ["--delegate", SOURCE_QUESTION, "--repo", repositoryPath, "--no-input", "--json"],
        delegatedOptions(repositoryPath, stateDirectory, {
          runDelegatedTask: async () => ({
            kind: "docsfab-delegated-task-result",
            status: "failed",
            answer: "",
            transcript: [],
            childWorkflows: [],
            error: "the delegated task failed",
            // Only a bound that ended the run is exhaustion, decided by the
            // typed stop rather than the words in `error`.
            limitStop: {
              limit: "delegatedTask.maxProviderTurns",
              unit: "turns",
              disposition: "stopped",
              configured: 24,
              observed: 25,
              remediation: "Raise the delegated task execution envelope for this run.",
            },
          }),
        }),
      ),
    );
    const exhaustedResult = decodeDelegatedTaskResult(JSON.parse(exhausted.stdout));
    expect(exhaustedResult.stopReason).toBe("budget-exhausted");
    expect(process.exitCode).toBe(1);
  });

  it("refuses to promote a plain failure to a limit stop on the strength of its wording", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const printed = await captureIo(() =>
      handleDoCommand(
        ["--delegate", SOURCE_QUESTION, "--repo", repositoryPath, "--no-input", "--json"],
        delegatedOptions(repositoryPath, stateDirectory, {
          runDelegatedTask: async () => ({
            kind: "docsfab-delegated-task-result",
            status: "failed",
            answer: "",
            transcript: [],
            childWorkflows: [],
            // Limit-sounding words in `error`, and no typed limit at all.
            error: "budget token limit maxProviderTurns maxToolCalls timeout",
          }),
        }),
      ),
    );
    const result = decodeDelegatedTaskResult(JSON.parse(printed.stdout));
    expect(result.stopReason).toBe("failed");
    expect(process.exitCode).toBe(1);
  });

  it("refuses to promote a crash to a limit stop because a tool-call clip rode along", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const printed = await captureIo(() =>
      handleDoCommand(
        ["--delegate", SOURCE_QUESTION, "--repo", repositoryPath, "--no-input", "--json"],
        delegatedOptions(repositoryPath, stateDirectory, {
          runDelegatedTask: async () => ({
            kind: "docsfab-delegated-task-result",
            status: "failed",
            answer: "",
            transcript: [],
            childWorkflows: [],
            // A genuine defect with an orthogonal clip flag: the confined ceiling
            // refused a call, the session carried on, then something unrelated
            // crashed. This is not budget exhaustion.
            error: "TypeError: Cannot read properties of undefined (reading 'id')",
            limitStop: {
              limit: "delegatedTask.maxToolCalls",
              unit: "calls",
              disposition: "clipped",
              configured: 8,
              observed: 9,
              remediation: "Raise the delegated task tool-call limit for this run.",
            },
          }),
        }),
      ),
    );
    const result = decodeDelegatedTaskResult(JSON.parse(printed.stdout));
    expect(result.stopReason).toBe("failed");
    expect(result.stopReason).not.toBe("budget-exhausted");
    expect(result.nextAction.code).toBe("inspect-failure");
    expect(delegatedTaskExitIntent(result)).toEqual({ exitCode: 1, reason: "failed" });
    // The clip is still reported, because work really was dropped.
    expect(printed.stderr).toContain("delegatedTask.maxToolCalls");
    expect(process.exitCode).toBe(1);
  });

  it("reports a completed run that was clipped as finished, and says the run continued", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const printed = await captureIo(() =>
      handleDoCommand(
        ["--delegate", SOURCE_QUESTION, "--repo", repositoryPath, "--no-input"],
        delegatedOptions(repositoryPath, stateDirectory, {
          runDelegatedTask: async () => ({
            ...completedReadResult(),
            limitStop: {
              limit: "delegatedTask.maxToolCalls",
              unit: "calls" as const,
              disposition: "clipped" as const,
              configured: 8,
              observed: 9,
              remediation: "Raise the delegated task tool-call limit for this run.",
            },
          }),
        }),
      ),
    );
    expect(printed.stdout).toContain("Stop reason: finished");
    expect(printed.stdout).toContain(
      "DocsFab continued with work clipped at the operational limit delegatedTask.maxToolCalls (limit 8 calls, attempted 9 calls).",
    );
    // The terminal must not say both that the run completed and that DocsFab
    // stopped it at a limit.
    expect(printed.stdout).not.toContain("DocsFab stopped this run");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("renders a wall-clock deadline as its own stop reason with the limit named on the terminal", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const limitStop = {
      limit: "delegatedTask.timeoutMs",
      unit: "ms" as const,
      disposition: "stopped" as const,
      configured: 1_800_000,
      observed: 1_800_004,
      remediation: "Raise the delegated task wall-clock limit for this run.",
    };
    const timedOut = {
      kind: "docsfab-delegated-task-result" as const,
      status: "timed-out" as const,
      answer: "",
      transcript: [],
      childWorkflows: [],
      error: "DocsFab stopped at the operational limit delegatedTask.timeoutMs",
      limitStop,
    };
    const human = await captureIo(() =>
      handleDoCommand(
        ["--delegate", SOURCE_QUESTION, "--repo", repositoryPath, "--no-input"],
        delegatedOptions(repositoryPath, stateDirectory, {
          runDelegatedTask: async () => timedOut,
        }),
      ),
    );
    expect(human.stdout).toContain("Stop reason: deadline-exceeded");
    expect(human.stdout).not.toContain("Stop reason: cancelled");
    expect(human.stdout).toContain(
      "DocsFab stopped this run at the operational limit delegatedTask.timeoutMs (limit 1800000 ms, observed 1800004 ms).",
    );
    expect(human.stdout).toContain(limitStop.remediation);
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    const json = await captureIo(() =>
      handleDoCommand(
        ["--delegate", SOURCE_QUESTION, "--repo", repositoryPath, "--no-input", "--json"],
        delegatedOptions(repositoryPath, stateDirectory, {
          runDelegatedTask: async () => timedOut,
        }),
      ),
    );
    const decoded = decodeDelegatedTaskResult(JSON.parse(json.stdout));
    expect(decoded.stopReason).toBe("deadline-exceeded");
    expect(delegatedTaskExitIntent(decoded)).toEqual({
      exitCode: 1,
      reason: "deadline-exceeded",
    });
    expect(decoded.nextAction.code).toBe("inspect-partial");
    // Canonical stdout stays exactly the document; the limit reaches the
    // operator on stderr rather than being dropped in JSON mode.
    expect(json.stderr).toContain("delegatedTask.timeoutMs");
  });

  it("rejects a composition selection before the delegated driver runs", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const runDelegatedTask = vi.fn(async () => completedReadResult());
    await expect(
      handleDoCommand(
        [
          "--delegate",
          SOURCE_QUESTION,
          "--repo",
          repositoryPath,
          "--composition",
          "openai-gpt-5.6-sol-pi",
          "--no-input",
        ],
        delegatedOptions(repositoryPath, stateDirectory, {
          runDelegatedTask,
          inspectDelegatedWorkspaceBasis: async () => {
            throw new Error("workspace basis must not run");
          },
        }),
      ),
    ).rejects.toThrow(DELEGATED_TASK_UNSUPPORTED_HOST);
    expect(runDelegatedTask).not.toHaveBeenCalled();
  });

  it("shares task identity fields across JSON, quiet, and default output", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const args = (flags: string[]) => [
      "--delegate",
      SOURCE_QUESTION,
      "--repo",
      repositoryPath,
      "--no-input",
      ...flags,
    ];
    const jsonPrinted = await captureIo(() =>
      handleDoCommand(
        args(["--json"]),
        delegatedOptions(repositoryPath, stateDirectory, { taskId: "task:shared-fields" }),
      ),
    );
    process.exitCode = undefined;
    const quietPrinted = await captureIo(() =>
      handleDoCommand(
        args(["--quiet"]),
        delegatedOptions(repositoryPath, stateDirectory, { taskId: "task:shared-fields" }),
      ),
    );
    process.exitCode = undefined;
    const humanPrinted = await captureIo(() =>
      handleDoCommand(
        args([]),
        delegatedOptions(repositoryPath, stateDirectory, { taskId: "task:shared-fields" }),
      ),
    );
    const decoded = decodeDelegatedTaskResult(JSON.parse(jsonPrinted.stdout));
    for (const text of [quietPrinted.stdout, humanPrinted.stdout]) {
      expect(text).toContain(decoded.taskId);
      expect(text).toContain(`Fulfillment: ${decoded.fulfillment}`);
      expect(text).toContain(`Stop reason: ${decoded.stopReason}`);
      expect(text).toContain(`Delivery: ${decoded.deliveryState}`);
      expect(text).toContain(`Next action: ${decoded.nextAction.code}`);
      expect(text).not.toContain(DELEGATED_TASK_GENERIC_PROMPT);
    }
    expect(humanPrinted.stdout).toContain("The JSON output flag is --json");
  });

  it("writes a complete quiet human result through the output coordinator and leaves JSON canonical", async () => {
    const { repositoryPath, stateDirectory } = await fixture();
    const writes: Array<{ stream: string; message: string }> = [];
    const outputCoordinator: OperatorOutputCoordinator = {
      writeMessage(stream, message) {
        writes.push({ stream, message });
      },
      startProgress: () => ({ id: Symbol("test-progress") }),
      updateProgress() {},
      finalizeProgress() {},
      dispose() {},
    };
    const args = (flags: string[]) => [
      "--delegate",
      SOURCE_QUESTION,
      "--repo",
      repositoryPath,
      "--no-input",
      ...flags,
    ];
    await handleDoCommand(
      args(["--quiet"]),
      delegatedOptions(repositoryPath, stateDirectory, {
        taskId: "task:coordinated-output",
        outputCoordinator,
      }),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.stream).toBe("stdout");
    expect(writes[0]?.message).toContain("Fulfillment: complete");
    expect(writes[0]?.message).not.toContain("The JSON output flag is --json");

    process.exitCode = undefined;
    writes.length = 0;
    const json = await captureIo(() =>
      handleDoCommand(
        args(["--json"]),
        delegatedOptions(repositoryPath, stateDirectory, {
          taskId: "task:coordinated-output",
          outputCoordinator,
        }),
      ),
    );
    expect(writes).toHaveLength(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ taskId: "task:coordinated-output" });
  });

  it("keeps catalog do parsing unchanged beside the delegated pilot", () => {
    expect(
      parseDoArguments([SOURCE_QUESTION, "--repo", "/tmp/repo", "--route-only"]),
    ).toMatchObject({
      delegate: false,
      routeOnly: true,
      request: SOURCE_QUESTION,
    });
  });
});
