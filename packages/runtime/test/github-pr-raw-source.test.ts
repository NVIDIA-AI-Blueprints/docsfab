// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Focused hostile controls for the confined original-byte source-tool seam. */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createConfinedToolSet } from "../src/harness/confined-tools.js";
import {
  DEFAULT_TOOL_OUTPUT_CAP_BYTES,
  MINIMUM_TOOL_OUTPUT_CAP_BYTES,
} from "../src/harness/tool-output-cap.js";
import {
  openExternalInputAccessCapture,
  recordExternalInputAccess,
  registerTrackedRepositorySourceInput,
} from "../src/inputs/access.js";
import {
  computeSourceSpanId,
  createSourceBinding,
  createSourceObservation,
  createSourceRepresentation,
  digestSourceProducerScopes,
  SOURCE_EXACT_ORIGINAL_FORM,
} from "../src/inputs/source-evidence.js";
import {
  createSourceArtifactReference,
  RequiredSourceUnreadError,
} from "../src/inputs/source-evidence-artifacts.js";
import {
  createSourceEvidenceHostAuthority,
  createSourceEvidenceService,
  type SourceEvidenceHostVerifier,
} from "../src/inputs/source-resolver.js";
import {
  createSourceStepPolicy,
  SOURCE_READ_RESPONSE_CEILING_BYTES,
} from "../src/inputs/source-step-policy.js";
import { readRequiredSourcesIntoStep } from "../src/workflow-execution/step-loop/required-sources.js";
import { configureCredential } from "./helpers/configured-credential.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const gitBlob = (bytes: Buffer) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const REVISION = "a".repeat(40);
const repository = { identitySha256: sha("raw-test-repository"), revision: REVISION };
const producerScopes = [
  { producerId: "fixture-original-source", scopeSha256: sha("raw-test-scope") },
];

