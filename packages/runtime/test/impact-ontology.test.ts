// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { OntologyPayload } from "../src/artifacts/index.js";
import { diffOntologyPayloads } from "../src/impact/ontology.js";

describe("ontology impact delta", () => {
  it("derives new-job and new-concept signals with relationship pressure", () => {
    const before = ontology();
    const after = ontology();
    after.entities.push(
      entity("entity:job", "user-job", "document:guide"),
      entity("entity:concept", "concept", "document:concept"),
    );
    after.relationships.push({
      subject: "entity:job",
      predicate: "operates-on",
      object: "entity:concept",
      evidence: [{ path: "docs/guide.md", nodeId: "document:guide" }],
    });

    expect(diffOntologyPayloads(before, after)).toEqual({
      delta: {
        addedEntityIds: ["entity:concept", "entity:job"],
        removedEntityIds: [],
        changedEntityIds: ["entity:concept", "entity:job"],
        addedRelationshipCount: 1,
        removedRelationshipCount: 0,
      },
      semanticSignals: [
        { kind: "new-concept", targetNodeId: "document:concept", relatedNodeIds: [] },
        { kind: "new-job", targetNodeId: "document:guide", relatedNodeIds: [] },
      ],
      semanticContextNodeIds: ["document:concept", "document:guide"],
    });
  });

  it("is order-independent and reports removed relationships deterministically", () => {
    const before = ontology();
    before.entities.push(
      entity("entity:a", "concept", "document:a"),
      entity("entity:b", "concept", "document:b"),
    );
    before.relationships.push({
      subject: "entity:a",
      predicate: "part-of",
      object: "entity:b",
      evidence: [{ path: "docs/a.md", nodeId: "document:a" }],
    });
    const after = { entities: [...before.entities].reverse(), relationships: [] };

    const result = diffOntologyPayloads(before, after);
    expect(result.delta).toMatchObject({
      addedEntityIds: [],
      removedEntityIds: [],
      changedEntityIds: ["entity:a", "entity:b"],
      addedRelationshipCount: 0,
      removedRelationshipCount: 1,
    });
    expect(result.semanticContextNodeIds).toEqual(["document:a", "document:b"]);
  });

  it("projects changed and removed entity evidence from both ontology revisions", () => {
    const before = ontology();
    before.entities.push(
      entity("entity:changed", "concept", "document:old-context"),
      entity("entity:removed", "user-job", "document:removed-context"),
    );
    const changed = entity("entity:changed", "concept", "document:new-context");
    changed.label = "Updated concept";
    const after = { entities: [changed], relationships: [] };

    const result = diffOntologyPayloads(before, after);

    expect(result.delta).toMatchObject({
      removedEntityIds: ["entity:removed"],
      changedEntityIds: ["entity:changed"],
    });
    expect(result.semanticContextNodeIds).toEqual([
      "document:new-context",
      "document:old-context",
      "document:removed-context",
    ]);
  });
});

function ontology(): OntologyPayload {
  return { entities: [], relationships: [] };
}

function entity(id: string, kind: "user-job" | "concept", nodeId: string) {
  return {
    id,
    label: id,
    kind,
    evidence: [{ path: `docs/${nodeId.slice("document:".length)}.md`, nodeId }],
  };
}
