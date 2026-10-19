// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve a local commit range into a `ChangeSourceV1` plus its two original
 * byte strings: the manifest and the unified diff.
 *
 * Every read is local, read-only plumbing against the checkout's own object
 * database through the trusted git runner: no fetch, no index or lock writes,
 * no hooks, no textconv or external diff, no replace refs, no commit-graph, and
 * no attributes from the working tree. A grafts file refuses, because it
 * would change which commits the range holds. In a shallow checkout the diff
 * stays exact or refuses; a commit list the boundary could make wrong is
 * labelled, not refused. Every commit in the range and both diff-side root
 * trees are re-hashed from their raw bytes; subtrees and blobs are not.
 *
 * The whole range is resolved and bounded here, before any model call; the
 * caller mints observations from the result later.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
  limit,
  refuseLimit,
  type ResolveLimitsOptions,
  type ResolvedLimit,
} from "../../config/limits.js";
import {
  SOURCE_EXTRACTION_MAX_DERIVATIVE_BYTES_LIMIT,
  SOURCE_EXTRACTION_MAX_ORIGINAL_BYTES_LIMIT,
} from "../../config/source-read-limits.js";
import { canonicalJson } from "../../content-ir/canonical.js";
import { MAX_GIT_OUTPUT_BYTES, runTrustedGit } from "../../host-invoker/trusted-git.js";
import { findConfiguredCredentialInValue } from "../../security/configured-credentials.js";
import { sourceExtractionLimits } from "../source-extraction.js";
import { assertChangeSourceExtractable } from "./acquisition.js";
import {
  CHANGE_SOURCE_DIFF_PROTOCOL,
  ChangeSourceContractError,
  changeSourceProvenance,
  createChangeSource,
  failChangeSource,
  GIT_EMPTY_TREE_IDS,
  type ChangeSourceBodyV1,
  type ChangeSourceCommitV1,
  type ChangeSourceFileStatus,
  type ChangeSourceFileV1,
  type ChangeSourceLabel,
  type ChangeSourceMemberV1,
  type ChangeSourceObjectFormat,
  type LocalRangeSelectorV1,
  type ResolvedChangeSourceV1,
  CHANGE_SOURCE_FILE_STATUSES,
} from "../change-source.js";
import {
  decodeUtf8,
  gitOrFail,
  lines,
  parseBatchCheck,
  parseCommit,
  presentIn,
  rawParents,
  readObjects,
  verified,
  type ChangeSourceGitRunner,
  type ParsedCommit,
} from "./objects.js";
import {
  createPinnedRepositoryRevision,
  isGitFullObjectId,
  type PinnedRepositoryIdentityV1,
} from "./revision.js";

export type { ChangeSourceGitRunner } from "./objects.js";

export const CHANGE_SOURCE_COMMITS_MAX_LIMIT = "changeSources.commitsMax" as const;
export const CHANGE_SOURCE_CHANGED_FILES_MAX_LIMIT = "changeSources.changedFilesMax" as const;
export const CHANGE_SOURCE_DIFF_MAX_BYTES_LIMIT = "changeSources.diffMaxBytes" as const;
export const CHANGE_SOURCE_FILE_DIFF_MAX_BYTES_LIMIT = "changeSources.fileDiffMaxBytes" as const;
export const CHANGE_SOURCE_SHALLOW_BOUNDARY_COMMITS_MAX_LIMIT =
  "changeSources.shallowBoundaryCommitsMax" as const;

export interface ChangeSourceLimitsV1 {
  readonly commits: ResolvedLimit;
  readonly changedFiles: ResolvedLimit;
  readonly diffBytes: ResolvedLimit;
  readonly fileDiffBytes: ResolvedLimit;
  readonly shallowBoundaryCommits: ResolvedLimit;
}

/**
 * Resolve the change-source bounds with their host overrides and refuse a set
 * that contradicts itself, before any git read: an admitted diff must survive
 * extraction whole and fit under the sealed git output cap.
 */
export function changeSourceLimits(options?: ResolveLimitsOptions): ChangeSourceLimitsV1 {
  const resolved = {
    commits: limit(CHANGE_SOURCE_COMMITS_MAX_LIMIT, options),
    changedFiles: limit(CHANGE_SOURCE_CHANGED_FILES_MAX_LIMIT, options),
    diffBytes: limit(CHANGE_SOURCE_DIFF_MAX_BYTES_LIMIT, options),
    fileDiffBytes: limit(CHANGE_SOURCE_FILE_DIFF_MAX_BYTES_LIMIT, options),
    shallowBoundaryCommits: limit(CHANGE_SOURCE_SHALLOW_BOUNDARY_COMMITS_MAX_LIMIT, options),
  };
  const diff = resolved.diffBytes.value;
  if (
    resolved.fileDiffBytes.value > diff ||
    diff > limit(SOURCE_EXTRACTION_MAX_ORIGINAL_BYTES_LIMIT, options).value ||
    diff > limit(SOURCE_EXTRACTION_MAX_DERIVATIVE_BYTES_LIMIT, options).value ||
    diff >= MAX_GIT_OUTPUT_BYTES
  ) {
    failChangeSource("change-source-limits-inconsistent");
  }
  return resolved;
}

