// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Prepare exact local Git bytes and read host-mounted prepared snapshots safely. */
import { createHash } from "node:crypto";
import { currentTaskActivity } from "../activity/observer.js";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { sourceExtractionLimits } from "./source-extraction.js";
import type { PreparedLocalSourceRefV1 } from "../live-agent/task-contract.js";
import {
  preparedLocalSourceContentSha256,
  type PreparedLocalSourceFileMetadataV1,
  type PreparedLocalSourceManifestV1,
  type PreparedLocalSourceSnapshotV1,
} from "./prepared-source.js";
import { withRepositoryWorkspace } from "../repository/workspace/materialize.js";
import {
  listTrackedRepositoryEntries,
  readTrackedRepositoryFile,
} from "../repository/workspace/tracked-read.js";
import { TrackedSourceOversizeError, type TrackedSourceReaderV1 } from "./source-acquisition.js";

export type PreparedLocalSourceReadFailure =
  | "invalid-source-id"
  | "invalid-source-path"
  | "invalid-scope"
  | "source-unavailable"
  | "unsafe-entry"
  | "source-tampered"
  | "source-too-large"
  | "source-unreadable";

/** Content-free and stable so no repository byte reaches a diagnostic. */
export class PreparedLocalSourceReadError extends Error {
  public constructor(public readonly code: PreparedLocalSourceReadFailure) {
    super(`Prepared local source read refused: ${code}.`);
    this.name = "PreparedLocalSourceReadError";
  }
}

function fail(code: PreparedLocalSourceReadFailure): never {
  throw new PreparedLocalSourceReadError(code);
}

export function refusePreparedLocalSourceRead(code: PreparedLocalSourceReadFailure): never {
  return fail(code);
}

const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function safeRelativePath(value: string): string {
  if (
    value.length === 0 ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return fail("invalid-source-path");
  }
  return value;
}

function metadataFor(path: string, bytes: Uint8Array): PreparedLocalSourceFileMetadataV1 {
  return Object.freeze({
    path,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

/**
 * Export selected files from one local Git revision. Direct file roots and
 * multiple documentation directories share one immutable repository view.
 */
export async function prepareLocalSourceSnapshot(input: {
  readonly sourceId: string;
  readonly repositoryPath: string;
  readonly repositoryRevision?: string;
  /** Repository-relative files or directory roots; paths are read-only scope. */
  readonly documentationRoots: readonly string[];
}): Promise<PreparedLocalSourceSnapshotV1> {
  if (!SOURCE_ID.test(input.sourceId)) fail("invalid-source-id");
  if (input.documentationRoots.length === 0) fail("invalid-scope");
  const roots = input.documentationRoots.map(safeRelativePath);
  if (new Set(roots).size !== roots.length) fail("invalid-scope");
  const revision = input.repositoryRevision ?? "HEAD";
  const maxBytes = sourceExtractionLimits().maxOriginalBytes;

  return withRepositoryWorkspace(input.repositoryPath, revision, async (workspace) => {
    const entries = await listTrackedRepositoryEntries(workspace);
    const selected = new Set<string>();
    for (const root of roots) {
      const matches = entries.filter(
        (entry) => entry.path === root || entry.path?.startsWith(`${root}/`) === true,
      );
      if (matches.length === 0) fail("source-unavailable");
      if (matches.some((entry) => entry.kind !== "regular")) fail("unsafe-entry");
      for (const entry of matches) {
        const path = entry.path;
        if (path === undefined) continue;
        if (selected.has(path)) fail("invalid-scope");
        selected.add(path);
      }
    }

    const files = [] as PreparedLocalSourceSnapshotV1["files"][number][];
    for (const path of [...selected].sort()) {
      try {
        const bytes = new Uint8Array(await readTrackedRepositoryFile(workspace, path, maxBytes));
        const retained = Buffer.from(bytes);
        const metadata = metadataFor(path, retained);
        files.push(
          Object.freeze({
            ...metadata,
            get bytes(): Uint8Array {
              return new Uint8Array(retained);
            },
          }),
        );
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error as { code?: unknown }).code === "oversize"
        ) {
          fail("source-too-large");
        }
        throw error;
      }
    }

    const metadata = files.map(({ path, byteLength, sha256 }) => ({ path, byteLength, sha256 }));
    const ref: PreparedLocalSourceRefV1 = Object.freeze({
      schemaVersion: 1,
      kind: "docsfab-prepared-local-source",
      sourceId: input.sourceId,
      repositoryRevision: workspace.revision,
      contentSha256: preparedLocalSourceContentSha256({
        sourceId: input.sourceId,
        repositoryRevision: workspace.revision,
        files: metadata,
      }),
      paths: Object.freeze(metadata.map((file) => file.path)),
    });
    return Object.freeze({ ref, files: Object.freeze(files) });
  });
}

function sameRef(left: PreparedLocalSourceRefV1, right: PreparedLocalSourceRefV1): boolean {
  return (
    left.sourceId === right.sourceId &&
    left.repositoryRevision === right.repositoryRevision &&
    left.contentSha256 === right.contentSha256 &&
    left.paths.length === right.paths.length &&
    left.paths.every((path, index) => path === right.paths[index])
  );
}

async function assertRealDirectory(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (await realpath(path)) !== path) {
      fail("unsafe-entry");
    }
  } catch (error) {
    if (error instanceof PreparedLocalSourceReadError) throw error;
    fail("source-unreadable");
  }
}

