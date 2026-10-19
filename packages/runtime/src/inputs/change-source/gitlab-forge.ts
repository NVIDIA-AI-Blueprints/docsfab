// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The GitLab merge request change source, forge arm: the merge request's diff
 * as GitLab reports it, read only when this checkout lacks an object the
 * local arm reads. Every read is a `glab api` GET through the operator's own
 * login, addressed by the pinned numeric project id, so a renamed project
 * cannot change what is read.
 *
 * Reads by range:
 * - open, or merged fast-forward (base to head): the merge request's
 *   `/diffs`, whose item total must equal its `changes_count`, and the commits
 *   `<base>..<head>` from `/repository/commits` in topological order, whose
 *   newest must be the pinned head (GitLab gives no commit count to check);
 * - merged through a merge or squash commit: `/repository/commits/:sha` and
 *   its `/diff`, whose added and removed lines must equal the commit's `stats`.
 * The merge request is read again after the last page; a moved head refuses.
 *
 * GitLab sends a file's hunks without git's header, and no blob or tree ids,
 * so each section's header is written here in git's own shape with no
 * `index` line, and the record carries no trees or blobs. A file whose diff
 * GitLab left empty, or whose text holds U+FFFD, stays listed with a forge
 * omission; nothing is silently dropped.
 */
import { canonicalJson } from "../../content-ir/canonical.js";
import { refuseLimit, type ResolveLimitsOptions, type ResolvedLimit } from "../../config/limits.js";
import type { ReadOnlyCommandResult } from "../../delivery/command-types.js";
import { findConfiguredCredentialInValue } from "../../security/configured-credentials.js";
import { assertChangeSourceExtractable } from "./acquisition.js";
import {
  CHANGE_SOURCE_OBJECT_FORMATS,
  createChangeSource,
  failChangeSource,
  GIT_EMPTY_TREE_IDS,
  type ChangeSourceBodyV1,
  type ChangeSourceCommitV1,
  type ChangeSourceFileStatus,
  type ChangeSourceFileV1,
  type ChangeSourceForgeOmissionReason,
  type ChangeSourceLabel,
  type ChangeSourceMemberV1,
  type ChangeSourceObjectFormat,
  type GitLabMergeRequestSourceV1,
  type ResolvedChangeSourceV1,
} from "../change-source.js";
import { fileLine, modeType, quotePath } from "./diff-text.js";
import type { GitLabMergeRequestPinV1, GitLabMergeRequestRangeV1 } from "./gitlab.js";
import { changeSourceLimits, type ChangeSourceLimitsV1 } from "./local.js";
import {
  createPinnedRepositoryRevision,
  gitlabProjectIdentity,
  isGitFullObjectId,
} from "./revision.js";
import {
  classifyGitLabReadFailure,
  gitlabMrReadEndpoint,
  GitLabSourceProviderError,
} from "../gitlab-source-provider.js";
import { sourceExtractionLimits } from "../source-extraction.js";

/**
 * Items per page on every paged read: GitLab's own maximum, so a listing
 * takes the fewest `glab` calls. A page shorter than this is the last.
 */
export const GITLAB_FORGE_PAGE_SIZE = 100;

/** One forge-arm read. */
export type GitLabForgeRead =
  | { readonly kind: "diffs"; readonly iid: number; readonly page: number }
  | {
      readonly kind: "commits";
      readonly base: string;
      readonly head: string;
      readonly page: number;
    }
  | { readonly kind: "commit"; readonly sha: string }
  | { readonly kind: "commit-diff"; readonly sha: string; readonly page: number };

/** The path of every forge-arm read, each under the pinned numeric project id. */
export function gitlabForgeEndpoint(projectId: number, read: GitLabForgeRead): string {
  const project = `projects/${projectId}`;
  const paging = `per_page=${GITLAB_FORGE_PAGE_SIZE}`;
  switch (read.kind) {
    case "diffs":
      return gitlabMrReadEndpoint({
        operation: "diffs",
        projectPath: String(projectId),
        mergeRequestIid: read.iid,
        limit: GITLAB_FORGE_PAGE_SIZE,
        page: read.page,
      });
    case "commits":
      return `${project}/repository/commits?ref_name=${read.base}..${read.head}&order=topo&${paging}&page=${read.page}`;
    case "commit":
      return `${project}/repository/commits/${read.sha}`;
    case "commit-diff":
      return `${project}/repository/commits/${read.sha}/diff?${paging}&page=${read.page}`;
  }
}

