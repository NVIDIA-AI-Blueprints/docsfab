// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ARTIFACT_KINDS,
  ARTIFACT_REFERENCE_KINDS,
  ARTIFACT_REFERENCE_ONLY_KINDS,
  ArtifactValidationError,
  canonicalArtifactDigest,
  canonicalArtifactJson,
  createArtifact,
  evaluatePlanState,
  validateArtifact,
  validateArtifactReference,
  validateArtifactUse,
} from "../src/artifacts/index.js";
import type {
  Artifact,
  ArtifactKind,
  ArtifactPayloadByKind,
  ArtifactReference,
  ArtifactUse,
  IaPlanArtifact,
} from "../src/artifacts/index.js";
import type { ContentIndexV1 } from "../src/content-ir/index.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const examplesRoot = resolve(projectRoot, "test/fixtures/runtime-evaluation/artifacts/v1");
const REVISION = "a".repeat(40);
const CONTENT_DIGEST = "b".repeat(64);
const INDEX_DIGEST = "c".repeat(64);
const BEFORE_REVISION = "d".repeat(40);
const BEFORE_CONTENT_DIGEST = "e".repeat(64);
const BEFORE_INDEX_DIGEST = "f".repeat(64);
const POLICY_DIGEST = "1".repeat(64);
const NOW = new Date("2026-08-03T16:00:00.000Z");
const DOCUMENT_HOME = "document:home";
const DOCUMENT_GUIDE = "document:guide";
const SECTION_INTRO = "section:introduction";
const SECTION_INSTALL = "section:install";

const index: ContentIndexV1 = {
  schemaVersion: 1,
  repository: { revision: REVISION, contentDigest: CONTENT_DIGEST },
  indexDigest: INDEX_DIGEST,
  nodes: [
    documentNode(DOCUMENT_HOME, "docs/index.md", "introduction"),
    documentNode(DOCUMENT_GUIDE, "docs/guide.md", "install"),
    {
      id: SECTION_INTRO,
      kind: "section",
      documentId: DOCUMENT_HOME,
      sourcePath: "docs/index.md",
      anchor: "introduction",
      depth: 1,
      startLine: 1,
      endLine: 8,
    },
    {
      id: SECTION_INSTALL,
      kind: "section",
      documentId: DOCUMENT_GUIDE,
      sourcePath: "docs/guide.md",
      anchor: "install",
      depth: 1,
      startLine: 1,
      endLine: 12,
    },
  ],
  edges: [
    { kind: "parent", from: SECTION_INTRO, to: DOCUMENT_HOME },
    { kind: "child", from: DOCUMENT_HOME, to: SECTION_INTRO },
    { kind: "parent", from: SECTION_INSTALL, to: DOCUMENT_GUIDE },
    { kind: "child", from: DOCUMENT_GUIDE, to: SECTION_INSTALL },
    { kind: "navigation", from: DOCUMENT_HOME, to: DOCUMENT_GUIDE },
  ],
  evidence: {
    repositoryRevision: REVISION,
    contentDigest: CONTENT_DIGEST,
    indexDigest: INDEX_DIGEST,
    documentCount: 2,
    sectionCount: 2,
    edgeCount: 5,
  },
};

const beforeIndex: ContentIndexV1 = {
  ...index,
  repository: {
    revision: BEFORE_REVISION,
    contentDigest: BEFORE_CONTENT_DIGEST,
  },
  indexDigest: BEFORE_INDEX_DIGEST,
  evidence: {
    ...index.evidence,
    repositoryRevision: BEFORE_REVISION,
    contentDigest: BEFORE_CONTENT_DIGEST,
    indexDigest: BEFORE_INDEX_DIGEST,
  },
};

