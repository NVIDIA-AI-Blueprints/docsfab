// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Apply seam: mutate owner .env under lock with staged receipts and crash intents.
 * Kept as one module because apply and rollback share the same transactional
 * host protocol (lock, intent, staged receipt, recovery rename).
 */
import { randomBytes } from "node:crypto";
import { closeSync, lstatSync, openSync, linkSync, renameSync } from "node:fs";
import { constants, open } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";
import type { ModelProfilePurpose } from "../catalog-contracts.js";
import type { TrustedModelCatalogApprovalAuthority } from "../catalog-provenance.js";
import { createProfileEnvironmentRollback } from "../profile-environment.js";
import { deepFreeze, invalid, kit } from "./dialect.js";
import {
  decodeProfileApplyPreview,
  decodeProfileApplyReceipt,
  decodeProfileRollbackPreview,
  decodeProfileRollbackReceipt,
  recoverProfileTransaction,
} from "./diagnose.js";
import {
  NOFOLLOW,
  assertLockIdentitySync,
  assertNormalTransactionArtifactsSync,
  assertPathIdentity,
  assertPathIdentitySync,
  assertPlainTree,
  assertReceiptReservationSync,
  assertRootIdentity,
  assertRootIdentitySync,
  assertSafeReceiptTargetSync,
  assertUntracked,
  assertUntrackedSync,
  cleanupNormalArtifactSync,
  digest,
  equal,
  exactKeys,
  exactOwnerArtifactPath,
  identity,
  isMissing,
  ownData,
  pathDigest,
  plainRecord,
  readOwnerConfiguration,
  readOwnerConfigurationSync,
  receiptStageName,
  safeUnlinkInode,
  safeUnlinkInodeSync,
  sameIdentity,
  sha256,
  syncDirectory,
  timestamp,
  validateDigestObject,
  writeExclusive,
} from "./host.js";
import { prepareProfileApply, prepareProfileRollback } from "./propose.js";
import {
  PROFILE_INTENT_NAME,
  PROFILE_LOCK_NAME,
  ProfileApplyAmbiguousError,
  ProfileApplyError,
  ProfileRollbackAmbiguousError,
  type PreparedProfileApply,
  type PreparedProfileRollback,
  type ProfileApplyHooks,
  type ProfileApplyPreviewV1,
  type ProfileApplyReceiptV1,
  type ProfileConfigurationIdentityV1,
  type ProfileRollbackPreviewV1,
  type ProfileRollbackReceiptV1,
  type ProfileSeedReceiptV1,
  type ProfileTransactionIntentV1,
  type StagedOwnerReceipt,
} from "./types.js";

