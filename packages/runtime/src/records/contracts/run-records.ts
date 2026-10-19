// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Run-level, step-level, checkpoint, store, and progress event contracts.

import type { ArtifactUse } from "../../artifacts/contracts.js";
import { isSourceReuseCountersV1 } from "./inference.js";
import type { ChangeEvidence, ImpactPostflightEvidence } from "../../impact/contracts.js";
import type { TaskLineageProjectionV1 } from "../../lineage/contracts.js";
import type {
  DocumentationGapLedgerV1,
  DocumentationNegativeEvidenceV1,
  DocumentationSearchFindingV1,
} from "../../search/gap-ledger-contracts.js";
import type {
  SecurityScanAuthorizationEvidence,
  SecurityScanEffectiveDisposition,
  SecurityScanReport,
} from "../../security/contracts.js";
import type { RepositoryTarget } from "../../repository/contracts.js";
import type { ReleaseDocumentationReadinessArtifactV1 } from "../../repository/release-documentation-readiness-contracts.js";
import type { WorkUnitMachineContractV1 } from "../../maturity/work-unit-machine-contract.js";
import type { InferenceRejectionReasonV1 } from "../../execution/contracts.js";
import type {
  WorkflowBranchCoverageV1,
  WorkflowName,
  WorkflowOutcomeEnvelopeV1,
  WorkflowSearchStepEvidenceV1,
  WorkflowStepKind,
  WorkflowTaskInput,
} from "../../workflow-contracts/contracts.js";
import type {
  InferenceExecutionEvidence,
  InferenceAttemptEvidence,
  InferenceAnswerSubmissionEvidenceV1,
  EvaluateStepEvidenceV1,
  SearchParticipationRecord,
} from "./inference.js";
import type { ModelEvidence, SkillEvidence } from "./model-skill-quality.js";
import type { ToolActivitySummary, TokenUsage } from "./tool-activity.js";
import type {
  QualityPackEvidenceV1,
  QualityProfileSelectionReceiptV1,
  QualityArtifactValidationBindingV1,
} from "./model-skill-quality.js";

export type RunStatus =
  | "queued"
  | "running"
  | "needs-input"
  | "needs-human-decision"
  | "succeeded"
  | "failed";

const REVIEW_LOCATOR_REFERENCE_KIND = "docsfab-review-locator-observation-reference" as const;

export interface ReviewLocatorObservationReference {
  readonly kind: typeof REVIEW_LOCATOR_REFERENCE_KIND;
  readonly objectSha256: string;
  readonly domainSha256: string;
  readonly runId: string;
  readonly stepId: "verify-technical-accuracy";
  readonly attempt: number;
  readonly summarySha256: string;
}

/** Strict leaf codec shared by the run decoder and deletion inventory. */
export function decodeReviewLocatorObservationReference(
  value: unknown,
): ReviewLocatorObservationReference {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Retained review locator reference is invalid for this run.");
  const record = value as Record<string, unknown>;
  const keys = [
    "kind",
    "objectSha256",
    "domainSha256",
    "runId",
    "stepId",
    "attempt",
    "summarySha256",
  ];
  if (
    Object.keys(record).sort().join("\0") !== keys.sort().join("\0") ||
    record.kind !== REVIEW_LOCATOR_REFERENCE_KIND ||
    record.stepId !== "verify-technical-accuracy" ||
    typeof record.runId !== "string" ||
    record.runId.length === 0 ||
    !Number.isSafeInteger(record.attempt) ||
    (record.attempt as number) < 1 ||
    ![record.objectSha256, record.domainSha256, record.summarySha256].every(
      (digest) => typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest),
    )
  )
    throw new Error("Retained review locator reference is invalid for this run.");
  return record as unknown as ReviewLocatorObservationReference;
}
/**
 * Every run status as a runtime list, so a new status fails typecheck here and
 * the pairing tests enumerate it against each consumer. No consumer derives
 * its own handling from this map.
 */
export const RUN_STATUS_KEYS = Object.freeze({
  queued: true,
  running: true,
  "needs-input": true,
  "needs-human-decision": true,
  succeeded: true,
  failed: true,
} as const satisfies Record<RunStatus, true>);
export type StepStatus =
  | "pending"
  | "running"
  | "needs-input"
  | "needs-human-decision"
  | "succeeded"
  | "failed";
