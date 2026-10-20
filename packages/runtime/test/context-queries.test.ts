// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { canonicalArtifactDigest, createArtifact } from "../src/artifacts/index.js";
import type { ArtifactReference } from "../src/artifacts/contracts.js";
import type { ContentIndexV1 } from "../src/content-ir/index.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import {
  canonicalContextPacketDigest,
  canonicalContextPacketJson,
  compileContext,
  ContextResultValidationError,
  validateCompilerResult,
  validateContextResult,
} from "../src/context/compiler.js";
import { contextPacketBudget } from "../src/context/budget.js";
import type {
  ContextCompileInput,
  ContextPolicy,
  ContextResult,
} from "../src/context/contracts.js";
import {
  canonicalContextQueryDigest,
  canonicalContextQueryJson,
  ContextQueryError,
  validateContextQuery,
} from "../src/context/queries.js";

const REVISION = "a".repeat(40);
const CONTENT_DIGEST = "b".repeat(64);
const TARGET = "document:guides/setup.md";
const HOME = "document:guides/index.md";
const SECTION = "section:guides/setup.md#get-started";
// The catalog budgets at the fallback input window (65,536 tokens).
const LOCAL_BUDGET = contextPacketBudget("local");
const CORPUS_BUDGET = contextPacketBudget("corpus");

function bindIndex(value: ContentIndexV1): ContentIndexV1 {
  const indexDigest = canonicalDigest({
    schemaVersion: value.schemaVersion,
    repository: value.repository,
    nodes: value.nodes,
    edges: value.edges,
  });
  return { ...value, indexDigest, evidence: { ...value.evidence, indexDigest } };
}

const index = bindIndex({
  schemaVersion: 1,
  repository: { revision: REVISION, contentDigest: CONTENT_DIGEST },
  indexDigest: "c".repeat(64),
  nodes: [
    {
      id: TARGET,
      kind: "document",
      sourcePath: "guides/setup.md",
      format: "gfm",
      byteLength: 128,
      anchors: ["get-started"],
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
    },
    {
      id: SECTION,
      kind: "section",
      documentId: TARGET,
      sourcePath: "guides/setup.md",
      anchor: "get-started",
      depth: 2,
      startLine: 3,
      endLine: 8,
    },
    {
      id: HOME,
      kind: "document",
      sourcePath: "guides/index.md",
      format: "gfm",
      byteLength: 64,
      anchors: [],
      frontmatter: [],
      directives: [],
      codeBlocks: [],
      regions: {
        body: "6".repeat(64),
        headings: "7".repeat(64),
        metadata: "8".repeat(64),
        navigation: "9".repeat(64),
        graph: "0".repeat(64),
      },
    },
  ],
  edges: [
    { kind: "child", from: TARGET, to: SECTION },
    { kind: "navigation", from: HOME, to: TARGET },
    { kind: "parent", from: SECTION, to: TARGET },
  ],
  evidence: {
    repositoryRevision: REVISION,
    contentDigest: CONTENT_DIGEST,
    indexDigest: "c".repeat(64),
    documentCount: 2,
    sectionCount: 1,
    edgeCount: 3,
  },
});

const ontology = createArtifact(
  "ontology",
  {
    entities: [
      {
        id: "job:configure",
        label: "Configure DocsFab",
        kind: "user-job",
        evidence: [{ path: "guides/setup.md", nodeId: TARGET }],
      },
      {
        id: "concept:guides-home",
        label: "Guides home",
        kind: "concept",
        evidence: [{ path: "guides/index.md", nodeId: HOME }],
      },
    ],
    relationships: [
      {
        subject: "job:configure",
        predicate: "documented-by",
        object: "concept:guides-home",
        evidence: [{ path: "guides/setup.md", nodeId: TARGET }],
      },
    ],
  },
  { index },
);

const targetSemantics = createArtifact(
  "context-packet",
  {
    targetNodeId: TARGET,
    pageRole: {
      contentType: "how-to",
      readerJob: "job:configure",
      canonicalParentId: HOME,
      organizingAxis: "reader-job",
    },
    ancestors: [HOME],
    siblings: [],
    relatedCanonicalPages: [HOME],
    placementRules: {
      belongsHere: [HOME],
      belongsElsewhere: [SECTION],
    },
    activeDecisionIds: ["decision:keep-setup-under-guides"],
    structuralPressure: "healthy",
    evidence: [{ path: "guides/setup.md", nodeId: TARGET }],
  },
  { index },
);

const policy: ContextPolicy = {
  id: "context:read-only-analysis",
  version: "1",
  digest: "d".repeat(64),
  allowDegradedRead: true,
};

