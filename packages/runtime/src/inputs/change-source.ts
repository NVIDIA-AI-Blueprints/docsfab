// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one change-source contract. Every way an operator names a code change
 * (a local commit range, a GitHub pull request or commit, or each first-parent
 * unit of a release range today; a GitLab merge request diff and a GitHub
 * compare later) resolves into a `ChangeSourceV1`: a pinned
 * revision pair, its range semantics, the commits and changed paths between
 * them, and labels. A new kind adds one entry to each extension table (its
 * source member and decoder, selector arm, kind arm, producer id, and
 * repository identity member); it never adds a parallel contract.
 *
 * Host code computes every field. Commit subjects are third-party text: they
 * stay inside the manifest observation and never become prompt or instruction
 * text.
 */
import { createContractKit } from "../contract-kit/index.js";
import {
  parseChangeRequestSelector,
  type ChangeRequestSelectorV1,
} from "./change-request-selector.js";
import {
  decodePinnedRepositoryRevisionV1,
  type PinnedRepositoryRevisionV1,
} from "./change-source/revision.js";
import {
  githubSourceDecoders,
  type GithubCommitSourceV1,
  type GithubCompareSourceV1,
  type GithubPullRequestSourceV1,
} from "./change-source/github-member.js";
import {
  githubChangeSourceSelectorArm,
  type GithubChangeSourceSelectorV1,
} from "./change-source/github-url.js";
import {
  releaseRangeSelectorArm,
  releaseRangeSourceDecoder,
  type ReleaseRangeSelectorV1,
  type ReleaseRangeSourceV1,
} from "./change-source/release-member.js";

export const CHANGE_SOURCE_KIND = "docsfab-change-source" as const;
export const CHANGE_SOURCE_DIGEST_KEY = "changeSourceSha256" as const;

/** Closed source kinds: exactly the keys of the shipped source decoder table. */
export const CHANGE_SOURCE_KINDS = [
  "local-range",
  "gitlab-merge-request",
  "github-pull-request",
  "github-commit",
  "github-compare",
  "release-range",
] as const;
export type ChangeSourceKind = (typeof CHANGE_SOURCE_KINDS)[number];

/**
 * Whether the host verified every object id and byte itself
 * (`local-verified`), or recorded what a forge reported (`forge-reported`).
 */
export const CHANGE_SOURCE_PROVENANCES = ["local-verified", "forge-reported"] as const;
export type ChangeSourceProvenance = (typeof CHANGE_SOURCE_PROVENANCES)[number];

/**
 * What every source member carries. A kind whose provenance can vary records
 * it in its own member; a member without `provenance` is `local-verified`.
 */
export interface ChangeSourceMemberV1 {
  readonly kind: string;
  readonly provenance?: ChangeSourceProvenance;
}

export interface LocalRangeSourceV1 {
  readonly kind: "local-range";
}

/** How a merged merge request landed; null while it is open. */
export const GITLAB_MERGE_REQUEST_MERGE_MODES = ["merge-commit", "squash", "fast-forward"] as const;
export type GitLabMergeRequestMergeMode = (typeof GITLAB_MERGE_REQUEST_MERGE_MODES)[number];

/**
 * A GitLab merge request's diff, pinned at the commits GitLab reported: read
 * from this checkout's own objects (`local-verified`), or from GitLab's own
 * diff when the checkout lacks them (`forge-reported`). Project fields name
 * the target project; `fork` records that the source project differs.
 */
export interface GitLabMergeRequestSourceV1 {
  readonly kind: "gitlab-merge-request";
  readonly provenance: ChangeSourceProvenance;
  readonly host: string;
  readonly projectPath: string;
  readonly projectId: number;
  readonly iid: number;
  readonly state: "opened" | "merged";
  readonly mergeMode: GitLabMergeRequestMergeMode | null;
  readonly diffRefs: {
    readonly base: string;
    readonly start: string;
    readonly head: string;
  };
  readonly mergeCommit: string | null;
  readonly squashCommit: string | null;
  readonly fork: boolean;
}

/** The shipped source members, discriminated by `kind`. */
export type ChangeSourceSourceV1 =
  | LocalRangeSourceV1
  | GitLabMergeRequestSourceV1
  | GithubPullRequestSourceV1
  | GithubCommitSourceV1
  | GithubCompareSourceV1
  | ReleaseRangeSourceV1;

/** The one provenance rule every decoder and resolver reads. */
export function changeSourceProvenance(source: ChangeSourceMemberV1): ChangeSourceProvenance {
  return source.provenance ?? "local-verified";
}

export const CHANGE_SOURCE_RANGE_SEMANTICS = [
  "two-dot",
  "three-dot",
  "first-parent-commit",
] as const;
export type ChangeSourceRangeSemantics = (typeof CHANGE_SOURCE_RANGE_SEMANTICS)[number];

export const CHANGE_SOURCE_OBJECT_FORMATS = ["sha1", "sha256"] as const;
export type ChangeSourceObjectFormat = (typeof CHANGE_SOURCE_OBJECT_FORMATS)[number];

export const CHANGE_SOURCE_FILE_STATUSES = ["A", "M", "D", "R", "C", "T"] as const;
export type ChangeSourceFileStatus = (typeof CHANGE_SOURCE_FILE_STATUSES)[number];

export const CHANGE_SOURCE_LABELS = [
  "info-attributes-present",
  "head-not-ancestor-of-workspace",
  "base-not-ancestor-of-head",
  "commit-list-incomplete-shallow",
  "commit-list-may-include-base-history",
  "merge-request-unmerged",
] as const;
export type ChangeSourceLabel = (typeof CHANGE_SOURCE_LABELS)[number];

/**
 * Diff protocol constants, named once and recorded on every contract so a
 * reader can reproduce the exact bytes: rename similarity (`-M<n>%`), context
 * lines (`-U<n>`), and the diff algorithm.
 */
export const CHANGE_SOURCE_DIFF_PROTOCOL = Object.freeze({
  renameSimilarityPercent: 50,
  contextLines: 3,
  diffAlgorithm: "myers",
} as const);

/** Git's empty tree, the old side of a root commit's diff, per object format. */
export const GIT_EMPTY_TREE_IDS: Readonly<Record<ChangeSourceObjectFormat, string>> = Object.freeze(
  {
    sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
  },
);

