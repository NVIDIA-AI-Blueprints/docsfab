// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded, redacted excerpt of a rejected model reply.
 *
 * The excerpt copies at most three segments of the text the step's decoder
 * parsed (the same trimmed text `rejectedReplyShape` describes, so offsets
 * agree): the head, the tail, and a window around the strict parser's stop
 * position when that falls between them. Each segment copies at most
 * `inference.rejectedReplyExcerptChars` reply characters, and every character
 * no segment copied is counted in `omittedChars`.
 *
 * Redaction runs on the whole reply before it is cut, so a cut cannot leave an
 * unrecognizable piece of a credential behind. Every span the shared guards
 * find is replaced by one marker, including the part of a span that reaches
 * into a segment from outside it: DocsFab's own configured credentials in any
 * form or piece, credential material and shapes, private-key blocks, and the
 * display sanitizer's URLs and home-directory paths, which name a user. A
 * segment in which a configured credential or the canonical credential screen
 * still matches afterwards is withheld whole.
 *
 * Segment edges fall on code-point boundaries and segment text is well-formed
 * UTF-16, because the strict record reader refuses an unpaired surrogate and
 * would then refuse the whole run record.
 */

import { runtimeEgressRootSet } from "../config/egress-roots.js";
import { isInferenceRejectedReplyShape } from "./rejected-reply-shape.js";
import { sanitizeDisplaySpans } from "../operator/display-sanitize.js";
import {
  configuredCredentialSpans,
  containsConfiguredCredential,
} from "../security/configured-credentials.js";
import { credentialMaterialSpans } from "../security/credential-material.js";
import { egressText, type HostRootSet } from "../security/egress.js";
import { PublicRootsOperatorError } from "../security/public-roots.js";
import { detectCredentialRuleIds } from "../security/repository-scanner.js";
import {
  containsTextCredentialShape,
  TEXT_CREDENTIAL_SHAPES,
} from "../security/text-credential-shapes.js";

export const REJECTED_REPLY_EXCERPT_LIMIT = "inference.rejectedReplyExcerptChars" as const;

/** Written in place of each redacted span. */
export const REJECTED_REPLY_EXCERPT_REDACTION = "[REDACTED]";

export const REJECTED_REPLY_EXCERPT_SEGMENT_ROLES = ["head", "parse-position", "tail"] as const;
export type RejectedReplyExcerptSegmentRole = (typeof REJECTED_REPLY_EXCERPT_SEGMENT_ROLES)[number];

export const REJECTED_REPLY_EXCERPT_WITHHELD = "credential-material" as const;

export interface RejectedReplyExcerptSegmentV1 {
  readonly role: RejectedReplyExcerptSegmentRole;
  /** Reply character offsets of the copied range, `[start, end)`. */
  readonly start: number;
  readonly end: number;
  /** The copied range with each redacted span replaced; empty when withheld. */
  readonly text: string;
  /** Present when the credential screen withheld the whole segment. */
  readonly withheld?: typeof REJECTED_REPLY_EXCERPT_WITHHELD;
}

export interface InferenceRejectedReplyExcerptV1 {
  readonly schemaVersion: 1;
  /** Characters in the reply the decoder saw, after surrounding whitespace was trimmed. */
  readonly replyChars: number;
  /** Where the strict parser stopped, when it reported a position. */
  readonly parseOffset?: number;
  /** Non-overlapping, in reply order; empty when the bound is 0 or the reply is empty. */
  readonly segments: readonly RejectedReplyExcerptSegmentV1[];
  /** Reply characters no segment copied. */
  readonly omittedChars: number;
  /** Spans replaced by the marker, summed over the segments not withheld. */
  readonly redactions: number;
  readonly limit: typeof REJECTED_REPLY_EXCERPT_LIMIT;
  /** The per-segment bound in force when the excerpt was written. */
  readonly bound: number;
}

/**
 * The PEM or PGP banner is a credential shape, but the key body under it is
 * not, so the whole block is one span: through its END line, or to the end of
 * the text.
 */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/gu;

/**
 * The text JWT shape stops at the second dot, so the whole token, signature
 * included, is one span. The signature stops where another token's header and
 * payload begin, so back-to-back tokens are each matched.
 */
const WHOLE_JWT =
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.(?:(?!eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.)[A-Za-z0-9_-])*/gu;

