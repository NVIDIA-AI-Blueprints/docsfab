// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describeDocsFabConfigurationSource } from "../config/host-paths.js";
import { gitEnvironment } from "../init/shared.js";
import { SAFE_GIT_CONFIG } from "../init/types.js";
import { DocumentationScope } from "./documentation-scope.js";
import { wslInteropMounts } from "./wsl-interop.js";
import { untrustedChildEnvironment } from "../security/child-process-environment.js";

const exec = promisify(execFile);
export const DOCUMENTATION_SANDBOX_FAILURE =
  "Documentation-only command isolation is unavailable. No command ran. Direct documentation edits remain available; Linux commands require working bubblewrap user namespaces.";

export const CONFIGURATION_CREDENTIALS_FAILURE =
  "DocsFab refused the command (live-command-configuration-unreadable): it could not resolve or list its configuration root, so it could not hide its own credential files from the command. No command ran. Next action: run ls -lLa on the Configuration path that docsfab live-agent printed at startup, fix the permission or link it reports, then retry.";

/**
 * DocsFab's own credential files in its configuration root: `secrets.env`, the
 * legacy `.env`, the `.env.legacy` copy that migration keeps, and the temporary
 * and backup copies setup makes of them. Matched on folded names, because a
 * case-insensitive file system opens these files under any spelling.
 */
const CONFIGURATION_CREDENTIAL = /^(?:\.env|(?:secrets\.env|\.env\.legacy)(?:\..*)?)$/su;

/**
 * Files in a linked worktree's admin directory that change what host-side Git
 * reads: `commondir` names the shared repository (without it, Git treats the
 * admin directory itself as one), `gitdir` names the checkout, and
 * `config.worktree` holds configuration when `extensions.worktreeConfig` is on.
 */
const WORKTREE_POINTERS = ["commondir", "gitdir", "config.worktree"] as const;
type WorktreePointer = (typeof WORKTREE_POINTERS)[number];

/**
 * What DocsFab holds in place of a missing `config.worktree` on Linux while a
 * command runs. A comment sets no configuration, and the fixed bytes let a later
 * command, or another session on the same worktree, recognize and remove it.
 */
export const WORKTREE_CONFIG_PLACEHOLDER =
  "# DocsFab placeholder: sets no configuration. DocsFab removes it after an approved command.\n";

export const WORKTREE_GIT_STATE_FAILURES = {
  commondir:
    "The approved command changed commondir in this worktree's Git admin directory, which tells host Git where the shared repository is. DocsFab restored its previous state and refused the result. Inspect repository state before retrying.",
  gitdir:
    "The approved command changed gitdir in this worktree's Git admin directory, which tells host Git where this worktree is. DocsFab restored its previous state and refused the result. Inspect repository state before retrying.",
  "config.worktree":
    "The approved command changed config.worktree in this worktree's Git admin directory, which holds configuration that host Git reads. DocsFab restored its previous state and refused the result. Inspect repository state before retrying.",
  irregular:
    "A commondir, gitdir, or config.worktree entry in this worktree's Git admin directory is not a single regular file, or its modules entry is not a directory, so DocsFab cannot protect it during a command. No command ran. Replace it outside live-agent, then retry.",
  nestedRepository:
    "The approved command created Git repository metadata that host Git would use: a .git entry or a bare repository layout under a documentation path, or submodule Git directories in this worktree's Git admin directory. DocsFab removed the entries that made it a repository and refused the result. Inspect repository state before retrying.",
  gitlink:
    "The approved command staged an embedded repository (a gitlink) in this worktree's Git index, which makes host Git run inside that directory. DocsFab removed the new index entries and refused the result. Inspect repository state before retrying.",
  gitmodules:
    "The approved command changed the staged .gitmodules entry in this worktree's Git index, which host Git reads for submodule settings. DocsFab restored the previous entry and refused the result. Inspect repository state before retrying.",
  documentationUnrepairable:
    "DocsFab could not read or clean a documentation directory while checking it for Git repository metadata, so it refused the command. Metadata the command created may remain under a documentation path. Outside live-agent, remove any .git entry you did not create before running Git there.",
  indexUnreadable:
    "DocsFab could not read this worktree's Git index to check it for embedded repositories. No command ran. Repair the index with Git outside live-agent, then retry.",
  indexUnrestorable:
    "DocsFab could not check or repair this worktree's Git index after the approved command, so it refused the result. Repository metadata the command created under documentation paths was removed. Inspect repository state before retrying.",
} as const satisfies Record<WorktreePointer | EmbeddedRepositoryFailure | "irregular", string>;
type EmbeddedRepositoryFailure =
  | "nestedRepository"
  | "gitlink"
  | "gitmodules"
  | "documentationUnrepairable"
  | "indexUnreadable"
  | "indexUnrestorable";

