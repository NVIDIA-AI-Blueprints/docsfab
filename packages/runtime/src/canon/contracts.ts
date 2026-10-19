// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createContractKit,
  createHostAuthorityFactory,
  deepFreeze,
} from "../contract-kit/index.js";

export const FOUNDATION_CANON_SCHEMA_VERSION = 1 as const;
export const FOUNDATION_CANON_STATES = ["proposal", "accepted"] as const;
export type FoundationCanonState = (typeof FOUNDATION_CANON_STATES)[number];

export interface FoundationCanonRepositoryBindingV1 {
  identitySha256: string;
  revision: string;
  contentDigestSha256: string;
}

export interface FoundationCanonInputBindingV1 {
  manifestSha256: string;
  inputIds: string[];
}

export interface FoundationCanonClaimV1 {
  id: string;
  subjectSha256: string;
  assertionSha256: string;
  confidence: "low" | "medium" | "high";
  verificationStatus: "unverified" | "verified" | "accepted-assumption";
  applicabilitySha256: string;
  ownerAuthorityId: string | null;
  statementSha256: string;
  evidenceIds: string[];
  assumptionIds: string[];
  dependencyIds: string[];
  affectedArtifactIds: string[];
  conflictGroupId: string | null;
  supersededByClaimId: string | null;
  claimSha256: string;
}

export interface FoundationCanonEvidenceV1 {
  id: string;
  inputId: string;
  digestSha256: string;
  evidenceSha256: string;
}

export interface FoundationCanonConflictV1 {
  id: string;
  claimIds: string[];
  resolutionSha256: string | null;
  conflictSha256: string;
}

export interface FoundationCanonAssumptionV1 {
  id: string;
  statementSha256: string;
  assumptionSha256: string;
}

export interface FoundationCanonDependencyV1 {
  id: string;
  dependsOnIds: string[];
  dependencySha256: string;
}

export interface FoundationCanonAffectedArtifactV1 {
  id: string;
  path: string;
  digestSha256: string;
  artifactSha256: string;
}

export interface FoundationCanonAuthorityV1 {
  authorityId: string;
  authoritySha256: string;
  acceptedAt: string;
}

export interface FoundationCanonHostVerifierV1 {
  verifyCurrent(canon: FoundationCanonV1): FoundationCanonAuthorityV1;
}
export type FoundationCanonHostAuthority = {
  readonly kind: "docsfab-foundation-canon-host-authority";
};
const hostAuthorities = createHostAuthorityFactory<
  "docsfab-foundation-canon-host-authority",
  FoundationCanonHostVerifierV1
>({
  kind: "docsfab-foundation-canon-host-authority",
  invalidMessage: "Invalid foundation canon host verifier.",
});

export interface FoundationCanonSupersessionV1 {
  supersedesCanonSha256: string;
  reasonSha256: string;
}

export interface FoundationCanonBodyV1 {
  canonId: string;
  version: string;
  proposedBy: "model" | "operator";
  repository: FoundationCanonRepositoryBindingV1;
  inputBinding: FoundationCanonInputBindingV1;
  state: FoundationCanonState;
  claims: FoundationCanonClaimV1[];
  evidence: FoundationCanonEvidenceV1[];
  conflicts: FoundationCanonConflictV1[];
  authority: FoundationCanonAuthorityV1 | null;
  assumptions: FoundationCanonAssumptionV1[];
  dependencies: FoundationCanonDependencyV1[];
  affectedArtifacts: FoundationCanonAffectedArtifactV1[];
  supersession: FoundationCanonSupersessionV1 | null;
}

export type FoundationCanonV1 = FoundationCanonBodyV1 & {
  schemaVersion: 1;
  kind: "docsfab-foundation-canon";
  canonSha256: string;
};

export interface FoundationCanonProjectionV1 {
  schemaVersion: 1;
  kind: "docsfab-foundation-canon-projection";
  canonId: string;
  version: string;
  repositoryIdentitySha256: string;
  repositoryRevision: string;
  state: FoundationCanonState;
  claimCount: number;
  evidenceCount: number;
  conflictCount: number;
  assumptionCount: number;
  dependencyCount: number;
  affectedArtifactCount: number;
  hasAuthority: boolean;
  supersedes: boolean;
  canonSha256: string;
  projectionSha256: string;
}

