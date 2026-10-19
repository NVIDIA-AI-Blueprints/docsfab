// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A planner needs-input stop is a supported product outcome, not a
 * `workflow-outcome-projection-invalid-record` failure. These tests drive the
 * recorded `plan-documentation` stop through the real `WorkflowRunner` with the
 * shipped projector for each authoring job.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AuthoringQualityWorkflowOutcomeError,
  AuthoringQualityWorkflowOutcomeProjector,
  type AuthoringQualityOutcomeWorkflow,
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
import type {
  RepositoryEvidenceCollector,
  RepositoryEvidenceContext,
} from "../src/repository/contracts.js";
import { RepositoryEvidenceProvenanceError } from "../src/repository/contracts.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import type { RepositorySecurityScanner } from "../src/security/contracts.js";
import { workflowOutcomeState } from "../src/workflow-contracts/outcome.js";
import { createAuthoringCandidate } from "../src/workflow-execution/authoring-candidate.js";
import type { AuthoringCandidateLifecycleV1 } from "../src/workflow-execution/authoring-runtime.js";
import type { AuthoringCandidateCaptureV1 } from "../src/workflow-execution/authoring-workspace-host.js";
import { applyWorkflowOutcome } from "../src/workflow-execution/runner-evidence.js";
import { canProbeCleanPlannerStop, WorkflowRunner } from "../src/workflow-execution/runner.js";
import { readyContextPreflight } from "./helpers.js";
import { scriptedEditorialProtocol } from "./helpers/editorial-protocol.js";
import { sourceObligationObserverFixture, verificationFixture } from "./helpers/verification.js";
import { journeyTestTimeoutMs } from "./support/journey.js";

const PLANNER_STOP_SUMMARY =
  "Restructure is blocked by an explicit preservation obligation conflict for docs/guide.md#more-help.";

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

class EmptyEvidence implements RepositoryEvidenceCollector {
  public readonly calls: boolean[] = [];
  public async capture(context?: RepositoryEvidenceContext): Promise<ChangeEvidence> {
    this.calls.push(context?.persistPatch ?? true);
    if (context?.persistPatch === false) return { files: [] };
    return {
      files: [],
      patch: {
        sha256: createHash("sha256").update("").digest("hex"),
        byteLength: 0,
        lineCount: 0,
        artifactPath: ".docsfab/patches/planner-stop.patch",
        format: "git-diff",
      },
    };
  }
}

/** The planner stops with the recorded governed-input diagnostic shape. */
class PlannerStopHarness implements AgentHarness, HostOperationExecutor {
  public readonly calls: string[] = [];

  public constructor(private readonly code: string) {}

  public async runStep(input: HarnessStepInput): ReturnType<AgentHarness["runStep"]> {
    this.calls.push(input.step.id);
    const common = {
      model: { provider: "hosted", model: "test-model" },
      skill: { id: input.step.skill, contentSha256: "a".repeat(64) },
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, turns: 1 },
      tools: { totalCalls: 0, failedCalls: 0, byTool: [], failureCategories: [] },
    };
    if (input.step.id === "plan-documentation") {
      return {
        ...common,
        summary: PLANNER_STOP_SUMMARY,
        outcome: "needs-input" as const,
        planDiagnostic: {
          schemaVersion: 1 as const,
          kind: "docsfab-documentation-plan-diagnostic" as const,
          code: this.code,
          responseSha256: "7".repeat(64),
          responseShape: "json-object" as const,
        },
      };
    }
    return { ...common, summary: `ran ${input.step.skill}`, ...(await verificationFixture(input)) };
  }
}

/** CREATE seals candidates through this port; a planner stop reaches none of it. */
class UnreachedAuthoringLifecycle implements AuthoringCandidateLifecycleV1 {
  public readonly calls: string[] = [];

  public async plannedTargetCollisions(): Promise<readonly []> {
    return [];
  }

