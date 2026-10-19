// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { OperationalLimitError, type ResolvedLimit } from "../config/limits.js";
import {
  repositoryEvidenceGitLimits,
  type RepositoryEvidenceGitLimitsV1,
} from "../config/repository-evidence-limits.js";
import { isNodeError } from "../shared/primitives.js";
import { ensurePrivateStateDirectory, PrivateStateError } from "../shared/private-state.js";
import { assertRunNotTombstoned, withRunMaintenanceGate } from "../records/run-maintenance-gate.js";
import {
  RepositoryEvidenceProvenanceError,
  type RepositoryCandidateArtifactKind,
  type RepositoryEvidenceCollector,
  type RepositoryEvidenceContext,
} from "./contracts.js";
import type { ChangeEvidence, ChangedFileEvidence } from "../impact/contracts.js";

const execFileAsync = promisify(execFile);
export const GIT_BINARY = process.platform === "win32" ? "git" : "/usr/bin/git";

/** Per-command config that disables hooks, filters, external diff, and pagers. */
export const SAFE_GIT_CONFIG = [
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
  "pager.diff=false",
  // A commit on a large tree would otherwise start a detached `git gc` or
  // `git maintenance` in the private evidence repository. Its repack writes
  // into that repository while `dispose()` deletes it, and the delete fails
  // with ENOTEMPTY, which replaces the run's own result.
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
] as const;

