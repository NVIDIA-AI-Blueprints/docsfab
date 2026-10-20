// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ArtifactEnvelope,
  ArtifactEvidence,
  OntologyEntityKind,
  OrganizingAxis,
} from "../artifacts/contracts.js";
import type { ContentIndexV1, RepositoryIdentity } from "../content-ir/contracts.js";

export const IA_DIAGNOSTIC_RULES = [
  "one-axis-per-sibling-set",
  "excessive-fan-out",
  "single-child-group",
  "mixed-node-kinds",
  "undeclared-axis-shift",
  "orphan-topic",
  "multiple-parents",
  "empty-overview",
  "unsupported-catch-all",
  "severe-imbalance",
  "mixed-purpose-page",
  "missing-top-level-evidence",
  "missing-throughline",
  "missing-page-classification",
  "missing-sibling-set",
] as const;
export type IaDiagnosticRule = (typeof IA_DIAGNOSTIC_RULES)[number];

export const IA_DIAGNOSTIC_SEVERITIES = ["advisory", "blocking"] as const;
export type IaDiagnosticSeverity = (typeof IA_DIAGNOSTIC_SEVERITIES)[number];

export const IA_RECOVERY_ACTIONS = [
  "declare-one-sibling-axis",
  "split-group",
  "collapse-single-child-group",
  "separate-node-kinds",
  "declare-secondary-axis",
  "assign-topic",
  "choose-canonical-parent",
  "add-overview",
  "rename-group-or-add-exception",
  "rebalance-groups",
  "split-mixed-purpose-page",
  "add-repository-evidence",
  "state-ontology-throughline",
  "classify-page",
  "declare-sibling-set",
] as const;
export type IaRecoveryAction = (typeof IA_RECOVERY_ACTIONS)[number];

export const IA_PAGE_PURPOSES = ["single-purpose", "mixed-purpose", "reference-catalog"] as const;
export type IaPagePurpose = (typeof IA_PAGE_PURPOSES)[number];

/** Closed semantic kinds used only for comparing siblings. */
export const IA_SIBLING_NODE_KINDS = [
  "task",
  "concept",
  "component",
  "reference",
  "persona",
  "gateway",
] as const;
export type IaSiblingNodeKind = (typeof IA_SIBLING_NODE_KINDS)[number];

export const IA_EXCEPTION_REASONS = [
  "external-standard",
  "legacy-url-contract",
  "temporary-migration",
] as const;
export type IaExceptionReason = (typeof IA_EXCEPTION_REASONS)[number];

/**
 * Candidate-v1 does not encode hierarchy, overview ownership, page purpose, or
 * a group's stated throughline. This closed projection supplies only those
 * structured facts. Every declaration carries revision-bound node evidence.
 */
export interface IaSiblingSetDeclaration {
  id: string;
  parentId: string;
  groupIds: string[];
  declaredAxis: OrganizingAxis;
  evidence: ArtifactEvidence[];
}

export interface IaOverviewDeclaration {
  groupId: string;
  nodeId: string;
  evidence: ArtifactEvidence[];
}

export interface IaThroughlineDeclaration {
  groupId: string;
  /** A validated entity in the revision-bound ontology artifact. */
  entityId: string;
  evidence: ArtifactEvidence[];
}

export interface IaPageClassification {
  nodeId: string;
  purpose: IaPagePurpose;
  siblingKind: IaSiblingNodeKind;
  evidence: ArtifactEvidence[];
}

export interface IaDiagnosticException {
  rule: "unsupported-catch-all";
  nodeId: string;
  reason: IaExceptionReason;
  evidence: ArtifactEvidence[];
}

export interface IaStructuralProjection {
  /** Closed set of topic nodes that the candidate is responsible for placing. */
  topicNodeIds: string[];
  siblingSets: IaSiblingSetDeclaration[];
  overviews: IaOverviewDeclaration[];
  throughlines: IaThroughlineDeclaration[];
  pageClassifications: IaPageClassification[];
  exceptions: IaDiagnosticException[];
}

export interface IaDiagnosticPolicy {
  id: string;
  version: string;
  digest: string;
  maxFanOut: number;
  severeImbalanceRatio: number;
  minOverviewBytes: number;
  unsupportedLabels: string[];
}

export const DEFAULT_IA_DIAGNOSTIC_POLICY: IaDiagnosticPolicy = {
  id: "docsfab:ia-structural-diagnostics",
  version: "1",
  digest: "0f2fa3c1c37401ce7109c505fb8c454ca6eacbb791ea77154aa44c94c83d3d36",
  maxFanOut: 12,
  severeImbalanceRatio: 4,
  minOverviewBytes: 1,
  unsupportedLabels: ["general", "misc", "miscellaneous", "other"],
};

export interface IaDiagnosticEvaluationInput {
  /** ContentIndex and artifacts must have been validated for one immutable revision. */
  index: ContentIndexV1;
  ontology: ArtifactEnvelope<"ontology">;
  candidates: ArtifactEnvelope<"ia-candidates">;
  semantics: readonly ArtifactEnvelope<"context-packet">[];
  candidateId: string;
  structure: IaStructuralProjection;
  policy: IaDiagnosticPolicy;
}

export interface IaDiagnosticRecovery {
  action: IaRecoveryAction;
  targetNodeIds: string[];
}

export interface IaDiagnostic {
  rule: IaDiagnosticRule;
  severity: IaDiagnosticSeverity;
  /** Exact candidate group, sibling set, topic, or page that failed the rule. */
  nodeId: string;
  relatedNodeIds: string[];
  evidence: ArtifactEvidence[];
  recovery: IaDiagnosticRecovery;
}

export type IaDiagnosticsStatus = "passed" | "failed";
export type IaDiagnosticsHighestSeverity = "none" | IaDiagnosticSeverity;

export interface IaDiagnosticsReport {
  schemaVersion: 1;
  repository: RepositoryIdentity;
  candidateId: string;
  status: IaDiagnosticsStatus;
  highestSeverity: IaDiagnosticsHighestSeverity;
  diagnostics: IaDiagnostic[];
  summary: {
    rulesEvaluated: number;
    blocking: number;
    advisory: number;
  };
  provenance: {
    indexDigest: string;
    ontologyDigest: string;
    candidatesDigest: string;
    semanticDigests: string[];
    policy: IaDiagnosticPolicy;
  };
}

export class IaDiagnosticsInputError extends Error {
  public constructor(
    public readonly code:
      | "invalid-artifact"
      | "candidate-unresolved"
      | "invalid-policy"
      | "invalid-projection"
      | "repository-mismatch",
    public readonly path: string,
  ) {
    super(`Invalid IA diagnostics input (${code}) at ${path}.`);
    this.name = "IaDiagnosticsInputError";
  }
}

/** Exported so downstream scoring can share an explicit ontology mapping. */
export const IA_ONTOLOGY_KIND_TO_SIBLING_KIND = {
  actor: "persona",
  "user-job": "task",
  "workflow-stage": "task",
  capability: "task",
  concept: "concept",
  component: "component",
  resource: "reference",
  artifact: "reference",
  configuration: "component",
  constraint: "reference",
  "failure-mode": "task",
  outcome: "concept",
} as const satisfies Record<OntologyEntityKind, IaSiblingNodeKind>;
