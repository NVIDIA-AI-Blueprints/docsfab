// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  failedRequiredCheckLines,
  formatRunFailureDiagnosticLines,
} from "./run-summary/failure.js";
export {
  formatAttemptModelTelemetryLine,
  formatRunFailureDiagnosticLines,
} from "./run-summary/failure.js";
import {
  buildPatchSectionLines,
  formatDeliveryLookupLines,
  formatRetainedDeliveryLines,
  runVerdictPlanes,
  type RunFooterProjectionContext,
} from "./run-summary/footer.js";
export {
  runVerdictPlanes,
  buildPatchSectionLines,
  parsePatchFileStats,
  type RunFooterProjectionContext,
} from "./run-summary/footer.js";
import type { RunSummaryContext } from "./run-summary/contracts.js";
import { projectRunPresentationView } from "./run-summary/view.js";
export { projectRunPresentationView, type RunPresentationView } from "./run-summary/view.js";
export type {
  RunSummaryContext,
  RunSummaryPublicationOutcome,
  RunPublicationPhase,
  RunHistoryNextCommandContext,
  RunSummaryPatchFileStat,
} from "./run-summary/contracts.js";
export type { RunLimitOverflowEvidenceV1 };
import { formatProductOutcomeLines, formatEditorialOutcomeLines } from "./run-summary/product.js";
export { renderWorkflowOutcome } from "./run-summary/product.js";
import {
  formatQualitySectionLines,
  formatReviewFindingsSection,
  quoteSummaryArgument,
  showsReviewFindingsSection,
} from "./run-summary/quality.js";
import { readinessOutcomeLines } from "../readiness/report.js";
import { TEMPLATE_AUDIT_WORKFLOW, templateAuditOutcomeLines } from "../templates/audit.js";
import { resolve } from "node:path";

import type { RunRecord } from "../records/contracts.js";
import { formatDocumentationGapLedgerSummary } from "../search/gap-ledger.js";
import { renderReleaseDocumentationReadinessScorecard } from "../release-documentation-scorecard.js";
import {
  collectRunLimitOverflowEvidence,
  mergeRunLimitOverflowEvidence,
  projectRunLimitOverflowLines,
  type RunLimitOverflowEvidenceV1,
} from "./run-limit-overflow.js";
import {
  redactOperatorFacingSummaryV1,
  workflowOutcomeState,
  type WorkflowOutcomeExitPolicyV1,
} from "../workflow-contracts/outcome.js";
import { formatSecurityScanCliMessages } from "../security/scan-cli.js";
import { CREDENTIAL_LIKE_CONTENT } from "../security/credential-findings.js";
import { redactCredentialMaterial } from "../security/credential-material.js";
import {
  isConfiguredCredentialName,
  redactConfiguredCredentials,
} from "../security/configured-credentials.js";
import { isAuthoringQualityOutcomeWorkflow } from "../evaluation-report/index.js";
import { projectReviewFindingsFromRun, type ProjectedReviewFindingsV1 } from "../review/index.js";
import { readRequiredCheckLimitations } from "../workflow-execution/required-check-limitation.js";
import { formatAnswerAskedEarlyLines, readAnswersAskedEarly } from "./answer-asked-early.js";
import { reviewOverdueModelEvidence } from "../execution/inference-evidence.js";
import { projectCredentialFindingsForPresentation } from "../security/credential-findings.js";
import { formatRequestIntentLines } from "../request-intent/interpret-record.js";
import { formatFirstPassContradictionLines } from "../cli/run/first-pass-contradiction-stop.js";
import { formatRunRetryDispositionLines } from "./retry-disposition.js";
import {
  formatCliDuration,
  formatCliVerdictLine,
  formatCliVerdictPlaneRows,
  indentCliBody,
  paintCliText,
  pushIndentedBody,
  pushSectionHeader,
  weakestCliVerdictColor,
  type CliFormatOptions,
  type CliVerdictPlanes,
} from "./cli-format.js";
import {
  formatDocChangeDeltaReviewLines,
  projectDocChangeDeltaCliSurface,
} from "./doc-change-delta-surface.js";
import { projectRunEditorialOutcome, projectRunCompositionExecution } from "./run-result.js";
import {
  buildRunHumanNextCommand,
  collectRunResultNextSteps as collectBaseRunResultNextSteps,
} from "./run-next-action.js";
import { diagnoseRunRecord, recordDiagnosisLocation } from "../diagnosis/record.js";
import { formatRunDiagnosisLines } from "../diagnosis/render.js";
import { admitPlannerDiagnostic } from "../workflow-contracts/planner-diagnostic.js";
import { AMBIGUOUS_CREATE_TARGETS_CODE } from "../workflow-execution/plan-binding.js";

