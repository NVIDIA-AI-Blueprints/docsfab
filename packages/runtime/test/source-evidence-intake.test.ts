// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  admitRunSourceBinding,
  assembleSourceEvidenceFinal,
  computeSourceRequestSha256,
  createExternalInputAccessLedger,
  createSourceArtifactReference,
  createSourceBinding,
  createSourceEvidenceHostAuthority,
  createSourceEvidenceService,
  createSourceExtractorRegistry,
  createSourceObservation,
  createSourceRepresentation,
  createSourceSpanAccess,
  computeSourceSpanId,
  createSourceSpanCitation,
  createSourceStepPolicy,
  decodeSourceArtifactReference,
  decodeSourceBinding,
  decodeSourceObservation,
  decodeSourceSpanAccess,
  digestSourceExtractorOptions,
  digestSourceProducerScopes,
  extractSourceRepresentation,
  type ExtractSourceRepresentationResult,
  htmlSourceExtractorAdapter,
  normalizeMediaType,
  openExternalInputAccessCapture,
  originalBudgetExceededError,
  projectSourceRequestContext,
  recordExternalInputAccess,
  registerFakeExternalInput,
  SOURCE_EXTRACTION_ERROR_CODES,
  SOURCE_LOCATOR_KINDS,
  SourceArtifactReferenceError,
  SourceEvidenceContractError,
  type SourceEvidenceHostVerifier,
  sourceEvidenceRequiredGapCodes,
  SourceEvidenceServiceError,
  SOURCE_EXACT_ORIGINAL_FORM,
  sourceExactOriginalCoverage,
  sourceRequiredCoverage,
  SourceExtractionError,
  type SourceExtractionLimitsV1,
  type SourceExtractionRequestV1,
  type SourceExtractionResultV1,
  type SourceExtractorAdapterV1,
  type SourceObservationV1,
  sourceRepositoryContentDigest,
  stepAdmitsSourceRead,
  verifySourceSpanCitations,
} from "../src/inputs/index.js";
import * as application from "../src/application/index.js";
import { executeWorkflowRun } from "../src/cli/run/execution.js";
import * as readerAdmission from "../src/execution/reader-task-admission.js";
import * as taskContext from "../src/execution/task-context.js";
import * as qualityPack from "../src/quality-pack/manifest.js";
import type { ArtifactReference } from "../src/artifacts/index.js";
import type { WorkflowBranchEvidenceHost } from "../src/workflow-contracts/contracts.js";
import * as editorialAssembly from "../src/workflow-execution/editorial-evidence-assembly.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { configureCredential } from "./helpers/configured-credential.js";

const fixtureUrl = (name: string) =>
  new URL(`./fixtures/source-evidence/html/${name}`, import.meta.url);
const HTML = new Uint8Array(readFileSync(fixtureUrl("release-notes.html")));
const DIVERGENT_HTML = new Uint8Array(readFileSync(fixtureUrl("divergent-release-notes.html")));

/**
 * The extraction seam is async, and the record-shape cases below build
 * the same two fixture chains dozens of times. Extract each fixture once here
 * so `buildChain` stays synchronous and those cases keep reading as record
 * cases rather than as await plumbing.
 */
const EXTRACTIONS = new Map<Uint8Array, ExtractSourceRepresentationResult>([
  [
    HTML,
    await extractSourceRepresentation({
      adapter: htmlSourceExtractorAdapter,
      bytes: HTML,
      mediaType: "text/html; charset=utf-8",
    }),
  ],
  [
    DIVERGENT_HTML,
    await extractSourceRepresentation({
      adapter: htmlSourceExtractorAdapter,
      bytes: DIVERGENT_HTML,
      mediaType: "text/html; charset=utf-8",
    }),
  ],
]);

const RUN_ID = "run-835-source";
const REVISION = "a".repeat(40);
const REPOSITORY_IDENTITY = createHash("sha256").update("/workspace/docsfab").digest("hex");
const WORKSPACE_IDENTITY = createHash("sha256").update("workspace-identity").digest("hex");
const TREE_DIGEST = createHash("sha256").update("tree").digest("hex");
const CONTENT_DIGEST = sourceRepositoryContentDigest({
  identitySha256: REPOSITORY_IDENTITY,
  revision: REVISION,
  treeSha256: TREE_DIGEST,
});
const PRODUCER_ID = "workspace-tracked-files";
const PRODUCER_SCOPE = createHash("sha256").update("tracked-files-scope").digest("hex");
const PRODUCER_SCOPES = [{ producerId: PRODUCER_ID, scopeSha256: PRODUCER_SCOPE }];
const POLICY = createSourceStepPolicy({
  sourceReadSkills: ["write-documentation", "verify-technical-accuracy"],
  perStepBudgetBytes: 8 * 1024,
});
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const READER_SENTENCE = "The runtime reads a tracked source only through a host-issued reader.";
const UNCITED_SENTENCE = "A derived line is never reported as a line in the original binary.";

const REQUEST = {
  workflow: "create-documentation",
  workspacePath: "/workspace/docsfab",
  repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
  allowWrite: false,
  instruction: "Document the release notes page.",
};

function requestSha256(overrides: Record<string, unknown> = {}): string {
  return projectSourceRequestContext(
    { ...REQUEST, ...overrides },
    {
      runId: RUN_ID,
      workspaceIdentitySha256: WORKSPACE_IDENTITY,
      repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
    },
  );
}

interface Chain {
  observation: SourceObservationV1;
  derivative: Uint8Array;
  binding: ReturnType<typeof createSourceBinding>;
  reference: ReturnType<typeof createSourceArtifactReference<"source-binding">>;
  representationId: string;
  spanIds: string[];
  spanTexts: string[];
}

function buildChain(
  options: {
    bytes?: Uint8Array;
    observationId?: string;
    required?: boolean;
    request?: string;
    producerScopeSha256?: string;
  } = {},
): Chain {
  const bytes = options.bytes ?? HTML;
  const observationId = options.observationId ?? "obs-release-notes";
  const request = options.request ?? requestSha256();
  const extraction = EXTRACTIONS.get(bytes);
  if (!extraction)
    throw new Error("buildChain has no pre-extracted representation for these bytes");
  const { representation, derivative } = extraction;
  const observation = createSourceObservation({
    observationId,
    originIdSha256: sha(`origin:${observationId}`),
    inputId: `input-${observationId}`,
    registrationSha256: sha(`registration:${observationId}`),
    runIdSha256: sha(RUN_ID),
    repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
    requestSha256: request,
    producerId: PRODUCER_ID,
    producerVersion: "1",
    producerScopeSha256: options.producerScopeSha256 ?? PRODUCER_SCOPE,
    acquisitionReceiptSha256: sha(`receipt:${observationId}`),
    observedAt: "2026-09-14T18:00:00.000Z",
    original: {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
      mediaType: "text/html",
      locatorSha256: sha("docs/release-notes.html"),
      version: { kind: "repository-revision", revision: REVISION },
      repositoryPath: "docs/release-notes.html",
    },
    representations: [representation],
  });
  const binding = createSourceBinding({
    runIdSha256: sha(RUN_ID),
    repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
    requestSha256: request,
    hostPolicySha256: POLICY.policySha256,
    producerScopeSha256: digestSourceProducerScopes(PRODUCER_SCOPES),
    parentBindingSha256: null,
    observations: [{ observationId, observationSha256: observation.observationSha256 }],
    requiredObservationIds: options.required === false ? [] : [observationId],
  });
  const reference = createSourceArtifactReference({
    kind: "source-binding",
    digest: binding.bindingSha256,
    repositoryRevision: REVISION,
    repositoryContentDigest: CONTENT_DIGEST,
  });
  return {
    observation,
    derivative,
    binding,
    reference,
    representationId: representation.representationId,
    spanIds: representation.spans.map((span) => span.spanId),
    spanTexts: representation.spans.map((span) =>
      Buffer.from(derivative.subarray(span.startByte, span.endByte)).toString("utf8"),
    ),
  };
}

/** Resolve a span by the exact derivative text it quotes. */
function spanFor(chain: Chain, text: string): string {
  const index = chain.spanTexts.indexOf(text);
  if (index === -1) throw new Error(`fixture has no span quoting: ${text}`);
  return chain.spanIds[index]!;
}

function buildVerifier(
  chain: Chain,
  overrides: Partial<SourceEvidenceHostVerifier> = {},
): SourceEvidenceHostVerifier {
  const { capture, contentDigestSha256 } = openLedger(chain);
  return {
    verifyCurrent: () => undefined,
    hostPolicySha256: POLICY.policySha256,
    producerScopes: PRODUCER_SCOPES,
    resolveBinding: (digest) =>
      digest === chain.binding.bindingSha256 ? chain.binding : undefined,
    resolveObservation: (observationId) =>
      observationId === chain.observation.observationId ? chain.observation : undefined,
    resolveDerivative: ({ representationId }) =>
      representationId === chain.representationId ? chain.derivative : undefined,
    recordAccess: ({ stepId, spanIds }) =>
      recordExternalInputAccess(capture, {
        inputId: chain.observation.inputId,
        stepId,
        outcome: "opened",
        observedContentDigestSha256: contentDigestSha256,
        accessorId: "docsfab-read-source",
        evidenceSha256s: [sha(spanIds.join(","))],
      }).observationSha256,
    now: () => new Date("2026-09-14T18:05:00.000Z"),
    ...overrides,
  };
}

/** Real external-input access ledger, not a stub, joined to the source reader. */
function openLedger(chain: Chain) {
  const capture = openExternalInputAccessCapture({
    runIdSha256: sha(RUN_ID),
    repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
  });
  const { contentDigestSha256 } = registerFakeExternalInput(capture, chain.observation.inputId, {
    adapterKind: "repository-document",
    canonicalLocator: "repository-document:docs/release-notes.html",
    safeTitle: "Release notes",
    body: Buffer.from(chain.derivative).toString("utf8"),
    version: { kind: "repository-revision", revision: REVISION },
    visibility: "internal",
    disclosurePolicy: "cite-and-quote",
    intendedRoles: ["evidence"],
  });
  if (!contentDigestSha256) throw new Error("fixture registration produced no content digest");
  return { capture, contentDigestSha256 };
}

function bind(chain: Chain, verifier: SourceEvidenceHostVerifier, context = {}) {
  const service = createSourceEvidenceService(createSourceEvidenceHostAuthority(verifier));
  return service.bindRun(chain.reference, {
    runId: RUN_ID,
    requestSha256: requestSha256(),
    repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
    workspaceIdentitySha256: WORKSPACE_IDENTITY,
    repositoryContentDigest: CONTENT_DIGEST,
    ...context,
  });
}

function expectServiceCode(run: () => unknown, code: string): void {
  expect(run).toThrowError(SourceEvidenceServiceError);
  try {
    run();
    throw new Error("expected a refusal");
  } catch (error) {
    expect((error as SourceEvidenceServiceError).code).toBe(code);
  }
}

function expectContractCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error("expected a contract rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(SourceEvidenceContractError);
    expect((error as SourceEvidenceContractError).code).toBe(code);
  }
}

describe("HTML derivative extraction", () => {
  it("extracts only inert readable text and names what it excluded", async () => {
    const { representation, derivative } = await extractSourceRepresentation({
      adapter: htmlSourceExtractorAdapter,
      bytes: HTML,
      mediaType: "text/html",
    });
    const text = Buffer.from(derivative).toString("utf8");
    expect(text).toContain("The runtime reads a tracked source only through a host-issued reader.");
    expect(text).toContain("Quoted entities such as & and <tag> survive extraction.");
    expect(text).not.toContain("__tracking");
    expect(text).not.toContain("Draft note that is not published yet.");
    expect(text).not.toContain("Internal reviewer scratch text.");
    expect(text).not.toContain("Reviewer comment");
    expect(text).not.toContain("color: #111");
    expect(representation.completeness).toBe("partial");
    expect(representation.limitations).toEqual([
      "active-content-excluded",
      "hidden-content-excluded",
    ]);
    expect(representation.mediaType).toBe("text/plain; charset=utf-8");
  });

  it("emits html-node locators whose derivative spans quote the exact bytes", async () => {
    const { representation, derivative } = await extractSourceRepresentation({
      adapter: htmlSourceExtractorAdapter,
      bytes: HTML,
      mediaType: "text/html",
    });
    expect(representation.spans.length).toBeGreaterThan(4);
    for (const span of representation.spans) {
      expect(span.locator.kind).toBe("html-node");
      expect(span.endByte).toBeGreaterThan(span.startByte);
      expect(span.endByte).toBeLessThanOrEqual(representation.byteLength);
    }
    const quoted = representation.spans.map((entry) =>
      Buffer.from(derivative.subarray(entry.startByte, entry.endByte)).toString("utf8"),
    );
    expect(quoted).toContain(READER_SENTENCE);
    expect(quoted).toContain("Quoted entities such as & and <tag> survive extraction.");
    const ordered = [...representation.spans].sort(
      (left, right) => left.startByte - right.startByte,
    );
    for (let index = 1; index < ordered.length; index += 1) {
      expect(ordered[index]!.startByte).toBeGreaterThanOrEqual(ordered[index - 1]!.endByte);
    }
  });

  it("keeps the derivative digest distinct from the original digest", async () => {
    const { representation } = await extractSourceRepresentation({
      adapter: htmlSourceExtractorAdapter,
      bytes: HTML,
      mediaType: "text/html",
    });
    const originalSha256 = createHash("sha256").update(HTML).digest("hex");
    expect(representation.originalSha256).toBe(originalSha256);
    expect(representation.sha256).not.toBe(originalSha256);
  });

  it("gives divergent originals divergent representation and span identities", async () => {
    const first = await extractSourceRepresentation({
      adapter: htmlSourceExtractorAdapter,
      bytes: HTML,
      mediaType: "text/html",
    });
    const second = await extractSourceRepresentation({
      adapter: htmlSourceExtractorAdapter,
      bytes: DIVERGENT_HTML,
      mediaType: "text/html",
    });
    expect(second.representation.representationId).not.toBe(first.representation.representationId);
    const shared = first.representation.spans.filter((span) =>
      second.representation.spans.some((other) => other.spanId === span.spanId),
    );
    expect(shared).toHaveLength(0);
  });

  it("refuses an adapter that does not claim the media type", async () => {
    await expect(
      extractSourceRepresentation({
        adapter: htmlSourceExtractorAdapter,
        bytes: HTML,
        mediaType: "application/pdf",
      }),
    ).rejects.toThrowError(new SourceExtractionError("unsupported-media-type"));
  });

  it("fails closed rather than truncating an oversized original", async () => {
    const refused = extractSourceRepresentation({
      adapter: htmlSourceExtractorAdapter,
      bytes: HTML,
      mediaType: "text/html",
      limits: { maxOriginalBytes: 16 },
    });
    await expect(refused).rejects.toThrowError(originalBudgetExceededError(HTML.byteLength, 16));
    // The line names the bound in force, the 16 bytes this call allowed, not the catalog's.
    await expect(refused).rejects.toThrowError(
      `sources-extraction-max-original-bytes-bound: ${HTML.byteLength} exceeds sources.extractionMaxOriginalBytes = 16 bytes.`,
    );
  });

  it("truncates the derivative under a byte budget and says so", async () => {
    const { representation } = await extractSourceRepresentation({
      adapter: htmlSourceExtractorAdapter,
      bytes: HTML,
      mediaType: "text/html",
      limits: { maxDerivativeBytes: 120 },
    });
    expect(representation.completeness).toBe("partial");
    expect(representation.limitations).toContain("byte-budget-truncated");
    expect(representation.byteLength).toBeLessThanOrEqual(120);
  });

  it("truncates spans under a span budget and says so", async () => {
    const { representation } = await extractSourceRepresentation({
      adapter: htmlSourceExtractorAdapter,
      bytes: HTML,
      mediaType: "text/html",
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
        adapter: htmlSourceExtractorAdapter,
        bytes: HTML,
        mediaType: "text/html",
        signal: controller.signal,
      }),
    ).rejects.toThrowError(new SourceExtractionError("extraction-cancelled"));
  });

  it("resolves adapters by parameter-free media type and rejects duplicates", () => {
    const registry = createSourceExtractorRegistry([htmlSourceExtractorAdapter]);
    expect(normalizeMediaType("TEXT/HTML; charset=UTF-8")).toBe("text/html");
    expect(registry.resolve("text/html; charset=utf-8")).toBe(htmlSourceExtractorAdapter);
    expect(registry.resolve("application/pdf")).toBeUndefined();
    expect(() =>
      createSourceExtractorRegistry([htmlSourceExtractorAdapter, htmlSourceExtractorAdapter]),
    ).toThrowError(new SourceExtractionError("duplicate-adapter"));
  });

  it("rejects configured-credential extractor options before they are digested", () => {
    const header = configureCredential(["eyJhbGciOiJ", "IUzI1NiIs", "InR5cCI6Ikp"].join("."));
    expect(() => digestSourceExtractorOptions({ header })).toThrowError(
      SourceEvidenceContractError,
    );
    // An option with a credential shape that is not one of DocsFab's own
    // configured credentials is digested like any other (#1807).
    const shaped = ["eyJ0eXAiOiJ", "KV1QiLCJhbG", "ciOiJSUzI1N"].join(".");
    expect(digestSourceExtractorOptions({ header: shaped })).toMatch(/^[0-9a-f]{64}$/u);
  });
});

/**
 * The seam accepts a promise-returning adapter so a packaged parser with a
 * promise-only API (PDF.js) can plug in without a second execution path.
 * These cases pin the part that matters: the async adapter runs inside the same
 * budget, deadline, and cancellation wrapper a synchronous one does, and a
 * deadline is a real loss, not a slow success.
 */
