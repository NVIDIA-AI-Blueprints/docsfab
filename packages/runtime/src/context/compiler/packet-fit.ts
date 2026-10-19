// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalDigest, canonicalJson } from "../../content-ir/canonical.js";
import { CONTEXT_PACKET_BYTES_PER_ESTIMATED_TOKEN } from "../contracts.js";
import type { ArtifactEnvelope } from "../../artifacts/contracts.js";
import type {
  ContextBudget,
  ContextEdgeSummary,
  ContextNodeSummary,
  ContextPacketV1,
  ContextPathSummary,
  ContextProvenance,
  ContextQuery,
  ContextSemanticSummary,
  PlacementAssessment,
} from "../contracts.js";
import {
  artifactReference,
  edgeKey,
  pathKey,
  referenceKey,
  semanticSummary,
  uniqueSorted,
} from "./projections.js";

function makePacket(
  query: ContextQuery,
  nodes: ContextNodeSummary[],
  edges: ContextEdgeSummary[],
  paths: ContextPathSummary[],
  semantics: ContextSemanticSummary[],
  provenance: ContextProvenance,
  placementAssessment?: PlacementAssessment,
): ContextPacketV1 {
  const packet: ContextPacketV1 = {
    schemaVersion: 1,
    query,
    nodes,
    edges,
    paths,
    semantics,
    ...(placementAssessment ? { placementAssessment } : {}),
    provenance,
    estimates: { byteLength: 0, estimatedTokens: 0 },
    digest: "0".repeat(64),
  };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    packet.digest = canonicalContextPacketDigest(packet);
    const byteLength = Buffer.byteLength(canonicalContextPacketJson(packet));
    const estimatedTokens = estimatedTokensFor(byteLength);
    if (
      packet.estimates.byteLength === byteLength &&
      packet.estimates.estimatedTokens === estimatedTokens
    )
      break;
    packet.estimates = { byteLength, estimatedTokens };
  }
  packet.digest = canonicalContextPacketDigest(packet);
  return packet;
}

export function estimatedTokensFor(byteLength: number): number {
  return Math.ceil(byteLength / CONTEXT_PACKET_BYTES_PER_ESTIMATED_TOKEN);
}

/**
 * Everything one walk can put in a packet, each list in rank order (see
 * `retentionOrder`), plus the parts every candidate shares. A candidate keeps a
 * prefix of each list, so shortening a candidate always drops its
 * lowest-ranked element.
 */
export interface PacketParts {
  readonly query: ContextQuery;
  readonly rankedNodes: readonly ContextNodeSummary[];
  /** Edges by the rank of their farther endpoint; `edgeEnds[i]` is that rank. */
  readonly rankedEdges: readonly ContextEdgeSummary[];
  readonly edgeEnds: readonly number[];
  /** One path per kept node, by that node's rank; `pathEnds[i]` is that rank. */
  readonly rankedPaths: readonly ContextPathSummary[];
  readonly pathEnds: readonly number[];
  /** Semantic inputs in packet order. */
  readonly semantics: readonly ArtifactEnvelope<"context-packet">[];
  readonly provenance: ContextProvenance;
  readonly placementAssessment?: PlacementAssessment;
}

/** How long a prefix of each ranked list a candidate keeps. */
export interface PacketCut {
  readonly nodes: number;
  readonly edges: number;
  readonly paths: number;
}

