// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import {
  FoundationCanonContractError,
  decodeFoundationCanon,
  type FoundationCanonV1,
} from "./contracts.js";

export const FOUNDATION_CANON_EVIDENCE_DISPOSITIONS = ["current", "stale"] as const;
export type FoundationCanonEvidenceDisposition =
  (typeof FOUNDATION_CANON_EVIDENCE_DISPOSITIONS)[number];

export const FOUNDATION_CANON_STALE_REASONS = [
  "repository-identity-mismatch",
  "repository-revision-mismatch",
  "repository-content-digest-mismatch",
  "input-manifest-mismatch",
  "input-set-mismatch",
  "content-index-mismatch",
  "ontology-mismatch",
  "prior-canon-mismatch",
  "prior-canon-missing",
] as const;
export type FoundationCanonStaleReason = (typeof FOUNDATION_CANON_STALE_REASONS)[number];

export type FoundationCanonInvalidationErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required"
  | "stale-evidence";

export class FoundationCanonInvalidationError extends Error {
  public constructor(public readonly code: FoundationCanonInvalidationErrorCode) {
    super(`Foundation canon invalidation rejected: ${code}.`);
    this.name = "FoundationCanonInvalidationError";
  }
}

function fail(code: FoundationCanonInvalidationErrorCode): never {
  throw new FoundationCanonInvalidationError(code);
}

const kit = createContractKit({
  fail: fail as ContractFail<FoundationCanonInvalidationErrorCode>,
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

/**
 * Current evidence plus the Content IR / ontology digests recorded when the
 * canon artifact was persisted. Digests only — never raw sources or secrets.
 */
export interface FoundationCanonEvidenceSnapshotV1 {
  repository: {
    identitySha256: string;
    revision: string;
    contentDigestSha256: string;
  };
  inputManifestSha256: string;
  inputIds: string[];
  /** Currently observed Content IR index digest (null if unbound). */
  contentIndexDigestSha256: string | null;
  /** Currently observed ontology artifact digest (null if unbound). */
  ontologyArtifactDigestSha256: string | null;
  /** Digests sealed into the durable canon artifact at persist time. */
  boundContentIndexDigestSha256: string | null;
  boundOntologyArtifactDigestSha256: string | null;
  priorCanonSha256: string | null;
  priorCanonPresent: boolean;
}

export interface FoundationCanonFreshnessV1 {
  schemaVersion: 1;
  kind: "docsfab-foundation-canon-freshness";
  disposition: FoundationCanonEvidenceDisposition;
  reasons: FoundationCanonStaleReason[];
  canonSha256: string;
  freshnessSha256: string;
}

/**
 * Compare a decoded canon and its sealed overlay bindings to current evidence.
 * Drift yields an explicit stale disposition; use
 * {@link assertFoundationCanonCurrent} to fail closed.
 */
export function evaluateFoundationCanonFreshness(
  value: unknown,
  evidence: FoundationCanonEvidenceSnapshotV1,
): FoundationCanonFreshnessV1 {
  const canon = decodeOrFail(value);
  kit.assertInert(evidence);
  kit.rejectCredentials(evidence);
  const snapshot = normalizeEvidence(evidence);
  const reasons = new Set<FoundationCanonStaleReason>();
  if (snapshot.repository.identitySha256 !== canon.repository.identitySha256) {
    reasons.add("repository-identity-mismatch");
  }
  if (snapshot.repository.revision !== canon.repository.revision) {
    reasons.add("repository-revision-mismatch");
  }
  if (snapshot.repository.contentDigestSha256 !== canon.repository.contentDigestSha256) {
    reasons.add("repository-content-digest-mismatch");
  }
  if (snapshot.inputManifestSha256 !== canon.inputBinding.manifestSha256) {
    reasons.add("input-manifest-mismatch");
  }
  if (!sameIdSet(snapshot.inputIds, canon.inputBinding.inputIds)) {
    reasons.add("input-set-mismatch");
  }
  if (snapshot.contentIndexDigestSha256 !== snapshot.boundContentIndexDigestSha256) {
    reasons.add("content-index-mismatch");
  }
  if (snapshot.ontologyArtifactDigestSha256 !== snapshot.boundOntologyArtifactDigestSha256) {
    reasons.add("ontology-mismatch");
  }
  if (canon.supersession !== null) {
    if (!snapshot.priorCanonPresent) reasons.add("prior-canon-missing");
    if (snapshot.priorCanonSha256 !== canon.supersession.supersedesCanonSha256) {
      reasons.add("prior-canon-mismatch");
    }
  }
  const sorted = [...reasons].sort(kit.compare);
  return kit.seal("docsfab-foundation-canon-freshness", "freshnessSha256", {
    disposition: sorted.length === 0 ? "current" : "stale",
    reasons: sorted,
    canonSha256: canon.canonSha256,
  }) as FoundationCanonFreshnessV1;
}

/** Fail closed unless the canon is current for the supplied evidence. */
export function assertFoundationCanonCurrent(
  value: unknown,
  evidence: FoundationCanonEvidenceSnapshotV1,
): FoundationCanonFreshnessV1 {
  const freshness = evaluateFoundationCanonFreshness(value, evidence);
  if (freshness.disposition !== "current") fail("stale-evidence");
  return freshness;
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

function normalizeEvidence(
  value: FoundationCanonEvidenceSnapshotV1,
): FoundationCanonEvidenceSnapshotV1 {
  const root = kit.object(value);
  kit.exact(root, [
    "repository",
    "inputManifestSha256",
    "inputIds",
    "contentIndexDigestSha256",
    "ontologyArtifactDigestSha256",
    "boundContentIndexDigestSha256",
    "boundOntologyArtifactDigestSha256",
    "priorCanonSha256",
    "priorCanonPresent",
  ]);
  const repository = kit.object(root.repository);
  kit.exact(repository, ["identitySha256", "revision", "contentDigestSha256"]);
  if (typeof root.priorCanonPresent !== "boolean") fail("invalid-value");
  return {
    repository: {
      identitySha256: kit.hash(repository.identitySha256),
      revision: kit.revision(repository.revision),
      contentDigestSha256: kit.hash(repository.contentDigestSha256),
    },
    inputManifestSha256: kit.hash(root.inputManifestSha256),
    inputIds: kit.array(root.inputIds).map(kit.identifier).sort(kit.compare),
    contentIndexDigestSha256: nullableHash(root.contentIndexDigestSha256),
    ontologyArtifactDigestSha256: nullableHash(root.ontologyArtifactDigestSha256),
    boundContentIndexDigestSha256: nullableHash(root.boundContentIndexDigestSha256),
    boundOntologyArtifactDigestSha256: nullableHash(root.boundOntologyArtifactDigestSha256),
    priorCanonSha256: nullableHash(root.priorCanonSha256),
    priorCanonPresent: root.priorCanonPresent,
  };
}

function nullableHash(value: unknown): string | null {
  if (value === null) return null;
  return kit.hash(value);
}

function sameIdSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