/** A local range resolves into the generic shape every kind returns. */
export type ResolvedLocalChangeSourceV1 = ResolvedChangeSourceV1;

export interface ResolveLocalChangeSourceInput {
  /** The checkout's top level, as the workspace recorded it. */
  readonly sourcePath: string;
  readonly selector: LocalRangeSelectorV1;
  /**
   * The source member to seal; absent means `{kind: "local-range"}`. A kind
   * whose objects are local may pass its own member, but never a
   * forge-reported one: this resolver verifies every object it records.
   */
  readonly source?: ChangeSourceMemberV1;
  /** The repository identity to seal; absent means the checkout path's digest. */
  readonly repository?: PinnedRepositoryIdentityV1;
  /** Labels the caller's kind knows and git cannot, such as an unmerged merge request. */
  readonly labels?: readonly ChangeSourceLabel[];
  /** The workspace's resolved revision, compared to `head` for a label only. */
  readonly workspaceRevision: string;
  readonly signal?: AbortSignal;
  readonly limits?: ResolveLimitsOptions;
  /**
   * Test seam over the trusted runner. It receives the per-call arguments after
   * the fixed repository selection, so a spy sees every subcommand.
   */
  readonly observeGit?: (args: readonly string[]) => void;
}

/** Per-call hardening the trusted runner does not already apply. */
export function hardening(objectFormat: ChangeSourceObjectFormat): string[] {
  return [
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    `attr.tree=${GIT_EMPTY_TREE_IDS[objectFormat]}`,
    "-c",
    "diff.external=",
    "-c",
    "core.quotePath=true",
    "-c",
    "core.commitGraph=false",
    "-c",
    "core.useReplaceRefs=false",
    // Plumbing diff-tree still honors this repo-local diff setting.
    "-c",
    "diff.suppressBlankEmpty=false",
  ];
}

/** Succeeds when git exits 0; any failure is the probe's negative answer. */
async function probe(run: () => Promise<Buffer>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return false;
  }
}

/** Strip trailing `~N` / `^N` ancestry, leaving the name it is relative to. */
function ancestryRoot(name: string): string {
  const index = name.search(/[~^]/u);
  return index < 0 ? name : name.slice(0, index);
}

interface RawEntry {
  readonly status: ChangeSourceFileStatus;
  readonly similarity: number | null;
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldBlob: string;
  readonly newBlob: string;
  readonly oldPath: string;
  readonly newPath: string;
}

interface NumstatEntry {
  readonly added: number | null;
  readonly removed: number | null;
}

/**
 * Parse `diff-tree -z --raw --numstat`: every raw record, then every numstat
 * record, in the same order. Paths are decoded strictly.
 */
function parseManifestOutput(output: Buffer): { raw: RawEntry[]; numstat: NumstatEntry[] } {
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] === 0) {
      fields.push(output.subarray(start, index));
      start = index + 1;
    }
  }
  const raw: RawEntry[] = [];
  const numstat: NumstatEntry[] = [];
  let index = 0;
  while (index < fields.length && fields[index]![0] === 0x3a) {
    const meta = fields[index]!.toString("latin1").slice(1).split(" ");
    if (meta.length !== 5) failChangeSource("change-source-git-failed");
    const [oldMode, newMode, oldBlob, newBlob, statusField] = meta as [
      string,
      string,
      string,
      string,
      string,
    ];
    const letter = statusField.charAt(0) as ChangeSourceFileStatus;
    if (!(CHANGE_SOURCE_FILE_STATUSES as readonly string[]).includes(letter)) {
      failChangeSource("change-source-git-failed");
    }
    const paired = letter === "R" || letter === "C";
    const first = fields[index + 1];
    const second = paired ? fields[index + 2] : first;
    if (first === undefined || second === undefined) failChangeSource("change-source-git-failed");
    raw.push({
      status: letter,
      similarity: paired ? Number(statusField.slice(1)) : null,
      oldMode,
      newMode,
      oldBlob,
      newBlob,
      oldPath: decodeUtf8(first),
      newPath: decodeUtf8(second),
    });
    index += paired ? 3 : 2;
  }
  while (index < fields.length) {
    // `added<TAB>removed<TAB>path`: split on the first two tabs only, since a
    // path may hold a tab.
    const record = fields[index]!.toString("latin1");
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
    if (secondTab < 0) failChangeSource("change-source-git-failed");
    const stats = [
      record.slice(0, firstTab),
      record.slice(firstTab + 1, secondTab),
      record.slice(secondTab + 1),
    ];
    const binary = stats[0] === "-";
    numstat.push({
      added: binary ? null : Number(stats[0]),
      removed: binary ? null : Number(stats[1]),
    });
    // A rename's numstat record leaves its path field empty and names both paths after it.
    index += stats[2] === "" ? 3 : 1;
  }
  if (numstat.length !== raw.length) failChangeSource("change-source-git-failed");
  return { raw, numstat };
}