// NEXT-action selection lives in `run-next-action.ts`; these re-exports keep
// this module's public surface.
export {
  buildRunHumanNextCommand,
  staleRevisionRecovery,
  type RunHumanNextCommand,
} from "./run-next-action.js";

/** Include the safe check locator in the JSON run's existing next-action plane. */
export function collectRunResultNextSteps(context: RunSummaryContext): string[] {
  return [...collectBaseRunResultNextSteps(context), ...failedRequiredCheckLines(context.record)];
}

/**
 * Selects the admitted findings shown in the human footer. Authoring jobs use
 * the strict run-step projection and acquire no quality-artifact claim.
 */
export function projectHumanReviewFindings(
  record: RunRecord,
  retained?: ProjectedReviewFindingsV1,
): ProjectedReviewFindingsV1 | undefined {
  if (retained) return retained;
  return isAuthoringQualityOutcomeWorkflow(record.workflow) ||
    record.workflow === TEMPLATE_AUDIT_WORKFLOW
    ? projectReviewFindingsFromRun(record)
    : undefined;
}

/** `execution · product · publication` one-liner; prefer `buildRunVerdictLines`. */
export function buildRunVerdictLine(
  context: RunFooterProjectionContext,
  options: CliFormatOptions,
): string {
  const { record } = context;
  const shortId = record.id.slice(0, 8);
  return `${record.workflow} ${shortId}: ${formatCliVerdictLine(runVerdictPlanes(context), options)}`;
}

/** Nested VERDICT body: workflow + 8-hex id, then labeled plane rows. */
export function buildRunVerdictLines(
  context: RunFooterProjectionContext,
  options: CliFormatOptions,
): string[] {
  return formatRunVerdictLines(
    { runId: context.record.id, workflow: context.record.workflow },
    runVerdictPlanes(context),
    options,
  );
}

function formatRunVerdictLines(
  identity: { readonly runId: string; readonly workflow: string },
  planes: CliVerdictPlanes,
  options: CliFormatOptions,
): string[] {
  const shortId = identity.runId.slice(0, 8);
  return [
    `${identity.workflow} ${shortId}`,
    ...formatCliVerdictPlaneRows(planes, options).map((row) => indentCliBody(row)),
  ];
}

/**
 * Human stdout footer, verdict first. Every shape, `--quiet` included, leaves
 * through one exit that shows none of DocsFab's own configured credentials,
 * whatever field held one (#1807).
 */
export function formatRunSummary(context: RunSummaryContext): string[] {
  return formatRunSummaryLines(context).map(redactConfiguredCredentials);
}

