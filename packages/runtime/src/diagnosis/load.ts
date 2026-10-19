// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Builds the `docsfab why` answer: reads the run index, adds saved records
 * the index does not hold yet by projecting them in memory with the same
 * projection `docsfab runs import` writes, selects runs, and diagnoses them.
 * A selected run that an earlier projection indexed is read again from its
 * saved record the same way, so fields added since are not read as absent.
 *
 * Read-only: nothing here writes the index, a record, or any other file.
 */
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { formatLimitObservation, limit, type ResolvedLimit } from "../config/limits.js";
import { parseJsonEvidence } from "../json-evidence.js";
import { runLimitOverflowSidecarPath } from "../operator/run-limit-overflow.js";
import { SAFE_RECORD_ID } from "../records/file-store.js";
import {
  isRunIndexTerminalStatus,
  projectRunIndexRows,
  RUN_INDEX_LIMITS,
  RUN_INDEX_PROJECTION_REVISION,
  carriedDocsfabRevision,
  sha256Hex,
  type RunIndexRowV1,
} from "../records/run-index.js";
import { readRunIndex, RunIndexStoreError } from "../records/run-index-store.js";
import { completeSnapshots, newestSnapshots } from "../records/run-index-query.js";
import {
  DIAGNOSIS_LIMITS,
  WHY_REPORT_KIND,
  WHY_REPORT_SCHEMA_VERSION,
  type RunDiagnosisV1,
  type WhyReportV1,
} from "./contracts.js";
import {
  currentRunRows,
  diagnoseRun,
  newestRunIds,
  runsImportCommand,
  summarizeByModel,
  type DiagnosisLocation,
} from "./engine.js";

const WHY_HELP_COMMAND = "docsfab why --help";
const RECORD_SUFFIX = ".json";
const LIMIT_OVERFLOW_SIDECAR_SUFFIX = runLimitOverflowSidecarPath(`x${RECORD_SUFFIX}`).slice(1);

/** A refusal with a stable code and the command that clears it. */
export class WhyOperatorError extends Error {
  public readonly code: string;
  public readonly nextAction: string;
  public constructor(code: string, message: string, nextAction: string) {
    super(message);
    this.code = code;
    this.nextAction = nextAction;
    this.name = "WhyOperatorError";
  }
}

export interface WhyRequest {
  readonly selection: WhyReportV1["selection"];
  readonly indexDirectory: string;
  /** Where saved records live; `null` when only an index directory was named. */
  readonly stateDirectory: string | null;
  /** The operator named the state directory, so a missing one is refused rather than empty. */
  readonly stateDirectoryExplicit: boolean;
  readonly location: DiagnosisLocation;
}

export async function buildWhyReport(request: WhyRequest): Promise<WhyReportV1> {
  if (request.stateDirectory !== null && request.stateDirectoryExplicit) {
    await refuseMissingStateDirectory(request.stateDirectory);
  }
  const maxBytes = limit(RUN_INDEX_LIMITS.indexMaxBytes);
  const read = await readIndexOrRefuse(request.indexDirectory, maxBytes);
  const indexed = currentRunRows(read.rows);
  const limitations: string[] = [];
  const projected = request.stateDirectory
    ? await projectUnindexedRecords(request.stateDirectory, indexed, request.selection, limitations)
    : new Map<string, RunIndexRowV1[]>();
  const rows = [...read.rows, ...[...projected.values()].flat()];
  const byRun = currentRunRows(rows);
  const selected = selectRuns(byRun, request, read.exists);
  const maxRuns = limit(DIAGNOSIS_LIMITS.maxRuns);
  const diagnosed = selected.slice(0, maxRuns.value);
  // Only the diagnosed runs are read again, so `diagnosis.maxRuns` bounds it.
  const reprojected = new Set<string>();
  let earlierUnread = 0;
  for (const runId of diagnosed) {
    const runRows = byRun.get(runId) ?? [];
    if (projected.has(runId) || !runRows.some(isEarlierProjection)) continue;
    // Import's labels carry forward: the batch and case, and the build
    // revision when the record bytes are the ones the earlier rows indexed.
    const read =
      request.stateDirectory !== null && SAFE_RECORD_ID.test(runId)
        ? await projectRecordFile(
            join(request.stateDirectory, `${runId}${RECORD_SUFFIX}`),
            runRows[0],
          )
        : "absent";
    if (typeof read === "string" || read.runId !== runId) {
      earlierUnread += 1;
      continue;
    }
    rows.push(...read.rows);
    byRun.set(runId, [...read.rows]);
    reprojected.add(runId);
  }
  const lookbackRuns = limit(DIAGNOSIS_LIMITS.recurrenceLookbackRuns).value;
  const diagnoses: RunDiagnosisV1[] = [];
  for (const runId of diagnosed) {
    diagnoses.push(
      diagnoseRun(byRun.get(runId) ?? [], {
        location: request.location,
        source: projected.has(runId) || reprojected.has(runId) ? "record" : "run-index",
        population: rows,
        lookbackRuns,
      }),
    );
  }
  const fromRecords = diagnosed.filter((runId) => projected.has(runId)).length;
  if (fromRecords > 0) limitations.unshift(`runs-not-indexed:${String(fromRecords)}`);
  if (reprojected.size > 0) limitations.push(`runs-reprojected:${String(reprojected.size)}`);
  if (earlierUnread > 0) limitations.push(`runs-index-earlier:${String(earlierUnread)}`);
  const complete = completeSnapshots(read.rows);
  return {
    schemaVersion: WHY_REPORT_SCHEMA_VERSION,
    kind: WHY_REPORT_KIND,
    index: {
      path: read.path,
      exists: read.exists,
      storedRows: read.rows.length,
      supersededRows: complete.rows.length - newestSnapshots(complete.rows).length,
      unreadableLines: read.unreadableLines,
      incompleteSnapshots: complete.incompleteSnapshots,
      refusedSnapshots: read.overflow?.refusedSnapshots ?? 0,
      stateDirectory: request.stateDirectory,
    },
    selection: request.selection,
    runs: {
      matched: selected.length,
      diagnosed: diagnoses.length,
      clipped: diagnoses.length < selected.length,
      limit: { name: maxRuns.name, value: maxRuns.value },
    },
    diagnoses,
    byModel: summarizeByModel(diagnoses, byRun),
    limitations,
  };
}

