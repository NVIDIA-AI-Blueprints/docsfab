// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as nodeZlib from "node:zlib";

import { describe, expect, it, vi } from "vitest";

// Wraps (never replaces the behavior of) node:zlib's real inflateRawSync so a
// dedicated test can observe the options each call received. Every other test
// in this file still exercises the real implementation through this wrapper.
vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  return { ...actual, inflateRawSync: vi.fn(actual.inflateRawSync) };
});

import {
  DOCX_MEDIA_TYPE,
  DOCX_XML_SECURITY_POLICY,
  diagnoseDocxPackage,
  docxSourceExtractorAdapter,
} from "../src/inputs/adapters/docx.js";
import {
  admitRunSourceBinding,
  assembleSourceEvidenceFinal,
  createDefaultSourceExtractorRegistry,
  createSourceArtifactReference,
  createSourceBinding,
  createSourceEvidenceHostAuthority,
  createSourceEvidenceService,
  createSourceExtractorRegistry,
  createSourceObservation,
  createSourceSpanCitation,
  createSourceStepPolicy,
  DEFAULT_SOURCE_EXTRACTION_LIMITS,
  digestSourceProducerScopes,
  extractSourceRepresentation,
  openExternalInputAccessCapture,
  originalBudgetExceededError,
  projectSourceRequestContext,
  recordExternalInputAccess,
  registerFakeExternalInput,
  type SourceEvidenceHostVerifier,
  sourceEvidenceRequiredGapCodes,
  SourceExtractionError,
  verifySourceSpanCitations,
} from "../src/inputs/index.js";
import type { SourceSpanLocatorV1 } from "../src/inputs/source-evidence.js";
import {
  buildZip,
  ENCRYPTED_GENERAL_PURPOSE_FLAG,
  SYMLINK_EXTERNAL_ATTRS,
} from "./fixtures/source-evidence/docx/zip-builder.mjs";

const BASIC = new Uint8Array(
  readFileSync(new URL("./fixtures/source-evidence/docx/basic-document.docx", import.meta.url)),
);
const DIVERGENT = new Uint8Array(
  readFileSync(new URL("./fixtures/source-evidence/docx/divergent-document.docx", import.meta.url)),
);

const WORDPROCESSINGML_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_DOCUMENT_REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const MAIN_DOCUMENT_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

function documentXml(bodyInner: string, prefix = "w"): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><${prefix}:document xmlns:${prefix}="${WORDPROCESSINGML_NS}"><${prefix}:body>${bodyInner}</${prefix}:body></${prefix}:document>`;
}

function contentTypesXml(
  mainPart = "word/document.xml",
  mainType = MAIN_DOCUMENT_CONTENT_TYPE,
): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${mainPart}" ContentType="${mainType}"/></Types>`;
}

function rootRelsXml(
  target = "word/document.xml",
  type: string | null = OFFICE_DOCUMENT_REL_TYPE,
  targetMode?: "External",
): string {
  const targetModeAttr = targetMode ? ` TargetMode="${targetMode}"` : "";
  const rel =
    type === null
      ? ""
      : `<Relationship Id="rId1" Type="${type}" Target="${target}"${targetModeAttr}/>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELATIONSHIPS_NS}">${rel}</Relationships>`;
}

interface PackageOptions {
  bodyInner: string;
  prefix?: string;
  documentPartName?: string;
  contentTypes?: string;
  rels?: string;
  extraEntries?: Array<Record<string, unknown>>;
}

/** Build a complete, well-formed package: content-types + root rels + main document. */
function fullPackage(options: PackageOptions): Uint8Array {
  const documentPartName = options.documentPartName ?? "word/document.xml";
  const contentTypes = options.contentTypes ?? contentTypesXml(documentPartName);
  const rels = options.rels ?? rootRelsXml(documentPartName);
  return new Uint8Array(
    buildZip([
      { name: "[Content_Types].xml", content: contentTypes },
      { name: "_rels/.rels", content: rels },
      { name: documentPartName, content: documentXml(options.bodyInner, options.prefix) },
      ...((options.extraEntries ?? []) as never),
    ]),
  );
}

/** A full package with the given raw body, using default parts/prefix. */
function docxBytes(
  bodyInner: string,
  extraEntries: Array<Record<string, unknown>> = [],
): Uint8Array {
  return fullPackage({ bodyInner, extraEntries });
}

const SIMPLE_PARAGRAPH = "<w:p><w:r><w:t>Hello world</w:t></w:r></w:p>";

function docxLocator(locator: SourceSpanLocatorV1) {
  if (locator.kind !== "docx-block") throw new Error(`expected docx-block, got ${locator.kind}`);
  return locator;
}

/**
 * Positive control for this whole file. Every refusal/limitation test below
 * changes exactly one thing relative to a launch that is known to succeed, so
 * a green refusal cannot be an artifact of a broken fixture.
 */
function cleanExtraction(bytes: Uint8Array = BASIC) {
  return extractSourceRepresentation({
    adapter: docxSourceExtractorAdapter,
    bytes,
    mediaType: DOCX_MEDIA_TYPE,
  });
}

