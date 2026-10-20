// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Attempt-scoped read-evidence ledger: what the read-class tools have already
 * delivered to the model, so useful progress is judged by evidence and not by
 * a fresh provider call ID.
 *
 * A read-class result is new evidence unless the same call already returned
 * the same model-visible bytes in the current epoch. A compaction starts a new
 * epoch, because it may have removed earlier results from the context. A
 * result re-read unchanged is still delivered in full with a host notice until
 * its own repeats pass `execution.readLoopRepeatStreak`, or the unchanged
 * re-reads of all results together pass `execution.readLoopUnchangedReReads`;
 * after that only the notice is sent, since the identical bytes are still in
 * context. Nothing new, changed, or from another range is ever withheld. Past
 * `execution.readLoopWithheldReads` notice-only answers the host ends the
 * attempt as `no-progress`. Notice-only answers are counted on whichever bound
 * withheld more (the most re-read result, or all results past the cross-result
 * allowance), plus the calls the host denied after it withdrew the tools and
 * asked for the answer.
 */
import { createHash } from "node:crypto";

import {
  formatLimitObservation,
  limit,
  type ResolveLimitsOptions,
  type ResolvedLimit,
} from "../config/limits.js";
import type { ReadEvidenceSnapshotV1 } from "../records/contracts.js";
import { OBSERVATION_TOOL_NAMES } from "./observation-tools.js";
import {
  FILESYSTEM_READ_ONLY_TOOLS,
  QUALITY_CANDIDATE_VALIDATION_TOOL_NAME,
} from "./pi-tool-confine.js";
import {
  PRESERVATION_SOURCE_READ_TOOL_NAMES,
  SOURCE_READ_TOOL_NAMES,
  SOURCE_SEARCH_TOOL_NAMES,
} from "./source-tools.js";
import { TOOL_RESULT_RECALL_TOOL_NAME } from "./tool-output-cap.js";
import { HISTORY_TOOL_NAMES } from "./history-tools.js";
import { READ_LOOP_LIMITS } from "../config/execution-limit-stops.js";
import { REVIEW_CHANGE_READ_TOOL_NAME } from "./confined-tools/review-change-side.js";

export const READ_LOOP_REPEAT_STREAK_LIMIT = READ_LOOP_LIMITS.repeatStreak;
export const READ_LOOP_WITHHELD_READS_LIMIT = READ_LOOP_LIMITS.withheldReads;
export const READ_LOOP_UNCHANGED_RE_READS_LIMIT = READ_LOOP_LIMITS.unchangedReReads;

/** Tools that only observe; an identical repeat adds no evidence. */
export const READ_EVIDENCE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...FILESYSTEM_READ_ONLY_TOOLS,
  TOOL_RESULT_RECALL_TOOL_NAME,
  ...SOURCE_READ_TOOL_NAMES,
  ...PRESERVATION_SOURCE_READ_TOOL_NAMES,
  ...SOURCE_SEARCH_TOOL_NAMES,
  ...OBSERVATION_TOOL_NAMES,
  ...HISTORY_TOOL_NAMES,
  REVIEW_CHANGE_READ_TOOL_NAME,
]);

/**
 * Tools whose success is step progress: they change the workspace or put a
 * proposal on the record. Any other tool is neutral: it neither adds read
 * evidence nor resets the repeat counts.
 */
export const READ_LOOP_PROGRESS_TOOL_NAMES: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "canon_propose_claim",
  "canon_conflict_gap",
  "canon_submit_artifact",
  QUALITY_CANDIDATE_VALIDATION_TOOL_NAME,
]);

export interface ReadLoopPolicy {
  readonly repeatStreak: ResolvedLimit;
  readonly withheldReads: ResolvedLimit;
  readonly unchangedReReads: ResolvedLimit;
}

