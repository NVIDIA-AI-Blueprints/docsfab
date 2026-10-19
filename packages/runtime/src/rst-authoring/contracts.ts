// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const RST_ORDINARY_PROSE_CAPABILITY = "update-existing-rst-ordinary-prose" as const;
export const RST_REGION_SCHEMA_VERSION = 1 as const;

export type RstRegionErrorCode = "rst-edit-region-unsupported" | "rst-preservation-mismatch";
export type RstNewline = "lf" | "crlf" | "none";
export type RstByteRange = Readonly<{ start: number; end: number }>;
export type RstParagraph = RstByteRange & Readonly<{ lineStart: number; lineEnd: number }>;
export type RstInsertionSlot = Readonly<{ offset: number; line: number }>;
export type RstOpaqueRegion = RstByteRange & Readonly<{ reason: string }>;
export type RstProtectedRange = RstByteRange &
  Readonly<{ kind: "ordinary" | "opaque" | "separator"; sha256: string }>;

export type RstPreservationManifest = Readonly<{
  schemaVersion: typeof RST_REGION_SCHEMA_VERSION;
  kind: "rst-preservation-manifest";
  capability: typeof RST_ORDINARY_PROSE_CAPABILITY;
  path: string;
  baseSha256: string;
  selectedStart: number;
  selectedEnd: number;
  ranges: readonly RstProtectedRange[];
  manifestSha256: string;
}>;

export type RstAnalysis = Readonly<{
  path: string;
  baseSha256: string;
  newline: RstNewline;
  finalNewline: boolean;
  byteLength: number;
  paragraphs: readonly RstParagraph[];
  insertionSlots: readonly RstInsertionSlot[];
  opaque: readonly RstOpaqueRegion[];
  /** Ordered original-line ranges used to build the preservation manifest. */
  protectedLines: readonly (RstByteRange &
    Readonly<{ kind: RstProtectedRange["kind"]; sha256: string }>)[];
}>;

export type RstSelection = Readonly<{
  path: string;
  kind: "replace" | "insert";
  start: number;
  end: number;
  baseSha256: string;
  newline: RstNewline;
  manifest: RstPreservationManifest;
}>;

export type RstPreservationReceipt = Readonly<{
  schemaVersion: typeof RST_REGION_SCHEMA_VERSION;
  capability: typeof RST_ORDINARY_PROSE_CAPABILITY;
  path: string;
  baseSha256: string;
  candidateSha256: string;
  selectedStart: number;
  selectedEnd: number;
  candidateEnd: number;
  unchangedRanges: number;
  manifestSha256: string;
}>;

export class RstRegionError extends Error {
  readonly code: RstRegionErrorCode;
  readonly path: string;
  readonly range: RstByteRange;
  readonly reason: string;

  constructor(reason: string, code: RstRegionErrorCode, path: string, range: RstByteRange) {
    super(`${code}: ${path}:${range.start}-${range.end}: ${reason}`);
    this.name = "RstRegionError";
    this.code = code;
    this.path = path;
    this.range = range;
    this.reason = reason;
  }
}
