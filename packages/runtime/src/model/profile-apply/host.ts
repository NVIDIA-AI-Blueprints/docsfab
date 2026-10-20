// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared host/filesystem primitives and validation bottoms for profile-apply.
 * The observe/propose/apply/diagnose seams depend on this module, so it must not
 * import them. Identity-checked FS operations and closed-schema bottoms stay
 * together as one fail-closed surface.
 */
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import {
  lstatSync,
  fstatSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  type BigIntStats,
} from "node:fs";
import { constants, lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { parseModelEndpoint, type ModelEndpointConfig } from "../configuration.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";
import type { ModelProfilePurpose } from "../catalog-contracts.js";
import type { ModelProfileApprovalBundleV1 } from "../profile-approval.js";
import { profileEnvironmentKeys } from "../profile-environment.js";
import { decodeModelProfileInspection } from "../profile-inspection.js";
import { deepFreeze, invalid, kit } from "./dialect.js";
import {
  PROFILE_CLAIM_NAME,
  PROFILE_INTENT_NAME,
  PROFILE_LOCK_NAME,
  ProfileApplyError,
  type GitContext,
  type ProfileConfigurationIdentityV1,
  type StagedOwnerReceipt,
} from "./types.js";
import { sha256 } from "../../content-ir/canonical.js";

const execFile = promisify(execFileCallback);
export const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export function validateIdentity(value: unknown): asserts value is ProfileConfigurationIdentityV1 {
  const record = plainRecord(value);
  exactKeys(record, ["device", "inode", "uid", "gid", "mode", "links", "size"]);
  const candidate = value as ProfileConfigurationIdentityV1;
  if (
    ![candidate.device, candidate.inode, candidate.links, candidate.size].every(
      (item) => typeof item === "string" && /^(?:0|[1-9][0-9]*)$/u.test(item),
    ) ||
    ![candidate.uid, candidate.gid, candidate.mode].every(
      (item) => Number.isSafeInteger(item) && item >= 0,
    ) ||
    candidate.mode > 0o777
  )
    invalid();
}

export function validateDigestObject(value: unknown): void {
  const record = plainRecord(value);
  const sha = ownData(record, "sha256");
  if (typeof sha !== "string" || !/^[a-f0-9]{64}$/u.test(sha)) invalid();
  const unsigned = { ...record };
  delete unsigned.sha256;
  if (digest(unsigned) !== sha) invalid();
}

export function plainRecord(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  )
    invalid();
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor) || !descriptor.enumerable) invalid();
  }
  return kit.object(value);
}

export function ownData(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor)) invalid();
  return descriptor.value;
}

export function exactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  kit.exact(record, [...expected]);
}

export function assertPlainTree(
  value: unknown,
  depth = 0,
  state: { count: number } = { count: 0 },
): void {
  state.count += 1;
  if (depth > 128 || state.count > 100_000) invalid();
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0
    )
      invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !length ||
      !("value" in length) ||
      length.value !== value.length ||
      !Number.isSafeInteger(length.value) ||
      length.value > 100_000
    )
      invalid();
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== length.value + 1) invalid();
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
      assertPlainTree(descriptor.value, depth + 1, state);
    }
    return;
  }
  const record = plainRecord(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(record))) {
    if (!("value" in descriptor)) invalid();
    assertPlainTree(descriptor.value, depth + 1, state);
  }
}

export async function exactProjectRoot(path: string): Promise<{
  path: string;
  identity: ProfileConfigurationIdentityV1;
}> {
  const resolved = resolve(path);
  const actual = await realpath(resolved);
  if (actual !== resolved) invalid();
  const metadata = await lstat(actual, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== BigInt(process.getuid?.() ?? -1) ||
    (Number(metadata.mode & 0o777n) & 0o022) !== 0
  )
    invalid();
  return { path: actual, identity: directoryIdentity(metadata) };
}

export async function exactOwnerArtifactPath(path: string): Promise<string> {
  if (
    typeof path !== "string" ||
    resolve(path) !== path ||
    basename(path) === "." ||
    basename(path) === ".." ||
    basename(path).includes("\0")
  )
    invalid();
  const parent = dirname(path);
  if ((await realpath(parent)) !== parent) invalid();
  const metadata = await lstat(parent, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== BigInt(process.getuid?.() ?? -1) ||
    (Number(metadata.mode & 0o777n) & 0o077) !== 0
  )
    invalid();
  return path;
}

