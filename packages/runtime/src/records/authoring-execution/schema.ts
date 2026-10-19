// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AuthoringCandidateV1 } from "../../workflow-execution/authoring-candidate.js";
import type {
  WorkflowAuthoringBranchIdV3,
  WorkflowAuthoringPhaseRoleV3,
  WorkflowDefinition,
} from "../../workflow-contracts/contracts.js";

export const AUTHORING_EXECUTION_KIND = "docsfab-authoring-execution" as const;

export const AUTHORING_PHASE_KIND = "docsfab-authoring-phase" as const;

export const AUTHORING_PARTIAL_KIND = "docsfab-authoring-partial-candidate" as const;

export const AUTHORING_REVISION_ADMISSION_KIND = "docsfab-authoring-revision-admission" as const;

export interface AuthoringCandidateArtifactReferenceV1 {
  readonly kind: "authoring-candidate-patch";
  readonly name: "candidate-0.patch" | "candidate-1.patch";
  readonly sha256: string;
  readonly byteLength: number;
}

export interface AuthoringCandidateHistoryEntryV1 {
  readonly candidate: AuthoringCandidateV1;
  readonly artifact: AuthoringCandidateArtifactReferenceV1;
  readonly admittedByStepId: "write-documentation" | "revise-documentation";
  readonly revisionInputDigest: string | null;
}

export interface AuthoringPartialCandidateV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof AUTHORING_PARTIAL_KIND;
  readonly runId: string;
  readonly ordinal: 1;
  readonly inputCandidateDigest: string;
  readonly revisionInputDigest: string;
  readonly originalRevision: string;
  readonly planDigest: string;
  readonly writePaths: readonly string[];
  readonly artifact: {
    readonly kind: "authoring-partial-patch";
    readonly name: "candidate-1.partial.patch";
    readonly sha256: string;
    readonly byteLength: number;
  } | null;
  readonly workspaceSnapshotDigest: string | null;
  readonly disposition: "non-deliverable";
  readonly failureCode: string;
  readonly partialSha256: string;
}

export interface AuthoringCandidatePointerV1 {
  readonly ordinal: 0 | 1;
  readonly digest: string;
  readonly artifactName: "candidate-0.patch" | "candidate-1.patch";
}

export interface AuthoringProducerSummaryBindingV1 {
  readonly stepId: string;
  readonly summarySha256: string;
  readonly candidateOrdinal: 0 | 1;
  readonly candidateDigest: string;
  readonly workspaceSnapshotDigest: string;
}

export interface AuthoringSelectionInputV1 {
  readonly candidate0Digest: string;
  readonly candidate0WorkspaceSnapshotDigest: string;
  readonly originalRevision: string;
  readonly planDigest: string;
  readonly writePaths: readonly string[];
  readonly sourceSearchSnapshotSha256: string;
  readonly sourceObligationLedgerSha256: string;
  readonly technicalCorrectionEvidenceSha256: string;
  readonly technical: AuthoringProducerSummaryBindingV1;
  readonly editorial: AuthoringProducerSummaryBindingV1;
}

export interface AuthoringPathSelectionV1 {
  readonly branchId: WorkflowAuthoringBranchIdV3;
  readonly input: AuthoringSelectionInputV1;
  readonly inputSha256: string;
  readonly revisionInputDigest: string | null;
  readonly requiredStepIds: readonly string[];
  readonly excludedStepIds: readonly string[];
}

export interface AuthoringSelectedProducerSetV1 {
  readonly lint: AuthoringProducerSummaryBindingV1;
  readonly technical: AuthoringProducerSummaryBindingV1;
  readonly editorial: AuthoringProducerSummaryBindingV1;
}

export interface AuthoringFinalPatchBindingV1 {
  readonly candidateOrdinal: 0 | 1;
  readonly candidateDigest: string;
  readonly artifactName: "candidate-0.patch" | "candidate-1.patch";
  readonly sha256: string;
  readonly byteLength: number;
  readonly baseRevision: string;
  readonly writePaths: readonly string[];
}

/** Host-observed admission facts for one successfully sealed candidate revision. */
export interface AuthoringRevisionAdmissionBindingV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof AUTHORING_REVISION_ADMISSION_KIND;
  readonly candidate0Digest: string;
  readonly candidate0WorkspaceSnapshotDigest: string;
  readonly candidate1Digest: string;
  readonly candidate1WorkspaceSnapshotDigest: string;
  readonly changedPaths: readonly string[];
  readonly accountingSha256: string;
  readonly admissionSha256: string;
}

