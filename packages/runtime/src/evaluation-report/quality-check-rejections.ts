// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Closed codes and contract locations for quality-path step failures outside
 * the evaluation validator's own table, carried as `QualityValidationRejectionV1`.
 *
 * Producers, in pipeline order (the `validator` field names the check):
 *
 * - `candidate-admission`: the runner's guards around the final evaluator
 *   (`runner-step-loop.ts`), before the host sees a candidate.
 * - `candidate-staging`: candidate preflight and staging
 *   (`quality-artifact-staging.ts`); outer `candidate-invalid`,
 *   `target-scope-mismatch`, or `artifact-integrity-invalid`.
 * - `evaluation`: the locked evaluation validator
 *   (`quality-validation-rejection.ts`); outer `evaluation-invalid`.
 * - `technical-trace`: the admitted technical fact trace; outer
 *   `technical-trace-incomplete`.
 * - `quality-score`: the locked score validator; outer `quality-score-invalid`.
 * - `report-finalization`: the host building the final report from the
 *   evaluator's Markdown; outer `report-binding-invalid`.
 * - `report-binding`: the locked report validator; outer
 *   `report-binding-invalid`.
 * - `final-report-staging`: storing the validated report.
 * - `binding-storage`: storing the validation binding itself.
 *
 * A locked validator that could not run is `<validator>-validator-unavailable`
 * (outer `validator-unavailable`). An unexpected host fault inside a check,
 * such as a file system or store error, is that check's
 * `<check>-integrity-failed`. Nothing reads as uncoded.
 *
 * No validator or model text is retained. A host code comes from the throw
 * site; a validator code comes from this module's tables, which match fixed
 * wording and capture nothing. An unrecognized diagnostic reads as
 * `<validator>-semantics` at `$`, never as a guess.
 */

import { retainedInferenceRejection } from "../config/inference-rejection-limits.js";
import {
  QualityArtifactStagingError,
  type TechnicalFactTraceInspection,
} from "./quality-artifact-staging.js";
import {
  type QualityValidationCheck,
  type QualityValidationRejectionV1,
  validatorIssueLines,
} from "./quality-validation-rejection.js";

/**
 * Every host-raised code and its contract location. `candidate-staging`
 * locations are relative to the candidate envelope, `report-finalization`
 * locations to the report's validated result summary; the rest read `$`.
 */
export const QUALITY_HOST_CHECK_LOCATIONS = Object.freeze({
  // candidate-admission (runner-step-loop.ts)
  "quality-technical-verification-unadmitted": "$",
  "quality-candidate-missing": "$",
  "quality-evaluator-identity-unbound": "$",
  "quality-technical-verification-changed": "$",
  // candidate-staging (quality-artifact-staging.ts)
  "candidate-not-inert": "$",
  "candidate-credential-material": "$",
  "candidate-envelope-shape": "$",
  "candidate-report-invalid": "$.reportMarkdown",
  "candidate-selection-mismatch": "$.selectionSha256",
  "candidate-host-binding-mismatch": "$",
  "candidate-evaluation-shape": "$.evaluation",
  "candidate-profile-mismatch": "$.evaluation.profile",
  "candidate-model-version-mismatch": "$.evaluation.model_version",
  "candidate-scope-type-invalid": "$.evaluation.target.scope_type",
  "candidate-revision-mismatch": "$.evaluation.target.repository_revision",
  "candidate-target-paths-invalid": "$.evaluation.target.paths",
  "candidate-target-outside-scope": "$.evaluation.target.paths",
  "candidate-quality-score-shape": "$.qualityScore",
  "candidate-artifact-unstored": "$",
  "staged-artifact-unreadable": "$",
  // report-finalization (quality-validator-host.ts)
  "report-candidate-not-text": "$",
  "report-summary-repeated": "$",
  "report-profile-bytes-changed": "$.profile",
  "report-profile-identity-mismatch": "$.profile",
  "report-limitation-section-count": "$.limitations",
  "report-limitation-row-ambiguous": "$.limitations",
  "report-limitation-value-invalid": "$.limitations",
  "report-limitation-duplicate": "$.limitations",
  "report-rubric-id-invalid": "$.rubric",
  "report-rubric-not-locked": "$.rubric",
  "report-rubric-bytes-changed": "$.rubric",
  "report-rubric-metadata-inconsistent": "$.rubric",
  "report-score-total-invalid": "$.rubric.total",
  "report-artifact-not-object": "$",
  // final-report-staging (quality-artifact-staging.ts)
  "final-report-invalid": "$",
  "final-report-unstored": "$",
  // binding-storage (quality-validator-host.ts)
  "validation-binding-unstored": "$",
  // shared by the three locked validators (quality-validator-host.ts)
  "validator-workspace-not-private": "$",
  "validator-lock-entry-missing": "$",
  "validator-input-not-regular": "$",
  "validator-input-digest-changed": "$",
  "evaluation-validator-unavailable": "$",
  "quality-score-validator-unavailable": "$",
  "report-binding-validator-unavailable": "$",
  // an unexpected host fault inside each check
  "candidate-staging-integrity-failed": "$",
  "evaluation-integrity-failed": "$",
  "technical-trace-integrity-failed": "$",
  "quality-score-integrity-failed": "$",
  "report-finalization-integrity-failed": "$",
  "report-binding-integrity-failed": "$",
  "final-report-staging-integrity-failed": "$",
  "binding-storage-integrity-failed": "$",
} as const);

