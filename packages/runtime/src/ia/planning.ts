// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createArtifact,
  IA_DECISION_KINDS,
  validateArtifact,
  type ApprovalRequirement,
  type Artifact,
  type ArtifactEvidence,
  type ArtifactReference,
  type IaCandidatesPayload,
  type IaDecisionKind,
  type IaEvaluationArtifact,
  type IaMigrationDisposition,
  type IaPlanArtifact,
  type IaPlanMode,
  type IaPlannedPage,
  type IaScope,
  type IaUseCase,
  type InboundLinkConsequence,
  type NavigationEvaluationArtifact,
  type PolicyBinding,
  type RedirectConsequence,
} from "../artifacts/index.js";
import type { ContentIndexV1, ContentNode } from "../content-ir/index.js";
import { assertIaEvaluationPassed, type EvaluateIaCandidateInput } from "./evaluator.js";

export interface IaPlanningTarget {
  sourcePath: string;
  anchor?: string;
}

export interface IaPlanningNeed {
  id: string;
  kind: IaDecisionKind;
  evidence: ArtifactEvidence[];
}

interface IaPlanningBaseInput {
  index: ContentIndexV1;
  scope: IaScope;
  mode: IaPlanMode;
  target?: IaPlanningTarget;
}

export interface IaNeedsInputPlanningInput extends IaPlanningBaseInput {
  needsInput: IaPlanningNeed[];
}

export interface IaEvaluatedPlanningInput extends IaPlanningBaseInput {
  planId: string;
  ontology: Artifact;
  candidates: Artifact;
  evaluation: Artifact;
  evaluationInput: EvaluateIaCandidateInput;
  navigationEvaluation: Artifact;
  useCases: IaUseCase[];
  redirects: RedirectConsequence[];
  inboundLinkConsequences: InboundLinkConsequence[];
  policyBindings: PolicyBinding[];
  requiredApproval: ApprovalRequirement;
  expiresAt: string;
  /** Exact inactive plan this revision replaces after review feedback. */
  supersedes?: ArtifactReference<"ia-plan">;
  plannedPages: IaPlannedPage[];
  migrationDispositions: IaMigrationDisposition[];
}

export type CreateIaPlanningOutcomeInput = IaNeedsInputPlanningInput | IaEvaluatedPlanningInput;

export type IaPlanningOutcome =
  | {
      status: "needs-input";
      scope: IaScope;
      mode: IaPlanMode;
      targetNodeId?: string;
      needs: IaPlanningNeed[];
      writesPerformed: false;
    }
  | {
      status: "needs-human-decision" | "plan-ready";
      scope: IaScope;
      mode: IaPlanMode;
      targetNodeId?: string;
      plan: IaPlanArtifact;
      writesPerformed: false;
    };

export type IaPlanningErrorCode =
  | "invalid-scope-mode"
  | "target-required"
  | "target-not-allowed"
  | "target-unresolved"
  | "needs-input-invalid"
  | "artifact-invalid"
  | "artifact-mismatch"
  | "candidate-ineligible"
  | "migration-incomplete";

export class IaPlanningError extends Error {
  public constructor(
    public readonly code: IaPlanningErrorCode,
    public readonly path: string,
  ) {
    super(`IA planning rejected ${path}: ${code}.`);
    this.name = "IaPlanningError";
  }
}

/**
 * Pure planning boundary. It resolves one immutable target and either
 * returns explicit missing input or composes a structurally valid pending
 * plan. It has no repository path or write capability.
 */
