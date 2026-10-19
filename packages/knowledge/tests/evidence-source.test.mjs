// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  canonicalDigest,
  decodeSourceBindingRecord,
  decodeSourceObservationRecord,
  EvidenceSourceError,
  resolveSourceEvidence,
  sourceRepresentationLineage,
  verifySourceSpanQuotation,
} from "../src/evidence-source.mjs";
import { gatherRepositoryFirstPass } from "../src/first-pass.mjs";

const temporaries = [];
after(async () => {
  for (const directory of temporaries) await rm(directory, { recursive: true, force: true });
});

const REVISION = "a".repeat(40);
const REPOSITORY_IDENTITY = "b".repeat(64);
const sha = (value) => createHash("sha256").update(value, "utf8").digest("hex");

/**
 * Build the exact wire records the runtime seals, using only the documented
 * canonical digest. If the two packages ever disagree about that digest, these
 * fixtures stop decoding, which is the point of building them here.
 */
function seal(kind, digestKey, body) {
  const envelope = { schemaVersion: 1, kind, ...body };
  return { ...envelope, [digestKey]: canonicalDigest(envelope) };
}

const DERIVATIVE = "Release Notes\nThe reader returns exact retained bytes.";
const DERIVATIVE_BYTES = Buffer.from(DERIVATIVE, "utf8");
const ORIGINAL_SHA = sha("<html><body><h1>Release Notes</h1></body></html>");

function buildRepresentation(overrides = {}) {
  const spans = overrides.spans ?? [
    {
      spanId: "span-first",
      startByte: 0,
      endByte: Buffer.byteLength("Release Notes", "utf8"),
      locator: { kind: "html-node", nodeOrdinal: 2, textStartByte: 0, textEndByte: 13 },
    },
    {
      spanId: "span-second",
      startByte: Buffer.byteLength("Release Notes\n", "utf8"),
      endByte: DERIVATIVE_BYTES.byteLength,
      locator: { kind: "html-node", nodeOrdinal: 3, textStartByte: 0, textEndByte: 42 },
    },
  ];
  const body = {
    representationId: "rep-html-text",
    mediaType: "text/plain; charset=utf-8",
    sha256: overrides.sha256 ?? createHash("sha256").update(DERIVATIVE_BYTES).digest("hex"),
    byteLength: overrides.byteLength ?? DERIVATIVE_BYTES.byteLength,
    extractor: { id: "docsfab-html-text", version: "1", optionsSha256: sha("options") },
    originalSha256: overrides.originalSha256 ?? ORIGINAL_SHA,
    spans,
    completeness: "partial",
    limitations: ["active-content-excluded"],
  };
  return { ...body, representationSha256: canonicalDigest(body) };
}

function buildObservation(overrides = {}) {
  return seal("docsfab-source-observation", "observationSha256", {
    observationId: overrides.observationId ?? "obs-release-notes",
    originIdSha256: sha("origin"),
    inputId: "input-release-notes",
    registrationSha256: sha("registration"),
    runIdSha256: sha("run-835"),
    repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
    requestSha256: overrides.requestSha256 ?? sha("request"),
    producerId: "workspace-tracked-files",
    producerVersion: "1",
    producerScopeSha256: sha("scope"),
    acquisitionReceiptSha256: sha("receipt"),
    observedAt: "2026-09-14T18:00:00.000Z",
    original: {
      sha256: ORIGINAL_SHA,
      byteLength: 48,
      mediaType: "text/html",
      locatorSha256: sha("docs/release-notes.html"),
      version: { kind: "repository-revision", revision: REVISION },
      repositoryPath: "docs/release-notes.html",
    },
    representations: [overrides.representation ?? buildRepresentation()],
  });
}

function buildBinding(observation, overrides = {}) {
  return seal("docsfab-source-binding", "bindingSha256", {
    runIdSha256: sha("run-835"),
    repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
    requestSha256: sha("request"),
    hostPolicySha256: sha("policy"),
    producerScopeSha256: sha("scopes"),
    parentBindingSha256: null,
    observations: [
      {
        observationId: observation.observationId,
        observationSha256: overrides.observationSha256 ?? observation.observationSha256,
      },
    ],
    requiredObservationIds: overrides.requiredObservationIds ?? [observation.observationId],
  });
}

