// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `docsfab runs query` answers counting questions over the append-only run
 * index. `docsfab runs import` adds saved run records, or a local-workflows
 * harness batch labelled by batch and case, to an index.
 *
 * Both are read-only with respect to run records, workflows, Git, GitLab, and
 * model providers. `import` writes only index rows.
 */
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { resolveDocsFabStateDirectory } from "../../config/host-paths.js";
import { formatLimitObservation, limit, type ResolvedLimit } from "../../config/limits.js";
import { parseJsonEvidence } from "../../json-evidence.js";
import { FAILURE_CLASSES, FAILURE_LAYERS } from "../../operator/failure-class.js";
import { runLimitOverflowSidecarPath } from "../../operator/run-limit-overflow.js";
import { SAFE_RECORD_ID } from "../../records/file-store.js";
import {
  isRunIndexQueryField,
  isRunIndexTerminalStatus,
  projectRunIndexRows,
  RUN_INDEX_LIMITS,
  RUN_INDEX_PROJECTION_REVISION,
  RUN_INDEX_QUERY_FIELDS,
  RUN_INDEX_RETRY_DECISION_RULES,
  RUN_INDEX_RUN_END_REVISION,
  carriedDocsfabRevision,
  sha256Hex,
  type RunIndexQueryField,
  type RunIndexRowV1,
} from "../../records/run-index.js";
import {
  completeSnapshots,
  newestSnapshots,
  queryRunEnds,
  queryRunIndex,
  renderRunIndexValue,
  RUN_INDEX_RUN_END_FIELDS,
  RUN_INDEX_UNAVAILABLE,
  type RunIndexQueryResult,
} from "../../records/run-index-query.js";
import { attemptClassifierSha256 } from "../../records/run-index-classifier.js";
import { runIndexRebuildRemediation } from "../../records/run-index-signals.js";
import {
  isRunTombstoned,
  withActiveRunGate,
  withRunMaintenanceGate,
} from "../../records/run-maintenance-gate.js";
import {
  appendRunIndexSnapshot,
  defaultRunIndexDirectory,
  readRunIndex,
  RunIndexStoreError,
  type RunIndexOverflowV1,
} from "../../records/run-index-store.js";

const QUERY_HELP_COMMAND = "docsfab runs query --help";
const IMPORT_HELP_COMMAND = "docsfab runs import --help";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u;
const REVISION = /^[0-9a-f]{7,64}$/u;
const HARNESS_BATCH_ID = /^[0-9a-f]{64}$/u;
const HARNESS_REPORT_FILE = "report.json";
const HARNESS_REPORT_KIND = "docsfab-local-e2e-report";
const RECORD_SUFFIX = ".json";
/** `<runId>.limit-overflow.json`, the one companion file a state directory holds. */
const LIMIT_OVERFLOW_SIDECAR_SUFFIX = runLimitOverflowSidecarPath(`x${RECORD_SUFFIX}`).slice(1);

export class RunsOperatorError extends Error {
  public readonly code: string;
  public readonly nextAction: string;
  public constructor(code: string, message: string, nextAction: string) {
    super(message);
    this.code = code;
    this.nextAction = nextAction;
    this.name = "RunsOperatorError";
  }
}

export interface RunsQueryArguments {
  readonly command: "query";
  readonly help: boolean;
  readonly json: boolean;
  readonly indexDirectory: string;
  /** State directory named in the rebuild remediation. */
  readonly rebuildStateDirectory: string;
  readonly where: ReadonlyMap<RunIndexQueryField, readonly string[]>;
  readonly since?: string;
  readonly until?: string;
  readonly groupBy: readonly RunIndexQueryField[];
}

export interface RunsImportArguments {
  readonly command: "import";
  readonly help: boolean;
  readonly json: boolean;
  readonly indexDirectory: string;
  readonly paths: readonly string[];
  readonly docsfabRevision: string | null;
}

export function runsQueryUsage(): string {
  return [
    "Usage: docsfab runs query [--where <field>=<value>]... [--since <date>] [--until <date>]",
    "         [--group-by <field>[,<field>]...] [--index-dir <path> | --state-dir <path>] [--json]",
    "",
    "Counts run index rows. Each row has a rowKind: attempt (one per recorded inference attempt),",
    "step (one per started step that recorded no attempt, whose artifact the quality validator",
    "refused, or that ended after its final attempt succeeded), or run (one per run). Without a",
    "--where rowKind=... clause the query counts attempt rows only, so the denominator is",
    "recorded attempts; use --where rowKind=run for per-run rates, for example by runStatus.",
    "runStatus is workflow execution only; it does not report whether live-agent checkout",
    "application succeeded. Inspect docsfab runs show <runId> --state-dir <path> for the",
    "saved checkout persistence outcome and overall status.",
    "Repeated --where values for one field are alternatives; different fields must all match.",
    "The value unavailable matches a field the record did not carry. --since is inclusive and",
    "--until is exclusive; both compare the run's creation time (YYYY-MM-DD is UTC midnight).",
    "Each group reports its rows, distinct runs, and share of the filtered rows (the denominator).",
    "Answer-record progress fields come from the committed ledger checkpoint on its physical attempt row;",
    "they describe required ledger keys and logical-lineage counts, not report validation.",
    "RUN ENDS then groups how each run ended, from its run row: the failing step and failure",
    "code. It covers the runs in the filtered rows or, with the default row kind, every run",
    "with a row of any kind that matches the other clauses.",
    "",
    `Fields: ${RUN_INDEX_QUERY_FIELDS.join(", ")}`,
  ].join("\n");
}

