// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import { QualityArtifactValidationError } from "../src/evaluation-report/quality-validator-host.js";
import { AuthoringQualityWorkflowOutcomeProjector } from "../src/evaluation-report/authoring-outcome-projector.js";
import {
  declinedQualityReportNote,
  QUALITY_REPORT_DECLINE_STEM,
} from "../src/workflow-execution/quality-correction-round.js";
import type {
  AgentHarness,
  HarnessStepInput,
  HostOperationExecutor,
} from "../src/execution/contracts.js";
import { InferenceStepError } from "../src/execution/contracts.js";
import { parseRetryPolicy } from "../src/config/retry-policy.js";
import { decodeWorkflowOutcome, WorkflowOutcomeError } from "../src/workflow-contracts/outcome.js";
import type { ChangeEvidence } from "../src/impact/contracts.js";
import { decodeSavedRunRecord } from "../src/cli/commands/runs.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import { FileRunStoreError } from "../src/records/file-store.js";
import {
  decodeRetainedAuthoringWorkflowV1,
  validateAuthoringRunRecordV1,
} from "../src/records/authoring-execution.js";
import type { RepositoryEvidenceCollector } from "../src/repository/contracts.js";
import { buildRunHumanNextCommand } from "../src/operator/run-summary.js";
import { buildDocsFabStepPrompt } from "../src/harness/pi-session.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { documentationAuditSearch } from "../src/maturity/audit-search-plan.js";
import { documentationObservationSearch } from "../src/search/observation-search-plan.js";
import type { RepositorySecurityScanner } from "../src/security/contracts.js";
import { parseWorkflowManifestSnapshot } from "../src/workflow-registry/manifest.js";
import * as workflowCatalog from "../src/workflow-registry/catalog.js";
import {
  authoringSourceSupportStepError,
  createAuthoringCandidate,
} from "../src/workflow-execution/authoring-candidate.js";
import type { AuthoringCandidateCaptureV1 } from "../src/workflow-execution/authoring-workspace-host.js";
import {
  authoringRevisionChangedPaths,
  type AuthoringCandidateLifecycleV1,
  type AuthoringRevisionSessionV1,
} from "../src/workflow-execution/authoring-runtime.js";
import { decodeAuthoringRevisionAccounting } from "../src/workflow-execution/authoring-revision.js";
import {
  admitPlannerReply,
  confirmProposedUpdatePlan,
} from "../src/harness/reply-admission/planner.js";
import { createConversionPatchNote } from "../src/workflow-contracts/create-conversion.js";
import { projectRunIndexRows } from "../src/records/run-index.js";
import { diagnoseRunRecord } from "../src/diagnosis/record.js";
import { admitJudgmentReply } from "../src/harness/reply-admission/judgment.js";
import {
  convertCreatePlanPageToUpdate,
  documentationPlanWritePaths,
  sealDocumentationPlanBinding,
  type PlannedTargetCollisionV1,
} from "../src/workflow-execution/plan-binding.js";
import type {
  TechnicalFactDimension,
  VerificationResult,
} from "../src/workflow-execution/review-response.js";
import { WorkflowRunner, WorkflowRunnerBoundaryError } from "../src/workflow-execution/runner.js";
import {
  TECHNICAL_CORRECTION_PROPOSAL_KIND,
  bindTechnicalCorrectionResponse,
  bindHostOwnedTechnicalCorrectionProposalV3,
  requiresSourceObligationLedger,
  requiresTechnicalCorrection,
} from "../src/workflow-execution/source-obligation.js";
import type { WorkflowDefinition } from "../src/workflow-contracts/contracts.js";
import { readyContextPreflight } from "./helpers.js";
import { authoringManifestV3, legacyAuthoringManifestV3 } from "./helpers/authoring-manifest.js";
import {
  sourceObligationObserverFixture,
  sourceObligationProposalFixture,
  verificationResultFixture,
} from "./helpers/verification.js";

const REVISION = "a".repeat(40);
const TARGET = "docs/guide.md";
const PLAN_RESPONSE_SHA256 = "c".repeat(64);
const BASE_SHA256 = "d".repeat(64);
const UNCHANGED_TARGET = "docs/reference.md";
const SOURCE = "src/api.ts";
/** Repository content quoting a path, which every step admits as written. */
const SHEBANG_STATEMENT = "src/api.ts starts with `#!/usr/bin/env node`, so it runs under Node.js.";
const workflow = parseWorkflowManifestSnapshot(authoringManifestV3(), "create-documentation", {
  "documentation-audit": documentationAuditSearch,
  "documentation-observation": documentationObservationSearch,
});
const legacyWorkflow = parseWorkflowManifestSnapshot(
  legacyAuthoringManifestV3(),
  "create-documentation",
  {
    "documentation-audit": documentationAuditSearch,
    "documentation-observation": documentationObservationSearch,
  },
);

class MemoryStore implements RunStore {
  readonly records: RunRecord[] = [];
  async save(record: RunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

class FailingTerminalStore extends MemoryStore {
  override async save(record: RunRecord): Promise<void> {
    if (record.status === "failed" && record.authoringExecution?.partialCandidate1) {
      throw new FileRunStoreError("write-failed");
    }
    await super.save(record);
  }
}

class FailingPreSealStore extends MemoryStore {
  private failed = false;

  override async save(record: RunRecord): Promise<void> {
    const writer = record.steps.find((step) => step.id === "write-documentation");
    if (
      !this.failed &&
      writer?.status === "succeeded" &&
      !record.authoringExecution?.selectedCandidate
    ) {
      this.failed = true;
      throw new FileRunStoreError("write-failed");
    }
    await super.save(record);
  }
}

/** Fails the first save of a record that holds a failed step, so the run settles as thrown. */
class FailOnceOnFailedStepStore extends MemoryStore {
  private failed = false;

  override async save(record: RunRecord): Promise<void> {
    if (!this.failed && record.steps.some((step) => step.status === "failed")) {
      this.failed = true;
      throw new FileRunStoreError("write-failed");
    }
    await super.save(record);
  }
}

class StaticScanner implements RepositorySecurityScanner {
  async scan() {
    return {
      ruleSet: "test-v1",
      status: "passed" as const,
      scannedFiles: 2,
      binaryFiles: 0,
      findings: [],
    };
  }
}

class EvidenceCollector implements RepositoryEvidenceCollector {
  constructor(private readonly patchDigit = "1") {}
  async capture(): Promise<ChangeEvidence> {
    return evidence(this.patchDigit);
  }
}

class ScriptedLifecycle implements AuthoringCandidateLifecycleV1 {
  readonly calls: string[] = [];
  /** What plan admission observes; empty means every CREATE target is new. */
  collisions: PlannedTargetCollisionV1[] = [];
  readonly collisionQueries: (readonly string[])[] = [];

  async plannedTargetCollisions(input: {
    writePaths: readonly string[];
  }): Promise<readonly PlannedTargetCollisionV1[]> {
    this.collisionQueries.push(input.writePaths);
    return this.collisions;
  }
  candidate0 = capture(0, "1", "2");
  candidate1 = capture(1, "3", "4");
  /** What the runner handed `prepareRevision`, in order. */
  readonly prepareInputs: unknown[] = [];
  readonly childEvidence = new EvidenceCollector("3");
  readonly childHost: HostOperationExecutor;

  constructor(
    host: HostOperationExecutor,
    private readonly rejectPreparation = false,
  ) {
    this.childHost = host;
  }

  async sealCandidate0(input?: {
    planDigest: string;
    writePaths?: readonly string[];
  }): Promise<AuthoringCandidateCaptureV1> {
    this.calls.push("seal-0");
    // A converted plan has its own digest, and a proposed UPDATE its own
    // pages; the scripted captures follow both.
    if (input && input.planDigest !== this.candidate0.candidate.planDigest) {
      const writePaths = input.writePaths ?? [TARGET, UNCHANGED_TARGET];
      this.candidate0 = capture(0, "1", "2", input.planDigest, writePaths);
      this.candidate1 = capture(1, "3", "4", input.planDigest, writePaths);
    }
    return this.candidate0;
  }

  async prepareRevision(input?: unknown): Promise<AuthoringRevisionSessionV1> {
    this.calls.push("prepare-1");
    this.prepareInputs.push(input);
    if (this.rejectPreparation) {
      throw new Error("The authenticated revision workspace could not be prepared.");
    }
    const repositoryWorkspace = {
      path: "/tmp/docsfab-authoring-child",
      sourcePath: "/tmp/source",
      requestedRevision: REVISION,
      revision: REVISION,
      dispose: async () => undefined,
    };
    return {
      candidate0: this.candidate0,
      workspacePath: repositoryWorkspace.path,
      repositoryWorkspace,
      search: workflowSearch,
      sourceObserver: sourceObligationObserverFixture,
      hostOperations: this.childHost,
      repositoryEvidence: this.childEvidence as never,
      hostSession: {
        candidate0: this.candidate0,
        workspace: repositoryWorkspace,
        evidenceCollector: this.childEvidence,
        sourceObserver: sourceObligationObserverFixture,
        searchCoordinator: workflowSearch,
        hostOperations: this.childHost,
        dispose: async () => undefined,
      } as never,
    };
  }

  async sealCandidate1(): Promise<AuthoringCandidateCaptureV1> {
    this.calls.push("seal-1");
    return this.candidate1;
  }

  /** Scripted in-attempt observations; empty means the sealed candidate-1 change. */
  readonly observedChangedPaths: (readonly string[])[] = [];

  async observeRevisionChangedPaths(): Promise<readonly string[]> {
    this.calls.push("observe-1");
    return (
      this.observedChangedPaths.shift() ??
      authoringRevisionChangedPaths(this.candidate0.snapshot, this.candidate1.snapshot)
    );
  }

  async resetRevision(): Promise<void> {
    this.calls.push("reset-1");
  }

  async captureFailedPartial() {
    this.calls.push("partial-1");
    return {
      selected: false as const,
      evidence: evidence("5"),
      workspaceSnapshotDigest: "6".repeat(64),
    };
  }

  async materializeSelected(input: { capture: AuthoringCandidateCaptureV1 }) {
    this.calls.push(`materialize-${input.capture.candidate.ordinal}`);
    return input.capture.evidence;
  }

  async dispose(): Promise<void> {
    this.calls.push("dispose-1");
  }
}

const workflowSearch = {
  async search(input: Parameters<LocalWorkflowSearchCoordinator["search"]>[0]) {
    const root = await mkdtemp(join(tmpdir(), "docsfab-authoring-runner-search-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await mkdir(join(root, "docs"), { recursive: true });
      await writeFile(join(root, SOURCE), "export const api = true;\n", "utf8");
      await writeFile(join(root, TARGET), "# Guide\n", "utf8");
      await writeFile(join(root, UNCHANGED_TARGET), "# Reference\n", "utf8");
      return await new LocalWorkflowSearchCoordinator().search({ ...input, repositoryPath: root });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
};

const plan = sealDocumentationPlanBinding(
  {
    mode: "create",
    pages: [
      { path: TARGET, disposition: "create" },
      { path: UNCHANGED_TARGET, disposition: "create" },
    ],
    sourceBindings: [
      { pagePath: TARGET, sources: [`${SOURCE}:1`] },
      { pagePath: UNCHANGED_TARGET, sources: [`${SOURCE}:1`] },
    ],
  },
  { expectedMode: "create" },
);

afterEach(() => vi.restoreAllMocks());

describe("CREATE Manifest V3 runner", () => {
  it.each([
    [undefined, "succeeded"],
    ["review-documentation", "failed"],
  ] as const)(
    "cold-replays a legacy %s record from its exact retained manifest",
    async (failStep, status) => {
      vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(legacyWorkflow);
      const harness = new AuthoringHarness(false, failStep);
      const lifecycle = new ScriptedLifecycle(harness);
      const record = await new WorkflowRunner({
        harness,
        hostOperations: harness,
        store: new MemoryStore(),
        repositoryScanner: new StaticScanner(),
        contextPreflight: readyContextPreflight,
        workflowSearch,
        sourceObligationObserver: sourceObligationObserverFixture,
        repositoryEvidence: new EvidenceCollector(),
        authoringCandidateLifecycle: lifecycle,
        id: () => "run-authoring",
      }).run(request());
      const cold = decodeSavedRunRecord(
        JSON.parse(JSON.stringify(record)) as JsonEvidenceValue,
        record.id,
      );
      const retainedWorkflow = decodeRetainedAuthoringWorkflowV1(cold.authoringExecution);

      expect(cold.status).toBe(status);
      expect(retainedWorkflow.authoringSchedule?.manifest).toEqual(
        legacyWorkflow.authoringSchedule?.manifest,
      );
      expect(() => validateAuthoringRunRecordV1(cold, retainedWorkflow)).not.toThrow();
    },
  );

  it("withholds CREATE evaluator text until host quality validation succeeds", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const credential = `glpat-${"x".repeat(24)}`;
    const rawSummary = `unsafe candidate ${credential}`;
    const safeFailureReport = "# Quality Validation Failure\n\nThe candidate was rejected safely.";
    const harness = new AuthoringHarness(
      false,
      undefined,
      undefined,
      false,
      "verified",
      false,
      false,
      { summary: rawSummary, candidate: { reportMarkdown: rawSummary } },
    );
    const lifecycle = new ScriptedLifecycle(harness);
    const streamed: string[] = [];
    const validate = vi.fn(async () => {
      throw new QualityArtifactValidationError(
        "candidate-invalid",
        { status: "failed", failureCode: "candidate-invalid" } as never,
        safeFailureReport,
      );
    });
    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      qualityValidation: {
        selection: { receipt: {}, discoveryLimitations: [] } as never,
        host: { validate } as never,
      },
      id: () => "run-authoring",
      onProgress: (event) => {
        if (event.type === "text") streamed.push(event.text);
      },
    }).run(request());

    expect(validate).toHaveBeenCalledOnce();
    expect(record.status).toBe("failed");
    expect(record.error).toBe("Quality artifact validation failed: candidate-invalid.");
    expect(record.steps.find((step) => step.id === "evaluate-document-quality")?.summary).toBe(
      safeFailureReport,
    );
    expect(JSON.stringify(record)).not.toContain(credential);
    expect(streamed.join("\n")).not.toContain(credential);
    expect(streamed).toContain(safeFailureReport);
  });

  it("declines the quality artifact instead of failing the run once a model-correctable refusal spends its retry budget", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const credential = `glpat-${"x".repeat(24)}`;
    const rawSummary = `unsafe candidate ${credential}`;
    const harness = new AuthoringHarness(
      false,
      undefined,
      undefined,
      false,
      "verified",
      false,
      false,
      { summary: rawSummary, candidate: { reportMarkdown: rawSummary } },
    );
    const lifecycle = new ScriptedLifecycle(harness);
    const safeReportMarkdown = "# Quality Validation Failure\n\nThe candidate was rejected safely.";
    const validate = vi.fn(async () => {
      throw new QualityArtifactValidationError(
        "candidate-invalid",
        { status: "failed", failureCode: "candidate-invalid" } as never,
        safeReportMarkdown,
        {
          validator: "evaluation",
          code: "evaluation-schema-enum",
          location: "$.evaluation",
          issueCount: 1,
        },
      );
    });
    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      qualityValidation: {
        selection: { receipt: {}, discoveryLimitations: [] } as never,
        host: { validate } as never,
      },
      id: () => "run-authoring",
    }).run(request());

    // `noRetryPolicy` is the runner's default, so the one attempt already
    // spends the whole (zero-sized) correction-round budget -- the step
    // declines on the first refusal rather than retrying.
    expect(validate).toHaveBeenCalledOnce();
    expect(record.status).toBe("succeeded");
    expect(record.error).toBeUndefined();
    const qualityStep = record.steps.find((step) => step.id === "evaluate-document-quality");
    expect(qualityStep?.status).toBe("succeeded");
    expect(qualityStep?.summary).toBe(
      `${safeReportMarkdown}\n\n---\n\n${declinedQualityReportNote(1, "evaluation-schema-enum")}`,
    );
    expect(qualityStep?.summary).toContain(QUALITY_REPORT_DECLINE_STEM);
    expect(qualityStep?.summary).toContain("evaluation-schema-enum");
    expect(qualityStep?.summary).toContain("1 attempt");
    // This fixture's mocked validator host builds its own safe reportMarkdown
    // rather than echoing the (here, credential-bearing) candidate verbatim,
    // so neither the raw candidate text nor the credential it carries ever
    // reaches the record -- only `error.reportMarkdown` carries through,
    // whatever the validator host decided it was safe to keep.
    expect(JSON.stringify(record)).not.toContain(credential);
    expect(JSON.stringify(record)).not.toContain(rawSummary);
  });

