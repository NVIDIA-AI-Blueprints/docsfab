// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Original-to-derivative extraction seam. An adapter returns ordered text
 * segments with locators; this module owns the derivative buffer layout, byte
 * digests, span identifiers, budgets, and the sealed representation. Adapters
 * never mint identifiers, digests, or representation descriptors.
 */

import {
  formatLimitExceeded,
  formatLimitObservation,
  formatLimitOverflow,
  limit,
  limitDefinition,
  type ResolveLimitsOptions,
} from "../config/limits.js";
import {
  SOURCE_EXTRACTION_MAX_DERIVATIVE_BYTES_LIMIT,
  SOURCE_EXTRACTION_MAX_ORIGINAL_BYTES_LIMIT,
  SOURCE_EXTRACTION_MAX_SPAN_BYTES_LIMIT,
  SOURCE_EXTRACTION_MAX_SPANS_LIMIT,
  isDeclaredSourceOverflowLimitName,
  sourceExtractionMaxDerivativeBytes,
  sourceExtractionMaxMs,
  sourceExtractionMaxOriginalBytes,
  sourceExtractionMaxSpanBytes,
  sourceExtractionMaxSpans,
} from "../config/source-read-limits.js";
import {
  createSourceRepresentation,
  digestSourceExtractorOptions,
  type SourceExtractorIdentityV1,
  type SourceLimitOverflowV1,
  type SourceLocatorKind,
  type SourceRepresentationLimitation,
  type SourceRepresentationV1,
  type SourceSpanLocatorV1,
  type SourceSpanV1,
  computeSourceSpanId,
} from "./source-evidence.js";
import { sha256 as sha256Bytes } from "../content-ir/canonical.js";

export const SOURCE_EXTRACTION_ERROR_CODES = [
  "adapter-failed",
  "adapter-invalid",
  "duplicate-adapter",
  "empty-extraction",
  "extraction-cancelled",
  "extraction-deadline-exceeded",
  "invalid-limits",
  "original-budget-exceeded",
  "unsupported-media-type",
] as const;
export type SourceExtractionErrorCode = (typeof SOURCE_EXTRACTION_ERROR_CODES)[number];

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set(SOURCE_EXTRACTION_ERROR_CODES);

export class SourceExtractionError extends Error {
  public constructor(
    public readonly code: SourceExtractionErrorCode,
    /**
     * A budget refusal's catalog line: the limit's refusal code, the observed
     * value, the limit and its value, and the remediation. Host text only; it
     * never carries document bytes.
     */
    public readonly limitRefusal?: string,
  ) {
    super(`Source extraction rejected: ${code}.${limitRefusal ? ` ${limitRefusal}` : ""}`);
    this.name = "SourceExtractionError";
  }
}

/**
 * Refuses with a fixed code only. The message interpolates the code, so an
 * unrecognized code would publish arbitrary text through the error string.
 */
function fail(code: SourceExtractionErrorCode): never {
  throw new SourceExtractionError(KNOWN_ERROR_CODES.has(code) ? code : "adapter-failed");
}

/**
 * Identifies refusals the host minted itself. An adapter can throw any class,
 * code, or Proxy (which answers every property read, even a private Symbol), so
 * only WeakSet identity is trusted, and no property is read before membership.
 * `has` is captured at module evaluation so a later patch to WeakSet.prototype cannot
 * change the answer.
 */
const HOST_REFUSALS = new WeakSet<object>();
const weakSetHas = WeakSet.prototype.has;

interface HostRefusal {
  readonly code: SourceExtractionErrorCode;
}

function hostRefusal(code: SourceExtractionErrorCode): HostRefusal {
  const refusal: HostRefusal = Object.freeze({ code });
  HOST_REFUSALS.add(refusal);
  return refusal;
}

function isHostRefusal(value: unknown): value is HostRefusal {
  return typeof value === "object" && value !== null && weakSetHas.call(HOST_REFUSALS, value);
}

