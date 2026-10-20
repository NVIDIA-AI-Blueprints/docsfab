// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Flat, content-free run index rows projected from a saved run record, so
 * failures can be counted across runs without re-reading every record.
 *
 * - `run`: exactly one per record, even with `steps: []`.
 * - `attempt`: one per recorded inference attempt.
 * - `step`: one per started step with no attempts, and one per step whose
 *   failure belongs to the step rather than to any attempt: the quality
 *   validator refused its artifact, or it ended failed or waiting for input
 *   after its final attempt succeeded. `pending` steps get no row.
 *
 * `docsfab runs query` counts `attempt` rows unless the operator names other
 * kinds. The record stays the
 * source of truth; a row is bound to one snapshot by `recordSha256` and never
 * carries model prose, error messages, instructions, or credentials.
 *
 * Absence is `null`, never a guess. A present value the row refuses to copy
 * (over `runs.indexFieldMaxChars` or with control characters) is also `null`
 * and named in `omittedFields`, so nothing is silently clipped. Extending the
 * row adds nullable fields and bumps `RUN_INDEX_PROJECTION_REVISION`.
 */
import { createHash } from "node:crypto";

import { canonicalJson } from "../../content-ir/canonical.js";
import { limit } from "../../config/limits.js";

import {
  isRejectedReplyExcerptOf,
  type InferenceRejectedReplyExcerptV1,
} from "../../execution/rejected-reply-excerpt.js";
import type { JsonEvidenceErrorCode, JsonEvidenceSyntaxDetail } from "../../json-evidence.js";
import { normalizeModelFinishReason } from "../../model/attempt-telemetry.js";
import {
  attemptExecutionLimitStop,
  exhaustedAllowanceStop,
  STEP_EXECUTION_CEILING_CODES,
} from "../../config/execution-limit-stops.js";
import {
  isStepExecutionCeilingSource,
  stepExecutionCeilingSource,
  type StepExecutionCeilingSource,
} from "../../config/execution-ceiling-source.js";
import {
  isFailureClass,
  isFailureCode,
  isFailureLayer,
  readFailureClassification,
  type FailureClass,
  type FailureLayer,
} from "../../operator/failure-class.js";
import { classifyInferenceAttempt } from "../../operator/failure-classification.js";
import {
  INFERENCE_RETRY_DECISION_TOKENS,
  inferenceRetryDecisionToken,
  type InferenceRetryDecisionToken,
} from "../../operator/retry-disposition.js";
import {
  isLegacyHostPathDisclosure,
  LEGACY_HOST_PATH_MATCH_ROOTS,
  LEGACY_HOST_PATH_SOURCE_READINGS,
  type InferenceAnswerPath,
  type InferenceAnswerPathReason,
  type InferenceAnswerReportTurnState,
  type InferenceAnswerSubmissionState,
  type InferenceAttemptEvidence,
  type InferenceConcludeNowTrigger,
  type InferenceExecutionEvidence,
  type InferenceTurnEvidence,
  type LegacyHostPathMatchRoot,
  type LegacyHostPathSourceReading,
} from "../contracts.js";
import {
  answerMemberEncodingColumn,
  INFERENCE_ANSWER_MEMBER_ENCODINGS,
  INFERENCE_ANSWER_PATH_REASONS,
  INFERENCE_ANSWER_PATHS,
  type InferenceAnswerMemberEncodingColumn,
  INFERENCE_ANSWER_REPORT_TURN_STATES,
  INFERENCE_ANSWER_SUBMISSION_STATES,
  isAnswerRecordLedgerProgress,
  isInferenceAnswerSubmissionEvidence,
} from "../answer-submission-evidence.js";
import { SAFE_RECORD_ID } from "../file-store.js";
import {
  INFERENCE_CONCLUDE_NOW_TRIGGERS,
  isInferenceConcludeNowEvidence,
} from "../inference-retry-rule-vocabulary.js";
import { attemptClassifierSha256 } from "../run-index-classifier.js";
import { isVerifierDisagreement, verifierDisagreementCount } from "../verifier-disagreement.js";
import { admittedCreateConversion } from "../../workflow-contracts/create-conversion.js";
import { getWorkflow } from "../../workflow-registry/catalog.js";
import { validateAuthoringRunRecordV1 } from "../authoring-execution.js";
import type { RunRecord } from "../contracts.js";
import {
  validateSourceAuthorityProposalAdmissionV1,
  type SourceAuthorityProposalRefusalCodeV1,
} from "../../workflow-execution/source-obligation-authority.js";
import {
  REQUEST_INTENT_OPERATIONS,
  REQUEST_INTENT_TARGET_ORIGINS,
  type RequestIntentOperation,
  type RequestIntentTargetOrigin,
} from "../../request-intent/contract.js";
import {
  decodeRunRecordRequestIntent,
  REQUEST_INTENT_ADMISSION_OUTCOMES,
  type RequestIntentAdmissionOutcome,
} from "../../request-intent/interpret-record.js";
import { RequestIntentContractError } from "../../request-intent/kit.js";
import {
  isInferenceRejectionSubject,
  type RejectionSubjectWithheld,
} from "../../execution/rejection-subject.js";
import {
  isCreateConversionReason,
  type CreateConversionReason,
} from "../../workflow-execution/plan-binding.js";
import {
  SOURCE_OBLIGATION_STEP_ID,
  sealedLedgerSourceEvidence,
} from "../../workflow-execution/source-obligation.js";
import {
  isHttpStatus,
  isInferenceAttemptModelTelemetry,
  isModelFinishReason,
  isProviderErrorClass,
  type ModelFinishReason,
  type ProviderErrorClass,
} from "../model-telemetry.js";
import { RUN_RECORD_MAX_BYTES_LIMIT } from "../run-record-limit.js";

import {
  RUN_INDEX_MODEL_SEPARATOR,
  RUN_INDEX_READINESS_DISPOSITIONS,
  RUN_INDEX_READINESS_REASON_CODES,
  RUN_INDEX_REPLY_PARSED,
  RUN_INDEX_ROW_KIND,
  RUN_INDEX_ROW_SCHEMA_VERSION,
  RUN_INDEX_PROJECTION_REVISION,
  RUN_INDEX_SOURCE_EVIDENCE,
  TERMINAL_STEP_STATUSES,
  RUN_INDEX_INTENT_MODEL_UNAVAILABLE,
  REPLY_PARSE_ERROR_CODES,
  REPLY_PARSE_SYNTAX_DETAILS,
  isRunIndexTerminalStatus,
  type RunIndexRowV1,
  type RunIndexSourceEvidence,
  type RunIndexReadinessDisposition,
  type RunIndexReplyExcerptReading,
  type RunIndexRetryDecisionRule,
  type RunIndexIntentAdmission,
  type RunIndexIntentTargetSource,
  type RunIndexOrigin,
  type RunIndexRejectionSource,
  type RunIndexRowKind,
  type RunIndexSnapshotContext,
  type RunIndexProjection,
  type RunIndexRecordRefusal,
} from "./schema.js";

