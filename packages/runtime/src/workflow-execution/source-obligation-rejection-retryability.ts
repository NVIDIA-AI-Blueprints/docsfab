// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Whether a source-obligation rejection may be retried.
 *
 * Both raising paths in `source-obligation.ts` (the decoder's coded rejections
 * and the mapped contract-kit rejections) read `retryable` from this table, so
 * a code cannot be terminal on one path and retried on the other.
 *
 * `model-correctable`: the model broke a stated syntax, shape, or content
 * rule, and a bounded retry told the rule (`source-obligation-rule-hints.ts`)
 * can repair it; every check still applies to every attempt. `terminal`:
 * authority, credential-material, and integrity failures stop the step
 * whatever budget remains.
 *
 * `SOURCE_OBLIGATION_REJECTION_RETRYABILITY_COVERAGE` in `source-obligation.ts`
 * fails to typecheck when the keys differ from the closed code set. This
 * module reads only the generated metadata leaf, so the decoder can use it
 * without loading runtime limit configuration or creating an import cycle.
 */

import { OUTPUT_RULES } from "../contracts/model-output.generated.js";

export type SourceObligationRejectionRetryability = "model-correctable" | "terminal";

export interface SourceObligationRejectionRetryabilityEntry {
  readonly retry: SourceObligationRejectionRetryability;
  readonly reason: string;
}

const correctable = (
  reason: string,
): SourceObligationRejectionRetryabilityEntry & { readonly retry: "model-correctable" } =>
  Object.freeze({ retry: "model-correctable", reason });
const terminal = (
  reason: string,
): SourceObligationRejectionRetryabilityEntry & { readonly retry: "terminal" } =>
  Object.freeze({ retry: "terminal", reason });

const STRICT_JSON = correctable(
  "The reply was not strict JSON evidence; the model can re-emit one strict JSON object.",
);
const fromOutputRule = (rule: (typeof OUTPUT_RULES)[keyof typeof OUTPUT_RULES]) =>
  rule.retry === "model-correctable" ? correctable(rule.reason) : terminal(rule.reason);

export const SOURCE_OBLIGATION_REJECTION_RETRYABILITY = Object.freeze({
  // Syntax.
  "invalid-json": STRICT_JSON,
  "invalid-utf8": STRICT_JSON,
  "malformed-json": STRICT_JSON,
  "duplicate-key": STRICT_JSON,
  "unsafe-number": STRICT_JSON,
  "noncanonical-json": STRICT_JSON,
  // Shape.
  "invalid-shape": correctable(
    "A value has the wrong JSON type or structure, which the contract declares.",
  ),
  "unexpected-key-set": correctable(
    "An object has missing or undeclared keys; the contract lists the exact key set.",
  ),
  "unsupported-identity": correctable(
    "The reply declared a kind or schemaVersion other than the constants the contract names.",
  ),
  // Content.
  "invalid-value": correctable(
    "A scalar is outside the type, values, or format the contract states for its location.",
  ),
  "empty-required-field": correctable("A required field is empty; the contract requires a value."),
  "bounds-exceeded": correctable(
    "A model-authored count, length, or size exceeded its configured limit. The model can condense the reply, and the limit still applies to every attempt.",
  ),
  "incomplete-required-set": correctable(
    "A set the contract requires in full came back short; the contract names every member.",
  ),
  "duplicate-entry": correctable("An entry the contract requires to be distinct was repeated."),
  "inconsistent-status": correctable(
    "A dimension's status disagrees with its own obligations, locators, or reason.",
  ),
  "invalid-locator": correctable(
    "A source locator was nonspecific or carried a revision suffix, which the locator rule forbids.",
  ),
  [OUTPUT_RULES["source-proposal-required"].code]: fromOutputRule(
    OUTPUT_RULES["source-proposal-required"],
  ),
  [OUTPUT_RULES["source-proposal-refused"].code]: fromOutputRule(
    OUTPUT_RULES["source-proposal-refused"],
  ),
  // Authority.
  "unauthorized-source": terminal(
    "The reply cited a path outside the admitted original source authority, which is an authority refusal (#1128).",
  ),
  // Integrity.
  "digest-mismatch": terminal(
    "Evidence did not match its own canonical digest. The host mints digests, so an integrity failure is never re-asked.",
  ),
  "stale-evidence": terminal(
    "Evidence was bound to another revision or scope, which is an integrity refusal.",
  ),
  // Disclosure.
  "credential-material": terminal(
    "Credential-shaped content is a disclosure refusal and is never re-asked, so the model is not prompted again with or about a secret.",
  ),
  "host-path-disclosure": correctable(
    "Recorded only by older hosts; kept model-correctable, as those hosts last classified it. No current step raises it.",
  ),
  // Fallback.
  unknown: correctable(
    "No finer rule was recorded. The generic contract hint applies, as it does for the technical decoders.",
  ),
} as const satisfies Record<string, SourceObligationRejectionRetryabilityEntry>);

/** `source-obligation.ts` requires this to equal its `SourceObligationRejectionCode` union. */
export type ClassifiedSourceObligationRejectionCode =
  keyof typeof SOURCE_OBLIGATION_REJECTION_RETRYABILITY;

export function isModelCorrectableSourceObligationRejection(
  code: ClassifiedSourceObligationRejectionCode,
): boolean {
  return SOURCE_OBLIGATION_REJECTION_RETRYABILITY[code].retry === "model-correctable";
}