export class WorktreeGitStateError extends Error {
  constructor(
    message: (typeof WORKTREE_GIT_STATE_FAILURES)[keyof typeof WORKTREE_GIT_STATE_FAILURES],
  ) {
    super(message);
    this.name = "WorktreeGitStateError";
  }
}

export async function documentationCommandSandbox(
  repository: string,
  scope: DocumentationScope,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: {
    runExec?: (
      file: string,
      args: readonly string[],
      options: { cwd: string; timeout: number; env: NodeJS.ProcessEnv },
    ) => Promise<{ stdout: string }>;
  } = {},
) {
  const executable =
    process.platform === "darwin"
      ? "/usr/bin/sandbox-exec"
      : process.platform === "linux"
        ? "/usr/bin/bwrap"
        : undefined;
  if (!executable) throw new Error(DOCUMENTATION_SANDBOX_FAILURE);
  await access(executable).catch(() => {
    throw new Error(DOCUMENTATION_SANDBOX_FAILURE);
  });
  // Resolve the host bridge before changing Git pointers or creating cleanup obligations.
  const interopMasks = process.platform === "linux" ? await wslInteropMounts() : [];
  const runExec =
    dependencies.runExec ??
    ((
      file: string,
      args: readonly string[],
      options: { cwd: string; timeout: number; env: NodeJS.ProcessEnv },
    ) => exec(file, [...args], options));
  const hidden = await configurationCredentialFiles(environment);
  const writable = await scope.writablePaths(repository);
  // Git needs its metadata, not general permission to rewrite checkout files.
  let grant: GitMetadataGrant = { paths: [] };
  try {
    const git = await runExec(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
        "--git-common-dir",
      ],
      { cwd: repository, timeout: 5000, env: untrustedChildEnvironment(environment) },
    );
    const [gitDir = "", commonDir = ""] = git.stdout.trim().split("\n");
    const metadata = await realpath(commonDir);
    if (basename(metadata) === ".git" && metadata !== repository)
      grant = await gitMetadataGrant(await realpath(gitDir), metadata);
  } catch {
    /* Non-Git documentation directories remain usable. */
  }
  const pointers = grant.admin ? await recordWorktreePointers(grant.admin) : [];
  const embedded = grant.admin
    ? await recordEmbeddedRepositories(repository, grant.admin, [...writable]).catch(
        async (error: unknown) => {
          await restoreWorktreePointers(pointers);
          throw error;
        },
      )
    : undefined;
  // Every check runs, pointers first so the index check's Git reads the restored ones;
  // the first failure is the one reported.
  const restoreGitState = async () => {
    const failures: unknown[] = [];
    await restoreWorktreePointers(pointers).catch((error: unknown) => failures.push(error));
    if (embedded)
      await restoreEmbeddedRepositories(embedded).catch((error: unknown) => failures.push(error));
    if (failures.length) throw failures[0];
  };
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "docsfab-doc-command-"))).catch(
    async (error: unknown) => {
      await restoreGitState();
      throw error;
    },
  );
  const masks: { args: string[]; directory?: string } =
    process.platform === "darwin"
      ? { args: [] }
      : await credentialMounts(hidden).catch(async (error: unknown) => {
          await rm(scratch, { recursive: true, force: true });
          await restoreGitState();
          throw error;
        });
  const temporary = masks.directory ? [scratch, masks.directory] : [scratch];
  const cleanup = () =>
    Promise.all(temporary.map((path) => rm(path, { recursive: true, force: true })));
  writable.push(scratch);
  // The admin directory stays writable for HEAD, index, and lock files. Its pointer files and
  // submodule Git directories do not, and neither do existing repositories under documentation.
  const readOnly = [
    ...pointers
      .filter((pointer) => pointer.file || pointer.placeholder)
      .map((pointer) => pointer.path),
    ...(embedded?.readOnly ?? []),
  ];
  // A command's leftover background process must not touch a restore in progress either.
  const denied = pointers.flatMap((pointer) => [pointer.path, restoreStaging(pointer.path)]);
  const deniedTrees = embedded ? [embedded.modules, ...embedded.protectedTrees] : [];
  // Under a documentation path: any path component spelled `.git`, and any entry named
  // `HEAD`, which a bare repository layout needs; in any case for both.
  const deniedPatterns = (embedded?.documentation ?? []).flatMap((path) => [
    `^${escapeRegExp(path)}(/.*)?/\\.[Gg][Ii][Tt](/.*)?$`,
    `^${escapeRegExp(path)}(/.*)?/[Hh][Ee][Aa][Dd]$`,
  ]);
  const deny = [
    ...denied.map((path) => `(literal ${JSON.stringify(path)})`),
    ...deniedTrees.map((path) => `(subpath ${JSON.stringify(path)})`),
    ...deniedPatterns.map((pattern) => `(regex ${JSON.stringify(pattern)})`),
  ];
  // The profile matches resolved paths, which `hidden` holds; it comes last, so no allow overrides it.
  const hide = hidden.map((path) => `(literal ${JSON.stringify(path)})`);
  const args =
    process.platform === "darwin"
      ? [
          "-p",
          `(version 1)(allow default)(deny file-write*)(allow file-write* (literal "/dev/null") ${[...writable, ...grant.paths].map((path) => `(subpath ${JSON.stringify(path)})`).join(" ")})${deny.length ? `(deny file-write* ${deny.join(" ")})` : ""}${hide.length ? `(deny file-read* file-write* ${hide.join(" ")})` : ""}`,
        ]
      : [
          "--die-with-parent",
          // A fresh /proc for this PID namespace shows no host process, so neither DocsFab's
          // environment nor its command line.
          "--unshare-pid",
          "--ro-bind",
          "/",
          "/",
          "--dev",
          "/dev",
          "--proc",
          "/proc",
          ...writable.flatMap((path) => ["--bind", path, path]),
          // A granted Git path existed when granted; if it is gone by now, bwrap skips it.
          ...grant.paths.flatMap((path) => ["--bind-try", path, path]),
          // A read-only mount point cannot be written, replaced, or removed.
          ...readOnly.flatMap((path) => ["--ro-bind-try", path, path]),
          // Last, so no later mount uncovers a credential file.
          ...masks.args,
          ...interopMasks,
          "--chdir",
          resolve(repository),
          "--",
        ];
  try {
    await runExec(executable, [...args, "/bin/bash", "--noprofile", "--norc", "-c", "true"], {
      cwd: repository,
      timeout: 5000,
      env: untrustedChildEnvironment(environment),
    });
  } catch {
    await cleanup();
    await restoreGitState();
    throw new Error(DOCUMENTATION_SANDBOX_FAILURE);
  }
  return { executable, args, scratch, cleanup, restoreGitState };
}

