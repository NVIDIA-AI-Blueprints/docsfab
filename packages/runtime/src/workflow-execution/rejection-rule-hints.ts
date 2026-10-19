// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host-owned repair hints for a bounded read-only retry.
 *
 * A refused response records a closed `code` and `location`
 * (`InferenceRejectionReasonV1`). A retry told only that the response failed
 * tends to repeat the mistake, so the retry prompt also states the rule behind
 * the code. Validators keep the hints for their codes in catalog modules
 * beside them (such as the `*-rule-hints.ts` files here; the editorial
 * envelope's live in `harness/response-correction.ts`), so a rule and its
 * explanation change together.
 *
 * Every hint is a fixed host-authored sentence. No hint is built from a
 * response, an error message, or any other model-controlled value. The only
 * variable text in a retry prompt is the rejection's own `code` and
 * `location`, which pass the content-free grammar and length bound in
 * `config/inference-rejection-limits.ts` first.
 */

import type { InferenceRejectionReasonV1 } from "../execution/contracts.js";
import type { JsonEvidenceErrorCode, JsonEvidenceSyntaxDetail } from "../json-evidence.js";

export interface RejectionRuleHint {
  /** Applies at every location that has no entry in `atLocation`. */
  readonly rule: string;
  /** Keys are exact contract locations from the raising decoder's closed vocabulary. */
  readonly atLocation?: Readonly<Record<string, string>>;
}

/**
 * Hints keyed by rejection code. A key ending in `*` is a family covering
 * every code that starts with the text before the `*` and has no exact entry.
 * The retained code grammar is kebab-case, so a family key never collides
 * with a code.
 */
export type RejectionRuleHintCatalog = Readonly<Record<string, RejectionRuleHint>>;

const FAMILY_SUFFIX = "*";

/**
 * An exact code wins over a family, and a longer family prefix wins over a
 * shorter one. Own-property lookups only, so a code such as `constructor`
 * cannot resolve to an inherited member.
 */
export function ruleHintFor(
  catalog: RejectionRuleHintCatalog,
  rejection: InferenceRejectionReasonV1,
): string | undefined {
  const entry = Object.hasOwn(catalog, rejection.code)
    ? catalog[rejection.code]
    : familyEntry(catalog, rejection.code);
  if (!entry) return undefined;
  if (entry.atLocation && Object.hasOwn(entry.atLocation, rejection.location)) {
    return entry.atLocation[rejection.location];
  }
  return entry.rule;
}

function familyEntry(
  catalog: RejectionRuleHintCatalog,
  code: string,
): RejectionRuleHint | undefined {
  let best: string | undefined;
  for (const key of Object.keys(catalog)) {
    if (!key.endsWith(FAMILY_SUFFIX)) continue;
    const prefix = key.slice(0, -FAMILY_SUFFIX.length);
    if (code.startsWith(prefix) && (best === undefined || key.length > best.length)) best = key;
  }
  return best === undefined ? undefined : catalog[best];
}

/**
 * Validators share some codes, such as `invalid-json`; the first catalog that
 * lists a shared code defines it, and a test keeps catalogs from defining the
 * same code twice.
 */
export function composeRejectionRuleHints(
  ...catalogs: readonly RejectionRuleHintCatalog[]
): RejectionRuleHintCatalog {
  const composed: Record<string, RejectionRuleHint> = {};
  for (const catalog of catalogs) {
    for (const [code, hint] of Object.entries(catalog)) {
      if (!Object.hasOwn(composed, code)) composed[code] = hint;
    }
  }
  return Object.freeze(composed);
}

export function everywhere(rule: string): RejectionRuleHint {
  return Object.freeze({ rule });
}

/** The parser's `unexpected-end` detail, which only a truncated response raises. */
export const COMPLETE_JSON_RULE =
  "The previous response ended before its JSON object was complete. Return a complete replacement object, including every closing string, array, and object. Use concise prose and compact JSON so the entire required result fits; preserve every required dimension, fact, finding, and evidence link.";

/**
 * The repair for `malformed-json`, which the parser raises for truncation and
 * also for a fence, prose, byte-order mark, stray character, or excess
 * nesting, so the rule names all of them.
 */
export const STRICT_JSON_SYNTAX_RULE =
  "The response was not syntactically valid strict JSON. Return exactly one complete JSON object as the whole response: no Markdown fence, no prose, byte-order mark, or other characters before or after it, no comments or trailing commas, no deeper nesting than the contract declares, and every string, array, and object closed. Use compact JSON so the entire result fits.";

/**
 * Rules for the strict-JSON parser's refusal codes (`json-evidence.ts`), keyed
 * by its closed union so a new code does not typecheck without a rule.
 */
export const JSON_EVIDENCE_ERROR_RULES = Object.freeze({
  "invalid-utf8": "The response must be valid UTF-8 text. Remove any invalid byte sequence.",
  "malformed-json": STRICT_JSON_SYNTAX_RULE,
  "duplicate-key":
    "A JSON object repeated a key. Use each key at most once in every object, keeping one value for it.",
  "unsafe-number":
    "A JSON number was not finite, was negative zero, or was an integer outside the safe-integer range. Use ordinary finite numbers; put identifiers and very large integers in strings.",
  "noncanonical-json":
    "The value was not in the canonical JSON encoding this contract requires: keys sorted, two-space indentation, and one trailing line break. Return ordinary strict JSON and do not reproduce a host-sealed record.",
} as const satisfies Record<JsonEvidenceErrorCode, string>);

/**
 * Rules for the parser's syntax details, raised as `json-<detail>`, keyed by
 * its closed union so a new detail does not typecheck without a rule.
 */
export const JSON_EVIDENCE_SYNTAX_RULES = Object.freeze({
  "unexpected-end": COMPLETE_JSON_RULE,
  "unexpected-token":
    "The response contained a character where JSON does not allow one. Return only the JSON object: no prose before or after it, no Markdown fence, no comments, no trailing commas, and a double-quoted string for every key.",
  "invalid-escape":
    'A JSON string used an invalid escape sequence. Use only \\", \\\\, \\/, \\b, \\f, \\n, \\r, \\t, or \\uXXXX escapes.',
  "unescaped-control":
    "A JSON string contained a raw control character, such as a literal line break or tab. Escape it as \\n, \\t, or \\uXXXX.",
  "unpaired-surrogate":
    "A JSON string contained an unpaired UTF-16 surrogate escape. Use a complete surrogate pair or the character itself.",
} as const satisfies Record<JsonEvidenceSyntaxDetail, string>);
