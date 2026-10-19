// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ArtifactReference,
  ArtifactUse,
  EditorialCandidateContextV1,
  EditorialDecisionArtifactReferenceV3,
} from "../artifacts/contracts.js";
import type { ReaderContextProvenanceV1, ReaderContextV1 } from "../context/reader-context.js";
import type { ReaderTaskContextProjectionV1 } from "../execution/task-context-contracts.js";
import type {
  BoundedSearchEvidenceV1,
  SearchArtifactClass,
  SearchProbeDeclarationV1,
  SearchRubricCriterionV1,
} from "../search/bounded-search-contracts.js";
import type {
  DocumentationGapLedgerV1,
  DocumentationNegativeEvidenceV1,
  DocumentationSearchFindingV1,
} from "../search/gap-ledger-contracts.js";
import type { SearchProgressEvidenceV1 } from "../search/progress-evidence-contracts.js";
import type {
  RepositoryBatchReplayAuthorityV1,
  RepositoryDiscoveryInventoryV1,
} from "../repository/inventory-contracts.js";
import type { RepositoryTarget } from "../repository/contracts.js";
import type { RunRecord } from "../records/contracts.js";

export type WorkflowName =
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
  // Catalogued but not operator-runnable: the host spine dispatches it, never
  // `docsfab run`.
  | "live-agent-turn"
  | "reconcile-product-behavior";
export type StepMode = "read-only" | "write";
export type ProductDisposition = "ready" | "not-ready" | "needs-input" | "inconclusive" | "blocked";
/**
 * Every product disposition as a runtime list, so a new disposition fails
 * typecheck here and the pairing tests enumerate it against each consumer. No
 * consumer derives its own handling from this map.
 */
export const PRODUCT_DISPOSITION_KEYS = Object.freeze({
  ready: true,
  "not-ready": true,
  "needs-input": true,
  inconclusive: true,
  blocked: true,
} as const satisfies Record<ProductDisposition, true>);
export type WorkflowOutcomeFindingKind =
  | "product-gap"
  | "missing-governed-input"
  | "evidence-limitation"
  | "blocked-dependency"
  | "roadmap-gap";
export interface WorkflowOutcomeStepEvidenceV1 {
  id: string;
  kind: "step";
  stepId: string;
  sha256: string;
}
export interface WorkflowOutcomeSearchEvidenceV1 {
  id: string;
  kind: "search";
  stepId: string;
  targetId: string;
  sha256: string;
}
export interface WorkflowOutcomeArtifactEvidenceV1 {
  id: string;
  kind: "artifact";
  stepId: string;
  role: ArtifactUse["role"];
  reference: ArtifactReference;
}
export type WorkflowOutcomeEvidenceV1 =
  | WorkflowOutcomeStepEvidenceV1
  | WorkflowOutcomeSearchEvidenceV1
  | WorkflowOutcomeArtifactEvidenceV1;
