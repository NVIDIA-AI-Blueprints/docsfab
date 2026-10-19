// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  inspectPauseDelegatedTask,
  createDelegatedRequest,
  createDelegatedRequirement,
  DELEGATED_TASK_INPUT_MODES,
  DELEGATED_TASK_WRITE_RESUME_REMAINDER,
} from "../src/delegated-task/continuation.js";
import {
  createDelegatedTaskQuestionBatch,
  decodeDelegatedTaskAnswers,
  DelegatedTaskQuestionError,
  DELEGATED_TASK_MISSING_TARGET_QUESTION_ID,
  DELEGATED_TASK_RESUME_ANSWERS_COMMAND,
  selectEssentialDelegatedQuestions,
  type DelegatedTaskQuestionCandidateV1,
} from "../src/delegated-task/question-contract.js";
import { DELEGATED_TASK_GENERIC_PROMPT } from "../src/delegated-task/task-state.js";
import { temporaryRoots } from "./helpers/temp.js";

const directories = temporaryRoots();
const REVISION = "a".repeat(40);
const NOW = () => new Date("2026-09-17T15:00:00.000Z");

async function fixture(options: { operators?: boolean } = {}): Promise<{
  repositoryPath: string;
  storeDirectory: string;
}> {
  const root = await directories.create("docsfab-delegated-pause-");
  const repositoryPath = join(root, "repo");
  await mkdir(join(repositoryPath, "docs"), { recursive: true });
  await writeFile(join(repositoryPath, "README.md"), "operators live under docs/operators/\n");
  if (options.operators) {
    await mkdir(join(repositoryPath, "docs", "operators"), { recursive: true });
    await writeFile(join(repositoryPath, "docs", "operators", "index.md"), "# Operators\n");
  }
  return { repositoryPath, storeDirectory: join(root, "state") };
}

function requirements() {
  return [createDelegatedRequirement("R1", "artifact", "docs/operators/index.md")];
}

function candidate(
  questionId: string,
  disposition: DelegatedTaskQuestionCandidateV1["disposition"],
  clarificationKind: DelegatedTaskQuestionCandidateV1["clarificationKind"] = "missing-outcome-or-target",
  prompt = "What documentation target path should this delegated task produce?",
  reason = "The original outcome cannot finish without this identified target.",
): DelegatedTaskQuestionCandidateV1 {
  return { questionId, clarificationKind, disposition, prompt, reason };
}