/** No user or system config, credential prompt, or network protocol for host Git. */
export function credentialFreeGitEnvironment(): NodeJS.ProcessEnv {
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

/**
 * A workspace-evidence git command crossed an operational limit: it ran longer
 * than `repository.evidenceGitTimeoutMs`, or wrote more than
 * `repository.evidenceGitOutputMaxBytes` to one output stream. The code is the
 * limit's catalog refusal, so the stop is classified `bound`. The message names
 * the limit, the observed value, how to raise it, and which git operation hit it.
 */
export class RepositoryEvidenceLimitError extends OperationalLimitError {
  public readonly operation: string;

  public constructor(limit: ResolvedLimit, observed: number, operation: string) {
    super(limit, observed);
    this.operation = operation;
    this.message = `${this.message} Scope: git ${operation} while recording the run's workspace evidence.`;
  }
}

/** The git subcommand an argument list runs, for a refusal's scope. */
function gitOperation(args: readonly string[]): string {
  return args.find((arg) => !arg.startsWith("-")) ?? "command";
}

function changedFileStatus(code: string): ChangedFileEvidence["status"] {
  if (code === "A") return "added";
  if (code === "M" || code === "T") return "modified";
  if (code === "D") return "deleted";
  if (code === "R") return "renamed";
  if (code === "C") return "copied";
  return "unknown";
}

function parseNameStatus(output: string): ChangedFileEvidence[] {
  const tokens = output.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const files: ChangedFileEvidence[] = [];
  for (let index = 0; index < tokens.length; ) {
    const rawStatus = tokens[index++];
    if (!rawStatus) throw new Error("Git returned malformed change evidence.");
    const status = changedFileStatus(rawStatus[0] ?? "");
    if (status === "renamed" || status === "copied") {
      const previousPath = tokens[index++];
      const path = tokens[index++];
      if (!previousPath || !path) {
        throw new Error("Git returned malformed rename or copy evidence.");
      }
      files.push({ path, previousPath, status });
      continue;
    }
    const path = tokens[index++];
    if (!path) throw new Error("Git returned malformed path evidence.");
    files.push({ path, status });
  }
  return files;
}

function lineCount(value: string): number {
  if (!value) return 0;
  return value.endsWith("\n") ? value.split("\n").length - 1 : value.split("\n").length;
}

interface DiffAgainstBaselineResult {
  body: string;
  provenanceViolation: boolean;
}

/**
 * Diffs the workspace against its export through an external Git directory. The
 * model workspace never gets Git metadata; the source repository is never touched.
 */
export class GitPatchEvidenceCollector implements RepositoryEvidenceCollector {
  private disposed = false;
  private runtimeBaselineAdvanced = false;
  private runtimeBaselinePaths: readonly string[] = [];
  private sourceBaselineRef = "";

  private constructor(
    private readonly workspacePath: string,
    private readonly artifactDirectory: string,
    private readonly temporaryRoot: string,
    private readonly gitDirectory: string,
    private readonly limits: RepositoryEvidenceGitLimitsV1,
  ) {}

  public static async create(
    workspacePath: string,
    artifactDirectory: string,
    limits: RepositoryEvidenceGitLimitsV1 = repositoryEvidenceGitLimits(),
  ): Promise<GitPatchEvidenceCollector> {
    // Resolved once, before any scratch exists, so an invalid host override
    // refuses here and every command of this run's evidence uses one value.
    const temporaryRoot = await mkdtemp(join(tmpdir(), "docsfab-evidence-"));
    const gitDirectory = join(temporaryRoot, "git");
    await mkdir(gitDirectory);
    const collector = new GitPatchEvidenceCollector(
      workspacePath,
      artifactDirectory,
      temporaryRoot,
      gitDirectory,
      limits,
    );
    try {
      await collector.git(["init", "--quiet"]);
      await collector.git(["config", "user.name", "DocsFab"]);
      await collector.git(["config", "user.email", "docsfab@example.invalid"]);
      await collector.git(["config", "commit.gpgsign", "false"]);
      await collector.git(["add", "--all", "--force", "--", "."]);
      await collector.git(["commit", "--quiet", "--allow-empty", "-m", "baseline"]);
      const sourceBaselineRef = (await collector.git(["rev-parse", "HEAD"])).trim();
      collector.sourceBaselineRef = sourceBaselineRef;
      return collector;
    } catch (error) {
      await collector.dispose();
      throw error;
    }
  }

  public async capture(context: RepositoryEvidenceContext): Promise<ChangeEvidence> {
    if (this.disposed) throw new Error("Evidence collector has been disposed.");
    if (context.workspacePath !== this.workspacePath) {
      throw new Error("Evidence collector received an unexpected workspace.");
    }
    const candidateArtifact = validateCandidateArtifact(context.candidateArtifact);
    if (candidateArtifact !== undefined && !context.persistPatch) {
      throw new Error(
        "Candidate evidence requires durable patch persistence before immutable retention.",
      );
    }
    await this.git(["add", "--all", "--force", "--", "."]);
    const fileDiff = await this.diffAgainstBaseline([
      "--cached",
      "--name-status",
      "-z",
      "--find-renames",
      "--find-copies",
      "--find-copies-harder",
      "--no-ext-diff",
      "--no-textconv",
    ]);
    const files = parseNameStatus(fileDiff.body);
    if (!context.persistPatch) {
      const evidence = { files };
      if (fileDiff.provenanceViolation) throw new RepositoryEvidenceProvenanceError(evidence);
      return evidence;
    }

    const patchDiff = await this.diffAgainstBaseline([
      "--cached",
      "--binary",
      "--full-index",
      "--find-renames",
      "--find-copies",
      "--find-copies-harder",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
    ]);
    const patchBody = patchDiff.body;
    const patch = Buffer.from(patchBody, "utf8");
    const artifactPath = await this.persistPatch(context.runId, patch, candidateArtifact);
    const evidence = {
      files,
      patch: {
        sha256: createHash("sha256").update(patch).digest("hex"),
        byteLength: patch.byteLength,
        lineCount: lineCount(patchBody),
        artifactPath,
        format: "git-diff" as const,
      },
    };
    if (fileDiff.provenanceViolation || patchDiff.provenanceViolation) {
      throw new RepositoryEvidenceProvenanceError(evidence);
    }
    return evidence;
  }

  /**
   * Advances the private baseline for host-owned bookkeeping paths. Workspace
   * bytes and other pending changes are untouched; later edits are still captured.
   */
  public async advanceBaselineForRuntimeChanges(paths: readonly string[]): Promise<void> {
    if (this.disposed) {
      throw new Error(
        "Evidence collector cannot advance its runtime baseline after being disposed.",
      );
    }
    if (this.runtimeBaselineAdvanced) {
      throw new Error(
        "Evidence collector runtime baseline is already advanced and cannot advance again.",
      );
    }
    const uniquePaths = validateRuntimeBaselinePaths(paths);
    this.runtimeBaselineAdvanced = true;

    // An earlier capture may have staged the whole workspace. Reset only the
    // private index, never workspace content.
    await this.git(["reset", "--quiet", "HEAD"]);
    await this.git(["--literal-pathspecs", "add", "--all", "--force", "--", ...uniquePaths]);
    const files = parseNameStatus(
      await this.git([
        "diff",
        "--cached",
        "--name-status",
        "-z",
        "--find-renames",
        "--find-copies",
        "--find-copies-harder",
        "--no-ext-diff",
        "--no-textconv",
        "HEAD",
        "--",
      ]),
    );
    const allowed = new Set(uniquePaths);
    if (
      files.some(
        (file) => !allowed.has(file.path) || (file.previousPath && !allowed.has(file.previousPath)),
      )
    ) {
      throw new Error("Evidence collector runtime baseline included an unexpected path.");
    }
    await this.git(["commit", "--quiet", "--allow-empty", "-m", "runtime bookkeeping baseline"]);
    this.runtimeBaselinePaths = Object.freeze([...uniquePaths]);
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await rm(this.temporaryRoot, { recursive: true, force: true });
  }

  /**
   * A git killed by SIGKILL cannot remove the index lock it holds, and the next
   * evidence command would fail on it ("index.lock: File exists"). The killed
   * child has exited and the private repository has no other writer, so the
   * lock is stale.
   */
  private async releaseIndexLock(): Promise<void> {
    await rm(join(this.gitDirectory, "index.lock"), { force: true });
  }

  /**
   * Run one evidence git command under the two catalog limits. It may run for
   * exactly `repository.evidenceGitTimeoutMs`; one millisecond more stops it.
   * Each output stream may carry exactly `repository.evidenceGitOutputMaxBytes`;
   * one byte more stops it. Either stop kills the child with SIGKILL. The coded
   * refusal naming the limit is thrown only after the child has exited and its
   * index lock is gone, so no evidence git outlives its refusal, races
   * `dispose()`, or blocks the collector's next command.
   */
  private async git(args: string[]): Promise<string> {
    const { timeoutMs, outputMaxBytes } = this.limits;
    const startedAt = performance.now();
    const pending = execFileAsync(
      GIT_BINARY,
      [
        ...SAFE_GIT_CONFIG,
        `--git-dir=${this.gitDirectory}`,
        `--work-tree=${this.workspacePath}`,
        ...args,
      ],
      {
        encoding: "utf8",
        maxBuffer: outputMaxBytes.value,
        killSignal: "SIGKILL",
        env: credentialFreeGitEnvironment(),
      },
    );
    // Set when the timer stops the command. execFile settles only once the
    // killed child has exited and its output has closed.
    let stoppedAfterMs: number | undefined;
    const timer = setTimeout(() => {
      // The timer fires no sooner than the limit plus one by its own clock, so
      // that is the least it reports, even when `performance.now` reads lower.
      const elapsedMs = Math.max(Math.floor(performance.now() - startedAt), timeoutMs.value + 1);
      // kill() is false once the child has exited; that exit keeps its own result.
      if (!pending.child.kill("SIGKILL")) return;
      stoppedAfterMs = elapsedMs;
    }, timeoutMs.value + 1);
    pending.child.once("exit", (_code, signal) => {
      // Once the timer's SIGKILL has ended the child, its output no longer
      // counts, and a grandchild that inherited the pipes must not hold the
      // refusal back. A child that exited on its own keeps all of its output.
      if (stoppedAfterMs === undefined || signal !== "SIGKILL") return;
      pending.child.stdout?.destroy();
      pending.child.stderr?.destroy();
    });
    // Counted the way Node counts against maxBuffer (bytes, on each stream), so
    // an overflow reports the bytes actually received.
    const received = { stdout: 0, stderr: 0 };
    pending.child.stdout?.on("data", (chunk: string) => {
      received.stdout += Buffer.byteLength(chunk, "utf8");
    });
    pending.child.stderr?.on("data", (chunk: string) => {
      received.stderr += Buffer.byteLength(chunk, "utf8");
    });
    try {
      return (await pending).stdout;
    } catch (error) {
      // Only a child that died of the timer's SIGKILL timed out. One that
      // exited on its own as the timer fired keeps its own failure.
      if (stoppedAfterMs !== undefined && pending.child.signalCode === "SIGKILL") {
        await this.releaseIndexLock();
        throw new RepositoryEvidenceLimitError(timeoutMs, stoppedAfterMs, gitOperation(args));
      }
      if (isNodeError(error, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")) {
        await this.releaseIndexLock();
        // Node stops the child once one stream passes the bound, so at least
        // the bound plus one byte arrived on it.
        throw new RepositoryEvidenceLimitError(
          outputMaxBytes,
          Math.max(received.stdout, received.stderr, outputMaxBytes.value + 1),
          gitOperation(args),
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Keeps host-owned paths visible when they change after the trusted baseline,
   * but excludes their hidden baseline bytes from rename/copy source discovery.
   */
  private async diffAgainstBaseline(args: readonly string[]): Promise<DiffAgainstBaselineResult> {
    const excludedRuntimePaths = this.runtimeBaselinePaths.map(
      (path) => `:(top,literal,exclude)${path}`,
    );
    const ordinary = await this.git(["diff", ...args, "HEAD", "--", ...excludedRuntimePaths]);
    if (this.runtimeBaselinePaths.length === 0) {
      return { body: ordinary, provenanceViolation: false };
    }

    const runtimeChanges = parseNameStatus(
      await this.git([
        "--literal-pathspecs",
        "diff",
        "--cached",
        "--name-status",
        "-z",
        "--no-renames",
        "HEAD",
        "--",
        ...this.runtimeBaselinePaths,
      ]),
    );
    if (runtimeChanges.length === 0) {
      return { body: ordinary, provenanceViolation: false };
    }

    const changedRuntimePaths = [...new Set(runtimeChanges.map((file) => file.path))];

    // The baseline holds host bookkeeping bytes, so it cannot be a patch's left
    // side. Render reserved paths against the source snapshot; the baseline only
    // detects changes.
    const sourceChanges = parseNameStatus(
      await this.git([
        "--literal-pathspecs",
        "diff",
        "--cached",
        "--name-status",
        "-z",
        "--no-renames",
        this.sourceBaselineRef,
        "--",
        ...changedRuntimePaths,
      ]),
    );
    const sourceChangePaths = new Set(sourceChanges.map((file) => file.path));
    const representablePaths = changedRuntimePaths.filter((path) => sourceChangePaths.has(path));
    const provenanceViolation = representablePaths.length !== changedRuntimePaths.length;

    if (representablePaths.length === 0) {
      return { body: ordinary, provenanceViolation };
    }

    const runtime = await this.git([
      "--literal-pathspecs",
      "diff",
      ...args,
      "--no-renames",
      this.sourceBaselineRef,
      "--",
      ...representablePaths,
    ]);
    return { body: `${ordinary}${runtime}`, provenanceViolation };
  }

  private async persistPatch(
    runId: string,
    patch: Buffer,
    candidateArtifact?: RepositoryCandidateArtifactKind,
  ): Promise<string> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
      throw new Error("Run identifier cannot be used as an artifact name.");
    }
    await ensurePrivateStateDirectory(this.artifactDirectory);
    return withRunMaintenanceGate(this.artifactDirectory, async () => {
      await assertRunNotTombstoned(this.artifactDirectory, runId);
      return this.persistPatchUnderGate(runId, patch, candidateArtifact);
    });
  }

  private async persistPatchUnderGate(
    runId: string,
    patch: Buffer,
    candidateArtifact?: RepositoryCandidateArtifactKind,
  ): Promise<string> {
    const destination = join(
      this.artifactDirectory,
      candidateArtifact === undefined ? `${runId}.patch` : `${runId}.${candidateArtifact}.patch`,
    );
    if (candidateArtifact !== undefined) {
      return persistImmutablePatch(destination, patch);
    }
    const before = await inspectPrivatePatchFile(destination);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, patch, { mode: 0o600, flag: "wx" });
      await ensurePrivateStateDirectory(this.artifactDirectory);
      await assertPatchDestinationUnchanged(destination, before);
      await rename(temporary, destination);
      return destination;
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

type PatchFileIdentity = { dev: number; ino: number; uid: number; mode: number };

function privatePatchStat(stat: Stats, path: string): PatchFileIdentity {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o7777) !== 0o600
  ) {
    throw new PrivateStateError(path);
  }
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode };
}

async function inspectPrivatePatchFile(path: string): Promise<PatchFileIdentity | undefined> {
  const entry = await lstat(path).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!entry) return undefined;
  const pinned = privatePatchStat(entry, path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const descriptor = privatePatchStat(await handle.stat(), path);
    if (
      descriptor.dev !== pinned.dev ||
      descriptor.ino !== pinned.ino ||
      descriptor.uid !== pinned.uid ||
      descriptor.mode !== pinned.mode
    ) {
      throw new PrivateStateError(path);
    }
    return pinned;
  } finally {
    await handle.close();
  }
}

async function assertPatchDestinationUnchanged(
  path: string,
  expected: PatchFileIdentity | undefined,
): Promise<void> {
  const current = await inspectPrivatePatchFile(path);
  if (
    (current === undefined) !== (expected === undefined) ||
    (current &&
      expected &&
      (current.dev !== expected.dev ||
        current.ino !== expected.ino ||
        current.uid !== expected.uid ||
        current.mode !== expected.mode))
  ) {
    throw new PrivateStateError(path);
  }
}

async function readPrivatePatchFile(path: string): Promise<Buffer> {
  const expected = await inspectPrivatePatchFile(path);
  if (!expected) throw new PrivateStateError(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = privatePatchStat(await handle.stat(), path);
    if (actual.dev !== expected.dev || actual.ino !== expected.ino)
      throw new PrivateStateError(path);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function validateCandidateArtifact(value: unknown): RepositoryCandidateArtifactKind | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, "kind")
  ) {
    throw new Error("Candidate artifact identity has a malformed closed host-controlled shape.");
  }
  const kind = (value as { kind?: unknown }).kind;
  if (kind !== "candidate0" && kind !== "candidate1" && kind !== "failed-partial") {
    throw new Error("Candidate artifact identity uses an unsupported closed host-controlled kind.");
  }
  return kind;
}

async function persistImmutablePatch(destination: string, patch: Buffer): Promise<string> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, patch, { mode: 0o600, flag: "wx" });
    await ensurePrivateStateDirectory(dirname(destination));
    await link(temporary, destination);
    return destination;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      const existing = await readPrivatePatchFile(destination);
      if (existing.equals(patch)) return destination;
      throw new Error(
        "Immutable candidate patch artifact cannot be overwritten with different bytes.",
      );
    }
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

function validateRuntimeBaselinePaths(paths: readonly string[]): string[] {
  if (paths.length === 0) {
    throw new Error("Evidence collector runtime baseline requires at least one path.");
  }
  const unique = new Set<string>();
  for (const path of paths) {
    if (
      path !== path.normalize("NFC") ||
      path.includes("\0") ||
      path.includes("\\") ||
      isAbsolute(path) ||
      /^[A-Za-z]:/u.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(
        "Evidence collector runtime baseline requires safe repository-relative paths.",
      );
    }
    if (unique.has(path)) {
      throw new Error("Evidence collector runtime baseline paths must be unique.");
    }
    unique.add(path);
  }
  return [...unique];
}
