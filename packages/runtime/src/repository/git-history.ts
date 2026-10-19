// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Read-only access to the local git history behind a materialized repository
 * workspace: resolve a revision, read a file at a revision, list and diff the
 * files two revisions change, walk commits, search commits for a string, and
 * blame a line range.
 *
 * Every read goes through `runTrustedGit` (no hooks, no fsmonitor, no
 * credential helper, no protocol, no lazy fetch, no replace refs or grafts, a
 * closed environment, a byte bound and a timeout) plus the argv hardening
 * below, so repository configuration can neither run a program nor change the
 * output this module parses. Revisions are validated hex object names or the
 * pinned head, passed after `--end-of-options` (blame takes a full id without
 * it, see `blame`; a search reads its window's full ids on stdin); paths are
 * literal and passed after `--`. Nothing here
 * writes to the repository or the network.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { limit, type ResolveLimitsOptions } from "../config/limits.js";
import type { ToolFailureCategory } from "../records/contracts.js";
import {
  MAX_GIT_OUTPUT_BYTES,
  runTrustedGit,
  TrustedGitError,
} from "../host-invoker/trusted-git.js";

/**
 * Global options for every history read. Literal pathspecs keep a path from
 * being read as pathspec magic, and each `-c` pins a setting that would
 * otherwise run a program or reshape the output parsed here.
 */
const HISTORY_GIT_OPTIONS = [
  "--no-pager",
  "--literal-pathspecs",
  "-c",
  "log.showSignature=false",
  "-c",
  "diff.external=",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "color.ui=false",
  "-c",
  "diff.orderFile=",
  "-c",
  "diff.relative=false",
  "-c",
  "diff.noprefix=false",
  "-c",
  "log.follow=false",
  "-c",
  "core.quotePath=false",
  "-c",
  "i18n.logOutputEncoding=UTF-8",
] as const;

/** Declared in `config/limits/gitHistory.yaml`. */
export const GIT_HISTORY_REVISION_MIN_HEX_CHARS_LIMIT = "gitHistory.revisionMinHexChars" as const;
const HEX_PATTERN = /^[0-9a-f]+$/u;
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
/** The model-facing name for the run's pinned revision. */
export const HEAD_REVISION_ALIAS = "head";
/** `git merge-base --is-ancestor` and `git cat-file -e` report "no" with exit status 1. */
const GIT_NO = 1;
/** Git's patch section header; a hunk line never starts with it. */
const PATCH_SECTION_HEADER = "diff --git ";
/** Git C-quotes a path holding an ASCII control character below this code point ... */
const ASCII_CONTROL_END = 0x20;
/** ... or the DEL character ... */
const ASCII_DELETE = 0x7f;
/** ... as a backslash and three octal digits, unless it has a letter escape below. */
const OCTAL_RADIX = 8;
const OCTAL_ESCAPE_DIGITS = 3;
const OCTAL_ESCAPE_PATTERN = /^[0-7]{3}$/u;
/** `--raw` fields before the names: two modes, two ids and the status, last. */
const RAW_RECORD_FIELDS = 5;
const RAW_STATUS_FIELD = RAW_RECORD_FIELDS - 1;
/**
 * A pickaxe record header: a leading NUL, then the commit, its parents, the
 * committer date and the subject, split by unit separators.
 */
const SEARCH_RECORD_FORMAT = "%x00%H%x1f%P%x1f%cI%x1f%s";
const SEARCH_RECORD_START = "\0";
/** Ends one record's last name and starts the next record. */
const SEARCH_RECORD_BOUNDARY = "\0\0";
/** What `-z` writes between a record's header and its first name. */
const SEARCH_HEADER_END = "\0\n";
/** A `blame --porcelain` line header: commit, source line, line, and an optional group size. */
const BLAME_HEADER_PATTERN =
  /^([0-9a-f]{40}|[0-9a-f]{64}) ([1-9][0-9]*) ([1-9][0-9]*)(?: [1-9][0-9]*)?$/u;
const BLAME_FILENAME_KEY = "filename ";
const BLAME_PREVIOUS_KEY = "previous ";
const C_QUOTE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["\x07", "a"],
  ["\b", "b"],
  ["\t", "t"],
  ["\n", "n"],
  ["\v", "v"],
  ["\f", "f"],
  ["\r", "r"],
  ['"', '"'],
  ["\\", "\\"],
]);

export const GIT_HISTORY_CODES = [
  "history-arguments-invalid",
  "history-revision-invalid",
  "history-revision-ambiguous",
  "history-revision-out-of-scope",
  "history-object-missing",
  "history-object-unavailable",
  "history-object-too-large",
  "history-object-binary",
  "history-output-too-large",
  "history-path-refused",
  "history-path-missing",
  "history-path-not-file",
  "history-cursor-invalid",
  "history-line-range-invalid",
  "history-timeout",
  "history-git-failed",
] as const;
export type GitHistoryCode = (typeof GIT_HISTORY_CODES)[number];

/** Each code's recorded tool-failure category; no new category is introduced. */
export const GIT_HISTORY_CODE_CATEGORIES: Readonly<Record<GitHistoryCode, ToolFailureCategory>> = {
  "history-arguments-invalid": "malformed-arguments",
  "history-revision-invalid": "malformed-arguments",
  "history-revision-ambiguous": "malformed-arguments",
  "history-revision-out-of-scope": "recoverable-miss",
  "history-object-missing": "recoverable-miss",
  "history-object-unavailable": "recoverable-miss",
  "history-object-too-large": "recoverable-miss",
  "history-object-binary": "recoverable-miss",
  "history-output-too-large": "recoverable-miss",
  "history-path-refused": "denied-path",
  "history-path-missing": "recoverable-miss",
  "history-path-not-file": "recoverable-miss",
  "history-cursor-invalid": "recoverable-miss",
  "history-line-range-invalid": "malformed-arguments",
  "history-timeout": "recoverable-miss",
  "history-git-failed": "tool-defect",
};