export function projectRunIndexRows(
  record: unknown,
  context: RunIndexSnapshotContext,
): RunIndexProjection {
  if (!isObject(record)) return { ok: false, reason: "not-a-run-record" };
  if (record.schemaVersion !== 2) return { ok: false, reason: "unsupported-schema" };
  if (typeof record.id !== "string" || !SAFE_RECORD_ID.test(record.id)) {
    return { ok: false, reason: "unsafe-run-id" };
  }
  if (!Array.isArray(record.steps)) return { ok: false, reason: "not-a-run-record" };
  const reader = new FieldReader(context.fieldMaxChars);
  const workflow = reader.required(record.workflow);
  const runStatus = reader.required(record.status);
  const runCreatedAt = reader.required(record.createdAt);
  if (workflow === null || runStatus === null || runCreatedAt === null) {
    return { ok: false, reason: "missing-run-identity" };
  }
  const repository = isObject(record.repository) ? record.repository : {};
  const qualityPack = isObject(record.qualityPack) ? record.qualityPack : {};
  const runFields = {
    schemaVersion: RUN_INDEX_ROW_SCHEMA_VERSION,
    kind: RUN_INDEX_ROW_KIND,
    projectionRevision: RUN_INDEX_PROJECTION_REVISION,
    snapshotId: context.snapshotId,
    indexedAt: context.indexedAt,
    origin: context.origin,
    runId: record.id,
    recordSha256: context.recordSha256,
    batchId: context.batchId ?? null,
    caseKey: context.caseKey ?? null,
    docsfabRevision: context.docsfabRevision ?? null,
    workflow,
    runStatus,
    runCreatedAt,
    sourceProposalOutcomes: null,
  } as const;
  const runOptional = {
    runStartedAt: reader.text("runStartedAt", record.startedAt),
    runCompletedAt: reader.text("runCompletedAt", record.completedAt),
    repositoryRevision: reader.text("repositoryRevision", repository.revision),
    qualityPackManifestSha256: reader.text("qualityPackManifestSha256", qualityPack.manifestSha256),
  };
  const runOmitted = reader.drain();
  const runFailure = recordedFailure(reader, record.failure);
  const recordedLimits = recordedProviderTurnLimits(record);
  const rows: Omit<RunIndexRowV1, "snapshotRows">[] = [
    {
      ...runFields,
      ...runOptional,
      rowKind: "run",
      stepIndex: null,
      stepId: null,
      stepKind: null,
      stepStatus: null,
      stepStartedAt: null,
      stepCompletedAt: null,
      skillId: null,
      skillSha256: null,
      attempt: null,
      finalAttempt: true,
      outcome: runStatus,
      ...runFailure,
      terminalStepId: terminalStepIdOf(reader, runStatus, record.steps),
      attemptClassifierSha256: null,
      rejectionSource: null,
      rejectionCode: null,
      rejectionLocation: null,
      rejectedReplyParseCode: null,
      rejectedReplyExcerpt: null,
      ...NO_REJECTION_SUBJECT,
      ...NO_HOST_PATH,
      conditionRetryability: null,
      retryDecision: null,
      retryDecisionRule: null,
      ...runModelFields(reader, record.models),
      ...NO_TELEMETRY,
      ...NO_ATTEMPT_OUTPUT,
      durationMs: reader.count("durationMs", record.durationMs),
      backoffMs: null,
      verifierDisagreementCount: recordedVerifierDisagreementCount(reader, record.steps),
      planConversion: admittedCreateConversion(record as never)?.reason ?? null,
      ...recordedSourceEvidence(reader, record.steps),
      sourceProposalOutcomes: recordedSourceProposalOutcomes(reader, record),
      ...recordedReadinessFields(reader, record),
      ...NO_READ_LOOP,
      executionCeilingSource: ceilingSourceOf(
        finalAttemptOf(terminalStepOf(runStatus, record.steps)),
        runFailure.failureCode,
        recordedLimits,
      ),
      ...NO_ANSWER_PATH,
      ...NO_ANSWER_RECORD_PROGRESS,
      ...recordedRequestIntent(record),
      omittedFields: [...runOmitted, ...reader.drain()],
    },
  ];
  record.steps.forEach((stepValue, stepIndex) => {
    const step = isObject(stepValue) ? stepValue : {};
    const inference = isObject(step.inference) ? step.inference : {};
    const attempts = Array.isArray(inference.attempts) ? inference.attempts : [];
    if (step.status === "pending" && attempts.length === 0) return;
    const stepId = reader.text("stepId", step.id);
    const stepStatus = reader.text("stepStatus", step.status);
    const skillEvidence = isObject(step.skillEvidence) ? step.skillEvidence : {};
    const stepFields = {
      stepIndex,
      stepId,
      stepKind: reader.text("stepKind", step.kind),
      stepStatus,
      stepStartedAt: reader.text("stepStartedAt", step.startedAt),
      stepCompletedAt: reader.text("stepCompletedAt", step.completedAt),
      skillId: reader.text("skillId", step.skill),
      skillSha256: reader.text("skillSha256", skillEvidence.contentSha256),
    };
    const stepOmitted = reader.drain();
    const quality = isObject(step.qualityValidationRejection)
      ? step.qualityValidationRejection
      : undefined;
    const pushStepRow = () => {
      const rejectionCode = quality ? reader.text("rejectionCode", quality.code) : null;
      const rejectionLocation = quality ? reader.text("rejectionLocation", quality.location) : null;
      const model = modelFields(reader, step.model);
      const stepFailure = recordedFailure(reader, step.failure);
      rows.push({
        ...runFields,
        ...runOptional,
        ...stepFields,
        rowKind: "step",
        attempt: null,
        finalAttempt: true,
        outcome: stepStatus ?? "unavailable",
        ...stepFailure,
        terminalStepId: null,
        attemptClassifierSha256: null,
        rejectionSource:
          rejectionCode !== null || rejectionLocation !== null ? "quality-validation" : null,
        rejectionCode,
        rejectionLocation,
        rejectedReplyParseCode: null,
        rejectedReplyExcerpt: null,
        ...NO_REJECTION_SUBJECT,
        ...NO_HOST_PATH,
        conditionRetryability: null,
        retryDecision: null,
        retryDecisionRule: null,
        ...model,
        ...NO_TELEMETRY,
        ...NO_ATTEMPT_OUTPUT,
        durationMs: reader.count("durationMs", step.durationMs),
        backoffMs: null,
        verifierDisagreementCount: null,
        planConversion: null,
        ...NO_SOURCE_EVIDENCE,
        ...NO_READINESS_FIELDS,
        ...NO_READ_LOOP,
        executionCeilingSource: ceilingSourceOf(
          attempts.at(-1),
          stepFailure.failureCode,
          recordedLimits,
        ),
        ...NO_ANSWER_PATH,
        ...NO_ANSWER_RECORD_PROGRESS,
        ...NO_REQUEST_INTENT,
        omittedFields: [...runOmitted, ...stepOmitted, ...reader.drain()],
      });
    };
    if (attempts.length === 0) {
      pushStepRow();
      return;
    }
    attempts.forEach((attemptValue, attemptIndex) => {
      const attempt = isObject(attemptValue) ? attemptValue : {};
      const outcome = reader.text("outcome", attempt.outcome) ?? "unavailable";
      const rejection = isObject(attempt.rejection) ? attempt.rejection : undefined;
      const rejectionCode = rejection ? reader.text("rejectionCode", rejection.code) : null;
      const rejectionLocation = rejection
        ? reader.text("rejectionLocation", rejection.location)
        : null;
      const model = modelFields(reader, attempt.model ?? step.model);
      const telemetry = telemetryFields(reader, attempt);
      const failure = attemptFailure(attempt);
      rows.push({
        ...runFields,
        ...runOptional,
        ...stepFields,
        rowKind: "attempt",
        attempt: reader.count("attempt", attempt.attempt),
        finalAttempt: attemptIndex === attempts.length - 1,
        outcome,
        ...failure,
        terminalStepId: null,
        attemptClassifierSha256: attemptClassifierSha256(),
        rejectionSource:
          rejectionCode !== null || rejectionLocation !== null ? "inference-attempt" : null,
        rejectionCode,
        rejectionLocation,
        rejectedReplyParseCode: replyParseCodeOf(reader, attempt.rejectedReplyShape),
        rejectedReplyExcerpt: replyExcerptReadingOf(reader, attempt),
        ...rejectionSubjectFields(reader, attempt.rejectionSubject),
        ...hostPathFields(reader, attempt.hostPathDisclosure),
        conditionRetryability: reader.text("conditionRetryability", attempt.conditionRetryability),
        retryDecision: reader.text("retryDecision", attempt.retryDecision),
        retryDecisionRule: retryDecisionRuleOf(attempt, inference),
        ...model,
        ...telemetry,
        ...attemptOutputFields(reader, attempt, telemetry.finishReason),
        durationMs: reader.count("durationMs", attempt.durationMs),
        backoffMs: reader.count("backoffMs", attempt.backoffMs),
        verifierDisagreementCount: null,
        planConversion: null,
        ...NO_SOURCE_EVIDENCE,
        ...NO_READINESS_FIELDS,
        ...readLoopFields(reader, attempt),
        executionCeilingSource: ceilingSourceOf(attempt, failure.failureCode, recordedLimits),
        ...answerPathFields(reader, attempt),
        ...answerRecordProgressFields(reader, step, attempt),
        ...NO_REQUEST_INTENT,
        omittedFields: [...runOmitted, ...stepOmitted, ...reader.drain()],
      });
    });
    // The validator refused the step's artifact, or the step ended for a
    // reason of its own, after its final attempt succeeded. One row either way.
    const finalAttempt = attempts.at(-1);
    const endedAfterSuccess =
      TERMINAL_STEP_STATUSES.includes(step.status) &&
      isObject(finalAttempt) &&
      finalAttempt.outcome === "succeeded";
    if (quality || endedAfterSuccess) pushStepRow();
  });
  return {
    ok: true,
    runId: record.id,
    rows: rows.map((row) => ({ ...row, snapshotRows: rows.length })),
  };
}

