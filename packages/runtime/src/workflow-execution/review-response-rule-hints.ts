// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Retry rule hints for the technical review and correction decoders
 * (`review-response.ts`, and the correction binders in `source-obligation.ts`
 * that raise `TechnicalReviewRejectionCode`s).
 *
 * Families are keyed by the closed union that produces them, so a new member
 * does not typecheck without a rule: `inventory-<detail>` at `$.factInventory`,
 * `json-<detail>` and `json-<code>` at `$response`, and the outer codes. Codes
 * shared with the source-obligation vocabulary are defined there, in wording
 * true for both decoders. `review-schema-<keyword>` and
 * `review-issue-location-unsafe` are also covered.
 *
 * `technical-rejection-retryability.ts` decides which codes a retry can reach,
 * and `EVERY_CORRECTABLE_TECHNICAL_REASON_HAS_A_RULE` requires a rule for each.
 * A code without a rule still reaches a retry named, with its location,
 * through the generic fallback. Vocabulary rules restate the allowed values,
 * never the rejected value.
 *
 * Change a hint with the validator rule it explains. The text is host-authored
 * and never includes response content; see `rejection-rule-hints.ts`.
 */

import {
  JSON_EVIDENCE_ERROR_RULES,
  JSON_EVIDENCE_SYNTAX_RULES,
  everywhere,
  type RejectionRuleHint,
  type RejectionRuleHintCatalog,
} from "./rejection-rule-hints.js";
import {
  APPLICABLE_DIMENSION_JUDGMENT_RULE,
  DIMENSION_DEMOTION_REJECTIONS,
  ISSUE_JUDGMENT_VOCABULARY_REJECTIONS,
  JUDGMENT_VERDICT_RULE,
  OBLIGATION_REJECTION_CODES,
  REVIEW_CATEGORIES,
  REVIEW_SEVERITIES,
  SOURCE_LOCATOR_RULE,
  UNKNOWN_OBLIGATION_LINK_REJECTION,
  VERDICT_CONSISTENCY_RULE,
  type InventoryFailureDetail,
  type TechnicalReviewRejectionCode,
} from "./review-response.js";
import type { SOURCE_OBLIGATION_RULE_HINTS } from "./source-obligation-rule-hints.js";
import type {
  FactLinkRejectionCode,
  ModelCorrectableTechnicalReason,
} from "./technical-rejection-retryability.js";
import type { StagedQualitySchemaMismatchKeyword } from "../evaluation-report/quality-schema-validation.js";

/** One per `InventoryFailureDetail`, recorded as `inventory-<detail>`. */
export const FACT_INVENTORY_RULE_HINTS = Object.freeze({
  shape: "factInventory must be an object with exactly completeness, dimensions, and limitations.",
  completeness: 'Set factInventory.completeness to exactly "bounded-not-proven".',
  "dimension-shape":
    "The previous factInventory dimension had the wrong fields. Each dimension must have exactly dimension, status, reason, sourceLocators, and facts. Use facts here, not the inventory-only obligations field. Follow the host verification contract for each fact.",
  "dimension-count":
    "factInventory.dimensions must contain exactly one entry for each required technical dimension, no more and no fewer.",
  "dimension-reason":
    "Each dimension reason must be a substantive explanation within the contract's length bounds, with no leading or trailing whitespace.",
  "dimension-identity":
    "Each dimension must name one of the required technical dimensions, spelled exactly, and each may appear only once.",
  "dimension-status":
    'Each dimension status must be exactly "applicable", "not-applicable", or "unverified".',
  // A judgment reply carries no factInventory; the host builds it from
  // obligationJudgments, so the rule is stated in both reply forms.
  "dimension-facts": `An "applicable" dimension needs at least one fact. A "not-applicable" or "unverified" dimension must set facts to []. In a judgment reply: ${APPLICABLE_DIMENSION_JUDGMENT_RULE}`,
  "dimension-locators": `An "applicable" dimension must set its own sourceLocators to [] and cite sources on each fact. A "not-applicable" dimension needs at least one dimension-level source locator. Locators must be distinct. ${SOURCE_LOCATOR_RULE}`,
  "limitation-link":
    'An "unverified" dimension\'s reason must exactly equal one entry of factInventory.limitations, character for character. Add the reason to limitations verbatim, or copy an existing limitation into reason.',
  "fact-identity":
    "Each fact id must be unique across the inventory and start with an uppercase letter followed by uppercase letters, digits, hyphens, or underscores.",
  "fact-shape":
    "Each fact must have exactly id, dimension, sourceLocators, statement, documentationDisposition, uncertainty, and issueIds.",
  "fact-text":
    "Each fact statement and uncertainty must be non-empty, within the contract's length bounds, and free of leading or trailing whitespace. A statement must be a substantive sentence.",
  "fact-dimension": "Each fact's dimension must equal the dimension of the entry that contains it.",
  "fact-locators": `Each fact needs at least one source locator, and its locators must be distinct. ${SOURCE_LOCATOR_RULE} Replace each such locator with the specific lines that establish the fact, and keep every other field.`,
  "fact-disposition":
    'Each fact documentationDisposition must be exactly "documented", "omitted", "conflicting", "unverified-policy", or "product-defect".',
  "fact-finding-link":
    "A documented fact must set issueIds to []. Every other fact must list at least one issue id, and each listed id must be the id of an issue in review.issues.",
} as const satisfies Record<InventoryFailureDetail, string>);

