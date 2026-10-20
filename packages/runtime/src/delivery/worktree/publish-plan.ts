// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Publish-plan seam: authorization/plan binding, discard, and cleanup. */
import { createHash, randomUUID } from "node:crypto";
import { lstat, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  DeliveryWorktreeError,
  assertCurrentLocalUserPublicationAuthorization,
  assertLocalUserPublicationAuthorization,
  assertLocalUserPublicationPlan,
  type DeliveryWorktreeFailureCode,
  type LocalUserPublicationAuthorizationV1,
  type LocalUserPublicationPlan,
} from "../contracts.js";
import { parseGitLabRemote, type VerifiedPublicationRun } from "../preflight.js";
import {
  assertScmPublishedTerminalCapability,
  type ScmPublishedTerminalCapability,
  type ScmPublishedTerminalEvidence,
} from "../receipt.js";
import {
  CAPABILITY_CONFIRMATION,
  ExecFileDeliveryCommandRunner,
  discardAuthorizations,
  publishedCleanupAuthorizations,
  type CleanupDeliveryWorktreeInput,
  type DeliveryCommandRunner,
  type DeliveryDiscardAuthorization,
  type DeliveryWorktreeCapability,
  type PrepareDeliveryWorktreeInput,
  type PublishedDeliveryCleanupAuthorization,
  type TrustedCapability,
} from "./types.js";
import {
  assertFilesystemMatchesGitTree,
  assertGitConfigSnapshot,
  assertIdentity,
  assertTrustedPaths,
  branchFingerprint,
  branchRevision,
  canonicalPath,
  directRefRevision,
  discoverDeliveryPartialState,
  fail,
  filesystemState,
  identity,
  metadataPathFingerprint,
  pinnedGitCommands,
  plainRecord,
  readDirectHead,
  readGitTree,
  requireCapability,
  requireGit,
  resolveCommonGitDirectory,
  resolveGitDirectoryFromWorktree,
  runGit,
  setCapabilityState,
  text,
  verifyPinnedPatch,
  withRepositoryLock,
} from "./host.js";

/** Preserves a ready or failed delivery without altering Git or filesystem state. */
export function archiveDeliveryWorktree(worktree: DeliveryWorktreeCapability): void {
  const trusted = requireCapability(worktree);
  if (trusted.state === "cleaned") fail("cleanup-refused");
  setCapabilityState(worktree, "archived");
}

export async function authorizeDeliveryDiscard(
  input: {
    worktree: DeliveryWorktreeCapability;
    confirmedPlanSha256: string;
    confirmation: typeof CAPABILITY_CONFIRMATION;
    reason: string;
    deleteBranch: boolean;
  },
  commands: DeliveryCommandRunner = new ExecFileDeliveryCommandRunner(),
): Promise<DeliveryDiscardAuthorization> {
  const trusted = requireCapability(input.worktree);
  if (
    trusted.state === "cleaned" ||
    input.confirmedPlanSha256 !== trusted.planSha256 ||
    input.confirmation !== CAPABILITY_CONFIRMATION ||
    !/^[A-Za-z0-9][A-Za-z0-9 ._:/+-]{7,255}$/u.test(input.reason)
  )
    fail("cleanup-refused");
  const authorization = Object.freeze({
    kind: "docsfab-delivery-discard-authorization" as const,
  });
  discardAuthorizations.set(authorization, {
    worktree: input.worktree,
    planSha256: trusted.planSha256,
    deleteBranch: input.deleteBranch,
    snapshotSha256: await discardSnapshot(commands, trusted),
    branchRevision: await branchRevision(trusted),
    branchFingerprint: await branchFingerprint(trusted),
  });
  return authorization;
}

export function authorizePublishedDeliveryCleanup(input: {
  worktree: DeliveryWorktreeCapability;
  publicationAuthorization: LocalUserPublicationAuthorizationV1;
  terminalCapability: ScmPublishedTerminalCapability;
}): PublishedDeliveryCleanupAuthorization {
  const trusted = requireCapability(input.worktree);
  if (
    trusted.state === "cleaned" ||
    input.publicationAuthorization !== trusted.publicationAuthorization
  ) {
    fail("cleanup-refused");
  }
  let evidence: ScmPublishedTerminalEvidence;
  try {
    evidence = assertScmPublishedTerminalCapability(
      input.terminalCapability,
      trusted.plan,
      trusted.publicationAuthorization,
    );
  } catch {
    fail("cleanup-refused");
  }
  const authorization = Object.freeze({
    kind: "docsfab-published-delivery-cleanup-authorization" as const,
  });
  publishedCleanupAuthorizations.set(authorization, {
    worktree: input.worktree,
    evidence,
    consumed: false,
  });
  return authorization;
}

