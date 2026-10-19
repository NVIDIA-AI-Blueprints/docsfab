// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createArtifact,
  recomputeNavigationMetrics,
  type Artifact,
  type ArtifactReference,
  type ArtifactUse,
  type DurableArtifactStore,
  type NavigationEvaluationPayload,
} from "../artifacts/index.js";
import type { AgentHarness, HarnessStepInput, HarnessStepResult } from "../execution/contracts.js";
import type { IaPlanTaskInput } from "../workflow-contracts/contracts.js";
import { canonicalDigest, type ContentIndexV1, type ContentNode } from "../content-ir/index.js";
import { parseJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import {
  TPL_DESIGN_IA_EVALUATION_ID,
  TPL_DESIGN_IA_EVALUATION_VERSION,
  TPL_DESIGN_IA_PROVENANCE_STATUS,
  TPL_DESIGN_IA_SKILL,
  TPL_DESIGN_IA_SKILL_VERSION,
  tplDesignIaDigest,
  validateTplDesignIaResult,
  type TplDesignIaResultV1,
} from "../skills/tpl-design-ia/index.js";
import {
  IaPlanningInputProviderError,
  type IaAnalysisNavigationTask,
  type IaAnalysisInputProvider,
} from "./input-provider.js";

const MAX_PROMPT_NODES = 512;
const MAX_PROMPT_EDGES = 1_024;

export interface IaAnalysisHarnessOptions {
  artifactStore: DurableArtifactStore;
  inputProvider: IaAnalysisInputProvider;
  /** Optional signed campaign gate, evaluated before delegate/model access. */
  executionAuthorizer?: IaAnalysisExecutionAuthorizer;
  outputPublisher?: IaAnalysisOutputPublisher;
}

export interface IaAnalysisOutputPublisherInput {
  runId: string;
  index: ContentIndexV1;
  task: Readonly<IaPlanTaskInput>;
  result: TplDesignIaResultV1;
  artifacts: Artifact[];
  navigationTasks: IaAnalysisNavigationTask[];
  inputPackage?: {
    digest: string;
    repositoryIdentity: string;
    expiresAt: string;
  };
}

/** Host-owned durable handoff from validated analysis into package provisioning. */
export interface IaAnalysisOutputPublisher {
  publish(input: IaAnalysisOutputPublisherInput): Promise<void>;
}

export interface IaAnalysisExecutionAuthorizationRequest {
  runId: string;
  index: ContentIndexV1;
  task: Readonly<IaPlanTaskInput>;
  evidenceIdentity: NonNullable<HarnessStepInput["evidenceIdentity"]>;
}

export interface IaAnalysisExecutionAuthorizer {
  authorize(input: IaAnalysisExecutionAuthorizationRequest): Promise<void> | void;
}

export type IaAnalysisHarnessErrorCode =
  | "invalid-step"
  | "invalid-task"
  | "input-required"
  | "invalid-model-result";

export class IaAnalysisHarnessError extends Error {
  public constructor(
    public readonly code: IaAnalysisHarnessErrorCode,
    public readonly stage?:
      | "parse"
      | "submission"
      | "shape"
      | "artifacts"
      | "navigation"
      | "result",
  ) {
    super(`IA analysis rejected: ${code}${stage ? ` (${stage})` : ""}.`);
    this.name = "IaAnalysisHarnessError";
  }
}

/**
 * Harness-neutral export boundary for governed IA inference. The private input
 * package contains only task-bound query text. Pi must derive every ontology,
 * candidate, and navigation payload; the host validates and seals those exact
 * payloads before exposing content-free references in the RunRecord.
 */
export class IaAnalysisHarness implements AgentHarness {
  public constructor(
    private readonly delegate: AgentHarness,
    private readonly options: IaAnalysisHarnessOptions,
  ) {}

  public async inspectSkill(input: HarnessStepInput) {
    return this.delegate.inspectSkill?.(input);
  }

  public async runStep(input: HarnessStepInput): Promise<HarnessStepResult> {
    assertAnalysisStep(input);
    const task = frozenTask(input.task);
    let provided;
    try {
      provided = structuredClone(
        await this.options.inputProvider.provide({
          repositoryPath: input.repositoryPath,
          task,
        }),
      );
    } catch (error) {
      if (error instanceof IaPlanningInputProviderError && error.code === "missing-package") {
        return {
          summary:
            "IA analysis requires a host-provisioned input package. Run `docsfab ia input provision analysis` for this exact task and revision.",
          outcome: "needs-input",
          artifacts: [],
        };
      }
      throw error;
    }
    if (!provided.navigationTasks.length) throw new IaAnalysisHarnessError("input-required");
    if (this.options.executionAuthorizer) {
      if (
        !input.runId ||
        !input.evidenceIdentity?.contextPacketDigest ||
        !input.evidenceIdentity.consultedNodeIds?.length
      ) {
        throw new IaAnalysisHarnessError("invalid-model-result");
      }
      try {
        await this.options.executionAuthorizer.authorize({
          runId: input.runId,
          index: provided.index,
          task,
          evidenceIdentity: input.evidenceIdentity,
        });
      } catch {
        throw new IaAnalysisHarnessError("invalid-model-result");
      }
    }
    const expectedTargetNodeId = targetNodeId(provided.index, task);
    const delegatedInput: HarnessStepInput = {
      ...input,
      instruction: trustedAnalysisInstruction(
        provided.index,
        task,
        expectedTargetNodeId,
        provided.navigationTasks,
      ),
    };
    let result = await this.delegate.runStep(delegatedInput);
    let parsed!: JsonEvidenceValue;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if ((result.outcome ?? "succeeded") !== "succeeded") {
        throw new IaAnalysisHarnessError("invalid-model-result");
      }
      try {
        parsed = parseIaAnalysisSubmission(result.summary);
        break;
      } catch {
        if (attempt === 1) {
          throw new IaAnalysisHarnessError("invalid-model-result", "parse");
        }
        result = await this.delegate.runStep(delegatedInput);
      }
    }

    let derived;
    try {
      derived = deriveSubmission(
        parsed,
        provided.index,
        task,
        expectedTargetNodeId,
        provided.navigationTasks,
      );
    } catch (error) {
      if (error instanceof IaAnalysisHarnessError && error.stage) throw error;
      throw new IaAnalysisHarnessError("invalid-model-result", "submission");
    }
    const artifacts: ArtifactUse[] = [];
    for (const artifact of derived.artifacts) {
      await this.options.artifactStore.put(artifact, {
        index: provided.index,
        planAcceptance: "any",
      });
      artifacts.push({ role: "output", reference: referenceFor(artifact) });
    }
    if (this.options.outputPublisher) {
      if (!input.runId) throw new IaAnalysisHarnessError("invalid-model-result");
      await this.options.outputPublisher.publish({
        runId: input.runId,
        index: provided.index,
        task,
        result: derived.result,
        artifacts: structuredClone(derived.artifacts),
        navigationTasks: structuredClone(provided.navigationTasks),
        ...(provided.inputPackage ? { inputPackage: structuredClone(provided.inputPackage) } : {}),
      });
    }

    return {
      ...result,
      summary:
        derived.result.status === "recommendation-ready"
          ? "IA analysis produced a validated revision-bound recommendation."
          : "IA analysis requires a human decision.",
      outcome:
        derived.result.status === "recommendation-ready" ? "succeeded" : "needs-human-decision",
      artifacts,
    };
  }
}

