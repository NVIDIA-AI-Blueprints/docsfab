// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The GitLab merge request change source. One `get` read pins the merge
 * request's commits; the diff is then read from this checkout's own objects
 * through the local resolver (`local-verified`), so every id and byte is
 * verified here. Only when the checkout lacks an object that diff reads is
 * it read from GitLab's own diff instead (`forge-reported`, see
 * `gitlab-forge.ts`); DocsFab never fetches.
 *
 * Which commits the diff reads follows GitLab's own merge request diff: an
 * open request diffs its base to its head; a merged one diffs its merge or
 * squash commit against the first parent, or base to head after a
 * fast-forward merge.
 */
import {
  MAX_GIT_OUTPUT_BYTES,
  runTrustedGit,
  TrustedGitError,
} from "../../host-invoker/trusted-git.js";
import type { ResolveLimitsOptions } from "../../config/limits.js";
import type { ReadOnlyCommandResult } from "../../delivery/command-types.js";
import { ExecInitCommandRunner } from "../../init/shared.js";
import type { CommandRunner } from "../../init/types.js";
import {
  changeRequestSelectorUsesCheckout,
  failChangeRequestSelector,
  type ChangeRequestSelectorV1,
} from "../change-request-selector.js";
import {
  ChangeSourceError,
  failChangeSource,
  type ChangeSourceLabel,
  type ChangeSourceMemberV1,
  type ChangeSourceV1,
  type GitLabMergeRequestSelectorV1,
  type GitLabMergeRequestSourceV1,
  type LocalRangeSelectorV1,
  type ResolvedChangeSourceV1,
} from "../change-source.js";
import { resolveGitLabMergeRequestFromForge } from "./gitlab-forge.js";
import { resolveLocalChangeSource } from "./local.js";
import { gitOrFail, parseBatchCheck } from "./objects.js";
import { gitlabProjectIdentity, isGitFullObjectId } from "./revision.js";
import {
  classifyGitLabReadFailure,
  failGitLabSourceProvider,
  type GitLabMrProjectionV1,
} from "../gitlab-source-provider.js";
import { resolveGitLabMergedMrProject } from "../merged-mr-gitlab.js";

export const GITLAB_MERGE_REQUEST_SOURCE_KIND = "gitlab-merge-request" as const;

/** The forge transport the merge request read and the checkout lookup use. */
export interface GitLabMergeRequestForgeAccess {
  readonly commands: CommandRunner;
  readonly environment: NodeJS.ProcessEnv;
}

/** What the one `get` read pins. Only ids, numbers and the canonical path are kept. */
export interface GitLabMergeRequestPinV1 {
  readonly iid: number;
  readonly state: string;
  readonly projectPath: string;
  readonly targetProjectId: number;
  readonly sourceProjectId: number;
  readonly sha: string | null;
  readonly diffRefs: GitLabMergeRequestSourceV1["diffRefs"] | null;
  readonly mergeCommitSha: string | null;
  readonly squashCommitSha: string | null;
  /**
   * GitLab's changed-file count as sent, such as `"22"` or `"1000+"`. Kept
   * raw and never judged here: only the forge arm reads it.
   */
  readonly changesCount: string | null;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    failGitLabSourceProvider("response");
  }
  return value;
}

function nullableObjectId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !isGitFullObjectId(value)) failGitLabSourceProvider("response");
  return value;
}

function objectId(value: unknown): string {
  return nullableObjectId(value) ?? failGitLabSourceProvider("response");
}

/**
 * Project a `get` answer onto the pin. GitLab names the target project in
 * `references.full` as `<path>!<iid>`; any answer about another project or
 * merge request than the one asked about is an invalid response.
 */
