// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  diffContentIndexes,
  type ContentIndexV1,
  type DocumentNode,
  type StructuralChangeRegion,
  type StructuralEdge,
} from "../content-ir/index.js";
import {
  createImpactAnalysis,
  IMPACT_CHANGE_REGIONS,
  IMPACT_REASONS,
  type ImpactAnalysis,
  type ImpactAnalysisMode,
  type ImpactChangeRegion,
  type ImpactNeighborhoodEntry,
  type ImpactPolicyBinding,
  type ImpactReason,
} from "./contracts.js";
import { compareText } from "../shared/primitives.js";

export const SEMANTIC_CHANGE_KINDS = [
  "new-job",
  "new-concept",
  "new-content-type",
  "duplicate-knowledge",
] as const;
export type SemanticChangeKind = (typeof SEMANTIC_CHANGE_KINDS)[number];

export interface SemanticImpactSignal {
  kind: SemanticChangeKind;
  targetNodeId: string;
  relatedNodeIds: string[];
}

export interface ImpactNavigationScenario {
  id: string;
  nodeIds: string[];
}

export interface AnalyzeDocumentationImpactInput {
  mode: ImpactAnalysisMode;
  before: ContentIndexV1;
  after: ContentIndexV1;
  policy: ImpactPolicyBinding;
  beforeWordCounts?: Readonly<Record<string, number>>;
  afterWordCounts?: Readonly<Record<string, number>>;
  semanticSignals?: readonly SemanticImpactSignal[];
  canonicalHomeByNodeId?: Readonly<Record<string, string>>;
  navigationScenarios?: readonly ImpactNavigationScenario[];
  siblingPressureThreshold?: number;
}

interface MutableNeighborhoodEntry {
  regions: Set<ImpactChangeRegion>;
  reasons: Set<ImpactReason>;
}

/**
 * Compute one deterministic affected neighborhood for both incremental and
 * scheduled full-corpus evaluation. Full mode evaluates every node internally,
 * while the report intentionally retains only the affected neighborhood so
 * its result can be compared directly with incremental mode.
 */
