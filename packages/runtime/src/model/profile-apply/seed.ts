// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unsigned first-run profile seed: materialize a named preset's MODEL_* block
 * into the config-root .env under the profile-apply lock/staging/receipt
 * seam without Ed25519.
 */
import { randomBytes } from "node:crypto";
import { closeSync, lstatSync, openSync, renameSync } from "node:fs";
import { constants } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { ModelCompositionError } from "../../model-composition/types.js";
import { parseModelEndpoint } from "../configuration.js";
import {
  createProfileTransactionIntent,
  persistProfileTransactionIntent,
  publishStagedOwnerReceipt,
  snapshotHooks,
  stageOwnerReceipt,
  assertPublishedTransactionStateSync,
} from "./apply.js";
import { decodeProfileSeedPreview, recoverProfileTransaction } from "./diagnose.js";
import { deepFreeze, invalid, kit } from "./dialect.js";
import {
  NOFOLLOW,
  assertLockIdentitySync,
  assertNormalTransactionArtifactsSync,
  assertPathIdentity,
  assertReceiptReservationSync,
  assertRootIdentity,
  assertRootIdentitySync,
  assertSafeReceiptTargetSync,
  assertSafeTemporaryState,
  assertUntracked,
  cleanupNormalArtifactSync,
  digest,
  dotenvAssignments,
  equal,
  exactProjectRoot,
  identity,
  isMissing,
  optionalLstat,
  ownData,
  plainRecord,
  readOwnerConfiguration,
  readOwnerConfigurationSync,
  sameIdentity,
  sha256,
  syncDirectory,
  timestamp,
  safeUnlinkInodeSync,
  writeExclusive,
} from "./host.js";
import { resolveProfileSeedPreset } from "./eval-presets.js";
import {
  PROFILE_LOCK_NAME,
  PROFILE_SEED_ABSENT_IDENTITY,
  ProfileApplyAmbiguousError,
  ProfileApplyError,
  type PreparedProfileSeed,
  type ProfileApplyHooks,
  type ProfileConfigurationIdentityV1,
  type ProfileSeedKeySource,
  type ProfileSeedPatchV1,
  type ProfileSeedPreviewV1,
  type ProfileSeedReceiptV1,
  type StagedOwnerReceipt,
} from "./types.js";

const HUB_METADATA_KEY = /INFERENCE_HUB/u;

export function resolveProfileSeedApiKey(input: {
  ambientEnvironment: NodeJS.ProcessEnv;
  existingAssignments: NodeJS.ProcessEnv;
}): { apiKey: string; keySource: ProfileSeedKeySource } {
  const ambient = admitSeedCredential(input.ambientEnvironment.MODEL_API_KEY);
  if (ambient) return { apiKey: ambient, keySource: "ambient" };
  const fromFile = admitSeedCredential(input.existingAssignments.MODEL_API_KEY);
  if (fromFile) return { apiKey: fromFile, keySource: "config-root" };
  const openai = admitSeedCredential(input.ambientEnvironment.OPENAI_API_KEY);
  if (openai) return { apiKey: openai, keySource: "ambient" };
  throw new Error(
    "profile seed requires MODEL_API_KEY in the environment or config-root .env file.",
  );
}

