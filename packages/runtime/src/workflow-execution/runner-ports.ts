// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Host-facing ports and evaluate/editorial policies; `./runner.ts` re-exports them. */

import { createHash } from "node:crypto";
import { posix } from "node:path";

import {
  ArtifactValidationError,
  type ArtifactReference,
  type ArtifactValidationErrorCode,
} from "../artifacts/contracts.js";
import { editorialInputAskPresentationV1 } from "../artifacts/editorial-input-ask.js";
import {
  EditorialDecisionValidationError,
  type EditorialDecisionValidationErrorCode,
  type HostOwnedEditorialIdentityV1,
} from "../artifacts/editorial-decision.js";
import { ArtifactStoreError, type ArtifactStoreErrorCode } from "../artifacts/store.js";
import type { ContextPreflightService } from "../context/contracts.js";
import {
  ReaderContextValidationError,
  type ReaderContextComparisonV1,
  type ReaderContextValidationErrorCode,
} from "../context/reader-context.js";
import type {
  AgentHarness,
  GovernedSkillResolver,
  HostOperationExecutor,
  InferenceRetryPolicy,
  RunRequest,
  PrReviewCitationAdmissionV1,
  SourceEvidenceRunnerBinding,
} from "../execution/contracts.js";
import {
  ReaderTaskContextError,
  type ReaderTaskContextErrorCode,
} from "../execution/task-context.js";
import { FileRunStoreError, type FileRunStoreErrorCode } from "../records/file-store.js";
import type { ImpactPostflightService } from "../impact/contracts.js";
import type { RepositoryEvidenceCollector } from "../repository/contracts.js";
import type { RepositorySecurityScanner } from "../security/contracts.js";
import type {
  EvaluateStepEvidenceV1,
  ProgressEvent,
  RunRecord,
  RunStore,
  StepRunRecord,
} from "../records/contracts.js";
import type {
  StepMode,
  WorkflowSearchCoordinator,
  WorkflowOutcomeProjector,
  WorkflowBranchEvidenceHost,
  WorkflowStep,
  WorkflowStepKind,
} from "../workflow-contracts/contracts.js";
import { isWorkflowManifestV3 } from "../workflow-contracts/contracts.js";
import { canonicalDigest, canonicalJson, sha256 } from "../content-ir/canonical.js";
import {
  EditorialEvidenceHostError,
  type EditorialEvidenceHostErrorCode,
} from "./editorial-evidence-host.js";
import { type AdmittedDocumentationPlanBinding, type PlanWriteRefusal } from "./plan-binding.js";
import { authoritativeReviewTargetPaths } from "./verification-result.js";
import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import type { SelectedDocumentationQualityProfile } from "../evaluation-report/quality-profile-selection.js";
import { type QualityValidatorHost } from "../evaluation-report/quality-validator-host.js";
import { validateEditorialReviewResult, type ReviewResult } from "./review-response.js";
import {
  type AuthoringCandidateV1,
  type AuthoringProducerBindingV1,
} from "./authoring-candidate.js";
import { decodeAuthoringPhaseEvidenceV1 } from "../records/authoring-execution.js";
import type { AuthoringCandidateLifecycleV1 } from "./authoring-runtime.js";
import {
  reviewDocumentationTargetPaths,
  type SourceObligationSourceObserver,
} from "./source-obligation.js";
import { type OriginalSourceAuthorityEvidenceV1 } from "./source-obligation-authority.js";
import { compareText } from "../shared/primitives.js";

export function verificationTargetsForRun(input: {
  workflow: import("../workflow-contracts/contracts.js").WorkflowDefinition;
  step: WorkflowStep;
  reviewScope?: import("../execution/contracts.js").RunReviewScope;
  contextTarget?: import("../context/contracts.js").ContextPreflightTarget;
  planBinding?: AdmittedDocumentationPlanBinding;
  originalSourceAuthorityEvidence?: OriginalSourceAuthorityEvidenceV1;
}): readonly string[] | undefined {
  const explicit = authoritativeReviewTargetPaths(input);
  if (explicit || input.workflow.name !== "review-documentation") return explicit;
  const targetPaths = reviewDocumentationTargetPaths(
    (input.originalSourceAuthorityEvidence?.members ?? []).map(({ path }) => path),
  );
  return targetPaths.length > 0 ? Object.freeze(targetPaths) : undefined;
}

