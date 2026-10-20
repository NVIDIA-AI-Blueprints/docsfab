// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { InferenceStepError } from "../src/execution/contracts.js";
import { createConfinedToolSet } from "../src/harness/confined-tools.js";
import { grantedTools, skillPolicyTools } from "../src/harness/pi-tool-confine.js";
import { SOURCE_READ_TOOL_NAMES, SOURCE_TOOL_NAMES } from "../src/harness/source-tools.js";
import {
  beginSourceReadAttempt,
  createSourceArtifactReference,
  createSourceBinding,
  createSourceEvidenceHostAuthority,
  createSourceEvidenceService,
  createSourceObservation,
  createSourceStepPolicy,
  digestSourceProducerScopes,
  extractSourceRepresentation,
  htmlSourceExtractorAdapter,
  openExternalInputAccessCapture,
  planRequiredSourceReads,
  projectSourceRequestContext,
  readSourceSpansForEveryAttempt,
  recordExternalInputAccess,
  registerFakeExternalInput,
  RequiredSourceUnreadError,
  SourceEvidenceServiceError,
  readSourceWindow,
  SOURCE_READ_GAP_MARKER_PREFIX,
  sourceEvidenceRequiredGapCodes,
  sourcePartialReadWarnings,
  sourceRequiredCoverage,
  sourceRequiredReadCoverage,
  stepAdmitsSourceRead,
  type SourceEvidenceHostVerifier,
  type SourceStepReaderV1,
} from "../src/inputs/index.js";
import { DEFAULT_NEXT_ACTIONS } from "../src/operator/error-envelope.js";
import { classifyThrownFailure } from "../src/operator/failure-classification.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import {
  notebookSourceExtractorAdapter,
  textSourceExtractorAdapter,
} from "../src/inputs/adapters/structured.js";
import { createSourceSpanAccess } from "../src/inputs/source-evidence.js";
import { gitlabMergedMrDiffExtractorAdapter } from "../src/inputs/merged-mr-evidence.js";
import { resolveToolOutputCapBytes } from "../src/harness/tool-output-cap.js";
import { sourceExtractionMaxSpanBytes } from "../src/config/source-read-limits.js";
import {
  configureCredential,
  configureCredentialsForEachTest,
} from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";
import { listedInventory, type SourceListing } from "./support/source-listing.js";

const HTML = new Uint8Array(
  readFileSync(new URL("./fixtures/source-evidence/html/release-notes.html", import.meta.url)),
);
/** Different bytes, so a second run's spans are genuinely distinguishable. */
const DIVERGENT_HTML = new Uint8Array(
  readFileSync(
    new URL("./fixtures/source-evidence/html/divergent-release-notes.html", import.meta.url),
  ),
);
const RUN_ID = "run-835-grants";
const REVISION = "a".repeat(40);
const REPOSITORY_IDENTITY = createHash("sha256").update("/workspace/docsfab").digest("hex");
const WORKSPACE_IDENTITY = createHash("sha256").update("workspace-identity").digest("hex");
const CONTENT_DIGEST = createHash("sha256").update("content").digest("hex");
const PRODUCER_ID = "workspace-tracked-files";
const PRODUCER_SCOPE = createHash("sha256").update("tracked-files-scope").digest("hex");
const PRODUCER_SCOPES = [{ producerId: PRODUCER_ID, scopeSha256: PRODUCER_SCOPE }];
const POLICY = createSourceStepPolicy({
  sourceReadSkills: ["write-documentation", "verify-technical-accuracy"],
  perStepBudgetBytes: 8 * 1024,
});
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** A service refusal by code; its detail line is asserted where it matters. */
function serviceRefusal(code: SourceEvidenceServiceError["code"]) {
  return expect.objectContaining({ name: "SourceEvidenceServiceError", code });
}
const READER_SENTENCE = "The runtime reads a tracked source only through a host-issued reader.";

/** The three read forms, as every shape refusal names them. */
const READ_FORMS =
  "Pass span ids, or a window (fromByte, with an optional maxBytes), or a diff file (diffFile, with an optional diffHunk), each in its own call; send an argument you do not use as null, or omit it.";

const workspaces: string[] = [];
afterAll(async () => {
  for (const path of workspaces) await rm(path, { recursive: true, force: true });
});

/** A plain-text original, one span per line, so its extract is complete. */
function requirementsText(lines: number, width = 48): Uint8Array {
  return new TextEncoder().encode(
    `${Array.from({ length: lines }, (_, index) =>
      `Requirement ${String(index).padStart(3, "0")} keeps the export bounded.`.padEnd(width, "."),
    ).join("\n")}\n`,
  );
}

const TEXT_SOURCE = {
  adapter: textSourceExtractorAdapter,
  mediaType: "text/plain",
  repositoryPath: "docs/requirements.txt",
} as const;

