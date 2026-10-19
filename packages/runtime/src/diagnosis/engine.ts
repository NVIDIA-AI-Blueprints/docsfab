// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Diagnosis over run index rows: one answer per run, naming the terminal
 * failure of each failed step, the earlier failures it recovered from or
 * repeated, and how often the same step failed the same way for the same
 * provider and model. Recurrence counts come from `queryRunIndex` with the
 * exact clauses the printed `docsfab runs query` command carries, so running
 * that command reproduces the number.
 */
import {
  completeSnapshots,
  newestSnapshots,
  queryRunIndex,
  RUN_INDEX_UNAVAILABLE,
} from "../records/run-index-query.js";
import {
  isRunIndexQueryField,
  type RunIndexQueryField,
  type RunIndexRowV1,
} from "../records/run-index.js";
import {
  attemptOutputTotalsOf,
  classifyAttemptRow,
  classifyRecordedFailure,
  streamErrorStatusOf,
  type CauseCommands,
  type CauseReading,
} from "./classify.js";
import type {
  DiagnosisEvidenceV1,
  DiagnosisFindingV1,
  DiagnosisRecurrenceV1,
  DiagnosisStopV1,
  RunDiagnosisV1,
  WhyModelCauseV1,
  WhyModelSummaryV1,
} from "./contracts.js";
import { DIAGNOSIS_OWNER_LABELS } from "./contracts.js";

/** Where the diagnosed index lives, as the arguments each printed command carries. */
export interface DiagnosisLocation {
  /** Appended to `docsfab why` and `docsfab runs query`, for example ` --state-dir /x`. */
  readonly indexArgs: string;
  /** Appended to `docsfab runs show`; empty when only an index directory is known. */
  readonly showArgs: string;
}

export interface DiagnoseRunOptions {
  readonly location: DiagnosisLocation;
  readonly source: RunDiagnosisV1["source"];
  /**
   * Every index row available for recurrence, raw from the index file plus any
   * run projected in memory. `null` when the index could not be read.
   */
  readonly population: readonly RunIndexRowV1[] | null;
  /** `diagnosis.recurrenceLookbackRuns`. */
  readonly lookbackRuns: number;
}

/** Each run's newest complete snapshot, grouped by run in file order. */
export function currentRunRows(rows: readonly RunIndexRowV1[]): Map<string, RunIndexRowV1[]> {
  const byRun = new Map<string, RunIndexRowV1[]>();
  for (const row of newestSnapshots(completeSnapshots(rows).rows)) {
    const list = byRun.get(row.runId) ?? [];
    list.push(row);
    byRun.set(row.runId, list);
  }
  return byRun;
}

/** Newest first by creation time; file order breaks ties, later first. */
export function newestRunIds(byRun: ReadonlyMap<string, readonly RunIndexRowV1[]>): string[] {
  const entries = [...byRun.entries()].map(([runId, rows], order) => ({
    runId,
    order,
    created: Date.parse(rows[0]?.runCreatedAt ?? ""),
  }));
  return entries
    .sort(
      (left, right) =>
        (Number.isNaN(right.created) ? -Infinity : right.created) -
          (Number.isNaN(left.created) ? -Infinity : left.created) || right.order - left.order,
    )
    .map((entry) => entry.runId);
}

