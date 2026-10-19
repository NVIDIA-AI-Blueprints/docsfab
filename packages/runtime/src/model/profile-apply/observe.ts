// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Observe seam: read owner host artifacts and live approval endpoints
 * without mutating tracked repository configuration.
 */
import { dirname, resolve } from "node:path";

import {
  InvalidModelProfileConfigurationError,
  ModelProfileMigrationError,
  UnsupportedModelProfileApiFormatError,
  type ModelEndpointConfig,
} from "../configuration.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";
import type { ModelProfilePurpose } from "../catalog-contracts.js";
import { invalid, kit } from "./dialect.js";
import {
  assertPlainTree,
  assertRootIdentitySync,
  assertSafeTemporaryState,
  assertUntracked,
  exactOwnerArtifactPath,
  exactProjectRoot,
  parsePostimageEndpoint,
  readOwnerConfiguration,
  readOwnerConfigurationSync,
  rejectAmbientOverrides,
  sameIdentity,
  syncDirectory,
  writeExclusive,
  safeUnlink,
} from "./host.js";
import {
  ProfileApplyAmbiguousError,
  ProfileApplyError,
  ProfileOwnerArtifactOperatorError,
  type ProfileOwnerArtifactKind,
  type ProfileConfigurationIdentityV1,
} from "./types.js";

/** Load the selected endpoint from the exact owner-only dotenv without mutating process.env. */
export async function loadProfileApprovalEndpoint(input: {
  projectRoot: string;
  purpose: ModelProfilePurpose;
  ambientEnvironment?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<ModelEndpointConfig> {
  try {
    const root = await exactProjectRoot(input.projectRoot);
    const target = resolve(root.path, ".env");
    rejectAmbientOverrides(input.ambientEnvironment ?? process.env, input.purpose);
    await assertSafeTemporaryState(root.path);
    assertRootIdentitySync(root.path, root.identity);
    const current = await readOwnerConfiguration(target);
    assertRootIdentitySync(root.path, root.identity);
    await assertUntracked(root.path, target, current.identity);
    assertRootIdentitySync(root.path, root.identity);
    const endpoint = parsePostimageEndpoint(
      current.bytes,
      input.purpose,
      input.ambientEnvironment ?? process.env,
      input.now ?? new Date(),
    );
    assertRootIdentitySync(root.path, root.identity);
    return endpoint;
  } catch (error) {
    if (error instanceof ProfileApplyAmbiguousError) throw error;
    if (error instanceof ProfileOwnerArtifactOperatorError) throw error;
    if (error instanceof ProfileApplyError) {
      throw new ProfileOwnerArtifactOperatorError("model profile configuration");
    }
    if (error instanceof ModelProfileMigrationError) {
      if (error.reason !== "invalid-profile") throw error;
      const profile = input.purpose === "judge" ? "JUDGE" : "MODEL";
      const field = `${profile}_API_FORMAT`;
      if (
        error.issues.length === 1 &&
        error.issues[0]?.profile === profile &&
        (error.issues[0].field === field || error.issues[0].field === "API_FORMAT")
      ) {
        throw new UnsupportedModelProfileApiFormatError(input.purpose);
      }
      throw new InvalidModelProfileConfigurationError(error.issues);
    }
    throw new ProfileOwnerArtifactOperatorError("model profile configuration");
  }
}

/** Stable owner-only host input for inspection evidence and signing keys. */
export async function readOwnerHostFile(
  path: string,
  artifact: ProfileOwnerArtifactKind = "owner profile input",
): Promise<Uint8Array> {
  try {
    const target = await exactOwnerArtifactPath(path);
    return Uint8Array.from((await readOwnerConfiguration(target)).bytes);
  } catch (error) {
    if (
      error instanceof ProfileApplyAmbiguousError ||
      error instanceof ProfileOwnerArtifactOperatorError
    )
      throw error;
    throw new ProfileOwnerArtifactOperatorError(artifact);
  }
}

export async function persistCredentialFreeHostArtifact(
  path: string,
  value: unknown,
): Promise<void> {
  try {
    assertPlainTree(value);
    kit.rejectCredentials(value);
    const bytes = Buffer.from(canonicalizeJsonEvidence(value as JsonEvidenceValue));
    const target = await exactOwnerArtifactPath(path);
    let created: ProfileConfigurationIdentityV1 | undefined;
    let complete = false;
    try {
      created = await writeExclusive(target, bytes);
      await syncDirectory(dirname(target));
      const stable = readOwnerConfigurationSync(target);
      if (!sameIdentity(stable.identity, created) || !Buffer.from(stable.bytes).equals(bytes))
        invalid();
      complete = true;
    } finally {
      if (!complete && created) await safeUnlink(target, created);
    }
  } catch (error) {
    if (error instanceof ProfileApplyError) throw error;
    throw new ProfileApplyError();
  }
}
