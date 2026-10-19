// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalJson, deepFreeze } from "../contract-kit/index.js";
import { sha256 } from "../content-ir/canonical.js";
import {
  RST_ORDINARY_PROSE_CAPABILITY,
  RST_REGION_SCHEMA_VERSION,
  RstRegionError,
  type RstAnalysis,
  type RstByteRange,
  type RstPreservationReceipt,
  type RstSelection,
} from "./contracts.js";
import { analyzeRstRegions, assertRstOrdinaryProse, selectRstRegion } from "./regions.js";

function mismatch(path: string, range: RstByteRange, reason: string): never {
  throw new RstRegionError(reason, "rst-preservation-mismatch", path, range);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function firstDifference(left: Uint8Array, right: Uint8Array): number {
  const comparable = Math.min(left.length, right.length);
  for (let index = 0; index < comparable; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return comparable;
}

function decodeCandidate(path: string, bytes: Uint8Array, range: RstByteRange): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RstRegionError(
      "The RST candidate bytes are not valid UTF-8 text.",
      "rst-edit-region-unsupported",
      path,
      range,
    );
  }
}

function validateSelectedBytes(selection: RstSelection, bytes: Uint8Array): void {
  const decoded = decodeCandidate(selection.path, bytes, {
    start: selection.start,
    end: selection.start + bytes.length,
  });
  const eol = selection.newline === "crlf" ? "\r\n" : "\n";
  let prose = decoded;
  if (selection.kind === "insert") {
    if (selection.newline === "none" || !decoded.endsWith(`${eol}${eol}`)) {
      throw new RstRegionError(
        "The insertion must end with two page-style newlines before the next block.",
        "rst-edit-region-unsupported",
        selection.path,
        { start: selection.start, end: selection.start + bytes.length },
      );
    }
    prose = decoded.slice(0, -2 * eol.length);
  }
  if (selection.newline === "crlf") {
    if (
      prose.replaceAll("\r\n", "").includes("\n") ||
      prose.replaceAll("\r\n", "").includes("\r")
    ) {
      throw new RstRegionError(
        "The RST candidate mixes newline styles within the selected prose.",
        "rst-edit-region-unsupported",
        selection.path,
        { start: selection.start, end: selection.start + bytes.length },
      );
    }
    prose = prose.replaceAll("\r\n", "\n");
  }
  assertRstOrdinaryProse(selection.path, prose, selection.newline === "none" ? "none" : "lf");
}

/** Verify an arbitrary captured candidate against the sealed original-byte partition. */
export function verifyRstPreservation(
  original: Uint8Array,
  candidate: Uint8Array,
  selection: RstSelection,
): RstPreservationReceipt {
  const base = Uint8Array.from(original);
  const next = Uint8Array.from(candidate);
  if (
    sha256(base) !== selection.baseSha256 ||
    selection.manifest.baseSha256 !== selection.baseSha256
  ) {
    mismatch(selection.path, { start: 0, end: base.length }, "sealed base bytes changed");
  }
  const analysis = analyzeRstRegions(selection.path, base);
  const expected =
    selection.kind === "replace"
      ? selectRstRegion(analysis, { kind: "replace", start: selection.start, end: selection.end })
      : selectRstRegion(analysis, { kind: "insert", offset: selection.start });
  if (canonicalJson(selection) !== canonicalJson(expected)) {
    mismatch(
      selection.path,
      { start: selection.start, end: selection.end },
      "preservation selection or manifest changed",
    );
  }
  const protectedSuffixLength = base.length - selection.end;
  if (next.length < selection.start + protectedSuffixLength) {
    mismatch(
      selection.path,
      { start: selection.start, end: selection.end },
      "candidate removed protected bytes",
    );
  }
  const candidateEnd = next.length - protectedSuffixLength;
  const selected = next.subarray(selection.start, candidateEnd);
  if (
    selection.kind === "replace" &&
    equalBytes(selected, base.subarray(selection.start, selection.end))
  ) {
    throw new RstRegionError(
      "The proposed replacement would create an empty documentation patch.",
      "rst-edit-region-unsupported",
      selection.path,
      { start: selection.start, end: selection.end },
    );
  }
  if (selection.kind === "insert" && selected.length === 0) {
    throw new RstRegionError(
      "The proposed insertion would create an empty documentation patch.",
      "rst-edit-region-unsupported",
      selection.path,
      { start: selection.start, end: selection.end },
    );
  }
  const delta = selected.length - (selection.end - selection.start);
  for (const range of selection.manifest.ranges) {
    const shifted = range.start >= selection.end ? delta : 0;
    const actual = next.subarray(range.start + shifted, range.end + shifted);
    const expectedBytes = base.subarray(range.start, range.end);
    if (sha256(actual) !== range.sha256 || !equalBytes(actual, expectedBytes)) {
      const first = firstDifference(expectedBytes, actual);
      mismatch(
        selection.path,
        { start: range.start + first, end: Math.min(range.end, range.start + first + 1) },
        `${range.kind} byte changed outside selected span`,
      );
    }
  }
  validateSelectedBytes(selection, selected);
  return deepFreeze({
    schemaVersion: RST_REGION_SCHEMA_VERSION,
    capability: RST_ORDINARY_PROSE_CAPABILITY,
    path: selection.path,
    baseSha256: selection.baseSha256,
    candidateSha256: sha256(next),
    selectedStart: selection.start,
    selectedEnd: selection.end,
    candidateEnd,
    unchangedRanges: selection.manifest.ranges.length,
    manifestSha256: selection.manifest.manifestSha256,
  });
}