/** Patch sections git emits per raw record: a type change is a delete plus an add. */
function sectionsFor(entry: RawEntry): number {
  return entry.status === "T" ? 2 : 1;
}

/** Byte offsets where a `diff --git ` section header starts a line. */
function sectionStarts(patch: Buffer): number[] {
  const marker = Buffer.from("diff --git ", "latin1");
  const starts: number[] = [];
  let offset = 0;
  while (offset < patch.length) {
    const found = patch.indexOf(marker, offset);
    if (found < 0) break;
    if (found === 0 || patch[found - 1] === 0x0a) starts.push(found);
    offset = found + marker.length;
  }
  return starts;
}

const ZERO_ID = /^0+$/u;
const GITLINK_MODE = "160000";
/**
 * Conservative patch-size upper bound for one file, from its blob sizes and
 * line counts. Every old and new byte appears at most once, plus a one-byte
 * line prefix (`byteFactor`); each hunk holds at least one changed line, and
 * its header is two ranges of at most twenty digits each plus git's
 * function-name context of at most eighty bytes (`hunkHeaderBytes`); a path
 * appears in at most four header lines, C-quoted at up to four bytes per byte
 * (`quotedPathFactor`); and the fixed header text, mode lines and
 * end-of-file markers fit in `fixedHeaderBytes`. Used only to group reads and
 * to omit a file too large to read; a kept file's size is always measured.
 */
const UPPER_BOUND = Object.freeze({
  byteFactor: 2,
  hunkHeaderBytes: 256,
  quotedPathFactor: 32,
  fixedHeaderBytes: 1024,
});

function upperBound(
  entry: RawEntry,
  sizes: ReadonlyMap<string, number>,
  stats: NumstatEntry,
): number {
  const oldSize = sizes.get(entry.oldBlob) ?? 0;
  const newSize = sizes.get(entry.newBlob) ?? 0;
  const changedLines = (stats.added ?? 0) + (stats.removed ?? 0);
  const pathBytes =
    Buffer.byteLength(entry.oldPath, "utf8") + Buffer.byteLength(entry.newPath, "utf8");
  return (
    (UPPER_BOUND.byteFactor * (oldSize + newSize) +
      UPPER_BOUND.hunkHeaderBytes * changedLines +
      UPPER_BOUND.quotedPathFactor * pathBytes +
      UPPER_BOUND.fixedHeaderBytes) *
    sectionsFor(entry)
  );
}

/**
 * Resolve and validate the selected range. Refuses with a coded
 * `ChangeSourceError` or `OperationalLimitError`; never truncates.
 */
export async function resolveLocalChangeSource(
  input: ResolveLocalChangeSourceInput,
): Promise<ResolvedLocalChangeSourceV1> {
  // Handles only a caller-supplied member that is forge-reported; a
  // local-verified member of any kind, and the default, go on to resolve.
  if (input.source !== undefined && changeSourceProvenance(input.source) !== "local-verified") {
    throw new ChangeSourceContractError("change-source-contract-invalid-value");
  }
  const limits = changeSourceLimits(input.limits);
  const discovered = lines(
    await gitOrFail(() =>
      runTrustedGit(
        input.sourcePath,
        [
          "rev-parse",
          "--absolute-git-dir",
          "--is-shallow-repository",
          "--show-object-format",
          "--git-common-dir",
          "--git-path",
          "info/attributes",
        ],
        input.signal,
      ),
    ),
  );
  const [gitDir, shallowText, formatText, commonDirText, attributesPath] = discovered;
  if (
    gitDir === undefined ||
    commonDirText === undefined ||
    attributesPath === undefined ||
    !(formatText === "sha1" || formatText === "sha256")
  ) {
    return failChangeSource("change-source-git-failed");
  }
  const objectFormat: ChangeSourceObjectFormat = formatText;
  const shallow = shallowText === "true";
  const inGitDir = (path: string) => (isAbsolute(path) ? path : resolve(input.sourcePath, path));
  // Grafts and the shallow list live in the common directory. Read there, not
  // through `--git-path`, which an environment override can point elsewhere.
  const commonDir = inGitDir(commonDirText);
  if ((await fileSize(join(commonDir, "info", "grafts"))) > 0) {
    failChangeSource("change-source-grafts-present");
  }
  const boundary = shallow ? await shallowBoundary(join(commonDir, "shallow")) : new Set<string>();
  const labels = new Set<ChangeSourceLabel>(input.labels ?? []);
  if ((await fileSize(inGitDir(attributesPath))) > 0) labels.add("info-attributes-present");

  // An empty work tree, so no checked-out or untracked .gitattributes applies
  // on a git without `attr.tree`.
  const workTree = await mkdtemp(join(tmpdir(), "docsfab-change-source-"));
  try {
    const run: ChangeSourceGitRunner = (args, options) => {
      input.observeGit?.(args);
      return runTrustedGit(
        workTree,
        [`--git-dir=${gitDir}`, `--work-tree=${workTree}`, ...hardening(objectFormat), ...args],
        input.signal,
        MAX_GIT_OUTPUT_BYTES,
        options?.input,
      );
    };
    const resolved = await resolveRange({
      run,
      selector: input.selector,
      shallow,
      boundary,
      objectFormat,
      labels,
      limits,
      source: input.source ?? { kind: "local-range" },
      repository: input.repository ?? {
        kind: "local-checkout",
        identitySha256: createHash("sha256").update(input.sourcePath).digest("hex"),
      },
      workspaceRevision: input.workspaceRevision,
    });
    // The manifest's size follows path and subject lengths, which no count
    // bounds, so both originals are extracted here, under the run's
    // extraction limits, rather than first overflowing at acquisition.
    await assertChangeSourceExtractable(
      resolved,
      sourceExtractionLimits(input.limits),
      input.limits,
    );
    return resolved;
  } finally {
    await rm(workTree, { recursive: true, force: true });
  }
}