/** Only these storage diagnostics may cross the hosted execution boundary. */
const RUN_STORE_ERROR_CODES: ReadonlySet<string> = new Set<FileRunStoreErrorCode>([
  "invalid-root",
  "unsupported-platform",
  "unsafe-root",
  "owner-mismatch",
  "insecure-permissions",
  "unsafe-record-id",
  "serialization-failed",
  "record-exists",
  "unsafe-entry",
  "record-not-found",
  "invalid-record",
  "write-failed",
]);

/** Carries only a recognized storage code; never retains the original exception. */
export class WorkflowRunnerBoundaryError extends Error {
  constructor(
    readonly code: `run-store-${FileRunStoreErrorCode}`,
    message = "Workflow execution could not be completed.",
  ) {
    super(message);
  }
}

export function recognizedRunStoreErrorCode(error: unknown): FileRunStoreErrorCode | undefined {
  try {
    if (!(error instanceof FileRunStoreError)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    const code = descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (typeof code === "string" && RUN_STORE_ERROR_CODES.has(code))
      return code as FileRunStoreErrorCode;
  } catch {
    // An untrusted exception cannot prevent cancellation or patch preservation.
  }
  return undefined;
}

/** Closed write-capable filesystem tools; evaluate steps must never grant these. */
const EVALUATE_FORBIDDEN_WRITE_TOOLS = new Set(["edit", "write"]);

/** Read-only tool set mirrored for evaluate evidence digests (harness-neutral). */
const EVALUATE_READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "get_section"] as const;

export const provenanceRejectionError =
  "Write result retained a valid partial patch, but runtime bookkeeping provenance could not be represented.";

export type EvaluateStepRejectCode =
  | "evaluate-not-read-only"
  | "evaluate-write-tools"
  | "evaluate-path-scope-expanded"
  | "evaluate-auth-minting"
  | "evaluate-acceptance-sole-flip";

export class EvaluateStepPolicyError extends Error {
  public constructor(public readonly code: EvaluateStepRejectCode) {
    super(`Evaluate step policy rejected: ${code}.`);
    this.name = "EvaluateStepPolicyError";
  }
}

function failEvaluatePolicy(code: EvaluateStepRejectCode): never {
  throw new EvaluateStepPolicyError(code);
}

export interface EvaluateStepPolicyInput {
  step: Pick<WorkflowStep, "id" | "kind" | "mode" | "skill">;
  grantedTools?: readonly string[];
  /** The step would expand intended paths beyond the declared scope. */
  pathScopeExpanded?: boolean;
  /** The step would mint write/tracker authorization. */
  authMinting?: boolean;
}

/** Fail-closed gates for catalog `evaluate` steps; a no-op for other kinds. */
export function assertEvaluateStepPolicy(input: EvaluateStepPolicyInput): void {
  if ((input.step.kind ?? "inference") !== "evaluate") return;
  if (input.step.mode !== "read-only") {
    failEvaluatePolicy("evaluate-not-read-only");
  }
  const granted = input.grantedTools ?? EVALUATE_READ_ONLY_TOOLS;
  if (granted.some((tool) => EVALUATE_FORBIDDEN_WRITE_TOOLS.has(tool))) {
    failEvaluatePolicy("evaluate-write-tools");
  }
  if (input.pathScopeExpanded) {
    failEvaluatePolicy("evaluate-path-scope-expanded");
  }
  if (input.authMinting) {
    failEvaluatePolicy("evaluate-auth-minting");
  }
}

/**
 * Admit the exact candidate-zero editorial phase before its summary can enter
 * the corrected canonical technical context.
 */
