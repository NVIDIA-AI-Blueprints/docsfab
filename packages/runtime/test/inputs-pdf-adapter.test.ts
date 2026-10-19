// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { PDF_TEST_INPUTS } from "./helpers/pdf-adapter-inputs.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi, afterEach } from "vitest";

import { canonicalDigest } from "../src/content-ir/canonical.js";
import { formatLimitObservation, limit } from "../src/config/limits.js";
import {
  ExternalInputContractError,
  accessLocalUpload,
  citePdfEvidenceSpan,
  createExternalInputAccessLedger,
  createExternalInputCitationLedger,
  createSourceStepPolicy,
  createSourceObservation,
  decodeSourceObservation,
  digestLocalUploadBytes,
  extractPdfEvidence,
  extractSourceRepresentation,
  formatOriginalBudgetExceeded,
  formatPdfEvidenceLimitations,
  formatSourceRepresentationLimitations,
  getPdfExtractionRecord,
  getRegisteredExternalInput,
  htmlSourceExtractorAdapter,
  isLocalUploadDisposition,
  listPdfEvidenceSpans,
  openExternalInputAccessCapture,
  openExternalInputCitationCapture,
  parseSyntheticExtractRegions,
  pdfSourceExtractorAdapter,
  projectPdfEvidenceExcerpt,
  registerLocalUpload,
  revokeLocalUpload,
  SOURCE_READ_RESPONSE_CEILING_BYTES,
  SourceExtractionError,
  type LocalUploadDispositionV1,
  type PdfEvidenceCitationV1,
  type PdfExtractionRecordV1,
} from "../src/inputs/index.js";
import { extractPdfTextEvidence } from "../src/inputs/adapters/pdf.js";
import { textSourceExtractorAdapter } from "../src/inputs/adapters/structured.js";
import { DEFAULT_SOURCE_EXTRACTION_LIMITS } from "../src/inputs/source-extraction.js";
import { SourceEvidenceContractError } from "../src/inputs/source-evidence.js";
import { formatRunSummary } from "../src/operator/run-summary.js";
import type { RunRecord } from "../src/records/contracts.js";
import { captureProductionLimitOverflow } from "./helpers/limit-overflow-cli.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHARTER_PDF = PDF_TEST_INPUTS.text;
const CHARTER_P2 = PDF_TEST_INPUTS.pageTwoText;
const SHA = (character: string) => character.repeat(64);

function openCapture() {
  const capability = openExternalInputAccessCapture({
    runIdSha256: SHA("a"),
    repository: {
      identitySha256: SHA("b"),
      revision: "c".repeat(40),
    },
  });
  openExternalInputCitationCapture(capability);
  return capability;
}