export interface StepRunRecord {
  id: string;
  /** Source provenance for a completed step copied into an answer-record child run. */
  inheritedFrom?: {
    readonly sourceRunId: string;
    readonly sourceRunRecordSha256: string;
    readonly sourceStepId: string;
  };
  title: string;
  kind?: WorkflowStepKind;
  operation?: "ia-plan" | "site-bootstrap" | "foundation" | "foundation-to-patch";
  skill: string;
  mode: import("../../workflow-contracts/contracts.js").StepMode;
  status: StepStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  model?: ModelEvidence;
  skillEvidence?: SkillEvidence;
  usage?: TokenUsage;
  tools?: ToolActivitySummary;
  inference?: InferenceExecutionEvidence;
  /** Pre-Pi source seeding, including a refusal that stops before an inference attempt exists. */
  preservationSourceObservationSeed?: {
    schemaVersion: 1;
    outcome: "succeeded" | "failed";
    counters: import("./inference.js").SourceReuseCountersV1;
  };
  /** Last content-free Pi turn/tool boundary observed while this step ran. */
  inferenceProgress?: InferenceProgressObservationV1;
  evaluateEvidence?: EvaluateStepEvidenceV1;
  contextPreflight?: import("../../context/contracts.js").ContextPreflightEvidence;
  searchEvidence?: WorkflowSearchStepEvidenceV1;
  /**
   * How this step joined its search plan. A reusing step stores a
   * byte-identical `searchEvidence`, so this is the only record of which step
   * observed it.
   */
  searchParticipation?: SearchParticipationRecord;
  /** Content-free index for a host-admitted records-mode evaluator response. */
  answerRecordLedger?: AnswerRecordLedgerIndexV1;
  /** Digest pointer to the last fully published answer-record control checkpoint. */
  answerRecordCheckpoint?: {
    readonly sha256: string;
    readonly sequence: number;
    /** Physical attempt that committed this pointer in this run. */
    readonly attempt: number;
  };
  repositoryBatchAuthority?: import("../../repository/inventory-contracts.js").RepositoryBatchReplayAuthorityV1;
  searchFindings?: DocumentationSearchFindingV1[];
  negativeEvidence?: DocumentationNegativeEvidenceV1[];
  gapLedger?: DocumentationGapLedgerV1;
  artifacts?: ArtifactUse[];
  planBinding?: import("../../workflow-execution/plan-binding.js").AdmittedDocumentationPlanBinding;
  /** Host-applied RST single-span edit and byte preservation proof. */
  rstPreservation?: import("../../rst-authoring/contracts.js").RstPreservationReceipt;
  /** Independent static structure and tracked-graph results; opaque regions stay explicit. */
  rstStaticStructure?: import("../../rst-authoring/static-comparison.js").RstStaticResult;
  rstStaticGraph?: import("../../rst-authoring/static-comparison.js").RstStaticGraphResult;
  /** The limited RST slice never executes a native Sphinx build. */
  rstNativeBuild?: "not-run";
  /** Final correction accounting, separate from the canonical technical summary. */
  technicalCorrectionEvidence?: import("../../workflow-execution/source-obligation.js").TechnicalCorrectionEvidence;
  /** Fixed candidate set on a normal or revised provisional technical step. */
  provisionalRichCandidateEvidence?: import("../../workflow-execution/source-obligation.js").ProvisionalRichCandidateEvidenceV1;
  /**
   * #1439: host-derived comparison of this canonical technical step with its
   * provisional pass. A sibling of `technicalCorrectionEvidence`, outside its
   * digest; present only on a canonical technical step.
   */
  verifierDisagreement?: import("../verifier-disagreement.js").VerifierDisagreementV1;
  /** Optional sealed CAS proof of exact model-visible review read coordinates. */
  reviewLocatorObservation?: ReviewLocatorObservationReference;
  /** Complete host-retained original source membership, present only on derivation. */
  originalSourceAuthority?: import("../../workflow-execution/source-obligation-authority.js").OriginalSourceAuthorityEvidenceV1;
  /** Host-checked per-attempt CREATE source proposals; model claims never mint these rows. */
  sourceProposalAdmissions?: import("../../workflow-execution/source-obligation-authority.js").SourceAuthorityProposalAdmissionV1[];
  /** Host-derived candidate/phase binding for CREATE Manifest V3. */
  authoringPhase?: import("../authoring-execution.js").AuthoringPhaseEvidenceV1;
  /** Strict author accounting retained only for the sole CREATE V3 revision writer. */
  authoringRevisionAccounting?: import("../../workflow-execution/authoring-revision.js").AuthoringRevisionAccountingV1;
  planDiagnostic?: {
    schemaVersion: 1;
    kind: "docsfab-documentation-plan-diagnostic";
    code: string;
    responseSha256: string;
    responseShape: "json-object" | "invalid-json" | "json-value";
  };
  /**
   * Coded plan-scope stop of a planned write step whose edit/write calls the
   * confined mutation boundary refused; see `workflow-contracts/plan-scope-stop.ts`.
   */
  planScopeStop?: import("../../workflow-contracts/plan-scope-stop.js").DocumentationPlanScopeStopV1;
  /**
   * Coded stop of a planned writer that changed no file while the host supplied
   * repository instructions; see `workflow-contracts/writer-no-change-stop.ts`.
   */
  writerNoChangeStop?: import("../../workflow-contracts/writer-no-change-stop.js").DocumentationWriterNoChangeStopV1;
  /**
   * Host navigation labels: on the planner step, a companion the write grant
   * excludes; on a plan writer, a page with no link path from navigation or an
   * index. Closed codes and paths only; a label never stops the run.
   */
  navigationLabels?: readonly import("../../workflow-execution/plan-companions.js").NavigationLabelV1[];
  /**
   * Why the locked quality validator refused this step's artifact, as a closed
   * code, contract location, and issue count; never validator or model text.
   */
  qualityValidationRejection?: import("../../evaluation-report/quality-validation-rejection.js").QualityValidationRejectionV1;
  /**
   * Why the CREATE revision accounting was refused, as a closed
   * `revision-accounting-<code>` from
   * `config/model-output/rules/revision-accounting.yaml`; never model text.
   */
  authoringRevisionRejection?: import("../../execution/contracts.js").InferenceRejectionReasonV1;
  /** Present only on a failed step. */
  failure?: import("../../operator/failure-class.js").FailureClassificationV1;
  summary?: string;
  error?: string;
}

