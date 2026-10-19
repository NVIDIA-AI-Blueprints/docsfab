// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared git/filesystem/lock primitives for delivery worktrees.
 * Layering: validate/publish-plan/materialize depend on this module; it must
 * stay free of those seams.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  readlink,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";
import { DeliveryWorktreeError, type DeliveryWorktreeFailureCode } from "../contracts.js";
import {
  SAFE_GIT_CONFIG,
  capabilities,
  type DeliveryCommandResult,
  type DeliveryCommandRunner,
  type DeliveryRegistration,
  type DeliveryWorktreeCapability,
  type EffectiveGitConfigEntry,
  type FsIdentity,
  type GitConfigSnapshot,
  type GitMetadataPin,
  type GitTreeEntry,
  type TrustedCapability,
} from "./types.js";
import { isRecord as plainRecord } from "../../shared/primitives.js";

export async function branchRevision(trusted: TrustedCapability): Promise<string | undefined> {
  return directRefRevision(
    trusted.commonGitDirectory,
    `refs/heads/${trusted.branch}`,
    "cleanup-refused",
  );
}

export async function branchFingerprint(trusted: TrustedCapability): Promise<string | undefined> {
  const revision = await branchRevision(trusted);
  if (revision === undefined) return undefined;
  const ref = `refs/heads/${trusted.branch}`;
  return createHash("sha256")
    .update(revision)
    .update("\0")
    .update(await metadataPathFingerprint(join(trusted.commonGitDirectory, ...ref.split("/"))))
    .update(
      await metadataPathFingerprint(join(trusted.commonGitDirectory, "logs", ...ref.split("/"))),
    )
    .update(await metadataPathFingerprint(join(trusted.commonGitDirectory, "packed-refs")))
    .digest("hex");
}

export async function metadataPathFingerprint(path: string): Promise<Buffer> {
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) fail("cleanup-refused");
    return Buffer.concat([
      Buffer.from(`${details.dev}\0${details.ino}\0${details.mode}\0${details.size}\0`),
      await readFile(path),
    ]);
  } catch (error) {
    if (error instanceof DeliveryWorktreeError) throw error;
    if (plainRecord(error) && error.code === "ENOENT") return Buffer.from("absent\0");
    fail("cleanup-refused");
  }
}

export async function enumerateEffectiveGitConfiguration(
  commands: DeliveryCommandRunner,
  cwd: string,
): Promise<EffectiveGitConfigEntry[]> {
  const result = await runGit(
    commands,
    ["config", "--includes", "--show-origin", "--null", "--list"],
    cwd,
  );
  if (result.exitCode !== 0) fail("source-repository-mismatch");
  const fields = text(result.stdout).split("\0");
  if (fields.at(-1) === "") fields.pop();
  expectEven(fields.length);
  const entries: EffectiveGitConfigEntry[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const origin = fields[index]!;
    const keyValue = fields[index + 1]!;
    const separator = keyValue.indexOf("\n");
    if (separator <= 0) fail("source-repository-mismatch");
    entries.push({
      origin,
      key: keyValue.slice(0, separator).toLowerCase(),
      value: keyValue.slice(separator + 1),
    });
  }
  rejectDangerousEffectiveGitConfiguration(entries);
  return entries;
}

export function rejectDangerousEffectiveGitConfiguration(entries: EffectiveGitConfigEntry[]): void {
  for (const entry of entries) {
    const dangerous =
      /^(?:core\.(?:hookspath|fsmonitor|attributesfile|worktree)|diff\.external|diff\..*\.(?:command|textconv)|filter\..*\.(?:clean|smudge|process|required))$/u.test(
        entry.key,
      );
    if (!dangerous) continue;
    const safeCommandLine =
      entry.origin === "command line:" &&
      ((entry.key === "core.hookspath" && entry.value === "/dev/null") ||
        (entry.key === "core.fsmonitor" && entry.value === "false"));
    if (!safeCommandLine) fail("source-repository-mismatch");
  }
}

export function expectEven(value: number): void {
  if (value % 2 !== 0) fail("source-repository-mismatch");
}

export { plainRecord };

export async function deliveryRegistrations(
  _commands: DeliveryCommandRunner,
  trusted: TrustedCapability,
): Promise<DeliveryRegistration[]> {
  const registrations: DeliveryRegistration[] = [];
  const root = join(trusted.commonGitDirectory, "worktrees");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (plainRecord(error) && error.code === "ENOENT") return [];
    fail("source-state-changed");
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !safeRepositoryPath(entry.name)) {
      fail("source-state-changed");
    }
    const gitDirectory = await canonicalPath(join(root, entry.name));
    if (!within(root, gitDirectory) || gitDirectory === root) fail("source-state-changed");
    const gitFileTarget = (
      await readFile(join(gitDirectory, "gitdir"), "utf8").catch(() => fail("source-state-changed"))
    ).trimEnd();
    if (!isAbsolute(gitFileTarget) || !gitFileTarget.endsWith(`${sep}.git`)) {
      fail("source-state-changed");
    }
    const path = resolve(gitFileTarget, "..");
    const directHead = await readDirectHead(gitDirectory, "source-state-changed");
    const branch = directHead.branch;
    const head = branch
      ? await directRefRevision(trusted.commonGitDirectory, branch, "source-state-changed")
      : directHead.revision;
    if (
      path === trusted.worktreePath ||
      (trusted.createsSourceBranch && branch === `refs/heads/${trusted.branch}`) ||
      (trusted.retainedHeadShape?.startsWith("attached-") &&
        branch === `refs/heads/${trusted.branch}`)
    ) {
      registrations.push({
        path,
        gitDirectory,
        ...(head ? { head } : {}),
        ...(branch ? { branch } : {}),
      });
    }
  }
  return registrations;
}

