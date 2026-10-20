// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Propose seam: build exact apply/rollback previews without mutating .env.
 */
import { basename, dirname, resolve } from "node:path";

import type { TrustedModelCatalogApprovalAuthority } from "../catalog-provenance.js";
import type { ModelProfilePurpose } from "../catalog-contracts.js";
import {
  decodeModelProfileApprovalBundle,
  projectModelProfileApprovalBundle,
} from "../profile-approval.js";
import {
  createProfileEnvironmentPatch,
  createProfileEnvironmentRollback,
} from "../profile-environment.js";
import { decodeModelProfileInspection } from "../profile-inspection.js";
import { createModelEvidence } from "../profile-evidence.js";
import { deepFreeze, invalid, kit } from "./dialect.js";
import {
  assertEndpointMatches,
  assertSafeTemporaryState,
  assertUntracked,
  digest,
  equal,
  exactProjectRoot,
  parsePostimageEndpoint,
  readOwnerConfiguration,
  rejectAmbientOverrides,
  sameDirectoryIdentity,
  sameIdentity,
  sha256,
} from "./host.js";
import { decodeProfileApplyReceipt } from "./diagnose.js";
import {
  ProfileApplyError,
  type PreparedProfileApply,
  type PreparedProfileRollback,
  type ProfileConfigurationIdentityV1,
} from "./types.js";

export async function prepareProfileApply(input: {
  projectRoot: string;
  purpose: ModelProfilePurpose;
  inspection: string | Uint8Array | unknown;
  approvalBundle: string | Uint8Array | unknown;
  authority: TrustedModelCatalogApprovalAuthority;
  ambientEnvironment?: NodeJS.ProcessEnv;
  now?: Date;
  activeLockIdentity?: ProfileConfigurationIdentityV1;
}): Promise<PreparedProfileApply> {
  try {
    const now = input.now ?? new Date();
    const root = await exactProjectRoot(input.projectRoot);
    const projectRoot = root.path;
    const target = resolve(projectRoot, ".env");
    if (dirname(target) !== projectRoot || basename(target) !== ".env") invalid();
    rejectAmbientOverrides(input.ambientEnvironment ?? process.env, input.purpose);
    const { bytes: before, identity } = await readOwnerConfiguration(target);
    await assertSafeTemporaryState(projectRoot, input.activeLockIdentity);
    await assertUntracked(projectRoot, target, identity);
    const inspection = decodeModelProfileInspection(input.inspection);
    const bundle = decodeModelProfileApprovalBundle(
      input.approvalBundle,
      inspection,
      input.authority,
      now,
    );
    if (bundle.purpose !== input.purpose || inspection.purpose !== input.purpose) invalid();
    const profile = projectModelProfileApprovalBundle(bundle, inspection, input.authority, now);
    const result = createProfileEnvironmentPatch(before, input.purpose, profile);
    const endpoint = parsePostimageEndpoint(
      result.bytes,
      input.purpose,
      input.ambientEnvironment ?? process.env,
      now,
    );
    assertEndpointMatches(endpoint, inspection, bundle);
    if (!equal(endpoint.profile, profile)) invalid();
    const postEvidence = createModelEvidence(endpoint);
    if (
      !postEvidence.profile ||
      postEvidence.profile.schemaVersion !== 2 ||
      !equal(postEvidence, bundle.modelEvidence)
    )
      invalid();

    const unsigned = {
      schemaVersion: 1 as const,
      kind: "docsfab-profile-apply-preview" as const,
      purpose: input.purpose,
      target: ".env" as const,
      rootIdentity: root.identity,
      targetIdentity: identity,
      inspectionSha256: inspection.sha256,
      approvalBundleSha256: bundle.sha256,
      approvalSha256: bundle.approval.sha256,
      approvalEvidenceSha256: bundle.approvalEvidence.sha256,
      authorizationSha256: bundle.authorization.sha256,
      proposalSha256: bundle.proposalSha256,
      proposalProvenanceSha256: bundle.proposalProvenanceSha256,
      decisionSha256: bundle.decisionSha256,
      patch: result.patch,
      tracked: false as const,
    };
    kit.rejectCredentials(unsigned);
    return Object.freeze({
      projectRoot,
      bytes: Uint8Array.from(result.bytes),
      preview: deepFreeze({ ...unsigned, sha256: digest(unsigned) }),
    });
  } catch (error) {
    if (error instanceof ProfileApplyError) throw error;
    throw new ProfileApplyError();
  }
}

export async function prepareProfileRollback(input: {
  projectRoot: string;
  receipt: string | Uint8Array | unknown;
  activeLockIdentity?: ProfileConfigurationIdentityV1;
}): Promise<PreparedProfileRollback> {
  try {
    const root = await exactProjectRoot(input.projectRoot);
    const target = resolve(root.path, ".env");
    const receipt = decodeProfileApplyReceipt(input.receipt);
    if (!receipt.applied || receipt.preview.patch.changedKeys.length === 0) invalid();
    if (!sameDirectoryIdentity(root.identity, receipt.preview.rootIdentity)) invalid();
    await assertSafeTemporaryState(root.path, input.activeLockIdentity);
    const current = await readOwnerConfiguration(target);
    if (
      !sameIdentity(current.identity, receipt.afterIdentity) ||
      sha256(current.bytes) !== receipt.afterSha256
    )
      invalid();
    await assertUntracked(root.path, target, current.identity);
    const bytes = createProfileEnvironmentRollback(current.bytes, receipt.preview.patch);
    const unsigned = {
      schemaVersion: 1 as const,
      kind: "docsfab-profile-rollback-preview" as const,
      purpose: receipt.purpose,
      target: ".env" as const,
      rootIdentity: root.identity,
      currentIdentity: current.identity,
      receiptSha256: receipt.sha256,
      patchSha256: receipt.patchSha256,
      fromSha256: receipt.afterSha256,
      toSha256: receipt.beforeSha256,
      tracked: false as const,
    };
    kit.rejectCredentials(unsigned);
    return Object.freeze({
      projectRoot: root.path,
      bytes: Uint8Array.from(bytes),
      preview: deepFreeze({ ...unsigned, sha256: digest(unsigned) }),
    });
  } catch (error) {
    if (error instanceof ProfileApplyError) throw error;
    throw new ProfileApplyError();
  }
}