export function parseGitLabMergeRequestPin(
  body: unknown,
  asked: { readonly projectPath: string; readonly iid: number },
): GitLabMergeRequestPinV1 {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    failGitLabSourceProvider("response");
  }
  const item = body as Record<string, unknown>;
  const iid = positiveInteger(item.iid);
  const targetProjectId = positiveInteger(item.target_project_id);
  const references = item.references as { full?: unknown } | null | undefined;
  const full = typeof references?.full === "string" ? references.full : "";
  const suffix = `!${iid}`;
  const projectPath = full.endsWith(suffix) ? full.slice(0, -suffix.length) : "";
  if (
    iid !== asked.iid ||
    positiveInteger(item.project_id) !== targetProjectId ||
    typeof item.state !== "string" ||
    // GitLab matches paths case-insensitively and answers with its own spelling.
    projectPath.toLowerCase() !== asked.projectPath.toLowerCase()
  ) {
    failGitLabSourceProvider("response");
  }
  const refs = item.diff_refs;
  if (refs !== null && (typeof refs !== "object" || Array.isArray(refs))) {
    failGitLabSourceProvider("response");
  }
  const diffRefs = refs as Record<string, unknown> | null;
  return Object.freeze({
    iid,
    state: item.state,
    projectPath,
    targetProjectId,
    sourceProjectId: positiveInteger(item.source_project_id),
    sha: nullableObjectId(item.sha),
    diffRefs:
      diffRefs === null
        ? null
        : Object.freeze({
            base: objectId(diffRefs.base_sha),
            start: objectId(diffRefs.start_sha),
            head: objectId(diffRefs.head_sha),
          }),
    mergeCommitSha: nullableObjectId(item.merge_commit_sha),
    squashCommitSha: nullableObjectId(item.squash_commit_sha),
    changesCount: typeof item.changes_count === "string" ? item.changes_count : null,
  });
}

/**
 * One `glab api` GET through the operator's own login: the one transport
 * every merge request read uses, the pin's and the forge arm's alike.
 */
export function runGitLabApiGet(input: {
  readonly host: string;
  readonly endpoint: string;
  readonly repositoryPath: string;
  readonly forge: GitLabMergeRequestForgeAccess;
}): Promise<ReadOnlyCommandResult> {
  return input.forge.commands.run(
    "glab",
    ["api", "--hostname", input.host, "--method", "GET", input.endpoint],
    input.repositoryPath,
    { env: input.forge.environment },
  );
}

/**
 * Read one merge request through the operator's own `glab` login. No upstream
 * text is retained, and stderr reaches only the failure classifier.
 */
export async function readGitLabMergeRequestPin(input: {
  readonly host: string;
  readonly projectPath: string;
  /** Address the project by its pinned numeric id rather than its path. */
  readonly projectId?: number;
  readonly iid: number;
  readonly repositoryPath: string;
  readonly forge: GitLabMergeRequestForgeAccess;
}): Promise<GitLabMergeRequestPinV1> {
  // The single-merge-request path the shared reader's `get` requests; it takes no page.
  const project = input.projectId === undefined ? input.projectPath : String(input.projectId);
  const endpoint = `projects/${encodeURIComponent(project)}/merge_requests/${input.iid}`;
  const result = await runGitLabApiGet({
    host: input.host,
    endpoint,
    repositoryPath: input.repositoryPath,
    forge: input.forge,
  }).catch(() => failGitLabSourceProvider("request"));
  if (result.exitCode !== 0) failGitLabSourceProvider(classifyGitLabReadFailure(result));
  let body: unknown;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    // Only the parse runs here, so the one failure is an unparseable answer.
    failGitLabSourceProvider("response");
  }
  return parseGitLabMergeRequestPin(body, { projectPath: input.projectPath, iid: input.iid });
}

/** The local range a pinned merge request diffs, and the member that records it. */
export interface GitLabMergeRequestRangeV1 {
  readonly selector: LocalRangeSelectorV1;
  readonly mergeMode: GitLabMergeRequestSourceV1["mergeMode"];
  readonly state: GitLabMergeRequestSourceV1["state"];
  /** Each commit the mapping names, with the role a refusal reports. */
  readonly endpoints: ReadonlyArray<{ readonly role: string; readonly id: string }>;
}

function localRange(
  form: LocalRangeSelectorV1["form"],
  base: string | null,
  head: string,
): LocalRangeSelectorV1 {
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "docsfab-change-source-selector" as const,
    source: "local-range" as const,
    form,
    base,
    head,
  });
}

/**
 * Map a pin onto the range its diff reads. Two-dot for an open request:
 * GitLab's own merge request diff is base to head, and needs no start commit.
 */