/**
 * #1439: the run's verifier disagreements, summed over every step that
 * retains a `verifierDisagreement`. The sum is known only when every present
 * field compared both passes, so it is null when no step carries the field,
 * when any present field is `unavailable` (that pair's count is unknown), and
 * when any present field is not well formed. A malformed field is also named
 * in `omittedFields`. A partial sum is never written: it would read as fewer
 * disagreements, or as agreement, than the run may hold.
 */
function recordedVerifierDisagreementCount(
  reader: FieldReader,
  steps: readonly unknown[],
): number | null {
  let total: number | null = null;
  let unknown = false;
  for (const step of steps) {
    if (!isObject(step) || step.verifierDisagreement === undefined) continue;
    if (!isVerifierDisagreement(step.verifierDisagreement)) {
      reader.refuse("verifierDisagreementCount");
      unknown = true;
      continue;
    }
    const count = verifierDisagreementCount(step.verifierDisagreement);
    if (count === null) unknown = true;
    else total = (total ?? 0) + count;
  }
  return unknown ? null : total;
}

type RequestIntentFields = Pick<
  RunIndexRowV1,
  "intentAdmission" | "intentOperation" | "intentTargetSource"
>;

const NO_REQUEST_INTENT: RequestIntentFields = Object.freeze({
  intentAdmission: null,
  intentOperation: null,
  intentTargetSource: null,
});

/**
 * The run's request interpretation, read only through the decoder that
 * verifies the sealed intent against the record's own instruction, as
 * `runs show` reads it. Consumers gate on the `admitted` outcome, never on a
 * present intent.
 */
function recordedRequestIntent(record: Record<string, unknown>): RequestIntentFields {
  if (record.requestIntent === undefined) return NO_REQUEST_INTENT;
  let decoded;
  try {
    decoded = decodeRunRecordRequestIntent(record.requestIntent, record.instruction);
  } catch (error) {
    // A field that does not decode or verify is unverified; any other error
    // is a defect, not a reading of the record.
    if (!(error instanceof RequestIntentContractError)) throw error;
    return { ...NO_REQUEST_INTENT, intentAdmission: "unverified" };
  }
  const { admission, intent } = decoded;
  const intentAdmission =
    admission.outcome === "unavailable" ? RUN_INDEX_INTENT_MODEL_UNAVAILABLE : admission.outcome;
  if (admission.outcome !== "admitted" || intent === null) {
    return { ...NO_REQUEST_INTENT, intentAdmission };
  }
  const origins = [
    ...new Set(
      intent.targets.filter((target) => target.role === "write").map((target) => target.chosenFrom),
    ),
  ];
  return {
    intentAdmission,
    intentOperation: intent.operation,
    intentTargetSource:
      origins.length === 0 ? "none" : origins.length === 1 ? origins[0]! : "mixed",
  };
}

/** `sourceEvidence` values, from fewest unverified dimensions to most. */
type SourceEvidenceFields = Pick<RunIndexRowV1, "sourceEvidence" | "unverifiedDimensions">;

const NO_SOURCE_EVIDENCE: SourceEvidenceFields = Object.freeze({
  sourceEvidence: null,
  unverifiedDimensions: null,
});

/**
 * The run's source evidence, from the last succeeded source-obligation step's
 * sealed ledger. A ledger the host cannot validate is unknown, not clean.
 */
