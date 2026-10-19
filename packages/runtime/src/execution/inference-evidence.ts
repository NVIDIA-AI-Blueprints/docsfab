// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { types as nodeUtilTypes } from "node:util";

import { limitDefinition } from "../config/limits.js";
import { createContractKit } from "../contract-kit/index.js";
import { isReviewOverdue } from "../model/configuration.js";
import { modelProfileEvidenceSha256 } from "../model/profile-evidence.js";
import type {
  HistoryReadCitationV1,
  HistoryReadRangeV1,
  ModelEvidence,
  ModelProfileEvidence,
  TokenUsage,
  ToolActivityEntry,
  ToolActivitySummary,
  ToolResultArchiveReceiptV1,
  ToolResultArchiveRefusalV1,
  ReadEvidenceSnapshotV1,
  ToolArgumentFillerRowV1,
  ToolRefusalIdMatchV1,
  ToolRefusalRowV1,
  ToolRefusalsV1,
  ToolResultArchiveSnapshotV1,
} from "../records/contracts.js";
import {
  HISTORY_READ_LABELS,
  HISTORY_TOOL_NAME_VALUES,
  SOURCE_TOOL_REFUSAL_TOOL_NAMES,
  TOOL_ARGUMENT_FILLER_KINDS,
  TOOL_FAILURE_DISPOSITIONS,
  TOOL_REFUSAL_ARGUMENT_KEYS,
  TOOL_REFUSAL_CODES,
  TOOL_REFUSAL_DETAIL_KINDS,
  TOOL_REFUSAL_ID_ARGUMENTS,
  TOOL_REFUSAL_ID_MATCHES,
} from "../records/contracts.js";
import {
  TOOL_REFUSAL_RECORD_MAX_ROWS_LIMIT,
  toolArgumentFillerRowKey,
  toolRefusalRowKey,
} from "../records/tool-refusals.js";

export type ScorecardRecordErrorCode = "invalid-scorecard-run-record" | "migration-required";

export class ScorecardRecordError extends Error {
  readonly code: ScorecardRecordErrorCode;
  /** The named sub-contract refusal, when one decided it (for example a composition binding). */
  readonly reason: string | undefined;

  constructor(code: ScorecardRecordErrorCode = "invalid-scorecard-run-record", reason?: string) {
    super(reason ? `Scorecard run record rejected: ${reason}.` : "Scorecard run record rejected.");
    this.name = "ScorecardRecordError";
    this.code = code;
    this.reason = reason;
  }
}

const inferenceEvidenceKit = createContractKit<ScorecardRecordErrorCode>({
  fail: (code) => {
    throw new ScorecardRecordError(code);
  },
  codes: {
    invalidShape: "invalid-scorecard-run-record",
    invalidValue: "invalid-scorecard-run-record",
    digestMismatch: "invalid-scorecard-run-record",
    credentialMaterial: "invalid-scorecard-run-record",
    schemaMismatch: "migration-required",
  },
  inertMode: "strict",
});

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/** One saved model whose attested review date had passed when its run started. */
export interface ReviewOverdueModelEvidence {
  provider: string;
  model: string;
  reviewAfter: string;
}

/**
 * The run record's "review overdue" advisory, projected
 * at read time from fields every record already carries (each model's attested
 * `profile.reviewAfter` and the run's own start time). It writes nothing, so no
 * record schema or digest changes. Models without a profile or with unknown
 * metadata never appear. A run time that is not a valid timestamp yields no
 * advisory rather than failing the reader: timestamp validity belongs to the
 * record decoders, and this line is advisory only.
 *
 * The saved-record reader (`runs show`) does not validate `models`, so this
 * accepts any value: a `models` that is not an array, and any member that is
 * not an object with string `provider`/`model` and a `YYYY-MM-DD`
 * `profile.reviewAfter`, contributes nothing instead of throwing.
 */
