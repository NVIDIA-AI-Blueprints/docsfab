// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Optional private-only `.gitignore` fragment after successful init apply.
 * Never ignores `.docsfab.json` (project config must stay committable).
 */
import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";

import {
  limit,
  OperationalLimitError,
  refuseLimit,
  type LimitSource,
  type ResolvedLimit,
} from "../config/limits.js";
import { DOCSFAB_PROJECT_CONFIG_FILE } from "./types.js";
import { currentUid, isAlreadyExists, isNotFound } from "./shared.js";

export const GITIGNORE_FILE = ".gitignore";
export const PRIVATE_GITIGNORE_ENTRIES = [".docsfab/", ".docsfab-init.*"] as const;

export type PrivateGitignoreEntry = (typeof PRIVATE_GITIGNORE_ENTRIES)[number];
export type GitignoreSkipReason =
  | "unsafe-type"
  | "not-owned"
  | "hardlinked"
  | "too-large"
  | "unreadable"
  | "changed-after-approval"
  | "write-uncertain"
  | "readback-unavailable";
export type GitignoreAppendStatus = "created" | "appended" | "unchanged" | "skipped" | "unknown";

export interface PrivateGitignorePlan {
  path: typeof GITIGNORE_FILE;
  action: "create" | "append" | "none" | "skip";
  missingEntries: readonly PrivateGitignoreEntry[];
  preimageSha256: string;
  maxBytes: number;
  maxBytesSource: LimitSource;
  reason?: GitignoreSkipReason;
  limitExceeded?: GitignoreLimitExceeded;
}

export interface GitignoreLimitExceeded {
  code: string;
  observedBytes: number;
  configuredBytes: number;
  scope: "selected repository .gitignore";
  remediation: string;
}

export interface GitignoreAppendResult {
  status: GitignoreAppendStatus;
  added: readonly string[];
  reason?: GitignoreSkipReason;
  limitExceeded?: GitignoreLimitExceeded;
}

const PRIVATE_ENTRY_SET: ReadonlySet<string> = new Set(PRIVATE_GITIGNORE_ENTRIES);

export function gitignoreLineIgnoresProjectConfig(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return false;
  const pattern = trimmed.replace(/\\/gu, "");
  return (
    pattern === DOCSFAB_PROJECT_CONFIG_FILE ||
    pattern === `/${DOCSFAB_PROJECT_CONFIG_FILE}` ||
    pattern === `**/${DOCSFAB_PROJECT_CONFIG_FILE}` ||
    pattern === `.${DOCSFAB_PROJECT_CONFIG_FILE}`
  );
}

export function assertPrivateOnlyGitignoreEntries(entries: readonly string[]): void {
  for (const entry of entries) {
    if (!PRIVATE_ENTRY_SET.has(entry) || gitignoreLineIgnoresProjectConfig(entry)) {
      throw new Error(
        `DocsFab init must not gitignore the project file ${DOCSFAB_PROJECT_CONFIG_FILE}.`,
      );
    }
  }
}

export function missingPrivateGitignoreEntries(content: string): PrivateGitignoreEntry[] {
  const present = new Set(
    content
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  );
  return PRIVATE_GITIGNORE_ENTRIES.filter((entry) => !privateEntryPresent(present, entry));
}

export function privateGitignoreFragment(entries: readonly string[]): string {
  assertPrivateOnlyGitignoreEntries(entries);
  return `${entries.join("\n")}\n`;
}

