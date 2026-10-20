// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { limit, refuseLimit, type ResolvedLimit } from "../config/limits.js";
import { canonicalDigest, createHostAuthorityFactory, deepFreeze } from "../contract-kit/index.js";
import { WorkflowChecksHostOperation } from "./workflow-checks.js";
import type { HostOperationExecutor } from "../execution/contracts.js";
import type { ChangeEvidence } from "../impact/contracts.js";
import {
  createAuthoringCandidate,
  decodeAuthoringCandidate,
  type AuthoringCandidateV1,
} from "./authoring-candidate.js";
import {
  repositoryChangeWriteEffectPaths,
  type RepositoryCandidateArtifactIdentityV1,
  type RepositoryTarget,
} from "../repository/contracts.js";
import { GitPatchEvidenceCollector } from "../repository/evidence.js";
import { RepositoryEvidenceProvenanceError } from "../repository/contracts.js";
import { prepareRepositoryWorkspace } from "../repository/workspace/materialize.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import {
  listTrackedRepositoryEntries,
  listTrackedRepositoryFileSnapshotMetadata,
  admitAuthorizedTrackedWrites,
  readTrackedRepositoryFile,
  TRACKED_WRITE_ADMISSION_MAX_BYTES_LIMIT,
  trackedRepositoryBlobObjectId,
  trackedRepositoryEntryKind,
  verifyActiveRepositoryWorkspace,
} from "../repository/workspace/tracked-read.js";
import {
  CreateTargetExistsError,
  type DocumentationPlanCreateConversionV1,
  type PlannedTargetCollisionV1,
} from "./plan-binding.js";
import { LocalWorkflowSearchCoordinator } from "../search/local-workflow-coordinator.js";
import { LocalSourceObligationSourceObserver } from "./source-obligation-observer.js";
import type { SourceObligationLedger } from "./source-obligation.js";

const PLANNED_PAGE_MAX_BYTES = "authoring.plannedPageMaxBytes";
const SNAPSHOT_MAX_ENTRIES = "authoring.workspaceSnapshotMaxEntries";
const SNAPSHOT_MAX_BYTES = "authoring.workspaceSnapshotMaxBytes";
const CANDIDATE_PATCH_MAX_BYTES = "authoring.candidatePatchMaxBytes";
const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export interface AuthoringWorkspaceSnapshotEntryV1 {
  readonly path: string;
  readonly kind: "regular" | "symlink" | "submodule";
  readonly mode: number | null;
  readonly byteLength: number | null;
  readonly sha256: string | null;
}

export interface AuthoringWorkspaceSnapshotV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-authoring-workspace-snapshot";
  readonly entries: readonly AuthoringWorkspaceSnapshotEntryV1[];
  readonly totalBytes: number;
  readonly digest: string;
}

export interface AuthoringCandidateCaptureInputV1 {
  readonly candidate: AuthoringCandidateV1;
  readonly workspace: RepositoryWorkspace;
  readonly repository: RepositoryTarget;
  /** Must have been created before the candidate writer changed the workspace. */
  readonly evidenceCollector: GitPatchEvidenceCollector;
  readonly sourceLedger: SourceObligationLedger;
  readonly signal?: AbortSignal;
}

export interface AuthoringCandidateSealInputV1 {
  readonly runId: string;
  readonly ordinal: 0 | 1;
  readonly originalRevision: string;
  readonly planDigest: string;
  readonly writePaths: readonly string[];
  readonly workspace: RepositoryWorkspace;
  readonly repository: RepositoryTarget;
  /** Must have been created before the candidate writer changed the workspace. */
  readonly evidenceCollector: GitPatchEvidenceCollector;
  readonly sourceLedger: SourceObligationLedger;
  readonly signal?: AbortSignal;
}

export interface AuthoringCandidateCaptureV1 {
  readonly candidate: AuthoringCandidateV1;
  readonly evidence: ChangeEvidence;
  readonly snapshot: AuthoringWorkspaceSnapshotV1;
  /** Opaque process-local proof that this exact capture passed host admission. */
  readonly authority: AuthoringCandidateCaptureAuthorityV1;
}

export interface AuthoringCandidateCaptureAuthorityV1 {
  readonly kind: "docsfab-authoring-candidate-capture-authority";
}

/**
 * Whether the run's write grant covers modifying an existing page, given its
 * Git blob object ID at the revision. Local runs have no such grant to consult.
 */
export type AuthoringUpdateGrantV1 = (target: {
  readonly path: string;
  readonly objectId: string;
}) => boolean;

export interface AuthoringRevisionWorkspaceInputV1 {
  readonly runId: string;
  readonly candidate0: AuthoringCandidateCaptureV1;
  /**
   * The admitted plan's CREATE-to-UPDATE conversion, when it has one: the one
   * planned page reconstruction replaces instead of creating.
   */
  readonly createConvertedToUpdate?: Pick<
    DocumentationPlanCreateConversionV1,
    "path" | "baseSha256"
  >;
  readonly sourceWorkspace: RepositoryWorkspace;
  readonly repository: RepositoryTarget;
  readonly sourceLedger: SourceObligationLedger;
  readonly artifactDirectory: string;
  readonly signal?: AbortSignal;
}

export interface AuthoringRevisionWorkspaceV1 {
  readonly candidate0: AuthoringCandidateCaptureV1;
  readonly workspace: RepositoryWorkspace;
  readonly evidenceCollector: GitPatchEvidenceCollector;
  readonly sourceObserver: LocalSourceObligationSourceObserver;
  readonly searchCoordinator: LocalWorkflowSearchCoordinator;
  readonly hostOperations: HostOperationExecutor;
  /** Opaque process-local proof binding this handle to its issued host lifecycle. */
  readonly authority: AuthoringRevisionWorkspaceAuthorityV1;
  dispose(): Promise<void>;
}

export interface AuthoringRevisionWorkspaceAuthorityV1 {
  readonly kind: "docsfab-authoring-revision-workspace-authority";
}