function recordedSourceEvidence(
  reader: FieldReader,
  steps: readonly unknown[],
): SourceEvidenceFields {
  const step = [...steps]
    .reverse()
    .find(
      (candidate): candidate is Record<string, unknown> =>
        isObject(candidate) &&
        candidate.id === SOURCE_OBLIGATION_STEP_ID &&
        candidate.status === "succeeded",
    );
  if (!step) return NO_SOURCE_EVIDENCE;
  const tally = sealedLedgerSourceEvidence(step);
  if (!tally) {
    reader.refuse("sourceEvidence");
    return NO_SOURCE_EVIDENCE;
  }
  return {
    sourceEvidence:
      tally.unverified === 0 ? "cited" : tally.unverified < tally.dimensions ? "partial" : "none",
    unverifiedDimensions: tally.unverified,
  };
}

type ReadinessFields = Pick<RunIndexRowV1, "readinessDisposition" | "readinessReasonCodes">;
const NO_READINESS_FIELDS: ReadinessFields = Object.freeze({
  readinessDisposition: null,
  readinessReasonCodes: null,
});

/** Only closed, host-projected readiness outcomes enter the index. */
function recordedReadinessFields(
  reader: FieldReader,
  record: Record<string, unknown>,
): ReadinessFields {
  if (record.workflow !== "readiness" || !isObject(record.workflowOutcome)) {
    return NO_READINESS_FIELDS;
  }
  const disposition = record.workflowOutcome.disposition;
  if (!(RUN_INDEX_READINESS_DISPOSITIONS as readonly unknown[]).includes(disposition)) {
    reader.refuse("readinessDisposition");
    return NO_READINESS_FIELDS;
  }
  const reasons: { criterionId: string; code: string }[] = [];
  const findings = Array.isArray(record.workflowOutcome.findings)
    ? record.workflowOutcome.findings
    : [];
  for (const value of findings) {
    if (!isObject(value) || value.kind !== "evidence-limitation") continue;
    if (typeof value.code !== "string") continue;
    const match = /^readiness-(source-completeness|source-usability)-([a-z-]+)$/u.exec(value.code);
    if (!match) continue;
    const [, criterionId, code] = match;
    if (!(RUN_INDEX_READINESS_REASON_CODES as readonly string[]).includes(code!)) {
      reader.refuse("readinessReasonCodes");
      return {
        readinessDisposition: disposition as RunIndexReadinessDisposition,
        readinessReasonCodes: null,
      };
    }
    if (reasons.some((reason) => reason.criterionId === criterionId)) {
      reader.refuse("readinessReasonCodes");
      return {
        readinessDisposition: disposition as RunIndexReadinessDisposition,
        readinessReasonCodes: null,
      };
    }
    reasons.push({ criterionId: criterionId!, code: code! });
  }
  reasons.sort((left, right) => left.criterionId.localeCompare(right.criterionId));
  return {
    readinessDisposition: disposition as RunIndexReadinessDisposition,
    readinessReasonCodes: reader.text("readinessReasonCodes", JSON.stringify(reasons)),
  };
}

type ModelFields = Pick<RunIndexRowV1, "provider" | "model" | "apiFormat" | "modelProfileSha256">;

const NO_MODEL: ModelFields = Object.freeze({
  provider: null,
  model: null,
  apiFormat: null,
  modelProfileSha256: null,
});

/**
 * A column is known only when every recorded model carries it, so a run row
 * never names part of a mixed run's models. A refused value is also named in
 * `omittedFields`.
 */
function runModelFields(reader: FieldReader, value: unknown): ModelFields {
  if (value === undefined || value === null) return NO_MODEL;
  if (!Array.isArray(value) || !value.every(isObject)) {
    for (const field of Object.keys(NO_MODEL)) reader.refuse(field);
    return NO_MODEL;
  }
  if (value.length === 0) return NO_MODEL;
  const columns = value.map((entry) => modelFields(reader, entry));
  const run = (field: keyof ModelFields): string | null => {
    const values = columns.map((column) => column[field]);
    if (values.some((item) => item === null)) return null;
    const distinct = [...new Set(values as string[])].sort();
    return reader.text(field, distinct.join(RUN_INDEX_MODEL_SEPARATOR));
  };
  return {
    provider: run("provider"),
    model: run("model"),
    apiFormat: run("apiFormat"),
    modelProfileSha256: run("modelProfileSha256"),
  };
}

function modelFields(reader: FieldReader, value: unknown): ModelFields {
  const model = isObject(value) ? value : {};
  const profile = isObject(model.profile) ? model.profile : {};
  return {
    provider: reader.text("provider", model.provider),
    model: reader.text("model", model.model),
    apiFormat: reader.text("apiFormat", profile.apiFormat),
    modelProfileSha256: reader.text("modelProfileSha256", profile.sha256),
  };
}

/** A shape without a readable parse or with an unknown code is refused, not copied. */
function replyParseCodeOf(reader: FieldReader, shape: unknown): string | null {
  if (shape === undefined || shape === null) return null;
  const parse = isObject(shape) && isObject(shape.parse) ? shape.parse : undefined;
  if (parse?.status === "parsed") return RUN_INDEX_REPLY_PARSED;
  if (parse?.status === "failed") {
    const { code, detail } = parse;
    if (typeof detail === "string" && Object.hasOwn(REPLY_PARSE_SYNTAX_DETAILS, detail)) {
      return `json-${detail}`;
    }
    if (detail === undefined && typeof code === "string") {
      if (Object.hasOwn(REPLY_PARSE_ERROR_CODES, code)) return `json-${code}`;
    }
  }
  return reader.refuse("rejectedReplyParseCode");
}

/** An excerpt the shared validator refuses is not described, and is named in `omittedFields`. */
function replyExcerptReadingOf(
  reader: FieldReader,
  attempt: Record<string, unknown>,
): RunIndexReplyExcerptReading | null {
  const excerpt = attempt.rejectedReplyExcerpt;
  if (excerpt === undefined || excerpt === null) return null;
  if (!isRejectedReplyExcerptOf(excerpt, attempt.rejectedReplyShape)) {
    return reader.refuse("rejectedReplyExcerpt");
  }
  const { segments } = excerpt as InferenceRejectedReplyExcerptV1;
  if (segments.length === 0) return "empty";
  return segments.some((segment) => segment.withheld === undefined) ? "retained" : "withheld";
}

type FailureFields = Pick<RunIndexRowV1, "failureClass" | "failureLayer" | "failureCode">;
type TelemetryFields = Pick<
  RunIndexRowV1,
  | "finishReason"
  | "providerErrorClass"
  | "httpStatus"
  | "outputTokens"
  | "outputAllowance"
  | "providerLatencyMs"
>;

