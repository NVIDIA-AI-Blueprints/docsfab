// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Wraps, never replaces, the pinned PDF.js build. Every test below runs the
// real parser; the wrapper only records the exact parameter object the adapter
// handed to `getDocument` and whether the loading task was destroyed, so those
// are observed facts rather than inferences from the adapter's source.
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pdfjs-dist/legacy/build/pdf.mjs")>();
  return {
    ...actual,
    getDocument: vi.fn((parameters: unknown) => {
      const task = (actual.getDocument as (input: unknown) => PdfTaskLike)(parameters);
      const realDestroy = task.destroy.bind(task);
      task.destroy = vi.fn(() => realDestroy());
      RECORDED.push({ parameters, task });
      return task;
    }),
  };
});

/** The minimum of a PDF.js loading task this file needs to observe. */
interface PdfTaskLike {
  promise: Promise<unknown>;
  destroy: (() => Promise<void>) & { mock?: unknown };
}

const RECORDED: Array<{ parameters: unknown; task: PdfTaskLike }> = [];

/**
 * Host-capability call log.
 *
 * Two mechanisms have to be covered. `vi.mock` intercepts an ESM `import` of a
 * builtin, which is what this package's own code uses. The shipped PDF.js build
 * does not import `node:fs` at all: it calls `process.getBuiltinModule("fs")`,
 * `("fs/promises")`, and `("module").createRequire(...)`, which bypasses module
 * resolution entirely.
 *
 * So `process.getBuiltinModule` itself is wrapped, here in `vi.hoisted` so the
 * wrapper is installed before anything imports PDF.js, and the modules it hands
 * back are wrapped too. `vi.spyOn` cannot be used on an ESM builtin namespace,
 * so every wrapper preserves the real implementation and only records the call.
 */
const CAPABILITY = vi.hoisted(() => {
  const calls: string[] = [];

  const FS_MEMBERS = [
    "access",
    "createReadStream",
    "lstat",
    "open",
    "openSync",
    "readFile",
    "readFileSync",
    "readdir",
    "readdirSync",
    "stat",
    "statSync",
  ] as const;
  const CHILD_MEMBERS = [
    "exec",
    "execFile",
    "execFileSync",
    "execSync",
    "fork",
    "spawn",
    "spawnSync",
  ] as const;
  const WATCHED: Record<string, readonly string[]> = {
    child_process: CHILD_MEMBERS,
    fs: FS_MEMBERS,
    "fs/promises": FS_MEMBERS,
    http: ["get", "request"],
    https: ["get", "request"],
    net: ["connect", "createConnection"],
    os: ["homedir", "hostname", "tmpdir", "userInfo"],
    "node:child_process": CHILD_MEMBERS,
    "node:fs": FS_MEMBERS,
    "node:fs/promises": FS_MEMBERS,
    "node:http": ["get", "request"],
    "node:https": ["get", "request"],
    "node:net": ["connect", "createConnection"],
    "node:os": ["homedir", "hostname", "tmpdir", "userInfo"],
    "node:vm": ["compileFunction", "runInContext", "runInNewContext", "runInThisContext"],
    vm: ["compileFunction", "runInContext", "runInNewContext", "runInThisContext"],
  };

  function wrap<T extends object>(label: string, actual: T, names: readonly string[]): T {
    const wrapped: Record<string, unknown> = { ...actual };
    for (const name of names) {
      const original = (actual as Record<string, unknown>)[name];
      if (typeof original !== "function") continue;
      wrapped[name] = (...args: unknown[]) => {
        calls.push(`${label}.${name}`);
        return (original as (...rest: unknown[]) => unknown).apply(actual, args);
      };
    }
    return wrapped as T;
  }

  // The real mechanism the shipped build uses.
  const originalGetBuiltinModule = process.getBuiltinModule.bind(process);
  process.getBuiltinModule = ((id: string) => {
    calls.push(`getBuiltinModule:${id}`);
    const actual = originalGetBuiltinModule(id as Parameters<typeof originalGetBuiltinModule>[0]);
    const names = WATCHED[id];
    return names && actual && typeof actual === "object"
      ? wrap(id, actual as object, names)
      : actual;
  }) as typeof process.getBuiltinModule;

  return { calls, wrap };
});

function wrapCapability<T extends object>(label: string, actual: T, names: readonly string[]): T {
  return CAPABILITY.wrap(label, actual, names);
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return wrapCapability("child_process", actual, [
    "exec",
    "execFile",
    "execFileSync",
    "execSync",
    "fork",
    "spawn",
    "spawnSync",
  ]);
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return wrapCapability("fs", actual, [
    "access",
    "createReadStream",
    "open",
    "openSync",
    "readFile",
    "readFileSync",
    "readdir",
    "readdirSync",
    "stat",
    "statSync",
  ]);
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return wrapCapability("fs/promises", actual, [
    "access",
    "lstat",
    "open",
    "readFile",
    "readdir",
    "stat",
  ]);
});

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return wrapCapability("net", actual, ["connect", "createConnection"]);
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return wrapCapability("os", actual, ["homedir", "hostname", "tmpdir", "userInfo"]);
});

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return wrapCapability("http", actual, ["get", "request"]);
});

vi.mock("node:https", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:https")>();
  return wrapCapability("https", actual, ["get", "request"]);
});

vi.mock("node:vm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:vm")>();
  return wrapCapability("vm", actual, [
    "compileFunction",
    "runInContext",
    "runInNewContext",
    "runInThisContext",
  ]);
});

import {
  PDF_DOCUMENT_OPTIONS,
  PDF_FORBIDDEN_RESOURCE_OPTIONS,
  PDF_MAX_PAGES,
  PDF_MEDIA_TYPE,
  PDF_PARSER_VERSION,
  PDF_SOURCE_EXTRACTOR_ID,
  extractPdfTextEvidence,
  hasUnmappableGlyph,
  joinPdfTextItems,
  loadPdfJs,
  pdfSourceExtractorAdapter,
  type PdfEvidenceOutcomeV1,
  type PdfEvidenceReasonCode,
} from "../src/inputs/adapters/pdf.js";
import {
  admitRunSourceBinding,
  assembleSourceEvidenceFinal,
  classifySourceMediaType,
  computeSourceSpanId,
  createDefaultSourceExtractorRegistry,
  createSourceArtifactReference,
  createSourceBinding,
  createSourceEvidenceHostAuthority,
  createSourceEvidenceService,
  createSourceExtractorRegistry,
  createSourceObservation,
  createSourceSpanCitation,
  createSourceStepPolicy,
  decodeSourceObservation,
  DEFAULT_SOURCE_EXTRACTION_LIMITS,
  digestSourceExtractorOptions,
  digestSourceProducerScopes,
  extractSourceRepresentation,
  type ExtractSourceRepresentationResult,
  htmlSourceExtractorAdapter,
  launchSourceParser,
  normalizeMediaType,
  openExternalInputAccessCapture,
  originalBudgetExceededError,
  probeSourceParserConfinement,
  projectSourceRequestContext,
  recordExternalInputAccess,
  registerFakeExternalInput,
  SOURCE_REPRESENTATION_LIMITATIONS,
  SourceEvidenceContractError,
  type SourceEvidenceHostVerifier,
  sourceEvidenceRequiredGapCodes,
  SourceExtractionError,
  type SourceExtractionLimitsV1,
  SourceParserLaunchError,
  verifySourceSpanCitations,
} from "../src/inputs/index.js";
import { configureCredential } from "./helpers/configured-credential.js";

const fixtureUrl = (name: string) =>
  new URL(`./fixtures/source-evidence/pdf/${name}`, import.meta.url);
const load = (name: string) => new Uint8Array(readFileSync(fixtureUrl(name)));

const SIMPLE = load("simple-two-page.pdf");
const DIVERGENT = load("divergent-two-page.pdf");

/** Every fixture, loaded once, so the measured inertness window reads no file. */
const ALL_FIXTURES = [
  "simple-two-page.pdf",
  "divergent-two-page.pdf",
  "type0-font.pdf",
  "type0-heuristic-encoding.pdf",
  "type0-tounicode.pdf",
  "type0-unmapped.pdf",
  "xref-stream.pdf",
  "incremental-update.pdf",
  "encrypted.pdf",
  "encrypted-hex-name.pdf",
  "rc4-owner-only.pdf",
  "rc4-owner-only-hex-name.pdf",
  "aes128-owner-only.pdf",
  "aes256-owner-only.pdf",
  "encrypt-lookalike.pdf",
  "malformed.pdf",
  "xfa-form.pdf",
  "acroform.pdf",
  "image-only.pdf",
  "inline-image.pdf",
  "mixed.pdf",
  "empty.pdf",
  "oversized-inflate-bomb.pdf",
  "chained-filter-bomb.pdf",
  "many-pages.pdf",
].map((name) => [name, load(name)] as const);

