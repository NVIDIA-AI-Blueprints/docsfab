// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readAnswersAskedEarly, type AnswerAskedEarlyReading } from "./answer-asked-early.js";
import { INFERENCE_CONCLUDE_NOW_TRIGGERS } from "../records/inference-retry-rule-vocabulary.js";
import { RUN_STATUS_KEYS, type RunRecord, type RunStatus } from "../records/contracts.js";
import type { InferenceProgressObservationV1 } from "../records/contracts.js";
import { decodeInferenceProgressObservation } from "../records/inference-progress.js";
import {
  decodeRunRetainedDeliveryV1,
  type RunRetainedDeliveryV1,
} from "../records/retained-delivery.js";
import {
  decodeCheckoutPersistenceOutcome,
  overallRunStatus,
} from "../records/checkout-persistence.js";
import { decodeAnswerRecordDiscoveryExecutionV1 } from "../records/answer-record-discovery.js";
import {
  comparesDistinctCommits,
  isNoChangeBasisLimitation,
  NO_CHANGE_NOMINATED_COVERAGE_BASIS_LIMITATION,
} from "../artifacts/editorial-decision.js";
import {
  decodeRunEditorialOutcomeV1,
  type RunEditorialOutcomeV1,
} from "../host-invoker/contracts.js";
import type {
  ProductDisposition,
  WorkflowBranchCoverageV1,
  WorkflowName,
} from "../workflow-contracts/contracts.js";
import {
  inspectQualityReportFromRun,
  type QualityReportProjection,
} from "../evaluation-report/index.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "./json-evidence.js";
import {
  projectDocChangeDeltaCliSurface,
  type DocChangeDeltaCliSurfaceV1,
} from "./doc-change-delta-surface.js";
import {
  decodeRunRecordEditorialEvidence,
  workflowOutcomeState,
  type WorkflowOutcomeDecodeOptionsV1,
  type WorkflowOutcomeExitPolicyV1,
} from "../workflow-contracts/outcome.js";
import {
  normalizeReviewFinding,
  projectReviewFindingsFromRun,
  REVIEW_FINDINGS_PROJECTOR,
  type ProjectedReviewFindingsV1,
  type ReviewFindingV1,
  type ReviewFindingsAvailability,
} from "../review/index.js";
import { reviewEvidenceLimitations, type ReviewEvidenceProjectionV1 } from "./review-evidence.js";
import {
  INFERENCE_RETRY_DECISION_TOKENS,
  RETRY_ELIGIBILITY_DISAGREEMENT,
  readRunRetryDispositions,
  type InferenceRetryDispositionReadingV1,
} from "./retry-disposition.js";
import {
  PROVIDER_ATTEMPT_ACCOUNTING_UNAVAILABLE,
  PROVIDER_ATTEMPT_COVERAGES,
} from "../model/provider-attempt.js";
import { isProviderTurnReplayVeto } from "../records/inference-retry-disposition.js";
import { isRejectedReplyExcerptOf } from "../execution/rejected-reply-excerpt.js";
import { isInferenceRejectedReplyShape } from "../execution/rejected-reply-shape.js";
import {
  projectRunFailureOccurrences,
  readFailureClassification,
  type FailureOccurrenceV1,
} from "./failure-classification.js";
import {
  collectRunLimitOverflowEvidence,
  mergeRunLimitOverflowEvidence,
  projectRunLimitOverflowLines,
  type RunLimitOverflowEvidenceV1,
} from "./run-limit-overflow.js";
import { sha256 } from "../content-ir/canonical.js";
import { decodeCredentialFindings } from "../delivery/run-record.js";
import {
  projectCredentialFindingsForPresentation,
  type CredentialFinding,
} from "../security/credential-findings.js";
import { admittedCreateConversion } from "../workflow-contracts/create-conversion.js";
import { admittedKeptUnchangedPages } from "../workflow-contracts/kept-pages.js";
import { validateSourceAuthorityProposalAdmissionV1 } from "../workflow-execution/source-obligation-authority.js";
import { compareText } from "../shared/primitives.js";
import { getWorkflow } from "../workflow-registry/catalog.js";
import { isSelfConsistentAnswerRecordContinuation } from "../records/composition-execution.js";
import {
  readRequiredCheckLimitations,
  REQUIRED_CHECK_NOT_RUN_LIMITATION,
} from "../workflow-execution/required-check-limitation.js";
import {
  FIRST_PASS_EVIDENCE_GAPS_LIMITATION,
  readFirstPassEvidenceGapLines,
} from "../cli/first-pass-evidence-gaps.js";
import {
  isCreateConversionReason,
  isDocumentationPlanPath,
  type CreateConversionReason,
} from "../workflow-execution/plan-binding.js";
import {
  admitPlannerDiagnostic,
  isPlannerResponseShape,
  PLANNER_MISSING_GOVERNED_INPUT_CODES,
} from "../workflow-contracts/planner-diagnostic.js";

export const RUN_RESULT_SCHEMA_VERSION = 1 as const;

const MISSING_GOVERNED_INPUT_CODE_VALUES = PLANNER_MISSING_GOVERNED_INPUT_CODES;
const INVALID_MODEL_OUTPUT_CODE_VALUES = [
  "invalid-json",
  "invalid-envelope",
  "invalid-summary",
  "invalid-shape",
  "invalid-mode",
  "empty-pages",
  "invalid-path",
  "duplicate-page",
  "invalid-disposition",
  "missing-source-binding",
  "duplicate-source-binding",
  "invalid-source",
  "digest-mismatch",
  "unknown",
] as const;
const MISSING_GOVERNED_INPUT_CODES = new Set<string>(MISSING_GOVERNED_INPUT_CODE_VALUES);
const INVALID_MODEL_OUTPUT_CODES = new Set<string>(INVALID_MODEL_OUTPUT_CODE_VALUES);
const SHA256 = /^[a-f0-9]{64}$/u;

