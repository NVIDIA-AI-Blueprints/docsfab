// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Exact local run-deletion inventory. The command never recursively follows links. */
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  ARTIFACT_OBJECT_LIMIT,
  DurableArtifactStore,
  opaqueRecordDigest,
} from "../artifacts/store.js";
import { decodeReviewLocatorObservation } from "../review/locator-provenance.js";
import {
  decodeSourceSnapshotPart,
  decodeSourceSnapshotRoot,
  readSourceSnapshotParts,
} from "../review-delivery/source-snapshot-store.js";
import { decodeReviewLocatorObservationReference } from "./contracts/run-records.js";
import { decodeReviewDeliverySnapshotReference } from "./review-delivery-snapshot-reference.js";
import { decodeRunChangeSources } from "./change-sources.js";
import {
  applyRunDeliveryDeletion,
  countRemainingRunDeliveryTargets,
  inventoryRunDelivery,
  runDeliveryInventoryDigest,
  type RunDeliveryDeletionInventory,
} from "../delivery/run-deletion-adapter.js";
import {
  cleanupRunDeliveryBranch,
  cleanupRunDeliveryWorktree,
  countRemainingRunDeliveryBranches,
  inspectRunDeliveryBranches,
  inspectRunDeliveryWorktree,
  validBranchCleanupEvidence,
  worktreeCleanupEvidenceDigest,
  type RunDeliveryBranchCleanupEvidence,
  type RunDeliveryWorktreeCleanupEvidence,
} from "../delivery/worktree/run-deletion-cleanup.js";
import { contextCacheKey, FileContextCache, type ContextCacheIdentity } from "../context/cache.js";
import { validateContextResult } from "../context/compiler.js";
import {
  decodeQualityValidationBinding,
  decodeStoredQualityArtifact,
} from "../evaluation-report/quality-artifact-staging.js";
import { limit, refuseLimit, type ResolvedLimit } from "../config/limits.js";
import { parseJsonEvidence } from "../json-evidence.js";
import { runLimitOverflowSidecarPath } from "../operator/run-limit-overflow.js";
import type { RunRecord } from "./contracts.js";
import { FileRunStore, SAFE_RECORD_ID } from "./file-store.js";
import { runRecordMaxBytes } from "./run-record-limit.js";
import { defaultRunIndexDirectory } from "./run-index-signals.js";
import { decodeRunIndexRow } from "./run-index.js";
import { purgeRunIndexRows } from "./run-index-store.js";
import { readStudyRun } from "./study-store.js";
import { isRecord } from "../shared/primitives.js";
import { validOverflowSidecar } from "./run-deletion/overflow-sidecar.js";
import {
  isRunTombstoned,
  markArtifactObjectForDeletion,
  referencedArtifactDigests,
  withActiveRunGate,
  withArtifactReferenceGates,
  withPatchRootGates,
  withRunMaintenanceGate,
  writeRunTombstone,
} from "./run-maintenance-gate.js";

interface EntryIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly kind: "file" | "directory";
  readonly sha256?: string;
}

interface RunDeletionCounts {
  readonly runId: string;
  readonly stateDirectory: string;
  readonly confirmation: string;
  readonly files: number;
  readonly directories: number;
  readonly sharedRetained: number;
  readonly unresolved: number;
  readonly indexRows: number;
  readonly indexOverflow: boolean;
  readonly deliveryIndexRows: number;
}

export interface RunDeletionPreview extends RunDeletionCounts {
  /** Registered delivery worktrees Git removes, including detached retries. */
  readonly worktrees: number;
  /** Run delivery branches deleted after those worktrees. */
  readonly branches: readonly string[];
  /** One sentence for each run branch that deletion keeps, with the reason. */
  readonly keptBranches: readonly string[];
}

interface RunDeletionInventory extends RunDeletionCounts {
  readonly roots: readonly EntryIdentity[];
  readonly entries: readonly EntryIdentity[];
  readonly recordPath: string;
  readonly artifacts: readonly ArtifactCandidate[];
  readonly residuals: readonly string[];
  readonly sharedCaches: readonly string[];
  readonly patchRoots: readonly string[];
  readonly indexFile?: EntryIdentity;
  readonly overflowFile?: EntryIdentity;
  readonly delivery: RunDeliveryDeletionInventory;
  readonly gitCleanups: readonly RunDeliveryWorktreeCleanupEvidence[];
  /** Absent from journals written before run branches were inventoried. */
  readonly gitBranches?: readonly RunDeliveryBranchCleanupEvidence[];
  readonly keptBranches?: readonly string[];
}

interface ArtifactCandidate {
  readonly root: string;
  readonly digest: string;
  readonly object: EntryIdentity;
  readonly shared: boolean;
}

interface RunDeletionJournal {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-run-deletion-journal";
  readonly approved: RunDeletionInventory;
}

function deliveryDigestMatches(inventory: RunDeliveryDeletionInventory): boolean {
  const { digest, ...body } = inventory;
  return digest === runDeliveryInventoryDigest(body);
}

function confirmationFor(
  input: Pick<
    RunDeletionInventory,
    | "runId"
    | "stateDirectory"
    | "roots"
    | "entries"
    | "artifacts"
    | "residuals"
    | "sharedCaches"
    | "patchRoots"
    | "indexRows"
    | "indexOverflow"
    | "indexFile"
    | "overflowFile"
    | "delivery"
    | "gitCleanups"
    | "gitBranches"
    | "keptBranches"
  >,
): string {
  const stable = {
    runId: input.runId,
    stateDirectory: input.stateDirectory,
    roots: input.roots,
    entries: input.entries,
    artifacts: input.artifacts,
    residuals: input.residuals,
    sharedCaches: input.sharedCaches,
    patchRoots: input.patchRoots,
    indexRows: input.indexRows,
    indexOverflow: input.indexOverflow,
    indexFile: input.indexFile,
    overflowFile: input.overflowFile,
    delivery: input.delivery,
    gitCleanups: input.gitCleanups,
    gitBranches: input.gitBranches,
    keptBranches: input.keptBranches,
  };
  return createHash("sha256")
    .update("docsfab-run-deletion-preview-v1\0")
    .update(JSON.stringify(stable))
    .digest("hex");
}

export interface RunDeletionResult {
  readonly runId: string;
  readonly complete: boolean;
  readonly removed: number;
  readonly sharedRetained: number;
  readonly unresolved: number;
  readonly nextAction?: string;
}

export interface RunDeletionHooks {
  /** Test seam immediately after a validated target has been unlinked. */
  readonly afterRemove?: (path: string) => void | Promise<void>;
}

export interface RunDeletionRoots {
  readonly receiptRoots?: readonly string[];
  readonly deliveryRoots?: readonly string[];
}

