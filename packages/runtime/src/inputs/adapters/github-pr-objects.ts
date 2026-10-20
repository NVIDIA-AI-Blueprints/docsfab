// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Private, disposable Git object reader for an explicitly verified public PR. */
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import {
  limit,
  refuseLimit,
  type ResolveLimitsOptions,
  type ResolvedLimit,
} from "../../config/limits.js";
import { objectId, parseCommit } from "../change-source/objects.js";
import { canonicalDigest } from "../../content-ir/canonical.js";
import { isExportExcluded } from "../../repository/workspace/export-exclusion.js";
import { GithubPackPreflightError, preflightGithubPack } from "./github-pr-pack.js";
import {
  createGithubPrTransport,
  githubPrLimits,
  type GithubPrFetchPort,
  type GithubPrLimits,
  type GithubPrRepositoryScope,
  type GithubPrTransport,
  type GithubPrTransportBudget,
} from "./github-pr-transport.js";

const SHA1 = /^[0-9a-f]{40}$/u;
const ZERO = "0".repeat(40);
const GIT_PATH = "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin";
const GIT_ENV = {
  PATH: GIT_PATH,
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_LFS_SKIP_SMUDGE: "1",
} as const;
const GIT_HARDENING = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.autocrlf=false",
  "-c",
  "diff.external=",
  "-c",
  "diff.trustExitCode=false",
  "-c",
  "filter.lfs.smudge=",
  "-c",
  "protocol.file.allow=never",
  "-c",
  "core.useReplaceRefs=false",
  "-c",
  "fetch.writeCommitGraph=false",
] as const;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class GithubPrObjectError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "GithubPrObjectError";
  }
}

function fail(code: string): never {
  throw new GithubPrObjectError(code);
}

function oid(id: string): string {
  if (!SHA1.test(id)) fail("github-pr-object-id-invalid");
  return id;
}

function strictUtf8(value: Buffer): string {
  try {
    return UTF8.decode(value);
  } catch {
    return fail("github-pr-path-encoding-unsupported");
  }
}

export interface GithubPrVerifiedScope {
  /** Trusted caller binds these names to stable, public repository IDs before construction. */
  readonly target: GithubPrRepositoryScope & { readonly repositoryId: number };
  readonly headRepository: GithubPrRepositoryScope & { readonly repositoryId: number };
  readonly baseTip: string;
  readonly headTip: string;
  readonly workspaceRoot: string;
}

export interface GithubPrAcquisitionMetrics {
  readonly responseBytes: number;
  readonly packInflatedBytes: number;
  readonly objectMaterializedBytes: number;
  readonly objects: number;
  readonly historyCommits: number;
  readonly elapsedMs: number;
  readonly effectiveLimits: Readonly<Record<string, number>>;
}

export interface GithubPrGraph {
  readonly B: string;
  readonly H: string;
  readonly M: string;
  readonly baseTree: string;
  readonly headTree: string;
  readonly mergeTree: string;
  readonly proposalCommits: number;
  readonly historyCommits: number;
  readonly complete: true;
}

export interface GithubPrManifestRow {
  readonly status: string;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldId: string | null;
  readonly newId: string | null;
  readonly content: "regular" | "symlink" | "gitlink" | "unsupported";
}

/** One entry authenticated by the original bounded Git object reader. */
export interface GithubPrVerifiedTreeEntry {
  readonly path: string;
  readonly mode: "100644" | "100755" | "120000" | "160000";
  readonly objectId: string;
  readonly byteLength: number | null;
}

/** Callback-local private reader port; serializable fields confer no authority. */
export interface GithubPrVerifiedTreeExportPort {
  readonly sourcePath: string;
  readonly targetRepositoryId: number;
  readonly headRepositoryId: number;
  readonly B: string;
  readonly H: string;
  readonly M: string;
  readonly baseTree: string;
  readonly headTree: string;
  readonly headEntriesSha256: string;
  readonly manifestSha256: string;
  readonly sourceIdentitySha256: string;
  readonly headEntries: readonly GithubPrVerifiedTreeEntry[];
  readonly baseDocumentation: readonly GithubPrVerifiedTreeEntry[];
  /** The reader acquisition/export signal, ending at callback admission. */
  readonly signal: AbortSignal;
  checkActive(): void;
  readVerifiedBlob(entry: GithubPrVerifiedTreeEntry, onProgress?: () => void): Promise<Buffer>;
  /** Cancel in-flight verified reads before their private Git root is removed. */
  cancel(): void;
}

