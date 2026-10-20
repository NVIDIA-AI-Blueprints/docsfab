// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Retry rule hints for the final quality evaluator's artifact, the envelope
 * `{ evaluation, qualityScore, reportMarkdown }`. A check's location is
 * relative to the artifact it reads, so every rule names its envelope member.
 *
 * Only codes `quality-rejection-retryability.ts` makes model-correctable reach
 * a retry, and each needs a rule here (see
 * `EVERY_CORRECTABLE_QUALITY_REJECTION_HAS_A_RULE`).
 *
 * Every rule is a fixed host-authored sentence. None repeats a validator
 * diagnostic, a rejected value, or any other model or validator text. Change a
 * hint with the rule it explains.
 */

import type { StagedQualitySchemaMismatchKeyword } from "../evaluation-report/quality-schema-validation.js";
import type { CorrectableCodeOf, OUTPUT_RULES } from "../contracts/model-output.generated.js";
import {
  everywhere,
  type RejectionRuleHint,
  type RejectionRuleHintCatalog,
} from "./rejection-rule-hints.js";
import type { ModelCorrectableQualityRejection } from "./quality-rejection-retryability.js";

const LIMITATION_SECTION =
  'The reportMarkdown must contain exactly one "## Evidence gaps and limitations" section. Write each limitation once as "- Limitation: <text>" or "- Evidence gap: <text>"; when its text contains a line break or control character, use "- Limitation (JSON):" followed by the JSON string encoding of the complete limitation instead. Do not add other prose to the section or add leading/trailing whitespace to a limitation. The host validates the complete text without a per-limitation character ceiling.';

const QUALITY_CANDIDATE_RULES = Object.freeze({
  "candidate-report-invalid":
    "reportMarkdown must be a non-empty Markdown report within the host's size bound. Condense it rather than dropping a required section.",
  "candidate-evaluation-shape":
    "evaluation must be a JSON object. Keep evaluation.target as an object with its model-authored evidence; the host writes the profile and target metadata.",
  "candidate-quality-score-shape":
    "qualityScore must be a JSON object that follows the locked quality score schema, or null when no rubric is supported by the target evidence.",
  "report-summary-repeated":
    'Do not write a "## Validated result summary" section in reportMarkdown. The host writes the one validated result summary after validation.',
  "report-summary-block-count":
    'Do not write a "## Validated result summary" heading or JSON summary block in reportMarkdown. The host appends exactly one after validation.',
  "report-limitation-section-count": LIMITATION_SECTION,
  "report-limitation-row-ambiguous": LIMITATION_SECTION,
  "report-limitation-value-invalid": LIMITATION_SECTION,
  "report-limitation-duplicate": LIMITATION_SECTION,
} as const satisfies Partial<Record<ModelCorrectableQualityRejection, string>>);

/**
 * Rules for the technical trace, which requires the final evaluation to carry
 * every material fact from the admitted technical verification result.
 */
const TECHNICAL_TRACE_RULES = Object.freeze({
  "technical-trace-malformed-candidate":
    "evaluation.findings and evaluation.limitations must be arrays, and every finding must be a JSON object.",
  "technical-trace-missing-fact-id":
    "Every fact the admitted technical verification result lists as not documented must be named by its fact id in at least one evaluation finding: in its id, description, acceptance_condition, resolution, dismissal_rationale, or an evidence locator or description.",
  "technical-trace-missing-issue-id":
    "The finding that names a not-documented technical fact must also name every issue id that fact lists in its issueIds.",
  "technical-trace-missing-uncertainty":
    "The finding that names a not-documented technical fact and its issue ids must also contain that fact's uncertainty text exactly, character for character.",
  "technical-trace-missing-source-locator":
    "The finding that names a not-documented technical fact, its issue ids, and its uncertainty must also cite every source locator that fact lists, exactly, as an evidence[].locator or verification_evidence[].locator value. Separate several locators in one locator field with semicolons. Keep every other field.",
  "technical-trace-missing-inventory-limitation":
    "evaluation.limitations must contain every limitation of the admitted technical fact inventory, character for character.",
  "technical-trace-missing-unverified-dimension-limitation":
    "For each technical dimension the admitted fact inventory marks unverified, evaluation.limitations must contain an entry that names the dimension id and contains its reason exactly.",
} as const satisfies Partial<Record<ModelCorrectableQualityRejection, string>>);

