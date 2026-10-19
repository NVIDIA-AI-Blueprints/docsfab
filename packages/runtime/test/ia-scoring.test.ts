// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ArtifactEvidence } from "../src/artifacts/contracts.js";
import type { ContentIndexV1, DocumentNode } from "../src/content-ir/contracts.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import {
  candidateTopologyDigest,
  compareIaCandidateScores,
  IaScoringError,
  scoreIaCandidate,
  selectEligibleCandidate,
  type IaScoringCandidate,
} from "../src/ia/scoring.js";

const REVISION = "a".repeat(40);
const CONTENT_DIGEST = "b".repeat(64);

const documents = [
  document("doc:install", "docs/install.md"),
  document("doc:configure", "docs/configure.md"),
  document("doc:operate", "docs/operate.md"),
  document("doc:troubleshoot", "docs/troubleshoot.md"),
];

const index = bindIndex({
  schemaVersion: 1,
  repository: { revision: REVISION, contentDigest: CONTENT_DIGEST },
  indexDigest: "c".repeat(64),
  nodes: documents,
  edges: [
    { kind: "outbound-link", from: "doc:install", to: "doc:configure" },
    { kind: "outbound-link", from: "doc:operate", to: "doc:troubleshoot" },
  ],
  evidence: {
    repositoryRevision: REVISION,
    contentDigest: CONTENT_DIGEST,
    indexDigest: "c".repeat(64),
    documentCount: 4,
    sectionCount: 0,
    edgeCount: 2,
  },
});

function bindIndex(value: ContentIndexV1): ContentIndexV1 {
  const indexDigest = canonicalDigest({
    schemaVersion: value.schemaVersion,
    repository: value.repository,
    nodes: value.nodes,
    edges: value.edges,
  });
  return { ...value, indexDigest, evidence: { ...value.evidence, indexDigest } };
}

const targets = documents.map((node) => node.id);

describe("deterministic IA scoring", () => {
  it("improves structural findability without moving any URL", () => {
    const baseline = scoreIaCandidate({
      index,
      targetNodeIds: targets,
      candidate: baselineCandidate(),
    });
    const improved = scoreIaCandidate({
      index,
      targetNodeIds: targets,
      candidate: improvedCandidate(),
    });
    const comparison = compareIaCandidateScores(baseline, improved);

    expect(baseline.components).toEqual({
      evidenceCoverage: 100,
      cohesion: 0,
      separation: 0,
      predictability: 100,
      balance: 100,
      stability: 100,
      duplication: 100,
    });
    expect(improved.components).toEqual({
      evidenceCoverage: 100,
      cohesion: 100,
      separation: 100,
      predictability: 100,
      balance: 100,
      stability: 100,
      duplication: 100,
    });
    expect(baseline.total).toBe(70);
    expect(improved.total).toBe(100);
    expect(comparison).toMatchObject({
      topologyChanged: true,
      totalDelta: 30,
      structuralFindabilityDelta: 45,
      improvesFindability: true,
      preservesAllUrls: true,
      candidateEligibility: { eligible: true, reasons: [] },
    });
    expect(Object.values(improved.components).every((score) => score >= 0 && score <= 100)).toBe(
      true,
    );
  });

  it("ignores display labels and array order in topology and score comparisons", () => {
    const original = improvedCandidate();
    const reordered: IaScoringCandidate = {
      ...original,
      id: "candidate:renamed-machine-id",
      label: "A different display label",
      groups: [...original.groups].reverse().map((group) => ({
        ...group,
        id: `${group.id}:renamed`,
        label: `Renamed ${group.label}`,
        memberNodeIds: [...group.memberNodeIds].reverse(),
        evidence: [...group.evidence].reverse(),
      })),
      placements: [...original.placements].reverse().map((placement) => ({
        ...placement,
        evidence: [...placement.evidence].reverse(),
      })),
      evidence: [...original.evidence].reverse(),
    };

    const originalScore = scoreIaCandidate({ index, targetNodeIds: targets, candidate: original });
    const reorderedScore = scoreIaCandidate({
      index,
      targetNodeIds: [...targets].reverse(),
      candidate: reordered,
    });
    expect(candidateTopologyDigest(reordered)).toBe(candidateTopologyDigest(original));
    expect(reorderedScore.topologyDigest).toBe(originalScore.topologyDigest);
    expect(reorderedScore.components).toEqual(originalScore.components);
    expect(reorderedScore.total).toBe(originalScore.total);
  });

  it("rejects a tidy but ambiguous topology from the eligibility seam", () => {
    const tidyButAmbiguous = scoreIaCandidate({
      index,
      targetNodeIds: targets,
      candidate: ambiguousCandidate(),
    });
    const improved = scoreIaCandidate({
      index,
      targetNodeIds: targets,
      candidate: improvedCandidate(),
    });
    const baseline = scoreIaCandidate({
      index,
      targetNodeIds: targets,
      candidate: baselineCandidate(),
    });

    expect(tidyButAmbiguous.components).toMatchObject({
      cohesion: 100,
      separation: 100,
      stability: 100,
    });
    expect(tidyButAmbiguous.eligibility).toEqual({
      eligible: false,
      reasons: ["ambiguous-placement"],
    });
    expect(selectEligibleCandidate([tidyButAmbiguous, baseline, improved])?.candidateId).toBe(
      "candidate:improved",
    );
    expect(selectEligibleCandidate([improved, baseline, tidyButAmbiguous])?.candidateId).toBe(
      "candidate:improved",
    );
  });

  it("fails closed when typed evidence does not resolve to the bound index", () => {
    const candidate = improvedCandidate();
    candidate.groups[0]!.evidence[0] = {
      path: "docs/not-install.md",
      nodeId: "doc:install",
    };

    expect(() => scoreIaCandidate({ index, targetNodeIds: targets, candidate })).toThrowError(
      new IaScoringError("invalid-evidence", "candidate.groups[0].evidence[0]"),
    );
  });

  it("accepts an explicitly declared secondary-axis sibling set and rejects an undeclared one", () => {
    const declared = improvedCandidate();
    declared.secondaryAxes = ["lifecycle"];
    declared.groups[1]!.axis = "lifecycle";
    const undeclared = structuredClone(declared);
    undeclared.id = "candidate:undeclared-shift";
    undeclared.secondaryAxes = [];

    expect(
      scoreIaCandidate({ index, targetNodeIds: targets, candidate: declared }).eligibility,
    ).toEqual({ eligible: true, reasons: [] });
    expect(
      scoreIaCandidate({ index, targetNodeIds: targets, candidate: undeclared }).eligibility,
    ).toEqual({ eligible: false, reasons: ["mixed-axis"] });
  });
});