export async function discoverDeliveryPartialState(
  commands: DeliveryCommandRunner,
  trusted: TrustedCapability,
  expectedRevision?: string,
): Promise<void> {
  const registrations = await deliveryRegistrations(commands, trusted);
  if (registrations.length > 1) fail("source-state-changed");
  const registration = registrations[0];
  if (
    registration &&
    (registration.path !== trusted.worktreePath ||
      (trusted.retainedHeadShape
        ? trusted.retainedHeadShape.startsWith("attached-")
          ? registration.branch !== `refs/heads/${trusted.branch}`
          : registration.branch !== undefined
        : trusted.createsSourceBranch
          ? registration.branch !== `refs/heads/${trusted.branch}`
          : registration.branch !== undefined) ||
      (expectedRevision !== undefined && registration.head !== expectedRevision))
  ) {
    fail("source-state-changed");
  }
  trusted.worktreeRegistered = registration !== undefined;
  const revision = await branchRevision(trusted);
  if (
    trusted.createsSourceBranch &&
    revision !== undefined &&
    expectedRevision !== undefined &&
    revision !== expectedRevision
  ) {
    fail("source-state-changed");
  }
  trusted.branchCreated = trusted.createsSourceBranch && revision !== undefined;
  if (await pathExists(trusted.worktreePath)) {
    trusted.worktreeIdentity = await identity(
      trusted.worktreePath,
      "worktree-creation-failed",
      "directory",
    );
    const gitDirectory = await resolveGitDirectoryFromWorktree(
      trusted.worktreePath,
      "worktree-creation-failed",
    );
    if (
      !registration ||
      registration.gitDirectory !== gitDirectory ||
      !within(join(trusted.commonGitDirectory, "worktrees"), gitDirectory) ||
      (await resolveCommonGitDirectory(gitDirectory, "worktree-creation-failed")) !==
        trusted.commonGitDirectory
    )
      fail("worktree-creation-failed");
    trusted.deliveryGitDirectory = gitDirectory;
    const worktreeConfigPath = join(gitDirectory, "config.worktree");
    if (!trusted.gitConfigSnapshot.pins.some((pin) => pin.path === worktreeConfigPath)) {
      trusted.gitConfigSnapshot.pins.push(await captureGitMetadataPin(worktreeConfigPath));
    }
  } else {
    trusted.worktreeIdentity = undefined;
  }
  trusted.worktreeRemoved = !trusted.worktreeRegistered && !trusted.worktreeIdentity;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (plainRecord(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function resolveGitDirectoryFromWorktree(
  worktreePath: string,
  code: DeliveryWorktreeFailureCode,
): Promise<string> {
  const dotGit = join(worktreePath, ".git");
  try {
    const details = await lstat(dotGit);
    if (details.isSymbolicLink()) fail(code);
    if (details.isDirectory()) return canonicalPath(dotGit);
    if (!details.isFile()) fail(code);
    const bytes = await readFile(dotGit);
    const value = bytes.toString("utf8");
    if (!Buffer.from(value).equals(bytes)) fail(code);
    const match = /^gitdir: ([^\0\r\n]+)\n?$/u.exec(value);
    if (!match) fail(code);
    return canonicalPath(resolve(worktreePath, match[1]!));
  } catch (error) {
    if (error instanceof DeliveryWorktreeError) throw error;
    fail(code);
  }
}

export async function resolveCommonGitDirectory(
  gitDirectory: string,
  code: DeliveryWorktreeFailureCode,
): Promise<string> {
  const commondirPath = join(gitDirectory, "commondir");
  try {
    const details = await lstat(commondirPath);
    if (details.isSymbolicLink() || !details.isFile()) fail(code);
    const bytes = await readFile(commondirPath);
    const value = bytes.toString("utf8");
    if (!Buffer.from(value).equals(bytes) || !/^[^\0\r\n]+\n?$/u.test(value)) fail(code);
    return canonicalPath(resolve(gitDirectory, value.trimEnd()));
  } catch (error) {
    if (error instanceof DeliveryWorktreeError) throw error;
    if (plainRecord(error) && error.code === "ENOENT") return canonicalPath(gitDirectory);
    fail(code);
  }
}

export async function readDirectHead(
  gitDirectory: string,
  code: DeliveryWorktreeFailureCode,
): Promise<{ branch?: string; revision?: string; bytes: Buffer }> {
  try {
    const path = join(gitDirectory, "HEAD");
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) fail(code);
    const bytes = await readFile(path);
    const value = bytes.toString("utf8");
    if (!Buffer.from(value).equals(bytes)) fail(code);
    const symbolic = /^ref: (refs\/[A-Za-z0-9._\/-]+)\n?$/u.exec(value);
    if (symbolic && safeGitRef(symbolic[1]!)) return { branch: symbolic[1], bytes };
    const detached = /^([a-f0-9]{40}|[a-f0-9]{64})\n?$/u.exec(value);
    if (detached) return { revision: detached[1], bytes };
    fail(code);
  } catch (error) {
    if (error instanceof DeliveryWorktreeError) throw error;
    fail(code);
  }
}

export function safeGitRef(value: string): boolean {
  return (
    value.startsWith("refs/") &&
    safeRepositoryPath(value) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !/[ ~^:?*[\\]/u.test(value) &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock")
  );
}

export async function readDirectRefs(
  commonGitDirectory: string,
  code: DeliveryWorktreeFailureCode,
): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  const packedPath = join(commonGitDirectory, "packed-refs");
  if (await pathExists(packedPath)) {
    const details = await lstat(packedPath);
    if (details.isSymbolicLink() || !details.isFile()) fail(code);
    const packed = await readFile(packedPath, "utf8");
    for (const line of packed.split(/\r?\n/u)) {
      if (!line || line.startsWith("#") || line.startsWith("^")) continue;
      const match = /^([a-f0-9]{40}|[a-f0-9]{64}) (refs\/.+)$/u.exec(line);
      if (!match || !safeGitRef(match[2]!)) fail(code);
      refs.set(match[2]!, match[1]!);
    }
  }
  await readLooseRefs(commonGitDirectory, "refs", refs, code);
  return refs;
}

export async function readLooseRefs(
  commonGitDirectory: string,
  relativePath: string,
  refs: Map<string, string>,
  code: DeliveryWorktreeFailureCode,
): Promise<void> {
  const directory = join(commonGitDirectory, ...relativePath.split("/"));
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (plainRecord(error) && error.code === "ENOENT") return;
    fail(code);
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const ref = `${relativePath}/${entry.name}`;
    if (!safeGitRef(ref) || entry.isSymbolicLink()) fail(code);
    if (entry.isDirectory()) {
      await readLooseRefs(commonGitDirectory, ref, refs, code);
      continue;
    }
    if (!entry.isFile()) fail(code);
    const bytes = await readFile(join(commonGitDirectory, ...ref.split("/")));
    const value = bytes.toString("utf8");
    if (!Buffer.from(value).equals(bytes)) fail(code);
    const direct = /^([a-f0-9]{40}|[a-f0-9]{64})\n?$/u.exec(value);
    if (direct) {
      refs.set(ref, direct[1]!);
      continue;
    }
    const symbolic = /^ref: (refs\/[A-Za-z0-9._\/-]+)\n?$/u.exec(value);
    if (!symbolic || !safeGitRef(symbolic[1]!)) fail(code);
    refs.set(ref, `symref:${symbolic[1]}:${createHash("sha256").update(bytes).digest("hex")}`);
  }
}

/**
 * The ref names that `start` reaches through symbolic refs, `start` first, ending at the first ref
 * that is not symbolic. Git resolves a worktree's HEAD this way, so a branch that HEAD reaches through
 * a symbolic branch is as checked out as one that HEAD names. Each ref is visited once, so the walk
 * ends within the refs that exist rather than at a depth cap, and a cycle fails closed.
 */
export function symbolicRefChain(
  refs: ReadonlyMap<string, string>,
  start: string,
  code: DeliveryWorktreeFailureCode,
): string[] {
  const chain: string[] = [];
  const visited = new Set<string>();
  let current = start;
  while (!visited.has(current)) {
    visited.add(current);
    chain.push(current);
    const symbolic = /^symref:(refs\/[A-Za-z0-9._\/-]+):[a-f0-9]{64}$/u.exec(
      refs.get(current) ?? "",
    );
    if (!symbolic) return chain;
    if (!safeGitRef(symbolic[1]!)) fail(code);
    current = symbolic[1]!;
  }
  return fail(code);
}

export async function directRefRevision(
  commonGitDirectory: string,
  ref: string,
  code: DeliveryWorktreeFailureCode,
): Promise<string | undefined> {
  if (!safeGitRef(ref)) fail(code);
  const refs = await readDirectRefs(commonGitDirectory, code);
  let current = ref;
  const visited = new Set<string>();
  for (let depth = 0; depth < 16; depth += 1) {
    if (visited.has(current)) fail(code);
    visited.add(current);
    const value = refs.get(current);
    if (value === undefined) {
      if (depth === 0) return undefined;
      fail(code);
    }
    if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) return value;
    const symbolic = /^symref:(refs\/[A-Za-z0-9._\/-]+):[a-f0-9]{64}$/u.exec(value);
    if (!symbolic || !safeGitRef(symbolic[1]!)) fail(code);
    current = symbolic[1]!;
  }
  fail(code);
}