export class RunDeletionError extends Error {
  public constructor(
    public readonly code: string,
    public readonly nextAction: string,
  ) {
    super(`Run deletion stopped (${code}). ${nextAction}`);
    this.name = "RunDeletionError";
  }
}

function failure(code: string, nextAction: string): never {
  throw new RunDeletionError(code, nextAction);
}

function journalFile(root: string, runId: string): string {
  const digest = createHash("sha256")
    .update("docsfab-run-deletion-journal-v1\0")
    .update(root)
    .update("\0")
    .update(runId)
    .digest("hex");
  return join(root, ".docsfab-run-delete-journals", `${digest}.json`);
}

async function loadJournal(root: string, runId: string): Promise<RunDeletionJournal | undefined> {
  const path = journalFile(root, runId);
  const journalRoot = dirname(path);
  try {
    const directory = await lstat(journalRoot);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.uid !== process.getuid?.() ||
      (directory.mode & 0o077) !== 0
    ) {
      return failure("journal-unsafe", "Inspect the private deletion journal before retrying.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let stat: Stats;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  ) {
    return failure("journal-unsafe", "Inspect the private deletion journal before retrying.");
  }
  const value = JSON.parse(await readFile(path, "utf8")) as RunDeletionJournal;
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "docsfab-run-deletion-journal" ||
    value.approved.stateDirectory !== root ||
    value.approved.runId !== runId ||
    value.approved.recordPath !== join(root, `${runId}.json`) ||
    !Array.isArray(value.approved.entries) ||
    !Array.isArray(value.approved.roots) ||
    !Array.isArray(value.approved.residuals) ||
    !Array.isArray(value.approved.sharedCaches) ||
    !Array.isArray(value.approved.patchRoots) ||
    !Array.isArray(value.approved.gitCleanups) ||
    !Array.isArray(value.approved.gitBranches ?? []) ||
    (value.approved.gitBranches ?? []).some((item) => !validBranchCleanupEvidence(item)) ||
    !Array.isArray(value.approved.keptBranches ?? []) ||
    (value.approved.keptBranches ?? []).some((line) => typeof line !== "string") ||
    !value.approved.delivery ||
    value.approved.gitCleanups.some((item) => {
      const { digest, ...body } = item;
      return (
        digest !== worktreeCleanupEvidenceDigest(body) ||
        !value.approved.delivery.attempts.some((attempt) => attempt.path === item.attemptPath)
      );
    }) ||
    value.approved.delivery.stateDirectory !== root ||
    value.approved.delivery.runId !== runId ||
    value.approved.delivery.recordSha256 !==
      value.approved.entries.find((entry) => entry.path === value.approved.recordPath)?.sha256 ||
    !deliveryDigestMatches(value.approved.delivery) ||
    value.approved.confirmation !== confirmationFor(value.approved)
  ) {
    return failure("journal-invalid", "Inspect the private deletion journal before retrying.");
  }
  const permittedReport = join(root, "reports", runId);
  const permitted = new Set([
    join(root, `${runId}.json`),
    runLimitOverflowSidecarPath(join(root, `${runId}.json`)),
    join(root, "study", `${runId}.json`),
  ]);
  for (const patchRoot of value.approved.patchRoots) {
    for (const suffix of ["", ".candidate0", ".candidate1", ".failed-partial"]) {
      permitted.add(join(patchRoot, `${runId}${suffix}.patch`));
    }
  }
  for (const entry of value.approved.entries) {
    if (
      typeof entry.path !== "string" ||
      resolve(entry.path) !== entry.path ||
      (!permitted.has(entry.path) &&
        entry.path !== permittedReport &&
        !entry.path.startsWith(`${permittedReport}/`))
    ) {
      return failure("journal-invalid", "Inspect the private deletion journal before retrying.");
    }
  }
  if (!Array.isArray(value.approved.artifacts)) {
    return failure("journal-invalid", "Inspect the private deletion journal before retrying.");
  }
  for (const candidate of value.approved.artifacts) {
    if (
      ![join(dirname(root), "artifacts"), join(root, "artifacts")].includes(candidate.root) ||
      !/^[a-f0-9]{64}$/u.test(candidate.digest) ||
      candidate.object.path !==
        join(candidate.root, "objects", "sha256", `${candidate.digest}.json`)
    ) {
      return failure("journal-invalid", "Inspect the private deletion journal before retrying.");
    }
  }
  return value;
}

