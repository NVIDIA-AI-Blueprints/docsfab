// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  getRegisteredExternalInput,
  openExternalInputAccessCapture,
} from "../src/inputs/access.js";
import {
  SourceAcquisitionError,
  TrackedSourceOversizeError,
  acquireTrackedSourceBinding,
  computeSourceOriginId,
  digestSourceReadScope,
  isWithinSourceReadScope,
  normalizeSourcePath,
  normalizeSourceSelection,
  type TrackedSourceReaderV1,
} from "../src/inputs/source-acquisition.js";
import {
  DEFAULT_SOURCE_EXTRACTOR_ADAPTERS,
  SOURCE_MEDIA_TYPE_BY_EXTENSION,
  classifySourceMediaType,
  createDefaultSourceExtractorRegistry,
  supportedSourceExtensions,
} from "../src/inputs/source-extractor-registry.js";
import { DIFF_SOURCE_MEDIA_TYPE, diffSourceExtractorAdapter } from "../src/inputs/adapters/diff.js";
import { DOCX_MEDIA_TYPE, DOCX_SOURCE_EXTRACTOR_ID } from "../src/inputs/adapters/docx.js";
import { HTML_SOURCE_EXTRACTOR_ID } from "../src/inputs/adapters/html.js";
import { PDF_MEDIA_TYPE, PDF_SOURCE_EXTRACTOR_ID } from "../src/inputs/adapters/pdf.js";
import {
  jsonSourceExtractorAdapter,
  notebookSourceExtractorAdapter,
  textSourceExtractorAdapter,
  yamlSourceExtractorAdapter,
} from "../src/inputs/adapters/structured.js";
import { decodeSourceBinding, decodeSourceObservation } from "../src/inputs/source-evidence.js";
import { formatOriginalBudgetRefusal } from "../src/inputs/source-extraction.js";

const REVISION_A = "a".repeat(40);
const REVISION_B = "b".repeat(40);
const REPOSITORY_PATH = "/tmp/acquisition-fixture";
const REPOSITORY = {
  identitySha256: createHash("sha256").update(REPOSITORY_PATH).digest("hex"),
  revision: REVISION_A,
};
const RUN_ID_SHA = createHash("sha256").update("acquisition-run", "utf8").digest("hex");
const REQUEST_SHA = createHash("sha256").update("acquisition-request", "utf8").digest("hex");
const POLICY_SHA = createHash("sha256").update("acquisition-policy", "utf8").digest("hex");
const OBSERVED_AT = "2026-09-15T09:00:00.000Z";

const HTML_A = `<!DOCTYPE html>
<html><body><h1>Release notes</h1><p>Revision A prose for the acquisition producer.</p></body></html>
`;
const HTML_B = `<!DOCTYPE html>
<html><body><h1>Release notes</h1><p>Revision B prose that differs from revision A.</p></body></html>
`;

/** In-memory stand-in for the workspace reader. Tracking is explicit, never inferred. */
function reader(files: Record<string, string | Uint8Array>): TrackedSourceReaderV1 {
  return {
    async isTrackedRegularFile(path) {
      return Object.hasOwn(files, path);
    },
    async readTrackedBytes(path, maxBytes) {
      const value = files[path];
      if (value === undefined) throw new Error(`reader asked for untracked ${path}`);
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
      if (bytes.byteLength > maxBytes) throw new TrackedSourceOversizeError(path, bytes.byteLength);
      return bytes;
    },
  };
}

function acquire(overrides: {
  files?: Record<string, string | Uint8Array>;
  selection?: readonly string[];
  readScope?: readonly string[];
  repository?: { identitySha256: string; revision: string };
  limits?: { maxOriginalBytes?: number; maxDerivativeBytes?: number; maxSpans?: number };
  requestSha256?: string;
}) {
  const files = overrides.files ?? { "docs/release-notes.html": HTML_A };
  const repository = overrides.repository ?? REPOSITORY;
  return acquireTrackedSourceBinding({
    reader: reader(files),
    externalInputs: openExternalInputAccessCapture({ runIdSha256: RUN_ID_SHA, repository }),
    selection: overrides.selection ?? ["docs/release-notes.html"],
    readScope: overrides.readScope ?? ["."],
    runIdSha256: RUN_ID_SHA,
    repository,
    requestSha256: overrides.requestSha256 ?? REQUEST_SHA,
    hostPolicySha256: POLICY_SHA,
    observedAt: OBSERVED_AT,
    ...(overrides.limits ? { limits: overrides.limits } : {}),
  });
}

