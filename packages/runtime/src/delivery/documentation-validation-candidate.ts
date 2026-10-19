// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The candidate a source-aware (v2) documentation-validation binding names,
 * shared by the plan and delivery sides (#2359).
 *
 * The plan derives the documentation-source applicability over this candidate,
 * and delivery re-derives it over the delivery worktree and requires the same
 * digest. Both sides therefore compute the candidate-input and
 * repository-identity digests here, and the plan reads the same tree delivery
 * validates: the run base plus the verified patch.
 */
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { limit, refuseLimit } from "../config/limits.js";
import {
  ExecFileDeliveryCommandRunner,
  SAFE_GIT_CONFIG,
  type DeliveryCommandResult,
  type DeliveryCommandRunner,
} from "./worktree/types.js";
import { documentationValidationKit } from "./validation-profile.js";

/** Bounds the Git commands that read, check, and check out the private candidate. */
export const VALIDATION_CANDIDATE_CHECKOUT_TIMEOUT_LIMIT =
  "delivery.validationCandidateCheckoutTimeoutMs";

/** Digest of the base revision and verified patch that delivery validates. */
export function documentationCandidateInputTreeSha256(input: {
  readonly baseRevision: string;
  readonly patchSha256: string;
}): string {
  return documentationValidationKit.canonicalDigest({
    baseRevision: input.baseRevision,
    patchSha256: input.patchSha256,
  });
}

/** Digest of the GitLab project identity the binding is bound to. */
export function documentationRepositoryIdentitySha256(input: {
  readonly host: string;
  readonly path: string;
  readonly projectId: number;
}): string {
  return documentationValidationKit.canonicalDigest({
    host: input.host,
    path: input.path,
    projectId: input.projectId,
  });
}

/**
 * The private candidate could not be built for a reason other than a patch
 * conflict: Git or the filesystem failed. Preflight refuses with
 * `validation-candidate-unavailable` instead of binding another tree.
 */
export class DocumentationValidationCandidateError extends Error {
  public constructor() {
    super("The run base and its verified patch could not be combined into a validation candidate.");
    this.name = "DocumentationValidationCandidateError";
  }
}

/**
 * `git apply --check` refused the verified patch against the run base with exit
 * status 1, the check delivery runs before it refuses with `patch-conflict`.
 */
export class DocumentationValidationPatchConflictError extends Error {
  public constructor() {
    super("The verified patch does not apply to the run base.");
    this.name = "DocumentationValidationPatchConflictError";
  }
}

export interface DocumentationValidationCandidateInput {
  /** The run's Git checkout. It is only read. */
  readonly repositoryPath: string;
  readonly baseRevision: string;
  readonly patchBytes: Buffer;
  /** Owner-private DocsFab directory that holds the temporary copy. */
  readonly parentDirectory: string;
}

/**
 * Attributes that would make checked-out bytes differ from the blobs delivery
 * writes. A private `info/attributes` outranks the tree's `.gitattributes`.
 */
const RAW_BLOB_ATTRIBUTES = "* -text -eol -crlf -filter -ident -working-tree-encoding\n";

/** Prefix of each private copy in the parent directory. */
const CANDIDATE_PREFIX = "candidate-";
/** `git apply --check`'s exit status for a patch that does not apply. */
const PATCH_DOES_NOT_APPLY = 1;

/**
 * Run `action` over a private copy of the run base plus the verified patch, then
 * remove the copy on every path. The copy is built the way delivery builds its
 * candidate: the base tree is read into a private index, the patch is checked
 * and applied with `git apply --cached --binary`, and the index is checked out
 * into the copy. A private Git directory borrows the run repository's objects
 * through its `objects/info/alternates` file, so nothing is written to that
 * repository: no worktree, index, ref, or object.
 *
 * Throws {@link DocumentationValidationPatchConflictError} only when `git apply
 * --check` exits 1 in time, {@link DocumentationValidationCandidateError} when
 * Git or the filesystem fails otherwise, and the limit's refusal when a Git
 * command outlives `delivery.validationCandidateCheckoutTimeoutMs`. A copy an
 * interrupted preflight leaves behind stays in place; nothing here removes a
 * copy it did not create.
 */
export async function withDocumentationValidationCandidate<T>(
  input: DocumentationValidationCandidateInput,
  action: (candidateRoot: string) => Promise<T>,
  commands: DeliveryCommandRunner = new ExecFileDeliveryCommandRunner(),
): Promise<T> {
  let root: string;
  try {
    await requireOwnedParentDirectory(input.parentDirectory);
    root = await mkdtemp(join(input.parentDirectory, CANDIDATE_PREFIX));
  } catch {
    throw new DocumentationValidationCandidateError();
  }
  try {
    const candidateRoot = await buildCandidate(input, root, commands);
    return await action(candidateRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Create the copies' directory, or accept it only when it is a real directory
 * this user owns. A symbolic link or anything else there is refused, never
 * followed.
 */
async function requireOwnedParentDirectory(path: string): Promise<void> {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing === undefined) await mkdir(path, { recursive: true, mode: 0o700 });
  const details = existing ?? (await lstat(path));
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!details.isDirectory() || (uid !== undefined && details.uid !== uid)) {
    throw new DocumentationValidationCandidateError();
  }
}

async function buildCandidate(
  input: DocumentationValidationCandidateInput,
  root: string,
  commands: DeliveryCommandRunner,
): Promise<string> {
  const source = await requireOutput(
    commands.run(
      "git",
      [...SAFE_GIT_CONFIG, "rev-parse", "--git-common-dir"],
      input.repositoryPath,
      {
        env: candidateGitEnvironment(),
      },
    ),
  );
  const commonDirectory = source.toString("utf8").trim();
  if (!commonDirectory) throw new DocumentationValidationCandidateError();
  const objects = resolve(
    isAbsolute(commonDirectory) ? commonDirectory : join(input.repositoryPath, commonDirectory),
    "objects",
  );
  // The alternates file holds one path per line; a line break would split this one.
  if (/[\r\n]/u.test(objects)) throw new DocumentationValidationCandidateError();
  const format = await commands.run(
    "git",
    [...SAFE_GIT_CONFIG, "rev-parse", "--show-object-format"],
    input.repositoryPath,
    { env: candidateGitEnvironment() },
  );
  const sha256Objects = format.exitCode === 0 && format.stdout.toString("utf8").trim() === "sha256";

  const gitDirectory = join(root, "git");
  const candidateRoot = join(root, "repository");
  await mkdir(candidateRoot, { mode: 0o700 }).catch(() => {
    throw new DocumentationValidationCandidateError();
  });
  await requireOutput(
    commands.run(
      "git",
      [
        "init",
        "--quiet",
        "--bare",
        "--template=",
        ...(sha256Objects ? ["--object-format=sha256"] : []),
        gitDirectory,
      ],
      root,
      { env: candidateGitEnvironment() },
    ),
  );
  try {
    await mkdir(join(gitDirectory, "info"), { recursive: true, mode: 0o700 });
    await writeFile(join(gitDirectory, "info", "attributes"), RAW_BLOB_ATTRIBUTES, {
      mode: 0o600,
    });
    // A file, not GIT_ALTERNATE_OBJECT_DIRECTORIES: Git splits that variable on
    // the path separator, so a ':' in the repository path would break it.
    await mkdir(join(gitDirectory, "objects", "info"), { recursive: true, mode: 0o700 });
    await writeFile(join(gitDirectory, "objects", "info", "alternates"), `${objects}\n`, {
      mode: 0o600,
    });
  } catch {
    throw new DocumentationValidationCandidateError();
  }

  const env = {
    ...candidateGitEnvironment(),
    GIT_DIR: gitDirectory,
    GIT_INDEX_FILE: join(gitDirectory, "index"),
  };
  const treeTimeout = limit(VALIDATION_CANDIDATE_CHECKOUT_TIMEOUT_LIMIT);
  await requireTreeCommand(
    commands,
    [...SAFE_GIT_CONFIG, "read-tree", input.baseRevision],
    root,
    env,
    treeTimeout,
  );
  if (input.patchBytes.byteLength > 0) {
    const started = performance.now();
    const checked = await commands
      .run("git", [...SAFE_GIT_CONFIG, "apply", "--check", "--cached", "--binary", "-"], root, {
        env,
        stdin: input.patchBytes,
        timeoutMs: treeTimeout.value,
      })
      .catch(() => undefined);
    const elapsed = Math.ceil(performance.now() - started);
    if (checked !== undefined && checked.exitCode !== 0 && elapsed >= treeTimeout.value) {
      refuseLimit(treeTimeout, elapsed);
    }
    // Only exit status 1 is a patch that does not apply; delivery runs this
    // check and refuses with patch-conflict. Exit 128, another status, or no
    // result is a failure to build the copy.
    if (checked?.exitCode === PATCH_DOES_NOT_APPLY) {
      throw new DocumentationValidationPatchConflictError();
    }
    if (checked === undefined || checked.exitCode !== 0) {
      throw new DocumentationValidationCandidateError();
    }
    await requireOutput(
      commands.run("git", [...SAFE_GIT_CONFIG, "apply", "--cached", "--binary", "-"], root, {
        env,
        stdin: input.patchBytes,
      }),
    );
  }
  await requireTreeCommand(
    commands,
    [...SAFE_GIT_CONFIG, "checkout-index", "--all", "--force"],
    root,
    { ...env, GIT_WORK_TREE: candidateRoot },
    treeTimeout,
  );
  return candidateRoot;
}

/**
 * A Git command over the whole candidate tree, bounded by the catalog limit
 * instead of the runner's default. Outliving the bound refuses with the limit's
 * code and the observed time; any other failure is a candidate error.
 */
async function requireTreeCommand(
  commands: DeliveryCommandRunner,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout: ReturnType<typeof limit>,
): Promise<void> {
  const started = performance.now();
  const result = await commands
    .run("git", args, cwd, { env, timeoutMs: timeout.value })
    .catch(() => undefined);
  if (result !== undefined && result.exitCode === 0) return;
  const elapsed = Math.ceil(performance.now() - started);
  if (elapsed >= timeout.value) refuseLimit(timeout, elapsed);
  throw new DocumentationValidationCandidateError();
}

async function requireOutput(pending: Promise<DeliveryCommandResult>): Promise<Buffer> {
  const result = await pending.catch(() => undefined);
  if (result === undefined || result.exitCode !== 0)
    throw new DocumentationValidationCandidateError();
  return result.stdout;
}

/**
 * Git with no user or system configuration, no credential prompts, and no
 * replace refs, as delivery runs it.
 */
function candidateGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: "/dev/null",
    XDG_CONFIG_HOME: "/dev/null",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    GIT_PAGER: "cat",
  };
}
