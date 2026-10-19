// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type OntologyDelta,
  type OntologyEntity,
  type OntologyPayload,
  type OntologyRelationship,
} from "../artifacts/index.js";
import { canonicalDigest } from "../content-ir/index.js";
import type { SemanticImpactSignal } from "./analyze.js";
import { compareText } from "../shared/primitives.js";

export interface OntologyImpactDelta {
  delta: OntologyDelta;
  semanticSignals: SemanticImpactSignal[];
  /** Before/after evidence nodes that require semantic-context reevaluation. */
  semanticContextNodeIds: string[];
}

/** Deterministically compare validated ontology payloads without model input. */
export function diffOntologyPayloads(
  before: OntologyPayload,
  after: OntologyPayload,
): OntologyImpactDelta {
  const beforeEntities = new Map(before.entities.map((entity) => [entity.id, entity]));
  const afterEntities = new Map(after.entities.map((entity) => [entity.id, entity]));
  const addedEntityIds: string[] = [];
  const removedEntityIds: string[] = [];
  const changedEntityIds = new Set<string>();
  const semanticSignals: SemanticImpactSignal[] = [];
  const semanticContextNodeIds = new Set<string>();

  for (const id of sortedUnion(beforeEntities.keys(), afterEntities.keys())) {
    const left = beforeEntities.get(id);
    const right = afterEntities.get(id);
    if (!left) {
      addedEntityIds.push(id);
      const signal = addedEntitySignal(right!);
      if (signal) semanticSignals.push(signal);
    } else if (!right) {
      removedEntityIds.push(id);
      addEvidenceNodes(semanticContextNodeIds, left);
    } else if (canonicalDigest(left) !== canonicalDigest(right)) {
      changedEntityIds.add(id);
      addEvidenceNodes(semanticContextNodeIds, left);
      addEvidenceNodes(semanticContextNodeIds, right);
    }
  }

  const beforeRelationships = relationshipMap(before.relationships);
  const afterRelationships = relationshipMap(after.relationships);
  const addedRelationships = [...afterRelationships.keys()]
    .filter((key) => !beforeRelationships.has(key))
    .sort(compareText);
  const removedRelationships = [...beforeRelationships.keys()]
    .filter((key) => !afterRelationships.has(key))
    .sort(compareText);
  for (const key of [...addedRelationships, ...removedRelationships]) {
    const beforeRelationship = beforeRelationships.get(key);
    const afterRelationship = afterRelationships.get(key);
    const relationship = afterRelationship ?? beforeRelationship!;
    changedEntityIds.add(relationship.subject);
    changedEntityIds.add(relationship.object);
    addRelationshipEvidenceNodes(semanticContextNodeIds, beforeRelationship);
    addRelationshipEvidenceNodes(semanticContextNodeIds, afterRelationship);
    for (const entityId of [relationship.subject, relationship.object]) {
      addEvidenceNodes(semanticContextNodeIds, beforeEntities.get(entityId));
      addEvidenceNodes(semanticContextNodeIds, afterEntities.get(entityId));
    }
  }

  return {
    delta: {
      addedEntityIds,
      removedEntityIds,
      changedEntityIds: [...changedEntityIds].sort(compareText),
      addedRelationshipCount: addedRelationships.length,
      removedRelationshipCount: removedRelationships.length,
    },
    semanticSignals: semanticSignals.sort((left, right) =>
      compareText(`${left.kind}\0${left.targetNodeId}`, `${right.kind}\0${right.targetNodeId}`),
    ),
    semanticContextNodeIds: [...semanticContextNodeIds].sort(compareText),
  };
}

function addEvidenceNodes(target: Set<string>, entity: OntologyEntity | undefined): void {
  for (const evidence of entity?.evidence ?? []) target.add(evidence.nodeId);
}

function addRelationshipEvidenceNodes(
  target: Set<string>,
  relationship: OntologyRelationship | undefined,
): void {
  for (const evidence of relationship?.evidence ?? []) target.add(evidence.nodeId);
}

function addedEntitySignal(entity: OntologyEntity): SemanticImpactSignal | undefined {
  const kind =
    entity.kind === "user-job" ? "new-job" : entity.kind === "concept" ? "new-concept" : undefined;
  if (!kind) return undefined;
  const nodeIds = [...new Set(entity.evidence.map((item) => item.nodeId))].sort(compareText);
  if (nodeIds.length === 0) return undefined;
  return {
    kind,
    targetNodeId: nodeIds[0]!,
    relatedNodeIds: nodeIds.slice(1),
  };
}

function relationshipMap(
  relationships: readonly OntologyRelationship[],
): Map<string, OntologyRelationship> {
  return new Map(
    relationships.map((relationship) => [
      `${relationship.subject}\0${relationship.predicate}\0${relationship.object}`,
      relationship,
    ]),
  );
}

function sortedUnion(left: Iterable<string>, right: Iterable<string>): string[] {
  return [...new Set([...left, ...right])].sort(compareText);
}
