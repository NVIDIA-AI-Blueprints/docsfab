// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  FoundationCanonContractError,
  createFoundationCanon,
  createFoundationCanonAffectedArtifact,
  createFoundationCanonAssumption,
  createFoundationCanonClaim,
  createFoundationCanonConflict,
  createFoundationCanonDependency,
  createFoundationCanonEvidence,
  createFoundationCanonHostAuthority,
  acceptFoundationCanon,
  decodeFoundationCanon,
  migrateFoundationCanon,
  projectFoundationCanon,
} from "../src/canon/index.js";
import { configureCredential } from "./helpers/configured-credential.js";

const sha = (character: string): string => character.repeat(64);

function proposal() {
  const assumption = createFoundationCanonAssumption({ id: "a1", statementSha256: sha("1") });
  const dependency = createFoundationCanonDependency({ id: "d1", dependsOnIds: [] });
  const evidence = createFoundationCanonEvidence({
    id: "e1",
    inputId: "input-1",
    digestSha256: sha("2"),
  });
  const claim = createFoundationCanonClaim({
    id: "c1",
    subjectSha256: sha("3"),
    assertionSha256: sha("3"),
    confidence: "high",
    verificationStatus: "verified",
    applicabilitySha256: sha("3"),
    ownerAuthorityId: null,
    statementSha256: sha("3"),
    evidenceIds: ["e1"],
    assumptionIds: ["a1"],
    dependencyIds: ["d1"],
    affectedArtifactIds: ["file-1"],
    conflictGroupId: null,
    supersededByClaimId: null,
  });
  const artifact = createFoundationCanonAffectedArtifact({
    id: "file-1",
    path: "docs/guide.md",
    digestSha256: sha("4"),
  });
  return createFoundationCanon({
    canonId: "canon-1",
    version: "v1",
    proposedBy: "model",
    state: "proposal",
    authority: null,
    repository: {
      identitySha256: sha("5"),
      revision: "a".repeat(40),
      contentDigestSha256: sha("6"),
    },
    inputBinding: { manifestSha256: sha("7"), inputIds: ["input-1"] },
    claims: [claim],
    evidence: [evidence],
    conflicts: [],
    assumptions: [assumption],
    dependencies: [dependency],
    affectedArtifacts: [artifact],
    supersession: null,
  });
}

function bodyOf(canon: ReturnType<typeof proposal>) {
  const { schemaVersion: _schemaVersion, kind: _kind, canonSha256: _canonSha256, ...body } = canon;
  return body;
}

function expectCode(action: () => unknown, code: string): void {
  expect(action).toThrowError(FoundationCanonContractError);
  try {
    action();
  } catch (error) {
    expect((error as FoundationCanonContractError).code).toBe(code);
  }
}

describe("FoundationCanonV1", () => {
  it("seals a content-minimized proposal and produces a smaller projection", () => {
    const canon = proposal();
    expect(Object.isFrozen(canon)).toBe(true);
    expect(decodeFoundationCanon(JSON.parse(JSON.stringify(canon)))).toEqual(canon);
    const projection = projectFoundationCanon(canon);
    expect(projection).toMatchObject({ state: "proposal", claimCount: 1, hasAuthority: false });
    expect("claims" in projection).toBe(false);
  });

  it("requires authority only for accepted state", () => {
    const source = proposal();
    expectCode(
      () =>
        createFoundationCanon({
          ...bodyOf(source),
          state: "accepted",
          authority: {
            authorityId: "forged",
            authoritySha256: sha("8"),
            acceptedAt: "2026-08-10T12:00:00.000Z",
          },
        }),
      "invalid-value",
    );
    const authority = createFoundationCanonHostAuthority({
      verifyCurrent: () => ({
        authorityId: "reviewer-1",
        authoritySha256: sha("8"),
        acceptedAt: "2026-08-10T12:00:00.000Z",
      }),
    });
    const accepted = acceptFoundationCanon(source, authority);
    expect(accepted.state).toBe("accepted");
  });

  it("rejects unsafe paths, duplicate IDs, dangling refs, bad member digests, and credentials", () => {
    configureCredential(["glpat", "abcdefghijklmnopqrst"].join("-"));
    expectCode(
      () =>
        createFoundationCanonAffectedArtifact({
          id: "a",
          path: "../secret",
          digestSha256: sha("1"),
        }),
      "unsafe-path",
    );
    const source = proposal();
    expectCode(
      () =>
        createFoundationCanon({
          ...bodyOf(source),
          claims: [source.claims[0]!, source.claims[0]!],
        }),
      "duplicate-reference",
    );
    const dangling = createFoundationCanonClaim({ ...source.claims[0]!, evidenceIds: ["missing"] });
    expectCode(
      () => createFoundationCanon({ ...bodyOf(source), claims: [dangling] }),
      "dangling-reference",
    );
    expectCode(
      () =>
        decodeFoundationCanon({
          ...source,
          claims: [{ ...source.claims[0]!, claimSha256: sha("f") }],
        }),
      "digest-mismatch",
    );
    expectCode(
      () => createFoundationCanon({ ...bodyOf(source), canonId: "glpat-abcdefghijklmnopqrst" }),
      "credential-material",
    );
    expectCode(
      () =>
        createFoundationCanon({
          ...bodyOf(source),
          repository: { ...source.repository, revision: "a".repeat(39) },
        }),
      "invalid-value",
    );
    const accessor = Object.create(Object.prototype, {
      canonId: { enumerable: true, get: () => "canon-1" },
    });
    expectCode(() => decodeFoundationCanon(accessor), "invalid-shape");
    expectCode(() => decodeFoundationCanon(new Proxy(source, {})), "invalid-shape");
  });

  it("rejects unknown source versions through the explicit migration policy", () => {
    expectCode(() => migrateFoundationCanon({ schemaVersion: 2 }), "migration-required");
  });
});
