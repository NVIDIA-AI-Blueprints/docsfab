// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  continueKnowledgeChild,
  createDelegatedRequest,
  createDelegatedRequirement,
  DELEGATED_TASK_WRITE_RESUME_REMAINDER,
  inspectPauseDelegatedTask,
  resumeDelegatedTask,
  type DelegatedTaskCheckDefinitionV1,
} from "../src/delegated-task/continuation.js";
import { createKnowledgeContinuationReceipt } from "../src/records/knowledge-continuation.js";
import { delegatedTaskStateContractKit } from "../src/delegated-task/task-state.js";
import { temporaryRoots } from "./helpers/temp.js";

const directories = temporaryRoots();
const REVISION = "a".repeat(40);
const HASH = (label: string) => delegatedTaskStateContractKit.canonicalDigest(label);
const NOW = () => new Date("2026-09-17T15:00:00.000Z");

async function fixture(): Promise<{ repositoryPath: string; storeDirectory: string }> {
  const root = await directories.create("docsfab-delegated-noreplay-");
  const repositoryPath = join(root, "repo");
  await mkdir(join(repositoryPath, "docs"), { recursive: true });
  await writeFile(join(repositoryPath, "README.md"), "operators live under docs/operators/\n");
  return { repositoryPath, storeDirectory: join(root, "state") };
}

function knowledgeReceipt() {
  const hash = HASH("knowledge-child");
  return createKnowledgeContinuationReceipt({
    schemaVersion: 1,
    kind: "docsfab-knowledge-continuation-receipt",
    originalRunId: "run-knowledge-1",
    repositoryIdentitySha256: hash,
    repositoryRevision: REVISION,
    workflow: "create-documentation",
    instructionSha256: hash,
    candidateSnapshotSha256: HASH("candidate-snapshot"),
    candidateArtifactSha256: HASH("candidate-artifact"),
    candidateBytesSha256: HASH("candidate-bytes"),
    originalTaskArtifactSha256: HASH("original-task"),
    originalTaskBindingArtifactSha256: HASH("original-binding"),
    originalTaskBindingBytesSha256: HASH("original-binding-bytes"),
    originArtifactSha256: HASH("origin"),
    lineageArtifactSha256: HASH("lineage"),
    taskLineageProjectionSha256: HASH("lineage-projection"),
    targetConflictReceipt: null,
    targetConflictReceiptSha256: null,
  });
}

function checkDefinition(label = "docs-check"): DelegatedTaskCheckDefinitionV1 {
  const digest = HASH(label);
  return {
    checkId: "docs-check",
    definitionSha256: digest,
    commandDefinitionSha256: digest,
    scopeSha256: digest,
    effectsSha256: digest,
    authoritySha256: digest,
  };
}