export function resolveReadLoopPolicy(options?: ResolveLimitsOptions): ReadLoopPolicy {
  return {
    repeatStreak: limit(READ_LOOP_REPEAT_STREAK_LIMIT, options),
    withheldReads: limit(READ_LOOP_WITHHELD_READS_LIMIT, options),
    unchangedReReads: limit(READ_LOOP_UNCHANGED_RE_READS_LIMIT, options),
  };
}

/** Which bound a read-loop stop is charged to: one result's, or all results'. */
export type ReadLoopStopBound = "one-result" | "across-results";

/**
 * How the ledger judged one executed call. Read-class calls are `new-evidence`,
 * `repeat` or `withheld`; progress-class calls are `progress`, or
 * `repeated-progress` when the identical call already succeeded.
 */
export type ReadEvidenceClassification =
  | "new-evidence"
  | "repeat"
  | "withheld"
  | "progress"
  | "repeated-progress";

/** Whether a classified success counts as useful progress for lease renewal. */
export function isUsefulProgress(classification: ReadEvidenceClassification | undefined): boolean {
  return (
    classification === undefined ||
    classification === "new-evidence" ||
    classification === "progress"
  );
}

interface Delivery {
  readonly turn: number;
  /** Unchanged re-reads of this result since the last progress call. */
  repeats: number;
}

/** Content-free counters for the stop message and tests. */
export interface ReadEvidenceCounters {
  readonly epoch: number;
  /** Most unchanged re-reads of any one result since the last progress call. */
  readonly worstRepeats: number;
  /** Unchanged re-reads of all results since the last progress call. */
  readonly acrossResults: number;
  readonly repeats: number;
  readonly withheld: number;
  /** Calls denied after the host withdrew the tools and asked for the answer. */
  readonly deniedAfterAsk: number;
}

/**
 * Counted per result and across results. A loop that re-reads one result is
 * caught by its own count; a loop that cycles through several results, none of
 * them often, by the total. Only a new progress call resets the counts, so a
 * loop that interleaves other reads still accumulates. A compaction resets the
 * per-result counts with the epoch but not the total: a re-read after it is new
 * evidence and adds nothing, so the total never counts content the model lost.
 */
export class ReadEvidenceLedger {
  private epochValue = 1;
  /** Call key -> result digest -> first delivery in this epoch. */
  private delivered = new Map<string, Map<string, Delivery>>();
  private worstRepeatsValue = 0;
  private acrossResultsValue = 0;
  private peakAcrossResultsValue = 0;
  private repeatsValue = 0;
  private withheldValue = 0;
  private deniedAfterAskValue = 0;
  private peakRepeatsValue = 0;
  /** Progress-class calls that already succeeded, by tool and arguments. */
  private readonly progressKeys = new Set<string>();
  private readonly classifications = new Map<string, ReadEvidenceClassification>();
  private turnSource: () => number = () => 0;

  public constructor(public readonly policy: ReadLoopPolicy) {}

  /** The governed provider turn a tool call belongs to; bound once the connection exists. */
  public bindTurnSource(source: () => number): void {
    this.turnSource = source;
  }

  /** A compaction may have dropped earlier results, so nothing counts as delivered. */
  public startEpoch(): void {
    this.epochValue += 1;
    this.delivered = new Map();
    this.worstRepeatsValue = 0;
  }

  /**
   * A successful progress-class call resets every repeat count, unless the
   * identical call already succeeded: re-sending the same proposal is not progress.
   */
  public observeProgress(toolCallId: string, toolName: string, args: unknown): void {
    const key = callKey(toolName, args);
    if (key !== undefined && this.progressKeys.has(key)) {
      this.classifications.set(toolCallId, "repeated-progress");
      return;
    }
    if (key !== undefined) this.progressKeys.add(key);
    this.classifications.set(toolCallId, "progress");
    for (const byDigest of this.delivered.values()) {
      for (const delivery of byDigest.values()) delivery.repeats = 0;
    }
    this.worstRepeatsValue = 0;
    this.acrossResultsValue = 0;
  }