/** Content-free remediation for each code; no path, revision or byte is echoed. */
const GIT_HISTORY_REMEDIATIONS: Readonly<Record<GitHistoryCode, string>> = {
  "history-arguments-invalid":
    "The arguments did not match the tool schema; send each documented field with its documented type.",
  "history-revision-invalid": `Name a revision as "${HEAD_REVISION_ALIAS}" or as a lowercase hex commit id of at least ${GIT_HISTORY_REVISION_MIN_HEX_CHARS_LIMIT} characters and at most the repository's full id length; ranges, refs, reflog entries and options are not revisions here.`,
  "history-revision-ambiguous":
    "The abbreviated id matches more than one commit; send more hex characters of the commit id.",
  "history-revision-out-of-scope": `The commit is not in the history of this run's pinned revision; only "${HEAD_REVISION_ALIAS}" and its ancestors can be read.`,
  "history-object-missing":
    "The object is not in this checkout. Name another revision, or read the change with a checkout that has it.",
  "history-object-unavailable":
    "This partial clone does not hold the object locally, and history tools never fetch. Read another revision or path.",
  "history-object-too-large":
    "The file at that revision is larger than hostInvoker.gitOutputMaxBytes, the bound on one whole-object read. Read another path.",
  "history-object-binary":
    "The file at that revision is not UTF-8 text; history tools return text only.",
  "history-output-too-large":
    "Git produced more output than hostInvoker.gitOutputMaxBytes allows for one read. Narrow the request with paths or a shorter range.",
  "history-path-refused":
    "Name a repository-relative path without absolute, home, NUL, empty, . or .. segments, outside credential-bearing and generated paths.",
  "history-path-missing":
    "The path does not exist at that revision. List what changed with docsfab_history_log or docsfab_history_diff first.",
  "history-path-not-file":
    "The path names a directory, link or submodule at that revision, not a regular file.",
  "history-cursor-invalid":
    "Send a cursor exactly as the same tool returned it in this attempt, with the same other arguments or none.",
  "history-line-range-invalid":
    "Name startLine and endLine as whole line numbers, counted from 1, with startLine at most endLine and endLine at most the file's line count at that revision. A file has one line per line break, plus one for a last line without a break; an empty file has none.",
  "history-timeout":
    "Git did not finish within hostInvoker.gitTimeoutMs. Narrow the request with a path or a shorter range.",
  "history-git-failed": "Git could not read this repository history; the host recorded a defect.",
};

/** A coded, content-free history refusal. */
export class GitHistoryError extends Error {
  public readonly code: GitHistoryCode;
  public readonly category: ToolFailureCategory;

  public constructor(code: GitHistoryCode, detail?: string) {
    super(
      `DocsFab refused this history read: ${code}. ${detail ? `${detail} ` : ""}${GIT_HISTORY_REMEDIATIONS[code]}`,
    );
    this.name = "GitHistoryError";
    this.code = code;
    this.category = GIT_HISTORY_CODE_CATEGORIES[code];
  }
}

/** Refuse a history read with its code; the error carries the fixed remediation. */
export function failGitHistory(code: GitHistoryCode, detail?: string): never {
  throw new GitHistoryError(code, detail);
}

export type GitRunner = (
  cwd: string,
  args: readonly string[],
  maximumBytes?: number,
  input?: Buffer,
) => Promise<Buffer>;

const trustedRunner: GitRunner = (cwd, args, maximumBytes, input) =>
  runTrustedGit(cwd, args, undefined, maximumBytes, input);

export interface GitHistoryReaderOptions {
  /** The operator checkout's top level, as the workspace export resolved it. */
  readonly sourcePath: string;
  /** The run's pinned full commit id. */
  readonly headRevision: string;
  /** Test seam: the git runner. Production always uses `runTrustedGit`. */
  readonly git?: GitRunner;
  /** Limit resolution; omitted resolves the process environment and host files. */
  readonly limits?: ResolveLimitsOptions;
}

export interface HistoryBlob {
  readonly objectId: string;
  readonly bytes: Buffer;
}

export interface HistoryLogEntry {
  readonly commit: string;
  readonly parents: readonly string[];
  readonly committedAt: string;
  readonly subject: string;
}

/** One commit a pickaxe search matched, with the names whose needle count changed. */
export interface HistorySearchMatch {
  readonly commit: string;
  readonly parents: readonly string[];
  readonly committedAt: string;
  readonly subject: string;
  /** Null for a name that is not UTF-8. */
  readonly paths: readonly (string | null)[];
}

/** One blamed line, as git attributed it. */
export interface HistoryBlameLine {
  /** The line's number in the blamed file, counted from 1. */
  readonly line: number;
  /** The commit that last changed the line. */
  readonly commit: string;
  /** The line's number in that commit's version of the file, counted from 1. */
  readonly sourceLine: number;
  /** The file's name in that commit; null when the name is not UTF-8. */
  readonly sourcePath: string | null;
  /**
   * The names the file had in the commit's parent, when git compared against
   * one; never served, only checked against the export exclusions. Null for a
   * name that is not UTF-8.
   */
  readonly previousPaths: readonly (string | null)[];
}

/**
 * One reader per tool set. The shallow set and the partial-clone answer are
 * read once: a tool set lives for one step attempt, and the checkout does not
 * change shape under a run.
 */
export class GitHistoryReader {
  public readonly headRevision: string;
  public readonly sourcePath: string;
  private readonly git: GitRunner;
  private readonly minimumHex: number;
  private shallow: Promise<ReadonlySet<string>> | undefined;
  private partial: Promise<boolean> | undefined;
  private readonly treesHeld = new Map<string, Promise<boolean>>();

  public constructor(options: GitHistoryReaderOptions) {
    if (!OBJECT_ID_PATTERN.test(options.headRevision)) {
      failGitHistory(
        "history-revision-invalid",
        "The pinned revision of the history reader is not a full object id.",
      );
    }
    this.sourcePath = options.sourcePath;
    this.headRevision = options.headRevision;
    this.git = options.git ?? trustedRunner;
    this.minimumHex = limit(GIT_HISTORY_REVISION_MIN_HEX_CHARS_LIMIT, options.limits).value;
  }

