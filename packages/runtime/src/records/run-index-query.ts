// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Run index query semantics.
 *
 * 1. Drop incomplete snapshots, then keep each run's newest complete snapshot
 *    (file order), so a re-saved or re-imported run counts once.
 * 2. Filter: values for one field are OR, fields are AND, `unavailable`
 *    matches null. Without a `rowKind` clause the filter is `rowKind=attempt`,
 *    so run and step rows never enter the default population.
 * 3. The filtered rows are the denominator; each group reports its rows,
 *    distinct runs, and share of that population.
 * 4. `runEndRunIds` names the runs whose `run` rows say how they ended: the
 *    population's runs, or, when `rowKind` was defaulted, every run with a row
 *    of any kind that matches the other clauses, so a run without attempts is
 *    not left out.
 */
import type { RunIndexQueryField, RunIndexRowKind, RunIndexRowV1 } from "./run-index.js";

/** Rendering and matching token for a null field. */
export const RUN_INDEX_UNAVAILABLE = "unavailable";

export const RUN_INDEX_DEFAULT_ROW_KIND: RunIndexRowKind = "attempt";

export interface RunIndexQuery {
  readonly where: ReadonlyMap<RunIndexQueryField, readonly string[]>;
  /** Inclusive lower bound on `runCreatedAt`, as epoch milliseconds. */
  readonly sinceMs?: number;
  /** Exclusive upper bound on `runCreatedAt`, as epoch milliseconds. */
  readonly untilMs?: number;
  readonly groupBy: readonly RunIndexQueryField[];
  /** Only these runs' rows enter the population. */
  readonly runIds?: ReadonlySet<string>;
}

/** The `run` row fields that say how a run ended, for `runs query`'s RUN ENDS. */
export const RUN_INDEX_RUN_END_FIELDS = Object.freeze([
  "workflow",
  "model",
  "runStatus",
  "terminalStepId",
  "failureClass",
  "failureCode",
] as const satisfies readonly RunIndexQueryField[]);

export interface RunIndexQueryGroup {
  readonly key: Readonly<Record<string, string | number | boolean | null>>;
  readonly rows: number;
  readonly runs: number;
  /** 0 for an empty population. */
  readonly share: number;
}

export interface RunIndexQueryResult {
  /** Rows the newest snapshots contain before filtering. */
  readonly indexedRows: number;
  /** Rows dropped because a newer snapshot of the same run exists. */
  readonly supersededRows: number;
  /** Snapshots dropped because some of their rows are missing. */
  readonly incompleteSnapshots: number;
  /** The `where` actually applied, including a defaulted `rowKind`. */
  readonly appliedWhere: ReadonlyMap<RunIndexQueryField, readonly string[]>;
  readonly rowKindDefaulted: boolean;
  readonly population: {
    readonly rows: number;
    readonly runs: number;
    /** Population rows that could not copy at least one recorded field. */
    readonly rowsWithOmittedFields: number;
  };
  readonly groups: readonly RunIndexQueryGroup[];
  /** The runs whose `run` rows a RUN ENDS reading groups; see the module notes. */
  readonly runEndRunIds: ReadonlySet<string>;
}

export function queryRunIndex(
  rows: readonly RunIndexRowV1[],
  query: RunIndexQuery,
): RunIndexQueryResult {
  const complete = completeSnapshots(rows);
  const current = newestSnapshots(complete.rows);
  const rowKindDefaulted = !query.where.has("rowKind");
  const appliedWhere = new Map(query.where);
  if (rowKindDefaulted) appliedWhere.set("rowKind", [RUN_INDEX_DEFAULT_ROW_KIND]);
  const population = current.filter((row) => matches(row, { ...query, where: appliedWhere }));
  const runEndRunIds = new Set(
    (rowKindDefaulted ? current.filter((row) => matches(row, query)) : population).map(
      (row) => row.runId,
    ),
  );
  const groups = new Map<
    string,
    { key: Record<string, unknown>; rows: number; runs: Set<string> }
  >();
  for (const row of population) {
    const key: Record<string, unknown> = {};
    for (const field of query.groupBy) key[field] = row[field] ?? null;
    const identity = JSON.stringify(query.groupBy.map((field) => key[field]));
    const group = groups.get(identity) ?? {
      key,
      rows: 0,
      runs: new Set<string>(),
    };
    group.rows += 1;
    group.runs.add(row.runId);
    groups.set(identity, group);
  }
  const total = population.length;
  const projected = [...groups.entries()]
    .map(([identity, group]) => ({
      identity,
      group: {
        key: group.key as RunIndexQueryGroup["key"],
        rows: group.rows,
        runs: group.runs.size,
        share: total === 0 ? 0 : group.rows / total,
      },
    }))
    .sort(
      (left, right) =>
        right.group.rows - left.group.rows || left.identity.localeCompare(right.identity),
    )
    .map((entry) => entry.group);
  return {
    indexedRows: current.length,
    supersededRows: complete.rows.length - current.length,
    incompleteSnapshots: complete.incompleteSnapshots,
    appliedWhere,
    rowKindDefaulted,
    population: {
      rows: total,
      runs: new Set(population.map((row) => row.runId)).size,
      rowsWithOmittedFields: population.filter((row) => row.omittedFields.length > 0).length,
    },
    groups: projected,
    runEndRunIds,
  };
}

/** How each of `runIds` ended, grouped by {@link RUN_INDEX_RUN_END_FIELDS}. */
export function queryRunEnds(
  rows: readonly RunIndexRowV1[],
  runIds: ReadonlySet<string>,
): RunIndexQueryResult {
  return queryRunIndex(rows, {
    where: new Map([["rowKind", ["run"]]]),
    groupBy: RUN_INDEX_RUN_END_FIELDS,
    runIds,
  });
}

/** Rows of snapshots whose every row is present, and a count of the rest. */
export function completeSnapshots(rows: readonly RunIndexRowV1[]): {
  readonly rows: RunIndexRowV1[];
  readonly incompleteSnapshots: number;
} {
  const present = new Map<string, number>();
  for (const row of rows) present.set(row.snapshotId, (present.get(row.snapshotId) ?? 0) + 1);
  const incomplete = new Set<string>();
  for (const row of rows) {
    if (present.get(row.snapshotId) !== row.snapshotRows) incomplete.add(row.snapshotId);
  }
  return {
    rows: rows.filter((row) => !incomplete.has(row.snapshotId)),
    incompleteSnapshots: incomplete.size,
  };
}

/** The rows of each run's last appended snapshot, in file order. */
export function newestSnapshots(rows: readonly RunIndexRowV1[]): RunIndexRowV1[] {
  const newest = new Map<string, string>();
  for (const row of rows) newest.set(row.runId, row.snapshotId);
  return rows.filter((row) => newest.get(row.runId) === row.snapshotId);
}

function matches(row: RunIndexRowV1, query: RunIndexQuery): boolean {
  if (query.runIds !== undefined && !query.runIds.has(row.runId)) return false;
  if (query.sinceMs !== undefined || query.untilMs !== undefined) {
    const created = Date.parse(row.runCreatedAt);
    if (Number.isNaN(created)) return false;
    if (query.sinceMs !== undefined && created < query.sinceMs) return false;
    if (query.untilMs !== undefined && created >= query.untilMs) return false;
  }
  for (const [field, accepted] of query.where) {
    if (!accepted.includes(renderRunIndexValue(row[field]))) return false;
  }
  return true;
}

export function renderRunIndexValue(value: string | number | boolean | null | undefined): string {
  return value === null || value === undefined ? RUN_INDEX_UNAVAILABLE : String(value);
}