const NO_FAILURE: FailureFields = Object.freeze({
  failureClass: null,
  failureLayer: null,
  failureCode: null,
});
type HostPathFields = Pick<RunIndexRowV1, "hostPathRoot" | "hostPathInAdmittedSource">;

type RejectionSubjectFields = Pick<
  RunIndexRowV1,
  | "rejectedSourcePath"
  | "declaredChangedPaths"
  | "observedChangedPaths"
  | "rejectionSubjectWithheld"
>;

const NO_REJECTION_SUBJECT: RejectionSubjectFields = Object.freeze({
  rejectedSourcePath: null,
  declaredChangedPaths: null,
  observedChangedPaths: null,
  rejectionSubjectWithheld: null,
});

/** The attempt's rejection subject as index fields; a malformed subject is refused, not copied. */
function rejectionSubjectFields(reader: FieldReader, value: unknown): RejectionSubjectFields {
  if (value === undefined || value === null) return NO_REJECTION_SUBJECT;
  if (!isInferenceRejectionSubject(value)) {
    for (const field of Object.keys(NO_REJECTION_SUBJECT)) reader.refuse(field);
    return NO_REJECTION_SUBJECT;
  }
  if ("withheld" in value) {
    return { ...NO_REJECTION_SUBJECT, rejectionSubjectWithheld: value.withheld };
  }
  if (value.kind === "source-path") {
    return {
      ...NO_REJECTION_SUBJECT,
      rejectedSourcePath: reader.text("rejectedSourcePath", value.path),
    };
  }
  return {
    ...NO_REJECTION_SUBJECT,
    declaredChangedPaths: reader.text("declaredChangedPaths", JSON.stringify(value.declared)),
    observedChangedPaths: reader.text("observedChangedPaths", JSON.stringify(value.observed)),
  };
}

const NO_HOST_PATH: HostPathFields = Object.freeze({
  hostPathRoot: null,
  hostPathInAdmittedSource: null,
});

function hostPathFields(reader: FieldReader, value: unknown): HostPathFields {
  if (value === undefined || value === null) return NO_HOST_PATH;
  if (!isLegacyHostPathDisclosure(value)) {
    reader.refuse("hostPathRoot");
    reader.refuse("hostPathInAdmittedSource");
    return NO_HOST_PATH;
  }
  return { hostPathRoot: value.root, hostPathInAdmittedSource: value.inAdmittedSource };
}

type ReadLoopFields = Pick<
  RunIndexRowV1,
  | "unchangedReReads"
  | "readLoopWithheld"
  | "maxRepeatsOfOneResult"
  | "maxUnchangedReReadsAcrossResults"
  | "concludeNow"
>;

const NO_READ_LOOP: ReadLoopFields = Object.freeze({
  unchangedReReads: null,
  readLoopWithheld: null,
  maxRepeatsOfOneResult: null,
  maxUnchangedReReadsAcrossResults: null,
  concludeNow: null,
});

/** The attempt's read-loop counters, copied as recorded; an absent snapshot is all `null`. */
function readLoopFields(reader: FieldReader, attempt: Record<string, unknown>): ReadLoopFields {
  const asked = attempt.concludeNow;
  let concludeNow: InferenceConcludeNowTrigger | null = null;
  if (asked !== undefined && asked !== null) {
    if (isInferenceConcludeNowEvidence(asked)) concludeNow = asked.trigger;
    else reader.refuse("concludeNow");
  }
  const tools = isObject(attempt.tools) ? attempt.tools : undefined;
  const counters = tools?.readEvidence;
  if (counters === undefined || counters === null) return { ...NO_READ_LOOP, concludeNow };
  if (!isObject(counters)) {
    for (const field of Object.keys(NO_READ_LOOP)) {
      if (field !== "concludeNow") reader.refuse(field);
    }
    return { ...NO_READ_LOOP, concludeNow };
  }
  return {
    concludeNow,
    unchangedReReads: reader.count("unchangedReReads", counters.unchangedReReads),
    readLoopWithheld: reader.count("readLoopWithheld", counters.withheld),
    maxRepeatsOfOneResult: reader.count("maxRepeatsOfOneResult", counters.maxRepeatsOfOneResult),
    maxUnchangedReReadsAcrossResults: reader.count(
      "maxUnchangedReReadsAcrossResults",
      counters.maxUnchangedReReadsAcrossResults,
    ),
  };
}

type AnswerPathFields = Pick<
  RunIndexRowV1,
  | "answerPath"
  | "answerPathReason"
  | "answerSubmission"
  | "answerReportTurn"
  | "answerMemberEncoding"
>;

const NO_ANSWER_PATH: AnswerPathFields = Object.freeze({
  answerPath: null,
  answerPathReason: null,
  answerSubmission: null,
  answerReportTurn: null,
  answerMemberEncoding: null,
});

/**
 * The attempt's answer path and states, copied only when the record holds a
 * well-formed `answerSubmission`; a malformed one is refused, never read in
 * part. `in-flight` byte counts stay in the record (`docsfab runs show`).
 */
function answerPathFields(reader: FieldReader, attempt: Record<string, unknown>): AnswerPathFields {
  const value = attempt.answerSubmission;
  if (value === undefined || value === null) return NO_ANSWER_PATH;
  if (!isInferenceAnswerSubmissionEvidence(value)) {
    for (const field of Object.keys(NO_ANSWER_PATH)) reader.refuse(field);
    return NO_ANSWER_PATH;
  }
  return {
    answerPath: value.path,
    answerPathReason: value.reason,
    answerSubmission: value.submission,
    answerReportTurn: value.reportTurn,
    answerMemberEncoding: value.memberEncoding
      ? answerMemberEncodingColumn(value.memberEncoding)
      : null,
  };
}

type AnswerRecordProgressFields = Pick<
  RunIndexRowV1,
  | "answerRecordAdmittedRowCount"
  | "answerRecordReleasedRowCount"
  | "answerRecordRemainingKeyCount"
  | "answerRecordRefusalEventCount"
  | "answerRecordComplete"
  | "answerRecordCheckpointSequence"
  | "answerRecordLogicalRunId"
  | "answerRecordSourceRunId"
  | "answerRecordSourceAttemptHighWater"
>;

const NO_ANSWER_RECORD_PROGRESS: AnswerRecordProgressFields = Object.freeze({
  answerRecordAdmittedRowCount: null,
  answerRecordReleasedRowCount: null,
  answerRecordRemainingKeyCount: null,
  answerRecordRefusalEventCount: null,
  answerRecordComplete: null,
  answerRecordCheckpointSequence: null,
  answerRecordLogicalRunId: null,
  answerRecordSourceRunId: null,
  answerRecordSourceAttemptHighWater: null,
});

interface AnswerRecordCheckpointPointer {
  readonly sha256: string;
  readonly sequence: number;
  readonly attempt: number;
}