export async function prepareProfileSeed(input: {
  projectRoot: string;
  preset: string;
  ambientEnvironment?: NodeJS.ProcessEnv;
  activeLockIdentity?: ProfileConfigurationIdentityV1;
}): Promise<PreparedProfileSeed> {
  try {
    const resolvedPreset = resolveProfileSeedPreset(input.preset);
    const root = await exactProjectRoot(input.projectRoot);
    const projectRoot = root.path;
    const target = resolve(projectRoot, ".env");
    await assertSafeTemporaryState(projectRoot, input.activeLockIdentity);
    const existing = await readOptionalOwnerConfiguration(target);
    if (existing) await assertUntracked(projectRoot, target, existing.identity);
    const existingAssignments = existing ? dotenvAssignments(existing.bytes) : {};
    const { apiKey, keySource } = resolveProfileSeedApiKey({
      ambientEnvironment: input.ambientEnvironment ?? process.env,
      existingAssignments,
    });
    const desired = new Map(resolvedPreset.assignments);
    desired.set("MODEL_API_KEY", apiKey);
    const desiredKeys = [...desired.keys()];
    const existingModel = modelProfileAssignments(existingAssignments);
    const created = existing === undefined;
    let bytes: Uint8Array;
    let changedKeys: string[];
    if (created) {
      bytes = Buffer.from(renderModelBlock([...desired.entries()]));
      changedKeys = desiredKeys;
    } else if (sameModelAssignments(existingModel, desired)) {
      bytes = Uint8Array.from(existing.bytes);
      changedKeys = [];
    } else if (existingModel.size === 0) {
      bytes = Buffer.from(appendModelBlock(existing.bytes, [...desired.entries()]));
      changedKeys = desiredKeys;
    } else {
      throw new Error("profile seed refused a conflicting MODEL profile already present in .env.");
    }
    parseModelEndpoint(dotenvAssignments(bytes), "MODEL", new Date());
    const beforeSha256 = existing ? sha256(existing.bytes) : sha256(new Uint8Array());
    const afterSha256 = sha256(bytes);
    const unsignedPatch: Omit<ProfileSeedPatchV1, "sha256"> = {
      schemaVersion: 1,
      kind: "docsfab-profile-seed-patch",
      purpose: "policy",
      preset: resolvedPreset.preset,
      created,
      changedKeys,
      beforeSha256,
      afterSha256,
    };
    kit.rejectCredentials(unsignedPatch);
    const patch = deepFreeze({ ...unsignedPatch, sha256: digest(unsignedPatch) });
    const unsignedPreview: Omit<ProfileSeedPreviewV1, "sha256"> = {
      schemaVersion: 1,
      kind: "docsfab-profile-seed-preview",
      purpose: "policy",
      target: ".env",
      rootIdentity: root.identity,
      targetIdentity: existing?.identity ?? PROFILE_SEED_ABSENT_IDENTITY,
      keySource,
      patch,
      tracked: false,
    };
    kit.rejectCredentials(unsignedPreview);
    return Object.freeze({
      projectRoot,
      bytes: Uint8Array.from(bytes),
      preview: deepFreeze({ ...unsignedPreview, sha256: digest(unsignedPreview) }),
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("profile seed ")) throw error;
    if (error instanceof ProfileApplyError) throw error;
    // A retired preset (#1512) keeps its named refusal and setup remediation;
    // a generic apply rejection would hide both from the operator.
    if (error instanceof ModelCompositionError && error.code === "composition-retired") throw error;
    throw new ProfileApplyError();
  }
}

export async function applyProfileSeed(input: {
  prepared: PreparedProfileSeed;
  receiptPath: string;
  ambientEnvironment?: NodeJS.ProcessEnv;
  now?: Date;
  hooks?: ProfileApplyHooks;
}): Promise<ProfileSeedReceiptV1> {
  let target: string | undefined;
  let prepared: PreparedProfileSeed | undefined;
  let temporary: string | undefined;
  let temporaryIdentity: ProfileConfigurationIdentityV1 | undefined;
  let lockPath: string | undefined;
  let lockIdentity: ProfileConfigurationIdentityV1 | undefined;
  let lockDescriptor: number | undefined;
  let installed = false;
  let installedIdentity: ProfileConfigurationIdentityV1 | undefined;
  let hooks: ProfileApplyHooks = {};
  let intentPath: string | undefined;
  let intentIdentity: ProfileConfigurationIdentityV1 | undefined;
  let plannedReceipt: ProfileSeedReceiptV1 | undefined;
  let preserveTransaction = false;
  let receiptPublished = false;
  let receiptCommitStarted = false;
  let stagedReceipt: StagedOwnerReceipt | undefined;
  let publishedReceiptIdentity: ProfileConfigurationIdentityV1 | undefined;
  try {
    const now = input.now ?? new Date();
    hooks = snapshotHooks(input.hooks);
    prepared = snapshotPreparedSeed(input.prepared);
    target = resolve(prepared.projectRoot, ".env");
    assertSafeReceiptTargetSync(prepared.projectRoot, input.receiptPath);
    const recovered = await recoverProfileTransaction({
      projectRoot: prepared.projectRoot,
      operation: "seed",
      purpose: "policy",
      previewSha256: prepared.preview.sha256,
      patchSha256: prepared.preview.patch.sha256,
      receiptPath: input.receiptPath,
    });
    if (recovered.status === "completed") {
      if (recovered.receipt.kind !== "docsfab-profile-seed-receipt") invalid();
      return recovered.receipt;
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
    const preset = prepared.preview.patch.preset;
    if (preset === null) invalid();
    const refreshed = await prepareProfileSeed({
      projectRoot: prepared.projectRoot,
      preset,
      ambientEnvironment: input.ambientEnvironment,
      activeLockIdentity: lockIdentity,
    });
    if (
      !equal(refreshed.preview, prepared.preview) ||
      !Buffer.from(refreshed.bytes).equals(Buffer.from(prepared.bytes))
    )
      invalid();
    const before = await readOptionalOwnerConfiguration(target);
    if (prepared.preview.patch.created !== (before === undefined)) invalid();
    if (before) {
      if (
        !sameIdentity(before.identity, prepared.preview.targetIdentity) ||
        sha256(before.bytes) !== prepared.preview.patch.beforeSha256
      )
        invalid();
      await assertUntracked(prepared.projectRoot, target, before.identity);
    } else if (!sameIdentity(prepared.preview.targetIdentity, PROFILE_SEED_ABSENT_IDENTITY)) {
      invalid();
    }
    if (prepared.preview.patch.changedKeys.length === 0) {
      if (!before) invalid();
      const result = seedReceipt(prepared.preview, now, false, before.identity, before.identity);
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
    const beforeArtifacts = before ? [{ path: target, identity: before.identity }] : [];
    assertNormalTransactionArtifactsSync(prepared.projectRoot, prepared.preview.rootIdentity, [
      ...beforeArtifacts,
      { path: temporary, identity: temporaryIdentity },
      { path: lockPath, identity: lockIdentity },
    ]);
    if (before) {
      const boundary = await readOwnerConfiguration(target);
      if (
        !sameIdentity(boundary.identity, before.identity) ||
        sha256(boundary.bytes) !== prepared.preview.patch.beforeSha256
      )
        invalid();
    }
    await assertPathIdentity(temporary, temporaryIdentity);
    await assertRootIdentity(prepared.projectRoot, prepared.preview.rootIdentity);
    hooks.beforeRename?.({ projectRoot: prepared.projectRoot, target, temporary });
    const stableTemporary = readOwnerConfigurationSync(temporary);
    if (
      !sameIdentity(stableTemporary.identity, temporaryIdentity) ||
      sha256(stableTemporary.bytes) !== prepared.preview.patch.afterSha256
    )
      invalid();
    plannedReceipt = seedReceipt(
      prepared.preview,
      now,
      true,
      before?.identity ?? PROFILE_SEED_ABSENT_IDENTITY,
      temporaryIdentity,
    );
    stagedReceipt = await stageOwnerReceipt(input.receiptPath, plannedReceipt);
    await hooks.afterReceiptStage?.({
      target: stagedReceipt.target,
      temporary: stagedReceipt.temporary,
    });
    const intent = createProfileTransactionIntent({
      operation: "seed",
      now,
      rootIdentity: prepared.preview.rootIdentity,
      lockIdentity,
      beforeIdentity: before?.identity ?? PROFILE_SEED_ABSENT_IDENTITY,
      beforeSha256: prepared.preview.patch.beforeSha256,
      temporaryName: basename(temporary),
      temporaryIdentity,
      plannedAfterSha256: prepared.preview.patch.afterSha256,
      receiptPath: input.receiptPath,
      receiptStageName: basename(stagedReceipt.temporary),
      receiptStageIdentity: stagedReceipt.identity,
      purpose: "policy",
      previewSha256: prepared.preview.sha256,
      patchSha256: prepared.preview.patch.sha256,
      receipt: plannedReceipt,
    });
    ({ path: intentPath, identity: intentIdentity } = await persistProfileTransactionIntent(
      prepared.projectRoot,
      intent,
    ));
    await hooks.afterIntentSync?.(intentPath);
    assertLockIdentitySync(lockDescriptor, lockPath, lockIdentity);
    assertReceiptReservationSync(stagedReceipt);
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
    await syncDirectory(prepared.projectRoot);
    if (!plannedReceipt || !sameIdentity(plannedReceipt.afterIdentity, after.identity)) invalid();
    const result = plannedReceipt;
    receiptCommitStarted = true;
    publishedReceiptIdentity = stagedReceipt.identity;
    await publishStagedOwnerReceipt(stagedReceipt, hooks, {
      projectRoot: prepared.projectRoot,
      rootIdentity: prepared.preview.rootIdentity,
      artifacts: [
        { path: target, identity: after.identity },
        { path: lockPath, identity: lockIdentity },
        { path: intentPath, identity: intentIdentity },
      ],
    });
    receiptPublished = true;
    await hooks.afterReceiptPublish?.(input.receiptPath);
    if (lockDescriptor === undefined || !lockPath || !lockIdentity) {
      throw new ProfileApplyAmbiguousError();
    }
    closeSync(lockDescriptor);
    lockDescriptor = undefined;
    if (!safeUnlinkInodeSync(lockPath, lockIdentity)) throw new ProfileApplyAmbiguousError();
    lockPath = undefined;
    lockIdentity = undefined;
    await syncDirectory(prepared.projectRoot);
    if (!intentPath || !intentIdentity) throw new ProfileApplyAmbiguousError();
    if (!safeUnlinkInodeSync(intentPath, intentIdentity)) throw new ProfileApplyAmbiguousError();
    intentPath = undefined;
    intentIdentity = undefined;
    await syncDirectory(prepared.projectRoot);
    stagedReceipt = undefined;
    return result;
  } catch (error) {
    if (receiptCommitStarted || receiptPublished || installed) {
      preserveTransaction = true;
      throw new ProfileApplyAmbiguousError();
    }
    if (error instanceof ProfileApplyError) throw error;
    if (error instanceof ProfileApplyAmbiguousError) throw error;
    if (error instanceof Error && error.message.startsWith("profile seed ")) throw error;
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
    if (installed && installedIdentity && preserveTransaction === false) {
      /* mutation already published or rolled forward by recovery */
    }
    if (cleanupAmbiguous) throw new ProfileApplyAmbiguousError();
  }
}

export function seedReceipt(
  preview: ProfileSeedPreviewV1,
  now: Date,
  applied: boolean,
  beforeIdentity: ProfileConfigurationIdentityV1,
  afterIdentity: ProfileConfigurationIdentityV1,
): ProfileSeedReceiptV1 {
  const unsigned = {
    schemaVersion: 1 as const,
    kind: "docsfab-profile-seed-receipt" as const,
    purpose: "policy" as const,
    target: ".env" as const,
    seededAt: timestamp(now),
    applied,
    created: preview.patch.created,
    keySource: preview.keySource,
    previewSha256: preview.sha256,
    beforeSha256: preview.patch.beforeSha256,
    afterSha256: preview.patch.afterSha256,
    beforeIdentity,
    afterIdentity,
    patchSha256: preview.patch.sha256,
    tracked: false as const,
    preview,
  };
  kit.rejectCredentials(unsigned);
  return deepFreeze({ ...unsigned, sha256: digest(unsigned) });
}

function snapshotPreparedSeed(value: unknown): PreparedProfileSeed {
  const record = plainRecord(value);
  exactPreparedKeys(record);
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
  const preview = decodeProfileSeedPreview(previewValue);
  if (sha256(descriptor.value) !== preview.patch.afterSha256) invalid();
  return {
    projectRoot: root,
    preview,
    bytes: Uint8Array.from(descriptor.value),
  };
}

function exactPreparedKeys(record: Record<string, unknown>): void {
  const keys = Object.keys(record);
  if (
    keys.length !== 3 ||
    !keys.includes("bytes") ||
    !keys.includes("preview") ||
    !keys.includes("projectRoot")
  )
    invalid();
}

async function runCleanupHook(hooks: ProfileApplyHooks, path: string): Promise<void> {
  await hooks.beforeCleanup?.(path);
}

async function readOptionalOwnerConfiguration(
  path: string,
): Promise<{ bytes: Uint8Array; identity: ProfileConfigurationIdentityV1 } | undefined> {
  const metadata = await optionalLstat(path);
  if (!metadata) return undefined;
  try {
    return await readOwnerConfiguration(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function admitSeedCredential(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 4_096 || /\s/u.test(trimmed) || /\$\{|\$\(|`/u.test(trimmed)) invalid();
  return trimmed;
}

function encodeSeedValue(value: string): string {
  return /^[A-Za-z0-9_./,:+\-?=&%#]+$/u.test(value) ? value : JSON.stringify(value);
}

function renderModelBlock(assignments: ReadonlyArray<[string, string]>): string {
  return `${assignments.map(([key, value]) => `${key}=${encodeSeedValue(value)}`).join("\n")}\n`;
}

function appendModelBlock(
  before: Uint8Array,
  assignments: ReadonlyArray<[string, string]>,
): string {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(before);
  const ending = source.includes("\r\n") ? "\r\n" : "\n";
  const block = renderModelBlock(assignments).replaceAll("\n", ending);
  if (source.length === 0) return block;
  const needsBreak = !source.endsWith("\n") && !source.endsWith("\r");
  const extra = source.trimEnd().length > 0 ? ending : "";
  return `${source}${needsBreak ? ending : ""}${extra}${block}`;
}

function modelProfileAssignments(environment: NodeJS.ProcessEnv): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(environment)) {
    if (!key.startsWith("MODEL_") || HUB_METADATA_KEY.test(key) || value === undefined) continue;
    result.set(key, value);
  }
  return result;
}

function sameModelAssignments(
  existing: Map<string, string>,
  desired: Map<string, string>,
): boolean {
  if (existing.size !== desired.size) return false;
  for (const [key, value] of desired) {
    if (existing.get(key) !== value) return false;
  }
  return true;
}