export async function applyProfileConfiguration(input: {
  prepared: PreparedProfileApply;
  confirmPatchSha256: string;
  inspection: string | Uint8Array | unknown;
  approvalBundle: string | Uint8Array | unknown;
  authority: TrustedModelCatalogApprovalAuthority;
  ambientEnvironment?: NodeJS.ProcessEnv;
  now?: Date;
  receiptPath: string;
  hooks?: ProfileApplyHooks;
}): Promise<ProfileApplyReceiptV1> {
  let target: string | undefined;
  let prepared:
    | { projectRoot: string; preview: ProfileApplyPreviewV1; bytes: Uint8Array }
    | undefined;
  let temporary: string | undefined;
  let temporaryIdentity: ProfileConfigurationIdentityV1 | undefined;
  let rollbackTemporary: string | undefined;
  let rollbackTemporaryIdentity: ProfileConfigurationIdentityV1 | undefined;
  let lockPath: string | undefined;
  let lockIdentity: ProfileConfigurationIdentityV1 | undefined;
  let lockDescriptor: number | undefined;
  let installed = false;
  let installedIdentity: ProfileConfigurationIdentityV1 | undefined;
  let hooks: ProfileApplyHooks = {};
  let intentPath: string | undefined;
  let intentIdentity: ProfileConfigurationIdentityV1 | undefined;
  let plannedReceipt: ProfileApplyReceiptV1 | undefined;
  let preserveTransaction = false;
  let receiptPublished = false;
  let receiptCommitStarted = false;
  let stagedReceipt: StagedOwnerReceipt | undefined;
  let publishedReceiptIdentity: ProfileConfigurationIdentityV1 | undefined;
  try {
    const now = input.now ?? new Date();
    hooks = snapshotHooks(input.hooks);
    prepared = snapshotPrepared(input.prepared);
    target = resolve(prepared.projectRoot, ".env");
    assertSafeReceiptTargetSync(prepared.projectRoot, input.receiptPath);
    if (input.confirmPatchSha256 !== prepared.preview.patch.sha256) invalid();
    const recovered = await recoverProfileTransaction({
      projectRoot: prepared.projectRoot,
      operation: "apply",
      purpose: prepared.preview.purpose,
      previewSha256: prepared.preview.sha256,
      patchSha256: prepared.preview.patch.sha256,
      approvalBundleSha256: prepared.preview.approvalBundleSha256,
      receiptPath: input.receiptPath,
    });
    if (recovered.status === "completed") {
      return decodeProfileApplyReceipt(recovered.receipt);
    }
    lockPath = resolve(prepared.projectRoot, PROFILE_LOCK_NAME);
    lockDescriptor = openSync(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
    lockIdentity = identity(lstatSync(lockPath, { bigint: true }));
    assertLockIdentitySync(lockDescriptor, lockPath, lockIdentity);
    assertNormalTransactionArtifactsSync(prepared.projectRoot, prepared.preview.rootIdentity, [
      { path: lockPath, identity: lockIdentity },
    ]);
    const refreshed = await prepareProfileApply({
      projectRoot: prepared.projectRoot,
      purpose: prepared.preview.purpose,
      inspection: input.inspection,
      approvalBundle: input.approvalBundle,
      authority: input.authority,
      ambientEnvironment: input.ambientEnvironment,
      now,
      activeLockIdentity: lockIdentity,
    });
    if (
      !equal(refreshed.preview, prepared.preview) ||
      !Buffer.from(refreshed.bytes).equals(Buffer.from(prepared.bytes))
    )
      invalid();
    const before = await readOwnerConfiguration(target);
    if (
      !sameIdentity(before.identity, prepared.preview.targetIdentity) ||
      sha256(before.bytes) !== prepared.preview.patch.beforeSha256
    )
      invalid();
    await assertUntracked(prepared.projectRoot, target, before.identity);
    if (prepared.preview.patch.changedKeys.length === 0) {
      const result = receipt(prepared.preview, now, false, before.identity, before.identity);
      stagedReceipt = await stageOwnerReceipt(input.receiptPath, result);
      await hooks.afterReceiptStage?.({
        target: stagedReceipt.target,
        temporary: stagedReceipt.temporary,
      });
      assertRootIdentitySync(prepared.projectRoot, prepared.preview.rootIdentity);
      assertNormalTransactionArtifactsSync(prepared.projectRoot, prepared.preview.rootIdentity, [
        { path: target, identity: before.identity },
        { path: lockPath, identity: lockIdentity },
        { path: stagedReceipt.temporary, identity: stagedReceipt.identity },
      ]);
      publishedReceiptIdentity = stagedReceipt.identity;
      await publishStagedOwnerReceipt(stagedReceipt, hooks, {
        projectRoot: prepared.projectRoot,
        rootIdentity: prepared.preview.rootIdentity,
        artifacts: [
          { path: target, identity: before.identity },
          { path: lockPath, identity: lockIdentity },
        ],
      });
      await hooks.afterReceiptPublish?.(input.receiptPath);
      assertPublishedTransactionStateSync(
        prepared.projectRoot,
        prepared.preview.rootIdentity,
        stagedReceipt,
        target,
        before.identity,
        prepared.preview.patch.beforeSha256,
      );
      if (lockDescriptor === undefined) throw new ProfileApplyAmbiguousError();
      closeSync(lockDescriptor);
      lockDescriptor = undefined;
      assertNormalTransactionArtifactsSync(prepared.projectRoot, prepared.preview.rootIdentity, [
        { path: target, identity: before.identity },
        { path: lockPath, identity: lockIdentity },
        { path: input.receiptPath, identity: publishedReceiptIdentity },
      ]);
      if (!safeUnlinkInodeSync(lockPath, lockIdentity)) throw new ProfileApplyAmbiguousError();
      lockPath = undefined;
      lockIdentity = undefined;
      await syncDirectory(prepared.projectRoot);
      assertPublishedTransactionStateSync(
        prepared.projectRoot,
        prepared.preview.rootIdentity,
        stagedReceipt,
        target,
        before.identity,
        prepared.preview.patch.beforeSha256,
      );
      stagedReceipt = undefined;
      return result;
    }
    const nonce = randomBytes(12).toString("hex");
    temporary = resolve(prepared.projectRoot, `.env.docsfab-new-${nonce}`);
    temporaryIdentity = await writeExclusive(temporary, prepared.bytes);
    await hooks.afterTemporarySync?.({
      projectRoot: prepared.projectRoot,
      target,
      temporary,
    });
    assertNormalTransactionArtifactsSync(prepared.projectRoot, prepared.preview.rootIdentity, [
      { path: target, identity: before.identity },
      { path: temporary, identity: temporaryIdentity },
      { path: lockPath, identity: lockIdentity },
    ]);
    const boundary = await readOwnerConfiguration(target);
    if (
      !sameIdentity(boundary.identity, before.identity) ||
      sha256(boundary.bytes) !== prepared.preview.patch.beforeSha256
    )
      invalid();
    await assertUntracked(prepared.projectRoot, target, boundary.identity);
    await assertPathIdentity(temporary, temporaryIdentity);
    await assertRootIdentity(prepared.projectRoot, prepared.preview.rootIdentity);
    hooks.beforeRename?.({ projectRoot: prepared.projectRoot, target, temporary });
    // Cooperative-writer boundary: no await occurs between the final stable
    // reads/index checks and rename. The held lock coordinates DocsFab writers;
    // an uncooperative process can still race this host operation.
    const synchronousBoundary = readOwnerConfigurationSync(target);
    if (
      !sameIdentity(synchronousBoundary.identity, before.identity) ||
      sha256(synchronousBoundary.bytes) !== prepared.preview.patch.beforeSha256
    )
      invalid();
    const stableTemporary = readOwnerConfigurationSync(temporary);
    if (
      !sameIdentity(stableTemporary.identity, temporaryIdentity) ||
      sha256(stableTemporary.bytes) !== prepared.preview.patch.afterSha256
    )
      invalid();
    plannedReceipt = receipt(prepared.preview, now, true, before.identity, temporaryIdentity);
    stagedReceipt = await stageOwnerReceipt(input.receiptPath, plannedReceipt);
    await hooks.afterReceiptStage?.({
      target: stagedReceipt.target,
      temporary: stagedReceipt.temporary,
    });
    assertRootIdentitySync(prepared.projectRoot, prepared.preview.rootIdentity);
    assertNormalTransactionArtifactsSync(prepared.projectRoot, prepared.preview.rootIdentity, [
      { path: target, identity: before.identity },
      { path: temporary, identity: temporaryIdentity },
      { path: lockPath, identity: lockIdentity },
      { path: stagedReceipt.temporary, identity: stagedReceipt.identity },
    ]);
    const intent = createProfileTransactionIntent({
      operation: "apply",
      now,
      rootIdentity: prepared.preview.rootIdentity,
      lockIdentity,
      beforeIdentity: before.identity,
      beforeSha256: prepared.preview.patch.beforeSha256,
      temporaryName: basename(temporary),
      temporaryIdentity,
      plannedAfterSha256: prepared.preview.patch.afterSha256,
      receiptPath: input.receiptPath,
      receiptStageName: basename(stagedReceipt.temporary),
      receiptStageIdentity: stagedReceipt.identity,
      purpose: prepared.preview.purpose,
      previewSha256: prepared.preview.sha256,
      patchSha256: prepared.preview.patch.sha256,
      approvalBundleSha256: prepared.preview.approvalBundleSha256,
      receipt: plannedReceipt,
    });
    ({ path: intentPath, identity: intentIdentity } = await persistProfileTransactionIntent(
      prepared.projectRoot,
      intent,
    ));
    await hooks.afterIntentSync?.(intentPath);
    assertRootIdentitySync(prepared.projectRoot, prepared.preview.rootIdentity);
    // Durable intent publication adds awaits, so the mutation boundary is
    // re-read from descriptors after it. No await occurs from these checks to
    // rename; the held lock coordinates cooperative DocsFab writers only.
    const finalBeforeRename = readOwnerConfigurationSync(target);
    const finalTemporary = readOwnerConfigurationSync(temporary);
    if (
      !sameIdentity(finalBeforeRename.identity, before.identity) ||
      sha256(finalBeforeRename.bytes) !== prepared.preview.patch.beforeSha256 ||
      !sameIdentity(finalTemporary.identity, temporaryIdentity) ||
      sha256(finalTemporary.bytes) !== prepared.preview.patch.afterSha256
    )
      invalid();
    assertRootIdentitySync(prepared.projectRoot, prepared.preview.rootIdentity);
    assertLockIdentitySync(lockDescriptor, lockPath, lockIdentity);
    assertReceiptReservationSync(stagedReceipt);
    assertNormalTransactionArtifactsSync(prepared.projectRoot, prepared.preview.rootIdentity, [
      { path: target, identity: finalBeforeRename.identity },
      { path: temporary, identity: finalTemporary.identity },
      { path: lockPath, identity: lockIdentity },
      { path: intentPath, identity: intentIdentity },
      { path: stagedReceipt.temporary, identity: stagedReceipt.identity },
    ]);
    renameSync(temporary, target);
    temporary = undefined;
    installed = true;
    installedIdentity = temporaryIdentity;
    await hooks.afterRename?.({ projectRoot: prepared.projectRoot, target });
    const after = await readOwnerConfiguration(target);
    installedIdentity = after.identity;
    if (
      !sameIdentity(after.identity, temporaryIdentity) ||
      sha256(after.bytes) !== prepared.preview.patch.afterSha256
    )
      invalid();
    await assertUntracked(prepared.projectRoot, target, after.identity);
    await assertRootIdentity(prepared.projectRoot, prepared.preview.rootIdentity);
    await syncDirectory(prepared.projectRoot);
    assertUntrackedSync(prepared.projectRoot, target, after.identity);
    const finalAfter = readOwnerConfigurationSync(target);
    if (
      !sameIdentity(finalAfter.identity, temporaryIdentity) ||
      sha256(finalAfter.bytes) !== prepared.preview.patch.afterSha256
    )
      invalid();
    if (!plannedReceipt || !sameIdentity(plannedReceipt.afterIdentity, finalAfter.identity))
      invalid();
    const result = plannedReceipt;
    if (!stagedReceipt) invalid();
    receiptCommitStarted = true;
    publishedReceiptIdentity = stagedReceipt.identity;
    await publishStagedOwnerReceipt(stagedReceipt, hooks, {
      projectRoot: prepared.projectRoot,
      rootIdentity: prepared.preview.rootIdentity,
      artifacts: [
        { path: target, identity: finalAfter.identity },
        { path: lockPath!, identity: lockIdentity! },
        { path: intentPath!, identity: intentIdentity! },
      ],
    });
    receiptPublished = true;
    await hooks.afterReceiptPublish?.(input.receiptPath);
    assertPublishedTransactionStateSync(
      prepared.projectRoot,
      prepared.preview.rootIdentity,
      stagedReceipt,
      target,
      finalAfter.identity,
      prepared.preview.patch.afterSha256,
    );
    if (lockDescriptor === undefined || !lockPath || !lockIdentity) {
      throw new ProfileApplyAmbiguousError();
    }
    closeSync(lockDescriptor);
    lockDescriptor = undefined;
    assertNormalTransactionArtifactsSync(prepared.projectRoot, prepared.preview.rootIdentity, [
      { path: target, identity: finalAfter.identity },
      { path: lockPath, identity: lockIdentity },
      { path: intentPath!, identity: intentIdentity! },
      { path: input.receiptPath, identity: publishedReceiptIdentity! },
    ]);
    if (!safeUnlinkInodeSync(lockPath, lockIdentity)) throw new ProfileApplyAmbiguousError();
    lockPath = undefined;
    lockIdentity = undefined;
    await syncDirectory(prepared.projectRoot);
    assertPublishedTransactionStateSync(
      prepared.projectRoot,
      prepared.preview.rootIdentity,
      stagedReceipt,
      target,
      finalAfter.identity,
      prepared.preview.patch.afterSha256,
    );
    if (!intentPath || !intentIdentity) throw new ProfileApplyAmbiguousError();
    assertNormalTransactionArtifactsSync(prepared.projectRoot, prepared.preview.rootIdentity, [
      { path: target, identity: finalAfter.identity },
      { path: intentPath, identity: intentIdentity },
      { path: input.receiptPath, identity: publishedReceiptIdentity! },
    ]);
    if (!safeUnlinkInodeSync(intentPath, intentIdentity)) {
      throw new ProfileApplyAmbiguousError();
    }
    intentPath = undefined;
    intentIdentity = undefined;
    await syncDirectory(prepared.projectRoot);
    assertPublishedTransactionStateSync(
      prepared.projectRoot,
      prepared.preview.rootIdentity,
      stagedReceipt,
      target,
      finalAfter.identity,
      prepared.preview.patch.afterSha256,
    );
    stagedReceipt = undefined;
    return result;
  } catch (error) {
    if (receiptCommitStarted || receiptPublished) {
      preserveTransaction = true;
      throw new ProfileApplyAmbiguousError();
    }
    if (installed && installedIdentity && target && prepared) {
      try {
        const installedValue = readOwnerConfigurationSync(target);
        if (
          !sameIdentity(installedValue.identity, installedIdentity) ||
          sha256(installedValue.bytes) !== prepared.preview.patch.afterSha256
        )
          invalid();
        const rollbackBytes = createProfileEnvironmentRollback(
          installedValue.bytes,
          prepared.preview.patch,
        );
        rollbackTemporary = resolve(
          prepared.projectRoot,
          `.env.docsfab-rollback-${randomBytes(12).toString("hex")}`,
        );
        rollbackTemporaryIdentity = await writeExclusive(rollbackTemporary, rollbackBytes);
        const stableRollback = readOwnerConfigurationSync(rollbackTemporary);
        if (
          !sameIdentity(stableRollback.identity, rollbackTemporaryIdentity) ||
          sha256(stableRollback.bytes) !== prepared.preview.patch.beforeSha256
        )
          invalid();
        const exactInstalled = readOwnerConfigurationSync(target);
        if (
          !sameIdentity(exactInstalled.identity, installedIdentity) ||
          sha256(exactInstalled.bytes) !== prepared.preview.patch.afterSha256
        )
          invalid();
        assertUntrackedSync(prepared.projectRoot, target, exactInstalled.identity);
        assertRootIdentitySync(prepared.projectRoot, prepared.preview.rootIdentity);
        if (lockDescriptor === undefined || !lockPath || !lockIdentity) invalid();
        assertLockIdentitySync(lockDescriptor, lockPath, lockIdentity);
        hooks.beforeRecoveryRename?.({
          projectRoot: prepared.projectRoot,
          target,
          temporary: rollbackTemporary,
        });
        assertNormalTransactionArtifactsSync(prepared.projectRoot, prepared.preview.rootIdentity, [
          { path: target, identity: exactInstalled.identity },
          { path: rollbackTemporary, identity: rollbackTemporaryIdentity },
          { path: lockPath, identity: lockIdentity },
          ...(intentPath && intentIdentity ? [{ path: intentPath, identity: intentIdentity }] : []),
          ...(stagedReceipt
            ? [{ path: stagedReceipt.temporary, identity: stagedReceipt.identity }]
            : []),
        ]);
        const recoveryBoundary = readOwnerConfigurationSync(target);
        if (
          !sameIdentity(recoveryBoundary.identity, installedIdentity) ||
          sha256(recoveryBoundary.bytes) !== prepared.preview.patch.afterSha256
        )
          invalid();
        renameSync(rollbackTemporary, target);
        rollbackTemporary = undefined;
        await syncDirectory(prepared.projectRoot);
        const restored = readOwnerConfigurationSync(target);
        if (
          !sameIdentity(restored.identity, rollbackTemporaryIdentity) ||
          sha256(restored.bytes) !== prepared.preview.patch.beforeSha256
        )
          invalid();
        installed = false;
      } catch {
        preserveTransaction = true;
        throw new ProfileApplyError();
      }
    }
    if (error instanceof ProfileApplyError) throw error;
    if (error instanceof ProfileApplyAmbiguousError) throw error;
    throw new ProfileApplyError();
  } finally {
    let cleanupAmbiguous = false;
    if (lockDescriptor !== undefined) {
      try {
        closeSync(lockDescriptor);
      } catch {
        /* content-free cleanup */
      }
    }
    if (temporary && temporaryIdentity) {
      await runCleanupHook(hooks, temporary);
      cleanupAmbiguous =
        !prepared ||
        !cleanupNormalArtifactSync(
          prepared.projectRoot,
          prepared.preview.rootIdentity,
          temporary,
          temporaryIdentity,
        ) ||
        cleanupAmbiguous;
    }
    if (rollbackTemporary && rollbackTemporaryIdentity) {
      cleanupAmbiguous =
        !prepared ||
        !cleanupNormalArtifactSync(
          prepared.projectRoot,
          prepared.preview.rootIdentity,
          rollbackTemporary,
          rollbackTemporaryIdentity,
        ) ||
        cleanupAmbiguous;
    }
    if (stagedReceipt && !preserveTransaction) {
      cleanupAmbiguous =
        !prepared ||
        !cleanupNormalArtifactSync(
          prepared.projectRoot,
          prepared.preview.rootIdentity,
          stagedReceipt.temporary,
          stagedReceipt.identity,
        ) ||
        cleanupAmbiguous;
      try {
        await syncDirectory(dirname(stagedReceipt.temporary));
      } catch {
        cleanupAmbiguous = true;
      }
    }
    if (lockPath && lockIdentity && !preserveTransaction) {
      cleanupAmbiguous =
        !prepared ||
        !cleanupNormalArtifactSync(
          prepared.projectRoot,
          prepared.preview.rootIdentity,
          lockPath,
          lockIdentity,
        ) ||
        cleanupAmbiguous;
    }
    if (intentPath && intentIdentity && !preserveTransaction) {
      cleanupAmbiguous =
        !prepared ||
        !cleanupNormalArtifactSync(
          prepared.projectRoot,
          prepared.preview.rootIdentity,
          intentPath,
          intentIdentity,
        ) ||
        cleanupAmbiguous;
    }
    if (prepared && !preserveTransaction) {
      try {
        await syncDirectory(prepared.projectRoot);
      } catch {
        cleanupAmbiguous = true;
      }
    }
    if (cleanupAmbiguous) throw new ProfileApplyAmbiguousError();
  }
}

export function receipt(
  preview: ProfileApplyPreviewV1,
  now: Date,
  applied: boolean,
  beforeIdentity: ProfileConfigurationIdentityV1,
  afterIdentity: ProfileConfigurationIdentityV1,
): ProfileApplyReceiptV1 {
  const unsigned = {
    schemaVersion: 1 as const,
    kind: "docsfab-profile-apply-receipt" as const,
    purpose: preview.purpose,
    target: ".env" as const,
    appliedAt: timestamp(now),
    applied,
    previewSha256: preview.sha256,
    beforeSha256: preview.patch.beforeSha256,
    afterSha256: preview.patch.afterSha256,
    beforeIdentity,
    afterIdentity,
    inspectionSha256: preview.inspectionSha256,
    approvalBundleSha256: preview.approvalBundleSha256,
    approvalSha256: preview.approvalSha256,
    approvalEvidenceSha256: preview.approvalEvidenceSha256,
    authorizationSha256: preview.authorizationSha256,
    proposalSha256: preview.proposalSha256,
    proposalProvenanceSha256: preview.proposalProvenanceSha256,
    decisionSha256: preview.decisionSha256,
    patchSha256: preview.patch.sha256,
    tracked: false as const,
    preview,
  };
  kit.rejectCredentials(unsigned);
  return deepFreeze({ ...unsigned, sha256: digest(unsigned) });
}

export async function applyProfileRollback(input: {
  prepared: PreparedProfileRollback;
  receipt: string | Uint8Array | unknown;
  confirmRollbackSha256: string;
  receiptPath: string;
  now?: Date;
  hooks?: ProfileApplyHooks;
}): Promise<ProfileRollbackReceiptV1> {
  let temporary: string | undefined;
  let temporaryIdentity: ProfileConfigurationIdentityV1 | undefined;
  let lockPath: string | undefined;
  let lockIdentity: ProfileConfigurationIdentityV1 | undefined;
  let lockDescriptor: number | undefined;
  let target: string | undefined;
  let prepared: ReturnType<typeof snapshotPreparedRollback> | undefined;
  let beforeBytes: Uint8Array | undefined;
  let installed = false;
  let installedIdentity: ProfileConfigurationIdentityV1 | undefined;
  let recovery: string | undefined;
  let recoveryIdentity: ProfileConfigurationIdentityV1 | undefined;
  let hooks: ProfileApplyHooks = {};
  let intentPath: string | undefined;
  let intentIdentity: ProfileConfigurationIdentityV1 | undefined;
  let plannedReceipt: ProfileRollbackReceiptV1 | undefined;
  let preserveTransaction = false;
  let receiptPublished = false;
  let receiptCommitStarted = false;
  let stagedReceipt: StagedOwnerReceipt | undefined;
  let publishedReceiptIdentity: ProfileConfigurationIdentityV1 | undefined;
  try {
    const now = input.now ?? new Date();
    hooks = snapshotHooks(input.hooks);
    prepared = snapshotPreparedRollback(input.prepared);
    assertSafeReceiptTargetSync(prepared.projectRoot, input.receiptPath);
    const applyReceipt = decodeProfileApplyReceipt(input.receipt);
    if (
      input.confirmRollbackSha256 !== prepared.preview.sha256 ||
      applyReceipt.sha256 !== prepared.preview.receiptSha256
    )
      invalid();
    const recovered = await recoverProfileTransaction({
      projectRoot: prepared.projectRoot,
      operation: "rollback",
      purpose: prepared.preview.purpose,
      previewSha256: prepared.preview.sha256,
      patchSha256: prepared.preview.patchSha256,
      applyReceiptSha256: applyReceipt.sha256,
      receiptPath: input.receiptPath,
    });
    if (recovered.status === "completed") {
      return decodeProfileRollbackReceipt(recovered.receipt);
    }
    target = resolve(prepared.projectRoot, ".env");
    lockPath = resolve(prepared.projectRoot, PROFILE_LOCK_NAME);
    lockDescriptor = openSync(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
    lockIdentity = identity(lstatSync(lockPath, { bigint: true }));
    assertLockIdentitySync(lockDescriptor, lockPath, lockIdentity);
    assertNormalTransactionArtifactsSync(prepared.projectRoot, prepared.preview.rootIdentity, [
      { path: lockPath, identity: lockIdentity },
    ]);
    const refreshed = await prepareProfileRollback({
      projectRoot: prepared.projectRoot,
      receipt: applyReceipt,
      activeLockIdentity: lockIdentity,
    });
    if (
      !equal(refreshed.preview, prepared.preview) ||
      !Buffer.from(refreshed.bytes).equals(Buffer.from(prepared.bytes))
    )
      invalid();
    const current = await readOwnerConfiguration(target);
    beforeBytes = Uint8Array.from(current.bytes);
    if (
      !sameIdentity(current.identity, prepared.preview.currentIdentity) ||
      sha256(current.bytes) !== prepared.preview.fromSha256
    )
      invalid();
    await assertUntracked(prepared.projectRoot, target, current.identity);
    temporary = resolve(
      prepared.projectRoot,
      `.env.docsfab-rollback-${randomBytes(12).toString("hex")}`,
    );
    temporaryIdentity = await writeExclusive(temporary, prepared.bytes);
    await hooks.afterTemporarySync?.({
      projectRoot: prepared.projectRoot,
      target,
      temporary,
    });
    assertNormalTransactionArtifactsSync(prepared.projectRoot, prepared.preview.rootIdentity, [
      { path: target, identity: current.identity },
      { path: temporary, identity: temporaryIdentity },
      { path: lockPath, identity: lockIdentity },
    ]);
    hooks.beforeRename?.({ projectRoot: prepared.projectRoot, target, temporary });
    const boundary = readOwnerConfigurationSync(target);
    const stableTemporary = readOwnerConfigurationSync(temporary);
    if (
      !sameIdentity(boundary.identity, current.identity) ||
      sha256(boundary.bytes) !== prepared.preview.fromSha256 ||
      !sameIdentity(stableTemporary.identity, temporaryIdentity) ||
      sha256(stableTemporary.bytes) !== prepared.preview.toSha256
    )
      invalid();
    plannedReceipt = rollbackReceipt(prepared.preview, now, current.identity, temporaryIdentity);
    stagedReceipt = await stageOwnerReceipt(input.receiptPath, plannedReceipt);
    await hooks.afterReceiptStage?.({
      target: stagedReceipt.target,
      temporary: stagedReceipt.temporary,
    });
    assertRootIdentitySync(prepared.projectRoot, prepared.preview.rootIdentity);
    assertNormalTransactionArtifactsSync(prepared.projectRoot, prepared.preview.rootIdentity, [
      { path: target, identity: current.identity },
      { path: temporary, identity: temporaryIdentity },
      { path: lockPath, identity: lockIdentity },
      { path: stagedReceipt.temporary, identity: stagedReceipt.identity },
    ]);
    const intent = createProfileTransactionIntent({
      operation: "rollback",
      now,
      rootIdentity: prepared.preview.rootIdentity,
      lockIdentity,
      beforeIdentity: current.identity,
      beforeSha256: prepared.preview.fromSha256,
      temporaryName: basename(temporary),
      temporaryIdentity,
      plannedAfterSha256: prepared.preview.toSha256,
      receiptPath: input.receiptPath,
      receiptStageName: basename(stagedReceipt.temporary),
      receiptStageIdentity: stagedReceipt.identity,
      purpose: prepared.preview.purpose,
      previewSha256: prepared.preview.sha256,
      patchSha256: prepared.preview.patchSha256,
      applyReceiptSha256: applyReceipt.sha256,
      receipt: plannedReceipt,
    });
    ({ path: intentPath, identity: intentIdentity } = await persistProfileTransactionIntent(
      prepared.projectRoot,
      intent,
    ));
    await hooks.afterIntentSync?.(intentPath);
    assertRootIdentitySync(prepared.projectRoot, prepared.preview.rootIdentity);
    const finalBeforeRename = readOwnerConfigurationSync(target);
    const finalTemporary = readOwnerConfigurationSync(temporary);
    if (
      !sameIdentity(finalBeforeRename.identity, current.identity) ||
      sha256(finalBeforeRename.bytes) !== prepared.preview.fromSha256 ||
      !sameIdentity(finalTemporary.identity, temporaryIdentity) ||
      sha256(finalTemporary.bytes) !== prepared.preview.toSha256
    )
      invalid();
    assertRootIdentitySync(prepared.projectRoot, prepared.preview.rootIdentity);
    assertLockIdentitySync(lockDescriptor, lockPath, lockIdentity);
    assertReceiptReservationSync(stagedReceipt);
    assertNormalTransactionArtifactsSync(prepared.projectRoot, prepared.preview.rootIdentity, [
      { path: target, identity: finalBeforeRename.identity },
      { path: temporary, identity: finalTemporary.identity },
      { path: lockPath, identity: lockIdentity },
      { path: intentPath, identity: intentIdentity },
      { path: stagedReceipt.temporary, identity: stagedReceipt.identity },
    ]);
    renameSync(temporary, target);
    temporary = undefined;
    installed = true;
    installedIdentity = temporaryIdentity;
    await hooks.afterRename?.({ projectRoot: prepared.projectRoot, target });
    const after = await readOwnerConfiguration(target);
    installedIdentity = after.identity;
    if (
      !sameIdentity(after.identity, temporaryIdentity) ||
      sha256(after.bytes) !== prepared.preview.toSha256
    )
      invalid();
    await assertUntracked(prepared.projectRoot, target, after.identity);
    await assertRootIdentity(prepared.projectRoot, prepared.preview.rootIdentity);
    await syncDirectory(prepared.projectRoot);
    assertUntrackedSync(prepared.projectRoot, target, after.identity);
    const finalAfter = readOwnerConfigurationSync(target);
    if (
      !sameIdentity(finalAfter.identity, temporaryIdentity) ||
      sha256(finalAfter.bytes) !== prepared.preview.toSha256
    )
      invalid();
    if (!plannedReceipt || !sameIdentity(plannedReceipt.afterIdentity, finalAfter.identity))
      invalid();
    const result = plannedReceipt;
    if (!stagedReceipt) invalid();
    receiptCommitStarted = true;
    publishedReceiptIdentity = stagedReceipt.identity;
    await publishStagedOwnerReceipt(stagedReceipt, hooks, {
      projectRoot: prepared.projectRoot,
      rootIdentity: prepared.preview.rootIdentity,
      artifacts: [
        { path: target, identity: finalAfter.identity },
        { path: lockPath!, identity: lockIdentity! },
        { path: intentPath!, identity: intentIdentity! },
      ],
    });
    receiptPublished = true;
    await hooks.afterReceiptPublish?.(input.receiptPath);
    assertPublishedTransactionStateSync(
      prepared.projectRoot,
      prepared.preview.rootIdentity,
      stagedReceipt,
      target,
      finalAfter.identity,
      prepared.preview.toSha256,
    );
    if (lockDescriptor === undefined || !lockPath || !lockIdentity) {
      throw new ProfileRollbackAmbiguousError();
    }
    closeSync(lockDescriptor);
    lockDescriptor = undefined;
    assertNormalTransactionArtifactsSync(prepared.projectRoot, prepared.preview.rootIdentity, [
      { path: target, identity: finalAfter.identity },
      { path: lockPath, identity: lockIdentity },
      { path: intentPath!, identity: intentIdentity! },
      { path: input.receiptPath, identity: publishedReceiptIdentity! },
    ]);
    if (!safeUnlinkInodeSync(lockPath, lockIdentity)) throw new ProfileRollbackAmbiguousError();
    lockPath = undefined;
    lockIdentity = undefined;
    await syncDirectory(prepared.projectRoot);
    assertPublishedTransactionStateSync(
      prepared.projectRoot,
      prepared.preview.rootIdentity,
      stagedReceipt,
      target,
      finalAfter.identity,
      prepared.preview.toSha256,
    );
    if (!intentPath || !intentIdentity) throw new ProfileRollbackAmbiguousError();
    assertNormalTransactionArtifactsSync(prepared.projectRoot, prepared.preview.rootIdentity, [
      { path: target, identity: finalAfter.identity },
      { path: intentPath, identity: intentIdentity },
      { path: input.receiptPath, identity: publishedReceiptIdentity! },
    ]);
    if (!safeUnlinkInodeSync(intentPath, intentIdentity)) {
      throw new ProfileRollbackAmbiguousError();
    }
    intentPath = undefined;
    intentIdentity = undefined;
    await syncDirectory(prepared.projectRoot);
    assertPublishedTransactionStateSync(
      prepared.projectRoot,
      prepared.preview.rootIdentity,
      stagedReceipt,
      target,
      finalAfter.identity,
      prepared.preview.toSha256,
    );
    stagedReceipt = undefined;
    return result;
  } catch (error) {
    if (receiptCommitStarted || receiptPublished) {
      preserveTransaction = true;
      throw new ProfileRollbackAmbiguousError();
    }
    if (installed && installedIdentity && target && prepared && beforeBytes) {
      try {
        const installedValue = readOwnerConfigurationSync(target);
        if (
          !sameIdentity(installedValue.identity, installedIdentity) ||
          sha256(installedValue.bytes) !== prepared.preview.toSha256
        ) {
          throw new ProfileRollbackAmbiguousError();
        }
        recovery = resolve(
          prepared.projectRoot,
          `.env.docsfab-new-${randomBytes(12).toString("hex")}`,
        );
        recoveryIdentity = await writeExclusive(recovery, beforeBytes);
        const stableRecovery = readOwnerConfigurationSync(recovery);
        if (
          !sameIdentity(stableRecovery.identity, recoveryIdentity) ||
          sha256(stableRecovery.bytes) !== prepared.preview.fromSha256
        ) {
          throw new ProfileRollbackAmbiguousError();
        }
        const exactInstalled = readOwnerConfigurationSync(target);
        if (
          !sameIdentity(exactInstalled.identity, installedIdentity) ||
          sha256(exactInstalled.bytes) !== prepared.preview.toSha256
        ) {
          throw new ProfileRollbackAmbiguousError();
        }
        assertUntrackedSync(prepared.projectRoot, target, exactInstalled.identity);
        assertRootIdentitySync(prepared.projectRoot, prepared.preview.rootIdentity);
        if (lockDescriptor === undefined || !lockPath || !lockIdentity) {
          throw new ProfileRollbackAmbiguousError();
        }
        assertLockIdentitySync(lockDescriptor, lockPath, lockIdentity);
        hooks.beforeRecoveryRename?.({
          projectRoot: prepared.projectRoot,
          target,
          temporary: recovery,
        });
        assertNormalTransactionArtifactsSync(prepared.projectRoot, prepared.preview.rootIdentity, [
          { path: target, identity: exactInstalled.identity },
          { path: recovery, identity: recoveryIdentity },
          { path: lockPath, identity: lockIdentity },
          ...(intentPath && intentIdentity ? [{ path: intentPath, identity: intentIdentity }] : []),
          ...(stagedReceipt
            ? [{ path: stagedReceipt.temporary, identity: stagedReceipt.identity }]
            : []),
        ]);
        const recoveryBoundary = readOwnerConfigurationSync(target);
        if (
          !sameIdentity(recoveryBoundary.identity, installedIdentity) ||
          sha256(recoveryBoundary.bytes) !== prepared.preview.toSha256
        ) {
          throw new ProfileRollbackAmbiguousError();
        }
        renameSync(recovery, target);
        recovery = undefined;
        await syncDirectory(prepared.projectRoot);
        const restored = readOwnerConfigurationSync(target);
        if (
          !sameIdentity(restored.identity, recoveryIdentity) ||
          sha256(restored.bytes) !== prepared.preview.fromSha256
        ) {
          throw new ProfileRollbackAmbiguousError();
        }
        installed = false;
      } catch (recoveryError) {
        preserveTransaction = true;
        if (recoveryError instanceof ProfileRollbackAmbiguousError) throw recoveryError;
        throw new ProfileRollbackAmbiguousError();
      }
    }
    if (error instanceof ProfileRollbackAmbiguousError) throw error;
    if (error instanceof ProfileApplyError) throw error;
    throw new ProfileApplyError();
  } finally {
    let cleanupAmbiguous = false;
    if (lockDescriptor !== undefined) {
      try {
        closeSync(lockDescriptor);
      } catch {
        /* content-free cleanup */
      }
    }
    if (temporary && temporaryIdentity) {
      await runCleanupHook(hooks, temporary);
      cleanupAmbiguous =
        !prepared ||
        !cleanupNormalArtifactSync(
          prepared.projectRoot,
          prepared.preview.rootIdentity,
          temporary,
          temporaryIdentity,
        ) ||
        cleanupAmbiguous;
    }
    if (recovery && recoveryIdentity) {
      await runCleanupHook(hooks, recovery);
      cleanupAmbiguous =
        !prepared ||
        !cleanupNormalArtifactSync(
          prepared.projectRoot,
          prepared.preview.rootIdentity,
          recovery,
          recoveryIdentity,
        ) ||
        cleanupAmbiguous;
    }
    if (stagedReceipt && !preserveTransaction) {
      cleanupAmbiguous =
        !prepared ||
        !cleanupNormalArtifactSync(
          prepared.projectRoot,
          prepared.preview.rootIdentity,
          stagedReceipt.temporary,
          stagedReceipt.identity,
        ) ||
        cleanupAmbiguous;
      try {
        await syncDirectory(dirname(stagedReceipt.temporary));
      } catch {
        cleanupAmbiguous = true;
      }
    }
    if (lockPath && lockIdentity && !preserveTransaction) {
      cleanupAmbiguous =
        !prepared ||
        !cleanupNormalArtifactSync(
          prepared.projectRoot,
          prepared.preview.rootIdentity,
          lockPath,
          lockIdentity,
        ) ||
        cleanupAmbiguous;
    }
    if (intentPath && intentIdentity && !preserveTransaction) {
      cleanupAmbiguous =
        !prepared ||
        !cleanupNormalArtifactSync(
          prepared.projectRoot,
          prepared.preview.rootIdentity,
          intentPath,
          intentIdentity,
        ) ||
        cleanupAmbiguous;
    }
    if (prepared && !preserveTransaction) {
      try {
        await syncDirectory(prepared.projectRoot);
      } catch {
        cleanupAmbiguous = true;
      }
    }
    if (cleanupAmbiguous) throw new ProfileRollbackAmbiguousError();
  }
}

export function rollbackReceipt(
  preview: ProfileRollbackPreviewV1,
  now: Date,
  beforeIdentity: ProfileConfigurationIdentityV1,
  afterIdentity: ProfileConfigurationIdentityV1,
): ProfileRollbackReceiptV1 {
  const unsigned = {
    schemaVersion: 1 as const,
    kind: "docsfab-profile-rollback-receipt" as const,
    purpose: preview.purpose,
    target: ".env" as const,
    rolledBackAt: timestamp(now),
    rollbackPreviewSha256: preview.sha256,
    applyReceiptSha256: preview.receiptSha256,
    patchSha256: preview.patchSha256,
    fromSha256: preview.fromSha256,
    toSha256: preview.toSha256,
    beforeIdentity,
    afterIdentity,
    tracked: false as const,
    preview,
  };
  kit.rejectCredentials(unsigned);
  return deepFreeze({ ...unsigned, sha256: digest(unsigned) });
}

export async function stageOwnerReceipt(
  path: string,
  value: ProfileApplyReceiptV1 | ProfileRollbackReceiptV1 | ProfileSeedReceiptV1,
): Promise<StagedOwnerReceipt> {
  const target = await exactOwnerArtifactPath(path);
  kit.rejectCredentials(value);
  validateDigestObject(value);
  const bytes = Buffer.from(canonicalizeJsonEvidence(value as unknown as JsonEvidenceValue));
  const temporary = resolve(dirname(target), receiptStageName(pathDigest(target), value.sha256));
  if (temporary === target) invalid();
  try {
    lstatSync(target, { bigint: true });
    invalid();
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const ambiguous = (): Error =>
    value.kind === "docsfab-profile-rollback-receipt"
      ? new ProfileRollbackAmbiguousError()
      : new ProfileApplyAmbiguousError();
  let cleanupIdentity: ProfileConfigurationIdentityV1 | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let complete = false;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
    cleanupIdentity = identity(await handle.stat({ bigint: true }));
    await handle.writeFile(bytes);
    await handle.sync();
    const metadata = await handle.stat({ bigint: true });
    if (
      !metadata.isFile() ||
      metadata.uid !== BigInt(process.getuid?.() ?? -1) ||
      Number(metadata.mode & 0o777n) !== 0o600 ||
      metadata.nlink !== 1n ||
      metadata.size !== BigInt(bytes.length)
    )
      invalid();
    const stagedIdentity = identity(metadata);
    await handle.close();
    handle = undefined;
    await syncDirectory(dirname(target));
    const stable = readOwnerConfigurationSync(temporary);
    if (!sameIdentity(stable.identity, stagedIdentity) || !Buffer.from(stable.bytes).equals(bytes))
      invalid();
    complete = true;
    return { target, temporary, identity: stagedIdentity, bytes };
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* cleanup below establishes ambiguity */
      }
    }
    if (!complete && cleanupIdentity) {
      const cleaned = await safeUnlinkInode(temporary, cleanupIdentity);
      let synced = true;
      try {
        await syncDirectory(dirname(target));
      } catch {
        synced = false;
      }
      if (!cleaned || !synced) throw ambiguous();
    }
  }
}

