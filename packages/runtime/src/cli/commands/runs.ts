// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { DurableArtifactStore } from "../../artifacts/index.js";
import { readIndexedRunDiagnosis } from "../../diagnosis/record.js";
import { resolveDocsFabStateDirectory } from "../../config/host-paths.js";
import { loadSavedRunEditorialDecodeOptions } from "../run/editorial-replay.js";
import { readPatchFileStats } from "../run/patch-file-stats.js";
import type { RunRecord } from "../../records/contracts.js";
import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../../json-evidence.js";
import {
  inspectQualityReportFromRun,
  readPersistedHostedQualityReport,
} from "../../evaluation-report/index.js";
import {
  buildRunResultV1,
  classifyRunResumability,
  collectRunResultNextSteps,
  defaultRunRecordPath,
  formatRunSummary,
  loadReviewPresentation,
  projectHumanReviewFindings,
  projectRunContinuationCommand,
  serializeRunResultV1,
  type RunHistoryNextCommandContext,
  type RunResumabilityProjectionV1,
  type RunSummaryContext,
} from "../../operator/index.js";
import {
  interactiveWorkflowOutcomePolicy,
  workflowOutcomeExitCode,
  workflowOutcomeState,
  type WorkflowOutcomeDecodeOptionsV1,
} from "../../workflow-contracts/outcome.js";
import {
  collectRunLimitOverflowEvidence,
  loadRunLimitOverflowSidecar,
  mergeRunLimitOverflowEvidence,
} from "../../operator/run-limit-overflow.js";
import {
  handleRunsImportCommand,
  handleRunsQueryCommand,
  RunsOperatorError,
} from "./runs-index.js";
import { runRecordMaxBytes } from "../../records/run-record-limit.js";
import {
  overallRunStatus,
  decodeCheckoutPersistenceOutcome,
  type CheckoutPersistenceOutcomeV1,
} from "../../records/checkout-persistence.js";
import type { ResolvedLimit } from "../../config/limits.js";
import {
  lookupSavedRunPublication,
  lookupSavedRunRetainedDelivery,
} from "../../operator/run-publication-lookup.js";
import { decodeRunRecordRequestIntent } from "../../request-intent/interpret-record.js";
import { RequestIntentContractError } from "../../request-intent/kit.js";
import {
  decodeSavedRunRecord,
  SAVED_RUN_STATUSES,
  SAVED_RUN_WORKFLOWS,
} from "../../records/saved-run-record.js";
import { handleRunsDeleteCommand } from "./runs-delete.js";
import {
  admitPlannerDiagnostic,
  isPlannerMissingGovernedInputCode,
} from "../../workflow-contracts/planner-diagnostic.js";

export { decodeSavedRunRecord } from "../../records/saved-run-record.js";

const SAFE_RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface RunsShowArguments {
  readonly command: "show";
  readonly runId: string;
  readonly json: boolean;
  readonly showScan: boolean;
  readonly stateDirectory: string;
  /** Gates the rendered `env DOCSFAB_STATE_DIR=` prefix. */
  readonly stateDirectoryExplicit: boolean;
  /** Read-only path input; never a write or accept grant by itself. */
  readonly canonSnapshotPath?: string;
  readonly acceptCandidateSnapshot: boolean;
  readonly authorityId?: string;
}

export interface RunsListArguments {
  readonly command: "list";
  readonly json: boolean;
  readonly stateDirectory: string;
}

export type RunsArguments = RunsShowArguments | RunsListArguments;

export interface RunListEntry {
  readonly runId: string;
  readonly availability: "available" | "unavailable";
  readonly workflow?: string;
  readonly status?: string;
  readonly workflowStatus?: string;
  readonly checkoutPersistence?: CheckoutPersistenceOutcomeV1;
  readonly repository?: { readonly path: string; readonly revision: string };
  readonly startedAt?: string;
  readonly updatedAt?: string;
  readonly artifacts?: { readonly available: boolean; readonly count: number };
  readonly report?: { readonly available: boolean };
  /** Minimized terminal/blocked/resumable/non-resumable fact. Never a command. */
  readonly resumability?: RunResumabilityProjectionV1;
  readonly reason?:
    | "malformed-record"
    | "unsupported-schema"
    | "unreadable-record"
    | "record-too-large";
  /** With `record-too-large`: the bound the record crossed and its observed size. */
  readonly limit?: RunListRecordLimitV1;
}