export interface ResolveGitLabMergeRequestFromForgeInput {
  readonly host: string;
  readonly pin: GitLabMergeRequestPinV1;
  readonly range: GitLabMergeRequestRangeV1;
  /** The local member; the record carries it as `forge-reported`. */
  readonly source: GitLabMergeRequestSourceV1;
  /** Why the local arm did not read the diff: its refusal's host-derived detail. */
  readonly cause: string;
  /** One `glab api` GET of an endpoint, through the pin's own transport. */
  readonly read: (endpoint: string) => Promise<ReadOnlyCommandResult>;
  /** The pin's own `get`, read again after the last page. */
  readonly reread: () => Promise<GitLabMergeRequestPinV1>;
  readonly limits?: ResolveLimitsOptions;
}

type ForgeContext = Pick<ResolveGitLabMergeRequestFromForgeInput, "pin" | "cause" | "read">;

/* ---------- reading GitLab's JSON: every field checked, nothing coerced ---------- */

function incomplete(detail: string): never {
  return failChangeSource("change-source-mr-forge-incomplete", detail);
}

/** A forge read that never answered: the local refusal stands, with both causes named. */
function unreadable(context: ForgeContext, failure: string): never {
  return failChangeSource(
    "change-source-mr-objects-unavailable",
    `${context.cause}; GitLab read failed: ${failure}`,
  );
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) incomplete(field);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") incomplete(field);
  return value;
}

function flag(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") incomplete(field);
  return value;
}

function count(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) incomplete(field);
  return value;
}

/**
 * U+FFFD, or a lone surrogate, which has no UTF-8 form and would be written
 * as U+FFFD. Either way the text is not the repository's bytes. In a `u`
 * pattern a surrogate pair is one code point, so only a lone one matches.
 */
const REPLACED_TEXT = /\uFFFD|[\uD800-\uDFFF]/u;

/** A path or subject recorded as GitLab sent it: replaced text refuses, and so does NUL. */
function name(value: unknown, field: string): string {
  const result = text(value, field);
  if (REPLACED_TEXT.test(result)) failChangeSource("change-source-mr-forge-text-replaced", field);
  if (result.includes("\0")) incomplete(field);
  return result;
}

/* ---------- the reads ---------- */

/** One read, parsed. Only the transport's failures fall back to the local refusal. */
async function readJson(context: ForgeContext, read: GitLabForgeRead): Promise<unknown> {
  const field = read.kind;
  const result = await context
    .read(gitlabForgeEndpoint(context.pin.targetProjectId, read))
    .catch(() => undefined);
  if (result === undefined) return unreadable(context, "request");
  // Handles only the runner's own output bound, before the shared classifier
  // folds it into `response`: a cut answer is never parsed. A timeout and
  // every other failure are the transport's.
  if (result.failure === "output-limit") {
    failChangeSource("change-source-mr-forge-page-bound", field);
  }
  if (result.exitCode !== 0) unreadable(context, classifyGitLabReadFailure(result));
  try {
    return JSON.parse(result.stdout);
  } catch {
    // Only the parse runs here, so the one failure is an unparseable answer.
    return incomplete(`${field}: not JSON`);
  }
}

/**
 * Every item of a paged listing. GitLab sends no next-page header to rely
 * on: a page shorter than the page size is the last, so an exact multiple
 * ends with one empty page. A listing within `bound` ends by page
 * `ceil(bound / page size) + 1`; a page past that refuses before it is read.
 */
async function readPages(
  context: ForgeContext,
  read: (page: number) => GitLabForgeRead,
  bound: ResolvedLimit,
): Promise<unknown[]> {
  const lastPage = Math.ceil(bound.value / GITLAB_FORGE_PAGE_SIZE) + 1;
  const items: unknown[] = [];
  for (let page = 1; ; page += 1) {
    if (page > lastPage) refuseLimit(bound, items.length);
    const request = read(page);
    const body = await readJson(context, request);
    if (!Array.isArray(body) || body.length > GITLAB_FORGE_PAGE_SIZE) {
      incomplete(`${request.kind} page ${page}`);
    }
    items.push(...body);
    if (body.length < GITLAB_FORGE_PAGE_SIZE) break;
  }
  if (items.length > bound.value) refuseLimit(bound, items.length);
  return items;
}