export function mapGitLabMergeRequestRange(
  pin: GitLabMergeRequestPinV1,
): GitLabMergeRequestRangeV1 {
  if (pin.state === "closed") failChangeSource("change-source-mr-closed-unmerged");
  if (pin.state === "locked") failChangeSource("change-source-mr-locked");
  if (pin.state !== "opened" && pin.state !== "merged") failGitLabSourceProvider("response");
  if (pin.diffRefs === null) return failChangeSource("change-source-mr-diff-refs-missing");
  // The diff's head and the request's head are two fields of one answer; a
  // request whose source branch moved under the diff reports both.
  if (pin.sha !== pin.diffRefs.head) failChangeSource("change-source-mr-moved");
  const { base, head } = pin.diffRefs;
  if (pin.state === "opened") {
    return {
      selector: localRange("two-dot", base, head),
      mergeMode: null,
      state: "opened",
      endpoints: [
        { role: "base", id: base },
        { role: "head", id: head },
      ],
    };
  }
  if (pin.mergeCommitSha !== null) {
    return {
      selector: localRange("single-commit", null, pin.mergeCommitSha),
      mergeMode: "merge-commit",
      state: "merged",
      endpoints: [{ role: "merge commit", id: pin.mergeCommitSha }],
    };
  }
  if (pin.squashCommitSha !== null) {
    return {
      selector: localRange("single-commit", null, pin.squashCommitSha),
      mergeMode: "squash",
      state: "merged",
      endpoints: [{ role: "squash commit", id: pin.squashCommitSha }],
    };
  }
  // A fast-forward merge adds no commit of its own: the branch's commits land as they are.
  return {
    selector: localRange("two-dot", base, head),
    mergeMode: "fast-forward",
    state: "merged",
    endpoints: [
      { role: "base", id: base },
      { role: "head", id: head },
    ],
  };
}

interface ProbeContext {
  readonly sourcePath: string;
  readonly signal?: AbortSignal;
  readonly observeGit?: (args: readonly string[]) => void;
}

/**
 * One read-only plumbing call in the checkout. The trusted runner closes the
 * environment and disables lazy fetch; these reads print no diff text, so the
 * resolver's diff and attribute hardening has nothing to act on.
 */
function checkoutGit(context: ProbeContext) {
  return (args: readonly string[], input?: Buffer) => {
    context.observeGit?.(args);
    return gitOrFail(() =>
      runTrustedGit(context.sourcePath, args, context.signal, MAX_GIT_OUTPUT_BYTES, input),
    );
  };
}

/**
 * Ids `cat-file --batch-check` finds with the expected type. In a partial
 * clone, git before 2.44 lazy-fetches a missing id here despite the runner,
 * so there it runs only on ids `heldObjects` has already found.
 */
async function presentObjects(
  git: ReturnType<typeof checkoutGit>,
  ids: readonly string[],
  type: "commit" | "blob",
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const found = parseBatchCheck(
    await git(["cat-file", "--batch-check"], Buffer.from(`${ids.join("\n")}\n`, "latin1")),
  );
  return new Set(ids.filter((id) => found.get(id)?.type === type));
}

/**
 * Lines of one `rev-list --objects --missing=print` read. `--missing` turns
 * lazy fetching off on every git version, so a missing object is listed as
 * `?<id>` instead of fetched; stdin and arguments carry full ids only.
 */
async function missingAwareList(
  git: ReturnType<typeof checkoutGit>,
  args: readonly string[],
  ids: readonly string[],
): Promise<string[]> {
  if (!ids.every(isGitFullObjectId)) failChangeSource("change-source-git-failed");
  const output = await git(
    ["rev-list", "--objects", "--no-walk", "--missing=print", "--no-object-names", ...args],
    Buffer.from(`${ids.join("\n")}\n`, "latin1"),
  );
  return output.toString("latin1").split("\n");
}

/**
 * Ids of `ids` the local store holds, of any type. `--ignore-missing` lists an
 * absent named object as nothing, where git 2.39 exits on it even under
 * `--missing=print`; `tree:0` keeps a named commit from listing its tree.
 */
async function heldObjects(
  git: ReturnType<typeof checkoutGit>,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const listed = new Set(
    await missingAwareList(git, ["--ignore-missing", "--filter=tree:0", "--stdin"], ids),
  );
  return new Set(ids.filter((id) => listed.has(id)));
}

/**
 * Whether the local store holds every tree of each commit. Whole trees
 * over-approximate the subtrees a recursive diff descends, so a partial clone
 * holding only the changed paths' trees refuses too; it never under-reads.
 */
