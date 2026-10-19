// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve a github.com pull request, commit, or compare URL into a
 * forge-reported `ChangeSourceV1` plus its two originals, before any model call.
 *
 * Everything recorded is what the GitHub REST API reported, read anonymously
 * (see `github-transport.ts`). The repository is pinned by its
 * numeric id after the first read, and every later read names commits and
 * trees by full id, so only the pull request object itself can move; its head
 * is read again last and a moved head refuses.
 *
 * Range by pull request state:
 * - open: `three-dot` from the target branch's current tip to the head, so
 *   the diff runs from their merge base, as GitHub shows it;
 * - merged (merge commit, squash, or rebase): `three-dot` from the base and
 *   head the pull request recorded, which stop moving at merge, checked
 *   against the pull request's own commit and file counts;
 * - closed without merging: refused.
 * A commit URL is `first-parent-commit`. A compare URL pins both refs to
 * commit ids first and always asks GitHub for `<base id>...<head id>`:
 * `A...B` is `three-dot`; `A..B` is `two-dot` and is read only when the
 * merge base is A, where both forms list the same files and hunks.
 *
 * Completeness comes from the totals GitHub declares (commit and file counts,
 * added and removed lines, `rel="next"` links, tree `truncated`), never from
 * GitHub's own page caps, and the file list must name exactly the paths that
 * differ between the two root trees. Modes and blob ids come from those trees.
 * A file GitHub sent no patch for is listed with a `forge-omitted` omission.
 */
import { canonicalJson } from "../../content-ir/canonical.js";
import { refuseLimit, type ResolveLimitsOptions } from "../../config/limits.js";
import { findConfiguredCredentialInValue } from "../../security/configured-credentials.js";
import { assertChangeSourceExtractable } from "./acquisition.js";
import {
  createChangeSource,
  failChangeSource,
  GIT_EMPTY_TREE_IDS,
  type ChangeSourceBodyV1,
  type ChangeSourceCommitV1,
  type ChangeSourceFileStatus,
  type ChangeSourceFileV1,
  type ChangeSourceMemberV1,
  type ResolvedChangeSourceV1,
} from "../change-source.js";
import type {
  GithubCommitSourceV1,
  GithubCompareSourceV1,
  GithubPullRequestSourceV1,
} from "./github-member.js";
import {
  createGithubApiClient,
  GITHUB_PAGE_SIZE,
  githubApiLimits,
  type GithubApiClient,
  type GithubApiLimitsV1,
  type GithubFetchPort,
} from "./github-transport.js";
import {
  GITHUB_HOST,
  type GithubChangeSourceSelectorV1,
  type GithubCommitSelectorV1,
  type GithubCompareSelectorV1,
  type GithubPullRequestSelectorV1,
} from "./github-url.js";
import { fileLine, modeType, quotePath } from "./diff-text.js";
import { changeSourceLimits, type ChangeSourceLimitsV1 } from "./local.js";
import { createPinnedRepositoryRevision, githubRepositoryIdentity } from "./revision.js";
import { sourceExtractionLimits } from "../source-extraction.js";

/** GitHub repositories use SHA-1 object ids. */
const OBJECT_ID = /^[0-9a-f]{40}$/u;
/**
 * Items asked of the commit listing that pins a compare ref: it starts at the
 * ref's own commit, and a listing carries no file list or patches.
 */
const GITHUB_PIN_PAGE_SIZE = 1;
const ZERO_ID = "0".repeat(GIT_EMPTY_TREE_IDS.sha1.length);
/** Git's empty blob, SHA-1: an added or deleted empty file has no hunk to send. */
const EMPTY_BLOB_ID = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
/** The sides that carry no content: absent, or the empty file. */
const NO_CONTENT_IDS: ReadonlySet<string> = new Set([ZERO_ID, EMPTY_BLOB_ID]);
const TREE_MODE = /^[0-7]{6}$/u;