export interface AuthoringExecutionBodyV1 {
  readonly runId: string;
  readonly workflow: "create-documentation";
  readonly manifest: NonNullable<WorkflowDefinition["authoringSchedule"]>["manifest"];
  readonly manifestSha256: string;
  readonly repositoryRevision: string;
  readonly planDigest: string;
  readonly writePaths: readonly string[];
  readonly sourceSearchSnapshotSha256: string | null;
  readonly sourceObligationLedgerSha256: string | null;
  readonly technicalCorrectionEvidenceSha256: string | null;
  readonly selection: AuthoringPathSelectionV1 | null;
  readonly candidates: readonly AuthoringCandidateHistoryEntryV1[];
  readonly revisionAdmission: AuthoringRevisionAdmissionBindingV1 | null;
  readonly partialCandidate1: AuthoringPartialCandidateV1 | null;
  readonly selectedCandidate: AuthoringCandidatePointerV1 | null;
  readonly selectedProducers: AuthoringSelectedProducerSetV1 | null;
  readonly finalPatch: AuthoringFinalPatchBindingV1 | null;
}

export interface AuthoringExecutionEvidenceV1 extends AuthoringExecutionBodyV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof AUTHORING_EXECUTION_KIND;
  readonly executionSha256: string;
}

export interface AuthoringPhaseEvidenceBodyV1 {
  readonly branchId: WorkflowAuthoringBranchIdV3 | null;
  readonly stepId: string;
  readonly ordinal: number;
  readonly role: WorkflowAuthoringPhaseRoleV3;
  readonly inputCandidateOrdinal: 0 | null;
  readonly inputCandidateDigest: string | null;
  readonly outputCandidateOrdinal: 0 | 1 | null;
  readonly outputCandidateDigest: string | null;
  readonly assessedCandidateOrdinal: 0 | 1 | null;
  readonly assessedCandidateDigest: string | null;
  readonly workspaceSnapshotDigest: string | null;
  readonly summarySha256: string | null;
}

export interface AuthoringPhaseEvidenceV1 extends AuthoringPhaseEvidenceBodyV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof AUTHORING_PHASE_KIND;
  readonly phaseSha256: string;
}

/** Stable phase identity available before inference or host execution starts. */
export interface AuthoringPhaseInvocationBindingV1 {
  readonly branchId: WorkflowAuthoringBranchIdV3 | null;
  readonly stepId: string;
  readonly ordinal: number;
  readonly role: WorkflowAuthoringPhaseRoleV3;
  readonly inputCandidateOrdinal: 0 | null;
  readonly inputCandidateDigest: string | null;
  readonly assessedCandidateOrdinal: 0 | 1 | null;
  readonly assessedCandidateDigest: string | null;
  readonly workspaceSnapshotDigest: string | null;
  readonly revisionInputDigest: string | null;
}

export interface CreateAuthoringExecutionEvidenceInputV1 {
  readonly runId: string;
  readonly repositoryRevision: string;
  readonly planDigest: string;
  readonly writePaths: readonly string[];
  readonly sourceSearchSnapshotSha256: string | null;
  readonly sourceObligationLedgerSha256: string | null;
  readonly technicalCorrectionEvidenceSha256: string | null;
  readonly selection:
    | (Omit<AuthoringPathSelectionV1, "inputSha256" | "requiredStepIds" | "excludedStepIds"> & {
        readonly input: AuthoringSelectionInputV1;
      })
    | null;
  readonly candidates: readonly {
    readonly candidate: AuthoringCandidateV1;
    readonly revisionInputDigest: string | null;
  }[];
  readonly revisionAdmission: AuthoringRevisionAdmissionBindingV1 | null;
  readonly partialCandidate1: AuthoringPartialCandidateV1 | null;
  readonly selectedCandidateOrdinal: 0 | 1 | null;
  readonly selectedProducers: AuthoringSelectedProducerSetV1 | null;
  readonly includeFinalPatch: boolean;
}

export const EXECUTION_BODY_KEYS = [
  "runId",
  "workflow",
  "manifest",
  "manifestSha256",
  "repositoryRevision",
  "planDigest",
  "writePaths",
  "sourceSearchSnapshotSha256",
  "sourceObligationLedgerSha256",
  "technicalCorrectionEvidenceSha256",
  "selection",
  "candidates",
  "revisionAdmission",
  "partialCandidate1",
  "selectedCandidate",
  "selectedProducers",
  "finalPatch",
] as const;

export const PHASE_BODY_KEYS = [
  "branchId",
  "stepId",
  "ordinal",
  "role",
  "inputCandidateOrdinal",
  "inputCandidateDigest",
  "outputCandidateOrdinal",
  "outputCandidateDigest",
  "assessedCandidateOrdinal",
  "assessedCandidateDigest",
  "workspaceSnapshotDigest",
  "summarySha256",
] as const;
