// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Verified no-change through the real CLI runner and a scripted model: under
 * the default reader context (no handoff, no operator
 * comparison), an update run whose plan keeps every page unchanged with
 * admitted evidence ends `verified-no-change`. A request that names the page
 * to check passes plan binding when the plan keeps it. Every non-patch plan
 * ends with a coded, terminal record; none crashes or stays `running`.
 *
 * The scripted planner replies with the judgment a model returns and the
 * production reply admission host-fills it, as the Pi harness does. This is
 * regression evidence for the host contract, not model-quality evidence.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { executeRunRequest } from "../src/cli/run-request.js";
import { handleRunsCommand } from "../src/cli/commands/runs.js";
import {
  NO_CHANGE_ASSESSMENT_LOCATION,
  NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION,
  NO_CHANGE_NOMINATED_COVERAGE_BASIS_LIMITATION,
  QUALITY_EVALUATION_NOT_APPLICABLE_LIMITATION,
} from "../src/artifacts/editorial-decision.js";
import { writerNoChangeStopFor } from "../src/workflow-contracts/writer-no-change-stop.js";
import {
  createDocumentationPlanBinding,
  PlanWriteScopeError,
} from "../src/workflow-execution/plan-binding.js";
import { EDITORIAL_UNSTATED_INSUFFICIENCY_LIMITATION } from "../src/workflow-execution/runner-editorial.js";
import { EditorialProtocolHarness } from "./helpers/editorial-protocol-harness.js";
import { git, orbitOptionChangeRepository } from "./helpers/orbit-option-change-fixture.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  process.exitCode = undefined;
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** The benchmark's no-change request shape: it names the page to start from. */
const CHECK_REQUEST =
  "Check whether the documentation needs an update for this change, starting from the Orbit CLI page (docs/cli.md). Update the documentation only if the change requires it; if it does not, make no edits and explain why.";

/**
 * NEXT for a verified no-change whose plan kept `docs/cli.md`. The host decides
 * the audience assessment, so the reply's audience code is not recorded.
 */
const KEPT_PAGE_NEXT = [
  "No documentation change needed; review the kept pages if you disagree: docs/cli.md.",
  "Basis: kept pages, no commit comparison.",
].join(" ");

const ASSESSMENT_STEPS = [
  "verify-technical-accuracy",
  "review-documentation",
  "test-audience-understanding",
  "evaluate-document-quality",
];

