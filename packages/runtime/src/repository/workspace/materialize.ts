// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, mkdtemp, mkdir, open, realpath, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { Readable } from "node:stream";
import { promisify } from "node:util";

import {
  formatLimitObservation,
  OperationalLimitError,
  type ResolveLimitsOptions,
} from "../../config/limits.js";
import {
  repositoryWorkspaceExportLimits,
  type RepositoryWorkspaceExportLimitsV1,
} from "../../config/repository-discovery-limits.js";
import {
  RepositoryWorkspaceMaterializationError,
  type RepositoryWorkspace,
  type GithubPrHeadWorkspace,
  type RepositoryWorkspaceMaterializationFailureCode,
  type RepositoryWorkspaceMaterializationFailureEvidence,
  type RepositoryWorkspaceMaterializationLimits,
  type RepositoryWorkspacePreparationOptions,
  type TrackedWorkspaceEntryKind,
} from "./contracts.js";
import {
  classifyRepositoryConfigurationKey,
  failRepositoryConfiguration,
  worktreeConfigurationEnabled,
  type RepositoryConfigurationScopeV1,
} from "./configuration-refusal.js";
import {
  RepositoryAccessRefusalError,
  repositoryAccessRefusalCode,
  repositoryFilesystemAccessDenied,
} from "./access-refusal.js";
import { isExportExcluded } from "./export-exclusion.js";
import {
  deactivateRepositoryWorkspace,
  disposeScopedRepositoryWorkspace,
  registerRepositoryWorkspace,
} from "./tracked-read.js";
import {
  assertGithubPrVerifiedTreeExportPort,
  GithubPrObjectError,
  type GithubPrVerifiedTreeExportPort,
} from "../../inputs/adapters/github-pr-objects.js";

interface TrackedWorkspaceEntry {
  path: string;
  kind: TrackedWorkspaceEntryKind;
  objectId?: string;
  digest?: string;
  size?: bigint;
  device?: bigint;
  inode?: bigint;
  mode?: bigint;
  modifiedNs?: bigint;
  changedNs?: bigint;
}

interface TrackedTreeEntry {
  path: string;
  kind: TrackedWorkspaceEntryKind;
  objectId: string;
  size?: bigint;
  executable: boolean;
}

interface MaterializationFailureDescriptor {
  code: RepositoryWorkspaceMaterializationFailureCode;
  phase: RepositoryWorkspaceMaterializationFailureEvidence["phase"];
  quantity: RepositoryWorkspaceMaterializationFailureEvidence["quantity"];
  /** Catalog refusal line when an operational limit stopped the export. */
  limitRefusal?: string;
}

/**
 * The export's progress clock. Hang detection is a no-progress window, not a
 * wall clock: every finished step moves `lastProgressAt`, and the export stops
 * only when it goes longer than `limits.maxStallMs` without one.
 */
interface ExportClock {
  readonly limits: Readonly<RepositoryWorkspaceMaterializationLimits>;
  /** The catalog limit behind each ceiling in `limits`, named in its refusal. */
  readonly catalog: RepositoryWorkspaceExportLimitsV1;
  /** `performance.now()` at the export's most recent progress. */
  lastProgressAt: number;
}

type ExportPhase = RepositoryWorkspaceMaterializationFailureEvidence["phase"];

interface MaterializationContext {
  controller: AbortController;
  activeChildren: Set<ReturnType<typeof spawn>>;
  limits: Readonly<RepositoryWorkspaceMaterializationLimits>;
  clock: ExportClock;
  /** True while a file's bytes are streaming from git, so a stall there is per-blob. */
  blobInFlight: boolean;
  firstFailure?: MaterializationFailureDescriptor;
  startedChildren: number;
  cancellationRequested: number;
  reapedChildren: number;
  writtenBytes: bigint;
  allocatedScratchBytes: bigint;
}

class MaterializationCancelled extends Error {}

const execFileAsync = promisify(execFile);
const GIT_BINARY = process.platform === "win32" ? "git" : "/usr/bin/git";
const LOSSLESS_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function filesystemErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

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
  "diff.trustExitCode=false",
  "-c",
  "pager.status=false",
  "-c",
  "pager.diff=false",
] as const;

function credentialFreeGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: "/dev/null",
    XDG_CONFIG_HOME: "/dev/null",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    GIT_PAGER: "cat",
    GIT_ALLOW_PROTOCOL: "file",
  };
}

/**
 * Run one preflight `git` read. The command is one step of the export, so it
 * may run for the rest of the no-progress window; the watchdog ends it only
 * once the export has stalled, and its success is progress.
 */
async function git(repositoryPath: string, args: string[], clock: ExportClock): Promise<string> {
  assertExportProgressing(clock, "preflight");
  const controller = new AbortController();
  const stopWatching = watchForStall(clock, () => controller.abort());
  try {
    const result = await execFileAsync(
      GIT_BINARY,
      [...SAFE_GIT_CONFIG, "-C", repositoryPath, ...args],
      {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        signal: controller.signal,
        env: credentialFreeGitEnvironment(),
      },
    );
    assertExportProgressing(clock, "preflight");
    recordExportProgress(clock);
    return result.stdout.trim();
  } catch (error) {
    if (error instanceof RepositoryWorkspaceMaterializationError) throw error;
    if (controller.signal.aborted || exportStalled(clock)) {
      throw stallError(clock, "aggregate-timeout", "preflight");
    }
    const refusal = repositoryAccessRefusalCode(error);
    if (refusal !== undefined) throw new RepositoryAccessRefusalError(refusal);
    throw new Error("Git workspace preparation failed.");
  } finally {
    stopWatching();
  }
}

/**
 * Refuse a checkout whose own git configuration would run a program, with a
 * coded error whose sentence survives relays that withhold unknown messages.
 *
 * Worktree scope is screened only where git honours it. An unconditional
 * `git config --worktree` exits 128 when `extensions.worktreeConfig` is off and
 * the repository has more than one working tree (even a stale one), or when
 * the extension is on but `config.worktree` does not exist yet. So the
 * extension is read from the `--local` listing, the file is probed for
 * existence, and a read that still fails becomes a coded refusal.
 * `core.repositoryFormatVersion` plays no part: git honours the extension at 0.
 */
async function rejectExecutableRepositoryConfiguration(
  repositoryPath: string,
  clock: ExportClock,
): Promise<void> {
  const localEntries = parseGitConfigurationEntries(
    await git(repositoryPath, ["config", "--local", "--no-includes", "--null", "--list"], clock),
  );
  screenRepositoryConfigurationEntries(localEntries, "local");
  if (!worktreeConfigurationEnabled(localEntries)) return;

  const worktreeConfigPath = await readableGit(
    repositoryPath,
    ["rev-parse", "--git-path", "config.worktree"],
    clock,
  );
  if (worktreeConfigPath === undefined) {
    failRepositoryConfiguration("worktree-configuration-unreadable", "worktree");
  }
  // `--git-path` answers relative to the repository for a main checkout and
  // absolute for a linked one, so resolve before asking whether it exists.
  if (!(await pathExists(resolve(repositoryPath, worktreeConfigPath)))) return;

  const worktreeConfig = await readableGit(
    repositoryPath,
    ["config", "--worktree", "--no-includes", "--null", "--list"],
    clock,
  );
  if (worktreeConfig === undefined) {
    failRepositoryConfiguration("worktree-configuration-unreadable", "worktree");
  }
  screenRepositoryConfigurationEntries(parseGitConfigurationEntries(worktreeConfig), "worktree");
}