async function treesHeld(
  git: ReturnType<typeof checkoutGit>,
  commits: readonly string[],
): Promise<boolean> {
  const listed = await missingAwareList(
    git,
    ["--ignore-missing", "--filter=blob:none", "--stdin"],
    commits,
  );
  const held = new Set(listed);
  return commits.every((id) => held.has(id)) && !listed.some((line) => line.startsWith("?"));
}

/** Git's spellings of a true boolean; a key with no value is true as well. */
const GIT_TRUE = new Set(["", "true", "yes", "on", "1"]);

/**
 * Whether the checkout is a partial clone: a promisor remote, or the
 * repository extension some git versions set instead. `git config --get-regexp`
 * exits 1 when no key matches; that exit, and only that one, means neither.
 */
async function isPartialClone(context: ProbeContext) {
  const args = [
    "config",
    "--null",
    "--get-regexp",
    "^(extensions\\.partialclone|remote\\..+\\.promisor)$",
  ];
  context.observeGit?.(args);
  let output: Buffer;
  try {
    output = await runTrustedGit(context.sourcePath, args, context.signal);
  } catch (error) {
    if (error instanceof TrustedGitError && error.kind === "exit" && error.exitCode === 1) {
      return false;
    }
    if (error instanceof Error && error.name === "AbortError") throw error;
    return failChangeSource("change-source-git-failed");
  }
  // Each entry is `<key>\n<value>`, NUL-terminated; a key with no value has no newline.
  return output
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0)
    .some((entry) => {
      const newline = entry.indexOf("\n");
      const key = newline < 0 ? entry : entry.slice(0, newline);
      const value = newline < 0 ? "" : entry.slice(newline + 1);
      return key === "extensions.partialclone" || GIT_TRUE.has(value.toLowerCase());
    });
}

const ZERO_OBJECT_ID = /^0+$/u;
const GITLINK_MODE = "160000";

/**
 * The commits whose trees the range's diff compares, old side first: both
 * endpoints, or one commit's first parent and then that commit, the commit
 * alone for a root commit.
 */
async function diffSides(
  git: ReturnType<typeof checkoutGit>,
  selector: LocalRangeSelectorV1,
): Promise<string[]> {
  if (selector.form !== "single-commit") return [selector.base!, selector.head];
  const [line = ""] = (
    await git(["rev-list", "--no-walk", "--parents", "--end-of-options", selector.head])
  )
    .toString("latin1")
    .split("\n");
  const [head, firstParent] = line.split(" ");
  if (head !== selector.head) failChangeSource("change-source-git-failed");
  return firstParent === undefined ? [head] : [firstParent, head];
}

/**
 * Blob ids on either side of the range's raw diff. Raw records without rename
 * detection carry no blob content, so listing them reads trees only.
 */
async function rangeBlobs(
  git: ReturnType<typeof checkoutGit>,
  selector: LocalRangeSelectorV1,
): Promise<string[]> {
  const sides =
    selector.form === "single-commit"
      ? ["--root", "--diff-merges=first-parent", "--no-commit-id", selector.head]
      : [selector.base!, selector.head];
  const fields = (
    await git(["diff-tree", "-r", "-z", "--raw", "--full-index", "--no-renames", ...sides])
  )
    .toString("latin1")
    .split("\0");
  const blobs = new Set<string>();
  for (const field of fields) {
    if (!field.startsWith(":")) continue;
    const [oldMode, newMode, oldBlob, newBlob] = field.slice(1).split(" ");
    for (const [mode, id] of [
      [oldMode, oldBlob],
      [newMode, newBlob],
    ] as const) {
      if (id !== undefined && mode !== GITLINK_MODE && !ZERO_OBJECT_ID.test(id)) blobs.add(id);
    }
  }
  return [...blobs];
}

/**
 * Refuse unless this checkout holds every object the range reads: each named
 * commit, and in a partial clone every tree of each side and each changed
 * blob, since there a missing object is expected rather than damage. Outside
 * a partial clone a missing tree or blob is damage, which the local resolver
 * refuses as a git failure.
 */
