// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createArtifact,
  DurableArtifactStore,
  type Artifact,
  type ArtifactPayloadByKind,
  type ArtifactReference,
  type IaPlannedPage,
} from "../src/artifacts/index.js";
import type { AgentHarness, HarnessStepInput } from "../src/execution/contracts.js";
import type { RepositorySecurityScanner } from "../src/security/contracts.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import {
  buildContentIndex,
  type ContentIndexV1,
  type DocumentNode,
} from "../src/content-ir/index.js";
import {
  IaPlanningHostOperation,
  IaPlanningOperationError,
  IaPlanningWorkflowOutcomeProjector,
  type IaPlanningHostOperationResult,
  type IaPlanningInputProviderResult,
} from "../src/ia/index.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { readyContextPreflight } from "./helpers.js";
import { passedIaEvaluationFixture } from "./ia-evaluation-fixture.js";

const REVISION = "a".repeat(40);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("IA planning host operation", () => {
  it("records only references and recovers the durable plan in a later invocation", async () => {
    const repositoryPath = await fixtureRepository();
    const artifactRoot = await temporaryRoot("docsfab-ia-artifacts-");
    let exactIndex: ContentIndexV1 | undefined;
    let hostResult: IaPlanningHostOperationResult | undefined;
    const operation = new IaPlanningHostOperation({
      artifactStore: new DurableArtifactStore(artifactRoot),
      inputProvider: {
        provide: async (request) => {
          expect(request.repositoryPath).toBe(repositoryPath);
          expect(request.task).toEqual({ kind: "ia-plan", scope: "site", mode: "create" });
          expect(Object.isFrozen(request.task)).toBe(true);
          exactIndex = await buildContentIndex({
            repositoryPath: request.repositoryPath,
            repositoryRevision: REVISION,
          });
          return evaluatedProviderResult(exactIndex);
        },
      },
    });
    const runStore = new MemoryRunStore();
    const runner = new WorkflowRunner({
      harness: new RejectingHarness(),
      hostOperations: {
        runStep: async (input) => {
          hostResult = await operation.runStep(input);
          return hostResult;
        },
      },
      store: runStore,
      repositoryScanner: passedScanner,
      contextPreflight: readyContextPreflight,
      id: () => "ia-planning-run",
      now: () => new Date("2026-08-03T12:00:00.000Z"),
    });

    const record = await runner.run({
      workflow: "ia-plan",
      workspacePath: repositoryPath,
      repository: {
        sourcePath: "/requester/source",
        requestedRevision: "HEAD",
        revision: REVISION,
      },
      task: { kind: "ia-plan", scope: "site", mode: "create" },
      allowWrite: false,
    });

    expect(hostResult).toMatchObject({
      outcome: "succeeded",
      planningOutcome: "plan-ready",
    });
    expect(record).toMatchObject({
      id: "ia-planning-run",
      status: "succeeded",
      task: { kind: "ia-plan", scope: "site", mode: "create" },
      steps: [{ status: "succeeded" }],
    });
    expect(record.artifacts?.map((use) => [use.role, use.reference.kind])).toEqual([
      ["input", "ontology"],
      ["input", "ia-candidates"],
      ["input", "ia-evaluation"],
      ["input", "navigation-evaluation"],
      ["output", "ia-plan"],
    ]);
    expect(JSON.stringify(record)).not.toContain("PRIVATE_REPOSITORY_CONTENT");
    expect(JSON.stringify(record)).not.toContain('"payload"');
    expect(runStore.records.at(-1)).toEqual(record);

    const freshStore = new DurableArtifactStore(artifactRoot);
    for (const use of record.artifacts ?? []) {
      await expect(freshStore.has(use.reference.digest)).resolves.toBe(true);
    }
    const planUse = record.artifacts?.find((use) => use.role === "output");
    if (!planUse || !exactIndex) throw new Error("Expected persisted plan fixture.");
    const recovered = await freshStore.get(planUse.reference.digest, {
      index: exactIndex,
      now: new Date("2026-08-03T12:00:00.000Z"),
      planAcceptance: "any",
    });
    expect(recovered).toMatchObject({
      kind: "ia-plan",
      digest: planUse.reference.digest,
      payload: {
        approval: { status: "pending" },
        mode: "create",
        plannedPages: [{ outputPath: "docs/get-started.md" }],
      },
    });
    if (recovered.kind !== "ia-plan") throw new Error("Expected IA plan.");
    await expect(freshStore.has(recovered.payload.candidateArtifact.digest)).resolves.toBe(true);
    await expect(freshStore.has(recovered.payload.iaEvaluation!.digest)).resolves.toBe(true);
    await expect(freshStore.has(recovered.payload.navigationEvaluation.digest)).resolves.toBe(true);
  });

  it("returns an explicit needs-input outcome without persisting repository content", async () => {
    const repositoryPath = await fixtureRepository();
    const artifactRoot = await temporaryRoot("docsfab-ia-needs-input-");
    const index = await buildContentIndex({ repositoryPath, repositoryRevision: REVISION });
    const guide = documentByPath(index, "docs/guide.md");
    const operation = new IaPlanningHostOperation({
      artifactStore: new DurableArtifactStore(artifactRoot),
      inputProvider: {
        provide: async ({ task }) => {
          expect(task).toEqual({
            kind: "ia-plan",
            scope: "page",
            mode: "reevaluate",
            target: { sourcePath: "docs/guide.md" },
          });
          expect(Object.isFrozen(task.target)).toBe(true);
          return {
            index,
            needsInput: [
              {
                id: "decision:canonical-home",
                kind: "canonical-home",
                evidence: [{ path: guide.sourcePath, nodeId: guide.id }],
              },
            ],
            // Simulate an untyped provider attempting to substitute task identity.
            scope: "site",
            mode: "create",
            target: { sourcePath: "docs/index.md" },
          } as unknown as IaPlanningInputProviderResult;
        },
      },
    });

    const result = await operation.runStep(
      stepInput(repositoryPath, {
        kind: "ia-plan",
        scope: "page",
        mode: "reevaluate",
        target: { sourcePath: "docs/guide.md" },
      }),
    );

    expect(result).toEqual({
      summary: "IA planning requires additional governed input.",
      outcome: "needs-input",
      planningOutcome: "needs-input",
      artifacts: [],
    });
    expect(await readdir(artifactRoot)).toEqual([]);
  });

  it("projects and persists a current blocked product outcome for a valid human-decision exit", async () => {
    const repositoryPath = await fixtureRepository();
    const projector = new IaPlanningWorkflowOutcomeProjector();
    const runner = new WorkflowRunner({
      harness: new RejectingHarness(),
      hostOperations: {
        runStep: async () => ({
          summary: "IA planning requires a human decision.",
          outcome: "needs-human-decision",
          artifacts: [],
        }),
      },
      outcomeProjector: projector,
      store: new MemoryRunStore(),
      repositoryScanner: passedScanner,
      contextPreflight: readyContextPreflight,
      id: () => "ia-human-decision-run",
      now: () => new Date("2026-08-03T12:00:00.000Z"),
    });
    const record = await runner.run({
      workflow: "ia-plan",
      workspacePath: repositoryPath,
      repository: {
        sourcePath: "/requester/source",
        requestedRevision: "HEAD",
        revision: REVISION,
      },
      task: {
        kind: "ia-plan",
        scope: "page",
        mode: "reevaluate",
        target: {
          sourcePath: "docs/guide.md",
        },
      },
      allowWrite: false,
    });

    expect(record).toMatchObject({
      status: "needs-human-decision",
      steps: [{ status: "needs-human-decision" }],
      workflowOutcome: {
        disposition: "blocked",
        findings: [{ code: "ia-planning-human-decision-required" }],
        openDecisions: [{ kind: "human-decision" }],
      },
    });
    await expect(projector.project(record)).resolves.toMatchObject({
      disposition: "blocked",
      findings: [{ kind: "blocked-dependency" }],
      openDecisions: [{ kind: "human-decision" }],
    });
  });

  it("returns a truthful human-decision outcome for a valid page plan that has no approval command", async () => {
    const repositoryPath = await fixtureRepository();
    const index = await buildContentIndex({ repositoryPath, repositoryRevision: REVISION });
    const guide = documentByPath(index, "docs/guide.md");
    const base = evaluatedProviderResult(index);
    const targeted = passedIaEvaluationFixture(index, "page", guide.id);
    const operation = new IaPlanningHostOperation({
      artifactStore: new DurableArtifactStore(await temporaryRoot("docsfab-ia-page-plan-")),
      inputProvider: {
        provide: async () => ({
          ...base,
          planId: "plan:page:reevaluate",
          ontology: targeted.ontology,
          candidates: targeted.candidates,
          evaluation: targeted.evaluation,
          evaluationInput: targeted.evaluationInput,
          navigationEvaluation: targeted.navigationEvaluation,
          plannedPages: [],
          migrationDispositions: [
            {
              nodeId: guide.id,
              disposition: "keep" as const,
              destinationPaths: [],
              relatedNodeIds: [],
              evidence: [evidence(guide)],
            },
          ],
        }),
      },
    });
    const result = await operation.runStep(
      stepInput(repositoryPath, {
        kind: "ia-plan",
        scope: "page",
        mode: "reevaluate",
        target: { sourcePath: guide.sourcePath },
      }),
    );
    expect(result).toMatchObject({
      outcome: "needs-human-decision",
      planningOutcome: "needs-human-decision",
      summary: "IA planning requires a human decision.",
    });
    expect(
      result.artifacts.some((use) => use.role === "output" && use.reference.kind === "ia-plan"),
    ).toBe(true);
  });

  it("rejects other host steps and missing fixed tasks", async () => {
    const operation = new IaPlanningHostOperation({
      artifactStore: new DurableArtifactStore(await temporaryRoot("docsfab-ia-invalid-")),
      inputProvider: {
        provide: async () => {
          throw new Error("must not run");
        },
      },
    });
    const repositoryPath = await fixtureRepository();
    const valid = stepInput(repositoryPath, { kind: "ia-plan", scope: "site", mode: "create" });
    await expect(
      operation.runStep({
        ...valid,
        step: { ...valid.step, operation: "site-bootstrap" },
      }),
    ).rejects.toEqual(new IaPlanningOperationError("invalid-step"));
    await expect(operation.runStep({ ...valid, task: undefined })).rejects.toEqual(
      new IaPlanningOperationError("invalid-task"),
    );
  });
});

