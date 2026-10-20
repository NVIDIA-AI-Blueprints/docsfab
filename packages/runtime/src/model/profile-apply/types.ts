// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ModelProfilePurpose } from "../catalog-contracts.js";
import type { ProfileEnvironmentPatchV1 } from "../profile-environment.js";

export const PROFILE_LOCK_NAME = ".env.docsfab-apply.lock" as const;
export const PROFILE_INTENT_NAME = ".env.docsfab-transaction.json" as const;
export const PROFILE_CLAIM_NAME = ".env.docsfab-recovery.claim" as const;
export const PROFILE_SEED_RECEIPT_NAME = ".env.docsfab-seed-receipt.json" as const;

export interface ProfileConfigurationIdentityV1 {
  device: string;
  inode: string;
  uid: number;
  gid: number;
  mode: number;
  links: string;
  size: string;
}

/** Sentinel identity for a missing config-root `.env` before first-run seed. */
export const PROFILE_SEED_ABSENT_IDENTITY: ProfileConfigurationIdentityV1 = {
  device: "0",
  inode: "0",
  uid: 0,
  gid: 0,
  mode: 0,
  links: "0",
  size: "0",
};

export interface ProfileApplyPreviewV1 {
  schemaVersion: 1;
  kind: "docsfab-profile-apply-preview";
  purpose: ModelProfilePurpose;
  target: ".env";
  rootIdentity: ProfileConfigurationIdentityV1;
  targetIdentity: ProfileConfigurationIdentityV1;
  inspectionSha256: string;
  approvalBundleSha256: string;
  approvalSha256: string;
  approvalEvidenceSha256: string;
  authorizationSha256: string;
  proposalSha256: string;
  proposalProvenanceSha256: string;
  decisionSha256: string;
  patch: ProfileEnvironmentPatchV1;
  tracked: false;
  sha256: string;
}

export interface PreparedProfileApply {
  preview: ProfileApplyPreviewV1;
  /** Exact post-image. Never serialize or retain this value as evidence. */
  bytes: Uint8Array;
  projectRoot: string;
}

export interface ProfileApplyHooks {
  afterTemporarySync?: (paths: {
    projectRoot: string;
    target: string;
    temporary: string;
  }) => void | Promise<void>;
  beforeRename?: (paths: { projectRoot: string; target: string; temporary: string }) => void;
  afterRename?: (paths: { projectRoot: string; target: string }) => void | Promise<void>;
  beforeRecoveryRename?: (paths: {
    projectRoot: string;
    target: string;
    temporary: string;
  }) => void;
  afterReceiptStage?: (paths: { target: string; temporary: string }) => void | Promise<void>;
  afterReceiptLink?: (paths: { target: string; temporary: string }) => void | Promise<void>;
  afterIntentSync?: (path: string) => void | Promise<void>;
  afterReceiptPublish?: (path: string) => void | Promise<void>;
  beforeCleanup?: (path: string) => void | Promise<void>;
}

export type ProfileTransactionRecovery =
  | { status: "none" | "abandoned" }
  | {
      status: "completed";
      receipt: ProfileApplyReceiptV1 | ProfileRollbackReceiptV1 | ProfileSeedReceiptV1;
    };

export type ProfileSeedKeySource = "ambient" | "config-root";

export interface ProfileSeedPatchV1 {
  schemaVersion: 1;
  kind: "docsfab-profile-seed-patch";
  purpose: "policy";
  preset: string | null;
  created: boolean;
  changedKeys: string[];
  beforeSha256: string;
  afterSha256: string;
  sha256: string;
}

export interface ProfileSeedPreviewV1 {
  schemaVersion: 1;
  kind: "docsfab-profile-seed-preview";
  purpose: "policy";
  target: ".env";
  rootIdentity: ProfileConfigurationIdentityV1;
  targetIdentity: ProfileConfigurationIdentityV1;
  keySource: ProfileSeedKeySource;
  patch: ProfileSeedPatchV1;
  tracked: false;
  sha256: string;
}

export interface PreparedProfileSeed {
  preview: ProfileSeedPreviewV1;
  /** Exact post-image. Never serialize or retain this value as evidence. */
  bytes: Uint8Array;
  projectRoot: string;
}

export interface ProfileSeedReceiptV1 {
  schemaVersion: 1;
  kind: "docsfab-profile-seed-receipt";
  purpose: "policy";
  target: ".env";
  seededAt: string;
  applied: boolean;
  created: boolean;
  keySource: ProfileSeedKeySource;
  previewSha256: string;
  beforeSha256: string;
  afterSha256: string;
  beforeIdentity: ProfileConfigurationIdentityV1;
  afterIdentity: ProfileConfigurationIdentityV1;
  patchSha256: string;
  tracked: false;
  preview: ProfileSeedPreviewV1;
  sha256: string;
}

export interface ProfileApplyReceiptV1 {
  schemaVersion: 1;
  kind: "docsfab-profile-apply-receipt";
  purpose: ModelProfilePurpose;
  target: ".env";
  appliedAt: string;
  applied: boolean;
  previewSha256: string;
  beforeSha256: string;
  afterSha256: string;
  beforeIdentity: ProfileConfigurationIdentityV1;
  afterIdentity: ProfileConfigurationIdentityV1;
  inspectionSha256: string;
  approvalBundleSha256: string;
  approvalSha256: string;
  approvalEvidenceSha256: string;
  authorizationSha256: string;
  proposalSha256: string;
  proposalProvenanceSha256: string;
  decisionSha256: string;
  patchSha256: string;
  tracked: false;
  preview: ProfileApplyPreviewV1;
  sha256: string;
}