export type RunPlannerDiagnosticCategoryV1 = "invalid-model-output" | "missing-governed-input";
export type RunPlannerDiagnosticCodeV1 =
  | (typeof MISSING_GOVERNED_INPUT_CODE_VALUES)[number]
  | (typeof INVALID_MODEL_OUTPUT_CODE_VALUES)[number];

/** Content-free planner evidence admitted from a frozen diagnostic envelope. */
export interface RunPlannerDiagnosticV1 {
  readonly category: RunPlannerDiagnosticCategoryV1;
  readonly code: RunPlannerDiagnosticCodeV1;
  readonly responseShape: "json-object" | "invalid-json" | "json-value";
  readonly responseSha256: string;
}

export interface RunProductProjectionV1 {
  readonly disposition: ProductDisposition | "legacy-no-product-disposition" | null;
  readonly findings: readonly string[];
  readonly limitations: readonly string[];
  readonly openDecisions: readonly string[];
  readonly plannerDiagnostic?: RunPlannerDiagnosticV1;
}

export interface RunResultCompositionExecutionV1 {
  compositionId: string;
  evidenceSha256: string;
  aggregateSha256: string | null;
  technicalApproval: "not-established";
  roleQualification: "not-established";
  releaseEligible: false;
}

export { decodeRunEditorialOutcomeV1 };
export type { RunEditorialOutcomeV1 };

export interface RunReviewFindingsProjectionV1 {
  readonly projector: typeof REVIEW_FINDINGS_PROJECTOR;
  readonly availability: ReviewFindingsAvailability;
  readonly artifactLocator: string | null;
  readonly limitations: readonly string[];
}

/** Run delivery index lookup as `runs show` reports it. */
export type RunResultPublicationV1 =
  | {
      readonly status: "found";
      readonly mergeRequestIid: number;
      readonly mergeRequestUrl: string;
      readonly sourceBranch: string;
      readonly targetBranch: string;
      readonly headRevision: string;
      /** Receipt disposition now, as the receipt store reports it. */
      readonly disposition: string;
      readonly receiptSha256AtOpen: string;
      readonly receiptSha256Current: string;
    }
  | { readonly status: "absent"; readonly code: string; readonly checkedRoot: string }
  | {
      readonly status: "refused";
      readonly code: string;
      readonly detail: string;
      readonly checkedRoot: string;
    };

export interface RunResultV1 {
  schemaVersion: typeof RUN_RESULT_SCHEMA_VERSION;
  kind: "docsfab-run-result";
  execution: {
    runId: string;
    workflow: WorkflowName;
    status: RunStatus;
    /** Workflow execution status before the optional checkout application. */
    workflowStatus?: RunStatus;
    checkoutPersistence?: import("../records/checkout-persistence.js").CheckoutPersistenceOutcomeV1;
    exitCode: 0 | 1 | 2;
    repository: {
      path: string;
      revision: string;
    };
    recordPath: string;
    patchPath: string | null;
    patchSha256: string | null;
    /** Content-free delta summary or an unavailable limitation; null without a patch. */
    docChangeDelta: DocChangeDeltaCliSurfaceV1 | null;
    durationMs: number | null;
  };
  product: {
    disposition: ProductDisposition | "legacy-no-product-disposition" | null;
    findings: readonly string[];
    limitations: readonly string[];
    openDecisions: readonly string[];
  };
  /** Editorial evidence is independent of execution, product disposition, and quality. */
  editorial?: RunEditorialOutcomeV1;
  quality: QualityReportProjection | null;
  /** Content-free credential-like findings; exact configured credentials remain private. */
  credentialFindings?: readonly CredentialFinding[];
  reviewFindings?: readonly ReviewFindingV1[];
  /** Additive for schema-v1 readers. */
  reviewFindingsProjection?: RunReviewFindingsProjectionV1;
  /** Sanitized planner protocol evidence, separate from sealed product findings. */
  plannerDiagnostic?: RunPlannerDiagnosticV1;
  /**
   * The host converted the CREATE plan's one existing page into an UPDATE of
   * it. Additive for schema-v1 readers; absent when nothing converted.
   */
  createConvertedToUpdate?: RunCreateConversionV1;
  /**
   * Saved-run replay only: the draft merge request the run delivery index
   * records for this run. Additive for schema-v1 readers and inside the
   * digested body; absent for a run with no publishable patch.
   */
  publication?: RunResultPublicationV1;
  /** Current retained local resources, independent of workflow and publication verdicts. */
  retainedDelivery?: RunRetainedDeliveryV1;
  /**
   * Every page the update plan kept unchanged (disposition `retain`), sorted,
   * including a page the request named. Additive for schema-v1
   * readers; absent when the plan kept no page.
   */
  keptUnchangedPages?: readonly string[];
  /** Host-admitted or refused CREATE source proposals retained on derivation. */
  sourceProposalAdmissions?: readonly import("../workflow-execution/source-obligation-authority.js").SourceAuthorityProposalAdmissionV1[];
  htmlReport: {
    url: string;
    path: string;
    digestSha256: string;
  } | null;
  /** Present only for an explicitly selected executable composition. */
  compositionExecution?: RunResultCompositionExecutionV1;
  /** Explicit unqualified execution provenance for answer-record discovery. */
  answerRecordDiscovery?: import("../records/answer-record-discovery.js").AnswerRecordDiscoveryExecutionV1;
  /** Latest optional content-free Pi boundary snapshot for each observed step. */
  inferenceProgress?: readonly RunInferenceProgressReadingV1[];
  /**
   * The condition/decision pair for every attempt of a failed or retried step,
   * verbatim from decoded record fields. Absent when no step has a retry story.
   */
  retryDispositions?: readonly InferenceRetryDispositionReadingV1[];
  /** Every classified failure the record names; absent when nothing failed. */
  failures?: readonly FailureOccurrenceV1[];
  nextSteps: readonly string[];
  /** Recover-class overflow from sealed evidence; absent when empty. */
  limitOverflow?: readonly string[];
  /**
   * Attempts the host asked to answer before the model finished reading, so
   * their answers came from partial reading; absent when none.
   */
  answersAskedEarly?: readonly AnswerAskedEarlyReading[];
  resultSha256: string;
}