describe("update-documentation under the default reader context", () => {
  it("ends verified-no-change, coded and terminal with no patch, when the plan keeps the named page with evidence", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    // The repository carries instructions, the condition the writer's
    // no-change stop needs; a plan that keeps every page never reaches it.
    const fixture = await documentedChangeFixture({ repositoryInstructions: true });
    const harness = new EditorialProtocolHarness({
      candidate: "no-change",
      impactSource: fixture.pageSource,
      plannerJudgment: true,
    });

    const { record, json } = await runCheckRequest(fixture, harness);

    expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
    expect(harness.stepIds).toEqual(["plan-documentation", ...ASSESSMENT_STEPS]);
    // The default context: no handoff, no operator comparison, and the named
    // page bound as the first-pass target the plan must address.
    const planner = harness.inputs[0]!;
    expect(planner.readerTaskContext).toMatchObject({
      kind: "docsfab-reader-task-context-input",
      inputOrigin: "conservative-fallback",
      noChangeAssessment: "requires-evidence",
    });
    expect(planner.readerContextInput?.change_scope).toEqual(["docs/cli.md"]);
    expect(planner.readerContextInput?.unresolved_questions).toEqual([]);
    expect(record?.steps[0]?.planBinding?.pages).toEqual([
      { path: "docs/cli.md", disposition: "retain" },
    ]);
    // The recorded evidence each assessor received: the kept page's admitted
    // bytes and the request, with no comparison.
    for (const input of harness.inputs.slice(1)) {
      expect(input.readerContextProvenance?.comparison).toEqual({ kind: "unknown" });
      expect(input.readerContextProvenance?.sources).toEqual(
        expect.arrayContaining([
          { uri: "docs/cli.md", role: "current-documentation", sha256: fixture.pageSource.sha256 },
          expect.objectContaining({ uri: "request:instruction", role: "request" }),
        ]),
      );
      expect(input.editorialCandidate?.proposal).toMatchObject({
        candidate: "no-change",
        impactBasis: { kind: "none" },
      });
    }
    expect(record?.workflowBranchCoverage).toMatchObject({
      selection: { branchId: "assess-no-change" },
      excludedStepIds: ["derive-source-obligations", "write-documentation", "lint-documentation"],
    });
    expect(record?.changes).toBeUndefined();
    expect(await git(fixture.repository, "status", "--short")).toBe("");
    expect(json).toMatchObject({
      execution: { status: "succeeded", exitCode: 0, patchPath: null },
      product: { disposition: "inconclusive" },
      editorial: {
        state: "validated",
        outcome: "verified-no-change",
        decision: "no-change",
      },
    });
    expect((json.editorial as { evidenceRefs: unknown[] }).evidenceRefs.length).toBeGreaterThan(0);
    // The result names its basis: kept pages, with no commit comparison.
    expect((json.editorial as { limitations: string[] }).limitations).toContain(
      NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION,
    );
    expect(json.product).toMatchObject({
      findings: expect.arrayContaining([NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION]),
      limitations: expect.arrayContaining([NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION]),
    });
    // ...and every page the plan kept.
    expect(json.keptUnchangedPages).toEqual(["docs/cli.md"]);
    // The writer never ran, so its no-change stop never fired.
    expect(record?.steps.some((step) => step.id === "write-documentation")).toBe(false);
    expect(record?.steps.every((step) => step.writerNoChangeStop === undefined)).toBe(true);

    // A cold replay of the saved record re-derives the same verified outcome.
    const replay = await runsShowJson(record!.id, fixture.config.stateDirectory);
    expect(replay).toMatchObject({
      execution: { status: "succeeded", patchPath: null },
      editorial: { outcome: "verified-no-change", decision: "no-change" },
      keptUnchangedPages: ["docs/cli.md"],
    });
    expect((replay.editorial as { limitations: string[] }).limitations).toContain(
      NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION,
    );
    const human = await runsShowHuman(record!.id, fixture.config.stateDirectory);
    expect(human).toContain(
      "Editorial outcome: verified-no-change (basis: kept pages, no commit comparison)",
    );
    expect(human).toContain("Kept unchanged: docs/cli.md");
    // NEXT: the run answered the request, so it names the kept page and the
    // basis, lists the other recorded limitation, and never calls a basis
    // code a wall or asks for a different request.
    const next = KEPT_PAGE_NEXT;
    expect((json.nextSteps as string[])[1]).toBe(next);
    expect(replay.nextSteps).toEqual(json.nextSteps);
    expect(human).toContain(`Reason: ${next}`);
    for (const surface of [
      JSON.stringify(json.nextSteps),
      JSON.stringify(replay.nextSteps),
      human,
    ]) {
      expect(surface).not.toContain("Change the request");
      expect(surface).not.toContain("wall");
    }
  });

  it("ends needs-input with a coded stop, not a crash, when a kept page has no admitted evidence", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const fixture = await documentedChangeFixture();
    // docs/absent.md does not exist at the revision, so the host cannot admit
    // it as current documentation: the plan keeps a page with no evidence.
    const harness = new EditorialProtocolHarness({
      candidate: "no-change",
      impactSource: fixture.pageSource,
      plannerJudgment: true,
      plannerPages: [
        { path: "docs/absent.md", disposition: "retain" },
        { path: "docs/cli.md", disposition: "retain" },
      ],
    });

    const { record, json } = await runCheckRequest(fixture, harness);

    expect(record?.status, JSON.stringify(record?.error)).toBe("needs-input");
    expect(harness.stepIds).toEqual(["plan-documentation"]);
    expect(record?.steps[0]?.status).toBe("needs-input");
    expect(record?.steps[0]?.error).toMatch(/^editorial-select:no-change-unsupported:/u);
    expect(record?.workflowOutcome?.disposition).toBe("needs-input");
    expect(record?.workflowOutcome?.findings.map((finding) => finding.code)).toContain(
      "no-change-unsupported",
    );
    expect(record?.workflowBranchCoverage?.selection ?? null).toBeNull();
    expect(record?.changes).toBeUndefined();
    expect(json).toMatchObject({
      execution: { status: "needs-input", patchPath: null },
      product: { disposition: "needs-input" },
    });
    expect((json.product as { findings: string[] }).findings).toContain("no-change-unsupported");
  });

  it("ends a kept-page insufficient-evidence judgment with a coded terminal record, not a crash", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const fixture = await documentedChangeFixture();
    // The field shape: the planner keeps the named page and judges the
    // evidence insufficient; the host-filled proposal carries no limitation.
    const harness = new EditorialProtocolHarness({
      candidate: "insufficient-evidence",
      impactSource: fixture.pageSource,
      plannerJudgment: true,
    });

    const { record, json } = await runCheckRequest(fixture, harness);

    expect(record?.status, JSON.stringify(record?.error)).toBe("needs-input");
    expect(harness.stepIds).toEqual(["plan-documentation"]);
    expect(record?.workflowOutcome).toMatchObject({
      disposition: "inconclusive",
      limitations: [EDITORIAL_UNSTATED_INSUFFICIENCY_LIMITATION],
      openDecisions: [],
    });
    expect(record?.workflowOutcome?.findings).toEqual([
      expect.objectContaining({
        kind: "evidence-limitation",
        code: EDITORIAL_UNSTATED_INSUFFICIENCY_LIMITATION,
      }),
    ]);
    expect(
      record?.artifacts?.filter((use) => use.reference.kind === "editorial-decision"),
    ).toHaveLength(1);
    expect(record?.changes).toBeUndefined();
    expect(json).toMatchObject({
      execution: { status: "needs-input", patchPath: null },
      product: { disposition: "inconclusive", limitations: ["insufficient-evidence"] },
      editorial: { outcome: "insufficient-evidence", decision: "insufficient-evidence" },
    });
    const replay = await runsShowJson(record!.id, fixture.config.stateDirectory);
    expect(replay).toMatchObject({
      execution: { status: "needs-input" },
      editorial: { outcome: "insufficient-evidence" },
    });
  });

  it("refuses a plan that marks the named page out of scope with a classified update-fitting stop", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const fixture = await documentedChangeFixture();
    const harness = new EditorialProtocolHarness({
      candidate: "no-change",
      impactSource: fixture.pageSource,
      plannerJudgment: true,
      plannerPages: [
        { path: "docs/cli.md", disposition: "out-of-scope" },
        { path: "docs/other.md", disposition: "retain" },
      ],
    });

    const { record } = await runCheckRequest(fixture, harness);

    expect(record?.status).toBe("failed");
    expect(harness.stepIds).toEqual(["plan-documentation"]);
    const planner = record?.steps[0];
    expect(planner?.status).toBe("failed");
    expect(planner?.failure).toMatchObject({
      class: "planning-refusal",
      code: "omitted-mandatory-obligation",
    });
    expect(planner?.error).toContain("the update plan does not address 1 page(s)");
    expect(planner?.error).toContain("(docs/cli.md)");
    expect(planner?.error).toContain("keep it unchanged with disposition retain");
    expect(planner?.error).not.toContain("CREATE");
    expect(record?.changes?.files ?? []).toEqual([]);
  });

  it("still writes a patch when the plan changes the named page (control)", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const fixture = await outdatedPageFixture();
    const harness = new EditorialProtocolHarness({
      candidate: "update",
      impactSource: fixture.pageSource,
      plannerJudgment: true,
    });

    const { record, json } = await runCheckRequest(fixture, harness);

    expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
    expect(record?.workflowBranchCoverage?.selection?.branchId).toBe("author");
    expect(record?.changes?.files).toEqual([{ path: "docs/cli.md", status: "modified" }]);
    expect(json).toMatchObject({
      execution: { status: "succeeded" },
      editorial: { outcome: "executed-update", decision: "update" },
    });
    expect((json.execution as { patchPath: string | null }).patchPath).toEqual(expect.any(String));
  });

  it("refuses, with a code, a plan that writes beyond the named page outside the roots (control)", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const fixture = await outdatedPageFixture();
    const harness = new EditorialProtocolHarness({
      candidate: "update",
      impactSource: fixture.pageSource,
      plannerJudgment: true,
      plannerPages: [
        { path: "docs/cli.md", disposition: "update" },
        { path: "notes/extra.md", disposition: "update" },
      ],
    });

    const { record } = await runCheckRequest(fixture, harness);

    expect(record?.status).toBe("failed");
    expect(harness.stepIds).toEqual(["plan-documentation"]);
    expect(record?.steps[0]?.error).toBe(
      new PlanWriteScopeError(
        [{ path: "notes/extra.md", refusal: "outside-roots" }],
        ["docs/", "fern/"],
      ).message,
    );
    expect(record?.steps[0]?.failure).toMatchObject({
      class: "planning-refusal",
      code: "plan-outside-write-roots",
    });
    expect(record?.changes?.files ?? []).toEqual([]);
  });

  // L1 (critic S2): under a workspace comparison, the operator or the model
  // nominates the public-contract and changed-source roles, so the coverage
  // basis rests on nominations. The page here is stale, yet the scripted
  // assessors accept no-change: the result must still name that basis.
  it("names the nominated-coverage basis of a no-change under a workspace comparison", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const fixture = await outdatedPageFixture();
    const harness = new EditorialProtocolHarness({
      candidate: "no-change",
      impactSource: fixture.pageSource,
      plannerJudgment: true,
    });

    const { record, json } = await runRequest(fixture, harness, {
      comparisonRequest: { kind: "workspace" },
      readerSources: [
        { role: "public-contract", path: "src/orbit.ts" },
        { role: "changed-source", path: "src/orbit.ts" },
      ],
    });

    expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
    const provenance = harness.inputs[1]?.readerContextProvenance;
    expect(provenance?.comparison).toMatchObject({ kind: "workspace" });
    expect(provenance?.sources.map((source) => source.role)).toEqual(
      expect.arrayContaining(["public-contract", "changed-source", "current-documentation"]),
    );
    expect(json).toMatchObject({
      execution: { status: "succeeded", patchPath: null },
      editorial: { state: "validated", outcome: "verified-no-change", decision: "no-change" },
    });
    expect((json.editorial as { limitations: string[] }).limitations).toContain(
      NO_CHANGE_NOMINATED_COVERAGE_BASIS_LIMITATION,
    );
    expect((json.editorial as { limitations: string[] }).limitations).not.toContain(
      NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION,
    );
    expect(json.product).toMatchObject({
      findings: expect.arrayContaining([NO_CHANGE_NOMINATED_COVERAGE_BASIS_LIMITATION]),
      limitations: expect.arrayContaining([NO_CHANGE_NOMINATED_COVERAGE_BASIS_LIMITATION]),
    });
    const human = await runsShowHuman(record!.id, fixture.config.stateDirectory);
    expect(human).toContain(
      "Editorial outcome: verified-no-change (basis: nominated source coverage, no commit comparison)",
    );
    expect(human).toContain("Basis: nominated source coverage, no commit comparison.");
    expect(human).not.toContain("Change the request");
  });

  // A plan that edits one page cannot certify no-change by keeping another,
  // under the live agent's workspace comparison or no comparison at all.
  it.each([
    { name: "read-only with no comparison", allowWrite: false },
    {
      name: "write granted with a workspace comparison",
      allowWrite: true,
      comparisonRequest: { kind: "workspace" as const },
    },
  ])(
    "refuses no-change for a plan that edits a page and keeps another ($name)",
    {
      timeout: testTimeoutMs(30_000),
    },
    async ({ allowWrite, comparisonRequest }) => {
      const fixture = await documentedChangeFixture({ guide: true });
      const harness = new EditorialProtocolHarness({
        candidate: "no-change",
        impactSource: fixture.pageSource,
        plannerJudgment: true,
        plannerPages: [
          { path: "docs/cli.md", disposition: "update" },
          { path: "docs/guide.md", disposition: "retain" },
        ],
      });

      const { record, json } = await runRequest(fixture, harness, {
        allowWrite,
        ...(comparisonRequest ? { comparisonRequest } : {}),
      });

      expect(record?.status, JSON.stringify(record?.error)).toBe("needs-input");
      expect(harness.stepIds).toEqual(["plan-documentation"]);
      expect(record?.steps[0]?.error).toMatch(/^editorial-select:no-change-unsupported:/u);
      expect(record?.workflowBranchCoverage?.selection ?? null).toBeNull();
      expect(record?.changes).toBeUndefined();
      expect(json.editorial).not.toMatchObject({ outcome: "verified-no-change" });
      expect(json.keptUnchangedPages).toEqual(["docs/guide.md"]);
    },
  );

  // A request that names two pages may update one and keep the other;
  // the kept page is named beside the patch, never left silent.
  it("names the named page an update plan kept beside its patch", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const fixture = await outdatedPageFixture({ guide: true });
    const harness = new EditorialProtocolHarness({
      candidate: "update",
      impactSource: fixture.pageSource,
      plannerJudgment: true,
      plannerPages: [
        { path: "docs/cli.md", disposition: "update" },
        { path: "docs/guide.md", disposition: "retain" },
      ],
    });

    const { record, json } = await runRequest(fixture, harness, {
      instruction: "Update docs/cli.md and docs/guide.md so both document the new --new option.",
      canonSnapshotPath: fixture.canonSnapshotPath,
    });

    expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
    expect(record?.changes?.files).toEqual([{ path: "docs/cli.md", status: "modified" }]);
    expect(json).toMatchObject({
      editorial: { outcome: "executed-update", decision: "update" },
      keptUnchangedPages: ["docs/guide.md"],
    });
    const replay = await runsShowJson(record!.id, fixture.config.stateDirectory);
    expect(replay.keptUnchangedPages).toEqual(["docs/guide.md"]);
    const human = await runsShowHuman(record!.id, fixture.config.stateDirectory);
    expect(human).toContain("Kept unchanged: docs/guide.md");
    expect(human).toContain("docs/cli.md");
    expect(human).toContain("Editorial outcome: executed-update\n");
  });
});

