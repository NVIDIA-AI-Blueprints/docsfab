// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  ArtifactStoreError,
  type ArtifactStoreWriteResult,
  type DurableArtifactStore,
} from "../artifacts/index.js";
import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import {
  FoundationCanonContractError,
  decodeFoundationCanon,
  migrateFoundationCanon,
  type FoundationCanonV1,
} from "./contracts.js";
import {
  FoundationCanonInvalidationError,
  assertFoundationCanonCurrent,
  evaluateFoundationCanonFreshness,
  type FoundationCanonEvidenceSnapshotV1,
  type FoundationCanonFreshnessV1,
} from "./invalidation.js";

export type FoundationCanonPersistenceErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required"
  | "not-found"
  | "integrity-mismatch"
  | "stale-evidence"
  | "store-rejected";

export class FoundationCanonPersistenceError extends Error {
  public constructor(public readonly code: FoundationCanonPersistenceErrorCode) {
    super(`Foundation canon persistence rejected: ${code}.`);
    this.name = "FoundationCanonPersistenceError";
  }
}

function fail(code: FoundationCanonPersistenceErrorCode): never {
  throw new FoundationCanonPersistenceError(code);
}

const kit = createContractKit({
  fail: fail as ContractFail<FoundationCanonPersistenceErrorCode>,
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

/**
 * Durable envelope stored through {@link DurableArtifactStore.putRecord}.
 * Identity remains `canon.canonSha256`; overlay digests bind Content IR and
 * ontology without rewriting closed FoundationCanonV1 shapes.
 */
export interface FoundationCanonStoredArtifactV1 {
  schemaVersion: 1;
  kind: "docsfab-foundation-canon-stored-artifact";
  canon: FoundationCanonV1;
  bindings: {
    contentIndexDigestSha256: string | null;
    ontologyArtifactDigestSha256: string | null;
  };
  storedArtifactSha256: string;
}

export interface FoundationCanonPersistBindingsV1 {
  contentIndexDigestSha256: string | null;
  ontologyArtifactDigestSha256: string | null;
}

export interface FoundationCanonLoadResultV1 {
  artifact: FoundationCanonStoredArtifactV1;
  freshness: FoundationCanonFreshnessV1;
}

/**
 * Persist a sealed canon version through the durable artifact store boundary.
 * Records are content-addressed by `canonSha256`, immutable after creation, and
 * migratable through {@link migrateFoundationCanon} on read.
 */
export async function persistFoundationCanon(
  store: DurableArtifactStore,
  value: unknown,
  bindings: FoundationCanonPersistBindingsV1 = {
    contentIndexDigestSha256: null,
    ontologyArtifactDigestSha256: null,
  },
): Promise<ArtifactStoreWriteResult & { artifact: FoundationCanonStoredArtifactV1 }> {
  const canon = decodeOrMigrate(value);
  kit.assertInert(bindings);
  kit.rejectCredentials(bindings);
  const normalizedBindings = normalizeBindings(bindings);
  const artifact = sealStoredArtifact(canon, normalizedBindings);
  try {
    const result = await store.putRecord(canon.canonSha256, artifact);
    return { ...result, artifact };
  } catch (error) {
    mapStoreError(error);
  }
}

/**
 * Load a canon artifact by identity and evaluate freshness against current
 * evidence. Stale evidence returns an explicit disposition; pass
 * `requireCurrent: true` to fail closed.
 */
export async function loadFoundationCanon(
  store: DurableArtifactStore,
  canonSha256: string,
  evidence: Omit<
    FoundationCanonEvidenceSnapshotV1,
    "boundContentIndexDigestSha256" | "boundOntologyArtifactDigestSha256"
  >,
  options: { requireCurrent?: boolean } = {},
): Promise<FoundationCanonLoadResultV1> {
  const digest = kit.hash(canonSha256);
  let raw: unknown;
  try {
    raw = await store.getRecord(digest);
  } catch (error) {
    mapStoreError(error);
  }
  const artifact = decodeStoredArtifact(raw);
  if (artifact.canon.canonSha256 !== digest) fail("digest-mismatch");
  const snapshot: FoundationCanonEvidenceSnapshotV1 = {
    ...normalizeCallerEvidence(evidence),
    boundContentIndexDigestSha256: artifact.bindings.contentIndexDigestSha256,
    boundOntologyArtifactDigestSha256: artifact.bindings.ontologyArtifactDigestSha256,
  };
  if (options.requireCurrent) {
    try {
      const freshness = assertFoundationCanonCurrent(artifact.canon, snapshot);
      return { artifact, freshness };
    } catch (error) {
      if (error instanceof FoundationCanonInvalidationError && error.code === "stale-evidence") {
        fail("stale-evidence");
      }
      throw error;
    }
  }
  const freshness = evaluateFoundationCanonFreshness(artifact.canon, snapshot);
  return { artifact, freshness };
}

export async function hasFoundationCanon(
  store: DurableArtifactStore,
  canonSha256: string,
): Promise<boolean> {
  try {
    return await store.has(kit.hash(canonSha256));
  } catch (error) {
    mapStoreError(error);
  }
}

function sealStoredArtifact(
  canon: FoundationCanonV1,
  bindings: FoundationCanonPersistBindingsV1,
): FoundationCanonStoredArtifactV1 {
  return kit.seal("docsfab-foundation-canon-stored-artifact", "storedArtifactSha256", {
    canon,
    bindings,
  }) as FoundationCanonStoredArtifactV1;
}

function decodeStoredArtifact(value: unknown): FoundationCanonStoredArtifactV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, ["schemaVersion", "kind", "canon", "bindings", "storedArtifactSha256"]);
  if (root.schemaVersion !== 1) fail("migration-required");
  if (root.kind !== "docsfab-foundation-canon-stored-artifact") fail("invalid-value");
  const canon = decodeOrMigrate(root.canon);
  const bindings = normalizeBindings(root.bindings);
  const sealed = sealStoredArtifact(canon, bindings);
  if (sealed.storedArtifactSha256 !== kit.hash(root.storedArtifactSha256)) fail("digest-mismatch");
  return sealed;
}