  /**
   * Resolve a model-supplied revision to a full commit id inside the pinned
   * head's history: `head`, or a lowercase hex commit id or abbreviation.
   */
  public async resolveRevision(raw: unknown): Promise<string> {
    if (raw === HEAD_REVISION_ALIAS) return this.headRevision;
    if (typeof raw === "string" && HEX_PATTERN.test(raw) && raw.length < this.minimumHex) {
      failGitHistory(
        "history-revision-invalid",
        `The id has ${String(raw.length)} hex characters; ${GIT_HISTORY_REVISION_MIN_HEX_CHARS_LIMIT} is ${String(this.minimumHex)}.`,
      );
    }
    // The pinned head's length is this repository's object format.
    const fullLength = this.headRevision.length;
    if (typeof raw === "string" && HEX_PATTERN.test(raw) && raw.length > fullLength) {
      failGitHistory(
        "history-revision-invalid",
        `The id has ${String(raw.length)} hex characters; this repository's commit ids have ${String(fullLength)}.`,
      );
    }
    if (typeof raw !== "string" || raw.length < this.minimumHex || !HEX_PATTERN.test(raw)) {
      failGitHistory("history-revision-invalid");
    }
    const resolved =
      raw.length === fullLength
        ? await this.resolveFullId(raw)
        : await this.resolveAbbreviation(raw);
    // Abbreviations resolve to commits only; a full id that peels to another
    // commit names an annotated tag.
    if (!resolved.startsWith(raw)) {
      failGitHistory("history-revision-invalid", "The id names a tag, not a commit.");
    }
    await this.assertInScope(resolved);
    return resolved;
  }

  /** Refuse a commit that is not the pinned head or one of its ancestors. */
  public async assertInScope(commit: string): Promise<void> {
    try {
      await this.run([
        "merge-base",
        "--is-ancestor",
        "--end-of-options",
        commit,
        this.headRevision,
      ]);
    } catch (error) {
      if (error instanceof TrustedGitError && error.kind === "exit" && error.exitCode === GIT_NO) {
        failGitHistory("history-revision-out-of-scope");
      }
      throw await this.classify(error, [commit]);
    }
  }

  /** The commits the checkout was cut at, empty for a full clone. */
  public shallowCommits(): Promise<ReadonlySet<string>> {
    // A failed read is not remembered, so one timeout does not fail the attempt's later reads.
    this.shallow ??= this.readShallowCommits().catch((error: unknown) => {
      this.shallow = undefined;
      throw error;
    });
    return this.shallow;
  }

  /** True when the checkout is a partial clone with a promisor remote. */
  public isPartialClone(): Promise<boolean> {
    this.partial ??= this.readPartialClone().catch((error: unknown) => {
      this.partial = undefined;
      throw error;
    });
    return this.partial;
  }