describe("versioned artifact contracts", () => {
  it("round-trips every v1 artifact kind with deterministic canonical digests", () => {
    const artifacts = createValidArtifacts();

    expect([...artifacts.keys()]).toEqual(ARTIFACT_KINDS);
    for (const [kind, artifact] of artifacts) {
      const roundTripped = JSON.parse(canonicalArtifactJson(artifact)) as unknown;
      expect(validateArtifact(roundTripped, { index, beforeIndex, now: NOW })).toEqual(artifact);
      expect(artifact.kind).toBe(kind);
      expect(artifact.digest).toBe(canonicalArtifactDigest(artifact));
      expect(artifact.repository).toEqual(index.repository);
    }

    const ontology = artifactByKind(artifacts, "ontology");
    const reordered = structuredClone(ontology);
    reordered.payload.entities.reverse();
    reordered.payload.relationships.reverse();
    for (const entity of reordered.payload.entities) entity.evidence.reverse();
    expect(canonicalArtifactDigest(reordered)).toBe(ontology.digest);
  });

  it("canonicalizes two-phase planning collections independently of input order", () => {
    const artifacts = createValidArtifacts();
    const evaluation = artifactByKind(artifacts, "ia-evaluation");
    const documents = index.nodes.filter((node) => node.kind === "document");
    const plan = mutateAndResign(artifactByKind(artifacts, "ia-plan"), (value) => {
      value.payload.mode = "reevaluate";
      value.payload.iaEvaluation = artifactReference(evaluation);
      value.payload.outputScope = [];
      value.payload.plannedPages = [];
      value.payload.migrationDispositions = documents.map((node, position) => ({
        nodeId: node.id,
        disposition: position === 0 ? "split" : "keep",
        destinationPaths: position === 0 ? ["docs/split/second.md", "docs/split/first.md"] : [],
        relatedNodeIds: position === 0 ? documents.slice(1).map((candidate) => candidate.id) : [],
        evidence: [{ path: node.sourcePath, nodeId: node.id }],
      }));
    });
    const permuted = structuredClone(plan);
    permuted.payload.plannedPages?.reverse();
    permuted.payload.migrationDispositions?.reverse();
    for (const disposition of permuted.payload.migrationDispositions ?? []) {
      disposition.destinationPaths.reverse();
      disposition.relatedNodeIds.reverse();
    }
    expect(canonicalArtifactDigest(permuted)).toBe(plan.digest);
  });

  it("keeps checked-in examples valid, revision-bound, and canonical", async () => {
    const artifacts = createValidArtifacts();
    for (const kind of ARTIFACT_KINDS) {
      const example = JSON.parse(
        await readFile(resolve(examplesRoot, `${kind}.json`), "utf8"),
      ) as unknown;
      const validated = validateArtifact(example, { index, beforeIndex, now: NOW });
      expect(validated).toEqual(artifacts.get(kind));
      expect(canonicalArtifactJson(example)).toBe(canonicalArtifactJson(validated));
    }
  });

  it("rejects unknown nested fields before artifact contents can propagate", () => {
    const ontology = artifactByKind(createValidArtifacts(), "ontology");
    expectArtifactError(
      mutateAndResign(ontology, (value) => {
        const entity = value.payload.entities[0];
        if (!entity) throw new Error("missing ontology entity fixture");
        Object.assign(entity, { promptInjection: true });
      }),
      "unknown-field",
    );
  });

  it.each([
    ["revision", { revision: "9".repeat(40), contentDigest: CONTENT_DIGEST }],
    ["content digest", { revision: REVISION, contentDigest: "9".repeat(64) }],
  ])("rejects a stale repository %s", (_label, repository) => {
    const ontology = artifactByKind(createValidArtifacts(), "ontology");
    expectArtifactError(
      mutateAndResign(ontology, (value) => {
        value.repository = repository;
      }),
      "repository-mismatch",
    );
  });

  it("rejects unresolved relationship, node, and entity identifiers", () => {
    const artifacts = createValidArtifacts();
    expectArtifactError(
      mutateAndResign(artifactByKind(artifacts, "ontology"), (value) => {
        value.payload.relationships[0]!.object = "entity:missing";
      }),
      "unresolved-endpoint",
    );
    expectArtifactError(
      mutateAndResign(artifactByKind(artifacts, "context-packet"), (value) => {
        value.payload.targetNodeId = "section:missing";
      }),
      "unresolved-endpoint",
    );
    expectArtifactError(
      mutateAndResign(artifactByKind(artifacts, "ontology"), (value) => {
        value.payload.relationships[0]!.subject = "entity:missing";
      }),
      "unresolved-endpoint",
    );
  });

  it.each([
    "/tmp/evidence.md",
    "../outside.md",
    "docs/../../outside.md",
    "docs\\index.md",
    "docs/index.md\0secret",
  ])("rejects unsafe repository evidence path %j", (path) => {
    const ontology = artifactByKind(createValidArtifacts(), "ontology");
    expectArtifactError(
      mutateAndResign(ontology, (value) => {
        value.payload.entities[0]!.evidence[0]!.path = path;
      }),
      "unsafe-path",
    );
  });

  it("requires evidence to identify an indexed node at the same source path", () => {
    const ontology = artifactByKind(createValidArtifacts(), "ontology");
    expectArtifactError(
      mutateAndResign(ontology, (value) => {
        const item = value.payload.entities[0]!.evidence[0]!;
        item.path = item.path === "docs/index.md" ? "docs/guide.md" : "docs/index.md";
      }),
      "unresolved-endpoint",
    );
    expectArtifactError(
      mutateAndResign(ontology, (value) => {
        value.payload.entities[0]!.evidence[0]!.path = "docs/missing.md";
      }),
      "unresolved-endpoint",
    );
    expectArtifactError(
      mutateAndResign(ontology, (value) => {
        delete (value.payload.entities[0]!.evidence[0] as { nodeId?: string }).nodeId;
      }),
      "missing-field",
    );
  });

  it("rejects invalid enums, duplicate IDs, and digest mismatches", () => {
    const ontology = artifactByKind(createValidArtifacts(), "ontology");
    expectArtifactError(
      mutateAndResign(ontology, (value) => {
        (value.payload.entities[0] as { kind: string }).kind = "persona";
      }),
      "invalid-enum",
    );
    expectArtifactError(
      mutateAndResign(ontology, (value) => {
        value.payload.entities[1]!.id = value.payload.entities[0]!.id;
      }),
      "duplicate-id",
    );
    expectArtifactError({ ...ontology, digest: "0".repeat(64) }, "digest-mismatch");
  });

  it("rejects a recommended IA candidate that is also rejected", () => {
    const candidates = artifactByKind(createValidArtifacts(), "ia-candidates");
    expectArtifactError(
      mutateAndResign(candidates, (value) => {
        value.payload.rejectedCandidates.push({
          candidateId: value.payload.recommendedCandidateId,
          reason: "lower-score",
        });
      }),
      "invalid-id",
    );
  });

  it("rejects an IA plan whose selected candidate is also rejected", () => {
    const plan = artifactByKind(createValidArtifacts(), "ia-plan");
    expectArtifactError(
      mutateAndResign(plan, (value) => {
        value.payload.rejectedCandidates.push({
          candidateId: value.payload.candidateId,
          reason: "policy-conflict",
        });
      }),
      "invalid-id",
    );
  });

  it("fails closed for unapproved, rejected, changes-requested, expired, and superseded plans", () => {
    const plan = artifactByKind(createValidArtifacts(), "ia-plan");
    const pending = mutateAndResign(plan, (value) => {
      value.payload.approval.status = "pending";
      delete value.payload.approval.approvedBy;
      delete value.payload.approval.approvedAt;
    });
    const rejected = mutateAndResign(plan, (value) => {
      value.payload.approval.status = "rejected";
      delete value.payload.approval.approvedBy;
      delete value.payload.approval.approvedAt;
    });
    const changesRequested = mutateAndResign(plan, (value) => {
      value.payload.approval.status = "changes-requested";
      delete value.payload.approval.approvedBy;
      delete value.payload.approval.approvedAt;
    });
    const expired = mutateAndResign(plan, (value) => {
      value.payload.expiresAt = "2026-08-03T15:59:59.000Z";
    });
    const replacement = mutateAndResign(plan, (value) => {
      value.payload.planId = "plan:replacement";
      value.payload.supersedes = artifactReference(plan);
    });

    expect(evaluatePlanState(plan, { now: NOW })).toBe("active");
    expect(evaluatePlanState(pending, { now: NOW })).toBe("unapproved");
    expect(evaluatePlanState(rejected, { now: NOW })).toBe("rejected");
    expect(evaluatePlanState(changesRequested, { now: NOW })).toBe("changes-requested");
    expect(evaluatePlanState(expired, { now: NOW })).toBe("expired");
    expect(evaluatePlanState(plan, { index, beforeIndex, now: NOW, activePlan: replacement })).toBe(
      "superseded",
    );
    expectArtifactError(pending, "plan-unapproved");
    expectArtifactError(changesRequested, "plan-unapproved");
    expectArtifactError(expired, "plan-expired");
    expectArtifactError(plan, "plan-superseded", { activePlan: replacement });
    expect(
      validateArtifact(pending, { index, beforeIndex, now: NOW, planAcceptance: "any" }),
    ).toEqual(pending);
    expect(
      validateArtifact(rejected, { index, beforeIndex, now: NOW, planAcceptance: "any" }),
    ).toEqual(rejected);
    expect(
      validateArtifact(changesRequested, {
        index,
        beforeIndex,
        now: NOW,
        planAcceptance: "any",
      }),
    ).toEqual(changesRequested);
  });

  it("requires an exact, same-scope supersession link", () => {
    const plan = artifactByKind(createValidArtifacts(), "ia-plan");
    const missingLink = mutateAndResign(plan, (value) => {
      value.payload.planId = "plan:missing-link";
    });
    const unrelatedScope = mutateAndResign(plan, (value) => {
      value.payload.planId = "plan:other-page";
      value.payload.scope = "page";
      value.payload.targetNodeId = DOCUMENT_GUIDE;
      value.payload.supersedes = artifactReference(plan);
    });

    expect(evaluatePlanState(plan, { index, beforeIndex, now: NOW, activePlan: missingLink })).toBe(
      "active",
    );
    expect(
      evaluatePlanState(plan, { index, beforeIndex, now: NOW, activePlan: unrelatedScope }),
    ).toBe("active");
    expect(
      validateArtifact(plan, { index, beforeIndex, now: NOW, activePlan: missingLink }),
    ).toEqual(plan);
    expect(
      validateArtifact(plan, { index, beforeIndex, now: NOW, activePlan: unrelatedScope }),
    ).toEqual(plan);
  });

  it("derives supersession from a fully validated active plan", () => {
    const artifacts = createValidArtifacts();
    const plan = artifactByKind(artifacts, "ia-plan");
    const replacement = mutateAndResign(plan, (value) => {
      value.payload.planId = "plan:replacement";
      value.payload.supersedes = artifactReference(plan);
    });
    const invalidReplacement = mutateAndResign(replacement, (value) => {
      value.payload.candidateArtifact.repositoryRevision = "9".repeat(40);
    });
    const invalidStatus = mutateAndResign(plan, (value) => {
      (value.payload.approval as { status: string }).status = "superseded";
      delete value.payload.approval.approvedBy;
      delete value.payload.approval.approvedAt;
    });

    expect(evaluatePlanState(plan, { index, beforeIndex, now: NOW, activePlan: replacement })).toBe(
      "superseded",
    );
    expectOperationError(
      () => evaluatePlanState(plan, { now: NOW, activePlan: replacement }),
      "missing-field",
    );
    expectOperationError(
      () =>
        evaluatePlanState(plan, {
          index,
          beforeIndex,
          now: NOW,
          activePlan: artifactByKind(artifacts, "ontology") as unknown as IaPlanArtifact,
        }),
      "invalid-enum",
    );
    expectArtifactError(plan, "repository-mismatch", { activePlan: invalidReplacement });
    expectArtifactError(invalidStatus, "invalid-enum");
  });

  it("rejects inconsistent approval metadata and chronology", () => {
    const plan = artifactByKind(createValidArtifacts(), "ia-plan");
    expectArtifactError(
      mutateAndResign(plan, (value) => {
        value.payload.approval.approvedAt = "2026-08-03T16:00:00.001Z";
      }),
      "invalid-time",
    );
    expectArtifactError(
      mutateAndResign(plan, (value) => {
        value.payload.approval.approvedAt = value.payload.expiresAt;
      }),
      "invalid-time",
    );
    expectArtifactError(
      mutateAndResign(plan, (value) => {
        value.payload.approval.status = "pending";
      }),
      "invalid-type",
    );
  });

  it("binds plans to an exact candidates artifact and navigation tasks to queries", () => {
    const artifacts = createValidArtifacts();
    const plan = artifactByKind(artifacts, "ia-plan");
    expectArtifactError(
      mutateAndResign(plan, (value) => {
        value.payload.candidateArtifact.repositoryContentDigest = "9".repeat(64);
      }),
      "repository-mismatch",
    );
    const navigation = artifactByKind(artifacts, "navigation-evaluation");
    expectArtifactError(
      mutateAndResign(navigation, (value) => {
        delete (value.payload.tasks[0] as { query?: string }).query;
      }),
      "missing-field",
    );
  });

  it("fails closed for inconsistent IA evaluation gates and unbounded scores", () => {
    const evaluation = artifactByKind(createValidArtifacts(), "ia-evaluation");
    expectArtifactError(
      mutateAndResign(evaluation, (value) => {
        value.payload.eligible = false;
      }),
      "invalid-type",
    );
    expectArtifactError(
      mutateAndResign(evaluation, (value) => {
        value.payload.blockingDiagnosticDigests = ["9".repeat(64)];
      }),
      "invalid-type",
    );
    expectArtifactError(
      mutateAndResign(evaluation, (value) => {
        value.payload.scores.total = 101;
      }),
      "invalid-type",
    );
    expectArtifactError(
      mutateAndResign(evaluation, (value) => {
        value.payload.navigationEvaluation.repositoryRevision = "9".repeat(40);
      }),
      "repository-mismatch",
    );
  });

  it("binds both sides of an impact report to supplied indexes", () => {
    const impact = artifactByKind(createValidArtifacts(), "impact-report");
    expectArtifactError(
      mutateAndResign(impact, (value) => {
        value.payload.beforeIndexDigest = "9".repeat(64);
      }),
      "repository-mismatch",
    );
    expectArtifactError(
      mutateAndResign(impact, (value) => {
        value.payload.beforeRepository.revision = "9".repeat(40);
      }),
      "repository-mismatch",
    );
    expectArtifactError(impact, "repository-mismatch", {}, { beforeIndex: undefined });
  });

  it("recomputes navigation metrics from task results", () => {
    const navigation = artifactByKind(createValidArtifacts(), "navigation-evaluation");
    expectArtifactError(
      mutateAndResign(navigation, (value) => {
        value.payload.metrics.recallAt3 = 0.75;
      }),
      "invalid-metrics",
    );
  });

  it("canonicalizes navigation task and result mappings independently of input order", () => {
    const navigation = artifactByKind(createValidArtifacts(), "navigation-evaluation");
    const permuted = structuredClone(navigation);
    permuted.payload.tasks.reverse();
    permuted.payload.results.reverse();

    expect(canonicalArtifactJson(permuted)).toBe(canonicalArtifactJson(navigation));
    expect(canonicalArtifactDigest(permuted)).toBe(navigation.digest);
    expect(validateArtifact(permuted, { index, beforeIndex, now: NOW })).toEqual(navigation);
  });

  it.each([
    {
      name: "matched result with no accepted node",
      rankedNodeIds: [SECTION_INSTALL],
      outcome: "matched" as const,
    },
    {
      name: "missed result with an accepted node",
      rankedNodeIds: [SECTION_INTRO],
      outcome: "missed" as const,
    },
    {
      name: "ambiguous result relabeled matched",
      rankedNodeIds: [SECTION_INTRO, DOCUMENT_HOME],
      outcome: "matched" as const,
    },
    {
      name: "ambiguous result relabeled missed",
      rankedNodeIds: [SECTION_INTRO, DOCUMENT_HOME],
      outcome: "missed" as const,
    },
  ])("rejects contradictory navigation outcome: $name", ({ rankedNodeIds, outcome }) => {
    const navigation = artifactByKind(createValidArtifacts(), "navigation-evaluation");
    expectArtifactError(
      mutateAndResign(navigation, (value) => {
        value.payload.results[0] = {
          taskId: "task:get-started",
          rankedNodeIds,
          outcome,
        };
      }),
      "invalid-enum",
    );
  });

  it("accepts all four deterministically derived navigation outcomes", () => {
    const missed = navigationPayload();
    missed.results[1] = {
      taskId: "task:install",
      rankedNodeIds: [DOCUMENT_HOME],
      outcome: "missed",
    };
    missed.metrics.noResultRate = 0;
    expect(
      create("navigation-evaluation", missed).payload.results.map((result) => result.outcome),
    ).toEqual(["matched", "missed"]);

    const ambiguous = navigationPayload();
    ambiguous.results[0] = {
      taskId: "task:get-started",
      rankedNodeIds: [SECTION_INTRO, DOCUMENT_HOME],
      outcome: "ambiguous",
    };
    ambiguous.metrics.ambiguousPlacementRate = 0.5;
    expect(
      create("navigation-evaluation", ambiguous).payload.results.map((result) => result.outcome),
    ).toEqual(["ambiguous", "no-result"]);
  });

  it("validates content-free artifact references and run-record uses", () => {
    const ontology = artifactByKind(createValidArtifacts(), "ontology");
    const reference = artifactReference(ontology);
    const use: ArtifactUse = {
      role: "input",
      stepId: "compile-context",
      reference,
    };

    expect(validateArtifactReference(reference, { index, expectedKind: "ontology" })).toEqual(
      reference,
    );
    expect(Object.keys(reference).sort()).toEqual([
      "digest",
      "kind",
      "repositoryContentDigest",
      "repositoryRevision",
      "schemaVersion",
    ]);
    expect(canonicalArtifactJson(use)).not.toContain("Operator");
    expect(canonicalArtifactJson(use)).not.toContain("relationships");
  });

  it.each(ARTIFACT_REFERENCE_ONLY_KINDS)(
    "accepts reference-only %s identities in ArtifactUse without widening envelopes",
    (kind) => {
      const reference: ArtifactReference<typeof kind> = {
        kind,
        schemaVersion: kind === "editorial-decision" ? 3 : 1,
        digest: "8".repeat(64),
        repositoryRevision: REVISION,
        repositoryContentDigest: CONTENT_DIGEST,
      };
      const use: ArtifactUse = { role: "output", stepId: "roadmap-step", reference };

      expect(ARTIFACT_REFERENCE_KINDS).toContain(kind);
      expect(ARTIFACT_KINDS).not.toContain(kind as never);
      expect(validateArtifactReference(reference, { index, expectedKind: kind })).toEqual(
        reference,
      );
      expect(validateArtifactUse(use)).toEqual(use);

      expectArtifactError(
        {
          schemaVersion: 1,
          kind,
          repository: { revision: REVISION, contentDigest: CONTENT_DIGEST },
          digest: canonicalArtifactDigest({
            schemaVersion: 1,
            kind,
            repository: { revision: REVISION, contentDigest: CONTENT_DIGEST },
            payload: {},
          }),
          payload: {},
        },
        "invalid-enum",
      );
    },
  );

  it("rejects unknown and content-bearing fields on reference-only ArtifactUse values", () => {
    const reference = {
      kind: "roadmap-ledger",
      schemaVersion: 1,
      digest: "8".repeat(64),
      repositoryRevision: REVISION,
      repositoryContentDigest: CONTENT_DIGEST,
    } as const;
    expectOperationError(
      () =>
        validateArtifactUse({
          role: "input",
          reference: { ...reference, payload: { raw: "secret" } },
        }),
      "unknown-field",
    );
    expectOperationError(
      () => validateArtifactReference({ ...reference, kind: "roadmap-receipt" }),
      "invalid-enum",
    );
  });
});

