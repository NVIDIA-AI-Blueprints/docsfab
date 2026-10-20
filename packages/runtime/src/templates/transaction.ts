// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  recheckTemplatePathPlan,
  MAX_TEMPLATE_OUTPUTS,
  TemplatePathError,
  type CanonicalTemplatePath,
  type TemplatePathPlan,
} from "./paths.js";

export const MAX_RENDERED_TEMPLATE_BYTES = 1024 * 1024;
export const MAX_TEMPLATE_TRANSACTION_BYTES = 8 * 1024 * 1024;

export interface RenderedTemplateBinding {
  relativePath: string;
  /** Exact rendered UTF-8 text. It is never retained in the durable summary. */
  content: string;
}

export interface TemplateTransactionInput {
  plan: TemplatePathPlan;
  rendered: readonly RenderedTemplateBinding[];
}

export interface TemplateTransactionOutputEvidence {
  relativePath: string;
  sha256: string;
  byteLength: number;
}

/** Content-free, host-path-free evidence suitable for a durable run record. */
export interface TemplateTransactionSummary {
  schemaVersion: 1;
  planDigest: string;
  outputs: TemplateTransactionOutputEvidence[];
  totalByteLength: number;
}

export interface TemplateTransactionHookContext {
  index: number;
  relativePath: string;
  /** Ephemeral path for deterministic failure injection; never returned in summaries. */
  absolutePath: string;
}

export interface TemplateTransactionDependencies {
  beforeExclusiveWrite?(context: TemplateTransactionHookContext): void | Promise<void>;
  /** Deterministic race seam after the final path check and before exclusive open. */
  beforeExclusiveOpen?(context: TemplateTransactionHookContext): void | Promise<void>;
  afterExclusiveWrite?(context: TemplateTransactionHookContext): void | Promise<void>;
  /**
   * Validate the completed write set before the transaction is accepted.
   * A failure rolls back every file and directory created by this transaction.
   */
  afterAllWrites?(): void | Promise<void>;
  /** Deterministic seam for descriptor-close failure coverage. */
  closeOwnedFile?(handle: FileHandle, index: number): void | Promise<void>;
  /** Deterministic seam for a link race immediately before rollback unlink. */
  beforeRollbackUnlink?(absolutePath: string): void | Promise<void>;
}

export type TemplateTransactionErrorCode =
  | "binding-mismatch"
  | "invalid-content"
  | "content-too-large"
  | "plan-invalid"
  | "race-detected"
  | "write-failed"
  | "rollback-failed";

export class TemplateTransactionError extends Error {
  public constructor(
    public readonly code: TemplateTransactionErrorCode,
    /** Repository-relative output path or a content-free input location. */
    public readonly path: string,
  ) {
    super(`Template transaction failed (${code}) at ${path}.`);
    this.name = "TemplateTransactionError";
  }
}

interface ValidatedBinding {
  relativePath: string;
  bytes: Buffer;
  sha256: string;
}

interface OwnedFilesystemEntry {
  path: string;
  device: number;
  inode: number;
}

interface OwnedFileEntry extends OwnedFilesystemEntry {
  /** Keep the created inode live so an unlinked replacement cannot reuse it. */
  handle: FileHandle;
}

/**
 * Apply a sealed path plan as one rollback-capable transaction. No existing
 * path is overwritten, and no rendered content is returned or recorded.
 */