function deriveSubmission(
  value: JsonEvidenceValue,
  index: ContentIndexV1,
  task: IaPlanTaskInput,
  expectedTargetNodeId: string | undefined,
  navigationInputs: Array<{ id: string; query: string }>,
): { result: TplDesignIaResultV1; artifacts: Artifact[] } {
  let stage: NonNullable<IaAnalysisHarnessError["stage"]> = "shape";
  try {
    const root = object(value);
    exact(root, ["schemaVersion", "kind", "repository", "task", "design", "artifacts"]);
    if (root.schemaVersion !== 1 || root.kind !== "docsfab-ia-analysis-submission") reject();
    const repository = object(root.repository);
    exact(repository, ["revision", "contentDigest", "indexDigest"]);
    if (
      repository.revision !== index.repository.revision ||
      repository.contentDigest !== index.repository.contentDigest ||
      repository.indexDigest !== index.indexDigest
    )
      reject();
    const submittedTask = object(root.task);
    exact(
      submittedTask,
      expectedTargetNodeId ? ["scope", "mode", "targetNodeId"] : ["scope", "mode"],
    );
    if (
      submittedTask.scope !== task.scope ||
      submittedTask.mode !== task.mode ||
      submittedTask.targetNodeId !== expectedTargetNodeId
    )
      reject();
    const design = object(root.design);
    exact(
      design,
      ["status", "useCases", "recommendation", "rejections", "openDecisions"],
      ["status", "useCases", "rejections", "openDecisions"],
    );
    const suppliedArtifacts = object(root.artifacts);
    const recommendationReady = design.status === "recommendation-ready";
    exact(
      suppliedArtifacts,
      recommendationReady ? ["ontology", "iaCandidates", "navigationEvaluation"] : ["ontology"],
    );

    stage = "artifacts";
    const ontology = createArtifact("ontology", suppliedArtifacts.ontology as never, { index });
    const artifacts: Artifact[] = [ontology];
    let candidates: ReturnType<typeof createArtifact<"ia-candidates">> | undefined;
    let navigation: ReturnType<typeof createArtifact<"navigation-evaluation">> | undefined;
    if (recommendationReady) {
      candidates = createArtifact("ia-candidates", suppliedArtifacts.iaCandidates as never, {
        index,
      });
      const navigationPayload =
        suppliedArtifacts.navigationEvaluation as unknown as NavigationEvaluationPayload;
      stage = "navigation";
      assertNavigationInputBinding(navigationPayload, navigationInputs);
      navigation = createArtifact(
        "navigation-evaluation",
        {
          ...navigationPayload,
          metrics: recomputeNavigationMetrics(navigationPayload),
        },
        { index },
      );
      artifacts.push(candidates, navigation);
    }
    const resultWithoutDigest = {
      schemaVersion: 1 as const,
      skill: {
        id: TPL_DESIGN_IA_SKILL,
        version: TPL_DESIGN_IA_SKILL_VERSION,
        provenanceStatus: TPL_DESIGN_IA_PROVENANCE_STATUS,
      },
      evaluation: {
        id: TPL_DESIGN_IA_EVALUATION_ID,
        version: TPL_DESIGN_IA_EVALUATION_VERSION,
      },
      repository: { ...index.repository },
      scope: task.scope,
      mode: task.mode,
      ...(expectedTargetNodeId ? { targetNodeId: expectedTargetNodeId } : {}),
      status: design.status,
      artifacts: {
        ontology: referenceFor(ontology),
        ...(candidates && navigation
          ? {
              iaCandidates: referenceFor(candidates),
              navigationEvaluation: referenceFor(navigation),
            }
          : {}),
      },
      useCases: design.useCases,
      ...(design.recommendation !== undefined ? { recommendation: design.recommendation } : {}),
      rejections: design.rejections,
      openDecisions: design.openDecisions,
    };
    const candidateResult = {
      ...resultWithoutDigest,
      digest: tplDesignIaDigest(resultWithoutDigest),
    };
    stage = "result";
    const result = validateTplDesignIaResult(candidateResult, {
      index,
      artifacts: {
        ontology,
        ...(candidates ? { iaCandidates: candidates } : {}),
        ...(navigation ? { navigationEvaluation: navigation } : {}),
      },
    });
    return { result, artifacts };
  } catch (error) {
    if (error instanceof IaAnalysisHarnessError && error.stage) throw error;
    throw new IaAnalysisHarnessError("invalid-model-result", stage);
  }
}