/** Cleanup is intentionally separate from preparation and never implicit on failure. */
export async function cleanupDeliveryWorktree(
  worktree: DeliveryWorktreeCapability,
  input: CleanupDeliveryWorktreeInput,
  commands: DeliveryCommandRunner = new ExecFileDeliveryCommandRunner(),
): Promise<void> {
  const trusted = requireCapability(worktree);
  const pinnedCommands = pinnedGitCommands(
    commands,
    trusted.gitConfigSnapshot,
    "cleanup-refused",
    trusted.branch,
  );
  return withRepositoryLock(
    trusted.repositoryPath,
    () => undefined,
    () => cleanupDeliveryWorktreeLocked(worktree, input, pinnedCommands, trusted),
  );
}

export async function cleanupDeliveryWorktreeLocked(
  worktree: DeliveryWorktreeCapability,
  input: CleanupDeliveryWorktreeInput,
  commands: DeliveryCommandRunner,
  trusted: TrustedCapability,
): Promise<void> {
  if (trusted.state === "cleaned") fail("cleanup-refused");
  await assertIdentity(
    trusted.repositoryPath,
    trusted.repositoryIdentity,
    "cleanup-failed",
    "directory",
  );
  await verifyCleanupRepository(commands, trusted);
  if (trusted.cleanupTombstonePath) {
    await assertIdentity(
      trusted.cleanupTombstonePath,
      trusted.capsuleIdentity,
      "cleanup-failed",
      "directory",
    );
  } else {
    await assertTrustedPaths(
      trusted,
      Boolean(trusted.worktreeIdentity && !trusted.worktreeRemoved),
    );
  }
  if (input.mode === "published") {
    const publication = publishedCleanupAuthorizations.get(input.authorization);
    if (!publication || publication.worktree !== worktree || publication.consumed)
      fail("cleanup-refused");
    await verifyPinnedPatch(trusted, "cleanup-refused");
    if (!trusted.worktreeRemoved) {
      if (!trusted.deliveryGitDirectory) fail("cleanup-refused");
      const head = await readDirectHead(trusted.deliveryGitDirectory, "cleanup-failed");
      const branchRef = `refs/heads/${trusted.branch}`;
      const revision = await directRefRevision(
        trusted.commonGitDirectory,
        branchRef,
        "cleanup-failed",
      );
      const publishedTree = await readCommitTree(
        commands,
        trusted.worktreePath,
        publication.evidence.commitRevision,
        "cleanup-failed",
      );
      const indexTree = text(
        await requireGit(commands, trusted.worktreePath, ["write-tree"], "cleanup-failed"),
      ).trim();
      const entries = await readGitTree(commands, trusted.worktreePath, publishedTree);
      await assertFilesystemMatchesGitTree(trusted.worktreePath, entries, "cleanup-refused");
      if (
        head.branch !== branchRef ||
        revision !== publication.evidence.commitRevision ||
        indexTree !== publishedTree
      ) {
        fail("cleanup-refused");
      }
      const removed = await runGit(
        commands,
        ["worktree", "remove", "--force", trusted.worktreePath],
        trusted.repositoryPath,
      );
      await discoverDeliveryPartialState(commands, trusted, publication.evidence.commitRevision);
      if (removed.exitCode !== 0 || trusted.worktreeRegistered || trusted.worktreeIdentity) {
        fail("cleanup-failed");
      }
      trusted.worktreeRemoved = true;
    }
  } else {
    const discard = discardAuthorizations.get(input.authorization);
    if (
      !discard ||
      discard.worktree !== worktree ||
      discard.planSha256 !== trusted.planSha256 ||
      (!trusted.worktreeRemoved &&
        discard.snapshotSha256 !== (await discardSnapshot(commands, trusted))) ||
      (discard.deleteBranch && discard.branchRevision !== (await branchRevision(trusted))) ||
      (discard.deleteBranch && discard.branchFingerprint !== (await branchFingerprint(trusted)))
    ) {
      fail("cleanup-refused");
    }
    if (!trusted.worktreeRemoved && (trusted.worktreeRegistered || trusted.worktreeIdentity)) {
      const removed = await runGit(
        commands,
        ["worktree", "remove", "--force", trusted.worktreePath],
        trusted.repositoryPath,
      );
      await discoverDeliveryPartialState(commands, trusted, discard.branchRevision);
      if (trusted.worktreeRegistered) fail("cleanup-failed");
      if (removed.exitCode !== 0 && trusted.worktreeIdentity) fail("cleanup-failed");
      trusted.worktreeRemoved = true;
    }
    if (discard.deleteBranch && trusted.branchCreated && !trusted.branchDeleted) {
      if (
        discard.branchRevision === undefined ||
        discard.branchRevision !== (await branchRevision(trusted)) ||
        discard.branchFingerprint !== (await branchFingerprint(trusted))
      )
        fail("cleanup-refused");
      const deleted = await runGit(
        commands,
        ["branch", "-D", "--", trusted.branch],
        trusted.repositoryPath,
      );
      const remainingBranch = await branchRevision(trusted);
      if (remainingBranch !== undefined) {
        if (deleted.exitCode !== 0 && remainingBranch !== discard.branchRevision)
          fail("cleanup-refused");
        fail("cleanup-failed");
      }
      trusted.branchDeleted = true;
    }
    if (trusted.worktreeRegistered || (trusted.branchCreated && !trusted.branchDeleted)) {
      fail("cleanup-refused");
    }
  }
  await assertIdentity(
    trusted.repositoryPath,
    trusted.repositoryIdentity,
    "cleanup-failed",
    "directory",
  );
  await verifyCleanupRepository(commands, trusted);
  await assertIdentity(
    trusted.deliveryRootPath,
    trusted.deliveryRootIdentity,
    "cleanup-failed",
    "directory",
  );
  if (!trusted.cleanupTombstonePath) {
    await assertIdentity(
      trusted.capsulePath,
      trusted.capsuleIdentity,
      "cleanup-failed",
      "directory",
    );
  }
  if (trusted.worktreeRegistered) {
    fail("cleanup-failed");
  }
  if (trusted.worktreeIdentity && trusted.worktreeRemoved) {
    try {
      await lstat(trusted.worktreePath);
      // An unregistered operation-created partial directory remains protected
      // by the exact capsule identity and is removed only with that capsule.
      if (!trusted.worktreeRemoved) fail("cleanup-failed");
    } catch (error) {
      if (error instanceof DeliveryWorktreeError) throw error;
      if (!plainRecord(error) || error.code !== "ENOENT") fail("cleanup-failed");
    }
  }
  const tombstone =
    trusted.cleanupTombstonePath ?? `${trusted.capsulePath}.cleanup-${randomUUID()}`;
  try {
    if (!trusted.cleanupTombstonePath) {
      await rename(trusted.capsulePath, tombstone);
      trusted.cleanupTombstonePath = tombstone;
    }
    await assertIdentity(tombstone, trusted.capsuleIdentity, "cleanup-failed", "directory");
    await assertIdentity(
      trusted.deliveryRootPath,
      trusted.deliveryRootIdentity,
      "cleanup-failed",
      "directory",
    );
    await rm(tombstone, { recursive: true });
  } catch {
    fail("cleanup-failed");
  }
  setCapabilityState(worktree, "cleaned");
  if (input.mode === "published") {
    const publication = publishedCleanupAuthorizations.get(input.authorization);
    if (publication) publication.consumed = true;
  }
}