/** A file's size, or 0 when it does not exist. */
export async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

/** Commits git walks as parentless in a shallow checkout. */
async function shallowBoundary(path: string): Promise<Set<string>> {
  let bytes = Buffer.alloc(0);
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const ids = lines(bytes);
  if (!ids.every(isGitFullObjectId)) failChangeSource("change-source-git-failed");
  return new Set(ids);
}

interface RangeContext {
  readonly run: ChangeSourceGitRunner;
  readonly selector: LocalRangeSelectorV1;
  readonly shallow: boolean;
  readonly boundary: ReadonlySet<string>;
  readonly objectFormat: ChangeSourceObjectFormat;
  readonly labels: Set<ChangeSourceLabel>;
  readonly limits: ChangeSourceLimitsV1;
  readonly source: ChangeSourceMemberV1;
  readonly repository: PinnedRepositoryIdentityV1;
  readonly workspaceRevision: string;
}

async function resolveCommitName(context: RangeContext, name: string): Promise<string> {
  const { run } = context;
  try {
    const [id] = lines(
      await run(["rev-parse", "--verify", "--end-of-options", `${name}^{commit}`]),
    );
    if (id === undefined || !isGitFullObjectId(id)) {
      return failChangeSource("change-source-revision-unresolved");
    }
    return id;
  } catch (error) {
    // Handles only the trusted runner's own failure for this name; a coded
    // refusal raised above and a caller abort pass through.
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (!(error instanceof Error) || "code" in error) throw error;
  }
  // Classify the unresolved name by probes. Only a shallow checkout can be
  // missing history; there, a relative name whose root resolves, or a full id
  // absent from the object database, ran past the clone's depth.
  if (context.shallow) {
    const root = ancestryRoot(name);
    if (
      root !== name &&
      (await probe(() => run(["rev-parse", "--verify", "--end-of-options", `${root}^{commit}`])))
    ) {
      return failChangeSource("change-source-history-unavailable");
    }
    if (isGitFullObjectId(name)) return failChangeSource("change-source-history-unavailable");
  }
  return failChangeSource("change-source-revision-unresolved");
}

async function mergeBaseOf(
  context: RangeContext,
  base: string,
  head: string,
): Promise<string | null> {
  try {
    const [id] = lines(await context.run(["merge-base", "--end-of-options", base, head]));
    return id !== undefined && isGitFullObjectId(id) ? id : null;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
  }
  // merge-base exits non-zero both for unrelated histories and for a failed
  // read. Two complete histories share an ancestor exactly when they share a
  // root commit, so compare roots before calling it "no merge base".
  if (context.shallow) return null;
  const roots = async (id: string) =>
    new Set(
      lines(
        await gitOrFail(() => context.run(["rev-list", "--max-parents=0", "--end-of-options", id])),
      ),
    );
  const baseRoots = await roots(base);
  const headRoots = await roots(head);
  if ([...headRoots].some((root) => baseRoots.has(root))) {
    return failChangeSource("change-source-git-failed");
  }
  return null;
}

/**
 * Refuse a shallow three-dot range whose visible history shows more than one
 * merge base. A boundary can hide the edge that makes one of them the other's
 * ancestor, and git then prints whichever its date order favours, so only full
 * history decides the diff base. A complete clone keeps git's own choice.
 */
async function refuseAmbiguousMergeBase(
  context: RangeContext,
  base: string,
  head: string,
): Promise<void> {
  const bases = lines(
    await gitOrFail(() => context.run(["merge-base", "--all", "--end-of-options", base, head])),
  );
  if (!bases.every(isGitFullObjectId)) failChangeSource("change-source-git-failed");
  if (bases.length > 1) {
    failChangeSource(
      "change-source-history-unavailable",
      `merge bases ${[...bases].sort().join(", ")}: this shallow clone shows more than one, ` +
        "and only full history decides which one git would diff from. " +
        "Run git fetch --unshallow, or use <base>..<head>, whose diff is exact",
    );
  }
}

