// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createArtifact,
  validateArtifact,
  type Artifact,
  type ArtifactEnvelope,
  type ArtifactEvidence,
  type ArtifactReference,
  type IaEvaluationArtifact,
  type NavigationEvaluationArtifact,
  type PolicyBinding,
} from "../artifacts/index.js";
import { canonicalDigest } from "../content-ir/index.js";
import type { ContentIndexV1 } from "../content-ir/index.js";
import {
  type IaDiagnosticPolicy,
  type IaDiagnosticsReport,
  type IaStructuralProjection,
} from "./contracts.js";
import { evaluateIaDiagnostics } from "./diagnostics.js";
import {
  compareNavigationStructures,
  validateNavigationSuiteAgainstIndex,
  type NavigationComparison,
  type NavigationRankings,
  type VersionedNavigationSuite,
} from "./navigation.js";
import {
  IA_SCORE_WEIGHTS,
  scoreIaCandidate,
  type IaCandidateScore,
  type IaPathPlacement,
  type IaScoringCandidate,
} from "./scoring.js";

const IA_EVALUATION_POLICY_VALUE = {
  id: "docsfab:ia-evaluation",
  version: "1",
  scoreWeights: IA_SCORE_WEIGHTS,
  requiredNavigationCaseKinds: [
    "routine-task",
    "reference-lookup",
    "troubleshooting",
    "ambiguous-placement",
    "expected-no-result",
  ],
  gate: "diagnostics-and-scoring-and-navigation",
} as const;

export const IA_EVALUATION_POLICY: PolicyBinding = {
  id: IA_EVALUATION_POLICY_VALUE.id,
  version: IA_EVALUATION_POLICY_VALUE.version,
  digest: canonicalDigest(IA_EVALUATION_POLICY_VALUE),
};

export interface EvaluateIaCandidateInput {
  index: ContentIndexV1;
  ontology: ArtifactEnvelope<"ontology">;
  candidates: ArtifactEnvelope<"ia-candidates">;
  semantics: readonly ArtifactEnvelope<"context-packet">[];
  candidateId: string;
  structure: IaStructuralProjection;
  diagnosticPolicy: IaDiagnosticPolicy;
  placements: IaPathPlacement[];
  navigationSuite: VersionedNavigationSuite;
  /** Versioned deterministic retrieval implementation that produced both rankings. */
  navigationRetrieval: PolicyBinding;
  currentRankings: NavigationRankings;
  proposedRankings: NavigationRankings;
}

export interface IaCandidateEvaluation {
  diagnostics: IaDiagnosticsReport;
  scoring: IaCandidateScore;
  navigation: NavigationComparison;
  navigationArtifact: NavigationEvaluationArtifact;
  artifact: IaEvaluationArtifact;
}

export type IaEvaluationGateCode =
  | "invalid-evaluation"
  | "candidate-mismatch"
  | "navigation-mismatch"
  | "deterministic-failed";

export class IaEvaluationGateError extends Error {
  public constructor(public readonly code: IaEvaluationGateCode) {
    super(`IA evaluation gate rejected the candidate: ${code}.`);
    this.name = "IaEvaluationGateError";
  }
}

/**
 * Runs every deterministic evaluation lane against one immutable candidate and index.
 * Candidate groups come from the validated artifact; callers can only supply
 * revision-bound path placements and navigation retrieval results.
 */
export function evaluateIaCandidate(input: EvaluateIaCandidateInput): IaCandidateEvaluation {
  const candidates = validateArtifact(input.candidates, { index: input.index });
  if (candidates.kind !== "ia-candidates") throw new IaEvaluationGateError("invalid-evaluation");
  const candidate = candidates.payload.candidates.find((item) => item.id === input.candidateId);
  if (!candidate) throw new IaEvaluationGateError("candidate-mismatch");

  const diagnostics = evaluateIaDiagnostics({
    index: input.index,
    ontology: input.ontology,
    candidates: input.candidates,
    semantics: input.semantics,
    candidateId: input.candidateId,
    structure: input.structure,
    policy: input.diagnosticPolicy,
  });
  const scoringCandidate: IaScoringCandidate = {
    id: candidate.id,
    primaryAxis: candidate.primaryAxis,
    secondaryAxes: [...candidate.secondaryAxes],
    groups: candidate.groups.map((group) => ({
      id: group.id,
      label: group.label,
      axis: group.axis,
      canonicalPath: group.canonicalPath,
      memberNodeIds: [...group.members],
      evidence: [...group.evidence],
    })),
    placements: input.placements,
    evidence: [...candidate.evidence],
  };
  const scoring = scoreIaCandidate({
    index: input.index,
    targetNodeIds: input.structure.topicNodeIds,
    candidate: scoringCandidate,
  });
  const suite = validateNavigationSuiteAgainstIndex(input.navigationSuite, input.index);
  assertNavigationEvidenceBound(suite, input.structure.topicNodeIds, input.index);
  const navigation = compareNavigationStructures(
    suite,
    input.currentRankings,
    input.proposedRankings,
    input.index,
  );
  const navigationArtifact = createArtifact(
    "navigation-evaluation",
    navigation.proposed.navigation,
    { index: input.index },
  );

  const eligible =
    diagnostics.status === "passed" && scoring.eligibility.eligible && navigation.deterministicPass;
  const evidence = uniqueEvidence([
    ...candidate.evidence,
    ...candidate.groups.flatMap((group) => group.evidence),
    ...input.placements.flatMap((placement) => placement.evidence),
    ...diagnostics.diagnostics.flatMap((diagnostic) => diagnostic.evidence),
  ]);
  const diagnosticBinding: PolicyBinding = {
    id: input.diagnosticPolicy.id,
    version: input.diagnosticPolicy.version,
    digest: input.diagnosticPolicy.digest,
  };
  const artifact = createArtifact(
    "ia-evaluation",
    {
      candidateArtifact: artifactReference(candidates),
      candidateId: candidate.id,
      diagnosticsDigest: canonicalDigest(diagnostics),
      scoringDigest: canonicalDigest(scoring),
      topologyDigest: scoring.topologyDigest,
      navigationComparisonDigest: navigation.digest,
      navigationEvaluation: artifactReference(navigationArtifact),
      navigationSuite: {
        id: suite.id,
        version: suite.version,
        digest: canonicalDigest(suite),
      },
      scores: {
        ...scoring.components,
        total: scoring.total,
        structuralFindability: scoring.structuralFindability,
      },
      deterministicStatus: eligible ? "passed" : "failed",
      eligible,
      blockingDiagnosticDigests: diagnostics.diagnostics
        .filter((diagnostic) => diagnostic.severity === "blocking")
        .map((diagnostic) => canonicalDigest(diagnostic))
        .sort(compareText),
      policyBindings: [diagnosticBinding, IA_EVALUATION_POLICY, input.navigationRetrieval].sort(
        (left, right) => compareText(left.id, right.id),
      ),
      evidence,
    },
    { index: input.index },
  );

  return { diagnostics, scoring, navigation, navigationArtifact, artifact };
}