function documentNode(id: string, sourcePath: string, anchor: string) {
  return {
    id,
    kind: "document" as const,
    sourcePath,
    format: "markdown" as const,
    byteLength: 32,
    anchors: [anchor],
    frontmatter: [],
    directives: [],
    codeBlocks: [],
    regions: {
      body: "2".repeat(64),
      headings: "3".repeat(64),
      metadata: "4".repeat(64),
      navigation: "5".repeat(64),
      graph: "6".repeat(64),
    },
  };
}

function createValidArtifacts(): Map<ArtifactKind, Artifact> {
  const navigation = create("navigation-evaluation", navigationPayload());
  const impact = create("impact-report", impactPayload());
  const candidates = create("ia-candidates", candidatesPayload());
  const iaEvaluation = create(
    "ia-evaluation",
    iaEvaluationPayload(artifactReference(candidates), artifactReference(navigation)),
  );
  const payloads: { [K in ArtifactKind]: ArtifactPayloadByKind[K] } = {
    ontology: ontologyPayload(),
    "context-packet": contextPayload(),
    "ia-candidates": candidates.payload,
    "ia-evaluation": iaEvaluation.payload,
    "ia-plan": planPayload(artifactReference(candidates), artifactReference(navigation)),
    "impact-report": impact.payload,
    "healing-report": healingPayload(artifactReference(impact)),
    "navigation-evaluation": navigation.payload,
  };
  return new Map(ARTIFACT_KINDS.map((kind) => [kind, create(kind, payloads[kind])])) as Map<
    ArtifactKind,
    Artifact
  >;
}