  it("keeps every quality correction attempt when provider throttles end three attempts first", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new ThrottledQualityHarness(3);
    const lifecycle = new ScriptedLifecycle(harness);
    const safeReportMarkdown = "# Quality Validation Failure\n\nThe candidate was rejected safely.";
    const validate = vi.fn(async () => {
      throw new QualityArtifactValidationError(
        "candidate-invalid",
        { status: "failed", failureCode: "candidate-invalid" } as never,
        safeReportMarkdown,
        {
          validator: "evaluation",
          code: "evaluation-schema-enum",
          location: "$.evaluation",
          issueCount: 1,
        },
      );
    });
    const retryPolicy = parseRetryPolicy({});
    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      qualityValidation: {
        selection: { receipt: {}, discoveryLimitations: [] } as never,
        host: { validate } as never,
      },
      retryPolicy,
      retrySleep: async () => undefined,
      id: () => "run-authoring",
    }).run(request());

    // Every contract attempt reached the validator; the throttled attempts
    // never produced a reply to validate and spent none of them.
    expect(validate).toHaveBeenCalledTimes(retryPolicy.maxRetries + 1);
    expect(record.status).toBe("succeeded");
    const qualityStep = record.steps.find((step) => step.id === "evaluate-document-quality");
    expect(qualityStep?.inference?.attempts.map((attempt) => attempt.outcome)).toEqual([
      "throttled",
      "throttled",
      "throttled",
      "malformed-response",
      "malformed-response",
      "malformed-response",
      "succeeded",
    ]);
    expect(qualityStep?.inference?.transportRetry?.maxRetries).toBe(
      retryPolicy.transport?.maxRetries,
    );
    // The decline names the correction attempts spent, not the step attempts.
    expect(qualityStep?.summary).toBe(
      `${safeReportMarkdown}\n\n---\n\n${declinedQualityReportNote(retryPolicy.maxRetries + 1, "evaluation-schema-enum")}`,
    );
    const evaluatorCalls = harness.calls.filter(
      (call) => call.step.id === "evaluate-document-quality",
    );
    // The run-record validator re-reads the transport block at outcome decode
    // and refuses a malformed one, including a contract category.
    expect(record.workflowOutcome).toBeDefined();
    expect(() => decodeWorkflowOutcome(record.workflowOutcome, record)).not.toThrow();
    // Each forgery leaves every attempt's budget position unchanged, so only
    // the block check itself can refuse it.
    for (const forge of [
      (block: Record<string, unknown>) => {
        block.categories = ["throttled", "provider-transient", "timeout"];
      },
      (block: Record<string, unknown>) => {
        block.categories = ["throttled", "throttled", "provider-transient"];
      },
      (block: Record<string, unknown>) => {
        block.unexpected = 1;
      },
    ]) {
      const forged = structuredClone(record);
      const forgedStep = forged.steps.find((step) => step.id === "evaluate-document-quality")!;
      forge(forgedStep.inference!.transportRetry as unknown as Record<string, unknown>);
      const categories = forgedStep.inference!.transportRetry!.categories;
      expect(
        () => decodeWorkflowOutcome(forged.workflowOutcome, forged),
        String(categories),
      ).toThrow(WorkflowOutcomeError);
    }
    // Raw attempt 4 is the first contract attempt, so it is not final.
    expect(evaluatorCalls.map((call) => call.finalInferenceAttempt)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it("still fails the run on a plain step error with quality validation configured (adjacent to the decline above)", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(false, "evaluate-document-quality");
    const lifecycle = new ScriptedLifecycle(harness);
    const validate = vi.fn();
    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      qualityValidation: {
        selection: { receipt: {}, discoveryLimitations: [] } as never,
        host: { validate } as never,
      },
      id: () => "run-authoring",
    }).run(request());

    // The failure never reaches quality validation at all, so the decline
    // path (which only fires on a tagged, model-correctable refusal) must
    // not absorb it: the run still fails exactly as it did before this
    // step carried a quality validator.
    expect(validate).not.toHaveBeenCalled();
    expect(record.status).toBe("failed");
    expect(record.steps.find((step) => step.id === "evaluate-document-quality")?.status).toBe(
      "failed",
    );
  });

  it("refuses a CREATE plan onto a path no UPDATE can start from at plan admission, before any write step", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    // A non-actionable run selects the retain branch, which never reconstructs
    // candidate 0, so before this refusal the overwrite was delivered silently.
    const harness = new AuthoringHarness(false);
    const lifecycle = new ScriptedLifecycle(harness);
    lifecycle.collisions = [{ path: TARGET, existing: "directory" }];
    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      id: () => "run-authoring",
    }).run(request());

    // Admission read the plan's own write targets, and nothing after the
    // planner ran: no model turn was spent writing a page that cannot ship.
    expect(lifecycle.collisionQueries).toEqual([[TARGET, UNCHANGED_TARGET]]);
    expect(harness.calls.map((input) => input.step.id)).toEqual(["plan-documentation"]);
    expect(lifecycle.calls).not.toContain("seal-0");
    expect(record.status).toBe("failed");
    const planner = record.steps.find((step) => step.id === "plan-documentation");
    expect(planner?.status).toBe("failed");
    expect(planner?.failure).toEqual({
      class: "planning-refusal",
      layer: "workflow",
      code: "create-target-exists",
    });
    expect(record.failure).toEqual(planner?.failure);
    expect(planner?.error).toContain(`(${TARGET} is a directory)`);
    expect(planner?.error).toContain("Remediation: name a new path for the new page.");
    expect(record.steps.find((step) => step.id === "write-documentation")?.status).toBe("pending");
  });

  it.each([
    [false, "retain"],
    [true, "revise"],
  ] as const)(
    "converts a CREATE plan onto the one page the revision holds into an UPDATE on the %s branch",
    async (actionable, branch) => {
      vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
      const harness = new AuthoringHarness(actionable);
      const lifecycle = new ScriptedLifecycle(harness);
      lifecycle.collisions = [{ path: TARGET, existing: "file", base: { sha256: BASE_SHA256 } }];
      const record = await new WorkflowRunner({
        harness,
        hostOperations: harness,
        store: new MemoryStore(),
        repositoryScanner: new StaticScanner(),
        contextPreflight: readyContextPreflight,
        workflowSearch,
        sourceObligationObserver: sourceObligationObserverFixture,
        repositoryEvidence: new EvidenceCollector(),
        authoringCandidateLifecycle: lifecycle,
        id: () => "run-authoring",
      }).run(request());

      expect(record.status).toBe("succeeded");
      expect(record.authoringExecution).toMatchObject({ selection: { branchId: branch } });
      expect(() =>
        validateAuthoringRunRecordV1(record, workflow, { requireTerminalSuccess: true }),
      ).not.toThrow();
      const conversion = { reason: "create-target-exists", path: TARGET, baseSha256: BASE_SHA256 };
      const planner = record.steps.find((step) => step.id === "plan-documentation")!;
      expect(planner.planBinding?.createConvertedToUpdate).toEqual(conversion);
      expect(planner.planBinding?.pages).toEqual([
        { path: TARGET, disposition: "update" },
        { path: UNCHANGED_TARGET, disposition: "create" },
      ]);
      // Write authority is the same pages.
      expect(lifecycle.candidate0.candidate.writePaths).toEqual([TARGET, UNCHANGED_TARGET]);
      expect(lifecycle.candidate0.candidate.planDigest).toBe(planner.planBinding?.digest);
      // Every plan consumer, the revision writer included, reads the converted
      // plan and the host's UPDATE contract for the page.
      const consumers = harness.calls.filter((input) => input.planBinding !== undefined);
      expect(consumers.map((input) => input.step.id)).toEqual(
        expect.arrayContaining([
          "write-documentation",
          "verify-technical-accuracy",
          "review-documentation",
          ...(actionable ? ["revise-documentation"] : []),
        ]),
      );
      for (const input of consumers) {
        expect(input.planBinding).toEqual(planner.planBinding);
        const prompt = buildDocsFabStepPrompt(input);
        expect(prompt).toContain(
          `Host CREATE-to-UPDATE conversion (authoritative): "${TARGET}" already existed`,
        );
        expect(prompt).toContain(
          "A correction removes base content only when a bound source contradicts it",
        );
      }
      // The revise branch rebuilds candidate 0 over exactly the converted base.
      expect(lifecycle.prepareInputs).toEqual(
        actionable ? [expect.objectContaining({ createConvertedToUpdate: conversion })] : [],
      );
      const plannerPrompt = buildDocsFabStepPrompt(
        harness.calls.find((input) => input.step.id === "plan-documentation")!,
      );
      expect(plannerPrompt).toContain("A CREATE request for a new page uses a new path.");
      expect(plannerPrompt).not.toContain("Host CREATE-to-UPDATE conversion");
    },
  );

  /**
   * The planner step the way the real harness admits a reply that proposes
   * the plan as an UPDATE: through the shipped reply admission and its
   * existence confirmation, reading the runner's oracle.
   */
  function proposingUpdatePlanner(harness: AuthoringHarness, pages = [TARGET]) {
    const runStep = harness.runStep.bind(harness);
    harness.runStep = async (input) => {
      if (input.step.id !== "plan-documentation") return runStep(input);
      harness.calls.push(input);
      const reply = JSON.stringify({
        summary: "Update the existing guide.",
        planBinding: {
          mode: "update",
          pages: pages.map((path) => ({ path, disposition: "update" })),
          sourceBindings: pages.map((path) => ({ pagePath: path, sources: [`${SOURCE}:1`] })),
        },
      });
      const context = {
        decodedResponse: reply,
        collectAttemptEvidence: () => ({}),
        refuseContractPlaceholder: () => undefined,
      };
      const admitted = admitPlannerReply(input, reply, context);
      if (admitted?.outcome !== "completed") throw new Error("fixture: the plan was not admitted");
      const planProposedMode = await confirmProposedUpdatePlan(input, admitted, context);
      return {
        summary: admitted.summary,
        planBinding: admitted.planBinding,
        planResponseSha256: admitted.planResponseSha256,
        ...(planProposedMode ? { planProposedMode } : {}),
      };
    };
  }

  it.each([
    [false, "retain"],
    [true, "revise"],
  ] as const)(
    "admits a planner-proposed UPDATE of the one page the revision holds as the same conversion on the %s branch",
    async (actionable, branch) => {
      vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
      const harness = new AuthoringHarness(actionable);
      proposingUpdatePlanner(harness);
      const lifecycle = new ScriptedLifecycle(harness);
      lifecycle.collisions = [{ path: TARGET, existing: "file", base: { sha256: BASE_SHA256 } }];
      const record = await new WorkflowRunner({
        harness,
        hostOperations: harness,
        store: new MemoryStore(),
        repositoryScanner: new StaticScanner(),
        contextPreflight: readyContextPreflight,
        workflowSearch,
        sourceObligationObserver: sourceObligationObserverFixture,
        repositoryEvidence: new EvidenceCollector(),
        authoringCandidateLifecycle: lifecycle,
        id: () => "run-authoring",
      }).run(request());

      expect(record.status).toBe("succeeded");
      expect(record.authoringExecution).toMatchObject({ selection: { branchId: branch } });
      const conversion = {
        reason: "planner-proposed-update",
        path: TARGET,
        baseSha256: BASE_SHA256,
      };
      const planner = record.steps.find((step) => step.id === "plan-documentation")!;
      expect(planner.planBinding?.mode).toBe("create");
      expect(planner.planBinding?.createConvertedToUpdate).toEqual(conversion);
      expect(planner.planBinding?.pages).toEqual([{ path: TARGET, disposition: "update" }]);
      // Reply admission asked the oracle once; plan admission asked once more.
      expect(lifecycle.collisionQueries).toEqual([[TARGET], [TARGET]]);
      // Write authority is the one page, as for a converted CREATE.
      expect(lifecycle.candidate0.candidate.writePaths).toEqual([TARGET]);
      expect(lifecycle.prepareInputs).toEqual(
        actionable ? [expect.objectContaining({ createConvertedToUpdate: conversion })] : [],
      );
      // Every operator surface reads the planner's reason.
      const projection = projectRunIndexRows(record, {
        origin: "run-store",
        snapshotId: "proposed-update",
        indexedAt: "2026-10-01T00:00:00.000Z",
        recordSha256: "e".repeat(64),
        fieldMaxChars: 512,
      });
      if (!projection.ok) throw new Error("fixture record refused by the index projection");
      expect(projection.rows[0]).toMatchObject({
        rowKind: "run",
        planConversion: "planner-proposed-update",
      });
      expect(createConversionPatchNote(conversion)).toBe(
        `(CREATE converted to UPDATE as the planner proposed: ${TARGET} existed at the run's revision)`,
      );
    },
  );

  it("refuses a planner-proposed UPDATE through the same admission when no UPDATE can start from the page", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(false);
    proposingUpdatePlanner(harness);
    const lifecycle = new ScriptedLifecycle(harness);
    // The hosted shape: the page exists, but the write grant does not cover it.
    lifecycle.collisions = [{ path: TARGET, existing: "file", updateRefused: "write-grant" }];
    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      id: () => "run-authoring",
    }).run(request());
    expect(record.status).toBe("failed");
    const planner = record.steps.find((step) => step.id === "plan-documentation")!;
    expect(planner.failure).toEqual({
      class: "planning-refusal",
      layer: "workflow",
      code: "create-target-exists",
    });
    expect(planner.error).toContain("the run's write grant does not cover modifying it");
    expect(harness.calls.map((input) => input.step.id)).toEqual(["plan-documentation"]);
  });

  it("asks which page a planner-proposed UPDATE means when several of its pages exist", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(false);
    proposingUpdatePlanner(harness, [TARGET, UNCHANGED_TARGET]);
    const lifecycle = new ScriptedLifecycle(harness);
    lifecycle.collisions = [
      { path: TARGET, existing: "file", base: { sha256: BASE_SHA256 } },
      { path: UNCHANGED_TARGET, existing: "file", base: { sha256: BASE_SHA256 } },
    ];
    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      id: () => "run-authoring",
    }).run(request());
    expect(record.status).toBe("needs-input");
    const planner = record.steps.find((step) => step.id === "plan-documentation")!;
    expect(planner.planBinding).toBeUndefined();
    expect(planner.planDiagnostic?.code).toBe("ambiguous-create-targets");
  });

  it("refuses a proposed UPDATE whose page no longer exists at plan admission as a host fault", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(false);
    proposingUpdatePlanner(harness);
    const lifecycle = new ScriptedLifecycle(harness);
    lifecycle.collisions = [{ path: TARGET, existing: "file", base: { sha256: BASE_SHA256 } }];
    // The page existed when the reply was admitted, and is gone at plan admission.
    const collisions = lifecycle.plannedTargetCollisions.bind(lifecycle);
    lifecycle.plannedTargetCollisions = async (input) =>
      lifecycle.collisionQueries.length === 0 ? collisions(input) : [];
    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      id: () => "run-authoring",
    }).run(request());
    expect(record.status).toBe("failed");
    expect(record.steps[0]?.error).toContain(
      "A proposed UPDATE plan names a page the run's revision does not hold.",
    );
  });

  it("refuses a proposed-UPDATE mark on any step but CREATE plan admission", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(false);
    const runStep = harness.runStep.bind(harness);
    harness.runStep = async (input) => {
      const result = await runStep(input);
      return input.step.id === "derive-source-obligations"
        ? { ...result, planBinding: plan, planProposedMode: "update" as const }
        : result;
    };
    const lifecycle = new ScriptedLifecycle(harness);
    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      id: () => "run-authoring",
    }).run(request());
    expect(record.status).toBe("failed");
    expect(record.steps.find((step) => step.id === "derive-source-obligations")?.error).toContain(
      "Only a CREATE planner result can carry a proposed UPDATE.",
    );
  });

  it("gives only the CREATE planner the existence oracle", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(false);
    const lifecycle = new ScriptedLifecycle(harness);
    await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      id: () => "run-authoring",
    }).run(request());
    const holders = harness.calls
      .filter((input) => input.planTargetExistence !== undefined)
      .map((input) => input.step.id);
    expect(holders).toEqual(["plan-documentation"]);
  });

  /**
   * Step 2 citing `locator`. An admitting harness runs the shipped judgment
   * admission, as the model harness does; otherwise the proposal is returned
   * unchecked, as a harness without reply admission returns it.
   */
  function citingDeriver(harness: AuthoringHarness, locator: string, admitting: boolean) {
    const runStep = harness.runStep.bind(harness);
    harness.runStep = async (input) => {
      if (input.step.id !== "derive-source-obligations") return runStep(input);
      harness.calls.push(input);
      const proposal = sourceObligationProposalFixture(locator);
      if (!admitting) {
        return {
          summary: canonicalizeJsonEvidence(proposal as unknown as JsonEvidenceValue).trimEnd(),
          sourceObligationProposal: proposal,
        };
      }
      const reply = JSON.stringify(proposal);
      const admitted = await admitJudgmentReply(input, reply, {
        decodedResponse: reply,
        collectAttemptEvidence: () => ({}),
        refuseContractPlaceholder: () => undefined,
      });
      return {
        summary: admitted.summary,
        sourceObligationProposal: admitted.sourceObligationProposal,
      };
    };
  }

  const CITATION_REFUSALS = [
    [
      "the converted page",
      `${TARGET}:2`,
      "write-target-source",
      { kind: "source-path", path: TARGET },
    ],
    [
      "a tracked file the plan did not bind",
      "docs/other.md:1",
      "source-proposal-required",
      { kind: "source-path", path: "docs/other.md" },
    ],
    [
      "a path the host does not know",
      "notes/invented.md:1",
      "source-proposal-required",
      { kind: "source-path", withheld: "not-host-known" },
    ],
  ] as const;

  // The runner checks the citations inside every attempt, so a harness that
  // skips reply admission gets the same refusal, retry, and record.
  it.each(
    CITATION_REFUSALS.flatMap(([name, locator, code, subject]) => [
      [name, "a harness that admits its reply", locator, code, subject, true] as const,
      [name, "a harness without reply admission", locator, code, subject, false] as const,
    ]),
  )(
    "refuses a CREATE step 2 that cites %s through %s inside its attempt and records what it cited",
    async (_name, _harnessKind, locator, code, subject, admitting) => {
      vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
      const harness = new AuthoringHarness(false);
      citingDeriver(harness, locator, admitting);
      const lifecycle = new ScriptedLifecycle(harness);
      lifecycle.collisions = [{ path: TARGET, existing: "file", base: { sha256: BASE_SHA256 } }];
      const record = await new WorkflowRunner({
        harness,
        hostOperations: harness,
        store: new MemoryStore(),
        repositoryScanner: new StaticScanner(),
        contextPreflight: readyContextPreflight,
        workflowSearch,
        sourceObligationObserver: {
          ...sourceObligationObserverFixture,
          trackedRegularPaths: async () =>
            new Set([SOURCE, TARGET, UNCHANGED_TARGET, "docs/other.md"]),
        },
        repositoryEvidence: new EvidenceCollector(),
        authoringCandidateLifecycle: lifecycle,
        retryPolicy: {
          ...RECORDED_RETRY_POLICY,
          retryableCategories: [...RECORDED_RETRY_POLICY.retryableCategories],
        },
        retrySleep: async () => undefined,
        id: () => "run-authoring",
      }).run(request());

      expect(record.status).toBe("failed");
      const derive = record.steps.find((step) => step.id === "derive-source-obligations")!;
      expect(derive.failure).toEqual({ class: "model-content", layer: "inference", code });
      // Refused in the attempt, not after it: every attempt says so. A write
      // target or a missing source proposal is model-correctable; an admitted
      // but unauthorized citation keeps the authority stop.
      const attempts = derive.inference?.attempts ?? [];
      const retryable = code === "write-target-source" || code === "source-proposal-required";
      expect(attempts.length).toBe(retryable ? 4 : 1);
      for (const attempt of attempts) {
        expect(attempt).toMatchObject({
          outcome: "malformed-response",
          retryable,
          rejection: { code, location: "$.dimensions[].sourceLocators[]" },
          rejectionSubject: subject,
        });
      }
      // The retry is told the rule, never the cited path.
      const retried = harness.calls.filter(
        (input) => input.step.id === "derive-source-obligations" && input.responseCorrection,
      );
      for (const input of retried) {
        expect(input.responseCorrection).toEqual({
          rejection: { code, location: "$.dimensions[].sourceLocators[]" },
        });
      }
      const saved = decodeSavedRunRecord(
        JSON.parse(JSON.stringify(record)) as JsonEvidenceValue,
        record.id,
      );
      const finding = diagnoseRunRecord(saved, "/tmp/state/run-authoring.json")?.findings.find(
        (entry) => entry.role === "terminal",
      );
      expect(finding?.what).toContain(
        "path" in subject
          ? `; the refused citation named ${subject.path}.`
          : "; the refused citation named a path the host does not know, so the record does not name it.",
      );
    },
  );

  it("asks which page a CREATE plan means when several pages it targets already exist", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(false);
    const lifecycle = new ScriptedLifecycle(harness);
    lifecycle.collisions = [
      { path: TARGET, existing: "file", base: { sha256: BASE_SHA256 } },
      { path: UNCHANGED_TARGET, existing: "file", base: { sha256: BASE_SHA256 } },
    ];
    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      outcomeProjector: new AuthoringQualityWorkflowOutcomeProjector(),
      id: () => "run-authoring",
    }).run(request());

    expect(record.status).toBe("needs-input");
    expect(record.failure).toBeUndefined();
    expect(harness.calls.map((input) => input.step.id)).toEqual(["plan-documentation"]);
    expect(lifecycle.calls).not.toContain("seal-0");
    const planner = record.steps.find((step) => step.id === "plan-documentation")!;
    expect(planner.planBinding).toBeUndefined();
    expect(planner.planDiagnostic).toEqual({
      schemaVersion: 1,
      kind: "docsfab-documentation-plan-diagnostic",
      code: "ambiguous-create-targets",
      responseSha256: PLAN_RESPONSE_SHA256,
      responseShape: "json-object",
    });
    expect(planner.summary).toContain(`(${TARGET}, ${UNCHANGED_TARGET})`);
    // The planner's own governed-input route carries it: a sealed outcome and a NEXT.
    expect(record.workflowOutcome).toMatchObject({
      disposition: "needs-input",
      findings: [
        expect.objectContaining({
          kind: "missing-governed-input",
          code: "ambiguous-create-targets",
          inputId: "documentation-plan:ambiguous-create-targets",
        }),
      ],
    });
    const action = buildRunHumanNextCommand({
      record,
      recordPath: "/tmp/state/run-authoring.json",
      repositoryPath: "/tmp/example",
      exitCode: 0,
    });
    expect(action?.reason).toContain("(ambiguous-create-targets)");
  });

  it("refuses a planner result that already claims a host conversion", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(false);
    const runStep = harness.runStep.bind(harness);
    harness.runStep = async (input) => {
      const result = await runStep(input);
      return input.step.id === "plan-documentation"
        ? {
            ...result,
            planBinding: convertCreatePlanPageToUpdate(
              plan,
              {
                path: TARGET,
                baseSha256: BASE_SHA256,
              },
              "create-target-exists",
            ),
          }
        : result;
    };
    const lifecycle = new ScriptedLifecycle(harness);
    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      id: () => "run-authoring",
    }).run(request());
    expect(record.status).toBe("failed");
    expect(record.steps[0]?.error).toContain("cannot carry a host CREATE-to-UPDATE conversion");
    expect(lifecycle.collisionQueries).toEqual([]);
  });

  it("refuses the host stop when the planner reply it judged has no digest", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(false);
    const runStep = harness.runStep.bind(harness);
    harness.runStep = async (input) => {
      const { planResponseSha256: _digest, ...result } = await runStep(input);
      return result;
    };
    const lifecycle = new ScriptedLifecycle(harness);
    lifecycle.collisions = [
      { path: TARGET, existing: "file", base: { sha256: BASE_SHA256 } },
      { path: UNCHANGED_TARGET, existing: "file", base: { sha256: BASE_SHA256 } },
    ];
    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      id: () => "run-authoring",
    }).run(request());
    expect(record.status).toBe("failed");
    expect(record.steps[0]?.error).toContain("cannot name the planner reply it stopped on");
  });

  it.each([
    [false, "retain", 9, 0],
    [true, "revise", 14, 1],
  ] as const)(
    "selects the %s-actionable evidence path without another attempt",
    async (actionable, branch, stepCount, selectedOrdinal) => {
      vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
      const harness = new AuthoringHarness(actionable);
      const lifecycle = new ScriptedLifecycle(harness);
      const runner = new WorkflowRunner({
        harness,
        hostOperations: harness,
        store: new MemoryStore(),
        repositoryScanner: new StaticScanner(),
        contextPreflight: readyContextPreflight,
        workflowSearch,
        sourceObligationObserver: sourceObligationObserverFixture,
        repositoryEvidence: new EvidenceCollector(),
        authoringCandidateLifecycle: lifecycle,
        id: () => "run-authoring",
      });

      const record = await runner.run(request());

      expect(record.status).toBe("succeeded");
      // Positive control for CREATE target admission: new targets are admitted.
      expect(lifecycle.collisionQueries).toEqual([[TARGET, UNCHANGED_TARGET]]);
      expect(() =>
        validateAuthoringRunRecordV1(record, workflow, { requireTerminalSuccess: true }),
      ).not.toThrow();
      expect(record.steps).toHaveLength(stepCount);
      expect(record.authoringExecution).toMatchObject({
        selection: { branchId: branch },
        selectedCandidate: { ordinal: selectedOrdinal },
        finalPatch: { candidateOrdinal: selectedOrdinal },
      });
      expect(harness.calls.filter((input) => input.step.id === "write-documentation")).toHaveLength(
        1,
      );
      expect(
        harness.calls.filter((input) => input.step.id === "revise-documentation"),
      ).toHaveLength(actionable ? 1 : 0);
      expect(lifecycle.calls.filter((call) => call === "seal-1")).toHaveLength(actionable ? 1 : 0);
      expect(lifecycle.calls).toContain(`materialize-${selectedOrdinal}`);
      expect(record.steps.every((step) => step.status === "succeeded")).toBe(true);
      for (const input of harness.calls.filter(
        (call) => call.evidenceIdentity?.authoringPhaseSha256,
      )) {
        expect(input.evidenceIdentity?.authoringPhaseSha256).toMatch(/^[a-f0-9]{64}$/u);
      }
      if (actionable) {
        const revision = harness.calls.find((input) => input.step.id === "revise-documentation")!;
        expect(revision.repositoryPath).toBe("/tmp/docsfab-authoring-child");
        expect(revision.repositoryWorkspace?.path).toBe("/tmp/docsfab-authoring-child");
        expect(revision.authoringRevisionInput?.actionableFacts).toHaveLength(1);
        const revisedFinal = harness.calls.find(
          (input) => input.step.id === "verify-revised-technical-accuracy",
        )!;
        expect(revisedFinal.step.prompt).toContain("provisional-revised-technical-verification");
        expect(revisedFinal.step.prompt).not.toContain(
          '"stepId":"provisional-technical-verification"',
        );
        expect(
          record.steps.find((step) => step.id === "revise-documentation")
            ?.authoringRevisionAccounting?.issueAccounting,
        ).toEqual([expect.objectContaining({ disposition: "applied" })]);
        expect(
          record.steps.find((step) => step.id === "verify-revised-technical-accuracy")?.summary,
        ).toBeDefined();
        expect(lifecycle.candidate0.candidate.writePaths).toEqual([TARGET, UNCHANGED_TARGET]);
        expect(lifecycle.candidate1.snapshot.entries).toHaveLength(2);
        expect(lifecycle.candidate0.snapshot.entries[1]).toEqual(
          lifecycle.candidate1.snapshot.entries[1],
        );
        expect(record.authoringExecution?.revisionAdmission).toMatchObject({
          changedPaths: [TARGET],
          candidate0WorkspaceSnapshotDigest: lifecycle.candidate0.candidate.workspaceSnapshotDigest,
          candidate1WorkspaceSnapshotDigest: lifecycle.candidate1.candidate.workspaceSnapshotDigest,
        });
      }
    },
  );

  // A refused read changes nothing and is not a request outside the approved
  // plan; only a refused mutation is.
  it("keeps a planned write succeeded when only a writer read was refused (#1055)", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new ToolRefusalAuthoringHarness({ deniedReads: 1, deniedMutations: 0 });
    const lifecycle = new ScriptedLifecycle(harness);

    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      id: () => "run-authoring",
    }).run(request());

    const writer = record.steps.find((step) => step.id === "write-documentation");
    expect(writer?.status).toBe("succeeded");
    expect(writer?.summary ?? "").not.toContain("outside the approved documentation plan");
    // The refusal stays visible as evidence but does not decide the outcome.
    expect(writer?.tools?.failureCategories).toEqual([{ category: "denied-path", count: 1 }]);
    expect(record.status).toBe("succeeded");
    expect(lifecycle.calls).toContain("materialize-0");
  });

  it.each([
    { stepId: "write-documentation", bridge: false },
    { stepId: "revise-documentation", bridge: true },
  ])(
    "stops $stepId for a new plan when a mutation was refused, as a sealed needs-input",
    async ({ stepId, bridge }) => {
      vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
      const harness = new ToolRefusalAuthoringHarness(
        { deniedReads: 1, deniedMutations: 1 },
        stepId,
        bridge,
      );
      const lifecycle = new ScriptedLifecycle(harness);

      const record = await new WorkflowRunner({
        harness,
        hostOperations: harness,
        store: new MemoryStore(),
        repositoryScanner: new StaticScanner(),
        contextPreflight: readyContextPreflight,
        workflowSearch,
        sourceObligationObserver: sourceObligationObserverFixture,
        repositoryEvidence: new EvidenceCollector(),
        authoringCandidateLifecycle: lifecycle,
        outcomeProjector: new AuthoringQualityWorkflowOutcomeProjector(),
        id: () => "run-authoring",
      }).run(request());

      const writer = record.steps.find((step) => step.id === stepId);
      expect(writer?.status).toBe("needs-input");
      expect(writer?.summary).toContain(
        "Writer requested a path outside the approved documentation plan; a new plan is required.",
      );
      // A coded stop seals; it is never refused as an invalid record.
      expect(record.status, record.error).toBe("needs-input");
      expect(record.workflowOutcomeRejection).toBeUndefined();
      expect(record.workflowOutcome).toMatchObject({
        disposition: "needs-input",
        openDecisions: [
          {
            id: "decision:documentation-plan:writer-mutation-outside-plan",
            kind: "governed-input",
            evidenceIds: [`step:${stepId}`],
          },
        ],
      });
      // The stopped writer's output is never admitted or selected.
      expect(writer?.authoringPhase).toMatchObject({
        outputCandidateOrdinal: null,
        outputCandidateDigest: null,
      });
      expect(writer?.authoringRevisionAccounting).toBeUndefined();
      expect(record.authoringExecution?.revisionAdmission ?? null).toBeNull();
      if (stepId === "write-documentation") {
        // Nothing was admitted, so nothing is sealed, selected or materialized.
        expect(lifecycle.calls).not.toContain("seal-0");
        expect(lifecycle.calls).not.toContain("materialize-0");
        expect(record.authoringExecution?.candidates ?? []).toEqual([]);
        expect(record.authoringExecution?.selectedCandidate ?? null).toBeNull();
      } else {
        // Candidate zero stays the selected result; the stopped revision is
        // retained only as a non-deliverable partial named by the stop code.
        expect(lifecycle.calls).toContain("partial-1");
        expect(lifecycle.calls).not.toContain("seal-1");
        // The retained patch is candidate zero, not the stopped revision's workspace.
        expect(lifecycle.calls).toContain("materialize-0");
        expect(record.changes?.patch?.sha256).toBe(lifecycle.candidate0.evidence.patch!.sha256);
        expect(record.authoringExecution?.selectedCandidate?.ordinal).toBe(0);
        expect(record.authoringExecution?.partialCandidate1).toMatchObject({
          disposition: "non-deliverable",
          failureCode: "writer-mutation-outside-plan",
        });
      }
      expect(() => validateAuthoringRunRecordV1(record, workflow)).not.toThrow();
      expect(() =>
        validateAuthoringRunRecordV1(record, workflow, { requireTerminalSuccess: true }),
      ).toThrow();
    },
  );

  it("stops a first writer that changed no file under AGENTS.md, as a sealed needs-input", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new NoChangeAuthoringHarness();
    const lifecycle = new ScriptedLifecycle(harness);

    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      outcomeProjector: new AuthoringQualityWorkflowOutcomeProjector(),
      id: () => "run-authoring",
    }).run(request());

    const writer = record.steps.find((step) => step.id === "write-documentation");
    expect(writer?.status).toBe("needs-input");
    expect(writer?.summary).toBe(
      "AGENTS.md asks me to confirm its disclaimer first. Do you acknowledge it?",
    );
    expect(writer?.writerNoChangeStop).toEqual({
      schemaVersion: 1,
      kind: "docsfab-documentation-writer-no-change-stop",
      code: "writer-made-no-change",
      repositoryInstructions: ["AGENTS.md"],
    });
    expect(record.status, record.error).toBe("needs-input");
    expect(record.workflowOutcomeRejection).toBeUndefined();
    expect(record.workflowOutcome).toMatchObject({
      disposition: "needs-input",
      openDecisions: [
        {
          id: "decision:documentation-plan:writer-made-no-change",
          kind: "governed-input",
          evidenceIds: ["step:write-documentation"],
        },
      ],
    });
    // The writer ran last; nothing was admitted, sealed, selected or materialized.
    expect(harness.calls.at(-1)?.step.id).toBe("write-documentation");
    expect(lifecycle.calls).not.toContain("seal-0");
    expect(lifecycle.calls).not.toContain("materialize-0");
    expect(record.authoringExecution?.candidates ?? []).toEqual([]);
    expect(() => validateAuthoringRunRecordV1(record, workflow)).not.toThrow();
  });

  it("routes a source-backed editorial contradiction through canonical technical correction and the sole revision", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(
      false,
      undefined,
      undefined,
      false,
      "verified",
      false,
      true,
    );
    const lifecycle = new ScriptedLifecycle(harness);
    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      id: () => "run-authoring",
    }).run(request());

    expect(record.status).toBe("succeeded");
    expect(record.steps).toHaveLength(14);
    expect(record.authoringExecution).toMatchObject({
      selection: {
        branchId: "revise",
        input: {
          technical: { stepId: "verify-technical-accuracy" },
          editorial: { stepId: "review-documentation" },
        },
      },
      selectedCandidate: { ordinal: 1 },
    });
    const provisional = record.steps.find(
      (step) => step.id === "provisional-technical-verification",
    )!;
    const canonical = record.steps.find((step) => step.id === "verify-technical-accuracy")!;
    expect(
      JSON.parse(provisional.summary!).factInventory.dimensions[0].facts[0]
        .documentationDisposition,
    ).toBe("documented");
    expect(
      JSON.parse(canonical.summary!).factInventory.dimensions[0].facts[0].documentationDisposition,
    ).toBe("conflicting");
    expect(JSON.parse(canonical.summary!).factInventory.dimensions[0].facts[0].id).toBe(
      JSON.parse(provisional.summary!).factInventory.dimensions[0].facts[0].id,
    );
    expect(harness.calls.filter((input) => input.step.id === "revise-documentation")).toHaveLength(
      1,
    );
    expect(record.steps.filter((step) => step.id === "revise-documentation")).toHaveLength(1);
    expect(() =>
      validateAuthoringRunRecordV1(record, workflow, { requireTerminalSuccess: true }),
    ).not.toThrow();
  });

  it("selects the revision when the admitted technical facts quote the cited source's shebang (#1343)", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(
      false,
      undefined,
      undefined,
      false,
      "verified",
      false,
      true,
      undefined,
      undefined,
      true,
    );
    const lifecycle = new ScriptedLifecycle(harness);
    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      id: () => "run-authoring",
    }).run(request());

    const canonical = record.steps.find((step) => step.id === "verify-technical-accuracy")!;
    expect(canonical.summary).toContain("#!/usr/bin/env node");
    expect(record.error).toBeUndefined();
    expect(record.authoringExecution).toMatchObject({
      selection: { branchId: "revise" },
      selectedCandidate: { ordinal: 1 },
    });
    expect(record.status).toBe("succeeded");
  });

  it("retains candidate zero and a non-deliverable partial when the revision writer fails", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(true, "revise-documentation");
    const lifecycle = new ScriptedLifecycle(harness);
    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      id: () => "run-authoring",
    }).run(request());

    expect(record.status).toBe("failed");
    expect(() => validateAuthoringRunRecordV1(record, workflow)).not.toThrow();
    expect(record.authoringExecution).toMatchObject({
      selection: { branchId: "revise" },
      selectedCandidate: { ordinal: 0 },
      partialCandidate1: {
        disposition: "non-deliverable",
        artifact: { sha256: "5".repeat(64) },
        workspaceSnapshotDigest: "6".repeat(64),
      },
      finalPatch: { candidateOrdinal: 0 },
    });
    expect(lifecycle.calls).toEqual(
      expect.arrayContaining(["seal-0", "prepare-1", "partial-1", "materialize-0", "dispose-1"]),
    );
    expect(lifecycle.calls).not.toContain("seal-1");
  });

  it("retains failed revision evidence but surfaces a typed terminal store failure", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(true, "revise-documentation");
    const lifecycle = new ScriptedLifecycle(harness);
    const run = new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new FailingTerminalStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      id: () => "run-authoring",
    }).run(request());

    await expect(run).rejects.toEqual(
      expect.objectContaining<Partial<WorkflowRunnerBoundaryError>>({
        code: "run-store-write-failed",
      }),
    );
    expect(lifecycle.calls).toEqual(
      expect.arrayContaining(["seal-0", "prepare-1", "partial-1", "materialize-0", "dispose-1"]),
    );
    expect(lifecycle.calls).not.toContain("seal-1");
  });

  it("keeps the coded ceiling line when a governor stop reaches the thrown-run settlement", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new GovernorStopHarness("write-documentation");
    const lifecycle = new ScriptedLifecycle(harness);
    const store = new FailOnceOnFailedStepStore();
    const run = new WorkflowRunner({
      harness,
      hostOperations: harness,
      store,
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      id: () => "run-authoring",
    }).run(request());

    await expect(run).rejects.toEqual(
      expect.objectContaining<Partial<WorkflowRunnerBoundaryError>>({
        code: "run-store-write-failed",
      }),
    );
    // The settlement re-marks the step from its terminal attempt, so the
    // limit code and its line survive the store failure that ended the run.
    const step = store.records
      .at(-1)
      ?.steps.find((candidate) => candidate.id === "write-documentation");
    expect(step?.failure).toEqual({
      class: "bound",
      layer: "inference",
      code: "composition-execution-max-tool-calls-per-step-bound",
    });
    expect(step?.error).toMatch(
      /^.+ composition-execution-max-tool-calls-per-step-bound: workflow step "write-documentation" exceeded its tool-call ceiling of 126 calls \(observed 127 calls\)\. Scope: one attempt of this step\./u,
    );
  });

  it("seals and materializes candidate zero before surfacing its original store failure", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(false);
    const lifecycle = new ScriptedLifecycle(harness);
    const store = new FailingPreSealStore();
    const run = new WorkflowRunner({
      harness,
      hostOperations: harness,
      store,
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      id: () => "run-authoring",
    }).run(request());

    await expect(run).rejects.toEqual(
      expect.objectContaining<Partial<WorkflowRunnerBoundaryError>>({
        code: "run-store-write-failed",
      }),
    );
    expect(lifecycle.calls).toEqual(expect.arrayContaining(["seal-0", "materialize-0"]));
    expect(lifecycle.calls).not.toContain("seal-1");
    expect(store.records.at(-1)).toMatchObject({
      status: "failed",
      error: "Workflow execution could not be completed.",
      authoringExecution: {
        selectedCandidate: { ordinal: 0 },
        finalPatch: { candidateOrdinal: 0 },
      },
      changes: { patch: { sha256: lifecycle.candidate0.evidence.patch!.sha256 } },
    });
  });

  it("retains a typed revision-accounting rejection with the failed partial", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(true, undefined, undefined, false, "verified", true);
    const lifecycle = new ScriptedLifecycle(harness);
    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      id: () => "run-authoring",
    }).run(request());

    expect(record.status).toBe("failed");
    expect(record.error).toContain("revision-accounting-source-locator-membership");
    const revision = record.steps.find((step) => step.id === "revise-documentation")!;
    expect(revision.error).toContain("revision-accounting-source-locator-membership");
    expect(revision.error).not.toContain("src/unrelated.ts");
    expect(revision.inference?.attempts.at(-1)).toMatchObject({
      outcome: "malformed-response",
      retryable: false,
      retryScheduled: false,
    });
    expect(record.authoringExecution).toMatchObject({
      selectedCandidate: { ordinal: 0 },
      partialCandidate1: {
        disposition: "non-deliverable",
        failureCode: "revision-writer-failed",
      },
      finalPatch: { candidateOrdinal: 0 },
    });
    expect(harness.calls.filter((input) => input.step.id === "revise-documentation")).toHaveLength(
      1,
    );
    expect(lifecycle.calls).toEqual(
      expect.arrayContaining(["partial-1", "materialize-0", "dispose-1"]),
    );
    expect(lifecycle.calls).not.toContain("seal-1");

    const action = buildRunHumanNextCommand({
      record,
      recordPath: "/tmp/custom state/run-authoring.json",
      repositoryPath: "/tmp/example",
      exitCode: 1,
    });
    expect(action?.command).toBe(
      "docsfab runs show run-authoring --state-dir '/tmp/custom state' --json",
    );
    expect(action?.reason).toContain("Candidate 0 remains selected");
    expect(action?.reason).toContain("non-deliverable");
    expect(action?.reason).not.toContain("could not be verified");

    const missing = structuredClone(record);
    delete missing.authoringExecution;
    const corrupt = structuredClone(record);
    corrupt.authoringExecution = {} as never;
    const selectedOne = structuredClone(record);
    const selectedPointer = selectedOne.authoringExecution?.selectedCandidate as {
      ordinal: 0 | 1;
    };
    selectedPointer.ordinal = 1;
    const invalidSequence = structuredClone(record);
    invalidSequence.steps[0] = { ...invalidSequence.steps[0]!, id: "unexpected-prefix" };

    for (const coldRecord of [missing, corrupt, selectedOne, invalidSequence]) {
      const coldAction = buildRunHumanNextCommand({
        record: coldRecord,
        recordPath: "/tmp/custom state/run-authoring.json",
        repositoryPath: "/tmp/example",
        exitCode: 1,
      });
      expect(coldAction?.command).toBe(
        "docsfab runs show run-authoring --state-dir '/tmp/custom state' --json",
      );
      expect(coldAction?.reason).toContain(
        "Candidate selection and failed-partial status could not be verified",
      );
      expect(coldAction?.reason).not.toContain("Candidate 0 remains selected");
      expect(coldAction?.reason).not.toContain("non-deliverable");
      expect(coldAction?.reason).toContain(
        "do not replay or retry the unchanged inference or write step",
      );
    }
  });

  /** The configured read-only budget of the recorded create-cli run. */
  const RECORDED_RETRY_POLICY = {
    maxRetries: 3,
    baseDelayMs: 1,
    maxDelayMs: 2,
    retryableCategories: [
      "blank-response",
      "malformed-response",
      "timeout",
      "throttled",
      "provider-transient",
    ],
  } as const satisfies NonNullable<ConstructorParameters<typeof WorkflowRunner>[0]["retryPolicy"]>;

  const RECORDED_RETRY_POLICY_WITH_TRANSPORT = {
    ...RECORDED_RETRY_POLICY,
    transport: { maxRetries: 3, maxDelayMs: 2, maxElapsedMs: 60_000 },
  } as const satisfies NonNullable<ConstructorParameters<typeof WorkflowRunner>[0]["retryPolicy"]>;

  function recordedMismatchRunner(
    harness: AuthoringHarness,
    lifecycle: ScriptedLifecycle,
    retryPolicy = RECORDED_RETRY_POLICY,
  ) {
    return new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      retryPolicy: { ...retryPolicy, retryableCategories: [...retryPolicy.retryableCategories] },
      retrySleep: async () => undefined,
      id: () => "run-authoring",
    });
  }

  it("records the recorded changed-path mismatch structurally and retries it from candidate 0 with its hint", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(true);
    const lifecycle = new ScriptedLifecycle(harness);
    // The create-cli record: the writer rewrote the page with identical bytes,
    // so nothing changed, yet it declared the page changed and the issue applied.
    lifecycle.observedChangedPaths.push([]);
    const record = await recordedMismatchRunner(harness, lifecycle).run(request());

    expect(record.status).toBe("succeeded");
    const revision = record.steps.find((step) => step.id === "revise-documentation")!;
    expect(revision.status).toBe("succeeded");
    expect(revision.authoringRevisionRejection).toBeUndefined();
    expect(revision.inference).toMatchObject({
      replay: "reset-write-step",
      configuredMaxRetries: 3,
      effectiveMaxRetries: 3,
    });
    expect(revision.inference?.attempts).toHaveLength(2);
    expect(revision.inference?.attempts[0]).toMatchObject({
      outcome: "malformed-response",
      retryable: true,
      retryScheduled: true,
      retryDecision: "retried",
      rejection: {
        code: "revision-accounting-changed-path-mismatch",
        location: "$.changedPaths",
      },
      // What the writer declared against what it changed: plan write paths only.
      rejectionSubject: { kind: "changed-paths", declared: [TARGET], observed: [] },
    });
    expect(revision.inference?.attempts[1]).toMatchObject({ outcome: "succeeded" });
    expect(revision.inference?.attempts[1]?.rejectionSubject).toBeUndefined();
    // The retry started from candidate 0 and was told the rule, never the reply.
    const writerCalls = harness.calls.filter((input) => input.step.id === "revise-documentation");
    expect(writerCalls).toHaveLength(2);
    expect(writerCalls[0]!.responseCorrection).toBeUndefined();
    expect(writerCalls[1]!.responseCorrection).toEqual({
      rejection: {
        code: "revision-accounting-changed-path-mismatch",
        location: "$.changedPaths",
      },
    });
    const resetAt = lifecycle.calls.indexOf("reset-1");
    expect(resetAt).toBeGreaterThan(lifecycle.calls.indexOf("observe-1"));
    expect(lifecycle.calls.filter((call) => call === "reset-1")).toHaveLength(1);
    expect(lifecycle.calls.slice(resetAt)).toContain("seal-1");
    expect(record.authoringExecution).toMatchObject({
      selectedCandidate: { ordinal: 1 },
      finalPatch: { candidateOrdinal: 1 },
    });
    expect(() => validateAuthoringRunRecordV1(record, workflow)).not.toThrow();
    const cold = decodeSavedRunRecord(
      JSON.parse(JSON.stringify(record)) as JsonEvidenceValue,
      record.id,
    );
    expect(cold.steps.find((step) => step.id === "revise-documentation")?.inference?.replay).toBe(
      "reset-write-step",
    );
  });

  it("resets candidate 0 before replaying a transport failure after a settled revision write", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(true);
    harness.transportFailureAfterRevisionWrite = true;
    const lifecycle = new ScriptedLifecycle(harness);
    const reset = lifecycle.resetRevision.bind(lifecycle);
    lifecycle.resetRevision = async () => {
      await reset();
      harness.revisionWorkspaceCandidate = 0;
    };

    const record = await recordedMismatchRunner(
      harness,
      lifecycle,
      RECORDED_RETRY_POLICY_WITH_TRANSPORT,
    ).run(request());

    const revision = record.steps.find((step) => step.id === "revise-documentation")!;
    expect(record.status).toBe("succeeded");
    expect(revision.inference).toMatchObject({
      replay: "reset-write-step",
      attempts: [
        {
          outcome: "provider-transient",
          writeSettlement: "write-executed",
          retryScheduled: true,
          retryRule: "retried-transport",
        },
        { outcome: "succeeded" },
      ],
    });
    expect(lifecycle.calls.filter((call) => call === "reset-1")).toHaveLength(1);
    expect(harness.revisionCandidateAtStart).toEqual([0, 0]);
    expect(harness.revisionWrites).toBe(1);
  });

  it("stops on the coded mismatch when the configured retries are spent", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(true);
    const lifecycle = new ScriptedLifecycle(harness);
    lifecycle.observedChangedPaths.push([], [], [], []);
    const record = await recordedMismatchRunner(harness, lifecycle).run(request());

    expect(record.status).toBe("failed");
    const revision = record.steps.find((step) => step.id === "revise-documentation")!;
    expect(revision.status).toBe("failed");
    expect(revision.authoringRevisionRejection).toEqual({
      code: "revision-accounting-changed-path-mismatch",
      location: "$.changedPaths",
    });
    expect(revision.failure).toEqual({
      class: "model-content",
      layer: "inference",
      code: "revision-accounting-changed-path-mismatch",
    });
    expect(revision.summary).toBeUndefined();
    expect(revision.inference?.attempts).toHaveLength(4);
    expect(revision.inference?.attempts.at(-1)).toMatchObject({
      outcome: "malformed-response",
      retryable: true,
      retryScheduled: false,
      retryDecision: "exhausted",
    });
    expect(lifecycle.calls.filter((call) => call === "reset-1")).toHaveLength(3);
    expect(lifecycle.calls).not.toContain("seal-1");
    expect(record.authoringExecution).toMatchObject({
      selectedCandidate: { ordinal: 0 },
      finalPatch: { candidateOrdinal: 0 },
    });
    expect(() => validateAuthoringRunRecordV1(record, workflow)).not.toThrow();
    // The saved record alone explains the stop: the declared page, and no change.
    const saved = decodeSavedRunRecord(
      JSON.parse(JSON.stringify(record)) as JsonEvidenceValue,
      record.id,
    );
    const diagnosis = diagnoseRunRecord(saved, "/tmp/state/run-authoring.json");
    const finding = diagnosis?.findings.find((entry) => entry.role === "terminal");
    expect(finding?.evidence.rejectionSubject).toEqual({
      sourcePath: null,
      declaredChangedPaths: JSON.stringify([TARGET]),
      observedChangedPaths: "[]",
      withheld: null,
    });
    expect(finding?.what).toBe(
      "Step revise-documentation attempt 4 of 4: malformed-response, rejected by " +
        "revision-accounting-changed-path-mismatch at $.changedPaths; the writer declared " +
        `${JSON.stringify([TARGET])} changed, and the host observed [] changed.`,
    );
    const action = buildRunHumanNextCommand({
      record,
      recordPath: "/tmp/state/run-authoring.json",
      repositoryPath: "/tmp/example",
    });
    expect(action?.reason).toContain("revision-accounting-changed-path-mismatch");
  });

  it("keeps the sealed mutation check and records its code when it disagrees with the attempt", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(true);
    const lifecycle = new ScriptedLifecycle(harness);
    // The attempt observed the declared change, but the sealed candidate 1 is
    // byte-identical to candidate 0: the sealed check still refuses it.
    lifecycle.observedChangedPaths.push([TARGET]);
    lifecycle.sealCandidate1 = async () => {
      lifecycle.calls.push("seal-1");
      return capture(1, "1", "4");
    };
    const record = await recordedMismatchRunner(harness, lifecycle).run(request());

    expect(record.status).toBe("failed");
    const revision = record.steps.find((step) => step.id === "revise-documentation")!;
    expect(revision.status).toBe("failed");
    expect(revision.inference?.attempts).toMatchObject([{ outcome: "succeeded" }]);
    expect(revision.authoringRevisionRejection).toEqual({
      code: "revision-accounting-changed-path-mismatch",
      location: "$.changedPaths",
    });
    expect(revision.failure).toMatchObject({ code: "revision-accounting-changed-path-mismatch" });
    const action = buildRunHumanNextCommand({
      record,
      recordPath: "/tmp/state/run-authoring.json",
      repositoryPath: "/tmp/example",
    });
    expect(action?.reason).toContain("revision-accounting-changed-path-mismatch");
  });

  it("stops the revision step on a coded host fault when its workspace cannot be observed", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(true);
    const lifecycle = new ScriptedLifecycle(harness);
    lifecycle.observeRevisionChangedPaths = async () => {
      lifecycle.calls.push("observe-1");
      throw new Error("The fixture workspace holds an entry candidate 0 does not have.");
    };
    const record = await recordedMismatchRunner(harness, lifecycle).run(request());

    expect(record.status).toBe("failed");
    const revision = record.steps.find((step) => step.id === "revise-documentation")!;
    expect(revision.status).toBe("failed");
    expect(revision.failure).toEqual({
      class: "infrastructure",
      layer: "workflow",
      code: "authoring-revision-observation-failed",
    });
    expect(revision.error).toBe(
      "The authoring revision workspace could not be observed to check the writer's accounting.",
    );
    // A host fault is never the model's reply: the attempt keeps its outcome.
    expect(revision.inference?.attempts).toMatchObject([{ outcome: "succeeded" }]);
    expect(revision.authoringRevisionRejection).toBeUndefined();
    expect(harness.calls.filter((input) => input.step.id === "revise-documentation")).toHaveLength(
      1,
    );
    expect(lifecycle.calls).not.toContain("reset-1");
    expect(lifecycle.calls).not.toContain("seal-1");
  });

  it("stops a replay whose candidate-0 reset fails as a coded host fault", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(true);
    const lifecycle = new ScriptedLifecycle(harness);
    lifecycle.observedChangedPaths.push([]);
    lifecycle.resetRevision = async () => {
      lifecycle.calls.push("reset-1");
      throw new Error("The fixture workspace could not be restored.");
    };
    const record = await recordedMismatchRunner(harness, lifecycle).run(request());

    const revision = record.steps.find((step) => step.id === "revise-documentation")!;
    expect(revision.status).toBe("failed");
    expect(revision.failure).toEqual({
      class: "infrastructure",
      layer: "workflow",
      code: "authoring-revision-reset-failed",
    });
    expect(revision.error).toBe(
      "The authoring revision workspace could not be restored to candidate 0 before a retry.",
    );
    expect(revision.authoringRevisionRejection).toBeUndefined();
    expect(harness.calls.filter((input) => input.step.id === "revise-documentation")).toHaveLength(
      1,
    );
    expect(lifecycle.calls).not.toContain("seal-1");
  });

  it("keeps admitted candidate one selected when a revised check fails", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(true, "lint-revised-documentation");
    const lifecycle = new ScriptedLifecycle(harness);
    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      id: () => "run-authoring",
    }).run(request());

    expect(record.status).toBe("failed");
    expect(() => validateAuthoringRunRecordV1(record, workflow)).not.toThrow();
    expect(record.authoringExecution).toMatchObject({
      selectedCandidate: { ordinal: 1 },
      partialCandidate1: null,
      finalPatch: { candidateOrdinal: 1 },
    });
    expect(lifecycle.calls).toContain("materialize-1");
    expect(lifecycle.calls).not.toContain("partial-1");
  });

  it("cancels without another attempt and retains candidate zero plus partial evidence", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const controller = new AbortController();
    const harness = new AuthoringHarness(true, "revise-documentation", controller);
    const lifecycle = new ScriptedLifecycle(harness);
    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      id: () => "run-authoring",
    }).run({ ...request(), signal: controller.signal });

    expect(record.status).toBe("failed");
    expect(() => validateAuthoringRunRecordV1(record, workflow)).not.toThrow();
    expect(record.error).toBe("Workflow cancelled by user.");
    expect(record.authoringExecution).toMatchObject({
      selectedCandidate: { ordinal: 0 },
      partialCandidate1: { failureCode: "cancelled" },
      finalPatch: { candidateOrdinal: 0 },
    });
    expect(harness.calls.filter((input) => input.step.id === "revise-documentation")).toHaveLength(
      1,
    );
    expect(lifecycle.calls).toContain("materialize-0");
  });

  it("rejects false revision accounting without selecting candidate one", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(true, undefined, undefined, true);
    const lifecycle = new ScriptedLifecycle(harness);
    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      id: () => "run-authoring",
    }).run(request());

    expect(record.status).toBe("failed");
    expect(() => validateAuthoringRunRecordV1(record, workflow)).not.toThrow();
    expect(record.authoringExecution).toMatchObject({
      selectedCandidate: { ordinal: 0 },
      partialCandidate1: { disposition: "non-deliverable" },
      finalPatch: { candidateOrdinal: 0 },
    });
    expect(
      record.steps.find((step) => step.id === "revise-documentation")?.authoringRevisionAccounting,
    ).toBeUndefined();
    expect(lifecycle.calls).toContain("partial-1");
    expect(lifecycle.calls).toContain("materialize-0");
  });

  it("retains the completed prefix when revision workspace preparation fails", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(true);
    const lifecycle = new ScriptedLifecycle(harness, true);
    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      id: () => "run-authoring",
    }).run(request());

    expect(record.status).toBe("failed");
    expect(() => validateAuthoringRunRecordV1(record, workflow)).not.toThrow();
    expect(record.steps.find((step) => step.id === "review-documentation")?.status).toBe(
      "succeeded",
    );
    expect(record.steps.find((step) => step.id === "revise-documentation")?.status).toBe("pending");
    expect(record.authoringExecution).toMatchObject({
      selection: { branchId: "revise" },
      selectedCandidate: { ordinal: 0 },
      partialCandidate1: null,
      finalPatch: { candidateOrdinal: 0 },
    });
    expect(lifecycle.calls).toEqual(
      expect.arrayContaining(["seal-0", "prepare-1", "materialize-0"]),
    );
    expect(lifecycle.calls).not.toContain("seal-1");
  });

  it("stops before revision as named InputAsk slots when admitted target coverage remains unverified", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(
      true,
      undefined,
      undefined,
      false,
      "unverified",
      false,
      false,
      undefined,
      "environment-prerequisite",
    );
    const lifecycle = new ScriptedLifecycle(harness);
    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      id: () => "run-authoring",
    }).run(request());

    // A source gap ends `needs-input` with one slot per page, never `failed` and
    // never CREATE success.
    expect(record.status).toBe("needs-input");
    expect(record.error).toBeUndefined();
    expect(record.failure).toBeUndefined();
    expect(record.authoringCandidateRejection).toBeUndefined();
    const inputIds = [TARGET, UNCHANGED_TARGET]
      .sort()
      .map((page) => `source-support:environment-prerequisite:${page}`);
    expect(record.workflowOutcome).toMatchObject({
      disposition: "needs-input",
      limitations: [],
      producedArtifacts: [],
    });
    expect(record.workflowOutcome!.findings.map((finding) => finding.inputId)).toEqual(inputIds);
    expect(new Set(record.workflowOutcome!.findings.map((finding) => finding.code))).toEqual(
      new Set(["authoring-candidate-unverified-coverage"]),
    );
    expect(record.workflowOutcome!.openDecisions.map((decision) => decision.inputId)).toEqual(
      inputIds,
    );
    const technicalStep = record.steps.find((step) => step.id === "verify-technical-accuracy")!;
    expect(technicalStep.status).toBe("needs-input");
    expect(technicalStep.error).toMatch(
      /^authoring-source-support:authoring-candidate-unverified-coverage:[a-f0-9]{64}$/u,
    );
    expect(technicalStep.summary).toContain("TECH-001");
    expect(record.steps).toHaveLength(workflow.authoringSchedule!.prefix.steps.length);
    expect(
      record.steps
        .filter((step) => step.id !== "verify-technical-accuracy")
        .every((step) => step.status === "succeeded"),
    ).toBe(true);
    expect(harness.calls.some((input) => input.step.id === "revise-documentation")).toBe(false);
    expect(harness.calls.some((input) => input.step.id === "evaluate-document-quality")).toBe(
      false,
    );
    expect(lifecycle.calls).toEqual(expect.arrayContaining(["seal-0", "materialize-0"]));
    expect(lifecycle.calls).not.toContain("prepare-1");
    expect(record.authoringExecution).toMatchObject({
      selection: null,
      selectedCandidate: { ordinal: 0 },
      finalPatch: { candidateOrdinal: 0 },
    });
    expect(() => validateAuthoringRunRecordV1(record, workflow)).not.toThrow();
    expect(() =>
      validateAuthoringRunRecordV1(record, workflow, { requireTerminalSuccess: true }),
    ).toThrow();
    // The validator admits the needs-input technical step only on a needs-input
    // run and only with the exact retained rejection of its own summary.
    expect(technicalStep.error).toBe(
      authoringSourceSupportStepError(
        "authoring-candidate-unverified-coverage",
        technicalStep.summary!,
      ),
    );
    const failedRun = structuredClone(record);
    failedRun.status = "failed";
    expect(() => validateAuthoringRunRecordV1(failedRun, workflow)).toThrow("selection-mismatch");
    const forgedDigest = structuredClone(record);
    forgedDigest.steps.find((step) => step.id === "verify-technical-accuracy")!.error =
      `authoring-source-support:authoring-candidate-unverified-coverage:${"0".repeat(64)}`;
    expect(() => validateAuthoringRunRecordV1(forgedDigest, workflow)).toThrow(
      "selection-mismatch",
    );

    const next = buildRunHumanNextCommand({
      record,
      recordPath: "/tmp/state/run-authoring.json",
      repositoryPath: record.repository.sourcePath,
      exitCode: 2,
    });
    expect(next?.command).toBe("docsfab do --continue run-authoring");
    expect(next?.reason).toContain(`Source for environment prerequisite on ${TARGET} (path)`);

    const coldRecord = decodeSavedRunRecord(
      JSON.parse(JSON.stringify(record)) as JsonEvidenceValue,
      record.id,
    );
    expect(() => validateAuthoringRunRecordV1(coldRecord, workflow)).not.toThrow();
    expect(coldRecord.workflowOutcome).toEqual(record.workflowOutcome);
  });

  it("routes a host-owned unverified ledger dimension to InputAsk when coverage reads verified", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(
      false,
      undefined,
      undefined,
      false,
      "verified",
      false,
      false,
      undefined,
      "environment-prerequisite",
    );
    const lifecycle = new ScriptedLifecycle(harness);
    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      id: () => "run-authoring",
    }).run(request());

    expect(record.status).toBe("needs-input");
    expect(record.workflowOutcome?.disposition).toBe("needs-input");
    expect(
      record.workflowOutcome!.findings.map((finding) => [finding.inputId, finding.code]),
    ).toEqual(
      [TARGET, UNCHANGED_TARGET]
        .sort()
        .map((page) => [
          `source-support:environment-prerequisite:${page}`,
          "source-obligation-unverified-dimension",
        ]),
    );
    expect(record.steps.find((step) => step.id === "verify-technical-accuracy")?.error).toMatch(
      /^authoring-source-support:source-obligation-unverified-dimension:[a-f0-9]{64}$/u,
    );
    expect(harness.calls.some((input) => input.step.id === "assess-audience-coverage")).toBe(false);
    expect(record.authoringExecution).toMatchObject({ selection: null });
    expect(() => validateAuthoringRunRecordV1(record, workflow)).not.toThrow();
  });

  it("retains candidate one when a revised assessment fails before inference", async () => {
    vi.spyOn(workflowCatalog, "getWorkflow").mockReturnValue(workflow);
    const harness = new AuthoringHarness(true);
    const lifecycle = new ScriptedLifecycle(harness);
    const record = await new WorkflowRunner({
      harness,
      hostOperations: harness,
      store: new MemoryStore(),
      repositoryScanner: new StaticScanner(),
      contextPreflight: {
        preflight: async (input) =>
          input.step.id === "provisional-revised-technical-verification"
            ? { status: "failed", reason: "preflight-internal-failure" }
            : readyContextPreflight.preflight(input),
      },
      workflowSearch,
      sourceObligationObserver: sourceObligationObserverFixture,
      repositoryEvidence: new EvidenceCollector(),
      authoringCandidateLifecycle: lifecycle,
      id: () => "run-authoring",
    }).run(request());

    expect(record.status).toBe("failed");
    expect(() => validateAuthoringRunRecordV1(record, workflow)).not.toThrow();
    const rejected = record.steps.find(
      (step) => step.id === "provisional-revised-technical-verification",
    )!;
    expect(rejected.status).toBe("failed");
    expect(rejected.inference).toBeUndefined();
    expect(rejected.authoringPhase).toBeDefined();
    expect(
      harness.calls.filter(
        (input) => input.step.id === "provisional-revised-technical-verification",
      ),
    ).toHaveLength(0);
    expect(record.authoringExecution).toMatchObject({
      selectedCandidate: { ordinal: 1 },
      partialCandidate1: null,
      finalPatch: { candidateOrdinal: 1 },
    });
    expect(lifecycle.calls).toContain("materialize-1");
  });
});