export async function appendPrivateGitignoreFragment(
  repositoryPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<GitignoreAppendResult> {
  const plan = await inspectPrivateGitignorePlan(repositoryPath, environment);
  return applyPrivateGitignorePlan(repositoryPath, plan, environment);
}

/** Read only: bind file identity and exact bytes without displaying its content. */
export async function inspectPrivateGitignorePlan(
  repositoryPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PrivateGitignorePlan> {
  const path = resolve(repositoryPath, GITIGNORE_FILE);
  const bound = limit("init.gitignoreMaxBytes", { environment });
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isNotFound(error)) {
      return {
        path: GITIGNORE_FILE,
        action: "create",
        missingEntries: [...PRIVATE_GITIGNORE_ENTRIES],
        preimageSha256: digestPreimage(),
        maxBytes: bound.value,
        maxBytesSource: bound.source,
      };
    }
    if (isUnsafeAccess(error)) return skipPlan("unreadable", digestPreimage(), bound);
    throw error;
  }
  const identity = digestPreimage(metadata);
  if (!metadata.isFile()) return skipPlan("unsafe-type", identity, bound);
  if (metadata.uid !== currentUid()) return skipPlan("not-owned", identity, bound);
  if (metadata.nlink !== 1) return skipPlan("hardlinked", identity, bound);
  if (metadata.size < 0) return skipPlan("unreadable", identity, bound);
  if (metadata.size > bound.value)
    return skipPlan("too-large", identity, bound, limitExceeded(bound, metadata.size));

  let handle: FileHandle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | nofollowFlag());
  } catch (error) {
    if (isUnsafeAccess(error)) return skipPlan("unreadable", identity, bound);
    if (isNotFound(error))
      throw new Error(".gitignore changed during preview; rerun init and approve a fresh plan.");
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!sameSnapshotIdentity(opened, metadata))
      throw new Error(".gitignore changed during preview; rerun init and approve a fresh plan.");
    const bytes = await handle.readFile();
    if (bytes.byteLength !== metadata.size)
      throw new Error(".gitignore changed during preview; rerun init and approve a fresh plan.");
    const finalMetadata = await handle.stat();
    if (!sameSnapshotIdentity(finalMetadata, metadata))
      throw new Error(".gitignore changed during preview; rerun init and approve a fresh plan.");
    const missingEntries = missingPrivateGitignoreEntries(bytes.toString("utf8"));
    const preimageSha256 = digestPreimage(metadata, bytes);
    if (missingEntries.length > 0) {
      const content = bytes.toString("utf8");
      const prefix = content.length === 0 || content.endsWith("\n") ? "" : "\n";
      const afterBytes =
        bytes.byteLength +
        Buffer.byteLength(`${prefix}${privateGitignoreFragment(missingEntries)}`);
      if (afterBytes > bound.value)
        return skipPlan(
          "too-large",
          preimageSha256,
          bound,
          limitExceeded(bound, afterBytes),
          missingEntries,
        );
    }
    return {
      path: GITIGNORE_FILE,
      action: missingEntries.length === 0 ? "none" : "append",
      missingEntries,
      preimageSha256,
      maxBytes: bound.value,
      maxBytesSource: bound.source,
    };
  } finally {
    await handle.close();
  }
}

function limitExceeded(bound: ResolvedLimit, observedBytes: number): GitignoreLimitExceeded {
  try {
    refuseLimit(bound, observedBytes);
  } catch (error) {
    if (!(error instanceof OperationalLimitError)) throw error;
    return {
      code: error.code,
      observedBytes: error.observed,
      configuredBytes: error.configured,
      scope: "selected repository .gitignore",
      remediation: bound.remediation,
    };
  }
}

export async function assertPrivateGitignorePlanCurrent(
  repositoryPath: string,
  approved: PrivateGitignorePlan,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const fresh = await inspectPrivateGitignorePlan(repositoryPath, environment);
  if (!samePlan(fresh, approved)) {
    throw new Error(
      ".gitignore changed after approval; the approved project file was not written.",
    );
  }
}

/** Apply only the previewed change. A changed preimage never gains new authority. */
export async function applyPrivateGitignorePlan(
  repositoryPath: string,
  approved: PrivateGitignorePlan,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<GitignoreAppendResult> {
  const fresh = await inspectPrivateGitignorePlan(repositoryPath, environment);
  if (!samePlan(fresh, approved)) return skipped("changed-after-approval");
  if (approved.action === "skip")
    return skipped(approved.reason ?? "unreadable", approved.limitExceeded);
  if (approved.action === "none") return { status: "unchanged", added: [] };
  const path = resolve(repositoryPath, GITIGNORE_FILE);
  return approved.action === "create"
    ? createPrivateGitignore(path, approved, environment)
    : appendPlannedGitignore(path, approved, environment);
}

async function appendPlannedGitignore(
  path: string,
  approved: PrivateGitignorePlan,
  environment: NodeJS.ProcessEnv,
): Promise<GitignoreAppendResult> {
  let handle: FileHandle;
  try {
    handle = await open(path, fsConstants.O_RDWR | nofollowFlag());
  } catch (error) {
    if (isNotFound(error) || isUnsafeAccess(error)) return skipped("changed-after-approval");
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== currentUid() || metadata.nlink !== 1)
      return skipped("changed-after-approval");
    if (metadata.size < 0 || metadata.size > approved.maxBytes)
      return skipped("changed-after-approval");
    const existing = await handle.readFile();
    if (existing.byteLength !== metadata.size) return skipped("changed-after-approval");
    if (digestPreimage(metadata, existing) !== approved.preimageSha256)
      return skipped("changed-after-approval");
    const content = existing.toString("utf8");
    const missing = missingPrivateGitignoreEntries(content);
    if (missing.join("\n") !== approved.missingEntries.join("\n"))
      return skipped("changed-after-approval");
    const prefix = content.length === 0 || content.endsWith("\n") ? "" : "\n";
    const appended = Buffer.from(`${prefix}${privateGitignoreFragment(missing)}`, "utf8");
    try {
      await handle.appendFile(appended);
      await handle.sync();
    } catch {
      return { status: "unknown", added: [], reason: "write-uncertain" };
    }
    const expected = Buffer.concat([existing, appended]);
    return (await confirmsWrittenBytes(path, handle, expected, environment))
      ? { status: "appended", added: missing }
      : { status: "unknown", added: [], reason: "write-uncertain" };
  } finally {
    await handle.close();
  }
}