/** One `git config --null --list` record is `key`, `\n`, then the value. */
function parseGitConfigurationEntries(
  config: string,
): readonly { readonly key: string; readonly value: string | undefined }[] {
  return config
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf("\n");
      return separator < 0
        ? { key: entry.toLowerCase(), value: undefined }
        : { key: entry.slice(0, separator).toLowerCase(), value: entry.slice(separator + 1) };
    });
}

function screenRepositoryConfigurationEntries(
  entries: readonly { readonly key: string; readonly value: string | undefined }[],
  scope: RepositoryConfigurationScopeV1,
): void {
  for (const entry of entries) {
    const code = classifyRepositoryConfigurationKey(entry.key);
    if (code !== undefined) failRepositoryConfiguration(code, scope);
  }
}

/**
 * Run one `git` read whose failure returns `undefined` for the caller to refuse.
 * A materialization error, including a stall, still propagates.
 */
async function readableGit(
  repositoryPath: string,
  args: string[],
  clock: ExportClock,
): Promise<string | undefined> {
  try {
    return await git(repositoryPath, args, clock);
  } catch (error) {
    if (error instanceof RepositoryWorkspaceMaterializationError) throw error;
    return undefined;
  }
}

/**
 * Not `isFile()`: a symlink or directory is git's to accept or reject, and a
 * plain-file test would silently skip the scope instead of refusing.
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export async function withRepositoryWorkspace<T>(
  repositoryPath: string,
  requestedRevision: string,
  action: (workspace: RepositoryWorkspace) => Promise<T>,
): Promise<T> {
  const workspace = await prepareRepositoryWorkspace(repositoryPath, requestedRevision);
  try {
    return await action(workspace);
  } finally {
    await workspace.dispose();
  }
}

export async function prepareRepositoryWorkspace(
  repositoryPath: string,
  requestedRevision = "HEAD",
  options: RepositoryWorkspacePreparationOptions = {},
): Promise<RepositoryWorkspace> {
  const catalog = repositoryWorkspaceExportLimits();
  const limits = materializationLimits(options.limits, catalog);
  const clock: ExportClock = { limits, catalog, lastProgressAt: performance.now() };
  let sourceInput: string;
  try {
    sourceInput = await awaitReadOnlyWithinStall(
      () => realpath(resolve(repositoryPath)),
      clock,
      "preflight",
    );
  } catch (error) {
    if (repositoryFilesystemAccessDenied(error)) {
      // hygiene: envelope — the typed class renders frozen operator text and its code maps the operator envelope.
      throw new RepositoryAccessRefusalError("repository-access-denied");
    }
    throw error;
  }
  const sourcePath = await git(sourceInput, ["rev-parse", "--show-toplevel"], clock);
  await rejectExecutableRepositoryConfiguration(sourcePath, clock);
  const revision = await git(
    sourcePath,
    ["rev-parse", "--verify", "--end-of-options", `${requestedRevision}^{commit}`],
    clock,
  );
  const { treeEntries, plannedScratchBytes } = await readTrackedTree(sourcePath, revision, clock);
  await enforceScratchAvailability(plannedScratchBytes, clock);
  let temporaryRoot: string | undefined;

  try {
    // Local filesystem promises are not cancellable. Await settlement, then check
    // the no-progress window so cleanup cannot race a late mutation.
    temporaryRoot = await mkdtemp(join(tmpdir(), "docsfab-workspace-"));
    assertExportProgressing(clock, "materialization");
    recordExportProgress(clock);
    const workspacePath = join(temporaryRoot, "repository");
    await mkdir(workspacePath);
    assertExportProgressing(clock, "materialization");
    recordExportProgress(clock);
    const blobDigests = await materializeTrackedBlobs(
      sourcePath,
      workspacePath,
      treeEntries,
      clock,
    );
    const workspaceMetadata = await awaitReadOnlyWithinStall(
      () => lstat(workspacePath),
      clock,
      "verification",
    );
    const canonicalWorkspacePath = await awaitReadOnlyWithinStall(
      () => realpath(workspacePath),
      clock,
      "verification",
    );
    const trackedEntries = await captureTrackedEntries(
      canonicalWorkspacePath,
      treeEntries,
      blobDigests,
      clock,
    );

    let workspace: RepositoryWorkspace;
    workspace = Object.freeze({
      path: workspacePath,
      sourcePath,
      requestedRevision,
      revision,
      async dispose(): Promise<void> {
        const root = deactivateRepositoryWorkspace(workspace);
        if (root) await rm(root, { recursive: true, force: true });
      },
    });
    registerRepositoryWorkspace(workspace, {
      temporaryRoot,
      workspacePath: canonicalWorkspacePath,
      device: workspaceMetadata.dev,
      inode: workspaceMetadata.ino,
      trackedEntries,
    });
    return workspace;
  } catch (error) {
    if (temporaryRoot !== undefined) {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
    if (error instanceof RepositoryWorkspaceMaterializationError) throw error;
    throw materializationError({
      code: "materialization-failed",
      phase: "materialization",
      quantity: null,
    });
  }
}

/** Export a verified H tree without invoking local checkout Git or accepting a serialized tree. */
export async function prepareRepositoryWorkspaceFromVerifiedTree(
  port: GithubPrVerifiedTreeExportPort,
  identity: { readonly sourceIdentitySha256: string; readonly manifestSha256: string },
  options: RepositoryWorkspacePreparationOptions & {
    readonly resolvedLimits?: ResolveLimitsOptions;
  } = {},
): Promise<GithubPrHeadWorkspace> {
  assertGithubPrVerifiedTreeExportPort(port);
  port.checkActive();
  if (
    !/^[a-f0-9]{64}$/u.test(identity.sourceIdentitySha256) ||
    !/^[a-f0-9]{64}$/u.test(identity.manifestSha256) ||
    identity.sourceIdentitySha256 !== port.sourceIdentitySha256 ||
    identity.manifestSha256 !== port.manifestSha256
  )
    throw new Error("The verified GitHub PR head workspace identity is invalid.");
  const catalog = repositoryWorkspaceExportLimits(options.resolvedLimits);
  const limits = materializationLimits(options.limits, catalog);
  const clock: ExportClock = { limits, catalog, lastProgressAt: performance.now() };
  const treeEntries: TrackedTreeEntry[] = [];
  const seen = new Set<string>();
  const verifiedRegularByPath = new Map<string, (typeof port.headEntries)[number]>();
  let plannedBytes = 0n;
  let metadataBytes = 0;
  for (const entry of port.headEntries) {
    assertExportProgressing(clock, "preflight");
    if (
      !safeTrackedPath(entry.path) ||
      seen.has(entry.path) ||
      !/^[a-f0-9]{40}$/u.test(entry.objectId) ||
      !["100644", "100755", "120000", "160000"].includes(entry.mode)
    )
      throw materializationError({
        code: "materialization-failed",
        phase: "preflight",
        quantity: null,
      });
    seen.add(entry.path);
    metadataBytes +=
      Buffer.byteLength(entry.path) + Buffer.byteLength(entry.mode) + entry.objectId.length;
    if (metadataBytes > limits.maxTreeMetadataBytes)
      throw materializationError(
        limitFailure(
          clock,
          "maxTreeMetadataBytes",
          "tree-metadata-limit",
          "preflight",
          "bytes",
          metadataBytes,
        ),
      );
    if (treeEntries.length >= limits.maxTreeEntries)
      throw materializationError(
        limitFailure(
          clock,
          "maxTreeEntries",
          "file-count-limit",
          "preflight",
          "files",
          treeEntries.length + 1,
        ),
      );
    const kind: TrackedWorkspaceEntryKind = isExportExcluded(entry.path)
      ? "excluded"
      : entry.mode === "160000"
        ? "submodule"
        : entry.mode === "120000"
          ? "symlink"
          : "regular";
    if (
      kind === "regular" &&
      (entry.byteLength === null || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0)
    )
      throw materializationError({
        code: "materialization-failed",
        phase: "preflight",
        quantity: null,
      });
    const size = kind === "regular" ? BigInt(entry.byteLength!) : undefined;
    treeEntries.push({
      path: entry.path,
      kind,
      objectId: entry.objectId,
      ...(size === undefined ? {} : { size }),
      executable: entry.mode === "100755",
    });
    if (kind === "regular") verifiedRegularByPath.set(entry.path, entry);
    if (size !== undefined) plannedBytes += size;
    if (plannedBytes > BigInt(limits.maxAggregateBytes))
      throw materializationError(
        limitFailure(
          clock,
          "maxAggregateBytes",
          "aggregate-byte-limit",
          "preflight",
          "bytes",
          plannedBytes,
        ),
      );
    const plannedScratch = plannedBytes + BigInt(treeEntries.length) * SCRATCH_ENTRY_OVERHEAD_BYTES;
    if (plannedScratch > BigInt(limits.maxScratchBytes))
      throw materializationError(
        limitFailure(
          clock,
          "maxScratchBytes",
          "scratch-space-limit",
          "preflight",
          "bytes",
          plannedScratch,
        ),
      );
    recordExportProgress(clock);
  }
  await enforceScratchAvailability(
    plannedBytes + BigInt(treeEntries.length) * SCRATCH_ENTRY_OVERHEAD_BYTES,
    clock,
  );
  port.checkActive();
  let temporaryRoot: string | undefined;
  try {
    temporaryRoot = await mkdtemp(join(tmpdir(), "docsfab-github-head-"));
    assertExportProgressing(clock, "materialization");
    recordExportProgress(clock);
    const workspacePath = join(temporaryRoot, "repository");
    await mkdir(workspacePath);
    assertExportProgressing(clock, "materialization");
    recordExportProgress(clock);
    const context: MaterializationContext = {
      controller: new AbortController(),
      activeChildren: new Set(),
      limits,
      clock,
      blobInFlight: false,
      startedChildren: 0,
      cancellationRequested: 0,
      reapedChildren: 0,
      writtenBytes: 0n,
      allocatedScratchBytes: 0n,
    };
    const cancelExport = () => context.controller.abort();
    port.signal.addEventListener("abort", cancelExport, { once: true });
    if (port.signal.aborted) cancelExport();
    const regular = treeEntries.filter(
      (entry): entry is TrackedTreeEntry & { size: bigint } =>
        entry.kind === "regular" && entry.size !== undefined,
    );
    const digests = new Map<string, string>();
    const stopWatching = watchForStall(clock, () => {
      failMaterialization(
        context,
        stallFailure(
          clock,
          context.blobInFlight ? "per-blob-timeout" : "aggregate-timeout",
          "materialization",
        ),
      );
      port.cancel();
    });
    try {
      await createExportDirectories(workspacePath, regular, context);
      for (const entry of regular) {
        if (context.controller.signal.aborted) throw new MaterializationCancelled();
        const verified = verifiedRegularByPath.get(entry.path);
        if (verified === undefined)
          throw new Error("The verified H tree entry is missing during workspace materialization.");
        context.blobInFlight = true;
        let bytes: Buffer | undefined;
        try {
          bytes = await port.readVerifiedBlob(verified, () => {
            assertExportProgressing(clock, "materialization");
            recordExportProgress(clock);
          });
          assertExportProgressing(clock, "materialization");
          recordExportProgress(clock);
          if (context.controller.signal.aborted) throw new MaterializationCancelled();
          if (BigInt(bytes.length) !== entry.size)
            throw new Error(
              "The verified H blob size changed before workspace materialization completed.",
            );
          const nextBytes = context.writtenBytes + BigInt(bytes.length);
          if (nextBytes > BigInt(limits.maxAggregateBytes))
            throw materializationError(
              limitFailure(
                clock,
                "maxAggregateBytes",
                "aggregate-byte-limit",
                "materialization",
                "bytes",
                nextBytes,
              ),
            );
          const digest = createHash("sha256").update(bytes).digest("hex");
          const absolute = join(workspacePath, ...entry.path.split("/"));
          let handle;
          try {
            handle = await open(
              absolute,
              fsConstants.O_WRONLY |
                fsConstants.O_CREAT |
                fsConstants.O_EXCL |
                fsConstants.O_NOFOLLOW,
              entry.executable ? 0o755 : 0o644,
            );
          } catch (error) {
            if (filesystemErrorCode(error, "EEXIST") || filesystemErrorCode(error, "ENOTDIR"))
              throw materializationError({
                code: "filesystem-path-collision",
                phase: "materialization",
                quantity: null,
              });
            throw error;
          }
          try {
            assertExportProgressing(clock, "materialization");
            recordExportProgress(clock);
            await handle.chmod(entry.executable ? 0o755 : 0o644);
            assertExportProgressing(clock, "materialization");
            recordExportProgress(clock);
            await writeAll(handle, bytes, 0, context.controller.signal, () => {
              assertExportProgressing(clock, "materialization");
              recordExportProgress(clock);
            });
            await handle.sync();
            assertExportProgressing(clock, "materialization");
            recordExportProgress(clock);
          } finally {
            await handle.close();
          }
          context.writtenBytes = nextBytes;
          digests.set(entry.path, digest);
          const metadata = await lstat(absolute, { bigint: true });
          context.allocatedScratchBytes += metadata.blocks * 512n;
          if (context.allocatedScratchBytes > BigInt(limits.maxScratchBytes))
            throw materializationError(
              limitFailure(
                clock,
                "maxScratchBytes",
                "scratch-space-limit",
                "materialization",
                "bytes",
                context.allocatedScratchBytes,
              ),
            );
        } finally {
          bytes?.fill(0);
        }
        context.blobInFlight = false;
        assertExportProgressing(clock, "materialization");
        recordExportProgress(clock);
      }
      await fsyncDirectory(workspacePath);
      port.checkActive();
    } catch (error) {
      if (context.firstFailure !== undefined) throw materializationError(context.firstFailure);
      throw error;
    } finally {
      stopWatching();
      port.signal.removeEventListener("abort", cancelExport);
    }
    port.checkActive();
    if (context.firstFailure !== undefined) throw materializationError(context.firstFailure);
    const workspaceMetadata = await awaitReadOnlyWithinStall(
      () => lstat(workspacePath),
      clock,
      "verification",
    );
    const canonicalWorkspacePath = await awaitReadOnlyWithinStall(
      () => realpath(workspacePath),
      clock,
      "verification",
    );
    const trackedEntries = await captureTrackedEntries(
      canonicalWorkspacePath,
      treeEntries,
      digests,
      clock,
    );
    port.checkActive();
    let workspace: GithubPrHeadWorkspace;
    workspace = Object.freeze({
      sourceKind: "github-pr-head" as const,
      sourceIdentitySha256: identity.sourceIdentitySha256,
      manifestSha256: identity.manifestSha256,
      targetRepositoryId: port.targetRepositoryId,
      headRepositoryId: port.headRepositoryId,
      B: port.B,
      H: port.H,
      M: port.M,
      headTree: port.headTree,
      headEntriesSha256: port.headEntriesSha256,
      path: workspacePath,
      sourcePath: port.sourcePath,
      requestedRevision: port.H,
      revision: port.H,
      async dispose(): Promise<void> {
        await disposeScopedRepositoryWorkspace(workspace);
      },
    });
    registerRepositoryWorkspace(workspace, {
      temporaryRoot,
      workspacePath: canonicalWorkspacePath,
      device: workspaceMetadata.dev,
      inode: workspaceMetadata.ino,
      trackedEntries,
    });
    return workspace;
  } catch (error) {
    if (temporaryRoot !== undefined) {
      try {
        await rm(temporaryRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "GitHub PR head workspace export and cleanup both failed.",
        );
      }
    }
    if (
      error instanceof RepositoryWorkspaceMaterializationError ||
      error instanceof GithubPrObjectError ||
      error instanceof OperationalLimitError
    )
      throw error;
    throw materializationError({
      code: "materialization-failed",
      phase: "materialization",
      quantity: null,
    });
  }
}

