// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { sha256 } from "../content-ir/canonical.js";
import type {
  ReviewCheckV1,
  ReviewCoverageV1,
  ReviewFindingV1,
  ReviewTargetV2,
} from "../review/contracts.js";
import { reviewResultFromRun, type ReviewRunBinding } from "../review/run-result.js";
import {
  inspectQualityReportFromRun,
  type QualityReportProjection,
} from "../evaluation-report/index.js";
import { getWorkflow } from "../workflow-registry/catalog.js";
import type { LiveWorkflowRun } from "./workflow-delivery.js";
import type { DocumentationWorkSelectionV1 } from "./documentation-work-selection.js";

export type DocumentationWorkCompletionStatusV1 = "completed" | "partial" | "not-assessed";

export type DocumentationWorkCompletionLimitationV1 =
  | "selection-not-executable"
  | "workflow-mismatch"
  | "workflow-step-incomplete"
  | "run-not-successful"
  | "run-cancelled"
  | "documentation-scope-unavailable"
  | "documentation-scope-incomplete"
  | "documentation-result-unavailable"
  | "review-result-unavailable"
  | "review-binding-unavailable"
  | "review-binding-invalid"
  | "review-binding-stale"
  | "incidental-code-findings-unclassified"
  | "impact-not-assessed";

export interface DocumentationWorkCompletionV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-documentation-work-completion";
  readonly status: DocumentationWorkCompletionStatusV1;
  readonly selectionKind: DocumentationWorkSelectionV1["kind"];
  readonly runId: string;
  readonly workflow: string;
  readonly repositoryRevision: string;
  /** Exact provider target when the shared source-bound review result was built. */
  readonly reviewTarget?: ReviewTargetV2;
  /** Shared review checks and findings stay distinct from scope and coverage. */
  readonly checks?: readonly ReviewCheckV1[];
  readonly findings?: readonly ReviewFindingV1[];
  readonly coverage?: ReviewCoverageV1;
  /** Canonical structured documentation-quality result bound to this run. */
  readonly documentationResult?: QualityReportProjection;
  readonly documentationScope: {
    readonly status: "complete" | "partial" | "not-assessed";
    readonly scopeSha256?: string;
    readonly reviewedPaths: readonly string[];
    readonly deferredPaths: readonly string[];
    readonly reviewRevision?: string;
  };
  /** The shared result has no stable code-vs-documentation finding taxonomy yet. */
  readonly incidentalCodeFindings: {
    readonly status: "not-assessed";
    readonly count: null;
  };
  /** An empty finding list alone is not a documentation-impact conclusion. */
  readonly impactDisposition: "not-assessed";
  readonly limitations: readonly DocumentationWorkCompletionLimitationV1[];
}

export interface ProjectDocumentationWorkCompletionInputV1 {
  readonly selection: DocumentationWorkSelectionV1;
  readonly run: LiveWorkflowRun;
  /** Host observation that this selected documentation review was requested for a PR. */
  readonly pullRequestReviewExpected?: boolean;
  /** Exact frozen binding from the shared PR review acquisition path. */
  readonly reviewBinding?: ReviewRunBinding;
  readonly signal?: AbortSignal;
}

