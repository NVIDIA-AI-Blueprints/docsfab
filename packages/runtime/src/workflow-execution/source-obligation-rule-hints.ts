// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Retry rule hints for the source-obligation decoder, one per code in
 * `SOURCE_OBLIGATION_REJECTION_CODES`, keyed by that closed union so a new code
 * does not typecheck without a rule. Location-specific entries use positions
 * from `SOURCE_OBLIGATION_REJECTION_LOCATIONS`.
 *
 * `invalid-json`, `invalid-shape`, `bounds-exceeded`, and `unknown` are shared
 * with the technical review and correction decoders. A rejection does not say
 * which decoder raised it, so each shared rule must hold for every decoder
 * that raises the code (`retry-rule-hints.test.ts` checks this).
 *
 * Change a hint with the validator rule it explains. The text is host-authored
 * and never includes response content; see `rejection-rule-hints.ts`.
 */

import {
  JSON_EVIDENCE_ERROR_RULES,
  everywhere,
  type RejectionRuleHint,
} from "./rejection-rule-hints.js";
import { limit } from "../config/limits.js";
import { OUTPUT_RULES } from "../contracts/model-output.generated.js";
import { SOURCE_LOCATOR_RULE } from "./review-response.js";
import type {
  SourceObligationRejectionCode,
  SourceObligationRejectionLocation,
} from "./source-obligation.js";

function byLocation(
  rule: string,
  atLocation: Partial<Record<SourceObligationRejectionLocation, string>>,
): RejectionRuleHint {
  return Object.freeze({ rule, atLocation: Object.freeze(atLocation) });
}

const DIMENSION_STATUS_RULE =
  'An "applicable" dimension needs at least one obligation. A "not-applicable" or "unverified" dimension must set obligations to []. A "not-applicable" dimension also needs at least one specific dimension-level source locator that supports the reason.';
type CataloguedSourceObligationCode =
  | (typeof OUTPUT_RULES)["source-proposal-required"]["code"]
  | (typeof OUTPUT_RULES)["source-proposal-refused"]["code"];
type LegacySourceObligationRejectionCode = Exclude<
  SourceObligationRejectionCode,
  CataloguedSourceObligationCode
>;

