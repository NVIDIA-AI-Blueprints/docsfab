// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Human text for a diagnosis. Each claim line is followed by the
 * `docsfab runs query` command that reproduces it.
 */
import { dirname } from "node:path";
import { escapePathText } from "../contract-kit/index.js";
import { redactConfiguredCredentials } from "../security/configured-credentials.js";
import { redactCredentialMaterial } from "../security/credential-material.js";

import { RUN_INDEX_UNAVAILABLE } from "../records/run-index-query.js";
import {
  DIAGNOSIS_LIMITS,
  DIAGNOSIS_OWNER_LABELS,
  DIAGNOSIS_OWNER_MEANINGS,
  type DiagnosisCause,
  type DiagnosisEvidenceV1,
  type DiagnosisFindingV1,
  type RunDiagnosisV1,
  type WhyReportV1,
} from "./contracts.js";
import {
  runsImportCommand,
  runsQueryCommand,
  shellArgument,
  type DiagnosisLocation,
} from "./engine.js";

/** Causes whose evidence is the model's reply, so a retained excerpt helps. */
const REPLY_CAUSES: ReadonlySet<DiagnosisCause> = new Set([
  "reply-not-json",
  "reply-shape-rejected",
  "reply-content-rejected",
  "reply-cut-over-allowance",
  "reply-continued-over-allowance",
  "output-allowance-reached",
]);

const ATTEMPT_EVIDENCE_FIELDS = [
  "outcome",
  "rejectionCode",
  "rejectedReplyParseCode",
  "finishReason",
  "outputTokens",
  "outputAllowance",
  "providerErrorClass",
  "httpStatus",
  "retryDecision",
] as const satisfies readonly (keyof DiagnosisEvidenceV1)[];
const RECORDED_EVIDENCE_FIELDS = [
  "outcome",
  "failureClass",
  "failureLayer",
  "rejectionSource",
  "rejectionCode",
] as const satisfies readonly (keyof DiagnosisEvidenceV1)[];

const LIMITATION_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  "stream-error-status-not-indexed":
    "The run index carries no in-stream provider status for this attempt; docsfab runs show prints it when the record kept one.",
  "recurrence-index-unread":
    "The run index could not be read, so recurrence across runs is not reported.",
  "recurrence-model-unavailable":
    "The attempt recorded no provider or model, so recurrence is not reported; it would pool unrelated runs.",
  "execution-ceiling-source-not-indexed":
    "The run index row does not say what set the execution ceiling (an earlier DocsFab indexed it), so the model's progress and an operator override are both named with their next actions.",
  "execution-ceiling-limits-not-recorded":
    "The run record does not carry the run host's configured provider-turn limit and the composition's sealed budgets, so the model's progress and an operator override are both named with their next actions.",
  "execution-ceiling-codes-mismatch":
    "The recorded ceiling code names a ceiling the stopped attempt's turn, lease, and recorded limits do not explain, so the model's progress and an operator override are both named with their next actions.",
  "answer-asked-early":
    "The host withdrew the tools and asked this attempt for its answer before the model finished reading, so the answer came from partial reading; the index row's concludeNow names why, and docsfab runs show lists it under LIMITATIONS.",
  "attempt-output-total-not-recorded":
    "The run index row carries no total output tokens and continuations for this attempt (an earlier DocsFab indexed it and its saved record was not read, or the turn ledger could not give them: none kept, unreadable, written before turns named their stop, or crossing a compaction), so both owners are named with their next actions.",
});