async function buildCapability(
  bytes: Uint8Array = HTML,
  observationId = "obs-release-notes",
  source: {
    adapter: typeof htmlSourceExtractorAdapter;
    mediaType: string;
    repositoryPath: string;
  } = {
    adapter: htmlSourceExtractorAdapter,
    mediaType: "text/html",
    repositoryPath: "docs/release-notes.html",
  },
) {
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
  const { representation, derivative } = await extractSourceRepresentation({
    adapter: source.adapter,
    bytes,
    mediaType: source.mediaType,
  });
  const observation = createSourceObservation({
    observationId,
    originIdSha256: sha("origin"),
    inputId: "input-release-notes",
    registrationSha256: sha("registration"),
    runIdSha256: sha(RUN_ID),
    repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
    requestSha256,
    producerId: PRODUCER_ID,
    producerVersion: "1",
    producerScopeSha256: PRODUCER_SCOPE,
    acquisitionReceiptSha256: sha("receipt"),
    observedAt: "2026-09-14T18:00:00.000Z",
    original: {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
      mediaType: source.mediaType,
      locatorSha256: sha(source.repositoryPath),
      version: { kind: "repository-revision", revision: REVISION },
      repositoryPath: source.repositoryPath,
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
    canonicalLocator: `repository-document:${source.repositoryPath}`,
    safeTitle: "Release notes",
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
    now: () => new Date("2026-09-14T18:05:00.000Z"),
  };
  const service = createSourceEvidenceService(createSourceEvidenceHostAuthority(verifier));
  const capability = service.bindRun(
    createSourceArtifactReference({
      kind: "source-binding",
      digest: binding.bindingSha256,
      repositoryRevision: REVISION,
      repositoryContentDigest: CONTENT_DIGEST,
    }),
    {
      runId: RUN_ID,
      requestSha256,
      repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
      workspaceIdentitySha256: WORKSPACE_IDENTITY,
      repositoryContentDigest: CONTENT_DIGEST,
    },
  );
  const spanTexts = representation.spans.map((span) =>
    Buffer.from(derivative.subarray(span.startByte, span.endByte)).toString("utf8"),
  );
  return {
    capability,
    observationId,
    representationId: representation.representationId,
    spanIds: representation.spans.map((span) => span.spanId),
    spanTexts,
  };
}

async function toolSet(reader?: SourceStepReaderV1) {
  const workspacePath = await mkdtemp(join(tmpdir(), "docsfab-source-grants-"));
  workspaces.push(workspacePath);
  return createConfinedToolSet({
    workspacePath,
    allowWrite: false,
    ...(reader ? { sourceReader: reader } : {}),
  });
}

function readSourceTool(definitions: Array<{ name: string }>) {
  return definitions.find((definition) => definition.name === "docsfab_read_source");
}

function listSourcesTool(definitions: Array<{ name: string }>) {
  return definitions.find((definition) => definition.name === "docsfab_list_sources");
}

describe("source kernel grants", () => {
  it("names exactly the two source kernel tools", () => {
    // Listing is the only channel through which a step learns a span id, so it
    // is granted and confined by the same switch that governs reading.
    // `docsfab_search_sources` is admitted by a separate grant, so the reader
    // grant is exactly these two names; `test/source-command-admission.test.ts`
    // pins the full vocabulary.
    expect([...SOURCE_READ_TOOL_NAMES]).toEqual(["docsfab_list_sources", "docsfab_read_source"]);
    expect([...SOURCE_READ_TOOL_NAMES]).not.toContain("docsfab_search_sources");
    expect([...SOURCE_TOOL_NAMES]).toContain("docsfab_search_sources");
  });

  it("does not expose either tool to a step with no reader", async () => {
    // The positive control is the granted case below; this is the same tool set
    // with the single difference that the host granted no reader.
    const set = await toolSet(undefined);
    expect(readSourceTool(set.definitions)).toBeUndefined();
    expect(listSourcesTool(set.definitions)).toBeUndefined();
  });

  it("exposes the inventory tool under exactly the same grant as the reader", async () => {
    const { capability } = await buildCapability();
    const reader = capability.forStep({
      stepId: "plan-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    })!;
    const set = await toolSet(reader);
    expect(listSourcesTool(set.definitions)).toBeDefined();
    expect(readSourceTool(set.definitions)).toBeDefined();
  });

  it("exposes the tool only when the host handed this step a reader", async () => {
    const { capability } = await buildCapability();
    const reader = capability.forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    })!;
    const set = await toolSet(reader);
    expect(readSourceTool(set.definitions)).toBeDefined();
  });

  it("keeps the tool out of the skill-lock filesystem policy", () => {
    expect(skillPolicyTools("write")).not.toContain("docsfab_read_source");
    expect(skillPolicyTools("read-only")).not.toContain("docsfab_read_source");
  });

  it("adds the tool to the model grant set only under a live reader", () => {
    expect(grantedTools("read-only", "inference", undefined, false)).not.toContain(
      "docsfab_read_source",
    );
    expect(grantedTools("write", "inference", undefined, false)).not.toContain(
      "docsfab_read_source",
    );
    expect(grantedTools("read-only", "inference", undefined, true)).toContain(
      "docsfab_read_source",
    );
    expect(grantedTools("write", "inference", undefined, true)).toContain("docsfab_read_source");
  });

  it("never grants a source read to a skill the policy does not admit", () => {
    expect(stepAdmitsSourceRead(POLICY, { skill: "plan-documentation" })).toBe(false);
    expect(stepAdmitsSourceRead(POLICY, { skill: "write-documentation" })).toBe(true);
    expect(stepAdmitsSourceRead(undefined, { skill: "write-documentation" })).toBe(false);
  });

  it("returns the exact retained bytes for a granted span", async () => {
    const { capability, representationId, spanIds, spanTexts } = await buildCapability();
    const reader = capability.forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    })!;
    const set = await toolSet(reader);
    const tool = readSourceTool(set.definitions)!;
    const result = await (tool as any).execute("call-1", {
      observationId: "obs-release-notes",
      representationId,
      spanIds: [spanIds[spanTexts.indexOf(READER_SENTENCE)]],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.kind).toBe("docsfab-source-span-read");
    expect(payload.text).toBe(READER_SENTENCE);
    expect(result.details.spanAccessSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(capability.spanAccesses()).toHaveLength(1);
  });

  it("refuses a span outside the sealed binding with a safe label", async () => {
    const { capability, representationId } = await buildCapability();
    const reader = capability.forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    })!;
    const set = await toolSet(reader);
    const tool = readSourceTool(set.definitions)!;
    await expect(
      (tool as any).execute("call-1", {
        observationId: "obs-release-notes",
        representationId,
        spanIds: ["span-not-in-this-binding"],
      }),
    ).rejects.toThrowError(
      "DocsFab refused this source read because the host reported span-unavailable.",
    );
    expect(capability.spanAccesses()).toHaveLength(0);
    expect(set.getFailureCategories()).toContainEqual({ category: "denied-path", count: 1 });
  });

  it("refuses a foreign observation", async () => {
    const { capability, representationId, spanIds } = await buildCapability();
    const reader = capability.forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    })!;
    const set = await toolSet(reader);
    const tool = readSourceTool(set.definitions)!;
    await expect(
      (tool as any).execute("call-1", {
        observationId: "obs-somewhere-else",
        representationId,
        spanIds: [spanIds[0]],
      }),
    ).rejects.toThrowError(
      "DocsFab refused this source read because the host reported observation-unavailable.",
    );
  });

  it("gives the model no way to name a path, a URL, or a policy", async () => {
    const { capability } = await buildCapability();
    const reader = capability.forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    })!;
    const set = await toolSet(reader);
    const tool = readSourceTool(set.definitions)! as unknown as {
      parameters: { properties: Record<string, unknown>; additionalProperties: boolean };
    };
    expect(Object.keys(tool.parameters.properties).sort()).toEqual([
      "diffFile",
      "diffHunk",
      "fromByte",
      "maxBytes",
      "observationId",
      "representationId",
      "source",
      "spanIds",
    ]);
    // A source is named by a host-issued handle, never a path. Every argument
    // is optional and nullable, so a provider that fills each one sends null.
    expect(tool.parameters.properties.source).toMatchObject({ type: ["string", "null"] });
    // The window and diff fields are offsets, sizes, and ordinals: integers, never a
    // name. 0 is admitted so it reaches the host, which reads it as unused.
    for (const name of ["fromByte", "maxBytes", "diffFile", "diffHunk"]) {
      expect(tool.parameters.properties[name]).toMatchObject({
        type: ["integer", "null"],
        minimum: 0,
      });
    }
    expect(tool.parameters.additionalProperties).toBe(false);
  });

  it("refuses a malformed selection before touching the reader", async () => {
    const { capability } = await buildCapability();
    const reader = capability.forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    })!;
    const set = await toolSet(reader);
    const tool = readSourceTool(set.definitions)!;
    await expect((tool as any).execute("call-1", {})).rejects.toThrowError(
      "DocsFab refused this source read because the host reported span-unavailable. Name the source to read: pass source, a handle docsfab_list_sources returned: s1. No source text was returned.",
    );
    // Every id left unused names no source either.
    await expect(
      (tool as any).execute("call-2", {
        source: null,
        observationId: "",
        representationId: "",
      }),
    ).rejects.toThrowError(
      "DocsFab refused this source read because the host reported span-unavailable. Name the source to read: pass source, a handle docsfab_list_sources returned: s1. No source text was returned.",
    );
    expect(capability.spanAccesses()).toHaveLength(0);
  });

  it("sets aside each unused value a provider fills an argument with, and counts it by kind", async () => {
    const { capability, spanIds, spanTexts } = await buildCapability();
    const reader = capability.forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    })!;
    const set = await toolSet(reader);
    const tool = readSourceTool(set.definitions)! as any;
    const read = async (id: string, params: Record<string, unknown>) =>
      JSON.parse((await tool.execute(id, { source: "s1", ...params })).content[0].text);
    const span = [spanIds[0]];
    // One unused value per call, so each rule stands alone.
    const spanReads: Array<[string, Record<string, unknown>]> = [
      ["null", { spanIds: span, fromByte: null }],
      ["empty-string", { spanIds: span, observationId: "" }],
      ["max-bytes-zero", { spanIds: span, maxBytes: 0 }],
      ["diff-file-zero", { spanIds: span, diffFile: 0 }],
      ["diff-hunk-zero", { spanIds: span, diffHunk: 0 }],
      ["from-byte-zero", { spanIds: span, fromByte: 0 }],
      ["placeholder-id", { spanIds: span, representationId: "<representationId>" }],
      ["not-a-diff", { spanIds: span, diffFile: 1, diffHunk: 1 }],
    ];
    for (const [id, params] of spanReads) {
      expect(await read(id, params), id).toMatchObject({
        kind: "docsfab-source-span-read",
        spanIds: span,
        text: spanTexts[0],
      });
    }
    // An empty span list and a zero maxBytes leave a window from byte 0.
    expect(await read("empty-list", { spanIds: [], maxBytes: 0 })).toMatchObject({
      kind: "docsfab-source-window-read",
      fromByte: 0,
    });
    expect(set.getToolArgumentFiller()).toEqual([
      {
        tool: "docsfab_read_source",
        argument: "diffFile",
        kind: "inapplicable",
        count: 1,
      },
      {
        tool: "docsfab_read_source",
        argument: "diffFile",
        kind: "zero",
        count: 1,
      },
      {
        tool: "docsfab_read_source",
        argument: "diffHunk",
        kind: "inapplicable",
        count: 1,
      },
      {
        tool: "docsfab_read_source",
        argument: "diffHunk",
        kind: "zero",
        count: 1,
      },
      {
        tool: "docsfab_read_source",
        argument: "fromByte",
        kind: "null",
        count: 1,
      },
      {
        tool: "docsfab_read_source",
        argument: "fromByte",
        kind: "zero",
        count: 1,
      },
      {
        tool: "docsfab_read_source",
        argument: "maxBytes",
        kind: "zero",
        count: 2,
      },
      {
        tool: "docsfab_read_source",
        argument: "observationId",
        kind: "empty",
        count: 1,
      },
      {
        tool: "docsfab_read_source",
        argument: "representationId",
        kind: "unissued-id",
        count: 1,
      },
      {
        tool: "docsfab_read_source",
        argument: "spanIds",
        kind: "empty",
        count: 1,
      },
    ]);
    // A meaningful value beside span ids is still a second selection.
    await expect(
      tool.execute("from-one", { source: "s1", spanIds: span, fromByte: 1 }),
    ).rejects.toThrowError(
      `DocsFab refused this source read because the host reported span-unavailable. spanIds cannot be combined with a fromByte after 0: a read by span ids returns those spans whole. Send fromByte as null, or omit it, beside spanIds. ${READ_FORMS} No source text was returned.`,
    );
    await expect(tool.execute("negative", { source: "s1", maxBytes: -1 })).rejects.toThrowError(
      "maxBytes must be a whole number of 1 or more.",
    );
  });

  it("refuses a diff file read of a source that is not a diff, and a window after byte 0 beside span ids", async () => {
    const { capability, observationId, representationId, spanIds } = await buildCapability();
    const reader = capability.forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    })!;
    const set = await toolSet(reader);
    const tool = readSourceTool(set.definitions)! as any;
    await expect(
      tool.execute("call-1", { observationId, representationId, diffFile: 1 }),
    ).rejects.toThrowError(
      "DocsFab refused this source read because the host reported span-unavailable. This representation is not a unified diff, so diffFile and diffHunk do not apply. Read it by span ids or by fromByte. No source text was returned.",
    );
    await expect(
      tool.execute("call-2", { observationId, representationId, fromByte: 1, spanIds }),
    ).rejects.toThrowError(
      `DocsFab refused this source read because the host reported span-unavailable. spanIds cannot be combined with a fromByte after 0: a read by span ids returns those spans whole. Send fromByte as null, or omit it, beside spanIds. ${READ_FORMS} No source text was returned.`,
    );
    await expect(
      tool.execute("call-3", { observationId, representationId, diffHunk: 1 }),
    ).rejects.toThrowError(
      "DocsFab refused this source read because the host reported span-unavailable. diffHunk needs diffFile, the number of the file the hunk belongs to. No source text was returned.",
    );
    expect(capability.spanAccesses()).toHaveLength(0);
  });

  it("answers every read shape with source text or a refusal that says what to change", async () => {
    const { capability, observationId, representationId, spanIds } = await buildCapability();
    const reader = capability.forStep({
      stepId: "plan-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    })!;
    const set = await toolSet(reader);
    const tool = readSourceTool(set.definitions)! as any;
    const ids = { observationId, representationId };
    const read = async (id: string, params: Record<string, unknown>) =>
      JSON.parse((await tool.execute(id, { ...ids, ...params })).content[0].text);
    const refusal = (detail: string) =>
      `DocsFab refused this source read because the host reported span-unavailable. ${detail} No source text was returned.`;
    const sizes = reader.listSources().map((entry) => entry.endByte - entry.startByte);

    // The observation and representation alone read a window from byte 0.
    const { remainingBudgetBytes: _whole, ...whole } = await read("whole", {});
    const { remainingBudgetBytes: _window, ...window } = await read("window", { fromByte: 0 });
    expect(whole).toEqual(window);
    // maxBytes bounds a read by span ids: within it, the spans are read.
    const bounded = await read("bounded", { spanIds: [spanIds[0]], maxBytes: sizes[0] });
    expect(bounded).toMatchObject({ kind: "docsfab-source-span-read", spanIds: [spanIds[0]] });
    // Past it, the read refuses with the spans' size, and nothing is recorded.
    const accesses = capability.spanAccesses().length;
    await expect(
      tool.execute("over", { ...ids, spanIds: spanIds.slice(0, 2), maxBytes: sizes[0] }),
    ).rejects.toThrowError(
      refusal(
        `These 2 spans hold ${sizes[0]! + sizes[1]!} bytes, more than maxBytes ${sizes[0]}. Name fewer span ids, raise maxBytes, or read a window from the first span's startByte.`,
      ),
    );
    // A span id or representation id the listing never issued names the fix.
    await expect(
      tool.execute("unknown-span", { ...ids, spanIds: [spanIds[0], `span-${"b".repeat(64)}`] }),
    ).rejects.toThrowError(
      refusal(
        "1 of the 2 span ids are not spans of this representation. Take span ids from docsfab_list_sources for the same source, or read a window from fromByte 0.",
      ),
    );
    await expect(
      tool.execute("unknown-representation", {
        observationId,
        representationId: `rep-${"c".repeat(64)}`,
        fromByte: 0,
      }),
    ).rejects.toThrowError(
      refusal(
        "That representationId is not a representation of this observation. Pass source with its handle instead: s1.",
      ),
    );
    await expect(
      tool.execute("both", { ...ids, spanIds: [spanIds[0]], fromByte: 1 }),
    ).rejects.toThrowError(
      refusal(
        `spanIds cannot be combined with a fromByte after 0: a read by span ids returns those spans whole. Send fromByte as null, or omit it, beside spanIds. ${READ_FORMS}`,
      ),
    );
    // An observation with one representation needs no representation id.
    const alone = JSON.parse((await tool.execute("no-rep", { observationId })).content[0].text);
    expect(alone).toMatchObject({ kind: "docsfab-source-window-read", source: "s1", fromByte: 0 });
    // An observation id the listing never issued names what to send instead.
    await expect(
      tool.execute("unissued", { observationId: "obs-release-notez", representationId }),
    ).rejects.toThrowError(
      "DocsFab refused this source read because the host reported observation-unavailable. That observationId is not a source this step may read. Pass source, a handle docsfab_list_sources returned (s1), instead of observationId and representationId; call docsfab_list_sources again to see them. No source text was returned.",
    );
    // Only the one read that named an issued observation was charged.
    expect(capability.spanAccesses()).toHaveLength(accesses + 1);
  });

  it("refuses a read once a later step superseded the reader", async () => {
    const { capability, representationId, spanIds } = await buildCapability();
    const reader = capability.forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    })!;
    const set = await toolSet(reader);
    capability.forStep({
      stepId: "verify-technical-accuracy",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    });
    const tool = readSourceTool(set.definitions)!;
    await expect(
      (tool as any).execute("call-1", {
        observationId: "obs-release-notes",
        representationId,
        spanIds: [spanIds[0]],
      }),
    ).rejects.toThrowError(
      "DocsFab refused this source read because the host reported stale-capability.",
    );
  });

  it("re-grants the source-read budget on a retried read-only attempt", async () => {
    // Budget sized for exactly one identical read. Without restoring remaining
    // bytes at the start of attempt 2, that second read would be refused.
    const built = await buildCapability();
    const sentenceIndex = built.spanTexts.indexOf(READER_SENTENCE);
    const oneReadBytes = Buffer.byteLength(READER_SENTENCE, "utf8");
    const grant = {
      stepId: "plan-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: oneReadBytes,
    };
    const selection = {
      observationId: built.observationId,
      representationId: built.representationId,
      spanIds: [built.spanIds[sentenceIndex]!],
    };
    const reader = built.capability.forStep(grant)!;
    const reads: string[] = [];
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy: {
        maxRetries: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
        retryableCategories: ["malformed-response"],
      },
      execute: async (attempt) => {
        beginSourceReadAttempt(reader);
        reads.push(reader.read(selection).text);
        if (attempt === 1) {
          throw new InferenceStepError(
            "structured response did not conform",
            "malformed-response",
            true,
          );
        }
        return { summary: "retry succeeded" };
      },
      sleep: async () => {},
    });
    expect(execution.status).toBe("succeeded");
    expect(reads).toEqual([READER_SENTENCE, READER_SENTENCE]);

    const starved = built.capability.forStep(grant)!;
    expect(starved.read(selection).text).toBe(READER_SENTENCE);
    expect(() => starved.read(selection)).toThrowError(serviceRefusal("budget-exhausted"));
  });
});

