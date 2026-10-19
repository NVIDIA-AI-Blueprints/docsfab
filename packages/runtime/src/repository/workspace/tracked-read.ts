// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  type RepositoryWorkspace,
  RepositoryWorkspaceReadError,
  type TrackedRepositoryEntry,
  type TrackedRepositoryEntryVerification,
  type TrackedRepositoryFile,
  type TrackedWorkspaceEntryKind,
} from "./contracts.js";
import { isExportExcluded } from "./export-exclusion.js";
import { limit, refuseLimit } from "../../config/limits.js";
import { compareText } from "../../shared/primitives.js";

interface TrackedWorkspaceEntry {
  path: string;
  kind: TrackedWorkspaceEntryKind;
  /** The revision's Git blob object ID; an admitted write's recapture drops it. */
  objectId?: string;
  /** SHA-256 of the exact raw Git blob bytes, retained only for regular files. */
  digest?: string;
  size?: bigint;
  device?: bigint;
  inode?: bigint;
  mode?: bigint;
  modifiedNs?: bigint;
  changedNs?: bigint;
}

interface RepositoryWorkspaceState {
  active: boolean;
  temporaryRoot: string;
  workspacePath: string;
  device: number;
  inode: number;
  leased: boolean;
  deferredRemoval?: () => void;
  deferredRemovalDone?: Promise<void>;
  trackedEntries: Map<string, TrackedWorkspaceEntry>;
}

const repositoryWorkspaceStates = new WeakMap<RepositoryWorkspace, RepositoryWorkspaceState>();
const activeRepositoryWorkspaces = new WeakSet<RepositoryWorkspace>();

export function registerRepositoryWorkspace(
  workspace: RepositoryWorkspace,
  state: Omit<RepositoryWorkspaceState, "active" | "leased">,
): void {
  repositoryWorkspaceStates.set(workspace, { ...state, active: true, leased: false });
  activeRepositoryWorkspaces.add(workspace);
}

export function deactivateRepositoryWorkspace(workspace: RepositoryWorkspace): string {
  const state = repositoryWorkspaceStates.get(workspace);
  if (state === undefined || !state.active) return "";
  if (state.leased) throw new Error("Repository workspace capability is leased.");
  state.active = false;
  activeRepositoryWorkspaces.delete(workspace);
  return state.temporaryRoot;
}

/** Close only a callback-owned workspace. A live lease keeps its files until release. */
export async function closeScopedRepositoryWorkspace(
  workspace: RepositoryWorkspace,
): Promise<boolean> {
  const state = repositoryWorkspaceStates.get(workspace);
  if (state === undefined) return true;
  if (!state.active) {
    if (state.deferredRemovalDone === undefined) return true;
    if (state.leased) return false;
    await state.deferredRemovalDone;
    return true;
  }
  state.active = false;
  activeRepositoryWorkspaces.delete(workspace);
  const root = state.temporaryRoot;
  if (state.leased) {
    let finish!: () => void;
    let fail!: (error: unknown) => void;
    const done = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    // The owner already receives a named unsettled-lease failure. Retain the
    // completion for a later explicit wait without an unhandled rejection.
    void done.catch(() => undefined);
    state.deferredRemovalDone = done;
    state.deferredRemoval = () => {
      void rm(root, { recursive: true, force: true }).then(finish, fail);
    };
    return false;
  }
  const done = rm(root, { recursive: true, force: true });
  state.deferredRemovalDone = done;
  await done;
  return true;
}

/** A direct H-workspace dispose shares scoped completion but retains leased refusal. */
export async function disposeScopedRepositoryWorkspace(
  workspace: RepositoryWorkspace,
): Promise<void> {
  const state = repositoryWorkspaceStates.get(workspace);
  if (state?.active && state.leased)
    throw new Error("The repository workspace capability is leased and cannot be disposed.");
  if (!(await closeScopedRepositoryWorkspace(workspace)))
    throw new Error("The repository workspace capability is leased and cannot be disposed.");
}

/** Observe eventual removal after a callback closed admission with a live lease. */
export async function waitForScopedRepositoryWorkspaceCleanup(
  workspace: RepositoryWorkspace,
): Promise<void> {
  const state = repositoryWorkspaceStates.get(workspace);
  if (state === undefined || state.active || state.deferredRemovalDone === undefined)
    throw new Error("The repository workspace has no pending scoped cleanup to await.");
  await state.deferredRemovalDone;
}

