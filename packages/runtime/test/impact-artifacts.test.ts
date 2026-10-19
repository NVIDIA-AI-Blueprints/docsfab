// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createArtifact } from "../src/artifacts/index.js";
import {
  canonicalDigest,
  type ContentIndexV1,
  type DocumentNode,
} from "../src/content-ir/index.js";
import { analyzeDocumentationImpact } from "../src/impact/analyze.js";
import { createImpactReportArtifact } from "../src/impact/artifacts.js";
import {
  coordinateDocumentationImpact,
  createImpactClassificationDiagnostics,
} from "../src/impact/coordinator.js";
import { DEFAULT_HEALING_POLICY, type HealingPolicy } from "../src/impact/policy.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("impact artifact adapter", () => {
  it("binds the deterministic analysis, policy decision, and before/after indexes", () => {
    const before = index(A, "1", "2");
    const after = index(B, "3", "4", true);
    const policy = {
      id: DEFAULT_HEALING_POLICY.id,
      version: DEFAULT_HEALING_POLICY.version,
      digest: DEFAULT_HEALING_POLICY.digest,
    };
    const analysis = analyzeDocumentationImpact({
      mode: "incremental",
      before,
      after,
      policy,
      semanticSignals: [
        {
          kind: "new-concept",
          targetNodeId: "document:guide",
          relatedNodeIds: ["document:home"],
        },
      ],
    });
    const policyInput = {
      proposal: {
        action: "cross-link",
        requestedLevel: "bounded-repair",
        targetNodeIds: ["document:guide"],
        outputPaths: ["docs/guide.md"],
        changesStableUrl: false,
      },
      pressure: 0.5,
      expectedBenefit: 0.8,
      wordGrowth: 0,
      materialEvidence: [
        { id: "evidence:semantic", kind: "semantic-change", digest: "5".repeat(64) },
        { id: "evidence:source", kind: "source-of-truth-change", digest: "6".repeat(64) },
      ],
      observedAt: "2026-08-03T20:00:00.000Z",
    } as const;

    const artifact = createImpactReportArtifact({
      analysis,
      policy: DEFAULT_HEALING_POLICY,
      beforeIndex: before,
      afterIndex: after,
      policyInput,
      beforeOntology: ontology(before, false),
      afterOntology: ontology(after, true),
      evidence: [{ path: "docs/guide.md", nodeId: "document:guide" }],
    });

    expect(artifact.repository).toEqual(after.repository);
    expect(artifact.payload).toMatchObject({
      beforeRepository: before.repository,
      afterRepository: after.repository,
      beforeIndexDigest: before.indexDigest,
      afterIndexDigest: after.indexDigest,
      semanticImpact: "cross-cutting",
      recommendedAction: "bounded-repair",
      requiredApproval: "maintainer",
    });
    expect(artifact.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects a policy decision or index not bound into the analysis", () => {
    const before = index(A, "1", "2");
    const after = index(B, "3", "4", true);
    const analysis = analyzeDocumentationImpact({
      mode: "incremental",
      before,
      after,
      policy: {
        id: DEFAULT_HEALING_POLICY.id,
        version: DEFAULT_HEALING_POLICY.version,
        digest: DEFAULT_HEALING_POLICY.digest,
      },
    });
    const policyInput = {
      proposal: {
        action: "observe",
        requestedLevel: "observe",
        targetNodeIds: ["document:guide"],
        outputPaths: ["docs/guide.md"],
        changesStableUrl: false,
      },
      pressure: 0,
      expectedBenefit: 0,
      wordGrowth: 0,
      materialEvidence: [],
      observedAt: "2026-08-03T20:00:00.000Z",
    } as const;
    const forgedPolicyAnalysis = analyzeDocumentationImpact({
      mode: "incremental",
      before,
      after,
      policy: {
        id: DEFAULT_HEALING_POLICY.id,
        version: DEFAULT_HEALING_POLICY.version,
        digest: "f".repeat(64),
      },
    });

    expect(() =>
      createImpactReportArtifact({
        analysis: forgedPolicyAnalysis,
        policy: DEFAULT_HEALING_POLICY,
        beforeIndex: before,
        afterIndex: after,
        policyInput,
        beforeOntology: ontology(before, false),
        afterOntology: ontology(after, false),
        evidence: [{ path: "docs/guide.md", nodeId: "document:guide" }],
      }),
    ).toThrow("policy decision");
    expect(() =>
      createImpactReportArtifact({
        analysis,
        policy: DEFAULT_HEALING_POLICY,
        beforeIndex: index(A, "7", "2"),
        afterIndex: after,
        policyInput,
        beforeOntology: ontology(before, false),
        afterOntology: ontology(after, false),
        evidence: [{ path: "docs/guide.md", nodeId: "document:guide" }],
      }),
    ).toThrow("supplied indexes");
  });

  it("retains removed nodes by resolving affected IDs against the before index", () => {
    const before = index(A, "1", "2");
    const afterBase = index(B, "3", "4");
    const after: ContentIndexV1 = {
      ...afterBase,
      nodes: afterBase.nodes.filter((node) => node.id !== "document:guide"),
      edges: [],
      evidence: {
        ...afterBase.evidence,
        documentCount: 1,
        edgeCount: 0,
      },
    };
    const analysis = analyzeDocumentationImpact({
      mode: "incremental",
      before,
      after,
      policy: {
        id: DEFAULT_HEALING_POLICY.id,
        version: DEFAULT_HEALING_POLICY.version,
        digest: DEFAULT_HEALING_POLICY.digest,
      },
    });
    const artifact = createImpactReportArtifact({
      analysis,
      policy: DEFAULT_HEALING_POLICY,
      beforeIndex: before,
      afterIndex: after,
      policyInput: {
        proposal: {
          action: "observe",
          requestedLevel: "observe",
          targetNodeIds: ["document:home"],
          outputPaths: ["docs/index.md"],
          changesStableUrl: false,
        },
        pressure: 0,
        expectedBenefit: 0,
        wordGrowth: 0,
        materialEvidence: [],
        observedAt: "2026-08-03T20:00:00.000Z",
      },
      beforeOntology: ontology(before, false),
      afterOntology: ontology(after, false),
      evidence: [{ path: "docs/index.md", nodeId: "document:home" }],
    });

    expect(artifact.payload.affectedNodeIds).toContain("document:guide");
  });

  it("honors the exact custom policy approval mapping bound into the analysis", () => {
    const before = index(A, "1", "2");
    const after = index(B, "3", "4", true);
    const custom = customPolicy();
    const analysis = analyzeDocumentationImpact({
      mode: "incremental",
      before,
      after,
      policy: { id: custom.id, version: custom.version, digest: custom.digest },
    });
    const artifact = createImpactReportArtifact({
      analysis,
      policy: custom,
      beforeIndex: before,
      afterIndex: after,
      policyInput: {
        proposal: {
          action: "link-repair",
          requestedLevel: "bounded-repair",
          targetNodeIds: ["document:guide"],
          outputPaths: ["docs/guide.md"],
          changesStableUrl: false,
        },
        pressure: 0.5,
        expectedBenefit: 0.8,
        wordGrowth: 0,
        materialEvidence: [
          { id: "evidence:one", kind: "link-failure", digest: "8".repeat(64) },
          { id: "evidence:two", kind: "source-of-truth-change", digest: "9".repeat(64) },
        ],
        observedAt: "2026-08-03T20:00:00.000Z",
      },
      beforeOntology: ontology(before, false),
      afterOntology: ontology(after, false),
      evidence: [{ path: "docs/guide.md", nodeId: "document:guide" }],
    });

    expect(artifact.payload.requiredApproval).toBe("product-owner");
  });

  it("reports semantic impact for an ontology-only entity change", () => {
    const before = index(A, "1", "2");
    const after = index(B, "3", "4");
    const beforeOntology = createArtifact(
      "ontology",
      {
        entities: [
          {
            id: "entity:concept",
            label: "Original concept",
            kind: "concept" as const,
            evidence: [{ path: "docs/guide.md", nodeId: "document:guide" }],
          },
        ],
        relationships: [],
      },
      { index: before },
    );
    const afterOntology = createArtifact(
      "ontology",
      {
        entities: [
          {
            id: "entity:concept",
            label: "Revised concept",
            kind: "concept" as const,
            evidence: [{ path: "docs/guide.md", nodeId: "document:guide" }],
          },
        ],
        relationships: [],
      },
      { index: after },
    );
    const coordinated = coordinateDocumentationImpact({
      mode: "incremental",
      before,
      after,
      policy: {
        id: DEFAULT_HEALING_POLICY.id,
        version: DEFAULT_HEALING_POLICY.version,
        digest: DEFAULT_HEALING_POLICY.digest,
      },
      beforeOntology,
      afterOntology,
      classification: createImpactClassificationDiagnostics({
        schemaVersion: 1,
        beforeRepository: { ...before.repository, indexDigest: before.indexDigest },
        afterRepository: { ...after.repository, indexDigest: after.indexDigest },
        newContentTypeNodeIds: [],
        duplicateKnowledge: [],
      }),
    });
    const artifact = createImpactReportArtifact({
      analysis: coordinated.analysis,
      policy: DEFAULT_HEALING_POLICY,
      beforeIndex: before,
      afterIndex: after,
      beforeOntology,
      afterOntology,
      policyInput: {
        proposal: {
          action: "observe",
          requestedLevel: "observe",
          targetNodeIds: ["document:guide"],
          outputPaths: ["docs/guide.md"],
          changesStableUrl: false,
        },
        pressure: 0,
        expectedBenefit: 0,
        wordGrowth: 0,
        materialEvidence: [],
        observedAt: "2026-08-03T20:00:00.000Z",
      },
      evidence: [{ path: "docs/guide.md", nodeId: "document:guide" }],
    });

    expect(coordinated.analysis.changedPaths).toEqual([]);
    expect(coordinated.analysis.neighborhood).toContainEqual({
      nodeId: "document:guide",
      regions: ["semantic-context"],
      reasons: ["ontology-entity"],
    });
    expect(artifact.payload).toMatchObject({
      affectedNodeIds: ["document:guide"],
      semanticImpact: "cross-cutting",
    });
  });
});