export interface RunInferenceProgressReadingV1 {
  readonly stepId: string;
  readonly observation: InferenceProgressObservationV1;
}

/** A CREATE-to-UPDATE conversion as the run result reports it. */
export interface RunCreateConversionV1 {
  readonly path: string;
  readonly reason: CreateConversionReason;
}

export interface BuildRunResultInput {
  record: RunRecord;
  recordPath: string;
  exitCode: 0 | 1 | 2;
  repositoryPath: string;
  nextSteps?: readonly string[];
  /** Pre-write content digest; required for DocChangeDelta when the run has no artifact refs. */
  repositoryContentDigestSha256?: string;
  editorialDecodeOptions?: WorkflowOutcomeDecodeOptionsV1;
  htmlReport?: RunResultV1["htmlReport"];
  /** Preloaded retained-artifact projection for initial and replay parity. */
  reviewFindingsProjection?: ProjectedReviewFindingsV1;
  reviewEvidenceProjection?: ReviewEvidenceProjectionV1;
  limitOverflowEvidence?: RunLimitOverflowEvidenceV1;
  /** Saved-run delivery lookup; distinct from RunSummaryContext.publication. */
  deliveryLookup?: RunResultPublicationV1;
  retainedDelivery?: RunRetainedDeliveryV1;
}

export function buildRunResultV1(input: BuildRunResultInput): RunResultV1 {
  const { record, recordPath, exitCode, repositoryPath } = input;
  const retainedDelivery =
    input.retainedDelivery === undefined
      ? undefined
      : decodeRunRetainedDeliveryV1(input.retainedDelivery);
  const projection = projectRunProduct(record, input.editorialDecodeOptions);
  const editorial = projectRunEditorialOutcome(record, input.editorialDecodeOptions);
  const { plannerDiagnostic, ...product } = projection;
  const patch = record.changes?.patch;
  const {
    quality,
    error: qualityError,
    limitation: qualityLimitation,
  } = inspectQualityReportFromRun(record, {
    qualityNotApplicable: editorial.outcome === "verified-no-change",
  });
  // A malformed quality projection must not discard independently verified
  // report metadata.
  const htmlReport = input.htmlReport ?? null;
  const review = input.reviewFindingsProjection ?? projectReviewFindingsFromRun(record);
  // Required checks the run could not run (#1918): a product limitation code,
  // and each recorded line, which names the command to run, in `nextSteps`.
  const requiredCheckLimitations = readRequiredCheckLimitations(record);
  const productWithReviewLimitations = {
    ...product,
    limitations: [
      ...new Set([
        ...product.limitations,
        ...(qualityError ? ["quality-projection-unavailable"] : []),
        ...(qualityLimitation ? [qualityLimitation] : []),
        ...(requiredCheckLimitations.length > 0 ? [REQUIRED_CHECK_NOT_RUN_LIMITATION] : []),
        // First pass continued with evidence gaps; `limitOverflow` lists them (#2113).
        ...(readFirstPassEvidenceGapLines(record).length > 0
          ? [FIRST_PASS_EVIDENCE_GAPS_LIMITATION]
          : []),
        ...review.limitations,
        ...(input.reviewEvidenceProjection
          ? reviewEvidenceLimitations(input.reviewEvidenceProjection)
          : []),
      ]),
    ],
  };
  const docChangeDelta = projectDocChangeDeltaCliSurface({
    record,
    ...(input.repositoryContentDigestSha256
      ? { repositoryContentDigestSha256: input.repositoryContentDigestSha256 }
      : {}),
  });
  const compositionExecution = projectRunCompositionExecution(record);
  const conversion = admittedCreateConversion(record);
  const keptUnchangedPages = admittedKeptUnchangedPages(record);
  const sourceProposalAdmissions =
    record.steps.find((step) => step.id === "derive-source-obligations")
      ?.sourceProposalAdmissions ?? [];
  const retryDispositions = readRunRetryDispositions(record);
  const answersAskedEarly = readAnswersAskedEarly(record);
  const inferenceProgress = record.steps.flatMap((step) =>
    step.inferenceProgress
      ? [{ stepId: step.id, observation: structuredClone(step.inferenceProgress) }]
      : [],
  );
  const failures = projectRunFailureOccurrences(record);
  const credentialFindings = projectCredentialFindingsForPresentation(record.credentialFindings);
  if (record.credentialFindings !== undefined) decodeCredentialFindings(record.credentialFindings);
  if (credentialFindings) assertCredentialFindingProjection(credentialFindings);
  const overflowLines = projectRunLimitOverflowLines(
    mergeRunLimitOverflowEvidence(
      collectRunLimitOverflowEvidence(record),
      input.limitOverflowEvidence,
    ),
  );
  const body = {
    schemaVersion: RUN_RESULT_SCHEMA_VERSION,
    kind: "docsfab-run-result" as const,
    execution: {
      runId: record.id,
      workflow: record.workflow,
      status: overallRunStatus(record),
      ...(record.checkoutPersistence
        ? { workflowStatus: record.status, checkoutPersistence: record.checkoutPersistence }
        : {}),
      exitCode,
      repository: {
        path: repositoryPath,
        revision: record.repository.revision,
      },
      recordPath,
      patchPath: patch?.artifactPath ?? null,
      patchSha256: patch?.sha256 ?? null,
      docChangeDelta,
      durationMs: record.durationMs ?? null,
    },
    product: productWithReviewLimitations,
    editorial,
    quality,
    ...(credentialFindings ? { credentialFindings } : {}),
    htmlReport,
    ...(input.deliveryLookup ? { publication: input.deliveryLookup } : {}),
    ...(retainedDelivery ? { retainedDelivery } : {}),
    ...(plannerDiagnostic ? { plannerDiagnostic } : {}),
    ...(conversion
      ? { createConvertedToUpdate: { path: conversion.path, reason: conversion.reason } }
      : {}),
    ...(keptUnchangedPages.length > 0 ? { keptUnchangedPages: [...keptUnchangedPages] } : {}),
    ...(sourceProposalAdmissions.length > 0
      ? {
          sourceProposalAdmissions: sourceProposalAdmissions.map(
            validateSourceAuthorityProposalAdmissionV1,
          ),
        }
      : {}),
    ...(record.workflow === "review-documentation"
      ? {
          reviewFindings: review.findings,
          reviewFindingsProjection: {
            projector: review.projector,
            availability: review.availability,
            artifactLocator: review.artifactLocator,
            limitations: review.limitations,
          },
        }
      : review.findings.length > 0
        ? { reviewFindings: review.findings }
        : {}),
    ...(compositionExecution ? { compositionExecution } : {}),
    ...(record.answerRecordDiscovery
      ? { answerRecordDiscovery: structuredClone(record.answerRecordDiscovery) }
      : {}),
    ...(inferenceProgress.length > 0 ? { inferenceProgress } : {}),
    ...(retryDispositions.length > 0 ? { retryDispositions } : {}),
    ...(failures.length > 0 ? { failures } : {}),
    ...(overflowLines.length > 0 ? { limitOverflow: overflowLines } : {}),
    ...(answersAskedEarly.length > 0 ? { answersAskedEarly } : {}),
    nextSteps: [
      ...(input.nextSteps ?? []),
      ...(qualityError ? [qualityError] : []),
      ...requiredCheckLimitations,
    ],
  };
  return Object.freeze({
    ...body,
    resultSha256: sha256(canonicalizeJsonEvidence(body as unknown as JsonEvidenceValue)),
  });
}