/** Protocol of a forge-reported record: the forge whose report it holds. */
export const CHANGE_SOURCE_FORGE_PROVIDERS = ["gitlab", "github"] as const;
export type ChangeSourceForgeProvider = (typeof CHANGE_SOURCE_FORGE_PROVIDERS)[number];

export interface ChangeSourceForgeProtocolV1 {
  readonly provider: ChangeSourceForgeProvider;
}

/**
 * Why a forge-reported file's diff is not bound; a forge gives no size for it.
 * `text-replaced`: the forge's diff text holds U+FFFD, so it is not the
 * repository's bytes.
 */
export const CHANGE_SOURCE_FORGE_OMISSION_REASONS = [
  "too-large",
  "collapsed",
  "no-patch",
  "text-replaced",
] as const;
export type ChangeSourceForgeOmissionReason = (typeof CHANGE_SOURCE_FORGE_OMISSION_REASONS)[number];

/** A diff the host left out under one of its own limits. */
export interface ChangeSourceLimitOmissionV1 {
  readonly code: "change-source-file-diff-omitted";
  /** Measured patch bytes, or the computed upper bound when the patch was never read. */
  readonly observedBytes: number;
  readonly basis: "measured" | "upper-bound";
  readonly limitName: string;
  readonly limitBytes: number;
}

/** A diff the forge itself left out; only a forge-reported record carries one. */
export interface ChangeSourceForgeOmissionV1 {
  readonly code: "change-source-file-diff-omitted";
  readonly basis: "forge-omitted";
  readonly forgeReason: ChangeSourceForgeOmissionReason;
}

/** Why a file's diff is absent from the diff observation while the file stays listed. */
export type ChangeSourceDiffOmissionV1 = ChangeSourceLimitOmissionV1 | ChangeSourceForgeOmissionV1;

/**
 * One changed path. Modes and blob ids are null only in a forge-reported record.
 * Similarity is null unless the status is R or C, and added/removed are null for a
 * binary file, in any record; a forge-reported record may also leave them null.
 */
export interface ChangeSourceFileV1 {
  readonly status: ChangeSourceFileStatus;
  /** Rename or copy score from the raw diff; null for every other status. */
  readonly similarity: number | null;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly oldMode: string | null;
  readonly newMode: string | null;
  readonly oldBlob: string | null;
  readonly newBlob: string | null;
  readonly binary: boolean;
  /** Line counts from `--numstat`; null for a binary file. */
  readonly added: number | null;
  readonly removed: number | null;
  readonly diffOmitted?: ChangeSourceDiffOmissionV1;
}

export interface ChangeSourceCommitV1 {
  readonly id: string;
  readonly parents: readonly string[];
  readonly subject: string;
  /**
   * Present on every commit exactly when the record carries
   * `commit-list-may-include-base-history`: true when the commit provably
   * descends from `diffFrom` in the history this checkout holds, false when
   * it may instead be the diff base's own history.
   */
  readonly descendsFromDiffBase?: boolean;
}

export interface ChangeSourceBodyV1<S extends ChangeSourceMemberV1 = ChangeSourceSourceV1> {
  readonly source: S;
  readonly revision: PinnedRepositoryRevisionV1;
  readonly objectFormat: ChangeSourceObjectFormat;
  readonly rangeSemantics: ChangeSourceRangeSemantics;
  /** Recorded for both range forms; only `three-dot` diffs from it. */
  readonly mergeBase: string | null;
  /** The commit the diff's old side is read from; null means the empty tree. */
  readonly diffFrom: string | null;
  /** Null only in a forge-reported record. */
  readonly baseTree: string | null;
  /** Null only in a forge-reported record. */
  readonly headTree: string | null;
  /** Oldest first. */
  readonly commits: readonly ChangeSourceCommitV1[];
  /** In git's diff order, which the diff observation follows. */
  readonly files: readonly ChangeSourceFileV1[];
  readonly labels: readonly ChangeSourceLabel[];
  /** The local diff protocol, or the forge that reported a forge-reported record. */
  readonly protocol: typeof CHANGE_SOURCE_DIFF_PROTOCOL | ChangeSourceForgeProtocolV1;
}

export type ChangeSourceV1<S extends ChangeSourceMemberV1 = ChangeSourceSourceV1> =
  ChangeSourceBodyV1<S> & {
    readonly schemaVersion: 1;
    readonly kind: typeof CHANGE_SOURCE_KIND;
    readonly changeSourceSha256: string;
  };

/** What every kind's resolver returns: the sealed record and its two originals. */
export interface ResolvedChangeSourceV1<S extends ChangeSourceMemberV1 = ChangeSourceSourceV1> {
  readonly changeSource: ChangeSourceV1<S>;
  /** Pretty-printed canonical JSON of `changeSource`. */
  readonly manifestBytes: Uint8Array;
  /** Unified diff of every file not omitted, in manifest order. */
  readonly diffBytes: Uint8Array;
}

/** What every parsed `--change` member carries; `source` names its kind. */
export interface ChangeSourceSelectorMemberV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-change-source-selector";
  readonly source: string;
}

/** A local commit range. It names revisions; nothing is resolved yet. */
export interface LocalRangeSelectorV1 extends ChangeSourceSelectorMemberV1 {
  readonly source: "local-range";
  readonly form: "two-dot" | "three-dot" | "single-commit";
  /** Null exactly for the single-commit form. */
  readonly base: string | null;
  readonly head: string;
}

/** A GitLab merge request; `changeRequest` is the `--mr` selector for the same value. */
export interface GitLabMergeRequestSelectorV1 extends ChangeSourceSelectorMemberV1 {
  readonly source: "gitlab-merge-request";
  readonly changeRequest: ChangeRequestSelectorV1;
}

/** The parsed `--change` value, discriminated by `source`. */
export type ChangeSourceSelectorV1 =
  | LocalRangeSelectorV1
  | GitLabMergeRequestSelectorV1
  | GithubChangeSourceSelectorV1
  | ReleaseRangeSelectorV1;

