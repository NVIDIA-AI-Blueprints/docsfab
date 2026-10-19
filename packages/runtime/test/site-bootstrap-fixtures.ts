// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync, type KeyObject } from "node:crypto";

import {
  createArtifact,
  type ArtifactEnvelope,
  type ArtifactEvidence,
  type ArtifactReference,
  type IaCandidate,
  type OntologyEntity,
  type PolicyBinding,
} from "../src/artifacts/index.js";
import type { ContentIndexV1 } from "../src/content-ir/index.js";
import { TEMPLATE_CATALOG_POLICY } from "../src/templates/load.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import {
  DEFAULT_IA_DIAGNOSTIC_POLICY,
  evaluateIaCandidate,
  iaPlanReviewerPolicyDigest,
  prepareIaPlanReviewerAuthorization,
  reviewIaPlan,
  type EvaluateIaCandidateInput,
  type IaPlanReviewerPolicy,
  type IaStructuralProjection,
  type NavigationRankCandidate,
  type NavigationRankings,
  type VersionedNavigationSuite,
} from "../src/ia/index.js";
import {
  createSiteBootstrapApplicationBundle,
  type SiteBootstrapApplicationBundle,
} from "../src/site-bootstrap/index.js";
import type { TemplatePreviewTopic } from "../src/templates/contracts.js";
import { TEMPLATE_SELECTION_POLICY, templateSelectionDigest } from "../src/templates/selection.js";

const A1 = "document:operate/run.md";
const A2 = "document:operate/debug.md";
const B1 = "document:concepts/model.md";
const B2 = "document:concepts/policy.md";
const OA = "document:operate/index.md";
const OB = "document:concepts/index.md";

export const CATALOG_POLICY: PolicyBinding = {
  id: TEMPLATE_CATALOG_POLICY.id,
  version: TEMPLATE_CATALOG_POLICY.version,
  digest: "d".repeat(64),
};
export const CHECK_POLICY: PolicyBinding = {
  id: "docsfab:repository-checks:test",
  version: "1",
  digest: "e".repeat(64),
};

const DEFAULT_REVIEWER_KEYS = generateKeyPairSync("ed25519");
const DEFAULT_REVIEWER_POLICY_VALUE = {
  id: "docsfab:site-bootstrap-reviewers",
  version: "1",
  reviewers: [
    {
      id: "maintainer:docs",
      role: "maintainer" as const,
      publicKey: DEFAULT_REVIEWER_KEYS.publicKey
        .export({
          type: "spki",
          format: "pem",
        })
        .toString(),
    },
  ],
};
export const SITE_BOOTSTRAP_REVIEWER_POLICY: IaPlanReviewerPolicy = {
  ...DEFAULT_REVIEWER_POLICY_VALUE,
  digest: iaPlanReviewerPolicyDigest(DEFAULT_REVIEWER_POLICY_VALUE),
};

export interface SiteBootstrapReviewerFixture {
  policy: IaPlanReviewerPolicy;
  reviewerId: string;
  privateKey: KeyObject;
}

export function siteBootstrapIndex(revision: string): ContentIndexV1 {
  const nodes = [OA, OB, A1, A2, B1, B2].map((id) => ({
    id,
    kind: "document" as const,
    sourcePath: sourcePathFor(id),
    format: "gfm" as const,
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
  }));
  return bindIndex({
    schemaVersion: 1,
    repository: { revision, contentDigest: "b".repeat(64) },
    indexDigest: "c".repeat(64),
    nodes,
    edges: [],
    evidence: {
      repositoryRevision: revision,
      contentDigest: "b".repeat(64),
      indexDigest: "c".repeat(64),
      documentCount: nodes.length,
      sectionCount: 0,
      edgeCount: 0,
    },
  });
}

export function siteBootstrapAfterIndex(before: ContentIndexV1): ContentIndexV1 {
  const sourcePath = "docs/get-started/quickstart.md";
  const added = {
    id: `document:${sourcePath}`,
    kind: "document" as const,
    sourcePath,
    format: "gfm" as const,
    byteLength: 13,
    anchors: [],
    frontmatter: [],
    directives: [],
    codeBlocks: [],
    regions: {
      body: "8".repeat(64),
      headings: "9".repeat(64),
      metadata: "a".repeat(64),
      navigation: "d".repeat(64),
      graph: "e".repeat(64),
    },
  };
  const nodes = [...before.nodes, added];
  return bindIndex({
    ...structuredClone(before),
    repository: {
      revision: before.repository.revision,
      contentDigest: "f".repeat(64),
    },
    indexDigest: "0".repeat(64),
    nodes,
    evidence: {
      ...before.evidence,
      contentDigest: "f".repeat(64),
      indexDigest: "0".repeat(64),
      documentCount: before.evidence.documentCount + 1,
    },
  });
}