async function writeJournal(approved: RunDeletionInventory): Promise<void> {
  const root = join(approved.stateDirectory, ".docsfab-run-delete-journals");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await lstat(root);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0
  ) {
    return failure("journal-unsafe", "Inspect the private deletion journal before retrying.");
  }
  const path = journalFile(approved.stateDirectory, approved.runId);
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(
      JSON.stringify({ schemaVersion: 1, kind: "docsfab-run-deletion-journal", approved }),
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function identity(
  path: string,
  kind: EntryIdentity["kind"],
  byteBound?: ResolvedLimit,
): Promise<EntryIdentity> {
  let stat: Stats;
  try {
    stat = await lstat(path);
  } catch {
    return failure("entry-changed", "Preview the run again before confirming deletion.");
  }
  if ((kind === "file" && !stat.isFile()) || (kind === "directory" && !stat.isDirectory())) {
    return failure("unsafe-entry", "Inspect the changed local store and preview the run again.");
  }
  if (stat.isSymbolicLink() || (kind === "file" && stat.nlink !== 1)) {
    return failure("unsafe-entry", "Remove the unsafe link or alias before retrying.");
  }
  if (stat.uid !== process.getuid?.()) {
    return failure("owner-mismatch", "Restore ownership of the local store before retrying.");
  }
  if (byteBound && stat.size > byteBound.value) refuseLimit(byteBound, stat.size);
  if (kind === "directory") {
    return { path, dev: stat.dev, ino: stat.ino, size: 0, mtimeMs: 0, kind };
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const pinned = await handle.stat();
    if (
      pinned.dev !== stat.dev ||
      pinned.ino !== stat.ino ||
      pinned.size !== stat.size ||
      pinned.mtimeMs !== stat.mtimeMs
    ) {
      return failure("entry-changed", "Preview the run again before confirming deletion.");
    }
    if (byteBound && pinned.size > byteBound.value) refuseLimit(byteBound, pinned.size);
    const digest = createHash("sha256");
    let observed = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const part = chunk as Buffer;
      observed += part.byteLength;
      if (byteBound && observed > byteBound.value) refuseLimit(byteBound, observed);
      digest.update(part);
    }
    const after = await handle.stat();
    if (
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs
    ) {
      return failure("entry-changed", "Preview the run again before confirming deletion.");
    }
    return {
      path,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      kind,
      sha256: digest.digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

async function optionalFile(path: string, entries: EntryIdentity[]): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  entries.push(await identity(path, "file"));
}

type ClassifiedRunEntry =
  | { readonly kind: "record"; readonly value: RunRecord; readonly entry: EntryIdentity }
  | {
      readonly kind: "sidecar";
      readonly owner: string;
      readonly value: unknown;
      readonly entry: EntryIdentity;
    };

async function classifyRunEntry(stateDirectory: string, name: string): Promise<ClassifiedRunEntry> {
  const path = join(stateDirectory, name);
  const byteBound = runRecordMaxBytes();
  const entry = await identity(path, "file", byteBound);
  let raw: Buffer;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      before.dev !== entry.dev ||
      before.ino !== entry.ino ||
      before.size !== entry.size ||
      before.mtimeMs !== entry.mtimeMs
    ) {
      return failure("entry-changed", "Preview the run again before confirming deletion.");
    }
    raw = await handle.readFile();
    if (raw.byteLength > byteBound.value) refuseLimit(byteBound, raw.byteLength);
    const after = await handle.stat();
    if (
      after.dev !== entry.dev ||
      after.ino !== entry.ino ||
      after.size !== entry.size ||
      after.mtimeMs !== entry.mtimeMs ||
      createHash("sha256").update(raw).digest("hex") !== entry.sha256
    ) {
      return failure("entry-changed", "Preview the run again before confirming deletion.");
    }
  } finally {
    await handle.close();
  }
  let value: unknown;
  try {
    value = parseJsonEvidence(raw);
  } catch {
    return failure(
      "artifact-owner-invalid",
      "Inspect retained run records and overflow sidecars before deletion.",
    );
  }
  const namedId = name.slice(0, -".json".length);
  if (!isRecord(value)) {
    return failure(
      "artifact-owner-invalid",
      "Inspect retained run records and overflow sidecars before deletion.",
    );
  }
  if (
    value.id === namedId &&
    value.kind !== "docsfab-run-limit-overflow" &&
    value.runId === undefined
  ) {
    const stored = await new FileRunStore(stateDirectory).getWithDigest(namedId, {
      maxBytes: runRecordMaxBytes().value,
    });
    if (stored.sha256 !== entry.sha256) {
      return failure("entry-changed", "Preview the run again before confirming deletion.");
    }
    return { kind: "record", value: stored.record as RunRecord, entry };
  }
  if (name.endsWith(".limit-overflow.json")) {
    const owner = name.slice(0, -".limit-overflow.json".length);
    try {
      if (SAFE_RECORD_ID.test(owner) && validOverflowSidecar(value, owner)) {
        return { kind: "sidecar", owner, value, entry };
      }
    } catch {
      // A malformed sidecar never becomes a deletion target or a skipped owner.
    }
  }
  return failure(
    "artifact-owner-invalid",
    "Inspect retained run records and overflow sidecars before deletion.",
  );
}

function countInventoryEntry(budget: { count: number; max: number }): void {
  budget.count += 1;
  if (budget.count > budget.max) {
    refuseLimit(limit("runs.deletionInventoryMaxEntries"), budget.count);
  }
}

async function optionalTree(
  path: string,
  entries: EntryIdentity[],
  budget: { count: number; max: number },
): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  countInventoryEntry(budget);
  entries.push(await identity(path, "directory"));
  for (const name of await readdir(path)) {
    const child = join(path, name);
    const stat = await lstat(child);
    if (stat.isDirectory()) await optionalTree(child, entries, budget);
    else {
      countInventoryEntry(budget);
      entries.push(await identity(child, "file"));
    }
  }
}

function artifactReferences(value: unknown, budget: { count: number; max: number }): Set<string> {
  const digests = referencedArtifactDigests(value, () => {
    budget.count += 1;
    if (budget.count > budget.max) {
      refuseLimit(limit("runs.deletionInventoryMaxEntries"), budget.count);
    }
  });
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const root = value as Record<string, unknown>;
    if (root.reviewDeliverySnapshot !== undefined) {
      try {
        const sources = decodeRunChangeSources(root.changeSources, root.workflow);
        const reference = decodeReviewDeliverySnapshotReference(root.reviewDeliverySnapshot, {
          runId: root.id as string,
          workflow: root.workflow as string,
          status: root.status as string,
          changeSources: sources,
        });
        digests.add(reference.rootObjectSha256);
      } catch {
        failure(
          "artifact-owner-invalid",
          "Inspect the retained review source reference before deleting this run.",
        );
      }
    }
    if (root.kind === "docsfab-review-delivery-snapshot") {
      try {
        for (const digest of decodeSourceSnapshotRoot(root).partDigests) digests.add(digest);
      } catch {
        failure(
          "artifact-owner-invalid",
          "Inspect the retained review source root before deleting this run.",
        );
      }
    }
    const steps = (value as Record<string, unknown>).steps;
    if (Array.isArray(steps)) {
      for (const step of steps) {
        if (!step || typeof step !== "object" || Array.isArray(step)) continue;
        const reference = (step as Record<string, unknown>).reviewLocatorObservation;
        if (reference === undefined) continue;
        try {
          digests.add(decodeReviewLocatorObservationReference(reference).objectSha256);
        } catch {
          failure(
            "artifact-owner-invalid",
            "Inspect the retained review locator reference before deleting this run.",
          );
        }
      }
    }
  }
  return digests;
}

/** Opaque hosted owner records can bind an object by a named digest field. */
function embeddedCandidateDigests(
  value: unknown,
  candidates: ReadonlySet<string>,
  budget: { count: number; max: number },
): Set<string> {
  const owned = new Set<string>();
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node === "string") {
      if (candidates.has(node)) owned.add(node);
    } else if (Array.isArray(node)) {
      budget.count += 1;
      if (budget.count > budget.max)
        refuseLimit(limit("runs.deletionInventoryMaxEntries"), budget.count);
      for (const item of node) stack.push(item);
    } else if (node && typeof node === "object") {
      budget.count += 1;
      if (budget.count > budget.max)
        refuseLimit(limit("runs.deletionInventoryMaxEntries"), budget.count);
      for (const item of Object.values(node)) stack.push(item);
    }
  }
  return owned;
}

async function objectJson(path: string): Promise<unknown> {
  const objectLimit = limit(ARTIFACT_OBJECT_LIMIT);
  const entry = await identity(path, "file", objectLimit);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const pinned = await handle.stat();
    if (
      pinned.dev !== entry.dev ||
      pinned.ino !== entry.ino ||
      pinned.size !== entry.size ||
      pinned.mtimeMs !== entry.mtimeMs
    ) {
      return failure("artifact-changed", "Preview the run again before confirming deletion.");
    }
    const chunks: Buffer[] = [];
    let observed = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const part = chunk as Buffer;
      observed += part.byteLength;
      if (observed > objectLimit.value) refuseLimit(objectLimit, observed);
      chunks.push(part);
    }
    bytes = Buffer.concat(chunks, observed);
  } finally {
    await handle.close();
  }
  if (!sameIdentity(entry, await identity(path, "file", objectLimit))) {
    return failure("artifact-changed", "Preview the run again before confirming deletion.");
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return failure(
      "artifact-store-invalid",
      "Inspect the malformed artifact-store object before deleting this run.",
    );
  }
}