/** Project observed method execution and shared review evidence without judging its prose. */
export function projectDocumentationWorkCompletion(
  input: ProjectDocumentationWorkCompletionInputV1,
): DocumentationWorkCompletionV1 {
  const { run, selection } = input;
  const limitations = new Set<DocumentationWorkCompletionLimitationV1>();
  const scope = run.reviewScope;
  const reviewedPaths = strings(scope?.targetPaths);
  const deferredPaths = strings(scope?.deferredPaths);
  const scopeValid =
    scope !== undefined &&
    scope.scope === "focused-set" &&
    isDigest(scope.scopeSha256) &&
    (scope.corpusFileCount === null ||
      (Number.isSafeInteger(scope.corpusFileCount) && (scope.corpusFileCount as number) >= 0)) &&
    reviewedPaths !== undefined &&
    deferredPaths !== undefined &&
    new Set([...reviewedPaths, ...deferredPaths]).size ===
      reviewedPaths.length + deferredPaths.length;
  if (!scopeValid) limitations.add("documentation-scope-unavailable");

  const selectionSupportsReview =
    selection.kind === "workflow" && selection.workflowId === "review-documentation";
  if (!selectionSupportsReview) limitations.add("selection-not-executable");
  else if (run.workflow !== selection.workflowId) limitations.add("workflow-mismatch");

  let requiredMethodsExecuted = false;
  if (selectionSupportsReview && run.workflow === selection.workflowId) {
    const expectedSteps = getWorkflowSteps(selection.workflowId);
    requiredMethodsExecuted =
      expectedSteps.length > 0 &&
      expectedSteps.every((expected) =>
        run.steps.some(
          (step) =>
            step.id === expected.id && step.skill === expected.skill && step.status === "succeeded",
        ),
      );
    if (!requiredMethodsExecuted) {
      limitations.add("workflow-step-incomplete");
    }
  }

  const allStepsSucceeded =
    run.steps.length > 0 && run.steps.every((step) => step.status === "succeeded");
  if (
    run.status !== "succeeded" ||
    run.livePersistence?.status === "failed" ||
    !allStepsSucceeded
  ) {
    limitations.add("run-not-successful");
  }
  if (input.signal?.aborted) limitations.add("run-cancelled");

  const accounting = scope?.accounting;
  const accountingConsistent =
    accounting !== undefined &&
    Number.isSafeInteger(accounting.radiusPageCount) &&
    accounting.radiusPageCount >= 0 &&
    Number.isSafeInteger(accounting.listedPageCount) &&
    accounting.listedPageCount === (reviewedPaths?.length ?? 0) + (deferredPaths?.length ?? 0) &&
    Number.isSafeInteger(accounting.unlistedPageCount) &&
    accounting.unlistedPageCount >= 0 &&
    accounting.radiusPageCount === accounting.listedPageCount + accounting.unlistedPageCount &&
    Number.isSafeInteger(accounting.unreviewableNeighbourCount) &&
    accounting.unreviewableNeighbourCount >= 0 &&
    (scope?.corpusFileCount === null ||
      (typeof scope?.corpusFileCount === "number" &&
        Number.isSafeInteger(scope.corpusFileCount) &&
        scope.corpusFileCount >= accounting.radiusPageCount));
  const scopeComplete =
    scopeValid &&
    accountingConsistent &&
    reviewedPaths!.length > 0 &&
    scope!.corpusFileCount !== null &&
    scope!.corpusFileCount > 0 &&
    deferredPaths!.length === 0 &&
    scope!.accounting !== undefined &&
    accounting!.unlistedPageCount === 0 &&
    accounting!.unreviewableNeighbourCount === 0;
  if (scopeValid && !scopeComplete) limitations.add("documentation-scope-incomplete");

  const inspectedDocumentationResult = inspectQualityReportFromRun(run);
  const documentationResult = inspectedDocumentationResult.quality ?? undefined;
  if (documentationResult === undefined) {
    limitations.add("documentation-result-unavailable");
  }

  const expectsPullRequest =
    input.pullRequestReviewExpected === true || (run.changeSources?.length ?? 0) > 0;
  let reviewTarget: ReviewTargetV2 | undefined;
  let checks: readonly ReviewCheckV1[] | undefined;
  let findings: readonly ReviewFindingV1[] | undefined;
  let coverage: ReviewCoverageV1 | undefined;

  if (expectsPullRequest && input.reviewBinding === undefined) {
    limitations.add("review-binding-unavailable");
  } else if (input.reviewBinding !== undefined) {
    if (input.reviewBinding.target.schemaVersion !== 2) {
      limitations.add("review-binding-invalid");
    } else if (
      input.reviewBinding.target.headSha !== run.repository.revision ||
      input.reviewBinding.target.workflow !== run.workflow
    ) {
      limitations.add("review-binding-stale");
    } else {
      try {
        const result = reviewResultFromRun(
          run,
          input.reviewBinding,
          undefined,
          undefined,
          undefined,
          {
            unprovenQualityReport: "label",
          },
        );
        if (result.schemaVersion !== 4 && result.schemaVersion !== 6) {
          limitations.add("review-binding-invalid");
        } else if (
          result.runIdSha256 !== sha256(run.id) ||
          result.reviewedHeadSha !== run.repository.revision ||
          result.target.headSha !== run.repository.revision ||
          result.target.workflow !== run.workflow ||
          (result.reviewScope !== undefined &&
            result.reviewScope.reviewRevision !== run.repository.revision)
        ) {
          limitations.add("review-binding-stale");
        } else {
          reviewTarget = result.target;
          checks = result.checks;
          findings = result.findings;
          coverage = result.reviewScope;
          if (coverage === undefined) limitations.add("review-result-unavailable");
        }
      } catch {
        limitations.add("review-binding-invalid");
      }
    }
  }

  if (reviewTarget !== undefined && coverage === undefined) {
    limitations.add("review-result-unavailable");
  }
  if (findings === undefined && expectsPullRequest) limitations.add("review-result-unavailable");
  if ((findings?.length ?? 0) > 0) limitations.add("incidental-code-findings-unclassified");
  limitations.add("impact-not-assessed");

  const documentationScope = {
    status: !scopeValid
      ? ("not-assessed" as const)
      : scopeComplete && !input.signal?.aborted
        ? ("complete" as const)
        : ("partial" as const),
    ...(scopeValid ? { scopeSha256: scope!.scopeSha256 } : {}),
    reviewedPaths: reviewedPaths ?? [],
    deferredPaths: deferredPaths ?? [],
    ...(scopeValid ? { reviewRevision: run.repository.revision } : {}),
  };

  const ready =
    selectionSupportsReview &&
    run.workflow === "review-documentation" &&
    run.status === "succeeded" &&
    run.livePersistence?.status !== "failed" &&
    allStepsSucceeded &&
    requiredMethodsExecuted &&
    scopeComplete &&
    documentationResult !== undefined &&
    !input.signal?.aborted &&
    (!expectsPullRequest || (reviewTarget !== undefined && coverage !== undefined));

  return Object.freeze({
    schemaVersion: 1,
    kind: "docsfab-documentation-work-completion",
    status: ready ? "completed" : !selectionSupportsReview ? "not-assessed" : "partial",
    selectionKind: selection.kind,
    runId: run.id,
    workflow: run.workflow,
    repositoryRevision: run.repository.revision,
    ...(reviewTarget ? { reviewTarget } : {}),
    ...(checks ? { checks } : {}),
    ...(findings ? { findings } : {}),
    ...(coverage ? { coverage } : {}),
    ...(documentationResult ? { documentationResult } : {}),
    documentationScope,
    incidentalCodeFindings: { status: "not-assessed" as const, count: null },
    impactDisposition: "not-assessed",
    limitations: Object.freeze([...limitations]),
  });
}

function getWorkflowSteps(workflow: "review-documentation") {
  // Keep execution matching against the registered workflow, not a copied skill list.
  return getWorkflow(workflow).steps.map((step) => ({ id: step.id, skill: step.skill }));
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function strings(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}
