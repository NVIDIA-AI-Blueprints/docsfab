// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type ReleaseDocumentationReadinessCategory =
  | "audience"
  | "site-infrastructure"
  | "site-build"
  | "site-template"
  | "site-validation"
  | "information-architecture"
  | "journey"
  | "task-guide"
  | "reference"
  | "trust"
  | "release-policy"
  | "governance"
  | "scoped-guidance"
  | "human-decision";

export type ReleaseDocumentationReadinessFindingState =
  | "covered"
  | "missing"
  | "needs-human-decision"
  | "inconclusive"
  | "blocked";

export interface ReleaseDocumentationReadinessFindingV1 {
  id: string;
  category: ReleaseDocumentationReadinessCategory;
  state: ReleaseDocumentationReadinessFindingState;
  targetId: string;
  stableGapId: string;
  evidence: {
    boundedSearchEvidenceSha256: string;
    repositoryPaths: string[];
    negativeObservationSha256: string | null;
    limitationSha256s: string[];
    inventorySha256: string;
    requestSetSha256: string;
    batchEvidenceSha256: string;
    resultEvidenceSha256s: string[];
  };
  findingSha256: string;
}

export interface ReleaseDocumentationWorkUnitV1 {
  id: string;
  targetId: string;
  priority: "P0" | "P1" | "P2";
  rationale: string;
  dependencies: string[];
  acceptanceCriteria: string[];
  verification: string[];
  requiredHumanInput: string[];
  trackerMutation: "not-authorized";
  workUnitSha256: string;
}

export interface ReleaseDocumentationReadinessArtifactV1 {
  schemaVersion: 1;
  kind: "docsfab-release-documentation-readiness";
  workflow: "release-documentation-readiness";
  repositoryRevision: string;
  repositoryIdentitySha256: string;
  repositoryTargetSha256: string;
  repositoryInventorySha256: string;
  repositoryBatchAuthoritySha256: string;
  workflowSearchEvidenceSha256: string;
  gapLedgerSha256: string;
  disposition: "ready" | "not-ready" | "inconclusive" | "blocked";
  findings: ReleaseDocumentationReadinessFindingV1[];
  workUnits: ReleaseDocumentationWorkUnitV1[];
  downstreamConsumers: ["#43", "#46"];
  trackerMutation: "not-authorized";
  artifactSha256: string;
}
