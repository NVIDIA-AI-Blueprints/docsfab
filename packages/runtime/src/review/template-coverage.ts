// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Per-page view of the existing host template audit retained by a review run. */
import type { RunRecord } from "../records/contracts.js";
import { parseJsonEvidence } from "../operator/json-evidence.js";
import {
  decodeTemplateAuditReport,
  templateAuditReviewFindings,
  type TemplateAuditPageV1,
  type TemplateAuditReportV1,
} from "../templates/audit.js";
import { isPlainRecord } from "../shared/primitives.js";
import type { ReviewFindingV1, ReviewTemplateCoverageV1 } from "./contracts.js";

/** Only the existing lint host step may supply this report; no audit is rerun here. */
export function reviewTemplateAuditReport(
  record: Pick<RunRecord, "steps">,
): TemplateAuditReportV1 | undefined {
  const step = record.steps.find((candidate) => candidate.id === "lint-documentation");
  if (!step?.summary) return undefined;
  try {
    const summary: unknown = parseJsonEvidence(step.summary.trim());
    if (!isPlainRecord(summary) || summary.templateConformance === undefined) return undefined;
    return decodeTemplateAuditReport(summary.templateConformance);
  } catch {
    // The review result keeps these pages unknown; findings projection records
    // the invalid audit evidence as a limitation.
    return undefined;
  }
}

function pageCoverage(
  path: string,
  page: TemplateAuditPageV1 | undefined,
  suggestions: ReadonlyMap<string, readonly string[]>,
): ReviewTemplateCoverageV1["pages"][number] {
  const rubric = {
    status: "unknown" as const,
    reason: "Selected rubric evidence is unavailable for this review run.",
  };
  if (!page) {
    return {
      path,
      mapping: "unknown",
      applicability: "unknown",
      reason: "No retained template audit covered this page.",
      templateId: null,
      conformance: "unknown",
      rules: [],
      suggestionIds: [],
      rubric,
    };
  }
  if (page.status === "refused") {
    return {
      path,
      mapping: "unknown",
      applicability: "unknown",
      reason: `Template audit refused this page: ${page.code}.`,
      templateId: null,
      conformance: "unknown",
      rules: [],
      suggestionIds: [],
      rubric,
    };
  }
  if (page.status === "unmapped") {
    const index = page.reason === "section-index";
    return {
      path,
      mapping: "unmapped",
      applicability: index ? "not-applicable" : "unknown",
      reason: index
        ? "This section index is navigation; the page template audit does not apply."
        : `No applicable page template was established: ${page.reason}.`,
      templateId: null,
      conformance: index ? "not-applicable" : "unknown",
      rules: [],
      suggestionIds: [],
      rubric,
    };
  }
  return {
    path,
    mapping: "mapped",
    applicability: "applicable",
    reason: `Mapped by ${page.basis}: ${page.signal}.`,
    templateId: page.templateId,
    conformance: page.status,
    rules: page.findings.map((finding) => ({
      rule: finding.rule,
      severity: finding.severity,
      expected: finding.expected,
      line: finding.line,
    })),
    suggestionIds: suggestions.get(path) ?? [],
    rubric,
  };
}

/** Preserve every admitted page, including unknowns, in target order. */
export function reviewTemplateCoverageFromRun(input: {
  readonly record: Pick<RunRecord, "steps">;
  readonly targetPaths: readonly string[];
  readonly findings: readonly ReviewFindingV1[];
}): ReviewTemplateCoverageV1 {
  const report = reviewTemplateAuditReport(input.record);
  const pages = new Map(report?.pages.map((page) => [page.path, page]) ?? []);
  const presentIds = new Set(input.findings.map((finding) => finding.id));
  const suggestions = new Map<string, string[]>();
  for (const finding of report ? templateAuditReviewFindings(report) : []) {
    if (!presentIds.has(finding.id)) continue;
    suggestions.set(finding.path, [...(suggestions.get(finding.path) ?? []), finding.id]);
  }
  return {
    reportDigest: report?.digest ?? null,
    pages: input.targetPaths.map((path) => pageCoverage(path, pages.get(path), suggestions)),
  };
}