/** Construct a candidate from one admitted plain paragraph. */
export function applyRstProseEdit(
  original: Uint8Array,
  selection: RstSelection,
  prose: string,
): { bytes: Uint8Array; receipt: RstPreservationReceipt } {
  const normalized = prose.replaceAll("\r\n", "\n");
  assertRstOrdinaryProse(selection.path, normalized, selection.newline === "none" ? "none" : "lf");
  const eol = selection.newline === "crlf" ? "\r\n" : "\n";
  const rendered =
    normalized.replaceAll("\n", eol) + (selection.kind === "insert" ? `${eol}${eol}` : "");
  const replacement = new TextEncoder().encode(rendered);
  const bytes = new Uint8Array(
    original.length - (selection.end - selection.start) + replacement.length,
  );
  bytes.set(original.subarray(0, selection.start));
  bytes.set(replacement, selection.start);
  bytes.set(original.subarray(selection.end), selection.start + replacement.length);
  const receipt = verifyRstPreservation(original, bytes, selection);
  return { bytes, receipt };
}

/** Locate a whole eligible source span from a captured candidate and verify it. */
export function selectRstCandidate(
  analysis: RstAnalysis,
  original: Uint8Array,
  candidate: Uint8Array,
): { selection: RstSelection; receipt: RstPreservationReceipt } {
  if (sha256(original) !== analysis.baseSha256) {
    mismatch(analysis.path, { start: 0, end: original.length }, "analysis base bytes changed");
  }
  const difference = firstDifference(original, candidate);
  if (difference === original.length && difference === candidate.length) {
    throw new RstRegionError(
      "The RST candidate contains no change to the selected page.",
      "rst-edit-region-unsupported",
      analysis.path,
      { start: difference, end: difference },
    );
  }
  const selectors = [
    ...analysis.paragraphs
      .filter((paragraph) => paragraph.start <= difference && difference <= paragraph.end)
      .map((paragraph) => ({
        kind: "replace" as const,
        start: paragraph.start,
        end: paragraph.end,
      })),
    ...analysis.insertionSlots
      // A captured insertion can share bytes with the following block, so its
      // slot may precede the first difference. It must still grow the page.
      .filter((slot) => slot.offset <= difference && candidate.length > original.length)
      .map((slot) => ({ kind: "insert" as const, offset: slot.offset })),
  ];
  let firstFailure: RstRegionError | undefined;
  for (const selector of selectors) {
    const selection = selectRstRegion(analysis, selector);
    try {
      return { selection, receipt: verifyRstPreservation(original, candidate, selection) };
    } catch (error) {
      if (!(error instanceof RstRegionError)) throw error;
      firstFailure ??= error;
    }
  }
  if (firstFailure) throw firstFailure;
  throw new RstRegionError(
    "The candidate change is outside an eligible ordinary-prose span.",
    "rst-edit-region-unsupported",
    analysis.path,
    { start: difference, end: difference + 1 },
  );
}
