// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  AgentHarness,
  HarnessStepInput,
  HostOperationExecutor,
} from "../src/execution/contracts.js";
import type { ChangeEvidence } from "../src/impact/contracts.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import type { RepositoryEvidenceCollector } from "../src/repository/contracts.js";
import type { RepositorySecurityScanner } from "../src/security/contracts.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { createAuthoringCandidate } from "../src/workflow-execution/authoring-candidate.js";
import type { AuthoringCandidateCaptureV1 } from "../src/workflow-execution/authoring-workspace-host.js";
import type {
  AuthoringCandidateLifecycleV1,
  AuthoringRevisionSessionV1,
} from "../src/workflow-execution/authoring-runtime.js";
import {
  documentationPlanBindingDigest,
  type DocumentationPlanMode,
} from "../src/workflow-execution/plan-binding.js";
import {
  decodeVerificationResponse,
  rejectTechnicalCorrection,
} from "../src/workflow-execution/review-response.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import {
  canContinueIndependentEvaluate,
  isTechnicalAdmissionStop,
  shouldContinueAfterTechnicalAdmissionStop,
} from "../src/workflow-execution/runner-schedule.js";
import { readyContextPreflight } from "./helpers.js";
import { sourceObligationObserverFixture, verificationFixture } from "./helpers/verification.js";

class MemoryStore implements RunStore {
  public records: RunRecord[] = [];
  public async save(record: RunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

class FakeScanner implements RepositorySecurityScanner {
  public async scan() {
    return {
      ruleSet: "test-v1",
      status: "passed" as const,
      scannedFiles: 2,
      binaryFiles: 0,
      findings: [],
    };
  }
}

class FakeEvidenceCollector implements RepositoryEvidenceCollector {
  public async capture(): Promise<ChangeEvidence> {
    return {
      files: [{ path: "README.md", status: "modified" }],
      patch: {
        sha256: "b".repeat(64),
        byteLength: 123,
        lineCount: 7,
        artifactPath: ".docsfab/patches/run-1.patch",
        format: "git-diff",
      },
    };
  }
}

class ScriptedHarness implements AgentHarness, HostOperationExecutor {
  public readonly calls: HarnessStepInput[] = [];

  public constructor(
    private readonly rejectStepId?: string,
    private readonly reject?: () => never,
  ) {}

  public async runStep(input: HarnessStepInput): ReturnType<AgentHarness["runStep"]> {
    this.calls.push(input);
    if (this.rejectStepId && input.step.id === this.rejectStepId) {
      this.reject?.();
      throw new Error(`Expected rejection for ${input.step.id}.`);
    }
    return {
      summary: `ran ${input.step.skill}`,
      ...(await verificationFixture(input)),
      ...(input.step.skill === "plan-documentation"
        ? {
            planBinding: documentationPlanBinding(
              input.workflow.name === "restructure-documentation" ? "restructure" : "create",
            ),
          }
        : {}),
      model: { provider: "hosted", model: "test-model" },
      skill: { id: input.step.skill, contentSha256: "a".repeat(64) },
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        total: 15,
        turns: 1,
        cost: 0,
      },
      tools: { totalCalls: 0, failedCalls: 0, byTool: [], failureCategories: [] },
    };
  }
}

class StubAuthoringLifecycle implements AuthoringCandidateLifecycleV1 {
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
    const evidence = await new FakeEvidenceCollector().capture();
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
    return {
      candidate,
      evidence,
      snapshot: {
        schemaVersion: 1,
        kind: "docsfab-authoring-workspace-snapshot",
        entries: [],
        totalBytes: 0,
        digest: candidate.workspaceSnapshotDigest,
      },
    } as unknown as AuthoringCandidateCaptureV1;
  }

  public async prepareRevision(): Promise<AuthoringRevisionSessionV1> {
    this.calls.push("prepare-1");
    throw new Error("Revision preparation must not run after a failed write or admission stop.");
  }

  public async sealCandidate1(): Promise<AuthoringCandidateCaptureV1> {
    this.calls.push("seal-1");
    throw new Error("Candidate one must not be sealed after a failed write or admission stop.");
  }

  public async observeRevisionChangedPaths(): Promise<readonly string[]> {
    this.calls.push("observe-1");
    throw new Error("The revision workspace must not be observed after a failed write stop.");
  }

  public async resetRevision(): Promise<void> {
    this.calls.push("reset-1");
    throw new Error("The revision workspace must not be reset after a failed write stop.");
  }

  public async captureFailedPartial() {
    this.calls.push("partial-1");
    return {
      selected: false as const,
      evidence: await new FakeEvidenceCollector().capture(),
      workspaceSnapshotDigest: "6".repeat(64),
    };
  }

  public async materializeSelected(input: { capture: AuthoringCandidateCaptureV1 }) {
    this.calls.push(`materialize-${input.capture.candidate.ordinal}`);
    return input.capture.evidence;
  }