export function runsImportUsage(): string {
  return [
    "Usage: docsfab runs import <path>... [--docsfab-revision <sha>] [--index-dir <path> | --state-dir <path>] [--json]",
    "",
    "Each path is a local-workflows harness batch directory (with report.json), a run state",
    "directory, or one saved run record file. Harness rows carry the batch ID and case key.",
    "A record already indexed with identical bytes and labels is left unchanged, unless an",
    "earlier DocsFab, or one that classifies attempts differently, indexed it: then it is indexed",
    "again, with the fields and attempt classes of this version. A record",
    "that has not finished (queued or running) is listed as not terminal and is not indexed.",
  ].join("\n");
}

export function parseRunsQueryArguments(args: readonly string[]): RunsQueryArguments {
  const options = scanOptions(args, "query", {
    flags: ["--json", "--help", "-h"],
    single: ["--index-dir", "--state-dir", "--since", "--until"],
    repeated: ["--where", "--group-by"],
  });
  if (options.positionals.length > 0) {
    throw usageError("query", "The docsfab runs query command accepts no positional arguments.");
  }
  const where = new Map<RunIndexQueryField, string[]>();
  for (const clause of options.repeated.get("--where") ?? []) {
    const separator = clause.indexOf("=");
    const field = separator > 0 ? clause.slice(0, separator) : "";
    const value = separator > 0 ? clause.slice(separator + 1) : "";
    if (!isRunIndexQueryField(field) || value.length === 0) {
      throw usageError(
        "query",
        `The --where clause must be <field>=<value> with a supported index field, not "${clause}".`,
      );
    }
    refuseOutsideClosedValues(field, value);
    where.set(field, [...(where.get(field) ?? []), value]);
  }
  const groupBy: RunIndexQueryField[] = [];
  for (const list of options.repeated.get("--group-by") ?? []) {
    for (const field of list.split(",")) {
      if (!isRunIndexQueryField(field)) {
        throw usageError(
          "query",
          `The --group-by option names an unsupported run index field "${field}".`,
        );
      }
      if (groupBy.includes(field)) {
        throw usageError("query", `The --group-by option names the field "${field}" twice.`);
      }
      groupBy.push(field);
    }
  }
  const since = options.single.get("--since");
  const until = options.single.get("--until");
  for (const [flag, value] of [
    ["--since", since],
    ["--until", until],
  ] as const) {
    if (value !== undefined && parseQueryTime(value) === undefined) {
      throw usageError(
        "query",
        `The ${flag} option requires a YYYY-MM-DD date or an ISO 8601 timestamp with a zone.`,
      );
    }
  }
  return {
    command: "query",
    help: options.flags.has("--help") || options.flags.has("-h"),
    json: options.flags.has("--json"),
    indexDirectory: indexDirectoryFrom(options.single),
    rebuildStateDirectory: rebuildStateDirectoryFrom(options.single),
    where,
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    groupBy,
  };
}

/**
 * `failureClass` and `failureLayer` hold closed vocabularies, so a value
 * outside them can never match. Refuse it rather than report an empty
 * population; an attempt's failure category is queried as `outcome`.
 */
