// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Storage / lock / journal seam for DocsFab init apply.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, readFileSync } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import {
  DOCSFAB_PROJECT_CONFIG_FILE,
  MAX_CONFIG_BYTES,
  SHA256,
  type DirectoryPin,
  type FileIdentity,
  type InitJournalV1,
  type InitLockLease,
  type InitLockOwner,
  type InitLockOwnerV2,
  type JournalSnapshot,
  type DocsFabInitMutationBoundary,
  type DocsFabInitMutationHooks,
  type LockOwnerSnapshot,
  type StoragePins,
} from "./types.js";
import {
  assertCredentialFree,
  currentUid,
  exactKeys,
  fileIdentity,
  isAlreadyExists,
  isNotFound,
  object,
  sameIdentity,
  sha256,
} from "./shared.js";
import {
  allocatePinnedPrivateRoots,
  captureDirectoryPin,
  verifyPin,
  verifyPins,
} from "./storage-paths.js";
export {
  allocatePinnedPrivateRoots,
  privateLayout,
  assertStorageDisjoint,
  INIT_CONFIGURATION_ROOT_REFUSAL_CODES,
  ConfigurationRootNotCanonicalError,
  configurationRootDisplayPath,
  captureConfigurationRoot,
  verifyConfigurationRoot,
  captureMissingConfigurationAuthority,
  ensureCanonicalDirectoryChain,
  captureOwnedCanonicalAncestor,
  captureOwnedDirectoryChain,
  prependOwnedAncestors,
  ensurePrivateChild,
  captureDirectoryPin,
  captureTrustedDirectoryPin,
  verifyPins,
  verifyPin,
} from "./storage-paths.js";

const PINNED_REPOSITORY_HELPER = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const input = JSON.parse(process.argv[1]);
const sameDirectory = (value, expected) => value.dev === expected.dev && value.ino === expected.ino &&
  value.uid === expected.uid && value.mode === expected.mode;
const sameObject = (value, expected) => value.dev === expected.dev && value.ino === expected.ino &&
  value.uid === expected.uid;