function iaEvaluationPayload(
  candidateArtifact: ArtifactReference<"ia-candidates">,
  navigationEvaluation: ArtifactReference<"navigation-evaluation">,
): ArtifactPayloadByKind["ia-evaluation"] {
  return {
    candidateArtifact,
    candidateId: "candidate:reader-job",
    diagnosticsDigest: "2".repeat(64),
    scoringDigest: "3".repeat(64),
    topologyDigest: "4".repeat(64),
    navigationComparisonDigest: "6".repeat(64),
    navigationEvaluation,
    navigationSuite: { id: "suite:mvp", version: "1", digest: "5".repeat(64) },
    scores: {
      evidenceCoverage: 100,
      cohesion: 90,
      separation: 88,
      predictability: 92,
      balance: 84,
      stability: 100,
      duplication: 100,
      total: 93,
      structuralFindability: 94,
    },
    deterministicStatus: "passed",
    eligible: true,
    blockingDiagnosticDigests: [],
    policyBindings: [{ id: "policy:ia-evaluation", version: "1", digest: POLICY_DIGEST }],
    evidence: [{ path: "docs/index.md", nodeId: DOCUMENT_HOME }],
  };
}

function create<K extends ArtifactKind>(
  kind: K,
  payload: ArtifactPayloadByKind[K],
): Extract<Artifact, { kind: K }> {
  return createArtifact(kind, payload, { index, beforeIndex, now: NOW });
}