describe("source span inventory disclosure (#835)", () => {
  async function grantedInventory(
    stepId = "write-documentation",
    bytes: Uint8Array = HTML,
    observationId = "obs-release-notes",
  ) {
    const built = await buildCapability(bytes, observationId);
    const reader = built.capability.forStep({
      stepId,
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    })!;
    const set = await toolSet(reader);
    return {
      ...built,
      capability: built.capability,
      reader,
      set,
      tool: listSourcesTool(set.definitions)!,
    };
  }

  /** The listing, with each span row joined to its source row as a model would. */
  async function listed(tool: { execute: (...args: any[]) => Promise<any> }) {
    const text = (await tool.execute("call-1", {})).content[0].text as string;
    const payload = JSON.parse(text) as SourceListing;
    return { ...payload, raw: payload, spans: listedInventory(payload) };
  }

  it("enumerates exactly the spans this step may read", async () => {
    const { tool, spanIds, representationId } = await grantedInventory();
    const inventory = await listed(tool);
    expect(inventory.kind).toBe("docsfab-source-span-inventory");
    expect(inventory.truncated).toBe(false);
    expect(inventory.spans.map((entry) => entry.spanId)).toEqual(spanIds);
    expect(inventory.spanCount).toBe(spanIds.length);
    for (const entry of inventory.spans) {
      expect(entry.observationId).toBe("obs-release-notes");
      expect(entry.representationId).toBe(representationId);
      expect(entry.repositoryPath).toBe("docs/release-notes.html");
      expect(entry.mediaType).toBe("text/html");
      expect(entry.locator.kind).toBe("html-node");
      expect(entry.endByte).toBeGreaterThan(entry.startByte);
    }
  });

  it("never returns source text, only identity and position", async () => {
    const { tool, spanTexts } = await grantedInventory();
    const raw = JSON.stringify(await listed(tool));
    // Every readable sentence of the derivative must be absent from the listing.
    for (const text of spanTexts) {
      expect(text.length).toBeGreaterThan(0);
      expect(raw).not.toContain(text);
    }
    expect(raw).not.toContain(READER_SENTENCE);
    expect(raw).not.toContain("must never reach the derivative");
    const inventory = await listed(tool);
    // A span names its source by handle; the long ids live once, on the source row.
    for (const entry of inventory.raw.spans) {
      expect(Object.keys(entry).sort()).toEqual([
        "endByte",
        "locator",
        "source",
        "spanId",
        "startByte",
      ]);
    }
  });

  it("hands the reader identifiers that actually read, closing the loop", async () => {
    // Positive control for the whole disclosure: a step that knows nothing but
    // what the inventory told it can complete a read.
    const { tool, set } = await grantedInventory();
    const inventory = await listed(tool);
    const first = inventory.spans[0]!;
    const read = readSourceTool(set.definitions)!;
    const result = await (read as any).execute("call-2", {
      observationId: first.observationId,
      representationId: first.representationId,
      spanIds: [first.spanId],
    });
    const payload = JSON.parse(result.content[0].text) as { text: string };
    expect(payload.text.length).toBeGreaterThan(0);
    expect(result.details.spanAccessSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("refuses a span id the inventory did not admit for this step", async () => {
    const { tool, set } = await grantedInventory();
    const admitted = new Set((await listed(tool)).spans.map((entry) => entry.spanId));
    // A well-formed span id from a different run: never listed, never readable.
    const foreign = `span-${"b".repeat(64)}`;
    expect(admitted.has(foreign)).toBe(false);
    const read = readSourceTool(set.definitions)!;
    await expect(
      (read as any).execute("call-3", {
        observationId: "obs-release-notes",
        representationId: (await listed(tool)).spans[0]!.representationId,
        spanIds: [foreign],
      }),
    ).rejects.toThrowError(
      "DocsFab refused this source read because the host reported span-unavailable.",
    );
  });

  it("refuses to list through a superseded step capability", async () => {
    const { capability } = await buildCapability();
    const reader = capability.forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    })!;
    const set = await toolSet(reader);
    // A later step supersedes the earlier reader, exactly as it does for read.
    capability.forStep({
      stepId: "verify-technical-accuracy",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    });
    const tool = listSourcesTool(set.definitions)!;
    await expect((tool as any).execute("call-4", {})).rejects.toThrowError(
      "DocsFab refused this source read because the host reported stale-capability.",
    );
  });

  it("gives an ungranted step no inventory at all", async () => {
    const { capability } = await buildCapability();
    const reader = capability.forStep({
      stepId: "lint-documentation",
      workflow: "create-documentation",
      readSource: false,
      remainingBudgetBytes: POLICY.perStepBudgetBytes,
    });
    expect(reader).toBeUndefined();
    const set = await toolSet(undefined);
    expect(listSourcesTool(set.definitions)).toBeUndefined();
  });

  it("leaves the run inert: no access, no budget spent, gate still blocked", async () => {
    // A listing that recorded access evidence would satisfy the required-source
    // write gate without a single byte being read.
    const { capability, tool } = await grantedInventory();
    const observationsBefore = capability.observations.map((entry) => entry.observationId);

    expect(capability.spanAccesses()).toHaveLength(0);
    await listed(tool);
    await listed(tool);
    await listed(tool);

    expect(capability.spanAccesses()).toHaveLength(0);
    expect(capability.observations.map((entry) => entry.observationId)).toEqual(observationsBefore);

    // The write gate still blocks, using the same coverage function the runner
    // calls, because nothing was actually read.
    const coverage = sourceRequiredCoverage({
      binding: capability.binding,
      observations: capability.observations,
      spanAccesses: capability.spanAccesses(),
    });
    expect(coverage).toEqual([{ observationId: "obs-release-notes", status: "unread" }]);
    expect(sourceEvidenceRequiredGapCodes({ requiredCoverage: coverage })).toEqual([
      "obs-release-notes:unread",
    ]);
  });

  it("spends no read budget, so a full-budget read still succeeds after listing", async () => {
    // A listing that charged the budget would starve the read that follows.
    // The budget here is exactly the bytes of every span, so any charge at all
    // makes the read below fail with budget-exhausted.
    const built = await buildCapability();
    const exactBudget = built.spanTexts.reduce(
      (total, text) => total + Buffer.byteLength(text, "utf8"),
      0,
    );
    const reader = built.capability.forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: exactBudget,
    })!;
    const set = await toolSet(reader);
    const list = listSourcesTool(set.definitions)!;
    for (let attempt = 0; attempt < 5; attempt += 1) await (list as any).execute("call-b", {});

    const read = readSourceTool(set.definitions)!;
    const result = await (read as any).execute("call-c", {
      observationId: built.observationId,
      representationId: built.representationId,
      spanIds: [...built.spanIds],
    });
    const payload = JSON.parse(result.content[0].text) as { text: string };
    expect(payload.text.length).toBeGreaterThan(0);
    // Reading consumed the budget; the listings did not.
    expect(built.capability.spanAccesses()).toHaveLength(1);
  });

  it("lists only the spans of the run it was bound to", async () => {
    // Two runs over different bytes, so their span ids are disjoint by
    // construction. A reader that enumerated a module-wide pool instead of its
    // own run would return the union and fail the assertions below.
    const first = await grantedInventory();
    const second = await grantedInventory(
      "verify-technical-accuracy",
      DIVERGENT_HTML,
      "obs-divergent-release-notes",
    );
    expect(second.spanIds).not.toEqual(first.spanIds);

    const firstListed = (await listed(first.tool)).spans;
    const secondListed = (await listed(second.tool)).spans;
    expect(firstListed.map((entry) => entry.spanId)).toEqual(first.spanIds);
    expect(secondListed.map((entry) => entry.spanId)).toEqual(second.spanIds);

    // Neither listing contains a single identifier belonging to the other run.
    const foreignToFirst = new Set(second.spanIds);
    expect(firstListed.some((entry) => foreignToFirst.has(entry.spanId))).toBe(false);
    const foreignToSecond = new Set(first.spanIds);
    expect(secondListed.some((entry) => foreignToSecond.has(entry.spanId))).toBe(false);
    expect(firstListed.every((entry) => entry.observationId === "obs-release-notes")).toBe(true);
    expect(
      secondListed.every((entry) => entry.observationId === "obs-divergent-release-notes"),
    ).toBe(true);
  });
});

