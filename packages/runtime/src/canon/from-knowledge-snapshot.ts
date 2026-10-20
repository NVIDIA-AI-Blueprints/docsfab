// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit } from "../contract-kit/index.js";

import {
  FoundationCanonContractError,
  acceptFoundationCanon,
  createFoundationCanon,
  createFoundationCanonClaim,
  createFoundationCanonConflict,
  createFoundationCanonEvidence,
  createFoundationCanonHostAuthority,
  type FoundationCanonV1,
} from "./contracts.js";

export const KNOWLEDGE_ACCEPTED_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const KNOWLEDGE_ACCEPTED_SNAPSHOT_KIND = "knowledge-accepted-snapshot" as const;
export const KNOWLEDGE_RESUME_RECEIPT_KIND = "docsfab-knowledge-resume-receipt" as const;

const SNAPSHOT_STATUSES = ["approved", "canonical", "candidate"] as const;
const ACCEPTED_SNAPSHOT_STATUSES = ["approved", "canonical"] as const;
const CLAIM_MODEL_STATES = [
  "participant-only",
  "candidate",
  "disputed",
  "unresolved",
  "canonical",
  "superseded",
] as const;

/** Content-addressed import receipt; wall-clock is not part of the façade snapshot. */
const KNOWLEDGE_SNAPSHOT_ACCEPTED_AT = "1970-01-01T00:00:00.000Z";

export type KnowledgeAcceptedSnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];
export type KnowledgeAcceptedSnapshotClaimModelState = (typeof CLAIM_MODEL_STATES)[number];

export interface KnowledgeAcceptedSnapshotClaimV1 {
  id: string;
  kind: string;
  scope: string;
  statement: string;
  modelState: KnowledgeAcceptedSnapshotClaimModelState;
  evidenceIds: string[];
}

export interface KnowledgeAcceptedSnapshotSourceV1 {
  id: string;
  locator: string;
}

export interface KnowledgeAcceptedSnapshotConflictV1 {
  id: string;
  claimIds: string[];
  classification?: KnowledgeAcceptedSnapshotConflictClassificationV1;
}

export interface KnowledgeAcceptedSnapshotConflictClassificationV1 {
  impact: "advisory" | "load-bearing";
  impactBasisSha256: string;
  blockingDocumentationPaths: string[];
  resolutionOwner: string;
  authorityKind: "product-decision-owner";
}

export interface KnowledgeResumeReceiptConflictV1 {
  conflictId: string;
  claimIds: string[];
  impact: "advisory" | "load-bearing";
  impactBasisSha256: string;
  blockingDocumentationPaths: string[];
  resolutionOwner: string;
  authorityKind: "product-decision-owner";
}

/** Content-free evidence that classified conflicts were advisory for one exact target. */
export interface KnowledgeResumeReceiptV1 {
  schemaVersion: 1;
  kind: typeof KNOWLEDGE_RESUME_RECEIPT_KIND;
  snapshotSha256: string;
  selectedTargetPath: string;
  advisoryConflicts: KnowledgeResumeReceiptConflictV1[];
}

export interface KnowledgeAcceptedSnapshotBodyV1 {
  projectId: string;
  modelVersionId: string;
  streamVersion: number;
  status: KnowledgeAcceptedSnapshotStatus;
  claims: KnowledgeAcceptedSnapshotClaimV1[];
  sources: KnowledgeAcceptedSnapshotSourceV1[];
  conflicts: KnowledgeAcceptedSnapshotConflictV1[];
}

export type KnowledgeAcceptedSnapshotV1 = KnowledgeAcceptedSnapshotBodyV1 & {
  schemaVersion: typeof KNOWLEDGE_ACCEPTED_SNAPSHOT_SCHEMA_VERSION;
  kind: typeof KNOWLEDGE_ACCEPTED_SNAPSHOT_KIND;
  snapshotSha256: string;
};

export type KnowledgeSnapshotImportErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required"
  | "duplicate-reference"
  | "dangling-reference"
  | "unsafe-path";

/** Operator identity required to host-accept a candidate snapshot for one run. */
export interface KnowledgeSnapshotHostAccept {
  authorityId: string;
}

export class KnowledgeSnapshotImportError extends Error {
  public constructor(public readonly code: KnowledgeSnapshotImportErrorCode) {
    super(`Knowledge snapshot import rejected: ${code}.`);
    this.name = "KnowledgeSnapshotImportError";
  }
}

function fail(code: KnowledgeSnapshotImportErrorCode): never {
  throw new KnowledgeSnapshotImportError(code);
}