export async function readOwnerConfiguration(path: string): Promise<{
  bytes: Uint8Array;
  identity: ProfileConfigurationIdentityV1;
}> {
  const metadata = await lstat(path, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== BigInt(process.getuid?.() ?? -1) ||
    Number(metadata.mode & 0o777n) !== 0o600 ||
    metadata.nlink !== 1n ||
    metadata.size > 4n * 1024n * 1024n
  )
    invalid();
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameIdentity(identity(before), identity(metadata))) invalid();
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (
      !sameIdentity(identity(before), identity(after)) ||
      !sameIdentity(identity(after), identity(named)) ||
      bytes.length !== Number(after.size)
    )
      invalid();
    return { bytes, identity: identity(after) };
  } finally {
    await handle.close();
  }
}

export async function readOwnerLinkedArtifact(path: string): Promise<{
  bytes: Uint8Array;
  identity: ProfileConfigurationIdentityV1;
}> {
  const metadata = await lstat(path, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== BigInt(process.getuid?.() ?? -1) ||
    Number(metadata.mode & 0o777n) !== 0o600 ||
    (metadata.nlink !== 1n && metadata.nlink !== 2n) ||
    metadata.size > 4n * 1024n * 1024n
  )
    invalid();
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameIdentity(identity(before), identity(metadata))) invalid();
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (
      !sameIdentity(identity(before), identity(after)) ||
      !sameIdentity(identity(after), identity(named)) ||
      bytes.length !== Number(after.size)
    ) {
      invalid();
    }
    return { bytes, identity: identity(after) };
  } finally {
    await handle.close();
  }
}

export async function writeExclusive(
  path: string,
  bytes: Uint8Array,
): Promise<ProfileConfigurationIdentityV1> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    const metadata = await handle.stat({ bigint: true });
    if (
      !metadata.isFile() ||
      metadata.uid !== BigInt(process.getuid?.() ?? -1) ||
      Number(metadata.mode & 0o777n) !== 0o600 ||
      metadata.nlink !== 1n
    )
      invalid();
    return identity(metadata);
  } finally {
    await handle.close();
  }
}

export async function assertRootIdentity(
  path: string,
  expected: ProfileConfigurationIdentityV1,
): Promise<void> {
  const metadata = await lstat(path, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !sameDirectoryIdentity(identity(metadata), expected)
  )
    invalid();
}

export async function assertPathIdentity(
  path: string,
  expected: ProfileConfigurationIdentityV1,
): Promise<void> {
  const metadata = await lstat(path, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    !sameIdentity(identity(metadata), expected)
  )
    invalid();
}

export async function safeUnlink(
  path: string,
  expected: ProfileConfigurationIdentityV1,
): Promise<boolean> {
  try {
    await assertPathIdentity(path, expected);
    await unlink(path);
    return true;
  } catch {
    // A mismatched path is never deleted; fail-closed cleanup leaves it for review.
    return false;
  }
}

export async function safeUnlinkInode(
  path: string,
  expected: ProfileConfigurationIdentityV1,
): Promise<boolean> {
  try {
    const metadata = await lstat(path, { bigint: true });
    const current = identity(metadata);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      current.device !== expected.device ||
      current.inode !== expected.inode ||
      current.uid !== expected.uid
    )
      return false;
    await unlink(path);
    return true;
  } catch (error) {
    return isMissing(error);
  }
}

export function readOwnerConfigurationSync(path: string): {
  bytes: Uint8Array;
  identity: ProfileConfigurationIdentityV1;
} {
  const descriptor = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (
      !before.isFile() ||
      named.isSymbolicLink() ||
      before.uid !== BigInt(process.getuid?.() ?? -1) ||
      Number(before.mode & 0o777n) !== 0o600 ||
      before.nlink !== 1n ||
      !sameIdentity(identity(before), identity(named))
    )
      invalid();
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const finalNamed = lstatSync(path, { bigint: true });
    if (
      !sameIdentity(identity(before), identity(after)) ||
      !sameIdentity(identity(after), identity(finalNamed))
    )
      invalid();
    return { bytes, identity: identity(after) };
  } finally {
    closeSync(descriptor);
  }
}