const FILE_STATUSES: Readonly<Record<string, ChangeSourceFileStatus>> = Object.freeze({
  added: "A",
  removed: "D",
  modified: "M",
  changed: "M",
  renamed: "R",
  copied: "C",
});

export interface ResolveGithubChangeSourceInput {
  readonly selector: GithubChangeSourceSelectorV1;
  readonly signal?: AbortSignal;
  readonly limits?: ResolveLimitsOptions;
  readonly onStatus?: (message: string) => void;
  /** Test seam; production calls the global `fetch`. */
  readonly fetch?: GithubFetchPort;
}

type GithubSourceV1 = GithubPullRequestSourceV1 | GithubCommitSourceV1 | GithubCompareSourceV1;

/* ---------- reading GitHub's JSON: every field checked, nothing coerced ---------- */

function invalid(field: string): never {
  return failChangeSource("change-source-github-response-invalid", field);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
}

function list(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(field);
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") invalid(field);
  return value;
}

function count(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(field);
  return value;
}

function objectId(value: unknown, field: string): string {
  if (typeof value !== "string" || !OBJECT_ID.test(value)) invalid(field);
  return value;
}

/** In a `u` pattern a surrogate pair is one code point, so this matches only a lone surrogate. */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/** Forge text kept byte for byte: no lone surrogate (it has no UTF-8 form) and, for names, no NUL. */
function wellFormed(value: string, name: boolean): string {
  if (LONE_SURROGATE.test(value) || (name && value.includes("\0"))) {
    failChangeSource("change-source-encoding-unsupported");
  }
  return value;
}

/* ---------- the reads ---------- */

interface PullRequest {
  readonly number: number;
  readonly open: boolean;
  readonly merged: boolean;
  readonly baseSha: string;
  readonly baseRef: string;
  readonly headSha: string;
  readonly repositoryId: number;
  readonly fullName: string;
  readonly headRepositoryId: number | null;
  readonly commits: number;
  readonly changedFiles: number;
}

function readPull(value: unknown): PullRequest {
  const root = record(value, "pull request");
  const base = record(root.base, "pull request base");
  const head = record(root.head, "pull request head");
  const baseRepository = record(base.repo, "pull request base.repo");
  const state = text(root.state, "pull request state");
  if (state !== "open" && state !== "closed") invalid("pull request state");
  if (typeof root.merged !== "boolean") invalid("pull request merged");
  return {
    number: count(root.number, "pull request number"),
    open: state === "open",
    merged: root.merged,
    baseSha: objectId(base.sha, "pull request base.sha"),
    baseRef: text(base.ref, "pull request base.ref"),
    headSha: objectId(head.sha, "pull request head.sha"),
    repositoryId: count(baseRepository.id, "pull request base.repo.id"),
    fullName: text(baseRepository.full_name, "pull request base.repo.full_name"),
    headRepositoryId:
      head.repo === null
        ? null
        : count(record(head.repo, "pull request head.repo").id, "pull request head.repo.id"),
    commits: count(root.commits, "pull request commits"),
    changedFiles: count(root.changed_files, "pull request changed_files"),
  };
}

interface ForgeCommit {
  readonly id: string;
  readonly tree: string;
  readonly parents: readonly string[];
  readonly subject: string;
}

function readCommit(value: unknown, field: string): ForgeCommit {
  const root = record(value, field);
  const detail = record(root.commit, `${field} commit`);
  const message = wellFormed(text(detail.message, `${field} message`), false);
  const firstLine = message.indexOf("\n");
  return {
    id: objectId(root.sha, `${field} sha`),
    tree: objectId(record(detail.tree, `${field} tree`).sha, `${field} tree.sha`),
    parents: list(root.parents, `${field} parents`).map((parent) =>
      objectId(record(parent, `${field} parent`).sha, `${field} parent sha`),
    ),
    subject: wellFormed(firstLine < 0 ? message : message.slice(0, firstLine), true),
  };
}

interface ForgeFile {
  readonly status: string;
  readonly path: string;
  readonly previousPath: string | null;
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string | null;
}

