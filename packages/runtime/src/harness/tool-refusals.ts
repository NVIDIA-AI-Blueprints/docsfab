// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Content-free evidence of why source and git history tool calls were
 * refused. A row names the tool, the host's code, what kind of fix the
 * refusal asked for, which declared arguments the call sent, and how each id
 * argument relates to the ids the host issued. It never holds an id, path,
 * revision, or byte the model sent or was shown, so the record can say "every
 * read sent a mis-copied observation id" without repeating one.
 */

import { limit, type ResolveLimitsOptions } from "../config/limits.js";
import { SOURCE_DISCOVERY_REFUSAL_CODES } from "../inputs/source-discovery.js";
import type { SourceCitationDiagnosticCode } from "../inputs/source-evidence-artifacts.js";
import { SOURCE_EVIDENCE_SERVICE_ERROR_CODES } from "../inputs/source-resolver.js";
import { TOOL_REFUSAL_ARGUMENT_KEYS } from "../records/contracts.js";
import type {
  ToolArgumentFillerRowV1,
  ToolRefusalArgumentKey,
  ToolRefusalCode,
  ToolRefusalDetailKind,
  ToolRefusalIdArgument,
  ToolRefusalIdMatch,
  ToolRefusalIdMatchV1,
  ToolRefusalRowV1,
  ToolRefusalsV1,
} from "../records/contracts.js";
import {
  TOOL_REFUSAL_RECORD_MAX_ROWS_LIMIT,
  mergeToolArgumentFiller,
  toolArgumentFillerRowKey,
  toolRefusalRowKey,
} from "../records/tool-refusals.js";
import { GIT_HISTORY_CODES } from "../repository/git-history.js";

// Every producer's codes are record codes; a new producer code fails to compile here.
SOURCE_EVIDENCE_SERVICE_ERROR_CODES satisfies readonly ToolRefusalCode[];
SOURCE_DISCOVERY_REFUSAL_CODES satisfies readonly ToolRefusalCode[];
GIT_HISTORY_CODES satisfies readonly ToolRefusalCode[];
export type CitationCodesAreRecordCodes = SourceCitationDiagnosticCode extends ToolRefusalCode
  ? true
  : never;

/** One refused call, before identical calls collapse into a row. */
export type ToolRefusalCall = Omit<ToolRefusalRowV1, "count">;

export type ToolRefusalRecorder = (call: ToolRefusalCall) => void;

/**
 * Rows of one tool set (one step attempt), in first-refusal order. Identical
 * refusals add to their row's count; a call that would open a row past the
 * catalogued bound is counted, never dropped silently.
 */
export class ToolRefusalLedger {
  private readonly rows: ToolRefusalRowV1[] = [];
  private readonly index = new Map<string, ToolRefusalRowV1>();
  private overflowCount = 0;
  private readonly maxRows: number;

  public constructor(options?: ResolveLimitsOptions) {
    this.maxRows = limit(TOOL_REFUSAL_RECORD_MAX_ROWS_LIMIT, options).value;
  }

  public readonly record: ToolRefusalRecorder = (call) => {
    const key = toolRefusalRowKey(call);
    const row = this.index.get(key);
    if (row) {
      row.count += 1;
      return;
    }
    if (this.rows.length >= this.maxRows) {
      this.overflowCount += 1;
      return;
    }
    const created: ToolRefusalRowV1 = { ...structuredClone(call), count: 1 };
    this.rows.push(created);
    this.index.set(key, created);
  };

  /** `undefined` when nothing was refused, so a clean step records no field. */
  public snapshot(): ToolRefusalsV1 | undefined {
    if (this.rows.length === 0 && this.overflowCount === 0) return undefined;
    return {
      rows: structuredClone(this.rows),
      overflowCount: this.overflowCount,
    };
  }
}

/** One argument of one call the host set aside as filler. */
export type ToolArgumentFillerCall = Omit<ToolArgumentFillerRowV1, "count">;

export type ToolArgumentFillerRecorder = (call: ToolArgumentFillerCall) => void;

/**
 * Filler counts of one tool set (one step attempt). Rows are keyed by the
 * closed tool, argument, and kind vocabularies, so their number is bounded by
 * construction and nothing is ever dropped.
 */
export class ToolArgumentFillerLedger {
  private readonly rows = new Map<string, ToolArgumentFillerRowV1>();

  public readonly record: ToolArgumentFillerRecorder = (call) => {
    const key = toolArgumentFillerRowKey(call);
    const row = this.rows.get(key);
    if (row) row.count += 1;
    else this.rows.set(key, { ...call, count: 1 });
  };

  /** Sorted rows; `undefined` when no call sent filler, so a clean step records no field. */
  public snapshot(): ToolArgumentFillerRowV1[] | undefined {
    return mergeToolArgumentFiller([[...this.rows.values()]]);
  }
}

