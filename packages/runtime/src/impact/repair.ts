// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { canonicalDigest, sha256 } from "../content-ir/canonical.js";
import { acquireRepositoryWorkspaceLease } from "../repository/workspace/lease.js";
import { verifyActiveRepositoryWorkspace } from "../repository/workspace/tracked-read.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PORTABLE_PATH = /^[A-Za-z0-9._/-]+$/u;
const SAFE_LINK = /^[A-Za-z0-9._/-]+(?:#[A-Za-z0-9._:-]+)?$/u;
const MAX_REPAIR_BYTES = 4 * 1024 * 1024;

export interface ApprovedBoundedLinkRepairPlan {
  schemaVersion: 1;
  id: string;
  repositoryRevision: string;
  outputPath: string;
  preimageSha256: string;
  oldLink: string;
  newLink: string;
  approval: {
    status: "approved";
    requirement: "maintainer";
    approvedBy: string;
    approvedAt: string;
  };
  expiresAt: string;
  delivery: {
    mode: "patch-only";
    mayMerge: false;
    mayPublish: false;
  };
  digest: string;
}

declare const boundedRepairCapabilityBrand: unique symbol;

/** Opaque host-prepared authority for one exact existing-file link repair. */
export interface BoundedLinkRepairCapability {
  readonly id: string;
  readonly planDigest: string;
  readonly repositoryRevision: string;
  readonly outputPath: string;
  readonly [boundedRepairCapabilityBrand]: true;
}

interface FileIdentity {
  device: number;
  inode: number;
  mode: number;
}

interface BoundedLinkRepairCapabilityState {
  workspace: RepositoryWorkspace;
  plan: Readonly<ApprovedBoundedLinkRepairPlan>;
  preparedIdentity: FileIdentity;
  preparedByteLength: number;
  preparedAncestors: Array<{ relativePath: string; identity: FileIdentity }>;
}

declare const boundedRepairApprovalBrand: unique symbol;
export interface BoundedLinkRepairApprovalGrant {
  readonly planDigest: string;
  readonly approvedBy: string;
  readonly [boundedRepairApprovalBrand]: true;
}

const approvalGrantPlans = new WeakMap<
  BoundedLinkRepairApprovalGrant,
  Readonly<ApprovedBoundedLinkRepairPlan>
>();

const capabilityStates = new WeakMap<
  BoundedLinkRepairCapability,
  BoundedLinkRepairCapabilityState
>();
const trustedCapabilities = new WeakSet<BoundedLinkRepairCapability>();

export interface ApplyBoundedLinkRepairInput {
  workspace: RepositoryWorkspace;
  capability: BoundedLinkRepairCapability;
  /** Explicit time makes approval expiry checks deterministic and testable. */
  evaluationTime: Date;
}

export interface BoundedLinkRepairSummary {
  schemaVersion: 1;
  operation: "bounded-link-repair";
  repositoryRevision: string;
  planDigest: string;
  outputPath: string;
  preimage: { sha256: string; byteLength: number; mode: number };
  postimage: { sha256: string; byteLength: number; mode: number };
  patch: { sha256: string; byteLength: number };
  delivery: {
    mode: "patch-only";
    mayMerge: false;
    mayPublish: false;
  };
  digest: string;
}

export interface BoundedLinkRepairHookContext {
  /** Ephemeral absolute path for deterministic race injection; never retained. */
  absolutePath: string;
  outputPath: string;
}

export interface BoundedLinkRepairDependencies {
  beforeAtomicReplace?(context: BoundedLinkRepairHookContext): void | Promise<void>;
  /** A failure rolls the target back to its exact original bytes and mode. */
  validateAfterRepair?(context: BoundedLinkRepairHookContext): void | Promise<void>;
}

export type BoundedLinkRepairErrorCode =
  | "invalid-workspace"
  | "invalid-capability"
  | "invalid-approval"
  | "invalid-plan"
  | "authorization-expired"
  | "unsafe-path"
  | "unsafe-link"
  | "invalid-content"
  | "content-too-large"
  | "stale-preimage"
  | "old-link-missing"
  | "old-link-ambiguous"
  | "race-detected"
  | "write-failed"
  | "validation-failed"
  | "rollback-failed";

export class BoundedLinkRepairError extends Error {
  public constructor(
    public readonly code: BoundedLinkRepairErrorCode,
    /** Always repository-relative or an input location; never a host path. */
    public readonly path: string,
  ) {
    super(`Bounded link repair failed (${code}) at ${path}.`);
    this.name = "BoundedLinkRepairError";
  }
}

/** Canonical digest used by the durable approved plan. */
export function boundedLinkRepairPlanDigest(
  plan: Omit<ApprovedBoundedLinkRepairPlan, "digest"> | ApprovedBoundedLinkRepairPlan,
): string {
  return canonicalDigest({
    schemaVersion: plan.schemaVersion,
    id: plan.id,
    repositoryRevision: plan.repositoryRevision,
    outputPath: plan.outputPath,
    preimageSha256: plan.preimageSha256,
    oldLink: plan.oldLink,
    newLink: plan.newLink,
    approval: plan.approval,
    expiresAt: plan.expiresAt,
    delivery: plan.delivery,
  });
}

/**
 * Trusted host boundary that intersects an approval attestation with the
 * configured maintainer allowlist and returns non-forgeable authority.
 */
export function prepareBoundedLinkRepairApprovalGrant(options: {
  plan: ApprovedBoundedLinkRepairPlan;
  allowedApprovers: readonly string[];
  evaluationTime: Date;
}): BoundedLinkRepairApprovalGrant {
  const plan = validateAndSnapshotPlan(options.plan, options.evaluationTime);
  if (
    !Array.isArray(options.allowedApprovers) ||
    options.allowedApprovers.length === 0 ||
    new Set(options.allowedApprovers).size !== options.allowedApprovers.length ||
    options.allowedApprovers.some(
      (approver) => typeof approver !== "string" || !IDENTIFIER.test(approver),
    ) ||
    !options.allowedApprovers.includes(plan.approval.approvedBy)
  ) {
    fail("invalid-approval", "approval.allowedApprovers");
  }
  const grant = Object.freeze({
    planDigest: plan.digest,
    approvedBy: plan.approval.approvedBy,
  }) as BoundedLinkRepairApprovalGrant;
  approvalGrantPlans.set(grant, plan);
  return grant;
}

/**
 * Trusted host boundary: validate one approved repair, bind it to an active
 * disposable export, verify its preimage, then return non-forgeable authority.
 */
export async function prepareBoundedLinkRepairCapability(options: {
  workspace: RepositoryWorkspace;
  approval: BoundedLinkRepairApprovalGrant;
  evaluationTime: Date;
}): Promise<BoundedLinkRepairCapability> {
  const plan = approvalGrantPlans.get(options.approval);
  if (!plan) fail("invalid-approval", "approval");
  assertAuthorizationEffective(plan, options.evaluationTime);
  let workspace: RepositoryWorkspace;
  try {
    workspace = await verifyActiveRepositoryWorkspace(options.workspace);
  } catch {
    fail("invalid-workspace", "workspace");
  }
  if (workspace.revision !== plan.repositoryRevision) {
    fail("invalid-plan", "plan.repositoryRevision");
  }

  const inspected = await inspectBoundTarget(workspace, plan.outputPath);
  let handle: FileHandle | undefined;
  try {
    handle = await openNoFollow(inspected.absolutePath, fsConstants.O_RDONLY);
    const current = await readStableFile(handle, inspected.identity, plan.outputPath);
    if (current.bytes.length > MAX_REPAIR_BYTES) fail("content-too-large", plan.outputPath);
    if (sha256(current.bytes) !== plan.preimageSha256) fail("stale-preimage", plan.outputPath);
    assertExactlyOneOldLink(current.bytes, plan.oldLink, plan.outputPath);
  } finally {
    await handle?.close();
  }

  const capability = Object.freeze({
    id: plan.id,
    planDigest: plan.digest,
    repositoryRevision: plan.repositoryRevision,
    outputPath: plan.outputPath,
  }) as BoundedLinkRepairCapability;
  capabilityStates.set(capability, {
    workspace,
    plan,
    preparedIdentity: inspected.identity,
    preparedByteLength: inspected.byteLength,
    preparedAncestors: inspected.ancestors,
  });
  trustedCapabilities.add(capability);
  return capability;
}

/**
 * Atomically replace one exact Markdown link in an existing regular file.
 * The source checkout is unreachable through this opaque workspace boundary.
 */
export async function applyBoundedLinkRepair(
  input: ApplyBoundedLinkRepairInput,
  dependencies: BoundedLinkRepairDependencies = {},
): Promise<BoundedLinkRepairSummary> {
  const state = resolveCapability(input.capability);
  if (state.workspace !== input.workspace) fail("invalid-capability", "capability");
  assertEvaluationTime(input.evaluationTime, "evaluationTime");
  assertAuthorizationEffective(state.plan, input.evaluationTime);

  let release: (() => void) | undefined;
  let invalidateWorkspace = false;
  try {
    release = await acquireRepositoryWorkspaceLease(input.workspace);
  } catch {
    fail("invalid-workspace", "workspace");
  }
  try {
    return await applyWithLease(input.workspace, state, dependencies);
  } catch (error) {
    invalidateWorkspace =
      error instanceof BoundedLinkRepairError &&
      (error.code === "rollback-failed" ||
        (error.code === "race-detected" && !(await boundAncestorsMatch(input.workspace, state))));
    throw error;
  } finally {
    release();
    if (invalidateWorkspace) await input.workspace.dispose();
  }
}

async function applyWithLease(
  workspace: RepositoryWorkspace,
  state: BoundedLinkRepairCapabilityState,
  dependencies: BoundedLinkRepairDependencies,
): Promise<BoundedLinkRepairSummary> {
  await verifyWorkspace(workspace);
  if (workspace.revision !== state.plan.repositoryRevision) {
    fail("invalid-workspace", "workspace.revision");
  }
  const target = await inspectBoundTarget(workspace, state.plan.outputPath);
  if (
    !sameIdentity(target.identity, state.preparedIdentity) ||
    target.byteLength !== state.preparedByteLength ||
    !sameAncestorChain(target.ancestors, state.preparedAncestors)
  ) {
    fail("race-detected", state.plan.outputPath);
  }

  let originalHandle: FileHandle | undefined;
  let temporaryPath: string | undefined;
  let installedIdentity: FileIdentity | undefined;
  let originalBytes: Buffer | undefined;
  let newBytes: Buffer | undefined;
  try {
    originalHandle = await openNoFollow(target.absolutePath, fsConstants.O_RDONLY);
    const original = await readStableFile(
      originalHandle,
      state.preparedIdentity,
      state.plan.outputPath,
    );
    originalBytes = original.bytes;
    if (sha256(originalBytes) !== state.plan.preimageSha256) {
      fail("stale-preimage", state.plan.outputPath);
    }
    newBytes = replaceExactlyOneOldLink(
      originalBytes,
      state.plan.oldLink,
      state.plan.newLink,
      state.plan.outputPath,
    );
    const postimageSha256 = sha256(newBytes);
    await assertBoundAncestors(workspace, state);
    temporaryPath = await writeAtomicCandidate(
      target.absolutePath,
      newBytes,
      state.preparedIdentity.mode,
    );

    const context = {
      absolutePath: target.absolutePath,
      outputPath: state.plan.outputPath,
    };
    await dependencies.beforeAtomicReplace?.(context);
    await verifyWorkspace(workspace);
    await assertBoundAncestors(workspace, state);
    await assertTargetUnchanged(
      target.absolutePath,
      originalHandle,
      state.preparedIdentity,
      state.plan.preimageSha256,
      state.plan.outputPath,
    );
    const candidateInfo = await lstat(temporaryPath);
    if (
      !candidateInfo.isFile() ||
      candidateInfo.isSymbolicLink() ||
      candidateInfo.mode !== state.preparedIdentity.mode
    ) {
      fail("race-detected", state.plan.outputPath);
    }
    installedIdentity = identity(candidateInfo);
    await rename(temporaryPath, target.absolutePath);
    temporaryPath = undefined;
    await assertBoundAncestors(workspace, state);
    await assertInstalledTarget(
      target.absolutePath,
      installedIdentity,
      postimageSha256,
      state.plan.outputPath,
    );

    try {
      await dependencies.validateAfterRepair?.(context);
      await verifyWorkspace(workspace);
      await assertBoundAncestors(workspace, state);
      await assertInstalledTarget(
        target.absolutePath,
        installedIdentity,
        postimageSha256,
        state.plan.outputPath,
      );
    } catch (error) {
      await rollbackInstalledTarget(
        workspace,
        state,
        target.absolutePath,
        installedIdentity,
        originalBytes,
        state.preparedIdentity.mode,
        state.plan.preimageSha256,
        state.plan.outputPath,
      );
      installedIdentity = undefined;
      if (error instanceof BoundedLinkRepairError && error.code === "rollback-failed") throw error;
      fail("validation-failed", state.plan.outputPath);
    }

    const patchBytes = boundedPatchBytes(state.plan.outputPath, originalBytes, newBytes);
    const value = {
      schemaVersion: 1 as const,
      operation: "bounded-link-repair" as const,
      repositoryRevision: state.plan.repositoryRevision,
      planDigest: state.plan.digest,
      outputPath: state.plan.outputPath,
      preimage: {
        sha256: state.plan.preimageSha256,
        byteLength: originalBytes.length,
        mode: state.preparedIdentity.mode & 0o7777,
      },
      postimage: {
        sha256: postimageSha256,
        byteLength: newBytes.length,
        mode: state.preparedIdentity.mode & 0o7777,
      },
      patch: {
        sha256: sha256(patchBytes),
        byteLength: patchBytes.length,
      },
      delivery: state.plan.delivery,
    };
    return { ...value, digest: canonicalDigest(value) };
  } catch (error) {
    if (installedIdentity && originalBytes) {
      try {
        await rollbackInstalledTarget(
          workspace,
          state,
          target.absolutePath,
          installedIdentity,
          originalBytes,
          state.preparedIdentity.mode,
          state.plan.preimageSha256,
          state.plan.outputPath,
        );
      } catch {
        fail("rollback-failed", state.plan.outputPath);
      }
    }
    if (error instanceof BoundedLinkRepairError) throw error;
    fail("write-failed", state.plan.outputPath);
  } finally {
    await originalHandle?.close();
    if (temporaryPath) await safeUnlinkCandidate(workspace, state, temporaryPath);
  }
  fail("write-failed", state.plan.outputPath);
}

async function inspectBoundTarget(
  workspace: RepositoryWorkspace,
  outputPath: string,
): Promise<{
  absolutePath: string;
  identity: FileIdentity;
  byteLength: number;
  ancestors: Array<{ relativePath: string; identity: FileIdentity }>;
}> {
  const root = await realpath(workspace.path);
  const segments = validateRepositoryPath(outputPath, "outputPath").split("/");
  let current = root;
  const rootInfo = await lstat(root);
  const ancestors = [{ relativePath: ".", identity: identity(rootInfo) }];
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]!);
    let info;
    try {
      info = await lstat(current);
    } catch {
      fail("unsafe-path", outputPath);
    }
    if (info.isSymbolicLink()) fail("unsafe-path", outputPath);
    if (index < segments.length - 1 && !info.isDirectory()) fail("unsafe-path", outputPath);
    if (index === segments.length - 1 && !info.isFile()) fail("unsafe-path", outputPath);
    if (index < segments.length - 1) {
      ancestors.push({
        relativePath: segments.slice(0, index + 1).join("/"),
        identity: identity(info),
      });
    }
  }
  const difference = relative(root, current);
  if (difference === ".." || difference.startsWith(`..${sep}`) || isAbsolute(difference)) {
    fail("unsafe-path", outputPath);
  }
  const info = await lstat(current);
  return {
    absolutePath: current,
    identity: identity(info),
    byteLength: info.size,
    ancestors,
  };
}

