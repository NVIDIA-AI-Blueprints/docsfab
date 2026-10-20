// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Committed-HEAD workspace basis for one delegated task. Child workflows run
 * in a disposable tracked export at committed HEAD; checkout dirt is compared
 * for dispatch admission only. This module never commits, stashes, resets,
 * checks out, or snapshots uncommitted edits into a child.
 */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DELEGATED_WORKSPACE_STRATEGY = "tracked-export" as const;
export const DELEGATED_CHILD_WORKSPACE_ORIGIN = "committed-head" as const;

export const WORKSPACE_MUTATION_COMMANDS = [
  "commit",
  "stash",
  "reset",
  "checkout",
  "snapshot",
] as const;
export type WorkspaceMutationCommand = (typeof WORKSPACE_MUTATION_COMMANDS)[number];

export const WORKSPACE_DIRTY_KINDS = ["staged", "unstaged", "untracked"] as const;
export type WorkspaceDirtyKind = (typeof WORKSPACE_DIRTY_KINDS)[number];

const GIT_BINARY = process.platform === "win32" ? "git" : "/usr/bin/git";
const SAFE_GIT_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.excludesFile=/dev/null",
  "-c",
  "diff.external=",
  "-c",
  "pager.status=false",
] as const;

const GIT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: process.platform === "win32" ? "NUL" : "/dev/null",
  XDG_CONFIG_HOME: process.platform === "win32" ? "NUL" : "/dev/null",
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: process.platform === "win32" ? "" : "/usr/bin/false",
  GIT_PAGER: "cat",
  GIT_ALLOW_PROTOCOL: "file",
};

export interface WorkspaceDirtyPath {
  readonly path: string;
  readonly kind: WorkspaceDirtyKind;
  readonly fromPath?: string;
}

export interface DelegatedWorkspaceBasis {
  readonly canonicalRepositoryPath: string;
  readonly committedHeadRevision: string;
  readonly dirtyPaths: readonly WorkspaceDirtyPath[];
  readonly workspace: {
    readonly strategy: typeof DELEGATED_WORKSPACE_STRATEGY;
    readonly disposable: true;
    readonly origin: typeof DELEGATED_CHILD_WORKSPACE_ORIGIN;
    readonly revision: string;
  };
}

export interface CommittedHeadFileIdentity {
  readonly path: string;
  readonly origin: typeof DELEGATED_CHILD_WORKSPACE_ORIGIN;
  readonly revision: string;
  readonly objectId: string;
  readonly bytes: Buffer;
}

export interface SavedPatchPreimageCheck {
  readonly status: "matched" | "rejected";
  readonly basis: typeof DELEGATED_CHILD_WORKSPACE_ORIGIN;
  readonly mismatchedPaths: readonly string[];
}

export class DelegatedWorkspaceBasisError extends Error {
  public constructor(
    message: string,
    public readonly code:
      | "inspect-failed"
      | "path-denied"
      | "mutation-denied"
      | "preimage-mismatch",
  ) {
    super(message);
    this.name = "DelegatedWorkspaceBasisError";
  }
}

export function isWorkspaceMutationCommand(command: string): boolean {
  return (WORKSPACE_MUTATION_COMMANDS as readonly string[]).includes(command);
}

export function refuseWorkspaceMutation(command: string): never {
  throw new DelegatedWorkspaceBasisError(
    `Delegated workflow basis refuses the ${command} workspace mutation; commit, stash, reset, checkout, and implicit snapshots are not used to bridge direct and child work.`,
    "mutation-denied",
  );
}

