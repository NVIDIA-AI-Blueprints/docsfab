// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createArtifact, type OntologyEntity } from "../src/artifacts/index.js";
import type { ContentIndexV1, DocumentNode, StructuralEdge } from "../src/content-ir/index.js";
import {
  coordinateDocumentationImpact,
  createImpactClassificationDiagnostics,
} from "../src/impact/coordinator.js";
import { DEFAULT_HEALING_POLICY } from "../src/impact/policy.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("issue #25 impact acceptance matrix", () => {
  it("expands a mixed-purpose growth change from bound job, concept, and content-type evidence", () => {
    const before = index(
      A,
      [
        document("document:home", "docs/index.md", "1"),
        document("document:guide", "docs/guide.md", "1"),
      ],
      [parent("document:guide")],
    );
    const after = index(
      B,
      [
        document("document:home", "docs/index.md", "1"),
        document("document:guide", "docs/guide.md", "2"),
      ],
      [parent("document:guide")],
    );
    const result = coordinate(
      before,
      after,
      [
        entity("entity:configure-job", "user-job", "document:guide"),
        entity("entity:credential", "concept", "document:guide"),
      ],
      ["document:guide"],
      [],
    );
    const guide = result.analysis.neighborhood.find((entry) => entry.nodeId === "document:guide");

    expect(guide?.reasons).toEqual(
      expect.arrayContaining(["new-job", "new-concept", "new-content-type"]),
    );
    expect(result.ontology.delta.addedEntityIds).toEqual([
      "entity:configure-job",
      "entity:credential",
    ]);
  });

  it("places a new page through its approved canonical-home neighborhood", () => {
    const before = index(A, [document("document:home", "docs/index.md", "1")], []);
    const after = index(
      B,
      [
        document("document:home", "docs/index.md", "1"),
        document("document:new-page", "docs/new-page.md", "2"),
      ],
      [parent("document:new-page")],
    );
    const result = coordinate(before, after, [], ["document:new-page"], [], {
      "document:new-page": "document:home",
    });

    expect(result.analysis.changedPaths).toEqual(["docs/new-page.md"]);
    expect(
      result.analysis.neighborhood.find((entry) => entry.nodeId === "document:new-page"),
    ).toMatchObject({ reasons: expect.arrayContaining(["direct-change", "new-content-type"]) });
    expect(
      result.analysis.neighborhood.find((entry) => entry.nodeId === "document:home")?.reasons,
    ).toEqual(expect.arrayContaining(["parent", "canonical-home"]));
  });

  it("expands duplicate knowledge from content-addressed classification diagnostics", () => {
    const documents = [
      document("document:home", "docs/index.md", "1"),
      document("document:canonical", "docs/canonical.md", "1"),
      document("document:duplicate", "docs/duplicate.md", "1"),
    ];
    const before = index(A, documents, [
      parent("document:canonical"),
      parent("document:duplicate"),
    ]);
    const after = index(
      B,
      [documents[0]!, { ...documents[1]!, regions: regions("2") }, documents[2]!],
      [parent("document:canonical"), parent("document:duplicate")],
    );
    const result = coordinate(
      before,
      after,
      [],
      [],
      [
        {
          canonicalNodeId: "document:canonical",
          duplicateNodeIds: ["document:duplicate"],
        },
      ],
    );

    expect(
      result.analysis.neighborhood.find((entry) => entry.nodeId === "document:canonical")?.reasons,
    ).toContain("duplicate-knowledge");
    expect(
      result.analysis.neighborhood.find((entry) => entry.nodeId === "document:duplicate")?.reasons,
    ).toContain("ontology-entity");
  });

  it("rejects unbound or digest-tampered classification evidence", () => {
    const before = index(A, [document("document:home", "docs/index.md", "1")], []);
    const after = index(B, [document("document:home", "docs/index.md", "2")], []);
    const classification = createImpactClassificationDiagnostics({
      schemaVersion: 1,
      beforeRepository: binding(before),
      afterRepository: binding(after),
      newContentTypeNodeIds: ["document:home"],
      duplicateKnowledge: [],
    });
    classification.digest = "f".repeat(64);

    expect(() =>
      coordinateDocumentationImpact({
        mode: "incremental",
        before,
        after,
        policy: policy(),
        beforeOntology: createArtifact(
          "ontology",
          { entities: [], relationships: [] },
          { index: before },
        ),
        afterOntology: createArtifact(
          "ontology",
          { entities: [], relationships: [] },
          { index: after },
        ),
        classification,
      }),
    ).toThrow("digest");
  });

  it("reevaluates evidence nodes for changed and removed ontology entities", () => {
    const documents = [
      document("document:home", "docs/index.md", "1"),
      document("document:guide", "docs/guide.md", "1"),
      document("document:legacy", "docs/legacy.md", "1"),
    ];
    const before = index(A, documents, [parent("document:guide"), parent("document:legacy")]);
    const after = index(B, documents, [parent("document:guide"), parent("document:legacy")]);
    const changedBefore = entity("entity:changed", "concept", "document:guide");
    const changedAfter = { ...changedBefore, label: "Changed concept" };
    const removed = entity("entity:removed", "user-job", "document:legacy");
    const result = coordinateDocumentationImpact({
      mode: "incremental",
      before,
      after,
      policy: policy(),
      beforeOntology: createArtifact(
        "ontology",
        {
          entities: [changedBefore, removed],
          relationships: [],
        },
        { index: before },
      ),
      afterOntology: createArtifact(
        "ontology",
        {
          entities: [changedAfter],
          relationships: [],
        },
        { index: after },
      ),
      classification: createImpactClassificationDiagnostics({
        schemaVersion: 1,
        beforeRepository: {
          ...before.repository,
          indexDigest: before.indexDigest,
        },
        afterRepository: {
          ...after.repository,
          indexDigest: after.indexDigest,
        },
        newContentTypeNodeIds: [],
        duplicateKnowledge: [],
      }),
    });

    expect(result.analysis.changedPaths).toEqual([]);
    for (const nodeId of ["document:guide", "document:legacy"]) {
      expect(result.analysis.neighborhood.find((entry) => entry.nodeId === nodeId)).toMatchObject({
        regions: ["semantic-context"],
        reasons: ["ontology-entity"],
      });
    }
  });
});

