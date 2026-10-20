// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createArtifact,
  evaluatePlanState,
  validateArtifact,
  type IaMigrationDisposition,
  type IaPlannedPage,
  type IaScope,
} from "../src/artifacts/index.js";
import type { ContentIndexV1, ContentNode, DocumentNode } from "../src/content-ir/index.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import {
  createIaPlanningOutcome,
  IaPlanningError,
  type IaEvaluatedPlanningInput,
} from "../src/ia/planning.js";
import { passedIaEvaluationFixture } from "./ia-evaluation-fixture.js";

const REVISION = "a".repeat(40);
const INDEX_DIGEST = "b".repeat(64);
const CONTENT_DIGEST = "c".repeat(64);
const POLICY_DIGEST = "d".repeat(64);
const DOCUMENT_HOME = "document:docs/index.md";
const DOCUMENT_GUIDE = "document:docs/guide.md";
const SECTION_INSTALL = "section:docs/guide.md#install";
const NOW = new Date("2026-08-03T12:00:00.000Z");

const unboundIndex: ContentIndexV1 = {
  schemaVersion: 1,
  repository: { revision: REVISION, contentDigest: CONTENT_DIGEST },
  indexDigest: INDEX_DIGEST,
  nodes: [
    document(DOCUMENT_HOME, "docs/index.md"),
    document(DOCUMENT_GUIDE, "docs/guide.md"),
    {
      id: SECTION_INSTALL,
      kind: "section",
      documentId: DOCUMENT_GUIDE,
      sourcePath: "docs/guide.md",
      anchor: "install",
      depth: 2,
      startLine: 3,
      endLine: 8,
    },
  ],
  edges: [{ kind: "parent", from: DOCUMENT_GUIDE, to: DOCUMENT_HOME }],
  evidence: {
    repositoryRevision: REVISION,
    contentDigest: CONTENT_DIGEST,
    indexDigest: INDEX_DIGEST,
    documentCount: 2,
    sectionCount: 1,
    edgeCount: 1,
  },
};
const canonicalIndexDigest = canonicalDigest({
  schemaVersion: 1,
  repository: unboundIndex.repository,
  nodes: unboundIndex.nodes,
  edges: unboundIndex.edges,
});
const index: ContentIndexV1 = {
  ...unboundIndex,
  indexDigest: canonicalIndexDigest,
  evidence: { ...unboundIndex.evidence, indexDigest: canonicalIndexDigest },
};