// The benchmark's eight no-change stops: every assessor answered, none
// rejected, and the quality evaluator answered not-applicable because no page
// changed. That answer confirms the no-change as a recorded limitation;
// technical verification and review must still accept. A finalization refusal
// names its closed code and location on every surface.
describe("a no-change whose quality evaluator answers not-applicable", () => {
  /** Codes the evaluators recorded in those trials, with their own answer. */
  const EVALUATOR_LIMITATIONS = [
    "quality-artifacts-not-validated",
    "audience-exercise-unavailable",
  ];
  /** The planner judgment's rationale, as `plannerJudgment` replies it. */
  const PLANNER_RATIONALE =
    "The Orbit CLI page already documents --new, the option the change ships, so no kept page needs an edit.";
  const REFUSED = "Final editorial evidence could not be admitted.";

  it("ends verified-no-change and records the evaluator's not-applicable as a limitation", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const fixture = await documentedChangeFixture();
    const harness = new EditorialProtocolHarness({
      candidate: "no-change",
      impactSource: fixture.pageSource,
      plannerJudgment: true,
      notApplicableAssessmentStep: "evaluate-document-quality",
      evaluatorLimitations: EVALUATOR_LIMITATIONS,
    });

    const { record, json } = await runCheckRequest(fixture, harness);

    expect(record?.status, JSON.stringify(record?.failure)).toBe("succeeded");
    expect(harness.stepIds).toEqual(["plan-documentation", ...ASSESSMENT_STEPS]);
    expect(record?.failure).toBeUndefined();
    expect(record?.editorialFinalizationRejection).toBeUndefined();
    expect(json).toMatchObject({
      execution: { status: "succeeded", exitCode: 0, patchPath: null },
      product: { disposition: "inconclusive" },
      editorial: { state: "validated", outcome: "verified-no-change", decision: "no-change" },
    });
    expect((json.editorial as { limitations: string[] }).limitations).toEqual(
      expect.arrayContaining([
        QUALITY_EVALUATION_NOT_APPLICABLE_LIMITATION,
        NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION,
        ...EVALUATOR_LIMITATIONS,
      ]),
    );
    expect(json.product).toMatchObject({
      findings: expect.arrayContaining([QUALITY_EVALUATION_NOT_APPLICABLE_LIMITATION]),
      limitations: expect.arrayContaining([QUALITY_EVALUATION_NOT_APPLICABLE_LIMITATION]),
    });
    const next = `${KEPT_PAGE_NEXT} Recorded limitations: audience-exercise-unavailable, quality-artifacts-not-validated, quality-evaluation-not-applicable.`;
    expect((json.nextSteps as string[])[1]).toBe(next);

    // A cold replay of the saved record re-derives the same verified outcome.
    const replay = await runsShowJson(record!.id, fixture.config.stateDirectory);
    expect(replay).toMatchObject({
      execution: { status: "succeeded", patchPath: null },
      editorial: { outcome: "verified-no-change", decision: "no-change" },
    });
    expect(replay.nextSteps).toEqual(json.nextSteps);
    const human = await runsShowHuman(record!.id, fixture.config.stateDirectory);
    expect(human).toContain(
      "Editorial outcome: verified-no-change (basis: kept pages, no commit comparison)",
    );
    expect(human).toContain(`Reason: ${next}`);
    expect(human).not.toContain("wall");
  });

  it("records no not-applicable limitation when the evaluator accepts (control)", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const fixture = await documentedChangeFixture();
    const harness = new EditorialProtocolHarness({
      candidate: "no-change",
      impactSource: fixture.pageSource,
      plannerJudgment: true,
      evaluatorLimitations: EVALUATOR_LIMITATIONS,
    });

    const { record, json } = await runCheckRequest(fixture, harness);

    expect(record?.status, JSON.stringify(record?.failure)).toBe("succeeded");
    expect(json).toMatchObject({
      editorial: { outcome: "verified-no-change", decision: "no-change" },
    });
    const limitations = (json.editorial as { limitations: string[] }).limitations;
    expect(limitations).toEqual(expect.arrayContaining(EVALUATOR_LIMITATIONS));
    expect(limitations).not.toContain(QUALITY_EVALUATION_NOT_APPLICABLE_LIMITATION);
    expect((json.nextSteps as string[])[1]).toBe(
      `${KEPT_PAGE_NEXT} Recorded limitations: audience-exercise-unavailable, quality-artifacts-not-validated.`,
    );
  });

  it.each(["verify-technical-accuracy", "review-documentation"] as const)(
    "stops with a coded, located cause when %s answers not-applicable",
    {
      timeout: testTimeoutMs(30_000),
    },
    async (stepId) => {
      const fixture = await documentedChangeFixture();
      const harness = new EditorialProtocolHarness({
        candidate: "no-change",
        impactSource: fixture.pageSource,
        plannerJudgment: true,
        notApplicableAssessmentStep: stepId,
      });

      const { record, json } = await runCheckRequest(fixture, harness);

      const code = "editorial-finalization-decision-independent-rejection";
      expect(record?.status).toBe("failed");
      expect(record?.steps.every((step) => step.status === "succeeded")).toBe(true);
      expect(record?.error).toBe(REFUSED);
      expect(record?.editorialFinalizationRejection).toEqual({
        code,
        location: NO_CHANGE_ASSESSMENT_LOCATION,
      });
      expect(record?.failure).toEqual({ class: "model-content", layer: "workflow", code });
      expect(json.failures).toEqual([
        { scope: "run", class: "model-content", layer: "workflow", code },
      ]);
      // The no-change is not verified, and NEXT names the refusal.
      expect(json.editorial).toMatchObject({ outcome: "insufficient-evidence" });
      const reason = `Final editorial evidence was refused by ${code} at ${NO_CHANGE_ASSESSMENT_LOCATION}: the independent assessments do not confirm the no-change. A no-change needs verify-technical-accuracy and review-documentation to answer accepted, and evaluate-document-quality to answer accepted or not-applicable. Inspect each assessment step in the saved run; do not retry unchanged inference.`;
      expect(json.nextSteps).toEqual([
        `docsfab runs show ${record!.id} --state-dir ${fixture.config.stateDirectory} --json`,
        reason,
      ]);
      const human = await runsShowHuman(record!.id, fixture.config.stateDirectory);
      expect(human).toContain(`Failure class: model-content (layer workflow, code ${code}).`);
      expect(human).toContain(
        `Final editorial evidence refused by ${code} at ${NO_CHANGE_ASSESSMENT_LOCATION}.`,
      );
      expect(human).toContain(`Reason: ${reason}`);
      expect(human).not.toContain("docsfab doctor");
    },
  );

  it("keeps a rejecting evaluator's code and verifies no no-change (control)", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const fixture = await documentedChangeFixture();
    const harness = new EditorialProtocolHarness({
      candidate: "no-change",
      impactSource: fixture.pageSource,
      plannerJudgment: true,
      rejectedAssessmentStep: "evaluate-document-quality",
    });

    const { record, json } = await runCheckRequest(fixture, harness);

    expect(record?.status, JSON.stringify(record?.failure)).toBe("succeeded");
    expect(json).toMatchObject({
      product: { disposition: "inconclusive" },
      editorial: { outcome: "insufficient-evidence", decision: "insufficient-evidence" },
    });
    const limitations = (json.editorial as { limitations: string[] }).limitations;
    expect(limitations).toContain("evidence-limitation.independent-assessment-rejected");
    expect(limitations).not.toContain(QUALITY_EVALUATION_NOT_APPLICABLE_LIMITATION);
    expect(record?.workflowOutcome?.findings.map((finding) => finding.code)).toContain(
      "evidence-limitation.independent-assessment-rejected",
    );
  });

  it("names a host refusal by its own code: the evaluator repeats the planner's rationale", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const fixture = await documentedChangeFixture();
    const harness = new EditorialProtocolHarness({
      candidate: "no-change",
      impactSource: fixture.pageSource,
      plannerJudgment: true,
      evaluatorRationale: PLANNER_RATIONALE,
    });

    const { record, json } = await runCheckRequest(fixture, harness);

    const code = "editorial-finalization-host-conflicting-assessment";
    expect(record?.status).toBe("failed");
    expect(record?.editorialFinalizationRejection).toEqual({ code, location: "$" });
    expect(record?.failure).toEqual({ class: "model-content", layer: "workflow", code });
    expect((json.nextSteps as string[])[1]).toBe(
      `Final editorial evidence was refused by ${code} at $: the evaluator's rationale repeats the planner's, so it is not independent evidence. Inspect each assessment step in the saved run; do not retry unchanged inference.`,
    );
  });

  it("counts each limitation code once when the assessors repeat each other", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    // Eleven codes from each of three assessors and the planner's basis code:
    // 34 entries, 12 distinct codes.
    const repeated = Array.from({ length: 11 }, (_, index) => `shared-limitation-${index}`);
    const fixture = await documentedChangeFixture();
    const harness = new EditorialProtocolHarness({
      candidate: "no-change",
      impactSource: fixture.pageSource,
      plannerJudgment: true,
      evaluatorLimitations: repeated,
      assessorLimitations: {
        "verify-technical-accuracy": repeated,
        "review-documentation": repeated,
      },
    });

    const { record, json } = await runCheckRequest(fixture, harness);

    expect(record?.status, JSON.stringify(record?.failure)).toBe("succeeded");
    expect(json).toMatchObject({ editorial: { outcome: "verified-no-change" } });
    expect((json.editorial as { limitations: string[] }).limitations).toEqual(
      [NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION, ...repeated].sort((left, right) =>
        left.localeCompare(right),
      ),
    );
  });

  it("merges more distinct limitation codes than any one assessment may carry", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    // Twelve distinct codes from each of three assessors: 36, with the basis 37.
    const codes = (step: string) =>
      Array.from({ length: 12 }, (_, index) => `${step}-limitation-${index}`);
    const fixture = await documentedChangeFixture();
    const harness = new EditorialProtocolHarness({
      candidate: "no-change",
      impactSource: fixture.pageSource,
      plannerJudgment: true,
      evaluatorLimitations: codes("evaluator"),
      assessorLimitations: {
        "verify-technical-accuracy": codes("technical"),
        "review-documentation": codes("review"),
      },
    });

    const { record, json } = await runCheckRequest(fixture, harness);

    expect(record?.status, JSON.stringify(record?.failure)).toBe("succeeded");
    expect(json).toMatchObject({ editorial: { outcome: "verified-no-change" } });
    expect((json.editorial as { limitations: string[] }).limitations).toHaveLength(37);
    expect(record?.workflowOutcome?.limitations).toEqual(
      expect.arrayContaining([...codes("technical"), ...codes("review"), ...codes("evaluator")]),
    );
  });
});