/**
 * Project retained editorial evidence through the strict record decoder.
 * Without decoders the result is explicitly unavailable; with them, invalid
 * evidence is a hard error.
 */
export function projectRunEditorialOutcome(
  record: RunRecord,
  options: WorkflowOutcomeDecodeOptionsV1 = {},
): RunEditorialOutcomeV1 {
  const hasDecisionReference = (record.artifacts ?? []).some(
    (use) => use.role === "output" && use.reference.kind === "editorial-decision",
  );
  if (
    (hasDecisionReference && !options.decodeEditorialDecision) ||
    (record.workflowBranchCoverage !== undefined && !options.decodeWorkflowBranchCoverage)
  ) {
    return unavailableEditorialOutcome("editorial-evidence-unresolved");
  }
  const editorial = decodeRunRecordEditorialEvidence(record, options);
  if (editorial.state === "editorial-evidence-unavailable") {
    return unavailableEditorialOutcome("editorial-evidence-unavailable");
  }
  if (editorial.state === "current-preselection") {
    return unavailableEditorialOutcome("editorial-selection-pending");
  }

  const decision = editorial.validated ?? editorial.candidate;
  const state = editorial.validated ? "validated" : "candidate";
  let outcome: Exclude<RunEditorialOutcomeV1, { state: "unavailable" }>["outcome"];
  const addedLimitations: string[] = [];
  if (decision.candidate === "insufficient-evidence") {
    outcome = "insufficient-evidence";
    addedLimitations.push("insufficient-evidence");
  } else if (decision.candidate === "no-change") {
    // A validated decision on a run that did not succeed (for example, a
    // refused product outcome after every step) is not a verified result.
    const verified = Boolean(editorial.validated) && record.status === "succeeded";
    outcome = verified ? "verified-no-change" : "insufficient-evidence";
    if (!verified) addedLimitations.push("no-change-unverified");
    // Every no-change without a comparison of two distinct commits names its
    // basis. A decision without a code rests on nominated source coverage:
    // decisions sealed before the codes existed carry none, and coverage was
    // then the only basis outside a commit comparison.
    if (
      !comparesDistinctCommits(decision.comparison) &&
      !decision.limitations.some(isNoChangeBasisLimitation)
    ) {
      addedLimitations.push(NO_CHANGE_NOMINATED_COVERAGE_BASIS_LIMITATION);
    }
  } else if (isExecutedAuthorUpdate(record, editorial.coverage, Boolean(editorial.validated))) {
    outcome = "executed-update";
  } else {
    outcome = "update-recommended";
    addedLimitations.push("update-not-executed");
  }

  return Object.freeze({
    state,
    outcome,
    decision: decision.candidate,
    candidateReference: structuredClone(editorial.candidateReference),
    validatedReference: editorial.validatedReference
      ? structuredClone(editorial.validatedReference)
      : null,
    evidenceRefs: decision.evidenceRefs.map((reference) => structuredClone(reference)),
    limitations: uniqueStrings([...decision.limitations, ...addedLimitations]),
  });
}

function unavailableEditorialOutcome(limitation: string): RunEditorialOutcomeV1 {
  return Object.freeze({
    state: "unavailable",
    outcome: "unavailable",
    decision: null,
    candidateReference: null,
    validatedReference: null,
    evidenceRefs: [] as const,
    limitations: [limitation],
  });
}

