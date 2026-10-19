// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Schedule seam for WorkflowRunner: run-record bootstrap, lineage capture,
 * progress typing, and terminal schedule diagnostics.
 */
import type { RunRequest } from "../execution/contracts.js";
import type { ProgressEvent, RunRecord, RunStore } from "../records/contracts.js";
import { type ReleaseDocumentationExpectedRepositoryV1 } from "../release-documentation-rubric.js";
import { validateWorkflowRunRequestTask } from "../workflow-contracts/task.js";
import { recordRunTaskLineage } from "../lineage/run-capture.js";
import {
  authoritativeReviewTargetPaths,
  technicalResponseDiagnosticFromMessage,
} from "./review-response.js";
import { classifyThrownFailure, markRunFailure } from "../operator/failure-classification.js";
import type { WorkflowDefinition } from "../workflow-contracts/contracts.js";
import {
  assertReviewScopeFitsProposalBound,
  ReviewScopeBoundError,
  type SourceObligationSourceObserver,
} from "./source-obligation.js";

export { workflowOutcomePersistenceError } from "../workflow-contracts/run-recovery-presentation.js";

type WithoutSequence<T> = T extends unknown ? Omit<T, "sequence"> : never;
export type ProgressEventInput = WithoutSequence<ProgressEvent>;

export const incompatibleTaskLineageError =
  "Supplied task lineage did not bind to this workflow run and was rejected.";
export const patchPersistenceError =
  "Write result could not be preserved as a reviewable patch artifact.";
export const impactPostflightError =
  "Write result failed deterministic impact postflight analysis.";
export const boundedDocImprovementScopeError =
  "Write result did not exactly match the signed documentation path set.";
export const emptyWriteResultError =
  "Write workflow completed without changing any repository file.";

export function releaseExpectedRepository(
  request: RunRequest,
): ReleaseDocumentationExpectedRepositoryV1 | undefined {
  if (request.workflow !== "release-documentation-readiness") return undefined;
  if (!request.releaseDefaultBranch) return undefined;
  return {
    ...structuredClone(request.repository),
    defaultBranch: request.releaseDefaultBranch,
  };
}

export function validateTaskInput(request: RunRequest): void {
  validateWorkflowRunRequestTask(request);
}

export function taskContextTarget(request: RunRequest) {
  if (request.task?.kind === "ia-plan") return request.task.target;
  if (request.task?.kind === "bounded-doc-improvement") {
    return { sourcePath: request.task.contextSourcePath };
  }
  if (!request.contextTarget && request.reviewScope?.targetPaths.length === 1) {
    // A named-page review carries a host-resolved scope even without
    // --context-path; use that page for discovery instead of the whole corpus.
    return { sourcePath: request.reviewScope.targetPaths[0]! };
  }
  return request.contextTarget;
}

/**
 * The complete page set of a multi-page focused review. Handles only a
 * `reviewScope` with more than one target and no single context target; a
 * one-page scope keeps the `contextTarget` neighbourhood path above.
 */
export function taskContextScope(
  request: RunRequest,
): { targetPaths: readonly string[]; scopeSha256: string } | undefined {
  if (taskContextTarget(request)) return undefined;
  const scope = request.reviewScope;
  if (!scope || scope.targetPaths.length <= 1) return undefined;
  return { targetPaths: [...scope.targetPaths], scopeSha256: scope.scopeSha256 };
}

export function markContextUnnecessary(
  record: RunRecord,
  startingIndex: number,
  reason: "workflow-stopped-before-step",
  endingIndex = record.steps.length,
): void {
  for (const step of record.steps.slice(startingIndex, endingIndex)) {
    step.contextPreflight ??= { status: "unnecessary", reason };
  }
}

/** Closed technical-envelope rejection, including invalid-json and invalid-accounting. */
export function isTechnicalAdmissionStop(error: unknown): boolean {
  const message = error instanceof Error ? error.message : undefined;
  return technicalResponseDiagnosticFromMessage(message) !== undefined;
}

/**
 * Continue only after a read-only evaluate step rejected its technical envelope.
 * Write, host-operation, and cancelled failures still stop the remaining schedule.
 */
