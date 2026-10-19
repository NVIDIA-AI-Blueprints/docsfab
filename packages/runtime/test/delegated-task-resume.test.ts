// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  inspectPauseDelegatedTask,
  resumeDelegatedTask,
  createDelegatedRequest,
  createDelegatedRequirement,
  DELEGATED_TASK_WRITE_RESUME_REMAINDER,
  DelegatedTaskContinuationError,
} from "../src/delegated-task/continuation.js";
import { DelegatedTaskQuestionError } from "../src/delegated-task/question-contract.js";
import { DELEGATED_TASK_STATE_MAX_BYTES } from "../src/contract-kit/decode-bounds.js";
import {
  DelegatedTaskStateError,
  DelegatedTaskStateStore,
  DELEGATED_TASK_GENERIC_PROMPT,
  DELEGATED_TASK_STATE_KIND,
  decodeDelegatedTaskState,
  delegatedTaskStoreRecordId,
} from "../src/delegated-task/task-state.js";
import { temporaryRoots } from "./helpers/temp.js";

const directories = temporaryRoots();
const REVISION = "a".repeat(40);
const NOW = () => new Date("2026-09-17T15:00:00.000Z");

async function fixture(): Promise<{
  repositoryPath: string;
  storeDirectory: string;
  otherRepo: string;
}> {
  const root = await directories.create("docsfab-delegated-resume-");
  const repositoryPath = join(root, "repo");
  const otherRepo = join(root, "other");
  await mkdir(join(repositoryPath, "docs"), { recursive: true });
  await mkdir(otherRepo, { recursive: true });
  await writeFile(join(repositoryPath, "README.md"), "operators live under docs/operators/\n");
  await writeFile(join(otherRepo, "README.md"), "unrelated\n");
  return { repositoryPath, storeDirectory: join(root, "state"), otherRepo };
}

function reqs() {
  return [createDelegatedRequirement("R1", "artifact", "docs/operators/index.md")];
}

async function pauseTask(
  repositoryPath: string,
  storeDirectory: string,
  taskId = "task:missing-target",
) {
  const originalRequirements = reqs();
  const paused = await inspectPauseDelegatedTask({
    taskId,
    ownerId: "owner-alice",
    outcome: "Document the operators directory.",
    request: createDelegatedRequest(originalRequirements),
    repositoryPath,
    repositoryRevision: REVISION,
    admittedLocators: ["README.md"],
    materialTargetLocator: "docs/operators/index.md",
    originalRequirements,
    inputMode: "json",
    currentAuthority: { read: true, write: false, check: false },
    storeDirectory,
    now: NOW,
  });
  if (paused.status !== "needs-input") throw new Error("expected needs-input pause");
  return paused;
}

