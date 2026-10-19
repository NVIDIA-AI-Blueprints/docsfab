// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createArtifact,
  validateArtifact,
  type ArtifactEvidence,
  type ArtifactEnvelope,
} from "../artifacts/index.js";
import type { ContentIndexV1, StructuralChangeRegion } from "../content-ir/index.js";
import { validateImpactAnalysis, type ImpactAnalysis } from "./contracts.js";
import { evaluateHealingPolicy, type HealingPolicy, type HealingPolicyInput } from "./policy.js";
import { diffOntologyPayloads } from "./ontology.js";

export interface CreateImpactReportArtifactInput {
  analysis: ImpactAnalysis;
  policy: HealingPolicy;
  beforeIndex: ContentIndexV1;
  afterIndex: ContentIndexV1;
  beforeOntology: ArtifactEnvelope<"ontology">;
  afterOntology: ArtifactEnvelope<"ontology">;
  policyInput: HealingPolicyInput;
  evidence: ArtifactEvidence[];
}

/**
 * Adapt the richer deterministic impact projection into DocsFab's versioned
 * artifact envelope without weakening either revision or policy binding.
 */
export function createImpactReportArtifact(
  input: CreateImpactReportArtifactInput,
): ArtifactEnvelope<"impact-report"> {
  const analysis = validateImpactAnalysis(input.analysis);
  assertIndexBinding(analysis, input.beforeIndex, input.afterIndex);
  const decision = evaluateHealingPolicy(input.policyInput, input.policy);
  if (
    decision.policy.id !== analysis.policy.id ||
    decision.policy.version !== analysis.policy.version ||
    decision.policy.digest !== analysis.policy.digest
  ) {
    throw new Error("Impact policy decision does not match the analysis binding.");
  }
  const structuralRegions = analysis.changedRegions.filter(
    (region): region is StructuralChangeRegion => region !== "semantic-context",
  );
  const reasons = new Set(analysis.neighborhood.flatMap((entry) => entry.reasons));
  const beforeOntology = validateArtifact(input.beforeOntology, {
    index: input.beforeIndex,
  });
  const afterOntology = validateArtifact(input.afterOntology, {
    index: input.afterIndex,
  });
  if (beforeOntology.kind !== "ontology" || afterOntology.kind !== "ontology") {
    throw new Error("Impact artifact adapter requires ontology artifacts.");
  }
  const ontologyDelta = diffOntologyPayloads(beforeOntology.payload, afterOntology.payload).delta;
  const semanticEntries = analysis.neighborhood.filter((entry) =>
    entry.regions.includes("semantic-context"),
  );
  const hasMaterialSemanticChange =
    ontologyDelta.addedEntityIds.length > 0 ||
    ontologyDelta.removedEntityIds.length > 0 ||
    ontologyDelta.changedEntityIds.length > 0 ||
    ontologyDelta.addedRelationshipCount > 0 ||
    ontologyDelta.removedRelationshipCount > 0 ||
    ["new-job", "new-concept", "new-content-type", "duplicate-knowledge", "ontology-entity"].some(
      (reason) => reasons.has(reason as never),
    );
  const navigationPressure = reasons.has("sibling-pressure")
    ? "critical"
    : analysis.neighborhood.some((entry) => entry.regions.includes("navigation"))
      ? "elevated"
      : "healthy";
  const semanticImpact =
    semanticEntries.length === 0
      ? "none"
      : hasMaterialSemanticChange || semanticEntries.length > 3
        ? "cross-cutting"
        : "localized";

  return createArtifact(
    "impact-report",
    {
      beforeRepository: input.beforeIndex.repository,
      afterRepository: input.afterIndex.repository,
      beforeIndexDigest: input.beforeIndex.indexDigest,
      afterIndexDigest: input.afterIndex.indexDigest,
      changedPaths: analysis.changedPaths,
      structuralRegions,
      ontologyDelta,
      affectedNodeIds: analysis.neighborhood.map((entry) => entry.nodeId),
      navigationPressure,
      semanticImpact,
      recommendedAction: decision.level,
      requiredApproval: decision.requiredApproval,
      evidence: input.evidence,
    },
    { index: input.afterIndex, beforeIndex: input.beforeIndex },
  );
}

function assertIndexBinding(
  analysis: ImpactAnalysis,
  before: ContentIndexV1,
  after: ContentIndexV1,
): void {
  const matches = (binding: ImpactAnalysis["beforeRepository"], index: ContentIndexV1) =>
    binding.revision === index.repository.revision &&
    binding.contentDigest === index.repository.contentDigest &&
    binding.indexDigest === index.indexDigest;
  if (!matches(analysis.beforeRepository, before) || !matches(analysis.afterRepository, after)) {
    throw new Error("Impact analysis does not match the supplied indexes.");
  }
}