class AuthoringHarness implements AgentHarness, HostOperationExecutor {
  readonly calls: HarnessStepInput[] = [];
  transportFailureAfterRevisionWrite = false;
  revisionWorkspaceCandidate = 0;
  revisionWrites = 0;
  readonly revisionCandidateAtStart: number[] = [];
  private revisionTransportFailureRaised = false;
  constructor(
    private readonly actionable: boolean,
    private readonly failStep?: string,
    private readonly abortController?: AbortController,
    private readonly invalidAccounting = false,
    private readonly coverageStatus: "verified" | "unverified" = "verified",
    private readonly rejectRevisionAccounting = false,
    private readonly editorialCorrectionBridge = false,
    private readonly qualityCandidate?: { summary: string; candidate: object },
    /** Seal this dimension `unverified` in the source-obligation ledger. */
    private readonly unverifiedLedgerDimension?: TechnicalFactDimension,
    /** Quote the cited source's shebang in the ledger and technical facts. */
    private readonly shebangFacts = false,
  ) {}

  async runStep(input: HarnessStepInput) {
    this.calls.push(input);
    if (input.step.id === this.failStep) {
      this.abortController?.abort();
      throw new Error("The bounded revision writer failed.");
    }
    if (input.step.id === "plan-documentation") {
      return {
        summary: "Created a bounded plan.",
        planBinding: plan,
        planResponseSha256: PLAN_RESPONSE_SHA256,
      };
    }
    if (requiresSourceObligationLedger(input)) {
      const proposal = sourceObligationProposalFixture(`${SOURCE}:1`);
      if (this.unverifiedLedgerDimension) {
        const reason = "The bound source does not establish this prerequisite.";
        proposal.dimensions = proposal.dimensions.map((entry) =>
          entry.dimension === this.unverifiedLedgerDimension
            ? { ...entry, status: "unverified", reason, sourceLocators: [] }
            : entry,
        );
        proposal.limitations = [reason];
      }
      if (this.shebangFacts) {
        proposal.dimensions[0]!.reason = SHEBANG_STATEMENT;
      }
      return {
        summary: canonicalizeJsonEvidence(proposal as unknown as JsonEvidenceValue).trimEnd(),
        sourceObligationProposal: proposal,
      };
    }
    if (input.step.skill === "verify-technical-accuracy") {
      const result = technicalResult(
        (this.actionable && !input.step.id.includes("revised")) ||
          (this.editorialCorrectionBridge && input.step.id === "verify-technical-accuracy"),
        this.coverageStatus,
        // The plan's own pages, so a plan of one page is covered as one.
        input.planBinding ? documentationPlanWritePaths(input.planBinding) : undefined,
      );
      if (this.editorialCorrectionBridge && input.step.id === "verify-technical-accuracy") {
        if (!input.step.prompt.includes("EDITORIAL-001")) {
          throw new Error(
            "Fixture canonical correction did not receive admitted editorial evidence.",
          );
        }
        result.review.issues[0]!.finding =
          "The candidate contradicts the source-backed operation order.";
        const fact = result.factInventory.dimensions[0]!.facts[0]!;
        fact.id = "FIXTURE_FACT_1";
        fact.statement = "The candidate contradicts the source-backed operation order.";
        fact.documentationDisposition = "conflicting";
      }
      if (this.shebangFacts) {
        result.factInventory.dimensions[0]!.facts[0]!.statement = SHEBANG_STATEMENT;
      }
      if (requiresTechnicalCorrection(input)) {
        if (!input.sourceObligationLedger) {
          throw new Error("Fixture correction requires a ledger.");
        }
        const correction =
          input.sourceObligationLedger.schemaVersion === 2
            ? await bindHostOwnedTechnicalCorrectionProposalV3(
                {
                  kind: TECHNICAL_CORRECTION_PROPOSAL_KIND,
                  schemaVersion: 3,
                  verdict: result.review.verdict,
                  coverage: result.coverage,
                  factInventory: result.factInventory,
                  issueJudgments: result.review.issues.map((issue) => ({
                    id: issue.id,
                    severity: issue.severity,
                    category: issue.category,
                    location: issue.location,
                    factIds: result.factInventory.dimensions
                      .flatMap((dimension) => dimension.facts)
                      .filter((fact) => fact.issueIds.includes(issue.id))
                      .map((fact) => fact.id),
                  })),
                  obligationAccounting: [],
                },
                input.sourceObligationLedger,
                input.originalSourceAuthorityAdmission ??
                  (() => {
                    throw new Error("Fixture correction requires original source authority.");
                  })(),
                input.runId ?? "",
                result.coverage.map((entry) => entry.path),
              )
            : bindTechnicalCorrectionResponse(
                { verificationResult: result, obligationAccounting: [] },
                input.sourceObligationLedger,
                (value) => value as VerificationResult,
              );
        return {
          summary: json(correction.verificationResult),
          verificationResult: correction.verificationResult,
          technicalCorrectionEvidence: correction.evidence,
        };
      }
      return { summary: json(result), verificationResult: result };
    }
    if (
      input.step.id === "review-documentation" ||
      input.step.id === "review-revised-documentation"
    ) {
      return {
        summary: json(
          this.editorialCorrectionBridge && input.step.id === "review-documentation"
            ? {
                verdict: "needs-revision",
                issues: [
                  {
                    id: "EDITORIAL-001",
                    severity: "major",
                    category: "technical_accuracy",
                    location: TARGET,
                    finding: "The candidate contradicts the source-backed operation order.",
                    evidence: { source_id: "fixture-source", locator: `${SOURCE}:1` },
                    required_change: "State the source-backed operation order.",
                  },
                ],
              }
            : { verdict: "pass", issues: [] },
        ),
      };
    }
    if (input.step.id === "revise-documentation") {
      this.revisionCandidateAtStart.push(this.revisionWorkspaceCandidate);
      if (this.transportFailureAfterRevisionWrite && this.revisionWorkspaceCandidate !== 0) {
        throw new Error("The revision retry did not start from candidate 0.");
      }
      if (this.transportFailureAfterRevisionWrite && !this.revisionTransportFailureRaised) {
        this.revisionTransportFailureRaised = true;
        this.revisionWorkspaceCandidate = 1;
        throw new InferenceStepError(
          "Model request failed: stream terminated",
          "provider-transient",
          true,
          { writeSettlement: "write-executed" },
        );
      }
      if (this.transportFailureAfterRevisionWrite) {
        this.revisionWorkspaceCandidate = 1;
        this.revisionWrites += 1;
      }
      if (this.rejectRevisionAccounting) {
        const revision = input.authoringRevisionInput;
        if (!revision) throw new Error("Fixture revision input is unavailable.");
        const issueIds = [
          ...new Set(revision.actionableFacts.flatMap((fact) => fact.issueIds)),
        ].sort();
        decodeAuthoringRevisionAccounting(
          json({
            issueAccounting: issueIds.map((issueId) => ({
              issueId,
              disposition: "applied",
              reason: "The generic fixture claims an unsupported source locator.",
              sourceLocators: ["src/unrelated.ts:9"],
            })),
            changedPaths: [TARGET],
            unresolvedFacts: [],
          }),
          revision,
        );
      }
      const issueId = input.authoringRevisionInput!.actionableFacts[0]!.issueIds[0]!;
      return {
        summary: "Applied the admitted source-backed correction.",
        authoringRevisionAccounting: {
          issueAccounting: [
            {
              issueId,
              disposition: "applied" as const,
              reason: "The admitted source evidence supports this bounded correction.",
              sourceLocators: [
                input.authoringRevisionInput!.actionableFacts[0]!.sourceLocators[0]!,
              ],
            },
          ],
          changedPaths: this.invalidAccounting ? [] : [TARGET],
          unresolvedFacts: [],
        },
      };
    }
    if (input.step.id === "evaluate-document-quality" && this.qualityCandidate) {
      input.onText?.(this.qualityCandidate.summary);
      return {
        summary: this.qualityCandidate.summary,
        qualityArtifactCandidate: this.qualityCandidate.candidate as never,
        skill: { id: input.step.skill, contentSha256: "f".repeat(64) },
      };
    }
    return { summary: `Completed ${input.step.id}.` };
  }
}

