// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { testTimeoutMs } from "./helpers/test-timeouts.js";

import { createObservableWorkspaceWithoutRequiredChecks } from "./helpers/observable-workspace.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import { readyContextPreflight, validModelConfig } from "./helpers.js";
import { sourceObligationObserverFixture, verificationFixture } from "./helpers/verification.js";
import {
  createProviderConnectionFactory,
  PiHarness,
  scriptedProvider,
  skillCrateDirectory,
  textTurn,
} from "./support/pi-harness-session-fixtures.js";

import type { AgentHarness, HarnessStepInput } from "../src/execution/contracts.js";
import type { BoundModelExecutionProfile } from "../src/model/configuration.js";
import { createModelEvidence } from "../src/model/profile-evidence.js";
import {
  loadInstalledModelCompositionAuthority,
  resolveInstalledExecutableComposition,
  type CompositionModelLimits,
} from "../src/model-composition/index.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import {
  createCompositionExecutionEvidence,
  parseCompositionExecutionAggregate,
  type CompositionExecutionEvidenceV1,
} from "../src/records/composition-execution.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A host-completed step result has a consumer past the harness: the terminal
 * seal (`records/composition-execution.ts` `aggregateStep`) fails
 * `subject-mismatch` for an inference step with no `model`, or whose last
 * attempt did not succeed.
 *
 * Drives the real `WorkflowRunner` under `compositionExecution` over the
 * executable composition. Step 4 runs through the real `PiHarness`, cut at the
 * output limit twice, so the runner and seal see exactly what the harness
 * returns. Every other step is a fixture.
 */
