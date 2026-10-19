// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Public REST identity admission followed by the native bounded object reader. */
import { createHash } from "node:crypto";
import { canonicalDigest } from "../../content-ir/canonical.js";
import { createContractKit, createHostAuthorityFactory } from "../../contract-kit/index.js";
import { buildRepositoryDiscoveryInventory } from "../../repository/inventory.js";
import type { RepositoryDiscoveryInventoryV1 } from "../../repository/inventory-contracts.js";
import type { GithubPrHeadWorkspace } from "../../repository/workspace/contracts.js";
import { prepareRepositoryWorkspaceFromVerifiedTree } from "../../repository/workspace/materialize.js";
import { closeScopedRepositoryWorkspace } from "../../repository/workspace/tracked-read.js";
import type { ResolveLimitsOptions } from "../../config/limits.js";
import {
  createGithubPrObjectReader,
  type GithubPrAcquisitionMetrics,
  type GithubPrGraph,
  type GithubPrManifestRow,
  type GithubPrObjectReader,
  type GithubPrVerifiedTreeEntry,
} from "./github-pr-objects.js";
import type { GithubPrFetchPort } from "./github-pr-transport.js";
import {
  createGithubApiClient,
  githubApiLimits,
  type GithubFetchPort,
} from "../change-source/github-transport.js";
import { githubPrReference, parseGithubPrLocator } from "../github-pr-locator.js";
import type { ChangeRequestRefV1 } from "../change-request.js";
import { classifySourceMediaType } from "../source-extractor-registry.js";

const SHA1 = /^[0-9a-f]{40}$/u;
const REPO = /^[A-Za-z0-9._-]+$/u;
const OWNER = /^[A-Za-z0-9](?:-?[A-Za-z0-9])*$/u;

export class GithubPrProviderError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "GithubPrProviderError";
  }
}

function fail(code: string): never {
  throw new GithubPrProviderError(code);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("github-pr-metadata-invalid");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string") fail("github-pr-metadata-invalid");
  return value;
}

function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    fail("github-pr-metadata-invalid");
  return value;
}

function oid(value: unknown): string {
  const id = text(value);
  if (!SHA1.test(id)) fail("github-pr-metadata-invalid");
  return id;
}

interface Repository {
  readonly repositoryId: number;
  readonly owner: string;
  readonly repo: string;
}

function repository(value: unknown): Repository {
  const root = record(value);
  const full = text(root.full_name);
  const parts = full.split("/");
  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    !OWNER.test(parts[0]) ||
    !REPO.test(parts[1]) ||
    parts[1].toLowerCase().endsWith(".git") ||
    root.private !== false ||
    (root.visibility !== undefined && root.visibility !== "public")
  )
    fail("github-pr-repository-not-public");
  return { repositoryId: positive(root.id), owner: parts[0], repo: parts[1] };
}

interface PullMetadata {
  readonly number: number;
  readonly state: "open" | "merged";
  readonly target: Repository;
  readonly headRepository: Repository;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly headSha: string;
}

function pull(value: unknown): PullMetadata {
  const root = record(value);
  const state = text(root.state);
  if (state !== "open" && state !== "closed") fail("github-pr-metadata-invalid");
  if (typeof root.merged !== "boolean") fail("github-pr-metadata-invalid");
  if (state === "closed" && root.merged === false) fail("github-pr-closed-unmerged");
  if (state === "open" && root.merged === true) fail("github-pr-metadata-invalid");
  const base = record(root.base);
  const head = record(root.head);
  if (head.repo === null || head.repo === undefined) fail("github-pr-head-unavailable");
  return {
    number: positive(root.number),
    state: state === "open" ? "open" : "merged",
    target: repository(base.repo),
    headRepository: repository(head.repo),
    baseRef: text(base.ref),
    baseSha: oid(base.sha),
    headSha: oid(head.sha),
  };
}

function sameRepository(left: Repository, right: Repository): boolean {
  return (
    left.repositoryId === right.repositoryId &&
    left.owner === right.owner &&
    left.repo === right.repo
  );
}

function sameMetadata(left: PullMetadata, right: PullMetadata): boolean {
  return (
    left.number === right.number &&
    left.state === right.state &&
    sameRepository(left.target, right.target) &&
    sameRepository(left.headRepository, right.headRepository) &&
    left.baseRef === right.baseRef &&
    left.baseSha === right.baseSha &&
    left.headSha === right.headSha
  );
}

/** Git ref path segments remain path segments even when the branch contains '/'. */
function refPath(ref: string): string {
  if (ref.length === 0 || ref.startsWith("/") || ref.endsWith("/") || ref.includes(".."))
    fail("github-pr-base-ref-invalid");
  return ref.split("/").map(encodeURIComponent).join("/");
}