async function createPrivateGitignore(
  path: string,
  approved: PrivateGitignorePlan,
  environment: NodeJS.ProcessEnv,
): Promise<GitignoreAppendResult> {
  const bytes = Buffer.from(privateGitignoreFragment(approved.missingEntries), "utf8");
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | nofollowFlag(),
      0o644,
    );
  } catch (error) {
    if (isAlreadyExists(error) || isUnsafeAccess(error)) return skipped("changed-after-approval");
    throw error;
  }
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } catch {
      return { status: "unknown", added: [], reason: "write-uncertain" };
    }
    return (await confirmsWrittenBytes(path, handle, bytes, environment))
      ? { status: "created", added: approved.missingEntries }
      : { status: "unknown", added: [], reason: "write-uncertain" };
  } finally {
    await handle?.close();
  }
}

async function confirmsWrittenBytes(
  repositoryFile: string,
  handle: FileHandle,
  expected: Buffer,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  try {
    const metadata = await handle.stat();
    const fresh = await inspectPrivateGitignorePlan(resolve(repositoryFile, ".."), environment);
    return fresh.action === "none" && fresh.preimageSha256 === digestPreimage(metadata, expected);
  } catch {
    return false;
  }
}

function skipPlan(
  reason: GitignoreSkipReason,
  preimageSha256: string,
  bound: ResolvedLimit,
  limitExceeded?: GitignoreLimitExceeded,
  missingEntries: readonly PrivateGitignoreEntry[] = [],
): PrivateGitignorePlan {
  return {
    path: GITIGNORE_FILE,
    action: "skip",
    missingEntries,
    preimageSha256,
    maxBytes: bound.value,
    maxBytesSource: bound.source,
    reason,
    ...(limitExceeded ? { limitExceeded } : {}),
  };
}

function skipped(
  reason: GitignoreSkipReason,
  limitExceeded?: GitignoreLimitExceeded,
): GitignoreAppendResult {
  return { status: "skipped", added: [], reason, ...(limitExceeded ? { limitExceeded } : {}) };
}

function samePlan(left: PrivateGitignorePlan, right: PrivateGitignorePlan): boolean {
  return (
    left.path === right.path &&
    left.action === right.action &&
    left.reason === right.reason &&
    left.preimageSha256 === right.preimageSha256 &&
    left.maxBytes === right.maxBytes &&
    left.maxBytesSource === right.maxBytesSource &&
    JSON.stringify(left.limitExceeded) === JSON.stringify(right.limitExceeded) &&
    left.missingEntries.join("\n") === right.missingEntries.join("\n")
  );
}

function sameSnapshotIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size
  );
}

function digestPreimage(metadata?: Stats, bytes?: Buffer): string {
  const hash = createHash("sha256");
  if (!metadata) return hash.update("absent").digest("hex");
  hash.update(
    JSON.stringify([
      metadata.dev,
      metadata.ino,
      metadata.uid,
      metadata.mode,
      metadata.nlink,
      metadata.size,
    ]),
  );
  if (bytes) hash.update(bytes);
  return hash.digest("hex");
}

function nofollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
}

function isUnsafeAccess(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "EACCES" || error.code === "EPERM" || error.code === "ELOOP";
}

function privateEntryPresent(present: ReadonlySet<string>, entry: PrivateGitignoreEntry): boolean {
  if (present.has(entry)) return true;
  if (entry === ".docsfab/") {
    return present.has(".docsfab") || present.has(".docsfab/*") || present.has("/.docsfab/");
  }
  return present.has(`/${entry}`);
}
