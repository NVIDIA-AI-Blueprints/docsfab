// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, readdir, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_MAXIMUM_JSON_BYTES = 16 * 1024 * 1024;
const SAFE_JSON_LEAF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u;

export type AcceptanceEvidenceErrorCode =
  | "invalid-directory"
  | "unsupported-platform"
  | "unsafe-directory"
  | "owner-mismatch"
  | "insecure-permissions"
  | "unsafe-entry"
  | "entry-too-large"
  | "invalid-json"
  | "serialization-failed"
  | "already-exists"
  | "read-failed"
  | "write-failed";

/** Errors intentionally omit filesystem paths and evidence content. */
export class AcceptanceEvidenceError extends Error {
  public constructor(public readonly code: AcceptanceEvidenceErrorCode) {
    super(`Acceptance evidence failed (${code}).`);
    this.name = "AcceptanceEvidenceError";
  }
}

/** Immutable canonical and ancestor identity for one owner-only acceptance directory. */
export interface AcceptanceEvidenceDirectory {
  readonly path: string;
  readonly canonicalPath: string;
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
  readonly ancestors: readonly AcceptanceEvidenceAncestor[];
}

interface AcceptanceEvidenceAncestor {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
}

export interface AcceptanceJsonLeaf {
  readonly file: string;
  readonly bytes: Buffer;
  readonly value: unknown;
}

export interface AcceptanceEvidenceReadOptions {
  maximumBytes?: number;
  /** Test seam immediately before a leaf is opened. */
  beforeOpen?: (file: string) => void | Promise<void>;
  /** Test seam after bytes are read but before identities are revalidated. */
  afterRead?: (file: string) => void | Promise<void>;
}

export interface AcceptanceEvidenceWriteOptions {
  /** Test seam immediately before the exclusive leaf open. */
  beforeOpen?: (file: string) => void | Promise<void>;
  /** Test seam after an empty private leaf is validated and before bytes are written. */
  beforeWrite?: (file: string) => void | Promise<void>;
  /** Test seam after bytes are synced but before pathname/parent revalidation. */
  afterWrite?: (file: string) => void | Promise<void>;
}