describe("a host-completed cut judgment under a composition execution aggregate", () => {
  const COMPOSITION_ID = "nvidia-inference-claude-sonnet-5-pi";
  const WORKFLOW_ID = "review-documentation";
  /** One whole eight-step run through the real runner; raised on a loaded CI runner. */
  const RUN_BUDGET_MS = testTimeoutMs(60_000);
  const RUN_ID = "cut-judgment-composition-run";
  const SOURCE_PATH = "/private/cut-judgment-composition";
  const REVISION = "a".repeat(40);
  const TARGET = "docs/requested.md";
  const CUT_STEP = "provisional-technical-verification";

  /** The executable composition and an execution profile derived from it alone. */
  async function compositionRuntime(): Promise<{
    executionProfile: BoundModelExecutionProfile;
    compositionExecution: CompositionExecutionEvidenceV1;
  }> {
    const { authority } = await loadInstalledModelCompositionAuthority();
    const bound = resolveInstalledExecutableComposition({
      authority,
      compositionId: COMPOSITION_ID,
      workflowId: WORKFLOW_ID,
    });
    const configuredLimits: CompositionModelLimits = { ...bound.composition.compositionLimits };
    const sealedMinimum = (pick: (limits: CompositionModelLimits) => number): number =>
      Math.min(
        pick(configuredLimits),
        pick(bound.candidate.proposedLimits),
        pick(bound.composition.compositionLimits),
        pick(bound.compositionCeiling),
      );
    const contextWindow = sealedMinimum((limits) => limits.contextWindow);
    const transport = bound.composition.deployment.transport;
    const apiFormat = transport === "anthropic-messages" ? "messages" : "chat_completions";
    const executionProfile: BoundModelExecutionProfile = {
      routeId: bound.composition.deployment.routeId,
      providerId: bound.composition.deployment.routeId,
      baseUrl: validModelConfig.baseUrl,
      modelId: bound.composition.model.resolvedId,
      transport,
      apiFormat,
      profile: {
        ...validModelConfig.profile,
        configuredLimits: {
          contextWindow: configuredLimits.contextWindow,
          maxInputTokens: configuredLimits.maxInputTokens,
          maxOutputTokens: configuredLimits.maxOutputTokens,
        },
        contextWindow,
        maxInputTokens: Math.min(
          sealedMinimum((limits) => limits.maxInputTokens),
          contextWindow,
        ),
        maxOutputTokens: Math.min(
          sealedMinimum((limits) => limits.maxOutputTokens),
          contextWindow,
        ),
        compatibility: { ...validModelConfig.profile.compatibility, apiFormats: [apiFormat] },
      },
      requestPolicy: { ...validModelConfig.requestPolicy },
      ...(bound.composition.requestPolicy
        ? { compositionRequestPolicy: { ...bound.composition.requestPolicy } }
        : {}),
      compositionPolicy: {
        maxProviderTurns: sealedMinimum((limits) => limits.maxProviderTurns),
        timeoutMs: sealedMinimum((limits) => limits.timeoutMs),
        maxResponseBytes: sealedMinimum((limits) => limits.maxResponseBytes),
      },
    };
    const compositionExecution = createCompositionExecutionEvidence({
      runId: RUN_ID,
      bound,
      executionProfile,
      configuredLimits,
      workflow: { id: bound.workflow.workflowId, sourceSha256: bound.workflow.sourceSha256 },
      repository: {
        identitySha256: createHash("sha256").update(SOURCE_PATH).digest("hex"),
        revision: REVISION,
      },
    });
    return { executionProfile, compositionExecution };
  }

  const workflowSearchFixture = {
    async search(input: Parameters<LocalWorkflowSearchCoordinator["search"]>[0]) {
      const repositoryPath = await mkdtemp(join(tmpdir(), "docsfab-cut-judgment-search-"));
      try {
        await writeFile(join(repositoryPath, "README.md"), "deterministic search evidence\n");
        return await new LocalWorkflowSearchCoordinator().search({ ...input, repositoryPath });
      } finally {
        await rm(repositoryPath, { recursive: true, force: true });
      }
    },
  };

  /** Run the whole review with step 4 answered by the real harness, cut twice. */
  async function reviewRun(): Promise<{
    record?: RunRecord;
    error?: unknown;
    fetches: number;
    model: ReturnType<typeof createModelEvidence>;
  }> {
    const { executionProfile, compositionExecution } = await compositionRuntime();
    const model = createModelEvidence(executionProfile);
    const outputLimit = executionProfile.profile.maxOutputTokens;
    // The step-4 judgment over the fixture ledger, cut inside its one coverage
    // entry after the first turn and again after the continuation.
    const answer = JSON.stringify({
      verdict: "needs-revision",
      coverage: [
        {
          path: TARGET,
          status: "verified",
          evidence: ["src/api.ts:42"],
          reason: "Compared the requested page with the admitted source.",
        },
      ],
      issueJudgments: [],
      obligationJudgments: [],
    });
    const cutAt = answer.indexOf('"reason"');
    const firstCut = Math.floor(cutAt / 2);
    const cut = (text: string) =>
      textTurn(text, executionProfile.modelId, "length", {
        prompt_tokens: 10,
        completion_tokens: outputLimit,
        total_tokens: 10 + outputLimit,
      });
    const provider = vi.fn(
      scriptedProvider([cut(answer.slice(0, firstCut)), cut(answer.slice(firstCut, cutAt))]),
    );
    vi.stubGlobal("fetch", provider);
    const realHarness = new PiHarness({
      skillCrateDirectory,
      executionProfile,
      credential: { family: "nvidia-inference-api", apiKey: validModelConfig.apiKey },
      providerConnectionFactory: createProviderConnectionFactory({
        routeId: executionProfile.routeId,
        transport: executionProfile.transport,
      }),
    });
    const usage = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, total: 3, turns: 1 };
    const skillEvidence = (id: string) => ({ id, contentSha256: canonicalDigest({ id }) });
    const harness: AgentHarness = {
      inspectSkill: async ({ step }) => skillEvidence(step.skill),
      runStep: async (input: HarnessStepInput) => {
        if (input.step.id === CUT_STEP) return realHarness.runStep(input);
        return {
          summary: `ran ${input.step.skill}`,
          ...(await verificationFixture(input)),
          model,
          skill: skillEvidence(input.step.skill),
          usage,
        };
      },
    };
    const store: RunStore = { save: async () => undefined };
    const runner = new WorkflowRunner({
      harness,
      hostOperations: {
        runStep: async () => ({
          summary: "fixture host operation",
          outcome: "succeeded" as const,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0, cost: 0 },
          tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
        }),
      },
      store,
      repositoryScanner: {
        scan: async () => ({
          ruleSet: "test-v1",
          status: "passed" as const,
          scannedFiles: 2,
          binaryFiles: 0,
          findings: [],
        }),
      },
      contextPreflight: readyContextPreflight,
      repositoryEvidence: {
        capture: async () => ({ files: [{ path: "README.md", status: "modified" as const }] }),
      },
      workflowSearch: workflowSearchFixture,
      sourceObligationObserver: sourceObligationObserverFixture,
    });
    const workspace = await createObservableWorkspaceWithoutRequiredChecks();
    try {
      const record = await runner.run({
        runId: RUN_ID,
        workflow: WORKFLOW_ID,
        workspacePath: workspace.path,
        repository: { sourcePath: SOURCE_PATH, requestedRevision: "HEAD", revision: REVISION },
        allowWrite: false,
        contextTarget: { sourcePath: TARGET },
        compositionExecution,
      });
      return { record, fetches: provider.mock.calls.length, model };
    } catch (error) {
      return { error, fetches: provider.mock.calls.length, model };
    } finally {
      await workspace.dispose();
    }
  }

  it(
    "runs step 5 and seals the run when step 4's answer is cut twice and host-completed",
    async () => {
      const { record, error, fetches, model } = await reviewRun();

      expect(error).toBeUndefined();
      expect(fetches).toBe(2);
      expect(record?.status).toBe("succeeded");
      const cutStep = record?.steps.find((step) => step.id === CUT_STEP);
      expect(cutStep?.status).toBe("succeeded");
      expect(cutStep?.model).toEqual(model);
      expect(cutStep?.inference?.attempts.at(-1)?.outcome).toBe("succeeded");
      const recorded = JSON.parse(cutStep?.summary ?? "{}") as {
        review?: { verdict?: string };
        factInventory?: { limitations?: string[] };
      };
      expect(recorded.review?.verdict).toBe("human-review");
      expect(recorded.factInventory?.limitations).toContainEqual(
        expect.stringContaining("Host judgment completion:"),
      );
      // Step 5 ran on the degraded step-4 result, and so did steps 6-8.
      expect(record?.steps.find((step) => step.id === "verify-technical-accuracy")?.status).toBe(
        "succeeded",
      );
      const aggregate = record?.compositionExecutionAggregate;
      expect(aggregate).toBeDefined();
      expect(parseCompositionExecutionAggregate(aggregate)).toEqual(aggregate);
      expect(aggregate?.steps.map((step) => step.id)).toEqual(
        getWorkflow(WORKFLOW_ID).steps.map((step) => step.id),
      );
      expect(aggregate?.steps.find((step) => step.id === CUT_STEP)?.modelEvidenceSha256).toEqual(
        expect.any(String),
      );
    },
    RUN_BUDGET_MS,
  );
});