  public async dispose(): Promise<void> {
    this.calls.push("dispose-1");
  }
}

const workflowSearchFixture = {
  async search(input: Parameters<LocalWorkflowSearchCoordinator["search"]>[0]) {
    const repositoryPath = await mkdtemp(join(tmpdir(), "docsfab-admission-search-"));
    try {
      await mkdir(join(repositoryPath, "src"), { recursive: true });
      await writeFile(join(repositoryPath, "README.md"), "deterministic search evidence\n");
      await writeFile(join(repositoryPath, "src/api.ts"), "export const api = true;\n");
      return await new LocalWorkflowSearchCoordinator().search({ ...input, repositoryPath });
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  },
};

function documentationPlanBinding(mode: DocumentationPlanMode, pagePath = "README.md") {
  const pages = [{ path: pagePath, disposition: mode }];
  const sourceBindings = [
    { pagePath, sources: [mode === "create" ? "src/api.ts:42" : "README.md"] },
  ];
  return {
    kind: "docsfab-documentation-plan" as const,
    schemaVersion: 1 as const,
    mode,
    pages,
    sourceBindings,
    digest: documentationPlanBindingDigest({ mode, pages, sourceBindings }),
  };
}

function repository() {
  return {
    sourcePath: "/tmp/repo",
    requestedRevision: "HEAD" as const,
    revision: "a".repeat(40),
  };
}

function invokedStepIds(harness: ScriptedHarness): string[] {
  return harness.calls.map((call) => call.step.id);
}

describe("independent evaluate continuation after technical admission stop", () => {
  it("treats closed technical envelope rejections as admission stops", () => {
    expect(
      isTechnicalAdmissionStop(new Error("Technical review response rejected: invalid-json.")),
    ).toBe(true);
    expect(
      isTechnicalAdmissionStop(
        new Error("Technical correction response rejected: invalid-accounting."),
      ),
    ).toBe(true);
    expect(isTechnicalAdmissionStop(new Error("write step failed"))).toBe(false);
    expect(
      shouldContinueAfterTechnicalAdmissionStop({
        aborted: false,
        step: { mode: "read-only", kind: "evaluate" },
        error: new Error("Technical review response rejected: invalid-json."),
      }),
    ).toBe(true);
    expect(
      shouldContinueAfterTechnicalAdmissionStop({
        aborted: false,
        step: { mode: "write", kind: "inference" },
        error: new Error("Technical review response rejected: invalid-json."),
      }),
    ).toBe(false);
  });

  it("continues only evaluate steps that do not consume a failed admitted predecessor", () => {
    const record = {
      steps: [
        { id: "verify-technical-accuracy", status: "failed" },
        { id: "review-documentation", status: "pending" },
        { id: "evaluate-document-quality", status: "pending" },
      ],
    } as RunRecord;
    expect(canContinueIndependentEvaluate({ mode: "read-only", kind: "evaluate" }, record)).toBe(
      true,
    );
    expect(
      canContinueIndependentEvaluate(
        {
          mode: "read-only",
          kind: "evaluate",
          consumes: ["verify-technical-accuracy"],
          consumesEvidence: ["verify-technical-accuracy"],
        },
        record,
      ),
    ).toBe(false);
  });

  it("invokes later review after a succeeded write and provisional invalid-json", async () => {
    const harness = new ScriptedHarness("provisional-technical-verification", () =>
      decodeVerificationResponse("{"),
    );
    const lifecycle = new StubAuthoringLifecycle();
    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new FakeScanner(),
      contextPreflight: readyContextPreflight,
      repositoryEvidence: new FakeEvidenceCollector(),
      workflowSearch: workflowSearchFixture,
      sourceObligationObserver: sourceObligationObserverFixture,
      authoringCandidateLifecycle: lifecycle,
      id: () => "run-create-provisional-invalid-json",
    }).run({
      workflow: "create-documentation",
      workspacePath: "/tmp/docsfab-workspace/repository",
      repository: repository(),
      allowWrite: true,
    });

    expect(record.status).toBe("failed");
    expect(record.error).toContain("invalid-json");
    expect(record.steps.find((step) => step.id === "write-documentation")).toMatchObject({
      status: "succeeded",
    });
    expect(
      record.steps.find((step) => step.id === "provisional-technical-verification"),
    ).toMatchObject({
      status: "failed",
    });
    expect(invokedStepIds(harness)).toContain("review-documentation");
    expect(invokedStepIds(harness)).not.toContain("verify-technical-accuracy");
    expect(invokedStepIds(harness)).not.toContain("revise-documentation");
    expect(record.steps.find((step) => step.id === "verify-technical-accuracy")).toMatchObject({
      status: "pending",
      contextPreflight: { status: "unnecessary", reason: "workflow-stopped-before-step" },
    });
    expect(record.changes?.patch).toBeDefined();
    expect(lifecycle.calls).not.toContain("prepare-1");
  });

  it("invokes later independent evaluate after verify invalid-accounting", async () => {
    const harness = new ScriptedHarness("verify-technical-accuracy", () =>
      rejectTechnicalCorrection("invalid-accounting"),
    );
    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new FakeScanner(),
      contextPreflight: readyContextPreflight,
      repositoryEvidence: new FakeEvidenceCollector(),
      workflowSearch: workflowSearchFixture,
      sourceObligationObserver: sourceObligationObserverFixture,
      id: () => "run-review-invalid-accounting",
    }).run({
      workflow: "review-documentation",
      workspacePath: "/tmp/docsfab-workspace/repository",
      repository: repository(),
      allowWrite: false,
    });

    expect(record.status).toBe("failed");
    expect(record.error).toContain("invalid-accounting");
    expect(record.steps.find((step) => step.id === "verify-technical-accuracy")).toMatchObject({
      status: "failed",
    });
    expect(invokedStepIds(harness)).toContain("review-documentation");
    expect(invokedStepIds(harness)).toContain("test-audience-understanding");
    expect(invokedStepIds(harness)).not.toContain("evaluate-document-quality");
    expect(record.steps.find((step) => step.id === "evaluate-document-quality")).toMatchObject({
      status: "pending",
      contextPreflight: { status: "unnecessary", reason: "workflow-stopped-before-step" },
    });
  });

  it.each([false, true])(
    "preserves restructure verification failure when empty patch is %s",
    async (emptyPatch) => {
      const harness = new ScriptedHarness("verify-technical-accuracy", () =>
        rejectTechnicalCorrection("invalid-fact-inventory"),
      );
      const record = await new WorkflowRunner({
        harness,
        hostOperations: harness,
        store: new MemoryStore(),
        repositoryScanner: new FakeScanner(),
        contextPreflight: readyContextPreflight,
        repositoryEvidence: {
          capture: async () => {
            const evidence = await new FakeEvidenceCollector().capture();
            return emptyPatch ? { ...evidence, files: [] } : evidence;
          },
        },
        workflowSearch: workflowSearchFixture,
        sourceObligationObserver: {
          ...sourceObligationObserverFixture,
          async capturePreservationBase(paths) {
            return {
              repositoryRevision: repository().revision,
              sources: paths.map((path) => ({
                path,
                sha256: "f".repeat(64),
                content: "original source\n",
              })),
            };
          },
        },
        id: () => "run-restructure-invalid-inventory",
      }).run({
        workflow: "restructure-documentation",
        workspacePath: "/tmp/docsfab-workspace/repository",
        repository: repository(),
        allowWrite: true,
      });

      expect(record.status).toBe("failed");
      expect(record.error).toContain("invalid-fact-inventory");
      expect(record.error).toBe(
        record.steps.find((step) => step.id === "verify-technical-accuracy")?.error,
      );
      expect(invokedStepIds(harness)).toContain("review-documentation");
      expect(invokedStepIds(harness)).not.toContain("evaluate-document-quality");
      expect(record.changes?.patch).toBeDefined();
      const base = harness.calls.find(
        (call) => call.step.id === "derive-source-obligations",
      )?.preservationBaseEvidence;
      expect(base?.sources.length).toBeGreaterThan(0);
      expect(
        harness.calls.find((call) => call.step.id === "write-documentation")
          ?.preservationBaseEvidence,
      ).toBe(base);
      expect(
        harness.calls.find((call) => call.step.id === "verify-technical-accuracy")
          ?.preservationBaseEvidence,
      ).toBe(base);
    },
  );

  it("does not continue later publication or evaluate work after a failed write", async () => {
    const harness = new ScriptedHarness("write-documentation", () => {
      throw new Error("write step failed");
    });
    const lifecycle = new StubAuthoringLifecycle();
    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new FakeScanner(),
      contextPreflight: readyContextPreflight,
      repositoryEvidence: new FakeEvidenceCollector(),
      workflowSearch: workflowSearchFixture,
      sourceObligationObserver: sourceObligationObserverFixture,
      authoringCandidateLifecycle: lifecycle,
      id: () => "run-create-failed-write",
    }).run({
      workflow: "create-documentation",
      workspacePath: "/tmp/docsfab-workspace/repository",
      repository: repository(),
      allowWrite: true,
    });

    expect(record.status).toBe("failed");
    expect(record.error).toBe("write step failed");
    expect(record.steps.find((step) => step.id === "write-documentation")).toMatchObject({
      status: "failed",
    });
    expect(invokedStepIds(harness)).not.toContain("review-documentation");
    expect(invokedStepIds(harness)).not.toContain("revise-documentation");
    expect(lifecycle.calls).not.toContain("prepare-1");
    expect(record.steps.find((step) => step.id === "review-documentation")).toMatchObject({
      status: "pending",
      contextPreflight: { status: "unnecessary", reason: "workflow-stopped-before-step" },
    });
  });
});
