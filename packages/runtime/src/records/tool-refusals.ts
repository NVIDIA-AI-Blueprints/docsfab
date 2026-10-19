// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helpers over recorded tool refusals, shared by the harness that writes
 * them, the runner that merges a step's attempts, and the readers that check
 * a record. No runtime imports, so a decoder can load it cheaply.
 */

import type { ToolArgumentFillerRowV1, ToolRefusalRowV1, ToolRefusalsV1 } from "./contracts.js";

/** The catalogued bound on a step's refusal rows; see `config/limits/sources.yaml`. */
export const TOOL_REFUSAL_RECORD_MAX_ROWS_LIMIT = "sources.toolRefusalRecordMaxRows" as const;

/** Rows that agree on every field but the count are one row. */
export function toolRefusalRowKey(row: Omit<ToolRefusalRowV1, "count">): string {
  return JSON.stringify([
    row.tool,
    row.code,
    row.detailKind,
    row.argumentKeys,
    row.undeclaredArgumentCount,
    row.idMatches.map((entry) => [entry.argument, entry.match, entry.count]),
  ]);
}

/**
 * A step's refusals from its attempts', in attempt order: identical rows add
 * their counts, and a row that would pass `maxRows` adds its count to the
 * overflow, as one attempt's ledger does.
 */
export function mergeToolRefusals(
  snapshots: readonly ToolRefusalsV1[],
  maxRows: number,
): ToolRefusalsV1 | undefined {
  if (snapshots.length === 0) return undefined;
  const rows: ToolRefusalRowV1[] = [];
  const index = new Map<string, ToolRefusalRowV1>();
  let overflowCount = 0;
  for (const snapshot of snapshots) {
    overflowCount += snapshot.overflowCount;
    for (const row of snapshot.rows) {
      const key = toolRefusalRowKey(row);
      const existing = index.get(key);
      if (existing) {
        existing.count += row.count;
      } else if (rows.length >= maxRows) {
        overflowCount += row.count;
      } else {
        const copy = structuredClone(row);
        rows.push(copy);
        index.set(key, copy);
      }
    }
  }
  return { rows, overflowCount };
}

/** The order filler rows are kept in: tool, then argument, then kind. */
export function toolArgumentFillerRowKey(row: Omit<ToolArgumentFillerRowV1, "count">): string {
  return `${row.tool}\0${row.argument}\0${row.kind}`;
}

/**
 * Filler rows of several attempts or calls as one sorted list: rows that agree
 * on tool, argument, and kind add their counts.
 */
export function mergeToolArgumentFiller(
  lists: readonly (readonly ToolArgumentFillerRowV1[])[],
): ToolArgumentFillerRowV1[] | undefined {
  const rows = new Map<string, ToolArgumentFillerRowV1>();
  for (const list of lists) {
    for (const row of list) {
      const key = toolArgumentFillerRowKey(row);
      const existing = rows.get(key);
      if (existing) existing.count += row.count;
      else rows.set(key, { ...row });
    }
  }
  if (rows.size === 0) return undefined;
  return [...rows.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, row]) => row);
}