export function createIaPlanningOutcome(input: CreateIaPlanningOutcomeInput): IaPlanningOutcome {
  const targetNode = resolveTarget(input);
  if ("needsInput" in input) {
    return needsInputOutcome(input, targetNode);
  }

  const artifacts = validatePlanningArtifacts(input);
  assertCandidateBindings(input, artifacts, targetNode?.id);
  assertMigrationCoverage(input, targetNode);
  const candidate = artifacts.candidates.payload.candidates.find(
    (item) => item.id === artifacts.candidates.payload.recommendedCandidateId,
  );
  if (!candidate) fail("artifact-mismatch", "$.candidates.recommendedCandidateId");

  const plan = createArtifact(
    "ia-plan",
    {
      planId: input.planId,
      candidateId: candidate.id,
      candidateArtifact: referenceFor(artifacts.candidates),
      scope: input.scope,
      ...(targetNode ? { targetNodeId: targetNode.id } : {}),
      primaryAxis: candidate.primaryAxis,
      secondaryAxes: [...candidate.secondaryAxes],
      groups: structuredClone(candidate.groups),
      useCases: structuredClone(input.useCases),
      rejectedCandidates: structuredClone(artifacts.candidates.payload.rejectedCandidates),
      openDecisions: structuredClone(artifacts.candidates.payload.openDecisions),
      redirects: structuredClone(input.redirects),
      inboundLinkConsequences: structuredClone(input.inboundLinkConsequences),
      navigationEvaluation: referenceFor(artifacts.navigation),
      policyBindings: structuredClone(input.policyBindings),
      approval: { requirement: input.requiredApproval, status: "pending" },
      expiresAt: input.expiresAt,
      ...(input.supersedes ? { supersedes: structuredClone(input.supersedes) } : {}),
      outputScope:
        input.mode === "create"
          ? input.plannedPages.map((page) => ({
              path: page.outputPath,
              operation: "create" as const,
            }))
          : [],
      mode: input.mode,
      iaEvaluation: referenceFor(artifacts.evaluation),
      plannedPages: structuredClone(input.plannedPages),
      migrationDispositions: structuredClone(input.migrationDispositions),
    },
    { index: input.index, planAcceptance: "any" },
  );

  const needsHumanDecision =
    plan.payload.openDecisions.length > 0 ||
    plan.payload.migrationDispositions?.some(
      (item) => item.disposition === "needs-human-decision",
    ) === true;
  return {
    status: needsHumanDecision ? "needs-human-decision" : "plan-ready",
    scope: input.scope,
    mode: input.mode,
    ...(targetNode ? { targetNodeId: targetNode.id } : {}),
    plan,
    writesPerformed: false,
  };
}

function resolveTarget(input: IaPlanningBaseInput): ContentNode | undefined {
  if (input.mode === "create" && input.scope !== "site") {
    fail("invalid-scope-mode", "$.mode");
  }
  if (input.scope === "site") {
    if (input.target) fail("target-not-allowed", "$.target");
    return undefined;
  }
  if (!input.target) fail("target-required", "$.target");
  const matches = input.index.nodes.filter(
    (node) =>
      node.sourcePath === input.target!.sourcePath &&
      (input.scope === "page"
        ? node.kind === "document" && input.target!.anchor === undefined
        : node.kind === "section" && node.anchor === input.target!.anchor),
  );
  if (matches.length !== 1) fail("target-unresolved", "$.target");
  return matches[0]!;
}

function needsInputOutcome(
  input: IaNeedsInputPlanningInput,
  targetNode: ContentNode | undefined,
): IaPlanningOutcome {
  if (!Array.isArray(input.needsInput) || input.needsInput.length === 0) {
    fail("needs-input-invalid", "$.needsInput");
  }
  const nodes = new Map(input.index.nodes.map((node) => [node.id, node.sourcePath]));
  const ids = new Set<string>();
  for (const [index, need] of input.needsInput.entries()) {
    if (
      !need.id ||
      ids.has(need.id) ||
      !IA_DECISION_KINDS.includes(need.kind) ||
      !Array.isArray(need.evidence)
    ) {
      fail("needs-input-invalid", `$.needsInput[${index}]`);
    }
    ids.add(need.id);
    for (const item of need.evidence) {
      if (nodes.get(item.nodeId) !== item.path) {
        fail("needs-input-invalid", `$.needsInput[${index}].evidence`);
      }
    }
  }
  return {
    status: "needs-input",
    scope: input.scope,
    mode: input.mode,
    ...(targetNode ? { targetNodeId: targetNode.id } : {}),
    needs: structuredClone(input.needsInput),
    writesPerformed: false,
  };
}