export const SOURCE_OBLIGATION_RULE_HINTS = Object.freeze({
  // Shared with technical review and correction.
  "invalid-json": everywhere(
    "The response was not strict JSON. Return exactly one JSON object as the whole response, with no Markdown fence and no prose before or after it.",
  ),
  "invalid-utf8": everywhere(JSON_EVIDENCE_ERROR_RULES["invalid-utf8"]),
  "malformed-json": everywhere(JSON_EVIDENCE_ERROR_RULES["malformed-json"]),
  "duplicate-key": everywhere(JSON_EVIDENCE_ERROR_RULES["duplicate-key"]),
  "unsafe-number": everywhere(JSON_EVIDENCE_ERROR_RULES["unsafe-number"]),
  "noncanonical-json": everywhere(JSON_EVIDENCE_ERROR_RULES["noncanonical-json"]),
  // Shared. Source obligations raise it for a wrong JSON type; technical
  // verification raises it for its envelope (wrong type, or missing or extra
  // top-level keys); technical correction also for a repeated issue judgment.
  "invalid-shape": everywhere(
    "The value at this location does not have the structure the response contract declares: it is the wrong JSON type, an object with missing or undeclared keys, or a list that repeats an entry the contract requires to be unique. Match the declared structure exactly, with every required key and no others.",
  ),
  "unexpected-key-set": everywhere(
    "The object at this location must have exactly the keys the response contract lists for it. Add every missing required key and remove every key the contract does not define.",
  ),
  "invalid-value": byLocation(
    "The value at this location has the wrong type, is outside its allowed values or format, is too short or too long, or has leading or trailing whitespace. Use a value the response contract allows at this location.",
    {
      "$.completeness": 'Set completeness to exactly "bounded-not-proven".',
      "$.dimensions[].dimension":
        "Each dimension must be one of the required technical dimension names from the response contract, spelled exactly.",
      "$.dimensions[].status":
        'Each dimensions entry status must be exactly "applicable", "not-applicable", or "unverified".',
      "$.dimensions[].obligations[].dimension":
        "Each obligation's dimension must equal the dimension of the entry that contains it.",
      "$.dimensions[].obligations[].evidenceClass":
        'Each obligation evidenceClass must be exactly "source-observation" or "source-inference".',
      "$.dimensions[].obligations[].id":
        "Each obligation id must use the host obligation format: OBL- followed by uppercase letters, digits, hyphens, or underscores.",
      get "$.dimensions[].reason"() {
        return `A short reason in the dimensions entry identified by its dimension value must explain why that dimension has its status in at least ${limit("factInventory.minDimensionReasonChars").value} characters. Keep every other dimension's reason with its own dimension value.`;
      },
    },
  ),
  "empty-required-field": byLocation(
    "A required field at this location is empty. Provide a non-empty value.",
    {
      "$.dimensions[].obligations[].sourceLocators": `Every obligation needs at least one source locator. ${SOURCE_LOCATOR_RULE}`,
      get "$.dimensions[].reason"() {
        return `A missing reason in the dimensions entry identified by its dimension value must explain why that dimension has its status in at least ${limit("factInventory.minDimensionReasonChars").value} characters. Keep every other dimension's reason with its own dimension value.`;
      },
    },
  ),
  // Shared with technical correction, which raises it for an oversized result.
  "bounds-exceeded": byLocation(
    "A count, length, or size bound was exceeded at this location. Return fewer or shorter entries, condensing wording rather than dropping required content.",
    {
      "$.dimensions":
        "Return exactly one dimensions entry for each required technical dimension. The response had more entries than the contract allows.",
    },
  ),
  "incomplete-required-set": byLocation(
    "A set the contract requires in full was missing entries. Return every required entry.",
    {
      "$.dimensions":
        "Return exactly one dimensions entry for each required technical dimension. The response omitted at least one.",
    },
  ),
  "duplicate-entry": byLocation(
    "Entries at this location must be distinct. Remove the repeated value.",
    {
      "$.dimensions[].dimension": "Each required technical dimension must appear exactly once.",
      "$.dimensions[].obligations[].id": "Each obligation id must be unique across the response.",
    },
  ),
  // Recorded only by older hosts: each status pairing is now its own rule in
  // config/model-output/rules/source-obligation.yaml.
  "inconsistent-status": byLocation(DIMENSION_STATUS_RULE, {
    "$.dimensions[].status": DIMENSION_STATUS_RULE,
    "$.dimensions[].sourceLocators":
      'An "applicable" dimension must set its own sourceLocators to []. Cite sources on each obligation instead.',
    "$.dimensions[].reason":
      'An "unverified" dimension\'s reason must exactly equal one entry of the top-level limitations array, character for character. Add the reason to limitations verbatim, or copy an existing limitation into reason.',
  }),
  "invalid-locator": everywhere(SOURCE_LOCATOR_RULE),
  "unauthorized-source": everywhere(
    "Cite only files in the admitted original source set for this run. Do not cite any other path.",
  ),
  "digest-mismatch": everywhere(
    "A digest did not match the evidence it seals. Do not write or copy digest fields; the host computes them.",
  ),
  "stale-evidence": everywhere(
    "The evidence was bound to another revision or scope. Use only the evidence and identity the host supplied for this run.",
  ),
  "unsupported-identity": everywhere(
    "Use exactly the kind and schemaVersion the response contract names. Do not add identity fields it does not declare.",
  ),
  "credential-material": everywhere(
    "Remove credential-shaped content, such as tokens, keys, passwords, or secrets. Never quote a secret, even from a source file.",
  ),
  // Recorded only by older hosts; no current step raises it, so no retry renders this hint.
  "host-path-disclosure": everywhere(
    "Remove every absolute host filesystem path, every file: reference, and every backslash, including any copied from a cited source; the host reads each of them as a host location. Cite repository-relative paths with forward slashes, and describe an escape sequence or a Windows path in words instead of quoting it.",
  ),
  // Shared with technical review and correction.
  unknown: everywhere(
    "The host recorded no finer rule for this rejection. Check every required field, field type, allowed value, and cross-reference against the selected response contract.",
  ),
} as const satisfies Record<LegacySourceObligationRejectionCode, RejectionRuleHint>);
