// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Pure PRODUCT and EDITORIAL body projections from admitted run evidence. */
import { admitPlanScopeStop } from "../../workflow-contracts/plan-scope-stop.js";
import { admitWriterNoChangeStop } from "../../workflow-contracts/writer-no-change-stop.js";
import { limit } from "../../config/limits.js";
import { editorialInputAskPresentationV1 } from "../../artifacts/editorial-input-ask.js";
import { noChangeBasisPhrase } from "../../artifacts/editorial-decision.js";
import type { RunRecord } from "../../records/contracts.js";
import type {
  WorkflowOutcomeEnvelopeV1,
  WorkflowOutcomeFindingV1,
} from "../../workflow-contracts/contracts.js";
import {
  redactOperatorFacingSummaryV1,
  workflowOutcomeState,
  type WorkflowOutcomeDecodeOptionsV1,
} from "../../workflow-contracts/outcome.js";
import { explainProductDisposition, explainFindingCode } from "../cli-format.js";
import { projectRunProduct, type RunEditorialOutcomeV1 } from "../run-result.js";

/** Operator-facing product outcome lines. */
export function renderWorkflowOutcome(
  record: RunRecord,
  options: { glossary?: boolean; decodeOptions?: WorkflowOutcomeDecodeOptionsV1 } = {},
): string[] {
  const glossary = options.glossary ?? true;
  const state = workflowOutcomeState(record, options.decodeOptions);
  if (state.state === "legacy-no-product-disposition") {
    const lines = ["Product disposition: legacy-no-product-disposition"];
    const explanation = glossary
      ? explainProductDisposition("legacy-no-product-disposition")
      : undefined;
    if (explanation) lines.push(`Product disposition meaning: ${explanation}`);
    return lines;
  }
  const { outcome } = state;
  return renderCurrentWorkflowOutcome(outcome, glossary);
}

/** Format a current outcome from typed evidence, optionally hiding repeated evidence categories. */
function renderCurrentWorkflowOutcome(
  outcome: WorkflowOutcomeEnvelopeV1,
  glossary: boolean,
  options: {
    omitEmptyEvidence?: boolean;
    collapseSharedEvidence?: boolean;
    auditFindings?: boolean;
  } = {},
): string[] {
  const findingCodes = new Set(outcome.findings.map((finding) => finding.code));
  const findings = outcome.findings;
  const limitations =
    options.omitEmptyEvidence && outcome.limitations.length === 0
      ? undefined
      : options.collapseSharedEvidence &&
          outcome.findings.length > 0 &&
          outcome.limitations.every((code) => findingCodes.has(code))
        ? undefined
        : outcome.limitations;
  const openDecisions =
    options.omitEmptyEvidence && outcome.openDecisions.length === 0
      ? undefined
      : options.collapseSharedEvidence &&
          outcome.findings.length > 0 &&
          outcome.openDecisions.every((decision) => findingCodes.has(decision.id))
        ? undefined
        : outcome.openDecisions;
  const lines = [
    `Product disposition: ${outcome.disposition}`,
    ...(options.auditFindings
      ? formatAuditFindingLines(findings)
      : options.omitEmptyEvidence && findings.length === 0
        ? []
        : [`Product findings: ${findings.map((finding) => finding.code).join(",") || "none"}`]),
    ...(limitations === undefined
      ? []
      : [`Product limitations: ${limitations.join(",") || "none"}`]),
    ...(openDecisions === undefined
      ? []
      : [
          `Product open decisions: ${openDecisions.map((decision) => decision.id).join(",") || "none"}`,
        ]),
    `Product outcome evidence: ${outcome.evidence.map((evidence) => evidence.id).join(",")}`,
  ];
  const explanation = glossary ? explainProductDisposition(outcome.disposition) : undefined;
  if (explanation) lines.splice(1, 0, `Product disposition meaning: ${explanation}`);
  for (const finding of findings) {
    if (finding.kind !== "missing-governed-input" || finding.inputId === undefined) continue;
    const presentation = editorialInputAskPresentationV1(finding.inputId);
    if (!presentation) continue;
    lines.push(
      `Product input: ${presentation.label} (${presentation.fillKind})`,
      `Product input why: ${presentation.why}`,
    );
  }
  return lines;
}

export function formatProductOutcomeLines(
  record: RunRecord,
  editorialDecodeOptions?: WorkflowOutcomeDecodeOptionsV1,
): string[] {
  return [
    ...formatProductDispositionLines(record, editorialDecodeOptions),
    ...sourceCitationGapLines(record),
  ];
}

/**
 * One line per citing write step that added documentation sentences with no
 * verified source citation, naming each by page and line, never by its text.
 */
function sourceCitationGapLines(record: RunRecord): string[] {
  const steps = record.sourceCitations?.steps;
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((step) => {
    const uncited = step.uncitedClaims ?? [];
    if (!Array.isArray(uncited) || uncited.length === 0) return [];
    const locations = [...new Set(uncited.map((claim) => `${claim.path}:${claim.line}`))];
    const sentences = uncited.length === 1 ? "1 sentence" : `${uncited.length} sentences`;
    return [
      `Uncited sentences: ${step.stepId} added ${sentences} with no verified source citation, at ${locations.join(", ")}.`,
    ];
  });
}