describe("two-phase IA planning", () => {
  it("creates a pending read-only site plan without weakening active apply validation", () => {
    const input = evaluatedInput("site", "create");
    input.plannedPages = [plannedPage()];
    const outcome = createIaPlanningOutcome(input);

    expect(outcome).toMatchObject({
      status: "plan-ready",
      scope: "site",
      mode: "create",
      writesPerformed: false,
      plan: {
        payload: {
          mode: "create",
          approval: { status: "pending", requirement: "maintainer" },
          plannedPages: [{ outputPath: "docs/get-started.md", format: "gfm" }],
          migrationDispositions: [],
          outputScope: [{ path: "docs/get-started.md", operation: "create" }],
        },
      },
    });
    if (!("plan" in outcome)) throw new Error("Expected a plan.");
    expect(validateArtifact(outcome.plan, { index, now: NOW, planAcceptance: "any" })).toEqual(
      outcome.plan,
    );
    expect(() => validateArtifact(outcome.plan, { index, now: NOW })).toThrow("plan-unapproved");
    expect(evaluatePlanState(outcome.plan, { now: NOW })).toBe("unapproved");
  });

  it("returns an explicit human-decision migration plan for a reevaluated site", () => {
    const input = evaluatedInput("site", "reevaluate");
    input.migrationDispositions = [
      migration(DOCUMENT_HOME, "keep"),
      migration(DOCUMENT_GUIDE, "needs-human-decision"),
    ];
    const outcome = createIaPlanningOutcome(input);

    expect(outcome).toMatchObject({
      status: "needs-human-decision",
      writesPerformed: false,
      plan: {
        payload: {
          mode: "reevaluate",
          plannedPages: [],
          outputScope: [],
        },
      },
    });
    if (!("plan" in outcome)) throw new Error("Expected a plan.");
    expect(outcome.plan.payload.migrationDispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: DOCUMENT_HOME, disposition: "keep" }),
        expect.objectContaining({
          nodeId: DOCUMENT_GUIDE,
          disposition: "needs-human-decision",
        }),
      ]),
    );
  });

  it.each([
    ["page", { sourcePath: "docs/guide.md" }, DOCUMENT_GUIDE],
    ["section", { sourcePath: "docs/guide.md", anchor: "install" }, SECTION_INSTALL],
  ] as const)(
    "resolves one exact %s target and requires its disposition",
    (scope, target, nodeId) => {
      const input = evaluatedInput(scope, "reevaluate", target);
      input.migrationDispositions = [migration(nodeId, "keep")];
      const outcome = createIaPlanningOutcome(input);
      expect(outcome).toMatchObject({ status: "plan-ready", targetNodeId: nodeId });

      input.migrationDispositions = [];
      expect(() => createIaPlanningOutcome(input)).toThrowError(
        new IaPlanningError("migration-incomplete", "$.migrationDispositions"),
      );
    },
  );

  it("models missing input without requiring candidate artifacts or writes", () => {
    const outcome = createIaPlanningOutcome({
      index,
      scope: "page",
      mode: "reevaluate",
      target: { sourcePath: "docs/guide.md" },
      needsInput: [
        {
          id: "decision:canonical-home",
          kind: "canonical-home",
          evidence: [{ path: "docs/guide.md", nodeId: DOCUMENT_GUIDE }],
        },
      ],
    });

    expect(outcome).toEqual({
      status: "needs-input",
      scope: "page",
      mode: "reevaluate",
      targetNodeId: DOCUMENT_GUIDE,
      needs: [
        {
          id: "decision:canonical-home",
          kind: "canonical-home",
          evidence: [{ path: "docs/guide.md", nodeId: DOCUMENT_GUIDE }],
        },
      ],
      writesPerformed: false,
    });
  });

  it("fails closed for invalid scope/mode and target combinations", () => {
    expect(() =>
      createIaPlanningOutcome({
        index,
        scope: "page",
        mode: "create",
        target: { sourcePath: "docs/guide.md" },
        needsInput: [{ id: "decision:x", kind: "axis", evidence: [] }],
      }),
    ).toThrowError(new IaPlanningError("invalid-scope-mode", "$.mode"));
    expect(() =>
      createIaPlanningOutcome({
        index,
        scope: "site",
        mode: "reevaluate",
        target: { sourcePath: "docs/guide.md" },
        needsInput: [{ id: "decision:x", kind: "axis", evidence: [] }],
      }),
    ).toThrowError(new IaPlanningError("target-not-allowed", "$.target"));
  });

  it("requires an exact revision-bound ontology artifact", () => {
    const wrongKind = evaluatedInput("site", "create");
    wrongKind.plannedPages = [plannedPage()];
    wrongKind.ontology = wrongKind.candidates;
    expect(() => createIaPlanningOutcome(wrongKind)).toThrowError(
      new IaPlanningError("artifact-invalid", "$.artifacts"),
    );

    const otherIndex: ContentIndexV1 = {
      ...index,
      repository: { ...index.repository, revision: "f".repeat(40) },
      evidence: { ...index.evidence, repositoryRevision: "f".repeat(40) },
    };
    const wrongRevision = evaluatedInput("site", "create");
    wrongRevision.plannedPages = [plannedPage()];
    wrongRevision.ontology = createArtifact(
      "ontology",
      {
        entities: [],
        relationships: [],
      },
      { index: otherIndex },
    );
    expect(() => createIaPlanningOutcome(wrongRevision)).toThrowError(
      new IaPlanningError("artifact-invalid", "$.artifacts"),
    );
  });

  it("recomputes evaluation evidence while overriding embedded artifact bindings", () => {
    const valid = evaluatedInput("site", "create");
    valid.plannedPages = [plannedPage()];
    const otherIndex: ContentIndexV1 = {
      ...index,
      repository: { ...index.repository, revision: "f".repeat(40) },
      evidence: { ...index.evidence, repositoryRevision: "f".repeat(40) },
    };
    valid.evaluationInput = {
      ...valid.evaluationInput,
      index: otherIndex,
      ontology: createArtifact(
        "ontology",
        { entities: [], relationships: [] },
        {
          index: otherIndex,
        },
      ),
      candidates: valid.candidates as typeof valid.evaluationInput.candidates,
    };
    expect(createIaPlanningOutcome(valid)).toMatchObject({ status: "plan-ready" });

    const forged = evaluatedInput("site", "create");
    forged.plannedPages = [plannedPage()];
    if (forged.evaluation.kind !== "ia-evaluation") throw new Error("fixture");
    forged.evaluation = createArtifact(
      "ia-evaluation",
      {
        ...forged.evaluation.payload,
        scoringDigest: "9".repeat(64),
        scores: { ...forged.evaluation.payload.scores, total: 100 },
      },
      { index },
    );
    expect(() => createIaPlanningOutcome(forged)).toThrowError(
      new IaPlanningError("artifact-invalid", "$.artifacts"),
    );
  });
});

