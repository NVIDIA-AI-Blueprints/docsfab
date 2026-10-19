// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Tool activity, refusal, history, read, and archive evidence contracts.

export interface TokenUsage {
  input: number;
  /**
   * Tokens produced, not a permitted maximum, from Pi's session totals. It
   * leaves out discarded in-turn replay output, which `turns[].outputTokens`
   * counts, and older records may store the grant under `turns[].outputTokens`,
   * so the two figures can disagree.
   */
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  turns: number;
  cost?: number;
}
export interface ToolActivityEntry {
  name: string;
  calls: number;
  failures: number;
}
/**
 * The closed set of categories an executed tool call can fail under. The one
 * source for every decoder, projector, and quality reader of recorded tool
 * evidence; the producer sorts with `localeCompare`, the decoder requires
 * lexicographic order, and a parity test keeps the two agreeing.
 *
 * - `denied-path`: the confinement refused the path. A refused edit/write
 *   is a mutation-boundary refusal, which the plan-scope stop keys on.
 * - `malformed-arguments`: the arguments did not match the tool's parameters,
 *   and the path they named was inside the grant. Not a mutation-boundary
 *   refusal. Material: no later call to the same tool in the attempt succeeded.
 * - `malformed-arguments-corrected`: the same, but a later call to the same
 *   tool in the attempt succeeded, so the model resent it in the declared
 *   shape. Not material.
 * - `citation-refused`: the host refused a model-supplied source citation;
 *   kept apart from `denied-path` for the same reason.
 * - `recoverable-miss`: the call named a target that did not match what it
 *   asked for: edit text that is absent, ambiguous, empty, overlapping, or
 *   unchanged, an edit of a missing file, a read offset past the end, or a
 *   directory where a file was expected or the reverse. The tool refused it
 *   before anything changed.
 * - `tool-defect`: any other failure, including a failed call no confined
 *   tool attributed.
 */
export const EXECUTED_TOOL_FAILURE_CATEGORIES = [
  "expected-missing-probe",
  "denied-path",
  "malformed-arguments",
  "malformed-arguments-corrected",
  "unsupported-pattern",
  "citation-refused",
  "recoverable-miss",
  "tool-defect",
  "unknown-tool",
] as const;
/**
 * Recorded failures that say nothing against the run's execution: a probe of
 * an absent target, and a malformed call the model then corrected. Every
 * other category is material to a `ready` outcome; `not-ready` admits the
 * recorded misses below.
 */
export const NON_MATERIAL_TOOL_FAILURE_CATEGORIES: readonly ToolFailureDisposition[] = [
  "expected-missing-probe",
  "malformed-arguments-corrected",
];
/**
 * Model tool misses a `not-ready` outcome admits when it records them as a
 * limitation: each call failed without changing anything, and none was
 * refused as a denied path or an ungranted tool. On a write step,
 * `tool-defect` (an internal or unattributed failure, which can be a write
 * that failed part-way), `denied-path` (which can be a write outside the
 * plan), `unknown-tool`, and `governance-stop` stay material to `not-ready`.
 */
export const NOT_READY_RECORDED_TOOL_MISS_CATEGORIES: readonly ToolFailureDisposition[] = [
  "citation-refused",
  "malformed-arguments",
  "recoverable-miss",
  "unsupported-pattern",
];
/**
 * Failed calls a read-only step also records as misses: it holds no edit or
 * write tool, so none of its calls can change the patch. A refused path is a
 * refused read, an unoffered tool call ran nothing, and a tool defect is a
 * read or search that failed. `governance-stop` stays material.
 */
export const NOT_READY_READ_ONLY_FAILED_CALL_CATEGORIES: readonly ToolFailureDisposition[] = [
  "denied-path",
  "tool-defect",
  "unknown-tool",
];
/** The categories a `not-ready` outcome records as misses for a step of `mode`. */
export function notReadyRecordedToolMissCategories(
  mode: import("../../workflow-contracts/contracts.js").StepMode,
): readonly ToolFailureDisposition[] {
  return mode === "read-only"
    ? [...NOT_READY_RECORDED_TOOL_MISS_CATEGORIES, ...NOT_READY_READ_ONLY_FAILED_CALL_CATEGORIES]
    : NOT_READY_RECORDED_TOOL_MISS_CATEGORIES;
}
/** Executed categories plus the governance stop, which is never an executed failure. */
export const TOOL_FAILURE_DISPOSITIONS = [
  ...EXECUTED_TOOL_FAILURE_CATEGORIES,
  "governance-stop",
] as const;
export type ToolFailureDisposition = (typeof TOOL_FAILURE_DISPOSITIONS)[number];
/** Categories the confined tools themselves record; `unknown-tool` is the session's. */
export type ToolFailureCategory = Exclude<
  ToolFailureDisposition,
  "governance-stop" | "unknown-tool"