function ontologyPayload(): ArtifactPayloadByKind["ontology"] {
  return {
    entities: [
      {
        id: "entity:operator",
        label: "Operator",
        kind: "actor",
        evidence: [{ path: "docs/index.md", nodeId: SECTION_INTRO }],
      },
      {
        id: "entity:configure",
        label: "Configure DocsFab",
        kind: "user-job",
        evidence: [{ path: "docs/guide.md", nodeId: SECTION_INSTALL }],
      },
    ],
    relationships: [
      {
        subject: "entity:operator",
        predicate: "requires",
        object: "entity:configure",
        evidence: [{ path: "docs/guide.md", nodeId: SECTION_INSTALL }],
      },
    ],
  };
}

function contextPayload(): ArtifactPayloadByKind["context-packet"] {
  return {
    targetNodeId: SECTION_INTRO,
    pageRole: {
      contentType: "tutorial",
      readerJob: "entity:configure",
      canonicalParentId: DOCUMENT_HOME,
      organizingAxis: "reader-job",
    },
    ancestors: [DOCUMENT_HOME],
    siblings: [],
    relatedCanonicalPages: [DOCUMENT_GUIDE],
    placementRules: {
      belongsHere: ["entity:operator"],
      belongsElsewhere: ["entity:configure"],
    },
    activeDecisionIds: ["decision:keep-quickstart"],
    structuralPressure: "healthy",
    evidence: [{ path: "docs/index.md", nodeId: SECTION_INTRO }],
  };
}

