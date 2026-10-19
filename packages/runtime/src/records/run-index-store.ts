// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Append-only storage for run index rows at
 * `<dirname(stateDirectory)>/run-index/runs.jsonl`, beside the state directory
 * because its readers refuse anything but run records.
 *
 * A snapshot counts only when all its rows are present, and the newest
 * complete snapshot per run wins, so repeated saves never double count.
 * Several processes may append, so an append never removes bytes. An append
 * that would cross `runs.indexMaxBytes` is refused whole; run-store refusals
 * go to `overflow.json`, which every query reports.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { DOCSFAB_BUILD_IDENTITY } from "../build-identity.js";
import { limit, type ResolvedLimit } from "../config/limits.js";
import type { RunRecord } from "./contracts.js";
import {
  defaultRunIndexDirectory,
  reportRunIndexLoss,
  runIndexRebuildRemediation,
} from "./run-index-signals.js";
import { ensurePrivateRunDirectory, FileRunStore, type FileRunStoreOptions } from "./file-store.js";
import { withRunMaintenanceGate } from "./run-maintenance-gate.js";
import {
  decodeRunIndexRow,
  docsfabBuildRevision,
  isRunIndexTerminalStatus,
  projectRunIndexRows,
  RUN_INDEX_LIMITS,
  sha256Hex,
  type RunIndexRowV1,
} from "./run-index.js";

export { defaultRunIndexDirectory, RUN_INDEX_DIRECTORY_NAME } from "./run-index-signals.js";
export const RUN_INDEX_FILE_NAME = "runs.jsonl";
export const RUN_INDEX_OVERFLOW_FILE_NAME = "overflow.json";
const RUN_INDEX_DELETED_DIRECTORY = ".docsfab-run-index-deleted";

const PRIVATE_FILE_MODE = 0o600;

async function indexDeletedPath(indexDirectory: string, runId: string): Promise<string> {
  const canonicalDirectory = await realpath(indexDirectory);
  const digest = createHash("sha256")
    .update("docsfab-run-index-deleted-v1\0")
    .update(canonicalDirectory)
    .update("\0")
    .update(runId)
    .digest("hex");
  return join(canonicalDirectory, RUN_INDEX_DELETED_DIRECTORY, digest);
}

async function isIndexRunDeleted(indexDirectory: string, runId: string): Promise<boolean> {
  const path = await indexDeletedPath(indexDirectory, runId);
  const parent = await lstat(
    join(await realpath(indexDirectory), RUN_INDEX_DELETED_DIRECTORY),
  ).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!parent) return false;
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid?.() ||
    (parent.mode & 0o077) !== 0
  ) {
    throw new RunIndexStoreError("runs-index-unsafe-file"); // hygiene: ok -- typed store code; its constructor supplies the operator-safe message.
  }
  const entry = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!entry) return false;
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1 ||
    entry.uid !== process.getuid?.() ||
    (entry.mode & 0o077) !== 0
  ) {
    throw new RunIndexStoreError("runs-index-unsafe-file"); // hygiene: ok -- typed store code; its constructor supplies the operator-safe message.
  }
  return true;
}

