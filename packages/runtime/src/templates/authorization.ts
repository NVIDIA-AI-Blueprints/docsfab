// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  validateArtifact,
  type Artifact,
  type ArtifactReference,
  type IaEvaluationArtifact,
  type IaPlanArtifact,
} from "../artifacts/index.js";
import type { ContentIndexV1 } from "../content-ir/index.js";
import { assertIaEvaluationPassed, type EvaluateIaCandidateInput } from "../ia/evaluator.js";
import type { ApprovedTemplatePlan } from "./contracts.js";
import type { TemplatePreviewTopic } from "./contracts.js";
import { TEMPLATE_SELECTION_POLICY, templateSelectionDigest } from "./selection.js";
import { MAX_TEMPLATE_OUTPUTS } from "./paths.js";

export class TemplateAuthorizationError extends Error {
  public constructor(
    public readonly code:
      | "invalid-plan"
      | "evaluation-mismatch"
      | "selection-mismatch"
      | "write-not-approved"
      | "unsupported-output",
  ) {
    super(`Template scaffold authorization failed: ${code}.`);
    this.name = "TemplateAuthorizationError";
  }
}

/**
 * Converts validated durable artifacts into the narrow read-only preview
 * authorization. Write operations must call this immediately before preview
 * and path preflight; an untrusted model cannot manufacture this proof.
 */
export function authorizeTemplateScaffold(input: {
  index: ContentIndexV1;
  plan: IaPlanArtifact;
  evaluation: IaEvaluationArtifact;
  evaluationInput: EvaluateIaCandidateInput;
  topics: readonly TemplatePreviewTopic[];
  templateCatalog: { id: string; version: string; digest: string };
  repositoryChecks: { id: string; version: string; digest: string };
  now: Date;
}): ApprovedTemplatePlan {
  let plan: Artifact;
  try {
    plan = validateArtifact(input.plan, { index: input.index, now: input.now });
  } catch {
    throw new TemplateAuthorizationError("invalid-plan");
  }
  if (plan.kind !== "ia-plan") throw new TemplateAuthorizationError("invalid-plan");
  try {
    assertIaEvaluationPassed(input.evaluation, input.evaluationInput);
  } catch {
    throw new TemplateAuthorizationError("evaluation-mismatch");
  }
  if (
    plan.payload.candidateId !== input.evaluation.payload.candidateId ||
    !sameReference(plan.payload.candidateArtifact, input.evaluation.payload.candidateArtifact) ||
    !sameReference(plan.payload.navigationEvaluation, input.evaluation.payload.navigationEvaluation)
  ) {
    throw new TemplateAuthorizationError("evaluation-mismatch");
  }
  if (
    plan.payload.approval.status !== "approved" ||
    plan.payload.approval.requirement === "none" ||
    !plan.payload.approval.approvedBy ||
    !plan.payload.approval.approvedAt
  ) {
    throw new TemplateAuthorizationError("write-not-approved");
  }
  if (
    plan.payload.outputScope.length === 0 ||
    plan.payload.outputScope.length > MAX_TEMPLATE_OUTPUTS ||
    plan.payload.outputScope.some((output) => output.operation !== "create")
  ) {
    throw new TemplateAuthorizationError("unsupported-output");
  }
  const selectionDigest = templateSelectionDigest(input.topics);
  const selectedPaths = [...input.topics].map((topic) => topic.outputPath).sort();
  const approvedPaths = plan.payload.outputScope.map((output) => output.path).sort();
  if (
    selectedPaths.length !== approvedPaths.length ||
    selectedPaths.some((path, index) => path !== approvedPaths[index])
  ) {
    throw new TemplateAuthorizationError("selection-mismatch");
  }
  const selection = plan.payload.policyBindings.find(
    (binding) =>
      binding.id === TEMPLATE_SELECTION_POLICY.id &&
      binding.version === TEMPLATE_SELECTION_POLICY.version,
  );
  if (!selection || selection.digest !== selectionDigest) {
    throw new TemplateAuthorizationError("selection-mismatch");
  }
  if (
    !hasPolicyBinding(plan.payload.policyBindings, input.templateCatalog) ||
    !hasPolicyBinding(plan.payload.policyBindings, input.repositoryChecks)
  ) {
    throw new TemplateAuthorizationError("selection-mismatch");
  }
  return {
    schemaVersion: 1,
    kind: "ia-plan",
    digest: plan.digest,
    repository: { ...plan.repository },
    planId: plan.payload.planId,
    candidateId: plan.payload.candidateId,
    iaEvaluation: {
      kind: "ia-evaluation",
      digest: input.evaluation.digest,
      repositoryRevision: input.evaluation.repository.revision,
      repositoryContentDigest: input.evaluation.repository.contentDigest,
      eligible: true,
    },
    templateSelectionDigest: selectionDigest,
    templateCatalogDigest: input.templateCatalog.digest,
    repositoryCheckPolicy: { ...input.repositoryChecks },
    approval: {
      status: "approved",
      requirement: plan.payload.approval.requirement,
      approvedBy: plan.payload.approval.approvedBy,
      approvedAt: plan.payload.approval.approvedAt,
    },
    expiresAt: plan.payload.expiresAt,
    outputs: plan.payload.outputScope.map((output) => ({
      path: output.path,
      operation: "create" as const,
    })),
  };
}

function hasPolicyBinding(
  bindings: readonly { id: string; version: string; digest: string }[],
  expected: { id: string; version: string; digest: string },
): boolean {
  return bindings.some(
    (binding) =>
      binding.id === expected.id &&
      binding.version === expected.version &&
      binding.digest === expected.digest,
  );
}

function sameReference<K extends "ia-candidates" | "navigation-evaluation">(
  left: ArtifactReference<K>,
  right: ArtifactReference<K>,
): boolean {
  return (
    left.kind === right.kind &&
    left.schemaVersion === right.schemaVersion &&
    left.digest === right.digest &&
    left.repositoryRevision === right.repositoryRevision &&
    left.repositoryContentDigest === right.repositoryContentDigest
  );
}