/**
 * Hard downstream seam for approval/scaffolding. It resolves both referenced
 * artifacts, binds the candidate identity, and rejects every failed result.
 */
export function assertIaEvaluationPassed(
  evaluationValue: Artifact,
  input: EvaluateIaCandidateInput,
): asserts evaluationValue is IaEvaluationArtifact {
  let evaluation: Artifact;
  let recomputed: IaCandidateEvaluation;
  try {
    evaluation = validateArtifact(evaluationValue, { index: input.index });
    recomputed = evaluateIaCandidate(input);
  } catch {
    throw new IaEvaluationGateError("invalid-evaluation");
  }
  if (evaluation.kind !== "ia-evaluation") {
    throw new IaEvaluationGateError("invalid-evaluation");
  }
  if (
    !sameReference(
      evaluation.payload.candidateArtifact,
      recomputed.artifact.payload.candidateArtifact,
    ) ||
    evaluation.payload.candidateId !== recomputed.artifact.payload.candidateId
  ) {
    throw new IaEvaluationGateError("candidate-mismatch");
  }
  if (
    !sameReference(
      evaluation.payload.navigationEvaluation,
      recomputed.artifact.payload.navigationEvaluation,
    )
  ) {
    throw new IaEvaluationGateError("navigation-mismatch");
  }
  if (evaluation.digest !== recomputed.artifact.digest) {
    throw new IaEvaluationGateError("invalid-evaluation");
  }
  if (evaluation.payload.deterministicStatus !== "passed" || !evaluation.payload.eligible) {
    throw new IaEvaluationGateError("deterministic-failed");
  }
}

/** Selects only passed evaluations; presentation labels and input order are inert. */
export function selectEligibleIaEvaluation(
  evaluations: readonly IaCandidateEvaluation[],
): IaCandidateEvaluation | undefined {
  const candidateIds = new Set<string>();
  for (const evaluation of evaluations) {
    if (candidateIds.has(evaluation.artifact.payload.candidateId)) {
      throw new IaEvaluationGateError("candidate-mismatch");
    }
    candidateIds.add(evaluation.artifact.payload.candidateId);
  }
  return [...evaluations]
    .filter(
      (evaluation) =>
        evaluation.artifact.payload.eligible &&
        evaluation.artifact.payload.deterministicStatus === "passed",
    )
    .sort(
      (left, right) =>
        right.scoring.total - left.scoring.total ||
        right.scoring.structuralFindability - left.scoring.structuralFindability ||
        compareText(left.scoring.topologyDigest, right.scoring.topologyDigest) ||
        compareText(left.artifact.payload.candidateId, right.artifact.payload.candidateId),
    )[0];
}

function artifactReference<K extends Artifact["kind"]>(
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

function sameReference<K extends Artifact["kind"]>(
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

function uniqueEvidence(evidence: readonly ArtifactEvidence[]): ArtifactEvidence[] {
  return [...new Map(evidence.map((item) => [`${item.path}\0${item.nodeId}`, item])).values()].sort(
    (left, right) => compareText(`${left.path}\0${left.nodeId}`, `${right.path}\0${right.nodeId}`),
  );
}

function assertNavigationEvidenceBound(
  suite: VersionedNavigationSuite,
  targetNodeIds: readonly string[],
  index: ContentIndexV1,
): void {
  const targets = new Set(targetNodeIds);
  const nodes = new Map(index.nodes.map((node) => [node.id, node]));
  const belongsToTarget = (nodeId: string): boolean => {
    const node = nodes.get(nodeId);
    return Boolean(
      node && (targets.has(node.id) || (node.kind === "section" && targets.has(node.documentId))),
    );
  };
  for (const navigationCase of suite.cases) {
    for (const destination of [
      ...navigationCase.expected,
      ...navigationCase.acceptableAlternatives,
    ]) {
      if (!belongsToTarget(destination.nodeId)) {
        throw new IaEvaluationGateError("candidate-mismatch");
      }
    }
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