/** Every `TechnicalReviewRejectionCode` the source-obligation catalog does not define. */
const TECHNICAL_REJECTION_RULES = Object.freeze({
  "unsafe-disclosure": "Remove credential-shaped content, and never quote a secret.",
  "invalid-review":
    'review must satisfy the governed review-result schema: verdict "pass", "needs-revision", or "human-review", and each issue with exactly id, severity, category, location, finding, evidence (an object with exactly source_id and locator), and required_change. Issue ids are uppercase letters, a hyphen, and three digits, and each issue location is a repository-relative page locator.',
  "invalid-coverage":
    'coverage must list each approved target page exactly once by repository-relative path, with status "verified" or "unverified", a non-empty reason, and distinct non-empty evidence entries. A verified entry needs at least one evidence entry.',
  "invalid-fact-inventory":
    'factInventory must follow the host verification contract: completeness "bounded-not-proven", one entry per required technical dimension with exactly dimension, status, reason, sourceLocators, and facts, and specific source locators and valid issue links on every fact.',
  // One statement of the rule, in both reply forms.
  "inconsistent-verdict": `The verdict must agree with the evidence. ${VERDICT_CONSISTENCY_RULE} ${JUDGMENT_VERDICT_RULE}`,
  "invalid-accounting":
    'Account for every source obligation exactly once by its obligationId, with disposition "retained", "refined", or "rejected". Do not change a statement, uncertainty, or dimension copied from the obligation.',
  "invalid-fact-link":
    "Every cited fact id must be well formed, appear at most once in its list, and name a fact in the fact inventory. Every cited obligation id must exist in the source-obligation ledger.",
  "source-authority":
    "Cite only files in the admitted original source set for this run, with specific repository-relative locators.",
  "target-authority":
    "Each issue location must point into one of the approved target pages for this run.",
} as const satisfies Record<
  Exclude<TechnicalReviewRejectionCode, keyof typeof SOURCE_OBLIGATION_RULE_HINTS>,
  string
>);

/**
 * Rules for the review-result schema keywords the frozen-schema validator
 * names, recorded as `review-schema-<keyword>` at a `$.review` location. Keyed
 * by `StagedQualitySchemaMismatchKeyword`, so a new keyword does not typecheck
 * without a rule; the `review-schema-*` family covers codes outside the list.
 */
export const REVIEW_SCHEMA_KEYWORD_RULES = Object.freeze({
  const:
    "The value at this location must equal the one value the review-result schema fixes there.",
  enum: 'The value at this location must be one of the values the review-result schema allows there, spelled exactly: verdict "pass", "needs-revision", or "human-review"; severity "critical", "major", or "minor"; and a category from the schema list.',
  type: "The value at this location has the wrong JSON type for the review-result schema, such as a string where an object or array is required.",
  required:
    "A required key is missing from the review. The location names the missing key; add it with a valid value.",
  "additional-properties":
    "The object at this location has a key the review-result schema does not declare. Remove it; put reader impact or confidence in finding instead.",
  "min-items":
    "The array at this location has fewer entries than the review-result schema requires.",
  "max-items":
    "The array at this location has more entries than the review-result schema allows. Merge or condense entries without dropping a required finding.",
  "unique-items": "The array at this location repeats an entry. Keep each entry once.",
  "min-length":
    "The string at this location is empty or shorter than the review-result schema allows.",
  "max-length":
    "The string at this location is longer than the review-result schema allows. Condense it.",
  pattern:
    "The string at this location does not match its required format. Issue ids are uppercase letters, a hyphen, and three digits.",
  format:
    "The string at this location does not match its required format, such as an RFC 3339 date-time.",
  minimum: "The number at this location is below the minimum the review-result schema allows.",
  maximum: "The number at this location is above the maximum the review-result schema allows.",
  "exclusive-minimum":
    "The number at this location must be greater than the minimum the review-result schema sets.",
} as const satisfies Record<StagedQualitySchemaMismatchKeyword, string>);

