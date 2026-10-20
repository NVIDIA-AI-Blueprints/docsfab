// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Journey: review documentation to a report. `docsfab run review-documentation`
 * argv through the shipped parser and runner, the real `PiHarness`, and a
 * scripted model; the report is read back through the persisted record, the
 * hosted report store, and `docsfab runs show --json`.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseRunArguments,
  unsupportedSourceWorkflowRefusal,
} from "../../src/cli/run-arguments.js";
import { readPersistedHostedQualityReport } from "../../src/evaluation-report/hosted-report.js";
import { declinedQualityReportNote } from "../../src/workflow-execution/quality-correction-round.js";
import { canonicalSourceObligationProposal } from "../../src/workflow-execution/source-obligation.js";
import { getWorkflow } from "../../src/workflow-registry/catalog.js";
import {
  sourceObligationProposalFixture,
  unverifiedVerificationResultFixture,
} from "../helpers/verification.js";
import { temporaryRoots } from "../helpers/temp.js";
import { captureGitSnapshot } from "../support/execution-convergence.js";
import {
  createJourneyFixture,
  expectOfflineInterpretation,
  journeyProviders,
  journeyTestTimeoutMs,
  readPersistedRecord,
  runJourney,
  runsShowJson,
} from "../support/journey.js";
import { reply, replyJson, type JourneyTurn } from "../support/journey-provider.js";

const roots = temporaryRoots();
const provider = journeyProviders();
const REVIEWED_PATHS = ["README.md", "docs/index.md"];

function qualityReportMarkdown(revision: string): string {
  return [
    "# Documentation quality evaluation report",
    "",
    "## Validated result summary",
    "",
    "```json",
    JSON.stringify({
      report_contract: "docsfab-quality-report-v0.1",
      target: {
        paths: REVIEWED_PATHS,
        repository_revision: revision,
        documentation_revision: revision,
      },
      profile: { id: "docsfab-documentation-quality", version: "1.0.0" },
      evaluation: { decision: "insufficient-evidence", confidence: 0.4, hard_gate_failures: [] },
      rubric: { status: "unavailable", reason: "The scripted journey has no live audience." },
      validation: {
        evaluation: "unavailable",
        quality_score: "unavailable",
        report_binding: "unavailable",
      },
      artifact_locators: { evaluation: null, quality_score: null, quality_report: null },
    }),
    "```",
    "",
    "## Evidence gaps and limitations",
    "",
    "- Limitation: Scripted journey evidence is not live model or audience evidence.",
  ].join("\n");
}

/** One reply per model step of review-documentation, in step order. */
function reviewTurns(revision: string): JourneyTurn[] {
  const verification = unverifiedVerificationResultFixture(
    REVIEWED_PATHS,
    "The journey fixture holds documentation claims but no implementation source that could verify them.",
  );
  const judgment = {
    verdict: verification.review.verdict,
    coverage: verification.coverage,
    issueJudgments: [],
    obligationJudgments: [],
  };
  return [
    // audit-documentation
    reply("The fixture documents Greeter in README.md and docs/index.md."),
    // derive-source-obligations
    reply(canonicalSourceObligationProposal(sourceObligationProposalFixture("README.md:1"))),
    // provisional-technical-verification, then verify-technical-accuracy
    replyJson(judgment),
    replyJson(judgment),
    // review-documentation
    replyJson({ verdict: "pass", issues: [] }),
    // test-audience-understanding
    reply("Audience evidence is unavailable in this scripted journey."),
    // evaluate-document-quality
    replyJson({
      evaluation: {
        profile: { id: "docsfab-documentation-quality", version: "v0.1" },
        model_version: "documentation-quality-model-v0.2",
        target: {
          scope_type: "documentation-set",
          repository_revision: revision,
          paths: REVIEWED_PATHS,
        },
      },
      qualityScore: null,
      reportMarkdown: qualityReportMarkdown(revision),
    }),
  ];
}

describe("review journey", () => {
  it(
    "reviews committed documentation to a persisted report without touching the repository",
    async () => {
      const fixture = await createJourneyFixture("greeter", roots);
      const before = await captureGitSnapshot(fixture.repository);
      const model = provider(reviewTurns(fixture.revision));

      const record = await runJourney({
        fixture,
        provider: model,
        argv: [
          "review-documentation",
          "--repo",
          fixture.repository,
          "--instruction",
          "Review the committed documentation.",
        ],
      });

      const saved = await readPersistedRecord(fixture, record.id);
      expect(saved).toMatchObject({
        id: record.id,
        workflow: "review-documentation",
        status: "succeeded",
        repository: { revision: fixture.revision },
        changes: { files: [] },
      });
      expect(saved.changes?.patch ?? null).toBeNull();
      expectOfflineInterpretation(saved);
      // Every model step ran, in catalog order, on the real harness.
      expect(saved.steps.map((step) => step.id)).toEqual(
        getWorkflow("review-documentation").steps.map((step) => step.id),
      );
      expect(saved.steps.map((step) => step.status)).toEqual(saved.steps.map(() => "succeeded"));
      expect(await captureGitSnapshot(fixture.repository)).toEqual(before);
      // Read-only by grant, not by script: no review step was offered a write tool.
      const offered = model.requests.flatMap((request) => request.offeredTools);
      expect(offered).toContain("read");
      expect(offered.filter((name) => name === "write" || name === "edit")).toEqual([]);

      // The report as the hosted store serves it, and as `runs show` reports it.
      const declinedSummary = `${qualityReportMarkdown(fixture.revision)}\n\n---\n\n${declinedQualityReportNote(1, "evaluation-schema-required")}`;
      const report = await readPersistedHostedQualityReport({
        stateDirectory: fixture.stateDirectory,
        runId: record.id,
      });
      expect(report).toMatchObject({ reportAvailable: true, markdownAvailable: true });
      expect(await readFile(report!.markdownPath!, "utf8")).toBe(declinedSummary);
      const shown = await runsShowJson(fixture, record.id);
      expect(shown.exitCode).toBe(0);
      expect(shown.value).toMatchObject({
        kind: "docsfab-run-result",
        execution: {
          runId: record.id,
          workflow: "review-documentation",
          status: "succeeded",
          exitCode: 0,
          patchPath: null,
          repository: { revision: fixture.revision },
        },
        htmlReport: { path: report!.path, digestSha256: report!.digestSha256 },
      });
    },
    journeyTestTimeoutMs(),
  );

  it("refuses --source for review before any model call", () => {
    expect(() =>
      parseRunArguments([
        "review-documentation",
        "--repo",
        join("journey", "repository"),
        "--source",
        "README.md",
        "--instruction",
        "Review the committed documentation.",
      ]),
    ).toThrow(unsupportedSourceWorkflowRefusal());
  });
});