// `docsfab run` delivers a draft merge request unless told otherwise. A
// verified no-change has nothing to publish: no draft MR is attempted, and
// every output mode exits 0 with the no-change NEXT instead of a publication
// failure or a throw.
describe("a verified no-change under the default draft-MR delivery", () => {
  it.each([
    { mode: "human output", json: false, quiet: false },
    { mode: "--json", json: true, quiet: false },
    { mode: "--quiet", json: false, quiet: true },
  ])(
    "records that no publication was needed ($mode)",
    {
      timeout: testTimeoutMs(30_000),
    },
    async ({ json, quiet }) => {
      const fixture = await documentedChangeFixture();
      const harness = new EditorialProtocolHarness({
        candidate: "no-change",
        impactSource: fixture.pageSource,
        plannerJudgment: true,
      });
      const published: string[] = [];
      const freshness: string[] = [];

      const {
        record,
        json: result,
        output,
      } = await runRequest(
        fixture,
        harness,
        { draftMr: true, remoteName: "origin", json },
        {
          ...(quiet ? { quiet: true } : {}),
          // The draft-MR path runs its freshness prelude before the write.
          ensurePublicationFreshness: async ({ revision }) => {
            freshness.push(revision);
            return { branch: "main", revision: fixture.head };
          },
          submitAfterSucceededRun: async (run) => {
            published.push(run.id);
            throw new Error("A verified no-change must not reach the publisher.");
          },
        },
      );

      expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
      expect(freshness).toEqual([fixture.head]);
      expect(published).toEqual([]);
      expect(process.exitCode ?? 0).toBe(0);
      const text = output.join("\n");
      expect(text).not.toContain("publication-not-attempted");
      expect(text).not.toContain("Change the request");
      // No VERDICT publication plane, so no `publication failed`.
      expect(text).not.toMatch(/^\s+publication /mu);
      if (json) {
        expect(result).toMatchObject({
          execution: { status: "succeeded", exitCode: 0, patchPath: null },
          editorial: { outcome: "verified-no-change" },
        });
        expect((result.nextSteps as string[])[1]).toBe(KEPT_PAGE_NEXT);
        return;
      }
      expect(text).toContain(`Reason: ${KEPT_PAGE_NEXT}`);
      if (quiet) {
        expect(text).not.toContain("PUBLICATION");
      } else {
        expect(text).toContain(
          [
            "PUBLICATION",
            "  Status: not needed",
            "  The run verified that no documentation change is needed, so no draft merge request was opened.",
          ].join("\n"),
        );
        expect(text).toContain(
          "Editorial outcome: verified-no-change (basis: kept pages, no commit comparison)",
        );
      }
    },
  );

  it("still hands an executed update to the publisher (control)", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const fixture = await outdatedPageFixture();
    const harness = new EditorialProtocolHarness({
      candidate: "update",
      impactSource: fixture.pageSource,
      plannerJudgment: true,
    });
    const published: string[] = [];

    const { record, output } = await runRequest(
      fixture,
      harness,
      { draftMr: true, remoteName: "origin", json: false },
      {
        ensurePublicationFreshness: async () => ({ branch: "main", revision: fixture.head }),
        submitAfterSucceededRun: async (run) => {
          published.push(run.id);
          throw new Error("The fixture publisher stops after the hand-off.");
        },
      },
    );

    expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
    expect(record?.changes?.files).toEqual([{ path: "docs/cli.md", status: "modified" }]);
    expect(published).toEqual([record!.id]);
    expect(output.join("\n")).not.toContain("Status: not needed");
  });

  // An independent assessor that reverses the planner's no-change to an update
  // leaves an update-recommended run with an empty patch. That is not a
  // verified no-change: delivery still hands it to the publisher, which
  // reports that publication was not attempted.
  it("still reports publication-not-attempted for an update-recommended run with an empty patch", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const fixture = await documentedChangeFixture();
    const harness = new EditorialProtocolHarness({
      candidate: "no-change",
      impactSource: fixture.pageSource,
      plannerJudgment: true,
      rejectedAssessmentStep: "review-documentation",
      rejectedRecommendation: "update",
    });

    const { record, output } = await runRequest(
      fixture,
      harness,
      { draftMr: true, remoteName: "origin", json: false },
      { ensurePublicationFreshness: async () => ({ branch: "main", revision: fixture.head }) },
    );

    expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
    expect(record?.workflowBranchCoverage?.selection?.branchId).toBe("assess-no-change");
    expect(record?.changes).toBeUndefined();
    const text = output.join("\n");
    expect(text).toContain("Editorial outcome: update-recommended");
    expect(text).toContain("Status: failed (publication-not-attempted)");
    expect(text).toMatch(/^\s+publication failed$/mu);
    expect(text).not.toContain("Status: not needed");
    expect(process.exitCode).toBe(1);
  });
});