const MATERIALIZATION_LIMIT_KEYS = [
  "maxTreeEntries",
  "maxAggregateBytes",
  "maxScratchBytes",
  "maxTreeMetadataBytes",
  "maxStallMs",
] as const;

/**
 * The ceilings for one export: each catalog limit with any host override
 * applied. A caller override may only tighten them.
 */
function materializationLimits(
  overrides: Partial<RepositoryWorkspaceMaterializationLimits> | undefined,
  catalog: RepositoryWorkspaceExportLimitsV1,
): Readonly<RepositoryWorkspaceMaterializationLimits> {
  const ceilings: Readonly<RepositoryWorkspaceMaterializationLimits> = {
    maxTreeEntries: catalog.maxTreeEntries.value,
    maxAggregateBytes: catalog.maxAggregateBytes.value,
    maxScratchBytes: catalog.maxScratchBytes.value,
    maxTreeMetadataBytes: catalog.maxTreeMetadataBytes.value,
    maxStallMs: catalog.maxStallMs.value,
  };
  const limits = { ...ceilings };
  if (overrides === undefined) return Object.freeze(limits);
  for (const key of MATERIALIZATION_LIMIT_KEYS) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0 || value > ceilings[key]) {
      throw new Error("Repository workspace materialization limits are invalid.");
    }
    limits[key] = value;
  }
  return Object.freeze(limits);
}