export interface WorkflowOutcomeFindingV1 {
  id: string;
  kind: WorkflowOutcomeFindingKind;
  severity: "info" | "warning" | "blocking";
  code: string;
  inputId?: string;
  evidenceIds: string[];
}
export interface WorkflowOutcomeOpenDecisionV1 {
  id: string;
  kind: "governed-input" | "human-decision" | "policy-approval" | "dependency";
  inputId?: string;
  evidenceIds: string[];
}
export interface WorkflowOutcomeCandidateV1 {
  disposition: ProductDisposition;
  findings: WorkflowOutcomeFindingV1[];
  evidence: WorkflowOutcomeEvidenceV1[];
  limitations: string[];
  openDecisions: WorkflowOutcomeOpenDecisionV1[];
  producedArtifacts: ArtifactReference[];
}
export interface WorkflowOutcomeEnvelopeV1 extends WorkflowOutcomeCandidateV1 {
  schemaVersion: 1;
  kind: "docsfab-workflow-outcome";
  outcomeSha256: string;
}
export interface WorkflowOutcomeProjector {
  project(
    record: Readonly<RunRecord>,
    decodeOptions?: import("./outcome.js").WorkflowOutcomeDecodeOptionsV1,
  ): Promise<WorkflowOutcomeCandidateV1>;
}
export type WorkflowStepKind = "inference" | "host-operation" | "evaluate";
export type SearchMode = "observe" | "revalidate" | "reuse";
export interface WorkflowStep {
  id: string;
  title: string;
  kind?: WorkflowStepKind;
  operation?: "ia-plan" | "site-bootstrap" | "foundation" | "foundation-to-patch";
  /** Installed child pipeline the native composition runs in process. */
  invokes?: "create-documentation";
  skill: string;
  mode: StepMode;
  prompt: string;
  /** Earlier step summaries exposed as bounded, untrusted evidence to this step. */
  consumes?: readonly string[];
  /**
   * Earlier steps whose sealed search, ledger, or evaluate hashes this step
   * may attach. Distinct from `consumes`, which forwards untrusted summaries.
   */
  consumesEvidence?: readonly string[];
  search?: WorkflowSearchPlanV1;
  /** Required when `search` is present. */
  searchMode?: SearchMode;
}
interface WorkflowSearchTargetDeclarationBaseV1 {
  id: string;
  targetKey: string;
  question: string;
  requiredProbes: SearchProbeDeclarationV1[];
}
export interface WorkflowArtifactSearchTargetDeclarationV1
  extends WorkflowSearchTargetDeclarationBaseV1 {
  targetType: "artifact-existence";
  artifactClass: SearchArtifactClass;
}
export interface WorkflowRubricSearchTargetDeclarationV1
  extends WorkflowSearchTargetDeclarationBaseV1 {
  targetType: "rubric-coverage";
  rubric: { id: string; version: string; criteria: SearchRubricCriterionV1[] };
}
export type WorkflowSearchTargetDeclarationV1 =
  | WorkflowArtifactSearchTargetDeclarationV1
  | WorkflowRubricSearchTargetDeclarationV1;