export interface GithubPrObjectSide {
  readonly side: "before" | "after";
  readonly path: string;
  readonly repositoryId: number;
  readonly blobId: string;
  readonly originalSha256: string;
  readonly bytes: Buffer;
  readonly mediaType: string;
}

export interface GithubPrObjectAcquisition {
  readonly ref: ChangeRequestRefV1;
  readonly headRepositoryId: number;
  readonly graph: GithubPrGraph;
  readonly manifest: readonly GithubPrManifestRow[];
  readonly sides: readonly GithubPrObjectSide[];
  readonly metrics: GithubPrAcquisitionMetrics;
  readonly metadataRequests: number;
}

const mintedAcquisitions = new WeakSet<object>();
const scopedAcquisitions = new WeakSet<object>();
const mintedBaseDocumentation = new WeakSet<object>();
const reviewBasisAuthorities = createHostAuthorityFactory<
  "docsfab-github-pr-review-basis-authority",
  { verifyCurrent(value: GithubPrReviewBasis): void }
>({
  kind: "docsfab-github-pr-review-basis-authority",
  invalidMessage: "A GitHub PR review basis requires a live producer verifier.",
});
const mintedReviewBases = new WeakMap<object, ReturnType<typeof reviewBasisAuthorities.create>>();
const baseDocumentationKit = createContractKit<string>({
  fail,
  codes: {
    invalidShape: "github-pr-base-documentation-invalid",
    invalidValue: "github-pr-base-documentation-invalid",
    digestMismatch: "github-pr-base-documentation-invalid",
    credentialMaterial: "github-pr-base-documentation-credential-material",
    schemaMismatch: "github-pr-base-documentation-invalid",
  },
  sizeGovernedBy: "repository.workspaceExportMaxTreeEntries",
});

/** Snapshot/custody builders accept only this process's real producer result. */
export function assertGithubPrObjectAcquisition(value: GithubPrObjectAcquisition): void {
  if (!mintedAcquisitions.has(value) && !scopedAcquisitions.has(value))
    fail("github-pr-acquisition-authority-required");
}

export interface AcquireGithubPrOptions {
  readonly workspaceRoot: string;
  readonly scratchRoot?: string;
  readonly limits?: ResolveLimitsOptions;
  readonly signal?: AbortSignal;
  /** Offline fixture ports; production defaults remain fixed public origins. */
  readonly apiFetch?: GithubFetchPort;
  readonly objectFetch?: GithubPrFetchPort;
}

/** Producer-authenticated target B context; it never grants B-byte citations. */
export interface GithubPrBaseDocumentationDescriptor {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-github-pr-base-documentation";
  readonly targetRepositoryId: number;
  readonly B: string;
  readonly baseTree: string;
  readonly entries: readonly GithubPrVerifiedTreeEntry[];
  readonly descriptorSha256: string;
}

export function assertGithubPrBaseDocumentationDescriptor(
  value: GithubPrBaseDocumentationDescriptor,
): void {
  if (!mintedBaseDocumentation.has(value)) fail("github-pr-base-documentation-authority-required");
}

export interface GithubPrReviewBasis {
  readonly acquisition: GithubPrObjectAcquisition;
  readonly headWorkspace: GithubPrHeadWorkspace;
  readonly headInventory: RepositoryDiscoveryInventoryV1;
  readonly baseDocumentation: GithubPrBaseDocumentationDescriptor;
  /** Abort is cooperative during consumer work; only acquisition/export has a deadline. */
  readonly signal: AbortSignal;
}

/** A structural clone or a basis retained after callback settlement has no authority. */
export function assertGithubPrReviewBasis(value: GithubPrReviewBasis): void {
  const authority = mintedReviewBases.get(value);
  const verifier = authority === undefined ? undefined : reviewBasisAuthorities.lookup(authority);
  if (verifier === undefined) fail("github-pr-review-basis-authority-required");
  verifier.verifyCurrent(value);
}

