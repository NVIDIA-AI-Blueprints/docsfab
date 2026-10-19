// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Types for the dependency-free response-contract key module; see response-contract-keys.js. */
export const VERIFICATION_RESULT_KEYS: readonly string[];
export const VERIFICATION_COVERAGE_ENTRY_KEYS: readonly string[];
export const FACT_INVENTORY_KEYS: readonly string[];
export const FACT_INVENTORY_DIMENSION_KEYS: readonly string[];
export const FACT_INVENTORY_FACT_KEYS: readonly string[];
export const TECHNICAL_CORRECTION_PROPOSAL_KEYS: readonly string[];
export const TECHNICAL_CORRECTION_JUDGMENT_KEYS: readonly string[];
export const TECHNICAL_CORRECTION_IGNORED_IDENTITY_KEYS: readonly string[];
export const TECHNICAL_CORRECTION_ENVELOPE_KEYS: readonly string[];
export const PROVISIONAL_RICH_JUDGMENT_ENVELOPE_KEYS: readonly string[];
export const PROVISIONAL_RICH_CANDIDATE_KEYS: readonly string[];
export const PROVISIONAL_RICH_PROPOSED_EDIT_KEYS: readonly string[];
export const PROVISIONAL_RICH_REPLACEMENT_EDIT_KEYS: readonly string[];
export const PROVISIONAL_RICH_EVIDENCE_CANDIDATE_KEYS: readonly string[];
export const PROVISIONAL_RICH_CANDIDATE_EVIDENCE_KEYS: readonly string[];
export const TECHNICAL_CORRECTION_ISSUE_JUDGMENT_KEYS: readonly string[];
export const TECHNICAL_CORRECTION_PROPOSAL_ISSUE_JUDGMENT_KEYS: readonly string[];
export const TECHNICAL_CORRECTION_OBLIGATION_JUDGMENT_KEYS: readonly string[];
export const TECHNICAL_CORRECTION_REPLACEMENT_KEYS: readonly string[];
export const OBLIGATION_ACCOUNTING_KEYS: readonly string[];
export const SOURCE_OBLIGATION_PROPOSAL_KEYS: readonly string[];
export const SOURCE_OBLIGATION_DIMENSION_KEYS: readonly string[];
export const SOURCE_OBLIGATION_KEYS: readonly string[];
export const EDITORIAL_ASSESSMENT_RESPONSE_KEYS: readonly string[];
export const EDITORIAL_ASSESSMENT_PROPOSAL_KEYS: readonly string[];
export const EDITORIAL_ASSESSMENT_RECOMMENDATION_KEYS: readonly string[];
export const PLANNER_COMPLETED_RESPONSE_KEYS: readonly string[];
export const EDITORIAL_PLANNER_COMPLETED_RESPONSE_KEYS: readonly string[];
export const PLANNER_NEEDS_INPUT_RESPONSE_KEYS: readonly string[];
export const DOCUMENTATION_PLAN_INPUT_KEYS: readonly string[];
export const DOCUMENTATION_PLAN_PAGE_KEYS: readonly string[];
export const DOCUMENTATION_PLAN_SOURCE_BINDING_KEYS: readonly string[];
export const EDITORIAL_DECISION_JUDGMENT_KEYS: readonly string[];
export const QUALITY_ARTIFACT_RESPONSE_KEYS: readonly string[];
export const QUALITY_ARTIFACT_ANSWER_KEYS: readonly string[];
export const RESPONSE_CONTRACT_SCHEMAS: readonly string[];
export const RESPONSE_CONTRACT_KEY_SETS: Readonly<Record<string, readonly string[]>>;
export const REJECTED_REPLY_SHAPE_SCHEMA_VERSION: 1;
export function buildResponseContractKeyVocabulary(
  readSchema: (schemaName: string) => unknown,
): Set<string>;
export function renderResponseContractVocabularyMirror(
  readSchema: (schemaName: string) => unknown,
): string;
