// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  canonicalArtifactDigest,
  createArtifact,
  type ArtifactEnvelope,
  type ArtifactEvidence,
  type ArtifactPayloadByKind,
  type ArtifactReference,
  type IaCandidate,
  type IaEvaluationArtifact,
  type IaPlanArtifact,
  type OntologyEntity,
} from "../src/artifacts/index.js";
import type { ContentIndexV1, DocumentNode } from "../src/content-ir/index.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import {
  DEFAULT_IA_DIAGNOSTIC_POLICY,
  evaluateIaCandidate,
  type EvaluateIaCandidateInput,
  type IaStructuralProjection,
  type NavigationRankCandidate,
  type NavigationRankings,
  type VersionedNavigationSuite,
} from "../src/ia/index.js";
import {
  authorizeTemplateScaffold,
  TemplateAuthorizationError,
} from "../src/templates/authorization.js";
import type { TemplatePreviewTopic } from "../src/templates/contracts.js";
import { TEMPLATE_CATALOG_POLICY } from "../src/templates/load.js";
import { TEMPLATE_SELECTION_POLICY, templateSelectionDigest } from "../src/templates/selection.js";

const NOW = new Date("2026-08-03T16:00:00.000Z");
const REVISION = "a".repeat(40);
const CONTENT_DIGEST = "b".repeat(64);
const INDEX_DIGEST = "c".repeat(64);
const A1 = "document:operate/run.md";
const A2 = "document:operate/debug.md";
const B1 = "document:concepts/model.md";
const B2 = "document:concepts/policy.md";
const OA = "document:operate/index.md";
const OB = "document:concepts/index.md";
const CATALOG_BINDING = {
  id: TEMPLATE_CATALOG_POLICY.id,
  version: TEMPLATE_CATALOG_POLICY.version,
  digest: "d".repeat(64),
};
const CHECK_BINDING = {
  id: "docsfab:repository-checks:test",
  version: "1",
  digest: "e".repeat(64),
};

describe("template scaffold authorization", () => {
  it("converts a validated approved IA plan and recomputed evaluation into a narrow create-only grant", () => {
    const input = fixture();
    const evaluation = evaluateIaCandidate(input).artifact;
    const plan = planFixture(input, evaluation);

    expect(
      authorizeTemplateScaffold({
        index: input.index,
        plan,
        evaluation,
        evaluationInput: input,
        topics: selectionTopics(),
        ...authorities(),
        now: NOW,
      }),
    ).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        kind: "ia-plan",
        digest: plan.digest,
        planId: "plan:reader-job",
        candidateId: "candidate:reader-job",
        iaEvaluation: expect.objectContaining({
          digest: evaluation.digest,
          eligible: true,
        }),
        approval: expect.objectContaining({
          status: "approved",
          requirement: "maintainer",
          approvedBy: "maintainer:example",
        }),
        outputs: [{ path: "docs/get-started/index.md", operation: "create" }],
      }),
    );
  });

  it("rejects a forged or stale evaluation instead of trusting its passing labels", () => {
    const input = fixture();
    const evaluation = evaluateIaCandidate(input).artifact;
    const forged = createArtifact(
      "ia-evaluation",
      {
        ...evaluation.payload,
        scoringDigest: "9".repeat(64),
        scores: { ...evaluation.payload.scores, total: 100 },
      },
      { index: input.index },
    );
    const staleInput = fixture();
    staleInput.currentRankings = { ...staleInput.currentRankings, routine: [] };

    expectAuthorizationError(
      () =>
        authorizeTemplateScaffold({
          index: input.index,
          plan: planFixture(input, evaluation),
          evaluation: forged,
          evaluationInput: input,
          topics: selectionTopics(),
          ...authorities(),
          now: NOW,
        }),
      "evaluation-mismatch",
    );
    expectAuthorizationError(
      () =>
        authorizeTemplateScaffold({
          index: input.index,
          plan: planFixture(input, evaluation),
          evaluation,
          evaluationInput: staleInput,
          topics: selectionTopics(),
          ...authorities(),
          now: NOW,
        }),
      "evaluation-mismatch",
    );
  });

  it("rejects a plan whose candidate or navigation evidence does not match the evaluation", () => {
    const input = fixture();
    const evaluation = evaluateIaCandidate(input).artifact;
    const mismatchedCandidate = planFixture(input, evaluation, { candidateId: "candidate:other" });
    const mismatchedNavigation = planFixture(input, evaluation, {
      navigationEvaluation: {
        ...evaluation.payload.navigationEvaluation,
        digest: "8".repeat(64),
      },
    });

    expectAuthorizationError(
      () =>
        authorizeTemplateScaffold({
          index: input.index,
          plan: mismatchedCandidate,
          evaluation,
          evaluationInput: input,
          topics: selectionTopics(),
          ...authorities(),
          now: NOW,
        }),
      "evaluation-mismatch",
    );
    expectAuthorizationError(
      () =>
        authorizeTemplateScaffold({
          index: input.index,
          plan: mismatchedNavigation,
          evaluation,
          evaluationInput: input,
          topics: selectionTopics(),
          ...authorities(),
          now: NOW,
        }),
      "evaluation-mismatch",
    );
  });

  it("rejects unapproved plans and approved plans without an external approver", () => {
    const input = fixture();
    const evaluation = evaluateIaCandidate(input).artifact;
    const pending = structuredClone(planFixture(input, evaluation));
    pending.payload.approval = { requirement: "maintainer", status: "pending" };
    pending.digest = canonicalArtifactDigest(pending);
    const selfApproved = planFixture(input, evaluation, {
      approval: {
        requirement: "none",
        status: "approved",
        approvedAt: "2026-08-03T15:00:00.000Z",
      },
    });

    // Durable plan validation rejects pending approval before the narrower
    // authorization layer is reached.
    expectAuthorizationError(
      () =>
        authorizeTemplateScaffold({
          index: input.index,
          plan: pending,
          evaluation,
          evaluationInput: input,
          topics: selectionTopics(),
          ...authorities(),
          now: NOW,
        }),
      "invalid-plan",
    );
    expectAuthorizationError(
      () =>
        authorizeTemplateScaffold({
          index: input.index,
          plan: selfApproved,
          evaluation,
          evaluationInput: input,
          topics: selectionTopics(),
          ...authorities(),
          now: NOW,
        }),
      "write-not-approved",
    );
  });

  it("rejects empty or non-create write scopes", () => {
    const input = fixture();
    const evaluation = evaluateIaCandidate(input).artifact;
    const empty = planFixture(input, evaluation, { outputScope: [] });
    const destructive = planFixture(input, evaluation, {
      outputScope: [{ path: "docs/get-started/index.md", operation: "move" }],
    });

    for (const plan of [empty, destructive]) {
      expectAuthorizationError(
        () =>
          authorizeTemplateScaffold({
            index: input.index,
            plan,
            evaluation,
            evaluationInput: input,
            topics: selectionTopics(),
            ...authorities(),
            now: NOW,
          }),
        "unsupported-output",
      );
    }

    const extraOutput = planFixture(input, evaluation, {
      outputScope: [
        { path: "docs/get-started/index.md", operation: "create" },
        { path: "docs/reference/index.md", operation: "create" },
      ],
    });
    expectAuthorizationError(
      () =>
        authorizeTemplateScaffold({
          index: input.index,
          plan: extraOutput,
          evaluation,
          evaluationInput: input,
          topics: selectionTopics(),
          ...authorities(),
          now: NOW,
        }),
      "selection-mismatch",
    );
  });
});