export type QualityHostCheckCode = keyof typeof QUALITY_HOST_CHECK_LOCATIONS;

/** A check the validator host runs; the runner's candidate admission precedes them. */
export type QualityHostPhase = Exclude<QualityValidationCheck, "candidate-admission">;

export const QUALITY_CHECK_INTEGRITY_CODES = Object.freeze({
  "candidate-staging": "candidate-staging-integrity-failed",
  evaluation: "evaluation-integrity-failed",
  "technical-trace": "technical-trace-integrity-failed",
  "quality-score": "quality-score-integrity-failed",
  "report-finalization": "report-finalization-integrity-failed",
  "report-binding": "report-binding-integrity-failed",
  "final-report-staging": "final-report-staging-integrity-failed",
  "binding-storage": "binding-storage-integrity-failed",
} as const satisfies Record<QualityHostPhase, QualityHostCheckCode>);

export const QUALITY_VALIDATOR_UNAVAILABLE_CODES = Object.freeze({
  evaluation: "evaluation-validator-unavailable",
  "quality-score": "quality-score-validator-unavailable",
  "report-binding": "report-binding-validator-unavailable",
} as const satisfies Partial<Record<QualityValidationCheck, QualityHostCheckCode>>);

export type QualityLockedValidator = keyof typeof QUALITY_VALIDATOR_UNAVAILABLE_CODES;

/**
 * A host check's closed code, read back as a `QualityValidationRejectionV1`.
 * The validator host and the runner record its code, not its message.
 */
export class QualityHostCheckError extends Error {
  public constructor(public readonly code: QualityHostCheckCode) {
    super(`The quality validation host refused the artifact with check code ${code}.`);
    this.name = "QualityHostCheckError";
  }
}

/** For `throw hostCheckError("<code>")`. */
export function hostCheckError(code: QualityHostCheckCode): QualityHostCheckError {
  return new QualityHostCheckError(code);
}

/**
 * A quality-path step refusal with no validation binding to carry it, such as
 * a runner guard around the final evaluator or an unreadable pack lock. Keeps
 * the operator message and carries the coded reason the runner records.
 */
export class QualityStepRejectionError extends Error {
  public constructor(
    public readonly rejection: QualityValidationRejectionV1,
    message: string,
  ) {
    super(message);
    this.name = "QualityStepRejectionError";
  }
}

/** A runner guard's refusal of the final evaluator's candidate, before the validator host runs. */
export function qualityCandidateAdmissionError(
  code: QualityHostCheckCode,
  message: string,
): QualityStepRejectionError {
  return new QualityStepRejectionError(hostCheckRejection("candidate-admission", code), message);
}

/** The closed code an error inside a host check carries, else that check's integrity code. */
export function hostCheckCodeOf(error: unknown, phase: QualityHostPhase): QualityHostCheckCode {
  if (error instanceof QualityHostCheckError) return error.code;
  if (error instanceof QualityArtifactStagingError && error.reason !== undefined) {
    return error.reason;
  }
  return QUALITY_CHECK_INTEGRITY_CODES[phase];
}

export function isLockedValidator(check: QualityValidationCheck): check is QualityLockedValidator {
  return Object.hasOwn(QUALITY_VALIDATOR_UNAVAILABLE_CODES, check);
}

/** A host check stops at its first issue, so the count is always one. */
export function hostCheckRejection(
  check: QualityValidationCheck,
  code: QualityHostCheckCode,
): QualityValidationRejectionV1 {
  const retained = retainedInferenceRejection({
    code,
    location: QUALITY_HOST_CHECK_LOCATIONS[code],
  });
  return {
    validator: check,
    code: retained.code,
    location: retained.location,
    issueCount: 1,
  };
}

