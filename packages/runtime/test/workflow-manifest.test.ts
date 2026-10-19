// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentHarness, HarnessStepInput } from "../src/execution/contracts.js";
import type { ChangeEvidence } from "../src/impact/contracts.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import type {
  RepositoryEvidenceCollector,
  RepositoryEvidenceContext,
} from "../src/repository/contracts.js";
import type { RepositorySecurityScanner } from "../src/security/contracts.js";
import {
  DECLARATIVE_WORKFLOW_NAMES,
  loadWorkflowManifestCatalog,
} from "../src/workflow-registry/manifest.js";
import { documentationObservationSearch } from "../src/search/observation-search-plan.js";
import { sourceReadinessSearch } from "../src/readiness/workflow.js";
import { releaseDocumentationReadinessSearch } from "../src/readiness/release-workflow.js";
import { documentationAuditSearch } from "../src/maturity/audit-search-plan.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import {
  LocalSourceObligationSourceObserver,
  listPreservationSources,
} from "../src/workflow-execution/source-obligation-observer.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { iaDiscoverySearch } from "../src/ia/discovery-search-plan.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import * as runnerStepLoop from "../src/workflow-execution/runner-step-loop.js";
import { requireConsumedStepSummaries } from "../src/workflow-execution/runner-step-loop.js";
import { createDocumentationPlanBinding } from "../src/workflow-execution/plan-binding.js";
import { readyContextPreflight } from "./helpers.js";
import { commitFixture, initFixtureRepo } from "./helpers/git.js";
import {
  inventorySearchCoordinatorFixture,
  preservationSourceObserverFixture,
  sourceObligationObserverFixture,
  verificationFixture,
  verificationResultFixture,
} from "./helpers/verification.js";
import {
  hasInventoryBeforeWrite,
  hasSourceObligationPhases,
  requiresSourceObligationLedger,
  requiresTechnicalCorrection,
} from "../src/workflow-execution/source-obligation.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestRoot = resolve(projectRoot, "workflows");
const roots: string[] = [];

function loadFrom(root: string) {
  return loadWorkflowManifestCatalog({
    root,
    searchPlans: {
      "documentation-audit": documentationAuditSearch,
      "documentation-observation": documentationObservationSearch,
      "information-architecture-discovery": iaDiscoverySearch,
      "source-readiness": sourceReadinessSearch,
      "release-documentation-readiness": releaseDocumentationReadinessSearch,
    },
  });
}

function inventoryRuntime(baseRevision?: string) {
  return {
    workflowSearch: inventorySearchCoordinatorFixture,
    sourceObligationObserver: baseRevision
      ? preservationSourceObserverFixture(baseRevision)
      : sourceObligationObserverFixture,
  };
}

function sixPathRestructurePreservationHandoff() {
  const baseRevision = "735d162e2134cbc6c284bac022686ec2e14063bc";
  const writerPaths = [
    "docs/collections/README.md",
    "docs/collections/guide.md",
    "docs/collections/reference.md",
    "fern/pages/collections/_index.mdx",
    "fern/pages/collections/concepts.mdx",
    "fern/pages/collections/guide.mdx",
  ];
  const plannerSummary = JSON.stringify({
    schemaVersion: 1,
    kind: "docsfab-restructure-preservation-map",
    baseRevision,
    baseTreeSha256: "c159ab7c42dae99f29911672ae9f575df4f6a094da89f4ef7d0f29f80ce609ca",
    candidateBinding: {
      state: "post-write-candidate-required",
      exactAllowedPaths: writerPaths,
    },
    obligations: [
      {
        obligationId: "published-route",
        entryPoint: "fern/pages/collections/concepts.mdx",
        baseLocator: "fern/pages/collections/concepts.mdx#worktree-security",
        approvedDestination: "fern/pages/setup/worktree-security.mdx#worktrees-project-scope",
        checkId: "navigation-route-and-anchor",
      },
      {
        obligationId: "overview-entry-contract",
        entryPoint: "fern/pages/collections/_index.mdx",
        baseLocator: "fern/pages/collections/_index.mdx#source-types",
        approvedDestination: "fern/pages/collections/_index.mdx#source-types",
        requiredFacts: [
          "`::` selects a named source scope.",
          "A remote registry is not a router source type.",
        ],
        checkId: "entry-point-facts",
      },
      {
        obligationId: "meaningful-deep-link",
        entryPoint: "docs/collections/README.md",
        baseLocator: "docs/collections/README.md#profile-help",
        approvedDestination: "docs/collections/guide.md#docs-job-mcp-profile",
        checkId: "meaningful-deep-link",
      },
    ],
  });
  const planBinding = createDocumentationPlanBinding(
    {
      mode: "restructure",
      pages: writerPaths.map((path) => ({ path, disposition: "restructure" as const })),
      sourceBindings: writerPaths.map((pagePath) => ({
        pagePath,
        sources: [`git:${baseRevision}:${pagePath}`],
      })),
    },
    { expectedMode: "restructure" },
  );
  return { baseRevision, writerPaths, plannerSummary, planBinding };
}