function expectAuthorizationError(
  action: () => unknown,
  code: TemplateAuthorizationError["code"],
): void {
  expect(action).toThrowError(new TemplateAuthorizationError(code));
}

function planFixture(
  input: EvaluateIaCandidateInput,
  evaluation: IaEvaluationArtifact,
  overrides: Partial<ArtifactPayloadByKind["ia-plan"]> = {},
): IaPlanArtifact {
  const candidate = input.candidates.payload.candidates[0]!;
  return createArtifact(
    "ia-plan",
    {
      planId: "plan:reader-job",
      candidateId: candidate.id,
      candidateArtifact: reference(input.candidates),
      scope: "site",
      primaryAxis: candidate.primaryAxis,
      secondaryAxes: candidate.secondaryAxes,
      groups: candidate.groups,
      useCases: [],
      rejectedCandidates: [],
      openDecisions: [],
      redirects: [],
      inboundLinkConsequences: [],
      navigationEvaluation: evaluation.payload.navigationEvaluation,
      policyBindings: [
        { id: "policy:stable-urls", version: "1", digest: "7".repeat(64) },
        { ...TEMPLATE_SELECTION_POLICY, digest: templateSelectionDigest(selectionTopics()) },
        CATALOG_BINDING,
        CHECK_BINDING,
      ],
      approval: {
        requirement: "maintainer",
        status: "approved",
        approvedBy: "maintainer:example",
        approvedAt: "2026-08-03T15:00:00.000Z",
      },
      expiresAt: "2026-08-04T16:00:00.000Z",
      outputScope: [{ path: "docs/get-started/index.md", operation: "create" }],
      ...overrides,
    },
    { index: input.index, now: NOW },
  );
}

function selectionTopics(): TemplatePreviewTopic[] {
  return [
    {
      id: "topic:get-started-index",
      slug: "get-started/index",
      title: "Get started",
      templateId: "get-started-overview-gfm",
      outputPath: "docs/get-started/index.md",
      productName: "DocsFab",
      evidenceNodeIds: [A1],
    },
  ];
}

function authorities(): {
  templateCatalog: typeof CATALOG_BINDING;
  repositoryChecks: typeof CHECK_BINDING;
} {
  return { templateCatalog: CATALOG_BINDING, repositoryChecks: CHECK_BINDING };
}

function reference<K extends "ia-candidates">(artifact: ArtifactEnvelope<K>): ArtifactReference<K> {
  return {
    kind: artifact.kind,
    schemaVersion: artifact.schemaVersion,
    digest: artifact.digest,
    repositoryRevision: artifact.repository.revision,
    repositoryContentDigest: artifact.repository.contentDigest,
  };
}

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
    navigationSuite: navigationSuite(),
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
