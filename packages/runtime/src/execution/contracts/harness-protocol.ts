// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Harness inputs, outputs, answer capabilities, and retry policy contracts.

import type {
  ArtifactReference,
  ArtifactUse,
  EditorialCandidateContextV1,
} from "../../artifacts/contracts.js";
import type { ContextPacket, ContextPreflightTarget } from "../../context/contracts.js";
import type {
  ReaderContextInputV1,
  ReaderContextProvenanceV1,
  ReaderContextV1,
} from "../../context/reader-context.js";
import type {
  ModelEvidence,
  SkillEvidence,
  TokenUsage,
  ToolActivitySummary,
  InferenceEvidenceIdentity,
  InferenceFailureCategory,
  InferenceFailureCondition,
  InferenceAnswerPath,
  InferenceAnswerPathReason,
  InferenceAnswerSubmissionEvidenceV1,
  InferenceConcludeNowEvidenceV1,
  InferenceDeadlineTurn,
  InferenceAttemptEvidence,
  InferenceAttemptModelTelemetryV1,
  InferenceTurnEvidence,
  InferenceProgressObservationV1,
} from "../../records/contracts.js";
import type {
  WorkflowDefinition,
  WorkflowSearchStepEvidenceV1,
  WorkflowStep,
  WorkflowTaskInput,
} from "../../workflow-contracts/contracts.js";
import type { AdmittedDocumentationPlanBinding } from "../../workflow-execution/plan-binding.js";
import type {
  ReaderTaskContextInputProjectionV1,
  ReaderTaskContextProjectionV1,
} from "../task-context.js";
import type {
  CandidateReviewSourceEvidenceV1,
  SealedStepEvidenceBindingV1,
  RunReviewScope,
} from "./run-request.js";
import type { InferenceRejectionReasonV1 } from "./inference-errors.js";

/**
 * Retry repair for a technical judgment that linked obligation IDs the sealed
 * ledger never issued, carried as `InferenceResponseCorrectionV1.detail` beside
 * the `fact-link-unknown-obligation` rejection.
 *
 * It is the one correction field a model value can reach, so each echoed ID is
 * identifier-shaped (`ECHOABLE_OBLIGATION_ID`) and within
 * `technicalCorrection.identifierMaxChars`, and the list is bounded by
 * `technicalCorrection.maxIssueJudgments` x `technicalCorrection.maxJudgmentFactIds`.
 * The decoder and the prompt builder both enforce those rules.
 */
export interface UnknownObligationIdsCorrection {
  readonly kind: "unknown-obligation-ids";
  /** Distinct cited IDs absent from the sealed ledger, in reply order. */
  readonly unknownObligationIds: readonly string[];
  /** Cited unknown values not echoed because they are not identifier-shaped. */
  readonly withheldCount: number;
}

/**
 * Retry repair for a technical judgment that rejected every obligation of an
 * applicable ledger dimension, carried as `InferenceResponseCorrectionV1.detail`
 * beside the `inventory-dimension-facts` rejection. It names only host
 * vocabulary: technical fact dimensions, each once, in ledger order. No model
 * value reaches it.
 */
export interface EmptiedApplicableDimensionsCorrection {
  readonly kind: "emptied-applicable-dimensions";
  /** Applicable ledger dimensions left with no retained or refined obligation. */
  readonly dimensions: readonly string[];
}

/** Host-vocabulary identity of the dimension whose model reason was refused. */
export interface SourceObligationDimensionReasonCorrection {
  readonly kind: "source-obligation-dimension-reason";
  readonly dimension: string;
}

/**
 * Retry repair for a final quality evaluator object whose keys differ from the
 * contract's, carried as `InferenceResponseCorrectionV1.detail` beside a
 * `quality-envelope-shape` refusal at `$` or an `evaluation-schema-required`
 * refusal. `missing` is host vocabulary. `undeclared` echoes reply key names,
 * so each is a location-segment identifier and the list is bounded by the
 * number of keys the contract declares there; any other key only counts in
 * `withheldCount`.
 */
export interface QualityKeySetCorrection {
  readonly kind: "quality-key-set";
  readonly missing: readonly string[];
  readonly undeclared: readonly string[];
  readonly withheldCount: number;
}