interface ForgeCommit {
  readonly id: string;
  readonly parents: readonly string[];
  readonly subject: string;
}

function readCommit(value: unknown, field: string, width: number): ForgeCommit {
  const root = record(value, field);
  const id = objectId(root.id, `${field} id`, width);
  if (!Array.isArray(root.parent_ids)) incomplete(`${field} parent_ids`);
  const message = text(root.message, `${field} message`);
  const firstLine = message.indexOf("\n");
  return {
    id,
    parents: root.parent_ids.map((parent) => objectId(parent, `${field} parent_ids`, width)),
    // The subject is the message's first line, as the local arm reads it; GitLab's `title` is not.
    subject: name(firstLine < 0 ? message : message.slice(0, firstLine), `${field} subject`),
  };
}

function objectId(value: unknown, field: string, width: number): string {
  if (typeof value !== "string" || !isGitFullObjectId(value) || value.length !== width) {
    incomplete(field);
  }
  return value;
}

/* ---------- one changed file ---------- */

/** GitLab writes the mode of a side that does not exist as `"0"`; git writes six zeros. */
const ABSENT_MODE = "000000";
const GIT_MODE = /^[0-7]{6}$/u;

function mode(value: unknown, field: string): string {
  const raw = text(value, field);
  const normalized = raw === "0" ? ABSENT_MODE : raw;
  if (!GIT_MODE.test(normalized)) incomplete(field);
  return normalized;
}

interface ForgeDiff {
  readonly status: ChangeSourceFileStatus;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly oldMode: string;
  readonly newMode: string;
  readonly diff: string;
}

