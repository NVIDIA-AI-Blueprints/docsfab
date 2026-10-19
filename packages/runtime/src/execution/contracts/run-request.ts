// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Run request admission data and focused review scope contracts.

import { catalogCapacity } from "../../config/catalog-capacity.js";
import type { ArtifactReference } from "../../artifacts/contracts.js";
import type { ContextPreflightTarget } from "../../context/contracts.js";
import type { CandidateSourceChangeV1 } from "../../candidate-source-manifest.js";
import type {
  ReaderContextInputV1,
  ReaderContextProvenanceV1,
  ReaderContextV1,
} from "../../context/reader-context.js";
import type { RepositoryTarget } from "../../repository/contracts.js";
import type {
  WorkflowDefinition,
  WorkflowName,
  WorkflowStep,
  WorkflowTaskInput,
} from "../../workflow-contracts/contracts.js";
import type {
  ReaderTaskContextInputProjectionV1,
  ReaderTaskContextProjectionV1,
} from "../task-context.js";

export interface SealedStepEvidenceBindingV1 {
  stepId: string;
  searchEvidenceSha256?: string;
  gapLedgerSha256?: string;
  evaluateEvidenceSha256?: string;
}

export interface CandidateReviewSourceBlobEvidenceV1 {
  readonly revision: string;
  readonly path: string;
  readonly objectId: string;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly content: string;
}

/** Process-local, host-observed C..H evidence. It is never a requester instruction or authority. */
export interface CandidateReviewSourceEvidenceV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-candidate-review-source-evidence";
  readonly source: {
    readonly baseRevision: string;
    readonly headRevision: string;
    readonly headTreeObjectId: string;
    readonly manifestSha256: string;
  };
  readonly candidate: {
    readonly reviewCommitObjectId: string;
    readonly treeObjectId: string;
    readonly targetManifestSha256: string;
  };
  readonly changes: readonly (CandidateSourceChangeV1 & {
    readonly before: CandidateReviewSourceBlobEvidenceV1 | null;
    readonly after: CandidateReviewSourceBlobEvidenceV1 | null;
  })[];
}

export interface QualityCandidateValidationStepInput {
  workflow: Pick<WorkflowDefinition, "name">;
  step: Pick<WorkflowStep, "id" | "skill" | "kind" | "mode">;
  qualityArtifactBound: boolean;
}

/** Exact neutral activation predicate shared by runner and harness adapters. */
export function isQualityCandidateValidationStep(
  input: QualityCandidateValidationStepInput,
): boolean {
  return (
    (input.workflow.name === "review-documentation" ||
      input.workflow.name === "create-documentation" ||
      input.workflow.name === "update-documentation") &&
    input.step.id === "evaluate-document-quality" &&
    input.step.skill === "evaluate-document-quality" &&
    (input.step.kind ?? "inference") === "evaluate" &&
    input.step.mode === "read-only" &&
    input.qualityArtifactBound
  );
}

/**
 * Longest continuation command the model is told to emit, in characters.
 * Lockstep with `REVIEW_SCOPE_CONTINUATION_TEXT_LIMIT` in
 * `packages/host/src/review-scope/contracts.ts`: reference-model heads among
 * the deferred pages are named first, then the rest in deferral order, and
 * pages past the bound are counted.
 */
export const REVIEW_SCOPE_CONTINUATION_TEXT_LIMIT = catalogCapacity(
  "reviewScope.continuationTextMaxChars",
);

/**
 * The documentation pages a read-only review is about; absent means
 * documentation-set scope.
 *
 * Present, it is authoritative: the runner binds it to every step and the step
 * prompt names it as the approved set. It narrows what is reviewed and
 * reported but is not a filesystem boundary, because verification and audit
 * steps still read source, navigation and the reference model.
 */
export interface RunReviewScope {
  readonly scope: "focused-set";
  /** Lockstep with `REVIEW_SCOPE_REASONS` in `packages/host/src/review-scope/contracts.ts`. */
  readonly reason:
    | "operator-named"
    | "documentation-index"
    | "within-budget"
    | "navigation-changed"
    | "model-changed"
    | "config-changed"
    | "scan-unavailable";
  /** Reviewed pages, in the order the operator named them. */
  readonly targetPaths: readonly string[];
  /** Named pages this run does not cover; reported, never silently dropped. */
  readonly deferredPaths: readonly string[];
  /**
   * Reference-model heads among the listed pages, named first in the
   * continuation command. Empty for an operator-named scope.
   */
  readonly anchorPaths?: readonly string[];
  readonly scopeSha256: string;
  /** Tracked Markdown pages in the whole repository, or null if uncounted. */
  readonly corpusFileCount: number | null;
  /**
   * Trusted identity for a directly runnable Slack continuation, derived from
   * the validated canon input and source revision. Absent for forge-triggered
   * reviews without a registered canon; the host renders their command later.
   */
  readonly continuationIdentity?: {
    readonly canonSha256: string;
    readonly reviewRevision: string;
  };
  /** Host-derived full-radius accounting; absent for pre-accounting/local producers. */
  readonly accounting?: {
    readonly radiusSha256: string;
    readonly radiusPageCount: number;
    readonly listedPageCount: number;
    readonly unlistedPageCount: number;
    readonly unreviewableNeighbourCount: number;
    readonly changedPathCount: number | null;
    readonly continuationCharacterLimit: number;
  };
}