const TECHNICAL_TRACE_LOCATIONS = Object.freeze({
  "malformed-candidate": "$",
  "missing-fact-id": "$.findings",
  "missing-issue-id": "$.findings",
  "missing-uncertainty": "$.findings",
  "missing-source-locator": "$.findings",
  "missing-inventory-limitation": "$.limitations",
  "missing-unverified-dimension-limitation": "$.limitations",
} as const satisfies Record<TechnicalFactTraceInspection["violations"][number]["code"], string>);

export type TechnicalTraceRejectionCode =
  `technical-trace-${keyof typeof TECHNICAL_TRACE_LOCATIONS}`;

export const TECHNICAL_TRACE_REJECTION_CODES: readonly TechnicalTraceRejectionCode[] =
  Object.freeze(
    Object.keys(TECHNICAL_TRACE_LOCATIONS).map(
      (code) => `technical-trace-${code}` as TechnicalTraceRejectionCode,
    ),
  );

/**
 * The trace check's first violation, from the same content-free inspection
 * the evaluator's advisory tool returns. The count is the retained
 * violations, which the inspection bounds.
 */
export function technicalTraceRejection(
  inspection: TechnicalFactTraceInspection,
): QualityValidationRejectionV1 {
  const first = inspection.violations[0];
  if (inspection.status !== "invalid" || first === undefined) {
    return hostCheckRejection("technical-trace", "technical-trace-integrity-failed");
  }
  const retained = retainedInferenceRejection({
    code: `technical-trace-${first.code}`,
    location: TECHNICAL_TRACE_LOCATIONS[first.code],
  });
  return {
    validator: "technical-trace",
    code: retained.code,
    location: retained.location,
    issueCount: inspection.violations.length,
  };
}

type DiagnosticRow = readonly [pattern: RegExp, code: string, location: string];

/**
 * The locked score validator's diagnostics (`checks/validate_quality_score.py`).
 * Locations are relative to the quality score artifact. Patterns match fixed
 * wording only; nothing is captured.
 */
const QUALITY_SCORE_DIAGNOSTICS = [
  [/^quality score must be a JSON object$/u, "score-not-object", "$"],
  [/^quality score is missing required field: /u, "score-field-missing", "$"],
  [/^quality score contains unsupported field: /u, "score-field-unsupported", "$"],
  [/^unsupported rubric: /u, "score-rubric-unsupported", "$.rubric"],
  [/^scores must be an object$/u, "score-dimensions-not-object", "$.scores"],
  [/^scores is missing required field: /u, "score-dimension-missing", "$.scores"],
  [/^scores contains unsupported field: /u, "score-dimension-unsupported", "$.scores"],
  [/^score \S+ must be a number$/u, "score-dimension-not-number", "$.scores"],
  [/^score \S+ must be between 0 and /u, "score-dimension-out-of-range", "$.scores"],
  [/^total must be a number between 0 and 100$/u, "score-total-out-of-range", "$.total"],
  [/^total \S+ does not equal the score sum /u, "score-total-sum-mismatch", "$.total"],
  [/^hard_gates must be an object$/u, "score-hard-gates-not-object", "$.hard_gates"],
  [/^hard_gates is missing required field: /u, "score-hard-gate-missing", "$.hard_gates"],
  [/^hard_gates contains unsupported field: /u, "score-hard-gate-unsupported", "$.hard_gates"],
  [
    /^hard gate \S+ must be a nonnegative integer$/u,
    "score-hard-gate-count-invalid",
    "$.hard_gates",
  ],
  [/^unsupported decision: /u, "score-decision-unsupported", "$.decision"],
  [
    /^a nonzero hard gate requires decision 'fail'$/u,
    "score-hard-gate-requires-fail",
    "$.decision",
  ],
  [/^decision 'pass' requires total >= /u, "score-pass-below-threshold", "$.decision"],
  [
    /^rubric \S+ does not allow conditional-pass$/u,
    "score-conditional-pass-not-allowed",
    "$.decision",
  ],
  [
    /^confidence must be a number between 0 and 1$/u,
    "score-confidence-out-of-range",
    "$.confidence",
  ],
  [/^rationale must be a non-empty string$/u, "score-rationale-empty", "$.rationale"],
  [/^unable to read /u, "score-unreadable", "$"],
  [/^invalid JSON in /u, "score-invalid-json", "$"],
  [/^non-finite JSON number: /u, "score-invalid-json", "$"],
] as const satisfies readonly DiagnosticRow[];

