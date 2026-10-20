// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Transactional apply / recovery / lock seam for DocsFab init.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, readFileSync, type Stats } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import {
  DOCSFAB_PROJECT_CONFIG_FILE,
  MAX_CONFIG_BYTES,
  SHA256,
  type ApplyResult,
  type ConfigurationRootSnapshot,
  type DirectoryPin,
  type ExistingConfig,
  type FileIdentity,
  type InitJournalV1,
  type InitLockLease,
  type InitLockOwnerV1,
  type JournalSnapshot,
  type DocsFabInitMutationBoundary,
  type DocsFabInitMutationHooks,
  type DocsFabPrivateRoots,
  type DocsFabProjectConfigV1,
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
  normalizedAbsolute,
  object,
  pathsOverlap,
  sameDirectoryIdentity,
  sameIdentity,
  sha256,
} from "./shared.js";
import { assertDocsFabProjectConfig } from "./project-config.js";
import {
  acquireInitLock,
  afterBoundary,
  allocatePinnedPrivateRoots,
  assertArtifactAbsent,
  assertStorageDisjoint,
  captureConfigurationRoot,
  captureOwnedDirectoryChain,
  fileObjectDigest,
  finishJournal,
  journalPreimageDigest,
  mutateRelativeToPinnedRepository,
  pathExists,
  readArtifactForRecovery,
  readBoundJournalForRecovery,
  readJournalSnapshot,
  readOwnedArtifact,
  releaseInitLock,
  removeEmptyOwnedArtifact,
  removePrivateJournalOrphan,
  sameFileObject,
  syncPinnedRepositoryDirectory,
  updateJournal,
  verifyConfigurationRoot,
  verifyLockLease,
  verifyPin,
  verifyPins,
  verifyTemporary,
  writeJournal,
} from "./storage.js";

