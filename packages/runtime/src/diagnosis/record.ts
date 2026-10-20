// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The DIAGNOSIS block of a run that just ended or is replayed: the run's own
 * record projected into index rows in memory, so the block never depends on
 * whether the index write succeeded, and recurrence read from the index when
 * it can be read.
 */
import { dirname } from "node:path";

import { limit } from "../config/limits.js";
import type { RunRecord } from "../records/contracts.js";
import {
  projectRunIndexRows,
  RUN_INDEX_LIMITS,
  sha256Hex,
  type RunIndexRowV1,
} from "../records/run-index.js";
import { defaultRunIndexDirectory, readRunIndex } from "../records/run-index-store.js";
import { DIAGNOSIS_LIMITS, type RunDiagnosisV1 } from "./contracts.js";
import { diagnoseRun, shellArgument, type DiagnosisLocation } from "./engine.js";

/** Index location arguments for a record saved at `recordPath`. */
export function recordDiagnosisLocation(recordPath: string): DiagnosisLocation {
  const stateDirArg = ` --state-dir ${shellArgument(dirname(recordPath))}`;
  return { indexArgs: stateDirArg, showArgs: stateDirArg };
}

/**
 * Diagnose one record. `population` is every index row available for
 * recurrence; `null` reports recurrence as unread. Returns `undefined` for a
 * record the index projection refuses, such as a legacy schema.
 */
export function diagnoseRunRecord(
  record: RunRecord,
  recordPath: string,
  population: readonly RunIndexRowV1[] | null = null,
): RunDiagnosisV1 | undefined {
  const projection = projectRunIndexRows(record, {
    origin: "run-store",
    snapshotId: `record-${record.id}`,
    indexedAt: record.completedAt ?? record.createdAt,
    recordSha256: sha256Hex(JSON.stringify(record)),
    fieldMaxChars: limit(RUN_INDEX_LIMITS.fieldMaxChars).value,
  });
  if (!projection.ok) return undefined;
  const rows = [...projection.rows];
  return diagnoseRun(rows, {
    location: recordDiagnosisLocation(recordPath),
    source: "record",
    population:
      population === null
        ? null
        : [...population.filter((row) => row.runId !== projection.runId), ...rows],
    lookbackRuns: limit(DIAGNOSIS_LIMITS.recurrenceLookbackRuns).value,
  });
}

/**
 * The same diagnosis with recurrence from the index beside the record's state
 * directory. Never throws: an unreadable index leaves recurrence unread, and a
 * diagnosis that fails returns `undefined` so the summary names that failure.
 */
export async function readIndexedRunDiagnosis(
  record: RunRecord,
  recordPath: string,
): Promise<RunDiagnosisV1 | undefined> {
  let population: readonly RunIndexRowV1[] | null = null;
  try {
    const maxBytes = limit(RUN_INDEX_LIMITS.indexMaxBytes);
    const read = await readRunIndex({
      indexDirectory: defaultRunIndexDirectory(dirname(recordPath)),
      maxBytes,
      onOversize: () => {
        throw new RangeError("run index over runs.indexMaxBytes"); // hygiene: ok -- caught below; recurrence is reported as unread.
      },
    });
    population = read.rows;
  } catch {
    population = null;
  }
  try {
    return diagnoseRunRecord(record, recordPath, population);
  } catch {
    return undefined;
  }
}
