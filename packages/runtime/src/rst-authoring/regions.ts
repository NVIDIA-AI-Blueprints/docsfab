// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit, deepFreeze } from "../contract-kit/index.js";
import { sha256 } from "../content-ir/canonical.js";
import {
  RST_ORDINARY_PROSE_CAPABILITY,
  RstRegionError,
  type RstAnalysis,
  type RstByteRange,
  type RstInsertionSlot,
  type RstNewline,
  type RstOpaqueRegion,
  type RstParagraph,
  type RstProtectedRange,
  type RstSelection,
} from "./contracts.js";

type Line = RstByteRange & {
  contentEnd: number;
  text: string;
  line: number;
  blank: boolean;
};

// RST uses every printable ASCII punctuation character for section adornments
// and for the prefix of a quoted literal block. A leading punctuation mark is
// therefore not provably ordinary prose in this deliberately bounded writer.
const RST_PUNCTUATION_LINE = /^[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]+[ \t]*$/u;
const RST_PUNCTUATION_PREFIX = /^[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/u;
const RST_OPTION_PREFIX = /^(?:--?[A-Za-z0-9]|\+[A-Za-z0-9]|\/[A-Za-z0-9])/u;

const originalByAnalysis = new WeakMap<RstAnalysis, Uint8Array>();
const kit = createContractKit({
  fail: (code: "rst-edit-region-unsupported") => {
    throw new Error(code);
  },
  codes: {
    invalidShape: "rst-edit-region-unsupported",
    invalidValue: "rst-edit-region-unsupported",
    digestMismatch: "rst-edit-region-unsupported",
    credentialMaterial: "rst-edit-region-unsupported",
    schemaMismatch: "rst-edit-region-unsupported",
  },
});

function unsupported(path: string, range: RstByteRange, reason: string): never {
  throw new RstRegionError(reason, "rst-edit-region-unsupported", path, range);
}

function splitLines(
  path: string,
  original: Uint8Array,
): { lines: Line[]; newline: RstNewline; finalNewline: boolean } {
  if (original[0] === 0xef && original[1] === 0xbb && original[2] === 0xbf) {
    unsupported(path, { start: 0, end: 3 }, "UTF-8 BOM requires a separate byte-offset policy");
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(original);
  } catch {
    return unsupported(path, { start: 0, end: original.length }, "source is not valid UTF-8");
  }
  if (decoded.includes("\0"))
    unsupported(path, { start: 0, end: original.length }, "NUL byte is not RST prose");
  // Docutils turns form feed and vertical tab into whitespace before parsing;
  // source control bytes have no ordinary-prose policy in this bounded writer.
  if (/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/u.test(decoded))
    unsupported(
      path,
      { start: 0, end: original.length },
      "control bytes require a separate RST interpretation policy",
    );
  const crlf = decoded.includes("\r\n");
  const lf = decoded.includes("\n");
  if (
    decoded.replaceAll("\r\n", "").includes("\r") ||
    (crlf && decoded.replaceAll("\r\n", "").includes("\n"))
  ) {
    unsupported(path, { start: 0, end: original.length }, "mixed or ambiguous newline semantics");
  }
  const newline: RstNewline = crlf ? "crlf" : lf ? "lf" : "none";
  const delimiter = crlf ? "\r\n" : "\n";
  const textLines = lf ? decoded.split(delimiter) : [decoded];
  const finalNewline = lf && decoded.endsWith(delimiter);
  const lines: Line[] = [];
  let offset = 0;
  for (let index = 0; index < textLines.length; index += 1) {
    if (finalNewline && index === textLines.length - 1) break;
    const text = textLines[index]!;
    const contentEnd = offset + Buffer.byteLength(text, "utf8");
    const end = contentEnd + (index < textLines.length - 1 ? Buffer.byteLength(delimiter) : 0);
    lines.push({
      start: offset,
      contentEnd,
      end,
      text,
      line: index + 1,
      blank: text.trim() === "",
    });
    offset = end;
  }
  return { lines, newline, finalNewline };
}

/** Conservative syntax screen. An unknown line is opaque, never editable. */
function unsafeReason(text: string): string | null {
  if (/^[ \t]/u.test(text)) return "indented or nested block";
  if (/\t/u.test(text)) return "tab or ambiguous indentation";
  if (/^\.\.(?:\s|$)/u.test(text)) return "explicit markup or directive";
  if (/^:[^\s:][^:]*:/u.test(text)) return "field list";
  if (RST_OPTION_PREFIX.test(text)) return "option list";
  if (/^(?:[-+*•‣⁃]|(?:\d+|[A-Za-z]|[IVXLCDMivxlcdm]+|#)[.)]|\([A-Za-z0-9]+\))\s/u.test(text))
    return "list item";
  if (/^(?:>>>|\.\.\.)\s/u.test(text)) return "doctest block";
  if (RST_PUNCTUATION_LINE.test(text)) return "heading or table adornment";
  if (/^[+|]/u.test(text)) return "table border or cell";
  if (/::[ \t]*$/u.test(text)) return "literal block introducer";
  if (RST_PUNCTUATION_PREFIX.test(text)) return "quoted literal or other punctuation markup";
  if (/[`|*]/u.test(text)) return "inline role, substitution, or emphasis";
  if (/\[[^\]]+\]_/u.test(text) || /\b[^\s]+__?\b/u.test(text))
    return "reference or footnote syntax";
  if (/\\/u.test(text)) return "escaped RST markup";
  return null;
}

/** Test candidate content independently of a page's surrounding separators. */
export function assertRstOrdinaryProse(path: string, prose: string, newline: RstNewline): void {
  if (prose.length === 0 || prose.trim() === "" || prose.startsWith("\n") || prose.endsWith("\n")) {
    unsupported(
      path,
      { start: 0, end: Buffer.byteLength(prose) },
      "candidate must be one nonempty paragraph",
    );
  }
  if (
    prose.includes("\r") ||
    /[\u0000-\u0008\u000b-\u001f\ufeff]/u.test(prose) ||
    (newline === "none" && prose.includes("\n"))
  ) {
    unsupported(
      path,
      { start: 0, end: Buffer.byteLength(prose) },
      "candidate has incompatible newline semantics",
    );
  }
  const rows = prose.split("\n");
  for (const row of rows) {
    const reason = row.trim() === "" ? "blank line splits the paragraph" : unsafeReason(row);
    if (reason) unsupported(path, { start: 0, end: Buffer.byteLength(prose) }, reason);
  }
}

/** Analyze only byte-provable top-level ordinary prose; all other blocks remain opaque. */
export function analyzeRstRegions(path: string, original: Uint8Array): RstAnalysis {
  const source = Uint8Array.from(original);
  const { lines, newline, finalNewline } = splitLines(path, source);
  const paragraphs: RstParagraph[] = [];
  const insertionSlots: RstInsertionSlot[] = [];
  const opaque: RstOpaqueRegion[] = [];
  const lineKinds: RstProtectedRange["kind"][] = lines.map(() => "separator");
  let index = 0;
  let previousBlockWasOrdinary = false;
  while (index < lines.length) {
    if (lines[index]!.blank) {
      index += 1;
      continue;
    }
    const first = index;
    while (index < lines.length && !lines[index]!.blank) index += 1;
    const block = lines.slice(first, index);
    const firstUnsafe = block
      .map((line) => unsafeReason(line.text))
      .find((reason) => reason !== null);
    const kind = firstUnsafe ? "opaque" : "ordinary";
    for (let cursor = first; cursor < index; cursor += 1) lineKinds[cursor] = kind;
    const start = block[0]!.start;
    const end = block[block.length - 1]!.contentEnd;
    if (firstUnsafe) opaque.push({ start, end, reason: firstUnsafe });
    else
      paragraphs.push({
        start,
        end,
        lineStart: block[0]!.line,
        lineEnd: block[block.length - 1]!.line,
      });
    if (previousBlockWasOrdinary && !/^[ \t]/u.test(block[0]!.text) && lines[first - 1]!.blank)
      insertionSlots.push({ offset: start, line: block[0]!.line });
    previousBlockWasOrdinary = !firstUnsafe;
  }
  const protectedLines = lines.map((line, lineIndex) => ({
    start: line.start,
    end: line.end,
    kind: lineKinds[lineIndex]!,
    sha256: sha256(source.subarray(line.start, line.end)),
  }));
  const analysis: RstAnalysis = deepFreeze({
    path,
    baseSha256: sha256(source),
    newline,
    finalNewline,
    byteLength: source.length,
    paragraphs,
    insertionSlots,
    opaque,
    protectedLines,
  });
  originalByAnalysis.set(analysis, source);
  return analysis;
}

export type RstRegionSelector =
  | Readonly<{ kind: "replace"; start: number; end: number }>
  | Readonly<{ kind: "insert"; offset: number }>;

export function selectRstRegion(analysis: RstAnalysis, selector: RstRegionSelector): RstSelection {
  const source = originalByAnalysis.get(analysis);
  if (!source)
    unsupported(analysis.path, { start: 0, end: 0 }, "analysis lacks bound original bytes");
  const start = selector.kind === "replace" ? selector.start : selector.offset;
  const end = selector.kind === "replace" ? selector.end : selector.offset;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end > source.length ||
    end < start
  ) {
    unsupported(analysis.path, { start, end }, "selection is outside the source byte range");
  }
  if (selector.kind === "replace") {
    if (
      !analysis.paragraphs.some((paragraph) => paragraph.start === start && paragraph.end === end)
    ) {
      unsupported(
        analysis.path,
        { start, end },
        "replacement must cover one whole top-level ordinary paragraph",
      );
    }
  } else if (!analysis.insertionSlots.some((slot) => slot.offset === start)) {
    unsupported(analysis.path, { start, end }, "insertion must precede a complete top-level block");
  }
  const ranges: RstProtectedRange[] = [];
  for (const line of analysis.protectedLines) {
    const portions =
      line.end <= start || line.start >= end
        ? [{ start: line.start, end: line.end }]
        : [
            { start: line.start, end: start },
            { start: end, end: line.end },
          ];
    for (const range of portions) {
      if (range.end > range.start)
        ranges.push({
          ...range,
          kind: line.kind,
          sha256: sha256(source.subarray(range.start, range.end)),
        });
    }
  }
  const manifest = kit.seal("rst-preservation-manifest", "manifestSha256", {
    capability: RST_ORDINARY_PROSE_CAPABILITY,
    path: analysis.path,
    baseSha256: analysis.baseSha256,
    selectedStart: start,
    selectedEnd: end,
    ranges,
  });
  return deepFreeze({
    path: analysis.path,
    kind: selector.kind,
    start,
    end,
    baseSha256: analysis.baseSha256,
    newline: analysis.newline,
    manifest,
  });
}