const QUALITY_SCORE_RULES = Object.freeze({
  "quality-score-semantics":
    "qualityScore broke a rule of the locked quality score schema or its rubric. Match its declared fields, types, ranges, and decision rules exactly, or set qualityScore to null when no rubric is supported by the target evidence.",
  "score-not-object": "qualityScore must be a JSON object, or null.",
  "score-field-missing":
    "qualityScore must have exactly rubric, scores, total, hard_gates, decision, confidence, and rationale.",
  "score-field-unsupported":
    "qualityScore must have exactly rubric, scores, total, hard_gates, decision, confidence, and rationale, and no other field.",
  "score-rubric-unsupported":
    "qualityScore.rubric must be the id of one of the installed rubrics the evaluator contract supplies, spelled exactly; otherwise set qualityScore to null.",
  "score-dimensions-not-object":
    "qualityScore.scores must be an object keyed by the selected rubric's dimensions.",
  "score-dimension-missing":
    "qualityScore.scores must have exactly one entry for each dimension the selected rubric defines.",
  "score-dimension-unsupported":
    "qualityScore.scores must contain only the dimensions the selected rubric defines.",
  "score-dimension-not-number": "Each qualityScore.scores value must be a finite number.",
  "score-dimension-out-of-range":
    "Each qualityScore.scores value must be at least zero and at most the maximum the selected rubric sets for that dimension.",
  "score-total-out-of-range": "qualityScore.total must be a number from 0 through 100.",
  "score-total-sum-mismatch":
    "qualityScore.total must equal the sum of the qualityScore.scores values exactly.",
  "score-hard-gates-not-object":
    "qualityScore.hard_gates must be an object with one count for each hard gate the score schema lists.",
  "score-hard-gate-missing":
    "qualityScore.hard_gates must have exactly one count for each hard gate the score schema lists.",
  "score-hard-gate-unsupported":
    "qualityScore.hard_gates must contain only the hard gates the score schema lists.",
  "score-hard-gate-count-invalid":
    "Each qualityScore.hard_gates value must be a nonnegative integer count.",
  "score-decision-unsupported":
    'qualityScore.decision must be exactly "pass", "conditional-pass", "fail", or "human-review".',
  "score-hard-gate-requires-fail":
    'Any nonzero qualityScore.hard_gates count requires qualityScore.decision "fail".',
  "score-pass-below-threshold":
    'qualityScore.decision "pass" requires qualityScore.total to reach the selected rubric\'s pass threshold. Choose the decision the total supports.',
  "score-conditional-pass-not-allowed":
    'The selected rubric does not allow qualityScore.decision "conditional-pass". Choose a decision the rubric allows.',
  "score-confidence-out-of-range": "qualityScore.confidence must be a number from 0 through 1.",
  "score-rationale-empty": "qualityScore.rationale must be a non-empty string.",
} as const satisfies Partial<Record<ModelCorrectableQualityRejection, string>>);

const LAYER_DIMENSIONS =
  "Each evaluation.layers entry must list each dimension the locked profile assigns to that layer exactly once, and only those dimensions.";
const PASS_DECISION =
  "Choose the overall_decision the evidence and the selected profile support, such as insufficient-evidence or fail.";

