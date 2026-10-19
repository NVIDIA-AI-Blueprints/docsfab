// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import type { HarnessStepInput } from "../src/execution/contracts.js";
import { createReviewResultV2, decodeReviewResultV2 } from "../src/review/index.js";
import { reviewCoverageFromRun } from "../src/review/run-result.js";
import { reviewTemplateCoverageFromRun } from "../src/review/template-coverage.js";
import { composeReviewPlacement } from "../src/review-delivery/placement.js";
import { renderSummaryPresentation } from "../src/review-delivery/inline-presentation.js";
import type { RunRecord } from "../src/records/contracts.js";
import { withRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import {
  auditTemplateConformance,
  templateAuditReviewFindings,
  type TemplateAuditReportV1,
} from "../src/templates/audit.js";
import type { GovernedTemplateBundle } from "../src/templates/contracts.js";
import { loadTemplateSet, prepareTemplateSet } from "../src/templates/load.js";
import { WorkflowChecksHostOperation } from "../src/workflow-execution/workflow-checks.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { fixture } from "./fixtures/review-delivery/presentation/synthetic.js";
import { initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = [
  "docs/tutorial.md",
  "docs/reference/environment-variables.md",
  "docs/concepts/overview.md",
  "docs/index.md",
];
let bundle: GovernedTemplateBundle;
const roots = temporaryRoots();

beforeAll(async () => {
  bundle = await loadTemplateSet(projectRoot);
});

function report(
  referenceContent = "# Environment Variables\n\n## General Environment Variables\n\nA value.\n",
): TemplateAuditReportV1 {
  return auditTemplateConformance({
    bundle,
    pages: [
      {
        path: paths[0]!,
        content: "# Build a Pipeline\n\n## Concepts Overview\n\n## Summary\n\n## Next Steps\n",
      },
      { path: paths[1]!, content: referenceContent },
      { path: paths[2]!, content: "# Overview\n\nNo template declaration.\n" },
      { path: paths[3]!, content: "# Documentation\n\nNavigation only.\n" },
    ],
    scope: { kind: "focused-set", enumeration: "complete", omittedEntries: 0, limitations: [] },
  });
}

function runWithAudit(
  audit?: TemplateAuditReportV1,
  status: "succeeded" | "failed" | "unavailable" = "succeeded",
): RunRecord {
  return {
    workflow: "review-documentation",
    repository: { revision: "b".repeat(40) },
    reviewScope: {
      scope: "focused-set",
      reason: "operator-named",
      targetPaths: paths,
      deferredPaths: [],
      scopeSha256: "d".repeat(64),
      corpusFileCount: paths.length,
    },
    steps: audit
      ? [
          {
            id: "lint-documentation",
            skill: "lint-documentation",
            status,
            summary: JSON.stringify({ checks: [], templateConformance: audit }),
          },
        ]
      : [],
  } as unknown as RunRecord;
}

describe("review template coverage", () => {
  it("consumes the existing host audit during a read-only focused PR review", async () => {
    const root = await roots.create("docsfab-review-template-coverage-");
    const repository = resolve(root, "repository");
    const revision = await initFixtureRepo(repository, {
      "docs/tutorial.md":
        "# Build a Pipeline\n\n## Concepts Overview\n\n## Summary\n\n## Next Steps\n",
      "docs/index.md": "# Documentation\n\nNavigation only.\n",
    });
    await withRepositoryWorkspace(repository, revision, async (workspace) => {
      const workflow = getWorkflow("review-documentation");
      const step = workflow.steps.find((candidate) => candidate.id === "lint-documentation");
      if (!step) throw new Error("Expected review lint step");
      const host = new WorkflowChecksHostOperation(workspace, "lint-documentation", {
        templates: await prepareTemplateSet(projectRoot),
      });
      const result = await host.runStep({
        workflow,
        step,
        repositoryPath: workspace.path,
        reviewScope: {
          scope: "focused-set",
          reason: "operator-named",
          targetPaths: ["docs/tutorial.md", "docs/index.md"],
          deferredPaths: [],
          scopeSha256: "d".repeat(64),
          corpusFileCount: 2,
        },
      } as HarnessStepInput);
      const retained = JSON.parse(result.summary ?? "null") as {
        templateConformance?: TemplateAuditReportV1;
      };
      expect(retained.templateConformance?.pages.map((page) => [page.path, page.status])).toEqual([
        ["docs/index.md", "unmapped"],
        ["docs/tutorial.md", "failed"],
      ]);
    });
  });

  it("keeps mapped, unmapped, not-applicable and unknown pages distinct with actual rule evidence", () => {
    const audit = report();
    const suggestions = templateAuditReviewFindings(audit);
    const coverage = reviewTemplateCoverageFromRun({
      record: runWithAudit(audit),
      targetPaths: paths,
      findings: suggestions,
    });
    expect(coverage.reportDigest).toBe(audit.digest);
    expect(
      coverage.pages.map((page) => [page.mapping, page.applicability, page.conformance]),
    ).toEqual([
      ["mapped", "applicable", "failed"],
      ["mapped", "applicable", "passed"],
      ["unmapped", "unknown", "unknown"],
      ["unmapped", "not-applicable", "not-applicable"],
    ]);
    expect(coverage.pages[0]).toMatchObject({
      templateId: "beginner-tutorial-gfm",
      rules: [{ rule: "missing-required-heading", expected: "h2:Prerequisites" }],
      suggestionIds: [suggestions[0]!.id],
    });
    expect(coverage.pages[1]).toMatchObject({ rules: [], suggestionIds: [] });
    expect(suggestions.some((finding) => finding.path === paths[1])).toBe(false);
    expect(coverage.pages[3]!.reason).toMatch(/navigation/u);
    expect(coverage.pages.every((page) => page.rubric.status === "unknown")).toBe(true);
  });

  it("retains template coverage when another lint check fails or is unavailable", () => {
    const audit = report();
    const suggestions = templateAuditReviewFindings(audit);
    for (const status of ["failed", "unavailable"] as const) {
      const coverage = reviewTemplateCoverageFromRun({
        record: runWithAudit(audit, status),
        targetPaths: paths,
        findings: suggestions,
      });
      expect(coverage.reportDigest).toBe(audit.digest);
      expect(coverage.pages[0]).toMatchObject({
        mapping: "mapped",
        conformance: "failed",
        suggestionIds: [suggestions[0]!.id],
      });
    }
  });

  it("reports absent or invalid audit evidence as unknown without a fabricated correction", () => {
    const missing = reviewTemplateCoverageFromRun({
      record: runWithAudit(),
      targetPaths: paths,
      findings: [],
    });
    expect(missing.reportDigest).toBeNull();
    expect(missing.pages).toHaveLength(paths.length);
    expect(
      missing.pages.every((page) => page.mapping === "unknown" && page.suggestionIds.length === 0),
    ).toBe(true);
    const audit = report();
    const invalid = runWithAudit({ ...audit, digest: "a".repeat(64) });
    expect(
      reviewTemplateCoverageFromRun({ record: invalid, targetPaths: paths, findings: [] }),
    ).toEqual(missing);
  });

  it("seals a passed page with warning-only template rules and its retained suggestion", () => {
    const audit = report(
      "# Environment Variables\n\n## General Environment Variables\n\nA value for [ORG].\n",
    );
    const suggestions = templateAuditReviewFindings(audit);
    const warning = suggestions.find((finding) => finding.path === paths[1]);
    expect(warning).toMatchObject({
      severity: "warning",
      code: "template:unresolved-template-placeholder",
    });
    const coverage = reviewTemplateCoverageFromRun({
      record: runWithAudit(audit),
      targetPaths: paths,
      findings: suggestions,
    });
    expect(coverage.pages[1]).toMatchObject({
      mapping: "mapped",
      conformance: "passed",
      rules: [{ rule: "unresolved-template-placeholder", severity: "warning" }],
      suggestionIds: [warning!.id],
    });
    const seed = fixture("gitlab");
    const original = seed.result;
    const result = createReviewResultV2(seed.target, seed.source, {
      taskId: original.taskId,
      runIdSha256: original.runIdSha256,
      findings: suggestions,
      checks: original.checks,
      unresolvedQuestions: original.unresolvedQuestions,
      affectedPaths: original.affectedPaths,
      patchLocator: original.patchLocator,
      locatorSha256: original.locatorSha256,
      reviewScope: {
        ...seed.result.reviewScope!,
        reviewedCount: paths.length,
        corpusFileCount: paths.length,
        deferredPaths: [],
        accounting: {
          ...seed.result.reviewScope!.accounting,
          radiusPageCount: paths.length,
          listedPageCount: paths.length,
          changedPathCount: 1,
        },
        templateCoverage: coverage,
      },
    });
    expect(decodeReviewResultV2(result).reviewScope?.templateCoverage?.pages[1]).toMatchObject({
      conformance: "passed",
      suggestionIds: [warning!.id],
    });
    const composition = composeReviewPlacement({
      ...seed,
      result,
      artifact: { ...seed.artifact, resultSha256: result.resultSha256 },
    });
    const action = composition.plan.actions.find((item) => item.kind === "publish-summary");
    if (!action || action.kind !== "publish-summary") throw new Error("Expected summary plan");
    const rendered = renderSummaryPresentation(composition, action);
    expect(rendered.body).toContain("unresolved-template-placeholder · warning");
    expect(rendered.body).toContain(warning!.id);
  });

  it("survives sealing, result projection and D1/D2 presentation without losing suggestion identity", () => {
    const audit = report();
    const suggestions = templateAuditReviewFindings(audit);
    const run = runWithAudit(audit);
    const scope = reviewCoverageFromRun(run, undefined, undefined, suggestions)!;
    const seed = fixture("gitlab");
    const original = seed.result;
    const resultInput = {
      taskId: original.taskId,
      runIdSha256: original.runIdSha256,
      findings: suggestions,
      checks: original.checks,
      unresolvedQuestions: original.unresolvedQuestions,
      affectedPaths: original.affectedPaths,
      patchLocator: original.patchLocator,
      locatorSha256: original.locatorSha256,
      reviewScope: {
        ...seed.result.reviewScope!,
        reviewedCount: paths.length,
        corpusFileCount: paths.length,
        deferredPaths: [],
        accounting: {
          ...seed.result.reviewScope!.accounting,
          radiusPageCount: paths.length,
          listedPageCount: paths.length,
          changedPathCount: 1,
        },
        templateCoverage: scope.templateCoverage,
      },
    };
    const result = createReviewResultV2(seed.target, seed.source, resultInput);
    const pages = resultInput.reviewScope.templateCoverage!.pages;
    expect(() =>
      createReviewResultV2(seed.target, seed.source, {
        ...resultInput,
        reviewScope: {
          ...resultInput.reviewScope,
          templateCoverage: {
            ...resultInput.reviewScope.templateCoverage!,
            pages: [{ ...pages[0]!, suggestionIds: ["finding:missing"] }, ...pages.slice(1)],
          },
        },
      }),
    ).toThrow(/invalid-value/u);
    expect(decodeReviewResultV2(result).reviewScope?.templateCoverage).toEqual(
      scope.templateCoverage,
    );
    const composition = composeReviewPlacement({
      ...seed,
      result,
      artifact: { ...seed.artifact, resultSha256: result.resultSha256 },
    });
    expect(composition.plan.reviewScope?.templateCoverage).toEqual(scope.templateCoverage);
    expect(composition.manifest.reviewScope?.templateCoverage).toEqual(scope.templateCoverage);
    const action = composition.plan.actions.find((item) => item.kind === "publish-summary");
    if (!action || action.kind !== "publish-summary") throw new Error("Expected summary plan");
    const rendered = renderSummaryPresentation(composition, action);
    expect(rendered.body).toContain("Template coverage: docs/tutorial.md");
    expect(rendered.body).toContain("Template coverage: docs/index.md");
    expect(rendered.body).toContain(suggestions[0]!.id);
    expect(rendered.publicationConfirmed).toBe(false);
  });
});
