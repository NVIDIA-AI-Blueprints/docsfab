// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

import { createContractKit } from "../contract-kit/index.js";
import { isNodeError } from "../shared/primitives.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export type KnowledgeContinuationAttemptPhase =
  | "prepared"
  | "executing"
  | "writer-completed"
  | "delivery-settled"
  | "failed-before-execution"
  | "needs-input-before-execution"
  | "abandoned-before-execution"
  | "recovery-required";

export interface KnowledgeContinuationProcessIdentityV1 {
  pid: number;
  processBirthIdentity: string;
}

export interface KnowledgeContinuationDeliveryResultV1 {
  status: "settled";
  intentSha256: string;
  locator: string | null;
  publisherResultArtifactSha256: string | null;
  publisherIdempotencyKey: string | null;
  resultSha256: string;
}

export interface KnowledgeContinuationAttemptV1 {
  schemaVersion: 1;
  kind: "docsfab-knowledge-continuation-attempt";
  originalRunId: string;
  sequence: number;
  predecessorSha256: string | null;
  attemptId: string;
  childRunId: string;
  snapshotSha256: string;
  deliveryIntentSha256: string;
  owner: KnowledgeContinuationProcessIdentityV1;
  deliveryOwner: KnowledgeContinuationProcessIdentityV1 | null;
  phase: KnowledgeContinuationAttemptPhase;
  childRecordSha256: string | null;
  deliveryResult: KnowledgeContinuationDeliveryResultV1 | null;
  recordedAt: string;
  journalSha256: string;
}

export type KnowledgeContinuationClaimResult =
  | { disposition: "claimed"; attempt: KnowledgeContinuationAttemptV1 }
  | { disposition: "busy"; attempt: KnowledgeContinuationAttemptV1 }
  | { disposition: "already-completed"; attempt: KnowledgeContinuationAttemptV1 }
  | { disposition: "recovery-required"; attempt: KnowledgeContinuationAttemptV1 };

export interface KnowledgeContinuationProcessInspector {
  inspect(pid: number): { alive: boolean; identity?: string };
}

export interface KnowledgeContinuationAttemptStoreOptions {
  /** Deterministic root-swap test seam immediately before the atomic link. */
  beforeLink?: () => void | Promise<void>;
}

interface DirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
  uid: number;
}

export type KnowledgeContinuationStoreErrorCode =
  | "unsafe-root"
  | "unsafe-selector"
  | "unsafe-entry"
  | "malformed-journal"
  | "journal-conflict"
  | "owner-mismatch";

export class KnowledgeContinuationStoreError extends Error {
  public constructor(public readonly code: KnowledgeContinuationStoreErrorCode) {
    super(`Knowledge continuation journal failed: ${code}.`);
    this.name = "KnowledgeContinuationStoreError";
  }
}

const kit = createContractKit({
  fail: (_code) => fail("malformed-journal"),
  inertMode: "strict",
  codes: {
    invalidShape: "malformed-journal",
    invalidValue: "malformed-journal",
    digestMismatch: "malformed-journal",
    credentialMaterial: "malformed-journal",
    schemaMismatch: "migration-required",
  },
});

export class KnowledgeContinuationAttemptStore {
  private readonly root: string;

  public constructor(
    root: string,
    private readonly processes: KnowledgeContinuationProcessInspector,
    private readonly now: () => Date = () => new Date(),
    private readonly options: KnowledgeContinuationAttemptStoreOptions = {},
  ) {
    if (!root || root.includes("\0")) fail("unsafe-root");
    this.root = resolve(root);
  }