export function reviewOverdueModelEvidence(
  models: unknown,
  runStartedAt: string,
): ReviewOverdueModelEvidence[] {
  const asOf = new Date(runStartedAt);
  if (!Number.isFinite(asOf.valueOf()) || !Array.isArray(models)) return [];
  return models.flatMap((item: unknown) => {
    if (!isPlainRecord(item) || !isPlainRecord(item.profile)) return [];
    const { provider, model } = item;
    const reviewAfter = item.profile.reviewAfter;
    return typeof provider === "string" &&
      typeof model === "string" &&
      typeof reviewAfter === "string" &&
      ISO_DAY.test(reviewAfter) &&
      isReviewOverdue(reviewAfter, asOf)
      ? [{ provider, model, reviewAfter }]
      : [];
  });
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/u;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeModelEvidence(
  value: unknown,
): ModelEvidence & { profile: ModelProfileEvidence } {
  const item = object(value);
  exact(item, ["provider", "model", "profile"]);
  const provider = identifier(item.provider);
  const model = identifier(item.model);
  const profile = decodeModelProfile(item.profile);
  const { sha256, ...withoutDigest } = profile;
  requireCondition(
    modelProfileEvidenceSha256({ provider, model, profile: withoutDigest }) === sha256,
  );
  return { provider, model, profile };
}

function decodeModelProfile(value: unknown): ModelProfileEvidence {
  const item = object(value);
  exact(item, [
    "schemaVersion",
    "status",
    "configuredContextWindow",
    "effectiveContextWindow",
    "configuredMaxInputTokens",
    "effectiveMaxInputTokens",
    "configuredMaxOutputTokens",
    "effectiveMaxOutputTokens",
    "effectiveLimitReason",
    "apiFormat",
    "reasoning",
    "input",
    "compatibility",
    "requestPolicy",
    "costPerMillionTokens",
    "pricing",
    "approvedSourceSha256",
    "effectiveDate",
    "reviewAfter",
    "sha256",
  ]);
  const schemaVersion = oneOf(item.schemaVersion, [1, 2] as const);
  const status = oneOf(item.status, ["current", "stale", "unknown"] as const);
  const configuredContextWindow = positiveInteger(item.configuredContextWindow);
  const effectiveContextWindow = positiveInteger(item.effectiveContextWindow);
  const configuredMaxInputTokens =
    item.configuredMaxInputTokens === undefined
      ? undefined
      : positiveInteger(item.configuredMaxInputTokens);
  const effectiveMaxInputTokens =
    item.effectiveMaxInputTokens === undefined
      ? undefined
      : positiveInteger(item.effectiveMaxInputTokens);
  const configuredMaxOutputTokens = positiveInteger(item.configuredMaxOutputTokens);
  const effectiveMaxOutputTokens = positiveInteger(item.effectiveMaxOutputTokens);
  requireCondition(effectiveContextWindow <= configuredContextWindow);
  requireCondition(
    (configuredMaxInputTokens === undefined) === (effectiveMaxInputTokens === undefined),
  );
  requireCondition(
    schemaVersion === 1
      ? configuredMaxInputTokens === undefined
      : configuredMaxInputTokens !== undefined,
  );
  if (configuredMaxInputTokens !== undefined && effectiveMaxInputTokens !== undefined) {
    requireCondition(configuredMaxInputTokens <= configuredContextWindow);
    requireCondition(effectiveMaxInputTokens <= effectiveContextWindow);
    requireCondition(effectiveMaxInputTokens <= configuredMaxInputTokens);
  }
  requireCondition(effectiveMaxOutputTokens <= configuredMaxOutputTokens);
  requireCondition(configuredMaxOutputTokens <= configuredContextWindow);
  requireCondition(effectiveMaxOutputTokens <= effectiveContextWindow);
  const effectiveLimitReason = oneOf(item.effectiveLimitReason, [
    "none",
    "metadata-unknown",
    "metadata-stale",
    "composition-candidate",
  ] as const);
  const apiFormat = oneOf(item.apiFormat, ["chat_completions", "messages"] as const);
  const reasoning = boolean(item.reasoning);
  const input = uniqueSortedEnumArray(item.input, ["text", "image"] as const);
  requireCondition(input.includes("text"));
  const compatibilityItem = object(item.compatibility);
  exact(compatibilityItem, ["supportsDeveloperRole", "supportsReasoningEffort", "apiFormats"]);
  const compatibility = {
    supportsDeveloperRole: boolean(compatibilityItem.supportsDeveloperRole),
    supportsReasoningEffort: boolean(compatibilityItem.supportsReasoningEffort),
    apiFormats: uniqueSortedEnumArray(compatibilityItem.apiFormats, [
      "chat_completions",
      "messages",
    ] as const),
  };
  requireCondition(compatibility.apiFormats.includes(apiFormat));
  requireCondition(!compatibility.supportsReasoningEffort || reasoning);
  const policyItem = object(item.requestPolicy);
  exact(policyItem, ["minimumOutputTokens", "reservedContextTokens"]);
  const requestPolicy = {
    minimumOutputTokens: positiveInteger(policyItem.minimumOutputTokens),
    reservedContextTokens: positiveInteger(policyItem.reservedContextTokens),
  };
  requireCondition(
    requestPolicy.minimumOutputTokens + requestPolicy.reservedContextTokens <=
      effectiveContextWindow,
  );
  const costItem = object(item.costPerMillionTokens);
  exact(costItem, ["input", "output", "cacheRead", "cacheWrite"]);
  const costPerMillionTokens = {
    input: nullableNonnegativeFinite(costItem.input),
    output: nullableNonnegativeFinite(costItem.output),
    cacheRead: nullableNonnegativeFinite(costItem.cacheRead),
    cacheWrite: nullableNonnegativeFinite(costItem.cacheWrite),
  };
  const pricing = oneOf(item.pricing, ["known", "unknown"] as const);
  const allRatesKnown = Object.values(costPerMillionTokens).every((rate) => rate !== null);
  requireCondition(pricing === (allRatesKnown ? "known" : "unknown"));
  const approvedSourceSha256 =
    item.approvedSourceSha256 === undefined
      ? undefined
      : pattern(item.approvedSourceSha256, SHA256);
  const effectiveDate = item.effectiveDate === undefined ? undefined : date(item.effectiveDate);
  const reviewAfter = item.reviewAfter === undefined ? undefined : date(item.reviewAfter);
  const sha256 = pattern(item.sha256, SHA256);
  if (effectiveLimitReason === "composition-candidate") {
    requireCondition(pricing === "unknown");
    if (status === "unknown") {
      requireCondition(
        approvedSourceSha256 === undefined &&
          effectiveDate === undefined &&
          reviewAfter === undefined,
      );
    } else {
      requireCondition(
        approvedSourceSha256 !== undefined &&
          effectiveDate !== undefined &&
          reviewAfter !== undefined,
      );
    }
  } else if (status === "current") {
    requireCondition(
      effectiveLimitReason === "none" &&
        effectiveContextWindow === configuredContextWindow &&
        (configuredMaxInputTokens === undefined ||
          effectiveMaxInputTokens === configuredMaxInputTokens) &&
        effectiveMaxOutputTokens === configuredMaxOutputTokens &&
        approvedSourceSha256 !== undefined &&
        effectiveDate !== undefined &&
        reviewAfter !== undefined,
    );
  } else if (status === "stale") {
    requireCondition(
      effectiveLimitReason === "metadata-stale" &&
        pricing === "unknown" &&
        approvedSourceSha256 !== undefined &&
        effectiveDate !== undefined &&
        reviewAfter !== undefined,
    );
  } else {
    requireCondition(
      effectiveLimitReason === "metadata-unknown" &&
        pricing === "unknown" &&
        approvedSourceSha256 === undefined &&
        effectiveDate === undefined &&
        reviewAfter === undefined,
    );
  }
  return {
    schemaVersion,
    status,
    configuredContextWindow,
    effectiveContextWindow,
    ...(configuredMaxInputTokens === undefined
      ? {}
      : { configuredMaxInputTokens, effectiveMaxInputTokens }),
    configuredMaxOutputTokens,
    effectiveMaxOutputTokens,
    effectiveLimitReason,
    apiFormat,
    reasoning,
    input,
    compatibility,
    requestPolicy,
    costPerMillionTokens,
    pricing,
    ...(approvedSourceSha256 === undefined ? {} : { approvedSourceSha256 }),
    ...(effectiveDate === undefined ? {} : { effectiveDate }),
    ...(reviewAfter === undefined ? {} : { reviewAfter }),
    sha256,
  };
}

export function decodeUsage(value: unknown): TokenUsage {
  const item = object(value);
  exact(item, ["input", "output", "cacheRead", "cacheWrite", "total", "turns", "cost"]);
  const input = nonnegativeInteger(item.input);
  const output = nonnegativeInteger(item.output);
  const cacheRead = nonnegativeInteger(item.cacheRead);
  const cacheWrite = nonnegativeInteger(item.cacheWrite);
  const total = nonnegativeInteger(item.total);
  const turns = nonnegativeInteger(item.turns);
  requireCondition(safeSum([input, output, cacheRead, cacheWrite]) === total);
  const cost = item.cost === undefined ? undefined : roundedCost(nonnegativeFinite(item.cost));
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
    turns,
    ...(cost === undefined ? {} : { cost }),
  };
}

