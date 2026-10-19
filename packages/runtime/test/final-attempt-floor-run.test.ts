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

import type {
  AgentHarness,
  HarnessStepInput,
  InferenceRetryPolicy,
} from "../src/execution/contracts.js";
import { parseRetryPolicy } from "../src/config/retry-policy.js";
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
import { isFinalMalformedResponseAttempt } from "../src/workflow-execution/retry.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/**
 * The runner, not the harness, knows when an attempt is the last one:
 * `isFinalMalformedResponseAttempt` reads the same effective policy
 * `executeInferenceStep` applies, so the two cannot disagree.
 */
describe("isFinalMalformedResponseAttempt", () => {
  /** The configured read-only policy, read from config/limits.yaml. */
  const configured = (): InferenceRetryPolicy => {
    const policy = parseRetryPolicy({});
    expect(policy.maxRetriesSource).toBe("config/limits.yaml");
    expect(policy.retryableCategories).toContain("malformed-response");
    return policy;
  };

  it("marks only the attempt after the last malformed-response retry of a read-only step", () => {
    const policy = configured();
    const attempts = Array.from({ length: policy.maxRetries + 1 }, (_, index) => index + 1);

    expect(
      attempts.map((attempt) =>
        isFinalMalformedResponseAttempt({ mode: "read-only", policy }, attempt),
      ),
    ).toEqual([...Array(policy.maxRetries).fill(false), true]);
  });

  it("marks the first attempt final when the operator configured no retry", () => {
    vi.stubEnv("DOCSFAB_READ_ONLY_MAX_RETRIES", "0");
    const policy = parseRetryPolicy(process.env);

    expect(isFinalMalformedResponseAttempt({ mode: "read-only", policy }, 1)).toBe(true);
  });

  it("marks the first attempt final when malformed-response is not a configured retry", () => {
    const policy = {
      ...configured(),
      retryableCategories: configured().retryableCategories.filter(
        (category) => category !== "malformed-response",
      ),
    };

    expect(isFinalMalformedResponseAttempt({ mode: "read-only", policy }, 1)).toBe(true);
  });

  it("reads the write-step replay the loop reads", () => {
    const policy = configured();

    // A write step is never replayed, so its one attempt is final ...
    expect(isFinalMalformedResponseAttempt({ mode: "write", policy }, 1)).toBe(true);
    // ... unless its host resets the workspace before each retry.
    expect(
      isFinalMalformedResponseAttempt({ mode: "write", hostResetsWrites: true, policy }, 1),
    ).toBe(false);
  });
});

/**
 * The whole run. Step 4 runs through the real `PiHarness`, whose scripted
 * provider answers every attempt with a reply the step refuses for its model
 * content (an off-vocabulary issue severity). Attempts 1..N-1 are retried, the
 * final attempt is admitted as the host floor, step 5 runs on it, and the run
 * seals (`records/composition-execution.ts` `aggregateStep` refuses an inference
 * step without model evidence).
 */
