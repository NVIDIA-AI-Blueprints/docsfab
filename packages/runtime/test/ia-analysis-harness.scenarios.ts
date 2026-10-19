// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DurableArtifactStore, type ArtifactEnvelope } from "../src/artifacts/index.js";
import type { AgentHarness, HarnessStepInput } from "../src/execution/contracts.js";
import type { ContentIndexV1 } from "../src/content-ir/index.js";
import { IaAnalysisHarness, IaAnalysisHarnessError } from "../src/ia/analysis-harness.js";
import { IaPlanningInputProviderError, planningTaskKey } from "../src/ia/input-provider.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";

export interface IaAnalysisScenarioFixture {
  readonly index: ContentIndexV1;
  readonly ontology: ArtifactEnvelope<"ontology">;
  readonly candidates: ArtifactEnvelope<"ia-candidates">;
  readonly navigation: ArtifactEnvelope<"navigation-evaluation">;
  readonly result: Record<string, unknown>;
}
export interface registerIaAnalysisHarnessScenariosInputs {
  readonly fixtureRoot: string;
  readonly loadFixture: () => Promise<IaAnalysisScenarioFixture>;
  readonly consultedNodeId: string;
  readonly projectedDocumentNodeId: string;
}

export function registerIaAnalysisHarnessScenarios(
  inputs: registerIaAnalysisHarnessScenariosInputs,
): void {
  const fixtureRoot = inputs.fixtureRoot;
  const loadFixture = inputs.loadFixture;
  const FIXTURE_REVISION = "a".repeat(40);
  const FIXTURE_CONSULTED_NODE_ID = inputs.consultedNodeId;
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  describe("IaAnalysisHarness", () => {
    it("returns an actionable needs-input outcome when the host package is absent", async () => {
      const delegate: AgentHarness = { runStep: vi.fn() };
      const harness = new IaAnalysisHarness(delegate, {
        artifactStore: new DurableArtifactStore(resolve(fixtureRoot, "unused-artifacts")),
        inputProvider: {
          provide: vi.fn(async () => {
            throw new IaPlanningInputProviderError(
              "missing-package",
              `private/${planningTaskKey({ kind: "ia-plan", scope: "site", mode: "create" })}`,
            );
          }),
        },
      });
      await expect(harness.runStep(stepInput())).resolves.toMatchObject({
        outcome: "needs-input",
        summary: expect.stringContaining("docsfab ia input provision analysis"),
        artifacts: [],
      });
      expect(delegate.runStep).not.toHaveBeenCalled();
    });

    it("turns a real inference result into validated durable artifact references", async () => {
      const fixture = await loadFixture();
      const root = await mkdtemp(join(tmpdir(), "docsfab-ia-analysis-"));
      roots.push(root);
      const runStep = vi.fn(async (_input: HarnessStepInput) => ({
        summary: JSON.stringify(submission(fixture)),
        model: { provider: "fake", model: "deterministic" },
      }));
      const delegate: AgentHarness = {
        inspectSkill: vi.fn(async () => ({
          id: "tpl-design-ia",
          source: {
            repository: "docsfab",
            revision: FIXTURE_REVISION,
            path: "skills/tpl-design-ia/SKILL.md",
          },
          version: "1",
          contentSha256: "a".repeat(64),
          allowedTools: ["read"],
        })),
        runStep,
      };
      const store = new DurableArtifactStore(join(root, "artifacts"));
      const harness = new IaAnalysisHarness(delegate, {
        artifactStore: store,
        inputProvider: {
          provide: vi.fn(async () => ({
            index: fixture.index,
            navigationTasks: fixture.navigation.payload.tasks.map(({ id, query }) => ({
              id,
              query,
            })),
          })),
        },
      });

      const result = await harness.runStep(stepInput());

      expect(result.summary).toBe(
        "IA analysis produced a validated revision-bound recommendation.",
      );
      expect(runStep).toHaveBeenCalledOnce();
      expect(runStep.mock.calls[0]![0].instruction).toContain('"repositoryIndex"');
      expect(runStep.mock.calls[0]![0].instruction).not.toContain('"frontmatter"');
      expect(runStep.mock.calls[0]![0].instruction).not.toContain('"expectedNodeIds"');
      expect(runStep.mock.calls[0]![0].instruction).not.toContain('"acceptableNodeIds"');
      expect(result.artifacts?.map((item) => [item.role, item.reference.kind])).toEqual([
        ["output", "ontology"],
        ["output", "ia-candidates"],
        ["output", "navigation-evaluation"],
      ]);
      for (const use of result.artifacts ?? []) {
        expect((await store.get(use.reference.digest)).digest).toBe(use.reference.digest);
      }
    });

    it("accepts one bare Markdown JSON fence without relaxing submission validation", async () => {
      const fixture = await loadFixture();
      const root = await mkdtemp(join(tmpdir(), "docsfab-ia-analysis-fence-"));
      roots.push(root);
      const harness = new IaAnalysisHarness(
        {
          runStep: async () => ({
            summary: `\`\`\`json\n${JSON.stringify(submission(fixture))}\n\`\`\``,
          }),
        },
        {
          artifactStore: new DurableArtifactStore(join(root, "artifacts")),
          inputProvider: {
            provide: async () => ({
              index: fixture.index,
              navigationTasks: fixture.navigation.payload.tasks.map(({ id, query }) => ({
                id,
                query,
              })),
            }),
          },
        },
      );

      await expect(harness.runStep(stepInput())).resolves.toMatchObject({ outcome: "succeeded" });
    });

    it("rejects prose, multiple, and unterminated Markdown fences", async () => {
      const fixture = await loadFixture();
      const summaries = [
        `Here is the result:\n\`\`\`json\n${JSON.stringify(submission(fixture))}\n\`\`\``,
        `\`\`\`json\n${JSON.stringify(submission(fixture))}\n\`\`\`\n\`\`\`json\n{}\n\`\`\``,
        `\`\`\`json\n${JSON.stringify(submission(fixture))}`,
      ];
      for (const [index, summary] of summaries.entries()) {
        const root = await mkdtemp(join(tmpdir(), `docsfab-ia-analysis-invalid-fence-${index}-`));
        roots.push(root);
        const harness = new IaAnalysisHarness(
          { runStep: async () => ({ summary }) },
          {
            artifactStore: new DurableArtifactStore(join(root, "artifacts")),
            inputProvider: {
              provide: async () => ({
                index: fixture.index,
                navigationTasks: fixture.navigation.payload.tasks.map(({ id, query }) => ({
                  id,
                  query,
                })),
              }),
            },
          },
        );
        await expect(harness.runStep(stepInput())).rejects.toEqual(
          new IaAnalysisHarnessError("invalid-model-result", "parse"),
        );
      }
    });

    it("retries once when a succeeded step returns unparseable JSON, then accepts a valid envelope", async () => {
      const fixture = await loadFixture();
      const root = await mkdtemp(join(tmpdir(), "docsfab-ia-analysis-parse-retry-ok-"));
      roots.push(root);
      const runStep = vi
        .fn()
        .mockResolvedValueOnce({ summary: "not-json" })
        .mockResolvedValueOnce({ summary: JSON.stringify(submission(fixture)) });
      const harness = new IaAnalysisHarness(
        { runStep },
        {
          artifactStore: new DurableArtifactStore(join(root, "artifacts")),
          inputProvider: {
            provide: async () => ({
              index: fixture.index,
              navigationTasks: fixture.navigation.payload.tasks.map(({ id, query }) => ({
                id,
                query,
              })),
            }),
          },
        },
      );

      await expect(harness.runStep(stepInput())).resolves.toMatchObject({
        outcome: "succeeded",
        summary: "IA analysis produced a validated revision-bound recommendation.",
      });
      expect(runStep).toHaveBeenCalledTimes(2);
      expect(runStep.mock.calls[0]![0].instruction).toBe(runStep.mock.calls[1]![0].instruction);
    });

    it("fail-closes as parse after one retry when both succeeded summaries are unparseable", async () => {
      const fixture = await loadFixture();
      const root = await mkdtemp(join(tmpdir(), "docsfab-ia-analysis-parse-retry-exhausted-"));
      roots.push(root);
      const garbage = "unparseable-model-summary-must-not-leak";
      const runStep = vi.fn(async () => ({ summary: garbage }));
      const harness = new IaAnalysisHarness(
        { runStep },
        {
          artifactStore: new DurableArtifactStore(join(root, "artifacts")),
          inputProvider: {
            provide: async () => ({
              index: fixture.index,
              navigationTasks: fixture.navigation.payload.tasks.map(({ id, query }) => ({
                id,
                query,
              })),
            }),
          },
        },
      );

      try {
        await harness.runStep(stepInput());
        expect.unreachable();
      } catch (error) {
        expect(error).toEqual(new IaAnalysisHarnessError("invalid-model-result", "parse"));
        expect(String(error)).not.toContain(garbage);
      }
      expect(runStep).toHaveBeenCalledTimes(2);
    });

    it("does not retry non-succeeded delegate outcomes or treat them as needs-input", async () => {
      const fixture = await loadFixture();
      const root = await mkdtemp(join(tmpdir(), "docsfab-ia-analysis-non-succeeded-"));
      roots.push(root);
      const runStep = vi.fn(async () => ({
        summary: "not-json",
        outcome: "needs-input" as const,
      }));
      const harness = new IaAnalysisHarness(
        { runStep },
        {
          artifactStore: new DurableArtifactStore(join(root, "artifacts")),
          inputProvider: {
            provide: async () => ({
              index: fixture.index,
              navigationTasks: fixture.navigation.payload.tasks.map(({ id, query }) => ({
                id,
                query,
              })),
            }),
          },
        },
      );

      await expect(harness.runStep(stepInput())).rejects.toEqual(
        new IaAnalysisHarnessError("invalid-model-result"),
      );
      expect(runStep).toHaveBeenCalledOnce();
    });

    it("keeps large host indexes out of the model prompt while retaining stable identities", async () => {
      const fixture = await loadFixture();
      const root = await mkdtemp(join(tmpdir(), "docsfab-ia-analysis-projection-"));
      roots.push(root);
      const largeIndex = structuredClone(fixture.index);
      const marker = "unbounded-index-content-must-not-reach-the-model";
      for (let index = 0; index < 2_000; index += 1) {
        largeIndex.nodes.push({
          id: `document:large-${String(index).padStart(4, "0")}`,
          kind: "document",
          sourcePath: `docs/large-${index}.md`,
          format: "gfm",
          byteLength: marker.length,
          anchors: [],
          frontmatter: [{ name: marker.repeat(20), type: "string" }],
          directives: [],
          codeBlocks: [],
          regions: {
            body: "a".repeat(64),
            headings: "b".repeat(64),
            metadata: "c".repeat(64),
            navigation: "d".repeat(64),
            graph: "e".repeat(64),
          },
        });
      }
      const runStep = vi.fn(async (_input: HarnessStepInput) => ({
        summary: JSON.stringify(submission(fixture)),
      }));
      const harness = new IaAnalysisHarness(
        { runStep },
        {
          artifactStore: new DurableArtifactStore(join(root, "artifacts")),
          inputProvider: {
            provide: async () => ({
              index: largeIndex,
              navigationTasks: fixture.navigation.payload.tasks.map(({ id, query }) => ({
                id,
                query,
              })),
            }),
          },
        },
      );

      await harness.runStep(stepInput());

      const instruction = runStep.mock.calls[0]![0].instruction!;
      expect(instruction).not.toContain(marker);
      expect(instruction.length).toBeLessThan(200_000);
      expect(instruction).toContain(`"indexDigest":"${fixture.index.indexDigest}"`);
      expect(fixture.index.nodes.some((node) => node.id === inputs.projectedDocumentNodeId)).toBe(
        true,
      );
      expect(instruction).toContain(`"id":"${inputs.projectedDocumentNodeId}"`);
      expect(instruction).toContain(`"id":"${fixture.navigation.payload.tasks[0]!.id}"`);
      expect(instruction).toContain('"nodeCount":');
    });

    it("fails with a content-free error when the model result is not the closed contract", async () => {
      const fixture = await loadFixture();
      const root = await mkdtemp(join(tmpdir(), "docsfab-ia-analysis-invalid-"));
      roots.push(root);
      const runStep = vi.fn(async () => ({ summary: '{"rawRepositoryText":"secret value"}' }));
      const harness = new IaAnalysisHarness(
        { runStep },
        {
          artifactStore: new DurableArtifactStore(join(root, "artifacts")),
          inputProvider: {
            provide: async () => ({
              index: fixture.index,
              navigationTasks: fixture.navigation.payload.tasks.map(({ id, query }) => ({
                id,
                query,
              })),
            }),
          },
        },
      );

      try {
        await harness.runStep(stepInput());
        expect.unreachable();
      } catch (error) {
        expect(error).toEqual(new IaAnalysisHarnessError("invalid-model-result", "shape"));
        expect(String(error)).not.toContain("secret value");
      }
      expect(runStep).toHaveBeenCalledOnce();
    });

    it("does not retry a parseable envelope that fails submission validation", async () => {
      const fixture = await loadFixture();
      const root = await mkdtemp(join(tmpdir(), "docsfab-ia-analysis-submission-no-retry-"));
      roots.push(root);
      const invalid = submission(fixture) as {
        repository: { revision: string };
      };
      invalid.repository.revision = "b".repeat(40);
      const runStep = vi.fn(async () => ({ summary: JSON.stringify(invalid) }));
      const harness = new IaAnalysisHarness(
        { runStep },
        {
          artifactStore: new DurableArtifactStore(join(root, "artifacts")),
          inputProvider: {
            provide: async () => ({
              index: fixture.index,
              navigationTasks: fixture.navigation.payload.tasks.map(({ id, query }) => ({
                id,
                query,
              })),
            }),
          },
        },
      );

      await expect(harness.runStep(stepInput())).rejects.toEqual(
        new IaAnalysisHarnessError("invalid-model-result", "shape"),
      );
      expect(runStep).toHaveBeenCalledOnce();
    });

    it("authorizes the exact preallocated run and evidence identity before delegate access", async () => {
      const fixture = await loadFixture();
      const root = await mkdtemp(join(tmpdir(), "docsfab-ia-analysis-authorized-"));
      roots.push(root);
      const runStep = vi.fn(async () => ({ summary: JSON.stringify(submission(fixture)) }));
      const authorize = vi.fn(() => undefined);
      const harness = new IaAnalysisHarness(
        { runStep },
        {
          artifactStore: new DurableArtifactStore(join(root, "artifacts")),
          inputProvider: {
            provide: async () => ({
              index: fixture.index,
              navigationTasks: fixture.navigation.payload.tasks.map(({ id, query }) => ({
                id,
                query,
              })),
            }),
          },
          executionAuthorizer: { authorize },
        },
      );

      await harness.runStep(authorizedStepInput());

      expect(authorize).toHaveBeenCalledOnce();
      expect(authorize).toHaveBeenCalledWith({
        runId: "corpus-run-1",
        index: fixture.index,
        task: { kind: "ia-plan", scope: "site", mode: "create" },
        evidenceIdentity: {
          repositoryRevision: fixture.index.repository.revision,
          contextPacketDigest: "c".repeat(64),
          consultedNodeIds: [FIXTURE_CONSULTED_NODE_ID],
        },
      });
      expect(authorize.mock.invocationCallOrder[0]).toBeLessThan(
        runStep.mock.invocationCallOrder[0]!,
      );
    });

    it("never calls the delegate when execution authorization is absent or rejected", async () => {
      const fixture = await loadFixture();
      const root = await mkdtemp(join(tmpdir(), "docsfab-ia-analysis-rejected-"));
      roots.push(root);
      const runStep = vi.fn(async () => ({ summary: JSON.stringify(submission(fixture)) }));
      const harness = new IaAnalysisHarness(
        { runStep },
        {
          artifactStore: new DurableArtifactStore(join(root, "artifacts")),
          inputProvider: {
            provide: async () => ({
              index: fixture.index,
              navigationTasks: fixture.navigation.payload.tasks.map(({ id, query }) => ({
                id,
                query,
              })),
            }),
          },
          executionAuthorizer: {
            authorize: () => {
              throw new Error("private detail");
            },
          },
        },
      );

      await expect(harness.runStep(authorizedStepInput())).rejects.toEqual(
        new IaAnalysisHarnessError("invalid-model-result"),
      );
      await expect(harness.runStep(stepInput())).rejects.toEqual(
        new IaAnalysisHarnessError("invalid-model-result"),
      );
      expect(runStep).not.toHaveBeenCalled();
    });
  });

  function stepInput(): HarnessStepInput {
    const workflow = getWorkflow("ia-analysis");
    return {
      repositoryPath: resolve(fixtureRoot, "repository"),
      workflow,
      step: workflow.steps[0]!,
      task: { kind: "ia-plan", scope: "site", mode: "create" },
    };
  }

  function authorizedStepInput(): HarnessStepInput {
    const input = stepInput();
    return {
      ...input,
      runId: "corpus-run-1",
      evidenceIdentity: {
        repositoryRevision: FIXTURE_REVISION,
        contextPacketDigest: "c".repeat(64),
        consultedNodeIds: [FIXTURE_CONSULTED_NODE_ID],
      },
    };
  }

  function submission(fixture: Awaited<ReturnType<typeof loadFixture>>): object {
    const result = fixture.result;
    return {
      schemaVersion: 1,
      kind: "docsfab-ia-analysis-submission",
      repository: {
        revision: fixture.index.repository.revision,
        contentDigest: fixture.index.repository.contentDigest,
        indexDigest: fixture.index.indexDigest,
      },
      task: { scope: "site", mode: "create" },
      design: {
        status: result.status,
        useCases: result.useCases,
        recommendation: result.recommendation,
        rejections: result.rejections,
        openDecisions: result.openDecisions,
      },
      artifacts: {
        ontology: fixture.ontology.payload,
        iaCandidates: fixture.candidates.payload,
        navigationEvaluation: fixture.navigation.payload,
      },
    };
  }
}