async function readStableFile(
  handle: FileHandle,
  expected: FileIdentity,
  outputPath: string,
): Promise<{ bytes: Buffer; identity: FileIdentity }> {
  const before = await handle.stat();
  if (!before.isFile() || !sameIdentity(identity(before), expected)) {
    fail("race-detected", outputPath);
  }
  if (before.size > MAX_REPAIR_BYTES) fail("content-too-large", outputPath);
  const bytes = Buffer.alloc(before.size);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (bytesRead === 0) fail("race-detected", outputPath);
    offset += bytesRead;
  }
  const after = await handle.stat();
  if (
    !after.isFile() ||
    !sameIdentity(identity(after), expected) ||
    before.size !== after.size ||
    bytes.length !== after.size
  ) {
    fail("race-detected", outputPath);
  }
  return { bytes, identity: identity(after) };
}

async function assertTargetUnchanged(
  absolutePath: string,
  handle: FileHandle,
  expected: FileIdentity,
  expectedSha256: string,
  outputPath: string,
): Promise<void> {
  const pathInfo = await lstat(absolutePath).catch(() => undefined);
  if (
    !pathInfo ||
    !pathInfo.isFile() ||
    pathInfo.isSymbolicLink() ||
    !sameIdentity(identity(pathInfo), expected)
  ) {
    fail("race-detected", outputPath);
  }
  const current = await readStableFile(handle, expected, outputPath);
  if (sha256(current.bytes) !== expectedSha256) fail("stale-preimage", outputPath);
}