/** Body lines of one run's diagnosis, without a section header. */
export function formatRunDiagnosisLines(
  diagnosis: RunDiagnosisV1,
  options: {
    readonly location: DiagnosisLocation;
    /**
     * The block ends the run's own `docsfab runs show` output, so lines that
     * send the reader to that same output are left out.
     */
    readonly inRunOutput?: boolean;
  },
): string[] {
  const lines = [diagnosis.summary];
  const identity = `${diagnosis.provider ?? RUN_INDEX_UNAVAILABLE} ${diagnosis.model ?? RUN_INDEX_UNAVAILABLE}`;
  lines.push(
    `Model: ${identity}; workflow ${diagnosis.workflow}; created ${diagnosis.runCreatedAt}.`,
  );
  if (diagnosis.stop) {
    const stop = diagnosis.stop;
    lines.push(
      `Stop: ${stop.status}${stop.stepId === null ? "" : ` at step ${stop.stepId}`}; admission ${stop.admission}.`,
    );
    lines.push(`Why: ${stop.explanation}`);
    lines.push(`Next: ${stop.nextAction}`);
    if (
      stop.nextCommand !== null &&
      !(options.inRunOutput && stop.nextCommand === diagnosis.showCommand)
    ) {
      lines.push(`  Command: ${stop.nextCommand}`);
    }
    for (const limitation of stop.limitations) lines.push(`Limitation: ${limitation}.`);
  }
  if (diagnosis.planConversion) {
    lines.push(
      diagnosis.planConversion === "planner-proposed-update"
        ? `Plan: the planner proposed an UPDATE of a page that already existed, and the host admitted it as the CREATE-to-UPDATE conversion of that page, reason ${diagnosis.planConversion}; docsfab runs show names the page.`
        : `Plan: the host converted the CREATE of a page that already existed into an UPDATE of that page, reason ${diagnosis.planConversion}; docsfab runs show names the page.`,
    );
  }
  if (diagnosis.sourceEvidence === "partial" || diagnosis.sourceEvidence === "none") {
    const count = diagnosis.unverifiedDimensions ?? RUN_INDEX_UNAVAILABLE;
    lines.push(
      `Source evidence: ${String(count)} technical dimension(s) of the source-obligation ledger are unverified${diagnosis.sourceEvidence === "none" ? ", every one of them" : ""}; docsfab runs show names each dimension's reason, including any locator the host removed.`,
    );
  }
  if (diagnosis.workflow === "readiness") {
    lines.push(
      `Readiness: ${diagnosis.readinessDisposition ?? RUN_INDEX_UNAVAILABLE}; criterion reasons ${diagnosis.readinessReasonCodes ?? RUN_INDEX_UNAVAILABLE}.`,
    );
  }
  if (diagnosis.sourceProposalOutcomes && diagnosis.sourceProposalOutcomes.length > 0) {
    lines.push("Source proposals:");
    for (const proposal of diagnosis.sourceProposalOutcomes) {
      const path = redactCredentialMaterial(escapePathText(proposal.path));
      lines.push(
        `  Attempt ${proposal.attempt}: ${proposal.status} ${path}${proposal.refusalCode ? ` (${proposal.refusalCode})` : ""}.`,
      );
    }
  } else if (diagnosis.sourceProposalOutcomesOmitted === true) {
    lines.push(
      "Source proposals: the run index did not retain a validated projection for this field.",
    );
  }
  const terminal = diagnosis.findings.filter((finding) => finding.role === "terminal");
  const contributing = diagnosis.findings.filter((finding) => finding.role === "contributing");
  for (const finding of terminal) {
    lines.push(...formatTerminalFinding(diagnosis, finding, options.inRunOutput === true));
  }
  for (const finding of contributing) {
    const label = DIAGNOSIS_OWNER_LABELS[finding.ownerClass];
    const attempts =
      finding.attempts.length > 1
        ? `attempts ${finding.attempts.join(", ")}`
        : `attempt ${String(finding.attempts[0] ?? RUN_INDEX_UNAVAILABLE)}`;
    const endedLater = terminal.some((candidate) => candidate.stepId === finding.stepId);
    const status =
      finding.recovered !== true
        ? "the step did not recover from it"
        : endedLater
          ? "a later attempt succeeded, but the step then ended on the cause above"
          : finding.stepSucceeded === true
            ? "the step later succeeded"
            : diagnosis.stop
              ? "a later attempt succeeded, but the run then stopped"
              : "the step later succeeded";
    // A cause the terminal finding already explains is not explained twice.
    const why = terminal.some((candidate) => candidate.cause === finding.cause)
      ? ""
      : ` ${finding.why}`;
    // An earlier answer from partial reading is named even when it recovered.
    const askedEarly = finding.limitations.includes("answer-asked-early")
      ? " The host had asked it to answer before it finished reading (answer-asked-early)."
      : "";
    lines.push(
      `Also: step ${finding.stepId ?? RUN_INDEX_UNAVAILABLE} ${attempts}: ${label} (${finding.cause}); ${status}.${why}${askedEarly}`,
    );
  }
  if (contributing.length > 0) {
    lines.push(
      `  Query: ${runsQueryCommand(options.location, [["runId", diagnosis.runId]], {
        groupBy: [
          "stepId",
          "attempt",
          "outcome",
          "rejectionCode",
          "rejectedReplyParseCode",
          "finishReason",
          "outputTokens",
          "outputAllowance",
          "providerErrorClass",
          "httpStatus",
        ],
      })}`,
    );
  }
  if (diagnosis.source === "record" && diagnosis.verdict !== "succeeded") {
    lines.push("Source: this run's saved record, projected the way the run index stores it.");
  }
  lines.push(`Full answer: ${diagnosis.whyCommand} (add --json for the docsfab-why envelope)`);
  // A line names the model and repeats it in queries; DocsFab's own
  // configured credentials never show, whatever field held one (#1807).
  return lines.map(redactConfiguredCredentials);
}