/** Exclusive publication whose original leaf descriptor remains pinned open. */
export interface AcceptanceJsonPublication {
  readonly path: string;
  assertStable(): Promise<void>;
  invalidate(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Pin an existing acceptance directory to its canonical path, ancestor chain,
 * and device/inode/owner/mode identity.
 * Creation and permission repair belong to the caller so this boundary never
 * silently accepts or changes an operator-selected location.
 */
export async function pinAcceptanceEvidenceDirectory(
  directory: string,
): Promise<AcceptanceEvidenceDirectory> {
  assertSupported();
  const path = validateDirectoryPath(directory);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const descriptor = await handle.stat();
    const uid = currentUid();
    assertPrivateDirectoryStat(descriptor, uid);
    await assertDirectoryAtPath(path, descriptor, uid);
    const canonicalPath = await realpath(path);
    const canonicalStat = await lstat(canonicalPath);
    assertPrivateDirectoryStat(canonicalStat, uid);
    if (canonicalStat.dev !== descriptor.dev || canonicalStat.ino !== descriptor.ino) {
      throw new AcceptanceEvidenceError("unsafe-directory");
    }
    return {
      path,
      canonicalPath,
      dev: descriptor.dev,
      ino: descriptor.ino,
      uid,
      mode: descriptor.mode,
      ancestors: await captureAncestorChain(canonicalPath),
    };
  } catch (error) {
    if (error instanceof AcceptanceEvidenceError) throw error;
    throw new AcceptanceEvidenceError("unsafe-directory");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Revalidate the canonical pathname, every ancestor, and the private leaf directory. */
export async function assertAcceptanceEvidenceDirectory(
  expected: AcceptanceEvidenceDirectory,
): Promise<void> {
  try {
    if ((await realpath(expected.path)) !== expected.canonicalPath) {
      throw new AcceptanceEvidenceError("unsafe-directory");
    }
    await assertAncestorChain(expected.ancestors);
    const stat = await lstat(expected.path);
    assertPrivateDirectoryStat(stat, expected.uid);
    if (!sameDirectory(stat, expected) || stat.mode !== expected.mode) {
      throw new AcceptanceEvidenceError("unsafe-directory");
    }
  } catch (error) {
    if (error instanceof AcceptanceEvidenceError) throw error;
    throw new AcceptanceEvidenceError("unsafe-directory");
  }
}

async function captureAncestorChain(path: string): Promise<AcceptanceEvidenceAncestor[]> {
  const paths: string[] = [];
  let current = dirname(path);
  while (true) {
    paths.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  paths.reverse();
  const identities: AcceptanceEvidenceAncestor[] = [];
  for (const ancestorPath of paths) {
    const stat = await lstat(ancestorPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new AcceptanceEvidenceError("unsafe-directory");
    }
    identities.push({
      path: ancestorPath,
      dev: stat.dev,
      ino: stat.ino,
      uid: stat.uid,
      mode: stat.mode,
    });
  }
  return identities;
}

async function assertAncestorChain(expected: readonly AcceptanceEvidenceAncestor[]): Promise<void> {
  if (!Array.isArray(expected) || expected.length === 0) {
    throw new AcceptanceEvidenceError("unsafe-directory");
  }
  for (const ancestor of expected) {
    const stat = await lstat(ancestor.path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== ancestor.dev ||
      stat.ino !== ancestor.ino ||
      stat.uid !== ancestor.uid ||
      stat.mode !== ancestor.mode
    ) {
      throw new AcceptanceEvidenceError("unsafe-directory");
    }
  }
}

/**
 * Enumerate a directory only when every entry is an owner-only regular JSON
 * leaf, then read each leaf without following links and revalidate all
 * descriptor, pathname, and parent identities.
 */
export async function readAcceptanceJsonLeaves(
  directory: AcceptanceEvidenceDirectory,
  options: AcceptanceEvidenceReadOptions = {},
): Promise<AcceptanceJsonLeaf[]> {
  const maximumBytes = validateMaximum(options.maximumBytes);
  try {
    await assertAcceptanceEvidenceDirectory(directory);
    const entries = await readdir(directory.path, { withFileTypes: true });
    await assertAcceptanceEvidenceDirectory(directory);
    const files = entries.map((entry) => entry.name).sort();
    assertSafeLeafNames(files);
    const leaves: AcceptanceJsonLeaf[] = [];
    for (const file of files) {
      leaves.push(
        await readAcceptanceJsonLeaf(directory, file, {
          maximumBytes,
          ...(options.beforeOpen ? { beforeOpen: options.beforeOpen } : {}),
          ...(options.afterRead ? { afterRead: options.afterRead } : {}),
        }),
      );
    }
    const filesAfter = (await readdir(directory.path)).sort();
    assertSafeLeafNames(filesAfter);
    if (
      filesAfter.length !== files.length ||
      filesAfter.some((file, index) => file !== files[index])
    ) {
      throw new AcceptanceEvidenceError("unsafe-entry");
    }
    await assertAcceptanceEvidenceDirectory(directory);
    return leaves;
  } catch (error) {
    if (error instanceof AcceptanceEvidenceError) throw error;
    throw new AcceptanceEvidenceError("read-failed");
  }
}

/** Read one immediate JSON leaf through a no-follow descriptor. */
export async function readAcceptanceJsonLeaf(
  directory: AcceptanceEvidenceDirectory,
  file: string,
  options: AcceptanceEvidenceReadOptions = {},
): Promise<AcceptanceJsonLeaf> {
  validateLeaf(file);
  const maximumBytes = validateMaximum(options.maximumBytes);
  const path = join(directory.path, file);
  let handle: FileHandle | undefined;
  try {
    await assertAcceptanceEvidenceDirectory(directory);
    const pathBefore = await safeLeafLstat(path);
    assertPrivateFileStat(pathBefore, directory.uid);
    await options.beforeOpen?.(file);
    await assertAcceptanceEvidenceDirectory(directory);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const descriptorBefore = await handle.stat();
    assertPrivateFileStat(descriptorBefore, directory.uid);
    assertSameFile(pathBefore, descriptorBefore);
    assertWithinMaximum(descriptorBefore.size, maximumBytes);
    const bytes = await readBounded(handle, maximumBytes);
    await options.afterRead?.(file);
    const descriptorAfter = await handle.stat();
    assertPrivateFileStat(descriptorAfter, directory.uid);
    assertStableFile(descriptorBefore, descriptorAfter);
    const pathAfter = await safeLeafLstat(path);
    assertPrivateFileStat(pathAfter, directory.uid);
    assertSameFile(descriptorAfter, pathAfter);
    await assertAcceptanceEvidenceDirectory(directory);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw new AcceptanceEvidenceError("invalid-json");
    }
    return { file, bytes, value };
  } catch (error) {
    if (error instanceof AcceptanceEvidenceError) throw error;
    throw new AcceptanceEvidenceError("read-failed");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Serialize and exclusively publish one owner-only JSON leaf. The destination
 * is opened and validated while empty; evidence bytes are written only after
 * the leaf and its pinned parent still match their original identities.
 */
export async function writeAcceptanceJsonExclusive(
  directory: AcceptanceEvidenceDirectory,
  file: string,
  value: unknown,
  options: AcceptanceEvidenceWriteOptions = {},
): Promise<void> {
  const publication = await openAcceptanceJsonExclusive(directory, file, value, options);
  try {
    await publication.close();
  } catch (error) {
    await publication.invalidate();
    throw error;
  }
}

/**
 * Exclusively write a JSON leaf and keep the exclusive-created descriptor open
 * through caller-owned terminal checks. Every failure after bytes begin is
 * invalidated by truncating and syncing that same descriptor.
 */
export async function openAcceptanceJsonExclusive(
  directory: AcceptanceEvidenceDirectory,
  file: string,
  value: unknown,
  options: AcceptanceEvidenceWriteOptions = {},
): Promise<AcceptanceJsonPublication> {
  validateLeaf(file);
  let bytes: Buffer;
  try {
    const serialized = JSON.stringify(value, null, 2);
    if (serialized === undefined) throw new Error("not serializable");
    bytes = Buffer.from(`${serialized}\n`, "utf8");
  } catch {
    throw new AcceptanceEvidenceError("serialization-failed");
  }
  const path = join(directory.path, file);
  let handle: FileHandle | undefined;
  let created: Stats | undefined;
  let transferred = false;
  try {
    await assertAcceptanceEvidenceDirectory(directory);
    await options.beforeOpen?.(file);
    await assertAcceptanceEvidenceDirectory(directory);
    try {
      handle = await open(
        path,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        throw new AcceptanceEvidenceError("already-exists");
      }
      throw error;
    }
    await handle.chmod(PRIVATE_FILE_MODE);
    created = await handle.stat();
    assertPrivateFileStat(created, directory.uid);
    if (created.size !== 0) throw new AcceptanceEvidenceError("unsafe-entry");
    const emptyPath = await safeLeafLstat(path);
    assertPrivateFileStat(emptyPath, directory.uid);
    assertSameFile(created, emptyPath);
    await assertAcceptanceEvidenceDirectory(directory);
    await options.beforeWrite?.(file);
    const stillEmpty = await handle.stat();
    assertPrivateFileStat(stillEmpty, directory.uid);
    assertStableFile(created, stillEmpty);
    const pathBeforeWrite = await safeLeafLstat(path);
    assertPrivateFileStat(pathBeforeWrite, directory.uid);
    assertSameFile(stillEmpty, pathBeforeWrite);
    await assertAcceptanceEvidenceDirectory(directory);

    await handle.writeFile(bytes);
    await handle.sync();
    await options.afterWrite?.(file);
    const written = await handle.stat();
    assertPrivateFileStat(written, directory.uid);
    if (
      written.dev !== created.dev ||
      written.ino !== created.ino ||
      written.size !== bytes.byteLength
    ) {
      throw new AcceptanceEvidenceError("unsafe-entry");
    }
    const pathAfter = await safeLeafLstat(path);
    assertPrivateFileStat(pathAfter, directory.uid);
    assertSameFile(written, pathAfter);
    await assertAcceptanceEvidenceDirectory(directory);
    await syncDirectory(directory);
    const publishedPath = await safeLeafLstat(path);
    assertPrivateFileStat(publishedPath, directory.uid);
    assertSameFile(written, publishedPath);
    await assertAcceptanceEvidenceDirectory(directory);
    const assertStable = async (): Promise<void> => {
      await assertAcceptanceEvidenceDirectory(directory);
      const descriptor = await handle!.stat();
      assertPrivateFileStat(descriptor, directory.uid);
      assertStableFile(written, descriptor);
      const atPath = await safeLeafLstat(path);
      assertPrivateFileStat(atPath, directory.uid);
      assertStableFile(written, atPath);
      await assertAcceptanceEvidenceDirectory(directory);
    };
    let closed = false;
    transferred = true;
    return {
      path,
      assertStable,
      async invalidate(): Promise<void> {
        if (closed) return;
        await invalidateCreatedDescriptor(handle!, directory, path, created!);
        await handle!.close().catch(() => undefined);
        closed = true;
      },
      async close(): Promise<void> {
        if (closed) return;
        await assertStable();
        await handle!.close();
        closed = true;
      },
    };
  } catch (error) {
    if (error instanceof AcceptanceEvidenceError) throw error;
    throw new AcceptanceEvidenceError("write-failed");
  } finally {
    if (!transferred && handle && created) {
      await invalidateCreatedDescriptor(handle, directory, path, created);
    }
    if (!transferred) await handle?.close().catch(() => undefined);
  }
}

/** Return an immediate validated leaf name for a requested result path. */
export function acceptanceJsonLeafForPath(
  directory: AcceptanceEvidenceDirectory,
  requestedPath: string,
): string {
  const path = resolve(requestedPath);
  const file = basename(path);
  validateLeaf(file);
  if (dirname(path) !== directory.path || join(directory.path, file) !== path) {
    throw new AcceptanceEvidenceError("unsafe-entry");
  }
  return file;
}

function validateDirectoryPath(directory: string): string {
  if (typeof directory !== "string" || !directory || directory.includes("\0")) {
    throw new AcceptanceEvidenceError("invalid-directory");
  }
  const path = resolve(directory);
  if (path === parse(path).root) {
    throw new AcceptanceEvidenceError("invalid-directory");
  }
  return path;
}

function validateLeaf(file: string): void {
  if (
    typeof file !== "string" ||
    file !== basename(file) ||
    !SAFE_JSON_LEAF.test(file) ||
    file.includes("\0")
  ) {
    throw new AcceptanceEvidenceError("unsafe-entry");
  }
}

function assertSafeLeafNames(files: readonly string[]): void {
  if (files.some((file) => !SAFE_JSON_LEAF.test(file))) {
    throw new AcceptanceEvidenceError("unsafe-entry");
  }
}

function validateMaximum(value: number | undefined): number {
  const maximum = value ?? DEFAULT_MAXIMUM_JSON_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new AcceptanceEvidenceError("entry-too-large");
  }
  return maximum;
}

function assertSupported(): void {
  if (
    process.platform === "win32" ||
    typeof process.getuid !== "function" ||
    typeof constants.O_NOFOLLOW !== "number" ||
    typeof constants.O_DIRECTORY !== "number"
  ) {
    throw new AcceptanceEvidenceError("unsupported-platform");
  }
}

function currentUid(): number {
  const getuid = process.getuid;
  if (typeof getuid !== "function") {
    throw new AcceptanceEvidenceError("unsupported-platform");
  }
  return getuid();
}

function assertPrivateDirectoryStat(stat: Stats, uid: number): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new AcceptanceEvidenceError("unsafe-directory");
  }
  if (stat.uid !== uid) throw new AcceptanceEvidenceError("owner-mismatch");
  if ((stat.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE) {
    throw new AcceptanceEvidenceError("insecure-permissions");
  }
}

function assertPrivateFileStat(stat: Stats, uid: number): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new AcceptanceEvidenceError("unsafe-entry");
  }
  if (stat.uid !== uid) throw new AcceptanceEvidenceError("owner-mismatch");
  if (stat.nlink !== 1) throw new AcceptanceEvidenceError("unsafe-entry");
  if ((stat.mode & 0o7777) !== PRIVATE_FILE_MODE) {
    throw new AcceptanceEvidenceError("insecure-permissions");
  }
}

function sameDirectory(stat: Stats, expected: AcceptanceEvidenceDirectory): boolean {
  return stat.dev === expected.dev && stat.ino === expected.ino && stat.uid === expected.uid;
}

async function assertDirectoryAtPath(path: string, descriptor: Stats, uid: number): Promise<void> {
  const pathStat = await lstat(path);
  assertPrivateDirectoryStat(pathStat, uid);
  if (
    pathStat.dev !== descriptor.dev ||
    pathStat.ino !== descriptor.ino ||
    pathStat.mode !== descriptor.mode
  ) {
    throw new AcceptanceEvidenceError("unsafe-directory");
  }
}

async function safeLeafLstat(path: string): Promise<Stats> {
  try {
    return await lstat(path);
  } catch {
    throw new AcceptanceEvidenceError("unsafe-entry");
  }
}

function assertSameFile(left: Stats, right: Stats): void {
  if (
    left.dev !== right.dev ||
    left.ino !== right.ino ||
    left.uid !== right.uid ||
    left.mode !== right.mode ||
    left.size !== right.size ||
    left.nlink !== right.nlink
  ) {
    throw new AcceptanceEvidenceError("unsafe-entry");
  }
}

function assertStableFile(before: Stats, after: Stats): void {
  assertSameFile(before, after);
  if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new AcceptanceEvidenceError("unsafe-entry");
  }
}