describe("async-capable extraction seam", () => {
  const TEXT_LOCATOR = (index: number) =>
    ({ kind: "text" as const, startByte: index, endByte: index + 1 }) satisfies {
      kind: "text";
      startByte: number;
      endByte: number;
    };

  const SEGMENTS: SourceExtractionResultV1 = {
    segments: [
      { text: "Alpha paragraph.", locator: TEXT_LOCATOR(0) },
      { text: "Beta paragraph.", locator: TEXT_LOCATOR(1) },
    ],
    limitations: [],
  };

  /** Same id, version, options, and segments as `syncTwin`; only the shape differs. */
  function adapterOf(
    extract: SourceExtractorAdapterV1["extract"],
    abort?: SourceExtractorAdapterV1["abort"],
  ): SourceExtractorAdapterV1 {
    return Object.freeze({
      id: "async-fixture",
      version: "1",
      locatorKind: "text" as const,
      mediaTypes: Object.freeze(["text/plain"]),
      defaultOptions: Object.freeze({ pinned: true }),
      extract,
      ...(abort ? { abort } : {}),
    });
  }

  const BYTES = new TextEncoder().encode("Alpha paragraph.\nBeta paragraph.\n");
  const syncTwin = adapterOf(() => structuredClone(SEGMENTS));
  const asyncTwin = adapterOf(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return structuredClone(SEGMENTS);
  });

  const run = (adapter: SourceExtractorAdapterV1, limits?: Partial<SourceExtractionLimitsV1>) =>
    extractSourceRepresentation({
      adapter,
      bytes: BYTES,
      mediaType: "text/plain",
      ...(limits ? { limits } : {}),
    });

  it("seals a promise-returning adapter that resolves inside the deadline", async () => {
    const { representation, derivative } = await run(asyncTwin);
    expect(representation.spans).toHaveLength(2);
    expect(representation.completeness).toBe("complete");
    expect(Buffer.from(derivative).toString("utf8")).toBe("Alpha paragraph.\nBeta paragraph.");
  });

  it("gives a sync and an async adapter producing the same segments identical digests", async () => {
    const sync = await run(syncTwin);
    const async = await run(asyncTwin);
    expect(async.representation.sha256).toBe(sync.representation.sha256);
    expect(async.representation.extractor.optionsSha256).toBe(
      sync.representation.extractor.optionsSha256,
    );
    expect(async.representation.representationId).toBe(sync.representation.representationId);
    expect(async.representation.spans.map((span) => span.spanId)).toEqual(
      sync.representation.spans.map((span) => span.spanId),
    );
    expect(Buffer.from(async.derivative).toString("utf8")).toBe(
      Buffer.from(sync.derivative).toString("utf8"),
    );
  });

  it("refuses an adapter that never resolves once the wall-clock deadline fires", async () => {
    const stuck = adapterOf(() => new Promise<SourceExtractionResultV1>(() => undefined));
    await expect(run(stuck, { maxExtractionMs: 25 })).rejects.toThrowError(
      new SourceExtractionError("extraction-deadline-exceeded"),
    );
  });

  it("discards what a timed-out adapter had already produced instead of sealing it", async () => {
    // The adapter builds complete, well-formed segments before it hangs, so an
    // implementation that sealed "whatever arrived by the deadline" would
    // return a representation here instead of refusing. A partial parse is not
    // a source.
    const produced: SourceExtractionSegmentSink = [];
    const partial = adapterOf(() => {
      produced.push(...structuredClone(SEGMENTS).segments);
      return new Promise<SourceExtractionResultV1>(() => undefined);
    });
    await expect(run(partial, { maxExtractionMs: 25 })).rejects.toThrowError(
      new SourceExtractionError("extraction-deadline-exceeded"),
    );
    expect(produced).toHaveLength(2);
  });

  it("refuses a rejecting adapter without leaking its error to the caller", async () => {
    const secret = "original byte 0x4a5b in object 12 near /Author (a.chen)";
    const rejecting = adapterOf(async () => {
      throw new Error(secret);
    });
    const error = await run(rejecting).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SourceExtractionError);
    expect((error as SourceExtractionError).code).toBe("adapter-failed");
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).not.toContain("0x4a5b");
    expect(JSON.stringify((error as Error).stack ?? "")).not.toContain("a.chen");
  });

  it("throws the same fixed code when the adapter throws synchronously", async () => {
    const throwing = adapterOf(() => {
      throw new Error("synchronous parser blowup");
    });
    await expect(run(throwing)).rejects.toThrowError(new SourceExtractionError("adapter-failed"));
  });

  it("discards a result that arrives after the deadline already fired", async () => {
    let resolvedLate = false;
    const late = adapterOf(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      resolvedLate = true;
      return structuredClone(SEGMENTS);
    });
    await expect(run(late, { maxExtractionMs: 20 })).rejects.toThrowError(
      new SourceExtractionError("extraction-deadline-exceeded"),
    );
    await new Promise((resolve) => setTimeout(resolve, 180));
    // The adapter did finish, and its result was still never sealed or
    // returned. A late success is not a success.
    expect(resolvedLate).toBe(true);
  });

  it("aborts the request signal and calls the adapter abort hook on a deadline", async () => {
    let abortedSignal = false;
    let abortHookCalls = 0;
    const cancellable = adapterOf(
      (request: SourceExtractionRequestV1) =>
        new Promise<SourceExtractionResultV1>(() => {
          request.signal?.addEventListener("abort", () => {
            abortedSignal = true;
          });
        }),
      () => {
        abortHookCalls += 1;
      },
    );
    await expect(run(cancellable, { maxExtractionMs: 25 })).rejects.toThrowError(
      new SourceExtractionError("extraction-deadline-exceeded"),
    );
    expect(abortedSignal).toBe(true);
    expect(abortHookCalls).toBe(1);
  });

  it("aborts the request signal when the caller cancels mid-flight", async () => {
    const controller = new AbortController();
    let abortedSignal = false;
    const cancellable = adapterOf(
      (request: SourceExtractionRequestV1) =>
        new Promise<SourceExtractionResultV1>((resolve) => {
          request.signal?.addEventListener("abort", () => {
            abortedSignal = true;
            resolve(structuredClone(SEGMENTS));
          });
        }),
    );
    const pending = extractSourceRepresentation({
      adapter: cancellable,
      bytes: BYTES,
      mediaType: "text/plain",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toThrowError(new SourceExtractionError("extraction-cancelled"));
    expect(abortedSignal).toBe(true);
  });

  it("never runs the abort hook when the adapter succeeds in time", async () => {
    let abortHookCalls = 0;
    const clean = adapterOf(
      async () => structuredClone(SEGMENTS),
      () => {
        abortHookCalls += 1;
      },
    );
    await run(clean);
    expect(abortHookCalls).toBe(0);
  });

  it("never runs the abort hook when the adapter fails in time either", async () => {
    // An adapter that failed on its own time has already finished, so the
    // teardown must not fire on this non-success.
    let abortHookCalls = 0;
    const failing = adapterOf(
      async () => {
        throw new Error("parser gave up on its own time");
      },
      () => {
        abortHookCalls += 1;
      },
    );
    await expect(run(failing)).rejects.toThrowError(new SourceExtractionError("adapter-failed"));
    expect(abortHookCalls).toBe(0);
  });

  it("keeps the refusal when an adapter abort hook itself throws", async () => {
    const hostile = adapterOf(
      () => new Promise<SourceExtractionResultV1>(() => undefined),
      () => {
        throw new Error("teardown exploded");
      },
    );
    await expect(run(hostile, { maxExtractionMs: 25 })).rejects.toThrowError(
      new SourceExtractionError("extraction-deadline-exceeded"),
    );
  });

  it("rejects a misconfigured budget as invalid-limits, not as a missed deadline", async () => {
    // A caller mistake and a document that genuinely ran long are different
    // events, and an operator reading a refusal code has to be able to tell
    // them apart. Every finite-positive violation is checked, on every limit.
    const cases: Array<[string, Partial<SourceExtractionLimitsV1>]> = [
      ["zero deadline", { maxExtractionMs: 0 }],
      ["negative deadline", { maxExtractionMs: -1 }],
      ["NaN deadline", { maxExtractionMs: Number.NaN }],
      ["infinite deadline", { maxExtractionMs: Number.POSITIVE_INFINITY }],
      ["zero original budget", { maxOriginalBytes: 0 }],
      ["negative derivative budget", { maxDerivativeBytes: -1 }],
      ["NaN span budget", { maxSpans: Number.NaN }],
    ];
    for (const [label, limits] of cases) {
      let ran = false;
      const spy = adapterOf(() => {
        ran = true;
        return structuredClone(SEGMENTS);
      });
      await expect(run(spy, limits), label).rejects.toThrowError(
        new SourceExtractionError("invalid-limits"),
      );
      expect(ran, label).toBe(false);
    }
  });

  it("rejects an adapter whose abort hook is not callable", async () => {
    const broken = {
      ...adapterOf(() => structuredClone(SEGMENTS)),
      abort: "stop" as unknown as SourceExtractorAdapterV1["abort"],
    };
    await expect(run(broken)).rejects.toThrowError(new SourceExtractionError("adapter-invalid"));
  });

  it("cannot preempt a CPU-bound adapter, and says so instead of pretending", async () => {
    // The deadline is not preemption. Its timer runs on this process's event
    // loop, so a synchronous adapter that never yields blocks the timer, and
    // its result is sealed normally, arbitrarily past the deadline. This pins
    // that limitation: a change that makes the deadline real (a worker, or the
    // reserved confined-subprocess mode) fails this test and must rewrite it.
    const DEADLINE_MS = 20;
    const SPIN_MS = 400;
    const spinner = adapterOf(() => {
      const until = Date.now() + SPIN_MS;
      // Busy work with no await point anywhere in it.
      while (Date.now() < until) {
        /* deliberately blocking */
      }
      return structuredClone(SEGMENTS);
    });

    const started = Date.now();
    const { representation } = await run(spinner, { maxExtractionMs: DEADLINE_MS });
    const elapsedMs = Date.now() - started;

    // Sealed, not refused.
    expect(representation.spans).toHaveLength(2);
    expect(representation.completeness).toBe("complete");
    // And measurably past the deadline it was given.
    expect(elapsedMs).toBeGreaterThan(DEADLINE_MS);
    expect(elapsedMs).toBeGreaterThanOrEqual(SPIN_MS - 50);
  });

  it("cannot preempt an adapter that awaits once and then blocks, either", async () => {
    // The async shape does not help by itself: the deadline reaches an adapter
    // only where it yields, and this one yields exactly once, too early.
    const DEADLINE_MS = 20;
    const SPIN_MS = 300;
    const lateSpinner = adapterOf(async () => {
      await Promise.resolve();
      const until = Date.now() + SPIN_MS;
      while (Date.now() < until) {
        /* deliberately blocking */
      }
      return structuredClone(SEGMENTS);
    });

    const started = Date.now();
    const { representation } = await run(lateSpinner, { maxExtractionMs: DEADLINE_MS });
    const elapsedMs = Date.now() - started;

    expect(representation.spans).toHaveLength(2);
    expect(elapsedMs).toBeGreaterThan(DEADLINE_MS);
  });

  it("refuses a hostile SourceExtractionError subclass without leaking its message", async () => {
    // An adapter can subclass the host's own error type, choose a code, and
    // rewrite the message. If the host identified its own refusals by class,
    // this adapter would both pick the refusal reason and publish document
    // bytes through the message.
    const SECRET = "SECRET-DOC-TEXT: quarterly revenue was 4.2 billion";
    class ForgedRefusal extends SourceExtractionError {
      public constructor() {
        super("extraction-deadline-exceeded");
        this.message = SECRET;
      }
    }
    const hostile = adapterOf(() => {
      throw new ForgedRefusal();
    });

    const error = await run(hostile).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SourceExtractionError);
    // The adapter did not get to choose the code.
    expect((error as SourceExtractionError).code).toBe("adapter-failed");
    expect((error as Error).message).toBe("Source extraction rejected: adapter-failed.");
    expect((error as Error).message).not.toContain("SECRET-DOC-TEXT");
    expect((error as Error).message).not.toContain("4.2 billion");
    expect(JSON.stringify((error as Error).stack ?? "")).not.toContain("SECRET-DOC-TEXT");
  });

  it("refuses a Proxy that impersonates a host refusal, and publishes none of it", async () => {
    // A private Symbol checked with a property read is not a secret: a Proxy
    // answers every property, including one it has never seen, and would let
    // the adapter put this code into the error message. The host tests WeakSet
    // membership, which a Proxy cannot forge.
    const FORGED = "extraction-deadline-exceeded SECRET-DOC-TEXT-account-4111111111111111";
    const impostor = adapterOf(() => {
      throw new Proxy(
        {},
        {
          get: (_target, property) => (typeof property === "symbol" ? true : FORGED),
        },
      );
    });

    const error = await run(impostor).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SourceExtractionError);
    expect((error as SourceExtractionError).code).toBe("adapter-failed");
    expect((error as Error).message).toBe("Source extraction rejected: adapter-failed.");

    // Nothing the adapter chose reaches any surface a caller or a log can see.
    const surfaces = [
      (error as SourceExtractionError).code,
      (error as Error).message,
      (error as Error).stack ?? "",
      JSON.stringify(error, Object.getOwnPropertyNames(error as object)),
    ].join("\n");
    expect(surfaces).not.toContain("SECRET-DOC-TEXT");
    expect(surfaces).not.toContain("4111111111111111");
    expect(surfaces).not.toContain("extraction-deadline-exceeded");
  });

  it("refuses a Proxy that forges a VALID host code, so identity alone is the gate", async () => {
    // Sharper than the case above, and the one that isolates the identity
    // check. The forged code is a real member of the fixed list, so the
    // message-building guard has nothing to object to. If membership were a
    // property read, the adapter would successfully choose the host's refusal
    // reason and the caller would be told the deadline expired when it did not.
    const impostor = adapterOf(() => {
      throw new Proxy(
        {},
        {
          get: (_target, property) =>
            typeof property === "symbol" ? true : "extraction-deadline-exceeded",
        },
      );
    });
    const error = await run(impostor).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as SourceExtractionError).code).toBe("adapter-failed");
    expect((error as SourceExtractionError).code).not.toBe("extraction-deadline-exceeded");
  });

  it("refuses a plain object literal that merely carries a code field", async () => {
    const impostor = adapterOf(() => {
      throw { code: "extraction-cancelled", message: "SECRET-DOC-TEXT in a literal" };
    });
    const error = await run(impostor).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as SourceExtractionError).code).toBe("adapter-failed");
    expect((error as Error).message).toBe("Source extraction rejected: adapter-failed.");
    expect((error as Error).message).not.toContain("SECRET-DOC-TEXT");
  });

  it("refuses a Proxy whose get trap throws, rather than crashing on it", async () => {
    // The refusal path must not touch a property of the thrown value before it
    // knows what the value is. A trap that throws proves it does not.
    const hostile = adapterOf(() => {
      throw new Proxy(
        {},
        {
          get: () => {
            throw new Error("trap refuses to answer");
          },
          has: () => {
            throw new Error("trap refuses to answer");
          },
        },
      );
    });
    await expect(run(hostile)).rejects.toThrowError(new SourceExtractionError("adapter-failed"));
  });

  it("keeps every refusal code inside the fixed list, whatever reaches the seam", async () => {
    // A second guard on the message-building path: even if a code escaped the
    // checks above, the error text is built from a known code.
    for (const adapter of [
      adapterOf(() => {
        throw new Proxy({}, { get: () => "not-a-real-code" });
      }),
      adapterOf(() => {
        throw { code: "not-a-real-code" };
      }),
    ]) {
      const error = await run(adapter).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(SOURCE_EXTRACTION_ERROR_CODES).toContain((error as SourceExtractionError).code);
      expect((error as Error).message).not.toContain("not-a-real-code");
    }
  });

  it("refuses a hostile subclass the same way when it forges a cancellation", async () => {
    class ForgedCancellation extends SourceExtractionError {
      public constructor() {
        super("extraction-cancelled");
      }
    }
    const hostile = adapterOf(async () => {
      throw new ForgedCancellation();
    });
    await expect(run(hostile)).rejects.toThrowError(new SourceExtractionError("adapter-failed"));
  });

  it("stops waiting the moment the caller cancels, rather than serving out the deadline", async () => {
    // Cancellation is raced, not merely observed: a caller that gives up must
    // not wait for the full maxExtractionMs and then get the deadline's code
    // for an event that was not a deadline.
    const controller = new AbortController();
    const stuck = adapterOf(() => new Promise<SourceExtractionResultV1>(() => undefined));
    const started = Date.now();
    const pending = extractSourceRepresentation({
      adapter: stuck,
      bytes: BYTES,
      mediaType: "text/plain",
      limits: { maxExtractionMs: 5_000 },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrowError(new SourceExtractionError("extraction-cancelled"));
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("tells a cancelled adapter to stop, through both the signal and the hook", async () => {
    const controller = new AbortController();
    let abortedSignal = false;
    let abortHookCalls = 0;
    const stuck = adapterOf(
      (request: SourceExtractionRequestV1) =>
        new Promise<SourceExtractionResultV1>(() => {
          request.signal?.addEventListener("abort", () => {
            abortedSignal = true;
          });
        }),
      () => {
        abortHookCalls += 1;
      },
    );
    const pending = extractSourceRepresentation({
      adapter: stuck,
      bytes: BYTES,
      mediaType: "text/plain",
      limits: { maxExtractionMs: 5_000 },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toThrowError(new SourceExtractionError("extraction-cancelled"));
    expect(abortedSignal).toBe(true);
    expect(abortHookCalls).toBe(1);
  });

  it("still runs the synchronous HTML adapter unchanged through the async host", async () => {
    // The shipped HTML adapter returns a plain object, not a promise, and the
    // async host still seals it.
    const { representation } = await extractSourceRepresentation({
      adapter: htmlSourceExtractorAdapter,
      bytes: HTML,
      mediaType: "text/html",
    });
    expect(representation.spans.length).toBeGreaterThan(4);
    expect(representation.extractor.id).toBe(htmlSourceExtractorAdapter.id);
  });
});

type SourceExtractionSegmentSink = Array<SourceExtractionResultV1["segments"][number]>;

describe("non-circular request identity", () => {
  it("excludes the source reference so the request hash has no cycle", () => {
    const withoutReference = requestSha256();
    const chain = buildChain();
    const withReference = requestSha256({ sourceBinding: chain.reference });
    expect(withReference).toBe(withoutReference);
    expect(chain.binding.requestSha256).toBe(withoutReference);
  });

  it("excludes the raw workspace path but binds its authenticated identity", () => {
    const moved = requestSha256({ workspacePath: "/elsewhere/docsfab" });
    expect(moved).toBe(requestSha256());
    expect(
      computeSourceRequestSha256({
        runId: RUN_ID,
        workflow: REQUEST.workflow,
        repository: REQUEST.repository,
        workspaceIdentitySha256: sha("other-workspace"),
        task: null,
        contextTarget: null,
        instruction: REQUEST.instruction,
        reviewScope: null,
        allowWrite: false,
        releaseDefaultBranch: null,
        taskLineage: null,
        compositionExecution: null,
        knowledgeResumeReceipt: null,
      }),
    ).not.toBe(requestSha256());
  });

  it("does not strip a named admission field", () => {
    expect(requestSha256({ allowWrite: true })).not.toBe(requestSha256());
    expect(requestSha256({ instruction: "Document something else." })).not.toBe(requestSha256());
    expect(requestSha256({ task: { id: "T-1" } })).not.toBe(requestSha256());
  });

  it("refuses an unrecognized admission field instead of dropping it", () => {
    expectContractCode(
      () => requestSha256({ someFutureAdmissionField: "value" }),
      "projection-unversioned",
    );
  });

  it("names the pending durable-continuation decision with its own code", () => {
    // These four are recognized siblings of the projected
    // knowledgeResumeReceipt, not unknown fields. Whether they belong in the
    // version-1 projection is an open decision, so they refuse under a distinct
    // code that keeps it legible.
    for (const field of [
      "knowledgeContinuationReceipt",
      "knowledgeContinuationRecoveryAuthorization",
      "knowledgeContinuationSnapshotSha256",
      "knowledgeContinuationAcceptanceSha256",
    ]) {
      expectContractCode(
        () => requestSha256({ [field]: sha("continuation") }),
        "continuation-projection-pending",
      );
    }
  });

  it("still projects the resume receipt that version 1 does cover", () => {
    expect(requestSha256({ knowledgeResumeReceipt: { id: "resume-1" } })).not.toBe(requestSha256());
  });
});

describe("source binding admission", () => {
  it("binds a run and reads the exact tracked bytes through a step reader", () => {
    const chain = buildChain();
    const capability = bind(chain, buildVerifier(chain));
    expect(capability.binding.bindingSha256).toBe(chain.binding.bindingSha256);
    const reader = capability.forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    });
    expect(reader).toBeDefined();
    const read = reader!.read({
      observationId: chain.observation.observationId,
      representationId: chain.representationId,
      spanIds: [spanFor(chain, READER_SENTENCE)],
    });
    expect(read.text).toBe(READER_SENTENCE);
    expect(read.spanAccess.bindingSha256).toBe(chain.binding.bindingSha256);
    expect(read.spanAccess.stepId).toBe("write-documentation");
    expect(capability.spanAccesses()).toHaveLength(1);
  });

  it("refuses a source-aware request with no live service", () => {
    const chain = buildChain();
    expectServiceCode(
      () =>
        admitRunSourceBinding({
          reference: chain.reference,
          service: undefined,
          context: {
            runId: RUN_ID,
            requestSha256: requestSha256(),
            repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
            workspaceIdentitySha256: WORKSPACE_IDENTITY,
            repositoryContentDigest: CONTENT_DIGEST,
          },
        }),
      "source-capability-unavailable",
    );
  });

  it("leaves a service inert for a no-source request", () => {
    const chain = buildChain();
    const service = createSourceEvidenceService(
      createSourceEvidenceHostAuthority(buildVerifier(chain)),
    );
    expect(
      admitRunSourceBinding({
        reference: undefined,
        service,
        context: {
          runId: RUN_ID,
          requestSha256: requestSha256(),
          repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
          workspaceIdentitySha256: WORKSPACE_IDENTITY,
          repositoryContentDigest: CONTENT_DIGEST,
        },
      }),
    ).toBeUndefined();
  });

  it("refuses a run whose identity does not match the binding", () => {
    const chain = buildChain();
    expectServiceCode(
      () => bind(chain, buildVerifier(chain), { runId: "run-other" }),
      "run-mismatch",
    );
  });

  it("refuses a request digest that does not match the binding", () => {
    const chain = buildChain();
    expectServiceCode(
      () => bind(chain, buildVerifier(chain), { requestSha256: sha("another-request") }),
      "request-mismatch",
    );
  });

  it("refuses a stale repository revision", () => {
    const chain = buildChain();
    expectServiceCode(
      () =>
        bind(chain, buildVerifier(chain), {
          repository: { identitySha256: REPOSITORY_IDENTITY, revision: "b".repeat(40) },
        }),
      "repository-mismatch",
    );
  });

  it("refuses a binding sealed under a different host policy", () => {
    const chain = buildChain();
    expectServiceCode(
      () => bind(chain, buildVerifier(chain, { hostPolicySha256: sha("other-policy") })),
      "policy-mismatch",
    );
  });

  it("refuses an observation outside the current producer scope", () => {
    const chain = buildChain({ producerScopeSha256: sha("foreign-scope") });
    expectServiceCode(() => bind(chain, buildVerifier(chain)), "producer-scope-mismatch");
  });

  it("refuses a binding whose observation record cannot be resolved", () => {
    const chain = buildChain();
    expectServiceCode(
      () => bind(chain, buildVerifier(chain, { resolveObservation: () => undefined })),
      "observation-unavailable",
    );
  });

  it("refuses a tampered persisted binding record", () => {
    const chain = buildChain();
    const tampered = { ...chain.binding, requiredObservationIds: [] };
    expectContractCode(() => decodeSourceBinding(tampered), "digest-mismatch");
    expectServiceCode(() => {
      try {
        bind(chain, buildVerifier(chain, { resolveBinding: () => tampered }));
      } catch (error) {
        if (error instanceof SourceEvidenceContractError) {
          throw new SourceEvidenceServiceError("digest-mismatch");
        }
        throw error;
      }
    }, "digest-mismatch");
  });
});

describe("step reads", () => {
  it("gives no reader to a step without a source-read grant", () => {
    const chain = buildChain();
    const capability = bind(chain, buildVerifier(chain));
    expect(stepAdmitsSourceRead(POLICY, { skill: "plan-documentation" })).toBe(false);
    expect(
      capability.forStep({
        stepId: "plan-documentation",
        workflow: "create-documentation",
        readSource: false,
        remainingBudgetBytes: POLICY.perStepBudgetBytes,
      }),
    ).toBeUndefined();
  });

  it("refuses a span that is not in the sealed binding", () => {
    const chain = buildChain();
    const foreign = buildChain({ bytes: DIVERGENT_HTML, observationId: "obs-foreign" });
    const reader = bind(chain, buildVerifier(chain)).forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    })!;
    expectServiceCode(
      () =>
        reader.read({
          observationId: chain.observation.observationId,
          representationId: chain.representationId,
          spanIds: [spanFor(foreign, READER_SENTENCE)],
        }),
      "span-unavailable",
    );
  });

  it("refuses an unselected foreign observation", () => {
    const chain = buildChain();
    const reader = bind(chain, buildVerifier(chain)).forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    })!;
    expectServiceCode(
      () =>
        reader.read({
          observationId: "obs-foreign",
          representationId: chain.representationId,
          spanIds: [spanFor(chain, READER_SENTENCE)],
        }),
      "observation-unavailable",
    );
  });

  it("refuses a reader that a later step superseded", () => {
    const chain = buildChain();
    const capability = bind(chain, buildVerifier(chain));
    const first = capability.forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    })!;
    capability.forStep({
      stepId: "verify-technical-accuracy",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    });
    expectServiceCode(
      () =>
        first.read({
          observationId: chain.observation.observationId,
          representationId: chain.representationId,
          spanIds: [spanFor(chain, READER_SENTENCE)],
        }),
      "stale-capability",
    );
  });

  it("refuses a cancelled step", () => {
    const chain = buildChain();
    const controller = new AbortController();
    const reader = bind(chain, buildVerifier(chain)).forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
      signal: controller.signal,
    })!;
    controller.abort();
    expectServiceCode(
      () =>
        reader.read({
          observationId: chain.observation.observationId,
          representationId: chain.representationId,
          spanIds: [spanFor(chain, READER_SENTENCE)],
        }),
      "cancelled",
    );
  });

  it("refuses a read beyond the remaining step budget", () => {
    const chain = buildChain();
    const reader = bind(chain, buildVerifier(chain)).forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: 4,
    })!;
    expectServiceCode(
      () =>
        reader.read({
          observationId: chain.observation.observationId,
          representationId: chain.representationId,
          spanIds: [spanFor(chain, READER_SENTENCE)],
        }),
      "budget-exhausted",
    );
  });

  it("records an access observation only for bytes actually returned", () => {
    const chain = buildChain();
    const verifier = buildVerifier(chain);
    const capability = bind(chain, verifier);
    const reader = capability.forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    })!;
    expectServiceCode(
      () =>
        reader.read({
          observationId: chain.observation.observationId,
          representationId: chain.representationId,
          spanIds: ["span-does-not-exist"],
        }),
      "span-unavailable",
    );
    expect(capability.spanAccesses()).toHaveLength(0);
    reader.read({
      observationId: chain.observation.observationId,
      representationId: chain.representationId,
      spanIds: [spanFor(chain, READER_SENTENCE)],
    });
    expect(capability.spanAccesses()).toHaveLength(1);
  });
});