/** A valid semantic-key cache entry belongs to its reusable cache key, not a run ID. */
async function isSharedContextCacheEntry(directory: string, name: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}\.json$/u.test(name)) return false;
  const path = join(directory, name);
  try {
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > runRecordMaxBytes().value
    )
      return false;
    const envelope = JSON.parse(await readFile(path, "utf8")) as {
      key?: unknown;
      identity?: unknown;
    };
    if (
      envelope.key !== name.slice(0, -".json".length) ||
      !envelope.identity ||
      typeof envelope.identity !== "object"
    )
      return false;
    const identity = envelope.identity as ContextCacheIdentity;
    if (contextCacheKey(identity) !== envelope.key) return false;
    const read = await new FileContextCache(directory).read(identity);
    if (read.status !== "hit") return false;
    validateContextResult(read.result);
    return true;
  } catch {
    return false;
  }
}

async function scanArtifactCandidates(
  stateDirectory: string,
  runId: string,
  record: RunRecord,
  targetSidecar: unknown,
  allowMissingDigests: ReadonlySet<string> = new Set(),
  sharedBudget?: { count: number; max: number },
): Promise<ArtifactCandidate[]> {
  const bound = limit("runs.deletionInventoryMaxEntries");
  const budget = sharedBudget ?? { count: 0, max: bound.value };
  const direct = artifactReferences(record, budget);
  for (const digest of artifactReferences(targetSidecar, budget)) direct.add(digest);
  const roots = [join(dirname(stateDirectory), "artifacts"), join(stateDirectory, "artifacts")];
  const objectDirectories: string[] = [];
  for (const root of roots) {
    const stat = await identityIfPresent(root, "directory");
    if (!stat) continue;
    const objects = await identityIfPresent(join(root, "objects"), "directory");
    const sha = await identityIfPresent(join(root, "objects", "sha256"), "directory");
    if (!objects || !sha) {
      return failure(
        "artifact-store-invalid",
        "Inspect the local artifact store before deleting this run.",
      );
    }
    objectDirectories.push(join(root, "objects", "sha256"));
  }
  // Older validation attempts may have staged sealed objects before the run's
  // final binding was saved. Their top-level run ID is the durable owner.
  for (const objectDirectory of objectDirectories) {
    for (const name of await readdir(objectDirectory)) {
      countInventoryEntry(budget);
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) {
        return failure(
          "artifact-store-invalid",
          "Inspect the unknown artifact-store entry before deleting this run.",
        );
      }
      const digest = name.slice(0, -".json".length);
      const value = await objectJson(join(objectDirectory, name));
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const owned = value as Record<string, unknown>;
      if (owned.runId !== runId) continue;
      try {
        if (owned.kind === "docsfab-quality-artifact-validation-binding") {
          const binding = decodeQualityValidationBinding(value);
          if (binding.bindingSha256 !== digest) {
            return failure(
              "artifact-owner-invalid",
              "Inspect the sealed quality objects for this run before deletion.",
            );
          }
          direct.add(digest);
          for (const child of artifactReferences(binding, budget)) direct.add(child);
        } else if (owned.kind === "docsfab-quality-artifact-record") {
          const artifact = decodeStoredQualityArtifact(value);
          if (artifact.recordSha256 !== digest) {
            return failure(
              "artifact-owner-invalid",
              "Inspect the sealed quality objects for this run before deletion.",
            );
          }
          direct.add(digest);
        } else if (owned.kind === "docsfab-review-locator-observation") {
          const observation = decodeReviewLocatorObservation(value);
          if (opaqueRecordDigest(observation) !== digest) {
            return failure(
              "artifact-owner-invalid",
              "Inspect the sealed review locator object for this run before deletion.",
            );
          }
          direct.add(digest);
        } else if (owned.kind === "docsfab-review-delivery-snapshot") {
          const root = decodeSourceSnapshotRoot(value);
          if (opaqueRecordDigest(root) !== digest) {
            return failure(
              "artifact-owner-invalid",
              "Inspect the sealed review source root before deleting this run.",
            );
          }
          direct.add(digest);
        } else if (owned.kind === "docsfab-review-delivery-snapshot-part") {
          // A failed root write leaves this sealed, run-owned part without a
          // parent edge. Admit it directly only after checking its contents
          // and address; the shared-reference scan below still protects it.
          const { part } = decodeSourceSnapshotPart(value);
          if (part.runId !== runId || opaqueRecordDigest(part) !== digest) {
            return failure(
              "artifact-owner-invalid",
              "Inspect the sealed review source part before deleting this run.",
            );
          }
          direct.add(digest);
        }
      } catch {
        return failure(
          "artifact-owner-invalid",
          "Inspect the sealed owned artifact objects for this run before deletion.",
        );
      }
    }
  }
  const queue = [...direct];
  const candidates = new Map<string, ArtifactCandidate>();
  const seenDigests = new Set<string>();
  while (queue.length > 0) {
    const digest = queue.shift() as string;
    if (seenDigests.has(digest)) continue;
    seenDigests.add(digest);
    budget.count += 1;
    if (budget.count > bound.value) refuseLimit(bound, budget.count);
    let located = false;
    for (const objectDirectory of objectDirectories) {
      const path = join(objectDirectory, `${digest}.json`);
      const object = await identityIfPresent(path, "file");
      if (!object) continue;
      located = true;
      const value = await objectJson(path);
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).kind === "docsfab-review-delivery-snapshot"
      ) {
        try {
          await readSourceSnapshotParts(
            new DurableArtifactStore(dirname(dirname(objectDirectory))),
            digest,
          );
        } catch {
          return failure(
            "artifact-owner-invalid",
            "Inspect the sealed review source root and its parts before deleting this run.",
          );
        }
      }
      for (const child of artifactReferences(value, budget)) queue.push(child);
      candidates.set(path, {
        root: dirname(dirname(objectDirectory)),
        digest,
        object,
        shared: false,
      });
    }
    if (!located && !allowMissingDigests.has(digest)) {
      return failure(
        "artifact-object-missing",
        "Locate the historical artifact root or repair the missing local object before deleting this run.",
      );
    }
  }
  const retainedReferences = new Set<string>();
  const candidateDigests = new Set([...candidates.values()].map((candidate) => candidate.digest));
  for (const name of await readdir(stateDirectory)) {
    if (!name.endsWith(".json") || name === `${runId}.json`) continue;
    const otherId = name.slice(0, -".json".length);
    if (!SAFE_RECORD_ID.test(otherId)) continue;
    budget.count += 1;
    if (budget.count > bound.value) refuseLimit(bound, budget.count);
    const other = await classifyRunEntry(stateDirectory, name);
    if (other.kind === "sidecar" && other.owner === runId) continue;
    for (const digest of artifactReferences(other.value, budget)) retainedReferences.add(digest);
    if (other.kind === "sidecar") {
      for (const digest of embeddedCandidateDigests(other.value, candidateDigests, budget)) {
        retainedReferences.add(digest);
      }
    }
  }
  const candidatePaths = new Set(candidates.keys());
  for (const objectDirectory of objectDirectories) {
    for (const name of await readdir(objectDirectory)) {
      countInventoryEntry(budget);
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) {
        return failure(
          "artifact-store-invalid",
          "Inspect the unknown artifact-store entry before deleting this run.",
        );
      }
      const path = join(objectDirectory, name);
      if (candidatePaths.has(path)) continue;
      const value = await objectJson(path);
      for (const digest of artifactReferences(value, budget)) {
        retainedReferences.add(digest);
      }
      for (const digest of embeddedCandidateDigests(value, candidateDigests, budget)) {
        retainedReferences.add(digest);
      }
    }
  }
  for (const candidate of candidates.values()) {
    if (retainedReferences.has(candidate.digest)) {
      candidates.set(candidate.object.path, { ...candidate, shared: true });
    }
  }
  // A retained parent object also retains the objects it references.
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates.values()) {
      if (!candidate.shared) continue;
      for (const digest of artifactReferences(await objectJson(candidate.object.path), budget)) {
        for (const child of candidates.values()) {
          if (child.digest === digest && !child.shared) {
            candidates.set(child.object.path, { ...child, shared: true });
            changed = true;
          }
        }
      }
    }
  }
  return [...candidates.values()].sort((a, b) => a.object.path.localeCompare(b.object.path));
}