  /** The bytes of one regular file at a commit. */
  public async readFile(commit: string, path: string): Promise<HistoryBlob> {
    const entry = await this.treeEntry(commit, path);
    if (!entry) failGitHistory("history-path-missing");
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
      failGitHistory("history-path-not-file");
    }
    // Refuse an absent blob before a read that would ask the promisor for it.
    if ((await this.isPartialClone()) && !(await this.objectPresent(entry.objectId))) {
      throw await this.missing();
    }
    let size: number;
    try {
      size = Number(
        (await this.run(["cat-file", "-s", "--end-of-options", entry.objectId])).toString().trim(),
      );
    } catch (error) {
      throw await this.classify(error, [entry.objectId]);
    }
    if (!Number.isSafeInteger(size) || size > MAX_GIT_OUTPUT_BYTES) {
      failGitHistory("history-object-too-large");
    }
    try {
      const bytes = await this.run(
        ["cat-file", "blob", "--end-of-options", entry.objectId],
        MAX_GIT_OUTPUT_BYTES,
      );
      return { objectId: entry.objectId, bytes };
    } catch (error) {
      throw await this.classify(error, [entry.objectId]);
    }
  }

  /** Paths `base` and `head` differ at, in git's order; renames read as delete plus add. */
  public async changedPaths(
    base: string,
    head: string,
    paths: readonly string[] = [],
  ): Promise<string[]> {
    // A treeless partial clone may lack either side's trees; reading one would ask the promisor.
    if ((await this.isPartialClone()) && !(await this.treesPresent([base, head]))) {
      throw await this.missing();
    }
    try {
      const output = await this.run(
        [
          "diff-tree",
          "-r",
          "-z",
          "--no-renames",
          "--name-only",
          "--no-textconv",
          "--no-ext-diff",
          "--end-of-options",
          base,
          head,
          "--",
          ...paths,
        ],
        MAX_GIT_OUTPUT_BYTES,
      );
      return output.toString("utf8").split("\0").filter(Boolean);
    } catch (error) {
      throw await this.classify(error, [base, head]);
    }
  }

  /**
   * The patch for one path between two commits, and only that path. A path
   * that is a file on one side and a directory on the other also matches
   * everything under the directory, so every other section is dropped here;
   * each of those paths is listed, or excluded, on its own by `changedPaths`.
   */
  public async filePatch(base: string, head: string, path: string): Promise<string> {
    if (await this.isPartialClone()) {
      for (const commit of [base, head]) {
        const entry = await this.treeEntry(commit, path);
        if (entry?.type === "blob" && !(await this.objectPresent(entry.objectId))) {
          throw await this.missing();
        }
      }
    }
    let output: Buffer;
    try {
      output = await this.run(
        [
          "diff-tree",
          "-p",
          "-r",
          "--no-renames",
          "--no-textconv",
          "--no-ext-diff",
          "--full-index",
          "--no-color",
          "-U3",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "--no-relative",
          "--end-of-options",
          base,
          head,
          "--",
          path,
        ],
        MAX_GIT_OUTPUT_BYTES,
      );
    } catch (error) {
      const objects = [base, head];
      for (const commit of [base, head]) {
        const entry = await this.treeEntry(commit, path).catch(() => undefined);
        if (entry) objects.push(entry.objectId);
      }
      throw await this.classify(error, objects);
    }
    return patchSection(output.toString("utf8"), path);
  }

  /**
   * Commits reachable from `to` and not from `from`, newest first, optionally
   * only those touching `path`; `count` entries after skipping `skip`.
   */
  public async log(input: {
    readonly to: string;
    readonly from?: string;
    readonly path?: string;
    readonly skip: number;
    readonly count: number;
  }): Promise<HistoryLogEntry[]> {
    let output: Buffer;
    try {
      output = await this.run(
        [
          "log",
          "--no-color",
          "--no-decorate",
          "--no-notes",
          "--no-mailmap",
          "--no-show-signature",
          "--format=%H%x1f%P%x1f%cI%x1f%s",
          "-z",
          `--skip=${String(input.skip)}`,
          `--max-count=${String(input.count)}`,
          "--end-of-options",
          input.to,
          ...(input.from ? [`^${input.from}`] : []),
          "--",
          ...(input.path ? [input.path] : []),
        ],
        MAX_GIT_OUTPUT_BYTES,
      );
    } catch (error) {
      throw await this.classify(error, input.from ? [input.to, input.from] : [input.to]);
    }
    return output
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((record) => {
        const [commit = "", parents = "", committedAt = "", ...subject] = record.split("\x1f");
        const parentIds = parents ? parents.split(" ") : [];
        if (
          !OBJECT_ID_PATTERN.test(commit) ||
          !parentIds.every((id) => OBJECT_ID_PATTERN.test(id))
        ) {
          failGitHistory("history-git-failed");
        }
        return { commit, parents: parentIds, committedAt, subject: subject.join("\x1f") };
      });
  }

  /**
   * The commits a search window scans: the walk from `to`, stopped at `from`
   * and limited to `paths`, newest first, `count` ids after skipping `skip`.
   * The walk never reads a needle, so the window is the same for every one.
   */
  public async searchWindow(input: {
    readonly to: string;
    readonly from?: string;
    readonly paths: readonly string[];
    readonly skip: number;
    readonly count: number;
  }): Promise<string[]> {
    let output: Buffer;
    try {
      output = await this.run(
        [
          "rev-list",
          `--skip=${String(input.skip)}`,
          `--max-count=${String(input.count)}`,
          "--end-of-options",
          input.to,
          ...(input.from ? [`^${input.from}`] : []),
          "--",
          ...input.paths,
        ],
        MAX_GIT_OUTPUT_BYTES,
      );
    } catch (error) {
      throw await this.classify(error, input.from ? [input.to, input.from] : [input.to]);
    }
    const ids = output.toString("utf8").split("\n").filter(Boolean);
    if (!ids.every((id) => OBJECT_ID_PATTERN.test(id) && id.length === this.headRevision.length)) {
      failGitHistory("history-git-failed");
    }
    return ids;
  }

  /**
   * Every name each window commit changed under `paths`, read without a
   * needle: a commit with one parent against it, a root or a shallow cut
   * against the empty tree, and a merge as nothing, since a pickaxe search
   * never matches a merge. One list per commit, in the window's order.
   */
  public async searchChangedNames(
    commits: readonly string[],
    paths: readonly string[],
  ): Promise<Array<readonly (string | null)[]>> {
    if (commits.length === 0) return [];
    return (
      await this.rawDiffs(
        commits.map((commit) => ({ child: commit })),
        paths,
      )
    ).map((records) => records.flatMap((record) => record.paths));
  }

  /**
   * The window commits whose change under `paths` alters how often `needle`
   * occurs (git's `-S`, a literal string), in the window's order, each with
   * the names whose count changed. Only the window's ids are read, from
   * stdin, so the walk is never repeated or widened here.
   *
   * Each record is a NUL, the header fields split by unit separators, a NUL
   * and a line feed, then each name followed by a NUL. A name is never empty,
   * so two NULs in a row only ever end one record and start the next; the
   * leading NUL keeps a name that spells a header from reading as one.
   */
  public async pickaxe(input: {
    readonly commits: readonly string[];
    readonly needle: string;
    readonly paths: readonly string[];
  }): Promise<HistorySearchMatch[]> {
    if (input.commits.length === 0) return [];
    // Each stdin line is read as a revision; only a full id may reach it.
    if (!input.commits.every((commit) => OBJECT_ID_PATTERN.test(commit))) {
      failGitHistory("history-git-failed");
    }
    let output: Buffer;
    try {
      output = await this.run(
        [
          "log",
          "--no-walk=unsorted",
          "--stdin",
          "--root",
          "--no-renames",
          "--diff-merges=off",
          // An empty order file: log reads the cleared `diff.orderFile` as a
          // file named "" and fails, and a configured one would reorder names.
          "-O/dev/null",
          `-S${input.needle}`,
          "--no-textconv",
          "--no-ext-diff",
          "--name-only",
          `--format=${SEARCH_RECORD_FORMAT}`,
          "-z",
          "--no-color",
          "--no-decorate",
          "--no-notes",
          "--no-mailmap",
          "--no-show-signature",
          "--no-abbrev",
          "--",
          ...input.paths,
        ],
        MAX_GIT_OUTPUT_BYTES,
        Buffer.from(`${input.commits.join("\n")}\n`, "utf8"),
      );
    } catch (error) {
      throw await this.classify(error, []);
    }
    const matches = parseSearchRecords(output);
    // Each match must be the next window id git was given, in order: a
    // strict subsequence, so no record can be reordered, repeated or foreign.
    let position = 0;
    for (const match of matches) {
      if (match.commit.length !== this.headRevision.length) failGitHistory("history-git-failed");
      while (position < input.commits.length && input.commits[position] !== match.commit) {
        position += 1;
      }
      if (position === input.commits.length) failGitHistory("history-git-failed");
      position += 1;
    }
    return matches;
  }

  /**
   * True when a walk from `to`, stopped at `from`, reaches a commit the shallow
   * clone was cut at. A cut commit reads as parentless, so it is among the
   * walk's parentless commits; a full clone's root is not in the shallow set.
   */
  public async reachesShallowCut(to: string, from?: string): Promise<boolean> {
    const shallow = await this.shallowCommits();
    if (shallow.size === 0) return false;
    let output: Buffer;
    try {
      output = await this.run(
        ["rev-list", "--max-parents=0", "--end-of-options", to, ...(from ? [`^${from}`] : [])],
        MAX_GIT_OUTPUT_BYTES,
      );
    } catch (error) {
      throw await this.classify(error, from ? [to, from] : [to]);
    }
    return output
      .toString("utf8")
      .split("\n")
      .some((commit) => shallow.has(commit));
  }

  /**
   * Who last changed lines `start` through `end` (counted from 1, inclusive)
   * of a regular file at a commit, in line order; the caller has already
   * checked the range against the file's line count.
   *
   * `--no-ignore-revs-file` drops a repository-configured ignore list:
   * neither `--ignore-revs-file=` nor `-c blame.ignoreRevsFile=` clears one,
   * so a missing file would fail every call and an existing one would move
   * attribution. Blame reads a revision placed after `--end-of-options` as
   * the path, so the full id goes without it; a hex id cannot start with `-`.
   */
  public async blame(
    commit: string,
    path: string,
    start: number,
    end: number,
  ): Promise<HistoryBlameLine[]> {
    if (!OBJECT_ID_PATTERN.test(commit)) failGitHistory("history-revision-invalid");
    const partial = await this.isPartialClone();
    if (partial && !(await this.blameObjectsPresent(commit, path))) throw await this.missing();
    let output: Buffer;
    try {
      output = await this.run(
        [
          "blame",
          "--porcelain",
          "--no-progress",
          "--no-textconv",
          "--no-ignore-revs-file",
          "-L",
          `${String(start)},${String(end)}`,
          commit,
          "--",
          path,
        ],
        MAX_GIT_OUTPUT_BYTES,
      );
    } catch (error) {
      // A partial clone, after the check above passed: blame stopped on an
      // object the check could not name, which the clone does not hold. A
      // full clone keeps the ordinary mapping, where such an exit is a defect.
      if (partial && error instanceof TrustedGitError && error.kind === "exit") {
        failGitHistory("history-object-unavailable");
      }
      throw await this.classify(error, [commit]);
    }
    return parseBlamePorcelain(output, start, end);
  }

  /**
   * Whether a partial clone holds every object blame may read for `path` at
   * `commit`, asked without a lazy fetch: each version of the file along its
   * history, the trees on its path, and, where the file first appears, both
   * whole trees and every added or deleted file of that commit, which rename
   * detection compares. The walk then continues under the name the file was
   * renamed from, as blame does.
   */
  private async blameObjectsPresent(commit: string, path: string): Promise<boolean> {
    const pending: Array<{ readonly tip: string; readonly path: string }> = [{ tip: commit, path }];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const { tip, path: name } = pending.shift()!;
      const key = `${tip}\0${name}`;
      if (visited.has(key)) continue;
      visited.add(key);
      // The file's versions and the trees on its path; a tree the walk needs
      // and cannot read fails it, since `--missing` never fetches.
      const versions = await this.noMissingObjects(
        ["--no-object-names", "--end-of-options", tip, "--", name],
        undefined,
        { missingTreeFails: true },
      );
      if (!versions) return false;
      let walk: Buffer;
      try {
        walk = await this.run(
          ["rev-list", "--missing=print", "--format=%H %P", "--end-of-options", tip, "--", name],
          MAX_GIT_OUTPUT_BYTES,
        );
      } catch (error) {
        throw await this.classify(error, []);
      }
      const pairs = walk
        .toString("utf8")
        .split("\n")
        .filter((line) => line.length > 0 && !line.startsWith("commit "))
        .flatMap((line) => {
          // A root commit, or a shallow cut, lists no parent and compares with nothing.
          const [child = "", ...parents] = line.split(" ").filter(Boolean);
          if (![child, ...parents].every((id) => OBJECT_ID_PATTERN.test(id))) {
            failGitHistory("history-git-failed");
          }
          return parents.map((parent) => ({ child, parent }));
        });
      if (pairs.length === 0) continue;
      // Where the file is absent in a parent, blame looks for a rename source there.
      const added = (await this.rawDiffs(pairs, [name])).flatMap((records, index) =>
        records.some((record) => record.status === "A" && record.paths[0] === name)
          ? [pairs[index]!]
          : [],
      );
      if (added.length === 0) continue;
      const trees = await this.noMissingObjects(
        ["--no-walk", "--filter=blob:none", "--no-object-names", "--stdin"],
        Buffer.from(`${added.flatMap((pair) => [pair.child, pair.parent]).join("\n")}\n`, "utf8"),
      );
      if (!trees) return false;
      const candidates = (await this.rawDiffs(added, []))
        .flat()
        .flatMap((record) => [record.oldId, record.newId])
        .filter((id) => !/^0+$/u.test(id));
      if (candidates.length > 0 && !(await this.locallyPresent(candidates))) return false;
      for (const pair of added) {
        const source = (await this.renames(pair.parent, pair.child)).get(name);
        if (source !== undefined) pending.push({ tip: pair.parent, path: source });
      }
    }
    return true;
  }

  /**
   * True when `rev-list --objects --missing=print` lists no missing object.
   * `--missing=print` turns lazy fetching off on every git version, so a
   * missing object is listed as `?<id>`; a tree a path-limited walk cannot
   * read ends the walk instead, which `missingTreeFails` reads as missing.
   */
  private async noMissingObjects(
    args: readonly string[],
    input?: Buffer,
    options: { readonly missingTreeFails?: boolean } = {},
  ): Promise<boolean> {
    let output: Buffer;
    try {
      output = await this.run(
        ["rev-list", "--objects", "--missing=print", ...args],
        MAX_GIT_OUTPUT_BYTES,
        input,
      );
    } catch (error) {
      if (options.missingTreeFails && error instanceof TrustedGitError && error.kind === "exit") {
        return false;
      }
      throw await this.classify(error, []);
    }
    return !output
      .toString("utf8")
      .split("\n")
      .some((line) => line.startsWith("?"));
  }

  /**
   * Whether every tree of a commit is in the local store, read once per
   * commit without a lazy fetch. A treeless partial clone holds the commits
   * but not their trees.
   */
  private async treesPresent(commits: readonly string[]): Promise<boolean> {
    const held = await Promise.all(
      commits.map((commit) => {
        let known = this.treesHeld.get(commit);
        if (!known) {
          known = this.noMissingObjects([
            "--no-walk",
            "--filter=blob:none",
            "--no-object-names",
            "--end-of-options",
            commit,
          ]).catch((error: unknown) => {
            this.treesHeld.delete(commit);
            throw error;
          });
          this.treesHeld.set(commit, known);
        }
        return known;
      }),
    );
    return held.every(Boolean);
  }

  /**
   * Raw records of each parent-to-child diff, without rename detection, one
   * list per pair. A pair without a parent diffs the commit as git reads it:
   * against its one parent, a root or shallow cut against the empty tree, and
   * a merge as no records.
   */
  private async rawDiffs(
    pairs: ReadonlyArray<{ readonly child: string; readonly parent?: string }>,
    paths: readonly string[],
  ): Promise<RawDiffRecord[][]> {
    const parentless = pairs.some((pair) => pair.parent === undefined);
    let output: Buffer;
    try {
      output = await this.run(
        [
          "diff-tree",
          "--stdin",
          "--always",
          ...(parentless ? ["--root", "--diff-merges=off"] : []),
          "-r",
          "--raw",
          "-z",
          "--no-abbrev",
          "--no-renames",
          "--no-textconv",
          "--no-ext-diff",
          "--",
          ...paths,
        ],
        MAX_GIT_OUTPUT_BYTES,
        Buffer.from(
          pairs
            .map((pair) =>
              pair.parent === undefined ? `${pair.child}\n` : `${pair.child} ${pair.parent}\n`,
            )
            .join(""),
          "utf8",
        ),
      );
    } catch (error) {
      throw await this.classify(error, []);
    }
    const groups = parseRawDiffs(output);
    if (
      groups.length !== pairs.length ||
      groups.some((group, index) => group.commit !== pairs[index]!.child)
    ) {
      failGitHistory("history-git-failed");
    }
    return groups.map((group) => group.records);
  }

  /** Renamed files between two commits, by new name, as git's default rename detection pairs them. */
  private async renames(parent: string, child: string): Promise<Map<string, string>> {
    let output: Buffer;
    try {
      output = await this.run(
        [
          "diff-tree",
          "-r",
          "-M",
          "--raw",
          "-z",
          "--no-abbrev",
          "--no-textconv",
          "--no-ext-diff",
          "--end-of-options",
          parent,
          child,
        ],
        MAX_GIT_OUTPUT_BYTES,
      );
    } catch (error) {
      throw await this.classify(error, [parent, child]);
    }
    const renamed = new Map<string, string>();
    for (const record of parseRawRecords(rawTokens(output))) {
      const [source, target] = record.paths;
      if (record.status === "R" && typeof source === "string" && typeof target === "string") {
        renamed.set(target, source);
      }
    }
    return renamed;
  }

  private async resolveFullId(raw: string): Promise<string> {
    // Peeling an absent object would ask the promisor for it.
    if ((await this.isPartialClone()) && !(await this.locallyPresent([raw]))) {
      throw await this.missing();
    }
    try {
      const output = await this.run([
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `${raw}^{commit}`,
      ]);
      return output.toString("utf8").trim();
    } catch (error) {
      throw await this.classifyRevision(error, raw);
    }
  }

  /**
   * Resolve an abbreviation from the object store alone. Refs are never
   * consulted, so a branch or tag named like hex cannot stand in for an id.
   */
  private async resolveAbbreviation(raw: string): Promise<string> {
    let candidates: string[];
    try {
      candidates = (await this.run(["rev-parse", `--disambiguate=${raw}`]))
        .toString("utf8")
        .split("\n")
        .filter(Boolean);
    } catch (error) {
      throw await this.classify(error, []);
    }
    if (candidates.length === 0) throw await this.missing();
    let typed: string[];
    try {
      typed = (
        await this.run(
          ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
          undefined,
          Buffer.from(`${candidates.join("\n")}\n`, "utf8"),
        )
      )
        .toString("utf8")
        .split("\n")
        .filter(Boolean);
    } catch (error) {
      throw await this.classify(error, []);
    }
    const commits = typed
      .map((line) => line.split(" "))
      .filter(([, type]) => type === "commit")
      .map(([id]) => id!);
    if (commits.length > 1) failGitHistory("history-revision-ambiguous");
    if (commits.length === 0) failGitHistory("history-revision-invalid");
    return commits[0]!;
  }

  private async treeEntry(
    commit: string,
    path: string,
  ): Promise<{ mode: string; type: string; objectId: string } | undefined> {
    if ((await this.isPartialClone()) && !(await this.treesPresent([commit]))) {
      throw await this.missing();
    }
    let output: Buffer;
    try {
      output = await this.run([
        "ls-tree",
        "-z",
        "--full-tree",
        "--end-of-options",
        commit,
        "--",
        path,
      ]);
    } catch (error) {
      throw await this.classify(error, [commit]);
    }
    for (const record of output.toString("utf8").split("\0")) {
      const tab = record.indexOf("\t");
      if (tab < 0 || record.slice(tab + 1) !== path) continue;
      const [mode = "", type = "", objectId = ""] = record.slice(0, tab).split(" ");
      return { mode, type, objectId };
    }
    return undefined;
  }

  /**
   * Why a full id did not resolve to a commit, from probes and never from
   * git's message: absent, present but not a commit, or present and unreadable.
   */
  private async classifyRevision(error: unknown, objectId: string): Promise<Error> {
    if (!(error instanceof TrustedGitError) || error.kind !== "exit") {
      return this.classify(error, []);
    }
    let type: string | undefined;
    try {
      type = (await this.run(["cat-file", "-t", "--end-of-options", objectId])).toString().trim();
    } catch {
      type = undefined;
    }
    if (type === "blob" || type === "tree") return new GitHistoryError("history-revision-invalid");
    if (type !== undefined) return new GitHistoryError("history-git-failed");
    return this.classify(error, [objectId]);
  }

  /**
   * Map a failed read to a code. Only an exit is probed: an object it needed
   * that is absent is missing (or unavailable in a partial clone); when every
   * object is present, the failure is a defect, never a missing object.
   */
  private async classify(error: unknown, objects: readonly string[]): Promise<Error> {
    if (error instanceof GitHistoryError) return error;
    if (!(error instanceof TrustedGitError)) return new GitHistoryError("history-git-failed");
    if (error.kind === "timeout") return new GitHistoryError("history-timeout");
    if (error.kind === "output-bound") return new GitHistoryError("history-output-too-large");
    if (error.kind !== "exit") return new GitHistoryError("history-git-failed");
    for (const objectId of objects) {
      if (!(await this.objectPresent(objectId))) return this.missing();
    }
    return new GitHistoryError("history-git-failed");
  }

  private async missing(): Promise<GitHistoryError> {
    if (await this.isPartialClone()) return new GitHistoryError("history-object-unavailable");
    if ((await this.shallowCommits()).size > 0) {
      return new GitHistoryError(
        "history-object-missing",
        "This checkout is a shallow clone, so history older than its cut is not present; deepen the operator checkout (git fetch --deepen or --unshallow) to read it.",
      );
    }
    return new GitHistoryError("history-object-missing");
  }

  private async objectPresent(objectId: string): Promise<boolean> {
    // Git before 2.45 ignores GIT_NO_LAZY_FETCH: there `cat-file -e` on a
    // promised object tries a fetch the closed protocol policy blocks and
    // exits 128, which would read as a defect. Ask the local store instead.
    if (await this.isPartialClone()) return this.locallyPresent([objectId]);
    try {
      await this.run(["cat-file", "-e", "--end-of-options", objectId]);
      return true;
    } catch (error) {
      if (error instanceof TrustedGitError && error.kind === "exit" && error.exitCode === GIT_NO) {
        return false;
      }
      throw await this.classify(error, []);
    }
  }

  /**
   * Whether the local object store holds every named object, read without a
   * lazy fetch on any git version: `rev-list --missing` turns lazy fetching
   * off, and `--ignore-missing` lists an absent named object as nothing, where
   * older git (2.39, for one) exits on it even under `--missing=print`. A
   * named object is listed whatever the filter; `tree:0` keeps a commit from
   * listing its whole tree.
   */
  private async locallyPresent(objectIds: readonly string[]): Promise<boolean> {
    // Each stdin line is read as a revision; only a full id may reach it.
    if (!objectIds.every((objectId) => OBJECT_ID_PATTERN.test(objectId))) {
      failGitHistory("history-git-failed");
    }
    let output: Buffer;
    try {
      output = await this.run(
        [
          "rev-list",
          "--objects",
          "--no-walk",
          "--missing=print",
          "--ignore-missing",
          "--filter=tree:0",
          "--no-object-names",
          "--stdin",
        ],
        MAX_GIT_OUTPUT_BYTES,
        Buffer.from(`${objectIds.join("\n")}\n`, "utf8"),
      );
    } catch (error) {
      throw await this.classify(error, []);
    }
    // A held object is listed as "<id>"; a missing one as "?<id>" or not at all.
    const listed = new Set(output.toString("utf8").split("\n"));
    return objectIds.every((objectId) => listed.has(objectId));
  }

  private async readShallowCommits(): Promise<ReadonlySet<string>> {
    try {
      const shallow = (await this.run(["rev-parse", "--is-shallow-repository"])).toString().trim();
      if (shallow !== "true") return new Set();
      const location = (await this.run(["rev-parse", "--git-path", "shallow"])).toString().trim();
      const file = isAbsolute(location) ? location : resolve(this.sourcePath, location);
      const text = await readFile(file, "utf8");
      return new Set(text.split("\n").filter((line) => OBJECT_ID_PATTERN.test(line)));
    } catch (error) {
      throw await this.classify(error, []);
    }
  }

  private async readPartialClone(): Promise<boolean> {
    try {
      const entries = (
        await this.run([
          "config",
          "--local",
          "--null",
          "--get-regexp",
          "^(remote\\..*\\.promisor|extensions\\.partialclone)$",
        ])
      )
        .toString("utf8")
        .split("\0")
        .filter(Boolean);
      return entries.some((entry) => {
        const separator = entry.indexOf("\n");
        const key = separator < 0 ? entry : entry.slice(0, separator);
        const value = separator < 0 ? "" : entry.slice(separator + 1).toLowerCase();
        return key === "extensions.partialclone" || ["true", "yes", "on", "1"].includes(value);
      });
    } catch (error) {
      // `git config --get-regexp` exits 1 when no key matches.
      if (error instanceof TrustedGitError && error.kind === "exit" && error.exitCode === GIT_NO) {
        return false;
      }
      throw await this.classify(error, []);
    }
  }

  private run(args: readonly string[], maximumBytes?: number, input?: Buffer): Promise<Buffer> {
    return this.git(this.sourcePath, [...HISTORY_GIT_OPTIONS, ...args], maximumBytes, input);
  }
}