export function admitCandidate0EditorialForCanonical(input: {
  runId: string;
  repositoryRevision: string;
  workflow: import("../workflow-contracts/contracts.js").WorkflowDefinition;
  candidate0: AuthoringCandidateV1 | undefined;
  step: StepRunRecord | undefined;
}): AuthoringProducerBindingV1<ReviewResult> {
  const { candidate0, step } = input;
  if (
    !isWorkflowManifestV3(input.workflow) ||
    input.workflow.authoringSchedule.selection.afterStepId !== "verify-technical-accuracy" ||
    !candidate0 ||
    candidate0.ordinal !== 0 ||
    candidate0.runId !== input.runId ||
    candidate0.originalRevision !== input.repositoryRevision ||
    step?.id !== "review-documentation" ||
    step.status !== "succeeded" ||
    !step.summary ||
    !step.authoringPhase
  ) {
    throw new Error(
      "Canonical technical correction requires admitted candidate-zero editorial evidence.",
    );
  }
  const phase = decodeAuthoringPhaseEvidenceV1(step.authoringPhase, {
    workflow: input.workflow,
    branchId: null,
    candidates: [candidate0],
  });
  const result = validateEditorialReviewResult(parseJsonEvidence(step.summary));
  if (
    phase.stepId !== "review-documentation" ||
    phase.role !== "editorial" ||
    phase.assessedCandidateOrdinal !== 0 ||
    phase.assessedCandidateDigest !== candidate0.digest ||
    phase.workspaceSnapshotDigest !== candidate0.workspaceSnapshotDigest ||
    phase.summarySha256 !== sha256(step.summary) ||
    canonicalizeJsonEvidence(result as unknown as JsonEvidenceValue).trimEnd() !== step.summary
  ) {
    throw new Error(
      "Canonical technical correction rejected stale candidate-zero editorial evidence.",
    );
  }
  return {
    summary: step.summary,
    summaryDigest: phase.summarySha256,
    producerId: step.id,
    candidateDigest: candidate0.digest,
    candidateOrdinal: 0,
    workspaceSnapshotDigest: candidate0.workspaceSnapshotDigest,
    result,
  };
}

/**
 * Acceptance remains host/decoder/machine-check owned. Evaluate alone never
 * flips a work-unit Acceptance to passed.
 */
export function assertEvaluateCannotSoleFlipAcceptance(input: {
  acceptancePassed: boolean;
  authorities: readonly ("evaluate" | "host" | "machine-check")[];
  /** When set, an evaluate step claiming sole Acceptance authority is rejected. */
  soleAuthorityStepKind?: WorkflowStepKind;
}): void {
  if (input.soleAuthorityStepKind === "evaluate") {
    failEvaluatePolicy("evaluate-acceptance-sole-flip");
  }
  if (!input.acceptancePassed) return;
  const nonEvaluate = input.authorities.some((authority) => authority !== "evaluate");
  if (!nonEvaluate) {
    failEvaluatePolicy("evaluate-acceptance-sole-flip");
  }
}

/** Content-free evaluate evidence digests for the run record. */
export function buildEvaluateStepEvidence(input: {
  evaluatorSkillId: string;
  evaluatorContentSha256: string;
  mode: StepMode;
  grantedTools?: readonly string[];
}): EvaluateStepEvidenceV1 {
  const grantedTools = [...(input.grantedTools ?? EVALUATE_READ_ONLY_TOOLS)].sort();
  return {
    schemaVersion: 1,
    kind: "docsfab-evaluate-step-evidence",
    evaluatorIdentitySha256: canonicalDigest({
      skillId: input.evaluatorSkillId,
      contentSha256: input.evaluatorContentSha256,
    }),
    toolPolicySha256: canonicalDigest({
      mode: input.mode,
      grantedTools,
    }),
    acceptancePolicySha256: canonicalDigest({
      soleFlip: false,
      authority: "evaluate-step-plus-host",
    }),
  };
}

export type { SourceEvidenceRunnerBinding };

export interface EditorialAdmittedSourceV1 {
  readonly uri: string;
  readonly sha256: string;
  readonly role: string;
}

export interface EditorialPlannedPageAdmissionV1 {
  readonly workflowBranchEvidence: WorkflowBranchEvidenceHost;
  readonly editorialEvidenceRefs: readonly ArtifactReference[];
  readonly sources: readonly EditorialAdmittedSourceV1[];
  readonly comparison: ReaderContextComparisonV1;
}

