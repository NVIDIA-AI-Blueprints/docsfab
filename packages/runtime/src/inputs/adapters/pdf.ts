// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * PDF text-evidence adapter built on the pinned `pdfjs-dist` text API. It never
 * tokenizes content streams, resolves objects, decodes fonts, or decompresses
 * anything itself.
 *
 * Two rules:
 * 1. Never emit text PDF.js did not produce. A page with an unmappable glyph is
 *    refused rather than quoted.
 * 2. Never report an incomplete read as complete. Every gap produces a
 *    limitation, which the host turns into `partial` completeness.
 *
 * PDF.js runs in-process (`in-process-inert`); the claim is only that no
 * filesystem, network, or subprocess capability is exercised during extraction.
 * The build reaches `fs` through `process.getBuiltinModule` on its URL-loading
 * path, so extraction passes `data`, never a URL. Its import-time
 * `@napi-rs/canvas` require runs before any document opens and fails closed
 * when the package is absent. Resolution of that require goes through Node's
 * own resolver, which the test below cannot observe. The test,
 * `test/source-evidence-pdf.test.ts`, wraps `getBuiltinModule` and the
 * capability modules and asserts an empty call log.
 */
import type { SourceLimitOverflowV1, SourceRepresentationLimitation } from "../source-evidence.js";
import {
  formatLimitOverflow,
  limit,
  type LimitOverflowObservationV1,
  type ResolveLimitsOptions,
} from "../../config/limits.js";
import {
  SOURCE_EXTRACTION_MAX_SPANS_LIMIT,
  SOURCE_PDF_MAX_PAGES_LIMIT,
  pdfMaxPages,
} from "../../config/source-read-limits.js";
import type {
  SourceExtractionRequestV1,
  SourceExtractionResultV1,
  SourceExtractionSegmentV1,
  SourceExtractorAdapterV1,
} from "../source-extraction.js";

export const PDF_SOURCE_EXTRACTOR_ID = "docsfab-pdf-text" as const;
export const PDF_SOURCE_EXTRACTOR_VERSION = "2" as const;
export const PDF_MEDIA_TYPE = "application/pdf" as const;

/**
 * Catalog `sources.pdfMaxPages` resolved at call time. Adapter identity hashes it
 * via `defaultOptions.maxPages`, so a host shrink changes the extractor identity.
 */
export function pdfExtractorMaxPages(options?: ResolveLimitsOptions): number {
  return pdfMaxPages(options);
}

/** Catalog default snapshot; extraction consumes `request.options.maxPages`, not this. */
export const PDF_MAX_PAGES = pdfExtractorMaxPages();

/**
 * Pinned `pdfjs-dist` version. It feeds `defaultOptions` and so every `spanId`,
 * so a parser upgrade changes span identity. A test asserts it matches the
 * installed and loaded versions.
 */
export const PDF_PARSER_VERSION = "6.3.289" as const;

/**
 * Frozen `getDocument` parameters. `isEvalSupported` is inert in `pdfjs-dist@6`
 * but stays to keep the intent legible and survive a downgrade.
 */
export const PDF_DOCUMENT_OPTIONS: Readonly<Record<string, unknown>> = Object.freeze({
  useWorkerFetch: false,
  useWasm: false,
  useSystemFonts: false,
  enableXfa: false,
  stopAtErrors: true,
  isEvalSupported: false,
  disableFontFace: true,
  disableAutoFetch: true,
  disableStream: true,
  verbosity: 0,
});

/**
 * Option names that would give PDF.js somewhere to fetch from; all stay unset.
 * A predefined-CMap document therefore fails closed with `unsupported-encoding`
 * instead of reaching outside the process for a mapping table.
 */
export const PDF_FORBIDDEN_RESOURCE_OPTIONS: readonly string[] = Object.freeze([
  "cMapUrl",
  "httpHeaders",
  "iccUrl",
  "range",
  "standardFontDataUrl",
  "url",
  "wasmUrl",
  "withCredentials",
]);