export interface SourceExtractionLimitsV1 {
  /** Exceeding it fails closed. */
  maxOriginalBytes: number;
  /** Exceeding it truncates with a limitation. */
  maxDerivativeBytes: number;
  /** Exceeding it truncates with a limitation. */
  maxSpans: number;
  /** A longer segment is split into consecutive spans of at most this many bytes. */
  maxSpanBytes: number;
  /**
   * Wall-clock ceiling on one `extract()` call, in milliseconds. It is a timer
   * race, so it fires only at the adapter's `await` points: a synchronous
   * CPU-bound adapter can overrun it without bound and its result is still
   * sealed (pinned by `test/source-evidence-intake.test.ts`). Preemption needs
   * the unimplemented `confined-subprocess` mode. No upper clamp is applied.
   */
  maxExtractionMs: number;
}

export function sourceExtractionLimits(
  options?: ResolveLimitsOptions,
): Readonly<SourceExtractionLimitsV1> {
  return Object.freeze({
    maxOriginalBytes: sourceExtractionMaxOriginalBytes(options),
    maxDerivativeBytes: sourceExtractionMaxDerivativeBytes(options),
    maxSpans: sourceExtractionMaxSpans(options),
    maxSpanBytes: sourceExtractionMaxSpanBytes(options),
    maxExtractionMs: sourceExtractionMaxMs(options),
  });
}

export const DEFAULT_SOURCE_EXTRACTION_LIMITS: Readonly<SourceExtractionLimitsV1> =
  sourceExtractionLimits();

/** One extracted passage plus the locator that points it back at the original. */
export interface SourceExtractionSegmentV1 {
  text: string;
  locator: SourceSpanLocatorV1;
}

export interface SourceExtractionResultV1 {
  segments: SourceExtractionSegmentV1[];
  limitations: SourceRepresentationLimitation[];
  /**
   * Pre-truncation observations for adapters that clip. The host merges them into
   * the sealed representation so formatters name the right catalog key.
   */
  overflows?: readonly SourceLimitOverflowV1[];
}

export interface SourceExtractionRequestV1 {
  bytes: Uint8Array;
  options: Readonly<Record<string, unknown>>;
  limits: Readonly<SourceExtractionLimitsV1>;
  /**
   * Aborts on caller cancellation or deadline. Observing it is the only way an
   * in-process adapter can honor a deadline it is overrunning.
   */
  signal?: AbortSignal;
}

/**
 * `extract` must be an in-process, inert transformation: no network,
 * filesystem, subprocess, script evaluation, or DOM; the host does not enforce
 * this. It returns text and locators only. A promise return does not widen what
 * it may touch; both shapes run in the same budget and deadline wrapper.
 */
export interface SourceExtractorAdapterV1 {
  readonly id: string;
  readonly version: string;
  /** The only locator kind this adapter may emit. */
  readonly locatorKind: SourceLocatorKind;
  /** Original media types this adapter claims, lowercase and parameter-free. */
  readonly mediaTypes: readonly string[];
  readonly defaultOptions: Readonly<Record<string, unknown>>;
  extract(
    request: SourceExtractionRequestV1,
  ): SourceExtractionResultV1 | Promise<SourceExtractionResultV1>;
  /**
   * Called at most once, with the request `extract` received, after
   * `request.signal` aborted. Synchronous; it cannot produce a result because
   * the host has already refused.
   */
  abort?(request: SourceExtractionRequestV1): void;
}

export interface SourceExtractorRegistryV1 {
  resolve(mediaType: string): SourceExtractorAdapterV1 | undefined;
  list(): readonly SourceExtractorAdapterV1[];
}

const ADAPTER_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/u;
const ADAPTER_VERSION = /^[0-9][0-9A-Za-z.-]{0,31}$/u;

