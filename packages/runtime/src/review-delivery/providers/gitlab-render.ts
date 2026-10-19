// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertHostedReportUrl } from "../../evaluation-report/hosted-report.js";
import type { ReviewDeliveryPlan } from "../contracts.js";

interface RenderFinding {
  readonly inventoryId: string;
  readonly severity: string;
  readonly text: string;
  readonly path: string | null;
}

/** Keep provider and producer text on one inert physical Markdown line. */
function inert(value: string): string {
  return value
    .replace(/\r\n?|\n/gu, " ")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/\\/gu, "&#92;")
    .replace(/([`*_{}\[\]()#+.!|>~-])/gu, "\\$1")
    .replace(/@/gu, "&#64;&#8203;")
    .replace(/https?:\/\//giu, (scheme) => `${scheme.slice(0, -3)}&#58;//`)
    .replace(/www\./giu, (prefix) => `${prefix.slice(0, -1)}&#46;`)
    .replace(/(^|\s)\/(\w)/gu, "$1/\u200b$2");
}

function trustedLink(url: string): string {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    /[\r\n\\()]/u.test(url)
  )
    throw new Error("GitLab review link must be a safe HTTPS URL.");
  return url;
}

export function renderGitLabReviewFinding(
  input: RenderFinding & { readonly marker: string },
): string {
  return [
    `DocsFab review finding (${inert(input.severity)})`,
    "",
    inert(input.text),
    ...(input.path === null ? [] : ["", `Path: ${inert(input.path)}`]),
    "",
    `Finding: ${inert(input.inventoryId)}`,
    `Review effect: ${input.marker}`,
  ].join("\n");
}

export function renderGitLabReviewSummary(input: {
  readonly findings: readonly RenderFinding[];
  readonly inlineCount: number;
  readonly reviewedHeadSha: string;
  readonly mrUrl: string;
  readonly reportUrl: string | null;
  readonly threadUrls: readonly string[];
  readonly marker: string;
}): string {
  const report = input.reportUrl === null ? null : assertHostedReportUrl(input.reportUrl);
  const lines = [
    "DocsFab review summary",
    "",
    `Reviewed head: ${inert(input.reviewedHeadSha)}`,
    `${input.findings.length} summary finding${input.findings.length === 1 ? "" : "s"}; ${input.inlineCount} inline finding${input.inlineCount === 1 ? "" : "s"}.`,
    "",
    `Merge request: [open review](${trustedLink(input.mrUrl)})`,
    ...(report === null
      ? ["Report link unavailable from the retained result."]
      : [`Report: [review report](${report})`]),
    ...input.threadUrls.map(
      (url, index) => `Discussion ${index + 1}: [open thread](${trustedLink(url)})`,
    ),
    "",
    ...input.findings.map(
      (finding) =>
        `- ${inert(finding.severity)}: ${inert(finding.text)}${finding.path === null ? "" : ` (${inert(finding.path)})`}`,
    ),
    "",
    `Review effect: ${input.marker}`,
  ];
  return lines.join("\n");
}

/** Rich content for newly prepared explicit overviews and summaries. Legacy bytes stay frozen. */
export function renderGitLabReviewOverview(input: {
  readonly plan: ReviewDeliveryPlan;
  readonly selectedFindingIds: readonly string[];
  readonly inlineCount: number;
  readonly reviewedHeadSha: string;
  readonly mrUrl: string;
  readonly reportUrl: string | null;
  readonly threadUrls: readonly string[];
  readonly marker: string;
}): string {
  const selected = new Set(input.selectedFindingIds);
  const findings = input.selectedFindingIds.map((id) => {
    const finding = input.plan.findings.find((item) => item.inventoryId === id);
    if (!finding) throw new Error("GitLab summary finding is absent from retained inventory.");
    return finding;
  });
  const legacy = renderGitLabReviewSummary({ ...input, findings });
  const lines = legacy.split("\n");
  lines.splice(lines.length - 1, 1);
  const inline = new Set(
    input.plan.actions.flatMap((action) =>
      action.kind === "publish-inline" ? [action.findingId] : [],
    ),
  );
  const retained = input.plan.findings.filter(
    (finding) => !selected.has(finding.inventoryId) && !inline.has(finding.inventoryId),
  );
  const scope = input.plan.reviewScope;
  lines.push(
    "Retained review inventory",
    `Total: ${input.plan.findings.length}; summary: ${selected.size}; inline planned: ${inline.size}; not published: ${retained.length}.`,
    scope === undefined
      ? "Coverage: not supplied by the retained result."
      : `Coverage: ${inert(scope.scope)}; reviewed ${scope.reviewedCount}; tracked corpus ${scope.corpusFileCount === null ? "uncounted" : scope.corpusFileCount}.`,
    ...(scope?.templateCoverage === undefined
      ? []
      : [
          `Template audit digest: ${scope.templateCoverage.reportDigest ?? "unavailable"}.`,
          ...scope.templateCoverage.pages.flatMap((page) => [
            `Template coverage: ${inert(page.path)}; mapping ${inert(page.mapping)}${page.templateId === null ? "" : ` (${inert(page.templateId)})`}; applicability ${inert(page.applicability)}; conformance ${inert(page.conformance)}; ${inert(page.reason)}; rubric ${inert(page.rubric.status)} (${inert(page.rubric.reason)}).`,
            ...page.rules.map(
              (rule) =>
                `Template rule: ${inert(page.path)}; ${inert(rule.rule)}; ${inert(rule.severity)}; expected ${inert(rule.expected)}${rule.line === null ? "" : `; line ${rule.line}`}.`,
            ),
            ...page.suggestionIds.map(
              (id) => `Template suggestion: ${inert(page.path)}; ${inert(id)}.`,
            ),
          ]),
        ]),
    ...((scope?.deferredPaths ?? []).length === 0
      ? []
      : ["Deferred paths:", ...scope!.deferredPaths.map((path) => `- ${inert(path)}`)]),
    ...((input.plan.result.skippedPaths ?? []).length === 0
      ? []
      : [
          "Skipped paths:",
          ...input.plan.result.skippedPaths!.map(
            (path) => `- ${inert(path.path)}: ${inert(path.reason)}`,
          ),
        ]),
    "Checks:",
    ...(input.plan.checks.length === 0
      ? ["- None recorded."]
      : input.plan.checks.map((check) => `- ${inert(check.name)}: ${inert(check.status)}`)),
    "Unresolved questions:",
    ...(input.plan.unresolvedQuestions.length === 0
      ? ["- None recorded."]
      : input.plan.unresolvedQuestions.map((question) => `- ${inert(question.summary)}`)),
    "Limitations:",
    ...(input.plan.limitations.length === 0
      ? ["- None recorded."]
      : input.plan.limitations.map((limitation) => `- ${inert(limitation)}`)),
    ...findings.flatMap((finding) => [
      `Summary candidate ${inert(finding.inventoryId)}: ${inert(finding.disposition.kind === "summary-candidate" ? finding.disposition.reason : "retained")}.`,
      ...finding.limitations.map((limitation) => `- ${inert(limitation)}`),
    ]),
    ...(retained.length === 0
      ? []
      : [
          "Not published from retained inventory:",
          ...retained.map(
            (finding) =>
              `- ${inert(finding.inventoryId)}: ${inert(finding.disposition.kind === "unsupported" ? finding.disposition.reason : "no planned publication")}`,
          ),
        ]),
    "",
    `Review effect: ${input.marker}`,
  );
  return lines.join("\n");
}
