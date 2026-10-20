// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Disk-backed, exact Git worktree cleanup for one approved local run deletion. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { limit } from "../../config/limits.js";
import type { RunRecord } from "../../records/contracts.js";
import type { RunDeliveryDeletionInventory } from "../run-deletion-adapter.js";
import { deterministicLocalUserSourceBranch, type LocalUserPublicationPlan } from "../contracts.js";
import { withDeliveryRootGates } from "../delivery-root-gates.js";
import { FileScmDeliveryReceiptStore } from "../receipt-store.js";
import { parseGitLabRemote } from "../preflight.js";
import { deliveryCapsuleName } from "./materialize.js";
import {
  assertFilesystemMatchesGitTree,
  directRefRevision,
  readDirectHead,
  readDirectRefs,
  readGitTree,
  readLooseRefs,
  requireGit,
  resolveCommonGitDirectory,
  resolveGitDirectoryFromWorktree,
  runGit,
  safeGitRef,
  safeRepositoryPath,
  symbolicRefChain,
  text,
  withRepositoryLock,
} from "./host.js";
import { readCommitTree } from "./publish-plan.js";
import { ExecFileDeliveryCommandRunner, type GitTreeEntry } from "./types.js";

type Attempt = RunDeliveryDeletionInventory["attempts"][number];

export interface GitDeletionIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly kind: "file" | "directory";
  readonly sha256?: string;
}

export interface RunDeliveryWorktreeCleanupEvidence {
  readonly attemptPath: string;
  readonly capsulePath: string;
  readonly worktreePath: string;
  readonly sourcePath: string;
  readonly sourceGitDirectory: string;
  readonly commonGitDirectory: string;
  readonly adminDirectory: string;
  readonly receiptRoot: string;
  readonly idempotencyKey: string;
  readonly planSha256: string;
  readonly recordSha256: string;
  readonly branchRef: string;
  readonly revision: string;
  readonly tree: string;
  readonly mode: "committed" | "base" | "patch";
  /** HEAD is detached at `revision`, as a retry of the run leaves it; `branchRef` stays the run's branch. */
  readonly detached?: true;
  readonly source: GitDeletionIdentity;
  readonly sourceGit: GitDeletionIdentity;
  readonly commonGit: GitDeletionIdentity;
  readonly admin: GitDeletionIdentity;
  readonly gitFile: GitDeletionIdentity;
  readonly adminHead: GitDeletionIdentity;
  readonly adminBackpointer: GitDeletionIdentity;
  readonly adminIndex: GitDeletionIdentity;
  readonly registration: string;
  readonly digest: string;
}

export class RunDeliveryWorktreeCleanupError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RunDeliveryWorktreeCleanupError";
  }
}

function refuse(message: string): never {
  throw new RunDeliveryWorktreeCleanupError(message);
}

export function worktreeCleanupEvidenceDigest(
  evidence: Omit<RunDeliveryWorktreeCleanupEvidence, "digest">,
): string {
  return createHash("sha256")
    .update("docsfab-run-delivery-worktree-cleanup-v1\0")
    .update(JSON.stringify(evidence))
    .digest("hex");
}

async function identity(
  path: string,
  kind: GitDeletionIdentity["kind"],
): Promise<GitDeletionIdentity> {
  const stat = await lstat(path);
  if (
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (kind === "directory" ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
  ) {
    refuse(`Unsafe Git cleanup identity at ${path}; inspect it before retrying.`);
  }
  if (kind === "directory") {
    return { path, dev: stat.dev, ino: stat.ino, size: 0, mtimeMs: 0, kind };
  }
  const hash = createHash("sha256");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const pinned = await handle.stat();
    if (
      pinned.dev !== stat.dev ||
      pinned.ino !== stat.ino ||
      pinned.size !== stat.size ||
      pinned.mtimeMs !== stat.mtimeMs
    ) {
      refuse(`Git cleanup identity changed at ${path}; preview again.`);
    }
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk as Buffer);
    }
    const after = await handle.stat();
    const named = await lstat(path);
    if (
      stat.dev !== after.dev ||
      stat.ino !== after.ino ||
      stat.size !== after.size ||
      stat.mtimeMs !== after.mtimeMs ||
      stat.dev !== named.dev ||
      stat.ino !== named.ino
    ) {
      refuse(`Git cleanup identity changed at ${path}; preview again.`);
    }
  } finally {
    await handle.close();
  }
  return {
    path,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    kind,
    sha256: hash.digest("hex"),
  };
}

async function assertIdentity(expected: GitDeletionIdentity): Promise<void> {
  const actual = await identity(expected.path, expected.kind);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    refuse(`Git cleanup identity changed at ${expected.path}; preview again.`);
  }
}