function readFile(value: unknown): ForgeFile {
  const root = record(value, "file");
  const patch =
    root.patch === undefined || root.patch === "" ? null : text(root.patch, "file patch");
  return {
    status: text(root.status, "file status"),
    path: wellFormed(text(root.filename, "file filename"), true),
    previousPath:
      root.previous_filename === undefined
        ? null
        : wellFormed(text(root.previous_filename, "file previous_filename"), true),
    additions: count(root.additions, "file additions"),
    deletions: count(root.deletions, "file deletions"),
    patch: patch === null ? null : wellFormed(patch, false),
  };
}

interface TreeEntry {
  readonly mode: string;
  readonly id: string;
}

/**
 * Read paged listings, following only `rel="next"`: a full page with no next
 * link is the last page. Every page counts against the resolution's page
 * bound, refused one page past it.
 */
class Pager {
  private read = 0;

  public constructor(
    private readonly client: GithubApiClient,
    private readonly limits: GithubApiLimitsV1,
  ) {}

  public async *pages(first: string): AsyncGenerator<unknown> {
    let next: string | null = first;
    while (next !== null) {
      if (this.read + 1 > this.limits.pages.value) refuseLimit(this.limits.pages, this.read + 1);
      this.read += 1;
      const page = await this.client.get(next);
      next = page.next;
      yield page.body;
    }
  }
}

async function readTree(
  client: GithubApiClient,
  api: string,
  id: string,
): Promise<Map<string, TreeEntry>> {
  const root = record((await client.get(`${api}/git/trees/${id}?recursive=1`)).body, "tree");
  if (objectId(root.sha, "tree sha") !== id) invalid("tree sha");
  if (root.truncated !== false) {
    if (root.truncated === true) failChangeSource("change-source-github-tree-truncated");
    invalid("tree truncated");
  }
  const entries = new Map<string, TreeEntry>();
  for (const entry of list(root.tree, "tree entries")) {
    const item = record(entry, "tree entry");
    if (item.type === "tree") continue;
    const mode = text(item.mode, "tree entry mode");
    if (!TREE_MODE.test(mode)) invalid("tree entry mode");
    entries.set(text(item.path, "tree entry path"), {
      mode,
      id: objectId(item.sha, "tree entry sha"),
    });
  }
  return entries;
}

/* ---------- building the record ---------- */

interface BuiltFile {
  readonly file: ChangeSourceFileV1;
  readonly section?: string;
}

/**
 * One file: its manifest entry from GitHub's file entry and the two trees,
 * and its `diff --git` section in git's own header shape around GitHub's hunks.
 */