export async function applyInitialization(input: {
  repositoryPath: string;
  configRoot: string;
  environment: NodeJS.ProcessEnv;
  /** The home the preview used; the refusal message names the root relative to it. */
  homeDirectory: string;
  roots: DocsFabPrivateRoots;
  projectConfig: DocsFabProjectConfigV1;
  expectedConfig: ExistingConfig;
  repositoryBindingSha256: string;
  revalidateApproval(): Promise<void>;
  revalidateRepositoryApproval(): Promise<void>;
  hooks?: DocsFabInitMutationHooks;
}): Promise<ApplyResult> {
  const repositoryPins = await captureOwnedDirectoryChain(input.repositoryPath);
  const repositoryPin = repositoryPins.at(-1)!;
  const configurationRoot = await captureConfigurationRoot(
    input.configRoot,
    input.homeDirectory,
    input.environment,
  );
  assertStorageDisjoint(input.repositoryPath, configurationRoot.path, input.roots);
  const storage = await allocatePinnedPrivateRoots(
    input.roots,
    input.repositoryPath,
    configurationRoot.path,
  );
  const repositoryHandle = await open(repositoryPin.path, fsConstants.O_RDONLY);
  let cleanupRequired = false;
  let changed = false;
  let needsPublication = false;
  let primaryError: unknown;
  try {
    storage.lock = await acquireInitLock(storage, input.hooks);
    await verifyPins([
      ...repositoryPins,
      ...storage.pins,
      storage.lock.directory,
      ...configurationRoot.pins,
    ]);
    await verifyLockLease(storage.lock);
    await verifyConfigurationRoot(configurationRoot);
    await input.hooks?.afterLockAcquired?.();
    await verifyPins([
      ...repositoryPins,
      ...storage.pins,
      storage.lock.directory,
      ...configurationRoot.pins,
    ]);
    await verifyLockLease(storage.lock);
    await verifyDirectoryHandle(repositoryHandle, repositoryPin);
    await verifyConfigurationRoot(configurationRoot);
    await input.revalidateApproval();
    cleanupRequired = await recoverInterruptedInitialization({
      repositoryPin,
      repositoryHandle,
      repositoryPins,
      storage,
      configurationRoot,
      repositoryBindingSha256: input.repositoryBindingSha256,
      hooks: input.hooks,
    });
    const postRecoveryConfig = await readExistingConfig(input.repositoryPath);
    const targetBytes = projectConfigBytes(input.projectConfig);
    const recoveredChange = !sameConfigSnapshot(postRecoveryConfig, input.expectedConfig);
    if (postRecoveryConfig.state === "file" && postRecoveryConfig.bytes!.equals(targetBytes)) {
      changed = recoveredChange;
    } else {
      if (!sameConfigSnapshot(postRecoveryConfig, input.expectedConfig)) {
        throw new Error(
          "Recovery changed the project configuration outside the approved target state.",
        );
      }
      needsPublication =
        input.expectedConfig.state === "absent" ||
        !projectConfigBytes(input.expectedConfig.value!).equals(targetBytes);
      changed = needsPublication;
    }
    if (needsPublication) {
      cleanupRequired =
        (await publishProjectConfig({
          repositoryPin,
          repositoryHandle,
          repositoryPins,
          storage,
          configurationRoot,
          config: input.projectConfig,
          expected: input.expectedConfig,
          repositoryBindingSha256: input.repositoryBindingSha256,
          revalidateRepositoryApproval: input.revalidateRepositoryApproval,
          hooks: input.hooks,
        })) || cleanupRequired;
    }
    try {
      await input.hooks?.afterConfigPublished?.();
    } catch {
      cleanupRequired = true;
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (storage.lock) {
      try {
        await releaseInitLock(storage, storage.lock, input.hooks);
      } catch (releaseError) {
        cleanupRequired = true;
        if (primaryError !== undefined) {
          primaryError = new AggregateError(
            [primaryError, releaseError],
            "Initialization and lock release both failed.",
          );
        }
      }
    }
    await repositoryHandle.close().catch((closeError) => {
      cleanupRequired = true;
      if (primaryError === undefined) primaryError = closeError;
    });
  }
  if (primaryError !== undefined) throw primaryError;
  return { configChanged: changed, cleanupRequired };
}

export async function publishProjectConfig(input: {
  repositoryPin: DirectoryPin;
  repositoryHandle: FileHandle;
  repositoryPins: DirectoryPin[];
  storage: StoragePins;
  configurationRoot: ConfigurationRootSnapshot;
  config: DocsFabProjectConfigV1;
  expected: ExistingConfig;
  repositoryBindingSha256: string;
  revalidateRepositoryApproval(): Promise<void>;
  hooks?: DocsFabInitMutationHooks;
}): Promise<boolean> {
  const configPath = resolve(input.repositoryPin.path, DOCSFAB_PROJECT_CONFIG_FILE);
  const temporary = resolve(input.repositoryPin.path, ".docsfab-init.pending");
  const backup = resolve(input.repositoryPin.path, ".docsfab-init.backup");
  await assertExpectedConfig(configPath, input.expected);
  const bytes = projectConfigBytes(input.config);
  await assertArtifactAbsent(temporary, "A stale initialization temporary file requires recovery.");
  await assertArtifactAbsent(backup, "A stale initialization backup requires recovery.");
  let handle: FileHandle | undefined;
  let cleanupRequired = false;
  try {
    handle = await open(
      temporary,
      fsConstants.O_RDWR |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0),
      0o600,
    );
    await afterBoundary(input.hooks, "temporary-created");
    await handle.writeFile(bytes);
    await (input.hooks?.configureTemporary
      ? input.hooks.configureTemporary(handle)
      : handle.chmod(0o644));
    await handle.sync();
    await afterBoundary(input.hooks, "temporary-synced");
    await verifyTemporary(handle, bytes);
    syncPinnedRepositoryDirectory(input.repositoryPin);
    await afterBoundary(input.hooks, "temporary-directory-synced");

    const temporaryIdentity = fileIdentity(await handle.stat());
    const previousReceipt = await readJournalSnapshot(input.storage.receiptPath);
    const journal: InitJournalV1 = {
      schemaVersion: 1,
      kind: "docsfab-init-journal",
      transactionId: randomUUID(),
      repositoryBindingSha256: input.repositoryBindingSha256,
      configPreimageSha256: input.expected.preimageSha256,
      targetSha256: sha256(bytes),
      temporaryObjectSha256: fileObjectDigest(temporaryIdentity),
      previousReceiptPreimageSha256: journalPreimageDigest(previousReceipt),
      change: input.expected.state === "absent" ? "create" : "update",
      phase: "prepared",
    };
    let journalSnapshot = await writeJournal(input.storage, journal, input.hooks);
    await input.hooks?.beforeConfigCommit?.();
    await verifyMutationAuthority(input, handle, temporary);
    await assertExpectedConfig(configPath, input.expected);
    await input.hooks?.atConfigPublication?.();
    await verifyMutationAuthority(input, handle, temporary);
    await input.revalidateRepositoryApproval();
    await verifyMutationAuthority(input, handle, temporary);
    await assertExpectedConfig(configPath, input.expected);
    if (input.expected.state === "file") {
      try {
        mutateRelativeToPinnedRepository(
          input.repositoryPin,
          "rename",
          configPath,
          backup,
          input.expected.identity,
        );
      } catch {
        throw new Error(
          "Project configuration changed at commit; the approved update was not published.",
        );
      }
      await afterBoundary(input.hooks, "preimage-renamed");
      syncPinnedRepositoryDirectory(input.repositoryPin);
      await afterBoundary(input.hooks, "preimage-directory-synced");
      const detached = await readConfigAt(backup);
      if (!sameConfigSnapshot(detached, input.expected)) {
        await restoreDetachedConfig(
          input.repositoryPin,
          backup,
          configPath,
          input.expected.identity,
        );
        throw new Error(
          "Project configuration changed at commit; the concurrent value was preserved.",
        );
      }
      journalSnapshot = await updateJournal(
        input.storage,
        { ...journal, phase: "preimage-detached" },
        journalSnapshot,
        input.hooks,
      );
    }
    await verifyMutationAuthority(input, handle, temporary);
    try {
      mutateRelativeToPinnedRepository(
        input.repositoryPin,
        "link",
        temporary,
        configPath,
        temporaryIdentity,
      );
    } catch (error) {
      if (input.expected.state === "file") {
        await quarantinePublicAndRestorePreimage(input.repositoryPin, backup, configPath);
      }
      throw new Error(
        isAlreadyExists(error)
          ? "Project configuration was concurrently recreated; the hostile public state was removed."
          : "Project configuration publication failed; the approved preimage was restored.",
      );
    }
    await afterBoundary(input.hooks, "config-linked");
    syncPinnedRepositoryDirectory(input.repositoryPin);
    await afterBoundary(input.hooks, "config-directory-synced");
    journalSnapshot = await updateJournal(
      input.storage,
      { ...journal, phase: "published" },
      journalSnapshot,
      input.hooks,
    );
    const finalLinked = await readOwnedArtifact(configPath, 2);
    if (
      !finalLinked ||
      sha256(finalLinked.bytes) !== journal.targetSha256 ||
      !sameFileObject(finalLinked.identity, fileIdentity(await handle.stat()))
    ) {
      cleanupRequired = true;
      await recoverInterruptedInitialization(input);
      return true;
    }
    mutateRelativeToPinnedRepository(
      input.repositoryPin,
      "unlink",
      temporary,
      undefined,
      temporaryIdentity,
    );
    await afterBoundary(input.hooks, "temporary-unlinked");
    syncPinnedRepositoryDirectory(input.repositoryPin);
    await afterBoundary(input.hooks, "temporary-unlink-directory-synced");
    if (input.expected.state === "file") {
      mutateRelativeToPinnedRepository(
        input.repositoryPin,
        "unlink",
        backup,
        undefined,
        input.expected.identity,
      );
      await afterBoundary(input.hooks, "backup-unlinked");
      syncPinnedRepositoryDirectory(input.repositoryPin);
      await afterBoundary(input.hooks, "backup-unlink-directory-synced");
    }
    await finishJournal(input.storage, journalSnapshot, false, input.hooks);
    const final = await readConfigAt(configPath);
    if (
      !final.bytes?.equals(bytes) ||
      !final.identity ||
      final.identity.nlink !== 1 ||
      (final.identity.mode & 0o777) !== 0o644
    )
      cleanupRequired = true;
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error("Project configuration publication failed before commit.");
  } finally {
    await handle?.close().catch(() => {
      cleanupRequired = true;
    });
  }
  return cleanupRequired;
}