function customPolicy(): HealingPolicy {
  const { digest: _digest, ...base } = DEFAULT_HEALING_POLICY;
  const value = {
    ...structuredClone(base),
    version: "custom-approval-1",
    approvals: {
      ...base.approvals,
      "bounded-repair": "product-owner" as const,
    },
  };
  return { ...value, digest: canonicalDigest(value) };
}

function ontology(indexValue: ContentIndexV1, withConcept: boolean) {
  return createArtifact(
    "ontology",
    {
      entities: withConcept
        ? [
            {
              id: "entity:new-concept",
              label: "New concept",
              kind: "concept" as const,
              evidence: [{ path: "docs/guide.md", nodeId: "document:guide" }],
            },
          ]
        : [],
      relationships: [],
    },
    { index: indexValue },
  );
}

function index(
  revision: string,
  contentSeed: string,
  indexSeed: string,
  changed = false,
): ContentIndexV1 {
  const nodes = [
    document("document:home", "docs/index.md", "a"),
    document("document:guide", "docs/guide.md", changed ? "b" : "a"),
  ];
  return {
    schemaVersion: 1,
    repository: { revision, contentDigest: contentSeed.repeat(64) },
    indexDigest: indexSeed.repeat(64),
    nodes,
    edges: [{ kind: "parent", from: "document:guide", to: "document:home" }],
    evidence: {
      repositoryRevision: revision,
      contentDigest: contentSeed.repeat(64),
      indexDigest: indexSeed.repeat(64),
      documentCount: 2,
      sectionCount: 0,
      edgeCount: 1,
    },
  };
}

function document(id: string, sourcePath: string, seed: string): DocumentNode {
  const digest = seed.repeat(64);
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
      body: digest,
      headings: digest,
      metadata: digest,
      navigation: digest,
      graph: digest,
    },
  };
}
