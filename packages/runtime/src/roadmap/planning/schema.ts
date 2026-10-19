// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RoadmapLedger, RoadmapProjectIdentity } from "../contracts/ledger.js";
import type { RoadmapMutationPlanV2 } from "../execution-v2.js";

export const ROADMAP_PLANNING_SCHEMA_VERSION = 1 as const;

export const ROADMAP_PLANNING_MODES = ["release", "health", "sweep"] as const;

export type RoadmapPlanningMode = (typeof ROADMAP_PLANNING_MODES)[number];

export const ROADMAP_PLANNING_DISPOSITIONS = [
  "documented",
  "no-doc-impact",
  "needs-update",
  "needs-new-doc",
  "healthy",
  "repair",
  "restructure",
  "investigate",
  "excluded",
  "blocked",
] as const;

export type RoadmapPlanningDisposition = (typeof ROADMAP_PLANNING_DISPOSITIONS)[number];

export interface RoadmapPlanningUnit {
  id: string;
  kind:
    | "change"
    | "commit"
    | "merge-request"
    | "doc-audit"
    | "structural"
    | "impact"
    | "repository";
  path: string;
  evidenceDigest: string;
  status?: "added" | "modified" | "deleted" | "renamed";
  previousPath?: string;
}

export interface RoadmapReleaseChange {
  status: "added" | "modified" | "deleted" | "renamed";
  path: string;
  previousPath?: string;
  evidenceDigest: string;
}

export interface RoadmapReleaseBoundaryAuthority {
  kind: "git-release-boundary";
  fromRevision: string;
  toRevision: string;
  fromTreeDigest: string;
  toTreeDigest: string;
  diffDigest: string;
  projectIdentityDigest: string;
  changes: RoadmapReleaseChange[];
  digest: string;
}

export interface RoadmapHealthAuditFinding {
  id: string;
  units: RoadmapPlanningUnit[];
  affectedPaths: string[];
  evidenceDigest: string;
  candidateDigest: string;
}

export interface RoadmapHealthAuditPackage {
  kind: "authenticated-doc-audit-package";
  schemaVersion: 1;
  runId: string;
  workflow: "review-documentation";
  status: "succeeded";
  repositoryRevision: string;
  repositoryContentDigest: string;
  projectIdentityDigest: string;
  scope?: string;
  findings: RoadmapHealthAuditFinding[];
  digest: string;
}

export interface RoadmapPlanningDraft {
  kind: "saga" | "issue" | "update" | "closeout" | "investigation";
  title: string;
  summary: string;
  acceptanceCriteria: string[];
  verification: string[];
  evidencePaths: string[];
  selfContained: boolean;
  requiredParentContext?: string;
}

export interface RoadmapPlanningRankInput {
  impact: number;
  urgency: number;
  dependency: number;
  scope: number;
  verificationCost: number;
  confidence: number;
}

export interface RoadmapPlanningCandidateInput {
  id: string;
  category: string;
  severity: "p0" | "p1" | "p2";
  disposition: RoadmapPlanningDisposition;
  unitIds: string[];
  affectedPaths: string[];
  evidenceDigest: string;
  rank: RoadmapPlanningRankInput;
  review: {
    disposition: "accepted" | "investigation" | "rejected";
    rationaleCode: string;
    evidenceDigest: string;
  };
  draft?: RoadmapPlanningDraft;
  dependsOnCandidateIds?: string[];
}

export interface RoadmapSemanticReconciliation {
  candidateId: string;
  issueIid: number;
  decision: "extend" | "supersede" | "conflict" | "unrelated";
  confidence: number;
  evidenceDigest: string;
}

export interface SanitizedRoadmapIssue {
  iid: number;
  state: "opened" | "closed";
  updatedAt: string;
  identityDigest: string;
  findingFingerprints: string[];
  materialEvidenceDigests: string[];
}

interface RoadmapPlanningInputBase {
  kind: "docsfab-roadmap-planning-input";
  schemaVersion: typeof ROADMAP_PLANNING_SCHEMA_VERSION;
  mode: RoadmapPlanningMode;
  repository: { revision: string; contentDigest: string };
  project: RoadmapProjectIdentity;
  observedAt: string;
  expiresAt: string;
  units: RoadmapPlanningUnit[];
  candidates: RoadmapPlanningCandidateInput[];
  semanticReconciliation: RoadmapSemanticReconciliation[];
  proposalCap: number;
}

export interface RoadmapReleasePlanningInput extends RoadmapPlanningInputBase {
  mode: "release";
  fromRevision: string;
  toRevision: string;
  releaseRef?: string;
  releasePackContractSha256: string;
  releaseBoundary: RoadmapReleaseBoundaryAuthority;
}

export interface RoadmapHealthPlanningInput extends RoadmapPlanningInputBase {
  mode: "health";
  scope?: string;
  docAudit: RoadmapHealthAuditPackage;
}

export interface RoadmapSweepPlanningInput extends RoadmapPlanningInputBase {
  mode: "sweep";
  baseLedger: RoadmapLedger;
}

export type RoadmapPlanningInput =
  | RoadmapReleasePlanningInput
  | RoadmapHealthPlanningInput
  | RoadmapSweepPlanningInput;

export interface RoadmapPlanningRankedProposal {
  candidateId: string;
  findingId: string;
  findingFingerprint: string;
  action: "create" | "extend" | "link" | "supersede" | "investigate" | "none";
  issueIid?: number;
  confidence: number;
  score: number;
  reasons: string[];
  operationKey?: string;
  draft?: RoadmapPlanningDraft;
}

export interface RoadmapPlanningArtifact {
  kind: "docsfab-roadmap-plan";
  schemaVersion: typeof ROADMAP_PLANNING_SCHEMA_VERSION;
  mode: RoadmapPlanningMode;
  readOnly: true;
  authorization: null;
  reconciliationOrder: ["deterministic", "semantic"];
  sourceDigest: string;
  sourceAuthorityId: string;
  ledger: RoadmapLedger;
  mutationPlan: RoadmapMutationPlanV2 | null;
  rankedProposals: RoadmapPlanningRankedProposal[];
  accountedUnitIds: string[];
  generatedAt: string;
  digest: string;
}
