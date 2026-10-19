// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The pinned repository revision shape every source that names repository
 * history shares: a repository identity, an optional base, and a head, each a
 * full Git object id. Change sources embed it; companion source repositories
 * reuse it rather than defining a second shape.
 *
 * Only identity and object ids live here. How a kind resolves its revisions,
 * and what it reads at them, belongs to that kind's producer.
 */
import { createContractKit } from "../../contract-kit/index.js";

/** A full SHA-1 or SHA-256 Git object id, the only revision form a record carries. */
export const GIT_FULL_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export function isGitFullObjectId(value: string): boolean {
  return GIT_FULL_OBJECT_ID.test(value);
}

export const PINNED_REPOSITORY_REVISION_KIND = "docsfab-pinned-repository-revision" as const;

/**
 * Repository identity kinds. `local-checkout` is a digest of the checkout's
 * top-level path, the same identity the source binding already records. A
 * forge identity is a digest of the canonical JSON its builder below writes.
 */
export const PINNED_REPOSITORY_IDENTITY_KINDS = [
  "local-checkout",
  "gitlab-project",
  "github-repository",
] as const;

export type PinnedRepositoryIdentityKind = (typeof PINNED_REPOSITORY_IDENTITY_KINDS)[number];

export interface PinnedRepositoryIdentityV1 {
  readonly kind: PinnedRepositoryIdentityKind;
  readonly identitySha256: string;
}

export interface PinnedRepositoryRevisionV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof PINNED_REPOSITORY_REVISION_KIND;
  readonly repository: PinnedRepositoryIdentityV1;
  /** Absent for a single pinned revision, such as a companion repository. */
  readonly base?: string;
  readonly head: string;
}

export const PINNED_REPOSITORY_REVISION_ERROR_CODES = [
  "pinned-revision-invalid-shape",
  "pinned-revision-invalid-value",
  "pinned-revision-credential-material",
  "pinned-revision-schema-mismatch",
  "pinned-revision-digest-mismatch",
] as const;

export type PinnedRepositoryRevisionErrorCode =
  (typeof PINNED_REPOSITORY_REVISION_ERROR_CODES)[number];

export class PinnedRepositoryRevisionError extends Error {
  public constructor(public readonly code: PinnedRepositoryRevisionErrorCode) {
    super(
      `The pinned repository revision record is not valid (${code}). It must carry a repository identity digest and full Git object ids only; rebuild it with createPinnedRepositoryRevision.`,
    );
    this.name = "PinnedRepositoryRevisionError";
  }
}

function failPinnedRevision(code: PinnedRepositoryRevisionErrorCode): never {
  throw new PinnedRepositoryRevisionError(code);
}

const kit = createContractKit<PinnedRepositoryRevisionErrorCode>({
  fail: failPinnedRevision,
  codes: {
    invalidShape: "pinned-revision-invalid-shape",
    invalidValue: "pinned-revision-invalid-value",
    digestMismatch: "pinned-revision-digest-mismatch",
    credentialMaterial: "pinned-revision-credential-material",
    schemaMismatch: "pinned-revision-schema-mismatch",
  },
});

function identity(value: unknown): PinnedRepositoryIdentityV1 {
  const root = kit.object(value);
  kit.exact(root, ["kind", "identitySha256"]);
  return {
    kind: kit.enumeration(root.kind, PINNED_REPOSITORY_IDENTITY_KINDS),
    identitySha256: kit.hash(root.identitySha256),
  };
}

/**
 * A canonical forge host: lowercase DNS labels only. No scheme, userinfo,
 * port, path, whitespace, or trailing dot, so one forge has one spelling.
 */
const FORGE_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/u;

function forgeHost(value: unknown): string {
  if (typeof value !== "string" || !FORGE_HOST.test(value)) {
    failPinnedRevision("pinned-revision-invalid-value");
  }
  return value;
}

/** A forge's numeric project or repository id; a numeric string is not one. */
function forgeId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    failPinnedRevision("pinned-revision-invalid-value");
  }
  return value;
}

function forgeIdentity(
  kind: PinnedRepositoryIdentityKind,
  fields: Record<string, string | number>,
): PinnedRepositoryIdentityV1 {
  return kit.deepFreeze({ kind, identitySha256: kit.canonicalDigest(fields) });
}

/** A GitLab project's identity: the digest of canonical `{host, projectId}`. */
export function gitlabProjectIdentity(input: {
  readonly host: string;
  readonly projectId: number;
}): PinnedRepositoryIdentityV1 {
  return forgeIdentity("gitlab-project", {
    host: forgeHost(input.host),
    projectId: forgeId(input.projectId),
  });
}

/** A GitHub repository's identity: the digest of canonical `{host, repositoryId}`. */
export function githubRepositoryIdentity(input: {
  readonly host: string;
  readonly repositoryId: number;
}): PinnedRepositoryIdentityV1 {
  return forgeIdentity("github-repository", {
    host: forgeHost(input.host),
    repositoryId: forgeId(input.repositoryId),
  });
}

/** Normalize and freeze one pinned revision; refuses anything but full object ids. */
export function createPinnedRepositoryRevision(input: {
  readonly repository: PinnedRepositoryIdentityV1;
  readonly base?: string;
  readonly head: string;
}): PinnedRepositoryRevisionV1 {
  return decodePinnedRepositoryRevisionV1({
    schemaVersion: 1,
    kind: PINNED_REPOSITORY_REVISION_KIND,
    repository: input.repository,
    ...(input.base === undefined ? {} : { base: input.base }),
    head: input.head,
  });
}

/** Closed-key decoder; a key outside the shape or a short object id refuses. */
export function decodePinnedRepositoryRevisionV1(value: unknown): PinnedRepositoryRevisionV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  const hasBase = Object.hasOwn(root, "base");
  kit.exact(root, ["schemaVersion", "kind", "repository", ...(hasBase ? ["base"] : []), "head"]);
  if (root.schemaVersion !== 1 || root.kind !== PINNED_REPOSITORY_REVISION_KIND) {
    failPinnedRevision("pinned-revision-schema-mismatch");
  }
  const head = kit.revision(root.head);
  const base = hasBase ? kit.revision(root.base) : undefined;
  if (base !== undefined && base.length !== head.length) {
    failPinnedRevision("pinned-revision-invalid-value");
  }
  return kit.deepFreeze({
    schemaVersion: 1 as const,
    kind: PINNED_REPOSITORY_REVISION_KIND,
    repository: identity(root.repository),
    ...(base === undefined ? {} : { base }),
    head,
  });
}