export async function applyTemplateTransaction(
  input: TemplateTransactionInput,
  dependencies: TemplateTransactionDependencies = {},
): Promise<TemplateTransactionSummary> {
  if (!Array.isArray(input.plan.outputs) || input.plan.outputs.length > MAX_TEMPLATE_OUTPUTS) {
    throw new TemplateTransactionError("plan-invalid", "$.plan.outputs");
  }
  const bindings = validateBindings(input.plan, input.rendered);
  let plan: TemplatePathPlan;
  try {
    plan = await recheckTemplatePathPlan(input.plan);
  } catch (error) {
    if (error instanceof TemplatePathError) {
      throw new TemplateTransactionError(
        error.code === "plan-changed" ? "plan-invalid" : "race-detected",
        safeErrorPath(error.path),
      );
    }
    throw new TemplateTransactionError("plan-invalid", "$.plan");
  }

  const createdFiles: OwnedFileEntry[] = [];
  const createdDirectories: OwnedFilesystemEntry[] = [];
  const createdDirectorySet = new Set<string>();
  let activeRelativePath = "$.transaction";
  try {
    for (let index = 0; index < plan.outputs.length; index += 1) {
      const output = plan.outputs[index]!;
      const binding = bindings.get(output.relativePath)!;
      activeRelativePath = output.relativePath;
      await createMissingParents(plan, output, createdDirectories, createdDirectorySet);
      await assertSafeWriteTarget(plan, output, createdDirectorySet);
      const context: TemplateTransactionHookContext = {
        index,
        relativePath: output.relativePath,
        absolutePath: output.absolutePath,
      };
      await dependencies.beforeExclusiveWrite?.(context);
      // The hook is an intentional race/failure seam, so containment must be
      // checked again after it and immediately before O_EXCL creation.
      await assertSafeWriteTarget(plan, output, createdDirectorySet);
      await dependencies.beforeExclusiveOpen?.(context);
      await writeExclusive(plan, output, binding.bytes, createdFiles);
      await dependencies.afterExclusiveWrite?.(context);
    }
    activeRelativePath = "$.afterAllWrites";
    await dependencies.afterAllWrites?.();
    activeRelativePath = "$.closeOwnedFiles";
    await closeOwnedFiles(createdFiles, dependencies.closeOwnedFile);
  } catch (error) {
    const rollbackSucceeded = await rollback(createdFiles, createdDirectories, dependencies);
    if (!rollbackSucceeded) {
      throw new TemplateTransactionError("rollback-failed", activeRelativePath);
    }
    if (error instanceof TemplateTransactionError) throw error;
    if (error instanceof TemplatePathError) {
      throw new TemplateTransactionError("race-detected", safeErrorPath(error.path));
    }
    throw new TemplateTransactionError("write-failed", activeRelativePath);
  }
  const outputs = plan.outputs.map((output) => {
    const binding = bindings.get(output.relativePath)!;
    return {
      relativePath: output.relativePath,
      sha256: binding.sha256,
      byteLength: binding.bytes.byteLength,
    };
  });
  return {
    schemaVersion: 1,
    planDigest: plan.digest,
    outputs,
    totalByteLength: outputs.reduce((total, output) => total + output.byteLength, 0),
  };
}

