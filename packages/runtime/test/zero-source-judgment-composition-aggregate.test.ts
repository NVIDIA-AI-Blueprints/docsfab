// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { testTimeoutMs } from "./helpers/test-timeouts.js";

import { createObservableWorkspaceWithoutRequiredChecks } from "./helpers/observable-workspace.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import { readyContextPreflight, validModelConfig } from "./helpers.js";
import { sourceObligationObserverFixture, verificationFixture } from "./helpers/verification.js";

import type { AgentHarness, HarnessStepInput } from "../src/execution/contracts.js";
import type { BoundModelExecutionProfile } from "../src/model/configuration.js";
import { createModelEvidence } from "../src/model/profile-evidence.js";
import {
  loadInstalledModelCompositionAuthority,
  resolveInstalledExecutableComposition,
  type BoundExecutableComposition,
  type CompositionModelLimits,
} from "../src/model-composition/index.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import {
  CompositionExecutionEvidenceError,
  createCompositionExecutionEvidence,
  parseCompositionExecutionAggregate,
  type CompositionExecutionEvidenceV1,
} from "../src/records/composition-execution.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { runHostZeroSourceJudgment } from "../src/harness/zero-source-judgment.js";
import {
  canonicalSourceObligationProposal,
  decodeSourceObligationResponse,
} from "../src/workflow-execution/source-obligation.js";
import { TECHNICAL_FACT_DIMENSIONS } from "../src/workflow-execution/review-response.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";

/**
 * The host-determined judgment result has a consumer past the harness.
 *
 * Every hosted run is a composition-runtime run: the host dispatcher refuses a
 * workflow with no installed composition, and `cli/run/execution.ts` attaches
 * `compositionExecution` whenever the composition runtime is bound. The terminal
 * seal in `workflow-execution/runner-terminal.ts` then builds
 * `createCompositionExecutionAggregate`, whose `aggregateStep`
 * (`records/composition-execution.ts`) fails `subject-mismatch` for any
 * inference-kind step whose record carries no `model`, or one that is not the
 * sealed composition's `deployment.routeId` / `model.resolvedId`. Steps 4 and 5
 * are `kind: evaluate`.
 *
 * Without model evidence on the short-circuited steps the run fails at the
 * terminal seal with a saved failed run. These cases drive
 * the real `WorkflowRunner` under `compositionExecution` with steps 4 and 5
 * returning exactly what `PiHarness.runStep`'s zero-source branch returns.
 */