export async function verifyCleanupRepository(
  _commands: DeliveryCommandRunner,
  trusted: TrustedCapability,
): Promise<void> {
  if (
    (await canonicalPath(trusted.repositoryPath)) !== trusted.repositoryPath ||
    (await resolveGitDirectoryFromWorktree(trusted.repositoryPath, "cleanup-failed")) !==
      trusted.sourceGitDirectory ||
    (await resolveCommonGitDirectory(trusted.sourceGitDirectory, "cleanup-failed")) !==
      trusted.commonGitDirectory
  )
    fail("cleanup-failed");
  await assertGitConfigSnapshot(trusted.gitConfigSnapshot, "cleanup-failed");
}

export async function discardSnapshot(
  _commands: DeliveryCommandRunner,
  trusted: TrustedCapability,
): Promise<string> {
  if (!trusted.worktreeIdentity || trusted.worktreeRemoved) return "absent";
  await assertIdentity(
    trusted.worktreePath,
    trusted.worktreeIdentity,
    "cleanup-refused",
    "directory",
  );
  if (!trusted.deliveryGitDirectory) fail("cleanup-refused");
  const head = await readDirectHead(trusted.deliveryGitDirectory, "cleanup-refused");
  const branch = `refs/heads/${trusted.branch}`;
  const revision = await directRefRevision(trusted.commonGitDirectory, branch, "cleanup-refused");
  if (head.branch !== branch || revision === undefined) fail("cleanup-refused");
  return createHash("sha256")
    .update(String(trusted.worktreeIdentity.dev))
    .update("\0")
    .update(String(trusted.worktreeIdentity.ino))
    .update("\0")
    .update(branch)
    .update("\0")
    .update(revision)
    .update("\0")
    .update(await metadataPathFingerprint(join(trusted.deliveryGitDirectory, "index")))
    .update(await metadataPathFingerprint(join(trusted.deliveryGitDirectory, "gitdir")))
    .update(await filesystemState(trusted.worktreePath))
    .digest("hex");
}

