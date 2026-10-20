// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { limit } from "../config/limits.js";
import { createContractKit, type ContractKitCodes } from "../contract-kit/index.js";
import {
  isModelCorrectableReviewResultRejection,
  type ReviewResultRejectionCode,
} from "./review-result-rejection-retryability.js";
import {
  inferenceFailureConditionOf,
  InferenceStepError,
  type EmptiedApplicableDimensionsCorrection,
  type HarnessStepInput,
  type InferenceRejectionReasonV1,
  type UnknownObligationIdsCorrection,
} from "../execution/contracts.js";
// The generated catalog table itself, a leaf, as plan-binding.ts imports it.
import {
  OUTPUT_RULES,
  rejectCorrectable,
  type OutputRuleRejection,
  type RuleCodeOf,
} from "../contracts/model-output.generated.js";
import {
  describeStagedQualityArtifactMismatch,
  validateStagedQualityArtifact,
  type SchemaValidation,
} from "../evaluation-report/quality-schema-validation.js";
import {
  canonicalizeJsonEvidence,
  JsonEvidenceError,
  type JsonEvidenceErrorCode,
  type JsonEvidenceSyntaxDetail,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import { jsonEnvelopeBody } from "../execution/json-envelope.js";
import { documentationPlanVerificationPaths } from "./plan-binding.js";
import {
  TECHNICAL_FACT_DIMENSIONS,
  OBLIGATION_REJECTION_CODES,
  VERIFICATION_RESPONSE_CONTRACT,
  NESTED_EDITORIAL_VERIFICATION_RESULT_CONTRACT,
  TECHNICAL_SYNTHESIS_CONTRACT,
  RECORDS_TECHNICAL_SYNTHESIS_CONTRACT,
  EDITORIAL_RESPONSE_CONTRACT,
  NESTED_EDITORIAL_REVIEW_RESULT_CONTRACT,
} from "./review-response-prompts.js";
export {
  TECHNICAL_FACT_DIMENSIONS,
  REVIEW_SEVERITIES,
  REVIEW_CATEGORIES,
  ISSUE_VOCABULARY_RULE,
  VERDICT_CONSISTENCY_RULE,
  JUDGMENT_VERDICT_RULE,
  COVERAGE_STATUS_RULE,
  JUDGMENT_VERDICT_CONTRACT,
  OBLIGATION_REJECTION_CODES,
  APPLICABLE_DIMENSION_JUDGMENT_RULE,
  SOURCE_LOCATOR_RULE,
  VERIFICATION_RESPONSE_CONTRACT,
  NESTED_VERIFICATION_RESULT_CONTRACT,
  NESTED_EDITORIAL_VERIFICATION_RESULT_CONTRACT,
  TECHNICAL_SYNTHESIS_CONTRACT,
  EDITORIAL_RESPONSE_CONTRACT,
  NESTED_EDITORIAL_REVIEW_RESULT_CONTRACT,
} from "./review-response-prompts.js";
import {
  isModelCorrectableTechnicalRejection,
  TECHNICAL_CORRECTION_BYTE_BOUNDS,
  type ClassifiedTechnicalRejectionReason,
  type FactLinkRejectionCode,
  type TechnicalCorrectionByteBound,
  type TechnicalCorrectionByteBoundCode,
  type TechnicalCorrectionInnerReason,
} from "./technical-rejection-retryability.js";
import {
  VERIFICATION_RESULT_KEYS,
  VERIFICATION_COVERAGE_ENTRY_KEYS,
  FACT_INVENTORY_KEYS,
  FACT_INVENTORY_DIMENSION_KEYS,
  FACT_INVENTORY_FACT_KEYS,
} from "../execution/response-contract-keys.js";
// Key sets live in one dependency-free module.
export {
  VERIFICATION_RESULT_KEYS,
  VERIFICATION_COVERAGE_ENTRY_KEYS,
  FACT_INVENTORY_KEYS,
  FACT_INVENTORY_DIMENSION_KEYS,
  FACT_INVENTORY_FACT_KEYS,
} from "../execution/response-contract-keys.js";
import { normalizeRepositoryLocator } from "./repository-locator.js";
// The repository locator grammar lives in one leaf module, which plan source
// admission also reads without an import cycle.
export {
  normalizeRepositoryLocator,
  type NormalizedRepositoryLocator,
} from "./repository-locator.js";

export interface ReviewResult {
  verdict: "pass" | "needs-revision" | "human-review";
  issues: Array<Record<string, unknown>>;
}

export interface VerificationResult {
  review: ReviewResult;
  coverage: Array<{
    path: string;
    status: "verified" | "unverified";
    evidence: string[];
    reason: string;
  }>;
  factInventory: TechnicalFactInventory;
}

export type TechnicalFactDimension = (typeof TECHNICAL_FACT_DIMENSIONS)[number];

export interface TechnicalSourceFact {
  id: string;
  dimension: TechnicalFactDimension;
  sourceLocators: string[];
  statement: string;
  documentationDisposition:
    | "documented"
    | "omitted"
    | "conflicting"
    | "unverified-policy"
    | "product-defect";
  uncertainty: string;
  issueIds: string[];
}

export interface TechnicalFactDimensionAssessment {
  dimension: TechnicalFactDimension;
  status: "applicable" | "not-applicable" | "unverified";
  reason: string;
  sourceLocators: string[];
  facts: TechnicalSourceFact[];
}

export interface TechnicalFactInventory {
  completeness: "bounded-not-proven";
  dimensions: TechnicalFactDimensionAssessment[];
  limitations: string[];
}

export interface LegacyVerificationResult {
  review: ReviewResult;
  coverage: VerificationResult["coverage"];
}

export type ReviewResultSchemaValidator = (value: unknown) => SchemaValidation;

export type VerificationResultFailureStage =
  | "envelope"
  | "review"
  | "coverage"
  | "fact-inventory"
  | "consistency";

export class VerificationResultContractError extends InferenceStepError {
  public readonly stage: VerificationResultFailureStage;

  public constructor(input: {
    stage: VerificationResultFailureStage;
    message: string;
    retryable?: boolean;
  }) {
    super(input.message, "malformed-response", input.retryable ?? true);
    this.stage = input.stage;
    this.name = "VerificationResultContractError";
  }
}

const REVIEW_WORKFLOWS = new Set([
  "review-documentation",
  "create-documentation",
  "update-documentation",
  "restructure-documentation",
]);

const UNSAFE_LOCATION_PATH = /(?:^|[\/\s(])\.\.(?:\/|$)|^(?:\/|[A-Za-z]:[\\/])/u;
const FACT_ID = /^[A-Z][A-Z0-9_-]{0,63}$/u;
const ISSUE_ID = /^[A-Z]+-[0-9]{3}$/u;

export const REVIEW_VERDICTS = [
  "pass",
  "needs-revision",
  "human-review",
] as const satisfies readonly ReviewResult["verdict"][];

export type ObligationRejectionCode = (typeof OBLIGATION_REJECTION_CODES)[number];

/**
 * The closed reasons the host demotes an applicable ledger dimension to
 * unverified; the demoted dimension's host-authored reason names one.
 */
export const DIMENSION_DEMOTION_REASONS = ["all-obligations-rejected-with-evidence"] as const;

export type DimensionDemotionReason = (typeof DIMENSION_DEMOTION_REASONS)[number];

/**
 * Closed codes and locations for a substantive all-reject the host still
 * refuses to demote. Each is a model-correctable rule the applicable-dimension
 * rule states.
 */
export const DIMENSION_DEMOTION_REJECTIONS = Object.freeze({
  unresolvedEvidence: Object.freeze({
    code: "demotion-evidence-unresolved",
    location: "$.obligationJudgments[].evidenceLocators[]",
  }),
  singleLine: Object.freeze({
    code: "demotion-evidence-single-line",
    location: "$.obligationJudgments[].evidenceLocators",
  }),
  everyApplicableDimension: Object.freeze({
    code: "demotion-every-applicable-dimension",
    location: "$.obligationJudgments",
  }),
});

const MAX_FACTS = 256;
const MAX_FACTS_PER_DIMENSION = 128;
const MAX_LOCATORS = 64;

export const TECHNICAL_REVIEW_REJECTION_CODES = [
  "invalid-json",
  "invalid-shape",
  "unsafe-disclosure",
  "invalid-review",
  "invalid-coverage",
  "invalid-fact-inventory",
  "inconsistent-verdict",
  "invalid-accounting",
  "invalid-fact-link",
  "bounds-exceeded",
  "source-authority",
  "target-authority",
  "unknown",
] as const;

export type TechnicalReviewRejectionCode = (typeof TECHNICAL_REVIEW_REJECTION_CODES)[number];

export interface TechnicalReviewFailureProjection {
  readonly message: string;
  readonly category: "malformed-response";
  readonly retryable: boolean;
}

/**
 * Closed parse-budget facts for an invalid-json technical response. Integers
 * only; `finishReason` is a provider token or `absent`. Never model prose or
 * credential material.
 */
export interface TechnicalParseBudget {
  readonly outputAllowance: number;
  readonly outputTokens: number;
  readonly finishReason: string;
}

type TechnicalResponseKind = "review" | "correction";
type TechnicalResponseFormat = "empty" | "object-like" | "array-like" | "fenced" | "other";

const CLOSED_FINISH_REASON = /^[a-z][a-z0-9_]{0,31}$/u;

export type InventoryFailureDetail =
  | "shape"
  | "completeness"
  | "dimension-shape"
  | "dimension-count"
  | "dimension-reason"
  | "dimension-identity"
  | "dimension-status"
  | "dimension-facts"
  | "dimension-locators"
  | "limitation-link"
  | "fact-identity"
  | "fact-shape"
  | "fact-text"
  | "fact-dimension"
  | "fact-locators"
  | "fact-disposition"
  | "fact-finding-link";

/**
 * A closed host-authored code and the response-contract location it applies
 * to, never a value from the response. Locations are relative to the
 * verification result object or, for correction-only rules, to the correction
 * envelope.
 */
export interface TechnicalRejectionInner {
  readonly code: string;
  readonly location: string;
}

interface TechnicalReviewFailureState {
  readonly kind?: TechnicalResponseKind;
  /** The inner validator reason, when the raising site names one. */
  readonly inner?: TechnicalRejectionInner;
  /**
   * Where the validated object sits in the reply when nested, such as
   * `$.verificationResult`; contract locations are rebased onto it.
   */
  readonly locationBase?: string;
  readonly parserCode?: JsonEvidenceErrorCode;
  readonly parserDetail?: JsonEvidenceSyntaxDetail;
  readonly inventoryDetail?: InventoryFailureDetail;
  readonly responseFormat?: TechnicalResponseFormat;
  readonly rejectionCode: TechnicalReviewRejectionCode;
  readonly retryable: boolean;
  /** Host-authored limit refusal. Never model text. */
  readonly hostDetail?: string;
  /** Present only on an invalid-json parse that carried request/usage facts. */
  readonly parseBudget?: TechnicalParseBudget;
  /**
   * Judgment links to obligation IDs the sealed ledger never issued. Only
   * identifier-shaped values are kept; they feed the retry hint and never reach
   * the error message or the run record.
   */
  readonly unknownObligationIds?: {
    readonly named: readonly string[];
    readonly withheld: number;
  };
  /**
   * Applicable ledger dimensions whose every obligation a judgment rejected,
   * in ledger order. Host vocabulary only; feeds the bounded retry.
   */
  readonly emptiedApplicableDimensions?: readonly TechnicalFactDimension[];
}

const technicalReviewFailureStates = new WeakMap<InferenceStepError, TechnicalReviewFailureState>();
const technicalReviewRetainedFindings = new WeakMap<InferenceStepError, ReviewResult>();

export const REVIEW_ISSUE_LOCATION_REJECTION = Object.freeze({
  code: "review-issue-location-unsafe",
  location: "$.review.issues[].location",
});

export const UNKNOWN_OBLIGATION_LINK_REJECTION = Object.freeze({
  code: "fact-link-unknown-obligation",
  location: "$.issueJudgments[].obligationIds[]",
});

/**
 * A judgment rejected every obligation of an applicable ledger dimension, so
 * the derived inventory has an applicable dimension with no facts. The code is
 * the fact-inventory rule; the location is the judgment member, because a
 * judgment reply never carries `factInventory`.
 */
export const EMPTIED_APPLICABLE_DIMENSION_REJECTION = Object.freeze({
  code: "inventory-dimension-facts",
  location: "$.obligationJudgments",
} as const satisfies {
  code: `inventory-${InventoryFailureDetail}`;
  location: string;
});

/**
 * The coded reason an attempt record keeps for a technical rejection: the
 * parser's syntax detail, the unknown-obligation link, the fact-inventory
 * detail, the raising site's inner reason, or, as the last resort, the outer
 * code at `$response`.
 */
function technicalRejectionDetail(state: TechnicalReviewFailureState) {
  if (state.parserDetail) return { code: `json-${state.parserDetail}`, location: "$response" };
  if (state.parserCode) return { code: `json-${state.parserCode}`, location: "$response" };
  if (state.unknownObligationIds) return { ...UNKNOWN_OBLIGATION_LINK_REJECTION };
  if (state.emptiedApplicableDimensions) return { ...EMPTIED_APPLICABLE_DIMENSION_REJECTION };
  const rebase = (location: string): string =>
    state.locationBase === undefined || !location.startsWith("$")
      ? location
      : `${state.locationBase}${location.slice(1)}`;
  if (state.inventoryDetail)
    return {
      code: `inventory-${state.inventoryDetail}`,
      location: rebase("$.factInventory"),
    };
  if (state.inner) return { code: state.inner.code, location: rebase(state.inner.location) };
  return {
    code: state.rejectionCode,
    location: state.locationBase ?? "$response",
  };
}

function closedFinishReason(value: unknown): string {
  if (value === "absent") return "absent";
  return typeof value === "string" && CLOSED_FINISH_REASON.test(value) ? value : "absent";
}

function admitTechnicalParseBudget(
  value: TechnicalParseBudget | undefined,
): TechnicalParseBudget | undefined {
  if (!value) return undefined;
  if (!Number.isInteger(value.outputAllowance) || value.outputAllowance < 0) return undefined;
  if (!Number.isInteger(value.outputTokens) || value.outputTokens < 0) return undefined;
  return {
    outputAllowance: value.outputAllowance,
    outputTokens: value.outputTokens,
    finishReason: closedFinishReason(value.finishReason),
  };
}

function technicalParseBudgetClause(budget: TechnicalParseBudget): string {
  return (
    ` Output allowance ${budget.outputAllowance};` +
    ` observed output tokens ${budget.outputTokens};` +
    ` finish reason ${budget.finishReason}.`
  );
}

function readTechnicalParseBudget(
  evidence: InferenceStepError["evidence"] | undefined,
): TechnicalParseBudget | undefined {
  if (!evidence) return undefined;
  const outputTokens = evidence.usage?.output;
  if (!Number.isInteger(outputTokens) || outputTokens === undefined || outputTokens < 0) {
    return undefined;
  }
  const turns = evidence.turns;
  const lastTurn =
    Array.isArray(turns) && turns.length > 0
      ? ([...turns].reverse().find((turn) => turn.decision !== "stop") ?? turns.at(-1))
      : undefined;
  const allowance =
    lastTurn?.requestedOutputTokens ??
    lastTurn?.effectiveMaxOutputTokens ??
    evidence.model?.profile?.effectiveMaxOutputTokens;
  if (!Number.isInteger(allowance) || allowance === undefined || allowance < 0) return undefined;
  return {
    outputAllowance: allowance,
    outputTokens,
    finishReason: closedFinishReason(lastTurn?.rawStopReason),
  };
}

function technicalFailureMessage(state: TechnicalReviewFailureState): string {
  const detail = state.parserCode
    ? ` Strict JSON: ${state.parserCode}; response format: ${state.responseFormat}.`
    : "";
  const budget = state.parseBudget ? technicalParseBudgetClause(state.parseBudget) : "";
  const host = state.hostDetail ? ` ${state.hostDetail}` : "";
  return `Technical ${state.kind ?? "review"} response rejected: ${state.rejectionCode}.${detail}${budget}${host}`;
}

/**
 * A reply that is not framed as the JSON object at all (prose, an array, or
 * nothing) is the `unframed-reply` condition, whose retry tells the model to
 * return only the object. Derived from the parse state, so every rebuild from
 * that state keeps it.
 */
function technicalFailureCondition(state: TechnicalReviewFailureState): {
  readonly condition?: "unframed-reply";
} {
  return state.responseFormat === "other" ||
    state.responseFormat === "array-like" ||
    state.responseFormat === "empty"
    ? { condition: "unframed-reply" }
    : {};
}

class TechnicalReviewResponseError extends InferenceStepError {
  public constructor(state: TechnicalReviewFailureState) {
    super(
      technicalFailureMessage(state),
      "malformed-response",
      state.retryable,
      undefined,
      technicalRejectionDetail(state),
      technicalFailureCondition(state),
    );
    this.name = "TechnicalReviewResponseError";
    technicalReviewFailureStates.set(this, Object.freeze({ ...state }));
  }
}

function rejectTechnicalReview(
  rejectionCode: TechnicalReviewRejectionCode,
  retryable = false,
  retained?: ReviewResult,
  inventoryDetail?: InventoryFailureDetail,
  inner?: TechnicalRejectionInner,
): never {
  const error = new TechnicalReviewResponseError({
    rejectionCode,
    retryable,
    inventoryDetail,
    ...(inner ? { inner } : {}),
  });
  rememberRetainedFindings(error, retained);
  throw error;
}

/**
 * A fact-inventory defect, raised here by both the provisional and correction
 * steps with retryability from the shared table.
 */
function rejectFactInventory(
  kind: TechnicalResponseKind,
  inventoryDetail: InventoryFailureDetail,
): never {
  throw new TechnicalReviewResponseError({
    kind,
    rejectionCode: "invalid-fact-inventory",
    retryable: isModelCorrectableTechnicalRejection(`inventory-${inventoryDetail}`),
    inventoryDetail,
  });
}

/**
 * A correction-only refusal. Retryability comes from
 * `technical-rejection-retryability.ts`, keyed by the inner reason when named
 * and the outer code otherwise; security and authority refusals stay terminal
 * there. Without `inner`, the record keeps only the outer code, at `$response`.
 */
export function rejectTechnicalCorrection(
  rejectionCode: TechnicalReviewRejectionCode,
  hostDetail?: string,
  inner?: TechnicalCorrectionInnerReason,
): never {
  throw new TechnicalReviewResponseError({
    kind: "correction",
    rejectionCode,
    retryable: isModelCorrectableTechnicalRejection(inner?.code ?? rejectionCode),
    ...(hostDetail ? { hostDetail } : {}),
    ...(inner ? { inner } : {}),
  });
}

/**
 * Obligation ID shape the host may echo in a retry hint. It admits no
 * whitespace, quotes, or markup, so a cited value cannot carry prose.
 * Credential-shaped replies never get this far: the judgment envelope refuses
 * them as `unsafe-disclosure` before host fill.
 */
export const ECHOABLE_OBLIGATION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;

/**
 * A judgment linked obligation IDs the sealed ledger never issued, under the
 * outer `invalid-fact-link` code. Model-correctable: the host knows the valid
 * set, so the retry names the unknown IDs and that set.
 */
export function rejectUnknownObligationLinks(citedUnknownIds: readonly string[]): never {
  const distinct = [...new Set(citedUnknownIds)];
  const named = distinct.filter((id) => ECHOABLE_OBLIGATION_ID.test(id));
  throw new TechnicalReviewResponseError({
    kind: "correction",
    rejectionCode: "invalid-fact-link",
    retryable: isModelCorrectableTechnicalRejection(UNKNOWN_OBLIGATION_LINK_REJECTION.code),
    unknownObligationIds: Object.freeze({
      named: Object.freeze(named),
      withheld: distinct.length - named.length,
    }),
  });
}

/**
 * A judgment-fill rule declared in `config/model-output/rules/technical-judgment.yaml`.
 * Its retry disposition, hint, and failure class come from the catalog, not
 * the retryability table.
 */
export function rejectTechnicalJudgment(
  rejection: OutputRuleRejection<RuleCodeOf<"technical-judgment">>,
  // A link rule keeps `invalid-fact-link`; a rule about a fact's own member
  // names the inventory.
  rejectionCode: "invalid-fact-link" | "invalid-fact-inventory" = "invalid-fact-link",
): never {
  throw new TechnicalReviewResponseError({
    kind: "correction",
    rejectionCode,
    retryable: OUTPUT_RULES[rejection.code].retry === "model-correctable",
    inner: { code: rejection.code, location: rejection.location },
  });
}

/**
 * Closed codes and contract locations for an issue judgment whose severity or
 * category is outside the host vocabulary.
 */
export const ISSUE_JUDGMENT_VOCABULARY_REJECTIONS = Object.freeze({
  severity: Object.freeze({
    code: "judgment-severity-invalid",
    location: "$.issueJudgments[].severity",
  }),
  category: Object.freeze({
    code: "judgment-category-invalid",
    location: "$.issueJudgments[].category",
  }),
});

export type TechnicalRejectionReasonCode =
  | TechnicalReviewRejectionCode
  | `inventory-${InventoryFailureDetail}`
  | FactLinkRejectionCode
  | (typeof UNKNOWN_OBLIGATION_LINK_REJECTION)["code"]
  | (typeof ISSUE_JUDGMENT_VOCABULARY_REJECTIONS)[keyof typeof ISSUE_JUDGMENT_VOCABULARY_REJECTIONS]["code"]
  | (typeof DIMENSION_DEMOTION_REJECTIONS)[keyof typeof DIMENSION_DEMOTION_REJECTIONS]["code"]
  | (typeof FACT_INVENTORY_LIMITATION_BOUND_REJECTION)["code"]
  | TechnicalCorrectionByteBoundCode;

/**
 * Fails to typecheck unless `technical-rejection-retryability.ts` classifies
 * exactly the closed reason set.
 */
export const TECHNICAL_REJECTION_RETRYABILITY_COVERAGE: [TechnicalRejectionReasonCode] extends [
  ClassifiedTechnicalRejectionReason,
]
  ? [ClassifiedTechnicalRejectionReason] extends [TechnicalRejectionReasonCode]
    ? true
    : never
  : never = true;

/**
 * An issue judgment named a severity or category outside the host vocabulary.
 * Model-correctable: the retry hint repeats the allowed values, never the
 * rejected value.
 */
export function rejectIssueJudgmentVocabulary(
  field: keyof typeof ISSUE_JUDGMENT_VOCABULARY_REJECTIONS,
): never {
  const inner = ISSUE_JUDGMENT_VOCABULARY_REJECTIONS[field];
  throw new TechnicalReviewResponseError({
    kind: "correction",
    rejectionCode: "invalid-review",
    retryable: isModelCorrectableTechnicalRejection(inner.code),
    inner: { ...inner },
  });
}

/**
 * The host-built judgment inventory would exceed
 * `factInventory.maxLimitations`. Each rejected obligation adds one, so a
 * fitting reply would retain obligations the source does not establish. It is
 * terminal and names the limit, observed count, and operator remediation.
 */
export const FACT_INVENTORY_LIMITATION_BOUND_REJECTION = Object.freeze({
  code: "fact-inventory-limitations-exceeded",
  location: "$.obligationJudgments",
});

/**
 * `location` is the member that added the rejections: `$.obligationJudgments`
 * for a judgment reply, `$.obligationAccounting` for a reply that writes its
 * own accounting.
 */
export function rejectFactInventoryLimitationBound(
  hostDetail: string,
  location: "$.obligationJudgments" | "$.obligationAccounting",
): never {
  throw new TechnicalReviewResponseError({
    kind: "correction",
    rejectionCode: "bounds-exceeded",
    retryable: isModelCorrectableTechnicalRejection(FACT_INVENTORY_LIMITATION_BOUND_REJECTION.code),
    hostDetail,
    inner: { code: FACT_INVENTORY_LIMITATION_BOUND_REJECTION.code, location },
  });
}

export {
  TECHNICAL_CORRECTION_BYTE_BOUNDS,
  type TechnicalCorrectionByteBound,
  type TechnicalCorrectionByteBoundCode,
};

/**
 * A technical-correction record over one of its byte bounds that the scope,
 * not the reply, must change: the host built it, or the host-filled coverage
 * for the scope alone is over the bound. Terminal; `hostDetail` names the
 * bound, the observed bytes, the scope, and the remediation.
 */
export function rejectTechnicalCorrectionHostBound(
  bound: TechnicalCorrectionByteBound,
  hostDetail: string,
): never {
  const { code } = TECHNICAL_CORRECTION_BYTE_BOUNDS[bound];
  throw new TechnicalReviewResponseError({
    kind: "correction",
    rejectionCode: "bounds-exceeded",
    retryable: isModelCorrectableTechnicalRejection(code),
    hostDetail,
    inner: { code, location: "$response" },
  });
}

/**
 * A substantive all-reject the host still refuses to demote: a fact-inventory
 * rule, because demotion decides a dimension's status. No model value reaches
 * the retry hint.
 */
export function rejectDimensionDemotion(reason: keyof typeof DIMENSION_DEMOTION_REJECTIONS): never {
  const inner = DIMENSION_DEMOTION_REJECTIONS[reason];
  throw new TechnicalReviewResponseError({
    kind: "correction",
    rejectionCode: "invalid-fact-inventory",
    retryable: isModelCorrectableTechnicalRejection(inner.code),
    inner: { ...inner },
  });
}

/**
 * The host repair for a rejected technical response, when its rule names one.
 * Reads only host-owned private state that survives the correction and harness
 * wraps; returns `undefined` for every other failure.
 */
export function technicalResponseCorrection(
  error: unknown,
): UnknownObligationIdsCorrection | EmptiedApplicableDimensionsCorrection | undefined {
  const state =
    error instanceof InferenceStepError ? technicalReviewFailureStates.get(error) : undefined;
  if (state?.emptiedApplicableDimensions) {
    return Object.freeze({
      kind: "emptied-applicable-dimensions" as const,
      dimensions: state.emptiedApplicableDimensions,
    });
  }
  if (!state?.unknownObligationIds) return undefined;
  return Object.freeze({
    kind: "unknown-obligation-ids" as const,
    unknownObligationIds: state.unknownObligationIds.named,
    withheldCount: state.unknownObligationIds.withheld,
  });
}

/**
 * A judgment rejected every obligation of each named applicable ledger
 * dimension: the `dimension-facts` inventory defect, recorded at
 * `$.obligationJudgments`. The retry names the dimensions.
 */
export function rejectEmptiedApplicableDimensions(
  dimensions: readonly TechnicalFactDimension[],
): never {
  throw new TechnicalReviewResponseError({
    kind: "correction",
    rejectionCode: "invalid-fact-inventory",
    retryable: isModelCorrectableTechnicalRejection(EMPTIED_APPLICABLE_DIMENSION_REJECTION.code),
    inventoryDetail: "dimension-facts",
    emptiedApplicableDimensions: Object.freeze([...dimensions]),
  });
}

/**
 * Preserve only host-owned private state, never a supplied error's message or
 * fields. The retry classification made where the defect was found survives
 * the correction wrap.
 *
 * A failure without host-owned state records the boundary's `fallback` code.
 * It is retried only when it is a host contract refusal that reports itself
 * repairable and the table classifies `fallback` as model-correctable. A host
 * exception, or a refusal its raiser marked terminal, is never retried.
 */
export function rejectTechnicalCorrectionFailure(
  error: unknown,
  fallback: TechnicalReviewRejectionCode,
  locationBase?: string,
): never {
  const state =
    error instanceof InferenceStepError ? technicalReviewFailureStates.get(error) : undefined;
  throw new TechnicalReviewResponseError({
    ...(state ?? { rejectionCode: fallback }),
    ...(locationBase !== undefined && state?.locationBase === undefined ? { locationBase } : {}),
    kind: "correction",
    retryable: state
      ? state.retryable ||
        (state.rejectionCode === "unknown" && isModelCorrectableTechnicalRejection("unknown"))
      : error instanceof InferenceStepError &&
        error.retryable &&
        isModelCorrectableTechnicalRejection(fallback),
  });
}

export function technicalCorrectionBoundary<T>(
  code: TechnicalReviewRejectionCode,
  run: () => T,
  /** Where the object `run` validates sits in the reply, when nested. */
  locationBase?: string,
): T {
  try {
    return run();
  } catch (error) {
    return rejectTechnicalCorrectionFailure(error, code, locationBase);
  }
}

/** Classifications describe framing only; they never admit or extract model content. */
export function parseTechnicalResponse(
  response: string,
  kind: TechnicalResponseKind,
  parseBudget?: TechnicalParseBudget,
): JsonEvidenceValue {
  try {
    // Same unwrap as `decodeSourceObligationResponse`: a fenced or
    // prose-wrapped object is a common provider shape. `jsonEnvelopeBody`
    // returns the reply untouched when the envelope is absent or ambiguous, so
    // every refusal keeps its code.
    return parseJsonEvidence(jsonEnvelopeBody(response));
  } catch (error) {
    const parserCode = error instanceof JsonEvidenceError ? error.code : "malformed-json";
    const trimmed = response.trimStart();
    const responseFormat: TechnicalResponseFormat = !trimmed
      ? "empty"
      : trimmed.startsWith("```")
        ? "fenced"
        : trimmed.startsWith("{")
          ? "object-like"
          : trimmed.startsWith("[")
            ? "array-like"
            : "other";
    const admittedBudget = admitTechnicalParseBudget(parseBudget);
    throw new TechnicalReviewResponseError({
      kind,
      rejectionCode: "invalid-json",
      // A prose, array, or empty reply is correctable too: its format makes it
      // the `unframed-reply` condition, whose retry asks for only the object.
      retryable: isModelCorrectableTechnicalRejection("invalid-json"),
      parserCode,
      ...(error instanceof JsonEvidenceError && error.detail ? { parserDetail: error.detail } : {}),
      responseFormat,
      ...(admittedBudget ? { parseBudget: admittedBudget } : {}),
    });
  }
}

export function projectTechnicalReviewFailure(error: unknown): TechnicalReviewFailureProjection {
  const state =
    error instanceof InferenceStepError ? technicalReviewFailureStates.get(error) : undefined;
  if (state && TECHNICAL_REVIEW_REJECTION_CODES.includes(state.rejectionCode)) {
    return Object.freeze({
      message: technicalFailureMessage(state),
      category: "malformed-response",
      retryable: state.retryable,
    });
  }
  return Object.freeze({
    message: "Technical review response rejected: unknown.",
    category: "malformed-response",
    retryable: true,
  });
}

/** Host-owned findings already admitted from a rejected envelope; never raw model prose. */
export function retainedTechnicalReviewFindings(error: unknown): ReviewResult | undefined {
  return error instanceof InferenceStepError
    ? technicalReviewRetainedFindings.get(error)
    : undefined;
}

/**
 * Rebuild a closed malformed-response error without dropping safely parsed
 * findings. Callers may attach attempt evidence; they must not copy the
 * rejected response body.
 */
export function wrapTechnicalReviewFailure(
  error: unknown,
  evidence?: InferenceStepError["evidence"],
): InferenceStepError {
  const state =
    error instanceof InferenceStepError ? technicalReviewFailureStates.get(error) : undefined;
  const parseBudget =
    state?.rejectionCode === "invalid-json"
      ? (state.parseBudget ?? readTechnicalParseBudget(evidence))
      : undefined;
  const enriched =
    state && parseBudget && state.parseBudget !== parseBudget
      ? Object.freeze({ ...state, parseBudget })
      : state;
  const failure =
    enriched && TECHNICAL_REVIEW_REJECTION_CODES.includes(enriched.rejectionCode)
      ? Object.freeze({
          message: technicalFailureMessage(enriched),
          category: "malformed-response" as const,
          retryable: enriched.retryable,
        })
      : projectTechnicalReviewFailure(error);
  const wrapped = new InferenceStepError(
    failure.message,
    failure.category,
    failure.retryable,
    evidence,
    enriched ? technicalRejectionDetail(enriched) : undefined,
    enriched ? technicalFailureCondition(enriched) : inferenceFailureConditionOf(error),
  );
  copyRetainedTechnicalReviewState(error, wrapped);
  if (enriched) technicalReviewFailureStates.set(wrapped, enriched);
  return wrapped;
}

/** Preserve closed rejection state and safely parsed findings across host wraps. */
export function copyRetainedTechnicalReviewState(
  from: unknown,
  to: InferenceStepError,
  /**
   * The wrapping host's retryability, when it differs from the raiser's. A
   * wrap that declines a retry the raiser allowed must pass `false`, or
   * `projectTechnicalReviewFailure` keeps reporting the raiser's `retryable`.
   */
  retryable?: boolean,
): InferenceStepError {
  const state =
    from instanceof InferenceStepError ? technicalReviewFailureStates.get(from) : undefined;
  if (state) {
    technicalReviewFailureStates.set(
      to,
      retryable === undefined || retryable === state.retryable
        ? state
        : Object.freeze({ ...state, retryable }),
    );
  }
  rememberRetainedFindings(to, retainedTechnicalReviewFindings(from));
  return to;
}

function rememberRetainedFindings(error: InferenceStepError, retained?: ReviewResult): void {
  if (retained) technicalReviewRetainedFindings.set(error, retained);
}

/**
 * Admit only a disclosure-safe review object from a rejected envelope.
 * Invalid JSON, credentials, and unsound issues are dropped.
 */
export function retainSafeReviewFindings(value: unknown): ReviewResult | undefined {
  try {
    classifyTechnicalReviewFailure(
      "unsafe-disclosure",
      () => {
        kit.assertInert(value);
        assertReviewResponseDisclosure(value);
      },
      false,
    );
  } catch {
    return undefined;
  }
  const root =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  if (!root) return undefined;
  const candidate = Object.prototype.hasOwnProperty.call(root, "review") ? root.review : root;
  try {
    validateTechnicalReview(candidate, defaultReviewResultSchemaValidator);
    const review = candidate as ReviewResult;
    assertVerdictConsistency(review);
    return structuredClone(review);
  } catch {
    return undefined;
  }
}

/** Read a closed diagnostic from an existing saved error without trusting arbitrary text. */
export function technicalResponseDiagnosticFromMessage(message: unknown): string | undefined {
  if (typeof message !== "string") return undefined;
  const match =
    /^Technical (review|correction) response rejected: ([a-z-]+)\.(?: Strict JSON: (invalid-utf8|malformed-json|duplicate-key|unsafe-number|noncanonical-json); response format: (empty|object-like|array-like|fenced|other)\.)?(?: Output allowance (\d+); observed output tokens (\d+); finish reason ([a-z][a-z0-9_]{0,31}|absent)\.)?$/u.exec(
      message,
    );
  if (
    !match ||
    !TECHNICAL_REVIEW_REJECTION_CODES.includes(match[2] as TechnicalReviewRejectionCode)
  )
    return undefined;
  if (match[3] && match[2] !== "invalid-json") return undefined;
  if ((match[5] || match[6] || match[7]) && match[2] !== "invalid-json") return undefined;
  return message;
}

function classifyTechnicalReviewFailure<T>(
  rejectionCode: TechnicalReviewRejectionCode,
  operation: () => T,
  retryable?: boolean,
): T {
  try {
    return operation();
  } catch (error) {
    if (
      error instanceof TechnicalReviewResponseError ||
      error instanceof VerificationResultContractError
    ) {
      throw error;
    }
    rejectTechnicalReview(
      rejectionCode,
      retryable ?? (error instanceof InferenceStepError ? error.retryable : true),
    );
  }
}

function fail(
  retryable = true,
  retained?: ReviewResult,
  /**
   * The rule the review result broke, at a location under the review result's
   * own root. A decoder that nests the result rebases it.
   */
  rejection?: InferenceRejectionReasonV1,
): never {
  const error = new InferenceStepError(
    "Review response did not satisfy the host-owned structured contract.",
    "malformed-response",
    retryable,
    undefined,
    rejection,
  );
  rememberRetainedFindings(error, retained);
  throw error;
}

/**
 * Every contract-kit axis, mapped onto a refusal the review-result table
 * classifies; a new axis or unclassified code fails to typecheck.
 */
export const REVIEW_RESULT_KIT_CODES = Object.freeze({
  invalidShape: "invalid-shape",
  invalidValue: "invalid-value",
  digestMismatch: "digest-mismatch",
  credentialMaterial: "credential-material",
  schemaMismatch: "schema-mismatch",
  boundExceeded: "bounds-exceeded",
} as const satisfies Required<ContractKitCodes<ReviewResultRejectionCode>>);

/**
 * Raise a review-result contract refusal with the table's retryability, so a
 * credential in a review result stops the step instead of re-asking the model.
 */
export function rejectReviewResultContract(code: ReviewResultRejectionCode): never {
  // The kit names no finer location than the review result's root.
  return fail(isModelCorrectableReviewResultRejection(code), undefined, { code, location: "$" });
}

const kit = createContractKit<ReviewResultRejectionCode>({
  fail: (code) => rejectReviewResultContract(code),
  inertMode: "strict",
  codes: REVIEW_RESULT_KIT_CODES,
});

const defaultReviewResultSchemaValidator: ReviewResultSchemaValidator = (value) =>
  validateStagedQualityArtifact("review-result.schema.json", value);

export function requiresVerificationResult(
  input: Pick<HarnessStepInput, "step" | "workflow">,
): boolean {
  return (
    input.step.skill === "verify-technical-accuracy" &&
    input.step.id !== "derive-source-obligations" &&
    REVIEW_WORKFLOWS.has(input.workflow.name)
  );
}

export function requiresEditorialReviewResult(
  input: Pick<HarnessStepInput, "step" | "workflow">,
): boolean {
  return input.step.skill === "review-documentation" && REVIEW_WORKFLOWS.has(input.workflow.name);
}

export function validateVerificationResult(
  value: unknown,
  targetPaths?: readonly string[],
  validateReviewResult: ReviewResultSchemaValidator = defaultReviewResultSchemaValidator,
): VerificationResult {
  try {
    const root = verificationBoundary("envelope", "invalid-shape", () => {
      classifyTechnicalReviewFailure("invalid-shape", () => kit.assertInert(value));
      classifyTechnicalReviewFailure(
        "unsafe-disclosure",
        () => assertReviewResponseDisclosure(value),
        isModelCorrectableTechnicalRejection("unsafe-disclosure"),
      );
      const candidate = kit.object(value);
      kit.exact(candidate, VERIFICATION_RESULT_KEYS);
      return candidate;
    });
    verificationBoundary("review", "invalid-review", () =>
      validateTechnicalReview(root.review, validateReviewResult),
    );
    const review = root.review as VerificationResult["review"];
    const unverifiedCoverage = verificationBoundary("coverage", "invalid-coverage", () =>
      validateCoverage(root.coverage, targetPaths),
    );
    const factInventory = verificationBoundary("fact-inventory", "invalid-fact-inventory", () =>
      validateFactInventory(root.factInventory, review),
    );
    verificationBoundary("consistency", "inconsistent-verdict", () => {
      if ((unverifiedCoverage || factInventory.unverified) && review.verdict !== "human-review") {
        fail();
      }
      assertVerdictConsistency(review);
    });
    return structuredClone(root) as unknown as VerificationResult;
  } catch (error) {
    if (error instanceof InferenceStepError) {
      rememberRetainedFindings(error, retainSafeReviewFindings(value));
    }
    throw error;
  }
}

/** The verification-result member each validation stage guards. */
const VERIFICATION_STAGE_LOCATIONS: Readonly<Record<VerificationResultFailureStage, string>> = {
  envelope: "$",
  review: "$.review",
  coverage: "$.coverage",
  "fact-inventory": "$.factInventory",
  consistency: "$.review.verdict",
};

function verificationBoundary<T>(
  stage: VerificationResultFailureStage,
  rejectionCode: TechnicalReviewRejectionCode,
  run: () => T,
): T {
  try {
    return run();
  } catch (error) {
    const retryable = error instanceof InferenceStepError ? error.retryable : true;
    const message =
      stage === "envelope"
        ? "Technical verification response failed the fixed three-field envelope contract."
        : stage === "review"
          ? "Technical verification review failed the governed review schema contract."
          : stage === "coverage"
            ? "Technical verification coverage failed the authoritative target binding contract."
            : stage === "fact-inventory"
              ? "Technical verification fact inventory failed dimension or finding linkage validation."
              : "Technical verification verdict is inconsistent with unverified evidence or findings.";
    const failure = new VerificationResultContractError({
      stage,
      message,
      retryable,
    });
    const priorState =
      error instanceof InferenceStepError ? technicalReviewFailureStates.get(error) : undefined;
    const effectiveCode = priorState?.rejectionCode ?? rejectionCode;
    technicalReviewFailureStates.set(
      failure,
      Object.freeze({
        ...priorState,
        rejectionCode: effectiveCode,
        retryable,
        // A stage with no finer reason still names the member it guards.
        ...(priorState?.inner || priorState?.inventoryDetail || priorState?.parserCode
          ? {}
          : {
              inner: {
                code: effectiveCode,
                location: VERIFICATION_STAGE_LOCATIONS[stage],
              },
            }),
      }),
    );
    throw failure;
  }
}

/**
 * Decode only retained pre-inventory technical wrappers. New model responses
 * must go through validateVerificationResult and cannot use this compatibility
 * path to omit source coverage.
 */
export function validateLegacyVerificationResult(
  value: unknown,
  targetPaths?: readonly string[],
  validateReviewResult: ReviewResultSchemaValidator = defaultReviewResultSchemaValidator,
): LegacyVerificationResult {
  kit.assertInert(value);
  assertReviewResponseDisclosure(value);
  const root = kit.object(value);
  kit.exact(root, ["review", "coverage"]);
  validateReview(root.review, validateReviewResult);
  const review = root.review as LegacyVerificationResult["review"];
  const unverifiedCoverage = validateCoverage(root.coverage, targetPaths);
  if (unverifiedCoverage && review.verdict !== "human-review") fail();
  assertVerdictConsistency(review);
  return structuredClone(root) as unknown as LegacyVerificationResult;
}

function validateCoverage(value: unknown, targetPaths?: readonly string[]): boolean {
  const coverage = kit.array(value);
  if (coverage.length === 0) fail();
  const seen = new Set<string>();
  let unverified = false;
  for (const value of coverage) {
    const entry = kit.object(value);
    kit.exact(entry, VERIFICATION_COVERAGE_ENTRY_KEYS);
    if (
      typeof entry.path !== "string" ||
      !entry.path.trim() ||
      entry.path.startsWith("/") ||
      entry.path.includes("\\") ||
      entry.path.split("/").some((part) => !part || part === "." || part === "..") ||
      seen.has(entry.path)
    ) {
      fail();
    }
    seen.add(entry.path);
    if (entry.status !== "verified" && entry.status !== "unverified") fail();
    if (typeof entry.reason !== "string" || !entry.reason.trim()) fail();
    const evidence = kit.array(entry.evidence);
    if (
      evidence.some((item) => typeof item !== "string" || !item.trim()) ||
      new Set(evidence).size !== evidence.length
    ) {
      fail();
    }
    if (entry.status === "verified" && evidence.length === 0) fail();
    if (entry.status === "unverified") unverified = true;
  }
  if (
    targetPaths &&
    (seen.size !== new Set(targetPaths).size || targetPaths.some((path) => !seen.has(path)))
  ) {
    fail();
  }
  return unverified;
}

function inventoryCheck<T>(detail: InventoryFailureDetail, operation: () => T): T {
  try {
    return operation();
  } catch {
    return rejectFactInventory("review", detail);
  }
}

function validateFactInventory(value: unknown, review: ReviewResult): { unverified: boolean } {
  const inventory = inventoryCheck("shape", () => {
    const result = kit.object(value);
    kit.exact(result, FACT_INVENTORY_KEYS);
    return result;
  });
  if (inventory.completeness !== "bounded-not-proven")
    rejectFactInventory("review", "completeness");
  // No per-entry length bound on limitations: the host writes most of them,
  // and its coverage note over a large target list can exceed the per-entry
  // bound. The count bound stays.
  const limitations = validateDistinctTextArray(
    inventory.limitations,
    limit("factInventory.maxLimitations").value,
  );
  const dimensions = kit.array(inventory.dimensions);
  if (dimensions.length !== TECHNICAL_FACT_DIMENSIONS.length)
    rejectFactInventory("review", "dimension-count");
  const reviewIssueIds = new Set<string>();
  for (const issueValue of review.issues) {
    const issue = kit.object(issueValue);
    const id = boundedText(issue.id, 64);
    if (!ISSUE_ID.test(id) || reviewIssueIds.has(id)) fail();
    reviewIssueIds.add(id);
  }
  const seenDimensions = new Set<TechnicalFactDimension>();
  const seenFacts = new Set<string>();
  let factCount = 0;
  let unverified = false;
  for (const dimensionValue of dimensions) {
    const assessment = inventoryCheck("dimension-shape", () => {
      const result = kit.object(dimensionValue);
      kit.exact(result, FACT_INVENTORY_DIMENSION_KEYS);
      return result;
    });
    const dimension = assessment.dimension;
    if (
      typeof dimension !== "string" ||
      !TECHNICAL_FACT_DIMENSIONS.includes(dimension as TechnicalFactDimension) ||
      seenDimensions.has(dimension as TechnicalFactDimension)
    ) {
      rejectFactInventory("review", "dimension-identity");
    }
    seenDimensions.add(dimension as TechnicalFactDimension);
    const status = assessment.status;
    if (status !== "applicable" && status !== "not-applicable" && status !== "unverified") {
      rejectFactInventory("review", "dimension-status");
    }
    const reason = inventoryCheck("dimension-reason", () =>
      boundedText(assessment.reason, 2_048, 12),
    );
    const sourceLocators = inventoryCheck("dimension-locators", () =>
      validateSourceLocators(assessment.sourceLocators, false),
    );
    const facts = kit.array(assessment.facts);
    if (facts.length > MAX_FACTS_PER_DIMENSION) fail();
    if (status === "applicable") {
      if (facts.length === 0) rejectFactInventory("review", "dimension-facts");
      if (sourceLocators.length !== 0) rejectFactInventory("review", "dimension-locators");
    } else if (facts.length !== 0) {
      rejectFactInventory("review", "dimension-facts");
    } else if (status === "not-applicable" && sourceLocators.length === 0) {
      rejectFactInventory("review", "dimension-locators");
    } else if (status === "unverified") {
      unverified = true;
      if (!limitations.includes(reason)) rejectFactInventory("review", "limitation-link");
    }
    for (const factValue of facts) {
      const fact = inventoryCheck("fact-shape", () => {
        const result = kit.object(factValue);
        kit.exact(result, FACT_INVENTORY_FACT_KEYS);
        return result;
      });
      const id = inventoryCheck("fact-identity", () => boundedText(fact.id, 64));
      if (!FACT_ID.test(id) || seenFacts.has(id)) rejectFactInventory("review", "fact-identity");
      seenFacts.add(id);
      factCount += 1;
      if (factCount > MAX_FACTS) fail();
      if (fact.dimension !== dimension) rejectFactInventory("review", "fact-dimension");
      try {
        validateSourceLocators(fact.sourceLocators, true);
      } catch {
        rejectFactInventory("review", "fact-locators");
      }
      inventoryCheck("fact-text", () => {
        boundedText(fact.statement, 4_096, 8);
        boundedText(fact.uncertainty, 2_048, 1);
      });
      if (
        fact.documentationDisposition !== "documented" &&
        fact.documentationDisposition !== "omitted" &&
        fact.documentationDisposition !== "conflicting" &&
        fact.documentationDisposition !== "unverified-policy" &&
        fact.documentationDisposition !== "product-defect"
      ) {
        rejectFactInventory("review", "fact-disposition");
      }
      const issueIds = validateDistinctBoundedTextArray(fact.issueIds, 32).map((issueId) => {
        if (!ISSUE_ID.test(issueId) || !reviewIssueIds.has(issueId))
          rejectFactInventory("review", "fact-finding-link");
        return issueId;
      });
      if (fact.documentationDisposition === "documented") {
        if (issueIds.length !== 0) rejectFactInventory("review", "fact-finding-link");
      } else if (issueIds.length === 0) {
        rejectFactInventory("review", "fact-finding-link");
      }
    }
  }
  if (seenDimensions.size !== TECHNICAL_FACT_DIMENSIONS.length) fail();
  return { unverified };
}

function validateSourceLocators(value: unknown, requireNonEmpty: boolean): string[] {
  const locators = validateDistinctBoundedTextArray(value, MAX_LOCATORS);
  if (requireNonEmpty && locators.length === 0) fail();
  for (const locator of locators) {
    if (!normalizeRepositoryLocator(locator).specific) fail();
  }
  return locators;
}

function validateDistinctBoundedTextArray(value: unknown, maxItems: number): string[] {
  const values = kit.array(value);
  if (values.length > maxItems) fail();
  const result = values.map((item) => boundedText(item, 4_096));
  if (new Set(result).size !== result.length) fail();
  return result;
}

/** {@link validateDistinctBoundedTextArray} without the per-entry length bound. */
function validateDistinctTextArray(value: unknown, maxItems: number): string[] {
  const values = kit.array(value);
  if (values.length > maxItems) fail();
  const result = values.map((item) => boundedText(item, Number.POSITIVE_INFINITY));
  if (new Set(result).size !== result.length) fail();
  return result;
}

function boundedText(value: unknown, maxLength: number, minLength = 1): string {
  const result = kit.string(value);
  const trimmed = result.trim();
  if (result !== trimmed || trimmed.length < minLength || trimmed.length > maxLength) fail();
  return result;
}

/**
 * Whether one evidence `locator` field cites `locator`.
 *
 * A field holds one repository locator or a `;`-separated list. A locator
 * label may contain `;`, so splitting on `;` cannot recover it. The field
 * cites `locator` only when it is a specific locator that fills a whole run of
 * `;`-separated entries, ignoring whitespace around separators; a locator
 * inside a wider entry is not cited.
 */
export function evidenceCitesRepositoryLocator(field: string, locator: string): boolean {
  if (locator !== locator.trim() || !normalizeRepositoryLocator(locator).specific) return false;
  for (let at = field.indexOf(locator); at !== -1; at = field.indexOf(locator, at + 1)) {
    if (entryBoundary(field, at - 1, -1) && entryBoundary(field, at + locator.length, 1)) {
      return true;
    }
  }
  return false;
}

/** Whether only whitespace separates `index` from the field edge or a `;` in `step` direction. */
function entryBoundary(field: string, index: number, step: -1 | 1): boolean {
  for (let cursor = index; cursor >= 0 && cursor < field.length; cursor += step) {
    const character = field[cursor]!;
    if (character === ";") return true;
    if (character.trim() !== "") return false;
  }
  return true;
}

export function decodeVerificationResponse(
  response: string,
  targetPaths?: readonly string[],
  validateReviewResult: ReviewResultSchemaValidator = defaultReviewResultSchemaValidator,
): VerificationResult {
  try {
    const parsed = parseTechnicalResponse(response, "review");
    return validateVerificationResult(parsed, targetPaths, validateReviewResult);
  } catch (error) {
    if (error instanceof TechnicalReviewResponseError) {
      throw error;
    }
    if (error instanceof VerificationResultContractError) {
      const state = technicalReviewFailureStates.get(error);
      return rejectTechnicalReview(
        state?.rejectionCode ?? "unknown",
        state?.rejectionCode === "unknown" ? true : (state?.retryable ?? true),
        retainedTechnicalReviewFindings(error),
        state?.inventoryDetail,
        state?.inner,
      );
    }
    return rejectTechnicalReview("unknown", true);
  }
}

/**
 * Decode only byte-canonical current technical summaries admitted earlier in
 * this run.
 */
export function decodeAdmittedVerificationSummary(
  summary: string | undefined,
  targetPaths?: readonly string[],
): VerificationResult | undefined {
  if (typeof summary !== "string" || summary.trim() !== summary) return undefined;
  try {
    const verified = validateVerificationResult(parseJsonEvidence(summary), targetPaths);
    return canonicalizeJsonEvidence(verified as unknown as JsonEvidenceValue).trimEnd() === summary
      ? verified
      : undefined;
  } catch {
    return undefined;
  }
}

export function validateEditorialReviewResult(
  value: unknown,
  validateReviewResult: ReviewResultSchemaValidator = defaultReviewResultSchemaValidator,
): ReviewResult {
  kit.assertInert(value);
  assertReviewResponseDisclosure(value);
  validateReview(value, validateReviewResult);
  const review = value as ReviewResult;
  assertVerdictConsistency(
    review,
    rejectCorrectable("review-result", "review-result-verdict-issues", "$.verdict"),
  );
  return structuredClone(review);
}

export function decodeEditorialReviewResponse(
  response: string,
  validateReviewResult: ReviewResultSchemaValidator = defaultReviewResultSchemaValidator,
): ReviewResult {
  let parsed: JsonEvidenceValue | undefined;
  try {
    // Same unwrap as the two decoders above.
    parsed = parseJsonEvidence(jsonEnvelopeBody(response));
    return validateEditorialReviewResult(parsed, validateReviewResult);
  } catch (error) {
    const retained = parsed !== undefined ? retainSafeReviewFindings(parsed) : undefined;
    if (error instanceof InferenceStepError && !error.retryable) {
      rememberRetainedFindings(error, retained);
      throw error;
    }
    // The generic refusal, naming the rule it broke.
    return fail(true, retained, editorialReviewRejection(error));
  }
}

/**
 * The rule a retryable editorial review refusal broke, at a location under the
 * review result's root. The shared review validator names schema and
 * issue-locator rules under a verification result's `$.review`; an editorial
 * review result is the review itself, so those locations are rebased to `$`.
 */
function editorialReviewRejection(error: unknown): InferenceRejectionReasonV1 {
  if (error instanceof JsonEvidenceError) return { code: "invalid-json", location: "$" };
  if (error instanceof InferenceStepError && error.rejection) {
    const { code, location } = error.rejection;
    if (location === "$response" || location === "$.review") return { code, location: "$" };
    if (location.startsWith("$.review.") || location.startsWith("$.review[")) {
      return { code, location: `$${location.slice("$.review".length)}` };
    }
    return { code, location };
  }
  return { code: "unknown", location: "$" };
}

export function authoritativeReviewTargetPaths(
  input: Pick<
    HarnessStepInput,
    | "workflow"
    | "step"
    | "reviewScope"
    | "contextTarget"
    | "planBinding"
    | "verificationTargetPaths"
  >,
): readonly string[] | undefined {
  if (input.planBinding) return documentationPlanVerificationPaths(input.planBinding);
  if (input.reviewScope) return input.reviewScope.targetPaths;
  if (input.workflow.name === "review-documentation" && input.contextTarget) {
    return [input.contextTarget.sourcePath];
  }
  if (input.verificationTargetPaths) return input.verificationTargetPaths;
  return undefined;
}

/**
 * Where the step's review result sits in its response. `top-level` is the
 * ordinary review response. `editorial-summary` nests the result as the summary
 * of the update-documentation V2 editorial assessment envelope, so the step
 * prompt carries exactly one outer-shape statement: the envelope's.
 */
export type ReviewResponsePlacement = "top-level" | "editorial-summary";

export function bindReviewResponseContract(
  input: HarnessStepInput,
  placement: ReviewResponsePlacement = "top-level",
): HarnessStepInput {
  const verificationRequired = requiresVerificationResult(input);
  const nested = placement === "editorial-summary";
  const responseContract = verificationRequired
    ? nested
      ? NESTED_EDITORIAL_VERIFICATION_RESULT_CONTRACT
      : VERIFICATION_RESPONSE_CONTRACT
    : requiresEditorialReviewResult(input)
      ? nested
        ? NESTED_EDITORIAL_REVIEW_RESULT_CONTRACT
        : EDITORIAL_RESPONSE_CONTRACT
      : requiresTechnicalSynthesis(input)
        ? input.qualityAnswerRecords !== undefined
          ? RECORDS_TECHNICAL_SYNTHESIS_CONTRACT
          : TECHNICAL_SYNTHESIS_CONTRACT
        : undefined;
  if (!responseContract) return input;
  return {
    ...input,
    step: {
      ...input.step,
      prompt: [
        input.step.prompt,
        "",
        responseContract,
        ...(verificationRequired && verificationTargetContract(input)
          ? [verificationTargetContract(input)!]
          : []),
      ].join("\n"),
    },
  };
}

export function verificationTargetContract(
  input: Pick<
    HarnessStepInput,
    | "workflow"
    | "step"
    | "reviewScope"
    | "contextTarget"
    | "planBinding"
    | "verificationTargetPaths"
  >,
): string | undefined {
  const targetPaths = authoritativeReviewTargetPaths(input);
  return targetPaths
    ? `Authoritative verification target: ${JSON.stringify(targetPaths)}. Include every listed page exactly once in coverage, including retained pages. Do not include out-of-scope pages or source dependencies as coverage targets.`
    : undefined;
}

export function admitReviewResponse(input: HarnessStepInput, response: string): string {
  let admitted: VerificationResult | ReviewResult;
  if (requiresVerificationResult(input)) {
    admitted = decodeVerificationResponse(response, authoritativeReviewTargetPaths(input));
  } else if (requiresEditorialReviewResult(input)) {
    admitted = decodeEditorialReviewResponse(response);
  } else {
    return response.trim();
  }
  return canonicalizeJsonEvidence(admitted as unknown as JsonEvidenceValue).trimEnd();
}

function validateReview(
  value: unknown,
  validateReviewResult: ReviewResultSchemaValidator,
): asserts value is ReviewResult {
  validateReviewWithSchemaStatus(value, validateReviewResult(value));
}

function validateTechnicalReview(
  value: unknown,
  validateReviewResult: ReviewResultSchemaValidator,
): asserts value is ReviewResult {
  let schemaValidation: SchemaValidation;
  try {
    schemaValidation = validateReviewResult(value);
  } catch {
    return rejectTechnicalReview("unknown");
  }
  if (schemaValidation === "schema-unavailable") {
    return rejectTechnicalReview("invalid-review", false);
  }
  classifyTechnicalReviewFailure("invalid-review", () =>
    validateReviewWithSchemaStatus(value, schemaValidation),
  );
}

function validateReviewWithSchemaStatus(
  value: unknown,
  schemaValidation: SchemaValidation,
): asserts value is ReviewResult {
  if (schemaValidation === "schema-unavailable") {
    throw new InferenceStepError(
      "The host-owned review response schema could not be loaded.",
      "malformed-response",
      false,
      undefined,
      // A host fault, not a rule the reply broke.
      { code: "unknown", location: "$" },
    );
  }
  if (schemaValidation !== "valid") {
    // Name the first schema rule the review broke and where; a custom
    // validator the schema cannot explain falls back to the stage location.
    const mismatch = describeStagedQualityArtifactMismatch("review-result.schema.json", value);
    if (!mismatch) fail();
    rejectTechnicalReview("invalid-review", true, undefined, undefined, {
      code: `review-schema-${mismatch.keyword}`,
      location: `$.review${mismatch.location.slice(1)}`,
    });
  }
  const review = value as ReviewResult;
  for (const issue of review.issues) {
    if (!isSafeLocation(issue.location) || normalizeRepositoryLocator(issue.location).malformed) {
      rejectTechnicalReview("invalid-review", true, undefined, undefined, {
        ...REVIEW_ISSUE_LOCATION_REJECTION,
      });
    }
  }
}

function isSafeLocation(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 4096 &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !UNSAFE_LOCATION_PATH.test(value.trim())
  );
}

function assertReviewResponseDisclosure(value: unknown): void {
  kit.rejectCredentials(value);
}

function assertVerdictConsistency(
  review: ReviewResult,
  rejection?: InferenceRejectionReasonV1,
): void {
  if (review.verdict === "pass" && review.issues.length !== 0) fail(true, undefined, rejection);
  if (review.verdict === "needs-revision" && review.issues.length === 0) {
    fail(true, undefined, rejection);
  }
}

function requiresTechnicalSynthesis(input: Pick<HarnessStepInput, "step" | "workflow">): boolean {
  return (
    input.workflow.name === "review-documentation" &&
    input.step.skill === "evaluate-document-quality"
  );
}