function isAnswerRecordCheckpointPointer(value: unknown): value is AnswerRecordCheckpointPointer {
  if (!isObject(value)) return false;
  return (
    Object.keys(value).length === 3 &&
    Object.hasOwn(value, "sha256") &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(value.sha256) &&
    Number.isSafeInteger(value.sequence) &&
    Number(value.sequence) > 0 &&
    Number.isSafeInteger(value.attempt) &&
    Number(value.attempt) > 0
  );
}

/**
 * The checkpoint-bound ledger summary belongs only to the physical attempt
 * that saved it. The checkpoint pointers and sequence must agree before any
 * count is copied; missing or inconsistent evidence never becomes zero.
 */
function answerRecordProgressFields(
  reader: FieldReader,
  step: Record<string, unknown>,
  attempt: Record<string, unknown>,
): AnswerRecordProgressFields {
  const ledger = isObject(step.answerRecordLedger) ? step.answerRecordLedger : undefined;
  const progress = ledger?.progress;
  if (
    progress === undefined &&
    step.answerRecordCheckpoint === undefined &&
    ledger?.checkpoint === undefined
  ) {
    return NO_ANSWER_RECORD_PROGRESS;
  }

  const refuseAll = (): AnswerRecordProgressFields => {
    for (const field of Object.keys(NO_ANSWER_RECORD_PROGRESS)) reader.refuse(field);
    return NO_ANSWER_RECORD_PROGRESS;
  };
  const stepPointer = step.answerRecordCheckpoint;
  const ledgerPointer = ledger?.checkpoint;
  if (
    !isAnswerRecordCheckpointPointer(stepPointer) ||
    !isAnswerRecordCheckpointPointer(ledgerPointer) ||
    stepPointer.sha256 !== ledgerPointer.sha256 ||
    stepPointer.sequence !== ledgerPointer.sequence ||
    stepPointer.attempt !== ledgerPointer.attempt
  ) {
    return refuseAll();
  }
  if (stepPointer.attempt !== attempt.attempt) return NO_ANSWER_RECORD_PROGRESS;
  if (
    !isAnswerRecordLedgerProgress(progress) ||
    progress.checkpointSequence !== stepPointer.sequence ||
    !Array.isArray(ledger?.rows)
  ) {
    return refuseAll();
  }

  let admittedRowCount = 0;
  let releasedRowCount = 0;
  for (const row of ledger.rows) {
    if (!isObject(row) || (row.state !== "admitted" && row.state !== "released")) {
      return refuseAll();
    }
    if (row.state === "admitted") admittedRowCount += 1;
    else releasedRowCount += 1;
  }
  if (
    admittedRowCount !== progress.admittedRowCount ||
    releasedRowCount !== progress.releasedRowCount
  ) {
    return refuseAll();
  }

  return {
    answerRecordAdmittedRowCount: reader.count(
      "answerRecordAdmittedRowCount",
      progress.admittedRowCount,
    ),
    answerRecordReleasedRowCount: reader.count(
      "answerRecordReleasedRowCount",
      progress.releasedRowCount,
    ),
    answerRecordRemainingKeyCount: reader.count(
      "answerRecordRemainingKeyCount",
      progress.remainingKeyCount,
    ),
    answerRecordRefusalEventCount: reader.count(
      "answerRecordRefusalEventCount",
      progress.refusalEventCount,
    ),
    answerRecordComplete: progress.complete,
    answerRecordCheckpointSequence: reader.count(
      "answerRecordCheckpointSequence",
      progress.checkpointSequence,
    ),
    answerRecordLogicalRunId: reader.text("answerRecordLogicalRunId", progress.logicalRunId),
    answerRecordSourceRunId: reader.text("answerRecordSourceRunId", progress.sourceRunId),
    answerRecordSourceAttemptHighWater: reader.count(
      "answerRecordSourceAttemptHighWater",
      progress.sourceAttemptHighWater,
    ),
  };
}

const NO_TELEMETRY: TelemetryFields = Object.freeze({
  finishReason: null,
  providerErrorClass: null,
  httpStatus: null,
  outputTokens: null,
  outputAllowance: null,
  providerLatencyMs: null,
});

/** A value outside the closed vocabulary is refused; no class is derived when absent. */
function recordedFailure(reader: FieldReader, value: unknown): FailureFields {
  if (value === undefined || value === null) return NO_FAILURE;
  const failure = readFailureClassification(value);
  if (failure) {
    return { failureClass: failure.class, failureLayer: failure.layer, failureCode: failure.code };
  }
  reader.refuse("failureClass");
  reader.refuse("failureLayer");
  reader.refuse("failureCode");
  return NO_FAILURE;
}

/** The step that ended a run that did not succeed, else `undefined`. */
function terminalStepOf(
  runStatus: string,
  steps: readonly unknown[],
): Record<string, unknown> | undefined {
  if (runStatus === "succeeded" || !isRunIndexTerminalStatus(runStatus)) return undefined;
  const terminal = steps.find(
    (step) => isObject(step) && TERMINAL_STEP_STATUSES.includes(step.status),
  );
  return isObject(terminal) ? terminal : undefined;
}

/** Null unless the run ended without succeeding and a step ended it. */
function terminalStepIdOf(
  reader: FieldReader,
  runStatus: string,
  steps: readonly unknown[],
): string | null {
  const terminal = terminalStepOf(runStatus, steps);
  return terminal ? reader.text("terminalStepId", terminal.id) : null;
}

function finalAttemptOf(step: Record<string, unknown> | undefined): unknown {
  const inference = isObject(step?.inference) ? step.inference : undefined;
  return Array.isArray(inference?.attempts) ? inference.attempts.at(-1) : undefined;
}

/**
 * The run host's configured provider-turn value and the smallest sealed
 * budget, as a composition run recorded them; `undefined` when the record
 * does not carry both.
 */
function recordedProviderTurnLimits(record: Record<string, unknown>) {
  const execution = isObject(record.compositionExecution) ? record.compositionExecution : {};
  const limits = isObject(execution.limits) ? execution.limits : {};
  const turnsOf = (key: string): number | undefined => {
    const vector = limits[key];
    const value = isObject(vector) ? vector.maxProviderTurns : undefined;
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? value
      : undefined;
  };
  const configured = turnsOf("configured");
  const sealed = ["candidate", "composition", "package"]
    .map(turnsOf)
    .filter((value): value is number => value !== undefined);
  return configured === undefined || sealed.length === 0
    ? undefined
    : { configured, sealed: Math.min(...sealed) };
}

/**
 * What set the execution ceiling `failureCode` names, read from the attempt's
 * last governed turn and lease the way the failure code was (a stop at the
 * ceiling, or a step that completed having used all of it) and from the
 * limits the run recorded, never from this process's own limits. `null` when
 * the code names no execution ceiling.
 */