const verifiedExports = new WeakSet<object>();
export function assertGithubPrVerifiedTreeExportPort(value: GithubPrVerifiedTreeExportPort): void {
  if (!verifiedExports.has(value)) fail("github-pr-verified-tree-authority-required");
}

export interface GithubPrObjectReader {
  readonly acquireTips: () => Promise<void>;
  readonly resolveGraph: () => Promise<GithubPrGraph>;
  readonly acquireTreesAndBlobs: () => Promise<readonly GithubPrManifestRow[]>;
  readonly readObject: (id: string, type: "commit" | "tree" | "blob") => Promise<Buffer>;
  readonly enumerate: () => Promise<readonly GithubPrManifestRow[]>;
  readonly exportVerifiedHeadTree: () => Promise<GithubPrVerifiedTreeExportPort>;
  readonly measurements: () => GithubPrAcquisitionMetrics;
  readonly dispose: () => Promise<void>;
}

interface GitResult {
  readonly status: number;
  readonly stdout: Buffer;
  readonly stderrBytes: number;
}

interface GitInput {
  readonly input?: Buffer;
  readonly inputFile?: string;
  readonly maxOutput: ResolvedLimit | number;
  readonly allowFailure?: boolean;
  readonly onOutputProgress?: () => void;
}

/** No caller environment, Git config, alternate object store, askpass, or credentials enter this process. */
export async function runIsolatedGithubGit(
  home: string,
  gitDir: string | null,
  args: readonly string[],
  options: GitInput,
  signal: AbortSignal,
): Promise<GitResult> {
  const env: NodeJS.ProcessEnv = {
    ...GIT_ENV,
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const argv = [...GIT_HARDENING, ...(gitDir === null ? [] : ["--git-dir", gitDir]), ...args];
  if (signal.aborted) fail("github-pr-cancelled");
  return new Promise((resolve, reject) => {
    const child = spawn("git", argv, {
      env,
      cwd: home,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const maxOutput =
      typeof options.maxOutput === "number" ? options.maxOutput : options.maxOutput.value;
    function outputError(observed: number): Error {
      if (typeof options.maxOutput === "number")
        return new GithubPrObjectError("github-pr-object-output-truncated");
      try {
        refuseLimit(options.maxOutput, observed);
      } catch (error) {
        const refusal = error as Error;
        refusal.message += " Scope: isolated Git subprocess combined stdout and stderr.";
        return refusal;
      }
    }
    let outputLength = 0;
    let stderrLength = 0;
    let fatal: Error | null = null;
    const killAfter = (error: Error) => {
      if (fatal !== null) return;
      fatal = error;
      child.kill("SIGKILL");
    };
    const abort = () => killAfter(new GithubPrObjectError("github-pr-cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      outputLength += chunk.length;
      const observed = outputLength + stderrLength;
      if (observed > maxOutput || !Number.isSafeInteger(observed)) {
        killAfter(outputError(observed));
      } else {
        stdout.push(chunk);
        try {
          options.onOutputProgress?.();
        } catch (error) {
          killAfter(
            error instanceof Error
              ? error
              : new GithubPrObjectError("github-pr-read-progress-failed"),
          );
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrLength += chunk.length;
      const observed = outputLength + stderrLength;
      if (observed > maxOutput || !Number.isSafeInteger(observed)) killAfter(outputError(observed));
      // Git diagnostics are intentionally discarded: untrusted object paths can appear there.
    });
    child.on("error", () => killAfter(new GithubPrObjectError("github-pr-git-unavailable")));
    child.stdin.on("error", () => killAfter(new GithubPrObjectError("github-pr-git-input-failed")));
    child.on("close", (status) => {
      signal.removeEventListener("abort", abort);
      if (fatal !== null) {
        reject(fatal);
      } else if (status !== 0 && !options.allowFailure) {
        reject(new GithubPrObjectError("github-pr-git-failed"));
      } else {
        resolve({
          status: status ?? -1,
          stdout: Buffer.concat(stdout, outputLength),
          stderrBytes: stderrLength,
        });
      }
    });
    if (options.inputFile !== undefined) {
      const source = createReadStream(options.inputFile);
      source.on("error", () =>
        killAfter(new GithubPrObjectError("github-pr-quarantine-read-failed")),
      );
      source.pipe(child.stdin);
    } else {
      child.stdin.end(options.input);
    }
  });
}

function parseRawManifest(
  output: Buffer,
  filesLimit: ResolvedLimit,
  renames: boolean,
): GithubPrManifestRow[] {
  const rows: GithubPrManifestRow[] = [];
  let additions = 0;
  let deletions = 0;
  let unchangedRows = 0;
  let at = 0;
  while (at < output.length) {
    const end = output.indexOf(0, at);
    if (end < 0) fail("github-pr-manifest-truncated");
    const header = output.toString("ascii", at, end);
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z][0-9]*)$/u.exec(
      header,
    );
    if (!match) fail("github-pr-manifest-invalid");
    at = end + 1;
    const firstEnd = output.indexOf(0, at);
    if (firstEnd < 0) fail("github-pr-manifest-truncated");
    const firstPath = strictUtf8(output.subarray(at, firstEnd));
    if (firstPath.length === 0) fail("github-pr-manifest-invalid");
    at = firstEnd + 1;
    const status = match[5]!;
    let secondPath: string | null = null;
    if (status[0] === "R" || status[0] === "C") {
      const secondEnd = output.indexOf(0, at);
      if (secondEnd < 0) fail("github-pr-manifest-truncated");
      secondPath = strictUtf8(output.subarray(at, secondEnd));
      if (secondPath.length === 0) fail("github-pr-manifest-invalid");
      at = secondEnd + 1;
    }
    const oldMode = match[1]!;
    const newMode = match[2]!;
    const oldId = match[3] === ZERO ? null : match[3]!;
    const newId = match[4] === ZERO ? null : match[4]!;
    const modes = [oldMode, newMode].filter((mode) => mode !== "000000");
    const content = modes.some((mode) => mode === "160000")
      ? "gitlink"
      : modes.some((mode) => mode === "120000")
        ? "symlink"
        : modes.every((mode) => mode === "100644" || mode === "100755")
          ? "regular"
          : "unsupported";
    rows.push({
      status,
      oldPath: status[0] === "A" ? null : firstPath,
      newPath: status[0] === "D" ? null : (secondPath ?? firstPath),
      oldMode,
      newMode,
      oldId,
      newId,
      content,
    });
    if (renames) {
      if (rows.length > filesLimit.value) refuseLimit(filesLimit, rows.length);
    } else {
      if (status[0] === "A") additions++;
      else if (status[0] === "D") deletions++;
      else unchangedRows++;
      // With -M but no -B/-C, each rename can consume one A and one D.
      // This is a monotone lower bound on final rows, so valid renames are
      // never refused just because they occupy two provisional rows.
      const leastFinalRows = unchangedRows + Math.max(additions, deletions);
      if (leastFinalRows > filesLimit.value) refuseLimit(filesLimit, leastFinalRows);
    }
  }
  return rows;
}

function treeChildren(body: Buffer): readonly string[] {
  const children: string[] = [];
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(32, at);
    const nul = body.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > body.length) fail("github-pr-tree-invalid");
    const mode = body.toString("ascii", at, space);
    const name = strictUtf8(body.subarray(space + 1, nul));
    if (name.length === 0 || name.includes("/")) fail("github-pr-tree-invalid");
    if (mode === "40000" || mode === "040000") {
      children.push(body.subarray(nul + 1, nul + 21).toString("hex"));
    } else if (!["100644", "100755", "120000", "160000"].includes(mode)) {
      fail("github-pr-tree-mode-unsupported");
    }
    at = nul + 21;
  }
  return children;
}

function strictTreeRecords(body: Buffer): readonly { mode: string; name: string; id: string }[] {
  const records: { mode: string; name: string; id: string }[] = [];
  const names = new Set<string>();
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(32, at);
    const nul = space < 0 ? -1 : body.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > body.length) fail("github-pr-tree-invalid");
    const mode = body.toString("ascii", at, space);
    if (!["40000", "040000", "100644", "100755", "120000", "160000"].includes(mode))
      fail("github-pr-tree-mode-unsupported");
    const name = strictUtf8(body.subarray(space + 1, nul));
    if (
      !name ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\") ||
      /[\0-\x1f\x7f\uD800-\uDFFF]/u.test(name) ||
      names.has(name)
    )
      fail("github-pr-tree-invalid");
    names.add(name);
    const id = body.subarray(nul + 1, nul + 21).toString("hex");
    oid(id);
    records.push({ mode, name, id });
    at = nul + 21;
  }
  return records;
}