const EVALUATION_RULES = Object.freeze({
  "evaluation-profile-semantics":
    "evaluation broke a rule of the selected profile. Check every layer, dimension, hard gate, constraint, outcome, confidence, and decision rule in the locked profile and layered evaluation reference.",
  "target-path-not-relative":
    "Every path in evaluation.target must be repository-relative, never absolute.",
  "target-path-not-posix": "Every path in evaluation.target must use forward slashes.",
  "target-path-dot-segments":
    "Every path in evaluation.target must not contain empty, '.', or '..' segments.",
  "target-path-not-location":
    "Every path in evaluation.target must name a repository location, not the repository root.",
  "family-evidence-undeclared":
    "Every evaluation.target.documentation_family_evidence entry must name a family listed in evaluation.target.documentation_families.",
  "family-evidence-repeated":
    "evaluation.target.documentation_family_evidence must name each family at most once.",
  "family-evidence-path-unrelated":
    "Every documentation family evidence path must equal, contain, or lie under one of evaluation.target.paths.",
  "family-evidence-missing":
    "Every family in evaluation.target.documentation_families needs one evaluation.target.documentation_family_evidence entry.",
  "family-path-mismatch":
    "A target path under a family's path prefix in the locked profile must list that family in evaluation.target.documentation_families.",
  "layer-dimension-repeated": LAYER_DIMENSIONS,
  "layer-dimension-unknown": LAYER_DIMENSIONS,
  "layer-dimension-missing": `${LAYER_DIMENSIONS} Every required dimension must be present.`,
  "required-dimension-applicability":
    'Every required dimension must set applicability to exactly "required".',
  "layer-decision-requires-met-dimension":
    'A layer decision of "pass" or "conditional-pass" requires every required dimension in that layer to be assessed "met". Otherwise lower the layer decision.',
  "layer-decision-requires-required-dimension":
    'Under the locked profile rules, an empty required-dimension set yields the profile\'s missing-evidence decision (currently "insufficient-evidence"); a hard-gate failure still yields "fail". Preserve "fail" only for an actual hard-gate failure, and otherwise use the profile\'s missing-evidence decision.',
  "dimension-met-without-evidence":
    'A dimension assessed "met" must cite at least one evidence entry.',
  "required-dimension-not-applicable": 'A required dimension cannot be assessed "not-applicable".',
  "dimension-met-with-no-evidence":
    'A dimension assessed "met" cannot cite evidence with strength "none". Cite real evidence or change the assessment.',
  "dimension-evidence-class-missing":
    'A dimension assessed "met" must cite evidence of the minimum evidence class the locked profile\'s evidence policy sets for it. Otherwise change the assessment.',
  "layer-confidence-exceeds-dimensions":
    "Each evaluation.layers entry's confidence must equal the lowest confidence among that layer's required dimensions, or 0 when none are required. Do not raise a dimension's confidence beyond its evidence.",
  "layer-confidence-no-required-dimensions":
    "Each evaluation.layers entry's confidence must equal the lowest confidence among that layer's required dimensions, or 0 when none are required. Do not raise a dimension's confidence beyond its evidence.",
  "layer-confidence-below-dimensions":
    "Each evaluation.layers entry's confidence must equal the lowest confidence among that layer's required dimensions, or 0 when none are required. Do not raise a dimension's confidence beyond its evidence.",
  "hard-gate-failures-not-unique": "evaluation.hard_gate_failures must list each gate once.",
  "hard-gate-unknown":
    "evaluation.hard_gate_failures must contain only hard gates the locked profile lists, spelled exactly.",
  "layer-hard-gate-requires-fail":
    'A layer with any hard_gate_failures must have layer decision "fail".',
  "layer-hard-gate-unknown":
    "Each layer's hard_gate_failures must contain only hard gates the locked profile lists, spelled exactly.",
  "layer-hard-gate-not-top-level":
    "Every hard gate a layer lists in its hard_gate_failures must also appear in evaluation.hard_gate_failures.",
  "hard-gate-requires-fail":
    'A nonempty evaluation.hard_gate_failures requires overall_decision "fail".',
  "constraint-dimension-mismatch":
    "Each evaluation.constraints entry must set dimension_id to the constraint id the locked profile assigns to that key.",
  "constraint-dimension-repeated":
    "evaluation.constraints must use each dimension_id under one key only.",
  "constraint-applicability":
    'Every constraint the locked profile requires must set applicability to exactly "required".',
  "outcome-attempt-repeated":
    "Each outcome attempt_id must be unique across evaluation.outcomes.human and evaluation.outcomes.agent.",
  "outcome-evidence-population-label":
    "Outcome-evaluation evidence under evaluation.outcomes must be labeled with the population of the list that contains it.",
  "outcome-evidence-population-mismatch":
    "Evidence under evaluation.outcomes may name only the population of the list that contains it.",
  "failing-layer-requires-fail": 'Any layer decision "fail" requires overall_decision "fail".',
  "experimental-profile-not-release-gate": `The selected profile is experimental and not release-gate eligible, so overall_decision cannot be "pass" or "conditional-pass". ${PASS_DECISION}`,
  "pass-requires-independent-evaluator": `overall_decision "pass" or "conditional-pass" requires an evaluator independent of the authors. ${PASS_DECISION}`,
  "conditional-pass-not-permitted": `The selected profile does not permit overall_decision "conditional-pass". ${PASS_DECISION}`,
  "pass-requires-passing-layers": `overall_decision "pass" or "conditional-pass" requires every layer decision to be "pass". ${PASS_DECISION}`,
  "pass-requires-constraint-met": `overall_decision "pass" or "conditional-pass" requires every required constraint to be assessed "met". ${PASS_DECISION}`,
  "pass-requires-outcome-evidence": `overall_decision "pass" or "conditional-pass" requires outcome evidence for each required population. ${PASS_DECISION}`,
  "pass-rejects-unverified-outcomes": `overall_decision "pass" or "conditional-pass" cannot rely on unverified outcome attempts. ${PASS_DECISION}`,
  "pass-requires-outcome-attempts": `overall_decision "pass" or "conditional-pass" requires the minimum number of verified outcome attempts the profile sets for each population. ${PASS_DECISION}`,
  "outcome-success-rate-below-required": `overall_decision "pass" or "conditional-pass" requires the verified outcome success rate the profile sets. ${PASS_DECISION}`,
  "overall-confidence-exceeds-dimensions":
    "evaluation.confidence must equal the lowest confidence among all required dimensions, or 0 when none are required.",
  "overall-confidence-no-required-dimensions":
    "evaluation.confidence must equal the lowest confidence among all required dimensions, or 0 when none are required.",
  "overall-confidence-below-dimensions":
    "evaluation.confidence must equal the lowest confidence among all required dimensions, or 0 when none are required.",
  "profile-id-mismatch":
    "evaluation.profile.id must equal the selected profile's id exactly, as the locked profile states it.",
  "profile-version-mismatch":
    "evaluation.profile.version must equal the selected profile's version exactly, as the locked profile states it.",
  "model-version-mismatch":
    "evaluation.model_version must equal the selected profile's model exactly, as the locked profile states it.",
  "finding-ids-not-unique": "Every evaluation.findings id must be unique.",
  "finding-dimension-unrecognized":
    "Each evaluation.findings dimension_id must name a dimension in the selected profile or a constraint in evaluation.constraints.",
} as const satisfies Partial<Record<ModelCorrectableQualityRejection, string>>);