/**
 * Resolved paths of DocsFab's own credential files, which approved commands
 * cannot read: the matching entries of the configuration root, resolved as
 * `loadConfig` resolves it, and the secrets file in effect when it lies
 * elsewhere. A missing root, entry, or link target holds nothing to read, and a
 * directory is not a credential file. Any other failure refuses, so no command
 * runs beside a credential file DocsFab could not resolve.
 */
async function configurationCredentialFiles(environment: NodeJS.ProcessEnv): Promise<string[]> {
  try {
    const source = describeDocsFabConfigurationSource(
      environment === process.env ? process.env : { ...process.env, ...environment },
    );
    const root = await realpath(source.configurationRoot).catch(absent);
    const candidates = root
      ? (await readdir(root))
          .filter((name) => CONFIGURATION_CREDENTIAL.test(folded(name)))
          .map((name) => join(root, name))
      : [];
    if (source.secretsFile) candidates.push(source.secretsFile);
    const hidden = new Set<string>();
    for (const candidate of candidates) {
      const path = await realpath(candidate).catch(absent);
      const entry = path && (await stat(path).catch(absent));
      if (path && entry && !entry.isDirectory()) hidden.add(path);
    }
    return [...hidden];
  } catch {
    throw new Error(CONFIGURATION_CREDENTIALS_FAILURE);
  }
}