export interface WorkflowSearchPlanV1 {
  schemaVersion: 1;
  id: string;
  version: string;
  targets: readonly WorkflowSearchTargetDeclarationV1[];
}
export interface WorkflowSearchResultV1 {
  targetId: string;
  bounded: BoundedSearchEvidenceV1;
  progress: SearchProgressEvidenceV1;
}
export interface WorkflowSearchStepEvidenceV1 {
  schemaVersion: 1;
  kind: "docsfab-workflow-search-evidence";
  planId: string;
  planVersion: string;
  workspaceSnapshotSha256: string;
  searches: WorkflowSearchResultV1[];
  evidenceSha256: string;
}
export interface WorkflowSearchCoordinatorInput {
  runId: string;
  repositoryPath: string;
  repository: RepositoryTarget;
  workflow: WorkflowDefinition;
  step: WorkflowStep;
  plan: WorkflowSearchPlanV1;
  repositoryDefaultBranch?: string;
  authorizedWritePaths?: readonly string[];
}
export interface WorkflowSearchCoordinatorResultV1 {
  repositoryIdentitySha256: string;
  searches: WorkflowSearchResultV1[];
  workspaceSnapshotSha256?: string;
  repositoryBatchAuthority?: RepositoryBatchReplayAuthorityV1;
  trustedRepositoryInventory?: RepositoryDiscoveryInventoryV1;
  /**
   * Warnings for the run record's `evidenceWarnings`, such as a linked asset
   * the workspace content index left out past a limit.
   */
  evidenceWarnings?: readonly string[];
}
export interface WorkflowSearchCoordinator {
  search(input: WorkflowSearchCoordinatorInput): Promise<WorkflowSearchCoordinatorResultV1>;
}
export interface WorkflowDefinition {
  /** Source manifest schema. Omitted only by legacy in-memory test fixtures. */
  schemaVersion?: 1 | 2 | 3;
  name: WorkflowName;
  title: string;
  outcome: string;
  contextPolicy: WorkflowContextPolicy;
  steps: readonly WorkflowStep[];
  /** Present only for the closed update-documentation Manifest V2 contract. */
  branching?: WorkflowBranchingDefinitionV2;
  /** Present only for the closed create-documentation Manifest V3 contract. */
  authoringSchedule?: WorkflowAuthoringScheduleDefinitionV3;
}
export type WorkflowBranchIdV2 = "author" | "assess-no-change";
export interface WorkflowBranchSelectionV2 {
  afterStepId: "plan-documentation";
  kind: "editorial-candidate-v1";
}
export interface WorkflowBranchV2 {
  id: WorkflowBranchIdV2;
  steps: readonly WorkflowStep[];
  contextPolicy: WorkflowContextPolicy;
}
export interface WorkflowBranchingDefinitionV2 {
  /** Canonical JSON snapshot retained for historical branch reconstruction. */
  manifest: WorkflowManifestV2;
  prefix: {
    steps: readonly WorkflowStep[];
    contextPolicy: WorkflowContextPolicy;
  };
  selection: WorkflowBranchSelectionV2;
  branches: readonly [WorkflowBranchV2, WorkflowBranchV2];
}
export type EditorialBranchCandidateV1 = "update" | "no-change" | "insufficient-evidence";
export interface WorkflowBranchSelectionEvidenceV1 {
  candidate: EditorialBranchCandidateV1;
  branchId: WorkflowBranchIdV2 | null;
  workspaceSnapshotSha256: string;
  candidateArtifact: import("../artifacts/contracts.js").EditorialDecisionArtifactReferenceV3;
  readerTaskContext: ReaderTaskContextProjectionV1;
  readerContext: ReaderContextV1;
  readerContextProvenance: ReaderContextProvenanceV1;
  /** Original candidate content; the reference alone is insufficient model context. */
  editorialCandidate: EditorialCandidateContextV1;
}
export interface WorkflowBranchEvidenceHost {
  /** Admit the planner proposal and select only from the runtime-owned fixed branches. */
  select(input: {
    workflow: WorkflowDefinition;
    record: Readonly<RunRecord>;
    proposal: unknown;
  }): Promise<WorkflowBranchSelectionEvidenceV1>;
  /**
   * Admit one selected-path assessment result before finalization. The proposal
   * stays untrusted; the host binds it to the supplied step and record.
   */
  observeAssessment(input: {
    workflow: WorkflowDefinition;
    record: Readonly<RunRecord>;
    stepId: string;
    proposal: unknown;
  }): Promise<void>;
  /** Admit a final decision from actual selected-path evidence. */
  finalize(input: {
    workflow: WorkflowDefinition;
    record: Readonly<RunRecord>;
    selection: WorkflowBranchSelectionEvidenceV1;
    coverageSha256: string;
  }): Promise<import("../artifacts/contracts.js").EditorialDecisionArtifactReferenceV3>;
  /** Strict retained-byte readback used by outcome and delivery admission. */
  decodeEditorialDecision(
    reference: import("../artifacts/contracts.js").EditorialDecisionArtifactReferenceV3,
    stepId: string,
  ): import("../artifacts/contracts.js").EditorialDecisionPayloadV1;
}

export function isWorkflowManifestV2(
  workflow: WorkflowDefinition,
): workflow is WorkflowDefinition & { schemaVersion: 2; branching: WorkflowBranchingDefinitionV2 } {
  return workflow.schemaVersion === 2 && workflow.branching !== undefined;
}

export function workflowBranch(
  workflow: WorkflowDefinition,
  branchId: WorkflowBranchIdV2,
): WorkflowBranchV2 {
  if (!isWorkflowManifestV2(workflow)) {
    throw new Error("Workflow branch selection requires a Manifest V2 definition.");
  }
  const branch = workflow.branching.branches.find((candidate) => candidate.id === branchId);
  if (!branch) throw new Error(`Workflow Manifest V2 has no branch ${branchId}.`);
  return branch;
}