export async function restoreDetachedConfig(
  repositoryPin: DirectoryPin,
  backup: string,
  configPath: string,
  expected?: FileIdentity,
): Promise<void> {
  try {
    mutateRelativeToPinnedRepository(repositoryPin, "link", backup, configPath, expected);
  } catch {
    // A concurrent value owns the public name; keep the detached value as recovery evidence.
    return;
  }
  mutateRelativeToPinnedRepository(repositoryPin, "unlink", backup, undefined, expected);
  syncPinnedRepositoryDirectory(repositoryPin);
}

interface RecoveryInput {
  repositoryPin: DirectoryPin;
  repositoryHandle: FileHandle;
  repositoryPins: DirectoryPin[];
  storage: StoragePins;
  configurationRoot: ConfigurationRootSnapshot;
  repositoryBindingSha256: string;
  hooks?: DocsFabInitMutationHooks;
}

export async function recoverInterruptedInitialization(input: RecoveryInput): Promise<boolean> {
  await verifyRecoveryAuthority(input);
  const configPath = resolve(input.repositoryPin.path, DOCSFAB_PROJECT_CONFIG_FILE);
  const temporary = resolve(input.repositoryPin.path, ".docsfab-init.pending");
  const backup = resolve(input.repositoryPin.path, ".docsfab-init.backup");
  const conflict = resolve(input.repositoryPin.path, ".docsfab-init.conflict");
  await removePrivateJournalOrphan(
    `${input.storage.journalPath}.pending`,
    input.storage.projectRoot,
  );
  await removePrivateJournalOrphan(
    `${input.storage.journalAnchorPath}.pending`,
    input.storage.projectRoot,
  );
  const boundJournal = await readBoundJournalForRecovery(input.storage);
  const journalSnapshot = boundJournal.snapshot;
  if (!journalSnapshot)
    return recoverOrphanedArtifacts(input, configPath, temporary, backup, conflict);
  const journal = journalSnapshot.value;
  if (journal.repositoryBindingSha256 !== input.repositoryBindingSha256) {
    const publicState = await readOwnedArtifact(configPath, 2);
    const backupState = await readOwnedArtifact(backup, 1);
    if (
      !publicState &&
      backupState &&
      configPreimageDigest("file", backupState.bytes, backupState.identity) ===
        journal.configPreimageSha256
    ) {
      mutateRelativeToPinnedRepository(
        input.repositoryPin,
        "rename",
        backup,
        configPath,
        backupState.identity,
      );
      syncPinnedRepositoryDirectory(input.repositoryPin);
    }
    throw new Error(
      "An interrupted initialization belongs to a different repository identity; recovery stopped safely.",
    );
  }

  let publicState = await readArtifactForRecovery(configPath);
  let pendingState = await readArtifactForRecovery(temporary);
  const backupState = await readArtifactForRecovery(backup);
  const backupIsPreimage =
    backupState.kind === "file" &&
    configPreimageDigest("file", backupState.artifact.bytes, backupState.artifact.identity) ===
      journal.configPreimageSha256;
  if (backupState.kind === "file" && !backupIsPreimage) {
    throw new Error("Interrupted initialization backup does not match the approved preimage.");
  }
  let cleanupRequired = boundJournal.cleanupRequired || (await pathExists(conflict));
  const publicIsTarget =
    publicState.kind === "file" &&
    sha256(publicState.artifact.bytes) === journal.targetSha256 &&
    fileObjectDigest(publicState.artifact.identity) === journal.temporaryObjectSha256;
  const pendingIsTarget =
    pendingState.kind === "file" &&
    sha256(pendingState.artifact.bytes) === journal.targetSha256 &&
    fileObjectDigest(pendingState.artifact.identity) === journal.temporaryObjectSha256;

  if (!publicIsTarget) {
    if (publicState.kind !== "absent") {
      await assertArtifactAbsent(
        conflict,
        "Interrupted initialization has an unresolved conflict artifact.",
      );
      mutateRelativeToPinnedRepository(input.repositoryPin, "rename", configPath, conflict);
      syncPinnedRepositoryDirectory(input.repositoryPin);
      cleanupRequired = true;
      publicState = { kind: "absent" };
    }
    if (pendingState.kind === "file" && pendingIsTarget) {
      await verifyRecoveryAuthority(input);
      mutateRelativeToPinnedRepository(
        input.repositoryPin,
        "link",
        temporary,
        configPath,
        pendingState.artifact.identity,
      );
      await afterBoundary(input.hooks, "config-linked");
      syncPinnedRepositoryDirectory(input.repositoryPin);
      await afterBoundary(input.hooks, "config-directory-synced");
      publicState = await readArtifactForRecovery(configPath);
    } else if (backupState.kind === "file" && backupIsPreimage) {
      await verifyRecoveryAuthority(input);
      mutateRelativeToPinnedRepository(
        input.repositoryPin,
        "rename",
        backup,
        configPath,
        backupState.artifact.identity,
      );
      syncPinnedRepositoryDirectory(input.repositoryPin);
      cleanupRequired =
        (await finishJournal(input.storage, journalSnapshot, true, input.hooks)) || cleanupRequired;
      return cleanupRequired;
    } else {
      throw new Error(
        "Interrupted initialization cannot be recovered automatically; cleanup is required.",
      );
    }
  }

  if (
    publicState.kind !== "file" ||
    sha256(publicState.artifact.bytes) !== journal.targetSha256 ||
    fileObjectDigest(publicState.artifact.identity) !== journal.temporaryObjectSha256
  ) {
    throw new Error(
      "Interrupted initialization recovery did not restore the approved configuration.",
    );
  }
  pendingState = await readArtifactForRecovery(temporary);
  if (pendingState.kind === "file") {
    if (
      sha256(pendingState.artifact.bytes) !== journal.targetSha256 ||
      fileObjectDigest(pendingState.artifact.identity) !== journal.temporaryObjectSha256
    ) {
      throw new Error("Interrupted initialization temporary file is hostile; cleanup is required.");
    }
    mutateRelativeToPinnedRepository(
      input.repositoryPin,
      "unlink",
      temporary,
      undefined,
      pendingState.artifact.identity,
    );
    await afterBoundary(input.hooks, "temporary-unlinked");
    syncPinnedRepositoryDirectory(input.repositoryPin);
    await afterBoundary(input.hooks, "temporary-unlink-directory-synced");
  } else if (pendingState.kind === "hostile") {
    throw new Error("Interrupted initialization temporary file is hostile; cleanup is required.");
  }
  if (backupState.kind === "file") {
    mutateRelativeToPinnedRepository(
      input.repositoryPin,
      "unlink",
      backup,
      undefined,
      backupState.artifact.identity,
    );
    await afterBoundary(input.hooks, "backup-unlinked");
    syncPinnedRepositoryDirectory(input.repositoryPin);
    await afterBoundary(input.hooks, "backup-unlink-directory-synced");
  } else if (backupState.kind === "hostile") {
    throw new Error("Interrupted initialization backup is hostile; cleanup is required.");
  }
  cleanupRequired =
    (await finishJournal(input.storage, journalSnapshot, true, input.hooks)) || cleanupRequired;
  return cleanupRequired;
}

