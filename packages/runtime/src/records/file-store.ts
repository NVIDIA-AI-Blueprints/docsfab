// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, link, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

import { redactConfiguredCredentials } from "../security/configured-credentials.js";
import type { RunRecord, RunStore } from "./contracts.js";
import { reportRunIndexLoss, runIndexRebuildRemediation } from "./run-index-signals.js";
import {
  assertRunNotTombstoned,
  assertNoDeletedArtifactReferences,
  withArtifactReferenceGates,
  withRunMaintenanceGate,
} from "./run-maintenance-gate.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
/**
 * The only run ids this store loads. Surfaces that name a saved run to an
 * operator must gate on this, not a private copy.
 */
export const SAFE_RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * A record as this store saves it: its JSON with every one of DocsFab's own
 * configured credentials replaced by `[REDACTED]`, and the record those bytes
 * hold (#1807). Behind the load-time refusal, a saved record, and the run
 * index projected from it, never keep a configured credential. A value that
 * only looks like a credential is kept.
 */
export function savedRunRecordBytes(record: RunRecord): {
  readonly saved: RunRecord;
  readonly bytes: Buffer;
} {
  const text = `${JSON.stringify(record, null, 2)}\n`;
  const screened = redactConfiguredCredentials(text);
  return screened === text
    ? { saved: record, bytes: Buffer.from(text, "utf8") }
    : { saved: JSON.parse(screened) as RunRecord, bytes: Buffer.from(screened, "utf8") };
}

export type FileRunStoreErrorCode =
  | "invalid-root"
  | "unsupported-platform"
  | "unsafe-root"
  | "owner-mismatch"
  | "insecure-permissions"
  | "unsafe-record-id"
  | "serialization-failed"
  | "record-exists"
  | "unsafe-entry"
  | "record-not-found"
  | "invalid-record"
  | "write-failed"
  | "bounds-exceeded";

/** Errors intentionally omit raw records, repository data, and host paths. */
export class FileRunStoreError extends Error {
  public readonly code: FileRunStoreErrorCode;
  public constructor(code: FileRunStoreErrorCode) {
    super(`Run record store failed (${code}).`);
    this.code = code;
    this.name = "FileRunStoreError";
  }
}

export interface FileRunStoreOptions {
  /** Test seam after the private temporary file is complete and before rename. */
  beforeRename?: (temporaryPath: string) => void | Promise<void>;
  /** Test seam after an exact record leaf is pinned and before its bytes are read. */
  beforeRead?: (recordPath: string) => void | Promise<void>;
  /** Test seam reporting how many descriptor bytes this read requested. */
  observeReadLength?: (length: number) => void;
  /** Test seam for deterministic temporary names. */
  id?: () => string;
  /**
   * Called after each durable save with the exact bytes written, for derived
   * projections such as the run index. Anything it throws is reported as a
   * `run-store-after-save-failed` stderr warning, never rethrown.
   */
  afterSave?: (record: RunRecord, bytes: Buffer) => Promise<void>;
}

export interface FileRunStoreReadResult {
  record: unknown;
  /** SHA-256 of the exact validated file bytes read from the pinned descriptor. */
  sha256: string;
}

export interface FileRunStoreReadOptions {
  /** Catalog bound; a longer pinned file is refused. */
  maxBytes?: number;
  /** Inspect an existing private store without creating or tightening it. */
  readOnly?: true;
}

interface DirectoryAncestorIdentity {
  path: string;
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  symbolicLink: boolean;
}

interface DirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
  uid: number;
  ancestors: readonly DirectoryAncestorIdentity[];
}

/**
 * Enforce the same owner-only directory boundary used by ordinary CLI runs and
 * the packaged acceptance harness. Existing owned permissive roots are
 * tightened before use; unverifiable platforms fail before a record is written.
 */
export async function ensurePrivateRunDirectory(directory: string): Promise<void> {
  validateRoot(directory);
  await preparePrivateRunDirectory(directory);
}