/** The userinfo of any scheme's URL, such as `postgres://user:pw@` or `redis://:pw@`. */
const URL_USERINFO = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/?#@]+@/gu;

/**
 * A Basic authorization value, which the assignment shapes miss after the
 * scheme word. A preceding `Authorization:` key joins the span, or the key
 * beside the marker would read as an assignment.
 */
const BASIC_CREDENTIAL =
  /(?:\bauthorization["']?\s*[:=]\s*["']?)?\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/giu;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** `text` with each unpaired surrogate replaced by U+FFFD; the length is unchanged. */
function wellFormed(text: string): string {
  return text.replace(LONE_SURROGATE, "\uFFFD");
}

function isWellFormed(text: string): boolean {
  return !new RegExp(LONE_SURROGATE.source).test(text);
}

/** Whether `index` falls between the two halves of a surrogate pair. */
function splitsPair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const high = text.charCodeAt(index - 1);
  const low = text.charCodeAt(index);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

type Span = readonly [number, number];

const LEADING_BOUNDARY = /^[^A-Za-z0-9_-]+/u;

/** Every span to redact in `text`, sorted and merged. */
function credentialSpans(text: string): Span[] {
  const spans: Array<[number, number]> = [
    // DocsFab's own configured credentials, matched exactly in any form or
    // piece (#1807), then the shapes display redaction has always removed.
    ...configuredCredentialSpans(text),
    ...credentialMaterialSpans(text),
    ...sanitizeDisplaySpans(text),
  ].map(([start, end]) => [start, end] as [number, number]);
  for (const shape of [
    ...TEXT_CREDENTIAL_SHAPES,
    PRIVATE_KEY_BLOCK,
    WHOLE_JWT,
    URL_USERINFO,
    BASIC_CREDENTIAL,
  ]) {
    const flags = shape.flags.includes("g") ? shape.flags : `${shape.flags}g`;
    for (const match of text.matchAll(new RegExp(shape.source, flags))) {
      // The assignment shape consumes the character before its key as a boundary.
      const start = match.index + (LEADING_BOUNDARY.exec(match[0])?.[0].length ?? 0);
      const end = match.index + match[0].length;
      if (start < end) spans.push([start, end]);
    }
  }
  spans.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span[0] <= previous[1]) previous[1] = Math.max(previous[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

/** Credential spans, or `undefined` when a guard could not run, which withholds every segment. */
function spansOrWithhold(text: string): Span[] | undefined {
  try {
    return credentialSpans(text);
  } catch {
    return undefined;
  }
}

/**
 * `text[start, end)` redacted, made well-formed, and screened, or `undefined`
 * when the screen still matches or a guard throws; either withholds the segment.
 */
function admittedSegmentText(
  text: string,
  spans: readonly Span[] | undefined,
  start: number,
  end: number,
): { text: string; redactions: number } | undefined {
  if (!spans) return undefined;
  try {
    const redacted = redactRange(text, spans, start, end);
    const admitted = wellFormed(redacted.text);
    return screened(admitted) ? undefined : { text: admitted, redactions: redacted.redactions };
  } catch {
    return undefined;
  }
}

/** `text[start, end)` with each overlapping span, clipped to the range, replaced by one marker. */
function redactRange(
  text: string,
  spans: readonly Span[],
  start: number,
  end: number,
): { text: string; redactions: number } {
  let output = "";
  let cursor = start;
  let redactions = 0;
  for (const [spanStart, spanEnd] of spans) {
    if (spanEnd <= start || spanStart >= end) continue;
    output += text.slice(cursor, Math.max(cursor, spanStart));
    output += REJECTED_REPLY_EXCERPT_REDACTION;
    cursor = Math.min(end, spanEnd);
    redactions += 1;
  }
  return { text: output + text.slice(cursor, end), redactions };
}

/** Whether any shared credential screen, or a configured credential, still matches `text`. */
function screened(text: string): boolean {
  return (
    containsConfiguredCredential(text) ||
    detectCredentialRuleIds(text).length > 0 ||
    containsTextCredentialShape(text)
  );
}

type SegmentRange = Pick<RejectedReplyExcerptSegmentV1, "role" | "start" | "end">;

/**
 * Head, parse-position window, and tail ranges; each at most `bound` long. An
 * edge inside a surrogate pair moves inward, so no range splits a character.
 */
function segmentRanges(
  text: string,
  bound: number,
  parseOffset: number | undefined,
): SegmentRange[] {
  const { length } = text;
  if (bound === 0 || length === 0) return [];
  const inward = (index: number, step: 1 | -1) => (splitsPair(text, index) ? index + step : index);
  const headEnd = inward(Math.min(bound, length), -1);
  const tailStart = inward(Math.max(headEnd, length - bound), 1);
  const ranges: SegmentRange[] = [{ role: "head", start: 0, end: headEnd }];
  if (parseOffset !== undefined && parseOffset >= headEnd && parseOffset < tailStart) {
    const start = inward(Math.max(headEnd, parseOffset - Math.floor(bound / 2)), 1);
    const end = inward(Math.min(tailStart, start + bound), -1);
    ranges.push({ role: "parse-position", start, end });
  }
  if (tailStart < length) ranges.push({ role: "tail", start: tailStart, end: length });
  return ranges.filter((range) => range.start < range.end);
}

/**
 * Whether the shared credential screen matches any of `texts`; a guard that
 * cannot run counts as a match.
 */
function anyScreened(texts: readonly string[]): boolean {
  return texts.some((text) => {
    try {
      return screened(text);
    } catch {
      return true;
    }
  });
}

/**
 * Excerpt `reply` under `bound` characters per segment. Total: every input
 * yields an excerpt, so describing a failure cannot itself fail.
 *
 * `innerTexts` are strings decoded from inside `reply`, such as a tool-call
 * member sent as a JSON string (#1707). An escape can hide credential material
 * from a screen of the raw reply, so each is screened too, and a match in any
 * withholds every segment.
 */
export function excerptRejectedReply(
  reply: string,
  bound: number,
  parseOffset?: number,
  innerTexts: readonly string[] = [],
): InferenceRejectedReplyExcerptV1 {
  const text = reply.trim();
  const offset =
    parseOffset !== undefined && Number.isSafeInteger(parseOffset) && parseOffset >= 0
      ? Math.min(parseOffset, text.length)
      : undefined;
  const ranges = segmentRanges(text, bound, offset);
  const spans =
    ranges.length === 0 ? [] : anyScreened(innerTexts) ? undefined : spansOrWithhold(text);
  let redactions = 0;
  let copied = 0;
  const segments = ranges.map(({ role, start, end }): RejectedReplyExcerptSegmentV1 => {
    copied += end - start;
    const admitted = admittedSegmentText(text, spans, start, end);
    if (!admitted) {
      return { role, start, end, text: "", withheld: REJECTED_REPLY_EXCERPT_WITHHELD };
    }
    redactions += admitted.redactions;
    return { role, start, end, text: admitted.text };
  });
  return {
    schemaVersion: 1,
    replyChars: text.length,
    ...(offset === undefined ? {} : { parseOffset: offset }),
    segments,
    omittedChars: text.length - copied,
    redactions,
    limit: REJECTED_REPLY_EXCERPT_LIMIT,
    bound,
  };
}

/**
 * The excerpt an operator surface may print. Records are untrusted input, so
 * each segment is redacted and screened again, then this host's roots are
 * replaced as on every other egress surface. A stored segment the screen now
 * matches, for example under a rule added after it was written, is withheld
 * here rather than refused on read. Offsets and counts are unchanged.
 */
export function projectRejectedReplyExcerpt(
  excerpt: InferenceRejectedReplyExcerptV1,
  roots: HostRootSet,
): InferenceRejectedReplyExcerptV1 {
  return {
    ...excerpt,
    segments: excerpt.segments.map((segment) => {
      if (segment.withheld) return { ...segment };
      const admitted = admittedSegmentText(
        segment.text,
        spansOrWithhold(segment.text),
        0,
        segment.text.length,
      );
      const egress = admitted && egressText(admitted.text, roots);
      return egress?.ok
        ? { ...segment, text: egress.text }
        : { ...segment, text: "", withheld: REJECTED_REPLY_EXCERPT_WITHHELD };
    }),
  };
}

/**
 * This host's roots for `projectRejectedReplyExcerpt`. An excerpt must still
 * render when `DOCSFAB_PUBLIC_ROOTS` is invalid, so then no root is public.
 */
export function rejectedReplyExcerptDisplayRoots(): HostRootSet {
  try {
    return runtimeEgressRootSet();
  } catch (error) {
    if (!(error instanceof PublicRootsOperatorError)) throw error;
    return runtimeEgressRootSet({ publicRoots: new Set() });
  }
}

// Decoding: one closed validator every record decoder shares.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSegment(
  value: unknown,
  bound: number,
  replyChars: number,
  redactions: number,
  projected: boolean,
): boolean {
  if (!isPlainObject(value)) return false;
  if (!Object.keys(value).every((key) => SEGMENT_KEYS.includes(key))) return false;
  if (!(REJECTED_REPLY_EXCERPT_SEGMENT_ROLES as readonly unknown[]).includes(value.role)) {
    return false;
  }
  const { start, end, text } = value;
  if (!isCount(start) || !isCount(end) || start >= end || end > replyChars) return false;
  if (end - start > bound || typeof text !== "string") return false;
  if (value.withheld !== undefined) {
    return value.withheld === REJECTED_REPLY_EXCERPT_WITHHELD && text === "";
  }
  // Each marker replaces at least one character. A projected excerpt's root
  // placeholders can be longer than the roots they replace. Text the credential
  // screen matches is not refused here, so a rule added later cannot make an
  // older record unreadable; `projectRejectedReplyExcerpt` withholds it.
  return (
    (projected ||
      text.length <= end - start + redactions * REJECTED_REPLY_EXCERPT_REDACTION.length) &&
    isWellFormed(text)
  );
}

const SEGMENT_KEYS = ["role", "start", "end", "text", "withheld"];

/** `projected`: read an excerpt `projectRejectedReplyExcerpt` returned, not a record. */
export interface RejectedReplyExcerptReadOptions {
  readonly projected?: boolean;
}

/**
 * Whether `value` is a well-formed excerpt. Closed keys, ranges inside the
 * reply, in order, and no longer than the recorded bound, counts that add up,
 * and segment text without an unpaired surrogate.
 */
export function isInferenceRejectedReplyExcerpt(
  value: unknown,
  options: RejectedReplyExcerptReadOptions = {},
): value is InferenceRejectedReplyExcerptV1 {
  if (!isPlainObject(value)) return false;
  if (
    !Object.keys(value).every((key) =>
      [
        "schemaVersion",
        "replyChars",
        "parseOffset",
        "segments",
        "omittedChars",
        "redactions",
        "limit",
        "bound",
      ].includes(key),
    )
  ) {
    return false;
  }
  const { replyChars, parseOffset, segments, omittedChars, redactions, bound } = value;
  if (value.schemaVersion !== 1 || value.limit !== REJECTED_REPLY_EXCERPT_LIMIT) return false;
  if (!isCount(replyChars) || !isCount(omittedChars) || !isCount(redactions)) return false;
  // Any recorded bound reads: each segment is checked against it and against
  // the reply, so lowering the catalog maximum later cannot orphan a record.
  if (!isCount(bound)) return false;
  if (parseOffset !== undefined && (!isCount(parseOffset) || parseOffset > replyChars)) {
    return false;
  }
  if (!Array.isArray(segments) || segments.length > REJECTED_REPLY_EXCERPT_SEGMENT_ROLES.length) {
    return false;
  }
  let cursor = 0;
  let roleIndex = 0;
  let copied = 0;
  for (const segment of segments as unknown[]) {
    if (!isSegment(segment, bound, replyChars, redactions, options.projected === true)) {
      return false;
    }
    const { role, start, end } = segment as unknown as RejectedReplyExcerptSegmentV1;
    const index = REJECTED_REPLY_EXCERPT_SEGMENT_ROLES.indexOf(role);
    if (index < roleIndex || start < cursor) return false;
    roleIndex = index + 1;
    cursor = end;
    copied += end - start;
  }
  return omittedChars === replyChars - copied;
}

/**
 * Whether `excerpt` is a well-formed excerpt of the reply `shape` describes:
 * an attempt carries one only beside its fingerprint, with the same length and
 * parse position.
 */
export function isRejectedReplyExcerptOf(
  excerpt: unknown,
  shape: unknown,
  options: RejectedReplyExcerptReadOptions = {},
): boolean {
  if (!isInferenceRejectedReplyExcerpt(excerpt, options) || !isInferenceRejectedReplyShape(shape)) {
    return false;
  }
  const offset = shape.parse.status === "failed" ? shape.parse.offset : undefined;
  return excerpt.replyChars === shape.replyChars && excerpt.parseOffset === offset;
}