const directory = fs.lstatSync(".");
if (!directory.isDirectory() || !sameDirectory(directory, input.directory)) process.exit(41);
if (input.operation === "sync") {
  const descriptor = fs.openSync(".", fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  process.exit(0);
}
if (input.expectedSource) {
  const source = fs.lstatSync(input.source);
  if (source.isSymbolicLink() || !sameObject(source, input.expectedSource) || source.uid !== input.uid) process.exit(42);
  if (input.expectedSourceSha256 &&
      (source.mode !== input.expectedSource.mode || source.nlink !== input.expectedSource.nlink ||
        source.size !== input.expectedSource.size ||
        crypto.createHash("sha256").update(fs.readFileSync(input.source)).digest("hex") !== input.expectedSourceSha256)) {
    process.exit(48);
  }
}
if (input.destinationMustBeAbsent) {
  try { fs.lstatSync(input.destination); process.exit(46); }
  catch (error) { if (!error || error.code !== "ENOENT") throw error; }
} else if (input.expectedDestination) {
  const destination = fs.lstatSync(input.destination);
  if (destination.isSymbolicLink() || !sameObject(destination, input.expectedDestination) ||
      destination.uid !== input.uid) process.exit(47);
}
if (input.operation === "link") {
  fs.linkSync(input.source, input.destination);
  if (input.expectedSource && !sameObject(fs.lstatSync(input.destination), input.expectedSource)) {
    fs.unlinkSync(input.destination);
    process.exit(44);
  }
} else if (input.operation === "rename") {
  fs.renameSync(input.source, input.destination);
  if (input.expectedSource && !sameObject(fs.lstatSync(input.destination), input.expectedSource)) {
    try { fs.renameSync(input.destination, input.source); } catch {}
    process.exit(45);
  }
}
else if (input.operation === "unlink") fs.unlinkSync(input.source);
else if (input.operation === "rmdir") fs.rmdirSync(input.source);
else process.exit(43);
`;

/**
 * Run one public-name mutation in an isolated helper whose cwd is pinned by
 * the kernel before authority/operand verification. Replacing an ancestor
 * pathname cannot redirect the verified relative operation, and the parent
 * process cwd is never changed.
 */
export function mutateRelativeToPinnedRepository(
  pin: DirectoryPin,
  operation: "link" | "rename" | "unlink" | "rmdir",
  sourcePath: string,
  destinationPath?: string,
  expectedSource?: FileIdentity,
  expectedDestination?: FileIdentity | null,
  expectedSourceSha256?: string,
): void {
  if (
    dirname(sourcePath) !== pin.path ||
    (destinationPath && dirname(destinationPath) !== pin.path)
  ) {
    throw new Error("Initialization publication escaped its pinned repository directory.");
  }
  const source = basename(sourcePath);
  const destination = destinationPath ? basename(destinationPath) : undefined;
  assertInternalPublicationName(source);
  if (destination) assertInternalPublicationName(destination);
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      PINNED_REPOSITORY_HELPER,
      JSON.stringify({
        operation,
        source,
        ...(destination ? { destination } : {}),
        directory: inputDirectoryIdentity(pin.identity),
        ...(expectedSource ? { expectedSource: inputFileIdentity(expectedSource) } : {}),
        ...(expectedDestination === null ? { destinationMustBeAbsent: true } : {}),
        ...(expectedDestination
          ? { expectedDestination: inputFileIdentity(expectedDestination) }
          : {}),
        ...(expectedSourceSha256 ? { expectedSourceSha256 } : {}),
        uid: currentUid(),
      }),
    ],
    {
      cwd: pin.path,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      encoding: "utf8",
      timeout: 5_000,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error("Pinned repository mutation failed at the irreversible operation.");
  }
}

export function syncPinnedRepositoryDirectory(pin: DirectoryPin): void {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      PINNED_REPOSITORY_HELPER,
      JSON.stringify({
        operation: "sync",
        source: DOCSFAB_PROJECT_CONFIG_FILE,
        directory: inputDirectoryIdentity(pin.identity),
        uid: currentUid(),
      }),
    ],
    {
      cwd: pin.path,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      encoding: "utf8",
      timeout: 5_000,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error("Pinned repository directory synchronization failed.");
  }
}

export function assertInternalPublicationName(value: string): void {
  const fixed = [
    DOCSFAB_PROJECT_CONFIG_FILE,
    ".docsfab-init.pending",
    ".docsfab-init.backup",
    ".docsfab-init.conflict",
    "init-journal.json",
    "init-journal.json.pending",
    "init-journal.anchor",
    "init-journal.anchor.pending",
    "init-journal.conflict",
    "init-receipt.json",
    "init-receipt.pending",
    "init-receipt.conflict",
    "init.lock",
    "init.lock.reclaimed",
    "owner.json",
  ];
  if (
    !fixed.includes(value) &&
    !/^init\.lock\.pending-(?:v2-)?[0-9]+-[0-9]+-[a-f0-9]{64}-[a-f0-9-]{36}$/u.test(value)
  ) {
    throw new Error("Initialization publication used an unexpected internal name.");
  }
}

export function inputDirectoryIdentity(
  value: FileIdentity,
): Pick<FileIdentity, "dev" | "ino" | "uid" | "mode"> {
  return { dev: value.dev, ino: value.ino, uid: value.uid, mode: value.mode };
}

export function inputFileIdentity(value: FileIdentity): FileIdentity {
  return { ...value };
}

interface OwnedArtifact {
  bytes: Buffer;
  identity: FileIdentity;
}
type RecoveryArtifact =
  | { kind: "absent" }
  | { kind: "hostile" }
  | { kind: "file"; artifact: OwnedArtifact };

export async function readArtifactForRecovery(path: string): Promise<RecoveryArtifact> {
  try {
    const artifact = await readOwnedArtifact(path, 2);
    return artifact ? { kind: "file", artifact } : { kind: "absent" };
  } catch {
    return { kind: "hostile" };
  }
}

export async function readOwnedArtifact(
  path: string,
  maximumLinks: number,
): Promise<OwnedArtifact | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY |
        (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0),
    );
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.uid !== currentUid() ||
      before.nlink < 1 ||
      before.nlink > maximumLinks ||
      (before.mode & 0o022) !== 0 ||
      before.size <= 0 ||
      before.size > MAX_CONFIG_BYTES
    )
      throw new Error("unsafe");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (
      !sameIdentity(fileIdentity(before), fileIdentity(after)) ||
      !sameIdentity(fileIdentity(after), fileIdentity(pathAfter)) ||
      bytes.byteLength !== after.size
    )
      throw new Error("unsafe");
    return { bytes, identity: fileIdentity(after) };
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function assertArtifactAbsent(path: string, message: string): Promise<void> {
  if (await pathExists(path)) throw new Error(message);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export function sameFileObject(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

export function fileObjectDigest(identity: FileIdentity): string {
  return sha256(
    canonicalizeJsonEvidence({
      dev: identity.dev,
      ino: identity.ino,
      uid: identity.uid,
    } as unknown as JsonEvidenceValue),
  );
}

export async function writeJournal(
  storage: StoragePins,
  journal: InitJournalV1,
  hooks?: DocsFabInitMutationHooks,
): Promise<JournalSnapshot> {
  await assertArtifactAbsent(
    storage.journalPath,
    "An initialization journal already requires recovery.",
  );
  return persistJournal(storage, journal, undefined, hooks);
}

export async function updateJournal(
  storage: StoragePins,
  journal: InitJournalV1,
  expected: JournalSnapshot,
  hooks?: DocsFabInitMutationHooks,
): Promise<JournalSnapshot> {
  return persistJournal(storage, journal, expected, hooks);
}

export async function persistJournal(
  storage: StoragePins,
  journal: InitJournalV1,
  expectedExisting: JournalSnapshot | undefined,
  hooks?: DocsFabInitMutationHooks,
): Promise<JournalSnapshot> {
  assertInitJournal(journal);
  const pending = `${storage.journalPath}.pending`;
  await assertArtifactAbsent(pending, "A pending initialization journal requires recovery.");
  const bytes = Buffer.from(
    canonicalizeJsonEvidence(journal as unknown as JsonEvidenceValue),
    "utf8",
  );
  const handle = await open(
    pending,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0),
    0o600,
  );
  let pendingIdentity: FileIdentity;
  try {
    await afterBoundary(hooks, "journal-created");
    await handle.writeFile(bytes);
    await handle.sync();
    pendingIdentity = fileIdentity(await handle.stat());
    await afterBoundary(hooks, "journal-synced");
  } finally {
    await handle.close();
  }
  await verifyPin(storage.projectRoot);
  const current = await readJournalSnapshot(storage.journalPath);
  const currentAnchor = await readJournalSnapshot(storage.journalAnchorPath);
  if (!sameJournalSnapshot(current, expectedExisting)) {
    throw new Error("The durable initialization journal changed before replacement.");
  }
  if (
    (currentAnchor === undefined) !== (expectedExisting === undefined) ||
    (currentAnchor &&
      expectedExisting &&
      (!sameFileObject(currentAnchor.identity, expectedExisting.identity) ||
        !currentAnchor.bytes.equals(expectedExisting.bytes)))
  ) {
    throw new Error("The durable initialization journal anchor changed before replacement.");
  }
  const anchorPending = `${storage.journalAnchorPath}.pending`;
  await assertArtifactAbsent(
    anchorPending,
    "A pending initialization journal anchor requires recovery.",
  );
  mutateRelativeToPinnedRepository(
    storage.projectRoot,
    "link",
    pending,
    anchorPending,
    pendingIdentity,
    null,
    sha256(bytes),
  );
  const pendingLinked = await readJournalSnapshot(pending);
  const anchorPendingSnapshot = await readJournalSnapshot(anchorPending);
  if (
    !pendingLinked ||
    !anchorPendingSnapshot ||
    !sameFileObject(pendingLinked.identity, pendingIdentity) ||
    !sameFileObject(anchorPendingSnapshot.identity, pendingIdentity) ||
    pendingLinked.identity.nlink !== 2 ||
    anchorPendingSnapshot.identity.nlink !== 2
  ) {
    throw new Error("The durable initialization journal anchor link could not be verified.");
  }
  mutateRelativeToPinnedRepository(
    storage.projectRoot,
    "rename",
    anchorPending,
    storage.journalAnchorPath,
    anchorPendingSnapshot.identity,
    currentAnchor?.identity ?? null,
    anchorPendingSnapshot.sha256,
  );
  mutateRelativeToPinnedRepository(
    storage.projectRoot,
    "rename",
    pending,
    storage.journalPath,
    pendingLinked.identity,
    expectedExisting?.identity ?? null,
    pendingLinked.sha256,
  );
  await afterBoundary(hooks, "journal-renamed");
  const directory = await open(storage.projectRoot.path, fsConstants.O_RDONLY);
  try {
    await syncDirectory(directory);
  } finally {
    await directory.close();
  }
  await afterBoundary(hooks, "journal-directory-synced");
  const published = await readJournalSnapshot(storage.journalPath);
  const publishedAnchor = await readJournalSnapshot(storage.journalAnchorPath);
  if (
    !published ||
    !published.bytes.equals(bytes) ||
    published.sha256 !== sha256(bytes) ||
    !sameFileObject(published.identity, pendingIdentity) ||
    published.identity.mode !== pendingIdentity.mode ||
    published.identity.nlink !== 2 ||
    !publishedAnchor ||
    !publishedAnchor.bytes.equals(bytes) ||
    !sameFileObject(publishedAnchor.identity, pendingIdentity) ||
    publishedAnchor.identity.nlink !== 2
  ) {
    throw new Error("The durable initialization journal failed exact publication verification.");
  }
  return published;
}

export async function finishJournal(
  storage: StoragePins,
  expectedJournal: JournalSnapshot,
  recovering: boolean,
  hooks?: DocsFabInitMutationHooks,
): Promise<boolean> {
  let cleanupRequired = false;
  await verifyPins(storage.pins);
  await verifyPin(storage.projectRoot);
  const journal = await readJournalSnapshot(storage.journalPath);
  if (!sameJournalSnapshot(journal, expectedJournal)) {
    throw new Error(
      "The transaction-bound initialization journal changed before receipt publication.",
    );
  }
  const anchor = await readJournalSnapshot(storage.journalAnchorPath);
  if (
    !anchor ||
    !anchor.bytes.equals(journal!.bytes) ||
    !sameFileObject(anchor.identity, journal!.identity) ||
    anchor.identity.nlink !== journal!.identity.nlink
  ) {
    throw new Error(
      "The transaction-bound initialization journal anchor changed before receipt publication.",
    );
  }
  let previousReceipt: JournalSnapshot | undefined;
  try {
    previousReceipt = await readJournalSnapshot(storage.receiptPath);
  } catch (error) {
    if (!recovering) throw error;
    await quarantinePrivateArtifact(storage, storage.receiptPath, "init-receipt.conflict");
    cleanupRequired = true;
  }
  const receiptAlreadyPublished =
    previousReceipt !== undefined &&
    previousReceipt.bytes.equals(journal!.bytes) &&
    sameFileObject(previousReceipt.identity, journal!.identity);
  const pendingReceipt = resolve(storage.projectRoot.path, "init-receipt.pending");
  if (!receiptAlreadyPublished) {
    if (journalPreimageDigest(previousReceipt) !== journal!.value.previousReceiptPreimageSha256) {
      if (!recovering) {
        throw new Error(
          "The transaction-bound initialization receipt preimage changed before publication.",
        );
      }
      if (previousReceipt) {
        await quarantinePrivateArtifact(storage, storage.receiptPath, "init-receipt.conflict");
        previousReceipt = undefined;
      }
      cleanupRequired = true;
    }
    let pending: JournalSnapshot | undefined;
    try {
      pending = await readJournalSnapshot(pendingReceipt);
    } catch (error) {
      if (!recovering) throw error;
      await quarantinePrivateArtifact(storage, pendingReceipt, "init-receipt.conflict");
      cleanupRequired = true;
    }
    if (
      pending &&
      (!sameFileObject(pending.identity, journal!.identity) ||
        !pending.bytes.equals(journal!.bytes))
    ) {
      throw new Error("The transaction-bound initialization receipt pending file was substituted.");
    }
    if (!pending) {
      mutateRelativeToPinnedRepository(
        storage.projectRoot,
        "link",
        storage.journalPath,
        pendingReceipt,
        journal!.identity,
        null,
        journal!.sha256,
      );
    }
    const linkedJournal = await readJournalSnapshot(storage.journalPath);
    const linkedPending = await readJournalSnapshot(pendingReceipt);
    if (
      !linkedJournal ||
      !linkedPending ||
      !linkedJournal.bytes.equals(expectedJournal.bytes) ||
      !linkedPending.bytes.equals(expectedJournal.bytes) ||
      !sameFileObject(linkedJournal.identity, expectedJournal.identity) ||
      !sameFileObject(linkedPending.identity, expectedJournal.identity) ||
      linkedJournal.identity.nlink !== 3 ||
      linkedPending.identity.nlink !== 3
    ) {
      throw new Error("The transaction-bound initialization receipt link could not be verified.");
    }
    mutateRelativeToPinnedRepository(
      storage.projectRoot,
      "rename",
      pendingReceipt,
      storage.receiptPath,
      linkedPending.identity,
      previousReceipt?.identity ?? null,
      linkedPending.sha256,
    );
    await afterBoundary(hooks, "receipt-renamed");
  }
  const directory = await open(storage.projectRoot.path, fsConstants.O_RDONLY);
  try {
    await syncDirectory(directory);
  } finally {
    await directory.close();
  }
  await afterBoundary(hooks, "receipt-directory-synced");
  const receipt = await readJournalSnapshot(storage.receiptPath);
  const stillLinkedJournal = await readJournalSnapshot(storage.journalPath);
  if (
    !receipt ||
    !stillLinkedJournal ||
    !receipt.bytes.equals(expectedJournal.bytes) ||
    receipt.sha256 !== expectedJournal.sha256 ||
    !sameFileObject(receipt.identity, expectedJournal.identity) ||
    !sameFileObject(stillLinkedJournal.identity, expectedJournal.identity) ||
    receipt.identity.mode !== expectedJournal.identity.mode ||
    receipt.identity.nlink !== 3 ||
    stillLinkedJournal.identity.nlink !== 3
  ) {
    throw new Error(
      "The transaction-bound initialization receipt was substituted after publication.",
    );
  }
  mutateRelativeToPinnedRepository(
    storage.projectRoot,
    "unlink",
    storage.journalPath,
    undefined,
    stillLinkedJournal.identity,
    undefined,
    stillLinkedJournal.sha256,
  );
  const stillLinkedAnchor = await readJournalSnapshot(storage.journalAnchorPath);
  if (
    !stillLinkedAnchor ||
    !sameFileObject(stillLinkedAnchor.identity, expectedJournal.identity) ||
    stillLinkedAnchor.identity.nlink !== 2
  ) {
    throw new Error(
      "The transaction-bound initialization journal anchor changed during receipt commit.",
    );
  }
  mutateRelativeToPinnedRepository(
    storage.projectRoot,
    "unlink",
    storage.journalAnchorPath,
    undefined,
    stillLinkedAnchor.identity,
    undefined,
    stillLinkedAnchor.sha256,
  );
  const finalDirectory = await open(storage.projectRoot.path, fsConstants.O_RDONLY);
  try {
    await syncDirectory(finalDirectory);
  } finally {
    await finalDirectory.close();
  }
  const finalReceipt = await readJournalSnapshot(storage.receiptPath);
  if (
    !finalReceipt ||
    !finalReceipt.bytes.equals(expectedJournal.bytes) ||
    finalReceipt.sha256 !== expectedJournal.sha256 ||
    !sameFileObject(finalReceipt.identity, expectedJournal.identity) ||
    finalReceipt.identity.mode !== expectedJournal.identity.mode ||
    finalReceipt.identity.nlink !== 1
  ) {
    throw new Error(
      "The transaction-bound initialization receipt failed final exact verification.",
    );
  }
  return cleanupRequired;
}

export async function readJournalSnapshot(path: string): Promise<JournalSnapshot | undefined> {
  const artifact = await readOwnedArtifact(path, 4);
  if (!artifact) return undefined;
  let value: unknown;
  try {
    value = parseJsonEvidence(artifact.bytes);
  } catch {
    throw new Error("The durable initialization journal is malformed; recovery stopped safely.");
  }
  assertInitJournal(value);
  const canonical = Buffer.from(
    canonicalizeJsonEvidence(value as unknown as JsonEvidenceValue),
    "utf8",
  );
  if (
    !artifact.bytes.equals(canonical) ||
    artifact.identity.mode !== (fsConstants.S_IFREG | 0o600)
  ) {
    throw new Error(
      "The durable initialization journal is not one exact canonical owner-private file.",
    );
  }
  return {
    value,
    bytes: artifact.bytes,
    identity: artifact.identity,
    sha256: sha256(artifact.bytes),
  };
}

export async function quarantinePrivateArtifact(
  storage: StoragePins,
  path: string,
  conflictName: "init-journal.conflict" | "init-receipt.conflict",
): Promise<void> {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== currentUid() ||
    metadata.nlink < 1 ||
    metadata.nlink > 4 ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("A substituted initialization authority artifact is unsafe to quarantine.");
  }
  const conflict = resolve(storage.projectRoot.path, conflictName);
  await assertArtifactAbsent(
    conflict,
    "An initialization authority conflict already requires cleanup.",
  );
  mutateRelativeToPinnedRepository(
    storage.projectRoot,
    "rename",
    path,
    conflict,
    fileIdentity(metadata),
    null,
  );
  const directory = await open(storage.projectRoot.path, fsConstants.O_RDONLY);
  try {
    await syncDirectory(directory);
  } finally {
    await directory.close();
  }
}

export async function readBoundJournalForRecovery(storage: StoragePins): Promise<{
  snapshot?: JournalSnapshot;
  cleanupRequired: boolean;
}> {
  let cleanupRequired =
    (await pathExists(resolve(storage.projectRoot.path, "init-journal.conflict"))) ||
    (await pathExists(resolve(storage.projectRoot.path, "init-receipt.conflict")));
  let anchor = await readJournalSnapshot(storage.journalAnchorPath);
  let journal: JournalSnapshot | undefined;
  let hostileJournal = false;
  try {
    journal = await readJournalSnapshot(storage.journalPath);
  } catch {
    hostileJournal = true;
  }
  if (!anchor && !journal && !hostileJournal) return { cleanupRequired };
  if (!anchor) {
    throw new Error(
      "The durable initialization journal lost its transaction anchor; recovery stopped safely.",
    );
  }
  if (
    !hostileJournal &&
    journal &&
    sameFileObject(journal.identity, anchor.identity) &&
    journal.bytes.equals(anchor.bytes)
  ) {
    return { snapshot: journal, cleanupRequired };
  }
  const conflict = resolve(storage.projectRoot.path, "init-journal.conflict");
  if (hostileJournal) {
    await quarantinePrivateArtifact(storage, storage.journalPath, "init-journal.conflict");
  } else if (journal) {
    await assertArtifactAbsent(
      conflict,
      "A substituted initialization journal already requires cleanup.",
    );
    mutateRelativeToPinnedRepository(
      storage.projectRoot,
      "rename",
      storage.journalPath,
      conflict,
      journal.identity,
      null,
    );
  }
  mutateRelativeToPinnedRepository(
    storage.projectRoot,
    "link",
    storage.journalAnchorPath,
    storage.journalPath,
    anchor.identity,
    null,
    anchor.sha256,
  );
  const directory = await open(storage.projectRoot.path, fsConstants.O_RDONLY);
  try {
    await syncDirectory(directory);
  } finally {
    await directory.close();
  }
  anchor = await readJournalSnapshot(storage.journalAnchorPath);
  journal = await readJournalSnapshot(storage.journalPath);
  if (
    !anchor ||
    !journal ||
    !sameFileObject(anchor.identity, journal.identity) ||
    !anchor.bytes.equals(journal.bytes)
  ) {
    throw new Error(
      "The transaction-bound initialization journal could not be recovered from its anchor.",
    );
  }
  cleanupRequired = true;
  return { snapshot: journal, cleanupRequired };
}

export function sameJournalSnapshot(
  left: JournalSnapshot | undefined,
  right: JournalSnapshot | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.sha256 === right.sha256 &&
    left.bytes.equals(right.bytes) &&
    sameIdentity(left.identity, right.identity)
  );
}

export function journalPreimageDigest(snapshot: JournalSnapshot | undefined): string {
  return sha256(
    canonicalizeJsonEvidence(
      snapshot
        ? ({
            state: "file",
            bytesSha256: snapshot.sha256,
            metadata: snapshot.identity,
          } as unknown as JsonEvidenceValue)
        : ({ state: "absent" } as unknown as JsonEvidenceValue),
    ),
  );
}

export function assertInitJournal(value: unknown): asserts value is InitJournalV1 {
  if (
    !object(value) ||
    !exactKeys(value, [
      "change",
      "configPreimageSha256",
      "kind",
      "phase",
      "previousReceiptPreimageSha256",
      "repositoryBindingSha256",
      "schemaVersion",
      "targetSha256",
      "temporaryObjectSha256",
      "transactionId",
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== "docsfab-init-journal" ||
    typeof value.transactionId !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(value.transactionId) ||
    typeof value.repositoryBindingSha256 !== "string" ||
    !SHA256.test(value.repositoryBindingSha256) ||
    typeof value.configPreimageSha256 !== "string" ||
    !SHA256.test(value.configPreimageSha256) ||
    typeof value.targetSha256 !== "string" ||
    !SHA256.test(value.targetSha256) ||
    typeof value.temporaryObjectSha256 !== "string" ||
    !SHA256.test(value.temporaryObjectSha256) ||
    typeof value.previousReceiptPreimageSha256 !== "string" ||
    !SHA256.test(value.previousReceiptPreimageSha256) ||
    (value.change !== "create" && value.change !== "update") ||
    (value.phase !== "prepared" &&
      value.phase !== "preimage-detached" &&
      value.phase !== "published")
  ) {
    throw new Error("The durable initialization journal is malformed; recovery stopped safely.");
  }
}

export async function removePrivateJournalOrphan(
  path: string,
  projectRoot: DirectoryPin,
): Promise<void> {
  if (!(await pathExists(path))) return;
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== currentUid() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("A pending initialization journal is unsafe; recovery stopped.");
  }
  await unlink(path);
  const directory = await open(projectRoot.path, fsConstants.O_RDONLY);
  try {
    await syncDirectory(directory);
  } finally {
    await directory.close();
  }
}

export async function removeEmptyOwnedArtifact(pin: DirectoryPin, path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== currentUid() ||
      metadata.nlink !== 1 ||
      metadata.size !== 0 ||
      (metadata.mode & 0o077) !== 0
    )
      return false;
    mutateRelativeToPinnedRepository(pin, "unlink", path, undefined, fileIdentity(metadata));
    return true;
  } catch (error) {
    if (isNotFound(error)) return true;
    throw error;
  }
}

export async function syncDirectory(handle: FileHandle): Promise<void> {
  await handle.sync();
}

export async function afterBoundary(
  hooks: DocsFabInitMutationHooks | undefined,
  boundary: DocsFabInitMutationBoundary,
): Promise<void> {
  await hooks?.afterMutationBoundary?.(boundary);
}

export async function verifyTemporary(handle: FileHandle, expected: Buffer): Promise<void> {
  const metadata = await handle.stat();
  const uid = currentUid();
  if (
    !metadata.isFile() ||
    metadata.uid !== uid ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o777) !== 0o644 ||
    metadata.size !== expected.byteLength
  ) {
    throw new Error("Temporary project configuration could not be secured before publication.");
  }
  const actual = Buffer.alloc(expected.byteLength);
  const read = await handle.read(actual, 0, actual.byteLength, 0);
  if (read.bytesRead !== actual.byteLength || !actual.equals(expected)) {
    throw new Error("Temporary project configuration changed before publication.");
  }
}

const INIT_LOCK_LEASE_MS = 5 * 60 * 1000;

export async function acquireInitLock(
  storage: StoragePins,
  hooks?: DocsFabInitMutationHooks,
): Promise<InitLockLease> {
  await verifyPins(storage.pins);
  await recoverDetachedLockReclaim(storage);
  await recoverPreparedLockClaims(storage);
  await reclaimStaleLockIfSafe(storage, storage.lockPath);
  const issuedAtMs = Date.now();
  const owner: InitLockOwnerV2 = {
    schemaVersion: 2,
    kind: "docsfab-init-lock-owner",
    leaseId: randomUUID(),
    pid: process.pid,
    uid: currentUid(),
    processBirthIdentity: requireProcessBirthIdentity(process.pid),
    issuedAtMs,
    expiresAtMs: issuedAtMs + INIT_LOCK_LEASE_MS,
  };
  const pending = resolve(
    storage.projectRoot.path,
    `init.lock.pending-v2-${owner.expiresAtMs}-${owner.pid}-${owner.processBirthIdentity}-${owner.leaseId}`,
  );
  try {
    await mkdir(pending, { mode: 0o700 });
  } catch (error) {
    throw new Error(
      isAlreadyExists(error)
        ? "Another DocsFab initialization is acquiring the repository lock."
        : "DocsFab could not acquire its owner-private initialization lock.",
    );
  }
  const pendingPin = await captureDirectoryPin(pending, true);
  try {
    await afterBoundary(hooks, "lock-prepared");
    const preparedOwner = await writeLockOwner(pendingPin, owner);
    await afterBoundary(hooks, "lock-owner-synced");
    await verifyPins(storage.pins);
    mutateRelativeToPinnedRepository(
      storage.projectRoot,
      "rename",
      pending,
      storage.lockPath,
      pendingPin.identity,
      null,
    );
    await afterBoundary(hooks, "lock-created");
    const parent = await open(storage.projectRoot.path, fsConstants.O_RDONLY);
    try {
      await syncDirectory(parent);
    } finally {
      await parent.close();
    }
    await afterBoundary(hooks, "lock-parent-synced");
    const directory = await captureDirectoryPin(storage.lockPath, true);
    const finalOwner = await readLockOwnerSnapshot(resolve(storage.lockPath, "owner.json"));
    if (!finalOwner || !sameLockOwnerSnapshot(finalOwner, preparedOwner)) {
      throw new Error("DocsFab initialization lock owner changed during atomic claim.");
    }
    await verifyPins(storage.pins);
    const lease = { directory, owner: finalOwner };
    await verifyLockLease(lease);
    return lease;
  } catch (error) {
    // A renamed lock is intentionally left durable for stale-owner recovery.
    if (await pathExists(pending)) {
      await removeLockDirectoryIfOwned(storage.projectRoot, pendingPin, owner.leaseId).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

export async function releaseInitLock(
  storage: StoragePins,
  lock: InitLockLease,
  hooks?: DocsFabInitMutationHooks,
): Promise<void> {
  await verifyLockLease(lock);
  const ownerPath = resolve(lock.directory.path, "owner.json");
  mutateRelativeToPinnedRepository(
    lock.directory,
    "unlink",
    ownerPath,
    undefined,
    lock.owner.identity,
    undefined,
    lock.owner.sha256,
  );
  await afterBoundary(hooks, "lock-owner-unlinked");
  const lockHandle = await open(lock.directory.path, fsConstants.O_RDONLY);
  try {
    await syncDirectory(lockHandle);
  } finally {
    await lockHandle.close();
  }
  await verifyPin(lock.directory);
  mutateRelativeToPinnedRepository(
    storage.projectRoot,
    "rmdir",
    lock.directory.path,
    undefined,
    lock.directory.identity,
  );
  await afterBoundary(hooks, "lock-removed");
  const parent = await open(storage.projectRoot.path, fsConstants.O_RDONLY);
  try {
    await syncDirectory(parent);
  } finally {
    await parent.close();
  }
  await afterBoundary(hooks, "lock-release-parent-synced");
}

export async function writeLockOwner(
  lock: DirectoryPin,
  owner: InitLockOwnerV2,
): Promise<LockOwnerSnapshot> {
  const path = resolve(lock.path, "owner.json");
  const bytes = Buffer.from(
    canonicalizeJsonEvidence(owner as unknown as JsonEvidenceValue),
    "utf8",
  );
  const handle = await open(
    path,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0),
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await open(lock.path, fsConstants.O_RDONLY);
  try {
    await syncDirectory(directory);
  } finally {
    await directory.close();
  }
  const snapshot = await readLockOwnerSnapshot(path);
  if (!snapshot || !snapshot.bytes.equals(bytes)) {
    throw new Error("DocsFab initialization lock owner failed exact durable verification.");
  }
  return snapshot;
}

export async function readLockOwnerSnapshot(path: string): Promise<LockOwnerSnapshot | undefined> {
  const artifact = await readOwnedArtifact(path, 1);
  if (!artifact) return undefined;
  let value: unknown;
  try {
    value = parseJsonEvidence(artifact.bytes);
  } catch {
    return undefined;
  }
  if (
    !object(value) ||
    !exactKeys(value, [
      "expiresAtMs",
      "issuedAtMs",
      "kind",
      "leaseId",
      "pid",
      "processBirthIdentity",
      "schemaVersion",
      "uid",
    ]) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    value.kind !== "docsfab-init-lock-owner" ||
    typeof value.leaseId !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(value.leaseId) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.uid !== "number" ||
    !Number.isSafeInteger(value.uid) ||
    value.uid < 0 ||
    typeof value.processBirthIdentity !== "string" ||
    !SHA256.test(value.processBirthIdentity) ||
    typeof value.issuedAtMs !== "number" ||
    !Number.isSafeInteger(value.issuedAtMs) ||
    value.issuedAtMs <= 0 ||
    typeof value.expiresAtMs !== "number" ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    value.expiresAtMs < value.issuedAtMs
  )
    return undefined;
  const canonical = Buffer.from(
    canonicalizeJsonEvidence(value as unknown as JsonEvidenceValue),
    "utf8",
  );
  if (!artifact.bytes.equals(canonical) || artifact.identity.mode !== (fsConstants.S_IFREG | 0o600))
    return undefined;
  return {
    value: value as unknown as InitLockOwner,
    bytes: artifact.bytes,
    identity: artifact.identity,
    sha256: sha256(artifact.bytes),
  };
}

export function sameLockOwnerSnapshot(left: LockOwnerSnapshot, right: LockOwnerSnapshot): boolean {
  return (
    left.sha256 === right.sha256 &&
    left.bytes.equals(right.bytes) &&
    sameIdentity(left.identity, right.identity)
  );
}

export async function verifyLockLease(lease: InitLockLease): Promise<void> {
  await verifyPin(lease.directory);
  const current = await readLockOwnerSnapshot(resolve(lease.directory.path, "owner.json"));
  if (
    !current ||
    !sameLockOwnerSnapshot(current, lease.owner) ||
    current.value.schemaVersion !== 2 ||
    lease.owner.value.schemaVersion !== 2 ||
    current.value.leaseId !== lease.owner.value.leaseId ||
    current.value.pid !== process.pid ||
    current.value.uid !== currentUid() ||
    current.value.processBirthIdentity !== requireProcessBirthIdentity(process.pid)
  ) {
    throw new Error("DocsFab initialization lock lease identity changed before use.");
  }
}

const PREPARED_LOCK_V1_PATTERN =
  /^init\.lock\.pending-([0-9]+)-([0-9]+)-([a-f0-9]{64})-([a-f0-9-]{36})$/u;
const PREPARED_LOCK_V2_PATTERN =
  /^init\.lock\.pending-v2-([0-9]+)-([0-9]+)-([a-f0-9]{64})-([a-f0-9-]{36})$/u;

function parsePreparedLockName(name: string):
  | {
      schemaVersion: 1 | 2;
      expiresAtMs: number;
      pid: number;
      processBirthIdentity: string;
      leaseId: string;
    }
  | undefined {
  const versioned = PREPARED_LOCK_V2_PATTERN.exec(name);
  const legacy = versioned ? undefined : PREPARED_LOCK_V1_PATTERN.exec(name);
  const match = versioned ?? legacy;
  if (!match) return undefined;
  return {
    schemaVersion: versioned ? 2 : 1,
    expiresAtMs: Number(match[1]),
    pid: Number(match[2]),
    processBirthIdentity: match[3]!,
    leaseId: match[4]!,
  };
}

export async function recoverPreparedLockClaims(storage: StoragePins): Promise<void> {
  for (const name of await readdir(storage.projectRoot.path)) {
    const prepared = parsePreparedLockName(name);
    if (!prepared) continue;
    const path = resolve(storage.projectRoot.path, name);
    const pin = await captureDirectoryPin(path, true);
    const { schemaVersion, expiresAtMs, pid, processBirthIdentity, leaseId } = prepared;
    if (!Number.isSafeInteger(expiresAtMs) || !Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error("A prepared initialization lock claim has an unsafe attributable name.");
    }
    const names = await readdir(path);
    if (names.length === 0) {
      if (Date.now() > expiresAtMs && leaseProcessIsGoneOrReused(prepared)) {
        mutateRelativeToPinnedRepository(
          storage.projectRoot,
          "rmdir",
          path,
          undefined,
          pin.identity,
        );
        syncPinnedRepositoryDirectory(storage.projectRoot);
      }
      continue;
    }
    if (names.length !== 1 || names[0] !== "owner.json") {
      throw new Error("A prepared initialization lock claim contains unexpected state.");
    }
    const owner = await readLockOwnerSnapshot(resolve(path, "owner.json"));
    if (
      !owner ||
      owner.value.schemaVersion !== schemaVersion ||
      owner.value.leaseId !== leaseId ||
      owner.value.pid !== pid ||
      owner.value.processBirthIdentity !== processBirthIdentity ||
      owner.value.expiresAtMs !== expiresAtMs
    ) {
      throw new Error("A prepared initialization lock claim does not match its attributable name.");
    }
    if (Date.now() > expiresAtMs && leaseProcessIsGoneOrReused(owner.value)) {
      await removeLockDirectoryIfOwned(storage.projectRoot, pin, leaseId);
    }
  }
}

export function requireProcessBirthIdentity(pid: number): string {
  const identity = inspectProcessBirth(pid).identity;
  if (!identity)
    throw new Error("DocsFab could not bind the initialization lease to process birth identity.");
  return identity;
}

export function inspectProcessBirth(pid: number): { alive: boolean; identity?: string } {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Initialization process identity requires a positive safe-integer PID.");
  }
  try {
    if (process.platform === "linux") {
      const statValue = readFileSync(`/proc/${pid}/stat`, "utf8");
      const endCommand = statValue.lastIndexOf(")");
      if (endCommand < 0) return { alive: true };
      const fields = statValue
        .slice(endCommand + 2)
        .trim()
        .split(/\s+/u);
      const startTicks = fields[19];
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (!startTicks || !/^[0-9]+$/u.test(startTicks) || !bootId) return { alive: true };
      return { alive: true, identity: sha256(`linux:${bootId}:${pid}:${startTicks}`) };
    }
    const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      encoding: "utf8",
      timeout: 2_000,
    });
    const started = result.status === 0 ? result.stdout.trim() : "";
    if (started) return { alive: true, identity: sha256(`${process.platform}:${pid}:${started}`) };
  } catch {
    // Fall through to the fail-safe liveness probe below.
  }
  try {
    process.kill(pid, 0);
    return { alive: true };
  } catch (error) {
    return object(error) && error.code === "ESRCH" ? { alive: false } : { alive: true };
  }
}

export async function reclaimStaleLockIfSafe(storage: StoragePins, path: string): Promise<void> {
  if (!(await pathExists(path))) return;
  const pin = await captureDirectoryPin(path, true);
  const names = await readdir(path);
  if (names.length === 0) {
    mutateRelativeToPinnedRepository(storage.projectRoot, "rmdir", path, undefined, pin.identity);
    const parent = await open(storage.projectRoot.path, fsConstants.O_RDONLY);
    try {
      await syncDirectory(parent);
    } finally {
      await parent.close();
    }
    return;
  }
  if (names.length !== 1 || names[0] !== "owner.json") {
    throw new Error("The DocsFab initialization lock contains unexpected recovery state.");
  }
  const owner = await readLockOwnerSnapshot(resolve(path, "owner.json"));
  if (!owner || owner.value.uid !== currentUid()) {
    throw new Error("The DocsFab initialization lock owner metadata is unsafe.");
  }
  if (Date.now() <= owner.value.expiresAtMs || !leaseProcessIsGoneOrReused(owner.value)) {
    throw new Error("Another DocsFab initialization is active for this repository.");
  }
  const reclaimed = `${storage.lockPath}.reclaimed`;
  await assertArtifactAbsent(reclaimed, "A reclaimed initialization lock requires cleanup.");
  mutateRelativeToPinnedRepository(
    storage.projectRoot,
    "rename",
    path,
    reclaimed,
    pin.identity,
    null,
  );
  const reclaimedPin = await captureDirectoryPin(reclaimed, true);
  await removeLockDirectoryIfOwned(storage.projectRoot, reclaimedPin, owner.value.leaseId);
  const parent = await open(storage.projectRoot.path, fsConstants.O_RDONLY);
  try {
    await syncDirectory(parent);
  } finally {
    await parent.close();
  }
}

export function leaseProcessIsGoneOrReused(
  owner: Pick<InitLockOwner, "schemaVersion" | "pid" | "processBirthIdentity">,
): boolean {
  const current = inspectProcessBirth(owner.pid);
  if (!current.alive) return true;
  if (owner.schemaVersion === 1) return false;
  return current.identity !== undefined && current.identity !== owner.processBirthIdentity;
}

export async function recoverDetachedLockReclaim(storage: StoragePins): Promise<void> {
  const path = `${storage.lockPath}.reclaimed`;
  if (!(await pathExists(path))) return;
  const pin = await captureDirectoryPin(path, true);
  await removeLockDirectoryIfOwned(storage.projectRoot, pin);
  const parent = await open(storage.projectRoot.path, fsConstants.O_RDONLY);
  try {
    await syncDirectory(parent);
  } finally {
    await parent.close();
  }
}

export async function removeLockDirectoryIfOwned(
  parent: DirectoryPin,
  lock: DirectoryPin,
  expectedLeaseId?: string,
): Promise<void> {
  await verifyPin(lock);
  const names = await readdir(lock.path);
  if (names.length === 1 && names[0] === "owner.json") {
    const owner = await readLockOwnerSnapshot(resolve(lock.path, "owner.json"));
    if (
      !owner ||
      owner.value.uid !== currentUid() ||
      (expectedLeaseId !== undefined && owner.value.leaseId !== expectedLeaseId)
    ) {
      throw new Error("Reclaimed lock ownership is unsafe.");
    }
    mutateRelativeToPinnedRepository(
      lock,
      "unlink",
      resolve(lock.path, "owner.json"),
      undefined,
      owner.identity,
      undefined,
      owner.sha256,
    );
  } else if (names.length !== 0) {
    throw new Error("Reclaimed lock contains unexpected files.");
  }
  mutateRelativeToPinnedRepository(parent, "rmdir", lock.path, undefined, lock.identity);
}