export const CHANGE_SOURCE_REFUSAL_CODES = [
  "change-source-option-value-missing",
  "change-source-option-form-unrecognized",
  "change-source-selector-repeated",
  "change-source-selector-grammar",
  "change-source-kind-unsupported",
  "change-source-selector-conflict",
  "change-source-workflow-unsupported",
  "change-source-resume-unsupported",
  "change-source-date-window-conflict",
  "change-source-revision-unresolved",
  "change-source-history-unavailable",
  "change-source-no-merge-base",
  "change-source-empty-range",
  "change-source-integrity-mismatch",
  "change-source-grafts-present",
  "change-source-encoding-unsupported",
  "change-source-credential-present",
  "change-source-limits-inconsistent",
  "change-source-git-failed",
  "change-source-resolution-missing",
  "change-source-mr-objects-unavailable",
  "change-source-mr-closed-unmerged",
  "change-source-mr-locked",
  "change-source-mr-diff-refs-missing",
  "change-source-mr-moved",
  "change-source-github-url-credentials",
  "change-source-github-url-insecure",
  "change-source-github-url-grammar",
  "change-source-github-url-partial",
  "change-source-github-compare-unsupported",
  "change-source-github-pull-closed-unmerged",
  "change-source-github-head-moved",
  "change-source-github-incomplete",
  "change-source-github-tree-truncated",
  "change-source-github-redirect-cross-host",
  "change-source-github-rate-limited",
  "change-source-github-forbidden",
  "change-source-github-not-found",
  "change-source-github-request-failed",
  "change-source-github-unreachable",
  "change-source-github-response-invalid",
  "change-source-record-unbound",
  "change-source-mr-forge-incomplete",
  "change-source-mr-forge-overflow",
  "change-source-mr-forge-text-replaced",
  "change-source-mr-forge-page-bound",
  "change-source-github-two-dot-not-ancestor",
  "change-source-github-pr-not-pull-request",
  "change-source-release-form-unsupported",
  "change-source-release-no-units",
  "change-source-release-observations-exceeded",
  "change-source-release-index-over-read-budget",
] as const;

export type ChangeSourceRefusalCode = (typeof CHANGE_SOURCE_REFUSAL_CODES)[number];

/**
 * The condition, then the action. No entry interpolates operator text; the
 * only appended detail is host-derived (an object role, a limit name).
 */