>;
export interface ToolFailureCategoryEntry {
  category: ToolFailureDisposition;
  count: number;
}
/**
 * The closed set of rules under which the confinement refuses a path, so a
 * refused edit/write (a `denied-path` mutation-boundary refusal) names what
 * to change without the path or any model text.
 *
 * - `absolute-path`: an absolute, home (`~`), file URL, UNC, or drive form
 *   outside the advertised virtual workspace.
 * - `governed-asset`: the read-only directory that serves governed assets.
 * - `link`: a symbolic link on the path, an existing file with more than one
 *   hard link, or a target whose canonical form leaves the workspace.
 * - `missing-path`: the call named no path, or a path that is not a string.
 * - `nul-byte`: the path contains a NUL byte.
 * - `outside-grant`: a workspace path outside the approved plan or grant.
 * - `traversal`: a `..` segment, or a path that leaves the workspace.
 * - `workspace-root`: the workspace root itself, which no edit or write can
 *   replace.
 */
export const PATH_REFUSAL_REASONS = [
  "absolute-path",
  "governed-asset",
  "link",
  "missing-path",
  "nul-byte",
  "outside-grant",
  "traversal",
  "workspace-root",
] as const;
export type PathRefusalReason = (typeof PATH_REFUSAL_REASONS)[number];
/** Refused edit/write calls under one reason; entries sort by reason. */
export interface MutationRefusalEntry {
  readonly reason: PathRefusalReason;
  readonly count: number;
}
export interface ToolActivitySummary {
  totalCalls: number;
  failedCalls: number;
  byTool: ToolActivityEntry[];
  failureCategories?: ToolFailureCategoryEntry[];
  /** SDK results rejected before the host hook; no execution lease call was requested. */
  preExecutionRejections?: {
    readonly schemaVersion: 1;
    readonly kind: "tool-pre-execution-rejections";
    readonly count: number;
  };
  /**
   * Tool names actually registered with the provider session, sorted. Unlike
   * `skillEvidence.toolPolicy.granted` (policy intent), a tool absent here was
   * never callable.
   */
  presented?: string[];
  /** Present only when the tool-result archive was enabled; never carries archived bytes. */
  toolResultArchive?: ToolResultArchiveSnapshotV1;
  /** Present only when an attempt re-read unchanged content; counts only. */
  readEvidence?: ReadEvidenceSnapshotV1;
  /**
   * Git history pages the host served this attempt, in the order the calls
   * finished; on a step, its attempts' entries in attempt order. At most one
   * per executed tool call, so the per-step tool-call ceiling
   * (`compositionExecution.maxToolCallsPerStep`) bounds it.
   */
  historyReads?: HistoryReadCitationV1[];
  /**
   * Why source and git history tool calls were refused, content-free: never an
   * id, path, revision, or source byte the model sent or was shown.
   */
  toolRefusals?: ToolRefusalsV1;
  /**
   * Arguments of source and git history tool calls the host set aside as
   * filler rather than read as a selection, content-free: never the value.
   */
  toolArgumentFiller?: ToolArgumentFillerRowV1[];
}
/**
 * Why the host set an argument aside instead of reading it:
 *
 * - `null`: the value was `null`.
 * - `empty`: an empty string or an empty list.
 * - `zero`: `0` where it cannot select anything: `maxBytes`, `diffFile`, or
 *   `diffHunk` (counted from 1), or `fromByte` beside another selection, where
 *   0 is the default start.
 * - `unissued-id`: beside a source handle, an `observationId` or
 *   `representationId` that is no id or handle the host issued.
 * - `redundant`: beside `spanIds`, a `diffFile` and `diffHunk` naming the diff
 *   unit those spans lie in.
 * - `inapplicable`: beside `spanIds`, a `diffFile` or `diffHunk` of a source
 *   that is not a diff.
 */