export async function readCommitTree(
  commands: DeliveryCommandRunner,
  cwd: string,
  revision: string,
  code: DeliveryWorktreeFailureCode,
): Promise<string> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revision)) fail(code);
  const commit = text(await requireGit(commands, cwd, ["cat-file", "commit", revision], code));
  const match = /^tree ([a-f0-9]{40}|[a-f0-9]{64})\n/u.exec(commit);
  if (!match) fail(code);
  return match[1]!;
}

export function validateInput(input: PrepareDeliveryWorktreeInput): void {
  try {
    assertLocalUserPublicationPlan(input.plan);
    assertLocalUserPublicationAuthorization(input.authorization, input.plan);
    assertCurrentLocalUserPublicationAuthorization(
      input.authorization,
      input.plan,
      (input.clock ?? (() => new Date()))(),
    );
  } catch {
    fail("authorization-mismatch");
  }
  if (
    ![input.runRecordPath, input.repositoryPath, input.deliveryRoot].every(
      (value) => typeof value === "string" && isAbsolute(value),
    )
  )
    fail("invalid-delivery-input");
  const rehydrating = input.sourceBranchMode === "rehydrate-published";
  const reusingRetained = input.sourceBranchMode === "reuse-retained";
  if (
    rehydrating !== (typeof input.expectedSourceRevision === "string") ||
    (rehydrating && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(input.expectedSourceRevision!)) ||
    reusingRetained !== (input.retainedHead !== undefined) ||
    (input.retainedHead !== undefined &&
      (![input.retainedHead.revision, input.retainedHead.branchRevision].every((revision) =>
        /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revision),
      ) ||
        !["attached-base", "attached-commit", "detached-base", "detached-commit"].includes(
          input.retainedHead.shape,
        )))
  ) {
    fail("invalid-delivery-input");
  }
}

export function assertCurrentPreparationAuthorization(
  authorization: LocalUserPublicationAuthorizationV1,
  plan: LocalUserPublicationPlan,
  clock: () => Date,
): void {
  try {
    assertCurrentLocalUserPublicationAuthorization(authorization, plan, clock());
  } catch {
    fail("authorization-mismatch");
  }
}

export function verifyRunBinding(
  run: VerifiedPublicationRun,
  plan: LocalUserPublicationPlan,
): void {
  if (
    run.id !== plan.run.id ||
    run.recordSha256 !== plan.run.recordSha256 ||
    run.revision !== plan.baseRevision ||
    run.patch.format !== plan.patch.format ||
    run.patch.sha256 !== plan.patch.sha256 ||
    run.patch.byteLength !== plan.patch.byteLength ||
    run.changedFileCount !== plan.patch.changedFileCount
  )
    fail("run-record-mismatch");
}

export async function verifyRepositoryIdentity(
  commands: DeliveryCommandRunner,
  repositoryPath: string,
  plan: LocalUserPublicationPlan,
): Promise<void> {
  for (const push of [false, true]) {
    const args = ["remote", "get-url", ...(push ? ["--push"] : []), "--all", plan.remote.name];
    const result = await requireGit(commands, repositoryPath, args, "source-repository-mismatch");
    const urls = text(result).split(/\r?\n/u).filter(Boolean);
    if (urls.length !== 1) fail("source-repository-mismatch");
    let parsed: ReturnType<typeof parseGitLabRemote>;
    try {
      parsed = parseGitLabRemote(urls[0]!);
    } catch {
      fail("source-repository-mismatch");
    }
    if (
      parsed.host !== plan.project.host ||
      parsed.projectPath.toLowerCase() !== plan.project.path.toLowerCase() ||
      parsed.transport !== plan.remote.transport
    )
      fail("source-repository-mismatch");
  }
}