function formatRunSummaryLines(context: RunSummaryContext): string[] {
  const { record, recordPath, exitCode, repositoryPath } = context;
  const view = projectRunPresentationView(context);
  const formatOptions: CliFormatOptions = {
    tty: context.tty,
    ...(context.ci !== undefined ? { ci: context.ci } : {}),
    ...(context.noColor !== undefined ? { noColor: context.noColor } : {}),
  };
  const lines: string[] = [];

  pushSectionHeader(lines, "VERDICT", formatOptions, {
    color: weakestCliVerdictColor(view.verdict),
  });
  pushIndentedBody(lines, formatRunVerdictLines(view.identity, view.verdict, formatOptions));
  if (record.checkoutPersistence) {
    pushIndentedBody(lines, [
      `Workflow status: ${record.status}`,
      `Checkout persistence: ${record.checkoutPersistence.outcome}${record.checkoutPersistence.outcome === "failed" ? ` (${record.checkoutPersistence.errorCode})` : ""}`,
    ]);
  }
  if (record.answerRecordDiscovery) {
    const { statusLabel, bounds } = record.answerRecordDiscovery;
    const providerExecution = bounds.effective.providerExecution;
    const providerBounds =
      providerExecution.policyVersion === 2
        ? "Answer-record evaluator step: aggregate provider-turn and whole-attempt time ceilings are absent."
        : `Provider execution is limited to ${providerExecution.maxProviderTurns} turns and ${providerExecution.timeoutMs} ms per attempt.`;
    pushIndentedBody(lines, [
      `Execution mode: ${statusLabel}`,
      `${providerBounds} Per-request model capacity: ` +
        `${bounds.effective.model.maxInputTokens} input / ${bounds.effective.model.maxOutputTokens} output tokens, ` +
        `${bounds.qualityValidatorTimeoutMs} ms local validator subprocess.`,
    ]);
  }
  if (context.history) {
    const { category, reason } = context.history.resumability;
    const resumabilityLines = [`Resumability: ${category} (${reason})`];
    if (context.history.selectionOutcomeReason) {
      resumabilityLines.push(context.history.selectionOutcomeReason);
    }
    pushIndentedBody(lines, resumabilityLines);
  }

  const next = view.next;
  if (next) {
    pushSectionHeader(lines, "NEXT", formatOptions);
    pushIndentedBody(lines, [
      next.command,
      `Reason: ${next.reason}`,
      ...hostPlanQuestionLines(record),
      ...(record.status === "failed" ? [`Why: ${runWhyCommand(record, recordPath)}`] : []),
    ]);
  }

  const patchLines = buildPatchSectionLines(context);
  if (patchLines.length > 0) {
    const paintedPatch = patchLines.map((line) =>
      line === "No documentation files." ? paintCliText(line, { dim: true }, formatOptions) : line,
    );
    pushSectionHeader(lines, "PATCH", formatOptions);
    pushIndentedBody(lines, paintedPatch);
  }

  pushSectionHeader(lines, "RECORD", formatOptions);
  const recordLines = [view.evidence.recordPath];
  if (view.evidence.patchPath && view.evidence.patchSha256) {
    recordLines.push(`Patch: ${view.evidence.patchPath}`);
    recordLines.push(`Patch digest: ${view.evidence.patchSha256}`);
    if (context.verbose) {
      const deltaSurface = projectDocChangeDeltaCliSurface({
        record,
        ...(context.repositoryContentDigestSha256
          ? {
              repositoryContentDigestSha256: context.repositoryContentDigestSha256,
            }
          : {}),
      });
      recordLines.push(...formatDocChangeDeltaReviewLines(deltaSurface));
    }
  }
  // Advisory only: the run used the profile as configured.
  for (const overdue of reviewOverdueModelEvidence(
    record.models,
    record.startedAt ?? record.createdAt,
  )) {
    recordLines.push(
      `Review overdue: ${overdue.provider}/${overdue.model} review date ${overdue.reviewAfter} had passed when the run started (reminder only; the configured profile was used).`,
    );
  }
  pushIndentedBody(lines, recordLines);

  // How the request was read before the first step. The renderer verifies the
  // sealed intent against the record's instruction before it prints a field.
  const intentLines = context.quiet ? [] : formatRequestIntentLines(record);
  if (intentLines.length > 0) {
    pushSectionHeader(lines, "INTENT", formatOptions);
    pushIndentedBody(lines, intentLines);
  }
  // The question first pass asked when repository sources disagreed.
  const firstPassLines = context.quiet ? [] : formatFirstPassContradictionLines(record);
  if (firstPassLines.length > 0) {
    pushSectionHeader(lines, "FIRST PASS", formatOptions);
    pushIndentedBody(lines, firstPassLines);
  }

  const appendQualitySection = (): void => {
    const qualityLines = formatQualitySectionLines(context);
    if (qualityLines === undefined) return;
    pushSectionHeader(lines, "QUALITY", formatOptions);
    pushIndentedBody(lines, qualityLines);
  };
  const appendLimitOverflowSection = (): void => {
    // Required checks that could not run come first: each names the command
    // the operator runs before merging the delivered change (#1918).
    const limitationLines = [
      ...readRequiredCheckLimitations(record),
      ...buildLimitOverflowLines(context),
      // Attempts the host asked to answer before they finished reading.
      ...formatAnswerAskedEarlyLines(readAnswersAskedEarly(record)),
    ];
    if (limitationLines.length === 0) return;
    pushSectionHeader(lines, "LIMITATIONS", formatOptions);
    pushIndentedBody(lines, limitationLines);
  };
  if (context.quiet) {
    appendQualitySection();
    appendLimitOverflowSection();
    return lines;
  }

  pushSectionHeader(lines, "EXECUTION", formatOptions);
  const executionLines = [
    `Run: ${record.id}`,
    `Workflow: ${record.workflow}`,
    `Repository: ${repositoryPath}`,
    `Revision: ${record.repository.revision}`,
    `Exit code: ${exitCode}`,
  ];
  if (record.durationMs !== undefined) {
    executionLines.push(
      `Duration: ${
        context.verbose ? `${record.durationMs}ms` : formatCliDuration(record.durationMs)
      }`,
    );
  }
  const compositionExecution = projectRunCompositionExecution(record);
  if (compositionExecution) {
    executionLines.push(
      `Composition: ${compositionExecution.compositionId}`,
      `Composition evidence: ${compositionExecution.evidenceSha256}`,
      `Composition aggregate: ${compositionExecution.aggregateSha256 ?? "not-available"}`,
      "Technical approval: not-established",
      "Role qualification: not-established",
      "Release eligible: no",
    );
  }
  pushIndentedBody(lines, executionLines);
  const sourceAdmissions =
    record.steps.find((step) => step.id === "derive-source-obligations")
      ?.sourceProposalAdmissions ?? [];
  if (sourceAdmissions.length > 0) {
    pushSectionHeader(lines, "SOURCE PROPOSALS", formatOptions);
    pushIndentedBody(
      lines,
      sourceAdmissions.flatMap((entry) => [
        `Attempt ${entry.attempt}: ${redactOperatorFacingSummaryV1(entry.path)}`,
        `Model reason: ${redactOperatorFacingSummaryV1(entry.reason)}`,
        `Host disposition: ${entry.status}${entry.refusalCode ? ` (${entry.refusalCode})` : ""}`,
      ]),
    );
  }

  pushSectionHeader(lines, "PRODUCT", formatOptions);
  const productLines = [
    ...formatProductOutcomeLines(record, context.editorialDecodeOptions),
    ...readinessOutcomeLines(record),
    ...templateAuditOutcomeLines(record),
  ];
  const outcome = workflowOutcomeState(record, context.editorialDecodeOptions);
  if (outcome.state === "current" && record.status === "needs-input") {
    const terminal = [...record.steps].reverse().find((step) => step.status === "needs-input");
    if (terminal?.summary) productLines.push(redactOperatorFacingSummaryV1(terminal.summary));
  }
  pushIndentedBody(lines, productLines);
  appendLimitOverflowSection();

  if (
    record.workflow === "update-documentation" ||
    record.workflowBranchCoverage !== undefined ||
    record.artifacts?.some((use) => use.reference.kind === "editorial-decision")
  ) {
    pushSectionHeader(lines, "EDITORIAL", formatOptions);
    pushIndentedBody(
      lines,
      formatEditorialOutcomeLines(
        projectRunEditorialOutcome(record, context.editorialDecodeOptions),
      ),
    );
  }

  if (showsReviewFindingsSection(context) && context.reviewFindingsProjection) {
    pushSectionHeader(lines, "REVIEW FINDINGS", formatOptions);
    pushIndentedBody(
      lines,
      formatReviewFindingsSection(context.reviewFindingsProjection, record, recordPath),
    );
  }

  if (context.publication && context.publication.status !== "not-requested") {
    pushSectionHeader(lines, "PUBLICATION", formatOptions);
    const publicationLines =
      context.publication.status === "succeeded"
        ? ["Status: succeeded", `Merge request: ${context.publication.mergeRequestUrl}`]
        : context.publication.status === "not-needed"
          ? [
              "Status: not needed",
              "The run verified that no documentation change is needed, so no draft merge request was opened.",
            ]
          : [`Status: failed (${context.publication.failureCode})`];
    if (context.publication.status === "failed" && context.publication.detail) {
      publicationLines.push(context.publication.detail);
    }
    if (context.publication.status === "failed" && context.publication.validationFailure) {
      publicationLines.push(
        `Validation: ${context.publication.validationFailure.reasonCode}`,
        ...(context.publication.validationFailure.results ?? []).map(
          (result) => `Check ${result.id}: ${result.status}`,
        ),
      );
    }
    if (context.publication.status === "failed" && context.publication.recoveryCommand) {
      publicationLines.push(`Recovery: ${context.publication.recoveryCommand}`);
    }
    if (context.retainedDelivery) {
      publicationLines.push(...formatRetainedDeliveryLines(context.retainedDelivery));
    }
    pushIndentedBody(lines, publicationLines);
  } else if (context.deliveryLookup) {
    pushSectionHeader(lines, "PUBLICATION", formatOptions);
    pushIndentedBody(lines, [
      ...formatDeliveryLookupLines(context.deliveryLookup),
      ...(context.retainedDelivery ? formatRetainedDeliveryLines(context.retainedDelivery) : []),
    ]);
  }

  appendQualitySection();

  if (record.releaseDocumentationReadiness && context.releaseScorecard) {
    lines.push("");
    lines.push(
      renderReleaseDocumentationReadinessScorecard(
        record,
        {
          ...record.repository,
          defaultBranch: context.releaseScorecard.defaultBranch,
        },
        context.releaseScorecard.inventory,
      ),
    );
  }

  if (context.verbose && record.gapLedger) {
    for (const line of formatDocumentationGapLedgerSummary(record.gapLedger)) {
      lines.push(line);
    }
  }

  const scanStdout = formatSecurityScanCliMessages(record, {
    showScan: context.showScan,
  }).filter((message) => message.stream === "stdout");
  if (scanStdout.length > 0) {
    pushSectionHeader(lines, "SCAN", formatOptions);
    pushIndentedBody(
      lines,
      scanStdout.map((message) => message.text),
    );
  }

  // Saved-run replay lists every credential-like finding (#1807); the live
  // summary counts them under LIMITATIONS and points here.
  if (context.history && record.credentialFindings?.length) {
    const findings = projectCredentialFindingsForPresentation(record.credentialFindings) ?? [];
    pushSectionHeader(lines, "CREDENTIAL-LIKE CONTENT", formatOptions);
    pushIndentedBody(lines, [
      "Flagged for the maintainers; DocsFab used it and continued. Each is a location and a rule, never the text.",
      // A record from any writer prints each location as one escaped line.
      ...findings.map((finding) => `${finding.location} (${finding.rule})`),
    ]);
  }

  if (context.iaContinuation?.length) {
    lines.push(...context.iaContinuation);
  }

  // Saved-run replay only; the live footer states the terminal attempt in one
  // sentence instead, in FAILURE below.
  if (context.history) {
    const retryLines = formatRunRetryDispositionLines(record);
    if (retryLines.length > 0) {
      pushSectionHeader(lines, "RETRIES", formatOptions);
      pushIndentedBody(lines, retryLines);
    }
  }

  if (record.status === "failed") {
    pushSectionHeader(lines, "FAILURE", formatOptions);
    pushIndentedBody(lines, formatRunFailureDiagnosticLines(record));
    pushSectionHeader(lines, "DIAGNOSIS", formatOptions);
    pushIndentedBody(lines, formatRunDiagnosisSection(context));
  }

  return lines;
}