function assertWithinMaximum(size: number, maximum: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > maximum) {
    throw new AcceptanceEvidenceError("entry-too-large");
  }
}

async function readBounded(handle: FileHandle, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximum - total + 1));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maximum) {
      throw new AcceptanceEvidenceError("entry-too-large");
    }
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

async function syncDirectory(expected: AcceptanceEvidenceDirectory): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      expected.path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const stat = await handle.stat();
    assertPrivateDirectoryStat(stat, expected.uid);
    if (!sameDirectory(stat, expected) || stat.mode !== expected.mode) {
      throw new AcceptanceEvidenceError("unsafe-directory");
    }
    await handle.sync();
    await assertAcceptanceEvidenceDirectory(expected);
  } catch (error) {
    if (error instanceof AcceptanceEvidenceError) throw error;
    throw new AcceptanceEvidenceError("write-failed");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function removeCreatedLeaf(
  directory: AcceptanceEvidenceDirectory,
  path: string,
  created: Stats,
): Promise<void> {
  await assertAcceptanceEvidenceDirectory(directory)
    .then(async () => {
      const current = await safeLeafLstat(path);
      assertPrivateFileStat(current, directory.uid);
      if (current.dev !== created.dev || current.ino !== created.ino) return;
      await unlink(path);
    })
    .catch(() => undefined);
}

async function invalidateCreatedDescriptor(
  handle: FileHandle,
  directory: AcceptanceEvidenceDirectory,
  path: string,
  created: Stats,
): Promise<void> {
  // The descriptor, unlike the pathname, continues to identify the bytes even
  // if an attacker swaps an ancestor after the exclusive open.
  await handle.truncate(0).catch(() => undefined);
  await handle.sync().catch(() => undefined);
  await removeCreatedLeaf(directory, path, created);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