export function analyzeDocumentationImpact(input: AnalyzeDocumentationImpactInput): ImpactAnalysis {
  validateInput(input);
  const diff = diffContentIndexes(input.before, input.after);
  const beforeDocuments = documents(input.before);
  const afterDocuments = documents(input.after);
  const nodes = new Set([
    ...input.before.nodes.map((node) => node.id),
    ...input.after.nodes.map((node) => node.id),
  ]);
  const neighborhood = new Map<string, MutableNeighborhoodEntry>();
  const edges = [...input.before.edges, ...input.after.edges];
  const threshold = input.siblingPressureThreshold ?? 8;
  const pressureSeeds = new Set<string>();

  for (const change of diff.documents) {
    pressureSeeds.add(change.documentId);
    add(neighborhood, change.documentId, toImpactRegions(change.regions), ["direct-change"]);
    add(neighborhood, change.documentId, ["semantic-context"], ["direct-change"]);

    const related = structuralFamily(change.documentId, edges);
    for (const parent of related.parents) {
      add(neighborhood, parent, ["semantic-context"], ["parent"]);
    }
    for (const sibling of related.siblings) {
      add(neighborhood, sibling, ["semantic-context"], ["sibling"]);
    }

    const structuralRegions = change.regions.filter((region) => region !== "body");
    if (structuralRegions.length > 0) {
      const invalidated = toImpactRegions(structuralRegions);
      for (const parent of related.parents) add(neighborhood, parent, invalidated, ["parent"]);
      for (const sibling of related.siblings) add(neighborhood, sibling, invalidated, ["sibling"]);
    }

    const beforeWords = input.beforeWordCounts?.[change.documentId];
    const afterWords = input.afterWordCounts?.[change.documentId];
    if (
      beforeWords !== undefined &&
      afterWords !== undefined &&
      Math.abs(afterWords - beforeWords) >= 400
    ) {
      add(neighborhood, change.documentId, ["body", "semantic-context"], ["word-growth-signal"]);
    }
  }

  for (const signal of input.semanticSignals ?? []) {
    pressureSeeds.add(signal.targetNodeId);
    add(neighborhood, signal.targetNodeId, ["semantic-context"], [signal.kind]);
    for (const related of signal.relatedNodeIds) {
      pressureSeeds.add(related);
      add(neighborhood, related, ["semantic-context"], ["ontology-entity"]);
    }
    const home = input.canonicalHomeByNodeId?.[signal.targetNodeId];
    if (home) add(neighborhood, home, ["semantic-context", "navigation"], ["canonical-home"]);
  }

  expandCurrentSiblingPressure(neighborhood, pressureSeeds, edges, input.after.edges, threshold);

  const navigationRelevant = [...neighborhood.values()].some(
    (entry) =>
      entry.regions.has("navigation") ||
      [...entry.reasons].some(
        (reason) =>
          reason === "new-job" ||
          reason === "new-concept" ||
          reason === "new-content-type" ||
          reason === "duplicate-knowledge",
      ),
  );
  if (navigationRelevant) {
    for (const scenario of input.navigationScenarios ?? []) {
      if (scenario.nodeIds.some((nodeId) => neighborhood.has(nodeId))) {
        for (const nodeId of scenario.nodeIds) {
          add(neighborhood, nodeId, ["navigation"], ["navigation-scenario"]);
        }
      }
    }
  }

  // Scheduled full mode reevaluates corpus-wide structural pressure, while
  // emitting the same affected projection shape used by incremental mode.
  if (input.mode === "full") {
    const parents = new Set<string>();
    for (const edge of input.after.edges) {
      if (edge.kind === "child") parents.add(edge.from);
      if (edge.kind === "parent") parents.add(edge.to);
    }
    for (const parent of parents) {
      const childIds = children(parent, input.after.edges);
      if (childIds.length > threshold) {
        add(neighborhood, parent, ["navigation", "graph"], ["sibling-pressure"]);
        for (const child of childIds) {
          add(neighborhood, child, ["navigation", "graph"], ["sibling-pressure"]);
        }
      }
    }
  }

  return createImpactAnalysis({
    schemaVersion: 1,
    mode: input.mode,
    beforeRepository: repositoryBinding(input.before),
    afterRepository: repositoryBinding(input.after),
    changedPaths: diff.documents.flatMap((change) => [
      ...(change.previousSourcePath ? [change.previousSourcePath] : []),
      change.sourcePath,
    ]),
    changedRegions: toImpactRegions(diff.regions),
    neighborhood: serializeNeighborhood(neighborhood),
    policy: input.policy,
  });
}

function validateInput(input: AnalyzeDocumentationImpactInput): void {
  if (!input || !["incremental", "full"].includes(input.mode)) {
    throw new Error("Impact analysis mode is invalid.");
  }
  const threshold = input.siblingPressureThreshold ?? 8;
  if (!Number.isSafeInteger(threshold) || threshold < 1) {
    throw new Error("Sibling pressure threshold must be a positive integer.");
  }
  for (const [name, counts] of [
    ["beforeWordCounts", input.beforeWordCounts],
    ["afterWordCounts", input.afterWordCounts],
  ] as const) {
    for (const [nodeId, count] of Object.entries(counts ?? {})) {
      if (!nodeId || !Number.isSafeInteger(count) || count < 0) {
        throw new Error(`${name} contains an invalid word count.`);
      }
    }
  }
  for (const signal of input.semanticSignals ?? []) {
    if (
      !SEMANTIC_CHANGE_KINDS.includes(signal.kind) ||
      !signal.targetNodeId ||
      new Set(signal.relatedNodeIds).size !== signal.relatedNodeIds.length
    ) {
      throw new Error("Semantic impact signal is invalid.");
    }
  }
  for (const scenario of input.navigationScenarios ?? []) {
    if (
      !scenario.id ||
      scenario.nodeIds.length === 0 ||
      new Set(scenario.nodeIds).size !== scenario.nodeIds.length
    ) {
      throw new Error("Impact navigation scenario is invalid.");
    }
  }
}