export const TOOL_ARGUMENT_FILLER_KINDS = [
  "empty",
  "inapplicable",
  "null",
  "redundant",
  "unissued-id",
  "zero",
] as const;
export type ToolArgumentFillerKind = (typeof TOOL_ARGUMENT_FILLER_KINDS)[number];
/**
 * Calls of one tool that sent one argument as one kind of filler. Rows are
 * sorted by tool, argument, and kind, and unique on them, so the closed
 * vocabularies bound their number.
 */
export interface ToolArgumentFillerRowV1 {
  tool: SourceToolRefusalToolName | HistoryToolName;
  argument: ToolRefusalArgumentKey;
  kind: ToolArgumentFillerKind;
  count: number;
}
/**
 * What a refusal told the model to change, as a closed kind; the text itself
 * is not recorded.
 *
 * - `argument-shape`: the call's arguments did not form one selection.
 * - `unknown-source`: no bound source has that handle or observation id.
 * - `unknown-representation`: the observation has no such representation.
 * - `unknown-span`: a span id is not a span of that representation.
 * - `window-range`: a byte offset or window lies outside the source.
 * - `diff-unit`: a diff file or hunk is not in the diff, or has no text.
 * - `span-size`: the named spans hold more than `maxBytes`.
 * - `read-budget`: the step's source-read budget cannot hold the read.
 * - `retained-text-missing`: the host holds no retained text for the source.
 * - `grant`: the step's read or citation grant is missing, stale, or cancelled.
 * - `binding`: the sealed binding no longer matches the run.
 * - `credential`: the credential screen withheld the result.
 * - `citation`, `discovery`, `history`: the refusal table of that tool family.
 * - `operational-limit`: a catalogued bound refused the call.
 * - `tool-defect`: the host failed; nothing the model sent was at fault.
 */
export const TOOL_REFUSAL_DETAIL_KINDS = [
  "argument-shape",
  "binding",
  "citation",
  "credential",
  "diff-unit",
  "discovery",
  "grant",
  "history",
  "operational-limit",
  "read-budget",
  "retained-text-missing",
  "span-size",
  "tool-defect",
  "unknown-representation",
  "unknown-source",
  "unknown-span",
  "window-range",
] as const;
export type ToolRefusalDetailKind = (typeof TOOL_REFUSAL_DETAIL_KINDS)[number];
/**
 * Every code a source or history tool refusal can carry: the source-evidence
 * service, citation, discovery, and git history codes, plus a catalogued
 * bound and a host defect. `harness/tool-refusals.ts` checks each producer's
 * codes against this list at compile time.
 */
export const TOOL_REFUSAL_CODES = [
  "authority-required",
  "budget-exhausted",
  "cancelled",
  "credential-withheld",
  "credentials",
  "digest-mismatch",
  "egress-unwalkable-value",
  "foreign-binding",
  "history-arguments-invalid",
  "history-cursor-invalid",
  "history-git-failed",
  "history-line-range-invalid",
  "history-object-binary",
  "history-object-missing",
  "history-object-too-large",
  "history-object-unavailable",
  "history-output-too-large",
  "history-path-missing",
  "history-path-not-file",
  "history-path-refused",
  "history-revision-ambiguous",
  "history-revision-invalid",
  "history-revision-out-of-scope",
  "history-timeout",
  "host-path",
  "local-path",
  "observation-unavailable",
  "operational-limit",
  "out-of-scope-locator",
  "policy-mismatch",
  "producer-scope-mismatch",
  "read-grant-missing",
  "repository-mismatch",
  "request-mismatch",
  "run-mismatch",
  "scope-identity",
  "source-capability-unavailable",
  "span-unavailable",
  "stale-capability",
  "step-mismatch",
  "tool-defect",
  "unknown-span",
  "unread-span",
  "unsupported-claim",
  "unsupported-locator",
  "wrong-step",
] as const;
export type ToolRefusalCode = (typeof TOOL_REFUSAL_CODES)[number];
/**
 * How one id argument of a refused call relates to the ids the host issued:
 * for source tools the listed observation, representation, and span ids; for
 * history tools the run's pinned revision.
 *
 * - `exact`: equals an issued id of that argument's kind.
 * - `handle`: a short handle the host issued (`s1`), or the history `head` alias.
 * - `path`: the listed repository path of a source. A path never names a
 *   source, so a call that sends one is refused.
 * - `unique-prefix`: a proper prefix of exactly one issued id.
 * - `near-miss-same-length`: shaped like an issued id (same kind prefix and
 *   length) but equal to none: a mis-copied id.
 * - `near-miss-other-length`: the kind prefix of an issued id, another length,
 *   and not a unique prefix: a truncated or extended id.
 * - `other-kind`: an issued id of another argument kind, such as a
 *   representation id sent as the observation id.
 * - `unknown`: none of the above.
 * - `malformed`: not a non-empty string.
 */