export async function publishStagedOwnerReceipt(
  staged: StagedOwnerReceipt,
  hooks: ProfileApplyHooks,
  transaction: {
    projectRoot: string;
    rootIdentity: ProfileConfigurationIdentityV1;
    artifacts: readonly { path: string; identity: ProfileConfigurationIdentityV1 }[];
  },
): Promise<void> {
  const stable = readOwnerConfigurationSync(staged.temporary);
  if (
    !sameIdentity(stable.identity, staged.identity) ||
    !Buffer.from(stable.bytes).equals(Buffer.from(staged.bytes))
  )
    invalid();
  assertNormalTransactionArtifactsSync(transaction.projectRoot, transaction.rootIdentity, [
    ...transaction.artifacts,
    { path: staged.temporary, identity: staged.identity },
  ]);
  linkSync(staged.temporary, staged.target);
  await hooks.afterReceiptLink?.({ target: staged.target, temporary: staged.temporary });
  assertRootIdentitySync(transaction.projectRoot, transaction.rootIdentity);
  const linkedTarget = identity(lstatSync(staged.target, { bigint: true }));
  assertNormalTransactionArtifactsSync(transaction.projectRoot, transaction.rootIdentity, [
    ...transaction.artifacts,
    { path: staged.temporary, identity: staged.identity },
    { path: staged.target, identity: linkedTarget },
  ]);
  if (!safeUnlinkInodeSync(staged.temporary, staged.identity)) invalid();
  await syncDirectory(dirname(staged.target));
  assertRootIdentitySync(transaction.projectRoot, transaction.rootIdentity);
  const finalReceipt = readOwnerConfigurationSync(staged.target);
  if (
    !sameIdentity(finalReceipt.identity, staged.identity) ||
    !Buffer.from(finalReceipt.bytes).equals(Buffer.from(staged.bytes))
  )
    invalid();
}