function formatTerminalFinding(
  diagnosis: RunDiagnosisV1,
  finding: DiagnosisFindingV1,
  inRunOutput: boolean,
): string[] {
  const lines = [
    `What: ${finding.what}`,
    `Why: ${finding.why}`,
    `Owner: ${DIAGNOSIS_OWNER_LABELS[finding.ownerClass]}. ${DIAGNOSIS_OWNER_MEANINGS[finding.ownerClass]}`,
    `Next: ${finding.nextAction}`,
  ];
  if (
    finding.nextCommand !== null &&
    !(inRunOutput && finding.nextCommand === diagnosis.showCommand)
  ) {
    lines.push(`  Command: ${finding.nextCommand}`);
  }
  const also = finding.alsoCause;
  if (also) {
    lines.push(
      `Also owner: ${DIAGNOSIS_OWNER_LABELS[also.ownerClass]} (${also.cause}). ${also.why}`,
      `Also next: ${also.nextAction}`,
    );
    if (also.nextCommand !== null && also.nextCommand !== finding.nextCommand) {
      lines.push(`  Command: ${also.nextCommand}`);
    }
  }
  lines.push(`Evidence: ${formatEvidence(finding.evidence)}`);
  lines.push(`  Query: ${finding.reproduce}`);
  const recurrence = finding.recurrence;
  if (recurrence) {
    const scope = `${finding.evidence.provider ?? RUN_INDEX_UNAVAILABLE} ${finding.evidence.model ?? RUN_INDEX_UNAVAILABLE}`;
    const where = finding.stepId === null ? "" : ` at ${finding.stepId}`;
    const window = recurrence.clipped
      ? ` (the newest ${String(recurrence.lookbackRuns)} by ${DIAGNOSIS_LIMITS.recurrenceLookbackRuns}; older runs are not counted)`
      : "";
    const first = recurrence.firstSeen
      ? `; first seen ${recurrence.firstSeen.runCreatedAt} in run ${recurrence.firstSeen.runId}, DocsFab revision ${recurrence.firstSeen.docsfabRevision ?? RUN_INDEX_UNAVAILABLE}`
      : "";
    lines.push(
      `Recurrence: ${String(recurrence.runs)} of the ${String(recurrence.ofRuns)} most recent ${recurrence.ofRuns === 1 ? "run" : "runs"} of ${scope}${window} had this signature${where}${first}.`,
    );
    lines.push(`  Query: ${recurrence.query}`);
    lines.push(`  Of: ${recurrence.denominatorQuery}`);
  }
  if (!inRunOutput && REPLY_CAUSES.has(finding.cause)) {
    lines.push(
      `Reply: ${diagnosis.showCommand} prints the rejected reply's retained excerpt when the record kept one.`,
    );
  }
  for (const code of finding.limitations) {
    lines.push(`Limitation: ${code}: ${LIMITATION_SENTENCES[code] ?? "See docsfab why --json."}`);
  }
  return lines;
}

