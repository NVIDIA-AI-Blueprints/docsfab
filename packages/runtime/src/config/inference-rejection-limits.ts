// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Admitted grammar for a coded inference rejection reason. The bounds are read
 * from the generated mirror of `config/limits.yaml`; change them there and run
 * `npm run generate:limits`.
 *
 * Neither bound is model-controlled: the raising decoder picks both fields from
 * its own frozen vocabulary. The bounds stop a forged, corrupted, or
 * non-conforming record from smuggling response bytes through fields the
 * contract promises are content-free. Exceeding one refuses rather than
 * truncating, because a truncated reason would read as a real one.
 */

import { LIMIT_DEFINITION_BY_NAME } from "./limits.generated.js";

/** Read one catalog value, refusing loudly rather than falling back to a literal. */
function catalogLimit(name: string): number {
  const definition = LIMIT_DEFINITION_BY_NAME[name];
  if (!definition) {
    throw new Error(`Inference rejection limit ${name} is missing from config/limits.yaml.`);
  }
  return definition.value;
}

/**
 * Maximum length of either field of an `InferenceRejectionReasonV1`.
 *
 * The write boundary (`workflow-execution/retry.ts`) refuses a longer value
 * because the closed-key record decoders (`execution/lease-contracts.ts`,
 * `quality-evaluation/corpus-live.ts`, `scorecard-record-decode.ts`) refuse to
 * read one; a record persisted above it would be undecodable.
 */
export const MAX_INFERENCE_REJECTION_REASON_LENGTH = catalogLimit(
  "inference.rejectionReasonLength",
);

/**
 * Longest identifier segment either grammar below admits: a whole kebab-case
 * code, or one dot-separated member of a location path. Both expressions are
 * built from it, so the caps cannot drift apart or from the catalog.
 */
export const MAX_INFERENCE_REJECTION_SEGMENT_LENGTH = catalogLimit(
  "inference.rejectionSegmentLength",
);

/**
 * Shape a rejection `code` must take to be retained: kebab-case lowercase
 * letters and digits, at most {@link MAX_INFERENCE_REJECTION_SEGMENT_LENGTH}
 * characters, matching `SAFE_CONTRACT_CODE` in `operator/error-envelope.ts`.
 *
 * The code vocabularies stay with the decoders that raise them and are not
 * copied here. Prose cannot match because it has spaces. The quantifier is the
 * cap less the two anchored end characters.
 */
export const INFERENCE_REJECTION_CODE_GRAMMAR = new RegExp(
  `^[a-z](?:[a-z0-9-]{0,${MAX_INFERENCE_REJECTION_SEGMENT_LENGTH - 2}}[a-z0-9])?$`,
  "u",
);

/**
 * Shape a rejection `location` must take to be retained: a `$`-rooted contract
 * path of dot-separated identifiers with optional empty `[]` members, or the
 * bare token `$response`. Each segment is at most
 * {@link MAX_INFERENCE_REJECTION_SEGMENT_LENGTH} characters; the quantifier is
 * the cap less the one leading character.
 *
 * Locations name positions in a host-owned response contract, never in a
 * response. Brackets must stay empty because an index such as `$.dimensions[3]`
 * would disclose how much the response contained. Host paths and URLs cannot
 * match.
 */
export const INFERENCE_REJECTION_LOCATION_GRAMMAR = new RegExp(
  `^\\$(?:response|(?:\\.[A-Za-z][A-Za-z0-9_]{0,${MAX_INFERENCE_REJECTION_SEGMENT_LENGTH - 1}}(?:\\[\\])*)*)$`,
  "u",
);

/**
 * Placeholder reasons recorded when a raised reason cannot itself be retained.
 *
 * Absence means the decoder recorded no reason, so a non-conforming reason is
 * replaced, not dropped. Each placeholder is inside the admitted grammar so the
 * record still decodes. No decoder raises them: reading one back means the
 * writer refused a reason, never that a response failed this way.
 */
export const UNRETAINABLE_INFERENCE_REJECTIONS = {
  tooLong: Object.freeze({ code: "unretainable-reason-too-long", location: "$response" }),
  offGrammar: Object.freeze({ code: "unretainable-reason-off-grammar", location: "$response" }),
} as const;

/**
 * The reason to persist for a raised one: itself when it is retainable, else
 * the placeholder naming why it was not. Never throws and never returns
 * nothing, so a diagnostic can neither fail the step it describes nor erase
 * itself.
 */
export function retainedInferenceRejection(reason: {
  readonly code: string;
  readonly location: string;
}): { readonly code: string; readonly location: string } {
  if (isRetainableInferenceRejection(reason)) return { ...reason };
  // Copied so no two attempt records share one object identity.
  return reason.code.length > MAX_INFERENCE_REJECTION_REASON_LENGTH ||
    reason.location.length > MAX_INFERENCE_REJECTION_REASON_LENGTH
    ? { ...UNRETAINABLE_INFERENCE_REJECTIONS.tooLong }
    : { ...UNRETAINABLE_INFERENCE_REJECTIONS.offGrammar };
}

/**
 * Whether a reason is safe to retain in, or read back out of, a record.
 *
 * Checks shape and grammar only, so an admitting decoder needs no raising
 * decoder's vocabulary, yet free prose in `code` and an indexed or
 * host-path-like `location` are refused.
 */
export function isRetainableInferenceRejection(value: {
  readonly code: string;
  readonly location: string;
}): boolean {
  return (
    value.code.length <= MAX_INFERENCE_REJECTION_REASON_LENGTH &&
    value.location.length <= MAX_INFERENCE_REJECTION_REASON_LENGTH &&
    INFERENCE_REJECTION_CODE_GRAMMAR.test(value.code) &&
    INFERENCE_REJECTION_LOCATION_GRAMMAR.test(value.location)
  );
}

/** Read one catalog entry's admitted ceiling, refusing loudly when it is missing. */
function catalogCeiling(name: string): number {
  const definition = LIMIT_DEFINITION_BY_NAME[name];
  if (!definition) {
    throw new Error(`Inference rejection limit ${name} is missing from config/limits.yaml.`);
  }
  return definition.max;
}

/**
 * Deepest JSON nesting a rejected reply's shape fingerprint describes. Every
 * container below it is counted in the fingerprint's `truncation`.
 */
export const MAX_REJECTED_REPLY_SHAPE_DEPTH = catalogLimit("inference.rejectedReplyShapeMaxDepth");

/**
 * Most distinct key paths, and most top-level keys, one fingerprint lists.
 * Paths and keys past it are counted in the fingerprint's `truncation`.
 */
export const MAX_REJECTED_REPLY_SHAPE_ENTRIES = catalogLimit(
  "inference.rejectedReplyShapeMaxEntries",
);

/**
 * The ceilings the record decoders admit: each entry's catalog `max`, not its
 * current value, so lowering a value cannot make a written record unreadable.
 */
export const REJECTED_REPLY_SHAPE_DECODE_CEILINGS = Object.freeze({
  depth: catalogCeiling("inference.rejectedReplyShapeMaxDepth"),
  entries: catalogCeiling("inference.rejectedReplyShapeMaxEntries"),
});
