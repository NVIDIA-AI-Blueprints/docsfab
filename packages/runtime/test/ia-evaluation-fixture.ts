// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createArtifact,
  type ArtifactEnvelope,
  type ArtifactEvidence,
  type IaScope,
} from "../src/artifacts/index.js";
import type { ContentIndexV1, DocumentNode } from "../src/content-ir/index.js";
import {
  DEFAULT_IA_DIAGNOSTIC_POLICY,
  documentationUrlForSourcePath,
  evaluateIaCandidate,
  type EvaluateIaCandidateInput,
  type IaStructuralProjection,
  type NavigationRankCandidate,
  type NavigationRankings,
  type VersionedNavigationSuite,
} from "../src/ia/index.js";

export function passedIaEvaluationFixture(
  index: ContentIndexV1,
  scope: IaScope = "site",
  targetNodeId?: string,
): {
  ontology: ArtifactEnvelope<"ontology">;
  candidates: ArtifactEnvelope<"ia-candidates">;
  evaluationInput: EvaluateIaCandidateInput;
  evaluation: ReturnType<typeof evaluateIaCandidate>["artifact"];
  navigationEvaluation: ReturnType<typeof evaluateIaCandidate>["navigationArtifact"];
} {
  const documents = index.nodes
    .filter((node): node is DocumentNode => node.kind === "document")
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  if (documents.length < 2) throw new Error("IA evaluation fixture requires two documents.");
  const first = documents[0]!;
  const second = documents[1]!;
  const ontology = createArtifact(
    "ontology",
    {
      entities: [
        {
          id: "entity:documentation",
          label: "Documentation",
          kind: "artifact",
          evidence: [evidence(first)],
        },
      ],
      relationships: [],
    },
    { index },
  );
  const candidates = createArtifact(
    "ia-candidates",
    {
      scope,
      ...(targetNodeId ? { targetNodeId } : {}),
      candidates: [
        {
          id: "candidate:reader-job",
          primaryAxis: "reader-job",
          secondaryAxes: [],
          score: 90,
          groups: [
            {
              id: "group:documentation",
              label: "Documentation",
              axis: "reader-job",
              members: documents.map((document) => document.id),
              canonicalPath: "docs",
              evidence: [evidence(first)],
            },
          ],
          evidence: [evidence(first)],
        },
      ],
      recommendedCandidateId: "candidate:reader-job",
      rejectedCandidates: [],
      openDecisions: [],
    },
    { index },
  );
  const structure: IaStructuralProjection = {
    topicNodeIds: documents.map((document) => document.id),
    siblingSets: [
      {
        id: "siblings:documentation",
        parentId: "candidate:reader-job",
        groupIds: ["group:documentation"],
        declaredAxis: "reader-job",
        evidence: [evidence(first)],
      },
    ],
    overviews: [
      {
        groupId: "group:documentation",
        nodeId: first.id,
        evidence: [evidence(first)],
      },
    ],
    throughlines: [
      {
        groupId: "group:documentation",
        entityId: "entity:documentation",
        evidence: [evidence(first)],
      },
    ],
    pageClassifications: documents.map((document) => ({
      nodeId: document.id,
      purpose: "single-purpose" as const,
      siblingKind: "task" as const,
      evidence: [evidence(document)],
    })),
    exceptions: [],
  };
  const rankings = passingRankings(first, second);
  const evaluationInput: EvaluateIaCandidateInput = {
    index,
    ontology,
    candidates,
    semantics: documents.map((document) => contextPacket(index, document)),
    candidateId: "candidate:reader-job",
    structure,
    diagnosticPolicy: DEFAULT_IA_DIAGNOSTIC_POLICY,
    placements: documents.map((document) => ({
      nodeId: document.id,
      proposedPath: document.sourcePath,
      evidence: [evidence(document)],
    })),
    navigationSuite: navigationSuite(first, second),
    navigationRetrieval: {
      id: "docsfab:test-navigation-retrieval",
      version: "1",
      digest: "6".repeat(64),
    },
    currentRankings: structuredClone(rankings),
    proposedRankings: structuredClone(rankings),
  };
  const evaluated = evaluateIaCandidate(evaluationInput);
  return {
    ontology,
    candidates,
    evaluationInput,
    evaluation: evaluated.artifact,
    navigationEvaluation: evaluated.navigationArtifact,
  };
}

function navigationSuite(first: DocumentNode, second: DocumentNode): VersionedNavigationSuite {
  return {
    schemaVersion: 1,
    id: "suite:planning",
    version: "1",
    cases: [
      navigationCase("routine", "routine-task", [destination(first)]),
      navigationCase("reference", "reference-lookup", [destination(second)]),
      navigationCase("troubleshoot", "troubleshooting", [destination(first)]),
      navigationCase("ambiguous", "ambiguous-placement", [destination(first), destination(second)]),
      navigationCase("none", "expected-no-result", []),
    ],
  };
}

function navigationCase(
  id: string,
  kind: VersionedNavigationSuite["cases"][number]["kind"],
  expected: VersionedNavigationSuite["cases"][number]["expected"],
): VersionedNavigationSuite["cases"][number] {
  return { id, kind, query: `query:${id}`, expected, acceptableAlternatives: [] };
}

function passingRankings(first: DocumentNode, second: DocumentNode): NavigationRankings {
  return {
    routine: [hit(first, 10)],
    reference: [hit(second, 10)],
    troubleshoot: [hit(first, 10)],
    ambiguous: [hit(first, 10), hit(second, 9)],
    none: [],
  };
}

function contextPacket(
  index: ContentIndexV1,
  document: DocumentNode,
): ArtifactEnvelope<"context-packet"> {
  return createArtifact(
    "context-packet",
    {
      targetNodeId: document.id,
      pageRole: {
        contentType: "how-to",
        readerJob: "entity:documentation",
        organizingAxis: "reader-job",
      },
      ancestors: [],
      siblings: [],
      relatedCanonicalPages: [],
      placementRules: { belongsHere: [], belongsElsewhere: [] },
      activeDecisionIds: [],
      structuralPressure: "healthy",
      evidence: [evidence(document)],
    },
    { index },
  );
}

function destination(document: DocumentNode): NavigationRankCandidate {
  return {
    nodeId: document.id,
    url: documentationUrlForSourcePath(document.sourcePath),
    anchor: null,
    score: 0,
  };
}

function hit(document: DocumentNode, score: number): NavigationRankCandidate {
  return { ...destination(document), score };
}

function evidence(document: DocumentNode): ArtifactEvidence {
  return { path: document.sourcePath, nodeId: document.id };
}