function sameIdentity(left: EntryIdentity, right: EntryIdentity): boolean {
  return (
    left.path === right.path &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.kind === right.kind &&
    left.sha256 === right.sha256
  );
}

async function patchRootFromRecord(record: RunRecord, runId: string): Promise<string | undefined> {
  const named = record.changes?.patch?.artifactPath;
  if (!named) return undefined;
  if (!isAbsolute(named) || resolve(named) !== named) {
    return failure("patch-path-invalid", "Inspect the saved patch path before deleting this run.");
  }
  const expectedNames = ["", ".candidate0", ".candidate1", ".failed-partial"].map(
    (suffix) => `${runId}${suffix}.patch`,
  );
  if (!expectedNames.includes(basename(named))) {
    return failure(
      "patch-owner-mismatch",
      "Inspect the saved run's patch ownership before deletion.",
    );
  }
  const root = dirname(named);
  const canonicalRoot = await realpath(root).catch(() => "");
  if (!canonicalRoot) {
    return failure(
      "patch-root-missing",
      "Restore the historical patch root before deleting this run.",
    );
  }
  await identity(root, "directory");
  return canonicalRoot;
}

async function scanRunIndexTargets(
  stateDirectory: string,
  runId: string,
): Promise<{
  indexFile?: EntryIdentity;
  overflowFile?: EntryIdentity;
  indexRows: number;
  indexOverflow: boolean;
  residuals: string[];
  indexRoot?: EntryIdentity;
}> {
  const directory = defaultRunIndexDirectory(stateDirectory);
  const indexRoot = await identityIfPresent(directory, "directory");
  if (!indexRoot) return { indexRows: 0, indexOverflow: false, residuals: [] };
  const indexFile = await identityIfPresent(join(directory, "runs.jsonl"), "file");
  const overflowFile = await identityIfPresent(join(directory, "overflow.json"), "file");
  const residuals: string[] = [];
  let indexRows = 0;
  let indexOverflow = false;
  if (indexFile) {
    const bound = limit("runs.indexMaxBytes");
    if (indexFile.size > bound.value) refuseLimit(bound, indexFile.size);
    for (const line of (await readFile(indexFile.path, "utf8")).split("\n")) {
      if (!line) continue;
      try {
        const row = decodeRunIndexRow(JSON.parse(line));
        if (row?.runId === runId) indexRows += 1;
        else if (!row && line.includes(runId)) residuals.push(indexFile.path);
      } catch {
        if (line.includes(runId)) residuals.push(indexFile.path);
      }
    }
  }
  if (overflowFile) {
    const bound = limit("runs.indexMaxBytes");
    if (overflowFile.size > bound.value) refuseLimit(bound, overflowFile.size);
    const raw = await readFile(overflowFile.path, "utf8");
    try {
      const overflow = JSON.parse(raw) as {
        schemaVersion?: unknown;
        kind?: unknown;
        lastRefusedRunId?: unknown;
        refusedSnapshots?: unknown;
      };
      if (
        overflow.schemaVersion !== 1 ||
        overflow.kind !== "docsfab-run-index-overflow" ||
        !Number.isSafeInteger(overflow.refusedSnapshots) ||
        (overflow.refusedSnapshots as number) < 1
      )
        residuals.push(overflowFile.path);
      else if (overflow.lastRefusedRunId === runId) {
        if (overflow.refusedSnapshots === 1) indexOverflow = true;
        else residuals.push(overflowFile.path);
      } else if (raw.includes(runId)) residuals.push(overflowFile.path);
    } catch {
      residuals.push(overflowFile.path);
    }
  }
  return {
    indexRoot,
    ...(indexFile ? { indexFile } : {}),
    ...(overflowFile ? { overflowFile } : {}),
    indexRows,
    indexOverflow,
    residuals,
  };
}