interface DirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

function directoryAncestors(path: string): string[] {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const result = [root];
  let current = root;
  for (const segment of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    result.push(current);
  }
  return result;
}

async function pinDirectory(
  path: string,
  identities: Map<string, DirectoryIdentity>,
): Promise<void> {
  const stat = await lstat(path, { bigint: true }).catch(() => null);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || (await realpath(path)) !== path) {
    fail("unsafe-entry");
  }
  const existing = identities.get(path);
  if (existing && (existing.dev !== stat.dev || existing.ino !== stat.ino)) fail("source-tampered");
  identities.set(path, { dev: stat.dev, ino: stat.ino });
}

async function pinDirectoryChain(
  path: string,
  identities: Map<string, DirectoryIdentity>,
): Promise<void> {
  for (const ancestor of directoryAncestors(path)) await pinDirectory(ancestor, identities);
}

async function revalidateDirectories(
  identities: ReadonlyMap<string, DirectoryIdentity>,
): Promise<void> {
  for (const [path, identity] of identities) {
    const stat = await lstat(path, { bigint: true }).catch(() => null);
    if (
      !stat ||
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.dev !== identity.dev ||
      stat.ino !== identity.ino ||
      (await realpath(path)) !== path
    ) {
      fail("source-tampered");
    }
  }
}

async function readExpectedFileBytes(
  handle: FileHandle,
  expectedLength: number,
  maxBytes: number,
): Promise<{ readonly bytes: Uint8Array; readonly overflow: boolean }> {
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 0 || expectedLength > maxBytes) {
    fail("source-too-large");
  }
  const capacity = expectedLength + 1;
  const buffer = Buffer.allocUnsafe(capacity);
  let bytesRead = 0;
  while (bytesRead < capacity) {
    const result = await handle.read(buffer, bytesRead, capacity - bytesRead, null);
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }
  const overflow = bytesRead > expectedLength;
  return {
    bytes: new Uint8Array(buffer.subarray(0, Math.min(bytesRead, expectedLength))),
    overflow,
  };
}

async function readMountedFile(
  root: string,
  sourceId: string,
  path: string,
  expected: PreparedLocalSourceFileMetadataV1,
  directoryIdentities: ReadonlyMap<string, DirectoryIdentity>,
): Promise<Uint8Array> {
  const maxBytes = sourceExtractionLimits().maxOriginalBytes;
  if (!Number.isSafeInteger(expected.byteLength) || expected.byteLength < 0) {
    fail("source-tampered");
  }
  if (expected.byteLength > maxBytes) fail("source-too-large");
  const base = resolve(root, sourceId);
  let parent = base;
  for (const segment of path.split("/").slice(0, -1)) {
    parent = join(parent, segment);
    await assertRealDirectory(parent);
  }
  const target = join(base, ...path.split("/"));
  const rel = relative(base, target);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) fail("invalid-source-path");
  let handle;
  try {
    await revalidateDirectories(directoryIdentities);
    const before = await lstat(target, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) fail("unsafe-entry");
    handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const openedBefore = await handle.stat({ bigint: true });
    if (
      !openedBefore.isFile() ||
      before.dev !== openedBefore.dev ||
      before.ino !== openedBefore.ino ||
      openedBefore.size !== BigInt(expected.byteLength)
    ) {
      fail("source-tampered");
    }
    const { bytes, overflow } = await readExpectedFileBytes(handle, expected.byteLength, maxBytes);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(target, { bigint: true });
    await revalidateDirectories(directoryIdentities);
    if (
      after.dev !== openedBefore.dev ||
      after.ino !== openedBefore.ino ||
      after.size !== openedBefore.size ||
      pathAfter.isSymbolicLink() ||
      pathAfter.dev !== openedBefore.dev ||
      pathAfter.ino !== openedBefore.ino ||
      overflow ||
      bytes.byteLength !== expected.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !== expected.sha256
    ) {
      fail("source-tampered");
    }
    return bytes;
  } catch (error) {
    if (error instanceof PreparedLocalSourceReadError) throw error;
    return fail("source-unreadable");
  } finally {
    await handle?.close();
  }
}

/**
 * Bind selected manifest entries to a host-declared mount. The returned
 * reader holds byte copies, so parent and workflow observe the same evidence
 * even if the mounted files change after this function completes.
 */