describe("required-source reads into a write step (#1808)", () => {
  function wholeBytes(built: Awaited<ReturnType<typeof buildCapability>>): number {
    return built.spanTexts.reduce((total, text) => total + Buffer.byteLength(text, "utf8"), 0);
  }

  function plan(built: Awaited<ReturnType<typeof buildCapability>>, budgetBytes: number) {
    return planRequiredSourceReads({
      binding: built.capability.binding,
      observations: built.capability.observations,
      spanAccesses: built.capability.spanAccesses(),
      budgetBytes,
    });
  }

  function coverageOf(built: Awaited<ReturnType<typeof buildCapability>>) {
    return sourceRequiredReadCoverage({
      binding: built.capability.binding,
      observations: built.capability.observations,
      spanAccesses: built.capability.spanAccesses(),
    });
  }

  it("plans every span of an unread required source, then only the spans no step has read", async () => {
    const built = await buildCapability();
    const bytes = wholeBytes(built);

    expect(plan(built, POLICY.perStepBudgetBytes)).toEqual({
      kind: "read",
      reads: [
        {
          observationId: built.observationId,
          representationId: built.representationId,
          repositoryPath: "docs/release-notes.html",
          spanIds: built.spanIds,
          bytes,
          priorReadBytes: 0,
          totalBytes: bytes,
        },
      ],
      neededBytes: bytes,
      budgetBytes: POLICY.perStepBudgetBytes,
    });

    // One span read is part of the source, not the whole source: the source is
    // partial, never considered, and the write step plans only the rest (#1809).
    const firstBytes = Buffer.byteLength(built.spanTexts[0]!, "utf8");
    built.capability
      .forStep({
        stepId: "verify-technical-accuracy",
        workflow: "create-documentation",
        readSource: true,
        remainingBudgetBytes: POLICY.perStepBudgetBytes,
      })!
      .read({
        observationId: built.observationId,
        representationId: built.representationId,
        spanIds: [built.spanIds[0]!],
      });
    expect(coverageOf(built)).toEqual([
      {
        observationId: built.observationId,
        repositoryPath: "docs/release-notes.html",
        status: "partial",
        readBytes: firstBytes,
        totalBytes: bytes,
      },
    ]);
    expect(plan(built, POLICY.perStepBudgetBytes)).toEqual({
      kind: "read",
      reads: [
        {
          observationId: built.observationId,
          representationId: built.representationId,
          repositoryPath: "docs/release-notes.html",
          spanIds: built.spanIds.slice(1),
          bytes: bytes - firstBytes,
          priorReadBytes: firstBytes,
          totalBytes: bytes,
        },
      ],
      neededBytes: bytes - firstBytes,
      budgetBytes: POLICY.perStepBudgetBytes,
    });

    // Once two steps between them read every span, nothing is left to plan.
    // This HTML extract left out its script and hidden block, so the source
    // stays partial for that extraction limitation, with every byte read.
    built.capability
      .forStep({
        stepId: "write-documentation",
        workflow: "create-documentation",
        readSource: true,
        remainingBudgetBytes: POLICY.perStepBudgetBytes,
      })!
      .read({
        observationId: built.observationId,
        representationId: built.representationId,
        spanIds: built.spanIds.slice(1),
      });
    expect(built.capability.observations[0]!.representations[0]!.completeness).toBe("partial");
    expect(coverageOf(built)).toEqual([
      {
        observationId: built.observationId,
        repositoryPath: "docs/release-notes.html",
        status: "partial",
        readBytes: bytes,
        totalBytes: bytes,
      },
    ]);
    expect(plan(built, POLICY.perStepBudgetBytes)).toEqual({
      kind: "read",
      reads: [],
      neededBytes: 0,
      budgetBytes: POLICY.perStepBudgetBytes,
    });
  });

  it("calls a complete extract considered only once every span was read", async () => {
    const built = await buildCapability(requirementsText(8), "obs-requirements", TEXT_SOURCE);
    const bytes = wholeBytes(built);
    expect(built.capability.observations[0]!.representations[0]!.completeness).toBe("complete");
    const reader = built.capability.forStep({
      stepId: "plan-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: bytes,
    })!;
    const selection = {
      observationId: built.observationId,
      representationId: built.representationId,
    };
    reader.read({ ...selection, spanIds: built.spanIds.slice(0, -1) });
    // Every span but one is still part of the source, not all of it.
    expect(coverageOf(built).map((entry) => entry.status)).toEqual(["partial"]);
    reader.read({ ...selection, spanIds: built.spanIds.slice(-1) });
    expect(coverageOf(built)).toEqual([
      {
        observationId: built.observationId,
        repositoryPath: "docs/requirements.txt",
        status: "considered",
        readBytes: bytes,
        totalBytes: bytes,
      },
    ]);
  });

  it("reads whole at exactly the budget, a window one byte under it, and stops only when no span fits", async () => {
    const built = await buildCapability();
    const bytes = wholeBytes(built);
    const spanSizes = built.spanTexts.map((text) => Buffer.byteLength(text, "utf8"));

    const exact = plan(built, bytes);
    expect(exact.kind === "read" ? exact.reads.map((read) => read.spanIds) : exact).toEqual([
      built.spanIds,
    ]);

    // One byte under: every span but the last. The source is read in part,
    // not left unreachable.
    expect(plan(built, bytes - 1)).toEqual({
      kind: "read",
      reads: [
        {
          observationId: built.observationId,
          representationId: built.representationId,
          repositoryPath: "docs/release-notes.html",
          spanIds: built.spanIds.slice(0, -1),
          bytes: bytes - spanSizes.at(-1)!,
          priorReadBytes: 0,
          totalBytes: bytes,
        },
      ],
      neededBytes: bytes,
      budgetBytes: bytes - 1,
    });

    // Not even the first span fits: the step stops before reading anything.
    const underFirstSpan = spanSizes[0]! - 1;
    expect(underFirstSpan).toBeGreaterThan(0);
    expect(plan(built, underFirstSpan)).toEqual({
      kind: "stop",
      gapCodes: [`${built.observationId}:unread`],
      gaps: [
        {
          observationId: built.observationId,
          repositoryPath: "docs/release-notes.html",
          reason: "over-read-budget",
          bytes,
        },
      ],
      neededBytes: bytes,
      budgetBytes: underFirstSpan,
    });
    // At exactly the first span it reads that span.
    const firstOnly = plan(built, spanSizes[0]!);
    expect(
      firstOnly.kind === "read" ? firstOnly.reads.map((read) => read.spanIds) : firstOnly,
    ).toEqual([[built.spanIds[0]]]);
    // A step without a reader has no budget at all.
    expect(plan(built, 0).kind).toBe("stop");
    expect(built.capability.spanAccesses()).toEqual([]);
  });

  it("keeps the bytes the host read charged to every later attempt of the step", async () => {
    const built = await buildCapability();
    const bytes = wholeBytes(built);
    const sentence = built.spanIds[built.spanTexts.indexOf(READER_SENTENCE)]!;
    const oneSpan = {
      observationId: built.observationId,
      representationId: built.representationId,
      spanIds: [sentence],
    };
    const grant = {
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: bytes + Buffer.byteLength(READER_SENTENCE, "utf8"),
    };
    const everySpan = built.spanIds.map((spanId) => ({ ...oneSpan, spanIds: [spanId] }));

    const reader = built.capability.forStep(grant)!;
    const results = readSourceSpansForEveryAttempt(reader, everySpan);
    expect(results.map((result) => result.text)).toEqual(built.spanTexts);
    expect(results.map((result) => result.spanAccess.stepId)).toEqual(
      built.spanIds.map(() => "write-documentation"),
    );
    // Each attempt restores what the host read left, not the whole grant.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      beginSourceReadAttempt(reader);
      expect(reader.read(oneSpan).text).toBe(READER_SENTENCE);
      expect(() => reader.read(oneSpan)).toThrowError(serviceRefusal("budget-exhausted"));
    }

    // Positive control: reads the model makes in one attempt are restored.
    const modelReader = built.capability.forStep(grant)!;
    for (const selection of everySpan) modelReader.read(selection);
    beginSourceReadAttempt(modelReader);
    for (const selection of everySpan) modelReader.read(selection);
  });

  it("classifies the stop by its code, with a catalogued class and next action", () => {
    const stop = new RequiredSourceUnreadError({
      stepId: "write-documentation",
      gapCodes: ["obs-requirements:unread"],
      gaps: [
        {
          observationId: "obs-requirements",
          repositoryPath: "docs/requirements.txt",
          reason: "over-read-budget",
          bytes: 39_789,
        },
      ],
      neededBytes: 39_789,
      budgetBytes: 512,
    });
    expect(stop.code).toBe("required-source-unread");
    expect(stop.message).toBe(
      'Workflow step "write-documentation" cannot write while required source evidence is missing (obs-requirements:unread). ' +
        "No earlier step read docs/requirements.txt (39789 bytes) with docsfab_read_source, and not one span of it fits in what is left of the step's source-read budget of 512 bytes (sources.readResponseCeilingBytes); reading what is left of every required source needs 39789 bytes. " +
        "Raise DOCSFAB_SOURCES_READ_RESPONSE_CEILING_BYTES to at least 39789, or bind fewer or smaller sources, such as fewer --source files or a narrower merge-request date range, then start a new run.",
    );
    expect(classifyThrownFailure(stop, "workflow")).toEqual({
      class: "bound",
      layer: "workflow",
      code: "required-source-unread",
    });
    // The same words without the code are the defect this stop replaced.
    expect(classifyThrownFailure(new Error(stop.message), "workflow").code).toBe("uncoded-error");
    expect(DEFAULT_NEXT_ACTIONS["required-source-unread"]).toContain(
      "sources.readResponseCeilingBytes",
    );
    // The bound is raisable, so the next action says how to raise it.
    expect(DEFAULT_NEXT_ACTIONS["required-source-unread"]).toContain(
      "Raise DOCSFAB_SOURCES_READ_RESPONSE_CEILING_BYTES",
    );
  });

  it("names each source that has no span or that the host could not acquire", () => {
    const message = new RequiredSourceUnreadError({
      stepId: "revise-documentation",
      gapCodes: ["obs-empty:unread", "obs-gone:unavailable"],
      gaps: [
        {
          observationId: "obs-empty",
          repositoryPath: "docs/empty.txt",
          reason: "no-readable-span",
        },
        { observationId: "obs-gone", repositoryPath: null, reason: "unavailable" },
      ],
      neededBytes: 0,
      budgetBytes: 32_768,
    }).message;
    expect(message).toBe(
      'Workflow step "revise-documentation" cannot write while required source evidence is missing (obs-empty:unread, obs-gone:unavailable). ' +
        "docs/empty.txt has no readable span. Drop each such source from this run, then start a new run. " +
        "The host could not acquire obs-gone. Re-attach each unavailable required source at a revision the host can read, or drop it from this run, then run again.",
    );
  });
});

describe("windowed source reads (#1809)", () => {
  function wholeBytes(built: Awaited<ReturnType<typeof buildCapability>>): number {
    return built.spanTexts.reduce((total, text) => total + Buffer.byteLength(text, "utf8"), 0);
  }

  function readerFor(
    built: Awaited<ReturnType<typeof buildCapability>>,
    stepId: string,
    remainingBudgetBytes: number,
  ) {
    return built.capability.forStep({
      stepId,
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes,
    })!;
  }

  it("pages a source larger than one step's budget across two steps to whole coverage", async () => {
    const built = await buildCapability(requirementsText(12), "obs-requirements", TEXT_SOURCE);
    const bytes = wholeBytes(built);
    const half = Math.ceil(bytes / 2);
    const selection = {
      observationId: built.observationId,
      representationId: built.representationId,
    };

    // Neither budget alone holds the source; the first step reads a window.
    const first = readSourceWindow(readerFor(built, "plan-documentation", half), {
      ...selection,
      fromByte: 0,
    });
    expect(first.readBytes).toBeGreaterThan(0);
    expect(first.readBytes).toBeLessThanOrEqual(half);
    expect(first.totalBytes).toBe(bytes);
    expect(first.remainingBudgetBytes).toBe(half - first.readBytes);
    expect(first.nextFromByte).not.toBeNull();
    const count = first.spans.length;
    expect(first.spans.map((span) => span.spanId)).toEqual(built.spanIds.slice(0, count));
    expect(first.spans.map((span) => span.text)).toEqual(built.spanTexts.slice(0, count));
    expect(
      sourceRequiredCoverage({
        binding: built.capability.binding,
        observations: built.capability.observations,
        spanAccesses: built.capability.spanAccesses(),
      }),
    ).toEqual([{ observationId: built.observationId, status: "partial" }]);

    // A later step continues from nextFromByte with exactly the bytes left.
    const second = readSourceWindow(
      readerFor(built, "write-documentation", bytes - first.readBytes),
      {
        ...selection,
        fromByte: first.nextFromByte!,
      },
    );
    expect(second.nextFromByte).toBeNull();
    expect(second.remainingBudgetBytes).toBe(0);
    expect([...first.spans, ...second.spans].map((span) => span.spanId)).toEqual(built.spanIds);
    expect(
      sourceRequiredReadCoverage({
        binding: built.capability.binding,
        observations: built.capability.observations,
        spanAccesses: built.capability.spanAccesses(),
      }),
    ).toEqual([
      {
        observationId: built.observationId,
        repositoryPath: "docs/requirements.txt",
        status: "considered",
        readBytes: bytes,
        totalBytes: bytes,
      },
    ]);
    // One access per window, each against the step that read it.
    expect(built.capability.spanAccesses().map((access) => access.stepId)).toEqual([
      "plan-documentation",
      "write-documentation",
    ]);
  });

  it("returns at least one whole span, stops at maxBytes, and refuses only what it cannot read", async () => {
    const built = await buildCapability();
    const sizes = built.spanTexts.map((text) => Buffer.byteLength(text, "utf8"));
    const selection = {
      observationId: built.observationId,
      representationId: built.representationId,
    };
    const reader = readerFor(built, "write-documentation", POLICY.perStepBudgetBytes);

    // A maxBytes under the first span still returns that span, so paging advances.
    const one = readSourceWindow(reader, { ...selection, fromByte: 0, maxBytes: 1 });
    expect(one.spans.map((span) => span.spanId)).toEqual([built.spanIds[0]]);
    expect(one.readBytes).toBe(sizes[0]);
    // Exactly two spans' bytes returns exactly those two spans.
    const two = readSourceWindow(reader, {
      ...selection,
      fromByte: one.nextFromByte!,
      maxBytes: sizes[1]! + sizes[2]!,
    });
    expect(two.spans.map((span) => span.spanId)).toEqual(built.spanIds.slice(1, 3));
    expect(two.readBytes).toBe(sizes[1]! + sizes[2]!);

    // No span starts at or after the offset.
    const past = Number.MAX_SAFE_INTEGER;
    expect(() => readSourceWindow(reader, { ...selection, fromByte: past })).toThrowError(
      serviceRefusal("span-unavailable"),
    );
    for (const malformed of [{ fromByte: -1 }, { fromByte: 0.5 }, { fromByte: 0, maxBytes: 0 }]) {
      expect(() => readSourceWindow(reader, { ...selection, ...malformed })).toThrowError(
        new SourceEvidenceServiceError(
          "span-unavailable",
          "A window read takes an observationId, a representationId, fromByte as a whole number of 0 or more, and maxBytes, when given, as a whole number of 1 or more.",
        ),
      );
    }
    // A budget that cannot hold the first span refuses, and records nothing.
    const accessesBefore = built.capability.spanAccesses().length;
    const starved = readerFor(built, "verify-technical-accuracy", sizes[0]! - 1);
    expect(() => readSourceWindow(starved, { ...selection, fromByte: 0 })).toThrowError(
      serviceRefusal("budget-exhausted"),
    );
    expect(built.capability.spanAccesses()).toHaveLength(accessesBefore);
    // A superseded reader cannot read a window either.
    expect(() => readSourceWindow(reader, { ...selection, fromByte: 0 })).toThrowError(
      new SourceEvidenceServiceError("stale-capability"),
    );
  });

  it("restores a window's bytes on the next attempt, like any read", async () => {
    const built = await buildCapability();
    const bytes = wholeBytes(built);
    const selection = {
      observationId: built.observationId,
      representationId: built.representationId,
      fromByte: 0,
    };
    const reader = readerFor(built, "write-documentation", bytes);
    expect(readSourceWindow(reader, selection).nextFromByte).toBeNull();
    expect(() => readSourceWindow(reader, selection)).toThrowError(
      serviceRefusal("budget-exhausted"),
    );
    beginSourceReadAttempt(reader);
    expect(readSourceWindow(reader, selection).readBytes).toBe(bytes);
  });

  it("serves a window through docsfab_read_source with each span's id beside its text", async () => {
    const built = await buildCapability();
    const sizes = built.spanTexts.map((text) => Buffer.byteLength(text, "utf8"));
    const reader = readerFor(built, "write-documentation", POLICY.perStepBudgetBytes);
    const set = await toolSet(reader);
    const tool = readSourceTool(set.definitions)! as unknown as {
      execute: (...args: unknown[]) => Promise<{
        content: Array<{ text: string }>;
        details: { spanAccessSha256: string };
      }>;
    };
    const maxBytes = sizes[0]! + sizes[1]!;
    const result = await tool.execute("call-window", {
      observationId: built.observationId,
      representationId: built.representationId,
      fromByte: 0,
      maxBytes,
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      kind: "docsfab-source-window-read",
      source: "s1",
      observationId: built.observationId,
      representationId: built.representationId,
      fromByte: 0,
      nextFromByte: expect.any(Number),
      readBytes: maxBytes,
      totalBytes: wholeBytes(built),
      remainingBudgetBytes: POLICY.perStepBudgetBytes - maxBytes,
      withheldSpanIds: [],
      spans: [
        { spanId: built.spanIds[0], text: built.spanTexts[0] },
        { spanId: built.spanIds[1], text: built.spanTexts[1] },
      ],
    });
    expect(result.details.spanAccessSha256).toBe(
      built.capability.spanAccesses()[0]!.spanAccessSha256,
    );
    expect(built.capability.spanAccesses()[0]!.spanIds).toEqual(built.spanIds.slice(0, 2));

    // Exactly one selection form: span ids and a window after byte 0 together,
    // or span ids larger than maxBytes, refuse before reading.
    for (const both of [
      {
        observationId: built.observationId,
        representationId: built.representationId,
        spanIds: [built.spanIds[0]],
        fromByte: 1,
      },
      {
        observationId: built.observationId,
        representationId: built.representationId,
        spanIds: [built.spanIds[0]],
        maxBytes: 1,
      },
    ]) {
      await expect(tool.execute("call-both", both)).rejects.toThrowError(
        "DocsFab refused this source read because the host reported span-unavailable.",
      );
    }
    expect(built.capability.spanAccesses()).toHaveLength(1);
  });

  it("summarizes each source in the inventory so a window can reach it past the span rows", async () => {
    const built = await buildCapability();
    const reader = readerFor(built, "plan-documentation", POLICY.perStepBudgetBytes);
    const set = await toolSet(reader);
    const list = listSourcesTool(set.definitions)! as unknown as {
      execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
    };
    const payload = JSON.parse((await list.execute("call-list", {})).content[0]!.text) as {
      sourceCount: number;
      sources: unknown[];
    };
    expect(payload.sourceCount).toBe(1);
    expect(payload.sources).toEqual([
      {
        handle: "s1",
        observationId: built.observationId,
        representationId: built.representationId,
        repositoryPath: "docs/release-notes.html",
        mediaType: "text/html",
        spanCount: built.spanIds.length,
        bytes: wholeBytes(built),
      },
    ]);
    // Identity and size only: no span text reaches the summary.
    const raw = JSON.stringify(payload.sources);
    for (const text of built.spanTexts) expect(raw).not.toContain(text);
  });
});