async function refuseMissingStateDirectory(stateDirectory: string): Promise<void> {
  const entry = await stat(stateDirectory).catch((error: unknown) => error);
  if (entry instanceof Error || !(entry as { isDirectory(): boolean }).isDirectory()) {
    const missing = (entry as { code?: unknown }).code === "ENOENT";
    throw new WhyOperatorError(
      missing ? "why-state-dir-missing" : "why-state-dir-unreadable",
      missing
        ? `The state directory ${stateDirectory} does not exist.`
        : `The state directory ${stateDirectory} is not a directory that docsfab why can read.`,
      "docsfab runs list --state-dir <state-directory>",
    );
  }
}

async function readIndexOrRefuse(indexDirectory: string, maxBytes: ResolvedLimit) {
  try {
    return await readRunIndex({
      indexDirectory,
      maxBytes,
      onOversize: (observed) => {
        throw new WhyOperatorError(
          maxBytes.refusal,
          formatLimitObservation(maxBytes, observed),
          "docsfab runs import --help",
        );
      },
    });
  } catch (error) {
    if (error instanceof RunIndexStoreError) {
      throw new WhyOperatorError(
        error.code,
        `The run index in ${indexDirectory} is not an owner-private regular file set that DocsFab can read safely.`,
        "docsfab runs import --help",
      );
    }
    throw error;
  }
}

/** Newest first, filtered by the selection; refuses an empty or ambiguous selection. */
function selectRuns(
  byRun: ReadonlyMap<string, readonly RunIndexRowV1[]>,
  request: WhyRequest,
  indexExists: boolean,
): string[] {
  const { selection } = request;
  let candidates = newestRunIds(byRun);
  if (selection.model !== null) {
    candidates = candidates.filter((runId) =>
      (byRun.get(runId) ?? []).some((row) => row.model === selection.model),
    );
  }
  if (selection.batchId !== null) {
    candidates = candidates.filter((runId) => byRun.get(runId)?.[0]?.batchId === selection.batchId);
  }
  if (selection.mode === "run" && selection.runId !== null) {
    const wanted = selection.runId;
    if (candidates.includes(wanted)) return [wanted];
    const matches = candidates.filter((runId) => runId.startsWith(wanted));
    if (matches.length === 1) return matches;
    if (matches.length > 1) {
      throw new WhyOperatorError(
        "why-run-ambiguous",
        `The run ID prefix ${wanted} matches ${String(matches.length)} indexed runs, so docsfab why cannot choose one.`,
        `docsfab runs list${request.location.showArgs}`,
      );
    }
    throw new WhyOperatorError(
      "why-run-not-found",
      `No run ${wanted} is in the run index or the state directory that docsfab why read.`,
      request.stateDirectory
        ? `docsfab runs list --state-dir ${request.stateDirectory}`
        : "docsfab why --help",
    );
  }
  if (candidates.length === 0) {
    throw new WhyOperatorError(
      "why-no-runs",
      indexExists || request.stateDirectory
        ? "No saved run matches this docsfab why selection in the run index or state directory."
        : "No run index exists here yet, and no state directory was named for docsfab why to read.",
      request.stateDirectory
        ? `docsfab runs list --state-dir ${request.stateDirectory}`
        : WHY_HELP_COMMAND,
    );
  }
  const [newest] = candidates;
  return selection.mode === "last" && newest !== undefined ? [newest] : candidates;
}