// A base and head comparison of one commit, as a CI job on the default branch
// produces with `git merge-base`, compares nothing: its coverage rests on the
// nominated public contract, and the result says so.
describe("a no-change whose comparison base equals the revision", () => {
  it("names the nominated-coverage basis, not a commit comparison", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const fixture = await documentedChangeFixture();
    const harness = new EditorialProtocolHarness({
      candidate: "no-change",
      impactSource: fixture.pageSource,
      plannerJudgment: true,
    });

    const { record, json } = await runRequest(fixture, harness, {
      comparisonRequest: {
        kind: "base-head",
        baseRevision: fixture.head,
        headRevision: fixture.head,
      },
      readerSources: [{ role: "public-contract", path: "src/orbit.ts" }],
    });

    expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
    expect(harness.inputs[1]?.readerContextProvenance?.comparison).toEqual({
      kind: "base-head",
      base_revision: fixture.head,
      head_revision: fixture.head,
    });
    expect(json).toMatchObject({
      execution: { status: "succeeded", patchPath: null },
      editorial: { outcome: "verified-no-change", decision: "no-change" },
    });
    const limitations = (json.editorial as { limitations: string[] }).limitations;
    expect(limitations).toContain(NO_CHANGE_NOMINATED_COVERAGE_BASIS_LIMITATION);
    expect(limitations).not.toContain(NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION);
    expect(json.product).toMatchObject({
      limitations: expect.arrayContaining([NO_CHANGE_NOMINATED_COVERAGE_BASIS_LIMITATION]),
    });
    expect((json.nextSteps as string[])[1]).toContain(
      "Basis: nominated source coverage, no commit comparison.",
    );
    const human = await runsShowHuman(record!.id, fixture.config.stateDirectory);
    expect(human).toContain(
      "Editorial outcome: verified-no-change (basis: nominated source coverage, no commit comparison)",
    );
    expect(human).not.toContain("Basis: base and head commit comparison");
  });
});