export function claimRepositoryWorkspaceLease(workspace: RepositoryWorkspace): void {
  const state = repositoryWorkspaceStates.get(workspace);
  if (state === undefined || !state.active || state.leased) {
    throw new Error("Repository workspace capability is already leased.");
  }
  state.leased = true;
}

export function releaseRepositoryWorkspaceLease(workspace: RepositoryWorkspace): void {
  const state = repositoryWorkspaceStates.get(workspace);
  if (state !== undefined) {
    state.leased = false;
    const remove = state.deferredRemoval;
    state.deferredRemoval = undefined;
    remove?.();
  }
}

/** Rejects values that were not prepared here or whose temporary workspace was disposed. */
export function assertActiveRepositoryWorkspace(
  workspace: unknown,
): asserts workspace is RepositoryWorkspace {
  const candidate = workspace as RepositoryWorkspace;
  const state = repositoryWorkspaceStates.get(candidate);
  if (state === undefined || !state.active || !activeRepositoryWorkspaces.has(candidate)) {
    throw new Error("Repository workspace capability is not active.");
  }
}

/** Also proves the capability still names the originally exported directory. */
export async function verifyActiveRepositoryWorkspace(
  workspace: unknown,
): Promise<RepositoryWorkspace> {
  assertActiveRepositoryWorkspace(workspace);
  const state = repositoryWorkspaceStates.get(workspace)!;
  try {
    const metadata = await lstat(workspace.path);
    const canonical = await realpath(workspace.path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      canonical !== state.workspacePath ||
      metadata.dev !== state.device ||
      metadata.ino !== state.inode
    ) {
      throw new Error("changed");
    }
  } catch {
    throw new Error("Repository workspace capability no longer matches its export.");
  }
  return workspace;
}

