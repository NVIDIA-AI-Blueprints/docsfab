// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { validateArtifact, type ArtifactEnvelope } from "../artifacts/index.js";
import { canonicalDigest, type ContentIndexV1 } from "../content-ir/index.js";
import {
  analyzeDocumentationImpact,
  type AnalyzeDocumentationImpactInput,
  type SemanticImpactSignal,
} from "./analyze.js";
import {
  createImpactAnalysis,
  type ImpactAnalysis,
  type ImpactRepositoryBinding,
} from "./contracts.js";
import { diffOntologyPayloads, type OntologyImpactDelta } from "./ontology.js";
import { compareText } from "../shared/primitives.js";

export interface DuplicateKnowledgeDiagnostic {
  canonicalNodeId: string;
  duplicateNodeIds: string[];
}

export interface ImpactClassificationDiagnostics {
  schemaVersion: 1;
  beforeRepository: ImpactRepositoryBinding;
  afterRepository: ImpactRepositoryBinding;
  newContentTypeNodeIds: string[];
  duplicateKnowledge: DuplicateKnowledgeDiagnostic[];
  digest: string;
}

export interface CoordinateDocumentationImpactInput
  extends Omit<AnalyzeDocumentationImpactInput, "semanticSignals"> {
  beforeOntology: ArtifactEnvelope<"ontology">;
  afterOntology: ArtifactEnvelope<"ontology">;
  classification: ImpactClassificationDiagnostics;
}

export interface CoordinatedDocumentationImpact {
  analysis: ImpactAnalysis;
  ontology: OntologyImpactDelta;
}

export function createImpactClassificationDiagnostics(
  value: Omit<ImpactClassificationDiagnostics, "digest">,
): ImpactClassificationDiagnostics {
  const parsed = parseClassification(value);
  return { ...parsed, digest: canonicalDigest(parsed) };
}

/**
 * Resolve every semantic expansion from revision-bound ontology artifacts and
 * content-addressed deterministic diagnostics before invoking the analyzer.
 */
export function coordinateDocumentationImpact(
  input: CoordinateDocumentationImpactInput,
): CoordinatedDocumentationImpact {
  const beforeOntology = validatedOntology(input.beforeOntology, input.before);
  const afterOntology = validatedOntology(input.afterOntology, input.after);
  const classification = validateClassification(input.classification);
  if (
    !matches(classification.beforeRepository, input.before) ||
    !matches(classification.afterRepository, input.after)
  ) {
    throw new Error("Impact classification diagnostics do not match the supplied indexes.");
  }
  const afterNodes = new Set(input.after.nodes.map((node) => node.id));
  const classificationNodes = [
    ...classification.newContentTypeNodeIds,
    ...classification.duplicateKnowledge.flatMap((group) => [
      group.canonicalNodeId,
      ...group.duplicateNodeIds,
    ]),
  ];
  if (classificationNodes.some((nodeId) => !afterNodes.has(nodeId))) {
    throw new Error("Impact classification diagnostics contain an unknown node.");
  }
  const ontology = diffOntologyPayloads(beforeOntology.payload, afterOntology.payload);
  const semanticSignals: SemanticImpactSignal[] = [
    ...ontology.semanticSignals,
    ...classification.newContentTypeNodeIds.map((nodeId) => ({
      kind: "new-content-type" as const,
      targetNodeId: nodeId,
      relatedNodeIds: [],
    })),
    ...classification.duplicateKnowledge.map((group) => ({
      kind: "duplicate-knowledge" as const,
      targetNodeId: group.canonicalNodeId,
      relatedNodeIds: group.duplicateNodeIds,
    })),
  ];
  const {
    beforeOntology: _beforeOntology,
    afterOntology: _afterOntology,
    classification: _classification,
    ...analysisInput
  } = input;
  const analysis = analyzeDocumentationImpact({ ...analysisInput, semanticSignals });
  return {
    analysis: addOntologySemanticContext(analysis, ontology.semanticContextNodeIds),
    ontology,
  };
}

function addOntologySemanticContext(
  analysis: ImpactAnalysis,
  nodeIds: readonly string[],
): ImpactAnalysis {
  if (nodeIds.length === 0) return analysis;
  const neighborhood = new Map(
    analysis.neighborhood.map((entry) => [
      entry.nodeId,
      {
        regions: new Set(entry.regions),
        reasons: new Set(entry.reasons),
      },
    ]),
  );
  for (const nodeId of nodeIds) {
    const entry = neighborhood.get(nodeId) ?? { regions: new Set(), reasons: new Set() };
    entry.regions.add("semantic-context");
    entry.reasons.add("ontology-entity");
    neighborhood.set(nodeId, entry);
  }
  const { digest: _digest, ...digestible } = analysis;
  return createImpactAnalysis({
    ...digestible,
    neighborhood: [...neighborhood].map(([nodeId, entry]) => ({
      nodeId,
      regions: [...entry.regions],
      reasons: [...entry.reasons],
    })),
  });
}

