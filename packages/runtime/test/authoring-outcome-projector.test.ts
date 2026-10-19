// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AUTHORING_QUALITY_OUTCOME_WORKFLOWS,
  AuthoringQualityWorkflowOutcomeError,
  AuthoringQualityWorkflowOutcomeProjector,
  isAuthoringQualityOutcomeWorkflow,
  type AuthoringQualityOutcomeWorkflow,
} from "../src/evaluation-report/authoring-outcome-projector.js";
import { projectQualityReportFromRun } from "../src/evaluation-report/index.js";
import type { RunRecord } from "../src/records/contracts.js";
import {
  createWorkflowOutcome,
  defaultInconclusiveWorkflowOutcome,
  workflowOutcomeState,
} from "../src/workflow-contracts/outcome.js";
import { applyWorkflowOutcome } from "../src/workflow-execution/runner-evidence.js";

const REVISION = "a".repeat(40);
const EVALUATE_STEP_ID = "evaluate-document-quality";

describe("AuthoringQualityWorkflowOutcomeProjector", () => {
  const projector = new AuthoringQualityWorkflowOutcomeProjector();

  it("names every authoring job that already runs evaluate-document-quality except review-documentation", () => {
    expect([...AUTHORING_QUALITY_OUTCOME_WORKFLOWS]).toEqual([
      "create-documentation",
      "update-documentation",
      "restructure-documentation",
    ]);
    expect(isAuthoringQualityOutcomeWorkflow("review-documentation")).toBe(false);
    expect(isAuthoringQualityOutcomeWorkflow("readiness")).toBe(false);
  });

  it("projects inconclusive limitation codes from admitted evaluate JSON", async () => {
    const record = authoringRecord({
      summary: routerEvaluateSummary(),
    });
    const candidate = await projector.project(record);
    const outcome = createWorkflowOutcome(candidate, record);

    expect(outcome.disposition).toBe("inconclusive");
    expect(outcome.limitations).toEqual([
      "experimental-quality-profile",
      "insufficient-evidence",
      "quality-rubric-unavailable",
    ]);
    expect(outcome.findings).toEqual([
      expect.objectContaining({
        kind: "evidence-limitation",
        severity: "warning",
        code: "experimental-quality-profile",
        evidenceIds: [`step:${EVALUATE_STEP_ID}`],
      }),
      expect.objectContaining({
        kind: "evidence-limitation",
        code: "insufficient-evidence",
      }),
      // The evaluator's own decision is an advisory finding with its own code,
      // citing only the evaluate step; it is not a limitation.
      {
        id: "finding:authoring-quality:quality-evaluation.insufficient-evidence",
        kind: "evidence-limitation",
        severity: "warning",
        code: "quality-evaluation.insufficient-evidence",
        evidenceIds: [`step:${EVALUATE_STEP_ID}`],
      },
      expect.objectContaining({
        kind: "evidence-limitation",
        code: "quality-rubric-unavailable",
      }),
    ]);
    expect(outcome.evidence).toEqual([
      expect.objectContaining({ kind: "step", stepId: EVALUATE_STEP_ID }),
      expect.objectContaining({ kind: "step", stepId: "test-audience-understanding" }),
    ]);
  });

  it("projects the same evaluate codes for every authoring workflow in the closed set", async () => {
    for (const workflow of AUTHORING_QUALITY_OUTCOME_WORKFLOWS) {
      const record = authoringRecord({ workflow, summary: routerEvaluateSummary() });
      const outcome = createWorkflowOutcome(await projector.project(record), record);
      expect(outcome.disposition).toBe("inconclusive");
      // `insufficient-evidence` is the audience rule's code, which create and
      // update always carry; restructure reads direct audience evidence here.
      expect(outcome.limitations).toEqual(
        workflow === "restructure-documentation"
          ? ["experimental-quality-profile", "quality-rubric-unavailable"]
          : ["experimental-quality-profile", "insufficient-evidence", "quality-rubric-unavailable"],
      );
      expect(outcome.findings.map((finding) => finding.code)).toContain(
        "quality-evaluation.insufficient-evidence",
      );
    }
  });

  it("never infers ready from a pass decision, Green band, or successful model call", async () => {
    const record = authoringRecord({
      summary: JSON.stringify({
        status: "pass",
        note: "Documentation is ready.",
        step_evidence: {
          rubric_score: {
            status: "available",
            total: 84,
            threshold: 80,
            interpretation_band: "Green",
            decision: "pass",
          },
        },
      }),
    });
    const candidate = await projector.project(record);
    const outcome = createWorkflowOutcome(candidate, record);

    expect(outcome.disposition).toBe("inconclusive");
    expect(outcome.disposition).not.toBe("ready");
    expect(outcome.limitations).toEqual(["experimental-quality-profile", "insufficient-evidence"]);
    expect(outcome.findings.every((finding) => finding.kind === "evidence-limitation")).toBe(true);
  });

  it.each([
    ["missing audience step", null],
    ["missing prerequisites", JSON.stringify({ evidence_status: "insufficient-evidence" })],
    ["invalid JSON evidence", "not-json"],
    ["invalid evidence status and target", JSON.stringify({ evidence_status: "unknown" })],
    [
      "proxy evidence",
      JSON.stringify({
        evidence_status: "proxy-evidence",
        target: {
          repository_revision: REVISION,
          documentation_revision: "candidate-documentation-v1",
        },
      }),
    ],
    [
      "candidate revision mismatch",
      JSON.stringify({
        evidence_status: "direct-outcome-evidence",
        reason: "candidate-revision-mismatch",
        target: {
          repository_revision: REVISION,
          documentation_revision: "candidate-documentation-v2",
        },
      }),
    ],
  ])(
    "retains %s when the final evaluator reports pass and Green",
    async (_name, audienceSummary) => {
      const record = authoringRecord({
        summary: passEvaluateSummary(),
        audienceSummary,
      });
      const outcome = createWorkflowOutcome(await projector.project(record), record);

      expect(outcome.disposition).toBe("inconclusive");
      expect(outcome.limitations).toEqual([
        "experimental-quality-profile",
        "insufficient-evidence",
      ]);
      const expectedEvidenceIds =
        audienceSummary === null
          ? [`step:${EVALUATE_STEP_ID}`]
          : [`step:${EVALUATE_STEP_ID}`, "step:test-audience-understanding"];
      expect(outcome.evidence.map((item) => item.id)).toEqual(expectedEvidenceIds);
      expect(
        outcome.findings.find((finding) => finding.code === "insufficient-evidence")?.evidenceIds,
      ).toEqual(expectedEvidenceIds);
    },
  );

  it("does not cite search evidence from other steps", async () => {
    const record = authoringRecord({
      summary: routerEvaluateSummary(),
      planSearchDisposition: "search-blocked",
    });
    const outcome = createWorkflowOutcome(await projector.project(record), record);

    expect(outcome.evidence.every((item) => item.kind === "step")).toBe(true);
    expect(outcome.evidence.map((item) => item.stepId)).toEqual([
      EVALUATE_STEP_ID,
      "test-audience-understanding",
    ]);
    expect(outcome.disposition).toBe("inconclusive");
  });

  it("stays on the default limitation when evaluate JSON is missing or markdown", async () => {
    const missing = authoringRecord({ summary: undefined, includeEvaluate: false });
    const markdown = authoringRecord({ summary: markdownQualityReport() });
    const missingCandidate = await projector.project(missing);
    const markdownCandidate = await projector.project(markdown);

    expect(missingCandidate).toEqual(defaultInconclusiveWorkflowOutcome(missing));
    expect(markdownCandidate).toEqual(defaultInconclusiveWorkflowOutcome(markdown));
    expect(missingCandidate.limitations).toEqual(["structured-product-evidence-unavailable"]);
    expect(markdownCandidate.limitations).toEqual(["structured-product-evidence-unavailable"]);
  });

  it("does not impose the standalone review-documentation report contract", async () => {
    const record = authoringRecord({ summary: routerEvaluateSummary() });
    expect(projectQualityReportFromRun(record)).toBeNull();
    await expect(
      projector.project({ ...record, workflow: "review-documentation" }),
    ).rejects.toEqual(new AuthoringQualityWorkflowOutcomeError("invalid-workflow"));
  });

  it("persists workflowOutcome for a succeeded authoring evaluate step", async () => {
    const record = authoringRecord({ summary: routerEvaluateSummary() });
    await applyWorkflowOutcome({ outcomeProjector: projector, record });

    expect(record.status).toBe("succeeded");
    expect(record.error).toBeUndefined();
    expect(record.workflowOutcome?.kind).toBe("docsfab-workflow-outcome");
    expect(workflowOutcomeState(record)).toEqual({
      state: "current",
      outcome: record.workflowOutcome,
    });
    expect(record.workflowOutcome?.disposition).toBe("inconclusive");
    expect(record.workflowOutcome?.limitations).toEqual([
      "experimental-quality-profile",
      "insufficient-evidence",
      "quality-rubric-unavailable",
    ]);
  });

  it("fail-closes when the projector is applied to an unknown workflow", async () => {
    const record = authoringRecord({ summary: routerEvaluateSummary() });
    record.workflow = "review-documentation";
    await expect(projector.project(record)).rejects.toEqual(
      new AuthoringQualityWorkflowOutcomeError("invalid-workflow"),
    );
  });

  it("fail-closes orphan revision accounting without an authoring envelope", async () => {
    const record = authoringRecord({ summary: routerEvaluateSummary() });
    (record.steps[0] as unknown as Record<string, unknown>).authoringRevisionAccounting = {};
    await expect(projector.project(record)).rejects.toEqual(
      new AuthoringQualityWorkflowOutcomeError("invalid-record"),
    );
  });

  // The forged-stop guard: a needs-input record whose stop the host did not
  // admit, or whose candidate admission refuses, still ends `failed` with a
  // named rejection. The coded stops that do project are pinned in
  // `authoring-writer-plan-scope-outcome.test.ts`.
  it.each([
    {
      name: "an uncoded needs-input stop",
      forge: (_step: RunRecord["steps"][number]) => undefined,
      location: "$.steps[].planDiagnostic",
    },
    {
      name: "a forged plan-scope stop",
      forge: (step: RunRecord["steps"][number]) => {
        step.planScopeStop = {
          schemaVersion: 1,
          kind: "docsfab-documentation-plan-scope-stop",
          code: "writer-mutation-outside-plan",
          refusedMutations: 1,
        };
      },
      location: "$.steps[].planScopeStop",
    },
    {
      name: "a forged writer no-change stop",
      forge: (step: RunRecord["steps"][number]) => {
        (step as unknown as Record<string, unknown>).writerNoChangeStop = {
          schemaVersion: 1,
          kind: "docsfab-writer-no-change-stop",
          code: "writer-no-change",
        };
      },
      location: "$.steps[].writerNoChangeStop",
    },
  ])("fails $name with the projection rejection", async ({ forge, location }) => {
    const record = needsInputRecord();
    forge(record.steps.at(-1)!);
    await applyWorkflowOutcome({ outcomeProjector: projector, record });

    expect(record.status).toBe("failed");
    expect(record.workflowOutcome).toBeUndefined();
    expect(record.workflowOutcomeRejection).toEqual({
      code: "workflow-outcome-projection-invalid-record",
      location,
    });
    expect(record.failure).toEqual({
      class: "contract-shape",
      layer: "workflow",
      code: "workflow-outcome-projection-invalid-record",
    });
  });

  it("fails a needs-input stop whose candidate admission refuses", async () => {
    const record = needsInputRecord();
    await applyWorkflowOutcome({
      outcomeProjector: {
        project: async () => ({
          disposition: "needs-input",
          findings: [
            {
              id: "finding:forged",
              kind: "missing-governed-input",
              severity: "blocking",
              code: "Not A Code",
              inputId: "input:forged",
              evidenceIds: [],
            },
          ],
          evidence: [],
          limitations: [],
          openDecisions: [],
          producedArtifacts: [],
        }),
      },
      record,
    });

    expect(record.status).toBe("failed");
    expect(record.workflowOutcome).toBeUndefined();
    expect(record.workflowOutcomeRejection?.code).toMatch(/^workflow-outcome-admission-/u);
    expect(record.failure?.code).toBe(record.workflowOutcomeRejection?.code);
  });

  it("wires the projector for authoring jobs in the shared application dependencies", () => {
    const source = readFileSync(resolve("src/application/dependencies.ts"), "utf8");
    expect(source).toContain("isAuthoringQualityOutcomeWorkflow(request.workflow)");
    expect(source).toContain("new AuthoringQualityWorkflowOutcomeProjector()");
  });
});

