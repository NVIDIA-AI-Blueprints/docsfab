// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildContentIndex } from "../src/content-ir/index.js";
import type { ContentIndexV1 } from "../src/content-ir/index.js";
import { contextPacketBudget } from "../src/context/budget.js";
import {
  canonicalContextPacketDigest,
  canonicalContextPacketJson,
  compileContext,
  ContextResultValidationError,
  validateCompilerResult,
} from "../src/context/compiler.js";
import type {
  ContextBudget,
  ContextCompileInput,
  ContextEdgeSummary,
  ContextPacketV1,
  ContextPathSummary,
  ContextQuery,
  ContextResult,
} from "../src/context/contracts.js";
import { structuralOntology } from "../src/context/index.js";
import { temporaryRoots } from "./helpers/temp.js";

const REVISION = "a".repeat(40);
const BYTES_PER_TOKEN = 4;
const roots = temporaryRoots();

/** A repository on disk, indexed the way the preflight indexes one. */
async function indexed(files: Record<string, string>): Promise<ContentIndexV1> {
  const root = await roots.create("docsfab-context-packet-trim-");
  for (const [path, text] of Object.entries(files)) {
    await mkdir(resolve(root, path, ".."), { recursive: true });
    await writeFile(resolve(root, path), text, "utf8");
  }
  return buildContentIndex({ repositoryPath: root, repositoryRevision: REVISION });
}

/**
 * Six cross-linked guides with sections and subsections, and a README that
 * links each: every node kind and structural edge kind a corpus walk meets.
 */
function crossLinkedCorpus(): Record<string, string> {
  const guides = Array.from({ length: 6 }, (_unused, guide) => `docs/guide-${guide}.md`);
  const files: Record<string, string> = {
    "README.md": `# Guides\n\n${guides.map((path) => `- [${path}](${path})`).join("\n")}\n`,
  };
  guides.forEach((path, guide) => {
    const topics = Array.from({ length: 3 }, (_unused, topic) => {
      const linked = (guide + topic + 1) % guides.length;
      return [
        `## Topic ${topic}`,
        "",
        `See [guide ${linked}](guide-${linked}.md#topic-${topic}).`,
        "",
        `### Step ${topic}.1`,
        "",
        "Do this.",
        "",
        `### Step ${topic}.2`,
        "",
        "Then that.",
        "",
      ].join("\n");
    });
    files[path] =
      `# Guide ${guide}\n\nNext: [guide ${(guide + 1) % 6}](guide-${(guide + 1) % 6}.md).\n\n` +
      topics.join("\n");
  });
  return files;
}

function compileInput(
  index: ContentIndexV1,
  query: ContextQuery,
  budget: ContextBudget,
): ContextCompileInput {
  return {
    index,
    ontology: structuralOntology(index),
    semantics: [],
    query,
    policy: {
      id: "workflow:readiness:context",
      version: "1",
      digest: "d".repeat(64),
      allowDegradedRead: true,
    },
    budget,
  };
}

/** A budget of `tokens` estimated tokens: the shape `contextPacketBudget` gives. */
function tokenBudget(tokens: number): ContextBudget {
  return {
    ...contextPacketBudget("corpus"),
    maxNodes: tokens,
    maxEdges: tokens,
    maxPaths: tokens,
    maxEstimatedTokens: tokens,
    maxBytes: tokens * BYTES_PER_TOKEN,
  };
}

function documentId(index: ContentIndexV1, sourcePath: string): string {
  const node = index.nodes.find(
    (candidate) => candidate.kind === "document" && candidate.sourcePath === sourcePath,
  );
  if (!node) throw new Error(`no document ${sourcePath}`);
  return node.id;
}

function edgeKey(edge: ContextEdgeSummary): string {
  return `${edge.kind}\0${edge.from}\0${edge.to}`;
}

function pathKey(path: ContextPathSummary): string {
  return path.nodeIds.join("\0");
}

/**
 * The byte length `packet` measures once its estimates describe it: what the
 * compiler reports for a walk it measured but did not keep.
 */