function buildFile(
  forge: ForgeFile,
  baseTree: ReadonlyMap<string, TreeEntry>,
  headTree: ReadonlyMap<string, TreeEntry>,
  limits: ChangeSourceLimitsV1,
): BuiltFile {
  const mapped = FILE_STATUSES[forge.status];
  if (mapped === undefined || !Object.hasOwn(FILE_STATUSES, forge.status)) invalid("file status");
  const renamed = mapped === "R" || mapped === "C";
  if (renamed !== (forge.previousPath !== null)) invalid("file previous_filename");
  const oldPath = mapped === "A" ? null : (forge.previousPath ?? forge.path);
  const newPath = mapped === "D" ? null : forge.path;
  const before = oldPath === null ? undefined : baseTree.get(oldPath);
  const after = newPath === null ? undefined : headTree.get(newPath);
  if ((oldPath !== null && before === undefined) || (newPath !== null && after === undefined)) {
    invalid("file missing from its tree");
  }
  const status: ChangeSourceFileStatus =
    mapped === "M" && modeType(before!.mode) !== modeType(after!.mode) ? "T" : mapped;
  const file: Omit<ChangeSourceFileV1, "diffOmitted"> = {
    status,
    // GitHub reports no rename score.
    similarity: null,
    oldPath,
    newPath,
    oldMode: before?.mode ?? null,
    newMode: after?.mode ?? null,
    oldBlob: before?.id ?? null,
    newBlob: after?.id ?? null,
    // GitHub does not say whether a file is binary; a file it sends no
    // patch for carries the forge omission below instead.
    binary: false,
    added: forge.additions,
    removed: forge.deletions,
  };
  const a = quotePath(`a/${oldPath ?? newPath}`);
  const b = quotePath(`b/${newPath ?? oldPath}`);
  const header = [`diff --git ${a} ${b}`];
  if (before && after && before.mode !== after.mode)
    header.push(`old mode ${before.mode}`, `new mode ${after.mode}`);
  if (!before) header.push(`new file mode ${after!.mode}`);
  if (!after) header.push(`deleted file mode ${before!.mode}`);
  if (renamed) {
    const verb = mapped === "R" ? "rename" : "copy";
    header.push(`${verb} from ${quotePath(oldPath!)}`, `${verb} to ${quotePath(newPath!)}`);
  }
  const oldId = before?.id ?? ZERO_ID;
  const newId = after?.id ?? ZERO_ID;
  if (oldId !== newId) {
    header.push(
      `index ${oldId}..${newId}${before && after && before.mode === after.mode ? ` ${after.mode}` : ""}`,
    );
  }
  if (forge.patch === null) {
    // No hunk is missing only when the content did not change: a pure rename
    // or mode change, or an empty file added or deleted. Filling or emptying
    // a file changes content, so GitHub left that diff out (binary, too
    // large, or not rendered) without saying which.
    const unchanged = oldId === newId || (NO_CONTENT_IDS.has(oldId) && NO_CONTENT_IDS.has(newId));
    if (!unchanged) {
      return {
        file: {
          ...file,
          diffOmitted: {
            code: "change-source-file-diff-omitted",
            basis: "forge-omitted",
            forgeReason: "no-patch",
          },
        },
      };
    }
    return { file, section: `${header.join("\n")}\n` };
  }
  const section = `${[
    ...header,
    fileLine("---", before ? a : "/dev/null"),
    fileLine("+++", after ? b : "/dev/null"),
    forge.patch,
  ].join("\n")}\n`;
  const bytes = Buffer.byteLength(section, "utf8");
  if (bytes > limits.fileDiffBytes.value) {
    return {
      file: {
        ...file,
        diffOmitted: {
          code: "change-source-file-diff-omitted",
          observedBytes: bytes,
          basis: "measured",
          limitName: limits.fileDiffBytes.name,
          limitBytes: limits.fileDiffBytes.value,
        },
      },
    };
  }
  return { file, section };
}

/**
 * Check the forge's file list against the two trees it was read between. The
 * paths that differ between the trees (files, symlinks and submodules; a
 * directory is no entry) must be exactly the listed paths plus each rename's
 * old path; a copy's source is unchanged. Sets, not counts, are compared, so
 * a list of the right length naming other files still refuses.
 *
 * `changeSources.changedFilesMax` applies to the trees' count first, with each
 * listed rename counted once, so a change over the bound refuses with its
 * size rather than as an incomplete list.
 */
function assertFilesMatchTrees(
  files: readonly ForgeFile[],
  baseTree: ReadonlyMap<string, TreeEntry>,
  headTree: ReadonlyMap<string, TreeEntry>,
  limits: ChangeSourceLimitsV1,
): void {
  const changed = new Set<string>();
  for (const [path, before] of baseTree) {
    const after = headTree.get(path);
    if (after === undefined || after.mode !== before.mode || after.id !== before.id) {
      changed.add(path);
    }
  }
  for (const path of headTree.keys()) if (!baseTree.has(path)) changed.add(path);
  // `named`: each entry's own path, once; `renamedFrom`: old paths no entry names.
  const named = new Set<string>();
  const renamedFrom = new Set<string>();
  let repeated = 0;
  for (const forge of files) {
    if (named.has(forge.path)) repeated += 1;
    named.add(forge.path);
    if (forge.status === "renamed" && forge.previousPath !== null) {
      renamedFrom.add(forge.previousPath);
    }
  }
  for (const path of named) renamedFrom.delete(path);
  const listed = new Set([...named, ...renamedFrom]);
  const changedFiles = changed.size - [...renamedFrom].filter((path) => changed.has(path)).length;
  if (changedFiles > limits.changedFiles.value) refuseLimit(limits.changedFiles, changedFiles);
  const extra = repeated + [...listed].filter((path) => !changed.has(path)).length;
  const missing = [...changed].filter((path) => !listed.has(path)).length;
  if (extra > 0 || missing > 0) {
    failChangeSource(
      "change-source-github-incomplete",
      `files: ${extra} listed that the trees do not change, ${missing} changed in the trees and not listed`,
    );
  }
}