  public async claim(input: {
    originalRunId: string;
    snapshotSha256: string;
    deliveryIntentSha256: string;
    childRunId: string;
    owner: KnowledgeContinuationProcessIdentityV1;
    attemptId?: string;
  }): Promise<KnowledgeContinuationClaimResult> {
    validateIdentifier(input.originalRunId);
    validateIdentifier(input.childRunId);
    validateHash(input.snapshotSha256);
    validateHash(input.deliveryIntentSha256);
    validateOwner(input.owner);
    await this.initialize();
    for (;;) {
      const history = await this.read(input.originalRunId);
      const latest = history.at(-1);
      if (latest) {
        const terminal = classifyLatest(latest, this.processes);
        if (terminal === "busy") return { disposition: "busy", attempt: latest };
        if (terminal === "already-completed") {
          return { disposition: "already-completed", attempt: latest };
        }
        if (terminal === "recovery-required") {
          if (latest.phase !== "recovery-required") {
            const uncertain = await this.append({
              ...latest,
              sequence: latest.sequence + 1,
              predecessorSha256: latest.journalSha256,
              phase: "recovery-required",
              recordedAt: this.now().toISOString(),
              journalSha256: "",
            }).catch((error: unknown) => {
              if (isConflict(error)) return undefined;
              throw error;
            });
            if (!uncertain) continue;
            return { disposition: "recovery-required", attempt: uncertain };
          }
          return { disposition: "recovery-required", attempt: latest };
        }
        if (terminal === "abandon-pre-execution") {
          const abandoned = await this.append({
            ...latest,
            sequence: latest.sequence + 1,
            predecessorSha256: latest.journalSha256,
            phase: "abandoned-before-execution",
            recordedAt: this.now().toISOString(),
            journalSha256: "",
          }).catch((error: unknown) => {
            if (isConflict(error)) return undefined;
            throw error;
          });
          if (!abandoned) continue;
          continue;
        }
      }
      // Claim against the exact predecessor just classified. A concurrent
      // append occupies this sequence and forces a full re-read/reclassification.
      const predecessor = latest;
      const sequence = (predecessor?.sequence ?? 0) + 1;
      const attemptId = input.attemptId ?? randomUUID();
      validateIdentifier(attemptId);
      const candidate = await this.append({
        schemaVersion: 1,
        kind: "docsfab-knowledge-continuation-attempt",
        originalRunId: input.originalRunId,
        sequence,
        predecessorSha256: predecessor?.journalSha256 ?? null,
        attemptId,
        childRunId: input.childRunId,
        snapshotSha256: input.snapshotSha256,
        deliveryIntentSha256: input.deliveryIntentSha256,
        owner: { ...input.owner },
        deliveryOwner: null,
        phase: "prepared",
        childRecordSha256: null,
        deliveryResult: null,
        recordedAt: this.now().toISOString(),
        journalSha256: "",
      }).catch((error: unknown) => {
        if (isConflict(error)) return undefined;
        throw error;
      });
      if (!candidate) continue;
      return { disposition: "claimed", attempt: candidate };
    }
  }

  public async transition(input: {
    originalRunId: string;
    attemptId: string;
    owner: KnowledgeContinuationProcessIdentityV1;
    phase: Exclude<KnowledgeContinuationAttemptPhase, "prepared" | "abandoned-before-execution">;
    childRecordSha256?: string;
    deliveryResult?: KnowledgeContinuationDeliveryResultV1;
  }): Promise<KnowledgeContinuationAttemptV1> {
    const history = await this.read(input.originalRunId);
    const latest = history.at(-1);
    if (!latest || latest.attemptId !== input.attemptId) fail("journal-conflict");
    const deliverySettlement =
      latest.phase === "writer-completed" && input.phase === "delivery-settled";
    if (
      !deliverySettlement &&
      (latest.owner.pid !== input.owner.pid ||
        latest.owner.processBirthIdentity !== input.owner.processBirthIdentity)
    )
      fail("owner-mismatch");
    const allowed = allowedTransition(latest.phase, input.phase);
    if (!allowed) fail("journal-conflict");
    const childRecordSha256 = input.childRecordSha256 ?? latest.childRecordSha256;
    if (childRecordSha256 !== null) validateHash(childRecordSha256);
    const deliveryResult = input.deliveryResult ?? latest.deliveryResult;
    if (input.phase === "delivery-settled") {
      validateDeliveryResult(deliveryResult);
      if (deliveryResult.intentSha256 !== latest.deliveryIntentSha256) fail("malformed-journal");
    } else if (input.deliveryResult !== undefined) {
      fail("malformed-journal");
    }
    return this.append({
      ...latest,
      sequence: latest.sequence + 1,
      predecessorSha256: latest.journalSha256,
      phase: input.phase,
      childRecordSha256,
      deliveryOwner: input.phase === "delivery-settled" ? { ...input.owner } : latest.deliveryOwner,
      deliveryResult,
      recordedAt: this.now().toISOString(),
      journalSha256: "",
    });
  }