function formatProductDispositionLines(
  record: RunRecord,
  editorialDecodeOptions?: WorkflowOutcomeDecodeOptionsV1,
): string[] {
  const projection = projectRunProduct(record, editorialDecodeOptions);
  const plannerLines = projection.plannerDiagnostic
    ? [
        `Planner diagnostic: ${projection.plannerDiagnostic.code}`,
        `Planner diagnostic category: ${projection.plannerDiagnostic.category}`,
        `Planner response shape: ${projection.plannerDiagnostic.responseShape}`,
        `Planner response digest: ${projection.plannerDiagnostic.responseSha256}`,
      ]
    : ["Planner diagnostic: unavailable"];
  const outcomeCurrent = workflowOutcomeState(record, editorialDecodeOptions).state === "current";
  if (!outcomeCurrent && (projection.disposition === null || projection.plannerDiagnostic)) {
    return [
      `Product disposition: ${projection.disposition ?? "unavailable"}`,
      ...projection.limitations.map((limitation) => `Product limitation: ${limitation}`),
      ...plannerLines,
    ];
  }
  // A sealed planner governed-input stop renders its outcome, then the admitted
  // planner evidence it was bound from.
  if (outcomeCurrent && projection.plannerDiagnostic) {
    const outcomeState = workflowOutcomeState(record, editorialDecodeOptions);
    if (outcomeState.state !== "current") return [];
    return [
      ...renderCurrentWorkflowOutcome(outcomeState.outcome, true, {
        omitEmptyEvidence: true,
        collapseSharedEvidence: true,
      }),
      ...plannerLines,
    ];
  }
  const rendered = renderWorkflowOutcome(record, { decodeOptions: editorialDecodeOptions });
  // A sealed writer stop renders its outcome, then the admitted stop it was
  // bound from.
  const planScopeStop = outcomeCurrent ? admitPlanScopeStop(record) : undefined;
  const writerNoChangeStop = outcomeCurrent ? admitWriterNoChangeStop(record) : undefined;
  const stopLines = planScopeStop
    ? [
        `Plan scope stop: ${planScopeStop.code} at step ${planScopeStop.stepId} (${planScopeStop.refusedMutations} refused edit/write call(s))`,
      ]
    : writerNoChangeStop
      ? [
          `Writer no-change stop: ${writerNoChangeStop.code} at step ${writerNoChangeStop.stepId} (repository instructions: ${writerNoChangeStop.repositoryInstructions.join(", ")})`,
        ]
      : [];
  const lines = [...rendered, ...stopLines];
  if (record.workflow === "review-documentation") {
    const state = workflowOutcomeState(record, editorialDecodeOptions);
    if (state.state === "current") {
      // Audit findings use their glossary projection in place of the findings
      // list, so other categories remain independent, as before.
      return [
        ...renderCurrentWorkflowOutcome(state.outcome, true, {
          omitEmptyEvidence: true,
          auditFindings: true,
        }),
        ...stopLines,
      ];
    }
    return lines;
  }
  const state = workflowOutcomeState(record, editorialDecodeOptions);
  if (state.state !== "current") return lines;
  const productLines = renderCurrentWorkflowOutcome(state.outcome, true, {
    omitEmptyEvidence: true,
    collapseSharedEvidence: true,
  });
  return [...productLines, ...stopLines];
}

export function formatEditorialOutcomeLines(editorial: RunEditorialOutcomeV1): string[] {
  const lines = [`Editorial outcome: ${editorial.outcome}${editorialBasisNote(editorial)}`];
  if (editorial.state === "unavailable") {
    lines.push(...editorial.limitations.map((limitation) => `Limitation: ${limitation}`));
    return lines;
  }
  lines.push(
    `Decision: ${editorial.decision}`,
    `Candidate evidence: artifact-digest:${editorial.candidateReference.digest}`,
  );
  if (editorial.validatedReference) {
    lines.push(`Validated evidence: artifact-digest:${editorial.validatedReference.digest}`);
  }
  lines.push(
    ...editorial.evidenceRefs.map(
      (reference) => `Supporting evidence: ${reference.kind}:artifact-digest:${reference.digest}`,
    ),
    ...editorial.limitations.map((limitation) => `Limitation: ${limitation}`),
  );
  return lines;
}

/**
 * How a verified no-change was reached, when no comparison of two distinct
 * commits supports it: the kept pages or nominated source coverage. The
 * decision's host-owned code says so.
 */
function editorialBasisNote(editorial: RunEditorialOutcomeV1): string {
  const basis =
    editorial.outcome === "verified-no-change"
      ? noChangeBasisPhrase(editorial.limitations)
      : undefined;
  return basis ? ` (basis: ${basis})` : "";
}

function formatAuditFindingLines(findings: readonly WorkflowOutcomeFindingV1[]): string[] {
  const shown = findings.slice(0, limit("reviewFindings.auditFooterFindings").value);
  const omitted = findings.length - shown.length;
  const lines = shown.map((finding) => formatFindingLine(finding.code));
  if (omitted > 0) {
    lines.push(`Product findings omitted: ${omitted}`);
  }
  return lines;
}

function formatFindingLine(code: string): string {
  const phrase = explainFindingCode(code);
  return phrase === undefined ? `Finding: ${code}` : `Finding: ${code} — ${phrase}`;
}
