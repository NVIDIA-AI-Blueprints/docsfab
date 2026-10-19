// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { hostname } from "node:os";

import { isNodeError } from "../shared/primitives.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/** Immutable generation in the exact-checkpoint claim journal. */
export interface AnswerRecordContinuationClaimV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-answer-record-continuation-claim-event";
  readonly sourceRunId: string;
  readonly sourceRunRecordSha256: string;
  readonly checkpointSha256: string;
  readonly checkpointSequence: number;
  readonly checkpointAttempt: number;
  readonly logicalRunId: string;
  readonly childRunId: string;
  readonly generation: number;
  readonly previousEventSha256: string | null;
  readonly ownerHost: string;
  readonly ownerPid: number;
  readonly claimId: string;
  readonly claimedAt: string;
}

export type AnswerRecordContinuationStoreErrorCode =
  | "unsafe-root"
  | "unsafe-identity"
  | "unsafe-entry"
  | "malformed-claim"
  | "already-claimed"
  | "claim-write-failed";

export class AnswerRecordContinuationStoreError extends Error {
  public constructor(
    public readonly code: AnswerRecordContinuationStoreErrorCode,
    public readonly existingChildRunId?: string,
  ) {
    super(
      code === "already-claimed" && existingChildRunId
        ? `Answer-record continuation was already claimed by child run ${existingChildRunId}. Inspect that run before starting another continuation.`
        : `Answer-record continuation claim failed (${code}).`,
    );
    this.name = "AnswerRecordContinuationStoreError";
  }
}

export interface AnswerRecordContinuationClaimStoreOptions {
  /** Injected immediately before no-clobber publication. */
  readonly beforeLink?: () => void | Promise<void>;
  /** Test seam for an abandoned generation; production always uses this process id. */
  readonly ownerPid?: () => number;
  readonly ownerHost?: () => string;
  /** Test seam for proving dead-owner recovery. */
  readonly ownerIsAlive?: (pid: number) => boolean | Promise<boolean>;
}

interface DirectoryIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly ancestors: readonly AncestorIdentity[];
}

interface AncestorIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
  readonly symbolicLink: boolean;
}

/**
 * One exact source checkpoint can start one physical child. Events are
 * append-only: after a process dies before saving that child, an exact retry
 * may append a new owner generation for the same child id, but never choose a
 * second child. Every event is durable before provider work begins.
 */
export class AnswerRecordContinuationClaimStore {
  private root: string;

  public constructor(
    root: string,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = randomUUID,
    private readonly options: AnswerRecordContinuationClaimStoreOptions = {},
  ) {
    if (!root || root.includes("\0")) fail("unsafe-root");
    this.root = resolve(root);
  }

  public async inspect(
    input: Omit<ClaimIdentity, "childRunId">,
  ): Promise<AnswerRecordContinuationClaimV1 | undefined> {
    validateIdentity({ ...input, childRunId: "inspect" });
    const root = await this.initialize();
    const key = claimKey(input.sourceRunId, input.checkpointSha256);
    return (await readJournal(this.root, root, key, input)).latest;
  }

  public async claim(input: ClaimIdentity): Promise<AnswerRecordContinuationClaimV1> {
    validateIdentity(input);
    const root = await this.initialize();
    const key = claimKey(input.sourceRunId, input.checkpointSha256);
    const existing = (await readJournal(this.root, root, key, input)).latest;
    if (existing) {
      if (existing.childRunId !== input.childRunId) {
        // hygiene: envelope -- stable claim code is rendered by the CLI boundary.
        throw new AnswerRecordContinuationStoreError("already-claimed", existing.childRunId);
      }
      if (await this.isOwnerAlive(existing)) {
        // hygiene: envelope -- stable claim code is rendered by the CLI boundary.
        throw new AnswerRecordContinuationStoreError("already-claimed", existing.childRunId);
      }
      return await this.publishEvent(
        root,
        key,
        input,
        existing.generation + 1,
        eventDigest(existing),
      );
    }
    return await this.publishEvent(root, key, input, 0, null);
  }