export function assertOwnerOnlyRunStateSupported(
  platform: NodeJS.Platform = process.platform,
  getuid: (() => number) | null = process.getuid ?? null,
): void {
  if (
    platform === "win32" ||
    typeof getuid !== "function" ||
    typeof constants.O_NOFOLLOW !== "number" ||
    typeof constants.O_DIRECTORY !== "number"
  ) {
    throw new FileRunStoreError("unsupported-platform");
  }
}

export class FileRunStore implements RunStore {
  private readonly directory: string;
  private readonly options: FileRunStoreOptions;
  /** Records first-created by this store instance may be atomically advanced. */
  private readonly ownedRecords = new Map<string, { dev: number; ino: number }>();

  public constructor(directory: string, options: FileRunStoreOptions = {}) {
    this.directory = validateRoot(directory);
    this.options = options;
  }

  public async save(record: RunRecord): Promise<void> {
    if (!SAFE_RECORD_ID.test(record.id)) throw new FileRunStoreError("unsafe-record-id");
    await preparePrivateRunDirectory(this.directory);
    return withRunMaintenanceGate(await realpath(this.directory), () =>
      withArtifactReferenceGates(this.directory, () => this.saveUnderGate(record)),
    );
  }

  private async saveUnderGate(record: RunRecord): Promise<void> {
    if (!SAFE_RECORD_ID.test(record.id)) {
      throw new FileRunStoreError("unsafe-record-id");
    }
    await assertRunNotTombstoned(this.directory, record.id);
    await assertNoDeletedArtifactReferences(this.directory, record);
    let saved: RunRecord;
    let bytes: Buffer;
    try {
      ({ saved, bytes } = savedRunRecordBytes(record));
    } catch {
      throw new FileRunStoreError("serialization-failed");
    }

    const root = await preparePrivateRunDirectory(this.directory);
    const destination = join(root.path, `${record.id}.json`);
    const temporaryId = (this.options.id ?? randomUUID)();
    if (!SAFE_RECORD_ID.test(temporaryId)) {
      throw new FileRunStoreError("unsafe-entry");
    }
    const temporary = join(root.path, `.${record.id}.${temporaryId}.tmp`);
    let handle: FileHandle | undefined;
    let temporaryStat: Stats | undefined;
    let temporaryCreated = false;
    const ownedRecord = this.ownedRecords.get(record.id);
    try {
      await assertDestinationForSave(destination, root.uid, ownedRecord);
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
      temporaryCreated = true;
      await handle.chmod(PRIVATE_FILE_MODE);
      await handle.writeFile(bytes);
      await handle.sync();
      temporaryStat = await handle.stat();
      assertPrivateFileStat(temporaryStat, root.uid);
      await this.options.beforeRename?.(temporary);
      await assertSamePrivateDirectory(root);
      const temporaryPathStat = await safeLstat(temporary);
      assertPrivateFileStat(temporaryPathStat, root.uid);
      if (
        temporaryPathStat.dev !== temporaryStat.dev ||
        temporaryPathStat.ino !== temporaryStat.ino
      ) {
        throw new FileRunStoreError("unsafe-entry");
      }
      await assertDestinationForSave(destination, root.uid, ownedRecord);
      await handle.close();
      handle = undefined;
      if (ownedRecord) {
        await rename(temporary, destination);
        temporaryCreated = false;
      } else {
        try {
          // link(2) is an atomic no-clobber claim. A fresh store instance can
          // never replace evidence left by an earlier invocation.
          await link(temporary, destination);
        } catch (error) {
          if (isNodeError(error, "EEXIST")) {
            throw new FileRunStoreError("record-exists");
          }
          throw error;
        }
      }
      await syncDirectory(root);
      const destinationStat = await safeLstat(destination);
      assertPrivateFileStat(destinationStat, root.uid);
      if (destinationStat.dev !== temporaryStat.dev || destinationStat.ino !== temporaryStat.ino) {
        throw new FileRunStoreError("unsafe-entry");
      }
      if (!ownedRecord) {
        await unlink(temporary);
        temporaryCreated = false;
        await syncDirectory(root);
      }
      this.ownedRecords.set(record.id, {
        dev: destinationStat.dev,
        ino: destinationStat.ino,
      });
    } catch (error) {
      if (error instanceof FileRunStoreError) throw error;
      throw new FileRunStoreError("write-failed");
    } finally {
      await handle?.close().catch(() => undefined);
      const expectedTemporary = temporaryStat;
      if (temporaryCreated && expectedTemporary) {
        // Never follow a substituted root merely to clean up an interrupted
        // temporary or unlink a substituted leaf. Leaving the original private
        // file behind is safer than deleting through an untrusted pathname.
        await assertSamePrivateDirectory(root)
          .then(async () => {
            const current = await safeLstat(temporary);
            assertPrivateFileStat(current, root.uid);
            if (current.dev !== expectedTemporary.dev || current.ino !== expectedTemporary.ino) {
              throw new FileRunStoreError("unsafe-entry");
            }
            await unlink(temporary);
          })
          .catch(() => undefined);
      }
    }
    if (this.options.afterSave) {
      try {
        await this.options.afterSave(saved, bytes);
      } catch {
        reportRunIndexLoss(
          "run-store-after-save-failed",
          `Run ${record.id} was saved, but indexing it failed. ${runIndexRebuildRemediation(this.directory)}`,
        );
      }
    }
  }

