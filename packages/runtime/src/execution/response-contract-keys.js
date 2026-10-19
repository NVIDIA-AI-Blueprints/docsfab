// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Response-contract key sets and the key vocabulary builder.
 *
 * Dependency-free: the decoders import their key sets from here, and
 * `scripts/check-model-output.mjs` renders the JSON mirror from this module in
 * `runtime:derived:preflight`, before `npm ci`.
 *
 * Every set below is a closed key set its decoder enforces, except the three
 * judgment-row sets, which are prompt-declared: the host fill ignores any other
 * row key, and `judgment-row-key-audit.ts` counts such keys on accepted replies.
 */

const keys = (...names) => Object.freeze(names);

// Technical verification result (review-response.ts).
export const VERIFICATION_RESULT_KEYS = keys("review", "coverage", "factInventory");
export const VERIFICATION_COVERAGE_ENTRY_KEYS = keys("path", "status", "evidence", "reason");
export const FACT_INVENTORY_KEYS = keys("completeness", "dimensions", "limitations");
export const FACT_INVENTORY_DIMENSION_KEYS = keys(
  "dimension",
  "status",
  "reason",
  "sourceLocators",
  "facts",
);
export const FACT_INVENTORY_FACT_KEYS = keys(
  "id",
  "dimension",
  "sourceLocators",
  "statement",
  "documentationDisposition",
  "uncertainty",
  "issueIds",
);

// Technical correction, provisional judgment, and ledger (source-obligation.ts).
export const TECHNICAL_CORRECTION_PROPOSAL_KEYS = keys(
  "kind",
  "schemaVersion",
  "verdict",
  "coverage",
  "factInventory",
  "issueJudgments",
  "obligationAccounting",
);
export const TECHNICAL_CORRECTION_JUDGMENT_KEYS = keys(
  "verdict",
  "coverage",
  "issueJudgments",
  "obligationJudgments",
);
export const TECHNICAL_CORRECTION_IGNORED_IDENTITY_KEYS = keys(
  "kind",
  "schemaVersion",
  "obligationAccounting",
  "factInventory",
);
export const TECHNICAL_CORRECTION_ENVELOPE_KEYS = keys(
  "verificationResult",
  "obligationAccounting",
);
export const PROVISIONAL_RICH_JUDGMENT_ENVELOPE_KEYS = keys(
  "kind",
  "schemaVersion",
  "judgment",
  "richCandidates",
);
export const PROVISIONAL_RICH_CANDIDATE_KEYS = keys(
  "issueId",
  "title",
  "readerConsequence",
  "obligationIds",
  "proposedEdit",
);
export const PROVISIONAL_RICH_PROPOSED_EDIT_KEYS = keys("kind", "text");
export const PROVISIONAL_RICH_REPLACEMENT_EDIT_KEYS = keys(
  "kind",
  "text",
  "path",
  "originalText",
  "replacementText",
);
export const PROVISIONAL_RICH_EVIDENCE_CANDIDATE_KEYS = keys(
  ...PROVISIONAL_RICH_CANDIDATE_KEYS,
  "candidateSha256",
);
export const PROVISIONAL_RICH_CANDIDATE_EVIDENCE_KEYS = keys(
  "kind",
  "schemaVersion",
  "sourceObligationLedgerSha256",
  "scopeSha256",
  "repositoryRevision",
  "verificationResultSha256",
  "candidates",
  "digest",
);
/** Prompt-declared judgment row keys; not decoder-enforced (see the header). */
export const TECHNICAL_CORRECTION_ISSUE_JUDGMENT_KEYS = keys(
  "id",
  "severity",
  "category",
  "location",
  "obligationIds",
);
export const TECHNICAL_CORRECTION_PROPOSAL_ISSUE_JUDGMENT_KEYS = keys(
  "id",
  "severity",
  "category",
  "location",
  "factIds",
);
/** Prompt-declared judgment row keys; not decoder-enforced (see the header). */
export const TECHNICAL_CORRECTION_OBLIGATION_JUDGMENT_KEYS = keys(
  "obligationId",
  "disposition",
  "documentationDisposition",
  // No issueIds; the host derives fact issue links from issueJudgments.
  "reason",
  "replacements",
  "statement",
  "uncertainty",
  "dimension",
  // A substantive rejection's closed code and admitted evidence.
  "rejectionCode",
  "evidenceLocators",
);
/** Prompt-declared judgment row keys; not decoder-enforced (see the header). */
export const TECHNICAL_CORRECTION_REPLACEMENT_KEYS = keys(
  "statement",
  "documentationDisposition",
  "uncertainty",
);
export const OBLIGATION_ACCOUNTING_KEYS = keys(
  "obligationId",
  "disposition",
  "factIds",
  "reason",
  "sourceLocators",
);
export const SOURCE_OBLIGATION_PROPOSAL_KEYS = keys("completeness", "dimensions", "limitations");
export const SOURCE_OBLIGATION_DIMENSION_KEYS = keys(
  "dimension",
  "status",
  "reason",
  "sourceLocators",
  "obligations",
);
export const SOURCE_OBLIGATION_KEYS = keys(
  "id",
  "dimension",
  "sourceLocators",
  "statement",
  "evidenceClass",
  "uncertainty",
);