function decodePresentedTools(value: unknown): string[] {
  const seen = new Set<string>();
  const names = array(value).map((entry) => {
    const name = identifier(entry);
    requireCondition(!seen.has(name));
    seen.add(name);
    return name;
  });
  // Sorted on write, so an unsorted list means the record was not produced by
  // the harness that claims to have produced it.
  requireCondition(canonical(names) === canonical([...names].sort()));
  return names;
}

export function decodeTools(value: unknown): ToolActivitySummary {
  const item = object(value);
  exact(item, [
    "totalCalls",
    "failedCalls",
    "byTool",
    "failureCategories",
    "preExecutionRejections",
    "presented",
    "toolResultArchive",
    "readEvidence",
    "historyReads",
    "toolRefusals",
    "toolArgumentFiller",
  ]);
  const totalCalls = nonnegativeInteger(item.totalCalls);
  const failedCalls = nonnegativeInteger(item.failedCalls);
  requireCondition(failedCalls <= totalCalls);
  const seen = new Set<string>();
  const byTool = array(item.byTool).map((entry) => {
    const tool = object(entry);
    exact(tool, ["name", "calls", "failures"]);
    const name = identifier(tool.name);
    requireCondition(!seen.has(name));
    seen.add(name);
    const calls = nonnegativeInteger(tool.calls);
    const failures = nonnegativeInteger(tool.failures);
    requireCondition(failures <= calls);
    return { name, calls, failures };
  });
  requireCondition(
    canonical(byTool.map((entry) => entry.name)) ===
      canonical([...byTool.map((entry) => entry.name)].sort()),
  );
  requireCondition(safeSum(byTool.map((entry) => entry.calls)) === totalCalls);
  requireCondition(safeSum(byTool.map((entry) => entry.failures)) === failedCalls);
  const failureCategories =
    item.failureCategories === undefined
      ? undefined
      : decodeToolFailureCategories(item.failureCategories, failedCalls);
  const preExecutionRejections = (() => {
    if (item.preExecutionRejections === undefined) return undefined;
    const rejection = object(item.preExecutionRejections);
    exact(rejection, ["schemaVersion", "kind", "count"]);
    requireCondition(
      rejection.schemaVersion === 1 && rejection.kind === "tool-pre-execution-rejections",
    );
    const count = nonnegativeInteger(rejection.count);
    requireCondition(count > 0);
    return { schemaVersion: 1 as const, kind: "tool-pre-execution-rejections" as const, count };
  })();
  const presented = item.presented === undefined ? undefined : decodePresentedTools(item.presented);
  // Every called tool must have been presented; a presented tool the model
  // never called is the ordinary case this field preserves.
  if (presented !== undefined) {
    const offered = new Set(presented);
    requireCondition(byTool.every((entry) => offered.has(entry.name)));
  }
  const toolResultArchive =
    item.toolResultArchive === undefined
      ? undefined
      : decodeToolResultArchiveSnapshot(item.toolResultArchive);
  const governanceStops =
    failureCategories?.find((entry) => entry.category === "governance-stop")?.count ?? 0;
  const readEvidence =
    item.readEvidence === undefined
      ? undefined
      : decodeReadEvidence(item.readEvidence, totalCalls, governanceStops);
  const historyReads =
    item.historyReads === undefined ? undefined : decodeHistoryReads(item.historyReads, byTool);
  const toolRefusals =
    item.toolRefusals === undefined ? undefined : decodeToolRefusals(item.toolRefusals, byTool);
  const toolArgumentFiller =
    item.toolArgumentFiller === undefined
      ? undefined
      : decodeToolArgumentFiller(item.toolArgumentFiller, byTool);
  return {
    totalCalls,
    failedCalls,
    byTool,
    ...(failureCategories === undefined ? {} : { failureCategories }),
    ...(preExecutionRejections === undefined ? {} : { preExecutionRejections }),
    ...(presented === undefined ? {} : { presented }),
    ...(toolResultArchive === undefined ? {} : { toolResultArchive }),
    ...(readEvidence === undefined ? {} : { readEvidence }),
    ...(historyReads === undefined ? {} : { historyReads }),
    ...(toolRefusals === undefined ? {} : { toolRefusals }),
    ...(toolArgumentFiller === undefined ? {} : { toolArgumentFiller }),
  };
}