/**
 * Retry repair for a final evaluation whose findings name no not-documented
 * technical fact, carried beside `technical-trace-missing-fact-id`. The fact
 * IDs come from the admitted technical verification the host holds, never the
 * refused reply; each is identifier-shaped and the list is bounded by the
 * trace check's violation bound.
 */
export interface QualityTraceFactIdsCorrection {
  readonly kind: "quality-trace-fact-ids";
  readonly factIds: readonly string[];
  readonly withheldCount: number;
}

/**
 * What the host tells a bounded read-only retry about the response it refused.
 *
 * Carries the retained coded reason, never the response or the error message;
 * the prompt builder renders it from the host-owned rule-hint catalog. Absent
 * `rejection` gets the generic response-contract guidance. `detail` is a
 * closed, rule-specific repair: `UnknownObligationIdsCorrection`,
 * `EmptiedApplicableDimensionsCorrection`, `QualityKeySetCorrection`, or
 * `QualityTraceFactIdsCorrection`, or `SourceObligationDimensionReasonCorrection`.
 */
export interface InferenceResponseCorrectionV1 {
  readonly rejection?: InferenceRejectionReasonV1;
  /** The refused attempt's failure condition; the retry rule's statement is rendered for it. */
  readonly condition?: InferenceFailureCondition;
  /**
   * The retry rule that scheduled this attempt, when its catalog entry carries
   * a statement or concludes now. Its statement wins over the condition's.
   */
  readonly retryRule?: import("../../contracts/model-output.generated.js").RetryRuleId;
  readonly detail?:
    | UnknownObligationIdsCorrection
    | EmptiedApplicableDimensionsCorrection
    | SourceObligationDimensionReasonCorrection
    | QualityKeySetCorrection
    | QualityTraceFactIdsCorrection;
}