describe("delegated-task resume", () => {
  it("resumes only the exact retained task from answers.json with q-target", async () => {
    const { repositoryPath, storeDirectory } = await fixture();
    const paused = await pauseTask(repositoryPath, storeDirectory);
    const provider = vi.fn(async () => {
      throw new Error("provider must not run");
    });
    const resumed = await resumeDelegatedTask({
      taskId: "task:missing-target",
      ownerId: "owner-alice",
      repositoryPath,
      repositoryRevision: REVISION,
      answersJson: '{"q-target":"docs/operators/"}',
      freshAuthority: { read: true, write: false, check: false },
      storeDirectory,
      executors: { provider },
      now: NOW,
    }).catch((error: unknown) => error);
    expect(resumed).toMatchObject({ status: "resumed" });
    expect(provider).not.toHaveBeenCalled();
    if (resumed instanceof Error) throw resumed;
    if (resumed.status !== "resumed") throw new Error("expected resumed");
    expect(resumed.state.taskId).toBe("task:missing-target");
    expect(resumed.state.pendingQuestions).toEqual([]);
    expect(resumed.state.settledQuestionIds).toEqual(["q-target"]);
    expect(resumed.genericPrompt).toBe(false);
    const stored = await new DelegatedTaskStateStore({ directory: storeDirectory }).getExact(
      "task:missing-target",
    );
    expect(stored.stateSha256).toBe(resumed.state.stateSha256);
  });

  it("defers the finished write until the caller commits the retained identity", async () => {
    const { repositoryPath, storeDirectory } = await fixture();
    await pauseTask(repositoryPath, storeDirectory);
    const resumed = await resumeDelegatedTask({
      taskId: "task:missing-target",
      ownerId: "owner-alice",
      repositoryPath,
      repositoryRevision: REVISION,
      answersJson: '{"q-target":"docs/operators/"}',
      freshAuthority: { read: true, write: false, check: false },
      storeDirectory,
      now: NOW,
      commit: "defer",
    });
    if (resumed.status !== "resumed") throw new Error("expected resumed");
    const store = new DelegatedTaskStateStore({ directory: storeDirectory });
    const paused = await store.readExact("task:missing-target");
    expect(paused.state.phase).toBe("pending-input");
    expect(paused.byteSha256).toBe(resumed.recordByteSha256);
    await expect(store.save(resumed.state, "0".repeat(64))).rejects.toBeInstanceOf(
      DelegatedTaskStateError,
    );
    const untouched = await store.getExact("task:missing-target");
    expect(untouched.phase).toBe("pending-input");
    await store.save(resumed.state, resumed.recordByteSha256);
    const committed = await store.getExact("task:missing-target");
    expect(committed.phase).toBe("finished");
    expect(committed.request).toEqual(paused.state.request);
    expect(committed.sourceSha256).toBe(paused.state.sourceSha256);
    expect(committed.planSha256).toBe(paused.state.planSha256);
    expect(committed.outcome).toBe(paused.state.outcome);
    expect(committed.outcomeSha256).toBe(paused.state.outcomeSha256);
  });

  it("rejects missing, extra, stale, duplicate, malformed, blank, wrong-task, wrong-owner, symlink, digest, and permission failures before provider work", async () => {
    const { repositoryPath, storeDirectory, otherRepo } = await fixture();
    await pauseTask(repositoryPath, storeDirectory);
    const provider = vi.fn(async () => {
      throw new Error("provider must not run");
    });
    const attempt = (overrides: Record<string, unknown>) =>
      resumeDelegatedTask({
        taskId: "task:missing-target",
        ownerId: "owner-alice",
        repositoryPath,
        repositoryRevision: REVISION,
        answersJson: '{"q-target":"docs/operators/"}',
        freshAuthority: { read: true, write: false, check: false },
        storeDirectory,
        executors: { provider },
        now: NOW,
        ...overrides,
      });

    await expect(attempt({ answersJson: "{}" })).rejects.toBeInstanceOf(DelegatedTaskQuestionError);
    await expect(attempt({ answersJson: '{"q-other":"docs/operators/"}' })).rejects.toMatchObject({
      code: "extra-answer",
    });
    await expect(
      attempt({ answersJson: '{"q-target":"docs/operators/","q-old":"x"}' }),
    ).rejects.toMatchObject({ code: "extra-answer" });
    await expect(
      attempt({ answersJson: '{"q-target":"docs/operators/","q-target":"docs/other/"}' }),
    ).rejects.toMatchObject({ code: "duplicate-answer-key" });
    await expect(attempt({ answersJson: "{" })).rejects.toMatchObject({
      code: "malformed-answers",
    });
    await expect(attempt({ answersJson: '{"q-target":""}' })).rejects.toMatchObject({
      code: "blank-answer",
    });
    await expect(attempt({ taskId: "task:other" })).rejects.toBeInstanceOf(DelegatedTaskStateError);
    await expect(attempt({ ownerId: "owner-bob" })).rejects.toMatchObject({
      code: "owner-mismatch",
    });
    await expect(attempt({ repositoryRevision: "b".repeat(40) })).rejects.toMatchObject({
      code: "identity-mismatch",
    });
    await expect(attempt({ planSha256: "c".repeat(64) })).rejects.toMatchObject({
      code: "identity-mismatch",
    });
    await expect(
      attempt({ freshAuthority: { read: false, write: false, check: false } }),
    ).rejects.toMatchObject({ code: "permission-changed" });

    const link = join(storeDirectory, "..", "alias");
    await symlink(otherRepo, link);
    await expect(attempt({ repositoryPath: link })).rejects.toMatchObject({
      code: "repository-mismatch",
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it("keeps lookup errors free of prompts, answers, source bodies, credentials, and paths", async () => {
    const { repositoryPath, storeDirectory } = await fixture();
    await pauseTask(repositoryPath, storeDirectory);
    try {
      await resumeDelegatedTask({
        taskId: "task:missing-target",
        ownerId: "owner-bob",
        repositoryPath,
        repositoryRevision: REVISION,
        answersJson: '{"q-target":"docs/operators/secret-token"}',
        freshAuthority: { read: true, write: false, check: false },
        storeDirectory,
        now: NOW,
      });
      throw new Error("expected owner-mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(DelegatedTaskStateError);
      const message = String(error);
      expect(message).not.toContain("docs/operators/secret-token");
      expect(message).not.toContain(repositoryPath);
      expect(message).not.toContain("README.md");
      expect(message).not.toContain(DELEGATED_TASK_GENERIC_PROMPT);
      expect(message).not.toContain("owner-bob");
    }
  });

  it("supplies fresh current authority and ignores prior write grants, session messages, and stored descriptors", async () => {
    const { repositoryPath, storeDirectory } = await fixture();
    await pauseTask(repositoryPath, storeDirectory);
    const blocked = await resumeDelegatedTask({
      taskId: "task:missing-target",
      ownerId: "owner-alice",
      repositoryPath,
      repositoryRevision: REVISION,
      answersJson: '{"q-target":"--allow-write docs/operators/"}',
      freshAuthority: { read: true, write: true, check: false },
      storeDirectory,
      now: NOW,
    });
    expect(blocked.status).toBe("blocked-write-resume");
    if (blocked.status !== "blocked-write-resume") throw new Error("expected blocked write");
    expect(blocked.nextRecipe).toBe("#877");
    expect(DELEGATED_TASK_WRITE_RESUME_REMAINDER.cells).toContain("write-resume-after-pause");

    const resumed = await resumeDelegatedTask({
      taskId: "task:missing-target",
      ownerId: "owner-alice",
      repositoryPath,
      repositoryRevision: REVISION,
      answersJson: '{"q-target":"docs/operators/"}',
      freshAuthority: { read: true, write: false, check: false },
      storeDirectory,
      now: NOW,
    });
    expect(resumed.status).toBe("resumed");
    if (resumed.status !== "resumed") throw new Error("expected resumed");
    expect(resumed.state.storedAuthorityDescriptor).toEqual({
      read: true,
      write: false,
      check: false,
    });
  });

  it("reports unsupported recovery when an active tool is interrupted", async () => {
    const { repositoryPath, storeDirectory } = await fixture();
    const paused = await inspectPauseDelegatedTask({
      taskId: "task:active-tool",
      ownerId: "owner-alice",
      outcome: "Document the operators directory.",
      request: createDelegatedRequest(reqs()),
      repositoryPath,
      repositoryRevision: REVISION,
      admittedLocators: ["README.md"],
      materialTargetLocator: "docs/operators/index.md",
      originalRequirements: reqs(),
      inputMode: "non-tty",
      currentAuthority: { read: true, write: false, check: false },
      storeDirectory,
      activeTool: true,
      now: NOW,
    });
    expect(paused).toEqual({
      status: "recovery-required",
      code: "unsupported-recovery",
      genericPrompt: false,
    });
    expect(paused).not.toHaveProperty("result");
  });

  it("does not claim automatic active-tool resume after a stored recovery-required phase", async () => {
    expect(new DelegatedTaskContinuationError("unsupported-recovery").code).toBe(
      "unsupported-recovery",
    );
  });

  it("refuses a historic v1 record that stored a digest without outcome bytes", () => {
    expect(() =>
      decodeDelegatedTaskState({
        schemaVersion: 1,
        kind: DELEGATED_TASK_STATE_KIND,
        outcomeSha256: "ab".repeat(32),
      }),
    ).toThrow(expect.objectContaining({ code: "migration-required" }));
  });

  it("refuses a task record above the configured state-byte bound before decode", async () => {
    const { repositoryPath, storeDirectory } = await fixture();
    await pauseTask(repositoryPath, storeDirectory);
    const recordId = delegatedTaskStoreRecordId("task:missing-target");
    await writeFile(
      join(storeDirectory, `${recordId}.json`),
      Buffer.alloc(DELEGATED_TASK_STATE_MAX_BYTES + 1, 0x61),
    );
    const store = new DelegatedTaskStateStore({ directory: storeDirectory });
    await expect(store.readExact("task:missing-target")).rejects.toMatchObject({
      code: "bounds-exceeded",
    });
  });
});
