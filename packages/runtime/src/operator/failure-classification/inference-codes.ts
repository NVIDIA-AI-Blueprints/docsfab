// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Exhaustive inference codes and code-family precedence. */
import { type UNRETAINABLE_INFERENCE_REJECTIONS } from "../../config/inference-rejection-limits.js";

import { LIMIT_DEFINITIONS } from "../../config/limits.generated.js";
// Not model-output.js: it resolves limits when it loads, and this module must
// load to report a limits failure.
import { OUTPUT_RULE_FAILURE_CLASSES } from "../../contracts/model-output-failure-classes.js";
import { OUTPUT_RULES } from "../../contracts/model-output.generated.js";

import type { JsonEvidenceErrorCode, JsonEvidenceSyntaxDetail } from "../../json-evidence.js";

import type {
  InferenceAttemptModelTelemetryV1,
  InferenceFailureCategory,
  ProviderErrorClass,
} from "../../records/contracts.js";

import { type CompositionExecutionEvidenceErrorCode } from "../../records/composition-execution-error.js";

import type { EDITORIAL_ENVELOPE_SHAPE_REJECTION } from "../../harness/pi.js";
import type { EDITORIAL_LIMITATION_CODE_REJECTIONS } from "../../workflow-execution/editorial-evidence-host.js";
import type { CONTRACT_PLACEHOLDER_REJECTION_CODE } from "../../workflow-execution/contract-placeholders.js";
import type {
  InventoryFailureDetail,
  DIMENSION_DEMOTION_REJECTIONS,
  FACT_INVENTORY_LIMITATION_BOUND_REJECTION,
  ISSUE_JUDGMENT_VOCABULARY_REJECTIONS,
  REVIEW_ISSUE_LOCATION_REJECTION,
  TechnicalCorrectionByteBoundCode,
  TechnicalReviewRejectionCode,
  UNKNOWN_OBLIGATION_LINK_REJECTION,
} from "../../workflow-execution/review-response.js";
import type { FactLinkRejectionCode } from "../../workflow-execution/technical-rejection-retryability.js";
import type { SourceObligationRejectionCode } from "../../workflow-execution/source-obligation.js";

import { isFailureCode, type FailureClass } from "../failure-class.js";

/**
 * The class of each inference failure category, used when an attempt recorded
 * no coded rejection and no provider error that names a cause. `throttled` and
 * `provider-transient` are conditions HTTP marks as repeatable. `invalid-request`,
 * `timeout`, `blank-response`, and `provider-terminal` each cover several
 * causes, so they stay `unknown` unless the recorded provider error names one.
 */
export const INFERENCE_CATEGORY_FAILURE_CLASSES = Object.freeze({
  "blank-response": "unknown",
  "malformed-response": "contract-shape",
  "context-exhausted": "bound",
  timeout: "unknown",
  throttled: "flake",
  "provider-transient": "flake",
  "invalid-request": "unknown",
  "provider-terminal": "unknown",
  "host-runtime-failure": "infrastructure",
  // A host bound ended the attempt: unchanged re-reads, or the tool-call ceiling.
  "no-progress": "bound",
} as const satisfies Record<InferenceFailureCategory, FailureClass>);

/** Composition evidence is a sealed contract; these codes are type-specific. */
export const COMPOSITION_EVIDENCE_CLASS_BY_CODE = {
  "credential-material": "contract-shape",
  "digest-mismatch": "contract-shape",
  "invalid-shape": "contract-shape",
  "invalid-value": "contract-shape",
  "schema-mismatch": "contract-shape",
  "migration-required": "contract-shape",
  "subject-mismatch": "contract-shape",
} as const satisfies Record<CompositionExecutionEvidenceErrorCode, FailureClass>;

/**
 * Classes for a recorded provider error that carries a failing HTTP status.
 * `rate-limit`, `server`, and `timeout` are statuses HTTP marks as repeatable,
 * so they are `flake`. `invalid-request` covers several causes and
 * `content-filter` has no class, so both stay `unknown`.
 */