export interface HarnessStepInput {
  signal?: AbortSignal;
  /** Additional host restriction; it can only remove workflow-derived tools. */
  toolCeiling?: readonly string[];
  runId?: string;
  repositoryPath: string;
  /** Host-authenticated active workspace for CREATE V3 candidate-bound tool reads. */
  repositoryWorkspace?: import("../../repository/workspace/contracts.js").RepositoryWorkspace;
  workflow: WorkflowDefinition;
  step: WorkflowStep;
  task?: WorkflowTaskInput;
  contextPacket?: ContextPacket;
  contextTarget?: ContextPreflightTarget;
  /** Host-admitted reader context and provenance; neither grants write authority. */
  readerContextInput?: ReaderContextInputV1;
  /** Verified reader context projection assembled by the host supplier. */
  readerTaskContext?: ReaderTaskContextInputProjectionV1 | ReaderTaskContextProjectionV1;
  readerContext?: ReaderContextV1;
  readerContextProvenance?: ReaderContextProvenanceV1;
  /** Genuine admitted artifacts this step may cite; references alone are never evidence. */
  editorialEvidenceRefs?: readonly ArtifactReference[];
  /** Host-validated original candidate supplied unchanged to each selected suffix. */
  editorialCandidate?: EditorialCandidateContextV1;
  evidenceIdentity?: InferenceEvidenceIdentity;
  searchEvidence?: WorkflowSearchStepEvidenceV1;
  /** Exact candidate source bytes, observed locally and rendered only as untrusted evidence. */
  candidateReviewSourceEvidence?: CandidateReviewSourceEvidenceV1;
  /** Exact tracked base bytes captured before restructuring, never reconstructed after a write. */
  preservationBaseEvidence?: import("../../workflow-execution/source-obligation.js").PreservationBaseEvidence;
  /** Sealed hashes from earlier steps. Not untrusted prompt text. */
  sealedEvidence?: readonly SealedStepEvidenceBindingV1[];
  /** Host-selected immutable quality profile for the comprehensive evaluator. */
  qualityProfileSelection?: import("../../records/contracts.js").QualityProfileSelectionReceiptV1;
  /** Host-bound `evaluation.target.paths` for that evaluator, derived with the selection. */
  qualityEvaluationTarget?: readonly import("../../evaluation-report/evaluation-target.js").EvaluationTargetEntryV1[];
  /** Host-admitted technical result bound to the final quality evaluator. */
  technicalVerification?: import("../../workflow-execution/verification-result.js").VerificationResult;
  /**
   * Typed page-set/source binding produced by the earlier planner step.
   * A source-aware run carries the V2 variant bound to the admitted source
   * binding; a no-source run carries V1 unchanged.
   */
  planBinding?: AdmittedDocumentationPlanBinding;
  /** Host-enumerated, sealed ordinary-prose regions for one RST update writer. */
  rstAuthoring?: import("../../rst-authoring/workflow.js").RstAuthoringInput;
  /**
   * The documentation planner only: the write scope its plan admission checks,
   * stated in its prompt. Guidance; it grants nothing and plan admission stays
   * the check.
   */
  planWriteGuidance?: import("../../workflow-execution/plan-write-guidance.js").PlanWriteGuidanceV1;
  /**
   * The documentation planner and writer only: governed template structure and
   * style guidance for the known pages. Never product evidence or authority.
   */
  pageTemplateGuidance?: import("../../templates/page-guidance.js").PageTemplateGuidanceV1;
  /** Typed, read-only source evidence. It grants no path or write authority. */
  sourceObligationLedger?: import("../../workflow-execution/source-obligation.js").SourceObligationLedger;
  /** Fixed, untrusted candidate bytes from the same branch's provisional verification. */
  provisionalRichCandidateEvidence?: import("../../workflow-execution/source-obligation.js").ProvisionalRichCandidateEvidenceV1;
  /** Opaque host capability for current-byte checks against retained original source authority. */
  originalSourceAuthorityAdmission?: import("../../workflow-execution/source-obligation-authority.js").OriginalSourceAuthorityAdmission;
  /**
   * Host-observed line counts of the sealed ledger's sources, bound to their
   * digests. Supplied only to the technical judgment steps, which check a
   * dimension demotion's evidence locators against them.
   */
  admittedSourceLineCounts?: readonly import("../../workflow-execution/source-obligation.js").AdmittedSourceLineCountV1[];
  /** Exact host-admitted documentation targets for technical verification. */
  verificationTargetPaths?: readonly string[];
  /** Host-sealed actionable input supplied only to the sole CREATE V3 revision writer. */
  authoringRevisionInput?: import("../../workflow-execution/authoring-candidate.js").AuthoringRevisionInputV1;
  /** Host-selected repair for the previous rejected read-only response; never model prose. */
  responseCorrection?: InferenceResponseCorrectionV1;
  /**
   * The final quality evaluator's answer path, resolved once per step by the
   * runner (`resolveAnswerPath`) and read by both tool grants and the
   * response contract. Absent on every other step and from any caller that
   * does not resolve it, which keeps the text answer.
   */
  answerSubmission?: {
    readonly path: InferenceAnswerPath;
    readonly reason: InferenceAnswerPathReason;
  };
  /** Test-injected, attempt-scoped host capability for quality answer records. */
  qualityAnswerRecords?: QualityAnswerRecordCapabilityV1;
  /** Host-qualified, attempt-scoped capability for the S2 source-obligation records route. */
  sourceObligationAnswerRecords?: SourceObligationAnswerRecordCapabilityV1;
  /** Exact host plan paired with the S2 answer-record capability. */
  sourceObligationAnswerRecordGuidance?: string;
  /** Host-derived answer-record call ceiling paired with that capability. */
  qualityAnswerRecordCallCeiling?: number;
  /** Experimental-only shared aggregate call pool for answer records and reading. */
  qualityAnswerRecordSharedToolCapacity?: true;
  /** Host capability: experimental discovery may renew after a zero-success correction tranche. */
  experimentalAnswerRecordDiscoveryRenewal?: true;
  /** Host-derived call ceiling for the explicitly activated S2 records route. */
  sourceObligationAnswerRecordCallCeiling?: number;
  /** Host-generated exact plan/shapes for the records-only evaluator contract. */
  qualityAnswerRecordGuidance?: string;
  /** Validated checkpoint rows seeded into Pi as assistant calls and tool receipts. */
  qualityAnswerRecordReplay?: readonly QualityAnswerRecordReplayPairV1[];
  /** Host ledger state kept separate from replay call/receipt history. */
  qualityAnswerRecordRemainingKeys?: readonly string[];
  /** Content-free current required/open ledger plan for timer recomputation. */
  qualityAnswerRecordProgress?: () => QualityAnswerRecordProgressV1;
  /** Sealed #1973 fit inputs; absent or unqualified plans cannot arm records answer-now. */
  qualityAnswerNowRecordsPlan?: {
    readonly fixtureRows: import("../../model-composition/types.js").InstalledAnswerSubmissionRecords["fixtureRows"];
    readonly fullPlanBytes: number;
    readonly fullPlanMessages: number;
    readonly dFullMs: number;
    readonly reportDecodeReserveMs: number;
    readonly qualifiedMessageBudget: number;
    readonly turnLatencyMs: number;
    readonly d3ResidualFires: boolean | "unknown";
  };
  inferenceAttempt?: number;
  /** Content-free observation emitted only at settled Pi turn/tool boundaries. */
  onProgress?: (observation: InferenceProgressObservationV1) => void;
  retriesConsumed?: number;
  /**
   * Set by the runner, never inferred by a harness: `true` when no retry of a
   * `malformed-response` refusal would follow this attempt. Absent is not final.
   */
  finalInferenceAttempt?: boolean;
  instruction?: string;
  /**
   * Non-authoritative context a live agent added to the user's verbatim
   * instruction. Never parsed for targets, sources, or restrictions, and never
   * part of the instruction digest.
   */
  instructionContext?: string;
  /** Bound to EVERY step, not just the first; see `RunReviewScope`. */
  reviewScope?: RunReviewScope;
  /** Same inert reference the run carried; evidence and delivery validation only. */
  sourceBinding?: import("../../inputs/source-evidence-artifacts.js").SourceArtifactReferenceV2<"source-binding">;
  /**
   * Process-local step read capability on the non-serializable transport. It
   * never enters prompts, JSONL, run records, or artifacts. Steps without a
   * source-read grant receive none.
   */
  sourceReader?: import("../../inputs/source-resolver.js").SourceStepReaderV1;
  /** Fresh host-issued range access to sealed restructuring originals. */
  preservationSourceReader?: import("../../workflow-execution/source-obligation.js").PreservationSourceReaderV1;
  /** Host-verified exact observations shared only within an opted-in run. */
  preservationSourceObservationEvidence?: string;
  /** Run-scoped store for exact preservation observations; never persists across runs. */
  preservationSourceObservationCache?: import("../../workflow-execution/preservation-source-observation-cache.js").PreservationSourceObservationCacheV1;
  /** Absent unless the policy admits search. */
  sourceSearcher?: import("../../inputs/source-step-search.js").SourceStepSearcherV1;
  /** Absent unless the policy admits citation. */
  sourceCiter?: import("../../inputs/source-resolver.js").SourceStepCiterV1;
  /**
   * Process-local, CREATE V3 planner only: which of `paths` the run's revision
   * already holds, in any form. Planner reply admission reads it to admit a
   * plan the model proposed as an UPDATE of existing pages. Absent elsewhere.
   */
  planTargetExistence?: (paths: readonly string[]) => Promise<readonly string[]>;
  /**
   * Process-local, CREATE source-obligation derivation only: the tracked
   * regular files at the run's revision, so a refused citation records its
   * path only when the host knows it. Absent elsewhere.
   */
  trackedRepositoryPaths?: ReadonlySet<string>;
  /** Host-retained CREATE derivation paths admitted by an earlier proposal receipt. */
  admittedSourceAuthorityPaths?: readonly string[];
  onText?: (text: string) => void;
}