interface ShallowExclusion {
  /** The diff base plus every present parent the walk found behind a boundary commit. */
  readonly tips: readonly string[];
  /** Whether a boundary commit the diff base reaches names a parent this checkout lacks. */
  readonly frontierMissing: boolean;
  /** Present boundary commits the tips reach. */
  readonly crossed: ReadonlySet<string>;
  /** Boundary commits this checkout holds. */
  readonly present: readonly string[];
}

/**
 * The boundary commits in `pending` that `tips` do not reach. Git walks a
 * boundary commit as parentless, so listing them against the tips names
 * exactly those.
 */
async function unreachedFrom(
  context: RangeContext,
  pending: readonly string[],
  tips: Iterable<string>,
): Promise<Set<string>> {
  const revisions = [...pending, ...[...tips].map((id) => `^${id}`)];
  return new Set(
    lines(
      await gitOrFail(() =>
        context.run(["rev-list", "--stdin"], {
          input: Buffer.from(`${revisions.join("\n")}\n`, "latin1"),
        }),
      ),
    ),
  );
}

/** Whether any of `ids` has history the tips do not reach. */
async function reachesPast(
  context: RangeContext,
  ids: readonly string[],
  tips: readonly string[],
): Promise<boolean> {
  const [countText] = lines(
    await gitOrFail(() =>
      context.run([
        "rev-list",
        "--count",
        "--end-of-options",
        ...ids,
        ...tips.map((id) => `^${id}`),
      ]),
    ),
  );
  const count = Number(countText);
  if (!Number.isSafeInteger(count)) failChangeSource("change-source-git-failed");
  return count > 0;
}

/**
 * Close the diff base's history over the boundary in a shallow checkout. Git
 * walks a boundary commit as parentless, so commits behind it that arrived
 * through another fetch are not excluded and would be listed as part of the
 * range. Between boundaries the recorded parents are the ones git walks
 * (grafts refuse; replace refs and the commit-graph are off), so only each
 * reached boundary commit's raw parents need following, as extra exclusion
 * tips.
 */
async function shallowExclusion(
  context: RangeContext,
  diffFrom: string,
): Promise<ShallowExclusion> {
  const { limits } = context;
  const held = await presentIn(context, [...context.boundary]);
  const boundary = [...context.boundary].filter((id) => held.has(id));
  const tips = new Set([diffFrom]);
  const crossed = new Set<string>();
  let frontierMissing = false;
  for (;;) {
    const pending = boundary.filter((id) => !crossed.has(id));
    if (pending.length === 0) break;
    const unreached = await unreachedFrom(context, pending, tips);
    const reached = pending.filter((id) => !unreached.has(id));
    if (reached.length === 0) break;
    for (const id of reached) crossed.add(id);
    if (crossed.size > limits.shallowBoundaryCommits.value) {
      refuseLimit(limits.shallowBoundaryCommits, crossed.size);
    }
    const parents = (await rawParents(context, reached, "boundary")).filter((id) => !tips.has(id));
    if (parents.length === 0) continue;
    const found = await presentIn(context, parents);
    for (const id of parents) {
      if (found.has(id)) tips.add(id);
      else frontierMissing = true;
    }
  }
  return { tips: [...tips], frontierMissing, crossed, present: boundary };
}

/**
 * Whether base's history crosses a boundary above the merge base, so a newer
 * merge base could sit behind it: a boundary commit base reaches and the
 * exclusion walk did not, whose parent is missing or reaches past the tips.
 */
async function baseCutAboveMergeBase(
  context: RangeContext,
  base: string,
  exclusion: ShallowExclusion,
): Promise<boolean> {
  const pending = exclusion.present.filter((id) => !exclusion.crossed.has(id));
  if (pending.length === 0) return false;
  const unreached = await unreachedFrom(context, pending, [base]);
  const reached = pending.filter((id) => !unreached.has(id));
  if (reached.length === 0) return false;
  const parents = (await rawParents(context, reached, "boundary")).filter(
    (id) => !exclusion.tips.includes(id),
  );
  if (parents.length === 0) return false;
  const found = await presentIn(context, parents);
  if (parents.some((id) => !found.has(id))) return true;
  return reachesPast(context, parents, exclusion.tips);
}