function input(overrides: Partial<ContextCompileInput> = {}): ContextCompileInput {
  return {
    index,
    ontology,
    semantics: [targetSemantics],
    query: { kind: "get-neighborhood", targetNodeId: TARGET },
    policy,
    budget: { ...LOCAL_BUDGET },
    ...overrides,
  };
}

function resignPacket(result: ContextResult): void {
  const packet = result.packet!;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    packet.digest = canonicalContextPacketDigest(packet);
    const byteLength = Buffer.byteLength(canonicalContextPacketJson(packet));
    const estimatedTokens = Math.ceil(byteLength / 4);
    if (
      packet.estimates.byteLength === byteLength &&
      packet.estimates.estimatedTokens === estimatedTokens
    )
      break;
    packet.estimates = { byteLength, estimatedTokens };
  }
  packet.digest = canonicalContextPacketDigest(packet);
}

describe("context query language", () => {
  it("keeps opaque external-link targets outside compiled context packets", () => {
    const externalTarget = `external:${"e".repeat(64)}`;
    const externalIndex = bindIndex({
      ...index,
      edges: [...index.edges, { kind: "outbound-link", from: TARGET, to: externalTarget }],
      evidence: {
        ...index.evidence,
        edgeCount: index.evidence.edgeCount + 1,
      },
    });
    const compiled = compileContext(input({ index: externalIndex }));

    expect(compiled.status).toBe("ready");
    expect(compiled.packet?.nodes.map((node) => node.id)).not.toContain(externalTarget);
    expect(compiled.packet?.edges).not.toContainEqual({
      kind: "outbound-link",
      from: TARGET,
      to: externalTarget,
    });
    expect(() => validateCompilerResult(compiled, input({ index: externalIndex }))).not.toThrow();
  });

  it("validates every closed query kind and canonicalizes set-like seeds", () => {
    expect(validateContextQuery({ kind: "locate", sourcePath: "guides/setup.md" })).toEqual({
      kind: "locate",
      sourcePath: "guides/setup.md",
    });
    expect(
      validateContextQuery({ kind: "get-neighborhood", targetNodeId: TARGET, depth: 2 }),
    ).toEqual({ kind: "get-neighborhood", targetNodeId: TARGET, depth: 2 });
    expect(validateContextQuery({ kind: "find-home", targetNodeId: TARGET })).toEqual({
      kind: "find-home",
      targetNodeId: TARGET,
    });
    expect(
      validateContextQuery({
        kind: "test-placement",
        targetNodeId: TARGET,
        candidateParentId: HOME,
      }),
    ).toMatchObject({ kind: "test-placement", candidateParentId: HOME });
    const expanded = validateContextQuery({
      kind: "expand",
      targetNodeIds: [TARGET, HOME],
      depth: 1,
    });
    expect(expanded).toEqual({
      kind: "expand",
      targetNodeIds: [HOME, TARGET],
      depth: 1,
    });
    expect(canonicalContextQueryJson(expanded)).toBe(
      canonicalContextQueryJson({
        kind: "expand",
        targetNodeIds: [TARGET, HOME],
        depth: 1,
      }),
    );
    expect(canonicalContextQueryDigest(expanded)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    [{ kind: "locate", sourcePath: "../secret.md" }, "unsafe-path"],
    [{ kind: "find-home", targetNodeId: TARGET, extra: true }, "unknown-field"],
    [{ kind: "expand", targetNodeIds: [TARGET, TARGET] }, "duplicate-node-id"],
    [{ kind: "arbitrary", targetNodeId: TARGET }, "invalid-query"],
  ] as const)("rejects invalid or extensible query input", (query, code) => {
    expect(() => validateContextQuery(query)).toThrowError(
      expect.objectContaining<Partial<ContextQueryError>>({ code }),
    );
  });
});

describe("pure context compiler", () => {
  it("compiles deterministic, content-free neighborhood evidence", () => {
    const first = compileContext(input());
    const permuted = compileContext(
      input({
        index,
        semantics: [targetSemantics],
      }),
    );
    expect(first.status).toBe("ready");
    expect(first.packet?.digest).toBe(permuted.packet?.digest);
    expect(first.packet?.digest).toBe(canonicalContextPacketDigest(first.packet!));
    expect(JSON.parse(canonicalContextPacketJson(first.packet!))).toEqual(first.packet);
    expect(first.provenance.consultedNodeIds).toEqual([HOME, SECTION, TARGET].sort());
    expect(first.provenance.activeDecisionIds).toEqual(["decision:keep-setup-under-guides"]);
    expect(first.provenance.ontology).toMatchObject({
      kind: "ontology",
      schemaVersion: 1,
      digest: ontology.digest,
    });
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("Configure DocsFab");
    expect(serialized).not.toContain("Guides home");
  });

  it("locates nodes and reports absent locations as unnecessary", () => {
    const located = compileContext(
      input({
        query: { kind: "locate", sourcePath: "guides/setup.md", anchor: "get-started" },
      }),
    );
    expect(located.status).toBe("ready");
    expect(located.packet?.nodes.map((node) => node.id)).toEqual([SECTION]);
    expect(located.reasons).toEqual([]);

    const absent = compileContext(
      input({
        query: { kind: "locate", sourcePath: "guides/absent.md" },
      }),
    );
    expect(absent.status).toBe("unnecessary");
    expect(absent.packet).toBeUndefined();
  });

  it("keeps canonical homes and placement categories distinct", () => {
    const home = compileContext(input({ query: { kind: "find-home", targetNodeId: TARGET } }));
    expect(home.status).toBe("ready");
    expect(home.packet?.semantics[0]).toMatchObject({
      belongsHere: [HOME],
      belongsElsewhere: [SECTION],
      canonicalHomeNodeIds: [HOME],
    });

    const canonical = compileContext(
      input({
        query: {
          kind: "test-placement",
          targetNodeId: TARGET,
          candidateParentId: HOME,
        },
      }),
    );
    expect(canonical.status).toBe("ready");
    expect(canonical.packet?.placementAssessment?.disposition).toBe("canonical-home");

    const elsewhere = compileContext(
      input({
        query: {
          kind: "test-placement",
          targetNodeId: TARGET,
          candidateParentId: SECTION,
        },
      }),
    );
    expect(elsewhere.status).toBe("ready");
    expect(elsewhere.packet?.placementAssessment?.disposition).toBe("belongs-elsewhere");
  });

  it("never guesses a missing page role or unproven placement", () => {
    const missingRole = compileContext(
      input({
        query: { kind: "find-home", targetNodeId: HOME },
      }),
    );
    expect(missingRole.status).toBe("failed");
    expect(missingRole.reasons).toEqual([{ code: "page-role-unresolved", detail: HOME }]);

    const uncertain = compileContext(
      input({
        query: {
          kind: "test-placement",
          targetNodeId: TARGET,
          candidateParentId: TARGET,
        },
      }),
    );
    expect(uncertain.status).toBe("degraded");
    expect(uncertain.packet?.placementAssessment?.disposition).toBe("undetermined");
    expect(uncertain.reasons).toContainEqual({
      code: "placement-undetermined",
      detail: TARGET,
    });

    const strict = compileContext(
      input({
        policy: { ...policy, allowDegradedRead: false },
        query: {
          kind: "test-placement",
          targetNodeId: TARGET,
          candidateParentId: TARGET,
        },
      }),
    );
    expect(strict.status).toBe("failed");
    expect(strict.packet).toBeUndefined();
  });

  it("enforces the declared hard budget caps deterministically", () => {
    const budget = { ...LOCAL_BUDGET, maxNodes: 1, maxDepth: 1 };
    const compiled = compileContext(
      input({
        budget,
        query: { kind: "get-neighborhood", targetNodeId: TARGET, depth: 2 },
      }),
    );
    expect(compiled.status).toBe("degraded");
    expect(compiled.packet?.nodes).toHaveLength(1);
    expect(compiled.packet?.estimates.byteLength).toBeLessThanOrEqual(budget.maxBytes);
    expect(compiled.packet?.estimates.estimatedTokens).toBeLessThanOrEqual(
      budget.maxEstimatedTokens,
    );
    expect(compiled.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(["depth-budget-exceeded", "node-budget-exceeded"]),
    );

    // A budget above the catalog default is a host's raise, not an invalid
    // input: the compiler has no ceiling of its own.
    const raised = compileContext(
      input({
        budget: {
          ...LOCAL_BUDGET,
          maxNodes: LOCAL_BUDGET.maxNodes * 2,
          maxEstimatedTokens: LOCAL_BUDGET.maxEstimatedTokens * 2,
          maxBytes: LOCAL_BUDGET.maxBytes * 2,
        },
      }),
    );
    expect(raised.status).toBe("ready");
    const malformed = compileContext(
      input({
        budget: { ...LOCAL_BUDGET, maxNodes: 0 },
      }),
    );
    expect(malformed.status).toBe("failed");
    expect(malformed.reasons).toEqual([{ code: "invalid-input" }]);
  });

  it("rejects artifacts and plan references from another revision", () => {
    const activePlan: ArtifactReference<"ia-plan"> = {
      kind: "ia-plan",
      schemaVersion: 1,
      digest: "e".repeat(64),
      repositoryRevision: "f".repeat(40),
      repositoryContentDigest: CONTENT_DIGEST,
    };
    const compiled = compileContext(input({ activePlan }));
    expect(compiled.status).toBe("failed");
    expect(compiled.reasons).toEqual([{ code: "repository-mismatch" }]);
  });

  it("rejects digest-valid artifacts that fail the full artifact contract", () => {
    const malformed = structuredClone(ontology) as typeof ontology & {
      payload: typeof ontology.payload & { rawRepositoryText?: string };
    };
    malformed.payload.rawRepositoryText = "not governed semantic evidence";
    malformed.digest = canonicalArtifactDigest(malformed);
    const compiled = compileContext(input({ ontology: malformed }));
    expect(compiled.status).toBe("failed");
    expect(compiled.reasons).toEqual([{ code: "invalid-input" }]);
    expect(compiled.packet).toBeUndefined();
  });

  it("fails closed when an irreducible packet exceeds a stricter hard cap", () => {
    const compiled = compileContext(
      input({
        budget: {
          ...LOCAL_BUDGET,
          maxNodes: 1,
          maxEdges: 1,
          maxPaths: 1,
          maxDepth: 0,
          maxBytes: 1,
          maxEstimatedTokens: 1,
        },
      }),
    );
    expect(compiled.status).toBe("failed");
    expect(compiled.packet).toBeUndefined();
    expect(compiled.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(["byte-budget-exceeded", "token-budget-exceeded"]),
    );
  });

  it("returns a bounded degraded subset for a 513-seed corpus expansion", () => {
    const nodes: ContentIndexV1["nodes"] = Array.from({ length: 513 }, (_unused, index) => {
      const suffix = String(index).padStart(4, "0");
      return {
        id: `document:${"a".repeat(64)}-${suffix}`,
        kind: "document" as const,
        sourcePath: `guides/${"b".repeat(48)}-${suffix}.md`,
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
      };
    });
    const largeIndex = bindIndex({
      schemaVersion: 1,
      repository: { revision: REVISION, contentDigest: CONTENT_DIGEST },
      indexDigest: "e".repeat(64),
      nodes,
      edges: [],
      evidence: {
        repositoryRevision: REVISION,
        contentDigest: CONTENT_DIGEST,
        indexDigest: "e".repeat(64),
        documentCount: nodes.length,
        sectionCount: 0,
        edgeCount: 0,
      },
    });
    const largeOntology = createArtifact(
      "ontology",
      {
        entities: [],
        relationships: [],
      },
      { index: largeIndex },
    );
    const largeInput = input({
      index: largeIndex,
      ontology: largeOntology,
      semantics: [],
      query: { kind: "expand", targetNodeIds: nodes.map((node) => node.id), depth: 0 },
      // A host-narrowed node count, so one seed past it is clipped by count
      // before the token budget trims the rest.
      budget: { ...CORPUS_BUDGET, maxNodes: 512 },
    });
    const compiled = compileContext(largeInput);

    expect(compiled.status).toBe("degraded");
    expect(compiled.packet).toBeDefined();
    expect(compiled.reasons.map((reason) => reason.code)).toContain("node-budget-exceeded");
    expect(compiled.packet!.nodes.length).toBeGreaterThan(0);
    expect(compiled.packet!.nodes.length).toBeLessThanOrEqual(512);
    expect(compiled.packet!.estimates.byteLength).toBeLessThanOrEqual(CORPUS_BUDGET.maxBytes);
    expect(compiled.packet!.estimates.estimatedTokens).toBeLessThanOrEqual(
      CORPUS_BUDGET.maxEstimatedTokens,
    );
    expect(compiled.packet!.query.kind).toBe("expand");
    if (compiled.packet!.query.kind === "expand") {
      expect(compiled.packet!.query.targetNodeIds.length).toBeLessThan(513);
      expect(compiled.packet!.query.targetNodeIds).toEqual(
        compiled.packet!.nodes.map((node) => node.id),
      );
    }
    expect(compiled.provenance.consultedNodeIds).toEqual(
      compiled.packet!.nodes.map((node) => node.id),
    );
    expect(compiled.packet!.semantics).toEqual([]);
    expect(compiled.packet!.provenance.semanticPackets).toEqual([]);
    expect(validateContextResult(compiled, largeInput)).toEqual(compiled);
  });

  it("degrades, not fails, an untargeted corpus expansion whose seeds alone are over budget despite having far fewer than maxNodes of them", () => {
    // The regression this guards (critic round 1 on !1384, B1): the first
    // cut of this fix discriminated the corpus-wide `expand` fallback from
    // a real multi-page scope by comparing `seeds.length` to `maxNodes`
    // (512) alone. But it is a BYTE/TOKEN bound, not a node count, that
    // actually binds `trimExpandPacketToBudget` below -- the corpus
    // `maxEstimatedTokens` (8,192) caps a packet around 32 KiB of
    // canonical JSON, which a few dozen real document summaries can
    // already exceed. Any untargeted run whose corpus has 512 or fewer
    // documents, but whose summaries alone are already over that
    // byte/token bound, used to fail the compile outright instead of
    // degrading -- exactly the symptom this whole MR exists to remove,
    // now on the untargeted path instead of the multi-page-scope path.
    // 400 nodes is far below 512, the node-count discriminator this MR's
    // first cut wrongly relied on.
    const nodes: ContentIndexV1["nodes"] = Array.from({ length: 400 }, (_unused, index) => {
      const suffix = String(index).padStart(4, "0");
      return {
        id: `document:${"a".repeat(64)}-${suffix}`,
        kind: "document" as const,
        sourcePath: `guides/${"b".repeat(48)}-${suffix}.md`,
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
      };
    });
    const smallCountIndex = bindIndex({
      schemaVersion: 1,
      repository: { revision: REVISION, contentDigest: CONTENT_DIGEST },
      indexDigest: "7".repeat(64),
      nodes,
      edges: [],
      evidence: {
        repositoryRevision: REVISION,
        contentDigest: CONTENT_DIGEST,
        indexDigest: "7".repeat(64),
        documentCount: nodes.length,
        sectionCount: 0,
        edgeCount: 0,
      },
    });
    const smallCountInput = input({
      index: smallCountIndex,
      ontology: createArtifact(
        "ontology",
        { entities: [], relationships: [] },
        { index: smallCountIndex },
      ),
      semantics: [],
      // The untargeted whole-corpus `expand` fallback: every document in
      // the corpus becomes a `seed` (see `preflight.ts`'s `expandSeedIds`,
      // `scopePaths.length === 0` branch), not just this test's own choice.
      query: { kind: "expand", targetNodeIds: nodes.map((node) => node.id), depth: 0 },
      budget: { ...CORPUS_BUDGET },
    });
    const compiled = compileContext(smallCountInput);

    expect(nodes.length).toBeLessThan(CORPUS_BUDGET.maxNodes);
    expect(compiled.status, JSON.stringify(compiled.reasons)).toBe("degraded");
    expect(compiled.reasons.map((reason) => reason.code)).not.toContain("node-budget-exceeded");
    expect(
      compiled.reasons.some(
        (reason) =>
          reason.code === "byte-budget-exceeded" || reason.code === "token-budget-exceeded",
      ),
    ).toBe(true);
    expect(compiled.packet).toBeDefined();
    expect(compiled.packet!.nodes.length).toBeGreaterThan(0);
    expect(compiled.packet!.nodes.length).toBeLessThan(nodes.length);
    expect(compiled.packet!.estimates.byteLength).toBeLessThanOrEqual(CORPUS_BUDGET.maxBytes);
    expect(compiled.packet!.estimates.estimatedTokens).toBeLessThanOrEqual(
      CORPUS_BUDGET.maxEstimatedTokens,
    );
    expect(validateContextResult(compiled, smallCountInput)).toEqual(compiled);
  });

  it("does not reintroduce omitted expand seeds when path trimming is sufficient", () => {
    const nodes: ContentIndexV1["nodes"] = Array.from({ length: 33 }, (_unused, index) => {
      const suffix = String(index).padStart(2, "0");
      return {
        id: `document:d${suffix}`,
        kind: "document" as const,
        sourcePath: `d/${suffix}.md`,
        format: "gfm" as const,
        byteLength: 8,
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
    });
    const compactIndex = bindIndex({
      schemaVersion: 1,
      repository: { revision: REVISION, contentDigest: CONTENT_DIGEST },
      indexDigest: "f".repeat(64),
      nodes,
      edges: [],
      evidence: {
        repositoryRevision: REVISION,
        contentDigest: CONTENT_DIGEST,
        indexDigest: "f".repeat(64),
        documentCount: nodes.length,
        sectionCount: 0,
        edgeCount: 0,
      },
    });
    const compactOntology = createArtifact(
      "ontology",
      {
        entities: [],
        relationships: [],
      },
      { index: compactIndex },
    );
    const compactInput = input({
      index: compactIndex,
      ontology: compactOntology,
      semantics: [],
      query: { kind: "expand", targetNodeIds: nodes.map((node) => node.id), depth: 0 },
      budget: {
        ...LOCAL_BUDGET,
        maxNodes: 32,
        maxEstimatedTokens: 1_600,
      },
    });
    const compiled = compileContext(compactInput);

    expect(compiled.status).toBe("degraded");
    expect(compiled.packet?.nodes).toHaveLength(32);
    // Only the paths that do not fit go, lowest-ranked first: every node keeps
    // its place, and the kept paths are those of the first-ranked seeds.
    const keptPaths = compiled.packet?.paths ?? [];
    expect(keptPaths.length).toBeGreaterThan(0);
    expect(keptPaths.length).toBeLessThan(32);
    expect(keptPaths.map((path) => path.nodeIds[0])).toEqual(
      nodes.slice(0, keptPaths.length).map((node) => node.id),
    );
    expect(compiled.reasons.map((reason) => reason.code)).toContain("token-budget-exceeded");
    expect(compiled.packet?.query.kind).toBe("expand");
    if (compiled.packet?.query.kind === "expand") {
      expect(compiled.packet.query.targetNodeIds).toEqual(
        compiled.packet.nodes.map((node) => node.id),
      );
      expect(compiled.packet.query.targetNodeIds).not.toContain(nodes[32]!.id);
    }
    expect(validateContextResult(compiled, compactInput)).toEqual(compiled);
  });

  it("preserves the requested expand seed when a depth neighbor sorts before it", () => {
    const seed = "document:z-seed";
    const neighbor = "document:a-neighbor";
    const nodes: ContentIndexV1["nodes"] = [
      {
        id: seed,
        kind: "document",
        sourcePath: "z.md",
        format: "gfm",
        byteLength: 1,
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
      },
      {
        id: neighbor,
        kind: "document",
        sourcePath: "a.md",
        format: "gfm",
        byteLength: 1,
        anchors: [],
        frontmatter: [],
        directives: [],
        codeBlocks: [],
        regions: {
          body: "6".repeat(64),
          headings: "7".repeat(64),
          metadata: "8".repeat(64),
          navigation: "9".repeat(64),
          graph: "0".repeat(64),
        },
      },
    ];
    const adversarialIndex = bindIndex({
      schemaVersion: 1,
      repository: { revision: REVISION, contentDigest: CONTENT_DIGEST },
      indexDigest: "9".repeat(64),
      nodes,
      edges: [{ kind: "navigation", from: seed, to: neighbor }],
      evidence: {
        repositoryRevision: REVISION,
        contentDigest: CONTENT_DIGEST,
        indexDigest: "9".repeat(64),
        documentCount: 2,
        sectionCount: 0,
        edgeCount: 1,
      },
    });
    const adversarialInput = input({
      index: adversarialIndex,
      ontology: createArtifact(
        "ontology",
        { entities: [], relationships: [] },
        {
          index: adversarialIndex,
        },
      ),
      semantics: [],
      query: { kind: "expand", targetNodeIds: [seed], depth: 1 },
      budget: {
        ...LOCAL_BUDGET,
        maxEstimatedTokens: 350,
      },
    });
    const compiled = compileContext(adversarialInput);

    expect(compiled.status).toBe("degraded");
    expect(compiled.packet?.query).toEqual({
      kind: "expand",
      targetNodeIds: [seed],
      depth: 1,
    });
    expect(compiled.packet?.nodes.map((node) => node.id)).toEqual([seed]);
    expect(validateCompilerResult(compiled, adversarialInput)).toEqual(compiled);
    expect(validateContextResult(compiled, adversarialInput)).toEqual(compiled);
  });

  it("preserves every requested expand seed of a multi-page scope, trimming only their unrequested neighbours", () => {
    // The defect this guards (found live on J3, 2026-09-30, 15/57 MRs
    // succeeding in 24h): a multi-page focused review names several
    // explicit seeds at once (its scope), not one. Before this fix,
    // `protectedNodeIds` protected only the FIRST of several `expand`
    // seeds, so a corpus byte/token trim could -- and, with real
    // multi-directory review scopes, routinely did -- drop a later,
    // explicitly requested seed while keeping an unrequested neighbour of
    // an earlier one. Three independent seed+neighbour pairs, sized so
    // all three seeds fit but no neighbour does, exercise every seed
    // equally rather than just a first-vs-rest asymmetry.
    const pairs = ["s1", "s2", "s3"].map((label, index) => {
      const seedId = `document:${label}-seed`;
      const neighborId = `document:${label}-neighbor`;
      const fill = String((index % 10) + 1).repeat(64);
      return {
        seedId,
        neighborId,
        seedNode: {
          id: seedId,
          kind: "document" as const,
          sourcePath: `${label}/seed.md`,
          format: "gfm" as const,
          byteLength: 1,
          anchors: [],
          frontmatter: [],
          directives: [],
          codeBlocks: [],
          regions: { body: fill, headings: fill, metadata: fill, navigation: fill, graph: fill },
        },
        neighborNode: {
          id: neighborId,
          kind: "document" as const,
          sourcePath: `${label}/neighbor.md`,
          format: "gfm" as const,
          byteLength: 1,
          anchors: [],
          frontmatter: [],
          directives: [],
          codeBlocks: [],
          regions: { body: fill, headings: fill, metadata: fill, navigation: fill, graph: fill },
        },
      };
    });
    const nodes: ContentIndexV1["nodes"] = pairs.flatMap((pair) => [
      pair.seedNode,
      pair.neighborNode,
    ]);
    const multiSeedIndex = bindIndex({
      schemaVersion: 1,
      repository: { revision: REVISION, contentDigest: CONTENT_DIGEST },
      indexDigest: "8".repeat(64),
      nodes,
      edges: pairs.map((pair) => ({
        kind: "navigation" as const,
        from: pair.seedId,
        to: pair.neighborId,
      })),
      evidence: {
        repositoryRevision: REVISION,
        contentDigest: CONTENT_DIGEST,
        indexDigest: "8".repeat(64),
        documentCount: nodes.length,
        sectionCount: 0,
        edgeCount: pairs.length,
      },
    });
    const seedIds = pairs.map((pair) => pair.seedId);
    const neighborIds = pairs.map((pair) => pair.neighborId);
    const multiSeedInput = input({
      index: multiSeedIndex,
      ontology: createArtifact(
        "ontology",
        { entities: [], relationships: [] },
        { index: multiSeedIndex },
      ),
      semantics: [],
      query: { kind: "expand", targetNodeIds: seedIds, depth: 1 },
      budget: {
        ...LOCAL_BUDGET,
        // All three seeds plus all three neighbours (6 nodes) does not
        // fit; all three seeds plus 2 of the 3 neighbours (5 nodes, 473 of
        // these 500 tokens, confirmed by direct instrumentation) does. The
        // exact node dropped is whichever neighbour sorts last among the
        // "optional" nodes -- not pinned here, only that it is always a
        // neighbour, never a seed.
        maxEstimatedTokens: 500,
      },
    });
    const compiled = compileContext(multiSeedInput);

    expect(compiled.status).toBe("degraded");
    expect(compiled.reasons.map((reason) => reason.code)).toContain("token-budget-exceeded");
    const boundIds = compiled.packet?.nodes.map((node) => node.id) ?? [];
    for (const seedId of seedIds) {
      expect(boundIds, `seed ${seedId} must survive the trim`).toContain(seedId);
    }
    // At least one neighbour -- unrequested context, unlike the seeds --
    // was the thing actually trimmed to make the budget fit; not every
    // neighbour needs to be (only enough to fit).
    expect(neighborIds.some((neighborId) => !boundIds.includes(neighborId))).toBe(true);
    expect(compiled.packet?.query.kind).toBe("expand");
    if (compiled.packet?.query.kind === "expand") {
      expect([...compiled.packet.query.targetNodeIds].sort()).toEqual([...seedIds].sort());
    }
    expect(validateCompilerResult(compiled, multiSeedInput)).toEqual(compiled);
    expect(validateContextResult(compiled, multiSeedInput)).toEqual(compiled);
  });

  it("strictly validates cached results and their compile-input bindings", () => {
    const compiled = compileContext(input());
    expect(validateContextResult(compiled, input())).toEqual(compiled);

    const corruptDigest = structuredClone(compiled);
    corruptDigest.packet!.digest = "f".repeat(64);
    expect(() => validateContextResult(corruptDigest, input())).toThrowError(
      expect.objectContaining<Partial<ContextResultValidationError>>({
        path: "$.packet.digest",
      }),
    );

    const crafted = structuredClone(compiled) as typeof compiled & { rawText?: string };
    crafted.rawText = "repository body";
    expect(() => validateContextResult(crafted, input())).toThrowError(
      expect.objectContaining<Partial<ContextResultValidationError>>({ path: "$.rawText" }),
    );

    const craftedEnum = structuredClone(compiled);
    (craftedEnum.packet!.edges[0] as unknown as { kind: string }).kind = "bogus";
    craftedEnum.packet!.digest = canonicalContextPacketDigest(craftedEnum.packet!);
    expect(() => validateContextResult(craftedEnum, input())).toThrowError(
      expect.objectContaining<Partial<ContextResultValidationError>>({
        path: "$.packet.edges[0].kind",
      }),
    );

    expect(() =>
      validateContextResult(
        compiled,
        input({
          policy: { ...policy, digest: "e".repeat(64) },
        }),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ContextResultValidationError>>({ path: "$.provenance" }),
    );
  });

  it("rejects re-signed path and placement poisoning", () => {
    const poisonedPath = structuredClone(compileContext(input()));
    const traversedPath = poisonedPath.packet!.paths.find((path) => path.edgeKinds.length > 0)!;
    traversedPath.edgeKinds[0] = "outbound-link";
    resignPacket(poisonedPath);
    const poisonedPathIndex = poisonedPath.packet!.paths.indexOf(traversedPath);
    expect(() => validateContextResult(poisonedPath, input())).toThrowError(
      expect.objectContaining<Partial<ContextResultValidationError>>({
        path: `$.packet.paths[${poisonedPathIndex}].edgeKinds[0]`,
      }),
    );

    const placementInput = input({
      query: {
        kind: "test-placement",
        targetNodeId: TARGET,
        candidateParentId: HOME,
      },
    });
    const poisonedPlacement = structuredClone(compileContext(placementInput));
    poisonedPlacement.packet!.placementAssessment!.disposition = "belongs-here";
    resignPacket(poisonedPlacement);
    expect(() => validateContextResult(poisonedPlacement, placementInput)).toThrowError(
      expect.objectContaining<Partial<ContextResultValidationError>>({
        path: "$.packet.placementAssessment",
      }),
    );
  });

  it("rejects re-signed provenance poisoning", () => {
    const baseline = compileContext(input());

    const consulted = structuredClone(baseline);
    consulted.provenance.consultedNodeIds = consulted.provenance.consultedNodeIds.slice(1);
    consulted.packet!.provenance.consultedNodeIds =
      consulted.packet!.provenance.consultedNodeIds.slice(1);
    resignPacket(consulted);
    expect(() => validateContextResult(consulted, input())).toThrowError(
      expect.objectContaining<Partial<ContextResultValidationError>>({
        path: "$.provenance.consultedNodeIds",
      }),
    );

    const decisions = structuredClone(baseline);
    decisions.provenance.activeDecisionIds = [];
    decisions.packet!.provenance.activeDecisionIds = [];
    resignPacket(decisions);
    expect(() => validateContextResult(decisions, input())).toThrowError(
      expect.objectContaining<Partial<ContextResultValidationError>>({
        path: "$.provenance.activeDecisionIds",
      }),
    );

    const semanticRefs = structuredClone(baseline);
    semanticRefs.provenance.semanticPackets = [];
    semanticRefs.packet!.provenance.semanticPackets = [];
    resignPacket(semanticRefs);
    expect(() => validateContextResult(semanticRefs, input())).toThrowError(
      expect.objectContaining<Partial<ContextResultValidationError>>({
        path: "$.provenance.semanticPackets",
      }),
    );
  });

  it("rejects a re-signed unrelated valid-node substitution", () => {
    const locateInput = input({
      query: {
        kind: "locate",
        sourcePath: "guides/setup.md",
        anchor: "get-started",
      },
    });
    const poisoned = structuredClone(compileContext(locateInput));
    const unrelated = compileContext(
      input({
        query: { kind: "locate", sourcePath: "guides/index.md" },
      }),
    );
    poisoned.packet!.nodes = structuredClone(unrelated.packet!.nodes);
    poisoned.packet!.edges = structuredClone(unrelated.packet!.edges);
    poisoned.packet!.paths = structuredClone(unrelated.packet!.paths);
    poisoned.packet!.semantics = structuredClone(unrelated.packet!.semantics);
    poisoned.provenance.consultedNodeIds = [HOME];
    poisoned.provenance.activeDecisionIds = [];
    poisoned.provenance.semanticPackets = [];
    poisoned.packet!.provenance.consultedNodeIds = [HOME];
    poisoned.packet!.provenance.activeDecisionIds = [];
    poisoned.packet!.provenance.semanticPackets = [];
    resignPacket(poisoned);

    // The packet is internally coherent and uses only real index evidence; the
    // exact reconstruction check rejects it because it was not query-derived.
    expect(validateCompilerResult(poisoned, locateInput)).toEqual(poisoned);
    expect(() => validateContextResult(poisoned, locateInput)).toThrowError(
      expect.objectContaining<Partial<ContextResultValidationError>>({ path: "$" }),
    );
  });
});