function refuseOutsideClosedValues(field: RunIndexQueryField, value: string): void {
  const closed =
    field === "failureClass"
      ? FAILURE_CLASSES
      : field === "failureLayer"
        ? FAILURE_LAYERS
        : field === "retryDecisionRule"
          ? RUN_INDEX_RETRY_DECISION_RULES
          : field === "answerRecordComplete"
            ? ["true", "false"]
            : null;
  if (closed === null || value === RUN_INDEX_UNAVAILABLE) return;
  if ((closed as readonly string[]).includes(value)) return;
  throw usageError(
    "query",
    `The ${field} value "${value}" is not one of ${closed.join(", ")}, or ${RUN_INDEX_UNAVAILABLE}.${
      field === "failureClass"
        ? ` An attempt's failure category, such as malformed-response, is its outcome: use --where outcome=${value}.`
        : ""
    }`,
  );
}

export function parseRunsImportArguments(args: readonly string[]): RunsImportArguments {
  const options = scanOptions(args, "import", {
    flags: ["--json", "--help", "-h"],
    single: ["--index-dir", "--state-dir", "--docsfab-revision"],
    repeated: [],
  });
  const help = options.flags.has("--help") || options.flags.has("-h");
  if (!help && options.positionals.length === 0) {
    throw usageError(
      "import",
      "The docsfab runs import command requires at least one harness batch, state directory, or record path.",
    );
  }
  const revision = options.single.get("--docsfab-revision");
  if (revision !== undefined && !REVISION.test(revision)) {
    throw usageError(
      "import",
      "The --docsfab-revision option requires a lowercase hexadecimal Git revision of 7 to 64 characters.",
    );
  }
  return {
    command: "import",
    help,
    json: options.flags.has("--json"),
    indexDirectory: indexDirectoryFrom(options.single),
    paths: options.positionals.map((path) => resolve(path)),
    docsfabRevision: revision ?? null,
  };
}

interface ScannedOptions {
  readonly flags: Set<string>;
  readonly single: Map<string, string>;
  readonly repeated: Map<string, string[]>;
  readonly positionals: string[];
}

function scanOptions(
  args: readonly string[],
  command: "query" | "import",
  shape: {
    readonly flags: readonly string[];
    readonly single: readonly string[];
    readonly repeated: readonly string[];
  },
): ScannedOptions {
  const scanned: ScannedOptions = {
    flags: new Set(),
    single: new Map(),
    repeated: new Map(),
    positionals: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (shape.flags.includes(argument)) {
      if (scanned.flags.has(argument)) {
        throw usageError(
          command,
          `The ${argument} option must not be duplicated on docsfab runs ${command}.`,
        );
      }
      scanned.flags.add(argument);
      continue;
    }
    if (shape.single.includes(argument) || shape.repeated.includes(argument)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw usageError(
          command,
          `The ${argument} option on docsfab runs ${command} requires a value.`,
        );
      }
      index += 1;
      if (shape.repeated.includes(argument)) {
        scanned.repeated.set(argument, [...(scanned.repeated.get(argument) ?? []), value]);
        continue;
      }
      if (scanned.single.has(argument)) {
        throw usageError(
          command,
          `The ${argument} option must not be duplicated on docsfab runs ${command}.`,
        );
      }
      scanned.single.set(argument, value);
      continue;
    }
    if (argument.startsWith("-")) {
      throw usageError(
        command,
        `Unknown docsfab runs ${command} option "${argument}" is not supported.`,
      );
    }
    scanned.positionals.push(argument);
  }
  if (scanned.single.has("--index-dir") && scanned.single.has("--state-dir")) {
    throw usageError(
      command,
      `The --index-dir and --state-dir options cannot be combined on docsfab runs ${command}.`,
    );
  }
  return scanned;
}

function indexDirectoryFrom(single: ReadonlyMap<string, string>): string {
  const explicit = single.get("--index-dir");
  if (explicit !== undefined) return resolve(explicit);
  return defaultRunIndexDirectory(single.get("--state-dir") ?? resolveDocsFabStateDirectory());
}

/** The state directory an index rebuild reads; unknown when only --index-dir was given. */
function rebuildStateDirectoryFrom(single: ReadonlyMap<string, string>): string {
  if (single.has("--index-dir")) return "<state-directory>";
  return resolve(single.get("--state-dir") ?? resolveDocsFabStateDirectory());
}

function usageError(command: "query" | "import", message: string): RunsOperatorError {
  return new RunsOperatorError(
    `runs-${command}-invalid-arguments`,
    message,
    command === "query" ? QUERY_HELP_COMMAND : IMPORT_HELP_COMMAND,
  );
}

function parseQueryTime(value: string): number | undefined {
  if (!DATE_ONLY.test(value) && !ISO_TIMESTAMP.test(value)) return undefined;
  const parsed = Date.parse(DATE_ONLY.test(value) ? `${value}T00:00:00.000Z` : value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function limitError(resolved: ResolvedLimit, observed: number, nextAction: string): never {
  throw new RunsOperatorError(
    resolved.refusal,
    formatLimitObservation(resolved, observed),
    nextAction,
  );
}

function storeError(error: unknown, indexDirectory: string): never {
  if (error instanceof RunIndexStoreError) {
    throw new RunsOperatorError(
      error.code,
      `The run index in ${indexDirectory} is not an owner-private regular file set that DocsFab can read or write safely.`,
      IMPORT_HELP_COMMAND,
    );
  }
  throw error;
}

// --- query -----------------------------------------------------------------

export interface RunIndexQueryEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-run-index-query";
  readonly index: {
    readonly path: string;
    readonly exists: boolean;
    readonly storedRows: number;
    readonly supersededRows: number;
    readonly unreadableLines: number;
    /** Snapshots whose rows were not all present, such as an interrupted append. */
    readonly incompleteSnapshots: number;
    /**
     * Attempt rows in the index's current snapshots, whatever the filters,
     * that another attempt classifier read, so their classifier fields read
     * unavailable until the record is imported again.
     */
    readonly staleClassifierRows: number;
  };
  readonly filters: {
    /** The filter applied, including `rowKind` when it was defaulted. */
    readonly where: Readonly<Record<string, readonly string[]>>;
    readonly rowKindDefaulted: boolean;
    readonly since: string | null;
    readonly until: string | null;
  };
  readonly groupBy: readonly string[];
  readonly population: RunIndexQueryResult["population"];
  readonly groups: RunIndexQueryResult["groups"];
  /** How each run behind the population ended, from its `run` row. */
  readonly runEnds: {
    readonly groupBy: readonly string[];
    readonly population: { readonly runs: number };
    readonly groups: RunIndexQueryResult["groups"];
    /** Of those runs, ones an earlier projection indexed, without the run-end fields. */
    readonly earlierProjectionRuns: number;
  };
  /** Present when the run store refused or failed to index a snapshot. */
  readonly incomplete: RunIndexOverflowV1 | null;
  /** How to rebuild this index from saved records; named on every incomplete line. */
  readonly rebuild: string;
  /** How to re-project stale rows in place; named on the stale lines. */
  readonly reimport: string;
}

export async function handleRunsQueryCommand(args: readonly string[]): Promise<void> {
  const parsed = parseRunsQueryArguments(args);
  if (parsed.help) {
    console.log(runsQueryUsage());
    return;
  }
  const envelope = await runRunsQuery(parsed);
  if (parsed.json) {
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }
  for (const line of formatRunsQuery(envelope)) console.log(line);
}

export async function runRunsQuery(parsed: RunsQueryArguments): Promise<RunIndexQueryEnvelopeV1> {
  const maxBytes = limit(RUN_INDEX_LIMITS.indexMaxBytes);
  let read;
  try {
    read = await readRunIndex({
      indexDirectory: parsed.indexDirectory,
      maxBytes,
      onOversize: (observed) => limitError(maxBytes, observed, IMPORT_HELP_COMMAND),
    });
  } catch (error) {
    storeError(error, parsed.indexDirectory);
  }
  const sinceMs = parsed.since !== undefined ? parseQueryTime(parsed.since) : undefined;
  const untilMs = parsed.until !== undefined ? parseQueryTime(parsed.until) : undefined;
  const result = queryRunIndex(read.rows, {
    where: parsed.where,
    groupBy: parsed.groupBy,
    ...(sinceMs !== undefined ? { sinceMs } : {}),
    ...(untilMs !== undefined ? { untilMs } : {}),
  });
  const current = newestSnapshots(completeSnapshots(read.rows).rows);
  const runEnds = queryRunEnds(read.rows, result.runEndRunIds);
  const earlierProjectionRuns = current.filter(
    (row) =>
      row.rowKind === "run" &&
      result.runEndRunIds.has(row.runId) &&
      row.projectionRevision < RUN_INDEX_RUN_END_REVISION,
  ).length;
  const staleClassifierRows = current.filter(
    (row) => row.rowKind === "attempt" && row.attemptClassifierSha256 !== attemptClassifierSha256(),
  ).length;
  return {
    schemaVersion: 1,
    kind: "docsfab-run-index-query",
    index: {
      path: read.path,
      exists: read.exists,
      storedRows: read.rows.length,
      supersededRows: result.supersededRows,
      unreadableLines: read.unreadableLines,
      incompleteSnapshots: result.incompleteSnapshots,
      staleClassifierRows,
    },
    filters: {
      where: Object.fromEntries(result.appliedWhere),
      rowKindDefaulted: result.rowKindDefaulted,
      since: parsed.since ?? null,
      until: parsed.until ?? null,
    },
    groupBy: parsed.groupBy,
    population: result.population,
    groups: result.groups,
    runEnds: {
      groupBy: RUN_INDEX_RUN_END_FIELDS,
      population: { runs: runEnds.population.runs },
      groups: runEnds.groups,
      earlierProjectionRuns,
    },
    incomplete: read.overflow,
    rebuild: runIndexRebuildRemediation(parsed.rebuildStateDirectory, parsed.indexDirectory),
    reimport: `docsfab runs import ${parsed.rebuildStateDirectory} --index-dir ${parsed.indexDirectory}`,
  };
}

export function formatRunsQuery(envelope: RunIndexQueryEnvelopeV1): string[] {
  const lines = [`RUN INDEX QUERY  ${envelope.index.path}`];
  if (!envelope.index.exists) {
    lines.push(
      "No run index exists yet. Run a workflow, or add saved records with docsfab runs import.",
    );
  }
  const filters = [
    ...Object.entries(envelope.filters.where).map(
      ([field, values]) =>
        `${field}=${values.join("|")}${field === "rowKind" && envelope.filters.rowKindDefaulted ? " (default)" : ""}`,
    ),
    ...(envelope.filters.since ? [`since=${envelope.filters.since}`] : []),
    ...(envelope.filters.until ? [`until=${envelope.filters.until}`] : []),
  ];
  lines.push(`Filters: ${filters.length > 0 ? filters.join(" ") : "none"}`);
  lines.push(
    `Population: ${String(envelope.population.rows)} rows across ${String(envelope.population.runs)} runs`,
  );
  for (const group of envelope.groups) {
    const key = envelope.groupBy
      .map((field) => `${field}=${renderRunIndexValue(group.key[field])}`)
      .join(" ");
    lines.push(
      `  ${String(group.rows)} rows (${(group.share * 100).toFixed(1)}%), ${String(group.runs)} runs${key ? `  ${key}` : ""}`,
    );
  }
  if (envelope.runEnds.population.runs === 0) {
    lines.push("RUN ENDS: none");
  } else {
    lines.push(`RUN ENDS: ${String(envelope.runEnds.population.runs)} runs, from each run row`);
    for (const group of envelope.runEnds.groups) {
      const key = envelope.runEnds.groupBy
        .map((field) => `${field}=${renderRunIndexValue(group.key[field])}`)
        .join(" ");
      lines.push(`  ${String(group.runs)} runs  ${key}`);
    }
    if (envelope.runEnds.earlierProjectionRuns > 0) {
      lines.push(
        `  ${String(envelope.runEnds.earlierProjectionRuns)} of these runs were indexed before run rows carried terminalStepId and failureCode, so both read unavailable. Import their records again: ${envelope.reimport}`,
      );
    }
  }
  if (envelope.index.supersededRows > 0) {
    lines.push(
      `Superseded: ${String(envelope.index.supersededRows)} rows from older snapshots of re-indexed runs were not counted.`,
    );
  }
  if (envelope.index.incompleteSnapshots > 0) {
    lines.push(
      `Incomplete snapshots: ${String(envelope.index.incompleteSnapshots)} appends were cut short and were not counted; each run's previous complete snapshot, if any, was used. ${envelope.rebuild}`,
    );
  }
  if (envelope.index.unreadableLines > 0) {
    lines.push(
      `Unreadable: ${String(envelope.index.unreadableLines)} index lines were not current rows and were not counted.`,
    );
  }
  if (envelope.index.staleClassifierRows > 0) {
    lines.push(
      `Stale classifier: ${String(envelope.index.staleClassifierRows)} attempt rows were indexed by a DocsFab that classifies attempts differently, so their failureClass, failureLayer, failureCode, and retryDecisionRule read unavailable. Import their records again: ${envelope.reimport}`,
    );
  }
  if (envelope.population.rowsWithOmittedFields > 0) {
    lines.push(
      `Omitted fields: ${String(envelope.population.rowsWithOmittedFields)} counted rows could not copy a recorded value (${RUN_INDEX_LIMITS.fieldMaxChars}); they match only as unavailable.`,
    );
  }
  if (envelope.incomplete) {
    const refusal = envelope.incomplete.lastRefusal;
    lines.push(
      `INCOMPLETE: ${String(envelope.incomplete.refusedSnapshots)} run snapshots were not indexed (last ${envelope.incomplete.lastRefusedRunId}: ${refusal.code}${
        refusal.limitName
          ? `, ${String(refusal.observed)} exceeds ${refusal.limitName} = ${String(refusal.limitValue)}`
          : ""
      }). Clear the cause, then: ${envelope.rebuild}`,
    );
  }
  return lines;
}

