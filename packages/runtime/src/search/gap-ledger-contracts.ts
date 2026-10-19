// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SearchDisposition, SearchLimitationCategory } from "./bounded-search-contracts.js";

type DocumentationWorkflowName =
  | "readiness"
  | "release-documentation-readiness"
  | "audit-documentation"
  | "foundation"
  | "bootstrap"
  | "ia-analysis"
  | "ia-plan"
  | "site-bootstrap"
  | "foundation-to-patch"
  | "review-documentation"
  | "create-documentation"
  | "update-documentation"
  | "restructure-documentation"
  | "live-agent-turn"
  | "reconcile-product-behavior";

export type DocumentationGapState = "open" | "resolved" | "satisfied" | "inconclusive" | "blocked";

export interface DocumentationSearchFindingV1 {
  schemaVersion: 1;
  kind: "docsfab-documentation-search-finding";
  source: {
    workflow: DocumentationWorkflowName;
    stepId: string;
    planId: string;
    planVersion: string;
    workflowSearchEvidenceSha256: string;
  };
  stableGapId: string;
  requirement: {
    id: string;
    subjectSha256: string;
  };
  target: {
    id: string;
    targetType: "artifact-existence" | "rubric-coverage";
    targetSha256: string;
    policySha256: string;
  };
  probeCoverage: {
    requiredProbeIds: string[];
    completedProbeIds: string[];
    incompleteProbeIds: string[];
    probes: Array<{
      id: string;
      outcome: "match" | "no-match" | "inconclusive" | "blocked";
      probeSha256: string;
      evidenceSha256: string;
    }>;
    sufficient: boolean;
    coverageSha256: string;
  };
  disposition: SearchDisposition;
  findingClass: "presence" | "absence" | "inconclusive" | "blocked";
  confidence: {
    level: "confirmed" | "bounded" | "inconclusive" | "blocked";
    saturation: "saturated" | "productive" | "not-observed";
    confidenceSha256: string;
  };
  limitations: Array<{
    id: string;
    category: SearchLimitationCategory;
    impact: "non-blocking" | "blocking";
    probeIds: string[];
    detailSha256: string;
    limitationSha256: string;
  }>;
  evidenceIdentity: {
    repositoryIdentitySha256: string;
    repositoryRevision: string;
    workspaceSnapshotSha256: string;
    boundedSearchEvidenceSha256: string;
    searchFindingSha256: string;
  };
  observationSha256: string;
}

export type DocumentationNegativeEvidenceV1 = DocumentationSearchFindingV1;

export interface DocumentationGapReconciliationV1 {
  schemaVersion: 1;
  kind: "docsfab-documentation-gap-reconciliation";
  stableGapId: string;
  status: "found" | "fixed" | "verified";
  repositoryRevision: string;
  negativeObservationSha256: string;
  evidenceObservationSha256: string;
  evidenceSha256: string;
  previousReconciliationSha256: string | null;
  reconciliationSha256: string;
}

export interface DocumentationGapLedgerEntryV1 {
  schemaVersion: 1;
  kind: "docsfab-documentation-gap-entry";
  stableGapId: string;
  requirement: DocumentationSearchFindingV1["requirement"];
  policySha256: string;
  observations: DocumentationSearchFindingV1[];
  currentObservationSha256: string;
  state: DocumentationGapState;
  reconciliations: DocumentationGapReconciliationV1[];
  entrySha256: string;
}

export interface DocumentationGapLedgerV1 {
  schemaVersion: 1;
  kind: "docsfab-documentation-gap-ledger";
  repositoryIdentitySha256: string;
  currentRevision: string;
  entries: DocumentationGapLedgerEntryV1[];
  ledgerSha256: string;
}

export interface DocumentationGapRoadmapProposalV1 {
  schemaVersion: 1;
  kind: "docsfab-documentation-gap-roadmap-proposal";
  proposalId: string;
  stableGapId: string;
  repositoryRevision: string;
  requirement: DocumentationSearchFindingV1["requirement"];
  sourceLedgerSha256: string;
  sourceObservationSha256: string;
  disposition: "not-found-after-bounded-search";
  lifecycle: "proposed";
  trackerMutation: "not-authorized";
  proposalSha256: string;
}