async function assertObjectsPresent(
  input: ProbeContext & { readonly range: GitLabMergeRequestRangeV1 },
): Promise<void> {
  const git = checkoutGit(input);
  const ids = input.range.endpoints.map((endpoint) => endpoint.id);
  const partial = await isPartialClone(input);
  const held = partial ? await heldObjects(git, ids) : new Set(ids);
  const commits = await presentObjects(
    git,
    ids.filter((id) => held.has(id)),
    "commit",
  );
  const missing = input.range.endpoints.find((endpoint) => !commits.has(endpoint.id));
  if (missing) failChangeSource("change-source-mr-objects-unavailable", missing.role);
  if (!partial) return;
  const sides = await diffSides(git, input.range.selector);
  // The remediation checks out each side in this order; naming them saves a forge lookup.
  const order = `sides ${sides.join(" then ")}`;
  if (!(await treesHeld(git, sides))) {
    failChangeSource("change-source-mr-objects-unavailable", `tree in a partial clone; ${order}`);
  }
  const blobs = await rangeBlobs(git, input.range.selector);
  const heldBlobs = await heldObjects(git, blobs);
  if (blobs.some((id) => !heldBlobs.has(id))) {
    failChangeSource(
      "change-source-mr-objects-unavailable",
      `file blob in a partial clone; ${order}`,
    );
  }
}

/** Refusals of the local resolver that mean "not in this checkout", never damage. */
const OBJECTS_ABSENT_CODES = new Set([
  "change-source-revision-unresolved",
  "change-source-history-unavailable",
]);

export interface ResolveGitLabMergeRequestChangeSourceInput {
  readonly selector: GitLabMergeRequestSelectorV1;
  readonly sourcePath: string;
  /** Where `glab` runs and the checkout's remote is read for `!N`. */
  readonly repositoryPath: string;
  readonly workspaceRevision: string;
  readonly forge: GitLabMergeRequestForgeAccess;
  readonly signal?: AbortSignal;
  readonly limits?: ResolveLimitsOptions;
  readonly onStatus?: (message: string) => void;
  /** Test seam over every git call: the presence probe's and the local resolver's. */
  readonly observeGit?: (args: readonly string[]) => void;
}

/** The checkout's own GitLab project for `!N`, with `glab` on the forge transport. */
async function checkoutProject(input: ResolveGitLabMergeRequestChangeSourceInput) {
  const local = new ExecInitCommandRunner();
  const project = await resolveGitLabMergedMrProject({
    repositoryPath: input.repositoryPath,
    environment: input.forge.environment,
    commands: {
      run: (command, args, cwd, options) =>
        (command === "glab" ? input.forge.commands : local).run(command, args, cwd, options),
    },
  });
  if (typeof project.projectPath !== "string" || project.projectPath.length === 0) {
    failChangeRequestSelector("checkout-project-unavailable");
  }
  return { host: project.host, projectPath: project.projectPath };
}

/**
 * Resolve a GitLab merge request into a sealed change source, before any
 * model call: from this checkout's own objects when it holds every one the
 * diff reads, else from GitLab's own diff.
 */