export interface AuthoringFailedPartialCaptureV1 {
  readonly selected: false;
  readonly evidence: ChangeEvidence;
  readonly workspaceSnapshotDigest: string | null;
}

interface AuthoringCandidateCaptureVerifier {
  verifyCurrent(): void;
  admittedCapture(): AuthoringCandidateCaptureV1 | undefined;
  selectedPromotionAllowed(): boolean;
}

interface AuthoringRevisionWorkspaceBoundStateV1 {
  readonly candidate0: AuthoringCandidateCaptureV1;
  readonly workspace: RepositoryWorkspace;
  readonly evidenceCollector: GitPatchEvidenceCollector;
  readonly sourceObserver: LocalSourceObligationSourceObserver;
  readonly searchCoordinator: LocalWorkflowSearchCoordinator;
  readonly hostOperations: HostOperationExecutor;
  readonly repository: RepositoryTarget;
  readonly sourceLedger: SourceObligationLedger;
  disposed: boolean;
}

interface AuthoringRevisionWorkspaceVerifier {
  verifyCurrent(): void;
  issuedWorkspace(): AuthoringRevisionWorkspaceV1 | undefined;
  boundState(): AuthoringRevisionWorkspaceBoundStateV1;
}

const captureAuthorities = createHostAuthorityFactory<
  AuthoringCandidateCaptureAuthorityV1["kind"],
  AuthoringCandidateCaptureVerifier
>({
  kind: "docsfab-authoring-candidate-capture-authority",
  invalidMessage: "Authoring candidate capture authority verifier is invalid.",
});

const revisionWorkspaceAuthorities = createHostAuthorityFactory<
  AuthoringRevisionWorkspaceAuthorityV1["kind"],
  AuthoringRevisionWorkspaceVerifier
>({
  kind: "docsfab-authoring-revision-workspace-authority",
  invalidMessage: "Authoring revision workspace authority verifier is invalid.",
});

function admitCandidateCapture(
  candidate: AuthoringCandidateV1,
  evidence: ChangeEvidence,
  snapshot: AuthoringWorkspaceSnapshotV1,
  selectedPromotionAllowed: boolean,
): AuthoringCandidateCaptureV1 {
  let admitted: AuthoringCandidateCaptureV1 | undefined;
  const verifier: AuthoringCandidateCaptureVerifier = {
    verifyCurrent(): void {
      if (admitted === undefined) {
        throw new Error("The authoring candidate capture authority is no longer current.");
      }
    },
    admittedCapture(): AuthoringCandidateCaptureV1 | undefined {
      return admitted;
    },
    selectedPromotionAllowed(): boolean {
      return selectedPromotionAllowed;
    },
  };
  const authority = captureAuthorities.create(verifier) as AuthoringCandidateCaptureAuthorityV1;
  admitted = deepFreeze({
    candidate,
    evidence: structuredClone(evidence),
    snapshot: structuredClone(snapshot),
    authority,
  });
  return admitted;
}

function requireAdmittedCandidateCapture(
  capture: AuthoringCandidateCaptureV1,
  options: { readonly requireSelectedPromotion?: boolean } = {},
): AuthoringCandidateCaptureV1 {
  const verifier = captureAuthorities.lookup(capture.authority);
  verifier?.verifyCurrent();
  if (!verifier || verifier.admittedCapture() !== capture) {
    throw new Error("Selected authoring candidate capture lacks host admission authority.");
  }
  if (options.requireSelectedPromotion && !verifier.selectedPromotionAllowed()) {
    throw new Error(
      "Revised authoring candidate has not passed its bound lifecycle admission for selected promotion.",
    );
  }
  return capture;
}

/** Read-only validation of the host's existing opaque candidate capture authority. */
export function assertAuthoringCandidateCaptureAuthority(
  capture: AuthoringCandidateCaptureV1,
): void {
  requireAdmittedCandidateCapture(capture);
}

/** Captures bounded filesystem facts and seals the candidate in one host operation. */
export async function sealAuthoringCandidate(
  input: AuthoringCandidateSealInputV1,
): Promise<AuthoringCandidateCaptureV1> {
  await assertWorkspaceBinding(input.workspace, input.repository);
  throwIfAborted(input.signal);
  if (input.originalRevision !== input.repository.revision) {
    throw new Error("Authoring candidate original revision does not match the repository binding.");
  }
  const candidateLike = {
    runId: input.runId,
    ordinal: input.ordinal,
    originalRevision: input.originalRevision,
    planDigest: input.planDigest,
    writePaths: input.writePaths,
  };
  for (const path of input.writePaths) assertSafePath(path);
  const sourcePaths = new Set(input.sourceLedger.identity.sources.map((source) => source.path));
  if (input.writePaths.some((path) => sourcePaths.has(path))) {
    throw new Error("Authoring candidate write paths intersect immutable source evidence.");
  }
  await assertOriginalSourcesUnchanged(input.workspace, input.sourceLedger);
  await refuseUnadmittablePlannedPages(input.workspace, input.writePaths);
  const admitted = await admitAuthorizedTrackedWrites(input.workspace, input.writePaths);
  if (!sameStrings(admitted, input.writePaths)) {
    throw new Error("Authoring candidate did not materialize every planned output path.");
  }
  const snapshot = await captureAuthoringWorkspaceSnapshot(input.workspace);
  throwIfAborted(input.signal);
  const evidence = await capturePatch(
    input.evidenceCollector,
    input.runId,
    input.repository,
    input.workspace.path,
    input.writePaths,
    input.ordinal === 0 ? "candidate0" : "candidate1",
  );
  const patch = evidence.patch;
  if (!patch) throw new Error("Authoring candidate patch capture did not retain durable evidence.");
  const candidate = createAuthoringCandidate({
    ...candidateLike,
    patchDigestSha256: patch.sha256,
    patchBytes: patch.byteLength,
    workspaceSnapshotDigest: snapshot.digest,
  });
  assertCandidatePatch(candidate, evidence);
  throwIfAborted(input.signal);
  return admitCandidateCapture(candidate, evidence, snapshot, input.ordinal === 0);
}