describe("zero-source judgment steps under a composition execution aggregate", () => {
  const COMPOSITION_ID = "anthropic-claude-opus-4.7-pi";
  const WORKFLOW_ID = "review-documentation";
  /**
   * One whole eight-step workflow run per case, through the real runner,
   * search coordinator and source-obligation observer. The shared CI-aware
   * helper raises this on a loaded runner and leaves it alone locally.
   */
  const RUN_BUDGET_MS = testTimeoutMs(30_000);
  const RUN_ID = "zero-source-composition-run";
  const SOURCE_PATH = "/private/zero-source-composition";
  const REVISION = "a".repeat(40);
  const TARGET = "docs/requested.md";
  /** The two judgment steps the short circuit answers, in workflow order. */
  const ZERO_SOURCE_STEPS = [
    "provisional-technical-verification",
    "verify-technical-accuracy",
  ] as const;

  /**
   * The bound executable composition for this workflow, and an execution profile
   * derived from it alone.
   *
   * `createCompositionExecutionEvidence` refuses any profile whose `providerId`
   * and `modelId` are not the composition's `deployment.routeId` and
   * `model.resolvedId`, and refuses any effective limit vector that is not the
   * minimum across the host configuration and the three digest-sealed sources.
   * Every number below is therefore derived from the installed composition, so
   * a sealed ceiling moving cannot silently invert this fixture.
   */
  async function compositionRuntime(): Promise<{
    bound: BoundExecutableComposition;
    executionProfile: BoundModelExecutionProfile;
    configuredLimits: CompositionModelLimits;
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
    const maxInputTokens = Math.min(
      sealedMinimum((limits) => limits.maxInputTokens),
      contextWindow,
    );
    const maxOutputTokens = Math.min(
      sealedMinimum((limits) => limits.maxOutputTokens),
      contextWindow,
    );
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
        maxInputTokens,
        maxOutputTokens,
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
    return { bound, executionProfile, configuredLimits, compositionExecution };
  }

  /** A whole directory cited, so no source is admitted. */
  function zeroSourceReply(): string {
    return JSON.stringify({
      completeness: "bounded-not-proven",
      dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => ({
        dimension,
        status: "not-applicable",
        reason: `The changed page establishes no ${dimension} obligation.`,
        sourceLocators: ["docs"],
        obligations: [],
      })),
      limitations: [],
    });
  }

  const workflowSearchFixture = {
    async search(input: Parameters<LocalWorkflowSearchCoordinator["search"]>[0]) {
      const repositoryPath = await mkdtemp(join(tmpdir(), "docsfab-zero-source-search-"));
      try {
        await writeFile(join(repositoryPath, "README.md"), "deterministic search evidence\n");
        return await new LocalWorkflowSearchCoordinator().search({ ...input, repositoryPath });
      } finally {
        await rm(repositoryPath, { recursive: true, force: true });
      }
    },
  };

  /**
   * Run the whole review workflow under `compositionExecution`, with steps 4 and
   * 5 answered exactly as `PiHarness.runStep`'s zero-source branch answers
   * them. `omitModelEvidence` drops `model` from those two results.
   */
  async function reviewRun(
    omitModelEvidence = false,
    failTerminalSave = false,
  ): Promise<{
    record?: RunRecord;
    error?: unknown;
    saved: RunRecord[];
    zeroSourceCalls: string[];
    model: ReturnType<typeof createModelEvidence>;
  }> {
    const { executionProfile, compositionExecution } = await compositionRuntime();
    const model = createModelEvidence(executionProfile);
    const saved: RunRecord[] = [];
    const zeroSourceCalls: string[] = [];
    const store: RunStore = {
      save: async (record) => {
        if (failTerminalSave && record.status === "failed") {
          throw new Error("terminal record store unavailable");
        }
        saved.push(structuredClone(record));
      },
    };
    const usage = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, total: 3, turns: 1 };
    const tools = { totalCalls: 0, failedCalls: 0, byTool: [] };
    const skillEvidence = (id: string) => ({ id, contentSha256: canonicalDigest({ id }) });
    const harness: AgentHarness = {
      // The host-operation step records no model and no inference, so its skill
      // evidence is the only subject the aggregate can bind it by.
      inspectSkill: async ({ step }) => skillEvidence(step.skill),
      runStep: async (input: HarnessStepInput) => {
        const skill = skillEvidence(input.step.skill);
        if (input.step.id === "derive-source-obligations") {
          const sourceObligationProposal = decodeSourceObligationResponse(
            zeroSourceReply(),
            undefined,
            input.evidenceIdentity?.repositoryRevision,
          );
          return {
            summary: canonicalSourceObligationProposal(sourceObligationProposal),
            sourceObligationProposal,
            model,
            skill,
            usage,
            tools,
          };
        }
        if ((ZERO_SOURCE_STEPS as readonly string[]).includes(input.step.id)) {
          const hostZeroSource = await runHostZeroSourceJudgment(input);
          if (hostZeroSource) {
            zeroSourceCalls.push(input.step.id);
            // Exactly the shape `PiHarness.runStep` returns, minus the model
            // evidence when `omitModelEvidence` is set.
            return {
              ...hostZeroSource,
              ...(omitModelEvidence ? {} : { model }),
              skill,
            };
          }
        }
        return {
          summary: `ran ${input.step.skill}`,
          ...(await verificationFixture(input)),
          model,
          skill,
          usage,
        };
      },
    };
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
        repository: {
          sourcePath: SOURCE_PATH,
          requestedRevision: "HEAD",
          revision: REVISION,
        },
        allowWrite: false,
        contextTarget: { sourcePath: TARGET },
        compositionExecution,
      });
      return { record, saved, zeroSourceCalls, model };
    } catch (error) {
      return { error, saved, zeroSourceCalls, model };
    } finally {
      await workspace.dispose();
    }
  }

  it(
    "seals the terminal aggregate for a run whose judgment steps spent no provider turn",
    async () => {
      const { record, zeroSourceCalls, model } = await reviewRun();

      // The short circuit really fired on both judgment steps of this run.
      expect(zeroSourceCalls).toEqual([...ZERO_SOURCE_STEPS]);
      expect(record?.status).toBe("succeeded");
      const aggregate = record?.compositionExecutionAggregate;
      expect(aggregate).toBeDefined();
      expect(parseCompositionExecutionAggregate(aggregate)).toEqual(aggregate);
      expect(aggregate?.steps.map((step) => step.id)).toEqual(
        getWorkflow(WORKFLOW_ID).steps.map((step) => step.id),
      );
      // The two short-circuited steps carry model evidence in the sealed
      // aggregate, like every other inference step and unlike the host operation.
      const byId = new Map(aggregate?.steps.map((step) => [step.id, step]));
      for (const stepId of ZERO_SOURCE_STEPS) {
        expect(byId.get(stepId)?.modelEvidenceSha256).toEqual(expect.any(String));
      }
      expect(byId.get("lint-documentation")?.modelEvidenceSha256).toBeNull();
      for (const stepId of ZERO_SOURCE_STEPS) {
        const stored = record?.steps.find((step) => step.id === stepId);
        expect(stored?.status).toBe("succeeded");
        expect(stored?.model).toEqual(model);
        // The steps spent no provider turn, and the record says so: no usage and
        // no tool activity were measured, because no connection was opened.
        expect(stored?.usage).toBeUndefined();
        expect(stored?.tools).toBeUndefined();
      }
    },
    RUN_BUDGET_MS,
  );

  it(
    "records a classified terminal refusal when judgment steps record no model",
    async () => {
      // The adjacent condition: the identical run, with `model` dropped from the
      // two host-determined results alone.
      const { record, error, saved, zeroSourceCalls } = await reviewRun(true);

      expect(zeroSourceCalls).toEqual([...ZERO_SOURCE_STEPS]);
      expect(error).toBeUndefined();
      // Every step succeeded; the run still failed at the terminal seal, with no
      // aggregate. That failure is the reason the model evidence above is
      // load-bearing, not decorative. The run returns its last stored record,
      // which is terminal and names the seal's coded refusal instead of
      // staying `running`.
      expect(record).toEqual(saved.at(-1));
      expect(saved.at(-1)?.status).toBe("failed");
      expect(saved.at(-1)?.error).toBe("Workflow execution could not be completed.");
      expect(saved.at(-1)?.failure).toEqual({
        class: "contract-shape",
        layer: "workflow",
        code: "subject-mismatch",
      });
      expect(saved.at(-1)?.workflowOutcome).toBeUndefined();
      expect(saved.at(-1)?.compositionExecutionAggregate).toBeUndefined();
      expect(saved.at(-1)?.steps.every((step) => step.status === "succeeded")).toBe(true);
    },
    RUN_BUDGET_MS,
  );

  it(
    "retains the aggregate refusal as cause when the failed terminal record cannot be saved",
    async () => {
      const { record, error, saved } = await reviewRun(true, true);
      expect(record).toBeUndefined();
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Workflow execution could not be completed.");
      expect((error as Error & { cause?: unknown }).cause).toBeInstanceOf(
        CompositionExecutionEvidenceError,
      );
      expect((error as Error & { cause?: { code?: string } }).cause?.code).toBe("subject-mismatch");
      expect(saved.at(-1)?.status).toBe("running");
      expect(saved.at(-1)?.steps.every((step) => step.status === "succeeded")).toBe(true);
      expect(saved.some((item) => item.status === "failed")).toBe(false);
    },
    RUN_BUDGET_MS,
  );
});