export interface EditorialAdmissionControlV1 {
  readonly comparison: ReaderContextComparisonV1;
  readonly sources: readonly EditorialAdmittedSourceV1[];
  readonly editorialEvidenceRefs?: readonly ArtifactReference[];
  readonly refreshForPlannedPages?: (
    pages: readonly string[],
  ) => Promise<EditorialPlannedPageAdmissionV1>;
}

export type EditorialInputAskFillKindV1 =
  import("../artifacts/editorial-input-ask.js").EditorialInputAskFillKindV1;

export interface EditorialInputAskSlotV1 {
  readonly inputId: string;
  readonly code: string;
  readonly label: string;
  readonly why: string;
  readonly fillKind: EditorialInputAskFillKindV1;
}

/**
 * What a trusted domain admission port says about a write run that finalized
 * with no changed file. A refusal names its own operator code so the runner can
 * record the actual cause; it is a value, never an exception.
 */
export type EmptyWriteResultAdmissionV1 =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly code: string };

/**
 * The pages a local run may write: its documentation write roots, directories
 * ending in `/` and exact file roots, and the one documentation write rule
 * under them. `rule` returns `undefined` for a path inside the scope and
 * otherwise why it is outside.
 */
export interface DocumentationPlanWriteScope {
  readonly roots: readonly string[];
  readonly rule: (path: string) => PlanWriteRefusal | undefined;
  /** Exact existing RST page selected by CLI patch-only admission, if any. */
  readonly rstUpdatePaths?: readonly string[];
}

