// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { QualityArtifactCandidateV1 } from "../../execution/contracts.js";
import type { QualityHostDerivationCountsV1 } from "../../records/contracts.js";
import { describeEvaluationTarget, type EvaluationTargetEntryV1 } from "../evaluation-target.js";
import { hostCheckError } from "../quality-check-rejections.js";
import type { QualityDerivationInputV1, QualityDerivationOutcomeV1 } from "./derivation.js";

export interface FullArtifactProjectionContext {
  readonly targetScope: string;
  readonly evaluationTarget: readonly EvaluationTargetEntryV1[];
  readonly profileModel: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly profileConstraints: unknown;
  readonly profileApplicability: unknown;
}

export interface FullArtifactTrustedMetadata {
  readonly runId: string;
  readonly repositoryRevision: string;
  readonly evaluatorStepId: string;
  readonly evaluatorAttempt: number;
  readonly evaluatedAt: string;
  readonly evaluatorProviderId?: string;
}

export type FullArtifactDerivationPreparation =
  | { readonly kind: "staging"; readonly candidate: QualityArtifactCandidateV1 }
  | {
      readonly kind: "derive";
      readonly candidateForStaging: QualityArtifactCandidateV1;
      readonly derivationInput: QualityDerivationInputV1;
      readonly originalEvaluation: Record<string, unknown>;
      readonly modelLayers: Record<string, unknown>;
      readonly originalQualityScore: Record<string, unknown> | null;
    };

export interface FullArtifactProjectionResult {
  readonly candidate: QualityArtifactCandidateV1;
  readonly adjustments: readonly string[];
  readonly hostDerivationCounts: QualityHostDerivationCountsV1;
}