const REVIEW_SCHEMA_FAMILY_RULE =
  "The review broke a rule of the governed review-result schema at this location. Match the schema's declared keys, types, formats, and allowed values exactly.";

/**
 * The repair for a judgment that linked an obligation ID the sealed ledger
 * never issued. The harness quotes it beside the cited IDs and the issued set.
 */
export const UNKNOWN_OBLIGATION_LINK_REPAIR =
  "Replace each with the host-issued obligation ID whose current fact the finding concerns, or remove that link.";

/**
 * The repair for a judgment that rejected every obligation of an applicable
 * ledger dimension. The harness quotes it after the named dimensions, their
 * obligation IDs, and the admitted source paths from the sealed ledger.
 */
export const EMPTIED_APPLICABLE_DIMENSION_REPAIR = `For each named dimension, retain at least one of its obligations the source establishes, or refine one to the statement the source does establish. Only if the admitted source establishes none of them, keep every one rejected and give each rejection rejectionCode ${OBLIGATION_REJECTION_CODES.map((code) => `"${code}"`).join(" or ")} and evidenceLocators into the admitted source paths listed here; the host then demotes the dimension to unverified and records "human-review". Keep issueJudgments consistent with the changed rows.`;

const UNKNOWN_OBLIGATION_LINK_RULE = `Every issueJudgments[].obligationIds entry must be an obligation ID the host issued in the sealed ledger named in the response contract; fact IDs and issue IDs in earlier results are not obligation IDs. For each unissued ID: ${UNKNOWN_OBLIGATION_LINK_REPAIR}`;

const quoted = (values: readonly string[]): string =>
  values.map((value) => JSON.stringify(value)).join(", ");

/**
 * Rules for a substantive all-reject the host still refuses to demote. Each
 * repeats the part of the applicable-dimension rule the reply broke.
 */
const DIMENSION_DEMOTION_RULES = Object.freeze({
  unresolvedEvidence:
    "Each evidenceLocators entry of a rejection that empties an applicable dimension must be a line or line-range locator, such as src/cli.mjs:12 or src/cli.mjs:12-18, into one of the admitted source paths the contract lists, and every cited line must exist in that source: start at line 1 or later and end no later than its last line. Reread the source and cite the lines the rejection relies on, or retain or refine an obligation the source establishes.",
  singleLine:
    "The rejections that empty one applicable dimension cited only one distinct source line between them. Cite, across that dimension's rejections, at least two distinct existing lines of the admitted source that show each statement is not established or is contradicted, or retain or refine an obligation the source establishes.",
  everyApplicableDimension:
    "The judgment rejected every obligation of every applicable ledger dimension, so no source-verified fact would remain. Keep at least one obligation the source establishes retained or refined, in at least one applicable dimension, and reject a whole dimension only where the admitted source establishes none of its obligations.",
} as const satisfies Record<keyof typeof DIMENSION_DEMOTION_REJECTIONS, string>);

/** The issue judgment vocabulary, rendered from the lists the fill checks. */
const ISSUE_JUDGMENT_VOCABULARY_RULES = Object.freeze({
  severity: `Each issueJudgments[].severity must be exactly one of ${quoted(REVIEW_SEVERITIES)}.`,
  category: `Each issueJudgments[].category must be exactly one of ${quoted(REVIEW_CATEGORIES)}, spelled with underscores. Use completeness for an omitted fact, technical_accuracy for a conflicting claim, and source_grounding for a claim whose authority is unavailable.`,
} as const satisfies Record<keyof typeof ISSUE_JUDGMENT_VOCABULARY_REJECTIONS, string>);