  /** The classification of the latest execution under this provider call ID, consumed once. */
  public takeClassification(toolCallId: string): ReadEvidenceClassification | undefined {
    const value = this.classifications.get(toolCallId);
    this.classifications.delete(toolCallId);
    return value;
  }

  /** Notice-only re-reads of the most re-read result since the last progress call. */
  public get withheldOfWorst(): number {
    return Math.max(0, this.worstRepeatsValue - this.policy.repeatStreak.value);
  }

  /** Notice-only re-reads past the cross-result allowance since the last progress call. */
  public get withheldAcrossResults(): number {
    return Math.max(0, this.acrossResultsValue - this.policy.unchangedReReads.value);
  }

  /**
   * The bound the notice-only answers are charged to: the one that withheld
   * more. A tie stays with the one-result bound, so a pure one-result loop
   * keeps its own code.
   */
  public get stopBound(): ReadLoopStopBound {
    return this.withheldAcrossResults > this.withheldOfWorst ? "across-results" : "one-result";
  }

  /**
   * A call the host denied after it withdrew the tools and asked for the
   * answer. It adds no evidence, so it spends the same notice-only allowance
   * as a withheld re-read. Neither a progress call nor a compaction resets it:
   * no call runs once the tools are withdrawn.
   */
  public recordDeniedAfterAsk(calls: number): void {
    this.deniedAfterAskValue += calls;
  }

  /** Notice-only answers the attempt has spent: withheld re-reads on the charged bound plus denied calls. */
  public get noticeOnlyAnswers(): number {
    return Math.max(this.withheldOfWorst, this.withheldAcrossResults) + this.deniedAfterAskValue;
  }

  public get stopDue(): boolean {
    return this.noticeOnlyAnswers > this.policy.withheldReads.value;
  }

  public counters(): ReadEvidenceCounters {
    return {
      epoch: this.epochValue,
      worstRepeats: this.worstRepeatsValue,
      acrossResults: this.acrossResultsValue,
      repeats: this.repeatsValue,
      withheld: this.withheldValue,
      deniedAfterAsk: this.deniedAfterAskValue,
    };
  }

  /**
   * The attempt record's counters, or `undefined` when nothing was re-read
   * unchanged and no call was denied after an ask. The denied count is kept so
   * the record alone explains a stop's observed value.
   */
  public snapshot(): ReadEvidenceSnapshotV1 | undefined {
    if (this.repeatsValue === 0 && this.deniedAfterAskValue === 0) return undefined;
    return {
      unchangedReReads: this.repeatsValue,
      withheld: this.withheldValue,
      maxRepeatsOfOneResult: this.peakRepeatsValue,
      maxUnchangedReReadsAcrossResults: this.peakAcrossResultsValue,
      ...(this.deniedAfterAskValue > 0 ? { deniedAfterAsk: this.deniedAfterAskValue } : {}),
    };
  }

  /** Content-free coded reason for the attempt record: the charged bound's catalog refusal. */
  public stopRejection(): { code: string; location: string } {
    const bound =
      this.stopBound === "across-results"
        ? this.policy.unchangedReReads
        : this.policy.withheldReads;
    return { code: bound.refusal, location: "$.tools" };
  }

  /**
   * Operator line for the `no-progress` stop: the charged bound's code, its
   * observed value and limit, and the remediation. Code and line come from the
   * same `stopBound`, so they always name the same bound.
   */
  public stopMessage(): string {
    const denied =
      this.deniedAfterAskValue === 0
        ? ""
        : ` After the host withdrew the tools and asked for the answer, the model made ${this.deniedAfterAskValue} more tool calls, each denied.`;
    if (this.stopBound === "across-results") {
      return `${formatLimitObservation(this.policy.unchangedReReads, this.acrossResultsValue)} Read loop across results in this step attempt: ${this.acrossResultsValue} unchanged re-reads with no progress call between, at most ${this.worstRepeatsValue} of one result; the host answered the last ${this.withheldAcrossResults} with a notice only, and the notice-only allowance is ${this.policy.withheldReads.name} = ${this.policy.withheldReads.value}.${denied}`;
    }
    return `${formatLimitObservation(this.policy.withheldReads, this.noticeOnlyAnswers)} Read loop in this step attempt: one unchanged result was re-read ${this.worstRepeatsValue} times with no progress call between (${this.repeatsValue} unchanged re-reads in the attempt).${denied}`;
  }