function readDiff(value: unknown): ForgeDiff {
  const root = record(value, "diff item");
  // GitLab's commit diff sends null here and its merge request diff a
  // boolean; a generated file is listed like any other, so only the shape is read.
  const generated = root.generated_file;
  if (generated !== undefined && generated !== null && typeof generated !== "boolean") {
    incomplete("diff item generated_file");
  }
  const added = flag(root.new_file, "diff item new_file");
  const renamed = flag(root.renamed_file, "diff item renamed_file");
  const deleted = flag(root.deleted_file, "diff item deleted_file");
  const oldPath = name(root.old_path, "diff item old_path");
  const newPath = name(root.new_path, "diff item new_path");
  const oldMode = mode(root.a_mode, "diff item a_mode");
  const newMode = mode(root.b_mode, "diff item b_mode");
  if (Number(added) + Number(renamed) + Number(deleted) > 1) incomplete("diff item status");
  if (!renamed && oldPath !== newPath) incomplete("diff item paths");
  // Exactly the sides that exist carry a mode.
  if ((oldMode === ABSENT_MODE) !== added || (newMode === ABSENT_MODE) !== deleted) {
    incomplete("diff item modes");
  }
  const changed: ChangeSourceFileStatus = added ? "A" : deleted ? "D" : renamed ? "R" : "M";
  return {
    // A file that became a symlink or a submodule is a type change, as git reports it.
    status: changed === "M" && modeType(oldMode) !== modeType(newMode) ? "T" : changed,
    oldPath: added ? null : oldPath,
    newPath: deleted ? null : newPath,
    oldMode,
    newMode,
    diff: text(root.diff, "diff item diff"),
  };
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/u;
/** A unified hunk header leaves out a side's line count when it is one. */
const UNWRITTEN_HUNK_LENGTH = 1;

/**
 * Added and removed lines of GitLab's hunk text, or undefined unless it is
 * whole hunks: every hunk holds exactly the lines its header counts.
 */
function hunkLines(diff: string): { added: number; removed: number } | undefined {
  if (!diff.endsWith("\n")) return undefined;
  const lines = diff.slice(0, -1).split("\n");
  let added = 0;
  let removed = 0;
  let index = 0;
  while (index < lines.length) {
    const header = HUNK_HEADER.exec(lines[index]!);
    if (header === null) return undefined;
    let oldLeft = header[1] === undefined ? UNWRITTEN_HUNK_LENGTH : Number(header[1]);
    let newLeft = header[2] === undefined ? UNWRITTEN_HUNK_LENGTH : Number(header[2]);
    index += 1;
    // `\ No newline at end of file` may follow any line, the hunk's last included.
    while (index < lines.length && (oldLeft > 0 || newLeft > 0 || lines[index]!.startsWith("\\"))) {
      const marker = lines[index]!.charAt(0);
      if (marker === " ") {
        oldLeft -= 1;
        newLeft -= 1;
      } else if (marker === "-") {
        oldLeft -= 1;
        removed += 1;
      } else if (marker === "+") {
        newLeft -= 1;
        added += 1;
      } else if (marker !== "\\") {
        return undefined;
      }
      if (oldLeft < 0 || newLeft < 0) return undefined;
      index += 1;
    }
    if (oldLeft !== 0 || newLeft !== 0) return undefined;
  }
  return { added, removed };
}

/** Which of GitLab's diff endpoints a file came from; each reads an empty diff its own way. */
type DiffArm = "merge-request-diffs" | "commit-diff";

interface BuiltFile {
  readonly file: ChangeSourceFileV1;
  readonly section?: string;
  /** Lines GitLab's text holds, for the commit's `stats` check. */
  readonly lines: { readonly added: number; readonly removed: number };
}

function forgeOmitted(
  file: Omit<ChangeSourceFileV1, "diffOmitted">,
  forgeReason: ChangeSourceForgeOmissionReason,
): ChangeSourceFileV1 {
  return {
    ...file,
    diffOmitted: { code: "change-source-file-diff-omitted", basis: "forge-omitted", forgeReason },
  };
}

/**
 * One file: its manifest entry and its `diff --git` section in git's header
 * shape around GitLab's hunks. GitLab's `diff` is whole hunks, the one
 * binary marker line for the file's own paths, or empty; any other shape
 * refuses.
 */
function buildFile(forge: ForgeDiff, arm: DiffArm, limits: ChangeSourceLimitsV1): BuiltFile {
  const { status, oldPath, newPath, oldMode, newMode } = forge;
  const a = quotePath(`a/${oldPath ?? newPath}`);
  const b = quotePath(`b/${newPath ?? oldPath}`);
  const header = [`diff --git ${a} ${b}`];
  if (status !== "A" && status !== "D" && oldMode !== newMode) {
    header.push(`old mode ${oldMode}`, `new mode ${newMode}`);
  }
  if (status === "A") header.push(`new file mode ${newMode}`);
  if (status === "D") header.push(`deleted file mode ${oldMode}`);
  if (status === "R")
    header.push(`rename from ${quotePath(oldPath!)}`, `rename to ${quotePath(newPath!)}`);
  const oldSide = oldPath === null ? "/dev/null" : a;
  const newSide = newPath === null ? "/dev/null" : b;
  const entry = {
    status,
    // GitLab reports no rename score.
    similarity: null,
    oldPath,
    newPath,
    oldMode,
    newMode,
    oldBlob: null,
    newBlob: null,
  };
  // GitLab writes its marker with the raw paths; the record re-emits git's, quoted.
  const rawMarker = `Binary files ${oldPath === null ? "/dev/null" : `a/${oldPath}`} and ${
    newPath === null ? "/dev/null" : `b/${newPath}`
  } differ\n`;
  let lines = { added: 0, removed: 0 };
  let body: string;
  let binary = false;
  if (forge.diff === "") {
    // A merge request diff has no line total to tell an empty diff from one
    // GitLab collapsed, so every empty one is a forge omission. A commit
    // diff's `stats` total proves each empty one holds no line.
    if (arm === "merge-request-diffs") {
      return {
        file: forgeOmitted({ ...entry, binary: false, added: null, removed: null }, "no-patch"),
        lines,
      };
    }
    body = "";
  } else if (forge.diff === rawMarker) {
    binary = true;
    body = `Binary files ${oldSide} and ${newSide} differ\n`;
  } else {
    const counted = forge.diff.startsWith("@@ ") ? hunkLines(forge.diff) : undefined;
    if (counted === undefined) incomplete(`diff of ${status} file`);
    lines = counted;
    body = `${fileLine("---", oldSide)}\n${fileLine("+++", newSide)}\n${forge.diff}`;
  }
  const file: Omit<ChangeSourceFileV1, "diffOmitted"> = {
    ...entry,
    binary,
    added: binary ? null : lines.added,
    removed: binary ? null : lines.removed,
  };
  // Replaced text is not the repository's bytes: the file stays listed, its diff is not bound.
  if (REPLACED_TEXT.test(forge.diff)) return { file: forgeOmitted(file, "text-replaced"), lines };
  const section = `${header.join("\n")}\n${body}`;
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
      lines,
    };
  }
  return { file, section, lines };
}