function quantity(
  unit: "files" | "bytes" | "milliseconds",
  limit: number | bigint,
  observed: number | bigint,
): NonNullable<RepositoryWorkspaceMaterializationFailureEvidence["quantity"]> {
  return { unit, limit: String(limit), observed: String(observed) };
}

function materializationError(
  failure: MaterializationFailureDescriptor,
  children: RepositoryWorkspaceMaterializationFailureEvidence["children"] = {
    started: 0,
    cancellationRequested: 0,
    reaped: 0,
  },
): RepositoryWorkspaceMaterializationError {
  return new RepositoryWorkspaceMaterializationError(
    {
      schemaVersion: 1,
      kind: "docsfab-repository-workspace-materialization-failure",
      code: failure.code,
      phase: failure.phase,
      quantity: failure.quantity,
      children,
    },
    failure.limitRefusal,
  );
}

/** Re-record a typed failure raised further down, keeping its limit line. */
function failureFromError(
  error: RepositoryWorkspaceMaterializationError,
): MaterializationFailureDescriptor {
  return {
    code: error.evidence.code,
    phase: error.evidence.phase,
    quantity: error.evidence.quantity,
    ...(error.limitRefusal === undefined ? {} : { limitRefusal: error.limitRefusal }),
  };
}

async function enforceScratchAvailability(plannedBytes: bigint, clock: ExportClock): Promise<void> {
  assertExportProgressing(clock, "preflight");
  let availableBytes: bigint;
  try {
    const scratch = await awaitReadOnlyWithinStall(
      () => statfs(tmpdir(), { bigint: true }),
      clock,
      "preflight",
    );
    availableBytes = scratch.bavail * scratch.bsize;
  } catch (error) {
    if (error instanceof RepositoryWorkspaceMaterializationError) throw error;
    throw materializationError({
      code: "scratch-space-limit",
      phase: "preflight",
      quantity: quantity("bytes", 0n, plannedBytes),
    });
  }
  if (plannedBytes > availableBytes) {
    throw materializationError({
      code: "scratch-space-limit",
      phase: "preflight",
      quantity: quantity("bytes", availableBytes, plannedBytes),
    });
  }
  assertExportProgressing(clock, "preflight");
}

/** The stall window restarts now: the export finished one more step. */
function recordExportProgress(clock: ExportClock): void {
  clock.lastProgressAt = performance.now();
}

/** Whole milliseconds since the export last made progress. */
function exportIdleMs(clock: ExportClock): number {
  return Math.floor(performance.now() - clock.lastProgressAt);
}

/**
 * The window admits exactly `maxStallMs` without progress; one millisecond
 * more is a stall, the same comparison `enforceLimit` makes.
 */
function exportStalled(clock: ExportClock): boolean {
  return exportIdleMs(clock) > clock.limits.maxStallMs;
}

function assertExportProgressing(clock: ExportClock, phase: ExportPhase): void {
  if (exportStalled(clock)) throw stallError(clock, "aggregate-timeout", phase);
}