export async function readGitTree(
  commands: DeliveryCommandRunner,
  cwd: string,
  tree: string,
): Promise<GitTreeEntry[]> {
  const output = await requireGit(
    commands,
    cwd,
    ["ls-tree", "-lrz", "--full-tree", tree],
    "patch-application-failed",
  );
  const records = output.toString("utf8").split("\0");
  if (records.at(-1) === "") records.pop();
  const entries: GitTreeEntry[] = [];
  for (const record of records) {
    const match =
      /^([0-7]{6}) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})\s+([0-9]+|-)\t([\s\S]+)$/u.exec(
        record,
      );
    if (!match) fail("patch-application-failed");
    const [, mode, type, oid, sizeText, path] = match;
    if (
      type !== "blob" ||
      (mode !== "100644" && mode !== "100755" && mode !== "120000") ||
      sizeText === "-" ||
      !path ||
      !safeRepositoryPath(path)
    ) {
      fail("patch-application-failed");
    }
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0 || size > 50 * 1024 * 1024) {
      fail("patch-application-failed");
    }
    const result = await runGit(commands, ["cat-file", "blob", oid!], cwd, {
      maxOutputBytes: size + 1,
    });
    if (result.exitCode !== 0 || result.stdout.byteLength !== size) {
      fail("patch-application-failed");
    }
    entries.push({ path, mode, oid: oid!, bytes: Buffer.from(result.stdout) });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return entries;
}