/** The path a file sorts by: its new path, or its old path when deleted. */
function sortKey(file: ChangeSourceFileV1): Buffer {
  return Buffer.from(file.newPath ?? file.oldPath ?? "", "utf8");
}

/* ---------- the two endpoint arms ---------- */

interface ForgeRange {
  readonly rangeSemantics: "two-dot" | "first-parent-commit";
  readonly base: string | null;
  readonly head: string;
  readonly mergeBase: string | null;
  readonly diffFrom: string | null;
  readonly commits: readonly ForgeCommit[];
  readonly files: readonly BuiltFile[];
}

/** GitLab's changed-file count for `/diffs`, refused unless it is an exact count within the bound. */
function declaredFileCount(pin: GitLabMergeRequestPinV1, limits: ChangeSourceLimitsV1): number {
  const raw = pin.changesCount;
  if (raw === null) return incomplete("changes_count: none");
  const capped = /^(\d+)\+$/u.exec(raw);
  if (capped !== null) {
    // GitLab caps the count it shows; at or past this host's own bound that bound refuses first.
    const atLeast = Number(capped[1]);
    if (atLeast >= limits.changedFiles.value) refuseLimit(limits.changedFiles, atLeast);
    failChangeSource("change-source-mr-forge-overflow", `changes_count ${raw}`);
  }
  if (!/^\d+$/u.test(raw)) incomplete("changes_count");
  const declared = Number(raw);
  if (declared > limits.changedFiles.value) refuseLimit(limits.changedFiles, declared);
  return declared;
}

/** Base to head: the merge request's own diff, and the commits between the two. */
async function readMergeRequestDiffs(
  context: ForgeContext,
  limits: ChangeSourceLimitsV1,
  width: number,
): Promise<ForgeRange> {
  const { pin } = context;
  const { base, head } = pin.diffRefs!;
  const declared = declaredFileCount(pin, limits);
  const items = await readPages(
    context,
    (page) => ({ kind: "diffs", iid: pin.iid, page }),
    limits.changedFiles,
  );
  if (items.length !== declared) incomplete(`files: ${items.length} listed of ${declared}`);
  const files = items.map((item) => buildFile(readDiff(item), "merge-request-diffs", limits));
  const listed = (
    await readPages(context, (page) => ({ kind: "commits", base, head, page }), limits.commits)
  ).map((item) => readCommit(item, "commit", width));
  // GitLab lists newest first and declares no commit count, so the newest
  // listed commit must be the pinned head; nothing checks the count.
  if (listed[0]?.id !== head) incomplete("commits: the newest listed is not the pinned head");
  return {
    rangeSemantics: "two-dot",
    base,
    head,
    // GitLab's diff base is the merge base of the target branch and the head.
    mergeBase: base,
    diffFrom: base,
    commits: [...listed].reverse(),
    files,
  };
}

/** One merge or squash commit against its first parent, checked against its line totals. */
async function readCommitDiff(
  context: ForgeContext,
  limits: ChangeSourceLimitsV1,
  width: number,
  sha: string,
): Promise<ForgeRange> {
  const root = record(await readJson(context, { kind: "commit", sha }), "commit");
  const commit = readCommit(root, "commit", width);
  if (commit.id !== sha) incomplete("commit id");
  const stats = record(root.stats, "commit stats");
  const declared = {
    added: count(stats.additions, "commit stats additions"),
    removed: count(stats.deletions, "commit stats deletions"),
  };
  const files = (
    await readPages(context, (page) => ({ kind: "commit-diff", sha, page }), limits.changedFiles)
  ).map((item) => buildFile(readDiff(item), "commit-diff", limits));
  // No file count exists for a commit; its line totals must match every
  // file's hunks, so a dropped page or a collapsed file refuses.
  const added = files.reduce((sum, entry) => sum + entry.lines.added, 0);
  const removed = files.reduce((sum, entry) => sum + entry.lines.removed, 0);
  if (added !== declared.added || removed !== declared.removed) {
    incomplete(`lines: ${added}+${removed} listed of ${declared.added}+${declared.removed}`);
  }
  const parent = commit.parents[0] ?? null;
  return {
    rangeSemantics: "first-parent-commit",
    base: parent,
    head: sha,
    mergeBase: null,
    diffFrom: parent,
    commits: [commit],
    files,
  };
}