describe("sources with a line longer than one read", () => {
  /**
   * One 40,001-byte line, a one-byte "a" then two-byte characters, so every
   * even offset inside it falls in the middle of a code point, then a short line.
   */
  const LONG_LINE = `a${"é".repeat(20_000)}`;
  const LONG_LINE_SOURCE = new TextEncoder().encode(`${LONG_LINE}\nClosing line.\n`);
  const LONG_LINE_BYTES = Buffer.byteLength(LONG_LINE, "utf8");
  /** Under the line, over one span. */
  const STEP_BUDGET = 24_576;

  function readerFor(
    built: Awaited<ReturnType<typeof buildCapability>>,
    stepId: string,
    remainingBudgetBytes: number,
    budgetBasis?: { kind: "input-window-share"; share: number; inputWindowTokens: number },
  ) {
    return built.capability.forStep({
      stepId,
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes,
      ...(budgetBasis ? { budgetBasis } : {}),
    })!;
  }

  async function longLine() {
    const built = await buildCapability(LONG_LINE_SOURCE, "obs-long-line", TEXT_SOURCE);
    return {
      built,
      selection: { observationId: built.observationId, representationId: built.representationId },
    };
  }

  it("splits the line into code-point-safe spans no longer than the span ceiling", async () => {
    const { built } = await longLine();
    const ceiling = sourceExtractionMaxSpanBytes();
    const sizes = built.spanTexts.map((text) => Buffer.byteLength(text, "utf8"));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(ceiling);
    expect(built.spanTexts.at(-1)).toBe("Closing line.");
    const lineSpans = built.spanTexts.slice(0, -1);
    expect(lineSpans.length).toBe(Math.ceil(LONG_LINE_BYTES / ceiling));
    // Every piece decodes whole, and the pieces rejoin to the line exactly.
    for (const text of lineSpans) expect(text).not.toContain("�");
    expect(lineSpans.join("")).toBe(LONG_LINE);
  });

  it("reads the line by window across two steps instead of refusing it", async () => {
    const { built, selection } = await longLine();
    const first = readSourceWindow(readerFor(built, "plan-documentation", STEP_BUDGET), {
      ...selection,
      fromByte: 0,
    });
    expect(first.readBytes).toBeGreaterThan(0);
    expect(first.readBytes).toBeLessThanOrEqual(STEP_BUDGET);
    expect(first.nextFromByte).not.toBeNull();

    const second = readSourceWindow(readerFor(built, "write-documentation", STEP_BUDGET), {
      ...selection,
      fromByte: first.nextFromByte!,
    });
    expect(second.nextFromByte).toBeNull();
    const read = [...first.spans, ...second.spans];
    expect(read.map((span) => span.spanId)).toEqual(built.spanIds);
    expect(
      read
        .slice(0, -1)
        .map((span) => span.text)
        .join(""),
    ).toBe(LONG_LINE);
  });

  it("starts a window at the span that holds an offset inside it", async () => {
    const { built, selection } = await longLine();
    const reader = readerFor(built, "plan-documentation", STEP_BUDGET);
    const window = readSourceWindow(reader, { ...selection, fromByte: 101, maxBytes: 1 });
    expect(window.spans.map((span) => span.spanId)).toEqual([built.spanIds[0]]);

    // Past the last span the refusal names where the representation ends.
    const end = LONG_LINE_BYTES + 1 + Buffer.byteLength("Closing line.");
    let refusal: unknown;
    try {
      readSourceWindow(reader, { ...selection, fromByte: end });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toEqual(serviceRefusal("span-unavailable"));
    expect((refusal as SourceEvidenceServiceError).detail).toBe(
      `fromByte ${end} is at or past byte ${end}, where the last span of this representation ends. Read from 0, or from the nextFromByte an earlier window returned.`,
    );
  });

  it("names the limit, the bytes, and the remediation when one span passes the whole step budget", async () => {
    const { built, selection } = await longLine();
    const first = Buffer.byteLength(built.spanTexts[0]!, "utf8");
    const budget = 8_192;
    const set = await toolSet(readerFor(built, "plan-documentation", budget));
    const tool = readSourceTool(set.definitions)! as unknown as {
      execute: (...args: unknown[]) => Promise<unknown>;
    };
    await expect(tool.execute("call-window", { ...selection, fromByte: 0 })).rejects.toThrowError(
      `DocsFab refused this source read because the host reported budget-exhausted. Step plan-documentation cannot read ${first} bytes in one read. sources-read-response-ceiling-bytes-bound: ${first} exceeds sources.readResponseCeilingBytes = ${budget} bytes. `,
    );

    // A budget set by the model's input window names that share instead.
    const windowed = readerFor(built, "plan-documentation", budget, {
      kind: "input-window-share",
      share: 0.15,
      inputWindowTokens: 13_653,
    });
    expect(() => readSourceWindow(windowed, { ...selection, fromByte: 0 })).toThrow(
      expect.objectContaining({
        code: "budget-exhausted",
        detail: expect.stringContaining(
          `sources-read-input-window-share-bound: ${first} exceeds the step's source-read budget of ${budget} bytes, sources.readInputWindowShare = 0.15 of the model's 13653-token input window.`,
        ),
      }),
    );
    expect(built.capability.spanAccesses()).toEqual([]);
  });

  it("says what is left when the step already spent the budget a span would need", async () => {
    const { built, selection } = await longLine();
    const reader = readerFor(built, "plan-documentation", STEP_BUDGET);
    const first = readSourceWindow(reader, { ...selection, fromByte: 0, maxBytes: 1 });
    const left = STEP_BUDGET - first.readBytes;
    const next = Buffer.byteLength(built.spanTexts[1]!, "utf8");
    expect(next).toBeGreaterThan(left);
    expect(() => readSourceWindow(reader, { ...selection, fromByte: first.nextFromByte! })).toThrow(
      expect.objectContaining({
        code: "budget-exhausted",
        detail: `Step plan-documentation has ${left} of its ${STEP_BUDGET}-byte source-read budget left and this read needs ${next} bytes. Read fewer spans, or continue from the same offset in a later step or attempt, which starts with its own budget.`,
      }),
    );
  });

  it("withholds every piece of a line when a configured credential crosses a cut", async () => {
    const ceiling = sourceExtractionMaxSpanBytes();
    // Short enough that neither half is a fragment the screen matches on its own.
    const secret = configureCredential(plantedCredentialValue(83, 18));
    const line = `${"x".repeat(ceiling - secret.length / 2)}${secret}${"y".repeat(4_000)}`;
    const built = await buildCapability(
      new TextEncoder().encode(`${line}\nClosing line.\n`),
      "obs-straddle",
      TEXT_SOURCE,
    );
    const selection = {
      observationId: built.observationId,
      representationId: built.representationId,
    };
    expect(built.spanTexts).toHaveLength(3);
    expect(built.spanTexts.some((text) => text.includes(secret))).toBe(false);
    const [first, second, closing] = built.spanIds as [string, string, string];

    // Window: both pieces are skipped and named, and only the closing line is read.
    const window = readSourceWindow(readerFor(built, "plan-documentation", STEP_BUDGET), {
      ...selection,
      fromByte: 0,
    });
    expect(window.withheldSpanIds).toEqual([first, second]);
    expect(window.spans.map((span) => span.spanId)).toEqual([closing]);
    expect(JSON.stringify(window)).not.toContain(secret.slice(0, secret.length / 2));

    // Read by id: each piece alone refuses, and nothing is charged or recorded.
    for (const spanId of [first, second]) {
      const reader = readerFor(built, "write-documentation", STEP_BUDGET);
      expect(() => reader.read({ ...selection, spanIds: [spanId] })).toThrow(
        serviceRefusal("credential-withheld"),
      );
    }
    expect(built.capability.spanAccesses().map((access) => access.spanIds)).toEqual([[closing]]);
  });

  it("rejoins contiguous pieces read by id with the derivative's own bytes", async () => {
    const { built, selection } = await longLine();
    const reader = readerFor(built, "write-documentation", 65_536);
    const read = reader.read({ ...selection, spanIds: [...built.spanIds].reverse() });
    // The line's pieces join with nothing between them; the next line after a newline.
    expect(read.text).toBe(`${LONG_LINE}\nClosing line.`);
  });

  it("marks the unread bytes between two non-adjacent pieces of one line read by id", async () => {
    const { built, selection } = await longLine();
    const [first, , third] = built.spanIds as [string, string, string];
    const gap = Buffer.byteLength(built.spanTexts[1]!, "utf8");
    const read = readerFor(built, "write-documentation", 65_536).read({
      ...selection,
      spanIds: [third, first],
    });
    expect(read.text).toBe(
      `${built.spanTexts[0]}${SOURCE_READ_GAP_MARKER_PREFIX} ${gap} bytes of this line not read]${built.spanTexts[2]}`,
    );
    expect(read.text).not.toContain("\n");
  });

  it("keeps or drops a split segment whole when an extraction budget cuts it", async () => {
    // A credential at the cut: a kept prefix of the line would end inside it.
    const secret = configureCredential(plantedCredentialValue(84, 18));
    const opening = "Opening line.";
    const line = `zzzz${secret}tail`;
    const bytes = new TextEncoder().encode(`${opening}\n${line}\n`);
    const prefixWithFragment = opening.length + 1 + 4 + 12;
    for (const [limits, limitation] of [
      [{ maxSpanBytes: 8, maxDerivativeBytes: prefixWithFragment }, "byte-budget-truncated"],
      [{ maxSpanBytes: 8, maxSpans: 1 + 2 }, "span-budget-truncated"],
    ] as const) {
      const { representation, derivative } = await extractSourceRepresentation({
        adapter: textSourceExtractorAdapter,
        bytes,
        mediaType: "text/plain",
        limits,
      });
      expect(Buffer.from(derivative).toString("utf8")).toBe(opening);
      expect(Buffer.from(derivative).toString("utf8")).not.toContain(secret.slice(0, 4));
      expect(representation.limitations).toEqual([limitation]);
      expect(representation.completeness).toBe("partial");
    }
  });

  it("narrows text and notebook locators to each piece and maps them back to the original bytes", async () => {
    // A BOM and CRLF endings shift where each line starts in the original.
    const lineA = "a".repeat(20_000);
    const lineB = "b".repeat(20_000);
    const original = new TextEncoder().encode(`﻿${lineA}\r\n${lineB}\r\n`);
    const { representation, derivative } = await extractSourceRepresentation({
      adapter: textSourceExtractorAdapter,
      bytes: original,
      mediaType: "text/plain",
    });
    const pieces = Math.ceil(20_000 / sourceExtractionMaxSpanBytes());
    expect(representation.spans).toHaveLength(2 * pieces);
    for (const span of representation.spans) {
      const locator = span.locator as { kind: string; startByte: number; endByte: number };
      expect(locator.kind).toBe("text");
      expect(locator.endByte - locator.startByte).toBe(span.endByte - span.startByte);
      expect(Buffer.from(original.subarray(locator.startByte, locator.endByte))).toEqual(
        Buffer.from(derivative.subarray(span.startByte, span.endByte)),
      );
    }
    expect((representation.spans[0]!.locator as { startByte: number }).startByte).toBe(3);
    expect((representation.spans[pieces]!.locator as { startByte: number }).startByte).toBe(
      3 + 20_000 + 2,
    );

    // A notebook cell narrows the same way, within the cell's own text.
    const cell = "c".repeat(20_000);
    const notebook = await extractSourceRepresentation({
      adapter: notebookSourceExtractorAdapter,
      bytes: new TextEncoder().encode(
        JSON.stringify({ cells: [{ cell_type: "markdown", source: cell }] }),
      ),
      mediaType: "application/x-ipynb+json",
    });
    expect(
      notebook.representation.spans.map((span) => {
        const locator = span.locator as { startByte: number; endByte: number };
        return [locator.startByte, locator.endByte];
      }),
    ).toEqual(
      notebook.representation.spans.map((span) => [
        span.startByte - notebook.representation.spans[0]!.startByte,
        span.endByte - notebook.representation.spans[0]!.startByte,
      ]),
    );
  });

  it("keeps the whole locator on every piece when a range does not measure the segment", async () => {
    const segment = "d".repeat(20_000);
    const adapter = {
      ...textSourceExtractorAdapter,
      id: "test-transcoded-text",
      // The range covers original bytes of another width than the derivative text.
      extract: () => ({
        segments: [{ text: segment, locator: { kind: "text", startByte: 0, endByte: 10_000 } }],
        limitations: [],
      }),
    };
    const { representation } = await extractSourceRepresentation({
      adapter: adapter as typeof textSourceExtractorAdapter,
      bytes: new TextEncoder().encode(segment),
      mediaType: "text/plain",
    });
    expect(representation.spans.length).toBeGreaterThan(1);
    for (const span of representation.spans) {
      expect(span.locator).toEqual({ kind: "text", startByte: 0, endByte: 10_000 });
    }
  });
});

describe("required-source reads past the budget (#1809)", () => {
  /** Required text sources of the given line counts, sealed in one binding. */
  async function twoSources(lineCounts: readonly number[] = [6, 20]) {
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
    const observe = async (observationId: string, path: string, bytes: Uint8Array) => {
      const { representation } = await extractSourceRepresentation({
        adapter: textSourceExtractorAdapter,
        bytes,
        mediaType: "text/plain",
      });
      return createSourceObservation({
        observationId,
        originIdSha256: sha(`origin-${observationId}`),
        inputId: `input-${observationId}`,
        registrationSha256: sha(`registration-${observationId}`),
        runIdSha256: sha(RUN_ID),
        repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
        requestSha256,
        producerId: PRODUCER_ID,
        producerVersion: "1",
        producerScopeSha256: PRODUCER_SCOPE,
        acquisitionReceiptSha256: sha(`receipt-${observationId}`),
        observedAt: "2026-10-05T18:00:00.000Z",
        original: {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          byteLength: bytes.byteLength,
          mediaType: "text/plain",
          locatorSha256: sha(path),
          version: { kind: "repository-revision", revision: REVISION },
          repositoryPath: path,
        },
        representations: [representation],
      });
    };
    const observations = await Promise.all(
      lineCounts.map((lines, index) =>
        observe(`obs-${index}-of-${lines}`, `docs/source-${index}.txt`, requirementsText(lines)),
      ),
    );
    const binding = createSourceBinding({
      runIdSha256: sha(RUN_ID),
      repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
      requestSha256,
      hostPolicySha256: POLICY.policySha256,
      producerScopeSha256: digestSourceProducerScopes(PRODUCER_SCOPES),
      parentBindingSha256: null,
      observations: observations.map((entry) => ({
        observationId: entry.observationId,
        observationSha256: entry.observationSha256,
      })),
      requiredObservationIds: observations.map((entry) => entry.observationId),
    });
    const need = (observationId: string) =>
      observations
        .find((entry) => entry.observationId === observationId)!
        .representations[0]!.spans.reduce(
          (total, span) => total + span.endByte - span.startByte,
          0,
        );
    return { binding, observations, need };
  }

  it("shares the budget smallest need first, so every source is read at least in part", async () => {
    const { binding, observations, need } = await twoSources();
    const ids = observations.map((entry) => entry.observationId);
    const [small, large] = [...ids].sort((left, right) => need(left) - need(right));
    const budgetBytes = 2 * need(small!);
    expect(budgetBytes).toBeLessThan(need(small!) + need(large!));

    const planned = planRequiredSourceReads({
      binding,
      observations,
      spanAccesses: [],
      budgetBytes,
    });
    expect(planned.kind).toBe("read");
    if (planned.kind !== "read") return;
    expect(planned.neededBytes).toBe(need(small!) + need(large!));
    const bySource = new Map(planned.reads.map((read) => [read.observationId, read]));
    // The smaller source fits its share and is read whole.
    expect(bySource.get(small!)).toMatchObject({ bytes: need(small!), totalBytes: need(small!) });
    // The larger source reads a window, a prefix of its spans, in what is left.
    const window = bySource.get(large!)!;
    const spans = observations.find((entry) => entry.observationId === large)!.representations[0]!
      .spans;
    expect(window.spanIds).toEqual(
      spans.slice(0, window.spanIds.length).map((span) => span.spanId),
    );
    expect(window.spanIds.length).toBeGreaterThan(0);
    expect(window.bytes).toBeLessThanOrEqual(budgetBytes - need(small!));
    expect(window.totalBytes).toBe(need(large!));
    expect(planned.reads.reduce((total, read) => total + read.bytes, 0)).toBeLessThanOrEqual(
      budgetBytes,
    );

    // With room for both, both read whole.
    const roomy = planRequiredSourceReads({
      binding,
      observations,
      spanAccesses: [],
      budgetBytes: need(small!) + need(large!),
    });
    expect(
      roomy.kind === "read" ? roomy.reads.map((read) => read.bytes === read.totalBytes) : roomy,
    ).toEqual([true, true]);
  });

  it("reaches every source when several do not fit, rather than reading some whole and starving one", async () => {
    // A budget that holds the small source and one large one whole: filling it
    // in order would leave the last source unread and stop the write step.
    const { binding, observations, need } = await twoSources([4, 20, 20]);
    const [small, first, second] = observations.map((entry) => entry.observationId);
    const budgetBytes = need(small!) + need(first!);

    const planned = planRequiredSourceReads({
      binding,
      observations,
      spanAccesses: [],
      budgetBytes,
    });
    expect(planned.kind).toBe("read");
    if (planned.kind !== "read") return;
    const bySource = new Map(planned.reads.map((read) => [read.observationId, read]));
    expect(bySource.get(small!)).toMatchObject({ bytes: need(small!) });
    // Each large source reads a window of about half of what is left, not all
    // or nothing.
    for (const id of [first!, second!]) {
      const read = bySource.get(id)!;
      expect(read.bytes).toBeGreaterThan(0);
      expect(read.bytes).toBeLessThan(need(id));
    }
    expect(planned.reads.reduce((total, read) => total + read.bytes, 0)).toBeLessThanOrEqual(
      budgetBytes,
    );
  });

  it("names a source the write step read only part of, with bytes, the limit, and the remediation", async () => {
    const built = await buildCapability();
    const bytes = built.spanTexts.reduce(
      (total, text) => total + Buffer.byteLength(text, "utf8"),
      0,
    );
    const budgetBytes = bytes - 1;
    const planned = planRequiredSourceReads({
      binding: built.capability.binding,
      observations: built.capability.observations,
      spanAccesses: built.capability.spanAccesses(),
      budgetBytes,
    });
    if (planned.kind !== "read") throw new Error("expected a windowed read plan");
    const reader = built.capability.forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: budgetBytes,
    })!;
    // The runner's host read: one read per planned span.
    for (const read of planned.reads) {
      readSourceSpansForEveryAttempt(
        reader,
        read.spanIds.map((spanId) => ({
          observationId: read.observationId,
          representationId: read.representationId,
          spanIds: [spanId],
        })),
      );
    }
    const readBytes = bytes - Buffer.byteLength(built.spanTexts.at(-1)!, "utf8");
    const coverage = sourceRequiredReadCoverage({
      binding: built.capability.binding,
      observations: built.capability.observations,
      spanAccesses: built.capability.spanAccesses(),
    });
    expect(coverage.map((entry) => entry.status)).toEqual(["partial"]);
    expect(
      sourcePartialReadWarnings({
        stepId: "write-documentation",
        coverage,
        neededBytes: planned.neededBytes,
        budgetBytes,
      }),
    ).toEqual([
      `source-read-partial: docs/release-notes.html was read ${readBytes} of ${bytes} bytes when step write-documentation started writing; the rest of it was not read.`,
      "source-read-partial: step write-documentation could not read every required source whole. " +
        `sources-read-response-ceiling-bytes-bound: ${bytes} exceeds sources.readResponseCeilingBytes = ${budgetBytes} bytes. ` +
        "Raise DOCSFAB_SOURCES_READ_RESPONSE_CEILING_BYTES to at least the bytes named, up to 67108864, so one step can read every required source whole, or bind fewer or smaller sources, then start a new run. Follow the named remediation.",
    ]);

    // Control: a whole read yields no warning.
    const whole = await buildCapability();
    const wholeReader = whole.capability.forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: bytes,
    })!;
    wholeReader.read({
      observationId: whole.observationId,
      representationId: whole.representationId,
      spanIds: whole.spanIds,
    });
    expect(
      sourcePartialReadWarnings({
        stepId: "write-documentation",
        coverage: sourceRequiredReadCoverage({
          binding: whole.capability.binding,
          observations: whole.capability.observations,
          spanAccesses: whole.capability.spanAccesses(),
        }),
        neededBytes: bytes,
        budgetBytes: bytes,
      }),
    ).toEqual([]);
  });
});