export function shouldContinueAfterTechnicalAdmissionStop(input: {
  readonly aborted: boolean;
  readonly step: {
    readonly mode: "read-only" | "write";
    readonly kind?: "inference" | "host-operation" | "evaluate";
  };
  readonly error: unknown;
}): boolean {
  if (input.aborted) return false;
  if (input.step.mode !== "read-only") return false;
  if ((input.step.kind ?? "inference") !== "evaluate") return false;
  return isTechnicalAdmissionStop(input.error);
}

/**
 * A later evaluate step may run after an admission stop only when it does not
 * consume a non-succeeded predecessor as summary or admitted sealed evidence.
 */
export function canContinueIndependentEvaluate(
  step: {
    readonly mode: "read-only" | "write";
    readonly kind?: "inference" | "host-operation" | "evaluate";
    readonly consumes?: readonly string[];
    readonly consumesEvidence?: readonly string[];
  },
  record: RunRecord,
): boolean {
  if (step.mode !== "read-only") return false;
  if ((step.kind ?? "inference") !== "evaluate") return false;
  const required = [...(step.consumes ?? []), ...(step.consumesEvidence ?? [])];
  return required.every((stepId) => {
    const prior = record.steps.find((candidate) => candidate.id === stepId);
    return prior?.status === "succeeded";
  });
}

export function durationMs(startedAt: string | undefined, completedAt: string): number {
  if (!startedAt) return 0;
  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
}

/**
 * Capture host-authenticated task lineage as content-free run evidence before
 * any step executes. Lineage that does not bind to this workflow and revision
 * fails immediately with a content-free diagnostic, so the run cannot reach
 * publication eligibility with incompatible lineage.
 */
export async function captureRequestLineage(input: {
  store: RunStore;
  record: RunRecord;
  request: RunRequest;
  completedAt: string;
}): Promise<boolean> {
  const { store, record, request, completedAt } = input;
  if (!request.taskLineage) return true;
  try {
    recordRunTaskLineage(record, request.taskLineage);
    return true;
  } catch {
    record.status = "failed";
    record.error = incompatibleTaskLineageError;
    markRunFailure(record, "task-lineage-incompatible");
    record.completedAt = completedAt;
    record.durationMs = 0;
    markContextUnnecessary(record, 0, "workflow-stopped-before-step");
    await saveBestEffort(store, record);
    return false;
  }
}

/**
 * Refuse a `review-documentation` run, before any step or model call, when the
 * host-filled coverage for its target pages alone exceeds the technical
 * correction's proposal bound (`assertReviewScopeFitsProposalBound`). A review
 * with no named pages targets every documentation page the observer would
 * admit into the step's sealed source authority.
 */
export async function admitReviewScopeCapacity(input: {
  store: RunStore;
  record: RunRecord;
  request: RunRequest;
  workflow: WorkflowDefinition;
  observer?: SourceObligationSourceObserver;
  completedAt: () => string;
}): Promise<boolean> {
  const { store, record, request, workflow } = input;
  if (workflow.name !== "review-documentation" || workflow.steps.length === 0) return true;
  const targets =
    authoritativeReviewTargetPaths({
      workflow,
      step: workflow.steps[0]!,
      ...(request.reviewScope ? { reviewScope: request.reviewScope } : {}),
      ...(request.contextTarget ? { contextTarget: request.contextTarget } : {}),
    }) ??
    // An unreadable snapshot is left to the step that seals the authority,
    // which records it as that step's failure.
    (await input.observer?.reviewDocumentationTargetPaths?.().catch(() => undefined));
  if (!targets) return true;
  try {
    assertReviewScopeFitsProposalBound(targets);
    return true;
  } catch (error) {
    if (!(error instanceof ReviewScopeBoundError)) throw error;
    record.status = "failed";
    record.error = error.message;
    record.failure = classifyThrownFailure(error, "workflow");
    record.completedAt = input.completedAt();
    record.durationMs = 0;
    markContextUnnecessary(record, 0, "workflow-stopped-before-step");
    await saveBestEffort(store, record);
    return false;
  }
}

export async function saveBestEffort(store: RunStore, record: RunRecord): Promise<void> {
  try {
    await store.save(record);
  } catch {
    // The original infrastructure failure remains authoritative.
  }
}