export type QualityAnswerRecordOutputCode =
  import("../../harness/quality-answer-record-admission.js").QualityAnswerRecordOutputCode;
export type QualityAnswerRecordReceiptV1 =
  import("../../harness/quality-answer-record-admission.js").QualityAnswerRecordReceiptV1;

/**
 * Narrow process-local record authority. Implementations bind call IDs to raw
 * captured Pi bytes and own all persistence; the harness receives no store or
 * validator-host methods. Absent outside an explicitly injected records run.
 */
export interface QualityAnswerRecordCapabilityV1 {
  /** Content-free, synchronous host ledger snapshot for the records answer reserve. */
  answerNowProgress(): QualityAnswerRecordProgressV1;
  /** One-shot readiness after settlement of a whole-artifact-validated ledger. */
  takeReportReadiness?(): boolean;
  prepareBatch(input: {
    readonly batchId: string;
    /** Complete ordered record-call proposal snapshot for this message. */
    readonly toolCalls: readonly {
      readonly toolCallId: string;
      readonly rawArguments: string | undefined;
    }[];
    /** The lease-authorized record-call prefix; no later proposal affects completion. */
    readonly authorizedToolCallIds: readonly string[];
  }): Promise<void>;
  receipt(toolCallId: string): QualityAnswerRecordReceiptV1;
  settle(input: {
    readonly batchId: string;
    /** Entire provider proposal snapshot, in call order. */
    readonly toolCallIds: readonly string[];
    /** Calls the execution lease actually authorized, in its granted prefix. */
    readonly authorizedToolCallIds: readonly string[];
    /** Authorized tool executions that returned success. */
    readonly successfulToolCallIds: readonly string[];
  }): Promise<void>;
}