function formatEvidence(evidence: DiagnosisEvidenceV1): string {
  const fields =
    evidence.rowKind === "attempt" ? ATTEMPT_EVIDENCE_FIELDS : RECORDED_EVIDENCE_FIELDS;
  const pairs = fields.map(
    (field) =>
      `${field}=${evidence[field] === null ? RUN_INDEX_UNAVAILABLE : String(evidence[field])}`,
  );
  if (evidence.streamErrorStatus !== null) {
    pairs.push(`streamErrorStatus=${String(evidence.streamErrorStatus)}`);
  }
  if (evidence.rejectionLocation !== null) {
    pairs.push(`rejectionLocation=${evidence.rejectionLocation}`);
  }
  const subject = evidence.rejectionSubject;
  if (subject) {
    if (subject.sourcePath !== null) pairs.push(`rejectedSourcePath=${subject.sourcePath}`);
    if (subject.declaredChangedPaths !== null) {
      pairs.push(`declaredChangedPaths=${subject.declaredChangedPaths}`);
    }
    if (subject.observedChangedPaths !== null) {
      pairs.push(`observedChangedPaths=${subject.observedChangedPaths}`);
    }
    if (subject.withheld !== null) pairs.push(`rejectionSubjectWithheld=${subject.withheld}`);
  }
  const totals = evidence.attemptTotals;
  if (totals) {
    pairs.push(
      `attemptOutputTokens=${totals.outputTokens ?? RUN_INDEX_UNAVAILABLE}`,
      `continuations=${totals.continuations ?? RUN_INDEX_UNAVAILABLE}`,
    );
  }
  return pairs.join(" ");
}

/** The whole `docsfab why` human answer. */
export function formatWhyReport(report: WhyReportV1, location: DiagnosisLocation): string[] {
  const lines: string[] = [];
  const single = report.diagnoses.length === 1 && report.selection.mode !== "all";
  lines.push(`WHY  ${report.index.path}`);
  const selection = [
    `mode=${report.selection.mode}`,
    ...(report.selection.runId !== null ? [`run=${report.selection.runId}`] : []),
    ...(report.selection.batchId !== null ? [`batch=${report.selection.batchId}`] : []),
    ...(report.selection.model !== null ? [`model=${report.selection.model}`] : []),
  ];
  lines.push(
    `Selection: ${selection.join(" ")}; diagnosed ${String(report.runs.diagnosed)} of ${String(report.runs.matched)} matching runs.`,
  );
  if (report.runs.clipped) {
    lines.push(
      `Clipped: the newest ${String(report.runs.diagnosed)} of ${String(report.runs.matched)} runs were diagnosed (${report.runs.limit.name} = ${String(report.runs.limit.value)}). Narrow the selection with a run ID, --batch, or --model, or raise ${report.runs.limit.name}.`,
    );
  }
  lines.push(...formatIndexNotes(report));
  for (const diagnosis of report.diagnoses) {
    lines.push("");
    lines.push(
      single
        ? "DIAGNOSIS"
        : `RUN ${diagnosis.runId}  ${diagnosis.workflow}  ${diagnosis.runStatus}`,
    );
    lines.push(...formatRunDiagnosisLines(diagnosis, { location }).map((line) => `  ${line}`));
  }
  if (!single && report.byModel.length > 0) {
    lines.push("");
    lines.push("BY MODEL");
    for (const summary of report.byModel) {
      lines.push(
        `  ${summary.provider ?? RUN_INDEX_UNAVAILABLE} ${summary.model ?? RUN_INDEX_UNAVAILABLE}: ${runs(summary.runs)}; ${String(summary.failedRuns)} ended by a failure on this model`,
      );
      for (const cause of summary.causes) {
        const role = cause.role === "terminal" ? "ended by" : "earlier";
        lines.push(
          `    ${role} ${DIAGNOSIS_OWNER_LABELS[cause.ownerClass]} (${cause.cause}) in ${runs(cause.runs)}${cause.steps.length > 0 ? ` at ${cause.steps.join(", ")}` : ""}`,
        );
      }
    }
    lines.push(
      `  Query: ${runsQueryCommand(location, [], { groupBy: ["provider", "model", "stepId", "outcome", "rejectionCode"] })}`,
    );
  }
  return lines;
}

