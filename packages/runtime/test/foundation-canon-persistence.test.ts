// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DurableArtifactStore } from "../src/artifacts/index.js";
import {
  FoundationCanonInvalidationError,
  FoundationCanonPersistenceError,
  assertFoundationCanonCurrent,
  assertProjectionRoundTrip,
  buildFoundationCanonQueryIndex,
  createFoundationCanon,
  createFoundationCanonAffectedArtifact,
  createFoundationCanonAssumption,
  createFoundationCanonClaim,
  createFoundationCanonConflict,
  createFoundationCanonDependency,
  createFoundationCanonEvidence,
  evaluateFoundationCanonFreshness,
  hasFoundationCanon,
  loadFoundationCanon,
  persistFoundationCanon,
  projectFoundationCanonSurfaces,
  queryFoundationCanonAffectedDocuments,
  queryFoundationCanonApplicability,
  queryFoundationCanonClaims,
  queryFoundationCanonConflicts,
  queryFoundationCanonGaps,
  renderFoundationCanonMarkdown,
} from "../src/canon/index.js";

const sha = (character: string): string => character.repeat(64);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function proposal(
  options: {
    conflict?: boolean;
    unverified?: boolean;
    supersession?: { supersedesCanonSha256: string; reasonSha256: string } | null;
  } = {},
) {
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
    verificationStatus: options.unverified ? "unverified" : "verified",
    applicabilitySha256: sha("3"),
    ownerAuthorityId: null,
    statementSha256: sha("3"),
    evidenceIds: ["e1"],
    assumptionIds: ["a1"],
    dependencyIds: ["d1"],
    affectedArtifactIds: ["file-1"],
    conflictGroupId: options.conflict ? "conflict-1" : null,
    supersededByClaimId: null,
  });
  const artifact = createFoundationCanonAffectedArtifact({
    id: "file-1",
    path: "docs/guide.md",
    digestSha256: sha("4"),
  });
  const claims = [claim];
  const conflicts = options.conflict
    ? (() => {
        const second = createFoundationCanonClaim({
          ...claim,
          id: "c2",
          assertionSha256: sha("9"),
          statementSha256: sha("9"),
          conflictGroupId: "conflict-1",
        });
        claims.push(second);
        return [
          createFoundationCanonConflict({
            id: "conflict-1",
            claimIds: ["c1", "c2"],
            resolutionSha256: null,
          }),
        ];
      })()
    : [];
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
    claims,
    evidence: [evidence],
    conflicts,
    assumptions: [assumption],
    dependencies: [dependency],
    affectedArtifacts: [artifact],
    supersession: options.supersession ?? null,
  });
}

function evidenceFor(
  canon: ReturnType<typeof proposal>,
  overrides: Partial<{
    revision: string;
    contentDigestSha256: string;
    inputManifestSha256: string;
    inputIds: string[];
    contentIndexDigestSha256: string | null;
    ontologyArtifactDigestSha256: string | null;
    priorCanonSha256: string | null;
    priorCanonPresent: boolean;
  }> = {},
) {
  return {
    repository: {
      identitySha256: canon.repository.identitySha256,
      revision: overrides.revision ?? canon.repository.revision,
      contentDigestSha256: overrides.contentDigestSha256 ?? canon.repository.contentDigestSha256,
    },
    inputManifestSha256: overrides.inputManifestSha256 ?? canon.inputBinding.manifestSha256,
    inputIds: overrides.inputIds ?? [...canon.inputBinding.inputIds],
    contentIndexDigestSha256: overrides.contentIndexDigestSha256 ?? null,
    ontologyArtifactDigestSha256: overrides.ontologyArtifactDigestSha256 ?? null,
    priorCanonSha256: overrides.priorCanonSha256 ?? null,
    priorCanonPresent: overrides.priorCanonPresent ?? false,
  };
}

async function temporaryStore(): Promise<DurableArtifactStore> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-canon-"));
  temporaryRoots.push(root);
  const store = new DurableArtifactStore(root);
  await store.initialize();
  return store;
}