/**
 * Rules for the fact-link reasons a model reply can break: the `factIds` a
 * correction's `obligationAccounting` rows write. The two-direction agreement
 * codes are terminal integrity checks of host-built proposals with no rule to
 * state, since the host derives each fact's `issueIds`. `judgment-fact-unlinked`
 * is declared in `config/model-output/rules/technical-judgment.yaml`.
 */
export const FACT_LINK_RULE_HINTS = Object.freeze({
  "fact-link-malformed-fact-id":
    "Each cited fact id must be the id of a fact in the fact inventory, written as an uppercase letter followed by uppercase letters, digits, hyphens, or underscores.",
  "fact-link-duplicate-fact-id": "A factIds list must name each fact id at most once.",
  "fact-link-unknown-fact":
    "A cited fact id named no fact in the fact inventory. Cite only the ids of facts the inventory lists.",
} as const satisfies Partial<Record<FactLinkRejectionCode, string>>);

const REVIEW_ISSUE_LOCATION_RULE =
  "Each issue location must be a safe repository-relative page locator, such as <target page path>:<line>: no absolute path, no .. segment, no backslash, and any line number or range starting at line 1 or later with its end no earlier than its start.";

function prefixed(
  prefix: string,
  rules: Readonly<Record<string, string>>,
): Record<string, RejectionRuleHint> {
  return Object.fromEntries(
    Object.entries(rules).map(([code, rule]) => [`${prefix}${code}`, everywhere(rule)]),
  );
}

export const TECHNICAL_RESPONSE_RULE_HINTS: RejectionRuleHintCatalog = Object.freeze({
  ...prefixed("inventory-", FACT_INVENTORY_RULE_HINTS),
  ...prefixed("json-", JSON_EVIDENCE_SYNTAX_RULES),
  ...prefixed("json-", JSON_EVIDENCE_ERROR_RULES),
  ...prefixed("", TECHNICAL_REJECTION_RULES),
  ...prefixed("review-schema-", REVIEW_SCHEMA_KEYWORD_RULES),
  "review-schema-*": everywhere(REVIEW_SCHEMA_FAMILY_RULE),
  "review-issue-location-unsafe": everywhere(REVIEW_ISSUE_LOCATION_RULE),
  [UNKNOWN_OBLIGATION_LINK_REJECTION.code]: everywhere(UNKNOWN_OBLIGATION_LINK_RULE),
  [ISSUE_JUDGMENT_VOCABULARY_REJECTIONS.severity.code]: everywhere(
    ISSUE_JUDGMENT_VOCABULARY_RULES.severity,
  ),
  [ISSUE_JUDGMENT_VOCABULARY_REJECTIONS.category.code]: everywhere(
    ISSUE_JUDGMENT_VOCABULARY_RULES.category,
  ),
  ...prefixed("", FACT_LINK_RULE_HINTS),
  [DIMENSION_DEMOTION_REJECTIONS.unresolvedEvidence.code]: everywhere(
    DIMENSION_DEMOTION_RULES.unresolvedEvidence,
  ),
  [DIMENSION_DEMOTION_REJECTIONS.singleLine.code]: everywhere(DIMENSION_DEMOTION_RULES.singleLine),
  [DIMENSION_DEMOTION_REJECTIONS.everyApplicableDimension.code]: everywhere(
    DIMENSION_DEMOTION_RULES.everyApplicableDimension,
  ),
});

type HintedTechnicalReason =
  | keyof typeof SOURCE_OBLIGATION_RULE_HINTS
  | keyof typeof TECHNICAL_REJECTION_RULES
  | `inventory-${keyof typeof FACT_INVENTORY_RULE_HINTS}`
  | keyof typeof FACT_LINK_RULE_HINTS
  | (typeof UNKNOWN_OBLIGATION_LINK_REJECTION)["code"]
  | (typeof ISSUE_JUDGMENT_VOCABULARY_REJECTIONS)[keyof typeof ISSUE_JUDGMENT_VOCABULARY_RULES]["code"]
  | (typeof DIMENSION_DEMOTION_REJECTIONS)[keyof typeof DIMENSION_DEMOTION_RULES]["code"];

/** Fails to typecheck while a model-correctable reason has no rule above. */
export const EVERY_CORRECTABLE_TECHNICAL_REASON_HAS_A_RULE: [
  Exclude<ModelCorrectableTechnicalReason, HintedTechnicalReason>,
] extends [never]
  ? true
  : never = true;
