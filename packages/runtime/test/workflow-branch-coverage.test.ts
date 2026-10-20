// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type {
  EditorialDecisionArtifactReferenceV3,
  EditorialDecisionPayloadV1,
} from "../src/artifacts/contracts.js";
import {
  assertRunRecordEditorialDeliveryEligible,
  PublicationRunRecordDecodeError,
} from "../src/delivery/run-record.js";
import type { RunRecord } from "../src/records/contracts.js";
import {
  createWorkflowBranchCoverageV1,
  workflowBranchCoverageDecodeOptionsV1,
} from "../src/records/composition-execution.js";
import {
  decodeWorkflowBranchCoverageV1,
  WorkflowBranchCoverageError,
} from "../src/workflow-contracts/branch-coverage.js";
import { workflowSelectedPath } from "../src/workflow-contracts/contracts.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";

const REVISION = "a".repeat(40);
const SNAPSHOT = "b".repeat(64);
const CANDIDATE: EditorialDecisionArtifactReferenceV3 = {
  kind: "editorial-decision",
  schemaVersion: 3,
  digest: "c".repeat(64),
  repositoryRevision: REVISION,
  repositoryContentDigest: "d".repeat(64),
};

describe("selected workflow branch coverage", () => {
  it.each([
    ["author", []],
    [
      "assess-no-change",
      ["derive-source-obligations", "write-documentation", "lint-documentation"],
    ],
  ] as const)(
    "derives exact %s obligations from the retained V2 manifest",
    (branchId, excluded) => {
      const workflow = getWorkflow("update-documentation");
      const coverage = createWorkflowBranchCoverageV1({
        workflow,
        repositoryRevision: REVISION,
        workspaceSnapshotSha256: SNAPSHOT,
        selection: { branchId, candidateArtifact: CANDIDATE },
      });

      expect(coverage.requiredStepIds).toEqual(
        workflowSelectedPath(workflow, branchId).steps.map((step) => step.id),
      );
      expect(coverage.excludedStepIds).toEqual(excluded);
      expect(coverage.manifest).toEqual(workflow.branching?.manifest);
      expect(Object.isFrozen(coverage)).toBe(true);
    },
  );

  it("rejects manifest substitution, unsupported versions, and changed seals", () => {
    const workflow = getWorkflow("update-documentation");
    const coverage = createWorkflowBranchCoverageV1({
      workflow,
      repositoryRevision: REVISION,
      workspaceSnapshotSha256: SNAPSHOT,
      selection: { branchId: "assess-no-change", candidateArtifact: CANDIDATE },
    });
    const options = workflowBranchCoverageDecodeOptionsV1({ workflow });

    for (const changed of [
      { ...structuredClone(coverage), schemaVersion: 2 },
      { ...structuredClone(coverage), coverageSha256: "0".repeat(64) },
      {
        ...structuredClone(coverage),
        manifest: { ...structuredClone(coverage.manifest), title: "Substituted" },
      },
    ]) {
      expect(() => decodeWorkflowBranchCoverageV1(changed, options)).toThrow(
        WorkflowBranchCoverageError,
      );
    }
  });

  it("rejects missing, duplicate, extra, failed, and excluded selected-path records", () => {
    const workflow = getWorkflow("update-documentation");
    const coverage = createWorkflowBranchCoverageV1({
      workflow,
      repositoryRevision: REVISION,
      workspaceSnapshotSha256: SNAPSHOT,
      selection: { branchId: "assess-no-change", candidateArtifact: CANDIDATE },
    });
    const path = workflowSelectedPath(workflow, "assess-no-change");
    const record = {
      workflow: "update-documentation",
      repository: { revision: REVISION },
      artifacts: [{ role: "output", stepId: "plan-documentation", reference: CANDIDATE }],
      steps: path.steps.map((step) => ({
        id: step.id,
        title: step.title,
        skill: step.skill,
        mode: step.mode,
        status: "succeeded",
      })),
    } as unknown as RunRecord;
    const decode = (candidate: RunRecord) =>
      decodeWorkflowBranchCoverageV1(
        coverage,
        workflowBranchCoverageDecodeOptionsV1({ workflow, record: candidate }),
      );
    const decodeComplete = (candidate: RunRecord) =>
      decodeWorkflowBranchCoverageV1(
        coverage,
        workflowBranchCoverageDecodeOptionsV1({
          workflow,
          record: candidate,
          requireComplete: true,
        }),
      );

    expect(() => decode({ ...record, steps: record.steps.slice(0, -1) })).toThrow();
    expect(() => decode({ ...record, steps: [...record.steps, record.steps[1]!] })).toThrow();
    expect(() =>
      decodeComplete({
        ...record,
        steps: record.steps.map((step, index) =>
          index === 2 ? { ...step, status: "failed" as const } : step,
        ),
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...record,
        steps: [
          ...record.steps,
          {
            id: "write-documentation",
            title: "forged writer",
            skill: "write-documentation",
            mode: "write",
            status: "succeeded",
          },
        ],
      }),
    ).toThrow();
  });

  it("requires the semantic callbacks and does not treat legacy absence as coverage", () => {
    const workflow = getWorkflow("update-documentation");
    expect(() => decodeWorkflowBranchCoverageV1(undefined, {} as never)).toThrow(
      WorkflowBranchCoverageError,
    );
    expect(workflow.schemaVersion).toBe(2);
  });

  it("rejects an admitted verified no-change record from delivery", () => {
    const workflow = getWorkflow("update-documentation");
    const finalReference: EditorialDecisionArtifactReferenceV3 = {
      ...CANDIDATE,
      digest: "e".repeat(64),
    };
    const planBindingSha256 = "f".repeat(64);
    const path = workflowSelectedPath(workflow, "assess-no-change");
    const record = {
      workflow: "update-documentation",
      status: "succeeded",
      repository: { revision: REVISION },
      steps: path.steps.map((step) => ({
        id: step.id,
        title: step.title,
        skill: step.skill,
        mode: step.mode,
        status: "succeeded",
        ...(step.id === "plan-documentation" ? { planBinding: { digest: planBindingSha256 } } : {}),
      })),
      artifacts: [
        { role: "output", stepId: "plan-documentation", reference: CANDIDATE },
        {
          role: "output",
          stepId: "evaluate-document-quality",
          reference: finalReference,
        },
      ],
    } as unknown as RunRecord;
    record.workflowBranchCoverage = createWorkflowBranchCoverageV1({
      workflow,
      repositoryRevision: REVISION,
      workspaceSnapshotSha256: SNAPSHOT,
      selection: { branchId: "assess-no-change", candidateArtifact: CANDIDATE },
    });
    const decision = (
      reference: EditorialDecisionArtifactReferenceV3,
      stepId: string,
    ): EditorialDecisionPayloadV1 => ({
      schemaVersion: 1,
      kind: "docsfab-editorial-decision",
      phase: stepId === "plan-documentation" ? "candidate" : "validated",
      candidateArtifact: stepId === "plan-documentation" ? null : CANDIDATE,
      branchCoverage:
        stepId === "plan-documentation"
          ? null
          : {
              schemaVersion: 1,
              kind: "docsfab-workflow-branch-coverage-reference",
              coverageSha256: record.workflowBranchCoverage!.coverageSha256,
            },
      candidate: "no-change",
      repositoryRevision: REVISION,
      workspaceSnapshotSha256: SNAPSHOT,
      readerProvenanceSha256: "1".repeat(64),
      planBindingSha256,
      policySha256: "2".repeat(64),
      comparison: { kind: "workspace", snapshot_sha256: SNAPSHOT },
      rationaleSha256: "3".repeat(64),
      evidenceRefs: [CANDIDATE],
      limitations: [],
      decisionSha256: reference.digest,
    });

    expect(() =>
      assertRunRecordEditorialDeliveryEligible(record, {
        decodeEditorialDecision: decision,
        decodeWorkflowBranchCoverage: (value, candidateRecord) =>
          decodeWorkflowBranchCoverageV1(
            value,
            workflowBranchCoverageDecodeOptionsV1({
              workflow,
              record: candidateRecord,
            }),
          ),
      }),
    ).toThrowError(new PublicationRunRecordDecodeError("no-document-change"));
  });
});