/** One `--raw -z` record: the two object ids, the status letter, and its one or two names. */
interface RawDiffRecord {
  readonly oldId: string;
  readonly newId: string;
  readonly status: string;
  /** Null for a name that is not UTF-8. */
  readonly paths: readonly (string | null)[];
}

/** `--raw -z` output split on NUL, each byte kept as one character. */
function rawTokens(output: Buffer): string[] {
  const tokens = output.toString("latin1").split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  return tokens;
}

/**
 * `diff-tree --stdin --always --raw -z` output: each input pair's child id,
 * then that pair's records. Names are consumed by count after each record,
 * so a name spelled like an object id is never read as the next pair.
 */
function parseRawDiffs(
  output: Buffer,
): Array<{ readonly commit: string; readonly records: RawDiffRecord[] }> {
  const tokens = rawTokens(output);
  const groups: Array<{ commit: string; records: RawDiffRecord[] }> = [];
  let index = 0;
  while (index < tokens.length) {
    const commit = tokens[index]!;
    if (!OBJECT_ID_PATTERN.test(commit)) failGitHistory("history-git-failed");
    let end = index + 1;
    while (end < tokens.length && tokens[end]!.startsWith(":")) {
      end += 1 + rawNameCount(tokens[end]!);
    }
    groups.push({
      commit,
      records: parseRawRecords(tokens.slice(index + 1, end)),
    });
    index = end;
  }
  return groups;
}