class MemoryRunStore implements RunStore {
  public records: RunRecord[] = [];

  public async save(record: RunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

class RejectingHarness implements AgentHarness {
  public async runStep(): Promise<never> {
    throw new Error("IA planning must not invoke the inference harness.");
  }
}

const passedScanner: RepositorySecurityScanner = {
  scan: async () => ({
    ruleSet: "test-v1",
    status: "passed",
    scannedFiles: 2,
    binaryFiles: 0,
    findings: [],
  }),
};

async function fixtureRepository(): Promise<string> {
  const root = await temporaryRoot("docsfab-ia-repository-");
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "index.md"), "# Home\n\nPRIVATE_REPOSITORY_CONTENT\n");
  await writeFile(join(root, "docs", "guide.md"), "# Guide\n\n## Install\n\nSteps.\n");
  return root;
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function stepInput(
  repositoryPath: string,
  task: NonNullable<HarnessStepInput["task"]>,
): HarnessStepInput {
  const workflow = getWorkflow("ia-plan");
  return { repositoryPath, workflow, step: workflow.steps[0]!, task };
}

function evaluatedProviderResult(index: ContentIndexV1): IaPlanningInputProviderResult {
  const guide = documentByPath(index, "docs/guide.md");
  const evaluated = passedIaEvaluationFixture(index);
  return {
    index,
    planId: "plan:site:create",
    ontology: evaluated.ontology,
    candidates: evaluated.candidates,
    evaluation: evaluated.evaluation,
    evaluationInput: evaluated.evaluationInput,
    navigationEvaluation: evaluated.navigationEvaluation,
    useCases: [
      {
        id: "use-case:install",
        actor: "Operator",
        trigger: "DocsFab is available",
        goal: "Install DocsFab",
        input: "A repository",
        outcome: "A working installation",
        evidence: [evidence(guide)],
      },
    ],
    redirects: [],
    inboundLinkConsequences: [],
    policyBindings: [{ id: "policy:ia", version: "1", digest: "d".repeat(64) }],
    requiredApproval: "maintainer",
    expiresAt: "2099-08-10T12:00:00.000Z",
    plannedPages: [plannedPage(guide)],
    migrationDispositions: [],
  };
}

function navigationPayload(guideId: string): ArtifactPayloadByKind["navigation-evaluation"] {
  return {
    tasks: [
      {
        id: "task:install",
        query: "How do I install DocsFab?",
        expectedNodeIds: [guideId],
        acceptableNodeIds: [],
      },
    ],
    results: [{ taskId: "task:install", rankedNodeIds: [guideId], outcome: "matched" }],
    metrics: {
      taskCount: 1,
      agreementRate: 1,
      recallAt3: 1,
      meanReciprocalRank: 1,
      noResultRate: 0,
      ambiguousPlacementRate: 0,
    },
  };
}

function evaluationPayload(
  candidateArtifact: ArtifactReference<"ia-candidates">,
  navigationEvaluation: ArtifactReference<"navigation-evaluation">,
  guide: DocumentNode,
): ArtifactPayloadByKind["ia-evaluation"] {
  return {
    candidateArtifact,
    candidateId: "candidate:reader-job",
    diagnosticsDigest: "1".repeat(64),
    scoringDigest: "2".repeat(64),
    topologyDigest: "3".repeat(64),
    navigationComparisonDigest: "4".repeat(64),
    navigationEvaluation,
    navigationSuite: { id: "suite:ia", version: "1", digest: "5".repeat(64) },
    scores: {
      evidenceCoverage: 100,
      cohesion: 90,
      separation: 90,
      predictability: 90,
      balance: 90,
      stability: 90,
      duplication: 100,
      total: 92,
      structuralFindability: 94,
    },
    deterministicStatus: "passed",
    eligible: true,
    blockingDiagnosticDigests: [],
    policyBindings: [{ id: "policy:ia", version: "1", digest: "d".repeat(64) }],
    evidence: [evidence(guide)],
  };
}

function plannedPage(guide: DocumentNode): IaPlannedPage {
  return {
    topicId: "topic:get-started",
    title: "Get started",
    slug: "get-started",
    templateId: "template:tutorial",
    format: "gfm",
    outputPath: "docs/get-started.md",
    evidence: [evidence(guide)],
  };
}

function documentByPath(index: ContentIndexV1, path: string): DocumentNode {
  const node = index.nodes.find(
    (candidate): candidate is DocumentNode =>
      candidate.kind === "document" && candidate.sourcePath === path,
  );
  if (!node) throw new Error(`Missing document ${path}.`);
  return node;
}

function evidence(document: DocumentNode): { path: string; nodeId: string } {
  return { path: document.sourcePath, nodeId: document.id };
}

function referenceFor<K extends Artifact["kind"]>(
  artifact: Extract<Artifact, { kind: K }>,
): ArtifactReference<K> {
  return {
    kind: artifact.kind,
    schemaVersion: artifact.schemaVersion,
    digest: artifact.digest,
    repositoryRevision: artifact.repository.revision,
    repositoryContentDigest: artifact.repository.contentDigest,
  };
}
