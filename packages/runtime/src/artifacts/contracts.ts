// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ContentIndexV1,
  RepositoryIdentity,
  StructuralChangeRegion,
} from "../content-ir/contracts.js";
import type {
  ReaderContextComparisonV1,
  ReaderContextImpactBasisV1,
} from "../context/reader-context.js";

export const ARTIFACT_KINDS = [
  "ontology",
  "context-packet",
  "ia-candidates",
  "ia-evaluation",
  "ia-plan",
  "impact-report",
  "healing-report",
  "navigation-evaluation",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * Durable roadmap state is referenced by runs but is not a semantic artifact
 * envelope. Keep these kinds out of ARTIFACT_KINDS so payload creation,
 * validation, migration, and storage remain closed to the semantic artifact set.
 */
export const ARTIFACT_REFERENCE_ONLY_KINDS = [
  "roadmap-ledger",
  "roadmap-mutation-plan",
  "roadmap-host-operation-request",
  "editorial-decision",
  "review-result",
  "review-delivery-intent",
] as const;

export const ARTIFACT_REFERENCE_KINDS = [
  ...ARTIFACT_KINDS,
  ...ARTIFACT_REFERENCE_ONLY_KINDS,
] as const;
export type ArtifactReferenceKind = (typeof ARTIFACT_REFERENCE_KINDS)[number];

export const ONTOLOGY_ENTITY_KINDS = [
  "actor",
  "user-job",
  "workflow-stage",
  "capability",
  "concept",
  "component",
  "resource",
  "artifact",
  "configuration",
  "constraint",
  "failure-mode",
  "outcome",
] as const;
export type OntologyEntityKind = (typeof ONTOLOGY_ENTITY_KINDS)[number];

export const ONTOLOGY_RELATIONSHIPS = [
  "is-a",
  "part-of",
  "requires",
  "precedes",
  "operates-on",
  "consumes",
  "produces",
  "configures",
  "validates",
  "fails-with",
  "resolved-by",
  "documented-by",
] as const;
export type OntologyRelationshipKind = (typeof ONTOLOGY_RELATIONSHIPS)[number];

export const CONTENT_TYPES = [
  "explanation",
  "tutorial",
  "how-to",
  "reference",
  "troubleshooting",
] as const;
export type DocumentationContentType = (typeof CONTENT_TYPES)[number];

export const ORGANIZING_AXES = [
  "reader-job",
  "lifecycle",
  "capability",
  "resource",
  "persona",
  "environment",
  "component",
] as const;
export type OrganizingAxis = (typeof ORGANIZING_AXES)[number];

export const STRUCTURAL_PRESSURES = ["healthy", "elevated", "critical"] as const;
export type StructuralPressure = (typeof STRUCTURAL_PRESSURES)[number];

export const IA_SCOPES = ["site", "section", "page"] as const;
export type IaScope = (typeof IA_SCOPES)[number];

export const IA_DECISION_KINDS = [
  "axis",
  "placement",
  "canonical-home",
  "label",
  "redirect",
] as const;
export type IaDecisionKind = (typeof IA_DECISION_KINDS)[number];

export const CANDIDATE_REJECTION_REASONS = [
  "lower-score",
  "insufficient-evidence",
  "mixed-axis",
  "unstable-urls",
  "ambiguous-placement",
  "policy-conflict",
] as const;
export type CandidateRejectionReason = (typeof CANDIDATE_REJECTION_REASONS)[number];

export const APPROVAL_REQUIREMENTS = ["none", "maintainer", "product-owner"] as const;
export type ApprovalRequirement = (typeof APPROVAL_REQUIREMENTS)[number];

export const PLAN_APPROVAL_STATUSES = [
  "pending",
  "approved",
  "changes-requested",
  "rejected",
] as const;
export type PlanApprovalStatus = (typeof PLAN_APPROVAL_STATUSES)[number];

export const OUTPUT_OPERATIONS = [
  "create",
  "update",
  "rename",
  "move",
  "delete",
  "redirect",
] as const;
export type OutputOperation = (typeof OUTPUT_OPERATIONS)[number];

export const PAGE_DISPOSITIONS = [
  "keep",
  "rename",
  "move",
  "split",
  "merge",
  "cross-link",
  "archive",
  "needs-human-decision",
] as const;
export type PageDisposition = (typeof PAGE_DISPOSITIONS)[number];

export const NAVIGATION_PRESSURES = ["healthy", "elevated", "critical"] as const;
export type NavigationPressure = (typeof NAVIGATION_PRESSURES)[number];

export const SEMANTIC_IMPACTS = ["none", "localized", "cross-cutting"] as const;
export type SemanticImpact = (typeof SEMANTIC_IMPACTS)[number];

export const HEALING_LEVELS = [
  "observe",
  "bounded-repair",
  "structural-proposal",
  "ontology-review",
] as const;
export type HealingLevel = (typeof HEALING_LEVELS)[number];

export const NAVIGATION_OUTCOMES = ["matched", "missed", "ambiguous", "no-result"] as const;
export type NavigationOutcome = (typeof NAVIGATION_OUTCOMES)[number];

export const ARTIFACT_USE_ROLES = ["input", "output"] as const;
export type ArtifactUseRole = (typeof ARTIFACT_USE_ROLES)[number];

export interface ArtifactEvidence {
  path: string;
  nodeId: string;
}

export interface OntologyEntity {
  id: string;
  label: string;
  kind: OntologyEntityKind;
  evidence: ArtifactEvidence[];
}

export interface OntologyRelationship {
  subject: string;
  predicate: OntologyRelationshipKind;
  object: string;
  evidence: ArtifactEvidence[];
}

export interface OntologyPayload {
  entities: OntologyEntity[];
  relationships: OntologyRelationship[];
}

export interface ContextPageRole {
  contentType: DocumentationContentType;
  readerJob: string;
  canonicalParentId?: string;
  organizingAxis: OrganizingAxis;
}

export interface PlacementRules {
  belongsHere: string[];
  belongsElsewhere: string[];
}

export interface ContextPacketPayload {
  targetNodeId: string;
  pageRole: ContextPageRole;
  ancestors: string[];
  siblings: string[];
  relatedCanonicalPages: string[];
  placementRules: PlacementRules;
  activeDecisionIds: string[];
  structuralPressure: StructuralPressure;
  evidence: ArtifactEvidence[];
}

export interface IaGroup {
  id: string;
  label: string;
  axis: OrganizingAxis;
  members: string[];
  canonicalPath: string;
  evidence: ArtifactEvidence[];
}

export interface IaCandidate {
  id: string;
  primaryAxis: OrganizingAxis;
  secondaryAxes: OrganizingAxis[];
  score: number;
  groups: IaGroup[];
  evidence: ArtifactEvidence[];
}

export interface RejectedCandidate {
  candidateId: string;
  reason: CandidateRejectionReason;
}

export interface OpenIaDecision {
  id: string;
  kind: IaDecisionKind;
  evidence: ArtifactEvidence[];
}

export interface IaCandidatesPayload {
  scope: IaScope;
  targetNodeId?: string;
  candidates: IaCandidate[];
  recommendedCandidateId: string;
  rejectedCandidates: RejectedCandidate[];
  openDecisions: OpenIaDecision[];
}

export interface IaUseCase {
  id: string;
  actor: string;
  trigger: string;
  goal: string;
  input: string;
  outcome: string;
  evidence: ArtifactEvidence[];
}

export interface RedirectConsequence {
  from: string;
  to: string;
}

export interface InboundLinkConsequence {
  nodeId: string;
  disposition: PageDisposition;
}

export interface PolicyBinding {
  id: string;
  version: string;
  digest: string;
}

export interface PlanApproval {
  requirement: ApprovalRequirement;
  status: PlanApprovalStatus;
  approvedBy?: string;
  approvedAt?: string;
}

export interface PlanOutput {
  path: string;
  operation: OutputOperation;
}

export const IA_PLAN_MODES = ["create", "reevaluate"] as const;
export type IaPlanMode = (typeof IA_PLAN_MODES)[number];

export interface IaPlannedPage {
  topicId: string;
  title: string;
  slug: string;
  templateId: string;
  format: "gfm" | "myst";
  outputPath: string;
  evidence: ArtifactEvidence[];
}

export interface IaMigrationDisposition {
  nodeId: string;
  disposition: PageDisposition;
  destinationPaths: string[];
  relatedNodeIds: string[];
  evidence: ArtifactEvidence[];
}

export interface ArtifactReference<K extends ArtifactReferenceKind = ArtifactReferenceKind> {
  kind: K;
  /** Runtime decoding admits only the known kind/version pairs. */
  schemaVersion: 1 | 3;
  digest: string;
  repositoryRevision: string;
  repositoryContentDigest: string;
}

/** Ratified editorial pair. Its domain body remains schema version 1. */
export type EditorialDecisionArtifactReferenceV3 = ArtifactReference<"editorial-decision"> & {
  schemaVersion: 3;
};

/** Content-free reference from retained final decision bytes to one sealed branch coverage. */
export interface WorkflowBranchCoverageReferenceV1 {
  schemaVersion: 1;
  kind: "docsfab-workflow-branch-coverage-reference";
  coverageSha256: string;
}

export const EDITORIAL_DECISION_CANDIDATES = [
  "update",
  "no-change",
  "insufficient-evidence",
] as const;
export type EditorialDecisionCandidateV1 = (typeof EDITORIAL_DECISION_CANDIDATES)[number];

/** Host-bound semantic consequence of one rejected independent assessment. */
export interface EditorialDecisionAssessmentRecommendationV1 {
  candidate: "update" | "insufficient-evidence";
  kind: "product-gap" | "evidence-limitation";
  /** Closed typed code retained in the final decision limitations. */
  code: string;
  /** Digest of the substantive assessment rationale retained by the host. */
  rationaleSha256: string;
}

/** Completed host-owned reader intent and original candidate supplied to each selected suffix. */
export interface EditorialCandidateContextV1 {
  reference: EditorialDecisionArtifactReferenceV3;
  proposal: EditorialDecisionProposalV1;
}

/** Untrusted planner output. The host supplies every identity, phase and seal. */
export interface EditorialDecisionProposalV1 {
  schemaVersion: 1;
  kind: "docsfab-editorial-decision-proposal";
  candidate: EditorialDecisionCandidateV1;
  rationale: string;
  evidenceRefs: ArtifactReference[];
  limitations: string[];
  impactBasis: ReaderContextImpactBasisV1;
}

export interface EditorialDecisionPayloadV1 {
  schemaVersion: 1;
  kind: "docsfab-editorial-decision";
  phase: "candidate" | "validated";
  candidateArtifact: EditorialDecisionArtifactReferenceV3 | null;
  branchCoverage: WorkflowBranchCoverageReferenceV1 | null;
  candidate: EditorialDecisionCandidateV1;
  repositoryRevision: string;
  workspaceSnapshotSha256: string;
  readerProvenanceSha256: string;
  planBindingSha256: string;
  policySha256: string;
  comparison: ReaderContextComparisonV1;
  rationaleSha256: string;
  evidenceRefs: ArtifactReference[];
  limitations: string[];
  decisionSha256: string;
}

export interface EditorialDecisionProducerProvenanceV1 {
  stepId:
    | "plan-documentation"
    | "verify-technical-accuracy"
    | "review-documentation"
    | "test-audience-understanding"
    | "evaluate-document-quality";
  skill: string;
  mode: "read-only";
  status: "succeeded";
  repositoryRevision: string;
  workspaceSnapshotSha256: string;
  /** Host-admitted semantic result for this evidence producer. */
  assessment: "accepted" | "rejected" | "not-applicable";
  /** Present exactly when the actual assessment rejected the original candidate. */
  recommendation: EditorialDecisionAssessmentRecommendationV1 | null;
}

export interface ResolvedEditorialDecisionEvidenceV1 {
  /** Exact reference the host resolver admitted. */
  reference: ArtifactReference;
  /** Exact retained bytes. The decoder never accepts a reference-only resolution. */
  bytes: Uint8Array;
  /** Actual step associations reconstructed by the host from retained run evidence. */
  producers: EditorialDecisionProducerProvenanceV1[];
}

export interface ResolvedEditorialDecisionRationaleV1 {
  /** Exact retained generated rationale bytes. */
  bytes: Uint8Array;
  /** Genuine admitted evidence identity this rationale was produced from. */
  boundReference: ArtifactReference;
  producer: EditorialDecisionProducerProvenanceV1;
}

export interface EditorialDecisionArtifactResolverV1 {
  resolve(reference: ArtifactReference): ResolvedEditorialDecisionEvidenceV1;
  resolveRationale(rationaleSha256: string): ResolvedEditorialDecisionRationaleV1;
}

/** Host-owned semantic decoder for each non-editorial artifact/domain record. */
export interface EditorialDecisionEvidenceValidatorV1 {
  validate(reference: ArtifactReference, bytes: Uint8Array): void;
}

/** Process-local host validator backed by the admitted run/step record. */
export interface EditorialDecisionProducerValidatorV1 {
  validate(
    producer: EditorialDecisionProducerProvenanceV1,
    boundReference: ArtifactReference | null,
  ): void;
}

export interface ArtifactUse {
  role: ArtifactUseRole;
  stepId?: string;
  reference: ArtifactReference;
}

export interface IaPlanPayload {
  planId: string;
  candidateId: string;
  candidateArtifact: ArtifactReference<"ia-candidates">;
  scope: IaScope;
  targetNodeId?: string;
  primaryAxis: OrganizingAxis;
  secondaryAxes: OrganizingAxis[];
  groups: IaGroup[];
  useCases: IaUseCase[];
  rejectedCandidates: RejectedCandidate[];
  openDecisions: OpenIaDecision[];
  redirects: RedirectConsequence[];
  inboundLinkConsequences: InboundLinkConsequence[];
  navigationEvaluation: ArtifactReference<"navigation-evaluation">;
  policyBindings: PolicyBinding[];
  approval: PlanApproval;
  expiresAt: string;
  supersedes?: ArtifactReference<"ia-plan">;
  outputScope: PlanOutput[];
  /** Complete planning fields; legacy v1 plans may omit this set only as a whole. */
  mode?: IaPlanMode;
  iaEvaluation?: ArtifactReference<"ia-evaluation">;
  plannedPages?: IaPlannedPage[];
  migrationDispositions?: IaMigrationDisposition[];
}

export interface OntologyDelta {
  addedEntityIds: string[];
  removedEntityIds: string[];
  changedEntityIds: string[];
  addedRelationshipCount: number;
  removedRelationshipCount: number;
}

export interface ImpactReportPayload {
  beforeRepository: RepositoryIdentity;
  afterRepository: RepositoryIdentity;
  beforeIndexDigest: string;
  afterIndexDigest: string;
  changedPaths: string[];
  structuralRegions: StructuralChangeRegion[];
  ontologyDelta: OntologyDelta;
  affectedNodeIds: string[];
  navigationPressure: NavigationPressure;
  semanticImpact: SemanticImpact;
  recommendedAction: HealingLevel;
  requiredApproval: ApprovalRequirement;
  evidence: ArtifactEvidence[];
}

export interface HealingRecommendation {
  id: string;
  level: HealingLevel;
  disposition: PageDisposition;
  targetNodeIds: string[];
  outputPaths: string[];
  evidence: ArtifactEvidence[];
}

export interface HealingReportPayload {
  impactReport: ArtifactReference<"impact-report">;
  recommendations: HealingRecommendation[];
  requiredApproval: ApprovalRequirement;
}

export interface NavigationTask {
  id: string;
  query: string;
  expectedNodeIds: string[];
  acceptableNodeIds: string[];
}

export interface NavigationResult {
  taskId: string;
  rankedNodeIds: string[];
  outcome: NavigationOutcome;
}

export interface NavigationMetrics {
  taskCount: number;
  agreementRate: number;
  recallAt3: number;
  meanReciprocalRank: number;
  noResultRate: number;
  ambiguousPlacementRate: number;
}

export interface NavigationEvaluationPayload {
  tasks: NavigationTask[];
  results: NavigationResult[];
  metrics: NavigationMetrics;
}

export const IA_EVALUATION_STATUSES = ["passed", "failed"] as const;
export type IaEvaluationStatus = (typeof IA_EVALUATION_STATUSES)[number];

export interface IaEvaluationScores {
  evidenceCoverage: number;
  cohesion: number;
  separation: number;
  predictability: number;
  balance: number;
  stability: number;
  duplication: number;
  total: number;
  structuralFindability: number;
}

/** Revision-bound deterministic evidence used by later approval/scaffolding gates. */
export interface IaEvaluationPayload {
  candidateArtifact: ArtifactReference<"ia-candidates">;
  candidateId: string;
  diagnosticsDigest: string;
  scoringDigest: string;
  topologyDigest: string;
  navigationComparisonDigest: string;
  navigationEvaluation: ArtifactReference<"navigation-evaluation">;
  navigationSuite: PolicyBinding;
  scores: IaEvaluationScores;
  deterministicStatus: IaEvaluationStatus;
  eligible: boolean;
  blockingDiagnosticDigests: string[];
  policyBindings: PolicyBinding[];
  evidence: ArtifactEvidence[];
}

export interface ArtifactPayloadByKind {
  ontology: OntologyPayload;
  "context-packet": ContextPacketPayload;
  "ia-candidates": IaCandidatesPayload;
  "ia-evaluation": IaEvaluationPayload;
  "ia-plan": IaPlanPayload;
  "impact-report": ImpactReportPayload;
  "healing-report": HealingReportPayload;
  "navigation-evaluation": NavigationEvaluationPayload;
}

export interface ArtifactEnvelope<
  K extends ArtifactKind = ArtifactKind,
  P = ArtifactPayloadByKind[K],
> {
  schemaVersion: 1;
  kind: K;
  repository: RepositoryIdentity;
  digest: string;
  payload: P;
}

export type Artifact = {
  [K in ArtifactKind]: ArtifactEnvelope<K, ArtifactPayloadByKind[K]>;
}[ArtifactKind];

export type IaPlanArtifact = ArtifactEnvelope<"ia-plan", IaPlanPayload>;
export type IaEvaluationArtifact = ArtifactEnvelope<"ia-evaluation", IaEvaluationPayload>;
export type NavigationEvaluationArtifact = ArtifactEnvelope<
  "navigation-evaluation",
  NavigationEvaluationPayload
>;
export type PlanState =
  | "active"
  | "unapproved"
  | "changes-requested"
  | "rejected"
  | "expired"
  | "superseded";

export interface ArtifactValidationOptions {
  index: ContentIndexV1;
  beforeIndex?: ContentIndexV1;
  now?: Date;
  activePlan?: IaPlanArtifact;
  /** Planning may inspect inactive plans; apply callers retain active-only default. */
  planAcceptance?: "active" | "any";
}

export interface ArtifactReferenceValidationOptions {
  index?: ContentIndexV1;
  expectedKind?: ArtifactReferenceKind;
}

export interface CreateArtifactOptions {
  index: ContentIndexV1;
  beforeIndex?: ContentIndexV1;
  now?: Date;
  planAcceptance?: "active" | "any";
}

export type ArtifactValidationErrorCode =
  | "unknown-field"
  | "missing-field"
  | "invalid-type"
  | "invalid-enum"
  | "invalid-json"
  | "invalid-id"
  | "duplicate-id"
  | "unsafe-path"
  | "unresolved-endpoint"
  | "repository-mismatch"
  | "digest-mismatch"
  | "invalid-time"
  | "plan-unapproved"
  | "plan-expired"
  | "plan-superseded"
  | "invalid-metrics"
  | "future-version"
  | "migration-missing"
  | "breaking-migration-required"
  | "downgrade-forbidden";

export class ArtifactValidationError extends Error {
  public readonly code: ArtifactValidationErrorCode;
  public readonly path: string;

  public constructor(code: ArtifactValidationErrorCode, path: string) {
    super(`Artifact validation failed (${code}) at ${path}.`);
    this.name = "ArtifactValidationError";
    this.code = code;
    this.path = path;
  }
}