export interface ProfileRollbackPreviewV1 {
  schemaVersion: 1;
  kind: "docsfab-profile-rollback-preview";
  purpose: ModelProfilePurpose;
  target: ".env";
  rootIdentity: ProfileConfigurationIdentityV1;
  currentIdentity: ProfileConfigurationIdentityV1;
  receiptSha256: string;
  patchSha256: string;
  fromSha256: string;
  toSha256: string;
  tracked: false;
  sha256: string;
}

export interface PreparedProfileRollback {
  projectRoot: string;
  preview: ProfileRollbackPreviewV1;
  /** Exact rollback post-image. Never serialize or retain this value as evidence. */
  bytes: Uint8Array;
}

export interface ProfileRollbackReceiptV1 {
  schemaVersion: 1;
  kind: "docsfab-profile-rollback-receipt";
  purpose: ModelProfilePurpose;
  target: ".env";
  rolledBackAt: string;
  rollbackPreviewSha256: string;
  applyReceiptSha256: string;
  patchSha256: string;
  fromSha256: string;
  toSha256: string;
  beforeIdentity: ProfileConfigurationIdentityV1;
  afterIdentity: ProfileConfigurationIdentityV1;
  tracked: false;
  preview: ProfileRollbackPreviewV1;
  sha256: string;
}

export class ProfileApplyError extends Error {
  public readonly code: "profile-apply-rejected" | "profile-owner-artifact-rejected";

  public constructor(
    code: "profile-apply-rejected" | "profile-owner-artifact-rejected" = "profile-apply-rejected",
    message = "Profile configuration apply was rejected.",
  ) {
    super(message);
    this.code = code;
    this.name = "ProfileApplyError";
  }
}

export type ProfileOwnerArtifactKind =
  | "inspection evidence"
  | "public signing key"
  | "private signing key"
  | "saved approval bundle"
  | "model profile configuration"
  | "owner profile input";

/** Safe refusal for a missing, unsafe, or unreadable owner-controlled profile artifact. */
export class ProfileOwnerArtifactOperatorError extends ProfileApplyError {
  public readonly code = "profile-owner-artifact-rejected" as const;
  public readonly nextAction: string;

  public constructor(public readonly artifact: ProfileOwnerArtifactKind) {
    super(
      "profile-owner-artifact-rejected",
      `The owner-controlled ${artifact} profile artifact could not be read safely.`,
    );
    this.name = "ProfileOwnerArtifactOperatorError";
    this.nextAction =
      artifact === "private signing key"
        ? "Restore the intended private signing key as an owner-only UTF-8 file; keep its contents private and have its owner verify it before retrying."
        : artifact === "public signing key"
          ? "Restore the authority's intended public signing key as an owner-only UTF-8 file and have its owner verify the key identity before retrying."
          : artifact === "saved approval bundle"
            ? "Restore the exact saved approval bundle from its owner-controlled source; preserve the original evidence and have its owner verify it before continuing."
            : artifact === "inspection evidence"
              ? "Restore the exact inspection evidence from its owner-controlled source as an owner-only file, then have its owner verify it before continuing."
              : artifact === "model profile configuration"
                ? "Verify the DocsFab configuration root and restore its intended owner-only model profile file; have its owner inspect the file before retrying."
                : "Restore the intended owner-controlled profile input as a regular owner-only UTF-8 file and have its owner verify it before continuing.";
  }
}

export class ProfileRollbackAmbiguousError extends Error {
  public readonly code = "profile-rollback-ambiguous" as const;

  public constructor() {
    super("Profile rollback outcome is ambiguous and requires owner review.");
    this.name = "ProfileRollbackAmbiguousError";
  }
}

export class ProfileApplyAmbiguousError extends Error {
  public readonly code = "profile-apply-ambiguous" as const;

  public constructor() {
    super("Profile apply outcome is ambiguous and requires owner review.");
    this.name = "ProfileApplyAmbiguousError";
  }
}

/** Internal transaction intent persisted for crash recovery. */
export interface ProfileTransactionIntentV1 {
  schemaVersion: 1;
  kind: "docsfab-profile-transaction-intent";
  operation: "apply" | "rollback" | "seed";
  createdAt: string;
  processId: number;
  target: ".env";
  lockName: ".env.docsfab-apply.lock";
  lockIdentity: ProfileConfigurationIdentityV1;
  rootIdentity: ProfileConfigurationIdentityV1;
  beforeIdentity: ProfileConfigurationIdentityV1;
  beforeSha256: string;
  plannedAfterIdentity: ProfileConfigurationIdentityV1;
  plannedAfterSha256: string;
  temporaryName: string;
  temporaryIdentity: ProfileConfigurationIdentityV1;
  receiptPathSha256: string;
  receiptStageName: string;
  receiptStageIdentity: ProfileConfigurationIdentityV1;
  purpose: ModelProfilePurpose;
  previewSha256: string;
  patchSha256: string;
  approvalBundleSha256: string | null;
  applyReceiptSha256: string | null;
  receipt: ProfileApplyReceiptV1 | ProfileRollbackReceiptV1 | ProfileSeedReceiptV1;
  sha256: string;
}

export interface StagedOwnerReceipt {
  target: string;
  temporary: string;
  identity: ProfileConfigurationIdentityV1;
  bytes: Uint8Array;
}

export interface GitContext {
  worktreeRoot: string;
  gitDirectories: readonly string[];
}