async function inventory(
  stateDirectory: string,
  runId: string,
  suppliedRoots: RunDeletionRoots = {},
): Promise<RunDeletionInventory> {
  if (!SAFE_RECORD_ID.test(runId)) {
    return failure("unsafe-run-id", "Use a run ID printed by docsfab runs list.");
  }
  const root = await realpath(resolve(stateDirectory));
  const namedRoot = await lstat(resolve(stateDirectory));
  if (!namedRoot.isDirectory() || namedRoot.isSymbolicLink())
    return failure("unsafe-root", "Use a private state directory and preview again.");
  const recordPath = join(root, `${runId}.json`);
  const recordBound = runRecordMaxBytes();
  const recordIdentity = await identity(recordPath, "file", recordBound);
  const record = (
    await new FileRunStore(root).getWithDigest(runId, {
      maxBytes: recordBound.value,
    })
  ).record as RunRecord;
  if (record.id !== runId) {
    return failure("record-mismatch", "Inspect the saved run record before retrying.");
  }
  if (record.status === "running" || record.status === "queued") {
    return failure("run-active", "Wait for the run to finish before deleting it.");
  }
  const roots = [await identity(root, "directory")];
  const entries: EntryIdentity[] = [recordIdentity];
  const inventoryBound = limit("runs.deletionInventoryMaxEntries");
  const inventoryBudget = { count: 0, max: inventoryBound.value };
  const sidecarPath = runLimitOverflowSidecarPath(recordPath);
  let targetSidecar: unknown;
  if (await identityIfPresent(sidecarPath, "file")) {
    const classified = await classifyRunEntry(root, basename(sidecarPath));
    if (classified.kind === "sidecar" && classified.owner === runId) {
      entries.push(classified.entry);
      targetSidecar = classified.value;
    }
  }
  const studyPath = join(root, "study", `${runId}.json`);
  if (await identityIfPresent(studyPath, "file")) {
    const study = await readStudyRun(join(root, "study"), runId);
    if (study.runId !== runId) {
      return failure("study-owner-mismatch", "Inspect the study evidence before deleting the run.");
    }
    roots.push(await identity(join(root, "study"), "directory"));
    await optionalFile(studyPath, entries);
  }
  const historicalPatchRoot = await patchRootFromRecord(record, runId);
  const patchRoots = [
    ...new Set([
      join(dirname(root), "patches"),
      join(root, "patches"),
      ...(historicalPatchRoot ? [historicalPatchRoot] : []),
    ]),
  ];
  for (const patchRoot of patchRoots) {
    const existing = await identityIfPresent(patchRoot, "directory");
    if (!existing) continue;
    roots.push(existing);
    for (const suffix of ["", ".candidate0", ".candidate1", ".failed-partial"]) {
      await optionalFile(join(patchRoot, `${runId}${suffix}.patch`), entries);
    }
  }
  const retainedPatch = record.changes?.patch;
  if (retainedPatch) {
    const saved = entries.find(
      (entry) =>
        entry.path === join(historicalPatchRoot as string, basename(retainedPatch.artifactPath)),
    );
    if (
      !saved ||
      saved.sha256 !== retainedPatch.sha256 ||
      saved.size !== retainedPatch.byteLength
    ) {
      return failure(
        "patch-evidence-mismatch",
        "Restore or inspect the historical patch evidence before deletion.",
      );
    }
  }
  const reportsRoot = join(root, "reports");
  if (await identityIfPresent(reportsRoot, "directory")) {
    roots.push(await identity(reportsRoot, "directory"));
    await optionalTree(join(reportsRoot, runId), entries, inventoryBudget);
  }
  const artifacts = await scanArtifactCandidates(
    root,
    runId,
    record,
    targetSidecar,
    new Set(),
    inventoryBudget,
  );
  const index = await scanRunIndexTargets(root, runId);
  const delivery = await inventoryRunDelivery({
    stateDirectory: root,
    runId,
    recordSha256: recordIdentity.sha256!,
    ...suppliedRoots,
  });
  const deliveryEntries = [
    ...delivery.receipts.flatMap((receipt) => receipt.entries),
    ...delivery.plans.filter((plan) => !plan.shared).map((plan) => plan.entry),
    ...delivery.attempts.flatMap((attempt) => attempt.entries),
    ...delivery.metadata,
  ];
  const deliveryIndexRows = delivery.index.affected.reduce(
    (count, chain) => count + chain.slots.filter((slot) => slot.entry.runId === runId).length,
    0,
  );
  if (index.indexRoot) roots.push(index.indexRoot);
  const residuals: string[] = [...index.residuals, ...delivery.unresolved];
  const gitCleanups: RunDeliveryWorktreeCleanupEvidence[] = [];
  for (const attempt of delivery.attempts.filter(
    (candidate) => candidate.requiresWorktreeCleanup,
  )) {
    try {
      gitCleanups.push(await inspectRunDeliveryWorktree(delivery, attempt, record));
    } catch (error) {
      residuals.push(
        error instanceof Error
          ? error.message
          : `Inspect registered Git worktree at ${attempt.path} before deleting this run.`,
      );
    }
  }
  const branchInventory = await inspectRunDeliveryBranches(delivery, record, gitCleanups);
  const gitBranches = [...branchInventory.branches];
  const keptBranches = [...branchInventory.kept];
  const sharedCaches: string[] = [];
  for (const name of ["context-cache", "quality-validation"]) {
    const directory = join(dirname(root), name);
    if (!(await identityIfPresent(directory, "directory"))) continue;
    for (const child of await readdir(directory)) {
      countInventoryEntry(inventoryBudget);
      const path = join(directory, child);
      if (name === "context-cache" && (await isSharedContextCacheEntry(directory, child))) {
        sharedCaches.push(path);
      } else residuals.push(path);
    }
  }
  const uniqueResiduals = [...new Set(residuals)].sort();
  sharedCaches.sort();
  for (const artifactRoot of new Set(artifacts.map((candidate) => candidate.root))) {
    roots.push(await identity(artifactRoot, "directory"));
    roots.push(await identity(join(artifactRoot, "objects"), "directory"));
    roots.push(await identity(join(artifactRoot, "objects", "sha256"), "directory"));
  }
  const stable = {
    runId,
    stateDirectory: root,
    roots,
    entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
    artifacts,
    residuals: uniqueResiduals,
    sharedCaches,
    patchRoots,
    indexRows: index.indexRows,
    indexOverflow: index.indexOverflow,
    indexFile: index.indexFile,
    overflowFile: index.overflowFile,
    delivery,
    gitCleanups,
    gitBranches,
    keptBranches,
  };
  const confirmation = confirmationFor(stable);
  return {
    runId,
    stateDirectory: root,
    confirmation,
    files:
      entries.filter((entry) => entry.kind === "file").length +
      artifacts.filter((candidate) => !candidate.shared).length +
      deliveryEntries.filter((entry) => entry.kind === "file").length +
      Number(index.indexOverflow),
    directories:
      entries.filter((entry) => entry.kind === "directory").length +
      deliveryEntries.filter((entry) => entry.kind === "directory").length,
    sharedRetained:
      artifacts.filter((candidate) => candidate.shared).length +
      sharedCaches.length +
      delivery.sharedRetained,
    unresolved: uniqueResiduals.length,
    indexRows: index.indexRows,
    indexOverflow: index.indexOverflow,
    deliveryIndexRows,
    roots,
    entries,
    recordPath,
    artifacts,
    residuals: uniqueResiduals,
    sharedCaches,
    patchRoots,
    delivery,
    gitCleanups,
    gitBranches,
    keptBranches,
    ...(index.indexFile ? { indexFile: index.indexFile } : {}),
    ...(index.overflowFile ? { overflowFile: index.overflowFile } : {}),
  };
}