function ceilingSourceOf(
  attempt: unknown,
  failureCode: string | null,
  recorded: ReturnType<typeof recordedProviderTurnLimits>,
): StepExecutionCeilingSource | null {
  const ceiling = failureCode === null ? undefined : STEP_EXECUTION_CEILING_CODES.get(failureCode);
  if (ceiling === undefined) return null;
  if (!isObject(attempt)) return "codes-mismatch";
  const last = Array.isArray(attempt.turns) ? attempt.turns.at(-1) : undefined;
  const turn = isObject(last) ? (last as Partial<InferenceTurnEvidence>) : undefined;
  const lease = isObject(attempt.executionLease) ? attempt.executionLease : undefined;
  const toolCalls = isObject(lease?.toolCalls) ? lease.toolCalls : undefined;
  const count = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const executed = count(toolCalls?.executed);
  const scopedCalls = isObject(lease?.toolCallsByScope) ? lease.toolCallsByScope : undefined;
  const callCeilings = isObject(lease?.toolCallCeilings) ? lease.toolCallCeilings : undefined;
  const readingCalls = count(scopedCalls?.reading) ?? executed;
  const readingCeiling = count(callCeilings?.reading) ?? count(turn?.maxToolCalls);
  const recordCalls = count(lease?.answerRecordCallsAdmitted);
  const recordCeiling = count(callCeilings?.answerRecord);
  const chargeableAttempts =
    executed === undefined ? undefined : executed + (count(toolCalls?.denied) ?? 0);
  const chargeableAttemptCeiling = count(lease?.chargeableAttemptCeiling);
  const bothScopesExhausted =
    scopedCalls === undefined ||
    callCeilings === undefined ||
    (readingCalls !== undefined &&
      readingCeiling !== undefined &&
      recordCalls !== undefined &&
      recordCeiling !== undefined &&
      readingCalls >= readingCeiling &&
      recordCalls >= recordCeiling) ||
    (chargeableAttempts !== undefined &&
      chargeableAttemptCeiling !== undefined &&
      chargeableAttempts >= chargeableAttemptCeiling);
  const providerTurns = count(lease?.providerTurns);
  const maxToolCalls = count(turn?.maxToolCalls);
  const maxProviderTurns = count(turn?.maxProviderTurns);
  const chargeableAttemptStop =
    lease?.terminalReason === "hard-tool-call-ceiling" &&
    chargeableAttempts !== undefined &&
    chargeableAttemptCeiling !== undefined &&
    chargeableAttempts >= chargeableAttemptCeiling &&
    readingCalls !== undefined &&
    readingCeiling !== undefined &&
    readingCalls < readingCeiling;
  const projectedCalls = chargeableAttemptStop ? chargeableAttempts : readingCalls;
  const projectedCeiling = chargeableAttemptStop ? chargeableAttemptCeiling : readingCeiling;
  const projectedTurn =
    turn && scopedCalls && callCeilings
      ? {
          ...turn,
          toolCalls: projectedCalls,
          maxToolCalls: projectedCeiling,
        }
      : turn;
  const candidateStop = attemptExecutionLimitStop({
    ...(projectedTurn ? { turns: [projectedTurn] } : {}),
    ...(lease
      ? {
          executionLease: {
            ...(typeof lease.terminalReason === "string"
              ? { terminalReason: lease.terminalReason }
              : {}),
            ...(providerTurns === undefined ? {} : { providerTurns }),
            ...(projectedCalls === undefined ? {} : { toolCalls: { executed: projectedCalls } }),
          },
        }
      : {}),
  });
  const leaseReadCeilingStop =
    lease?.terminalReason === "hard-tool-call-ceiling" &&
    readingCalls !== undefined &&
    readingCeiling !== undefined &&
    readingCalls >= readingCeiling;
  const stop =
    candidateStop?.ceiling === "tool-calls" &&
    scopedCalls &&
    !leaseReadCeilingStop &&
    !bothScopesExhausted
      ? undefined
      : (candidateStop ??
        exhaustedAllowanceStop({
          ...(bothScopesExhausted &&
          chargeableAttempts !== undefined &&
          chargeableAttemptCeiling !== undefined
            ? { executedToolCalls: chargeableAttempts }
            : scopedCalls === undefined && executed !== undefined
              ? { executedToolCalls: executed }
              : {}),
          ...(bothScopesExhausted && chargeableAttemptCeiling !== undefined
            ? { maxToolCalls: chargeableAttemptCeiling }
            : bothScopesExhausted && readingCeiling !== undefined
              ? { maxToolCalls: readingCeiling }
              : scopedCalls === undefined && maxToolCalls !== undefined
                ? { maxToolCalls }
                : {}),
          ...(providerTurns === undefined ? {} : { providerTurns }),
          ...(maxProviderTurns === undefined ? {} : { maxProviderTurns }),
        }));
  // Compared by ceiling, not code: which provider-turn code a stop gets depends
  // on the host limits of the process that classifies it.
  return stop?.ceiling === ceiling ? stepExecutionCeilingSource(stop, recorded) : "codes-mismatch";
}

/**
 * The same reading `docsfab runs show` prints for the attempt, so the index
 * and the saved-run view cannot name a decision two ways.
 */
function retryDecisionRuleOf(
  attempt: Record<string, unknown>,
  inference: Record<string, unknown>,
): RunIndexRetryDecisionRule | null {
  const token = inferenceRetryDecisionToken(
    attempt as unknown as InferenceAttemptEvidence,
    inference as unknown as InferenceExecutionEvidence,
  );
  return token === "unavailable" ? null : token;
}

type AttemptOutputFields = Pick<
  RunIndexRowV1,
  "attemptOutputTokens" | "continuations" | "firstFinishReason" | "answerOutputTokens"
>;

const NO_ATTEMPT_OUTPUT: AttemptOutputFields = Object.freeze({
  attemptOutputTokens: null,
  continuations: null,
  firstFinishReason: null,
  answerOutputTokens: null,
});

/**
 * Whole-attempt output facts from `usage` and the turn ledger.
 *
 * A turn cut at the output limit is followed by another turn in two cases: the
 * host continues a cut answer, or Pi re-issues a cut tool call. The ledger's
 * `toolCalls` counts the tool calls in Pi's full transcript, which compaction
 * does not shrink, so it rises after a turn that issued one, even an
 * unexecuted one, and stays level after a continuation. A level count across a
 * compaction reads as unknown: the next turn was sent a rewritten context.
 * Turns the governor stopped before sending (`decision: "stop"`) are skipped.
 */
