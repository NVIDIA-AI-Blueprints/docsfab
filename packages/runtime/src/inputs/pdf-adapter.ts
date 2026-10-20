// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ExternalInputContractError, type ExternalInputHostCapability } from "./contracts.js";
import {
  getExternalInputAccessBinding,
  getExternalInputLifecycleState,
  type ExternalInputAccessObservationV1,
} from "./access.js";
import {
  citeExternalInput,
  type ExternalInputCitationDiagnosticV1,
  type ExternalInputCitationRole,
  type ExternalInputCitationV1,
} from "./citation.js";
import { projectExternalInputDisclosure } from "./disclosure.js";
import { createInputsDialect, deepFreeze } from "./dialect.js";
import {
  accessLocalUpload,
  digestLocalUploadBytes,
  isLocalUploadDisposition,
  openLocalUploadSurface,
  readLocalUploadBytes,
  type LocalUploadDispositionV1,
} from "./upload-adapter.js";

function fail(code: ExternalInputContractError["code"]): never {
  throw new ExternalInputContractError(code);
}

const {
  canonicalDigest,
  assertInert,
  rejectCredentials,
  object,
  noUnknown,
  identifier,
  hash,
  nullableHash,
  enumeration,
} = createInputsDialect(fail);

export const PDF_ADAPTER_PARSER_ID = "docsfab-pdf-evidence-v1";
export const PDF_ADAPTER_PARSER_VERSION = "1.0.0";

export interface PdfPageRegionIdentityV1 {
  page: number;
  regionIndex: number;
  regionId: string;
  regionIdentitySha256: string;
  startOffset: number;
  endOffset: number;
}

export interface PdfEvidenceSpanV1 {
  schemaVersion: 1;
  kind: "docsfab-pdf-evidence-span";
  inputId: string;
  contentDigestSha256: string;
  page: number;
  regionId: string;
  regionIdentitySha256: string;
  evidenceSpanDigestSha256: string;
  /** Character offsets into the disposable extract; not a host path. */
  startOffset: number;
  endOffset: number;
  spanSha256: string;
}

export interface PdfExtractionRecordV1 {
  schemaVersion: 1;
  kind: "docsfab-pdf-extraction-record";
  inputId: string;
  contentDigestSha256: string;
  parserId: string;
  parserVersion: string;
  pageCount: number;
  regions: Array<{
    page: number;
    regionId: string;
    regionIdentitySha256: string;
    evidenceSpanDigestSha256: string;
  }>;
  limitations: string[];
  recordSha256: string;
}

export interface PdfEvidenceCitationV1 {
  schemaVersion: 1;
  kind: "docsfab-pdf-evidence-citation";
  inputId: string;
  contentDigestSha256: string;
  page: number;
  regionIdentitySha256: string;
  evidenceSpanDigestSha256: string;
  citationSha256: string;
  accessObservationSha256: string | null;
  bindingSha256: string;
}

interface PdfExtractionState {
  records: Map<string, PdfExtractionRecordV1>;
  spans: Map<string, PdfEvidenceSpanV1[]>;
  /** Disposable extract text keyed by inputId — never written to durable ledgers. */
  extracts: Map<string, string>;
}

const pdfStates = new WeakMap<object, PdfExtractionState>();