/** Elements of an ascending rank list that sit below `rank`: a prefix length. */
function countBelow(ends: readonly number[], rank: number): number {
  let lower = 0;
  let upper = ends.length;
  while (lower < upper) {
    const middle = (lower + upper) >>> 1;
    if (ends[middle]! < rank) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

function retainedSemanticInputs(
  parts: PacketParts,
  retainedNodeIds: ReadonlySet<string>,
): ArtifactEnvelope<"context-packet">[] {
  return parts.semantics.filter((semantic) => retainedNodeIds.has(semantic.payload.targetNodeId));
}

function retainedProvenance(
  parts: PacketParts,
  retainedNodeIds: ReadonlySet<string>,
  retainedSemantics: readonly ArtifactEnvelope<"context-packet">[],
): ContextProvenance {
  return {
    ...parts.provenance,
    semanticPackets: retainedSemantics
      .map(artifactReference)
      .sort((left, right) => referenceKey(left).localeCompare(referenceKey(right))),
    consultedNodeIds: parts.provenance.consultedNodeIds.filter((nodeId) =>
      retainedNodeIds.has(nodeId),
    ),
    activeDecisionIds: uniqueSorted(
      retainedSemantics.flatMap((semantic) => semantic.payload.activeDecisionIds),
    ),
  };
}

/** The packet a cut keeps, in the canonical order an untrimmed packet uses. */
function candidatePacket(parts: PacketParts, cut: PacketCut): ContextPacketV1 {
  const retainedNodes = parts.rankedNodes.slice(0, cut.nodes);
  const retainedNodeIds = new Set(retainedNodes.map((node) => node.id));
  const retainedSemantics = retainedSemanticInputs(parts, retainedNodeIds);
  const nodesById = new Map(retainedNodes.map((node) => [node.id, node]));
  return makePacket(
    parts.query.kind === "expand"
      ? {
          ...parts.query,
          targetNodeIds: parts.query.targetNodeIds.filter((nodeId) => retainedNodeIds.has(nodeId)),
        }
      : parts.query,
    uniqueSorted([...retainedNodeIds]).map((nodeId) => nodesById.get(nodeId)!),
    parts.rankedEdges
      .slice(0, cut.edges)
      .sort((left, right) => edgeKey(left).localeCompare(edgeKey(right))),
    parts.rankedPaths
      .slice(0, cut.paths)
      .sort((left, right) => pathKey(left).localeCompare(pathKey(right))),
    retainedSemantics.map((semantic) => semanticSummary(semantic.payload)),
    retainedProvenance(parts, retainedNodeIds, retainedSemantics),
    parts.placementAssessment,
  );
}

/** Running totals: `sums[k]` is the sum of the first `k` values. */
function prefixSums(values: readonly number[]): number[] {
  const sums = [0];
  for (const value of values) sums.push(sums.at(-1)! + value);
  return sums;
}

/** Bytes `count` elements add to an empty canonical JSON list: themselves and their commas. */
function listBytes(sums: readonly number[], count: number): number {
  return count === 0 ? 0 : sums[count]! + count - 1;
}

/**
 * The same for a list whose members were measured with a trailing comma each
 * and only some of the first `rankCount` ranks belong: the last comma is the
 * one the list does not have.
 */
function commaTerminatedListBytes(
  sums: readonly number[],
  counts: readonly number[],
  rankCount: number,
): number {
  return counts[rankCount] === 0 ? 0 : sums[rankCount]! - 1;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value));
}

/**
 * Exact canonical byte length of any cut, without serializing its long
 * lists. Canonical JSON joins list elements with bare commas, so a list adds
 * its elements' bytes plus one byte between each pair; every element is
 * measured once, and a cut costs one small skeleton plus prefix sums. That
 * keeps a trim of a whole large corpus linear instead of re-serializing the
 * packet per probe.
 */
export class PacketSizer {
  private readonly nodeBytes: number[];
  /** Consulted and target IDs are measured with their trailing comma. */
  private readonly consultedIdBytes: number[];
  private readonly consultedCounts: number[];
  private readonly targetIdBytes: number[];
  private readonly targetCounts: number[];
  private readonly edgeBytes: number[];
  private readonly pathBytes: number[];
  /** Ascending ranks of the semantic inputs' targets; unwalked targets never stay. */
  private readonly semanticRanks: number[];
  private readonly skeletons = new Map<number, number>();

  public constructor(
    private readonly parts: PacketParts,
    rank: ReadonlyMap<string, number>,
  ) {
    const consulted = new Set(parts.provenance.consultedNodeIds);
    const targets = new Set(parts.query.kind === "expand" ? parts.query.targetNodeIds : []);
    const idBytes = (member: boolean, nodeId: string): number =>
      member ? jsonBytes(nodeId) + 1 : 0;
    this.nodeBytes = prefixSums(parts.rankedNodes.map(jsonBytes));
    this.consultedIdBytes = prefixSums(
      parts.rankedNodes.map((node) => idBytes(consulted.has(node.id), node.id)),
    );
    this.consultedCounts = prefixSums(
      parts.rankedNodes.map((node) => (consulted.has(node.id) ? 1 : 0)),
    );
    this.targetIdBytes = prefixSums(
      parts.rankedNodes.map((node) => idBytes(targets.has(node.id), node.id)),
    );
    this.targetCounts = prefixSums(parts.rankedNodes.map((node) => (targets.has(node.id) ? 1 : 0)));
    this.edgeBytes = prefixSums(parts.rankedEdges.map(jsonBytes));
    this.pathBytes = prefixSums(parts.rankedPaths.map(jsonBytes));
    this.semanticRanks = parts.semantics
      .map((semantic) => rank.get(semantic.payload.targetNodeId) ?? Number.POSITIVE_INFINITY)
      .sort((left, right) => left - right);
  }

  /** The `estimates.byteLength` that `candidatePacket(parts, cut)` would carry. */
  public byteLength(cut: PacketCut): number {
    const withZeroEstimates =
      this.skeletonBytes(cut.nodes) +
      listBytes(this.nodeBytes, cut.nodes) +
      commaTerminatedListBytes(this.consultedIdBytes, this.consultedCounts, cut.nodes) +
      commaTerminatedListBytes(this.targetIdBytes, this.targetCounts, cut.nodes) +
      listBytes(this.edgeBytes, cut.edges) +
      listBytes(this.pathBytes, cut.paths);
    return settledByteLength(withZeroEstimates);
  }