/** Inspect committed HEAD and current-checkout dirt without mutating the repository. */
export async function inspectDelegatedWorkspaceBasis(
  repositoryPath: string,
): Promise<DelegatedWorkspaceBasis> {
  const canonicalRepositoryPath = await canonicalRepository(repositoryPath);
  const committedHeadRevision = (
    await runGit(canonicalRepositoryPath, ["rev-parse", "HEAD"])
  ).trim();
  if (!/^[a-f0-9]{40,64}$/iu.test(committedHeadRevision)) {
    throw new DelegatedWorkspaceBasisError(
      "Delegated workspace basis could not read a complete committed HEAD revision identifier.",
      "inspect-failed",
    );
  }
  const porcelain = await runGit(canonicalRepositoryPath, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  return {
    canonicalRepositoryPath,
    committedHeadRevision,
    dirtyPaths: Object.freeze(parsePorcelainV1Z(porcelain)),
    workspace: {
      strategy: DELEGATED_WORKSPACE_STRATEGY,
      disposable: true,
      origin: DELEGATED_CHILD_WORKSPACE_ORIGIN,
      revision: committedHeadRevision,
    },
  };
}

export function relevantDirtyPaths(
  basis: DelegatedWorkspaceBasis,
  declaredSourceTargetPaths: readonly string[],
): readonly WorkspaceDirtyPath[] {
  const declared = declaredSourceTargetPaths.map(normalizeRepoPath);
  return basis.dirtyPaths.filter((entry) => {
    const paths = [entry.path, ...(entry.fromPath ? [entry.fromPath] : [])];
    return paths.some((path) => declared.some((item) => pathsOverlap(path, item)));
  });
}

/** Child workflows read committed HEAD bytes, never the current uncommitted checkout. */
export async function readCommittedHeadFile(
  repositoryPath: string,
  path: string,
): Promise<CommittedHeadFileIdentity> {
  const basis = await inspectDelegatedWorkspaceBasis(repositoryPath);
  const relative = normalizeRepoPath(path);
  const objectId = (
    await runGit(basis.canonicalRepositoryPath, ["rev-parse", `HEAD:${relative}`])
  ).trim();
  const bytes = await runGitBuffer(basis.canonicalRepositoryPath, ["show", `HEAD:${relative}`]);
  return {
    path: relative,
    origin: DELEGATED_CHILD_WORKSPACE_ORIGIN,
    revision: basis.committedHeadRevision,
    objectId,
    bytes,
  };
}

/**
 * Saved-patch application keeps exact HEAD preimage checks. A preimage taken from
 * the dirty checkout cannot attest the child's committed-HEAD disposable workspace.
 */
export async function verifySavedPatchPreimage(input: {
  readonly repositoryPath: string;
  readonly changedFiles: readonly { readonly path: string; readonly preimageObjectId: string }[];
}): Promise<SavedPatchPreimageCheck> {
  const mismatchedPaths: string[] = [];
  for (const file of input.changedFiles) {
    const head = await readCommittedHeadFile(input.repositoryPath, file.path);
    if (head.objectId !== file.preimageObjectId) mismatchedPaths.push(file.path);
  }
  return {
    status: mismatchedPaths.length === 0 ? "matched" : "rejected",
    basis: DELEGATED_CHILD_WORKSPACE_ORIGIN,
    mismatchedPaths: Object.freeze(mismatchedPaths),
  };
}

export async function hashWorkingTreeBlob(repositoryPath: string, path: string): Promise<string> {
  const canonical = await canonicalRepository(repositoryPath);
  return (await runGit(canonical, ["hash-object", "--", normalizeRepoPath(path)])).trim();
}

export function parsePorcelainV1Z(text: string): WorkspaceDirtyPath[] {
  const parts = text.split("\0");
  if (parts.at(-1) === "") parts.pop();
  const dirty: WorkspaceDirtyPath[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index]!;
    if (record.length < 4) {
      throw new DelegatedWorkspaceBasisError(
        "Delegated workspace basis received a truncated Git porcelain status record.",
        "inspect-failed",
      );
    }
    const x = record[0]!;
    const y = record[1]!;
    const path = normalizeRepoPath(record.slice(3));
    const copiedOrRenamed = x === "R" || x === "C" || y === "R" || y === "C";
    let fromPath: string | undefined;
    if (copiedOrRenamed) {
      index += 1;
      const origin = parts[index];
      if (!origin) {
        throw new DelegatedWorkspaceBasisError(
          "Delegated workspace basis received a rename porcelain record without an origin path.",
          "inspect-failed",
        );
      }
      fromPath = normalizeRepoPath(origin);
    }
    dirty.push({
      path,
      kind: kindForStatus(x, y),
      ...(fromPath ? { fromPath } : {}),
    });
  }
  return dirty;
}

function kindForStatus(x: string, y: string): WorkspaceDirtyKind {
  if (x === "?" && y === "?") return "untracked";
  if (x !== " " && x !== "?") return "staged";
  return "unstaged";
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function normalizeRepoPath(path: string): string {
  const trimmed = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    !trimmed ||
    isAbsolute(trimmed) ||
    trimmed.includes("\0") ||
    trimmed.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new DelegatedWorkspaceBasisError(
      "Delegated workspace basis requires a repository-relative path without parent or absolute segments.",
      "path-denied",
    );
  }
  return trimmed;
}

async function canonicalRepository(repositoryPath: string): Promise<string> {
  if (
    typeof repositoryPath !== "string" ||
    repositoryPath.trim() === "" ||
    !isAbsolute(repositoryPath)
  ) {
    throw new DelegatedWorkspaceBasisError(
      "Delegated workspace basis requires an existing absolute local repository directory.",
      "path-denied",
    );
  }
  if (repositoryPath.split(/[\\/]/u).includes("..")) {
    throw new DelegatedWorkspaceBasisError(
      "Delegated workspace basis requires an existing absolute local repository directory.",
      "path-denied",
    );
  }
  try {
    return await realpath(resolve(repositoryPath));
  } catch {
    throw new DelegatedWorkspaceBasisError(
      "Delegated workspace basis requires an existing absolute local repository directory.",
      "path-denied",
    );
  }
}

async function runGit(repositoryPath: string, args: readonly string[]): Promise<string> {
  return (await runGitBuffer(repositoryPath, args)).toString("utf8");
}

async function runGitBuffer(repositoryPath: string, args: readonly string[]): Promise<Buffer> {
  try {
    const result = await execFileAsync(
      GIT_BINARY,
      [...SAFE_GIT_CONFIG, "-C", repositoryPath, ...args],
      {
        encoding: "buffer",
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        env: GIT_ENV,
      },
    );
    return Buffer.from(result.stdout);
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? Buffer.from(error.stderr as Uint8Array).toString("utf8")
        : "";
    throw new DelegatedWorkspaceBasisError(
      `Delegated workspace basis could not inspect Git metadata for the selected repository. ${stderr}`.trim(),
      "inspect-failed",
    );
  }
}