function isExecutedAuthorUpdate(
  record: RunRecord,
  coverage: WorkflowBranchCoverageV1 | undefined,
  validated: boolean,
): boolean {
  return (
    validated &&
    record.status === "succeeded" &&
    coverage?.selection?.branchId === "author" &&
    record.steps.some(
      (step) =>
        step.id === "write-documentation" && step.mode === "write" && step.status === "succeeded",
    ) &&
    (record.changes?.files.length ?? 0) > 0 &&
    (record.changes?.patch?.byteLength ?? 0) > 0
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Project only product facts supported by sealed outcome or strictly admitted
 * planner evidence. A missing outcome on a failed/current record is not proof
 * that the record predates structured product disposition.
 */
export function projectRunProduct(
  record: RunRecord,
  decodeOptions: WorkflowOutcomeDecodeOptionsV1 = {},
): RunProductProjectionV1 {
  const outcome = workflowOutcomeState(record, decodeOptions);
  const plannerDiagnostic = projectPlannerDiagnostic(record);
  if (outcome.state === "current") {
    // A sealed planner governed-input stop keeps its admitted planner evidence
    // beside the outcome, so PRODUCT and NEXT still name it.
    const plannerStop =
      outcome.outcome.disposition === "needs-input" &&
      plannerDiagnostic?.category === "missing-governed-input"
        ? plannerDiagnostic
        : undefined;
    return Object.freeze({
      disposition: outcome.outcome.disposition,
      findings: outcome.outcome.findings.map((finding) => finding.code),
      limitations: [...outcome.outcome.limitations],
      openDecisions: outcome.outcome.openDecisions.map((decision) => decision.id),
      ...(plannerStop ? { plannerDiagnostic: plannerStop } : {}),
    });
  }

  if (plannerDiagnostic) {
    return Object.freeze({
      disposition: plannerDiagnostic.category === "missing-governed-input" ? "needs-input" : null,
      findings: [],
      limitations: ["structured-product-outcome-unavailable"],
      openDecisions: [],
      plannerDiagnostic,
    });
  }

  if (record.status === "succeeded" && !containsPlannerDiagnosticEvidence(record)) {
    return Object.freeze({
      disposition: "legacy-no-product-disposition",
      findings: [],
      limitations: [],
      openDecisions: [],
    });
  }

  return Object.freeze({
    disposition: null,
    findings: [],
    limitations: ["structured-product-outcome-unavailable", "planner-diagnostic-unavailable"],
    openDecisions: [],
  });
}

function containsPlannerDiagnosticEvidence(record: RunRecord): boolean {
  if (!Array.isArray(record.steps)) return true;
  for (const step of record.steps as unknown[]) {
    if (!step || typeof step !== "object" || Array.isArray(step)) return true;
    if ("planDiagnostic" in step) return true;
  }
  return false;
}

/**
 * Categorize the admitted planner diagnostic, or `undefined`. The authoring
 * outcome projector reads the same admission.
 */
function projectPlannerDiagnostic(record: RunRecord): RunPlannerDiagnosticV1 | undefined {
  const admitted = admitPlannerDiagnostic(record);
  if (!admitted) return undefined;
  const category = MISSING_GOVERNED_INPUT_CODES.has(admitted.code)
    ? "missing-governed-input"
    : INVALID_MODEL_OUTPUT_CODES.has(admitted.code)
      ? "invalid-model-output"
      : undefined;
  if (!category) return undefined;
  return Object.freeze({
    category,
    code: admitted.code as RunPlannerDiagnosticCodeV1,
    responseShape: admitted.responseShape,
    responseSha256: admitted.responseSha256,
  });
}

/**
 * Serialized with control, format, and line-separator characters escaped. They
 * are valid raw in JSON but can restyle or reorder a terminal line, and model
 * text such as a reply excerpt can carry them; escaped, they denote the same
 * string.
 */
export function serializeRunResultV1(result: RunResultV1): string {
  if (result.retainedDelivery !== undefined) {
    decodeRunRetainedDeliveryV1(result.retainedDelivery);
  }
  if (result.credentialFindings !== undefined) {
    assertCredentialFindingProjection(result.credentialFindings);
  }
  return `${escapeInvisibleJsonCharacters(
    canonicalizeJsonEvidence(result as unknown as JsonEvidenceValue),
  )}\n`;
}

/**
 * `json` with C1 control, format, and line-separator characters written as
 * `\uXXXX`. They can occur only inside strings, so the value is unchanged.
 */
export function escapeInvisibleJsonCharacters(json: string): string {
  return json.replace(INVISIBLE_CHARACTERS, escapeUtf16Units);
}

const INVISIBLE_CHARACTERS = /[\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/gu;

function escapeUtf16Units(character: string): string {
  let escaped = "";
  for (let index = 0; index < character.length; index += 1) {
    escaped += `\\u${character.charCodeAt(index).toString(16).padStart(4, "0")}`;
  }
  return escaped;
}

export function decodeRunResultV1(value: unknown): RunResultV1 {
  if (!value || typeof value !== "object") {
    throw new Error("The docsfab run result envelope must be a JSON object.");
  }
  const root = value as RunResultV1;
  if (root.kind !== "docsfab-run-result" || root.schemaVersion !== RUN_RESULT_SCHEMA_VERSION) {
    throw new Error("The docsfab run result envelope has an invalid kind or schema version.");
  }
  if (!root.execution?.runId || !root.resultSha256) {
    throw new Error("The docsfab run result envelope is missing required execution fields.");
  }
  if (root.execution.checkoutPersistence !== undefined) {
    decodeCheckoutPersistenceOutcome(root.execution.checkoutPersistence);
    if (
      root.execution.workflowStatus === undefined ||
      typeof root.execution.workflowStatus !== "string" ||
      !Object.hasOwn(RUN_STATUS_KEYS, root.execution.workflowStatus) ||
      root.execution.status !==
        overallRunStatus({
          status: root.execution.workflowStatus,
          checkoutPersistence: root.execution.checkoutPersistence,
        })
    )
      throw new Error("The docsfab run result has inconsistent checkout persistence.");
  } else if (root.execution.workflowStatus !== undefined) {
    throw new Error("The docsfab run result has inconsistent checkout persistence.");
  }
  if (typeof root.resultSha256 !== "string" || !SHA256.test(root.resultSha256)) {
    throw new Error("The docsfab run result envelope has an invalid result digest.");
  }
  if (root.compositionExecution !== undefined) {
    assertRunResultCompositionExecution(root.compositionExecution);
  }
  if (root.answerRecordDiscovery !== undefined) {
    const evidence = decodeAnswerRecordDiscoveryExecutionV1(root.answerRecordDiscovery);
    if (
      evidence.runBinding.runId !== root.execution.runId ||
      evidence.runBinding.workflow !== root.execution.workflow ||
      evidence.runBinding.repositoryRevision !== root.execution.repository.revision ||
      evidence.composition.workflow.id !== root.execution.workflow ||
      root.compositionExecution !== undefined
    ) {
      throw new Error("The docsfab run result has invalid experimental discovery provenance.");
    }
  }
  if (root.publication !== undefined) {
    assertRunResultPublication(root.publication);
  }
  const retainedDelivery = Object.getOwnPropertyDescriptor(root, "retainedDelivery");
  if (retainedDelivery) {
    if (!("value" in retainedDelivery)) {
      throw new Error("The docsfab run result has an invalid retained delivery display.");
    }
    decodeRunRetainedDeliveryV1(retainedDelivery.value);
  }
  if (root.plannerDiagnostic !== undefined) {
    assertRunResultPlannerDiagnostic(root.plannerDiagnostic);
  }
  if (root.createConvertedToUpdate !== undefined) {
    assertRunResultCreateConversion(root.createConvertedToUpdate);
  }
  if (root.keptUnchangedPages !== undefined) {
    assertRunResultKeptUnchangedPages(root.keptUnchangedPages);
  }
  if (root.sourceProposalAdmissions !== undefined) {
    if (root.execution.workflow !== "create-documentation") {
      throw new Error("The docsfab run result envelope has source proposals outside CREATE.");
    }
    assertRunResultSourceProposalAdmissions(root.sourceProposalAdmissions);
  }
  if (root.editorial !== undefined) {
    decodeRunEditorialOutcomeV1(root.editorial);
  }
  if (root.credentialFindings !== undefined) {
    assertCredentialFindingProjection(root.credentialFindings);
  }
  if (root.reviewFindings !== undefined) {
    if (!Array.isArray(root.reviewFindings) || root.reviewFindings.length > 256) {
      throw new Error("The docsfab run result envelope has invalid review findings.");
    }
    for (const finding of root.reviewFindings) normalizeReviewFinding(finding);
  }
  if (root.reviewFindingsProjection !== undefined) {
    assertRunReviewFindingsProjection(root.reviewFindingsProjection);
  }
  if (root.retryDispositions !== undefined) {
    assertRunResultRetryDispositions(root.retryDispositions);
  }
  if (root.inferenceProgress !== undefined) {
    assertRunResultInferenceProgress(root.inferenceProgress);
  }
  if (root.failures !== undefined) {
    assertRunResultFailures(root.failures);
  }
  if (root.answersAskedEarly !== undefined) {
    assertRunResultAnswersAskedEarly(root.answersAskedEarly);
  }
  return root;
}

/** Reuse the metadata contract with its display allowance, then require its safe public form. */
function assertCredentialFindingProjection(value: unknown): void {
  decodeCredentialFindings(value, "presentation");
  const projected = projectCredentialFindingsForPresentation(value as readonly CredentialFinding[]);
  if (
    canonicalizeJsonEvidence(value as JsonEvidenceValue) !==
    canonicalizeJsonEvidence((projected ?? []) as unknown as JsonEvidenceValue)
  ) {
    throw new Error("The docsfab run result has unsafe credential finding metadata.");
  }
}

function assertRunResultSourceProposalAdmissions(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("The docsfab run result envelope has invalid source proposal admissions.");
  }
  value.forEach(validateSourceAuthorityProposalAdmissionV1);
}

function assertRunResultInferenceProgress(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("The docsfab run result has invalid inference progress.");
  }
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("The docsfab run result has invalid inference progress.");
    }
    const item = raw as Record<string, unknown>;
    if (
      Object.keys(item).length !== 2 ||
      !Object.hasOwn(item, "stepId") ||
      !Object.hasOwn(item, "observation") ||
      typeof item.stepId !== "string" ||
      item.stepId.length === 0 ||
      seen.has(item.stepId)
    ) {
      throw new Error("The docsfab run result has invalid inference progress.");
    }
    try {
      decodeInferenceProgressObservation(item.observation);
    } catch {
      throw new Error("The docsfab run result has invalid inference progress.");
    }
    seen.add(item.stepId);
  }
}