  /**
   * Advance an existing exact record only while its saved bytes still match
   * the caller's read. The maintenance gate excludes concurrent DocsFab writers
   * and deletion; the replacement rechecks the saved leaf before rename.
   */
  public async replaceIfDigest(
    recordId: string,
    expectedSha256: string,
    record: RunRecord,
    maxBytes: number,
  ): Promise<void> {
    if (
      record.id !== recordId ||
      !/^[a-f0-9]{64}$/u.test(expectedSha256) ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1
    )
      throw new FileRunStoreError("record-exists"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    await preparePrivateRunDirectory(this.directory);
    return withRunMaintenanceGate(await realpath(this.directory), () =>
      withArtifactReferenceGates(this.directory, async () => {
        const current = await this.getWithDigest(recordId, { maxBytes });
        if (current.sha256 !== expectedSha256) throw new FileRunStoreError("record-exists"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
        let saved: RunRecord;
        let bytes: Buffer;
        try {
          ({ saved, bytes } = savedRunRecordBytes(record));
        } catch {
          throw new FileRunStoreError("serialization-failed"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
        }
        if (bytes.byteLength > maxBytes) throw new FileRunStoreError("bounds-exceeded"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
        await this.replaceExactBytesUnderGate(recordId, bytes, expectedSha256, maxBytes);
        if (this.options.afterSave) {
          try {
            await this.options.afterSave(saved, bytes);
          } catch {
            reportRunIndexLoss(
              "run-store-after-save-failed",
              `Run ${record.id} was saved, but indexing it failed. ${runIndexRebuildRemediation(this.directory)}`,
            );
          }
        }
      }),
    );
  }

  /**
   * Replace one exact record using the same temporary, identity, and directory
   * durability protocol as `save`. The caller supplies the bytes and the
   * compare-and-swap decision.
   */
  public async replaceExactBytes(recordId: string, bytes: Buffer): Promise<void> {
    if (!SAFE_RECORD_ID.test(recordId)) throw new FileRunStoreError("unsafe-record-id");
    await preparePrivateRunDirectory(this.directory);
    return withRunMaintenanceGate(await realpath(this.directory), () =>
      withArtifactReferenceGates(this.directory, () =>
        this.replaceExactBytesUnderGate(recordId, bytes),
      ),
    );
  }

  private async replaceExactBytesUnderGate(
    recordId: string,
    bytes: Buffer,
    expectedSha256?: string,
    maxBytes?: number,
  ): Promise<void> {
    if (!SAFE_RECORD_ID.test(recordId)) throw new FileRunStoreError("unsafe-record-id"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    await assertRunNotTombstoned(this.directory, recordId);
    try {
      await assertNoDeletedArtifactReferences(this.directory, JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      if (error instanceof SyntaxError) {
        // The exact-byte CAS contract validates the record at its caller.
      } else throw error;
    }
    const root = await preparePrivateRunDirectory(this.directory);
    const destination = join(root.path, `${recordId}.json`);
    const temporaryId = (this.options.id ?? randomUUID)();
    if (!SAFE_RECORD_ID.test(temporaryId)) throw new FileRunStoreError("unsafe-entry"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    const temporary = join(root.path, `.${recordId}.${temporaryId}.tmp`);
    let handle: FileHandle | undefined;
    let temporaryStat: Stats | undefined;
    let temporaryCreated = false;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
      temporaryCreated = true;
      await handle.chmod(PRIVATE_FILE_MODE);
      await handle.writeFile(bytes);
      await handle.sync();
      temporaryStat = await handle.stat();
      assertPrivateFileStat(temporaryStat, root.uid);
      await this.options.beforeRename?.(temporary);
      await assertSamePrivateDirectory(root);
      const temporaryPathStat = await safeLstat(temporary);
      assertPrivateFileStat(temporaryPathStat, root.uid);
      if (
        temporaryPathStat.dev !== temporaryStat.dev ||
        temporaryPathStat.ino !== temporaryStat.ino
      ) {
        throw new FileRunStoreError("unsafe-entry"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
      }
      if (expectedSha256 !== undefined) {
        const current = await this.getWithDigest(recordId, { maxBytes });
        if (current.sha256 !== expectedSha256) throw new FileRunStoreError("record-exists"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
      }
      await handle.close();
      handle = undefined;
      await rename(temporary, destination);
      temporaryCreated = false;
      await syncDirectory(root);
      const destinationStat = await safeLstat(destination);
      assertPrivateFileStat(destinationStat, root.uid);
      if (destinationStat.dev !== temporaryStat.dev || destinationStat.ino !== temporaryStat.ino) {
        throw new FileRunStoreError("unsafe-entry"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
      }
      this.ownedRecords.set(recordId, { dev: destinationStat.dev, ino: destinationStat.ino });
    } catch (error) {
      if (error instanceof FileRunStoreError) throw error;
      throw new FileRunStoreError("write-failed"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    } finally {
      await handle?.close().catch(() => undefined);
      if (temporaryCreated) await unlink(temporary).catch(() => undefined);
    }
  }

  /** Safely load one exact run id. Directory enumeration never selects a run. */
  public async get(recordId: string): Promise<unknown> {
    return (await this.getWithDigest(recordId)).record;
  }

  /** Safely load one exact run id and bind it to its persisted byte identity. */
  public async getWithDigest(
    recordId: string,
    options: FileRunStoreReadOptions = {},
  ): Promise<FileRunStoreReadResult> {
    if (!SAFE_RECORD_ID.test(recordId)) throw new FileRunStoreError("unsafe-record-id"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    const root = await preparePrivateRunDirectory(this.directory, options.readOnly === true);
    const path = join(root.path, `${recordId}.json`);
    let handle: FileHandle | undefined;
    try {
      const entry = await lstat(path).catch((error: unknown) => {
        if (isNodeError(error, "ENOENT")) throw new FileRunStoreError("record-not-found"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
        throw error;
      });
      assertPrivateFileStat(entry, root.uid);
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      assertPrivateFileStat(opened, root.uid);
      if (opened.dev !== entry.dev || opened.ino !== entry.ino) {
        throw new FileRunStoreError("unsafe-entry"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
      }
      await assertSamePrivateDirectory(root);
      const pinnedRead = await handle.stat();
      assertPrivateFileStat(pinnedRead, root.uid);
      if (pinnedRead.dev !== opened.dev || pinnedRead.ino !== opened.ino) {
        throw new FileRunStoreError("unsafe-entry"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
      }
      if (options.maxBytes !== undefined && pinnedRead.size > options.maxBytes) {
        throw new FileRunStoreError("bounds-exceeded"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
      }
      await this.options.beforeRead?.(path);
      const bytes = await readPinnedDescriptor(handle, options, this.options.observeReadLength);
      const after = await handle.stat();
      assertPrivateFileStat(after, root.uid);
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
        throw new FileRunStoreError("unsafe-entry"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
      }
      await assertSamePrivateDirectory(root);
      const leaf = await safeLstat(path);
      assertPrivateFileStat(leaf, root.uid);
      if (leaf.dev !== opened.dev || leaf.ino !== opened.ino || leaf.size !== opened.size) {
        throw new FileRunStoreError("unsafe-entry"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      try {
        return {
          record: JSON.parse(bytes.toString("utf8")) as unknown,
          sha256,
        };
      } catch {
        throw new FileRunStoreError("invalid-record"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
      }
    } catch (error) {
      if (error instanceof FileRunStoreError) throw error;
      throw new FileRunStoreError("unsafe-entry"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

async function readPinnedDescriptor(
  handle: FileHandle,
  options: FileRunStoreReadOptions,
  observeReadLength?: (length: number) => void,
): Promise<Buffer> {
  if (options.maxBytes === undefined) {
    const bytes = await handle.readFile();
    observeReadLength?.(bytes.length);
    return bytes;
  }
  const cap = options.maxBytes + 1;
  observeReadLength?.(cap);
  const buffer = Buffer.allocUnsafe(cap);
  const { bytesRead } = await handle.read(buffer, 0, cap, 0);
  if (bytesRead > options.maxBytes) {
    throw new FileRunStoreError("bounds-exceeded"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  }
  return Buffer.from(buffer.subarray(0, bytesRead));
}

async function preparePrivateRunDirectory(
  directory: string,
  readOnly = false,
): Promise<DirectoryIdentity> {
  assertOwnerOnlyRunStateSupported();
  const path = validateRoot(directory);
  const ancestorsBefore = await captureDirectoryAncestors(dirname(path));
  let handle: FileHandle | undefined;
  try {
    const existing = await lstat(path).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    });
    if (existing?.isSymbolicLink()) throw new FileRunStoreError("unsafe-root");
    if (existing && !existing.isDirectory()) throw new FileRunStoreError("unsafe-root");
    if (!readOnly) await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await assertDirectoryAncestors(ancestorsBefore);
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let stat = await handle.stat();
    const uid = currentUid();
    await assertDirectoryIdentityAtPath(path, stat, uid);
    if ((stat.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE) {
      if (readOnly) assertPrivateDirectoryStat(stat, uid);
      await handle.chmod(PRIVATE_DIRECTORY_MODE);
      stat = await handle.stat();
      await assertDirectoryIdentityAtPath(path, stat, uid);
    }
    assertPrivateDirectoryStat(stat, uid);
    const ancestors = await captureDirectoryAncestors(dirname(path));
    await assertDirectoryIdentityAtPath(path, stat, uid);
    return { path, dev: stat.dev, ino: stat.ino, uid, ancestors };
  } catch (error) {
    if (error instanceof FileRunStoreError) throw error;
    throw new FileRunStoreError("unsafe-root");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertSamePrivateDirectory(expected: DirectoryIdentity): Promise<void> {
  await assertDirectoryAncestors(expected.ancestors);
  const stat = await safeLstat(expected.path);
  assertPrivateDirectoryStat(stat, expected.uid);
  if (stat.dev !== expected.dev || stat.ino !== expected.ino) {
    throw new FileRunStoreError("unsafe-root");
  }
}

async function captureDirectoryAncestors(path: string): Promise<DirectoryAncestorIdentity[]> {
  const paths: string[] = [];
  let cursor = resolve(path);
  while (true) {
    paths.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const ancestors: DirectoryAncestorIdentity[] = [];
  for (const ancestor of paths.reverse()) {
    const stat = await lstat(ancestor).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    });
    if (!stat) continue;
    const symbolicLink = stat.isSymbolicLink();
    if (symbolicLink && !(await isOperatingSystemDirectoryAlias(ancestor))) {
      throw new FileRunStoreError("unsafe-root"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    }
    if (!symbolicLink && !stat.isDirectory()) throw new FileRunStoreError("unsafe-root"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    ancestors.push({
      path: ancestor,
      dev: stat.dev,
      ino: stat.ino,
      uid: stat.uid,
      mode: stat.mode,
      symbolicLink,
    });
  }
  return ancestors;
}

async function assertDirectoryAncestors(
  expected: readonly DirectoryAncestorIdentity[],
): Promise<void> {
  for (const ancestor of expected) {
    const stat = await lstat(ancestor.path).catch(() => {
      throw new FileRunStoreError("unsafe-root"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    });
    if (
      stat.isSymbolicLink() !== ancestor.symbolicLink ||
      (!stat.isSymbolicLink() && !stat.isDirectory()) ||
      stat.dev !== ancestor.dev ||
      stat.ino !== ancestor.ino ||
      stat.uid !== ancestor.uid ||
      stat.mode !== ancestor.mode ||
      (stat.isSymbolicLink() && !(await isOperatingSystemDirectoryAlias(ancestor.path)))
    ) {
      throw new FileRunStoreError("unsafe-root"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    }
  }
}

async function isOperatingSystemDirectoryAlias(path: string): Promise<boolean> {
  if (process.platform !== "darwin" || (path !== "/var" && path !== "/tmp")) return false;
  const canonical = await realpath(path).catch(() => "");
  return canonical === `/private${path}`;
}

async function assertDestinationForSave(
  path: string,
  uid: number,
  owned: { dev: number; ino: number } | undefined,
): Promise<void> {
  const stat = await lstat(path).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!stat) {
    if (owned) throw new FileRunStoreError("unsafe-entry");
    return;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== uid) {
    throw new FileRunStoreError("unsafe-entry");
  }
  if (!owned) throw new FileRunStoreError("record-exists");
  assertPrivateFileStat(stat, uid);
  if (stat.dev !== owned.dev || stat.ino !== owned.ino) {
    throw new FileRunStoreError("unsafe-entry");
  }
}

function assertPrivateDirectoryStat(stat: Stats, uid: number): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new FileRunStoreError("unsafe-root");
  }
  if (stat.uid !== uid) throw new FileRunStoreError("owner-mismatch");
  if ((stat.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE) {
    throw new FileRunStoreError("insecure-permissions");
  }
}

function assertPrivateFileStat(stat: Stats, uid: number): void {
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.uid !== uid ||
    (stat.mode & 0o7777) !== PRIVATE_FILE_MODE
  ) {
    throw new FileRunStoreError("unsafe-entry");
  }
}

async function safeLstat(path: string): Promise<Stats> {
  try {
    return await lstat(path);
  } catch {
    throw new FileRunStoreError("unsafe-entry");
  }
}

async function syncDirectory(expected: DirectoryIdentity): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      expected.path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const stat = await handle.stat();
    assertPrivateDirectoryStat(stat, expected.uid);
    if (stat.dev !== expected.dev || stat.ino !== expected.ino) {
      throw new FileRunStoreError("unsafe-root");
    }
    await handle.sync();
  } catch (error) {
    if (error instanceof FileRunStoreError) throw error;
    throw new FileRunStoreError("write-failed");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function validateRoot(directory: string): string {
  if (typeof directory !== "string" || !directory || directory.includes("\0")) {
    throw new FileRunStoreError("invalid-root");
  }
  const path = resolve(directory);
  if (path === parse(path).root) throw new FileRunStoreError("invalid-root");
  return path;
}

async function assertDirectoryIdentityAtPath(
  path: string,
  descriptor: Stats,
  uid: number,
): Promise<void> {
  if (!descriptor.isDirectory() || descriptor.uid !== uid) {
    throw new FileRunStoreError(descriptor.uid !== uid ? "owner-mismatch" : "unsafe-root");
  }
  const pathStat = await safeLstat(path);
  if (
    pathStat.isSymbolicLink() ||
    !pathStat.isDirectory() ||
    pathStat.uid !== uid ||
    pathStat.dev !== descriptor.dev ||
    pathStat.ino !== descriptor.ino
  ) {
    throw new FileRunStoreError("unsafe-root");
  }
}

function currentUid(): number {
  const getuid = process.getuid;
  if (typeof getuid !== "function") {
    throw new FileRunStoreError("unsupported-platform");
  }
  return getuid();
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