export async function assertFilesystemMatchesGitTree(
  root: string,
  entries: readonly GitTreeEntry[],
  code: DeliveryWorktreeFailureCode,
): Promise<void> {
  const actualPaths = await collectFilesystemLeafPaths(root, "", code);
  const expectedPaths = entries.map((entry) => entry.path).sort();
  if (
    canonicalizeJsonEvidence(actualPaths as unknown as JsonEvidenceValue) !==
    canonicalizeJsonEvidence(expectedPaths as unknown as JsonEvidenceValue)
  )
    fail(code);
  for (const entry of entries) {
    const path = join(root, ...entry.path.split("/"));
    const details = await lstat(path).catch(() => fail(code));
    if (entry.mode === "120000") {
      if (!details.isSymbolicLink() || !Buffer.from(await readlink(path)).equals(entry.bytes))
        fail(code);
      continue;
    }
    if (
      details.isSymbolicLink() ||
      !details.isFile() ||
      (details.mode & 0o777) !== (entry.mode === "100755" ? 0o755 : 0o644)
    )
      fail(code);
    const bytes = await readFile(path).catch(() => fail(code));
    if (!bytes.equals(entry.bytes)) fail(code);
  }
}

export async function collectFilesystemLeafPaths(
  root: string,
  relativePath: string,
  code: DeliveryWorktreeFailureCode,
): Promise<string[]> {
  const directory = relativePath ? join(root, ...relativePath.split("/")) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const paths: string[] = [];
  for (const entry of entries) {
    const path = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (path === ".git") continue;
    if (!safeRepositoryPath(path)) fail(code);
    if (entry.isDirectory()) {
      const details = await lstat(join(root, ...path.split("/")));
      if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o777) !== 0o755) {
        fail(code);
      }
      paths.push(...(await collectFilesystemLeafPaths(root, path, code)));
    } else paths.push(path);
  }
  return paths.sort();
}

export async function filesystemState(root: string): Promise<string> {
  const hash = createHash("sha256");
  await hashDirectory(root, "", hash);
  return hash.digest("hex");
}

export async function hashDirectory(
  root: string,
  relativePath: string,
  hash: ReturnType<typeof createHash>,
): Promise<void> {
  const directory = relativePath ? join(root, relativePath) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const absolute = join(root, ...path.split("/"));
    const details = await lstat(absolute);
    // A source checkout owns a .git directory whose worktree metadata changes as
    // an expected Git operation. A linked worktree instead has a security-critical
    // .git gitfile; include that file's bytes and identity in the fingerprint.
    if (path === ".git" && details.isDirectory()) continue;
    if (path !== ".git" && !safeRepositoryPath(path)) fail("source-state-changed");
    hash
      .update(path)
      .update("\0")
      .update(String(details.mode & 0o7777))
      .update("\0");
    if (details.isSymbolicLink()) {
      hash
        .update("link\0")
        .update(await readlink(absolute))
        .update("\0");
    } else if (details.isFile()) {
      hash
        .update("file\0")
        .update(await readFile(absolute))
        .update("\0");
    } else if (details.isDirectory()) {
      hash.update("directory\0");
      await hashDirectory(root, path, hash);
    } else {
      fail("source-state-changed");
    }
  }
}

export async function canonicalOwnerDirectory(
  path: string,
  code: DeliveryWorktreeFailureCode,
  ownerOnly: boolean,
): Promise<string> {
  try {
    const canonical = await canonicalPath(path);
    const details = await stat(canonical);
    if (!details.isDirectory() || (ownerOnly && !ownerOnlyDirectory(details))) fail(code);
    return canonical;
  } catch (error) {
    if (error instanceof DeliveryWorktreeError) throw error;
    fail(code);
  }
}

export function ownerOnlyDirectory(details: Stats): boolean {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return (
    uid !== undefined &&
    details.isDirectory() &&
    details.uid === uid &&
    (details.mode & 0o077) === 0
  );
}

export function fileIdentity(details: Stats): FsIdentity {
  return { dev: details.dev, ino: details.ino, uid: details.uid, mode: details.mode };
}