describe("inputs PDF / local-upload adapter", () => {
  it("registers golden charter PDF extract and yields citable page/region spans", () => {
    const capability = openCapture();
    const registered = registerLocalUpload(capability, {
      inputId: PDF_TEST_INPUTS.mainId,
      safeTitle: PDF_TEST_INPUTS.mainTitle,
      logicalName: PDF_TEST_INPUTS.mainLogicalName,
      mediaKind: "pdf",
      bytes: CHARTER_PDF,
      visibility: "internal",
      disclosurePolicy: "cite-and-quote",
      intendedRoles: ["evidence", "requirement"],
    });
    expect(registered.disposition).toBe("registered");
    expect(registered.parserId).toBe("docsfab-local-upload-v1");
    expect(registered.parserVersion).toBe("1.0.0");
    expect(registered.contentDigestSha256).toBe(digestLocalUploadBytes(CHARTER_PDF));
    expect(registered.limitations).toContain("synthetic-pdf-text-extract");

    const registration = getRegisteredExternalInput(capability, PDF_TEST_INPUTS.mainId);
    expect(registration.sourceKind).toBe("upload");
    expect(registration.contentDigestSha256).toMatch(/^[a-f0-9]{64}$/u);

    const extracted = extractPdfEvidence(capability, PDF_TEST_INPUTS.mainId);
    expect(isLocalUploadDisposition(extracted)).toBe(false);
    const record = extracted as PdfExtractionRecordV1;
    expect(record.kind).toBe("docsfab-pdf-extraction-record");
    expect(record.parserId).toBe("docsfab-pdf-evidence-v1");
    expect(record.pageCount).toBe(1);
    expect(record.regions.length).toBeGreaterThan(0);
    expect(record.limitations).toEqual(
      expect.arrayContaining([
        "synthetic-extract-parser",
        "no-ocr",
        "content-minimized-durable-records",
      ]),
    );

    const spans = listPdfEvidenceSpans(capability, PDF_TEST_INPUTS.mainId);
    const reviewGate = spans.find((span) => {
      const excerpt = CHARTER_PDF.slice(span.startOffset, span.endOffset);
      return excerpt.includes(PDF_TEST_INPUTS.citableFact);
    });
    expect(reviewGate).toBeDefined();

    const claimSha = canonicalDigest({
      kind: "canon-claim",
      id: "claim-review-gate",
    });
    const cited = citePdfEvidenceSpan(capability, {
      inputId: PDF_TEST_INPUTS.mainId,
      stepId: "step:foundation-inspect",
      role: "evidence",
      supportedClaimSha256: claimSha,
      page: reviewGate!.page,
      regionIdentitySha256: reviewGate!.regionIdentitySha256,
      evidenceSpanDigestSha256: reviewGate!.evidenceSpanDigestSha256,
    });
    expect((cited as PdfEvidenceCitationV1).kind).toBe("docsfab-pdf-evidence-citation");
    const binding = cited as PdfEvidenceCitationV1;
    expect(binding.inputId).toBe(PDF_TEST_INPUTS.mainId);
    expect(binding.contentDigestSha256).toBe(record.contentDigestSha256);
    expect(binding.page).toBe(reviewGate!.page);
    expect(binding.regionIdentitySha256).toBe(reviewGate!.regionIdentitySha256);
    expect(binding.evidenceSpanDigestSha256).toBe(reviewGate!.evidenceSpanDigestSha256);
    expect(binding.citationSha256).toMatch(/^[a-f0-9]{64}$/u);

    const excerpt = projectPdfEvidenceExcerpt(capability, {
      inputId: PDF_TEST_INPUTS.mainId,
      evidenceSpanDigestSha256: reviewGate!.evidenceSpanDigestSha256,
      surface: "prompt",
    });
    expect("boundedExcerpt" in excerpt).toBe(true);
    expect((excerpt as { boundedExcerpt: string | null }).boundedExcerpt).toContain(
      PDF_TEST_INPUTS.citableFact,
    );

    const accessLedger = createExternalInputAccessLedger(capability);
    const citationLedger = createExternalInputCitationLedger(capability);
    expect(JSON.stringify(accessLedger)).not.toContain("/Users/");
    expect(JSON.stringify(citationLedger)).not.toContain(CHARTER_PDF.split("\n")[1]!);
    expect(
      JSON.stringify(getPdfExtractionRecord(capability, PDF_TEST_INPUTS.mainId)),
    ).not.toContain(PDF_TEST_INPUTS.citableFact);
  });

  it("registers charter page-2 extract for conflict-capable evidence", () => {
    const capability = openCapture();
    const registered = registerLocalUpload(capability, {
      inputId: PDF_TEST_INPUTS.pageTwoId,
      safeTitle: PDF_TEST_INPUTS.pageTwoTitle,
      logicalName: PDF_TEST_INPUTS.pageTwoLogicalName,
      mediaKind: "pdf-extract-text",
      bytes: CHARTER_P2,
      visibility: "internal",
      disclosurePolicy: "cite-and-quote",
      intendedRoles: ["evidence"],
    });
    expect(registered.disposition).toBe("registered");
    const record = extractPdfEvidence(
      capability,
      PDF_TEST_INPUTS.pageTwoId,
    ) as PdfExtractionRecordV1;
    expect(record.pageCount).toBe(2);
    const spans = listPdfEvidenceSpans(capability, PDF_TEST_INPUTS.pageTwoId);
    expect(spans.some((span) => span.page === 2)).toBe(true);
  });

  it("returns safe dispositions for unsupported, encrypted, oversized, malformed, digest-mismatch, changed, and revoked", () => {
    const capability = openCapture();

    const unsupported = registerLocalUpload(capability, {
      inputId: "input-docx",
      safeTitle: "Unsupported upload",
      logicalName: "inputs/notes.docx",
      mediaKind: "unsupported",
      bytes: "not a pdf",
      visibility: "internal",
      disclosurePolicy: "cite-only",
      intendedRoles: ["evidence"],
    });
    expect(unsupported.disposition).toBe("unsupported");

    const encrypted = registerLocalUpload(capability, {
      inputId: "input-encrypted",
      safeTitle: "Encrypted PDF",
      logicalName: "inputs/secret.pdf",
      mediaKind: "pdf",
      bytes: "%PDF-1.4\n1 0 obj\n<< /Encrypt 2 0 R >>\nendobj\n%%EOF\n",
      visibility: "restricted",
      disclosurePolicy: "identity-only",
      intendedRoles: ["evidence"],
    });
    expect(encrypted.disposition).toBe("encrypted");

    const binary = registerLocalUpload(capability, {
      inputId: "input-binary-pdf",
      safeTitle: "Binary PDF without extract",
      logicalName: "inputs/plain.pdf",
      mediaKind: "pdf",
      bytes: "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n1 0 obj<<>>endobj\n%%EOF\n",
      visibility: "internal",
      disclosurePolicy: "cite-only",
      intendedRoles: ["evidence"],
    });
    expect(binary.disposition).toBe("unsupported");

    const oversized = registerLocalUpload(capability, {
      inputId: "input-huge",
      safeTitle: "Oversized extract",
      logicalName: "inputs/huge.pdf.txt",
      mediaKind: "pdf-extract-text",
      bytes: `SYNTHETIC PDF EXTRACT — oversized\n${"x".repeat(100)}`,
      maxBytes: 32,
      visibility: "internal",
      disclosurePolicy: "cite-and-quote",
      intendedRoles: ["evidence"],
    });
    expect(oversized.disposition).toBe("oversized");

    const malformed = registerLocalUpload(capability, {
      inputId: "input-malformed",
      safeTitle: "Malformed extract",
      logicalName: "inputs/bad.pdf.txt",
      mediaKind: "pdf-extract-text",
      bytes: "this is not a synthetic extract header",
      visibility: "internal",
      disclosurePolicy: "cite-and-quote",
      intendedRoles: ["evidence"],
    });
    expect(malformed.disposition).toBe("malformed");

    const mismatch = registerLocalUpload(capability, {
      inputId: "input-mismatch",
      safeTitle: "Digest mismatch",
      logicalName: PDF_TEST_INPUTS.mainLogicalName,
      mediaKind: "pdf",
      bytes: CHARTER_PDF,
      expectedContentDigestSha256: SHA("f"),
      visibility: "internal",
      disclosurePolicy: "cite-and-quote",
      intendedRoles: ["evidence"],
    });
    expect(mismatch.disposition).toBe("digest-mismatch");

    const ok = registerLocalUpload(capability, {
      inputId: "input-revocable",
      safeTitle: PDF_TEST_INPUTS.revocableTitle,
      logicalName: PDF_TEST_INPUTS.mainLogicalName,
      mediaKind: "pdf",
      bytes: CHARTER_PDF,
      visibility: "internal",
      disclosurePolicy: "cite-and-quote",
      intendedRoles: ["evidence"],
    });
    expect(ok.disposition).toBe("registered");

    const changed = registerLocalUpload(capability, {
      inputId: "input-revocable",
      safeTitle: PDF_TEST_INPUTS.revocableTitle,
      logicalName: PDF_TEST_INPUTS.mainLogicalName,
      mediaKind: "pdf",
      bytes: `${CHARTER_PDF}\nchanged-tail`,
      visibility: "internal",
      disclosurePolicy: "cite-and-quote",
      intendedRoles: ["evidence"],
    });
    expect(changed.disposition).toBe("changed");

    // Fresh registration path for revoke coverage.
    const capability2 = openCapture();
    registerLocalUpload(capability2, {
      inputId: "input-to-revoke",
      safeTitle: "Soon revoked",
      logicalName: PDF_TEST_INPUTS.mainLogicalName,
      mediaKind: "pdf",
      bytes: CHARTER_PDF,
      visibility: "internal",
      disclosurePolicy: "cite-and-quote",
      intendedRoles: ["evidence"],
    });
    extractPdfEvidence(capability2, "input-to-revoke");
    const revoked = revokeLocalUpload(capability2, "input-to-revoke");
    expect(revoked.disposition).toBe("revoked");
    const after = extractPdfEvidence(capability2, "input-to-revoke");
    expect(isLocalUploadDisposition(after)).toBe(true);
    expect((after as LocalUploadDispositionV1).disposition).toBe("revoked");
    const access = accessLocalUpload(capability2, {
      inputId: "input-to-revoke",
      stepId: "step:after-revoke",
    });
    expect(isLocalUploadDisposition(access)).toBe(true);
    expect((access as LocalUploadDispositionV1).disposition).toBe("revoked");
  });

  it("rejects absolute host paths and does not expose parser internals on dispositions", () => {
    const capability = openCapture();
    expect(() =>
      registerLocalUpload(capability, {
        inputId: "input-host-path",
        safeTitle: "Host path attempt",
        logicalName: "/etc/passwd",
        mediaKind: "pdf-extract-text",
        bytes: CHARTER_PDF,
        visibility: "internal",
        disclosurePolicy: "cite-and-quote",
        intendedRoles: ["evidence"],
      }),
    ).toThrow(ExternalInputContractError);

    expect(() =>
      registerLocalUpload(capability, {
        inputId: "input-parent-escape",
        safeTitle: "Parent escape",
        logicalName: PDF_TEST_INPUTS.invalidParentName,
        mediaKind: "pdf",
        bytes: CHARTER_PDF,
        visibility: "internal",
        disclosurePolicy: "cite-and-quote",
        intendedRoles: ["evidence"],
      }),
    ).toThrow(ExternalInputContractError);

    const disposition = registerLocalUpload(capability, {
      inputId: "input-bad-magic",
      safeTitle: "Bad magic",
      logicalName: "inputs/not-pdf.bin",
      mediaKind: "pdf",
      bytes: "NOT_A_PDF",
      visibility: "internal",
      disclosurePolicy: "cite-only",
      intendedRoles: ["evidence"],
    });
    expect(disposition.disposition).toBe("malformed");
    expect(JSON.stringify(disposition)).not.toMatch(/stack|Error:|at Object/u);
  });

  it("parses synthetic regions deterministically for golden extracts", () => {
    const regions = parseSyntheticExtractRegions(CHARTER_PDF);
    expect(regions.length).toBeGreaterThan(0);
    expect(regions.every((region) => region.page === 1)).toBe(true);
    const again = parseSyntheticExtractRegions(CHARTER_PDF);
    expect(again.map((region) => region.regionIdentitySha256)).toEqual(
      regions.map((region) => region.regionIdentitySha256),
    );
  });
});

