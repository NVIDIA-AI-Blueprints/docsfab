// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Quality and review-finding body projections for the operator summary. */
import { dirname } from "node:path";
import { limit } from "../../config/limits.js";
import type { RunRecord } from "../../records/contracts.js";
import { TEMPLATE_AUDIT_WORKFLOW } from "../../templates/audit.js";
import {
  inspectQualityReportFromRun,
  isAuthoringQualityOutcomeWorkflow,
} from "../../evaluation-report/index.js";
import type { ProjectedReviewFindingsV1, ReviewFindingV1 } from "../../review/index.js";
import type { ReviewEvidenceProjectionV1 } from "../review-evidence.js";
import { projectRunEditorialOutcome } from "../run-result.js";
import type { WorkflowOutcomeDecodeOptionsV1 } from "../../workflow-contracts/outcome.js";
import { formatStepRejectionSentence } from "../retry-disposition.js";

export interface QualityPresentationContext {
  readonly record: RunRecord;
  readonly recordPath: string;
  readonly quiet?: boolean;
  readonly editorialDecodeOptions?: WorkflowOutcomeDecodeOptionsV1;
  readonly reviewFindingsProjection?: ProjectedReviewFindingsV1;
  readonly reviewEvidenceProjection?: ReviewEvidenceProjectionV1;
  readonly reportServeCommand?: string;
  readonly reportUnavailableReason?: string;
  readonly htmlReportUrl?: string;
  readonly htmlReportPath?: string;
  readonly markdownReportPath?: string | null;
  readonly markdownReportAvailable?: boolean;
  readonly markdownReportUnavailableReason?: "byte-bound" | "artifact-unavailable";
}

/** Return only QUALITY body lines; the caller decides whether and where to render the section. */
export function formatQualitySectionLines(
  context: QualityPresentationContext,
): string[] | undefined {
  const { record } = context;
  const {
    quality,
    error: qualityError,
    limitation: qualityLimitation,
  } = inspectQualityReportFromRun(record, {
    qualityNotApplicable:
      projectRunEditorialOutcome(record, context.editorialDecodeOptions).outcome ===
      "verified-no-change",
  });
  const evaluator =
    !quality && Array.isArray(record.steps)
      ? [...record.steps].reverse().find((step) => step?.skill === "evaluate-document-quality")
      : undefined;
  const rejection = evaluator && formatStepRejectionSentence(evaluator);
  if (
    !quality &&
    !qualityError &&
    !qualityLimitation &&
    !rejection &&
    !context.reviewEvidenceProjection &&
    !(
      record.workflow === "review-documentation" &&
      (context.reportServeCommand || context.reportUnavailableReason)
    )
  ) {
    return undefined;
  }
  const qualityLines = quality
    ? [
        `Decision: ${quality.decision}`,
        `Confidence: ${quality.confidence}`,
        quality.rubric.status === "available"
          ? `Score: ${quality.rubric.total}/100 (${quality.rubric.interpretationBand}; threshold ${quality.rubric.threshold})`
          : `Score: unavailable (${quality.rubric.reason})`,
        `Hard-gate failures: ${quality.hardGateFailures.length}`,
        context.htmlReportUrl
          ? `Report: ${context.htmlReportUrl}`
          : context.reportUnavailableReason
            ? `Report: ${context.reportUnavailableReason}`
            : `Report: artifact-digest:${quality.reportLocator.digestSha256}`,
        ...(quality.limitations.length > 0
          ? quality.limitations.map((limitation) => `Limitation: ${limitation}`)
          : [
              "Limitation: no structured limitations were projected; inspect the retained evaluator report.",
            ]),
      ]
    : [
        "Quality: unavailable/not projected",
        context.htmlReportUrl
          ? `Report: ${context.htmlReportUrl}`
          : `Report: ${context.reportUnavailableReason ?? "unavailable"}`,
      ];
  if (qualityError) qualityLines.unshift(qualityError);
  if (qualityLimitation) qualityLines.push(`Limitation: ${qualityLimitation}`);
  if (rejection) qualityLines.push(rejection);
  if (qualityLimitation === "quality-envelope-json") {
    qualityLines.push("No quality evaluation or quality score is recorded.");
  }
  if (context.reviewFindingsProjection) {
    qualityLines.push(
      `Review findings: ${context.reviewFindingsProjection.availability} (${context.reviewFindingsProjection.findings.length})`,
      `Review findings projector: ${context.reviewFindingsProjection.projector}`,
    );
    if (context.reviewFindingsProjection.artifactLocator) {
      qualityLines.push(
        `Review findings artifact: ${context.reviewFindingsProjection.artifactLocator}`,
      );
    }
    // The limitation list prints once per run: in REVIEW FINDINGS when that
    // section renders, otherwise here (for example under --quiet).
    if (!showsReviewFindingsSection(context)) {
      qualityLines.push(
        ...formatReviewFindingLimitationLines(
          context.reviewFindingsProjection.limitations,
          "Review findings limitation: ",
          record,
          context.recordPath,
        ),
      );
    }
  }
  if (context.reviewEvidenceProjection) {
    const evidence = context.reviewEvidenceProjection;
    qualityLines.push(
      `Review method: ${evidence.reviewMethod}`,
      `Package command checks: ${evidence.packageChecks}`,
      `Artifact validators: ${evidence.artifactValidators}`,
      `Human audience evidence: ${evidence.audience.human}`,
      `Agent audience evidence: ${evidence.audience.agent}`,
    );
  }
  if (context.htmlReportPath) qualityLines.push(`HTML path: ${context.htmlReportPath}`);
  if (context.markdownReportAvailable && context.markdownReportPath) {
    qualityLines.push(`Markdown path: ${context.markdownReportPath}`);
  } else if (context.markdownReportAvailable === false) {
    qualityLines.push(
      `Markdown path: unavailable (${context.markdownReportUnavailableReason ?? "unknown"})`,
    );
  }
  return qualityLines;
}

