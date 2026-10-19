// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { ARTIFACT_KINDS, type Artifact, type ArtifactValidationOptions } from "./contracts.js";
import { canonicalArtifactDigest, canonicalArtifactJson } from "./canonical.js";
import { validateArtifact } from "./validate.js";
import { isPlainRecord, isNodeError } from "../shared/primitives.js";
import { formatLimitObservation, limit, type ResolvedLimit } from "../config/limits.js";

const SHA256 = /^[a-f0-9]{64}$/;
/** The catalogued object bound a store applies when its caller names none. */
export const ARTIFACT_OBJECT_LIMIT = "artifacts.maxObjectBytes";
/** That limit's catalog refusal; a test holds the two equal. */
export const ARTIFACT_OBJECT_BOUND_CODE = "artifacts-max-object-bytes-bound";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SAFE_TEMPORARY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export type ArtifactStoreErrorCode =
  | "invalid-digest"
  | "unsafe-path"
  | "not-found"
  | "symlink"
  | "invalid-node"
  | "insecure-permissions"
  | "owner-mismatch"
  | "artifact-too-large"
  | typeof ARTIFACT_OBJECT_BOUND_CODE
  | "invalid-json"
  | "invalid-artifact"
  | "integrity-mismatch";

/** The bound an oversized object crossed, and the size the store observed. */
export interface ArtifactStoreSizeRefusalV1 {
  /** The catalogued limit, or the caller's own `maxArtifactBytes` bound. */
  readonly limit: ResolvedLimit | number;
  readonly observed: number;
}

export class ArtifactStoreError extends Error {
  /** Set only on a size refusal: the bound's name, its value, and what was observed. */
  public readonly limitName?: string;
  public readonly configured?: number;
  public readonly observed?: number;

  public constructor(
    public readonly code: ArtifactStoreErrorCode,
    public readonly path: string,
    size?: ArtifactStoreSizeRefusalV1,
  ) {
    super(artifactStoreErrorMessage(code, path, size));
    this.name = "ArtifactStoreError";
    if (size) {
      this.limitName = typeof size.limit === "number" ? "maxArtifactBytes" : size.limit.name;
      this.configured = typeof size.limit === "number" ? size.limit : size.limit.value;
      this.observed = size.observed;
    }
  }
}

function artifactStoreErrorMessage(
  code: ArtifactStoreErrorCode,
  path: string,
  size: ArtifactStoreSizeRefusalV1 | undefined,
): string {
  if (!size) return `Artifact store failed (${code}) at ${path}.`;
  if (typeof size.limit === "number") {
    return `Artifact store failed (${code}) at ${path}: ${size.observed} bytes exceeds the caller's ${size.limit}-byte bound.`;
  }
  return `Artifact store refused the object at ${path}. ${formatLimitObservation(size.limit, size.observed)}`;
}

/** Whether `error` is the store refusing an object for its size, under either bound. */
export function isArtifactObjectSizeRefusal(error: unknown): error is ArtifactStoreError {
  return (
    error instanceof ArtifactStoreError &&
    (error.code === ARTIFACT_OBJECT_BOUND_CODE || error.code === "artifact-too-large")
  );
}

/** Content digest of an opaque JSON record written through {@link DurableArtifactStore.putRecord}. */
export function opaqueRecordDigest(value: unknown): string {
  return createHash("sha256").update(stableRecordJson(value), "utf8").digest("hex");
}

export interface DurableArtifactStoreOptions {
  /**
   * A caller's own tighter object bound. Without it the store applies the
   * effective `artifacts.maxObjectBytes`, host overrides included.
   */
  maxArtifactBytes?: number;
  /** Test seam after a private temporary object is complete and before publication. */
  beforeCommit?: (temporaryPath: string, destinationPath: string) => void | Promise<void>;
  /** Test seam after an exact object leaf is pinned and before its bytes are read. */
  beforeRead?: (objectPath: string) => void | Promise<void>;
  /** Test seam for deterministic temporary names. */
  id?: () => string;
}

export interface ArtifactStoreWriteResult {
  digest: string;
  created: boolean;
}

interface DirectoryAncestorIdentity {
  path: string;
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  symbolicLink: boolean;
}

interface PrivateDirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
  uid: number;
  mode: number;
}

interface ArtifactStoreIdentity {
  ancestors: readonly DirectoryAncestorIdentity[];
  directories: readonly PrivateDirectoryIdentity[];
  objectDirectory: PrivateDirectoryIdentity;
}

