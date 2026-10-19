// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Literal GitHub review text derived only from the sealed D1 plan. */
import { assertHostedReportUrl } from "../../evaluation-report/hosted-report.js";
import type { ReviewDeliveryAction, ReviewDeliveryPlan } from "../contracts.js";

function literal(value: string): string {
  let longest = 2;
  for (const run of value.matchAll(/~+/gu)) longest = Math.max(longest, run[0].length);
  const fence = "~".repeat(longest + 1);
  return `${fence}text\n${value}${value.endsWith("\n") || value.endsWith("\r") ? "" : "\n"}${fence}`;
}

function safeReportLink(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    const url = assertHostedReportUrl(value);
    return `[Hosted report](<${url.replace(/>/gu, "%3E")}>)`;
  } catch {
    return null;
  }
}

function findingFor(plan: ReviewDeliveryPlan, id: string) {
  return plan.findings.find((finding) => finding.inventoryId === id);
}

export function renderGithubReviewBody(
  plan: ReviewDeliveryPlan,
  summary: Extract<ReviewDeliveryAction, { kind: "publish-summary" }> | undefined,
  createMarker: string,
): string {
  const sections = ["DocsFab documentation review", `<!-- docsfab-review:${createMarker} -->`];
  if (summary) {
    for (const id of summary.findingIds) {
      const finding = findingFor(plan, id);
      if (!finding) throw new Error("The summary action names an absent retained finding.");
      sections.push(`Summary finding (${finding.severity}):`, literal(finding.text));
    }
  }
  const report = safeReportLink(plan.result.hostedReportUrl);
  if (report) sections.push(report);
  sections.push(
    `Review scope: ${plan.findings.length} retained findings; ${plan.checks.length} checks; ${plan.unresolvedQuestions.length} open questions.`,
  );
  return sections.join("\n\n");
}