export function readOwnerLinkedArtifactSync(path: string): {
  bytes: Uint8Array;
  identity: ProfileConfigurationIdentityV1;
} {
  const descriptor = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (
      !before.isFile() ||
      named.isSymbolicLink() ||
      before.uid !== BigInt(process.getuid?.() ?? -1) ||
      Number(before.mode & 0o777n) !== 0o600 ||
      (before.nlink !== 1n && before.nlink !== 2n) ||
      !sameIdentity(identity(before), identity(named))
    )
      invalid();
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const finalNamed = lstatSync(path, { bigint: true });
    if (
      !sameIdentity(identity(before), identity(after)) ||
      !sameIdentity(identity(after), identity(finalNamed)) ||
      bytes.length !== Number(after.size)
    ) {
      invalid();
    }
    return { bytes, identity: identity(after) };
  } finally {
    closeSync(descriptor);
  }
}

export function assertPathIdentitySync(
  path: string,
  expected: ProfileConfigurationIdentityV1,
): void {
  const metadata = lstatSync(path, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    !sameIdentity(identity(metadata), expected)
  )
    invalid();
}

export function assertRootIdentitySync(
  path: string,
  expected: ProfileConfigurationIdentityV1,
): void {
  const metadata = lstatSync(path, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !sameDirectoryIdentity(identity(metadata), expected)
  )
    invalid();
}