function attemptOutputFields(
  reader: FieldReader,
  attempt: Record<string, unknown>,
  finishReason: ModelFinishReason | null,
): AttemptOutputFields {
  const usage = isObject(attempt.usage) ? attempt.usage : {};
  const attemptOutputTokens = reader.count("attemptOutputTokens", usage.output);
  const ledger = attempt.turns;
  if (ledger === undefined || ledger === null) {
    return { ...NO_ATTEMPT_OUTPUT, attemptOutputTokens };
  }
  if (!Array.isArray(ledger) || !ledger.every(isObject)) {
    reader.refuse("continuations");
    reader.refuse("firstFinishReason");
    reader.refuse("answerOutputTokens");
    return { ...NO_ATTEMPT_OUTPUT, attemptOutputTokens };
  }
  const turns = ledger.filter((turn) => turn.decision !== "stop");
  const last = turns.length - 1;
  // `true` / `false`, or `undefined` when the ledger cannot tell.
  const continued = (index: number): boolean | undefined => {
    const turn = turns[index]!;
    const next = turns[index + 1]!;
    if (typeof turn.rawStopReason !== "string") return undefined;
    if (normalizeModelFinishReason(undefined, turn.rawStopReason) !== "length") return false;
    if (!sameCount(turn.toolCalls, next.toolCalls)) {
      return isCount(turn.toolCalls) && isCount(next.toolCalls) ? false : undefined;
    }
    return sameCount(turn.compactions, next.compactions) ? true : undefined;
  };
  let continuations = 0;
  for (let index = 0; index < last; index += 1) {
    const reading = continued(index);
    if (reading === undefined) return { ...NO_ATTEMPT_OUTPUT, attemptOutputTokens };
    if (reading) continuations += 1;
  }
  if (last < 0) return { ...NO_ATTEMPT_OUTPUT, attemptOutputTokens, continuations };
  let first = last;
  while (first > 0 && continued(first - 1) === true) first -= 1;
  const answer = turns.slice(first);
  // The turn before the answer delimits it; every one must name its stop, so a
  // ledger that recorded grants rather than production is never summed.
  const delimited =
    [...answer, ...(first > 0 ? [turns[first - 1]!] : [])].every(
      (turn) => typeof turn.rawStopReason === "string",
    ) && answer.every((turn) => isCount(turn.outputTokens));
  return {
    attemptOutputTokens,
    continuations,
    firstFinishReason: first < last ? "length" : finishReason,
    answerOutputTokens: delimited
      ? answer.reduce((total, turn) => total + (turn.outputTokens as number), 0)
      : null,
  };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sameCount(left: unknown, right: unknown): boolean {
  return isCount(left) && isCount(right) && left === right;
}

/**
 * Attempts store no class, so this is the shared attempt classifier's reading,
 * the same one `docsfab runs show` and `RunResultV1.failures` report.
 */
function attemptFailure(attempt: Record<string, unknown>): FailureFields {
  const failure = classifyInferenceAttempt(attempt as unknown as InferenceAttemptEvidence);
  return failure
    ? { failureClass: failure.class, failureLayer: failure.layer, failureCode: failure.code }
    : NO_FAILURE;
}

/** Telemetry that fails the shared shape validator is refused as a whole. */
function telemetryFields(reader: FieldReader, attempt: Record<string, unknown>): TelemetryFields {
  const telemetry = attempt.modelTelemetry;
  if (telemetry === undefined || telemetry === null) return NO_TELEMETRY;
  if (
    !isInferenceAttemptModelTelemetry(
      telemetry,
      attempt.outcome as InferenceAttemptEvidence["outcome"],
    )
  ) {
    for (const field of Object.keys(NO_TELEMETRY)) reader.refuse(field);
    return NO_TELEMETRY;
  }
  return {
    finishReason: telemetry.finishReason ?? null,
    providerErrorClass: telemetry.providerError?.class ?? null,
    httpStatus: telemetry.providerError?.httpStatus ?? null,
    outputTokens: telemetry.outputTokens ?? null,
    outputAllowance: telemetry.outputAllowance ?? null,
    providerLatencyMs: telemetry.providerLatencyMs,
  };
}

/** Copies identifier-like values under the field ceiling and records refusals. */
class FieldReader {
  private omitted: string[] = [];

  public constructor(private readonly maxChars: number) {}

  public required(value: unknown): string | null {
    return typeof value === "string" && this.admissible(value) ? value : null;
  }

  public text(field: string, value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value === "string" && this.admissible(value)) return value;
    this.omit(field);
    return null;
  }

  public count(field: string, value: unknown): number | null {
    if (value === undefined || value === null) return null;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
    this.omit(field);
    return null;
  }

  public refuse(field: string): null {
    this.omit(field);
    return null;
  }

  public drain(): string[] {
    const drained = this.omitted;
    this.omitted = [];
    return drained;
  }

  private omit(field: string): void {
    if (!this.omitted.includes(field)) this.omitted.push(field);
  }

  private admissible(value: string): boolean {
    return (
      value.length > 0 && value.length <= this.maxChars && !/[\u0000-\u001f\u007f]/u.test(value)
    );
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Decode one stored index line; anything that is not a row reads as
 * `undefined` so it counts as unreadable. Fields added since the row's
 * projection read as `null`. An `attempt` row from another classifier reads
 * `failureClass` and `failureLayer` as `null`, so one cause is never split
 * across two classes.
 */

function recordedSourceProposalOutcomes(
  reader: FieldReader,
  record: Record<string, unknown>,
): string | null {
  const steps = record.steps;
  if (!Array.isArray(steps)) return null;
  const outcomes: {
    attempt: number;
    path: string;
    status: "admitted" | "refused";
    refusalCode?: SourceAuthorityProposalRefusalCodeV1;
  }[] = [];
  let malformed = false;
  const carriesReceipts = steps.some(
    (step) => isObject(step) && step.sourceProposalAdmissions !== undefined,
  );
  if (carriesReceipts) {
    if (
      record.workflow !== "create-documentation" ||
      steps.some(
        (step) =>
          isObject(step) &&
          step.sourceProposalAdmissions !== undefined &&
          step.id !== "derive-source-obligations",
      )
    ) {
      return reader.refuse("sourceProposalOutcomes");
    }
    try {
      validateAuthoringRunRecordV1(
        record as unknown as RunRecord,
        getWorkflow("create-documentation"),
      );
    } catch {
      malformed = true;
    }
  }
  for (const step of steps) {
    if (!isObject(step)) continue;
    if (step.sourceProposalAdmissions === undefined) continue;
    if (!Array.isArray(step.sourceProposalAdmissions)) {
      malformed = true;
      continue;
    }
    for (const receipt of step.sourceProposalAdmissions) {
      try {
        const validated = validateSourceAuthorityProposalAdmissionV1(receipt);
        outcomes.push({
          attempt: validated.attempt,
          path: validated.path,
          status: validated.status,
          ...(validated.status === "refused" ? { refusalCode: validated.refusalCode } : {}),
        });
      } catch {
        malformed = true;
      }
    }
  }
  if (malformed) return reader.refuse("sourceProposalOutcomes");
  if (outcomes.length === 0) return null;
  return reader.text("sourceProposalOutcomes", canonicalJson(outcomes));
}