const PAGE_ONE_TEXT =
  "The quick brown fox jumps over the lazy dog.\nAccents: café, señor, über, façade.";
const PAGE_TWO_TEXT = "Kerned Text Example\nPage two, second item.";

/**
 * The shipped default registry, not a PDF-only fixture. Every "through the
 * real host path" case below resolves the adapter from here by media type
 * rather than importing it directly, so a registration mistake on HEAD fails a
 * test instead of passing one.
 */
const REGISTRY = createDefaultSourceExtractorRegistry();

function resolvePdfAdapter() {
  const adapter = REGISTRY.resolve("application/pdf; charset=binary");
  if (!adapter) throw new Error("the shared registry does not resolve application/pdf");
  return adapter;
}

/** The real host path: registry lookup, then the seam's own sealing. */
function host(
  bytes: Uint8Array,
  limits?: Partial<SourceExtractionLimitsV1>,
): Promise<ExtractSourceRepresentationResult> {
  return extractSourceRepresentation({
    adapter: resolvePdfAdapter(),
    bytes,
    mediaType: PDF_MEDIA_TYPE,
    ...(limits ? { limits } : {}),
  });
}

function adapterOutcome(
  bytes: Uint8Array,
  limits?: Partial<SourceExtractionLimitsV1>,
): Promise<PdfEvidenceOutcomeV1> {
  return extractPdfTextEvidence({
    bytes,
    options: pdfSourceExtractorAdapter.defaultOptions,
    limits: { ...DEFAULT_SOURCE_EXTRACTION_LIMITS, ...(limits ?? {}) },
  });
}

const spanText = (result: ExtractSourceRepresentationResult, index: number) => {
  const span = result.representation.spans[index];
  if (!span) throw new Error(`no span at index ${index}`);
  return Buffer.from(result.derivative.subarray(span.startByte, span.endByte)).toString("utf8");
};

beforeEach(() => {
  RECORDED.length = 0;
});

/** Whatever the pinned build did to the host while it was being imported. */
let importTimeCalls: string[] = [];

// Loading the parser the first time costs seconds; every later call costs
// milliseconds. Warming it here keeps the timing assertions below about the
// fixtures rather than about a one-time module import, and captures the
// import-time capability calls separately from the measured window.
beforeAll(async () => {
  CAPABILITY.calls.length = 0;
  await loadPdfJs();
  importTimeCalls = [...CAPABILITY.calls];
  CAPABILITY.calls.length = 0;
  await adapterOutcome(SIMPLE);
}, 60_000);