/** Lists only regular files admitted by the exact Git revision export. */
export async function listTrackedRepositoryFiles(
  workspace: unknown,
): Promise<readonly TrackedRepositoryFile[]> {
  const verified = await verifyActiveRepositoryWorkspace(workspace);
  const state = repositoryWorkspaceStates.get(verified)!;
  return [...state.trackedEntries.values()]
    .filter(
      (entry): entry is TrackedWorkspaceEntry & { size: bigint } =>
        entry.kind === "regular" && entry.size !== undefined,
    )
    .map((entry) => ({ path: entry.path, byteLength: Number(entry.size) }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

/** `sha256` is the stored blob digest, so snapshots never load large files. */
export interface TrackedRepositoryFileSnapshotMetadata {
  readonly path: string;
  readonly kind: TrackedWorkspaceEntryKind;
  readonly mode: number | null;
  readonly byteLength: number | null;
  readonly sha256: string | null;
}

export async function listTrackedRepositoryFileSnapshotMetadata(
  workspace: unknown,
): Promise<readonly TrackedRepositoryFileSnapshotMetadata[]> {
  const verified = await verifyActiveRepositoryWorkspace(workspace);
  const observations = await verifyTrackedRepositoryEntries(verified);
  if (observations.some((entry) => entry.status !== "verified")) {
    throw new Error("Tracked repository file snapshot changed during authenticated verification.");
  }
  const state = repositoryWorkspaceStates.get(verified)!;
  return [...state.trackedEntries.values()]
    .filter((entry) => entry.kind !== "excluded")
    .map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      mode: entry.mode === undefined ? null : Number(entry.mode & 0o777n),
      byteLength: entry.size === undefined ? null : Number(entry.size),
      sha256: entry.digest ?? null,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Lists the tree shape without exposing excluded credential paths. Read bytes
 * through readTrackedRepositoryFile, which is race-checked.
 */
export async function listTrackedRepositoryEntries(
  workspace: unknown,
): Promise<readonly TrackedRepositoryEntry[]> {
  const verified = await verifyActiveRepositoryWorkspace(workspace);
  const state = repositoryWorkspaceStates.get(verified)!;
  return [...state.trackedEntries.values()]
    .map(
      (entry): TrackedRepositoryEntry =>
        entry.kind === "excluded"
          ? { kind: "excluded" }
          : {
              path: entry.path,
              kind: entry.kind,
              ...(entry.size === undefined ? {} : { byteLength: Number(entry.size) }),
            },
    )
    .sort(
      (left, right) =>
        compareText(left.kind, right.kind) || compareText(left.path ?? "", right.path ?? ""),
    );
}

/**
 * Revalidates every entry without reading contents: regular files keep their
 * captured inode, device, size, type, timestamps, and real path, and
 * non-materialized entries stay absent. Covers content-skipped files.
 */
export async function verifyTrackedRepositoryEntries(
  workspace: unknown,
): Promise<readonly TrackedRepositoryEntryVerification[]> {
  const verified = await verifyActiveRepositoryWorkspace(workspace);
  const state = repositoryWorkspaceStates.get(verified)!;
  const observations: TrackedRepositoryEntryVerification[] = [];
  for (const entry of state.trackedEntries.values()) {
    const path = entry.kind === "excluded" ? undefined : entry.path;
    const body = { ...(path ? { path } : {}), kind: entry.kind };
    try {
      const absolute = join(state.workspacePath, ...entry.path.split("/"));
      if (entry.kind === "regular") {
        const before = await lstat(absolute, { bigint: true });
        assertTrackedSnapshot(entry, before);
        if ((await realpath(absolute)) !== absolute)
          throw new RepositoryWorkspaceReadError("changed");
        const after = await lstat(absolute, { bigint: true });
        assertTrackedSnapshot(entry, after);
      } else {
        try {
          await lstat(absolute, { bigint: true });
          throw new RepositoryWorkspaceReadError("changed");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
      }
      observations.push({ ...body, status: "verified" });
    } catch {
      observations.push({ ...body, status: "changed" });
    }
  }
  return observations.sort(
    (left, right) =>
      compareText(left.kind, right.kind) || compareText(left.path ?? "", right.path ?? ""),
  );
}

/** Returns the host-proven disposition for one exact tree path without reading it. */
export async function trackedRepositoryEntryKind(
  workspace: unknown,
  path: string,
): Promise<TrackedWorkspaceEntryKind | undefined> {
  const verified = await verifyActiveRepositoryWorkspace(workspace);
  return repositoryWorkspaceStates.get(verified)!.trackedEntries.get(path)?.kind;
}

/** A SHA-1 Git object ID in hex; a SHA-256 repository's IDs are longer. */
const SHA1_OBJECT_ID_HEX_LENGTH = 40;

/**
 * The Git blob object ID of one exact tracked regular file at the workspace's
 * revision, returned only when the file now at that path, a plain regular file
 * at its own real path, hashes to that ID. The bytes are streamed into the
 * hash, so no buffer or size cap applies. Returns `undefined` for any other
 * entry and for a file an admitted write has replaced. Throws
 * `RepositoryWorkspaceReadError("changed")` when the file is missing, is not a
 * plain file, changes while it is read, or holds other bytes, and `read-failed`
 * when the file system refuses the read.
 */
export async function trackedRepositoryBlobObjectId(
  workspace: unknown,
  path: string,
): Promise<string | undefined> {
  const verified = await verifyActiveRepositoryWorkspace(workspace);
  const state = repositoryWorkspaceStates.get(verified)!;
  const entry = state.trackedEntries.get(path);
  if (entry?.kind !== "regular" || entry.objectId === undefined) return undefined;
  const absolute = join(state.workspacePath, ...path.split("/"));
  let handle;
  try {
    // Cheap gates before any byte is read: a plain file at its own real path.
    assertLiveRegularFile(await lstat(absolute, { bigint: true }));
    if ((await realpath(absolute)) !== absolute) trackedReadFailure("changed");
    handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    assertLiveRegularFile(before);
    // Identity is the content: Git's blob hash in the object ID's own format.
    const hash = createHash(
      entry.objectId.length === SHA1_OBJECT_ID_HEX_LENGTH ? "sha1" : "sha256",
    );
    hash.update(`blob ${before.size}\0`);
    let streamed = 0n;
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
      hash.update(chunk as Buffer);
      streamed += BigInt((chunk as Buffer).byteLength);
    }
    const after = await handle.stat({ bigint: true });
    if (
      streamed !== before.size ||
      !identitiesMatch(before, after) ||
      hash.digest("hex") !== entry.objectId
    )
      trackedReadFailure("changed");
    return entry.objectId;
  } catch (error) {
    if (error instanceof RepositoryWorkspaceReadError) throw error;
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "EACCES" || error.code === "EPERM" || error.code === "EIO")
    )
      trackedReadFailure("read-failed");
    trackedReadFailure("changed");
  } finally {
    await handle?.close();
  }
}

/** The catalogued bound on one file an authorized in-run write may hold. */
export const TRACKED_WRITE_ADMISSION_MAX_BYTES_LIMIT = "repository.trackedWriteAdmissionMaxBytes";
export const TRACKED_WRITE_ADMISSION_MAX_PATH_CHARS_LIMIT =
  "repository.trackedWriteAdmissionMaxPathChars";

/**
 * Recaptures bytes for authenticated in-run writes so later reads see them.
 * Paths that cannot be recaptured, including a file over
 * `repository.trackedWriteAdmissionMaxBytes`, keep the export identity and
 * stay quarantined. A caller that must name the bound refuses by its code first.
 */
export async function admitAuthorizedTrackedWrites(
  workspace: unknown,
  paths: readonly string[],
): Promise<readonly string[]> {
  const verified = await verifyActiveRepositoryWorkspace(workspace);
  const state = repositoryWorkspaceStates.get(verified)!;
  const maxBytes = limit(TRACKED_WRITE_ADMISSION_MAX_BYTES_LIMIT).value;
  const maxPathChars = limit(TRACKED_WRITE_ADMISSION_MAX_PATH_CHARS_LIMIT);
  const eligible = [...new Set(paths)].sort(compareText).filter((path) => {
    const existing = state.trackedEntries.get(path);
    return (
      (existing === undefined || existing.kind === "regular") &&
      (existing !== undefined || !isExportExcluded(path))
    );
  });
  // Reject the whole invocation before any earlier eligible candidate changes
  // tracked state. `.length` is the catalog's UTF-16 code-unit observation.
  for (const path of eligible) {
    if (path.length > maxPathChars.value) refuseLimit(maxPathChars, path.length);
  }
  const admitted: string[] = [];
  for (const path of eligible) {
    try {
      state.trackedEntries.set(path, await recaptureTrackedRegularFile(state, path, maxBytes));
      admitted.push(path);
    } catch (error) {
      if (!(error instanceof RepositoryWorkspaceReadError)) throw error;
    }
  }
  return admitted;
}

/** Reads one exact tracked regular file through a bounded, race-checked descriptor. */
export async function readTrackedRepositoryFile(
  workspace: unknown,
  path: string,
  maxBytes: number,
): Promise<Buffer> {
  const verified = await verifyActiveRepositoryWorkspace(workspace);
  const state = repositoryWorkspaceStates.get(verified)!;
  const entry = state.trackedEntries.get(path);
  if (!entry) throw new RepositoryWorkspaceReadError("not-tracked");
  if (entry.kind !== "regular" || entry.size === undefined)
    throw new RepositoryWorkspaceReadError("unsafe-kind");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || entry.size > BigInt(maxBytes))
    throw new RepositoryWorkspaceReadError("oversize");
  const absolute = join(state.workspacePath, ...path.split("/"));
  let handle;
  try {
    const beforePath = await lstat(absolute, { bigint: true });
    assertTrackedSnapshot(entry, beforePath);
    if ((await realpath(absolute)) !== absolute) throw new RepositoryWorkspaceReadError("changed");
    handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    assertTrackedSnapshot(entry, before);
    const bytes = Buffer.alloc(Number(entry.size));
    const digest = createHash("sha256");
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (read.bytesRead === 0) throw new RepositoryWorkspaceReadError("changed");
      digest.update(bytes.subarray(offset, offset + read.bytesRead));
      offset += read.bytesRead;
    }
    const extra = Buffer.alloc(1);
    if (
      (await handle.read(extra, 0, 1, offset)).bytesRead !== 0 ||
      entry.digest === undefined ||
      digest.digest("hex") !== entry.digest
    )
      throw new RepositoryWorkspaceReadError("changed");
    const after = await handle.stat({ bigint: true });
    const afterPath = await lstat(absolute, { bigint: true });
    assertTrackedSnapshot(entry, after);
    assertTrackedSnapshot(entry, afterPath);
    if ((await realpath(absolute)) !== absolute) throw new RepositoryWorkspaceReadError("changed");
    return bytes;
  } catch (error) {
    throw trackedReadError(error);
  } finally {
    await handle?.close();
  }
}

