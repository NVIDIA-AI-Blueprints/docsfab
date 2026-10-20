// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createArtifact } from "../src/artifacts/index.js";
import type {
  ArtifactEnvelope,
  IaCandidate,
  IaGroup,
  OntologyEntity,
} from "../src/artifacts/contracts.js";
import type { ContentIndexV1, DocumentNode } from "../src/content-ir/contracts.js";
import {
  DEFAULT_IA_DIAGNOSTIC_POLICY,
  IA_DIAGNOSTIC_RULES,
  type IaDiagnosticEvaluationInput,
  type IaDiagnosticRule,
  type IaPageClassification,
  type IaStructuralProjection,
} from "../src/ia/contracts.js";
import { evaluateIaDiagnostics } from "../src/ia/diagnostics.js";

const REVISION = "a".repeat(40);
const CONTENT_DIGEST = "b".repeat(64);
const INDEX_DIGEST = "c".repeat(64);
const GROUP_A = "group:operate";
const GROUP_B = "group:understand";
const A1 = "document:operate/run.md";
const A2 = "document:operate/debug.md";
const B1 = "document:concepts/model.md";
const B2 = "document:concepts/policy.md";
const OVERVIEW_A = "document:operate/index.md";
const OVERVIEW_B = "document:concepts/index.md";

interface Draft {
  nodes: DocumentNode[];
  entities: OntologyEntity[];
  candidate: IaCandidate;
  structure: IaStructuralProjection;
  policy: typeof DEFAULT_IA_DIAGNOSTIC_POLICY;
}

