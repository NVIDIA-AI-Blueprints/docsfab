// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit } from "../../contract-kit/index.js";
import { OUTPUT_RULE_HINTS, OUTPUT_RULES } from "../../contracts/model-output.js";
import {
  EVALUATION_DIAGNOSTIC_CODES,
  type EvaluationDiagnosticCode,
} from "../../evaluation-report/quality-validation-rejection.js";
import {
  QUALITY_CHECK_REJECTION_CODES,
  TECHNICAL_TRACE_REJECTION_CODES,
  QUALITY_SCORE_SEMANTICS_FALLBACK,
  QUALITY_SCORE_VALIDATOR_REFUSED,
  qualityCandidateAdmissionError,
  type QualityCheckRejectionCode,
} from "../../evaluation-report/quality-check-rejections.js";
import { STAGED_QUALITY_SCHEMA_MISMATCH_KEYWORDS } from "../../evaluation-report/quality-schema-validation.js";
import type { AnswerRecordCode } from "../answer-records.js";
import type {
  QualityAnswerRecordOutputCode,
  QualityAnswerRecordReceiptV1,
} from "../quality-answer-record-admission.js";

const ADMISSION_HOST_FAILURE_REASONS = [
  "unmapped-refusal",
  "row-type-missing",
  "declaration-mismatch",
  "binding-identity",
  "binding-hash",
  "schema-hashes",
  "canonical-schema-binding",
  "reference-hashes",
  "reference-provenance-set",
  "reference-id-set",
  "narrowing-binding-mismatch",
  "narrowing-values",
  "confidence-anchors",
  "unsupported-generated-schema",
  "index-address-missing",
  "checkpoint-row-address",
  "checkpoint-address",
  "stored-row-address",
  "stored-row-binding",
  "stored-row-shape",
  "release-row-missing",
  "release-row-binding",
  "batch-shape",
  "batch-authorization",
  "batch-drift",
  "overlapping-batch",
  "validator-infrastructure-failure",
  "validator-outcome-shape",
  "validator-outcome-set",
  "validator-outcome-incomplete",
  "completion-ledger-drift",
  "completion-call-missing",
  "derivation-open-shape",
  "assembled-artifact-shape",
  "completion-validator-infrastructure-failure",
  "assembly-validator-outcome",
  "assembly-validator-owner",
  "unknown-call",
  "settlement-authority",
  "settlement-admission-drift",
  "withdrawal-address",
  "settlement-row-missing",
  "settlement-ledger-rebuild",
  "checkpoint-restore-order",
  "checkpoint-binding",
  "checkpoint-issued-state",
  "checkpoint-row-shape",
  "checkpoint-row-ledger",
  "checkpoint-refusal-state",
  "checkpoint-continuation-source-missing",
  "checkpoint-shape",
  "release-active-batch",
  "reloaded-ledger-invalid",
  "ledger-incomplete",
  "derivation-open",
  "replay-row-not-committed",
  "answer-record-shape",
] as const;

type AdmissionHostFailureReason = (typeof ADMISSION_HOST_FAILURE_REASONS)[number];
type CanonicalAdmissionHostFailureReason = AdmissionHostFailureReason | "unclassified";

/** Return only diagnostics selected from the closed host/contract-kit vocabulary. */
export function canonicalAdmissionHostFailureReason(
  code: string,
): CanonicalAdmissionHostFailureReason {
  return (ADMISSION_HOST_FAILURE_REASONS as readonly string[]).includes(code)
    ? (code as AdmissionHostFailureReason)
    : "unclassified";
}

export function qualityAnswerRecordAdmissionFailureMessage(code: string): string {
  return `Quality answer-record admission stopped because host validation failed (host reason: ${canonicalAdmissionHostFailureReason(code)}).`;
}

const failKit = (code: CanonicalAdmissionHostFailureReason): never => {
  // Integrity, disclosure, and host-validation faults must terminate the host
  // path. They are never presented as model-correctable record-shape errors.
  throw qualityCandidateAdmissionError(
    "candidate-staging-integrity-failed",
    qualityAnswerRecordAdmissionFailureMessage(code),
  );
};
const kit = createContractKit({
  fail: (code) => failKit(canonicalAdmissionHostFailureReason(String(code))),
  codes: {
    invalidShape: "answer-record-shape",
    invalidValue: "answer-record-shape",
    digestMismatch: "answer-record-shape",
    credentialMaterial: "answer-record-shape",
    schemaMismatch: "answer-record-shape",
  },
});

function failClosed(
  code: QualityAnswerRecordOutputCode,
  location: string,
  type: string | null,
  key: string | null,
  feedbackOverride?: string,
): QualityAnswerRecordReceiptV1 {
  const rule = (
    OUTPUT_RULES as Readonly<
      Record<string, { retry: "model-correctable" | "terminal"; locations: readonly string[] }>
    >
  )[code];
  const isSchemaCode =
    code.startsWith("evaluation-schema-") &&
    STAGED_QUALITY_SCHEMA_MISMATCH_KEYWORDS.some(
      (keyword) => code === `evaluation-schema-${keyword}`,
    );
  const isDiagnostic = EVALUATION_DIAGNOSTIC_CODES.includes(code as EvaluationDiagnosticCode);
  const isQualityScoreDiagnostic =
    QUALITY_CHECK_REJECTION_CODES.includes(code as QualityCheckRejectionCode) &&
    (code.startsWith("score-") ||
      code === QUALITY_SCORE_SEMANTICS_FALLBACK ||
      code === QUALITY_SCORE_VALIDATOR_REFUSED);
  const isTechnicalTraceRefusal = TECHNICAL_TRACE_REJECTION_CODES.includes(
    code as (typeof TECHNICAL_TRACE_REJECTION_CODES)[number],
  );
  if (
    (!rule || !rule.locations.includes(location)) &&
    !isSchemaCode &&
    !isDiagnostic &&
    !isQualityScoreDiagnostic &&
    !isTechnicalTraceRefusal
  ) {
    return failKit("unmapped-refusal");
  }
  const hint = rule ? OUTPUT_RULE_HINTS[code as AnswerRecordCode] : undefined;
  const correctableQualityRefusal =
    isSchemaCode ||
    code === "evaluation-profile-semantics" ||
    isQualityScoreDiagnostic ||
    code === "technical-trace-missing-fact-id";
  const retry = rule?.retry ?? (correctableQualityRefusal ? "model-correctable" : "terminal");
  const qualityFeedback = isSchemaCode
    ? (feedbackOverride ?? "Correct this record to match the declared record shape.")
    : code === "evaluation-profile-semantics"
      ? "Revise this record to satisfy the selected quality profile."
      : isQualityScoreDiagnostic
        ? "Revise the quality score to satisfy the selected quality profile."
        : undefined;
  return {
    status: "refused",
    type,
    key,
    code,
    location,
    retry,
    ...(feedbackOverride
      ? { feedback: feedbackOverride }
      : hint
        ? { feedback: hint.atLocation?.[location] ?? hint.rule }
        : qualityFeedback
          ? { feedback: qualityFeedback }
          : {}),
    remaining: [],
    complete: false,
  };
}

export { failKit, kit, failClosed };