/**
 * The first `maxBytes` bytes of a tracked regular file (all of it when it is
 * shorter), for classifying content, such as telling binary from text, without
 * reading a large file whole. The file must still match its tracked snapshot
 * before and after the read, but the bytes are not checked against the tracked
 * digest, so a caller must never use them as file content or evidence.
 */
export async function readTrackedRepositoryFilePrefix(
  workspace: unknown,
  path: string,
  maxBytes: number,
): Promise<Buffer> {
  const verified = await verifyActiveRepositoryWorkspace(workspace);
  const state = repositoryWorkspaceStates.get(verified)!;
  const entry = state.trackedEntries.get(path);
  if (!entry) throw new RepositoryWorkspaceReadError("not-tracked"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  if (entry.kind !== "regular" || entry.size === undefined)
    throw new RepositoryWorkspaceReadError("unsafe-kind"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new RepositoryWorkspaceReadError("oversize"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  const absolute = join(state.workspacePath, ...path.split("/"));
  let handle;
  try {
    assertTrackedSnapshot(entry, await lstat(absolute, { bigint: true }));
    if ((await realpath(absolute)) !== absolute) throw new RepositoryWorkspaceReadError("changed"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    assertTrackedSnapshot(entry, await handle.stat({ bigint: true }));
    const bytes = Buffer.alloc(Math.min(maxBytes, Number(entry.size)));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (read.bytesRead === 0) throw new RepositoryWorkspaceReadError("changed"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
      offset += read.bytesRead;
    }
    assertTrackedSnapshot(entry, await handle.stat({ bigint: true }));
    return bytes;
  } catch (error) {
    throw trackedReadError(error);
  } finally {
    await handle?.close();
  }
}

function trackedReadError(error: unknown): RepositoryWorkspaceReadError {
  if (error instanceof RepositoryWorkspaceReadError) return error;
  if (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EACCES" || error.code === "EPERM" || error.code === "EIO")
  )
    return new RepositoryWorkspaceReadError("read-failed");
  return new RepositoryWorkspaceReadError("changed");
}

async function recaptureTrackedRegularFile(
  state: RepositoryWorkspaceState,
  path: string,
  maxBytes: number,
): Promise<TrackedWorkspaceEntry> {
  if (!safeTrackedPath(path)) trackedReadFailure("unsafe-kind");
  const absolute = join(state.workspacePath, ...path.split("/"));
  let handle;
  try {
    const beforePath = await lstat(absolute, { bigint: true });
    assertLiveRegularFile(beforePath);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || beforePath.size > BigInt(maxBytes)) {
      trackedReadFailure("oversize");
    }
    if ((await realpath(absolute)) !== absolute) trackedReadFailure("changed");
    handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!identitiesMatch(beforePath, before)) trackedReadFailure("changed");
    const bytes = Buffer.alloc(Number(before.size));
    const digest = createHash("sha256");
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (read.bytesRead === 0) trackedReadFailure("changed");
      digest.update(bytes.subarray(offset, offset + read.bytesRead));
      offset += read.bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) {
      trackedReadFailure("changed");
    }
    const after = await handle.stat({ bigint: true });
    const afterPath = await lstat(absolute, { bigint: true });
    if (!identitiesMatch(before, after) || !identitiesMatch(beforePath, afterPath)) {
      trackedReadFailure("changed");
    }
    if ((await realpath(absolute)) !== absolute) trackedReadFailure("changed");
    return {
      path,
      kind: "regular",
      digest: digest.digest("hex"),
      size: before.size,
      device: before.dev,
      inode: before.ino,
      mode: before.mode & 0o777n,
      modifiedNs: before.mtimeNs,
      changedNs: before.ctimeNs,
    };
  } catch (error) {
    if (error instanceof RepositoryWorkspaceReadError) throw error;
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "EACCES" || error.code === "EPERM" || error.code === "EIO")
    )
      trackedReadFailure("read-failed");
    trackedReadFailure("changed");
  } finally {
    await handle?.close();
  }
  trackedReadFailure("changed");
}

