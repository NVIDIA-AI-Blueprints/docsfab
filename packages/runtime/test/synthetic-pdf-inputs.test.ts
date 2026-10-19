// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  createExternalInputCitationLedger,
  extractPdfEvidence,
  listPdfEvidenceSpans,
  openExternalInputAccessCapture,
  openExternalInputCitationCapture,
  parseSyntheticExtractRegions,
  registerLocalUpload,
  type PdfExtractionRecordV1,
} from "../src/inputs/index.js";
import { PDF_TEST_INPUTS } from "./helpers/pdf-adapter-inputs.js";

function capture() {
  const capability = openExternalInputAccessCapture({
    runIdSha256: "a".repeat(64),
    repository: { identitySha256: "b".repeat(64), revision: "c".repeat(40) },
  });
  openExternalInputCitationCapture(capability);
  return capability;
}

describe("synthetic PDF input distribution", () => {
  it("supplies a registered citable fact without persisting its text", () => {
    const capability = capture();
    expect(
      registerLocalUpload(capability, {
        inputId: PDF_TEST_INPUTS.mainId,
        safeTitle: PDF_TEST_INPUTS.mainTitle,
        logicalName: PDF_TEST_INPUTS.mainLogicalName,
        mediaKind: "pdf",
        bytes: PDF_TEST_INPUTS.text,
        visibility: "internal",
        disclosurePolicy: "cite-and-quote",
        intendedRoles: ["evidence"],
      }).disposition,
    ).toBe("registered");
    const record = extractPdfEvidence(capability, PDF_TEST_INPUTS.mainId) as PdfExtractionRecordV1;
    expect(record.pageCount).toBe(1);
    const spans = listPdfEvidenceSpans(capability, PDF_TEST_INPUTS.mainId);
    expect(
      spans.some((span) =>
        PDF_TEST_INPUTS.text
          .slice(span.startOffset, span.endOffset)
          .includes(PDF_TEST_INPUTS.citableFact),
      ),
    ).toBe(true);
    expect(JSON.stringify(record)).not.toContain(PDF_TEST_INPUTS.citableFact);
    expect(JSON.stringify(createExternalInputCitationLedger(capability))).not.toContain(
      PDF_TEST_INPUTS.citableFact,
    );
  });

  it("supplies an independently addressable second-page extract", () => {
    const regions = parseSyntheticExtractRegions(PDF_TEST_INPUTS.pageTwoText);
    expect(regions.length).toBeGreaterThan(0);
    expect(regions.every((region) => region.page === 2)).toBe(true);
    const capability = capture();
    expect(
      registerLocalUpload(capability, {
        inputId: PDF_TEST_INPUTS.pageTwoId,
        safeTitle: PDF_TEST_INPUTS.pageTwoTitle,
        logicalName: PDF_TEST_INPUTS.pageTwoLogicalName,
        mediaKind: "pdf-extract-text",
        bytes: PDF_TEST_INPUTS.pageTwoText,
        visibility: "internal",
        disclosurePolicy: "cite-and-quote",
        intendedRoles: ["evidence"],
      }).disposition,
    ).toBe("registered");
    expect(extractPdfEvidence(capability, PDF_TEST_INPUTS.pageTwoId)).toMatchObject({
      pageCount: 2,
    });
  });
});