export function diagnoseRun(
  runRows: readonly RunIndexRowV1[],
  options: DiagnoseRunOptions,
): RunDiagnosisV1 {
  const runRow = runRows.find((row) => row.rowKind === "run") ?? runRows[0];
  if (!runRow) throw new TypeError("A run diagnosis needs at least the run's index row.");
  const runId = runRow.runId;
  const commands: CauseCommands = {
    whyJson: `docsfab why ${shellArgument(runId)}${options.location.indexArgs} --json`,
    runsShow: `docsfab runs show ${shellArgument(runId)}${options.location.showArgs}`,
  };
  const steps = groupSteps(runRows);
  const findings: DiagnosisFindingV1[] = [];
  const contributing: DiagnosisFindingV1[] = [];
  for (const step of steps) {
    const failingRows = step.rows.filter((row) => !isSucceededRow(row));
    const terminal = step.status === "failed" ? failingRows.at(-1) : undefined;
    if (terminal) {
      findings.push(
        buildFinding({
          role: "terminal",
          rows: [terminal],
          step,
          reading: readRow(terminal, commands, options),
          runRow,
          options,
        }),
      );
    }
    const earlier = new Map<string, { rows: RunIndexRowV1[]; reading: CauseReading }>();
    for (const row of failingRows) {
      if (row === terminal || row.rowKind !== "attempt") continue;
      const reading = readRow(row, commands, options);
      const group = earlier.get(reading.cause) ?? { rows: [], reading };
      group.rows.push(row);
      group.reading = reading;
      earlier.set(reading.cause, group);
    }
    for (const group of earlier.values()) {
      contributing.push(
        buildFinding({
          role: "contributing",
          rows: group.rows,
          step,
          reading: group.reading,
          runRow,
          options,
        }),
      );
    }
  }
  const verdict = verdictOf(runRow.runStatus);
  if (verdict === "failed" && findings.length === 0) {
    findings.push(
      buildFinding({
        role: "terminal",
        rows: [runRow],
        step: null,
        reading: classifyRecordedFailure(runRow, commands),
        runRow,
        options,
      }),
    );
  }
  const all = [...findings, ...contributing];
  // The default store has no location args; --index-dir has an index arg but
  // deliberately no saved-run show arg because imports need not live beside it.
  const stop = recordedStop(
    runRow,
    steps,
    commands.runsShow,
    options.location.showArgs !== "" || options.location.indexArgs === "",
  );
  const identity = runModelIdentity(runRows, findings);
  return {
    runId,
    workflow: runRow.workflow,
    runStatus: runRow.runStatus,
    runCreatedAt: runRow.runCreatedAt,
    batchId: runRow.batchId,
    caseKey: runRow.caseKey,
    docsfabRevision: runRow.docsfabRevision,
    provider: identity.provider,
    model: identity.model,
    verdict,
    summary: summarize(runId, verdict, findings, contributing, runRow, stop),
    findings: all,
    stop,
    whyCommand: `docsfab why ${shellArgument(runId)}${options.location.indexArgs}`,
    showCommand: commands.runsShow,
    source: options.source,
    planConversion: runRow.planConversion,
    sourceEvidence: runRow.sourceEvidence,
    unverifiedDimensions: runRow.unverifiedDimensions,
    readinessDisposition: runRow.readinessDisposition,
    readinessReasonCodes: runRow.readinessReasonCodes,
    sourceProposalOutcomes: sourceProposalOutcomesOf(runRow.sourceProposalOutcomes),
    sourceProposalOutcomesOmitted:
      runRow.projectionRevision < 19
        ? null
        : runRow.omittedFields.includes("sourceProposalOutcomes"),
  };
}