export async function createPreparedLocalSourceReader(input: {
  readonly manifest: PreparedLocalSourceManifestV1;
  readonly refs: readonly PreparedLocalSourceRefV1[];
  /** Trusted host-supplied mount root; never read from a task ref. */
  readonly sourcesRoot: string;
}): Promise<TrackedSourceReaderV1 & { readonly refs: readonly PreparedLocalSourceRefV1[] }> {
  const requestedRoot = resolve(input.sourcesRoot);
  let root: string;
  try {
    const rootStat = await lstat(requestedRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail("unsafe-entry");
    root = await realpath(requestedRoot);
  } catch (error) {
    if (error instanceof PreparedLocalSourceReadError) throw error;
    return fail("source-unreadable");
  }
  await assertRealDirectory(root);
  const directoryIdentities = new Map<string, DirectoryIdentity>();
  await pinDirectoryChain(root, directoryIdentities);
  const entries = new Map(input.manifest.sources.map((entry) => [entry.ref.sourceId, entry]));
  const selected = new Map<string, Uint8Array>();
  const refs: PreparedLocalSourceRefV1[] = [];
  const ids = new Set<string>();
  for (const ref of input.refs) {
    if (!SOURCE_ID.test(ref.sourceId)) fail("invalid-source-id");
    if (ids.has(ref.sourceId)) fail("invalid-scope");
    ids.add(ref.sourceId);
    const entry = entries.get(ref.sourceId);
    if (entry === undefined || !sameRef(entry.ref, ref)) fail("source-tampered");
    if (
      preparedLocalSourceContentSha256({
        sourceId: ref.sourceId,
        repositoryRevision: ref.repositoryRevision,
        files: entry.files,
      }) !== ref.contentSha256
    ) {
      fail("source-tampered");
    }
    const activity = currentTaskActivity();
    const settleBind = activity?.observer.startResource({
      childScopeId: activity.childScopeId,
      resourceKind: "prepared-source",
      operation: "bind",
      resourceId: ref.sourceId,
      path: null,
      fromByte: null,
      maxBytes: null,
    });
    try {
      await pinDirectoryChain(join(root, ref.sourceId), directoryIdentities);
      for (const file of entry.files) {
        const path = safeRelativePath(file.path);
        if (!ref.paths.includes(path)) fail("invalid-scope");
        const virtualPath = `${ref.sourceId}/${path}`;
        if (selected.has(virtualPath)) fail("invalid-scope");
        const targetParent = dirname(join(root, ref.sourceId, ...path.split("/")));
        await pinDirectoryChain(targetParent, directoryIdentities);
        const settleLoad = activity?.observer.startResource({
          childScopeId: activity.childScopeId,
          resourceKind: "prepared-source",
          operation: "load",
          resourceId: ref.sourceId,
          path: virtualPath,
          fromByte: null,
          maxBytes: null,
        });
        try {
          const bytes = await readMountedFile(root, ref.sourceId, path, file, directoryIdentities);
          selected.set(virtualPath, bytes);
          settleLoad?.({ status: "ok", bytes });
        } catch (error) {
          settleLoad?.({ status: "failed", bytes: null });
          throw error;
        }
      }
      settleBind?.({ status: "ok", bytes: null });
      refs.push(ref);
    } catch (error) {
      settleBind?.({ status: "failed", bytes: null });
      throw error;
    }
  }
  if (refs.length === 0) fail("invalid-scope");
  const stable = new Map([...selected].map(([path, bytes]) => [path, Buffer.from(bytes)]));
  return Object.freeze({
    refs: Object.freeze(refs),
    async isTrackedRegularFile(repositoryPath: string): Promise<boolean> {
      return stable.has(repositoryPath);
    },
    async listTrackedRegularFiles(): Promise<readonly string[]> {
      return Object.freeze([...stable.keys()].sort());
    },
    async readTrackedBytes(repositoryPath: string, maxBytes: number): Promise<Uint8Array> {
      const activity = currentTaskActivity();
      const settleRead = activity?.observer.startResource({
        childScopeId: activity.childScopeId,
        resourceKind: "prepared-source",
        operation: "read",
        resourceId: repositoryPath.split("/")[0] ?? null,
        path: repositoryPath,
        fromByte: 0,
        maxBytes,
      });
      try {
        const bytes = stable.get(repositoryPath);
        if (bytes === undefined) fail("source-unavailable");
        if (bytes.byteLength > maxBytes) {
          throw new TrackedSourceOversizeError(repositoryPath, bytes.byteLength);
        }
        const result = new Uint8Array(bytes);
        settleRead?.({ status: "ok", bytes: result });
        return result;
      } catch (error) {
        settleRead?.({ status: "failed", bytes: null });
        throw error;
      }
    },
  });
}

/** Check that a mount remains below its host-declared root before it is used. */
export function isPreparedSourcePathWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