export async function identity(
  path: string,
  code: DeliveryWorktreeFailureCode,
  kind: "directory" | "file",
): Promise<FsIdentity> {
  try {
    const details = await lstat(path);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      uid === undefined ||
      details.isSymbolicLink() ||
      details.uid !== uid ||
      (kind === "directory" ? !details.isDirectory() : !details.isFile())
    )
      fail(code);
    return fileIdentity(details);
  } catch (error) {
    if (error instanceof DeliveryWorktreeError) throw error;
    fail(code);
  }
}

export async function assertIdentity(
  path: string,
  expected: FsIdentity,
  code: DeliveryWorktreeFailureCode,
  kind: "directory" | "file",
): Promise<void> {
  const actual = await identity(path, code, kind);
  if (
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.uid !== expected.uid ||
    actual.mode !== expected.mode
  )
    fail(code);
}

export async function assertTrustedPaths(
  trusted: TrustedCapability,
  includeWorktree: boolean,
): Promise<void> {
  await assertIdentity(
    trusted.deliveryRootPath,
    trusted.deliveryRootIdentity,
    "delivery-root-unsafe",
    "directory",
  );
  await assertIdentity(
    trusted.capsulePath,
    trusted.capsuleIdentity,
    "delivery-root-unsafe",
    "directory",
  );
  if (includeWorktree) {
    if (!trusted.worktreeIdentity) fail("worktree-creation-failed");
    await assertIdentity(
      trusted.worktreePath,
      trusted.worktreeIdentity,
      "worktree-creation-failed",
      "directory",
    );
  }
}

export async function verifyPinnedPatch(
  trusted: TrustedCapability,
  code: DeliveryWorktreeFailureCode,
): Promise<Buffer> {
  await assertIdentity(trusted.capsulePath, trusted.capsuleIdentity, code, "directory");
  const path = join(trusted.capsulePath, "verified.patch");
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let verified: Buffer | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollow);
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.dev !== trusted.patchIdentity.dev ||
      before.ino !== trusted.patchIdentity.ino ||
      before.uid !== trusted.patchIdentity.uid ||
      before.mode !== trusted.patchIdentity.mode ||
      before.size !== trusted.plan.patch.byteLength
    )
      fail(code);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    await assertIdentity(path, trusted.patchIdentity, code, "file");
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mode !== before.mode ||
      after.size !== before.size ||
      createHash("sha256").update(bytes).digest("hex") !== trusted.patchSha256
    )
      fail(code);
    verified = bytes;
  } catch (error) {
    if (error instanceof DeliveryWorktreeError) throw error;
    fail(code);
  } finally {
    await handle?.close();
  }
  if (!verified) fail(code);
  return verified;
}