export async function prepareAuthoringRevisionWorkspace(
  input: AuthoringRevisionWorkspaceInputV1,
): Promise<AuthoringRevisionWorkspaceV1> {
  requireAdmittedCandidateCapture(input.candidate0);
  await assertWorkspaceBinding(input.sourceWorkspace, input.repository);
  assertCandidateIdentity(input.candidate0.candidate, input.runId, 0);
  assertCandidateRepositoryBinding(input.candidate0.candidate, input.repository);
  assertCandidatePatch(input.candidate0.candidate, input.candidate0.evidence);
  assertSnapshotDigest(
    input.candidate0.snapshot,
    input.candidate0.candidate.workspaceSnapshotDigest,
  );
  assertSourceScope(input.candidate0.candidate, input.sourceLedger, input.repository);
  throwIfAborted(input.signal);
  await assertOriginalSourcesUnchanged(input.sourceWorkspace, input.sourceLedger);
  const child = await prepareRepositoryWorkspace(
    input.repository.sourcePath,
    input.repository.revision,
  );
  let collector: GitPatchEvidenceCollector | undefined;
  try {
    await assertWorkspaceBinding(child, input.repository);
    collector = await GitPatchEvidenceCollector.create(child.path, input.artifactDirectory);
    const sourceObserver = new LocalSourceObligationSourceObserver(child);
    await sourceObserver.assertUnchanged(input.sourceLedger.identity.sources);
    await copyPlannedOutputs(
      input.sourceWorkspace,
      child,
      input.candidate0.candidate,
      input.candidate0.snapshot,
      input.createConvertedToUpdate,
      input.signal,
    );
    throwIfAborted(input.signal);
    const snapshot = await captureAuthoringWorkspaceSnapshot(
      child,
      input.candidate0.candidate.writePaths,
    );
    assertSnapshotDigest(snapshot, input.candidate0.candidate.workspaceSnapshotDigest);
    if (snapshot.digest !== input.candidate0.snapshot.digest) {
      throw new Error("Revision workspace does not reproduce the complete candidate-0 snapshot.");
    }
    await sourceObserver.assertUnchanged(input.sourceLedger.identity.sources);
    throwIfAborted(input.signal);
    const workspace = child;
    const searchCoordinator = new LocalWorkflowSearchCoordinator({ workspace });
    const hostOperations = new WorkflowChecksHostOperation(workspace, "lint-revised-documentation");
    const state: AuthoringRevisionWorkspaceBoundStateV1 = {
      candidate0: input.candidate0,
      workspace,
      evidenceCollector: collector,
      sourceObserver,
      searchCoordinator,
      hostOperations,
      repository: deepFreeze(structuredClone(input.repository)),
      sourceLedger: deepFreeze(structuredClone(input.sourceLedger)),
      disposed: false,
    };
    let issued: AuthoringRevisionWorkspaceV1 | undefined;
    const verifier: AuthoringRevisionWorkspaceVerifier = {
      verifyCurrent(): void {
        if (!issued || state.disposed) {
          throw new Error("The authoring revision workspace authority is no longer current.");
        }
      },
      issuedWorkspace(): AuthoringRevisionWorkspaceV1 | undefined {
        return issued;
      },
      boundState(): AuthoringRevisionWorkspaceBoundStateV1 {
        return state;
      },
    };
    const authority = revisionWorkspaceAuthorities.create(
      verifier,
    ) as AuthoringRevisionWorkspaceAuthorityV1;
    issued = Object.freeze({
      candidate0: state.candidate0,
      workspace: state.workspace,
      evidenceCollector: state.evidenceCollector,
      sourceObserver: state.sourceObserver,
      searchCoordinator: state.searchCoordinator,
      hostOperations: state.hostOperations,
      authority,
      async dispose(): Promise<void> {
        if (state.disposed) return;
        state.disposed = true;
        await disposeRevisionResources(state.evidenceCollector, state.workspace);
      },
    });
    return issued;
  } catch (error) {
    try {
      await disposeRevisionResources(collector, child);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Authoring revision workspace preparation failed and cleanup was incomplete.",
        { cause: error },
      );
    }
    throw error;
  }
}

export async function admitAuthoringCandidate1(
  workspace: AuthoringRevisionWorkspaceV1,
  candidate: AuthoringCandidateV1,
  repository: RepositoryTarget,
  sourceLedger: SourceObligationLedger,
  signal?: AbortSignal,
): Promise<AuthoringCandidateCaptureV1> {
  const bound = requireIssuedRevisionWorkspace(workspace);
  assertSameRepositoryTarget(repository, bound.repository);
  assertSameSourceLedger(sourceLedger, bound.sourceLedger);
  decodeAuthoringCandidate(candidate);
  await assertWorkspaceBinding(bound.workspace, bound.repository);
  assertCandidateIdentity(candidate, bound.candidate0.candidate.runId, 1);
  assertCandidateRepositoryBinding(candidate, bound.repository);
  assertSameCandidatePlan(candidate, bound.candidate0.candidate);
  assertSourceScope(candidate, bound.sourceLedger, bound.repository);
  await bound.sourceObserver.assertUnchanged(bound.sourceLedger.identity.sources);
  throwIfAborted(signal);
  await refuseUnadmittablePlannedPages(bound.workspace, candidate.writePaths);
  const admitted = await admitAuthorizedTrackedWrites(bound.workspace, candidate.writePaths);
  if (!sameStrings(admitted, candidate.writePaths)) {
    throw new Error("Revised authoring candidate did not materialize every planned output path.");
  }
  const snapshot = await captureAuthoringWorkspaceSnapshot(bound.workspace);
  assertSnapshotDigest(snapshot, candidate.workspaceSnapshotDigest);
  const evidence = await capturePatch(
    bound.evidenceCollector,
    candidate.runId,
    bound.repository,
    bound.workspace.path,
    candidate.writePaths,
    "candidate1",
  );
  assertCandidatePatch(candidate, evidence);
  await bound.sourceObserver.assertUnchanged(bound.sourceLedger.identity.sources);
  throwIfAborted(signal);
  return admitCandidateCapture(candidate, evidence, snapshot, true);
}

