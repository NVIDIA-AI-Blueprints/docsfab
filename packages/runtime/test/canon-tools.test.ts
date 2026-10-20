// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createFoundationCanon,
  createFoundationCanonAffectedArtifact,
  createFoundationCanonAssumption,
  createFoundationCanonClaim,
  createFoundationCanonConflict,
  createFoundationCanonDependency,
  createFoundationCanonEvidence,
} from "../src/canon/index.js";
import {
  CANON_TOOL_MAX_JSON_BYTES,
  CANON_TOOL_NAMES,
  runWithHostBoundCanon,
} from "../src/harness/canon-tools.js";
import { createConfinedToolSet } from "../src/harness/confined-tools.js";
import { temporaryRoots } from "./helpers/temp.js";

const temporaryDirectories = temporaryRoots();

const sha = (character: string): string => character.repeat(64);

function proposal(
  overrides: {
    evidenceIds?: string[];
    verificationStatus?: "unverified" | "verified" | "accepted-assumption";
    withConflict?: boolean;
  } = {},
) {
  const assumption = createFoundationCanonAssumption({
    id: "a1",
    statementSha256: sha("1"),
  });
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
    verificationStatus: overrides.verificationStatus ?? "verified",
    applicabilitySha256: sha("3"),
    ownerAuthorityId: null,
    statementSha256: sha("3"),
    evidenceIds: overrides.evidenceIds ?? ["e1"],
    assumptionIds: ["a1"],
    dependencyIds: ["d1"],
    affectedArtifactIds: ["file-1"],
    conflictGroupId: overrides.withConflict ? "x1" : null,
    supersededByClaimId: null,
  });
  const claim2 = overrides.withConflict
    ? createFoundationCanonClaim({
        id: "c2",
        subjectSha256: sha("8"),
        assertionSha256: sha("8"),
        confidence: "medium",
        verificationStatus: "unverified",
        applicabilitySha256: sha("8"),
        ownerAuthorityId: null,
        statementSha256: sha("8"),
        evidenceIds: ["e1"],
        assumptionIds: ["a1"],
        dependencyIds: ["d1"],
        affectedArtifactIds: ["file-1"],
        conflictGroupId: "x1",
        supersededByClaimId: null,
      })
    : null;
  const artifact = createFoundationCanonAffectedArtifact({
    id: "file-1",
    path: "docs/guide.md",
    digestSha256: sha("4"),
  });
  const conflict = overrides.withConflict
    ? [
        createFoundationCanonConflict({
          id: "x1",
          claimIds: ["c1", "c2"],
          resolutionSha256: null,
        }),
      ]
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
    claims: claim2 ? [claim, claim2] : [claim],
    evidence: [evidence],
    conflicts: conflict,
    assumptions: [assumption],
    dependencies: [dependency],
    affectedArtifacts: [artifact],
    supersession: null,
  });
}

function evidenceSnapshot(canon: ReturnType<typeof proposal>, stale = false) {
  return {
    repository: stale
      ? {
          identitySha256: sha("5"),
          revision: "b".repeat(40),
          contentDigestSha256: sha("6"),
        }
      : { ...canon.repository },
    inputManifestSha256: canon.inputBinding.manifestSha256,
    inputIds: [...canon.inputBinding.inputIds],
    contentIndexDigestSha256: null,
    ontologyArtifactDigestSha256: null,
    boundContentIndexDigestSha256: null,
    boundOntologyArtifactDigestSha256: null,
    priorCanonSha256: null,
    priorCanonPresent: false,
  };
}

async function fixture(allowWrite = false, boundCanonSha256?: string) {
  const root = await temporaryDirectories.create("docsfab-canon-tools-");
  const toolSet = await createConfinedToolSet({
    workspacePath: root,
    allowWrite,
    ...(boundCanonSha256 ? { boundCanonSha256 } : {}),
  });
  const tools = new Map(toolSet.definitions.map((tool) => [tool.name, tool]));
  const call = async (name: string, parameters: Record<string, unknown>) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    return tool.execute(`test-${name}`, parameters, undefined, undefined, undefined as never);
  };
  const resultJson = async (name: string, parameters: Record<string, unknown>) => {
    const result = await call(name, parameters);
    const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
    return JSON.parse(text) as Record<string, unknown>;
  };
  return { root, toolSet, call, resultJson };
}