describe("runner admission", () => {
  function runnerWithoutSourceService() {
    const unreachable = () => {
      throw new Error("the runner reached execution before refusing the source request");
    };
    return new WorkflowRunner({
      harness: { runStep: unreachable } as never,
      store: { save: unreachable, load: unreachable, list: unreachable } as never,
      repositoryScanner: { scan: unreachable } as never,
      id: () => RUN_ID,
      now: () => new Date("2026-09-14T18:00:00.000Z"),
    });
  }

  const baseRequest = {
    workflow: "readiness" as const,
    workspacePath: "/workspace/docsfab",
    repository: {
      sourcePath: "/workspace/docsfab",
      requestedRevision: "HEAD",
      revision: REVISION,
    },
    allowWrite: false,
  };

  it("refuses a source-aware run before any step when no service is configured", async () => {
    const chain = buildChain();
    await expect(
      runnerWithoutSourceService().run({ ...baseRequest, sourceBinding: chain.reference }),
    ).rejects.toThrowError(new SourceEvidenceServiceError("source-capability-unavailable"));
  });

  it("does not reach source admission for a no-source run", async () => {
    // The same runner, the same unreachable stubs, without the reference: the
    // failure is now the ordinary store call, proving admission stayed inert.
    await expect(runnerWithoutSourceService().run(baseRequest)).rejects.not.toThrowError(
      SourceEvidenceServiceError,
    );
  });
});

