// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { canonicalEvaluatorSummary } from "../src/cli/run/delivery.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { inspectQualityReportFromRun } from "../src/evaluation-report/contracts.js";
import { formatStepRejectionSentence } from "../src/operator/retry-disposition.js";
import { declinedQualityReportNote } from "../src/workflow-execution/quality-correction-round.js";
import { createConfinedToolSet } from "../src/harness/confined-tools.js";
import { PiHarness } from "../src/harness/pi.js";
import { runHostedWorkflow } from "../src/host-invoker/workflow-runner.js";
import { createLiveAgentToolDefinitions } from "../src/live-agent/capabilities.js";
import { LiveWorkflowDelivery } from "../src/live-agent/workflow-delivery.js";
import { runTerminalConversation } from "../src/live-agent/host.js";
import { verifyQualityPack } from "../src/quality-pack/manifest.js";
import { FileRunStore } from "../src/records/file-store.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import { LocalRepositorySecurityScanner } from "../src/security/repository-scanner.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { validModelConfig } from "./helpers.js";
import {
  sourceObligationProposalFixture,
  unverifiedVerificationResultFixture,
} from "./helpers/verification.js";
import { canonicalSourceObligationProposal } from "../src/workflow-execution/source-obligation.js";
import {
  captureGitSnapshot,
  type BaselineObservation,
  createFixtureRepository,
  decodeBaselineManifest,
  hostedReadinessRequest,
  loadBaselineManifest,
  reasoningToolTurn,
  removeFixture,
  runtimeConfig,
  scriptedProvider,
  summarizeBaselineObservations,
  textTurn,
} from "./support/execution-convergence.js";

const exec = promisify(execFile);
const roots: string[] = [];
const observations = new Map<string, BaselineObservation>();

// Every journey here drives real Git fixtures, the real Pi adapter and a real
// structural context compile, so none fits the local default test budget.
vi.setConfig({ testTimeout: 120_000 });

afterEach(async () => {
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  await Promise.all(roots.splice(0).map((root) => removeFixture(root)));
});

afterAll(async () => {
  expect(summarizeBaselineObservations(await loadBaselineManifest(), observations)).toEqual({
    requiredPass: 7,
    knownDefect: 0,
    failed: 0,
  });
});

