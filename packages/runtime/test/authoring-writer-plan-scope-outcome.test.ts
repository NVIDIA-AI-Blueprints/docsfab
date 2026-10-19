// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A writer plan-scope stop is a supported product outcome, not a
 * `workflow-outcome-projection-invalid-record` failure. These tests drive a
 * writer whose edit the confinement refused through the real `WorkflowRunner`
 * with the shipped projector, then every operator surface.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AuthoringQualityWorkflowOutcomeProjector,
  planScopeGovernedInputOutcome,
} from "../src/evaluation-report/authoring-outcome-projector.js";
import type {
  AgentHarness,
  HarnessStepInput,
  HostOperationExecutor,
} from "../src/execution/contracts.js";
import type { ChangeEvidence } from "../src/impact/contracts.js";
import { classifyRunResumability } from "../src/operator/run-resumability.js";
import { buildRunResultV1 } from "../src/operator/run-result.js";
import { buildRunHumanNextCommand, formatRunSummary } from "../src/operator/run-summary.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import type { RepositoryEvidenceCollector } from "../src/repository/contracts.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import type { RepositorySecurityScanner } from "../src/security/contracts.js";
import { workflowOutcomeState } from "../src/workflow-contracts/outcome.js";
import {
  admitPlanScopeStop,
  createPlanScopeStop,
} from "../src/workflow-contracts/plan-scope-stop.js";
import { documentationPlanBindingDigest } from "../src/workflow-execution/plan-binding.js";
import { applyWorkflowOutcome } from "../src/workflow-execution/runner-evidence.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { readyContextPreflight } from "./helpers.js";
import { scriptedEditorialProtocol } from "./helpers/editorial-protocol.js";
import {
  preservationSourceObserverFixture,
  sourceObligationObserverFixture,
  verificationFixture,
} from "./helpers/verification.js";

const TARGET = "docs/guide.md";
const INPUT_ID = "documentation-plan:writer-mutation-outside-plan";
const STOP_SENTENCE =
  "Writer requested a path outside the approved documentation plan; a new plan is required.";