describe("artifact references and record variants", () => {
  it("accepts only the source reference-only kinds at schema version 2", () => {
    const chain = buildChain();
    expect(chain.reference.schemaVersion).toBe(2);
    expect(decodeSourceArtifactReference(chain.reference, "source-binding")).toEqual(
      chain.reference,
    );
  });

  it("rejects the historical v1 and reserved editorial v3 reference pairs", () => {
    const chain = buildChain();
    for (const schemaVersion of [1, 3]) {
      try {
        decodeSourceArtifactReference({ ...chain.reference, schemaVersion });
        throw new Error("expected a rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(SourceArtifactReferenceError);
        expect((error as SourceArtifactReferenceError).code).toBe("migration-required");
      }
    }
  });

  it("rejects a reference whose kind was substituted", () => {
    const chain = buildChain();
    try {
      decodeSourceArtifactReference(
        { ...chain.reference, kind: "source-observation" },
        "source-binding",
      );
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as SourceArtifactReferenceError).code).toBe("substitution");
    }
  });

  it("rejects an unknown record variant instead of coercing it", () => {
    const chain = buildChain();
    // Different field set: the closed shape refuses it outright.
    expectContractCode(() => decodeSourceObservation(chain.binding), "invalid-shape");
    expectContractCode(() => decodeSourceBinding(chain.observation), "invalid-shape");
    // Same field set, swapped kind: the explicit kind/version pair refuses it.
    expectContractCode(
      () => decodeSourceObservation({ ...chain.observation, kind: "docsfab-source-binding" }),
      "migration-required",
    );
    expectContractCode(
      () => decodeSourceBinding({ ...chain.binding, schemaVersion: 2 }),
      "migration-required",
    );
  });

  it("keeps sealed evidence read-only", () => {
    const chain = buildChain();
    expect(Object.isFrozen(chain.observation)).toBe(true);
    expect(Object.isFrozen(chain.observation.representations[0])).toBe(true);
    // Modules are already strict, so writing through a frozen record throws.
    expect(() => {
      (chain.observation as { observationId: string }).observationId = "obs-forged";
    }).toThrowError(TypeError);
  });

  it("rejects a span whose identity does not match its own binding", () => {
    const chain = buildChain();
    const representation = chain.observation.representations[0]!;
    const forged = {
      ...representation,
      spans: representation.spans.map((span, index) =>
        index === 0 ? { ...span, endByte: span.endByte - 1 } : span,
      ),
    };
    expectContractCode(
      () =>
        decodeSourceObservation({
          ...chain.observation,
          representations: [forged],
        }),
      "span-mismatch",
    );
  });

  it("rejects a representation bound to a different original", () => {
    const chain = buildChain();
    const other = buildChain({ bytes: DIVERGENT_HTML, observationId: "obs-other" });
    expectContractCode(
      () =>
        decodeSourceObservation({
          ...chain.observation,
          representations: [other.observation.representations[0]!],
        }),
      "substitution",
    );
  });

  it("rejects a required observation that the binding never selected", () => {
    expectContractCode(
      () =>
        createSourceBinding({
          runIdSha256: sha(RUN_ID),
          repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
          requestSha256: requestSha256(),
          hostPolicySha256: POLICY.policySha256,
          producerScopeSha256: digestSourceProducerScopes(PRODUCER_SCOPES),
          parentBindingSha256: null,
          observations: [{ observationId: "obs-a", observationSha256: sha("a") }],
          requiredObservationIds: ["obs-b"],
        }),
      "substitution",
    );
  });

  it("closes the locator set to the seven frozen discriminants", () => {
    expect([...SOURCE_LOCATOR_KINDS]).toEqual([
      "diff",
      "docx-block",
      "html-node",
      "json-pointer",
      "notebook-cell",
      "pdf-page",
      "text",
    ]);
  });
});