/**
 * The locked report validator's diagnostics (`checks/validate_quality_report.py`,
 * reached through the skill's shim). Locations are relative to the report's
 * validated result summary. A retained gap evidence row's index is matched by
 * shape and never captured.
 */
const REPORT_BINDING_DIAGNOSTICS = [
  [/^unable to read /u, "report-input-unreadable", "$"],
  [/^invalid JSON in /u, "report-input-unreadable", "$"],
  [/^non-finite JSON number: /u, "report-input-unreadable", "$"],
  [/^(?:evaluation|profile|quality score) must be an object$/u, "report-input-not-object", "$"],
  [
    /^quality report must contain exactly one JSON object under /u,
    "report-summary-block-count",
    "$",
  ],
  [/^invalid report summary JSON: /u, "report-summary-json-invalid", "$"],
  [/^report summary must be (?:a JSON object|an object)$/u, "report-summary-not-object", "$"],
  [/^report summary (?:is missing|contains unsupported) field /u, "report-summary-fields", "$"],
  [
    /^(?:quality report|documentation quality evaluation) schema must be an object$/u,
    "report-validator-schema-invalid",
    "$",
  ],
  [/^quality-report\.schema\.json: /u, "report-summary-schema", "$"],
  [/^evaluation\.json: /u, "report-evaluation-artifact-invalid", "$.evaluation"],
  [/^quality-score\.json: /u, "report-score-artifact-invalid", "$.rubric"],
  [
    /^v0\.2 report must contain exactly one limitation section$/u,
    "report-limitation-section-count",
    "$.limitations",
  ],
  [
    /^v0\.2 report limitation section is ambiguous$/u,
    "report-limitation-row-ambiguous",
    "$.limitations",
  ],
  [/^v0\.2 JSON limitation row is invalid$/u, "report-limitation-row-ambiguous", "$.limitations"],
  [
    /^v0\.2 JSON limitation row has an invalid value$/u,
    "report-limitation-value-invalid",
    "$.limitations",
  ],
  [
    /^v0\.2 report limitation row has an invalid value$/u,
    "report-limitation-value-invalid",
    "$.limitations",
  ],
  [
    /^v0\.2 report limitation section contains duplicate values$/u,
    "report-limitation-duplicate",
    "$.limitations",
  ],
  [
    /^v0\.2 report limitations must be a string array$/u,
    "report-limitations-not-strings",
    "$.limitations",
  ],
  [
    /^v0\.2 report validation requires the Markdown limitation collection$/u,
    "report-limitations-unread",
    "$.limitations",
  ],
  [
    /^report limitations do not exactly match the Markdown limitation collection$/u,
    "report-limitations-mismatch",
    "$.limitations",
  ],
  [
    /^v0\.2 retained gap evidence must be an array$/u,
    "report-gap-evidence-not-array",
    "$.retained_gap_evidence",
  ],
  [
    /^v0\.2 report validation requires the profile artifact digest$/u,
    "report-profile-digest-missing",
    "$.retained_gap_evidence",
  ],
  [/^retained gap evidence\[[^\]]*\] /u, "report-gap-evidence-mismatch", "$.retained_gap_evidence"],
  [
    /^profile (?:decision policy|calibration) must be an object$/u,
    "report-profile-policy-not-object",
    "$.retained_gap_evidence",
  ],
  [/^report contract is unsupported$/u, "report-contract-unsupported", "$.report_contract"],
  [/^report target /u, "report-target-mismatch", "$.target"],
  [/^report profile /u, "report-profile-mismatch", "$.profile"],
  [/^report evaluation /u, "report-evaluation-mismatch", "$.evaluation"],
  [/^report validation /u, "report-validation-status", "$.validation"],
  [
    /^report must record \S+(?: \S+)? validation as passed$/u,
    "report-validation-status",
    "$.validation",
  ],
  [
    /^missing quality-score\.json must be recorded as unavailable$/u,
    "report-validation-status",
    "$.validation",
  ],
  [/^report artifact locators? /u, "report-artifact-locators", "$.artifact_locators"],
  [
    /^(?:missing quality-score\.json must have a null report locator|available quality-score\.json requires a non-empty locator)$/u,
    "report-artifact-locators",
    "$.artifact_locators",
  ],
  [/^report rubric /u, "report-rubric-mismatch", "$.rubric"],
  [
    /^(?:an unavailable report rubric must contain only status and reason|missing quality-score\.json requires rubric status unavailable|an unavailable rubric score requires a non-empty reason)$/u,
    "report-rubric-mismatch",
    "$.rubric",
  ],
  [
    /^quality-score (?:scores|dimension|hard gates|decision) /u,
    "report-rubric-yaml-mismatch",
    "$.rubric",
  ],
  [/^rubric \S+ has an invalid pass_threshold$/u, "report-rubric-threshold-invalid", "$.rubric"],
  [
    /^rubric \S+ has no readable dimension weights$/u,
    "report-rubric-weights-unreadable",
    "$.rubric",
  ],
  [/^no versioned rubric YAML has id /u, "report-rubric-unresolved", "$.rubric"],
] as const satisfies readonly DiagnosticRow[];