export function assertPublishedTransactionStateSync(
  projectRoot: string,
  rootIdentity: ProfileConfigurationIdentityV1,
  staged: StagedOwnerReceipt,
  target: string,
  targetIdentity: ProfileConfigurationIdentityV1,
  targetSha256: string,
): void {
  assertRootIdentitySync(projectRoot, rootIdentity);
  const published = readOwnerConfigurationSync(staged.target);
  if (
    !sameIdentity(published.identity, staged.identity) ||
    !Buffer.from(published.bytes).equals(Buffer.from(staged.bytes))
  )
    invalid();
  const configuration = readOwnerConfigurationSync(target);
  if (
    !sameIdentity(configuration.identity, targetIdentity) ||
    sha256(configuration.bytes) !== targetSha256
  )
    invalid();
  assertNormalTransactionArtifactsSync(projectRoot, rootIdentity, [
    { path: staged.target, identity: published.identity },
    { path: target, identity: configuration.identity },
  ]);
  assertRootIdentitySync(projectRoot, rootIdentity);
}

export function createProfileTransactionIntent(input: {
  operation: "apply" | "rollback" | "seed";
  now: Date;
  rootIdentity: ProfileConfigurationIdentityV1;
  lockIdentity: ProfileConfigurationIdentityV1;
  beforeIdentity: ProfileConfigurationIdentityV1;
  beforeSha256: string;
  temporaryName: string;
  temporaryIdentity: ProfileConfigurationIdentityV1;
  plannedAfterSha256: string;
  receiptPath: string;
  receiptStageName: string;
  receiptStageIdentity: ProfileConfigurationIdentityV1;
  purpose: ModelProfilePurpose;
  previewSha256: string;
  patchSha256: string;
  approvalBundleSha256?: string;
  applyReceiptSha256?: string;
  receipt: ProfileApplyReceiptV1 | ProfileRollbackReceiptV1 | ProfileSeedReceiptV1;
}): ProfileTransactionIntentV1 {
  const unsigned = {
    schemaVersion: 1 as const,
    kind: "docsfab-profile-transaction-intent" as const,
    operation: input.operation,
    createdAt: timestamp(input.now),
    processId: process.pid,
    target: ".env" as const,
    lockName: PROFILE_LOCK_NAME,
    lockIdentity: input.lockIdentity,
    rootIdentity: input.rootIdentity,
    beforeIdentity: input.beforeIdentity,
    beforeSha256: input.beforeSha256,
    plannedAfterIdentity: input.temporaryIdentity,
    plannedAfterSha256: input.plannedAfterSha256,
    temporaryName: input.temporaryName,
    temporaryIdentity: input.temporaryIdentity,
    receiptPathSha256: pathDigest(input.receiptPath),
    receiptStageName: input.receiptStageName,
    receiptStageIdentity: input.receiptStageIdentity,
    purpose: input.purpose,
    previewSha256: input.previewSha256,
    patchSha256: input.patchSha256,
    approvalBundleSha256: input.approvalBundleSha256 ?? null,
    applyReceiptSha256: input.applyReceiptSha256 ?? null,
    receipt: input.receipt,
  };
  kit.rejectCredentials(unsigned);
  return deepFreeze({ ...unsigned, sha256: digest(unsigned) });
}