export async function captureFailedAuthoringPartial(
  workspace: AuthoringRevisionWorkspaceV1,
  repository: RepositoryTarget,
  signal?: AbortSignal,
): Promise<AuthoringFailedPartialCaptureV1> {
  const bound = requireIssuedRevisionWorkspace(workspace);
  assertSameRepositoryTarget(repository, bound.repository);
  await assertWorkspaceBinding(bound.workspace, bound.repository);
  let evidence: ChangeEvidence;
  try {
    evidence = await bound.evidenceCollector.capture({
      runId: bound.candidate0.candidate.runId,
      repository: bound.repository,
      workspacePath: bound.workspace.path,
      persistPatch: true,
      candidateArtifact: { kind: "failed-partial" },
    });
  } catch (error) {
    if (error instanceof RepositoryEvidenceProvenanceError) {
      return deepFreeze({
        selected: false as const,
        evidence: structuredClone(error.evidence),
        workspaceSnapshotDigest: null,
      });
    }
    throw error;
  }
  const candidate0 = bound.candidate0.candidate;
  const changedPaths = repositoryChangeWriteEffectPaths(evidence.files);
  const hasProvenanceDamage =
    changedPaths.some((path) => !candidate0.writePaths.includes(path)) ||
    evidence.files.some((file) => file.status === "deleted");
  if (hasProvenanceDamage) {
    return deepFreeze({
      selected: false as const,
      evidence: structuredClone(evidence),
      workspaceSnapshotDigest: null,
    });
  }
  // Partial retention is permitted after cancellation, so the caller can
  // record already-written bytes without authorizing another model step.
  const snapshot = await captureAuthoringWorkspaceSnapshot(bound.workspace, candidate0.writePaths);
  return deepFreeze({
    selected: false as const,
    evidence: structuredClone(evidence),
    workspaceSnapshotDigest: snapshot.digest,
  });
}

/**
 * The revision workspace's snapshot, taken without sealing candidate 1, for
 * the in-attempt accounting check; sealing later repeats every admission
 * check. The tracked snapshot cannot see untracked paths, so the whole
 * workspace is walked first and an entry candidate 0 lacks is refused.
 */
export async function observeAuthoringRevisionWorkspace(
  workspace: AuthoringRevisionWorkspaceV1,
  signal?: AbortSignal,
): Promise<AuthoringWorkspaceSnapshotV1> {
  const bound = requireIssuedRevisionWorkspace(workspace);
  await assertWorkspaceBinding(bound.workspace, bound.repository);
  throwIfAborted(signal);
  await assertOnlyCandidate0Entries(bound.workspace.path, bound.candidate0.snapshot);
  return captureAuthoringWorkspaceSnapshot(bound.workspace, bound.candidate0.candidate.writePaths);
}

/**
 * Refuse any entry in the revision workspace that candidate 0 does not have:
 * a file, a symbolic link, a directory, or anything else.
 *
 * The workspace is a tracked-blob export with no `.git` (the patch collector
 * keeps it outside), no ignored or generated files, and no materialized
 * symlinks or submodules, so nothing is excluded from the walk: a `.git` entry
 * refuses like any other. The walk does not follow links or descend into an
 * unadmitted entry.
 */
async function assertOnlyCandidate0Entries(
  root: string,
  snapshot: AuthoringWorkspaceSnapshotV1,
): Promise<void> {
  const files = new Set(
    snapshot.entries.filter((entry) => entry.kind === "regular").map((entry) => entry.path),
  );
  const directories = new Set<string>();
  for (const path of files) {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      directories.add(parts.slice(0, depth).join("/"));
    }
  }
  const pending = [""];
  while (pending.length > 0) {
    const relative = pending.pop()!;
    const entries = await readdir(relative ? join(root, ...relative.split("/")) : root, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory() && directories.has(path)) {
        pending.push(path);
      } else if (!(entry.isFile() && files.has(path))) {
        throw new Error(
          "The authoring revision workspace contains an entry that candidate 0 does not have.",
        ); // hygiene: ok -- host integrity refusal; the runner codes it as a revision replay fault.
      }
    }
  }
}

/**
 * Restore every planned page in the revision workspace to sealed candidate 0
 * before a bounded retry of the revision writer.
 *
 * Bytes come from the source workspace, which still holds candidate 0. Each
 * page is replaced, not written through: a planned page or parent that is no
 * longer a plain file or directory refuses. The restore succeeds only when no
 * extra entry exists, the tracked snapshot equals candidate 0's, and the
 * original sources are unchanged, so a retry starts from the first attempt's
 * input.
 */