export interface RunRequest {
  /** Process-local cancellation, never serialized into run evidence. */
  signal?: AbortSignal;
  runId?: string;
  workflow: WorkflowName;
  workspacePath: string;
  repository: RepositoryTarget;
  /** Credential-free provenance for an explicitly unqualified discovery run. */
  answerRecordDiscovery?: import("../../records/answer-record-discovery.js").AnswerRecordDiscoveryExecutionV1;
  task?: WorkflowTaskInput;
  contextTarget?: ContextPreflightTarget;
  /** Portable reader intent supplied for context-dependent documentation work. */
  readerContextInput?: ReaderContextInputV1;
  /** Verified reader context projection assembled by the host supplier. */
  readerTaskContext?: ReaderTaskContextInputProjectionV1 | ReaderTaskContextProjectionV1;
  /** Completed host-admitted reader context for the selected repository snapshot. */
  readerContext?: ReaderContextV1;
  /** Exact provenance for `readerContext`; neither field grants write authority. */
  readerContextProvenance?: ReaderContextProvenanceV1;
  /** Genuine admitted artifacts the model may cite in an editorial proposal. */
  editorialEvidenceRefs?: readonly ArtifactReference[];
  instruction?: string;
  /** Credential-free original CLI selection needed to reconstruct safe retries. */
  retryContext?: import("../../records/retry-context.js").CliRunRetryContextV1;
  /**
   * Non-authoritative context a live agent added to the user's verbatim
   * instruction. Never parsed for targets, sources, or restrictions, and never
   * part of the instruction digest.
   */
  instructionContext?: string;
  /**
   * The operator-supplied comparison and nominations this update admitted,
   * saved so an InputAsk continuation re-admits them. Absent when it had none.
   */
  readerEvidenceRequest?: import("../../records/reader-evidence-request.js").RunRecordReaderEvidenceRequestV1;
  reviewScope?: RunReviewScope;
  /**
   * The request interpretation's outcome, copied onto the queued record.
   * Recorded evidence only: no admission reads it yet, so the source request
   * projection leaves it out.
   */
  requestIntent?: import("../../request-intent/interpret-record.js").RunRecordRequestIntentV1;
  /** Provenance only; first pass has already validated this selected option. */
  firstPassChoices?: readonly import("../../records/first-pass-choice.js").FirstPassChoiceV1[];
  allowWrite: boolean;
  releaseDefaultBranch?: string;
  taskLineage?: import("../../lineage/contracts.js").TaskLineageArtifactsV1;
  /** Sealed, credential-free selection evidence for an explicit composition run. */
  compositionExecution?: import("../../records/composition-execution.js").CompositionExecutionEvidenceV1;
  /** Each bound slot's effective model settings and sources, recorded from the queued save. */
  modelSettings?: import("../../records/run-model-settings.js").RunModelSettingsV1;
  /** Content-free evidence for target-scoped advisory knowledge conflicts. */
  knowledgeResumeReceipt?: import("../../canon/from-knowledge-snapshot.js").KnowledgeResumeReceiptV1;
  knowledgeContinuationReceipt?: import("../../records/knowledge-continuation.js").KnowledgeContinuationReceiptV1;
  knowledgeContinuationRecoveryAuthorization?: import("../../lineage/contracts.js").TaskLineageRecoveryAuthorizationV1;
  knowledgeContinuationSnapshotSha256?: string;
  knowledgeContinuationAcceptanceSha256?: string;
  /**
   * Inert source-binding reference; data, never authority. Without the
   * matching process-local service, admission fails with
   * `source-capability-unavailable`.
   */
  sourceBinding?: import("../../inputs/source-evidence-artifacts.js").SourceArtifactReferenceV2<"source-binding">;
  /** Host-resolved exact child continuation; never sourced from model content. */
  answerRecordContinuation?: {
    readonly logicalRunId: string;
    readonly sourceRunId: string;
    readonly checkpoint: {
      readonly record: import("../../records/contracts.js").AnswerRecordContinuationCheckpointEnvelopeV1;
      readonly sha256: string;
    };
    readonly resumeStepId: string;
    readonly completedPrefix: readonly import("../../records/contracts.js").StepRunRecord[];
    readonly selectedPathId?: string;
    readonly selectionEvidence?: {
      readonly workflowBranchCoverage?: import("../../records/contracts.js").RunRecord["workflowBranchCoverage"];
      readonly authoringExecution?: import("../../records/contracts.js").RunRecord["authoringExecution"];
    };
    readonly sourceArtifacts?: import("../../records/contracts.js").RunRecord["artifacts"];
  };
  /** Content-free child receipt copied onto the new physical run record. */
  answerRecordContinuationReceipt?: import("../../records/contracts.js").AnswerRecordContinuationReceiptV1;
}