describe("declarative runtime workflow manifests", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("loads the complete operator-runnable workflow catalog from top-level manifests", () => {
    const catalog = loadFrom(manifestRoot);
    expect(Object.keys(catalog)).toEqual([...DECLARATIVE_WORKFLOW_NAMES]);
    expect(catalog["create-documentation"].steps.map((step) => step.skill)).toContain(
      "write-documentation",
    );
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog["restructure-documentation"])).toBe(true);
    expect(Object.isFrozen(catalog["restructure-documentation"].steps)).toBe(true);
  });

  it("binds the standalone comprehensive evaluator to all earlier evidence", () => {
    const catalog = loadFrom(manifestRoot);
    const workflow = catalog["review-documentation"]!;
    const evaluator = workflow.steps.at(-1)!;
    expect(evaluator.skill).toBe("evaluate-document-quality");
    expect(evaluator.mode).toBe("read-only");
    expect(evaluator.consumes).toEqual(
      workflow.steps
        .slice(0, -1)
        .filter(
          (step) =>
            !["derive-source-obligations", "provisional-technical-verification"].includes(step.id),
        )
        .map((step) => step.id),
    );
    for (const artifact of ["evaluation.json", "quality-score.json", "quality-report.md"]) {
      expect(evaluator.prompt).toContain(artifact);
    }
    expect(evaluator.prompt).toContain("The model writes the report narrative");
    expect(evaluator.prompt).toContain("the host writes the validated result summary");
    expect(evaluator.prompt).not.toContain("docsfab-quality-report-v0.1");
    expect(evaluator.prompt).not.toContain("quality-report.schema.json");
    expect(evaluator.prompt).toContain("Do not edit source files");
  });

  it.each([
    ["create-documentation", 2],
    ["update-documentation", 2],
    ["restructure-documentation", 1],
  ] as const)(
    "keeps host-authored report summary instructions in %s",
    async (workflowName, count) => {
      const source = JSON.parse(
        await readFile(resolve(manifestRoot, `${workflowName}.json`), "utf8"),
      ) as {
        steps?: Array<{ skill: string; prompt: string }>;
        branches?: Array<{ steps: Array<{ skill: string; prompt: string }> }>;
        branching?: {
          prefix?: { steps: Array<{ skill: string; prompt: string }> };
          branches: Array<{ steps: Array<{ skill: string; prompt: string }> }>;
        };
      };
      const authoredSteps = [
        ...(source.steps ?? []),
        ...(source.branches?.flatMap((branch) => branch.steps) ?? []),
        ...(source.branching?.prefix?.steps ?? []),
        ...(source.branching?.branches.flatMap((branch) => branch.steps) ?? []),
      ];
      const evaluators = authoredSteps.filter((step) => step.skill === "evaluate-document-quality");

      expect(evaluators).toHaveLength(count);
      for (const evaluator of evaluators) {
        expect(evaluator.prompt).toContain("The model writes the report narrative");
        expect(evaluator.prompt).toContain("the host writes the validated result summary");
        expect(evaluator.prompt).not.toContain("docsfab-quality-report-v0.1");
        expect(evaluator.prompt).not.toContain("quality-report.schema.json");
      }
    },
  );

  it.each(["create-documentation", "update-documentation"] as const)(
    "binds %s audience evidence before final quality evaluation",
    (workflowName) => {
      const workflow = loadFrom(manifestRoot)[workflowName]!;
      const audience = workflow.steps.find((step) => step.id === "test-audience-understanding")!;
      const evaluator = workflow.steps.at(-1)!;

      expect(workflow.steps.indexOf(audience)).toBe(workflow.steps.length - 2);
      expect(audience).toMatchObject({
        kind: "evaluate",
        skill: "test-audience-understanding",
        mode: "read-only",
      });
      expect(workflow.contextPolicy.steps.at(-2)).toMatchObject({
        stepId: audience.id,
        required: true,
        allowReadOnlyDegraded: true,
      });
      expect(audience.prompt).toContain("Exclude author, reviewer, evaluator, scoring oracle");
      expect(audience.prompt).toContain("candidate revision mismatch");
      expect(evaluator.consumes).toContain("test-audience-understanding");
      expect(evaluator.consumesEvidence).toContain(
        workflowName === "create-documentation"
          ? "verify-revised-technical-accuracy"
          : "verify-technical-accuracy",
      );
      expect(evaluator.searchMode).toBe("reuse");
    },
  );

  it("loads the strict update-only V2 fixed prefix and two branch suffixes", () => {
    const workflow = loadFrom(manifestRoot)["update-documentation"]!;
    expect(workflow.schemaVersion).toBe(2);
    expect(workflow.branching?.prefix.steps.map((step) => step.id)).toEqual(["plan-documentation"]);
    expect(workflow.branching?.selection).toEqual({
      afterStepId: "plan-documentation",
      kind: "editorial-candidate-v1",
    });
    expect(workflow.branching?.branches.map((branch) => branch.id)).toEqual([
      "author",
      "assess-no-change",
    ]);
    expect(workflow.branching?.branches[0].steps.map((step) => step.id)).toEqual([
      "derive-source-obligations",
      "write-documentation",
      "lint-documentation",
      "verify-technical-accuracy",
      "review-documentation",
      "test-audience-understanding",
      "evaluate-document-quality",
    ]);
    expect(workflow.branching?.branches[1].steps.map((step) => step.id)).toEqual([
      "verify-technical-accuracy",
      "review-documentation",
      "test-audience-understanding",
      "evaluate-document-quality",
    ]);
    expect(workflow.branching?.branches[1].steps.every((step) => step.mode === "read-only")).toBe(
      true,
    );
    const branches = workflow.branching?.branches ?? [];
    const author = branches.find((branch) => branch.id === "author")!;
    const noChange = branches.find((branch) => branch.id === "assess-no-change")!;
    const authorVerify = author.steps.find((step) => step.id === "verify-technical-accuracy")!;
    const authorReview = author.steps.find((step) => step.id === "review-documentation")!;
    const authorQuality = author.steps.find((step) => step.id === "evaluate-document-quality")!;
    const noChangeVerify = noChange.steps.find((step) => step.id === "verify-technical-accuracy")!;
    const noChangeReview = noChange.steps.find((step) => step.id === "review-documentation")!;
    const noChangeQuality = noChange.steps.find((step) => step.id === "evaluate-document-quality")!;

    expect(authorVerify.prompt).not.toContain("proposed no-change assessment");
    expect(authorReview.prompt).not.toContain("proposed no-change assessment");
    expect(authorQuality.prompt).not.toContain("proposed no-change assessment");
    expect(noChangeVerify.prompt).toContain("proposed no-change assessment");
    expect(noChangeVerify.prompt).toContain("exact admitted source");
    expect(noChangeVerify.prompt).toContain("supplied source locators");
    expect(noChangeReview.prompt).toContain("proposed no-change assessment");
    expect(noChangeReview.prompt).toContain("establishing findings independently");
    expect(noChangeReview.prompt).toContain("Do not repeat the scope inventory");
    expect(noChangeQuality.prompt).toContain("proposed no-change assessment");
    expect(noChangeQuality.prompt).toContain("supplied evidence package and exact target");
    expect(noChangeQuality.prompt).toContain("Do not rerun earlier reviews");
  });

  it("schedules inventory-only verify before write on update authoring and restructure", () => {
    const update = loadFrom(manifestRoot)["update-documentation"]!;
    const authorDerive = update.branching!.branches[0].steps[0]!;
    const authorWrite = update.branching!.branches[0].steps[1]!;
    const authorVerify = update.branching!.branches[0].steps.find(
      (step) => step.id === "verify-technical-accuracy",
    )!;
    expect(authorDerive).toMatchObject({
      id: "derive-source-obligations",
      skill: "verify-technical-accuracy",
      kind: "evaluate",
      mode: "read-only",
      searchMode: "revalidate",
    });
    expect(authorDerive.prompt).toContain("inventory-only mode");
    expect(authorDerive.prompt).toContain("admitted change evidence");
    expect(authorWrite.id).toBe("write-documentation");
    expect(authorWrite.consumes).toEqual(["plan-documentation", "derive-source-obligations"]);
    expect(update.branching!.branches[1].steps.map((step) => step.id)).not.toContain(
      "derive-source-obligations",
    );
    expect(hasInventoryBeforeWrite(update)).toBe(true);
    expect(hasSourceObligationPhases(update)).toBe(false);
    expect(requiresSourceObligationLedger({ workflow: update, step: authorDerive })).toBe(true);
    expect(requiresTechnicalCorrection({ workflow: update, step: authorVerify })).toBe(false);

    const restructure = loadFrom(manifestRoot)["restructure-documentation"]!;
    const restructureDerive = restructure.steps.find(
      (step) => step.id === "derive-source-obligations",
    )!;
    const restructureWrite = restructure.steps.find((step) => step.id === "write-documentation")!;
    const restructureVerify = restructure.steps.find(
      (step) => step.id === "verify-technical-accuracy",
    )!;
    expect(
      restructure.steps.map((step) => step.id).indexOf("derive-source-obligations"),
    ).toBeLessThan(restructure.steps.map((step) => step.id).indexOf("write-documentation"));
    expect(restructureDerive.skill).toBe("verify-technical-accuracy");
    expect(restructureDerive.prompt).toContain("inventory-only mode");
    expect(restructureDerive.consumes).toEqual(["plan-documentation"]);
    expect(restructureDerive.consumesEvidence).toEqual(["plan-documentation"]);
    expect(restructureWrite.consumes).toEqual(["plan-documentation", "derive-source-obligations"]);
    expect(hasInventoryBeforeWrite(restructure)).toBe(true);
    expect(hasSourceObligationPhases(restructure)).toBe(false);
    expect(requiresSourceObligationLedger({ workflow: restructure, step: restructureDerive })).toBe(
      true,
    );
    expect(requiresTechnicalCorrection({ workflow: restructure, step: restructureVerify })).toBe(
      false,
    );
  });

  it("binds restructure planning and writing to immutable page-specific preservation evidence", () => {
    const workflow = loadFrom(manifestRoot)["restructure-documentation"]!;
    const planner = workflow.steps.find((step) => step.id === "plan-documentation")!;
    const writer = workflow.steps.find((step) => step.id === "write-documentation")!;

    expect(planner.prompt).toContain("immutable base evidence");
    expect(planner.prompt).toContain("explicit user and workflow requirements independently");
    expect(planner.prompt).toContain("repository paths from published routes");
    expect(planner.prompt).toContain("Return the complete preservation map in the planner summary");
    expect(planner.prompt).toContain("reason ambiguous-scope");
    expect(writer.consumes).toEqual(["plan-documentation", "derive-source-obligations"]);
    expect(writer.consumesEvidence).toEqual(["plan-documentation", "derive-source-obligations"]);
    expect(writer.prompt).toContain("exact bound preservation map");
    expect(writer.prompt).toContain("change only host-authorized paths");
    expect(writer.prompt).toContain("separate result for every obligation");
    expect(writer.prompt).toContain("Do not reconstruct the base from the mutable workspace");
    const review = workflow.steps.find((step) => step.id === "review-documentation")!;
    expect(review.consumes).toEqual(["plan-documentation"]);
    expect(review.consumesEvidence).toEqual(["plan-documentation"]);
    expect(review.consumes).not.toContain("write-documentation");
    expect(review.prompt).toContain("preservation review");
    expect(review.prompt).toContain("one result per obligation");
    expect(review.prompt).toContain("not only repository source paths");
    expect(review.prompt).toContain("or consume writer conclusions");
    expect(planner.prompt).toContain(
      "later independent preservation review consumes this retained map",
    );
    const evaluator = workflow.steps.find((step) => step.id === "evaluate-document-quality")!;
    expect(evaluator.prompt).toContain("Keep independent preservation-review results separate");
  });

  it("delivers the exact multi-page preservation summary to the restructure writer", async () => {
    const { baseRevision, writerPaths, plannerSummary, planBinding } =
      sixPathRestructurePreservationHandoff();
    const calls: HarnessStepInput[] = [];
    const harness: AgentHarness = {
      runStep: async (input) => {
        calls.push(input);
        if (input.step.id === "plan-documentation") {
          return { summary: plannerSummary, planBinding };
        }
        if (input.step.id === "derive-source-obligations") {
          return verificationFixture(input);
        }
        return { summary: `${input.step.id} completed` };
      },
    };
    const store = new ManifestTestRunStore();
    const runner = new WorkflowRunner({
      harness,
      hostOperations: {
        runStep: async (input) => {
          calls.push(input);
          return { summary: "Stop after the writer context assertion.", outcome: "needs-input" };
        },
      },
      store,
      repositoryScanner: manifestTestScanner,
      contextPreflight: readyContextPreflight,
      repositoryEvidence: new ManifestTestRepositoryEvidence(writerPaths[0]!),
      ...inventoryRuntime(baseRevision),
      id: () => "restructure-preservation-handoff",
    });

    const record = await runner.run({
      workflow: "restructure-documentation",
      workspacePath: "/tmp/docsfab-preservation-handoff",
      repository: {
        sourcePath: "/tmp/docsfab-preservation-source",
        requestedRevision: baseRevision,
        revision: baseRevision,
      },
      allowWrite: true,
    });

    expect(record.status, record.error).toBe("needs-input");
    const writerInput = calls.find((input) => input.step.id === "write-documentation")!;
    const consumed = JSON.parse(writerInput.step.prompt.split("\n").at(-1)!) as Array<{
      stepId: string;
      summary: string;
    }>;
    expect(consumed.map((item) => item.stepId)).toEqual([
      "plan-documentation",
      "derive-source-obligations",
    ]);
    expect(consumed[0]).toEqual({ stepId: "plan-documentation", summary: plannerSummary });
    expect(consumed[0]!.summary).toHaveLength(plannerSummary.length);
    expect(writerInput.preservationBaseEvidence?.repositoryRevision).toBe(baseRevision);
    expect(writerInput.preservationBaseEvidence?.sources.map((source) => source.path)).toEqual(
      [...writerPaths].sort(),
    );
    expect(Object.isFrozen(writerInput.preservationBaseEvidence)).toBe(true);
    expect(writerInput.planBinding).toEqual(planBinding);
    expect(Object.isFrozen(writerInput.planBinding)).toBe(true);
    expect(writerInput.planBinding?.pages.map((page) => page.path)).toEqual(
      writerPaths.toSorted((left, right) => left.localeCompare(right)),
    );
    for (const pagePath of writerPaths) {
      expect(
        new Set(
          writerInput.planBinding?.sourceBindings.find((binding) => binding.pagePath === pagePath)
            ?.sources,
        ),
      ).toEqual(new Set([`git:${baseRevision}:${pagePath}`]));
    }
    expect(writerInput.sealedEvidence?.map((binding) => binding.stepId)).toEqual([
      "plan-documentation",
      "derive-source-obligations",
    ]);
    expect(writerInput.sealedEvidence?.[0]).toEqual({
      stepId: "plan-documentation",
      evaluateEvidenceSha256: record.steps.find((step) => step.id === "plan-documentation")!
        .evaluateEvidence!.evaluatorIdentitySha256,
    });
  });

  it("keeps exact preservation evidence for review and withholds eager originals from audience assessment in stage-specific mode", async () => {
    const { baseRevision, writerPaths, plannerSummary, planBinding } =
      sixPathRestructurePreservationHandoff();
    const calls: HarnessStepInput[] = [];
    const harness: AgentHarness = {
      runStep: async (input) => {
        calls.push(input);
        if (input.step.id === "plan-documentation") {
          return { summary: plannerSummary, planBinding };
        }
        if (input.step.id === "derive-source-obligations") {
          return verificationFixture(input);
        }
        if (input.step.id === "verify-technical-accuracy") {
          return {
            summary: "Verified the six-path candidate.",
            verificationResult: verificationResultFixture(
              planBinding.pages.map((page) => page.path),
            ),
          };
        }
        if (input.step.id === "review-documentation") {
          return { summary: "Reviewer retains the complete preservation evidence." };
        }
        if (input.step.id === "test-audience-understanding") {
          return { summary: "Stop after the audience context assertion.", outcome: "needs-input" };
        }
        return { summary: `${input.step.id} completed` };
      },
    };
    const store = new ManifestTestRunStore();
    const runner = new WorkflowRunner({
      harness,
      hostOperations: {
        runStep: async (input) => {
          calls.push(input);
          return { summary: `${input.step.id} completed` };
        },
      },
      store,
      repositoryScanner: manifestTestScanner,
      contextPreflight: readyContextPreflight,
      repositoryEvidence: new ManifestTestRepositoryEvidence(writerPaths[0]!),
      ...inventoryRuntime(baseRevision),
      preservationBaseDelivery: "stage-specific",
      id: () => "restructure-preservation-review-handoff",
    });

    const record = await runner.run({
      workflow: "restructure-documentation",
      workspacePath: "/tmp/docsfab-preservation-review-handoff",
      repository: {
        sourcePath: "/tmp/docsfab-preservation-source",
        requestedRevision: baseRevision,
        revision: baseRevision,
      },
      allowWrite: true,
    });

    expect(record.status, record.error).toBe("needs-input");
    expect(calls.some((input) => input.step.id === "write-documentation")).toBe(true);
    const reviewInput = calls.find((input) => input.step.id === "review-documentation")!;
    const consumed = JSON.parse(reviewInput.step.prompt.split("\n").at(-1)!) as Array<{
      stepId: string;
      summary: string;
    }>;
    expect(consumed).toEqual([{ stepId: "plan-documentation", summary: plannerSummary }]);
    expect(consumed.map((item) => item.stepId)).not.toContain("write-documentation");
    expect(reviewInput.preservationBaseEvidence?.repositoryRevision).toBe(baseRevision);
    expect(reviewInput.preservationBaseEvidence?.sources.map((source) => source.path)).toEqual(
      [...writerPaths].sort(),
    );
    expect(Object.isFrozen(reviewInput.preservationBaseEvidence)).toBe(true);
    expect(reviewInput.planBinding).toEqual(planBinding);
    expect(Object.isFrozen(reviewInput.planBinding)).toBe(true);
    expect(reviewInput.planBinding?.pages.map((page) => page.path)).toEqual(
      writerPaths.toSorted((left, right) => left.localeCompare(right)),
    );
    expect(reviewInput.sealedEvidence).toEqual([
      {
        stepId: "plan-documentation",
        evaluateEvidenceSha256: record.steps.find((step) => step.id === "plan-documentation")!
          .evaluateEvidence!.evaluatorIdentitySha256,
      },
    ]);
    const audienceInput = calls.find((input) => input.step.id === "test-audience-understanding")!;
    expect(audienceInput.preservationBaseEvidence).toBeUndefined();
    expect(audienceInput.planBinding).toEqual(planBinding);
    expect(audienceInput.sourceReader).toBeUndefined();
    expect(audienceInput.preservationSourceReader).toMatchObject({
      kind: "docsfab-preservation-source-reader",
      stepId: "test-audience-understanding",
    });
  });

  it.each(["inspectSkill", "store.save"] as const)(
    "revokes the actual reader when audience %s fails after retaining it",
    async (failurePoint) => {
      const { baseRevision, writerPaths, plannerSummary, planBinding } =
        sixPathRestructurePreservationHandoff();
      const root = await mkdtemp(join(tmpdir(), "docsfab-reader-lifecycle-"));
      let workspace: Awaited<ReturnType<typeof prepareRepositoryWorkspace>> | undefined;
      let retainedReader: HarnessStepInput["preservationSourceReader"];
      try {
        for (const path of writerPaths) {
          const absolutePath = join(root, path);
          await mkdir(dirname(absolutePath), { recursive: true });
          await writeFile(absolutePath, `# Original ${path}\n`);
        }
        await initFixtureRepo(root, undefined, { branch: "main" });
        await commitFixture(root, "original preservation reader fixture");
        workspace = await prepareRepositoryWorkspace(root, "HEAD");
        const runId = `restructure-reader-${failurePoint.replace(".", "-")}`;
        const realObserver = new LocalSourceObligationSourceObserver(workspace);
        const { capture, evidence } = await realObserver.captureOriginalSourceAuthority({
          runId,
          workflow: getWorkflow("restructure-documentation"),
          repositoryRevision: workspace.revision,
          scopeSha256: "d".repeat(64),
          workspaceSnapshotSha256: "e".repeat(64),
        });
        const reader = realObserver.createPreservationSourceReader({
          runId,
          stepId: "test-audience-understanding",
          repositoryRevision: workspace.revision,
          capture,
          authority: evidence,
          authorizedPaths: writerPaths,
        });
        const runtime = inventoryRuntime(baseRevision);
        const sourceObligationObserver = {
          ...runtime.sourceObligationObserver,
          createPreservationSourceReader: () => reader,
        };
        const store = new ManifestTestRunStore();
        let didFailAudienceSave = false;
        const guardedStore: RunStore = {
          save: async (record) => {
            if (
              failurePoint === "store.save" &&
              !didFailAudienceSave &&
              record.steps.find((step) => step.id === "test-audience-understanding")?.skillEvidence
            ) {
              didFailAudienceSave = true;
              throw new Error("injected audience store.save failure");
            }
            await store.save(record);
          },
        };
        const harness: AgentHarness = {
          inspectSkill: async (input) => {
            if (input.step.id === "test-audience-understanding") {
              retainedReader = input.preservationSourceReader;
              if (failurePoint === "inspectSkill") {
                throw new Error("injected audience inspectSkill failure");
              }
            }
            return { id: input.step.skill, contentSha256: "f".repeat(64) };
          },
          runStep: async (input) => {
            if (input.step.id === "plan-documentation") {
              return { summary: plannerSummary, planBinding };
            }
            if (input.step.id === "derive-source-obligations") {
              return verificationFixture(input);
            }
            if (input.step.id === "verify-technical-accuracy") {
              return {
                summary: "Verified the six-path candidate.",
                verificationResult: verificationResultFixture(
                  planBinding.pages.map((page) => page.path),
                ),
              };
            }
            return { summary: `${input.step.id} completed` };
          },
        };
        const runner = new WorkflowRunner({
          harness,
          hostOperations: { runStep: async () => ({ summary: "completed" }) },
          store: guardedStore,
          repositoryScanner: manifestTestScanner,
          contextPreflight: readyContextPreflight,
          repositoryEvidence: new ManifestTestRepositoryEvidence(writerPaths[0]!),
          workflowSearch: runtime.workflowSearch,
          sourceObligationObserver,
          preservationBaseDelivery: "stage-specific",
          id: () => runId,
        });
        const record = await runner.run({
          workflow: "restructure-documentation",
          workspacePath: root,
          repository: {
            sourcePath: root,
            requestedRevision: baseRevision,
            revision: baseRevision,
          },
          allowWrite: true,
        });

        expect(record.status).toBe("failed");
        expect(retainedReader).toBe(reader);
        expect(() => listPreservationSources(retainedReader!)).toThrow(/stale or invalid/u);
      } finally {
        await workspace?.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("refuses restructure consumption when the retained planner summary is absent", () => {
    const restructure = loadFrom(manifestRoot)["restructure-documentation"]!;
    const planner = restructure.steps.find((step) => step.id === "plan-documentation")!;
    const consumer = restructure.steps.find((step) => step.id === "derive-source-obligations")!;
    const baseRevision = "735d162e2134cbc6c284bac022686ec2e14063bc";
    const pagePath = "docs/collections/README.md";
    const planBinding = createDocumentationPlanBinding(
      {
        mode: "restructure",
        pages: [{ path: pagePath, disposition: "restructure" }],
        sourceBindings: [{ pagePath, sources: [`git:${baseRevision}:${pagePath}`] }],
      },
      { expectedMode: "restructure" },
    );
    const canonicalHandoff = {
      steps: [
        {
          id: planner.id,
          status: "succeeded",
          planBinding,
        },
      ],
    } as unknown as RunRecord;

    expect(consumer.consumes).toContain(planner.id);
    expect(() => requireConsumedStepSummaries(canonicalHandoff, consumer)).toThrow(
      'Workflow step "derive-source-obligations" requires a succeeded summary from earlier step "plan-documentation".',
    );
  });

  it("refuses a missing live planner summary before the restructure writer runs", async () => {
    const { baseRevision, writerPaths, plannerSummary, planBinding } =
      sixPathRestructurePreservationHandoff();
    const calls: HarnessStepInput[] = [];
    const originalStepLoop = runnerStepLoop.executeGovernedWorkflowStep;
    let removedLivePlannerSummary = false;
    const stepLoop = vi
      .spyOn(runnerStepLoop, "executeGovernedWorkflowStep")
      .mockImplementation(async (input) => {
        if (input.step.id === "derive-source-obligations") {
          const planner = input.record.steps.find((step) => step.id === "plan-documentation");
          expect(planner).toMatchObject({ status: "succeeded", summary: plannerSummary });
          expect(planner?.planBinding).toEqual(planBinding);
          delete planner!.summary;
          removedLivePlannerSummary = true;
        }
        return originalStepLoop(input);
      });

    try {
      const harness: AgentHarness = {
        runStep: async (input) => {
          calls.push(input);
          if (input.step.id === "plan-documentation") {
            return { summary: plannerSummary, planBinding };
          }
          return { summary: `${input.step.id} completed` };
        },
      };
      const runner = new WorkflowRunner({
        harness,
        hostOperations: {
          runStep: async (input) => {
            calls.push(input);
            return { summary: `${input.step.id} completed` };
          },
        },
        store: new ManifestTestRunStore(),
        repositoryScanner: manifestTestScanner,
        contextPreflight: readyContextPreflight,
        repositoryEvidence: new ManifestTestRepositoryEvidence(writerPaths[0]!),
        ...inventoryRuntime(baseRevision),
        id: () => "restructure-missing-live-planner-summary",
      });

      const record = await runner.run({
        workflow: "restructure-documentation",
        workspacePath: "/tmp/docsfab-missing-live-planner-summary",
        repository: {
          sourcePath: "/tmp/docsfab-preservation-source",
          requestedRevision: baseRevision,
          revision: baseRevision,
        },
        allowWrite: true,
      });

      const refusal =
        'Workflow step "derive-source-obligations" requires a succeeded summary from earlier step "plan-documentation".';
      expect(removedLivePlannerSummary).toBe(true);
      expect(record.status).toBe("failed");
      expect(record.error).toBe(refusal);
      expect(record.steps.find((step) => step.id === "derive-source-obligations")).toMatchObject({
        status: "failed",
        error: refusal,
      });
      expect(calls.some((input) => input.step.id === "derive-source-obligations")).toBe(false);
      expect(calls.some((input) => input.step.id === "write-documentation")).toBe(false);
    } finally {
      stepLoop.mockRestore();
    }
  });

  it.each([
    "create-documentation",
    "update-documentation",
    "review-documentation",
    "restructure-documentation",
  ] as const)("delivers host checks and findings to the %s evaluator", (name) => {
    const workflow = loadFrom(manifestRoot)[name]!;
    const lint = workflow.steps.find((step) => step.id === "lint-documentation")!;
    expect(lint.kind).toBe("host-operation");
    expect(lint.mode).toBe("read-only");
    if (name === "create-documentation") {
      expect(workflow.schemaVersion).toBe(3);
      const reviseEvaluator = workflow
        .authoringSchedule!.branches.find((branch) => branch.id === "revise")!
        .steps.at(-1)!;
      expect(reviseEvaluator.id).toBe("evaluate-document-quality");
      expect(reviseEvaluator.consumes).toEqual([
        "lint-revised-documentation",
        "verify-revised-technical-accuracy",
        "review-revised-documentation",
        "test-audience-understanding",
      ]);
    } else {
      expect(workflow.steps.at(-1)!.consumes).toEqual(
        workflow.steps
          .slice(0, -1)
          .filter(
            (step) =>
              (name === "update-documentation" ||
                !["plan-documentation", "write-documentation"].includes(step.skill)) &&
              !["derive-source-obligations", "provisional-technical-verification"].includes(
                step.id,
              ),
          )
          .map((step) => step.id),
      );
    }
    const review = workflow.steps.find((step) => step.id === "review-documentation")!;
    expect(review.consumes ?? []).not.toContain("write-documentation");
  });

  it("fails closed for an incomplete manifest set", async () => {
    const root = await copyManifests();
    await rm(resolve(root, "create-documentation.json"));
    expect(() => loadFrom(root)).toThrow(/manifest set mismatch/u);
  });

  it("rejects unknown keys and context policies that drift from ordered steps", async () => {
    const extraRoot = await copyManifests();
    const createPath = resolve(extraRoot, "create-documentation.json");
    const create = JSON.parse(await readFile(createPath, "utf8")) as Record<string, unknown>;
    create.router = "model-selected";
    await writeFile(createPath, `${JSON.stringify(create, null, 2)}\n`, "utf8");
    expect(() => loadFrom(extraRoot)).toThrow(/unsupported by .* schema: router/u);

    const driftRoot = await copyManifests();
    const restructurePath = resolve(driftRoot, "restructure-documentation.json");
    const restructure = JSON.parse(await readFile(restructurePath, "utf8")) as {
      contextPolicy: { steps: Array<{ stepId: string }> };
    };
    restructure.contextPolicy.steps[0]!.stepId = "substituted-step";
    await writeFile(restructurePath, `${JSON.stringify(restructure, null, 2)}\n`, "utf8");
    expect(() => loadFrom(driftRoot)).toThrow(/must match workflow step ids in order/u);
  });

  it("rejects a searchPlan without searchMode and two observe steps of the same plan", async () => {
    const missingModeRoot = await copyManifests();
    const createPath = resolve(missingModeRoot, "create-documentation.json");
    const create = JSON.parse(await readFile(createPath, "utf8")) as {
      schemaVersion: number;
      steps?: Array<Record<string, unknown>>;
      prefix?: { steps: Array<Record<string, unknown>> };
    };
    const createPrefixStep =
      create.schemaVersion === 3 ? create.prefix!.steps[0]! : create.steps![0]!;
    delete createPrefixStep.searchMode;
    await writeFile(createPath, `${JSON.stringify(create, null, 2)}\n`, "utf8");
    expect(() => loadFrom(missingModeRoot)).toThrow(/searchPlan and searchMode together/u);

    const twoObserveRoot = await copyManifests();
    const updatePath = resolve(twoObserveRoot, "update-documentation.json");
    const update = JSON.parse(await readFile(updatePath, "utf8")) as {
      branches: Array<{ steps: Array<Record<string, unknown>> }>;
    };
    const verify = update.branches[0]!.steps.find(
      (step) => step.id === "verify-technical-accuracy",
    )!;
    verify.searchMode = "observe";
    await writeFile(updatePath, `${JSON.stringify(update, null, 2)}\n`, "utf8");
    expect(() => loadFrom(twoObserveRoot)).toThrow(/cannot observe search plan/u);
  });
});

async function copyManifests(): Promise<string> {
  const parent = await mkdtemp(resolve(tmpdir(), "docsfab-workflow-manifests-"));
  roots.push(parent);
  const root = resolve(parent, "workflows");
  await cp(manifestRoot, root, { recursive: true });
  return root;
}

class ManifestTestRunStore implements RunStore {
  public readonly records: RunRecord[] = [];

  public async save(record: RunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

class ManifestTestRepositoryEvidence implements RepositoryEvidenceCollector {
  public constructor(private readonly changedPath: string) {}

  public async capture(context: RepositoryEvidenceContext): Promise<ChangeEvidence> {
    return {
      files: [{ path: this.changedPath, status: "modified" }],
      ...(context.persistPatch
        ? {
            patch: {
              sha256: "b".repeat(64),
              byteLength: 128,
              lineCount: 8,
              artifactPath: ".docsfab/patches/restructure-preservation-handoff.patch",
              format: "git-diff" as const,
            },
          }
        : {}),
    };
  }
}

const manifestTestScanner: RepositorySecurityScanner = {
  scan: async () => ({
    ruleSet: "manifest-test-v1",
    status: "passed",
    scannedFiles: 6,
    binaryFiles: 0,
    findings: [],
  }),
};
