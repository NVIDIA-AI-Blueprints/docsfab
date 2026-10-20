// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DurableArtifactStore } from "../artifacts/index.js";
import type { RunRecord } from "../records/contracts.js";
import {
  loadVerifiedReviewEvaluationArtifact,
  projectReviewFindingsFromRetainedRun,
  type ProjectedReviewFindingsV1,
  type VerifiedReviewEvaluationArtifactV1,
} from "../review/index.js";
import type { JsonEvidenceValue } from "./json-evidence.js";

export type ReviewMethodEvidence = "static-read-only" | "not-established";
export type PackageCheckEvidence = "not-executed" | "not-established";
export type ArtifactValidatorEvidence = "passed" | "unavailable" | "invalid";
export type AudienceOutcomeEvidence = "unavailable" | "model-claimed-only";

export interface ReviewEvidenceProjectionV1 {
  readonly reviewMethod: ReviewMethodEvidence;
  readonly packageChecks: PackageCheckEvidence;
  readonly artifactValidators: ArtifactValidatorEvidence;
  readonly audience: {
    readonly human: AudienceOutcomeEvidence;
    readonly agent: AudienceOutcomeEvidence;
  };
}

export interface LoadedReviewPresentationV1 {
  readonly findings: ProjectedReviewFindingsV1;
  readonly evidence: ReviewEvidenceProjectionV1 | null;
}

const REVIEW_STEP_IDS = new Set([
  "audit-documentation",
  "lint-documentation",
  "verify-technical-accuracy",
  "review-documentation",
  "test-audience-understanding",
  "evaluate-document-quality",
]);
// Keep this light operator projection synchronized with harness/canon-tools.ts
// without importing the harness implementation into the operator edge.
const STATIC_TOOL_NAMES = new Set([
  "read",
  "find",
  "grep",
  "ls",
  "canon_query",
  "canon_conflict_gap",
  "canon_affected_docs",
  "canon_validate_citations",
  "canon_propose_claim",
  "canon_submit_artifact",
]);

/**
 * Load the retained findings and their execution/evidence projection. Artifact
 * content is admitted only through the bound loader, and model-authored
 * audience claims stay claims after their payload validates.
 */
export async function loadReviewPresentation(
  record: RunRecord,
  store: DurableArtifactStore,
): Promise<LoadedReviewPresentationV1> {
  const findings = await projectReviewFindingsFromRetainedRun(record, store);
  let verified: VerifiedReviewEvaluationArtifactV1 | null = null;
  if (
    findings.artifactLocator !== null &&
    (findings.availability === "complete" || findings.availability === "partial")
  ) {
    try {
      verified = await loadVerifiedReviewEvaluationArtifact(record, store);
    } catch {
      // The findings projection already carries the bounded loader failure.
      // A second read can race local state removal; do not invent payload facts.
    }
  }
  return Object.freeze({
    findings,
    evidence: record.steps.some(
      (step) =>
        step.id === "evaluate-document-quality" && step.skill === "evaluate-document-quality",
    )
      ? projectReviewEvidence(record, findings, verified)
      : null,
  });
}

export function reviewEvidenceLimitations(evidence: ReviewEvidenceProjectionV1): readonly string[] {
  return Object.freeze([
    evidence.reviewMethod === "static-read-only"
      ? "review-method-static-read-only"
      : "review-method-not-established",
    evidence.packageChecks === "not-executed"
      ? "package-command-checks-not-executed"
      : "package-command-checks-not-established",
    `human-audience-evidence-${evidence.audience.human}`,
    `agent-audience-evidence-${evidence.audience.agent}`,
  ]);
}

function projectReviewEvidence(
  record: RunRecord,
  findings: ProjectedReviewFindingsV1,
  verified: VerifiedReviewEvaluationArtifactV1 | null,
): ReviewEvidenceProjectionV1 {
  const reviewMethod = staticReviewWasObserved(record) ? "static-read-only" : "not-established";
  const outcomes = object(verified?.payload.outcomes);
  return Object.freeze({
    reviewMethod,
    packageChecks: reviewMethod === "static-read-only" ? "not-executed" : "not-established",
    artifactValidators:
      verified !== null
        ? "passed"
        : findings.availability === "invalid"
          ? "invalid"
          : "unavailable",
    audience: Object.freeze({
      human: audienceEvidence(outcomes?.human),
      agent: audienceEvidence(outcomes?.agent),
    }),
  });
}

function staticReviewWasObserved(record: RunRecord): boolean {
  const reviewSteps = record.steps.filter((step) => REVIEW_STEP_IDS.has(step.id));
  const successfulReviewWasObserved = reviewSteps.some((step) => step.status === "succeeded");
  if (record.workflow !== "review-documentation" || !successfulReviewWasObserved) return false;
  if (
    reviewSteps.some(
      (step) => step.kind === "host-operation" && (step.tools?.totalCalls ?? 0) === 0,
    )
  ) {
    return false;
  }
  const calledTools = reviewSteps.flatMap((step) =>
    (step.tools?.byTool ?? []).filter((tool) => tool.calls > 0).map((tool) => tool.name),
  );
  return (
    calledTools.length > 0 &&
    reviewSteps.every((step) => step.mode === "read-only") &&
    calledTools.every((name) => STATIC_TOOL_NAMES.has(name))
  );
}

function audienceEvidence(value: JsonEvidenceValue | undefined): AudienceOutcomeEvidence {
  return Array.isArray(value) && value.length > 0 ? "model-claimed-only" : "unavailable";
}

function object(
  value: JsonEvidenceValue | undefined,
): Readonly<Record<string, JsonEvidenceValue>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