/**
 * The writer returns the tool evidence a confined Pi step reports: every
 * refusal is aggregated into the closed denied-path category, and the
 * harness separately reports how many of them were mutation (edit/write)
 * refusals.
 */
class ToolRefusalAuthoringHarness extends AuthoringHarness {
  constructor(
    private readonly refusals: { deniedReads: number; deniedMutations: number },
    private readonly refusingStep = "write-documentation",
    editorialCorrectionBridge = false,
  ) {
    super(false, undefined, undefined, false, "verified", false, editorialCorrectionBridge);
  }

  override async runStep(input: HarnessStepInput) {
    const result = await super.runStep(input);
    if (input.step.id !== this.refusingStep) return result;
    const { deniedReads, deniedMutations } = this.refusals;
    const denied = deniedReads + deniedMutations;
    return {
      ...result,
      tools: {
        totalCalls: 3 + denied,
        failedCalls: denied,
        byTool: [
          { name: "read", calls: 2 + deniedReads, failures: deniedReads },
          { name: "write", calls: 1 + deniedMutations, failures: deniedMutations },
        ],
        failureCategories: [{ category: "denied-path" as const, count: denied }],
      },
      ...(deniedMutations > 0 ? { mutationBoundaryDenials: deniedMutations } : {}),
    };
  }
}