function sourceProposalOutcomesOf(value: string | null) {
  if (value === null) return null;
  try {
    const decoded: unknown = JSON.parse(value);
    return Array.isArray(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** Per provider and model: runs that used it, runs it failed, and causes by role. */
export function summarizeByModel(
  diagnoses: readonly RunDiagnosisV1[],
  rowsByRun: ReadonlyMap<string, readonly RunIndexRowV1[]>,
): WhyModelSummaryV1[] {
  interface Tally {
    provider: string | null;
    model: string | null;
    runs: Set<string>;
    failedRuns: Set<string>;
    causes: Map<string, { cause: WhyModelCauseV1; runs: Set<string>; steps: Set<string> }>;
  }
  const tallies = new Map<string, Tally>();
  const tallyOf = (provider: string | null, model: string | null): Tally => {
    const key = JSON.stringify([provider, model]);
    const existing = tallies.get(key);
    if (existing) return existing;
    const created: Tally = {
      provider,
      model,
      runs: new Set(),
      failedRuns: new Set(),
      causes: new Map(),
    };
    tallies.set(key, created);
    return created;
  };
  for (const diagnosis of diagnoses) {
    const models = new Set<string>();
    for (const row of rowsByRun.get(diagnosis.runId) ?? []) {
      // Steps that call no model, such as a lint step, do not count as a model's run.
      if (row.rowKind === "run" || (row.rowKind === "step" && row.model === null)) continue;
      models.add(JSON.stringify([row.provider, row.model]));
    }
    if (models.size === 0) models.add(JSON.stringify([diagnosis.provider, diagnosis.model]));
    for (const key of models) {
      const [provider, model] = JSON.parse(key) as [string | null, string | null];
      tallyOf(provider, model).runs.add(diagnosis.runId);
    }
    for (const finding of diagnosis.findings) {
      const tally = tallyOf(finding.evidence.provider, finding.evidence.model);
      tally.runs.add(diagnosis.runId);
      if (finding.role === "terminal") tally.failedRuns.add(diagnosis.runId);
      const causeKey = `${finding.role}:${finding.cause}`;
      const entry = tally.causes.get(causeKey) ?? {
        cause: {
          ownerClass: finding.ownerClass,
          cause: finding.cause,
          role: finding.role,
          runs: 0,
          steps: [],
        },
        runs: new Set<string>(),
        steps: new Set<string>(),
      };
      entry.runs.add(diagnosis.runId);
      if (finding.stepId !== null) entry.steps.add(finding.stepId);
      tally.causes.set(causeKey, entry);
    }
  }
  return [...tallies.values()]
    .map((tally) => ({
      provider: tally.provider,
      model: tally.model,
      runs: tally.runs.size,
      failedRuns: tally.failedRuns.size,
      causes: [...tally.causes.values()]
        .map((entry) => ({
          ...entry.cause,
          runs: entry.runs.size,
          steps: [...entry.steps].sort(),
        }))
        .sort(
          (left, right) =>
            (left.role === right.role ? 0 : left.role === "terminal" ? -1 : 1) ||
            right.runs - left.runs ||
            left.cause.localeCompare(right.cause),
        ),
    }))
    .sort(
      (left, right) =>
        compareNullable(left.provider, right.provider) || compareNullable(left.model, right.model),
    );
}

interface StepGroup {
  readonly stepIndex: number;
  readonly stepId: string | null;
  readonly status: string | null;
  readonly rows: RunIndexRowV1[];
}

function groupSteps(runRows: readonly RunIndexRowV1[]): StepGroup[] {
  const groups = new Map<number, StepGroup>();
  for (const row of runRows) {
    if (row.rowKind === "run" || row.stepIndex === null) continue;
    const group = groups.get(row.stepIndex) ?? {
      stepIndex: row.stepIndex,
      stepId: row.stepId,
      status: row.stepStatus,
      rows: [],
    };
    group.rows.push(row);
    groups.set(row.stepIndex, group);
  }
  return [...groups.values()].sort((left, right) => left.stepIndex - right.stepIndex);
}

function isSucceededRow(row: RunIndexRowV1): boolean {
  return row.outcome === "succeeded";
}

/** Only status and verified index fields can explain a gate; no raw question is read. */
function recordedStop(
  runRow: RunIndexRowV1,
  steps: readonly StepGroup[],
  showCommand: string,
  savedRunLocationKnown: boolean,
): DiagnosisStopV1 | null {
  const status = runRow.runStatus;
  if (status !== "needs-input" && status !== "needs-human-decision") return null;
  const terminalStatuses = new Set(["failed", "needs-input", "needs-human-decision"]);
  const terminalSteps = steps.filter((step) => terminalStatuses.has(step.status ?? ""));
  const matching = terminalSteps.filter((step) => step.status === status);
  const admissionConflictsWithSteps = steps.length > 0 && runRow.intentAdmission === "question";
  const coherent =
    terminalSteps.length === 1 &&
    matching.length === 1 &&
    matching[0]!.stepId !== null &&
    !admissionConflictsWithSteps &&
    (runRow.terminalStepId === null || runRow.terminalStepId === matching[0]!.stepId);
  const selected = coherent ? matching[0]! : null;
  const noStep = steps.length === 0 && runRow.terminalStepId === null;
  const admission =
    status === "needs-input" && noStep && runRow.intentAdmission === "question"
      ? "question"
      : "unknown";
  const limitations: DiagnosisStopV1["limitations"][number][] = ["stop-detail-unavailable"];
  if (selected === null && !noStep) {
    limitations.push(terminalSteps.length > 1 ? "stop-step-ambiguous" : "stop-step-inconsistent");
  } else if (noStep) {
    limitations.push("stop-step-unavailable");
  }
  if (status === "needs-input" && noStep && admission === "unknown") {
    limitations.push("stop-admission-unavailable");
  }
  if (!savedRunLocationKnown) limitations.push("stop-saved-location-unavailable");
  const explanation =
    status === "needs-input"
      ? admission === "question"
        ? "The recorded request interpretation asked for input before any step ran. The index does not contain the exact question."
        : "The run recorded a needs-input stop. The index does not contain the exact requested input."
      : "The run recorded a needs-human-decision stop. The index does not contain the exact decision.";
  return {
    status,
    stepId: selected?.stepId ?? null,
    stepIndex: selected?.stepIndex ?? null,
    admission,
    explanation,
    nextAction: savedRunLocationKnown
      ? "Inspect the saved run for retained context before deciding what input or decision is needed."
      : "Identify the saved run's state directory from run provenance before inspecting retained context; the selected index does not establish that location.",
    nextCommand: savedRunLocationKnown ? showCommand : null,
    limitations,
  };
}

function readRow(
  row: RunIndexRowV1,
  commands: CauseCommands,
  options: DiagnoseRunOptions,
): CauseReading {
  return row.rowKind === "attempt"
    ? classifyAttemptRow(row, commands)
    : classifyRecordedFailure(row, commands);
}

function verdictOf(status: string): RunDiagnosisV1["verdict"] {
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  return "incomplete";
}

function buildFinding(input: {
  readonly role: DiagnosisFindingV1["role"];
  readonly rows: readonly RunIndexRowV1[];
  readonly step: StepGroup | null;
  readonly reading: CauseReading;
  readonly runRow: RunIndexRowV1;
  readonly options: DiagnoseRunOptions;
}): DiagnosisFindingV1 {
  const { role, rows, step, reading, runRow, options } = input;
  const row = rows[rows.length - 1]!;
  const attempts = rows
    .map((candidate) => candidate.attempt)
    .filter((attempt): attempt is number => attempt !== null);
  const stepAttempts = step
    ? step.rows.filter((candidate) => candidate.rowKind === "attempt").length
    : 0;
  const signature: Record<string, string> = { ...reading.signature };
  // Without a provider or model, "the same model" would pool unrelated runs.
  const modelKnown = row.provider !== null || row.model !== null;
  const recurrence =
    role === "terminal" && options.population !== null && modelKnown
      ? recurrenceOf(row, signature, runRow, options.population, options)
      : null;
  return {
    role,
    stepId: row.stepId,
    stepIndex: row.stepIndex,
    attempts,
    stepAttempts,
    recovered: role === "contributing" ? recoveredAfter(step, attempts) : null,
    stepSucceeded: step === null ? null : step.status === "succeeded",
    ownerClass: reading.ownerClass,
    cause: reading.cause,
    what: whatOf(row, attempts, stepAttempts),
    why: reading.why,
    nextAction: reading.nextAction,
    nextCommand: reading.nextCommand,
    evidence: evidenceOf(row),
    signature,
    reproduce: reproduceCommand(row, options.location),
    recurrence,
    alsoCause: reading.alsoCause,
    limitations: [
      ...reading.limitations,
      ...(role === "terminal" && options.population === null ? ["recurrence-index-unread"] : []),
      ...(role === "terminal" && options.population !== null && !modelKnown
        ? ["recurrence-model-unavailable"]
        : []),
    ],
  };
}

/**
 * A contributing failure was recovered from when its step succeeded, or when a
 * later attempt of the step succeeded even though the step then ended on a
 * cause of its own.
 */
function recoveredAfter(step: StepGroup | null, attempts: readonly number[]): boolean {
  if (step === null) return false;
  if (step.status === "succeeded") return true;
  const last = Math.max(...attempts);
  return step.rows.some(
    (row) =>
      row.rowKind === "attempt" &&
      row.attempt !== null &&
      row.attempt > last &&
      row.outcome === "succeeded",
  );
}

function whatOf(row: RunIndexRowV1, attempts: readonly number[], stepAttempts: number): string {
  const step = row.stepId ?? RUN_INDEX_UNAVAILABLE;
  const rejection =
    row.rejectionCode === null
      ? ""
      : `, rejected by ${row.rejectionCode}${row.rejectionLocation === null ? "" : ` at ${row.rejectionLocation}`}`;
  if (row.rowKind === "run") {
    return `Run ${row.runId} ended ${row.runStatus} with no failing step recorded in the index.`;
  }
  if (row.rowKind === "step") {
    if (row.rejectionSource === "quality-validation") {
      return `Step ${step} failed quality validation${rejection}.`;
    }
    // A step row beside attempt rows is a step that ended after its final
    // attempt succeeded, so the failure is the step's own.
    return stepAttempts > 0
      ? `Step ${step} ended ${row.outcome} after its final attempt succeeded, with failure code ${row.failureCode ?? RUN_INDEX_UNAVAILABLE}.`
      : `Step ${step} failed without a recorded inference attempt${rejection}.`;
  }
  const label =
    attempts.length > 1
      ? `attempts ${attempts.join(", ")} of ${String(stepAttempts)}`
      : `attempt ${String(attempts[0] ?? RUN_INDEX_UNAVAILABLE)} of ${String(stepAttempts)}`;
  return `Step ${step} ${label}: ${row.outcome}${rejection}${rejectionSubjectClause(row)}${answerPathClause(row)}${answerRecordProgressClause(row)}.`;
}

function answerRecordProgressClause(row: RunIndexRowV1): string {
  const progress = answerRecordProgressOf(row);
  if (progress === null) return "";
  return ` (answer-record ledger: ${String(progress.admittedRowCount)} admitted, ${String(progress.releasedRowCount)} released, ${String(progress.remainingKeyCount)} required keys remaining, ${String(progress.refusalEventCount)} refusal events; ledger complete ${String(progress.complete)} at checkpoint ${String(progress.checkpointSequence)} for logical run ${progress.logicalRunId} from source run ${progress.sourceRunId} through source attempt ${String(progress.sourceAttemptHighWater)})`;
}

function answerRecordProgressOf(row: RunIndexRowV1): DiagnosisEvidenceV1["answerRecordProgress"] {
  if (
    row.answerRecordAdmittedRowCount === null ||
    row.answerRecordReleasedRowCount === null ||
    row.answerRecordRemainingKeyCount === null ||
    row.answerRecordRefusalEventCount === null ||
    row.answerRecordComplete === null ||
    row.answerRecordCheckpointSequence === null ||
    row.answerRecordLogicalRunId === null ||
    row.answerRecordSourceRunId === null ||
    row.answerRecordSourceAttemptHighWater === null
  ) {
    return null;
  }
  return {
    admittedRowCount: row.answerRecordAdmittedRowCount,
    releasedRowCount: row.answerRecordReleasedRowCount,
    remainingKeyCount: row.answerRecordRemainingKeyCount,
    refusalEventCount: row.answerRecordRefusalEventCount,
    complete: row.answerRecordComplete,
    checkpointSequence: row.answerRecordCheckpointSequence,
    logicalRunId: row.answerRecordLogicalRunId,
    sourceRunId: row.answerRecordSourceRunId,
    sourceAttemptHighWater: row.answerRecordSourceAttemptHighWater,
  };
}

/**
 * How the final quality evaluator's answer reached the host, from the
 * attempt row: the path and why, and on the tool path how far the submission
 * and the report got. An operator override is named as operator
 * configuration. Empty for a row that records no answer path.
 */
function answerPathClause(row: RunIndexRowV1): string {
  if (row.answerPath === null) return "";
  const reason =
    row.answerPathReason === "operator-override"
      ? "set by operator configuration DOCSFAB_ANSWER_SUBMISSION=text-final"
      : (row.answerPathReason ?? RUN_INDEX_UNAVAILABLE);
  const states =
    row.answerPath === "tool-call"
      ? `; submission ${row.answerSubmission ?? RUN_INDEX_UNAVAILABLE}, report ${row.answerReportTurn ?? RUN_INDEX_UNAVAILABLE}`
      : "";
  return ` (answer path ${row.answerPath}, ${reason}${states})`;
}

/**
 * What the refused rule refused, from the attempt row alone: the citation's
 * path, or the pages the writer declared changed against the pages it changed.
 */
function rejectionSubjectClause(row: RunIndexRowV1): string {
  if (row.rejectedSourcePath !== null) {
    return `; the refused citation named ${row.rejectedSourcePath}`;
  }
  if (row.declaredChangedPaths !== null && row.observedChangedPaths !== null) {
    return `; the writer declared ${row.declaredChangedPaths} changed, and the host observed ${row.observedChangedPaths} changed`;
  }
  if (row.rejectionSubjectWithheld === "not-host-known") {
    return "; the refused citation named a path the host does not know, so the record does not name it";
  }
  if (row.rejectionSubjectWithheld === "over-bound") {
    return "; what it refused is longer than the record retains (see docsfab runs show)";
  }
  return "";
}

function rejectionSubjectOf(row: RunIndexRowV1): DiagnosisEvidenceV1["rejectionSubject"] {
  return row.rejectedSourcePath === null &&
    row.declaredChangedPaths === null &&
    row.observedChangedPaths === null &&
    row.rejectionSubjectWithheld === null
    ? null
    : {
        sourcePath: row.rejectedSourcePath,
        declaredChangedPaths: row.declaredChangedPaths,
        observedChangedPaths: row.observedChangedPaths,
        withheld: row.rejectionSubjectWithheld,
      };
}

function evidenceOf(row: RunIndexRowV1): DiagnosisEvidenceV1 {
  return {
    rowKind: row.rowKind,
    provider: row.provider,
    model: row.model,
    outcome: row.outcome,
    failureClass: row.failureClass,
    failureLayer: row.failureLayer,
    rejectionSource: row.rejectionSource,
    rejectionCode: row.rejectionCode,
    rejectionLocation: row.rejectionLocation,
    rejectedReplyParseCode: row.rejectedReplyParseCode,
    finishReason: row.finishReason,
    outputTokens: row.outputTokens,
    outputAllowance: row.outputAllowance,
    providerErrorClass: row.providerErrorClass,
    httpStatus: row.httpStatus,
    streamErrorStatus: streamErrorStatusOf(row),
    conditionRetryability: row.conditionRetryability,
    retryDecision: row.retryDecision,
    attemptTotals: attemptOutputTotalsOf(row),
    rejectionSubject: rejectionSubjectOf(row),
    answerRecordProgress: answerRecordProgressOf(row),
  };
}

const ATTEMPT_EVIDENCE_GROUP_BY: readonly RunIndexQueryField[] = [
  "attempt",
  "outcome",
  "rejectionCode",
  "rejectedReplyParseCode",
  "finishReason",
  "outputTokens",
  "outputAllowance",
  "providerErrorClass",
  "httpStatus",
  "answerRecordAdmittedRowCount",
  "answerRecordReleasedRowCount",
  "answerRecordRemainingKeyCount",
  "answerRecordRefusalEventCount",
  "answerRecordComplete",
  "answerRecordCheckpointSequence",
  "answerRecordLogicalRunId",
  "answerRecordSourceRunId",
  "answerRecordSourceAttemptHighWater",
];
const STEP_EVIDENCE_GROUP_BY: readonly RunIndexQueryField[] = [
  "outcome",
  "rejectionSource",
  "rejectionCode",
  "rejectionLocation",
  "failureClass",
  "failureLayer",
];
const RUN_EVIDENCE_GROUP_BY: readonly RunIndexQueryField[] = [
  "runStatus",
  "failureClass",
  "failureLayer",
];

/** Every row of the run at this step, grouped by the fields the finding cites. */
function reproduceCommand(row: RunIndexRowV1, location: DiagnosisLocation): string {
  const clauses: [string, string][] = [["runId", row.runId]];
  if (row.rowKind !== "attempt") clauses.unshift(["rowKind", row.rowKind]);
  if (row.stepId !== null && row.rowKind !== "run") clauses.push(["stepId", row.stepId]);
  const groupBy =
    row.rowKind === "attempt"
      ? ATTEMPT_EVIDENCE_GROUP_BY
      : row.rowKind === "step"
        ? STEP_EVIDENCE_GROUP_BY
        : RUN_EVIDENCE_GROUP_BY;
  return runsQueryCommand(location, clauses, { groupBy });
}

/**
 * Recurrence within the newest `lookbackRuns` runs of the finding's provider
 * and model, up to and including this run. First seen reads the whole index.
 */
function recurrenceOf(
  row: RunIndexRowV1,
  signature: Readonly<Record<string, string>>,
  runRow: RunIndexRowV1,
  population: readonly RunIndexRowV1[],
  options: DiagnoseRunOptions,
): DiagnosisRecurrenceV1 {
  const scope: [string, string][] = [];
  if (row.rowKind !== "attempt") scope.push(["rowKind", row.rowKind]);
  scope.push(["provider", row.provider ?? RUN_INDEX_UNAVAILABLE]);
  scope.push(["model", row.model ?? RUN_INDEX_UNAVAILABLE]);
  const matching: [string, string][] = [...scope];
  if (row.stepId !== null && row.rowKind !== "run") matching.push(["stepId", row.stepId]);
  for (const [field, value] of Object.entries(signature)) {
    if (field !== "rowKind") matching.push([field, value]);
  }
  const created = new Map<string, number>();
  const revision = new Map<string, string | null>();
  for (const candidate of newestSnapshots(completeSnapshots(population).rows)) {
    if (!created.has(candidate.runId)) {
      created.set(candidate.runId, Date.parse(candidate.runCreatedAt));
      revision.set(candidate.runId, candidate.docsfabRevision);
    }
  }
  const target = Date.parse(runRow.runCreatedAt);
  const scopeRuns = runIdsOf(population, scope, {});
  const eligible = scopeRuns
    .filter((runId) => (created.get(runId) ?? Number.NaN) <= target)
    .sort((left, right) => (created.get(right) ?? 0) - (created.get(left) ?? 0));
  const window = eligible.slice(0, options.lookbackRuns);
  const clipped = eligible.length > window.length;
  const newer = scopeRuns.some((runId) => (created.get(runId) ?? Number.NaN) > target);
  const bounds = {
    ...(clipped && window.length > 0
      ? { sinceMs: Math.min(...window.map((runId) => created.get(runId) ?? target)) }
      : {}),
    ...(newer && !Number.isNaN(target) ? { untilMs: target + 1 } : {}),
  };
  const matchingRuns = runIdsOf(population, matching, bounds);
  const denominatorRuns = runIdsOf(population, scope, bounds);
  const everMatching = runIdsOf(population, matching, {});
  const first = everMatching
    .filter((runId) => !Number.isNaN(created.get(runId) ?? Number.NaN))
    .sort((left, right) => (created.get(left) ?? 0) - (created.get(right) ?? 0))[0];
  return {
    runs: matchingRuns.length,
    ofRuns: denominatorRuns.length,
    lookbackRuns: options.lookbackRuns,
    clipped,
    firstSeen:
      first === undefined
        ? null
        : {
            runId: first,
            runCreatedAt: new Date(created.get(first) ?? 0).toISOString(),
            docsfabRevision: revision.get(first) ?? null,
          },
    query: runsQueryCommand(options.location, matching, { ...bounds, groupBy: ["runId"] }),
    denominatorQuery: runsQueryCommand(options.location, scope, bounds),
  };
}

function runIdsOf(
  population: readonly RunIndexRowV1[],
  clauses: readonly (readonly [string, string])[],
  bounds: { readonly sinceMs?: number; readonly untilMs?: number },
): string[] {
  const result = queryRunIndex(population, {
    where: whereOf(clauses),
    groupBy: ["runId"],
    ...bounds,
  });
  return result.groups.map((group) => String(group.key.runId));
}

function whereOf(
  clauses: readonly (readonly [string, string])[],
): Map<RunIndexQueryField, readonly string[]> {
  const where = new Map<RunIndexQueryField, string[]>();
  for (const [field, value] of clauses) {
    if (!isRunIndexQueryField(field)) {
      throw new TypeError(`Diagnosis clause field ${field} is not a run index query field.`);
    }
    where.set(field, [...(where.get(field) ?? []), value]);
  }
  return where;
}

/** The import command that adds a state directory's records to the index `why` reads. */
export function runsImportCommand(stateDirectory: string): string {
  const directory = shellArgument(stateDirectory);
  return `docsfab runs import ${directory} --state-dir ${directory}`;
}

/** A `docsfab runs query` command with the same meaning as the `where` it prints. */
export function runsQueryCommand(
  location: DiagnosisLocation,
  clauses: readonly (readonly [string, string])[],
  options: {
    readonly sinceMs?: number;
    readonly untilMs?: number;
    readonly groupBy?: readonly string[];
  } = {},
): string {
  const parts = [`docsfab runs query${location.indexArgs}`];
  for (const [field, value] of clauses) parts.push(`--where ${shellArgument(`${field}=${value}`)}`);
  if (options.sinceMs !== undefined) {
    parts.push(`--since ${new Date(options.sinceMs).toISOString()}`);
  }
  if (options.untilMs !== undefined) {
    parts.push(`--until ${new Date(options.untilMs).toISOString()}`);
  }
  if (options.groupBy && options.groupBy.length > 0) {
    parts.push(`--group-by ${options.groupBy.join(",")}`);
  }
  return parts.join(" ");
}

function runModelIdentity(
  runRows: readonly RunIndexRowV1[],
  findings: readonly DiagnosisFindingV1[],
): { provider: string | null; model: string | null } {
  const runRow = runRows.find((row) => row.rowKind === "run");
  if (runRow && runRow.model !== null) return { provider: runRow.provider, model: runRow.model };
  const terminal = findings.find((finding) => finding.evidence.model !== null);
  if (terminal) return { provider: terminal.evidence.provider, model: terminal.evidence.model };
  const attempt = runRows.find((row) => row.rowKind !== "run" && row.model !== null);
  return attempt
    ? { provider: attempt.provider, model: attempt.model }
    : { provider: null, model: null };
}

function summarize(
  runId: string,
  verdict: RunDiagnosisV1["verdict"],
  terminal: readonly DiagnosisFindingV1[],
  contributing: readonly DiagnosisFindingV1[],
  runRow: Pick<RunIndexRowV1, "sourceEvidence">,
  stop: DiagnosisStopV1 | null,
): string {
  if (verdict === "succeeded") {
    const ended =
      contributing.length === 0
        ? `Run ${runId} succeeded; it recorded no failed attempt.`
        : `Run ${runId} succeeded after ${String(contributing.reduce((sum, finding) => sum + finding.attempts.length, 0))} failed attempts it recovered from.`;
    // A review whose ledger kept no source evidence is not a clean success.
    return runRow.sourceEvidence === "none"
      ? `${ended} Its source evidence is degraded: every technical dimension is unverified, so no step verified a claim against admitted source.`
      : ended;
  }
  if (stop !== null) {
    const location = stop.stepId === null ? "the run" : `step ${stop.stepId}`;
    return `Run ${runId} stopped at ${location}: ${stop.status}. The exact requested ${stop.status === "needs-input" ? "input" : "decision"} is unavailable in the index.`;
  }
  if (terminal.length === 0) {
    return `Run ${runId} stopped as ${verdict} without a failing step or class in the index; docsfab runs show names what it needs.`;
  }
  const causes = terminal.map(
    (finding) =>
      `${finding.stepId === null ? "the run" : `step ${finding.stepId}`}: ${DIAGNOSIS_OWNER_LABELS[finding.ownerClass]} (${finding.cause})`,
  );
  return `Run ${runId} ${verdict === "failed" ? "failed" : "stopped"} at ${causes.join("; ")}.`;
}

function compareNullable(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left.localeCompare(right);
}

export function shellArgument(value: string): string {
  return /^[A-Za-z0-9_.\-/:@=,]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
