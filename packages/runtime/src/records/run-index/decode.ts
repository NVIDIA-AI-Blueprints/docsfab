// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalJson } from "../../content-ir/canonical.js";
import { limit } from "../../config/limits.js";
import { isStepExecutionCeilingSource } from "../../config/execution-ceiling-source.js";
import { isFailureClass, isFailureCode, isFailureLayer } from "../../operator/failure-class.js";
import {
  LEGACY_HOST_PATH_MATCH_ROOTS,
  LEGACY_HOST_PATH_SOURCE_READINGS,
  type InferenceAnswerPath,
  type InferenceAnswerPathReason,
  type InferenceAnswerReportTurnState,
  type InferenceAnswerSubmissionState,
  type InferenceConcludeNowTrigger,
  type LegacyHostPathMatchRoot,
  type LegacyHostPathSourceReading,
} from "../contracts.js";
import {
  INFERENCE_ANSWER_MEMBER_ENCODINGS,
  INFERENCE_ANSWER_PATHS,
  INFERENCE_ANSWER_PATH_REASONS,
  INFERENCE_ANSWER_REPORT_TURN_STATES,
  INFERENCE_ANSWER_SUBMISSION_STATES,
  type InferenceAnswerMemberEncodingColumn,
} from "../answer-submission-evidence.js";
import { INFERENCE_CONCLUDE_NOW_TRIGGERS } from "../inference-retry-rule-vocabulary.js";
import { attemptClassifierSha256 } from "../run-index-classifier.js";
import {
  REQUEST_INTENT_OPERATIONS,
  REQUEST_INTENT_TARGET_ORIGINS,
  type RequestIntentOperation,
  type RequestIntentTargetOrigin,
} from "../../request-intent/contract.js";
import { isCreateConversionReason } from "../../workflow-execution/plan-binding.js";
import { isHttpStatus, isModelFinishReason, isProviderErrorClass } from "../model-telemetry.js";
import {
  RUN_INDEX_PROJECTION_REVISION,
  RUN_INDEX_READINESS_CRITERIA,
  RUN_INDEX_READINESS_DISPOSITIONS,
  RUN_INDEX_READINESS_REASON_CODES,
  RUN_INDEX_REPLY_EXCERPT_READINGS,
  RUN_INDEX_RETRY_DECISION_RULES,
  RUN_INDEX_ROW_KINDS,
  RUN_INDEX_ROW_KIND,
  RUN_INDEX_ROW_SCHEMA_VERSION,
  RUN_INDEX_SOURCE_EVIDENCE,
  RUN_INDEX_INTENT_ADMISSIONS,
  RUN_INDEX_INTENT_TARGET_SOURCES,
  CLOSED_VOCABULARY_REVISION,
  type RunIndexRowV1,
  type RunIndexReplyExcerptReading,
  type RunIndexRetryDecisionRule,
  type RunIndexSourceEvidence,
  type RunIndexReadinessDisposition,
  type RunIndexIntentAdmission,
  type RunIndexIntentTargetSource,
} from "./schema.js";
import { validateSourceAuthorityProposalAdmissionV1 } from "../../workflow-execution/source-obligation-authority.js";
import type { RejectionSubjectWithheld } from "../../execution/rejection-subject.js";

type ReadinessFields = Pick<RunIndexRowV1, "readinessDisposition" | "readinessReasonCodes">;
type RequestIntentFields = Pick<
  RunIndexRowV1,
  "intentAdmission" | "intentOperation" | "intentTargetSource"
>;
type AnswerPathFields = Pick<
  RunIndexRowV1,
  | "answerPath"
  | "answerPathReason"
  | "answerSubmission"
  | "answerReportTurn"
  | "answerMemberEncoding"