export async function persistProfileTransactionIntent(
  projectRoot: string,
  intent: ProfileTransactionIntentV1,
): Promise<{ path: string; identity: ProfileConfigurationIdentityV1 }> {
  const path = resolve(projectRoot, PROFILE_INTENT_NAME);
  const bytes = Buffer.from(canonicalizeJsonEvidence(intent as unknown as JsonEvidenceValue));
  const ambiguous = (): Error =>
    intent.operation === "rollback"
      ? new ProfileRollbackAmbiguousError()
      : new ProfileApplyAmbiguousError();
  let cleanupIdentity: ProfileConfigurationIdentityV1 | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let complete = false;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
    cleanupIdentity = identity(await handle.stat({ bigint: true }));
    await handle.writeFile(bytes);
    await handle.sync();
    const metadata = await handle.stat({ bigint: true });
    if (
      !metadata.isFile() ||
      metadata.uid !== BigInt(process.getuid?.() ?? -1) ||
      Number(metadata.mode & 0o777n) !== 0o600 ||
      metadata.nlink !== 1n ||
      metadata.size !== BigInt(bytes.length)
    )
      invalid();
    const intentIdentity = identity(metadata);
    await handle.close();
    handle = undefined;
    await syncDirectory(projectRoot);
    const stable = readOwnerConfigurationSync(path);
    if (!sameIdentity(stable.identity, intentIdentity) || !Buffer.from(stable.bytes).equals(bytes))
      invalid();
    complete = true;
    return { path, identity: intentIdentity };
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* cleanup below establishes ambiguity */
      }
    }
    if (!complete && cleanupIdentity) {
      const cleaned = await safeUnlinkInode(path, cleanupIdentity);
      let synced = true;
      try {
        await syncDirectory(projectRoot);
      } catch {
        synced = false;
      }
      if (!cleaned || !synced) throw ambiguous();
    }
  }
}