export function isPreservationSourceObservationSeedV1(
  value: unknown,
): value is NonNullable<StepRunRecord["preservationSourceObservationSeed"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    Object.keys(item).sort().join() === "counters,outcome,schemaVersion" &&
    item.schemaVersion === 1 &&
    (item.outcome === "succeeded" || item.outcome === "failed") &&
    isSourceReuseCountersV1(item.counters)
  );
}

/** Event-driven host observation; absence means no boundary was observed. */
export interface InferenceProgressObservationV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-inference-progress-observation";
  readonly attempt: number;
  readonly observedAt: string;
  readonly event:
    | "provider-turn-started"
    | "provider-turn-settled"
    | "tool-execution-started"
    | "tool-execution-settled";
  readonly phase:
    | "provider-turn-pending"
    | "provider-turn-settled"
    | "tool-execution-active"
    | "tool-execution-settled";
  readonly providerTurns: { readonly started: number; readonly settled: number };
  readonly toolExecutions: { readonly started: number; readonly settled: number };
  /**
   * Optional content-free cumulative attribution for settled tool activity.
   * Older saved observations omit it. `errorResults` mirrors Pi's
   * `tool_execution_end.isError` bit and does not mean an answer was accepted
   * or refused; answer admission remains in the answer-record ledger.
   */
  readonly toolActivity?: InferenceProgressToolActivityV1;
  /** Latest cumulative Pi session token counters; absent until Pi reports them. */
  readonly usage?: Omit<TokenUsage, "cost">;
}

export interface InferenceProgressToolActivityCountsV1 {
  readonly started: number;
  readonly settled: number;
  readonly errorResults: number;
}

/** Fixed category counts, never model-provided names, identifiers, or payloads. */
export interface InferenceProgressToolActivityV1 {
  readonly answerRecord: InferenceProgressToolActivityCountsV1;
  readonly reportSubmission: InferenceProgressToolActivityCountsV1;
  readonly candidateValidation: InferenceProgressToolActivityCountsV1;
  readonly readSearch: InferenceProgressToolActivityCountsV1;
  readonly other: InferenceProgressToolActivityCountsV1;
}