function candidatesPayload(): ArtifactPayloadByKind["ia-candidates"] {
  return {
    scope: "site",
    candidates: [
      {
        id: "candidate:reader-job",
        primaryAxis: "reader-job",
        secondaryAxes: ["lifecycle"],
        score: 92,
        groups: [
          {
            id: "group:get-started",
            label: "Get started",
            axis: "reader-job",
            members: [DOCUMENT_HOME, DOCUMENT_GUIDE],
            canonicalPath: "docs/get-started",
            evidence: [{ path: "docs/index.md", nodeId: DOCUMENT_HOME }],
          },
        ],
        evidence: [{ path: "docs/index.md", nodeId: DOCUMENT_HOME }],
      },
      {
        id: "candidate:component",
        primaryAxis: "component",
        secondaryAxes: [],
        score: 64,
        groups: [
          {
            id: "group:docsfab",
            label: "DocsFab",
            axis: "component",
            members: [DOCUMENT_HOME, DOCUMENT_GUIDE],
            canonicalPath: "docs/docsfab",
            evidence: [{ path: "docs/guide.md", nodeId: DOCUMENT_GUIDE }],
          },
        ],
        evidence: [{ path: "docs/guide.md", nodeId: DOCUMENT_GUIDE }],
      },
    ],
    recommendedCandidateId: "candidate:reader-job",
    rejectedCandidates: [{ candidateId: "candidate:component", reason: "lower-score" }],
    openDecisions: [
      {
        id: "decision:keep-quickstart",
        kind: "canonical-home",
        evidence: [{ path: "docs/index.md", nodeId: DOCUMENT_HOME }],
      },
    ],
  };
}

