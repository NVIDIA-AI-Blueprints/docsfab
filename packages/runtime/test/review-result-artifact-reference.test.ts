// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  ARTIFACT_KINDS,
  ARTIFACT_REFERENCE_ONLY_KINDS,
  ARTIFACT_REFERENCE_KINDS,
  ArtifactValidationError,
  validateArtifact,
  validateArtifactReference,
  validateArtifactUse,
} from "../src/artifacts/index.js";
import { decodeArtifacts } from "../src/delivery/run-record/step-decoder.js";
import { FileRunStore } from "../src/records/file-store.js";
import type { RunRecord } from "../src/records/contracts.js";
import { temporaryRoots } from "./helpers/temp.js";

const REVISION = "a".repeat(40);
const DIGEST = "b".repeat(64);
const CONTENT_DIGEST = "c".repeat(64);
const roots = temporaryRoots();

function reviewResultReference() {
  return {
    kind: "review-result",
    schemaVersion: 1,
    digest: DIGEST,
    repositoryRevision: REVISION,
    repositoryContentDigest: CONTENT_DIGEST,
  } as const;
}

function runRecord(id: string, artifacts: RunRecord["artifacts"]): RunRecord {
  return {
    schemaVersion: 2,
    id,
    workflow: "review-documentation",
    repository: {
      sourcePath: "/fixtures/review-result-reference",
      requestedRevision: "HEAD",
      revision: REVISION,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-10-16T12:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [],
    artifacts,
  };
}

describe("review-result reference-only artifact kind", () => {
  it("admits the private inspection-intent reference only at version 1", () => {
    const reference = { ...reviewResultReference(), kind: "review-delivery-intent" } as const;
    expect(ARTIFACT_REFERENCE_ONLY_KINDS).toContain("review-delivery-intent");
    expect(ARTIFACT_KINDS).not.toContain("review-delivery-intent" as never);
    expect(
      validateArtifactReference(reference, { expectedKind: "review-delivery-intent" }),
    ).toEqual(reference);
    expectArtifactError(
      () => validateArtifactReference({ ...reference, schemaVersion: 2 }),
      "future-version",
    );
  });

  it("admits the closed version 1 reference and keeps it outside semantic envelopes", () => {
    const reference = reviewResultReference();
    const use = { role: "output", stepId: "review", reference } as const;

    expect(ARTIFACT_REFERENCE_KINDS).toContain("review-result");
    expect(ARTIFACT_REFERENCE_ONLY_KINDS).toContain("review-result");
    expect(ARTIFACT_KINDS).not.toContain("review-result" as never);
    expect(validateArtifactReference(reference, { expectedKind: "review-result" })).toEqual(
      reference,
    );
    expect(validateArtifactUse(use)).toEqual(use);
    expectArtifactError(
      () =>
        validateArtifact({
          schemaVersion: 1,
          kind: "review-result",
          repository: { revision: REVISION, contentDigest: CONTENT_DIGEST },
          digest: DIGEST,
          payload: {},
        }),
      "invalid-enum",
    );
  });

  it("writes and reads a RunRecord artifact through the decoder importer", async () => {
    const root = await roots.create("docsfab-review-result-reference-");
    const reference = reviewResultReference();
    const use = { role: "output", stepId: "review", reference } as const;
    const writer = new FileRunStore(root);

    await writer.save(runRecord("review-result-reference", [use]));
    const saved = await writer.get("review-result-reference");
    expect(saved).toMatchObject({ artifacts: [use] });

    const decodedUses = decodeArtifacts(
      (saved as { artifacts: unknown }).artifacts,
      undefined,
      REVISION,
    );
    expect(decodedUses).toEqual([use]);
    expect(decodedUses[0]?.reference).toMatchObject({
      digest: DIGEST,
      repositoryRevision: REVISION,
      repositoryContentDigest: CONTENT_DIGEST,
    });
  });

  it.each([
    ["unknown kind", { kind: "review-result-extra" }, "invalid-enum"],
    ["unsupported version", { schemaVersion: 0 }, "invalid-type"],
    ["future version", { schemaVersion: 4 }, "future-version"],
    ["extra field", { payload: {} }, "unknown-field"],
    ["malformed digest", { digest: "xyz" }, "invalid-type"],
    ["malformed revision", { repositoryRevision: "main" }, "invalid-type"],
  ] as const)("refuses %s with existing validator semantics", (_name, change, code) => {
    const value = { ...reviewResultReference(), ...change };
    expectArtifactError(() => validateArtifactReference(value), code);
  });

  it("refuses missing fields, an unexpected kind, and repository-index mismatches", () => {
    const missingDigest = { ...reviewResultReference() } as Record<string, unknown>;
    delete missingDigest.digest;
    expectArtifactError(() => validateArtifactReference(missingDigest), "missing-field");
    expectArtifactError(
      () =>
        validateArtifactReference(reviewResultReference(), {
          index: {
            repository: { revision: "d".repeat(40), contentDigest: "e".repeat(64) },
          } as never,
        }),
      "repository-mismatch",
    );
  });

  it("refuses an unexpected kind at the reference boundary", () => {
    expectArtifactError(
      () => validateArtifactReference(reviewResultReference(), { expectedKind: "ontology" }),
      "invalid-enum",
    );
  });

  it.each(ARTIFACT_REFERENCE_ONLY_KINDS.filter((kind) => kind !== "review-result"))(
    "preserves adjacent reference-only kind %s",
    (kind) => {
      const reference = {
        kind,
        schemaVersion: kind === "editorial-decision" ? 3 : 1,
        digest: DIGEST,
        repositoryRevision: REVISION,
        repositoryContentDigest: CONTENT_DIGEST,
      };
      expect(validateArtifactReference(reference, { expectedKind: kind })).toEqual(reference);
      expect(validateArtifactUse({ role: "output", reference })).toMatchObject({ reference });
    },
  );
});

function expectArtifactError(action: () => unknown, code: ArtifactValidationError["code"]): void {
  try {
    action();
    throw new Error("expected artifact validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactValidationError);
    expect((error as ArtifactValidationError).code).toBe(code);
  }
}
