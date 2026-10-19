// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { createObservableWorkspaceWithoutRequiredChecks } from "./helpers/observable-workspace.js";

import { canonicalDigest } from "../src/content-ir/canonical.js";
import {
  decodeSuccessfulPublicationRunRecord as decodePublicationRunRecordStrict,
  PublicationRunRecordDecodeError,
  type PublicationRunRecordDecodeOptionsV1,
} from "../src/delivery/run-record.js";
import { InferenceStepError, type AgentHarness } from "../src/execution/contracts.js";
import type { BoundModelExecutionProfile } from "../src/model/configuration.js";
import { modelProfileEvidenceSha256 } from "../src/model/profile-evidence.js";
import {
  loadInstalledModelCompositionAuthority,
  resolveInstalledExecutableComposition,
  type BoundExecutableComposition,
  type CompositionModelLimits,
} from "../src/model-composition/index.js";
import { governProviderTurn } from "../src/model/turn-governor.js";
import type {
  ModelEvidence,
  ModelProfileEvidence,
  RunRecord,
  SkillEvidence,
} from "../src/records/contracts.js";
import {
  createCompositionExecutionAggregate,
  createCompositionExecutionEvidence,
  parseCompositionExecutionAggregate,
  type CompositionExecutionEvidenceV1,
} from "../src/records/composition-execution.js";
import { decodeNativePilotNemotronRunRecord } from "../src/native-compositions/pilot-runner.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { parseWorkflowManifestSnapshot } from "../src/workflow-registry/manifest.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { LocalAuthoringCandidateLifecycle } from "../src/workflow-execution/authoring-runtime.js";
import { LocalSourceObligationSourceObserver } from "../src/workflow-execution/source-obligation-observer.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import {
  documentationPlanBindingDigest,
  type DocumentationPlanMode,
} from "../src/workflow-execution/plan-binding.js";
import { scriptedEditorialProtocol } from "./helpers/editorial-protocol.js";
import { AuthoringQualityWorkflowOutcomeProjector } from "../src/evaluation-report/authoring-outcome-projector.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { documentationAuditSearch } from "../src/maturity/audit-search-plan.js";
import { documentationObservationSearch } from "../src/search/observation-search-plan.js";
import { sourceObligationObserverFixture, verificationFixture } from "./helpers/verification.js";
import { canonicalizeJsonEvidence } from "../src/json-evidence.js";
import { initFixtureRepo } from "./helpers/git.js";

export interface registerCompositionRunEvidenceScenariosInputs {
  readonly historicalCreateWorkflow?: () => Promise<ReturnType<typeof getWorkflow>>;
}