export async function recoverOrphanedArtifacts(
  input: RecoveryInput,
  configPath: string,
  temporary: string,
  backup: string,
  conflict: string,
): Promise<boolean> {
  let cleanupRequired = await pathExists(conflict);
  const publicState = await readArtifactForRecovery(configPath);
  const pendingState = await readArtifactForRecovery(temporary);
  const backupState = await readArtifactForRecovery(backup);
  if (pendingState.kind === "file") {
    if (
      publicState.kind === "file" &&
      sameFileObject(publicState.artifact.identity, pendingState.artifact.identity)
    ) {
      mutateRelativeToPinnedRepository(
        input.repositoryPin,
        "unlink",
        temporary,
        undefined,
        pendingState.artifact.identity,
      );
      syncPinnedRepositoryDirectory(input.repositoryPin);
    } else {
      mutateRelativeToPinnedRepository(
        input.repositoryPin,
        "unlink",
        temporary,
        undefined,
        pendingState.artifact.identity,
      );
      syncPinnedRepositoryDirectory(input.repositoryPin);
    }
  } else if (pendingState.kind === "hostile") {
    if (await removeEmptyOwnedArtifact(input.repositoryPin, temporary))
      syncPinnedRepositoryDirectory(input.repositoryPin);
    else throw new Error("A hostile initialization temporary artifact requires manual cleanup.");
  }
  if (backupState.kind === "file") {
    if (publicState.kind === "absent") {
      mutateRelativeToPinnedRepository(
        input.repositoryPin,
        "rename",
        backup,
        configPath,
        backupState.artifact.identity,
      );
      syncPinnedRepositoryDirectory(input.repositoryPin);
    } else if (
      publicState.kind === "file" &&
      publicState.artifact.bytes.equals(backupState.artifact.bytes)
    ) {
      mutateRelativeToPinnedRepository(
        input.repositoryPin,
        "unlink",
        backup,
        undefined,
        backupState.artifact.identity,
      );
      syncPinnedRepositoryDirectory(input.repositoryPin);
    } else {
      cleanupRequired = true;
    }
  } else if (backupState.kind === "hostile") {
    throw new Error("A hostile initialization backup artifact requires manual cleanup.");
  }
  return cleanupRequired;
}