// --- import ----------------------------------------------------------------

type ImportSourceKind = "local-e2e-report" | "state-directory" | "record-file";

interface ImportCandidate {
  readonly path: string;
  readonly batchId: string | null;
  readonly caseKey: string | null;
}

export interface RunIndexImportEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-run-index-import";
  readonly index: { readonly path: string };
  readonly sources: readonly {
    readonly path: string;
    readonly kind: ImportSourceKind;
    readonly batchId: string | null;
    readonly records: number;
  }[];
  readonly imported: readonly {
    readonly runId: string;
    readonly caseKey: string | null;
    readonly rows: number;
  }[];
  readonly unchanged: readonly {
    readonly runId: string;
    readonly caseKey: string | null;
  }[];
  /**
   * Records that have not finished, so they are not indexed; the run store
   * indexes them when they reach a terminal status.
   */
  readonly notTerminal: readonly {
    readonly path: string;
    readonly runId: string;
    readonly status: string;
  }[];
  /** Records not indexed, each with a stable code; remaining records still import. */
  readonly refused: readonly {
    readonly path: string;
    readonly code: string;
    readonly observed?: number;
  }[];
  /** Harness cases that left no run record, so they have no rows. */
  readonly casesWithoutRunRecord: readonly {
    readonly batchId: string;
    readonly caseKey: string;
    readonly outcome: string | null;
  }[];
}

