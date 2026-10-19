// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Whether a quality validation rejection may be retried.
 *
 * Classifies every code a quality-path step refusal can record
 * (`QUALITY_CHECK_REJECTION_CODES`, `EVALUATION_DIAGNOSTIC_CODES`, and the
 * `evaluation-schema-<keyword>` family).
 *
 * `model-correctable`: the final evaluator's artifact broke a stated contract
 * rule, and a bounded retry told the rule can repair it; every validator still
 * checks every attempt.
 *
 * `terminal` stops the step whatever budget remains:
 *
 * - host faults: an unavailable validator, a changed lock or input, a storage
 *   or integrity failure, or a host-built value that disagrees with itself;
 * - security refusals: credential or non-inert content;
 * - refusals with no rule the evaluator can see: a validator that refused
 *   without naming an issue, or a check that runs after a locked validator
 *   already accepted the same field, so the host and validator disagree.
 *
 * The `satisfies` clause fails to typecheck when the table and code set
 * differ; `quality-rejection-rule-hints.ts` fails when a model-correctable
 * code has no rule. This module is a dependency-free leaf; it imports types
 * only.
 */

import type { QualityCheckRejectionCode } from "../evaluation-report/quality-check-rejections.js";
import type { RuleCodeOf } from "../contracts/model-output.generated.js";
import type {
  EvaluationDiagnosticCode,
  EvaluationSchemaRejectionCode,
} from "../evaluation-report/quality-validation-rejection.js";

export type QualityRejectionCode =
  | QualityCheckRejectionCode
  | EvaluationDiagnosticCode
  | EvaluationSchemaRejectionCode
  | Extract<RuleCodeOf<"quality-envelope">, "evaluation-layer-residual-invalid">;

export type QualityRejectionRetryability = "model-correctable" | "terminal";

export interface QualityRejectionRetryabilityEntry {
  readonly retry: QualityRejectionRetryability;
  readonly reason: string;
}

const correctable = (
  reason: string,
): QualityRejectionRetryabilityEntry & {
  readonly retry: "model-correctable";
} => Object.freeze({ retry: "model-correctable", reason });
const terminal = (
  reason: string,
): QualityRejectionRetryabilityEntry & { readonly retry: "terminal" } =>
  Object.freeze({ retry: "terminal", reason });

const HOST_FAULT = terminal(
  "A host precondition, lock, storage, or integrity fault; no reply can repair it.",
);
const VALIDATOR_UNAVAILABLE = terminal(
  "The locked validator could not run; the host runtime must be repaired.",
);
const HOST_BUILT = terminal(
  "The host built or supplied this value, so a refusal is a host defect, not the evaluator's.",
);
const AFTER_LOCKED_VALIDATOR = terminal(
  "A locked validator already accepted this field, so this refusal means the host and that validator disagree.",
);
const UNNAMED_REFUSAL = terminal(
  "The validator refused without naming an issue, so no rule can be stated to the evaluator.",
);
const EVALUATION_RULE = correctable(
  "The evaluation broke a rule of the locked evaluation schema or selected profile that the evaluator contract states.",
);
const EVALUATION_SCHEMA_RULE = correctable(
  "The evaluation broke the locked evaluation schema the evaluator contract supplies in full.",
);
const TRACE_RULE = correctable(
  "The evaluation dropped admitted technical evidence it can carry forward from the admitted verification result.",
);
const SCORE_RULE = correctable(
  "The quality score broke a rule of the locked score schema or rubric that the evaluator contract supplies.",
);
const REPORT_LIMITATION_RULE = correctable(
  "The evaluator's report Markdown broke the limitation section format the report template states.",
);