export async function quarantinePublicAndRestorePreimage(
  repositoryPin: DirectoryPin,
  backup: string,
  configPath: string,
): Promise<void> {
  const conflict = resolve(repositoryPin.path, ".docsfab-init.conflict");
  if (await pathExists(configPath)) {
    await assertArtifactAbsent(
      conflict,
      "A project configuration conflict already requires cleanup.",
    );
    mutateRelativeToPinnedRepository(repositoryPin, "rename", configPath, conflict);
    syncPinnedRepositoryDirectory(repositoryPin);
  }
  if (await pathExists(backup)) {
    const backupState = await readOwnedArtifact(backup, 1);
    if (!backupState) throw new Error("The approved preimage backup became unavailable.");
    mutateRelativeToPinnedRepository(
      repositoryPin,
      "rename",
      backup,
      configPath,
      backupState.identity,
    );
    syncPinnedRepositoryDirectory(repositoryPin);
  }
}

export async function verifyMutationAuthority(
  input: RecoveryInput,
  temporaryHandle: FileHandle,
  temporaryPath: string,
): Promise<void> {
  await verifyRecoveryAuthority(input);
  const pathMetadata = await lstat(temporaryPath);
  const handleMetadata = await temporaryHandle.stat();
  if (
    !sameIdentity(fileIdentity(pathMetadata), fileIdentity(handleMetadata)) ||
    pathMetadata.isSymbolicLink()
  ) {
    throw new Error("The initialization temporary pathname was substituted before commit.");
  }
}