describe("a review whose step-4 judgment is refused on every attempt of the configured budget", () => {
  const COMPOSITION_ID = "nvidia-inference-claude-sonnet-5-pi";
  const WORKFLOW_ID = "review-documentation";
  /** One whole eight-step run through the real runner; raised on a loaded CI runner. */
  const RUN_BUDGET_MS = testTimeoutMs(60_000);
  const RUN_ID = "final-attempt-floor-run";
  const SOURCE_PATH = "/private/final-attempt-floor";
  const REVISION = "a".repeat(40);
  const TARGET = "docs/requested.md";
  const FLOORED_STEP = "provisional-technical-verification";

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
      const repositoryPath = await mkdtemp(join(tmpdir(), "docsfab-final-attempt-search-"));
      try {
        await writeFile(join(repositoryPath, "README.md"), "deterministic search evidence\n");
        return await new LocalWorkflowSearchCoordinator().search({ ...input, repositoryPath });
      } finally {
        await rm(repositoryPath, { recursive: true, force: true });
      }
    },
  };

  /** Run the whole review under the configured retry policy, step 4 by the real harness. */
  async function reviewRun(policy: InferenceRetryPolicy): Promise<{
    record?: RunRecord;
    error?: unknown;
    fetches: number;
    model: ReturnType<typeof createModelEvidence>;
  }> {
    const { executionProfile, compositionExecution } = await compositionRuntime();
    const model = createModelEvidence(executionProfile);
    // The fixture ledger has no obligation, so the one model-content defect is
    // the issue judgment's severity, outside the stated vocabulary.
    const refused = JSON.stringify({
      verdict: "needs-revision",
      coverage: [
        {
          path: TARGET,
          status: "verified",
          evidence: ["src/api.ts:42"],
          reason: "Compared the requested page with the admitted source.",
        },
      ],
      issueJudgments: [
        {
          id: "TECH-001",
          severity: "blocker",
          category: "completeness",
          location: `${TARGET}:1`,
          obligationIds: [],
        },
      ],
      obligationJudgments: [],
    });
    const attempts = policy.maxRetries + 1;
    const provider = vi.fn(
      scriptedProvider(
        Array.from({ length: attempts }, () => textTurn(refused, executionProfile.modelId)),
      ),
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
        if (input.step.id === FLOORED_STEP) return realHarness.runStep(input);
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
      retryPolicy: policy,
      retrySleep: async () => {},
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
    "retries attempts 1..N-1, admits the floor on attempt N, runs step 5 and seals the run",
    async () => {
      const policy = parseRetryPolicy({});
      expect(policy.maxRetriesSource).toBe("config/limits.yaml");
      const attempts = policy.maxRetries + 1;

      const { record, error, fetches, model } = await reviewRun(policy);

      expect(error).toBeUndefined();
      // Every attempt of the configured budget reached the provider once.
      expect(fetches).toBe(attempts);
      expect(record?.status).toBe("succeeded");
      const floored = record?.steps.find((step) => step.id === FLOORED_STEP);
      expect(floored?.status).toBe("succeeded");
      expect(floored?.model).toEqual(model);
      expect(floored?.inference?.attempts).toMatchObject([
        ...Array.from({ length: attempts - 1 }, (_, index) => ({
          attempt: index + 1,
          outcome: "malformed-response",
          retryable: true,
          retryScheduled: true,
          retryDecision: "retried",
          rejection: { code: "judgment-severity-invalid", location: "$.issueJudgments[].severity" },
        })),
        { attempt: attempts, outcome: "succeeded", model },
      ]);
      // The runner re-validated the floor and recorded it as the step summary.
      const recorded = JSON.parse(floored?.summary ?? "{}") as {
        review?: { verdict?: string; issues?: unknown[] };
        factInventory?: { limitations?: string[] };
      };
      expect(recorded.review).toEqual({ verdict: "human-review", issues: [] });
      expect(recorded.factInventory?.limitations).toContainEqual(
        `Host judgment completion: the step's own checks refused the ${FLOORED_STEP} judgment reply with no retry left (${attempts} attempts spent, rejection code judgment-severity-invalid), so the host kept none of that reply. ` +
          "The host kept 0 complete obligation judgments and recorded 0 unverified, kept 0 coverage entries and host-filled 1, and kept 0 issue judgments and dropped 0; the verdict is human-review.",
      );
      // Step 5 ran on the floored step-4 result, and so did steps 6-8.
      expect(record?.steps.find((step) => step.id === "verify-technical-accuracy")?.status).toBe(
        "succeeded",
      );
      const aggregate = record?.compositionExecutionAggregate;
      expect(aggregate).toBeDefined();
      expect(parseCompositionExecutionAggregate(aggregate)).toEqual(aggregate);
      expect(aggregate?.steps.map((step) => step.id)).toEqual(
        getWorkflow(WORKFLOW_ID).steps.map((step) => step.id),
      );
      expect(
        aggregate?.steps.find((step) => step.id === FLOORED_STEP)?.modelEvidenceSha256,
      ).toEqual(expect.any(String));
    },
    RUN_BUDGET_MS,
  );
});