async function resolveRange(context: RangeContext): Promise<ResolvedLocalChangeSourceV1> {
  const { run, selector, limits, objectFormat } = context;
  const head = await resolveCommitName(context, selector.head);
  const base = selector.base === null ? null : await resolveCommitName(context, selector.base);
  if (base !== null && base === head) failChangeSource("change-source-empty-range");

  let mergeBase: string | null = null;
  let diffFrom: string | null;
  let commitIds: string[];
  let exclusion: ShallowExclusion | null = null;
  // Commits the visible ancestry path does not prove to descend from the diff base.
  let unproven: ReadonlySet<string> = new Set();
  if (selector.form === "single-commit") {
    const headObject = verified(
      context,
      await readObjects(context, [head]),
      head,
      "commit",
      "head",
    );
    diffFrom = parseCommit(headObject.body).parents[0] ?? null;
    commitIds = [head];
  } else {
    mergeBase = await mergeBaseOf(context, base!, head);
    // Three-dot diffs from the merge base. In a shallow checkout a missing one
    // may only be past the boundary, so "unrelated" would not be true either.
    if (selector.form === "three-dot" && mergeBase === null) {
      failChangeSource(
        context.shallow ? "change-source-history-unavailable" : "change-source-no-merge-base",
      );
    }
    if (selector.form === "three-dot" && context.shallow) {
      await refuseAmbiguousMergeBase(context, base!, head);
    }
    diffFrom = selector.form === "three-dot" ? mergeBase : base;
    exclusion = context.shallow ? await shallowExclusion(context, diffFrom!) : null;
    const excluded = (exclusion?.tips ?? [diffFrom!]).map((id) => `^${id}`);
    // Counted before listing, so the refusal reports the real number.
    const [countText] = lines(
      await gitOrFail(() => run(["rev-list", "--count", "--end-of-options", head, ...excluded])),
    );
    const commitCount = Number(countText);
    if (!Number.isSafeInteger(commitCount)) failChangeSource("change-source-git-failed");
    if (commitCount > limits.commits.value) refuseLimit(limits.commits, commitCount);
    commitIds = lines(
      await gitOrFail(() =>
        run(["rev-list", "--reverse", "--topo-order", "--end-of-options", head, ...excluded]),
      ),
    );
    if (commitIds.length !== commitCount) failChangeSource("change-source-git-failed");
    // Past a missing parent, a listed commit may still be a hidden ancestor of
    // the diff base. One that descends from the diff base through visible
    // edges cannot be, and shallow truncation only removes edges, so only the
    // others are in doubt: labelled and marked, since the diff is exact.
    if (exclusion?.frontierMissing) {
      const descendants = new Set(
        lines(
          await gitOrFail(() =>
            run(["rev-list", "--ancestry-path", "--end-of-options", head, `^${diffFrom}`]),
          ),
        ),
      );
      unproven = new Set(commitIds.filter((id) => !descendants.has(id)));
      // Three-dot keeps refusing here: the walk below its merge base is cut
      // and the list is in doubt, so the merge base is not trusted either.
      if (unproven.size > 0 && selector.form === "three-dot") {
        failChangeSource("change-source-history-unavailable");
      }
      if (unproven.size > 0) context.labels.add("commit-list-may-include-base-history");
    }
  }
  if (selector.form === "single-commit" && commitIds.length > limits.commits.value) {
    refuseLimit(limits.commits, commitIds.length);
  }

  // Every commit in the range, both endpoints, the merge base and the diff's
  // old side are re-hashed from raw bytes.
  const roles = new Map<string, string>();
  commitIds.forEach((id, index) => roles.set(id, `commit ${index + 1}`));
  if (mergeBase !== null) roles.set(mergeBase, "merge base");
  if (diffFrom !== null && !roles.has(diffFrom)) roles.set(diffFrom, "diff base");
  if (base !== null) roles.set(base, "base");
  roles.set(head, "head");
  const commitObjects = await readObjects(context, [...roles.keys()]);
  const parsed = new Map<string, ParsedCommit>();
  for (const [id, role] of roles) {
    parsed.set(id, parseCommit(verified(context, commitObjects, id, "commit", role).body));
  }
  const marked = context.labels.has("commit-list-may-include-base-history");
  const commits: ChangeSourceCommitV1[] = commitIds.map((id) => ({
    id,
    parents: parsed.get(id)!.parents,
    subject: parsed.get(id)!.subject,
    ...(marked ? { descendsFromDiffBase: !unproven.has(id) } : {}),
  }));

  // Only a shallow boundary may hide a parent; anywhere else a missing parent
  // is a damaged object database.
  const listed = new Set(commitIds);
  const outside = [
    ...new Set(commits.flatMap((entry) => entry.parents).filter((id) => !listed.has(id))),
  ];
  const held = await presentIn(context, outside);
  if (
    commits.some(
      (entry) =>
        !context.boundary.has(entry.id) &&
        entry.parents.some((id) => !listed.has(id) && !held.has(id)),
    )
  ) {
    failChangeSource("change-source-revision-unresolved");
  }
  if (selector.form !== "single-commit") {
    await labelShallowRange(context, { base: base!, mergeBase, commits, held, exclusion });
  }

  const emptyTree = GIT_EMPTY_TREE_IDS[objectFormat];
  const headTree = parsed.get(head)!.tree;
  const baseTree = diffFrom === null ? emptyTree : parsed.get(diffFrom)!.tree;
  const treeObjects = await readObjects(
    context,
    [baseTree, headTree].filter((id) => id !== emptyTree),
  );
  if (baseTree !== emptyTree) verified(context, treeObjects, baseTree, "tree", "base tree");
  if (headTree !== emptyTree) verified(context, treeObjects, headTree, "tree", "head tree");

  const [aheadText] = lines(
    await gitOrFail(() =>
      run(["rev-list", "--count", "--end-of-options", head, `^${context.workspaceRevision}`]),
    ),
  );
  if (Number(aheadText) > 0) context.labels.add("head-not-ancestor-of-workspace");

  const from = diffFrom ?? emptyTree;
  const diffOptions = [
    `-M${CHANGE_SOURCE_DIFF_PROTOCOL.renameSimilarityPercent}%`,
    `-l${limits.changedFiles.value}`,
    "--full-index",
    "--no-ext-diff",
    "--no-textconv",
  ];
  const manifest = parseManifestOutput(
    await gitOrFail(() =>
      run([
        "diff-tree",
        "-r",
        "-z",
        "--raw",
        "--numstat",
        ...diffOptions,
        "--end-of-options",
        from,
        head,
      ]),
    ),
  );
  if (manifest.raw.length > limits.changedFiles.value) {
    refuseLimit(limits.changedFiles, manifest.raw.length);
  }

  const blobs = [
    ...new Set(
      manifest.raw.flatMap((entry) => [
        ...(entry.oldMode === GITLINK_MODE || ZERO_ID.test(entry.oldBlob) ? [] : [entry.oldBlob]),
        ...(entry.newMode === GITLINK_MODE || ZERO_ID.test(entry.newBlob) ? [] : [entry.newBlob]),
      ]),
    ),
  ];
  const sizes = new Map<string, number>();
  if (blobs.length > 0) {
    const checked = await gitOrFail(() =>
      run(["cat-file", "--batch-check"], { input: Buffer.from(`${blobs.join("\n")}\n`, "latin1") }),
    );
    for (const [id, entry] of parseBatchCheck(checked)) {
      if (entry.type === "blob") sizes.set(id, entry.size);
    }
    if (blobs.some((id) => !sizes.has(id))) failChangeSource("change-source-git-failed");
  }

  const files = await readFileDiffs(context, manifest, sizes, from, head, diffOptions);
  const kept = files.filter((entry) => entry.patch !== undefined);
  const diffBytes = Buffer.concat(kept.map((entry) => entry.patch!));
  if (diffBytes.length > limits.diffBytes.value) refuseLimit(limits.diffBytes, diffBytes.length);
  const diffText = decodeUtf8(diffBytes);

  const body: ChangeSourceBodyV1<ChangeSourceMemberV1> = {
    source: context.source,
    revision: createPinnedRepositoryRevision({
      repository: context.repository,
      ...(selector.form === "single-commit"
        ? diffFrom === null
          ? {}
          : { base: diffFrom }
        : { base: base! }),
      head,
    }),
    objectFormat,
    rangeSemantics:
      selector.form === "single-commit"
        ? "first-parent-commit"
        : selector.form === "three-dot"
          ? "three-dot"
          : "two-dot",
    mergeBase,
    diffFrom,
    baseTree,
    headTree,
    commits,
    files: files.map((entry) => entry.file),
    labels: [...context.labels].sort(),
    protocol: CHANGE_SOURCE_DIFF_PROTOCOL,
  };
  // An exact configured credential in a subject, a path or the diff stops
  // here, before sealing, whose own screen would refuse it as a malformed
  // record. Credential-shaped text is repository content and becomes a
  // run-record finding instead.
  if (findConfiguredCredentialInValue(body) || findConfiguredCredentialInValue(diffText)) {
    failChangeSource("change-source-credential-present");
  }
  const changeSource = createChangeSource(body);
  const manifestText = `${JSON.stringify(JSON.parse(canonicalJson(changeSource)), null, 2)}\n`;
  return {
    changeSource,
    manifestBytes: new TextEncoder().encode(manifestText),
    diffBytes: new Uint8Array(diffBytes),
  };
}