function baselineCandidate(): IaScoringCandidate {
  return candidate("candidate:baseline", [
    group("group:basics", "Basics", ["doc:install", "doc:operate"]),
    group("group:advanced", "Advanced", ["doc:configure", "doc:troubleshoot"]),
  ]);
}

function improvedCandidate(): IaScoringCandidate {
  return candidate("candidate:improved", [
    group("group:get-started", "Get started", ["doc:install", "doc:configure"]),
    group("group:maintain", "Maintain", ["doc:operate", "doc:troubleshoot"]),
  ]);
}

function ambiguousCandidate(): IaScoringCandidate {
  return candidate("candidate:tidy-ambiguous", [
    group("group:get-started", "Get started", ["doc:install", "doc:configure"]),
    group("group:onboarding", "Onboarding", ["doc:install", "doc:configure"]),
    group("group:maintain", "Maintain", ["doc:operate", "doc:troubleshoot"]),
  ]);
}

function candidate(id: string, groups: IaScoringCandidate["groups"]): IaScoringCandidate {
  return {
    id,
    label: `Label for ${id}`,
    primaryAxis: "reader-job",
    secondaryAxes: [],
    groups,
    placements: documents.map((node) => ({
      nodeId: node.id,
      proposedPath: node.sourcePath,
      evidence: [evidence(node.id)],
    })),
    evidence: documents.map((node) => evidence(node.id)),
  };
}

function group(
  id: string,
  label: string,
  memberNodeIds: string[],
): IaScoringCandidate["groups"][number] {
  return {
    id,
    label,
    axis: "reader-job",
    canonicalPath: `docs/${id.slice("group:".length)}`,
    memberNodeIds,
    evidence: memberNodeIds.map(evidence),
  };
}

function evidence(nodeId: string): ArtifactEvidence {
  const node = documents.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`missing fixture node: ${nodeId}`);
  return { path: node.sourcePath, nodeId };
}

function document(id: string, sourcePath: string): DocumentNode {
  return {
    id,
    kind: "document",
    sourcePath,
    format: "gfm",
    byteLength: 100,
    anchors: [],
    frontmatter: [],
    directives: [],
    codeBlocks: [],
    regions: {
      body: "1".repeat(64),
      headings: "2".repeat(64),
      metadata: "3".repeat(64),
      navigation: "4".repeat(64),
      graph: "5".repeat(64),
    },
  };
}