describe("execution convergence baseline", () => {
  it("loads a closed deterministic manifest tied to the three private-v1 journeys", async () => {
    const manifest = await loadBaselineManifest();
    expect(manifest.scenarios).toHaveLength(7);
    expect(new Set(manifest.scenarios.map((scenario) => scenario.caseRef))).toEqual(
      new Set([
        "mature-change-review",
        "new-product-feature-live-agent",
        "intent-gap-answer-and-resume",
        "#479",
      ]),
    );
    expect(manifest.scenarios.filter((scenario) => scenario.knownDefect)).toEqual([]);
    expect(() => decodeBaselineManifest({ ...manifest, unexpectedPolicy: true })).toThrow(
      "manifest keys are invalid",
    );
    expect(() =>
      decodeBaselineManifest({
        ...manifest,
        scenarios: [...manifest.scenarios, manifest.scenarios[0]],
      }),
    ).toThrow("IDs must be unique");
    const first = manifest.scenarios[0]!;
    expect(() =>
      summarizeBaselineObservations(
        manifest,
        new Map([
          [
            first.id,
            {
              status: first.status,
              source: first.source,
              artifact: "substituted-artifact",
              authority: first.authority,
              retention: first.retention,
              defectSignature: first.knownDefect?.signature,
            },
          ],
        ]),
      ),
    ).toThrow(/expectation-mismatch/u);
    const requiredNegativeBypassed = new Map(
      manifest.scenarios.map((scenario) => [
        scenario.id,
        {
          status: scenario.status,
          source: scenario.source,
          artifact: scenario.artifact,
          authority: scenario.authority,
          retention: scenario.retention,
          defectSignature: scenario.knownDefect?.signature,
        },
      ]),
    );
    requiredNegativeBypassed.set(first.id, {
      ...requiredNegativeBypassed.get(first.id)!,
      status: "insufficient-evidence",
      artifact: "validated-quality-projection",
    });
    expect(() => summarizeBaselineObservations(manifest, requiredNegativeBypassed)).toThrow(
      /direct-cli-read-only-review:expectation-mismatch/u,
    );
    const staleKnownDefectManifest = {
      ...manifest,
      scenarios: manifest.scenarios.map((scenario, index) =>
        index === 0
          ? {
              ...scenario,
              knownDefect: {
                issue: "#999",
                signature: "historical-defect",
                normativeStatus: scenario.status,
              },
            }
          : scenario,
      ),
    };
    const staleKnownDefectObservations = new Map(
      manifest.scenarios.map((scenario) => [
        scenario.id,
        {
          status: scenario.status,
          source: scenario.source,
          artifact: scenario.artifact,
          authority: scenario.authority,
          retention: scenario.retention,
        },
      ]),
    );
    expect(() =>
      summarizeBaselineObservations(staleKnownDefectManifest, staleKnownDefectObservations),
    ).toThrow(/direct-cli-read-only-review:stale-known-defect:#999/u);
  });

  it("runs the headless hosted adapter at an exact clean commit and refuses writes", async () => {
    const fixture = await trackedFixture("documented");
    const before = await captureGitSnapshot(fixture.repository);
    const request = hostedReadinessRequest(fixture);
    const events: unknown[] = [];
    const result = await runHostedWorkflow({
      request,
      credential: null,
      emit: (event) => events.push(event),
    });

    expect(result.record).toMatchObject({
      id: "convergence-readiness",
      workflow: "readiness",
      status: "succeeded",
      repository: { revision: fixture.revision },
      workspace: { disposable: true },
      models: [expect.objectContaining({ provider: "offline-fixture" })],
    });
    expect(result.patch).toBeNull();
    expect(await captureGitSnapshot(fixture.repository)).toEqual(before);
    expect(
      await readFile(join(fixture.stateDirectory, `${result.record.id}.json`), "utf8"),
    ).toContain('"status": "succeeded"');
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "run-status", status: "running" }),
        expect.objectContaining({ type: "run-status", status: "succeeded" }),
      ]),
    );
    const writeRequest = hostedReadinessRequest({ ...fixture, workflow: "site-bootstrap" });
    await expect(
      runHostedWorkflow({ request: writeRequest, credential: null, emit: () => undefined }),
    ).rejects.toThrow("separate operation-specific write grant");
    observe("headless-hosted-review", {
      status: "succeeded-read-only",
      source: "exact-commit-and-tree",
      artifact: "null-patch",
      authority: "read-only",
      retention: "private-hosted-run",
    });
  });

  it("retains direct CLI review evidence while rejecting unavailable validator claims", async () => {
    const fixture = await trackedFixture("documented");
    const before = await captureGitSnapshot(fixture.repository);
    const verificationResult = unverifiedVerificationResultFixture(
      ["README.md", "docs/guide.md"],
      "The frozen fixture contains documentation claims but no implementation source that could verify them.",
    );
    vi.stubGlobal(
      "fetch",
      scriptedProvider([
        textTurn("Deterministic audit evidence."),
        textTurn(canonicalSourceObligationProposal(sourceObligationProposalFixture("README.md:1"))),
        textTurn(
          JSON.stringify({
            verdict: verificationResult.review.verdict,
            coverage: verificationResult.coverage,
            issueJudgments: [],
            obligationJudgments: [],
          }),
        ),
        textTurn(
          JSON.stringify({
            verdict: verificationResult.review.verdict,
            coverage: verificationResult.coverage,
            issueJudgments: [],
            obligationJudgments: [],
          }),
        ),
        textTurn(JSON.stringify({ verdict: "pass", issues: [] })),
        textTurn("Audience evidence is unavailable in this deterministic fixture."),
        textTurn(
          JSON.stringify({
            evaluation: {
              profile: { id: "docsfab-documentation-quality", version: "v0.1" },
              model_version: "documentation-quality-model-v0.2",
              target: {
                scope_type: "documentation-set",
                repository_revision: fixture.revision,
                paths: ["README.md", "docs/guide.md"],
              },
            },
            qualityScore: null,
            reportMarkdown: unavailableQualityReport(fixture.revision),
          }),
        ),
      ]),
    );
    const record = await executeRunRequest(
      {
        workflow: "review-documentation",
        repositoryPath: fixture.repository,
        revision: "HEAD",
        instruction: "Review the committed fixture documentation.",
        allowWrite: false,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      runtimeConfig(fixture.stateDirectory),
      { silent: true },
    );

    // No amount of model correction (no retry budget is configured here, so
    // the one attempt is already final) produced a schema-valid evaluation
    // (`evaluation_id` is absent), so the host declines the quality step's
    // artifact instead of failing the whole review -- the same fail-open
    // shape `hostFillRefusedJudgment` already gives the two ledger judgment
    // steps once their own retry budget is spent.
    expect(record).toMatchObject({
      workflow: "review-documentation",
      status: "succeeded",
      repository: { revision: fixture.revision },
      workspace: { strategy: "tracked-export", disposable: true },
      qualityPack: expect.objectContaining({ id: "docsfab-default", version: "1.0.0" }),
      models: [
        expect.objectContaining({
          provider: validModelConfig.providerId,
          model: validModelConfig.modelId,
        }),
      ],
      changes: { files: [] },
    });
    expect(record?.qualityArtifactValidation).toBeUndefined();
    expect(record?.changes?.patch ?? null).toBeNull();
    // The declined quality step keeps the locked validator's first issue as
    // a closed code and location, even though the step (and the run) now
    // succeeds -- the same code every existing consumer below already read
    // off a failed step.
    const qualityStep = record!.steps.at(-1)!;
    expect(qualityStep.status).toBe("succeeded");
    expect(qualityStep.qualityValidationRejection).toMatchObject({
      validator: "evaluation",
      code: "evaluation-schema-required",
      location: "$.layers",
    });
    expect(qualityStep.qualityValidationRejection!.issueCount).toBeGreaterThan(0);
    expect(formatStepRejectionSentence(qualityStep)).toBe(
      `Rejected by evaluation-schema-required at $.layers (${qualityStep.qualityValidationRejection!.issueCount} quality validator issues).`,
    );
    expect(
      record?.skills.map(({ id, contentSha256, bundleSha256 }) => ({
        id,
        contentSha256,
        bundleSha256,
      })),
    ).toEqual(await expectedInstalledReviewSkills());
    expect(record?.qualityPack).toEqual(await expectedInstalledQualityPack());
    expect(await captureGitSnapshot(fixture.repository)).toEqual(before);
    const declinedSummary = `${unavailableQualityReport(fixture.revision)}\n\n---\n\n${declinedQualityReportNote(1, "evaluation-schema-required")}`;
    const saved = JSON.parse(
      await readFile(join(fixture.stateDirectory, `${record!.id}.json`), "utf8"),
    ) as { steps: Array<{ summary?: string }> };
    expect(saved.steps.at(-1)?.summary).toBe(declinedSummary);
    // A decline is a disclosed, known absence (`projectQualityReportFromRun`
    // recognizes the host's own stem and returns `null` directly), not the
    // unexplained gap `missing-report`/`invalid-report` name: no error, and
    // (per `deliverCliRunResult`, cli/run/delivery.ts) no forced exit code.
    const qualityResult = inspectQualityReportFromRun(record!);
    expect(qualityResult).toEqual({ quality: null });
    expect(record?.error).toBeUndefined();
    // Adjacent condition: a step that is genuinely still `failed`, with a
    // real (non-passed) quality-validation binding but an UNRELATED error
    // message -- not the standard "Quality artifact validation failed: X."
    // shape `canonicalEvaluatorSummary` requires -- still yields no canonical
    // evaluator summary. This is the exact `step.error === ...` clause the
    // function's second branch checks (`cli/run/delivery.ts`); forced back
    // onto a clone, since this scenario itself no longer produces one.
    const unrelatedFailure = structuredClone(record!);
    unrelatedFailure.qualityArtifactValidation = {
      status: "failed",
      failureCode: "evaluation-invalid",
    } as never;
    unrelatedFailure.steps.at(-1)!.status = "failed";
    unrelatedFailure.steps.at(-1)!.error = "Unrelated provider failure";
    expect(canonicalEvaluatorSummary(unrelatedFailure)).toBeNull();
    expect(canonicalEvaluatorSummary(record!)).toBe(declinedSummary);
    // The CLI now exits 0 (successful commands never assign `process.exitCode`
    // at all; it stays `undefined`, per `cli/run/delivery.ts`'s own `if
    // (exitCode !== 0) process.exitCode = exitCode;`): a decline is a
    // disclosed absence, not the "no validated quality report" problem that
    // forces exit 1 today for a genuinely unexplained gap.
    expect(process.exitCode ?? 0).toBe(0);
    expect(
      await readFile(
        join(fixture.stateDirectory, "reports", record!.id, "quality-report.md"),
        "utf8",
      ),
    ).toBe(declinedSummary);
    expect(
      await readFile(join(fixture.stateDirectory, "reports", record!.id, "index.html"), "utf8"),
    ).toContain('href="quality-report.md"');
    observe("direct-cli-read-only-review", {
      status: "declined-quality-step-run-succeeded",
      source: "exact-commit",
      artifact: "retained-report-no-quality-projection",
      authority: "read-only",
      retention: "private-run-and-report",
    });
  });

  it("keeps live workflow output separate from an authorized current-checkout edit", async () => {
    const fixture = await trackedFixture("documented");
    const workflowFixture = await trackedFixture("documented");
    await writeFile(join(fixture.repository, "docs", "staged.md"), "staged user bytes\n");
    await git(fixture.repository, "add", "docs/staged.md");
    await writeFile(join(fixture.repository, "README.md"), "# Fixture package\n\nstaged bytes\n");
    await git(fixture.repository, "add", "README.md");
    await writeFile(
      join(fixture.repository, "README.md"),
      "# Fixture package\n\nstaged bytes\nunstaged bytes\n",
    );
    await writeFile(join(fixture.repository, "docs", "untracked.md"), "untracked user bytes\n");
    const before = await captureGitSnapshot(fixture.repository);
    const beforeUserState = await captureUserState(fixture.repository, [
      "README.md",
      "docs/staged.md",
      "docs/untracked.md",
    ]);
    const capabilities = {
      skills: [],
      qualityPack: { id: "docsfab-default", version: "1.0.0" },
      workflows: [{ name: "review-documentation", title: "Review documentation" }],
    } as never;
    let workflowDetails: unknown;
    let turnComplete = false;
    let turnError: unknown;
    const liveTools = createLiveAgentToolDefinitions({
      capabilities,
      runWorkflow: async () => {
        const result = await runHostedWorkflow({
          request: hostedReadinessRequest(workflowFixture),
          credential: null,
          emit: () => undefined,
        });
        return result.record;
      },
    });
    const confined = await createConfinedToolSet({
      workspacePath: fixture.repository,
      allowWrite: true,
      isWritePathAllowed: (path) => path.startsWith("docs/"),
    });
    const workflowTool = liveTools.find((tool) => tool.name === "docsfab_run_workflow")!;
    const writeTool = confined.definitions.find((tool) => tool.name === "write")!;
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 100 });
    const session = {
      sessionFile: undefined,
      subscribe: () => () => undefined,
      abort: async () => undefined,
      prompt: async () => {
        try {
          const workflow = await workflowTool.execute(
            "workflow-call",
            { workflow: "review-documentation", instruction: "Review the guide." },
            undefined,
            undefined,
            {} as never,
          );
          workflowDetails = workflow.details;
          await writeTool.execute(
            "write-call",
            { path: "docs/direct.md", content: "direct authorized edit\n" },
            undefined,
            undefined,
            {} as never,
          );
        } catch (error) {
          turnError = error;
          throw error;
        } finally {
          turnComplete = true;
        }
      },
    };
    const conversation = runTerminalConversation(session, input, output, {
      environment: { NO_COLOR: "" },
      skillIds: [],
      workflowIds: ["review-documentation"],
    });
    input.write("perform fixture\n");
    // The subject is output separation, not latency: the hosted run compiles a
    // real structural packet first, which exceeds vi.waitFor's default.
    await vi.waitFor(() => expect(turnComplete).toBe(true), { timeout: 60_000 });
    input.write("/exit\n");
    await conversation;
    expect(turnError).toBeUndefined();

    expect(workflowDetails).toMatchObject({
      kind: "docsfab-live-workflow-result",
      workflow: "readiness",
      status: "succeeded",
      persistence: { status: "not-applied" },
    });
    expect(await readFile(join(fixture.repository, "docs", "direct.md"), "utf8")).toBe(
      "direct authorized edit\n",
    );
    const after = await captureGitSnapshot(fixture.repository);
    expect(after.head).toBe(before.head);
    expect(after.tree).toBe(before.tree);
    expect(after.index).toBe(before.index);
    expect(after.worktree).toBe(before.worktree);
    expect(after.untracked["docs/untracked.md"]).toBe(before.untracked["docs/untracked.md"]);
    expect(
      await captureUserState(fixture.repository, [
        "README.md",
        "docs/staged.md",
        "docs/untracked.md",
      ]),
    ).toEqual(beforeUserState);
    observe("live-agent-workflow-and-direct-edit", {
      status: "separate-workflow-and-checkout-results",
      source: "committed-head-plus-user-work",
      artifact: "workflow-null-patch-and-direct-file",
      authority: "operation-specific-write",
      retention: "workflow-result-and-user-work",
    });
  });

  it("applies and replays a bound saved workflow patch while retaining user work", async () => {
    const fixture = await trackedFixture("documented");
    const store = new FileRunStore(fixture.stateDirectory);
    const evidence = await GitPatchEvidenceCollector.create(
      fixture.repository,
      join(fixture.root, "state", "patches"),
    );
    const runner = new WorkflowRunner({
      harness: offlineHarness(),
      store,
      repositoryScanner: new LocalRepositorySecurityScanner(),
      contextPreflight: readyContext,
      repositoryEvidence: evidence,
      hostOperations: {
        runStep: async () => {
          await writeFile(
            join(fixture.repository, "docs", "guide.md"),
            "# Updated fixture guide\n",
          );
          return {
            summary: "Applied the approved fixture site plan.",
            tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
          };
        },
      },
      id: () => "convergence-delivery",
    });
    const record = await runner.run({
      workflow: "site-bootstrap",
      workspacePath: fixture.repository,
      repository: {
        sourcePath: fixture.repository,
        requestedRevision: "HEAD",
        revision: fixture.revision,
      },
      task: {
        kind: "site-bootstrap",
        plan: {
          kind: "ia-plan",
          schemaVersion: 1,
          digest: "a".repeat(64),
          repositoryRevision: fixture.revision,
          repositoryContentDigest: "b".repeat(64),
        },
      },
      allowWrite: true,
    });
    await git(fixture.repository, "checkout", "--", "docs/guide.md");
    await evidence.dispose();
    await writeFile(join(fixture.repository, "README.md"), "# Fixture package\n\nstaged bytes\n");
    await git(fixture.repository, "add", "README.md");
    await writeFile(
      join(fixture.repository, "README.md"),
      "# Fixture package\n\nstaged bytes\nunstaged bytes\n",
    );
    await writeFile(join(fixture.repository, "docs", "user.md"), "untracked user bytes\n");
    const beforeUserState = await captureUserState(fixture.repository, [
      "README.md",
      "docs/user.md",
    ]);
    const delivery = new LiveWorkflowDelivery({
      repositoryPath: fixture.repository,
      stateDirectory: fixture.stateDirectory,
      allowWrite: true,
      confirmPublication: async () => false,
      loadRun: async () => ({
        id: record.id,
        workflow: record.workflow,
        workflowOutcome: "succeeded",
        recordSha256: (await store.getWithDigest(record.id)).sha256,
        sourcePath: record.repository.sourcePath,
        revision: record.repository.revision,
        patch: record.changes!.patch!,
        patchBytes: await readFile(record.changes!.patch!.artifactPath),
        changedFiles: record.changes!.files,
        changedFileCount: record.changes!.files.length,
        taskLineage: null,
      }),
    });

    expect(await delivery.persist(record)).toEqual({ status: "applied" });
    expect(await captureUserState(fixture.repository, ["README.md", "docs/user.md"])).toEqual(
      beforeUserState,
    );
    expect(await delivery.persist(record)).toEqual({ status: "already-applied" });
    expect(await captureUserState(fixture.repository, ["README.md", "docs/user.md"])).toEqual(
      beforeUserState,
    );
    expect(await readFile(join(fixture.repository, "docs", "guide.md"), "utf8")).toBe(
      "# Updated fixture guide\n",
    );
    expect(await readFile(join(fixture.repository, "docs", "user.md"), "utf8")).toBe(
      "untracked user bytes\n",
    );
    const after = await captureGitSnapshot(fixture.repository);
    expect(after.index).not.toBe("");
    expect(after.worktree).not.toBe("");
    observe("authorized-workflow-patch-persistence", {
      status: "applied-then-already-applied",
      source: "bound-revision",
      artifact: "bound-saved-patch",
      authority: "operation-specific-write",
      retention: "private-run-and-patch",
    });
  });

  it("propagates cancellation through the live workflow tool into WorkflowRunner", async () => {
    const fixture = await trackedFixture("documented");
    const controller = new AbortController();
    const tools = createLiveAgentToolDefinitions({
      capabilities: {
        skills: [],
        qualityPack: { id: "docsfab-default", version: "1.0.0" },
        workflows: [{ name: "review-documentation", title: "Review documentation" }],
      } as never,
      runWorkflow: async (_workflow, _instruction, _onProgress, signal) => {
        const runner = new WorkflowRunner({
          harness: {
            inspectSkill: offlineHarness().inspectSkill,
            runStep: async () => {
              await new Promise<void>((resolve) =>
                signal!.addEventListener("abort", () => resolve(), { once: true }),
              );
              throw new Error("Workflow cancelled by user.");
            },
          },
          store: new FileRunStore(fixture.stateDirectory),
          repositoryScanner: new LocalRepositorySecurityScanner(),
          contextPreflight: readyContext,
          id: () => "convergence-cancelled",
        });
        return runner.run({
          signal,
          workflow: "readiness",
          workspacePath: fixture.repository,
          repository: {
            sourcePath: fixture.repository,
            requestedRevision: "HEAD",
            revision: fixture.revision,
          },
          allowWrite: false,
        });
      },
    });
    const tool = tools.find((candidate) => candidate.name === "docsfab_run_workflow")!;
    const pending = tool.execute(
      "cancel-call",
      { workflow: "review-documentation", instruction: "Review the guide." },
      controller.signal,
      undefined,
      {} as never,
    );
    setTimeout(() => controller.abort("PRIVATE fixture reason"), 10);
    const result = await pending;
    expect(result.details).toMatchObject({
      kind: "docsfab-live-workflow-result",
      status: "cancelled",
      workflowStatus: "failed",
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE fixture reason");
    expect(
      await readFile(join(fixture.stateDirectory, "convergence-cancelled.json"), "utf8"),
    ).toContain("Workflow cancelled by user.");
    observe("workflow-cancellation", {
      status: "cancelled-without-private-reason",
      source: "exact-commit",
      artifact: "typed-terminal-result",
      authority: "read-only",
      retention: "private-run",
    });
  });

  it("keeps a real first-pass intent gap as typed needs-input evidence", async () => {
    const fixture = await trackedFixture("intent-gap");
    const before = await captureGitSnapshot(fixture.repository);
    const record = await executeRunRequest(
      {
        workflow: "create-documentation",
        repositoryPath: fixture.repository,
        revision: "HEAD",
        instruction: "Create an About page that states the product purpose.",
        allowWrite: true,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      runtimeConfig(fixture.stateDirectory),
      { silent: true },
    );
    if (!record) throw new Error("expected a persisted needs-input run record");
    expect(record).toMatchObject({
      workflow: "create-documentation",
      status: "needs-input",
      repository: { revision: fixture.revision },
      workspace: { disposable: true },
      steps: [],
      knowledgeContinuationReceipt: expect.objectContaining({
        originalRunId: record.id,
      }),
    });
    expect(await captureGitSnapshot(fixture.repository)).toEqual(before);
    const saved = JSON.parse(
      await readFile(join(fixture.stateDirectory, `${record.id}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(saved).toMatchObject({ id: record.id, status: "needs-input", steps: [] });
    observe("typed-knowledge-stop", {
      status: "needs-input",
      source: "exact-commit",
      artifact: "durable-stop",
      authority: "operation-specific-write-disposable",
      retention: "private-run",
    });
  });

  it("passes reasoning_content through the real Pi adapter without blank or replay errors", async () => {
    const fixture = await trackedFixture("documented");
    vi.stubGlobal(
      "fetch",
      scriptedProvider([
        reasoningToolTurn("first distinct reasoning", "read-1"),
        reasoningToolTurn("second distinct reasoning", "read-2"),
        textTurn("Deterministic fixture review complete."),
      ]),
    );
    const harness = new PiHarness({
      skillCrateDirectory: join(process.cwd(), "skill-crate"),
      model: validModelConfig,
    });
    const workflow = getWorkflow("review-documentation");
    const result = await harness.runStep({
      runId: "convergence-provider-shape",
      repositoryPath: fixture.repository,
      workflow,
      step: workflow.steps[0]!,
      evidenceIdentity: { repositoryRevision: fixture.revision },
    });

    expect(result.summary).toBe("Deterministic fixture review complete.");
    expect(result.executionLease).toMatchObject({
      terminalReason: "completed",
      toolCalls: { requested: 2, executed: 2, succeeded: 2, failed: 0 },
    });
    expect(result.turns).toHaveLength(3);
    expect(result.turns?.[0]?.requestDigest).not.toBe(result.turns?.[1]?.requestDigest);
    observe("provider-reasoning-content", {
      status: "distinct-nonblank-authority",
      source: "exact-commit",
      artifact: "turn-and-lease-evidence",
      authority: "read-only-tool-batches",
      retention: "in-memory-turn-evidence",
    });
  });
});

async function trackedFixture(seed: "documented" | "intent-gap") {
  const fixture = await createFixtureRepository(seed);
  roots.push(fixture.root);
  return fixture;
}

async function git(repository: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd: repository, encoding: "utf8" })).stdout.trim();
}

function observe(id: string, observation: BaselineObservation): void {
  if (observations.has(id)) throw new Error(`duplicate baseline observation: ${id}`);
  observations.set(id, observation);
}

async function captureUserState(repository: string, paths: string[]) {
  return {
    status: await git(repository, "status", "--porcelain=v1", "--", ...paths),
    worktreeObjects: Object.fromEntries(
      await Promise.all(
        paths.map(async (path) => [path, await git(repository, "hash-object", path)]),
      ),
    ),
    indexObjects: Object.fromEntries(
      await Promise.all(
        paths.map(async (path) => {
          try {
            return [path, await git(repository, "rev-parse", `:${path}`)];
          } catch {
            return [path, null];
          }
        }),
      ),
    ),
  };
}

async function expectedInstalledReviewSkills() {
  const workflow = getWorkflow("review-documentation");
  const lock = JSON.parse(
    await readFile(join(process.cwd(), "skill-crate", "lock.json"), "utf8"),
  ) as {
    skills: Array<{ id: string; contentSha256: string; bundleSha256: string }>;
  };
  return [...new Set(workflow.steps.map(({ skill }) => skill))].map((id) => {
    const locked = lock.skills.find((candidate) => candidate.id === id);
    if (!locked) throw new Error(`missing installed skill lock: ${id}`);
    return { id, contentSha256: locked.contentSha256, bundleSha256: locked.bundleSha256 };
  });
}

async function expectedInstalledQualityPack() {
  return verifyQualityPack({
    skillCrateDirectory: join(process.cwd(), "skill-crate"),
    qualityDirectory: join(process.cwd(), "quality"),
    qualityPackDirectory: join(process.cwd(), "quality-pack"),
  });
}

function offlineHarness() {
  return {
    inspectSkill: async ({ step }: { step: { skill: string } }) => ({
      id: step.skill,
      contentSha256: "a".repeat(64),
    }),
    runStep: async ({ step }: { step: { id: string } }) => ({
      summary: `deterministic fixture executed ${step.id}`,
      model: { provider: "offline-fixture", model: "execution-convergence" },
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        turns: 0,
        cost: 0,
      },
      tools: { totalCalls: 0, failedCalls: 0, byTool: [], failureCategories: [] },
    }),
  };
}

const readyContext = {
  preflight: async () => ({
    status: "ready" as const,
    packetDigest: "b".repeat(64),
    consultedNodeIds: [],
    ontologyVersion: "convergence-fixture-v1",
    effectiveDecisionIds: [],
    measurements: { byteLength: 0, estimatedTokens: 0, latencyMs: 0, nodeCount: 0 },
    cache: { disposition: "disabled" as const, rebuildAttempted: false },
    packet: { schemaVersion: 1 as const, digest: "b".repeat(64) },
  }),
};

function unavailableQualityReport(revision: string): string {
  return [
    "# Documentation quality evaluation report",
    "",
    "## Validated result summary",
    "",
    "```json",
    JSON.stringify({
      report_contract: "docsfab-quality-report-v0.1",
      target: {
        paths: ["docs/guide.md"],
        repository_revision: revision,
        documentation_revision: revision,
      },
      profile: { id: "docsfab-documentation-quality", version: "1.0.0" },
      evaluation: { decision: "insufficient-evidence", confidence: 0.4, hard_gate_failures: [] },
      rubric: { status: "unavailable", reason: "Deterministic fixture has no live audience." },
      validation: {
        evaluation: "unavailable",
        quality_score: "unavailable",
        report_binding: "unavailable",
      },
      artifact_locators: {
        evaluation: null,
        quality_score: null,
        quality_report: null,
      },
    }),
    "```",
    "",
    "## Evidence gaps and limitations",
    "",
    "- Limitation: Deterministic fixture evidence is not live model or audience evidence.",
  ].join("\n");
}