export const FOUNDATION_CANON_MIGRATION_POLICY = deepFreeze({
  schemaVersion: 1 as const,
  kind: "docsfab-foundation-canon-migration-policy" as const,
  currentSchemaVersion: 1 as const,
  acceptedSourceVersions: [1] as const,
  unknownVersion: "reject" as const,
  retention: "identity-digests-and-reference-graph-only" as const,
  historicalAuthority: "none" as const,
});

export type FoundationCanonContractErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required"
  | "duplicate-reference"
  | "dangling-reference"
  | "unsafe-path";

export class FoundationCanonContractError extends Error {
  public constructor(public readonly code: FoundationCanonContractErrorCode) {
    super(`Foundation canon contract rejected: ${code}.`);
    this.name = "FoundationCanonContractError";
  }
}

function fail(code: FoundationCanonContractErrorCode): never {
  throw new FoundationCanonContractError(code);
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

/** Creates a canonical, frozen, content-minimized FoundationCanonV1 record. */
export function createFoundationCanon(input: FoundationCanonBodyV1): FoundationCanonV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const body = normalizeBody(kit.object(input));
  if (body.state !== "proposal" || body.authority !== null) fail("invalid-value");
  return kit.seal("docsfab-foundation-canon", "canonSha256", body) as FoundationCanonV1;
}

/** Creates an opaque, non-serializable host authority capability. */
export function createFoundationCanonHostAuthority(
  verifier: FoundationCanonHostVerifierV1,
): FoundationCanonHostAuthority {
  return hostAuthorities.create(verifier);
}

/** Host-authenticates an exact proposal; callers cannot mint acceptance from serializable data. */
export function acceptFoundationCanon(
  proposal: unknown,
  authority: FoundationCanonHostAuthority,
): FoundationCanonV1 {
  const decoded = decodeFoundationCanon(proposal);
  if (decoded.state !== "proposal" || decoded.authority !== null) fail("invalid-value");
  const verifier = hostAuthorities.lookup(authority);
  if (!verifier) fail("invalid-value");
  const receipt = verifier.verifyCurrent(decoded);
  kit.assertInert(receipt);
  kit.rejectCredentials(receipt);
  const {
    schemaVersion: _schemaVersion,
    kind: _kind,
    canonSha256: _canonSha256,
    ...body
  } = decoded;
  return sealAccepted({ ...body, state: "accepted", authority: authorityRecord(receipt) });
}

/** Decodes structural data only; no authority is conferred by a decoded record. */
export function decodeFoundationCanon(value: unknown): FoundationCanonV1 {
  return kit.decodeSealed(
    value,
    "docsfab-foundation-canon",
    "canonSha256",
    [
      "canonId",
      "version",
      "proposedBy",
      "repository",
      "inputBinding",
      "state",
      "claims",
      "evidence",
      "conflicts",
      "authority",
      "assumptions",
      "dependencies",
      "affectedArtifacts",
      "supersession",
    ],
    normalizeBody,
  ) as FoundationCanonV1;
}

export function projectFoundationCanon(value: unknown): FoundationCanonProjectionV1 {
  const canon = decodeFoundationCanon(value);
  return kit.seal("docsfab-foundation-canon-projection", "projectionSha256", {
    canonId: canon.canonId,
    version: canon.version,
    repositoryIdentitySha256: canon.repository.identitySha256,
    repositoryRevision: canon.repository.revision,
    state: canon.state,
    claimCount: canon.claims.length,
    evidenceCount: canon.evidence.length,
    conflictCount: canon.conflicts.length,
    assumptionCount: canon.assumptions.length,
    dependencyCount: canon.dependencies.length,
    affectedArtifactCount: canon.affectedArtifacts.length,
    hasAuthority: canon.authority !== null,
    supersedes: canon.supersession !== null,
    canonSha256: canon.canonSha256,
  }) as FoundationCanonProjectionV1;
}

export function migrateFoundationCanon(value: unknown): FoundationCanonV1 {
  if (kit.sourceVersion(value) !== 1) fail("migration-required");
  return decodeFoundationCanon(value);
}