export async function verifyRecoveryAuthority(input: RecoveryInput): Promise<void> {
  await verifyPins([
    ...input.repositoryPins,
    ...input.storage.pins,
    input.storage.lock!.directory,
    ...input.configurationRoot.pins,
  ]);
  await verifyLockLease(input.storage.lock!);
  await verifyDirectoryHandle(input.repositoryHandle, input.repositoryPin);
  await verifyConfigurationRoot(input.configurationRoot);
}

export async function verifyDirectoryHandle(handle: FileHandle, pin: DirectoryPin): Promise<void> {
  const metadata = await handle.stat();
  if (!metadata.isDirectory() || !sameDirectoryIdentity(fileIdentity(metadata), pin.identity)) {
    throw new Error("A pinned initialization directory handle changed before commit.");
  }
  await verifyPin(pin);
}

export async function readExistingConfig(repositoryPath: string): Promise<ExistingConfig> {
  return readConfigAt(resolve(repositoryPath, DOCSFAB_PROJECT_CONFIG_FILE), true);
}

export async function readConfigAt(
  path: string,
  allowInterruptedLink = false,
): Promise<ExistingConfig> {
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
      (before.nlink !== 1 && !(allowInterruptedLink && before.nlink === 2)) ||
      (before.mode & 0o022) !== 0 ||
      before.size <= 0 ||
      before.size > MAX_CONFIG_BYTES
    ) {
      throw new Error("unsafe");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      !sameIdentity(fileIdentity(before), fileIdentity(after)) ||
      !sameIdentity(fileIdentity(after), fileIdentity(pathAfter)) ||
      bytes.byteLength !== after.size
    )
      throw new Error("unsafe");
    if (after.nlink === 2) {
      const pending = await readOwnedArtifact(resolve(dirname(path), ".docsfab-init.pending"), 2);
      if (!pending || !sameFileObject(pending.identity, fileIdentity(after)))
        throw new Error("unsafe");
    }
    const value = parseJsonEvidence(bytes);
    assertDocsFabProjectConfig(value);
    const identity = fileIdentity(after);
    return {
      state: "file",
      preimageSha256: configPreimageDigest("file", bytes, identity),
      value,
      bytes,
      identity,
    };
  } catch (error) {
    if (isNotFound(error))
      return { state: "absent", preimageSha256: configPreimageDigest("absent") };
    if (
      error instanceof Error &&
      (error.message.startsWith("Existing DocsFab") ||
        error.message.includes("forbidden credential"))
    )
      throw error;
    throw new Error(
      "Existing DocsFab project configuration is unsafe or unreadable; no project file was changed.",
    );
  } finally {
    await handle?.close();
  }
}