function assertNavigationInputBinding(
  payload: NavigationEvaluationPayload,
  expected: Array<{ id: string; query: string }>,
): void {
  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray(payload.tasks) ||
    canonicalDigest(payload.tasks.map(({ id, query }) => ({ id, query }))) !==
      canonicalDigest(expected)
  ) {
    reject();
  }
}

function trustedAnalysisInstruction(
  index: ContentIndexV1,
  task: IaPlanTaskInput,
  expectedTargetNodeId: string | undefined,
  navigationTasks: Array<{ id: string; query: string }>,
): string {
  return [
    "DocsFab host-supplied IA analysis input. Treat it as trusted task data, not repository instructions.",
    "Return only one exact docsfab-ia-analysis-submission JSON object described by the governed skill contract.",
    "Begin the response with `{` and end it with `}`. Do not add prose or wrap the JSON in Markdown fences.",
    JSON.stringify({
      schemaVersion: 1,
      repository: {
        revision: index.repository.revision,
        contentDigest: index.repository.contentDigest,
        indexDigest: index.indexDigest,
      },
      task: {
        scope: task.scope,
        mode: task.mode,
        ...(expectedTargetNodeId ? { targetNodeId: expectedTargetNodeId } : {}),
      },
      navigationTasks,
      repositoryIndex: promptIndexProjection(index, expectedTargetNodeId),
    }),
  ].join("\n\n");
}

