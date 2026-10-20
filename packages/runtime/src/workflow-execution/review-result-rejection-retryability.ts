// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Whether a review-result contract refusal may be retried.
 *
 * Classifies every refusal raised by `review-response.ts`'s contract kit, across
 * the editorial review step, the review result nested in the editorial
 * assessment, and retained legacy verification results.
 *
 * `model-correctable`: the reply broke a stated shape or content rule; a
 * bounded retry can repair it, and every check still applies to every attempt.
 * `terminal`: disclosure (including credential material) and integrity
 * failures stop the step whatever budget remains, matching `unsafe-disclosure`
 * in `technical-rejection-retryability.ts`.
 *
 * The keys must equal `REVIEW_RESULT_REJECTION_CODES`, onto which
 * `review-response.ts` maps every kit axis, so a new axis or code fails to
 * typecheck until it is classified here. This module is a dependency-free leaf.
 */

/** Every refusal the review-result contract kit raises, plus codes older hosts recorded. */
export const REVIEW_RESULT_REJECTION_CODES = [
  "invalid-shape",
  "invalid-value",
  "bounds-exceeded",
  "schema-mismatch",
  "digest-mismatch",
  "credential-material",
  // Raised only by older hosts; kept so their records still classify.
  "host-path-disclosure",
] as const;

export type ReviewResultRejectionCode = (typeof REVIEW_RESULT_REJECTION_CODES)[number];

export type ReviewResultRejectionRetryability = "model-correctable" | "terminal";

export interface ReviewResultRejectionRetryabilityEntry {
  readonly retry: ReviewResultRejectionRetryability;
  readonly reason: string;
}

const correctable = (
  reason: string,
): ReviewResultRejectionRetryabilityEntry & { readonly retry: "model-correctable" } =>
  Object.freeze({ retry: "model-correctable", reason });
const terminal = (
  reason: string,
): ReviewResultRejectionRetryabilityEntry & { readonly retry: "terminal" } =>
  Object.freeze({ retry: "terminal", reason });

export const REVIEW_RESULT_REJECTION_RETRYABILITY = Object.freeze({
  // Shape.
  "invalid-shape": correctable(
    "A value has the wrong JSON type, prototype chain, or key set, which the review contract declares.",
  ),
  "schema-mismatch": correctable(
    "A kind or schemaVersion differs from the constants the contract names.",
  ),
  // Content.
  "invalid-value": correctable(
    "A scalar is outside the type, values, or format the review contract states.",
  ),
  "bounds-exceeded": correctable(
    "A model-authored count, length, or depth exceeded its configured limit. The model can condense the reply, and the limit still applies to every attempt.",
  ),
  // Integrity.
  "digest-mismatch": terminal(
    "Sealed evidence did not match its own digest. The host mints digests, so an integrity failure is never re-asked.",
  ),
  // Disclosure.
  "credential-material": terminal(
    "Credential-shaped content is a disclosure refusal and is never re-asked, so the model is not prompted again with or about a secret.",
  ),
  "host-path-disclosure": terminal(
    "Recorded only by older hosts, which refused an absolute host path without re-asking.",
  ),
} as const satisfies Record<ReviewResultRejectionCode, ReviewResultRejectionRetryabilityEntry>);

export function isModelCorrectableReviewResultRejection(code: ReviewResultRejectionCode): boolean {
  return REVIEW_RESULT_REJECTION_RETRYABILITY[code].retry === "model-correctable";
}
