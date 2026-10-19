// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CONTRACT_PLACEHOLDER_STATEMENT, CONTRACT_PLACEHOLDERS } from "./contract-placeholders.js";
export const TECHNICAL_FACT_DIMENSIONS = [
  "input-representations",
  "defaults-and-overrides",
  "mutable-state",
  "destination-and-trust",
  "error-status-retry",
  "environment-prerequisite",
] as const;

export const REVIEW_SEVERITIES = ["critical", "major", "minor"] as const;

export const REVIEW_CATEGORIES = [
  "technical_accuracy",
  "source_grounding",
  "completeness",
  "task_success",
  "example_validity",
  "information_architecture",
  "style_compliance",
  "security_compliance",
] as const;

/**
 * The one host statement of the issue vocabulary, rendered from the lists the
 * decoders check.
 */
export const ISSUE_VOCABULARY_RULE = `Use only severity ${REVIEW_SEVERITIES.join("|")} and category ${REVIEW_CATEGORIES.join("|")}.`;

/**
 * The one host statement of the verdict rule the consistency stage of
 * `validateVerificationResult` enforces; contracts and the
 * `inconsistent-verdict` retry hint quote it.
 */
export const VERDICT_CONSISTENCY_RULE =
  'A "pass" verdict requires no issues, a "needs-revision" verdict requires at least one issue, and any unverified coverage entry or unverified fact-inventory dimension requires "human-review".';

/**
 * How the verdict rule applies to a judgment reply, which carries no review
 * issues or fact inventory. The host builds both, so it records the verdict an
 * unverified sealed-ledger dimension decides (`hostJudgmentVerdict` in
 * `source-obligation.ts`); the remaining clauses are the model's to satisfy.
 */
export const JUDGMENT_VERDICT_RULE =
  'In a judgment reply the host builds issues from issueJudgments and the fact inventory from the sealed ledger. When the sealed ledger marks any dimension unverified, the host demotes a dimension to unverified, or any coverage entry is unverified, the verdict is "human-review" and the host records it. Otherwise return "pass" only with no issueJudgments, and "needs-revision" only with at least one issueJudgment, and every issueJudgment must link a non-documented obligation.';

/**
 * The one host statement of what a coverage entry's status means, quoted by
 * every contract that asks the model for coverage. The host cannot tell a
 * misread status from a real source gap without classifying reason prose, so
 * CREATE keeps refusing unverified coverage and this statement carries the
 * rule. Not yet migrated to the model-output catalog.
 */
export const COVERAGE_STATUS_RULE =
  'Coverage status records whether the admitted sources let you check the target page\'s claims. Use "unverified" only when a claim the page makes cannot be compared with any admitted source because none addresses it, and name that claim and the missing source in reason. Missing command execution is not grounds for "unverified": a command that was not authorized or not run belongs in the affected facts\' uncertainty, not in coverage status. When the page\'s claims can be compared with admitted sources, the entry is "verified" even though no command ran.';

/** The verdict rule as both judgment contracts state it. */
export const JUDGMENT_VERDICT_CONTRACT = `${VERDICT_CONSISTENCY_RULE} ${JUDGMENT_VERDICT_RULE}`;

/**
 * The closed codes a judgment may give a rejected obligation. Only a rejection
 * with one of them and admitted evidence locators counts toward demoting an
 * applicable dimension.
 */
export const OBLIGATION_REJECTION_CODES = [
  "not-established-by-source",
  "contradicted-by-source",
] as const;

const QUOTED_REJECTION_CODES = OBLIGATION_REJECTION_CODES.map((code) => `"${code}"`).join(" or ");

/**
 * The one host statement of the applicable-dimension rule for a judgment
 * reply, quoted by the shared accounting contract and the `dimension-facts`
 * hint.
 */