export const PROVIDER_STATUS_ERROR_FAILURE_CLASSES = Object.freeze({
  auth: "auth",
  "rate-limit": "flake",
  server: "flake",
  timeout: "flake",
  network: "unknown",
  "stream-incomplete": "unknown",
  "content-filter": "unknown",
  "invalid-request": "unknown",
  unknown: "unknown",
} as const satisfies Record<ProviderErrorClass, FailureClass>);

/**
 * Classes for a recorded provider error with no failing HTTP status: a stream
 * cut, socket failure, DNS failure, or an error event inside a 2xx stream.
 * The provider marked nothing repeatable, so `network`, `timeout`, and
 * `stream-incomplete` (a 2xx stream that closed before it finished) are
 * `infrastructure`, not `flake`. This module reads only the retained closed
 * class, never the provider's error text or an in-stream `streamErrorStatus`,
 * so a declared server error keeps its `provider-transient` category's class.
 */
export const PROVIDER_UNANSWERED_ERROR_FAILURE_CLASSES = Object.freeze({
  auth: "auth",
  "rate-limit": "flake",
  server: "unknown",
  timeout: "infrastructure",
  network: "infrastructure",
  "stream-incomplete": "infrastructure",
  "content-filter": "unknown",
  "invalid-request": "unknown",
  unknown: "unknown",
} as const satisfies Record<ProviderErrorClass, FailureClass>);

/**
 * The class and code a recorded provider error names, or `undefined` when it
 * names no class. The caller passes only telemetry the record's strict reader
 * admits.
 */
export function providerErrorFailure(
  telemetry: InferenceAttemptModelTelemetryV1,
): { readonly failureClass: FailureClass; readonly code: string } | undefined {
  const error = telemetry.providerError;
  if (!error) return undefined;
  const answered = error.httpStatus !== undefined;
  const failureClass = (
    answered ? PROVIDER_STATUS_ERROR_FAILURE_CLASSES : PROVIDER_UNANSWERED_ERROR_FAILURE_CLASSES
  )[error.class];
  if (failureClass === "unknown") return undefined;
  return {
    failureClass,
    code: answered ? `provider-http-${error.class}` : `provider-${error.class}`,
  };
}

/** Outer technical review and correction codes (`review-response.ts`). */
const TECHNICAL_REVIEW_REJECTION_CLASSES = {
  "invalid-json": "contract-shape",
  "invalid-shape": "contract-shape",
  "unsafe-disclosure": "model-content",
  "invalid-review": "model-content",
  "invalid-coverage": "model-content",
  "invalid-fact-inventory": "model-content",
  "inconsistent-verdict": "model-content",
  "invalid-accounting": "model-content",
  "invalid-fact-link": "model-content",
  "bounds-exceeded": "bound",
  "source-authority": "model-content",
  "target-authority": "model-content",
  unknown: "unknown",
} as const satisfies Record<TechnicalReviewRejectionCode, FailureClass>;

/** Source-obligation decoder codes (`source-obligation.ts`). */
const SOURCE_OBLIGATION_REJECTION_CLASSES = {
  "invalid-json": "contract-shape",
  "invalid-utf8": "contract-shape",
  "malformed-json": "contract-shape",
  "duplicate-key": "contract-shape",
  "unsafe-number": "contract-shape",
  "noncanonical-json": "contract-shape",
  "invalid-shape": "contract-shape",
  "unexpected-key-set": "contract-shape",
  "invalid-value": "contract-shape",
  "empty-required-field": "contract-shape",
  "bounds-exceeded": "bound",
  "incomplete-required-set": "model-content",
  "duplicate-entry": "model-content",
  "inconsistent-status": "model-content",
  "invalid-locator": "model-content",
  [OUTPUT_RULES["source-proposal-required"].code]:
    OUTPUT_RULES["source-proposal-required"].failureClass,
  [OUTPUT_RULES["source-proposal-refused"].code]:
    OUTPUT_RULES["source-proposal-refused"].failureClass,
  "unauthorized-source": "model-content",
  "digest-mismatch": "contract-shape",
  "stale-evidence": "contract-shape",
  "unsupported-identity": "contract-shape",
  "credential-material": "model-content",
  "host-path-disclosure": "model-content",
  unknown: "unknown",
} as const satisfies Record<SourceObligationRejectionCode, FailureClass>;

