// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Rule-specific retry repairs for the final quality evaluator: which keys an
 * object lacks or has undeclared, and which not-documented technical facts no
 * finding names. Kept in host-owned private state beside the attempt failure,
 * like the technical review's repairs, so no serializer copies them into a
 * record; `retry.ts` reads them when it builds the next attempt's correction.
 */

import { MAX_INFERENCE_REJECTION_SEGMENT_LENGTH } from "../config/inference-rejection-limits.js";
import { limit } from "../config/limits.js";
import {
  inspectTechnicalFactTrace,
  TECHNICAL_FACT_TRACE_MAX_VIOLATIONS,
} from "../evaluation-report/quality-artifact-staging.js";
import { stagedQualitySchemaVocabulary } from "../evaluation-report/quality-schema-validation.js";
import type {
  InferenceRejectionReasonV1,
  InferenceStepError,
  QualityKeySetCorrection,
  QualityTraceFactIdsCorrection,
} from "../execution/contracts.js";
import { QUALITY_ARTIFACT_ANSWER_KEYS } from "../execution/response-contract-keys.js";
import { detectCredentialRuleIds } from "../security/repository-scanner.js";
import { ECHOABLE_OBLIGATION_ID } from "./review-response.js";
import type { VerificationResult } from "./verification-result.js";

/** The shape of a reply key a retry may repeat: the recorded location segment grammar. */
export const ECHOABLE_KEY_NAME = new RegExp(
  `^[A-Za-z][A-Za-z0-9_]{0,${MAX_INFERENCE_REJECTION_SEGMENT_LENGTH - 1}}$`,
  "u",
);

/** Separators that split a reply key into the segments a token can hide in. */
const KEY_SEGMENT_SEPARATOR = /[_.-]/u;

/**
 * Every span a credential could occupy in a key: the key, each segment, and
 * each prefix and suffix that ends or starts at a separator. The shared
 * detector anchors its patterns at word boundaries, and `_` is a word
 * character, so `x_ghp_...` hides a token from a whole-key check.
 */
function keySpans(key: string): string[] {
  const cuts = [...key.matchAll(new RegExp(KEY_SEGMENT_SEPARATOR, "gu"))].map(
    (match) => match.index,
  );
  return [
    key,
    ...key.split(KEY_SEGMENT_SEPARATOR),
    ...cuts.flatMap((cut) => [key.slice(0, cut), key.slice(cut + 1)]),
  ];
}

/** A segment long enough to be a secret and mixing letters with digits. */
function isRandomLookingSegment(segment: string, minChars: number): boolean {
  return segment.length >= minChars && /[A-Za-z]/u.test(segment) && /[0-9]/u.test(segment);
}

/**
 * Whether a retry may repeat a reply key: identifier-shaped; no span of it
 * shaped like a credential to the shared detector; and no segment
 * random-looking at `inference.echoedKeySegmentRandomChars`. Anything else is
 * counted, never named.
 */
export function isEchoableKeyName(key: string): boolean {
  if (!ECHOABLE_KEY_NAME.test(key)) return false;
  const minChars = limit("inference.echoedKeySegmentRandomChars").value;
  return (
    keySpans(key).every((span) => detectCredentialRuleIds(span).length === 0) &&
    key.split(KEY_SEGMENT_SEPARATOR).every((segment) => !isRandomLookingSegment(segment, minChars))
  );
}

export type QualityResponseCorrection = QualityKeySetCorrection | QualityTraceFactIdsCorrection;

const corrections = new WeakMap<InferenceStepError, QualityResponseCorrection>();

/** Attach a repair to the attempt failure it explains. */
export function recordQualityResponseCorrection(
  failure: InferenceStepError,
  correction: QualityResponseCorrection | undefined,
): void {
  if (correction) corrections.set(failure, correction);
}

/**
 * Carry the repair recorded for `from` onto a host wrap of it. A wrap that
 * drops it sends the retry the generic contract text instead of the keys.
 */
export function copyQualityResponseCorrection(from: unknown, to: InferenceStepError): void {
  recordQualityResponseCorrection(to, qualityResponseCorrection(from));
}

/** The repair recorded for `error`, if any. */
export function qualityResponseCorrection(error: unknown): QualityResponseCorrection | undefined {
  return typeof error === "object" && error !== null
    ? corrections.get(error as InferenceStepError)
    : undefined;
}

/**
 * Split the undeclared keys into the ones a retry may name and a count of the
 * rest. At most `bound` names are kept, so a reply cannot grow the retry.
 */