/** Prepare a full-artifact candidate without running the locked deriver. */
export function prepareFullArtifactDerivation(
  candidate: QualityArtifactCandidateV1,
  trusted: FullArtifactTrustedMetadata,
  context: FullArtifactProjectionContext,
  evaluationVersion: string,
): FullArtifactDerivationPreparation {
  if (!candidate.answerPath) return { kind: "staging", candidate };
  const { answerPath: _answerPath, ...candidateForStaging } = candidate;
  const rawPassThrough = (): FullArtifactDerivationPreparation => ({
    kind: "staging",
    candidate: candidateForStaging,
  });
  if (
    !candidate.evaluation ||
    typeof candidate.evaluation !== "object" ||
    Array.isArray(candidate.evaluation)
  ) {
    return rawPassThrough();
  }
  const evaluation = asRecord(candidate.evaluation);
  const rawTarget = evaluation.target;
  const target =
    rawTarget && typeof rawTarget === "object" && !Array.isArray(rawTarget)
      ? asRecord(rawTarget)
      : rawTarget === undefined
        ? {}
        : undefined;
  const hostTarget = target
    ? {
        ...target,
        scope_type: context.targetScope,
        paths: context.evaluationTarget.map((entry) => entry.path),
        repository_revision: trusted.repositoryRevision,
        documentation_revision: trusted.repositoryRevision,
        approved_evidence_revision: trusted.repositoryRevision,
        delivery_surface_locator: describeEvaluationTarget(context.evaluationTarget),
      }
    : rawTarget;
  const profileConstraints = asRecord(context.profileConstraints);
  const expectedConstraintIds = [
    ...(Array.isArray(profileConstraints.required) ? profileConstraints.required : []),
    ...(Array.isArray(profileConstraints.conditional) ? profileConstraints.conditional : []),
  ].filter((id): id is string => typeof id === "string");
  const requiredConstraintKeys = new Set(
    (Array.isArray(profileConstraints.required) ? profileConstraints.required : [])
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.replaceAll("-", "_")),
  );
  const rawConstraints = evaluation.constraints;
  const partiallyFilledConstraints =
    rawConstraints && typeof rawConstraints === "object" && !Array.isArray(rawConstraints)
      ? Object.fromEntries(
          Object.entries(asRecord(rawConstraints)).map(([key, value]) => {
            const id = expectedConstraintIds.find(
              (expected) => expected.replaceAll("-", "_") === key,
            );
            if (!id || !value || typeof value !== "object" || Array.isArray(value)) {
              return [key, value];
            }
            return [
              key,
              {
                ...asRecord(value),
                dimension_id: id,
                ...(requiredConstraintKeys.has(key) ? { applicability: "required" } : {}),
              },
            ];
          }),
        )
      : rawConstraints;
  const rawFindings = evaluation.findings;
  const hostFindings = Array.isArray(rawFindings)
    ? rawFindings.map((finding, index) => {
        if (!finding || typeof finding !== "object" || Array.isArray(finding)) return finding;
        return {
          ...asRecord(finding),
          id: `F-${index + 1}`,
          owner: "documentation-owner",
          status: "open",
        };
      })
    : rawFindings;
  const hostEvaluation: Record<string, unknown> = {
    ...evaluation,
    evaluation_id: `${trusted.runId}:${trusted.evaluatorStepId}:${trusted.evaluatorAttempt}`,
    evaluation_version: evaluationVersion,
    evaluated_at: trusted.evaluatedAt,
    model_version: context.profileModel,
    profile: {
      id: context.profileId,
      version: context.profileVersion,
    },
    evaluator: {
      ...(trusted.evaluatorProviderId ? { provider_id: trusted.evaluatorProviderId } : {}),
      provider_type: "agent",
      independent_of_authors: false,
      independence_evidence:
        "The host bound the configured evaluator identity, but no author-independence evidence was admitted.",
    },
    ...(hostTarget !== undefined ? { target: hostTarget } : {}),
    outcomes: { human: [], agent: [] },
    ...(partiallyFilledConstraints !== undefined
      ? { constraints: partiallyFilledConstraints }
      : {}),
    ...(hostFindings !== undefined ? { findings: hostFindings } : {}),
  };
  const passThrough = (): FullArtifactDerivationPreparation => ({
    kind: "staging",
    candidate: { ...candidateForStaging, evaluation: hostEvaluation },
  });
  if (
    !evaluation.layers ||
    typeof evaluation.layers !== "object" ||
    Array.isArray(evaluation.layers)
  ) {
    return passThrough();
  }
  if (!target) return passThrough();
  // Preserve malformed authored constraints for the locked validator to reject.
  if (
    !hostEvaluation.constraints ||
    typeof hostEvaluation.constraints !== "object" ||
    Array.isArray(hostEvaluation.constraints)
  ) {
    return passThrough();
  }
  const layers = asRecord(evaluation.layers);
  const constraints = asRecord(hostEvaluation.constraints);
  if (
    Object.keys(constraints).length !== expectedConstraintIds.length ||
    expectedConstraintIds.some((id) => !Object.hasOwn(constraints, id.replaceAll("-", "_")))
  ) {
    return passThrough();
  }
  if (
    expectedConstraintIds.some((id) => {
      const constraint = constraints[id.replaceAll("-", "_")];
      return !constraint || typeof constraint !== "object" || Array.isArray(constraint);
    })
  ) {
    return passThrough();
  }
  const applicability = asRecord(context.profileApplicability);
  const documentationSet = asRecord(applicability.documentation_set);
  const expectedDimensions = asRecord(documentationSet.required_dimensions_by_layer);
  if (
    Object.keys(expectedDimensions).length !== Object.keys(layers).length ||
    Object.keys(expectedDimensions).some((layerId) => !Object.hasOwn(layers, layerId))
  ) {
    return passThrough();
  }
  const hostLayers: Record<string, unknown> = {};
  for (const [layerId, rawLayer] of Object.entries(layers)) {
    if (!rawLayer || typeof rawLayer !== "object" || Array.isArray(rawLayer)) {
      return passThrough();
    }
    const layer = asRecord(rawLayer);
    const expectedIds = expectedDimensions[layerId];
    if (
      !Array.isArray(expectedIds) ||
      !Array.isArray(layer.dimensions) ||
      !layer.dimensions.every(
        (dimension) =>
          dimension !== null &&
          typeof dimension === "object" &&
          !Array.isArray(dimension) &&
          typeof asRecord(dimension).dimension_id === "string",
      )
    ) {
      return passThrough();
    }
    const byId = new Map<string, Record<string, unknown>>();
    for (const rawDimension of layer.dimensions) {
      const dimension = asRecord(rawDimension);
      const dimensionId = dimension.dimension_id as string;
      if (!expectedIds.includes(dimensionId) || byId.has(dimensionId)) return passThrough();
      byId.set(dimensionId, dimension);
    }
    if (expectedIds.some((dimensionId) => !byId.has(dimensionId))) return passThrough();
    hostLayers[layerId] = {
      ...layer,
      dimensions: expectedIds.map((dimensionId) => byId.get(dimensionId)!),
    };
  }
  const hostConstraints = Object.fromEntries(
    expectedConstraintIds.map((id) => {
      const key = id.replaceAll("-", "_");
      const required =
        Array.isArray(profileConstraints.required) && profileConstraints.required.includes(id);
      return [
        key,
        {
          ...asRecord(constraints[key]),
          dimension_id: id,
          ...(required ? { applicability: "required" } : {}),
        },
      ];
    }),
  );
  const completedHostEvaluation = {
    ...hostEvaluation,
    layers: hostLayers,
    constraints: hostConstraints,
    findings: hostFindings,
  };
  const layerEntries = Object.values(layers);
  if (
    !Array.isArray(evaluation.hard_gate_failures) ||
    !evaluation.hard_gate_failures.every((gate) => typeof gate === "string") ||
    !Array.isArray(evaluation.limitations) ||
    !evaluation.limitations.every((limitation) => typeof limitation === "string") ||
    !layerEntries.every((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const layer = asRecord(entry);
      return (
        Array.isArray(layer.hard_gate_failures) &&
        layer.hard_gate_failures.every((gate) => typeof gate === "string")
      );
    })
  ) {
    // Preserve malformed model-owned fields for the locked validator to reject.
    return passThrough();
  }
  const textLayerGates: Record<string, readonly string[]> = {};
  const layerShortfallDecisions: Record<string, string> = {};
  for (const [layerId, rawLayer] of Object.entries(layers)) {
    const layer = asRecord(rawLayer);
    textLayerGates[layerId] = layer.hard_gate_failures as string[];
    if (typeof layer.decision === "string") {
      layerShortfallDecisions[layerId] = layer.decision;
    }
  }
  return {
    kind: "derive",
    candidateForStaging: { ...candidateForStaging, evaluation: completedHostEvaluation },
    derivationInput: {
      schemaVersion: 1,
      kind: "docsfab-quality-derivation-input",
      evaluation: completedHostEvaluation,
      qualityScore: candidate.qualityScore,
      gateAttribution: {},
      layerShortfallDecisions,
      textPathGates: {
        layers: textLayerGates,
        overall: evaluation.hard_gate_failures as string[],
      },
    },
    originalEvaluation: evaluation,
    modelLayers: layers,
    originalQualityScore: candidate.qualityScore,
  };
}