export async function previewRunDeletion(
  stateDirectory: string,
  runId: string,
  suppliedRoots: RunDeletionRoots = {},
): Promise<RunDeletionPreview> {
  const root = await realpath(resolve(stateDirectory));
  const journal = await loadJournal(root, runId);
  const {
    roots: _roots,
    entries: _entries,
    recordPath: _recordPath,
    artifacts: _artifacts,
    residuals: _residuals,
    sharedCaches: _sharedCaches,
    patchRoots: _patchRoots,
    indexFile: _indexFile,
    overflowFile: _overflowFile,
    delivery: _delivery,
    gitCleanups,
    gitBranches,
    keptBranches,
    ...preview
  } = journal?.approved ?? (await inventory(stateDirectory, runId, suppliedRoots));
  return {
    ...preview,
    worktrees: gitCleanups.length,
    branches: (gitBranches ?? []).map((branch) => branch.branch),
    keptBranches: keptBranches ?? [],
  };
}

export async function applyRunDeletion(
  stateDirectory: string,
  runId: string,
  confirmation: string,
  hooks: RunDeletionHooks = {},
  suppliedRoots: RunDeletionRoots = {},
): Promise<RunDeletionResult> {
  const root = await realpath(resolve(stateDirectory));
  return withRunMaintenanceGate(root, () =>
    withActiveRunGate(root, runId, () =>
      withArtifactReferenceGates(root, async () => {
        const journal = await loadJournal(root, runId);
        let extraRoots = journal?.approved.patchRoots;
        if (!extraRoots) {
          const source = (await new FileRunStore(root).get(runId)) as RunRecord;
          const custom = await patchRootFromRecord(source, runId);
          extraRoots = custom ? [custom] : [];
        }
        return withPatchRootGates(root, extraRoots, (patchRoots) =>
          applyRunDeletionUnderGate(root, runId, confirmation, hooks, patchRoots, suppliedRoots),
        );
      }),
    ),
  );
}