describe("DOCX block extraction", () => {
  it("extracts one segment per body paragraph with the exact literal text", async () => {
    const { representation, derivative } = await cleanExtraction();
    const text = (locator: SourceSpanLocatorV1) => {
      const span = representation.spans.find(
        (entry) => JSON.stringify(entry.locator) === JSON.stringify(locator),
      );
      if (!span) throw new Error(`no span for locator ${JSON.stringify(locator)}`);
      return Buffer.from(derivative.subarray(span.startByte, span.endByte)).toString("utf8");
    };
    expect(
      text({
        kind: "docx-block",
        part: "word/document.xml",
        blockPath: [0],
        paragraphOrdinal: 0,
        tableCell: null,
      }),
    ).toBe("Release Notes");
    expect(
      text({
        kind: "docx-block",
        part: "word/document.xml",
        blockPath: [2],
        paragraphOrdinal: 2,
        tableCell: null,
      }),
    ).toBe("First bullet item");
    expect(
      text({
        kind: "docx-block",
        part: "word/document.xml",
        blockPath: [3],
        paragraphOrdinal: 3,
        tableCell: null,
      }),
    ).toBe("Second bullet item");
    expect(
      text({
        kind: "docx-block",
        part: "word/document.xml",
        blockPath: [4],
        paragraphOrdinal: 4,
        tableCell: null,
      }),
    ).toBe("See the docs for more.");
  });

  it("assigns heading and list items docx-block ordinals, never HTML or page positions", async () => {
    const { representation } = await cleanExtraction();
    expect(representation.spans.every((span) => span.locator.kind === "docx-block")).toBe(true);
    const heading = docxLocator(
      representation.spans.find((span) => docxLocator(span.locator).paragraphOrdinal === 0)!
        .locator,
    );
    const firstList = docxLocator(
      representation.spans.find((span) => docxLocator(span.locator).paragraphOrdinal === 2)!
        .locator,
    );
    expect(heading).toEqual({
      kind: "docx-block",
      part: "word/document.xml",
      blockPath: [0],
      paragraphOrdinal: 0,
      tableCell: null,
    });
    expect(firstList).toEqual({
      kind: "docx-block",
      part: "word/document.xml",
      blockPath: [2],
      paragraphOrdinal: 2,
      tableCell: null,
    });
  });

  it("extracts non-ASCII spans exactly, including a surrogate-pair emoji", async () => {
    const { representation, derivative } = await cleanExtraction();
    const span = representation.spans.find((entry) => {
      const locator = docxLocator(entry.locator);
      return locator.blockPath[0] === 1 && locator.paragraphOrdinal === 1;
    });
    if (!span) throw new Error("expected the unicode paragraph span");
    const text = Buffer.from(derivative.subarray(span.startByte, span.endByte)).toString("utf8");
    expect(text).toBe("Unicode café & résumé 日本語 😀");
  });

  it("extracts one segment per table cell with row/column locators", async () => {
    const { representation, derivative } = await cleanExtraction();
    const cellText = (row: number, column: number) => {
      const span = representation.spans.find((entry) => {
        const locator = docxLocator(entry.locator);
        return locator.tableCell?.row === row && locator.tableCell?.column === column;
      });
      if (!span) throw new Error(`no span for cell (${row}, ${column})`);
      return Buffer.from(derivative.subarray(span.startByte, span.endByte)).toString("utf8");
    };
    expect(cellText(0, 0)).toBe("Row0 Col0");
    expect(cellText(0, 1)).toBe("Row0 Col1");
    expect(cellText(1, 0)).toBe("Row1 Col0");
    expect(cellText(1, 1)).toBe("Row1 Col1");
    const cellLocator = docxLocator(
      representation.spans.find((entry) => docxLocator(entry.locator).tableCell?.row === 0)!
        .locator,
    );
    expect(cellLocator.blockPath).toEqual([5, 0, 0]);
    expect(cellLocator.paragraphOrdinal).toBeNull();
  });

  it("reports complete for a clean document with no limitations", async () => {
    const { representation } = await cleanExtraction();
    expect(representation.completeness).toBe("complete");
    expect(representation.limitations).toEqual([]);
    expect(representation.mediaType).toBe("text/plain; charset=utf-8");
  });

  it("never quotes the external hyperlink target it never opened", async () => {
    const { derivative } = await cleanExtraction();
    const text = Buffer.from(derivative).toString("utf8");
    expect(text).not.toContain("docs.example.invalid");
    expect(text).toContain("the docs");
  });

  it("gives divergent originals divergent representation and span identities", async () => {
    const first = await cleanExtraction(BASIC);
    const second = await cleanExtraction(DIVERGENT);
    expect(second.representation.representationId).not.toBe(first.representation.representationId);
    const shared = first.representation.spans.filter((span) =>
      second.representation.spans.some((other) => other.spanId === span.spanId),
    );
    expect(shared).toHaveLength(0);
  });

  it("resolves the same block position to different text across divergent fixtures", async () => {
    const first = await cleanExtraction(BASIC);
    const second = await cleanExtraction(DIVERGENT);
    const firstBlockZero = first.representation.spans.find(
      (entry) => docxLocator(entry.locator).paragraphOrdinal === 0,
    )!;
    const secondBlockZero = second.representation.spans.find(
      (entry) => docxLocator(entry.locator).paragraphOrdinal === 0,
    )!;
    const firstText = Buffer.from(
      first.derivative.subarray(firstBlockZero.startByte, firstBlockZero.endByte),
    ).toString("utf8");
    const secondText = Buffer.from(
      second.derivative.subarray(secondBlockZero.startByte, secondBlockZero.endByte),
    ).toString("utf8");
    expect(firstText).toBe("Release Notes");
    expect(secondText).toBe("Divergent Notes");
    expect(firstText).not.toBe(secondText);
  });

  it("keeps the derivative digest distinct from the original digest", async () => {
    const { representation } = await cleanExtraction();
    expect(representation.sha256).not.toBe(representation.originalSha256);
  });

  it("refuses an adapter call that does not claim the media type", async () => {
    await expect(
      extractSourceRepresentation({
        adapter: docxSourceExtractorAdapter,
        bytes: BASIC,
        mediaType: "application/zip",
      }),
    ).rejects.toThrowError(new SourceExtractionError("unsupported-media-type"));
  });

  it("fails closed rather than truncating an oversized original", async () => {
    const refused = extractSourceRepresentation({
      adapter: docxSourceExtractorAdapter,
      bytes: BASIC,
      mediaType: DOCX_MEDIA_TYPE,
      limits: { maxOriginalBytes: 16 },
    });
    await expect(refused).rejects.toThrowError(originalBudgetExceededError(BASIC.byteLength, 16));
    // The line names the bound in force, the 16 bytes this call allowed, not the catalog's.
    await expect(refused).rejects.toThrowError(
      `sources-extraction-max-original-bytes-bound: ${BASIC.byteLength} exceeds sources.extractionMaxOriginalBytes = 16 bytes.`,
    );
  });

  it("truncates the derivative under a byte budget and says so", async () => {
    const { representation } = await extractSourceRepresentation({
      adapter: docxSourceExtractorAdapter,
      bytes: BASIC,
      mediaType: DOCX_MEDIA_TYPE,
      limits: { maxDerivativeBytes: 40 },
    });
    expect(representation.completeness).toBe("partial");
    expect(representation.limitations).toContain("byte-budget-truncated");
  });

  it("truncates spans under a span budget and says so", async () => {
    const { representation } = await extractSourceRepresentation({
      adapter: docxSourceExtractorAdapter,
      bytes: BASIC,
      mediaType: DOCX_MEDIA_TYPE,
      limits: { maxSpans: 2 },
    });
    expect(representation.spans).toHaveLength(2);
    expect(representation.limitations).toContain("span-budget-truncated");
  });

  it("refuses to run under an already cancelled signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      extractSourceRepresentation({
        adapter: docxSourceExtractorAdapter,
        bytes: BASIC,
        mediaType: DOCX_MEDIA_TYPE,
        signal: controller.signal,
      }),
    ).rejects.toThrowError(new SourceExtractionError("extraction-cancelled"));
  });

  it("resolves the adapter by parameter-free media type and rejects duplicate registration", () => {
    const registry = createSourceExtractorRegistry([docxSourceExtractorAdapter]);
    expect(registry.resolve(`${DOCX_MEDIA_TYPE}; charset=binary`)).toBe(docxSourceExtractorAdapter);
    expect(() =>
      createSourceExtractorRegistry([docxSourceExtractorAdapter, docxSourceExtractorAdapter]),
    ).toThrowError(new SourceExtractionError("duplicate-adapter"));
  });

  it("recognizes a body paragraph under an alternate prefix bound to the same namespace", async () => {
    const altBytes = fullPackage({
      bodyInner: "<x:p><x:r><x:t>Hello world</x:t></x:r></x:p>",
      prefix: "x",
    });
    const wResult = await cleanExtraction(docxBytes(SIMPLE_PARAGRAPH));
    const xResult = await cleanExtraction(altBytes);
    expect(xResult.representation.spans).toHaveLength(wResult.representation.spans.length);
    expect(xResult.representation.limitations).toEqual([]);
    const wLocator = docxLocator(wResult.representation.spans[0]!.locator);
    const xLocator = docxLocator(xResult.representation.spans[0]!.locator);
    expect(xLocator.blockPath).toEqual(wLocator.blockPath);
    expect(xLocator.paragraphOrdinal).toBe(wLocator.paragraphOrdinal);
    const xText = Buffer.from(
      xResult.derivative.subarray(
        xResult.representation.spans[0]!.startByte,
        xResult.representation.spans[0]!.endByte,
      ),
    ).toString("utf8");
    expect(xText).toBe("Hello world");
  });

  it("does not shift later block ordinals when an earlier alternate-prefix paragraph is present", async () => {
    const bytes = fullPackage({
      bodyInner:
        '<x:p xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><x:r><x:t>Alt prefix first</x:t></x:r></x:p><w:p><w:r><w:t>Then w prefix</w:t></w:r></w:p>',
    });
    const { representation, derivative } = await cleanExtraction(bytes);
    expect(representation.spans).toHaveLength(2);
    const texts = representation.spans.map((span) =>
      Buffer.from(derivative.subarray(span.startByte, span.endByte)).toString("utf8"),
    );
    expect(texts).toEqual(["Alt prefix first", "Then w prefix"]);
    const ordinals = representation.spans.map((span) => docxLocator(span.locator).paragraphOrdinal);
    expect(ordinals).toEqual([0, 1]);
  });

  it("parses a quoted attribute value containing a literal greater-than sign without corrupting text", async () => {
    const bytes = docxBytes('<w:p><w:r><w:t w:x="a&gt;INJECTED">real text</w:t></w:r></w:p>');
    const { derivative } = await cleanExtraction(bytes);
    const text = Buffer.from(derivative).toString("utf8");
    expect(text).toBe("real text");
    expect(text).not.toContain("INJECTED");
  });
});

