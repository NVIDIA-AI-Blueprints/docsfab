// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Known failures of the outcome pairing tests: a producer value a consumer
 * does not yet handle, owned by an open issue. A pair with no row must pass
 * the invariant. A pair with a row passes only while it still fails the
 * invariant with exactly the row's `observed` output. A fix lane flips a row
 * by deleting it.
 */
import { isDeepStrictEqual } from "node:util";

export const PAIRING_FAMILIES = Object.freeze([
  "run-status",
  "product-disposition",
  "readiness-disposition",
  "editorial-outcome",
  "failure-class",
] as const);

export type PairingFamily = (typeof PAIRING_FAMILIES)[number];

export interface KnownFailureRow {
  readonly family: PairingFamily;
  readonly producerValue: string;
  readonly consumer: string;
  /** The open issue that owns the gap, as `#N`; never the pairing Task itself. */
  readonly owner: string;
  /** The consumer's parsed output for this pair while the gap stands. */
  readonly observed: unknown;
}

/** The Task that owns these tests; a gap it finds belongs to another issue. */
export const PAIRING_TASK = "#2075";

const ISSUE_REFERENCE = /^#[1-9][0-9]*$/u;

export const KNOWN_FAILURES: readonly KnownFailureRow[] = Object.freeze([
  // The VERDICT execution plane collapses a human-decision stop into needs-input.
  {
    family: "run-status",
    producerValue: "needs-human-decision",
    consumer: "runs-show-text",
    owner: "#2081",
    observed: { execution: "needs-input", why: false },
  },
  // The VERDICT execution plane shows a queued run as running.
  {
    family: "run-status",
    producerValue: "queued",
    consumer: "runs-show-text",
    owner: "#2081",
    observed: { execution: "running", why: false },
  },
  // `why` refuses a saved unfinished run as if no such run existed.
  {
    family: "run-status",
    producerValue: "queued",
    consumer: "why",
    owner: "#2025",
    observed: { refused: "why-run-not-found" },
  },
  {
    family: "run-status",
    producerValue: "running",
    consumer: "why",
    owner: "#2025",
    observed: { refused: "why-run-not-found" },
  },
]);

/** The known-failure owner a pair's test title carries, as ` (#N)`, or "". */
export function ownerSuffix(
  rows: readonly KnownFailureRow[],
  pair: Pick<KnownFailureRow, "family" | "producerValue" | "consumer">,
): string {
  const key = knownFailureKey(pair);
  const row = rows.find((candidate) => knownFailureKey(candidate) === key);
  return row ? ` (${row.owner})` : "";
}

export function knownFailureKey(
  row: Pick<KnownFailureRow, "family" | "producerValue" | "consumer">,
): string {
  return `${row.family}/${row.producerValue}/${row.consumer}`;
}

export interface PairResult {
  readonly family: PairingFamily;
  readonly producerValue: string;
  readonly consumer: string;
  readonly observed: unknown;
  readonly expected: unknown;
}

/**
 * Throw unless the pair meets the invariant with no row, or fails it with
 * exactly the observed output its row records.
 */
export function resolvePair(rows: readonly KnownFailureRow[], pair: PairResult): void {
  const key = knownFailureKey(pair);
  const row = rows.find((candidate) => knownFailureKey(candidate) === key);
  const holds = isDeepStrictEqual(pair.observed, pair.expected);
  if (!row) {
    if (holds) return;
    throw new Error(
      `pair ${key} breaks the invariant: observed ${show(pair.observed)}, expected ${show(pair.expected)}`,
    );
  }
  if (holds) {
    throw new Error(`stale known-failure row ${key} (owner ${row.owner}): delete it`);
  }
  if (!isDeepStrictEqual(pair.observed, row.observed)) {
    throw new Error(
      `known-failure row ${key} (owner ${row.owner}) observed mismatch: observed ${show(pair.observed)}, row records ${show(row.observed)}`,
    );
  }
}

/**
 * Table problems: a duplicate key, an owner that is not `#N` or is the
 * pairing Task, or a row whose value or consumer the registries no longer
 * produce or read.
 */
export function knownFailureTableProblems(
  rows: readonly KnownFailureRow[],
  produced: Readonly<Record<PairingFamily, readonly string[]>>,
  reads: (consumer: string, family: PairingFamily) => boolean,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = knownFailureKey(row);
    if (seen.has(key)) problems.push(`duplicate known-failure row ${key}`);
    seen.add(key);
    if (!ISSUE_REFERENCE.test(row.owner) || row.owner === PAIRING_TASK) {
      problems.push(`known-failure row ${key} needs an owning issue other than ${PAIRING_TASK}`);
    }
    if (
      !Object.hasOwn(produced, row.family) ||
      !produced[row.family].includes(row.producerValue) ||
      !reads(row.consumer, row.family)
    ) {
      problems.push(`orphaned known-failure row ${key} (owner ${row.owner})`);
    }
  }
  return problems;
}

function show(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value);
}