export const CHANGE_SOURCE_REFUSALS: Readonly<Record<ChangeSourceRefusalCode, string>> =
  Object.freeze({
    "change-source-option-value-missing":
      "The --change option was passed without a commit range. Write --change <base>..<head>, --change <base>...<head>, or --change <commit>, then run again.",
    "change-source-option-form-unrecognized":
      "An option starting with --change was passed in a form this command does not accept, so it would otherwise have been ignored and the run left without the change you named. Write --change <range> or --change=<range>, then run again.",
    "change-source-selector-repeated":
      "Pass --change at most once; a run binds one change as its basis. Name the whole range in one --change value, and add --source for any further supporting files.",
    "change-source-selector-grammar":
      "The --change value is not a commit range this input accepts. Write <base>..<head> for the changes on head since base, <base>...<head> for the changes on head since it diverged from base, or one commit such as HEAD for that commit against its first parent. Open-ended ranges, ^! and ^@ suffixes, reflog @{...} forms, :/text searches and <rev>:<path> names are not accepted; name both endpoints as branch names, tags, or commit ids.",
    "change-source-kind-unsupported":
      "The --change value names a merge request, a pull request, or a URL this release does not read, such as a compare page or a link on a host it does not support. Check out the change and pass --change <base>..<head>, or name a GitLab merge request by its URL or host/group/project!number.",
    "change-source-selector-conflict":
      "--change cannot be combined with --pr or --mr; a run binds one change as its basis. Drop one of them, and add --source for any further supporting files.",
    "change-source-workflow-unsupported":
      "--change is supported only for the create-documentation and update-documentation workflows. Re-run the change under one of those workflows, or drop --change.",
    "change-source-resume-unsupported":
      "--change cannot be combined with a resume flag; a durable knowledge stop is not source-aware yet. Run again without the resume flag to bind this change on a fresh run, or resume the stopped run without --change.",
    "change-source-date-window-conflict":
      "A date-scoped merged-MR update already selects its changes from the instruction, so it cannot also take --change. Drop --change to keep the date window, or restate the instruction without the date window and name the change with --change.",
    "change-source-revision-unresolved":
      "A --change endpoint does not name a commit in this repository. Check the branch, tag, or commit id, fetch it into this checkout if it lives on a remote, then run again.",
    "change-source-history-unavailable":
      "This checkout is a shallow clone and does not hold the history the --change range needs. Deepen the clone yourself, for example with git fetch --deepen or git fetch --unshallow, or name a range inside the history it holds, then run again. DocsFab never fetches.",
    "change-source-no-merge-base":
      "The two --change endpoints share no history, so <base>...<head> has no merge base to diff from. Use <base>..<head> to diff the two endpoints directly, or name endpoints on one history, then run again.",
    "change-source-empty-range":
      "The --change range holds no change: base and head name the same commit, or the head is already part of the base's history. Name the commit before the change as base, or pass the one commit alone to diff it against its first parent, then run again.",
    "change-source-integrity-mismatch":
      "A Git object in the --change range does not hash to its own id, so this checkout's object database has been altered or corrupted. Nothing was bound. Run git fsck in the checkout, restore the repository from a trusted clone, then run again.",
    "change-source-grafts-present":
      "This checkout has a grafts file, which rewrites commit parents and would change which commits the range holds. Nothing was bound. Remove .git/info/grafts, or convert it with git replace --convert-graft-file (replace refs are ignored here), then run again.",
    "change-source-encoding-unsupported":
      "The --change range holds a path or diff text that is not valid UTF-8, and a lossy decode would silently rewrite it. Nothing was bound. Name a range that leaves out that file, or re-encode the file as UTF-8 in a new commit, then run again.",
    "change-source-credential-present":
      "The --change range holds one of DocsFab's own configured credentials, so it was not bound as evidence a model could read. Remove the credential from the change and rotate it, or name a range without it, then run again.",
    "change-source-limits-inconsistent":
      "The change-source limits contradict each other: changeSources.fileDiffMaxBytes must not exceed changeSources.diffMaxBytes, which must not exceed sources.extractionMaxOriginalBytes or sources.extractionMaxDerivativeBytes and must stay below hostInvoker.gitOutputMaxBytes. Correct the host override that broke the relation, then run again.",
    "change-source-git-failed":
      "A Git read for the --change range failed, timed out, or returned more output than its sealed bound (hostInvoker.gitTimeoutMs, hostInvoker.gitOutputMaxBytes). Nothing was bound. Narrow the range, check that git can read this checkout, then run again.",
    "change-source-resolution-missing":
      "The run request names a --change range that the host did not resolve before execution. Run it through docsfab run or docsfab do, which resolve the range before any workflow model call.",
    "change-source-mr-objects-unavailable":
      "This checkout does not hold every commit, tree and file the merge request's diff reads, and reading the diff from GitLab through glab failed as well. Nothing was bound. Either fix the glab login for the merge request's host (glab auth status names the problem) so the diff is read from GitLab, or fetch the merge request into this checkout with git fetch origin refs/merge-requests/<number>/head plus its target branch, then run again. A partial clone fetches trees and files only when a checkout needs them, so there also run git checkout on each side the diff compares, in order, and switch back to your branch: the base commit and then the head for an open or fast-forward merged merge request, or the merge or squash commit's first parent and then that commit. The detail after this message names what this checkout lacks, with the sides' commits in that order when a tree or file is missing, and then the GitLab read's failure. DocsFab never fetches.",
    "change-source-mr-closed-unmerged":
      "The merge request was closed without being merged, so its diff is no change to the project. Nothing was bound. Name a merged or open merge request, or name the commits with --change <base>..<head>, then run again.",
    "change-source-mr-locked":
      "The merge request is locked while GitLab completes its merge, so its final commits are not known yet. Nothing was bound. Retry when the merge completes.",
    "change-source-mr-diff-refs-missing":
      "GitLab reported no diff commits for the merge request, so there is no pinned diff to read. Nothing was bound. Retry once GitLab has prepared the merge request's diff, or name the commits with --change <base>..<head>.",
    "change-source-mr-moved":
      "The merge request changed while it was read: GitLab reported two different head or merge commits for it. Nothing was bound. Run again once the merge request stops changing.",
    "change-source-github-url-credentials":
      "The --change GitHub URL carries a user name or password. Nothing was read, and DocsFab never sends URL credentials. Remove them, leaving https://github.com/<owner>/<repo>/pull/<number> or /commit/<sha>, then run again.",
    "change-source-github-url-insecure":
      "The --change GitHub URL uses http. DocsFab reads GitHub over https only. Write the URL with https://, then run again.",
    "change-source-github-url-grammar":
      "The --change GitHub URL is not a pull request, commit, or compare URL this input accepts. Write https://github.com/<owner>/<repo>/pull/<number> (its /files, /commits and /changes views name the same pull request), https://github.com/<owner>/<repo>/commit/<sha>, or https://github.com/<owner>/<repo>/compare/<base>...<head> with git branch, tag, or commit names, without a port, a . or .. path segment, or a query string (a compare page's ?expand=1 is the one exception), then run again.",
    "change-source-github-url-partial":
      "The --change GitHub URL names one commit or a commit range inside a pull request, and binding the whole pull request would widen the change. Pass the commit's own URL, https://github.com/<owner>/<repo>/commit/<sha>, or the whole pull request URL, then run again.",
    "change-source-github-compare-unsupported":
      "The --change value is a GitHub compare URL in a form this release does not read: one ref with no range, a side in another fork (owner:branch), or a reflog date (@{...}). Write https://github.com/<owner>/<repo>/compare/<base>...<head> with both sides in that repository, or check out both commits and pass --change <base>...<head>, then run again.",
    "change-source-github-pull-closed-unmerged":
      "The --change pull request was closed without being merged, so it names no change that reached its target branch. Pass a merged or open pull request, or the URL of one of its commits, then run again.",
    "change-source-github-head-moved":
      "The --change pull request's head commit moved while DocsFab was reading it, so the reads do not describe one change. Nothing was bound. Run again once the pull request stops changing, or pass its head commit's URL.",
    "change-source-github-incomplete":
      "GitHub listed fewer commits, files, or changed lines than it declared for the --change change, or a file list that differs from the paths changed between the two trees it reported, so the list would be incomplete or wrong. Nothing was bound. Check out the change and pass --change <base>..<head> or <base>...<head>, which DocsFab reads in full, then run again.",
    "change-source-github-tree-truncated":
      "GitHub truncated a repository tree DocsFab reads for file modes and blob ids, because the repository is too large for one tree read. Nothing was bound. Check out the change and pass --change <base>..<head> or <base>...<head>, then run again.",
    "change-source-github-redirect-cross-host":
      "GitHub answered a --change read with a redirect away from https://api.github.com, which DocsFab does not follow. Nothing was bound. Check the URL, then run again; a renamed or moved repository redirects within api.github.com and is followed.",
    "change-source-github-rate-limited":
      "GitHub's rate limit for anonymous API requests from this address is used up. DocsFab reads public repositories without credentials. Run again after the reset time named below.",
    "change-source-github-forbidden":
      "GitHub refused a --change read with HTTP 403 for a reason other than its rate limit. DocsFab reads public github.com repositories without credentials. Check that the repository is public and reachable from this host, then run again.",
    "change-source-github-not-found":
      "GitHub answered HTTP 404 for the --change pull request, commit, or repository. It may not exist, or it may be private: DocsFab reads public github.com repositories only and sends no credentials. Check the URL, then run again.",
    "change-source-github-request-failed":
      "GitHub answered a --change read with an HTTP status DocsFab does not accept, named below. Nothing was bound. Run again later; check https://www.githubstatus.com if it persists.",
    "change-source-github-unreachable":
      "DocsFab could not reach https://api.github.com to read the --change URL. Check this host's network access. Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 is also set, so on a host behind a proxy set both, then run again.",
    "change-source-github-response-invalid":
      "GitHub answered a --change read with a response that does not have the shape DocsFab reads, so it could not be recorded. Nothing was bound. Run again later; the field that failed is named below.",
    "change-source-record-unbound":
      "The change named by --change, --mr or --pr resolved, but the host reached the workflow without the sealed change it acquired, so the run record could not cite it. This is a DocsFab defect, not a problem with the change, and the workflow did not start. Report it, or run again without that option.",
    "change-source-mr-forge-incomplete":
      "GitLab's answer for the merge request's diff did not add up, so it may be missing files, lines or commits: a file count, a line total or the newest listed commit disagreed with what GitLab declared, or a field was not in the shape DocsFab reads. Nothing was bound. Fetch the merge request into this checkout with git fetch origin refs/merge-requests/<number>/head plus its target branch so its diff is read from local objects, then run again. The detail after this message names what disagreed.",
    "change-source-mr-forge-overflow":
      "GitLab reports the merge request's changed-file count only as a lower bound, such as 1000+, so DocsFab cannot check that it read every file. Nothing was bound. Fetch the merge request into this checkout with git fetch origin refs/merge-requests/<number>/head plus its target branch so its diff is read from local objects, then run again.",
    "change-source-mr-forge-text-replaced":
      "GitLab sent a changed path or a commit subject holding the replacement character U+FFFD, which stands where the repository's bytes are not valid UTF-8, so DocsFab would record a name the repository does not hold. Nothing was bound. Fetch the merge request into this checkout with git fetch origin refs/merge-requests/<number>/head plus its target branch so it is read from local objects, then run again.",
    "change-source-mr-forge-page-bound":
      "One GitLab answer for the merge request's diff was larger than a glab read may return, so it could not be read whole. Nothing was bound. Fetch the merge request into this checkout with git fetch origin refs/merge-requests/<number>/head plus its target branch so its diff is read from local objects, then run again.",
    "change-source-github-two-dot-not-ancestor":
      "The --change GitHub compare URL uses <base>..<head>, but base is not an ancestor of head: the two have diverged, or head is behind base. DocsFab reads a GitHub two-dot compare only when base is the merge base, because the forge's diff of two diverged commits cannot be checked. Nothing was bound. Write <base>...<head> to diff from their merge base, or check out both commits and pass --change <base>..<head>, then run again.",
    "change-source-github-pr-not-pull-request":
      "--pr and --mr name a pull or merge request, but the GitHub URL names a commit or a compare range. Pass it as --change <url> instead, then run again.",
    "change-source-release-form-unsupported":
      "The --change release: value is not a release form this release reads. Write release:<base>..<head>, naming the previous release's tag or commit as base and the new one as head; a release named by its last tag or by a date window is not supported yet. Then run again.",
    "change-source-release-no-units":
      "The --change release range holds no first-parent commits: head is base itself or one of base's ancestors, so the range names no change. Name the earlier release as base and the later one as head, then run again.",
    "change-source-release-observations-exceeded":
      "The release units index, the units this run binds, and the --source files together exceed what one source binding holds. Nothing was bound and no model was called. Lower DOCSFAB_CHANGE_SOURCES_RELEASE_UNITS_PER_RUN_MAX or pass fewer --source files, then run again.",
    "change-source-release-index-over-read-budget":
      "The release units index lists every unit of the range and one step must read it whole, but even with a one-unit page it is larger than the step's source-read budget for the model this run binds. Nothing was bound and no model was called. Name a shorter range with an earlier head, bind a model with a larger input window, or, when sources.readResponseCeilingBytes set the budget, raise DOCSFAB_SOURCES_READ_RESPONSE_CEILING_BYTES, then run again.",
  });

