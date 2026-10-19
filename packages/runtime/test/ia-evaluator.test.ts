// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createArtifact } from "../src/artifacts/index.js";
import type {
  ArtifactEnvelope,
  ArtifactEvidence,
  IaCandidate,
  OntologyEntity,
} from "../src/artifacts/contracts.js";
import type { ContentIndexV1, DocumentNode } from "../src/content-ir/contracts.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import { DEFAULT_IA_DIAGNOSTIC_POLICY, type IaStructuralProjection } from "../src/ia/contracts.js";
import {
  assertIaEvaluationPassed,
  evaluateIaCandidate,
  IaEvaluationGateError,
  IA_EVALUATION_POLICY,
  selectEligibleIaEvaluation,
  type EvaluateIaCandidateInput,
} from "../src/ia/evaluator.js";
import type {
  NavigationRankCandidate,
  NavigationRankings,
  VersionedNavigationSuite,
} from "../src/ia/navigation.js";

const REVISION = "a".repeat(40);
const CONTENT_DIGEST = "b".repeat(64);
const INDEX_DIGEST = "c".repeat(64);
const A1 = "document:operate/run.md";
const A2 = "document:operate/debug.md";
const B1 = "document:concepts/model.md";
const B2 = "document:concepts/policy.md";
const OA = "document:operate/index.md";
const OB = "document:concepts/index.md";

describe("revision-bound IA evaluation", () => {
  it("composes diagnostics, scoring, and known-answer evidence into a passed artifact", () => {
    const input = fixture();
    const result = evaluateIaCandidate(input);

    expect(result.diagnostics.status).toBe("passed");
    expect(result.scoring.eligibility).toEqual({ eligible: true, reasons: [] });
    expect(result.navigation.deterministicPass).toBe(true);
    expect(result.artifact.payload).toMatchObject({
      candidateId: "candidate:reader-job",
      deterministicStatus: "passed",
      eligible: true,
      blockingDiagnosticDigests: [],
      navigationEvaluation: { digest: result.navigationArtifact.digest },
    });
    expect(result.artifact.payload.policyBindings).toContainEqual(IA_EVALUATION_POLICY);
    expect(() => assertIaEvaluationPassed(result.artifact, input)).not.toThrow();
    expect(selectEligibleIaEvaluation([result])).toBe(result);
  });

  it("makes a structurally tidy candidate ineligible when deterministic diagnostics fail", () => {
    const input = fixture();
    input.structure.pageClassifications = input.structure.pageClassifications.filter(
      (item) => item.nodeId !== A1,
    );
    const result = evaluateIaCandidate(input);

    expect(result.scoring.eligibility.eligible).toBe(true);
    expect(result.diagnostics.diagnostics.map((item) => item.rule)).toContain(
      "missing-page-classification",
    );
    expect(result.artifact.payload).toMatchObject({
      deterministicStatus: "failed",
      eligible: false,
    });
    expect(result.artifact.payload.blockingDiagnosticDigests.length).toBeGreaterThan(0);
    expect(() => assertIaEvaluationPassed(result.artifact, input)).toThrowError(
      new IaEvaluationGateError("deterministic-failed"),
    );
    expect(selectEligibleIaEvaluation([result])).toBeUndefined();
  });

  it("never lets a failed navigation suite or advisory-looking score bypass the gate", () => {
    const input = fixture();
    input.proposedRankings = { ...input.proposedRankings, routine: [] };
    const result = evaluateIaCandidate(input);

    expect(result.scoring.total).toBeGreaterThan(0);
    expect(result.navigation.deterministicPass).toBe(false);
    expect(result.artifact.payload.eligible).toBe(false);
    expect(() => assertIaEvaluationPassed(result.artifact, input)).toThrowError(
      new IaEvaluationGateError("deterministic-failed"),
    );
  });

  it("recomputes every digest and score instead of trusting a fabricated passed artifact", () => {
    const input = fixture();
    const result = evaluateIaCandidate(input);
    const forged = createArtifact(
      "ia-evaluation",
      {
        ...result.artifact.payload,
        scoringDigest: "9".repeat(64),
        scores: { ...result.artifact.payload.scores, total: 100 },
      },
      { index: input.index },
    );

    expect(forged.payload).toMatchObject({ deterministicStatus: "passed", eligible: true });
    expect(() => assertIaEvaluationPassed(forged, input)).toThrowError(
      new IaEvaluationGateError("invalid-evaluation"),
    );
  });

  it("rejects a passing-looking suite about indexed pages outside the candidate", () => {
    const input = fixture();
    const referenceCase = input.navigationSuite.cases.find((entry) => entry.id === "reference")!;
    referenceCase.expected = [destination(OA)];
    input.currentRankings = { ...input.currentRankings, reference: [hit(OA, 10)] };
    input.proposedRankings = { ...input.proposedRankings, reference: [hit(OA, 10)] };

    expect(() => evaluateIaCandidate(input)).toThrowError(
      new IaEvaluationGateError("candidate-mismatch"),
    );
  });

  it("binds current-versus-proposed evidence into the durable artifact", () => {
    const originalInput = fixture();
    const original = evaluateIaCandidate(originalInput);
    const changedInput = fixture();
    changedInput.currentRankings = { ...changedInput.currentRankings, routine: [] };
    const changed = evaluateIaCandidate(changedInput);

    expect(changed.navigationArtifact.digest).toBe(original.navigationArtifact.digest);
    expect(changed.artifact.payload.navigationComparisonDigest).not.toBe(
      original.artifact.payload.navigationComparisonDigest,
    );
    expect(changed.artifact.digest).not.toBe(original.artifact.digest);
    expect(() => assertIaEvaluationPassed(original.artifact, changedInput)).toThrowError(
      new IaEvaluationGateError("invalid-evaluation"),
    );
  });

  it("records an off-scope retrieval false positive as a deterministic failure", () => {
    const input = fixture();
    input.proposedRankings = { ...input.proposedRankings, none: [hit(OA, 10)] };
    const result = evaluateIaCandidate(input);

    expect(result.navigation.proposed.cases.find((entry) => entry.id === "none")).toMatchObject({
      deterministicPass: false,
      failureReasons: ["unexpected-result"],
    });
    expect(result.artifact.payload).toMatchObject({
      deterministicStatus: "failed",
      eligible: false,
    });
  });
});