export const TOOL_REFUSAL_ID_MATCHES = [
  "exact",
  "handle",
  "malformed",
  "near-miss-other-length",
  "near-miss-same-length",
  "other-kind",
  "path",
  "unique-prefix",
  "unknown",
] as const;
export type ToolRefusalIdMatch = (typeof TOOL_REFUSAL_ID_MATCHES)[number];
/** The id arguments a refusal classifies; `range.from` and `range.to` are nested. */
export const TOOL_REFUSAL_ID_ARGUMENTS = [
  "base",
  "head",
  "observationId",
  "range.from",
  "range.to",
  "representationId",
  "revision",
  "source",
  "spanIds",
] as const;
export type ToolRefusalIdArgument = (typeof TOOL_REFUSAL_ID_ARGUMENTS)[number];
/**
 * Every argument name a source or history tool declares, nested ones dotted;
 * sorted. A refusal row records only these names.
 */
export const TOOL_REFUSAL_ARGUMENT_KEYS = [
  "base",
  "claim",
  "cursor",
  "diffFile",
  "diffHunk",
  "endLine",
  "fromByte",
  "fromEntry",
  "head",
  "maxBytes",
  "maxDescriptors",
  "maxEntries",
  "needle",
  "observationId",
  "path",
  "paths",
  "range",
  "range.from",
  "range.to",
  "representationId",
  "revision",
  "source",
  "spanIds",
  "startLine",
] as const;
export type ToolRefusalArgumentKey = (typeof TOOL_REFUSAL_ARGUMENT_KEYS)[number];
/** The source tools whose refusals the record classifies; sorted. */
export const SOURCE_TOOL_REFUSAL_TOOL_NAMES = [
  "docsfab_cite_source",
  "docsfab_list_sources",
  "docsfab_read_preservation_source",
  "docsfab_read_source",
  "docsfab_search_sources",
] as const;
export type SourceToolRefusalToolName = (typeof SOURCE_TOOL_REFUSAL_TOOL_NAMES)[number];
export interface ToolRefusalIdMatchV1 {
  argument: ToolRefusalIdArgument;
  match: ToolRefusalIdMatch;
  /** Values of that argument in that class: one for a scalar, any for `spanIds`. */
  count: number;
}
/**
 * Refused calls that agree on every field, collapsed into one row with their
 * count, so a model retrying one refusal costs one row.
 */
export interface ToolRefusalRowV1 {
  tool: SourceToolRefusalToolName | HistoryToolName;
  /** The host's refusal code, such as `observation-unavailable`. */
  code: ToolRefusalCode;
  detailKind: ToolRefusalDetailKind;
  /** The tool's declared argument names the call sent, sorted; nested ones dotted. */
  argumentKeys: ToolRefusalArgumentKey[];
  /** Argument names the call sent that the tool does not declare; never their names. */
  undeclaredArgumentCount: number;
  /** Sorted by argument, then match. */
  idMatches: ToolRefusalIdMatchV1[];
  count: number;
}
/**
 * At most `sources.toolRefusalRecordMaxRows` rows, in first-refusal order; a
 * refused call that would open a row past it is counted in `overflowCount`.
 */
export interface ToolRefusalsV1 {
  rows: ToolRefusalRowV1[];
  overflowCount: number;
}
/** The git history tools; sorted, as the presented tool list is. */
export const HISTORY_TOOL_NAME_VALUES = [
  "docsfab_history_blame",
  "docsfab_history_diff",
  "docsfab_history_log",
  "docsfab_history_search",
  "docsfab_history_show",
] as const;
export type HistoryToolName = (typeof HISTORY_TOOL_NAME_VALUES)[number];
/**
 * Limitations a served history page carries instead of a refusal:
 * `history-shallow`, the walk reached the cut of a shallow clone;
 * `history-partial-clone`, the checkout is a partial clone;
 * `history-paths-excluded`, the diff left credential-bearing or generated
 * paths out, a blamed line's older name was one and was not served, or a
 * searched window's commits changed one (decided without the search string,
 * so it says nothing about where the string occurs).
 */