describe("deterministic IA diagnostics", () => {
  it("passes a balanced, evidenced candidate with one axis and explicit classifications", () => {
    const report = evaluateIaDiagnostics(fixture());

    expect(report).toMatchObject({
      schemaVersion: 1,
      candidateId: "candidate:reader-job",
      status: "passed",
      highestSeverity: "none",
      diagnostics: [],
      summary: {
        rulesEvaluated: IA_DIAGNOSTIC_RULES.length,
        blocking: 0,
        advisory: 0,
      },
    });
    expect(report.provenance.semanticDigests).toEqual(
      [...report.provenance.semanticDigests].sort(),
    );
  });

  it.each<{
    name: string;
    rule: IaDiagnosticRule;
    mutate: (draft: Draft) => void;
  }>([
    {
      name: "one declared axis per sibling set",
      rule: "one-axis-per-sibling-set",
      mutate: (draft) => {
        draft.candidate.secondaryAxes = ["lifecycle"];
        draft.candidate.groups[1]!.axis = "lifecycle";
      },
    },
    {
      name: "excessive fan-out",
      rule: "excessive-fan-out",
      mutate: (draft) => addTopics(draft, GROUP_A, 11),
    },
    {
      name: "single-child groups",
      rule: "single-child-group",
      mutate: (draft) => {
        draft.candidate.groups[0]!.members = [A1];
      },
    },
    {
      name: "mixed sibling kinds",
      rule: "mixed-node-kinds",
      mutate: (draft) => {
        classification(draft, A2).siblingKind = "concept";
      },
    },
    {
      name: "undeclared axis shifts",
      rule: "undeclared-axis-shift",
      mutate: (draft) => {
        draft.candidate.groups[1]!.axis = "lifecycle";
      },
    },
    {
      name: "orphan topics",
      rule: "orphan-topic",
      mutate: (draft) => {
        draft.candidate.groups[0]!.members = [A1];
      },
    },
    {
      name: "multiple canonical parents",
      rule: "multiple-parents",
      mutate: (draft) => {
        draft.candidate.groups[1]!.members.push(A1);
      },
    },
    {
      name: "empty overviews",
      rule: "empty-overview",
      mutate: (draft) => {
        draft.nodes.find((node) => node.id === OVERVIEW_A)!.byteLength = 0;
      },
    },
    {
      name: "unsupported catch-all categories",
      rule: "unsupported-catch-all",
      mutate: (draft) => {
        draft.candidate.groups[0]!.label = "Miscellaneous";
      },
    },
    {
      name: "severe cluster imbalance",
      rule: "severe-imbalance",
      mutate: (draft) => addTopics(draft, GROUP_B, 7),
    },
    {
      name: "mixed-purpose pages",
      rule: "mixed-purpose-page",
      mutate: (draft) => {
        classification(draft, A1).purpose = "mixed-purpose";
      },
    },
    {
      name: "top-level groups without member evidence",
      rule: "missing-top-level-evidence",
      mutate: (draft) => {
        draft.candidate.groups[0]!.evidence = [evidence(OVERVIEW_A)];
      },
    },
    {
      name: "groups without a stated ontology throughline",
      rule: "missing-throughline",
      mutate: (draft) => {
        draft.structure.throughlines = draft.structure.throughlines.filter(
          (item) => item.groupId !== GROUP_A,
        );
      },
    },
    {
      name: "topics without explicit page classifications",
      rule: "missing-page-classification",
      mutate: (draft) => {
        draft.structure.pageClassifications = draft.structure.pageClassifications.filter(
          (item) => item.nodeId !== A1,
        );
      },
    },
    {
      name: "groups without a declared sibling set",
      rule: "missing-sibling-set",
      mutate: (draft) => {
        draft.structure.siblingSets[0]!.groupIds = [GROUP_A];
      },
    },
  ])("detects $name with exact evidence and a closed recovery", ({ rule, mutate }) => {
    const report = evaluateIaDiagnostics(fixture(mutate));
    const result = report.diagnostics.find((item) => item.rule === rule);
    const severity = rule === "single-child-group" ? "advisory" : "blocking";

    expect(report.status).toBe("failed");
    expect(report.highestSeverity).toBe("blocking");
    expect(result).toBeDefined();
    expect(result).toMatchObject({
      rule,
      severity,
      nodeId: expect.any(String),
      evidence: expect.any(Array),
      recovery: {
        action: expect.any(String),
        targetNodeIds: expect.any(Array),
      },
    });
    expect(result!.evidence.length).toBeGreaterThan(0);
    expect(result!.recovery.targetNodeIds.length).toBeGreaterThan(0);
  });

  it.each(["Other", "General", "Misc", "Miscellaneous"])(
    "requires an explicit exception for the %s category",
    (label) => {
      const withoutException = evaluateIaDiagnostics(
        fixture((draft) => {
          draft.candidate.groups[0]!.label = label;
        }),
      );
      const withException = evaluateIaDiagnostics(
        fixture((draft) => {
          draft.candidate.groups[0]!.label = label;
          draft.structure.exceptions.push({
            rule: "unsupported-catch-all",
            nodeId: GROUP_A,
            reason: "legacy-url-contract",
            evidence: [evidence(A1)],
          });
        }),
      );

      expect(rules(withoutException)).toContain("unsupported-catch-all");
      expect(rules(withException)).not.toContain("unsupported-catch-all");
      expect(withException.status).toBe("passed");
    },
  );

  it("distinguishes an intentional reference catalog from a mixed-purpose page", () => {
    const reference = evaluateIaDiagnostics(
      fixture((draft) => {
        classification(draft, A1).purpose = "reference-catalog";
        classification(draft, A1).siblingKind = "reference";
        classification(draft, A2).purpose = "reference-catalog";
        classification(draft, A2).siblingKind = "reference";
      }),
    );
    const mixed = evaluateIaDiagnostics(
      fixture((draft) => {
        classification(draft, A1).purpose = "mixed-purpose";
      }),
    );

    expect(reference.status).toBe("passed");
    expect(rules(reference)).not.toContain("mixed-purpose-page");
    expect(rules(mixed)).toContain("mixed-purpose-page");
  });

  it("reports the exact topic, parent groups, evidence, and recovery for duplicate placement", () => {
    const report = evaluateIaDiagnostics(
      fixture((draft) => {
        draft.candidate.groups[1]!.members.push(A1);
      }),
    );
    const result = report.diagnostics.find((item) => item.rule === "multiple-parents")!;

    expect(result).toEqual({
      rule: "multiple-parents",
      severity: "blocking",
      nodeId: A1,
      relatedNodeIds: [GROUP_B, GROUP_A].sort(),
      evidence: [evidence(A1)],
      recovery: {
        action: "choose-canonical-parent",
        targetNodeIds: [A1, GROUP_A, GROUP_B].sort(),
      },
    });
  });

  it("is deterministic under repeated evaluation and normalizes result ordering", () => {
    const input = fixture((draft) => {
      draft.candidate.groups[0]!.label = "Other";
      draft.structure.pageClassifications = draft.structure.pageClassifications.reverse();
      draft.structure.topicNodeIds = draft.structure.topicNodeIds.reverse();
    });

    expect(evaluateIaDiagnostics(input)).toEqual(evaluateIaDiagnostics(input));
    const report = evaluateIaDiagnostics(input);
    expect(report.diagnostics.map((item) => item.rule)).toEqual(
      [...report.diagnostics]
        .sort(
          (left, right) =>
            IA_DIAGNOSTIC_RULES.indexOf(left.rule) - IA_DIAGNOSTIC_RULES.indexOf(right.rule),
        )
        .map((item) => item.rule),
    );
  });

  it("rejects projection claims that are not bound to an indexed node", () => {
    const input = fixture();
    input.structure.pageClassifications[0]!.evidence = [
      {
        path: "outside.md",
        nodeId: A1,
      },
    ];

    expect(() => evaluateIaDiagnostics(input)).toThrowError(
      expect.objectContaining({ code: "invalid-projection" }),
    );
  });

  it("rejects stale or invalid artifacts instead of evaluating them", () => {
    const input = fixture();
    input.ontology.digest = "0".repeat(64);

    expect(() => evaluateIaDiagnostics(input)).toThrowError(
      expect.objectContaining({ code: "invalid-artifact" }),
    );
  });
});