export class ChangeSourceError extends Error {
  public constructor(
    public readonly code: ChangeSourceRefusalCode,
    /** Host-derived only, such as an object role; never operator or repository text. */
    public readonly detail?: string,
  ) {
    super(
      detail === undefined
        ? CHANGE_SOURCE_REFUSALS[code]
        : `${CHANGE_SOURCE_REFUSALS[code]} (${detail})`,
    );
    this.name = "ChangeSourceError";
  }
}

export function failChangeSource(code: ChangeSourceRefusalCode, detail?: string): never {
  throw new ChangeSourceError(code, detail);
}

/**
 * Forms another kind owns: a URL, an scp-style remote, `!N`,
 * `group/project!N`, or a scheme-less forge merge request, pull, or compare
 * path. Checked before the range grammar, so none is read as a range.
 */
const FOREIGN_KIND =
  /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|git@)|!\d+$|\/-\/merge_requests\/|\/pull\/\d|\/compare\//u;
/**
 * One endpoint: a branch, tag, or commit name with optional `~N` / `^N`
 * ancestry. Excludes `:`, `@`, `{`, `!` and whitespace, which carry the
 * `<rev>:<path>`, `:/text`, reflog, `^!` and `^@` forms.
 */
const ENDPOINT = /^[A-Za-z0-9_][A-Za-z0-9_./~^-]*$/u;

function endpoint(value: string): string {
  if (!ENDPOINT.test(value) || value.includes("..") || value.endsWith(".")) {
    failChangeSource("change-source-selector-grammar");
  }
  return value;
}

/** One kind's `--change` grammar: its member for a value it claims, else undefined. */
export type ChangeSourceSelectorArm<
  S extends ChangeSourceSelectorMemberV1 = ChangeSourceSelectorMemberV1,
> = (value: string) => S | undefined;

/**
 * The merge request forms: a URL path through `/merge_requests/`, and a value
 * ending in `!<number>`. A bare number stays a local revision name.
 */
const GITLAB_MERGE_REQUEST_FORM = /\/merge_requests\/|!\d+$/u;

/**
 * Claim a GitLab merge request through the `--mr` grammar, so both options
 * accept the same forms and refuse with the same codes. A form the `--mr`
 * grammar refuses refuses here too; another forge's value is not claimed.
 */
function gitlabMergeRequestSelector(value: string): GitLabMergeRequestSelectorV1 | undefined {
  if (!GITLAB_MERGE_REQUEST_FORM.test(value)) return undefined;
  return mergeRequestChangeSourceSelector(parseChangeRequestSelector(value));
}

/** A `--mr` selector as the change-source selector of its kind; undefined for another forge. */
export function mergeRequestChangeSourceSelector(
  changeRequest: ChangeRequestSelectorV1 | undefined,
): GitLabMergeRequestSelectorV1 | undefined {
  if (changeRequest?.provider !== "gitlab") return undefined;
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "docsfab-change-source-selector" as const,
    source: "gitlab-merge-request" as const,
    changeRequest,
  });
}