export function assertLockIdentitySync(
  descriptor: number,
  path: string,
  expected: ProfileConfigurationIdentityV1,
): void {
  const held = identity(fstatSync(descriptor, { bigint: true }));
  const named = identity(lstatSync(path, { bigint: true }));
  if (!sameIdentity(held, expected) || !sameIdentity(named, expected)) invalid();
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function assertSafeTemporaryState(
  projectRoot: string,
  activeLockIdentity?: ProfileConfigurationIdentityV1,
): Promise<void> {
  const names = await readdir(projectRoot);
  if (
    names.some(
      (name) => name.startsWith(".env.docsfab-new-") || name.startsWith(".env.docsfab-rollback-"),
    )
  )
    invalid();
  if (names.includes(PROFILE_INTENT_NAME) || names.includes(PROFILE_CLAIM_NAME)) invalid();
  if (names.includes(PROFILE_LOCK_NAME)) {
    if (!activeLockIdentity) invalid();
    const lock = identity(await lstat(resolve(projectRoot, PROFILE_LOCK_NAME), { bigint: true }));
    if (!sameIdentity(lock, activeLockIdentity)) invalid();
  } else if (activeLockIdentity) invalid();
  const git = gitContextSync(projectRoot);
  if (!git) return;
  for (const probe of [
    ".env.docsfab-new-probe",
    ".env.docsfab-rollback-probe",
    PROFILE_LOCK_NAME,
    PROFILE_INTENT_NAME,
    PROFILE_CLAIM_NAME,
  ]) {
    try {
      await execFile(
        "git",
        ["-C", git.worktreeRoot, "check-ignore", "--quiet", "--", resolve(projectRoot, probe)],
        {
          env: gitEnvironment(),
          timeout: 5_000,
          maxBuffer: 16 * 1024,
        },
      );
    } catch {
      return invalid();
    }
  }
}

export async function assertRecoveryNamespace(
  projectRoot: string,
  boundTemporaryName: string,
): Promise<void> {
  const names = await readdir(projectRoot);
  const transactionTemporaries = names.filter(
    (name) => name.startsWith(".env.docsfab-new-") || name.startsWith(".env.docsfab-rollback-"),
  );
  if (
    transactionTemporaries.some((name) => name !== boundTemporaryName) ||
    new Set(transactionTemporaries).size !== transactionTemporaries.length
  )
    invalid();
}

export async function assertUntracked(
  projectRoot: string,
  target: string,
  targetIdentity: ProfileConfigurationIdentityV1,
): Promise<void> {
  assertUntrackedSync(projectRoot, target, targetIdentity);
}

export function assertUntrackedSync(
  projectRoot: string,
  target: string,
  targetIdentity: ProfileConfigurationIdentityV1,
): void {
  try {
    const git = gitContextSync(projectRoot);
    if (!git) return;
    rejectIndexAliasesSync(git.worktreeRoot, target, targetIdentity, gitIndexListingSync(git));
  } catch (error) {
    if (error instanceof ProfileApplyError) throw error;
    invalid();
  }
}

export function assertUntrackedIfInRootSync(
  projectRoot: string,
  target: string,
  targetIdentity: ProfileConfigurationIdentityV1,
): void {
  const pathFromRoot = relative(projectRoot, target);
  if (
    pathFromRoot !== "" &&
    !pathFromRoot.startsWith(`..${pathSeparator()}`) &&
    pathFromRoot !== ".." &&
    !isAbsolute(pathFromRoot)
  ) {
    assertUntrackedSync(projectRoot, target, targetIdentity);
  }
}

export function assertNormalTransactionArtifactsSync(
  projectRoot: string,
  rootIdentity: ProfileConfigurationIdentityV1,
  artifacts: readonly { path: string; identity: ProfileConfigurationIdentityV1 }[],
): void {
  assertRootIdentitySync(projectRoot, rootIdentity);
  const git = gitContextSync(projectRoot);
  const listing = git ? gitIndexListingSync(git) : undefined;
  for (const artifact of artifacts) {
    const pathFromRoot = relative(projectRoot, artifact.path);
    if (
      git &&
      listing !== undefined &&
      pathFromRoot !== "" &&
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${pathSeparator()}`) &&
      !isAbsolute(pathFromRoot)
    ) {
      rejectIndexAliasesSync(git.worktreeRoot, artifact.path, artifact.identity, listing);
    }
    assertRootIdentitySync(projectRoot, rootIdentity);
  }
}

export function gitIndexListingSync(git: GitContext): string {
  return execFileSync("git", ["-C", git.worktreeRoot, "ls-files", "-z", "--stage", "--full-name"], {
    env: gitEnvironment(),
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
    encoding: "utf8",
  });
}

export function assertSafeReceiptTargetSync(projectRoot: string, receiptPath: string): void {
  if (typeof receiptPath !== "string" || resolve(receiptPath) !== receiptPath) invalid();
  const pathFromRoot = relative(projectRoot, receiptPath);
  const insideRoot =
    pathFromRoot !== "" &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${pathSeparator()}`) &&
    !isAbsolute(pathFromRoot);
  if (
    insideRoot &&
    !pathFromRoot.includes(pathSeparator()) &&
    (pathFromRoot === ".env" ||
      pathFromRoot === PROFILE_LOCK_NAME ||
      pathFromRoot === PROFILE_INTENT_NAME ||
      pathFromRoot === PROFILE_CLAIM_NAME ||
      pathFromRoot.startsWith(".env.docsfab-new-") ||
      pathFromRoot.startsWith(".env.docsfab-rollback-"))
  )
    invalid();
  const git = gitContextSync(projectRoot);
  if (!git) return;
  for (const gitDirectory of git.gitDirectories) {
    const fromGitDirectory = relative(gitDirectory, receiptPath);
    if (
      fromGitDirectory === "" ||
      (fromGitDirectory !== ".." &&
        !fromGitDirectory.startsWith(`..${pathSeparator()}`) &&
        !isAbsolute(fromGitDirectory))
    )
      invalid();
  }
}

export function gitContextSync(projectRoot: string): GitContext | null {
  try {
    const output = execFileSync(
      "git",
      ["-C", projectRoot, "rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"],
      {
        env: gitEnvironment(),
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
      },
    );
    const lines = output.trim().split("\n");
    if (lines.length !== 3 || lines.some((line) => line.length === 0)) invalid();
    const worktreeRoot = realpathSync(resolve(lines[0]!));
    const gitDirectory = realpathSync(resolve(lines[1]!));
    const commonDirectory = realpathSync(
      isAbsolute(lines[2]!) ? resolve(lines[2]!) : resolve(projectRoot, lines[2]!),
    );
    return { worktreeRoot, gitDirectories: [gitDirectory, commonDirectory] };
  } catch (error) {
    if (error instanceof ProfileApplyError) throw error;
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr)
        : "";
    if (stderr.includes("not a git repository")) return null;
    invalid();
  }
}

export function safeUnlinkInodeSync(
  path: string,
  expected: ProfileConfigurationIdentityV1,
): boolean {
  try {
    const metadata = lstatSync(path, { bigint: true });
    const current = identity(metadata);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      current.device !== expected.device ||
      current.inode !== expected.inode ||
      current.uid !== expected.uid
    )
      return false;
    unlinkSync(path);
    return true;
  } catch (error) {
    return isMissing(error);
  }
}