  public async read(originalRunId: string): Promise<KnowledgeContinuationAttemptV1[]> {
    validateIdentifier(originalRunId);
    const root = await this.initialize();
    const exactName = new RegExp(
      `^${originalRunId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\.[0-9]{12}\\.json$`,
      "u",
    );
    const names = (await readdir(this.root))
      .filter((name) => exactName.test(name))
      .sort((left, right) => sequenceFromName(left) - sequenceFromName(right));
    const records: KnowledgeContinuationAttemptV1[] = [];
    for (const name of names) {
      if (!/^[-A-Za-z0-9._:]+\.[0-9]{12}\.json$/u.test(name)) fail("unsafe-entry");
      records.push(await this.readEntry(join(this.root, name), root));
    }
    for (const [index, record] of records.entries()) {
      if (
        record.originalRunId !== originalRunId ||
        record.sequence !== index + 1 ||
        record.predecessorSha256 !== (index === 0 ? null : records[index - 1]!.journalSha256)
      )
        fail("malformed-journal");
    }
    await assertSameDirectory(root);
    return records;
  }

  private async initialize(): Promise<DirectoryIdentity> {
    await assertSafeOwnedAncestors(this.root);
    const before = await lstat(this.root).catch((error: unknown) =>
      isNodeError(error, "ENOENT") ? undefined : Promise.reject(error),
    );
    if (before?.isSymbolicLink() || (before && !before.isDirectory())) fail("unsafe-root");
    await mkdir(this.root, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await assertSafeOwnedAncestors(this.root);
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        this.root,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      let after = await handle.stat();
      assertPrivateDirectory(after, false);
      const atPath = await lstat(this.root);
      if (atPath.dev !== after.dev || atPath.ino !== after.ino || atPath.isSymbolicLink())
        fail("unsafe-root");
      if ((after.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
        await handle.chmod(PRIVATE_DIRECTORY_MODE);
        after = await handle.stat();
      }
      assertPrivateDirectory(after, true);
      return { path: this.root, dev: after.dev, ino: after.ino, uid: after.uid };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async append(
    value: Omit<KnowledgeContinuationAttemptV1, "journalSha256"> & { journalSha256: string },
  ): Promise<KnowledgeContinuationAttemptV1> {
    const root = await this.initialize();
    const { journalSha256: _ignored, ...body } = value;
    const record = Object.freeze({
      ...body,
      journalSha256: kit.canonicalDigest(body),
    }) as unknown as KnowledgeContinuationAttemptV1;
    decodeAttempt(record);
    const destination = join(
      this.root,
      `${record.originalRunId}.${String(record.sequence).padStart(12, "0")}.json`,
    );
    const temporary = join(this.root, `.${record.originalRunId}.${randomUUID()}.tmp`);
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    try {
      await handle.chmod(PRIVATE_FILE_MODE);
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      const temporaryOpened = await handle.stat();
      assertPrivateFile(temporaryOpened);
      await handle.close();
      const temporaryAtPath = await lstat(temporary);
      if (
        temporaryAtPath.dev !== temporaryOpened.dev ||
        temporaryAtPath.ino !== temporaryOpened.ino ||
        !temporaryAtPath.isFile() ||
        temporaryAtPath.isSymbolicLink() ||
        temporaryAtPath.uid !== temporaryOpened.uid ||
        (temporaryAtPath.mode & 0o777) !== PRIVATE_FILE_MODE
      )
        fail("unsafe-entry");
      await this.options.beforeLink?.();
      await assertSameDirectory(root);
      try {
        await link(temporary, destination);
      } catch (error) {
        if (isNodeError(error, "EEXIST")) fail("journal-conflict");
        throw error;
      }
      await assertSameDirectory(root);
      const destinationStat = await lstat(destination);
      if (
        destinationStat.dev !== temporaryOpened.dev ||
        destinationStat.ino !== temporaryOpened.ino ||
        !destinationStat.isFile() ||
        destinationStat.isSymbolicLink() ||
        destinationStat.uid !== temporaryOpened.uid ||
        (destinationStat.mode & 0o777) !== PRIVATE_FILE_MODE
      )
        fail("unsafe-entry");
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
      return record;
    } finally {
      await handle.close().catch(() => undefined);
      await assertSameDirectory(root)
        .then(() => unlink(temporary))
        .catch(() => undefined);
    }
  }

  private async readEntry(
    path: string,
    root: DirectoryIdentity,
  ): Promise<KnowledgeContinuationAttemptV1> {
    await assertSameDirectory(root);
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== PRIVATE_FILE_MODE
    )
      fail("unsafe-entry");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.uid !== process.getuid?.() ||
        (opened.mode & 0o777) !== PRIVATE_FILE_MODE ||
        opened.dev !== stat.dev ||
        opened.ino !== stat.ino
      )
        fail("unsafe-entry");
      const parsed = JSON.parse(await handle.readFile("utf8")) as unknown;
      await assertSameDirectory(root);
      return decodeAttempt(parsed);
    } catch (error) {
      if (error instanceof KnowledgeContinuationStoreError) throw error;
      fail("malformed-journal");
    } finally {
      await handle.close();
    }
  }
}