function fixture() {
  const observation = buildObservation();
  return {
    observation,
    observations: [observation],
    binding: buildBinding(observation),
    derivatives: { "rep-html-text": DERIVATIVE },
  };
}

function expectCode(run, code) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof EvidenceSourceError, `expected EvidenceSourceError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

describe("source evidence decoding", () => {
  it("accepts the sealed observation and binding produced by the runtime contract", () => {
    // Positive control. Every rejection below changes exactly one thing in
    // this fixture, so a green rejection cannot be a broken-fixture artifact.
    const { observation, binding } = fixture();
    assert.equal(decodeSourceObservationRecord(observation).observationId, "obs-release-notes");
    assert.equal(decodeSourceBindingRecord(binding).bindingSha256, binding.bindingSha256);
  });

  it("rejects an observation whose digest was recomputed over altered fields", () => {
    const { observation } = fixture();
    expectCode(
      () => decodeSourceObservationRecord({ ...observation, producerId: "someone-else" }),
      "observation-digest-mismatch",
    );
  });

  it("rejects a representation whose own descriptor digest is wrong", () => {
    const representation = buildRepresentation();
    const observation = buildObservation({
      representation: { ...representation, representationSha256: sha("forged") },
    });
    expectCode(
      () => decodeSourceObservationRecord(observation),
      "representation-digest-mismatch",
    );
  });

  it("rejects a representation bound to a different original", () => {
    const observation = buildObservation({
      representation: buildRepresentation({ originalSha256: sha("another-original") }),
    });
    expectCode(() => decodeSourceObservationRecord(observation), "representation-mismatch");
  });

  it("rejects a span range outside the retained derivative", () => {
    const observation = buildObservation({
      representation: buildRepresentation({
        spans: [
          {
            spanId: "span-overrun",
            startByte: 0,
            endByte: DERIVATIVE_BYTES.byteLength + 1,
            locator: { kind: "html-node", nodeOrdinal: 0, textStartByte: 0, textEndByte: 1 },
          },
        ],
      }),
    });
    expectCode(() => decodeSourceObservationRecord(observation), "invalid-span");
  });

  it("rejects an unfamiliar locator discriminant", () => {
    const observation = buildObservation({
      representation: buildRepresentation({
        spans: [
          {
            spanId: "span-unknown",
            startByte: 0,
            endByte: 5,
            locator: { kind: "spreadsheet-cell", row: 1, column: 1 },
          },
        ],
      }),
    });
    expectCode(() => decodeSourceObservationRecord(observation), "unknown-locator");
  });

  it("rejects a future schema version rather than guessing", () => {
    const { observation } = fixture();
    expectCode(
      () => decodeSourceObservationRecord({ ...observation, schemaVersion: 2 }),
      "unsupported-version",
    );
  });

  it("rejects a binding presented as an observation", () => {
    const { binding } = fixture();
    expectCode(() => decodeSourceObservationRecord(binding), "invalid-shape");
  });

  it("rejects a required observation the binding never selected", () => {
    const observation = buildObservation();
    expectCode(
      () =>
        decodeSourceBindingRecord(
          buildBinding(observation, { requiredObservationIds: ["obs-absent"] }),
        ),
      "unknown-required-observation",
    );
  });
});

describe("representation lineage", () => {
  it("roots lineage at the original and hangs each derivative off it", () => {
    const { observation } = fixture();
    const lineage = sourceRepresentationLineage(observation);
    assert.equal(lineage.length, 2);
    assert.equal(lineage[0].representationId, `original-${ORIGINAL_SHA}`);
    assert.equal(lineage[0].parentRepresentationId, null);
    assert.equal(lineage[0].role, "original");
    assert.equal(lineage[1].representationId, "rep-html-text");
    assert.equal(lineage[1].parentRepresentationId, `original-${ORIGINAL_SHA}`);
    assert.equal(lineage[1].role, "derivative");
    assert.notEqual(lineage[1].sha256, lineage[0].sha256);
    assert.deepEqual([...lineage[1].limitations], ["active-content-excluded"]);
  });
});

describe("source evidence resolution", () => {
  it("returns exact span quotations for the sealed derivative", () => {
    const resolved = resolveSourceEvidence(fixture());
    assert.equal(resolved.sources.length, 1);
    const [source] = resolved.sources;
    assert.equal(source.location, "docs/release-notes.html");
    assert.equal(source.required, true);
    assert.equal(source.completeness, "partial");
    assert.equal(source.spans[0].text, "Release Notes");
    assert.equal(source.spans[1].text, "The reader returns exact retained bytes.");
  });

  it("rejects a derivative whose bytes do not match the sealed representation", () => {
    expectCode(
      () =>
        resolveSourceEvidence({
          ...fixture(),
          derivatives: { "rep-html-text": "Release Notes\nSomething else entirely." },
        }),
      "derivative-mismatch",
    );
  });

  it("rejects an observation whose digest diverges from the binding reference", () => {
    const observation = buildObservation();
    expectCode(
      () =>
        resolveSourceEvidence({
          binding: buildBinding(observation, { observationSha256: sha("divergent") }),
          observations: [observation],
          derivatives: { "rep-html-text": DERIVATIVE },
        }),
      "observation-mismatch",
    );
  });

  it("rejects an observation bound to a different request", () => {
    const observation = buildObservation({ requestSha256: sha("another-request") });
    expectCode(
      () =>
        resolveSourceEvidence({
          binding: buildBinding(observation),
          observations: [observation],
          derivatives: { "rep-html-text": DERIVATIVE },
        }),
      "observation-mismatch",
    );
  });

  it("rejects a binding whose required observation was not supplied", () => {
    const observation = buildObservation();
    const other = buildObservation({ observationId: "obs-other" });
    expectCode(
      () =>
        resolveSourceEvidence({
          binding: buildBinding(observation),
          observations: [other],
          derivatives: { "rep-html-text": DERIVATIVE },
        }),
      "observation-unavailable",
    );
  });

  it("reports when no retained derivative was supplied at all", () => {
    expectCode(() => resolveSourceEvidence({ ...fixture(), derivatives: {} }), "no-readable-representation");
  });

  it("verifies an exact quotation and refuses a paraphrase", () => {
    const base = fixture();
    assert.equal(
      verifySourceSpanQuotation({
        ...base,
        representationId: "rep-html-text",
        spanId: "span-first",
        quotedText: "Release Notes",
      }),
      true,
    );
    assert.equal(
      verifySourceSpanQuotation({
        ...base,
        representationId: "rep-html-text",
        spanId: "span-first",
        quotedText: "Release notes",
      }),
      false,
    );
    expectCode(
      () =>
        verifySourceSpanQuotation({
          ...base,
          representationId: "rep-html-text",
          spanId: "span-absent",
          quotedText: "Release Notes",
        }),
      "unknown-span",
    );
  });
});

describe("first-pass source-evidence intake", () => {
  async function gather(sourceEvidence) {
    const repositoryPath = await mkdtemp(join(tmpdir(), "docsfab-evidence-repo-"));
    const dataDirectory = await mkdtemp(join(tmpdir(), "docsfab-evidence-data-"));
    temporaries.push(repositoryPath, dataDirectory);
    return gatherRepositoryFirstPass({
      repositoryPath,
      dataDirectory,
      revision: REVISION,
      ...(sourceEvidence ? { sourceEvidence } : {}),
    });
  }

  it("registers nothing extra for a run without a source binding", async () => {
    const result = await gather(undefined);
    assert.equal(result.sourceEvidenceCount, 0);
  });

  it("registers the bound source and proposes span-quoting claims", async () => {
    const result = await gather(fixture());
    assert.equal(result.sourceEvidenceCount, 1);
    const statements = Object.values(result.snapshot.claims ?? {}).map(
      (claim) => claim.statement ?? "",
    );
    assert.ok(
      statements.some((statement) => statement.includes('Source span span-first states: "Release Notes".')),
      `expected a span-quoting claim, saw: ${JSON.stringify(statements)}`,
    );
  });

  it("refuses to gather from a tampered binding rather than degrading silently", async () => {
    const base = fixture();
    await assert.rejects(
      gather({ ...base, binding: { ...base.binding, requiredObservationIds: ["obs-absent"] } }),
      (error) => error instanceof EvidenceSourceError,
    );
  });
});