/** Specific reasons, narrower than the seam's shared limitation vocabulary. */
export const PDF_EVIDENCE_REASON_CODES = [
  "cancelled",
  "encrypted",
  "forms-layer-excluded",
  "malformed",
  "no-text-layer",
  "over-page-limit",
  "over-size",
  "unsupported-encoding",
  "xfa-form",
] as const;
export type PdfEvidenceReasonCode = (typeof PDF_EVIDENCE_REASON_CODES)[number];

export interface PdfEvidenceOutcomeV1 extends SourceExtractionResultV1 {
  /** Sorted and deduplicated. The seam only carries `limitations`. */
  reasons: readonly PdfEvidenceReasonCode[];
  /** Pages the document declares, before the ceiling is applied. */
  pageCount: number;
  extractedPages: number;
  /** Closed page or span axis when `over-page-limit` was recorded. */
  overflow?: LimitOverflowObservationV1;
}

interface PdfTextItem {
  str: string;
  hasEOL: boolean;
}

interface PdfTextContent {
  items: unknown[];
}

interface PdfPage {
  getTextContent(): Promise<PdfTextContent>;
  cleanup(): void;
}

interface PdfDocument {
  numPages: number;
  isPureXfa?: boolean;
  getPage(pageNumber: number): Promise<PdfPage>;
  getMetadata(): Promise<{ info?: Record<string, unknown> }>;
  /** `null` only when the document carries no security handler at all. */
  getPermissions(): Promise<unknown>;
}

interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

interface PdfJsModule {
  version: string;
  getDocument(parameters: Record<string, unknown>): PdfLoadingTask;
}

let pdfjsModule: Promise<PdfJsModule> | undefined;

/**
 * Loads the legacy build (no browser worker) once. The import is dynamic so a
 * host that never opens a PDF never loads the parser.
 */
export function loadPdfJs(): Promise<PdfJsModule> {
  pdfjsModule ??= import("pdfjs-dist/legacy/build/pdf.mjs") as unknown as Promise<PdfJsModule>;
  return pdfjsModule;
}

const ABORTERS = new WeakMap<SourceExtractionRequestV1, () => void>();

function isTextItem(item: unknown): item is PdfTextItem {
  return (
    typeof item === "object" && item !== null && typeof (item as { str?: unknown }).str === "string"
  );
}

/**
 * True when the string holds U+FFFD, a private-use code point, or an unpaired
 * surrogate (PDF.js's signals for an unmappable glyph); such text has no defined
 * meaning in the source, so citing it invents evidence. A control character
 * other than tab and LF also counts: a text layer does not legitimately produce
 * one, and it would corrupt the derivative.
 */
export function hasUnmappableGlyph(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit === 0xfffd) return true;
    if (unit >= 0xe000 && unit <= 0xf8ff) return true;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = index + 1 < value.length ? value.charCodeAt(index + 1) : Number.NaN;
      if (!(low >= 0xdc00 && low <= 0xdfff)) return true;
      // U+F0000-U+10FFFD, the supplementary private-use planes.
      if (unit >= 0xdb80) return true;
      index += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
    if (unit < 0x20 && unit !== 0x09 && unit !== 0x0a) return true;
    if (unit >= 0x7f && unit <= 0x9f) return true;
  }
  return false;
}

/**
 * Joins items in PDF.js order with a newline after each `hasEOL` item. No spacing
 * is guessed from glyph geometry; a guessed space is not in the source.
 */
export function joinPdfTextItems(items: readonly PdfTextItem[]): string {
  let text = "";
  for (const item of items) {
    text += item.str;
    if (item.hasEOL) text += "\n";
  }
  return text.trimEnd();
}

function classifyLoadFailure(error: unknown): PdfEvidenceReasonCode {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "PasswordException") return "encrypted";
  // PDF.js error messages can quote the untrusted bytes, so only a fixed code
  // leaves this module.
  return "malformed";
}