/** Digest-only index; sealed record payloads stay in DurableArtifactStore. */
export type QualityEvaluationAnswerRecordType =
  typeof import("../../contracts/model-output.generated.js").OUTPUT_RECORD_CONTRACTS["quality-evaluation"]["records"][number]["type"];
export interface AnswerRecordLedgerProgressV1 {
  readonly admittedRowCount: number;
  readonly releasedRowCount: number;
  readonly remainingKeyCount: number;
  readonly refusalEventCount: number;
  readonly complete: boolean;
  readonly checkpointSequence: number;
  readonly logicalRunId: string;
  readonly sourceRunId: string;
  readonly sourceAttemptHighWater: number;
}
export interface AnswerRecordLedgerIndexV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-answer-record-ledger-index";
  readonly contractId: string;
  readonly bindingsSha256: string;
  readonly rows: readonly {
    readonly type: QualityEvaluationAnswerRecordType;
    readonly key: string;
    readonly recordSha256: string;
    /** Released rows remain locatable evidence but no longer satisfy the ledger. */
    readonly state: "admitted" | "released";
    readonly attempt: number;
  }[];
  readonly checkpoint?: {
    readonly sha256: string;
    readonly sequence: number;
    readonly attempt: number;
  };
  readonly progress?: AnswerRecordLedgerProgressV1;
}