// Editorial assessment (editorial-response-contract.ts, editorial-evidence-host.ts).
export const EDITORIAL_ASSESSMENT_RESPONSE_KEYS = keys("summary", "editorialAssessmentProposal");
export const EDITORIAL_ASSESSMENT_PROPOSAL_KEYS = keys(
  "schemaVersion",
  "kind",
  "assessment",
  "rationale",
  "evidenceRefs",
  "limitations",
  "recommendation",
);
export const EDITORIAL_ASSESSMENT_RECOMMENDATION_KEYS = keys("candidate", "kind", "code");

// Documentation planner reply (harness/reply-admission/planner.ts,
// workflow-execution/plan-binding.ts, artifacts/editorial-decision.ts), declared
// so a rejected planner reply's fingerprint names its keys.
export const PLANNER_COMPLETED_RESPONSE_KEYS = keys("summary", "planBinding");
export const EDITORIAL_PLANNER_COMPLETED_RESPONSE_KEYS = keys(
  "summary",
  "planBinding",
  "editorialDecisionProposal",
);
export const PLANNER_NEEDS_INPUT_RESPONSE_KEYS = keys("summary", "outcome", "reason");
export const DOCUMENTATION_PLAN_INPUT_KEYS = keys("mode", "pages", "sourceBindings");
export const DOCUMENTATION_PLAN_PAGE_KEYS = keys("path", "disposition");
export const DOCUMENTATION_PLAN_SOURCE_BINDING_KEYS = keys("pagePath", "sources");
export const EDITORIAL_DECISION_JUDGMENT_KEYS = keys("candidate", "rationale", "slotIds");

// Final quality evaluator envelope (quality-candidate-tool.ts).
export const QUALITY_ARTIFACT_RESPONSE_KEYS = keys("evaluation", "qualityScore", "reportMarkdown");
// The leading JSON object of the evaluator's answer, which carries the report as
// Markdown after it (quality-candidate-tool.ts).
export const QUALITY_ARTIFACT_ANSWER_KEYS = keys("evaluation", "qualityScore");

/** Frozen host schemas whose declared properties are response-contract keys. */
export const RESPONSE_CONTRACT_SCHEMAS = keys(
  "review-result.schema.json",
  "documentation-quality-evaluation.schema.json",
  "quality-score.schema.json",
);

