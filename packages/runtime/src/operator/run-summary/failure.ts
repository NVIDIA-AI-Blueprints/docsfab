// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Failure and required-check diagnostics from closed, retained evidence. */
import type { InferenceAttemptEvidence, RunRecord } from "../../records/contracts.js";
import { isInferenceAttemptModelTelemetry } from "../../records/model-telemetry.js";
import { describeFailureClassification, readRunFailure } from "../failure-classification.js";
import { readAuthoringCandidateRejection } from "../../workflow-execution/authoring-candidate.js";
import { readEditorialFinalizationRejection } from "../../workflow-execution/editorial-finalization-rejection.js";
import {
  formatStepRejectionSentence,
  formatStepRetryDispositionSentence,
} from "../retry-disposition.js";
import {
  isConfiguredCredentialName,
  redactConfiguredCredentials,
} from "../../security/configured-credentials.js";
import { redactCredentialMaterial } from "../../security/credential-material.js";
import { redactOperatorFacingSummaryV1 } from "../../workflow-contracts/outcome.js";

function formatAttemptParseBudgetLine(
  attempt: InferenceAttemptEvidence | undefined,
): string | undefined {
  if (!attempt || attempt.outcome !== "malformed-response") return undefined;
  const outputTokens = attempt.usage?.output;
  if (!Number.isInteger(outputTokens) || outputTokens === undefined || outputTokens < 0) {
    return undefined;
  }
  const lastTurn =
    Array.isArray(attempt.turns) && attempt.turns.length > 0
      ? ([...attempt.turns].reverse().find((turn) => turn.decision !== "stop") ??
        attempt.turns.at(-1))
      : undefined;
  const allowance =
    lastTurn?.requestedOutputTokens ??
    lastTurn?.effectiveMaxOutputTokens ??
    attempt.model?.profile?.effectiveMaxOutputTokens;
  if (!Number.isInteger(allowance) || allowance === undefined || allowance < 0) return undefined;
  return (
    `Output allowance ${allowance}; observed output tokens ${outputTokens};` +
    ` finish reason ${closedAttemptFinishReason(lastTurn?.rawStopReason)}.`
  );
}

/**
 * How the provider ended the terminal attempt, so a reply cut at the output
 * limit is not mistaken for a shape rejection. Silent without valid telemetry.
 * Closed values and integers only.
 */
export function formatAttemptModelTelemetryLine(
  attempt: InferenceAttemptEvidence | undefined,
): string | undefined {
  if (!attempt || !isInferenceAttemptModelTelemetry(attempt.modelTelemetry, attempt.outcome)) {
    return undefined;
  }
  const telemetry = attempt.modelTelemetry;
  const clauses = [`finish reason ${telemetry.finishReason ?? "unavailable"}`];
  if (telemetry.outputTokens !== undefined || telemetry.outputAllowance !== undefined) {
    clauses.push(
      `output ${telemetry.outputTokens ?? "unavailable"} of ${
        telemetry.outputAllowance ?? "unavailable"
      } allowed tokens`,
    );
  }
  clauses.push(`provider latency ${telemetry.providerLatencyMs} ms`);
  const error = telemetry.providerError;
  if (error) {
    const details = [
      ...(error.httpStatus === undefined ? [] : [`HTTP ${error.httpStatus}`]),
      ...(error.retryAfterMs === undefined ? [] : [`retry after ${error.retryAfterMs} ms`]),
      ...(error.streamErrorStatus === undefined
        ? []
        : [`in-stream status ${error.streamErrorStatus}`]),
    ];
    clauses.push(
      `provider error ${error.class}${details.length > 0 ? ` (${details.join("; ")})` : ""}`,
    );
  }
  return `Model telemetry: ${clauses.join("; ")}.`;
}

function closedAttemptFinishReason(value: unknown): string {
  if (value === "absent") return "absent";
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,31}$/u.test(value) ? value : "absent";
}

/**
 * Cite the run, failing step, and coded rejection. `--quiet` callers print
 * this to stderr on a failed run because the quiet footer omits FAILURE. Does
 * not dump the record or rejected model prose.
 */