export interface WorkflowRunnerOptions {
  /** Fresh GitLab CLI's private pinned before/after source; never a saved record. */
  reviewChangeSource?: import("../harness/confined-tools/review-change-side.js").ReviewChangeSource;
  /** Local read-only review observation CAS; absent on hosted and older runners. */
  reviewLocatorArtifacts?: import("../artifacts/store.js").DurableArtifactStore;
  /** Host-owned original provider result and the existing private artifact store. */
  reviewResultRetention?: {
    readonly artifacts: import("../artifacts/store.js").DurableArtifactStore;
    readonly prepare: (record: Readonly<RunRecord>) => Promise<{
      readonly originalResult: import("../review/contracts.js").ReviewResult;
      readonly sourceReference: import("../records/review-delivery-snapshot-reference.js").ReviewDeliverySnapshotReferenceV1;
    }>;
  };
  /** Effective per-run evidence input representation, resolved after host environment loading. */
  evidenceInputFormatPolicy?: import("../harness/evidence-input-format.js").EvidenceInputFormatPolicyV1;
  harness: AgentHarness;
  /**
   * Experimental evidence projection strategy. `eager` preserves the current
   * preservation-base delivery to every restructuring stage. `stage-specific`
   * withholds the eager full base only from audience assessment; exact source
   * access and preservation evidence for other stages keep their existing
   * step-scoped contracts. Defaults to `eager` until paired model qualification.
   */
  preservationBaseDelivery?: "eager" | "stage-specific";
  /** Independent default-off opt-in to seed exact reads from the accuracy verifier. */
  preservationObservationReuse?: boolean;
  /** Host-captured original operator targets, saved only for continuation naming. */
  operatorTargetPaths?: readonly string[];
  /** Fixed host ceiling intersected with derived grants, never a new grant. */
  toolCeiling?: readonly string[];
  /**
   * Coded lines first pass decided before the run, such as a source the
   * request's reading names that it did not bind. The queued record keeps
   * each in `evidenceWarnings`, so every stop and result lists it.
   */
  firstPassNotices?: readonly string[];
  /**
   * The paths a navigation companion may modify: a hosted run's exact modify
   * targets. A companion outside it is labeled, never admitted. Absent on a
   * local run, which grants `docs/` and `fern/` inside its write scope.
   */
  documentationCompanionGrant?: readonly string[];
  /**
   * A local run's documentation write scope, whatever its request reading or
   * first-pass binding: the roots, and the rule every planned write path,
   * navigation companions included, must pass. Plan admission refuses any
   * other path before a write step. Absent on a hosted run, whose host
   * authority confines its writes.
   */
  planWriteScope?: DocumentationPlanWriteScope;
  /** Internal local preflight result for one caller-bound RST update. */
  rstCapabilityAdmission?: import("../rst-authoring/capability-admission.js").RstCapabilityAdmissionV1;
  /** Exact tracked revision used to bind a local RST writer's base bytes and static graph. */
  rstRepositoryWorkspace?: import("../repository/workspace/contracts.js").RepositoryWorkspace;
  /** Process-local original bytes and selected span retained until patch capture. */
  rstCaptureBinding?: import("../rst-authoring/workflow.js").RstCaptureBinding;
  /**
   * The verified governed template set. When present, the documentation
   * planner and writer read template structure guidance for their pages;
   * absent, they run without it.
   */
  templateSet?: import("../templates/load.js").TemplateSetCapability;
  /**
   * A hosted documentation run's operator naming: plan admission refuses a
   * planned agent instruction file or hidden path that `named` does not name,
   * as a local run's `planWriteScope` does; the host grant confines every
   * other write. `roots` is the grant's path ceiling, named in the refusal.
   */
  hostedPlanNaming?: {
    readonly roots: readonly string[];
    readonly named: import("../repository/operator-named-paths.js").OperatorNamedPaths;
  };
  /** Process-local source-evidence service and effective policy. */
  sourceEvidence?: SourceEvidenceRunnerBinding;
  /** Process-local citation grant bound to the selected public PR and source policy. */
  prReviewCitationAdmission?: PrReviewCitationAdmissionV1;
  /**
   * The sealed change-source records the run bound, cited on the queued save.
   * Non-empty by type, so a run without a change carries no key.
   */
  changeSources?: import("../records/change-sources.js").RunChangeSourcesV1;
  /** A release run's sealed units index and its page, cited on the queued save. */
  changeSourceRelease?: import("../records/change-source-release.js").RunChangeSourceReleaseV1;
  /** Exact Pin B+C identity verified before a product workflow starts. */
  qualityPackEvidence?: import("../records/contracts.js").QualityPackEvidenceV1;
  /**
   * The bound route's recorded answer submission and the operator's
   * `DOCSFAB_ANSWER_SUBMISSION` option. The runner resolves the final
   * quality evaluator's answer path from them once per step; absent resolves
   * to the text answer.
   */
  answerSubmission?: {
    readonly capability?: import("../model-composition/types.js").InstalledAnswerSubmission;
    readonly option: import("../config/answer-submission.js").AnswerSubmissionOption;
  };
  /** Resolve authoring quality only after the exact final candidate exists. */
  prepareAuthoringQualityValidation?: (input: {
    readonly workflow: import("../workflow-contracts/contracts.js").WorkflowDefinition;
    readonly record: RunRecord;
    readonly workspacePath: string;
    readonly targetPaths: readonly string[];
    readonly repositoryEvidence: RepositoryEvidenceCollector;
    readonly capture?: import("./authoring-workspace-host.js").AuthoringCandidateCaptureV1;
    readonly repositoryWorkspace?: import("../repository/workspace/contracts.js").RepositoryWorkspace;
  }) => Promise<NonNullable<WorkflowRunnerOptions["qualityValidation"]>>;
  /** Runtime-owned profile selection and validator seam for comprehensive review. */
  qualityValidation?: {
    selection: SelectedDocumentationQualityProfile;
    host: QualityValidatorHost;
  };
  /** Explicit activation gate for the S2 answer-record adapter; absent by default. */
  sourceObligationAnswerRecordRouteEnabled?: boolean;
  /**
   * The `--source` and `--pr` pins the run bound, recorded on the queued save.
   * Absent when the run bound neither, so such a run carries no key.
   */
  retainedEvidenceBindings?: import("../records/retained-evidence-bindings.js").RetainedEvidenceBindingsV1;
  skillResolver?: GovernedSkillResolver;
  /** Required only by catalog steps whose kind is host-operation. */
  hostOperations?: HostOperationExecutor;
  store: RunStore;
  /** Strict run-index projection awaited after a durable answer-record checkpoint pointer is saved. */
  publishAnswerRecordProgress?: (record: RunRecord) => Promise<void>;
  /** Host-resolved exact source checkpoint; never populated from model text. */
  answerRecordContinuation?: {
    readonly logicalRunId: string;
    readonly sourceRunId: string;
    readonly checkpoint: {
      readonly record: import("../records/contracts.js").AnswerRecordContinuationCheckpointEnvelopeV1;
      readonly sha256: string;
    };
    readonly resumeStepId: string;
    readonly completedPrefix: readonly StepRunRecord[];
    readonly selectedPathId?: string;
    readonly selectionEvidence?: {
      readonly workflowBranchCoverage?: RunRecord["workflowBranchCoverage"];
      readonly authoringExecution?: RunRecord["authoringExecution"];
    };
    readonly sourceArtifacts?: RunRecord["artifacts"];
  };
  /** Deferred claim for the exact checkpoint, called after successful host restore. */
  claimAnswerRecordContinuation?: (
    child?: import("../records/contracts.js").RunRecord,
  ) => Promise<void>;
  /** Sealed fit projection for answer-record answer-now; absent means fail-safe unarmed. */
  qualityAnswerNowRecordsPlan?: {
    readonly fixtureRows: import("../model-composition/types.js").InstalledAnswerSubmissionRecords["fixtureRows"];
    readonly fullPlanBytes: number;
    readonly fullPlanMessages: number;
    readonly dFullMs: number;
    readonly reportDecodeReserveMs: number;
    readonly qualifiedMessageBudget: number;
    readonly turnLatencyMs: number;
    readonly d3ResidualFires: boolean | "unknown";
  };
  repositoryScanner: RepositorySecurityScanner;
  contextPreflight?: ContextPreflightService;
  impactPostflight?: ImpactPostflightService;
  repositoryEvidence?: RepositoryEvidenceCollector;
  /** When configured, every catalog search plan completes before its model/host step. */
  workflowSearch?: WorkflowSearchCoordinator;
  sourceObligationObserver?: SourceObligationSourceObserver;
  /** Local-only authenticated candidate lifecycle for CREATE Manifest V3. */
  authoringCandidateLifecycle?: AuthoringCandidateLifecycleV1;
  /** Harness-neutral product projection, separate from execution success/failure. */
  outcomeProjector?: WorkflowOutcomeProjector;
  /**
   * Trusted domain admission after actual evidence capture; never installed by
   * serialized input. `admit` reports a refusal instead of throwing: the runner
   * records `admitted: false` as a classified run failure, while a throw would
   * escape finalization as an unclassified rejection with no stored cause.
   */
  emptyWriteResultAdmission?: {
    admit(record: Readonly<RunRecord>): Promise<EmptyWriteResultAdmissionV1>;
  };
  /** Host-owned admission for the closed update-documentation V2 selection. */
  workflowBranchEvidence?: WorkflowBranchEvidenceHost;
  /** CLI/hosted admission identity used to auto-admit planned pages before select(). */
  editorialAdmission?: EditorialAdmissionControlV1;
  retryPolicy?: InferenceRetryPolicy;
  retrySleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  id?: () => string;
  onProgress?: (event: ProgressEvent) => void;
}