  public async isOwnerAlive(claim: AnswerRecordContinuationClaimV1): Promise<boolean> {
    if (this.options.ownerIsAlive) return await this.options.ownerIsAlive(claim.ownerPid);
    const localHost = `${process.platform}:${hostname()}`;
    // Run state can be copied between machines. An absent PID on another host
    // is not evidence that the original owner died here; refuse recovery.
    if (!localHost || claim.ownerHost !== localHost) return true;
    try {
      process.kill(claim.ownerPid, 0);
      // A live reused PID is conservatively still treated as owned.
      return true;
    } catch (error) {
      if (isNodeError(error, "ESRCH")) return false;
      return true;
    }
  }

  private async publishEvent(
    root: DirectoryIdentity,
    key: string,
    input: ClaimIdentity,
    generation: number,
    previousEventSha256: string | null,
  ): Promise<AnswerRecordContinuationClaimV1> {
    const ownerPid = this.options.ownerPid?.() ?? process.pid;
    const event: AnswerRecordContinuationClaimV1 = {
      schemaVersion: 1,
      kind: "docsfab-answer-record-continuation-claim-event",
      ...input,
      generation,
      previousEventSha256,
      ownerHost: this.options.ownerHost?.() ?? `${process.platform}:${hostname()}`,
      ownerPid,
      claimId: this.id(),
      claimedAt: this.now().toISOString(),
    };
    if (
      !Number.isSafeInteger(event.ownerPid) ||
      event.ownerPid < 1 ||
      typeof event.ownerHost !== "string" ||
      event.ownerHost.length === 0 ||
      !SAFE_ID.test(event.claimId)
    )
      fail("unsafe-identity");
    const destination = eventPath(this.root, key, generation);
    const temporary = join(this.root, `.${key}.${randomUUID()}.tmp`);
    let handle: FileHandle | undefined;
    let temporaryCreated = false;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
      temporaryCreated = true;
      await handle.chmod(PRIVATE_FILE_MODE);
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      await handle.sync();
      const opened = await handle.stat();
      assertPrivateFile(opened);
      await handle.close();
      handle = undefined;
      const atPath = await lstat(temporary);
      assertSameFile(opened, atPath);
      await this.options.beforeLink?.();
      await assertSameDirectory(root);
      try {
        await link(temporary, destination);
      } catch (error) {
        if (isNodeError(error, "EEXIST")) {
          const latest = (await readJournal(this.root, root, key, input)).latest;
          // hygiene: envelope -- stable claim code is rendered by the CLI boundary.
          throw new AnswerRecordContinuationStoreError("already-claimed", latest?.childRunId);
        }
        throw error;
      }
      await assertSameDirectory(root);
      const destinationStat = await lstat(destination);
      assertSameFile(opened, destinationStat);
      const directory = await open(
        this.root,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        const pinned = await directory.stat();
        if (pinned.dev !== root.dev || pinned.ino !== root.ino) fail("unsafe-root");
        await directory.sync();
      } finally {
        await directory.close();
      }
      await assertSameDirectory(root);
      return event;
    } catch (error) {
      if (error instanceof AnswerRecordContinuationStoreError) throw error;
      // hygiene: envelope -- stable claim code is rendered by the CLI boundary.
      throw new AnswerRecordContinuationStoreError("claim-write-failed");
    } finally {
      await handle?.close().catch(() => undefined);
      if (temporaryCreated) {
        await assertSameDirectory(root)
          .then(() => unlink(temporary))
          .catch(() => undefined);
      }
    }
  }

  private async initialize(): Promise<DirectoryIdentity> {
    const ancestors = await captureSafeOwnedAncestors(this.root);
    const before = await lstat(this.root).catch((error: unknown) =>
      isNodeError(error, "ENOENT") ? undefined : Promise.reject(error),
    );
    if (before?.isSymbolicLink() || (before && !before.isDirectory())) fail("unsafe-root");
    await mkdir(this.root, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await assertSafeOwnedAncestors(ancestors);
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        this.root,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      let stat = await handle.stat();
      assertPrivateDirectory(stat, false);
      const atPath = await lstat(this.root);
      if (atPath.dev !== stat.dev || atPath.ino !== stat.ino || atPath.isSymbolicLink())
        fail("unsafe-root");
      if ((stat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
        await handle.chmod(PRIVATE_DIRECTORY_MODE);
        stat = await handle.stat();
      }
      assertPrivateDirectory(stat, true);
      await assertSafeOwnedAncestors(ancestors);
      return { path: this.root, dev: stat.dev, ino: stat.ino, uid: stat.uid, ancestors };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

type ClaimIdentity = {
  readonly sourceRunId: string;
  readonly sourceRunRecordSha256: string;
  readonly checkpointSha256: string;
  readonly checkpointSequence: number;
  readonly checkpointAttempt: number;
  readonly logicalRunId: string;
  readonly childRunId: string;
};

async function readJournal(
  directory: string,
  root: DirectoryIdentity,
  key: string,
  expected: Omit<ClaimIdentity, "childRunId">,
): Promise<{ latest?: AnswerRecordContinuationClaimV1 }> {
  await assertSameDirectory(root);
  const names = await readdir(directory);
  const generations = names
    .map((name) => ({
      name,
      match: new RegExp(`^${key}\\.(0|[1-9][0-9]*)\\.json$`, "u").exec(name),
    }))
    .filter((entry) => entry.match !== null)
    .map((entry) => ({ name: entry.name, generation: Number(entry.match![1]) }))
    .sort((left, right) => left.generation - right.generation);
  if (generations.length === 0) return {};
  let previousEventSha256: string | null = null;
  let latest: AnswerRecordContinuationClaimV1 | undefined;
  for (let index = 0; index < generations.length; index += 1) {
    const entry = generations[index]!;
    if (entry.generation !== index) fail("malformed-claim");
    const value = await readEvent(join(directory, entry.name), root);
    if (
      value.generation !== index ||
      value.previousEventSha256 !== previousEventSha256 ||
      value.sourceRunId !== expected.sourceRunId ||
      value.sourceRunRecordSha256 !== expected.sourceRunRecordSha256 ||
      value.checkpointSha256 !== expected.checkpointSha256 ||
      value.checkpointSequence !== expected.checkpointSequence ||
      value.checkpointAttempt !== expected.checkpointAttempt ||
      value.logicalRunId !== expected.logicalRunId ||
      (latest && value.childRunId !== latest.childRunId)
    ) {
      fail("malformed-claim");
    }
    previousEventSha256 = eventDigest(value);
    latest = value;
  }
  await assertSameDirectory(root);
  return latest ? { latest } : {};
}

async function readEvent(
  path: string,
  root: DirectoryIdentity,
): Promise<AnswerRecordContinuationClaimV1> {
  await assertSameDirectory(root);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    assertPrivateFile(opened);
    const atPath = await lstat(path);
    assertSameFile(opened, atPath);
    const value: unknown = JSON.parse(await handle.readFile("utf8"));
    const claim = decodeClaim(value);
    await assertSameDirectory(root);
    return claim;
  } catch (error) {
    if (error instanceof AnswerRecordContinuationStoreError) throw error;
    // hygiene: envelope -- stable claim code is rendered by the CLI boundary.
    throw new AnswerRecordContinuationStoreError("malformed-claim");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function decodeClaim(value: unknown): AnswerRecordContinuationClaimV1 {
  if (!isObject(value)) fail("malformed-claim");
  const fields = [
    "schemaVersion",
    "kind",
    "sourceRunId",
    "sourceRunRecordSha256",
    "checkpointSha256",
    "checkpointSequence",
    "checkpointAttempt",
    "logicalRunId",
    "childRunId",
    "generation",
    "previousEventSha256",
    "ownerHost",
    "ownerPid",
    "claimId",
    "claimedAt",
  ];
  if (
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  )
    fail("malformed-claim");
  const claim = value as unknown as AnswerRecordContinuationClaimV1;
  validateIdentity(claim);
  if (
    claim.schemaVersion !== 1 ||
    claim.kind !== "docsfab-answer-record-continuation-claim-event" ||
    !Number.isSafeInteger(claim.generation) ||
    claim.generation < 0 ||
    !(claim.previousEventSha256 === null || SHA256.test(claim.previousEventSha256)) ||
    !Number.isSafeInteger(claim.ownerPid) ||
    claim.ownerPid < 1 ||
    typeof claim.ownerHost !== "string" ||
    claim.ownerHost.length === 0 ||
    !SAFE_ID.test(claim.claimId) ||
    typeof claim.claimedAt !== "string" ||
    !Number.isFinite(Date.parse(claim.claimedAt))
  ) {
    fail("malformed-claim");
  }
  return claim;
}

function validateIdentity(input: ClaimIdentity): void {
  if (
    !SAFE_ID.test(input.sourceRunId) ||
    !SAFE_ID.test(input.logicalRunId) ||
    !SAFE_ID.test(input.childRunId) ||
    !SHA256.test(input.sourceRunRecordSha256) ||
    !SHA256.test(input.checkpointSha256) ||
    !Number.isSafeInteger(input.checkpointSequence) ||
    input.checkpointSequence < 1 ||
    !Number.isSafeInteger(input.checkpointAttempt) ||
    input.checkpointAttempt < 1
  ) {
    fail("unsafe-identity");
  }
}

function claimKey(sourceRunId: string, checkpointSha256: string): string {
  return createHash("sha256").update(`${sourceRunId}\0${checkpointSha256}`, "utf8").digest("hex");
}

function eventPath(directory: string, key: string, generation: number): string {
  return join(directory, `${key}.${generation}.json`);
}

function eventDigest(event: AnswerRecordContinuationClaimV1): string {
  return createHash("sha256")
    .update(`${JSON.stringify(event)}\n`, "utf8")
    .digest("hex");
}

function assertPrivateDirectory(stat: Stats, requireMode: boolean): void {
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (requireMode && (stat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE)
  )
    fail("unsafe-root");
}

function assertPrivateFile(stat: Stats): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== PRIVATE_FILE_MODE
  )
    fail("unsafe-entry");
}

function assertSameFile(expected: Stats, actual: Stats): void {
  assertPrivateFile(actual);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) fail("unsafe-entry");
}

async function assertSameDirectory(expected: DirectoryIdentity): Promise<void> {
  await assertSafeOwnedAncestors(expected.ancestors);
  const stat = await lstat(expected.path).catch(() => fail("unsafe-root"));
  assertPrivateDirectory(stat, true);
  if (stat.dev !== expected.dev || stat.ino !== expected.ino || stat.uid !== expected.uid)
    fail("unsafe-root");
}

async function captureSafeOwnedAncestors(path: string): Promise<readonly AncestorIdentity[]> {
  const uid = process.getuid?.();
  if (uid === undefined) fail("unsafe-root");
  let current = dirname(path);
  const filesystemRoot = parse(current).root;
  const ancestors: AncestorIdentity[] = [];
  while (current !== filesystemRoot) {
    const stat = await lstat(current).catch((error: unknown) =>
      isNodeError(error, "ENOENT") ? undefined : Promise.reject(error),
    );
    if (stat) {
      const symbolicLink = stat.isSymbolicLink();
      if (symbolicLink ? !(await isOperatingSystemDirectoryAlias(current)) : !stat.isDirectory())
        fail("unsafe-root");
      ancestors.push({
        path: current,
        dev: stat.dev,
        ino: stat.ino,
        uid: stat.uid,
        mode: stat.mode,
        symbolicLink,
      });
    }
    current = dirname(current);
  }
  return ancestors;
}

async function assertSafeOwnedAncestors(expected: readonly AncestorIdentity[]): Promise<void> {
  for (const ancestor of expected) {
    const stat = await lstat(ancestor.path).catch(() => fail("unsafe-root"));
    if (
      stat.isSymbolicLink() !== ancestor.symbolicLink ||
      (!stat.isSymbolicLink() && !stat.isDirectory()) ||
      stat.dev !== ancestor.dev ||
      stat.ino !== ancestor.ino ||
      stat.uid !== ancestor.uid ||
      stat.mode !== ancestor.mode ||
      (stat.isSymbolicLink() && !(await isOperatingSystemDirectoryAlias(ancestor.path)))
    )
      fail("unsafe-root");
  }
}

async function isOperatingSystemDirectoryAlias(path: string): Promise<boolean> {
  if (process.platform !== "darwin" || (path !== "/var" && path !== "/tmp")) return false;
  const canonical = await realpath(path).catch(() => "");
  return canonical === `/private${path}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code: AnswerRecordContinuationStoreErrorCode): never {
  throw new AnswerRecordContinuationStoreError(code);
}