function assertAdapter(adapter: SourceExtractorAdapterV1): void {
  if (
    !adapter ||
    typeof adapter !== "object" ||
    typeof adapter.extract !== "function" ||
    typeof adapter.id !== "string" ||
    !ADAPTER_ID.test(adapter.id) ||
    typeof adapter.version !== "string" ||
    !ADAPTER_VERSION.test(adapter.version) ||
    !Array.isArray(adapter.mediaTypes) ||
    adapter.mediaTypes.length === 0 ||
    adapter.mediaTypes.some(
      (value) => typeof value !== "string" || value !== value.toLowerCase(),
    ) ||
    (adapter.abort !== undefined && typeof adapter.abort !== "function")
  ) {
    fail("adapter-invalid");
  }
}

/** Duplicate media-type claims fail closed. */
export function createSourceExtractorRegistry(
  adapters: readonly SourceExtractorAdapterV1[],
): SourceExtractorRegistryV1 {
  const byMediaType = new Map<string, SourceExtractorAdapterV1>();
  for (const adapter of adapters) {
    assertAdapter(adapter);
    for (const mediaType of adapter.mediaTypes) {
      if (byMediaType.has(mediaType)) fail("duplicate-adapter");
      byMediaType.set(mediaType, adapter);
    }
  }
  const frozen = Object.freeze([...adapters]);
  return Object.freeze({
    resolve(mediaType: string): SourceExtractorAdapterV1 | undefined {
      return byMediaType.get(normalizeMediaType(mediaType));
    },
    list(): readonly SourceExtractorAdapterV1[] {
      return frozen;
    },
  });
}

/** Strip parameters and case so `text/html; charset=utf-8` resolves `text/html`. */
export function normalizeMediaType(value: string): string {
  return String(value).split(";")[0]!.trim().toLowerCase();
}

export { sha256Bytes };

export interface ExtractSourceRepresentationInput {
  adapter: SourceExtractorAdapterV1;
  bytes: Uint8Array;
  mediaType: string;
  options?: Record<string, unknown>;
  limits?: Partial<SourceExtractionLimitsV1>;
  signal?: AbortSignal;
}

export interface ExtractSourceRepresentationResult {
  representation: SourceRepresentationV1;
  /** Spans index into these bytes. */
  derivative: Uint8Array;
  originalSha256: string;
  extractor: SourceExtractorIdentityV1;
}

/**
 * Returns only a result that arrives before the deadline or caller cancellation.
 * This is not preemption (see `maxExtractionMs`). For an adapter that yields, the
 * host refuses, discards any late result, and signals stop via `request.signal`
 * and `abort()`.
 */
async function runAdapterUnderDeadline(
  adapter: SourceExtractorAdapterV1,
  request: SourceExtractionRequestV1,
  controller: AbortController,
  deadlineMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<SourceExtractionResultV1> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detachCaller: (() => void) | undefined;
  // Set only when the host stopped waiting on a still-running adapter.
  let hostGaveUp = false;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(hostRefusal("extraction-deadline-exceeded"));
    }, deadlineMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  });

  // Raced, not merely observed, so a caller that gives up does not wait on an
  // adapter that may never return.
  const cancellation = new Promise<never>((_resolve, reject) => {
    if (callerSignal === undefined) return;
    const onAbort = () => {
      controller.abort();
      reject(hostRefusal("extraction-cancelled"));
    };
    callerSignal.addEventListener("abort", onAbort, { once: true });
    detachCaller = () => callerSignal.removeEventListener("abort", onAbort);
  });

  // Normalizes a synchronous return, a synchronous throw, and a promise.
  const attempt = (async () => adapter.extract(request))();
  try {
    return await Promise.race([attempt, deadline, cancellation]);
  } catch (error) {
    // Establish membership before reading `code`; see HOST_REFUSALS.
    if (isHostRefusal(error)) {
      hostGaveUp = true;
      return fail(error.code);
    }
    if (callerSignal?.aborted) return fail("extraction-cancelled");
    // The adapter's error can quote untrusted bytes, so it never escapes.
    return fail("adapter-failed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    detachCaller?.();
    if (hostGaveUp) {
      controller.abort();
      try {
        adapter.abort?.(request);
      } catch {
        // A throwing teardown must not replace the host's refusal.
      }
    }
    // Late settlements are never inspected but always handled, so they cannot
    // crash the process as unhandled rejections.
    void attempt.then(
      () => undefined,
      () => undefined,
    );
    void deadline.catch(() => undefined);
    void cancellation.catch(() => undefined);
  }
}