>;
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
const NO_REQUEST_INTENT: RequestIntentFields = Object.freeze({
  intentAdmission: null,
  intentOperation: null,
  intentTargetSource: null,
});
const NO_SOURCE_EVIDENCE = Object.freeze({ sourceEvidence: null, unverifiedDimensions: null });
const NO_READINESS_FIELDS = Object.freeze({
  readinessDisposition: null,
  readinessReasonCodes: null,
});
const NO_ANSWER_PATH = Object.freeze({
  answerPath: null,
  answerPathReason: null,
  answerSubmission: null,
  answerReportTurn: null,
  answerMemberEncoding: null,
});
const NO_ANSWER_RECORD_PROGRESS = Object.freeze({
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decode one stored index line; anything that is not a row reads as
 * `undefined` so it counts as unreadable. Fields added since the row's
 * projection read as `null`. An `attempt` row from another classifier reads
 * `failureClass` and `failureLayer` as `null`, so one cause is never split
 * across two classes.
 */
export function decodeRunIndexRow(value: unknown): RunIndexRowV1 | undefined {
  if (!isObject(value)) return undefined;
  if (value.schemaVersion !== RUN_INDEX_ROW_SCHEMA_VERSION || value.kind !== RUN_INDEX_ROW_KIND) {
    return undefined;
  }
  if (
    typeof value.snapshotId !== "string" ||
    typeof value.snapshotRows !== "number" ||
    !(RUN_INDEX_ROW_KINDS as readonly unknown[]).includes(value.rowKind) ||
    typeof value.runId !== "string" ||
    typeof value.runCreatedAt !== "string" ||
    !Array.isArray(value.omittedFields)
  ) {
    return undefined;
  }
  const projectionRevision = Number.isSafeInteger(value.projectionRevision)
    ? (value.projectionRevision as number)
    : 1;
  const closed = projectionRevision >= CLOSED_VOCABULARY_REVISION;
  const classifier =
    typeof value.attemptClassifierSha256 === "string" ? value.attemptClassifierSha256 : null;
  const classCurrent =
    closed && (value.rowKind !== "attempt" || classifier === attemptClassifierSha256());
  return {
    ...(value as unknown as RunIndexRowV1),
    projectionRevision,
    attemptClassifierSha256: classifier,
    rejectedReplyParseCode:
      typeof value.rejectedReplyParseCode === "string" ? value.rejectedReplyParseCode : null,
    rejectedReplyExcerpt: (RUN_INDEX_REPLY_EXCERPT_READINGS as readonly unknown[]).includes(
      value.rejectedReplyExcerpt,
    )
      ? (value.rejectedReplyExcerpt as RunIndexReplyExcerptReading)
      : null,
    rejectedSourcePath: storedAttemptText(value, "rejectedSourcePath"),
    declaredChangedPaths: storedAttemptText(value, "declaredChangedPaths"),
    observedChangedPaths: storedAttemptText(value, "observedChangedPaths"),
    rejectionSubjectWithheld:
      value.rowKind === "attempt" &&
      (REJECTION_SUBJECT_WITHHELD as readonly unknown[]).includes(value.rejectionSubjectWithheld)
        ? (value.rejectionSubjectWithheld as RejectionSubjectWithheld)
        : null,
    hostPathRoot: (LEGACY_HOST_PATH_MATCH_ROOTS as readonly unknown[]).includes(value.hostPathRoot)
      ? (value.hostPathRoot as LegacyHostPathMatchRoot)
      : null,
    hostPathInAdmittedSource: (LEGACY_HOST_PATH_SOURCE_READINGS as readonly unknown[]).includes(
      value.hostPathInAdmittedSource,
    )
      ? (value.hostPathInAdmittedSource as LegacyHostPathSourceReading)
      : null,
    failureClass: classCurrent && isFailureClass(value.failureClass) ? value.failureClass : null,
    failureLayer: classCurrent && isFailureLayer(value.failureLayer) ? value.failureLayer : null,
    failureCode: classCurrent && isFailureCode(value.failureCode) ? value.failureCode : null,
    terminalStepId:
      value.rowKind === "run" && typeof value.terminalStepId === "string"
        ? value.terminalStepId
        : null,
    retryDecisionRule:
      classCurrent &&
      (RUN_INDEX_RETRY_DECISION_RULES as readonly unknown[]).includes(value.retryDecisionRule)
        ? (value.retryDecisionRule as RunIndexRetryDecisionRule)
        : null,
    finishReason: closed && isModelFinishReason(value.finishReason) ? value.finishReason : null,
    providerErrorClass: isProviderErrorClass(value.providerErrorClass)
      ? value.providerErrorClass
      : null,
    httpStatus: isHttpStatus(value.httpStatus) ? value.httpStatus : null,
    outputTokens: storedCount(value.outputTokens),
    outputAllowance: storedCount(value.outputAllowance),
    providerLatencyMs: storedCount(value.providerLatencyMs),
    attemptOutputTokens: storedCount(value.attemptOutputTokens),
    continuations: storedCount(value.continuations),
    firstFinishReason: isModelFinishReason(value.firstFinishReason)
      ? value.firstFinishReason
      : null,
    answerOutputTokens: storedCount(value.answerOutputTokens),
    verifierDisagreementCount: storedCount(value.verifierDisagreementCount),
    planConversion:
      value.rowKind === "run" && isCreateConversionReason(value.planConversion)
        ? value.planConversion
        : null,
    ...(value.rowKind === "run" &&
    (RUN_INDEX_SOURCE_EVIDENCE as readonly unknown[]).includes(value.sourceEvidence) &&
    storedCount(value.unverifiedDimensions) !== null
      ? {
          sourceEvidence: value.sourceEvidence as RunIndexSourceEvidence,
          unverifiedDimensions: storedCount(value.unverifiedDimensions),
        }
      : NO_SOURCE_EVIDENCE),
    unchangedReReads: storedCount(value.unchangedReReads),
    readLoopWithheld: storedCount(value.readLoopWithheld),
    maxRepeatsOfOneResult: storedCount(value.maxRepeatsOfOneResult),
    maxUnchangedReReadsAcrossResults: storedCount(value.maxUnchangedReReadsAcrossResults),
    concludeNow:
      value.rowKind === "attempt" &&
      (INFERENCE_CONCLUDE_NOW_TRIGGERS as readonly unknown[]).includes(value.concludeNow)
        ? (value.concludeNow as InferenceConcludeNowTrigger)
        : null,
    executionCeilingSource: isStepExecutionCeilingSource(value.executionCeilingSource)
      ? value.executionCeilingSource
      : null,
    ...storedAnswerPath(value),
    ...storedAnswerRecordProgress(value),
    ...storedRequestIntent(value),
    ...storedReadinessFields(value),
    sourceProposalOutcomes: storedSourceProposalOutcomes(value),
    omittedFields: storedSourceProposalOmission(value),
  };
}

function storedSourceProposalOmission(value: Record<string, unknown>): readonly string[] {
  const omitted = value.omittedFields as string[];
  if (
    value.rowKind === "run" &&
    typeof value.projectionRevision === "number" &&
    value.projectionRevision >= RUN_INDEX_PROJECTION_REVISION &&
    !omitted.includes("sourceProposalOutcomes") &&
    (value.sourceProposalOutcomes === undefined ||
      (value.sourceProposalOutcomes !== null && storedSourceProposalOutcomes(value) === null))
  ) {
    return [...omitted, "sourceProposalOutcomes"];
  }
  return omitted;
}

function storedSourceProposalOutcomes(value: Record<string, unknown>): string | null {
  if (value.rowKind !== "run" || typeof value.sourceProposalOutcomes !== "string") return null;
  try {
    const decoded: unknown = JSON.parse(value.sourceProposalOutcomes);
    if (!Array.isArray(decoded) || decoded.length === 0) return null;
    const reason = "x".repeat(limit("factInventory.minDimensionReasonChars").value);
    const outcomes = decoded.map((entry) => {
      if (!isObject(entry)) {
        throw new TypeError("Stored source proposal outcome must be a validated object.");
      }
      const baseKeys = ["attempt", "path", "status"];
      const keys = entry.status === "refused" ? [...baseKeys, "refusalCode"] : baseKeys;
      if (Object.keys(entry).length !== keys.length || keys.some((key) => !(key in entry))) {
        throw new TypeError("Stored source proposal outcome has an invalid key set.");
      }
      const receipt = validateSourceAuthorityProposalAdmissionV1({
        schemaVersion: 1,
        kind: "docsfab-source-proposal-admission",
        attempt: entry.attempt,
        path: entry.path,
        reason,
        status: entry.status,
        ...(entry.status === "refused" ? { refusalCode: entry.refusalCode } : {}),
      });
      return {
        attempt: receipt.attempt,
        path: receipt.path,
        status: receipt.status,
        ...(receipt.status === "refused" ? { refusalCode: receipt.refusalCode } : {}),
      };
    });
    return canonicalJson(outcomes) === value.sourceProposalOutcomes
      ? value.sourceProposalOutcomes
      : null;
  } catch {
    return null;
  }
}

function storedReadinessFields(value: Record<string, unknown>): ReadinessFields {
  if (
    value.rowKind !== "run" ||
    value.workflow !== "readiness" ||
    typeof value.projectionRevision !== "number" ||
    value.projectionRevision < 17
  ) {
    return NO_READINESS_FIELDS;
  }
  const disposition = (RUN_INDEX_READINESS_DISPOSITIONS as readonly unknown[]).includes(
    value.readinessDisposition,
  )
    ? (value.readinessDisposition as RunIndexReadinessDisposition)
    : null;
  let readinessReasonCodes: string | null = null;
  if (typeof value.readinessReasonCodes === "string") {
    try {
      const reasons: unknown = JSON.parse(value.readinessReasonCodes);
      if (
        Array.isArray(reasons) &&
        reasons.every(
          (reason) =>
            isObject(reason) &&
            Object.keys(reason).length === 2 &&
            typeof reason.criterionId === "string" &&
            (RUN_INDEX_READINESS_CRITERIA as readonly string[]).includes(reason.criterionId) &&
            typeof reason.code === "string" &&
            (RUN_INDEX_READINESS_REASON_CODES as readonly string[]).includes(reason.code),
        ) &&
        new Set(reasons.map((reason) => (reason as Record<string, string>).criterionId)).size ===
          reasons.length &&
        JSON.stringify(reasons) === value.readinessReasonCodes
      ) {
        readinessReasonCodes = value.readinessReasonCodes;
      }
    } catch {
      // A malformed stored field reads as unavailable, never as a reason.
    }
  }
  return { readinessDisposition: disposition, readinessReasonCodes };
}

/** The stored request-interpretation fields of a run row when closed, else `null`. */
function storedRequestIntent(value: Record<string, unknown>): RequestIntentFields {
  if (value.rowKind !== "run") return NO_REQUEST_INTENT;
  const closed = <T extends string>(values: readonly T[], field: unknown): T | null =>
    (values as readonly unknown[]).includes(field) ? (field as T) : null;
  return {
    intentAdmission: closed(RUN_INDEX_INTENT_ADMISSIONS, value.intentAdmission),
    intentOperation: closed(REQUEST_INTENT_OPERATIONS, value.intentOperation),
    intentTargetSource: closed(RUN_INDEX_INTENT_TARGET_SOURCES, value.intentTargetSource),
  };
}

/** Each answer-path field as stored when it is a closed value, else `null`. */
function storedAnswerPath(value: Record<string, unknown>): AnswerPathFields {
  const closed = <T extends string>(values: readonly T[], field: unknown): T | null =>
    (values as readonly unknown[]).includes(field) ? (field as T) : null;
  return value.rowKind !== "attempt"
    ? NO_ANSWER_PATH
    : {
        answerPath: closed(INFERENCE_ANSWER_PATHS, value.answerPath),
        answerPathReason: closed(INFERENCE_ANSWER_PATH_REASONS, value.answerPathReason),
        answerSubmission: closed(INFERENCE_ANSWER_SUBMISSION_STATES, value.answerSubmission),
        answerReportTurn: closed(INFERENCE_ANSWER_REPORT_TURN_STATES, value.answerReportTurn),
        answerMemberEncoding: closed(INFERENCE_ANSWER_MEMBER_ENCODINGS, value.answerMemberEncoding),
      };
}

function storedAnswerRecordProgress(value: Record<string, unknown>): AnswerRecordProgressFields {
  if (
    value.rowKind !== "attempt" ||
    typeof value.projectionRevision !== "number" ||
    !Number.isSafeInteger(value.projectionRevision) ||
    value.projectionRevision < 18
  ) {
    return NO_ANSWER_RECORD_PROGRESS;
  }
  const counts = [
    value.answerRecordAdmittedRowCount,
    value.answerRecordReleasedRowCount,
    value.answerRecordRemainingKeyCount,
    value.answerRecordRefusalEventCount,
    value.answerRecordCheckpointSequence,
    value.answerRecordSourceAttemptHighWater,
  ];
  if (
    !counts.every(
      (count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0,
    ) ||
    (value.answerRecordCheckpointSequence as number) <= 0 ||
    (value.answerRecordSourceAttemptHighWater as number) <= 0 ||
    typeof value.answerRecordComplete !== "boolean" ||
    typeof value.answerRecordLogicalRunId !== "string" ||
    value.answerRecordLogicalRunId.length === 0 ||
    typeof value.answerRecordSourceRunId !== "string" ||
    value.answerRecordSourceRunId.length === 0
  ) {
    return NO_ANSWER_RECORD_PROGRESS;
  }
  return {
    answerRecordAdmittedRowCount: value.answerRecordAdmittedRowCount as number,
    answerRecordReleasedRowCount: value.answerRecordReleasedRowCount as number,
    answerRecordRemainingKeyCount: value.answerRecordRemainingKeyCount as number,
    answerRecordRefusalEventCount: value.answerRecordRefusalEventCount as number,
    answerRecordComplete: value.answerRecordComplete,
    answerRecordCheckpointSequence: value.answerRecordCheckpointSequence as number,
    answerRecordLogicalRunId: value.answerRecordLogicalRunId,
    answerRecordSourceRunId: value.answerRecordSourceRunId,
    answerRecordSourceAttemptHighWater: value.answerRecordSourceAttemptHighWater as number,
  };
}

const REJECTION_SUBJECT_WITHHELD = Object.freeze([
  "not-host-known",
  "over-bound",
] as const satisfies readonly RejectionSubjectWithheld[]);

/** An attempt row's stored text field, or `null` on any other row or value. */
function storedAttemptText(value: Record<string, unknown>, field: string): string | null {
  return value.rowKind === "attempt" && typeof value[field] === "string"
    ? (value[field] as string)
    : null;
}

function storedCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