function validatedOntology(
  artifact: ArtifactEnvelope<"ontology">,
  index: ContentIndexV1,
): ArtifactEnvelope<"ontology"> {
  const validated = validateArtifact(artifact, { index });
  if (validated.kind !== "ontology") throw new Error("Expected an ontology artifact.");
  return validated;
}

function validateClassification(value: ImpactClassificationDiagnostics) {
  const parsed = parseClassification(value);
  if (
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.digest) ||
    canonicalDigest(parsed) !== value.digest
  ) {
    throw new Error("Impact classification diagnostics digest is invalid.");
  }
  return parsed;
}

function parseClassification(
  value: Omit<ImpactClassificationDiagnostics, "digest"> | ImpactClassificationDiagnostics,
): Omit<ImpactClassificationDiagnostics, "digest"> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.newContentTypeNodeIds) ||
    !Array.isArray(value.duplicateKnowledge)
  ) {
    throw new Error("Impact classification diagnostics are invalid.");
  }
  const allowed = new Set([
    "schemaVersion",
    "beforeRepository",
    "afterRepository",
    "newContentTypeNodeIds",
    "duplicateKnowledge",
    "digest",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("Impact classification diagnostics contain unknown fields.");
  }
  const newContentTypeNodeIds = sortedIds(value.newContentTypeNodeIds);
  const duplicateKnowledge = value.duplicateKnowledge
    .map((group) => {
      if (
        !group ||
        typeof group !== "object" ||
        Array.isArray(group) ||
        Object.keys(group).sort().join(",") !== "canonicalNodeId,duplicateNodeIds" ||
        typeof group.canonicalNodeId !== "string" ||
        !Array.isArray(group.duplicateNodeIds)
      ) {
        throw new Error("Duplicate-knowledge diagnostics are invalid.");
      }
      const duplicateNodeIds = sortedIds(group.duplicateNodeIds);
      if (duplicateNodeIds.length === 0 || duplicateNodeIds.includes(group.canonicalNodeId)) {
        throw new Error("Duplicate-knowledge diagnostics are invalid.");
      }
      return { canonicalNodeId: group.canonicalNodeId, duplicateNodeIds };
    })
    .sort((left, right) => compareText(left.canonicalNodeId, right.canonicalNodeId));
  if (
    new Set(duplicateKnowledge.map((group) => group.canonicalNodeId)).size !==
    duplicateKnowledge.length
  ) {
    throw new Error("Duplicate-knowledge diagnostics contain duplicates.");
  }
  return {
    schemaVersion: 1,
    beforeRepository: repository(value.beforeRepository),
    afterRepository: repository(value.afterRepository),
    newContentTypeNodeIds,
    duplicateKnowledge,
  };
}

function sortedIds(values: readonly unknown[]): string[] {
  if (values.some((value) => typeof value !== "string" || !value || /\s/u.test(value))) {
    throw new Error("Impact classification node IDs are invalid.");
  }
  const sorted = [...values] as string[];
  sorted.sort(compareText);
  if (new Set(sorted).size !== sorted.length) {
    throw new Error("Impact classification node IDs contain duplicates.");
  }
  return sorted;
}

function fullRevision(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}

function repository(value: unknown): ImpactRepositoryBinding {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "contentDigest,indexDigest,revision"
  ) {
    throw new Error("Impact classification repository binding is invalid.");
  }
  const binding = value as Record<string, unknown>;
  if (
    !fullRevision(binding.revision) ||
    typeof binding.contentDigest !== "string" ||
    typeof binding.indexDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(binding.contentDigest) ||
    !/^[a-f0-9]{64}$/u.test(binding.indexDigest)
  ) {
    throw new Error("Impact classification repository binding is invalid.");
  }
  return {
    revision: binding.revision,
    contentDigest: binding.contentDigest,
    indexDigest: binding.indexDigest,
  };
}

function matches(binding: ImpactRepositoryBinding, index: ContentIndexV1): boolean {
  return (
    binding.revision === index.repository.revision &&
    binding.contentDigest === index.repository.contentDigest &&
    binding.indexDigest === index.indexDigest
  );
}