function runs(count: number): string {
  return `${String(count)} ${count === 1 ? "run" : "runs"}`;
}

function runsWere(count: string | undefined): string {
  return count === "1" ? "1 run was" : `${count ?? "some"} runs were`;
}

/** The import that re-indexes the runs this answer read; the state directory when known. */
function reindexCommand(report: WhyReportV1): string {
  return report.index.stateDirectory === null
    ? `docsfab runs import <state-directory> --index-dir ${shellArgument(dirname(report.index.path))}`
    : runsImportCommand(report.index.stateDirectory);
}

function formatIndexNotes(report: WhyReportV1): string[] {
  const notes: string[] = [];
  if (!report.index.exists) {
    notes.push("Index: no run index exists yet; runs were read from saved records.");
  }
  for (const limitation of report.limitations) {
    const [code, count] = limitation.split(":");
    if (code === "runs-not-indexed") {
      notes.push(
        `Not indexed: ${count ?? "some"} runs were diagnosed from their saved records because the run index does not hold them; ${
          report.index.stateDirectory === null
            ? "docsfab runs import adds them"
            : `${runsImportCommand(report.index.stateDirectory)} adds them`
        }.`,
      );
    } else if (code === "runs-reprojected") {
      notes.push(
        `Re-read: ${runsWere(count)} indexed by an earlier DocsFab, so ${count === "1" ? "it was" : "they were"} diagnosed from ${count === "1" ? "its saved record" : "their saved records"}; ${reindexCommand(report)} indexes ${count === "1" ? "it" : "them"} again.`,
      );
    } else if (code === "runs-index-earlier") {
      notes.push(
        `Earlier index: ${runsWere(count)} indexed by an earlier DocsFab and ${
          report.index.stateDirectory === null
            ? "not read again, because no state directory was named"
            : `${count === "1" ? "its saved record was" : "their saved records were"} missing, unreadable, or not that run's terminal record`
        }, so fields added since read unavailable; ${reindexCommand(report)} indexes ${count === "1" ? "it" : "them"} again.`,
      );
    } else {
      notes.push(`Limitation: ${limitation}`);
    }
  }
  if (report.index.incompleteSnapshots > 0) {
    notes.push(
      `Incomplete snapshots: ${String(report.index.incompleteSnapshots)} index appends were cut short and were not read.`,
    );
  }
  if (report.index.unreadableLines > 0) {
    notes.push(
      `Unreadable: ${String(report.index.unreadableLines)} index lines were not current rows and were not read.`,
    );
  }
  if (report.index.refusedSnapshots > 0) {
    notes.push(
      `INCOMPLETE: ${String(report.index.refusedSnapshots)} run snapshots were refused by the run index; docsfab runs query names the cause.`,
    );
  }
  return notes;
}