/**
 * Decide the shallow-boundary refusal and labels of a range. Git walks a
 * boundary commit as parentless even when its parent arrived through another
 * ref, so commits of the range behind a listed boundary commit may be
 * missing from the list. Its parent is harmless only when the exclusion walk
 * reaches it. A three-dot diff then refuses, because a newer merge base may
 * sit behind that boundary, unless base itself is the merge base; otherwise
 * the list is labelled, because the endpoint diff is exact.
 */
async function labelShallowRange(
  context: RangeContext,
  range: {
    readonly base: string;
    readonly mergeBase: string | null;
    readonly commits: readonly ChangeSourceCommitV1[];
    readonly held: ReadonlySet<string>;
    readonly exclusion: ShallowExclusion | null;
  },
): Promise<void> {
  const { base, mergeBase, commits, held, exclusion } = range;
  const listed = new Set(commits.map((entry) => entry.id));
  const onBoundary = commits.filter((entry) => context.boundary.has(entry.id));
  const behind = [
    ...new Set(
      onBoundary
        .flatMap((entry) => entry.parents)
        .filter((id) => !listed.has(id) && !(exclusion?.tips.includes(id) ?? false)),
    ),
  ];
  const incomplete =
    exclusion !== null &&
    behind.length > 0 &&
    (behind.some((id) => !held.has(id)) || (await reachesPast(context, behind, exclusion.tips)));
  if (
    context.selector.form === "three-dot" &&
    exclusion !== null &&
    mergeBase !== base &&
    (incomplete || (await baseCutAboveMergeBase(context, base, exclusion)))
  ) {
    failChangeSource("change-source-history-unavailable");
  }
  if (incomplete) context.labels.add("commit-list-incomplete-shallow");
  // A two-dot range from a base off head's history, such as a reversed range,
  // also undoes the base's own changes: labelled, not refused. In a shallow
  // checkout git's merge base sees only visible history, so base may still be
  // head's ancestor through a boundary commit: then it is not decided.
  const throughBoundary =
    exclusion !== null && (incomplete || onBoundary.some((entry) => entry.parents.includes(base)));
  if (context.selector.form === "two-dot" && mergeBase !== base && !throughBoundary) {
    context.labels.add("base-not-ancestor-of-head");
  }
}