  public async sealCandidate0(input: {
    runId: string;
    repository: { revision: string };
    planDigest: string;
    writePaths: readonly string[];
  }): Promise<AuthoringCandidateCaptureV1> {
    this.calls.push("seal-0");
    const evidence = await new EmptyEvidence().capture();
    const candidate = createAuthoringCandidate({
      runId: input.runId,
      ordinal: 0,
      originalRevision: input.repository.revision,
      planDigest: input.planDigest,
      writePaths: input.writePaths,
      patchDigestSha256: evidence.patch!.sha256,
      patchBytes: evidence.patch!.byteLength,
      workspaceSnapshotDigest: "2".repeat(64),
    });
    return { candidate, evidence } as unknown as AuthoringCandidateCaptureV1;
  }

  public async prepareRevision(): Promise<never> {
    this.calls.push("prepare-1");
    throw new Error("A planner stop must not prepare a revision.");
  }

  public async sealCandidate1(): Promise<never> {
    this.calls.push("seal-1");
    throw new Error("A planner stop must not seal candidate one.");
  }

  public async observeRevisionChangedPaths(): Promise<never> {
    this.calls.push("observe-1");
    throw new Error("A planner stop must not observe a revision.");
  }

  public async resetRevision(): Promise<void> {
    this.calls.push("reset-1");
  }

  public async captureFailedPartial() {
    this.calls.push("partial-1");
    return {
      selected: false as const,
      evidence: await new EmptyEvidence().capture(),
      workspaceSnapshotDigest: "6".repeat(64),
    };
  }

  public async materializeSelected(input: { capture: AuthoringCandidateCaptureV1 }) {
    this.calls.push(`materialize-${input.capture.candidate.ordinal}`);
    return input.capture.evidence;
  }

  public async dispose(): Promise<void> {
    this.calls.push("dispose");
  }
}