function fixture(mutate?: (draft: Draft) => void): IaDiagnosticEvaluationInput {
  const draft = baseDraft();
  mutate?.(draft);
  const index = contentIndex(draft.nodes);
  const ontology = createArtifact(
    "ontology",
    {
      entities: draft.entities,
      relationships: [],
    },
    { index },
  );
  const candidates = createArtifact(
    "ia-candidates",
    {
      scope: "site",
      candidates: [draft.candidate],
      recommendedCandidateId: draft.candidate.id,
      rejectedCandidates: [],
      openDecisions: [],
    },
    { index },
  );
  const semantics = draft.structure.topicNodeIds.map((nodeId) => {
    const group = draft.candidate.groups.find((item) => item.members.includes(nodeId));
    const readerJob = group?.id === GROUP_B ? "entity:understand" : "entity:operate";
    return createArtifact(
      "context-packet",
      {
        targetNodeId: nodeId,
        pageRole: {
          contentType: "how-to",
          readerJob,
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
  });
  return {
    index,
    ontology,
    candidates,
    semantics,
    candidateId: draft.candidate.id,
    structure: draft.structure,
    policy: draft.policy,
  };
}

function baseDraft(): Draft {
  const nodes = [OVERVIEW_A, OVERVIEW_B, A1, A2, B1, B2].map((id) => document(id));
  const groups: IaGroup[] = [
    {
      id: GROUP_A,
      label: "Operate",
      axis: "reader-job",
      members: [A1, A2],
      canonicalPath: "operate",
      evidence: [evidence(A1)],
    },
    {
      id: GROUP_B,
      label: "Understand",
      axis: "reader-job",
      members: [B1, B2],
      canonicalPath: "concepts",
      evidence: [evidence(B1)],
    },
  ];
  const entities: OntologyEntity[] = [
    {
      id: "entity:operate",
      label: "Operate DocsFab",
      kind: "user-job",
      evidence: [evidence(A1)],
    },
    {
      id: "entity:understand",
      label: "Understand DocsFab",
      kind: "concept",
      evidence: [evidence(B1)],
    },
  ];
  return {
    nodes,
    entities,
    candidate: {
      id: "candidate:reader-job",
      primaryAxis: "reader-job",
      secondaryAxes: [],
      score: 90,
      groups,
      evidence: [evidence(A1)],
    },
    structure: {
      topicNodeIds: [A1, A2, B1, B2],
      siblingSets: [
        {
          id: "siblings:top-level",
          parentId: "candidate:reader-job",
          groupIds: [GROUP_A, GROUP_B],
          declaredAxis: "reader-job",
          evidence: [evidence(A1)],
        },
      ],
      overviews: [
        { groupId: GROUP_A, nodeId: OVERVIEW_A, evidence: [evidence(OVERVIEW_A)] },
        { groupId: GROUP_B, nodeId: OVERVIEW_B, evidence: [evidence(OVERVIEW_B)] },
      ],
      throughlines: [
        { groupId: GROUP_A, entityId: "entity:operate", evidence: [evidence(A1)] },
        { groupId: GROUP_B, entityId: "entity:understand", evidence: [evidence(B1)] },
      ],
      pageClassifications: [A1, A2, B1, B2].map((nodeId) => ({
        nodeId,
        purpose: "single-purpose",
        siblingKind: "task",
        evidence: [evidence(nodeId)],
      })),
      exceptions: [],
    },
    policy: {
      ...DEFAULT_IA_DIAGNOSTIC_POLICY,
      unsupportedLabels: [...DEFAULT_IA_DIAGNOSTIC_POLICY.unsupportedLabels],
    },
  };
}

function addTopics(draft: Draft, groupId: string, count: number): void {
  const group = draft.candidate.groups.find((item) => item.id === groupId)!;
  for (let index = 0; index < count; index += 1) {
    const nodeId = `document:generated/topic-${groupId === GROUP_A ? "a" : "b"}-${index}.md`;
    draft.nodes.push(document(nodeId));
    draft.structure.topicNodeIds.push(nodeId);
    draft.structure.pageClassifications.push({
      nodeId,
      purpose: "single-purpose",
      siblingKind: "task",
      evidence: [evidence(nodeId)],
    });
    group.members.push(nodeId);
  }
}

function classification(draft: Draft, nodeId: string): IaPageClassification {
  return draft.structure.pageClassifications.find((item) => item.nodeId === nodeId)!;
}

function document(id: string): DocumentNode {
  const sourcePath = sourcePathFor(id);
  return {
    id,
    kind: "document",
    sourcePath,
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

function contentIndex(nodes: DocumentNode[]): ContentIndexV1 {
  return {
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
}

function evidence(nodeId: string): { path: string; nodeId: string } {
  return { path: sourcePathFor(nodeId), nodeId };
}

function sourcePathFor(nodeId: string): string {
  return nodeId.replace(/^document:/u, "");
}

function rules(report: ReturnType<typeof evaluateIaDiagnostics>): IaDiagnosticRule[] {
  return report.diagnostics.map((item) => item.rule);
}