describe("DOCX main-document-part resolution", () => {
  it("resolves the main part from _rels/.rels rather than assuming word/document.xml", async () => {
    const bytes = fullPackage({
      bodyInner: "<w:p><w:r><w:t>Real content at an unusual path</w:t></w:r></w:p>",
      documentPartName: "word/document2.xml",
    });
    const diagnosis = diagnoseDocxPackage(bytes);
    expect(diagnosis).toEqual({ ok: true, documentPart: "word/document2.xml" });
    const { representation, derivative } = await cleanExtraction(bytes);
    expect(Buffer.from(derivative).toString("utf8")).toBe("Real content at an unusual path");
    expect(docxLocator(representation.spans[0]!.locator).part).toBe("word/document2.xml");
  });

  it("cites the real main part and never the decoy document.xml a relationship does not name", async () => {
    // _rels/.rels names word/document2.xml as the real main part. A benign
    // decoy also named word/document.xml sits in the archive at the
    // conventional path but is never the officeDocument target.
    const bytes = new Uint8Array(
      buildZip([
        { name: "[Content_Types].xml", content: contentTypesXml("word/document2.xml") },
        { name: "_rels/.rels", content: rootRelsXml("word/document2.xml") },
        {
          name: "word/document.xml",
          content: documentXml("<w:p><w:r><w:t>DECOY, never cited</w:t></w:r></w:p>"),
        },
        {
          name: "word/document2.xml",
          content: documentXml("<w:p><w:r><w:t>Real cited content</w:t></w:r></w:p>"),
        },
      ]),
    );
    const { representation, derivative } = await cleanExtraction(bytes);
    const text = Buffer.from(derivative).toString("utf8");
    expect(text).toBe("Real cited content");
    expect(text).not.toContain("DECOY");
    expect(docxLocator(representation.spans[0]!.locator).part).toBe("word/document2.xml");
  });

  it("refuses when _rels/.rels is missing", async () => {
    const bytes = new Uint8Array(
      buildZip([
        { name: "[Content_Types].xml", content: contentTypesXml() },
        { name: "word/document.xml", content: documentXml(SIMPLE_PARAGRAPH) },
      ]),
    );
    expect(diagnoseDocxPackage(bytes)).toEqual({
      ok: false,
      reasonCode: "root-relationships-missing",
    });
    await expect(cleanExtraction(bytes)).rejects.toThrowError(
      new SourceExtractionError("empty-extraction"),
    );
  });

  it("refuses when no officeDocument relationship is declared", () => {
    const bytes = new Uint8Array(
      buildZip([
        { name: "[Content_Types].xml", content: contentTypesXml() },
        { name: "_rels/.rels", content: rootRelsXml("word/document.xml", null) },
        { name: "word/document.xml", content: documentXml(SIMPLE_PARAGRAPH) },
      ]),
    );
    expect(diagnoseDocxPackage(bytes)).toEqual({
      ok: false,
      reasonCode: "main-relationship-missing",
    });
  });

  it("refuses when [Content_Types].xml does not declare the main document content type", async () => {
    const bytes = fullPackage({
      bodyInner: SIMPLE_PARAGRAPH,
      contentTypes: contentTypesXml("word/document.xml", "application/xml"),
    });
    expect(diagnoseDocxPackage(bytes)).toEqual({ ok: false, reasonCode: "content-type-mismatch" });
    await expect(cleanExtraction(bytes)).rejects.toThrowError(
      new SourceExtractionError("empty-extraction"),
    );
  });

  it("refuses when the officeDocument relationship target does not exist in the archive", () => {
    const bytes = new Uint8Array(
      buildZip([
        { name: "[Content_Types].xml", content: contentTypesXml() },
        { name: "_rels/.rels", content: rootRelsXml("word/does-not-exist.xml") },
      ]),
    );
    expect(diagnoseDocxPackage(bytes)).toEqual({ ok: false, reasonCode: "main-part-missing" });
  });

  it("refuses an officeDocument relationship marked TargetMode=External", async () => {
    // TargetMode="External" means Target is a URI outside the package, not
    // an internal part path. This adapter never fetches anything either
    // way, but an external target is never a valid main document part and
    // must not be treated as an internal one even if its string happens to
    // look like an internal path.
    const bytes = new Uint8Array(
      buildZip([
        { name: "[Content_Types].xml", content: contentTypesXml() },
        {
          name: "_rels/.rels",
          content: rootRelsXml("word/document.xml", OFFICE_DOCUMENT_REL_TYPE, "External"),
        },
        { name: "word/document.xml", content: documentXml(SIMPLE_PARAGRAPH) },
      ]),
    );
    expect(diagnoseDocxPackage(bytes)).toEqual({
      ok: false,
      reasonCode: "main-relationship-external",
    });
    await expect(cleanExtraction(bytes)).rejects.toThrowError(
      new SourceExtractionError("empty-extraction"),
    );
  });

  it("refuses an officeDocument relationship target that normalizes to an unsafe path", () => {
    const bytes = new Uint8Array(
      buildZip([
        { name: "[Content_Types].xml", content: contentTypesXml() },
        { name: "_rels/.rels", content: rootRelsXml("../evil.xml") },
      ]),
    );
    expect(diagnoseDocxPackage(bytes)).toEqual({ ok: false, reasonCode: "main-part-unsafe-path" });
  });

  it("refuses more than one officeDocument relationship", () => {
    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELATIONSHIPS_NS}"><Relationship Id="rId1" Type="${OFFICE_DOCUMENT_REL_TYPE}" Target="word/document.xml"/><Relationship Id="rId2" Type="${OFFICE_DOCUMENT_REL_TYPE}" Target="word/document2.xml"/></Relationships>`;
    const bytes = new Uint8Array(
      buildZip([
        { name: "[Content_Types].xml", content: contentTypesXml() },
        { name: "_rels/.rels", content: rels },
        { name: "word/document.xml", content: documentXml(SIMPLE_PARAGRAPH) },
        { name: "word/document2.xml", content: documentXml(SIMPLE_PARAGRAPH) },
      ]),
    );
    expect(diagnoseDocxPackage(bytes)).toEqual({
      ok: false,
      reasonCode: "main-relationship-ambiguous",
    });
  });

  it("refuses a _rels/.rels part that is not well-formed XML", () => {
    const bytes = new Uint8Array(
      buildZip([
        { name: "[Content_Types].xml", content: contentTypesXml() },
        { name: "_rels/.rels", content: "<Relationships><unclosed></Relationships>" },
        { name: "word/document.xml", content: documentXml(SIMPLE_PARAGRAPH) },
      ]),
    );
    expect(diagnoseDocxPackage(bytes)).toEqual({
      ok: false,
      reasonCode: "root-relationships-malformed",
    });
  });

  it("refuses a _rels/.rels entry that fails to decompress", () => {
    // A store-method entry whose declared uncompressed size disagrees with
    // its actual content length fails this adapter's own consistency check
    // (readEntryBytes), independent of any XML content.
    const bytes = new Uint8Array(
      buildZip([
        { name: "[Content_Types].xml", content: contentTypesXml() },
        {
          name: "_rels/.rels",
          content: rootRelsXml(),
          store: true,
          declaredUncompressedSize: 1,
        },
        { name: "word/document.xml", content: documentXml(SIMPLE_PARAGRAPH) },
      ]),
    );
    expect(diagnoseDocxPackage(bytes)).toEqual({
      ok: false,
      reasonCode: "root-relationships-unreadable",
    });
  });

  it("refuses when [Content_Types].xml is missing", () => {
    const bytes = new Uint8Array(
      buildZip([
        { name: "_rels/.rels", content: rootRelsXml() },
        { name: "word/document.xml", content: documentXml(SIMPLE_PARAGRAPH) },
      ]),
    );
    expect(diagnoseDocxPackage(bytes)).toEqual({ ok: false, reasonCode: "content-types-missing" });
  });

  it("refuses a [Content_Types].xml entry that fails to decompress", () => {
    const bytes = new Uint8Array(
      buildZip([
        {
          name: "[Content_Types].xml",
          content: contentTypesXml(),
          store: true,
          declaredUncompressedSize: 1,
        },
        { name: "_rels/.rels", content: rootRelsXml() },
        { name: "word/document.xml", content: documentXml(SIMPLE_PARAGRAPH) },
      ]),
    );
    expect(diagnoseDocxPackage(bytes)).toEqual({
      ok: false,
      reasonCode: "content-types-unreadable",
    });
  });

  it("refuses a [Content_Types].xml part that is not well-formed XML", () => {
    const bytes = new Uint8Array(
      buildZip([
        { name: "[Content_Types].xml", content: "<Types><unclosed></Types>" },
        { name: "_rels/.rels", content: rootRelsXml() },
        { name: "word/document.xml", content: documentXml(SIMPLE_PARAGRAPH) },
      ]),
    );
    expect(diagnoseDocxPackage(bytes)).toEqual({
      ok: false,
      reasonCode: "content-types-malformed",
    });
  });

  it("refuses a ZIP64 archive", () => {
    // ZIP64 is signalled by the 0xffff sentinel in the EOCD's total-entries
    // field (or 0xffffffff in the central-directory offset/size fields);
    // this adapter refuses it outright rather than implementing zip64.
    const valid = Buffer.from(docxBytes(SIMPLE_PARAGRAPH));
    const corrupted = Buffer.from(valid);
    // EOCD is the last 22 bytes (no archive comment); total-entries is a
    // 2-byte field at offset 10 within it.
    corrupted.writeUInt16LE(0xffff, corrupted.length - 22 + 10);
    expect(diagnoseDocxPackage(new Uint8Array(corrupted))).toEqual({
      ok: false,
      reasonCode: "zip64-unsupported",
    });
  });
});