function parseLines(output: Buffer): string[] {
  if (output.length === 0) return [];
  const text = output.toString("ascii");
  if (!text.endsWith("\n")) fail("github-pr-git-output-truncated");
  return text.slice(0, -1).split("\n").filter(Boolean);
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

/** Create a host-only, disposable reader; serializable input cannot restore its network authority. */
export async function createGithubPrObjectReader(
  scope: GithubPrVerifiedScope,
  options: {
    readonly scratchRoot?: string;
    readonly limits?: ResolveLimitsOptions;
    readonly signal?: AbortSignal;
    /** Test host only: emulates HTTP around real upload-pack bytes, never changes production URLs. */
    readonly fetchPort?: GithubPrFetchPort;
    /** Test-only observation of local Git subcommands; confers no command authority. */
    readonly observeGit?: (args: readonly string[]) => void;
  } = {},
): Promise<GithubPrObjectReader> {
  oid(scope.baseTip);
  oid(scope.headTip);
  if (
    !Number.isSafeInteger(scope.target.repositoryId) ||
    scope.target.repositoryId < 1 ||
    !Number.isSafeInteger(scope.headRepository.repositoryId) ||
    scope.headRepository.repositoryId < 1
  )
    fail("github-pr-repository-id-invalid");
  const limits = githubPrLimits(options.limits);
  const gitOutputLimit = limit("hostInvoker.gitOutputMaxBytes", options.limits);
  const gitDefaultOutputLimit = limit("hostInvoker.gitDefaultOutputMaxBytes", options.limits);
  const gitTimeoutLimit = limit("hostInvoker.gitTimeoutMs", options.limits);
  const scratchRoot = await realpath(options.scratchRoot ?? tmpdir());
  const workspaceRoot = await realpath(scope.workspaceRoot);
  if (isWithin(workspaceRoot, scratchRoot)) fail("github-pr-scratch-inside-workspace");
  const started = performance.now();
  const deadlineAt = started + limits.acquisitionTimeoutMs.value;
  const deadlineSignal = AbortSignal.timeout(limits.acquisitionTimeoutMs.value);
  const readerAbort = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadlineSignal, readerAbort.signal])
    : AbortSignal.any([deadlineSignal, readerAbort.signal]);
  const home = await mkdtemp(join(scratchRoot, "docsfab-github-pr-"));
  const repoDir = join(home, "objects.git");
  const template = join(home, "empty-template");
  const budget: GithubPrTransportBudget = { admittedBytes: 0 };
  let inflatedBytes = 0;
  let materializedBytes = 0;
  let objects = 0;
  let historyCommits = 0;
  let graph: GithubPrGraph | null = null;
  let initialRows: GithubPrManifestRow[] | null = null;
  let finalRows: GithubPrManifestRow[] | null = null;
  let disposed = false;
  let initialized = false;
  let verifiedExport: GithubPrVerifiedTreeExportPort | null = null;
  const shallow = new Set<string>();
  const requestedGitmodules = new Set<string>();
  const transports = new Map<string, GithubPrTransport>();

  function ensureActive(): void {
    if (disposed) fail("github-pr-reader-disposed");
    if (options.signal?.aborted || readerAbort.signal.aborted) fail("github-pr-cancelled");
    if (deadlineSignal.aborted || performance.now() >= deadlineAt) {
      refuseLimit(limits.acquisitionTimeoutMs, Math.ceil(performance.now() - started));
    }
  }

  async function cleanup(): Promise<void> {
    if (disposed) return;
    disposed = true;
    readerAbort.abort();
    if (verifiedExport !== null) verifiedExports.delete(verifiedExport);
    await rm(home, { recursive: true, force: true });
  }

  async function guarded<T>(action: () => Promise<T>): Promise<T> {
    try {
      ensureActive();
      return await action();
    } catch (error) {
      await cleanup();
      if (deadlineSignal.aborted && !options.signal?.aborted) {
        refuseLimit(limits.acquisitionTimeoutMs, Math.ceil(performance.now() - started));
      }
      throw error;
    }
  }

  async function run(
    args: readonly string[],
    maxOutput: ResolvedLimit | number,
    input?: Buffer,
    inputFile?: string,
    allowFailure = false,
    onOutputProgress?: () => void,
  ): Promise<GitResult> {
    ensureActive();
    options.observeGit?.(args);
    const operationTimeout = AbortSignal.timeout(gitTimeoutLimit.value);
    try {
      return await runIsolatedGithubGit(
        home,
        repoDir,
        args,
        { maxOutput, input, inputFile, allowFailure, onOutputProgress },
        AbortSignal.any([signal, operationTimeout]),
      );
    } catch (error) {
      if (operationTimeout.aborted && !signal.aborted)
        refuseLimit(gitTimeoutLimit, gitTimeoutLimit.value + 1);
      throw error;
    }
  }

  function transport(repository: GithubPrRepositoryScope): GithubPrTransport {
    const key = `${repository.owner}/${repository.repo}`;
    let found = transports.get(key);
    if (found === undefined) {
      found = createGithubPrTransport(repository, {
        limits,
        budget,
        signal,
        deadlineAt,
        fetchPort: options.fetchPort,
      });
      transports.set(key, found);
    }
    return found;
  }

  async function acquire(
    repository: GithubPrRepositoryScope,
    wants: readonly string[],
    filter: "tree:0" | "blob:none" | null,
    deepen?: number,
  ): Promise<void> {
    const client = transport(repository);
    if (!transports.has(`${repository.owner}/${repository.repo}:discovered`)) {
      await client.discover();
      transports.set(`${repository.owner}/${repository.repo}:discovered`, client);
    }
    const result = await client.fetch({ wants, filter, deepen });
    const inputPath = join(home, "quarantine.pack");
    await writeFile(inputPath, result.pack, { mode: 0o600, flag: "wx" });
    let missingGitmodules: string[] = [];
    try {
      let preflight;
      try {
        preflight = await preflightGithubPack(
          result.pack,
          {
            packInflatedMaxBytes: limits.packInflatedBytes.value - inflatedBytes,
            objectMaterializedMaxBytes: limits.objectMaterializedBytes.value - materializedBytes,
            objectsMax: limits.objects.value - objects,
          },
          { signal, deadlineAt: Date.now() + Math.max(0, deadlineAt - performance.now()) },
        );
      } catch (error) {
        if (error instanceof GithubPackPreflightError) {
          if (error.code === "object-count-limit" && error.observed !== undefined)
            refuseLimit(limits.objects, objects + error.observed);
          if (error.code === "inflated-byte-limit" && error.observed !== undefined)
            refuseLimit(limits.packInflatedBytes, inflatedBytes + error.observed);
          if (error.code === "materialized-byte-limit" && error.observed !== undefined)
            refuseLimit(limits.objectMaterializedBytes, materializedBytes + error.observed);
          if (error.code === "cancelled" && options.signal?.aborted) fail("github-pr-cancelled");
        }
        throw error;
      }
      inflatedBytes += preflight.inflatedBytes;
      materializedBytes += preflight.materializedBytes;
      objects += preflight.objectCount;
      const imported = await run(
        [
          "index-pack",
          "--stdin",
          "--fsck-objects",
          `--max-input-size=${limits.acquisitionBytes.value}`,
        ],
        gitDefaultOutputLimit,
        undefined,
        inputPath,
      );
      const answer = imported.stdout.toString("ascii");
      const lines = answer.endsWith("\n") ? answer.slice(0, -1).split("\n") : [];
      if (!/^pack\t[0-9a-f]{40}$/u.test(lines[0] ?? ""))
        fail("github-pr-index-pack-response-invalid");
      missingGitmodules = [...new Set(lines.slice(1))];
      if (
        !missingGitmodules.every((id) => SHA1.test(id)) ||
        missingGitmodules.length > limits.objects.value
      )
        fail("github-pr-index-pack-response-invalid");
      for (const id of result.shallow) shallow.add(id);
      for (const id of result.unshallow) {
        if (!shallow.delete(id)) fail("github-pr-shallow-response-invalid");
      }
      await writeFile(
        join(repoDir, "shallow"),
        [...shallow].join("\n") + (shallow.size > 0 ? "\n" : ""),
        { mode: 0o600 },
      );
    } finally {
      await rm(inputPath, { force: true });
    }
    if (missingGitmodules.length > 0) {
      for (const id of missingGitmodules) {
        if (requestedGitmodules.has(id)) fail("github-pr-gitmodules-missing");
        requestedGitmodules.add(id);
      }
      await acquire(repository, missingGitmodules, null);
      for (const id of missingGitmodules) await readObject(id, "blob");
    }
  }

  async function readObject(
    id: string,
    type: "commit" | "tree" | "blob",
    onProgress?: () => void,
  ): Promise<Buffer> {
    oid(id);
    const checked = await run(
      ["cat-file", "--batch-check"],
      gitDefaultOutputLimit,
      Buffer.from(`${id}\n`, "ascii"),
      undefined,
      false,
      onProgress,
    );
    const line = checked.stdout.toString("ascii");
    if (line === `${id} missing\n`) fail("github-pr-object-missing");
    const match = /^([0-9a-f]{40}) (commit|tree|blob|tag) (\d+)\n$/u.exec(line);
    if (!match || match[1] !== id || match[2] !== type) fail("github-pr-object-type-invalid");
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size > limits.objectMaterializedBytes.value) {
      refuseLimit(limits.objectMaterializedBytes, size);
    }
    const output = await run(
      ["cat-file", "--batch"],
      size + id.length + type.length + String(size).length + 4,
      Buffer.from(`${id}\n`, "ascii"),
      undefined,
      false,
      onProgress,
    );
    const headerEnd = output.stdout.indexOf(10);
    if (
      headerEnd < 0 ||
      output.stdout.toString("ascii", 0, headerEnd + 1) !== `${id} ${type} ${size}\n`
    ) {
      fail("github-pr-object-output-invalid");
    }
    const body = output.stdout.subarray(headerEnd + 1);
    if (body.length !== size + 1 || body[size] !== 10) fail("github-pr-object-output-truncated");
    const exact = Buffer.from(body.subarray(0, size));
    if (objectId("sha1", type, exact) !== id) fail("github-pr-object-integrity-mismatch");
    return exact;
  }

  async function rawDiff(renames: boolean): Promise<GithubPrManifestRow[]> {
    if (graph === null) fail("github-pr-graph-required");
    const args = [
      "diff-tree",
      "-r",
      "--raw",
      "-z",
      "--no-abbrev",
      "--no-ext-diff",
      "--no-textconv",
      ...(renames ? ["-M", `-l${limits.changedFiles.value}`] : ["--no-renames"]),
      graph.M,
      graph.H,
      "--",
    ];
    const output = await run(args, gitOutputLimit);
    const rows = parseRawManifest(output.stdout, limits.changedFiles, renames);
    return rows;
  }

  try {
    await mkdir(template, { mode: 0o700 });
    const initializedRepo = await runIsolatedGithubGit(
      home,
      null,
      ["init", "--bare", "--object-format=sha1", `--template=${template}`, repoDir],
      {
        maxOutput: gitDefaultOutputLimit,
      },
      AbortSignal.any([signal, AbortSignal.timeout(gitTimeoutLimit.value)]),
    );
    if (initializedRepo.status !== 0) fail("github-pr-git-init-failed");
    initialized = true;
  } catch (error) {
    await cleanup();
    throw error;
  }
  if (!initialized) fail("github-pr-git-init-failed");

  return {
    acquireTips: () =>
      guarded(async () => {
        if (graph !== null) fail("github-pr-already-resolved");
        await acquire(scope.target, [scope.baseTip], "tree:0", limits.historyCommits.value);
        await acquire(scope.headRepository, [scope.headTip], "tree:0", limits.historyCommits.value);
        await readObject(scope.baseTip, "commit");
        await readObject(scope.headTip, "commit");
      }),
    resolveGraph: () =>
      guarded(async () => {
        const base = parseCommit(await readObject(scope.baseTip, "commit"));
        const head = parseCommit(await readObject(scope.headTip, "commit"));
        const countOutput = await run(
          ["rev-list", "--count", scope.baseTip, scope.headTip],
          gitDefaultOutputLimit,
        );
        const count = Number(countOutput.stdout.toString("ascii").trim());
        if (!Number.isSafeInteger(count)) fail("github-pr-history-count-invalid");
        if (count > limits.historyCommits.value) refuseLimit(limits.historyCommits, count);
        historyCommits = count;
        const all = await run(["rev-list", scope.baseTip, scope.headTip], gitOutputLimit);
        const ids = parseLines(all.stdout);
        if (ids.length !== count || !ids.every((id) => SHA1.test(id)))
          fail("github-pr-history-incomplete");
        for (const id of ids) {
          const commit = parseCommit(await readObject(id, "commit"));
          if (!SHA1.test(commit.tree) || !commit.parents.every((parent) => SHA1.test(parent))) {
            fail("github-pr-history-incomplete");
          }
        }
        const bases = await run(
          ["merge-base", "--all", scope.baseTip, scope.headTip],
          gitDefaultOutputLimit,
          undefined,
          undefined,
          true,
        );
        const mergeBases = bases.status === 0 ? parseLines(bases.stdout) : [];
        if (mergeBases.length === 0) fail("github-pr-history-incomplete");
        if (mergeBases.length !== 1 || !SHA1.test(mergeBases[0]!))
          fail("github-pr-merge-base-ambiguous");
        const M = mergeBases[0]!;
        const frontier = await run(
          ["rev-list", scope.baseTip, scope.headTip, "--not", M],
          gitOutputLimit,
        );
        if (parseLines(frontier.stdout).some((id) => shallow.has(id)))
          fail("github-pr-history-incomplete");
        const merge = parseCommit(await readObject(M, "commit"));
        const proposals = await run(
          ["rev-list", "--count", `${M}..${scope.headTip}`],
          gitDefaultOutputLimit,
        );
        const proposalCommits = Number(proposals.stdout.toString("ascii").trim());
        if (!Number.isSafeInteger(proposalCommits)) fail("github-pr-proposal-count-invalid");
        if (proposalCommits > limits.proposalCommits.value)
          refuseLimit(limits.proposalCommits, proposalCommits);
        graph = {
          B: scope.baseTip,
          H: scope.headTip,
          M,
          baseTree: base.tree,
          headTree: head.tree,
          mergeTree: merge.tree,
          proposalCommits,
          historyCommits: count,
          complete: true,
        };
        return graph;
      }),
    acquireTreesAndBlobs: () =>
      guarded(async () => {
        if (graph === null) fail("github-pr-graph-required");
        await acquire(scope.target, [graph.mergeTree], "blob:none");
        await acquire(scope.headRepository, [graph.headTree], "blob:none");
        const pending = [graph.mergeTree, graph.headTree];
        const seen = new Set<string>();
        while (pending.length > 0) {
          const id = pending.pop()!;
          if (seen.has(id)) continue;
          seen.add(id);
          if (seen.size > limits.objects.value) refuseLimit(limits.objects, seen.size);
          pending.push(...treeChildren(await readObject(id, "tree")));
        }
        initialRows = await rawDiff(false);
        const before = new Set<string>();
        const after = new Set<string>();
        for (const row of initialRows) {
          if (row.oldId !== null && (row.oldMode === "100644" || row.oldMode === "100755")) {
            before.add(row.oldId);
          }
          if (row.newId !== null && (row.newMode === "100644" || row.newMode === "100755")) {
            after.add(row.newId);
          }
        }
        if (before.size > 0) await acquire(scope.target, [...before], null);
        if (after.size > 0) await acquire(scope.headRepository, [...after], null);
        for (const id of new Set([...before, ...after])) await readObject(id, "blob");
        finalRows = await rawDiff(true);
        return finalRows;
      }),
    exportVerifiedHeadTree: () =>
      guarded(async () => {
        if (graph === null || finalRows === null) fail("github-pr-manifest-required");
        if (verifiedExport !== null) return verifiedExport;
        await acquire(scope.target, [graph.baseTree], "blob:none");
        const maxEntries = limit("repository.workspaceExportMaxTreeEntries", options.limits);
        const maxMetadata = limit("repository.workspaceExportMaxTreeMetadataBytes", options.limits);
        let metadataBytes = 0;
        async function walk(root: string): Promise<GithubPrVerifiedTreeEntry[]> {
          const output: GithubPrVerifiedTreeEntry[] = [];
          const pending: Array<{ id: string; prefix: string }> = [{ id: root, prefix: "" }];
          while (pending.length > 0) {
            const current = pending.pop()!;
            const body = await readObject(current.id, "tree");
            metadataBytes += body.length;
            if (metadataBytes > maxMetadata.value) refuseLimit(maxMetadata, metadataBytes);
            for (const record of strictTreeRecords(body)) {
              const path = current.prefix + record.name;
              if (record.mode === "40000" || record.mode === "040000") {
                pending.push({ id: record.id, prefix: `${path}/` });
                continue;
              }
              if (output.length >= maxEntries.value) refuseLimit(maxEntries, output.length + 1);
              output.push({
                path,
                mode: record.mode as GithubPrVerifiedTreeEntry["mode"],
                objectId: record.id,
                byteLength: null,
              });
            }
          }
          return output;
        }
        const head = await walk(graph.headTree);
        const base = await walk(graph.baseTree);
        const headRegular = [
          ...new Set(
            head
              .filter(
                (entry) =>
                  (entry.mode === "100644" || entry.mode === "100755") &&
                  !isExportExcluded(entry.path),
              )
              .map((entry) => entry.objectId),
          ),
        ];
        if (headRegular.length > 0) await acquire(scope.headRepository, headRegular, null);
        const checkedHead: GithubPrVerifiedTreeEntry[] = [];
        for (const entry of head) {
          if (
            (entry.mode !== "100644" && entry.mode !== "100755") ||
            isExportExcluded(entry.path)
          ) {
            checkedHead.push(Object.freeze(entry));
            continue;
          }
          const checked = await run(
            ["cat-file", "--batch-check"],
            gitDefaultOutputLimit,
            Buffer.from(`${entry.objectId}\n`, "ascii"),
          );
          const match = /^([0-9a-f]{40}) blob (\d+)\n$/u.exec(checked.stdout.toString("ascii"));
          if (!match || match[1] !== entry.objectId) fail("github-pr-object-missing");
          const byteLength = Number(match[2]);
          if (!Number.isSafeInteger(byteLength)) fail("github-pr-object-size-invalid");
          checkedHead.push(Object.freeze({ ...entry, byteLength }));
        }
        const gitPathOrder = (left: GithubPrVerifiedTreeEntry, right: GithubPrVerifiedTreeEntry) =>
          Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"));
        checkedHead.sort(gitPathOrder);
        const headEntriesSha256 = canonicalDigest(checkedHead);
        const manifestSha256 = canonicalDigest(finalRows);
        const sourceIdentitySha256 = canonicalDigest({
          kind: "docsfab-github-pr-head-workspace",
          targetRepositoryId: scope.target.repositoryId,
          headRepositoryId: scope.headRepository.repositoryId,
          B: graph.B,
          H: graph.H,
          M: graph.M,
          baseTree: graph.baseTree,
          headTree: graph.headTree,
          headEntriesSha256,
          manifestSha256,
        });
        const admitted = new Map(checkedHead.map((entry) => [entry.path, entry]));
        const inFlight = new Map<string, { promise: Promise<Buffer>; readers: number }>();
        const port: GithubPrVerifiedTreeExportPort = Object.freeze({
          sourcePath: repoDir,
          targetRepositoryId: scope.target.repositoryId,
          headRepositoryId: scope.headRepository.repositoryId,
          B: graph.B,
          H: graph.H,
          M: graph.M,
          baseTree: graph.baseTree,
          headTree: graph.headTree,
          headEntriesSha256,
          manifestSha256,
          sourceIdentitySha256,
          headEntries: Object.freeze(checkedHead),
          signal,
          checkActive: ensureActive,
          baseDocumentation: Object.freeze(
            base
              .filter(
                (entry) => /\.(?:md|mdx)$/iu.test(entry.path) && !isExportExcluded(entry.path),
              )
              .sort(gitPathOrder)
              .map((entry) => Object.freeze(entry)),
          ),
          cancel(): void {
            readerAbort.abort();
          },
          async readVerifiedBlob(
            entry: GithubPrVerifiedTreeEntry,
            onProgress?: () => void,
          ): Promise<Buffer> {
            const verified = admitted.get(entry.path);
            if (
              verified !== entry ||
              entry.byteLength === null ||
              (entry.mode !== "100644" && entry.mode !== "100755")
            )
              fail("github-pr-verified-blob-authority-required");
            let flight = inFlight.get(entry.objectId);
            if (flight === undefined) {
              flight = {
                promise: guarded(async () => {
                  const bytes = await readObject(entry.objectId, "blob", onProgress);
                  if (bytes.length !== entry.byteLength) fail("github-pr-object-size-invalid");
                  return bytes;
                }),
                readers: 0,
              };
              inFlight.set(entry.objectId, flight);
            }
            flight.readers += 1;
            try {
              return Buffer.from(await flight.promise);
            } finally {
              flight.readers -= 1;
              if (flight.readers === 0) {
                inFlight.delete(entry.objectId);
                // All concurrent consumers already copied their own bytes.
                void flight.promise.then(
                  (bytes) => bytes.fill(0),
                  () => undefined,
                );
              }
            }
          },
        });
        verifiedExports.add(port);
        verifiedExport = port;
        return port;
      }),
    readObject: (id, type) => guarded(() => readObject(id, type)),
    enumerate: () =>
      guarded(async () => {
        if (finalRows === null) fail("github-pr-manifest-required");
        return finalRows;
      }),
    measurements: () => ({
      responseBytes: budget.admittedBytes,
      packInflatedBytes: inflatedBytes,
      objectMaterializedBytes: materializedBytes,
      objects,
      historyCommits,
      elapsedMs: Math.ceil(performance.now() - started),
      effectiveLimits: Object.fromEntries(
        Object.values(limits).map((entry) => [entry.name, entry.value]),
      ),
    }),
    dispose: cleanup,
  };
}