async function boundOriginal(
  parts: readonly string[],
  budgetBytes?: number,
  withDerivative = false,
) {
  const root = await mkdtemp(join(tmpdir(), "docsfab-raw-source-tool-"));
  roots.push(root);
  const original = Buffer.from(parts.join(""), "utf8");
  const originalSha256 = sha(original);
  const extractor = { id: "fixture-exact-original", version: "1", optionsSha256: sha("options") };
  let offset = 0;
  const spans = parts.map((part) => {
    const startByte = offset;
    const endByte = startByte + Buffer.byteLength(part, "utf8");
    offset = endByte;
    const locator = { kind: "text" as const, startByte, endByte };
    return {
      spanId: computeSourceSpanId({
        originalSha256,
        derivativeSha256: originalSha256,
        extractor,
        startByte,
        endByte,
        locator,
        ...(original.length === 0 ? { allowEmptyOriginalWitness: true } : {}),
      }),
      startByte,
      endByte,
      locator,
    };
  });
  const raw = createSourceRepresentation({
    form: SOURCE_EXACT_ORIGINAL_FORM,
    sha256: originalSha256,
    byteLength: original.length,
    originalSha256,
    extractor,
    spans,
    completeness: "complete",
    limitations: [],
  });
  const policy = createSourceStepPolicy({
    sourceReadSkills: ["repo-bootstrap"],
    ...(budgetBytes === undefined ? {} : { perStepBudgetBytes: budgetBytes }),
  });
  const capture = openExternalInputAccessCapture({ runIdSha256: sha("raw-test-run"), repository });
  const registration = registerTrackedRepositorySourceInput(capture, {
    inputId: "input-original-fixture",
    canonicalLocator: "repository-document:docs/source.md",
    safeTitle: "Original source",
    contentDigestSha256: originalSha256,
    revision: REVISION,
    producerId: producerScopes[0]!.producerId,
    producerVersion: "1",
  });
  const observation = createSourceObservation({
    observationId: "obs-original-fixture",
    originIdSha256: sha("raw-origin"),
    inputId: "input-original-fixture",
    registrationSha256: registration.entrySha256,
    primaryContentForm: SOURCE_EXACT_ORIGINAL_FORM,
    runIdSha256: sha("raw-test-run"),
    repository,
    requestSha256: sha("raw-request"),
    producerId: producerScopes[0]!.producerId,
    producerVersion: "1",
    producerScopeSha256: producerScopes[0]!.scopeSha256,
    acquisitionReceiptSha256: sha("raw-acquisition"),
    observedAt: "2026-10-15T00:00:00.000Z",
    original: {
      sha256: originalSha256,
      byteLength: original.length,
      mediaType: "text/markdown",
      locatorSha256: sha("docs/source.md"),
      version: { kind: "repository-revision", revision: REVISION },
      repositoryPath: "docs/source.md",
    },
    representations: [raw],
  });
  const derivativeBytes = Buffer.from("Normalized companion\n", "utf8");
  const derivativeSha256 = sha(derivativeBytes);
  const derivativeExtractor = {
    id: "fixture-normalized-companion",
    version: "1",
    optionsSha256: sha("normalized-options"),
  };
  const derivativeLocator = {
    kind: "text" as const,
    startByte: 0,
    endByte: derivativeBytes.length,
  };
  const derivativeRepresentation = createSourceRepresentation({
    sha256: derivativeSha256,
    byteLength: derivativeBytes.length,
    originalSha256: derivativeSha256,
    extractor: derivativeExtractor,
    spans: [
      {
        spanId: computeSourceSpanId({
          originalSha256: derivativeSha256,
          derivativeSha256,
          extractor: derivativeExtractor,
          startByte: 0,
          endByte: derivativeBytes.length,
          locator: derivativeLocator,
        }),
        startByte: 0,
        endByte: derivativeBytes.length,
        locator: derivativeLocator,
      },
    ],
    completeness: "complete",
    limitations: [],
  });
  const derivativeRegistration = withDerivative
    ? registerTrackedRepositorySourceInput(capture, {
        inputId: "input-normalized-fixture",
        canonicalLocator: "repository-document:docs/normalized.md",
        safeTitle: "Normalized companion",
        contentDigestSha256: derivativeSha256,
        revision: REVISION,
        producerId: producerScopes[0]!.producerId,
        producerVersion: "1",
      })
    : undefined;
  const derivativeObservation = derivativeRegistration
    ? createSourceObservation({
        observationId: "obs-normalized-fixture",
        originIdSha256: sha("normalized-origin"),
        inputId: "input-normalized-fixture",
        registrationSha256: derivativeRegistration.entrySha256,
        runIdSha256: sha("raw-test-run"),
        repository,
        requestSha256: sha("raw-request"),
        producerId: producerScopes[0]!.producerId,
        producerVersion: "1",
        producerScopeSha256: producerScopes[0]!.scopeSha256,
        acquisitionReceiptSha256: sha("normalized-acquisition"),
        observedAt: "2026-10-15T00:00:00.000Z",
        original: {
          sha256: derivativeSha256,
          byteLength: derivativeBytes.length,
          mediaType: "text/markdown",
          locatorSha256: sha("docs/normalized.md"),
          version: { kind: "repository-revision", revision: REVISION },
          repositoryPath: "docs/normalized.md",
        },
        representations: [derivativeRepresentation],
      })
    : undefined;
  const binding = createSourceBinding({
    runIdSha256: sha("raw-test-run"),
    repository,
    requestSha256: sha("raw-request"),
    hostPolicySha256: policy.policySha256,
    producerScopeSha256: digestSourceProducerScopes(producerScopes),
    parentBindingSha256: null,
    observations: [
      {
        observationId: observation.observationId,
        observationSha256: observation.observationSha256,
      },
      ...(derivativeObservation
        ? [
            {
              observationId: derivativeObservation.observationId,
              observationSha256: derivativeObservation.observationSha256,
            },
          ]
        : []),
    ],
    requiredObservationIds: [
      observation.observationId,
      ...(derivativeObservation ? [derivativeObservation.observationId] : []),
    ],
  });
  let retained: Buffer | undefined = original;
  const verifier: SourceEvidenceHostVerifier = {
    verifyCurrent: () => undefined,
    hostPolicySha256: policy.policySha256,
    producerScopes,
    resolveBinding: (digest) => (digest === binding.bindingSha256 ? binding : undefined),
    resolveObservation: (id) =>
      id === observation.observationId
        ? observation
        : id === derivativeObservation?.observationId
          ? derivativeObservation
          : undefined,
    resolveDerivative: ({ observationId }) =>
      observationId === derivativeObservation?.observationId
        ? Buffer.from(derivativeBytes)
        : undefined,
    resolveOriginal: () => (retained === undefined ? undefined : Buffer.from(retained)),
    describeOriginal: () => ({
      side: "after",
      repositoryId: "11",
      blobId: gitBlob(original),
      originalSha256,
    }),
    recordAccess: ({ observationId, stepId }) => {
      const selected =
        observationId === derivativeObservation?.observationId
          ? derivativeObservation
          : observation;
      return recordExternalInputAccess(capture, {
        inputId: selected.inputId,
        stepId,
        outcome: "opened",
        observedContentDigestSha256: selected.original.sha256,
        accessorId: "docsfab-source-evidence",
        evidenceSha256s: [selected.observationSha256],
      }).observationSha256;
    },
    now: () => new Date("2026-10-15T00:05:00.000Z"),
  };
  const service = createSourceEvidenceService(createSourceEvidenceHostAuthority(verifier));
  const reference = createSourceArtifactReference({
    kind: "source-binding",
    digest: binding.bindingSha256,
    repositoryRevision: REVISION,
    repositoryContentDigest: sha("raw-content"),
  });
  const context = {
    runId: "raw-test-run",
    requestSha256: sha("raw-request"),
    repository,
    workspaceIdentitySha256: sha("raw-workspace"),
    repositoryContentDigest: sha("raw-content"),
  };
  const capability = service.bindRun(reference, context);
  const reader = capability.forStep({
    stepId: "bootstrap-guidance",
    workflow: "bootstrap",
    readSource: true,
    remainingBudgetBytes: policy.perStepBudgetBytes,
  })!;
  return {
    root,
    original,
    observation,
    raw,
    spans,
    derivativeObservation,
    derivativeRepresentation,
    policy,
    service,
    reference,
    context,
    capability,
    reader,
    setOriginal: (bytes: Buffer | undefined) => {
      retained = bytes;
    },
  };
}