export async function withRepositoryLock<T>(
  repositoryPath: string,
  authorizeMutation: () => void,
  action: () => Promise<T>,
): Promise<T> {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined) fail("source-repository-mismatch");
  const lockRoot = join(tmpdir(), `docsfab-delivery-locks-${uid}`);
  authorizeMutation();
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const rootIdentity = await identity(lockRoot, "source-repository-mismatch", "directory");
  if ((rootIdentity.mode & 0o777) !== 0o700) fail("source-repository-mismatch");
  const lockName = createHash("sha256").update(repositoryPath).digest("hex");
  const lockPath = join(lockRoot, lockName);
  const deadline = Date.now() + 30_000;
  let lockIdentity: FsIdentity | undefined;
  while (!lockIdentity) {
    try {
      await assertIdentity(lockRoot, rootIdentity, "source-repository-mismatch", "directory");
      const currentRoot = await identity(lockRoot, "source-repository-mismatch", "directory");
      if ((currentRoot.mode & 0o777) !== 0o700) fail("source-repository-mismatch");
      authorizeMutation();
      await mkdir(lockPath, { mode: 0o700 });
      lockIdentity = await identity(lockPath, "source-repository-mismatch", "directory");
    } catch (error) {
      if (error instanceof DeliveryWorktreeError) throw error;
      if (Date.now() >= deadline) fail("delivery-collision");
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  try {
    return await action();
  } finally {
    const tombstone = `${lockPath}.release-${randomUUID()}`;
    try {
      const currentRoot = await identity(lockRoot, "cleanup-failed", "directory");
      if ((currentRoot.mode & 0o777) !== 0o700) fail("cleanup-failed");
      await assertIdentity(lockPath, lockIdentity, "cleanup-failed", "directory");
      await rename(lockPath, tombstone);
      await assertIdentity(tombstone, lockIdentity, "cleanup-failed", "directory");
      await rm(tombstone, { recursive: true });
    } catch {
      // Never delete an unverified lock pathname. A stale owner-only lock fails
      // future attempts closed and is safer than deleting another process' lock.
    }
  }
}

export async function captureGitMetadataPin(
  path: string,
  required = false,
): Promise<GitMetadataPin> {
  try {
    const pinnedIdentity = await identity(path, "source-repository-mismatch", "file");
    const bytes = await readFile(path);
    await assertIdentity(path, pinnedIdentity, "source-repository-mismatch", "file");
    return {
      path,
      identity: pinnedIdentity,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    };
  } catch (error) {
    if (error instanceof DeliveryWorktreeError && required) throw error;
    try {
      await lstat(path);
      fail("source-repository-mismatch");
    } catch (missing) {
      if (missing instanceof DeliveryWorktreeError) throw missing;
      if (!plainRecord(missing) || missing.code !== "ENOENT") fail("source-repository-mismatch");
      return { path };
    }
  }
}

export async function assertGitMetadataPin(
  pin: GitMetadataPin,
  code: DeliveryWorktreeFailureCode,
): Promise<void> {
  if (!pin.identity) {
    try {
      await lstat(pin.path);
      fail(code);
    } catch (error) {
      if (error instanceof DeliveryWorktreeError) throw error;
      if (!plainRecord(error) || error.code !== "ENOENT") fail(code);
      return;
    }
  }
  await assertIdentity(pin.path, pin.identity, code, "file");
  const bytes = await readFile(pin.path).catch(() => fail(code));
  await assertIdentity(pin.path, pin.identity, code, "file");
  if (createHash("sha256").update(bytes).digest("hex") !== pin.sha256) fail(code);
}

export async function captureGitConfigSnapshot(
  commands: DeliveryCommandRunner,
  cwd: string,
  mandatoryPaths: string[],
): Promise<GitConfigSnapshot> {
  const entries = await enumerateEffectiveGitConfiguration(commands, cwd);
  const originPaths = entries.flatMap((entry) =>
    entry.origin.startsWith("file:") ? [resolve(cwd, entry.origin.slice("file:".length))] : [],
  );
  const uniquePaths = [...new Set([...mandatoryPaths, ...originPaths])];
  const pins = await Promise.all(
    uniquePaths.map((path) => captureGitMetadataPin(path, mandatoryPaths[0] === path)),
  );
  const snapshot = { pins, validatedContexts: new Set<string>() };
  await assertGitConfigSnapshot(snapshot, "source-repository-mismatch");
  const confirmed = await enumerateEffectiveGitConfiguration(commands, cwd);
  if (
    canonicalizeJsonEvidence(entries as unknown as JsonEvidenceValue) !==
    canonicalizeJsonEvidence(confirmed as unknown as JsonEvidenceValue)
  )
    fail("source-repository-mismatch");
  snapshot.validatedContexts.add(await gitConfigContext(cwd));
  return snapshot;
}

export async function assertGitConfigSnapshot(
  snapshot: GitConfigSnapshot,
  code: DeliveryWorktreeFailureCode,
): Promise<void> {
  for (const pin of snapshot.pins) await assertGitMetadataPin(pin, code);
}

export async function validateEffectiveGitConfiguration(
  commands: DeliveryCommandRunner,
  snapshot: GitConfigSnapshot,
  cwd: string,
  code: DeliveryWorktreeFailureCode,
): Promise<void> {
  const context = await gitConfigContext(cwd);
  if (snapshot.validatedContexts.has(context)) return;
  await assertGitConfigSnapshot(snapshot, code);
  const before = await enumerateEffectiveGitConfiguration(commands, cwd);
  const known = new Set(snapshot.pins.map((pin) => pin.path));
  for (const entry of before) {
    if (!entry.origin.startsWith("file:")) continue;
    const path = resolve(cwd, entry.origin.slice("file:".length));
    if (!known.has(path)) {
      snapshot.pins.push(await captureGitMetadataPin(path, true));
      known.add(path);
    }
  }
  await assertGitConfigSnapshot(snapshot, code);
  const after = await enumerateEffectiveGitConfiguration(commands, cwd);
  if (
    canonicalizeJsonEvidence(before as unknown as JsonEvidenceValue) !==
    canonicalizeJsonEvidence(after as unknown as JsonEvidenceValue)
  )
    fail(code);
  snapshot.validatedContexts.add(context);
}

export async function gitConfigContext(cwd: string): Promise<string> {
  const dotGit = join(cwd, ".git");
  try {
    const details = await lstat(dotGit);
    let headPath: string;
    if (details.isDirectory()) {
      headPath = join(dotGit, "HEAD");
    } else if (details.isFile() && !details.isSymbolicLink()) {
      const gitFile = await readFile(dotGit, "utf8");
      const match = /^gitdir: (.+)\n?$/u.exec(gitFile);
      if (!match) fail("source-repository-mismatch");
      headPath = resolve(cwd, match[1]!, "HEAD");
    } else {
      fail("source-repository-mismatch");
    }
    return createHash("sha256")
      .update(resolve(cwd))
      .update("\0")
      .update(await readFile(headPath))
      .digest("hex");
  } catch (error) {
    if (error instanceof DeliveryWorktreeError) throw error;
    // Commands rooted at the source are validated against the source checkout;
    // a missing delivery path receives a distinct context until materialized.
    return createHash("sha256").update(resolve(cwd)).update("\0absent").digest("hex");
  }
}

export function pinnedGitCommands(
  commands: DeliveryCommandRunner,
  snapshot: GitConfigSnapshot,
  code: DeliveryWorktreeFailureCode,
  authorizedBranchDeletion?: string,
): DeliveryCommandRunner {
  return {
    async run(command, args, cwd, options) {
      await assertGitConfigSnapshot(snapshot, code);
      if (command === "git") await validateEffectiveGitConfiguration(commands, snapshot, cwd, code);
      const operation = gitOperationArgs(args);
      const branchDeletion =
        command === "git" &&
        authorizedBranchDeletion &&
        operation[0] === "branch" &&
        operation[1] === "-D" &&
        operation.at(-1) === authorizedBranchDeletion;
      const effectiveBefore = branchDeletion
        ? await enumerateEffectiveGitConfiguration(commands, cwd)
        : undefined;
      const result = await commands.run(command, args, cwd, options);
      if (branchDeletion) {
        await authorizeExactBranchConfigDelta(
          commands,
          snapshot,
          cwd,
          authorizedBranchDeletion,
          effectiveBefore!,
          code,
        );
        return result;
      }
      await assertGitConfigSnapshot(snapshot, code);
      if (command === "git") await validateEffectiveGitConfiguration(commands, snapshot, cwd, code);
      return result;
    },
  };
}

export function gitOperationArgs(args: readonly string[]): readonly string[] {
  let index = 0;
  while (args[index] === "-c" && args[index + 1] !== undefined) index += 2;
  return args.slice(index);
}

export async function authorizeExactBranchConfigDelta(
  commands: DeliveryCommandRunner,
  snapshot: GitConfigSnapshot,
  cwd: string,
  branch: string,
  beforeEntries: EffectiveGitConfigEntry[],
  code: DeliveryWorktreeFailureCode,
): Promise<void> {
  const refreshed: GitMetadataPin[] = [];
  for (const pin of snapshot.pins) {
    const current = await captureGitMetadataPin(pin.path, pin.identity !== undefined);
    if (sameGitPin(pin, current)) {
      refreshed.push(pin);
      continue;
    }
    if (!pin.identity || !pin.sha256 || !current.identity || !current.sha256) fail(code);
    const before = await readPinnedBytes(pin, code);
    const after = await readFile(current.path).catch(() => fail(code));
    if (!after.equals(removeExactBranchSection(before, branch))) fail(code);
    refreshed.push(current);
  }
  const afterEntries = await enumerateEffectiveGitConfiguration(commands, cwd);
  const prefix = `branch.${branch.toLowerCase()}.`;
  const expectedEntries = beforeEntries.filter((entry) => !entry.key.startsWith(prefix));
  if (
    canonicalizeJsonEvidence(expectedEntries as unknown as JsonEvidenceValue) !==
    canonicalizeJsonEvidence(afterEntries as unknown as JsonEvidenceValue)
  )
    fail(code);
  snapshot.pins = refreshed;
  snapshot.validatedContexts.clear();
  snapshot.validatedContexts.add(await gitConfigContext(cwd));
}

export function sameGitPin(left: GitMetadataPin, right: GitMetadataPin): boolean {
  if (!left.identity || !right.identity) return left.identity === right.identity;
  return (
    left.identity.dev === right.identity.dev &&
    left.identity.ino === right.identity.ino &&
    left.identity.uid === right.identity.uid &&
    left.identity.mode === right.identity.mode &&
    left.sha256 === right.sha256
  );
}

export async function readPinnedBytes(
  pin: GitMetadataPin,
  code: DeliveryWorktreeFailureCode,
): Promise<Buffer> {
  // The prior bytes are needed only across an authorized branch deletion. Keep
  // them in the pin digest boundary rather than accepting a wholesale refresh.
  const bytes = pin.bytes;
  if (bytes && createHash("sha256").update(bytes).digest("hex") === pin.sha256) return bytes;
  fail(code);
}

export function removeExactBranchSection(bytes: Buffer, branch: string): Buffer {
  const textValue = bytes.toString("utf8");
  if (!Buffer.from(textValue).equals(bytes)) fail("cleanup-refused");
  const escaped = branch.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const section = new RegExp(
    `^\\s*\\[branch\\s+"${escaped}"\\]\\s*(?:[#;].*)?\\r?\\n(?:^(?!\\s*\\[)[^\\r\\n]*(?:\\r?\\n|$))*`,
    "mu",
  );
  return Buffer.from(textValue.replace(section, ""));
}

export async function requireGit(
  commands: DeliveryCommandRunner,
  cwd: string,
  args: readonly string[],
  code: DeliveryWorktreeFailureCode,
): Promise<Buffer> {
  const result = await runGit(commands, args, cwd);
  if (result.exitCode !== 0) fail(code);
  return result.stdout;
}

export function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: "/dev/null",
    XDG_CONFIG_HOME: "/dev/null",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    GIT_PAGER: "cat",
    GIT_ALLOW_PROTOCOL: "file",
  };
}