async function readRegistrationPointer(path: string): Promise<string> {
  const expected = await identity(path, "file");
  if (expected.size > limit("repository.evidenceGitOutputMaxBytes").value) {
    refuse(`Git registration at ${path} exceeds the supported evidence bound.`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const pinned = await handle.stat();
    if (pinned.dev !== expected.dev || pinned.ino !== expected.ino) {
      refuse(`Git registration changed at ${path}; inspect it before retrying.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.size !== expected.size ||
      after.mtimeMs !== expected.mtimeMs ||
      bytes.byteLength !== expected.size ||
      createHash("sha256").update(bytes).digest("hex") !== expected.sha256
    ) {
      refuse(`Git registration changed at ${path}; inspect it before retrying.`);
    }
    await assertIdentity(expected);
    return text(bytes).trimEnd();
  } finally {
    await handle.close();
  }
}

function within(parent: string, path: string): boolean {
  const suffix = relative(parent, path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`);
}

/** `write-tree` updates Git's cache-tree/index and would mutate a deletion preview. */
async function readIndexEntries(
  commands: ExecFileDeliveryCommandRunner,
  worktreePath: string,
): Promise<GitTreeEntry[]> {
  const maxBytes = limit("repository.evidenceGitOutputMaxBytes").value;
  const listing = await runGit(commands, ["ls-files", "--stage", "-z", "--"], worktreePath, {
    maxOutputBytes: maxBytes,
  });
  if (listing.exitCode !== 0) refuse(`Git index could not be read at ${worktreePath}.`);
  const records = listing.stdout.toString("utf8").split("\0");
  if (records.at(-1) === "") records.pop();
  if (records.length > limit("runs.deletionInventoryMaxEntries").value) {
    refuse(`Git index at ${worktreePath} exceeds the run deletion inventory entry limit.`);
  }
  const entries: GitTreeEntry[] = [];
  const paths = new Set<string>();
  for (const record of records) {
    const match = /^(100644|100755|120000) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t([^\0]+)$/u.exec(record);
    if (!match || !safeRepositoryPath(match[3]!) || paths.has(match[3]!)) {
      refuse(`Git index at ${worktreePath} has an unsafe or unresolved entry.`);
    }
    const [, mode, oid, path] = match;
    paths.add(path!);
    const sizeOutput = await runGit(commands, ["cat-file", "-s", oid!], worktreePath, {
      maxOutputBytes: maxBytes,
    });
    const size = Number(text(sizeOutput.stdout).trim());
    if (sizeOutput.exitCode !== 0 || !Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
      refuse(`Git index blob at ${path} exceeds the supported evidence bound.`);
    }
    const content = await runGit(commands, ["cat-file", "blob", oid!], worktreePath, {
      maxOutputBytes: size + 1,
    });
    if (content.exitCode !== 0 || content.stdout.byteLength !== size) {
      refuse(`Git index blob at ${path} changed while reading it.`);
    }
    entries.push({
      path: path!,
      mode: mode as GitTreeEntry["mode"],
      oid: oid!,
      bytes: Buffer.from(content.stdout),
    });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function entriesDigest(entries: readonly GitTreeEntry[]): string {
  return createHash("sha256")
    .update(JSON.stringify(entries.map(({ path, mode, oid }) => ({ path, mode, oid }))))
    .digest("hex");
}

/** The run's own checkout, which must still be at its recorded canonical path. */
async function originalSourcePath(
  inventory: RunDeliveryDeletionInventory,
  record: RunRecord,
): Promise<string> {
  if (
    record.id !== inventory.runId ||
    !record.repository?.sourcePath ||
    !isAbsolute(record.repository.sourcePath)
  ) {
    refuse(`Run ${inventory.runId} lacks an independent original repository path.`);
  }
  const sourcePath = await realpath(record.repository.sourcePath).catch(() =>
    refuse(
      `Restore the original repository at ${record.repository.sourcePath} before deleting this attempt.`,
    ),
  );
  if (sourcePath !== record.repository.sourcePath) {
    refuse(
      `Original repository path changed; restore ${record.repository.sourcePath} and preview again.`,
    );
  }
  return sourcePath;
}

async function assertOriginalRemote(
  commands: ExecFileDeliveryCommandRunner,
  sourcePath: string,
  plan: LocalUserPublicationPlan,
  subject: string,
): Promise<void> {
  const remoteBytes = await requireGit(
    commands,
    sourcePath,
    ["remote", "get-url", "--all", plan.remote.name],
    "cleanup-refused",
  );
  const remotes = text(remoteBytes).trimEnd().split("\n");
  if (remotes.length !== 1) refuse(`Original repository remote changed for ${subject}.`);
  const remote = parseGitLabRemote(remotes[0]!);
  if (
    remote.host !== plan.project.host ||
    remote.projectPath !== plan.project.path ||
    remote.transport !== plan.remote.transport
  ) {
    refuse(`Original repository remote no longer matches the approved plan for ${subject}.`);
  }
}

async function loadedAuthority(
  inventory: RunDeliveryDeletionInventory,
  attempt: Attempt,
  record: RunRecord,
) {
  const sourcePath = await originalSourcePath(inventory, record);
  const receipts = inventory.receipts.filter(
    (receipt) => receipt.planSha256 === attempt.planSha256,
  );
  if (receipts.length !== 1) refuse(`Attempt ${attempt.path} lacks one exact owned receipt.`);
  const receiptEntry = receipts[0]!;
  const store = new FileScmDeliveryReceiptStore(receiptEntry.root);
  const receipt = await store.load(receiptEntry.idempotencyKey);
  const plan = await store.loadPlan(attempt.planSha256);
  if (
    !receipt ||
    !plan ||
    receipt.run.id !== inventory.runId ||
    receipt.run.recordSha256 !== inventory.recordSha256 ||
    receipt.planSha256 !== attempt.planSha256 ||
    plan.run.id !== inventory.runId ||
    plan.run.recordSha256 !== inventory.recordSha256 ||
    plan.sha256 !== attempt.planSha256 ||
    record.repository.revision !== plan.baseRevision ||
    receipt.baseRevision !== plan.baseRevision ||
    receipt.sourceBranch !== plan.proposedSourceBranch ||
    receipt.repository.projectId !== plan.project.id ||
    receipt.repository.host !== plan.project.host ||
    receipt.repository.path !== plan.project.path
  ) {
    refuse(`Receipt or plan for attempt ${attempt.path} changed; inspect and preview again.`);
  }
  const capsulePath = join(attempt.path, deliveryCapsuleName(plan));
  const worktreePath = join(capsulePath, "repository");
  if (
    attempt.root !== resolve(attempt.root) ||
    !within(attempt.root, attempt.path) ||
    !attempt.entries.some((entry) => entry.path === worktreePath && entry.kind === "directory") ||
    !attempt.entries.some(
      (entry) => entry.path === join(worktreePath, ".git") && entry.kind === "file",
    )
  ) {
    refuse(`Attempt ${attempt.path} is not one approved publication capsule.`);
  }
  const commands = new ExecFileDeliveryCommandRunner();
  await assertOriginalRemote(commands, sourcePath, plan, attempt.path);
  await requireGit(
    commands,
    sourcePath,
    ["rev-parse", "--verify", `${record.repository.revision}^{commit}`],
    "cleanup-refused",
  );
  await requireGit(
    commands,
    sourcePath,
    ["rev-parse", "--verify", `${plan.baseRevision}^{commit}`],
    "cleanup-refused",
  );
  return { sourcePath, receiptEntry, receipt, plan, capsulePath, worktreePath, commands };
}

/** Read-only preview of the exact registration and full worktree bytes. */
export async function inspectRunDeliveryWorktree(
  inventory: RunDeliveryDeletionInventory,
  attempt: Attempt,
  record: RunRecord,
): Promise<RunDeliveryWorktreeCleanupEvidence> {
  const authority = await loadedAuthority(inventory, attempt, record);
  const { sourcePath, receiptEntry, receipt, plan, capsulePath, worktreePath, commands } =
    authority;
  if (
    receipt.disposition !== "succeeded" &&
    receipt.disposition !== "failed" &&
    receipt.disposition !== "recovered"
  ) {
    refuse(`Attempt ${attempt.path} is active; close its writer and preview again.`);
  }
  const sourceGitDirectory = await resolveGitDirectoryFromWorktree(sourcePath, "cleanup-refused");
  const commonGitDirectory = await resolveCommonGitDirectory(sourceGitDirectory, "cleanup-refused");
  const adminDirectory = await resolveGitDirectoryFromWorktree(worktreePath, "cleanup-refused");
  if (
    (await resolveCommonGitDirectory(adminDirectory, "cleanup-refused")) !== commonGitDirectory ||
    !within(join(commonGitDirectory, "worktrees"), adminDirectory)
  ) {
    refuse(`Attempt ${attempt.path} points to a different Git repository.`);
  }
  const backpointer = await readRegistrationPointer(join(adminDirectory, "gitdir"));
  if (backpointer !== join(worktreePath, ".git")) {
    refuse(`Git registration for ${attempt.path} points elsewhere.`);
  }
  const head = await readDirectHead(adminDirectory, "cleanup-refused");
  const branchRef = `refs/heads/${plan.proposedSourceBranch}`;
  // A retry finds the run's branch already present and checks out a worktree
  // detached at the base revision; its index then holds the base tree or the
  // approved patch, never the delivery commit.
  const detached = head.branch === undefined;
  const revision = detached
    ? head.revision
    : await directRefRevision(commonGitDirectory, branchRef, "cleanup-refused");
  const committedRevision = detached ? undefined : receipt.evidence.commit?.sha;
  const expectedRevision = committedRevision ?? plan.baseRevision;
  if ((!detached && head.branch !== branchRef) || revision !== expectedRevision) {
    refuse(`Attempt branch or commit changed for ${attempt.path}; inspect it.`);
  }
  const baseOrCommitTree = await readCommitTree(
    commands,
    worktreePath,
    expectedRevision,
    "cleanup-refused",
  );
  const indexEntries = await readIndexEntries(commands, worktreePath);
  const baseOrCommitEntries = await readGitTree(commands, worktreePath, baseOrCommitTree);
  const indexMatchesRevision = entriesDigest(indexEntries) === entriesDigest(baseOrCommitEntries);
  let mode: RunDeliveryWorktreeCleanupEvidence["mode"];
  if (committedRevision) {
    if (!indexMatchesRevision) {
      refuse(`Committed attempt index changed for ${attempt.path}; inspect it.`);
    }
    mode = "committed";
  } else if (indexMatchesRevision) {
    mode = "base";
  } else {
    const patchPath = join(capsulePath, "verified.patch");
    const patchIdentity = await identity(patchPath, "file");
    if (
      patchIdentity.sha256 !== plan.patch.sha256 ||
      patchIdentity.size !== plan.patch.byteLength ||
      !attempt.entries.some(
        (entry) =>
          entry.path === patchPath &&
          entry.sha256 === patchIdentity.sha256 &&
          entry.size === patchIdentity.size,
      )
    ) {
      refuse(`Retained patch changed for failed attempt ${attempt.path}; inspect it.`);
    }
    const diff = await runGit(
      commands,
      [
        "diff",
        "--cached",
        "--binary",
        "--full-index",
        "--find-renames",
        "--find-copies",
        "--find-copies-harder",
        "--",
      ],
      worktreePath,
      { maxOutputBytes: plan.patch.byteLength },
    );
    if (
      diff.exitCode !== 0 ||
      diff.stdout.byteLength !== plan.patch.byteLength ||
      createHash("sha256").update(diff.stdout).digest("hex") !== plan.patch.sha256
    ) {
      refuse(`Failed attempt index differs from its approved patch at ${attempt.path}.`);
    }
    mode = "patch";
  }
  const tree = mode === "patch" ? entriesDigest(indexEntries) : baseOrCommitTree;
  await assertFilesystemMatchesGitTree(worktreePath, indexEntries, "cleanup-refused");
  const registration = `${adminDirectory}\0${backpointer}\0${branchRef}\0${revision}`;
  const body = {
    attemptPath: attempt.path,
    capsulePath,
    worktreePath,
    sourcePath,
    sourceGitDirectory,
    commonGitDirectory,
    adminDirectory,
    receiptRoot: receiptEntry.root,
    idempotencyKey: receiptEntry.idempotencyKey,
    planSha256: plan.sha256,
    recordSha256: inventory.recordSha256,
    branchRef,
    revision: expectedRevision,
    tree,
    mode,
    ...(detached ? { detached: true as const } : {}),
    source: await identity(sourcePath, "directory"),
    sourceGit: await identity(sourceGitDirectory, "directory"),
    commonGit: await identity(commonGitDirectory, "directory"),
    admin: await identity(adminDirectory, "directory"),
    gitFile: await identity(join(worktreePath, ".git"), "file"),
    adminHead: await identity(join(adminDirectory, "HEAD"), "file"),
    adminBackpointer: await identity(join(adminDirectory, "gitdir"), "file"),
    adminIndex: await identity(join(adminDirectory, "index"), "file"),
    registration,
  };
  return { ...body, digest: worktreeCleanupEvidenceDigest(body) };
}

/** Read-only proof that Git and the pinned capsule registration were removed. */
export async function assertRemovedWorktreeRegistration(
  inventory: RunDeliveryDeletionInventory,
  attempt: Attempt,
  approved: RunDeliveryWorktreeCleanupEvidence,
): Promise<void> {
  const { digest, ...body } = approved;
  const gitEntry = attempt.entries.find(
    (entry) => entry.path === join(approved.worktreePath, ".git") && entry.kind === "file",
  );
  if (
    digest !== worktreeCleanupEvidenceDigest(body) ||
    !inventory.attempts.some((candidate) => candidate.path === attempt.path) ||
    approved.attemptPath !== attempt.path ||
    approved.planSha256 !== attempt.planSha256 ||
    approved.recordSha256 !== inventory.recordSha256 ||
    !within(attempt.path, approved.capsulePath) ||
    dirname(approved.worktreePath) !== approved.capsulePath ||
    !attempt.entries.some(
      (entry) => entry.path === approved.capsulePath && entry.kind === "directory",
    ) ||
    !gitEntry ||
    approved.source.path !== approved.sourcePath ||
    approved.sourceGit.path !== approved.sourceGitDirectory ||
    approved.commonGit.path !== approved.commonGitDirectory ||
    approved.admin.path !== approved.adminDirectory ||
    approved.gitFile.path !== join(approved.worktreePath, ".git") ||
    approved.adminBackpointer.path !== join(approved.adminDirectory, "gitdir") ||
    approved.adminHead.path !== join(approved.adminDirectory, "HEAD") ||
    approved.adminIndex.path !== join(approved.adminDirectory, "index") ||
    !inventory.receipts.some(
      (receipt) =>
        receipt.root === approved.receiptRoot &&
        receipt.idempotencyKey === approved.idempotencyKey &&
        receipt.planSha256 === approved.planSha256,
    ) ||
    approved.registration !==
      `${approved.adminDirectory}\0${join(approved.worktreePath, ".git")}\0${approved.branchRef}\0${approved.revision}` ||
    gitEntry.sha256 !==
      createHash("sha256").update(`gitdir: ${approved.adminDirectory}\n`).digest("hex") ||
    gitEntry.sha256 !== approved.gitFile.sha256 ||
    gitEntry.dev !== approved.gitFile.dev ||
    gitEntry.ino !== approved.gitFile.ino ||
    !within(join(approved.commonGitDirectory, "worktrees"), approved.adminDirectory)
  ) {
    refuse(`Approved Git worktree clearance is not bound to attempt ${attempt.path}.`);
  }
  for (const path of [approved.worktreePath, approved.adminDirectory]) {
    try {
      await lstat(path);
      refuse(`Git worktree or registration remains at ${path}; inspect it.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await assertIdentity(approved.source);
  await assertIdentity(approved.sourceGit);
  await assertIdentity(approved.commonGit);
  if (
    (await resolveGitDirectoryFromWorktree(approved.sourcePath, "cleanup-refused")) !==
      approved.sourceGitDirectory ||
    (await resolveCommonGitDirectory(approved.sourceGitDirectory, "cleanup-refused")) !==
      approved.commonGitDirectory
  ) {
    refuse(`Original repository Git directory changed for ${attempt.path}; inspect it.`);
  }
  const registrationRoot = join(approved.commonGitDirectory, "worktrees");
  for (const name of await readdir(registrationRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  })) {
    const pointer = join(registrationRoot, name, "gitdir");
    const target = await readRegistrationPointer(pointer).catch(() =>
      refuse(`Inspect changed Git registration ${pointer} before resuming deletion.`),
    );
    if (target === join(approved.worktreePath, ".git")) {
      refuse(`A new Git registration points to ${approved.worktreePath}; inspect it.`);
    }
  }
}

/** Revalidate the disk-backed authority under the same repository lock as publication. */
export async function cleanupRunDeliveryWorktree(
  inventory: RunDeliveryDeletionInventory,
  attempt: Attempt,
  record: RunRecord | undefined,
  approved: RunDeliveryWorktreeCleanupEvidence,
): Promise<void> {
  const { digest, ...body } = approved;
  if (
    digest !== worktreeCleanupEvidenceDigest(body) ||
    approved.attemptPath !== attempt.path ||
    approved.recordSha256 !== inventory.recordSha256
  ) {
    refuse(`Approved worktree inventory changed for ${attempt.path}; preview again.`);
  }
  await withRepositoryLock(
    approved.sourcePath,
    () => undefined,
    async () => {
      await withDeliveryRootGates([approved.receiptRoot], async () => {
        const worktreePresent = await lstat(approved.worktreePath).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        );
        const adminPresent = await lstat(approved.adminDirectory).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        );
        if (!worktreePresent && !adminPresent) {
          await assertRemovedWorktreeRegistration(inventory, attempt, approved);
          return;
        }
        if (!worktreePresent || !adminPresent || !record) {
          refuse(`Git worktree cleanup is partial at ${attempt.path}; inspect it before retrying.`);
        }
        const current = await inspectRunDeliveryWorktree(inventory, attempt, record);
        if (current.digest !== approved.digest) {
          refuse(`Git or receipt evidence changed for ${attempt.path}; preview again.`);
        }
        for (const entry of [
          approved.source,
          approved.sourceGit,
          approved.commonGit,
          approved.admin,
          approved.gitFile,
          approved.adminHead,
          approved.adminBackpointer,
          approved.adminIndex,
        ])
          await assertIdentity(entry);
        const commands = new ExecFileDeliveryCommandRunner();
        const removed = await runGit(
          commands,
          approved.mode === "patch"
            ? ["worktree", "remove", "--force", approved.worktreePath]
            : ["worktree", "remove", approved.worktreePath],
          approved.sourcePath,
        );
        if (removed.exitCode !== 0)
          refuse(`Git refused exact worktree cleanup at ${attempt.path}.`);
        await assertRemovedWorktreeRegistration(inventory, attempt, approved);
      });
    },
  );
}

/** One run branch that confirmed deletion removes, pinned to its approved tip. */
export interface RunDeliveryBranchCleanupEvidence {
  readonly sourcePath: string;
  readonly commonGitDirectory: string;
  /** Short name, such as `docsfab-run/<run>-<base>-<digest>`. */
  readonly branch: string;
  /** The run's base revision or the delivery commit its receipt records. */
  readonly revision: string;
  readonly source: GitDeletionIdentity;
  readonly commonGit: GitDeletionIdentity;
  readonly digest: string;
}

export interface RunDeliveryBranchInventory {
  readonly branches: readonly RunDeliveryBranchCleanupEvidence[];
  /** One preview sentence for each run branch that deletion keeps, with the reason. */
  readonly kept: readonly string[];
}

const DELIVERY_BRANCH_PREFIX = "docsfab-run/";

export function branchCleanupEvidenceDigest(
  evidence: Omit<RunDeliveryBranchCleanupEvidence, "digest">,
): string {
  return createHash("sha256")
    .update("docsfab-run-delivery-branch-cleanup-v1\0")
    .update(JSON.stringify(evidence))
    .digest("hex");
}

/** Whether journaled evidence is unaltered and names a DocsFab delivery branch. */
export function validBranchCleanupEvidence(evidence: RunDeliveryBranchCleanupEvidence): boolean {
  const { digest, ...body } = evidence;
  return (
    digest === branchCleanupEvidenceDigest(body) &&
    typeof evidence.branch === "string" &&
    evidence.branch.startsWith(DELIVERY_BRANCH_PREFIX) &&
    safeGitRef(`refs/heads/${evidence.branch}`)
  );
}

/**
 * How a worktree uses a branch. Git's own branch deletion refuses each of these,
 * and an update-refs rebase counts as "being rebased".
 */
interface BranchUse {
  readonly path: string;
  readonly how: "checked out" | "being rebased" | "being bisected";
}

/** One small state file in a worktree's Git directory, or undefined when Git did not write it. */
async function worktreeStateValue(
  administration: string,
  name: string,
): Promise<string | undefined> {
  const path = join(administration, ...name.split("/"));
  const present = await lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
      throw error;
    },
  );
  return present ? (await readRegistrationPointer(path)).trim() : undefined;
}

/**
 * How the worktree whose Git directory is `administration` uses `branchRef`.
 * HEAD counts when it names the branch or reaches it through symbolic refs, as
 * Git resolves it. A rebase or bisect detaches HEAD, so it is read from the
 * state Git keeps for it; any state that names the branch counts, even when
 * HEAD is attached again. A rebase with `--update-refs` also moves every branch
 * listed in its `update-refs` file, whichever branch its `head-name` names.
 */
async function worktreeBranchUse(
  administration: string,
  branchRef: string,
  refs: ReadonlyMap<string, string>,
): Promise<BranchUse["how"] | undefined> {
  const head = (await readDirectHead(administration, "cleanup-refused")).branch;
  if (head !== undefined && symbolicRefChain(refs, head, "cleanup-refused").includes(branchRef)) {
    return "checked out";
  }
  const names = [branchRef, branchRef.slice("refs/heads/".length)];
  for (const state of ["rebase-merge/head-name", "rebase-apply/head-name"]) {
    const value = await worktreeStateValue(administration, state);
    if (value !== undefined && names.includes(value)) return "being rebased";
  }
  // Three lines for each ref that the rebase will move: the ref, its old object id, its new one.
  const updating = await worktreeStateValue(administration, "rebase-merge/update-refs");
  if (updating?.split("\n").some((line) => line.trim() === branchRef)) return "being rebased";
  const bisecting = await worktreeStateValue(administration, "BISECT_START");
  return bisecting !== undefined && names.includes(bisecting) ? "being bisected" : undefined;
}

/**
 * Every worktree that uses `branchRef`, the original checkout included. Deleting
 * the ref directly, as the compare-and-delete does, no longer has Git's own
 * refusal behind it, so this is the only check that keeps a worktree's branch.
 */
async function branchUses(commonGitDirectory: string, branchRef: string): Promise<BranchUse[]> {
  const refs = await readDirectRefs(commonGitDirectory, "cleanup-refused");
  const uses: BranchUse[] = [];
  const original = await worktreeBranchUse(commonGitDirectory, branchRef, refs);
  if (original) uses.push({ path: dirname(commonGitDirectory), how: original });
  const registrations = join(commonGitDirectory, "worktrees");
  const names = await readdir(registrations).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  for (const name of names.sort()) {
    const administration = join(registrations, name);
    // Git resolves a linked worktree's HEAD through that worktree's own refs (refs/worktree,
    // refs/bisect, refs/rewritten), which sit beside its HEAD instead of in the shared refs. Read
    // only those: Git ignores every other entry in that directory, so none may override a shared ref.
    const ownRefs = new Map(refs);
    for (const namespace of ["refs/worktree", "refs/bisect", "refs/rewritten"]) {
      await readLooseRefs(administration, namespace, ownRefs, "cleanup-refused");
    }
    const how = await worktreeBranchUse(administration, branchRef, ownRefs);
    if (!how) continue;
    uses.push({
      path: dirname(await readRegistrationPointer(join(administration, "gitdir"))),
      how,
    });
  }
  return uses;
}

/** `checked out at /a, /b, being rebased at /c`: the paths grouped by how each uses the branch. */
function describeBranchUses(uses: readonly BranchUse[]): string {
  return [...new Set(uses.map(({ how }) => how))]
    .map(
      (how) =>
        `${how} at ${uses
          .filter((use) => use.how === how)
          .map(({ path }) => path)
          .join(", ")}`,
    )
    .join(", ");
}

/** Whether `revision` is a commit whose only parent is `baseRevision`, as DocsFab commits are. */
async function singleCommitOn(
  commands: ExecFileDeliveryCommandRunner,
  sourcePath: string,
  revision: string,
  baseRevision: string,
): Promise<boolean> {
  const raw = text(
    await requireGit(commands, sourcePath, ["cat-file", "commit", revision], "cleanup-refused"),
  );
  const headerEnd = raw.indexOf("\n\n");
  const parents = (headerEnd < 0 ? raw : raw.slice(0, headerEnd))
    .split("\n")
    .filter((line) => line.startsWith("parent "));
  return parents.length === 1 && parents[0] === `parent ${baseRevision}`;
}

/**
 * Decide one run branch. Only a branch DocsFab named for this run is deleted,
 * and only while its tip is the base revision or the delivery commit the run's
 * receipt records; a push or merge-request failure leaves it at that commit.
 */
async function decideRunDeliveryBranch(
  inventory: RunDeliveryDeletionInventory,
  record: RunRecord,
  plans: readonly LocalUserPublicationPlan[],
  worktrees: readonly RunDeliveryWorktreeCleanupEvidence[],
): Promise<RunDeliveryBranchCleanupEvidence | { readonly kept: string } | undefined> {
  const plan = plans[0]!;
  const branch = plan.proposedSourceBranch;
  const sourcePath = await originalSourcePath(inventory, record);
  const commands = new ExecFileDeliveryCommandRunner();
  await assertOriginalRemote(commands, sourcePath, plan, `branch ${branch}`);
  const commonGitDirectory = await resolveCommonGitDirectory(
    await resolveGitDirectoryFromWorktree(sourcePath, "cleanup-refused"),
    "cleanup-refused",
  );
  const branchRef = `refs/heads/${branch}`;
  const revision = await directRefRevision(commonGitDirectory, branchRef, "cleanup-refused");
  if (revision === undefined) return undefined;
  const named = deterministicLocalUserSourceBranch(
    plan.run.id,
    plan.baseRevision,
    plan.run.recordSha256,
    plan.patch.sha256,
  );
  if (branch !== named) return { kept: "DocsFab did not name it for this run" };
  const recorded = new Set<string>();
  for (const entry of inventory.receipts) {
    if (!plans.some((candidate) => candidate.sha256 === entry.planSha256)) continue;
    const receipt = await new FileScmDeliveryReceiptStore(entry.root).load(entry.idempotencyKey);
    const commit =
      receipt?.planSha256 === entry.planSha256 ? receipt.evidence.commit?.sha : undefined;
    if (commit) recorded.add(commit);
  }
  if (
    revision !== plan.baseRevision &&
    !(
      recorded.has(revision) &&
      (await singleCommitOn(commands, sourcePath, revision, plan.baseRevision))
    )
  ) {
    return {
      kept: `it points at ${revision}, not at the run's base revision or its recorded delivery commit`,
    };
  }
  const elsewhere = (await branchUses(commonGitDirectory, branchRef)).filter(
    ({ path }) => !worktrees.some((worktree) => worktree.worktreePath === path),
  );
  if (elsewhere.length > 0) return { kept: `it is ${describeBranchUses(elsewhere)}` };
  const body = {
    sourcePath,
    commonGitDirectory,
    branch,
    revision,
    source: await identity(sourcePath, "directory"),
    commonGit: await identity(commonGitDirectory, "directory"),
  };
  return { ...body, digest: branchCleanupEvidenceDigest(body) };
}

/**
 * Read-only choice of the run branches that confirmed deletion removes after
 * the approved worktrees; every other existing run branch is reported as kept.
 */
export async function inspectRunDeliveryBranches(
  inventory: RunDeliveryDeletionInventory,
  record: RunRecord,
  worktrees: readonly RunDeliveryWorktreeCleanupEvidence[],
): Promise<RunDeliveryBranchInventory> {
  const plansByBranch = new Map<string, LocalUserPublicationPlan[]>();
  for (const entry of inventory.plans) {
    if (entry.shared) continue;
    const plan = await new FileScmDeliveryReceiptStore(entry.root).loadPlan(entry.planSha256);
    if (!plan) continue;
    plansByBranch.set(plan.proposedSourceBranch, [
      ...(plansByBranch.get(plan.proposedSourceBranch) ?? []),
      plan,
    ]);
  }
  const branches: RunDeliveryBranchCleanupEvidence[] = [];
  const kept: string[] = [];
  for (const [branch, plans] of plansByBranch) {
    let decision: Awaited<ReturnType<typeof decideRunDeliveryBranch>>;
    try {
      decision = await decideRunDeliveryBranch(inventory, record, plans, worktrees);
    } catch {
      // Anything that prevents inspection leaves the branch in place.
      decision = {
        kept: `the original repository at ${record.repository?.sourcePath} could not be inspected`,
      };
    }
    if (decision === undefined) continue;
    if ("kept" in decision) kept.push(`Branch ${branch} would be kept: ${decision.kept}.`);
    else branches.push(decision);
  }
  return { branches, kept };
}

/** Approved branches that still exist, for resumed and incomplete counts. */
export async function countRemainingRunDeliveryBranches(
  branches: readonly RunDeliveryBranchCleanupEvidence[],
): Promise<number> {
  let remaining = 0;
  for (const approved of branches) {
    const branchRef = `refs/heads/${approved.branch}`;
    if (
      (await directRefRevision(approved.commonGitDirectory, branchRef, "cleanup-refused")) !==
      undefined
    ) {
      remaining += 1;
    }
  }
  return remaining;
}

/**
 * Delete one approved run branch under the publication repository lock, and only
 * while it still holds its approved tip and no worktree uses it; false when it
 * is already gone.
 */
export async function cleanupRunDeliveryBranch(
  approved: RunDeliveryBranchCleanupEvidence,
): Promise<boolean> {
  if (!validBranchCleanupEvidence(approved)) {
    refuse(`Approved branch inventory changed for ${approved.branch}; preview again.`);
  }
  const branchRef = `refs/heads/${approved.branch}`;
  return withRepositoryLock(
    approved.sourcePath,
    () => undefined,
    async () => {
      await assertIdentity(approved.source);
      await assertIdentity(approved.commonGit);
      const commonGitDirectory = await resolveCommonGitDirectory(
        await resolveGitDirectoryFromWorktree(approved.sourcePath, "cleanup-refused"),
        "cleanup-refused",
      );
      if (commonGitDirectory !== approved.commonGitDirectory) {
        refuse(
          `Original repository Git directory changed for branch ${approved.branch}; inspect it.`,
        );
      }
      const revision = await directRefRevision(commonGitDirectory, branchRef, "cleanup-refused");
      if (revision === undefined) return false;
      if (revision !== approved.revision) {
        refuse(`Branch ${approved.branch} moved after preview; inspect it and preview again.`);
      }
      const uses = await branchUses(commonGitDirectory, branchRef);
      if (uses.length > 0) {
        refuse(`Branch ${approved.branch} is ${describeBranchUses(uses)}; preview again.`);
      }
      // Compare-and-delete: Git removes the ref only while it still holds the approved tip, so a
      // tip that moves after the check above survives. `--no-deref` keeps a symbolic ref from
      // deleting the branch it names. Unlike `branch -D`, this leaves `branch.<name>` settings.
      const deleted = await runGit(
        new ExecFileDeliveryCommandRunner(),
        ["update-ref", "--no-deref", "-d", "--", branchRef, approved.revision],
        approved.sourcePath,
      );
      const remaining = await directRefRevision(commonGitDirectory, branchRef, "cleanup-refused");
      if (remaining === undefined) return deleted.exitCode === 0;
      if (remaining !== approved.revision) {
        refuse(`Branch ${approved.branch} moved after preview; inspect it and preview again.`);
      }
      refuse(`Git did not delete branch ${approved.branch}; inspect it.`);
    },
  );
}