export const QUALITY_REJECTION_RETRYABILITY = Object.freeze({
  // candidate-admission: runner guards around the final evaluator.
  "quality-technical-verification-unadmitted": HOST_FAULT,
  "quality-candidate-missing": terminal(
    "The evaluator returned no admitted candidate or a non-success outcome; a malformed envelope is already retried by the envelope decoder.",
  ),
  "quality-evaluator-identity-unbound": HOST_FAULT,
  "quality-technical-verification-changed": HOST_FAULT,
  // candidate-staging.
  "candidate-not-inert": terminal(
    "Non-inert candidate content is a security refusal and is never re-asked.",
  ),
  "candidate-credential-material": terminal(
    "Credential-shaped candidate content is a security refusal and is never re-asked.",
  ),
  "candidate-envelope-shape": HOST_BUILT,
  "candidate-report-invalid": correctable(
    "reportMarkdown must be non-empty Markdown within its size bound, as the envelope contract states.",
  ),
  "candidate-selection-mismatch": HOST_BUILT,
  "candidate-host-binding-mismatch": HOST_BUILT,
  "candidate-evaluation-shape": correctable(
    "evaluation must be a JSON object and evaluation.target must remain a JSON object with its model-authored evidence fields; the host supplies profile metadata and fills target metadata.",
  ),
  "candidate-profile-mismatch": HOST_BUILT,
  "candidate-model-version-mismatch": HOST_BUILT,
  "candidate-scope-type-invalid": HOST_BUILT,
  "candidate-revision-mismatch": HOST_BUILT,
  // The host writes evaluation.target.paths from the selected scope before staging.
  "candidate-target-paths-invalid": HOST_BUILT,
  "candidate-target-outside-scope": HOST_BUILT,
  "candidate-quality-score-shape": correctable(
    "qualityScore must be a JSON object or null, as the envelope contract states.",
  ),
  "candidate-artifact-unstored": HOST_FAULT,
  "staged-artifact-unreadable": HOST_FAULT,
  // report-finalization.
  "report-candidate-not-text": HOST_BUILT,
  "report-summary-repeated": correctable(
    "The host writes the one validated result summary; the evaluator's report must not repeat that section.",
  ),
  "report-profile-bytes-changed": HOST_FAULT,
  "report-profile-identity-mismatch": HOST_FAULT,
  "report-limitation-section-count": REPORT_LIMITATION_RULE,
  "report-limitation-row-ambiguous": REPORT_LIMITATION_RULE,
  "report-limitation-value-invalid": REPORT_LIMITATION_RULE,
  "report-limitation-duplicate": REPORT_LIMITATION_RULE,
  "report-rubric-id-invalid": AFTER_LOCKED_VALIDATOR,
  "report-rubric-not-locked": AFTER_LOCKED_VALIDATOR,
  "report-rubric-bytes-changed": HOST_FAULT,
  "report-rubric-metadata-inconsistent": HOST_FAULT,
  "report-score-total-invalid": AFTER_LOCKED_VALIDATOR,
  "report-artifact-not-object": HOST_BUILT,
  // final-report-staging and binding-storage.
  "final-report-invalid": HOST_BUILT,
  "final-report-unstored": HOST_FAULT,
  "validation-binding-unstored": HOST_FAULT,
  // shared by the three locked validators.
  "validator-workspace-not-private": HOST_FAULT,
  "validator-lock-entry-missing": HOST_FAULT,
  "validator-input-not-regular": HOST_FAULT,
  "validator-input-digest-changed": HOST_FAULT,
  "evaluation-validator-unavailable": VALIDATOR_UNAVAILABLE,
  "quality-score-validator-unavailable": VALIDATOR_UNAVAILABLE,
  "report-binding-validator-unavailable": VALIDATOR_UNAVAILABLE,
  // an unexpected host fault inside each check.
  "candidate-staging-integrity-failed": HOST_FAULT,
  "evaluation-integrity-failed": HOST_FAULT,
  "technical-trace-integrity-failed": HOST_FAULT,
  "quality-score-integrity-failed": HOST_FAULT,
  "report-finalization-integrity-failed": HOST_FAULT,
  "report-binding-integrity-failed": HOST_FAULT,
  "final-report-staging-integrity-failed": HOST_FAULT,
  "binding-storage-integrity-failed": HOST_FAULT,
  // technical-trace.
  "technical-trace-malformed-candidate": TRACE_RULE,
  "technical-trace-missing-fact-id": TRACE_RULE,
  "technical-trace-missing-issue-id": TRACE_RULE,
  "technical-trace-missing-uncertainty": TRACE_RULE,
  "technical-trace-missing-source-locator": TRACE_RULE,
  "technical-trace-missing-inventory-limitation": TRACE_RULE,
  "technical-trace-missing-unverified-dimension-limitation": TRACE_RULE,
  // quality-score: the locked score validator.
  "quality-score-semantics": correctable(
    "The score validator named an issue with the score the table has no finer rule for; the generic score rule applies.",
  ),
  "quality-score-validator-refused": UNNAMED_REFUSAL,
  "score-not-object": SCORE_RULE,
  "score-field-missing": SCORE_RULE,
  "score-field-unsupported": SCORE_RULE,
  "score-rubric-unsupported": SCORE_RULE,
  "score-dimensions-not-object": SCORE_RULE,
  "score-dimension-missing": SCORE_RULE,
  "score-dimension-unsupported": SCORE_RULE,
  "score-dimension-not-number": SCORE_RULE,
  "score-dimension-out-of-range": SCORE_RULE,
  "score-total-out-of-range": SCORE_RULE,
  "score-total-sum-mismatch": SCORE_RULE,
  "score-hard-gates-not-object": SCORE_RULE,
  "score-hard-gate-missing": SCORE_RULE,
  "score-hard-gate-unsupported": SCORE_RULE,
  "score-hard-gate-count-invalid": SCORE_RULE,
  "score-decision-unsupported": SCORE_RULE,
  "score-hard-gate-requires-fail": SCORE_RULE,
  "score-pass-below-threshold": SCORE_RULE,
  "score-conditional-pass-not-allowed": SCORE_RULE,
  "score-confidence-out-of-range": SCORE_RULE,
  "score-rationale-empty": SCORE_RULE,
  "score-unreadable": HOST_BUILT,
  "score-invalid-json": HOST_BUILT,
  // report-binding: the locked report validator checks the host-finalized report.
  "report-binding-semantics": terminal(
    "The report validator checks a report the host finalized, so an unrecognised refusal cannot be attributed to the evaluator.",
  ),
  "report-binding-validator-refused": UNNAMED_REFUSAL,
  "report-input-unreadable": HOST_BUILT,
  "report-input-not-object": HOST_BUILT,
  "report-summary-block-count": correctable(
    "The evaluator's report must not write its own validated result summary heading; the host appends the one summary.",
  ),
  "report-summary-json-invalid": HOST_BUILT,
  "report-summary-not-object": HOST_BUILT,
  "report-summary-fields": HOST_BUILT,
  "report-validator-schema-invalid": HOST_FAULT,
  "report-summary-schema": HOST_BUILT,
  "report-evaluation-artifact-invalid": AFTER_LOCKED_VALIDATOR,
  "report-score-artifact-invalid": AFTER_LOCKED_VALIDATOR,
  "report-limitations-not-strings": HOST_BUILT,
  "report-limitations-unread": HOST_BUILT,
  "report-limitations-mismatch": terminal(
    "Report finalization already accepted every limitation row and built the summary from them, so a mismatch means the host and the report validator disagree.",
  ),
  "report-gap-evidence-not-array": HOST_BUILT,
  "report-profile-digest-missing": HOST_BUILT,
  "report-gap-evidence-mismatch": HOST_BUILT,
  "report-profile-policy-not-object": HOST_FAULT,
  "report-contract-unsupported": HOST_BUILT,
  "report-target-mismatch": HOST_BUILT,
  "report-profile-mismatch": HOST_BUILT,
  "report-evaluation-mismatch": HOST_BUILT,
  "report-validation-status": HOST_BUILT,
  "report-artifact-locators": HOST_BUILT,
  "report-rubric-mismatch": HOST_BUILT,
  "report-rubric-yaml-mismatch": HOST_BUILT,
  "report-rubric-threshold-invalid": HOST_FAULT,
  "report-rubric-weights-unreadable": HOST_FAULT,
  "report-rubric-unresolved": AFTER_LOCKED_VALIDATOR,
  // evaluation: the locked evaluation validator.
  "evaluation-validator-refused": UNNAMED_REFUSAL,
  "evaluation-input-unreadable": HOST_FAULT,
  "evaluation-pack-invalid": terminal(
    "The locked profile or schema the validator read is malformed; a broken quality pack never spends retries.",
  ),
  "evaluation-profile-semantics": correctable(
    "The evaluation validator named a profile rule the table has no finer rule for; the generic profile rule applies.",
  ),
  "evaluation-layer-residual-invalid": correctable(
    "An open layer must use the exact residual decision rule the host states for the locked profile.",
  ),
  "target-path-not-relative": EVALUATION_RULE,
  "target-path-not-posix": EVALUATION_RULE,
  "target-path-dot-segments": EVALUATION_RULE,
  "target-path-not-location": EVALUATION_RULE,
  "family-evidence-undeclared": EVALUATION_RULE,
  "family-evidence-repeated": EVALUATION_RULE,
  "family-evidence-path-unrelated": EVALUATION_RULE,
  "family-evidence-missing": EVALUATION_RULE,
  "family-path-mismatch": EVALUATION_RULE,
  "layer-dimension-repeated": EVALUATION_RULE,
  "layer-dimension-unknown": EVALUATION_RULE,
  "layer-dimension-missing": EVALUATION_RULE,
  "required-dimension-applicability": EVALUATION_RULE,
  "layer-decision-requires-met-dimension": EVALUATION_RULE,
  "layer-decision-requires-required-dimension": EVALUATION_RULE,
  "dimension-met-without-evidence": EVALUATION_RULE,
  "required-dimension-not-applicable": EVALUATION_RULE,
  "dimension-met-with-no-evidence": EVALUATION_RULE,
  "dimension-evidence-class-missing": EVALUATION_RULE,
  "layer-confidence-exceeds-dimensions": EVALUATION_RULE,
  "layer-confidence-no-required-dimensions": EVALUATION_RULE,
  "layer-confidence-below-dimensions": EVALUATION_RULE,
  "hard-gate-failures-not-unique": EVALUATION_RULE,
  "hard-gate-unknown": EVALUATION_RULE,
  "layer-hard-gate-requires-fail": EVALUATION_RULE,
  "layer-hard-gate-unknown": EVALUATION_RULE,
  "layer-hard-gate-not-top-level": EVALUATION_RULE,
  "hard-gate-requires-fail": EVALUATION_RULE,
  "constraint-dimension-mismatch": EVALUATION_RULE,
  "constraint-dimension-repeated": EVALUATION_RULE,
  "constraint-applicability": EVALUATION_RULE,
  "outcome-attempt-repeated": EVALUATION_RULE,
  "outcome-evidence-population-label": EVALUATION_RULE,
  "outcome-evidence-population-mismatch": EVALUATION_RULE,
  "failing-layer-requires-fail": EVALUATION_RULE,
  "experimental-profile-not-release-gate": EVALUATION_RULE,
  "pass-requires-independent-evaluator": EVALUATION_RULE,
  "conditional-pass-not-permitted": EVALUATION_RULE,
  "pass-requires-passing-layers": EVALUATION_RULE,
  "pass-requires-constraint-met": EVALUATION_RULE,
  "pass-requires-outcome-evidence": EVALUATION_RULE,
  "pass-rejects-unverified-outcomes": EVALUATION_RULE,
  "pass-requires-outcome-attempts": EVALUATION_RULE,
  "outcome-success-rate-below-required": EVALUATION_RULE,
  "overall-confidence-exceeds-dimensions": EVALUATION_RULE,
  "overall-confidence-no-required-dimensions": EVALUATION_RULE,
  "overall-confidence-below-dimensions": EVALUATION_RULE,
  "profile-id-mismatch": EVALUATION_RULE,
  "profile-version-mismatch": EVALUATION_RULE,
  "model-version-mismatch": EVALUATION_RULE,
  "finding-ids-not-unique": EVALUATION_RULE,
  "finding-dimension-unrecognized": EVALUATION_RULE,
  // evaluation-schema-<keyword>: the frozen evaluation schema.
  "evaluation-schema-const": EVALUATION_SCHEMA_RULE,
  "evaluation-schema-enum": EVALUATION_SCHEMA_RULE,
  "evaluation-schema-type": EVALUATION_SCHEMA_RULE,
  "evaluation-schema-required": EVALUATION_SCHEMA_RULE,
  "evaluation-schema-additional-properties": EVALUATION_SCHEMA_RULE,
  "evaluation-schema-min-items": EVALUATION_SCHEMA_RULE,
  "evaluation-schema-max-items": EVALUATION_SCHEMA_RULE,
  "evaluation-schema-unique-items": EVALUATION_SCHEMA_RULE,
  "evaluation-schema-min-length": EVALUATION_SCHEMA_RULE,
  "evaluation-schema-max-length": EVALUATION_SCHEMA_RULE,
  "evaluation-schema-pattern": EVALUATION_SCHEMA_RULE,
  "evaluation-schema-format": EVALUATION_SCHEMA_RULE,
  "evaluation-schema-minimum": EVALUATION_SCHEMA_RULE,
  "evaluation-schema-maximum": EVALUATION_SCHEMA_RULE,
  "evaluation-schema-exclusive-minimum": EVALUATION_SCHEMA_RULE,
} as const satisfies Record<QualityRejectionCode, QualityRejectionRetryabilityEntry>);

/** Codes the table lets a bounded retry repair. */
export type ModelCorrectableQualityRejection = {
  [Code in QualityRejectionCode]: (typeof QUALITY_REJECTION_RETRYABILITY)[Code]["retry"] extends "model-correctable"
    ? Code
    : never;
}[QualityRejectionCode];

/**
 * Whether the table marks a code as refusing a value the host built or
 * supplied, so its refusal is a DocsFab defect rather than the evaluator's.
 * A code outside the table is not.
 */
export function isHostBuiltQualityRejection(code: string): boolean {
  return (
    Object.hasOwn(QUALITY_REJECTION_RETRYABILITY, code) &&
    QUALITY_REJECTION_RETRYABILITY[code as QualityRejectionCode] === HOST_BUILT
  );
}

/**
 * A code outside the table, such as the retained grammar's placeholder, is
 * terminal: the host cannot state a rule for a code it does not know.
 */
export function isModelCorrectableQualityRejection(code: string): boolean {
  return (
    Object.hasOwn(QUALITY_REJECTION_RETRYABILITY, code) &&
    QUALITY_REJECTION_RETRYABILITY[code as QualityRejectionCode].retry === "model-correctable"
  );
}
