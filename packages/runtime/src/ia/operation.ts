// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type Artifact,
  type ArtifactReference,
  type ArtifactUse,
  type DurableArtifactStore,
} from "../artifacts/index.js";
import type {
  HarnessStepInput,
  HarnessStepResult,
  HostOperationExecutor,
} from "../execution/contracts.js";
import type { RunRecord } from "../records/contracts.js";
import type {
  IaPlanTaskInput,
  WorkflowOutcomeCandidateV1,
  WorkflowOutcomeProjector,
} from "../workflow-contracts/contracts.js";
import { canonicalJson, type ContentIndexV1 } from "../content-ir/index.js";
import {
  createIaPlanningOutcome,
  type IaEvaluatedPlanningInput,
  type IaNeedsInputPlanningInput,
  type IaPlanningOutcome,
} from "./planning.js";
import {
  defaultInconclusiveWorkflowOutcome,
  workflowOutcomeStepEvidence,
} from "../workflow-contracts/outcome.js";

export const IA_PLANNING_INPUT_ID = "planning-input-package-required";

/** Product outcome for the typed missing-package path. */
export class IaPlanningWorkflowOutcomeProjector implements WorkflowOutcomeProjector {
  public async project(record: Readonly<RunRecord>): Promise<WorkflowOutcomeCandidateV1> {
    if (record.workflow !== "ia-plan") throw new IaPlanningOperationError("invalid-step");
    if (record.status === "needs-human-decision") {
      const terminal = [...record.steps]
        .reverse()
        .find((step) => step.status === "needs-human-decision");
      if (!terminal) throw new IaPlanningOperationError("invalid-step");
      const evidence = workflowOutcomeStepEvidence(record as RunRecord, terminal.id);
      return {
        disposition: "blocked",
        findings: [
          {
            id: "finding:ia-planning-human-decision-required",
            kind: "blocked-dependency",
            severity: "blocking",
            code: "ia-planning-human-decision-required",
            evidenceIds: [evidence.id],
          },
        ],
        evidence: [evidence],
        limitations: [],
        openDecisions: [
          {
            id: "decision:ia-planning-human-decision-required",
            kind: "human-decision",
            evidenceIds: [evidence.id],
          },
        ],
        producedArtifacts: [
          ...new Map(
            (record.artifacts ?? [])
              .filter((use) => use.role === "output")
              .map((use) => [canonicalJson(use.reference), structuredClone(use.reference)]),
          ).values(),
        ].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
      };
    }
    if (record.status !== "needs-input") {
      return defaultInconclusiveWorkflowOutcome(record as RunRecord);
    }
    const terminal = [...record.steps].reverse().find((step) => step.status === "needs-input");
    if (!terminal) throw new IaPlanningOperationError("invalid-step");
    const evidence = workflowOutcomeStepEvidence(record as RunRecord, terminal.id);
    return {
      disposition: "needs-input",
      findings: [
        {
          id: `finding:${IA_PLANNING_INPUT_ID}`,
          kind: "missing-governed-input",
          severity: "blocking",
          code: IA_PLANNING_INPUT_ID,
          inputId: IA_PLANNING_INPUT_ID,
          evidenceIds: [evidence.id],
        },
      ],
      evidence: [evidence],
      limitations: [],
      openDecisions: [
        {
          id: `decision:${IA_PLANNING_INPUT_ID}`,
          kind: "governed-input",
          inputId: IA_PLANNING_INPUT_ID,
          evidenceIds: [evidence.id],
        },
      ],
      producedArtifacts: [],
    };
  }
}

export interface IaPlanningInputProviderRequest {
  /** Exact disposable checkout selected by the workflow runner. */
  repositoryPath: string;
  /** Frozen fixed-workflow task; providers must not infer scope from prose. */
  task: Readonly<IaPlanTaskInput>;
}

type EvaluatedProviderResult = Omit<
  IaEvaluatedPlanningInput,
  "index" | "scope" | "mode" | "target"
>;

export type IaPlanningInputProviderResult =
  | {
      index: ContentIndexV1;
      needsInput: IaNeedsInputPlanningInput["needsInput"];
      /** Host-derived recovery command; never sourced from model output. */
      nextCommand?: string;
    }
  | ({ index: ContentIndexV1 } & EvaluatedProviderResult);

/** Host-owned seam for governed analysis or deterministic test fixtures. */
export interface IaPlanningInputProvider {
  provide(input: IaPlanningInputProviderRequest): Promise<IaPlanningInputProviderResult>;
}

export interface IaPlanningHostOperationOptions {
  inputProvider: IaPlanningInputProvider;
  artifactStore: DurableArtifactStore;
}

