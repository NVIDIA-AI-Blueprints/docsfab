// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ArtifactEnvelope,
  ArtifactKind,
  ArtifactReference,
} from "../../artifacts/contracts.js";
import type { ContextPathSummary, ContextSemanticSummary } from "../contracts.js";

export function artifactReference<K extends ArtifactKind>(
  artifact: ArtifactEnvelope<K>,
): ArtifactReference<K> {
  return {
    kind: artifact.kind,
    schemaVersion: 1,
    digest: artifact.digest,
    repositoryRevision: artifact.repository.revision,
    repositoryContentDigest: artifact.repository.contentDigest,
  };
}

export function referenceKey(reference: ArtifactReference): string {
  return `${reference.kind}\0${reference.digest}`;
}

export function edgeKey(edge: { kind: string; from: string; to: string }): string {
  return `${edge.kind}\0${edge.from}\0${edge.to}`;
}

export function pathKey(path: ContextPathSummary): string {
  return `${path.nodeIds.join("\0")}\x01${path.edgeKinds.join("\0")}`;
}

export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function semanticSummary(
  payload: ArtifactEnvelope<"context-packet">["payload"],
): ContextSemanticSummary {
  return {
    targetNodeId: payload.targetNodeId,
    pageRole: structuredClone(payload.pageRole),
    belongsHere: uniqueSorted(payload.placementRules.belongsHere),
    belongsElsewhere: uniqueSorted(payload.placementRules.belongsElsewhere),
    canonicalHomeNodeIds: uniqueSorted([
      ...(payload.pageRole.canonicalParentId ? [payload.pageRole.canonicalParentId] : []),
      ...payload.relatedCanonicalPages,
    ]),
    activeDecisionIds: uniqueSorted(payload.activeDecisionIds),
  };
}
