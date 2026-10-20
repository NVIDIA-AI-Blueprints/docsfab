// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalizeJsonEvidence } from "../src/json-evidence.js";
import type { AgentHarness, HarnessStepInput } from "../src/execution/contracts.js";
import type { ChangeEvidence } from "../src/impact/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import type {
  RepositoryEvidenceCollector,
  RepositoryEvidenceContext,
} from "../src/repository/contracts.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import type { RepositorySecurityScanner } from "../src/security/contracts.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { AuthoringQualityWorkflowOutcomeProjector } from "../src/evaluation-report/authoring-outcome-projector.js";
import { bindDocumentationPlanProposal } from "../src/workflow-execution/plan-binding.js";
import { createAuthoringCandidate } from "../src/workflow-execution/authoring-candidate.js";
import type { AuthoringCandidateCaptureV1 } from "../src/workflow-execution/authoring-workspace-host.js";
import type {
  AuthoringCandidateLifecycleV1,
  AuthoringRevisionSessionV1,
} from "../src/workflow-execution/authoring-runtime.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { LocalSourceObligationSourceObserver } from "../src/workflow-execution/source-obligation-observer.js";
import { buildRunResultV1 } from "../src/operator/run-result.js";
import type { WorkflowName } from "../src/workflow-contracts/contracts.js";
import { readyContextPreflight } from "./helpers.js";
import { scriptedEditorialProtocol } from "./helpers/editorial-protocol.js";
import { verificationFixture, verificationResultFixture } from "./helpers/verification.js";
import { initFixtureRepo } from "./helpers/git.js";

const REVISION = "a".repeat(40);
const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/authoring-audience");
const workflows = ["create-documentation", "update-documentation"] as const;

type AuthoringWorkflow = (typeof workflows)[number];
type AudienceFixture = {
  evidence_status: "direct-outcome-evidence" | "insufficient-evidence" | "unknown";
  reason?: string;
  target?: { repository_revision: string; documentation_revision: string };
};

class MemoryStore implements RunStore {
  public records: RunRecord[] = [];