async function assertInstalledTarget(
  absolutePath: string,
  expected: FileIdentity,
  expectedSha256: string,
  outputPath: string,
): Promise<void> {
  const pathInfo = await lstat(absolutePath).catch(() => undefined);
  if (
    !pathInfo ||
    !pathInfo.isFile() ||
    pathInfo.isSymbolicLink() ||
    !sameIdentity(identity(pathInfo), expected)
  ) {
    fail("race-detected", outputPath);
  }
  let handle: FileHandle | undefined;
  try {
    handle = await openNoFollow(absolutePath, fsConstants.O_RDONLY);
    const current = await readStableFile(handle, expected, outputPath);
    if (sha256(current.bytes) !== expectedSha256) fail("race-detected", outputPath);
  } finally {
    await handle?.close();
  }
}

async function writeAtomicCandidate(
  targetPath: string,
  bytes: Buffer,
  mode: number,
): Promise<string> {
  const path = resolve(
    dirname(targetPath),
    `.docsfab-link-repair-${process.pid}-${randomBytes(12).toString("hex")}.tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await openNoFollow(
      path,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.chmod(mode & 0o7777);
    await handle.sync();
    return path;
  } catch (error) {
    await handle?.close();
    await unlink(path).catch(() => undefined);
    throw error;
  } finally {
    await handle?.close();
  }
}

async function rollbackInstalledTarget(
  workspace: RepositoryWorkspace,
  state: BoundedLinkRepairCapabilityState,
  absolutePath: string,
  installed: FileIdentity,
  originalBytes: Buffer,
  originalMode: number,
  originalSha256: string,
  outputPath: string,
): Promise<void> {
  await assertBoundAncestors(workspace, state).catch(() => fail("rollback-failed", outputPath));
  const current = await lstat(absolutePath).catch(() => undefined);
  if (
    !current ||
    !current.isFile() ||
    current.isSymbolicLink() ||
    !sameIdentity(identity(current), installed)
  ) {
    fail("rollback-failed", outputPath);
  }
  const restorePath = await writeAtomicCandidate(absolutePath, originalBytes, originalMode).catch(
    () => fail("rollback-failed", outputPath),
  );
  try {
    const restoreInfo = await lstat(restorePath);
    const restoreIdentity = identity(restoreInfo);
    await assertBoundAncestors(workspace, state).catch(() => fail("rollback-failed", outputPath));
    const stillInstalled = await lstat(absolutePath);
    if (!sameIdentity(identity(stillInstalled), installed)) fail("rollback-failed", outputPath);
    await rename(restorePath, absolutePath);
    await assertInstalledTarget(absolutePath, restoreIdentity, originalSha256, outputPath);
    await chmod(absolutePath, originalMode & 0o7777);
    const final = await lstat(absolutePath);
    if (final.mode !== originalMode) fail("rollback-failed", outputPath);
  } catch (error) {
    await unlink(restorePath).catch(() => undefined);
    if (error instanceof BoundedLinkRepairError && error.code === "rollback-failed") throw error;
    fail("rollback-failed", outputPath);
  }
}

async function assertBoundAncestors(
  workspace: RepositoryWorkspace,
  state: BoundedLinkRepairCapabilityState,
): Promise<void> {
  let inspected: Awaited<ReturnType<typeof inspectBoundTarget>>;
  try {
    inspected = await inspectBoundTarget(workspace, state.plan.outputPath);
  } catch {
    fail("race-detected", state.plan.outputPath);
  }
  if (!sameAncestorChain(inspected.ancestors, state.preparedAncestors)) {
    fail("race-detected", state.plan.outputPath);
  }
}

async function boundAncestorsMatch(
  workspace: RepositoryWorkspace,
  state: BoundedLinkRepairCapabilityState,
): Promise<boolean> {
  try {
    await assertBoundAncestors(workspace, state);
    return true;
  } catch {
    return false;
  }
}

async function safeUnlinkCandidate(
  workspace: RepositoryWorkspace,
  state: BoundedLinkRepairCapabilityState,
  temporaryPath: string,
): Promise<void> {
  try {
    await assertBoundAncestors(workspace, state);
    await unlink(temporaryPath);
  } catch {
    // If the parent chain changed, following the path could mutate outside the
    // workspace. Leave the attacker's moved temporary file untouched.
  }
}

function replaceExactlyOneOldLink(
  bytes: Buffer,
  oldLink: string,
  newLink: string,
  outputPath: string,
): Buffer {
  const content = decodeUtf8(bytes, outputPath);
  const token = `](${oldLink})`;
  const occurrences = countOccurrences(content, token);
  if (occurrences === 0) fail("old-link-missing", outputPath);
  if (occurrences !== 1) fail("old-link-ambiguous", outputPath);
  return Buffer.from(content.replace(token, `](${newLink})`), "utf8");
}

function assertExactlyOneOldLink(bytes: Buffer, oldLink: string, outputPath: string): void {
  const content = decodeUtf8(bytes, outputPath);
  const occurrences = countOccurrences(content, `](${oldLink})`);
  if (occurrences === 0) fail("old-link-missing", outputPath);
  if (occurrences !== 1) fail("old-link-ambiguous", outputPath);
}

function countOccurrences(content: string, token: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = content.indexOf(token, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + token.length;
  }
}

function decodeUtf8(bytes: Buffer, outputPath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("invalid-content", outputPath);
  }
}

function boundedPatchBytes(outputPath: string, before: Buffer, after: Buffer): Buffer {
  const beforeLines = patchLines(decodeUtf8(before, outputPath));
  const afterLines = patchLines(decodeUtf8(after, outputPath));
  if (beforeLines.length !== afterLines.length) fail("invalid-content", outputPath);
  const changed = beforeLines
    .map((line, index) => (line.text === afterLines[index]?.text ? -1 : index))
    .filter((index) => index >= 0);
  if (changed.length !== 1) fail("invalid-content", outputPath);
  const changedIndex = changed[0]!;
  const start = Math.max(0, changedIndex - 3);
  const end = Math.min(beforeLines.length, changedIndex + 4);
  const count = end - start;
  const chunks = [
    `--- a/${outputPath}\n`,
    `+++ b/${outputPath}\n`,
    `@@ -${start + 1},${count} +${start + 1},${count} @@\n`,
  ];
  for (let index = start; index < end; index += 1) {
    if (index === changedIndex) {
      chunks.push(formatPatchLine("-", beforeLines[index]!));
      chunks.push(formatPatchLine("+", afterLines[index]!));
    } else {
      chunks.push(formatPatchLine(" ", beforeLines[index]!));
    }
  }
  return Buffer.from(chunks.join(""), "utf8");
}

function patchLines(content: string): Array<{ text: string; terminated: boolean }> {
  if (content.length === 0) return [];
  const terminated = content.endsWith("\n");
  const values = content.split("\n");
  if (terminated) values.pop();
  return values.map((text, index) => ({
    text,
    terminated: index < values.length - 1 || terminated,
  }));
}

function formatPatchLine(
  prefix: " " | "+" | "-",
  line: { text: string; terminated: boolean },
): string {
  return `${prefix}${line.text}\n${line.terminated ? "" : "\\ No newline at end of file\n"}`;
}

function validateAndSnapshotPlan(
  value: ApprovedBoundedLinkRepairPlan,
  evaluationTime: Date,
): Readonly<ApprovedBoundedLinkRepairPlan> {
  assertEvaluationTime(evaluationTime, "evaluationTime");
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-plan", "plan");
  const expected = [
    "schemaVersion",
    "id",
    "repositoryRevision",
    "outputPath",
    "preimageSha256",
    "oldLink",
    "newLink",
    "approval",
    "expiresAt",
    "delivery",
    "digest",
  ];
  if (
    !closedKeys(value, expected) ||
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    !IDENTIFIER.test(value.id) ||
    typeof value.repositoryRevision !== "string" ||
    !GIT_REVISION.test(value.repositoryRevision) ||
    typeof value.preimageSha256 !== "string" ||
    !SHA256.test(value.preimageSha256) ||
    typeof value.digest !== "string" ||
    !SHA256.test(value.digest)
  ) {
    fail("invalid-plan", "plan");
  }
  validateRepositoryPath(value.outputPath, "plan.outputPath");
  validateRepositoryLink(value.oldLink, "plan.oldLink");
  validateRepositoryLink(value.newLink, "plan.newLink");
  if (value.oldLink === value.newLink) fail("invalid-plan", "plan.newLink");
  if (
    !value.approval ||
    !closedKeys(value.approval, ["status", "requirement", "approvedBy", "approvedAt"]) ||
    value.approval.status !== "approved" ||
    value.approval.requirement !== "maintainer" ||
    typeof value.approval.approvedBy !== "string" ||
    !IDENTIFIER.test(value.approval.approvedBy)
  ) {
    fail("invalid-plan", "plan.approval");
  }
  assertTimestamp(value.approval.approvedAt, "plan.approval.approvedAt");
  assertTimestamp(value.expiresAt, "plan.expiresAt");
  if (
    !value.delivery ||
    !closedKeys(value.delivery, ["mode", "mayMerge", "mayPublish"]) ||
    value.delivery.mode !== "patch-only" ||
    value.delivery.mayMerge !== false ||
    value.delivery.mayPublish !== false
  ) {
    fail("invalid-plan", "plan.delivery");
  }
  if (boundedLinkRepairPlanDigest(value) !== value.digest) fail("invalid-plan", "plan.digest");
  const plan = Object.freeze({
    ...value,
    approval: Object.freeze({ ...value.approval }),
    delivery: Object.freeze({ ...value.delivery }),
  });
  assertAuthorizationEffective(plan, evaluationTime);
  return plan;
}

function resolveCapability(
  capability: BoundedLinkRepairCapability,
): BoundedLinkRepairCapabilityState {
  const state = capabilityStates.get(capability);
  if (!state || !trustedCapabilities.has(capability)) fail("invalid-capability", "capability");
  return state;
}

function assertAuthorizationEffective(
  plan: ApprovedBoundedLinkRepairPlan,
  evaluationTime: Date,
): void {
  const now = evaluationTime.toISOString();
  if (now < plan.approval.approvedAt || now >= plan.expiresAt) {
    fail("authorization-expired", "plan.approval");
  }
}

async function verifyWorkspace(workspace: RepositoryWorkspace): Promise<void> {
  try {
    await verifyActiveRepositoryWorkspace(workspace);
  } catch {
    fail("invalid-workspace", "workspace");
  }
}

function validateRepositoryPath(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4_096 ||
    value !== value.normalize("NFC") ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.startsWith("~") ||
    isAbsolute(value) ||
    !PORTABLE_PATH.test(value)
  ) {
    fail("unsafe-path", path);
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.length > 255 ||
        segment.endsWith(".") ||
        segment.endsWith(" "),
    ) ||
    value.toLowerCase().includes("%2e")
  ) {
    fail("unsafe-path", path);
  }
  return value;
}

function validateRepositoryLink(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 2_048 ||
    value !== value.normalize("NFC") ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.startsWith("~") ||
    !SAFE_LINK.test(value)
  ) {
    fail("unsafe-link", path);
  }
  const [pathname] = value.split("#", 1);
  try {
    validateRepositoryPath(pathname, path);
  } catch (error) {
    if (error instanceof BoundedLinkRepairError) fail("unsafe-link", path);
    throw error;
  }
  return value;
}

function assertEvaluationTime(value: Date, path: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail("invalid-plan", path);
}

function assertTimestamp(value: string, path: string): void {
  if (typeof value !== "string") fail("invalid-plan", path);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail("invalid-plan", path);
  }
}

function closedKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    [...expected].sort().every((key, index) => key === keys[index])
  );
}

function identity(info: { dev: number; ino: number; mode: number }): FileIdentity {
  return { device: info.dev, inode: info.ino, mode: info.mode };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.mode === right.mode;
}

function sameAncestorChain(
  left: readonly { relativePath: string; identity: FileIdentity }[],
  right: readonly { relativePath: string; identity: FileIdentity }[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const expected = right[index];
      return (
        expected?.relativePath === entry.relativePath &&
        sameIdentity(entry.identity, expected.identity)
      );
    })
  );
}

async function openNoFollow(path: string, flags: number, mode?: number): Promise<FileHandle> {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  return open(path, flags | noFollow, mode);
}

function fail(code: BoundedLinkRepairErrorCode, path: string): never {
  throw new BoundedLinkRepairError(code, path);
}