/**
 * Call `onStall` once, when the export goes longer than its window without
 * progress. Progress only moves `lastProgressAt`, so a wake that finds recent
 * progress sleeps for the rest of the new window instead of firing. The delay
 * never exceeds `maxStallMs + 1`, which the catalog keeps within the largest
 * delay a Node timer honours. Returns a function that stops watching.
 */
function watchForStall(clock: ExportClock, onStall: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  const wake = (): void => {
    timer = undefined;
    if (exportStalled(clock)) {
      onStall();
      return;
    }
    timer = setTimeout(wake, clock.limits.maxStallMs + 1 - exportIdleMs(clock));
  };
  timer = setTimeout(wake, Math.max(1, clock.limits.maxStallMs + 1 - exportIdleMs(clock)));
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
}

/**
 * Await one read-only step. It may take the rest of the no-progress window;
 * past that it is abandoned as a stall. Its completion is progress.
 */
async function awaitReadOnlyWithinStall<T>(
  operation: () => Promise<T>,
  clock: ExportClock,
  phase: ExportPhase,
): Promise<T> {
  assertExportProgressing(clock, phase);
  let stopWatching: (() => void) | undefined;
  try {
    const value = await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        stopWatching = watchForStall(clock, () => {
          reject(stallError(clock, "aggregate-timeout", phase));
        });
      }),
    ]);
    assertExportProgressing(clock, phase);
    recordExportProgress(clock);
    return value;
  } finally {
    stopWatching?.();
  }
}

/**
 * The evidence for a catalog limit the export exceeded, with the limit's
 * refusal line: its refusal code, the observed value, the effective limit
 * (caller tightening included), and its remediation.
 */
function limitFailure(
  clock: ExportClock,
  axis: keyof RepositoryWorkspaceMaterializationLimits,
  code: RepositoryWorkspaceMaterializationFailureCode,
  phase: ExportPhase,
  unit: NonNullable<RepositoryWorkspaceMaterializationFailureEvidence["quantity"]>["unit"],
  observed: number | bigint,
): MaterializationFailureDescriptor {
  const value = clock.limits[axis];
  return {
    code,
    phase,
    quantity: quantity(unit, value, observed),
    limitRefusal: formatLimitObservation({ ...clock.catalog[axis], value }, Number(observed)),
  };
}

/** The evidence for an export that stopped making progress for its whole window. */
function stallFailure(
  clock: ExportClock,
  code: "aggregate-timeout" | "per-blob-timeout",
  phase: ExportPhase,
): MaterializationFailureDescriptor {
  return limitFailure(clock, "maxStallMs", code, phase, "milliseconds", exportIdleMs(clock));
}

function stallError(
  clock: ExportClock,
  code: "aggregate-timeout" | "per-blob-timeout",
  phase: ExportPhase,
): RepositoryWorkspaceMaterializationError {
  return materializationError(stallFailure(clock, code, phase));
}

const MAX_TREE_RECORD_BYTES = 1024 * 1024;
const SCRATCH_ENTRY_OVERHEAD_BYTES = 4_096n;

async function readTrackedTree(
  repositoryPath: string,
  revision: string,
  clock: ExportClock,
): Promise<{ treeEntries: TrackedTreeEntry[]; plannedScratchBytes: bigint }> {
  const limits = clock.limits;
  assertExportProgressing(clock, "preflight");
  const child = spawn(
    GIT_BINARY,
    [...SAFE_GIT_CONFIG, "-C", repositoryPath, "ls-tree", "-lrz", "--full-tree", revision],
    {
      env: credentialFreeGitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stderr!.resume();
  let processFailure = false;
  const closed = new Promise<number | null>((resolveClosed) => {
    child.once("error", () => {
      processFailure = true;
    });
    child.once("close", resolveClosed);
  });
  let failure: MaterializationFailureDescriptor | undefined;
  let cancellationRequested = 0;
  const stop = (next: MaterializationFailureDescriptor): void => {
    if (failure !== undefined) return;
    failure = next;
    if (child.exitCode === null && child.signalCode === null && child.kill("SIGKILL")) {
      cancellationRequested = 1;
    }
  };
  // Each listing chunk is progress, so a long listing that keeps arriving is
  // never stopped; one that goes silent for the window is.
  const stopWatching = watchForStall(clock, () => {
    stop(stallFailure(clock, "aggregate-timeout", "preflight"));
  });
  const treeEntries: TrackedTreeEntry[] = [];
  let plannedBytes = 0n;
  let metadataBytes = 0;
  let pending = Buffer.alloc(0);
  try {
    for await (const value of child.stdout!) {
      if (failure !== undefined) break;
      recordExportProgress(clock);
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      metadataBytes += chunk.byteLength;
      if (metadataBytes > limits.maxTreeMetadataBytes) {
        stop(
          limitFailure(
            clock,
            "maxTreeMetadataBytes",
            "tree-metadata-limit",
            "preflight",
            "bytes",
            metadataBytes,
          ),
        );
        break;
      }
      pending = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk]);
      if (pending.byteLength > MAX_TREE_RECORD_BYTES && pending.indexOf(0) < 0) {
        stop({
          code: "tree-metadata-limit",
          phase: "preflight",
          quantity: quantity("bytes", MAX_TREE_RECORD_BYTES, pending.byteLength),
        });
        break;
      }
      let separator: number;
      while ((separator = pending.indexOf(0)) >= 0) {
        if (separator > MAX_TREE_RECORD_BYTES) {
          stop({
            code: "tree-metadata-limit",
            phase: "preflight",
            quantity: quantity("bytes", MAX_TREE_RECORD_BYTES, separator),
          });
          break;
        }
        const recordBytes = pending.subarray(0, separator);
        pending = pending.subarray(separator + 1);
        if (recordBytes.byteLength === 0) continue;
        if (treeEntries.length >= limits.maxTreeEntries) {
          stop(
            limitFailure(
              clock,
              "maxTreeEntries",
              "file-count-limit",
              "preflight",
              "files",
              treeEntries.length + 1,
            ),
          );
          break;
        }
        let entry: TrackedTreeEntry;
        try {
          entry = parseTrackedTreeRecord(LOSSLESS_UTF8.decode(recordBytes));
        } catch {
          stop({ code: "materialization-failed", phase: "preflight", quantity: null });
          break;
        }
        treeEntries.push(entry);
        if (entry.kind === "regular" && entry.size !== undefined) {
          plannedBytes += entry.size;
          if (plannedBytes > BigInt(limits.maxAggregateBytes)) {
            stop(
              limitFailure(
                clock,
                "maxAggregateBytes",
                "aggregate-byte-limit",
                "preflight",
                "bytes",
                plannedBytes,
              ),
            );
            break;
          }
        }
        const plannedScratchBytes =
          plannedBytes + BigInt(treeEntries.length) * SCRATCH_ENTRY_OVERHEAD_BYTES;
        if (plannedScratchBytes > BigInt(limits.maxScratchBytes)) {
          stop(
            limitFailure(
              clock,
              "maxScratchBytes",
              "scratch-space-limit",
              "preflight",
              "bytes",
              plannedScratchBytes,
            ),
          );
          break;
        }
      }
    }
  } catch {
    if (failure === undefined) {
      stop({ code: "materialization-failed", phase: "preflight", quantity: null });
    }
  } finally {
    const code = await closed;
    stopWatching();
    if (failure === undefined && (processFailure || code !== 0 || pending.byteLength !== 0)) {
      failure = { code: "materialization-failed", phase: "preflight", quantity: null };
    }
  }
  if (failure !== undefined) {
    throw materializationError(failure, {
      started: 1,
      cancellationRequested,
      reaped: 1,
    });
  }
  assertExportProgressing(clock, "preflight");
  recordExportProgress(clock);
  return {
    treeEntries,
    plannedScratchBytes: plannedBytes + BigInt(treeEntries.length) * SCRATCH_ENTRY_OVERHEAD_BYTES,
  };
}