/**
 * Runs one adapter under the budgets and seals the result. The derivative is the
 * segments joined by newlines; separators belong to no span, so spans never
 * overlap and every boundary lands on a code-point boundary.
 */
export async function extractSourceRepresentation(
  input: ExtractSourceRepresentationInput,
): Promise<ExtractSourceRepresentationResult> {
  assertAdapter(input.adapter);
  if (input.signal?.aborted) fail("extraction-cancelled");
  const mediaType = normalizeMediaType(input.mediaType);
  if (!input.adapter.mediaTypes.includes(mediaType)) fail("unsupported-media-type");
  const limits: SourceExtractionLimitsV1 = {
    ...sourceExtractionLimits(),
    ...(input.limits ?? {}),
  };
  for (const value of [
    limits.maxOriginalBytes,
    limits.maxDerivativeBytes,
    limits.maxSpans,
    limits.maxSpanBytes,
    limits.maxExtractionMs,
  ]) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail("invalid-limits");
  }
  // Below the catalog minimum a piece could not hold one whole code point.
  if (
    !Number.isSafeInteger(limits.maxSpanBytes) ||
    limits.maxSpanBytes < limitDefinition(SOURCE_EXTRACTION_MAX_SPAN_BYTES_LIMIT).min
  ) {
    fail("invalid-limits");
  }
  if (input.bytes.byteLength > limits.maxOriginalBytes) {
    throw originalBudgetExceededError(input.bytes.byteLength, limits.maxOriginalBytes);
  }

  const options = Object.freeze({ ...input.adapter.defaultOptions, ...(input.options ?? {}) });
  assertBoundExtractorOptions(options);
  const optionsSha256 = digestSourceExtractorOptions({
    adapterId: input.adapter.id,
    adapterVersion: input.adapter.version,
    locatorKind: input.adapter.locatorKind,
    limits,
    options,
  });
  const extractor: SourceExtractorIdentityV1 = {
    id: input.adapter.id,
    version: input.adapter.version,
    optionsSha256,
  };

  const controller = new AbortController();
  const request: SourceExtractionRequestV1 = Object.freeze({
    bytes: input.bytes,
    options,
    limits: Object.freeze({ ...limits }),
    signal: controller.signal,
  });
  const result = await runAdapterUnderDeadline(
    input.adapter,
    request,
    controller,
    limits.maxExtractionMs,
    input.signal,
  );
  if (input.signal?.aborted) fail("extraction-cancelled");
  if (!result || !Array.isArray(result.segments) || !Array.isArray(result.limitations)) {
    fail("adapter-invalid");
  }
  if (result.segments.some((segment) => segment.locator.kind !== input.adapter.locatorKind)) {
    fail("adapter-invalid");
  }

  const limitations = new Set<SourceRepresentationLimitation>(result.limitations);
  const hostOverflows: SourceLimitOverflowV1[] = [...adapterOverflows(result)];
  const kept: Array<{ locator: SourceSpanLocatorV1; startByte: number; endByte: number }> = [];
  const chunks: Buffer[] = [];
  const separator = Buffer.from("\n", "utf8");
  let fullDerivativeBytes = 0;
  let fullSpanCount = 0;
  const encodedSegments = result.segments.map((segment, index) => {
    if (typeof segment.text !== "string" || segment.text.length === 0) fail("adapter-invalid");
    const encoded = Buffer.from(segment.text, "utf8");
    const pieces = spanPieces(encoded, limits.maxSpanBytes);
    fullDerivativeBytes += encoded.byteLength + (index === 0 ? 0 : separator.byteLength);
    fullSpanCount += pieces.length;
    return { segment, encoded, pieces };
  });
  let offset = 0;
  // A budget keeps or drops a segment whole. A kept prefix of a split segment
  // could end inside a configured credential, leaving a fragment the
  // credential screen, which judges each segment's run of pieces, never sees.
  for (const { segment, encoded, pieces } of encodedSegments) {
    if (kept.length + pieces.length > limits.maxSpans) {
      limitations.add("span-budget-truncated");
      hostOverflows.push({
        limitation: "span-budget-truncated",
        limitName: SOURCE_EXTRACTION_MAX_SPANS_LIMIT,
        observed: fullSpanCount,
      });
      break;
    }
    const prefix = kept.length === 0 ? 0 : separator.byteLength;
    if (offset + prefix + encoded.byteLength > limits.maxDerivativeBytes) {
      limitations.add("byte-budget-truncated");
      hostOverflows.push({
        limitation: "byte-budget-truncated",
        limitName: SOURCE_EXTRACTION_MAX_DERIVATIVE_BYTES_LIMIT,
        observed: fullDerivativeBytes,
      });
      break;
    }
    if (prefix > 0) {
      chunks.push(separator);
      offset += prefix;
    }
    chunks.push(encoded);
    for (const [start, end] of pieces) {
      kept.push({
        locator: pieceLocator(segment.locator, encoded.byteLength, start, end),
        startByte: offset + start,
        endByte: offset + end,
      });
    }
    offset += encoded.byteLength;
  }
  if (kept.length === 0) fail("empty-extraction");

  const derivative = new Uint8Array(Buffer.concat(chunks));
  const originalSha256 = sha256Bytes(input.bytes);
  const derivativeSha256 = sha256Bytes(derivative);
  const spans: SourceSpanV1[] = kept.map((piece) => ({
    spanId: computeSourceSpanId({
      originalSha256,
      extractor,
      derivativeSha256,
      startByte: piece.startByte,
      endByte: piece.endByte,
      locator: piece.locator,
    }),
    startByte: piece.startByte,
    endByte: piece.endByte,
    locator: piece.locator,
  }));
  const sortedLimitations = [...limitations].sort();
  const uniqueOverflows = uniqueOverflowsByLimitation(hostOverflows);
  const representation = createSourceRepresentation({
    sha256: derivativeSha256,
    byteLength: derivative.byteLength,
    extractor,
    originalSha256,
    spans,
    completeness: sortedLimitations.length === 0 ? "complete" : "partial",
    limitations: sortedLimitations,
    ...(uniqueOverflows.length > 0 ? { overflows: uniqueOverflows } : {}),
  });
  return { representation, derivative, originalSha256, extractor };
}