function planPayload(
  candidateArtifact: ArtifactReference<"ia-candidates">,
  navigationEvaluation: ArtifactReference<"navigation-evaluation">,
): ArtifactPayloadByKind["ia-plan"] {
  const chosen = candidatesPayload().candidates[0]!;
  return {
    planId: "plan:reader-job",
    candidateId: chosen.id,
    candidateArtifact,
    scope: "site",
    primaryAxis: chosen.primaryAxis,
    secondaryAxes: chosen.secondaryAxes,
    groups: chosen.groups,
    useCases: [
      {
        id: "use-case:first-run",
        actor: "entity:operator",
        trigger: "DocsFab is installed",
        goal: "Run a governed documentation workflow",
        input: "A local documentation repository",
        outcome: "A reviewable patch and evidence record",
        evidence: [{ path: "docs/index.md", nodeId: SECTION_INTRO }],
      },
    ],
    rejectedCandidates: [{ candidateId: "candidate:component", reason: "lower-score" }],
    openDecisions: [],
    redirects: [{ from: "docs/guide.md", to: "docs/get-started/guide.md" }],
    inboundLinkConsequences: [{ nodeId: DOCUMENT_GUIDE, disposition: "move" }],
    navigationEvaluation,
    policyBindings: [{ id: "policy:stable-urls", version: "1", digest: POLICY_DIGEST }],
    approval: {
      requirement: "maintainer",
      status: "approved",
      approvedBy: "maintainer:example",
      approvedAt: "2026-08-03T15:00:00.000Z",
    },
    expiresAt: "2026-08-04T16:00:00.000Z",
    outputScope: [
      { path: "docs/get-started/index.md", operation: "create" },
      { path: "docs/get-started/guide.md", operation: "move" },
    ],
  };
}