/**
 * An immutable, content-addressed artifact store for handing artifacts between
 * separate local DocsFab invocations. Artifact validation remains explicit:
 * callers may provide the current content index when writing or reading.
 */
export class DurableArtifactStore {
  public readonly root: string;
  private readonly objectDirectory: string;
  private readonly maxArtifactBytes: number;
  /** The catalogued bound in force, or `undefined` when the caller named its own. */
  private readonly objectLimit: ResolvedLimit | undefined;
  private readonly options: DurableArtifactStoreOptions;

  public constructor(root: string, options: DurableArtifactStoreOptions = {}) {
    if (typeof root !== "string" || root.length === 0 || root.includes("\0")) {
      throw new ArtifactStoreError("unsafe-path", String(root));
    }
    const objectLimit =
      options.maxArtifactBytes === undefined ? limit(ARTIFACT_OBJECT_LIMIT) : undefined;
    const maxArtifactBytes = options.maxArtifactBytes ?? objectLimit!.value;
    if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1) {
      throw new ArtifactStoreError("artifact-too-large", "maxArtifactBytes");
    }
    this.root = resolve(root);
    this.objectDirectory = this.withinRoot("objects", "sha256");
    this.maxArtifactBytes = maxArtifactBytes;
    this.objectLimit = objectLimit;
    this.options = options;
  }

  /** The largest object, in bytes, this store writes or reads. */
  public get maxObjectBytes(): number {
    return this.maxArtifactBytes;
  }

  public async initialize(): Promise<void> {
    await this.prepareDirectories();
  }

  public async put(
    artifact: Artifact,
    validation?: ArtifactValidationOptions,
  ): Promise<ArtifactStoreWriteResult> {
    const normalized = inspectArtifact(artifact);
    const digest = normalized.digest;
    if (validation) validateArtifact(normalized, validation);
    const serialized = canonicalArtifactJson(normalized);
    return this.writeObjectBytes(digest, Buffer.from(serialized, "utf8"), async () => {
      await this.get(digest, validation);
    });
  }

  /**
   * Persist an opaque JSON record under a caller-supplied content digest.
   * Used by sealed domain contracts (for example foundation canon) that share
   * the durable object pool without joining the Artifact kind set. Existing
   * bytes must match exactly; substituted content fails closed.
   */
  public async putRecord(digest: string, value: unknown): Promise<ArtifactStoreWriteResult> {
    if (!SHA256.test(digest)) {
      throw new ArtifactStoreError("invalid-digest", digest);
    }
    let serialized: string;
    try {
      serialized = stableRecordJson(value);
    } catch {
      throw new ArtifactStoreError("invalid-json", digest);
    }
    const contents = Buffer.from(serialized, "utf8");
    return this.writeObjectBytes(digest, contents, async () => {
      const existing = await this.readObjectBytes(digest);
      if (!existing.equals(contents)) {
        throw new ArtifactStoreError("integrity-mismatch", this.objectPath(digest));
      }
    });
  }

  public async get(digest: string, validation?: ArtifactValidationOptions): Promise<Artifact> {
    const contents = await this.readObjectBytes(digest);
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents.toString("utf8"));
    } catch {
      throw new ArtifactStoreError("invalid-json", this.objectPath(digest));
    }
    const artifact = inspectArtifact(parsed, digest);
    if (canonicalArtifactJson(artifact) !== contents.toString("utf8")) {
      throw new ArtifactStoreError("integrity-mismatch", this.objectPath(digest));
    }
    return validation ? validateArtifact(artifact, validation) : artifact;
  }

  /**
   * Read an opaque JSON record previously written with {@link putRecord}.
   * Does not interpret Artifact envelopes; callers decode their own contracts.
   */
  public async getRecord(digest: string, options: { readOnly?: true } = {}): Promise<unknown> {
    const contents = await this.readObjectBytes(digest, options.readOnly === true);
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents.toString("utf8"));
    } catch {
      throw new ArtifactStoreError("invalid-json", this.objectPath(digest));
    }
    if (stableRecordJson(parsed) !== contents.toString("utf8")) {
      throw new ArtifactStoreError("integrity-mismatch", this.objectPath(digest));
    }
    return parsed;
  }

  public async has(digest: string): Promise<boolean> {
    try {
      await this.readObjectBytes(digest);
      return true;
    } catch (error) {
      if (error instanceof ArtifactStoreError && error.code === "not-found") return false;
      throw error;
    }
  }

  private async writeObjectBytes(
    digest: string,
    contents: Buffer,
    whenPresent: () => Promise<void>,
  ): Promise<ArtifactStoreWriteResult> {
    this.assertWithinSize(contents.byteLength, digest);
    const store = await this.prepareDirectories();
    const { clearArtifactDeletionMarker, withRunMaintenanceGate } = await import(
      "../records/run-maintenance-gate.js"
    );
    return withRunMaintenanceGate(this.root, async () => {
      const result = await this.writeObjectBytesUnderGate(digest, contents, whenPresent, store);
      await clearArtifactDeletionMarker(this.root, digest);
      return result;
    });
  }

  private async writeObjectBytesUnderGate(
    digest: string,
    contents: Buffer,
    whenPresent: () => Promise<void>,
    store: ArtifactStoreIdentity,
  ): Promise<ArtifactStoreWriteResult> {
    try {
      await whenPresent();
      await assertArtifactStoreIdentity(store);
      return { digest, created: false };
    } catch (error) {
      if (!(error instanceof ArtifactStoreError) || error.code !== "not-found") throw error;
    }

    const destination = this.objectPath(digest);
    const temporaryId = (this.options.id ?? randomUUID)();
    if (!SAFE_TEMPORARY_ID.test(temporaryId)) {
      throw new ArtifactStoreError("unsafe-path", this.objectDirectory); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    }
    const temporary = this.withinRoot("objects", "sha256", `.${digest}.${temporaryId}.tmp`);
    let handle: FileHandle | undefined;
    let temporaryStat: Stats | undefined;
    let temporaryCreated = false;
    try {
      await assertArtifactStoreIdentity(store);
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
        PRIVATE_FILE_MODE,
      );
      temporaryCreated = true;
      await handle.chmod(PRIVATE_FILE_MODE);
      await handle.writeFile(contents);
      await handle.sync();
      temporaryStat = await handle.stat();
      assertExactPrivateFileStat(temporaryStat, temporary);
      await this.options.beforeCommit?.(temporary, destination);
      await assertArtifactStoreIdentity(store);
      await assertExactFileIdentity(temporary, temporaryStat);
      await handle.close();
      handle = undefined;
      try {
        // An atomic no-clobber link preserves the first immutable object when
        // separate processes publish the same digest concurrently.
        await link(temporary, destination);
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        await removePinnedTemporary(store, temporary, temporaryStat);
        temporaryCreated = false;
        await whenPresent();
        await assertArtifactStoreIdentity(store);
        return { digest, created: false };
      }
      await syncDirectory(store.objectDirectory);
      const destinationStat = await lstat(destination);
      assertExactPrivateFileStat(destinationStat, destination);
      if (
        destinationStat.dev !== temporaryStat.dev ||
        destinationStat.ino !== temporaryStat.ino ||
        destinationStat.size !== temporaryStat.size
      ) {
        throw new ArtifactStoreError("integrity-mismatch", destination); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
      }
      await removePinnedTemporary(store, temporary, temporaryStat);
      temporaryCreated = false;
      await syncDirectory(store.objectDirectory);
      await assertArtifactStoreIdentity(store);
      await assertExactFileIdentity(destination, destinationStat);
    } finally {
      await handle?.close().catch(() => undefined);
      if (temporaryCreated && temporaryStat) {
        await removePinnedTemporary(store, temporary, temporaryStat).catch(() => undefined);
      }
    }
    return { digest, created: true };
  }

  private async readObjectBytes(digest: string, readOnly = false): Promise<Buffer> {
    const store = await this.prepareDirectories(readOnly);
    const path = this.objectPath(digest);
    let entry: Stats;
    try {
      entry = await lstat(path);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) throw new ArtifactStoreError("not-found", path);
      throw error;
    }
    if (entry.isSymbolicLink()) throw new ArtifactStoreError("symlink", path);
    assertPrivateFileStat(entry, path);
    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | noFollowFlag());
    } catch (error) {
      if (isNodeError(error, "ENOENT")) throw new ArtifactStoreError("not-found", path); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
      if (isNodeError(error, "ELOOP")) throw new ArtifactStoreError("symlink", path); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
      throw error;
    }

    try {
      const before = await handle.stat();
      assertPrivateFileStat(before, path);
      if (before.dev !== entry.dev || before.ino !== entry.ino) {
        throw new ArtifactStoreError("integrity-mismatch", path); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
      }
      this.assertWithinSize(before.size, path);
      await assertArtifactStoreIdentity(store);
      await this.options.beforeRead?.(path);
      const contents = await readBounded(handle, this.maxArtifactBytes, (observed) =>
        this.refuseSize(path, observed),
      );
      const after = await handle.stat();
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
        throw new ArtifactStoreError("integrity-mismatch", path);
      }
      await assertArtifactStoreIdentity(store);
      await assertExactFileIdentity(path, before);
      return contents;
    } finally {
      await handle.close();
    }
  }

  private objectPath(digest: string): string {
    if (!SHA256.test(digest)) {
      throw new ArtifactStoreError("invalid-digest", digest);
    }
    return this.withinRoot("objects", "sha256", `${digest}.json`);
  }

  private withinRoot(...parts: string[]): string {
    const candidate = resolve(this.root, ...parts);
    const child = relative(this.root, candidate);
    if (
      child === "" ||
      child === ".." ||
      child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(child)
    ) {
      throw new ArtifactStoreError("unsafe-path", candidate);
    }
    return candidate;
  }

  private assertWithinSize(size: number, path: string): void {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new ArtifactStoreError("artifact-too-large", path);
    }
    if (size > this.maxArtifactBytes) this.refuseSize(path, size);
  }

  /** Refuse by the bound in force, naming it and the observed size. */
  private refuseSize(path: string, observed: number): never {
    if (this.objectLimit) {
      throw new ArtifactStoreError(ARTIFACT_OBJECT_BOUND_CODE, path, {
        limit: this.objectLimit,
        observed,
      });
    }
    // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message with both sizes.
    throw new ArtifactStoreError("artifact-too-large", path, {
      limit: this.maxArtifactBytes,
      observed,
    });
  }

  private async prepareDirectories(readOnly = false): Promise<ArtifactStoreIdentity> {
    const ancestorsBefore = await captureDirectoryAncestors(dirname(this.root));
    try {
      if (!readOnly) await mkdir(this.root, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      await assertDirectoryAncestors(ancestorsBefore);
      const root = await pinPrivateDirectory(this.root);
      const objects = await (readOnly ? pinPrivateDirectory : ensurePrivateDirectory)(
        this.withinRoot("objects"),
      );
      const objectDirectory = await (readOnly ? pinPrivateDirectory : ensurePrivateDirectory)(
        this.objectDirectory,
      );
      const ancestors = await captureDirectoryAncestors(dirname(this.root));
      const store = { ancestors, directories: [root, objects, objectDirectory], objectDirectory };
      await assertArtifactStoreIdentity(store);
      return store;
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError("unsafe-path", this.root); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    }
  }
}