function repositoryBinding(index: ContentIndexV1) {
  return {
    revision: index.repository.revision,
    contentDigest: index.repository.contentDigest,
    indexDigest: index.indexDigest,
  };
}

function documents(index: ContentIndexV1): Map<string, DocumentNode> {
  return new Map(
    index.nodes
      .filter((node): node is DocumentNode => node.kind === "document")
      .map((node) => [node.id, node]),
  );
}

function structuralFamily(nodeId: string, edges: readonly StructuralEdge[]) {
  const parents = new Set<string>();
  for (const edge of edges) {
    if (edge.kind === "parent" && edge.from === nodeId) parents.add(edge.to);
    if (edge.kind === "child" && edge.to === nodeId) parents.add(edge.from);
  }
  const siblings = new Set<string>();
  for (const parent of parents) {
    for (const child of children(parent, edges)) if (child !== nodeId) siblings.add(child);
  }
  for (const edge of edges) {
    if (
      edge.from === nodeId &&
      (edge.kind === "previous-sibling" || edge.kind === "next-sibling")
    ) {
      siblings.add(edge.to);
    }
  }
  return { parents: [...parents].sort(compareText), siblings: [...siblings].sort(compareText) };
}

function children(parentId: string, edges: readonly StructuralEdge[]): string[] {
  const values = new Set<string>();
  for (const edge of edges) {
    if (edge.kind === "child" && edge.from === parentId) values.add(edge.to);
    if (edge.kind === "parent" && edge.to === parentId) values.add(edge.from);
  }
  return [...values].sort(compareText);
}

function expandCurrentSiblingPressure(
  neighborhood: Map<string, MutableNeighborhoodEntry>,
  seedNodeIds: Iterable<string>,
  relationEdges: readonly StructuralEdge[],
  currentEdges: readonly StructuralEdge[],
  threshold: number,
): void {
  const candidateParents = new Set<string>();
  for (const nodeId of seedNodeIds) {
    candidateParents.add(nodeId);
    for (const parent of structuralFamily(nodeId, relationEdges).parents) {
      candidateParents.add(parent);
    }
  }
  for (const parent of candidateParents) {
    const childIds = children(parent, currentEdges);
    if (childIds.length <= threshold) continue;
    add(neighborhood, parent, ["navigation", "graph"], ["sibling-pressure"]);
    for (const child of childIds) {
      add(neighborhood, child, ["navigation", "graph"], ["sibling-pressure"]);
    }
  }
}

function add(
  neighborhood: Map<string, MutableNeighborhoodEntry>,
  nodeId: string,
  regions: readonly ImpactChangeRegion[],
  reasons: readonly ImpactReason[],
): void {
  const entry = neighborhood.get(nodeId) ?? { regions: new Set(), reasons: new Set() };
  for (const region of regions) entry.regions.add(region);
  for (const reason of reasons) entry.reasons.add(reason);
  neighborhood.set(nodeId, entry);
}

function toImpactRegions(regions: readonly StructuralChangeRegion[]): ImpactChangeRegion[] {
  return IMPACT_CHANGE_REGIONS.filter(
    (region) => region !== "semantic-context" && regions.includes(region as StructuralChangeRegion),
  );
}

function serializeNeighborhood(
  neighborhood: Map<string, MutableNeighborhoodEntry>,
): ImpactNeighborhoodEntry[] {
  return [...neighborhood.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([nodeId, entry]) => ({
      nodeId,
      regions: IMPACT_CHANGE_REGIONS.filter((region) => entry.regions.has(region)),
      reasons: IMPACT_REASONS.filter((reason) => entry.reasons.has(reason)),
    }));
}