interface ForgeRange {
  readonly source: GithubSourceV1;
  readonly repositoryId: number;
  readonly rangeSemantics: "two-dot" | "three-dot" | "first-parent-commit";
  readonly base: string | null;
  readonly head: string;
  readonly mergeBase: string | null;
  readonly diffFrom: string | null;
  readonly baseTree: string;
  readonly headTree: string;
  readonly commits: readonly ForgeCommit[];
  readonly files: readonly ForgeFile[];
}

async function seal(
  client: GithubApiClient,
  range: ForgeRange,
  limits: ChangeSourceLimitsV1,
  options: ResolveLimitsOptions | undefined,
): Promise<ResolvedChangeSourceV1<ChangeSourceMemberV1>> {
  const api = `/repositories/${range.repositoryId}`;
  const emptyTree = GIT_EMPTY_TREE_IDS.sha1;
  const baseTree =
    range.baseTree === emptyTree
      ? new Map<string, TreeEntry>()
      : await readTree(client, api, range.baseTree);
  const headTree = await readTree(client, api, range.headTree);
  assertFilesMatchTrees(range.files, baseTree, headTree, limits);
  const built = range.files.map((forge) => buildFile(forge, baseTree, headTree, limits));
  const diffText = built.map((entry) => entry.section ?? "").join("");
  const diffBytes = Buffer.from(diffText, "utf8");
  if (diffBytes.length > limits.diffBytes.value) refuseLimit(limits.diffBytes, diffBytes.length);
  const commits: ChangeSourceCommitV1[] = range.commits.map((entry) => ({
    id: entry.id,
    parents: entry.parents,
    subject: entry.subject,
  }));
  const body: ChangeSourceBodyV1<ChangeSourceMemberV1> = {
    source: range.source,
    revision: createPinnedRepositoryRevision({
      repository: githubRepositoryIdentity({
        host: GITHUB_HOST,
        repositoryId: range.repositoryId,
      }),
      ...(range.base === null ? {} : { base: range.base }),
      head: range.head,
    }),
    objectFormat: "sha1",
    rangeSemantics: range.rangeSemantics,
    mergeBase: range.mergeBase,
    diffFrom: range.diffFrom,
    baseTree: range.baseTree,
    headTree: range.headTree,
    commits,
    files: built.map((entry) => entry.file),
    // The workspace and shallow-history labels are git facts about a local
    // checkout; a forge-reported record decides none of them.
    labels: [],
    protocol: { provider: "github" },
  };
  // The same screen as a local range: an exact configured credential refuses
  // before sealing; credential-shaped forge text is content, admitted.
  if (findConfiguredCredentialInValue(body) || findConfiguredCredentialInValue(diffText)) {
    failChangeSource("change-source-credential-present");
  }
  const changeSource = createChangeSource(body);
  const manifestText = `${JSON.stringify(JSON.parse(canonicalJson(changeSource)), null, 2)}\n`;
  const resolved = {
    changeSource,
    manifestBytes: new TextEncoder().encode(manifestText),
    diffBytes: new Uint8Array(diffBytes),
  };
  await assertChangeSourceExtractable(resolved, sourceExtractionLimits(options), options);
  return resolved;
}

/* ---------- the kinds ---------- */