function inspectArtifact(value: unknown, expectedDigest?: string): Artifact {
  if (!isPlainRecord(value)) throw new ArtifactStoreError("invalid-artifact", "$.artifact");
  const keys = Object.keys(value).sort();
  const expectedKeys = ["digest", "kind", "payload", "repository", "schemaVersion"];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new ArtifactStoreError("invalid-artifact", "$.artifact");
  }
  if (value.schemaVersion !== 1 || !ARTIFACT_KINDS.includes(value.kind as never)) {
    throw new ArtifactStoreError("invalid-artifact", "$.artifact");
  }
  if (!SHA256.test(String(value.digest))) {
    throw new ArtifactStoreError("invalid-digest", "$.digest");
  }
  if (expectedDigest !== undefined && value.digest !== expectedDigest) {
    throw new ArtifactStoreError("integrity-mismatch", "$.digest");
  }
  if (canonicalArtifactDigest(value) !== value.digest) {
    throw new ArtifactStoreError("integrity-mismatch", "$.digest");
  }
  return value as unknown as Artifact;
}

async function ensurePrivateDirectory(path: string): Promise<PrivateDirectoryIdentity> {
  try {
    await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  return pinPrivateDirectory(path);
}

async function pinPrivateDirectory(path: string): Promise<PrivateDirectoryIdentity> {
  let entry: Stats;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) throw new ArtifactStoreError("not-found", path); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    throw error;
  }
  if (entry.isSymbolicLink()) throw new ArtifactStoreError("symlink", path); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  if (!entry.isDirectory()) throw new ArtifactStoreError("invalid-node", path); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  assertOwner(entry.uid, path);
  const mode = entry.mode & 0o777;
  if ((mode & 0o077) !== 0 || (mode & 0o700) !== 0o700) {
    throw new ArtifactStoreError("insecure-permissions", path); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | noFollowFlag());
  try {
    const descriptor = await handle.stat();
    if (
      !descriptor.isDirectory() ||
      descriptor.dev !== entry.dev ||
      descriptor.ino !== entry.ino ||
      descriptor.uid !== entry.uid ||
      descriptor.mode !== entry.mode
    ) {
      throw new ArtifactStoreError("unsafe-path", path); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    }
    return {
      path,
      dev: descriptor.dev,
      ino: descriptor.ino,
      uid: descriptor.uid,
      mode: descriptor.mode,
    };
  } finally {
    await handle.close();
  }
}