const REASON_LIMITATION: Readonly<Record<PdfEvidenceReasonCode, SourceRepresentationLimitation>> =
  Object.freeze({
    cancelled: "unsupported-structure",
    encrypted: "unsupported-structure",
    "forms-layer-excluded": "active-content-excluded",
    malformed: "unsupported-structure",
    "no-text-layer": "non-text-content-excluded",
    "over-page-limit": "span-budget-truncated",
    "over-size": "unsupported-structure",
    "unsupported-encoding": "unsupported-encoding",
    "xfa-form": "active-content-excluded",
  });

/**
 * Extracts page text from verified PDF bytes. `extract()` projects this onto the
 * seam's shape; this also reports specific reason codes the seam cannot express.
 */
export async function extractPdfTextEvidence(
  request: SourceExtractionRequestV1,
): Promise<PdfEvidenceOutcomeV1> {
  const reasons = new Set<PdfEvidenceReasonCode>();
  const segments: SourceExtractionSegmentV1[] = [];
  let pageCount = 0;
  let overflow: LimitOverflowObservationV1 | undefined;

  const done = (): PdfEvidenceOutcomeV1 => {
    const sortedReasons = [...reasons].sort();
    return {
      segments,
      limitations: [...new Set(sortedReasons.map((reason) => REASON_LIMITATION[reason]))].sort(),
      reasons: sortedReasons,
      pageCount,
      extractedPages: segments.length,
      ...(overflow ? { overflow } : {}),
    };
  };

  // The host checks this too; a direct caller gets the same refusal before any
  // byte reaches the parser.
  if (request.bytes.byteLength > request.limits.maxOriginalBytes) {
    reasons.add("over-size");
    return done();
  }

  // Validate the hashed page ceiling before PDF.js loads so a malformed bound
  // cannot open the original.
  const pageCeiling = boundPdfMaxPages(request.options);

  const pdfjs = await loadPdfJs();

  // PDF.js may detach the buffer it is handed; the host still digests the
  // original afterwards, so PDF.js gets a private copy.
  const data = new Uint8Array(request.bytes);

  const parameters: Record<string, unknown> = { ...PDF_DOCUMENT_OPTIONS, data };
  const task = pdfjs.getDocument(parameters);

  let destroyed = false;
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    // Fire-and-forget: a failed teardown must not become the reported outcome.
    void Promise.resolve(task.destroy()).catch(() => undefined);
  };
  request.signal?.addEventListener("abort", destroy, { once: true });
  ABORTERS.set(request, destroy);

  try {
    let document: PdfDocument;
    try {
      document = await task.promise;
    } catch (error) {
      reasons.add(classifyLoadFailure(error));
      return done();
    }

    pageCount = document.numPages;

    let info: Record<string, unknown> = {};
    try {
      info = (await document.getMetadata()).info ?? {};
    } catch {
      // Without metadata there is no encryption or XFA signal; refuse.
      reasons.add("malformed");
      return done();
    }

    // Encryption is decided after load: PDF.js silently decrypts a document with
    // an empty user password. Either signal refuses: `info.EncryptFilterName`
    // names an installed security handler, and `getPermissions()` is null only
    // without an `/Encrypt` dictionary. Neither matches bytes, so escaped names
    // like `/Encr#79pt` are caught too.
    let permissions: unknown;
    try {
      permissions = await document.getPermissions();
    } catch {
      reasons.add("malformed");
      return done();
    }
    if (typeof info.EncryptFilterName === "string" || permissions !== null) {
      reasons.add("encrypted");
      return done();
    }

    if (document.isPureXfa === true || info.IsXFAPresent === true) {
      // XFA content lives in the XFA stream, so page text is not the document.
      reasons.add("xfa-form");
      return done();
    }
    if (info.IsAcroFormPresent === true) {
      // Static page text is real, but field values are not in it.
      reasons.add("forms-layer-excluded");
    }

    const readablePages = Math.min(pageCount, pageCeiling);
    if (pageCount > pageCeiling) {
      reasons.add("over-page-limit");
      overflow = { limitName: SOURCE_PDF_MAX_PAGES_LIMIT, observed: pageCount };
    }

    for (let pageNumber = 1; pageNumber <= readablePages; pageNumber += 1) {
      if (request.signal?.aborted) {
        reasons.add("cancelled");
        return done();
      }
      if (segments.length >= request.limits.maxSpans) {
        reasons.add("over-page-limit");
        overflow ??= { limitName: SOURCE_EXTRACTION_MAX_SPANS_LIMIT };
        break;
      }

      let page: PdfPage;
      let content: PdfTextContent;
      try {
        page = await document.getPage(pageNumber);
      } catch {
        reasons.add("malformed");
        continue;
      }
      try {
        content = await page.getTextContent();
      } catch {
        reasons.add("malformed");
        continue;
      } finally {
        page.cleanup();
      }

      // The locator indexes into this sequence: PDF.js text items in order,
      // marked-content records removed.
      const items = content.items.filter(isTextItem);
      if (items.length === 0) {
        // Image-only and empty pages are indistinguishable through the text API;
        // either way the page has no citable text.
        reasons.add("no-text-layer");
        continue;
      }
      if (items.some((item) => hasUnmappableGlyph(item.str))) {
        reasons.add("unsupported-encoding");
        continue;
      }
      const text = joinPdfTextItems(items);
      if (text.length === 0) {
        reasons.add("no-text-layer");
        continue;
      }
      segments.push({
        text,
        locator: { kind: "pdf-page", pageNumber, itemStart: 0, itemEnd: items.length },
      });
    }

    return done();
  } finally {
    ABORTERS.delete(request);
    request.signal?.removeEventListener("abort", destroy);
    destroy();
  }
}

