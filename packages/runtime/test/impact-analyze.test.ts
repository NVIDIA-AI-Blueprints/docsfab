// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type {
  ContentIndexV1,
  DocumentNode,
  StructuralChangeRegion,
  StructuralEdge,
} from "../src/content-ir/index.js";
import { analyzeDocumentationImpact } from "../src/impact/analyze.js";
import { DEFAULT_HEALING_POLICY } from "../src/impact/policy.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const policy = {
  id: DEFAULT_HEALING_POLICY.id,
  version: DEFAULT_HEALING_POLICY.version,
  digest: DEFAULT_HEALING_POLICY.digest,
};

describe("incremental documentation impact analysis", () => {
  it("keeps a 400-word body-only change local to semantic reevaluation", () => {
    const before = corpus();
    const after = mutate(before, "document:guide", ["body"]);
    const result = analyzeDocumentationImpact({
      mode: "incremental",
      before,
      after,
      policy,
      beforeWordCounts: { "document:guide": 600 },
      afterWordCounts: { "document:guide": 1_000 },
    });

    expect(entry(result, "document:guide")).toMatchObject({
      regions: ["body", "semantic-context"],
      reasons: ["direct-change", "word-growth-signal"],
    });
    expect(entry(result, "document:home")?.regions).toEqual(["semantic-context"]);
    expect(entry(result, "document:reference")?.regions).toEqual(["semantic-context"]);
    expect(
      result.neighborhood.every(
        (item) => !item.regions.includes("navigation") && !item.regions.includes("graph"),
      ),
    ).toBe(true);
  });

  it("expands new concepts through ontology, canonical-home, and navigation evidence", () => {
    const before = corpus();
    const after = mutate(before, "document:guide", ["body"]);
    const result = analyzeDocumentationImpact({
      mode: "incremental",
      before,
      after,
      policy,
      semanticSignals: [
        {
          kind: "new-concept",
          targetNodeId: "document:guide",
          relatedNodeIds: ["document:concept"],
        },
      ],
      canonicalHomeByNodeId: { "document:guide": "document:home" },
      navigationScenarios: [
        {
          id: "scenario:configure",
          nodeIds: ["document:guide", "document:reference"],
        },
      ],
    });

    expect(entry(result, "document:guide")?.reasons).toContain("new-concept");
    expect(entry(result, "document:concept")).toMatchObject({
      regions: ["semantic-context"],
      reasons: ["ontology-entity"],
    });
    expect(entry(result, "document:home")?.reasons).toContain("canonical-home");
    expect(entry(result, "document:reference")?.reasons).toContain("navigation-scenario");
  });

  it("expands navigation deterministically when sibling pressure crosses the policy threshold", () => {
    const before = corpus(2);
    const afterBase = corpus(3, B);
    const added = afterBase.nodes.find((node) => node.id === "document:child-3") as DocumentNode;
    const after = {
      ...afterBase,
      nodes: [
        ...afterBase.nodes.filter((node) => node.id !== added.id),
        {
          ...added,
          regions: regionDigests("added"),
        },
      ],
      indexDigest: "9".repeat(64),
      evidence: { ...afterBase.evidence, indexDigest: "9".repeat(64) },
    };
    const result = analyzeDocumentationImpact({
      mode: "incremental",
      before,
      after,
      policy,
      siblingPressureThreshold: 4,
    });

    for (const id of [
      "document:home",
      "document:child-1",
      "document:child-2",
      "document:child-3",
    ]) {
      expect(entry(result, id)?.reasons).toContain("sibling-pressure");
      expect(entry(result, id)?.regions).toEqual(expect.arrayContaining(["navigation", "graph"]));
    }
  });

  it("makes full and incremental modes agree on the affected neighborhood", () => {
    const before = corpus();
    const after = mutate(before, "document:guide", ["headings", "graph"]);
    const common = { before, after, policy };
    const incremental = analyzeDocumentationImpact({ mode: "incremental", ...common });
    const full = analyzeDocumentationImpact({ mode: "full", ...common });

    expect(full.neighborhood).toEqual(incremental.neighborhood);
    expect(full.changedPaths).toEqual(incremental.changedPaths);
    expect(full.changedRegions).toEqual(incremental.changedRegions);
    expect(full.digest).not.toBe(incremental.digest);
  });

  it("keeps incremental and full projections equal for an affected overfull family", () => {
    const before = corpus(9);
    const after = mutate(before, "document:child-1", ["body"]);
    const common = { before, after, policy, siblingPressureThreshold: 8 };
    const incremental = analyzeDocumentationImpact({ mode: "incremental", ...common });
    const full = analyzeDocumentationImpact({ mode: "full", ...common });

    expect(full.neighborhood).toEqual(incremental.neighborhood);
    expect(entry(incremental, "document:home")).toMatchObject({
      regions: expect.arrayContaining(["navigation", "graph"]),
      reasons: expect.arrayContaining(["sibling-pressure"]),
    });
  });

  it("keeps semantic-only incremental and full projections equal under existing sibling pressure", () => {
    const before = corpus(9);
    const after = corpus(9, B);
    const common = {
      before,
      after,
      policy,
      siblingPressureThreshold: 8,
      semanticSignals: [
        {
          kind: "new-concept" as const,
          targetNodeId: "document:child-1",
          relatedNodeIds: [],
        },
      ],
    };
    const incremental = analyzeDocumentationImpact({ mode: "incremental", ...common });
    const full = analyzeDocumentationImpact({ mode: "full", ...common });

    expect(full.neighborhood).toEqual(incremental.neighborhood);
    expect(entry(incremental, "document:child-1")).toMatchObject({
      regions: expect.arrayContaining(["navigation", "graph", "semantic-context"]),
      reasons: expect.arrayContaining(["sibling-pressure", "new-concept"]),
    });
  });

  it("reports both old and new paths for an otherwise content-identical move", () => {
    const before = corpus();
    const after = structuredClone(before);
    after.repository = { revision: B, contentDigest: "4".repeat(64) };
    after.indexDigest = "2".repeat(64);
    after.evidence = {
      ...after.evidence,
      repositoryRevision: B,
      contentDigest: "4".repeat(64),
      indexDigest: "2".repeat(64),
    };
    const moved = after.nodes.find((node) => node.id === "document:guide");
    if (!moved) throw new Error("Missing move fixture.");
    moved.sourcePath = "docs/guides/guide.md";

    const result = analyzeDocumentationImpact({ mode: "incremental", before, after, policy });

    expect(result.changedPaths).toEqual(["docs/guide.md", "docs/guides/guide.md"]);
    expect(entry(result, "document:guide")?.regions).toEqual(
      expect.arrayContaining(["navigation", "graph"]),
    );
  });
});