/** Fact-inventory details, recorded as `inventory-<detail>`. */
const INVENTORY_REJECTION_CLASSES = {
  "inventory-shape": "contract-shape",
  "inventory-completeness": "model-content",
  "inventory-dimension-shape": "contract-shape",
  "inventory-dimension-count": "model-content",
  "inventory-dimension-reason": "model-content",
  "inventory-dimension-identity": "model-content",
  "inventory-dimension-status": "model-content",
  "inventory-dimension-facts": "model-content",
  "inventory-dimension-locators": "model-content",
  "inventory-limitation-link": "model-content",
  "inventory-fact-identity": "model-content",
  "inventory-fact-shape": "contract-shape",
  "inventory-fact-text": "model-content",
  "inventory-fact-dimension": "model-content",
  "inventory-fact-locators": "model-content",
  "inventory-fact-disposition": "model-content",
  "inventory-fact-finding-link": "model-content",
} as const satisfies Record<`inventory-${InventoryFailureDetail}`, FailureClass>;

/**
 * Strict-JSON parser codes, recorded as `json-<code>` and `json-<detail>`.
 * `json-unexpected-end` can also mean a normally unclosed or empty reply, so it
 * is a shape failure; only a recorded finish reason proves a cut-off `bound`.
 */
const JSON_PARSE_REJECTION_CLASSES = {
  "json-invalid-utf8": "contract-shape",
  "json-malformed-json": "contract-shape",
  "json-duplicate-key": "contract-shape",
  "json-unsafe-number": "contract-shape",
  "json-noncanonical-json": "contract-shape",
  "json-unexpected-end": "contract-shape",
  "json-unexpected-token": "contract-shape",
  "json-invalid-escape": "contract-shape",
  "json-unescaped-control": "contract-shape",
  "json-unpaired-surrogate": "contract-shape",
} as const satisfies Record<
  `json-${JsonEvidenceErrorCode}` | `json-${JsonEvidenceSyntaxDetail}`,
  FailureClass
>;

/**
 * Inner codes each raising site exports as a named constant. The union is read
 * from those constants, so a new code does not typecheck until the table below
 * names it.
 */
type NamedInferenceRejectionCode =
  | typeof EDITORIAL_ENVELOPE_SHAPE_REJECTION
  | (typeof UNKNOWN_OBLIGATION_LINK_REJECTION)["code"]
  | (typeof REVIEW_ISSUE_LOCATION_REJECTION)["code"]
  | (typeof ISSUE_JUDGMENT_VOCABULARY_REJECTIONS)[keyof typeof ISSUE_JUDGMENT_VOCABULARY_REJECTIONS]["code"]
  | (typeof DIMENSION_DEMOTION_REJECTIONS)[keyof typeof DIMENSION_DEMOTION_REJECTIONS]["code"]
  | (typeof FACT_INVENTORY_LIMITATION_BOUND_REJECTION)["code"]
  | TechnicalCorrectionByteBoundCode
  | (typeof UNRETAINABLE_INFERENCE_REJECTIONS)[keyof typeof UNRETAINABLE_INFERENCE_REJECTIONS]["code"]
  | (typeof EDITORIAL_LIMITATION_CODE_REJECTIONS)[keyof typeof EDITORIAL_LIMITATION_CODE_REJECTIONS]["code"]
  | typeof CONTRACT_PLACEHOLDER_REJECTION_CODE
  | FactLinkRejectionCode
  | "source-readiness-unassessed-available-sources";