describe("delegated-task question pause", () => {
  it("finishes a source-complete fixture without a question after inspecting admitted sources", async () => {
    const { repositoryPath, storeDirectory } = await fixture({ operators: true });
    const reqs = requirements();
    const paused = await inspectPauseDelegatedTask({
      taskId: "task:source-complete",
      ownerId: "owner-alice",
      outcome: "Document the operators directory.",
      request: createDelegatedRequest(reqs),
      repositoryPath,
      repositoryRevision: REVISION,
      admittedLocators: ["README.md", "docs/operators/index.md"],
      materialTargetLocator: "docs/operators/index.md",
      originalRequirements: reqs,
      inputMode: "non-tty",
      currentAuthority: { read: true, write: false, check: false },
      storeDirectory,
      now: NOW,
    });
    expect(paused.status).toBe("finished");
    if (paused.status !== "finished") throw new Error("expected finished");
    expect(paused.genericPrompt).toBe(false);
    expect(paused.result.stopReason).toBe("finished");
    expect(paused.result.pendingQuestionIds).toEqual([]);
    expect(paused.completedReads.map((read) => read.locator)).toEqual([
      "README.md",
      "docs/operators/index.md",
    ]);
    expect(JSON.stringify(paused)).not.toContain(DELEGATED_TASK_GENERIC_PROMPT);
  });

  it("inspects available sources first then emits exactly one stable q-target question", async () => {
    const { repositoryPath, storeDirectory } = await fixture();
    const reqs = requirements();
    const paused = await inspectPauseDelegatedTask({
      taskId: "task:missing-target",
      ownerId: "owner-alice",
      outcome: "Document the operators directory.",
      request: createDelegatedRequest(reqs),
      repositoryPath,
      repositoryRevision: REVISION,
      admittedLocators: ["README.md"],
      materialTargetLocator: "docs/operators/index.md",
      originalRequirements: reqs,
      inputMode: "non-tty",
      currentAuthority: { read: true, write: false, check: false },
      storeDirectory,
      now: NOW,
    });
    expect(paused.status).toBe("needs-input");
    if (paused.status !== "needs-input") throw new Error("expected needs-input");
    expect(paused.batch.questions).toHaveLength(1);
    expect(paused.batch.questions[0]?.questionId).toBe(DELEGATED_TASK_MISSING_TARGET_QUESTION_ID);
    expect(paused.batch.questions[0]?.reason).toMatch(/inspecting admitted sources/u);
    expect(paused.batch.completedReads.map((read) => read.locator)).toEqual(["README.md"]);
    expect(paused.batch.completedReads.length).toBeGreaterThan(0);
    expect(paused.batch.resumeCommand).toBe(
      DELEGATED_TASK_RESUME_ANSWERS_COMMAND("task:missing-target"),
    );
    expect(paused.result.fulfillment === "partial" || paused.result.fulfillment === "none").toBe(
      true,
    );
    expect(paused.result.stopReason).toBe("needs-input");
    expect(paused.result.nextAction.command).toBe(paused.batch.resumeCommand);
    expect(paused.genericPrompt).toBe(false);
    expect(JSON.stringify(paused.batch)).not.toContain(DELEGATED_TASK_GENERIC_PROMPT);
  });

  it("reduces four candidates to at most three essential questions and never emits implementation-detail or skill IDs", () => {
    const selected = selectEssentialDelegatedQuestions([
      candidate("q-target", "essential"),
      candidate(
        "q-impl",
        "implementation-detail",
        "missing-outcome-or-target",
        "Which helper should rewrite the module filename?",
        "This is an implementation detail about an internal function.",
      ),
      candidate(
        "q-skill",
        "skill-or-workflow-id",
        "missing-outcome-or-target",
        "Which skill identifier should the task load?",
        "The user should not name a skill id.",
      ),
      candidate(
        "q-workflow",
        "skill-or-workflow-id",
        "unavailable-authority",
        "Which workflow id should continue this job?",
        "The user should not name a workflow identifier.",
      ),
    ]);
    expect(selected.map((question) => question.questionId)).toEqual(["q-target"]);
    expect(JSON.stringify(selected)).not.toMatch(
      /skill identifier|workflow id|implementation detail/u,
    );

    const fourEssential = selectEssentialDelegatedQuestions([
      candidate("q-auth", "essential", "unavailable-authority"),
      candidate("q-conflict", "essential", "contradictory-product-fact"),
      candidate("q-extra", "essential"),
      candidate("q-target", "essential"),
    ]);
    expect(fourEssential).toHaveLength(3);
    expect(fourEssential.map((question) => question.questionId)).toEqual([
      "q-auth",
      "q-conflict",
      "q-extra",
    ]);
  });

  it("persists the same pending task state for non-TTY, --no-input, JSON, and end-of-input", async () => {
    const { repositoryPath, storeDirectory } = await fixture();
    const reqs = requirements();
    const digests = [];
    for (const inputMode of DELEGATED_TASK_INPUT_MODES.filter((mode) => mode !== "interactive")) {
      const paused = await inspectPauseDelegatedTask({
        taskId: `task:${inputMode}`,
        ownerId: "owner-alice",
        outcome: "Document the operators directory.",
        request: createDelegatedRequest(reqs, inputMode),
        repositoryPath,
        repositoryRevision: REVISION,
        admittedLocators: ["README.md"],
        materialTargetLocator: "docs/operators/index.md",
        originalRequirements: reqs,
        inputMode,
        currentAuthority: { read: true, write: false, check: false },
        storeDirectory,
        now: NOW,
      });
      expect(paused.status).toBe("needs-input");
      if (paused.status !== "needs-input") throw new Error("expected needs-input");
      expect(paused.result.stopReason).toBe("needs-input");
      expect(["partial", "none"]).toContain(paused.result.fulfillment);
      expect(paused.genericPrompt).toBe(false);
      expect(paused.result.nextAction.command).not.toContain(DELEGATED_TASK_GENERIC_PROMPT);
      digests.push({
        questions: paused.batch.questions.map((question) => question.questionId),
        reads: paused.batch.completedReads.map((read) => read.locator),
        stopReason: paused.result.stopReason,
        fulfillment: paused.result.fulfillment,
      });
    }
    expect(new Set(digests.map((item) => JSON.stringify(item))).size).toBe(1);
  });

  it("returns focused questions to an interactive adapter without a generic You: prompt", async () => {
    const { repositoryPath, storeDirectory } = await fixture();
    const reqs = requirements();
    const paused = await inspectPauseDelegatedTask({
      taskId: "task:interactive",
      ownerId: "owner-alice",
      outcome: "Document the operators directory.",
      request: createDelegatedRequest(reqs, "interactive"),
      repositoryPath,
      repositoryRevision: REVISION,
      admittedLocators: ["README.md"],
      materialTargetLocator: "docs/operators/index.md",
      originalRequirements: reqs,
      inputMode: "interactive",
      currentAuthority: { read: true, write: false, check: false },
      storeDirectory,
      now: NOW,
    });
    expect(paused.status).toBe("needs-input");
    if (paused.status !== "needs-input") throw new Error("expected needs-input");
    expect(paused.batch.questions[0]?.questionId).toBe("q-target");
    expect(JSON.stringify(paused)).not.toContain("You:");
  });

  it("rejects malformed, extra, missing, duplicate, stale, blank, and already-settled answers", () => {
    const pending = ["q-target"];
    expect(() =>
      decodeDelegatedTaskAnswers({ bytes: "{", taskId: "task:1", pendingQuestionIds: pending }),
    ).toThrow(DelegatedTaskQuestionError);
    expect(() =>
      decodeDelegatedTaskAnswers({
        bytes: '{"q-target":"docs/operators/","q-target":"docs/other/"}',
        taskId: "task:1",
        pendingQuestionIds: pending,
      }),
    ).toThrow(/duplicate-answer-key/u);
    expect(() =>
      decodeDelegatedTaskAnswers({
        bytes: '{"q-other":"docs/operators/"}',
        taskId: "task:1",
        pendingQuestionIds: pending,
      }),
    ).toThrow(/extra-answer/u);
    expect(() =>
      decodeDelegatedTaskAnswers({ bytes: "{}", taskId: "task:1", pendingQuestionIds: pending }),
    ).toThrow(/missing-answer/u);
    expect(() =>
      decodeDelegatedTaskAnswers({
        bytes: '{"q-old":"docs/operators/"}',
        taskId: "task:1",
        pendingQuestionIds: pending,
        issuedQuestionIds: ["q-target", "q-old"],
      }),
    ).toThrow(/stale-answer/u);
    expect(() =>
      decodeDelegatedTaskAnswers({
        bytes: '{"q-target":""}',
        taskId: "task:1",
        pendingQuestionIds: pending,
      }),
    ).toThrow(/blank-answer/u);
    expect(() =>
      decodeDelegatedTaskAnswers({
        bytes: '{"q-target":"docs/operators/"}',
        taskId: "task:1",
        pendingQuestionIds: [],
        settledQuestionIds: ["q-target"],
        issuedQuestionIds: ["q-target"],
      }),
    ).toThrow(/already-settled-answer/u);
  });

  it("seals a question batch with the exact resume command and retained completed reads", () => {
    const batch = createDelegatedTaskQuestionBatch({
      taskId: "task:missing-target",
      questions: [
        {
          questionId: "q-target",
          clarificationKind: "missing-outcome-or-target",
          prompt: "What documentation target path should this delegated task produce?",
          reason:
            "The requested documentation target is missing after inspecting admitted sources.",
        },
      ],
      completedReads: [{ locator: "README.md", digestSha256: "b".repeat(64) }],
      resumeCommand: DELEGATED_TASK_RESUME_ANSWERS_COMMAND("task:missing-target"),
    });
    expect(batch.kind).toBe("docsfab-delegated-task-question-batch");
    expect(batch.resumeCommand).toContain("--resume task:missing-target");
    expect(DELEGATED_TASK_WRITE_RESUME_REMAINDER.nextRecipe).toBe("#877");
  });
});