async function markIndexRunDeleted(indexDirectory: string, runId: string): Promise<void> {
  const root = join(await realpath(indexDirectory), RUN_INDEX_DELETED_DIRECTORY);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await lstat(root);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0
  ) {
    throw new RunIndexStoreError("runs-index-unsafe-file"); // hygiene: ok -- typed store code; its constructor supplies the operator-safe message.
  }
  const path = await indexDeletedPath(indexDirectory, runId);
  if (!(await isIndexRunDeleted(indexDirectory, runId))) {
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    try {
      await handle.writeFile("deleted-run-index-id\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const parent = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const pinned = await parent.stat();
    if (pinned.dev !== directory.dev || pinned.ino !== directory.ino) {
      throw new RunIndexStoreError("runs-index-unsafe-file"); // hygiene: ok -- typed store code; its constructor supplies the operator-safe message.
    }
    await parent.sync();
  } finally {
    await parent.close();
  }
}

export type RunIndexStoreErrorCode =
  | "runs-index-unsafe-file"
  | "runs-index-io-failed"
  | "runs-index-run-deleted";

/** Storage failure; the message never carries row contents or record data. */
export class RunIndexStoreError extends Error {
  public readonly code: RunIndexStoreErrorCode;
  public constructor(code: RunIndexStoreErrorCode) {
    super(`The run index could not be read or written safely (${code}).`);
    this.code = code;
    this.name = "RunIndexStoreError";
  }
}

export type RunIndexAppendResult =
  | {
      readonly status: "appended";
      readonly rows: number;
      readonly bytes: number;
    }
  | {
      readonly status: "refused";
      readonly limit: ResolvedLimit;
      readonly observedBytes: number;
    };

/**
 * Append one snapshot's rows, or refuse the whole snapshot without writing
 * when the file would cross `runs.indexMaxBytes`.
 *
 * Never truncate or rewrite: another process may have committed rows since
 * this one read the size. A cut-off earlier append is contained by starting on
 * a fresh line, and `snapshotRows` lets a query drop an incomplete snapshot.
 */
export async function appendRunIndexSnapshot(
  input: {
    readonly indexDirectory: string;
    readonly rows: readonly RunIndexRowV1[];
    readonly maxBytes: ResolvedLimit;
  },
  options: RunIndexAppendOptions = {},
): Promise<RunIndexAppendResult> {
  await ensurePrivateRunDirectory(input.indexDirectory);
  return withRunMaintenanceGate(input.indexDirectory, () =>
    appendRunIndexSnapshotUnderGate(input, options),
  );
}

async function appendRunIndexSnapshotUnderGate(
  input: {
    readonly indexDirectory: string;
    readonly rows: readonly RunIndexRowV1[];
    readonly maxBytes: ResolvedLimit;
  },
  options: RunIndexAppendOptions,
): Promise<RunIndexAppendResult> {
  if (input.rows.length === 0) return { status: "appended", rows: 0, bytes: 0 };
  for (const runId of new Set(input.rows.map((row) => row.runId))) {
    if (await isIndexRunDeleted(input.indexDirectory, runId)) {
      throw new RunIndexStoreError("runs-index-run-deleted"); // hygiene: ok -- typed store code; its constructor supplies the operator-safe message.
    }
  }
  const rows = Buffer.from(input.rows.map((row) => `${JSON.stringify(row)}\n`).join(""), "utf8");
  await ensurePrivateRunDirectory(input.indexDirectory);
  const path = join(input.indexDirectory, RUN_INDEX_FILE_NAME);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    const stat = await handle.stat();
    assertPrivateIndexFile(stat);
    const bytes = (await endsWithNewline(handle, stat.size))
      ? rows
      : Buffer.concat([Buffer.from("\n"), rows]);
    const observedBytes = stat.size + bytes.length;
    if (observedBytes > input.maxBytes.value) {
      return { status: "refused", limit: input.maxBytes, observedBytes };
    }
    await (options.writeAll ?? writeRunIndexBytes)(handle, bytes);
    await handle.sync();
    return { status: "appended", rows: input.rows.length, bytes: bytes.length };
  } catch (error) {
    if (error instanceof RunIndexStoreError) throw error;
    throw new RunIndexStoreError("runs-index-io-failed"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export interface RunIndexAppendOptions {
  /** Test seam replacing the write loop, for example to fail mid-append. */
  readonly writeAll?: (handle: FileHandle, bytes: Buffer) => Promise<void>;
}

/** The part of a file handle the write loop uses; a test can supply short writes. */
export interface RunIndexWriteTarget {
  write(buffer: Buffer, offset: number, length: number): Promise<{ readonly bytesWritten: number }>;
}

/** Write every byte or throw; a short write continues from where it stopped. */
export async function writeRunIndexBytes(
  handle: RunIndexWriteTarget,
  bytes: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    if (bytesWritten <= 0) throw new RunIndexStoreError("runs-index-io-failed"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    offset += bytesWritten;
  }
}

async function endsWithNewline(handle: FileHandle, size: number): Promise<boolean> {
  if (size === 0) return true;
  const last = Buffer.alloc(1);
  await handle.read(last, 0, 1, size - 1);
  return last[0] === 0x0a;
}

export interface RunIndexReadResult {
  readonly path: string;
  readonly exists: boolean;
  readonly rows: readonly RunIndexRowV1[];
  /** Lines that were not a current index row, such as an interrupted append. */
  readonly unreadableLines: number;
  readonly overflow: RunIndexOverflowV1 | null;
}

/** An index over `runs.indexMaxBytes` goes to `onOversize` rather than being read partially. */
export async function readRunIndex(input: {
  readonly indexDirectory: string;
  readonly maxBytes: ResolvedLimit;
  readonly onOversize: (observedBytes: number) => never;
}): Promise<RunIndexReadResult> {
  const directory = await lstat(input.indexDirectory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (directory === undefined) return readRunIndexUnderGate(input);
  if (directory !== undefined && !directory.isDirectory()) {
    throw new RunIndexStoreError("runs-index-unsafe-file");
  }
  return withRunMaintenanceGate(input.indexDirectory, () => readRunIndexUnderGate(input));
}

async function readRunIndexUnderGate(input: {
  readonly indexDirectory: string;
  readonly maxBytes: ResolvedLimit;
  readonly onOversize: (observedBytes: number) => never;
}): Promise<RunIndexReadResult> {
  const path = join(input.indexDirectory, RUN_INDEX_FILE_NAME);
  const overflow = await readRunIndexOverflow(input.indexDirectory, input.maxBytes);
  const bytes = await readPrivateFile(path, input.maxBytes.value, input.onOversize);
  if (bytes === undefined) {
    return { path, exists: false, rows: [], unreadableLines: 0, overflow };
  }
  const rows: RunIndexRowV1[] = [];
  let unreadableLines = 0;
  for (const line of bytes.toString("utf8").split("\n")) {
    if (line.length === 0) continue;
    let decoded: RunIndexRowV1 | undefined;
    try {
      decoded = decodeRunIndexRow(JSON.parse(line));
    } catch {
      decoded = undefined;
    }
    if (decoded) rows.push(decoded);
    else unreadableLines += 1;
  }
  return { path, exists: true, rows, unreadableLines, overflow };
}

/** Snapshots the run store could not index; every query reports it. */
export interface RunIndexOverflowV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-run-index-overflow";
  readonly refusedSnapshots: number;
  readonly firstRefusedAt: string;
  readonly lastRefusedAt: string;
  readonly lastRefusedRunId: string;
  readonly lastRefusal: {
    /** A limit refusal code, `runs-index-io-failed`, or `runs-index-record-unsupported`. */
    readonly code: string;
    readonly limitName: string | null;
    readonly limitValue: number | null;
    readonly observed: number | null;
  };
}

/** Strict progress projection used at a checkpoint boundary inside a live run. */
export async function publishRunIndexProgress(
  stateDirectory: string,
  record: RunRecord,
): Promise<void> {
  const indexDirectory = defaultRunIndexDirectory(stateDirectory);
  const now = new Date().toISOString();
  let maxBytes: ResolvedLimit | undefined;
  try {
    maxBytes = limit(RUN_INDEX_LIMITS.indexMaxBytes);
    const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    const projection = projectRunIndexRows(record, {
      origin: "run-store",
      snapshotId: randomUUID(),
      indexedAt: now,
      recordSha256: sha256Hex(bytes),
      fieldMaxChars: limit(RUN_INDEX_LIMITS.fieldMaxChars).value,
      docsfabRevision: docsfabBuildRevision(DOCSFAB_BUILD_IDENTITY),
    });
    if (!projection.ok) {
      // hygiene: envelope -- stable storage code is rendered by the run-index command.
      throw new RunIndexStoreError("runs-index-io-failed");
    }
    const result = await appendRunIndexSnapshot({
      indexDirectory,
      rows: projection.rows,
      maxBytes,
    });
    if (result.status === "refused") {
      await recordRunIndexOverflow({
        indexDirectory,
        runId: record.id,
        at: now,
        maxBytes: result.limit,
        refusal: {
          code: result.limit.refusal,
          limitName: result.limit.name,
          limitValue: result.limit.value,
          observed: result.observedBytes,
        },
      });
      // hygiene: envelope -- stable storage code is rendered by the run-index command.
      throw new RunIndexStoreError("runs-index-io-failed");
    }
  } catch (error) {
    if (error instanceof RunIndexStoreError) throw error;
    // hygiene: envelope -- stable storage code is rendered by the run-index command.
    throw new RunIndexStoreError("runs-index-io-failed");
  }
}

export async function recordRunIndexOverflow(input: {
  readonly indexDirectory: string;
  readonly runId: string;
  readonly at: string;
  readonly refusal: RunIndexOverflowV1["lastRefusal"];
  readonly maxBytes: ResolvedLimit;
}): Promise<void> {
  await ensurePrivateRunDirectory(input.indexDirectory);
  return withRunMaintenanceGate(input.indexDirectory, () => recordRunIndexOverflowUnderGate(input));
}

/** Physically purge one run's snapshots while excluding O_APPEND holders and readers. */
export async function purgeRunIndexRows(indexDirectory: string, runId: string): Promise<number> {
  const directory = await lstat(indexDirectory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (directory === undefined) await ensurePrivateRunDirectory(indexDirectory);
  if (directory !== undefined && !directory.isDirectory()) {
    throw new RunIndexStoreError("runs-index-unsafe-file");
  }
  return withRunMaintenanceGate(indexDirectory, async () => {
    await markIndexRunDeleted(indexDirectory, runId);
    const path = join(indexDirectory, RUN_INDEX_FILE_NAME);
    const current = await lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (current !== undefined && (!current.isFile() || current.nlink !== 1)) {
      throw new RunIndexStoreError("runs-index-unsafe-file");
    }
    const bytes = current === undefined ? Buffer.alloc(0) : await readFile(path);
    if (bytes.byteLength > limit("runs.indexMaxBytes").value) {
      throw new RunIndexStoreError("runs-index-unsafe-file");
    }
    const kept: string[] = [];
    let removed = 0;
    for (const line of bytes.toString("utf8").split("\n")) {
      if (line.length === 0) continue;
      let row: RunIndexRowV1 | undefined;
      try {
        row = decodeRunIndexRow(JSON.parse(line));
      } catch {
        row = undefined;
      }
      if (row?.runId === runId) removed += 1;
      else if (line.includes(runId) && row === undefined) {
        throw new RunIndexStoreError("runs-index-unsafe-file");
      } else kept.push(line);
    }
    const overflow = await readRunIndexOverflow(indexDirectory, limit("runs.indexMaxBytes"));
    if (overflow?.lastRefusedRunId === runId && overflow.refusedSnapshots !== 1) {
      throw new RunIndexStoreError("runs-index-unsafe-file");
    }
    if (removed > 0 && current !== undefined) {
      const next = Buffer.from(kept.length ? `${kept.join("\n")}\n` : "", "utf8");
      const pending = join(indexDirectory, `.runs-delete-${randomUUID()}.tmp`);
      const handle = await open(
        pending,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
      try {
        await handle.writeFile(next);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        const before = await lstat(path);
        if (
          before.dev !== current.dev ||
          before.ino !== current.ino ||
          before.size !== current.size
        ) {
          throw new RunIndexStoreError("runs-index-unsafe-file");
        }
        await rename(pending, path);
      } finally {
        await unlink(pending).catch(() => undefined);
      }
    }
    if (overflow?.lastRefusedRunId === runId) {
      const overflowPath = join(indexDirectory, RUN_INDEX_OVERFLOW_FILE_NAME);
      const before = await lstat(overflowPath);
      if (!before.isFile() || before.nlink !== 1) {
        throw new RunIndexStoreError("runs-index-unsafe-file");
      }
      await unlink(overflowPath);
      removed += 1;
    }
    return removed;
  });
}

async function recordRunIndexOverflowUnderGate(input: {
  readonly indexDirectory: string;
  readonly runId: string;
  readonly at: string;
  readonly refusal: RunIndexOverflowV1["lastRefusal"];
  readonly maxBytes: ResolvedLimit;
}): Promise<void> {
  if (await isIndexRunDeleted(input.indexDirectory, input.runId)) {
    throw new RunIndexStoreError("runs-index-run-deleted"); // hygiene: ok -- typed store code; its constructor supplies the operator-safe message.
  }
  const previous = await readRunIndexOverflow(input.indexDirectory, input.maxBytes);
  const next: RunIndexOverflowV1 = {
    schemaVersion: 1,
    kind: "docsfab-run-index-overflow",
    refusedSnapshots: (previous?.refusedSnapshots ?? 0) + 1,
    firstRefusedAt: previous?.firstRefusedAt ?? input.at,
    lastRefusedAt: input.at,
    lastRefusedRunId: input.runId,
    lastRefusal: input.refusal,
  };
  const destination = join(input.indexDirectory, RUN_INDEX_OVERFLOW_FILE_NAME);
  const temporary = join(
    input.indexDirectory,
    `.${RUN_INDEX_OVERFLOW_FILE_NAME}.${randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
  } catch {
    await unlink(temporary).catch(() => undefined);
    throw new RunIndexStoreError("runs-index-io-failed"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readRunIndexOverflow(
  indexDirectory: string,
  maxBytes: ResolvedLimit,
): Promise<RunIndexOverflowV1 | null> {
  const bytes = await readPrivateFile(
    join(indexDirectory, RUN_INDEX_OVERFLOW_FILE_NAME),
    maxBytes.value,
    () => {
      throw new RunIndexStoreError("runs-index-unsafe-file"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    },
  );
  if (bytes === undefined) return null;
  try {
    const value = JSON.parse(bytes.toString("utf8")) as Partial<RunIndexOverflowV1>;
    if (
      value.schemaVersion === 1 &&
      value.kind === "docsfab-run-index-overflow" &&
      typeof value.refusedSnapshots === "number" &&
      typeof value.lastRefusedRunId === "string" &&
      typeof value.lastRefusal?.code === "string"
    ) {
      return value as RunIndexOverflowV1;
    }
  } catch {
    // An unreadable overflow file is itself an incomplete index.
  }
  throw new RunIndexStoreError("runs-index-unsafe-file"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
}

async function readPrivateFile(
  path: string,
  maxBytes: number,
  onOversize: (observedBytes: number) => never,
): Promise<Buffer | undefined> {
  let entry: Stats;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw new RunIndexStoreError("runs-index-io-failed"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  }
  assertPrivateIndexFile(entry);
  if (entry.size > maxBytes) onOversize(entry.size);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    assertPrivateIndexFile(opened);
    if (opened.size > maxBytes) onOversize(opened.size);
    return await handle.readFile();
  } catch (error) {
    if (error instanceof RunIndexStoreError) throw error;
    throw new RunIndexStoreError("runs-index-io-failed"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function assertPrivateIndexFile(stat: Stats): void {
  const uid = process.getuid?.();
  if (!stat.isFile() || (uid !== undefined && stat.uid !== uid)) {
    throw new RunIndexStoreError("runs-index-unsafe-file"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/**
 * The run store's post-save index hook. It never throws, because a derived
 * projection must not fail the record it describes; failures go to the
 * overflow file, or to a stderr warning if that write fails too.
 */
export function createRunStoreIndexer(
  stateDirectory: string,
  options: {
    readonly now?: () => Date;
    readonly snapshotId?: () => string;
    readonly append?: RunIndexAppendOptions;
    /** Test seam for the build revision stamped on every row. */
    readonly docsfabRevision?: string | null;
  } = {},
): (record: RunRecord, bytes: Buffer) => Promise<void> {
  const indexDirectory = defaultRunIndexDirectory(stateDirectory);
  const docsfabRevision =
    options.docsfabRevision !== undefined
      ? options.docsfabRevision
      : docsfabBuildRevision(DOCSFAB_BUILD_IDENTITY);
  return async (record, bytes) => {
    if (!isRunIndexTerminalStatus(record.status)) return;
    const at = (options.now ?? (() => new Date()))().toISOString();
    let maxBytes: ResolvedLimit | undefined;
    try {
      maxBytes = limit(RUN_INDEX_LIMITS.indexMaxBytes);
      const projection = projectRunIndexRows(record, {
        origin: "run-store",
        snapshotId: (options.snapshotId ?? randomUUID)(),
        indexedAt: at,
        recordSha256: sha256Hex(bytes),
        fieldMaxChars: limit(RUN_INDEX_LIMITS.fieldMaxChars).value,
        docsfabRevision,
      });
      if (!projection.ok) {
        await recordRunIndexOverflow({
          indexDirectory,
          runId: record.id,
          at,
          maxBytes,
          refusal: {
            code: "runs-index-record-unsupported",
            limitName: null,
            limitValue: null,
            observed: null,
          },
        });
        return;
      }
      const result = await appendRunIndexSnapshot(
        { indexDirectory, rows: projection.rows, maxBytes },
        options.append,
      );
      if (result.status === "refused") {
        await recordRunIndexOverflow({
          indexDirectory,
          runId: record.id,
          at,
          maxBytes,
          refusal: {
            code: result.limit.refusal,
            limitName: result.limit.name,
            limitValue: result.limit.value,
            observed: result.observedBytes,
          },
        });
      }
    } catch {
      try {
        if (!maxBytes) throw new RunIndexStoreError("runs-index-io-failed"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
        await recordRunIndexOverflow({
          indexDirectory,
          runId: record.id,
          at,
          maxBytes,
          refusal: {
            code: "runs-index-io-failed",
            limitName: null,
            limitValue: null,
            observed: null,
          },
        });
      } catch {
        reportRunIndexLoss(
          "runs-index-io-failed",
          `Run ${record.id} was saved but not added to the run index, and the loss could not be recorded in ${RUN_INDEX_OVERFLOW_FILE_NAME}. ${runIndexRebuildRemediation(stateDirectory, indexDirectory)}`,
        );
      }
    }
  };
}

/**
 * Builds a saving run store whose terminal saves also write the index.
 * `run-index-cli-wiring.test.ts` requires it for every saving run store under
 * `src/cli/` and `src/application/`.
 */
export function createIndexedFileRunStore(
  stateDirectory: string,
  options: Omit<FileRunStoreOptions, "afterSave"> = {},
): FileRunStore {
  return new FileRunStore(stateDirectory, {
    ...options,
    afterSave: createRunStoreIndexer(stateDirectory),
  });
}