/** Extracts page/region identities and span digests from a registered PDF text extract. */
export function extractPdfEvidence(
  capability: ExternalInputHostCapability,
  inputId: string,
): PdfExtractionRecordV1 | LocalUploadDispositionV1 {
  ensurePdf(capability);
  const state = pdfStates.get(capability as object)!;
  const id = identifier(inputId);
  const lifecycle = getExternalInputLifecycleState(capability, id);
  if (lifecycle === "revoked") {
    return sealUploadDisposition("revoked", "pdf-revoked", id);
  }
  if (lifecycle === "changed") {
    return sealUploadDisposition("changed", "pdf-changed", id);
  }

  const read = readLocalUploadBytes(capability, id);
  if (isLocalUploadDisposition(read)) return read;

  const text = new TextDecoder("utf-8", { fatal: false }).decode(read.bytes);
  if (text.includes("\0")) {
    return sealUploadDisposition("malformed", "pdf-extract-nul", id, {
      contentDigestSha256: read.contentDigestSha256,
      mediaKind: read.mediaKind,
      limitations: ["extract-must-be-text"],
    });
  }

  const regions = parseSyntheticExtractRegions(text);
  if (regions.length === 0) {
    return sealUploadDisposition("malformed", "pdf-no-regions", id, {
      contentDigestSha256: read.contentDigestSha256,
      mediaKind: read.mediaKind,
      limitations: ["no-page-region-identities"],
    });
  }

  const spans: PdfEvidenceSpanV1[] = regions.map((region) => {
    const excerpt = text.slice(region.startOffset, region.endOffset);
    const evidenceSpanDigestSha256 = canonicalDigest({
      kind: "docsfab-pdf-evidence-span-body",
      inputId: id,
      contentDigestSha256: read.contentDigestSha256,
      page: region.page,
      regionId: region.regionId,
      excerpt: excerpt.normalize("NFC"),
    });
    return sealSpan({
      inputId: id,
      contentDigestSha256: read.contentDigestSha256,
      page: region.page,
      regionId: region.regionId,
      regionIdentitySha256: region.regionIdentitySha256,
      evidenceSpanDigestSha256,
      startOffset: region.startOffset,
      endOffset: region.endOffset,
    });
  });

  const pageCount = Math.max(...regions.map((region) => region.page));
  const record = sealRecord({
    inputId: id,
    contentDigestSha256: read.contentDigestSha256,
    parserId: PDF_ADAPTER_PARSER_ID,
    parserVersion: PDF_ADAPTER_PARSER_VERSION,
    pageCount,
    regions: spans.map((span) => ({
      page: span.page,
      regionId: span.regionId,
      regionIdentitySha256: span.regionIdentitySha256,
      evidenceSpanDigestSha256: span.evidenceSpanDigestSha256,
    })),
    limitations: [
      "synthetic-extract-parser",
      "no-ocr",
      "no-remote-fetch",
      "content-minimized-durable-records",
    ],
  });

  state.records.set(id, record);
  state.spans.set(id, spans);
  state.extracts.set(id, text.normalize("NFC"));
  return record;
}

export function listPdfEvidenceSpans(
  capability: ExternalInputHostCapability,
  inputId: string,
): PdfEvidenceSpanV1[] {
  ensurePdf(capability);
  const state = pdfStates.get(capability as object)!;
  const spans = state.spans.get(identifier(inputId));
  return spans ? [...spans] : [];
}

export function getPdfExtractionRecord(
  capability: ExternalInputHostCapability,
  inputId: string,
): PdfExtractionRecordV1 | null {
  ensurePdf(capability);
  return pdfStates.get(capability as object)!.records.get(identifier(inputId)) ?? null;
}

/**
 * Binds input ID, content digest, page/region identity, and evidence-span digest
 * onto an external-input citation without rewriting sealed citation shapes.
 */
export function citePdfEvidenceSpan(
  capability: ExternalInputHostCapability,
  input: {
    inputId: string;
    stepId: string;
    role: ExternalInputCitationRole;
    supportedClaimSha256: string;
    page: number;
    regionIdentitySha256: string;
    evidenceSpanDigestSha256: string;
    accessObservationSha256?: string | null;
  },
): PdfEvidenceCitationV1 | ExternalInputCitationDiagnosticV1 | LocalUploadDispositionV1 {
  ensurePdf(capability);
  assertInert(input);
  requireShape(object(input), [
    "inputId",
    "stepId",
    "role",
    "supportedClaimSha256",
    "page",
    "regionIdentitySha256",
    "evidenceSpanDigestSha256",
    "accessObservationSha256",
  ]);
  rejectCredentials(input);

  const inputId = identifier(input.inputId);
  const lifecycle = getExternalInputLifecycleState(capability, inputId);
  if (lifecycle === "revoked") return sealUploadDisposition("revoked", "pdf-revoked", inputId);
  if (lifecycle === "changed") return sealUploadDisposition("changed", "pdf-changed", inputId);

  const state = pdfStates.get(capability as object)!;
  if (!state.spans.has(inputId)) {
    const extracted = extractPdfEvidence(capability, inputId);
    if (isLocalUploadDisposition(extracted)) return extracted;
  }
  const available = state.spans.get(inputId) ?? [];
  const regionIdentitySha256 = hash(input.regionIdentitySha256);
  const evidenceSpanDigestSha256 = hash(input.evidenceSpanDigestSha256);
  const page = nonnegativePage(input.page);
  const matched = available.find(
    (span) =>
      span.page === page &&
      span.regionIdentitySha256 === regionIdentitySha256 &&
      span.evidenceSpanDigestSha256 === evidenceSpanDigestSha256,
  );
  if (!matched) fail("digest-mismatch");

  const liveExtract = state.extracts.get(inputId);
  if (liveExtract !== undefined) {
    const liveDigest = digestLocalUploadBytes(liveExtract);
    if (liveDigest !== matched.contentDigestSha256) {
      return sealUploadDisposition("changed", "pdf-extract-digest-drift", inputId, {
        contentDigestSha256: liveDigest,
      });
    }
  }

  let accessObservationSha256 =
    input.accessObservationSha256 === undefined
      ? null
      : nullableHash(input.accessObservationSha256);
  if (accessObservationSha256 === null) {
    const accessed = accessLocalUpload(capability, {
      inputId,
      stepId: identifier(input.stepId),
      accessorId: "docsfab-pdf-evidence-adapter",
    });
    if (isLocalUploadDisposition(accessed)) return accessed;
    accessObservationSha256 = (accessed as ExternalInputAccessObservationV1).observationSha256;
  }

  const cited = citeExternalInput(capability, {
    inputId,
    stepId: identifier(input.stepId),
    role: enumeration(input.role, [
      "requirement",
      "evidence",
      "background",
      "validation",
      "contradictory",
    ] as const),
    supportedClaimSha256: hash(input.supportedClaimSha256),
    accessObservationSha256,
  });
  if ((cited as ExternalInputCitationV1).kind !== "docsfab-external-input-citation") {
    return cited as ExternalInputCitationDiagnosticV1;
  }
  const citation = cited as ExternalInputCitationV1;

  return sealPdfCitation({
    inputId,
    contentDigestSha256: matched.contentDigestSha256,
    page: matched.page,
    regionIdentitySha256: matched.regionIdentitySha256,
    evidenceSpanDigestSha256: matched.evidenceSpanDigestSha256,
    citationSha256: citation.citationSha256,
    accessObservationSha256,
  });
}