export async function resetAuthoringRevisionWorkspace(
  workspace: AuthoringRevisionWorkspaceV1,
  sourceWorkspace: RepositoryWorkspace,
  signal?: AbortSignal,
): Promise<void> {
  const bound = requireIssuedRevisionWorkspace(workspace);
  await assertWorkspaceBinding(bound.workspace, bound.repository);
  await assertWorkspaceBinding(sourceWorkspace, bound.repository);
  const candidate0 = bound.candidate0;
  const pages = candidate0.candidate.writePaths.map((path) => {
    assertSafePath(path);
    const expected = candidate0.snapshot.entries.find((entry) => entry.path === path);
    if (!expected || expected.kind !== "regular" || expected.mode === null) {
      throw new Error("Candidate-0 snapshot omitted a planned output path during revision reset."); // hygiene: ok -- host integrity refusal; the runner codes it as authoring-revision-reset-failed.
    }
    return { path, mode: expected.mode, byteLength: expected.byteLength ?? 0 };
  });
  // Every page is checked before the first restore, so a refusal leaves the
  // workspace exactly as the writer left it.
  const pageBound = refuseOversizedPlannedPages(pages);
  for (const { path, mode } of pages) {
    throwIfAborted(signal);
    const bytes = await readTrackedRepositoryFile(sourceWorkspace, path, pageBound.value);
    const segments = path.split("/");
    await assertPlainDirectoryChain(bound.workspace.path, segments.slice(0, -1));
    const destination = join(bound.workspace.path, ...segments);
    const existing = await lstat(destination).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (existing && !existing.isFile()) {
      throw new Error(
        "A planned revision page is no longer a regular file, so it cannot be restored.",
      ); // hygiene: ok -- host integrity refusal; the runner codes it as authoring-revision-reset-failed.
    }
    await rm(destination, { force: true });
    await writeFile(destination, bytes, { flag: "wx", mode: 0o644 });
    await chmod(destination, mode);
  }
  throwIfAborted(signal);
  await assertOnlyCandidate0Entries(bound.workspace.path, candidate0.snapshot);
  const snapshot = await captureAuthoringWorkspaceSnapshot(
    bound.workspace,
    candidate0.candidate.writePaths,
  );
  if (snapshot.digest !== candidate0.snapshot.digest) {
    throw new Error(
      "Revision workspace reset did not reproduce the complete candidate-0 snapshot.",
    ); // hygiene: ok -- host integrity refusal; the runner codes it as authoring-revision-reset-failed.
  }
  await bound.sourceObserver.assertUnchanged(bound.sourceLedger.identity.sources);
}

/** Refuse a restore through anything but plain directories below the workspace root. */
async function assertPlainDirectoryChain(
  root: string,
  directories: readonly string[],
): Promise<void> {
  let current = root;
  for (const segment of directories) {
    current = join(current, segment);
    const entry = await lstat(current).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (entry === undefined) {
      await mkdir(current);
    } else if (!entry.isDirectory()) {
      throw new Error(
        "A planned revision page's parent is no longer a plain directory, so it cannot be restored.",
      ); // hygiene: ok -- host integrity refusal; the runner codes it as authoring-revision-reset-failed.
    }
  }
}

export async function materializeSelectedAuthoringEvidence(
  capture: AuthoringCandidateCaptureV1,
  expected: {
    readonly candidate: AuthoringCandidateV1;
    readonly repository: RepositoryTarget;
    readonly workspace: RepositoryWorkspace;
  },
): Promise<ChangeEvidence> {
  requireAdmittedCandidateCapture(capture, { requireSelectedPromotion: true });
  decodeAuthoringCandidate(expected.candidate);
  await assertWorkspaceBinding(expected.workspace, expected.repository);
  assertCandidateRepositoryBinding(capture.candidate, expected.repository);
  assertCandidateRepositoryBinding(expected.candidate, expected.repository);
  if (capture.candidate.digest !== expected.candidate.digest) {
    throw new Error("Selected authoring candidate identity does not match retained evidence.");
  }
  let current: AuthoringWorkspaceSnapshotV1;
  try {
    current = await captureAuthoringWorkspaceSnapshot(expected.workspace);
  } catch {
    throw new Error("Selected authoring workspace snapshot changed after evidence admission.");
  }
  assertSnapshotDigest(capture.snapshot, capture.candidate.workspaceSnapshotDigest);
  if (
    current.digest !== capture.snapshot.digest ||
    current.digest !== capture.candidate.workspaceSnapshotDigest
  ) {
    throw new Error("Selected authoring workspace snapshot changed after evidence admission.");
  }
  assertCandidateEvidenceScope(capture.candidate, capture.evidence);
  const patch = capture.evidence.patch;
  if (!patch) throw new Error("Selected authoring candidate has no durable patch evidence.");
  if (patch.sha256 !== capture.candidate.patchDigestSha256) {
    throw new Error("Selected authoring patch digest does not match candidate identity.");
  }
  if (patch.byteLength !== capture.candidate.patchBytes) {
    throw new Error("Selected authoring patch size does not match candidate identity.");
  }
  const expectedArtifactName = `${capture.candidate.runId}.candidate${capture.candidate.ordinal}.patch`;
  if (basename(patch.artifactPath) !== expectedArtifactName) {
    throw new Error(
      "Selected authoring patch artifact does not match its admitted candidate slot.",
    );
  }
  const bytes = await readImmutablePatchArtifact(
    patch.artifactPath,
    patch.byteLength,
    patch.sha256,
  );
  const finalPath = join(dirname(patch.artifactPath), `${capture.candidate.runId}.patch`);
  await persistImmutableFile(finalPath, bytes);
  const retainedEvidence = structuredClone(capture.evidence);
  return {
    ...retainedEvidence,
    patch: { ...patch, artifactPath: finalPath },
  };
}

export async function readImmutablePatchArtifact(
  artifactPath: string,
  expectedBytes: number,
  expectedSha256: string,
): Promise<Buffer> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || !SHA256.test(expectedSha256)) {
    throw new Error(
      "Selected authoring patch artifact has invalid bounded metadata and cannot be trusted for delivery.",
    );
  }
  const patchBound = limit(CANDIDATE_PATCH_MAX_BYTES);
  if (expectedBytes > patchBound.value) refuseLimit(patchBound, expectedBytes);
  const absolute = resolve(artifactPath);
  if (absolute !== artifactPath) {
    throw new Error("Selected authoring patch artifact path is not canonical.");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(absolute);
    assertPrivatePatchStat(before, expectedBytes);
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    handle = await open(absolute, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    assertPrivatePatchStat(opened, expectedBytes);
    const bytes = Buffer.allocUnsafe(expectedBytes);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, null);
      if (result.bytesRead === 0)
        throw new Error("Patch artifact bytes were truncated during bounded read.");
      offset += result.bytesRead;
    }
    const extra = Buffer.alloc(1);
    const extraRead = await handle.read(extra, 0, 1, null);
    const after = await handle.stat();
    const pathAfter = await lstat(absolute);
    assertPrivatePatchStat(after, expectedBytes);
    if (
      extraRead.bytesRead !== 0 ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino ||
      createHash("sha256").update(bytes).digest("hex") !== expectedSha256
    ) {
      throw new Error("Selected patch artifact changed during its bounded read operation.");
    }
    return bytes;
  } catch {
    throw new Error(
      "Selected authoring patch artifact changed after admission and cannot be trusted for delivery.",
    );
  } finally {
    await handle?.close();
  }
}