export const APPLICABLE_DIMENSION_JUDGMENT_RULE = `The host builds each ledger dimension's facts only from its retained and refined obligations, so keep at least one obligation of every dimension the sealed ledger marks applicable retained or refined whenever the source establishes one of them; when the source establishes a different statement, refine the obligation to that statement. Reject every obligation of an applicable dimension only when the admitted source establishes none of them, and then make every one of those rejections substantive: give it rejectionCode ${QUOTED_REJECTION_CODES} ("not-established-by-source" when the cited source does not establish the statement, "contradicted-by-source" when it shows the statement is false and establishes no replacement), and evidenceLocators, one or more distinct line or line-range locators, such as src/cli.mjs:12 or src/cli.mjs:12-18, without a revision suffix, into the admitted source paths the host lists, citing only lines that exist in that source. Across one such dimension, the rejections must together cite at least two distinct source lines, and at least one applicable dimension must keep a retained or refined obligation. The host then demotes that dimension to unverified, and the verdict becomes "human-review". A rejection without both fields cannot empty an applicable dimension.`;

const REVIEW_ISSUE_REQUIREMENTS = [
  // Every example value is a contract placeholder.
  `Each nonempty issues entry must have exactly this shape: ${JSON.stringify({
    id: CONTRACT_PLACEHOLDERS.issueId,
    severity: CONTRACT_PLACEHOLDERS.issueSeverity,
    category: CONTRACT_PLACEHOLDERS.issueCategory,
    location: CONTRACT_PLACEHOLDERS.issueLocation,
    finding: CONTRACT_PLACEHOLDERS.issueFinding,
    evidence: {
      source_id: CONTRACT_PLACEHOLDERS.evidenceSourceId,
      locator: CONTRACT_PLACEHOLDERS.sourceLine,
    },
    required_change: CONTRACT_PLACEHOLDERS.requiredChange,
  })}`,
  `${ISSUE_VOCABULARY_RULE} Issue IDs must match ^[A-Z]+-[0-9]{3}$. All other string fields must be nonempty. evidence is one object with exactly source_id and locator, not a string or array. Do not add fields. Put reader impact and confidence, when relevant, in finding rather than separate properties. Replace the example with actual findings and evidence; do not invent a finding to fill the shape.`,
  CONTRACT_PLACEHOLDER_STATEMENT,
];

/**
 * The one host statement of the fact-inventory locator rule that
 * `validateSourceLocators` enforces, quoted by the verification contract and
 * the `inventory-fact-locators` hint. A plan source identity (`path@revision`)
 * is a whole-file identity the host binds, not an establishing locator.
 */
export const SOURCE_LOCATOR_RULE =
  "Every sourceLocators entry is one specific repository-relative locator: path:line, path:start-end, or path#anchor, with one location per entry. A plan source identity such as <path>@<revision> names a whole file at the bound revision and is not a source locator: cite the establishing lines without the @revision suffix, because the host binds the repository revision separately.";

/**
 * The verification result shape the contract shows. The first dimension shows
 * the applicable form and the rest the not-applicable form; every free-text,
 * locator, and ID value is a contract placeholder.
 */
const VERIFICATION_RESULT_SHAPE = {
  review: { verdict: "pass", issues: [] },
  coverage: [
    {
      path: CONTRACT_PLACEHOLDERS.targetPagePath,
      status: "verified",
      evidence: [CONTRACT_PLACEHOLDERS.sourceLine],
      reason: CONTRACT_PLACEHOLDERS.coverageReason,
    },
  ],
  factInventory: {
    completeness: "bounded-not-proven",
    dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension, index) =>
      index === 0
        ? {
            dimension,
            status: "applicable",
            reason: CONTRACT_PLACEHOLDERS.applicableReason,
            sourceLocators: [],
            facts: [
              {
                id: CONTRACT_PLACEHOLDERS.factId,
                dimension,
                sourceLocators: [CONTRACT_PLACEHOLDERS.sourceRange],
                statement: CONTRACT_PLACEHOLDERS.factStatement,
                documentationDisposition: "documented",
                uncertainty: CONTRACT_PLACEHOLDERS.factUncertainty,
                issueIds: [],
              },
            ],
          }
        : {
            dimension,
            status: "not-applicable",
            reason: CONTRACT_PLACEHOLDERS.notApplicableReason,
            sourceLocators: [CONTRACT_PLACEHOLDERS.sourceRange],
            facts: [],
          },
    ),
    limitations: [],
  },
};

