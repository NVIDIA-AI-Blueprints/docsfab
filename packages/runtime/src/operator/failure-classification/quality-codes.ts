// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Quality validation and artifact code classes. */
import { composeTables, familyClass } from "./inference-codes.js";

import { type QualityCheckRejectionCode } from "../../evaluation-report/quality-check-rejections.js";
import type { EvaluationDiagnosticCode } from "../../evaluation-report/quality-validation-rejection.js";

import type { QualityArtifactValidationBindingV1 } from "../../records/contracts.js";

import { isFailureCode, type FailureClass } from "../failure-class.js";

/**
 * A locked validator that exited without listing an issue. The receipt does not
 * say whether it refused, crashed, or was killed at a limit, so: `unknown`.
 */
const VALIDATOR_REFUSED_CLASS = "unknown" as const satisfies FailureClass;

/**
 * The locked evaluation validator's inner codes. Its semantic diagnostics are
 * rules on the evaluator's content; schema keywords resolve by family.
 */
const EVALUATION_DIAGNOSTIC_FAILURE_CLASSES = {
  "evaluation-validator-refused": VALIDATOR_REFUSED_CLASS,
  "evaluation-profile-semantics": "model-content",
  "evaluation-input-unreadable": "infrastructure",
  "evaluation-pack-invalid": "contract-shape",
  "target-path-not-relative": "model-content",
  "target-path-not-posix": "model-content",
  "target-path-dot-segments": "model-content",
  "target-path-not-location": "model-content",
  "family-evidence-undeclared": "model-content",
  "family-evidence-repeated": "model-content",
  "family-evidence-path-unrelated": "model-content",
  "family-evidence-missing": "model-content",
  "family-path-mismatch": "model-content",
  "layer-dimension-repeated": "model-content",
  "layer-dimension-unknown": "model-content",
  "layer-dimension-missing": "model-content",
  "required-dimension-applicability": "model-content",
  "layer-decision-requires-met-dimension": "model-content",
  "layer-decision-requires-required-dimension": "model-content",
  "dimension-met-without-evidence": "model-content",
  "required-dimension-not-applicable": "model-content",
  "dimension-met-with-no-evidence": "model-content",
  "dimension-evidence-class-missing": "model-content",
  "layer-confidence-exceeds-dimensions": "model-content",
  "layer-confidence-no-required-dimensions": "model-content",
  "layer-confidence-below-dimensions": "model-content",
  "hard-gate-failures-not-unique": "model-content",
  "hard-gate-unknown": "model-content",
  "layer-hard-gate-requires-fail": "model-content",
  "layer-hard-gate-unknown": "model-content",
  "layer-hard-gate-not-top-level": "model-content",
  "hard-gate-requires-fail": "model-content",
  "constraint-dimension-mismatch": "model-content",
  "constraint-dimension-repeated": "model-content",
  "constraint-applicability": "model-content",
  "outcome-attempt-repeated": "model-content",
  "outcome-evidence-population-label": "model-content",
  "outcome-evidence-population-mismatch": "model-content",
  "failing-layer-requires-fail": "model-content",
  "experimental-profile-not-release-gate": "model-content",
  "pass-requires-independent-evaluator": "model-content",
  "conditional-pass-not-permitted": "model-content",
  "pass-requires-passing-layers": "model-content",
  "pass-requires-constraint-met": "model-content",
  "pass-requires-outcome-evidence": "model-content",
  "pass-rejects-unverified-outcomes": "model-content",
  "pass-requires-outcome-attempts": "model-content",
  "outcome-success-rate-below-required": "model-content",
  "overall-confidence-exceeds-dimensions": "model-content",
  "overall-confidence-no-required-dimensions": "model-content",
  "overall-confidence-below-dimensions": "model-content",
  "profile-id-mismatch": "model-content",
  "profile-version-mismatch": "model-content",
  "model-version-mismatch": "model-content",
  "finding-ids-not-unique": "model-content",
  "finding-dimension-unrecognized": "model-content",
} as const satisfies Record<EvaluationDiagnosticCode, FailureClass>;