function assertLiveRegularFile(metadata: BigIntStats): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    trackedReadFailure("changed");
  }
}

function trackedReadFailure(code: RepositoryWorkspaceReadError["code"]): never {
  throw new RepositoryWorkspaceReadError(code); // hygiene: ok
}

function identitiesMatch(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    !left.isSymbolicLink() &&
    !right.isSymbolicLink() &&
    left.nlink === 1n &&
    right.nlink === 1n &&
    left.size === right.size &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    (left.mode & 0o777n) === (right.mode & 0o777n) &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function safeTrackedPath(path: string): boolean {
  return (
    Boolean(path) &&
    !/[\uD800-\uDFFF]/u.test(path) &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !/[\0-\x1f\x7f]/u.test(path) &&
    path.split("/").every((part) => Boolean(part) && part !== "." && part !== "..")
  );
}

function assertTrackedSnapshot(entry: TrackedWorkspaceEntry, metadata: BigIntStats): void {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size !== entry.size ||
    metadata.dev !== entry.device ||
    metadata.ino !== entry.inode ||
    (metadata.mode & 0o777n) !== entry.mode ||
    metadata.mtimeNs !== entry.modifiedNs ||
    metadata.ctimeNs !== entry.changedNs
  )
    throw new RepositoryWorkspaceReadError("changed");
}