describe("delegated-task no-replay continuation", () => {
  it("references settled direct edit, check, child, and publication receipts once and makes zero duplicate physical calls", async () => {
    const { repositoryPath, storeDirectory } = await fixture();
    const receipt = knowledgeReceipt();
    const oldInput = HASH("pre-pause-input");
    const originalRequirements = [
      createDelegatedRequirement("R1", "artifact", "docs/operators/index.md"),
      createDelegatedRequirement("R2", "check", "docs-check"),
      createDelegatedRequirement("R3", "child-workflow", "create-documentation"),
    ];
    const edit = vi.fn(async () => HASH("edit-call"));
    const check = vi.fn(async () => ({
      evidenceId: "check:docs-check-new",
      receiptSha256: HASH("new-check"),
      state: "passed" as const,
    }));
    const childWorkflow = vi.fn(async () => HASH("child-call"));
    const publication = vi.fn(async () => HASH("pub-call"));
    const paused = await inspectPauseDelegatedTask({
      taskId: "task:no-replay",
      ownerId: "owner-alice",
      outcome: "Document the operators directory.",
      request: createDelegatedRequest(originalRequirements),
      repositoryPath,
      repositoryRevision: REVISION,
      admittedLocators: ["README.md"],
      materialTargetLocator: "docs/operators/index.md",
      originalRequirements,
      inputMode: "no-input",
      currentAuthority: { read: true, write: false, check: true },
      storeDirectory,
      knowledgeChildReceipt: receipt,
      settledOperations: [
        {
          operationId: "edit:docs",
          kind: "edit",
          inputIdentitySha256: oldInput,
          receiptSha256: HASH("edit-receipt"),
          definitionSha256: HASH("edit-def"),
        },
        {
          operationId: "docs-check",
          kind: "check",
          inputIdentitySha256: oldInput,
          receiptSha256: HASH("old-check-receipt"),
          definitionSha256: HASH("docs-check"),
        },
        {
          operationId: "child:knowledge",
          kind: "child-workflow",
          inputIdentitySha256: oldInput,
          receiptSha256: receipt.receiptSha256,
          definitionSha256: null,
        },
        {
          operationId: "pub:1",
          kind: "publication",
          inputIdentitySha256: oldInput,
          receiptSha256: HASH("pub-receipt"),
          definitionSha256: HASH("pub-def"),
        },
      ],
      now: NOW,
    });
    expect(paused.status).toBe("needs-input");
    const continued = continueKnowledgeChild(receipt);
    expect(continued.receiptSha256).toBe(receipt.receiptSha256);
    const resumed = await resumeDelegatedTask({
      taskId: "task:no-replay",
      ownerId: "owner-alice",
      repositoryPath,
      repositoryRevision: REVISION,
      answersJson: '{"q-target":"docs/operators/"}',
      freshAuthority: { read: true, write: false, check: true },
      storeDirectory,
      currentInputIdentitySha256: oldInput,
      checkDefinition: checkDefinition(),
      retainedCheckDefinition: checkDefinition(),
      knowledgeChildReceipt: receipt,
      executors: { edit, check, childWorkflow, publication },
      now: NOW,
    });
    expect(resumed.status).toBe("blocked-write-resume");
    expect(edit).toHaveBeenCalledTimes(0);
    expect(publication).toHaveBeenCalledTimes(0);
    expect(DELEGATED_TASK_WRITE_RESUME_REMAINDER.nextRecipe).toBe("#877");

    const readOnly = await resumeDelegatedTask({
      taskId: "task:no-replay",
      ownerId: "owner-alice",
      repositoryPath,
      repositoryRevision: REVISION,
      answersJson: '{"q-target":"docs/operators/"}',
      freshAuthority: { read: true, write: false, check: true },
      storeDirectory,
      currentInputIdentitySha256: oldInput,
      checkDefinition: checkDefinition(),
      retainedCheckDefinition: checkDefinition(),
      knowledgeChildReceipt: receipt,
      executors: { check, childWorkflow },
      now: NOW,
    });
    expect(readOnly.status).toBe("resumed");
    if (readOnly.status !== "resumed") throw new Error("expected resumed");
    expect(check).toHaveBeenCalledTimes(0);
    expect(childWorkflow).toHaveBeenCalledTimes(0);
    expect(readOnly.interviewRecordsCreated).toBe(0);
    expect(readOnly.knowledgeChildReceipt?.receiptSha256).toBe(receipt.receiptSha256);
    expect(readOnly.result.children[0]?.childId).toBe("child:knowledge");
    expect(readOnly.result.checks[0]?.receiptSha256).toBe(HASH("old-check-receipt"));
  });

  it("automatically reruns an unchanged admitted check after an authorized input-identity change and rejects a changed grant", async () => {
    const { repositoryPath, storeDirectory } = await fixture();
    const oldInput = HASH("pre-pause-input");
    const newInput = HASH("post-edit-input");
    const originalRequirements = [
      createDelegatedRequirement("R1", "artifact", "docs/operators/index.md"),
      createDelegatedRequirement("R2", "check", "docs-check"),
    ];
    const check = vi.fn(async () => ({
      evidenceId: "check:docs-check-fresh",
      receiptSha256: HASH("fresh-check-receipt"),
      state: "passed" as const,
    }));
    await inspectPauseDelegatedTask({
      taskId: "task:revalidate",
      ownerId: "owner-alice",
      outcome: "Document the operators directory.",
      request: createDelegatedRequest(originalRequirements),
      repositoryPath,
      repositoryRevision: REVISION,
      admittedLocators: ["README.md"],
      materialTargetLocator: "docs/operators/index.md",
      originalRequirements,
      inputMode: "end-of-input",
      currentAuthority: { read: true, write: false, check: true },
      storeDirectory,
      settledOperations: [
        {
          operationId: "docs-check",
          kind: "check",
          inputIdentitySha256: oldInput,
          receiptSha256: HASH("stale-check-receipt"),
          definitionSha256: HASH("docs-check"),
        },
      ],
      now: NOW,
    });
    const resumed = await resumeDelegatedTask({
      taskId: "task:revalidate",
      ownerId: "owner-alice",
      repositoryPath,
      repositoryRevision: REVISION,
      answersJson: '{"q-target":"docs/operators/"}',
      freshAuthority: { read: true, write: false, check: true },
      storeDirectory,
      currentInputIdentitySha256: newInput,
      authorizedDocumentationEdit: true,
      checkDefinition: checkDefinition(),
      retainedCheckDefinition: checkDefinition(),
      executors: { check },
      now: NOW,
    });
    expect(resumed.status).toBe("resumed");
    if (resumed.status !== "resumed") throw new Error("expected resumed");
    expect(check).toHaveBeenCalledTimes(1);
    expect(resumed.result.checks[0]?.receiptSha256).toBe(HASH("fresh-check-receipt"));
    expect(resumed.result.checks[0]?.receiptSha256).not.toBe(HASH("stale-check-receipt"));

    await inspectPauseDelegatedTask({
      taskId: "task:grant-change",
      ownerId: "owner-alice",
      outcome: "Document the operators directory.",
      request: createDelegatedRequest(originalRequirements, "grant"),
      repositoryPath,
      repositoryRevision: REVISION,
      admittedLocators: ["README.md"],
      materialTargetLocator: "docs/operators/index.md",
      originalRequirements,
      inputMode: "json",
      currentAuthority: { read: true, write: false, check: true },
      storeDirectory,
      now: NOW,
    });
    await expect(
      resumeDelegatedTask({
        taskId: "task:grant-change",
        ownerId: "owner-alice",
        repositoryPath,
        repositoryRevision: REVISION,
        answersJson: '{"q-target":"docs/operators/"}',
        freshAuthority: { read: true, write: false, check: true },
        storeDirectory,
        authorizedDocumentationEdit: true,
        checkDefinition: checkDefinition("docs-check"),
        retainedCheckDefinition: checkDefinition("changed-command"),
        executors: { check },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "grant-required" });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("records write-resume remainder as blocked on #877", () => {
    expect(DELEGATED_TASK_WRITE_RESUME_REMAINDER).toMatchObject({
      blocked: true,
      nextRecipe: "#877",
    });
    expect(DELEGATED_TASK_WRITE_RESUME_REMAINDER.cells).toEqual([
      "write-resume-after-pause",
      "replay-settled-write",
    ]);
  });
});