export const HISTORY_READ_LABELS = [
  "history-partial-clone",
  "history-paths-excluded",
  "history-shallow",
] as const;
export type HistoryReadLabel = (typeof HISTORY_READ_LABELS)[number];
/**
 * What one page served of one source: a byte range of a file's text or of a
 * file's patch (after host-root masking), or an entry range of a commit walk,
 * where `path` is the log's path filter or null, and always null for a
 * search, whose scanned window is the range and whose path filter is the
 * citation's `paths`; `bytes` and `entries` are half-open, `start` included
 * and `end` not. A blame page serves `lines`:
 * counted from 1, both ends included, so `start` is the first served line,
 * `end` the last, and `1 <= start <= end`.
 */
export interface HistoryReadRangeV1 {
  path: string | null;
  unit: "bytes" | "entries" | "lines";
  start: number;
  end: number;
}
/**
 * One served history page, built by the host. `sha256` digests the exact text
 * the model received; `revisions` are full commit ids.
 */
export interface HistoryReadCitationV1 {
  tool: HistoryToolName;
  revisions: string[];
  paths: string[];
  ranges: HistoryReadRangeV1[];
  labels: HistoryReadLabel[];
  sha256: string;
  /** Diff only: changed paths left out as credential-bearing or generated. */
  excludedPathCount?: number;
  /**
   * Search only, and always present there: the full ids of the commits this
   * page served, each once. A commit whose files span pages is on each.
   */
  matchedCommits?: string[];
  /** The continuation handle this call resumed from. */
  cursor?: string;
  /** The continuation handle this call issued. */
  nextCursor?: string;
}
/**
 * Content-free read-loop counters for one attempt. Each unchanged re-read got a
 * host notice; `withheld` of them got the notice instead of the content.
 * `maxRepeatsOfOneResult` is the most re-reads of one unchanged result with no
 * progress call between. `maxUnchangedReReadsAcrossResults` is the most
 * unchanged re-reads of all results together with no progress call between;
 * records written before the cross-result bound lack it. `deniedAfterAsk`,
 * present only when positive, counts the tool calls the host denied after it
 * withdrew the tools on a conclude-now retry; each spent the read-loop stop's
 * allowance.
 */
export interface ReadEvidenceSnapshotV1 {
  readonly unchangedReReads: number;
  readonly withheld: number;
  readonly maxRepeatsOfOneResult: number;
  readonly maxUnchangedReReadsAcrossResults?: number;
  readonly deniedAfterAsk?: number;
}
/**
 * Content-free receipt for one oversized tool result archived for exact recall.
 * It rides on the capped result's `details` as `docsfabToolResultArchive` so a
 * reviewer can join the model-visible projection to the saved original.
 */
export interface ToolResultArchiveReceiptV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-tool-result-archive";
  /** Stable handle, unique within one confined tool set, for `docsfab_recall_tool_result`. */
  readonly handle: string;
  readonly sha256: string;
  /** Capped tool whose result was archived first under this digest. */
  readonly toolName: string;
  readonly totalBytes: number;
}
/**
 * Content-free receipt on a `docsfab_recall_tool_result` result's `details` as
 * `docsfabToolResultRecall`: the exact archived byte range returned.
 */
export interface ToolResultRecallReceiptV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-tool-result-recall";
  readonly handle: string;
  readonly sha256: string;
  readonly byteOffset: number;
  /** Exclusive end of the returned range. */
  readonly byteEnd: number;
  readonly totalBytes: number;
}
/** A result the archive refused at its declared ceiling; nothing was evicted. */
export interface ToolResultArchiveRefusalV1 {
  readonly limitName: string;
  /** Bytes the archive would have held had it accepted the result. */
  readonly observedBytes: number;
}
/** Archive state for one confined tool set, whose lifetime bounds the archive. */
export interface ToolResultArchiveSnapshotV1 {
  readonly receipts: readonly ToolResultArchiveReceiptV1[];
  readonly storedBytes: number;
  readonly ceilingBytes: number;
  readonly refusals: readonly ToolResultArchiveRefusalV1[];
}