function validatePlanningArtifacts(input: IaEvaluatedPlanningInput): {
  ontology: Extract<Artifact, { kind: "ontology" }>;
  candidates: Extract<Artifact, { kind: "ia-candidates" }>;
  evaluation: IaEvaluationArtifact;
  navigation: NavigationEvaluationArtifact;
  evaluationInput: EvaluateIaCandidateInput;
} {
  try {
    const ontology = validateArtifact(input.ontology, { index: input.index });
    const candidates = validateArtifact(input.candidates, { index: input.index });
    const evaluation = validateArtifact(input.evaluation, { index: input.index });
    const navigation = validateArtifact(input.navigationEvaluation, { index: input.index });
    if (
      ontology.kind !== "ontology" ||
      candidates.kind !== "ia-candidates" ||
      evaluation.kind !== "ia-evaluation" ||
      navigation.kind !== "navigation-evaluation"
    )
      throw new Error("kind");
    const evaluationInput = bindIaEvaluationInput(input, ontology, candidates);
    assertIaEvaluationPassed(evaluation, evaluationInput);
    return { ontology, candidates, evaluation, navigation, evaluationInput };
  } catch {
    fail("artifact-invalid", "$.artifacts");
  }
}

function assertCandidateBindings(
  input: IaEvaluatedPlanningInput,
  artifacts: ReturnType<typeof validatePlanningArtifacts>,
  targetNodeId: string | undefined,
): void {
  const candidates = artifacts.candidates;
  const evaluation = artifacts.evaluation;
  if (
    candidates.payload.scope !== input.scope ||
    candidates.payload.targetNodeId !== targetNodeId ||
    evaluation.payload.candidateId !== candidates.payload.recommendedCandidateId ||
    !sameReference(evaluation.payload.candidateArtifact, referenceFor(candidates)) ||
    !sameReference(evaluation.payload.navigationEvaluation, referenceFor(artifacts.navigation))
  ) {
    fail("artifact-mismatch", "$.artifacts");
  }
}

/** Replace packaged evaluator bindings with the exact artifacts already validated for this plan. */
export function bindIaEvaluationInput(
  input: Pick<IaEvaluatedPlanningInput, "index" | "ontology" | "candidates" | "evaluationInput">,
  ontology = input.ontology as Extract<Artifact, { kind: "ontology" }>,
  candidates = input.candidates as Extract<Artifact, { kind: "ia-candidates" }>,
): EvaluateIaCandidateInput {
  const value = input.evaluationInput;
  return {
    index: structuredClone(input.index),
    ontology: structuredClone(ontology),
    candidates: structuredClone(candidates),
    semantics: structuredClone(value.semantics),
    candidateId: value.candidateId,
    structure: structuredClone(value.structure),
    diagnosticPolicy: structuredClone(value.diagnosticPolicy),
    placements: structuredClone(value.placements),
    navigationSuite: structuredClone(value.navigationSuite),
    navigationRetrieval: structuredClone(value.navigationRetrieval),
    currentRankings: structuredClone(value.currentRankings),
    proposedRankings: structuredClone(value.proposedRankings),
  };
}

function assertMigrationCoverage(
  input: IaEvaluatedPlanningInput,
  targetNode: ContentNode | undefined,
): void {
  if (input.mode === "create") {
    if (input.plannedPages.length === 0 || input.migrationDispositions.length !== 0) {
      fail("migration-incomplete", "$.plannedPages");
    }
    return;
  }
  if (input.plannedPages.length !== 0) fail("migration-incomplete", "$.plannedPages");
  const expected =
    input.scope === "site"
      ? input.index.nodes.filter((node) => node.kind === "document").map((node) => node.id)
      : [targetNode!.id];
  const actual = input.migrationDispositions.map((item) => item.nodeId);
  if (
    new Set(actual).size !== actual.length ||
    expected.length !== actual.length ||
    expected.some((nodeId) => !actual.includes(nodeId))
  ) {
    fail("migration-incomplete", "$.migrationDispositions");
  }
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

function sameReference(left: ArtifactReference, right: ArtifactReference): boolean {
  return (
    left.kind === right.kind &&
    left.schemaVersion === right.schemaVersion &&
    left.digest === right.digest &&
    left.repositoryRevision === right.repositoryRevision &&
    left.repositoryContentDigest === right.repositoryContentDigest
  );
}

function fail(code: IaPlanningErrorCode, path: string): never {
  throw new IaPlanningError(code, path);
}