async function applyRunDeletionUnderGate(
  stateDirectory: string,
  runId: string,
  confirmation: string,
  hooks: RunDeletionHooks,
  patchRoots: readonly string[],
  suppliedRoots: RunDeletionRoots,
): Promise<RunDeletionResult> {
  const priorJournal = await loadJournal(stateDirectory, runId);
  const approved =
    priorJournal?.approved ?? (await inventory(stateDirectory, runId, suppliedRoots));
  if (approved.confirmation !== confirmation) {
    return failure("confirmation-changed", "Preview the run again and use its new token.");
  }
  if (approved.residuals.length > 0) {
    return {
      runId,
      complete: false,
      removed: 0,
      sharedRetained: approved.sharedRetained,
      unresolved: approved.residuals.length,
      nextAction: `Unattributed or ambiguous local entries remain (${approved.residuals.join(", ")}). Inspect ownership and repair or relocate them before previewing this run again.`,
    };
  }
  const tombstoned = await isRunTombstoned(approved.stateDirectory, runId);
  for (const expected of approved.roots) {
    const actual = await identity(expected.path, "directory");
    if (!sameIdentity(expected, actual)) {
      return failure(
        "root-changed",
        "Inspect the changed local store and preview or resume safely.",
      );
    }
  }
  if (!priorJournal || !tombstoned) {
    for (const expected of [
      ...approved.entries,
      ...(approved.indexFile ? [approved.indexFile] : []),
      ...(approved.overflowFile ? [approved.overflowFile] : []),
    ]) {
      const actual = await identity(expected.path, expected.kind);
      if (!sameIdentity(expected, actual)) {
        return failure("entry-changed", "Preview the run again before confirming deletion.");
      }
    }
    if (!priorJournal) {
      const deliveryRemaining = await countRemainingRunDeliveryTargets(approved.delivery);
      const approvedDeliveryCount =
        approved.delivery.receipts.reduce((count, receipt) => count + receipt.entries.length, 0) +
        approved.delivery.plans.filter((plan) => !plan.shared).length +
        approved.delivery.attempts.reduce((count, attempt) => count + attempt.entries.length, 0) +
        approved.delivery.metadata.length +
        approved.deliveryIndexRows;
      if (
        deliveryRemaining.maintenanceIncomplete ||
        deliveryRemaining.remaining !== approvedDeliveryCount
      ) {
        return failure(
          "delivery-changed",
          "Inspect the changed delivery store and preview this run again.",
        );
      }
    }
    if (!priorJournal) await writeJournal(approved);
  }
  const approvedTargetCount =
    approved.entries.length +
    approved.artifacts.filter((candidate) => !candidate.shared).length +
    approved.indexRows +
    Number(approved.indexOverflow) +
    approved.delivery.receipts.reduce((count, receipt) => count + receipt.entries.length, 0) +
    approved.delivery.plans.filter((plan) => !plan.shared).length +
    approved.delivery.attempts.reduce((count, attempt) => count + attempt.entries.length, 0) +
    approved.delivery.metadata.length +
    approved.deliveryIndexRows +
    (approved.gitBranches ?? []).length;
  let removed = priorJournal
    ? Math.max(0, approvedTargetCount - (await countUnresolvedApprovedTargets(approved)))
    : 0;
  let sharedRetained = approved.sharedRetained;
  try {
    if (!tombstoned) await writeRunTombstone(approved.stateDirectory, runId);
    for (const patchRoot of patchRoots) {
      if (!(await isRunTombstoned(patchRoot, runId))) await writeRunTombstone(patchRoot, runId);
    }
    for (const approvedWorktree of approved.gitCleanups) {
      const attempt = approved.delivery.attempts.find(
        (candidate) => candidate.path === approvedWorktree.attemptPath,
      );
      if (!attempt) return failure("journal-invalid", "Inspect the approved worktree inventory.");
      const absentBefore = (
        await Promise.all(attempt.entries.map((entry) => identityIfPresent(entry.path, entry.kind)))
      ).filter((entry) => !entry).length;
      const sourcePresent = await identityIfPresent(approved.recordPath, "file");
      const record = sourcePresent
        ? ((await new FileRunStore(approved.stateDirectory).get(runId)) as RunRecord)
        : undefined;
      await cleanupRunDeliveryWorktree(approved.delivery, attempt, record, approvedWorktree);
      const absentAfter = (
        await Promise.all(attempt.entries.map((entry) => identityIfPresent(entry.path, entry.kind)))
      ).filter((entry) => !entry).length;
      removed += absentAfter - absentBefore;
    }
    // Git refuses to delete a branch while a worktree has it checked out.
    for (const approvedBranch of approved.gitBranches ?? []) {
      if (await cleanupRunDeliveryBranch(approvedBranch)) removed += 1;
    }
    const deliveryResult = await applyRunDeliveryDeletion(approved.delivery, {
      afterRemove: hooks.afterRemove,
      clearedWorktrees: approved.gitCleanups,
    });
    removed += deliveryResult.removed;
    sharedRetained += deliveryResult.sharedRetained - approved.delivery.sharedRetained;
    const deliveryRemaining = await countRemainingRunDeliveryTargets(
      approved.delivery,
      approved.gitCleanups,
    );
    if (
      deliveryResult.unresolved.length > 0 ||
      deliveryRemaining.unresolved.length > 0 ||
      deliveryRemaining.remaining > 0
    ) {
      return {
        runId,
        complete: false,
        removed,
        sharedRetained,
        unresolved: Math.max(
          deliveryRemaining.remaining,
          deliveryResult.unresolved.length + deliveryRemaining.unresolved.length,
        ),
        nextAction:
          deliveryResult.nextAction ??
          "Inspect the remaining delivery targets and retry with the same confirmation.",
      };
    }
    const fileEntries = approved.entries.filter((entry) => entry.kind === "file");
    for (const entry of fileEntries.filter((item) => item.path !== approved.recordPath)) {
      const actual = await identityIfPresent(entry.path, "file");
      if (!actual && priorJournal) continue;
      if (!actual || !sameIdentity(entry, actual)) {
        return failure("entry-changed", "A sidecar changed during deletion; inspect and retry.");
      }
      await unlink(entry.path);
      removed += 1;
      await hooks.afterRemove?.(entry.path);
    }
    const directories = approved.entries
      .filter((entry) => entry.kind === "directory")
      .sort((a, b) => b.path.length - a.path.length);
    for (const entry of directories) {
      const actual = await identityIfPresent(entry.path, "directory");
      if (!actual && priorJournal) continue;
      if (!actual || !sameIdentity(entry, actual)) {
        return failure("entry-changed", "A directory changed during deletion; inspect and retry.");
      }
      await rmdir(entry.path);
      removed += 1;
    }
    removed += await purgeRunIndexRows(defaultRunIndexDirectory(approved.stateDirectory), runId);
    for (const expected of approved.roots) {
      if (!sameIdentity(expected, await identity(expected.path, "directory"))) {
        return failure("root-changed", "Inspect the changed local store and resume deletion.");
      }
    }
    const sourceStillPresent = await identityIfPresent(approved.recordPath, "file");
    const missingApprovedDigests = new Set<string>();
    if (priorJournal) {
      for (const candidate of approved.artifacts) {
        if (!(await identityIfPresent(candidate.object.path, "file"))) {
          missingApprovedDigests.add(candidate.digest);
        }
      }
    }
    const newlyShared = new Set<string>();
    if (sourceStillPresent) {
      const record = (await new FileRunStore(approved.stateDirectory).get(runId)) as RunRecord;
      for (const candidate of await scanArtifactCandidates(
        approved.stateDirectory,
        runId,
        record,
        undefined,
        missingApprovedDigests,
      )) {
        if (candidate.shared) newlyShared.add(candidate.object.path);
      }
    }
    sharedRetained += approved.artifacts.filter(
      (candidate) => !candidate.shared && newlyShared.has(candidate.object.path),
    ).length;
    for (const candidate of approved.artifacts) {
      if (candidate.shared || newlyShared.has(candidate.object.path)) continue;
      const current = await identityIfPresent(candidate.object.path, "file");
      if (!current && priorJournal) continue;
      if (!current || !sameIdentity(candidate.object, current)) {
        return failure("artifact-changed", "Inspect the artifact store and resume deletion.");
      }
      await markArtifactObjectForDeletion(candidate.root, candidate.digest);
      await unlink(candidate.object.path);
      removed += 1;
      await hooks.afterRemove?.(candidate.object.path);
    }
    const source = fileEntries.find((entry) => entry.path === approved.recordPath);
    if (!source) return failure("record-missing", "Inspect the run store before retrying.");
    const currentSource = await identityIfPresent(source.path, "file");
    if (currentSource && !sameIdentity(source, currentSource)) {
      return failure("entry-changed", "The run record changed; inspect and retry.");
    }
    if (currentSource) {
      await unlink(source.path);
      removed += 1;
      await hooks.afterRemove?.(source.path);
    }
    await unlink(journalFile(approved.stateDirectory, runId));
    return {
      runId,
      complete: true,
      removed,
      sharedRetained,
      unresolved: 0,
    };
  } catch (error) {
    const unresolved = await countUnresolvedApprovedTargets(approved).catch(() =>
      Math.max(1, approvedTargetCount - removed),
    );
    removed = Math.max(removed, approvedTargetCount - unresolved);
    return {
      runId,
      complete: false,
      removed,
      sharedRetained,
      unresolved,
      nextAction: `Deletion is incomplete (${error instanceof Error ? error.message : "unknown failure"}). Retry docsfab runs delete ${shellArgument(runId)} --confirm ${shellArgument(confirmation)} --state-dir ${shellArgument(approved.stateDirectory)}; the private journal binds the approved inventory.`,
    };
  }
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function countUnresolvedApprovedTargets(approved: RunDeletionInventory): Promise<number> {
  let unresolved = 0;
  unresolved += (await countRemainingRunDeliveryTargets(approved.delivery)).remaining;
  unresolved += await countRemainingRunDeliveryBranches(approved.gitBranches ?? []);
  for (const entry of approved.entries) {
    if (await identityIfPresent(entry.path, entry.kind)) unresolved += 1;
  }
  for (const candidate of approved.artifacts) {
    if (!candidate.shared && (await identityIfPresent(candidate.object.path, "file")))
      unresolved += 1;
  }
  const indexDirectory = defaultRunIndexDirectory(approved.stateDirectory);
  const indexPath = join(indexDirectory, "runs.jsonl");
  if (await identityIfPresent(indexPath, "file")) {
    const bytes = await readFile(indexPath);
    const bound = limit("runs.indexMaxBytes");
    if (bytes.byteLength > bound.value) refuseLimit(bound, bytes.byteLength);
    for (const line of bytes.toString("utf8").split("\n")) {
      if (!line) continue;
      if ((JSON.parse(line) as { runId?: unknown }).runId === approved.runId) unresolved += 1;
    }
  }
  const overflowPath = join(indexDirectory, "overflow.json");
  if (await identityIfPresent(overflowPath, "file")) {
    const overflow = JSON.parse(await readFile(overflowPath, "utf8")) as {
      lastRefusedRunId?: unknown;
    };
    if (overflow.lastRefusedRunId === approved.runId) unresolved += 1;
  }
  return unresolved;
}

async function identityIfPresent(
  path: string,
  kind: EntryIdentity["kind"],
): Promise<EntryIdentity | undefined> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return identity(path, kind);
}
