// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Whether a technical review or correction rejection may be retried.
 *
 * Classifies every reason the technical decoders record: outer
 * `TechnicalReviewRejectionCode`s, `inventory-<detail>` reasons, and the
 * correction's judgment and fact-link reasons. The raising sites in
 * `review-response.ts` read `retryable` from this table, so a rule cannot be
 * retryable in one step and declined in another.
 *
 * `model-correctable`: the model broke a stated contract rule, and a bounded
 * retry told the rule can repair it; every check still applies to every
 * attempt. `terminal`: security (credential or host-path disclosure) and
 * authority refusals stop immediately, whatever budget remains.
 *
 * Host defects never reach a model-correctable entry: a missing host admission
 * or target set raises a terminal authority code, a missing host schema keeps
 * its site's non-retryable flag, and `rejectTechnicalCorrectionFailure`
 * refuses a host exception without rejection state.
 *
 * `TECHNICAL_REJECTION_RETRYABILITY_COVERAGE` in `review-response.ts` fails to
 * typecheck when the keys differ from the closed reason set, and
 * `review-response-rule-hints.ts` requires a rule for every model-correctable
 * reason. This module is a dependency-free leaf so decoders and harness
 * contract modules can read it without an import cycle.
 */

/**
 * Inner reasons for a fact link the correction and V3 proposal validators
 * refuse under the outer `invalid-fact-link` code. The unissued-obligation
 * reason is declared with its own contract location in
 * `review-response.ts`.
 */
export const FACT_LINK_REJECTION_CODES = [
  "fact-link-malformed-fact-id",
  "fact-link-duplicate-fact-id",
  "fact-link-unknown-fact",
  "fact-link-documented-fact",
  "fact-link-judgment-omits-linked-facts",
  "fact-link-judgment-fact-mismatch",
  "fact-link-judgment-missing-fact",
  "fact-link-unknown-issue",
] as const;

export type FactLinkRejectionCode = (typeof FACT_LINK_REJECTION_CODES)[number];

/** The inner reason a correction-only refusal names, when it names one. */
export interface TechnicalCorrectionInnerReason {
  readonly code: FactLinkRejectionCode;
  readonly location: string;
}

/**
 * The canonical byte bounds of a technical-correction record, by the limit
 * that holds each. A code is the limit's own catalog refusal, so the record
 * names the bound and its failure class is `bound`.
 */
export const TECHNICAL_CORRECTION_BYTE_BOUNDS = Object.freeze({
  proposal: Object.freeze({
    limit: "technicalCorrection.proposalMaxBytes",
    code: "technical-correction-proposal-max-bytes-bound",
  }),
  evidence: Object.freeze({
    limit: "technicalCorrection.evidenceMaxBytes",
    code: "technical-correction-evidence-max-bytes-bound",
  }),
  derivedResult: Object.freeze({
    limit: "technicalCorrection.derivedResultMaxBytes",
    code: "technical-correction-derived-result-max-bytes-bound",
  }),
} as const);

export type TechnicalCorrectionByteBound = keyof typeof TECHNICAL_CORRECTION_BYTE_BOUNDS;

export type TechnicalCorrectionByteBoundCode =
  (typeof TECHNICAL_CORRECTION_BYTE_BOUNDS)[TechnicalCorrectionByteBound]["code"];

export type TechnicalRejectionRetryability = "model-correctable" | "terminal";

export interface TechnicalRejectionRetryabilityEntry {
  readonly retry: TechnicalRejectionRetryability;
  readonly reason: string;
}

const correctable = (
  reason: string,
): TechnicalRejectionRetryabilityEntry & { readonly retry: "model-correctable" } =>
  Object.freeze({ retry: "model-correctable", reason });
const terminal = (
  reason: string,
): TechnicalRejectionRetryabilityEntry & { readonly retry: "terminal" } =>
  Object.freeze({ retry: "terminal", reason });