/**
 * Required text sources with chosen line widths, sealed in one binding, so a
 * plan's spans have the byte sizes a test names. Each line is `L<n>` padded.
 */
async function buildSources(
  sources: ReadonlyArray<{
    readonly id: string;
    readonly path: string;
    readonly widths?: readonly number[];
    readonly bytes?: Uint8Array;
    readonly adapter?: typeof textSourceExtractorAdapter;
  }>,
) {
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
  const observations = await Promise.all(
    sources.map(async (source) => {
      const bytes =
        source.bytes ??
        new TextEncoder().encode(
          `${(source.widths ?? []).map((width, index) => `L${index}`.padEnd(width, ".")).join("\n")}\n`,
        );
      const { representation } = await extractSourceRepresentation({
        adapter: source.adapter ?? textSourceExtractorAdapter,
        bytes,
        mediaType: "text/plain",
      });
      return createSourceObservation({
        observationId: source.id,
        originIdSha256: sha(`origin-${source.id}`),
        inputId: `input-${source.id}`,
        registrationSha256: sha(`registration-${source.id}`),
        runIdSha256: sha(RUN_ID),
        repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
        requestSha256,
        producerId: PRODUCER_ID,
        producerVersion: "1",
        producerScopeSha256: PRODUCER_SCOPE,
        acquisitionReceiptSha256: sha(`receipt-${source.id}`),
        observedAt: "2026-10-05T18:00:00.000Z",
        original: {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          byteLength: bytes.byteLength,
          mediaType: "text/plain",
          locatorSha256: sha(source.path),
          version: { kind: "repository-revision", revision: REVISION },
          repositoryPath: source.path,
        },
        representations: [representation],
      });
    }),
  );
  const binding = createSourceBinding({
    runIdSha256: sha(RUN_ID),
    repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
    requestSha256,
    hostPolicySha256: POLICY.policySha256,
    producerScopeSha256: digestSourceProducerScopes(PRODUCER_SCOPES),
    parentBindingSha256: null,
    observations: observations.map((entry) => ({
      observationId: entry.observationId,
      observationSha256: entry.observationSha256,
    })),
    requiredObservationIds: observations.map((entry) => entry.observationId),
  });
  return { binding, observations };
}