/**
 * The question a host stop on the CREATE plan asks, in NEXT so `--quiet` shows
 * it. Only the host writes this stop's summary; a planner's own stop keeps its
 * text in PRODUCT.
 */
function hostPlanQuestionLines(record: RunRecord): string[] {
  if (record.status !== "needs-input") return [];
  if (admitPlannerDiagnostic(record)?.code !== AMBIGUOUS_CREATE_TARGETS_CODE) return [];
  const planner = record.steps.find((step) => step.id === "plan-documentation");
  return planner?.summary ? [`Question: ${redactOperatorFacingSummaryV1(planner.summary)}`] : [];
}

/** `docsfab why` for this run, reading the state directory the record was saved in. */
function runWhyCommand(record: RunRecord, recordPath: string): string {
  return `docsfab why ${quoteSummaryArgument(record.id)}${recordDiagnosisLocation(recordPath).indexArgs}`;
}

/**
 * DIAGNOSIS body: the caller's index-backed diagnosis, else one computed from
 * the record. A record the index projection refuses still names `docsfab why`.
 */
export function formatRunDiagnosisSection(
  context: Pick<RunSummaryContext, "record" | "recordPath" | "diagnosis">,
): string[] {
  const location = recordDiagnosisLocation(context.recordPath);
  let diagnosis = context.diagnosis;
  let unavailable: string | undefined;
  if (!diagnosis) {
    try {
      diagnosis = diagnoseRunRecord(context.record, context.recordPath);
      if (!diagnosis) {
        unavailable =
          "Diagnosis unavailable: the run index projection refuses this record, for example a record schema it does not read.";
      }
    } catch {
      unavailable =
        "Diagnosis unavailable: DocsFab failed while diagnosing this record, which is a DocsFab defect; report it with this run's record.";
    }
  }
  if (!diagnosis) {
    return [unavailable ?? "", `Full answer: ${runWhyCommand(context.record, context.recordPath)}`];
  }
  return formatRunDiagnosisLines(diagnosis, { location, inRunOutput: true });
}

function buildLimitOverflowLines(context: RunSummaryContext): string[] {
  return [
    ...projectRunLimitOverflowLines(
      mergeRunLimitOverflowEvidence(
        collectRunLimitOverflowEvidence(context.record),
        context.releaseScorecard?.inventory
          ? {
              inventory: context.releaseScorecard.inventory,
              ...(context.limitOverflowEvidence?.limits
                ? { limits: context.limitOverflowEvidence.limits }
                : {}),
            }
          : undefined,
        context.limitOverflowEvidence,
      ),
    ),
    // Credential-like content the run used and continued past (#1807).
    ...(context.record.evidenceWarnings ?? []).filter((warning) =>
      warning.startsWith(`${CREDENTIAL_LIKE_CONTENT}:`),
    ),
  ];
}

export function defaultRunRecordPath(stateDirectory: string, runId: string): string {
  return resolve(stateDirectory, `${runId}.json`);
}

export function runSummaryLineBudget(lines: readonly string[]): number {
  return lines.length;
}

export type { WorkflowOutcomeExitPolicyV1 };