export interface FirstPassDocumentationTargetControl {
  readonly workflow: "create-documentation" | "update-documentation";
  readonly instructionSha256: string;
  readonly repositoryRevision: string;
  readonly targetPaths: readonly string[];
  readonly bodySha256: string;
}

const FIRST_PASS_TARGET_CONTROL_KEYS = [
  "workflow",
  "instructionSha256",
  "repositoryRevision",
  "targetPaths",
  "bodySha256",
] as const;
const SHA256 = /^[a-f0-9]{64}$/u;
const REPOSITORY_REVISION = /^[a-f0-9]{40,64}$/u;
const SAFE_DOCUMENTATION_TARGET = /^(?!\.)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u;

export { compareText };

function firstPassTargetControlFailure(): never {
  throw new Error("First-pass documentation target control does not match the workflow request.");
}

export function validateFirstPassTargetControl(
  value: FirstPassDocumentationTargetControl | undefined,
  request: RunRequest,
): FirstPassDocumentationTargetControl | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return firstPassTargetControlFailure();
  }
  const valueKeys = Reflect.ownKeys(value);
  if (
    Object.getPrototypeOf(value) !== Object.prototype ||
    valueKeys.length !== FIRST_PASS_TARGET_CONTROL_KEYS.length ||
    valueKeys.some(
      (key) =>
        typeof key !== "string" ||
        !FIRST_PASS_TARGET_CONTROL_KEYS.includes(
          key as (typeof FIRST_PASS_TARGET_CONTROL_KEYS)[number],
        ),
    ) ||
    (value.workflow !== "create-documentation" && value.workflow !== "update-documentation") ||
    value.workflow !== request.workflow ||
    typeof value.instructionSha256 !== "string" ||
    !SHA256.test(value.instructionSha256) ||
    typeof value.repositoryRevision !== "string" ||
    !REPOSITORY_REVISION.test(value.repositoryRevision) ||
    value.repositoryRevision !== request.repository.revision ||
    !Array.isArray(value.targetPaths) ||
    value.targetPaths.length === 0 ||
    typeof value.bodySha256 !== "string" ||
    !SHA256.test(value.bodySha256)
  ) {
    return firstPassTargetControlFailure();
  }
  const targetPaths = value.targetPaths as readonly unknown[];
  if (
    targetPaths.some(
      (path) =>
        typeof path !== "string" ||
        !SAFE_DOCUMENTATION_TARGET.test(path) ||
        path.includes("\\") ||
        posix.isAbsolute(path) ||
        posix.normalize(path) !== path,
    ) ||
    targetPaths.some(
      (path, index) =>
        index > 0 && compareText(targetPaths[index - 1] as string, path as string) >= 0,
    )
  ) {
    return firstPassTargetControlFailure();
  }
  const instructionSha256 = createHash("sha256")
    .update((request.instruction ?? "").normalize("NFC"), "utf8")
    .digest("hex");
  if (value.instructionSha256 !== instructionSha256) return firstPassTargetControlFailure();
  const bodySha256 = createHash("sha256")
    .update(
      JSON.stringify({
        workflow: value.workflow,
        instructionSha256: value.instructionSha256,
        repositoryRevision: value.repositoryRevision,
        targetPaths: value.targetPaths,
      }),
      "utf8",
    )
    .digest("hex");
  if (value.bodySha256 !== bodySha256) return firstPassTargetControlFailure();
  return Object.freeze({
    workflow: value.workflow,
    instructionSha256: value.instructionSha256,
    repositoryRevision: value.repositoryRevision,
    targetPaths: Object.freeze([...(value.targetPaths as readonly string[])]),
    bodySha256: value.bodySha256,
  });
}