/** When a site names an inner reason, that reason is classified; otherwise the outer code. */
export const TECHNICAL_REJECTION_RETRYABILITY = Object.freeze({
  // Outer codes.
  "invalid-json": correctable(
    "The reply failed strict JSON parsing; the model can re-emit it as strict JSON. A prose or empty reply is recorded with the unframed-reply condition, whose retry asks for only the object.",
  ),
  "invalid-shape": correctable(
    "The reply has the wrong JSON type, missing or undeclared keys, or a repeated judgment id, all of which the contract declares.",
  ),
  "unsafe-disclosure": terminal(
    "Credential-shaped or absolute host-path content is a security refusal and is never re-asked.",
  ),
  "invalid-review": correctable(
    "The review verdict or issues broke the governed review schema that the contract states.",
  ),
  "invalid-coverage": correctable(
    "Coverage must list each approved target once. The contract names the targets.",
  ),
  "invalid-fact-inventory": correctable(
    "The fact inventory broke a dimension, fact, or link rule that the contract states.",
  ),
  "inconsistent-verdict": correctable(
    "The verdict disagrees with the reply's own issues or unverified evidence.",
  ),
  "invalid-accounting": correctable(
    "An obligation row is missing, repeated, unissued, or altered. The contract names the exact ledger set.",
  ),
  "invalid-fact-link": correctable(
    "Issue, fact, and obligation links disagree within the reply. The model can relink them from its own judgments.",
  ),
  "bounds-exceeded": correctable(
    "A model-authored count, length, or size exceeded its configured limit. The model can condense the reply, and the limit still applies to every attempt.",
  ),
  "source-authority": terminal(
    "The reply cites sources outside the admitted source set, or the host lacks an authority admission. Either way it is an authority refusal (#1128).",
  ),
  "target-authority": terminal(
    "The reply locates an issue outside the approved targets, or the host lacks a target set. Either way it is an authority refusal (#1128).",
  ),
  unknown: correctable(
    "No finer rule was recorded. The generic contract hint applies, as it has since #1121.",
  ),
  // Fact-inventory details, raised identically in verification and correction.
  "inventory-shape": correctable("The inventory must have exactly the three declared keys."),
  "inventory-completeness": correctable("The contract fixes completeness to one literal value."),
  "inventory-dimension-shape": correctable("Each dimension must have exactly the declared keys."),
  "inventory-dimension-count": correctable(
    "The inventory needs exactly one entry per required dimension, and the contract names them all.",
  ),
  "inventory-dimension-reason": correctable(
    "A dimension reason must be substantive text within its bounds.",
  ),
  "inventory-dimension-identity": correctable(
    "Each dimension must be one of the named dimensions, and each can appear only once.",
  ),
  "inventory-dimension-status": correctable("Dimension status is one of three declared values."),
  "inventory-dimension-facts": correctable(
    "Whether a dimension lists facts follows from its status.",
  ),
  "inventory-dimension-locators": correctable(
    "Where a dimension cites locators follows from its status.",
  ),
  "inventory-limitation-link": correctable(
    "An unverified dimension's reason must copy a limitation verbatim.",
  ),
  "inventory-fact-identity": correctable("Fact ids follow a declared format and are unique."),
  "inventory-fact-shape": correctable("Each fact must have exactly the declared keys."),
  "inventory-fact-text": correctable("Fact text must be non-empty and within its bounds."),
  "inventory-fact-dimension": correctable("A fact's dimension must match its containing entry."),
  "inventory-fact-locators": correctable(
    "Fact locators must be specific and distinct, as the locator rule states.",
  ),
  "inventory-fact-disposition": correctable(
    "Documentation disposition is one of five declared values.",
  ),
  "inventory-fact-finding-link": correctable(
    "Fact issueIds must name only the reply's own issues, and only on non-documented facts.",
  ),
  // Correction judgment reasons.
  "fact-link-unknown-obligation": correctable(
    "The judgment cites an obligation ID the sealed ledger never issued. The retry names the issued set (#1219).",
  ),
  "judgment-severity-invalid": correctable(
    "The severity is outside the vocabulary the contract lists (#1234).",
  ),
  // A substantive all-reject the host still refuses to demote.
  "demotion-evidence-unresolved": correctable(
    "A rejection cites a line or range that is not a line locator inside its admitted source. The contract states the locator form and the admitted paths.",
  ),
  "demotion-evidence-single-line": correctable(
    "The rejections of one dimension cite only one distinct source line between them. The contract requires two distinct lines across the dimension.",
  ),
  "fact-inventory-limitations-exceeded": terminal(
    "The host-built inventory holds one limitation per rejected obligation, so only retaining obligations the source does not establish could fit. The operator raises factInventory.maxLimitations or narrows the run (#1254).",
  ),
  // Canonical byte bounds of the technical-correction record, raised under the
  // outer `bounds-exceeded` code when the reply is the host's own, or when the
  // host-filled coverage for the scope alone exceeds the bound, so the step's
  // floor cannot fit either. A reply the model can condense keeps the outer code.
  "technical-correction-proposal-max-bytes-bound": terminal(
    "The host-built proposal, or the host-filled coverage alone, exceeds technicalCorrection.proposalMaxBytes for this scope. The operator narrows the scope.",
  ),
  "technical-correction-evidence-max-bytes-bound": terminal(
    "The host-built evidence, or the host-filled coverage alone, exceeds technicalCorrection.evidenceMaxBytes for this scope. The operator narrows the scope.",
  ),
  "technical-correction-derived-result-max-bytes-bound": terminal(
    "The derived result of a host-built proposal, or the host-filled coverage alone, exceeds technicalCorrection.derivedResultMaxBytes for this scope. The operator narrows the scope.",
  ),
  "demotion-every-applicable-dimension": correctable(
    "The judgment would demote every applicable dimension. The contract requires at least one to keep a retained or refined obligation.",
  ),
  "judgment-category-invalid": correctable(
    "The category is outside the vocabulary the contract lists (#1234).",
  ),
  "fact-link-malformed-fact-id": correctable("A cited fact id breaks the declared id format."),
  "fact-link-duplicate-fact-id": correctable("A factIds list repeats a fact id."),
  "fact-link-unknown-fact": correctable("A cited fact id names no fact in the reply's inventory."),
  // The host derives each fact's issueIds from the judgment's obligationIds, so
  // these checks cannot fail on a model reply. They remain the integrity check
  // of a host-built V3 proposal and a sealed record, where a disagreement is a
  // host or record fault a re-ask cannot repair.
  "fact-link-documented-fact": terminal(
    "Raised only on a host-built proposal or sealed record since #1342: the host never links a documented fact to an issue, so a documented fact an issue cites is a record fault.",
  ),
  "fact-link-judgment-omits-linked-facts": terminal(
    "Raised only on a host-built proposal or sealed record since #1342: the host derives both link directions from the same judgments, so a disagreement is a record fault.",
  ),
  "fact-link-judgment-fact-mismatch": terminal(
    "Raised only on a host-built proposal or sealed record since #1342: the host derives both link directions from the same judgments, so a disagreement is a record fault.",
  ),
  "fact-link-judgment-missing-fact": terminal(
    "Raised only on a host-built proposal or sealed record since #1342: the host derives both link directions from the same judgments, so a disagreement is a record fault.",
  ),
  "fact-link-unknown-issue": terminal(
    "Raised only on a host-built proposal or sealed record since #1342: a derived fact link names only an admitted issue judgment, so an unknown one is a record fault.",
  ),
} as const satisfies Record<string, TechnicalRejectionRetryabilityEntry>);

/** `review-response.ts` requires this to equal its `TechnicalRejectionReasonCode` union. */
export type ClassifiedTechnicalRejectionReason = keyof typeof TECHNICAL_REJECTION_RETRYABILITY;

/** Reasons the table lets a bounded retry repair. */
export type ModelCorrectableTechnicalReason = {
  [Code in ClassifiedTechnicalRejectionReason]: (typeof TECHNICAL_REJECTION_RETRYABILITY)[Code]["retry"] extends "model-correctable"
    ? Code
    : never;
}[ClassifiedTechnicalRejectionReason];

export function isModelCorrectableTechnicalRejection(
  reason: ClassifiedTechnicalRejectionReason,
): boolean {
  return TECHNICAL_REJECTION_RETRYABILITY[reason].retry === "model-correctable";
}