function validateBindings(
  plan: TemplatePathPlan,
  rendered: readonly RenderedTemplateBinding[],
): ReadonlyMap<string, ValidatedBinding> {
  if (!Array.isArray(rendered)) fail("binding-mismatch", "$.rendered");
  const planned = new Set(plan.outputs.map((output) => output.relativePath));
  const bindings = new Map<string, ValidatedBinding>();
  let totalBytes = 0;
  rendered.forEach((binding, index) => {
    const path = `$.rendered[${index}]`;
    if (
      !binding ||
      typeof binding !== "object" ||
      Array.isArray(binding) ||
      Object.keys(binding).some((key) => key !== "relativePath" && key !== "content") ||
      !Object.hasOwn(binding, "relativePath") ||
      !Object.hasOwn(binding, "content") ||
      typeof binding.relativePath !== "string" ||
      !planned.has(binding.relativePath) ||
      bindings.has(binding.relativePath)
    ) {
      fail("binding-mismatch", path);
    }
    if (typeof binding.content !== "string" || binding.content.includes("\0")) {
      fail("invalid-content", `${path}.content`);
    }
    const bytes = Buffer.from(binding.content, "utf8");
    if (bytes.toString("utf8") !== binding.content) {
      fail("invalid-content", `${path}.content`);
    }
    if (bytes.byteLength > MAX_RENDERED_TEMPLATE_BYTES) {
      fail("content-too-large", `${path}.content`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TEMPLATE_TRANSACTION_BYTES) {
      fail("content-too-large", "$.rendered");
    }
    bindings.set(binding.relativePath, {
      relativePath: binding.relativePath,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  });
  if (bindings.size !== planned.size) fail("binding-mismatch", "$.rendered");
  return bindings;
}

async function createMissingParents(
  plan: TemplatePathPlan,
  output: CanonicalTemplatePath,
  createdDirectories: OwnedFilesystemEntry[],
  createdDirectorySet: Set<string>,
): Promise<void> {
  for (const directory of output.missingParentDirectories) {
    if (createdDirectorySet.has(directory)) continue;
    await assertExistingDirectoryChain(plan.workspacePath, dirname(directory));
    if (await pathExists(directory)) race(output.relativePath);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch {
      race(output.relativePath);
    }
    let metadata;
    try {
      metadata = await lstat(directory);
    } catch {
      race(output.relativePath);
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) race(output.relativePath);
    createdDirectories.push(ownedEntry(directory, metadata));
    createdDirectorySet.add(directory);
  }
}

async function assertSafeWriteTarget(
  plan: TemplatePathPlan,
  output: CanonicalTemplatePath,
  createdDirectorySet: ReadonlySet<string>,
): Promise<void> {
  const expected = resolve(plan.workspacePath, ...output.relativePath.split("/"));
  if (expected !== output.absolutePath || !isInside(plan.workspacePath, expected)) {
    throw new TemplateTransactionError("plan-invalid", output.relativePath);
  }
  await assertExistingDirectoryChain(plan.workspacePath, dirname(expected));
  for (const directory of createdDirectorySet) {
    if (!isInside(plan.workspacePath, directory)) {
      throw new TemplateTransactionError("plan-invalid", output.relativePath);
    }
  }
  if (await pathExists(expected)) race(output.relativePath);
}

async function assertExistingDirectoryChain(
  workspacePath: string,
  targetDirectory: string,
): Promise<void> {
  if (!isInside(workspacePath, targetDirectory)) {
    throw new TemplateTransactionError("plan-invalid", "$.plan.outputs");
  }
  const difference = relative(workspacePath, targetDirectory);
  let current = workspacePath;
  for (const segment of difference.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch {
      race(relative(workspacePath, current).split(sep).join("/"));
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      race(relative(workspacePath, current).split(sep).join("/"));
    }
    const canonical = await realpath(current);
    if (!isInside(workspacePath, canonical)) {
      race(relative(workspacePath, current).split(sep).join("/"));
    }
  }
}

async function writeExclusive(
  plan: TemplatePathPlan,
  output: CanonicalTemplatePath,
  bytes: Buffer,
  createdFiles: OwnedFileEntry[],
): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(
      output.absolutePath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw new TemplateTransactionError("race-detected", "$.exclusive-create");
  }
  let retained = false;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) race(output.relativePath);
    const owned: OwnedFileEntry = {
      ...ownedEntry(output.absolutePath, metadata),
      handle,
    };
    createdFiles.push(owned);
    retained = true;
    // O_NOFOLLOW protects only the leaf. Revalidate the complete parent chain
    // and prove the opened descriptor is still the leaf reached from the
    // workspace path before writing any rendered bytes.
    await assertExistingDirectoryChain(plan.workspacePath, dirname(output.absolutePath));
    const leaf = await lstat(output.absolutePath);
    if (leaf.isSymbolicLink() || !leaf.isFile() || !sameIdentity(owned, leaf)) {
      race(output.relativePath);
    }
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    if (!retained) await handle.close();
  }
}

async function rollback(
  files: readonly OwnedFileEntry[],
  directories: readonly OwnedFilesystemEntry[],
  dependencies: TemplateTransactionDependencies,
): Promise<boolean> {
  let succeeded = true;
  for (const file of [...files].reverse()) {
    try {
      const held = await file.handle.stat();
      if (!held.isFile() || !sameIdentity(file, held)) {
        succeeded = false;
        continue;
      }
      let metadata;
      try {
        metadata = await lstat(file.path);
      } catch (error) {
        if (!isMissing(error) || (await file.handle.stat()).nlink !== 0) succeeded = false;
        continue;
      }
      if (
        held.nlink !== 1 ||
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.nlink !== 1 ||
        !sameIdentity(file, metadata)
      ) {
        succeeded = false;
        continue;
      }
      if (!(await quarantineAndRemoveOwnedFile(file, dependencies))) succeeded = false;
    } catch (error) {
      succeeded = false;
    } finally {
      await file.handle.close().catch(() => {
        succeeded = false;
      });
    }
  }
  for (const directory of [...directories].reverse()) {
    try {
      const metadata = await lstat(directory.path);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        !sameIdentity(directory, metadata)
      ) {
        succeeded = false;
        continue;
      }
      await rmdir(directory.path);
    } catch (error) {
      if (!isMissing(error)) succeeded = false;
    }
  }
  return succeeded;
}

