// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { createLocalWorkflowApplicationServices } from "../src/application/dependencies.js";
import { withLocalPreservationSourceWorkspace } from "../src/cli/run/execution.js";

import {
  prepareRepositoryWorkspace,
  withRepositoryWorkspace,
} from "../src/repository/workspace/materialize.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import type {
  AgentHarness,
  HarnessStepInput,
  HarnessStepResult,
} from "../src/execution/contracts.js";
import { isPreservationSourceObservationSeedV1, type RunRecord } from "../src/records/contracts.js";
import { buildDocsFabStepPrompt } from "../src/harness/pi-session.js";
import { createPreservationSourceToolDefinition } from "../src/harness/source-tools.js";
import { createConfinedToolSet } from "../src/harness/confined-tools.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { documentationPlanBindingDigest } from "../src/workflow-execution/plan-binding.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { verificationFixture } from "./helpers/verification.js";
import { readyContextPreflight } from "./helpers.js";
import {
  EXPERIMENTAL_PRESERVATION_OBSERVATION_REUSE_ENV,
  experimentalPreservationObservationReuseEnabled,
} from "../src/host-invoker/workflow-runner.js";
import {
  LocalSourceObligationSourceObserver,
  listPreservationSources,
  revokePreservationSourceReader,
} from "../src/workflow-execution/source-obligation-observer.js";
import {
  createPreservationSourceObservationCache,
  formatSeededPreservationSourceObservations,
  preservationSourceObservationCacheDelta,
  preservationSourceObservationCacheStats,
  readPreservationSourceObservation,
  seedPreservationSourceObservations,
} from "../src/workflow-execution/preservation-source-observation-cache.js";
import { readPreservationSourceRange } from "../src/workflow-execution/source-obligation-observer.js";
import { commitFixture, initFixtureRepo } from "./helpers/git.js";

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "docsfab-observation-reuse-"));
  const source = join(root, "source");
  const original =
    "Opening paragraph: keep the meaning intact.\n" +
    "Independent discovery must find this second fact: navigation labels stay stable.\n" +
    "Closing paragraph: preserve the final caveat.\n";
  await mkdir(join(source, "docs"), { recursive: true });
  await writeFile(join(source, "docs", "guide.md"), original);
  await writeFile(join(source, "docs", "candidate.md"), "candidate before review\n");
  await initFixtureRepo(source, undefined, { branch: "main" });
  await commitFixture(source, "observation reuse fixture");
  const workspace = await prepareRepositoryWorkspace(source, "HEAD");
  const observer = new LocalSourceObligationSourceObserver(workspace);
  const workflow = getWorkflow("restructure-documentation");
  const sealed = await observer.captureOriginalSourceAuthority({
    runId: "observation-reuse-run",
    workflow,
    repositoryRevision: workspace.revision,
    scopeSha256: "a".repeat(64),
    workspaceSnapshotSha256: "b".repeat(64),
  });
  return { root, source, original, workspace, observer, workflow, sealed };
}