  /**
   * Classify one successful read-class result and return the content the
   * model receives. `content` is the exact model-visible block list.
   */
  public observe(
    toolCallId: string,
    toolName: string,
    args: unknown,
    content: readonly unknown[],
  ): { classification: ReadEvidenceClassification; content: unknown[] } {
    const key = callKey(toolName, args);
    const digest = contentDigest(content);
    if (key === undefined || digest === undefined) {
      // An argument or result the ledger cannot fingerprint is never judged a repeat.
      this.classifications.set(toolCallId, "new-evidence");
      return { classification: "new-evidence", content: [...content] };
    }
    const byDigest = this.delivered.get(key) ?? new Map<string, Delivery>();
    const delivery = byDigest.get(digest);
    if (!delivery) {
      byDigest.set(digest, { turn: this.turnSource(), repeats: 0 });
      this.delivered.set(key, byDigest);
      this.classifications.set(toolCallId, "new-evidence");
      return { classification: "new-evidence", content: [...content] };
    }
    delivery.repeats += 1;
    this.repeatsValue += 1;
    this.acrossResultsValue += 1;
    this.worstRepeatsValue = Math.max(this.worstRepeatsValue, delivery.repeats);
    this.peakRepeatsValue = Math.max(this.peakRepeatsValue, delivery.repeats);
    this.peakAcrossResultsValue = Math.max(this.peakAcrossResultsValue, this.acrossResultsValue);
    const target = describeTarget(toolName, args);
    const pastOneResult = delivery.repeats > this.policy.repeatStreak.value;
    const pastAcrossResults = this.acrossResultsValue > this.policy.unchangedReReads.value;
    if (!pastOneResult && !pastAcrossResults) {
      this.classifications.set(toolCallId, "repeat");
      return {
        classification: "repeat",
        content: [
          ...content,
          {
            type: "text",
            text: repeatNotice(toolName, target, delivery.turn, delivery.repeats, this.policy),
          },
        ],
      };
    }
    this.withheldValue += 1;
    this.classifications.set(toolCallId, "withheld");
    return {
      classification: "withheld",
      content: [
        {
          type: "text",
          text: withheldNotice({
            toolName,
            target,
            firstTurn: delivery.turn,
            repeats: delivery.repeats,
            acrossResults: pastOneResult ? undefined : this.acrossResultsValue,
            noticeOnlyAnswers: this.noticeOnlyAnswers,
            policy: this.policy,
          }),
        },
      ],
    };
  }
}

export const READ_EVIDENCE_NOTICE_PREFIX = "[DocsFab host]";

function repeatNotice(
  toolName: string,
  target: string,
  firstTurn: number,
  repeats: number,
  policy: ReadLoopPolicy,
): string {
  return `${READ_EVIDENCE_NOTICE_PREFIX} This ${toolName} result${target} is unchanged since turn ${firstTurn} and is already in your context. Re-reading it adds no evidence (re-read ${repeats} times; after ${policy.repeatStreak.value} re-reads of one result, or ${policy.unchangedReReads.value} unchanged re-reads across results, the host stops re-sending it). Continue the step with what you have.`;
}

/**
 * The notice that replaces a withheld re-read. `acrossResults` is set when the
 * cross-result allowance, not this result's own count, withheld it. The stop
 * point is stated as notice-only answers left, which is true for either bound.
 */
