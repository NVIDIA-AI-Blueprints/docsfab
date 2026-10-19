// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ContentFormat } from "../content-ir/contracts.js";
import type {
  RepositoryNavigationObservationRouteV1,
  RepositoryNavigationObservationSourceV1,
} from "./navigation-observation.js";

/** Closed axis plus the actual observation that crossed it. */
export interface RepositoryInventoryOverflowV1 {
  readonly limitName: string;
  readonly observed?: number;
}

type InventoryReleaseDocumentationContentClass =
  | "launch-audiences"
  | "personas"
  | "user-jobs"
  | "site-templates"
  | "public-information-architecture"
  | "installation"
  | "quickstart"
  | "first-success"
  | "task-guides"
  | "cli-reference"
  | "configuration-reference"
  | "api-reference"
  | "troubleshooting"
  | "failure-modes"
  | "security"
  | "limitations"
  | "trust-boundaries"
  | "releases"
  | "compatibility"
  | "support"
  | "lifecycle"
  | "ownership"
  | "freshness"
  | "review-policy"
  | "human-decisions";

type InventoryReleaseDecisionsPath = ".docsfab-release-documentation-decisions.json";

export type RepositoryInventoryCoverageKind = "structure" | "text" | "navigation" | "metadata";

export type RepositoryInventoryFailureCategory =
  | "content-index-incomplete"
  | "entry-limit-exceeded"
  | "entry-redacted"
  | "invalid-package-metadata"
  | "invalid-text-input"
  | "navigation-observation-incomplete"
  | "oversize-input"
  | "tracked-file-changed"
  | "tracked-file-unreadable"
  | "text-index-limit-exceeded"
  | "unsupported-text-format"
  | "unsafe-tracked-entry"
  | "unsupported-document-format";

export interface RepositoryInventoryFailureV1 {
  category: RepositoryInventoryFailureCategory;
  affects: RepositoryInventoryCoverageKind[];
  path?: string;
  evidenceSha256: string;
  /** Closed navigation or inventory axis when this failure recorded overflow. */
  overflow?: RepositoryInventoryOverflowV1;
}

export interface RepositoryInventoryFileV1 {
  id: string;
  path: string;
  kind: "regular" | "symlink" | "submodule";
  byteLength: number | null;
  evidenceSha256: string;
}

export interface RepositoryInventoryCoverageV1 {
  policy:
    | "tracked-tree-v1"
    | "tracked-regular-utf8-v1"
    | "content-ir-graph-v2"
    | "repository-navigation-observation-v1"
    | "repository-metadata-v1";
  status: "complete" | "incomplete";
  indexedCount: number;
  excludedCount: number;
  omittedCount: number;
  evidenceSha256: string;
}

export interface RepositoryInventoryNavigationV1 {
  id: string;
  status: "complete" | "incomplete";
  graphEdgeCount: number;
  navigationEdgeCount: number;
  paths: string[];
  sources?: RepositoryNavigationObservationSourceV1[];
  routes?: RepositoryNavigationObservationRouteV1[];
  evidenceSha256: string;
}

export interface RepositoryInventoryDocumentV1 {
  id: string;
  path: string;
  format: ContentFormat | "rst";
  depth: number;
  parent: string | null;
  candidateAudience: "public" | "internal";
  evidenceSha256: string;
}

export interface RepositoryInventoryDocumentProfileV2 {
  id: string;
  path: string;
  contentClasses: InventoryReleaseDocumentationContentClass[];
  byteLength: number;
  sectionCount: number;
  maximumSectionDepth: number;
  substantiveSectionCount: number;
  procedureStepCount: number;
  codeBlockCount: number;
  incomingRelationshipCount: number;
  outgoingRelationshipCount: number;
  navigationRelationshipCount: number;
  evidenceSha256: string;
}

export interface RepositoryInventoryDecisionFactV2 {
  id: string;
  topic: string;
  status: "approved" | "unknown";
  path: InventoryReleaseDecisionsPath;
  evidenceSha256: string;
}

export interface RepositoryInventorySignalV1 {
  id: string;
  category: "site-generator" | "ci-validation" | "configuration" | "dependency";
  name: string;
  paths: string[];
  evidenceSha256: string;
}