/** Small record constructors keep callers from reimplementing member digest rules. */
export function createFoundationCanonClaim(
  input: Omit<FoundationCanonClaimV1, "claimSha256">,
): FoundationCanonClaimV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const body = {
    id: kit.identifier(input.id),
    subjectSha256: kit.hash(input.subjectSha256),
    assertionSha256: kit.hash(input.assertionSha256),
    confidence: kit.enumeration(input.confidence, ["low", "medium", "high"] as const),
    verificationStatus: kit.enumeration(input.verificationStatus, [
      "unverified",
      "verified",
      "accepted-assumption",
    ] as const),
    applicabilitySha256: kit.hash(input.applicabilitySha256),
    ownerAuthorityId:
      input.ownerAuthorityId === null ? null : kit.identifier(input.ownerAuthorityId),
    statementSha256: kit.hash(input.statementSha256),
    evidenceIds: ids(input.evidenceIds),
    assumptionIds: ids(input.assumptionIds),
    dependencyIds: ids(input.dependencyIds),
    affectedArtifactIds: ids(input.affectedArtifactIds),
    conflictGroupId: input.conflictGroupId === null ? null : kit.identifier(input.conflictGroupId),
    supersededByClaimId:
      input.supersededByClaimId === null ? null : kit.identifier(input.supersededByClaimId),
  };
  return member(
    "docsfab-foundation-canon-claim",
    "claimSha256",
    body,
  ) as unknown as FoundationCanonClaimV1;
}
export function createFoundationCanonEvidence(
  input: Omit<FoundationCanonEvidenceV1, "evidenceSha256">,
): FoundationCanonEvidenceV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  return member("docsfab-foundation-canon-evidence", "evidenceSha256", {
    id: kit.identifier(input.id),
    inputId: kit.identifier(input.inputId),
    digestSha256: kit.hash(input.digestSha256),
  }) as unknown as FoundationCanonEvidenceV1;
}
export function createFoundationCanonConflict(
  input: Omit<FoundationCanonConflictV1, "conflictSha256">,
): FoundationCanonConflictV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  return member("docsfab-foundation-canon-conflict", "conflictSha256", {
    id: kit.identifier(input.id),
    claimIds: ids(input.claimIds),
    resolutionSha256: kit.nullableHash(input.resolutionSha256),
  }) as unknown as FoundationCanonConflictV1;
}
export function createFoundationCanonAssumption(
  input: Omit<FoundationCanonAssumptionV1, "assumptionSha256">,
): FoundationCanonAssumptionV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  return member("docsfab-foundation-canon-assumption", "assumptionSha256", {
    id: kit.identifier(input.id),
    statementSha256: kit.hash(input.statementSha256),
  }) as unknown as FoundationCanonAssumptionV1;
}
export function createFoundationCanonDependency(
  input: Omit<FoundationCanonDependencyV1, "dependencySha256">,
): FoundationCanonDependencyV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  return member("docsfab-foundation-canon-dependency", "dependencySha256", {
    id: kit.identifier(input.id),
    dependsOnIds: ids(input.dependsOnIds),
  }) as unknown as FoundationCanonDependencyV1;
}
export function createFoundationCanonAffectedArtifact(
  input: Omit<FoundationCanonAffectedArtifactV1, "artifactSha256">,
): FoundationCanonAffectedArtifactV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  return member("docsfab-foundation-canon-artifact", "artifactSha256", {
    id: kit.identifier(input.id),
    path: safePath(input.path),
    digestSha256: kit.hash(input.digestSha256),
  }) as unknown as FoundationCanonAffectedArtifactV1;
}