/**
 * The first writer as a confined Pi step reports it after it held the
 * repository's AGENTS.md, read once, and replied without an edit or write.
 */
class NoChangeAuthoringHarness extends AuthoringHarness {
  constructor() {
    super(false);
  }

  override async runStep(input: HarnessStepInput) {
    const result = await super.runStep(input);
    if (input.step.id !== "write-documentation") return result;
    return {
      ...result,
      summary: "AGENTS.md asks me to confirm its disclaimer first. Do you acknowledge it?",
      repositoryInstructions: ["AGENTS.md"],
      tools: {
        totalCalls: 1,
        failedCalls: 0,
        byTool: [{ name: "read", calls: 1, failures: 0 }],
        failureCategories: [],
        presented: ["edit", "find", "grep", "ls", "read", "write"],
      },
    };
  }
}

function technicalResult(
  actionable: boolean,
  coverageStatus: "verified" | "unverified" = "verified",
  targets: readonly string[] = [TARGET, UNCHANGED_TARGET],
): VerificationResult {
  const result = verificationResultFixture([...targets]);
  if (coverageStatus === "unverified") {
    result.review.verdict = "human-review";
    result.coverage = result.coverage.map((entry) => ({
      ...entry,
      status: "unverified",
      reason: "The approved source span does not establish complete target coverage.",
    }));
    result.factInventory.limitations = [
      "The approved source span does not establish complete target coverage.",
    ];
  }
  if (!actionable) return result;
  result.review.verdict = coverageStatus === "unverified" ? "human-review" : "needs-revision";
  result.review.issues = [
    {
      id: "TECH-001",
      severity: "major",
      category: "technical_accuracy",
      location: TARGET,
      finding: "The source-backed API behavior is omitted from the candidate.",
      evidence: { source_id: "fixture-source", locator: `${SOURCE}:1` },
      required_change: "Document the admitted API behavior.",
    },
  ];
  const fact = result.factInventory.dimensions[0]!.facts[0]!;
  fact.id = "FACT001";
  fact.documentationDisposition = "omitted";
  fact.issueIds = ["TECH-001"];
  return result;
}