/**
 * Rename first, then inspect the moved inode. This avoids unlinking a pathname
 * that was substituted after its last identity check. A substituted regular
 * file is restored with O_EXCL hard-link semantics and is never deleted.
 */
async function quarantineAndRemoveOwnedFile(
  file: OwnedFileEntry,
  dependencies: TemplateTransactionDependencies,
): Promise<boolean> {
  let quarantineDirectory: string | undefined;
  let quarantinePath: string | undefined;
  let quarantineContainsPath = false;
  let succeeded = true;
  try {
    quarantineDirectory = await mkdtemp(join(dirname(file.path), ".docsfab-rollback-"));
    quarantinePath = join(quarantineDirectory, basename(file.path));
    await dependencies.beforeRollbackUnlink?.(file.path);
    try {
      await rename(file.path, quarantinePath);
      quarantineContainsPath = true;
    } catch (error) {
      if (!isMissing(error) || (await file.handle.stat()).nlink !== 0) succeeded = false;
    }
    if (quarantineContainsPath) {
      const [held, moved] = await Promise.all([file.handle.stat(), lstat(quarantinePath)]);
      if (
        !held.isFile() ||
        held.nlink !== 1 ||
        !sameIdentity(file, held) ||
        !moved.isFile() ||
        moved.isSymbolicLink() ||
        moved.nlink !== 1 ||
        !sameIdentity(file, moved)
      ) {
        try {
          await link(quarantinePath, file.path);
          await unlink(quarantinePath);
          quarantineContainsPath = false;
        } catch {
          // Keep the quarantined replacement intact when an exclusive restore fails.
        }
        succeeded = false;
      } else {
        await unlink(quarantinePath);
        quarantineContainsPath = false;
        const afterUnlink = await file.handle.stat();
        if (!sameIdentity(file, afterUnlink) || afterUnlink.nlink !== 0) succeeded = false;
      }
    }
  } catch {
    succeeded = false;
  } finally {
    if (quarantineDirectory && !quarantineContainsPath) {
      try {
        await rmdir(quarantineDirectory);
      } catch {
        succeeded = false;
      }
    }
  }
  return succeeded;
}

async function closeOwnedFiles(
  files: readonly OwnedFileEntry[],
  closeOwnedFile?: (handle: FileHandle, index: number) => void | Promise<void>,
): Promise<void> {
  const results = await Promise.allSettled(
    files.map((file, index) =>
      closeOwnedFile ? closeOwnedFile(file.handle, index) : file.handle.close(),
    ),
  );
  if (results.some((result) => result.status === "rejected")) {
    throw new Error("Template transaction descriptor close failed.");
  }
}

function ownedEntry(path: string, metadata: { dev: number; ino: number }): OwnedFilesystemEntry {
  return { path, device: metadata.dev, inode: metadata.ino };
}

function sameIdentity(
  expected: Pick<OwnedFilesystemEntry, "device" | "inode">,
  actual: { dev: number; ino: number },
): boolean {
  return expected.device === actual.dev && expected.inode === actual.ino;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isInside(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === "" ||
    !(difference === ".." || difference.startsWith(`..${sep}`) || isAbsolute(difference))
  );
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function safeErrorPath(path: string): string {
  return isAbsolute(path) ? "$.plan" : path;
}

function race(path: string): never {
  throw new TemplateTransactionError("race-detected", path);
}

function fail(code: TemplateTransactionErrorCode, path: string): never {
  throw new TemplateTransactionError(code, path);
}