describe("foundation canon persistence and projection", () => {
  it("persists and reloads a content-addressed canon through DurableArtifactStore", async () => {
    const store = await temporaryStore();
    const canon = proposal();
    const bindings = {
      contentIndexDigestSha256: sha("a"),
      ontologyArtifactDigestSha256: sha("b"),
    };
    const written = await persistFoundationCanon(store, canon, bindings);
    expect(written.created).toBe(true);
    expect(written.digest).toBe(canon.canonSha256);
    expect(await hasFoundationCanon(store, canon.canonSha256)).toBe(true);

    const again = await persistFoundationCanon(store, canon, bindings);
    expect(again.created).toBe(false);

    const loaded = await loadFoundationCanon(
      store,
      canon.canonSha256,
      evidenceFor(canon, {
        contentIndexDigestSha256: sha("a"),
        ontologyArtifactDigestSha256: sha("b"),
      }),
      { requireCurrent: true },
    );
    expect(loaded.artifact.canon).toEqual(canon);
    expect(loaded.freshness.disposition).toBe("current");
    expect(loaded.artifact.bindings).toEqual(bindings);
  });

  it("projects machine JSON, human report, and advisory markdown to one identity", () => {
    const canon = proposal({ unverified: true, conflict: true });
    const { machine, report } = projectFoundationCanonSurfaces(canon);
    assertProjectionRoundTrip(canon, machine, report);
    expect(report.machineProjectionSha256).toBe(machine.projectionSha256);
    expect(report.gapCount).toBeGreaterThan(0);
    const markdown = renderFoundationCanonMarkdown(canon);
    expect(markdown).toContain(machine.projectionSha256);
    expect(markdown).toContain("Advisory projection only");
    expect(markdown).not.toContain("glpat-");
  });

  it("returns deterministic query indexes without undisclosed source content", () => {
    const canon = proposal({ unverified: true, conflict: true });
    const index = buildFoundationCanonQueryIndex(canon);
    expect(index.claims.map((item) => item.id)).toEqual(["c1", "c2"]);
    expect(queryFoundationCanonConflicts(canon)).toHaveLength(1);
    expect(queryFoundationCanonGaps(canon).some((gap) => gap.kind === "unverified-claim")).toBe(
      true,
    );
    expect(queryFoundationCanonAffectedDocuments(canon)).toEqual([
      expect.objectContaining({ path: "docs/guide.md", claimIds: ["c1", "c2"] }),
    ]);
    expect(queryFoundationCanonApplicability(canon, sha("3"))).toHaveLength(1);
    expect(queryFoundationCanonClaims(canon, { verificationStatus: "unverified" }).length).toBe(2);
    expect(JSON.stringify(index)).not.toMatch(/secret|password|glpat-/i);
  });

  it("marks stale evidence and fails closed when required current", async () => {
    const store = await temporaryStore();
    const canon = proposal();
    await persistFoundationCanon(store, canon);

    const stale = evaluateFoundationCanonFreshness(canon, {
      ...evidenceFor(canon, { revision: "b".repeat(40) }),
      boundContentIndexDigestSha256: null,
      boundOntologyArtifactDigestSha256: null,
    });
    expect(stale.disposition).toBe("stale");
    expect(stale.reasons).toContain("repository-revision-mismatch");
    expect(() =>
      assertFoundationCanonCurrent(canon, {
        ...evidenceFor(canon, { contentDigestSha256: sha("f") }),
        boundContentIndexDigestSha256: null,
        boundOntologyArtifactDigestSha256: null,
      }),
    ).toThrowError(FoundationCanonInvalidationError);

    const loaded = await loadFoundationCanon(
      store,
      canon.canonSha256,
      evidenceFor(canon, { inputManifestSha256: sha("e") }),
    );
    expect(loaded.freshness.disposition).toBe("stale");
    expect(loaded.freshness.reasons).toContain("input-manifest-mismatch");

    await expect(
      loadFoundationCanon(
        store,
        canon.canonSha256,
        evidenceFor(canon, { ontologyArtifactDigestSha256: sha("c") }),
        { requireCurrent: true },
      ),
    ).rejects.toMatchObject({
      code: "stale-evidence",
    } satisfies Partial<FoundationCanonPersistenceError>);
  });

  it("requires prior canon presence when supersession is recorded", async () => {
    const store = await temporaryStore();
    const prior = proposal();
    await persistFoundationCanon(store, prior);
    const next = proposal({
      supersession: { supersedesCanonSha256: prior.canonSha256, reasonSha256: sha("8") },
    });
    // Force a distinct version body via different version id
    const { schemaVersion: _s, kind: _k, canonSha256: _c, ...body } = next;
    const superseded = createFoundationCanon({ ...body, version: "v2" });
    await persistFoundationCanon(store, superseded);

    const missingPrior = await loadFoundationCanon(
      store,
      superseded.canonSha256,
      evidenceFor(superseded, { priorCanonPresent: false, priorCanonSha256: null }),
    );
    expect(missingPrior.freshness.reasons).toEqual(
      expect.arrayContaining(["prior-canon-missing", "prior-canon-mismatch"]),
    );

    const current = await loadFoundationCanon(
      store,
      superseded.canonSha256,
      evidenceFor(superseded, {
        priorCanonPresent: true,
        priorCanonSha256: prior.canonSha256,
      }),
      { requireCurrent: true },
    );
    expect(current.freshness.disposition).toBe("current");
  });

  it("rejects substituted durable bytes", async () => {
    const store = await temporaryStore();
    const first = proposal();
    await persistFoundationCanon(store, first);
    const second = createFoundationCanon({
      ...(() => {
        const { schemaVersion: _s, kind: _k, canonSha256: _c, ...body } = first;
        return body;
      })(),
      version: "v-other",
    });
    // Different canonSha256 — distinct object key; substitution attack is same key different bytes
    await persistFoundationCanon(store, second);
    expect(first.canonSha256).not.toBe(second.canonSha256);

    await expect(store.putRecord(first.canonSha256, { tampered: true })).rejects.toMatchObject({
      code: "integrity-mismatch",
    });
  });
});