function capture(
  ordinal: 0 | 1,
  patchDigit: string,
  snapshotDigit: string,
  planDigest = plan.digest,
  writePaths: readonly string[] = [TARGET, UNCHANGED_TARGET],
): AuthoringCandidateCaptureV1 {
  const change = evidence(patchDigit);
  const candidate = createAuthoringCandidate({
    runId: "run-authoring",
    ordinal,
    originalRevision: REVISION,
    planDigest,
    writePaths: [...writePaths],
    patchDigestSha256: change.patch!.sha256,
    patchBytes: change.patch!.byteLength,
    workspaceSnapshotDigest: snapshotDigit.repeat(64),
  });
  return {
    candidate,
    evidence: change,
    snapshot: {
      schemaVersion: 1,
      kind: "docsfab-authoring-workspace-snapshot",
      entries: [
        {
          path: TARGET,
          kind: "regular",
          mode: 0o100644,
          byteLength: 8,
          sha256: patchDigit.repeat(64),
        },
        {
          path: UNCHANGED_TARGET,
          kind: "regular",
          mode: 0o100644,
          byteLength: 12,
          sha256: "9".repeat(64),
        },
      ],
      totalBytes: 20,
      digest: candidate.workspaceSnapshotDigest,
    },
  } as unknown as AuthoringCandidateCaptureV1;
}