export function classifyLatest(
  latest: KnowledgeContinuationAttemptV1,
  processes: KnowledgeContinuationProcessInspector,
): "retry" | "busy" | "already-completed" | "recovery-required" | "abandon-pre-execution" {
  if (latest.phase === "delivery-settled" || latest.phase === "writer-completed")
    return "already-completed";
  if (latest.phase === "recovery-required") return "recovery-required";
  if (
    latest.phase === "failed-before-execution" ||
    latest.phase === "needs-input-before-execution" ||
    latest.phase === "abandoned-before-execution"
  )
    return "retry";
  const current = processes.inspect(latest.owner.pid);
  if (current.alive && current.identity === latest.owner.processBirthIdentity) return "busy";
  if (
    latest.phase === "prepared" &&
    (!current.alive ||
      (current.identity !== undefined && current.identity !== latest.owner.processBirthIdentity))
  )
    return "abandon-pre-execution";
  return "recovery-required";
}

function allowedTransition(
  from: KnowledgeContinuationAttemptPhase,
  to: KnowledgeContinuationAttemptPhase,
): boolean {
  if (from === "prepared")
    return [
      "executing",
      "failed-before-execution",
      "needs-input-before-execution",
      "recovery-required",
    ].includes(to);
  if (from === "executing")
    return [
      "writer-completed",
      "failed-before-execution",
      "needs-input-before-execution",
      "recovery-required",
    ].includes(to);
  if (from === "writer-completed") return to === "delivery-settled";
  return false;
}