/**
 * Rules for the evaluation schema keywords the frozen-schema validator names,
 * recorded as `evaluation-schema-<keyword>` at a location in `evaluation`.
 */
export const EVALUATION_SCHEMA_KEYWORD_RULES = Object.freeze({
  const:
    "The evaluation value at this location must equal the one value the locked evaluation schema fixes there.",
  enum: "The evaluation value at this location must be one of the values the locked evaluation schema allows there, spelled exactly.",
  type: "The evaluation value at this location has the wrong JSON type for the locked evaluation schema, such as a string where an object or array is required.",
  required:
    "A key the locked evaluation schema requires is missing at this location. Add it with a valid value.",
  "additional-properties":
    "The evaluation object at this location has a key the locked evaluation schema does not declare. Remove it.",
  "min-items":
    "The evaluation array at this location has fewer entries than the locked evaluation schema requires.",
  "max-items":
    "The evaluation array at this location has more entries than the locked evaluation schema allows. Merge or condense entries without dropping a required one.",
  "unique-items": "The evaluation array at this location repeats an entry. Keep each entry once.",
  "min-length":
    "The evaluation string at this location is empty or shorter than the locked evaluation schema allows.",
  "max-length":
    "The evaluation string at this location is longer than the locked evaluation schema allows. Condense it.",
  pattern:
    "The evaluation string at this location does not match the format the locked evaluation schema requires.",
  format:
    "The evaluation string at this location does not match its required format, such as an RFC 3339 date-time.",
  minimum:
    "The evaluation number at this location is below the minimum the locked evaluation schema allows.",
  maximum:
    "The evaluation number at this location is above the maximum the locked evaluation schema allows.",
  "exclusive-minimum":
    "The evaluation number at this location must be greater than the minimum the locked evaluation schema sets.",
} as const satisfies Record<StagedQualitySchemaMismatchKeyword, string>);

function prefixed(
  prefix: string,
  rules: Readonly<Record<string, string>>,
): Record<string, RejectionRuleHint> {
  return Object.fromEntries(
    Object.entries(rules).map(([code, rule]) => [`${prefix}${code}`, everywhere(rule)]),
  );
}

export const QUALITY_RESPONSE_RULE_HINTS: RejectionRuleHintCatalog = Object.freeze({
  ...prefixed("", QUALITY_CANDIDATE_RULES),
  ...prefixed("", TECHNICAL_TRACE_RULES),
  ...prefixed("", QUALITY_SCORE_RULES),
  ...prefixed("", EVALUATION_RULES),
  ...prefixed("evaluation-schema-", EVALUATION_SCHEMA_KEYWORD_RULES),
});

type QualityEnvelopeCodesWithCatalogHints = {
  [Code in CorrectableCodeOf<"quality-envelope">]: (typeof OUTPUT_RULES)[Code]["statement"] extends string
    ? Code
    : never;
}[CorrectableCodeOf<"quality-envelope">];

type HintedQualityRejection =
  | keyof typeof QUALITY_CANDIDATE_RULES
  | keyof typeof TECHNICAL_TRACE_RULES
  | keyof typeof QUALITY_SCORE_RULES
  | keyof typeof EVALUATION_RULES
  | `evaluation-schema-${keyof typeof EVALUATION_SCHEMA_KEYWORD_RULES}`
  | QualityEnvelopeCodesWithCatalogHints;

/** Fails to typecheck while a model-correctable code has no rule above. */
export const EVERY_CORRECTABLE_QUALITY_REJECTION_HAS_A_RULE: [
  Exclude<ModelCorrectableQualityRejection, HintedQualityRejection>,
] extends [never]
  ? true
  : never = true;