const EDITORIAL_INPUT_ASK_FALLBACK = editorialInputAskPresentationV1("editorial-identity")!;

/**
 * Codes the runner itself assigns when editorial selection stops, as opposed
 * to codes a contract validator raised. None of them claims a reviewer
 * rejected anything: no independent reviewer has run when selection happens.
 */
export const EDITORIAL_SELECT_HOST_STOP_CODES = Object.freeze({
  /**
   * The validator refused a `no-change` candidate whose admitted evidence
   * does not support it (for example, an unknown comparison). The validator
   * names that refusal `independent-rejection` because at finalize it is one;
   * at selection the only producer is the planner, so it is a host check.
   */
  noChangeUnsupported: "no-change-unsupported",
  /** Selection threw something that is not a typed contract refusal. */
  hostFailure: "host-failure",
} as const);

export type EditorialSelectHostStopCode =
  (typeof EDITORIAL_SELECT_HOST_STOP_CODES)[keyof typeof EDITORIAL_SELECT_HOST_STOP_CODES];

/** Every code an editorial selection stop can carry; closed so no new code appears unreviewed. */
export type EditorialSelectStopCode =
  | EditorialSelectHostStopCode
  | Exclude<EditorialDecisionValidationErrorCode, "independent-rejection">
  | EditorialEvidenceHostErrorCode
  | ReaderContextValidationErrorCode
  | ReaderTaskContextErrorCode
  | ArtifactValidationErrorCode
  | ArtifactStoreErrorCode;

