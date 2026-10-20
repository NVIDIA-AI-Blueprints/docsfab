// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Diagnose seam: receipt codecs, postimage verification, and transaction recovery.
 */
import { lstatSync } from "node:fs";
import { link, lstat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../../json-evidence.js";
import { detectCredentialRuleIdsInValue } from "../../security/repository-scanner.js";
import type { ModelProfilePurpose } from "../catalog-contracts.js";
import { decodeProfileEnvironmentPatch } from "../profile-environment.js";
import { deepFreeze, invalid, kit } from "./dialect.js";
import {
  assertNormalTransactionArtifactsSync,
  assertPathIdentitySync,
  assertPlainTree,
  assertRecoveryNamespace,
  assertRootIdentitySync,
  assertSafeReceiptTargetSync,
  assertSafeTemporaryState,
  assertUntracked,
  assertUntrackedIfInRootSync,
  assertUntrackedSync,
  digest,
  equal,
  exactKeys,
  exactOwnerArtifactPath,
  exactProjectRoot,
  hexDigest,
  identity,
  isMissing,
  optionalLstat,
  pathDigest,
  plainRecord,
  processIsAlive,
  readOwnerConfiguration,
  readOwnerConfigurationSync,
  readOwnerLinkedArtifact,
  readOwnerLinkedArtifactSync,
  receiptStageName,
  safeUnlink,
  safeUnlinkInode,
  sameDirectoryIdentity,
  sameIdentity,
  sameInodeOwner,
  sha256,
  syncDirectory,
  timestamp,
  validateDigestObject,
  validateIdentity,
} from "./host.js";
import {
  PROFILE_CLAIM_NAME,
  PROFILE_INTENT_NAME,
  PROFILE_LOCK_NAME,
  PROFILE_SEED_ABSENT_IDENTITY,
  ProfileApplyAmbiguousError,
  ProfileApplyError,
  ProfileRollbackAmbiguousError,
  type ProfileApplyPreviewV1,
  type ProfileApplyReceiptV1,
  type ProfileConfigurationIdentityV1,
  type ProfileRollbackPreviewV1,
  type ProfileRollbackReceiptV1,
  type ProfileSeedPatchV1,
  type ProfileSeedPreviewV1,
  type ProfileSeedReceiptV1,
  type ProfileTransactionIntentV1,
  type ProfileTransactionRecovery,
} from "./types.js";

export function serializeProfileApplyReceipt(value: ProfileApplyReceiptV1): string {
  return canonicalizeJsonEvidence(decodeProfileApplyReceipt(value) as unknown as JsonEvidenceValue);
}

export function decodeProfileApplyReceipt(
  value: string | Uint8Array | unknown,
): ProfileApplyReceiptV1 {
  try {
    const parsed =
      typeof value === "string" || value instanceof Uint8Array ? parseJsonEvidence(value) : value;
    assertPlainTree(parsed);
    const receipt = structuredClone(parsed) as ProfileApplyReceiptV1;
    const record = plainRecord(receipt);
    exactKeys(record, [
      "schemaVersion",
      "kind",
      "purpose",
      "target",
      "appliedAt",
      "applied",
      "previewSha256",
      "beforeSha256",
      "afterSha256",
      "beforeIdentity",
      "afterIdentity",
      "inspectionSha256",
      "approvalBundleSha256",
      "approvalSha256",
      "approvalEvidenceSha256",
      "authorizationSha256",
      "proposalSha256",
      "proposalProvenanceSha256",
      "decisionSha256",
      "patchSha256",
      "tracked",
      "preview",
      "sha256",
    ]);
    if (
      receipt.schemaVersion !== 1 ||
      receipt.kind !== "docsfab-profile-apply-receipt" ||
      (receipt.purpose !== "policy" && receipt.purpose !== "judge") ||
      receipt.target !== ".env" ||
      typeof receipt.applied !== "boolean" ||
      receipt.tracked !== false ||
      timestamp(new Date(receipt.appliedAt)) !== receipt.appliedAt
    )
      invalid();
    for (const sha of [
      receipt.sha256,
      receipt.previewSha256,
      receipt.beforeSha256,
      receipt.afterSha256,
      receipt.inspectionSha256,
      receipt.approvalBundleSha256,
      receipt.approvalSha256,
      receipt.approvalEvidenceSha256,
      receipt.authorizationSha256,
      receipt.proposalSha256,
      receipt.proposalProvenanceSha256,
      receipt.decisionSha256,
      receipt.patchSha256,
    ])
      if (!hexDigest(sha)) invalid();
    validateIdentity(receipt.beforeIdentity);
    validateIdentity(receipt.afterIdentity);
    const preview = decodeProfileApplyPreview(receipt.preview);
    const patch = decodeProfileEnvironmentPatch(preview.patch);
    if (
      receipt.purpose !== preview.purpose ||
      receipt.previewSha256 !== preview.sha256 ||
      receipt.beforeSha256 !== patch.beforeSha256 ||
      receipt.afterSha256 !== patch.afterSha256 ||
      receipt.patchSha256 !== patch.sha256 ||
      receipt.inspectionSha256 !== preview.inspectionSha256 ||
      receipt.approvalBundleSha256 !== preview.approvalBundleSha256 ||
      receipt.approvalSha256 !== preview.approvalSha256 ||
      receipt.approvalEvidenceSha256 !== preview.approvalEvidenceSha256 ||
      receipt.authorizationSha256 !== preview.authorizationSha256 ||
      receipt.proposalSha256 !== preview.proposalSha256 ||
      receipt.proposalProvenanceSha256 !== preview.proposalProvenanceSha256 ||
      receipt.decisionSha256 !== preview.decisionSha256 ||
      !sameIdentity(receipt.beforeIdentity, preview.targetIdentity)
    )
      invalid();
    if (
      !receipt.applied &&
      (patch.changedKeys.length !== 0 ||
        !sameIdentity(receipt.beforeIdentity, receipt.afterIdentity) ||
        receipt.beforeSha256 !== receipt.afterSha256)
    )
      invalid();
    if (
      receipt.applied &&
      (patch.changedKeys.length === 0 ||
        receipt.beforeSha256 === receipt.afterSha256 ||
        sameIdentity(receipt.beforeIdentity, receipt.afterIdentity))
    )
      invalid();
    const unsigned = { ...record };
    delete unsigned.sha256;
    if (digest(unsigned) !== receipt.sha256 || detectCredentialRuleIdsInValue(receipt).length > 0)
      invalid();
    return deepFreeze(receipt);
  } catch (error) {
    if (error instanceof ProfileApplyError) throw error;
    throw new ProfileApplyError();
  }
}

export async function loadProfileApplyReceipt(path: string): Promise<ProfileApplyReceiptV1> {
  try {
    const target = await exactOwnerArtifactPath(path);
    return decodeProfileApplyReceipt((await readOwnerConfiguration(target)).bytes);
  } catch (error) {
    if (error instanceof ProfileApplyError) throw error;
    throw new ProfileApplyError();
  }
}

export async function assertSafeProfileReceiptTarget(input: {
  projectRoot: string;
  receiptPath: string;
}): Promise<void> {
  try {
    const root = await exactProjectRoot(input.projectRoot);
    const target = await exactOwnerArtifactPath(input.receiptPath);
    assertRootIdentitySync(root.path, root.identity);
    assertSafeReceiptTargetSync(root.path, target);
    assertRootIdentitySync(root.path, root.identity);
  } catch (error) {
    if (error instanceof ProfileApplyError) throw error;
    throw new ProfileApplyError();
  }
}

export async function verifyProfileApplyReceiptPostimage(input: {
  projectRoot: string;
  receiptPath: string;
  receipt: string | Uint8Array | unknown;
  afterCurrentRead?: () => void | Promise<void>;
}): Promise<ProfileApplyReceiptV1> {
  try {
    const root = await exactProjectRoot(input.projectRoot);
    const receipt = decodeProfileApplyReceipt(input.receipt);
    const receiptPath = await exactOwnerArtifactPath(input.receiptPath);
    assertSafeReceiptTargetSync(root.path, receiptPath);
    const receiptBytes = Buffer.from(
      canonicalizeJsonEvidence(receipt as unknown as JsonEvidenceValue),
    );
    const namedReceipt = await readOwnerConfiguration(receiptPath);
    if (!Buffer.from(namedReceipt.bytes).equals(receiptBytes)) invalid();
    const target = resolve(root.path, ".env");
    await assertSafeTemporaryState(root.path);
    assertRootIdentitySync(root.path, root.identity);
    const current = await readOwnerConfiguration(target);
    assertRootIdentitySync(root.path, root.identity);
    await input.afterCurrentRead?.();
    assertRootIdentitySync(root.path, root.identity);
    if (!sameDirectoryIdentity(root.identity, receipt.preview.rootIdentity)) invalid();
    if (
      !sameIdentity(current.identity, receipt.afterIdentity) ||
      sha256(current.bytes) !== receipt.afterSha256
    )
      invalid();
    await assertUntracked(root.path, target, current.identity);
    assertReplayStateSync(
      root.path,
      root.identity,
      target,
      receipt.afterIdentity,
      receipt.afterSha256,
      receiptPath,
      namedReceipt.identity,
      receiptBytes,
    );
    return receipt;
  } catch (error) {
    if (error instanceof ProfileApplyError) throw error;
    throw new ProfileApplyError();
  }
}

export async function recoverProfileTransaction(input: {
  projectRoot: string;
  operation: "apply" | "rollback" | "seed";
  purpose: ModelProfilePurpose;
  previewSha256?: string;
  patchSha256: string;
  approvalBundleSha256?: string;
  applyReceiptSha256?: string;
  receiptPath: string;
  afterClaim?: () => void | Promise<void>;
  afterIntentClaim?: () => void | Promise<void>;
  afterTemporaryCleanup?: () => void | Promise<void>;
  afterClaimCleanup?: () => void | Promise<void>;
}): Promise<ProfileTransactionRecovery> {
  const ambiguous = (): Error =>
    input.operation === "rollback"
      ? new ProfileRollbackAmbiguousError()
      : new ProfileApplyAmbiguousError();
  try {
    const root = await exactProjectRoot(input.projectRoot);
    const receiptTarget = await exactOwnerArtifactPath(input.receiptPath);
    assertRootIdentitySync(root.path, root.identity);
    assertSafeReceiptTargetSync(root.path, receiptTarget);
    assertRootIdentitySync(root.path, root.identity);
    const intentPath = resolve(root.path, PROFILE_INTENT_NAME);
    const lockPath = resolve(root.path, PROFILE_LOCK_NAME);
    const claimPath = resolve(root.path, PROFILE_CLAIM_NAME);
    const [intentMetadata, lockMetadata, claimMetadata] = await Promise.all([
      optionalLstat(intentPath),
      optionalLstat(lockPath),
      optionalLstat(claimPath),
    ]);
    assertRootIdentitySync(root.path, root.identity);
    if (!intentMetadata && !lockMetadata && !claimMetadata) return { status: "none" };
    if (lockMetadata && !intentMetadata) throw ambiguous();
    let intentSourcePath = intentPath;
    let intentSourceMetadata = intentMetadata;
    if (!intentSourceMetadata) {
      if (!claimMetadata) throw ambiguous();
      intentSourcePath = claimPath;
      intentSourceMetadata = claimMetadata;
    }
    let intentRead: { bytes: Uint8Array; identity: ProfileConfigurationIdentityV1 };
    const intentClaimLinkPair =
      intentMetadata &&
      claimMetadata &&
      !lockMetadata &&
      identity(intentMetadata).device === identity(claimMetadata).device &&
      identity(intentMetadata).inode === identity(claimMetadata).inode;
    if (intentClaimLinkPair && intentMetadata && claimMetadata) {
      const intentLink = identity(intentMetadata);
      const claimLink = identity(claimMetadata);
      if (
        intentLink.links !== "2" ||
        claimLink.links !== "2" ||
        !sameInodeOwner(intentLink, claimLink) ||
        intentLink.device !== claimLink.device ||
        intentLink.inode !== claimLink.inode
      ) {
        throw ambiguous();
      }
      const [linkedIntent, linkedClaim] = await Promise.all([
        readOwnerLinkedArtifact(intentPath),
        readOwnerLinkedArtifact(claimPath),
      ]);
      assertRootIdentitySync(root.path, root.identity);
      if (
        !sameIdentity(linkedIntent.identity, linkedClaim.identity) ||
        !Buffer.from(linkedIntent.bytes).equals(Buffer.from(linkedClaim.bytes))
      ) {
        throw ambiguous();
      }
      intentRead = linkedIntent;
    } else {
      intentRead = await readOwnerConfiguration(intentSourcePath);
      assertRootIdentitySync(root.path, root.identity);
    }
    const intent = decodeProfileTransactionIntent(intentRead.bytes);
    if (
      intent.operation !== input.operation ||
      intent.purpose !== input.purpose ||
      (input.previewSha256 !== undefined && intent.previewSha256 !== input.previewSha256) ||
      intent.patchSha256 !== input.patchSha256 ||
      intent.approvalBundleSha256 !== (input.approvalBundleSha256 ?? null) ||
      intent.applyReceiptSha256 !== (input.applyReceiptSha256 ?? null) ||
      intent.receiptPathSha256 !== pathDigest(input.receiptPath) ||
      !sameDirectoryIdentity(intent.rootIdentity, root.identity) ||
      processIsAlive(intent.processId)
    )
      throw ambiguous();
    await assertRecoveryNamespace(root.path, intent.temporaryName);
    assertRootIdentitySync(root.path, root.identity);
    const lockIdentity = intent.lockIdentity;

    // Claim the dead transaction without following or replacing either artifact.
    const stableIntent =
      intentRead.identity.links === "2"
        ? readOwnerLinkedArtifactSync(intentSourcePath)
        : readOwnerConfigurationSync(intentSourcePath);
    if (
      !sameIdentity(stableIntent.identity, intentRead.identity) ||
      !Buffer.from(stableIntent.bytes).equals(Buffer.from(intentRead.bytes))
    )
      throw ambiguous();
    assertRootIdentitySync(root.path, root.identity);
    assertUntrackedSync(root.path, intentSourcePath, intentRead.identity);
    if (lockMetadata) assertUntrackedSync(root.path, lockPath, identity(lockMetadata));
    if (claimMetadata) assertUntrackedSync(root.path, claimPath, identity(claimMetadata));
    assertRootIdentitySync(root.path, root.identity);
    let claimIdentity: ProfileConfigurationIdentityV1;
    if (lockMetadata) {
      const currentLock = identity(lockMetadata);
      if (!sameInodeOwner(currentLock, lockIdentity)) throw ambiguous();
      if (!claimMetadata) {
        assertPathIdentitySync(lockPath, lockIdentity);
        await link(lockPath, claimPath);
        assertRootIdentitySync(root.path, root.identity);
        const linkedClaim = identity(await lstat(claimPath, { bigint: true }));
        assertRootIdentitySync(root.path, root.identity);
        if (!sameInodeOwner(linkedClaim, lockIdentity)) throw ambiguous();
        await input.afterClaim?.();
        assertRootIdentitySync(root.path, root.identity);
      } else {
        const linkedClaim = identity(claimMetadata);
        if (
          !sameInodeOwner(linkedClaim, lockIdentity) ||
          linkedClaim.device !== currentLock.device ||
          linkedClaim.inode !== currentLock.inode
        )
          throw ambiguous();
      }
      await assertRecoveryNamespace(root.path, intent.temporaryName);
      assertRootIdentitySync(root.path, root.identity);
      const finalLock = await lstat(lockPath, { bigint: true });
      assertRootIdentitySync(root.path, root.identity);
      assertUntrackedSync(root.path, lockPath, identity(finalLock));
      assertRootIdentitySync(root.path, root.identity);
      if (!(await safeUnlinkInode(lockPath, lockIdentity))) throw ambiguous();
      assertRootIdentitySync(root.path, root.identity);
      await syncDirectory(root.path);
      assertRootIdentitySync(root.path, root.identity);
      claimIdentity = identity(await lstat(claimPath, { bigint: true }));
      assertRootIdentitySync(root.path, root.identity);
      if (!sameIdentity(claimIdentity, lockIdentity)) throw ambiguous();
    } else if (claimMetadata) {
      claimIdentity = identity(await lstat(claimPath, { bigint: true }));
      assertRootIdentitySync(root.path, root.identity);
      const isLockClaim =
        sameIdentity(claimIdentity, intent.lockIdentity) && intentMetadata !== null;
      const isIntentClaim = sameIdentity(claimIdentity, intentRead.identity);
      if (!isLockClaim && !isIntentClaim) throw ambiguous();
    } else {
      // Post-commit cleanup removes the lock first. Claim the remaining
      // credential-free intent itself so a second recovery can resume if this
      // recovery is killed during marker cleanup.
      await link(intentPath, claimPath);
      assertRootIdentitySync(root.path, root.identity);
      claimIdentity = identity(await lstat(claimPath, { bigint: true }));
      assertRootIdentitySync(root.path, root.identity);
      if (
        claimIdentity.device !== intentRead.identity.device ||
        claimIdentity.inode !== intentRead.identity.inode
      )
        throw ambiguous();
      await input.afterIntentClaim?.();
      assertRootIdentitySync(root.path, root.identity);
      await input.afterClaim?.();
      assertRootIdentitySync(root.path, root.identity);
      assertUntrackedSync(root.path, intentPath, claimIdentity);
      assertUntrackedSync(root.path, claimPath, claimIdentity);
      assertRootIdentitySync(root.path, root.identity);
      // Keep both names until the terminal claim cleanup. If recovery is
      // interrupted after removing the claim, the original intent remains as
      // the last durable restart point.
      await syncDirectory(root.path);
      assertRootIdentitySync(root.path, root.identity);
    }

    const target = resolve(root.path, ".env");
    await assertRecoveryNamespace(root.path, intent.temporaryName);
    assertRootIdentitySync(root.path, root.identity);
    const targetMetadata = await optionalLstat(target);
    assertRootIdentitySync(root.path, root.identity);
    let current: { bytes: Uint8Array; identity: ProfileConfigurationIdentityV1 };
    if (!targetMetadata) {
      if (
        intent.operation !== "seed" ||
        !sameIdentity(intent.beforeIdentity, PROFILE_SEED_ABSENT_IDENTITY) ||
        intent.beforeSha256 !== sha256(new Uint8Array())
      ) {
        throw ambiguous();
      }
      current = { bytes: new Uint8Array(), identity: PROFILE_SEED_ABSENT_IDENTITY };
    } else {
      current = await readOwnerConfiguration(target);
      assertRootIdentitySync(root.path, root.identity);
      assertUntrackedSync(root.path, target, current.identity);
    }
    assertRootIdentitySync(root.path, root.identity);
    const before =
      sameIdentity(current.identity, intent.beforeIdentity) &&
      sha256(current.bytes) === intent.beforeSha256;
    const after =
      sameIdentity(current.identity, intent.plannedAfterIdentity) &&
      sha256(current.bytes) === intent.plannedAfterSha256;
    const temporary = resolve(root.path, intent.temporaryName);
    if (before) {
      const beforeTemporary = await optionalLstat(temporary);
      assertRootIdentitySync(root.path, root.identity);
      if (beforeTemporary) {
        const temporaryValue = await readOwnerConfiguration(temporary);
        assertRootIdentitySync(root.path, root.identity);
        assertUntrackedSync(root.path, temporary, temporaryValue.identity);
        assertRootIdentitySync(root.path, root.identity);
        if (
          !sameIdentity(temporaryValue.identity, intent.temporaryIdentity) ||
          sha256(temporaryValue.bytes) !== intent.plannedAfterSha256
        )
          throw ambiguous();
        if (!(await safeUnlink(temporary, temporaryValue.identity))) throw ambiguous();
        assertRootIdentitySync(root.path, root.identity);
        await syncDirectory(root.path);
        assertRootIdentitySync(root.path, root.identity);
        await input.afterTemporaryCleanup?.();
        assertRootIdentitySync(root.path, root.identity);
      }
      const abandonedReceiptPath = await exactOwnerArtifactPath(resolve(input.receiptPath));
      assertRootIdentitySync(root.path, root.identity);
      const abandonedStagePath = resolve(dirname(abandonedReceiptPath), intent.receiptStageName);
      const abandonedReceipt = await optionalLstat(abandonedReceiptPath);
      assertRootIdentitySync(root.path, root.identity);
      if (abandonedReceipt) throw ambiguous();
      const abandonedStage = await optionalLstat(abandonedStagePath);
      assertRootIdentitySync(root.path, root.identity);
      if (abandonedStage) {
        const staged = await readOwnerConfiguration(abandonedStagePath);
        assertRootIdentitySync(root.path, root.identity);
        assertUntrackedIfInRootSync(root.path, abandonedStagePath, staged.identity);
        const receiptBytes = Buffer.from(
          canonicalizeJsonEvidence(intent.receipt as unknown as JsonEvidenceValue),
        );
        if (
          !sameIdentity(staged.identity, intent.receiptStageIdentity) ||
          !Buffer.from(staged.bytes).equals(receiptBytes)
        )
          throw ambiguous();
        assertRootIdentitySync(root.path, root.identity);
        if (!(await safeUnlink(abandonedStagePath, staged.identity))) throw ambiguous();
        assertRootIdentitySync(root.path, root.identity);
        await syncDirectory(dirname(abandonedReceiptPath));
        assertRootIdentitySync(root.path, root.identity);
      }
      // Keep the JSON-bearing intent until last. Every preceding state remains
      // recoverable after process death: intent+claim, then intent-only.
      await assertRecoveryNamespace(root.path, intent.temporaryName);
      assertRootIdentitySync(root.path, root.identity);
      const abandonedClaim = await lstat(claimPath, { bigint: true });
      assertRootIdentitySync(root.path, root.identity);
      assertUntrackedSync(root.path, claimPath, identity(abandonedClaim));
      assertRootIdentitySync(root.path, root.identity);
      if (!(await safeUnlinkInode(claimPath, claimIdentity))) throw ambiguous();
      assertRootIdentitySync(root.path, root.identity);
      await syncDirectory(root.path);
      assertRootIdentitySync(root.path, root.identity);
      await input.afterClaimCleanup?.();
      assertRootIdentitySync(root.path, root.identity);
      const remainingIntent = await optionalLstat(intentPath);
      assertRootIdentitySync(root.path, root.identity);
      if (remainingIntent) assertUntrackedSync(root.path, intentPath, identity(remainingIntent));
      assertRootIdentitySync(root.path, root.identity);
      assertAbandonedRecoveryStateSync(
        root.path,
        root.identity,
        intent,
        target,
        abandonedReceiptPath,
        abandonedStagePath,
      );
      if (!(await safeUnlinkInode(intentPath, intentRead.identity))) throw ambiguous();
      assertRootIdentitySync(root.path, root.identity);
      await syncDirectory(root.path);
      assertAbandonedRecoveryStateSync(
        root.path,
        root.identity,
        intent,
        target,
        abandonedReceiptPath,
        abandonedStagePath,
      );
      return { status: "abandoned" };
    }
    if (!after) throw ambiguous();
    const afterTemporary = await optionalLstat(temporary);
    assertRootIdentitySync(root.path, root.identity);
    if (afterTemporary) throw ambiguous();
    await assertRecoveryNamespace(root.path, intent.temporaryName);
    assertRootIdentitySync(root.path, root.identity);
    const receiptPath = await exactOwnerArtifactPath(resolve(input.receiptPath));
    assertRootIdentitySync(root.path, root.identity);
    const receiptStagePath = resolve(dirname(receiptPath), intent.receiptStageName);
    if (basename(receiptStagePath) !== intent.receiptStageName) throw ambiguous();
    const receiptBytes = Buffer.from(
      canonicalizeJsonEvidence(intent.receipt as unknown as JsonEvidenceValue),
    );
    const [receiptMetadata, receiptStageMetadata] = await Promise.all([
      optionalLstat(receiptPath),
      optionalLstat(receiptStagePath),
    ]);
    assertRootIdentitySync(root.path, root.identity);
    if (receiptStageMetadata) {
      const stage = await readOwnerLinkedArtifact(receiptStagePath);
      assertRootIdentitySync(root.path, root.identity);
      assertUntrackedIfInRootSync(root.path, receiptStagePath, stage.identity);
      if (
        !sameInodeOwner(stage.identity, intent.receiptStageIdentity) ||
        !Buffer.from(stage.bytes).equals(receiptBytes)
      )
        throw ambiguous();
      if (receiptMetadata) {
        const linkedReceipt = await readOwnerLinkedArtifact(receiptPath);
        assertRootIdentitySync(root.path, root.identity);
        assertUntrackedIfInRootSync(root.path, receiptPath, linkedReceipt.identity);
        if (
          !sameInodeOwner(linkedReceipt.identity, intent.receiptStageIdentity) ||
          linkedReceipt.identity.device !== stage.identity.device ||
          linkedReceipt.identity.inode !== stage.identity.inode ||
          linkedReceipt.identity.links !== "2" ||
          stage.identity.links !== "2" ||
          !Buffer.from(linkedReceipt.bytes).equals(receiptBytes)
        )
          throw ambiguous();
      } else {
        if (!sameIdentity(stage.identity, intent.receiptStageIdentity)) throw ambiguous();
        await assertRecoveryNamespace(root.path, intent.temporaryName);
        assertRootIdentitySync(root.path, root.identity);
        assertUntrackedSync(root.path, target, current.identity);
        assertUntrackedIfInRootSync(root.path, receiptStagePath, stage.identity);
        assertRootIdentitySync(root.path, root.identity);
        await link(receiptStagePath, receiptPath);
        assertRootIdentitySync(root.path, root.identity);
      }
      assertRootIdentitySync(root.path, root.identity);
      assertUntrackedIfInRootSync(root.path, receiptStagePath, stage.identity);
      const linkedFinalMetadata = await lstat(receiptPath, { bigint: true });
      assertRootIdentitySync(root.path, root.identity);
      assertUntrackedIfInRootSync(root.path, receiptPath, identity(linkedFinalMetadata));
      assertRootIdentitySync(root.path, root.identity);
      if (!(await safeUnlinkInode(receiptStagePath, intent.receiptStageIdentity))) {
        throw ambiguous();
      }
      assertRootIdentitySync(root.path, root.identity);
      await syncDirectory(dirname(receiptPath));
      assertRootIdentitySync(root.path, root.identity);
    } else if (!receiptMetadata) {
      throw ambiguous();
    }
    let recoveredReceipt: ProfileApplyReceiptV1 | ProfileRollbackReceiptV1 | ProfileSeedReceiptV1;
    const finalReceipt = await readOwnerConfiguration(receiptPath);
    assertRootIdentitySync(root.path, root.identity);
    assertUntrackedIfInRootSync(root.path, receiptPath, finalReceipt.identity);
    if (
      !sameIdentity(finalReceipt.identity, intent.receiptStageIdentity) ||
      !Buffer.from(finalReceipt.bytes).equals(receiptBytes)
    )
      throw ambiguous();
    recoveredReceipt =
      intent.operation === "apply"
        ? decodeProfileApplyReceipt(finalReceipt.bytes)
        : intent.operation === "seed"
          ? decodeProfileSeedReceipt(finalReceipt.bytes)
          : decodeProfileRollbackReceipt(finalReceipt.bytes);
    if (!equal(recoveredReceipt, intent.receipt)) throw ambiguous();
    await assertRecoveryNamespace(root.path, intent.temporaryName);
    assertRootIdentitySync(root.path, root.identity);
    assertUntrackedSync(root.path, target, current.identity);
    const finalClaim = await lstat(claimPath, { bigint: true });
    assertRootIdentitySync(root.path, root.identity);
    assertUntrackedSync(root.path, claimPath, identity(finalClaim));
    assertRootIdentitySync(root.path, root.identity);
    if (!(await safeUnlinkInode(claimPath, claimIdentity))) throw ambiguous();
    assertRootIdentitySync(root.path, root.identity);
    await syncDirectory(root.path);
    assertRootIdentitySync(root.path, root.identity);
    await input.afterClaimCleanup?.();
    assertRootIdentitySync(root.path, root.identity);
    const finalIntent = await optionalLstat(intentPath);
    assertRootIdentitySync(root.path, root.identity);
    if (finalIntent) assertUntrackedSync(root.path, intentPath, identity(finalIntent));
    assertRootIdentitySync(root.path, root.identity);
    assertCompletedRecoveryStateSync(
      root.path,
      root.identity,
      intent,
      target,
      receiptPath,
      receiptBytes,
    );
    if (!(await safeUnlinkInode(intentPath, intentRead.identity))) throw ambiguous();
    assertRootIdentitySync(root.path, root.identity);
    await syncDirectory(root.path);
    assertCompletedRecoveryStateSync(
      root.path,
      root.identity,
      intent,
      target,
      receiptPath,
      receiptBytes,
    );
    return { status: "completed", receipt: recoveredReceipt };
  } catch (error) {
    if (
      error instanceof ProfileApplyAmbiguousError ||
      error instanceof ProfileRollbackAmbiguousError
    )
      throw error;
    throw ambiguous();
  }
}

export function assertCompletedRecoveryStateSync(
  projectRoot: string,
  rootIdentity: ProfileConfigurationIdentityV1,
  intent: ProfileTransactionIntentV1,
  target: string,
  receiptPath: string,
  receiptBytes: Uint8Array,
): void {
  assertRootIdentitySync(projectRoot, rootIdentity);
  const configuration = readOwnerConfigurationSync(target);
  const receipt = readOwnerConfigurationSync(receiptPath);
  if (
    !sameIdentity(configuration.identity, intent.plannedAfterIdentity) ||
    sha256(configuration.bytes) !== intent.plannedAfterSha256 ||
    !sameIdentity(receipt.identity, intent.receiptStageIdentity) ||
    !Buffer.from(receipt.bytes).equals(Buffer.from(receiptBytes))
  )
    throw new ProfileApplyError();
  assertNormalTransactionArtifactsSync(projectRoot, rootIdentity, [
    { path: target, identity: configuration.identity },
    { path: receiptPath, identity: receipt.identity },
  ]);
  assertRootIdentitySync(projectRoot, rootIdentity);
}

function optionalAbandonedConfiguration(
  target: string,
  intent: ProfileTransactionIntentV1,
): { bytes: Uint8Array; identity: ProfileConfigurationIdentityV1 } {
  try {
    return readOwnerConfigurationSync(target);
  } catch (error) {
    if (
      isMissing(error) &&
      intent.operation === "seed" &&
      sameIdentity(intent.beforeIdentity, PROFILE_SEED_ABSENT_IDENTITY)
    ) {
      return { bytes: new Uint8Array(), identity: PROFILE_SEED_ABSENT_IDENTITY };
    }
    throw error;
  }
}

export function assertAbandonedRecoveryStateSync(
  projectRoot: string,
  rootIdentity: ProfileConfigurationIdentityV1,
  intent: ProfileTransactionIntentV1,
  target: string,
  receiptPath: string,
  receiptStagePath: string,
): void {
  assertRootIdentitySync(projectRoot, rootIdentity);
  const configuration = optionalAbandonedConfiguration(target, intent);
  if (
    !sameIdentity(configuration.identity, intent.beforeIdentity) ||
    sha256(configuration.bytes) !== intent.beforeSha256
  )
    throw new ProfileApplyError();
  if (!sameIdentity(configuration.identity, PROFILE_SEED_ABSENT_IDENTITY)) {
    assertNormalTransactionArtifactsSync(projectRoot, rootIdentity, [
      { path: target, identity: configuration.identity },
    ]);
  }
  for (const path of [receiptPath, receiptStagePath]) {
    try {
      lstatSync(path, { bigint: true });
      throw new ProfileApplyError();
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    assertRootIdentitySync(projectRoot, rootIdentity);
  }
}

export function serializeProfileRollbackReceipt(value: ProfileRollbackReceiptV1): string {
  return canonicalizeJsonEvidence(
    decodeProfileRollbackReceipt(value) as unknown as JsonEvidenceValue,
  );
}

export function decodeProfileRollbackReceipt(
  value: string | Uint8Array | unknown,
): ProfileRollbackReceiptV1 {
  try {
    const parsed =
      typeof value === "string" || value instanceof Uint8Array ? parseJsonEvidence(value) : value;
    assertPlainTree(parsed);
    const receipt = structuredClone(parsed) as ProfileRollbackReceiptV1;
    const record = plainRecord(receipt);
    exactKeys(record, [
      "schemaVersion",
      "kind",
      "purpose",
      "target",
      "rolledBackAt",
      "rollbackPreviewSha256",
      "applyReceiptSha256",
      "patchSha256",
      "fromSha256",
      "toSha256",
      "beforeIdentity",
      "afterIdentity",
      "tracked",
      "preview",
      "sha256",
    ]);
    if (
      receipt.schemaVersion !== 1 ||
      receipt.kind !== "docsfab-profile-rollback-receipt" ||
      (receipt.purpose !== "policy" && receipt.purpose !== "judge") ||
      receipt.target !== ".env" ||
      receipt.tracked !== false ||
      timestamp(new Date(receipt.rolledBackAt)) !== receipt.rolledBackAt
    )
      invalid();
    for (const sha of [
      receipt.rollbackPreviewSha256,
      receipt.applyReceiptSha256,
      receipt.patchSha256,
      receipt.fromSha256,
      receipt.toSha256,
      receipt.sha256,
    ]) {
      if (!hexDigest(sha)) invalid();
    }
    validateIdentity(receipt.beforeIdentity);
    validateIdentity(receipt.afterIdentity);
    const preview = decodeProfileRollbackPreview(receipt.preview);
    if (
      receipt.purpose !== preview.purpose ||
      receipt.rollbackPreviewSha256 !== preview.sha256 ||
      receipt.applyReceiptSha256 !== preview.receiptSha256 ||
      receipt.patchSha256 !== preview.patchSha256 ||
      receipt.fromSha256 !== preview.fromSha256 ||
      receipt.toSha256 !== preview.toSha256 ||
      !sameIdentity(receipt.beforeIdentity, preview.currentIdentity) ||
      receipt.fromSha256 === receipt.toSha256 ||
      sameIdentity(receipt.beforeIdentity, receipt.afterIdentity)
    )
      invalid();
    const unsigned = { ...record };
    delete unsigned.sha256;
    if (digest(unsigned) !== receipt.sha256 || detectCredentialRuleIdsInValue(receipt).length > 0)
      invalid();
    return deepFreeze(receipt);
  } catch (error) {
    if (error instanceof ProfileApplyError) throw error;
    throw new ProfileApplyError();
  }
}

export async function loadProfileRollbackReceipt(path: string): Promise<ProfileRollbackReceiptV1> {
  try {
    const target = await exactOwnerArtifactPath(path);
    return decodeProfileRollbackReceipt((await readOwnerConfiguration(target)).bytes);
  } catch (error) {
    if (error instanceof ProfileApplyError) throw error;
    throw new ProfileApplyError();
  }
}

export async function verifyProfileRollbackReceiptPostimage(input: {
  projectRoot: string;
  receiptPath: string;
  receipt: string | Uint8Array | unknown;
  afterCurrentRead?: () => void | Promise<void>;
}): Promise<ProfileRollbackReceiptV1> {
  try {
    const root = await exactProjectRoot(input.projectRoot);
    const receipt = decodeProfileRollbackReceipt(input.receipt);
    const receiptPath = await exactOwnerArtifactPath(input.receiptPath);
    assertSafeReceiptTargetSync(root.path, receiptPath);
    const receiptBytes = Buffer.from(
      canonicalizeJsonEvidence(receipt as unknown as JsonEvidenceValue),
    );
    const namedReceipt = await readOwnerConfiguration(receiptPath);
    if (!Buffer.from(namedReceipt.bytes).equals(receiptBytes)) invalid();
    if (!sameDirectoryIdentity(root.identity, receipt.preview.rootIdentity)) invalid();
    const target = resolve(root.path, ".env");
    await assertSafeTemporaryState(root.path);
    assertRootIdentitySync(root.path, root.identity);
    const current = await readOwnerConfiguration(target);
    assertRootIdentitySync(root.path, root.identity);
    await input.afterCurrentRead?.();
    assertRootIdentitySync(root.path, root.identity);
    if (
      !sameIdentity(current.identity, receipt.afterIdentity) ||
      sha256(current.bytes) !== receipt.toSha256
    )
      invalid();
    await assertUntracked(root.path, target, current.identity);
    assertReplayStateSync(
      root.path,
      root.identity,
      target,
      receipt.afterIdentity,
      receipt.toSha256,
      receiptPath,
      namedReceipt.identity,
      receiptBytes,
    );
    return receipt;
  } catch (error) {
    if (error instanceof ProfileApplyError) throw error;
    throw new ProfileApplyError();
  }
}

export function assertReplayStateSync(
  projectRoot: string,
  rootIdentity: ProfileConfigurationIdentityV1,
  target: string,
  targetIdentity: ProfileConfigurationIdentityV1,
  targetSha256: string,
  receiptPath: string,
  receiptIdentity: ProfileConfigurationIdentityV1,
  receiptBytes: Uint8Array,
): void {
  assertRootIdentitySync(projectRoot, rootIdentity);
  const configuration = readOwnerConfigurationSync(target);
  const receipt = readOwnerConfigurationSync(receiptPath);
  if (
    !sameIdentity(configuration.identity, targetIdentity) ||
    sha256(configuration.bytes) !== targetSha256 ||
    !sameIdentity(receipt.identity, receiptIdentity) ||
    !Buffer.from(receipt.bytes).equals(Buffer.from(receiptBytes))
  )
    invalid();
  assertNormalTransactionArtifactsSync(projectRoot, rootIdentity, [
    { path: target, identity: configuration.identity },
    { path: receiptPath, identity: receipt.identity },
  ]);
  assertRootIdentitySync(projectRoot, rootIdentity);
}

export function decodeProfileTransactionIntent(
  value: string | Uint8Array | unknown,
): ProfileTransactionIntentV1 {
  try {
    const parsed =
      typeof value === "string" || value instanceof Uint8Array ? parseJsonEvidence(value) : value;
    assertPlainTree(parsed);
    const intent = structuredClone(parsed) as ProfileTransactionIntentV1;
    const record = plainRecord(intent);
    exactKeys(record, [
      "schemaVersion",
      "kind",
      "operation",
      "createdAt",
      "processId",
      "target",
      "lockName",
      "lockIdentity",
      "rootIdentity",
      "beforeIdentity",
      "beforeSha256",
      "plannedAfterIdentity",
      "plannedAfterSha256",
      "temporaryName",
      "temporaryIdentity",
      "receiptPathSha256",
      "receiptStageName",
      "receiptStageIdentity",
      "purpose",
      "previewSha256",
      "patchSha256",
      "approvalBundleSha256",
      "applyReceiptSha256",
      "receipt",
      "sha256",
    ]);
    if (
      intent.schemaVersion !== 1 ||
      intent.kind !== "docsfab-profile-transaction-intent" ||
      (intent.operation !== "apply" &&
        intent.operation !== "rollback" &&
        intent.operation !== "seed") ||
      (intent.purpose !== "policy" && intent.purpose !== "judge") ||
      intent.target !== ".env" ||
      intent.lockName !== PROFILE_LOCK_NAME ||
      !Number.isSafeInteger(intent.processId) ||
      intent.processId <= 0 ||
      timestamp(new Date(intent.createdAt)) !== intent.createdAt
    )
      invalid();
    for (const identityValue of [
      intent.lockIdentity,
      intent.rootIdentity,
      intent.beforeIdentity,
      intent.plannedAfterIdentity,
      intent.temporaryIdentity,
      intent.receiptStageIdentity,
    ]) {
      validateIdentity(identityValue);
    }
    for (const sha of [
      intent.beforeSha256,
      intent.plannedAfterSha256,
      intent.receiptPathSha256,
      intent.previewSha256,
      intent.patchSha256,
      intent.sha256,
    ])
      if (!hexDigest(sha)) invalid();
    if (intent.approvalBundleSha256 !== null && !hexDigest(intent.approvalBundleSha256)) invalid();
    if (intent.applyReceiptSha256 !== null && !hexDigest(intent.applyReceiptSha256)) invalid();
    const pattern =
      intent.operation === "rollback"
        ? /^\.env\.docsfab-rollback-[a-f0-9]{24}$/u
        : /^\.env\.docsfab-new-[a-f0-9]{24}$/u;
    if (
      !pattern.test(intent.temporaryName) ||
      !sameIdentity(intent.plannedAfterIdentity, intent.temporaryIdentity)
    )
      invalid();
    if (
      intent.receiptStageName !== receiptStageName(intent.receiptPathSha256, intent.receipt.sha256)
    ) {
      invalid();
    }
    if (intent.operation === "apply") {
      const receipt = decodeProfileApplyReceipt(intent.receipt);
      if (
        intent.approvalBundleSha256 !== receipt.approvalBundleSha256 ||
        intent.applyReceiptSha256 !== null ||
        intent.previewSha256 !== receipt.previewSha256 ||
        intent.patchSha256 !== receipt.patchSha256 ||
        intent.purpose !== receipt.purpose ||
        intent.beforeSha256 !== receipt.beforeSha256 ||
        intent.plannedAfterSha256 !== receipt.afterSha256 ||
        !sameIdentity(intent.beforeIdentity, receipt.beforeIdentity) ||
        !sameIdentity(intent.plannedAfterIdentity, receipt.afterIdentity)
      )
        invalid();
      intent.receipt = receipt;
    } else if (intent.operation === "seed") {
      const receipt = decodeProfileSeedReceipt(intent.receipt);
      if (
        intent.approvalBundleSha256 !== null ||
        intent.applyReceiptSha256 !== null ||
        intent.previewSha256 !== receipt.previewSha256 ||
        intent.patchSha256 !== receipt.patchSha256 ||
        intent.purpose !== receipt.purpose ||
        intent.beforeSha256 !== receipt.beforeSha256 ||
        intent.plannedAfterSha256 !== receipt.afterSha256 ||
        !sameIdentity(intent.beforeIdentity, receipt.beforeIdentity) ||
        !sameIdentity(intent.plannedAfterIdentity, receipt.afterIdentity)
      )
        invalid();
      intent.receipt = receipt;
    } else {
      const receipt = decodeProfileRollbackReceipt(intent.receipt);
      if (
        intent.approvalBundleSha256 !== null ||
        intent.applyReceiptSha256 !== receipt.applyReceiptSha256 ||
        intent.previewSha256 !== receipt.rollbackPreviewSha256 ||
        intent.patchSha256 !== receipt.patchSha256 ||
        intent.purpose !== receipt.purpose ||
        intent.beforeSha256 !== receipt.fromSha256 ||
        intent.plannedAfterSha256 !== receipt.toSha256 ||
        !sameIdentity(intent.beforeIdentity, receipt.beforeIdentity) ||
        !sameIdentity(intent.plannedAfterIdentity, receipt.afterIdentity)
      )
        invalid();
      intent.receipt = receipt;
    }
    const unsigned = { ...record };
    delete unsigned.sha256;
    if (digest(unsigned) !== intent.sha256 || detectCredentialRuleIdsInValue(intent).length > 0)
      invalid();
    return deepFreeze(intent);
  } catch (error) {
    if (error instanceof ProfileApplyError) throw error;
    throw new ProfileApplyError();
  }
}

export function decodeProfileRollbackPreview(value: unknown): ProfileRollbackPreviewV1 {
  assertPlainTree(value);
  const preview = structuredClone(value) as ProfileRollbackPreviewV1;
  const previewRecord = plainRecord(preview);
  exactKeys(previewRecord, [
    "schemaVersion",
    "kind",
    "purpose",
    "target",
    "rootIdentity",
    "currentIdentity",
    "receiptSha256",
    "patchSha256",
    "fromSha256",
    "toSha256",
    "tracked",
    "sha256",
  ]);
  if (
    preview.schemaVersion !== 1 ||
    preview.kind !== "docsfab-profile-rollback-preview" ||
    (preview.purpose !== "policy" && preview.purpose !== "judge") ||
    preview.target !== ".env" ||
    preview.tracked !== false
  )
    invalid();
  validateIdentity(preview.rootIdentity);
  validateIdentity(preview.currentIdentity);
  for (const sha of [
    preview.receiptSha256,
    preview.patchSha256,
    preview.fromSha256,
    preview.toSha256,
    preview.sha256,
  ])
    if (!hexDigest(sha)) invalid();
  validateDigestObject(preview);
  return deepFreeze(preview);
}

export function decodeProfileApplyPreview(value: unknown): ProfileApplyPreviewV1 {
  assertPlainTree(value);
  const preview = structuredClone(value) as ProfileApplyPreviewV1;
  const record = plainRecord(preview);
  exactKeys(record, [
    "schemaVersion",
    "kind",
    "purpose",
    "target",
    "rootIdentity",
    "targetIdentity",
    "inspectionSha256",
    "approvalBundleSha256",
    "approvalSha256",
    "approvalEvidenceSha256",
    "authorizationSha256",
    "proposalSha256",
    "proposalProvenanceSha256",
    "decisionSha256",
    "patch",
    "tracked",
    "sha256",
  ]);
  if (
    preview.schemaVersion !== 1 ||
    preview.kind !== "docsfab-profile-apply-preview" ||
    (preview.purpose !== "policy" && preview.purpose !== "judge") ||
    preview.target !== ".env" ||
    preview.tracked !== false
  )
    invalid();
  validateIdentity(preview.rootIdentity);
  validateIdentity(preview.targetIdentity);
  for (const sha of [
    preview.inspectionSha256,
    preview.approvalBundleSha256,
    preview.approvalSha256,
    preview.approvalEvidenceSha256,
    preview.authorizationSha256,
    preview.proposalSha256,
    preview.proposalProvenanceSha256,
    preview.decisionSha256,
    preview.sha256,
  ])
    if (!hexDigest(sha)) invalid();
  const patch = decodeProfileEnvironmentPatch(preview.patch);
  if (patch.purpose !== preview.purpose) invalid();
  validateDigestObject(preview);
  return deepFreeze(preview);
}

export function decodeProfileSeedPatch(value: unknown): ProfileSeedPatchV1 {
  assertPlainTree(value);
  const patch = structuredClone(value) as ProfileSeedPatchV1;
  const record = plainRecord(patch);
  exactKeys(record, [
    "schemaVersion",
    "kind",
    "purpose",
    "preset",
    "created",
    "changedKeys",
    "beforeSha256",
    "afterSha256",
    "sha256",
  ]);
  if (
    patch.schemaVersion !== 1 ||
    patch.kind !== "docsfab-profile-seed-patch" ||
    patch.purpose !== "policy" ||
    (patch.preset !== null && (typeof patch.preset !== "string" || patch.preset.length === 0)) ||
    typeof patch.created !== "boolean" ||
    !Array.isArray(patch.changedKeys) ||
    new Set(patch.changedKeys).size !== patch.changedKeys.length ||
    patch.changedKeys.some((key) => typeof key !== "string" || !key.startsWith("MODEL_"))
  )
    invalid();
  for (const sha of [patch.beforeSha256, patch.afterSha256, patch.sha256])
    if (!hexDigest(sha)) invalid();
  if (patch.created && patch.changedKeys.length === 0) invalid();
  if (!patch.created && patch.changedKeys.length === 0 && patch.beforeSha256 !== patch.afterSha256)
    invalid();
  if (patch.changedKeys.length > 0 && patch.beforeSha256 === patch.afterSha256) invalid();
  validateDigestObject(patch);
  if (detectCredentialRuleIdsInValue(patch).length > 0) invalid();
  return deepFreeze(patch);
}

export function decodeProfileSeedPreview(value: unknown): ProfileSeedPreviewV1 {
  assertPlainTree(value);
  const preview = structuredClone(value) as ProfileSeedPreviewV1;
  const record = plainRecord(preview);
  exactKeys(record, [
    "schemaVersion",
    "kind",
    "purpose",
    "target",
    "rootIdentity",
    "targetIdentity",
    "keySource",
    "patch",
    "tracked",
    "sha256",
  ]);
  if (
    preview.schemaVersion !== 1 ||
    preview.kind !== "docsfab-profile-seed-preview" ||
    preview.purpose !== "policy" ||
    preview.target !== ".env" ||
    preview.tracked !== false ||
    (preview.keySource !== "ambient" && preview.keySource !== "config-root")
  )
    invalid();
  validateIdentity(preview.rootIdentity);
  validateIdentity(preview.targetIdentity);
  if (!hexDigest(preview.sha256)) invalid();
  const patch = decodeProfileSeedPatch(preview.patch);
  if (patch.created !== sameIdentity(preview.targetIdentity, PROFILE_SEED_ABSENT_IDENTITY))
    invalid();
  validateDigestObject(preview);
  if (detectCredentialRuleIdsInValue(preview).length > 0) invalid();
  return deepFreeze(preview);
}

export function decodeProfileSeedReceipt(
  value: string | Uint8Array | unknown,
): ProfileSeedReceiptV1 {
  try {
    const parsed =
      typeof value === "string" || value instanceof Uint8Array ? parseJsonEvidence(value) : value;
    assertPlainTree(parsed);
    const receipt = structuredClone(parsed) as ProfileSeedReceiptV1;
    const record = plainRecord(receipt);
    exactKeys(record, [
      "schemaVersion",
      "kind",
      "purpose",
      "target",
      "seededAt",
      "applied",
      "created",
      "keySource",
      "previewSha256",
      "beforeSha256",
      "afterSha256",
      "beforeIdentity",
      "afterIdentity",
      "patchSha256",
      "tracked",
      "preview",
      "sha256",
    ]);
    if (
      receipt.schemaVersion !== 1 ||
      receipt.kind !== "docsfab-profile-seed-receipt" ||
      receipt.purpose !== "policy" ||
      receipt.target !== ".env" ||
      receipt.tracked !== false ||
      typeof receipt.applied !== "boolean" ||
      typeof receipt.created !== "boolean" ||
      (receipt.keySource !== "ambient" && receipt.keySource !== "config-root") ||
      timestamp(new Date(receipt.seededAt)) !== receipt.seededAt
    )
      invalid();
    for (const sha of [
      receipt.sha256,
      receipt.previewSha256,
      receipt.beforeSha256,
      receipt.afterSha256,
      receipt.patchSha256,
    ])
      if (!hexDigest(sha)) invalid();
    validateIdentity(receipt.beforeIdentity);
    validateIdentity(receipt.afterIdentity);
    const preview = decodeProfileSeedPreview(receipt.preview);
    const patch = decodeProfileSeedPatch(preview.patch);
    if (
      receipt.previewSha256 !== preview.sha256 ||
      receipt.beforeSha256 !== patch.beforeSha256 ||
      receipt.afterSha256 !== patch.afterSha256 ||
      receipt.patchSha256 !== patch.sha256 ||
      receipt.created !== patch.created ||
      receipt.keySource !== preview.keySource ||
      !sameIdentity(receipt.beforeIdentity, preview.targetIdentity)
    )
      invalid();
    if (
      !receipt.applied &&
      (patch.changedKeys.length !== 0 ||
        !sameIdentity(receipt.beforeIdentity, receipt.afterIdentity) ||
        receipt.beforeSha256 !== receipt.afterSha256)
    )
      invalid();
    if (
      receipt.applied &&
      (patch.changedKeys.length === 0 ||
        receipt.beforeSha256 === receipt.afterSha256 ||
        sameIdentity(receipt.beforeIdentity, receipt.afterIdentity))
    )
      invalid();
    const unsigned = { ...record };
    delete unsigned.sha256;
    if (digest(unsigned) !== receipt.sha256 || detectCredentialRuleIdsInValue(receipt).length > 0)
      invalid();
    return deepFreeze(receipt);
  } catch (error) {
    if (error instanceof ProfileApplyError) throw error;
    throw new ProfileApplyError();
  }
}

export function serializeProfileSeedReceipt(value: ProfileSeedReceiptV1): string {
  return canonicalizeJsonEvidence(decodeProfileSeedReceipt(value) as unknown as JsonEvidenceValue);
}

export async function loadProfileSeedReceipt(path: string): Promise<ProfileSeedReceiptV1> {
  try {
    const target = await exactOwnerArtifactPath(path);
    return decodeProfileSeedReceipt((await readOwnerConfiguration(target)).bytes);
  } catch (error) {
    if (error instanceof ProfileApplyError) throw error;
    throw new ProfileApplyError();
  }
}

export async function verifyProfileSeedReceiptPostimage(input: {
  projectRoot: string;
  receiptPath: string;
  receipt: string | Uint8Array | unknown;
}): Promise<ProfileSeedReceiptV1> {
  try {
    const root = await exactProjectRoot(input.projectRoot);
    const receipt = decodeProfileSeedReceipt(input.receipt);
    const receiptPath = await exactOwnerArtifactPath(input.receiptPath);
    assertSafeReceiptTargetSync(root.path, receiptPath);
    const receiptBytes = Buffer.from(
      canonicalizeJsonEvidence(receipt as unknown as JsonEvidenceValue),
    );
    const namedReceipt = await readOwnerConfiguration(receiptPath);
    if (!Buffer.from(namedReceipt.bytes).equals(receiptBytes)) invalid();
    const target = resolve(root.path, ".env");
    await assertSafeTemporaryState(root.path);
    assertRootIdentitySync(root.path, root.identity);
    const current = await readOwnerConfiguration(target);
    if (!sameDirectoryIdentity(root.identity, receipt.preview.rootIdentity)) invalid();
    if (
      !sameIdentity(current.identity, receipt.afterIdentity) ||
      sha256(current.bytes) !== receipt.afterSha256
    )
      invalid();
    await assertUntracked(root.path, target, current.identity);
    return receipt;
  } catch (error) {
    if (error instanceof ProfileApplyError) throw error;
    throw new ProfileApplyError();
  }
}