function entry(result: ReturnType<typeof analyzeDocumentationImpact>, nodeId: string) {
  return result.neighborhood.find((item) => item.nodeId === nodeId);
}

function corpus(children = 0, revision = A): ContentIndexV1 {
  const baseDocuments = [
    document("document:home", "docs/index.md"),
    document("document:guide", "docs/guide.md"),
    document("document:reference", "docs/reference.md"),
    document("document:concept", "docs/concept.md"),
  ];
  const childDocuments = Array.from({ length: children }, (_, index) =>
    document(`document:child-${index + 1}`, `docs/child-${index + 1}.md`),
  );
  const edges: StructuralEdge[] = [
    { kind: "parent", from: "document:guide", to: "document:home" },
    { kind: "parent", from: "document:reference", to: "document:home" },
    ...childDocuments.map(
      (child): StructuralEdge => ({
        kind: "parent",
        from: child.id,
        to: "document:home",
      }),
    ),
  ];
  const nodes = [...baseDocuments, ...childDocuments];
  const indexDigest = revision === A ? "1".repeat(64) : "2".repeat(64);
  return {
    schemaVersion: 1,
    repository: { revision, contentDigest: revision === A ? "3".repeat(64) : "4".repeat(64) },
    indexDigest,
    nodes,
    edges,
    evidence: {
      repositoryRevision: revision,
      contentDigest: revision === A ? "3".repeat(64) : "4".repeat(64),
      indexDigest,
      documentCount: nodes.length,
      sectionCount: 0,
      edgeCount: edges.length,
    },
  };
}

function mutate(
  before: ContentIndexV1,
  documentId: string,
  regions: StructuralChangeRegion[],
): ContentIndexV1 {
  const nodes = before.nodes.map((node) =>
    node.id === documentId && node.kind === "document"
      ? {
          ...node,
          regions: Object.fromEntries(
            Object.entries(node.regions).map(([region, digest]) => [
              region,
              regions.includes(region as StructuralChangeRegion) ? "8".repeat(64) : digest,
            ]),
          ) as DocumentNode["regions"],
        }
      : node,
  );
  return {
    ...before,
    repository: { revision: B, contentDigest: "4".repeat(64) },
    indexDigest: "2".repeat(64),
    nodes,
    evidence: {
      ...before.evidence,
      repositoryRevision: B,
      contentDigest: "4".repeat(64),
      indexDigest: "2".repeat(64),
    },
  };
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
    regions: regionDigests(id),
  };
}

function regionDigests(seed: string): DocumentNode["regions"] {
  const digest = seed
    .padEnd(64, "0")
    .slice(0, 64)
    .replace(/[^a-f0-9]/gu, "0");
  return { body: digest, headings: digest, metadata: digest, navigation: digest, graph: digest };
}