/** The run-record bound an unlisted record crossed. Numbers and names only. */
export interface RunListRecordLimitV1 {
  readonly name: string;
  readonly refusal: string;
  readonly value: number;
  readonly observed: number;
  readonly unit: string;
  readonly remediation: string;
}

export interface RunListEnvelope {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-run-list";
  readonly runs: readonly RunListEntry[];
}

const MAX_LIST_RECORDS = 10_000;
const MAX_LIST_FIELD_LENGTH = 512;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/u;
/**
 * Saved-run commands. Show, list, query, and import preserve their existing
 * contracts; delete requires a preview token before changing local stores.
 */
export async function handleRunsCommand(args: string[]): Promise<void> {
  if (args[0] === "query") return handleRunsQueryCommand(args.slice(1));
  if (args[0] === "import") return handleRunsImportCommand(args.slice(1));
  if (args[0] === "delete") return handleRunsDeleteCommand(args.slice(1));
  const parsed = parseRunsArguments(args);
  if (parsed.command === "list") {
    const runs = await listSavedRunRecords(parsed.stateDirectory);
    if (parsed.json) {
      const envelope: RunListEnvelope = { schemaVersion: 1, kind: "docsfab-run-list", runs };
      console.log(canonicalizeJsonEvidence(envelope as unknown as JsonEvidenceValue).trimEnd());
    } else {
      for (const line of formatRunList(runs, parsed.stateDirectory)) console.log(line);
    }
    return;
  }
  const recordPath = defaultRunRecordPath(parsed.stateDirectory, parsed.runId);
  let record: RunRecord;
  try {
    record = await loadSavedRunRecord(recordPath, parsed.runId);
  } catch (error) {
    if (error instanceof SavedRunNotFoundError) {
      reportSavedRunNotFound(error, parsed.json);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  const htmlReport = await readPersistedHostedQualityReport({
    stateDirectory: parsed.stateDirectory,
    runId: parsed.runId,
  });
  const qualityError = inspectQualityReportFromRun(record).error;
  const editorialDecodeOptions = await loadSavedRunEditorialDecodeOptions(
    record,
    parsed.stateDirectory,
  );
  const reviewPresentation =
    record.workflow === "review-documentation"
      ? await loadReviewPresentation(
          record,
          new DurableArtifactStore(resolve(dirname(parsed.stateDirectory), "artifacts")),
        )
      : undefined;
  const reviewFindingsProjection = projectHumanReviewFindings(record, reviewPresentation?.findings);
  let verifiedQuestion = false;
  if (record.status === "needs-input" && record.steps.length === 0 && record.requestIntent) {
    try {
      verifiedQuestion =
        decodeRunRecordRequestIntent(record.requestIntent, record.instruction).admission.outcome ===
        "question";
    } catch (error) {
      if (!(error instanceof RequestIntentContractError)) throw error;
    }
  }
  const plannerDiagnostic =
    record.status === "needs-input" ? admitPlannerDiagnostic(record) : undefined;
  const verifiedPlannerInput =
    plannerDiagnostic !== undefined && isPlannerMissingGovernedInputCode(plannerDiagnostic.code);
  const exitCode = qualityError
    ? 1
    : record.checkoutPersistence?.outcome === "failed"
      ? 1
      : verifiedQuestion ||
          verifiedPlannerInput ||
          (record.status === "needs-input" &&
            workflowOutcomeState(record, editorialDecodeOptions).state === "current")
        ? 2
        : workflowOutcomeExitCode(
            record,
            interactiveWorkflowOutcomePolicy(),
            editorialDecodeOptions,
          );
  const patchFileStats = parsed.json ? undefined : await readPatchFileStats(record);
  const limitOverflowEvidence = mergeRunLimitOverflowEvidence(
    collectRunLimitOverflowEvidence(record),
    await loadRunLimitOverflowSidecar(recordPath, parsed.runId),
  );
  const diagnosis =
    !parsed.json && record.status === "failed"
      ? await readIndexedRunDiagnosis(record, recordPath)
      : undefined;
  const deliveryLookup = await lookupSavedRunPublication({
    environment: process.env,
    stateDirectory: parsed.stateDirectory,
    record,
  });
  const retainedDelivery = await lookupSavedRunRetainedDelivery({
    environment: process.env,
    stateDirectory: parsed.stateDirectory,
    record,
  });
  const summaryContext: RunSummaryContext = {
    record,
    recordPath,
    exitCode,
    repositoryPath: record.repository.sourcePath,
    ...(deliveryLookup ? { deliveryLookup } : {}),
    ...(retainedDelivery ? { retainedDelivery } : {}),
    ...(diagnosis ? { diagnosis } : {}),
    showScan: parsed.showScan,
    ...(patchFileStats ? { patchFileStats } : {}),
    ...(editorialDecodeOptions ? { editorialDecodeOptions } : {}),
    ...(reviewFindingsProjection ? { reviewFindingsProjection } : {}),
    ...(reviewPresentation?.evidence
      ? { reviewEvidenceProjection: reviewPresentation.evidence }
      : {}),
    ...(limitOverflowEvidence ? { limitOverflowEvidence } : {}),
    ...(htmlReport?.reportAvailable
      ? {
          htmlReportUrl: htmlReport.url,
          htmlReportPath: htmlReport.path,
          markdownReportPath: htmlReport.markdownPath,
          markdownReportAvailable: htmlReport.markdownAvailable,
          ...(htmlReport.markdownUnavailableReason
            ? { markdownReportUnavailableReason: htmlReport.markdownUnavailableReason }
            : {}),
          reportServeCommand: htmlReport.serveCommand,
        }
      : {
          ...(record.workflow === "review-documentation"
            ? {
                reportUnavailableReason: htmlReport?.reportUnavailableReason
                  ? `retained report unavailable (${htmlReport.reportUnavailableReason})`
                  : "no retained evaluator report",
              }
            : {}),
        }),
  };
  if (parsed.json) {
    console.log(
      serializeRunResultV1(
        buildRunResultV1({
          record,
          recordPath,
          exitCode,
          repositoryPath: record.repository.sourcePath,
          ...(editorialDecodeOptions ? { editorialDecodeOptions } : {}),
          nextSteps: collectRunResultNextSteps(summaryContext),
          htmlReport: htmlReport?.reportAvailable
            ? { url: htmlReport.url, path: htmlReport.path, digestSha256: htmlReport.digestSha256 }
            : null,
          ...(reviewFindingsProjection ? { reviewFindingsProjection } : {}),
          ...(reviewPresentation?.evidence
            ? { reviewEvidenceProjection: reviewPresentation.evidence }
            : {}),
          ...(limitOverflowEvidence ? { limitOverflowEvidence } : {}),
          ...(deliveryLookup ? { deliveryLookup } : {}),
          ...(retainedDelivery ? { retainedDelivery } : {}),
        }),
      ).trimEnd(),
    );
  } else {
    const resumability = await classifyRunResumability(
      record,
      parsed.stateDirectory,
      undefined,
      editorialDecodeOptions,
    );
    let readyCommand: { command: string; reason: string } | undefined;
    let selectionOutcomeReason: string | undefined;
    const explicitSelectionAttempted =
      parsed.canonSnapshotPath !== undefined ||
      parsed.acceptCandidateSnapshot ||
      parsed.authorityId !== undefined;
    // `projectRunContinuationCommand` gates on `resumability.category` itself,
    // so this caller does not duplicate the check.
    if (explicitSelectionAttempted) {
      const selection = await projectRunContinuationCommand({
        record,
        resumability,
        stateDirectory: parsed.stateDirectory,
        stateDirectoryExplicit: parsed.stateDirectoryExplicit,
        canonSnapshotPath: parsed.canonSnapshotPath,
        acceptCandidateSnapshot: parsed.acceptCandidateSnapshot,
        authorityId: parsed.authorityId,
      });
      if (selection.disposition === "ready") {
        readyCommand = selection.rendered;
      } else {
        selectionOutcomeReason = selection.reason;
      }
    }
    const historyContext: RunSummaryContext = {
      ...summaryContext,
      history: { resumability, readyCommand, selectionOutcomeReason },
    };
    for (const line of formatRunSummary(historyContext)) {
      console.log(line);
    }
  }
  if (exitCode !== 0) process.exitCode = exitCode;
}

export function parseRunsArguments(args: string[]): RunsArguments {
  if (args[0] === "list") return parseRunsListArguments(args.slice(1));
  if (args[0] !== "show") {
    throw new RunsOperatorError(
      "runs-invalid-subcommand",
      "The docsfab runs command supports list, show, query, import, or delete for saved run records.",
      "docsfab runs --help",
    );
  }
  const rest = args.slice(1);
  if (rest.includes("--allow-write")) {
    throw new Error("docsfab runs show is read-only and does not accept write authorization.");
  }
  const jsonCount = rest.filter((argument) => argument === "--json").length;
  const showScanCount = rest.filter((argument) => argument === "--show-scan").length;
  const acceptCandidateCount = rest.filter(
    (argument) => argument === "--accept-candidate-snapshot",
  ).length;
  if (jsonCount > 1) {
    throw new Error("The --json option must not be duplicated on docsfab runs show.");
  }
  if (showScanCount > 1) {
    throw new Error("The --show-scan option must not be duplicated on docsfab runs show.");
  }
  if (acceptCandidateCount > 1) {
    throw new Error(
      "The --accept-candidate-snapshot option must not be duplicated on docsfab runs show.",
    );
  }
  const withoutFlags = rest.filter(
    (argument) =>
      argument !== "--json" &&
      argument !== "--show-scan" &&
      argument !== "--accept-candidate-snapshot",
  );
  const consumed = new Set<number>();
  const stateDirectories: string[] = [];
  const canonSnapshotPaths: string[] = [];
  const authorityIds: string[] = [];
  for (let index = 0; index < withoutFlags.length; index += 1) {
    const argument = withoutFlags[index]!;
    if (argument === "--state-dir") {
      const value = withoutFlags[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("The --state-dir option requires a directory path value.");
      }
      consumed.add(index);
      consumed.add(index + 1);
      stateDirectories.push(value);
      index += 1;
      continue;
    }
    if (argument === "--canon-snapshot") {
      const value = withoutFlags[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("The --canon-snapshot option requires a file path value.");
      }
      consumed.add(index);
      consumed.add(index + 1);
      canonSnapshotPaths.push(value);
      index += 1;
      continue;
    }
    if (argument === "--authority-id") {
      const value = withoutFlags[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("The --authority-id option requires a DocsFab operator identifier value.");
      }
      consumed.add(index);
      consumed.add(index + 1);
      authorityIds.push(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      throw new Error(`Unknown docsfab runs show option "${argument}" is not supported.`);
    }
  }
  if (stateDirectories.length > 1) {
    throw new Error("The --state-dir option must not be duplicated on docsfab runs show.");
  }
  if (canonSnapshotPaths.length > 1) {
    throw new Error("The --canon-snapshot option must not be duplicated on docsfab runs show.");
  }
  if (authorityIds.length > 1) {
    throw new Error("The --authority-id option must not be duplicated on docsfab runs show.");
  }
  const canonSnapshotPath = canonSnapshotPaths[0];
  const authorityId = authorityIds[0];
  const acceptCandidateSnapshot = acceptCandidateCount === 1;
  if (acceptCandidateSnapshot && !canonSnapshotPath) {
    throw new Error(
      "The --accept-candidate-snapshot option requires a --canon-snapshot <path> value.",
    );
  }
  if (acceptCandidateSnapshot && !authorityId) {
    throw new Error(
      "The --accept-candidate-snapshot option requires an --authority-id <id> value.",
    );
  }
  if (authorityId && !acceptCandidateSnapshot) {
    throw new Error(
      "The --authority-id option on docsfab runs show requires --accept-candidate-snapshot.",
    );
  }
  if (
    jsonCount === 1 &&
    (canonSnapshotPath !== undefined || acceptCandidateSnapshot || authorityId !== undefined)
  ) {
    throw new Error(
      "The --json option cannot be combined with --canon-snapshot, --accept-candidate-snapshot, or --authority-id on docsfab runs show.",
    );
  }
  const positionals = withoutFlags.filter((_, index) => !consumed.has(index));
  if (positionals.length === 0) {
    throw new Error("docsfab runs show requires a saved run id argument.");
  }
  if (positionals.length > 1) {
    throw new Error("docsfab runs show accepts exactly one saved run id.");
  }
  const runId = positionals[0]!;
  if (!SAFE_RECORD_ID.test(runId)) {
    throw new Error("The requested run id is not a safe record identity.");
  }
  return {
    command: "show",
    runId,
    json: jsonCount === 1,
    showScan: showScanCount === 1,
    stateDirectory: resolve(stateDirectories[0] ?? resolveDocsFabStateDirectory()),
    stateDirectoryExplicit: stateDirectories.length === 1,
    ...(canonSnapshotPath ? { canonSnapshotPath: resolve(canonSnapshotPath) } : {}),
    acceptCandidateSnapshot,
    ...(authorityId ? { authorityId } : {}),
  };
}

function parseRunsListArguments(args: string[]): RunsListArguments {
  const jsonCount = args.filter((argument) => argument === "--json").length;
  if (jsonCount > 1) {
    throw new Error("The --json option must not be duplicated on docsfab runs list.");
  }
  const withoutFlags = args.filter((argument) => argument !== "--json");
  const consumed = new Set<number>();
  const stateDirectories: string[] = [];
  for (let index = 0; index < withoutFlags.length; index += 1) {
    const argument = withoutFlags[index]!;
    if (argument === "--state-dir") {
      const value = withoutFlags[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("The --state-dir option requires a directory path value.");
      }
      consumed.add(index);
      consumed.add(index + 1);
      stateDirectories.push(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      throw new Error(`Unknown docsfab runs list option "${argument}" is not supported.`);
    }
  }
  if (stateDirectories.length > 1) {
    throw new Error("The --state-dir option must not be duplicated on docsfab runs list.");
  }
  if (withoutFlags.some((_, index) => !consumed.has(index))) {
    throw new Error("The docsfab runs list command accepts no positional arguments.");
  }
  return {
    command: "list",
    json: jsonCount === 1,
    stateDirectory: resolve(stateDirectories[0] ?? resolveDocsFabStateDirectory()),
  };
}

async function listSavedRunRecords(stateDirectory: string): Promise<RunListEntry[]> {
  let entries;
  try {
    entries = await readdir(stateDirectory, { withFileTypes: true });
  } catch (error) {
    if (isErrnoCode(error, ["ENOENT"])) return [];
    throw new Error("The saved run directory could not be read.");
  }

  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (candidates.length > MAX_LIST_RECORDS)
    throw new Error("The saved run directory contains too many records to list safely.");
  const recordBound = runRecordMaxBytes();
  const runs = await Promise.all(
    candidates.map((entry) => loadRunListEntry(resolve(stateDirectory, entry.name), recordBound)),
  );
  return runs.sort(compareRunListEntries);
}

async function loadRunListEntry(
  recordPath: string,
  recordBound: ResolvedLimit,
): Promise<RunListEntry> {
  const filename = recordPath.slice(recordPath.lastIndexOf("/") + 1);
  const filenameId = filename.endsWith(".json") ? filename.slice(0, -5) : "";
  if (!SAFE_RECORD_ID.test(filenameId)) {
    return { runId: "unavailable", availability: "unavailable", reason: "malformed-record" };
  }
  try {
    const metadata = await stat(recordPath);
    if (metadata.size > recordBound.value) {
      // Too large is not malformed: name the bound, the size, and how to raise it.
      return {
        runId: filenameId,
        availability: "unavailable",
        reason: "record-too-large",
        limit: {
          name: recordBound.name,
          refusal: recordBound.refusal,
          value: recordBound.value,
          observed: metadata.size,
          unit: recordBound.unit,
          remediation: recordBound.remediation,
        },
      };
    }
    const value = parseJsonEvidence(await readFile(recordPath));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { runId: filenameId, availability: "unavailable", reason: "malformed-record" };
    }
    const root = value as { [key: string]: JsonEvidenceValue };
    if (root.schemaVersion !== 2) {
      return { runId: filenameId, availability: "unavailable", reason: "unsupported-schema" };
    }
    if (root.id !== filenameId) {
      return { runId: filenameId, availability: "unavailable", reason: "malformed-record" };
    }
    const repository = root.repository;
    if (!repository || typeof repository !== "object" || Array.isArray(repository)) {
      return { runId: filenameId, availability: "unavailable", reason: "malformed-record" };
    }
    const repo = repository as { [key: string]: JsonEvidenceValue };
    if (
      !isSafeListField(root.workflow) ||
      !SAVED_RUN_WORKFLOWS.has(root.workflow) ||
      !isSafeListField(root.status) ||
      !SAVED_RUN_STATUSES.has(root.status) ||
      !isSafeListField(repo.sourcePath) ||
      !isSafeListField(repo.revision)
    ) {
      return { runId: filenameId, availability: "unavailable", reason: "malformed-record" };
    }
    const checkoutPersistence = Object.hasOwn(root, "checkoutPersistence")
      ? decodeCheckoutPersistenceOutcome(root.checkoutPersistence)
      : undefined;
    const createdAt = timestampField(root.createdAt);
    const startedAt = timestampField(root.startedAt);
    const updatedAt = timestampField(root.completedAt) ?? createdAt;
    if (!createdAt || !updatedAt)
      return { runId: filenameId, availability: "unavailable", reason: "malformed-record" };
    const artifacts = Array.isArray(root.artifacts)
      ? { available: root.artifacts.length > 0, count: root.artifacts.length }
      : { available: false, count: 0 };
    const report = await readPersistedHostedQualityReport({
      stateDirectory: dirname(recordPath),
      runId: filenameId,
    });
    const stateDirectory = dirname(recordPath);
    const editorialDecodeOptions = await editorialDecodeOptionsForSavedListRecord(
      value,
      filenameId,
      stateDirectory,
    );
    const resumability = await classifyRunResumability(
      value,
      stateDirectory,
      undefined,
      editorialDecodeOptions,
    ).catch(() => ({ category: "non-resumable", reason: "unverifiable-attempt-journal" }) as const);
    return {
      runId: filenameId,
      availability: "available",
      workflow: root.workflow,
      status: overallRunStatus({
        status: root.status as RunRecord["status"],
        ...(checkoutPersistence ? { checkoutPersistence } : {}),
      }),
      ...(checkoutPersistence
        ? {
            workflowStatus: root.status as string,
            checkoutPersistence,
          }
        : {}),
      repository: { path: repo.sourcePath, revision: repo.revision },
      ...(startedAt ? { startedAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      artifacts,
      report: { available: report?.reportAvailable === true },
      resumability,
    };
  } catch (error) {
    return {
      runId: filenameId,
      availability: "unavailable",
      reason: isErrnoCode(error, ["EACCES", "EPERM"]) ? "unreadable-record" : "malformed-record",
    };
  }
}

function stringField(value: JsonEvidenceValue | undefined): string | undefined {
  return isSafeListField(value) ? value : undefined;
}
function isSafeListField(value: JsonEvidenceValue | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_LIST_FIELD_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
function timestampField(value: JsonEvidenceValue | undefined): string | undefined {
  if (!isSafeListField(value) || !ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value)))
    return undefined;
  return value;
}

function compareRunListEntries(left: RunListEntry, right: RunListEntry): number {
  const leftTime = Date.parse(left.updatedAt ?? "");
  const rightTime = Date.parse(right.updatedAt ?? "");
  return (
    (Number.isNaN(rightTime) ? -Infinity : rightTime) -
      (Number.isNaN(leftTime) ? -Infinity : leftTime) || right.runId.localeCompare(left.runId)
  );
}

function formatRunList(runs: readonly RunListEntry[], stateDirectory: string): string[] {
  if (runs.length === 0) return [`No saved runs in ${stateDirectory}.`];
  return [
    "RUNS",
    ...runs.map((run) => {
      if (run.availability === "unavailable") {
        if (run.reason === "record-too-large" && run.limit) {
          return `  ${run.runId}: unavailable (record-too-large: ${run.limit.observed} ${run.limit.unit} exceeds ${run.limit.name} = ${run.limit.value} ${run.limit.unit}; code ${run.limit.refusal}). ${run.limit.remediation}`;
        }
        return `  ${run.runId}: unavailable (${run.reason ?? "unavailable"})`;
      }
      return [
        `  ${run.runId}`,
        `workflow=${run.workflow}`,
        `status=${run.status}`,
        `repository=${run.repository?.path}`,
        `revision=${run.repository?.revision}`,
        `started=${run.startedAt ?? "unavailable"}`,
        `updated=${run.updatedAt ?? "unavailable"}`,
        `artifacts=${run.artifacts?.available ? "available" : "unavailable"}`,
        `report=${run.report?.available ? "available" : "unavailable"}`,
        `resumability=${run.resumability?.category ?? "unavailable"}`,
      ].join(" ");
    }),
  ];
}

/**
 * Load the same state-directory-bound coverage/editorial/security replay
 * decoders `runs show` uses. List must not crash the directory scan when one
 * record's retained evidence is unavailable; fail closed without options.
 */
async function editorialDecodeOptionsForSavedListRecord(
  value: JsonEvidenceValue,
  expectedId: string,
  stateDirectory: string,
): Promise<WorkflowOutcomeDecodeOptionsV1 | undefined> {
  try {
    return await loadSavedRunEditorialDecodeOptions(
      decodeSavedRunRecord(value, expectedId),
      stateDirectory,
    );
  } catch {
    return undefined;
  }
}

class SavedRunNotFoundError extends Error {
  readonly code = "saved-run-not-found";
  readonly stateDirectory: string;
  readonly nextAction: string;

  public constructor(stateDirectory: string) {
    super(`The requested saved run record was not found in ${stateDirectory}.`);
    this.name = "SavedRunNotFoundError";
    this.stateDirectory = stateDirectory;
    this.nextAction = `docsfab runs list --state-dir ${quoteCliOperand(stateDirectory)}`;
  }
}

function quoteCliOperand(value: string): string {
  return /^[A-Za-z0-9_.\-/:@]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function reportSavedRunNotFound(error: SavedRunNotFoundError, json: boolean): void {
  const envelope = {
    schemaVersion: 1 as const,
    kind: "docsfab-operator-error" as const,
    code: error.code,
    message: error.message,
    nextAction: error.nextAction,
  };
  if (json) {
    console.error(JSON.stringify(envelope));
    return;
  }
  console.error(error.message);
  console.error(`code: ${error.code}`);
  console.error(`Next action: ${error.nextAction}`);
}

async function loadSavedRunRecord(recordPath: string, expectedId: string): Promise<RunRecord> {
  let bytes: Buffer;
  try {
    bytes = await readFile(recordPath);
  } catch (error) {
    if (isErrnoCode(error, ["ENOENT", "ENOTDIR"])) {
      throw new SavedRunNotFoundError(dirname(recordPath));
    }
    throw new Error("The saved run record could not be read.");
  }
  let value: JsonEvidenceValue;
  try {
    value = parseJsonEvidence(bytes);
  } catch {
    throw new Error("The saved run record is malformed and cannot be shown.");
  }
  return decodeSavedRunRecord(value, expectedId);
}

function isErrnoCode(error: unknown, codes: readonly string[]): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}