function routerEvaluateSummary(): string {
  return JSON.stringify({
    status: "insufficient-evidence",
    artifacts: {
      "evaluation.json": {
        content: {
          profile: { id: "docsfab-documentation-quality", version: "v0.1" },
          overall_decision: "insufficient-evidence",
        },
      },
      "quality-score.json": {
        reason: "No unambiguous content-type rubric.",
      },
    },
    step_evidence: {
      rubric_score: { status: "unavailable" },
    },
  });
}

function markdownQualityReport(): string {
  return [
    "# Documentation quality evaluation report",
    "",
    "## Validated result summary",
    "",
    "```json",
    JSON.stringify({
      report_contract: "docsfab-quality-report-v0.1",
      evaluation: { decision: "pass", confidence: 0.9, hard_gate_failures: [] },
      rubric: {
        status: "available",
        id: "task-guide-v0.1",
        total: 84,
        threshold: 80,
        interpretation_band: "Green",
        decision: "pass",
      },
    }),
    "```",
  ].join("\n");
}

function passEvaluateSummary(): string {
  return JSON.stringify({
    status: "pass",
    step_evidence: {
      rubric_score: {
        status: "available",
        total: 84,
        threshold: 80,
        interpretation_band: "Green",
        decision: "pass",
      },
    },
  });
}