// The writer no-change stop needs a page to write, so a plan
// that keeps every page leaves a writer that changed nothing to the run's own
// no-change outcome.
describe("the writer no-change stop and a plan that keeps every page", () => {
  const writer = {
    stepId: "write-documentation",
    repositoryInstructions: ["AGENTS.md"],
    tools: {
      totalCalls: 1,
      failedCalls: 0,
      presented: ["edit", "read", "write"],
      byTool: [{ name: "read", calls: 1, failures: 0 }],
    },
  };

  it("fires for a writer that changed nothing in a plan that edits a page (control)", () => {
    const plan = createDocumentationPlanBinding({
      mode: "update",
      pages: [{ path: "docs/cli.md", disposition: "update" }],
      sourceBindings: [{ pagePath: "docs/cli.md", sources: ["src/orbit.ts"] }],
    });
    expect(writerNoChangeStopFor({ ...writer, planBinding: plan })).toMatchObject({
      code: "writer-made-no-change",
    });
  });

  it("never fires for a plan that keeps every page", () => {
    const plan = createDocumentationPlanBinding({
      mode: "update",
      pages: [{ path: "docs/cli.md", disposition: "retain" }],
      sourceBindings: [],
    });
    expect(writerNoChangeStopFor({ ...writer, planBinding: plan })).toBeUndefined();
  });
});