/**
 * The declared argument names a call sent, sorted, with nested object
 * arguments dotted (`range.from`), and how many names it sent that the tool
 * does not declare. Undeclared names are model text, so only their count is kept.
 */
export function toolArgumentKeys(
  params: unknown,
  declared: Readonly<Record<string, readonly string[] | true>>,
): { argumentKeys: ToolRefusalArgumentKey[]; undeclaredArgumentCount: number } {
  const keys: ToolRefusalArgumentKey[] = [];
  let undeclared = 0;
  if (!isPlainRecord(params)) return { argumentKeys: [], undeclaredArgumentCount: 0 };
  for (const [name, value] of Object.entries(params)) {
    const shape = Object.hasOwn(declared, name) ? declared[name] : undefined;
    if (shape === undefined || !isArgumentKey(name)) {
      undeclared += 1;
      continue;
    }
    keys.push(name);
    if (shape !== true && isPlainRecord(value)) {
      for (const nested of Object.keys(value)) {
        const dotted = `${name}.${nested}`;
        if (shape.includes(nested) && isArgumentKey(dotted)) keys.push(dotted);
        else undeclared += 1;
      }
    }
  }
  return { argumentKeys: keys.sort(), undeclaredArgumentCount: undeclared };
}

/** Ids of one kind the host issued, sorted for prefix search. */
export class IssuedIds {
  private readonly sorted: readonly string[];
  private readonly members: ReadonlySet<string>;
  private readonly lengths: ReadonlySet<number>;
  /** The shared `obs-` / `rep-` / `span-` prefix, when every id has one. */
  public readonly kindPrefix: string | undefined;

  public constructor(ids: Iterable<string>) {
    this.members = new Set(ids);
    this.sorted = [...this.members].sort();
    this.lengths = new Set(this.sorted.map((id) => id.length));
    const prefixes = new Set(this.sorted.map((id) => id.slice(0, id.indexOf("-") + 1)));
    const [only] = prefixes;
    this.kindPrefix = prefixes.size === 1 && only ? only : undefined;
  }

  public has(value: string): boolean {
    return this.members.has(value);
  }

  public hasLength(length: number): boolean {
    return this.lengths.has(length);
  }

  /** Whether `value` is a proper prefix of exactly one id. */
  public uniquePrefix(value: string): boolean {
    let low = 0;
    let high = this.sorted.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.sorted[middle]! < value) low = middle + 1;
      else high = middle;
    }
    const first = this.sorted[low];
    if (first === undefined || first.length <= value.length || !first.startsWith(value)) {
      return false;
    }
    return !(this.sorted[low + 1]?.startsWith(value) ?? false);
  }
}

/**
 * How one id value relates to the ids of its own kind, then to the handles,
 * paths, and ids of other kinds the host issued. Pure: no value is kept.
 */
export function classifyIssuedId(
  value: unknown,
  own: IssuedIds,
  others: {
    readonly handles?: ReadonlySet<string>;
    readonly paths?: ReadonlySet<string>;
    readonly otherKinds?: readonly IssuedIds[];
  } = {},
): ToolRefusalIdMatch {
  if (typeof value !== "string" || value.length === 0) return "malformed";
  if (others.handles?.has(value)) return "handle";
  if (own.has(value)) return "exact";
  if (others.paths?.has(value)) return "path";
  if (own.uniquePrefix(value)) return "unique-prefix";
  if (own.kindPrefix !== undefined && value.startsWith(own.kindPrefix)) {
    return own.hasLength(value.length) ? "near-miss-same-length" : "near-miss-other-length";
  }
  if (others.otherKinds?.some((ids) => ids.has(value))) return "other-kind";
  return "unknown";
}

/** Collapse per-value classes into sorted `{ argument, match, count }` entries. */
export function idMatchEntries(
  classes: ReadonlyArray<readonly [ToolRefusalIdArgument, ToolRefusalIdMatch]>,
): ToolRefusalIdMatchV1[] {
  const counts = new Map<string, ToolRefusalIdMatchV1>();
  for (const [argument, match] of classes) {
    const key = `${argument}\0${match}`;
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { argument, match, count: 1 });
  }
  return [...counts.values()].sort((left, right) =>
    compareCodeUnits(`${left.argument}\0${left.match}`, `${right.argument}\0${right.match}`),
  );
}

/** Code-unit order, the order the record decoders check. */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const ARGUMENT_KEYS: ReadonlySet<string> = new Set(TOOL_REFUSAL_ARGUMENT_KEYS);

function isArgumentKey(name: string): name is ToolRefusalArgumentKey {
  return ARGUMENT_KEYS.has(name);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type { ToolRefusalDetailKind };