/** A validator diagnostic the table has no row for. */
export const QUALITY_SCORE_SEMANTICS_FALLBACK = "quality-score-semantics";
export const REPORT_BINDING_SEMANTICS_FALLBACK = "report-binding-semantics";
/** The validator exited without listing an issue. */
export const QUALITY_SCORE_VALIDATOR_REFUSED = "quality-score-validator-refused";
export const REPORT_BINDING_VALIDATOR_REFUSED = "report-binding-validator-refused";

function classify(
  table: readonly DiagnosticRow[],
  message: string,
  fallback: string,
): { code: string; location: string } {
  for (const [pattern, code, location] of table) {
    if (pattern.test(message)) return { code, location };
  }
  return { code: fallback, location: "$" };
}

export function classifyQualityScoreDiagnostic(message: string): {
  code: string;
  location: string;
} {
  return classify(QUALITY_SCORE_DIAGNOSTICS, message, QUALITY_SCORE_SEMANTICS_FALLBACK);
}

export function classifyReportBindingDiagnostic(message: string): {
  code: string;
  location: string;
} {
  return classify(REPORT_BINDING_DIAGNOSTICS, message, REPORT_BINDING_SEMANTICS_FALLBACK);
}

/**
 * Reduce a failed score or report validator run to its first issue's closed
 * code, as `projectEvaluationValidatorRejection` does for the evaluation
 * validator. Validator text is read in memory and never retained.
 */
export function projectLockedValidatorRejection(input: {
  readonly validator: "quality-score" | "report-binding";
  readonly stderr: string;
}): QualityValidationRejectionV1 {
  const lines = validatorIssueLines(input.stderr);
  const first = lines[0];
  const reason =
    input.validator === "quality-score"
      ? first === undefined
        ? { code: QUALITY_SCORE_VALIDATOR_REFUSED, location: "$" }
        : classifyQualityScoreDiagnostic(first)
      : first === undefined
        ? { code: REPORT_BINDING_VALIDATOR_REFUSED, location: "$" }
        : classifyReportBindingDiagnostic(first);
  const retained = retainedInferenceRejection(reason);
  return {
    validator: input.validator,
    code: retained.code,
    location: retained.location,
    issueCount: lines.length,
  };
}

/**
 * Every code a quality-path step failure can record outside the evaluation
 * validator's own table. A failure-class table keyed by quality codes must
 * name each one.
 */
export type QualityCheckRejectionCode =
  | QualityHostCheckCode
  | TechnicalTraceRejectionCode
  | typeof QUALITY_SCORE_SEMANTICS_FALLBACK
  | typeof QUALITY_SCORE_VALIDATOR_REFUSED
  | (typeof QUALITY_SCORE_DIAGNOSTICS)[number][1]
  | typeof REPORT_BINDING_SEMANTICS_FALLBACK
  | typeof REPORT_BINDING_VALIDATOR_REFUSED
  | (typeof REPORT_BINDING_DIAGNOSTICS)[number][1];

export const QUALITY_CHECK_REJECTION_CODES: readonly QualityCheckRejectionCode[] = Object.freeze([
  ...new Set<QualityCheckRejectionCode>([
    ...(Object.keys(QUALITY_HOST_CHECK_LOCATIONS) as QualityHostCheckCode[]),
    ...TECHNICAL_TRACE_REJECTION_CODES,
    QUALITY_SCORE_SEMANTICS_FALLBACK,
    QUALITY_SCORE_VALIDATOR_REFUSED,
    ...QUALITY_SCORE_DIAGNOSTICS.map(([, code]) => code),
    REPORT_BINDING_SEMANTICS_FALLBACK,
    REPORT_BINDING_VALIDATOR_REFUSED,
    ...REPORT_BINDING_DIAGNOSTICS.map(([, code]) => code),
  ]),
]);