/** Handles only: nothing exists at the path, or one of its components is not a directory. */
function absent(error: NodeJS.ErrnoException): undefined {
  if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
  throw error;
}

/**
 * bwrap arguments that mount one empty file nobody can read over each
 * credential file, and the directory that holds it. The directory is outside
 * the writable scratch, so a command cannot change the file's mode.
 */
async function credentialMounts(
  hidden: readonly string[],
): Promise<{ args: string[]; directory?: string }> {
  if (!hidden.length) return { args: [] };
  const directory = await mkdtemp(join(tmpdir(), "docsfab-doc-command-mask-"));
  const mask = join(directory, "hidden");
  await writeFile(mask, "", { mode: 0 }).catch(async (error: unknown) => {
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
  return { args: hidden.flatMap((path) => ["--ro-bind", mask, path]), directory };
}

interface GitMetadataGrant {
  readonly paths: readonly string[];
  /** A linked worktree's own admin directory, when granted. */
  readonly admin?: string;
}

/**
 * Git metadata an approved command may write, given the realpaths of this
 * checkout's `--git-dir` and the shared `--git-common-dir`.
 *
 * - Main checkout (`gitDir === metadata`): the whole metadata directory.
 * - Linked worktree: only what linked worktrees share - objects, refs, and ref
 *   reflogs - plus this worktree's own admin directory, except its pointer
 *   files. The main checkout's `HEAD`, `index`, `logs/HEAD`, `config`,
 *   `hooks/`, `info/`, `packed-refs`, and other worktrees' admin directories
 *   stay read-only.
 *
 * Git reads a linked worktree's common directory from `<gitDir>/commondir`.
 * Approved commands cannot write it, but a process outside the sandbox can
 * redirect it; `gitDir` comes from the checkout's gitfile, which commands
 * cannot write. The linked-worktree grant is therefore all-or-nothing on
 * `gitDir` sitting directly in `<metadata>/worktrees/`. A shared path is
 * granted only when it exists and is its own realpath, so the grant never
 * follows a symlink out of the common directory. A command cannot swap a
 * granted path for a symlink, because the path's parent stays read-only.
 */
async function gitMetadataGrant(gitDir: string, metadata: string): Promise<GitMetadataGrant> {
  if (gitDir === metadata) return { paths: [metadata] };
  // Handles only: this admin directory is not a direct child of `<metadata>/worktrees/`.
  if (dirname(gitDir) !== join(metadata, "worktrees")) return { paths: [] };
  const shared: string[] = [];
  for (const path of [
    join(metadata, "objects"),
    join(metadata, "refs"),
    join(metadata, "logs", "refs"),
  ]) {
    // Handles only: the path resolves to itself (exists, no symlink on the way).
    if ((await realpath(path).catch(() => undefined)) === path) shared.push(path);
  }
  return { paths: [...shared, gitDir], admin: gitDir };
}

interface PointerRecord {
  readonly name: WorktreePointer;
  readonly path: string;
  /** The regular file before the command; absent when there was none, or only a placeholder. */
  readonly file?: { readonly mode: bigint; readonly bytes: Buffer };
  /** A placeholder `config.worktree` sits at the path, for bwrap to mount read-only. */
  readonly placeholder: boolean;
}

type EntryStats = Awaited<ReturnType<typeof lstatOrAbsent>>;

const lstatOrAbsent = (path: string) =>
  lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    // Handles only: nothing exists at the path.
    if (error.code === "ENOENT") return undefined;
    throw error;
  });

const PLACEHOLDER_BYTES = Buffer.from(WORKTREE_CONFIG_PLACEHOLDER);