export async function handleRunsImportCommand(args: readonly string[]): Promise<void> {
  const parsed = parseRunsImportArguments(args);
  if (parsed.help) {
    console.log(runsImportUsage());
    return;
  }
  const envelope = await runRunsImport(parsed);
  if (parsed.json) {
    console.log(JSON.stringify(envelope, null, 2));
  } else {
    for (const line of formatRunsImport(envelope)) console.log(line);
  }
  if (envelope.refused.length > 0) process.exitCode = 1;
}

export async function runRunsImport(
  parsed: RunsImportArguments,
  options: {
    readonly now?: () => Date;
    /** Test seam at the precise stale-projection boundary, before source revalidation. */
    readonly afterProjection?: (runId: string) => void | Promise<void>;
  } = {},
): Promise<RunIndexImportEnvelopeV1> {
  const maxBytes = limit(RUN_INDEX_LIMITS.indexMaxBytes);
  const recordMaxBytes = limit(RUN_INDEX_LIMITS.recordMaxBytes);
  const importMaxRecords = limit(RUN_INDEX_LIMITS.importMaxRecords);
  const fieldMaxChars = limit(RUN_INDEX_LIMITS.fieldMaxChars).value;
  const sources: RunIndexImportEnvelopeV1["sources"][number][] = [];
  const candidates: ImportCandidate[] = [];
  const casesWithoutRunRecord: RunIndexImportEnvelopeV1["casesWithoutRunRecord"][number][] = [];
  const refused: RunIndexImportEnvelopeV1["refused"][number][] = [];
  for (const path of parsed.paths) {
    await collectImportSource(path, recordMaxBytes, {
      sources,
      candidates,
      casesWithoutRunRecord,
      refused,
    });
  }
  if (candidates.length > importMaxRecords.value) {
    limitError(importMaxRecords, candidates.length, IMPORT_HELP_COMMAND);
  }
  let existing;
  try {
    existing = await readRunIndex({
      indexDirectory: parsed.indexDirectory,
      maxBytes,
      onOversize: (observed) => limitError(maxBytes, observed, IMPORT_HELP_COMMAND),
    });
  } catch (error) {
    storeError(error, parsed.indexDirectory);
  }
  // Compare against complete snapshots only, so a run whose newest snapshot
  // was cut short is imported again instead of reported unchanged.
  const latest = new Map<string, RunIndexRowV1>();
  const complete = completeSnapshots(existing.rows).rows;
  for (const row of complete) latest.set(row.runId, row);
  // Runs whose newest snapshot has an attempt row another attempt classifier
  // wrote: its classes are that classifier's reading, not this one's.
  const staleClassifier = new Set<string>();
  for (const row of complete) {
    if (
      row.rowKind === "attempt" &&
      row.attemptClassifierSha256 !== attemptClassifierSha256() &&
      latest.get(row.runId)?.snapshotId === row.snapshotId
    ) {
      staleClassifier.add(row.runId);
    }
  }
  const imported: RunIndexImportEnvelopeV1["imported"][number][] = [];
  const unchanged: RunIndexImportEnvelopeV1["unchanged"][number][] = [];
  const notTerminal: RunIndexImportEnvelopeV1["notTerminal"][number][] = [];
  const indexedAt = (options.now ?? (() => new Date()))().toISOString();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const read = await readCandidate(candidate.path, recordMaxBytes);
    if (!read.ok) {
      refused.push(read.refusal);
      continue;
    }
    const recordSha256 = sha256Hex(read.bytes);
    const projection = projectRunIndexRows(read.value, {
      origin: "import",
      snapshotId: randomUUID(),
      indexedAt,
      recordSha256,
      fieldMaxChars,
      batchId: candidate.batchId,
      caseKey: candidate.caseKey,
      docsfabRevision: parsed.docsfabRevision,
    });
    if (!projection.ok) {
      refused.push({
        path: candidate.path,
        code: `runs-index-record-${projection.reason}`,
      });
      continue;
    }
    const runStatus = projection.rows[0]?.runStatus ?? "unavailable";
    if (!isRunIndexTerminalStatus(runStatus)) {
      notTerminal.push({
        path: candidate.path,
        runId: projection.runId,
        status: runStatus,
      });
      continue;
    }
    const previous = latest.get(projection.runId);
    const docsfabRevision = carriedDocsfabRevision(parsed.docsfabRevision, previous, recordSha256);
    const rows =
      docsfabRevision === parsed.docsfabRevision
        ? projection.rows
        : projection.rows.map((row) => ({ ...row, docsfabRevision }));
    // An earlier projection's snapshot is re-projected so its rows gain newer
    // fields. A later projection's snapshot, from a newer DocsFab sharing the
    // index, is kept: re-projecting would drop fields this version does not
    // know. At the same revision, rows from another attempt classifier are
    // re-projected so their classes are not left at an old reading.
    if (
      previous &&
      (previous.projectionRevision > RUN_INDEX_PROJECTION_REVISION ||
        (previous.projectionRevision === RUN_INDEX_PROJECTION_REVISION &&
          !staleClassifier.has(projection.runId))) &&
      previous.recordSha256 === recordSha256 &&
      previous.caseKey === candidate.caseKey &&
      previous.batchId === candidate.batchId &&
      previous.docsfabRevision === docsfabRevision
    ) {
      unchanged.push({ runId: projection.runId, caseKey: candidate.caseKey });
      continue;
    }
    let appended;
    await options.afterProjection?.(projection.runId);
    const sourceRoot = dirname(candidate.path);
    const canonicalSourceRoot = await realpath(sourceRoot);
    const canonicalIndexRoot = await realpath(parsed.indexDirectory).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return resolve(parsed.indexDirectory);
        throw error;
      },
    );
    if (canonicalSourceRoot === canonicalIndexRoot) {
      refused.push({ path: candidate.path, code: "runs-index-source-index-root-conflict" });
      continue;
    }
    try {
      const publication = await withRunMaintenanceGate(sourceRoot, () =>
        withActiveRunGate(sourceRoot, projection.runId, async () => {
          if (await isRunTombstoned(sourceRoot, projection.runId)) {
            return { kind: "deleted" as const };
          }
          const current = await readCandidate(candidate.path, recordMaxBytes);
          if (!current.ok || sha256Hex(current.bytes) !== recordSha256) {
            return { kind: "changed" as const };
          }
          return {
            kind: "appended" as const,
            result: await appendRunIndexSnapshot({
              indexDirectory: parsed.indexDirectory,
              rows,
              maxBytes,
            }),
          };
        }),
      );
      if (publication.kind !== "appended") {
        refused.push({
          path: candidate.path,
          code:
            publication.kind === "deleted" ? "runs-index-run-deleted" : "runs-index-record-changed",
        });
        continue;
      }
      appended = publication.result;
    } catch (error) {
      if (error instanceof RunIndexStoreError && error.code === "runs-index-run-deleted") {
        refused.push({ path: candidate.path, code: error.code });
        continue;
      }
      storeError(error, parsed.indexDirectory);
    }
    if (appended.status === "refused") {
      // Nothing after this point fits either; name every remaining record.
      for (const remaining of candidates.slice(index)) {
        refused.push({
          path: remaining.path,
          code: appended.limit.refusal,
          observed: appended.observedBytes,
        });
      }
      break;
    }
    const last = rows[rows.length - 1];
    if (last) latest.set(projection.runId, last);
    staleClassifier.delete(projection.runId);
    imported.push({
      runId: projection.runId,
      caseKey: candidate.caseKey,
      rows: rows.length,
    });
  }
  return {
    schemaVersion: 1,
    kind: "docsfab-run-index-import",
    index: { path: existing.path },
    sources,
    imported,
    unchanged,
    notTerminal,
    refused,
    casesWithoutRunRecord,
  };
}