describe("DOCX archive-abuse and malformed-input refusals", () => {
  it("refuses an encrypted archive entry", async () => {
    const bytes = docxBytes(SIMPLE_PARAGRAPH);
    const encryptedZip = new Uint8Array(
      buildZip([
        { name: "[Content_Types].xml", content: contentTypesXml() },
        { name: "_rels/.rels", content: rootRelsXml() },
        {
          name: "word/document.xml",
          content: documentXml(SIMPLE_PARAGRAPH),
          generalPurposeFlag: ENCRYPTED_GENERAL_PURPOSE_FLAG,
        },
      ]),
    );
    // Positive control: the same content, unencrypted, extracts fine.
    expect((await cleanExtraction(bytes)).representation.spans.length).toBeGreaterThan(0);
    expect(diagnoseDocxPackage(encryptedZip)).toEqual({ ok: false, reasonCode: "encrypted" });
    await expect(cleanExtraction(encryptedZip)).rejects.toThrowError(
      new SourceExtractionError("empty-extraction"),
    );
  });

  it("refuses a package containing a macro part", async () => {
    const macroDocx = fullPackage({
      bodyInner: SIMPLE_PARAGRAPH,
      extraEntries: [{ name: "word/vbaProject.bin", content: "fake macro bytes" }],
    });
    expect(diagnoseDocxPackage(macroDocx)).toEqual({ ok: false, reasonCode: "macro-enabled" });
    await expect(cleanExtraction(macroDocx)).rejects.toThrowError(
      new SourceExtractionError("empty-extraction"),
    );
  });

  it("refuses a zip that has no main document part", async () => {
    const notDocx = new Uint8Array(buildZip([{ name: "readme.txt", content: "not a docx" }]));
    expect(diagnoseDocxPackage(notDocx)).toEqual({
      ok: false,
      reasonCode: "root-relationships-missing",
    });
    await expect(cleanExtraction(notDocx)).rejects.toThrowError(
      new SourceExtractionError("empty-extraction"),
    );
  });

  it("refuses bytes that are not a zip archive at all", async () => {
    const garbage = new TextEncoder().encode(
      "this is not a zip file at all, just plain text bytes",
    );
    expect(diagnoseDocxPackage(garbage)).toEqual({ ok: false, reasonCode: "eocd-not-found" });
    await expect(cleanExtraction(garbage)).rejects.toThrowError(
      new SourceExtractionError("empty-extraction"),
    );
  });

  it("refuses a central directory that points past the end of the buffer", async () => {
    const valid = Buffer.from(docxBytes(SIMPLE_PARAGRAPH));
    const corrupted = Buffer.from(valid);
    // The EOCD record is the last 22 bytes (no archive comment was written).
    // Corrupt its central-directory-offset field so it names an offset the
    // buffer does not contain.
    corrupted.writeUInt32LE(0xfffffffe, corrupted.length - 6);
    expect(diagnoseDocxPackage(new Uint8Array(corrupted))).toEqual({
      ok: false,
      reasonCode: "central-directory-malformed",
    });
    await expect(cleanExtraction(new Uint8Array(corrupted))).rejects.toThrowError(
      new SourceExtractionError("empty-extraction"),
    );
  });

  it("refuses a document part declaring a DOCTYPE", async () => {
    const bytes = new Uint8Array(
      buildZip([
        { name: "[Content_Types].xml", content: contentTypesXml() },
        { name: "_rels/.rels", content: rootRelsXml() },
        {
          name: "word/document.xml",
          content: `<?xml version="1.0"?><!DOCTYPE w:document><w:document xmlns:w="${WORDPROCESSINGML_NS}"><w:body>${SIMPLE_PARAGRAPH}</w:body></w:document>`,
        },
      ]),
    );
    // Package-level resolution (rels/content-types/zip) succeeds; the DOCTYPE
    // is only in the main document part's own XML, parsed later by extract().
    expect(diagnoseDocxPackage(bytes)).toEqual({ ok: true, documentPart: "word/document.xml" });
    await expect(cleanExtraction(bytes)).rejects.toThrowError(
      new SourceExtractionError("empty-extraction"),
    );
  });

  it("refuses a document part declaring an external entity", async () => {
    const bytes = new Uint8Array(
      buildZip([
        { name: "[Content_Types].xml", content: contentTypesXml() },
        { name: "_rels/.rels", content: rootRelsXml() },
        {
          name: "word/document.xml",
          content: `<?xml version="1.0"?><!ENTITY xxe SYSTEM "file:///etc/passwd"><w:document xmlns:w="${WORDPROCESSINGML_NS}"><w:body>${SIMPLE_PARAGRAPH}</w:body></w:document>`,
        },
      ]),
    );
    await expect(cleanExtraction(bytes)).rejects.toThrowError(
      new SourceExtractionError("empty-extraction"),
    );
  });

  it("refuses a traversal path outside the package", async () => {
    const traversal = docxBytes(SIMPLE_PARAGRAPH, [{ name: "../evil.txt", content: "escape" }]);
    expect(diagnoseDocxPackage(traversal)).toEqual({ ok: false, reasonCode: "unsafe-path" });
    await expect(cleanExtraction(traversal)).rejects.toThrowError(
      new SourceExtractionError("empty-extraction"),
    );
  });

  it("refuses an absolute part path", async () => {
    const absolute = docxBytes(SIMPLE_PARAGRAPH, [{ name: "/etc/passwd", content: "escape" }]);
    expect(diagnoseDocxPackage(absolute)).toEqual({ ok: false, reasonCode: "unsafe-path" });
    await expect(cleanExtraction(absolute)).rejects.toThrowError(
      new SourceExtractionError("empty-extraction"),
    );
  });

  it("refuses a symlink archive entry", async () => {
    const symlinked = docxBytes(SIMPLE_PARAGRAPH, [
      { name: "word/evil-link", content: "x", externalAttrs: SYMLINK_EXTERNAL_ATTRS },
    ]);
    expect(diagnoseDocxPackage(symlinked)).toEqual({ ok: false, reasonCode: "symlink" });
    await expect(cleanExtraction(symlinked)).rejects.toThrowError(
      new SourceExtractionError("empty-extraction"),
    );
  });

  it("refuses duplicate part names", async () => {
    const duplicated = new Uint8Array(
      buildZip([
        { name: "[Content_Types].xml", content: contentTypesXml() },
        { name: "_rels/.rels", content: rootRelsXml() },
        { name: "word/document.xml", content: documentXml(SIMPLE_PARAGRAPH) },
        { name: "word/document.xml", content: documentXml(SIMPLE_PARAGRAPH) },
      ]),
    );
    expect(diagnoseDocxPackage(duplicated)).toEqual({ ok: false, reasonCode: "duplicate-part" });
    await expect(cleanExtraction(duplicated)).rejects.toThrowError(
      new SourceExtractionError("empty-extraction"),
    );
  });

  it("refuses a case-variant duplicate part name", () => {
    const bytes = new Uint8Array(
      buildZip([
        { name: "[Content_Types].xml", content: contentTypesXml() },
        { name: "_rels/.rels", content: rootRelsXml() },
        { name: "word/document.xml", content: documentXml(SIMPLE_PARAGRAPH) },
        { name: "Word/Document.xml", content: documentXml(SIMPLE_PARAGRAPH) },
      ]),
    );
    expect(diagnoseDocxPackage(bytes)).toEqual({ ok: false, reasonCode: "duplicate-part" });
  });

  it("refuses an entry whose local header name disagrees with the central directory", () => {
    const bytes = new Uint8Array(
      buildZip([
        { name: "[Content_Types].xml", content: contentTypesXml() },
        { name: "_rels/.rels", content: rootRelsXml() },
        {
          name: "word/document.xml",
          content: documentXml(SIMPLE_PARAGRAPH),
          localNameOverride: "word/something-else.xml",
        },
      ]),
    );
    expect(diagnoseDocxPackage(bytes)).toEqual({ ok: false, reasonCode: "expansion-failed" });
  });

  it("refuses an archive with more entries than the configured cap", async () => {
    const manyEntries = docxBytes(SIMPLE_PARAGRAPH, [
      { name: "word/extra-1.xml", content: "<x/>" },
      { name: "word/extra-2.xml", content: "<x/>" },
    ]);
    // Positive control: the same bytes, under the default cap, extract fine.
    expect((await cleanExtraction(manyEntries)).representation.spans.length).toBeGreaterThan(0);
    expect(diagnoseDocxPackage(manyEntries, { maxArchiveEntries: 2 })).toEqual({
      ok: false,
      reasonCode: "too-many-entries",
    });
    await expect(
      extractSourceRepresentation({
        adapter: docxSourceExtractorAdapter,
        bytes: manyEntries,
        mediaType: DOCX_MEDIA_TYPE,
        options: { maxArchiveEntries: 2 },
      }),
    ).rejects.toThrowError(new SourceExtractionError("empty-extraction"));
  });

  it("refuses a document part whose declared expansion exceeds the configured cap", async () => {
    const longParagraph = `<w:p><w:r><w:t>${"x".repeat(500)}</w:t></w:r></w:p>`;
    const bytes = docxBytes(longParagraph);
    // Positive control: the same bytes, under the default cap, extract fine.
    expect((await cleanExtraction(bytes)).representation.spans.length).toBeGreaterThan(0);
    // The budget applies uniformly to every part this adapter reads. 500
    // bytes comfortably fits [Content_Types].xml and _rels/.rels (a few
    // hundred bytes each) but not the ~700-byte long-paragraph document part.
    expect(diagnoseDocxPackage(bytes, { maxExpandedBytes: 500 })).toEqual({
      ok: false,
      reasonCode: "expansion-failed",
    });
    await expect(
      extractSourceRepresentation({
        adapter: docxSourceExtractorAdapter,
        bytes,
        mediaType: DOCX_MEDIA_TYPE,
        options: { maxExpandedBytes: 500 },
      }),
    ).rejects.toThrowError(new SourceExtractionError("empty-extraction"));
  });

  it("refuses an entry whose declared size is honest-looking but whose real inflated output exceeds the cap (maxOutputLength, not the pre-check, is the actual bound)", async () => {
    // The declared uncompressedSize field is false: it claims a small size
    // that passes the pre-check (`entry.uncompressedSize > maxExpandedBytes`
    // is false), while the actual DEFLATE stream, honestly decompressed,
    // produces far more bytes than declared. Only the decompressor's own
    // `maxOutputLength` bound (plus this module's post-decompression size
    // check) catches this; the declared-size pre-check cannot, because it
    // was never given the truth.
    const realContent = documentXml(`<w:p><w:r><w:t>${"A".repeat(200_000)}</w:t></w:r></w:p>`);
    const bytes = new Uint8Array(
      buildZip([
        { name: "[Content_Types].xml", content: contentTypesXml() },
        { name: "_rels/.rels", content: rootRelsXml() },
        {
          name: "word/document.xml",
          content: realContent,
          declaredUncompressedSize: 10,
        },
      ]),
    );
    expect(diagnoseDocxPackage(bytes, { maxExpandedBytes: 1_000 })).toEqual({
      ok: false,
      reasonCode: "expansion-failed",
    });
    await expect(
      extractSourceRepresentation({
        adapter: docxSourceExtractorAdapter,
        bytes,
        mediaType: DOCX_MEDIA_TYPE,
        options: { maxExpandedBytes: 1_000 },
      }),
    ).rejects.toThrowError(new SourceExtractionError("empty-extraction"));
  });

  it("passes maxOutputLength equal to the configured cap to every inflateRawSync call", async () => {
    // Observes the protective mechanism directly, not just its effect: without
    // maxOutputLength the post-decompression check still rejects the result,
    // but only after the full oversized buffer is materialized. This fails if
    // the option is dropped or given the wrong value.
    const mockInflate = vi.mocked(nodeZlib.inflateRawSync);
    mockInflate.mockClear();
    const bytes = docxBytes(SIMPLE_PARAGRAPH);
    const cap = 12_345;
    await extractSourceRepresentation({
      adapter: docxSourceExtractorAdapter,
      bytes,
      mediaType: DOCX_MEDIA_TYPE,
      options: { maxExpandedBytes: cap },
    });
    expect(mockInflate).toHaveBeenCalled();
    for (const call of mockInflate.mock.calls) {
      expect(call[1]).toMatchObject({ maxOutputLength: cap });
    }
  });

  it("refuses XML nested deeper than the configured depth cap", async () => {
    const open = "<w:sdt>".repeat(10);
    const close = "</w:sdt>".repeat(10);
    // Nest inside the run, not around the paragraph: the paragraph must stay
    // a direct child of `w:body` so this exercises the XML parser's depth
    // cap specifically, not the unrelated block-structure requirement that a
    // paragraph block is a direct body child.
    const deep = docxBytes(`<w:p><w:r>${open}<w:t>Hello world</w:t>${close}</w:r></w:p>`);
    // Positive control: the same bytes, under the default cap, extract fine.
    expect((await cleanExtraction(deep)).representation.spans.length).toBeGreaterThan(0);
    // Package-level resolution (rels/content-types are shallow) succeeds; the
    // depth violation is inside the main document part's own XML, which
    // diagnoseDocxPackage does not parse -- only extract() does.
    expect(diagnoseDocxPackage(deep, { maxXmlDepth: 5 })).toEqual({
      ok: true,
      documentPart: "word/document.xml",
    });
    await expect(
      extractSourceRepresentation({
        adapter: docxSourceExtractorAdapter,
        bytes: deep,
        mediaType: DOCX_MEDIA_TYPE,
        options: { maxXmlDepth: 5 },
      }),
    ).rejects.toThrowError(new SourceExtractionError("empty-extraction"));
  });

  it("refuses XML with more nodes than the configured node cap", async () => {
    await expect(
      extractSourceRepresentation({
        adapter: docxSourceExtractorAdapter,
        bytes: BASIC,
        mediaType: DOCX_MEDIA_TYPE,
        options: { maxXmlNodes: 3 },
      }),
    ).rejects.toThrowError(new SourceExtractionError("empty-extraction"));
  });
});