function assertPrivatePatchStat(
  metadata: Awaited<ReturnType<typeof lstat>>,
  expectedBytes: number,
): void {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size !== expectedBytes ||
    (Number(metadata.mode) & 0o077) !== 0
  ) {
    throw new Error("Patch artifact metadata is unsafe for immutable retention.");
  }
}

async function persistImmutableFile(destination: string, bytes: Buffer): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await link(temporary, destination);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      await readImmutablePatchArtifact(
        destination,
        bytes.byteLength,
        createHash("sha256").update(bytes).digest("hex"),
      );
      return;
    }
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * The planned CREATE targets the workspace's exact revision export already
 * holds: the path itself, a directory at the path, or a file at one of its
 * ancestors. Paths compare case-insensitively, as a case-insensitive file
 * system resolves them. A collision carries `base`, the page's content
 * digest, only when the exact path is the one tracked regular file that folds
 * to it and `updateGrant`, when given, allows modifying it: plan admission
 * converts that one into an UPDATE and refuses every other kind before any
 * page is written.
 *
 * Valid only before the run's first write: admitted writes rewrite the
 * workspace's tracked entries.
 */
export async function plannedTargetCollisions(
  workspace: RepositoryWorkspace,
  writePaths: readonly string[],
  updateGrant?: AuthoringUpdateGrantV1,
): Promise<readonly PlannedTargetCollisionV1[]> {
  const fold = (path: string) => path.toLowerCase();
  const tracked = (await listTrackedRepositoryEntries(workspace)).flatMap((entry) =>
    entry.path === undefined ? [] : [fold(entry.path)],
  );
  const files = new Set(tracked);
  const collisions: PlannedTargetCollisionV1[] = [];
  for (const path of [...new Set(writePaths)].sort()) {
    assertSafePath(path);
    const folded = fold(path);
    // An excluded entry is listed without its path; ask for this exact one.
    const exactKind = await trackedRepositoryEntryKind(workspace, path);
    if (files.has(folded) || exactKind !== undefined) {
      // Two tracked entries that fold together leave a case-insensitive
      // export holding only one of them, so neither is a safe base.
      const unique = tracked.filter((entry) => entry === folded).length === 1;
      const base =
        exactKind === "regular" && unique ? await trackedRegularFileSha256(workspace, path) : null;
      // The grant reads the revision's object ID, never the page, so a page of
      // any size gets an answer.
      const objectId =
        base && updateGrant ? await trackedRepositoryBlobObjectId(workspace, path) : undefined;
      if (base && updateGrant && (objectId === undefined || !updateGrant({ path, objectId }))) {
        collisions.push({ path, existing: "file", updateRefused: "write-grant" });
        continue;
      }
      collisions.push({ path, existing: "file", ...(base ? { base: { sha256: base } } : {}) });
      continue;
    }
    if (tracked.some((entry) => entry.startsWith(`${folded}/`))) {
      collisions.push({ path, existing: "directory" });
      continue;
    }
    const segments = folded.split("/");
    for (let end = segments.length - 1; end > 0; end -= 1) {
      if (files.has(segments.slice(0, end).join("/"))) {
        collisions.push({ path, existing: "parent-file" });
        break;
      }
    }
  }
  return collisions;
}

/**
 * How a planned output already exists under `root`: a file or directory at
 * the path, or a non-directory at one of its ancestors. `undefined` when the
 * path and every missing ancestor are free to create.
 */
export async function reconstructionTargetCollision(
  root: string,
  path: string,
): Promise<PlannedTargetCollisionV1 | undefined> {
  assertSafePath(path);
  const segments = path.split("/");
  const observe = async (relative: readonly string[]) => {
    try {
      return await lstat(join(root, ...relative));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  };
  for (let end = 1; end < segments.length; end += 1) {
    const ancestor = await observe(segments.slice(0, end));
    if (!ancestor) return undefined;
    if (!ancestor.isDirectory()) return { path, existing: "parent-file" };
  }
  const target = await observe(segments);
  if (!target) return undefined;
  return { path, existing: target.isDirectory() ? "directory" : "file" };
}

/**
 * Create one planned output under `root`, refusing an existing target first.
 * The check runs before `mkdir`, so a file at an ancestor is refused by the
 * same code instead of failing inside `mkdir`. Returns the written path.
 */
export async function writePlannedOutput(
  root: string,
  path: string,
  bytes: Uint8Array,
): Promise<string> {
  // Defence in depth behind plan admission's collision refusal.
  const collision = await reconstructionTargetCollision(root, path);
  if (collision) throw new CreateTargetExistsError([collision], "candidate-reconstruction");
  const destination = join(root, ...path.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: "wx", mode: 0o644 });
  return destination;
}

/**
 * Remove the converted page from a fresh revision export so candidate 0's
 * bytes can be written in its place. Refuses unless the page is a plain file
 * below plain directories whose content is the converted base.
 */
async function removeConvertedBase(
  child: RepositoryWorkspace,
  path: string,
  baseSha256: string,
): Promise<void> {
  const segments = path.split("/");
  await assertPlainDirectoryChain(child.path, segments.slice(0, -1));
  const destination = join(child.path, ...segments);
  const existing = await lstat(destination);
  if (!existing.isFile() || (await trackedRegularFileSha256(child, path)) !== baseSha256) {
    throw new Error(
      "The converted page in the revision workspace is not the base the plan converted.",
    ); // hygiene: ok -- host integrity refusal; the export is built from the same revision.
  }
  await rm(destination);
}

/** The tracked regular file's content digest at the workspace's revision. */
async function trackedRegularFileSha256(
  workspace: RepositoryWorkspace,
  path: string,
): Promise<string | null> {
  const entry = (await listTrackedRepositoryFileSnapshotMetadata(workspace)).find(
    (candidate) => candidate.path === path,
  );
  return entry?.kind === "regular" && entry.sha256 && SHA256.test(entry.sha256)
    ? entry.sha256
    : null;
}