async function collectImportSource(
  path: string,
  recordMaxBytes: ResolvedLimit,
  into: {
    sources: RunIndexImportEnvelopeV1["sources"][number][];
    candidates: ImportCandidate[];
    casesWithoutRunRecord: RunIndexImportEnvelopeV1["casesWithoutRunRecord"][number][];
    refused: RunIndexImportEnvelopeV1["refused"][number][];
  },
): Promise<void> {
  const entry = await lstatOrUndefined(path);
  if (!entry || entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
    throw new RunsOperatorError(
      "runs-import-path-unavailable",
      `The import path ${path} is not a readable regular file or directory, and symbolic links are not followed.`,
      IMPORT_HELP_COMMAND,
    );
  }
  if (entry.isFile()) {
    into.sources.push({ path, kind: "record-file", batchId: null, records: 1 });
    into.candidates.push({ path, batchId: null, caseKey: null });
    return;
  }
  const reportPath = join(path, HARNESS_REPORT_FILE);
  const report = await lstatOrUndefined(reportPath);
  if (!report) {
    const records = await recordFiles(path);
    into.sources.push({
      path,
      kind: "state-directory",
      batchId: null,
      records: records.length,
    });
    for (const file of records) into.candidates.push({ path: file, batchId: null, caseKey: null });
    return;
  }
  const read = await readCandidate(reportPath, recordMaxBytes);
  if (!read.ok) {
    throw new RunsOperatorError(
      read.refusal.code,
      `The harness report ${reportPath} could not be read as a bounded JSON file (${read.refusal.code}).`,
      IMPORT_HELP_COMMAND,
    );
  }
  const batch = decodeHarnessReport(read.value);
  if (!batch) {
    throw new RunsOperatorError(
      "runs-import-harness-report-unsupported",
      `The file ${reportPath} is not a schema-version 1 docsfab-local-e2e-report with safe case keys.`,
      IMPORT_HELP_COMMAND,
    );
  }
  let records = 0;
  for (const entryCase of batch.entries) {
    const files = await recordFiles(join(path, entryCase.key, "runs"));
    if (files.length === 0) {
      into.casesWithoutRunRecord.push({
        batchId: batch.batchId,
        caseKey: entryCase.key,
        outcome: entryCase.outcome,
      });
      continue;
    }
    records += files.length;
    for (const file of files) {
      into.candidates.push({
        path: file,
        batchId: batch.batchId,
        caseKey: entryCase.key,
      });
    }
  }
  into.sources.push({
    path,
    kind: "local-e2e-report",
    batchId: batch.batchId,
    records,
  });
}