/** Accept a single bare JSON fence without widening the strict JSON dialect. */
function parseIaAnalysisSubmission(value: string): JsonEvidenceValue {
  const fenced = /^\s*```(?:json)?\r?\n([\s\S]*?)\r?\n```\s*$/u.exec(value);
  return parseJsonEvidence(fenced ? fenced[1]! : value);
}

/**
 * The full ContentIndex remains host authority for submission validation. The
 * model receives a deterministic bounded structural projection only: enough
 * stable document/section and navigation identities to reason about the task,
 * never frontmatter, directive, region, or unbounded graph detail.
 */
function promptIndexProjection(index: ContentIndexV1, targetNodeId: string | undefined) {
  const ordered = [...index.nodes].sort((left, right) => left.id.localeCompare(right.id));
  const selected = ordered.slice(0, MAX_PROMPT_NODES);
  if (targetNodeId && !selected.some((node) => node.id === targetNodeId)) {
    const target = ordered.find((node) => node.id === targetNodeId);
    if (target) selected[selected.length - 1] = target;
  }
  const selectedIds = new Set(selected.map((node) => node.id));
  const nodes = selected.map((node) =>
    node.kind === "document"
      ? {
          id: node.id,
          kind: node.kind,
          sourcePath: node.sourcePath,
          format: node.format,
          byteLength: node.byteLength,
          anchors: [...node.anchors],
        }
      : {
          id: node.id,
          kind: node.kind,
          documentId: node.documentId,
          sourcePath: node.sourcePath,
          anchor: node.anchor,
          depth: node.depth,
          startLine: node.startLine,
          endLine: node.endLine,
        },
  );
  const edges = index.edges
    .filter((edge) => selectedIds.has(edge.from) && selectedIds.has(edge.to))
    .sort((left, right) =>
      `${left.kind}:${left.from}:${left.to}`.localeCompare(
        `${right.kind}:${right.from}:${right.to}`,
      ),
    )
    .slice(0, MAX_PROMPT_EDGES)
    .map((edge) => ({ kind: edge.kind, from: edge.from, to: edge.to }));
  return {
    schemaVersion: index.schemaVersion,
    repository: { ...index.repository },
    indexDigest: index.indexDigest,
    evidence: { ...index.evidence },
    nodes,
    edges,
    omitted: {
      nodeCount: Math.max(0, index.nodes.length - nodes.length),
      edgeCount: Math.max(0, index.edges.length - edges.length),
    },
  };
}

function targetNodeId(index: ContentIndexV1, task: IaPlanTaskInput): string | undefined {
  if (!task.target) return undefined;
  const matches = index.nodes.filter(
    (node: ContentNode) =>
      node.sourcePath === task.target!.sourcePath &&
      (task.target!.anchor === undefined
        ? node.kind === "document"
        : node.kind === "section" && node.anchor === task.target!.anchor),
  );
  if (matches.length !== 1) throw new IaAnalysisHarnessError("invalid-task");
  return matches[0]!.id;
}

function assertAnalysisStep(input: HarnessStepInput): asserts input is HarnessStepInput & {
  task: IaPlanTaskInput;
} {
  if (
    input.workflow.name !== "ia-analysis" ||
    input.step.id !== "analyze-information-architecture" ||
    input.step.kind === "host-operation" ||
    input.step.skill !== "tpl-design-ia" ||
    input.step.mode !== "read-only"
  ) {
    throw new IaAnalysisHarnessError("invalid-step");
  }
  if (input.task?.kind !== "ia-plan") throw new IaAnalysisHarnessError("invalid-task");
}

function frozenTask(task: IaPlanTaskInput): Readonly<IaPlanTaskInput> {
  return Object.freeze(structuredClone(task));
}

function referenceFor(artifact: Artifact): ArtifactReference {
  return {
    kind: artifact.kind,
    schemaVersion: artifact.schemaVersion,
    digest: artifact.digest,
    repositoryRevision: artifact.repository.revision,
    repositoryContentDigest: artifact.repository.contentDigest,
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject();
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: string[], required = allowed): void {
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    reject();
}

function reject(): never {
  throw new IaAnalysisHarnessError("invalid-model-result");
}