const kit = createContractKit({
  fail,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

const SNAPSHOT_BODY_KEYS = [
  "projectId",
  "modelVersionId",
  "streamVersion",
  "status",
  "claims",
  "sources",
  "conflicts",
] as const;

/** Seals a knowledge-accepted snapshot; does not confer Foundation Canon acceptance. */
export function createKnowledgeAcceptedSnapshot(
  input: KnowledgeAcceptedSnapshotBodyV1,
): KnowledgeAcceptedSnapshotV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  return kit.seal(
    KNOWLEDGE_ACCEPTED_SNAPSHOT_KIND,
    "snapshotSha256",
    normalizeSnapshot(kit.object(input)),
  ) as KnowledgeAcceptedSnapshotV1;
}

/** Decodes structural snapshot data only; approved status is required at import. */
export function decodeKnowledgeAcceptedSnapshot(value: unknown): KnowledgeAcceptedSnapshotV1 {
  return kit.decodeSealed(
    value,
    KNOWLEDGE_ACCEPTED_SNAPSHOT_KIND,
    "snapshotSha256",
    [...SNAPSHOT_BODY_KEYS],
    normalizeSnapshot,
  ) as KnowledgeAcceptedSnapshotV1;
}

/**
 * Maps a sealed knowledge snapshot into FoundationCanonV1.
 * Approved/canonical snapshots import as accepted. Candidate snapshots
 * require a host-accept operator identity; the host verifier is not a
 * serializable record. Does not rewrite file-model approval_state.
 */
export function importFoundationCanonFromKnowledgeSnapshot(
  value: unknown,
  hostAccept?: KnowledgeSnapshotHostAccept,
): FoundationCanonV1 {
  const snapshot = decodeKnowledgeAcceptedSnapshot(value);
  const operatorId = hostAccept === undefined ? undefined : kit.identifier(hostAccept.authorityId);
  if (operatorId !== undefined) {
    if (snapshot.status !== "candidate") fail("invalid-value");
  } else if (!isAcceptedSnapshotStatus(snapshot.status)) {
    fail("invalid-value");
  }
  const authorityId =
    operatorId === undefined
      ? `knowledge:${snapshot.projectId}:${snapshot.modelVersionId}`
      : `operator:${operatorId}:knowledge:${snapshot.projectId}:${snapshot.modelVersionId}`;
  try {
    const proposal = createFoundationCanon(mapProposal(snapshot));
    const authority = createFoundationCanonHostAuthority({
      verifyCurrent: (canon) => {
        if (operatorId === undefined && !isAcceptedSnapshotStatus(snapshot.status)) {
          fail("invalid-value");
        }
        if (operatorId !== undefined && snapshot.status !== "candidate") fail("invalid-value");
        if (canon.repository.contentDigestSha256 !== snapshot.snapshotSha256) {
          fail("digest-mismatch");
        }
        return {
          authorityId,
          authoritySha256: snapshot.snapshotSha256,
          acceptedAt: KNOWLEDGE_SNAPSHOT_ACCEPTED_AT,
        };
      },
    });
    return acceptFoundationCanon(proposal, authority);
  } catch (error) {
    if (error instanceof KnowledgeSnapshotImportError) throw error;
    if (error instanceof FoundationCanonContractError) fail(error.code);
    throw error;
  }
}

function isAcceptedSnapshotStatus(
  status: KnowledgeAcceptedSnapshotStatus,
): status is (typeof ACCEPTED_SNAPSHOT_STATUSES)[number] {
  return (ACCEPTED_SNAPSHOT_STATUSES as readonly string[]).includes(status);
}

function normalizeSnapshot(root: Record<string, unknown>): KnowledgeAcceptedSnapshotBodyV1 {
  kit.exact(root, [...SNAPSHOT_BODY_KEYS]);
  const claims = kit.array(root.claims).map(snapshotClaim).sort(byId);
  const sources = kit.array(root.sources).map(snapshotSource).sort(byId);
  const conflicts = kit.array(root.conflicts).map(snapshotConflict).sort(byId);
  uniqueIds(claims);
  uniqueIds(sources);
  uniqueIds(conflicts);
  if (claims.length === 0 || sources.length === 0) fail("invalid-value");
  const sourceIds = new Set(sources.map((source) => source.id));
  const claimIds = new Set(claims.map((claim) => claim.id));
  for (const claim of claims) requireRefs(claim.evidenceIds, sourceIds);
  for (const conflict of conflicts) {
    requireRefs(conflict.claimIds, claimIds);
    if (conflict.claimIds.length < 2) fail("invalid-value");
  }
  const claimedBy = new Map<string, string>();
  for (const conflict of conflicts) {
    for (const claimId of conflict.claimIds) {
      const prior = claimedBy.get(claimId);
      if (prior !== undefined && prior !== conflict.id) fail("duplicate-reference");
      claimedBy.set(claimId, conflict.id);
    }
  }
  return {
    projectId: kit.identifier(root.projectId),
    modelVersionId: kit.identifier(root.modelVersionId),
    streamVersion: streamVersion(root.streamVersion),
    status: kit.enumeration(root.status, SNAPSHOT_STATUSES),
    claims,
    sources,
    conflicts,
  };
}

function snapshotClaim(value: unknown): KnowledgeAcceptedSnapshotClaimV1 {
  const root = kit.object(value);
  kit.exact(root, ["id", "kind", "scope", "statement", "modelState", "evidenceIds"]);
  const claim = {
    id: kit.identifier(root.id),
    kind: kit.identifier(root.kind),
    scope: kit.string(root.scope),
    statement: kit.string(root.statement),
    modelState: kit.enumeration(root.modelState, CLAIM_MODEL_STATES),
    evidenceIds: ids(root.evidenceIds),
  };
  if (claim.evidenceIds.length === 0) fail("invalid-value");
  return claim;
}

function snapshotSource(value: unknown): KnowledgeAcceptedSnapshotSourceV1 {
  const root = kit.object(value);
  kit.exact(root, ["id", "locator"]);
  const locator = kit.string(root.locator);
  if (locator.length === 0) fail("invalid-value");
  return { id: kit.identifier(root.id), locator };
}

function snapshotConflict(value: unknown): KnowledgeAcceptedSnapshotConflictV1 {
  const root = kit.object(value);
  kit.exact(root, ["id", "claimIds", "classification"], ["classification"]);
  return {
    id: kit.identifier(root.id),
    claimIds: ids(root.claimIds),
    ...(root.classification === undefined
      ? {}
      : { classification: snapshotConflictClassification(root.classification) }),
  };
}

function snapshotConflictClassification(
  value: unknown,
): KnowledgeAcceptedSnapshotConflictClassificationV1 {
  const root = kit.object(value);
  kit.exact(root, [
    "impact",
    "impactBasisSha256",
    "blockingDocumentationPaths",
    "resolutionOwner",
    "authorityKind",
  ]);
  const impact = kit.enumeration(root.impact, ["advisory", "load-bearing"] as const);
  const paths = documentationPaths(root.blockingDocumentationPaths);
  if (
    (impact === "advisory" && paths.length !== 0) ||
    (impact === "load-bearing" && paths.length === 0)
  ) {
    fail("invalid-value");
  }
  if (root.authorityKind !== "product-decision-owner") fail("invalid-value");
  return {
    impact,
    impactBasisSha256: kit.hash(root.impactBasisSha256),
    blockingDocumentationPaths: paths,
    resolutionOwner: kit.identifier(root.resolutionOwner),
    authorityKind: "product-decision-owner",
  };
}

/** Strictly decode normalized receipt evidence before it crosses a core execution boundary. */
export function decodeKnowledgeResumeReceipt(value: unknown): KnowledgeResumeReceiptV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, [
    "schemaVersion",
    "kind",
    "snapshotSha256",
    "selectedTargetPath",
    "advisoryConflicts",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== KNOWLEDGE_RESUME_RECEIPT_KIND) {
    fail("invalid-value");
  }
  const selectedTargetPath = documentationPath(root.selectedTargetPath);
  const advisoryConflicts = kit
    .array(root.advisoryConflicts)
    .map(receiptConflict)
    .sort(byConflictId);
  if (advisoryConflicts.length === 0) fail("invalid-value");
  const conflictIds = advisoryConflicts.map((conflict) => conflict.conflictId);
  kit.unique(conflictIds);
  if (
    advisoryConflicts.some((conflict) =>
      conflict.blockingDocumentationPaths.includes(selectedTargetPath),
    )
  ) {
    fail("invalid-value");
  }
  return {
    schemaVersion: 1,
    kind: KNOWLEDGE_RESUME_RECEIPT_KIND,
    snapshotSha256: kit.hash(root.snapshotSha256),
    selectedTargetPath,
    advisoryConflicts,
  };
}