function settledByteLength(packet: ContextPacketV1): number {
  let estimates = { byteLength: 0, estimatedTokens: 0 };
  for (;;) {
    const byteLength = Buffer.byteLength(canonicalContextPacketJson({ ...packet, estimates }));
    const estimatedTokens = Math.ceil(byteLength / BYTES_PER_TOKEN);
    if (estimates.byteLength === byteLength && estimates.estimatedTokens === estimatedTokens) {
      return byteLength;
    }
    estimates = { byteLength, estimatedTokens };
  }
}

/** `packet` with its estimates and digest recomputed, as a producer would seal it. */
function resealed(packet: ContextPacketV1): ContextPacketV1 {
  const byteLength = settledByteLength(packet);
  const sealed = {
    ...packet,
    estimates: { byteLength, estimatedTokens: Math.ceil(byteLength / BYTES_PER_TOKEN) },
  };
  return { ...sealed, digest: canonicalContextPacketDigest(sealed) };
}

interface Shape {
  readonly label: string;
  readonly query: ContextQuery;
  /** The nodes the request names, in the order it names them. */
  readonly requested: readonly string[];
}

/**
 * Checks one compile against the untrimmed walk: every kept edge and path
 * joins kept nodes, the cut is a rank prefix (requested targets in request
 * order, then nearer nodes before farther, edges by their farther end, paths
 * by their end), the estimates are exact and within budget, and a trim
 * reports the walk's whole size. Returns a description of each violation.
 */
function trimViolations(
  shape: Shape,
  input: ContextCompileInput,
  result: ContextResult,
  whole: ContextPacketV1,
): string[] {
  const violations: string[] = [];
  const budget = input.budget;
  const depth = new Map(whole.paths.map((path) => [path.nodeIds.at(-1)!, path.nodeIds.length - 1]));
  const packet = result.packet;
  const wholeSize = settledByteLength({
    ...whole,
    provenance: { ...whole.provenance, budget },
  });
  const reasonSize = (code: string): number | undefined => {
    const detail = result.reasons.find((reason) => reason.code === code)?.detail;
    return detail === undefined ? undefined : Number(detail);
  };
  if (!packet) {
    if (result.status !== "failed") violations.push(`status ${result.status} without a packet`);
    const smallest = reasonSize("token-budget-exceeded");
    if (smallest === undefined || smallest <= budget.maxEstimatedTokens) {
      violations.push(`no packet, but the token reason reads ${smallest}`);
    }
    return violations;
  }
  const byteLength = Buffer.byteLength(canonicalContextPacketJson(packet));
  if (
    packet.estimates.byteLength !== byteLength ||
    packet.estimates.estimatedTokens !== Math.ceil(byteLength / BYTES_PER_TOKEN)
  ) {
    violations.push(`estimates ${JSON.stringify(packet.estimates)} for ${byteLength} bytes`);
  }
  if (
    byteLength > budget.maxBytes ||
    packet.estimates.estimatedTokens > budget.maxEstimatedTokens
  ) {
    violations.push(`${byteLength} bytes exceed the budget`);
  }
  const kept = new Set(packet.nodes.map((node) => node.id));
  for (const edge of packet.edges) {
    if (!kept.has(edge.from) || !kept.has(edge.to)) {
      violations.push(`dangling ${edge.kind} edge ${edge.from} -> ${edge.to}`);
    }
  }
  for (const path of packet.paths) {
    if (path.nodeIds.some((nodeId) => !kept.has(nodeId))) {
      violations.push(`dangling path to ${path.nodeIds.at(-1)}`);
    }
  }
  const targets = packet.query.kind === "expand" ? packet.query.targetNodeIds : [];
  for (const nodeId of [...targets, ...packet.provenance.consultedNodeIds]) {
    if (!kept.has(nodeId)) violations.push(`query or provenance names trimmed node ${nodeId}`);
  }
  try {
    validateCompilerResult(result, input);
  } catch (error) {
    violations.push(`validator: ${(error as Error).message}`);
  }

  if (result.status === "ready") {
    if (
      canonicalContextPacketJson({ ...packet, provenance: whole.provenance }) !==
      canonicalContextPacketJson({ ...whole, estimates: packet.estimates, digest: packet.digest })
    ) {
      violations.push("a ready packet differs from the untrimmed walk");
    }
    if (wholeSize !== byteLength) violations.push(`ready at ${byteLength}, walk is ${wholeSize}`);
    return violations;
  }

  // Requested targets first, in the order the request named them.
  const keptRequested = shape.requested.filter((nodeId) => kept.has(nodeId));
  if (keptRequested.join() !== shape.requested.slice(0, keptRequested.length).join()) {
    violations.push(`kept targets out of request order: ${keptRequested.join(", ")}`);
  }
  // Then nearer before farther: keeping a node at some depth keeps every
  // nearer one; an edge ranks by its farther end and a path by its end.
  const deepest = (values: readonly number[]): number => Math.max(-1, ...values);
  const nodeDepth = deepest(packet.nodes.map((node) => depth.get(node.id)!));
  for (const node of whole.nodes) {
    if (depth.get(node.id)! < nodeDepth && !kept.has(node.id)) {
      violations.push(`dropped node ${node.id} nearer than a kept one`);
    }
  }
  const edgeDepth = (edge: ContextEdgeSummary): number =>
    Math.max(depth.get(edge.from)!, depth.get(edge.to)!);
  const keptEdges = new Set(packet.edges.map(edgeKey));
  const keptEdgeDepth = deepest(packet.edges.map(edgeDepth));
  for (const edge of whole.edges) {
    if (
      kept.has(edge.from) &&
      kept.has(edge.to) &&
      edgeDepth(edge) < keptEdgeDepth &&
      !keptEdges.has(edgeKey(edge))
    ) {
      violations.push(
        `dropped edge ${edge.kind} ${edge.from} -> ${edge.to} nearer than a kept one`,
      );
    }
  }
  const keptPaths = new Set(packet.paths.map(pathKey));
  const keptPathDepth = deepest(packet.paths.map((path) => path.nodeIds.length - 1));
  for (const path of whole.paths) {
    if (
      kept.has(path.nodeIds.at(-1)!) &&
      path.nodeIds.length - 1 < keptPathDepth &&
      !keptPaths.has(pathKey(path))
    ) {
      violations.push(`dropped path to ${path.nodeIds.at(-1)} nearer than a kept one`);
    }
  }
  // A trim reports the whole walk's size, measured under this budget.
  if (reasonSize("byte-budget-exceeded") !== wholeSize) {
    violations.push(`byte reason ${reasonSize("byte-budget-exceeded")}, walk is ${wholeSize}`);
  }
  if (reasonSize("token-budget-exceeded") !== Math.ceil(wholeSize / BYTES_PER_TOKEN)) {
    violations.push(`token reason ${reasonSize("token-budget-exceeded")}, walk is ${wholeSize}`);
  }
  return violations;
}