/** Sealed durable control state for retrying an answer-record evaluator. */
export interface AnswerRecordContinuationCheckpointV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-answer-record-continuation-checkpoint";
  readonly continuationId: string;
  readonly sequence: number;
  readonly predecessorCheckpointSha256: string | null;
  readonly sourceRunId: string;
  readonly logicalRunId: string;
  readonly stepId: string;
  readonly sourceAttemptHighWater: number;
  readonly bindingsSha256: string;
  readonly bindings: Readonly<Record<string, unknown>>;
  readonly rows: readonly {
    readonly type: QualityEvaluationAnswerRecordType;
    readonly key: string;
    readonly recordSha256: string;
    readonly payloadSha256: string;
    readonly originalAttempt: number;
  }[];
  readonly issuedKeyHighWater: Readonly<Record<string, number>>;
  readonly tombstones: readonly {
    readonly type: string;
    readonly key: string;
    readonly reasonCode: string;
    readonly settlementSequence: number;
  }[];
  readonly refusalCounts: Readonly<Record<string, number>>;
  /** Content-free count by admitted rejection code and contract location. */
  readonly refusalDiagnostics?: readonly {
    readonly code: string;
    readonly location: string;
    readonly count: number;
  }[];
  readonly refusalExhaustion: { readonly type: string | null; readonly key: string | null } | null;
  readonly settledBatchHighWater: number;
  readonly complete: boolean;
}
/** Contract-kit sealed checkpoint envelope persisted and transported on resume. */
export interface AnswerRecordContinuationCheckpointEnvelopeV1
  extends AnswerRecordContinuationCheckpointV1 {
  readonly recordSha256: string;
}
export interface RunRecord {
  schemaVersion: 2;
  id: string;
  /** Content-free receipt linking a physical child to its exact answer-record checkpoint. */
  answerRecordContinuation?: AnswerRecordContinuationReceiptV1;
  workflow: WorkflowName;
  repository: RepositoryTarget;
  workspace: { strategy: "tracked-export"; disposable: true };
  instruction?: string;
  /** Minimal original CLI context for reconstructing a safe retry command. */
  retryContext?: import("../retry-context.js").CliRunRetryContextV1;
  /** Original explicit operator targets retained for an InputAsk continuation. */
  operatorTargetPaths?: readonly string[];
  /** Live-agent context beside the verbatim instruction; never parsed. */
  instructionContext?: string;
  /** Operator-supplied comparison and nominations an InputAsk continuation re-admits. */
  readerEvidenceRequest?: import("../reader-evidence-request.js").RunRecordReaderEvidenceRequestV1;
  /**
   * The `--source` files and `--pr` merge request a create or update run
   * bound, with the digests the host read, from the queued save. An InputAsk
   * continuation binds them again and refuses if they moved.
   */
  retainedEvidenceBindings?: import("../retained-evidence-bindings.js").RetainedEvidenceBindingsV1;
  task?: WorkflowTaskInput;
  taskLineage?: TaskLineageProjectionV1;
  /** Present from the first queued save for an explicit composition run. */
  compositionExecution?: import("../composition-execution.js").CompositionExecutionEvidenceV1;
  /** Present only for explicit, unqualified answer-record discovery runs. */
  answerRecordDiscovery?: import("../answer-record-discovery.js").AnswerRecordDiscoveryExecutionV1;
  /** Present only after every installed workflow step succeeds. */
  compositionExecutionAggregate?: import("../composition-execution.js").CompositionExecutionAggregateV1;
  /**
   * Each effective model setting, its source, and the preset's own value,
   * from the queued save of a run that bound a model. Private: the full
   * endpoint is kept only here.
   */
  modelSettings?: import("../run-model-settings.js").RunModelSettingsV1;
  /** Present from the queued save when classified conflicts were advisory for this target. */
  knowledgeResumeReceipt?: import("../../canon/from-knowledge-snapshot.js").KnowledgeResumeReceiptV1;
  /** Immutable link from a recovered child run to its original first-pass stop. */
  knowledgeContinuationReceipt?: import("../knowledge-continuation.js").KnowledgeContinuationReceiptV1;
  /** Fresh host authorization for recovering historical lineage in this process. */
  knowledgeContinuationRecoveryAuthorization?: import("../../lineage/contracts.js").TaskLineageRecoveryAuthorizationV1;
  knowledgeContinuationSnapshotSha256?: string;
  /** Seal binding the accepted snapshot to the stop and fresh recovery authorization. */
  knowledgeContinuationAcceptanceSha256?: string;
  status: RunStatus;
  /** Same-run checkout application result; absent on legacy and ordinary CLI runs. */
  checkoutPersistence?: import("../checkout-persistence.js").CheckoutPersistenceOutcomeV1;
  workflowOutcome?: WorkflowOutcomeEnvelopeV1;
  /** Known sealed V1 selected-path evidence for retained V2 workflow manifests. */
  workflowBranchCoverage?: WorkflowBranchCoverageV1;
  /** Portable candidate history and selected-path evidence for CREATE Manifest V3. */
  authoringExecution?: import("../authoring-execution.js").AuthoringExecutionEvidenceV1;
  releaseDocumentationReadiness?: ReleaseDocumentationReadinessArtifactV1;
  workUnitMachineContracts?: readonly WorkUnitMachineContractV1[];
  error?: string;
  /**
   * The failed run's first cause, which is its first failed step's when a step
   * failed. Present only on a failed run.
   */
  failure?: import("../../operator/failure-class.js").FailureClassificationV1;
  /**
   * Why the workflow outcome was refused after every step succeeded, as a
   * closed code, which `failure.code` repeats, and a `$`-rooted location;
   * never error, validator, or model text.
   */
  workflowOutcomeRejection?: import("../../workflow-execution/outcome-rejection.js").WorkflowOutcomeRejectionV1;
  /**
   * Why CREATE revision selection refused candidate-zero evidence, as a closed
   * code, which `failure.code` repeats, and a `$`-rooted location; never
   * error, validator, or model text.
   */
  authoringCandidateRejection?: import("../../workflow-execution/authoring-candidate.js").AuthoringCandidateRejectionV1;
  /**
   * Why terminal editorial finalization refused the final decision after every
   * step succeeded, as a closed code, which `failure.code` repeats, and a
   * `$`-rooted location; never error, validator, or model text.
   */
  editorialFinalizationRejection?: import("../../workflow-execution/editorial-finalization-rejection.js").EditorialFinalizationRejectionV1;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  models: ModelEvidence[];
  skills: SkillEvidence[];
  qualityPack?: QualityPackEvidenceV1;
  /** Selected before the first review-documentation model invocation. */
  qualityProfileSelection?: QualityProfileSelectionReceiptV1;
  /** Runtime-owned artifact and validator binding for the final evaluator result. */
  qualityArtifactValidation?: QualityArtifactValidationBindingV1;
  usage: TokenUsage;
  tools: ToolActivitySummary;
  artifacts?: ArtifactUse[];
  searchFindings?: DocumentationSearchFindingV1[];
  negativeEvidence?: DocumentationNegativeEvidenceV1[];
  gapLedger?: DocumentationGapLedgerV1;
  securityScan?: SecurityScanReport;
  securityScanEffectiveDisposition?: SecurityScanEffectiveDisposition;
  securityScanAuthorization?: SecurityScanAuthorizationEvidence;
  changes?: ChangeEvidence;
  impactPostflight?: ImpactPostflightEvidence;
  /**
   * Present only for a focused review; absent means documentation-set scope.
   * Keeps a narrow review from being mistaken for a whole-set baseline.
   */
  reviewScope?: import("../../execution/contracts.js").RunReviewScope;
  /**
   * How the request interpretation before the first step ended, and the sealed
   * intent it admitted. Present from the first queued save of every run that
   * reached the step; readers verify the intent against `instruction` first.
   */
  requestIntent?: import("../../request-intent/interpret-record.js").RunRecordRequestIntentV1;
  /**
   * Present only on a `needs-input` run first pass stopped before its first
   * step because repository sources disagree: each disagreement with the
   * sides the host verified, and the one question it asks.
   */
  firstPassContradiction?: import("../../cli/run/first-pass-contradiction-stop.js").RunRecordFirstPassContradictionV1;
  firstPassContradictionAdmission?: import("../first-pass-contradiction-admission.js").FirstPassContradictionAdmissionV1;
  firstPassReplay?: import("../first-pass-replay.js").FirstPassReplayV1;
  firstPassChoices?: readonly import("../first-pass-choice.js").FirstPassChoiceV1[];
  /**
   * Present only for a hosted conversational turn. It lives on the run record
   * because the sealed terminal line is the only channel from a sandboxed
   * worker back to the host; the host stores the next session state under
   * `sessionStateSha256`.
   */
  liveAgentTurn?: import("../../host-invoker/live-agent-turn.js").LiveAgentTurnResultV1;
  /** Present only for a hosted turn that produced no answer. Sanitized reason. */
  liveAgentTurnFailure?: {
    schemaVersion: 1;
    kind: "docsfab-live-agent-turn-failure";
    sessionId: string;
    threadBindingSha256: string;
    messageTs: string;
    reason: string;
  };
  /**
   * Present only for a source-grounded run whose write steps were judged on
   * citation coverage: per gated write step, the claims extracted from its
   * summary and the sealed span citations it attached.
   */
  sourceCitations?: import("../source-citations.js").SourceRunCitationsV1;
  /**
   * Present only when the run bound a code change: one entry per sealed
   * change-source record, from the queued save. A stop before the runner
   * starts carries none.
   */
  changeSources?: readonly import("../change-sources.js").RunChangeSourceV1[];
  /** One checked private source graph for a successful read-only review run. */
  reviewDeliverySnapshot?: import("../review-delivery-snapshot-reference.js").ReviewDeliverySnapshotReferenceV1;
  /**
   * Present only when the run bound a release range: its sealed units index
   * and the page it fixed, beside the unit records in `changeSources`.
   */
  changeSourceRelease?: import("../change-source-release.js").RunChangeSourceReleaseV1;
  /**
   * Credential-like repository or request content the run used and continued
   * past (#1807). Each names a location and a scanner rule, never the text.
   */
  credentialFindings?: import("../../security/credential-findings.js").CredentialFinding[];
  evidenceWarnings?: string[];
  steps: StepRunRecord[];
}

export interface AnswerRecordContinuationReceiptV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-answer-record-continuation-receipt";
  readonly sourceRunId: string;
  readonly sourceRunRecordSha256: string;
  readonly checkpointSha256: string;
  readonly checkpointSequence: number;
  readonly checkpointAttempt: number;
  readonly logicalRunId: string;
  /** Digest of the inherited step payloads, excluding their child-specific provenance wrapper. */
  readonly inheritedPrefixSha256: string;
  /** Present when a fresh child resumes a continuation after its local owner exited. */
  readonly recoveryBasis?: "same-host-owner-process-exited";
}
export interface RunStore {
  save(record: RunRecord): Promise<void>;
}
export interface SequencedProgressEvent {
  sequence: number;
}
export type ProgressEvent = SequencedProgressEvent &
  (
    | { type: "run-status"; runId: string; status: RunStatus }
    | { type: "step-status"; runId: string; stepId: string; status: StepStatus }
    | {
        type: "artifact-reference";
        runId: string;
        stepId: string;
        status: "referenced";
        artifact: ArtifactUse;
      }
    | { type: "text"; runId: string; stepId: string; text: string }
  );