/**
 * Every other quality-path code, grouped by the check that raises it.
 *
 * - Evaluator-authored values (evaluation, score, report Markdown): a host rule
 *   break is `model-content`; a wrong type or field set is `contract-shape`.
 * - A refusal of host-authored values, of an artifact an earlier check
 *   admitted, or of a verified locked asset that disagrees with another is a
 *   producer-side binding defect: `contract-shape`.
 * - Store faults, changed locked bytes, missing or unstartable validators, and
 *   `<check>-integrity-failed` host faults are `infrastructure`.
 * - A non-private validator workspace sits beside the operator's state
 *   directory, so it is `operator-input`.
 * - A code covering several causes is `unknown`.
 */
const QUALITY_CHECK_FAILURE_CLASSES = {
  // candidate-admission: the runner's guards before the validator host runs.
  "quality-technical-verification-unadmitted": "contract-shape",
  "quality-candidate-missing": "contract-shape",
  "quality-evaluator-identity-unbound": "contract-shape",
  "quality-technical-verification-changed": "contract-shape",
  // candidate-staging
  "candidate-not-inert": "contract-shape",
  "candidate-credential-material": "model-content",
  "candidate-envelope-shape": "contract-shape",
  "candidate-report-invalid": "contract-shape",
  "candidate-selection-mismatch": "contract-shape",
  "candidate-host-binding-mismatch": "contract-shape",
  "candidate-evaluation-shape": "contract-shape",
  "candidate-profile-mismatch": "model-content",
  "candidate-model-version-mismatch": "model-content",
  "candidate-scope-type-invalid": "model-content",
  "candidate-revision-mismatch": "model-content",
  // The host writes evaluation.target.paths, so these refuse a host value.
  "candidate-target-paths-invalid": "contract-shape",
  "candidate-target-outside-scope": "contract-shape",
  "candidate-quality-score-shape": "contract-shape",
  "candidate-artifact-unstored": "infrastructure",
  "staged-artifact-unreadable": "infrastructure",
  // report-finalization: the host writes the summary; the limitation section is the evaluator's.
  "report-candidate-not-text": "contract-shape",
  "report-summary-repeated": "model-content",
  "report-profile-bytes-changed": "infrastructure",
  "report-profile-identity-mismatch": "contract-shape",
  "report-limitation-section-count": "model-content",
  "report-limitation-row-ambiguous": "model-content",
  "report-limitation-value-invalid": "model-content",
  "report-limitation-duplicate": "model-content",
  "report-rubric-id-invalid": "contract-shape",
  "report-rubric-not-locked": "contract-shape",
  "report-rubric-bytes-changed": "infrastructure",
  "report-rubric-metadata-inconsistent": "contract-shape",
  "report-score-total-invalid": "contract-shape",
  "report-artifact-not-object": "contract-shape",
  // final-report-staging and binding-storage
  "final-report-invalid": "contract-shape",
  "final-report-unstored": "infrastructure",
  "validation-binding-unstored": "infrastructure",
  // the host's guards around the three locked validators
  "validator-workspace-not-private": "operator-input",
  "validator-lock-entry-missing": "infrastructure",
  "validator-input-not-regular": "infrastructure",
  "validator-input-digest-changed": "infrastructure",
  "evaluation-validator-unavailable": "infrastructure",
  "quality-score-validator-unavailable": "infrastructure",
  "report-binding-validator-unavailable": "infrastructure",
  // an unexpected host fault inside each check
  "candidate-staging-integrity-failed": "infrastructure",
  "evaluation-integrity-failed": "infrastructure",
  "technical-trace-integrity-failed": "infrastructure",
  "quality-score-integrity-failed": "infrastructure",
  "report-finalization-integrity-failed": "infrastructure",
  "report-binding-integrity-failed": "infrastructure",
  "final-report-staging-integrity-failed": "infrastructure",
  "binding-storage-integrity-failed": "infrastructure",
  // technical-trace: the evaluation against the admitted fact trace
  "technical-trace-malformed-candidate": "contract-shape",
  "technical-trace-missing-fact-id": "model-content",
  "technical-trace-missing-issue-id": "model-content",
  "technical-trace-missing-uncertainty": "model-content",
  "technical-trace-missing-source-locator": "model-content",
  "technical-trace-missing-inventory-limitation": "model-content",
  "technical-trace-missing-unverified-dimension-limitation": "model-content",
  // quality-score: an unrecognised diagnostic is semantic.
  "quality-score-semantics": "model-content",
  "quality-score-validator-refused": VALIDATOR_REFUSED_CLASS,
  "score-not-object": "contract-shape",
  "score-field-missing": "contract-shape",
  "score-field-unsupported": "contract-shape",
  "score-rubric-unsupported": "model-content",
  "score-dimensions-not-object": "contract-shape",
  "score-dimension-missing": "contract-shape",
  "score-dimension-unsupported": "contract-shape",
  "score-dimension-not-number": "contract-shape",
  "score-dimension-out-of-range": "model-content",
  "score-total-out-of-range": "model-content",
  "score-total-sum-mismatch": "model-content",
  "score-hard-gates-not-object": "contract-shape",
  "score-hard-gate-missing": "contract-shape",
  "score-hard-gate-unsupported": "contract-shape",
  "score-hard-gate-count-invalid": "contract-shape",
  "score-decision-unsupported": "model-content",
  "score-hard-gate-requires-fail": "model-content",
  "score-pass-below-threshold": "model-content",
  "score-conditional-pass-not-allowed": "model-content",
  "score-confidence-out-of-range": "model-content",
  "score-rationale-empty": "model-content",
  "score-unreadable": "infrastructure",
  "score-invalid-json": "contract-shape",
  // report-binding: an unrecognised diagnostic may be the host's summary or the
  // evaluator's Markdown, so it names no one cause.
  "report-binding-semantics": "unknown",
  "report-binding-validator-refused": VALIDATOR_REFUSED_CLASS,
  // "unable to read" (a file system fault) or "invalid JSON" (a host binding defect).
  "report-input-unreadable": "unknown",
  "report-input-not-object": "contract-shape",
  // The host writes one block; the evaluator's Markdown can add a look-alike heading.
  "report-summary-block-count": "unknown",
  "report-summary-json-invalid": "contract-shape",
  "report-summary-not-object": "contract-shape",
  "report-summary-fields": "contract-shape",
  "report-validator-schema-invalid": "contract-shape",
  "report-summary-schema": "contract-shape",
  "report-evaluation-artifact-invalid": "contract-shape",
  "report-score-artifact-invalid": "contract-shape",
  "report-limitations-not-strings": "contract-shape",
  "report-limitations-unread": "contract-shape",
  "report-limitations-mismatch": "contract-shape",
  "report-gap-evidence-not-array": "contract-shape",
  "report-profile-digest-missing": "contract-shape",
  "report-gap-evidence-mismatch": "contract-shape",
  "report-profile-policy-not-object": "contract-shape",
  "report-contract-unsupported": "contract-shape",
  "report-target-mismatch": "contract-shape",
  "report-profile-mismatch": "contract-shape",
  "report-evaluation-mismatch": "contract-shape",
  "report-validation-status": "contract-shape",
  "report-artifact-locators": "contract-shape",
  "report-rubric-mismatch": "contract-shape",
  "report-rubric-yaml-mismatch": "contract-shape",
  "report-rubric-threshold-invalid": "contract-shape",
  "report-rubric-weights-unreadable": "contract-shape",
  "report-rubric-unresolved": "contract-shape",
} as const satisfies Record<QualityCheckRejectionCode, FailureClass>;