export async function resolveGitLabMergeRequestChangeSource(
  input: ResolveGitLabMergeRequestChangeSourceInput,
): Promise<ResolvedChangeSourceV1<ChangeSourceMemberV1>> {
  const { changeRequest } = input.selector;
  const named = changeRequestSelectorUsesCheckout(changeRequest)
    ? await checkoutProject(input)
    : { host: changeRequest.host!, projectPath: changeRequest.projectPath! };
  const pin = await readGitLabMergeRequestPin({
    host: named.host,
    projectPath: named.projectPath,
    iid: changeRequest.number,
    repositoryPath: input.repositoryPath,
    forge: input.forge,
  });
  const range = mapGitLabMergeRequestRange(pin);
  const source: GitLabMergeRequestSourceV1 = {
    kind: GITLAB_MERGE_REQUEST_SOURCE_KIND,
    provenance: "local-verified",
    host: named.host,
    projectPath: pin.projectPath,
    projectId: pin.targetProjectId,
    iid: pin.iid,
    state: range.state,
    mergeMode: range.mergeMode,
    diffRefs: pin.diffRefs!,
    mergeCommit: range.state === "merged" ? pin.mergeCommitSha : null,
    squashCommit: range.state === "merged" ? pin.squashCommitSha : null,
    fork: pin.sourceProjectId !== pin.targetProjectId,
  };
  // The local refusal that sends the diff to GitLab: only "this checkout
  // lacks an object". Integrity, grafts, encoding, credential, limit, bound
  // and git-failure refusals stay themselves and read nothing from GitLab.
  let unavailable: ChangeSourceError | undefined;
  try {
    await assertObjectsPresent({
      sourcePath: input.sourcePath,
      range,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.observeGit ? { observeGit: input.observeGit } : {}),
    });
  } catch (error) {
    // Handles only the probe's "object not here" refusal; its git failures stay themselves.
    if (
      !(error instanceof ChangeSourceError && error.code === "change-source-mr-objects-unavailable")
    ) {
      throw error;
    }
    unavailable = error;
  }
  const labels: ChangeSourceLabel[] = range.state === "opened" ? ["merge-request-unmerged"] : [];
  let resolved: ResolvedChangeSourceV1<ChangeSourceMemberV1> | undefined;
  if (unavailable === undefined) {
    try {
      resolved = await resolveLocalChangeSource({
        sourcePath: input.sourcePath,
        selector: range.selector,
        workspaceRevision: input.workspaceRevision,
        source,
        repository: gitlabProjectIdentity({
          host: named.host,
          projectId: pin.targetProjectId,
        }),
        labels,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.limits ? { limits: input.limits } : {}),
        ...(input.observeGit ? { observeGit: input.observeGit } : {}),
      });
    } catch (error) {
      // Handles only the resolver's "this checkout lacks the history" codes;
      // integrity, grafts, encoding, credential and bound refusals stay themselves.
      if (!(error instanceof ChangeSourceError && OBJECTS_ABSENT_CODES.has(error.code))) {
        throw error;
      }
      unavailable = new ChangeSourceError(
        "change-source-mr-objects-unavailable",
        `commit history, ${error.code}`,
      );
    }
  }
  if (resolved === undefined) {
    const cause = unavailable!.detail ?? "objects";
    resolved = await resolveGitLabMergeRequestFromForge({
      host: named.host,
      pin,
      range,
      source,
      cause,
      read: (endpoint) =>
        runGitLabApiGet({
          host: named.host,
          endpoint,
          repositoryPath: input.repositoryPath,
          forge: input.forge,
        }),
      reread: () =>
        readGitLabMergeRequestPin({
          host: named.host,
          projectPath: pin.projectPath,
          projectId: pin.targetProjectId,
          iid: pin.iid,
          repositoryPath: input.repositoryPath,
          forge: input.forge,
        }),
      ...(input.limits ? { limits: input.limits } : {}),
    });
    input.onStatus?.(
      `change source: merge request !${pin.iid} diff read from GitLab (forge-reported), because this checkout lacks objects it reads: ${unavailable!.code} (${cause})`,
    );
    if (range.selector.form !== "single-commit") {
      input.onStatus?.(
        `change source: GitLab declares no commit count for merge request !${pin.iid}, so its commit list is checked only against the pinned head`,
      );
    }
  }
  if (range.state === "opened") {
    input.onStatus?.(
      `change source: merge request !${pin.iid} is open; its description was not bound, because an open merge request's text can still change`,
    );
  }
  return resolved;
}

/** The merge request a record pins, or undefined for another kind. */
export function gitlabMergeRequestSourceOf(
  changeSource: ChangeSourceV1<ChangeSourceMemberV1>,
): GitLabMergeRequestSourceV1 | undefined {
  const { source } = changeSource;
  return source.kind === GITLAB_MERGE_REQUEST_SOURCE_KIND
    ? (source as GitLabMergeRequestSourceV1)
    : undefined;
}

/**
 * The `--mr` selector whose text binds beside a merged merge request's diff,
 * named by the pinned host and canonical path. An open request's text can
 * still change, so it has none.
 */
export function mergeRequestTextSelector(
  changeSource: ChangeSourceV1<ChangeSourceMemberV1>,
): ChangeRequestSelectorV1 | undefined {
  const source = gitlabMergeRequestSourceOf(changeSource);
  if (source?.state !== "merged") return undefined;
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "docsfab-change-request-selector" as const,
    provider: "gitlab" as const,
    host: source.host,
    projectPath: source.projectPath,
    number: source.iid,
  });
}

/**
 * Refuse merge request text whose merge and squash commits are not the ones
 * the diff was pinned at: the text and the diff would describe two states.
 */
export function assertMergeRequestTextMatchesPin(
  source: GitLabMergeRequestSourceV1,
  projection: Pick<GitLabMrProjectionV1, "mergeCommitSha" | "squashCommitSha">,
): void {
  if (
    projection.mergeCommitSha !== source.mergeCommit ||
    projection.squashCommitSha !== source.squashCommit
  ) {
    failChangeSource("change-source-mr-moved");
  }
}
