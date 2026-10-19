// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

import type { ChangeEvidence, ChangedFileEvidence, PatchMetadata } from "./contracts.js";
import { limit } from "../config/limits.js";
import { createHealingPlan, validateHealingPlan, type HealingPlan } from "./contracts.js";
import { compareText } from "../shared/primitives.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
// Patch readers share the capture bound, so every patch the run can capture is readable.
const PATCH_BYTES_LIMIT = "repository.evidenceGitOutputMaxBytes";

export type PatchEvidenceBindingErrorCode =
  | "invalid-plan"
  | "invalid-task"
  | "invalid-evidence"
  | "repository-mismatch"
  | "path-mismatch"
  | "patch-mismatch";

export class PatchEvidenceBindingError extends Error {
  public constructor(
    public readonly code: PatchEvidenceBindingErrorCode,
    public readonly path: string,
  ) {
    super(`Persisted patch binding rejected ${path}: ${code}.`);
    this.name = "PatchEvidenceBindingError";
  }
}

export interface BindPersistedGitPatchEvidenceInput {
  plan: HealingPlan;
  taskIds: readonly string[];
  repositoryRevision: string;
  changes: ChangeEvidence;
}

/**
 * Verify a collector-persisted Git patch and replace every bounded task's
 * patch claim with the exact durable artifact identity. The union of selected
 * task outputs must equal the collector's changed paths. The host-only
 * artifact path is checked but never copied into the HealingPlan.
 */
export async function bindPersistedGitPatchEvidence(
  input: BindPersistedGitPatchEvidenceInput,
): Promise<HealingPlan> {
  let plan: HealingPlan;
  try {
    plan = validateHealingPlan(input.plan);
  } catch {
    fail("invalid-plan", "$.plan");
  }
  if (
    !GIT_REVISION.test(input.repositoryRevision) ||
    input.repositoryRevision !== plan.repository.revision
  ) {
    fail("repository-mismatch", "$.repositoryRevision");
  }
  if (
    !Array.isArray(input.taskIds) ||
    input.taskIds.length === 0 ||
    input.taskIds.some((id) => typeof id !== "string" || !id) ||
    new Set(input.taskIds).size !== input.taskIds.length
  ) {
    fail("invalid-task", "$.taskIds");
  }
  const boundedTasks = plan.taskGroups
    .flatMap((group) => group.tasks)
    .filter((task) => task.level === "bounded-repair");
  const requested = new Set(input.taskIds);
  if (
    !sameSet(
      input.taskIds,
      boundedTasks.map((task) => task.id),
    )
  ) {
    fail("invalid-task", "$.taskIds");
  }
  const patch = validatePatchMetadata(input.changes?.patch);
  const files = validateFiles(input.changes?.files);
  const outputPaths = [...new Set(boundedTasks.flatMap((task) => task.outputPaths))];
  if (!sameSet([...new Set(files.flatMap(changedPaths))], outputPaths)) {
    fail("path-mismatch", "$.changes.files");
  }
  await verifyPersistedPatch(patch);

  const { digest: _digest, ...digestible } = plan;
  return createHealingPlan({
    ...digestible,
    taskGroups: plan.taskGroups.map((group) => ({
      ...group,
      tasks: group.tasks.map((candidate) =>
        requested.has(candidate.id)
          ? {
              ...candidate,
              patch: { sha256: patch.sha256, byteLength: patch.byteLength },
            }
          : candidate,
      ),
    })),
  });
}

function validatePatchMetadata(value: PatchMetadata | undefined): PatchMetadata {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "artifactPath,byteLength,format,lineCount,sha256" ||
    !SHA256.test(value.sha256) ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength <= 0 ||
    value.byteLength > limit(PATCH_BYTES_LIMIT).value ||
    !Number.isSafeInteger(value.lineCount) ||
    value.lineCount < 0 ||
    typeof value.artifactPath !== "string" ||
    !value.artifactPath ||
    value.format !== "git-diff"
  ) {
    fail("invalid-evidence", "$.changes.patch");
  }
  return value;
}

function validateFiles(value: ChangedFileEvidence[] | undefined): ChangedFileEvidence[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("invalid-evidence", "$.changes.files");
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const path = `$.changes.files[${index}]`;
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).some((key) => !["path", "status", "previousPath"].includes(key)) ||
      !safePath(entry.path) ||
      !["added", "modified", "deleted", "renamed", "copied"].includes(entry.status) ||
      (entry.previousPath !== undefined && !safePath(entry.previousPath))
    ) {
      fail("invalid-evidence", path);
    }
    const key = `${entry.previousPath ?? ""}\0${entry.path}`;
    if (seen.has(key)) fail("invalid-evidence", path);
    seen.add(key);
    return { ...entry };
  });
}

function changedPaths(file: ChangedFileEvidence): string[] {
  return [...(file.previousPath ? [file.previousPath] : []), file.path];
}

async function verifyPersistedPatch(patch: PatchMetadata): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    handle = await open(patch.artifactPath, fsConstants.O_RDONLY | noFollow);
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size !== patch.byteLength ||
      before.size > limit(PATCH_BYTES_LIMIT).value
    ) {
      fail("patch-mismatch", "$.changes.patch.artifactPath");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(patch.artifactPath);
    if (
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      bytes.byteLength !== after.size ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino ||
      createHash("sha256").update(bytes).digest("hex") !== patch.sha256
    ) {
      fail("patch-mismatch", "$.changes.patch.artifactPath");
    }
  } catch (error) {
    if (error instanceof PatchEvidenceBindingError) throw error;
    fail("patch-mismatch", "$.changes.patch.artifactPath");
  } finally {
    await handle?.close();
  }
}

function safePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Boolean(value) &&
    value === value.normalize("NFC") &&
    !value.startsWith("/") &&
    !value.startsWith("~") &&
    !/^[A-Za-z]:\//u.test(value) &&
    !value.includes("\\") &&
    value.split("/").every((segment) => Boolean(segment) && segment !== "." && segment !== "..")
  );
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = [...right].sort(compareText);
  return [...left].sort(compareText).every((value, index) => value === expected[index]);
}

function fail(code: PatchEvidenceBindingErrorCode, path: string): never {
  throw new PatchEvidenceBindingError(code, path);
}