/** Full overview for an explicitly requested summary or a fresh summary action. */
export function renderGithubOverviewBody(
  plan: ReviewDeliveryPlan,
  summary: Extract<ReviewDeliveryAction, { kind: "publish-summary" }> | undefined,
  createMarker: string,
): string {
  const selected = new Set(summary?.findingIds ?? []);
  const inline = new Set(
    plan.actions
      .filter(
        (action): action is Extract<ReviewDeliveryAction, { kind: "publish-inline" }> =>
          action.kind === "publish-inline",
      )
      .map((action) => action.findingId),
  );
  const retained = plan.findings.filter(
    (finding) => !selected.has(finding.inventoryId) && !inline.has(finding.inventoryId),
  );
  const unsupported = retained.filter((finding) => finding.disposition.kind === "unsupported");
  const sections = [
    "DocsFab documentation review",
    `<!-- docsfab-review:${createMarker} -->`,
    plan.target.scmProvider === "github"
      ? `Target: GitHub repository ${plan.target.repositoryId}, pull request #${plan.target.pullRequestNumber}.`
      : "Target: sealed review request.",
    "Reviewed head:",
    literal(plan.result.reviewedHeadSha),
    `Retained findings: ${plan.findings.length}; selected summary: ${selected.size}; inline comments: ${inline.size}; unposted retained: ${retained.length}; unsupported: ${unsupported.length}.`,
  ];
  for (const id of summary?.findingIds ?? []) {
    const finding = findingFor(plan, id);
    if (!finding) throw new Error("The summary action names an absent retained finding.");
    sections.push(`Summary finding (${finding.severity}):`, literal(finding.text));
  }
  if (inline.size > 0)
    sections.push(
      "Inline findings are in the review's native comments; their prose is not duplicated here.",
    );
  for (const action of plan.actions) {
    if (action.kind !== "publish-inline") continue;
    sections.push("Inline comment finding:", literal(action.findingId));
  }
  for (const finding of retained) {
    sections.push("Not published retained finding:", literal(finding.inventoryId));
    if (finding.disposition.kind === "unsupported")
      sections.push("Reason:", literal(finding.disposition.reason));
  }
  for (const finding of plan.findings)
    for (const limitation of finding.limitations)
      sections.push("Finding limitation for:", literal(finding.inventoryId), literal(limitation));
  sections.push(`Checks: ${plan.checks.length}.`);
  for (const check of plan.checks)
    sections.push("Check:", literal(check.name), `Status: ${check.status}.`);
  sections.push(`Open questions: ${plan.unresolvedQuestions.length}.`);
  for (const question of plan.unresolvedQuestions)
    sections.push("Question:", literal(question.summary));
  sections.push(
    "Review scope:",
    plan.reviewScope ? literal(plan.reviewScope.scope) : "Not recorded.",
  );
  if (plan.reviewScope) {
    sections.push(
      `Reviewed pages: ${plan.reviewScope.reviewedCount}; corpus pages: ${plan.reviewScope.corpusFileCount ?? "unknown"}.`,
    );
    const accounting = plan.reviewScope.accounting;
    sections.push(
      `Coverage accounting: radius ${accounting.radiusPageCount}; listed ${accounting.listedPageCount}; unlisted ${accounting.unlistedPageCount}; unreviewable neighbours ${accounting.unreviewableNeighbourCount}; changed paths ${accounting.changedPathCount ?? "unknown"}; continuation character limit ${accounting.continuationCharacterLimit}.`,
    );
    for (const path of plan.reviewScope.anchorPaths) sections.push("Anchor path:", literal(path));
    for (const path of plan.reviewScope.deferredPaths)
      sections.push("Deferred path:", literal(path));
    if (plan.reviewScope.continuationLocator !== undefined)
      sections.push("Continuation locator:", literal(plan.reviewScope.continuationLocator));
    const coverage = plan.reviewScope.templateCoverage;
    sections.push(
      "Template coverage report:",
      coverage?.reportDigest === undefined || coverage.reportDigest === null
        ? "Not retained."
        : literal(coverage.reportDigest),
    );
    for (const page of coverage?.pages ?? []) {
      sections.push(
        "Template page:",
        literal(page.path),
        `Mapping: ${page.mapping}; applicability: ${page.applicability}; conformance: ${page.conformance}; rubric: ${page.rubric.status}.`,
        "Reason:",
        literal(page.reason),
        "Rubric reason:",
        literal(page.rubric.reason),
      );
      if (page.templateId !== null) sections.push("Template ID:", literal(page.templateId));
      for (const rule of page.rules)
        sections.push(
          "Template rule:",
          literal(rule.rule),
          `Severity: ${rule.severity}; line: ${rule.line ?? "unknown"}.`,
          "Expected:",
          literal(rule.expected),
        );
      for (const id of page.suggestionIds)
        sections.push("Retained template suggestion ID:", literal(id));
    }
  }
  for (const path of plan.affectedPaths) sections.push("Affected path:", literal(path));
  for (const skipped of plan.result.skippedPaths ?? [])
    sections.push("Skipped path:", literal(skipped.path), "Reason:", literal(skipped.reason));
  for (const limitation of plan.limitations)
    sections.push("Review limitation:", literal(limitation));
  const report = safeReportLink(plan.result.hostedReportUrl);
  if (report) sections.push("Hosted report candidate (audience access unconfirmed):", report);
  return sections.join("\n\n");
}

export function renderGithubInlineBody(
  plan: ReviewDeliveryPlan,
  action: Extract<ReviewDeliveryAction, { kind: "publish-inline" }>,
  createMarker: string,
): string {
  const finding = findingFor(plan, action.findingId);
  if (!finding) throw new Error("The inline action names an absent retained finding.");
  return [
    `DocsFab finding (${finding.severity})`,
    `<!-- docsfab-review:${createMarker}:${action.id} -->`,
    literal(finding.text),
  ].join("\n\n");
}