/**
 * Selector arms of the kinds other than `local-range`, tried in order before
 * the foreign-form refusal; the local range grammar is the fallback.
 */
export const CHANGE_SOURCE_SELECTOR_ARMS: readonly ChangeSourceSelectorArm<ChangeSourceSelectorV1>[] =
  Object.freeze([
    gitlabMergeRequestSelector,
    githubChangeSourceSelectorArm(failChangeSource),
    releaseRangeSelectorArm(failChangeSource, endpoint),
  ]);

/**
 * Parse a `--change` value into a selector. `...` is matched before `..`, so
 * `A...B` is never split into `A` and `.B`.
 */
export function parseChangeSourceSelector(value: string): ChangeSourceSelectorV1;
export function parseChangeSourceSelector<S extends ChangeSourceSelectorMemberV1>(
  value: string,
  arms: readonly ChangeSourceSelectorArm<S>[],
): S | LocalRangeSelectorV1;
export function parseChangeSourceSelector(
  value: string,
  arms: readonly ChangeSourceSelectorArm[] = CHANGE_SOURCE_SELECTOR_ARMS,
): ChangeSourceSelectorMemberV1 {
  if (typeof value !== "string" || value.length === 0) {
    failChangeSource("change-source-option-value-missing");
  }
  for (const arm of arms) {
    const claimed = arm(value);
    if (claimed !== undefined) return Object.freeze(claimed);
  }
  if (FOREIGN_KIND.test(value)) failChangeSource("change-source-kind-unsupported");
  const threeDot = value.indexOf("...");
  if (threeDot >= 0) {
    return selector(
      "three-dot",
      endpoint(value.slice(0, threeDot)),
      endpoint(value.slice(threeDot + "...".length)),
    );
  }
  const twoDot = value.indexOf("..");
  if (twoDot >= 0) {
    return selector(
      "two-dot",
      endpoint(value.slice(0, twoDot)),
      endpoint(value.slice(twoDot + "..".length)),
    );
  }
  return selector("single-commit", null, endpoint(value));
}

function selector(
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

const CHANGE_SOURCE_CONTRACT_ERROR_CODES = [
  "change-source-contract-invalid-shape",
  "change-source-contract-invalid-value",
  "change-source-contract-digest-mismatch",
  "change-source-contract-credential-material",
  "change-source-contract-schema-mismatch",
] as const;

type ChangeSourceContractErrorCode = (typeof CHANGE_SOURCE_CONTRACT_ERROR_CODES)[number];

export class ChangeSourceContractError extends Error {
  public constructor(public readonly code: ChangeSourceContractErrorCode) {
    super(
      `The change-source record is not valid (${code}). It is host-built; rebuild it from the repository rather than editing it.`,
    );
    this.name = "ChangeSourceContractError";
  }
}

function failContract(code: ChangeSourceContractErrorCode): never {
  throw new ChangeSourceContractError(code);
}

const kit = createContractKit<ChangeSourceContractErrorCode>({
  fail: failContract,
  codes: {
    invalidShape: "change-source-contract-invalid-shape",
    invalidValue: "change-source-contract-invalid-value",
    digestMismatch: "change-source-contract-digest-mismatch",
    credentialMaterial: "change-source-contract-credential-material",
    schemaMismatch: "change-source-contract-schema-mismatch",
  },
  // The range limits bound both lists where the record is built.
  sizeGovernedBy: "changeSources.changedFilesMax",
});

/** Paths and subjects are repository bytes: kept exactly, so NFC is not required. */
function text(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0")) {
    failContract("change-source-contract-invalid-value");
  }
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    failContract("change-source-contract-invalid-value");
  }
  return value;
}

function nullableCount(value: unknown): number | null {
  return value === null ? null : count(value);
}

function nullableRevision(value: unknown): string | null {
  return value === null ? null : kit.revision(value);
}

const GIT_MODE = /^[0-7]{6}$/u;

function mode(value: unknown): string {
  const result = text(value);
  if (!GIT_MODE.test(result)) failContract("change-source-contract-invalid-value");
  return result;
}

/** Decode a tree-derived field: required locally, nullable only in a forge-reported record. */
function reported<T>(
  provenance: ChangeSourceProvenance,
  value: unknown,
  decode: (value: unknown) => T,
): T | null {
  return provenance === "forge-reported" && value === null ? null : decode(value);
}

function omission(value: unknown, provenance: ChangeSourceProvenance): ChangeSourceDiffOmissionV1 {
  const root = kit.object(value);
  if (root.code !== "change-source-file-diff-omitted") {
    failContract("change-source-contract-invalid-value");
  }
  // Only a forge can omit a diff without a size; the host always measures or bounds it.
  if (root.basis === "forge-omitted") {
    if (provenance !== "forge-reported") failContract("change-source-contract-invalid-value");
    kit.exact(root, ["code", "basis", "forgeReason"]);
    return {
      code: "change-source-file-diff-omitted",
      basis: "forge-omitted",
      forgeReason: kit.enumeration(root.forgeReason, CHANGE_SOURCE_FORGE_OMISSION_REASONS),
    };
  }
  kit.exact(root, ["code", "observedBytes", "basis", "limitName", "limitBytes"]);
  return {
    code: "change-source-file-diff-omitted",
    observedBytes: count(root.observedBytes),
    basis: kit.enumeration(root.basis, ["measured", "upper-bound"] as const),
    limitName: kit.identifier(root.limitName),
    limitBytes: count(root.limitBytes),
  };
}