  public async save(record: RunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

const passedScanner: RepositorySecurityScanner = {
  scan: async () => ({
    ruleSet: "test-v1",
    status: "passed",
    scannedFiles: 1,
    binaryFiles: 0,
    findings: [],
  }),
};

class CandidateEvidence implements RepositoryEvidenceCollector {
  public constructor(private readonly workflow: AuthoringWorkflow) {}

  public async capture(_context: RepositoryEvidenceContext): Promise<ChangeEvidence> {
    return {
      files: [
        {
          path: "docs/candidate.md",
          status: this.workflow === "create-documentation" ? "added" : "modified",
        },
      ],
      patch: {
        sha256: "b".repeat(64),
        byteLength: 24,
        lineCount: 1,
        artifactPath: ".docsfab/patches/authoring-audience.patch",
        format: "git-diff",
      },
    };
  }
}

class CreateCandidateLifecycle implements AuthoringCandidateLifecycleV1 {
  private candidate0?: AuthoringCandidateCaptureV1;

  public async plannedTargetCollisions(): Promise<readonly []> {
    return [];
  }

  public async sealCandidate0(
    input: Parameters<AuthoringCandidateLifecycleV1["sealCandidate0"]>[0],
  ): Promise<AuthoringCandidateCaptureV1> {
    const evidence = await new CandidateEvidence("create-documentation").capture({} as never);
    const candidate = createAuthoringCandidate({
      runId: input.runId,
      ordinal: 0,
      originalRevision: input.repository.revision,
      planDigest: input.planDigest,
      writePaths: input.writePaths,
      patchDigestSha256: evidence.patch!.sha256,
      patchBytes: evidence.patch!.byteLength,
      workspaceSnapshotDigest: "d".repeat(64),
    });
    this.candidate0 = {
      candidate,
      evidence,
      snapshot: {
        schemaVersion: 1,
        kind: "docsfab-authoring-workspace-snapshot",
        entries: input.writePaths.map((path) => ({
          path,
          kind: "regular" as const,
          mode: 0o100644,
          byteLength: 24,
          sha256: "e".repeat(64),
        })),
        totalBytes: input.writePaths.length * 24,
        digest: candidate.workspaceSnapshotDigest,
      },
    } as unknown as AuthoringCandidateCaptureV1;
    return this.candidate0;
  }

  public async materializeSelected(): Promise<ChangeEvidence> {
    if (!this.candidate0) throw new Error("CREATE candidate zero was not sealed.");
    return this.candidate0.evidence;
  }

  public async prepareRevision(): Promise<AuthoringRevisionSessionV1> {
    throw new Error("The audience fixture does not select the revision branch.");
  }

  public async sealCandidate1(): Promise<AuthoringCandidateCaptureV1> {
    throw new Error("The audience fixture does not create candidate one.");
  }

  public async captureFailedPartial(): Promise<never> {
    throw new Error("The audience fixture does not capture a revision partial.");
  }

  public async observeRevisionChangedPaths(): Promise<never> {
    throw new Error("The audience fixture does not observe a revision workspace.");
  }

  public async resetRevision(): Promise<never> {
    throw new Error("The audience fixture does not reset a revision workspace.");
  }

  public async dispose(): Promise<void> {}
}

class AudienceHarness implements AgentHarness {
  public readonly calls: HarnessStepInput[] = [];

  public constructor(
    private readonly workflow: AuthoringWorkflow,
    private readonly audience: AudienceFixture,
    private readonly failAudience = false,
    private readonly failEvaluator = false,
  ) {}

  public async runStep(input: HarnessStepInput) {
    this.calls.push(input);
    if (input.step.id === "test-audience-understanding" && this.failAudience) {
      throw new Error("audience-provider-failed");
    }
    if (input.step.id === "evaluate-document-quality" && this.failEvaluator) {
      throw new Error("late-evaluator-failed");
    }
    if (input.step.id === "plan-documentation") {
      const mode = this.workflow === "create-documentation" ? "create" : "update";
      return {
        summary: "plan summary",
        planBinding: bindDocumentationPlanProposal({
          mode,
          pages: [{ path: "docs/candidate.md", disposition: mode }],
          sourceBindings: [
            { pagePath: "docs/candidate.md", sources: ["src/product-contract.ts:1"] },
          ],
        }),
        skill: skill(input),
      };
    }
    if (this.workflow === "create-documentation") {
      const verification = await verificationFixture(input);
      if (Object.keys(verification).length > 0) {
        return { summary: `${input.step.id} fixture`, ...verification, skill: skill(input) };
      }
      if (input.step.id === "review-documentation") {
        return {
          summary: canonicalizeJsonEvidence({ issues: [], verdict: "pass" }).trimEnd(),
          skill: skill(input),
        };
      }
    }
    if (input.step.id === "derive-source-obligations") {
      return {
        summary: "derived source obligations",
        ...(await verificationFixture(input)),
        skill: skill(input),
      };
    }
    if (input.step.id === "test-audience-understanding") {
      return { summary: JSON.stringify(this.audience), skill: skill(input) };
    }
    if (input.step.id === "verify-technical-accuracy") {
      const paths = input.planBinding?.pages.map((page) => page.path) ?? ["docs/candidate.md"];
      const verificationResult = verificationResultFixture(paths);
      verificationResult.review = {
        verdict: this.failEvaluator ? "needs-revision" : "pass",
        issues: this.failEvaluator
          ? [
              {
                id: "TECH-001",
                severity: "major",
                category: "technical_accuracy",
                location: `${paths[0]}:1`,
                finding: "The candidate claim needs source verification.",
                evidence: { source_id: "fixture-source", locator: `${paths[0]}:1` },
                required_change: "Align the claim with the declared source binding.",
              },
            ]
          : [],
      };
      return {
        summary: "verified candidate documentation claims",
        verificationResult,
        skill: skill(input),
      };
    }
    if (input.step.id === "evaluate-document-quality") {
      return {
        summary: JSON.stringify({
          status: "pass",
          step_evidence: {
            audience_understanding: this.audience,
            rubric_score: {
              status: "available",
              total: 84,
              threshold: 80,
              interpretation_band: "Green",
              decision: "pass",
            },
          },
        }),
        skill: skill(input),
      };
    }
    return { summary: `${input.step.id} summary`, skill: skill(input) };
  }
}

const hostChecks = {
  runStep: async () => ({
    summary: JSON.stringify({ status: "passed", coverage: "fixture", checks: [] }),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0, cost: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [], failureCategories: [] },
  }),
};

function skill(input: HarnessStepInput) {
  return { id: input.step.skill, contentSha256: "c".repeat(64) };
}

async function fixture(name: string): Promise<AudienceFixture> {
  return JSON.parse(
    await readFile(resolve(fixtureRoot, `${name}.json`), "utf8"),
  ) as AudienceFixture;
}

async function run(
  workflow: AuthoringWorkflow,
  audience: AudienceFixture,
  failAudience = false,
  failEvaluator = false,
) {
  const harness = new AudienceHarness(workflow, audience, failAudience, failEvaluator);
  const protocol =
    workflow === "update-documentation" ? scriptedEditorialProtocol(harness) : { harness };
  const sourceRoot = await mkdtemp(join(tmpdir(), "docsfab-authoring-audience-source-"));
  let activeSourceWorkspace: Awaited<ReturnType<typeof prepareRepositoryWorkspace>> | undefined;
  try {
    await initFixtureRepo(
      sourceRoot,
      { "src/product-contract.ts": "export const documentedBehavior = true;\n" },
      { branch: "main", message: "audience source fixture" },
    );
    activeSourceWorkspace = await prepareRepositoryWorkspace(sourceRoot, "HEAD");
    if (!activeSourceWorkspace)
      throw new Error("authoring audience source workspace was not prepared");
    const record = await new WorkflowRunner({
      ...protocol,
      store: new MemoryStore(),
      repositoryScanner: passedScanner,
      hostOperations: hostChecks,
      contextPreflight: readyContextPreflight,
      repositoryEvidence: new CandidateEvidence(workflow),
      workflowSearch: new LocalWorkflowSearchCoordinator(),
      sourceObligationObserver: new LocalSourceObligationSourceObserver(activeSourceWorkspace),
      ...(workflow === "create-documentation"
        ? { authoringCandidateLifecycle: new CreateCandidateLifecycle() }
        : {}),
      outcomeProjector: new AuthoringQualityWorkflowOutcomeProjector(),
      id: () => `audience-${workflow}`,
      now: () => new Date("2026-09-13T14:00:00.000Z"),
    }).run({
      workflow: workflow as WorkflowName,
      workspacePath: activeSourceWorkspace.path,
      repository: {
        sourcePath: "/tmp/source",
        requestedRevision: "HEAD",
        revision: REVISION,
      },
      instruction: "Author the approved candidate for the declared audience.",
      allowWrite: true,
    });
    return { harness, record };
  } finally {
    await activeSourceWorkspace?.dispose();
    await rm(sourceRoot, { recursive: true, force: true });
  }
}

describe("authoring audience evidence", () => {
  it("retains verification findings in the public result when a later evaluator fails", async () => {
    const { record } = await run("update-documentation", await fixture("available"), false, true);
    const result = buildRunResultV1({
      record,
      recordPath: "/tmp/run.json",
      exitCode: 1,
      repositoryPath: "/tmp/repository",
    });
    expect(record.status).toBe("failed");
    expect(result.product.disposition).toBeNull();
    expect(result.reviewFindings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "TECH-001" })]),
    );
  });
  it.each(workflows)(
    "passes available audience evidence through the actual %s runner",
    async (workflow) => {
      const audience = await fixture("available");
      const { harness, record } = await run(workflow, audience);
      const audienceCall = harness.calls.find(
        (call) => call.step.id === "test-audience-understanding",
      )!;
      const evaluatorCall = harness.calls.find(
        (call) => call.step.id === "evaluate-document-quality",
      )!;

      expect(record.status, record.error).toBe("succeeded");
      expect(record.workflowOutcome).toMatchObject({
        disposition: "inconclusive",
        limitations: ["experimental-quality-profile", "insufficient-evidence"],
      });
      expect(audienceCall.step.kind).toBe("evaluate");
      expect(audienceCall.step.mode).toBe("read-only");
      expect(audienceCall.evidenceIdentity?.repositoryRevision).toBe(REVISION);
      expect(audienceCall.contextPacket).toBeDefined();
      expect(audienceCall.step.prompt).toContain("Earlier independent results");
      if (workflow === "update-documentation") {
        expect(audienceCall.step.prompt).toContain("review-documentation summary");
      }
      const audienceProducerIds =
        workflow === "create-documentation"
          ? ["lint-documentation", "verify-technical-accuracy", "review-documentation"]
          : ["review-documentation"];
      expect(consumedSummaries(audienceCall)).toEqual(
        audienceProducerIds.map((stepId) => ({
          stepId,
          summary: record.steps.find((step) => step.id === stepId)!.summary!,
        })),
      );
      expect(audienceCall.sealedEvidence).toEqual(
        workflow === "update-documentation"
          ? [expect.objectContaining({ stepId: "review-documentation" })]
          : undefined,
      );
      expect(
        consumedSummaries(evaluatorCall).find(
          (item) => item.stepId === "test-audience-understanding",
        ),
      ).toEqual({ stepId: "test-audience-understanding", summary: JSON.stringify(audience) });
      for (const stepId of [
        "lint-documentation",
        "verify-technical-accuracy",
        "review-documentation",
        "test-audience-understanding",
      ]) {
        expect(evaluatorCall.step.prompt).toContain(`\"stepId\":\"${stepId}\"`);
      }
      expect(evaluatorCall.sealedEvidence).toEqual(
        workflow === "update-documentation"
          ? [
              expect.objectContaining({ stepId: "plan-documentation" }),
              expect.objectContaining({ stepId: "lint-documentation" }),
              expect.objectContaining({ stepId: "verify-technical-accuracy" }),
              expect.objectContaining({ stepId: "review-documentation" }),
              expect.objectContaining({ stepId: "test-audience-understanding" }),
            ]
          : [expect.objectContaining({ stepId: "verify-technical-accuracy" })],
      );
    },
  );

  it.each(workflows)(
    "keeps a schema-valid but semantically invalid audience artifact insufficient for %s",
    async (workflow) => {
      const audience = await fixture("semantically-invalid");
      const { harness, record } = await run(workflow, audience);
      const evaluatorCall = harness.calls.find(
        (call) => call.step.id === "evaluate-document-quality",
      )!;

      expect(record.status).toBe("succeeded");
      expect(consumedSummaries(evaluatorCall)).toContainEqual({
        stepId: "test-audience-understanding",
        summary: JSON.stringify(audience),
      });
      expect(record.workflowOutcome).toMatchObject({
        disposition: "inconclusive",
        limitations: ["experimental-quality-profile", "insufficient-evidence"],
      });
    },
  );

  it.each(["missing-prerequisites", "invalid-evidence", "revision-mismatch"] as const)(
    "retains %s as insufficient evidence in evaluator and operator outcomes",
    async (name) => {
      const audience = await fixture(name);
      const { harness, record } = await run("create-documentation", audience);
      const evaluatorCall = harness.calls.find(
        (call) => call.step.id === "evaluate-document-quality",
      )!;

      expect(record.status).toBe("succeeded");
      if (name === "revision-mismatch") {
        expect(audience.target?.repository_revision).toBe(REVISION);
        expect(audience.target?.documentation_revision).toBe("candidate-documentation-v2");
      }
      expect(
        consumedSummaries(evaluatorCall).find(
          (item) => item.stepId === "test-audience-understanding",
        ),
      ).toEqual({ stepId: "test-audience-understanding", summary: JSON.stringify(audience) });
      expect(record.steps.find((step) => step.id === "test-audience-understanding")?.summary).toBe(
        JSON.stringify(audience),
      );
      expect(record.workflowOutcome).toMatchObject({
        disposition: "inconclusive",
        limitations: ["experimental-quality-profile", "insufficient-evidence"],
      });
    },
  );

  it.each(workflows)(
    "preserves hard-failure precedence when %s audience execution fails",
    async (workflow) => {
      const { harness, record } = await run(workflow, await fixture("available"), true);

      expect(record.status).toBe("failed");
      expect(record.error).toBe("audience-provider-failed");
      expect(record.steps.find((step) => step.id === "test-audience-understanding")).toMatchObject({
        status: "failed",
        error: "audience-provider-failed",
      });
      expect(record.steps.find((step) => step.id === "evaluate-document-quality")?.status).toBe(
        "pending",
      );
      expect(record.workflowOutcome).toBeUndefined();
      expect(harness.calls.some((call) => call.step.id === "evaluate-document-quality")).toBe(
        false,
      );
    },
  );
});

function consumedSummaries(call: HarnessStepInput): Array<{ stepId: string; summary: string }> {
  const payload = call.step.prompt.split("\n").at(-1);
  if (!payload) throw new Error("Evaluator prompt has no consumed-summary payload.");
  return JSON.parse(payload) as Array<{ stepId: string; summary: string }>;
}