/** How many names follow a raw record: two for a rename or copy, else one. */
function rawNameCount(record: string): number {
  const status = record.split(" ")[RAW_STATUS_FIELD] ?? "";
  return status.startsWith("R") || status.startsWith("C") ? 2 : 1;
}

/** Raw records, each a `:`-led field list followed by its names. */
function parseRawRecords(tokens: readonly string[]): RawDiffRecord[] {
  const records: RawDiffRecord[] = [];
  let index = 0;
  while (index < tokens.length) {
    const fields = tokens[index]!.startsWith(":") ? tokens[index]!.slice(1).split(" ") : [];
    const [, , oldId = "", newId = "", status = ""] = fields;
    const count = rawNameCount(tokens[index]!);
    const names = tokens.slice(index + 1, index + 1 + count);
    if (
      fields.length !== RAW_RECORD_FIELDS ||
      !OBJECT_ID_PATTERN.test(oldId) ||
      !OBJECT_ID_PATTERN.test(newId) ||
      names.length !== count
    ) {
      failGitHistory("history-git-failed");
    }
    records.push({
      oldId,
      newId,
      status: status.charAt(0),
      paths: names.map(utf8Name),
    });
    index += 1 + count;
  }
  return records;
}

/**
 * `log -S --name-only -z` output in `SEARCH_RECORD_FORMAT`, each byte kept as
 * one character until a field is decoded. Framing that does not hold, a
 * header that is not ids, or an empty name is a defect, never a guess.
 */