function evidence(digit: string): ChangeEvidence {
  return {
    files: [
      { path: TARGET, status: "modified" },
      { path: UNCHANGED_TARGET, status: "modified" },
    ],
    patch: {
      sha256: digit.repeat(64),
      byteLength: 100,
      lineCount: 4,
      artifactPath: `/tmp/candidate-${digit}.patch`,
      format: "git-diff",
    },
  };
}

function request() {
  return {
    workflow: "create-documentation" as const,
    workspacePath: "/tmp/docsfab-authoring-source",
    repository: { sourcePath: "/tmp/source", requestedRevision: REVISION, revision: REVISION },
    allowWrite: true,
  };
}

function json(value: unknown): string {
  return canonicalizeJsonEvidence(value as JsonEvidenceValue).trimEnd();
}

/** The quality evaluator's first `throttles` attempts end on an HTTP 429. */
class ThrottledQualityHarness extends AuthoringHarness {
  constructor(private throttles: number) {
    super(false, undefined, undefined, false, "verified", false, false, {
      summary: "candidate",
      candidate: { reportMarkdown: "candidate" },
    });
  }

  override async runStep(input: HarnessStepInput) {
    if (input.step.id === "evaluate-document-quality" && this.throttles > 0) {
      this.throttles -= 1;
      this.calls.push(input);
      throw new InferenceStepError(
        "Model request failed: 429 Too Many Requests",
        "throttled",
        true,
        {
          modelTelemetry: {
            schemaVersion: 1,
            finishReason: "error",
            providerLatencyMs: 3,
            providerError: { class: "rate-limit", httpStatus: 429 },
          },
        },
      );
    }
    return super.runStep(input);
  }
}