function decodeHarnessReport(value: unknown):
  | {
      readonly batchId: string;
      readonly entries: readonly {
        readonly key: string;
        readonly outcome: string | null;
      }[];
    }
  | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  if (root.schemaVersion !== 1 || root.kind !== HARNESS_REPORT_KIND) return undefined;
  if (typeof root.batchId !== "string" || !HARNESS_BATCH_ID.test(root.batchId)) return undefined;
  if (!Array.isArray(root.entries)) return undefined;
  const entries: { key: string; outcome: string | null }[] = [];
  for (const entry of root.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const { key, outcome } = entry as Record<string, unknown>;
    if (typeof key !== "string" || !SAFE_RECORD_ID.test(key)) return undefined;
    entries.push({
      key,
      outcome: typeof outcome === "string" && SAFE_RECORD_ID.test(outcome) ? outcome : null,
    });
  }
  return { batchId: root.batchId, entries };
}

/** Saved record files in one directory, by name; a missing directory has none. */
async function recordFiles(directory: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isErrnoCode(error, ["ENOENT", "ENOTDIR"])) return [];
    throw new RunsOperatorError(
      "runs-import-path-unavailable",
      `The run state directory ${directory} could not be listed for import by this user.`,
      IMPORT_HELP_COMMAND,
    );
  }
  // Every other `.json` entry is a candidate, so a stray file is refused by
  // name rather than skipped. Only the known limit-overflow sidecar is not.
  return names
    .filter((name) => name.endsWith(RECORD_SUFFIX) && !name.endsWith(LIMIT_OVERFLOW_SIDECAR_SUFFIX))
    .sort()
    .map((name) => join(directory, name));
}