function file(value: unknown, provenance: ChangeSourceProvenance): ChangeSourceFileV1 {
  const root = kit.object(value);
  const omitted = Object.hasOwn(root, "diffOmitted");
  kit.exact(root, [
    "status",
    "similarity",
    "oldPath",
    "newPath",
    "oldMode",
    "newMode",
    "oldBlob",
    "newBlob",
    "binary",
    "added",
    "removed",
    ...(omitted ? ["diffOmitted"] : []),
  ]);
  if (typeof root.binary !== "boolean") failContract("change-source-contract-invalid-value");
  return {
    status: kit.enumeration(root.status, CHANGE_SOURCE_FILE_STATUSES),
    similarity: nullableCount(root.similarity),
    oldPath: nullableText(root.oldPath),
    newPath: nullableText(root.newPath),
    oldMode: reported(provenance, root.oldMode, mode),
    newMode: reported(provenance, root.newMode, mode),
    oldBlob: reported(provenance, root.oldBlob, kit.revision),
    newBlob: reported(provenance, root.newBlob, kit.revision),
    binary: root.binary,
    added: nullableCount(root.added),
    removed: nullableCount(root.removed),
    ...(omitted ? { diffOmitted: omission(root.diffOmitted, provenance) } : {}),
  };
}

function commit(value: unknown): ChangeSourceCommitV1 {
  const root = kit.object(value);
  const marked = Object.hasOwn(root, "descendsFromDiffBase");
  kit.exact(root, ["id", "parents", "subject", ...(marked ? ["descendsFromDiffBase"] : [])]);
  if (marked && typeof root.descendsFromDiffBase !== "boolean") {
    failContract("change-source-contract-invalid-value");
  }
  return {
    id: kit.revision(root.id),
    parents: kit.array(root.parents).map((parent) => kit.revision(parent)),
    subject: text(root.subject),
    ...(marked ? { descendsFromDiffBase: root.descendsFromDiffBase as boolean } : {}),
  };
}

/**
 * The per-commit marker and its label agree: every commit is marked, and at
 * least one is unproven, exactly when the label is present.
 */
function assertAncestryMarks(
  commits: readonly ChangeSourceCommitV1[],
  labels: readonly ChangeSourceLabel[],
): void {
  const marked = commits.filter((entry) => entry.descendsFromDiffBase !== undefined).length;
  const consistent = labels.includes("commit-list-may-include-base-history")
    ? marked === commits.length && commits.some((entry) => entry.descendsFromDiffBase === false)
    : marked === 0;
  if (!consistent) failContract("change-source-contract-invalid-value");
}

/**
 * Every object id in the record has the record's object format: a SHA-1 id
 * in a SHA-256 record, or the reverse, refuses. The empty tree id fixes the
 * width per format.
 */
function assertObjectFormat(body: ChangeSourceBodyV1<ChangeSourceMemberV1>): void {
  const width = GIT_EMPTY_TREE_IDS[body.objectFormat].length;
  const ids = [
    body.revision.base,
    body.revision.head,
    body.mergeBase,
    body.diffFrom,
    body.baseTree,
    body.headTree,
    ...body.commits.flatMap((entry) => [entry.id, ...entry.parents]),
    ...body.files.flatMap((entry) => [entry.oldBlob, entry.newBlob]),
  ];
  if (ids.some((id) => typeof id === "string" && id.length !== width)) {
    failContract("change-source-contract-invalid-value");
  }
}

function protocol(
  value: unknown,
  provenance: ChangeSourceProvenance,
): ChangeSourceBodyV1<ChangeSourceMemberV1>["protocol"] {
  const root = kit.object(value);
  // A forge-reported record names its forge; every other record carries the local constants.
  if (provenance === "forge-reported") {
    kit.exact(root, ["provider"]);
    return { provider: kit.enumeration(root.provider, CHANGE_SOURCE_FORGE_PROVIDERS) };
  }
  kit.exact(root, ["renameSimilarityPercent", "contextLines", "diffAlgorithm"]);
  if (kit.canonicalJson(root) !== kit.canonicalJson(CHANGE_SOURCE_DIFF_PROTOCOL)) {
    failContract("change-source-contract-invalid-value");
  }
  return CHANGE_SOURCE_DIFF_PROTOCOL;
}

/** The checks a source decoder arm may apply; each refuses with the contract's own codes. */
export interface ChangeSourceDecodeKit {
  readonly exact: (root: Record<string, unknown>, keys: readonly string[]) => void;
  readonly enumeration: <const T extends readonly string[]>(value: unknown, values: T) => T[number];
  readonly identifier: (value: unknown) => string;
  readonly revision: (value: unknown) => string;
}

const DECODE_KIT: ChangeSourceDecodeKit = Object.freeze({
  exact: (root: Record<string, unknown>, keys: readonly string[]) => kit.exact(root, keys),
  enumeration: kit.enumeration,
  identifier: kit.identifier,
  revision: kit.revision,
});

/**
 * One kind's `source` member decoder: closed keys, and `provenance` only when
 * that kind's provenance can vary.
 */
export type ChangeSourceSourceDecoder<S extends ChangeSourceMemberV1 = ChangeSourceMemberV1> = (
  root: Record<string, unknown>,
  decode: ChangeSourceDecodeKit,
) => S;

/** The shipped source decoders, keyed by kind. */
export const CHANGE_SOURCE_SOURCE_DECODERS: Readonly<
  Record<ChangeSourceKind, ChangeSourceSourceDecoder<ChangeSourceSourceV1>>
> = Object.freeze({
  "local-range": (root: Record<string, unknown>, decode: ChangeSourceDecodeKit) => {
    decode.exact(root, ["kind"]);
    return { kind: "local-range" as const };
  },
  "gitlab-merge-request": gitlabMergeRequestSource,
  ...githubSourceDecoders(() => failContract("change-source-contract-invalid-value")),
  "release-range": releaseRangeSourceDecoder,
});

function positiveId(value: unknown): number {
  const result = count(value);
  if (result === 0) failContract("change-source-contract-invalid-value");
  return result;
}

/**
 * The merge request member. State, merge mode and the recorded merge and
 * squash commits must agree: an open request records neither commit, and
 * each merge mode records exactly the commit its diff is read from.
 */
