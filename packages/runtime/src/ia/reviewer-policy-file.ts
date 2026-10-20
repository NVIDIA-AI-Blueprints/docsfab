// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

import { validateIaPlanReviewerPolicy, type IaPlanReviewerPolicy } from "./plan-review.js";

const MAX_POLICY_BYTES = 1024 * 1024;

export class IaPlanReviewerPolicyFileError extends Error {
  public constructor(
    public readonly code:
      | "invalid-file"
      | "symlink"
      | "insecure-permissions"
      | "owner-mismatch"
      | "policy-too-large"
      | "file-changed"
      | "invalid-json"
      | "invalid-policy",
    public readonly path: string,
  ) {
    super(`IA reviewer policy file rejected (${code}) at ${path}.`);
    this.name = "IaPlanReviewerPolicyFileError";
  }
}

/** Load one stable, owner-only public reviewer policy without following links. */
export async function loadIaPlanReviewerPolicyFile(path: string): Promise<IaPlanReviewerPolicy> {
  let handle: FileHandle | undefined;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const before = await handle.stat();
    assertPolicyFile(before, path);
    if (before.size <= 0 || before.size > MAX_POLICY_BYTES) {
      throw new IaPlanReviewerPolicyFileError("policy-too-large", path);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    assertPolicyFile(after, path);
    if (
      bytes.byteLength !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino
    ) {
      throw new IaPlanReviewerPolicyFileError("file-changed", path);
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new IaPlanReviewerPolicyFileError("invalid-json", path);
    }
    try {
      return validateIaPlanReviewerPolicy(value);
    } catch {
      throw new IaPlanReviewerPolicyFileError("invalid-policy", path);
    }
  } catch (error) {
    if (error instanceof IaPlanReviewerPolicyFileError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw new IaPlanReviewerPolicyFileError("symlink", path);
    }
    throw new IaPlanReviewerPolicyFileError("invalid-file", path);
  } finally {
    await handle?.close();
  }
}

function assertPolicyFile(stat: Stats, path: string): void {
  if (!stat.isFile()) throw new IaPlanReviewerPolicyFileError("invalid-file", path);
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new IaPlanReviewerPolicyFileError("owner-mismatch", path);
  }
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
    throw new IaPlanReviewerPolicyFileError("insecure-permissions", path);
  }
}