function assertPrivateFileStat(stat: Stats, path: string): void {
  if (!stat.isFile()) throw new ArtifactStoreError("invalid-node", path);
  assertOwner(stat.uid, path);
  if ((stat.mode & 0o077) !== 0) {
    throw new ArtifactStoreError("insecure-permissions", path);
  }
}

function assertExactPrivateFileStat(stat: Stats, path: string): void {
  assertPrivateFileStat(stat, path);
  if ((stat.mode & 0o7777) !== PRIVATE_FILE_MODE) {
    throw new ArtifactStoreError("insecure-permissions", path); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  }
}

function assertOwner(uid: number, path: string): void {
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && uid !== currentUid) {
    throw new ArtifactStoreError("owner-mismatch", path);
  }
}

async function readBounded(
  handle: FileHandle,
  maximum: number,
  refuse: (observed: number) => never,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximum - total + 1));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    // The file grew past the bound after its size was checked; `total` is
    // what was read before stopping, a lower bound on the object's size.
    if (total > maximum) refuse(total);
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
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
      throw new ArtifactStoreError("symlink", ancestor); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    }
    if (!symbolicLink && !stat.isDirectory()) {
      throw new ArtifactStoreError("invalid-node", ancestor); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    }
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
      throw new ArtifactStoreError("unsafe-path", ancestor.path); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
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
      throw new ArtifactStoreError("unsafe-path", ancestor.path); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    }
  }
}