async function acquireGithubPrObjectsImpl<T>(
  url: string,
  options: AcquireGithubPrOptions,
  consume?: (
    acquired: GithubPrObjectAcquisition,
    reader: GithubPrObjectReader,
    verifyMetadata: () => Promise<number>,
  ) => Promise<T>,
): Promise<GithubPrObjectAcquisition | T> {
  const locator = parseGithubPrLocator(url);
  const api = createGithubApiClient({
    limits: githubApiLimits(options.limits),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.apiFetch ? { fetch: options.apiFetch } : {}),
  });
  const path = `/repos/${locator.owner}/${locator.repository}`;
  const namedTarget = repository((await api.get(path)).body);
  const first = pull((await api.get(`${path}/pulls/${locator.number}`)).body);
  if (
    first.number !== locator.number ||
    !sameRepository(namedTarget, first.target) ||
    first.target.owner.toLowerCase() !== locator.owner.toLowerCase() ||
    first.target.repo.toLowerCase() !== locator.repository.toLowerCase()
  )
    fail("github-pr-target-substituted");
  const checkedTarget = repository(
    (await api.get(`/repositories/${first.target.repositoryId}`)).body,
  );
  const checkedHead = repository(
    (await api.get(`/repositories/${first.headRepository.repositoryId}`)).body,
  );
  if (
    !sameRepository(checkedTarget, first.target) ||
    !sameRepository(checkedHead, first.headRepository)
  )
    fail("github-pr-repository-drift");
  async function baseTip(metadata: PullMetadata): Promise<string> {
    if (metadata.state === "merged") return metadata.baseSha;
    const root = record(
      (
        await api.get(
          `/repositories/${metadata.target.repositoryId}/git/ref/heads/${refPath(metadata.baseRef)}`,
        )
      ).body,
    );
    const object = record(root.object);
    if (object.type !== "commit") fail("github-pr-base-ref-invalid");
    return oid(object.sha);
  }
  const B = await baseTip(first);
  const H = first.headSha;
  const ref = githubPrReference(locator, first.target.repositoryId);
  const reader = await createGithubPrObjectReader(
    {
      target: first.target,
      headRepository: first.headRepository,
      baseTip: B,
      headTip: H,
      workspaceRoot: options.workspaceRoot,
    },
    {
      ...(options.scratchRoot ? { scratchRoot: options.scratchRoot } : {}),
      ...(options.limits ? { limits: options.limits } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.objectFetch ? { fetchPort: options.objectFetch } : {}),
    },
  );
  const sides: GithubPrObjectSide[] = [];
  let primaryFailure: unknown;
  let failed = false;
  try {
    await reader.acquireTips();
    const graph = await reader.resolveGraph();
    await reader.acquireTreesAndBlobs();
    const manifest = await reader.enumerate();
    for (const row of manifest) {
      for (const side of ["before", "after"] as const) {
        const path = side === "before" ? row.oldPath : row.newPath;
        const id = side === "before" ? row.oldId : row.newId;
        const mode = side === "before" ? row.oldMode : row.newMode;
        if (path === null || id === null || (mode !== "100644" && mode !== "100755")) continue;
        const mediaType = classifySourceMediaType(path);
        if (mediaType !== "text/markdown" && mediaType !== "text/mdx") continue;
        const bytes = Buffer.from(await reader.readObject(id, "blob"));
        sides.push({
          side,
          path,
          repositoryId:
            side === "before" ? first.target.repositoryId : first.headRepository.repositoryId,
          blobId: id,
          originalSha256: createHash("sha256").update(bytes).digest("hex"),
          bytes,
          mediaType,
        });
      }
    }
    async function verifyMetadata(): Promise<number> {
      const last = pull((await api.get(`${path}/pulls/${locator.number}`)).body);
      const lastB = await baseTip(last);
      const lastTarget = repository(
        (await api.get(`/repositories/${last.target.repositoryId}`)).body,
      );
      const lastHead = repository(
        (await api.get(`/repositories/${last.headRepository.repositoryId}`)).body,
      );
      if (
        !sameMetadata(first, last) ||
        B !== lastB ||
        !sameRepository(lastTarget, first.target) ||
        !sameRepository(lastHead, first.headRepository)
      )
        fail("github-pr-metadata-drift");
      return api.requests();
    }
    await verifyMetadata();
    const measured = reader.measurements();
    const acquired: GithubPrObjectAcquisition = Object.freeze({
      ref,
      headRepositoryId: first.headRepository.repositoryId,
      graph: Object.freeze({ ...graph }),
      manifest: Object.freeze(manifest.map((row) => Object.freeze({ ...row }))),
      sides: Object.freeze(sides.map((side) => Object.freeze({ ...side }))),
      metrics: Object.freeze({
        ...measured,
        effectiveLimits: Object.freeze({ ...measured.effectiveLimits }),
      }),
      metadataRequests: api.requests(),
    });
    if (consume === undefined) {
      mintedAcquisitions.add(acquired);
      return acquired;
    }
    scopedAcquisitions.add(acquired);
    try {
      return await consume(acquired, reader, verifyMetadata);
    } finally {
      scopedAcquisitions.delete(acquired);
      for (const side of sides) side.bytes.fill(0);
    }
  } catch (error) {
    failed = true;
    primaryFailure = error;
    for (const side of sides) side.bytes.fill(0);
    throw error;
  } finally {
    try {
      await reader.dispose();
    } catch (cleanupError) {
      if (failed)
        throw new AggregateError(
          [primaryFailure, cleanupError],
          "GitHub PR acquisition and private reader cleanup both failed.",
        );
      throw cleanupError;
    }
  }
}