interface NoChangeFixture extends Awaited<ReturnType<typeof orbitOptionChangeRepository>> {
  readonly pageSource: { uri: string; sha256: string };
}

interface FixtureOptions {
  /** Add `docs/guide.md`, which documents the same option as the CLI page. */
  readonly guide?: boolean;
  /** Add an `AGENTS.md` repository instruction file. */
  readonly repositoryInstructions?: boolean;
}

/** The Orbit change, with the CLI page already documenting the shipped option. */
async function documentedChangeFixture(options: FixtureOptions = {}): Promise<NoChangeFixture> {
  const fixture = await orbitOptionChangeRepository(
    "docsfab-default-no-change",
    temporaryDirectories,
  );
  const page = "# Orbit CLI\n\nThe public option is --new.\n";
  await writeFile(join(fixture.repository, "docs/cli.md"), page);
  await addFixturePages(fixture.repository, options, "--new");
  await git(fixture.repository, "add", "--all");
  await git(
    fixture.repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "docs: describe --new",
  );
  const head = await git(fixture.repository, "rev-parse", "HEAD");
  await git(fixture.repository, "update-ref", "refs/remotes/origin/main", head);
  return { ...fixture, head, pageSource: await pageSource(page) };
}

/** The Orbit change, with the CLI page still documenting the old option. */
async function outdatedPageFixture(options: FixtureOptions = {}): Promise<NoChangeFixture> {
  const fixture = await orbitOptionChangeRepository("docsfab-default-update", temporaryDirectories);
  if (options.guide || options.repositoryInstructions) {
    await addFixturePages(fixture.repository, options, "--old");
    await git(fixture.repository, "add", "--all");
    await git(
      fixture.repository,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "docs: add the guide",
    );
    const head = await git(fixture.repository, "rev-parse", "HEAD");
    await git(fixture.repository, "update-ref", "refs/remotes/origin/main", head);
    return {
      ...fixture,
      head,
      pageSource: await pageSource("# Orbit CLI\n\nThe public option is --old.\n"),
    };
  }
  return {
    ...fixture,
    pageSource: await pageSource("# Orbit CLI\n\nThe public option is --old.\n"),
  };
}