function decodeOrMigrate(value: unknown): FoundationCanonV1 {
  try {
    return migrateFoundationCanon(value);
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

function normalizeBindings(value: unknown): FoundationCanonPersistBindingsV1 {
  const root = kit.object(value);
  kit.exact(root, ["contentIndexDigestSha256", "ontologyArtifactDigestSha256"]);
  return {
    contentIndexDigestSha256: nullableHash(root.contentIndexDigestSha256),
    ontologyArtifactDigestSha256: nullableHash(root.ontologyArtifactDigestSha256),
  };
}

function normalizeCallerEvidence(
  value: Omit<
    FoundationCanonEvidenceSnapshotV1,
    "boundContentIndexDigestSha256" | "boundOntologyArtifactDigestSha256"
  >,
): Omit<
  FoundationCanonEvidenceSnapshotV1,
  "boundContentIndexDigestSha256" | "boundOntologyArtifactDigestSha256"
> {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, [
    "repository",
    "inputManifestSha256",
    "inputIds",
    "contentIndexDigestSha256",
    "ontologyArtifactDigestSha256",
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
    priorCanonSha256: nullableHash(root.priorCanonSha256),
    priorCanonPresent: root.priorCanonPresent,
  };
}

function nullableHash(value: unknown): string | null {
  if (value === null) return null;
  return kit.hash(value);
}

function mapStoreError(error: unknown): never {
  if (error instanceof ArtifactStoreError) {
    if (error.code === "not-found") fail("not-found");
    if (error.code === "integrity-mismatch") fail("integrity-mismatch");
    if (error.code === "invalid-digest") fail("digest-mismatch");
    if (error.code === "invalid-json") fail("invalid-shape");
    fail("store-rejected");
  }
  throw error;
}