describe("PDF text evidence, positive controls", () => {
  it("extracts both pages of a real text PDF with exact text and pdf-page locators", async () => {
    const result = await host(SIMPLE);
    expect(result.representation.spans).toHaveLength(2);
    expect(result.representation.completeness).toBe("complete");
    expect(result.representation.limitations).toEqual([]);
    expect(result.representation.spans[0]!.locator).toEqual({
      kind: "pdf-page",
      pageNumber: 1,
      itemStart: 0,
      itemEnd: 2,
    });
    expect(result.representation.spans[1]!.locator).toEqual({
      kind: "pdf-page",
      pageNumber: 2,
      itemStart: 0,
      itemEnd: 2,
    });
    expect(spanText(result, 0)).toBe(PAGE_ONE_TEXT);
    expect(spanText(result, 1)).toBe(PAGE_TWO_TEXT);
  });

  it("preserves non-ASCII page text byte for byte", async () => {
    const result = await host(SIMPLE);
    expect(spanText(result, 0)).toContain("Accents: café, señor, über, façade.");
    expect(Buffer.from(result.derivative).toString("utf8")).toBe(
      `${PAGE_ONE_TEXT}\n${PAGE_TWO_TEXT}`,
    );
  });

  it("keeps the original digest intact, because the parser never sees the host's buffer", async () => {
    const before = createHash("sha256").update(SIMPLE).digest("hex");
    const result = await host(SIMPLE);
    // pdf.js takes ownership of, and may detach, the buffer it is given. If the
    // adapter passed the host's own bytes, this digest would not survive.
    expect(result.originalSha256).toBe(before);
    expect(createHash("sha256").update(SIMPLE).digest("hex")).toBe(before);
    expect(SIMPLE.byteLength).toBeGreaterThan(0);
  });

  it("runs through the seam's launch path and seals identical digests", async () => {
    const launched = await launchSourceParser({
      adapter: resolvePdfAdapter(),
      bytes: SIMPLE,
      mediaType: PDF_MEDIA_TYPE,
      executionMode: "in-process-inert",
    });
    const direct = await host(SIMPLE);
    expect(launched.executionMode).toBe("in-process-inert");
    expect(launched.representation.representationId).toBe(direct.representation.representationId);
    expect(launched.representation.spans.map((span) => span.spanId)).toEqual(
      direct.representation.spans.map((span) => span.spanId),
    );
  });

  it("binds the pinned parser version into the extractor identity", async () => {
    const installed = JSON.parse(
      readFileSync(new URL("../node_modules/pdfjs-dist/package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const module = await loadPdfJs();
    expect(installed.version).toBe(PDF_PARSER_VERSION);
    expect(module.version).toBe(PDF_PARSER_VERSION);
    expect(pdfSourceExtractorAdapter.defaultOptions.parserVersion).toBe(PDF_PARSER_VERSION);

    const result = await host(SIMPLE);
    expect(result.extractor.id).toBe(PDF_SOURCE_EXTRACTOR_ID);
    // The options digest covers defaultOptions, which carries the parser
    // version, so a parser upgrade cannot reuse an existing span identity.
    expect(result.extractor.optionsSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("resolves by parameter-free media type through the shipped default registry", () => {
    expect(normalizeMediaType("APPLICATION/PDF; charset=binary")).toBe(PDF_MEDIA_TYPE);
    expect(REGISTRY.resolve(PDF_MEDIA_TYPE)).toBe(pdfSourceExtractorAdapter);
    expect(REGISTRY.resolve("text/html")).toBe(htmlSourceExtractorAdapter);
    expect(pdfSourceExtractorAdapter.locatorKind).toBe("pdf-page");
    expect(classifySourceMediaType("docs/release-notes.pdf")).toBe(PDF_MEDIA_TYPE);
    expect(classifySourceMediaType("docs/release-notes.PDF")).toBe(PDF_MEDIA_TYPE);
  });

  it("treats a registry that never registered PDF as a missing parser, not an empty success", () => {
    const withoutPdf = createSourceExtractorRegistry([htmlSourceExtractorAdapter]);
    expect(withoutPdf.resolve(PDF_MEDIA_TYPE)).toBeUndefined();
    expect(createDefaultSourceExtractorRegistry().resolve(PDF_MEDIA_TYPE)).toBe(
      pdfSourceExtractorAdapter,
    );
  });
});

describe("PDF locators are load-bearing, not decorative", () => {
  it("gives a divergent document divergent representation and span identities", async () => {
    const first = await host(SIMPLE);
    const second = await host(DIVERGENT);
    expect(second.representation.representationId).not.toBe(first.representation.representationId);
    const shared = first.representation.spans.filter((span) =>
      second.representation.spans.some((other) => other.spanId === span.spanId),
    );
    expect(shared).toHaveLength(0);
    expect(spanText(second, 0)).toContain("The five boxing wizards jump quickly.");
  });

  it("makes a wrong page number a different span, so a mis-cited page cannot verify", async () => {
    const result = await host(SIMPLE);
    const span = result.representation.spans[0]!;
    const honest = computeSourceSpanId({
      originalSha256: result.originalSha256,
      extractor: result.extractor,
      derivativeSha256: result.representation.sha256,
      startByte: span.startByte,
      endByte: span.endByte,
      locator: span.locator,
    });
    const offByOne = computeSourceSpanId({
      originalSha256: result.originalSha256,
      extractor: result.extractor,
      derivativeSha256: result.representation.sha256,
      startByte: span.startByte,
      endByte: span.endByte,
      locator: { kind: "pdf-page", pageNumber: 2, itemStart: 0, itemEnd: 2 },
    });
    expect(honest).toBe(span.spanId);
    expect(offByOne).not.toBe(span.spanId);
  });

  it("makes a wrong item range a different span, so a substituted map cannot verify", async () => {
    const result = await host(SIMPLE);
    const span = result.representation.spans[0]!;
    expect(span.locator).toEqual({ kind: "pdf-page", pageNumber: 1, itemStart: 0, itemEnd: 2 });
    const narrowed = computeSourceSpanId({
      originalSha256: result.originalSha256,
      extractor: result.extractor,
      derivativeSha256: result.representation.sha256,
      startByte: span.startByte,
      endByte: span.endByte,
      locator: { kind: "pdf-page", pageNumber: 1, itemStart: 0, itemEnd: 1 },
    });
    expect(narrowed).not.toBe(span.spanId);
  });

  it("rejects a representation bound to a different original's bytes", async () => {
    const first = await host(SIMPLE);
    const second = await host(DIVERGENT);
    const observation = createSourceObservation({
      observationId: "obs-simple-pdf",
      originIdSha256: createHash("sha256").update("origin-simple").digest("hex"),
      inputId: "input-simple-pdf",
      registrationSha256: createHash("sha256").update("registration-simple").digest("hex"),
      runIdSha256: createHash("sha256").update("run-simple").digest("hex"),
      repository: { identitySha256: "a".repeat(64), revision: "b".repeat(40) },
      requestSha256: createHash("sha256").update("request-simple").digest("hex"),
      producerId: "workspace-tracked-files",
      producerVersion: "1",
      producerScopeSha256: createHash("sha256").update("scope-simple").digest("hex"),
      acquisitionReceiptSha256: createHash("sha256").update("receipt-simple").digest("hex"),
      observedAt: "2026-09-16T12:00:00.000Z",
      original: {
        sha256: first.originalSha256,
        byteLength: SIMPLE.byteLength,
        mediaType: PDF_MEDIA_TYPE,
        locatorSha256: createHash("sha256").update("docs/simple.pdf").digest("hex"),
        version: { kind: "repository-revision", revision: "b".repeat(40) },
        repositoryPath: "docs/simple.pdf",
      },
      representations: [first.representation],
    });
    expect(() =>
      decodeSourceObservation({
        ...observation,
        representations: [second.representation],
      }),
    ).toThrowError(new SourceEvidenceContractError("substitution"));
  });

  it("gives each page its own span, in page order, over disjoint derivative ranges", async () => {
    const result = await host(SIMPLE);
    const pages = result.representation.spans.map((span) =>
      span.locator.kind === "pdf-page" ? span.locator.pageNumber : -1,
    );
    expect(pages).toEqual([1, 2]);
    expect(result.representation.spans[0]!.endByte).toBeLessThan(
      result.representation.spans[1]!.startByte,
    );
  });
});

describe("every fixture class yields real text or a specific limitation", () => {
  interface Expectation {
    reasons: PdfEvidenceReasonCode[];
    segments: number;
    pageCount: number;
  }

  const CLASSES: Array<[string, Expectation]> = [
    ["simple-two-page.pdf", { reasons: [], segments: 2, pageCount: 2 }],
    ["divergent-two-page.pdf", { reasons: [], segments: 2, pageCount: 2 }],
    ["type0-font.pdf", { reasons: [], segments: 1, pageCount: 1 }],
    ["type0-heuristic-encoding.pdf", { reasons: [], segments: 1, pageCount: 1 }],
    ["type0-tounicode.pdf", { reasons: [], segments: 1, pageCount: 1 }],
    ["xref-stream.pdf", { reasons: [], segments: 1, pageCount: 1 }],
    ["incremental-update.pdf", { reasons: [], segments: 1, pageCount: 1 }],
    ["mixed.pdf", { reasons: ["no-text-layer"], segments: 1, pageCount: 2 }],
    ["image-only.pdf", { reasons: ["no-text-layer"], segments: 0, pageCount: 1 }],
    ["inline-image.pdf", { reasons: ["no-text-layer"], segments: 0, pageCount: 1 }],
    ["empty.pdf", { reasons: ["no-text-layer"], segments: 0, pageCount: 1 }],
    ["oversized-inflate-bomb.pdf", { reasons: ["no-text-layer"], segments: 0, pageCount: 1 }],
    ["type0-unmapped.pdf", { reasons: ["unsupported-encoding"], segments: 0, pageCount: 1 }],
    ["encrypt-lookalike.pdf", { reasons: [], segments: 1, pageCount: 1 }],
    ["acroform.pdf", { reasons: ["forms-layer-excluded"], segments: 1, pageCount: 1 }],
    ["xfa-form.pdf", { reasons: ["xfa-form"], segments: 0, pageCount: 1 }],
    ["encrypted.pdf", { reasons: ["encrypted"], segments: 0, pageCount: 0 }],
    ["encrypted-hex-name.pdf", { reasons: ["encrypted"], segments: 0, pageCount: 0 }],
    ["rc4-owner-only.pdf", { reasons: ["encrypted"], segments: 0, pageCount: 1 }],
    ["rc4-owner-only-hex-name.pdf", { reasons: ["encrypted"], segments: 0, pageCount: 1 }],
    ["aes128-owner-only.pdf", { reasons: ["encrypted"], segments: 0, pageCount: 1 }],
    ["aes256-owner-only.pdf", { reasons: ["encrypted"], segments: 0, pageCount: 1 }],
    ["malformed.pdf", { reasons: ["malformed"], segments: 0, pageCount: 0 }],
    ["many-pages.pdf", { reasons: ["over-page-limit"], segments: PDF_MAX_PAGES, pageCount: 105 }],
  ];

  it.each(CLASSES)(
    "classifies %s exactly once, with no silent empty success",
    async (name, expectation) => {
      const outcome = await adapterOutcome(load(name));
      expect(outcome.reasons).toEqual(expectation.reasons);
      expect(outcome.segments).toHaveLength(expectation.segments);
      expect(outcome.pageCount).toBe(expectation.pageCount);
      // The contract that matters: text or a named limitation, never neither.
      expect(outcome.segments.length > 0 || outcome.limitations.length > 0).toBe(true);
      // And never a clean bill of health for a document that gave up nothing.
      if (outcome.segments.length === 0) expect(outcome.limitations.length).toBeGreaterThan(0);
    },
  );

  it.each(CLASSES.filter(([, e]) => e.segments === 0))(
    "refuses %s at the host boundary rather than sealing an empty representation",
    async (name) => {
      await expect(host(load(name))).rejects.toThrowError(
        new SourceExtractionError("empty-extraction"),
      );
    },
  );

  it.each(CLASSES.filter(([, e]) => e.segments > 0 && e.reasons.length > 0))(
    "seals %s as partial, never as complete",
    async (name) => {
      const result = await host(load(name));
      expect(result.representation.completeness).toBe("partial");
      expect(result.representation.limitations.length).toBeGreaterThan(0);
    },
  );
});

describe("the critic's attack fixtures", () => {
  it("bounds a single-filter decompression bomb instead of blocking the event loop", async () => {
    // This adapter calls no decompressor at all, so the bomb is just a page
    // with no text.
    const started = Date.now();
    const outcome = await adapterOutcome(load("oversized-inflate-bomb.pdf"));
    const elapsedMs = Date.now() - started;
    expect(outcome.segments).toEqual([]);
    expect(outcome.reasons).toEqual(["no-text-layer"]);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it("lets the seam deadline cut a chained-filter bomb the adapter cannot bound", async () => {
    // Chaining `/Filter [/FlateDecode x4]` multiplies the decode work. The
    // adapter has no decompressor of its own to bound, so the seam's deadline
    // is what stops it, and that works here only because PDF.js yields while
    // decoding.
    const bytes = load("chained-filter-bomb.pdf");
    expect(bytes.byteLength).toBeLessThan(2_048);

    // The cut runs first, cold, under a budget far below any plausible decode
    // time, so the assertion does not depend on how warm an earlier decode left
    // the JIT.
    const cutStarted = Date.now();
    await expect(host(bytes, { maxExtractionMs: 25 })).rejects.toThrowError(
      new SourceExtractionError("extraction-deadline-exceeded"),
    );
    const cutMs = Date.now() - cutStarted;

    // Then let the same bytes run to completion, to show what was saved.
    const uncutStarted = Date.now();
    const uncut = await adapterOutcome(bytes);
    const uncutMs = Date.now() - uncutStarted;

    expect(uncut.reasons).toEqual(["no-text-layer"]);
    expect(uncut.segments).toEqual([]);
    expect(cutMs).toBeLessThan(uncutMs);
  }, 60_000);

  it("reads a Type0/Identity-H page as the digits PDF.js mapped, not as Latin-1 bytes", async () => {
    // PDF.js maps these CIDs to "012", the fixture's real text; decoding them
    // through the Latin-1 table would yield "HACH".
    const outcome = await adapterOutcome(load("type0-font.pdf"));
    expect(outcome.segments).toHaveLength(1);
    expect(outcome.segments[0]!.text).toBe("012");
    expect(outcome.segments[0]!.text).not.toContain("HACH");
  });

  it("refuses a composite font whose glyphs PDF.js could not map, rather than quoting them", async () => {
    const outcome = await adapterOutcome(load("type0-unmapped.pdf"));
    expect(outcome.reasons).toEqual(["unsupported-encoding"]);
    expect(outcome.limitations).toEqual(["unsupported-encoding"]);
    expect(outcome.segments).toEqual([]);
  });

  it("extracts declared ToUnicode text from the composite control, not the heuristic digits", async () => {
    const outcome = await adapterOutcome(load("type0-tounicode.pdf"));
    expect(outcome.segments).toHaveLength(1);
    expect(outcome.segments[0]!.text).toBe("ABC");
    expect(outcome.reasons).toEqual([]);
    expect(outcome.limitations).toEqual([]);
  });

  it("still cites heuristic Type0 digits as complete, because the text API names no ToUnicode signal", async () => {
    const heuristic = await host(load("type0-heuristic-encoding.pdf"));
    const control = await host(load("type0-tounicode.pdf"));
    expect(heuristic.representation.completeness).toBe("complete");
    expect(control.representation.completeness).toBe("complete");
    expect(heuristic.representation.limitations).toEqual([]);
    expect(control.representation.limitations).toEqual([]);
    expect(spanText(heuristic, 0)).toBe("012");
    expect(spanText(control, 0)).toBe("ABC");
    expect([...SOURCE_REPRESENTATION_LIMITATIONS]).not.toContain("heuristic-encoding");
  });

  it("never emits inline image sample bytes as text", async () => {
    // Tokenizing the bytes after `ID` would yield "ABC." as page text. There is
    // no text-showing operator on this page at all.
    const outcome = await adapterOutcome(load("inline-image.pdf"));
    expect(outcome.segments).toEqual([]);
    expect(JSON.stringify(outcome)).not.toContain("ABC.");
  });

  it("cites the current object after an incremental update, never the shadowed one", async () => {
    // The superseding object is physically last in the file and the superseded
    // one is physically first, so byte-order object lookup and xref-following
    // give different answers. Only the xref answer is correct.
    const outcome = await adapterOutcome(load("incremental-update.pdf"));
    expect(outcome.segments).toHaveLength(1);
    expect(outcome.segments[0]!.text).toBe(
      "CURRENT revision two text that a correct reader cites.",
    );
    expect(JSON.stringify(outcome)).not.toContain("SUPERSEDED");
  });

  it("refuses a document PDF.js DECRYPTED, not merely one it failed to open", async () => {
    // `encrypted.pdf` carries an invalid /O and /U, so PDF.js fails at load and
    // any refusal at all looks correct. This fixture is well-formed RC4 40-bit
    // with an owner password and an empty user password, the commonest real
    // shape: PDF.js opens it with no password, decrypts it, and hands over the
    // text, which must not be cited as `complete`.
    const outcome = await adapterOutcome(load("rc4-owner-only.pdf"));
    expect(outcome.reasons).toEqual(["encrypted"]);
    expect(outcome.segments).toEqual([]);
    // The document really did open: PDF.js reported its page count before the
    // refusal, so this is not a load failure wearing an encryption label.
    expect(outcome.pageCount).toBe(1);
    expect(JSON.stringify(outcome)).not.toContain("must still never be cited");
  });

  it.each([
    ["aes128-owner-only.pdf", "AES-128 owner-locked: readable by any reader, citable by none."],
    ["aes256-owner-only.pdf", "AES-256 owner-locked: readable by any reader, citable by none."],
  ])("refuses %s, the shape a modern producer actually writes", async (name, plaintext) => {
    // RC4 is the easiest encrypted PDF to hand-build; AES is the one readers
    // meet. Both decrypt unasked in raw PDF.js: the page opens and the
    // plaintext is recoverable, so the only thing between it and a citation is
    // the post-load check.
    const outcome = await adapterOutcome(load(name));
    expect(outcome.reasons).toEqual(["encrypted"]);
    expect(outcome.segments).toEqual([]);
    expect(outcome.pageCount).toBe(1);
    expect(JSON.stringify(outcome)).not.toContain(plaintext);
    await expect(host(load(name))).rejects.toThrowError(
      new SourceExtractionError("empty-extraction"),
    );
  });

  it("refuses the same decryptable document when the key is spelled /Encr#79pt", async () => {
    const raw = Buffer.from(load("rc4-owner-only-hex-name.pdf")).toString("latin1");
    expect(raw).toContain("/Encr#79pt");
    expect(raw).not.toContain("/Encrypt ");
    const outcome = await adapterOutcome(load("rc4-owner-only-hex-name.pdf"));
    expect(outcome.reasons).toEqual(["encrypted"]);
    expect(outcome.pageCount).toBe(1);
    expect(outcome.segments).toEqual([]);
  });

  it("reads an unencrypted document whose page text merely mentions /Encrypt", async () => {
    // Positive control for the two refusals above. The literal bytes
    // `/Encrypt`, `/O` and `/U` are in this file's content stream, so a
    // byte-pattern detector would refuse it. The check is a property of the
    // loaded document, not of its bytes, so this must read normally.
    const raw = Buffer.from(load("encrypt-lookalike.pdf")).toString("latin1");
    expect(raw).toContain("/Encrypt");
    const outcome = await adapterOutcome(load("encrypt-lookalike.pdf"));
    expect(outcome.reasons).toEqual([]);
    expect(outcome.segments).toHaveLength(1);
    expect(outcome.segments[0]!.text).toBe(
      "This page merely mentions /Encrypt, /O and /U as words.",
    );
  });

  it("names an AcroForm layer it cannot read, while still citing the static page", async () => {
    // The form's field values live in the AcroForm, never in the page content
    // stream, so the page text is real but the document is only partly read.
    const outcome = await adapterOutcome(load("acroform.pdf"));
    expect(outcome.reasons).toEqual(["forms-layer-excluded"]);
    expect(outcome.limitations).toEqual(["active-content-excluded"]);
    expect(outcome.segments).toHaveLength(1);
    expect(outcome.segments[0]!.text).toBe(
      "Static page text beside an AcroForm whose values are elsewhere.",
    );
    expect(JSON.stringify(outcome)).not.toContain("value that is not page text");
    const sealed = await host(load("acroform.pdf"));
    expect(sealed.representation.completeness).toBe("partial");
  });

  it("refuses an encrypted document whose trailer key is written with a hex escape", async () => {
    // /Encr#79pt and /Encrypt are the same PDF name. A byte-pattern detector
    // misses this file; PDF.js, which decodes name escapes, does not.
    const raw = Buffer.from(load("encrypted-hex-name.pdf")).toString("latin1");
    expect(raw).toContain("/Encr#79pt");
    expect(raw).not.toContain("/Encrypt ");
    const outcome = await adapterOutcome(load("encrypted-hex-name.pdf"));
    expect(outcome.reasons).toEqual(["encrypted"]);
    expect(outcome.segments).toEqual([]);
    expect(JSON.stringify(outcome)).not.toContain("must never be read");
  });

  it("extracts text reachable only through a PDF 1.5 cross-reference and object stream", async () => {
    const raw = Buffer.from(load("xref-stream.pdf")).toString("latin1");
    expect(raw).toContain("/Type /XRef");
    expect(raw).toContain("/Type /ObjStm");
    expect(raw).not.toContain("trailer");
    const outcome = await adapterOutcome(load("xref-stream.pdf"));
    expect(outcome.segments).toHaveLength(1);
    expect(outcome.segments[0]!.text).toBe("Held inside a PDF 1.5 cross-reference stream file.");
  });

  it("refuses an XFA document instead of citing its static page layer", async () => {
    const outcome = await adapterOutcome(load("xfa-form.pdf"));
    expect(outcome.reasons).toEqual(["xfa-form"]);
    expect(outcome.limitations).toEqual(["active-content-excluded"]);
    expect(JSON.stringify(outcome)).not.toContain("Static page text");
  });

  it("stops at the 100-page ceiling and says it truncated", async () => {
    const outcome = await adapterOutcome(load("many-pages.pdf"));
    expect(outcome.pageCount).toBe(105);
    expect(outcome.segments).toHaveLength(PDF_MAX_PAGES);
    expect(outcome.reasons).toEqual(["over-page-limit"]);
    expect(outcome.segments[0]!.text).toBe("Page 1 of 105.");
    expect(outcome.segments[PDF_MAX_PAGES - 1]!.text).toBe(`Page ${PDF_MAX_PAGES} of 105.`);
    const pages = outcome.segments.map((segment) =>
      segment.locator.kind === "pdf-page" ? segment.locator.pageNumber : -1,
    );
    expect(pages[0]).toBe(1);
    expect(pages[pages.length - 1]).toBe(PDF_MAX_PAGES);
    expect(pages).not.toContain(101);
  });

  it("names the encrypted refusal without quoting anything from the document", async () => {
    const outcome = await adapterOutcome(load("encrypted.pdf"));
    expect(outcome.reasons).toEqual(["encrypted"]);
    expect(JSON.stringify(outcome)).not.toContain("This text exists");
  });

  it("reports a malformed object graph as a structure limitation, not as an empty success", async () => {
    const outcome = await adapterOutcome(load("malformed.pdf"));
    expect(outcome.reasons).toEqual(["malformed"]);
    expect(outcome.limitations).toEqual(["unsupported-structure"]);
  });
});

describe("finite budgets, cancellation, and the reserved subprocess mode", () => {
  it("refuses an oversized original before a byte reaches the parser", async () => {
    RECORDED.length = 0;
    await expect(host(SIMPLE, { maxOriginalBytes: 16 })).rejects.toThrowError(
      originalBudgetExceededError(SIMPLE.byteLength, 16),
    );
    expect(RECORDED).toHaveLength(0);
  });

  it("refuses an oversized original even when the adapter is called directly", async () => {
    RECORDED.length = 0;
    const outcome = await adapterOutcome(SIMPLE, { maxOriginalBytes: 16 });
    expect(outcome.reasons).toEqual(["over-size"]);
    expect(RECORDED).toHaveLength(0);
  });

  it("truncates the derivative under a byte budget and names the limitation", async () => {
    const full = await host(SIMPLE);
    const pageOneBytes = full.representation.spans[0]!.endByte;
    expect(pageOneBytes).toBeGreaterThan(0);
    const truncated = await host(SIMPLE, { maxDerivativeBytes: pageOneBytes });
    expect(truncated.representation.spans).toHaveLength(1);
    expect(truncated.representation.byteLength).toBe(pageOneBytes);
    expect(truncated.representation.completeness).toBe("partial");
    expect(truncated.representation.limitations).toContain("byte-budget-truncated");
    expect(spanText(truncated, 0)).toBe(PAGE_ONE_TEXT);
  });

  it("truncates spans under a span budget and names the limitation", async () => {
    const truncated = await host(SIMPLE, { maxSpans: 1 });
    expect(truncated.representation.spans).toHaveLength(1);
    expect(truncated.representation.completeness).toBe("partial");
    expect(truncated.representation.limitations).toContain("span-budget-truncated");
    expect(spanText(truncated, 0)).toBe(PAGE_ONE_TEXT);
  });

  it("turns a missing packaged parser into adapter-failed rather than quoting the load error", async () => {
    const missing = {
      ...pdfSourceExtractorAdapter,
      extract: async () => {
        throw new Error("Cannot find module 'pdfjs-dist/legacy/build/pdf.mjs'");
      },
    };
    await expect(
      extractSourceRepresentation({
        adapter: missing,
        bytes: SIMPLE,
        mediaType: PDF_MEDIA_TYPE,
      }),
    ).rejects.toThrowError(new SourceExtractionError("adapter-failed"));
    try {
      await extractSourceRepresentation({
        adapter: missing,
        bytes: SIMPLE,
        mediaType: PDF_MEDIA_TYPE,
      });
    } catch (error) {
      expect((error as Error).message).toBe("Source extraction rejected: adapter-failed.");
      expect((error as Error).message).not.toContain("pdfjs-dist");
    }
  });

  it("rejects configured-credential extractor options before a byte reaches the parser", async () => {
    RECORDED.length = 0;
    // One of DocsFab's own configured credentials; a credential shape alone is
    // an ordinary option (#1807).
    const header = configureCredential(["eyJhbGciOiJ", "IUzI1NiIs", "InR5cCI6Ikp"].join("."));
    expect(() => digestSourceExtractorOptions({ header })).toThrowError(
      SourceEvidenceContractError,
    );
    await expect(
      extractSourceRepresentation({
        adapter: resolvePdfAdapter(),
        bytes: SIMPLE,
        mediaType: PDF_MEDIA_TYPE,
        options: { header },
      }),
    ).rejects.toThrowError(SourceEvidenceContractError);
    expect(RECORDED).toHaveLength(0);
  });

  it("proves extraction and the confinement probe on this host, and claims no other platform", async () => {
    const result = await host(SIMPLE);
    expect(result.representation.completeness).toBe("complete");
    expect(spanText(result, 0)).toBe(PAGE_ONE_TEXT);
    const probe = probeSourceParserConfinement();
    expect(probe.platform).toBe(process.platform);
    expect(["darwin", "linux"]).toContain(process.platform);
    if (process.platform === "darwin") {
      expect(probe.mechanism).toBe("sandbox-exec");
    }
    if (process.platform === "linux") {
      expect(probe.mechanism).toBe("bubblewrap");
    }
  });

  it("destroys the PDF.js loading task on every completed extraction", async () => {
    RECORDED.length = 0;
    await host(SIMPLE);
    expect(RECORDED).toHaveLength(1);
    expect(RECORDED[0]!.task.destroy).toHaveBeenCalled();
  });

  it("destroys the PDF.js loading task when the host cancels mid-flight", async () => {
    RECORDED.length = 0;
    const controller = new AbortController();
    const pending = extractSourceRepresentation({
      adapter: resolvePdfAdapter(),
      bytes: load("many-pages.pdf"),
      mediaType: PDF_MEDIA_TYPE,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrowError(SourceExtractionError);
    expect(RECORDED).toHaveLength(1);
    expect(RECORDED[0]!.task.destroy).toHaveBeenCalled();
  });

  it("exposes an abort hook the seam can call, and calling it is idempotent", async () => {
    RECORDED.length = 0;
    const controller = new AbortController();
    const request = {
      bytes: SIMPLE,
      options: pdfSourceExtractorAdapter.defaultOptions,
      limits: DEFAULT_SOURCE_EXTRACTION_LIMITS,
      signal: controller.signal,
    };
    const pending = pdfSourceExtractorAdapter.extract(request);
    pdfSourceExtractorAdapter.abort?.(request);
    pdfSourceExtractorAdapter.abort?.(request);
    await Promise.resolve(pending).catch(() => undefined);
    expect(RECORDED).toHaveLength(1);
    expect(RECORDED[0]!.task.destroy).toHaveBeenCalledTimes(1);
  });

  it("refuses to run at all under an already cancelled signal", async () => {
    RECORDED.length = 0;
    const controller = new AbortController();
    controller.abort();
    await expect(
      extractSourceRepresentation({
        adapter: resolvePdfAdapter(),
        bytes: SIMPLE,
        mediaType: PDF_MEDIA_TYPE,
        signal: controller.signal,
      }),
    ).rejects.toThrowError(new SourceExtractionError("extraction-cancelled"));
    expect(RECORDED).toHaveLength(0);
  });

  it("refuses the reserved confined-subprocess mode for PDF, probe or no probe", async () => {
    const probe = probeSourceParserConfinement({ platform: "linux", run: () => undefined });
    expect(probe.available).toBe(true);
    await expect(
      launchSourceParser({
        adapter: resolvePdfAdapter(),
        bytes: SIMPLE,
        mediaType: PDF_MEDIA_TYPE,
        executionMode: "confined-subprocess",
        confinement: probe,
      }),
    ).rejects.toThrowError(new SourceParserLaunchError("subprocess-unimplemented"));
    await expect(
      launchSourceParser({
        adapter: resolvePdfAdapter(),
        bytes: SIMPLE,
        mediaType: PDF_MEDIA_TYPE,
        executionMode: "confined-subprocess",
      }),
    ).rejects.toThrowError(new SourceParserLaunchError("confinement-unavailable"));
  });

  it("refuses the adapter against a media type it did not claim", async () => {
    await expect(
      extractSourceRepresentation({
        adapter: resolvePdfAdapter(),
        bytes: SIMPLE,
        mediaType: "text/html",
      }),
    ).rejects.toThrowError(new SourceExtractionError("unsupported-media-type"));
  });
});

describe("pdfjs-dist@6.3.289 ToUnicode surface (#920)", () => {
  const TEXT_ITEM_KEYS = ["dir", "fontName", "hasEOL", "height", "str", "transform", "width"];
  const TEXT_STYLE_KEYS = ["ascent", "descent", "fontFamily", "vertical"];

  type PdfJsInspectPage = {
    getTextContent: () => Promise<{
      items: unknown[];
      styles: Record<string, Record<string, unknown>>;
    }>;
    getOperatorList: () => Promise<unknown>;
    commonObjs: { get: (id: string) => unknown };
    cleanup: () => void;
  };

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  async function inspectPinnedTextApi(
    bytes: Uint8Array,
    extraOptions: Record<string, unknown> = {},
    operatorList = false,
  ) {
    const pdfjs = await loadPdfJs();
    const data = new Uint8Array(bytes);
    const task = pdfjs.getDocument({ ...PDF_DOCUMENT_OPTIONS, ...extraOptions, data });
    try {
      const document = (await task.promise) as unknown as {
        getPage: (pageNumber: number) => Promise<PdfJsInspectPage>;
      };
      const page = await document.getPage(1);
      const content = await page.getTextContent();
      const item = content.items.find((entry): entry is Record<string, unknown> => {
        return isRecord(entry) && typeof entry.str === "string";
      });
      if (!item) throw new Error("expected a text item");
      const fontName = typeof item.fontName === "string" ? item.fontName : "";
      const styleName = Object.keys(content.styles)[0];
      let commonObjsError: string | undefined;
      try {
        page.commonObjs.get(fontName);
      } catch (error) {
        commonObjsError = error instanceof Error ? error.message : String(error);
      }
      let operatorFont: Record<string, unknown> | undefined;
      if (operatorList) {
        await page.getOperatorList();
        const font = page.commonObjs.get(fontName);
        if (!isRecord(font)) throw new Error("expected a font object after getOperatorList");
        operatorFont = font;
      }
      page.cleanup();
      return {
        str: item.str,
        itemKeys: [...Object.keys(item)].sort(),
        styleKeys: [...Object.keys(content.styles[styleName ?? ""] ?? {})].sort(),
        commonObjsError,
        operatorFont,
        operatorFontKeys: operatorFont ? [...Object.keys(operatorFont)].sort() : undefined,
      };
    } finally {
      await task.destroy();
    }
  }

  it("exposes only TextItem and TextStyle fields from getTextContent, on both Type0 fixtures", async () => {
    const heuristic = await inspectPinnedTextApi(load("type0-heuristic-encoding.pdf"));
    const control = await inspectPinnedTextApi(load("type0-tounicode.pdf"));
    expect(heuristic.str).toBe("012");
    expect(control.str).toBe("ABC");
    expect(heuristic.itemKeys).toEqual(TEXT_ITEM_KEYS);
    expect(control.itemKeys).toEqual(TEXT_ITEM_KEYS);
    expect(heuristic.styleKeys).toEqual(TEXT_STYLE_KEYS);
    expect(control.styleKeys).toEqual(TEXT_STYLE_KEYS);
    expect(heuristic.itemKeys).not.toContain("hasIncludedToUnicodeMap");
    expect(control.styleKeys).not.toContain("toUnicode");
  });

  it("leaves page.commonObjs.get(fontName) unresolved after getTextContent, with or without fontExtraProperties", async () => {
    const frozen = await inspectPinnedTextApi(load("type0-heuristic-encoding.pdf"));
    const extra = await inspectPinnedTextApi(load("type0-heuristic-encoding.pdf"), {
      fontExtraProperties: true,
    });
    const control = await inspectPinnedTextApi(load("type0-tounicode.pdf"), {
      fontExtraProperties: true,
    });
    expect(frozen.commonObjsError).toMatch(/Requesting object that isn't resolved yet/u);
    expect(extra.commonObjsError).toMatch(/Requesting object that isn't resolved yet/u);
    expect(control.commonObjsError).toMatch(/Requesting object that isn't resolved yet/u);
  });

  it("discriminates the pair only through getOperatorList plus fontExtraProperties reading private toUnicode shape", async () => {
    const heuristic = await inspectPinnedTextApi(
      load("type0-heuristic-encoding.pdf"),
      { fontExtraProperties: true },
      true,
    );
    const control = await inspectPinnedTextApi(
      load("type0-tounicode.pdf"),
      { fontExtraProperties: true },
      true,
    );
    expect(heuristic.operatorFont?.composite).toBe(true);
    expect(control.operatorFont?.composite).toBe(true);
    expect(heuristic.operatorFont).not.toHaveProperty("hasIncludedToUnicodeMap");
    expect(control.operatorFont).not.toHaveProperty("hasIncludedToUnicodeMap");
    expect(JSON.stringify(heuristic.operatorFont?.toUnicode)).toBe(
      '{"firstChar":0,"lastChar":65535}',
    );
    expect(JSON.stringify(control.operatorFont?.toUnicode)).toContain('"_map"');
    expect(JSON.stringify(control.operatorFont?.toUnicode)).toContain('"A"');
    expect(JSON.stringify(control.operatorFont?.toUnicode)).toContain('"B"');
    expect(JSON.stringify(control.operatorFont?.toUnicode)).toContain('"C"');
  }, 60_000);

  it("does not export composite or toUnicode from getOperatorList under the frozen option set", async () => {
    const heuristic = await inspectPinnedTextApi(load("type0-heuristic-encoding.pdf"), {}, true);
    const control = await inspectPinnedTextApi(load("type0-tounicode.pdf"), {}, true);
    expect(heuristic.operatorFontKeys).toEqual(["_inspectFont", "compiledGlyphs"]);
    expect(control.operatorFontKeys).toEqual(["_inspectFont", "compiledGlyphs"]);
  }, 60_000);
});

describe("inertness", () => {
  const source = readFileSync(new URL("../src/inputs/adapters/pdf.ts", import.meta.url), "utf8");

  it("hands PDF.js exactly the pinned option set, with no resource location", async () => {
    RECORDED.length = 0;
    await host(SIMPLE);
    expect(RECORDED).toHaveLength(1);
    const parameters = RECORDED[0]!.parameters as Record<string, unknown>;
    for (const [key, value] of Object.entries(PDF_DOCUMENT_OPTIONS)) {
      expect(parameters[key]).toBe(value);
    }
    expect(parameters.useWorkerFetch).toBe(false);
    expect(parameters.useWasm).toBe(false);
    expect(parameters.useSystemFonts).toBe(false);
    expect(parameters.enableXfa).toBe(false);
    expect(parameters.stopAtErrors).toBe(true);
    expect(parameters.isEvalSupported).toBe(false);
    expect(parameters.disableFontFace).toBe(true);
    expect(Object.hasOwn(parameters, "fontExtraProperties")).toBe(false);
    // Nothing that would give PDF.js a place to fetch from.
    for (const forbidden of PDF_FORBIDDEN_RESOURCE_OPTIONS) {
      expect(Object.hasOwn(parameters, forbidden)).toBe(false);
    }
    // Bytes in, not a URL.
    expect(parameters.data).toBeInstanceOf(Uint8Array);
    expect(Object.keys(parameters).sort()).toEqual(
      [...Object.keys(PDF_DOCUMENT_OPTIONS), "data"].sort(),
    );
  });

  it("gives PDF.js a private copy of the bytes, not the host's buffer", async () => {
    RECORDED.length = 0;
    await host(SIMPLE);
    const handed = RECORDED[0]!.parameters.data as Uint8Array;
    // Identity is compared without vitest's pretty-printer, because the buffer
    // handed to PDF.js is detached by the time this runs. That detachment is
    // the point: had the adapter passed the host's own bytes, the host could
    // not have digested the original afterwards.
    expect(handed === SIMPLE).toBe(false);
    expect(handed.byteLength).toBe(0);
    expect(SIMPLE.byteLength).toBeGreaterThan(0);
  });

  it("imports nothing capable of network, filesystem, subprocess, or evaluation", () => {
    // Comments are stripped first: this file's own docstrings name the banned
    // constructs in order to explain why they are absent, and a prose mention
    // is not a call.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .split("\n")
      .filter((line) => !/^\s*\/\//u.test(line))
      .join("\n");
    const importLines = code.split("\n").filter((line) => /^\s*import\b/.test(line));
    const dynamicImports = [...code.matchAll(/import\("([^"]+)"\)/gu)].map((match) => match[1]);
    expect(dynamicImports).toEqual(["pdfjs-dist/legacy/build/pdf.mjs"]);
    for (const banned of [
      "node:fs",
      "node:child_process",
      "node:net",
      "node:http",
      "node:https",
      "node:vm",
      "node:worker_threads",
      "node:dgram",
      "node:os",
      "node:process",
    ]) {
      expect(importLines.some((line) => line.includes(banned))).toBe(false);
      expect(dynamicImports.includes(banned)).toBe(false);
    }
    expect(code.includes("require(")).toBe(false);
    for (const banned of [
      "eval(",
      "new Function(",
      "fetch(",
      "XMLHttpRequest",
      "globalThis.",
      // The two mechanisms that bypass module resolution, and therefore bypass
      // any import-level guard. The shipped PDF.js build uses both; the adapter
      // must not.
      "getBuiltinModule",
      "createRequire",
      // Rendering and extra-font APIs that would be required to read ToUnicode
      // at pdfjs-dist@6.3.289. This adapter is limited to text extraction.
      "getOperatorList",
      "fontExtraProperties",
      "commonObjs",
    ]) {
      expect(code.includes(banned)).toBe(false);
    }
  });

  it("exercises no filesystem, network, subprocess, or evaluator capability while parsing", async () => {
    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchSpy });
    // Fixture bytes are already in memory, so nothing in the measured window
    // needs to touch a file for reasons of this test's own making.
    CAPABILITY.calls.length = 0;
    try {
      for (const [, bytes] of ALL_FIXTURES) {
        await adapterOutcome(bytes);
      }
      expect(CAPABILITY.calls).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    }
  }, 120_000);

  it("sees the build's own import-time capability use, and it is confined to import", () => {
    // This is the proof that the wrapper observes PDF.js and not only this
    // test's own calls: the pinned build runs
    // `getBuiltinModule("module").createRequire(...)("@napi-rs/canvas")` once
    // while it is being evaluated, and the wrapper caught it.
    expect(importTimeCalls).toContain("getBuiltinModule:module");
    // It happens before any document is opened, it is the only capability the
    // build reaches for at import, and the optional package is absent here, so
    // the require fails closed with a warning. Node's own resolver does the
    // filesystem lookup for it, which is outside what this wrapper can observe;
    // that is recorded as a known gap rather than claimed as measured.
    expect(importTimeCalls.filter((call) => call.startsWith("child_process."))).toEqual([]);
    expect(importTimeCalls.filter((call) => call.startsWith("net."))).toEqual([]);
    expect(importTimeCalls.filter((call) => call.startsWith("http"))).toEqual([]);
    expect(importTimeCalls.filter((call) => call.startsWith("os."))).toEqual([]);
  });

  it("records a home-directory read through getBuiltinModule, so emptiness is not blindness", () => {
    CAPABILITY.calls.length = 0;
    const os = process.getBuiltinModule("os");
    os.homedir();
    expect(CAPABILITY.calls).toEqual(["getBuiltinModule:os", "os.homedir"]);
    CAPABILITY.calls.length = 0;
  });

  it("records a subprocess launched through getBuiltinModule, the escape that hid before", async () => {
    // Positive control through the escape that can run a real subprocess. If
    // this stops recording, the emptiness asserted above becomes meaningless.
    CAPABILITY.calls.length = 0;
    const childProcess = process.getBuiltinModule("child_process");
    childProcess.execFileSync(process.execPath, ["-e", "0"], { stdio: "ignore" });
    expect(CAPABILITY.calls).toEqual([
      "getBuiltinModule:child_process",
      "child_process.execFileSync",
    ]);
    CAPABILITY.calls.length = 0;
  });

  it("records a filesystem read reached through getBuiltinModule too", async () => {
    // The mechanism the shipped build actually uses for fs. Wrapping only the
    // ESM `import` of node:fs would miss this entirely.
    CAPABILITY.calls.length = 0;
    const fs = process.getBuiltinModule("fs");
    fs.readFileSync(new URL("../package.json", import.meta.url));
    expect(CAPABILITY.calls).toEqual(["getBuiltinModule:fs", "fs.readFileSync"]);
    CAPABILITY.calls.length = 0;
  });

  it("records a filesystem read reached through an ordinary import as well", async () => {
    CAPABILITY.calls.length = 0;
    const fs = await import("node:fs/promises");
    await fs.readFile(new URL("../package.json", import.meta.url));
    expect(CAPABILITY.calls).toEqual(["fs/promises.readFile"]);
    CAPABILITY.calls.length = 0;
  });

  it("ships a parser build with no evaluator and no host-capability import", () => {
    // The adapter's inertness claim depends on the pinned build, so the build
    // itself is checked rather than only the adapter that configures it.
    for (const file of ["legacy/build/pdf.mjs", "legacy/build/pdf.worker.mjs"]) {
      const build = readFileSync(
        new URL(`../node_modules/pdfjs-dist/${file}`, import.meta.url),
        "utf8",
      );
      expect(build.includes("eval(")).toBe(false);
      expect(build.includes("new Function(")).toBe(false);
      expect(build.includes("node:fs")).toBe(false);
      expect(build.includes("node:http")).toBe(false);
      expect(build.includes("child_process")).toBe(false);
      expect(build.includes("worker_threads")).toBe(false);
    }
  });
});

describe("unit rules the page classification depends on", () => {
  it("flags the exact code points PDF.js uses for an unmapped glyph", () => {
    expect(hasUnmappableGlyph("012")).toBe(false);
    expect(hasUnmappableGlyph("Accents: café, señor, über, façade.")).toBe(false);
    expect(hasUnmappableGlyph("tab\tand\nnewline")).toBe(false);
    expect(hasUnmappableGlyph("emoji \u{1F600} is a real character")).toBe(false);
    expect(hasUnmappableGlyph("�")).toBe(true);
    expect(hasUnmappableGlyph("")).toBe(true);
    expect(hasUnmappableGlyph("")).toBe(true);
    expect(hasUnmappableGlyph("\u{F0000}")).toBe(true);
    expect(hasUnmappableGlyph("\u{10FFFD}")).toBe(true);
    expect(hasUnmappableGlyph("lone high \uD800 surrogate")).toBe(true);
    expect(hasUnmappableGlyph("lone low \uDC00 surrogate")).toBe(true);
    expect(hasUnmappableGlyph("control  bell")).toBe(true);
    expect(hasUnmappableGlyph("delete ")).toBe(true);
  });

  it("joins page items in PDF.js order and guesses no whitespace", () => {
    expect(
      joinPdfTextItems([
        { str: "first", hasEOL: true },
        { str: "second", hasEOL: false },
      ]),
    ).toBe("first\nsecond");
    expect(
      joinPdfTextItems([
        { str: "a", hasEOL: false },
        { str: "b", hasEOL: false },
      ]),
    ).toBe("ab");
    expect(joinPdfTextItems([{ str: "trailing", hasEOL: true }])).toBe("trailing");
    expect(joinPdfTextItems([])).toBe("");
  });

  it("keeps the shipped configuration frozen and finite", () => {
    expect(Object.isFrozen(PDF_DOCUMENT_OPTIONS)).toBe(true);
    expect(Object.isFrozen(pdfSourceExtractorAdapter)).toBe(true);
    expect(Object.isFrozen(pdfSourceExtractorAdapter.defaultOptions)).toBe(true);
    expect(PDF_MAX_PAGES).toBe(100);
    for (const forbidden of PDF_FORBIDDEN_RESOURCE_OPTIONS) {
      expect(Object.hasOwn(PDF_DOCUMENT_OPTIONS, forbidden)).toBe(false);
      expect(Object.hasOwn(pdfSourceExtractorAdapter.defaultOptions, forbidden)).toBe(false);
    }
  });
});

/**
 * Registry-level integration proof. Everything between the registry and a
 * readable, cited PDF span is proven here, against
 * the real seam and the real process-local source-evidence service: a media
 * type resolves the PDF adapter, the host seals a representation, that
 * representation becomes a `SourceObservationV1` and a `SourceBindingV1`, a
 * step reader issued from that binding returns the page text, and the required
 * coverage gate distinguishes a read span from an unread one.
 */
describe("integration: registry to a cited PDF span", () => {
  const RUN_ID = "run-837-pdf-integration";
  const REVISION = "c".repeat(40);
  const REPOSITORY_IDENTITY = createHash("sha256").update("/workspace/docsfab").digest("hex");
  const WORKSPACE_IDENTITY = createHash("sha256").update("workspace-identity-837").digest("hex");
  const CONTENT_DIGEST = createHash("sha256").update("content-837").digest("hex");
  const PRODUCER_ID = "workspace-tracked-files";
  const PRODUCER_SCOPE = createHash("sha256").update("tracked-files-scope").digest("hex");
  const PRODUCER_SCOPES = [{ producerId: PRODUCER_ID, scopeSha256: PRODUCER_SCOPE }];
  const POLICY = createSourceStepPolicy({
    sourceReadSkills: ["write-documentation", "verify-technical-accuracy"],
    perStepBudgetBytes: 8 * 1024,
  });
  const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const OBSERVATION_ID = "obs-release-notes-pdf";

  async function buildPdfChain(bytes: Uint8Array = SIMPLE) {
    const requestSha256 = projectSourceRequestContext(
      {
        workflow: "create-documentation",
        workspacePath: "/workspace/docsfab",
        repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
        allowWrite: true,
      },
      {
        runId: RUN_ID,
        workspaceIdentitySha256: WORKSPACE_IDENTITY,
        repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
      },
    );

    // The registry, not a direct import: a registration mistake fails here.
    const adapter = REGISTRY.resolve("application/pdf");
    if (!adapter) throw new Error("the default registry does not carry a PDF adapter");
    const { representation, derivative } = await extractSourceRepresentation({
      adapter,
      bytes,
      mediaType: PDF_MEDIA_TYPE,
    });

    const observation = createSourceObservation({
      observationId: OBSERVATION_ID,
      originIdSha256: sha("origin-pdf"),
      inputId: "input-release-notes-pdf",
      registrationSha256: sha("registration-pdf"),
      runIdSha256: sha(RUN_ID),
      repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
      requestSha256,
      producerId: PRODUCER_ID,
      producerVersion: "1",
      producerScopeSha256: PRODUCER_SCOPE,
      acquisitionReceiptSha256: sha("receipt-pdf"),
      observedAt: "2026-09-15T09:00:00.000Z",
      original: {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
        mediaType: PDF_MEDIA_TYPE,
        locatorSha256: sha("docs/release-notes.pdf"),
        version: { kind: "repository-revision", revision: REVISION },
        repositoryPath: "docs/release-notes.pdf",
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
      observations: [
        { observationId: OBSERVATION_ID, observationSha256: observation.observationSha256 },
      ],
      requiredObservationIds: [OBSERVATION_ID],
    });
    const capture = openExternalInputAccessCapture({
      runIdSha256: sha(RUN_ID),
      repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
    });
    const { contentDigestSha256 } = registerFakeExternalInput(capture, observation.inputId, {
      adapterKind: "repository-document",
      canonicalLocator: "repository-document:docs/release-notes.pdf",
      safeTitle: "Release notes, PDF",
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
      now: () => new Date("2026-09-15T09:05:00.000Z"),
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
    return { binding, capability, observation, representation };
  }

  it("returns the exact page text through a host-issued step reader", async () => {
    const { capability, representation } = await buildPdfChain();
    const reader = capability.forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    });
    expect(reader).toBeDefined();
    const pageOne = representation.spans.find(
      (span) => span.locator.kind === "pdf-page" && span.locator.pageNumber === 1,
    );
    expect(pageOne).toBeDefined();
    const read = reader!.read({
      observationId: OBSERVATION_ID,
      representationId: representation.representationId,
      spanIds: [pageOne!.spanId],
    });
    expect(read.text).toBe(PAGE_ONE_TEXT);
    expect(read.spanAccess.stepId).toBe("write-documentation");
    expect(read.spanAccess.spanIds).toEqual([pageOne!.spanId]);
  });

  it("carries pdf-page locators all the way into the sealed binding", async () => {
    const { capability } = await buildPdfChain();
    const observation = capability.observations[0]!;
    const locators = observation.representations[0]!.spans.map((span) => span.locator);
    expect(locators).toEqual([
      { kind: "pdf-page", pageNumber: 1, itemStart: 0, itemEnd: 2 },
      { kind: "pdf-page", pageNumber: 2, itemStart: 0, itemEnd: 2 },
    ]);
  });

  it("blocks the write when the required PDF span was never read", async () => {
    const { binding, capability, observation } = await buildPdfChain();
    // No step reads anything, so the required observation stays unread.
    const unread = assembleSourceEvidenceFinal({
      binding,
      observations: [observation],
      spanAccesses: capability.spanAccesses(),
      spanCitations: [],
      externalInputManifestSha256: sha("manifest-pdf"),
      accessLedgerSha256: sha("access-ledger-pdf"),
      citationLedgerSha256: sha("citation-ledger-pdf"),
    });
    expect(unread.requiredCoverage).toEqual([{ observationId: OBSERVATION_ID, status: "unread" }]);
    expect(sourceEvidenceRequiredGapCodes(unread)).not.toEqual([]);
  });

  it("clears the write gate once a step has actually read the PDF span", async () => {
    const { binding, capability, observation, representation } = await buildPdfChain();
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
      externalInputManifestSha256: sha("manifest-pdf"),
      accessLedgerSha256: sha("access-ledger-pdf"),
      citationLedgerSha256: sha("citation-ledger-pdf"),
    });
    expect(read.requiredCoverage).toEqual([
      { observationId: OBSERVATION_ID, status: "considered" },
    ]);
    expect(sourceEvidenceRequiredGapCodes(read)).toEqual([]);
  });

  it("accepts a writer citation of a PDF span the verifier already read", async () => {
    const { binding, capability, observation, representation } = await buildPdfChain();
    const reader = capability.forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    });
    const pageOne = representation.spans[0]!;
    const read = reader!.read({
      observationId: OBSERVATION_ID,
      representationId: representation.representationId,
      spanIds: [pageOne.spanId],
    });
    const citation = createSourceSpanCitation({
      bindingSha256: binding.bindingSha256,
      observationId: OBSERVATION_ID,
      representationId: representation.representationId,
      representationSha256: representation.representationSha256,
      stepId: "write-documentation",
      spanIds: [pageOne.spanId],
      spanAccessSha256s: [read.spanAccess.spanAccessSha256],
      supportedClaimSha256: sha("claim-page-one"),
      externalInputCitationSha256: sha("external-citation-pdf"),
    });
    expect(
      verifySourceSpanCitations({
        binding,
        observations: [observation],
        spanAccesses: capability.spanAccesses(),
        spanCitations: [citation],
        materialClaimSha256s: [sha("claim-page-one")],
      }),
    ).toEqual([]);
  });

  it("rejects a writer citation of a PDF page nobody read", async () => {
    const { binding, capability, observation, representation } = await buildPdfChain();
    const reader = capability.forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    });
    const pageOne = representation.spans[0]!;
    const pageTwo = representation.spans[1]!;
    const read = reader!.read({
      observationId: OBSERVATION_ID,
      representationId: representation.representationId,
      spanIds: [pageOne.spanId],
    });
    const citation = createSourceSpanCitation({
      bindingSha256: binding.bindingSha256,
      observationId: OBSERVATION_ID,
      representationId: representation.representationId,
      representationSha256: representation.representationSha256,
      stepId: "write-documentation",
      spanIds: [pageTwo.spanId],
      spanAccessSha256s: [read.spanAccess.spanAccessSha256],
      supportedClaimSha256: sha("claim-unread-page"),
      externalInputCitationSha256: sha("external-citation-unread"),
    });
    expect(
      verifySourceSpanCitations({
        binding,
        observations: [observation],
        spanAccesses: capability.spanAccesses(),
        spanCitations: [citation],
        materialClaimSha256s: [],
      }),
    ).toEqual([{ supportedClaimSha256: sha("claim-unread-page"), code: "unread-span" }]);
  });

  it("carries honest partial limitations into the sealed final evidence", async () => {
    const acroform = load("acroform.pdf");
    const { binding, capability, observation, representation } = await buildPdfChain(acroform);
    expect(representation.completeness).toBe("partial");
    expect(representation.limitations).toContain("active-content-excluded");
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
    const final = assembleSourceEvidenceFinal({
      binding,
      observations: [observation],
      spanAccesses: capability.spanAccesses(),
      spanCitations: [],
      externalInputManifestSha256: sha("manifest-pdf"),
      accessLedgerSha256: sha("access-ledger-pdf"),
      citationLedgerSha256: sha("citation-ledger-pdf"),
    });
    expect(final.limitations).toEqual([
      { observationId: OBSERVATION_ID, reasonCode: "active-content-excluded" },
    ]);
    expect(final.requiredCoverage).toEqual([{ observationId: OBSERVATION_ID, status: "partial" }]);
  });
});