/** Apply a successful derivation and return only the host-authored projections. */
export function projectFullArtifactDerivation(
  prepared: Extract<FullArtifactDerivationPreparation, { kind: "derive" }>,
  derived: Extract<QualityDerivationOutcomeV1, { status: "derived" }>,
): FullArtifactProjectionResult {
  const modelLimitations = prepared.originalEvaluation.limitations as string[];
  const hostLimitations = new Set(derived.hostLimitations);
  const duplicateLimitationsRemoved = modelLimitations.filter((limitation) =>
    hostLimitations.has(limitation),
  ).length;
  const retainedModelLimitations = modelLimitations.filter(
    (limitation) => !hostLimitations.has(limitation),
  );
  const adaptedEvaluation = {
    ...derived.evaluation,
    limitations: [...retainedModelLimitations, ...derived.hostLimitations],
  };
  const hostMetadataFieldsChanged = countEvaluationMetadataChanges(
    prepared.originalEvaluation,
    adaptedEvaluation,
  );
  const ruleDerivedFieldsChanged = countRuleDerivedChanges(
    prepared.originalEvaluation,
    adaptedEvaluation,
    prepared.originalQualityScore,
    derived.qualityScore,
  );
  const adjustments: string[] = [];
  if (hostMetadataFieldsChanged > 0 || ruleDerivedFieldsChanged > 0) {
    adjustments.push(
      `The host supplied or replaced ${hostMetadataFieldsChanged} host-owned metadata field${hostMetadataFieldsChanged === 1 ? "" : "s"} and derived ${ruleDerivedFieldsChanged} rule-derived field${ruleDerivedFieldsChanged === 1 ? "" : "s"}; counts only.`,
    );
  }
  if (duplicateLimitationsRemoved > 0) {
    adjustments.push(
      `The host removed ${duplicateLimitationsRemoved} byte-identical duplicate quality-profile limitation note${duplicateLimitationsRemoved === 1 ? "" : "s"}.`,
    );
  }
  return {
    candidate: {
      ...prepared.candidateForStaging,
      evaluation: adaptedEvaluation,
      qualityScore: derived.qualityScore,
    },
    adjustments,
    hostDerivationCounts: {
      schemaVersion: 1,
      kind: "docsfab-quality-host-derivation-counts",
      hostMetadataFieldsChanged,
      ruleDerivedFieldsChanged,
      duplicateLimitationsRemoved,
      coherenceLabelsCount: derived.coherenceLabels.length,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw hostCheckError("report-artifact-not-object");
  }
  return value as Record<string, unknown>;
}

function countEvaluationMetadataChanges(
  original: Record<string, unknown>,
  adapted: Record<string, unknown>,
): number {
  let changes = 0;
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const count = (before: unknown, after: unknown): void => {
    if (JSON.stringify(before) !== JSON.stringify(after)) changes += 1;
  };
  for (const field of [
    "evaluation_id",
    "evaluation_version",
    "evaluated_at",
    "model_version",
    "profile",
    "evaluator",
    "outcomes",
  ]) {
    count(original[field], adapted[field]);
  }
  const beforeTarget = record(original.target);
  const afterTarget = record(adapted.target);
  for (const field of [
    "scope_type",
    "paths",
    "repository_revision",
    "documentation_revision",
    "approved_evidence_revision",
    "delivery_surface_locator",
  ]) {
    count(beforeTarget[field], afterTarget[field]);
  }
  const beforeConstraints = record(original.constraints);
  const afterConstraints = record(adapted.constraints);
  for (const key of Object.keys(afterConstraints)) {
    count(record(beforeConstraints[key]).dimension_id, record(afterConstraints[key]).dimension_id);
  }
  const beforeFindings = Array.isArray(original.findings) ? original.findings : [];
  const afterFindings = Array.isArray(adapted.findings) ? adapted.findings : [];
  for (const [index, finding] of afterFindings.entries()) {
    const before = record(beforeFindings[index]);
    const after = record(finding);
    for (const field of ["id", "owner", "status"]) count(before[field], after[field]);
  }
  return changes;
}

function countRuleDerivedChanges(
  original: Record<string, unknown>,
  adapted: Record<string, unknown>,
  originalScore: unknown,
  adaptedScore: unknown,
): number {
  let changes = 0;
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const count = (before: unknown, after: unknown): void => {
    if (JSON.stringify(before) !== JSON.stringify(after)) changes += 1;
  };
  count(original.overall_decision, adapted.overall_decision);
  count(original.confidence, adapted.confidence);
  count(original.conditions, adapted.conditions);
  count(original.hard_gate_failures, adapted.hard_gate_failures);
  count(originalScore, adaptedScore);
  const beforeLayers = record(original.layers);
  const afterLayers = record(adapted.layers);
  for (const [layerId, rawLayer] of Object.entries(afterLayers)) {
    const before = record(beforeLayers[layerId]);
    const after = record(rawLayer);
    count(before.decision, after.decision);
    count(before.confidence, after.confidence);
    count(before.hard_gate_failures, after.hard_gate_failures);
    const beforeDimensions = new Map(
      (Array.isArray(before.dimensions) ? before.dimensions : []).map((dimension) => [
        record(dimension).dimension_id,
        record(dimension),
      ]),
    );
    for (const dimension of Array.isArray(after.dimensions) ? after.dimensions : []) {
      const item = record(dimension);
      count(beforeDimensions.get(item.dimension_id)?.applicability, item.applicability);
    }
  }
  const beforeConstraints = record(original.constraints);
  const afterConstraints = record(adapted.constraints);
  for (const [key, rawConstraint] of Object.entries(afterConstraints)) {
    count(record(beforeConstraints[key]).applicability, record(rawConstraint).applicability);
  }
  return changes;
}