/** Every quality-path inner code and its class. */
export const QUALITY_VALIDATION_REJECTION_FAILURE_CLASSES: Readonly<Record<string, FailureClass>> =
  composeTables(EVALUATION_DIAGNOSTIC_FAILURE_CLASSES, QUALITY_CHECK_FAILURE_CLASSES);

/** The class a quality-path inner code maps to, or `undefined` outside every table. */
export function qualityRejectionFailureClass(code: string): FailureClass | undefined {
  if (!isFailureCode(code)) return undefined;
  return Object.hasOwn(QUALITY_VALIDATION_REJECTION_FAILURE_CLASSES, code)
    ? QUALITY_VALIDATION_REJECTION_FAILURE_CLASSES[code]
    : familyClass(code);
}

/** The quality artifact binding's outer failure codes. */
export const QUALITY_ARTIFACT_FAILURE_CLASSES = Object.freeze({
  "candidate-invalid": "contract-shape",
  "target-scope-mismatch": "contract-shape",
  "evaluation-invalid": "model-content",
  "quality-score-invalid": "contract-shape",
  "report-binding-invalid": "contract-shape",
  "validator-unavailable": "infrastructure",
  "validator-integrity-invalid": "infrastructure",
  "artifact-integrity-invalid": "contract-shape",
  "technical-trace-incomplete": "model-content",
} as const satisfies Record<
  NonNullable<QualityArtifactValidationBindingV1["failureCode"]>,
  FailureClass
>);
