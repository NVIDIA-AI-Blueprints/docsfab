// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import {
  FoundationCanonContractError,
  decodeFoundationCanon,
  type FoundationCanonAffectedArtifactV1,
  type FoundationCanonClaimV1,
  type FoundationCanonConflictV1,
  type FoundationCanonV1,
} from "./contracts.js";

export type FoundationCanonQueryErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required";

export class FoundationCanonQueryError extends Error {
  public constructor(public readonly code: FoundationCanonQueryErrorCode) {
    super(`Foundation canon query rejected: ${code}.`);
    this.name = "FoundationCanonQueryError";
  }
}

function fail(code: FoundationCanonQueryErrorCode): never {
  throw new FoundationCanonQueryError(code);
}

const kit = createContractKit({
  fail: fail as ContractFail<FoundationCanonQueryErrorCode>,
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

export interface FoundationCanonClaimIndexEntryV1 {
  id: string;
  claimSha256: string;
  confidence: FoundationCanonClaimV1["confidence"];
  verificationStatus: FoundationCanonClaimV1["verificationStatus"];
  applicabilitySha256: string;
  conflictGroupId: string | null;
  affectedArtifactIds: string[];
  evidenceIds: string[];
}

export interface FoundationCanonConflictIndexEntryV1 {
  id: string;
  conflictSha256: string;
  claimIds: string[];
  resolved: boolean;
}

export interface FoundationCanonGapIndexEntryV1 {
  kind: "unverified-claim" | "unresolved-conflict" | "superseded-claim";
  id: string;
}

export interface FoundationCanonAffectedDocumentIndexEntryV1 {
  id: string;
  path: string;
  digestSha256: string;
  claimIds: string[];
}

export interface FoundationCanonApplicabilityIndexEntryV1 {
  applicabilitySha256: string;
  claimIds: string[];
}

/** Deterministic, content-minimized query index over one canon version. */
export interface FoundationCanonQueryIndexV1 {
  schemaVersion: 1;
  kind: "docsfab-foundation-canon-query-index";
  canonId: string;
  version: string;
  canonSha256: string;
  claims: FoundationCanonClaimIndexEntryV1[];
  conflicts: FoundationCanonConflictIndexEntryV1[];
  gaps: FoundationCanonGapIndexEntryV1[];
  affectedDocuments: FoundationCanonAffectedDocumentIndexEntryV1[];
  applicability: FoundationCanonApplicabilityIndexEntryV1[];
  indexSha256: string;
}

/** Build a sealed query index. Ordering is deterministic; no raw source bodies. */
export function buildFoundationCanonQueryIndex(value: unknown): FoundationCanonQueryIndexV1 {
  const canon = decodeOrFail(value);
  const claims = canon.claims.map(claimEntry).sort((left, right) => kit.compare(left.id, right.id));
  const conflicts = canon.conflicts
    .map(conflictEntry)
    .sort((left, right) => kit.compare(left.id, right.id));
  const gaps = collectGaps(canon.claims, canon.conflicts);
  const affectedDocuments = collectAffected(canon);
  const applicability = collectApplicability(canon.claims);
  return kit.seal("docsfab-foundation-canon-query-index", "indexSha256", {
    canonId: canon.canonId,
    version: canon.version,
    canonSha256: canon.canonSha256,
    claims,
    conflicts,
    gaps,
    affectedDocuments,
    applicability,
  }) as FoundationCanonQueryIndexV1;
}

export function queryFoundationCanonClaims(
  value: unknown,
  filter: {
    verificationStatus?: FoundationCanonClaimV1["verificationStatus"];
    conflictGroupId?: string | null;
    applicabilitySha256?: string;
  } = {},
): FoundationCanonClaimIndexEntryV1[] {
  const index = buildFoundationCanonQueryIndex(value);
  return index.claims.filter((claim) => {
    if (
      filter.verificationStatus !== undefined &&
      claim.verificationStatus !== filter.verificationStatus
    ) {
      return false;
    }
    if (filter.conflictGroupId !== undefined && claim.conflictGroupId !== filter.conflictGroupId) {
      return false;
    }
    if (
      filter.applicabilitySha256 !== undefined &&
      claim.applicabilitySha256 !== filter.applicabilitySha256
    ) {
      return false;
    }
    return true;
  });
}

export function queryFoundationCanonConflicts(
  value: unknown,
): FoundationCanonConflictIndexEntryV1[] {
  return buildFoundationCanonQueryIndex(value).conflicts;
}

export function queryFoundationCanonGaps(value: unknown): FoundationCanonGapIndexEntryV1[] {
  return buildFoundationCanonQueryIndex(value).gaps;
}

export function queryFoundationCanonAffectedDocuments(
  value: unknown,
): FoundationCanonAffectedDocumentIndexEntryV1[] {
  return buildFoundationCanonQueryIndex(value).affectedDocuments;
}

export function queryFoundationCanonApplicability(
  value: unknown,
  applicabilitySha256?: string,
): FoundationCanonApplicabilityIndexEntryV1[] {
  const entries = buildFoundationCanonQueryIndex(value).applicability;
  if (applicabilitySha256 === undefined) return entries;
  const digest = kit.hash(applicabilitySha256);
  return entries.filter((entry) => entry.applicabilitySha256 === digest);
}

function claimEntry(claim: FoundationCanonClaimV1): FoundationCanonClaimIndexEntryV1 {
  return {
    id: claim.id,
    claimSha256: claim.claimSha256,
    confidence: claim.confidence,
    verificationStatus: claim.verificationStatus,
    applicabilitySha256: claim.applicabilitySha256,
    conflictGroupId: claim.conflictGroupId,
    affectedArtifactIds: [...claim.affectedArtifactIds],
    evidenceIds: [...claim.evidenceIds],
  };
}

function conflictEntry(conflict: FoundationCanonConflictV1): FoundationCanonConflictIndexEntryV1 {
  return {
    id: conflict.id,
    conflictSha256: conflict.conflictSha256,
    claimIds: [...conflict.claimIds],
    resolved: conflict.resolutionSha256 !== null,
  };
}

function collectGaps(
  claims: FoundationCanonClaimV1[],
  conflicts: FoundationCanonConflictV1[],
): FoundationCanonGapIndexEntryV1[] {
  const gaps: FoundationCanonGapIndexEntryV1[] = [];
  for (const claim of claims) {
    if (claim.verificationStatus === "unverified") {
      gaps.push({ kind: "unverified-claim", id: claim.id });
    }
    if (claim.supersededByClaimId !== null) {
      gaps.push({ kind: "superseded-claim", id: claim.id });
    }
  }
  for (const conflict of conflicts) {
    if (conflict.resolutionSha256 === null) {
      gaps.push({ kind: "unresolved-conflict", id: conflict.id });
    }
  }
  return gaps.sort((left, right) => {
    const byKind = kit.compare(left.kind, right.kind);
    return byKind !== 0 ? byKind : kit.compare(left.id, right.id);
  });
}

function collectAffected(canon: FoundationCanonV1): FoundationCanonAffectedDocumentIndexEntryV1[] {
  const claimIdsByArtifact = new Map<string, string[]>();
  for (const claim of canon.claims) {
    for (const artifactId of claim.affectedArtifactIds) {
      const list = claimIdsByArtifact.get(artifactId) ?? [];
      list.push(claim.id);
      claimIdsByArtifact.set(artifactId, list);
    }
  }
  return canon.affectedArtifacts
    .map((artifact: FoundationCanonAffectedArtifactV1) => ({
      id: artifact.id,
      path: artifact.path,
      digestSha256: artifact.digestSha256,
      claimIds: [...(claimIdsByArtifact.get(artifact.id) ?? [])].sort(kit.compare),
    }))
    .sort((left, right) => kit.compare(left.id, right.id));
}

function collectApplicability(
  claims: FoundationCanonClaimV1[],
): FoundationCanonApplicabilityIndexEntryV1[] {
  const map = new Map<string, string[]>();
  for (const claim of claims) {
    const list = map.get(claim.applicabilitySha256) ?? [];
    list.push(claim.id);
    map.set(claim.applicabilitySha256, list);
  }
  return [...map.entries()]
    .map(([applicabilitySha256, claimIds]) => ({
      applicabilitySha256,
      claimIds: [...claimIds].sort(kit.compare),
    }))
    .sort((left, right) => kit.compare(left.applicabilitySha256, right.applicabilitySha256));
}

function decodeOrFail(value: unknown): FoundationCanonV1 {
  try {
    return decodeFoundationCanon(value);
  } catch (error) {
    if (error instanceof FoundationCanonContractError) {
      fail(
        error.code === "migration-required"
          ? "migration-required"
          : error.code === "digest-mismatch"
            ? "digest-mismatch"
            : error.code === "credential-material"
              ? "credential-material"
              : error.code === "invalid-value"
                ? "invalid-value"
                : "invalid-shape",
      );
    }
    throw error;
  }
}