function parseTrackedTreeRecord(record: string): TrackedTreeEntry {
  const match = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40,64})\s+(\d+|-)\t([\s\S]+)$/u.exec(record);
  if (!match) throw new Error("invalid-tree-entry");
  const mode = match[1]!;
  const path = match[5]!;
  if (!safeTrackedPath(path)) throw new Error("unsafe-tree-path");
  const unsafeKind =
    match[2] === "commit" || mode === "160000"
      ? ("submodule" as const)
      : mode === "120000"
        ? ("symlink" as const)
        : undefined;
  return {
    path,
    kind: unsafeKind ?? (isExportExcluded(path) ? ("excluded" as const) : ("regular" as const)),
    objectId: match[3]!,
    ...(match[4] !== "-" ? { size: BigInt(match[4]!) } : {}),
    executable: mode === "100755",
  };
}

async function materializeTrackedBlobs(
  sourcePath: string,
  workspacePath: string,
  treeEntries: readonly TrackedTreeEntry[],
  clock: ExportClock,
): Promise<Map<string, string>> {
  const regularEntries = treeEntries.filter(
    (entry): entry is TrackedTreeEntry & { size: bigint } =>
      entry.kind === "regular" && entry.size !== undefined,
  );
  const context: MaterializationContext = {
    controller: new AbortController(),
    activeChildren: new Set(),
    limits: clock.limits,
    clock,
    blobInFlight: false,
    startedChildren: 0,
    cancellationRequested: 0,
    reapedChildren: 0,
    writtenBytes: 0n,
    allocatedScratchBytes: 0n,
  };
  assertExportProgressing(clock, "materialization");
  // A slow export that keeps creating directories and writing bytes is never
  // stopped. One that goes silent for the window stops: per-blob while a
  // file's bytes are streaming from git, aggregate anywhere else.
  const stopWatching = watchForStall(clock, () => {
    failMaterialization(
      context,
      stallFailure(
        clock,
        context.blobInFlight ? "per-blob-timeout" : "aggregate-timeout",
        "materialization",
      ),
    );
  });
  const blobDigests = new Map<string, string>();
  try {
    await createExportDirectories(workspacePath, regularEntries, context);
    if (regularEntries.length > 0) {
      const streamed = await streamGitBatch(sourcePath, workspacePath, regularEntries, context);
      for (const [path, digest] of streamed) blobDigests.set(path, digest);
    }
    if (context.firstFailure === undefined) {
      await awaitMaterializationReadOnly(
        () => fsyncDirectory(workspacePath),
        context,
        "materialization",
      );
    }
  } catch (error) {
    if (error instanceof MaterializationCancelled) {
      // firstFailure already recorded.
    } else if (error instanceof RepositoryWorkspaceMaterializationError) {
      throw error;
    } else if (context.firstFailure === undefined) {
      failMaterialization(context, {
        code: "materialization-failed",
        phase: "materialization",
        quantity: null,
      });
    }
  } finally {
    stopWatching();
  }
  if (context.firstFailure !== undefined) {
    throw materializationError(context.firstFailure, {
      started: context.startedChildren,
      cancellationRequested: context.cancellationRequested,
      reaped: context.reapedChildren,
    });
  }
  return blobDigests;
}

async function createExportDirectories(
  workspacePath: string,
  entries: readonly TrackedTreeEntry[],
  context: MaterializationContext,
): Promise<void> {
  if (context.controller.signal.aborted) throw new MaterializationCancelled();
  const dirs = new Set<string>();
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let acc = workspacePath;
    for (let index = 0; index < parts.length - 1; index += 1) {
      acc = join(acc, parts[index]!);
      dirs.add(acc);
    }
  }
  const ordered = [...dirs].sort(
    (left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right),
  );
  for (const dir of ordered) {
    if (context.controller.signal.aborted) throw new MaterializationCancelled();
    try {
      await mkdir(dir);
    } catch (error) {
      if (filesystemErrorCode(error, "EEXIST")) {
        failMaterialization(context, {
          code: "filesystem-path-collision",
          phase: "materialization",
          quantity: null,
        });
        throw new MaterializationCancelled();
      }
      throw error;
    }
    recordExportProgress(context.clock);
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } catch {
    // Some hosts refuse directory fsync. Scratch is still a private temp tree.
  } finally {
    await handle.close();
  }
}