describe("context packet trims keep a rank prefix of the walk (#1932)", () => {
  it("keeps only edges and paths among kept nodes, nearest first, at every budget and query shape", async () => {
    const index = await indexed(crossLinkedCorpus());
    const documents = index.nodes
      .filter((node) => node.kind === "document")
      .map((node) => node.id)
      .sort();
    // Three pages named in descending ID order, so request order is not the
    // sorted order the packet records.
    const named = [
      documentId(index, "docs/guide-4.md"),
      documentId(index, "docs/guide-1.md"),
      documentId(index, "README.md"),
    ]
      .sort()
      .reverse();
    const neighborhood = documentId(index, "docs/guide-2.md");
    const located = index.nodes
      .filter((node) => node.sourcePath === "docs/guide-3.md")
      .map((node) => node.id)
      .sort();
    const shapes: Shape[] = [
      {
        label: "expand of every page",
        query: { kind: "expand", targetNodeIds: documents, depth: 2 },
        requested: documents,
      },
      {
        label: "expand of three named pages",
        query: { kind: "expand", targetNodeIds: named, depth: 2 },
        requested: named,
      },
      {
        label: "get-neighborhood",
        query: { kind: "get-neighborhood", targetNodeId: neighborhood, depth: 2 },
        requested: [neighborhood],
      },
      {
        label: "locate",
        query: { kind: "locate", sourcePath: "docs/guide-3.md" },
        requested: located,
      },
    ];

    let compiles = 0;
    const statuses = new Set<string>();
    for (const shape of shapes) {
      const whole = compileContext(compileInput(index, shape.query, tokenBudget(9_999_999)));
      expect(whole.status, shape.label).toBe("ready");
      const wholeTokens = whole.packet!.estimates.estimatedTokens;
      // From a budget no node fits to one past the whole walk, in 48 steps.
      for (let step = 0; step <= 48; step += 1) {
        const tokens = Math.max(20, Math.round(20 + ((wholeTokens + 40 - 20) * step) / 48));
        const input = compileInput(index, shape.query, tokenBudget(tokens));
        const result = compileContext(input);
        compiles += 1;
        statuses.add(result.status);
        expect(
          trimViolations(shape, input, result, whole.packet!),
          `${shape.label} at ${tokens}`,
        ).toEqual([]);
      }
    }
    expect(compiles).toBe(4 * 49);
    // The sweep reaches every outcome: no packet, a trimmed one, and a whole one.
    expect([...statuses].sort()).toEqual(["degraded", "failed", "ready"]);
  });

  it("drops the edges and path of a node that does not fit, even when they would", async () => {
    // Page A links to page B, whose anchor list alone outweighs the budget.
    const index = await indexed({
      "docs/a.md": "# A\n\nSee [B](b.md).\n",
      "docs/b.md": `# B\n\n${Array.from({ length: 300 }, (_unused, heading) => `## Heading ${heading}\n\nText.\n`).join("\n")}`,
    });
    const a = documentId(index, "docs/a.md");
    const b = documentId(index, "docs/b.md");
    const query: ContextQuery = { kind: "get-neighborhood", targetNodeId: a, depth: 2 };
    const whole = compileContext(compileInput(index, query, tokenBudget(9_999_999))).packet!;
    const bNode = whole.nodes.find((node) => node.id === b)!;
    // Room for everything but page B's node: its edges and path would fit.
    const tokens = Math.ceil(
      (whole.estimates.byteLength - Buffer.byteLength(JSON.stringify(bNode))) / BYTES_PER_TOKEN,
    );
    const input = compileInput(index, query, tokenBudget(tokens));
    const result = compileContext(input);
    expect(result.status).toBe("degraded");
    const packet = result.packet!;
    const kept = new Set(packet.nodes.map((node) => node.id));
    expect(kept.has(a)).toBe(true);
    expect(kept.has(b)).toBe(false);
    expect(packet.nodes).toHaveLength(whole.nodes.length - 1);
    expect(packet.edges).toEqual(whole.edges.filter((edge) => edge.from !== b && edge.to !== b));
    expect(packet.paths).toEqual(whole.paths.filter((path) => !path.nodeIds.includes(b)));
    expect(validateCompilerResult(result, input)).toEqual(result);
  });

  it("refuses a packet whose edge or path names a node it does not carry", async () => {
    const index = await indexed({
      "docs/a.md": "# A\n\nSee [B](b.md).\n",
      "docs/b.md": "# B\n\nText.\n",
    });
    const b = documentId(index, "docs/b.md");
    const input = compileInput(
      index,
      { kind: "locate", sourcePath: "docs/a.md" },
      tokenBudget(9_999),
    );
    const result = compileContext(input);
    expect(validateCompilerResult(result, input)).toEqual(result);
    const packet = result.packet!;
    const kept = new Set(packet.nodes.map((node) => node.id));
    expect(kept.has(b)).toBe(false);
    // A real index edge from a kept node to page B, which the packet does not
    // carry, so no other check refuses it: not the shape check, and not, with
    // the input, the check that every edge is an index edge.
    const link = index.edges.find(
      (edge) => edge.kind === "outbound-link" && edge.to === b && kept.has(edge.from),
    );
    expect(link).toBeDefined();
    const withEdge = resealed({
      ...packet,
      edges: [...packet.edges, { kind: "outbound-link", from: link!.from, to: b }],
    });
    const withPath = resealed({
      ...packet,
      paths: [...packet.paths, { nodeIds: [link!.from, b], edgeKinds: ["outbound-link"] }],
    });
    // Without the input only the packet's own membership check applies.
    for (const bound of [undefined, input]) {
      expect(() => validateCompilerResult({ ...result, packet: withEdge }, bound)).toThrow(
        expect.objectContaining<Partial<ContextResultValidationError>>({
          path: `$.packet.edges[${packet.edges.length}]`,
        }),
      );
      expect(() => validateCompilerResult({ ...result, packet: withPath }, bound)).toThrow(
        expect.objectContaining<Partial<ContextResultValidationError>>({
          path: `$.packet.paths[${packet.paths.length}].nodeIds[1]`,
        }),
      );
    }
    // Control: the same real edge and path pass both checks in a packet that
    // carries page B.
    const whole = compileContext(
      compileInput(
        index,
        { kind: "get-neighborhood", targetNodeId: link!.from, depth: 1 },
        tokenBudget(9_999),
      ),
    );
    expect(whole.packet!.nodes.some((node) => node.id === b)).toBe(true);
    expect(whole.packet!.edges).toContainEqual({ kind: "outbound-link", from: link!.from, to: b });
    expect(validateCompilerResult(whole)).toEqual(whole);
  });

  it("keeps every edge among its kept nodes before any path", async () => {
    const index = await indexed(crossLinkedCorpus());
    const documents = index.nodes
      .filter((node) => node.kind === "document")
      .map((node) => node.id)
      .sort();
    const query: ContextQuery = { kind: "expand", targetNodeIds: documents, depth: 2 };
    const whole = compileContext(compileInput(index, query, tokenBudget(9_999_999))).packet!;
    // A budget with room for every node and edge and about two paths more.
    let tokens = 1_000;
    for (let round = 0; round < 4; round += 1) {
      const withoutPaths = settledByteLength({
        ...whole,
        paths: [],
        provenance: { ...whole.provenance, budget: tokenBudget(tokens) },
      });
      tokens = Math.ceil(withoutPaths / BYTES_PER_TOKEN) + 60;
    }
    const result = compileContext(compileInput(index, query, tokenBudget(tokens)));
    expect(result.status).toBe("degraded");
    const packet = result.packet!;
    expect(packet.nodes).toEqual(whole.nodes);
    expect(packet.edges).toEqual(whole.edges);
    expect(packet.paths.length).toBeGreaterThan(0);
    expect(packet.paths.length).toBeLessThan(whole.paths.length);
  });

  it("keeps a packet exactly at its byte or token budget whole, and trims it one below", async () => {
    const index = await indexed(crossLinkedCorpus());
    const query: ContextQuery = {
      kind: "get-neighborhood",
      targetNodeId: documentId(index, "docs/guide-2.md"),
      depth: 2,
    };
    const compile = (budget: ContextBudget): ContextResult =>
      compileContext(compileInput(index, query, budget));
    // Each bound alone: the other one never binds.
    const bytesOnly = (maxBytes: number): ContextBudget => ({
      ...tokenBudget(9_999_999),
      maxBytes,
    });
    const tokensOnly = (maxEstimatedTokens: number): ContextBudget => ({
      ...tokenBudget(9_999_999),
      maxEstimatedTokens,
    });
    for (const [label, bounded, measure, code] of [
      [
        "bytes",
        bytesOnly,
        (packet: ContextPacketV1) => packet.estimates.byteLength,
        "byte-budget-exceeded",
      ],
      [
        "tokens",
        tokensOnly,
        (packet: ContextPacketV1) => packet.estimates.estimatedTokens,
        "token-budget-exceeded",
      ],
    ] as const) {
      // The packet records its budget, so settle the bound against the size.
      let bound = 1_000;
      for (let round = 0; round < 4; round += 1) {
        const result = compile(bounded(bound));
        const detail = result.reasons.find((reason) => reason.code === code)?.detail;
        bound = detail === undefined ? measure(result.packet!) : Number(detail);
      }
      const at = compile(bounded(bound));
      expect(at.status, label).toBe("ready");
      expect(at.reasons, label).toEqual([]);
      expect(measure(at.packet!), label).toBe(bound);
      expect(String(bound - 1), label).toHaveLength(String(bound).length);
      const below = compile(bounded(bound - 1));
      expect(below.status, label).toBe("degraded");
      expect(below.reasons, label).toContainEqual({ code, detail: String(bound) });
      expect(measure(below.packet!), label).toBeLessThan(bound);
    }
  });
});