/**
 * How many spans one segment's text becomes under `maxSpanBytes`, so an
 * adapter can plan its segments against the span ceiling the host enforces.
 */
export function sourceSegmentSpanCount(text: string, maxSpanBytes: number): number {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= maxSpanBytes) return 1;
  let count = 0;
  let start = 0;
  while (start < encoded.byteLength) {
    start = spanPieceEnd(encoded, start, maxSpanBytes);
    count += 1;
  }
  return count;
}

function spanPieceEnd(encoded: Buffer, start: number, maxBytes: number): number {
  let end = Math.min(start + maxBytes, encoded.byteLength);
  // A continuation byte is 10xxxxxx; move the cut to its code point's lead byte.
  while (end < encoded.byteLength && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return end;
}

/**
 * Byte ranges, within one encoded segment, of the spans it becomes: the whole
 * segment, or consecutive pieces of at most `maxBytes` that end on a UTF-8
 * code-point boundary and together cover every byte.
 */
function spanPieces(encoded: Buffer, maxBytes: number): Array<readonly [number, number]> {
  if (encoded.byteLength <= maxBytes) return [[0, encoded.byteLength]];
  const pieces: Array<readonly [number, number]> = [];
  let start = 0;
  while (start < encoded.byteLength) {
    const end = spanPieceEnd(encoded, start, maxBytes);
    pieces.push([start, end]);
    start = end;
  }
  return pieces;
}

/**
 * The locator of one piece of a segment. A `text`, `notebook-cell`, or `diff`
 * range as wide as the segment's derivative bytes measures those bytes, so it
 * narrows to the piece; the shipped adapters always emit such ranges, since a
 * BOM or CRLF only shifts where a line starts. A `diff` piece keeps its file
 * and hunk fields, and a manifest piece, which has no original range, keeps
 * its locator. A range of another width, such as one over transcoded original
 * bytes, and every other locator kind keep naming the whole unit the piece was
 * cut from rather than guess an offset.
 */
function pieceLocator(
  locator: SourceSpanLocatorV1,
  segmentBytes: number,
  start: number,
  end: number,
): SourceSpanLocatorV1 {
  if (start === 0 && end === segmentBytes) return locator;
  if (
    (locator.kind === "text" || locator.kind === "notebook-cell") &&
    locator.endByte - locator.startByte === segmentBytes
  ) {
    return { ...locator, startByte: locator.startByte + start, endByte: locator.startByte + end };
  }
  if (
    locator.kind === "diff" &&
    locator.startByte !== null &&
    locator.endByte !== null &&
    locator.endByte - locator.startByte === segmentBytes
  ) {
    return { ...locator, startByte: locator.startByte + start, endByte: locator.startByte + end };
  }
  return locator;
}

/** Reads one span's retained text; a derivative that does not match the seal is rejected. */
export function readSourceSpanBytes(
  representation: SourceRepresentationV1,
  derivative: Uint8Array,
  spanId: string,
): string {
  const span = representation.spans.find((entry) => entry.spanId === spanId);
  if (!span) fail("adapter-invalid");
  return sourceSpanTextReader(representation, derivative)(span);
}

/**
 * Checks a derivative against its seal once, then reads any of the
 * representation's spans from it, so a read of many spans hashes the
 * derivative once rather than once per span.
 */
export function sourceSpanTextReader(
  representation: SourceRepresentationV1,
  derivative: Uint8Array,
): (span: Pick<SourceSpanV1, "startByte" | "endByte">) => string {
  if (sha256Bytes(derivative) !== representation.sha256) fail("adapter-invalid");
  return (span) => Buffer.from(derivative.subarray(span.startByte, span.endByte)).toString("utf8");
}

const EXTRACTION_LIMITATION_CATALOG: Readonly<
  Partial<Record<SourceRepresentationLimitation, string>>
> = Object.freeze({
  "byte-budget-truncated": SOURCE_EXTRACTION_MAX_DERIVATIVE_BYTES_LIMIT,
  "span-budget-truncated": SOURCE_EXTRACTION_MAX_SPANS_LIMIT,
});

/**
 * Recover-class operator lines for truncation flags on a sealed representation.
 * `--source` acquisition refuses truncation; other extracts keep the flag so a
 * later summary cannot silently clip.
 */
export function formatSourceRepresentationLimitations(
  representation: Pick<SourceRepresentationV1, "limitations" | "overflows">,
  options?: ResolveLimitsOptions,
): readonly string[] {
  return Object.freeze(
    representation.limitations.map((reasonCode) => {
      const overflow = representation.overflows?.find((entry) => entry.limitation === reasonCode);
      const catalog = overflow?.limitName ?? EXTRACTION_LIMITATION_CATALOG[reasonCode];
      if (!catalog) return reasonCode;
      return `${reasonCode}; ${formatLimitOverflow(limit(catalog, options), overflow)}`;
    }),
  );
}

function uniqueOverflowsByLimitation(
  overflows: readonly SourceLimitOverflowV1[],
): SourceLimitOverflowV1[] {
  return [...new Map(overflows.map((entry) => [entry.limitation, entry])).values()];
}

/** A malformed identity-bound `maxPages` fails here, before the adapter opens the original. */
function assertBoundExtractorOptions(options: Readonly<Record<string, unknown>>): void {
  if (!Object.hasOwn(options, "maxPages")) return;
  const maxPages = options.maxPages;
  if (typeof maxPages !== "number" || !Number.isSafeInteger(maxPages) || maxPages <= 0) {
    fail("invalid-limits");
  }
}

function adapterOverflows(result: SourceExtractionResultV1): SourceLimitOverflowV1[] {
  if (result.overflows === undefined) return [];
  if (!Array.isArray(result.overflows)) fail("adapter-invalid");
  return result.overflows.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !result.limitations.includes(entry.limitation) ||
      typeof entry.limitName !== "string" ||
      !isDeclaredSourceOverflowLimitName(entry.limitName) ||
      typeof entry.observed !== "number" ||
      !Number.isSafeInteger(entry.observed) ||
      entry.observed < 0
    ) {
      fail("adapter-invalid");
    }
    return {
      limitation: entry.limitation,
      limitName: entry.limitName,
      observed: entry.observed,
    };
  });
}