export interface IaPlanningHostOperationResult extends HarnessStepResult {
  /** Closed orchestration result; plan or need contents never enter a run record. */
  planningOutcome: IaPlanningOutcome["status"];
  artifacts: ArtifactUse[];
}

export type IaPlanningOperationErrorCode = "invalid-step" | "invalid-task";

export class IaPlanningOperationError extends Error {
  public constructor(public readonly code: IaPlanningOperationErrorCode) {
    super(`IA planning host operation rejected: ${code}.`);
    this.name = "IaPlanningOperationError";
  }
}

/**
 * Pi-independent host adapter for the read-only IA planning phase. The input
 * provider receives only the exact disposable path and fixed task. Its result
 * is combined with task fields here, so it cannot substitute another target.
 */
export class IaPlanningHostOperation implements HostOperationExecutor {
  public constructor(private readonly options: IaPlanningHostOperationOptions) {}

  public async runStep(input: HarnessStepInput): Promise<IaPlanningHostOperationResult> {
    assertPlanningStep(input);
    const task = frozenTask(input.task);
    const provided = structuredClone(
      await this.options.inputProvider.provide({
        repositoryPath: input.repositoryPath,
        task,
      }),
    );
    const planningInput = {
      ...provided,
      index: provided.index,
      scope: task.scope,
      mode: task.mode,
      ...(task.target ? { target: structuredClone(task.target) } : {}),
    } as IaEvaluatedPlanningInput | IaNeedsInputPlanningInput;
    if (!task.target) {
      delete (planningInput as { target?: unknown }).target;
    }
    const outcome = createIaPlanningOutcome(planningInput);
    const reportedStatus =
      outcome.status === "plan-ready" && (task.scope !== "site" || task.mode !== "create")
        ? ("needs-human-decision" as const)
        : outcome.status;
    const artifacts = await this.persistArtifacts(planningInput, outcome);
    return {
      summary:
        outcome.status === "needs-input" &&
        "nextCommand" in provided &&
        typeof provided.nextCommand === "string"
          ? `IA planning requires its governed input package. Next: ${provided.nextCommand}`
          : summaryFor(reportedStatus),
      outcome: runnerOutcome(reportedStatus),
      planningOutcome: reportedStatus,
      artifacts,
    };
  }

  private async persistArtifacts(
    input: IaEvaluatedPlanningInput | IaNeedsInputPlanningInput,
    outcome: IaPlanningOutcome,
  ): Promise<ArtifactUse[]> {
    const artifacts: Array<{ artifact: Artifact; role: ArtifactUse["role"] }> = [];
    if (!("needsInput" in input)) {
      artifacts.push(
        { artifact: input.ontology, role: "input" },
        { artifact: input.candidates, role: "input" },
        { artifact: input.evaluation, role: "input" },
        { artifact: input.navigationEvaluation, role: "input" },
      );
    }
    if ("plan" in outcome) artifacts.push({ artifact: outcome.plan, role: "output" });

    const uses: ArtifactUse[] = [];
    for (const { artifact, role } of artifacts) {
      await this.options.artifactStore.put(artifact, {
        index: input.index,
        planAcceptance: "any",
      });
      uses.push({ role, reference: referenceFor(artifact) });
    }
    return uses;
  }
}

function assertPlanningStep(input: HarnessStepInput): asserts input is HarnessStepInput & {
  task: IaPlanTaskInput;
} {
  if (
    input.step.kind !== "host-operation" ||
    input.step.operation !== "ia-plan" ||
    input.step.mode !== "read-only"
  ) {
    throw new IaPlanningOperationError("invalid-step");
  }
  if (input.task?.kind !== "ia-plan") {
    throw new IaPlanningOperationError("invalid-task");
  }
}

function frozenTask(task: IaPlanTaskInput): Readonly<IaPlanTaskInput> {
  const target = task.target ? Object.freeze(structuredClone(task.target)) : undefined;
  return Object.freeze({
    kind: task.kind,
    scope: task.scope,
    mode: task.mode,
    ...(target ? { target } : {}),
  });
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

function runnerOutcome(
  status: IaPlanningOutcome["status"],
): NonNullable<HarnessStepResult["outcome"]> {
  return status === "plan-ready" ? "succeeded" : status;
}

function summaryFor(status: IaPlanningOutcome["status"]): string {
  switch (status) {
    case "plan-ready":
      return "IA planning produced a revision-bound plan.";
    case "needs-input":
      return "IA planning requires additional governed input.";
    case "needs-human-decision":
      return "IA planning requires a human decision.";
  }
}