function parseSearchRecords(output: Buffer): HistorySearchMatch[] {
  if (output.length === 0) return [];
  const text = output.toString("latin1");
  if (!text.startsWith(SEARCH_RECORD_START) || !text.endsWith("\0")) {
    failGitHistory("history-git-failed");
  }
  return text
    .slice(SEARCH_RECORD_START.length, -1)
    .split(SEARCH_RECORD_BOUNDARY)
    .map((record) => {
      const headerEnd = record.indexOf(SEARCH_HEADER_END);
      if (headerEnd < 0) failGitHistory("history-git-failed");
      const header = Buffer.from(record.slice(0, headerEnd), "latin1").toString("utf8");
      const names = record.slice(headerEnd + SEARCH_HEADER_END.length).split("\0");
      const [commit = "", parents = "", committedAt = "", ...subject] = header.split("\x1f");
      const parentIds = parents ? parents.split(" ") : [];
      if (
        !OBJECT_ID_PATTERN.test(commit) ||
        !parentIds.every((id) => OBJECT_ID_PATTERN.test(id)) ||
        names.some((name) => name.length === 0)
      ) {
        failGitHistory("history-git-failed");
      }
      return {
        commit,
        parents: parentIds,
        committedAt,
        subject: subject.join("\x1f"),
        paths: names.map(utf8Name),
      };
    });
}