interface FileDiff {
  readonly file: ChangeSourceFileV1;
  readonly patch?: Buffer;
}

/**
 * Read each file's patch in groups whose summed upper bound fits the git
 * output cap, measure it, and omit (with a label) any file over the per-file
 * bound or whose upper bound alone exceeds the cap.
 */
async function readFileDiffs(
  context: RangeContext,
  manifest: { raw: RawEntry[]; numstat: NumstatEntry[] },
  sizes: ReadonlyMap<string, number>,
  from: string,
  head: string,
  diffOptions: readonly string[],
): Promise<FileDiff[]> {
  const { limits } = context;
  const bounds = manifest.raw.map((entry, index) =>
    upperBound(entry, sizes, manifest.numstat[index]!),
  );
  const patches = new Map<number, Buffer>();
  const readable = manifest.raw
    .map((_, index) => index)
    .filter((index) => bounds[index]! <= MAX_GIT_OUTPUT_BYTES);
  const total = readable.reduce((sum, index) => sum + bounds[index]!, 0);
  const groups: number[][] = [];
  if (readable.length === manifest.raw.length && total <= MAX_GIT_OUTPUT_BYTES) {
    groups.push(readable);
  } else {
    let group: number[] = [];
    let groupBytes = 0;
    for (const index of readable) {
      if (group.length > 0 && groupBytes + bounds[index]! > MAX_GIT_OUTPUT_BYTES) {
        groups.push(group);
        group = [];
        groupBytes = 0;
      }
      group.push(index);
      groupBytes += bounds[index]!;
    }
    if (group.length > 0) groups.push(group);
  }
  const whole = groups.length === 1 && groups[0]!.length === manifest.raw.length;
  for (const group of groups) {
    const pathspecs = whole
      ? []
      : [
          "--",
          ...new Set(
            group.flatMap((index) => [manifest.raw[index]!.oldPath, manifest.raw[index]!.newPath]),
          ),
        ];
    const patch = await gitOrFail(() =>
      context.run([
        ...(whole ? [] : ["--literal-pathspecs"]),
        "diff-tree",
        "-r",
        "-p",
        `-U${CHANGE_SOURCE_DIFF_PROTOCOL.contextLines}`,
        "--src-prefix=a/",
        "--dst-prefix=b/",
        `--diff-algorithm=${CHANGE_SOURCE_DIFF_PROTOCOL.diffAlgorithm}`,
        "--no-color",
        ...diffOptions,
        "--end-of-options",
        from,
        head,
        ...pathspecs,
      ]),
    );
    const starts = sectionStarts(patch);
    const expected = group.reduce((sum, index) => sum + sectionsFor(manifest.raw[index]!), 0);
    if (starts.length !== expected || (starts.length > 0 && starts[0] !== 0)) {
      failChangeSource("change-source-git-failed");
    }
    let section = 0;
    for (const index of group) {
      const count = sectionsFor(manifest.raw[index]!);
      const end = starts[section + count] ?? patch.length;
      patches.set(index, patch.subarray(starts[section]!, end));
      section += count;
    }
  }
  return manifest.raw.map((entry, index) => {
    const stats = manifest.numstat[index]!;
    const file: Omit<ChangeSourceFileV1, "diffOmitted"> = {
      status: entry.status,
      similarity: entry.similarity,
      oldPath: entry.status === "A" ? null : entry.oldPath,
      newPath: entry.status === "D" ? null : entry.newPath,
      oldMode: entry.oldMode,
      newMode: entry.newMode,
      oldBlob: entry.oldBlob,
      newBlob: entry.newBlob,
      binary: stats.added === null,
      added: stats.added,
      removed: stats.removed,
    };
    const patch = patches.get(index);
    const observed = patch === undefined ? bounds[index]! : patch.length;
    if (patch === undefined || patch.length > limits.fileDiffBytes.value) {
      return {
        file: {
          ...file,
          diffOmitted: {
            code: "change-source-file-diff-omitted" as const,
            observedBytes: observed,
            basis: patch === undefined ? ("upper-bound" as const) : ("measured" as const),
            limitName: limits.fileDiffBytes.name,
            limitBytes: limits.fileDiffBytes.value,
          },
        },
      };
    }
    return { file, patch };
  });
}
