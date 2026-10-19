// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { RunRecord, StepRunRecord } from "../src/records/contracts.js";
import {
  answerRecordContinuationPrefixSha256,
  isSelfConsistentAnswerRecordContinuation,
} from "../src/records/composition-execution.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { projectRunCompositionExecution } from "../src/operator/run-result.js";

function continuationRecord(): { record: RunRecord; workflow: ReturnType<typeof getWorkflow> } {
  const workflow = getWorkflow("review-documentation");
  const evaluatorIndex = workflow.steps.findIndex(
    (step) => step.id === "evaluate-document-quality",
  );
  const sourceRunId = "source-run";
  const logicalRunId = "logical-run";
  const sourceRunRecordSha256 = "a".repeat(64);
  const sourcePrefix: StepRunRecord[] = workflow.steps.slice(0, evaluatorIndex).map((step) => ({
    id: step.id,
    title: step.title,
    kind: step.kind ?? "inference",
    skill: step.skill,
    mode: step.mode,
    status: "succeeded",
    summary: `source summary for ${step.id}`,
  }));
  const receipt = {
    schemaVersion: 1 as const,
    kind: "docsfab-answer-record-continuation-receipt" as const,
    sourceRunId,
    sourceRunRecordSha256,
    checkpointSha256: "b".repeat(64),
    checkpointSequence: 4,
    checkpointAttempt: 2,
    logicalRunId,
    inheritedPrefixSha256: answerRecordContinuationPrefixSha256(sourcePrefix),
  };
  const steps: StepRunRecord[] = workflow.steps.map((definition, index) => {
    if (index < evaluatorIndex) {
      return {
        ...sourcePrefix[index]!,
        inheritedFrom: { sourceRunId, sourceRunRecordSha256, sourceStepId: definition.id },
      };
    }
    if (index === evaluatorIndex) {
      return {
        id: definition.id,
        title: definition.title,
        kind: definition.kind ?? "evaluate",
        skill: definition.skill,
        mode: definition.mode,
        status: "succeeded",
        answerRecordCheckpoint: { sha256: "c".repeat(64), sequence: 5, attempt: 1 },
        answerRecordLedger: {
          schemaVersion: 1,
          kind: "docsfab-answer-record-ledger-index",
          contractId: "quality-evaluation",
          bindingsSha256: "d".repeat(64),
          rows: [],
          checkpoint: { sha256: "c".repeat(64), sequence: 5, attempt: 1 },
          progress: {
            admittedRowCount: 2,
            releasedRowCount: 0,
            remainingKeyCount: 0,
            refusalEventCount: 0,
            complete: true,
            checkpointSequence: 5,
            logicalRunId,
            sourceRunId: "child-run",
            sourceAttemptHighWater: 3,
          },
        },
      };
    }
    return {
      id: definition.id,
      title: definition.title,
      kind: definition.kind ?? "inference",
      skill: definition.skill,
      mode: definition.mode,
      status: "succeeded",
    };
  });
  return {
    workflow,
    record: {
      schemaVersion: 2,
      id: "child-run",
      workflow: workflow.name,
      repository: { sourcePath: "/tmp/repo", requestedRevision: "main", revision: "a".repeat(40) },
      workspace: { strategy: "tracked-export", disposable: true },
      status: "succeeded",
      answerRecordContinuation: receipt,
      steps,
    } as RunRecord,
  };
}

describe("answer-record continuation provenance", () => {
  it("accepts only a complete child with a receipt-bound contiguous inherited prefix", () => {
    const { record, workflow } = continuationRecord();
    expect(isSelfConsistentAnswerRecordContinuation(record, workflow)).toBe(true);
    record.compositionExecution = {
      runId: record.id,
      compositionId: "installed-composition",
      evidenceSha256: "e".repeat(64),
      technicalApproval: "not-established",
      roleQualification: "not-established",
      releaseEligible: false,
    } as NonNullable<RunRecord["compositionExecution"]>;
    expect(projectRunCompositionExecution(record)).toMatchObject({
      compositionId: "installed-composition",
      aggregateSha256: null,
      releaseEligible: false,
    });
  });

  it("rejects changed inherited content, a detached receipt, or a forged prefix", () => {
    const { record, workflow } = continuationRecord();
    const changedPrefix = structuredClone(record);
    changedPrefix.steps[0]!.summary = "changed after source load";
    expect(isSelfConsistentAnswerRecordContinuation(changedPrefix, workflow)).toBe(false);

    const detachedReceipt = structuredClone(record);
    detachedReceipt.answerRecordContinuation!.sourceRunId = "unrelated-run";
    expect(isSelfConsistentAnswerRecordContinuation(detachedReceipt, workflow)).toBe(false);

    const forgedPrefix = structuredClone(record);
    delete forgedPrefix.steps[0]!.inheritedFrom;
    expect(isSelfConsistentAnswerRecordContinuation(forgedPrefix, workflow)).toBe(false);
  });
});