export function workflowSelectedPath(
  workflow: WorkflowDefinition,
  branchId: WorkflowBranchIdV2,
): { steps: readonly WorkflowStep[]; contextPolicy: WorkflowContextPolicy } {
  const branch = workflowBranch(workflow, branchId);
  return {
    steps: [...workflow.branching!.prefix.steps, ...branch.steps],
    contextPolicy: {
      schemaVersion: 1,
      steps: [...workflow.branching!.prefix.contextPolicy.steps, ...branch.contextPolicy.steps],
    },
  };
}

/** Exact retained V2 manifest wire shape. */
export interface WorkflowManifestStepV2 {
  id: string;
  title: string;
  kind: WorkflowStepKind;
  skill: string;
  mode: StepMode;
  prompt: string;
  consumes?: string[];
  consumesEvidence?: string[];
  searchPlan?: string;
  searchMode?: SearchMode;
}
export interface WorkflowManifestBranchV2 {
  id: "author" | "assess-no-change";
  steps: WorkflowManifestStepV2[];
  contextPolicy: WorkflowContextPolicy;
}
export interface WorkflowManifestV2 {
  schemaVersion: 2;
  name: "update-documentation";
  title: string;
  outcome: string;
  prefix: { steps: WorkflowManifestStepV2[]; contextPolicy: WorkflowContextPolicy };
  selection: { afterStepId: "plan-documentation"; kind: "editorial-candidate-v1" };
  branches: [WorkflowManifestBranchV2, WorkflowManifestBranchV2];
}
export type WorkflowAuthoringBranchIdV3 = "retain" | "revise";
export type WorkflowAuthoringPhaseStepIdV3 =
  | "write-documentation"
  | "lint-documentation"
  | "provisional-technical-verification"
  | "verify-technical-accuracy"
  | "review-documentation"
  | "revise-documentation"
  | "lint-revised-documentation"
  | "provisional-revised-technical-verification"
  | "verify-revised-technical-accuracy"
  | "review-revised-documentation"
  | "test-audience-understanding"
  | "evaluate-document-quality";
export type WorkflowAuthoringPhaseRoleV3 =
  | "writer"
  | "lint"
  | "provisional-technical"
  | "canonical-technical"
  | "editorial"
  | "audience"
  | "evaluation";
export interface WorkflowAuthoringWriterPhaseV3 {
  stepId: "write-documentation" | "revise-documentation";
  ordinal: number;
  role: "writer";
  /** Null for the initial author; candidate 0 for the sole revision author. */
  inputCandidateOrdinal: null | 0;
  outputCandidateOrdinal: 0 | 1;
}
export interface WorkflowAuthoringAssessmentPhaseV3 {
  stepId: Exclude<WorkflowAuthoringPhaseStepIdV3, "write-documentation" | "revise-documentation">;
  ordinal: number;
  role: Exclude<WorkflowAuthoringPhaseRoleV3, "writer">;
  candidateOrdinal: 0 | 1;
}
export type WorkflowAuthoringPhaseV3 =
  | WorkflowAuthoringWriterPhaseV3
  | WorkflowAuthoringAssessmentPhaseV3;