export const RESPONSE_CONTRACT_KEY_SETS = Object.freeze({
  verificationResult: VERIFICATION_RESULT_KEYS,
  verificationCoverageEntry: VERIFICATION_COVERAGE_ENTRY_KEYS,
  factInventory: FACT_INVENTORY_KEYS,
  factInventoryDimension: FACT_INVENTORY_DIMENSION_KEYS,
  factInventoryFact: FACT_INVENTORY_FACT_KEYS,
  correctionEnvelope: TECHNICAL_CORRECTION_ENVELOPE_KEYS,
  provisionalRichJudgmentEnvelope: PROVISIONAL_RICH_JUDGMENT_ENVELOPE_KEYS,
  provisionalRichCandidate: PROVISIONAL_RICH_CANDIDATE_KEYS,
  provisionalRichProposedEdit: PROVISIONAL_RICH_PROPOSED_EDIT_KEYS,
  provisionalRichReplacementEdit: PROVISIONAL_RICH_REPLACEMENT_EDIT_KEYS,
  provisionalRichEvidenceCandidate: PROVISIONAL_RICH_EVIDENCE_CANDIDATE_KEYS,
  provisionalRichCandidateEvidence: PROVISIONAL_RICH_CANDIDATE_EVIDENCE_KEYS,
  correctionProposal: TECHNICAL_CORRECTION_PROPOSAL_KEYS,
  correctionProposalIssueJudgment: TECHNICAL_CORRECTION_PROPOSAL_ISSUE_JUDGMENT_KEYS,
  provisionalJudgment: TECHNICAL_CORRECTION_JUDGMENT_KEYS,
  provisionalJudgmentIgnoredIdentity: TECHNICAL_CORRECTION_IGNORED_IDENTITY_KEYS,
  provisionalIssueJudgment: TECHNICAL_CORRECTION_ISSUE_JUDGMENT_KEYS,
  provisionalObligationJudgment: TECHNICAL_CORRECTION_OBLIGATION_JUDGMENT_KEYS,
  provisionalReplacement: TECHNICAL_CORRECTION_REPLACEMENT_KEYS,
  obligationAccounting: OBLIGATION_ACCOUNTING_KEYS,
  sourceObligationProposal: SOURCE_OBLIGATION_PROPOSAL_KEYS,
  sourceObligationDimension: SOURCE_OBLIGATION_DIMENSION_KEYS,
  sourceObligation: SOURCE_OBLIGATION_KEYS,
  editorialAssessmentEnvelope: EDITORIAL_ASSESSMENT_RESPONSE_KEYS,
  editorialAssessmentProposal: EDITORIAL_ASSESSMENT_PROPOSAL_KEYS,
  editorialAssessmentRecommendation: EDITORIAL_ASSESSMENT_RECOMMENDATION_KEYS,
  plannerCompleted: PLANNER_COMPLETED_RESPONSE_KEYS,
  editorialPlannerCompleted: EDITORIAL_PLANNER_COMPLETED_RESPONSE_KEYS,
  plannerNeedsInput: PLANNER_NEEDS_INPUT_RESPONSE_KEYS,
  documentationPlanInput: DOCUMENTATION_PLAN_INPUT_KEYS,
  documentationPlanPage: DOCUMENTATION_PLAN_PAGE_KEYS,
  documentationPlanSourceBinding: DOCUMENTATION_PLAN_SOURCE_BINDING_KEYS,
  editorialDecisionJudgment: EDITORIAL_DECISION_JUDGMENT_KEYS,
  qualityArtifactEnvelope: QUALITY_ARTIFACT_RESPONSE_KEYS,
  qualityArtifactAnswer: QUALITY_ARTIFACT_ANSWER_KEYS,
});

/** Current rejected-reply shape fingerprint schema; readers name keys only from it. */
export const REJECTED_REPLY_SHAPE_SCHEMA_VERSION = 1;

/** Every property name a JSON Schema declares, at any depth, including `$defs`. */
function schemaPropertyNames(schema, into) {
  if (Array.isArray(schema)) {
    for (const item of schema) schemaPropertyNames(item, into);
    return;
  }
  if (!schema || typeof schema !== "object") return;
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      for (const name of Object.keys(value)) into.add(name);
    }
    if (key === "required" && Array.isArray(value)) {
      for (const name of value) if (typeof name === "string") into.add(name);
    }
    schemaPropertyNames(value, into);
  }
}

/**
 * Build the vocabulary from the key sets and the frozen schemas.
 *
 * @param {(schemaName: string) => unknown} readSchema parsed JSON of one schema in RESPONSE_CONTRACT_SCHEMAS
 * @returns {Set<string>}
 */
export function buildResponseContractKeyVocabulary(readSchema) {
  const vocabulary = new Set();
  for (const set of Object.values(RESPONSE_CONTRACT_KEY_SETS)) {
    for (const key of set) vocabulary.add(key);
  }
  for (const name of RESPONSE_CONTRACT_SCHEMAS) schemaPropertyNames(readSchema(name), vocabulary);
  return vocabulary;
}

/**
 * The JSON mirror text for readers that cannot load runtime TypeScript.
 *
 * @param {(schemaName: string) => unknown} readSchema
 * @returns {string}
 */
export function renderResponseContractVocabularyMirror(readSchema) {
  const mirror = {
    kind: "docsfab-response-contract-key-vocabulary",
    schemaVersion: 1,
    generatedFrom: "packages/runtime/src/execution/response-contract-keys.js",
    regenerate: "npm run generate:model-output (from packages/runtime)",
    rejectedReplyShapeSchemaVersion: REJECTED_REPLY_SHAPE_SCHEMA_VERSION,
    schemas: [...RESPONSE_CONTRACT_SCHEMAS],
    keys: [...buildResponseContractKeyVocabulary(readSchema)].sort(),
  };
  return `${JSON.stringify(mirror, null, 2)}\n`;
}