function undeclaredNames(
  keys: readonly string[],
  bound: number,
): Pick<QualityKeySetCorrection, "undeclared" | "withheldCount"> {
  const named = keys.filter(isEchoableKeyName).slice(0, bound);
  return { undeclared: named, withheldCount: keys.length - named.length };
}

/**
 * The key-set repair for an answer object whose top-level keys are not the
 * answer form's; `undefined` when the object had no keys to compare.
 */
export function answerKeySetCorrection(
  receivedKeys: readonly string[] | undefined,
): QualityKeySetCorrection | undefined {
  if (!receivedKeys) return undefined;
  const expected: readonly string[] = QUALITY_ARTIFACT_ANSWER_KEYS;
  const missing = expected.filter((key) => !receivedKeys.includes(key));
  const undeclared = receivedKeys.filter((key) => !expected.includes(key));
  if (missing.length === 0 && undeclared.length === 0) return undefined;
  return Object.freeze({
    kind: "quality-key-set",
    missing: Object.freeze(missing),
    ...undeclaredNames(undeclared, expected.length),
  });
}

/** The object at a `$`-rooted location with no array step, or `undefined`. */
function objectAt(value: unknown, location: string): Record<string, unknown> | undefined {
  if (!location.startsWith("$") || location.includes("[")) return undefined;
  let node: unknown = value;
  for (const segment of location.slice(1).split(".").slice(1)) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = Object.hasOwn(node, segment) ? (node as Record<string, unknown>)[segment] : undefined;
  }
  return node && typeof node === "object" && !Array.isArray(node)
    ? (node as Record<string, unknown>)
    : undefined;
}

/**
 * The key-set repair for an `evaluation-schema-required` refusal whose object
 * also carries a key the schema does not declare there, the shape of a key
 * written under another spelling. `undefined` when the object has no
 * undeclared key, the location crosses an array, or the schema does not
 * require the missing key there.
 */
export function evaluationRequiredKeyCorrection(
  rejection: InferenceRejectionReasonV1,
  evaluation: unknown,
): QualityKeySetCorrection | undefined {
  if (rejection.code !== "evaluation-schema-required") return undefined;
  const split = /^(.*)\.([^.[\]]+)$/u.exec(rejection.location);
  if (!split) return undefined;
  const [, parent, missing] = split as unknown as [string, string, string];
  const required = stagedQualitySchemaVocabulary("documentation-quality-evaluation.schema.json", {
    keyword: "required",
    location: rejection.location,
  });
  // The keys the schema declares at the parent object.
  const declared = stagedQualitySchemaVocabulary("documentation-quality-evaluation.schema.json", {
    keyword: "additional-properties",
    location: parent,
  }) as readonly string[] | undefined;
  const object = objectAt(evaluation, parent);
  if (!required?.includes(missing) || !declared || !object) return undefined;
  const undeclared = Object.keys(object).filter((key) => !declared.includes(key));
  if (undeclared.length === 0) return undefined;
  return Object.freeze({
    kind: "quality-key-set",
    missing: Object.freeze([missing]),
    ...undeclaredNames(undeclared, declared.length),
  });
}

/**
 * The fact-ID repair for a `technical-trace-missing-fact-id` refusal: the
 * not-documented facts of the admitted technical verification that no finding
 * names, from the same trace inspection the validator ran.
 */
export function traceFactIdsCorrection(
  rejection: InferenceRejectionReasonV1,
  evaluation: unknown,
  verification: VerificationResult | undefined,
): QualityTraceFactIdsCorrection | undefined {
  if (rejection.code !== "technical-trace-missing-fact-id" || !verification) return undefined;
  const inspection = inspectTechnicalFactTrace(evaluation, verification);
  const ids = [
    ...new Set(
      inspection.violations
        .filter((violation) => violation.code === "missing-fact-id" && violation.factId)
        .map((violation) => violation.factId!),
    ),
  ];
  if (ids.length === 0) return undefined;
  const maxChars = limit("technicalCorrection.identifierMaxChars").value;
  const named = ids
    .filter((id) => id.length <= maxChars && ECHOABLE_OBLIGATION_ID.test(id))
    .slice(0, TECHNICAL_FACT_TRACE_MAX_VIOLATIONS);
  return Object.freeze({
    kind: "quality-trace-fact-ids",
    factIds: Object.freeze(named),
    // A truncated inspection stopped counting; the count is a lower bound.
    withheldCount: ids.length - named.length,
  });
}