export interface WorkflowAuthoringSelectionV3 {
  afterStepId: "review-documentation" | "verify-technical-accuracy";
  kind: "authoring-revision-v1";
}
export interface WorkflowAuthoringBranchV3 {
  id: WorkflowAuthoringBranchIdV3;
  steps: readonly WorkflowStep[];
  contextPolicy: WorkflowContextPolicy;
}
export interface WorkflowAuthoringScheduleDefinitionV3 {
  /** Canonical JSON snapshot retained for schedule reconstruction. */
  manifest: WorkflowManifestV3;
  prefix: {
    steps: readonly WorkflowStep[];
    contextPolicy: WorkflowContextPolicy;
  };
  selection: WorkflowAuthoringSelectionV3;
  branches: readonly [WorkflowAuthoringBranchV3, WorkflowAuthoringBranchV3];
}
/** Exact retained create V3 manifest wire shape. */
export interface WorkflowManifestBranchV3 {
  id: WorkflowAuthoringBranchIdV3;
  steps: WorkflowManifestStepV2[];
  contextPolicy: WorkflowContextPolicy;
}
export interface WorkflowManifestV3 {
  schemaVersion: 3;
  name: "create-documentation";
  title: string;
  outcome: string;
  prefix: { steps: WorkflowManifestStepV2[]; contextPolicy: WorkflowContextPolicy };
  selection: WorkflowAuthoringSelectionV3;
  branches: [WorkflowManifestBranchV3, WorkflowManifestBranchV3];
}
export function isWorkflowManifestV3(
  workflow: WorkflowDefinition,
): workflow is WorkflowDefinition & {
  schemaVersion: 3;
  authoringSchedule: WorkflowAuthoringScheduleDefinitionV3;
} {
  return workflow.schemaVersion === 3 && workflow.authoringSchedule !== undefined;
}
export interface WorkflowBranchCoverageSelectionV1 {
  branchId: "author" | "assess-no-change";
  candidateArtifact: EditorialDecisionArtifactReferenceV3;
}
export interface WorkflowBranchCoverageV1 {
  schemaVersion: 1;
  kind: "docsfab-workflow-branch-coverage";
  workflow: "update-documentation";
  manifest: WorkflowManifestV2;
  manifestSha256: string;
  repositoryRevision: string;
  workspaceSnapshotSha256: string;
  selection: WorkflowBranchCoverageSelectionV1 | null;
  requiredStepIds: string[];
  excludedStepIds: string[];
  coverageSha256: string;
}
export type ContextLevel = "local" | "change-scoped" | "corpus";
export type ContextQueryKind =
  | "locate"
  | "get-neighborhood"
  | "find-home"
  | "test-placement"
  | "expand";
export interface WorkflowContextStepPolicy {
  stepId: string;
  required: boolean;
  level: ContextLevel;
  query: ContextQueryKind;
  allowReadOnlyDegraded: boolean;
}
export interface WorkflowContextPolicy {
  schemaVersion: 1;
  steps: readonly WorkflowContextStepPolicy[];
}
export type IaPlanScope = "site" | "section" | "page";
export type IaPlanMode = "create" | "reevaluate";
export interface IaPlanTaskInput {
  kind: "ia-plan";
  scope: IaPlanScope;
  mode: IaPlanMode;
  target?: import("../context/contracts.js").ContextPreflightTarget;
}
export interface SiteBootstrapTaskInput {
  kind: "site-bootstrap";
  plan: ArtifactReference<"ia-plan">;
}
export interface BoundedDocImprovementTaskInput {
  kind: "bounded-doc-improvement";
  campaignId: string;
  repositoryId: string;
  testedCommit: string;
  repositoryIdentitySha256: string;
  contextSourcePath: string;
  gap: { id: string; evidenceSha256: string; successCriterionSha256: string };
  analysis: {
    runId: string;
    recordSha256: string;
    approvedOutcomeSha256: string;
    approvedProposal: string;
  };
  authorization: { sha256: string; digest: string };
  intendedPaths: string[];
}
export interface FoundationToPatchTaskInput {
  kind: "foundation-to-patch";
  intendedPaths: string[];
  authorization?: { sha256: string; digest: string; expiresAt: string };
  canonSha256?: string;
}
export interface CreateDocumentationTaskInput {
  kind: "create-documentation";
  canonSha256: string;
}
export interface UpdateDocumentationTaskInput {
  kind: "update-documentation";
  canonSha256: string;
}
export type WorkflowTaskInput =
  | IaPlanTaskInput
  | SiteBootstrapTaskInput
  | BoundedDocImprovementTaskInput
  | FoundationToPatchTaskInput
  | CreateDocumentationTaskInput
  | UpdateDocumentationTaskInput;
