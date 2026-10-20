// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The closed vocabularies of an attempt's `answerSubmission` record
 * and the one validator every attempt reader shares. A leaf, so each record
 * decoder can check a saved attempt without importing the harness.
 */
import type {
  AnswerRecordLedgerProgressV1,
  InferenceAnswerMemberEncodingV1,
  InferenceAnswerPath,
  InferenceAnswerPathReason,
  InferenceAnswerReportTurnState,
  InferenceAnswerSubmissionEvidenceV1,
  InferenceAnswerSubmissionState,
} from "./contracts.js";

export const INFERENCE_ANSWER_PATHS = Object.freeze([
  "text-final",
  "tool-call",
  "answer-records",
] as const satisfies readonly InferenceAnswerPath[]);

export const INFERENCE_ANSWER_PATH_REASONS = Object.freeze([
  "recorded-route",
  "not-recorded",
  "tool-not-granted",
  "operator-override",
  "record-ledger",
] as const satisfies readonly InferenceAnswerPathReason[]);

export const INFERENCE_ANSWER_SUBMISSION_STATES = Object.freeze([
  "absent",
  "in-flight",
  "admitted",
  "refused",
  "not-decoded-at-ceiling",
  "not-applicable",
] as const satisfies readonly InferenceAnswerSubmissionState[]);

export const INFERENCE_ANSWER_REPORT_TURN_STATES = Object.freeze([
  "not-asked",
  "in-flight",
  "admitted",
  "refused",
  "clamped",
  "authority-stopped",
] as const satisfies readonly InferenceAnswerReportTurnState[]);

export const INFERENCE_ANSWER_EVALUATION_ENCODINGS = Object.freeze([
  "object",
  "string",
] as const satisfies readonly InferenceAnswerMemberEncodingV1["evaluation"][]);

export const INFERENCE_ANSWER_QUALITY_SCORE_ENCODINGS = Object.freeze([
  "object",
  "null",
  "string",
] as const satisfies readonly InferenceAnswerMemberEncodingV1["qualityScore"][]);

/**
 * The run-index projection of `memberEncoding`: `<evaluation>/<qualityScore>`,
 * for example `string/string`.
 */
export const INFERENCE_ANSWER_MEMBER_ENCODINGS = Object.freeze(
  INFERENCE_ANSWER_EVALUATION_ENCODINGS.flatMap((evaluation) =>
    INFERENCE_ANSWER_QUALITY_SCORE_ENCODINGS.map(
      (qualityScore) => `${evaluation}/${qualityScore}` as const,
    ),
  ),
);
export type InferenceAnswerMemberEncodingColumn =
  (typeof INFERENCE_ANSWER_MEMBER_ENCODINGS)[number];

export function answerMemberEncodingColumn(
  encoding: InferenceAnswerMemberEncodingV1,
): InferenceAnswerMemberEncodingColumn {
  return `${encoding.evaluation}/${encoding.qualityScore}`;
}

const ANSWER_RECORD_PROGRESS_KEYS = new Set([
  "admittedRowCount",
  "releasedRowCount",
  "remainingKeyCount",
  "refusalEventCount",
  "complete",
  "checkpointSequence",
  "logicalRunId",
  "sourceRunId",
  "sourceAttemptHighWater",
]);

/** The closed, content-free progress summary committed with an answer-record checkpoint. */
export function isAnswerRecordLedgerProgress(
  value: unknown,
): value is AnswerRecordLedgerProgressV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    Object.keys(item).length === ANSWER_RECORD_PROGRESS_KEYS.size &&
    Object.keys(item).every((key) => ANSWER_RECORD_PROGRESS_KEYS.has(key)) &&
    Number.isSafeInteger(item.admittedRowCount) &&
    Number(item.admittedRowCount) >= 0 &&
    Number.isSafeInteger(item.releasedRowCount) &&
    Number(item.releasedRowCount) >= 0 &&
    Number.isSafeInteger(item.remainingKeyCount) &&
    Number(item.remainingKeyCount) >= 0 &&
    Number.isSafeInteger(item.refusalEventCount) &&
    Number(item.refusalEventCount) >= 0 &&
    typeof item.complete === "boolean" &&
    Number.isSafeInteger(item.checkpointSequence) &&
    Number(item.checkpointSequence) > 0 &&
    typeof item.logicalRunId === "string" &&
    item.logicalRunId.length > 0 &&
    typeof item.sourceRunId === "string" &&
    item.sourceRunId.length > 0 &&
    Number.isSafeInteger(item.sourceAttemptHighWater) &&
    Number(item.sourceAttemptHighWater) > 0
  );
}

const KEYS = new Set([
  "path",
  "reason",
  "submission",
  "reportTurn",
  "submissionInFlightBytes",
  "reportInFlightBytes",
  "memberEncoding",
  "submissionInnerBytes",
]);

function isMemberEncoding(value: unknown): value is InferenceAnswerMemberEncodingV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    Object.keys(item).length === 2 &&
    member(INFERENCE_ANSWER_EVALUATION_ENCODINGS, item.evaluation) &&
    member(INFERENCE_ANSWER_QUALITY_SCORE_ENCODINGS, item.qualityScore)
  );
}

function member<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function optionalCount(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && Number(value) >= 0);
}

/**
 * The closed shape of an attempt's answer-submission record. States must
 * agree with the path and reason. The tool-call path can submit an answer and
 * ask for a report after admission; the records path has no singular
 * submission and asks for a report after ledger completion. In-flight byte
 * counts appear exactly with their in-flight states.
 */
export function isInferenceAnswerSubmissionEvidence(
  value: unknown,
): value is InferenceAnswerSubmissionEvidenceV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !KEYS.has(key))) return false;
  if (
    !member(INFERENCE_ANSWER_PATHS, item.path) ||
    !member(INFERENCE_ANSWER_PATH_REASONS, item.reason) ||
    !member(INFERENCE_ANSWER_SUBMISSION_STATES, item.submission) ||
    !member(INFERENCE_ANSWER_REPORT_TURN_STATES, item.reportTurn) ||
    !optionalCount(item.submissionInFlightBytes) ||
    !optionalCount(item.reportInFlightBytes)
  ) {
    return false;
  }
  if ((item.path === "tool-call") !== (item.reason === "recorded-route")) return false;
  if (
    item.path === "text-final" &&
    (item.submission !== "absent" || item.reportTurn !== "not-asked")
  ) {
    return false;
  }
  if (item.path === "answer-records") {
    if (item.reason !== "record-ledger" || item.submission !== "not-applicable") return false;
  } else if (item.reason === "record-ledger" || item.submission === "not-applicable") {
    return false;
  }
  if (
    item.path !== "answer-records" &&
    item.reportTurn !== "not-asked" &&
    item.submission !== "admitted"
  ) {
    return false;
  }
  if ((item.submission === "in-flight") !== (item.submissionInFlightBytes !== undefined)) {
    return false;
  }
  if (item.memberEncoding !== undefined) {
    if (item.submission !== "admitted" || !isMemberEncoding(item.memberEncoding)) return false;
  }
  const stringMember =
    item.memberEncoding !== undefined &&
    ((item.memberEncoding as InferenceAnswerMemberEncodingV1).evaluation === "string" ||
      (item.memberEncoding as InferenceAnswerMemberEncodingV1).qualityScore === "string");
  if (!optionalCount(item.submissionInnerBytes)) return false;
  if (stringMember !== (item.submissionInnerBytes !== undefined)) return false;
  return (item.reportTurn === "in-flight") === (item.reportInFlightBytes !== undefined);
}
