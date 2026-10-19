// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Operational bounds for source-read grants, extraction, and PDF page
 * ceilings, projected from the operational-limits catalog.
 *
 * Each numeric bound is declared once in the root `config/limits.yaml`.
 * Callers that must honor a host override read through `limit()` at use time.
 */
import { limit, type ResolveLimitsOptions, type ResolvedLimit } from "./limits.js";
import { LIMIT_DEFINITION_BY_NAME } from "./limits.generated.js";

export const SOURCE_READ_RESPONSE_CEILING_LIMIT = "sources.readResponseCeilingBytes" as const;
export const SOURCE_READ_INPUT_WINDOW_SHARE_LIMIT = "sources.readInputWindowShare" as const;
export const SOURCE_EXTRACTION_MAX_ORIGINAL_BYTES_LIMIT =
  "sources.extractionMaxOriginalBytes" as const;
export const SOURCE_EXTRACTION_MAX_DERIVATIVE_BYTES_LIMIT =
  "sources.extractionMaxDerivativeBytes" as const;
export const SOURCE_EXTRACTION_MAX_SPANS_LIMIT = "sources.extractionMaxSpans" as const;
export const SOURCE_EXTRACTION_MAX_SPAN_BYTES_LIMIT = "sources.extractionMaxSpanBytes" as const;
export const SOURCE_EXTRACTION_MAX_MS_LIMIT = "sources.extractionMaxMs" as const;
export const SOURCE_PDF_MAX_PAGES_LIMIT = "sources.pdfMaxPages" as const;
/** Sealed: the longest repository-relative path sealed source evidence keeps. */
export const SOURCE_AUTHORITY_MEMBER_PATH_MAX_CHARS_LIMIT =
  "sources.authorityMemberPathMaxChars" as const;

export const SOURCE_OVERFLOW_LIMIT_NAMES = Object.freeze([
  SOURCE_EXTRACTION_MAX_DERIVATIVE_BYTES_LIMIT,
  SOURCE_EXTRACTION_MAX_SPANS_LIMIT,
  SOURCE_PDF_MAX_PAGES_LIMIT,
] as const);

export type SourceOverflowLimitName = (typeof SOURCE_OVERFLOW_LIMIT_NAMES)[number];

const SOURCE_OVERFLOW_LIMIT_NAME_SET: ReadonlySet<string> = new Set(SOURCE_OVERFLOW_LIMIT_NAMES);

export function isDeclaredSourceOverflowLimitName(name: string): name is SourceOverflowLimitName {
  return SOURCE_OVERFLOW_LIMIT_NAME_SET.has(name) && Boolean(LIMIT_DEFINITION_BY_NAME[name]);
}

export function sourceReadResponseCeiling(options?: ResolveLimitsOptions): ResolvedLimit {
  return limit(SOURCE_READ_RESPONSE_CEILING_LIMIT, options);
}

/** Share of the bound model's input window one step's source reads may fill. */
export function sourceReadInputWindowShare(options?: ResolveLimitsOptions): ResolvedLimit {
  return limit(SOURCE_READ_INPUT_WINDOW_SHARE_LIMIT, options);
}

export function sourceExtractionMaxOriginalBytes(options?: ResolveLimitsOptions): number {
  return limit(SOURCE_EXTRACTION_MAX_ORIGINAL_BYTES_LIMIT, options).value;
}

export function sourceExtractionMaxDerivativeBytes(options?: ResolveLimitsOptions): number {
  return limit(SOURCE_EXTRACTION_MAX_DERIVATIVE_BYTES_LIMIT, options).value;
}

export function sourceExtractionMaxSpans(options?: ResolveLimitsOptions): number {
  return limit(SOURCE_EXTRACTION_MAX_SPANS_LIMIT, options).value;
}

/** Longest span one extracted segment keeps; a longer segment is split, never clipped. */
export function sourceExtractionMaxSpanBytes(options?: ResolveLimitsOptions): number {
  return limit(SOURCE_EXTRACTION_MAX_SPAN_BYTES_LIMIT, options).value;
}

export function sourceExtractionMaxMs(options?: ResolveLimitsOptions): number {
  return limit(SOURCE_EXTRACTION_MAX_MS_LIMIT, options).value;
}

export function pdfMaxPagesLimit(options?: ResolveLimitsOptions): ResolvedLimit {
  return limit(SOURCE_PDF_MAX_PAGES_LIMIT, options);
}

export function pdfMaxPages(options?: ResolveLimitsOptions): number {
  return pdfMaxPagesLimit(options).value;
}