function evaluatedInput(
  scope: IaScope,
  mode: "create" | "reevaluate",
  target?: { sourcePath: string; anchor?: string },
): IaEvaluatedPlanningInput {
  const targetNodeId = target
    ? index.nodes.find(
        (node) =>
          node.sourcePath === target.sourcePath &&
          (target.anchor
            ? node.kind === "section" && node.anchor === target.anchor
            : node.kind === "document"),
      )?.id
    : undefined;
  const evaluated = passedIaEvaluationFixture(index, scope, targetNodeId);
  return {
    index,
    scope,
    mode,
    ...(target ? { target } : {}),
    planId: `plan:${scope}:${mode}`,
    ontology: evaluated.ontology,
    candidates: evaluated.candidates,
    evaluation: evaluated.evaluation,
    evaluationInput: evaluated.evaluationInput,
    navigationEvaluation: evaluated.navigationEvaluation,
    useCases: [
      {
        id: "use-case:install",
        actor: "Operator",
        trigger: "DocsFab is available",
        goal: "Install DocsFab",
        input: "A repository",
        outcome: "A working installation",
        evidence: [{ path: "docs/guide.md", nodeId: DOCUMENT_GUIDE }],
      },
    ],
    redirects: [],
    inboundLinkConsequences: [],
    policyBindings: [{ id: "policy:ia", version: "1", digest: POLICY_DIGEST }],
    requiredApproval: "maintainer",
    expiresAt: "2026-08-10T12:00:00.000Z",
    plannedPages: [],
    migrationDispositions: [],
  };
}

function plannedPage(): IaPlannedPage {
  return {
    topicId: "topic:get-started",
    title: "Get started",
    slug: "get-started",
    templateId: "template:tutorial",
    format: "gfm",
    outputPath: "docs/get-started.md",
    evidence: [{ path: "docs/guide.md", nodeId: DOCUMENT_GUIDE }],
  };
}

function migration(
  nodeId: string,
  disposition: IaMigrationDisposition["disposition"],
): IaMigrationDisposition {
  return {
    nodeId,
    disposition,
    destinationPaths: [],
    relatedNodeIds: [],
    evidence: [evidenceFor(nodeId)],
  };
}

function evidenceFor(nodeId: string) {
  const node = index.nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error(`Missing fixture node ${nodeId}.`);
  return { path: node.sourcePath, nodeId };
}

function document(id: string, sourcePath: string): DocumentNode {
  const digest = "e".repeat(64);
  return {
    id,
    kind: "document",
    sourcePath,
    format: "gfm",
    byteLength: 100,
    anchors: [],
    frontmatter: [],
    directives: [],
    codeBlocks: [],
    regions: {
      body: digest,
      headings: digest,
      metadata: digest,
      navigation: digest,
      graph: digest,
    },
  };
}