async function copyPlannedOutputs(
  sourceWorkspace: RepositoryWorkspace,
  child: RepositoryWorkspace,
  candidate: AuthoringCandidateV1,
  snapshot: AuthoringWorkspaceSnapshotV1,
  conversion: AuthoringRevisionWorkspaceInputV1["createConvertedToUpdate"],
  signal?: AbortSignal,
): Promise<void> {
  await verifyActiveRepositoryWorkspace(sourceWorkspace);
  await verifyActiveRepositoryWorkspace(child);
  if (conversion && !candidate.writePaths.includes(conversion.path)) {
    throw new Error("The CREATE-to-UPDATE conversion names a path outside candidate 0's plan."); // hygiene: ok -- host integrity refusal; plan admission binds both from one sealed plan.
  }
  const pages = candidate.writePaths.map((path) => {
    assertSafePath(path);
    const expected = snapshot.entries.find((entry) => entry.path === path);
    if (!expected || expected.kind !== "regular" || expected.mode === null) {
      throw new Error(
        "Candidate-0 snapshot omitted a planned output path during child reconstruction.",
      );
    }
    return { path, mode: expected.mode, byteLength: expected.byteLength ?? 0 };
  });
  const pageBound = refuseOversizedPlannedPages(pages);
  for (const { path, mode } of pages) {
    throwIfAborted(signal);
    const bytes = await readTrackedRepositoryFile(sourceWorkspace, path, pageBound.value);
    // The converted page alone is replaced, and only while the child still
    // holds exactly the base the plan converted; every other existing target
    // keeps the collision refusal. Removing it first is what lets that
    // refusal pass for this one path.
    if (conversion?.path === path) await removeConvertedBase(child, path, conversion.baseSha256);
    const destination = await writePlannedOutput(child.path, path, bytes);
    await chmod(destination, mode);
  }
}

/**
 * Refuse, by its catalogued code, the first planned page of sealed candidate 0
 * over the page bound in force, and return that bound. Sizes come from
 * candidate 0's sealed snapshot, so no page byte is read before the check.
 */
function refuseOversizedPlannedPages(
  pages: readonly { readonly byteLength: number }[],
): ResolvedLimit {
  const bound = limit(PLANNED_PAGE_MAX_BYTES);
  for (const { byteLength } of pages) {
    if (byteLength > bound.value) refuseLimit(bound, byteLength);
  }
  return bound;
}

/**
 * Refuse, by its catalogued code, a written planned page larger than tracked
 * writes admit, before admission leaves it out without a code. The bound is
 * `repository.trackedWriteAdmissionMaxBytes` in force, the bound admission
 * itself applies. A lowering override of `authoring.plannedPageMaxBytes`
 * refuses where a page is read into memory, at the revision copy and reset,
 * not here.
 */
async function refuseUnadmittablePlannedPages(
  workspace: RepositoryWorkspace,
  writePaths: readonly string[],
): Promise<void> {
  const admission = limit(TRACKED_WRITE_ADMISSION_MAX_BYTES_LIMIT);
  for (const path of writePaths) {
    const entry = await lstat(join(workspace.path, ...path.split("/"))).catch((error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      ) {
        return undefined;
      }
      throw error;
    });
    if (entry?.isFile() && entry.size > admission.value) refuseLimit(admission, entry.size);
  }
}

export async function captureAuthoringWorkspaceSnapshot(
  workspace: RepositoryWorkspace,
  authorizedWritePaths: readonly string[] = [],
): Promise<AuthoringWorkspaceSnapshotV1> {
  if (authorizedWritePaths.length !== 0) {
    const admitted = await admitAuthorizedTrackedWrites(workspace, authorizedWritePaths);
    if (!sameStrings(admitted, authorizedWritePaths)) {
      throw new Error("Authoring workspace snapshot could not admit every requested path.");
    }
  }
  const entries = await listTrackedRepositoryFileSnapshotMetadata(workspace);
  const entryBound = limit(SNAPSHOT_MAX_ENTRIES);
  if (entries.length > entryBound.value) refuseLimit(entryBound, entries.length);
  let totalBytes = 0;
  const normalized = entries.map((entry) => {
    assertSafePath(entry.path);
    if (entry.kind === "excluded") {
      throw new Error(
        "Authoring workspace snapshot contains an excluded path outside the authenticated export.",
      );
    }
    const byteLength = entry.byteLength ?? 0;
    if (entry.kind === "regular") {
      if (
        !Number.isSafeInteger(byteLength) ||
        byteLength < 0 ||
        !Number.isSafeInteger(entry.mode) ||
        !SHA256.test(entry.sha256 ?? "")
      ) {
        throw new Error(
          "Authoring workspace snapshot contains invalid file metadata for an authenticated complete snapshot.",
        );
      }
    } else if (entry.mode !== null || entry.byteLength !== null || entry.sha256 !== null) {
      throw new Error(
        "Authoring workspace snapshot contains invalid file metadata for an authenticated complete snapshot.",
      );
    }
    totalBytes += byteLength;
    return {
      path: entry.path,
      kind: entry.kind,
      mode: entry.mode,
      byteLength: entry.byteLength,
      sha256: entry.sha256,
    };
  });
  const byteBound = limit(SNAPSHOT_MAX_BYTES);
  if (totalBytes > byteBound.value) refuseLimit(byteBound, totalBytes);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-authoring-workspace-snapshot" as const,
    entries: normalized,
    totalBytes,
  };
  return Object.freeze({ ...body, digest: canonicalDigest(body) });
}