function directAudienceSummary(): string {
  return JSON.stringify({
    evidence_status: "direct-outcome-evidence",
    target: {
      repository_revision: REVISION,
      documentation_revision: "candidate-documentation-v1",
    },
  });
}

function authoringRecord(input: {
  workflow?: AuthoringQualityOutcomeWorkflow;
  summary?: string;
  includeEvaluate?: boolean;
  audienceSummary?: string | null;
  planSearchDisposition?: "search-blocked" | "found";
}): RunRecord {
  const evaluateSummary = input.summary;
  const includeEvaluate = input.includeEvaluate ?? true;
  const record: RunRecord = {
    schemaVersion: 2,
    id: "run:authoring-quality-outcome-fixture",
    workflow: input.workflow ?? "create-documentation",
    repository: {
      sourcePath: "/private/source",
      requestedRevision: "HEAD",
      revision: REVISION,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-08-05T00:00:00.000Z",
    startedAt: "2026-08-05T00:00:00.000Z",
    completedAt: "2026-08-05T00:00:01.000Z",
    durationMs: 1_000,
    models: [],
    skills: [],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      turns: 0,
    },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "plan-documentation",
        title: "Plan the documentation",
        kind: "evaluate",
        skill: "plan-documentation",
        mode: "read-only",
        status: "succeeded",
        startedAt: "2026-08-05T00:00:00.000Z",
        completedAt: "2026-08-05T00:00:01.000Z",
        durationMs: 1_000,
        summary: "Typed product evidence fixture.",
      },
    ],
  };
  const audienceSummary =
    input.audienceSummary === undefined ? directAudienceSummary() : input.audienceSummary;
  if (audienceSummary !== null) {
    record.steps.push({
      id: "test-audience-understanding",
      title: "Test audience understanding",
      kind: "evaluate",
      skill: "test-audience-understanding",
      mode: "read-only",
      status: "succeeded",
      startedAt: "2026-08-05T00:00:00.000Z",
      completedAt: "2026-08-05T00:00:01.000Z",
      durationMs: 1_000,
      summary: audienceSummary,
    });
  }
  if (includeEvaluate) {
    record.steps.push({
      id: EVALUATE_STEP_ID,
      title: "Evaluate document quality",
      kind: "evaluate",
      skill: EVALUATE_STEP_ID,
      mode: "read-only",
      status: "succeeded",
      startedAt: "2026-08-05T00:00:00.000Z",
      completedAt: "2026-08-05T00:00:01.000Z",
      durationMs: 1_000,
      ...(evaluateSummary === undefined ? {} : { summary: evaluateSummary }),
    });
  }
  if (input.planSearchDisposition) {
    record.steps[0]!.searchEvidence = {
      schemaVersion: 1,
      kind: "docsfab-workflow-search-evidence",
      planId: "documentation-observation-discovery",
      planVersion: "1.0.0",
      searches: [
        {
          targetId: "documentation-nav-graph",
          bounded: {
            evidenceSha256: "b".repeat(64),
            target: { repository: { revision: record.repository.revision } },
            confidence: { disposition: input.planSearchDisposition },
          },
          progress: { target: { repository: { revision: record.repository.revision } } },
        },
      ],
      evidenceSha256: "c".repeat(64),
    } as unknown as NonNullable<RunRecord["steps"][number]["searchEvidence"]>;
  }
  return record;
}

/** A writer step stopped `needs-input` with no admitted stop of its own. */
function needsInputRecord(): RunRecord {
  const record = authoringRecord({ workflow: "update-documentation", includeEvaluate: false });
  record.status = "needs-input";
  delete record.completedAt;
  const writer = structuredClone(record.steps[0]!);
  writer.id = "write-documentation";
  writer.title = "Write the documentation";
  writer.kind = "inference";
  writer.skill = "write-documentation";
  writer.mode = "write";
  writer.status = "needs-input";
  delete writer.summary;
  record.steps = [record.steps[0]!, writer];
  return record;
}