/**
 * The only caller runs after an editorial-candidate selection step, so the
 * declared workflow is already an update. There, an admitted plan that writes
 * pages under a write grant is a directed update; with a known comparison the
 * planner's own candidate stands. Request wording never decides this.
 */
export function shouldHostBindDirectedUpdate(input: {
  readonly planMutates: boolean;
  readonly allowWrite: boolean;
  readonly comparisonUnknown: boolean;
}): boolean {
  return input.planMutates && input.allowWrite && input.comparisonUnknown;
}

export function synthesizeEditorialInputAskSlots(input: {
  readonly code: EditorialSelectStopCode;
  readonly comparisonUnknown: boolean;
  readonly sourceRoles: readonly string[];
  readonly planPages: readonly string[];
  readonly assessmentOnly: boolean;
}): readonly EditorialInputAskSlotV1[] {
  const roles = new Set(input.sourceRoles);
  const missing: string[] = [];
  if (input.comparisonUnknown) missing.push("comparison");
  if (!roles.has("current-documentation") && input.planPages.length > 0) {
    missing.push("current-documentation");
  }
  if (!roles.has("public-contract")) missing.push("public-contract");
  if (!roles.has("request")) missing.push("request");
  if (input.assessmentOnly && !roles.has("accepted-knowledge")) {
    missing.push("prd", "accepted-decision");
  }
  const ids = missing.length > 0 ? missing : ["editorial-identity"];
  return Object.freeze(
    ids.map((inputId) => {
      const catalog = editorialInputAskPresentationV1(inputId) ?? EDITORIAL_INPUT_ASK_FALLBACK;
      return Object.freeze({
        inputId,
        code: input.code,
        label: catalog.label,
        why: catalog.why,
        fillKind: catalog.fillKind,
      });
    }),
  );
}

/**
 * Name why `editorialHost.select` threw. Typed contract refusals keep their
 * code, except the validator's `independent-rejection`: selection builds a
 * candidate-phase payload whose only producer is the planner, so that refusal
 * is the no-change evidence check, not a reviewer's rejection.
 *
 * The typed classes are every contract error `EditorialEvidenceHostV1.select`
 * can raise, read from its call graph: the host's own checks, the proposal
 * and candidate validators, the reader context and provenance validators, the
 * reader task context projection, artifact reference and canonical JSON
 * validation, and the artifact store. Anything else, including an untyped
 * error that carries a code-shaped field, is a host failure, never a rejection.
 */
export function editorialSelectErrorCode(error: unknown): EditorialSelectStopCode {
  if (error instanceof EditorialDecisionValidationError) {
    return error.code === "independent-rejection"
      ? EDITORIAL_SELECT_HOST_STOP_CODES.noChangeUnsupported
      : error.code;
  }
  if (
    error instanceof EditorialEvidenceHostError ||
    error instanceof ReaderContextValidationError ||
    error instanceof ReaderTaskContextError ||
    error instanceof ArtifactValidationError ||
    error instanceof ArtifactStoreError
  ) {
    return error.code;
  }
  return EDITORIAL_SELECT_HOST_STOP_CODES.hostFailure;
}

export function rejectedProposalDigest(proposal: unknown): string {
  try {
    return sha256(canonicalJson(proposal));
  } catch {
    return sha256("editorial-select-rejected");
  }
}

export function uniqueDocumentationPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((path) => SAFE_DOCUMENTATION_TARGET.test(path)))].sort(
    compareText,
  );
}

export function hostOwnedEditorialIdentity(input: {
  readonly artifactEvidenceRefs: readonly ArtifactReference[];
  readonly sources: readonly EditorialAdmittedSourceV1[];
}): HostOwnedEditorialIdentityV1 {
  return {
    artifactEvidenceRefs: input.artifactEvidenceRefs,
    sourceEvidence: input.sources.map((source) => ({ uri: source.uri, sha256: source.sha256 })),
  };
}
