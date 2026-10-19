// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalArtifactJson } from "../../artifacts/canonical.js";
import type { EditorialDecisionArtifactReferenceV3 } from "../../artifacts/contracts.js";
import {
  isWorkflowManifestV2,
  workflowSelectedPath,
  type WorkflowBranchCoverageV1,
  type WorkflowBranchIdV2,
  type WorkflowDefinition,
} from "../../workflow-contracts/contracts.js";
import {
  decodeWorkflowBranchCoverageV1,
  type WorkflowBranchCoverageDecodeOptionsV1,
} from "../../workflow-contracts/branch-coverage.js";
import type { RunRecord } from "../contracts.js";
import { fail, kit } from "./kit.js";

/** Seal host-derived selected-path obligations before any suffix step runs. */
export function createWorkflowBranchCoverageV1(input: {
  workflow: WorkflowDefinition;
  repositoryRevision: string;
  workspaceSnapshotSha256: string;
  selection: null | {
    branchId: WorkflowBranchIdV2;
    candidateArtifact: EditorialDecisionArtifactReferenceV3;
  };
}): WorkflowBranchCoverageV1 {
  if (!isWorkflowManifestV2(input.workflow) || input.workflow.name !== "update-documentation") {
    fail("subject-mismatch");
  }
  const branching = input.workflow.branching!;
  const manifest = structuredClone(branching.manifest);
  const requiredStepIds = input.selection
    ? workflowSelectedPath(input.workflow, input.selection.branchId).steps.map((step) => step.id)
    : branching.prefix.steps.map((step) => step.id);
  const selectedIds = new Set(requiredStepIds);
  const excludedStepIds = input.selection
    ? branching.branches
        .find((branch) => branch.id !== input.selection!.branchId)!
        .steps.map((step) => step.id)
        .filter((id) => !selectedIds.has(id))
    : [];
  const coverage = kit.seal("docsfab-workflow-branch-coverage", "coverageSha256", {
    workflow: "update-documentation" as const,
    manifest,
    manifestSha256: kit.canonicalDigest(manifest),
    repositoryRevision: kit.revision(input.repositoryRevision),
    workspaceSnapshotSha256: kit.hash(input.workspaceSnapshotSha256),
    selection: input.selection
      ? {
          branchId: input.selection.branchId,
          candidateArtifact: structuredClone(input.selection.candidateArtifact),
        }
      : null,
    requiredStepIds,
    excludedStepIds,
  });
  if (
    Buffer.byteLength(kit.canonicalJson(manifest), "utf8") > 64 * 1024 ||
    Buffer.byteLength(kit.canonicalJson(coverage), "utf8") > 128 * 1024
  ) {
    fail("invalid-value");
  }
  return decodeWorkflowBranchCoverageV1(
    coverage,
    workflowBranchCoverageDecodeOptionsV1({ workflow: input.workflow }),
  );
}

/** Runtime-owned semantic callback for fresh execution and retained selected-path records. */
export function workflowBranchCoverageDecodeOptionsV1(input: {
  workflow: WorkflowDefinition;
  record?: Readonly<RunRecord>;
  requireComplete?: boolean;
}): WorkflowBranchCoverageDecodeOptionsV1 {
  if (!isWorkflowManifestV2(input.workflow) || input.workflow.name !== "update-documentation") {
    fail("subject-mismatch");
  }
  const workflow = input.workflow;
  const branching = workflow.branching!;
  return {
    decodeManifest: (value) => {
      if (canonicalArtifactJson(value) !== canonicalArtifactJson(branching.manifest)) {
        fail("subject-mismatch");
      }
      return structuredClone(branching.manifest);
    },
    validateCoverage: (coverage) => {
      const selection = coverage.selection;
      const selectedPath = selection
        ? workflowSelectedPath(workflow, selection.branchId)
        : branching.prefix;
      const required = selectedPath.steps.map((step) => step.id);
      const selectedIds = new Set(required);
      const excluded = selection
        ? branching.branches
            .find((branch) => branch.id !== selection.branchId)!
            .steps.map((step) => step.id)
            .filter((id) => !selectedIds.has(id))
        : [];
      if (
        canonicalArtifactJson(coverage.requiredStepIds) !== canonicalArtifactJson(required) ||
        canonicalArtifactJson(coverage.excludedStepIds) !== canonicalArtifactJson(excluded)
      ) {
        fail("subject-mismatch");
      }
      const record = input.record;
      if (!record) return;
      if (
        record.workflow !== coverage.workflow ||
        record.repository.revision !== coverage.repositoryRevision ||
        record.steps.length !== required.length
      ) {
        fail("subject-mismatch");
      }
      for (const [index, step] of record.steps.entries()) {
        const definition = selectedPath.steps[index];
        if (
          !definition ||
          step.id !== definition.id ||
          step.skill !== definition.skill ||
          step.mode !== definition.mode ||
          (input.requireComplete && step.status !== "succeeded") ||
          coverage.excludedStepIds.includes(step.id)
        ) {
          fail("subject-mismatch");
        }
      }
      if (selection) {
        const uses = (record.artifacts ?? []).filter(
          (use) =>
            use.role === "output" &&
            canonicalArtifactJson(use.reference) ===
              canonicalArtifactJson(selection.candidateArtifact),
        );
        if (uses.length !== 1) fail("subject-mismatch");
      }
      if (input.requireComplete && selection?.branchId === "assess-no-change") {
        if (record.changes !== undefined) fail("subject-mismatch");
        for (const stepId of [
          "plan-documentation",
          "verify-technical-accuracy",
          "evaluate-document-quality",
        ]) {
          const search = record.steps.find((step) => step.id === stepId)?.searchEvidence;
          if (!search || search.workspaceSnapshotSha256 !== coverage.workspaceSnapshotSha256) {
            fail("subject-mismatch");
          }
        }
      }
    },
  };
}