function withheldNotice(input: {
  readonly toolName: string;
  readonly target: string;
  readonly firstTurn: number;
  readonly repeats: number;
  readonly acrossResults: number | undefined;
  readonly noticeOnlyAnswers: number;
  readonly policy: ReadLoopPolicy;
}): string {
  const { toolName, target, firstTurn, repeats, acrossResults, noticeOnlyAnswers, policy } = input;
  const why =
    acrossResults === undefined
      ? `Unchanged re-reads add no evidence (re-read ${repeats} times).`
      : `This attempt has re-read ${acrossResults} unchanged results with no progress between; past ${policy.unchangedReReads.value} the host sends only this notice.`;
  // The stop is due once notice-only answers pass the allowance.
  const untilStop = Math.max(0, policy.withheldReads.value - noticeOnlyAnswers) + 1;
  return `${READ_EVIDENCE_NOTICE_PREFIX} Not re-sent: this ${toolName} result${target} is unchanged since turn ${firstTurn}, and that content is still in your context. ${why} New files, changed files and other ranges are still delivered in full. Finish the step now with the evidence you have; ${untilStop} more notice-only ${untilStop === 1 ? "answer ends" : "answers end"} this attempt as no-progress.`;
}

function describeTarget(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const record = args as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path : undefined;
  if (toolName === "read" && path !== undefined) {
    const offset = typeof record.offset === "number" ? ` from line ${record.offset}` : "";
    const limitLines = typeof record.limit === "number" ? `, ${record.limit} lines` : "";
    return ` for ${path}${offset}${limitLines}`;
  }
  return path !== undefined ? ` for ${path} with the same arguments` : " with the same arguments";
}

function callKey(toolName: string, args: unknown): string | undefined {
  const canonical = stableJson({ toolName, args: args ?? null });
  return canonical === undefined ? undefined : sha256(canonical);
}

function contentDigest(content: readonly unknown[]): string | undefined {
  const canonical = stableJson(content);
  return canonical === undefined ? undefined : sha256(canonical);
}

/** Key-sorted JSON of plain data, or `undefined` for anything else. */
function stableJson(value: unknown): string | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      const encoded = stableJson(item);
      if (encoded === undefined) return undefined;
      items.push(encoded);
    }
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return undefined;
    const entries: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) continue;
      const encoded = stableJson(item);
      if (encoded === undefined) return undefined;
      entries.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${entries.join(",")}}`;
  }
  return undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

type AnyToolDefinition = {
  name: string;
  execute: (...arguments_: any[]) => Promise<any>;
};

/**
 * Wrap one confined tool for the ledger. Read-class results are classified and
 * may gain a notice or be replaced by one; a successful progress-class call
 * resets the repeat counts unless it repeats an identical call; every other
 * tool passes through. A failed call is neutral.
 */
export function withReadEvidence<T extends AnyToolDefinition>(
  definition: T,
  ledger: ReadEvidenceLedger,
): T {
  const execute = definition.execute.bind(definition) as (...arguments_: any[]) => Promise<any>;
  if (READ_LOOP_PROGRESS_TOOL_NAMES.has(definition.name)) {
    return {
      ...definition,
      async execute(...arguments_: any[]) {
        const result = await execute(...arguments_);
        const toolCallId = arguments_[0];
        if (typeof toolCallId === "string") {
          ledger.observeProgress(toolCallId, definition.name, arguments_[1]);
        }
        return result;
      },
    };
  }
  if (!READ_EVIDENCE_TOOL_NAMES.has(definition.name)) return definition;
  return {
    ...definition,
    async execute(...arguments_: any[]) {
      const result = await execute(...arguments_);
      const toolCallId = arguments_[0];
      if (typeof toolCallId !== "string" || !result || typeof result !== "object") return result;
      const record = result as { content?: unknown };
      if (!Array.isArray(record.content)) return result;
      const observed = ledger.observe(toolCallId, definition.name, arguments_[1], record.content);
      if (observed.classification === "new-evidence") return result;
      return { ...(result as Record<string, unknown>), content: observed.content };
    },
  };
}