/**
 * Terminal saved records the index lacks, projected in memory. A named run
 * reads only its own record. Refused and unreadable records are counted in
 * `limitations`, never skipped silently.
 */
async function projectUnindexedRecords(
  stateDirectory: string,
  indexed: ReadonlyMap<string, readonly RunIndexRowV1[]>,
  selection: WhyReportV1["selection"],
  limitations: string[],
): Promise<Map<string, RunIndexRowV1[]>> {
  const projected = new Map<string, RunIndexRowV1[]>();
  let names: string[];
  if (selection.mode === "run" && selection.runId !== null) {
    names =
      indexed.has(selection.runId) || !SAFE_RECORD_ID.test(selection.runId)
        ? []
        : [`${selection.runId}${RECORD_SUFFIX}`];
  } else {
    try {
      names = (await readdir(stateDirectory))
        .filter(
          (name) =>
            name.endsWith(RECORD_SUFFIX) &&
            !name.endsWith(LIMIT_OVERFLOW_SIDECAR_SUFFIX) &&
            !indexed.has(name.slice(0, -RECORD_SUFFIX.length)),
        )
        .sort();
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ENOENT") {
        throw new WhyOperatorError(
          "why-state-dir-unreadable",
          `The state directory ${stateDirectory} could not be listed for docsfab why by this user.`,
          "docsfab runs list --state-dir <state-directory>",
        );
      }
      names = [];
    }
  }
  if (names.length === 0) return projected;
  const importMax = limit(RUN_INDEX_LIMITS.importMaxRecords);
  if (names.length > importMax.value) {
    throw new WhyOperatorError(
      importMax.refusal,
      formatLimitObservation(importMax, names.length),
      runsImportCommand(stateDirectory),
    );
  }
  const recordMax = limit(RUN_INDEX_LIMITS.recordMaxBytes);
  let unreadable = 0;
  let oversize = 0;
  for (const name of names) {
    const read = await projectRecordFile(join(stateDirectory, name));
    if (read === "absent" || read === "not-terminal") continue;
    if (read === "oversize") {
      oversize += 1;
      continue;
    }
    if (read === "unreadable") {
      unreadable += 1;
      continue;
    }
    projected.set(read.runId, [...read.rows]);
  }
  if (oversize > 0) limitations.push(`${recordMax.refusal}:${String(oversize)}`);
  if (unreadable > 0) limitations.push(`records-unreadable:${String(unreadable)}`);
  return projected;
}

/** Rows an earlier projection wrote lack fields this one adds. */
function isEarlierProjection(row: RunIndexRowV1): boolean {
  return row.projectionRevision < RUN_INDEX_PROJECTION_REVISION;
}

/**
 * One saved record projected in memory exactly as `docsfab runs import`
 * projects it. A record that is not terminal is not a run end yet.
 */
async function projectRecordFile(
  path: string,
  previous?: RunIndexRowV1,
): Promise<
  | { readonly runId: string; readonly rows: readonly RunIndexRowV1[] }
  | "absent"
  | "oversize"
  | "unreadable"
  | "not-terminal"
> {
  const read = await readRecordFile(path, limit(RUN_INDEX_LIMITS.recordMaxBytes).value);
  if (typeof read === "string") return read;
  const recordSha256 = sha256Hex(read.bytes);
  const projection = projectRunIndexRows(read.value, {
    origin: "import",
    snapshotId: `record-${randomUUID()}`,
    indexedAt: new Date().toISOString(),
    recordSha256,
    fieldMaxChars: limit(RUN_INDEX_LIMITS.fieldMaxChars).value,
    batchId: previous?.batchId ?? null,
    caseKey: previous?.caseKey ?? null,
    docsfabRevision: carriedDocsfabRevision(null, previous, recordSha256),
  });
  if (!projection.ok) return "unreadable";
  if (!isRunIndexTerminalStatus(projection.rows[0]?.runStatus)) return "not-terminal";
  return { runId: projection.runId, rows: projection.rows };
}

type RecordRead =
  | { readonly bytes: Buffer; readonly value: unknown }
  | "absent"
  | "oversize"
  | "unreadable";

async function readRecordFile(path: string, maxBytes: number): Promise<RecordRead> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat: Stats = await handle.stat();
    if (!stat.isFile()) return "unreadable";
    if (stat.size > maxBytes) return "oversize";
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) return "oversize";
    return { bytes, value: parseJsonEvidence(bytes) };
  } catch (error) {
    return (error as { code?: unknown }).code === "ENOENT" ? "absent" : "unreadable";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