/** The turn governor refuses this step's next turn at its tool-call ceiling. */
class GovernorStopHarness extends AuthoringHarness {
  constructor(private readonly stopStep: string) {
    super(false);
  }

  override async runStep(input: HarnessStepInput) {
    if (input.step.id === this.stopStep) {
      this.calls.push(input);
      throw new InferenceStepError(
        "Model request failed [context-exhausted; retryable=false]: Provider turn stopped locally: reason=tool-call-limit",
        "context-exhausted",
        false,
        {
          turns: [
            {
              turn: 120,
              toolCalls: 127,
              toolResults: 127,
              maxProviderTurns: 128,
              maxToolCalls: 126,
              compactions: 0,
              maxCompactions: 128,
              configuredContextWindow: 131_072,
              effectiveContextWindow: 131_072,
              configuredMaxOutputTokens: 16_384,
              effectiveMaxOutputTokens: 16_384,
              reservedTokens: 1_024,
              estimatedInputTokens: 34_962,
              availableOutputTokens: 95_086,
              requiredMinimumOutputTokens: 16,
              decision: "stop",
              reason: "tool-call-limit",
              requestDigest: "c".repeat(64),
              evidenceDigest: "e".repeat(64),
            },
          ],
        },
      );
    }
    return super.runStep(input);
  }
}