/**
 * Projects a bounded excerpt of an extracted span under disclosure policy; never
 * upgrades policy, and durable surfaces stay content-minimized.
 */
export function projectPdfEvidenceExcerpt(
  capability: ExternalInputHostCapability,
  input: {
    inputId: string;
    evidenceSpanDigestSha256: string;
    surface?: "prompt" | "log" | "run-record" | "terminal";
  },
): ReturnType<typeof projectExternalInputDisclosure> | LocalUploadDispositionV1 {
  ensurePdf(capability);
  const inputId = identifier(input.inputId);
  const lifecycle = getExternalInputLifecycleState(capability, inputId);
  if (lifecycle === "revoked") {
    return sealUploadDisposition("revoked", "pdf-revoked", inputId);
  }
  const state = pdfStates.get(capability as object)!;
  const spans = state.spans.get(inputId) ?? [];
  const span = spans.find(
    (entry) => entry.evidenceSpanDigestSha256 === hash(input.evidenceSpanDigestSha256),
  );
  if (!span) fail("invalid-value");
  const extract = state.extracts.get(inputId);
  if (!extract) {
    return sealUploadDisposition("inaccessible", "pdf-extract-absent", inputId);
  }
  const excerptCandidate = extract.slice(span.startOffset, span.endOffset);
  return projectExternalInputDisclosure(capability, {
    inputId,
    surface: input.surface ?? "prompt",
    requestedLevel: "bounded-excerpt",
    excerptCandidate,
  });
}

/** Parses synthetic extract text into page/region identities. */
export function parseSyntheticExtractRegions(text: string): PdfPageRegionIdentityV1[] {
  const normalized = text.normalize("NFC");
  if (normalized.length === 0 || normalized.includes("\0")) return [];

  const pageBlocks = splitSyntheticPages(normalized);
  const regions: PdfPageRegionIdentityV1[] = [];
  for (const block of pageBlocks) {
    const lines = block.text.split("\n");
    let offset = block.startOffset;
    let regionIndex = 0;
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
      const line = lines[lineIdx]!;
      const lineStart = offset;
      const lineEnd = offset + line.length;
      if (lineIdx < lines.length - 1) offset = lineEnd + 1;
      else offset = lineEnd;

      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const isHeader = /^SYNTHETIC (?:PDF )?EXTRACT\b|^SYNTHETIC WEAK SOURCE\b/u.test(trimmed);
      const pageHasBody = lines.some((candidate) => {
        const value = candidate.trim();
        return (
          value.length > 0 && !/^SYNTHETIC (?:PDF )?EXTRACT\b|^SYNTHETIC WEAK SOURCE\b/u.test(value)
        );
      });
      if (isHeader && pageHasBody) continue;

      const regionId = `p${block.page}.r${regionIndex}`;
      const regionIdentitySha256 = canonicalDigest({
        kind: "docsfab-pdf-page-region-identity",
        page: block.page,
        regionId,
        startOffset: lineStart,
        endOffset: lineEnd,
      });
      regions.push({
        page: block.page,
        regionIndex,
        regionId,
        regionIdentitySha256,
        startOffset: lineStart,
        endOffset: lineEnd,
      });
      regionIndex += 1;
    }
  }
  return regions;
}