/** S2 reuses the answer-record grammar and batch lifecycle with domain-owned assembly. */
export interface SourceObligationAnswerRecordCapabilityV1 {
  prepareBatch(input: {
    readonly batchId: string;
    readonly toolCalls: readonly {
      readonly toolCallId: string;
      readonly rawArguments: string | undefined;
    }[];
    readonly authorizedToolCallIds: readonly string[];
  }): Promise<void>;
  receipt(toolCallId: string): Omit<
    import("../../harness/answer-records.js").AnswerRecordReceipt,
    "code"
  > & {
    readonly code?: string;
  };
  settle(input: {
    readonly batchId: string;
    readonly toolCallIds: readonly string[];
    readonly authorizedToolCallIds: readonly string[];
    readonly successfulToolCallIds: readonly string[];
    /** Authorized failed executions whose host receipt was a declared refusal. */
    readonly failedToolCallIds: readonly string[];
  }): Promise<void>;
  finish(): Promise<
    import("../../workflow-execution/source-obligation.js").SourceObligationLedgerProposalV1
  >;
}

export interface QualityAnswerRecordProgressV1 {
  /** Required keys declared by this admission plan, before row mutations. */
  readonly requiredKeys: readonly string[];
  readonly remainingKeys: readonly string[];
  readonly completedKeys: readonly string[];
  /** Direct status of every declared open set and its host closing flag. */
  readonly openSets: readonly { readonly type: string; readonly open: boolean }[];
  readonly complete: boolean;
}

/** Runner-only owner of the harness capability and host-assembled ledger. */
export interface QualityAnswerRecordSessionV1 {
  readonly capability: QualityAnswerRecordCapabilityV1;
  /** Exact plan-derived ceiling for authorized answer-record tool calls. */
  readonly recordCallCeiling: number;
  /** Experimental discovery may borrow from the ordinary reading-call pool. */
  readonly sharedToolCallCapacity?: true;
  /** Experimental discovery continues after a correction tranche with no useful records. */
  readonly experimentalAnswerRecordDiscoveryRenewal?: true;
  /** Host-generated exact plan and resolved narrowing instructions for the model. */
  readonly promptGuidance: string;
  /** Last sealed control checkpoint restored or committed by this session. */
  restoreCheckpoint(checkpoint: {
    readonly record: import("../../records/contracts.js").AnswerRecordContinuationCheckpointEnvelopeV1;
    readonly sha256: string;
  }): Promise<void>;
  /** True when an authentic prior checkpoint was rejected as semantically stale. */
  checkpointWasStale(): boolean;
  /** Publish a child-owned checkpoint after an explicit process-resume claim. */
  materializeContinuationCheckpoint(): Promise<void>;
  latestCheckpoint(): Promise<
    | {
        readonly record: import("../../records/contracts.js").AnswerRecordContinuationCheckpointEnvelopeV1;
        readonly sha256: string;
      }
    | undefined
  >;
  replayState(): Promise<{
    readonly pairs: readonly QualityAnswerRecordReplayPairV1[];
    readonly remainingKeys: readonly string[];
    readonly completedKeys: readonly string[];
    readonly complete: boolean;
  }>;
  snapshotIndex(): Promise<
    import("../../records/contracts.js").AnswerRecordLedgerIndexV1 | undefined
  >;
  /** Mark this attempt's admitted rows released after a trusted route mismatch. */
  releaseAll(): Promise<void>;
  finish(reportMarkdown: string): Promise<{
    readonly evaluation: Record<string, unknown>;
    readonly qualityScore: Record<string, unknown> | null;
    readonly index: import("../../records/contracts.js").AnswerRecordLedgerIndexV1;
  }>;
}