describe("governed canon / structured-artifact tools", () => {
  it("exposes canon helpers on the read-only grant set without edit/write", async () => {
    const { toolSet } = await fixture(false);
    const names = toolSet.definitions.map((tool) => tool.name).sort();
    for (const name of CANON_TOOL_NAMES) {
      expect(names).toContain(name);
    }
    expect(names).toEqual(["find", "grep", "ls", "read", ...CANON_TOOL_NAMES].sort());
    expect(names).not.toContain("edit");
    expect(names).not.toContain("write");
    expect(names).not.toContain("bash");
  });

  it("keeps edit/write only when write is granted", async () => {
    const { toolSet } = await fixture(true);
    const names = toolSet.definitions.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["edit", "write", ...CANON_TOOL_NAMES]));
  });

  it("queries claims, conflicts/gaps, affected docs, and validates citations", async () => {
    const { resultJson } = await fixture(false);
    const canon = proposal({
      verificationStatus: "unverified",
      withConflict: true,
    });
    const canonJson = JSON.stringify(canon);

    const query = await resultJson("canon_query", {
      canonJson,
      verificationStatus: "unverified",
    });
    expect(query.kind).toBe("docsfab-canon-query-result");
    expect(query.canonSha256).toBe(canon.canonSha256);
    expect(query.claimCount).toBe(2);

    const gaps = await resultJson("canon_conflict_gap", { canonJson });
    expect(gaps.kind).toBe("docsfab-canon-conflict-gap-result");
    expect(gaps.conflicts).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "x1", resolved: false })]),
    );
    expect(gaps.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "unverified-claim", id: "c1" }),
        expect.objectContaining({ kind: "unverified-claim", id: "c2" }),
        expect.objectContaining({ kind: "unresolved-conflict", id: "x1" }),
      ]),
    );

    const docs = await resultJson("canon_affected_docs", { canonJson });
    expect(docs.kind).toBe("docsfab-canon-affected-docs-result");
    expect(docs.documents).toEqual([
      expect.objectContaining({
        id: "file-1",
        path: "docs/guide.md",
        claimIds: ["c1", "c2"],
      }),
    ]);

    const citations = await resultJson("canon_validate_citations", { canonJson });
    expect(citations.valid).toBe(true);
    expect(citations.failureCount).toBe(0);
  });

  it("validates citations on sealed canons and flags invented proposal refs", async () => {
    const { resultJson, toolSet } = await fixture(false);
    const canon = proposal();
    const ok = await resultJson("canon_validate_citations", {
      canonJson: JSON.stringify(canon),
    });
    expect(ok.valid).toBe(true);
    expect(ok.failureCount).toBe(0);

    const invented = createFoundationCanonClaim({
      id: "c-invented",
      subjectSha256: sha("a"),
      assertionSha256: sha("a"),
      confidence: "low",
      verificationStatus: "unverified",
      applicabilitySha256: sha("a"),
      ownerAuthorityId: null,
      statementSha256: sha("a"),
      evidenceIds: ["missing-evidence"],
      assumptionIds: [],
      dependencyIds: [],
      affectedArtifactIds: ["missing-file"],
      conflictGroupId: null,
      supersededByClaimId: null,
    });
    const bad = await resultJson("canon_validate_citations", {
      canonJson: JSON.stringify(canon),
      claimJson: JSON.stringify(invented),
    });
    expect(bad.valid).toBe(false);
    expect(bad.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invented-evidence", ref: "missing-evidence" }),
        expect.objectContaining({
          code: "invented-affected-artifact",
          ref: "missing-file",
        }),
      ]),
    );
    expect(toolSet.getFailureCategories()).toEqual([]);
  });

  it("proposes claims and submits structured artifacts as content-addressed refs", async () => {
    const { resultJson } = await fixture(false);
    const proposed = await resultJson("canon_propose_claim", {
      id: "c2",
      subjectSha256: sha("9"),
      assertionSha256: sha("9"),
      confidence: "medium",
      verificationStatus: "unverified",
      applicabilitySha256: sha("9"),
      statementSha256: sha("9"),
      evidenceIdsJson: JSON.stringify(["e1"]),
      assumptionIdsJson: JSON.stringify(["a1"]),
      dependencyIdsJson: JSON.stringify(["d1"]),
      affectedArtifactIdsJson: JSON.stringify(["file-1"]),
    });
    expect(proposed.kind).toBe("docsfab-canon-claim-proposal-result");
    expect(proposed.claimSha256).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/u));

    const submitted = await resultJson("canon_submit_artifact", {
      canonJson: JSON.stringify(proposal()),
    });
    expect(submitted.kind).toBe("docsfab-canon-submit-artifact-result");
    expect(submitted.projectionSha256).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/u));
    expect(submitted.reportSha256).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/u));
    expect(submitted.report).toEqual(
      expect.objectContaining({
        kind: "docsfab-foundation-canon-report",
        claimCount: 1,
        hasAuthority: false,
      }),
    );
  });

  it("fails closed for invalid, oversized, and stale inputs with existing taxonomy", async () => {
    const { call, toolSet } = await fixture(false);
    const canon = proposal();

    await expect(call("canon_query", { canonJson: "{not-json" })).rejects.toThrow(
      "DocsFab does not support the requested tool pattern.",
    );

    await expect(
      call("canon_query", { canonJson: "x".repeat(CANON_TOOL_MAX_JSON_BYTES + 1) }),
    ).rejects.toThrow("DocsFab does not support the requested tool pattern.");

    await expect(
      call("canon_query", {
        canonJson: JSON.stringify(canon),
        evidenceSnapshotJson: JSON.stringify(evidenceSnapshot(canon, true)),
      }),
    ).rejects.toThrow("DocsFab denied the requested tool path.");

    const categories = toolSet.getFailureCategories().map((entry) => entry.category);
    expect(categories).toEqual(expect.arrayContaining(["unsupported-pattern", "denied-path"]));
    expect(JSON.stringify(toolSet.getFailureCategories())).not.toMatch(/glpat-|secret/i);
  });

  it("accepts current evidence snapshots without inventing authority", async () => {
    const { resultJson } = await fixture(false);
    const canon = proposal();
    const result = await resultJson("canon_query", {
      canonJson: JSON.stringify(canon),
      evidenceSnapshotJson: JSON.stringify(evidenceSnapshot(canon, false)),
    });
    expect(result.claimCount).toBe(1);
    expect(result).not.toHaveProperty("authority");
  });

  it("fails closed when model-supplied canonJson disagrees with the host pin", async () => {
    const pinned = proposal();
    const other = proposal({ verificationStatus: "unverified" });
    expect(other.canonSha256).not.toBe(pinned.canonSha256);
    const { call, resultJson, toolSet } = await fixture(false, pinned.canonSha256);

    const matched = await resultJson("canon_query", { canonJson: JSON.stringify(pinned) });
    expect(matched.canonSha256).toBe(pinned.canonSha256);

    await expect(call("canon_query", { canonJson: JSON.stringify(other) })).rejects.toThrow(
      "DocsFab denied the requested tool path.",
    );
    await expect(
      call("canon_submit_artifact", { canonJson: JSON.stringify(other) }),
    ).rejects.toThrow("DocsFab denied the requested tool path.");
    expect(toolSet.getFailureCategories()).toEqual(
      expect.arrayContaining([{ category: "denied-path", count: 2 }]),
    );
  });

  it("fails closed when a run pin disagrees even without a tool-set option", async () => {
    const pinned = proposal();
    const other = proposal({ verificationStatus: "unverified" });
    const { call } = await fixture(false);
    await expect(
      runWithHostBoundCanon(pinned.canonSha256, () =>
        call("canon_query", { canonJson: JSON.stringify(other) }),
      ),
    ).rejects.toThrow("DocsFab denied the requested tool path.");
  });
});