function assertRunResultAnswersAskedEarly(
  value: unknown,
): asserts value is readonly AnswerAskedEarlyReading[] {
  const valid =
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => {
      const reading = entry as Record<string, unknown> | null;
      return (
        reading !== null &&
        typeof reading === "object" &&
        Object.keys(reading).sort().join(",") === "attempt,outcome,stepId,trigger,turn" &&
        typeof reading.stepId === "string" &&
        Number.isSafeInteger(reading.attempt) &&
        (reading.attempt as number) >= 1 &&
        (INFERENCE_CONCLUDE_NOW_TRIGGERS as readonly unknown[]).includes(reading.trigger) &&
        Number.isSafeInteger(reading.turn) &&
        (reading.turn as number) >= 1 &&
        typeof reading.outcome === "string"
      );
    });
  if (!valid) throw new Error("The docsfab run result envelope has invalid answers asked early.");
}

function assertRunResultCreateConversion(value: unknown): asserts value is RunCreateConversionV1 {
  const conversion = value as Record<string, unknown> | null;
  if (
    !conversion ||
    typeof conversion !== "object" ||
    Array.isArray(conversion) ||
    Object.keys(conversion).sort().join("\0") !== "path\0reason" ||
    !isCreateConversionReason(conversion.reason) ||
    typeof conversion.path !== "string" ||
    !isDocumentationPlanPath(conversion.path)
  ) {
    throw new Error("The docsfab run result envelope has an invalid CREATE conversion.");
  }
}

const PUBLICATION_KEYS = {
  found: [
    "disposition",
    "headRevision",
    "mergeRequestIid",
    "mergeRequestUrl",
    "receiptSha256AtOpen",
    "receiptSha256Current",
    "sourceBranch",
    "status",
    "targetBranch",
  ],
  absent: ["checkedRoot", "code", "status"],
  refused: ["checkedRoot", "code", "detail", "status"],
} as const;