/** `git/ref` path segments, each encoded, so a branch name cannot change the path. */
function refPath(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

interface ForgeCompare {
  readonly declaredCommits: number;
  readonly mergeBase: ForgeCommit;
  readonly commits: readonly ForgeCommit[];
  readonly files: readonly ForgeFile[];
}

/**
 * Read `compare/<base>...<head>` between two full commit ids, every page,
 * and refuse a commit list short of the total GitHub declared. Always `...`:
 * the file list is checked against the merge base's tree, which says nothing
 * about which hunks a two-dot diff would hold.
 */
async function readCompare(
  pager: Pager,
  api: string,
  base: string,
  head: string,
  limits: ChangeSourceLimitsV1,
): Promise<ForgeCompare> {
  let mergeBase: ForgeCommit | undefined;
  let declaredCommits = -1;
  const commits: ForgeCommit[] = [];
  const files: ForgeFile[] = [];
  for await (const page of pager.pages(
    `${api}/compare/${base}...${head}?per_page=${GITHUB_PAGE_SIZE}`,
  )) {
    const root = record(page, "compare");
    const total = count(root.total_commits, "compare total_commits");
    if (declaredCommits === -1) {
      declaredCommits = total;
      if (total > limits.commits.value) refuseLimit(limits.commits, total);
      mergeBase = readCommit(root.merge_base_commit, "compare merge_base_commit");
      // GitHub sends the file list on the first page only.
      for (const entry of list(root.files ?? [], "compare files")) files.push(readFile(entry));
    } else if (total !== declaredCommits) {
      invalid("compare total_commits");
    }
    for (const entry of list(root.commits, "compare commits")) {
      commits.push(readCommit(entry, "compare commit"));
      if (commits.length > limits.commits.value) refuseLimit(limits.commits, commits.length);
    }
  }
  if (commits.length !== declaredCommits) {
    failChangeSource(
      "change-source-github-incomplete",
      `commits: ${commits.length} of ${declaredCommits}`,
    );
  }
  return { declaredCommits, mergeBase: mergeBase!, commits, files };
}

async function resolvePull(
  selector: GithubPullRequestSelectorV1,
  client: GithubApiClient,
  pager: Pager,
  limits: ChangeSourceLimitsV1,
): Promise<ForgeRange> {
  const first = readPull(
    (await client.get(`/repos/${selector.owner}/${selector.repository}/pulls/${selector.number}`))
      .body,
  );
  if (first.number !== selector.number) invalid("pull request number");
  if (!first.open && !first.merged) failChangeSource("change-source-github-pull-closed-unmerged");
  if (first.open && first.merged) invalid("pull request merged");
  // From here the repository is named by id, so a rename or a new repository
  // under the old name cannot change what is read.
  const api = `/repositories/${first.repositoryId}`;
  if (first.changedFiles > limits.changedFiles.value)
    refuseLimit(limits.changedFiles, first.changedFiles);
  let base = first.baseSha;
  if (first.open) {
    const ref = record(
      (await client.get(`${api}/git/ref/heads/${refPath(first.baseRef)}`)).body,
      "base ref",
    );
    const target = record(ref.object, "base ref object");
    if (target.type !== "commit") invalid("base ref object type");
    base = objectId(target.sha, "base ref object sha");
  }

  const { declaredCommits, mergeBase, commits, files } = await readCompare(
    pager,
    api,
    base,
    first.headSha,
    limits,
  );
  // A head already inside the base tip has no change left to diff.
  if (declaredCommits === 0) failChangeSource("change-source-empty-range");
  if (first.merged && declaredCommits !== first.commits) {
    failChangeSource(
      "change-source-github-incomplete",
      `commits: ${declaredCommits} compared, ${first.commits} on the pull request`,
    );
  }
  if (files.length !== first.changedFiles) {
    failChangeSource(
      "change-source-github-incomplete",
      `files: ${files.length} of ${first.changedFiles}`,
    );
  }
  const headCommit = commits.find((entry) => entry.id === first.headSha);
  if (headCommit === undefined) invalid("compare commits head");
  return {
    source: {
      kind: "github-pull-request",
      provenance: "forge-reported",
      host: GITHUB_HOST,
      repositoryId: first.repositoryId,
      fullName: first.fullName,
      number: first.number,
      state: first.merged ? "merged" : "open",
      headRepositoryId: first.headRepositoryId,
    },
    repositoryId: first.repositoryId,
    rangeSemantics: "three-dot",
    base,
    head: first.headSha,
    mergeBase: mergeBase.id,
    diffFrom: mergeBase.id,
    baseTree: mergeBase.tree,
    headTree: headCommit.tree,
    commits,
    files,
  };
}

/** Re-read the pull request last: a head that moved since the first read refuses; a moved base does not. */
async function assertHeadUnmoved(
  selector: GithubPullRequestSelectorV1,
  client: GithubApiClient,
  range: ForgeRange,
): Promise<void> {
  const again = readPull(
    (await client.get(`/repositories/${range.repositoryId}/pulls/${selector.number}`)).body,
  );
  if (again.number !== selector.number || again.repositoryId !== range.repositoryId) {
    invalid("pull request identity");
  }
  if (again.headSha !== range.head) failChangeSource("change-source-github-head-moved");
}

/** The repository named in the URL, read once; every later read names it by id. */
async function readRepository(
  selector: GithubCommitSelectorV1 | GithubCompareSelectorV1,
  client: GithubApiClient,
): Promise<{ readonly repositoryId: number; readonly fullName: string }> {
  const repository = record(
    (await client.get(`/repos/${selector.owner}/${selector.repository}`)).body,
    "repository",
  );
  return {
    repositoryId: count(repository.id, "repository id"),
    fullName: text(repository.full_name, "repository full_name"),
  };
}

async function resolveCommit(
  selector: GithubCommitSelectorV1,
  client: GithubApiClient,
  pager: Pager,
  limits: ChangeSourceLimitsV1,
): Promise<ForgeRange> {
  const { repositoryId, fullName } = await readRepository(selector, client);
  const api = `/repositories/${repositoryId}`;
  let commit: ForgeCommit | undefined;
  let declared = { additions: 0, deletions: 0 };
  const files: ForgeFile[] = [];
  for await (const page of pager.pages(
    `${api}/commits/${selector.commit}?per_page=${GITHUB_PAGE_SIZE}`,
  )) {
    const root = record(page, "commit");
    const read = readCommit(root, "commit");
    // An abbreviated id is pinned to the full id GitHub resolved, which must extend it.
    if (!read.id.startsWith(selector.commit) || (commit !== undefined && read.id !== commit.id)) {
      invalid("commit sha");
    }
    if (commit === undefined) {
      const stats = record(root.stats, "commit stats");
      declared = {
        additions: count(stats.additions, "commit stats additions"),
        deletions: count(stats.deletions, "commit stats deletions"),
      };
    }
    commit = read;
    for (const entry of list(root.files, "commit files")) {
      files.push(readFile(entry));
      if (files.length > limits.changedFiles.value) refuseLimit(limits.changedFiles, files.length);
    }
  }
  // GitHub declares no file count for a commit; its line totals must match
  // the files listed, or the list was cut short.
  const additions = files.reduce((sum, entry) => sum + entry.additions, 0);
  const deletions = files.reduce((sum, entry) => sum + entry.deletions, 0);
  if (additions !== declared.additions || deletions !== declared.deletions) {
    failChangeSource(
      "change-source-github-incomplete",
      `lines: ${additions}+${deletions} listed of ${declared.additions}+${declared.deletions}`,
    );
  }
  const head = commit!;
  const parent = head.parents[0] ?? null;
  const parentTree =
    parent === null
      ? GIT_EMPTY_TREE_IDS.sha1
      : objectId(
          record(
            record((await client.get(`${api}/git/commits/${parent}`)).body, "parent commit").tree,
            "parent tree",
          ).sha,
          "parent tree sha",
        );
  return {
    source: {
      kind: "github-commit",
      provenance: "forge-reported",
      host: GITHUB_HOST,
      repositoryId,
      fullName,
    },
    repositoryId,
    rangeSemantics: "first-parent-commit",
    base: parent,
    head: head.id,
    mergeBase: null,
    diffFrom: parent,
    baseTree: parentTree,
    headTree: head.tree,
    commits: [head],
    files,
  };
}

/**
 * Pin one compare ref to its commit: the commit listing that starts at the
 * ref returns that commit first. A full commit id must come back as itself;
 * a shorter name may be a branch or tag, so GitHub's answer is the pin.
 */
async function pinRef(client: GithubApiClient, api: string, ref: string): Promise<string> {
  const listing = list(
    (
      await client.get(
        `${api}/commits?sha=${encodeURIComponent(ref)}&per_page=${GITHUB_PIN_PAGE_SIZE}`,
      )
    ).body,
    "commit listing",
  );
  if (listing.length === 0) invalid("commit listing");
  const pinned = readCommit(listing[0], "commit listing commit").id;
  if (OBJECT_ID.test(ref.toLowerCase()) && pinned !== ref.toLowerCase()) invalid("commit sha");
  return pinned;
}

async function resolveCompare(
  selector: GithubCompareSelectorV1,
  client: GithubApiClient,
  pager: Pager,
  limits: ChangeSourceLimitsV1,
): Promise<ForgeRange> {
  const { repositoryId, fullName } = await readRepository(selector, client);
  const api = `/repositories/${repositoryId}`;
  // Both refs are pinned before the compare, so a branch that moves between
  // reads cannot change what the compare names.
  const base = await pinRef(client, api, selector.base);
  const head = await pinRef(client, api, selector.head);
  const { declaredCommits, mergeBase, commits, files } = await readCompare(
    pager,
    api,
    base,
    head,
    limits,
  );
  // Two-dot diffs from base itself. GitHub's `...` answer lists the same files
  // and hunks only when base is the merge base, so any other two-dot (the two
  // diverged, or head is behind base) refuses rather than bind a mislabelled diff.
  if (selector.form === "two-dot" && mergeBase.id !== base) {
    failChangeSource("change-source-github-two-dot-not-ancestor");
  }
  // Head is base, or already in base's history: nothing to diff.
  if (declaredCommits === 0) failChangeSource("change-source-empty-range");
  const headCommit = commits.find((entry) => entry.id === head);
  if (headCommit === undefined) invalid("compare commits head");
  return {
    source: {
      kind: "github-compare",
      provenance: "forge-reported",
      host: GITHUB_HOST,
      repositoryId,
      fullName,
    },
    repositoryId,
    rangeSemantics: selector.form,
    base,
    head,
    mergeBase: mergeBase.id,
    // Equal for two-dot, which is read only when the merge base is base.
    diffFrom: selector.form === "three-dot" ? mergeBase.id : base,
    baseTree: mergeBase.tree,
    headTree: headCommit.tree,
    commits,
    files,
  };
}

/**
 * Resolve and bound a GitHub selector. Refuses with a coded
 * `ChangeSourceError` or `OperationalLimitError`; never truncates.
 */
export async function resolveGithubChangeSource(
  input: ResolveGithubChangeSourceInput,
): Promise<ResolvedChangeSourceV1<ChangeSourceMemberV1>> {
  const limits = changeSourceLimits(input.limits);
  const apiLimits = githubApiLimits(input.limits);
  const client = createGithubApiClient({
    limits: apiLimits,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  const pager = new Pager(client, apiLimits);
  const { selector } = input;
  const range =
    selector.source === "github-pull-request"
      ? await resolvePull(selector, client, pager, limits)
      : selector.source === "github-commit"
        ? await resolveCommit(selector, client, pager, limits)
        : await resolveCompare(selector, client, pager, limits);
  const resolved = await seal(client, range, limits, input.limits);
  if (selector.source === "github-pull-request") await assertHeadUnmoved(selector, client, range);
  input.onStatus?.(`change source: ${client.requests()} anonymous GitHub API request(s)`);
  return resolved;
}