/** Whether `entry` is a placeholder config.worktree, which counts as no file at all. */
async function holdsPlaceholder(path: string, entry: EntryStats): Promise<boolean> {
  if (!entry?.isFile() || entry.nlink !== 1n || entry.size !== BigInt(PLACEHOLDER_BYTES.length))
    return false;
  const bytes = await readFile(path).catch((error: NodeJS.ErrnoException) => {
    // Handles only: another session removed its placeholder after the lstat.
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return bytes?.equals(PLACEHOLDER_BYTES) ?? false;
}

/**
 * Records the pointer files before an approved command runs in a linked
 * worktree. The sandbox profile denies writes to them; the record lets the
 * host restore anything the profile cannot stop before the result returns.
 */
async function recordWorktreePointers(admin: string): Promise<PointerRecord[]> {
  const records: PointerRecord[] = [];
  for (const name of WORKTREE_POINTERS) {
    const path = join(admin, name);
    let entry = await lstatOrAbsent(path);
    // bwrap cannot mount over a missing path, and the placeholder sets nothing.
    if (!entry && name === "config.worktree" && process.platform === "linux") {
      await writeFile(path, WORKTREE_CONFIG_PLACEHOLDER, { flag: "wx" }).catch(
        (error: NodeJS.ErrnoException) => {
          // Handles only: another session on this worktree created one first.
          if (error.code !== "EEXIST") throw error;
        },
      );
      entry = await lstatOrAbsent(path);
    }
    // Ours, another session's, or one a crashed session left: it is removed after the command.
    if (name === "config.worktree" && (await holdsPlaceholder(path, entry))) {
      records.push({ name, path, placeholder: true });
      continue;
    }
    // Handles only: an entry that is not one regular file cannot be restored byte for byte.
    if (entry && (!entry.isFile() || entry.nlink !== 1n)) {
      await restoreWorktreePointers(records);
      throw new WorktreeGitStateError(WORKTREE_GIT_STATE_FAILURES.irregular);
    }
    records.push({
      name,
      path,
      placeholder: false,
      ...(entry && {
        file: { mode: entry.mode, bytes: await readFile(path) },
      }),
    });
  }
  return records;
}

/**
 * Restores every pointer file that differs from its record, removes any
 * placeholder, then refuses the command, naming the first changed file.
 */
async function restoreWorktreePointers(records: readonly PointerRecord[]): Promise<void> {
  let changed: WorktreePointer | undefined;
  for (const record of records) {
    const entry = await lstatOrAbsent(record.path);
    // The mode includes the file type, so a symlink or directory never matches a regular file,
    // and a second link would let a later write elsewhere change the same bytes.
    const intact = record.file
      ? entry !== undefined &&
        entry.mode === record.file.mode &&
        entry.nlink === 1n &&
        (await readFile(record.path)).equals(record.file.bytes)
      : entry === undefined ||
        (record.name === "config.worktree" && (await holdsPlaceholder(record.path, entry)));
    if (!intact) changed ??= record.name;
    if (!record.file && entry) await rm(record.path, { recursive: true, force: true });
    else if (!intact && record.file) await restorePointerFile(record.path, record.file);
  }
  if (changed) throw new WorktreeGitStateError(WORKTREE_GIT_STATE_FAILURES[changed]);
}

const restoreStaging = (path: string) => `${path}.docsfab-restore`;

/** Replaces the path atomically, so host Git never reads a missing or partial pointer. */
async function restorePointerFile(
  path: string,
  file: NonNullable<PointerRecord["file"]>,
): Promise<void> {
  const staged = restoreStaging(path);
  await rm(staged, { recursive: true, force: true });
  await writeFile(staged, file.bytes, { flag: "wx" });
  await chmod(staged, Number(file.mode) & ~constants.S_IFMT);
  // rename() replaces a file or symlink but not a directory.
  if ((await lstatOrAbsent(path))?.isDirectory()) await rm(path, { recursive: true, force: true });
  await rename(staged, path);
}

/**
 * Host Git runs a child Git process, with that repository's own configuration,
 * in every gitlink (mode 160000) whose directory holds `.git`. Git started
 * inside a directory with `.git`, or inside a bare repository layout, uses that
 * repository. A linked worktree keeps its submodules' Git directories in
 * `<admin>/modules/`. This record lets the host remove any of that state an
 * approved command creates.
 */
interface EmbeddedRepositoryRecord {
  readonly repository: string;
  /** Documentation paths the command may write. */
  readonly documentation: readonly string[];
  /** Repository markers under documentation before the command. */
  readonly markers: RepositoryMarkers;
  readonly modules: string;
  readonly modulesExisted: boolean;
  readonly index: IndexRecord;
  /** Existing directories and files bwrap mounts read-only. */
  readonly readOnly: readonly string[];
  /** Existing Git directories under documentation the macOS profile denies as trees. */
  readonly protectedTrees: readonly string[];
}

interface IndexRecord {
  /** Gitlink paths, decoded as Latin-1 so any path bytes round-trip to Git. */
  readonly gitlinks: ReadonlySet<string>;
  /** Each staged `.gitmodules` entry as `<mode> <object> <stage>`. */
  readonly gitmodules: readonly string[];
}

async function recordEmbeddedRepositories(
  repository: string,
  admin: string,
  documentation: readonly string[],
): Promise<EmbeddedRepositoryRecord> {
  const modules = join(admin, "modules");
  const existing = await lstatOrAbsent(modules);
  // Handles only: a modules entry that is not a directory cannot be held read-only as one.
  if (existing && !existing.isDirectory())
    throw new WorktreeGitStateError(WORKTREE_GIT_STATE_FAILURES.irregular);
  const index = await readIndex(repository);
  if (!index) throw new WorktreeGitStateError(WORKTREE_GIT_STATE_FAILURES.indexUnreadable);
  const markers = await repositoryMarkers(documentation, { repair: false });
  if (markers.unreadable)
    throw new WorktreeGitStateError(WORKTREE_GIT_STATE_FAILURES.documentationUnrepairable);
  const layouts = [...markers.layouts].filter(([, layout]) => layout.identity.mountable);
  return {
    repository,
    documentation,
    markers,
    modules,
    modulesExisted: existing !== undefined,
    index,
    readOnly: [
      ...(existing ? [modules] : []),
      ...[...markers.dotGit].flatMap(([path, entry]) => (entry.mountable ? [path] : [])),
      ...layouts.map(([path]) => path),
    ],
    protectedTrees: layouts.map(([path]) => path),
  };
}

/**
 * Removes the repository markers, submodule Git directories, and gitlinks the
 * command created, restores a changed `.gitmodules` entry, then refuses the
 * command. Pre-existing entries stay, including ones moved within documentation.
 */
async function restoreEmbeddedRepositories(record: EmbeddedRepositoryRecord): Promise<void> {
  const failures: (typeof RESTORE_FAILURE_ORDER)[number][] = [];
  // Files first, so no Git process below can find a repository the command created.
  const after = await repositoryMarkers(record.documentation, { repair: true });
  const created = createdMarkers(record.markers, after);
  if (!record.modulesExisted && (await lstatOrAbsent(record.modules))) created.push(record.modules);
  let unremoved = after.unreadable;
  for (const path of created) if (!(await removeCreated(path))) unremoved = true;
  if (unremoved) failures.push("documentationUnrepairable");
  if (created.length) failures.push("nestedRepository");
  const index = await readIndex(record.repository);
  if (!index) failures.push("indexUnrestorable");
  else {
    const gitlinks = [...index.gitlinks].filter((path) => !record.index.gitlinks.has(path));
    const gitmodules = index.gitmodules.join("\n") !== record.index.gitmodules.join("\n");
    const remove = [...gitlinks, ...(gitmodules ? [".gitmodules"] : [])];
    if (remove.length) {
      const removed = await hostGit(
        record.repository,
        ["update-index", "--force-remove", "-z", "--stdin"],
        remove.map((path) => `${path}\0`).join(""),
      );
      const restored =
        removed !== undefined &&
        (!gitmodules ||
          !record.index.gitmodules.length ||
          (await hostGit(
            record.repository,
            ["update-index", "-z", "--index-info"],
            record.index.gitmodules.map((entry) => `${entry}\t.gitmodules\0`).join(""),
          )) !== undefined);
      if (!restored) failures.push("indexUnrestorable");
      if (gitlinks.length) failures.push("gitlink");
      if (gitmodules) failures.push("gitmodules");
    }
  }
  const first = RESTORE_FAILURE_ORDER.find((failure) => failures.includes(failure));
  if (first) throw new WorktreeGitStateError(WORKTREE_GIT_STATE_FAILURES[first]);
}

/** What DocsFab could not undo outranks what it undid. */
const RESTORE_FAILURE_ORDER = [
  "documentationUnrepairable",
  "indexUnrestorable",
  "nestedRepository",
  "gitlink",
  "gitmodules",
] as const;

/**
 * Removes an entry the command created. A command can lock it first, with
 * owner permissions or, on macOS, the user immutable and append-only flags,
 * so a failed removal lifts those and tries once more.
 */
async function removeCreated(path: string): Promise<boolean> {
  const removed = () =>
    rm(path, { recursive: true, force: true }).then(
      () => true,
      () => false,
    );
  if (await removed()) return true;
  // Best effort, like the access grant below: the second removal decides the outcome.
  if (process.platform === "darwin")
    await exec("/usr/bin/chflags", ["-R", "nouchg,nouappnd", path], {
      env: untrustedChildEnvironment(process.env),
    }).catch(() => undefined);
  await grantOwnerAccess(path);
  return removed();
}

/** Gives the owner full access to a directory and every directory below it, without following symlinks. */
async function grantOwnerAccess(path: string): Promise<void> {
  // Best effort: the caller's second removal reports what stays locked.
  const entry = await lstat(path).catch(() => undefined);
  if (!entry?.isDirectory()) return;
  await chmod(path, (entry.mode & ~constants.S_IFMT) | constants.S_IRWXU).catch(() => undefined);
  for (const name of await readdir(path).catch(() => [])) await grantOwnerAccess(join(path, name));
}

/** HFS+ ignores these code points when it compares names, and so does Git's `.git` check. */
const HFS_IGNORABLE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu;
/** A name as a case-insensitive file system, and Git's own checks, compare it. */
const folded = (name: string) => name.replace(HFS_IGNORABLE, "").toLowerCase();
/** Entries that make Git open their directory as a repository when started inside it. */
const LAYOUT_ENTRIES = new Set(["head", "objects", "refs", "commondir"]);

/**
 * Git state under documentation that Git would open as a repository: `.git`
 * entries, in any case, and bare repository layouts, which are directories
 * with `HEAD` beside `objects` and `refs` or beside `commondir`.
 */
interface RepositoryMarkers {
  readonly dotGit: ReadonlyMap<string, EntryIdentity>;
  readonly layouts: ReadonlyMap<string, RepositoryLayout>;
  /** Identities of every entry named like a layout entry, in or out of a layout. */
  readonly layoutEntries: ReadonlySet<string>;
  readonly unreadable: boolean;
}

interface RepositoryLayout {
  readonly identity: EntryIdentity;
  /** The layout entries in the directory, by path, with their identities. */
  readonly entries: ReadonlyMap<string, string>;
}

/**
 * Walks `roots` without following or entering a symlink, and without entering a
 * `.git` entry. With `repair`, a directory the command made unreadable to its
 * owner gets owner read and search access back first, so it cannot hide an entry.
 */
async function repositoryMarkers(
  roots: readonly string[],
  options: { repair: boolean },
): Promise<RepositoryMarkers> {
  const dotGit = new Map<string, EntryIdentity>();
  const layouts = new Map<string, RepositoryLayout>();
  const layoutEntries = new Set<string>();
  let unreadable = false;
  const visit = async (path: string, entry: EntryStats): Promise<void> => {
    if (!entry?.isDirectory()) return;
    const readable = constants.S_IRUSR | constants.S_IXUSR;
    if (options.repair && (Number(entry.mode) & readable) !== readable)
      // Best effort: the read below reports a directory that stays locked.
      await chmod(path, (Number(entry.mode) & ~constants.S_IFMT) | readable).catch(() => undefined);
    const names = await readdir(path).catch((error: NodeJS.ErrnoException) => {
      // Handles only: the directory went away, or became a file, after the lstat.
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
      unreadable = true;
      return [];
    });
    const entries = new Map<string, string>();
    const kinds = new Set<string>();
    for (const name of names) {
      const child = join(path, name);
      const stats = await lstat(child, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
        // Handles only: the entry went away after the listing.
        if (error.code === "ENOENT") return undefined;
        unreadable = true;
        return undefined;
      });
      if (!stats) continue;
      const kind = folded(name);
      if (kind === ".git") {
        dotGit.set(child, await identify(child, stats));
        continue;
      }
      if (LAYOUT_ENTRIES.has(kind)) {
        const { identity } = await identify(child, stats);
        entries.set(child, identity);
        layoutEntries.add(identity);
        kinds.add(kind);
      }
      await visit(child, stats);
    }
    if (
      kinds.has("head") &&
      (kinds.has("commondir") || (kinds.has("objects") && kinds.has("refs")))
    )
      layouts.set(path, { identity: await identify(path, entry), entries });
  };
  for (const root of roots) await visit(root, await lstatOrAbsent(root));
  return { dotGit, layouts, layoutEntries, unreadable };
}

interface EntryIdentity {
  /** Device, inode, type, and a symlink's target: a moved entry keeps it, a new one does not. */
  readonly identity: string;
  readonly mountable: boolean;
}

async function identify(path: string, entry: NonNullable<EntryStats>): Promise<EntryIdentity> {
  const target = entry.isSymbolicLink() ? await readlink(path) : "";
  const type = Number(entry.mode) & constants.S_IFMT;
  return {
    identity: `${entry.dev}:${entry.ino}:${type}:${target}`,
    // bwrap would mount a symlink's target; a replaced link fails the identity check instead.
    mountable: entry.isDirectory() || entry.isFile(),
  };
}

/**
 * The `.git` entries the command created, and for each bare repository layout
 * it created, the entries that make it one: its new `HEAD`, or else its other
 * new layout entries. Entries that existed before stay, even when moved.
 */
function createdMarkers(before: RepositoryMarkers, after: RepositoryMarkers): string[] {
  const known = new Set([...before.dotGit.values()].map((entry) => entry.identity));
  const knownLayouts = new Set(
    [...before.layouts.values()].map((layout) => layout.identity.identity),
  );
  const created = [...after.dotGit]
    .filter(([, entry]) => !known.has(entry.identity))
    .map(([path]) => path);
  for (const layout of after.layouts.values()) {
    if (knownLayouts.has(layout.identity.identity)) continue;
    const added = [...layout.entries].filter(([, identity]) => !before.layoutEntries.has(identity));
    const head = added.filter(([path]) => folded(basename(path)) === "head");
    created.push(...(head.length ? head : added).map(([path]) => path));
  }
  return created;
}

/** Host Git for the index check: no hooks, fsmonitor, submodule recursion, or user config. */
const INDEX_GIT = [...SAFE_GIT_CONFIG, "-c", "submodule.recurse=false", "--no-optional-locks"];

async function readIndex(repository: string): Promise<IndexRecord | undefined> {
  const listing = await hostGit(repository, ["ls-files", "--stage", "-z"]);
  if (listing === undefined) return undefined;
  const gitlinks = new Set<string>();
  const gitmodules: string[] = [];
  for (const line of listing.split("\0")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const entry = line.slice(0, tab);
    const path = line.slice(tab + 1);
    if (entry.startsWith("160000 ")) gitlinks.add(path);
    if (path === ".gitmodules") gitmodules.push(entry);
  }
  return { gitlinks, gitmodules };
}

/** Resolves Git's output as Latin-1, which keeps path bytes intact, or undefined on failure. */
function hostGit(
  repository: string,
  args: readonly string[],
  input?: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn("git", [...INDEX_GIT, ...args], {
      cwd: repository,
      env: gitEnvironment(),
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => resolve(undefined));
    child.on("close", (code) =>
      resolve(code === 0 ? Buffer.concat(chunks).toString("latin1") : undefined),
    );
    // Handles only: Git exited before reading its input; its exit code reports that.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(Buffer.from(input ?? "", "latin1"));
  });
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