const VERIFICATION_RESULT_REQUIREMENTS = [
  "Serialize compact JSON without indentation. Keep narrative fields concise and avoid repeating a fact in multiple dimensions; retain every material atomic fact, required field, finding, and evidence link. Finish the entire object before adding optional elaboration.",
  // Every example value is closed vocabulary or a contract placeholder.
  `Shape: ${JSON.stringify(VERIFICATION_RESULT_SHAPE)}`,
  "The review object must satisfy quality/schemas/review-result.schema.json. Findings require source_id and locator evidence.",
  ...REVIEW_ISSUE_REQUIREMENTS,
  "Include each target page exactly once in coverage; source dependencies are evidence, not extra target pages. Use the authoritative review scope or approved plan when supplied.",
  "Without an authoritative target list, report only the pages actually checked; that list does not prove full documentation-set coverage.",
  "A verified entry means the stated checks were completed, not that every claim on the page was verified. Its reason must identify the claims sampled, checks completed, and remaining limits. Cite specific source evidence. Zero tool calls are acceptable when supplied evidence is sufficient.",
  COVERAGE_STATUS_RULE,
  `Assess each fact-inventory dimension exactly once: ${TECHNICAL_FACT_DIMENSIONS.join(", ")}.`,
  'Every dimension must include exactly dimension, status, reason, sourceLocators, and facts. For an applicable dimension, return at least one fact and set dimension-level sourceLocators to []; keep the source citations on each fact. For not-applicable, set facts to [] and provide a substantive source-backed reason and specific sourceLocators. For unverified, set facts to [], retain sourceLocators as an array, state the missing-evidence reason verbatim in factInventory.limitations, and use review.verdict "human-review".',
  "Every fact needs a stable ID, its dimension, one or more specific repository-relative source locators, the behavioral statement, documentation disposition, uncertainty, and linked issue IDs. Omitted, conflicting, unverified-policy, and product-defect facts must link to existing review issue IDs; documented facts link to none.",
  SOURCE_LOCATOR_RULE,
  'Use documentationDisposition "documented", "omitted", "conflicting", "unverified-policy", or "product-defect". Final output cannot leave a fact unassessed.',
  'Set factInventory.completeness to "bounded-not-proven". A structurally complete inventory does not prove factual completeness outside the frozen sources and scope.',
  `${VERDICT_CONSISTENCY_RULE} Return completed findings and coverage, never a promise to review later.`,
  "Normal JSON whitespace and key order are accepted; the host canonicalizes an admitted result.",
];

export const VERIFICATION_RESPONSE_CONTRACT = [
  "Runtime technical verification response contract (host-owned):",
  "Return one JSON object with exactly review, coverage, and factInventory, without Markdown fences or surrounding prose.",
  ...VERIFICATION_RESULT_REQUIREMENTS,
].join("\n");

export const NESTED_VERIFICATION_RESULT_CONTRACT = [
  "Nested technical verificationResult contract (host-owned):",
  "Inside the selected outer correction envelope, verificationResult must contain exactly review, coverage, and factInventory. These fields must not appear at the outer top level.",
  ...VERIFICATION_RESULT_REQUIREMENTS,
].join("\n");

/**
 * Technical verification result nested as the summary of the update-documentation
 * V2 editorial assessment envelope. It states no top-level shape: the host
 * envelope contract that follows it is the step's only outer shape.
 */
export const NESTED_EDITORIAL_VERIFICATION_RESULT_CONTRACT = [
  "Nested technical verification result contract (host-owned):",
  "This contract defines a nested value, not the response. The host-owned outer response contract that follows defines the only top-level JSON shape. Its summary value contains exactly review, coverage, and factInventory. review, coverage, and factInventory must not appear at the outer top level.",
  ...VERIFICATION_RESULT_REQUIREMENTS,
].join("\n");