class MemoryStore implements RunStore {
  public records: RunRecord[] = [];
  public async save(record: RunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

class PassingScanner implements RepositorySecurityScanner {
  public async scan() {
    return {
      ruleSet: "test-v1",
      status: "passed" as const,
      scannedFiles: 1,
      binaryFiles: 0,
      findings: [],
    };
  }
}

/** The writer's in-plan write landed, as in the live runs. */
class WrittenEvidence implements RepositoryEvidenceCollector {
  public async capture(): Promise<ChangeEvidence> {
    const patch = `diff --git a/${TARGET} b/${TARGET}\n`;
    return {
      files: [{ path: TARGET, status: "modified" }],
      patch: {
        sha256: createHash("sha256").update(patch).digest("hex"),
        byteLength: patch.length,
        lineCount: 1,
        artifactPath: ".docsfab/patches/writer-stop.patch",
        format: "git-diff",
      },
    };
  }
}

type Mode = "update" | "restructure";

function plan(mode: Mode) {
  const pages = [{ path: TARGET, disposition: mode }];
  const sourceBindings = [{ pagePath: TARGET, sources: ["src/api.ts:1"] }];
  return {
    kind: "docsfab-documentation-plan" as const,
    schemaVersion: 1 as const,
    mode,
    pages,
    sourceBindings,
    digest: documentationPlanBindingDigest({ mode, pages, sourceBindings }),
  };
}

/**
 * The recorded live writer: one refused edit (aggregated as `denied-path`), one
 * successful write, and the host-internal mutation-denial count the confined
 * tools report.
 */
class WriterStopHarness implements AgentHarness, HostOperationExecutor {
  public readonly calls: string[] = [];

  public constructor(
    private readonly mode: Mode,
    private readonly refusedMutations = 1,
  ) {}

  public async runStep(input: HarnessStepInput): ReturnType<AgentHarness["runStep"]> {
    this.calls.push(input.step.id);
    const common = {
      model: { provider: "hosted", model: "test-model" },
      skill: { id: input.step.skill, contentSha256: "a".repeat(64) },
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, turns: 1 },
    };
    if (input.step.id === "plan-documentation") {
      return {
        ...common,
        summary: `Plan the ${this.mode} of ${TARGET}.`,
        ...(await verificationFixture(input)),
        planBinding: plan(this.mode),
      };
    }
    if (input.step.id === "write-documentation") {
      return {
        ...common,
        summary: `Wrote ${TARGET}.`,
        tools: {
          totalCalls: 2 + this.refusedMutations,
          failedCalls: this.refusedMutations,
          byTool: [
            { name: "edit", calls: this.refusedMutations, failures: this.refusedMutations },
            { name: "read", calls: 1, failures: 0 },
            { name: "write", calls: 1, failures: 0 },
          ],
          failureCategories: [{ category: "denied-path" as const, count: this.refusedMutations }],
        },
        mutationBoundaryDenials: this.refusedMutations,
      };
    }
    return { ...common, summary: `ran ${input.step.skill}`, ...(await verificationFixture(input)) };
  }
}

const workflowSearchFixture = {
  async search(input: Parameters<LocalWorkflowSearchCoordinator["search"]>[0]) {
    const repositoryPath = await mkdtemp(join(tmpdir(), "docsfab-writer-stop-search-"));
    try {
      await mkdir(join(repositoryPath, "docs"), { recursive: true });
      await mkdir(join(repositoryPath, "src"), { recursive: true });
      await writeFile(join(repositoryPath, TARGET), "# Guide\n\n## Errors\n");
      await writeFile(join(repositoryPath, "src/api.ts"), "export const api = 1;\n");
      return await new LocalWorkflowSearchCoordinator().search({ ...input, repositoryPath });
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  },
};

const WORKFLOW_FOR_MODE = {
  update: "update-documentation",
  restructure: "restructure-documentation",
} as const;

async function runWriterStop(mode: Mode, refusedMutations = 1) {
  const workflow = WORKFLOW_FOR_MODE[mode];
  const harness = new WriterStopHarness(mode, refusedMutations);
  const store = new MemoryStore();
  // UPDATE runs with its editorial host, as the CLI composes it.
  const editorial = mode === "update" ? scriptedEditorialProtocol(harness) : undefined;
  const record = await new WorkflowRunner({
    harness: editorial?.harness ?? harness,
    hostOperations: harness,
    store,
    repositoryScanner: new PassingScanner(),
    contextPreflight: readyContextPreflight,
    repositoryEvidence: new WrittenEvidence(),
    workflowSearch: workflowSearchFixture,
    sourceObligationObserver:
      mode === "restructure"
        ? preservationSourceObserverFixture("a".repeat(40))
        : sourceObligationObserverFixture,
    outcomeProjector: new AuthoringQualityWorkflowOutcomeProjector(),
    ...(editorial ? { workflowBranchEvidence: editorial.workflowBranchEvidence } : {}),
    id: () => `run-${workflow}-writer-stop`,
  }).run({
    workflow,
    workspacePath: "/tmp/docsfab-workspace/repository",
    repository: { sourcePath: "/tmp/repo", requestedRevision: "HEAD", revision: "a".repeat(40) },
    instruction: `Update ${TARGET} for a new user. Change only ${TARGET}.`,
    allowWrite: true,
  });
  return { record, harness, store, decodeOptions: editorial?.decodeOptions ?? {} };
}

async function projectStripped(record: RunRecord, mutate: (record: RunRecord) => void) {
  const stopped = structuredClone(record);
  delete stopped.workflowOutcome;
  mutate(stopped);
  return new AuthoringQualityWorkflowOutcomeProjector()
    .project(stopped)
    .then(() => undefined)
    .catch((error: unknown) => error);
}

describe("writer plan-scope stop outcome", () => {
  it.each(["update", "restructure"] as const)(
    "seals a %s writer stop as a needs-input workflow outcome",
    async (mode) => {
      const workflow = WORKFLOW_FOR_MODE[mode];
      const { record, harness, store, decodeOptions } = await runWriterStop(mode);

      expect(harness.calls.at(-1)).toBe("write-documentation");
      expect(record.status, record.error).toBe("needs-input");
      expect(record.error).toBeUndefined();
      expect(record.failure).toBeUndefined();
      expect(record.workflowOutcomeRejection).toBeUndefined();
      const writer = record.steps.find((step) => step.id === "write-documentation")!;
      expect(writer.status).toBe("needs-input");
      expect(writer.summary).toContain(STOP_SENTENCE);
      expect(writer.planScopeStop).toEqual({
        schemaVersion: 1,
        kind: "docsfab-documentation-plan-scope-stop",
        code: "writer-mutation-outside-plan",
        refusedMutations: 1,
      });

      const state = workflowOutcomeState(record, decodeOptions);
      expect(state.state).toBe("current");
      if (state.state !== "current") throw new Error("unreachable");
      expect(state.outcome).toMatchObject({
        disposition: "needs-input",
        findings: [
          {
            id: `finding:${INPUT_ID}`,
            kind: "missing-governed-input",
            severity: "blocking",
            code: "writer-mutation-outside-plan",
            inputId: INPUT_ID,
            evidenceIds: ["step:write-documentation"],
          },
        ],
        limitations: [],
        openDecisions: [
          {
            id: `decision:${INPUT_ID}`,
            kind: "governed-input",
            inputId: INPUT_ID,
            evidenceIds: ["step:write-documentation"],
          },
        ],
      });
      expect(store.records.at(-1)?.workflowOutcome).toEqual(record.workflowOutcome);

      // NEXT names the plan-scope stop and a governed-input retry, never doctor.
      const context = {
        record,
        recordPath: "/tmp/state/runs/run.json",
        exitCode: 0,
        repositoryPath: "/tmp/repo",
        editorialDecodeOptions: decodeOptions,
      };
      const next = buildRunHumanNextCommand(context);
      expect(next?.command).toBe(
        `docsfab run ${workflow} --repo '<original target checkout>' --instruction '<amended instruction with required governed input>' --patch-only`,
      );
      expect(next?.reason).toContain("writer-mutation-outside-plan; 1 refused edit/write call(s)");
      expect(next?.reason).toContain("so the plan includes every path the change needs");
      expect(next?.command).not.toContain("doctor");

      const summary = formatRunSummary({
        ...context,
        tty: false,
        ci: false,
        noColor: true,
      }).join("\n");
      expect(summary).toContain("Product disposition: needs-input");
      expect(summary).toContain(`Product open decisions: decision:${INPUT_ID}`);
      expect(summary).toContain(
        "Plan scope stop: writer-mutation-outside-plan at step write-documentation (1 refused edit/write call(s))",
      );
      expect(summary).not.toContain("FAILURE");
      expect(summary).not.toContain("docsfab doctor");

      const result = buildRunResultV1(context);
      expect(result.product.disposition).toBe("needs-input");
      expect(result.product.openDecisions).toEqual([`decision:${INPUT_ID}`]);

      await expect(
        classifyRunResumability(record, "/tmp/state/runs", undefined, decodeOptions),
      ).resolves.toEqual({ category: "blocked", reason: "needs-input" });
    },
  );

  it("records every refused mutation in the stop", async () => {
    const { record } = await runWriterStop("restructure", 3);
    expect(record.status, record.error).toBe("needs-input");
    expect(admitPlanScopeStop(record)).toEqual({
      stepId: "write-documentation",
      code: "writer-mutation-outside-plan",
      refusedMutations: 3,
    });
  });

  // Adjacent refusals: each is a needs-input record the projector must still
  // refuse, so the new branch admits only the coded, evidence-backed stop.
  it.each([
    {
      name: "the coded stop is absent (prose alone)",
      location: "$.steps[].planDiagnostic",
      mutate: (record: RunRecord) => {
        delete writerOf(record).planScopeStop;
      },
    },
    {
      name: "the stop claims more refusals than the recorded denied-path count",
      location: "$.steps[].planScopeStop",
      mutate: (record: RunRecord) => {
        writerOf(record).planScopeStop!.refusedMutations = 2;
      },
    },
    {
      name: "the recorded refusals were reads, not edit/write calls",
      location: "$.steps[].planScopeStop",
      mutate: (record: RunRecord) => {
        writerOf(record).tools!.byTool = [
          { name: "read", calls: 2, failures: 1 },
          { name: "write", calls: 1, failures: 0 },
        ];
      },
    },
    {
      // A malformed call is not a refused mutation, so it cannot back a stop.
      name: "every failed edit/write was malformed-arguments, not a refused path",
      location: "$.steps[].planScopeStop",
      mutate: (record: RunRecord) => {
        writerOf(record).tools!.failureCategories = [{ category: "malformed-arguments", count: 1 }];
      },
    },
    {
      name: "the stop counts a malformed call among its refused mutations",
      location: "$.steps[].planScopeStop",
      mutate: (record: RunRecord) => {
        const writer = writerOf(record);
        writer.planScopeStop!.refusedMutations = 2;
        writer.tools!.failedCalls = 2;
        writer.tools!.byTool = [
          { name: "edit", calls: 2, failures: 2 },
          { name: "read", calls: 1, failures: 0 },
          { name: "write", calls: 1, failures: 0 },
        ];
        writer.tools!.failureCategories = [
          { category: "denied-path", count: 1 },
          { category: "malformed-arguments", count: 1 },
        ];
      },
    },
    {
      name: "the stop sits on a read-only step",
      location: "$.steps[].planScopeStop",
      mutate: (record: RunRecord) => {
        writerOf(record).mode = "read-only";
      },
    },
    {
      name: "the writer's plan digest is not the planner's",
      location: "$.steps[].planScopeStop",
      mutate: (record: RunRecord) => {
        // A fresh object: the clone shares one plan object between both steps.
        writerOf(record).planBinding = { ...writerOf(record).planBinding!, digest: "f".repeat(64) };
      },
    },
    {
      name: "the writer's inference attempt did not succeed",
      location: "$.steps[].planScopeStop",
      mutate: (record: RunRecord) => {
        writerOf(record).inference!.attempts.at(-1)!.outcome = "timeout";
      },
    },
    {
      name: "a second step also stopped needs-input",
      location: "$.steps[].planScopeStop",
      mutate: (record: RunRecord) => {
        // Not the planner, whose own status is checked separately.
        record.steps.find((step) => step.id === "derive-source-obligations")!.status =
          "needs-input";
      },
    },
    {
      name: "the planner did not succeed",
      location: "$.steps[].planScopeStop",
      mutate: (record: RunRecord) => {
        record.steps.find((step) => step.id === "plan-documentation")!.status = "failed";
      },
    },
    {
      name: "the stop carries an unknown code",
      location: "$.steps[].planScopeStop",
      mutate: (record: RunRecord) => {
        (writerOf(record).planScopeStop as { code: string }).code = "writer-asked-nicely";
      },
    },
    {
      name: "the stop carries an extra key",
      location: "$.steps[].planScopeStop",
      mutate: (record: RunRecord) => {
        (writerOf(record).planScopeStop as unknown as Record<string, unknown>).path = "x";
      },
    },
  ])("still refuses a needs-input record when $name", async ({ location, mutate }) => {
    const { record } = await runWriterStop("restructure");
    expect(record.status, record.error).toBe("needs-input");
    expect(await projectStripped(record, mutate)).toMatchObject({
      code: "invalid-record",
      location,
    });
  });

  it("admits no stop outside the authoring workflows", async () => {
    const { record } = await runWriterStop("restructure");
    expect(admitPlanScopeStop(record)).toBeDefined();
    expect(admitPlanScopeStop({ ...record, workflow: "review-documentation" })).toBeUndefined();
  });

  it("fails the run with the named rule location when the stop cannot be admitted", async () => {
    const { record } = await runWriterStop("restructure");
    const stopped = structuredClone(record);
    delete stopped.workflowOutcome;
    writerOf(stopped).planScopeStop!.refusedMutations = 2;
    await applyWorkflowOutcome({
      outcomeProjector: new AuthoringQualityWorkflowOutcomeProjector(),
      record: stopped,
    });
    expect(stopped.status).toBe("failed");
    expect(stopped.workflowOutcomeRejection).toEqual({
      code: "workflow-outcome-projection-invalid-record",
      location: "$.steps[].planScopeStop",
    });
  });
});

function writerOf(record: RunRecord) {
  return record.steps.find((step) => step.id === "write-documentation")!;
}

/**
 * Recorded writer stops, reduced to their content-free step facts (provenance
 * in each fixture). As recorded (prose only) the stop is not admitted; with the coded field the new step loop
 * writes, the same recorded tool evidence and plan digests admit it.
 */
describe("the recorded live writer stops", () => {
  it.each(["update-77d2ec1e.json", "create-48ef1a5c.json"])(
    "admits %s only once the step loop records the coded stop",
    async (name) => {
      const recorded = JSON.parse(
        await readFile(
          new URL(`./fixtures/writer-plan-scope-stop/${name}`, import.meta.url),
          "utf8",
        ),
      ) as RunRecord & { workflowOutcomeRejection: { location: string } };
      expect(recorded.failure?.code).toBe("workflow-outcome-projection-invalid-record");
      // The stop as the step loop left it, before the projector failed the run.
      const stopped = { ...structuredClone(recorded), status: "needs-input" as const };
      expect(admitPlanScopeStop(stopped)).toBeUndefined();
      expect(planScopeGovernedInputOutcome(stopped)).toBeUndefined();

      const writer = stopped.steps.find((step) => step.id === "write-documentation")!;
      expect(writer.status).toBe("needs-input");
      writer.planScopeStop = createPlanScopeStop(1);
      expect(admitPlanScopeStop(stopped)).toEqual({
        stepId: "write-documentation",
        code: "writer-mutation-outside-plan",
        refusedMutations: 1,
      });
      expect(planScopeGovernedInputOutcome(stopped)).toMatchObject({
        disposition: "needs-input",
        openDecisions: [{ id: `decision:${INPUT_ID}`, evidenceIds: ["step:write-documentation"] }],
      });
      // The recorded evidence holds exactly one refused edit/write call.
      writer.planScopeStop = createPlanScopeStop(2);
      expect(admitPlanScopeStop(stopped)).toBeUndefined();
    },
  );
});