function receiptConflict(value: unknown): KnowledgeResumeReceiptConflictV1 {
  const root = kit.object(value);
  kit.exact(root, [
    "conflictId",
    "claimIds",
    "impact",
    "impactBasisSha256",
    "blockingDocumentationPaths",
    "resolutionOwner",
    "authorityKind",
  ]);
  const impact = kit.enumeration(root.impact, ["advisory", "load-bearing"] as const);
  const claimIds = ids(root.claimIds);
  if (claimIds.length < 2) fail("invalid-value");
  const paths = documentationPaths(root.blockingDocumentationPaths);
  if (
    (impact === "advisory" && paths.length !== 0) ||
    (impact === "load-bearing" && paths.length === 0)
  ) {
    fail("invalid-value");
  }
  if (root.authorityKind !== "product-decision-owner") fail("invalid-value");
  return {
    conflictId: kit.identifier(root.conflictId),
    claimIds,
    impact,
    impactBasisSha256: kit.hash(root.impactBasisSha256),
    blockingDocumentationPaths: paths,
    resolutionOwner: kit.identifier(root.resolutionOwner),
    authorityKind: "product-decision-owner",
  };
}

function documentationPaths(value: unknown): string[] {
  const paths = kit.array(value).map(documentationPath).sort(kit.compare);
  kit.unique(paths);
  return paths;
}