export interface QualityAnswerRecordReplayPairV1 {
  readonly toolCallId: string;
  readonly type: string;
  readonly key: string;
  readonly record: import("../../json-evidence.js").JsonEvidenceValue;
  /** Exact typed-shell call arguments rebuilt from the canonical saved row. */
  readonly toolArguments: {
    readonly type: string;
    readonly key?: string;
    readonly record: import("../../json-evidence.js").JsonEvidenceValue;
  };
  readonly sourceAttempt: number;
  readonly checkpointSha256: string;
}
export interface HarnessStepResult {
  summary: string;
  verificationResult?: import("../../workflow-execution/verification-result.js").VerificationResult;
  outcome?: "succeeded" | "needs-input" | "needs-human-decision";
  model?: ModelEvidence;
  /** Actual models an installed nested composition used; never a substitute for `model`. */
  models?: readonly ModelEvidence[];
  skill?: SkillEvidence;
  usage?: TokenUsage;
  tools?: ToolActivitySummary;
  /** Attempt-wide host accounting for write-capable tool settlement. */
  writeSettlement?: InferenceAttemptEvidence["writeSettlement"];
  /**
   * Edit/write calls in this attempt that the confined mutation boundary
   * refused as denied-path. Host-internal and not persisted. Unlike a refused read, a
   * refused mutation means the writer asked for a path outside the approved
   * plan, which the aggregate failure category cannot distinguish.
   */
  mutationBoundaryDenials?: number;
  /**
   * Repository-relative paths of the repository instruction files the harness
   * supplied to this step's model. Host-internal and not persisted; a writer
   * no-change stop records them.
   */
  repositoryInstructions?: readonly string[];
  /**
   * Lines each confined `read` call in this attempt showed the model, under
   * `source-coordinates` rendering only. Host-internal and not persisted: a
   * source citation may cite only these lines.
   */
  observedSourceLines?: import("../../repository/source-citation.js").ObservedSourceLinesV1;
  /** Host-only selected-attempt raw read observation; never model input. */
  reviewReadObservation?: import("../../harness/confined-tools/source-coordinates.js").ReviewReadObservationSnapshot;
  /** Measurement only; content-free (see `judgment-row-key-audit-contract.ts`). */
  judgmentRowKeyAudit?: import("../judgment-row-key-audit-contract.js").JudgmentRowKeyAuditV1;
  /** Closed per-attempt model telemetry; see `records/model-telemetry.ts`. */
  modelTelemetry?: InferenceAttemptModelTelemetryV1;
  /** Content-free provider response byte observations, absent on old runtimes. */
  providerResponses?: InferenceAttemptEvidence["providerResponses"];
  /** Content-free runtime-dispatch and source-reuse observations. */
  efficiency?: InferenceAttemptEvidence["efficiency"];
  /** UTF-8 byte length of the reply span the step's decoder admitted. */
  answerBytes?: number;
  /** When the harness withdrew the tools and asked for the answer, and why. */
  concludeNow?: InferenceConcludeNowEvidenceV1;
  /** The final quality evaluator's answer path and, on the tool path, how far it got. */
  answerSubmission?: InferenceAnswerSubmissionEvidenceV1;
  turns?: InferenceTurnEvidence[];
  executionLease?: ExecutionLeaseRuntimeEvidenceV1;
  artifacts?: ArtifactUse[];
  /** Exact final-evaluator envelope decoded by the Pi adapter. */
  qualityArtifactCandidate?: QualityArtifactCandidateV1;
  /** Markdown-only report admitted after host-settled records assembly. */
  qualityAnswerRecordReport?: string;
  /** Content-free typed plan artifact for downstream authoring. */
  planBinding?: AdmittedDocumentationPlanBinding;
  /** Untrusted fixed-phase proposal; the host binds source bytes and identity. */
  sourceObligationProposal?: import("../../workflow-execution/source-obligation.js").SourceObligationLedgerProposalV1;
  /** Additive provenance for the canonical corrected technical result. */
  technicalCorrectionEvidence?: import("../../workflow-execution/source-obligation.js").TechnicalCorrectionEvidence;
  /** Host-sealed provisional candidate set returned by the actual Pi reply admission. */
  provisionalRichCandidateEvidence?: import("../../workflow-execution/source-obligation.js").ProvisionalRichCandidateEvidenceV1;
  /** Strict author evidence returned only by the sole CREATE V3 revision writer. */
  authoringRevisionAccounting?: import("../../workflow-execution/authoring-revision.js").AuthoringRevisionAccountingV1;
  /** Untrusted planner content. The host binds identities, producer and phase after admission. */
  editorialDecisionProposal?: import("../../artifacts/contracts.js").EditorialDecisionProposalV1;
  /** Untrusted independent assessment content. Only the host can admit its actual producer. */
  editorialAssessmentProposal?: unknown;
  /**
   * SHA-256 of a completed planner reply as decoded, so a needs-input stop
   * plan admission raises on that reply names it like a planner's own stop.
   */
  planResponseSha256?: string;
  /**
   * Present when a CREATE planner proposed its plan as an UPDATE of pages that
   * exist; the reply was admitted as a CREATE plan of those pages, and plan
   * admission records the conversion with the planner's reason.
   */
  planProposedMode?: "update";
  /** Sanitized planner protocol diagnostics retained for operator evidence. */
  planDiagnostic?: {
    schemaVersion: 1;
    kind: "docsfab-documentation-plan-diagnostic";
    code: string;
    responseSha256: string;
    responseShape: "json-object" | "invalid-json" | "json-value";
  };
}
export interface QualityArtifactCandidateV1 {
  evaluation: Record<string, unknown>;
  qualityScore: Record<string, unknown> | null;
  reportMarkdown: string;
  selectionSha256: string;
  /** Internal admission provenance; never persisted in the canonical artifact. */
  answerPath?: "text" | "tool-call";
}
export interface AgentHarness {
  inspectSkill?(input: HarnessStepInput): Promise<SkillEvidence | undefined>;
  /** Credential-free digest of the actual serving model and request policy, for test-injected record bindings when no installed composition exists. */
  qualityAnswerRecordRouteBindingSha256?(): string;
  /** Host-bound provider identity available before answer-record completion receipts are issued. */
  qualityAnswerRecordProviderId?(): string;
  runStep(input: HarnessStepInput): Promise<HarnessStepResult>;
}
export interface GovernedSkillResolver {
  resolveSkill(input: HarnessStepInput): Promise<SkillEvidence | undefined>;
}
export interface HostOperationExecutor {
  runStep(input: HarnessStepInput): Promise<HarnessStepResult>;
}
export interface InferenceRetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableCategories: InferenceFailureCategory[];
  /**
   * Separate, smaller retry budget for attempt timeouts: a timeout costs the
   * whole attempt timer, so repeating it can exhaust the job deadline. Omitted
   * means zero, not `maxRetries`. `retryBudgetForCategory` also caps it at
   * `maxRetries`.
   */
  maxTimeoutRetries?: number;
  /**
   * Retry budget, within `maxRetries`, for a structured answer cut at the output
   * limit or refused after a continuation. Omitted means zero.
   */
  maxCutAnswerRetries?: number;
  /**
   * Retry budget, within `maxRetries`, for an attempt the host stopped as
   * `no-progress`. Omitted means zero.
   */
  maxNoProgressRetries?: number;
  /**
   * Separate budget for attempts that end in a transport fault, so they never
   * spend `maxRetries`. Omitted means one shared count, the behaviour of a
   * policy built before this budget existed.
   */
  transport?: InferenceTransportRetryPolicy;
  /** Catalog/host/project provenance of `maxRetries` when the parsed policy retained it. */
  maxRetriesSource?: "config/limits.yaml" | "host" | "project";
}
/** The step-level transport budget; see `retry.maxTransport*` in config/limits/retry.yaml. */
export interface InferenceTransportRetryPolicy {
  /** Transport-failed attempts that may be retried, from `retry.maxTransportRetries`. */
  maxRetries: number;
  /** Ceiling on one wait before a transport retry, Retry-After included. */
  maxDelayMs: number;
  /** Wall clock the step may spend in transport-failed attempts and their waits. */
  maxElapsedMs: number;
}
export type ExecutionCheckpointTurnDisposition =
  | "accepted"
  | "cancelled"
  | "blank"
  | "malformed"
  | "context-exhausted"
  | "provider-failed"
  | "progress-stopped";