export function formatRunFailureDiagnosticLines(record: RunRecord): string[] {
  const lines: string[] = [];
  const runId = typeof record.id === "string" && record.id.length > 0 ? record.id : undefined;
  const requiredCheckFailure = readRunFailure(record)?.code === "required-check-failed";
  const errorForDisplay = requiredCheckFailure
    ? "A repository-required check failed on the candidate; inspect the recorded check evidence."
    : record.error;
  const failedSteps = Array.isArray(record.steps)
    ? record.steps.filter((item) => item.status === "failed")
    : [];
  if (runId) {
    const stepIds = failedSteps
      .map((step) => step.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (stepIds.length === 1) {
      lines.push(`Run ${runId} failed at step ${stepIds[0]}.`);
    } else if (stepIds.length > 1) {
      lines.push(`Run ${runId} failed at steps ${stepIds.join(", ")}.`);
    } else {
      lines.push(`Run ${runId} failed.`);
    }
  } else if (errorForDisplay) {
    lines.push(`Run failed: ${errorForDisplay}`);
  }
  const failure = readRunFailure(record);
  if (failure) lines.push(`Failure class: ${describeFailureClassification(failure)}.`);
  if (failure?.code === "review-result-retention-failed") {
    lines.push(
      "Original review evidence was not retained; inspect the saved run and artifact store before a new review.",
    );
  }
  lines.push(...failedRequiredCheckLines(record));
  // A refusal between steps names its rule and location from the closed field.
  const candidateRejection = readAuthoringCandidateRejection(record.authoringCandidateRejection);
  if (candidateRejection) {
    lines.push(
      `Authoring candidate rejected by ${candidateRejection.code} at ${candidateRejection.location}.`,
    );
  }
  const editorialRejection = readEditorialFinalizationRejection(
    record.editorialFinalizationRejection,
  );
  if (editorialRejection) {
    lines.push(
      `Final editorial evidence refused by ${editorialRejection.code} at ${editorialRejection.location}.`,
    );
  }
  const seenErrors = new Set<string>();
  if (typeof record.error === "string" && record.error.length > 0) seenErrors.add(record.error);
  for (const step of failedSteps) {
    const rejection = formatStepRejectionSentence(step);
    if (rejection) lines.push(rejection);
    if (!runId) {
      lines.push(
        `Step ${step.id} failed: ${requiredCheckFailure ? "inspect recorded check evidence" : (step.error ?? "Unknown error")}`,
      );
    } else if (!requiredCheckFailure && step.error && !seenErrors.has(step.error)) {
      lines.push(`Step ${step.id} failed: ${step.error}`);
      seenErrors.add(step.error);
    }
    const parseBudget = formatAttemptParseBudgetLine(step.inference?.attempts.at(-1));
    if (parseBudget && !(step.error ?? record.error ?? "").includes("Output allowance ")) {
      lines.push(parseBudget);
    }
    const telemetry = formatAttemptModelTelemetryLine(step.inference?.attempts.at(-1));
    if (telemetry) lines.push(telemetry);
    const disposition = formatStepRetryDispositionSentence(step);
    if (disposition) lines.push(disposition);
  }
  if (runId && errorForDisplay) {
    lines.push(errorForDisplay);
  }
  return lines.map(redactConfiguredCredentials);
}

/** Only fixed host-check fields are projected; command output is never rendered. */
export function failedRequiredCheckLines(record: RunRecord): string[] {
  if (readRunFailure(record)?.code !== "required-check-failed") return [];
  const summary = [...record.steps]
    .reverse()
    .find(
      (step) =>
        step.kind === "host-operation" &&
        step.skill === "lint-documentation" &&
        step.status === "succeeded",
    )?.summary;
  if (!summary) return [];
  let evidence: unknown;
  try {
    evidence = JSON.parse(summary);
  } catch {
    return [];
  }
  if (!evidence || typeof evidence !== "object" || !("checks" in evidence)) return [];
  const parsed = evidence as { snapshotSha256?: unknown; checks: unknown };
  if (typeof parsed.snapshotSha256 !== "string") return [];
  const checks = parsed.checks;
  if (!Array.isArray(checks)) return [];
  return checks.flatMap((check: unknown) => {
    if (!check || typeof check !== "object") return [];
    const row = check as Record<string, unknown>;
    if (row.required !== true || row.status !== "failed" || typeof row.command !== "string")
      return [];
    const command = safeRequiredCheckCommandForDisplay(row.command);
    const exit =
      typeof row.exitCode === "number" && Number.isSafeInteger(row.exitCode)
        ? `, exit code ${row.exitCode}`
        : "";
    return [
      `Inspect recorded required repository check ${command}: failed on the candidate${exit}. Compare with independently validated baseline evidence before assigning cause.`,
    ];
  });
}

/** Keep unverifiable argument values out of human and JSON saved-run summaries. */
function safeRequiredCheckCommandForDisplay(command: string): string {
  if (!/^[A-Za-z0-9_@%+=:,./ -]+$/u.test(command)) return "(command detail withheld)";
  const words = command.split(/ +/u).filter(Boolean);
  if (
    words.some((word) =>
      isConfiguredCredentialName(word.replaceAll("-", "_").replace(/^_+/u, "").toUpperCase()),
    )
  )
    return "(command detail withheld)";
  const [program, first, second, ...extra] = words;
  const plainName = (value: string | undefined): boolean =>
    typeof value === "string" && /^[A-Za-z0-9_.:/-]+$/u.test(value) && !value.startsWith("-");
  const simpleCommand =
    ((program === "npm" || program === "pnpm" || program === "yarn") &&
      ((first === "run" && plainName(second) && extra.length === 0) ||
        (first === "test" && second === undefined))) ||
    (program === "make" && (first === undefined || (plainName(first) && second === undefined))) ||
    ((program === "python" || program === "python3") &&
      first === "-m" &&
      (second === "pytest" || second === "unittest") &&
      extra.length === 0);
  return simpleCommand
    ? redactCredentialMaterial(redactOperatorFacingSummaryV1(command))
    : "(command detail withheld)";
}