async function addFixturePages(
  repository: string,
  options: FixtureOptions,
  option: string,
): Promise<void> {
  if (options.guide) {
    await writeFile(
      join(repository, "docs/guide.md"),
      `# Orbit guide\n\nRun Orbit with the ${option} option.\n`,
    );
  }
  if (options.repositoryInstructions) {
    await writeFile(join(repository, "AGENTS.md"), "# Agents\n\nKeep pages short.\n");
  }
}

async function pageSource(page: string): Promise<{ uri: string; sha256: string }> {
  const { createHash } = await import("node:crypto");
  return { uri: "docs/cli.md", sha256: createHash("sha256").update(page).digest("hex") };
}

async function runCheckRequest(fixture: NoChangeFixture, harness: EditorialProtocolHarness) {
  return runRequest(fixture, harness);
}

type RunRequestOverrides = Partial<
  Pick<
    Parameters<typeof executeRunRequest>[0],
    | "allowWrite"
    | "comparisonRequest"
    | "instruction"
    | "canonSnapshotPath"
    | "readerSources"
    | "draftMr"
    | "remoteName"
    | "json"
  >
>;

type RunOptions = Omit<NonNullable<Parameters<typeof executeRunRequest>[2]>, "harness">;

async function runRequest(
  fixture: NoChangeFixture,
  harness: EditorialProtocolHarness,
  overrides: RunRequestOverrides = {},
  options: RunOptions = {},
) {
  const output: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (message?: unknown): void => {
    output.push(String(message));
  };
  console.error = (message?: unknown): void => {
    output.push(String(message));
  };
  let record;
  try {
    record = await executeRunRequest(
      {
        workflow: "update-documentation",
        repositoryPath: fixture.repository,
        revision: fixture.head,
        instruction: CHECK_REQUEST,
        allowWrite: true,
        releaseGate: false,
        verbose: false,
        json: true,
        showScan: false,
        ...overrides,
      },
      fixture.config,
      { harness, ...options },
    );
  } finally {
    console.log = log;
    console.error = error;
  }
  const json =
    overrides.json === false ? {} : (JSON.parse(output.at(-1) ?? "{}") as Record<string, unknown>);
  return { record, json, output };
}

async function runsShowHuman(runId: string, stateDirectory: string): Promise<string> {
  const output: string[] = [];
  const log = console.log;
  console.log = (message?: unknown): void => {
    output.push(String(message));
  };
  try {
    await handleRunsCommand(["show", runId, "--state-dir", stateDirectory]);
  } finally {
    console.log = log;
  }
  return `${output.join("\n")}\n`;
}

async function runsShowJson(runId: string, stateDirectory: string) {
  const output: string[] = [];
  const log = console.log;
  console.log = (message?: unknown): void => {
    output.push(String(message));
  };
  try {
    await handleRunsCommand(["show", runId, "--json", "--state-dir", stateDirectory]);
  } finally {
    console.log = log;
  }
  return JSON.parse(output.at(-1) ?? "{}") as Record<string, unknown>;
}