function bindIndex(value: ContentIndexV1): ContentIndexV1 {
  const indexDigest = canonicalDigest({
    schemaVersion: value.schemaVersion,
    repository: value.repository,
    nodes: value.nodes,
    edges: value.edges,
  });
  return { ...value, indexDigest, evidence: { ...value.evidence, indexDigest } };
}

export function siteBootstrapBundle(
  index: ContentIndexV1,
  now: Date,
  reviewer: SiteBootstrapReviewerFixture = {
    policy: SITE_BOOTSTRAP_REVIEWER_POLICY,
    reviewerId: "maintainer:docs",
    privateKey: DEFAULT_REVIEWER_KEYS.privateKey,
  },
): SiteBootstrapApplicationBundle {
  const input = evaluationInput(index);
  const evaluation = evaluateIaCandidate(input).artifact;
  const topics = selectionTopics();
  const candidate = input.candidates.payload.candidates[0]!;
  const pendingPlan = createArtifact(
    "ia-plan",
    {
      planId: "plan:site-bootstrap",
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
      iaEvaluation: reference(evaluation),
      policyBindings: [
        { id: "policy:stable-urls", version: "1", digest: "7".repeat(64) },
        { ...TEMPLATE_SELECTION_POLICY, digest: templateSelectionDigest(topics) },
        CATALOG_POLICY,
        CHECK_POLICY,
      ],
      approval: {
        requirement: "maintainer",
        status: "pending",
      },
      expiresAt: new Date(now.valueOf() + 60 * 60_000).toISOString(),
      outputScope: topics.map((topic) => ({ path: topic.outputPath, operation: "create" })),
      mode: "create",
      plannedPages: topics.map((topic) => ({
        topicId: topic.id,
        title: topic.title,
        slug: topic.slug,
        templateId: topic.templateId,
        format: "gfm" as const,
        outputPath: topic.outputPath,
        evidence: [evidence(A1)],
      })),
      migrationDispositions: [],
    },
    { index, now, planAcceptance: "any" },
  );
  const transition = reviewIaPlan({
    index,
    plan: pendingPlan,
    authorization: prepareIaPlanReviewerAuthorization({
      policy: reviewer.policy,
      reviewerId: reviewer.reviewerId,
      privateKey: reviewer.privateKey,
      now: () => new Date(now.valueOf() - 60_000),
    }),
    decision: "approved",
  });
  const plan = transition.plan;
  return createSiteBootstrapApplicationBundle(
    {
      schemaVersion: 1,
      kind: "site-bootstrap-application",
      repository: {
        ...index.repository,
        indexDigest: index.indexDigest,
      },
      plan,
      review: transition.review,
      reviewerPolicy: {
        id: reviewer.policy.id,
        version: reviewer.policy.version,
        digest: reviewer.policy.digest,
      },
      evaluation,
      evaluationInput: input,
      topics,
      templateCatalogPolicy: CATALOG_POLICY,
      repositoryCheckPolicy: CHECK_POLICY,
    },
    { now, reviewerPolicy: reviewer.policy },
  );
}

function selectionTopics(): TemplatePreviewTopic[] {
  return [
    {
      id: "topic:quickstart",
      slug: "get-started/quickstart",
      title: "Quickstart",
      templateId: "quickstart-gfm",
      outputPath: "docs/get-started/quickstart.md",
      productName: "DocsFab",
      evidenceNodeIds: [A1],
    },
  ];
}

function evaluationInput(index: ContentIndexV1): EvaluateIaCandidateInput {
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
  const rankings = passingRankings();
  return {
    index,
    ontology,
    candidates,
    semantics: structure.topicNodeIds.map((nodeId) => contextPacket(index, nodeId)),
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

function reference<K extends "ia-candidates" | "ia-evaluation">(
  artifact: ArtifactEnvelope<K>,
): ArtifactReference<K> {
  return {
    kind: artifact.kind,
    schemaVersion: artifact.schemaVersion,
    digest: artifact.digest,
    repositoryRevision: artifact.repository.revision,
    repositoryContentDigest: artifact.repository.contentDigest,
  };
}

function evidence(nodeId: string): ArtifactEvidence {
  return { path: sourcePathFor(nodeId), nodeId };
}

function sourcePathFor(nodeId: string): string {
  return nodeId.replace(/^document:/u, "");
}