function fixture(): EvaluateIaCandidateInput {
  const nodes = [OA, OB, A1, A2, B1, B2].map(document);
  const index = contentIndex(nodes);
  const candidate = candidateFixture();
  const ontology = createArtifact(
    "ontology",
    {
      entities: ontologyEntities(),
      relationships: [],
    },
    { index },
  );
  const candidates = createArtifact(
    "ia-candidates",
    {
      scope: "site",
      candidates: [candidate],
      recommendedCandidateId: candidate.id,
      rejectedCandidates: [],
      openDecisions: [],
    },
    { index },
  );
  const structure = structureFixture();
  const semantics = structure.topicNodeIds.map((nodeId) => contextPacket(index, nodeId));
  const suite = navigationSuite();
  const rankings = passingRankings();
  return {
    index,
    ontology,
    candidates,
    semantics,
    candidateId: candidate.id,
    structure,
    diagnosticPolicy: DEFAULT_IA_DIAGNOSTIC_POLICY,
    placements: structure.topicNodeIds.map((nodeId) => ({
      nodeId,
      proposedPath: sourcePathFor(nodeId),
      evidence: [evidence(nodeId)],
    })),
    navigationSuite: suite,
    navigationRetrieval: {
      id: "docsfab:test-navigation-retrieval",
      version: "1",
      digest: "6".repeat(64),
    },
    currentRankings: structuredClone(rankings),
    proposedRankings: structuredClone(rankings),
  };
}

function candidateFixture(): IaCandidate {
  return {
    id: "candidate:reader-job",
    primaryAxis: "reader-job",
    secondaryAxes: [],
    score: 90,
    groups: [
      {
        id: "group:operate",
        label: "Operate",
        axis: "reader-job",
        members: [A1, A2],
        canonicalPath: "operate",
        evidence: [evidence(A1)],
      },
      {
        id: "group:understand",
        label: "Understand",
        axis: "reader-job",
        members: [B1, B2],
        canonicalPath: "concepts",
        evidence: [evidence(B1)],
      },
    ],
    evidence: [evidence(A1)],
  };
}

function ontologyEntities(): OntologyEntity[] {
  return [
    { id: "entity:operate", label: "Operate", kind: "user-job", evidence: [evidence(A1)] },
    { id: "entity:understand", label: "Understand", kind: "concept", evidence: [evidence(B1)] },
  ];
}