describe("final evidence and citations", () => {
  function completeRun() {
    const chain = buildChain();
    const verifier = buildVerifier(chain);
    const capability = bind(chain, verifier);
    const reader = capability.forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    })!;
    const read = reader.read({
      observationId: chain.observation.observationId,
      representationId: chain.representationId,
      spanIds: [spanFor(chain, READER_SENTENCE)],
    });
    return { chain, capability, read };
  }

  it("reports a considered required source after a real read", () => {
    const { chain, capability } = completeRun();
    const final = assembleSourceEvidenceFinal({
      binding: chain.binding,
      observations: [chain.observation],
      spanAccesses: capability.spanAccesses(),
      spanCitations: [],
      externalInputManifestSha256: sha("manifest"),
      accessLedgerSha256: sha("access-ledger"),
      citationLedgerSha256: sha("citation-ledger"),
    });
    expect(final.requiredCoverage).toEqual([
      { observationId: chain.observation.observationId, status: "partial" },
    ]);
    expect(final.limitations).toEqual([
      { observationId: chain.observation.observationId, reasonCode: "active-content-excluded" },
      { observationId: chain.observation.observationId, reasonCode: "hidden-content-excluded" },
    ]);
    expect(sourceEvidenceRequiredGapCodes(final)).toHaveLength(0);
  });

  it("blocks on a required source that no step read", () => {
    const chain = buildChain();
    const final = assembleSourceEvidenceFinal({
      binding: chain.binding,
      observations: [chain.observation],
      spanAccesses: [],
      spanCitations: [],
      externalInputManifestSha256: sha("manifest"),
      accessLedgerSha256: sha("access-ledger"),
      citationLedgerSha256: sha("citation-ledger"),
    });
    expect(final.requiredCoverage[0]!.status).toBe("unread");
    expect(sourceEvidenceRequiredGapCodes(final)).toEqual([
      `${chain.observation.observationId}:unread`,
    ]);
  });

  it("marks an unacquired required source unavailable", () => {
    const chain = buildChain();
    const final = assembleSourceEvidenceFinal({
      binding: chain.binding,
      observations: [chain.observation],
      spanAccesses: [],
      spanCitations: [],
      externalInputManifestSha256: sha("manifest"),
      accessLedgerSha256: sha("access-ledger"),
      citationLedgerSha256: sha("citation-ledger"),
      unavailableObservationIds: [chain.observation.observationId],
    });
    expect(final.requiredCoverage[0]!.status).toBe("unavailable");
  });

  it("accepts a citation whose spans were actually read in the same step", () => {
    const { chain, capability, read } = completeRun();
    const citation = createSourceSpanCitation({
      bindingSha256: chain.binding.bindingSha256,
      observationId: chain.observation.observationId,
      representationId: chain.representationId,
      representationSha256: chain.observation.representations[0]!.representationSha256,
      stepId: "write-documentation",
      spanIds: [spanFor(chain, READER_SENTENCE)],
      spanAccessSha256s: [read.spanAccess.spanAccessSha256],
      supportedClaimSha256: sha("claim-reader"),
      externalInputCitationSha256: sha("external-citation"),
    });
    expect(
      verifySourceSpanCitations({
        binding: chain.binding,
        observations: [chain.observation],
        spanAccesses: capability.spanAccesses(),
        spanCitations: [citation],
        materialClaimSha256s: [sha("claim-reader")],
      }),
    ).toEqual([]);
  });

  it("rejects a citation of a span nobody read", () => {
    const { chain, capability } = completeRun();
    const citation = createSourceSpanCitation({
      bindingSha256: chain.binding.bindingSha256,
      observationId: chain.observation.observationId,
      representationId: chain.representationId,
      representationSha256: chain.observation.representations[0]!.representationSha256,
      stepId: "write-documentation",
      spanIds: [spanFor(chain, UNCITED_SENTENCE)],
      spanAccessSha256s: [capability.spanAccesses()[0]!.spanAccessSha256],
      supportedClaimSha256: sha("claim-unread"),
      externalInputCitationSha256: sha("external-citation"),
    });
    expect(
      verifySourceSpanCitations({
        binding: chain.binding,
        observations: [chain.observation],
        spanAccesses: capability.spanAccesses(),
        spanCitations: [citation],
        materialClaimSha256s: [],
      }),
    ).toEqual([{ supportedClaimSha256: sha("claim-unread"), code: "unread-span" }]);
  });

  it("rejects a citation attributed to the wrong step", () => {
    const { chain, capability, read } = completeRun();
    const citation = createSourceSpanCitation({
      bindingSha256: chain.binding.bindingSha256,
      observationId: chain.observation.observationId,
      representationId: chain.representationId,
      representationSha256: chain.observation.representations[0]!.representationSha256,
      stepId: "review-documentation",
      spanIds: [spanFor(chain, READER_SENTENCE)],
      spanAccessSha256s: [read.spanAccess.spanAccessSha256],
      supportedClaimSha256: sha("claim-wrong-step"),
      externalInputCitationSha256: sha("external-citation"),
    });
    expect(
      verifySourceSpanCitations({
        binding: chain.binding,
        observations: [chain.observation],
        spanAccesses: capability.spanAccesses(),
        spanCitations: [citation],
        materialClaimSha256s: [],
      }),
    ).toEqual([{ supportedClaimSha256: sha("claim-wrong-step"), code: "wrong-step" }]);
  });

  it("reports a material claim that no citation supports", () => {
    const { chain, capability } = completeRun();
    expect(
      verifySourceSpanCitations({
        binding: chain.binding,
        observations: [chain.observation],
        spanAccesses: capability.spanAccesses(),
        spanCitations: [],
        materialClaimSha256s: [sha("claim-unsupported")],
      }),
    ).toEqual([{ supportedClaimSha256: sha("claim-unsupported"), code: "unsupported-claim" }]);
  });

  it("joins the existing external-input access ledger", () => {
    const chain = buildChain();
    const { capture, contentDigestSha256 } = openLedger(chain);
    const verifier = buildVerifier(chain, {
      recordAccess: ({ stepId, spanIds }) =>
        recordExternalInputAccess(capture, {
          inputId: chain.observation.inputId,
          stepId,
          outcome: "opened",
          observedContentDigestSha256: contentDigestSha256,
          accessorId: "docsfab-read-source",
          evidenceSha256s: [sha(spanIds.join(","))],
        }).observationSha256,
    });
    const reader = bind(chain, verifier).forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    })!;
    const read = reader.read({
      observationId: chain.observation.observationId,
      representationId: chain.representationId,
      spanIds: [spanFor(chain, READER_SENTENCE)],
    });
    const ledger = createExternalInputAccessLedger(capture);
    expect(
      ledger.observations.some(
        (entry) => entry.observationSha256 === read.spanAccess.accessObservationSha256,
      ),
    ).toBe(true);
  });
});

const CLI_REVISION = "a".repeat(40);
const CLI_HASH = "b".repeat(64);
const CLI_SOURCE_HASH = "c".repeat(64);

describe("CLI executeWorkflowRun workflowBranchEvidence seam", () => {
  // Covers the CLI-assembled host through the executeWorkflowApplication spread.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes assembled workflowBranchEvidence into executeWorkflowApplication", async () => {
    const workflowBranchEvidence = sentinelBranchEvidence();
    const captured: unknown[] = [];
    const contentIndex = { schemaVersion: 1, nodes: [] };
    const assemble = stubCliWorkflowSeam({
      workflowBranchEvidence,
      captured,
    });

    const result = await executeWorkflowRun(
      cliInvocation("update-documentation"),
      cliWorkspace(),
      {} as never,
      {
        workflow: getWorkflow("update-documentation"),
        contentIndex,
      } as never,
      {} as never,
    );

    expect(assemble).toHaveBeenCalledTimes(1);
    expect(assemble.mock.calls[0]?.[0]).toMatchObject({ index: contentIndex });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toBe(workflowBranchEvidence);
    expect(result.editorialDecodeOptions).toEqual(
      expect.objectContaining({
        decodeEditorialDecision: expect.any(Function),
        decodeWorkflowBranchCoverage: expect.any(Function),
      }),
    );
  });

  it("omits workflowBranchEvidence when the update run has no content index", async () => {
    const captured: unknown[] = [];
    const assemble = stubCliWorkflowSeam({ captured });

    const result = await executeWorkflowRun(
      cliInvocation("update-documentation"),
      cliWorkspace(),
      {} as never,
      { workflow: getWorkflow("update-documentation") } as never,
      {} as never,
    );

    expect(assemble).not.toHaveBeenCalled();
    expect(captured).toEqual([undefined]);
    expect(result.editorialDecodeOptions).toBeUndefined();
  });

  it("omits workflowBranchEvidence for create-documentation even with a content index", async () => {
    const captured: unknown[] = [];
    const assemble = stubCliWorkflowSeam({ captured });

    const result = await executeWorkflowRun(
      cliInvocation("create-documentation"),
      cliWorkspace(),
      {} as never,
      {
        workflow: getWorkflow("create-documentation"),
        contentIndex: { schemaVersion: 1, nodes: [] },
      } as never,
      {} as never,
    );

    expect(assemble).not.toHaveBeenCalled();
    expect(captured).toEqual([undefined]);
    expect(result.editorialDecodeOptions).toBeUndefined();
  });
});

function stubCliWorkflowSeam(input: {
  captured: unknown[];
  workflowBranchEvidence?: WorkflowBranchEvidenceHost;
}) {
  vi.spyOn(qualityPack, "verifyQualityPackContext").mockResolvedValue({ evidence: {} } as never);
  vi.spyOn(taskContext, "createStyleTaskContext").mockResolvedValue({ prompt: "" } as never);
  vi.spyOn(taskContext, "conservativeReaderContextInput").mockImplementation(
    ({ instruction }: { instruction: string }) => cliReaderContextInput(instruction) as never,
  );
  vi.spyOn(taskContext, "createReaderTaskContextSupplier").mockResolvedValue({
    validateHandoff: (value: unknown) => value,
    projectInput: (value: unknown) => ({
      schemaVersion: 1,
      kind: "docsfab-reader-task-context-input",
      inputOrigin: "conservative-fallback",
      noChangeAssessment: "ineligible",
      readerContextInput: value,
      baseline: { path: "baseline.md", sha256: CLI_HASH, content: "baseline" },
      policy: { id: "policy", version: "v1", sha256: CLI_HASH },
      prompt: "input",
    }),
  } as never);
  vi.spyOn(readerAdmission, "observeReaderTaskContextAdmissionV1").mockResolvedValue({
    admission: {
      admittedRevision: CLI_REVISION,
      workspaceSnapshotSha256: CLI_HASH,
      repositoryIdentitySha256: CLI_HASH,
      comparison: {
        kind: "base-head",
        base_revision: CLI_REVISION,
        head_revision: CLI_REVISION,
      },
      sources: [
        {
          uri: "docs/guide.md",
          role: "current-documentation",
          sha256: CLI_SOURCE_HASH,
        },
      ],
      provenanceLimitations: ["changed-source-not-applicable-identical-revisions"],
    },
    sourceBytes: [],
    changedPaths: [],
  } as never);
  const assemble = vi
    .spyOn(editorialAssembly, "assembleEditorialEvidenceFromAdmissionV1")
    .mockResolvedValue({
      readerTaskContext: {},
      observation: {},
      editorialEvidenceRefs: [] as ArtifactReference[],
      workflowBranchEvidence: input.workflowBranchEvidence ?? sentinelBranchEvidence(),
    } as never);
  vi.spyOn(application, "createLocalWorkflowApplicationServices").mockResolvedValue({
    services: { harness: { runStep: async () => ({ summary: "fixture" }) } },
  } as never);
  vi.spyOn(application, "executeWorkflowApplication").mockImplementation(async ({ services }) => {
    input.captured.push(services.workflowBranchEvidence);
    return {
      id: "cli-branch-evidence",
      workflow: "update-documentation",
      status: "succeeded",
      steps: [],
    } as never;
  });
  return assemble;
}

function sentinelBranchEvidence(): WorkflowBranchEvidenceHost {
  const fail = async () => {
    throw new Error("sentinel workflowBranchEvidence must not run");
  };
  return {
    select: fail,
    observeAssessment: fail,
    finalize: fail,
    decodeEditorialDecision: () => {
      throw new Error("sentinel workflowBranchEvidence must not run");
    },
  };
}

function cliInvocation(workflow: "create-documentation" | "update-documentation") {
  return {
    request: {
      workflow,
      instruction: "Update the guide.",
      allowWrite: false,
    },
    config: {
      skillCrateDirectory: "/fixture/skills",
      qualityDirectory: "/fixture/quality",
      qualityPackDirectory: "/fixture/quality-pack",
      stateDirectory: "/fixture/runs",
      model: {},
      retryPolicy: {},
    },
    options: {
      quiet: true,
      executionHarness: { runStep: async () => ({ summary: "fixture" }) },
      skillResolver: { resolveSkill: async () => ({ id: "fixture", contentSha256: CLI_HASH }) },
    },
    output: { log: vi.fn(), error: vi.fn() },
  } as never;
}

function cliWorkspace() {
  return {
    sourcePath: "/fixture/repository",
    path: "/fixture/workspace",
    requestedRevision: CLI_REVISION,
    revision: CLI_REVISION,
  } as never;
}

function cliReaderContextInput(instruction: string) {
  return {
    schema_version: 1 as const,
    target_audience: "documentation readers",
    reader_job: instruction,
    change_scope: ["docs/guide.md"],
    source_priority: ["request", "current documentation", "public contract"],
    required_content: [instruction],
    excluded_content: ["unrelated content"],
    unresolved_questions: ["Confirm the independently observed impact."],
    known_limitations: ["No independent impact decision exists yet."],
  };
}