export type ExecutionLeaseRuntimeTerminalDisposition =
  | "completed"
  | "needs-input"
  | "needs-human-decision"
  | "cancelled"
  | "provider-failed"
  | "context-exhausted"
  | "blank"
  | "malformed"
  | "progress-stopped"
  | "authorization-denied"
  | "evidence-invalid"
  | "budget-stopped";
export interface ExecutionLeaseRuntimeEvidenceV1 {
  schemaVersion: 1;
  kind: "docsfab-pi-execution-lease-evidence";
  /** V2 explicitly marks that whole-attempt aggregate authorities are absent. */
  policyVersion?: 2;
  aggregatePolicy?: { kind: "absent" };
  policySha256: string;
  identitySha256: string;
  coordinatorSha256: string;
  phase: "active" | "batch-pending" | "checkpoint-required" | "terminal";
  terminalReason?:
    | "completed"
    | "needs-input"
    | "needs-human-decision"
    | "security-denied"
    | "authorization-denied"
    | "cancellation-requested"
    | "evidence-preservation-required"
    | "context-exhausted"
    | "hard-tool-call-ceiling"
    | "cumulative-input-limit"
    | "cumulative-output-limit"
    | "output-authority-exhausted"
    | "cumulative-time-limit"
    | "cost-unavailable"
    | "cumulative-cost-limit"
    | "provider-turn-limit"
    | "lease-limit"
    | "checkpoint-not-renewable"
    | "provider-terminal"
    | "provider-unavailable";
  terminalDisposition?: ExecutionLeaseRuntimeTerminalDisposition;
  providerTurns: number;
  checkpointProviderTurns: number;
  compactions: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  elapsedMs: number;
  toolCalls: {
    requested: number;
    executed: number;
    succeeded: number;
    failed: number;
    denied: number;
    governanceBlocked: number;
  };
  /** Optional scoped projections exist only when a host record-call plan is active. */
  toolCallsByScope?: { reading: number; answerRecord: number };
  answerRecordCallsAdmitted?: number;
  toolCallCeilings?: { reading: number; answerRecord: number };
  /** Present on new scoped evidence; absent is interpreted as legacy partitioned mode. */
  toolCallCapacityMode?: "partitioned" | "shared";
  /** Actual host attempt ceiling, including denied calls; content-free replay evidence. */
  chargeableAttemptCeiling?: number;
  checkpoints: Array<{
    sequence: number;
    leaseNumber: number;
    disposition: ExecutionCheckpointTurnDisposition;
    outputSha256: string | null;
    inputTokens: number;
    outputTokens: number;
    elapsedMs: number;
    progressObservationSha256: string | null;
    progressRecommendationSha256: string | null;
    coordinatorSha256: string;
  }>;
  resume: {
    coordinatorSha256: string;
    stateSha256: string;
    leaseCheckpointSha256: string | null;
    coordinatorCheckpointSha256: string | null;
    decisionSha256: string | null;
  };
  binding: {
    inferenceAttempt: number;
    retriesConsumed: number;
    repositoryRevision: string;
    providerTurnLedgerSha256: string;
    usageSha256: string;
    toolsSha256: string;
  };
  evidenceSha256: string;
}