/**
 * Host-built filler rows: closed tools, argument names, and kinds, sorted and
 * unique, and never more calls setting one argument aside than the tool made.
 */
export function decodeToolArgumentFiller(
  value: unknown,
  byTool: readonly ToolActivityEntry[],
): ToolArgumentFillerRowV1[] {
  const rows = array(value).map((entry): ToolArgumentFillerRowV1 => {
    const row = object(entry);
    exact(row, ["tool", "argument", "kind", "count"]);
    return {
      tool: oneOf(row.tool, REFUSAL_TOOLS),
      argument: oneOf(row.argument, TOOL_REFUSAL_ARGUMENT_KEYS),
      kind: oneOf(row.kind, TOOL_ARGUMENT_FILLER_KINDS),
      count: positiveInteger(row.count),
    };
  });
  requireCondition(rows.length > 0);
  const keys = rows.map(toolArgumentFillerRowKey);
  requireCondition(new Set(keys).size === keys.length);
  requireCondition(canonical(keys) === canonical([...keys].sort()));
  // One call sets one argument aside at most once, whatever the kind.
  const perArgument = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.tool}\0${row.argument}`;
    perArgument.set(key, safeSum([perArgument.get(key) ?? 0, row.count]));
  }
  for (const [key, count] of perArgument) {
    const tool = key.slice(0, key.indexOf("\0"));
    requireCondition(count <= (byTool.find((entry) => entry.name === tool)?.calls ?? 0));
  }
  return rows;
}

const REFUSAL_TOOLS = [...SOURCE_TOOL_REFUSAL_TOOL_NAMES, ...HISTORY_TOOL_NAME_VALUES] as const;

/**
 * Host-built refusal rows: closed codes, kinds, argument names, and id
 * classes, unique, under the catalogued row bound, and never more refused
 * calls than the tools' recorded failures.
 */
export function decodeToolRefusals(
  value: unknown,
  byTool: readonly ToolActivityEntry[],
): ToolRefusalsV1 {
  const item = object(value);
  exact(item, ["rows", "overflowCount"]);
  const overflowCount = nonnegativeInteger(item.overflowCount);
  const rows = array(item.rows).map(decodeToolRefusalRow);
  requireCondition(rows.length > 0 || overflowCount > 0);
  requireCondition(rows.length <= limitDefinition(TOOL_REFUSAL_RECORD_MAX_ROWS_LIMIT).max);
  requireCondition(new Set(rows.map(toolRefusalRowKey)).size === rows.length);
  let refused = 0;
  for (const tool of REFUSAL_TOOLS) {
    const count = safeSum(rows.filter((row) => row.tool === tool).map((row) => row.count));
    const failures = byTool.find((entry) => entry.name === tool)?.failures ?? 0;
    requireCondition(count <= failures);
    refused += failures;
  }
  requireCondition(safeSum([...rows.map((row) => row.count), overflowCount]) <= refused);
  return { rows, overflowCount };
}

function decodeToolRefusalRow(value: unknown): ToolRefusalRowV1 {
  const item = object(value);
  exact(item, [
    "tool",
    "code",
    "detailKind",
    "argumentKeys",
    "undeclaredArgumentCount",
    "idMatches",
    "count",
  ]);
  const argumentKeys = array(item.argumentKeys).map((key) =>
    oneOf(key, TOOL_REFUSAL_ARGUMENT_KEYS),
  );
  requireCondition(new Set(argumentKeys).size === argumentKeys.length);
  requireCondition(canonical(argumentKeys) === canonical([...argumentKeys].sort()));
  const idMatches = array(item.idMatches).map((entry): ToolRefusalIdMatchV1 => {
    const match = object(entry);
    exact(match, ["argument", "match", "count"]);
    return {
      argument: oneOf(match.argument, TOOL_REFUSAL_ID_ARGUMENTS),
      match: oneOf(match.match, TOOL_REFUSAL_ID_MATCHES),
      count: positiveInteger(match.count),
    };
  });
  const matchKeys = idMatches.map((entry) => `${entry.argument}\0${entry.match}`);
  requireCondition(new Set(matchKeys).size === matchKeys.length);
  requireCondition(canonical(matchKeys) === canonical([...matchKeys].sort()));
  // A classified id is one the call sent, and a scalar argument holds one value.
  const sent = new Set<string>(argumentKeys);
  requireCondition(idMatches.every((entry) => sent.has(entry.argument)));
  for (const argument of new Set(idMatches.map((entry) => entry.argument))) {
    if (argument === "spanIds") continue;
    const values = idMatches.filter((entry) => entry.argument === argument);
    requireCondition(safeSum(values.map((entry) => entry.count)) === 1);
  }
  return {
    tool: oneOf(item.tool, REFUSAL_TOOLS),
    code: oneOf(item.code, TOOL_REFUSAL_CODES),
    detailKind: oneOf(item.detailKind, TOOL_REFUSAL_DETAIL_KINDS),
    argumentKeys,
    undeclaredArgumentCount: nonnegativeInteger(item.undeclaredArgumentCount),
    idMatches,
    count: positiveInteger(item.count),
  };
}

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/**
 * Host-built history citations. Each is one successful call of its tool, so a
 * tool's entries never outnumber its calls that did not fail.
 */
export function decodeHistoryReads(
  value: unknown,
  byTool: readonly ToolActivityEntry[],
): HistoryReadCitationV1[] {
  const entries = array(value).map(decodeHistoryRead);
  requireCondition(entries.length > 0);
  for (const tool of HISTORY_TOOL_NAME_VALUES) {
    const activity = byTool.find((entry) => entry.name === tool);
    const served = entries.filter((entry) => entry.tool === tool).length;
    requireCondition(served <= (activity ? activity.calls - activity.failures : 0));
  }
  return entries;
}

function decodeHistoryRead(value: unknown): HistoryReadCitationV1 {
  const item = object(value);
  exact(item, [
    "tool",
    "revisions",
    "paths",
    "ranges",
    "labels",
    "sha256",
    "excludedPathCount",
    "matchedCommits",
    "cursor",
    "nextCursor",
  ]);
  const tool = oneOf(item.tool, HISTORY_TOOL_NAME_VALUES);
  const revisions = array(item.revisions).map((revision) => pattern(revision, OBJECT_ID));
  requireCondition(
    tool === "docsfab_history_diff" ? revisions.length === 2 : revisions.length >= 1,
  );
  requireCondition(revisions.length <= 2);
  const paths = array(item.paths).map(historyPathText);
  const ranges = array(item.ranges).map(decodeHistoryRange);
  // Only blame serves lines, one file at one revision per page.
  const blame = tool === "docsfab_history_blame";
  requireCondition(ranges.every((range) => (range.unit === "lines") === blame));
  requireCondition(
    !blame ||
      (revisions.length === 1 &&
        paths.length === 1 &&
        ranges.length === 1 &&
        ranges[0]!.path === paths[0]),
  );
  const labels = array(item.labels).map((label) => oneOf(label, HISTORY_READ_LABELS));
  requireCondition(new Set(labels).size === labels.length);
  requireCondition(canonical(labels) === canonical([...labels].sort()));
  const excludedPathCount =
    item.excludedPathCount === undefined ? undefined : positiveInteger(item.excludedPathCount);
  requireCondition(
    excludedPathCount === undefined ||
      (tool === "docsfab_history_diff" && labels.includes("history-paths-excluded")),
  );
  const matchedCommits = decodeMatchedCommits(item.matchedCommits, tool, revisions, ranges);
  return {
    tool,
    revisions,
    paths,
    ranges,
    labels,
    sha256: pattern(item.sha256, SHA256),
    ...(excludedPathCount === undefined ? {} : { excludedPathCount }),
    ...(matchedCommits === undefined ? {} : { matchedCommits }),
    ...(item.cursor === undefined ? {} : { cursor: identifier(item.cursor) }),
    ...(item.nextCursor === undefined ? {} : { nextCursor: identifier(item.nextCursor) }),
  };
}

/**
 * A search page's served commits: present on every search citation and on no
 * other. Its one range is the scanned window, with no path, and it serves
 * each commit at most once, never more than the window scanned or the most
 * one window may scan.
 */
function decodeMatchedCommits(
  value: unknown,
  tool: HistoryReadCitationV1["tool"],
  revisions: readonly string[],
  ranges: readonly HistoryReadRangeV1[],
): string[] | undefined {
  if (tool !== "docsfab_history_search") {
    requireCondition(value === undefined);
    return undefined;
  }
  const window = ranges[0];
  requireCondition(
    ranges.length === 1 &&
      window !== undefined &&
      window.unit === "entries" &&
      window.path === null,
  );
  const commits = array(value).map((commit) => pattern(commit, OBJECT_ID));
  requireCondition(commits.every((commit) => commit.length === revisions[0]!.length));
  requireCondition(new Set(commits).size === commits.length);
  requireCondition(
    commits.length <= limitDefinition("gitHistory.pickaxeMaxCommitsScanned").max &&
      commits.length <= window!.end - window!.start,
  );
  return commits;
}

function decodeHistoryRange(value: unknown): HistoryReadRangeV1 {
  const item = object(value);
  exact(item, ["path", "unit", "start", "end"]);
  const start = nonnegativeInteger(item.start);
  const end = nonnegativeInteger(item.end);
  requireCondition(start <= end);
  const unit = oneOf(item.unit, ["bytes", "entries", "lines"] as const);
  // Lines count from 1 and include both ends, so a served range starts at line 1 or later.
  requireCondition(unit !== "lines" || start >= 1);
  return {
    path: item.path === null ? null : historyPathText(item.path),
    unit,
    start,
    end,
  };
}

/** Repository paths may hold any character but NUL. */
function historyPathText(value: unknown): string {
  requireCondition(typeof value === "string" && value.length > 0 && !value.includes("\0"));
  requireCondition(!hasUnpairedSurrogate(value as string));
  return value as string;
}

/**
 * Read-loop counters: integers only, each bounded by the calls they count. A
 * denied call never executed, so `deniedAfterAsk` is bounded by the
 * `governance-stop` partition, not by `totalCalls`.
 */
function decodeReadEvidence(
  value: unknown,
  totalCalls: number,
  governanceStops: number,
): ReadEvidenceSnapshotV1 {
  const item = object(value);
  exact(item, [
    "unchangedReReads",
    "withheld",
    "maxRepeatsOfOneResult",
    "maxUnchangedReReadsAcrossResults",
    "deniedAfterAsk",
  ]);
  const unchangedReReads = nonnegativeInteger(item.unchangedReReads);
  const withheld = nonnegativeInteger(item.withheld);
  const maxRepeatsOfOneResult = nonnegativeInteger(item.maxRepeatsOfOneResult);
  // Absent on records written before the cross-result bound.
  const acrossResults =
    item.maxUnchangedReReadsAcrossResults === undefined
      ? undefined
      : nonnegativeInteger(item.maxUnchangedReReadsAcrossResults);
  const deniedAfterAsk =
    item.deniedAfterAsk === undefined ? undefined : positiveInteger(item.deniedAfterAsk);
  requireCondition(
    (unchangedReReads > 0 || deniedAfterAsk !== undefined) &&
      unchangedReReads <= totalCalls &&
      withheld <= unchangedReReads &&
      (unchangedReReads === 0 ? maxRepeatsOfOneResult === 0 : maxRepeatsOfOneResult > 0) &&
      maxRepeatsOfOneResult <= unchangedReReads &&
      // One result's re-reads are among all results' re-reads, which are among the attempt's.
      (acrossResults === undefined ||
        (maxRepeatsOfOneResult <= acrossResults && acrossResults <= unchangedReReads)) &&
      (deniedAfterAsk === undefined || deniedAfterAsk <= governanceStops),
  );
  return {
    unchangedReReads,
    withheld,
    maxRepeatsOfOneResult,
    ...(acrossResults === undefined ? {} : { maxUnchangedReReadsAcrossResults: acrossResults }),
    ...(deniedAfterAsk === undefined ? {} : { deniedAfterAsk }),
  };
}

function decodeToolResultArchiveSnapshot(value: unknown): ToolResultArchiveSnapshotV1 {
  const item = object(value);
  exact(item, ["receipts", "storedBytes", "ceilingBytes", "refusals"]);
  const storedBytes = nonnegativeInteger(item.storedBytes);
  const ceilingBytes = nonnegativeInteger(item.ceilingBytes);
  const receipts = array(item.receipts).map(decodeToolResultArchiveReceipt);
  const refusals = array(item.refusals).map(decodeToolResultArchiveRefusal);
  return { receipts, storedBytes, ceilingBytes, refusals };
}

function decodeToolResultArchiveReceipt(value: unknown): ToolResultArchiveReceiptV1 {
  const item = object(value);
  exact(item, ["schemaVersion", "kind", "handle", "sha256", "toolName", "totalBytes"]);
  requireCondition(item.schemaVersion === 1);
  requireCondition(item.kind === "docsfab-tool-result-archive");
  return {
    schemaVersion: 1,
    kind: "docsfab-tool-result-archive",
    handle: identifier(item.handle),
    sha256: pattern(item.sha256, SHA256),
    toolName: identifier(item.toolName),
    totalBytes: nonnegativeInteger(item.totalBytes),
  };
}

function decodeToolResultArchiveRefusal(value: unknown): ToolResultArchiveRefusalV1 {
  const item = object(value);
  exact(item, ["limitName", "observedBytes"]);
  return {
    limitName: identifier(item.limitName),
    observedBytes: nonnegativeInteger(item.observedBytes),
  };
}

function decodeToolFailureCategories(
  value: unknown,
  failedCalls: number,
): NonNullable<ToolActivitySummary["failureCategories"]> {
  const seen = new Set<string>();
  const categories = array(value).map((entry) => {
    const item = object(entry);
    exact(item, ["category", "count"]);
    const category = oneOf(item.category, TOOL_FAILURE_DISPOSITIONS);
    requireCondition(!seen.has(category));
    seen.add(category);
    return { category, count: positiveInteger(item.count) };
  });
  requireCondition(
    canonical(categories.map((entry) => entry.category)) ===
      canonical([...categories.map((entry) => entry.category)].sort()),
  );
  // Executed categories partition failedCalls. `governance-stop` is a
  // supplemental never-executed partition and must not be counted in that sum.
  requireCondition(
    safeSum(
      categories
        .filter((entry) => entry.category !== "governance-stop")
        .map((entry) => entry.count),
    ) === failedCalls,
  );
  return categories;
}

function roundedCost(value: number): number {
  return Number(value.toFixed(12));
}

function object(value: unknown): Record<string, unknown> {
  const item = inferenceEvidenceKit.object(value);
  requireCondition(
    Object.values(Object.getOwnPropertyDescriptors(item)).every(
      (descriptor) => descriptor.value !== undefined,
    ),
  );
  return item;
}

function array(value: unknown): unknown[] {
  requireCondition(Array.isArray(value) && !nodeUtilTypes.isProxy(value));
  const items = inferenceEvidenceKit.array(value);
  requireCondition(
    Object.values(Object.getOwnPropertyDescriptors(items)).every(
      (descriptor) => descriptor.value !== undefined,
    ),
  );
  return items;
}

function exact(value: Record<string, unknown>, allowed: readonly string[]): void {
  inferenceEvidenceKit.noUnknown(value, [...allowed]);
}

function requireCondition(condition: unknown): asserts condition {
  if (!condition) throw new ScorecardRecordError();
}

function boolean(value: unknown): boolean {
  requireCondition(typeof value === "boolean");
  return value;
}

function safeText(value: unknown, maxLength: number): string {
  requireCondition(typeof value === "string" && value.length > 0 && value.length <= maxLength);
  requireCondition(!UNSAFE_TEXT.test(value) && !hasUnpairedSurrogate(value));
  return value;
}

function identifier(value: unknown): string {
  const decoded = safeText(value, 512);
  requireCondition(SAFE_ID.test(decoded));
  return decoded;
}

function pattern(value: unknown, expression: RegExp): string {
  requireCondition(typeof value === "string" && expression.test(value));
  return value;
}

function nonnegativeInteger(value: unknown): number {
  requireCondition(Number.isSafeInteger(value) && Number(value) >= 0);
  return Number(value);
}

function positiveInteger(value: unknown): number {
  const decoded = nonnegativeInteger(value);
  requireCondition(decoded > 0);
  return decoded;
}

function nonnegativeFinite(value: unknown): number {
  requireCondition(
    typeof value === "number" && Number.isFinite(value) && value >= 0 && !Object.is(value, -0),
  );
  return value;
}

function nullableNonnegativeFinite(value: unknown): number | null {
  return value === null ? null : nonnegativeFinite(value);
}

function date(value: unknown): string {
  requireCondition(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value));
  requireCondition(new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value);
  return value;
}

function oneOf<const T extends readonly unknown[]>(value: unknown, values: T): T[number] {
  requireCondition(values.includes(value));
  return value as T[number];
}

function uniqueSortedEnumArray<const T extends readonly string[]>(
  value: unknown,
  values: T,
): T[number][] {
  const decoded = array(value).map((item) => oneOf(item, values));
  requireCondition(new Set(decoded).size === decoded.length);
  requireCondition(canonical(decoded) === canonical([...decoded].sort()));
  requireCondition(decoded.length > 0);
  return decoded;
}

function safeSum(values: number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  requireCondition(Number.isSafeInteger(total));
  return total;
}

function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const item = object(value);
  return `{${Object.keys(item)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`)
    .join(",")}}`;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