describe("DOCX partial extraction and honest limitations", () => {
  it("excludes inline media and names the limitation without losing sibling text", async () => {
    const bytes = docxBytes("<w:p><w:r><w:t>Caption text</w:t></w:r><w:r><w:drawing/></w:r></w:p>");
    const { representation, derivative } = await cleanExtraction(bytes);
    const text = Buffer.from(derivative).toString("utf8");
    expect(text).toBe("Caption text");
    expect(representation.limitations).toContain("non-text-content-excluded");
  });

  it("excludes deleted and moved-from revision text (realistic w:delText) but includes inserted and moved-to text", async () => {
    const bytes = docxBytes(
      "<w:p>" +
        "<w:del><w:r><w:delText>deleted and excluded</w:delText></w:r></w:del>" +
        "<w:moveFrom><w:r><w:t>moved away and excluded</w:t></w:r></w:moveFrom>" +
        "<w:ins><w:r><w:t>inserted and kept</w:t></w:r></w:ins>" +
        "<w:moveTo><w:r><w:t> moved here and kept</w:t></w:r></w:moveTo>" +
        "</w:p>",
    );
    const { representation, derivative } = await cleanExtraction(bytes);
    const text = Buffer.from(derivative).toString("utf8");
    expect(text).toBe("inserted and kept moved here and kept");
    expect(text).not.toContain("deleted");
    expect(text).not.toContain("moved away");
    expect(representation.limitations).toContain("unsupported-structure");
  });

  it("excludes w:del content by its own element identity, not by delText/t naming", async () => {
    // Real producers wrap deleted text in `w:delText`, which this adapter's
    // text collector never matches anyway (only `w:t` is read), so a del
    // block using `w:delText` would be excluded even without an explicit
    // `w:del` check. This test removes that structural coincidence: it puts
    // an ordinary `w:t` inside `w:del`, so exclusion can only come from the
    // explicit REVISION_EXCLUDED_LOCALS membership, proving that check is
    // actually load-bearing rather than redundant with the tag-name gap.
    const bytes = docxBytes(
      "<w:p><w:del><w:r><w:t>should still be excluded</w:t></w:r></w:del><w:r><w:t>kept</w:t></w:r></w:p>",
    );
    const { representation, derivative } = await cleanExtraction(bytes);
    const text = Buffer.from(derivative).toString("utf8");
    expect(text).toBe("kept");
    expect(text).not.toContain("should still be excluded");
    expect(representation.limitations).toContain("unsupported-structure");
  });

  it("refuses a locally mismatched tag rather than recovering into it", async () => {
    // `fast-xml-parser`'s own `parse` step, left unchecked, is forgiving of
    // this exact malformation: the stray `</w:r>` (no matching open `<w:r>`
    // at this point) pops the current element regardless of name, so the
    // second, otherwise-empty `<w:p>` closes early and the following
    // `<w:r>...</w:r>` lands as a `w:body` sibling rather than raising an
    // error. `XMLValidator.validate`, run before `parse`, catches this
    // well-formedness violation and refuses the whole document instead.
    const bytes = docxBytes(
      "<w:p><w:r><w:t>Good paragraph</w:t></w:r></w:p><w:p></w:r><w:r><w:t>Orphaned by the mismatch</w:t></w:r></w:p>",
    );
    await expect(cleanExtraction(bytes)).rejects.toThrowError(
      new SourceExtractionError("empty-extraction"),
    );
  });

  it("refuses a missing run close tag rather than fabricating one span across three paragraphs", async () => {
    // Without a well-formedness gate, a missing `</w:r>` in the first paragraph makes
    // `fast-xml-parser` nest the following two `<w:p>` elements as
    // descendants of the still-open first one. This module's own generic-
    // container recursion (needed for legitimate wrappers like
    // `w:hyperlink`) then walks straight into them, concatenating three
    // unrelated paragraphs' text into a single fabricated span at
    // `blockPath: [0]` with `completeness: "complete"` and no limitation --
    // provenance an attacker could aim at any block. `XMLValidator.validate`
    // refuses the whole document instead of merging anything.
    const bytes = docxBytes(
      "<w:p><w:r><w:t>ALPHA</w:t></w:p>" +
        "<w:p><w:r><w:t>BRAVO</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>CHARLIE</w:t></w:r></w:p>",
    );
    await expect(cleanExtraction(bytes)).rejects.toThrowError(
      new SourceExtractionError("empty-extraction"),
    );
  });

  it("refuses a well-formed but schema-invalid nested w:p rather than fabricating one span", async () => {
    // The well-formedness gate above (`XMLValidator.validate`) catches a
    // missing close tag, but cannot catch a `<w:p>` nested directly inside
    // another `<w:p>`, which WordprocessingML's schema forbids but XML itself
    // allows. `collectParagraphText` recurses only into known inline
    // containers, so a nested `w:p` is flagged and skipped rather than merged
    // into one span at the outer paragraph's locator.
    const bytes = docxBytes(
      "<w:p><w:r><w:t>ALPHA</w:t></w:r>" +
        "<w:p><w:r><w:t>BRAVO</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>CHARLIE</w:t></w:r></w:p>" +
        "</w:p>",
    );
    const { representation, derivative } = await cleanExtraction(bytes);
    expect(representation.spans).toHaveLength(1);
    const text = Buffer.from(derivative).toString("utf8");
    expect(text).toBe("ALPHA");
    expect(text).not.toContain("BRAVO");
    expect(text).not.toContain("CHARLIE");
    expect(representation.completeness).toBe("partial");
    expect(representation.limitations).toContain("unsupported-structure");
  });

  it("refuses text through an unrecognized container (w:customXml) wrapping a nested w:p", async () => {
    // Same class of defect, a different concrete container: any unrecognized
    // element, not only a bare nested `w:p`, must never be assumed safe to
    // recurse into.
    const bytes = docxBytes(
      "<w:p><w:r><w:t>Before</w:t></w:r>" +
        "<w:customXml><w:p><w:r><w:t>Hidden</w:t></w:r></w:p></w:customXml>" +
        "<w:r><w:t>After</w:t></w:r></w:p>",
    );
    const { representation, derivative } = await cleanExtraction(bytes);
    const text = Buffer.from(derivative).toString("utf8");
    expect(text).toBe("BeforeAfter");
    expect(text).not.toContain("Hidden");
    expect(representation.limitations).toContain("unsupported-structure");
  });

  it("extracts text through an inline content control (w:sdt/w:sdtContent) inside a paragraph", async () => {
    const bytes = docxBytes(
      "<w:p><w:r><w:t>Before </w:t></w:r>" +
        '<w:sdt><w:sdtPr><w:alias w:val="x"/></w:sdtPr>' +
        "<w:sdtContent><w:r><w:t>SDT text</w:t></w:r></w:sdtContent></w:sdt>" +
        "<w:r><w:t> After</w:t></w:r></w:p>",
    );
    const { representation, derivative } = await cleanExtraction(bytes);
    const text = Buffer.from(derivative).toString("utf8");
    expect(text).toBe("Before SDT text After");
    expect(representation.completeness).toBe("complete");
    expect(representation.limitations).toEqual([]);
  });

  it("flags a body-level content control (w:sdt) without extracting or fabricating its contained paragraph", async () => {
    // Known debt (see the contract doc): a block-level w:sdt's sdtContent
    // is never opened, so a content control wrapping a whole paragraph loses
    // that paragraph's text entirely -- but honestly (flagged, and never
    // merged into a neighboring block), not fabricated into the wrong place.
    const bytes = docxBytes(
      "<w:p><w:r><w:t>Before</w:t></w:r></w:p>" +
        '<w:sdt><w:sdtPr><w:alias w:val="x"/></w:sdtPr>' +
        "<w:sdtContent><w:p><w:r><w:t>Inside SDT</w:t></w:r></w:p></w:sdtContent></w:sdt>" +
        "<w:p><w:r><w:t>After</w:t></w:r></w:p>",
    );
    const { representation, derivative } = await cleanExtraction(bytes);
    expect(representation.spans).toHaveLength(2);
    const text = Buffer.from(derivative).toString("utf8");
    expect(text).toContain("Before");
    expect(text).toContain("After");
    expect(text).not.toContain("Inside SDT");
    expect(representation.limitations).toContain("unsupported-structure");
    // Not a block: must not shift the second paragraph's ordinal.
    const ordinals = representation.spans.map((span) => docxLocator(span.locator).paragraphOrdinal);
    expect(ordinals).toEqual([0, 1]);
  });

  it("names an omitted story without losing the body text", async () => {
    const withFootnotes = docxBytes(SIMPLE_PARAGRAPH, [
      { name: "word/footnotes.xml", content: "<w:footnotes/>" },
    ]);
    // Positive control: the same body, with no story part, is complete.
    expect((await cleanExtraction(docxBytes(SIMPLE_PARAGRAPH))).representation.completeness).toBe(
      "complete",
    );
    const { representation, derivative } = await cleanExtraction(withFootnotes);
    expect(Buffer.from(derivative).toString("utf8")).toBe("Hello world");
    expect(representation.completeness).toBe("partial");
    expect(representation.limitations).toContain("unsupported-structure");
  });

  it("excludes a hidden (vanish) run but keeps sibling visible text", async () => {
    const bytes = docxBytes(
      "<w:p>" +
        "<w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden text</w:t></w:r>" +
        "<w:r><w:t>visible text</w:t></w:r>" +
        "</w:p>",
    );
    const { representation, derivative } = await cleanExtraction(bytes);
    const text = Buffer.from(derivative).toString("utf8");
    expect(text).toBe("visible text");
    expect(text).not.toContain("hidden");
    expect(representation.limitations).toContain("hidden-content-excluded");
  });

  it("honours CT_OnOff w:val on w:vanish: false/0/off mean visible, not hidden", async () => {
    // A bare `<w:vanish/>` (no w:val) means hidden, tested above. Per
    // ECMA-376's CT_OnOff, `w:val="false"` (and "0", "off") explicitly turn
    // the property off -- the run must stay visible, not hidden merely
    // because a `w:vanish` element is present at all.
    const bytes = docxBytes(
      "<w:p>" +
        '<w:r><w:rPr><w:vanish w:val="false"/></w:rPr><w:t>still visible</w:t></w:r>' +
        '<w:r><w:rPr><w:vanish w:val="0"/></w:rPr><w:t>also visible</w:t></w:r>' +
        '<w:r><w:rPr><w:vanish w:val="off"/></w:rPr><w:t>visible too</w:t></w:r>' +
        "</w:p>",
    );
    const { representation, derivative } = await cleanExtraction(bytes);
    const text = Buffer.from(derivative).toString("utf8");
    expect(text).toBe("still visiblealso visiblevisible too");
    expect(representation.limitations).not.toContain("hidden-content-excluded");
  });

  it("flags a foreign-namespace element (e.g. mc:AlternateContent) instead of silently losing its text", async () => {
    // Word routinely wraps modern content (often drawings/shapes) in
    // mc:AlternateContent for backward compatibility. This adapter never
    // resolves markup-compatibility fallback semantics; the whole element is
    // skipped, and that incompleteness is named rather than silently
    // absorbed.
    const bytes = docxBytes(
      "<w:p><w:r><w:t>Before</w:t></w:r>" +
        '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
        "<mc:Choice><w:t>should not appear</w:t></mc:Choice>" +
        "</mc:AlternateContent>" +
        "<w:r><w:t>After</w:t></w:r></w:p>",
    );
    const { representation, derivative } = await cleanExtraction(bytes);
    const text = Buffer.from(derivative).toString("utf8");
    expect(text).toBe("BeforeAfter");
    expect(text).not.toContain("should not appear");
    expect(representation.limitations).toContain("unsupported-structure");
  });

  it("flags a foreign-namespace element directly under w:body", async () => {
    const bytes = docxBytes(
      "<w:p><w:r><w:t>Before</w:t></w:r></w:p>" +
        '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
        "<mc:Fallback/>" +
        "</mc:AlternateContent>" +
        "<w:p><w:r><w:t>After</w:t></w:r></w:p>",
    );
    const { representation, derivative } = await cleanExtraction(bytes);
    const text = Buffer.from(derivative).toString("utf8");
    expect(text).toContain("Before");
    expect(text).toContain("After");
    expect(representation.limitations).toContain("unsupported-structure");
    // Not a block: must not shift the second paragraph's ordinal.
    const ordinals = representation.spans.map((span) => docxLocator(span.locator).paragraphOrdinal);
    expect(ordinals).toEqual([0, 1]);
  });

  it("takes CDATA content literally, never entity-decoded", async () => {
    const bytes = docxBytes(
      "<w:p><w:r><w:t><![CDATA[literal &amp; not decoded, and a < sign]]></w:t></w:r></w:p>",
    );
    const { derivative } = await cleanExtraction(bytes);
    const text = Buffer.from(derivative).toString("utf8");
    expect(text).toBe("literal &amp; not decoded, and a < sign");
  });

  it("flags an embedded altChunk part without opening it", async () => {
    const bytes = docxBytes(
      '<w:p><w:r><w:t>Before</w:t></w:r></w:p><w:altChunk r:id="rId9"/><w:p><w:r><w:t>After</w:t></w:r></w:p>',
    );
    const { representation, derivative } = await cleanExtraction(bytes);
    const text = Buffer.from(derivative).toString("utf8");
    expect(text).toContain("Before");
    expect(text).toContain("After");
    expect(representation.limitations).toContain("unsupported-structure");
    // altChunk is not a block: it must not shift the second paragraph's ordinal.
    const ordinals = representation.spans.map((span) => docxLocator(span.locator).paragraphOrdinal);
    expect(ordinals).toEqual([0, 1]);
  });

  it("flags a table nested inside a cell without silently dropping the limitation", async () => {
    const bytes = docxBytes(
      "<w:tbl><w:tr><w:tc>" +
        "<w:p><w:r><w:t>Outer cell text</w:t></w:r></w:p>" +
        "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Nested cell text</w:t></w:r></w:p></w:tc></w:tr></w:tbl>" +
        "</w:tc></w:tr></w:tbl>",
    );
    const { representation, derivative } = await cleanExtraction(bytes);
    const text = Buffer.from(derivative).toString("utf8");
    expect(text).toContain("Outer cell text");
    expect(text).not.toContain("Nested cell text");
    expect(representation.completeness).toBe("partial");
    expect(representation.limitations).toContain("unsupported-structure");
  });

  it("flags a table row wrapped in a content control instead of silently dropping it", async () => {
    // Schema-valid ECMA-376 content (a block-level w:sdt can wrap one or
    // more w:tr), but this adapter's table walk only looks at w:tbl's
    // *direct* w:tr children, so the wrapped row must be flagged rather than
    // silently lost under completeness "complete".
    const bytes = docxBytes(
      "<w:tbl>" +
        "<w:tr><w:tc><w:p><w:r><w:t>Normal Row Cell</w:t></w:r></w:p></w:tc></w:tr>" +
        '<w:sdt><w:sdtPr><w:alias w:val="x"/></w:sdtPr><w:sdtContent>' +
        "<w:tr><w:tc><w:p><w:r><w:t>Hidden Row Cell</w:t></w:r></w:p></w:tc></w:tr>" +
        "</w:sdtContent></w:sdt>" +
        "</w:tbl>",
    );
    const { representation, derivative } = await cleanExtraction(bytes);
    const text = Buffer.from(derivative).toString("utf8");
    expect(text).toContain("Normal Row Cell");
    expect(text).not.toContain("Hidden Row Cell");
    expect(representation.completeness).toBe("partial");
    expect(representation.limitations).toContain("unsupported-structure");
  });

  it("flags a table cell wrapped in a content control instead of silently dropping it", async () => {
    const bytes = docxBytes(
      "<w:tbl><w:tr>" +
        "<w:tc><w:p><w:r><w:t>Normal Cell</w:t></w:r></w:p></w:tc>" +
        '<w:sdt><w:sdtPr><w:alias w:val="x"/></w:sdtPr>' +
        "<w:tc><w:p><w:r><w:t>Hidden Cell</w:t></w:r></w:p></w:tc>" +
        "</w:sdt>" +
        "</w:tr></w:tbl>",
    );
    const { representation, derivative } = await cleanExtraction(bytes);
    const text = Buffer.from(derivative).toString("utf8");
    expect(text).toContain("Normal Cell");
    expect(text).not.toContain("Hidden Cell");
    expect(representation.completeness).toBe("partial");
    expect(representation.limitations).toContain("unsupported-structure");
  });

  it("flags a cell paragraph wrapped in w:customXml instead of silently dropping it", async () => {
    const bytes = docxBytes(
      "<w:tbl><w:tr><w:tc>" +
        "<w:p><w:r><w:t>Normal Cell Text</w:t></w:r></w:p>" +
        "<w:customXml><w:p><w:r><w:t>Hidden In CustomXml</w:t></w:r></w:p></w:customXml>" +
        "</w:tc></w:tr></w:tbl>",
    );
    const { representation, derivative } = await cleanExtraction(bytes);
    const text = Buffer.from(derivative).toString("utf8");
    expect(text).toContain("Normal Cell Text");
    expect(text).not.toContain("Hidden In CustomXml");
    expect(representation.completeness).toBe("partial");
    expect(representation.limitations).toContain("unsupported-structure");
  });

  it("still silently skips ordinary table metadata (tblPr/tblGrid/trPr/tcPr)", async () => {
    // Positive control for the three tests above: legitimate table metadata
    // must not be flagged just because it is not a tr/tc/p.
    const bytes = docxBytes(
      "<w:tbl>" +
        '<w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>' +
        '<w:tblGrid><w:gridCol w:w="100"/></w:tblGrid>' +
        "<w:tr><w:trPr/><w:tc><w:tcPr/><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr>" +
        "</w:tbl>",
    );
    const { representation, derivative } = await cleanExtraction(bytes);
    const text = Buffer.from(derivative).toString("utf8");
    expect(text).toBe("Cell");
    expect(representation.completeness).toBe("complete");
    expect(representation.limitations).toEqual([]);
  });

  it("falls back on a non-UTF-8 document part and names the limitation", async () => {
    const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x00, 0x00]);
    const bytes = new Uint8Array(
      buildZip([
        { name: "[Content_Types].xml", content: contentTypesXml() },
        { name: "_rels/.rels", content: rootRelsXml() },
        { name: "word/document.xml", content: invalidUtf8, store: true },
      ]),
    );
    await expect(cleanExtraction(bytes)).rejects.toThrowError(
      new SourceExtractionError("empty-extraction"),
    );
  });
});

