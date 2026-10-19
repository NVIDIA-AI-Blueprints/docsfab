// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Stable public entry for profile apply/observe/propose/diagnose.
 * Implementation lives under ./profile-apply/; keep this path for CLI and tests.
 */
export {
  ProfileApplyAmbiguousError,
  ProfileApplyError,
  ProfileOwnerArtifactOperatorError,
  ProfileRollbackAmbiguousError,
  PROFILE_SEED_RECEIPT_NAME,
  type PreparedProfileApply,
  type PreparedProfileRollback,
  type PreparedProfileSeed,
  type ProfileApplyHooks,
  type ProfileApplyPreviewV1,
  type ProfileApplyReceiptV1,
  type ProfileConfigurationIdentityV1,
  type ProfileOwnerArtifactKind,
  type ProfileRollbackPreviewV1,
  type ProfileRollbackReceiptV1,
  type ProfileSeedReceiptV1,
  type ProfileTransactionRecovery,
} from "./profile-apply/types.js";

export {
  loadProfileApprovalEndpoint,
  persistCredentialFreeHostArtifact,
  readOwnerHostFile,
} from "./profile-apply/observe.js";

export {
  prepareProfileApply,
  prepareProfileRollback,
} from "./profile-apply/propose.js";

export {
  applyProfileConfiguration,
  applyProfileRollback,
} from "./profile-apply/apply.js";

export { applyProfileSeed, prepareProfileSeed } from "./profile-apply/seed.js";

export {
  assertSafeProfileReceiptTarget,
  decodeProfileApplyReceipt,
  decodeProfileRollbackReceipt,
  decodeProfileSeedReceipt,
  loadProfileApplyReceipt,
  loadProfileRollbackReceipt,
  loadProfileSeedReceipt,
  recoverProfileTransaction,
  serializeProfileApplyReceipt,
  serializeProfileRollbackReceipt,
  serializeProfileSeedReceipt,
  verifyProfileApplyReceiptPostimage,
  verifyProfileRollbackReceiptPostimage,
  verifyProfileSeedReceiptPostimage,
} from "./profile-apply/diagnose.js";