describe("closed exact-original source evidence", () => {
  function originals() {
    const chain = buildChain();
    const {
      schemaVersion: _version,
      kind: _kind,
      observationSha256: _digest,
      ...legacyBody
    } = chain.observation;
    const originalSha256 = chain.observation.original.sha256;
    const extractor = { id: "fixture-exact-utf8", version: "1", optionsSha256: sha("raw-options") };
    const locator = { kind: "text" as const, startByte: 0, endByte: HTML.length };
    const raw = createSourceRepresentation({
      form: SOURCE_EXACT_ORIGINAL_FORM,
      sha256: originalSha256,
      byteLength: HTML.length,
      extractor,
      originalSha256,
      spans: [
        {
          spanId: computeSourceSpanId({
            originalSha256,
            derivativeSha256: originalSha256,
            extractor,
            startByte: 0,
            endByte: HTML.length,
            locator,
          }),
          startByte: 0,
          endByte: HTML.length,
          locator,
        },
      ],
      completeness: "complete",
      limitations: [],
    });
    return { chain, legacyBody, raw };
  }

  it("preserves legacy seals and admits only paired dual or original-primary registration", () => {
    const { chain, legacyBody, raw } = originals();
    expect(decodeSourceObservation(JSON.parse(JSON.stringify(chain.observation)))).toEqual(
      chain.observation,
    );
    expect(Object.hasOwn(chain.observation, "primaryContentForm")).toBe(false);
    const dual = createSourceObservation({
      ...legacyBody,
      originalInputId: "input-original-fixture",
      originalRegistrationSha256: sha("original-registration"),
      representations: [...legacyBody.representations, raw],
    });
    expect(decodeSourceObservation(JSON.parse(JSON.stringify(dual)))).toEqual(dual);
    expect(dual.inputId).toBe(chain.observation.inputId);
    expect(dual.representations[0]).toEqual(chain.observation.representations[0]);
    const originalOnly = createSourceObservation({
      ...legacyBody,
      inputId: "input-original-fixture",
      registrationSha256: sha("original-registration"),
      primaryContentForm: SOURCE_EXACT_ORIGINAL_FORM,
      representations: [raw],
    });
    expect(decodeSourceObservation(JSON.parse(JSON.stringify(originalOnly)))).toEqual(originalOnly);
    expect(originalOnly.representations).toHaveLength(1);
    expect(() => createSourceObservation({ ...legacyBody, representations: [raw] })).toThrow();
    expect(() =>
      createSourceObservation({
        ...legacyBody,
        originalInputId: "input-original-fixture",
        representations: [raw],
      }),
    ).toThrow();
    expect(() =>
      createSourceObservation({
        ...legacyBody,
        originalInputId: "input-original-fixture",
        originalRegistrationSha256: sha("original-registration"),
      }),
    ).toThrow();
    expect(() =>
      createSourceObservation({
        ...legacyBody,
        primaryContentForm: SOURCE_EXACT_ORIGINAL_FORM,
        representations: [...legacyBody.representations, raw],
      }),
    ).toThrow();
    expect(() =>
      createSourceObservation({
        ...legacyBody,
        originalInputId: legacyBody.inputId,
        originalRegistrationSha256: sha("original-registration"),
        representations: [...legacyBody.representations, raw],
      }),
    ).toThrow();
    expect(() =>
      createSourceObservation({
        ...legacyBody,
        originalInputId: "input-original-fixture",
        originalRegistrationSha256: legacyBody.registrationSha256,
        representations: [...legacyBody.representations, raw],
      }),
    ).toThrow();
    expect(() =>
      createSourceObservation({
        ...legacyBody,
        primaryContentForm: SOURCE_EXACT_ORIGINAL_FORM,
        originalInputId: "input-original-fixture",
        originalRegistrationSha256: sha("original-registration"),
        representations: [raw],
      }),
    ).toThrow();
    const alternateExtractor = {
      ...raw.extractor,
      optionsSha256: sha("second-raw-options"),
    };
    const alternateRaw = createSourceRepresentation({
      form: SOURCE_EXACT_ORIGINAL_FORM,
      sha256: raw.sha256,
      byteLength: raw.byteLength,
      extractor: alternateExtractor,
      originalSha256: raw.originalSha256,
      spans: raw.spans.map((span) => ({
        ...span,
        spanId: computeSourceSpanId({
          originalSha256: raw.originalSha256,
          derivativeSha256: raw.sha256,
          extractor: alternateExtractor,
          startByte: span.startByte,
          endByte: span.endByte,
          locator: span.locator,
        }),
      })),
      completeness: "complete",
      limitations: [],
    });
    expect(() =>
      createSourceObservation({
        ...legacyBody,
        originalInputId: "input-original-fixture",
        originalRegistrationSha256: sha("original-registration"),
        representations: [...legacyBody.representations, raw, alternateRaw],
      }),
    ).toThrow();
    expect(() =>
      decodeSourceObservation({ ...dual, originalInputId: "input-substituted" }),
    ).toThrow();
    expect(() =>
      decodeSourceObservation({
        ...dual,
        representations: [dual.representations[0]!, dual.representations[0]!],
      }),
    ).toThrow();
  });

  it("admits exactly one zero-byte original witness and charges its sealed access", () => {
    const { legacyBody } = originals();
    const originalSha256 = sha("");
    const extractor = {
      id: "fixture-empty-utf8",
      version: "1",
      optionsSha256: sha("empty-options"),
    };
    const locator = { kind: "text" as const, startByte: 0, endByte: 0 };
    const witness = {
      spanId: computeSourceSpanId({
        originalSha256,
        derivativeSha256: originalSha256,
        extractor,
        startByte: 0,
        endByte: 0,
        locator,
        allowEmptyOriginalWitness: true,
      }),
      startByte: 0,
      endByte: 0,
      locator,
    };
    expect(() =>
      computeSourceSpanId({
        originalSha256,
        derivativeSha256: originalSha256,
        extractor,
        startByte: 0,
        endByte: 0,
        locator,
      }),
    ).toThrow();
    const raw = createSourceRepresentation({
      form: SOURCE_EXACT_ORIGINAL_FORM,
      sha256: originalSha256,
      byteLength: 0,
      extractor,
      originalSha256,
      spans: [witness],
      completeness: "complete",
      limitations: [],
    });
    const observation = createSourceObservation({
      ...legacyBody,
      inputId: "input-empty-original",
      registrationSha256: sha("empty-registration"),
      primaryContentForm: SOURCE_EXACT_ORIGINAL_FORM,
      original: { ...legacyBody.original, sha256: originalSha256, byteLength: 0 },
      representations: [raw],
    });
    expect(decodeSourceObservation(JSON.parse(JSON.stringify(observation)))).toEqual(observation);
    expect(() =>
      createSourceRepresentation({
        form: SOURCE_EXACT_ORIGINAL_FORM,
        sha256: originalSha256,
        byteLength: 0,
        extractor,
        originalSha256,
        spans: [],
        completeness: "complete",
        limitations: [],
      }),
    ).toThrow();
    expect(() =>
      createSourceRepresentation({
        form: SOURCE_EXACT_ORIGINAL_FORM,
        sha256: originalSha256,
        byteLength: 0,
        extractor,
        originalSha256,
        spans: [{ ...witness, startByte: 1, endByte: 1 }],
        completeness: "complete",
        limitations: [],
      }),
    ).toThrow();
    expect(() =>
      createSourceRepresentation({
        form: SOURCE_EXACT_ORIGINAL_FORM,
        sha256: originalSha256,
        byteLength: 0,
        extractor,
        originalSha256,
        spans: [witness, witness],
        completeness: "complete",
        limitations: [],
      }),
    ).toThrow();
    const before = sourceExactOriginalCoverage({ observations: [observation], spanAccesses: [] });
    expect(before).toMatchObject([
      {
        status: "unread",
        originalBytesRead: 0,
        originalByteLength: 0,
        serializedBytesCharged: 0,
        remainingSpanIds: [witness.spanId],
      },
    ]);
    const access = createSourceSpanAccess({
      bindingSha256: sha("binding"),
      observationId: observation.observationId,
      representationId: raw.representationId,
      representationSha256: raw.representationSha256,
      stepId: "bootstrap-guidance",
      accessObservationSha256: sha("opened"),
      spanIds: [witness.spanId],
      observedAt: "2026-09-14T18:05:00.000Z",
      serializedChargeBytes: 1,
    });
    expect(decodeSourceSpanAccess(JSON.parse(JSON.stringify(access)))).toEqual(access);
    expect(
      sourceExactOriginalCoverage({ observations: [observation], spanAccesses: [access] }),
    ).toMatchObject([
      {
        status: "complete",
        originalBytesRead: 0,
        originalByteLength: 0,
        serializedBytesCharged: 1,
        remainingSpanIds: [],
      },
    ]);
    expect(() => createSourceSpanAccess({ ...access, serializedChargeBytes: 0 })).toThrow();
  });

  it("keeps derivative and original coverage separate and seals the original charge", () => {
    const { chain, legacyBody } = originals();
    expect(chain.spanIds.length).toBeGreaterThan(1);
    const cut = HTML.indexOf(10) + 1;
    expect(cut).toBeGreaterThan(0);
    const originalSha256 = chain.observation.original.sha256;
    const extractor = {
      id: "fixture-original-split",
      version: "1",
      optionsSha256: sha("split-options"),
    };
    const raw = createSourceRepresentation({
      form: SOURCE_EXACT_ORIGINAL_FORM,
      sha256: originalSha256,
      byteLength: HTML.length,
      extractor,
      originalSha256,
      spans: [
        [0, cut],
        [cut, HTML.length],
      ].map(([startByte, endByte]) => {
        const locator = { kind: "text" as const, startByte: startByte!, endByte: endByte! };
        return {
          spanId: computeSourceSpanId({
            originalSha256,
            derivativeSha256: originalSha256,
            extractor,
            startByte: startByte!,
            endByte: endByte!,
            locator,
          }),
          startByte: startByte!,
          endByte: endByte!,
          locator,
        };
      }),
      completeness: "complete",
      limitations: [],
    });
    const derivative = chain.observation.representations[0]!;
    const partialDerivative = createSourceRepresentation({
      sha256: derivative.sha256,
      byteLength: derivative.byteLength,
      extractor: derivative.extractor,
      originalSha256,
      spans: derivative.spans,
      completeness: "partial",
      limitations: ["byte-budget-truncated"],
    });
    const observation = createSourceObservation({
      ...legacyBody,
      originalInputId: "input-original-split",
      originalRegistrationSha256: sha("split-registration"),
      representations: [partialDerivative, raw],
    });
    const {
      schemaVersion: _version,
      kind: _kind,
      bindingSha256: _digest,
      ...bindingBody
    } = chain.binding;
    const binding = createSourceBinding({
      ...bindingBody,
      observations: [
        {
          observationId: observation.observationId,
          observationSha256: observation.observationSha256,
        },
      ],
    });
    const access = (representation: typeof raw, spanId: string, rawCharge?: number) =>
      createSourceSpanAccess({
        bindingSha256: binding.bindingSha256,
        observationId: observation.observationId,
        representationId: representation.representationId,
        representationSha256: representation.representationSha256,
        stepId: "bootstrap-guidance",
        accessObservationSha256: sha(`access:${spanId}`),
        spanIds: [spanId],
        observedAt: "2026-09-14T18:05:00.000Z",
        ...(rawCharge === undefined ? {} : { serializedChargeBytes: rawCharge }),
      });
    const derivativeFirst = access(partialDerivative, partialDerivative.spans[0]!.spanId);
    const rawSecond = access(raw, raw.spans[1]!.spanId, 77);
    const mixed = [derivativeFirst, rawSecond];
    expect(
      sourceRequiredCoverage({ binding, observations: [observation], spanAccesses: mixed }),
    ).toEqual([{ observationId: observation.observationId, status: "partial" }]);
    expect(
      sourceExactOriginalCoverage({ observations: [observation], spanAccesses: mixed }),
    ).toMatchObject([
      {
        status: "partial",
        originalBytesRead: HTML.length - cut,
        serializedBytesCharged: 77,
        remainingSpanIds: [raw.spans[0]!.spanId],
      },
    ]);
    // A copied raw span id on a derivative access cannot satisfy original-byte
    // coverage. The coverage projection must bind representation identity too.
    const crossViewImpostor = {
      ...derivativeFirst,
      spanIds: [raw.spans[0]!.spanId],
    };
    expect(
      sourceExactOriginalCoverage({
        observations: [observation],
        spanAccesses: [crossViewImpostor],
      }),
    ).toMatchObject([
      {
        status: "unread",
        originalBytesRead: 0,
        serializedBytesCharged: 0,
        remainingSpanIds: [raw.spans[0]!.spanId, raw.spans[1]!.spanId],
      },
    ]);
    const allRaw = [...mixed, access(raw, raw.spans[0]!.spanId, 99)];
    expect(
      sourceRequiredCoverage({ binding, observations: [observation], spanAccesses: allRaw }),
    ).toEqual([{ observationId: observation.observationId, status: "considered" }]);
    expect(
      sourceExactOriginalCoverage({ observations: [observation], spanAccesses: allRaw }),
    ).toMatchObject([
      {
        status: "complete",
        originalBytesRead: HTML.length,
        serializedBytesCharged: 176,
        remainingSpanIds: [],
      },
    ]);
    const final = assembleSourceEvidenceFinal({
      binding,
      observations: [observation],
      spanAccesses: allRaw,
      spanCitations: [],
      externalInputManifestSha256: sha("manifest"),
      accessLedgerSha256: sha("access-ledger"),
      citationLedgerSha256: sha("citation-ledger"),
    });
    expect(final.requiredCoverage).toEqual([
      { observationId: observation.observationId, status: "considered" },
    ]);
    expect(final.exactOriginalCoverage).toMatchObject([
      { status: "complete", originalBytesRead: HTML.length, serializedBytesCharged: 176 },
    ]);
    expect(final.limitations).toEqual([
      { observationId: observation.observationId, reasonCode: "byte-budget-truncated" },
    ]);
    const { serializedChargeBytes, ...missingRawCharge } = rawSecond;
    expect(serializedChargeBytes).toBe(77);
    expect(() =>
      assembleSourceEvidenceFinal({
        binding,
        observations: [observation],
        spanAccesses: [missingRawCharge],
        spanCitations: [],
        externalInputManifestSha256: sha("manifest"),
        accessLedgerSha256: sha("access-ledger"),
        citationLedgerSha256: sha("citation-ledger"),
      }),
    ).toThrow();
  });

  it("marks a bound but unavailable original unavailable in both coverage views", () => {
    const { chain, legacyBody, raw } = originals();
    const observation = createSourceObservation({
      ...legacyBody,
      primaryContentForm: SOURCE_EXACT_ORIGINAL_FORM,
      representations: [raw],
    });
    const {
      schemaVersion: _version,
      kind: _kind,
      bindingSha256: _digest,
      ...bindingBody
    } = chain.binding;
    const binding = createSourceBinding({
      ...bindingBody,
      observations: [
        {
          observationId: observation.observationId,
          observationSha256: observation.observationSha256,
        },
      ],
    });
    const final = assembleSourceEvidenceFinal({
      binding,
      observations: [observation],
      spanAccesses: [],
      spanCitations: [],
      unavailableObservationIds: [observation.observationId],
      externalInputManifestSha256: sha("unavailable-manifest"),
      accessLedgerSha256: sha("unavailable-access-ledger"),
      citationLedgerSha256: sha("unavailable-citation-ledger"),
    });
    expect(final.requiredCoverage).toEqual([
      { observationId: observation.observationId, status: "unavailable" },
    ]);
    expect(final.exactOriginalCoverage).toMatchObject([
      {
        observationId: observation.observationId,
        status: "unavailable",
        originalBytesRead: 0,
        originalByteLength: HTML.length,
        serializedBytesCharged: 0,
        remainingSpanIds: [raw.spans[0]!.spanId],
      },
    ]);
  });

  it("prefers a fully read original over a longer but partial derivative", () => {
    const { chain, legacyBody, raw } = originals();
    const originalSha256 = chain.observation.original.sha256;
    const twice = Buffer.concat([HTML, HTML]);
    const extractor = {
      id: "fixture-repeated-derivative",
      version: "1",
      optionsSha256: sha("repeat"),
    };
    const derivativeSha256 = createHash("sha256").update(twice).digest("hex");
    const repeated = createSourceRepresentation({
      sha256: derivativeSha256,
      byteLength: twice.length,
      extractor,
      originalSha256,
      spans: [0, 1].map((index) => {
        const startByte = index * HTML.length;
        const endByte = startByte + HTML.length;
        const locator = { kind: "text" as const, startByte: 0, endByte: HTML.length };
        return {
          spanId: computeSourceSpanId({
            originalSha256,
            derivativeSha256,
            extractor,
            startByte,
            endByte,
            locator,
          }),
          startByte,
          endByte,
          locator,
        };
      }),
      completeness: "partial",
      limitations: ["byte-budget-truncated"],
    });
    const observation = createSourceObservation({
      ...legacyBody,
      originalInputId: "input-original-repeated",
      originalRegistrationSha256: sha("repeated-original-registration"),
      representations: [repeated, raw],
    });
    const {
      schemaVersion: _version,
      kind: _kind,
      bindingSha256: _digest,
      ...bindingBody
    } = chain.binding;
    const binding = createSourceBinding({
      ...bindingBody,
      observations: [
        {
          observationId: observation.observationId,
          observationSha256: observation.observationSha256,
        },
      ],
    });
    const access = (representation: typeof raw, serializedChargeBytes?: number) =>
      createSourceSpanAccess({
        bindingSha256: binding.bindingSha256,
        observationId: observation.observationId,
        representationId: representation.representationId,
        representationSha256: representation.representationSha256,
        stepId: "bootstrap-guidance",
        accessObservationSha256: sha(representation.representationId),
        spanIds: representation.spans.map((span) => span.spanId),
        observedAt: "2026-09-14T18:05:00.000Z",
        ...(serializedChargeBytes === undefined ? {} : { serializedChargeBytes }),
      });
    expect(repeated.byteLength).toBeGreaterThan(raw.byteLength);
    expect(
      sourceRequiredCoverage({
        binding,
        observations: [observation],
        spanAccesses: [access(repeated), access(raw, 900)],
      }),
    ).toEqual([{ observationId: observation.observationId, status: "considered" }]);
  });
});