/**
 * `blame --porcelain` output for lines `start` through `end`. Each line is a
 * header (`<id> <source line> <line>[ <group size>]`), the commit's details
 * the first time it appears (or again when it has more than one name), and
 * the line itself after a tab. Details are read only for the file's name and
 * its parent's name; the text is not read here.
 */
function parseBlamePorcelain(output: Buffer, start: number, end: number): HistoryBlameLine[] {
  const records = output.toString("latin1").split("\n");
  if (records.at(-1) === "") records.pop();
  const names = new Map<string, string | null>();
  const previous = new Map<string, Array<string | null>>();
  const lines: HistoryBlameLine[] = [];
  let current: { commit: string; sourceLine: number; line: number } | undefined;
  for (const record of records) {
    if (current === undefined) {
      const header = BLAME_HEADER_PATTERN.exec(record);
      if (!header) failGitHistory("history-git-failed");
      current = {
        commit: header[1]!,
        sourceLine: Number(header[2]),
        line: Number(header[3]),
      };
    } else if (record.startsWith("\t")) {
      const sourcePath = names.get(current.commit);
      if (sourcePath === undefined) failGitHistory("history-git-failed");
      lines.push({
        ...current,
        sourcePath,
        previousPaths: previous.get(current.commit) ?? [],
      });
      current = undefined;
    } else if (record.startsWith(BLAME_FILENAME_KEY)) {
      names.set(current.commit, gitQuotedName(record.slice(BLAME_FILENAME_KEY.length)));
    } else if (record.startsWith(BLAME_PREVIOUS_KEY)) {
      const rest = record.slice(BLAME_PREVIOUS_KEY.length);
      const separator = rest.indexOf(" ");
      if (separator < 0 || !OBJECT_ID_PATTERN.test(rest.slice(0, separator))) {
        failGitHistory("history-git-failed");
      }
      const seen = previous.get(current.commit) ?? [];
      seen.push(gitQuotedName(rest.slice(separator + 1)));
      previous.set(current.commit, seen);
    }
  }
  if (
    current !== undefined ||
    lines.length !== end - start + 1 ||
    lines.some((entry, index) => entry.line !== start + index)
  ) {
    failGitHistory("history-git-failed");
  }
  return lines;
}

/** A name as `--raw -z` writes it, one character per byte; null when it is not UTF-8. */
function utf8Name(bytes: string): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(bytes, "latin1"));
  } catch {
    return null;
  }
}

/** A name as blame writes it under `core.quotePath=false`: bare, or C-quoted. */
function gitQuotedName(value: string): string | null {
  if (!value.startsWith('"')) return utf8Name(value);
  if (value.length < 2 || !value.endsWith('"')) return null;
  const letters = new Map([...C_QUOTE_ESCAPES].map(([character, letter]) => [letter, character]));
  let bytes = "";
  const body = value.slice(1, -1);
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!;
    if (character !== "\\") {
      bytes += character;
      continue;
    }
    const next = body[index + 1] ?? "";
    const octal = body.slice(index + 1, index + 1 + OCTAL_ESCAPE_DIGITS);
    if (letters.has(next)) {
      bytes += letters.get(next)!;
      index += 1;
    } else if (OCTAL_ESCAPE_PATTERN.test(octal)) {
      bytes += String.fromCharCode(Number.parseInt(octal, OCTAL_RADIX));
      index += OCTAL_ESCAPE_DIGITS;
    } else {
      return null;
    }
  }
  return utf8Name(bytes);
}

/**
 * The sections of `patch` whose header names exactly `path` on both sides, in
 * git's order. A change of type (file to symlink or submodule, or back) is two
 * such sections, a deletion then an addition; every other path's section is
 * dropped. No such section is a defect: the path came from git's own list of
 * what changed.
 */
function patchSection(patch: string, path: string): string {
  const header = `${PATCH_SECTION_HEADER}${quotedPatchName("a/", path)} ${quotedPatchName("b/", path)}\n`;
  const sections: string[] = [];
  for (const line of patch.split(/(?<=\n)/u)) {
    if (sections.length === 0 || line.startsWith(PATCH_SECTION_HEADER)) sections.push(line);
    else sections[sections.length - 1] += line;
  }
  const matching = sections.filter((section) => section.startsWith(header));
  if (matching.length === 0) failGitHistory("history-git-failed");
  return matching.join("");
}

/** A patch header name as git writes it with `core.quotePath=false`. */
function quotedPatchName(prefix: string, path: string): string {
  let quoted = "";
  let needsQuotes = false;
  for (const character of `${prefix}${path}`) {
    const code = character.codePointAt(0)!;
    const letter = C_QUOTE_ESCAPES.get(character);
    if (letter !== undefined) {
      quoted += `\\${letter}`;
      needsQuotes = true;
    } else if (code < ASCII_CONTROL_END || code === ASCII_DELETE) {
      quoted += `\\${code.toString(OCTAL_RADIX).padStart(OCTAL_ESCAPE_DIGITS, "0")}`;
      needsQuotes = true;
    } else {
      quoted += character;
    }
  }
  return needsQuotes ? `"${quoted}"` : quoted;
}