export async function runGit(
  commands: DeliveryCommandRunner,
  args: readonly string[],
  cwd: string,
  options: {
    stdin?: Uint8Array;
    timeoutMs?: number;
    maxOutputBytes?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<DeliveryCommandResult> {
  assertSafeGitOperation(args);
  const { env, ...runnerOptions } = options;
  return commands.run("git", [...SAFE_GIT_CONFIG, ...args], cwd, {
    ...runnerOptions,
    env: { ...gitEnvironment(), ...env },
  });
}

export function assertSafeGitOperation(args: readonly string[]): void {
  const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
  const exact = (...expected: string[]): boolean =>
    args.length === expected.length && expected.every((value, index) => args[index] === value);
  if (
    exact("rev-parse", "--show-toplevel") ||
    exact("rev-parse", "--git-common-dir") ||
    exact("rev-parse", "--git-path", "config.worktree") ||
    exact("config", "--includes", "--show-origin", "--null", "--list") ||
    exact("write-tree")
  )
    return;
  if (
    args[0] === "rev-parse" &&
    args[1] === "--verify" &&
    args.length === 3 &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})\^\{commit\}$/u.test(args[2]!)
  )
    return;
  if (
    args[0] === "remote" &&
    args[1] === "get-url" &&
    args.length >= 4 &&
    args.at(-2) === "--all" &&
    typeof args.at(-1) === "string" &&
    (args.length === 4 || (args.length === 5 && args[2] === "--push"))
  )
    return;
  if (
    args[0] === "worktree" &&
    args[1] === "add" &&
    args[2] === "--no-checkout" &&
    args[3] === "-b" &&
    args.length === 7 &&
    safeRepositoryPath(args[4]!) &&
    isAbsolute(args[5]!) &&
    oid.test(args[6]!)
  )
    return;
  if (
    args[0] === "worktree" &&
    args[1] === "add" &&
    args[2] === "--no-checkout" &&
    args[3] === "--detach" &&
    args.length === 6 &&
    isAbsolute(args[4]!) &&
    oid.test(args[5]!)
  )
    return;
  if (args[0] === "read-tree" && args.length === 2 && oid.test(args[1]!)) return;
  if (
    exact(
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      "--find-renames",
      "--find-copies",
      "--find-copies-harder",
      "--",
    )
  )
    return;
  if (exact("ls-files", "--stage", "-z", "--")) return;
  if (args[0] === "cat-file" && args[1] === "-s" && args.length === 3 && oid.test(args[2]!)) return;
  if (
    exact("apply", "--check", "--cached", "--binary", "-") ||
    exact("apply", "--cached", "--binary", "-")
  )
    return;
  if (
    args[0] === "diff-tree" &&
    args.length === 13 &&
    exact(
      "diff-tree",
      "--no-commit-id",
      "--no-ext-diff",
      "--no-textconv",
      "-r",
      "--name-status",
      "-z",
      "--find-renames",
      "--find-copies",
      "--find-copies-harder",
      args[10]!,
      args[11]!,
      "--",
    ) &&
    oid.test(args[10]!) &&
    oid.test(args[11]!)
  )
    return;
  if (
    args[0] === "ls-tree" &&
    args.length === 4 &&
    exact("ls-tree", "-lrz", "--full-tree", args[3]!) &&
    oid.test(args[3]!)
  )
    return;
  if (
    args[0] === "cat-file" &&
    args.length === 3 &&
    (args[1] === "blob" || args[1] === "commit") &&
    oid.test(args[2]!)
  )
    return;
  if (args[0] === "worktree" && args[1] === "remove" && args.length === 3 && isAbsolute(args[2]!))
    return;
  if (
    args[0] === "worktree" &&
    args[1] === "remove" &&
    args[2] === "--force" &&
    args.length === 4 &&
    isAbsolute(args[3]!)
  )
    return;
  if (
    args[0] === "branch" &&
    args[1] === "-D" &&
    args[2] === "--" &&
    args.length === 4 &&
    safeRepositoryPath(args[3]!)
  )
    return;
  // Compare-and-delete of one DocsFab run branch at an exact tip. Without `--no-deref`, Git deletes
  // the ref that a symbolic ref names instead of the symbolic ref. The branch part takes only the
  // characters that DocsFab mints, which leaves out the control and invisible Unicode characters
  // that Git accepts in a ref name.
  if (
    args[0] === "update-ref" &&
    args[1] === "--no-deref" &&
    args[2] === "-d" &&
    args[3] === "--" &&
    args.length === 6 &&
    /^refs\/heads\/docsfab-run\/[a-z0-9._/-]+$/u.test(args[4]!) &&
    safeGitRef(args[4]!) &&
    oid.test(args[5]!)
  )
    return;
  fail("source-repository-mismatch");
}

export function requireCapability(value: DeliveryWorktreeCapability): TrustedCapability {
  const trusted = capabilities.get(value);
  if (!trusted) fail("cleanup-refused");
  return trusted;
}

export function setCapabilityState(
  value: DeliveryWorktreeCapability,
  state: DeliveryWorktreeCapability["state"],
): void {
  const trusted = requireCapability(value);
  trusted.state = state;
  value.state = state;
}

export function safeRepositoryPath(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.normalize("NFC") &&
    !value.startsWith("/") &&
    !value.startsWith("~") &&
    !/^[A-Za-z]:[\\/]/u.test(value) &&
    !value.includes("\\") &&
    value.split("/").every((segment) => Boolean(segment) && segment !== "." && segment !== "..")
  );
}

export function within(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return candidate === "" || (!candidate.startsWith(`..${sep}`) && candidate !== "..");
}

export async function canonicalPath(path: string): Promise<string> {
  return realpath(resolve(path));
}

export function text(value: Buffer): string {
  return value.toString("utf8");
}

export function fail(code: DeliveryWorktreeFailureCode): never {
  throw new DeliveryWorktreeError(code);
}