async function streamGitBatch(
  sourcePath: string,
  workspacePath: string,
  entries: readonly (TrackedTreeEntry & { size: bigint })[],
  context: MaterializationContext,
): Promise<Map<string, string>> {
  if (context.controller.signal.aborted) throw new MaterializationCancelled();
  const child = spawn(GIT_BINARY, [...SAFE_GIT_CONFIG, "-C", sourcePath, "cat-file", "--batch"], {
    env: { ...credentialFreeGitEnvironment(), GIT_FLUSH: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.activeChildren.add(child);
  child.stderr!.resume();
  let spawnFailed = false;
  const closed = new Promise<number | null>((resolveClosed) => {
    child.once("error", () => {
      spawnFailed = true;
      failMaterialization(context, {
        code: "git-blob-failed",
        phase: "materialization",
        quantity: null,
      });
    });
    child.once("close", (code) => {
      context.activeChildren.delete(child);
      context.reapedChildren += 1;
      if (
        context.firstFailure === undefined &&
        !context.controller.signal.aborted &&
        (spawnFailed || (code !== 0 && code !== null))
      ) {
        failMaterialization(context, {
          code: "git-blob-failed",
          phase: "materialization",
          quantity: null,
        });
      }
      resolveClosed(code);
    });
  });
  context.startedChildren += 1;
  const stdout = child.stdout;
  const stdin = child.stdin;
  if (stdout === null || stdin === null) {
    failMaterialization(context, {
      code: "git-blob-failed",
      phase: "materialization",
      quantity: null,
    });
    throw new MaterializationCancelled();
  }
  const reader = new GitBatchStdout(stdout);
  const blobDigests = new Map<string, string>();
  try {
    for (const entry of entries) {
      if (context.controller.signal.aborted) throw new MaterializationCancelled();
      await writeStdinLine(stdin, `${entry.objectId}\n`);
      blobDigests.set(
        entry.path,
        await materializeBatchBlob(workspacePath, entry, reader, context),
      );
    }
    stdin.end();
  } catch (error) {
    if (error instanceof MaterializationCancelled || context.controller.signal.aborted) {
      // firstFailure already recorded by failMaterialization.
    } else if (error instanceof RepositoryWorkspaceMaterializationError) {
      failMaterialization(context, failureFromError(error));
    } else {
      failMaterialization(context, {
        code: "materialization-failed",
        phase: "materialization",
        quantity: null,
      });
    }
  } finally {
    try {
      if (!stdin.destroyed) stdin.end();
    } catch {
      // Child may already be killed.
    }
    await closed;
  }
  if (context.firstFailure !== undefined) throw new MaterializationCancelled();
  return blobDigests;
}

async function materializeBatchBlob(
  workspacePath: string,
  entry: TrackedTreeEntry & { size: bigint },
  reader: GitBatchStdout,
  context: MaterializationContext,
): Promise<string> {
  if (context.controller.signal.aborted) throw new MaterializationCancelled();
  const absolute = join(workspacePath, ...entry.path.split("/"));
  const expectedMode = entry.executable ? 0o755 : 0o644;
  let handle;
  try {
    handle = await open(
      absolute,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      expectedMode,
    );
  } catch (error) {
    if (filesystemErrorCode(error, "EEXIST")) {
      failMaterialization(context, {
        code: "filesystem-path-collision",
        phase: "materialization",
        quantity: null,
      });
      throw new MaterializationCancelled();
    }
    throw error;
  }
  // From here until the file is written, a stall is this blob's: git sent no
  // header or bytes for it within the window.
  context.blobInFlight = true;
  let digest: string;
  try {
    try {
      // Creation modes pass through the umask, so a restrictive umask would fail
      // export verification. Restore the tracked mode through the open
      // descriptor, so a path swapped after creation cannot redirect the chmod.
      await handle.chmod(expectedMode);
    } catch (error) {
      if (error instanceof RepositoryWorkspaceMaterializationError) {
        failMaterialization(context, failureFromError(error));
        throw new MaterializationCancelled();
      }
      failMaterialization(context, {
        code: "materialization-failed",
        phase: "verification",
        quantity: null,
      });
      throw new MaterializationCancelled();
    }
    digest = await streamBatchBlob(entry, handle, reader, context);
    if (context.controller.signal.aborted) throw new MaterializationCancelled();
  } finally {
    context.blobInFlight = false;
    await handle.close();
  }
  if (context.controller.signal.aborted) throw new MaterializationCancelled();
  const metadata = await awaitMaterializationReadOnly(
    () => lstat(absolute, { bigint: true }),
    context,
    "verification",
  );
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size !== entry.size
  ) {
    failMaterialization(context, {
      code: "materialization-failed",
      phase: "verification",
      quantity: null,
    });
    throw new MaterializationCancelled();
  }
  context.allocatedScratchBytes += metadata.blocks * 512n;
  if (context.allocatedScratchBytes > BigInt(context.limits.maxScratchBytes)) {
    failMaterialization(
      context,
      limitFailure(
        context.clock,
        "maxScratchBytes",
        "scratch-space-limit",
        "materialization",
        "bytes",
        context.allocatedScratchBytes,
      ),
    );
    throw new MaterializationCancelled();
  }
  return digest;
}

async function streamBatchBlob(
  entry: TrackedTreeEntry & { size: bigint },
  output: Awaited<ReturnType<typeof open>>,
  reader: GitBatchStdout,
  context: MaterializationContext,
): Promise<string> {
  const header = await reader.readLine();
  if (context.controller.signal.aborted) throw new MaterializationCancelled();
  recordExportProgress(context.clock);
  if (header === null) {
    failMaterialization(context, {
      code: "git-blob-failed",
      phase: "materialization",
      quantity: null,
    });
    throw new MaterializationCancelled();
  }
  if (header.endsWith(" missing")) {
    failMaterialization(context, {
      code: "git-blob-failed",
      phase: "materialization",
      quantity: null,
    });
    throw new MaterializationCancelled();
  }
  const match = /^([0-9a-f]{40,64}) blob (\d+)$/u.exec(header);
  if (match === null || match[1] !== entry.objectId || BigInt(match[2]!) !== entry.size) {
    failMaterialization(context, {
      code: "git-blob-failed",
      phase: "materialization",
      quantity: null,
    });
    throw new MaterializationCancelled();
  }
  const digest = createHash("sha256");
  let written = 0n;
  await reader.readInto(entry.size, async (bytes) => {
    if (context.controller.signal.aborted) throw new MaterializationCancelled();
    const nextAggregateBytes = context.writtenBytes + BigInt(bytes.byteLength);
    if (nextAggregateBytes > BigInt(context.limits.maxAggregateBytes)) {
      failMaterialization(
        context,
        limitFailure(
          context.clock,
          "maxAggregateBytes",
          "aggregate-byte-limit",
          "materialization",
          "bytes",
          nextAggregateBytes,
        ),
      );
      throw new MaterializationCancelled();
    }
    if (nextAggregateBytes > BigInt(context.limits.maxScratchBytes)) {
      failMaterialization(
        context,
        limitFailure(
          context.clock,
          "maxScratchBytes",
          "scratch-space-limit",
          "materialization",
          "bytes",
          nextAggregateBytes,
        ),
      );
      throw new MaterializationCancelled();
    }
    const start = Number(written);
    written += BigInt(bytes.byteLength);
    context.writtenBytes = nextAggregateBytes;
    digest.update(bytes);
    await writeAll(output, bytes, start, context.controller.signal);
    recordExportProgress(context.clock);
  });
  const trailer = await reader.readBytes(1);
  if (trailer[0] !== 0x0a) {
    failMaterialization(context, {
      code: "git-blob-failed",
      phase: "materialization",
      quantity: null,
    });
    throw new MaterializationCancelled();
  }
  if (written !== entry.size) {
    failMaterialization(context, {
      code: "materialization-failed",
      phase: "verification",
      quantity: null,
    });
    throw new MaterializationCancelled();
  }
  return digest.digest("hex");
}

class GitBatchStdout {
  private leftover: Buffer = Buffer.alloc(0);
  private readonly stdout: Readable;

  public constructor(stdout: Readable) {
    this.stdout = stdout;
  }

  public async readLine(): Promise<string | null> {
    while (true) {
      const idx = this.leftover.indexOf(0x0a);
      if (idx >= 0) {
        const line = this.leftover.subarray(0, idx).toString("utf8");
        this.leftover = Buffer.from(this.leftover.subarray(idx + 1));
        return line;
      }
      const next = await this.readChunk();
      if (next === null) {
        if (this.leftover.byteLength === 0) return null;
        const line = this.leftover.toString("utf8");
        this.leftover = Buffer.alloc(0);
        return line;
      }
      this.leftover =
        this.leftover.byteLength === 0 ? Buffer.from(next) : Buffer.concat([this.leftover, next]);
    }
  }

  public async readBytes(count: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let remaining = count;
    while (remaining > 0) {
      if (this.leftover.byteLength === 0) {
        const next = await this.readChunk();
        if (next === null) {
          throw new Error("Git cat-file --batch ended before the expected blob bytes.");
        }
        this.leftover = Buffer.from(next);
      }
      const take = Math.min(remaining, this.leftover.byteLength);
      chunks.push(Buffer.from(this.leftover.subarray(0, take)));
      this.leftover = Buffer.from(this.leftover.subarray(take));
      remaining -= take;
    }
    return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
  }

  public async readInto(size: bigint, write: (bytes: Buffer) => Promise<void>): Promise<void> {
    let remaining = size;
    while (remaining > 0n) {
      if (this.leftover.byteLength === 0) {
        const next = await this.readChunk();
        if (next === null) {
          throw new Error("Git cat-file --batch ended before the expected blob bytes.");
        }
        this.leftover = Buffer.from(next);
      }
      const cap = remaining > 1_048_576n ? 1_048_576 : Number(remaining);
      const take = Math.min(this.leftover.byteLength, cap);
      const slice = Buffer.from(this.leftover.subarray(0, take));
      this.leftover = Buffer.from(this.leftover.subarray(take));
      remaining -= BigInt(take);
      await write(slice);
    }
  }

  private readChunk(): Promise<Buffer | null> {
    const stdout = this.stdout;
    return new Promise((resolve, reject) => {
      if (stdout.readableEnded) {
        resolve(null);
        return;
      }
      const tryRead = (): boolean => {
        const data = stdout.read() as Buffer | string | null;
        if (data === null) return false;
        resolve(Buffer.isBuffer(data) ? data : Buffer.from(data));
        return true;
      };
      if (tryRead()) return;
      const onReadable = (): void => {
        if (tryRead()) cleanup();
      };
      const onEnd = (): void => {
        cleanup();
        resolve(null);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const cleanup = (): void => {
        stdout.off("readable", onReadable);
        stdout.off("end", onEnd);
        stdout.off("error", onError);
      };
      stdout.once("readable", onReadable);
      stdout.once("end", onEnd);
      stdout.once("error", onError);
    });
  }
}

function writeStdinLine(stdin: NodeJS.WritableStream, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stdin.write(line, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function writeAll(
  output: Awaited<ReturnType<typeof open>>,
  bytes: Buffer,
  start: number,
  signal: AbortSignal,
  onWriteProgress?: () => void,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const write = await output.write(bytes, offset, bytes.byteLength - offset, start + offset);
    if (write.bytesWritten === 0) throw new Error("write-failed");
    offset += write.bytesWritten;
    onWriteProgress?.();
    if (signal.aborted) throw new MaterializationCancelled();
  }
}

async function awaitMaterializationReadOnly<T>(
  operation: () => Promise<T>,
  context: MaterializationContext,
  phase: ExportPhase,
): Promise<T> {
  try {
    return await awaitReadOnlyWithinStall(operation, context.clock, phase);
  } catch (error) {
    if (
      error instanceof RepositoryWorkspaceMaterializationError &&
      error.evidence.code === "aggregate-timeout"
    ) {
      failMaterialization(context, failureFromError(error));
      throw new MaterializationCancelled();
    }
    throw error;
  }
}

function failMaterialization(
  context: MaterializationContext,
  failure: MaterializationFailureDescriptor,
): void {
  if (context.firstFailure !== undefined) return;
  context.firstFailure = failure;
  context.controller.abort();
  for (const child of context.activeChildren) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    if (child.kill("SIGKILL")) context.cancellationRequested += 1;
  }
}

async function captureTrackedEntries(
  workspacePath: string,
  treeEntries: readonly TrackedTreeEntry[],
  blobDigests: ReadonlyMap<string, string>,
  clock: ExportClock,
): Promise<Map<string, TrackedWorkspaceEntry>> {
  const entries = new Map<string, TrackedWorkspaceEntry>();
  for (const treeEntry of treeEntries) {
    assertExportProgressing(clock, "verification");
    if (treeEntry.kind !== "regular") {
      // These Git entries were intentionally not exported. A host alias to a
      // regular file or an implicit directory would otherwise be registered as
      // an absent endpoint and produce a changed workspace on its first read.
      const omitted = join(workspacePath, ...treeEntry.path.split("/"));
      try {
        await awaitReadOnlyWithinStall(() => lstat(omitted), clock, "verification");
        throw materializationError({
          code: "filesystem-path-collision",
          phase: "verification",
          quantity: null,
        });
      } catch (error) {
        if (error instanceof RepositoryWorkspaceMaterializationError) throw error;
        if (!filesystemErrorCode(error, "ENOENT")) {
          if (filesystemErrorCode(error, "ENOTDIR")) {
            throw materializationError({
              code: "filesystem-path-collision",
              phase: "verification",
              quantity: null,
            });
          }
          throw error;
        }
      }
      entries.set(treeEntry.path, { path: treeEntry.path, kind: treeEntry.kind });
      recordExportProgress(clock);
      continue;
    }
    const absolute = join(workspacePath, ...treeEntry.path.split("/"));
    try {
      const digest = blobDigests.get(treeEntry.path);
      if (digest === undefined) {
        throw new Error("Git workspace preparation did not retain a blob digest.");
      }
      const metadata = await awaitReadOnlyWithinStall(
        () => lstat(absolute, { bigint: true }),
        clock,
        "verification",
      );
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.nlink !== 1n ||
        (await awaitReadOnlyWithinStall(() => realpath(absolute), clock, "verification")) !==
          absolute
      ) {
        throw new Error("Git workspace preparation rejected an unsafe exported file.");
      }
      if (treeEntry.size !== metadata.size) {
        throw new Error("Git workspace preparation materialized an invalid blob size.");
      }
      const expectedMode = treeEntry.executable ? 0o755n : 0o644n;
      if ((metadata.mode & 0o777n) !== expectedMode) {
        throw new Error("Git workspace preparation materialized an invalid blob mode.");
      }
      entries.set(treeEntry.path, {
        path: treeEntry.path,
        kind: "regular",
        objectId: treeEntry.objectId,
        digest,
        size: metadata.size,
        device: metadata.dev,
        inode: metadata.ino,
        mode: metadata.mode & 0o777n,
        modifiedNs: metadata.mtimeNs,
        changedNs: metadata.ctimeNs,
      });
    } catch (error) {
      throw error;
    }
  }
  assertExportProgressing(clock, "verification");
  return entries;
}

function safeTrackedPath(path: string): boolean {
  return (
    Boolean(path) &&
    !/[\uD800-\uDFFF]/u.test(path) &&
    !path.includes("\\") &&
    !/[\0-\x1f\x7f]/u.test(path) &&
    path.split("/").every((part) => Boolean(part) && part !== "." && part !== "..")
  );
}
