// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { ArtifactValidationError } from "./contracts.js";

const SET_LIKE_ARRAY_FIELDS = new Set([
  "entities",
  "relationships",
  "evidence",
  "secondaryAxes",
  "relatedCanonicalPages",
  "belongsHere",
  "belongsElsewhere",
  "activeDecisionIds",
  "rejectedCandidates",
  "openDecisions",
  "policyBindings",
  "changedPaths",
  "structuralRegions",
  "addedEntityIds",
  "removedEntityIds",
  "changedEntityIds",
  "affectedNodeIds",
  "targetNodeIds",
  "outputPaths",
  "expectedNodeIds",
  "acceptableNodeIds",
  "blockingDiagnosticDigests",
  "tasks",
  "results",
  "consultedNodeIds",
  "decisionIds",
  "plannedPages",
  "migrationDispositions",
  "destinationPaths",
  "relatedNodeIds",
  "evidenceRefs",
  "limitations",
]);

function compareCanonical(left: unknown, right: unknown): number {
  const leftValue = JSON.stringify(left);
  const rightValue = JSON.stringify(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function canonicalValue(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
  parentField?: string,
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ArtifactValidationError("invalid-json", path);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw new ArtifactValidationError("invalid-json", path);
  }
  if (seen.has(value)) {
    throw new ArtifactValidationError("invalid-json", path);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) {
        throw new ArtifactValidationError("invalid-json", path);
      }
      const entries = value.map((item, index) => canonicalValue(item, `${path}[${index}]`, seen));
      return SET_LIKE_ARRAY_FIELDS.has(parentField ?? "")
        ? entries.sort(compareCanonical)
        : entries;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new ArtifactValidationError("invalid-json", path);
    }
    if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) {
      throw new ArtifactValidationError("invalid-json", path);
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonicalValue(child, `${path}.${key}`, seen, key)]),
    );
  } finally {
    seen.delete(value);
  }
}

export function canonicalArtifactJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value, "$", new WeakSet<object>()));
}

export function canonicalArtifactDigest(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ArtifactValidationError("invalid-type", "$");
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ArtifactValidationError("invalid-json", "$");
  }
  const { digest: _digest, ...digestible } = value as Record<string, unknown>;
  return createHash("sha256").update(canonicalArtifactJson(digestible)).digest("hex");
}