export function snapshotPrepared(value: unknown): {
  projectRoot: string;
  preview: ProfileApplyPreviewV1;
  bytes: Uint8Array;
} {
  const record = plainRecord(value);
  exactKeys(record, ["bytes", "preview", "projectRoot"]);
  const descriptor = Object.getOwnPropertyDescriptor(record, "bytes");
  if (
    !descriptor ||
    !("value" in descriptor) ||
    !(descriptor.value instanceof Uint8Array) ||
    Object.getPrototypeOf(descriptor.value) !== Uint8Array.prototype
  )
    invalid();
  const root = ownData(record, "projectRoot");
  const previewValue = ownData(record, "preview");
  if (typeof root !== "string" || root.length === 0) invalid();
  assertPlainTree(previewValue);
  const preview = decodeProfileApplyPreview(previewValue);
  const bytes = Uint8Array.from(descriptor.value);
  if (sha256(bytes) !== preview.patch.afterSha256) invalid();
  return { projectRoot: root, preview: deepFreeze(preview), bytes };
}

export function snapshotHooks(value: unknown): ProfileApplyHooks {
  if (value === undefined) return {};
  const record = plainRecord(value);
  const allowed = [
    "afterTemporarySync",
    "beforeRename",
    "afterRename",
    "beforeRecoveryRename",
    "afterReceiptStage",
    "afterReceiptLink",
    "afterIntentSync",
    "afterReceiptPublish",
    "beforeCleanup",
  ];
  if (Object.keys(record).some((key) => !allowed.includes(key))) invalid();
  const result: ProfileApplyHooks = {};
  for (const key of allowed as Array<keyof ProfileApplyHooks>) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor) continue;
    if (!("value" in descriptor) || typeof descriptor.value !== "function") invalid();
    result[key] = descriptor.value as never;
  }
  return Object.freeze(result);
}

export async function runCleanupHook(hooks: ProfileApplyHooks, path: string): Promise<void> {
  try {
    await hooks.beforeCleanup?.(path);
  } catch {
    /* force identity-checked cleanup */
  }
}

export function snapshotPreparedRollback(value: unknown): {
  projectRoot: string;
  preview: ProfileRollbackPreviewV1;
  bytes: Uint8Array;
} {
  const record = plainRecord(value);
  exactKeys(record, ["bytes", "preview", "projectRoot"]);
  const bytesValue = ownData(record, "bytes");
  const root = ownData(record, "projectRoot");
  const previewValue = ownData(record, "preview");
  if (
    !(bytesValue instanceof Uint8Array) ||
    Object.getPrototypeOf(bytesValue) !== Uint8Array.prototype ||
    typeof root !== "string" ||
    root.length === 0
  )
    invalid();
  const preview = decodeProfileRollbackPreview(previewValue);
  const bytes = Uint8Array.from(bytesValue);
  if (sha256(bytes) !== preview.toSha256) invalid();
  return { projectRoot: root, preview, bytes };
}