describe("independent preservation-source observation reuse", () => {
  it("is independently disabled unless explicitly enabled", () => {
    expect(experimentalPreservationObservationReuseEnabled({})).toBe(false);
    expect(
      experimentalPreservationObservationReuseEnabled({
        [EXPERIMENTAL_PRESERVATION_OBSERVATION_REUSE_ENV]: "0",
      }),
    ).toBe(false);
    expect(
      experimentalPreservationObservationReuseEnabled({
        [EXPERIMENTAL_PRESERVATION_OBSERVATION_REUSE_ENV]: "1",
      }),
    ).toBe(true);
    expect(() =>
      experimentalPreservationObservationReuseEnabled({
        [EXPERIMENTAL_PRESERVATION_OBSERVATION_REUSE_ENV]: "yes",
      }),
    ).toThrow(/must be 0 or 1/u);
  });

  it("transfers the runner-owned cache from its verifier tool to the fresh audience step", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-observation-runner-"));
    const source = join(root, "source");
    const original =
      "Opening fact for first verifier.\n" +
      "Independent audience discovery finds: navigation labels stay stable.\n";
    await mkdir(join(source, "docs"), { recursive: true });
    await writeFile(join(source, "docs", "guide.md"), original);
    await initFixtureRepo(source, undefined, { branch: "main" });
    await commitFixture(source, "runner observation fixture");
    vi.stubEnv("DOCSFAB_EXPERIMENTAL_STAGE_SPECIFIC_PRESERVATION_BASE", "1");
    vi.stubEnv("DOCSFAB_EXPERIMENTAL_PRESERVATION_OBSERVATION_REUSE", "1");
    try {
      await withRepositoryWorkspace(source, "HEAD", async (workspace) => {
        let sourceExportPath = "";
        await withLocalPreservationSourceWorkspace(
          workspace,
          "restructure-documentation",
          async (preservationSourceWorkspace, preservationDeliveryPolicy) => {
            expect(preservationSourceWorkspace?.path).not.toBe(workspace.path);
            sourceExportPath = preservationSourceWorkspace!.path;
            const workflow = getWorkflow("restructure-documentation");
            const captured: HarnessStepInput[] = [];
            let retainedRecord: RunRecord | undefined;
            let earlierPassage = "";
            let audiencePassage = "";
            const harness: AgentHarness = {
              async runStep(input): Promise<HarnessStepResult> {
                captured.push(input);
                if (input.step.id === "write-documentation") {
                  const confined = await createConfinedToolSet({
                    workspacePath: input.repositoryPath,
                    allowWrite: true,
                    allowedWritePaths: ["docs/guide.md"],
                  });
                  const writeTool = confined.definitions.find(
                    (definition) => definition.name === "write",
                  )!;
                  await writeTool.execute(
                    "candidate-write",
                    { path: "docs/guide.md", content: "Updated candidate page.\n" },
                    undefined,
                    undefined,
                    undefined as never,
                  );
                }
                if (input.step.id === "verify-technical-accuracy") {
                  const confined = await createConfinedToolSet({
                    workspacePath: input.repositoryPath,
                    allowWrite: false,
                    preservationSourceReader: input.preservationSourceReader,
                    preservationSourceObservationCache: input.preservationSourceObservationCache,
                  });
                  const tool = confined.definitions.find(
                    (definition) => definition.name === "docsfab_read_preservation_source",
                  )!;
                  const sourceId = listPreservationSources(input.preservationSourceReader!)[0]!
                    .sourceId;
                  const toolResult = await tool.execute(
                    "verify-read",
                    { sourceId, fromByte: 0, maxBytes: 31 },
                    undefined,
                    undefined,
                    undefined as never,
                  );
                  earlierPassage = JSON.parse(
                    toolResult.content.find((item) => item.type === "text")!.text,
                  ).text;
                }
                if (input.step.id === "test-audience-understanding") {
                  expect(input.preservationSourceObservationCache).toBe(
                    captured.find((call) => call.step.id === "verify-technical-accuracy")
                      ?.preservationSourceObservationCache,
                  );
                  const prompt = buildDocsFabStepPrompt(input);
                  expect(prompt).toContain(earlierPassage);
                  expect(prompt).toContain('"discoveryComplete":false');
                  const confined = await createConfinedToolSet({
                    workspacePath: input.repositoryPath,
                    allowWrite: false,
                    preservationSourceReader: input.preservationSourceReader,
                    preservationSourceObservationCache: input.preservationSourceObservationCache,
                  });
                  const tool = confined.definitions.find(
                    (definition) => definition.name === "docsfab_read_preservation_source",
                  )!;
                  const reference = listPreservationSources(input.preservationSourceReader!).find(
                    (entry) => entry.path === "docs/guide.md",
                  )!;
                  const missingOffset = Buffer.byteLength(
                    original.slice(0, original.indexOf("Independent")),
                  );
                  const toolResult = await tool.execute(
                    "audience-followup-read",
                    {
                      sourceId: reference.sourceId,
                      fromByte: missingOffset,
                      maxBytes: Buffer.byteLength(original) - missingOffset,
                    },
                    undefined,
                    undefined,
                    undefined as never,
                  );
                  audiencePassage = JSON.parse(
                    toolResult.content.find((item) => item.type === "text")!.text,
                  ).text;
                }
                const planPages = [{ path: "docs/guide.md", disposition: "move" as const }];
                const sourceBindings = [{ pagePath: "docs/guide.md", sources: ["docs/guide.md"] }];
                const planBinding = {
                  kind: "docsfab-documentation-plan" as const,
                  schemaVersion: 1 as const,
                  mode: "restructure" as const,
                  pages: planPages,
                  sourceBindings,
                  digest: documentationPlanBindingDigest({
                    mode: "restructure",
                    pages: planPages,
                    sourceBindings,
                  }),
                };
                return {
                  summary: `ran ${input.step.skill}`,
                  ...(await verificationFixture(input)),
                  ...(input.step.id === "plan-documentation" ? { planBinding } : {}),
                  ...(input.step.mode === "read-only" && input.step.kind === "evaluate"
                    ? { editorialAssessmentProposal: { stepId: input.step.id } }
                    : {}),
                  model: { provider: "hosted", model: "test-model" },
                  skill: { id: input.step.skill, contentSha256: "a".repeat(64) },
                  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, turns: 1 },
                };
              },
            };
            const { services } = await createLocalWorkflowApplicationServices({
              config: {
                stateDirectory: join(root, "runs"),
                skillCrateDirectory: resolve("skill-crate"),
                qualityDirectory: resolve("quality"),
                qualityPackDirectory: resolve("quality-pack"),
              },
              request: { workflow: "restructure-documentation" },
              workflow,
              workspace,
              preservationSourceWorkspace,
              preservationDeliveryPolicy,
              repositoryEvidence: { capture: async () => ({ files: [] }) },
              baseHarness: harness,
              hostOperations: {
                runStep: async (input) => ({ summary: `host check passed for ${input.step.id}` }),
              },
            } as never);
            const runnerOptions = {
              ...services,
              harness,
              store: {
                save: async (record) => {
                  retainedRecord = structuredClone(record);
                },
              },
              repositoryScanner: {
                scan: async () => ({
                  ruleSet: "test-v1",
                  status: "passed",
                  scannedFiles: 2,
                  binaryFiles: 0,
                  findings: [],
                }),
              },
              contextPreflight: readyContextPreflight,
              repositoryEvidence: { capture: async () => ({ files: [] }) },
              workflowSearch: new LocalWorkflowSearchCoordinator(),
              hostOperations: {
                runStep: async (input) => ({ summary: `host check passed for ${input.step.id}` }),
              },
              id: () => "observation-runner-test",
            };
            const runRequest = {
              workflow: "restructure-documentation",
              workspacePath: workspace.path,
              repository: {
                sourcePath: workspace.sourcePath,
                requestedRevision: workspace.requestedRevision,
                revision: workspace.revision,
              },
              allowWrite: true,
              instruction: "Keep key information in the reorganized guide.",
            } as const;
            await new WorkflowRunner(runnerOptions).run(runRequest);
            const verifier = captured.find((call) => call.step.id === "verify-technical-accuracy");
            const audience = captured.find(
              (call) => call.step.id === "test-audience-understanding",
            );
            expect(verifier?.preservationSourceReader).toBeDefined();
            expect(audience?.preservationSourceReader).toBeDefined();
            expect(
              retainedRecord?.steps.find((entry) => entry.id === "test-audience-understanding")
                ?.preservationSourceObservationSeed,
            ).toMatchObject({
              schemaVersion: 1,
              outcome: "succeeded",
              counters: { seededRanges: 1, refusals: 0 },
            });
            expect(audiencePassage).toContain("navigation labels stay stable");
            expect(
              await readFile(join(preservationSourceWorkspace!.path, "docs", "guide.md"), "utf8"),
            ).toBe(original);

            // A seed refusal occurs before Pi gets an audience attempt. The
            // outer runner still saves that failed step's content-free counters.
            const observer = services.sourceObligationObserver!;
            const failureObserver = Object.create(observer) as typeof observer;
            failureObserver.createPreservationSourceReader = (input) => {
              const reader = observer.createPreservationSourceReader(input);
              if (input.stepId === "test-audience-understanding")
                revokePreservationSourceReader(reader);
              return reader;
            };
            let failedRecord: RunRecord | undefined;
            const priorAudienceCalls = captured.filter(
              (call) => call.step.id === "test-audience-understanding",
            ).length;
            const failedRun = await new WorkflowRunner({
              ...runnerOptions,
              sourceObligationObserver: failureObserver,
              store: {
                save: async (record) => {
                  failedRecord = structuredClone(record);
                },
              },
              id: () => "observation-seed-refusal-test",
            }).run(runRequest);
            expect(failedRun.status).toBe("failed");
            const failedAudience = failedRecord?.steps.find(
              (entry) => entry.id === "test-audience-understanding",
            );
            expect(failedAudience?.status).toBe("failed");
            expect(failedAudience?.inference).toBeUndefined();
            expect(failedAudience?.preservationSourceObservationSeed).toMatchObject({
              schemaVersion: 1,
              outcome: "failed",
              counters: { seededRanges: 0, refusals: 1 },
            });
            expect(
              isPreservationSourceObservationSeedV1(
                failedAudience?.preservationSourceObservationSeed,
              ),
            ).toBe(true);
            expect(
              isPreservationSourceObservationSeedV1({
                ...failedAudience?.preservationSourceObservationSeed,
                rawText: original,
              }),
            ).toBe(false);
            expect(
              captured.filter((call) => call.step.id === "test-audience-understanding"),
            ).toHaveLength(priorAudienceCalls);
          },
        );
        await expect(
          readFile(join(sourceExportPath, "docs", "guide.md"), "utf8"),
        ).rejects.toThrow();
        let failedExportPath = "";
        await expect(
          withLocalPreservationSourceWorkspace(
            workspace,
            "restructure-documentation",
            async (sourceWorkspace) => {
              failedExportPath = sourceWorkspace!.path;
              throw new Error("injected execution failure");
            },
          ),
        ).rejects.toThrow("injected execution failure");
        await expect(
          readFile(join(failedExportPath, "docs", "guide.md"), "utf8"),
        ).rejects.toThrow();
        expect(await readFile(join(source, "docs", "guide.md"), "utf8")).toBe(original);
      });
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("seeds exact previously read ranges into a fresh step and keeps missing facts discoverable", async () => {
    const fixture = await createFixture();
    const cache = createPreservationSourceObservationCache();
    try {
      const earlierReader = fixture.observer.createPreservationSourceReader({
        runId: "observation-reuse-run",
        stepId: "verify-technical-accuracy",
        repositoryRevision: fixture.workspace.revision,
        capture: fixture.sealed.capture,
        authority: fixture.sealed.evidence,
        authorizedPaths: ["docs/guide.md"],
      });
      const [earlierReference] = listPreservationSources(earlierReader);
      const firstRead = await readPreservationSourceObservation({
        cache,
        reader: earlierReader,
        sourceId: earlierReference!.sourceId,
        fromByte: 0,
        maxBytes: 20,
      });
      const deliberatelyIncompleteAssessment = "No relevant preservation fact was found.";
      let authorizedRangeReadOperations = 1;
      expect(firstRead.text).toBe(fixture.original.slice(0, 20));
      expect(firstRead.nextFromByte).not.toBeNull();

      const audienceReader = fixture.observer.createPreservationSourceReader({
        runId: "observation-reuse-run",
        stepId: "test-audience-understanding",
        repositoryRevision: fixture.workspace.revision,
        capture: fixture.sealed.capture,
        authority: fixture.sealed.evidence,
        authorizedPaths: ["docs/guide.md"],
      });
      const beforeSeed = preservationSourceObservationCacheStats(cache);
      const seeded = await seedPreservationSourceObservations({ cache, reader: audienceReader });
      expect(
        preservationSourceObservationCacheDelta(
          beforeSeed,
          preservationSourceObservationCacheStats(cache),
        ),
      ).toMatchObject({ seededRanges: 1, refusals: 0 });
      authorizedRangeReadOperations += 1;
      expect(seeded).toHaveLength(1);
      expect(seeded[0]).toMatchObject({
        sourceId: earlierReference!.sourceId,
        fromByte: 0,
        endByte: 20,
        sourceByteLength: Buffer.byteLength(fixture.original),
        discoveryComplete: false,
        observedInStepId: "verify-technical-accuracy",
      });
      expect(formatSeededPreservationSourceObservations(seeded)).toContain(
        "do not inherit an earlier assessment",
      );
      expect(formatSeededPreservationSourceObservations(seeded)).toContain(
        '"discoveryComplete":false',
      );
      expect(formatSeededPreservationSourceObservations(seeded)).not.toContain(
        deliberatelyIncompleteAssessment,
      );
      const audiencePrompt = buildDocsFabStepPrompt({
        workflow: fixture.workflow,
        step: fixture.workflow.steps.find((step) => step.id === "test-audience-understanding")!,
        repositoryPath: fixture.workspace.path,
        preservationSourceReader: audienceReader,
        preservationSourceObservationEvidence: formatSeededPreservationSourceObservations(seeded),
      } as HarnessStepInput);
      expect(audiencePrompt).toContain("Previously observed exact original passages");
      expect(audiencePrompt).toContain('"discoveryComplete":false');
      expect(audiencePrompt).toContain("Exact original-source references");
      expect(audiencePrompt).toContain("continue discovering and reading");

      const readTool = createPreservationSourceToolDefinition(audienceReader, cache);
      const toolResult = await readTool.execute(
        "audience-read",
        {
          sourceId: earlierReference!.sourceId,
          fromByte: 0,
          maxBytes: 20,
        },
        undefined,
        undefined,
        undefined as never,
      );
      authorizedRangeReadOperations += 1;
      expect(toolResult.content.find((item) => item.type === "text")?.text).toContain(
        "Opening paragraph",
      );

      const missingFactOffset = Buffer.byteLength(
        fixture.original.slice(0, fixture.original.indexOf("Independent")),
      );
      const newlyDiscovered = await readPreservationSourceRange({
        reader: audienceReader,
        sourceId: earlierReference!.sourceId,
        fromByte: missingFactOffset,
        maxBytes: Buffer.byteLength(fixture.original) - missingFactOffset,
      });
      authorizedRangeReadOperations += 1;
      expect(newlyDiscovered.text).toContain("navigation labels stay stable");
      const cacheStats = preservationSourceObservationCacheStats(cache);
      expect(cacheStats).toMatchObject({
        misses: 1,
        hits: 1,
        seededRanges: 1,
      });
      // benchmarks/ is intentionally absent from the public runtime export.
      // Keep the synthetic receipt's fixture and metrics independently asserted
      // here so this behavior test runs in both repository and exported trees.
      expect(createHash("sha256").update(fixture.original).digest("hex")).toBe(
        "a86064034a5373ce96a585d8d4423a0c8758a6eaaf9aa0e97b98f48d3283a008",
      );
      expect(Buffer.byteLength(fixture.original)).toBe(171);
      expect(Buffer.byteLength(firstRead.text)).toBe(20);
      expect(cacheStats).toEqual({
        hits: 1,
        misses: 1,
        seededRanges: 1,
        invalidations: {
          "authority-change": 0,
          "source-change": 0,
          "snapshot-change": 0,
        },
        missReasons: { "range-mismatch": 0 },
        refusals: 0,
      });
      expect(authorizedRangeReadOperations).toBe(4);
    } finally {
      await fixture.workspace.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("reauthorizes every reuse and refuses revoked or stale source access", async () => {
    const fixture = await createFixture();
    const cache = createPreservationSourceObservationCache();
    try {
      const firstReader = fixture.observer.createPreservationSourceReader({
        runId: "observation-reuse-run",
        stepId: "verify-technical-accuracy",
        repositoryRevision: fixture.workspace.revision,
        capture: fixture.sealed.capture,
        authority: fixture.sealed.evidence,
        authorizedPaths: ["docs/guide.md"],
      });
      const [reference] = listPreservationSources(firstReader);
      await readPreservationSourceObservation({
        cache,
        reader: firstReader,
        sourceId: reference!.sourceId,
        fromByte: 0,
        maxBytes: 20,
      });

      const unauthorizedReader = fixture.observer.createPreservationSourceReader({
        runId: "observation-reuse-run",
        stepId: "test-audience-understanding",
        repositoryRevision: fixture.workspace.revision,
        capture: fixture.sealed.capture,
        authority: fixture.sealed.evidence,
        authorizedPaths: ["docs/candidate.md"],
      });
      await expect(
        seedPreservationSourceObservations({ cache, reader: unauthorizedReader }),
      ).resolves.toEqual([]);
      await expect(
        readPreservationSourceObservation({
          cache,
          reader: unauthorizedReader,
          sourceId: reference!.sourceId,
          fromByte: 0,
          maxBytes: 20,
        }),
      ).rejects.toThrow(/unavailable to this step/u);

      const otherRun = await fixture.observer.captureOriginalSourceAuthority({
        runId: "another-observation-reuse-run",
        workflow: fixture.workflow,
        repositoryRevision: fixture.workspace.revision,
        scopeSha256: "e".repeat(64),
        workspaceSnapshotSha256: "f".repeat(64),
      });
      const otherRunReader = fixture.observer.createPreservationSourceReader({
        runId: "another-observation-reuse-run",
        stepId: "test-audience-understanding",
        repositoryRevision: fixture.workspace.revision,
        capture: otherRun.capture,
        authority: otherRun.evidence,
        authorizedPaths: ["docs/guide.md"],
      });
      await expect(
        readPreservationSourceObservation({
          cache,
          reader: otherRunReader,
          sourceId: reference!.sourceId,
          fromByte: 0,
          maxBytes: 20,
        }),
      ).rejects.toThrow(/unavailable to this step/u);

      const staleReader = fixture.observer.createPreservationSourceReader({
        runId: "observation-reuse-run",
        stepId: "test-audience-understanding",
        repositoryRevision: fixture.workspace.revision,
        capture: fixture.sealed.capture,
        authority: fixture.sealed.evidence,
        authorizedPaths: ["docs/guide.md"],
      });
      revokePreservationSourceReader(staleReader);
      const beforeRefusal = preservationSourceObservationCacheStats(cache);
      await expect(
        seedPreservationSourceObservations({ cache, reader: staleReader }),
      ).rejects.toThrow(/stale or invalid/u);
      expect(
        preservationSourceObservationCacheDelta(
          beforeRefusal,
          preservationSourceObservationCacheStats(cache),
        ),
      ).toMatchObject({ seededRanges: 0, refusals: 1 });
      expect(preservationSourceObservationCacheStats(cache).refusals).toBeGreaterThan(0);
    } finally {
      await fixture.workspace.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("seeds a repeated EOF span once even when distinct requests return the same bytes", async () => {
    const fixture = await createFixture();
    const cache = createPreservationSourceObservationCache();
    try {
      const firstReader = fixture.observer.createPreservationSourceReader({
        runId: "observation-reuse-run",
        stepId: "verify-technical-accuracy",
        repositoryRevision: fixture.workspace.revision,
        capture: fixture.sealed.capture,
        authority: fixture.sealed.evidence,
        authorizedPaths: ["docs/guide.md"],
      });
      const [reference] = listPreservationSources(firstReader);
      const fromByte = Buffer.byteLength(fixture.original) - 8;
      const first = await readPreservationSourceObservation({
        cache,
        reader: firstReader,
        sourceId: reference!.sourceId,
        fromByte,
        maxBytes: 16,
      });
      const second = await readPreservationSourceObservation({
        cache,
        reader: firstReader,
        sourceId: reference!.sourceId,
        fromByte,
        maxBytes: 64,
      });
      expect(second).toEqual(first);

      const audienceReader = fixture.observer.createPreservationSourceReader({
        runId: "observation-reuse-run",
        stepId: "test-audience-understanding",
        repositoryRevision: fixture.workspace.revision,
        capture: fixture.sealed.capture,
        authority: fixture.sealed.evidence,
        authorizedPaths: ["docs/guide.md"],
      });
      const seeded = await seedPreservationSourceObservations({ cache, reader: audienceReader });
      expect(seeded).toHaveLength(1);
      expect(seeded[0]).toMatchObject({ fromByte, endByte: Buffer.byteLength(fixture.original) });
    } finally {
      await fixture.workspace.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("invalidates authority changes and leaves a cached original valid after candidate edits", async () => {
    const fixture = await createFixture();
    const cache = createPreservationSourceObservationCache();
    try {
      const firstReader = fixture.observer.createPreservationSourceReader({
        runId: "observation-reuse-run",
        stepId: "verify-technical-accuracy",
        repositoryRevision: fixture.workspace.revision,
        capture: fixture.sealed.capture,
        authority: fixture.sealed.evidence,
        authorizedPaths: ["docs/guide.md"],
      });
      const [reference] = listPreservationSources(firstReader);
      const first = await readPreservationSourceObservation({
        cache,
        reader: firstReader,
        sourceId: reference!.sourceId,
        fromByte: 0,
        maxBytes: 20,
      });
      await writeFile(join(fixture.workspace.path, "docs", "candidate.md"), "candidate edited\n");

      const sameAuthorityReader = fixture.observer.createPreservationSourceReader({
        runId: "observation-reuse-run",
        stepId: "test-audience-understanding",
        repositoryRevision: fixture.workspace.revision,
        capture: fixture.sealed.capture,
        authority: fixture.sealed.evidence,
        authorizedPaths: ["docs/guide.md"],
      });
      const reused = await readPreservationSourceObservation({
        cache,
        reader: sameAuthorityReader,
        sourceId: reference!.sourceId,
        fromByte: 0,
        maxBytes: 20,
      });
      expect(reused).toEqual(first);
      await readPreservationSourceObservation({
        cache,
        reader: sameAuthorityReader,
        sourceId: reference!.sourceId,
        fromByte: 0,
        maxBytes: 24,
      });
      expect(preservationSourceObservationCacheStats(cache).missReasons["range-mismatch"]).toBe(1);

      await writeFile(join(fixture.workspace.path, "docs", "guide.md"), "tampered source\n");
      await expect(
        readPreservationSourceObservation({
          cache,
          reader: sameAuthorityReader,
          sourceId: reference!.sourceId,
          fromByte: 0,
          maxBytes: 20,
        }),
      ).rejects.toThrow(/source|read failed|changed after the source authority/u);
    } finally {
      await fixture.workspace.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("invalidates a prior range when the host authority digest changes", async () => {
    const fixture = await createFixture();
    const cache = createPreservationSourceObservationCache();
    try {
      const firstReader = fixture.observer.createPreservationSourceReader({
        runId: "observation-reuse-run",
        stepId: "verify-technical-accuracy",
        repositoryRevision: fixture.workspace.revision,
        capture: fixture.sealed.capture,
        authority: fixture.sealed.evidence,
        authorizedPaths: ["docs/guide.md"],
      });
      const [firstReference] = listPreservationSources(firstReader);
      await readPreservationSourceObservation({
        cache,
        reader: firstReader,
        sourceId: firstReference!.sourceId,
        fromByte: 0,
        maxBytes: 20,
      });

      const changedAuthority = await fixture.observer.captureOriginalSourceAuthority({
        runId: "observation-reuse-run",
        workflow: fixture.workflow,
        repositoryRevision: fixture.workspace.revision,
        scopeSha256: "c".repeat(64),
        workspaceSnapshotSha256: "d".repeat(64),
      });
      const changedAuthorityReader = fixture.observer.createPreservationSourceReader({
        runId: "observation-reuse-run",
        stepId: "test-audience-understanding",
        repositoryRevision: fixture.workspace.revision,
        capture: changedAuthority.capture,
        authority: changedAuthority.evidence,
        authorizedPaths: ["docs/guide.md"],
      });
      const [changedReference] = listPreservationSources(changedAuthorityReader);
      const reauthorized = await readPreservationSourceObservation({
        cache,
        reader: changedAuthorityReader,
        sourceId: changedReference!.sourceId,
        fromByte: 0,
        maxBytes: 20,
      });
      expect(reauthorized.text).toContain("Opening paragraph");
      expect(preservationSourceObservationCacheStats(cache).invalidations["authority-change"]).toBe(
        1,
      );
    } finally {
      await fixture.workspace.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