export function registerCompositionRunEvidenceScenarios(
  inputs: registerCompositionRunEvidenceScenariosInputs,
): void {
  const REVISION = "a".repeat(64);
  const SOURCE_PATH = "/private/composition-source";
  const CONFIGURED_LIMITS: CompositionModelLimits = {
    contextWindow: 100_000,
    maxInputTokens: 90_000,
    maxOutputTokens: 10_000,
    maxProviderTurns: 6,
    timeoutMs: 420_000,
    maxResponseBytes: 100_000,
  };
  const publicationDecodeOptions = new Map<string, PublicationRunRecordDecodeOptionsV1>();
  const workflowSearchFixture = {
    async search(input: Parameters<LocalWorkflowSearchCoordinator["search"]>[0]) {
      const repositoryPath = await mkdtemp(join(tmpdir(), "docsfab-composition-search-"));
      try {
        await mkdir(join(repositoryPath, "src"));
        await writeFile(join(repositoryPath, "README.md"), "deterministic composition evidence\n");
        await writeFile(join(repositoryPath, "src/api.ts"), "export const api = true;\n");
        return await new LocalWorkflowSearchCoordinator().search({ ...input, repositoryPath });
      } finally {
        await rm(repositoryPath, { recursive: true, force: true });
      }
    },
  };

  function decodeSuccessfulPublicationRunRecord(value: unknown): RunRecord {
    const id =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as { id?: unknown }).id
        : undefined;
    return decodePublicationRunRecordStrict(
      value,
      typeof id === "string" ? publicationDecodeOptions.get(id) : undefined,
    );
  }

  describe("composition run and publication evidence", () => {
    it("persists sealed selection evidence from the queued boundary and seals the terminal aggregate", async () => {
      const saved: RunRecord[] = [];
      const record = await compositionRunRecord(saved);

      expect(saved[0]).toMatchObject({
        status: "queued",
        compositionExecution: { releaseEligible: false },
      });
      expect(saved[0]!.compositionExecutionAggregate).toBeUndefined();
      expect(
        saved.every(
          (boundary) =>
            boundary.compositionExecution?.evidenceSha256 ===
            record.compositionExecution?.evidenceSha256,
        ),
      ).toBe(true);
      expect(record.status).toBe("succeeded");
      expect(parseCompositionExecutionAggregate(record.compositionExecutionAggregate)).toEqual(
        record.compositionExecutionAggregate,
      );
      expect(record.compositionExecutionAggregate?.steps.map((step) => step.id)).toEqual([
        "plan-documentation",
        "derive-source-obligations",
        "write-documentation",
        "lint-documentation",
        "verify-technical-accuracy",
        "review-documentation",
        "test-audience-understanding",
        "evaluate-document-quality",
      ]);
      expect(record.compositionExecutionAggregate?.result.patchSha256).toBe("f".repeat(64));
      expect(decodeSuccessfulPublicationRunRecord(record)).toEqual(record);
    });

    it("admits a current create workflow host step and rejects forged host metrics", async () => {
      const record = await compositionRunRecord(
        [],
        undefined,
        undefined,
        "composition-run",
        "create-documentation",
      );
      expect(record.status).toBe("succeeded");
      expect(record.steps).toHaveLength(9);
      expect(record.authoringExecution).toMatchObject({
        selection: { branchId: "retain" },
        selectedCandidate: { ordinal: 0, artifactName: "candidate-0.patch" },
        finalPatch: {
          candidateOrdinal: 0,
          artifactName: "candidate-0.patch",
          baseRevision: record.repository.revision,
          writePaths: ["docs/guide.md"],
        },
      });
      const decoded = decodeNativePilotNemotronRunRecord(
        record,
        getWorkflow("create-documentation"),
      );
      const host = decoded.steps.find((step) => step.kind === "host-operation");
      expect(host).toMatchObject({ kind: "host-operation", status: "succeeded" });
      expect(host?.model).toBeUndefined();
      expect(host?.inference).toBeUndefined();
      expect(host?.usage).toMatchObject({ input: 0, output: 0, total: 0 });
      expect(host?.tools).toMatchObject({ totalCalls: 0, failedCalls: 0 });

      const strictScannerRecord = structuredClone(record);
      strictScannerRecord.securityScan = {
        ruleSet: "docsfab-local-v2",
        status: "passed",
        scannedFiles: 1,
        binaryFiles: 0,
        findings: [],
      };
      strictScannerRecord.securityScanEffectiveDisposition = { status: "passed" };
      delete strictScannerRecord.securityScanAuthorization;
      expect(strictScannerRecord.workflowOutcome).toBeDefined();
      expect(() =>
        decodeNativePilotNemotronRunRecord(
          strictScannerRecord,
          getWorkflow("create-documentation"),
        ),
      ).not.toThrow();

      const forgedStrictDisposition = structuredClone(strictScannerRecord);
      forgedStrictDisposition.securityScanEffectiveDisposition = { status: "authorized" };
      expect(() =>
        decodeNativePilotNemotronRunRecord(
          forgedStrictDisposition,
          getWorkflow("create-documentation"),
        ),
      ).toThrow();

      const forged = structuredClone(record);
      const forgedHost = forged.steps.find((step) => step.kind === "host-operation")!;
      forgedHost.kind = "host-operation";
      forgedHost.usage = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, turns: 1 };
      expect(() =>
        decodeNativePilotNemotronRunRecord(forged, getWorkflow("create-documentation")),
      ).toThrow();
      const relabelled = structuredClone(record);
      relabelled.steps.find((step) => step.kind === "host-operation")!.kind = "inference";
      expect(() =>
        decodeNativePilotNemotronRunRecord(relabelled, getWorkflow("create-documentation")),
      ).toThrow();

      const forgedPhase = structuredClone(record);
      const technicalPhase = forgedPhase.steps.find(
        (step) => step.id === "verify-technical-accuracy",
      );
      (technicalPhase!.authoringPhase as { summarySha256: string }).summarySha256 = "0".repeat(64);
      expect(() =>
        decodeNativePilotNemotronRunRecord(forgedPhase, getWorkflow("create-documentation")),
      ).toThrow();

      const malformedAuthoring = structuredClone(record);
      (malformedAuthoring.authoringExecution as unknown as Record<string, unknown>).selection = {
        branchId: "retain",
      };
      expect(() =>
        decodeNativePilotNemotronRunRecord(malformedAuthoring, getWorkflow("create-documentation")),
      ).toThrow();

      const substitutedWorkflow = structuredClone(getWorkflow("create-documentation"));
      if (substitutedWorkflow.schemaVersion !== 3) throw new Error("Expected CREATE V3 workflow.");
      substitutedWorkflow.authoringSchedule.manifest.title = "Substituted CREATE workflow";
      expect(() => decodeNativePilotNemotronRunRecord(record, substitutedWorkflow)).toThrow();
    });

    it("admits a current create workflow failure after host lint", async () => {
      const record = await compositionRunRecord(
        [],
        undefined,
        undefined,
        "composition-run",
        "create-documentation",
        "verify-technical-accuracy",
      );
      expect(record.status).toBe("failed");
      const decoded = decodeNativePilotNemotronRunRecord(
        record,
        getWorkflow("create-documentation"),
      );
      const host = decoded.steps.find((step) => step.kind === "host-operation");
      expect(host).toMatchObject({ kind: "host-operation", status: "succeeded" });
      expect(host?.usage).toMatchObject({ input: 0, output: 0, total: 0 });
      const forged = structuredClone(record);
      const forgedHost = forged.steps.find((step) => step.kind === "host-operation")!;
      forgedHost.tools = {
        totalCalls: 1,
        failedCalls: 0,
        byTool: [{ name: "lint", calls: 1, failures: 0 }],
      };
      expect(() =>
        decodeNativePilotNemotronRunRecord(forged, getWorkflow("create-documentation")),
      ).toThrow();

      if (inputs.historicalCreateWorkflow) {
        const historicalWorkflow = await inputs.historicalCreateWorkflow();
        expect(() => decodeNativePilotNemotronRunRecord(record, historicalWorkflow)).toThrow();
      }
    });

    it("rejects a repository-mismatched selection before any save or provider turn", async () => {
      const mismatched = structuredClone(await compositionEvidence()) as unknown as Record<
        string,
        unknown
      >;
      (mismatched.repository as Record<string, unknown>).revision = "b".repeat(64);
      reseal(mismatched, "evidenceSha256");
      const saved: RunRecord[] = [];
      let providerCalls = 0;

      await expect(
        compositionRunRecord(
          saved,
          mismatched as unknown as CompositionExecutionEvidenceV1,
          () => (providerCalls += 1),
        ),
      ).rejects.toThrow("subject-mismatch");
      expect(saved).toEqual([]);
      expect(providerCalls).toBe(0);
    });

    it("rejects replaying one selection under another run identity", async () => {
      const evidence = await compositionEvidence();
      let providerCalls = 0;

      await expect(
        compositionRunRecord([], evidence, () => (providerCalls += 1), "another-composition-run"),
      ).rejects.toThrow("subject-mismatch");
      expect(providerCalls).toBe(0);
    });

    it("rejects a missing, reordered, or substituted aggregate step", async () => {
      const record = await compositionRunRecord();

      const missing = structuredClone(record);
      delete missing.compositionExecutionAggregate;
      expectPublicationReject(missing);

      const reordered = mutableRecord(record);
      const aggregate = aggregateBody(reordered);
      aggregate.steps = [...(aggregate.steps as unknown[])].reverse();
      reseal(aggregate, "aggregateSha256");
      expectPublicationReject(reordered);

      const substituted = mutableRecord(record);
      const substitutedAggregate = aggregateBody(substituted);
      const first = (substitutedAggregate.steps as Record<string, unknown>[])[0]!;
      first.id = "another-step";
      reseal(substitutedAggregate, "aggregateSha256");
      expectPublicationReject(substituted);

      const hostEvidence = mutableRecord(record);
      const hostAggregate = aggregateBody(hostEvidence);
      const hostStep = (hostAggregate.steps as Record<string, unknown>[]).find(
        (step) => step.kind === "host-operation",
      )!;
      hostStep.modelEvidenceSha256 = "0".repeat(64);
      reseal(hostAggregate, "aggregateSha256");
      expectPublicationReject(hostEvidence);
    });

    it("rejects patch, result, model, inference, and skill evidence drift", async () => {
      const record = await compositionRunRecord();
      const mutations: Array<(value: RunRecord) => void> = [
        (value) => {
          value.changes!.patch!.sha256 = "0".repeat(64);
        },
        (value) => {
          value.steps[0]!.summary = "A substituted result.";
        },
        (value) => {
          value.steps[0]!.model!.model = "substituted-model";
        },
        (value) => {
          value.steps[0]!.inference!.attempts[0]!.durationMs += 1;
        },
        (value) => {
          value.steps[0]!.skillEvidence!.contentSha256 = "0".repeat(64);
        },
      ];
      for (const mutate of mutations) {
        const changed = structuredClone(record);
        mutate(changed);
        expectPublicationReject(changed);
      }
    });

    it("rejects a re-sealed release claim and self-consistent model substitution", async () => {
      const record = await compositionRunRecord();
      const releaseClaim = mutableRecord(record);
      const evidence = releaseClaim.compositionExecution as unknown as Record<string, unknown>;
      evidence.releaseEligible = true;
      reseal(evidence, "evidenceSha256");
      expectPublicationReject(releaseClaim);

      const substituted = structuredClone(record);
      substituted.steps[0]!.model!.model = "substituted-model";
      expect(() =>
        createCompositionExecutionAggregate({
          compositionExecution: substituted.compositionExecution!,
          run: substituted,
          workflow: getWorkflow("update-documentation"),
        }),
      ).toThrow("subject-mismatch");
    });
  });

  async function compositionRunRecord(
    saved: RunRecord[] = [],
    suppliedEvidence?: CompositionExecutionEvidenceV1,
    onProviderCall?: () => void,
    runId = "composition-run",
    workflowId: "update-documentation" | "create-documentation" = "update-documentation",
    failStep?: string,
  ): Promise<RunRecord> {
    const createFixture = workflowId === "create-documentation" ? await createGitFixture() : null;
    const repositoryRevision = createFixture?.revision ?? REVISION;
    const compositionExecution =
      suppliedEvidence ??
      (await compositionEvidence(workflowId, createFixture?.path, repositoryRevision));
    const model = compositionModelEvidence(compositionExecution);
    let clock = Date.parse("2026-08-23T00:00:00.000Z");
    const fixtureHarness = harness(model, onProviderCall, failStep);
    const hostOperations = {
      runStep: async () => ({
        summary: "fixture host operation",
        outcome: "succeeded" as const,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0, cost: 0 },
        tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
      }),
    };
    const authoringWorkspace = createFixture
      ? await prepareRepositoryWorkspace(createFixture.path, repositoryRevision)
      : null;
    const authoringArtifacts = createFixture
      ? await mkdtemp(join(tmpdir(), "docsfab-composition-artifacts-"))
      : null;
    const authoringCollector =
      authoringWorkspace && authoringArtifacts
        ? await GitPatchEvidenceCollector.create(authoringWorkspace.path, authoringArtifacts)
        : null;
    const sourceObserver = authoringWorkspace
      ? new LocalSourceObligationSourceObserver(authoringWorkspace)
      : null;
    const authoringLifecycle =
      authoringWorkspace && authoringCollector && authoringArtifacts && sourceObserver
        ? new LocalAuthoringCandidateLifecycle({
            workspace: authoringWorkspace,
            evidenceCollector: authoringCollector,
            search: new LocalWorkflowSearchCoordinator(),
            sourceObserver,
            hostOperations,
            artifactDirectory: authoringArtifacts,
          })
        : null;
    const protocol =
      workflowId === "update-documentation"
        ? scriptedEditorialProtocol(fixtureHarness)
        : { harness: fixtureHarness };
    const runner = new WorkflowRunner({
      ...protocol,
      hostOperations,
      store: {
        save: async (record) => {
          saved.push(structuredClone(record));
        },
      },
      repositoryScanner: {
        scan: async () => ({
          ruleSet: "credential-rules-v1",
          status: "passed",
          scannedFiles: 1,
          binaryFiles: 0,
          findings: [],
        }),
      },
      contextPreflight: {
        preflight: async () => ({ status: "unnecessary", reason: "policy-marked-unnecessary" }),
      },
      workflowSearch: workflowSearchFixture,
      sourceObligationObserver: sourceObserver ?? sourceObligationObserverFixture,
      repositoryEvidence: authoringCollector ?? {
        capture: async () => ({
          files: [{ path: "README.md", status: "modified" }],
          patch: {
            sha256: "f".repeat(64),
            byteLength: 42,
            lineCount: 1,
            artifactPath: "/private/state/composition.patch",
            format: "git-diff",
          },
        }),
      },
      impactPostflight: {
        postflight: async () => ({
          schemaVersion: 1,
          status: "completed",
          analysisDigest: "7".repeat(64),
          changedPaths: [workflowId === "create-documentation" ? "docs/guide.md" : "README.md"],
        }),
      },
      ...(workflowId === "update-documentation"
        ? { outcomeProjector: new AuthoringQualityWorkflowOutcomeProjector() }
        : {}),
      ...(authoringLifecycle ? { authoringCandidateLifecycle: authoringLifecycle } : {}),
      id: () => "composition-run",
      now: () => new Date((clock += 100)),
    });
    const disposableWorkspace = authoringWorkspace
      ? null
      : await createObservableWorkspaceWithoutRequiredChecks();
    try {
      const record = await runner.run({
        runId,
        workflow: workflowId,
        workspacePath: authoringWorkspace?.path ?? disposableWorkspace!.path,
        repository: {
          sourcePath: createFixture?.path ?? SOURCE_PATH,
          requestedRevision: repositoryRevision,
          revision: repositoryRevision,
        },
        instruction:
          workflowId === "create-documentation"
            ? "Create a documentation page for this feature."
            : "Polish the documentation with a concrete page-level change.",
        allowWrite: true,
        compositionExecution,
      });
      if ("decodeOptions" in protocol)
        publicationDecodeOptions.set(record.id, protocol.decodeOptions);
      return record;
    } finally {
      await disposableWorkspace?.dispose();
      await authoringCollector?.dispose();
      await authoringWorkspace?.dispose();
      if (authoringArtifacts) await rm(authoringArtifacts, { recursive: true, force: true });
      await createFixture?.dispose();
    }
  }

  async function compositionEvidence(
    workflowId: "update-documentation" | "create-documentation" = "update-documentation",
    sourcePath = SOURCE_PATH,
    revision = REVISION,
  ): Promise<CompositionExecutionEvidenceV1> {
    const { authority } = await loadInstalledModelCompositionAuthority();
    const bound = resolveInstalledExecutableComposition({
      authority,
      compositionId: "anthropic-claude-opus-4.7-pi",
      workflowId,
    });
    return createCompositionExecutionEvidence({
      runId: "composition-run",
      bound,
      executionProfile: executionProfile(bound),
      configuredLimits: CONFIGURED_LIMITS,
      workflow: { id: bound.workflow.workflowId, sourceSha256: bound.workflow.sourceSha256 },
      repository: {
        identitySha256: createHash("sha256").update(sourcePath).digest("hex"),
        revision,
      },
    });
  }

  async function createGitFixture(): Promise<{
    path: string;
    revision: string;
    dispose: () => Promise<void>;
  }> {
    const path = await mkdtemp(join(tmpdir(), "docsfab-composition-create-"));
    try {
      const revision = await initFixtureRepo(
        path,
        {
          "README.md": "composition source repository\n",
          "src/api.ts": "export const api = true;\n",
        },
        { branch: "main", message: "composition source" },
      );
      return {
        path,
        revision,
        dispose: () => rm(path, { recursive: true, force: true }),
      };
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * The effective provider-turn budget: the minimum across the host-configured
   * vector and the three digest-sealed sources, as `deriveEffectiveLimits`
   * (src/records/composition-execution.ts) computes it and as
   * `src/cli/run/composition-runtime.ts` builds the policy in production. Derived,
   * not pinned, so a moved sealed budget does not break every fixture here.
   */
  function effectiveProviderTurns(bound: BoundExecutableComposition): number {
    return Math.min(
      CONFIGURED_LIMITS.maxProviderTurns,
      bound.candidate.proposedLimits.maxProviderTurns,
      bound.composition.compositionLimits.maxProviderTurns,
      bound.compositionCeiling.maxProviderTurns,
    );
  }

  function executionProfile(bound: BoundExecutableComposition): BoundModelExecutionProfile {
    const transport = bound.composition.deployment.transport;
    const apiFormat = transport === "anthropic-messages" ? "messages" : "chat_completions";
    return {
      routeId: bound.composition.deployment.routeId,
      providerId: bound.composition.deployment.routeId,
      baseUrl: "https://api.anthropic.com/v1",
      modelId: bound.composition.model.resolvedId,
      transport,
      apiFormat,
      profile: {
        configuredLimits: {
          contextWindow: CONFIGURED_LIMITS.contextWindow,
          maxInputTokens: CONFIGURED_LIMITS.maxInputTokens,
          maxOutputTokens: CONFIGURED_LIMITS.maxOutputTokens,
        },
        contextWindow: 65_536,
        maxInputTokens: 65_536,
        maxOutputTokens: 8_192,
        effectiveLimitReason: "composition-candidate",
        reasoning: false,
        input: ["text"],
        compatibility: {
          supportsDeveloperRole: true,
          supportsReasoningEffort: false,
          apiFormats: [apiFormat],
        },
        costPerMillionTokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
        metadata: {
          approvedSource: null,
          effectiveDate: null,
          reviewAfter: null,
          status: "unknown",
        },
      },
      requestPolicy: { minimumOutputTokens: 16, reservedContextTokens: 128 },
      compositionPolicy: {
        maxProviderTurns: effectiveProviderTurns(bound),
        timeoutMs: 300_000,
        // The effective limit is the min across configured / candidate /
        // composition / package (records/composition-execution.ts). CONFIGURED_LIMITS
        // is tighter here (100_000) to exercise clamping, so deriving from the
        // composition alone would be as wrong as pinning the literal.
        maxResponseBytes: Math.min(
          CONFIGURED_LIMITS.maxResponseBytes,
          bound.composition.compositionLimits.maxResponseBytes,
        ),
      },
    };
  }

  function compositionModelEvidence(
    evidence: CompositionExecutionEvidenceV1,
  ): ModelEvidence & { profile: ModelProfileEvidence } {
    const provider = evidence.deployment.routeId;
    const model = evidence.model.resolvedId;
    const profile: Omit<ModelProfileEvidence, "sha256"> = {
      schemaVersion: 2,
      status: "unknown",
      configuredContextWindow: evidence.limits.configured.contextWindow,
      effectiveContextWindow: evidence.limits.effective.contextWindow,
      configuredMaxInputTokens: evidence.limits.configured.maxInputTokens,
      effectiveMaxInputTokens: evidence.limits.effective.maxInputTokens,
      configuredMaxOutputTokens: evidence.limits.configured.maxOutputTokens,
      effectiveMaxOutputTokens: evidence.limits.effective.maxOutputTokens,
      effectiveLimitReason: "composition-candidate",
      apiFormat: "chat_completions",
      reasoning: false,
      input: ["text"],
      compatibility: {
        supportsDeveloperRole: true,
        supportsReasoningEffort: false,
        apiFormats: ["chat_completions"],
      },
      requestPolicy: { minimumOutputTokens: 16, reservedContextTokens: 128 },
      costPerMillionTokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
      pricing: "unknown",
    };
    return {
      provider,
      model,
      profile: { ...profile, sha256: modelProfileEvidenceSha256({ provider, model, profile }) },
    };
  }

  function harness(
    model: ModelEvidence & { profile: ModelProfileEvidence },
    onProviderCall?: () => void,
    failStep?: string,
  ): AgentHarness {
    return {
      inspectSkill: async ({ step }) => skill(step.skill),
      runStep: async (input) => {
        onProviderCall?.();
        if (
          input.step.id === "write-documentation" &&
          input.workflow.name === "create-documentation"
        ) {
          await mkdir(join(input.repositoryPath, "docs"), { recursive: true });
          await writeFile(
            join(input.repositoryPath, "docs/guide.md"),
            "# Guide\n\nFixture content.\n",
          );
        }
        const governed = governProviderTurn({
          context: {
            messages: [{ role: "user", content: "Perform governed documentation work." }],
          },
          policy: {
            budget: {
              configuredContextWindow: model.profile.configuredContextWindow,
              effectiveContextWindow: model.profile.effectiveContextWindow,
              configuredMaxInputTokens: model.profile.configuredMaxInputTokens!,
              effectiveMaxInputTokens: model.profile.effectiveMaxInputTokens!,
              configuredMaxOutputTokens: model.profile.configuredMaxOutputTokens,
              effectiveMaxOutputTokens: model.profile.effectiveMaxOutputTokens,
              reservedTokens: model.profile.requestPolicy.reservedContextTokens,
              requiredMinimumOutputTokens: model.profile.requestPolicy.minimumOutputTokens,
            },
            maxProviderTurns: 4,
            maxToolCalls: 12,
            maxCompactions: 8,
            minRecentToolTurns: 1,
          },
          state: { providerTurns: 0, toolCalls: 0, toolResults: 0, compactions: 0 },
          evidenceIdentity: input.evidenceIdentity!,
          pinnedMessageCount: 0,
        });
        const usage = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, total: 3, turns: 1 };
        const tools = { totalCalls: 0, failedCalls: 0, byTool: [] };
        if (input.step.id === failStep) {
          throw new InferenceStepError("fixture terminal failure", "provider-terminal", false, {
            model: structuredClone(model),
            usage,
            tools,
            turns: [governed.evidence],
          });
        }
        return {
          summary:
            input.step.skill === "review-documentation"
              ? canonicalizeJsonEvidence({ issues: [], verdict: "pass" }).trimEnd()
              : "Completed governed documentation work.",
          ...(input.step.id === "plan-documentation"
            ? {
                planBinding: documentationPlanBinding(
                  input.workflow.name === "update-documentation"
                    ? "update"
                    : input.workflow.name === "restructure-documentation"
                      ? "restructure"
                      : "create",
                  input.workflow.name === "create-documentation" ? "docs/guide.md" : "README.md",
                ),
              }
            : {}),
          model: structuredClone(model),
          skill: skill(input.step.skill),
          ...(await verificationFixture(input)),
          usage,
          tools,
          turns: [governed.evidence],
        };
      },
    };
  }

  function documentationPlanBinding(mode: DocumentationPlanMode, pagePath = "README.md") {
    const pages = [{ path: pagePath, disposition: mode }];
    const sourceBindings = [
      { pagePath, sources: [mode === "create" ? "src/api.ts:1" : "README.md"] },
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

  function skill(id: string): SkillEvidence {
    return {
      id,
      contentSha256: canonicalDigest({ id }),
      bundleSha256: canonicalDigest({ bundle: id }),
      version: "1.0.0",
      license: "Apache-2.0",
      source: { repository: "skill-catalog", revision: REVISION, path: `skills/${id}/SKILL.md` },
      toolPolicy: { declared: [], granted: [], withheld: [] },
    };
  }

  function mutableRecord(value: RunRecord): Record<string, unknown> {
    return structuredClone(value) as unknown as Record<string, unknown>;
  }

  function aggregateBody(value: Record<string, unknown>): Record<string, unknown> {
    return value.compositionExecutionAggregate as Record<string, unknown>;
  }

  function reseal(value: Record<string, unknown>, digestKey: string): void {
    const body = { ...value };
    delete body[digestKey];
    value[digestKey] = canonicalDigest(body);
  }

  function expectPublicationReject(value: unknown): void {
    expect(() => decodeSuccessfulPublicationRunRecord(value)).toThrow(
      PublicationRunRecordDecodeError,
    );
  }
}
