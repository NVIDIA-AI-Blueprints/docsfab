// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { sha256 } from "../../content-ir/canonical.js";
import { fail, kit } from "./protocol.js";
import type { AuthoringPhaseEvidenceBodyV1 } from "./schema.js";
import type { AuthoringCandidateV1 } from "../../workflow-execution/authoring-candidate.js";
import {
  authoringPhaseForStep,
  authoringPrefixPhaseForStep,
} from "../../workflow-contracts/authoring-schedule.js";
import {
  isWorkflowManifestV3,
  type WorkflowAuthoringBranchIdV3,
  type WorkflowAuthoringPhaseV3,
  type WorkflowAuthoringScheduleDefinitionV3,
  type WorkflowDefinition,
} from "../../workflow-contracts/contracts.js";

export function normalizePhase(
  root: Record<string, unknown>,
  context: {
    workflow: WorkflowDefinition;
    branchId: WorkflowAuthoringBranchIdV3 | null;
    candidates: readonly AuthoringCandidateV1[];
  },
): AuthoringPhaseEvidenceBodyV1 {
  const stepId = kit.identifier(root.stepId);
  const phase = resolvePhase(context.workflow, context.branchId, stepId);
  const summarySha256 = root.summarySha256 === null ? null : kit.hash(root.summarySha256);
  const expected = phaseBody(
    phase,
    context.branchId,
    context.candidates,
    root.outputCandidateDigest !== null,
    null,
  );
  const normalized: AuthoringPhaseEvidenceBodyV1 = {
    ...expected,
    summarySha256,
  };
  if (
    root.branchId !== normalized.branchId ||
    root.ordinal !== normalized.ordinal ||
    root.role !== normalized.role ||
    root.inputCandidateOrdinal !== normalized.inputCandidateOrdinal ||
    root.inputCandidateDigest !== normalized.inputCandidateDigest ||
    root.outputCandidateOrdinal !== normalized.outputCandidateOrdinal ||
    root.outputCandidateDigest !== normalized.outputCandidateDigest ||
    root.assessedCandidateOrdinal !== normalized.assessedCandidateOrdinal ||
    root.assessedCandidateDigest !== normalized.assessedCandidateDigest ||
    root.workspaceSnapshotDigest !== normalized.workspaceSnapshotDigest
  ) {
    fail("phase-mismatch");
  }
  return normalized;
}

export function phaseBody(
  phase: ReturnType<typeof resolvePhase>,
  branchId: WorkflowAuthoringBranchIdV3 | null,
  candidates: readonly AuthoringCandidateV1[],
  outputAdmitted: boolean,
  summary: string | null,
): AuthoringPhaseEvidenceBodyV1 {
  if (phase.role === "writer") {
    const input =
      phase.inputCandidateOrdinal === null ? null : candidates[phase.inputCandidateOrdinal];
    const output = outputAdmitted ? candidates[phase.outputCandidateOrdinal] : undefined;
    if ((phase.inputCandidateOrdinal !== null && !input) || (outputAdmitted && !output)) {
      fail("candidate-mismatch");
    }
    return {
      branchId,
      stepId: phase.stepId,
      ordinal: phase.ordinal,
      role: phase.role,
      inputCandidateOrdinal: phase.inputCandidateOrdinal,
      inputCandidateDigest: input?.digest ?? null,
      outputCandidateOrdinal: output ? phase.outputCandidateOrdinal : null,
      outputCandidateDigest: output?.digest ?? null,
      assessedCandidateOrdinal: null,
      assessedCandidateDigest: null,
      workspaceSnapshotDigest: output?.workspaceSnapshotDigest ?? null,
      summarySha256: summary === null ? null : sha256(summary),
    };
  }
  const candidate = candidates[phase.candidateOrdinal];
  if (!candidate) fail("candidate-mismatch");
  return {
    branchId,
    stepId: phase.stepId,
    ordinal: phase.ordinal,
    role: phase.role,
    inputCandidateOrdinal: null,
    inputCandidateDigest: null,
    outputCandidateOrdinal: null,
    outputCandidateDigest: null,
    assessedCandidateOrdinal: phase.candidateOrdinal,
    assessedCandidateDigest: candidate.digest,
    workspaceSnapshotDigest: candidate.workspaceSnapshotDigest,
    summarySha256: summary === null ? null : sha256(summary),
  };
}

export function requireV3(workflow: WorkflowDefinition): WorkflowAuthoringScheduleDefinitionV3 {
  if (!isWorkflowManifestV3(workflow) || workflow.name !== "create-documentation") {
    fail("subject-mismatch");
  }
  return workflow.authoringSchedule;
}

export function resolvePhase(
  workflow: WorkflowDefinition,
  branchId: WorkflowAuthoringBranchIdV3 | null,
  stepId: string,
): WorkflowAuthoringPhaseV3 {
  requireV3(workflow);
  const prefix = authoringPrefixPhaseForStep(workflow, stepId);
  if (prefix) return prefix;
  if (!branchId) fail("phase-mismatch");
  const phase = authoringPhaseForStep(workflow, branchId, stepId);
  if (!phase) fail("phase-mismatch");
  return phase;
}

export function tryResolvePhase(
  workflow: WorkflowDefinition,
  branchId: WorkflowAuthoringBranchIdV3 | null,
  stepId: string,
): WorkflowAuthoringPhaseV3 | undefined {
  const prefix = authoringPrefixPhaseForStep(workflow, stepId);
  if (prefix) return prefix;
  return branchId ? authoringPhaseForStep(workflow, branchId, stepId) : undefined;
}