function decodeAttempt(value: unknown): KnowledgeContinuationAttemptV1 {
  kit.assertInert(value);
  const record = kit.object(value);
  const keys = [
    "schemaVersion",
    "kind",
    "originalRunId",
    "sequence",
    "predecessorSha256",
    "attemptId",
    "childRunId",
    "snapshotSha256",
    "deliveryIntentSha256",
    "owner",
    "deliveryOwner",
    "phase",
    "childRecordSha256",
    "deliveryResult",
    "recordedAt",
    "journalSha256",
  ];
  kit.exact(record, keys);
  if (record.schemaVersion !== 1 || record.kind !== "docsfab-knowledge-continuation-attempt")
    fail("malformed-journal");
  validateIdentifier(record.originalRunId);
  validateIdentifier(record.attemptId);
  validateIdentifier(record.childRunId);
  if (!Number.isSafeInteger(record.sequence) || (record.sequence as number) < 1)
    fail("malformed-journal");
  if (record.predecessorSha256 !== null) kit.hash(record.predecessorSha256);
  validateHash(record.snapshotSha256);
  validateHash(record.deliveryIntentSha256);
  validateOwner(record.owner);
  if (record.deliveryOwner !== null) validateOwner(record.deliveryOwner);
  kit.enumeration(record.phase, [
    "prepared",
    "executing",
    "writer-completed",
    "delivery-settled",
    "failed-before-execution",
    "needs-input-before-execution",
    "abandoned-before-execution",
    "recovery-required",
  ] as const);
  if (record.childRecordSha256 !== null) kit.hash(record.childRecordSha256);
  if (record.deliveryResult !== null) validateDeliveryResult(record.deliveryResult);
  if (
    (record.phase === "delivery-settled") !== (record.deliveryResult !== null) ||
    (record.phase === "delivery-settled") !== (record.deliveryOwner !== null) ||
    (record.deliveryResult !== null &&
      record.deliveryResult.intentSha256 !== record.deliveryIntentSha256)
  )
    fail("malformed-journal");
  kit.timestamp(record.recordedAt);
  kit.hash(record.journalSha256);
  const { journalSha256, ...body } = record;
  if (journalSha256 !== kit.canonicalDigest(body)) fail("malformed-journal");
  return Object.freeze(structuredClone(record)) as unknown as KnowledgeContinuationAttemptV1;
}
function validateDeliveryResult(
  value: unknown,
): asserts value is KnowledgeContinuationDeliveryResultV1 {
  const result = kit.object(value);
  kit.exact(result, [
    "status",
    "intentSha256",
    "locator",
    "publisherResultArtifactSha256",
    "publisherIdempotencyKey",
    "resultSha256",
  ]);
  if (result.status !== "settled") fail("malformed-journal");
  kit.hash(result.intentSha256);
  if (
    result.locator !== null &&
    (typeof result.locator !== "string" ||
      result.locator.length === 0 ||
      result.locator.includes("\0"))
  )
    fail("malformed-journal");
  if (result.publisherResultArtifactSha256 !== null) kit.hash(result.publisherResultArtifactSha256);
  if (result.publisherIdempotencyKey !== null) kit.hash(result.publisherIdempotencyKey);
  if (
    (result.locator === null) !== (result.publisherResultArtifactSha256 === null) ||
    (result.locator === null) !== (result.publisherIdempotencyKey === null)
  )
    fail("malformed-journal");
  kit.hash(result.resultSha256);
  const { resultSha256, ...body } = result;
  if (resultSha256 !== kit.canonicalDigest(body)) fail("malformed-journal");
}

function validateIdentifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail("unsafe-selector");
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
async function assertSameDirectory(expected: DirectoryIdentity): Promise<void> {
  await assertSafeOwnedAncestors(expected.path);
  const stat = await lstat(expected.path).catch(() => fail("unsafe-root"));
  assertPrivateDirectory(stat, true);
  if (stat.dev !== expected.dev || stat.ino !== expected.ino || stat.uid !== expected.uid)
    fail("unsafe-root");
}
async function assertSafeOwnedAncestors(path: string): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) fail("unsafe-root");
  let current = dirname(path);
  const filesystemRoot = parse(current).root;
  while (current !== filesystemRoot) {
    const stat = await lstat(current).catch((error: unknown) =>
      isNodeError(error, "ENOENT") ? undefined : Promise.reject(error),
    );
    if (stat) {
      if (stat.isSymbolicLink()) {
        if (!isDarwinSystemAlias(current, stat.uid)) fail("unsafe-root");
      } else if (!stat.isDirectory()) {
        fail("unsafe-root");
      }
    }
    current = dirname(current);
  }
}
function isDarwinSystemAlias(path: string, uid: number): boolean {
  return process.platform === "darwin" && uid === 0 && (path === "/tmp" || path === "/var");
}
function validateHash(value: unknown): asserts value is string {
  kit.hash(value);
}
function validateOwner(value: unknown): asserts value is KnowledgeContinuationProcessIdentityV1 {
  const owner = kit.object(value);
  kit.exact(owner, ["pid", "processBirthIdentity"]);
  if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) < 1) fail("malformed-journal");
  kit.hash(owner.processBirthIdentity);
}
function sequenceFromName(name: string): number {
  const match = /\.([0-9]{12})\.json$/u.exec(name);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}
function isConflict(error: unknown): boolean {
  return error instanceof KnowledgeContinuationStoreError && error.code === "journal-conflict";
}
function fail(code: KnowledgeContinuationStoreErrorCode): never {
  throw new KnowledgeContinuationStoreError(code);
}