function structureFixture(): IaStructuralProjection {
  return {
    topicNodeIds: [A1, A2, B1, B2],
    siblingSets: [
      {
        id: "siblings:top",
        parentId: "candidate:reader-job",
        groupIds: ["group:operate", "group:understand"],
        declaredAxis: "reader-job",
        evidence: [evidence(A1)],
      },
    ],
    overviews: [
      { groupId: "group:operate", nodeId: OA, evidence: [evidence(OA)] },
      { groupId: "group:understand", nodeId: OB, evidence: [evidence(OB)] },
    ],
    throughlines: [
      { groupId: "group:operate", entityId: "entity:operate", evidence: [evidence(A1)] },
      { groupId: "group:understand", entityId: "entity:understand", evidence: [evidence(B1)] },
    ],
    pageClassifications: [A1, A2, B1, B2].map((nodeId) => ({
      nodeId,
      purpose: "single-purpose" as const,
      siblingKind: "task" as const,
      evidence: [evidence(nodeId)],
    })),
    exceptions: [],
  };
}

function navigationSuite(): VersionedNavigationSuite {
  return {
    schemaVersion: 1,
    id: "suite:mvp",
    version: "1",
    cases: [
      navigationCase("routine", "routine-task", [destination(A1)]),
      navigationCase("reference", "reference-lookup", [destination(B1)]),
      navigationCase("troubleshoot", "troubleshooting", [destination(A2)]),
      navigationCase("ambiguous", "ambiguous-placement", [destination(A1), destination(B1)]),
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

function passingRankings(): NavigationRankings {
  return {
    routine: [hit(A1, 10)],
    reference: [hit(B1, 10)],
    troubleshoot: [hit(A2, 10)],
    ambiguous: [hit(A1, 10), hit(B1, 9)],
    none: [],
  };
}

function destination(nodeId: string): NavigationRankCandidate {
  const path = sourcePathFor(nodeId)
    .replace(/\.md$/u, "")
    .replace(/\/index$/u, "");
  return { nodeId, url: `/${path}`, anchor: null, score: 0 };
}

function hit(nodeId: string, score: number): NavigationRankCandidate {
  return { ...destination(nodeId), score };
}

function contextPacket(index: ContentIndexV1, nodeId: string): ArtifactEnvelope<"context-packet"> {
  return createArtifact(
    "context-packet",
    {
      targetNodeId: nodeId,
      pageRole: {
        contentType: "how-to",
        readerJob: nodeId.startsWith("document:concepts/") ? "entity:understand" : "entity:operate",
        organizingAxis: "reader-job",
      },
      ancestors: [],
      siblings: [],
      relatedCanonicalPages: [],
      placementRules: { belongsHere: [], belongsElsewhere: [] },
      activeDecisionIds: [],
      structuralPressure: "healthy",
      evidence: [evidence(nodeId)],
    },
    { index },
  );
}

function contentIndex(nodes: DocumentNode[]): ContentIndexV1 {
  const value: ContentIndexV1 = {
    schemaVersion: 1,
    repository: { revision: REVISION, contentDigest: CONTENT_DIGEST },
    indexDigest: INDEX_DIGEST,
    nodes,
    edges: [],
    evidence: {
      repositoryRevision: REVISION,
      contentDigest: CONTENT_DIGEST,
      indexDigest: INDEX_DIGEST,
      documentCount: nodes.length,
      sectionCount: 0,
      edgeCount: 0,
    },
  };
  const indexDigest = canonicalDigest({
    schemaVersion: 1,
    repository: value.repository,
    nodes,
    edges: value.edges,
  });
  return { ...value, indexDigest, evidence: { ...value.evidence, indexDigest } };
}

function document(id: string): DocumentNode {
  return {
    id,
    kind: "document",
    sourcePath: sourcePathFor(id),
    format: "gfm",
    byteLength: 64,
    anchors: [],
    frontmatter: [],
    directives: [],
    codeBlocks: [],
    regions: {
      body: "1".repeat(64),
      headings: "2".repeat(64),
      metadata: "3".repeat(64),
      navigation: "4".repeat(64),
      graph: "5".repeat(64),
    },
  };
}

function evidence(nodeId: string): ArtifactEvidence {
  return { path: sourcePathFor(nodeId), nodeId };
}

function sourcePathFor(nodeId: string): string {
  return nodeId.replace(/^document:/u, "");
}