function gitlabMergeRequestSource(root: Record<string, unknown>): GitLabMergeRequestSourceV1 {
  kit.exact(root, [
    "kind",
    "provenance",
    "host",
    "projectPath",
    "projectId",
    "iid",
    "state",
    "mergeMode",
    "diffRefs",
    "mergeCommit",
    "squashCommit",
    "fork",
  ]);
  const diffRefs = kit.object(root.diffRefs);
  kit.exact(diffRefs, ["base", "start", "head"]);
  if (typeof root.fork !== "boolean") failContract("change-source-contract-invalid-value");
  const state = kit.enumeration(root.state, ["opened", "merged"] as const);
  const mergeMode =
    root.mergeMode === null
      ? null
      : kit.enumeration(root.mergeMode, GITLAB_MERGE_REQUEST_MERGE_MODES);
  const mergeCommit = nullableRevision(root.mergeCommit);
  const squashCommit = nullableRevision(root.squashCommit);
  const consistent =
    state === "opened"
      ? mergeMode === null && mergeCommit === null && squashCommit === null
      : mergeMode === "merge-commit"
        ? mergeCommit !== null
        : mergeMode === "squash"
          ? mergeCommit === null && squashCommit !== null
          : mergeMode === "fast-forward" && mergeCommit === null && squashCommit === null;
  if (!consistent) failContract("change-source-contract-invalid-value");
  return {
    kind: "gitlab-merge-request",
    // Local objects or GitLab's own diff; the body checks each provenance's own fields.
    provenance: kit.enumeration(root.provenance, CHANGE_SOURCE_PROVENANCES),
    host: kit.identifier(root.host),
    projectPath: kit.identifier(root.projectPath),
    projectId: positiveId(root.projectId),
    iid: positiveId(root.iid),
    state,
    mergeMode,
    diffRefs: {
      base: kit.revision(diffRefs.base),
      start: kit.revision(diffRefs.start),
      head: kit.revision(diffRefs.head),
    },
    mergeCommit,
    squashCommit,
    fork: root.fork,
  };
}

const BODY_KEYS = [
  "source",
  "revision",
  "objectFormat",
  "rangeSemantics",
  "mergeBase",
  "diffFrom",
  "baseTree",
  "headTree",
  "commits",
  "files",
  "labels",
  "protocol",
];

function sourceMember<S extends ChangeSourceMemberV1>(
  value: unknown,
  decoders: Readonly<Record<string, ChangeSourceSourceDecoder<S>>>,
): S {
  const root = kit.object(value);
  // Own keys only, so an inherited name such as `constructor` is no kind.
  if (typeof root.kind !== "string" || !Object.hasOwn(decoders, root.kind)) {
    failContract("change-source-contract-invalid-value");
  }
  const member = decoders[root.kind]!(root, DECODE_KIT);
  // An arm decodes only its own kind, and any provenance it reports is a known one.
  if (member.kind !== root.kind) failContract("change-source-contract-invalid-value");
  if (member.provenance !== undefined) {
    kit.enumeration(member.provenance, CHANGE_SOURCE_PROVENANCES);
  }
  return member;
}

function normalizeBodyWith<S extends ChangeSourceMemberV1>(
  decoders: Readonly<Record<string, ChangeSourceSourceDecoder<S>>>,
): (root: Record<string, unknown>) => ChangeSourceBodyV1<S> {
  return (root) => {
    const source = sourceMember(root.source, decoders);
    const provenance = changeSourceProvenance(source);
    const labels = kit
      .array(root.labels)
      .map((label) => kit.enumeration(label, CHANGE_SOURCE_LABELS));
    kit.unique(labels);
    const commits = kit.array(root.commits).map(commit);
    assertAncestryMarks(commits, labels);
    const body: ChangeSourceBodyV1<S> = {
      source,
      revision: decodePinnedRepositoryRevisionV1(root.revision),
      objectFormat: kit.enumeration(root.objectFormat, CHANGE_SOURCE_OBJECT_FORMATS),
      rangeSemantics: kit.enumeration(root.rangeSemantics, CHANGE_SOURCE_RANGE_SEMANTICS),
      mergeBase: nullableRevision(root.mergeBase),
      diffFrom: nullableRevision(root.diffFrom),
      baseTree: reported(provenance, root.baseTree, kit.revision),
      headTree: reported(provenance, root.headTree, kit.revision),
      commits,
      files: kit.array(root.files).map((entry) => file(entry, provenance)),
      labels: [...labels].sort(),
      protocol: protocol(root.protocol, provenance),
    };
    assertObjectFormat(body);
    return body;
  };
}

export interface ChangeSourceCodec<S extends ChangeSourceMemberV1> {
  /** Seal a host-built change source; the digest covers every field. */
  readonly create: (body: ChangeSourceBodyV1<ChangeSourceMemberV1>) => ChangeSourceV1<S>;
  /** Closed-key decoder; any key outside the contract, or a stale digest, refuses. */
  readonly decode: (value: unknown) => ChangeSourceV1<S>;
}

/**
 * A codec over one source decoder table. The shipped codec is
 * `createChangeSource` / `decodeChangeSourceV1`; a kind joins it by adding its
 * decoder to `CHANGE_SOURCE_SOURCE_DECODERS`.
 */
export function createChangeSourceCodec<S extends ChangeSourceMemberV1>(
  sourceDecoders: Readonly<Record<string, ChangeSourceSourceDecoder<S>>>,
): ChangeSourceCodec<S> {
  const decoders = Object.freeze({ ...sourceDecoders });
  const normalize = normalizeBodyWith(decoders);
  const decode = (value: unknown): ChangeSourceV1<S> =>
    kit.decodeSealed(
      value,
      CHANGE_SOURCE_KIND,
      CHANGE_SOURCE_DIGEST_KEY,
      BODY_KEYS,
      normalize,
    ) as ChangeSourceV1<S>;
  return Object.freeze({
    create: (body: ChangeSourceBodyV1<ChangeSourceMemberV1>) =>
      decode(kit.seal(CHANGE_SOURCE_KIND, CHANGE_SOURCE_DIGEST_KEY, normalize({ ...body }))),
    decode,
  });
}

const SHIPPED_CODEC = createChangeSourceCodec(CHANGE_SOURCE_SOURCE_DECODERS);

/** Seal a host-built change source; the digest covers every field. */
export function createChangeSource(body: ChangeSourceBodyV1<ChangeSourceMemberV1>): ChangeSourceV1 {
  return SHIPPED_CODEC.create(body);
}

/** Closed-key decoder; any key outside the contract, or a stale digest, refuses. */
export function decodeChangeSourceV1(value: unknown): ChangeSourceV1 {
  return SHIPPED_CODEC.decode(value);
}