/** A key banner built at run time, so no credential-shaped literal sits in this file. */
const KEY_MARKER = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
/**
 * One of DocsFab's own configured credentials for each test below. Only a
 * configured credential is withheld; a credential shape such as KEY_MARKER is
 * read like any other text (#1807).
 */
const CONFIGURED_KEY = plantedCredentialValue(81, 32);

describe("credential screen before a source read counts (#1809)", () => {
  configureCredentialsForEachTest(CONFIGURED_KEY);

  function readerFor(
    built: Awaited<ReturnType<typeof buildCapability>>,
    stepId: string,
    remainingBudgetBytes: number,
  ) {
    return built.capability.forStep({
      stepId,
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes,
    })!;
  }

  /** Forty requirement lines; line 20 carries `secret`, the configured key by default. */
  async function screenedSource(secret = CONFIGURED_KEY) {
    const rows = Array.from({ length: 40 }, (_, index) =>
      index === 20
        ? `Place the TLS key ${secret} in the key file.`
        : `Requirement ${String(index).padStart(4, "0")} keeps the export bounded.`.padEnd(64, "."),
    );
    const built = await buildCapability(
      new TextEncoder().encode(`${rows.join("\n")}\n`),
      "obs-screen",
      TEXT_SOURCE,
    );
    return {
      built,
      flagged: built.spanIds[20]!,
      flaggedBytes: Buffer.byteLength(built.spanTexts[20]!, "utf8"),
      bytes: built.spanTexts.reduce((total, text) => total + Buffer.byteLength(text, "utf8"), 0),
      selection: { observationId: built.observationId, representationId: built.representationId },
    };
  }

  it("skips a withheld span in a window, and never charges, records, or counts it as read", async () => {
    const { built, flagged, flaggedBytes, bytes, selection } = await screenedSource();
    const read = readSourceTool(
      (await toolSet(readerFor(built, "plan-documentation", bytes))).definitions,
    ) as unknown as {
      execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
    };

    const result = await read.execute("window", { ...selection, fromByte: 0, maxBytes: bytes });
    const payload = JSON.parse(result.content[0]!.text) as {
      withheldSpanIds: string[];
      spans: Array<{ spanId: string }>;
      readBytes: number;
      remainingBudgetBytes: number;
      nextFromByte: number | null;
    };
    expect(payload.withheldSpanIds).toEqual([flagged]);
    expect(payload.spans.map((span) => span.spanId)).toEqual(
      built.spanIds.filter((spanId) => spanId !== flagged),
    );
    expect(result.content[0]!.text).not.toContain(CONFIGURED_KEY);
    // Only the readable spans are charged: the withheld bytes stay in the budget.
    expect(payload.readBytes).toBe(bytes - flaggedBytes);
    expect(payload.remainingBudgetBytes).toBe(flaggedBytes);
    expect(payload.nextFromByte).toBeNull();
    expect(built.capability.spanAccesses().flatMap((access) => access.spanIds)).not.toContain(
      flagged,
    );

    // A read of only that span refuses with the boundary message, and still
    // charges and records nothing.
    const accessesBefore = built.capability.spanAccesses().length;
    await expect(read.execute("one", { ...selection, spanIds: [flagged] })).rejects.toThrowError(
      /credential-isolation boundary/u,
    );
    expect(built.capability.spanAccesses()).toHaveLength(accessesBefore);

    // The source is partial, never considered, and the write step plans the
    // withheld span; its own read of it refuses before anything counts.
    const coverageInput = {
      binding: built.capability.binding,
      observations: built.capability.observations,
      spanAccesses: built.capability.spanAccesses(),
    };
    expect(sourceRequiredReadCoverage(coverageInput)[0]).toMatchObject({
      status: "partial",
      readBytes: bytes - flaggedBytes,
      totalBytes: bytes,
    });
    const planned = planRequiredSourceReads({
      ...coverageInput,
      budgetBytes: POLICY.perStepBudgetBytes,
    });
    expect(planned.kind === "read" ? planned.reads.map((entry) => entry.spanIds) : planned).toEqual(
      [[flagged]],
    );
    const writer = readerFor(built, "write-documentation", POLICY.perStepBudgetBytes);
    expect(() => writer.read({ ...selection, spanIds: [flagged] })).toThrowError(
      new SourceEvidenceServiceError("credential-withheld"),
    );
    expect(built.capability.spanAccesses()).toHaveLength(accessesBefore);

    // The operator line names the withheld bytes, with no budget line: the
    // budget did not cut this read short.
    expect(
      sourcePartialReadWarnings({
        stepId: "write-documentation",
        coverage: sourceRequiredReadCoverage(coverageInput),
        neededBytes: flaggedBytes,
        budgetBytes: POLICY.perStepBudgetBytes,
        withheldBytes: new Map([[built.observationId, flaggedBytes]]),
      }),
    ).toEqual([
      `source-read-partial: docs/requirements.txt was read ${bytes - flaggedBytes} of ${bytes} bytes when step write-documentation started writing; the rest of it was not read, including ${flaggedBytes} bytes the credential screen withheld.`,
    ]);
  });

  it("refuses a window with nothing readable left, charging and recording nothing", async () => {
    const { built, flagged, bytes, selection } = await screenedSource();
    const reader = readerFor(built, "plan-documentation", bytes);
    const spans = built.capability.observations[0]!.representations[0]!.spans;
    const flaggedSpan = spans.find((span) => span.spanId === flagged)!;
    // A window that opens on the banner skips it and returns the next line
    // whole, past maxBytes, so paging still advances.
    const fromBanner = readSourceWindow(reader, {
      ...selection,
      fromByte: flaggedSpan.startByte,
      maxBytes: 1,
    });
    const nextLineBytes = Buffer.byteLength(built.spanTexts[21]!, "utf8");
    expect(fromBanner.withheldSpanIds).toEqual([flagged]);
    expect(fromBanner.spans).toEqual([{ spanId: built.spanIds[21], text: built.spanTexts[21] }]);
    expect(fromBanner.readBytes).toBe(nextLineBytes);
    expect(fromBanner.nextFromByte).toBe(spans[22]!.startByte);
    expect(fromBanner.remainingBudgetBytes).toBe(bytes - nextLineBytes);
    expect(built.capability.spanAccesses().map((access) => access.spanIds)).toEqual([
      [built.spanIds[21]],
    ]);

    // A source whose last line is the banner has nothing readable from there.
    const tail = await buildCapability(
      new TextEncoder().encode(`Opening line of the source.\nKey: ${CONFIGURED_KEY}\n`),
      "obs-tail",
      TEXT_SOURCE,
    );
    const tailReader = readerFor(tail, "plan-documentation", 1024);
    const tailSelection = {
      observationId: tail.observationId,
      representationId: tail.representationId,
    };
    const tailSpans = tail.capability.observations[0]!.representations[0]!.spans;
    expect(tailSpans).toHaveLength(2);
    expect(() =>
      readSourceWindow(tailReader, { ...tailSelection, fromByte: tailSpans[1]!.startByte }),
    ).toThrowError(new SourceEvidenceServiceError("credential-withheld"));
    expect(tail.capability.spanAccesses()).toEqual([]);
    // Nothing was charged: a window from the start reads the first line against
    // the whole grant and lists the banner as withheld.
    const first = readSourceWindow(tailReader, { ...tailSelection, fromByte: 0 });
    const firstLineBytes = Buffer.byteLength(tail.spanTexts[0]!, "utf8");
    expect(first.spans).toEqual([{ spanId: tail.spanIds[0], text: "Opening line of the source." }]);
    expect(first.withheldSpanIds).toEqual([tailSpans[1]!.spanId]);
    expect(first.readBytes).toBe(firstLineBytes);
    expect(first.nextFromByte).toBeNull();
    expect(first.remainingBudgetBytes).toBe(1024 - firstLineBytes);
    expect(tail.capability.spanAccesses().map((access) => access.spanIds)).toEqual([
      [tail.spanIds[0]],
    ]);
  });

  it("reads a window whose payload only looks like a secret assignment, since both screens match exactly (#1807)", async () => {
    // Once the window's JSON payload joins the middle cell's lines, they read
    // as a secret assignment that the per-span text does not. Both screens
    // match DocsFab's own configured credentials exactly, so they agree: a
    // shape alone refuses neither, and the whole window is read and charged.
    // A configured credential in the same cell is withheld span by span and
    // never charged.
    const notebookWith = (value: string) => ({
      cells: [
        {
          cell_type: "markdown",
          metadata: {},
          source: "# Export guide\nKeep every export bounded.",
        },
        {
          cell_type: "markdown",
          metadata: {},
          source: [["Set", "secret", "=\n"].join(" "), `${value}\n`, "in the file."],
        },
        { cell_type: "markdown", metadata: {}, source: "Run the export once per release." },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    });
    const notebookSource = (id: string, value: string) =>
      buildCapability(new TextEncoder().encode(JSON.stringify(notebookWith(value))), id, {
        adapter: notebookSourceExtractorAdapter,
        mediaType: "application/x-ipynb+json",
        repositoryPath: "docs/export.ipynb",
      });
    const budget = 8192;
    const windowOf = async (built: Awaited<ReturnType<typeof buildCapability>>) => {
      const read = readSourceTool(
        (await toolSet(readerFor(built, "plan-documentation", budget))).definitions,
      ) as unknown as {
        execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
      };
      const result = await read.execute("window", {
        observationId: built.observationId,
        representationId: built.representationId,
        fromByte: 0,
      });
      return JSON.parse(result.content[0]!.text) as {
        spans: Array<{ spanId: string }>;
        withheldSpanIds: string[];
        readBytes: number;
        remainingBudgetBytes: number;
      };
    };

    const shaped = await notebookSource("obs-notebook", "abcdefghij");
    expect(shaped.spanIds).toHaveLength(3);
    const whole = await windowOf(shaped);
    expect(whole.withheldSpanIds).toEqual([]);
    expect(whole.spans.map((span) => span.spanId)).toEqual(shaped.spanIds);
    expect(whole.remainingBudgetBytes).toBe(budget - whole.readBytes);
    // One access records every span of the window, in its own order.
    expect(shaped.capability.spanAccesses().map((access) => [...access.spanIds].sort())).toEqual([
      [...shaped.spanIds].sort(),
    ]);

    const configured = await notebookSource("obs-notebook-configured", CONFIGURED_KEY);
    const skipped = await windowOf(configured);
    expect(skipped.withheldSpanIds).toEqual([configured.spanIds[1]]);
    expect(skipped.spans.map((span) => span.spanId)).toEqual([
      configured.spanIds[0],
      configured.spanIds[2],
    ]);
    expect(configured.capability.spanAccesses().flatMap((access) => access.spanIds)).not.toContain(
      configured.spanIds[1],
    );

    // The payload screen still runs before the window counts. A configured
    // value that only the window's payload carries, here a run of a span id
    // that no span's text holds, refuses the whole window, and nothing is
    // charged or recorded.
    const payloadOnly = await notebookSource("obs-notebook-payload", "abcdefghij");
    configureCredential(payloadOnly.spanIds[2]!.slice("span-".length, "span-".length + 24));
    for (const call of ["window-1", "window-2"]) {
      await expect(windowOf(payloadOnly), call).rejects.toThrowError(
        /credential-isolation boundary/u,
      );
    }
    expect(payloadOnly.capability.spanAccesses()).toHaveLength(0);
  });

  it("screens a span read's exact payload before the read counts, so a refused read is never charged or recorded", async () => {
    // The payload screen runs before a read by span id counts, as it does for a
    // window. A configured value that only the read's payload carries, here a
    // run of the span id it names, refuses the read, and nothing is charged or
    // recorded.
    const built = await buildCapability(requirementsText(4), "obs-span-payload", TEXT_SOURCE);
    const selection = {
      observationId: built.observationId,
      representationId: built.representationId,
    };
    const read = readSourceTool(
      (await toolSet(readerFor(built, "plan-documentation", 8192))).definitions,
    ) as unknown as {
      execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
    };
    configureCredential(built.spanIds[1]!.slice("span-".length, "span-".length + 24));
    for (const call of ["span-1a", "span-1b"]) {
      await expect(
        read.execute(call, { ...selection, spanIds: [built.spanIds[1]] }),
        call,
      ).rejects.toThrowError(/credential-isolation boundary/u);
    }
    expect(built.capability.spanAccesses()).toHaveLength(0);

    // Positive control: another span's read carries no configured value; it
    // reads by its id and records exactly one access.
    const result = await read.execute("span-0", { ...selection, spanIds: [built.spanIds[0]] });
    expect((JSON.parse(result.content[0]!.text) as { text: string }).text).toBe(built.spanTexts[0]);
    expect(built.capability.spanAccesses().map((access) => access.spanIds)).toEqual([
      [built.spanIds[0]],
    ]);
  });

  it("reads a span with only a credential shape, and charges and records the read (#1807)", async () => {
    const { built, flagged, bytes, selection } = await screenedSource(KEY_MARKER);
    const reader = readerFor(built, "plan-documentation", bytes);

    const window = readSourceWindow(reader, { ...selection, fromByte: 0, maxBytes: bytes });
    expect(window.withheldSpanIds).toEqual([]);
    expect(window.spans.map((span) => span.spanId)).toEqual(built.spanIds);
    expect(window.readBytes).toBe(bytes);
    expect(built.capability.spanAccesses().flatMap((access) => access.spanIds)).toContain(flagged);
    expect(
      readerFor(built, "write-documentation", POLICY.perStepBudgetBytes).read({
        ...selection,
        spanIds: [flagged],
      }),
    ).toBeDefined();
  });
});

describe("window and plan rules no earlier test pinned (#1809)", () => {
  it("returns what the remaining budget holds when maxBytes asks for more", async () => {
    const built = await buildCapability(requirementsText(40, 48), "obs-k9", TEXT_SOURCE);
    const reader = built.capability.forStep({
      stepId: "write-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: 1000,
    })!;
    const result = readSourceWindow(reader, {
      observationId: built.observationId,
      representationId: built.representationId,
      fromByte: 0,
      maxBytes: 5000,
    });
    expect(result.readBytes).toBeLessThanOrEqual(1000);
    expect(result.readBytes).toBeGreaterThan(1000 - 48);
    expect(result.nextFromByte).not.toBeNull();
    expect(result.remainingBudgetBytes).toBe(1000 - result.readBytes);
  });

  it("defaults a tool window to the per-call tool output cap, not the whole budget", async () => {
    const built = await buildCapability(requirementsText(1000, 64), "obs-cap", TEXT_SOURCE);
    const reader = built.capability.forStep({
      stepId: "plan-documentation",
      workflow: "create-documentation",
      readSource: true,
      remainingBudgetBytes: 262_144,
    })!;
    const read = readSourceTool((await toolSet(reader)).definitions) as unknown as {
      execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
    };
    const payload = JSON.parse(
      (
        await read.execute("default", {
          observationId: built.observationId,
          representationId: built.representationId,
          fromByte: 0,
        })
      ).content[0]!.text,
    ) as { readBytes: number; nextFromByte: number | null; totalBytes: number };
    expect(payload.totalBytes).toBeGreaterThan(resolveToolOutputCapBytes());
    expect(payload.readBytes).toBeLessThanOrEqual(resolveToolOutputCapBytes());
    expect(payload.readBytes).toBeGreaterThan(resolveToolOutputCapBytes() - 64);
    expect(payload.nextFromByte).not.toBeNull();
  });

  it("reads a first span larger than its share when what is left holds it", async () => {
    const { binding, observations } = await buildSources([
      { id: "obs-a", path: "docs/a.txt", widths: [600] },
      { id: "obs-b", path: "docs/b.txt", widths: Array.from({ length: 10 }, () => 100) },
      { id: "obs-c", path: "docs/c.txt", widths: Array.from({ length: 20 }, () => 100) },
    ]);
    const planned = planRequiredSourceReads({
      binding,
      observations,
      spanAccesses: [],
      budgetBytes: 1000,
    });
    expect(
      planned.kind === "read"
        ? planned.reads.map((read) => [read.observationId, read.bytes])
        : planned,
    ).toEqual([
      ["obs-a", 600],
      ["obs-b", 200],
      ["obs-c", 200],
    ]);
  });

  it("does not stop for a partly read source the budget has no room to extend", async () => {
    const { binding, observations } = await buildSources([
      { id: "obs-a", path: "docs/a.txt", widths: [100, 100, 100, 100] },
      { id: "obs-b", path: "docs/b.txt", widths: [100, 100, 1000] },
    ]);
    const source = observations.find((entry) => entry.observationId === "obs-b")!;
    const representation = source.representations[0]!;
    const planned = planRequiredSourceReads({
      binding,
      observations,
      spanAccesses: [
        createSourceSpanAccess({
          bindingSha256: binding.bindingSha256,
          observationId: source.observationId,
          representationId: representation.representationId,
          representationSha256: representation.representationSha256,
          stepId: "plan-documentation",
          accessObservationSha256: sha("access-obs-b"),
          spanIds: representation.spans.slice(0, 2).map((span) => span.spanId),
          observedAt: "2026-10-05T18:05:00.000Z",
        }),
      ],
      budgetBytes: 300,
    });
    expect(
      planned.kind === "read"
        ? planned.reads.map((read) => [read.observationId, read.bytes])
        : planned,
    ).toEqual([["obs-a", 100]]);
  });

  it("keeps every partial-read line within the run-record readers' 1,024 characters", () => {
    // delivery/run-record.ts and scorecard-record-run.ts refuse a longer evidence warning.
    for (const length of [512, 513, 917, 1024]) {
      const path = `docs/${"d".repeat(length - "docs/".length - ".txt".length)}.txt`;
      expect(path).toHaveLength(length);
      const lines = sourcePartialReadWarnings({
        stepId: "revise-documentation",
        coverage: [
          {
            observationId: `obs-${"a".repeat(64)}`,
            repositoryPath: path,
            status: "partial",
            readBytes: 67_108_863,
            totalBytes: 67_108_864,
          },
        ],
        neededBytes: 67_108_864,
        budgetBytes: 67_108_863,
        withheldBytes: new Map([[`obs-${"a".repeat(64)}`, 67_108_863]]),
      });
      expect(lines).toHaveLength(2);
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(1024);
      // A path past the authority bound is shown by its tail, with the
      // observation id that identifies it whole.
      if (length > 512) {
        expect(lines[0]).toContain(`…${path.slice(-512)} (observation obs-${"a".repeat(64)})`);
      } else {
        expect(lines[0]).toContain(`source-read-partial: ${path} was read`);
      }
    }
  });
});

describe("merged-MR diffs in whole-line spans (#1809)", () => {
  /** A unified diff of about 290 KB: one file, many short lines, blank lines kept. */
  function largeDiff(): Uint8Array {
    const lines = ["# GitLab merge request !42", "", "--- a/docs/guide.md", "+++ b/docs/guide.md"];
    for (let index = 0; index < 6000; index += 1) {
      lines.push(index % 50 === 0 ? "" : `+ Line ${index} of the changed guide text.`);
    }
    return new TextEncoder().encode(`${lines.join("\n")}\n`);
  }

  it("splits a diff into whole-line spans that rejoin to every byte", async () => {
    const bytes = largeDiff();
    const { representation, derivative } = await extractSourceRepresentation({
      adapter: gitlabMergedMrDiffExtractorAdapter,
      bytes,
      mediaType: "text/plain",
    });
    expect(Buffer.from(derivative).equals(Buffer.from(bytes))).toBe(true);
    expect(representation.completeness).toBe("complete");
    expect(representation.spans.length).toBeGreaterThan(100);
    const text = Buffer.from(derivative).toString("utf8");
    for (const span of representation.spans.slice(1)) {
      // Every span starts right after the newline it was cut at.
      expect(text[span.startByte - 1]).toBe("\n");
    }
  });

  it("reads a window of a diff larger than the budget rather than stopping", async () => {
    const { binding, observations } = await buildSources([
      {
        id: "obs-mr-42",
        path: "gitlab-mr/42.diff",
        bytes: largeDiff(),
        adapter: gitlabMergedMrDiffExtractorAdapter,
      },
    ]);
    const planned = planRequiredSourceReads({
      binding,
      observations,
      spanAccesses: [],
      budgetBytes: 32_768,
    });
    expect(planned.kind).toBe("read");
    if (planned.kind !== "read") return;
    expect(planned.reads).toHaveLength(1);
    expect(planned.reads[0]!.bytes).toBeGreaterThan(30_000);
    expect(planned.reads[0]!.bytes).toBeLessThanOrEqual(32_768);
    expect(planned.reads[0]!.totalBytes).toBeGreaterThan(200_000);
  });

  function extractDiff(bytes: Uint8Array) {
    return extractSourceRepresentation({
      adapter: gitlabMergedMrDiffExtractorAdapter,
      bytes,
      mediaType: "text/plain",
    });
  }

  it("keeps a diff just under the derivative ceiling within the span ceiling", async () => {
    // 4,000 lines of 256 bytes, 1,027,999 bytes in all, cut into 2,000 spans of
    // two lines each: under the 2,048-span ceiling, so the extract is complete.
    const bytes = new TextEncoder().encode(
      Array.from({ length: 4000 }, () => "b".repeat(256)).join("\n"),
    );
    const { representation, derivative } = await extractDiff(bytes);
    expect(representation.completeness).toBe("complete");
    expect(representation.limitations).toEqual([]);
    expect(representation.spans).toHaveLength(2000);
    expect(representation.spans.every((span) => span.endByte - span.startByte === 513)).toBe(true);
    expect(Buffer.from(derivative).equals(Buffer.from(bytes))).toBe(true);
  });

  it("keeps every span's locator at the span's own offsets, final newlines included", async () => {
    // Seeded, so a failing case reruns exactly.
    let state = 0x1809;
    const next = (bound: number) => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      return state % bound;
    };
    const pieces = ["+", "-", " ", "x", "\t", "é", "日本"];
    const cases: Array<{ name: string; text: string }> = [
      // A line that fills a span right before the text's final newline.
      { name: "one long line and a final newline", text: `${"a".repeat(600)}\n` },
      {
        name: "two long lines and a final newline",
        text: `${"a".repeat(600)}\n${"b".repeat(600)}\n`,
      },
      { name: "one long line and two final newlines", text: `${"a".repeat(600)}\n\n` },
      { name: "no final newline", text: `${"a".repeat(600)}\nb` },
    ];
    for (let index = 0; index < 300; index += 1) {
      const lines = Array.from({ length: 1 + next(12) }, (_, line) =>
        Array.from(
          { length: line === 0 || next(4) > 0 ? 1 + next(700) : 0 },
          () => pieces[next(pieces.length)],
        ).join(""),
      );
      cases.push({
        name: `seeded case ${index}`,
        text: `${lines.join("\n")}${"\n".repeat(next(3))}`,
      });
    }
    for (const { name, text } of cases) {
      const bytes = new TextEncoder().encode(text);
      const { representation, derivative } = await extractDiff(bytes);
      expect(Buffer.from(derivative).equals(Buffer.from(bytes)), name).toBe(true);
      for (const span of representation.spans) {
        expect(span.locator, name).toEqual({
          kind: "text",
          startByte: span.startByte,
          endByte: span.endByte,
        });
      }
    }
  });

  it("keeps the opening whole lines of a diff past the derivative ceiling and declares the cut", async () => {
    // 4,400 lines of 511 bytes: past the 1 MiB derivative ceiling and under the
    // 4 MiB original ceiling, so the diff binds in part instead of refusing.
    const bytes = new TextEncoder().encode(
      `${Array.from({ length: 4400 }, () => `+ ${"c".repeat(509)}`).join("\n")}\n`,
    );
    const { representation, derivative } = await extractDiff(bytes);
    expect(representation.completeness).toBe("partial");
    expect(representation.limitations).toEqual(["byte-budget-truncated"]);
    expect(representation.overflows).toEqual([
      {
        limitation: "byte-budget-truncated",
        limitName: "sources.extractionMaxDerivativeBytes",
        observed: bytes.byteLength,
      },
    ]);
    // Two-line spans of 1,023 bytes, as many as fit in 1,048,576 bytes.
    expect(representation.spans).toHaveLength(1024);
    expect(derivative.byteLength).toBe(1024 * 1024 - 1);
    expect(
      Buffer.from(bytes.subarray(0, derivative.byteLength)).equals(Buffer.from(derivative)),
    ).toBe(true);
    expect(bytes[derivative.byteLength]).toBe(0x0a);
  });
});