const PDF_FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/source-evidence/pdf",
);
const TWO_PAGE_PDF = readFileSync(join(PDF_FIXTURE_ROOT, "divergent-two-page.pdf"));
const MANY_PAGE_PDF = readFileSync(join(PDF_FIXTURE_ROOT, "many-pages.pdf"));
const temporary: string[] = [];

describe("central source-read, extraction, and PDF page limits (T5 / #1021)", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    process.exitCode = undefined;
    await Promise.all(
      temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("admits a per-step source-read budget at the catalog ceiling", () => {
    const policy = createSourceStepPolicy({
      sourceReadSkills: ["write-documentation"],
      perStepBudgetBytes: SOURCE_READ_RESPONSE_CEILING_BYTES,
    });
    expect(policy.perStepBudgetBytes).toBe(SOURCE_READ_RESPONSE_CEILING_BYTES);
  });

  it("refuses a per-step source-read budget one byte over the catalog ceiling", () => {
    const ceiling = limit("sources.readResponseCeilingBytes");
    expect(() =>
      createSourceStepPolicy({
        sourceReadSkills: ["write-documentation"],
        perStepBudgetBytes: ceiling.value + 1,
      }),
    ).toThrow(formatLimitObservation(ceiling, ceiling.value + 1));
  });

  it("keeps a permitted lower per-attempt source-read grant so #976 retries stay intact", () => {
    const policy = createSourceStepPolicy({
      sourceReadSkills: ["write-documentation"],
      perStepBudgetBytes: 8 * 1024,
    });
    expect(policy.perStepBudgetBytes).toBe(8 * 1024);
  });

  it("honors a lowered host override of the source-read ceiling and refuses override plus one", () => {
    const limits = {
      environment: {
        ...process.env,
        DOCSFAB_SOURCES_READ_RESPONSE_CEILING_BYTES: "16",
      },
      hostFile: null as const,
      projectFile: null as const,
    };
    const policy = createSourceStepPolicy({
      sourceReadSkills: ["write-documentation"],
      limits,
    });
    expect(policy.perStepBudgetBytes).toBe(16);
    const ceiling = limit("sources.readResponseCeilingBytes", limits);
    expect(() =>
      createSourceStepPolicy({
        sourceReadSkills: ["write-documentation"],
        perStepBudgetBytes: 17,
        limits,
      }),
    ).toThrow(formatLimitObservation(ceiling, 17));
  });

  it("extracts at the original-byte bound and refuses bound plus one", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("DOCSFAB_SOURCES_EXTRACTION_MAX_ORIGINAL_BYTES", "8");
    const atBound = Buffer.from("<p>x</p>");
    expect(atBound.byteLength).toBe(8);
    const kept = await extractSourceRepresentation({
      adapter: htmlSourceExtractorAdapter,
      bytes: atBound,
      mediaType: "text/html",
    });
    expect(kept.representation.completeness).toBe("complete");
    // Bound plus one names the extraction code, the limit's refusal code, the
    // bytes observed, the bound, and the remediation, with one closing sentence.
    const refused = extractSourceRepresentation({
      adapter: htmlSourceExtractorAdapter,
      bytes: Buffer.from("<p>xy</p>"),
      mediaType: "text/html",
    });
    await expect(refused).rejects.toMatchObject({
      name: "SourceExtractionError",
      code: "original-budget-exceeded",
      message:
        "Source extraction rejected: original-budget-exceeded. " +
        "sources-extraction-max-original-bytes-bound: 9 exceeds sources.extractionMaxOriginalBytes = 8 bytes. " +
        "Bind a smaller source, such as a narrower merged-MR window or a smaller tracked file, or raise DOCSFAB_SOURCES_EXTRACTION_MAX_ORIGINAL_BYTES, up to 67108864, then start a new run. " +
        "Follow the named remediation.",
    });
    expect(formatOriginalBudgetExceeded(9)).toContain("sources.extractionMaxOriginalBytes");
    expect(formatOriginalBudgetExceeded(9)).toContain("Follow the named remediation.");
  });

  it("raises both extraction byte ceilings past their defaults, up to the contract's 64 MiB", async () => {
    vi.unstubAllEnvs();
    const contractMax = 64 * 1024 * 1024;
    // Each override is admitted at the catalog max and refused one past it.
    for (const [name, override] of [
      ["sources.extractionMaxOriginalBytes", "DOCSFAB_SOURCES_EXTRACTION_MAX_ORIGINAL_BYTES"],
      ["sources.extractionMaxDerivativeBytes", "DOCSFAB_SOURCES_EXTRACTION_MAX_DERIVATIVE_BYTES"],
    ] as const) {
      expect(limit(name).value).toBeLessThan(contractMax);
      expect(limit(name, { environment: { [override]: String(contractMax) } }).value).toBe(
        contractMax,
      );
      expect(() => limit(name, { environment: { [override]: String(contractMax + 1) } })).toThrow(
        `${override} must be an integer between 1 and ${contractMax}.`,
      );
    }

    // A text source of 2,000 lines of 524 bytes: 1,049,999 bytes of derivative,
    // past the 1,048,576-byte default, which truncates it.
    const text = Buffer.from(
      Array.from({ length: 2000 }, (_, index) => `${index}`.padEnd(524, "d")).join("\n"),
    );
    const extract = () =>
      extractSourceRepresentation({
        adapter: textSourceExtractorAdapter,
        bytes: text,
        mediaType: "text/plain",
      });
    expect((await extract()).representation.limitations).toEqual(["byte-budget-truncated"]);
    // Raised to exactly its size, it is whole; raised to one byte less, it is cut.
    vi.stubEnv("DOCSFAB_SOURCES_EXTRACTION_MAX_DERIVATIVE_BYTES", String(text.byteLength));
    const whole = await extract();
    expect(whole.representation.completeness).toBe("complete");
    expect(whole.derivative.byteLength).toBe(1_049_999);
    vi.stubEnv("DOCSFAB_SOURCES_EXTRACTION_MAX_DERIVATIVE_BYTES", String(text.byteLength - 1));
    expect((await extract()).representation.limitations).toEqual(["byte-budget-truncated"]);

    // An original one byte past the 4 MiB default is refused at the default and
    // read under an override of its size; one more byte is refused again.
    vi.stubEnv("DOCSFAB_SOURCES_EXTRACTION_MAX_DERIVATIVE_BYTES", String(contractMax));
    const defaultOriginal = limit("sources.extractionMaxOriginalBytes").value;
    expect(defaultOriginal).toBe(4_194_304);
    const original = (bytes: number) =>
      extractSourceRepresentation({
        adapter: textSourceExtractorAdapter,
        bytes: Buffer.alloc(bytes, "o"),
        mediaType: "text/plain",
      });
    await expect(original(defaultOriginal + 1)).rejects.toMatchObject({
      code: "original-budget-exceeded",
      message: expect.stringContaining(
        `sources-extraction-max-original-bytes-bound: ${defaultOriginal + 1} exceeds sources.extractionMaxOriginalBytes = ${defaultOriginal} bytes.`,
      ),
    });
    vi.stubEnv("DOCSFAB_SOURCES_EXTRACTION_MAX_ORIGINAL_BYTES", String(defaultOriginal + 1));
    expect((await original(defaultOriginal + 1)).derivative.byteLength).toBe(defaultOriginal + 1);
    await expect(original(defaultOriginal + 2)).rejects.toMatchObject({
      code: "original-budget-exceeded",
      message: expect.stringContaining(
        `sources-extraction-max-original-bytes-bound: ${defaultOriginal + 2} exceeds sources.extractionMaxOriginalBytes = ${defaultOriginal + 1} bytes.`,
      ),
    });
  });

  it("records byte-budget-truncated with the actual pre-truncation derivative size", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("DOCSFAB_SOURCES_EXTRACTION_MAX_DERIVATIVE_BYTES", "3");
    const html = Buffer.from("<p>aa</p><p>ccc</p>");
    const truncated = await extractSourceRepresentation({
      adapter: htmlSourceExtractorAdapter,
      bytes: html,
      mediaType: "text/html",
    });
    expect(truncated.representation.limitations).toContain("byte-budget-truncated");
    expect(truncated.representation.completeness).toBe("partial");
    expect(truncated.representation.overflows).toEqual([
      {
        limitation: "byte-budget-truncated",
        limitName: "sources.extractionMaxDerivativeBytes",
        observed: 6,
      },
    ]);
    const summary = formatSourceRepresentationLimitations(truncated.representation).join("\n");
    expect(summary).toMatch(/6 exceeds sources\.extractionMaxDerivativeBytes = 3 bytes/);
    expect(summary).not.toMatch(/4 exceeds sources\.extractionMaxDerivativeBytes/);
    expect(summary).toContain("Follow the named remediation.");
    const human = operatorLimitSummary({ sourceRepresentations: [truncated.representation] });
    expect(human).toMatch(/6 exceeds sources\.extractionMaxDerivativeBytes = 3 bytes/);
    expect(human).toContain("LIMITATIONS");

    vi.stubEnv("DOCSFAB_SOURCES_EXTRACTION_MAX_DERIVATIVE_BYTES", "6");
    const complete = await extractSourceRepresentation({
      adapter: htmlSourceExtractorAdapter,
      bytes: html,
      mediaType: "text/html",
    });
    expect(complete.representation.limitations).not.toContain("byte-budget-truncated");
    expect(complete.representation.completeness).toBe("complete");
    expect(complete.representation.overflows).toBeUndefined();
  });

  it("reports an honest nonnumeric extraction overflow when observation was not persisted", () => {
    const summary = formatSourceRepresentationLimitations({
      limitations: ["byte-budget-truncated", "span-budget-truncated"],
    }).join("\n");
    expect(summary).toContain("exceeded sources.extractionMaxDerivativeBytes = ");
    expect(summary).toContain("exceeded sources.extractionMaxSpans = ");
    expect(summary).not.toMatch(/\d+ exceeds sources\.extractionMaxDerivativeBytes/u);
    const human = operatorLimitSummary({
      sourceRepresentations: [{ limitations: ["byte-budget-truncated", "span-budget-truncated"] }],
    });
    expect(human).toContain("exceeded sources.extractionMaxDerivativeBytes = ");
    expect(human).toContain("exceeded sources.extractionMaxSpans = ");
  });

  it("records span-budget-truncated with the actual pre-truncation span count", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("DOCSFAB_SOURCES_EXTRACTION_MAX_SPANS", "2");
    const html = Buffer.from("<p>a</p><p>b</p><p>c</p><p>d</p>");
    const truncated = await extractSourceRepresentation({
      adapter: htmlSourceExtractorAdapter,
      bytes: html,
      mediaType: "text/html",
    });
    expect(truncated.representation.limitations).toContain("span-budget-truncated");
    expect(truncated.representation.overflows).toEqual([
      {
        limitation: "span-budget-truncated",
        limitName: "sources.extractionMaxSpans",
        observed: 4,
      },
    ]);
    const summary = formatSourceRepresentationLimitations(truncated.representation).join("\n");
    expect(summary).toMatch(/4 exceeds sources\.extractionMaxSpans = 2 count/);
    expect(summary).not.toMatch(/3 exceeds sources\.extractionMaxSpans/);
    expect(operatorLimitSummary({ sourceRepresentations: [truncated.representation] })).toMatch(
      /4 exceeds sources\.extractionMaxSpans = 2 count/,
    );

    vi.stubEnv("DOCSFAB_SOURCES_EXTRACTION_MAX_SPANS", "4");
    const complete = await extractSourceRepresentation({
      adapter: htmlSourceExtractorAdapter,
      bytes: html,
      mediaType: "text/html",
    });
    expect(complete.representation.limitations).not.toContain("span-budget-truncated");
    expect(complete.representation.completeness).toBe("complete");
  });

  it("stops PDF extraction at the page bound and records the actual page count", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("DOCSFAB_SOURCES_PDF_MAX_PAGES", "2");
    const atBound = await extractPdfTextEvidence({
      bytes: TWO_PAGE_PDF,
      options: pdfSourceExtractorAdapter.defaultOptions,
      limits: DEFAULT_SOURCE_EXTRACTION_LIMITS,
    });
    expect(atBound.pageCount).toBe(2);
    expect(atBound.reasons).not.toContain("over-page-limit");
    expect(atBound.overflow).toBeUndefined();
    expect(formatPdfEvidenceLimitations(atBound)).toEqual([]);

    const over = await extractPdfTextEvidence({
      bytes: MANY_PAGE_PDF,
      options: pdfSourceExtractorAdapter.defaultOptions,
      limits: DEFAULT_SOURCE_EXTRACTION_LIMITS,
    });
    expect(over.segments).toHaveLength(2);
    expect(over.pageCount).toBe(105);
    expect(over.reasons).toContain("over-page-limit");
    expect(over.overflow).toEqual({ limitName: "sources.pdfMaxPages", observed: 105 });
    expect(over.limitations).toContain("span-budget-truncated");
    const summary = formatPdfEvidenceLimitations(over).join("\n");
    expect(summary).toMatch(/105 exceeds sources\.pdfMaxPages = 2 pages/);
    expect(summary).not.toMatch(/3 exceeds sources\.pdfMaxPages/);
    expect(summary).toContain("sources-pdf-max-pages-bound");
    expect(summary).toContain("Follow the named remediation.");
  });

  it("seals PDF page overflow through the adapter extract path into the operator summary", async () => {
    vi.stubEnv("DOCSFAB_SOURCES_PDF_MAX_PAGES", "2");
    const atBound = await extractSourceRepresentation({
      adapter: pdfSourceExtractorAdapter,
      bytes: TWO_PAGE_PDF,
      mediaType: "application/pdf",
    });
    expect(atBound.representation.completeness).toBe("complete");
    expect(atBound.representation.limitations).not.toContain("span-budget-truncated");
    expect(atBound.representation.overflows).toBeUndefined();
    expect(operatorLimitSummary({ sourceRepresentations: [atBound.representation] })).not.toContain(
      "sources.pdfMaxPages",
    );

    const over = await extractSourceRepresentation({
      adapter: pdfSourceExtractorAdapter,
      bytes: MANY_PAGE_PDF,
      mediaType: "application/pdf",
    });
    expect(over.representation.completeness).toBe("partial");
    expect(over.representation.overflows).toEqual([
      {
        limitation: "span-budget-truncated",
        limitName: "sources.pdfMaxPages",
        observed: 105,
      },
    ]);
    const persisted = persistPdfRepresentation(over, MANY_PAGE_PDF.byteLength);
    expect(persisted.representations[0]!.overflows).toEqual(over.representation.overflows);
    const captured = await captureProductionLimitOverflow({
      record: overflowRunRecord(),
      limitOverflowEvidence: { sourceRepresentations: persisted.representations },
      roots: temporary,
    });
    for (const human of [captured.runHuman, captured.showHuman]) {
      expect(human).toMatch(/105 exceeds sources\.pdfMaxPages = 2 pages/);
      expect(human).not.toMatch(/3 exceeds sources\.pdfMaxPages/);
      expect(human).not.toContain("sources.extractionMaxSpans");
      expect(human).toContain("LIMITATIONS");
      expect(human).toContain("Follow the named remediation.");
    }
    expect(captured.envelope.limitOverflow?.join("\n")).toMatch(
      /105 exceeds sources\.pdfMaxPages = 2 pages/,
    );
    expect(captured.runJson).toMatch(/105 exceeds sources\.pdfMaxPages = 2 pages/);
    expect(captured.showJson).toMatch(/105 exceeds sources\.pdfMaxPages = 2 pages/);
  });

  it("refuses a persisted overflow row whose limitName is not a catalog axis", async () => {
    vi.stubEnv("DOCSFAB_SOURCES_PDF_MAX_PAGES", "2");
    const over = await extractSourceRepresentation({
      adapter: pdfSourceExtractorAdapter,
      bytes: MANY_PAGE_PDF,
      mediaType: "application/pdf",
    });
    const persisted = persistPdfRepresentation(over, MANY_PAGE_PDF.byteLength);
    const cloned = JSON.parse(JSON.stringify(persisted)) as {
      representations: Array<{ overflows?: Array<{ limitName: string }> }>;
    };
    cloned.representations[0]!.overflows![0]!.limitName = "sources.notARealAxis";
    expect(() => decodeSourceObservation(cloned)).toThrow(SourceEvidenceContractError);
    expect(() => decodeSourceObservation(cloned)).toThrow(/invalid-value/u);
  });

  it("binds the selected PDF page ceiling into extractor identity before extraction", async () => {
    const two = await extractSourceRepresentation({
      adapter: pdfSourceExtractorAdapter,
      bytes: TWO_PAGE_PDF,
      mediaType: "application/pdf",
      options: { maxPages: 2 },
    });
    const four = await extractSourceRepresentation({
      adapter: pdfSourceExtractorAdapter,
      bytes: TWO_PAGE_PDF,
      mediaType: "application/pdf",
      options: { maxPages: 4 },
    });
    expect(two.extractor.optionsSha256).not.toBe(four.extractor.optionsSha256);
    expect(two.representation.extractor.optionsSha256).toBe(two.extractor.optionsSha256);

    await expect(
      extractSourceRepresentation({
        adapter: pdfSourceExtractorAdapter,
        bytes: TWO_PAGE_PDF,
        mediaType: "application/pdf",
        options: { maxPages: 0 },
      }),
    ).rejects.toThrow(new SourceExtractionError("invalid-limits"));
    await expect(
      extractSourceRepresentation({
        adapter: pdfSourceExtractorAdapter,
        bytes: TWO_PAGE_PDF,
        mediaType: "application/pdf",
        options: { maxPages: 1.5 },
      }),
    ).rejects.toThrow(new SourceExtractionError("invalid-limits"));
    await expect(
      extractSourceRepresentation({
        adapter: pdfSourceExtractorAdapter,
        bytes: TWO_PAGE_PDF,
        mediaType: "application/pdf",
        options: { maxPages: Number.NaN },
      }),
    ).rejects.toThrow(new SourceExtractionError("invalid-limits"));
  });
});