function documentationPath(value: unknown): string {
  const path = kit.string(value).normalize("NFC");
  if (!/^docs\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.mdx?$/u.test(path)) fail("unsafe-path");
  return path;
}

function byConflictId(
  left: KnowledgeResumeReceiptConflictV1,
  right: KnowledgeResumeReceiptConflictV1,
): number {
  return kit.compare(left.conflictId, right.conflictId);
}

function mapProposal(
  snapshot: KnowledgeAcceptedSnapshotV1,
): Parameters<typeof createFoundationCanon>[0] {
  const conflictGroupByClaim = new Map<string, string>();
  for (const conflict of snapshot.conflicts) {
    for (const claimId of conflict.claimIds) conflictGroupByClaim.set(claimId, conflict.id);
  }
  const evidence = snapshot.sources.map((source) =>
    createFoundationCanonEvidence({
      id: source.id,
      inputId: source.id,
      digestSha256: kit.canonicalDigest(source.locator),
    }),
  );
  const claims = snapshot.claims.map((claim) => {
    const statementSha256 = kit.canonicalDigest(claim.statement);
    return createFoundationCanonClaim({
      id: claim.id,
      subjectSha256: kit.canonicalDigest(claim.kind),
      assertionSha256: statementSha256,
      confidence: claim.modelState === "canonical" ? "high" : "medium",
      verificationStatus: claim.modelState === "canonical" ? "verified" : "unverified",
      applicabilitySha256: kit.canonicalDigest(claim.scope),
      ownerAuthorityId: null,
      statementSha256,
      evidenceIds: claim.evidenceIds,
      assumptionIds: [],
      dependencyIds: [],
      affectedArtifactIds: [],
      conflictGroupId: conflictGroupByClaim.get(claim.id) ?? null,
      supersededByClaimId: null,
    });
  });
  const conflicts = snapshot.conflicts.map((conflict) =>
    createFoundationCanonConflict({
      id: conflict.id,
      claimIds: conflict.claimIds,
      resolutionSha256: null,
    }),
  );
  return {
    canonId: snapshot.modelVersionId,
    version: String(snapshot.streamVersion),
    proposedBy: "operator",
    state: "proposal",
    authority: null,
    repository: {
      identitySha256: kit.canonicalDigest(snapshot.projectId),
      revision: kit.canonicalDigest(snapshot.streamVersion),
      contentDigestSha256: snapshot.snapshotSha256,
    },
    inputBinding: {
      manifestSha256: kit.canonicalDigest(snapshot.modelVersionId),
      inputIds: snapshot.sources.map((source) => source.id),
    },
    claims,
    evidence,
    conflicts,
    assumptions: [],
    dependencies: [],
    affectedArtifacts: [],
    supersession: null,
  };
}

function streamVersion(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Object.is(value, -0)
  ) {
    fail("invalid-value");
  }
  return value;
}

function ids(value: unknown): string[] {
  const result = kit.array(value).map(kit.identifier).sort(kit.compare);
  kit.unique(result);
  return result;
}

function uniqueIds(values: Array<{ id: string }>): void {
  if (new Set(values.map((value) => value.id)).size !== values.length) fail("duplicate-reference");
}

function requireRefs(values: string[], known: Set<string>): void {
  if (values.some((value) => !known.has(value))) fail("dangling-reference");
}

function byId(left: { id: string }, right: { id: string }): number {
  return kit.compare(left.id, right.id);
}