async function capturePatch(
  collector: GitPatchEvidenceCollector,
  runId: string,
  repository: RepositoryTarget,
  workspacePath: string,
  writePaths: readonly string[],
  kind: RepositoryCandidateArtifactIdentityV1["kind"],
): Promise<ChangeEvidence> {
  const evidence = await collector.capture({
    runId,
    repository,
    workspacePath,
    persistPatch: true,
    candidateArtifact: { kind },
  });
  const changedPaths = repositoryChangeWriteEffectPaths(evidence.files);
  if (changedPaths.some((path) => !writePaths.includes(path))) {
    throw new Error("Authoring candidate patch escaped the exact planned write paths.");
  }
  if (evidence.files.some((file) => file.status === "deleted")) {
    throw new Error(
      "CREATE authoring candidates cannot delete original files under the write contract.",
    );
  }
  return evidence;
}

function assertCandidateEvidenceScope(
  candidate: AuthoringCandidateV1,
  evidence: ChangeEvidence,
): void {
  const changedPaths = repositoryChangeWriteEffectPaths(evidence.files);
  if (changedPaths.some((path) => !candidate.writePaths.includes(path))) {
    throw new Error("Selected authoring candidate evidence escaped the exact planned write paths.");
  }
  if (evidence.files.some((file) => file.status === "deleted")) {
    throw new Error("Selected CREATE authoring candidate evidence cannot delete original files.");
  }
}

function assertCandidatePatch(candidate: AuthoringCandidateV1, evidence: ChangeEvidence): void {
  const patch = evidence.patch;
  if (
    !patch ||
    patch.sha256 !== candidate.patchDigestSha256 ||
    patch.byteLength !== candidate.patchBytes
  ) {
    throw new Error("Authoring candidate patch evidence does not match its sealed identity.");
  }
}

async function assertWorkspaceBinding(
  workspace: RepositoryWorkspace,
  repository: RepositoryTarget,
): Promise<void> {
  await verifyActiveRepositoryWorkspace(workspace);
  if (
    (await realpath(workspace.sourcePath)) !== (await realpath(resolve(repository.sourcePath))) ||
    workspace.revision !== repository.revision ||
    !REVISION.test(repository.revision)
  ) {
    throw new Error("Authoring workspace is not bound to the original repository revision.");
  }
}

function requireIssuedRevisionWorkspace(
  workspace: AuthoringRevisionWorkspaceV1,
): AuthoringRevisionWorkspaceBoundStateV1 {
  const verifier = revisionWorkspaceAuthorities.lookup(workspace.authority);
  verifier?.verifyCurrent();
  if (!verifier || verifier.issuedWorkspace() !== workspace) {
    throw new Error("Authoring revision workspace lacks exact host lifecycle authority.");
  }
  return verifier.boundState();
}

function assertSameRepositoryTarget(supplied: RepositoryTarget, bound: RepositoryTarget): void {
  if (
    supplied.sourcePath !== bound.sourcePath ||
    supplied.requestedRevision !== bound.requestedRevision ||
    supplied.revision !== bound.revision ||
    supplied.gitlabTargetRevision !== bound.gitlabTargetRevision ||
    supplied.gitlabTargetBranch !== bound.gitlabTargetBranch
  ) {
    throw new Error("The authoring revision workspace repository binding was substituted.");
  }
}

function assertSameSourceLedger(
  supplied: SourceObligationLedger,
  bound: SourceObligationLedger,
): void {
  if (canonicalDigest(supplied) !== canonicalDigest(bound)) {
    throw new Error("Authoring revision workspace source ledger binding was substituted.");
  }
}

async function assertOriginalSourcesUnchanged(
  workspace: RepositoryWorkspace,
  ledger: SourceObligationLedger,
): Promise<void> {
  await new LocalSourceObligationSourceObserver(workspace).assertUnchanged(ledger.identity.sources);
}

function assertSourceScope(
  candidate: AuthoringCandidateV1,
  ledger: SourceObligationLedger,
  repository: RepositoryTarget,
): void {
  if (ledger.identity.repositoryRevision !== repository.revision) {
    throw new Error("Authoring source ledger is bound to another repository revision.");
  }
  const sourcePaths = new Set(ledger.identity.sources.map((source) => source.path));
  if (candidate.writePaths.some((path) => sourcePaths.has(path))) {
    throw new Error("Authoring candidate write paths intersect immutable source evidence.");
  }
}

function assertCandidateIdentity(
  candidate: AuthoringCandidateV1,
  runId: string,
  ordinal: 0 | 1,
): void {
  if (candidate.runId !== runId || candidate.ordinal !== ordinal) {
    throw new Error("Authoring candidate identity is stale or out of order.");
  }
}

function assertCandidateRepositoryBinding(
  candidate: AuthoringCandidateV1,
  repository: RepositoryTarget,
): void {
  if (candidate.originalRevision !== repository.revision) {
    throw new Error("Authoring candidate is not bound to the repository revision.");
  }
  for (const path of candidate.writePaths) assertSafePath(path);
}

function assertSameCandidatePlan(
  candidate: AuthoringCandidateV1,
  original: AuthoringCandidateV1,
): void {
  if (
    candidate.originalRevision !== original.originalRevision ||
    candidate.planDigest !== original.planDigest ||
    !sameStrings(candidate.writePaths, original.writePaths)
  ) {
    throw new Error("Revised authoring candidate changed the original plan or write paths.");
  }
}

function assertSnapshotDigest(snapshot: AuthoringWorkspaceSnapshotV1, expected: string): void {
  if (!SHA256.test(expected) || snapshot.digest !== expected) {
    throw new Error("Authoring workspace snapshot digest does not match candidate identity.");
  }
}

function assertSafePath(path: string): void {
  if (
    !path ||
    path !== path.normalize("NFC") ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\0-\x1f\x7f]/u.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Authoring workspace path must remain repository-relative and normalized.");
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Authoring workspace operation was cancelled before further filesystem work.");
  }
}

async function disposeRevisionResources(
  collector: GitPatchEvidenceCollector | undefined,
  workspace: RepositoryWorkspace,
): Promise<void> {
  const results = await Promise.allSettled([
    collector?.dispose() ?? Promise.resolve(),
    workspace.dispose(),
  ]);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Authoring revision workspace cleanup failed.");
  }
}