export function assertReceiptReservationSync(staged: StagedOwnerReceipt): void {
  assertPathIdentitySync(staged.temporary, staged.identity);
  try {
    lstatSync(staged.target, { bigint: true });
    invalid();
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export function cleanupNormalArtifactSync(
  projectRoot: string,
  rootIdentity: ProfileConfigurationIdentityV1,
  path: string,
  artifactIdentity: ProfileConfigurationIdentityV1,
): boolean {
  try {
    assertNormalTransactionArtifactsSync(projectRoot, rootIdentity, [
      { path, identity: artifactIdentity },
    ]);
    return safeUnlinkInodeSync(path, artifactIdentity);
  } catch {
    return false;
  }
}

export function pathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

export function rejectIndexAliasesSync(
  projectRoot: string,
  target: string,
  targetIdentity: ProfileConfigurationIdentityV1,
  listing: string,
): void {
  const targetIndexPath = relative(projectRoot, target).split(pathSeparator()).join("/");
  for (const path of indexPaths(listing)) {
    if (path.normalize("NFC").toLowerCase() === targetIndexPath.normalize("NFC").toLowerCase())
      invalid();
    const candidate = indexedPath(projectRoot, path);
    try {
      const metadata = lstatSync(candidate, { bigint: true });
      if (
        metadata.dev.toString() === targetIdentity.device &&
        metadata.ino.toString() === targetIdentity.inode
      )
        invalid();
      if (realpathSync(candidate) === target) invalid();
    } catch (error) {
      if (error instanceof ProfileApplyError) throw error;
      if (!isMissing(error)) invalid();
    }
  }
}

export function indexPaths(listing: string): string[] {
  if (listing.includes("\uFFFD")) invalid();
  return listing
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf("\t");
      if (tab < 1) return invalid();
      return entry.slice(tab + 1);
    });
}

export function indexedPath(projectRoot: string, path: string): string {
  if (!path || path.includes("\0") || path !== path.normalize("NFC") || isAbsolute(path)) invalid();
  const candidate = resolve(projectRoot, path);
  const back = relative(projectRoot, candidate);
  if (
    !back ||
    back === ".." ||
    back.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(back)
  )
    invalid();
  return candidate;
}

export function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
  };
}

export function isMissing(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT",
  );
}

export async function optionalLstat(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      (error as { code?: unknown }).code !== "ESRCH"
    );
  }
}

export function pathDigest(path: string): string {
  if (typeof path !== "string" || resolve(path) !== path) invalid();
  return sha256(Buffer.from(path));
}

export function rejectAmbientOverrides(
  environment: NodeJS.ProcessEnv,
  purpose: ModelProfilePurpose,
): void {
  const prefix = purpose === "policy" ? "MODEL" : "JUDGE";
  const keys = [
    ...profileEnvironmentKeys(purpose),
    `${prefix}_PROVIDER`,
    `${prefix}_BASE_URL`,
    purpose === "policy" ? "MODEL_ID" : "JUDGE_MODEL_ID",
    `${prefix}_API_FORMAT`,
    `${prefix}_API_MIN_OUTPUT_TOKENS`,
    `${prefix}_CONTEXT_RESERVE_TOKENS`,
  ];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(environment, key);
    if (!descriptor) continue;
    if (!("value" in descriptor) || descriptor.value !== undefined) invalid();
  }
}