const workflowSearchFixture = {
  async search(input: Parameters<LocalWorkflowSearchCoordinator["search"]>[0]) {
    const repositoryPath = await mkdtemp(join(tmpdir(), "docsfab-planner-stop-search-"));
    try {
      await mkdir(join(repositoryPath, "docs"), { recursive: true });
      await writeFile(join(repositoryPath, "docs/guide.md"), "# Guide\n\n## Errors\n");
      return await new LocalWorkflowSearchCoordinator().search({ ...input, repositoryPath });
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  },
};

async function runPlannerStop(
  workflow: AuthoringQualityOutcomeWorkflow,
  code: string,
  collector?: RepositoryEvidenceCollector | null,
) {
  const harness = new PlannerStopHarness(code);
  const lifecycle = new UnreachedAuthoringLifecycle();
  const store = new MemoryStore();
  const evidence = new EmptyEvidence();
  // UPDATE runs with its editorial host, as the CLI composes it; the planner
  // stop returns no editorial proposal.
  const editorial =
    workflow === "update-documentation" ? scriptedEditorialProtocol(harness) : undefined;
  const record = await new WorkflowRunner({
    harness,
    hostOperations: harness,
    store,
    repositoryScanner: new PassingScanner(),
    contextPreflight: readyContextPreflight,
    ...(collector === null ? {} : { repositoryEvidence: collector ?? evidence }),
    workflowSearch: workflowSearchFixture,
    sourceObligationObserver: sourceObligationObserverFixture,
    outcomeProjector: new AuthoringQualityWorkflowOutcomeProjector(),
    ...(workflow === "create-documentation" ? { authoringCandidateLifecycle: lifecycle } : {}),
    ...(editorial ? { workflowBranchEvidence: editorial.workflowBranchEvidence } : {}),
    id: () => `run-${workflow}-planner-stop`,
  }).run({
    workflow,
    workspacePath: "/tmp/docsfab-workspace/repository",
    repository: { sourcePath: "/tmp/repo", requestedRevision: "HEAD", revision: "a".repeat(40) },
    instruction: "Reorder docs/guide.md for a new user and preserve every existing anchor.",
    allowWrite: true,
  });
  return {
    record,
    harness,
    lifecycle,
    store,
    evidence,
    decodeOptions: editorial?.decodeOptions ?? {},
  };
}

const PLANNER_STOPS = [
  // The recorded live shape.
  { workflow: "restructure-documentation", code: "ambiguous-scope" },
  { workflow: "create-documentation", code: "missing-source" },
  { workflow: "update-documentation", code: "missing-information" },
] as const satisfies readonly { workflow: AuthoringQualityOutcomeWorkflow; code: string }[];

describe("authoring planner needs-input outcome (#1354)", () => {
  it.each(PLANNER_STOPS)(
    "persists a $workflow planner $code stop as a needs-input workflow outcome",
    async ({ workflow, code }) => {
      const { record, harness, lifecycle, store, evidence, decodeOptions } = await runPlannerStop(
        workflow,
        code,
      );

      expect(harness.calls.at(-1)).toBe("plan-documentation");
      expect(lifecycle.calls).not.toContain("seal-0");
      expect(record.status, record.error).toBe("needs-input");
      expect(record.error).toBeUndefined();
      expect(record.failure).toBeUndefined();
      expect(record.workflowOutcomeRejection).toBeUndefined();
      expect(record.changes?.patch).toBeUndefined();
      expect(evidence.calls).toEqual(workflow === "update-documentation" ? [] : [false]);

      const inputId = `documentation-plan:${code}`;
      const state = workflowOutcomeState(record, decodeOptions);
      expect(state.state).toBe("current");
      if (state.state !== "current") throw new Error("unreachable");
      expect(state.outcome).toMatchObject({
        disposition: "needs-input",
        findings: [
          {
            id: `finding:documentation-plan:${code}`,
            kind: "missing-governed-input",
            severity: "blocking",
            code,
            inputId,
            evidenceIds: ["step:plan-documentation"],
          },
        ],
        limitations: [],
        openDecisions: [
          {
            id: `decision:documentation-plan:${code}`,
            kind: "governed-input",
            inputId,
            evidenceIds: ["step:plan-documentation"],
          },
        ],
      });
      expect(store.records.at(-1)?.workflowOutcome).toEqual(record.workflowOutcome);

      // NEXT keeps the governed-input retry route, never doctor or inspect.
      const next = buildRunHumanNextCommand({
        record,
        recordPath: "/tmp/state/runs/run.json",
        exitCode: 0,
        repositoryPath: "/tmp/repo",
        editorialDecodeOptions: decodeOptions,
      });
      expect(next?.command).toBe(
        `docsfab run ${workflow} --repo '<original target checkout>' --instruction '<amended instruction with required governed input>' --patch-only`,
      );
      expect(next?.reason).toContain(`required governed input (${code})`);

      const summary = formatRunSummary({
        record,
        recordPath: "/tmp/state/runs/run.json",
        exitCode: 0,
        repositoryPath: "/tmp/repo",
        tty: false,
        ci: false,
        noColor: true,
        editorialDecodeOptions: decodeOptions,
      }).join("\n");
      expect(summary).toContain("Product disposition: needs-input");
      expect(summary).toContain(`Product open decisions: decision:documentation-plan:${code}`);
      expect(summary).toContain(`Planner diagnostic: ${code}`);
      expect(summary).not.toContain("FAILURE");
      expect(summary).not.toContain("docsfab doctor");

      const result = buildRunResultV1({
        record,
        recordPath: "/tmp/state/runs/run.json",
        exitCode: 0,
        repositoryPath: "/tmp/repo",
        editorialDecodeOptions: decodeOptions,
      });
      expect(result.product.disposition).toBe("needs-input");
      expect(result.plannerDiagnostic).toMatchObject({ category: "missing-governed-input", code });

      // A planner governed-input stop has no editorial InputAsk slot to fill,
      // so it is not offered as a `do --continue` stop.
      await expect(
        classifyRunResumability(record, "/tmp/state/runs", undefined, decodeOptions),
      ).resolves.toEqual({
        category: "blocked",
        reason: "needs-input",
      });
    },
  );

  it("keeps a patch when an unexpected pre-write change is observed", async () => {
    const calls: boolean[] = [];
    const evidence: RepositoryEvidenceCollector = {
      async capture(context) {
        calls.push(context.persistPatch);
        return {
          files: [{ path: "docs/unexpected.md", status: "added" }],
          ...(context.persistPatch
            ? { patch: await new EmptyEvidence().capture().then((item) => item.patch!) }
            : {}),
        };
      },
    };
    const { record } = await runPlannerStop("create-documentation", "missing-source", evidence);
    expect(calls).toEqual([false, true]);
    expect(record.status).toBe("needs-input");
    expect(record.changes?.patch).toBeDefined();
  });

  it("does not treat collector-supplied patch evidence as a clean stop", async () => {
    const calls: boolean[] = [];
    const evidence: RepositoryEvidenceCollector = {
      async capture(context) {
        calls.push(context.persistPatch);
        return new EmptyEvidence().capture();
      },
    };
    const { record } = await runPlannerStop("create-documentation", "missing-source", evidence);
    expect(calls).toEqual([false, true]);
    expect(record.changes?.patch).toBeDefined();
  });

  it.each(["provenance", "capture"] as const)(
    "keeps a probe %s failure fatal even if patch fallback succeeds",
    async (failure) => {
      const calls: boolean[] = [];
      const evidence: RepositoryEvidenceCollector = {
        async capture(context) {
          calls.push(context.persistPatch);
          if (!context.persistPatch) {
            if (failure === "provenance")
              throw new RepositoryEvidenceProvenanceError({ files: [] });
            throw new Error("evidence-capture-unavailable");
          }
          return new EmptyEvidence().capture();
        },
      };
      const { record } = await runPlannerStop("create-documentation", "missing-source", evidence);
      expect(calls).toEqual([false, true]);
      expect(record.status).toBe("failed");
      expect(record.failure?.code).toBe(
        failure === "provenance" ? "evidence-provenance-rejected" : "patch-persistence-failed",
      );
    },
  );

  it("does not infer a clean planner stop without a repository evidence collector", async () => {
    const { record } = await runPlannerStop("create-documentation", "missing-source", null);
    expect(record.status).toBe("failed");
    expect(record.failure?.code).toBe("patch-persistence-failed");
  });

  it.each(["needs-input", "failed", "cancelled"] as const)(
    "preserves filesystem changes from an executed writer that stops %s",
    async (terminal) => {
      const root = await mkdtemp(join(tmpdir(), "docsfab-partial-writer-control-"));
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      await writeFile(join(workspace, "README.md"), "# Existing guidance\n");
      const collector = await GitPatchEvidenceCollector.create(workspace, join(root, "patches"));
      const captures: boolean[] = [];
      const controller = new AbortController();
      try {
        const record = await new WorkflowRunner({
          harness: {
            async runStep(input) {
              expect(input.step.mode).toBe("write");
              await writeFile(
                join(input.repositoryPath, "README.md"),
                "# Retain this partial guidance\n",
              );
              if (terminal === "failed") throw new Error("partial-writer-failed");
              if (terminal === "cancelled") controller.abort();
              return { summary: "Writer needs operator input.", outcome: "needs-input" };
            },
          },
          store: new MemoryStore(),
          repositoryScanner: new PassingScanner(),
          contextPreflight: readyContextPreflight,
          repositoryEvidence: {
            async capture(context) {
              captures.push(context.persistPatch);
              return collector.capture(context);
            },
          },
          id: () => `partial-writer-${terminal}`,
        }).run({
          workflow: "bootstrap",
          workspacePath: workspace,
          repository: {
            sourcePath: workspace,
            requestedRevision: "HEAD",
            revision: "a".repeat(40),
          },
          allowWrite: true,
          signal: controller.signal,
        });
        expect(record.status, record.error).toBe(
          terminal === "needs-input" ? "needs-input" : "failed",
        );
        if (terminal === "failed") expect(record.error).toContain("partial-writer-failed");
        if (terminal === "cancelled") expect(record.error).toMatch(/cancelled/iu);
        expect(captures).toEqual([true]);
        expect(record.changes?.files).toEqual([{ path: "README.md", status: "modified" }]);
        expect(record.changes?.patch?.byteLength).toBeGreaterThan(0);
        expect(await readFile(record.changes!.patch!.artifactPath, "utf8")).toContain(
          "+# Retain this partial guidance",
        );
      } finally {
        await collector.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    journeyTestTimeoutMs(),
  );

  it("excludes inherited, failed, and cancelled partial writes from the clean probe", async () => {
    const { record } = await runPlannerStop("create-documentation", "missing-source");
    const base = {
      record,
      stepId: "plan-documentation",
      stepStatus: "needs-input",
      writeExecutionStarted: false,
      hasAnswerRecordContinuation: false,
      authoringCaptureCount: 0,
      hasRepositoryEvidenceCollector: true,
    };
    expect(canProbeCleanPlannerStop(base)).toBe(true);
    expect(canProbeCleanPlannerStop({ ...base, hasAnswerRecordContinuation: true })).toBe(false);
    // A cancelled current writer has already set this flag before the cancellation is observed.
    expect(canProbeCleanPlannerStop({ ...base, writeExecutionStarted: true })).toBe(false);
    expect(canProbeCleanPlannerStop({ ...base, authoringCaptureCount: 1 })).toBe(false);
    const inherited = structuredClone(record);
    const writer = inherited.steps.find((step) => step.mode === "write")!;
    writer.status = "succeeded";
    writer.inheritedFrom = {
      sourceRunId: "source-run",
      sourceRunRecordSha256: "a".repeat(64),
      sourceStepId: writer.id,
    };
    expect(canProbeCleanPlannerStop({ ...base, record: inherited })).toBe(false);
    const partial = structuredClone(record);
    const partialWriter = partial.steps.find((step) => step.mode === "write")!;
    partialWriter.status = "failed";
    partialWriter.startedAt = "2026-10-14T00:00:00.000Z";
    expect(canProbeCleanPlannerStop({ ...base, record: partial })).toBe(false);
  });

  it("still refuses a needs-input stop with no admitted planner diagnostic, naming the rule location", async () => {
    const { record } = await runPlannerStop("restructure-documentation", "ambiguous-scope");
    const stopped = structuredClone(record);
    delete stopped.workflowOutcome;
    const planner = stopped.steps.find((step) => step.id === "plan-documentation")!;
    delete planner.planDiagnostic;

    await expect(
      new AuthoringQualityWorkflowOutcomeProjector().project(stopped),
    ).rejects.toMatchObject({
      code: "invalid-record",
      location: "$.steps[].planDiagnostic",
    });
    await applyWorkflowOutcome({
      outcomeProjector: new AuthoringQualityWorkflowOutcomeProjector(),
      record: stopped,
    });
    expect(stopped.status).toBe("failed");
    expect(stopped.workflowOutcomeRejection).toEqual({
      code: "workflow-outcome-projection-invalid-record",
      location: "$.steps[].planDiagnostic",
    });
  });

  it("refuses a planner stop whose diagnostic code names no governed input", async () => {
    const { record } = await runPlannerStop("restructure-documentation", "ambiguous-scope");
    const stopped = structuredClone(record);
    delete stopped.workflowOutcome;
    // An admitted invalid-model-output code is not missing user input.
    stopped.steps.find((step) => step.id === "plan-documentation")!.planDiagnostic!.code =
      "invalid-json";

    await expect(
      new AuthoringQualityWorkflowOutcomeProjector().project(stopped),
    ).rejects.toMatchObject({ code: "invalid-record", location: "$.steps[].planDiagnostic" });
  });

  it("refuses a planner stop when another step also stopped needs-input", async () => {
    const { record } = await runPlannerStop("restructure-documentation", "ambiguous-scope");
    const stopped = structuredClone(record);
    delete stopped.workflowOutcome;
    const audit = stopped.steps.find((step) => step.id === "audit-documentation")!;
    expect(audit.status).toBe("succeeded");
    audit.status = "needs-input";

    await expect(
      new AuthoringQualityWorkflowOutcomeProjector().project(stopped),
    ).rejects.toMatchObject({ code: "invalid-record", location: "$.steps[].planDiagnostic" });
  });

  it("names the refused run status for a record the projector cannot seal", async () => {
    const { record } = await runPlannerStop("restructure-documentation", "ambiguous-scope");
    const failed = { ...structuredClone(record), status: "needs-human-decision" as const };
    delete failed.workflowOutcome;

    const refusal = await new AuthoringQualityWorkflowOutcomeProjector()
      .project(failed)
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(AuthoringQualityWorkflowOutcomeError);
    expect(refusal).toMatchObject({ code: "invalid-record", location: "$.status" });
  });
});