export interface RepositoryInventoryCommandV1 {
  id: string;
  purpose: "build" | "docs-build" | "lint" | "link-check" | "test" | "other";
  invocation: string;
  packagePath: string;
  evidenceSha256: string;
}

export interface RepositoryInstructionScopeV1 {
  id: string;
  path: string;
  scope: string;
  evidenceSha256: string;
}

export interface RepositoryDiscoveryInventoryV1 {
  schemaVersion: 1 | 2;
  kind: "docsfab-repository-discovery-inventory";
  repositoryRevision: string;
  structuralSha256: string;
  inventorySha256: string;
  status: "complete" | "incomplete";
  coverage: {
    structure: RepositoryInventoryCoverageV1;
    text: RepositoryInventoryCoverageV1;
    navigation: RepositoryInventoryCoverageV1;
    metadata: RepositoryInventoryCoverageV1;
  };
  contentIndex: {
    status: "complete" | "incomplete";
    indexSha256: string | null;
    documentCount: number;
    sectionCount: number;
    edgeCount: number;
  };
  files: RepositoryInventoryFileV1[];
  navigation: RepositoryInventoryNavigationV1;
  documents: RepositoryInventoryDocumentV1[];
  signals: RepositoryInventorySignalV1[];
  commands: RepositoryInventoryCommandV1[];
  instructionScopes: RepositoryInstructionScopeV1[];
  documentProfiles?: RepositoryInventoryDocumentProfileV2[];
  decisionFacts?: RepositoryInventoryDecisionFactV2[];
  failures: RepositoryInventoryFailureV1[];
}

export type RepositoryBatchProbeQuestionV1 =
  | { kind: "filename"; name: string }
  | { kind: "exact-path"; path: string }
  | { kind: "path-segment"; segment: string }
  | { kind: "literal-text"; value: string }
  | {
      kind: "document-profile";
      contentClass: InventoryReleaseDocumentationContentClass;
      minByteLength: number;
      minSectionCount: number;
      minSubstantiveSectionCount: number;
      minRelationshipCount: number;
      minProcedureStepCount: number;
      minCodeBlockCount: number;
    }
  | { kind: "decision-status"; topic: string; status: "approved" }
  | {
      kind: "unsupported";
      operation: "semantic-assessment" | "unrestricted-pattern";
    }
  | {
      kind: "metadata";
      field:
        | "documentation"
        | "conventional-entrypoint"
        | "site-generator"
        | "build-command"
        | "command"
        | "lint-command"
        | "link-check-command"
        | "ci-validation"
        | "instruction-scope"
        | "public-candidate"
        | "internal-candidate"
        | "dependency"
        | "configuration"
        | "navigation-graph";
    };

export interface RepositoryBatchProbeRequestV1 {
  id: string;
  question: RepositoryBatchProbeQuestionV1;
}

export interface RepositoryBatchProbeResultV1 {
  id: string;
  requestSha256: string;
  disposition: "found" | "not-found-after-bounded-search" | "incomplete" | "unsupported";
  failureCategory:
    | "structure-incomplete"
    | "text-index-incomplete"
    | "navigation-index-incomplete"
    | "metadata-index-incomplete"
    | "unsupported-question"
    | null;
  matchCount: number;
  evidenceIds: string[];
  paths: string[];
  evidenceSha256: string;
}

export interface RepositoryBatchProbeEvidenceV1 {
  schemaVersion: 1;
  kind: "docsfab-repository-batch-probe-evidence";
  targetId: string;
  targetSha256: string;
  repositoryRevision: string;
  inventorySha256: string;
  requestSetSha256: string;
  results: RepositoryBatchProbeResultV1[];
  evidenceSha256: string;
}

export interface RepositoryBatchReplayTargetAuthorityV1 {
  targetId: string;
  requests: RepositoryBatchProbeRequestV1[];
  evidence: RepositoryBatchProbeEvidenceV1;
}

export interface RepositoryBatchReplayAuthorityV1 {
  schemaVersion: 1;
  kind: "docsfab-repository-batch-replay-authority";
  repositoryIdentitySha256: string;
  repositoryRevision: string;
  inventory: RepositoryDiscoveryInventoryV1;
  targets: RepositoryBatchReplayTargetAuthorityV1[];
  authoritySha256: string;
}