function technicalSynthesisContract(recordsMode: boolean): string {
  return [
    "Runtime final synthesis source-fact handoff (host-owned):",
    "The admitted verify-technical-accuracy result in Earlier independent results contains a bounded factInventory. Preserve every originating fact ID, linked technical issue ID, and source locator when retaining or consolidating a material technical finding.",
    recordsMode
      ? "For every non-documented fact, link one structured final finding through record.originating_ids to its exact fact ID and retain every linked technical issue ID and the exact uncertainty text. Finding prose alone does not establish a record.originating_ids link. The host carries that fact's admitted source locators onto the linked finding as host evidence."
      : "For every non-documented fact, one structured final finding must contain the exact fact ID, every linked technical issue ID, and the exact uncertainty text in its ID, description, evidence descriptions, acceptance condition, resolution, or dismissal rationale. The host then carries that fact's admitted source locators onto the first such finding as one host evidence entry, holding each admitted locator the finding does not already cite exactly, so you need not copy them.",
    "Do not replace dimension-specific facts with a generic API-coverage statement. Preserve each admitted dimension status exactly: applicable and not-applicable reasons explain scope and must not be relabeled as unverified limitations.",
    recordsMode
      ? 'The host carries admitted factInventory limitations and exact dimension/reason limitations for dimensions whose status is "unverified" into the final evaluation and report. You may include additional evidence-based limitations, but do not copy these host-owned strings or claim an inventory limitation absent from the admitted verification.'
      : 'Copy each factInventory limitation verbatim into evaluation.limitations. Add a dimension-ID/reason limitation only for a dimension whose admitted status is exactly "unverified"; that limitation must contain the exact dimension ID and its exact reason.',
    "Keep fact-level uncertainty with its originating fact, including unavailable execution or external-owner policy. Fact uncertainty does not change the whole dimension status.",
    "If you add a missing-evidence observation beyond factInventory.limitations, identify its actual evidence basis and affected fact without fabricating an upstream status.",
    "Preserve bounded-not-proven as a separate completeness limitation, not as a claim that every dimension is unverified.",
    "A source range you cite must include the implementation lines that establish the fact, not only a declaration or signature.",
    "The inventory's bounded-not-proven marker prevents a factual-completeness claim. Independently assess the frozen source when the final decision requires stronger evidence.",
  ].join("\n");
}

export const TECHNICAL_SYNTHESIS_CONTRACT = technicalSynthesisContract(false);

export const RECORDS_TECHNICAL_SYNTHESIS_CONTRACT = technicalSynthesisContract(true);

const EDITORIAL_REVIEW_RESULT_REQUIREMENTS = [
  'Shape: {"verdict":"pass","issues":[]}',
  ...REVIEW_ISSUE_REQUIREMENTS,
  "Each issue location must be a credential-free repository-relative locator or bounded section label, such as <target page path>:<line> or <section heading>.",
  "A pass requires no issues. A needs-revision verdict requires at least one issue. Use human-review when evidence is insufficient for either conclusion.",
  "Return completed findings, never a promise to review later. Do not include credentials.",
  "Normal JSON whitespace and key order are accepted; the host canonicalizes an admitted result.",
];

export const EDITORIAL_RESPONSE_CONTRACT = [
  "Runtime editorial review response contract (host-owned):",
  "Return one JSON object satisfying quality/schemas/review-result.schema.json, without Markdown fences or surrounding prose.",
  ...EDITORIAL_REVIEW_RESULT_REQUIREMENTS,
].join("\n");

/**
 * Editorial review result nested as the summary of the update-documentation
 * V2 editorial assessment envelope. It states no top-level shape: the host
 * envelope contract that follows it is the step's only outer shape.
 */
export const NESTED_EDITORIAL_REVIEW_RESULT_CONTRACT = [
  "Nested editorial review result contract (host-owned):",
  "This contract defines a nested value, not the response. The host-owned outer response contract that follows defines the only top-level JSON shape. Its summary value is one review result satisfying quality/schemas/review-result.schema.json with exactly verdict and issues. verdict and issues must not appear at the outer top level.",
  ...EDITORIAL_REVIEW_RESULT_REQUIREMENTS,
].join("\n");