describe("source observation repository paths", () => {
  function observeAt(repositoryPath: string): SourceObservationV1 {
    const { observation } = buildChain();
    return createSourceObservation({
      observationId: observation.observationId,
      originIdSha256: observation.originIdSha256,
      inputId: observation.inputId,
      registrationSha256: observation.registrationSha256,
      runIdSha256: observation.runIdSha256,
      repository: observation.repository,
      requestSha256: observation.requestSha256,
      producerId: observation.producerId,
      producerVersion: observation.producerVersion,
      producerScopeSha256: observation.producerScopeSha256,
      acquisitionReceiptSha256: observation.acquisitionReceiptSha256,
      observedAt: observation.observedAt,
      original: { ...observation.original, repositoryPath },
      representations: [...observation.representations],
    });
  }

  it("admits a path under a hidden directory and refuses traversal, naming the field", () => {
    for (const hidden of [".bench/change.json", "docs/.config/source.yaml", ".notes.txt"]) {
      expect(observeAt(hidden).original.repositoryPath).toBe(hidden);
    }
    for (const refused of ["./change.json", "../change.json", "docs/../change.json", ".."]) {
      let refusal: unknown;
      try {
        observeAt(refused);
      } catch (error) {
        refusal = error;
      }
      expect(refusal, refused).toBeInstanceOf(SourceEvidenceContractError);
      expect((refusal as SourceEvidenceContractError).code).toBe("invalid-value");
      expect((refusal as SourceEvidenceContractError).field).toBe("original.repositoryPath");
      expect((refusal as Error).message).toMatch(
        /^Source-evidence contract rejected: invalid-value\. Field original\.repositoryPath: a repository path is /u,
      );
    }
  });

  it("keeps composed and decomposed repository paths as distinct sealed identities", () => {
    const composed = "docs/caf\u00e9 guide.md";
    const decomposed = "docs/cafe\u0301 guide.md";
    const first = observeAt(composed);
    const second = observeAt(decomposed);
    expect(first.original.repositoryPath).toBe(composed);
    expect(second.original.repositoryPath).toBe(decomposed);
    expect(second.observationSha256).not.toBe(first.observationSha256);
    expect(
      decodeSourceObservation(JSON.parse(JSON.stringify(second))).original.repositoryPath,
    ).toBe(decomposed);
  });

  it("admits safe printable Git paths without changing the existing path-length boundary", () => {
    const path = "docs/📘@guide.md";
    const observed = observeAt(path);
    expect(observed.original.repositoryPath).toBe(path);
    expect(
      decodeSourceObservation(JSON.parse(JSON.stringify(observed))).original.repositoryPath,
    ).toBe(path);
    expect(observeAt("a".repeat(1_024)).original.repositoryPath).toHaveLength(1_024);
    expect(() => observeAt("a".repeat(1_025))).toThrow(
      expect.objectContaining({ code: "invalid-value", field: "original.repositoryPath" }),
    );
  });

  it("refuses ambiguous or unsafe repository paths while admitting exact UTF-8 text", () => {
    for (const refused of [
      "",
      "/docs/guide.md",
      "C:/docs/guide.md",
      "C:docs/guide.md",
      "docs//guide.md",
      "docs/./guide.md",
      "docs/../guide.md",
      "docs/guide.md/",
      "docs\\guide.md",
      "docs/line\nbreak.md",
      "docs/\u00a0guide.md",
      "docs/\u202eguide.md",
      "docs/\ud800.md",
    ]) {
      expect(() => observeAt(refused), refused).toThrow(
        expect.objectContaining({ code: "invalid-value", field: "original.repositoryPath" }),
      );
    }
  });
});