type CandidateRead =
  | { readonly ok: true; readonly bytes: Buffer; readonly value: unknown }
  | {
      readonly ok: false;
      readonly refusal: RunIndexImportEnvelopeV1["refused"][number];
    };

async function readCandidate(path: string, maxBytes: ResolvedLimit): Promise<CandidateRead> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat: Stats = await handle.stat();
    if (!stat.isFile()) {
      return {
        ok: false,
        refusal: { path, code: "runs-index-record-unsafe-file" },
      };
    }
    if (stat.size > maxBytes.value) {
      return {
        ok: false,
        refusal: { path, code: maxBytes.refusal, observed: stat.size },
      };
    }
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes.value) {
      return {
        ok: false,
        refusal: { path, code: maxBytes.refusal, observed: bytes.length },
      };
    }
    try {
      return { ok: true, bytes, value: parseJsonEvidence(bytes) };
    } catch {
      return {
        ok: false,
        refusal: { path, code: "runs-index-record-malformed" },
      };
    }
  } catch {
    return {
      ok: false,
      refusal: { path, code: "runs-index-record-unreadable" },
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}

function isErrnoCode(error: unknown, codes: readonly string[]): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    codes.includes((error as { code: string }).code)
  );
}

export function formatRunsImport(envelope: RunIndexImportEnvelopeV1): string[] {
  const rows = envelope.imported.reduce((sum, entry) => sum + entry.rows, 0);
  const lines = [
    `RUN INDEX IMPORT  ${envelope.index.path}`,
    ...envelope.sources.map(
      (source) =>
        `  ${source.kind}: ${source.path} (${String(source.records)} records${source.batchId ? `, batch ${source.batchId}` : ""})`,
    ),
    `Imported ${String(envelope.imported.length)} runs (${String(rows)} rows); ${String(envelope.unchanged.length)} unchanged; ${String(envelope.notTerminal.length)} not terminal; ${String(envelope.refused.length)} refused.`,
  ];
  for (const refusal of envelope.refused) {
    lines.push(
      `  refused ${refusal.path}: ${refusal.code}${refusal.observed !== undefined ? ` (observed ${String(refusal.observed)})` : ""}`,
    );
  }
  for (const pending of envelope.notTerminal) {
    lines.push(
      `  not terminal ${pending.path}: run ${pending.runId} is ${pending.status}; import it again after it finishes`,
    );
  }
  for (const missing of envelope.casesWithoutRunRecord) {
    lines.push(
      `  no run record: case ${missing.caseKey} (${missing.outcome ?? "unavailable"}) in batch ${missing.batchId}`,
    );
  }
  return lines;
}