async function isOperatingSystemDirectoryAlias(path: string): Promise<boolean> {
  if (process.platform !== "darwin" || (path !== "/var" && path !== "/tmp")) return false;
  const canonical = await realpath(path).catch(() => "");
  return canonical === `/private${path}`;
}

async function assertArtifactStoreIdentity(expected: ArtifactStoreIdentity): Promise<void> {
  await assertDirectoryAncestors(expected.ancestors);
  for (const directory of expected.directories) {
    const stat = await lstat(directory.path).catch(() => {
      throw new ArtifactStoreError("unsafe-path", directory.path); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== directory.dev ||
      stat.ino !== directory.ino ||
      stat.uid !== directory.uid ||
      stat.mode !== directory.mode
    ) {
      throw new ArtifactStoreError("unsafe-path", directory.path); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    }
  }
}

async function assertExactFileIdentity(path: string, expected: Stats): Promise<void> {
  const stat = await lstat(path).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) throw new ArtifactStoreError("not-found", path); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    throw error;
  });
  if (stat.isSymbolicLink()) throw new ArtifactStoreError("symlink", path); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  assertExactPrivateFileStat(stat, path);
  if (
    stat.dev !== expected.dev ||
    stat.ino !== expected.ino ||
    stat.uid !== expected.uid ||
    stat.mode !== expected.mode ||
    stat.size !== expected.size
  ) {
    throw new ArtifactStoreError("integrity-mismatch", path); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  }
}

async function removePinnedTemporary(
  store: ArtifactStoreIdentity,
  temporary: string,
  expected: Stats,
): Promise<void> {
  await assertArtifactStoreIdentity(store);
  await assertExactFileIdentity(temporary, expected);
  await unlink(temporary);
}

async function syncDirectory(expected: PrivateDirectoryIdentity): Promise<void> {
  const handle = await open(
    expected.path,
    constants.O_RDONLY | constants.O_DIRECTORY | noFollowFlag(),
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isDirectory() ||
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino ||
      stat.uid !== expected.uid ||
      stat.mode !== expected.mode
    ) {
      throw new ArtifactStoreError("unsafe-path", expected.path); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

/** Stable JSON for opaque records: sorted keys, plain JSON values only. */
function stableRecordJson(value: unknown): string {
  return JSON.stringify(sortRecordValue(value));
}

function sortRecordValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("invalid-json");
    return value;
  }
  if (Array.isArray(value)) return value.map(sortRecordValue);
  if (!isPlainRecord(value)) throw new Error("invalid-json");
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortRecordValue(value[key])]),
  );
}
