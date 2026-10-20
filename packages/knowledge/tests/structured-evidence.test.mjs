// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { canonicalDigest, resolveSourceEvidence } from "../src/evidence-source.mjs";
import {
  projectStructuredEvidenceSource,
  StructuredEvidenceError,
  verifyStructuredQuotation,
} from "../src/structured-evidence.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const REVISION = "a".repeat(40);
const REPOSITORY_IDENTITY = "b".repeat(64);

function seal(kind, digestKey, body) {
  const envelope = { schemaVersion: 1, kind, ...body };
  return { ...envelope, [digestKey]: canonicalDigest(envelope) };
}

function fixture() {
  const original = Buffer.from(
    JSON.stringify({ paths: { "/pets": { get: { summary: "List pets" } } } }),
    "utf8",
  );
  const derivative = '"List pets"';
  const representationBody = {
    representationId: "rep-openapi",
    mediaType: "text/plain; charset=utf-8",
    sha256: sha(derivative),
    byteLength: Buffer.byteLength(derivative),
    extractor: { id: "docsfab-json-pointer", version: "1", optionsSha256: sha("options") },
    originalSha256: sha(original),
    spans: [
      {
        spanId: "span-list-pets",
        startByte: 0,
        endByte: Buffer.byteLength(derivative),
        locator: { kind: "json-pointer", pointer: "/paths/~1pets/get/summary" },
      },
    ],
    completeness: "complete",
    limitations: [],
  };
  const representation = {
    ...representationBody,
    representationSha256: canonicalDigest(representationBody),
  };
  const observation = seal("docsfab-source-observation", "observationSha256", {
    observationId: "obs-openapi",
    originIdSha256: sha("origin"),
    inputId: "input-openapi",
    registrationSha256: sha("registration"),
    runIdSha256: sha("run-836"),
    repository: { identitySha256: REPOSITORY_IDENTITY, revision: REVISION },
    requestSha256: sha("request"),
    producerId: "workspace-tracked-files",
    producerVersion: "1",
    producerScopeSha256: sha("scope"),
    acquisitionReceiptSha256: sha("receipt"),
    observedAt: "2026-09-14T18:00:00.000Z",
    original: {
      sha256: sha(original),
      byteLength: original.byteLength,
      mediaType: "application/vnd.oai.openapi+json",
      locatorSha256: sha("api/openapi.json"),
      version: { kind: "repository-revision", revision: REVISION },
      repositoryPath: "api/openapi.json",
    },
    representations: [representation],
  });
  const binding = seal("docsfab-source-binding", "bindingSha256", {
    runIdSha256: observation.runIdSha256,
    repository: observation.repository,
    requestSha256: observation.requestSha256,
    hostPolicySha256: sha("policy"),
    producerScopeSha256: sha("scopes"),
    parentBindingSha256: null,
    observations: [
      { observationId: observation.observationId, observationSha256: observation.observationSha256 },
    ],
    requiredObservationIds: [observation.observationId],
  });
  return { original, derivative, observation, binding };
}

function expectCode(run, code) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof StructuredEvidenceError);
    assert.equal(error.code, code);
    return true;
  });
}

describe("structured evidence projection", () => {
  it("preserves a validated JSON Pointer from the portable E1 handoff", () => {
    const base = fixture();
    const resolved = resolveSourceEvidence({
      binding: base.binding,
      observations: [base.observation],
      derivatives: { "rep-openapi": base.derivative },
    });
    const projected = projectStructuredEvidenceSource(resolved.sources[0]);
    assert.equal(projected.location, "api/openapi.json");
    assert.equal(projected.required, true);
    assert.equal(projected.completeness, "complete");
    assert.deepEqual(projected.spans[0], {
      spanId: "span-list-pets",
      locator: { kind: "json-pointer", pointer: "/paths/~1pets/get/summary" },
      text: '"List pets"',
      evidenceClass: "source-content",
    });
    assert.equal(
      verifyStructuredQuotation({
        originalBytes: base.original,
        originalSha256: sha(base.original),
        locator: projected.spans[0].locator,
        quotedText: projected.spans[0].text,
      }),
      true,
    );
  });

  it("matches original JSON number tokens instead of normalized values", () => {
    for (const [original, pointer, quoted] of [
      ['{"value":1e2}', "/value", "1e2"],
      ['{"value":-0}', "/value", "-0"],
      ['{"value":1.0000000000000001}', "/value", "1.0000000000000001"],
    ]) {
      const bytes = Buffer.from(original);
      assert.equal(
        verifyStructuredQuotation({
          originalBytes: bytes,
          originalSha256: sha(bytes),
          locator: { kind: "json-pointer", pointer },
          quotedText: quoted,
        }),
        true,
      );
    }
  });

  it("rejects an extra locator field instead of treating it as authority", () => {
    expectCode(
      () =>
        projectStructuredEvidenceSource({
          ...resolveSourceEvidence({
            binding: fixture().binding,
            observations: [fixture().observation],
            derivatives: { "rep-openapi": fixture().derivative },
          }).sources[0],
          spans: [
            {
              spanId: "span-list-pets",
              locator: {
                kind: "json-pointer",
                pointer: "/paths/~1pets/get/summary",
                repositoryPath: "other.json",
              },
              text: '"List pets"',
            },
          ],
        }),
      "invalid-locator",
    );
  });

  it("labels notebook output as historical evidence", () => {
    const projected = projectStructuredEvidenceSource({
      observationId: "obs-notebook",
      representationId: "rep-notebook",
      location: "analysis.ipynb",
      required: false,
      completeness: "partial",
      limitations: ["non-text-content-excluded"],
      spans: [
        {
          spanId: "span-output",
          locator: {
            kind: "notebook-cell",
            cellId: "run",
            cellOrdinal: 1,
            part: "output",
            outputOrdinal: 0,
            startByte: 0,
            endByte: 7,
          },
          text: "200 OK\n",
        },
      ],
    });
    assert.equal(projected.spans[0].evidenceClass, "historical-notebook-output");
    assert.deepEqual(projected.historicalOutputSpanIds, ["span-output"]);
  });
});