function coordinate(
  before: ContentIndexV1,
  after: ContentIndexV1,
  addedEntities: OntologyEntity[],
  newContentTypeNodeIds: string[],
  duplicateKnowledge: Array<{ canonicalNodeId: string; duplicateNodeIds: string[] }>,
  canonicalHomeByNodeId: Record<string, string> = {},
) {
  return coordinateDocumentationImpact({
    mode: "incremental",
    before,
    after,
    policy: policy(),
    beforeOntology: createArtifact(
      "ontology",
      { entities: [], relationships: [] },
      { index: before },
    ),
    afterOntology: createArtifact(
      "ontology",
      {
        entities: addedEntities,
        relationships: [],
      },
      { index: after },
    ),
    classification: createImpactClassificationDiagnostics({
      schemaVersion: 1,
      beforeRepository: binding(before),
      afterRepository: binding(after),
      newContentTypeNodeIds,
      duplicateKnowledge,
    }),
    canonicalHomeByNodeId,
  });
}

function policy() {
  return {
    id: DEFAULT_HEALING_POLICY.id,
    version: DEFAULT_HEALING_POLICY.version,
    digest: DEFAULT_HEALING_POLICY.digest,
  };
}

function binding(indexValue: ContentIndexV1) {
  return {
    revision: indexValue.repository.revision,
    contentDigest: indexValue.repository.contentDigest,
    indexDigest: indexValue.indexDigest,
  };
}

function index(revision: string, nodes: DocumentNode[], edges: StructuralEdge[]): ContentIndexV1 {
  const seed = revision === A ? "3" : "4";
  return {
    schemaVersion: 1,
    repository: { revision, contentDigest: seed.repeat(64) },
    indexDigest: (revision === A ? "5" : "6").repeat(64),
    nodes,
    edges,
    evidence: {
      repositoryRevision: revision,
      contentDigest: seed.repeat(64),
      indexDigest: (revision === A ? "5" : "6").repeat(64),
      documentCount: nodes.length,
      sectionCount: 0,
      edgeCount: edges.length,
    },
  };
}

function document(id: string, sourcePath: string, seed: string): DocumentNode {
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
    regions: regions(seed),
  };
}

function regions(seed: string): DocumentNode["regions"] {
  const digest = seed.repeat(64);
  return { body: digest, headings: digest, metadata: digest, navigation: digest, graph: digest };
}

function parent(child: string): StructuralEdge {
  return { kind: "parent", from: child, to: "document:home" };
}

function entity(id: string, kind: "user-job" | "concept", nodeId: string): OntologyEntity {
  return {
    id,
    label: id,
    kind,
    evidence: [
      {
        path:
          nodeId === "document:home"
            ? "docs/index.md"
            : `docs/${nodeId.slice("document:".length)}.md`,
        nodeId,
      },
    ],
  };
}