const NAMED_INFERENCE_REJECTION_CLASSES = {
  "editorial-envelope-shape": "contract-shape",
  "editorial-limitation-code-off-grammar": "model-content",
  "contract-placeholder-copied": "model-content",
  "source-readiness-unassessed-available-sources": "model-content",
  "fact-link-malformed-fact-id": "model-content",
  "fact-link-duplicate-fact-id": "model-content",
  "fact-link-unknown-fact": "model-content",
  "fact-link-documented-fact": "model-content",
  "fact-link-judgment-omits-linked-facts": "model-content",
  "fact-link-judgment-fact-mismatch": "model-content",
  "fact-link-judgment-missing-fact": "model-content",
  "fact-link-unknown-issue": "model-content",
  "fact-link-unknown-obligation": "model-content",
  "judgment-severity-invalid": "model-content",
  "judgment-category-invalid": "model-content",
  "demotion-evidence-unresolved": "model-content",
  "demotion-evidence-single-line": "model-content",
  "demotion-every-applicable-dimension": "model-content",
  // A configured count bound, not a model defect.
  "fact-inventory-limitations-exceeded": "bound",
  // A technical-correction record over its canonical byte bound for the scope.
  "technical-correction-proposal-max-bytes-bound": "bound",
  "technical-correction-evidence-max-bytes-bound": "bound",
  "technical-correction-derived-result-max-bytes-bound": "bound",
  "review-issue-location-unsafe": "model-content",
  // A reason existed but the writer could not retain it: no cause is named.
  "unretainable-reason-too-long": "unknown",
  "unretainable-reason-off-grammar": "unknown",
} as const satisfies Record<NamedInferenceRejectionCode, FailureClass>;

/**
 * Code families a validator builds from a schema keyword at run time. The key
 * is the literal prefix; the class covers every keyword under it.
 */
export const REJECTION_FAMILY_FAILURE_CLASSES = Object.freeze({
  "review-schema-": "contract-shape",
  "evaluation-schema-": "contract-shape",
  // A refused bootstrap result recorded on its attempt keeps the class its
  // operator-code family row gives it (`OPERATOR_CODE_FAMILY_FAILURE_CLASSES`).
  "repository-bootstrap-": "contract-shape",
} as const satisfies Record<string, FailureClass>);

/**
 * Operator code families whose bare codes (`path`, `schema`, `workflow`) are not
 * globally unique, so a bare-code situation row would let one module's class
 * answer for another's. Every member shares the family's class; the bare
 * prefix alone is not a member.
 *
 * The `repository-bootstrap-` literal duplicates `onboarding/bootstrap-result.ts`
 * because this module must not import a domain module; a test holds them equal.
 */
export const OPERATOR_CODE_FAMILY_FAILURE_CLASSES = Object.freeze({
  "repository-bootstrap-": "contract-shape",
} as const satisfies Record<string, FailureClass>);

/**
 * Every catalogued operational limit's refusal code, from `config/limits.yaml`.
 * A stop that names one of them is `bound`. Read last, so a table that already
 * names a shared refusal code keeps its class.
 */
export const LIMIT_REFUSAL_CODES: ReadonlySet<string> = new Set(
  LIMIT_DEFINITIONS.map((definition) => definition.refusal).filter(isFailureCode),
);

export function composeTables(
  ...tables: readonly Readonly<Record<string, FailureClass>>[]
): Readonly<Record<string, FailureClass>> {
  const composed: Record<string, FailureClass> = {};
  for (const table of tables) {
    for (const [code, failureClass] of Object.entries(table)) {
      if (Object.hasOwn(composed, code) && composed[code] !== failureClass) {
        throw new Error(
          `Failure class tables disagree about rejection code ${code}; give it one class.`,
        );
      }
      composed[code] = failureClass;
    }
  }
  return Object.freeze(composed);
}

/** Every exact inference rejection code and its class. */
export const INFERENCE_REJECTION_FAILURE_CLASSES: Readonly<Record<string, FailureClass>> =
  composeTables(
    TECHNICAL_REVIEW_REJECTION_CLASSES,
    SOURCE_OBLIGATION_REJECTION_CLASSES,
    INVENTORY_REJECTION_CLASSES,
    JSON_PARSE_REJECTION_CLASSES,
    NAMED_INFERENCE_REJECTION_CLASSES,
    OUTPUT_RULE_FAILURE_CLASSES,
  );

export function familyClass(code: string): FailureClass | undefined {
  for (const [prefix, failureClass] of Object.entries(REJECTION_FAMILY_FAILURE_CLASSES)) {
    if (code.startsWith(prefix) && code.length > prefix.length) return failureClass;
  }
  return undefined;
}