function splitSyntheticPages(
  text: string,
): Array<{ page: number; startOffset: number; text: string }> {
  const pageMarker = /(?:^|\n)(?=SYNTHETIC EXTRACT —[^\n]*\bpage\s+(\d+)\b)/giu;
  const matches = [...text.matchAll(pageMarker)];
  if (matches.length === 0) {
    const headerPage = text.match(/\bpage\s+(\d+)\b/iu);
    return [
      {
        page: headerPage ? Number(headerPage[1]) : 1,
        startOffset: 0,
        text,
      },
    ];
  }

  const blocks: Array<{ page: number; startOffset: number; text: string }> = [];
  const firstIdx = matches[0]!.index ?? 0;
  const firstStart = text[firstIdx] === "\n" ? firstIdx + 1 : firstIdx;
  if (firstStart > 0) {
    const prefix = text.slice(0, firstStart).replace(/\n$/u, "");
    if (prefix.length > 0) {
      blocks.push({ page: 1, startOffset: 0, text: prefix });
    }
  }
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const rawIdx = match.index ?? 0;
    const start = text[rawIdx] === "\n" ? rawIdx + 1 : rawIdx;
    const endRaw = matches[index + 1]?.index ?? text.length;
    const page = Number(match[1]);
    blocks.push({
      page: Number.isInteger(page) && page > 0 ? page : index + 1,
      startOffset: start,
      text: text.slice(start, endRaw).replace(/^\n/u, ""),
    });
  }
  return blocks.filter((block) => block.text.length > 0);
}

function ensurePdf(capability: ExternalInputHostCapability): void {
  getExternalInputAccessBinding(capability);
  openLocalUploadSurface(capability);
  if (!pdfStates.has(capability as object)) {
    pdfStates.set(capability as object, {
      records: new Map(),
      spans: new Map(),
      extracts: new Map(),
    });
  }
}

function sealUploadDisposition(
  disposition: LocalUploadDispositionV1["disposition"],
  reasonCode: string,
  inputId: string | null,
  extra: {
    contentDigestSha256?: string | null;
    mediaKind?: LocalUploadDispositionV1["mediaKind"];
    limitations?: string[];
  } = {},
): LocalUploadDispositionV1 {
  const envelope = {
    schemaVersion: 1 as const,
    kind: "docsfab-local-upload-disposition" as const,
    disposition,
    reasonCode,
    inputId,
    contentDigestSha256: extra.contentDigestSha256 ?? null,
    mediaKind: extra.mediaKind ?? null,
    parserId: PDF_ADAPTER_PARSER_ID,
    parserVersion: PDF_ADAPTER_PARSER_VERSION,
    limitations: extra.limitations ?? [],
  };
  return deepFreeze({
    ...envelope,
    dispositionSha256: canonicalDigest(envelope),
  });
}

function sealSpan(
  body: Omit<PdfEvidenceSpanV1, "schemaVersion" | "kind" | "spanSha256">,
): PdfEvidenceSpanV1 {
  const envelope = {
    schemaVersion: 1 as const,
    kind: "docsfab-pdf-evidence-span" as const,
    ...body,
  };
  return deepFreeze({ ...envelope, spanSha256: canonicalDigest(envelope) });
}

function sealRecord(
  body: Omit<PdfExtractionRecordV1, "schemaVersion" | "kind" | "recordSha256">,
): PdfExtractionRecordV1 {
  const envelope = {
    schemaVersion: 1 as const,
    kind: "docsfab-pdf-extraction-record" as const,
    ...body,
  };
  return deepFreeze({ ...envelope, recordSha256: canonicalDigest(envelope) });
}

function sealPdfCitation(
  body: Omit<PdfEvidenceCitationV1, "schemaVersion" | "kind" | "bindingSha256">,
): PdfEvidenceCitationV1 {
  const envelope = {
    schemaVersion: 1 as const,
    kind: "docsfab-pdf-evidence-citation" as const,
    ...body,
  };
  return deepFreeze({ ...envelope, bindingSha256: canonicalDigest(envelope) });
}

function nonnegativePage(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100_000) {
    fail("invalid-value");
  }
  return value;
}

function requireShape(root: Record<string, unknown>, keys: string[]): void {
  noUnknown(root, keys);
  for (const key of [
    "inputId",
    "stepId",
    "role",
    "supportedClaimSha256",
    "page",
    "regionIdentitySha256",
    "evidenceSpanDigestSha256",
  ]) {
    if (!(key in root)) fail("invalid-shape");
  }
}