function projectPdfOverflow(outcome: PdfEvidenceOutcomeV1): SourceLimitOverflowV1 | undefined {
  if (
    typeof outcome.overflow?.observed !== "number" ||
    !outcome.limitations.includes("span-budget-truncated")
  ) {
    return undefined;
  }
  return {
    limitation: "span-budget-truncated",
    limitName: outcome.overflow.limitName,
    observed: outcome.overflow.observed,
  };
}

async function extract(request: SourceExtractionRequestV1): Promise<SourceExtractionResultV1> {
  const outcome = await extractPdfTextEvidence(request);
  const overflow = projectPdfOverflow(outcome);
  return {
    segments: outcome.segments,
    limitations: outcome.limitations,
    ...(overflow ? { overflows: Object.freeze([overflow]) } : {}),
  };
}

/** Returns the ceiling hashed into this request; throws on a malformed bound. */
function boundPdfMaxPages(options: Readonly<Record<string, unknown>>): number {
  const value = options.maxPages;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("PDF extraction refused because the hashed maxPages bound is invalid-limits.");
  }
  return value;
}

function abort(request: SourceExtractionRequestV1): void {
  ABORTERS.get(request)?.();
}

export const pdfSourceExtractorAdapter: SourceExtractorAdapterV1 = Object.freeze({
  id: PDF_SOURCE_EXTRACTOR_ID,
  version: PDF_SOURCE_EXTRACTOR_VERSION,
  locatorKind: "pdf-page",
  mediaTypes: Object.freeze([PDF_MEDIA_TYPE]),
  get defaultOptions() {
    return Object.freeze({
      ...PDF_DOCUMENT_OPTIONS,
      maxPages: pdfExtractorMaxPages(),
      parser: "pdfjs-dist",
      parserVersion: PDF_PARSER_VERSION,
    });
  },
  extract,
  abort,
});

/**
 * Recover-class operator lines for PDF page-ceiling truncation. The sealed
 * representation carries `span-budget-truncated`; this names the limit.
 */
export function formatPdfEvidenceLimitations(
  outcome: Pick<PdfEvidenceOutcomeV1, "reasons" | "pageCount" | "overflow">,
  options?: ResolveLimitsOptions,
): readonly string[] {
  if (!outcome.reasons.includes("over-page-limit")) return Object.freeze([]);
  const catalog = outcome.overflow?.limitName ?? SOURCE_PDF_MAX_PAGES_LIMIT;
  return Object.freeze([
    `over-page-limit; ${formatLimitOverflow(limit(catalog, options), outcome.overflow)}`,
  ]);
}