/** The object format whose ids have the pinned head's width. */
function objectFormatOf(head: string): ChangeSourceObjectFormat {
  const format = CHANGE_SOURCE_OBJECT_FORMATS.find(
    (candidate) => GIT_EMPTY_TREE_IDS[candidate].length === head.length,
  );
  return format ?? incomplete("object id width");
}

/** Read the merge request again: a head or base that moved since the pin refuses. */
async function assertUnmoved(
  context: ForgeContext,
  reread: ResolveGitLabMergeRequestFromForgeInput["reread"],
): Promise<void> {
  let again: GitLabMergeRequestPinV1;
  try {
    again = await reread();
  } catch (error) {
    // Handles only the shared reader's own coded failures; anything else is not a GitLab answer.
    if (error instanceof GitLabSourceProviderError) unreadable(context, error.code);
    throw error;
  }
  const { pin } = context;
  if (
    again.sha !== pin.sha ||
    again.diffRefs?.head !== pin.diffRefs!.head ||
    again.diffRefs?.base !== pin.diffRefs!.base
  ) {
    failChangeSource("change-source-mr-moved");
  }
}

/**
 * Read a pinned merge request's diff from GitLab and seal it as a
 * forge-reported record. Refuses with a coded `ChangeSourceError` or
 * `OperationalLimitError`; never truncates.
 */
export async function resolveGitLabMergeRequestFromForge(
  input: ResolveGitLabMergeRequestFromForgeInput,
): Promise<ResolvedChangeSourceV1<ChangeSourceMemberV1>> {
  const limits = changeSourceLimits(input.limits);
  const context: ForgeContext = { pin: input.pin, cause: input.cause, read: input.read };
  const { selector } = input.range;
  const objectFormat = objectFormatOf(selector.head);
  const width = selector.head.length;
  const range =
    selector.form === "single-commit"
      ? await readCommitDiff(context, limits, width, selector.head)
      : await readMergeRequestDiffs(context, limits, width);
  await assertUnmoved(context, input.reread);

  // One stated order on both arms: byte order of the new path, or of the old
  // path for a deletion, which is git's own diff order.
  const built = [...range.files].sort((left, right) =>
    Buffer.compare(sortKey(left.file), sortKey(right.file)),
  );
  const diffText = built.map((entry) => entry.section ?? "").join("");
  const diffBytes = Buffer.from(diffText, "utf8");
  if (diffBytes.length > limits.diffBytes.value) refuseLimit(limits.diffBytes, diffBytes.length);
  const commits: ChangeSourceCommitV1[] = range.commits.map((entry) => ({
    id: entry.id,
    parents: entry.parents,
    subject: entry.subject,
  }));
  const labels: ChangeSourceLabel[] =
    input.range.state === "opened" ? ["merge-request-unmerged"] : [];
  const body: ChangeSourceBodyV1<ChangeSourceMemberV1> = {
    source: { ...input.source, provenance: "forge-reported" },
    revision: createPinnedRepositoryRevision({
      // The target project, never the source project of a fork.
      repository: gitlabProjectIdentity({ host: input.host, projectId: input.pin.targetProjectId }),
      ...(range.base === null ? {} : { base: range.base }),
      head: range.head,
    }),
    objectFormat,
    rangeSemantics: range.rangeSemantics,
    mergeBase: range.mergeBase,
    diffFrom: range.diffFrom,
    baseTree: null,
    headTree: null,
    commits,
    files: built.map((entry) => entry.file),
    // The checkout labels are git facts about local history; GitLab decides none of them.
    labels,
    protocol: { provider: "gitlab" },
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
  await assertChangeSourceExtractable(resolved, sourceExtractionLimits(input.limits), input.limits);
  return resolved;
}