describe("DOCX adapter inertness", () => {
  it("imports nothing from fs, subprocess, network, or vm capability", () => {
    const source = readFileSync(new URL("../src/inputs/adapters/docx.ts", import.meta.url), "utf8");
    for (const forbidden of [
      "node:fs",
      "node:child_process",
      "node:net",
      "node:http",
      "node:https",
      "node:dgram",
      "node:tls",
      "node:vm",
    ]) {
      expect(source.includes(`"${forbidden}`) || source.includes(`'${forbidden}`)).toBe(false);
    }
    expect(source).not.toMatch(/\beval\s*\(/u);
    expect(source).not.toMatch(/new\s+Function\s*\(/u);
  });

  it("never imports the XMLBuilder half of the pinned dependency", () => {
    const source = readFileSync(new URL("../src/inputs/adapters/docx.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bXMLBuilder\b/u);
    expect(source).not.toMatch(/\baddEntity\b/u);
  });

  it("declares no external entity resolution and no DTD loading", () => {
    expect(DOCX_XML_SECURITY_POLICY.resolveExternalEntities).toBe(false);
    expect(DOCX_XML_SECURITY_POLICY.loadExternalDtd).toBe(false);
  });

  it("never throws from garbage bytes, even calling the adapter directly", async () => {
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd, 0x50, 0x4b]);
    const result = await docxSourceExtractorAdapter.extract({
      bytes: garbage,
      options: docxSourceExtractorAdapter.defaultOptions,
      limits: DEFAULT_SOURCE_EXTRACTION_LIMITS,
    });
    expect(result.segments).toEqual([]);
  });
});

/**
 * The generic binding → reader → span access → citation →
 * `SourceEvidenceFinalV1` chain with DOCX swapped in for HTML. The adapter is
 * resolved from the shipped default registry, so a registration miss fails
 * here instead of a direct-import extraction test.
 */
describe("integration: registry to a cited DOCX span", () => {
  const RUN_ID = "run-838-docx-integration";
  const REVISION = "d".repeat(40);
  const REPOSITORY_IDENTITY = createHash("sha256").update("/workspace/docsfab").digest("hex");
  const WORKSPACE_IDENTITY = createHash("sha256").update("workspace-identity-838").digest("hex");
  const TREE_DIGEST = createHash("sha256").update("tree-838").digest("hex");
  const CONTENT_DIGEST = createHash("sha256")
    .update(`content-838:${REPOSITORY_IDENTITY}:${REVISION}:${TREE_DIGEST}`)
    .digest("hex");
  const PRODUCER_ID = "workspace-tracked-files";
  const PRODUCER_SCOPE = createHash("sha256").update("tracked-files-scope").digest("hex");
  const PRODUCER_SCOPES = [{ producerId: PRODUCER_ID, scopeSha256: PRODUCER_SCOPE }];
  const POLICY = createSourceStepPolicy({
    sourceReadSkills: ["write-documentation", "verify-technical-accuracy"],
    perStepBudgetBytes: 8 * 1024,
  });
  const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const OBSERVATION_ID = "obs-release-notes-docx";
  const HEADING_TEXT = "Release Notes";
  const LIST_TEXT = "First bullet item";
  const REGISTRY = createDefaultSourceExtractorRegistry();
  const PARTIAL_BYTES = docxBytes(
    "<w:p>" +
      "<w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden text</w:t></w:r>" +
      "<w:r><w:t>visible heading</w:t></w:r>" +
      "</w:p>",
    [{ name: "word/footnotes.xml", content: "<w:footnotes/>" }],
  );

  async function buildDocxChain(
    options: { bytes?: Uint8Array; observationId?: string; repositoryPath?: string } = {},
  ) {
    const bytes = options.bytes ?? BASIC;
    const observationId = options.observationId ?? OBSERVATION_ID;
    const repositoryPath = options.repositoryPath ?? "docs/release-notes.docx";
    const requestSha256 = projectSourceRequestContext(
      {
        workflow: "create-documentation",
        workspacePath: "/workspace/docsfab",
        repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
        allowWrite: false,
        instruction: "Document the Word release notes.",
      },
      {
        runId: RUN_ID,
        workspaceIdentitySha256: WORKSPACE_IDENTITY,
        repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
      },
    );

    const adapter = REGISTRY.resolve(DOCX_MEDIA_TYPE);
    if (!adapter) throw new Error("the default registry does not carry a DOCX adapter");
    const { representation, derivative } = await extractSourceRepresentation({
      adapter,
      bytes,
      mediaType: DOCX_MEDIA_TYPE,
    });

    const observation = createSourceObservation({
      observationId,
      originIdSha256: sha(`origin:${observationId}`),
      inputId: `input-${observationId}`,
      registrationSha256: sha(`registration:${observationId}`),
      runIdSha256: sha(RUN_ID),
      repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
      requestSha256,
      producerId: PRODUCER_ID,
      producerVersion: "1",
      producerScopeSha256: PRODUCER_SCOPE,
      acquisitionReceiptSha256: sha(`receipt:${observationId}`),
      observedAt: "2026-09-16T14:00:00.000Z",
      original: {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
        mediaType: DOCX_MEDIA_TYPE,
        locatorSha256: sha(repositoryPath),
        version: { kind: "repository-revision", revision: REVISION },
        repositoryPath,
      },
      representations: [representation],
    });
    const binding = createSourceBinding({
      runIdSha256: sha(RUN_ID),
      repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
      requestSha256,
      hostPolicySha256: POLICY.policySha256,
      producerScopeSha256: digestSourceProducerScopes(PRODUCER_SCOPES),
      parentBindingSha256: null,
      observations: [{ observationId, observationSha256: observation.observationSha256 }],
      requiredObservationIds: [observationId],
    });
    const capture = openExternalInputAccessCapture({
      runIdSha256: sha(RUN_ID),
      repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
    });
    const { contentDigestSha256 } = registerFakeExternalInput(capture, observation.inputId, {
      adapterKind: "repository-document",
      canonicalLocator: `repository-document:${repositoryPath}`,
      safeTitle: "Release notes, DOCX",
      body: Buffer.from(derivative).toString("utf8"),
      version: { kind: "repository-revision", revision: REVISION },
      visibility: "internal",
      disclosurePolicy: "cite-and-quote",
      intendedRoles: ["evidence"],
    });
    const verifier: SourceEvidenceHostVerifier = {
      verifyCurrent: () => undefined,
      hostPolicySha256: POLICY.policySha256,
      producerScopes: PRODUCER_SCOPES,
      resolveBinding: (digest) => (digest === binding.bindingSha256 ? binding : undefined),
      resolveObservation: (id) => (id === observation.observationId ? observation : undefined),
      resolveDerivative: ({ representationId }) =>
        representationId === representation.representationId ? derivative : undefined,
      recordAccess: ({ stepId, spanIds }) =>
        recordExternalInputAccess(capture, {
          inputId: observation.inputId,
          stepId,
          outcome: "opened",
          observedContentDigestSha256: contentDigestSha256!,
          accessorId: "docsfab-read-source",
          evidenceSha256s: [sha(spanIds.join(","))],
        }).observationSha256,
      now: () => new Date("2026-09-16T14:05:00.000Z"),
    };
    const service = createSourceEvidenceService(createSourceEvidenceHostAuthority(verifier));
    const reference = createSourceArtifactReference({
      kind: "source-binding",
      digest: binding.bindingSha256,
      repositoryRevision: REVISION,
      repositoryContentDigest: CONTENT_DIGEST,
    });
    const capability = admitRunSourceBinding({
      reference,
      service,
      context: {
        runId: RUN_ID,
        requestSha256,
        repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
        workspaceIdentitySha256: WORKSPACE_IDENTITY,
        repositoryContentDigest: CONTENT_DIGEST,
      },
    });
    if (!capability) throw new Error("the service refused a source-aware run");
    return { binding, capability, derivative, observation, representation };
  }

  function spanText(
    representation: Awaited<ReturnType<typeof buildDocxChain>>["representation"],
    derivative: Uint8Array,
    predicate: (locator: ReturnType<typeof docxLocator>) => boolean,
  ): { spanId: string; text: string } {
    const span = representation.spans.find((entry) => predicate(docxLocator(entry.locator)));
    if (!span) throw new Error("expected a matching DOCX span");
    return {
      spanId: span.spanId,
      text: Buffer.from(derivative.subarray(span.startByte, span.endByte)).toString("utf8"),
    };
  }

  it("returns the exact heading text through a host-issued step reader", async () => {
    const { capability, derivative, representation } = await buildDocxChain();
    const reader = capability.forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    });
    expect(reader).toBeDefined();
    const heading = spanText(
      representation,
      derivative,
      (locator) => locator.paragraphOrdinal === 0 && locator.tableCell === null,
    );
    expect(heading.text).toBe(HEADING_TEXT);
    const read = reader!.read({
      observationId: OBSERVATION_ID,
      representationId: representation.representationId,
      spanIds: [heading.spanId],
    });
    expect(read.text).toBe(HEADING_TEXT);
    expect(read.spanAccess.stepId).toBe("write-documentation");
    expect(read.spanAccess.spanIds).toEqual([heading.spanId]);
  });

  it("carries docx-block locators all the way into the sealed binding", async () => {
    const { capability } = await buildDocxChain();
    const locators = capability.observations[0]!.representations[0]!.spans.map(
      (span) => span.locator,
    );
    expect(locators.every((locator) => locator.kind === "docx-block")).toBe(true);
    expect(locators).toEqual([
      {
        kind: "docx-block",
        part: "word/document.xml",
        blockPath: [0],
        paragraphOrdinal: 0,
        tableCell: null,
      },
      {
        kind: "docx-block",
        part: "word/document.xml",
        blockPath: [1],
        paragraphOrdinal: 1,
        tableCell: null,
      },
      {
        kind: "docx-block",
        part: "word/document.xml",
        blockPath: [2],
        paragraphOrdinal: 2,
        tableCell: null,
      },
      {
        kind: "docx-block",
        part: "word/document.xml",
        blockPath: [3],
        paragraphOrdinal: 3,
        tableCell: null,
      },
      {
        kind: "docx-block",
        part: "word/document.xml",
        blockPath: [4],
        paragraphOrdinal: 4,
        tableCell: null,
      },
      {
        kind: "docx-block",
        part: "word/document.xml",
        blockPath: [5, 0, 0],
        paragraphOrdinal: null,
        tableCell: { row: 0, column: 0 },
      },
      {
        kind: "docx-block",
        part: "word/document.xml",
        blockPath: [5, 0, 1],
        paragraphOrdinal: null,
        tableCell: { row: 0, column: 1 },
      },
      {
        kind: "docx-block",
        part: "word/document.xml",
        blockPath: [5, 1, 0],
        paragraphOrdinal: null,
        tableCell: { row: 1, column: 0 },
      },
      {
        kind: "docx-block",
        part: "word/document.xml",
        blockPath: [5, 1, 1],
        paragraphOrdinal: null,
        tableCell: { row: 1, column: 1 },
      },
    ]);
  });

  it("blocks the write when the required DOCX span was never read", async () => {
    const { binding, capability, observation } = await buildDocxChain();
    const unread = assembleSourceEvidenceFinal({
      binding,
      observations: [observation],
      spanAccesses: capability.spanAccesses(),
      spanCitations: [],
      externalInputManifestSha256: sha("manifest-docx"),
      accessLedgerSha256: sha("access-ledger-docx"),
      citationLedgerSha256: sha("citation-ledger-docx"),
    });
    expect(unread.requiredCoverage).toEqual([{ observationId: OBSERVATION_ID, status: "unread" }]);
    expect(sourceEvidenceRequiredGapCodes(unread)).toEqual([`${OBSERVATION_ID}:unread`]);
  });

  it("clears the write gate once a step has actually read the DOCX span", async () => {
    const { binding, capability, observation, representation } = await buildDocxChain();
    const reader = capability.forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    });
    reader!.read({
      observationId: OBSERVATION_ID,
      representationId: representation.representationId,
      spanIds: representation.spans.map((span) => span.spanId),
    });
    const read = assembleSourceEvidenceFinal({
      binding,
      observations: [observation],
      spanAccesses: capability.spanAccesses(),
      spanCitations: [],
      externalInputManifestSha256: sha("manifest-docx"),
      accessLedgerSha256: sha("access-ledger-docx"),
      citationLedgerSha256: sha("citation-ledger-docx"),
    });
    expect(read.requiredCoverage).toEqual([
      { observationId: OBSERVATION_ID, status: "considered" },
    ]);
    expect(sourceEvidenceRequiredGapCodes(read)).toEqual([]);
  });

  it("accepts a citation whose DOCX spans were actually read in the same step", async () => {
    const { binding, capability, derivative, observation, representation } = await buildDocxChain();
    const reader = capability.forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    })!;
    const heading = spanText(
      representation,
      derivative,
      (locator) => locator.paragraphOrdinal === 0 && locator.tableCell === null,
    );
    const read = reader.read({
      observationId: OBSERVATION_ID,
      representationId: representation.representationId,
      spanIds: [heading.spanId],
    });
    const citation = createSourceSpanCitation({
      bindingSha256: binding.bindingSha256,
      observationId: OBSERVATION_ID,
      representationId: representation.representationId,
      representationSha256: observation.representations[0]!.representationSha256,
      stepId: "write-documentation",
      spanIds: [heading.spanId],
      spanAccessSha256s: [read.spanAccess.spanAccessSha256],
      supportedClaimSha256: sha("claim-heading"),
      externalInputCitationSha256: sha("external-citation-docx"),
    });
    expect(
      verifySourceSpanCitations({
        binding,
        observations: [observation],
        spanAccesses: capability.spanAccesses(),
        spanCitations: [citation],
        materialClaimSha256s: [sha("claim-heading")],
      }),
    ).toEqual([]);
  });

  it("rejects a citation of a DOCX span nobody read", async () => {
    const { binding, capability, derivative, observation, representation } = await buildDocxChain();
    const reader = capability.forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    })!;
    const heading = spanText(
      representation,
      derivative,
      (locator) => locator.paragraphOrdinal === 0 && locator.tableCell === null,
    );
    const list = spanText(
      representation,
      derivative,
      (locator) => locator.paragraphOrdinal === 2 && locator.tableCell === null,
    );
    expect(list.text).toBe(LIST_TEXT);
    const read = reader.read({
      observationId: OBSERVATION_ID,
      representationId: representation.representationId,
      spanIds: [heading.spanId],
    });
    const citation = createSourceSpanCitation({
      bindingSha256: binding.bindingSha256,
      observationId: OBSERVATION_ID,
      representationId: representation.representationId,
      representationSha256: observation.representations[0]!.representationSha256,
      stepId: "write-documentation",
      spanIds: [list.spanId],
      spanAccessSha256s: [read.spanAccess.spanAccessSha256],
      supportedClaimSha256: sha("claim-unread-list"),
      externalInputCitationSha256: sha("external-citation-docx"),
    });
    expect(
      verifySourceSpanCitations({
        binding,
        observations: [observation],
        spanAccesses: capability.spanAccesses(),
        spanCitations: [citation],
        materialClaimSha256s: [],
      }),
    ).toEqual([{ supportedClaimSha256: sha("claim-unread-list"), code: "unread-span" }]);
  });

  it("reports honest partial final evidence for omitted stories and hidden runs", async () => {
    const { binding, capability, derivative, observation, representation } = await buildDocxChain({
      bytes: PARTIAL_BYTES,
      observationId: "obs-partial-docx",
      repositoryPath: "docs/partial-notes.docx",
    });
    expect(representation.completeness).toBe("partial");
    expect(representation.limitations).toEqual(
      expect.arrayContaining(["hidden-content-excluded", "unsupported-structure"]),
    );
    const visible = spanText(representation, derivative, () => true);
    expect(visible.text).toBe("visible heading");
    expect(visible.text).not.toContain("hidden");
    const reader = capability.forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    })!;
    reader.read({
      observationId: "obs-partial-docx",
      representationId: representation.representationId,
      spanIds: [visible.spanId],
    });
    const final = assembleSourceEvidenceFinal({
      binding,
      observations: [observation],
      spanAccesses: capability.spanAccesses(),
      spanCitations: [],
      externalInputManifestSha256: sha("manifest-docx-partial"),
      accessLedgerSha256: sha("access-ledger-docx-partial"),
      citationLedgerSha256: sha("citation-ledger-docx-partial"),
    });
    expect(final.requiredCoverage).toEqual([
      { observationId: "obs-partial-docx", status: "partial" },
    ]);
    expect(final.limitations).toEqual(
      expect.arrayContaining([
        { observationId: "obs-partial-docx", reasonCode: "hidden-content-excluded" },
        { observationId: "obs-partial-docx", reasonCode: "unsupported-structure" },
      ]),
    );
    expect(sourceEvidenceRequiredGapCodes(final)).toEqual([]);
  });
});