function impactPayload(): ArtifactPayloadByKind["impact-report"] {
  return {
    beforeRepository: { revision: BEFORE_REVISION, contentDigest: BEFORE_CONTENT_DIGEST },
    afterRepository: index.repository,
    beforeIndexDigest: BEFORE_INDEX_DIGEST,
    afterIndexDigest: INDEX_DIGEST,
    changedPaths: ["docs/guide.md"],
    structuralRegions: ["body", "navigation"],
    ontologyDelta: {
      addedEntityIds: [],
      removedEntityIds: [],
      changedEntityIds: ["entity:configure"],
      addedRelationshipCount: 0,
      removedRelationshipCount: 0,
    },
    affectedNodeIds: [DOCUMENT_GUIDE, SECTION_INSTALL],
    navigationPressure: "elevated",
    semanticImpact: "localized",
    recommendedAction: "bounded-repair",
    requiredApproval: "maintainer",
    evidence: [{ path: "docs/guide.md", nodeId: SECTION_INSTALL }],
  };
}

function healingPayload(
  impactReport: ArtifactReference<"impact-report">,
): ArtifactPayloadByKind["healing-report"] {
  return {
    impactReport,
    recommendations: [
      {
        id: "recommendation:update-navigation",
        level: "bounded-repair",
        disposition: "cross-link",
        targetNodeIds: [DOCUMENT_HOME, DOCUMENT_GUIDE],
        outputPaths: ["docs/index.md"],
        evidence: [{ path: "docs/index.md", nodeId: DOCUMENT_HOME }],
      },
    ],
    requiredApproval: "maintainer",
  };
}

function navigationPayload(): ArtifactPayloadByKind["navigation-evaluation"] {
  return {
    tasks: [
      {
        id: "task:get-started",
        query: "How do I get started with DocsFab?",
        expectedNodeIds: [SECTION_INTRO],
        acceptableNodeIds: [DOCUMENT_HOME],
      },
      {
        id: "task:install",
        query: "How do I install DocsFab?",
        expectedNodeIds: [SECTION_INSTALL],
        acceptableNodeIds: [],
      },
    ],
    results: [
      { taskId: "task:get-started", rankedNodeIds: [SECTION_INTRO], outcome: "matched" },
      { taskId: "task:install", rankedNodeIds: [], outcome: "no-result" },
    ],
    metrics: {
      taskCount: 2,
      agreementRate: 0.5,
      recallAt3: 0.5,
      meanReciprocalRank: 0.5,
      noResultRate: 0.5,
      ambiguousPlacementRate: 0,
    },
  };
}

function artifactReference<K extends ArtifactKind>(
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

function artifactByKind<K extends ArtifactKind>(
  artifacts: ReadonlyMap<ArtifactKind, Artifact>,
  kind: K,
): Extract<Artifact, { kind: K }> {
  const artifact = artifacts.get(kind);
  if (artifact?.kind !== kind) {
    throw new Error(`missing ${kind} artifact fixture`);
  }
  return artifact as Extract<Artifact, { kind: K }>;
}

function mutateAndResign<T extends Artifact>(artifact: T, mutation: (value: T) => void): T {
  const changed = structuredClone(artifact);
  mutation(changed);
  changed.digest = canonicalArtifactDigest(changed);
  return changed;
}

function expectArtifactError(
  value: unknown,
  code: ArtifactValidationError["code"],
  options: { activePlan?: IaPlanArtifact } = {},
  validationOverrides: Partial<Parameters<typeof validateArtifact>[1]> = {},
): void {
  try {
    validateArtifact(value, { index, beforeIndex, now: NOW, ...options, ...validationOverrides });
    throw new Error(`Expected artifact validation to fail with ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactValidationError);
    expect((error as ArtifactValidationError).code).toBe(code);
  }
}

function expectOperationError(
  operation: () => unknown,
  code: ArtifactValidationError["code"],
): void {
  try {
    operation();
    throw new Error(`Expected artifact validation to fail with ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactValidationError);
    expect((error as ArtifactValidationError).code).toBe(code);
  }
}
