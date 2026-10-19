// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  WorkflowAuthoringBranchIdV3,
  WorkflowAuthoringPhaseRoleV3,
  WorkflowAuthoringPhaseStepIdV3,
  WorkflowAuthoringPhaseV3,
  WorkflowContextPolicy,
  WorkflowDefinition,
  WorkflowStep,
} from "./contracts.js";
import { isWorkflowManifestV3 } from "./contracts.js";

export interface WorkflowAuthoringSelectedPathV3 {
  branchId: WorkflowAuthoringBranchIdV3;
  candidateOrdinal: 0 | 1;
  steps: readonly WorkflowStep[];
  contextPolicy: WorkflowContextPolicy;
  excludedStepIds: readonly string[];
  phases: readonly WorkflowAuthoringPhaseV3[];
  technicalProducerStepId: "verify-technical-accuracy" | "verify-revised-technical-accuracy";
  editorialProducerStepId: "review-documentation" | "review-revised-documentation";
}

const phaseRoles = new Map<WorkflowAuthoringPhaseStepIdV3, WorkflowAuthoringPhaseRoleV3>([
  ["write-documentation", "writer"],
  ["lint-documentation", "lint"],
  ["provisional-technical-verification", "provisional-technical"],
  ["verify-technical-accuracy", "canonical-technical"],
  ["review-documentation", "editorial"],
  ["revise-documentation", "writer"],
  ["lint-revised-documentation", "lint"],
  ["provisional-revised-technical-verification", "provisional-technical"],
  ["verify-revised-technical-accuracy", "canonical-technical"],
  ["review-revised-documentation", "editorial"],
  ["test-audience-understanding", "audience"],
  ["evaluate-document-quality", "evaluation"],
]);

/**
 * Resolve a candidate phase that is available before branch selection.
 * Planning and source derivation deliberately return undefined because no
 * authored candidate exists yet.
 */
export function authoringPrefixPhaseForStep(
  workflow: WorkflowDefinition,
  stepId: string,
): WorkflowAuthoringPhaseV3 | undefined {
  const schedule = requireAuthoringSchedule(workflow);
  const index = schedule.prefix.steps.findIndex((step) => step.id === stepId);
  if (index < 0) return undefined;
  return phaseForStep(stepId, index + 1, 0);
}

/** Resolve host-owned phase metadata from the exact installed selected path. */
export function authoringPhaseForStep(
  workflow: WorkflowDefinition,
  branchId: WorkflowAuthoringBranchIdV3,
  stepId: string,
): WorkflowAuthoringPhaseV3 | undefined {
  return authoringSelectedPath(workflow, branchId).phases.find((phase) => phase.stepId === stepId);
}

/** Select one of the two finite CREATE paths without consulting model output. */
export function authoringSelectedPath(
  workflow: WorkflowDefinition,
  branchId: WorkflowAuthoringBranchIdV3,
): WorkflowAuthoringSelectedPathV3 {
  const schedule = requireAuthoringSchedule(workflow);
  const branch = schedule.branches.find((candidate) => candidate.id === branchId);
  if (!branch) throw new Error(`Workflow Manifest V3 has no authoring branch ${branchId}.`);

  const steps = Object.freeze([...schedule.prefix.steps, ...branch.steps]);
  const selectedIds = new Set(steps.map((step) => step.id));
  const excludedStepIds = Object.freeze(
    schedule.branches
      .flatMap((candidate) => candidate.steps)
      .map((step) => step.id)
      .filter((stepId, index, all) => !selectedIds.has(stepId) && all.indexOf(stepId) === index),
  );
  const revised = branchId === "revise";
  const phases = Object.freeze(
    steps.flatMap((step, index) => {
      const phase = phaseForStep(step.id, index + 1, revised ? 1 : 0);
      return phase ? [phase] : [];
    }),
  );

  return Object.freeze({
    branchId,
    candidateOrdinal: revised ? 1 : 0,
    steps,
    contextPolicy: Object.freeze({
      schemaVersion: 1,
      steps: Object.freeze([...schedule.prefix.contextPolicy.steps, ...branch.contextPolicy.steps]),
    }),
    excludedStepIds,
    phases,
    technicalProducerStepId: revised
      ? "verify-revised-technical-accuracy"
      : "verify-technical-accuracy",
    editorialProducerStepId: revised ? "review-revised-documentation" : "review-documentation",
  });
}

function requireAuthoringSchedule(workflow: WorkflowDefinition) {
  if (!isWorkflowManifestV3(workflow)) {
    throw new Error("Authoring schedule selection requires a create-documentation Manifest V3.");
  }
  return workflow.authoringSchedule;
}

function phaseForStep(
  stepId: string,
  ordinal: number,
  selectedCandidateOrdinal: 0 | 1,
): WorkflowAuthoringPhaseV3 | undefined {
  if (!phaseRoles.has(stepId as WorkflowAuthoringPhaseStepIdV3)) return undefined;
  const exactStepId = stepId as WorkflowAuthoringPhaseStepIdV3;
  const role = phaseRoles.get(exactStepId)!;
  if (role === "writer") {
    return Object.freeze(
      exactStepId === "write-documentation"
        ? {
            stepId: exactStepId,
            ordinal,
            role,
            inputCandidateOrdinal: null,
            outputCandidateOrdinal: 0,
          }
        : {
            stepId: "revise-documentation",
            ordinal,
            role,
            inputCandidateOrdinal: 0,
            outputCandidateOrdinal: 1,
          },
    );
  }
  return Object.freeze({
    stepId: exactStepId as Exclude<
      WorkflowAuthoringPhaseStepIdV3,
      "write-documentation" | "revise-documentation"
    >,
    ordinal,
    role,
    candidateOrdinal:
      revisedStep(exactStepId) || role === "audience" || role === "evaluation"
        ? selectedCandidateOrdinal
        : 0,
  });
}

function revisedStep(stepId: WorkflowAuthoringPhaseStepIdV3): boolean {
  return stepId.includes("revised");
}