describe("independent original locator checks", () => {
  it("matches exact text bytes and rejects a wrong original digest", () => {
    const original = Buffer.from("alpha\r\nβeta\n", "utf8");
    assert.equal(
      verifyStructuredQuotation({
        originalBytes: original,
        originalSha256: sha(original),
        locator: { kind: "text", startByte: 7, endByte: 12 },
        quotedText: "βeta",
      }),
      true,
    );
    expectCode(
      () =>
        verifyStructuredQuotation({
          originalBytes: original,
          originalSha256: sha("another source"),
          locator: { kind: "text", startByte: 7, endByte: 12 },
          quotedText: "βeta",
        }),
      "original-mismatch",
    );
    const invalidUtf8 = Buffer.from([0xff, 0x61]);
    expectCode(
      () =>
        verifyStructuredQuotation({
          originalBytes: invalidUtf8,
          originalSha256: sha(invalidUtf8),
          locator: { kind: "text", startByte: 0, endByte: 2 },
          quotedText: "�a",
        }),
      "invalid-original",
    );
  });

  it("preserves an embedded BOM at the start of a selected text range", () => {
    const original = Buffer.from("a\n\uFEFFb", "utf8");
    assert.equal(
      verifyStructuredQuotation({
        originalBytes: original,
        originalSha256: sha(original),
        locator: { kind: "text", startByte: 2, endByte: 6 },
        quotedText: "\uFEFFb",
      }),
      true,
    );
  });

  it("rejects lossy or duplicate JSON originals during independent replay", () => {
    for (const original of [
      Buffer.from('{"value":9007199254740993}'),
      Buffer.from('{"value":1,"value":2}'),
    ]) {
      expectCode(
        () =>
          verifyStructuredQuotation({
            originalBytes: original,
            originalSha256: sha(original),
            locator: { kind: "json-pointer", pointer: "/value" },
            quotedText: "2",
          }),
        "invalid-original",
      );
    }
  });

  it("checks notebook cell id against its original ordinal", () => {
    const notebook = Buffer.from(
      JSON.stringify({
        cells: [
          { cell_type: "markdown", id: "intro", source: ["# Intro\n"] },
          {
            cell_type: "code",
            id: "run",
            source: ["print('ok')"],
            outputs: [{ output_type: "stream", text: ["ok\n"] }],
          },
        ],
        nbformat: 4,
        nbformat_minor: 5,
      }),
      "utf8",
    );
    const locator = {
      kind: "notebook-cell",
      cellId: "run",
      cellOrdinal: 1,
      part: "output",
      outputOrdinal: 0,
      startByte: 0,
      endByte: 3,
    };
    assert.equal(
      verifyStructuredQuotation({
        originalBytes: notebook,
        originalSha256: sha(notebook),
        locator,
        quotedText: "ok\n",
      }),
      true,
    );
    expectCode(
      () =>
        verifyStructuredQuotation({
          originalBytes: notebook,
          originalSha256: sha(notebook),
          locator: { ...locator, cellOrdinal: 0 },
          quotedText: "ok\n",
        }),
      "notebook-cell-ordinal-mismatch",
    );
  });

  it("rejects duplicate notebook ids during replay checks", () => {
    const notebook = Buffer.from(
      JSON.stringify({
        cells: [
          { cell_type: "markdown", id: "same", source: ["one"] },
          { cell_type: "markdown", id: "same", source: ["two"] },
        ],
      }),
      "utf8",
    );
    expectCode(
      () =>
        verifyStructuredQuotation({
          originalBytes: notebook,
          originalSha256: sha(notebook),
          locator: {
            kind: "notebook-cell",
            cellId: "same",
            cellOrdinal: 0,
            part: "source",
            outputOrdinal: null,
            startByte: 0,
            endByte: 3,
          },
          quotedText: "one",
        }),
      "duplicate-notebook-cell-id",
    );
  });

  it("applies the strict JSON subset to notebook originals", () => {
    for (const original of [
      Buffer.from('{"cells":[],"cells":[]}'),
      Buffer.from(
        '{"cells":[{"cell_type":"markdown","id":"intro","source":["ok"]}],"metadata":{"count":9007199254740993}}',
      ),
    ]) {
      expectCode(
        () =>
          verifyStructuredQuotation({
            originalBytes: original,
            originalSha256: sha(original),
            locator: {
              kind: "notebook-cell",
              cellId: "intro",
              cellOrdinal: 0,
              part: "source",
              outputOrdinal: null,
              startByte: 0,
              endByte: 2,
            },
            quotedText: "ok",
          }),
        "invalid-original",
      );
    }
  });

  it("preserves a BOM at the start of a notebook part range", () => {
    const notebook = Buffer.from(
      JSON.stringify({
        cells: [{ cell_type: "markdown", id: "intro", source: ["\uFEFFb"] }],
      }),
      "utf8",
    );
    assert.equal(
      verifyStructuredQuotation({
        originalBytes: notebook,
        originalSha256: sha(notebook),
        locator: {
          kind: "notebook-cell",
          cellId: "intro",
          cellOrdinal: 0,
          part: "source",
          outputOrdinal: null,
          startByte: 0,
          endByte: 4,
        },
        quotedText: "\uFEFFb",
      }),
      true,
    );
  });
});