function assertRunResultPublication(value: unknown): asserts value is RunResultPublicationV1 {
  const publication = value as Record<string, unknown> | null;
  const status = publication?.status;
  const keys =
    status === "found" || status === "absent" || status === "refused"
      ? PUBLICATION_KEYS[status]
      : undefined;
  if (
    !publication ||
    typeof publication !== "object" ||
    Array.isArray(publication) ||
    keys === undefined ||
    Object.keys(publication).sort().join("\0") !== keys.join("\0") ||
    Object.entries(publication).some(
      ([key, field]) =>
        key !== "mergeRequestIid" && (typeof field !== "string" || field.length === 0),
    ) ||
    (status === "found" &&
      (!Number.isSafeInteger(publication.mergeRequestIid) ||
        (publication.mergeRequestIid as number) <= 0 ||
        !SHA256.test(publication.receiptSha256AtOpen as string) ||
        !SHA256.test(publication.receiptSha256Current as string)))
  ) {
    throw new Error("The docsfab run result envelope has an invalid publication lookup.");
  }
}

/** Unique, sorted plan page paths; an empty list is absent, never present. */
function assertRunResultKeptUnchangedPages(value: unknown): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (path, index) =>
        typeof path !== "string" ||
        !isDocumentationPlanPath(path) ||
        (index > 0 && compareText(value[index - 1] as string, path) >= 0),
    )
  ) {
    throw new Error("The docsfab run result envelope has invalid kept unchanged pages.");
  }
}

/** An unknown class, layer, or scope is refused rather than printed as a cause. */
function assertRunResultFailures(value: unknown): asserts value is readonly FailureOccurrenceV1[] {
  if (!Array.isArray(value)) {
    throw new Error("The docsfab run result envelope has invalid failure classes.");
  }
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("The docsfab run result envelope has invalid failure classes.");
    }
    const { scope, stepId, attempt, ...classification } = entry as Record<string, unknown>;
    if (
      !readFailureClassification(classification) ||
      (scope !== "run" && scope !== "step" && scope !== "attempt") ||
      (scope === "run" ? stepId !== undefined : typeof stepId !== "string") ||
      (attempt !== undefined &&
        (scope !== "attempt" || !Number.isSafeInteger(attempt) || (attempt as number) < 1))
    ) {
      throw new Error("The docsfab run result envelope has invalid failure classes.");
    }
  }
}

function assertRunResultRetryDispositions(
  value: unknown,
): asserts value is readonly InferenceRetryDispositionReadingV1[] {
  if (!Array.isArray(value)) {
    throw new Error("The docsfab run result envelope has invalid retry dispositions.");
  }
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("The docsfab run result envelope has invalid retry dispositions.");
    }
    const reading = entry as Record<string, unknown>;
    if (
      typeof reading.stepId !== "string" ||
      (typeof reading.attempt !== "number" && reading.attempt !== "unavailable") ||
      typeof reading.outcome !== "string" ||
      typeof reading.conditionRetryability !== "string" ||
      typeof reading.retryDecision !== "string" ||
      !(INFERENCE_RETRY_DECISION_TOKENS as readonly string[]).includes(
        reading.decisionToken as string,
      )
    ) {
      throw new Error("The docsfab run result envelope has invalid retry dispositions.");
    }
    if (reading.retryable !== undefined) {
      if (
        reading.retryable !== true &&
        reading.retryable !== false &&
        reading.retryable !== "unavailable"
      ) {
        throw new Error("The docsfab run result envelope has invalid retry dispositions.");
      }
    }
    if (reading.retriesRemaining !== undefined) {
      if (
        reading.retriesRemaining !== "unavailable" &&
        (typeof reading.retriesRemaining !== "number" ||
          !Number.isInteger(reading.retriesRemaining) ||
          reading.retriesRemaining < 0)
      ) {
        throw new Error("The docsfab run result envelope has invalid retry dispositions.");
      }
    }
    if (
      reading.eligibilityDisagreement !== undefined &&
      reading.eligibilityDisagreement !== RETRY_ELIGIBILITY_DISAGREEMENT
    ) {
      throw new Error("The docsfab run result envelope has invalid retry dispositions.");
    }
    if (reading.rejection !== undefined) {
      if (
        !reading.rejection ||
        typeof reading.rejection !== "object" ||
        Array.isArray(reading.rejection) ||
        typeof (reading.rejection as { code?: unknown }).code !== "string" ||
        typeof (reading.rejection as { location?: unknown }).location !== "string"
      ) {
        throw new Error("The docsfab run result envelope has invalid retry dispositions.");
      }
    }
    // When present it must be a well-formed, content-free fingerprint.
    if (
      reading.rejectedReplyShape !== undefined &&
      !isInferenceRejectedReplyShape(reading.rejectedReplyShape)
    ) {
      throw new Error("The docsfab run result envelope has invalid retry dispositions.");
    }
    if (
      reading.rejectedReplyExcerpt !== undefined &&
      !isRejectedReplyExcerptOf(reading.rejectedReplyExcerpt, reading.rejectedReplyShape, {
        projected: true,
      })
    ) {
      throw new Error("The docsfab run result envelope has invalid retry dispositions.");
    }
    // Every reading this build writes carries `physicalAttempts`. An unknown
    // veto token is refused rather than passed into operator prose.
    assertRunResultPhysicalAttempts(reading.physicalAttempts);
    if (reading.replayVeto !== undefined && !isProviderTurnReplayVeto(reading.replayVeto)) {
      throw new Error("The docsfab run result envelope has invalid retry dispositions.");
    }
  }
}

/**
 * The `unavailable` sentinel or complete non-negative counts with a closed
 * coverage word. The envelope is untrusted, so a malformed count is refused
 * rather than shown to an operator as fact.
 */