function persistPdfRepresentation(
  extracted: Awaited<ReturnType<typeof extractSourceRepresentation>>,
  originalByteLength: number,
) {
  return decodeSourceObservation(
    JSON.parse(
      JSON.stringify(
        createSourceObservation({
          observationId: "obs-pdf-overflow",
          originIdSha256: SHA("a"),
          inputId: "input-pdf-overflow",
          registrationSha256: SHA("b"),
          runIdSha256: SHA("c"),
          repository: { identitySha256: SHA("d"), revision: "e".repeat(40) },
          requestSha256: SHA("f"),
          producerId: "workspace-tracked-files",
          producerVersion: "1",
          producerScopeSha256: SHA("a"),
          acquisitionReceiptSha256: SHA("b"),
          observedAt: "2026-09-21T16:00:00.000Z",
          original: {
            sha256: extracted.originalSha256,
            byteLength: originalByteLength,
            mediaType: "application/pdf",
            locatorSha256: SHA("c"),
            version: { kind: "content-digest", contentDigestSha256: extracted.originalSha256 },
            repositoryPath: "sources/many-pages.pdf",
          },
          representations: [extracted.representation],
        }),
      ),
    ),
  );
}

function operatorLimitSummary(
  evidence: import("../src/operator/run-summary.js").RunLimitOverflowEvidenceV1,
): string {
  return formatRunSummary({
    record: overflowRunRecord(),
    recordPath: "/private/state/run-limit-overflow.json",
    exitCode: 0,
    repositoryPath: "/tmp/example",
    tty: false,
    ci: true,
    noColor: true,
    limitOverflowEvidence: evidence,
  }).join("\n");
}

function overflowRunRecord(): RunRecord {
  return {
    schemaVersion: 2,
    id: "run-limit-overflow",
    workflow: "review-documentation",
    repository: {
      sourcePath: "/tmp/example",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-09-21T16:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [],
  };
}