function normalizeBody(root: Record<string, unknown>): FoundationCanonBodyV1 {
  kit.exact(root, [
    "canonId",
    "version",
    "proposedBy",
    "repository",
    "inputBinding",
    "state",
    "claims",
    "evidence",
    "conflicts",
    "authority",
    "assumptions",
    "dependencies",
    "affectedArtifacts",
    "supersession",
  ]);
  const claims = kit.array(root.claims).map(claim).sort(byId);
  const evidence = kit.array(root.evidence).map(evidenceRecord).sort(byId);
  const conflicts = kit.array(root.conflicts).map(conflict).sort(byId);
  const assumptions = kit.array(root.assumptions).map(assumption).sort(byId);
  const dependencies = kit.array(root.dependencies).map(dependency).sort(byId);
  const affectedArtifacts = kit.array(root.affectedArtifacts).map(artifact).sort(byId);
  for (const records of [
    claims,
    evidence,
    conflicts,
    assumptions,
    dependencies,
    affectedArtifacts,
  ]) {
    uniqueIds(records);
  }
  const inputBinding = binding(root.inputBinding);
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const assumptionIds = new Set(assumptions.map((item) => item.id));
  const dependencyIds = new Set(dependencies.map((item) => item.id));
  for (const item of claims) {
    requireRefs(item.evidenceIds, evidenceIds);
    requireRefs(item.assumptionIds, assumptionIds);
    requireRefs(item.dependencyIds, dependencyIds);
  }
  const claimIds = new Set(claims.map((item) => item.id));
  const artifactIds = new Set(affectedArtifacts.map((item) => item.id));
  for (const item of claims) {
    requireRefs(item.affectedArtifactIds, artifactIds);
    if (
      item.evidenceIds.length === 0 &&
      !(item.assumptionIds.length > 0 && item.verificationStatus === "accepted-assumption")
    ) {
      fail("invalid-value");
    }
    if (item.supersededByClaimId !== null)
      requireRefs([item.supersededByClaimId], claimIds, item.id);
  }
  for (const item of conflicts) {
    requireRefs(item.claimIds, claimIds);
    if (
      item.claimIds.length < 2 ||
      item.claimIds.some(
        (id) => claims.find((claim) => claim.id === id)?.conflictGroupId !== item.id,
      )
    )
      fail("invalid-value");
  }
  for (const item of dependencies) requireRefs(item.dependsOnIds, dependencyIds, item.id);
  for (const item of evidence) requireRefs([item.inputId], new Set(inputBinding.inputIds));
  const state = kit.enumeration(root.state, FOUNDATION_CANON_STATES);
  const authority = root.authority === null ? null : authorityRecord(root.authority);
  if ((state === "accepted") !== (authority !== null)) fail("invalid-value");
  return {
    canonId: kit.identifier(root.canonId),
    version: kit.identifier(root.version),
    proposedBy: kit.enumeration(root.proposedBy, ["model", "operator"] as const),
    repository: repository(root.repository),
    inputBinding,
    state,
    claims,
    evidence,
    conflicts,
    authority,
    assumptions,
    dependencies,
    affectedArtifacts,
    supersession: root.supersession === null ? null : supersession(root.supersession),
  };
}