function assertRunResultPhysicalAttempts(value: unknown): void {
  if (value === PROVIDER_ATTEMPT_ACCOUNTING_UNAVAILABLE) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The docsfab run result envelope has invalid retry dispositions.");
  }
  const accounting = value as Record<string, unknown>;
  for (const key of [
    "logicalTurns",
    "physicalRequests",
    "replayedRequests",
    "blankRequests",
    "governorStoppedTurns",
    "unaccountedTurns",
  ]) {
    const count = accounting[key];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new Error("The docsfab run result envelope has invalid retry dispositions.");
    }
  }
  // Optional: envelopes written before request-policy refusals were counted lack it.
  const refused = accounting.requestPolicyRefusedTurns;
  if (
    refused !== undefined &&
    (typeof refused !== "number" || !Number.isSafeInteger(refused) || refused < 0)
  ) {
    throw new Error("The docsfab run result envelope has invalid retry dispositions.");
  }
  if (!(PROVIDER_ATTEMPT_COVERAGES as readonly unknown[]).includes(accounting.coverage)) {
    throw new Error("The docsfab run result envelope has invalid retry dispositions.");
  }
}

function assertRunReviewFindingsProjection(
  value: RunReviewFindingsProjectionV1,
): asserts value is RunReviewFindingsProjectionV1 {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join("\0") !==
      ["artifactLocator", "availability", "limitations", "projector"].sort().join("\0") ||
    value.projector !== REVIEW_FINDINGS_PROJECTOR ||
    !["complete", "partial", "unavailable", "invalid"].includes(value.availability) ||
    (value.artifactLocator !== null &&
      !/^record:sha256:[a-f0-9]{64}$/u.test(value.artifactLocator)) ||
    !Array.isArray(value.limitations) ||
    value.limitations.some(
      (limitation) =>
        typeof limitation !== "string" ||
        limitation.length === 0 ||
        limitation.length > 512 ||
        /^\s|\s$/u.test(limitation),
    )
  ) {
    throw new Error("The docsfab run result envelope has invalid review findings projection.");
  }
}

function assertRunResultPlannerDiagnostic(
  value: RunPlannerDiagnosticV1,
): asserts value is RunPlannerDiagnosticV1 {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join("\0") !==
      ["category", "code", "responseShape", "responseSha256"].sort().join("\0") ||
    typeof value.code !== "string" ||
    typeof value.responseSha256 !== "string" ||
    !SHA256.test(value.responseSha256) ||
    !isPlannerResponseShape(value.responseShape) ||
    (value.category === "missing-governed-input"
      ? !MISSING_GOVERNED_INPUT_CODES.has(value.code)
      : value.category === "invalid-model-output"
        ? !INVALID_MODEL_OUTPUT_CODES.has(value.code)
        : true)
  ) {
    throw new Error(
      "The docsfab run result envelope has invalid sanitized planner diagnostic fields.",
    );
  }
}

/** Content-minimized composition status shared by the human and JSON projections. */
export function projectRunCompositionExecution(
  record: RunRecord,
): RunResultCompositionExecutionV1 | undefined {
  const continuation =
    record.answerRecordContinuation !== undefined &&
    isSelfConsistentAnswerRecordContinuation(record, getWorkflow(record.workflow));
  if (record.answerRecordContinuation !== undefined && !continuation) {
    throw new Error(
      "Composition run output rejected inconsistent continuation provenance for this physical attempt.",
    );
  }
  if (
    record.compositionExecution === undefined &&
    record.compositionExecutionAggregate === undefined
  ) {
    return undefined;
  }
  if (record.compositionExecution === undefined) {
    throw new Error(
      "Composition run output requires its original sealed composition selection evidence.",
    );
  }
  const evidence = record.compositionExecution;
  const aggregate = record.compositionExecutionAggregate;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(evidence.compositionId) ||
    !/^[a-f0-9]{64}$/u.test(evidence.evidenceSha256) ||
    evidence.technicalApproval !== "not-established" ||
    evidence.roleQualification !== "not-established" ||
    evidence.releaseEligible !== false ||
    (record.status === "succeeded" && aggregate === undefined && !continuation) ||
    (aggregate !== undefined &&
      (!/^[a-f0-9]{64}$/u.test(aggregate.aggregateSha256) ||
        aggregate.compositionEvidenceSha256 !== evidence.evidenceSha256 ||
        aggregate.runId !== record.id ||
        aggregate.workflow.id !== record.workflow ||
        aggregate.repository.revision !== record.repository.revision ||
        aggregate.technicalApproval !== evidence.technicalApproval ||
        aggregate.roleQualification !== evidence.roleQualification ||
        aggregate.releaseEligible !== evidence.releaseEligible))
  ) {
    throw new Error(
      "Composition run output rejected aggregate evidence that conflicts with its selection.",
    );
  }
  return Object.freeze({
    compositionId: evidence.compositionId,
    evidenceSha256: evidence.evidenceSha256,
    aggregateSha256: aggregate?.aggregateSha256 ?? null,
    technicalApproval: "not-established",
    roleQualification: "not-established",
    releaseEligible: false,
  });
}

function assertRunResultCompositionExecution(
  value: RunResultCompositionExecutionV1,
): asserts value is RunResultCompositionExecutionV1 {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join("\0") !==
      [
        "aggregateSha256",
        "compositionId",
        "evidenceSha256",
        "releaseEligible",
        "roleQualification",
        "technicalApproval",
      ]
        .sort()
        .join("\0") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.compositionId) ||
    !/^[a-f0-9]{64}$/u.test(value.evidenceSha256) ||
    (value.aggregateSha256 !== null && !/^[a-f0-9]{64}$/u.test(value.aggregateSha256)) ||
    value.technicalApproval !== "not-established" ||
    value.roleQualification !== "not-established" ||
    value.releaseEligible !== false
  ) {
    throw new Error("The docsfab run result envelope has invalid composition execution fields.");
  }
}

export type { WorkflowOutcomeExitPolicyV1 };
export type { DocChangeDeltaCliSurfaceV1 };