/**
 * REVIEW FINDINGS renders for authoring workflows, `review-documentation`, and
 * the template audit, whose callers preload a findings projection. Other
 * workflows and `--quiet` keep the count-only QUALITY lines.
 */
export function showsReviewFindingsSection(context: QualityPresentationContext): boolean {
  if (context.quiet || !context.reviewFindingsProjection) return false;
  return (
    isAuthoringQualityOutcomeWorkflow(context.record.workflow) ||
    context.record.workflow === "review-documentation" ||
    context.record.workflow === TEMPLATE_AUDIT_WORKFLOW
  );
}

const REVIEW_FINDING_DISPLAY_ORDER: readonly ReviewFindingV1["severity"][] = [
  "error",
  "warning",
  "info",
];

/** Display order only; the projection and the JSON keep their own id order. */
function rankReviewFindingsForDisplay(findings: readonly ReviewFindingV1[]): ReviewFindingV1[] {
  return [...findings].sort(
    (left, right) =>
      REVIEW_FINDING_DISPLAY_ORDER.indexOf(left.severity) -
        REVIEW_FINDING_DISPLAY_ORDER.indexOf(right.severity) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
}

/**
 * The top `reviewFindings.summaryTopN` admitted findings, a "shown N of M" line
 * when clipped, then the limitation list.
 */
export function formatReviewFindingsSection(
  projection: ProjectedReviewFindingsV1,
  record: RunRecord,
  recordPath: string,
): string[] {
  const lines = [
    `Availability: ${projection.availability} (${projection.findings.length})`,
    `Projector: ${projection.projector}`,
    projection.artifactLocator
      ? `Artifact: ${projection.artifactLocator}`
      : "Artifact: none; source: admitted run-step summaries",
  ];
  const ranked = rankReviewFindingsForDisplay(projection.findings);
  const shown = ranked.slice(0, limit("reviewFindings.summaryTopN").value);
  for (const finding of shown) {
    lines.push(...formatReviewFinding(finding));
  }
  // Only a clipped list gets the line: every admitted finding is in the JSON.
  if (shown.length < ranked.length) {
    lines.push(
      `Findings shown: ${shown.length} of ${ranked.length} (severity, then id); ` +
        `${ranked.length - shown.length} more: ${runsShowJsonCommand(record, recordPath)}`,
    );
  }
  lines.push(
    ...formatReviewFindingLimitationLines(
      projection.limitations,
      "Limitation: ",
      record,
      recordPath,
    ),
  );
  return lines;
}

/**
 * Per-item limitation families the human result counts instead of listing.
 * Every other limitation stays verbatim; JSON keeps every code.
 */
const COLLAPSED_REVIEW_LIMITATION_FAMILY =
  /^(review-finding-fact-source-[a-z]+|review-finding-location-[a-z]+|review-findings-duplicate|review-finding-fact-metadata-omitted|review-finding-fact-statement-omitted):/u;

function formatReviewFindingLimitationLines(
  limitations: readonly string[],
  prefix: string,
  record: RunRecord,
  recordPath: string,
): string[] {
  const verbatim: string[] = [];
  const counts = new Map<string, number>();
  for (const limitation of limitations) {
    const family = COLLAPSED_REVIEW_LIMITATION_FAMILY.exec(limitation)?.[1];
    if (family === undefined) verbatim.push(`${prefix}${limitation}`);
    else counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  const collapsed = [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([family, count]) => `${prefix}${family}: ${count}`);
  return collapsed.length === 0
    ? verbatim
    : [
        ...verbatim,
        ...collapsed,
        `${prefix}per-item codes counted above are listed by ${runsShowJsonCommand(record, recordPath)}`,
      ];
}

/** Replay command for the full JSON (`reviewFindings`, `product.limitations`). */
function runsShowJsonCommand(record: RunRecord, recordPath: string): string {
  return `docsfab runs show ${quoteSummaryArgument(record.id)} --json --state-dir ${quoteSummaryArgument(dirname(recordPath))}`;
}

export function quoteSummaryArgument(value: string): string {
  return /^[A-Za-z0-9_.\-/:@]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function formatReviewFinding(finding: ReviewFindingV1): string[] {
  const location = finding.path
    ? `${finding.path}${finding.line === undefined ? "" : `:${finding.line}`}`
    : "location unavailable";
  return [
    `[${finding.severity}] ${finding.code} at ${location}: ${finding.summary}`,
    `Identity: ${finding.id}; origin: ${finding.origin ?? "unavailable"}`,
    `Evidence: ${finding.evidence ?? "unavailable"}`,
    `Recommendation: ${finding.recommendation ?? "unavailable"}`,
  ];
}