export async function assertExpectedConfig(path: string, expected: ExistingConfig): Promise<void> {
  const current = await readConfigAt(path);
  if (!sameConfigSnapshot(current, expected)) {
    throw new Error(
      "DocsFab project configuration changed after preview; the approved project file was not written.",
    );
  }
}

export function sameConfigSnapshot(left: ExistingConfig, right: ExistingConfig): boolean {
  return left.state === right.state && left.preimageSha256 === right.preimageSha256;
}

export function configPreimageDigest(
  state: "absent" | "file" | "symlink",
  bytes?: Buffer,
  identity?: FileIdentity,
): string {
  const material =
    state === "file" && bytes && identity
      ? { state, bytesSha256: sha256(bytes), metadata: identity }
      : { state };
  return sha256(canonicalizeJsonEvidence(material as unknown as JsonEvidenceValue));
}

export function projectConfigBytes(config: DocsFabProjectConfigV1): Buffer {
  assertDocsFabProjectConfig(config);
  const bytes = Buffer.from(
    canonicalizeJsonEvidence(config as unknown as JsonEvidenceValue),
    "utf8",
  );
  assertCredentialFree(
    bytes.toString("utf8"),
    "Project configuration serialization contained credential material.",
  );
  return bytes;
}

/** Public allocator retained for tests and host integrations; mutation uses the pinned variant below. */
export async function allocateDocsFabPrivateRoots(roots: DocsFabPrivateRoots): Promise<void> {
  await allocatePinnedPrivateRoots(roots);
}