export function parsePostimageEndpoint(
  bytes: Uint8Array,
  purpose: ModelProfilePurpose,
  ambient: NodeJS.ProcessEnv,
  now: Date,
): ModelEndpointConfig {
  const environment = dotenvAssignments(bytes);
  const prefix = purpose === "policy" ? "MODEL" : "JUDGE";
  const key = `${prefix}_API_KEY`;
  if (!environment[key]) {
    const descriptor = Object.getOwnPropertyDescriptor(ambient, key);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") invalid();
    environment[key] = descriptor.value;
  }
  return parseModelEndpoint(environment, prefix, now);
}

export function dotenvAssignments(bytes: Uint8Array): NodeJS.ProcessEnv {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid();
  }
  const result: NodeJS.ProcessEnv = {};
  for (const raw of source.split(/\r\n|\n|\r/u)) {
    if (/^\s*(?:#.*)?$/u.test(raw)) continue;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*(?:#.*)?$/u.exec(raw);
    if (!match) invalid();
    const key = match[1]!;
    if (Object.hasOwn(result, key)) invalid();
    let value = match[2]!;
    if (/\$\{|\$\(|`/u.test(value)) invalid();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      if (value.startsWith('"')) {
        try {
          value = JSON.parse(value) as string;
        } catch {
          return invalid();
        }
      } else value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

export function assertEndpointMatches(
  endpoint: ModelEndpointConfig,
  inspection: ReturnType<typeof decodeModelProfileInspection>,
  bundle: ModelProfileApprovalBundleV1,
): void {
  if (
    endpoint.providerId !== inspection.subject.provider ||
    endpoint.modelId !== inspection.subject.model ||
    endpoint.apiFormat !== inspection.subject.apiFormat ||
    !endpointBaseMatchesApprovedOrigin(
      endpoint.baseUrl,
      endpoint.profile.metadata.approvedSource,
    ) ||
    !equal(endpoint.requestPolicy, inspection.runtime.profileEvidence.requestPolicy) ||
    endpoint.profile.metadata.effectiveDate !== bundle.approval.effectiveDate ||
    endpoint.profile.metadata.reviewAfter !== bundle.approval.reviewAfter
  )
    invalid();
}

export function endpointBaseMatchesApprovedOrigin(baseUrl: string, origin: string | null): boolean {
  if (!origin) return false;
  try {
    const base = new URL(baseUrl);
    const approved = new URL(origin);
    return (
      approved.href === approved.origin + "/" &&
      base.origin === approved.origin &&
      base.pathname === "/v1" &&
      base.search === "" &&
      base.hash === "" &&
      base.username === "" &&
      base.password === ""
    );
  } catch {
    return false;
  }
}

export function identity(metadata: BigIntStats): ProfileConfigurationIdentityV1 {
  return {
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    uid: Number(metadata.uid),
    gid: Number(metadata.gid),
    mode: Number(metadata.mode & 0o777n),
    links: metadata.nlink.toString(),
    size: metadata.size.toString(),
  };
}

export function directoryIdentity(metadata: BigIntStats): ProfileConfigurationIdentityV1 {
  return { ...identity(metadata), links: "0", size: "0" };
}

export function sameIdentity(
  left: ProfileConfigurationIdentityV1,
  right: ProfileConfigurationIdentityV1,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.links === right.links &&
    left.size === right.size
  );
}

export function sameInodeOwner(
  left: ProfileConfigurationIdentityV1,
  right: ProfileConfigurationIdentityV1,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.size === right.size
  );
}

export function sameDirectoryIdentity(
  left: ProfileConfigurationIdentityV1,
  right: ProfileConfigurationIdentityV1,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode
  );
}

export function timestamp(value: Date): string {
  if (!Number.isFinite(value.valueOf())) invalid();
  return value.toISOString();
}

export { sha256 };

export function digest(value: unknown): string {
  return sha256(Buffer.from(canonicalizeJsonEvidence(value as JsonEvidenceValue)));
}

export function hexDigest(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    kit.hash(value);
    return true;
  } catch {
    return false;
  }
}

export function equal(left: unknown, right: unknown): boolean {
  return (
    canonicalizeJsonEvidence(left as JsonEvidenceValue) ===
    canonicalizeJsonEvidence(right as JsonEvidenceValue)
  );
}

export { deepFreeze };

export function receiptStageName(receiptPathSha256: string, receiptSha256: string): string {
  return `.docsfab-profile-receipt-${receiptPathSha256}-${receiptSha256}`;
}