describe("default source extractor registry (#835)", () => {
  it("registers all three shipped adapters and resolves every media type they claim", () => {
    const registry = createDefaultSourceExtractorRegistry();
    expect(registry.resolve("text/html")?.id).toBe(HTML_SOURCE_EXTRACTOR_ID);
    expect(registry.resolve("application/xhtml+xml")?.id).toBe(HTML_SOURCE_EXTRACTOR_ID);
    expect(registry.resolve("text/html; charset=utf-8")?.id).toBe(HTML_SOURCE_EXTRACTOR_ID);
    expect(registry.resolve(DOCX_MEDIA_TYPE)?.id).toBe(DOCX_SOURCE_EXTRACTOR_ID);
    expect(registry.resolve(PDF_MEDIA_TYPE)?.id).toBe(PDF_SOURCE_EXTRACTOR_ID);
    expect(registry.resolve("application/json")?.id).toBe(jsonSourceExtractorAdapter.id);
    expect(registry.resolve("application/yaml")?.id).toBe(yamlSourceExtractorAdapter.id);
    expect(registry.resolve("application/x-ipynb+json")?.id).toBe(
      notebookSourceExtractorAdapter.id,
    );
    expect(registry.resolve("text/plain")?.id).toBe(textSourceExtractorAdapter.id);
    expect(registry.resolve(DIFF_SOURCE_MEDIA_TYPE)?.id).toBe(diffSourceExtractorAdapter.id);
    expect(registry.resolve("text/x-patch")?.id).toBe(diffSourceExtractorAdapter.id);
    expect(registry.list().map((adapter) => adapter.id)).toEqual([
      HTML_SOURCE_EXTRACTOR_ID,
      DOCX_SOURCE_EXTRACTOR_ID,
      PDF_SOURCE_EXTRACTOR_ID,
      textSourceExtractorAdapter.id,
      jsonSourceExtractorAdapter.id,
      yamlSourceExtractorAdapter.id,
      notebookSourceExtractorAdapter.id,
      diffSourceExtractorAdapter.id,
    ]);
  });

  it("gives each registered adapter its own locator kind, so no two contest a span", () => {
    const registry = createDefaultSourceExtractorRegistry();
    const kinds = registry.list().map((adapter) => adapter.locatorKind);
    expect(kinds).toEqual([
      "html-node",
      "docx-block",
      "pdf-page",
      "text",
      "json-pointer",
      "json-pointer",
      "notebook-cell",
      "diff",
    ]);
    const uniqueExceptSharedPointer = kinds.filter((kind) => kind !== "json-pointer");
    expect(new Set(uniqueExceptSharedPointer).size).toBe(uniqueExceptSharedPointer.length);
    expect(kinds.filter((kind) => kind === "json-pointer")).toHaveLength(2);
  });

  it("resolves nothing for a media type no registered adapter claims", () => {
    const registry = createDefaultSourceExtractorRegistry();
    expect(registry.resolve("application/zip")).toBeUndefined();
    expect(registry.resolve("application/msword")).toBeUndefined();
    expect(
      registry.resolve("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    ).toBeUndefined();
    expect(DEFAULT_SOURCE_EXTRACTOR_ADAPTERS).toHaveLength(8);
  });

  it("classifies only the fixed extension allowlist and never sniffs", () => {
    expect(classifySourceMediaType("docs/a.html")).toBe("text/html");
    expect(classifySourceMediaType("docs/a.HTM")).toBe("text/html");
    expect(classifySourceMediaType("docs/a.xhtml")).toBe("application/xhtml+xml");
    expect(classifySourceMediaType("docs/a.pdf")).toBe(PDF_MEDIA_TYPE);
    expect(classifySourceMediaType("docs/a.PDF")).toBe(PDF_MEDIA_TYPE);
    expect(classifySourceMediaType("docs/a.docx")).toBe(DOCX_MEDIA_TYPE);
    expect(classifySourceMediaType("docs/a.DocX")).toBe(DOCX_MEDIA_TYPE);
    expect(classifySourceMediaType("spec/openapi.json")).toBe("application/json");
    expect(classifySourceMediaType("spec/openapi.yaml")).toBe("application/yaml");
    expect(classifySourceMediaType("spec/openapi.YML")).toBe("application/yaml");
    expect(classifySourceMediaType("analysis/example.ipynb")).toBe("application/x-ipynb+json");
    expect(classifySourceMediaType("src/example.js")).toBe("text/javascript");
    expect(classifySourceMediaType("src/example.ts")).toBe("text/x-typescript");
    expect(classifySourceMediaType("config/runtime.toml")).toBe("application/toml");
    expect(classifySourceMediaType("notes/readme.txt")).toBe("text/plain");
    expect(classifySourceMediaType("changes/feature.diff")).toBe(DIFF_SOURCE_MEDIA_TYPE);
    expect(classifySourceMediaType("changes/0001-feature.PATCH")).toBe(DIFF_SOURCE_MEDIA_TYPE);
    expect(classifySourceMediaType("docs/a.doc")).toBeUndefined();
    expect(classifySourceMediaType("docs/a.xlsx")).toBeUndefined();
    expect(classifySourceMediaType("docs/a.md")).toBe("text/markdown");
    expect(classifySourceMediaType("docs/a.MARKDOWN")).toBe("text/markdown");
    expect(classifySourceMediaType("docs/a.MdX")).toBe("text/mdx");
    expect(classifySourceMediaType("docs/README")).toBeUndefined();
    expect(classifySourceMediaType("docs/.htaccess")).toBeUndefined();
    expect(classifySourceMediaType("docs/trailing.")).toBeUndefined();
  });

  it("offers every allowlisted extension a registered adapter, so none is unreachable", () => {
    const registry = createDefaultSourceExtractorRegistry();
    for (const extension of Object.keys(SOURCE_MEDIA_TYPE_BY_EXTENSION)) {
      const mediaType = classifySourceMediaType(`docs/a.${extension}`);
      expect(mediaType).toBeDefined();
      expect(registry.resolve(mediaType!)).toBeDefined();
    }
  });

  it("keeps Markdown extensions derived from the installed text adapter claims", () => {
    const markdownExtensions = ["md", "markdown", "mdx"];
    expect(
      supportedSourceExtensions().filter((extension) => markdownExtensions.includes(extension)),
    ).toEqual([...markdownExtensions].sort());
    expect(supportedSourceExtensions([jsonSourceExtractorAdapter])).not.toEqual(
      expect.arrayContaining(markdownExtensions),
    );
    expect(createDefaultSourceExtractorRegistry().resolve("text/markdown")?.id).toBe(
      textSourceExtractorAdapter.id,
    );
    expect(createDefaultSourceExtractorRegistry().resolve("text/mdx")?.id).toBe(
      textSourceExtractorAdapter.id,
    );
  });
});

describe("tracked source read scope (#835)", () => {
  it("matches a scope prefix only on a separator boundary", () => {
    expect(isWithinSourceReadScope("docs/guide.html", ["docs"])).toBe(true);
    expect(isWithinSourceReadScope("docs", ["docs"])).toBe(true);
    expect(isWithinSourceReadScope("docs-internal/guide.html", ["docs"])).toBe(false);
    expect(isWithinSourceReadScope("private/guide.html", ["."])).toBe(true);
  });

  it("digests the grant, not the selection", () => {
    const wide = digestSourceReadScope({ repository: REPOSITORY, readScope: ["."] });
    const narrow = digestSourceReadScope({ repository: REPOSITORY, readScope: ["docs"] });
    const reordered = digestSourceReadScope({
      repository: REPOSITORY,
      readScope: ["specs", "docs"],
    });
    const sorted = digestSourceReadScope({ repository: REPOSITORY, readScope: ["docs", "specs"] });
    expect(wide).not.toBe(narrow);
    expect(reordered).toBe(sorted);
  });
});

describe("tracked source acquisition refusals (#835)", () => {
  it("refuses a path the repository does not track at the selected revision", async () => {
    await expect(acquire({ files: {}, selection: ["docs/absent.html"] })).rejects.toThrowError(
      new SourceAcquisitionError("path-not-tracked", "docs/absent.html"),
    );
  });

  it("refuses a tracked path outside the host-granted read scope", async () => {
    // Genuinely tracked and genuinely extractable: only the grant refuses it.
    await expect(
      acquire({
        files: { "private/secrets-overview.html": HTML_A },
        selection: ["private/secrets-overview.html"],
        readScope: ["docs"],
      }),
    ).rejects.toThrowError(
      new SourceAcquisitionError("path-outside-read-scope", "private/secrets-overview.html"),
    );
  });

  it("asks nothing of the repository for a path outside the read scope", async () => {
    const asked: string[] = [];
    await expect(
      acquireTrackedSourceBinding({
        reader: {
          async isTrackedRegularFile(path) {
            asked.push(path);
            return true;
          },
          async readTrackedBytes() {
            throw new Error("must not read");
          },
        },
        externalInputs: openExternalInputAccessCapture({
          runIdSha256: RUN_ID_SHA,
          repository: REPOSITORY,
        }),
        selection: ["private/a.html"],
        readScope: ["docs"],
        runIdSha256: RUN_ID_SHA,
        repository: REPOSITORY,
        requestSha256: REQUEST_SHA,
        hostPolicySha256: POLICY_SHA,
        observedAt: OBSERVED_AT,
      }),
    ).rejects.toThrowError(SourceAcquisitionError);
    expect(asked).toEqual([]);
  });

  it("refuses a tracked media type no adapter claims", async () => {
    const refused = acquire({
      files: { "docs/spec.doc": "\xd0\xcf\x11\xe0 legacy Word binary" },
      selection: ["docs/spec.doc"],
    });
    // The refusal renders the extensions this host accepts, so the
    // expectation carries the same default registry the producer used.
    await expect(refused).rejects.toMatchObject({
      acceptedExtensions: expect.arrayContaining(["md", "markdown", "mdx"]),
    });
    await expect(refused).rejects.toThrowError(
      new SourceAcquisitionError(
        "unsupported-media-type",
        "docs/spec.doc",
        undefined,
        undefined,
        supportedSourceExtensions(),
      ),
    );
  });

  it("refuses an allowlisted extension whose bytes are a different format", async () => {
    // The extension chooses which adapter is offered the bytes; it does not
    // assert what the bytes are. A `.pdf` holding a ZIP reaches the PDF
    // adapter, which refuses it on the bytes, so the acquisition fails closed
    // rather than binding whatever another adapter would have made of it.
    await expect(
      acquire({
        files: { "docs/spec.pdf": "PK this is a zip wearing a pdf name" },
        selection: ["docs/spec.pdf"],
      }),
    ).rejects.toThrowError(
      new SourceAcquisitionError("extractor-limitation", "docs/spec.pdf", "empty-extraction"),
    );

    await expect(
      acquire({
        files: { "docs/notes.docx": "%PDF-1.7 this is a pdf wearing a docx name" },
        selection: ["docs/notes.docx"],
      }),
    ).rejects.toThrowError(
      new SourceAcquisitionError("extractor-limitation", "docs/notes.docx", "empty-extraction"),
    );
  });

  it("refuses an original that exceeds the admitted byte ceiling", async () => {
    const large = `<html><body><p>${"x".repeat(4096)}</p></body></html>`;
    const refused = acquire({
      files: { "docs/large.html": large },
      selection: ["docs/large.html"],
      limits: { maxOriginalBytes: 64 },
    });
    // The refusal names the ceiling it was measured against, so the
    // expectation carries the same 64 bytes the producer was given.
    await expect(refused).rejects.toThrowError(
      new SourceAcquisitionError(
        "input-over-limit",
        "docs/large.html",
        undefined,
        { amount: 64, unit: "bytes" },
        undefined,
        formatOriginalBudgetRefusal(large.length, 64),
      ),
    );
    // Its catalog line names the code, the file's bytes, the bound in force,
    // and the override that raises it.
    await expect(refused).rejects.toThrowError(
      `Source acquisition refused: input-over-limit (docs/large.html). sources-extraction-max-original-bytes-bound: ${large.length} exceeds sources.extractionMaxOriginalBytes = 64 bytes. Bind a smaller source, such as a narrower merged-MR window or a smaller tracked file, or raise DOCSFAB_SOURCES_EXTRACTION_MAX_ORIGINAL_BYTES, up to 67108864, then start a new run. Follow the named remediation.`,
    );
  });

  it("keeps the extraction seam's catalog line when it re-wraps an original-size refusal", async () => {
    // A reader that hands over more than it was asked for: the seam refuses
    // the original, and acquisition keeps that refusal's line.
    const large = `<html><body><p>${"x".repeat(4096)}</p></body></html>`;
    const refused = acquireTrackedSourceBinding({
      reader: {
        async isTrackedRegularFile() {
          return true;
        },
        async readTrackedBytes() {
          return new TextEncoder().encode(large);
        },
      },
      externalInputs: openExternalInputAccessCapture({
        runIdSha256: RUN_ID_SHA,
        repository: REPOSITORY,
      }),
      selection: ["docs/large.html"],
      readScope: ["docs"],
      runIdSha256: RUN_ID_SHA,
      repository: REPOSITORY,
      requestSha256: REQUEST_SHA,
      hostPolicySha256: POLICY_SHA,
      observedAt: OBSERVED_AT,
      limits: { maxOriginalBytes: 64 },
    });
    await expect(refused).rejects.toMatchObject({
      code: "input-over-limit",
      extractionCode: "original-budget-exceeded",
    });
    await expect(refused).rejects.toThrowError(
      `Source acquisition refused: input-over-limit (docs/large.html). sources-extraction-max-original-bytes-bound: ${large.length} exceeds sources.extractionMaxOriginalBytes = 64 bytes.`,
    );
  });

  it("names the bound without a count when the reader cannot measure the file", async () => {
    await expect(
      acquireTrackedSourceBinding({
        reader: {
          async isTrackedRegularFile() {
            return true;
          },
          async readTrackedBytes(path) {
            throw new TrackedSourceOversizeError(path);
          },
        },
        externalInputs: openExternalInputAccessCapture({
          runIdSha256: RUN_ID_SHA,
          repository: REPOSITORY,
        }),
        selection: ["docs/large.html"],
        readScope: ["docs"],
        runIdSha256: RUN_ID_SHA,
        repository: REPOSITORY,
        requestSha256: REQUEST_SHA,
        hostPolicySha256: POLICY_SHA,
        observedAt: OBSERVED_AT,
        limits: { maxOriginalBytes: 64 },
      }),
    ).rejects.toThrowError(
      "Source acquisition refused: input-over-limit (docs/large.html). sources-extraction-max-original-bytes-bound: exceeded sources.extractionMaxOriginalBytes = 64 bytes.",
    );
  });

  it("refuses a derivative the budget truncated rather than sealing partial coverage", async () => {
    const many = `<html><body>${Array.from(
      { length: 40 },
      (_value, index) => `<p>Paragraph number ${index} of the release notes.</p>`,
    ).join("")}</body></html>`;
    const refused = acquire({
      files: { "docs/many.html": many },
      selection: ["docs/many.html"],
      limits: { maxSpans: 3 },
    });
    // Span truncation names the span budget, not a byte ceiling: the limit's
    // code, the spans the adapter produced, and the 3 in force.
    await expect(refused).rejects.toMatchObject({
      code: "input-over-limit",
      repositoryPath: "docs/many.html",
      limit: { amount: 3, unit: "spans" },
    });
    await expect(refused).rejects.toThrowError(
      /^Source acquisition refused: input-over-limit \(docs\/many\.html\)\. sources-extraction-max-spans-bound: 40 exceeds sources\.extractionMaxSpans = 3 count\. Bind a smaller file, or raise sources\.extractionMaxSpans in config\/limits\/sources\.yaml\. Follow the named remediation\.$/u,
    );
  });

  it("refuses an extractor limitation that makes the binding unsound", async () => {
    // An unmatched close tag leaves the scanner reporting unsupported-structure,
    // so the derivative does not faithfully stand in for the original.
    await expect(
      acquire({
        files: { "docs/broken.html": "<html><body><p>Text</p></section></body></html>" },
        selection: ["docs/broken.html"],
      }),
    ).rejects.toThrowError(new SourceAcquisitionError("extractor-limitation", "docs/broken.html"));
  });

  it("refuses an empty selection, a duplicate path, and an unsafe path", async () => {
    await expect(acquire({ selection: [] })).rejects.toThrowError(
      new SourceAcquisitionError("empty-selection"),
    );
    await expect(
      acquire({ selection: ["docs/release-notes.html", "docs/release-notes.html"] }),
    ).rejects.toThrowError(
      new SourceAcquisitionError("duplicate-source-path", "docs/release-notes.html"),
    );
    for (const unsafe of ["../escape.html", "/absolute.html", "docs/../escape.html", "docs/"]) {
      expect(() => normalizeSourceSelection([unsafe], ["."])).toThrowError(SourceAcquisitionError);
    }
  });

  it("refuses a single-dot segment without probing the repository", async () => {
    // `docs/./a.html` resolves to a tracked file, so a validator that only
    // rejected `..` would hand it to a repository probe. Each spelling must be
    // refused by shape, before any I/O.
    const probed: string[] = [];
    const probeCounting = {
      async isTrackedRegularFile(path: string) {
        probed.push(path);
        return true;
      },
      async readTrackedBytes() {
        probed.push("read");
        return new TextEncoder().encode(HTML_A);
      },
    };
    for (const unsafe of [
      "docs/./release-notes.html",
      "./docs/release-notes.html",
      "docs/../docs/release-notes.html",
      "docs//release-notes.html",
      "/docs/release-notes.html",
      "docs/release-notes.html/",
    ]) {
      await expect(
        acquireTrackedSourceBinding({
          reader: probeCounting,
          externalInputs: openExternalInputAccessCapture({
            runIdSha256: RUN_ID_SHA,
            repository: REPOSITORY,
          }),
          selection: [unsafe],
          readScope: ["."],
          runIdSha256: RUN_ID_SHA,
          repository: REPOSITORY,
          requestSha256: REQUEST_SHA,
          hostPolicySha256: POLICY_SHA,
          observedAt: OBSERVED_AT,
        }),
      ).rejects.toThrowError(new SourceAcquisitionError("invalid-source-path", unsafe));
      expect(normalizeSourcePath.bind(null, unsafe)).toThrowError(
        new SourceAcquisitionError("invalid-source-path", unsafe),
      );
    }
    // Not one of the six spellings reached the repository.
    expect(probed).toEqual([]);
  });

  it("refuses an empty read scope instead of defaulting to the whole tree", async () => {
    await expect(acquire({ readScope: [] })).rejects.toThrowError(
      new SourceAcquisitionError("empty-read-scope"),
    );
  });
});

describe("tracked source acquisition binding (#835)", () => {
  it.each([
    ["md", "text/markdown", "# Café\r\n\r\nRésumé\nTail"],
    ["markdown", "text/markdown", "\uFEFF# Ωmega\r\n\r\nβeta"],
    ["MDX", "text/mdx", "\uFEFF# MDX\r\n\r\nCafé\r\nEnd"],
  ])(
    "admits tracked .%s source with original byte identity and faithful span locators",
    async (extension, mediaType, text) => {
      const path = `docs/source.${extension}`;
      const bytes = new Uint8Array(Buffer.from(text, "utf8"));
      const result = await acquire({ files: { [path]: bytes }, selection: [path] });
      const entry = result.acquired[0]!;
      const observation = decodeSourceObservation(entry.observation);
      const binding = decodeSourceBinding(result.binding);
      const representation = observation.representations[0]!;

      expect(observation.original.mediaType).toBe(mediaType);
      expect(observation.original.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(observation.original.byteLength).toBe(bytes.byteLength);
      expect(representation.extractor.id).toBe(textSourceExtractorAdapter.id);
      expect(representation.spans.length).toBeGreaterThan(0);
      expect(binding.observations.map((item) => item.observationId)).toContain(
        observation.observationId,
      );
      for (const span of representation.spans) {
        expect(span.locator.kind).toBe("text");
        if (span.locator.kind !== "text") throw new Error("expected original text locator");
        expect(Buffer.from(bytes.subarray(span.locator.startByte, span.locator.endByte))).toEqual(
          Buffer.from(entry.derivative.subarray(span.startByte, span.endByte)),
        );
      }
    },
  );

  it.each(["md", "mdx"])(
    "refuses malformed UTF-8 in .%s through default tracked acquisition",
    async (extension) => {
      const path = `docs/broken.${extension}`;
      const malformed = new Uint8Array([0x23, 0x20, 0xc3, 0x28]);
      await expect(
        acquire({ files: { [path]: malformed }, selection: [path] }),
      ).rejects.toMatchObject({
        code: "extractor-limitation",
        repositoryPath: path,
        extractionCode: "adapter-failed",
      });
    },
  );

  it("admits a Markdown original exactly at its byte budget and refuses one byte over", async () => {
    const exact = new Uint8Array(Buffer.from("# β\n"));
    const accepted = await acquire({
      files: { "docs/exact.md": exact },
      selection: ["docs/exact.md"],
      limits: { maxOriginalBytes: exact.byteLength },
    });
    expect(accepted.acquired[0]!.observation.original.byteLength).toBe(exact.byteLength);
    await expect(
      acquire({
        files: { "docs/over.md": new Uint8Array([...exact, 0x21]) },
        selection: ["docs/over.md"],
        limits: { maxOriginalBytes: exact.byteLength },
      }),
    ).rejects.toMatchObject({ code: "input-over-limit", repositoryPath: "docs/over.md" });
  });

  it("refuses derivative and span overflow for tracked Markdown instead of sealing a prefix", async () => {
    await expect(
      acquire({
        files: { "docs/spans.md": "A\n\nB\nC" },
        selection: ["docs/spans.md"],
        limits: { maxSpans: 2 },
      }),
    ).rejects.toMatchObject({ code: "input-over-limit", repositoryPath: "docs/spans.md" });
    await expect(
      acquire({
        files: { "docs/derivative.md": "A\n\nB\nC" },
        selection: ["docs/derivative.md"],
        limits: { maxDerivativeBytes: 2 },
      }),
    ).rejects.toMatchObject({ code: "input-over-limit", repositoryPath: "docs/derivative.md" });
  });

  it("mints a decodable binding carrying every #795 binding this producer owns", async () => {
    const result = await acquire({});
    const binding = decodeSourceBinding(result.binding);
    const [entry] = result.acquired;

    expect(binding.runIdSha256).toBe(RUN_ID_SHA);
    expect(binding.requestSha256).toBe(REQUEST_SHA);
    expect(binding.hostPolicySha256).toBe(POLICY_SHA);
    expect(binding.repository).toEqual(REPOSITORY);
    expect(binding.requiredObservationIds).toEqual([entry!.observation.observationId]);

    const observation = decodeSourceObservation(entry!.observation);
    expect(observation.producerId).toBe("workspace-tracked-files");
    expect(observation.producerVersion).toBe("1");
    expect(observation.producerScopeSha256).toBe(
      digestSourceReadScope({ repository: REPOSITORY, readScope: ["."] }),
    );
    expect(observation.original.repositoryPath).toBe("docs/release-notes.html");
    expect(observation.original.mediaType).toBe("text/html");
    expect(observation.original.version).toEqual({
      kind: "repository-revision",
      revision: REVISION_A,
    });
    expect(observation.original.sha256).toBe(
      createHash("sha256").update(new TextEncoder().encode(HTML_A)).digest("hex"),
    );
    expect(observation.original.byteLength).toBe(new TextEncoder().encode(HTML_A).byteLength);

    const [representation] = observation.representations;
    expect(representation!.extractor.id).toBe(HTML_SOURCE_EXTRACTOR_ID);
    expect(representation!.extractor.version).toBe("1");
    expect(representation!.originalSha256).toBe(observation.original.sha256);
    expect(representation!.sha256).toBe(
      createHash("sha256").update(entry!.derivative).digest("hex"),
    );
    expect(representation!.spans.length).toBeGreaterThan(0);
    expect(representation!.spans.every((span) => span.locator.kind === "html-node")).toBe(true);
    expect(Buffer.from(entry!.derivative).toString("utf8")).toContain("Release notes");
  });

  it("acquires a tracked JSON original through the installed structured adapter", async () => {
    const json = '{"summary":"List pets"}\n';
    const result = await acquire({
      files: { "api/standalone.json": json },
      selection: ["api/standalone.json"],
    });
    const [entry] = result.acquired;
    const observation = decodeSourceObservation(entry!.observation);
    expect(observation.original.repositoryPath).toBe("api/standalone.json");
    expect(observation.original.mediaType).toBe("application/json");
    expect(observation.original.sha256).toBe(
      createHash("sha256").update(new TextEncoder().encode(json)).digest("hex"),
    );
    const [representation] = observation.representations;
    expect(representation!.extractor.id).toBe(jsonSourceExtractorAdapter.id);
    expect(representation!.spans).toEqual([
      expect.objectContaining({
        locator: { kind: "json-pointer", pointer: "/summary" },
      }),
    ]);
    expect(Buffer.from(entry!.derivative).toString("utf8")).toBe('"List pets"');
  });

  it("registers the acquired original as a real repository-document external input", async () => {
    const repository = REPOSITORY;
    const externalInputs = openExternalInputAccessCapture({
      runIdSha256: RUN_ID_SHA,
      repository,
    });
    const result = await acquireTrackedSourceBinding({
      reader: reader({ "docs/release-notes.html": HTML_A }),
      externalInputs,
      selection: ["docs/release-notes.html"],
      readScope: ["."],
      runIdSha256: RUN_ID_SHA,
      repository,
      requestSha256: REQUEST_SHA,
      hostPolicySha256: POLICY_SHA,
      observedAt: OBSERVED_AT,
    });
    const [entry] = result.acquired;
    const registration = getRegisteredExternalInput(externalInputs, entry!.observation.inputId);
    expect(registration.sourceKind).toBe("repository-document");
    expect(registration.locator.permissionClass).toBe("readable");
    expect(registration.version).toEqual({ kind: "repository-revision", revision: REVISION_A });
    expect(registration.contentDigestSha256).toBe(
      createHash("sha256").update(entry!.derivative).digest("hex"),
    );
    expect(entry!.observation.registrationSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("binds every selected path and requires each one", async () => {
    const result = await acquire({
      files: { "docs/a.html": HTML_A, "docs/b.html": HTML_B },
      selection: ["docs/b.html", "docs/a.html"],
    });
    expect(result.acquired.map((entry) => entry.repositoryPath)).toEqual([
      "docs/a.html",
      "docs/b.html",
    ]);
    expect(result.binding.observations).toHaveLength(2);
    expect(result.binding.requiredObservationIds).toHaveLength(2);
  });

  it("gives the same path at a divergent revision different digests and a different binding", async () => {
    const atA = await acquire({ files: { "docs/release-notes.html": HTML_A } });
    const atB = await acquire({
      files: { "docs/release-notes.html": HTML_B },
      repository: { identitySha256: REPOSITORY.identitySha256, revision: REVISION_B },
    });

    const originalA = atA.acquired[0]!.observation.original;
    const originalB = atB.acquired[0]!.observation.original;
    const representationA = atA.acquired[0]!.representation;
    const representationB = atB.acquired[0]!.representation;

    // Same origin, different bytes: every content-bearing digest moves.
    expect(
      computeSourceOriginId({
        repository: REPOSITORY,
        repositoryPath: "docs/release-notes.html",
      }),
    ).toBe(atA.acquired[0]!.observation.originIdSha256);
    expect(atB.acquired[0]!.observation.originIdSha256).toBe(
      atA.acquired[0]!.observation.originIdSha256,
    );
    expect(originalB.sha256).not.toBe(originalA.sha256);
    expect(representationB.sha256).not.toBe(representationA.sha256);
    expect(representationB.representationId).not.toBe(representationA.representationId);
    expect(atB.acquired[0]!.observation.observationId).not.toBe(
      atA.acquired[0]!.observation.observationId,
    );
    expect(atB.binding.bindingSha256).not.toBe(atA.binding.bindingSha256);
    expect(atB.binding.repository.revision).toBe(REVISION_B);
    expect(Buffer.from(atB.acquired[0]!.derivative).toString("utf8")).toContain("Revision B");
    expect(Buffer.from(atA.acquired[0]!.derivative).toString("utf8")).toContain("Revision A");
  });

  it("moves the binding when the caller request identity changes", async () => {
    const first = await acquire({});
    const second = await acquire({
      requestSha256: createHash("sha256").update("other-request", "utf8").digest("hex"),
    });
    expect(second.binding.bindingSha256).not.toBe(first.binding.bindingSha256);
  });

  it("moves the binding when the host-granted read scope widens", async () => {
    const narrow = await acquire({ readScope: ["docs"] });
    const wide = await acquire({ readScope: ["."] });
    expect(narrow.binding.producerScopeSha256).not.toBe(wide.binding.producerScopeSha256);
    expect(narrow.binding.bindingSha256).not.toBe(wide.binding.bindingSha256);
  });
});