function repository(value: unknown): FoundationCanonRepositoryBindingV1 {
  const root = kit.object(value);
  kit.exact(root, ["identitySha256", "revision", "contentDigestSha256"]);
  return {
    identitySha256: kit.hash(root.identitySha256),
    revision: kit.revision(root.revision),
    contentDigestSha256: kit.hash(root.contentDigestSha256),
  };
}
function binding(value: unknown): FoundationCanonInputBindingV1 {
  const root = kit.object(value);
  kit.exact(root, ["manifestSha256", "inputIds"]);
  return { manifestSha256: kit.hash(root.manifestSha256), inputIds: ids(root.inputIds) };
}
function claim(value: unknown): FoundationCanonClaimV1 {
  const r = kit.object(value);
  kit.exact(r, [
    "id",
    "subjectSha256",
    "assertionSha256",
    "confidence",
    "verificationStatus",
    "applicabilitySha256",
    "ownerAuthorityId",
    "statementSha256",
    "evidenceIds",
    "assumptionIds",
    "dependencyIds",
    "affectedArtifactIds",
    "conflictGroupId",
    "supersededByClaimId",
    "claimSha256",
  ]);
  const body = {
    id: kit.identifier(r.id),
    subjectSha256: kit.hash(r.subjectSha256),
    assertionSha256: kit.hash(r.assertionSha256),
    confidence: kit.enumeration(r.confidence, ["low", "medium", "high"] as const),
    verificationStatus: kit.enumeration(r.verificationStatus, [
      "unverified",
      "verified",
      "accepted-assumption",
    ] as const),
    applicabilitySha256: kit.hash(r.applicabilitySha256),
    ownerAuthorityId: r.ownerAuthorityId === null ? null : kit.identifier(r.ownerAuthorityId),
    statementSha256: kit.hash(r.statementSha256),
    evidenceIds: ids(r.evidenceIds),
    assumptionIds: ids(r.assumptionIds),
    dependencyIds: ids(r.dependencyIds),
    affectedArtifactIds: ids(r.affectedArtifactIds),
    conflictGroupId: r.conflictGroupId === null ? null : kit.identifier(r.conflictGroupId),
    supersededByClaimId:
      r.supersededByClaimId === null ? null : kit.identifier(r.supersededByClaimId),
  };
  return verify(
    "docsfab-foundation-canon-claim",
    "claimSha256",
    r.claimSha256,
    body,
  ) as unknown as FoundationCanonClaimV1;
}
function evidenceRecord(value: unknown): FoundationCanonEvidenceV1 {
  const r = kit.object(value);
  kit.exact(r, ["id", "inputId", "digestSha256", "evidenceSha256"]);
  return verify("docsfab-foundation-canon-evidence", "evidenceSha256", r.evidenceSha256, {
    id: kit.identifier(r.id),
    inputId: kit.identifier(r.inputId),
    digestSha256: kit.hash(r.digestSha256),
  }) as unknown as FoundationCanonEvidenceV1;
}
function conflict(value: unknown): FoundationCanonConflictV1 {
  const r = kit.object(value);
  kit.exact(r, ["id", "claimIds", "resolutionSha256", "conflictSha256"]);
  return verify("docsfab-foundation-canon-conflict", "conflictSha256", r.conflictSha256, {
    id: kit.identifier(r.id),
    claimIds: ids(r.claimIds),
    resolutionSha256: kit.nullableHash(r.resolutionSha256),
  }) as unknown as FoundationCanonConflictV1;
}
function sealAccepted(body: FoundationCanonBodyV1): FoundationCanonV1 {
  const normalized = normalizeBody(body as unknown as Record<string, unknown>);
  if (normalized.state !== "accepted" || normalized.authority === null) fail("invalid-value");
  return kit.seal("docsfab-foundation-canon", "canonSha256", normalized) as FoundationCanonV1;
}
function assumption(value: unknown): FoundationCanonAssumptionV1 {
  const r = kit.object(value);
  kit.exact(r, ["id", "statementSha256", "assumptionSha256"]);
  return verify("docsfab-foundation-canon-assumption", "assumptionSha256", r.assumptionSha256, {
    id: kit.identifier(r.id),
    statementSha256: kit.hash(r.statementSha256),
  }) as unknown as FoundationCanonAssumptionV1;
}
function dependency(value: unknown): FoundationCanonDependencyV1 {
  const r = kit.object(value);
  kit.exact(r, ["id", "dependsOnIds", "dependencySha256"]);
  return verify("docsfab-foundation-canon-dependency", "dependencySha256", r.dependencySha256, {
    id: kit.identifier(r.id),
    dependsOnIds: ids(r.dependsOnIds),
  }) as unknown as FoundationCanonDependencyV1;
}
function artifact(value: unknown): FoundationCanonAffectedArtifactV1 {
  const r = kit.object(value);
  kit.exact(r, ["id", "path", "digestSha256", "artifactSha256"]);
  const path = safePath(r.path);
  return verify("docsfab-foundation-canon-artifact", "artifactSha256", r.artifactSha256, {
    id: kit.identifier(r.id),
    path,
    digestSha256: kit.hash(r.digestSha256),
  }) as unknown as FoundationCanonAffectedArtifactV1;
}
function authorityRecord(value: unknown): FoundationCanonAuthorityV1 {
  const r = kit.object(value);
  kit.exact(r, ["authorityId", "authoritySha256", "acceptedAt"]);
  return {
    authorityId: kit.identifier(r.authorityId),
    authoritySha256: kit.hash(r.authoritySha256),
    acceptedAt: kit.timestamp(r.acceptedAt),
  };
}
function supersession(value: unknown): FoundationCanonSupersessionV1 {
  const r = kit.object(value);
  kit.exact(r, ["supersedesCanonSha256", "reasonSha256"]);
  return {
    supersedesCanonSha256: kit.hash(r.supersedesCanonSha256),
    reasonSha256: kit.hash(r.reasonSha256),
  };
}
function verify(
  kind: string,
  digestKey: string,
  supplied: unknown,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const sealed = kit.seal(kind, digestKey, body) as Record<string, unknown>;
  if (supplied !== sealed[digestKey]) fail("digest-mismatch");
  return deepFreeze({ ...body, [digestKey]: sealed[digestKey] });
}
function member(
  kind: string,
  digestKey: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const sealed = kit.seal(kind, digestKey, body) as Record<string, unknown>;
  return deepFreeze({ ...body, [digestKey]: sealed[digestKey] });
}
function ids(value: unknown): string[] {
  const result = kit.array(value).map(kit.identifier).sort(kit.compare);
  kit.unique(result);
  return result;
}
function uniqueIds(values: Array<{ id: string }>): void {
  if (new Set(values.map((value) => value.id)).size !== values.length) fail("duplicate-reference");
}
function requireRefs(values: string[], known: Set<string>, disallow?: string): void {
  if (values.some((value) => !known.has(value) || value === disallow)) fail("dangling-reference");
}
function byId(left: { id: string }, right: { id: string }): number {
  return kit.compare(left.id, right.id);
}
function safePath(value: unknown): string {
  const path = kit.string(value);
  if (!/^(?!\/)(?!.*(?:^|\/)\.\.?\/)[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/u.test(path))
    fail("unsafe-path");
  return path;
}