  /**
   * The cut's packet with every long list empty and zero estimates. Only its
   * semantics depend on the cut, and they shrink as a rank prefix, so one
   * skeleton serves every cut that keeps the same semantics.
   */
  private skeletonBytes(nodeCount: number): number {
    const semanticCount = countBelow(this.semanticRanks, nodeCount);
    const cached = this.skeletons.get(semanticCount);
    if (cached !== undefined) return cached;
    const retainedNodeIds = new Set(
      this.parts.rankedNodes.slice(0, nodeCount).map((node) => node.id),
    );
    const retainedSemantics = retainedSemanticInputs(this.parts, retainedNodeIds);
    const skeleton: ContextPacketV1 = {
      schemaVersion: 1,
      query:
        this.parts.query.kind === "expand"
          ? { ...this.parts.query, targetNodeIds: [] }
          : this.parts.query,
      nodes: [],
      edges: [],
      paths: [],
      semantics: retainedSemantics.map((semantic) => semanticSummary(semantic.payload)),
      ...(this.parts.placementAssessment
        ? { placementAssessment: this.parts.placementAssessment }
        : {}),
      provenance: {
        ...retainedProvenance(this.parts, retainedNodeIds, retainedSemantics),
        consultedNodeIds: [],
      },
      estimates: { byteLength: 0, estimatedTokens: 0 },
      digest: "0".repeat(64),
    };
    const bytes = jsonBytes(skeleton);
    this.skeletons.set(semanticCount, bytes);
    return bytes;
  }
}

/**
 * The byte length `makePacket` settles on for a packet that measures
 * `withZeroEstimates` bytes while its estimates read 0 and 0. Each round
 * rewrites the two estimate numbers; the length never shrinks and its digits
 * grow only logarithmically, so the rounds settle within a few steps.
 */
function settledByteLength(withZeroEstimates: number): number {
  const zeroDigits = String(0).length * 2;
  let byteLength = withZeroEstimates;
  for (;;) {
    const next =
      withZeroEstimates -
      zeroDigits +
      String(byteLength).length +
      String(estimatedTokensFor(byteLength)).length;
    if (next === byteLength) return byteLength;
    byteLength = next;
  }
}

/** The largest count in `[low, high]` that fits, or `undefined` when `low` does not. */
function largestFitting(
  low: number,
  high: number,
  fits: (count: number) => boolean,
): number | undefined {
  if (!fits(low)) return undefined;
  let best = low;
  let lower = low + 1;
  let upper = high;
  while (lower <= upper) {
    const middle = (lower + upper) >>> 1;
    if (fits(middle)) {
      best = middle;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  return best;
}

function withinBudget(byteLength: number, budget: ContextBudget): boolean {
  return (
    byteLength <= budget.maxBytes && estimatedTokensFor(byteLength) <= budget.maxEstimatedTokens
  );
}

/**
 * The cut that keeps the most of the walk within `budget`, or `undefined`
 * when not even the first-ranked node fits. The whole walk wins when it fits.
 * Otherwise the most nodes that fit alone, then the most of their edges that
 * still fit, then the most of their paths.
 */
export function fitPacketCut(
  parts: PacketParts,
  sizer: PacketSizer,
  budget: ContextBudget,
  whole: PacketCut,
): PacketCut | undefined {
  if (withinBudget(sizer.byteLength(whole), budget)) return whole;
  if (whole.nodes === 0) return undefined;
  const nodes = largestFitting(1, whole.nodes, (count) =>
    withinBudget(sizer.byteLength({ nodes: count, edges: 0, paths: 0 }), budget),
  );
  if (nodes === undefined) return undefined;
  const edges = largestFitting(0, countBelow(parts.edgeEnds, nodes), (count) =>
    withinBudget(sizer.byteLength({ nodes, edges: count, paths: 0 }), budget),
  )!;
  const paths = largestFitting(0, countBelow(parts.pathEnds, nodes), (count) =>
    withinBudget(sizer.byteLength({ nodes, edges, paths: count }), budget),
  )!;
  return { nodes, edges, paths };
}

/**
 * Builds the chosen cut and confirms it against the budget. The sizer is
 * exact, so the first build fits; if it ever did not, the cut gives up its
 * lowest-ranked path, then edge, then node until it does, so no packet over
 * its budget can leave the compiler.
 */
export function fittedPacket(
  parts: PacketParts,
  cut: PacketCut,
  budget: ContextBudget,
): ContextPacketV1 | undefined {
  let current: PacketCut | undefined = cut;
  while (current) {
    const packet = candidatePacket(parts, current);
    if (withinBudget(packet.estimates.byteLength, budget)) return packet;
    current =
      current.paths > 0
        ? { ...current, paths: current.paths - 1 }
        : current.edges > 0
          ? { ...current, edges: current.edges - 1 }
          : current.nodes > 1
            ? { nodes: current.nodes - 1, edges: 0, paths: 0 }
            : undefined;
  }
  return undefined;
}

export function canonicalContextPacketJson(packet: ContextPacketV1): string {
  return canonicalJson(packet);
}

export function canonicalContextPacketDigest(packet: ContextPacketV1): string {
  const { digest: _digest, ...digestible } = packet;
  return canonicalDigest(digestible);
}