async function toolsFor(
  reader: Awaited<ReturnType<typeof boundOriginal>>["reader"],
  root: string,
  toolOutputCapBytes?: number,
) {
  const set = await createConfinedToolSet({
    workspacePath: root,
    allowWrite: false,
    sourceReader: reader,
    ...(toolOutputCapBytes === undefined ? {} : { toolOutputCapBytes }),
  });
  const tool = (name: string) =>
    set.definitions.find((entry) => entry.name === name)! as unknown as {
      execute: (
        ...args: unknown[]
      ) => Promise<{ content: Array<{ text: string }>; details?: { spanAccessSha256: string } }>;
    };
  return { list: tool("docsfab_list_sources"), read: tool("docsfab_read_source") };
}

describe("confined exact-original source reads", () => {
  it("refuses a cross-run or substituted binding before issuing a raw reader", async () => {
    const built = await boundOriginal(["# Run-bound source\n"]);
    expect(() =>
      built.service.bindRun(built.reference, { ...built.context, runId: "another-run" }),
    ).toThrow();
    expect(() =>
      built.service.bindRun({ ...built.reference, digest: sha("another-binding") }, built.context),
    ).toThrow();
    expect(built.capability.spanAccesses()).toHaveLength(0);
  });

  it("preflights the empty original's complete prompt at the minimal budget before a receipt", async () => {
    async function attempt(budgetBytes: number) {
      const built = await boundOriginal([""], budgetBytes);
      try {
        const result = readRequiredSourcesIntoStep({
          capability: built.capability,
          reader: built.reader,
          stepId: "bootstrap-guidance",
          budgetBytes,
          citable: false,
        });
        return { result, accesses: built.capability.spanAccesses() };
      } catch (error) {
        return { error, accesses: built.capability.spanAccesses() };
      }
    }
    const generous = await attempt(4096);
    expect(generous.error).toBeUndefined();
    expect(generous.accesses).toHaveLength(1);
    // The budget is rendered inside the charged prompt; start near its
    // measured size and find the smallest fixed-point admission.
    let threshold = generous.accesses[0]!.serializedChargeBytes! + 16;
    expect((await attempt(threshold)).error).toBeUndefined();
    while (threshold > 1 && (await attempt(threshold - 1)).error === undefined) threshold--;
    const exact = await attempt(threshold);
    expect(exact.error).toBeUndefined();
    expect(exact.accesses).toHaveLength(1);
    expect(exact.accesses[0]!.serializedChargeBytes).toBeGreaterThan(0);
    expect(exact.result?.text).toContain('"startByte":0,"endByte":0,"text":""');
    expect(exact.accesses[0]!.serializedChargeBytes).toBe(
      Buffer.byteLength(exact.result!.text!, "utf8"),
    );
    const tooSmall = await attempt(threshold - 1);
    expect(tooSmall.error).toBeDefined();
    expect(tooSmall.accesses).toHaveLength(0);
  });

  it("reads a smaller original window when rendered framing exceeds the logical byte budget", async () => {
    const budgetBytes = 3072;
    const built = await boundOriginal(
      Array.from({ length: 3 }, () => " ".repeat(1024)),
      budgetBytes,
    );
    const prepared = readRequiredSourcesIntoStep({
      capability: built.capability,
      reader: built.reader,
      stepId: "bootstrap-guidance",
      budgetBytes,
      citable: false,
    });
    const accesses = built.capability.spanAccesses();
    expect(accesses.length).toBeGreaterThan(0);
    expect(accesses.length).toBeLessThan(built.spans.length);
    expect(accesses.map((access) => access.spanIds[0])).toEqual(
      built.spans.slice(0, accesses.length).map((span) => span.spanId),
    );
    expect(accesses.reduce((sum, access) => sum + (access.serializedChargeBytes ?? 0), 0)).toBe(
      Buffer.byteLength(prepared.text!, "utf8"),
    );
    expect(Buffer.byteLength(prepared.text!, "utf8")).toBeLessThanOrEqual(budgetBytes);
    expect(
      prepared.partialReadWarnings.some((warning) => warning.includes("source-read-partial")),
    ).toBe(true);
  });

  it("partially reads a full-size blank original under the shipped step budget", async () => {
    const budgetBytes = SOURCE_READ_RESPONSE_CEILING_BYTES;
    const pieces = Array.from({ length: 16 }, () => " ".repeat(budgetBytes / 16));
    const built = await boundOriginal(pieces, budgetBytes);
    const prepared = readRequiredSourcesIntoStep({
      capability: built.capability,
      reader: built.reader,
      stepId: "bootstrap-guidance",
      budgetBytes,
      citable: false,
    });
    const accesses = built.capability.spanAccesses();
    expect(accesses.length).toBeGreaterThan(0);
    expect(accesses.length).toBeLessThan(built.spans.length);
    expect(accesses.map((access) => access.spanIds[0])).toEqual(
      built.spans.slice(0, accesses.length).map((span) => span.spanId),
    );
    expect(accesses.reduce((sum, access) => sum + (access.serializedChargeBytes ?? 0), 0)).toBe(
      Buffer.byteLength(prepared.text!, "utf8"),
    );
    expect(Buffer.byteLength(prepared.text!, "utf8")).toBeLessThanOrEqual(budgetBytes);
    expect(
      prepared.partialReadWarnings.some((warning) => warning.includes("source-read-partial")),
    ).toBe(true);
  });

  it("names every unread original and normalized source when no mixed prompt fits", async () => {
    const budgetBytes = 100;
    const built = await boundOriginal(["# Raw\n"], budgetBytes, true);
    let refusal: unknown;
    try {
      readRequiredSourcesIntoStep({
        capability: built.capability,
        reader: built.reader,
        stepId: "bootstrap-guidance",
        budgetBytes,
        citable: false,
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(RequiredSourceUnreadError);
    const gaps = (refusal as RequiredSourceUnreadError).gaps;
    expect(gaps.map((gap) => gap.observationId).sort()).toEqual(
      [built.derivativeObservation!.observationId, built.observation.observationId].sort(),
    );
    expect(gaps.every((gap) => gap.reason === "over-read-budget")).toBe(true);
    expect(String(refusal)).toContain(`${built.derivativeObservation!.observationId}:unread`);
    expect(String(refusal)).toContain(`${built.observation.observationId}:unread`);
    expect(built.capability.spanAccesses()).toHaveLength(0);
  });

  it("preflights combined original framing and normalized bytes before either access", async () => {
    async function attempt(budgetBytes: number) {
      const built = await boundOriginal(["# Raw\n"], budgetBytes, true);
      try {
        const result = readRequiredSourcesIntoStep({
          capability: built.capability,
          reader: built.reader,
          stepId: "bootstrap-guidance",
          budgetBytes,
          citable: false,
        });
        return { result, accesses: built.capability.spanAccesses() };
      } catch (error) {
        return { error, accesses: built.capability.spanAccesses() };
      }
    }
    const generous = await attempt(4096);
    expect(generous.error).toBeUndefined();
    expect(generous.accesses).toHaveLength(2);
    const rawCharge = generous.accesses.find(
      (access) => access.serializedChargeBytes !== undefined,
    )?.serializedChargeBytes;
    expect(rawCharge).toBeGreaterThan(0);
    let threshold = rawCharge! + Buffer.byteLength("Normalized companion\n", "utf8") + 16;
    expect((await attempt(threshold)).error).toBeUndefined();
    while (threshold > 1 && (await attempt(threshold - 1)).error === undefined) threshold--;
    const exact = await attempt(threshold);
    expect(exact.error).toBeUndefined();
    expect(exact.accesses).toHaveLength(2);
    const tooSmall = await attempt(threshold - 1);
    expect(tooSmall.error).toBeDefined();
    expect(tooSmall.accesses).toHaveLength(0);
  });

  it("requires a rendering screen and rejects cancelled or superseded grants", async () => {
    const built = await boundOriginal(["# Bound source\n"]);
    const selection = {
      observationId: built.observation.observationId,
      representationId: built.raw.representationId,
      spanIds: [built.spans[0]!.spanId],
    };
    expect(() => built.reader.read(selection)).toThrow();
    expect(built.capability.spanAccesses()).toHaveLength(0);
    const controller = new AbortController();
    const cancelled = built.capability.forStep({
      stepId: "bootstrap-guidance",
      workflow: "bootstrap",
      readSource: true,
      remainingBudgetBytes: built.policy.perStepBudgetBytes,
      signal: controller.signal,
    })!;
    controller.abort();
    expect(() => cancelled.listSources()).toThrow();
    expect(built.capability.spanAccesses()).toHaveLength(0);
    const fresh = built.capability.forStep({
      stepId: "next-guidance",
      workflow: "bootstrap",
      readSource: true,
      remainingBudgetBytes: built.policy.perStepBudgetBytes,
    })!;
    expect(fresh.listSources()).toHaveLength(1);
    expect(() => built.reader.listSources()).toThrow();
    expect(() => cancelled.listSources()).toThrow();
    expect(built.capability.spanAccesses()).toHaveLength(0);
  });

  it("charges the exact escaped content array and respects a live host cap below ambient", async () => {
    const body = `# Heading\r\n${'"'.repeat(850)}\r\n`;
    const measuredRun = await boundOriginal([body]);
    const full = await toolsFor(measuredRun.reader, measuredRun.root);
    const selection = { source: "s1", spanIds: measuredRun.spans.map((span) => span.spanId) };
    const result = await full.read.execute("read-full", selection);
    const charge = Buffer.byteLength(JSON.stringify(result.content), "utf8");
    expect(charge).toBeGreaterThan(MINIMUM_TOOL_OUTPUT_CAP_BYTES);
    expect(charge).toBeLessThan(DEFAULT_TOOL_OUTPUT_CAP_BYTES);
    expect(measuredRun.capability.spanAccesses()[0]!.serializedChargeBytes).toBe(charge);
    const exactRun = await boundOriginal([body]);
    const exact = await toolsFor(exactRun.reader, exactRun.root, charge);
    expect(await exact.read.execute("read-exact", selection)).toMatchObject({
      details: { spanAccessSha256: expect.stringMatching(/^[0-9a-f]{64}$/u) },
    });
    expect(exactRun.capability.spanAccesses()[0]!.serializedChargeBytes).toBe(charge);
    const refusedRun = await boundOriginal([body]);
    const refused = await toolsFor(refusedRun.reader, refusedRun.root, charge - 1);
    await expect(refused.read.execute("read-over", selection)).rejects.toThrow();
    expect(refusedRun.capability.spanAccesses()).toHaveLength(0);
    const inventory = JSON.parse(
      (
        await refused.list.execute("list-one", {
          fromEntry: 0,
          maxEntries: 1,
        })
      ).content[0]!.text,
    ) as { spanCount: number; nextFromEntry: number | null };
    expect(inventory).toMatchObject({ spanCount: 1, nextFromEntry: null });
    expect(
      JSON.parse(
        (await refused.list.execute("list-at-limit", { maxEntries: 256 })).content[0]!.text,
      ),
    ).toMatchObject({ spanCount: 1, nextFromEntry: null });
    await expect(refused.list.execute("list-invalid", { maxEntries: 257 })).rejects.toThrow();
  });

  it("screens the complete original when a credential crosses sealed spans", async () => {
    const secret = configureCredential("ORIGINALBOUNDARYSECRET");
    const built = await boundOriginal([
      `# Safe\n${secret.slice(0, 8)}`,
      `${secret.slice(8)}\nEnd.\n`,
    ]);
    const tools = await toolsFor(built.reader, built.root);
    await expect(
      tools.read.execute("cross-boundary", {
        source: "s1",
        spanIds: [built.spans[0]!.spanId],
      }),
    ).rejects.toThrow();
    expect(built.capability.spanAccesses()).toHaveLength(0);
  });

  it("refuses changed or missing original after admission without a new access", async () => {
    const built = await boundOriginal(["# Retained original\n"]);
    const tools = await toolsFor(built.reader, built.root);
    const selection = { source: "s1", spanIds: [built.spans[0]!.spanId] };
    await tools.read.execute("genuine", selection);
    expect(built.capability.spanAccesses()).toHaveLength(1);
    built.setOriginal(Buffer.from("# Changed  original\n"));
    await expect(tools.read.execute("changed", selection)).rejects.toThrow();
    expect(built.capability.spanAccesses()).toHaveLength(1);
    built.setOriginal(undefined);
    await expect(tools.read.execute("missing", selection)).rejects.toThrow();
    expect(built.capability.spanAccesses()).toHaveLength(1);
  });

  it("gives the empty original one 0..0 window witness with positive framing charge", async () => {
    const built = await boundOriginal([""]);
    const tools = await toolsFor(built.reader, built.root);
    const result = await tools.read.execute("empty-zero", { source: "s1", fromByte: 0 });
    const payload = JSON.parse(result.content[0]!.text) as {
      readBytes: number;
      totalBytes: number;
      nextFromByte: number | null;
      spans: Array<{ startByte: number; endByte: number; text: string }>;
    };
    expect(payload).toMatchObject({
      readBytes: 0,
      totalBytes: 0,
      nextFromByte: null,
      spans: [{ startByte: 0, endByte: 0, text: "" }],
    });
    expect(built.capability.spanAccesses()[0]!.serializedChargeBytes).toBe(
      Buffer.byteLength(JSON.stringify(result.content), "utf8"),
    );
    expect(built.capability.spanAccesses()[0]!.serializedChargeBytes).toBeGreaterThan(0);
    await expect(
      tools.read.execute("empty-past-end", { source: "s1", fromByte: 1 }),
    ).rejects.toThrow();
    expect(built.capability.spanAccesses()).toHaveLength(1);
  });

  it("admits the empty framing and cumulative two-read budget exactly, then refuses one byte over", async () => {
    for (const parts of [[""], ["A", "B"]] as const) {
      const generous = await boundOriginal(parts, 4096);
      const generousTools = await toolsFor(generous.reader, generous.root);
      if (parts.length > 1) {
        const firstPage = JSON.parse(
          (await generousTools.list.execute("first-page", { maxEntries: 1 })).content[0]!.text,
        ) as { spans: unknown[]; nextFromEntry: number | null };
        const nextPage = JSON.parse(
          (await generousTools.list.execute("next-page", { fromEntry: 1, maxEntries: 1 }))
            .content[0]!.text,
        ) as { spans: unknown[]; nextFromEntry: number | null };
        expect(firstPage).toMatchObject({ nextFromEntry: 1 });
        expect(firstPage.spans).toHaveLength(1);
        expect(nextPage).toMatchObject({ nextFromEntry: null });
        expect(nextPage.spans).toHaveLength(1);
      }
      for (const [index, span] of generous.spans.entries())
        await generousTools.read.execute(`generous-${index}`, {
          source: "s1",
          spanIds: [span.spanId],
        });
      let threshold = generous.capability
        .spanAccesses()
        .reduce((sum, access) => sum + access.serializedChargeBytes!, 0);
      async function attempt(budgetBytes: number) {
        const built = await boundOriginal(parts, budgetBytes);
        const tools = await toolsFor(built.reader, built.root);
        let succeeded = 0;
        for (const [index, span] of built.spans.entries()) {
          try {
            await tools.read.execute(`boundary-${index}`, {
              source: "s1",
              spanIds: [span.spanId],
            });
            succeeded++;
          } catch {
            break;
          }
        }
        return { succeeded, accesses: built.capability.spanAccesses() };
      }
      expect((await attempt(threshold)).succeeded).toBe(parts.length);
      // The final budget field can use fewer decimal digits at the crossing;
      // find the exact fixed-point threshold rather than estimating it from
      // original span lengths or a different budget's rendering.
      while (threshold > 1 && (await attempt(threshold - 1)).succeeded === parts.length)
        threshold--;
      const exact = await attempt(threshold);
      expect(exact.succeeded).toBe(parts.length);
      expect(
        exact.accesses.reduce((sum, access) => sum + access.serializedChargeBytes!, 0),
      ).toBeLessThanOrEqual(threshold);
      const over = await attempt(threshold - 1);
      expect(over.succeeded).toBe(parts.length - 1);
      expect(over.accesses).toHaveLength(parts.length - 1);
    }
  });
});