/** Legacy returned acquisition remains valid after its disposable reader closes. */
export async function acquireGithubPrObjects(
  url: string,
  options: AcquireGithubPrOptions,
): Promise<GithubPrObjectAcquisition> {
  return acquireGithubPrObjectsImpl(url, options) as Promise<GithubPrObjectAcquisition>;
}

/** Use one bounded reader for immutable M..H sides and a registered full H workspace. */
export async function withGithubPrReviewBasis<T>(
  url: string,
  options: AcquireGithubPrOptions,
  consume: (basis: GithubPrReviewBasis) => Promise<T>,
): Promise<T> {
  return acquireGithubPrObjectsImpl(url, options, async (acquired, reader, verifyMetadata) => {
    const port = await reader.exportVerifiedHeadTree();
    await verifyMetadata();
    const manifestSha256 = canonicalDigest(acquired.manifest);
    if (manifestSha256 !== port.manifestSha256) fail("github-pr-manifest-drift");
    const sourceIdentitySha256 = port.sourceIdentitySha256;
    const workspace = await prepareRepositoryWorkspaceFromVerifiedTree(
      port,
      {
        sourceIdentitySha256,
        manifestSha256,
      },
      { resolvedLimits: options.limits },
    );
    const measured = reader.measurements();
    let scopedAcquired: GithubPrObjectAcquisition | undefined;
    let baseDocumentation: GithubPrBaseDocumentationDescriptor | undefined;
    let basisActive = false;
    let primaryFailure: unknown;
    let failed = false;
    try {
      const headInventory = await buildRepositoryDiscoveryInventory({
        workspace,
        limits: options.limits,
      });
      const entries = Object.freeze(
        port.baseDocumentation.map((entry) => Object.freeze({ ...entry })),
      );
      const descriptorBody = {
        targetRepositoryId: port.targetRepositoryId,
        B: port.B,
        baseTree: port.baseTree,
        entries,
      };
      baseDocumentationKit.assertInert(descriptorBody);
      baseDocumentationKit.rejectCredentials(descriptorBody);
      baseDocumentation = baseDocumentationKit.seal(
        "docsfab-github-pr-base-documentation",
        "descriptorSha256",
        descriptorBody,
      );
      mintedBaseDocumentation.add(baseDocumentation);
      port.checkActive();
      const metadataRequests = await verifyMetadata();
      scopedAcquired = Object.freeze({
        ...acquired,
        metadataRequests,
        metrics: Object.freeze({
          ...measured,
          effectiveLimits: Object.freeze({ ...measured.effectiveLimits }),
        }),
      });
      scopedAcquisitions.add(scopedAcquired);
      const basis: GithubPrReviewBasis = Object.freeze({
        acquisition: scopedAcquired,
        headWorkspace: workspace,
        headInventory,
        baseDocumentation,
        signal: options.signal ?? new AbortController().signal,
      });
      basisActive = true;
      mintedReviewBases.set(
        basis,
        reviewBasisAuthorities.create({
          verifyCurrent(value) {
            if (!basisActive || value !== basis) fail("github-pr-review-basis-authority-required");
            assertGithubPrObjectAcquisition(basis.acquisition);
            assertGithubPrBaseDocumentationDescriptor(basis.baseDocumentation);
          },
        }),
      );
      port.checkActive();
      return await consume(basis);
    } catch (error) {
      failed = true;
      primaryFailure = error;
      throw error;
    } finally {
      basisActive = false;
      if (scopedAcquired !== undefined) scopedAcquisitions.delete(scopedAcquired);
      if (baseDocumentation !== undefined) mintedBaseDocumentation.delete(baseDocumentation);
      try {
        const settled = await closeScopedRepositoryWorkspace(workspace);
        if (!settled) fail("github-pr-workspace-lease-unsettled");
      } catch (cleanupError) {
        if (failed)
          throw new AggregateError(
            [primaryFailure, cleanupError],
            "GitHub PR review basis and scoped workspace cleanup both failed.",
          );
        throw cleanupError;
      }
    }
  }) as Promise<T>;
}