/**
 * The catalog line for an original over the byte bound: the limit's refusal
 * code, the observed bytes when the caller measured them, the bound in force
 * (which an embedding host may have lowered below the catalog's, or a host
 * override raised above it), and the remediation naming the override.
 */
export function formatOriginalBudgetRefusal(
  observedBytes: number | undefined,
  maxOriginalBytes: number,
  options?: ResolveLimitsOptions,
): string {
  const bound = {
    ...limit(SOURCE_EXTRACTION_MAX_ORIGINAL_BYTES_LIMIT, options),
    value: maxOriginalBytes,
  };
  return observedBytes === undefined
    ? formatLimitExceeded(bound)
    : formatLimitObservation(bound, observedBytes);
}

/**
 * The catalog line for a truncation a representation records: the limit's
 * refusal code, the size the adapter produced, the bound in force, and the
 * remediation. `boundInForce` is the ceiling the extraction ran under, when
 * the overflow is that ceiling's own.
 */
export function formatTruncationRefusal(
  representation: Pick<SourceRepresentationV1, "overflows">,
  limitation: "byte-budget-truncated" | "span-budget-truncated",
  boundInForce?: number,
  options?: ResolveLimitsOptions,
): string {
  const ownLimit = EXTRACTION_LIMITATION_CATALOG[limitation]!;
  const overflow = representation.overflows?.find((entry) => entry.limitation === limitation);
  const name = overflow?.limitName ?? ownLimit;
  const resolved = limit(name, options);
  return formatLimitOverflow(
    boundInForce !== undefined && name === ownLimit
      ? { ...resolved, value: boundInForce }
      : resolved,
    overflow,
  );
}

/** The extraction refusal for an original over the byte bound, with its catalog line. */
export function originalBudgetExceededError(
  observedBytes: number,
  maxOriginalBytes: number,
  options?: ResolveLimitsOptions,
): SourceExtractionError {
  return new SourceExtractionError(
    "original-budget-exceeded",
    formatOriginalBudgetRefusal(observedBytes, maxOriginalBytes, options),
  );
}

/** Catalog refusal line for an original over the byte bound. */
export function formatOriginalBudgetExceeded(
  observedBytes: number,
  options?: ResolveLimitsOptions,
): string {
  return formatLimitObservation(
    limit(SOURCE_EXTRACTION_MAX_ORIGINAL_BYTES_LIMIT, options),
    observedBytes,
  );
}
