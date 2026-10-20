// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  ORGANIZING_AXES,
  type ArtifactEvidence,
  type OrganizingAxis,
} from "../artifacts/contracts.js";
import type { ContentIndex, ContentNode, StructuralEdge } from "../content-ir/contracts.js";
import { canonicalDigest } from "../content-ir/canonical.js";
import { ContentIndexDecodeError, decodeContentIndex } from "../content-ir/decoder.js";

export const IA_SCORE_WEIGHTS = {
  evidenceCoverage: 15,
  cohesion: 15,
  separation: 15,
  predictability: 20,
  balance: 10,
  stability: 15,
  duplication: 10,
} as const;

export type IaScoreComponent = keyof typeof IA_SCORE_WEIGHTS;

export interface IaTopologyGroup {
  /** Stable machine identity. It is deliberately excluded from topology comparisons. */
  id: string;
  /** Display text. It never contributes to a structural score or digest. */
  label?: string;
  axis: OrganizingAxis;
  canonicalPath: string;
  memberNodeIds: string[];
  evidence: ArtifactEvidence[];
}

export interface IaPathPlacement {
  nodeId: string;
  proposedPath: string;
  evidence: ArtifactEvidence[];
}

export interface IaScoringCandidate {
  id: string;
  /** Display text. It never contributes to a structural score or digest. */
  label?: string;
  primaryAxis: OrganizingAxis;
  /** Explicitly declared axes that may organize a separate sibling set. */
  secondaryAxes: OrganizingAxis[];
  groups: IaTopologyGroup[];
  placements: IaPathPlacement[];
  evidence: ArtifactEvidence[];
}

export interface IaScoringInput {
  /** A validated, revision-bound structural index. */
  index: ContentIndex;
  /** Document nodes whose placement is in scope. */
  targetNodeIds: string[];
  candidate: IaScoringCandidate;
}

export interface IaComponentScores {
  evidenceCoverage: number;
  cohesion: number;
  separation: number;
  predictability: number;
  balance: number;
  stability: number;
  duplication: number;
}

export const IA_INELIGIBILITY_REASONS = [
  "insufficient-evidence",
  "incomplete-placement",
  "ambiguous-placement",
  "mixed-axis",
  "incomplete-path-plan",
  "path-collision",
] as const;

export type IaIneligibilityReason = (typeof IA_INELIGIBILITY_REASONS)[number];

export type IaEligibility =
  | { eligible: true; reasons: [] }
  | { eligible: false; reasons: IaIneligibilityReason[] };

export interface IaCandidateScore {
  candidateId: string;
  topologyDigest: string;
  components: IaComponentScores;
  /** The weighted total is closed to the inclusive range 0..100. */
  total: number;
  /** Navigation-oriented subset of the components, also in 0..100. */
  structuralFindability: number;
  eligibility: IaEligibility;
}

export interface IaScoreComparison {
  baselineCandidateId: string;
  candidateId: string;
  baselineTopologyDigest: string;
  candidateTopologyDigest: string;
  topologyChanged: boolean;
  componentDeltas: IaComponentScores;
  totalDelta: number;
  structuralFindabilityDelta: number;
  improvesFindability: boolean;
  preservesAllUrls: boolean;
  candidateEligibility: IaEligibility;
}

export class IaScoringError extends Error {
  public constructor(
    public readonly code:
      | "invalid-index"
      | "invalid-candidate"
      | "invalid-target"
      | "invalid-evidence"
      | "unsafe-path",
    public readonly path: string,
  ) {
    super(`${code}:${path}`);
    this.name = "IaScoringError";
  }
}

const FINDABILITY_WEIGHTS = {
  evidenceCoverage: 20,
  cohesion: 25,
  separation: 20,
  predictability: 25,
  duplication: 10,
} as const;

const GRAPH_EDGE_KINDS = new Set<StructuralEdge["kind"]>([
  "navigation",
  "outbound-link",
  "backlink",
]);
const ORGANIZING_AXIS_SET = new Set<string>(ORGANIZING_AXES);

/**
 * Scores a proposed IA using only normalized repository structure and evidence.
 * This function does not invoke a model, execute repository text, or access the
 * network.
 */
export function scoreIaCandidate(input: IaScoringInput): IaCandidateScore {
  const validated = validateScoringInput(input);
  const targetSet = new Set(validated.targetNodeIds);
  const membership = memberships(validated.candidate.groups, targetSet);
  const placements = new Map(
    validated.candidate.placements.map((placement) => [placement.nodeId, placement]),
  );
  const evidenceNodeIds = new Set(
    [
      ...validated.candidate.evidence,
      ...validated.candidate.groups.flatMap((group) => group.evidence),
      ...validated.candidate.placements.flatMap((placement) => placement.evidence),
    ].map((reference) => reference.nodeId),
  );
  const graphEdges = documentGraphEdges(validated.index, targetSet);

  const components: IaComponentScores = {
    evidenceCoverage: percentage(
      validated.targetNodeIds.filter((nodeId) => evidenceNodeIds.has(nodeId)).length,
      validated.targetNodeIds.length,
    ),
    cohesion: cohesionScore(validated.candidate.groups, graphEdges, targetSet),
    separation: separationScore(graphEdges, membership),
    predictability: predictabilityScore(validated, membership, placements),
    balance: balanceScore(validated.candidate.groups),
    stability: percentage(
      validated.targetNodeIds.filter(
        (nodeId) =>
          placements.get(nodeId)?.proposedPath ===
          nodeById(validated.index).get(nodeId)?.sourcePath,
      ).length,
      validated.targetNodeIds.length,
    ),
    duplication: percentage(
      validated.targetNodeIds.filter((nodeId) => membership.get(nodeId)?.length === 1).length,
      validated.targetNodeIds.length,
    ),
  };

  const total = weightedScore(components, IA_SCORE_WEIGHTS);
  const structuralFindability = weightedScore(components, FINDABILITY_WEIGHTS);
  return {
    candidateId: validated.candidate.id,
    topologyDigest: candidateTopologyDigest(validated.candidate),
    components,
    total,
    structuralFindability,
    eligibility: eligibility(validated, components, membership, placements),
  };
}

/**
 * Digests only structural meaning: candidate/group IDs, labels, evidence order,
 * group order, member order, and placement order do not affect the result.
 */
export function candidateTopologyDigest(candidate: IaScoringCandidate): string {
  return canonicalDigest({
    schemaVersion: 1,
    primaryAxis: candidate.primaryAxis,
    secondaryAxes: [...candidate.secondaryAxes].sort(compareText),
    groups: candidate.groups
      .map((group) => ({
        axis: group.axis,
        canonicalPath: group.canonicalPath,
        memberNodeIds: [...group.memberNodeIds].sort(compareText),
      }))
      .sort(compareCanonical),
    placements: candidate.placements
      .map(({ nodeId, proposedPath }) => ({ nodeId, proposedPath }))
      .sort(compareCanonical),
  });
}

export function compareIaCandidateScores(
  baseline: IaCandidateScore,
  candidate: IaCandidateScore,
): IaScoreComparison {
  const componentDeltas = Object.fromEntries(
    (Object.keys(IA_SCORE_WEIGHTS) as IaScoreComponent[]).map((component) => [
      component,
      rounded(candidate.components[component] - baseline.components[component]),
    ]),
  ) as unknown as IaComponentScores;
  const structuralFindabilityDelta = rounded(
    candidate.structuralFindability - baseline.structuralFindability,
  );
  return {
    baselineCandidateId: baseline.candidateId,
    candidateId: candidate.candidateId,
    baselineTopologyDigest: baseline.topologyDigest,
    candidateTopologyDigest: candidate.topologyDigest,
    topologyChanged: baseline.topologyDigest !== candidate.topologyDigest,
    componentDeltas,
    totalDelta: rounded(candidate.total - baseline.total),
    structuralFindabilityDelta,
    improvesFindability: structuralFindabilityDelta > 0,
    preservesAllUrls: candidate.components.stability === 100,
    candidateEligibility: candidate.eligibility,
  };
}

/** Deterministic recommendation seam. Ineligible candidates are never returned. */
export function selectEligibleCandidate(
  scores: readonly IaCandidateScore[],
): IaCandidateScore | undefined {
  const ids = new Set<string>();
  for (const score of scores) {
    if (ids.has(score.candidateId)) {
      throw new IaScoringError("invalid-candidate", "scores[].candidateId");
    }
    ids.add(score.candidateId);
  }
  return [...scores]
    .filter((score) => score.eligibility.eligible)
    .sort(
      (left, right) =>
        right.total - left.total ||
        right.structuralFindability - left.structuralFindability ||
        compareText(left.topologyDigest, right.topologyDigest) ||
        compareText(left.candidateId, right.candidateId),
    )[0];
}

function validateScoringInput(input: IaScoringInput): IaScoringInput {
  validateIndex(input.index);
  id(input.candidate.id, "candidate.id");
  if (!ORGANIZING_AXIS_SET.has(input.candidate.primaryAxis)) {
    fail("invalid-candidate", "candidate.primaryAxis");
  }
  unique(input.candidate.secondaryAxes, "candidate.secondaryAxes", "invalid-candidate");
  if (
    input.candidate.secondaryAxes.includes(input.candidate.primaryAxis) ||
    input.candidate.secondaryAxes.some((axis) => !ORGANIZING_AXIS_SET.has(axis))
  ) {
    fail("invalid-candidate", "candidate.secondaryAxes");
  }
  if (input.targetNodeIds.length === 0) fail("invalid-target", "targetNodeIds");
  unique(input.targetNodeIds, "targetNodeIds", "invalid-target");
  const nodes = nodeById(input.index);
  for (const [index, nodeId] of input.targetNodeIds.entries()) {
    const node = nodes.get(nodeId);
    if (!node || node.kind !== "document") fail("invalid-target", `targetNodeIds[${index}]`);
  }
  if (input.candidate.groups.length === 0) fail("invalid-candidate", "candidate.groups");
  unique(
    input.candidate.groups.map((group) => group.id),
    "candidate.groups[].id",
    "invalid-candidate",
  );
  const targets = new Set(input.targetNodeIds);
  for (const [groupIndex, group] of input.candidate.groups.entries()) {
    id(group.id, `candidate.groups[${groupIndex}].id`);
    if (!ORGANIZING_AXIS_SET.has(group.axis)) {
      fail("invalid-candidate", `candidate.groups[${groupIndex}].axis`);
    }
    safePath(group.canonicalPath, `candidate.groups[${groupIndex}].canonicalPath`);
    if (group.memberNodeIds.length === 0) {
      fail("invalid-candidate", `candidate.groups[${groupIndex}].memberNodeIds`);
    }
    unique(
      group.memberNodeIds,
      `candidate.groups[${groupIndex}].memberNodeIds`,
      "invalid-candidate",
    );
    for (const [memberIndex, nodeId] of group.memberNodeIds.entries()) {
      if (!targets.has(nodeId)) {
        fail("invalid-target", `candidate.groups[${groupIndex}].memberNodeIds[${memberIndex}]`);
      }
    }
    validateEvidence(group.evidence, input.index, `candidate.groups[${groupIndex}].evidence`);
  }
  unique(
    input.candidate.placements.map((placement) => placement.nodeId),
    "candidate.placements[].nodeId",
    "invalid-candidate",
  );
  for (const [index, placement] of input.candidate.placements.entries()) {
    if (!targets.has(placement.nodeId)) {
      fail("invalid-target", `candidate.placements[${index}].nodeId`);
    }
    safePath(placement.proposedPath, `candidate.placements[${index}].proposedPath`);
    validateEvidence(placement.evidence, input.index, `candidate.placements[${index}].evidence`);
  }
  validateEvidence(input.candidate.evidence, input.index, "candidate.evidence");
  return input;
}

function validateIndex(index: ContentIndex): void {
  try {
    decodeContentIndex(index);
  } catch (error) {
    fail("invalid-index", error instanceof ContentIndexDecodeError ? error.path : "index");
  }
}

function validateEvidence(
  evidence: readonly ArtifactEvidence[],
  index: ContentIndex,
  path: string,
): void {
  const nodes = nodeById(index);
  for (const [evidenceIndex, reference] of evidence.entries()) {
    safePath(reference.path, `${path}[${evidenceIndex}].path`);
    const node = nodes.get(reference.nodeId);
    if (!node || node.sourcePath !== reference.path) {
      fail("invalid-evidence", `${path}[${evidenceIndex}]`);
    }
  }
}

function eligibility(
  input: IaScoringInput,
  components: IaComponentScores,
  membership: ReadonlyMap<string, readonly string[]>,
  placements: ReadonlyMap<string, IaPathPlacement>,
): IaEligibility {
  const reasons: IaIneligibilityReason[] = [];
  if (components.evidenceCoverage < 100) reasons.push("insufficient-evidence");
  if (input.targetNodeIds.some((nodeId) => !membership.has(nodeId))) {
    reasons.push("incomplete-placement");
  }
  if (input.targetNodeIds.some((nodeId) => (membership.get(nodeId)?.length ?? 0) > 1)) {
    reasons.push("ambiguous-placement");
  }
  const declaredAxes = new Set([input.candidate.primaryAxis, ...input.candidate.secondaryAxes]);
  if (input.candidate.groups.some((group) => !declaredAxes.has(group.axis))) {
    reasons.push("mixed-axis");
  }
  if (input.targetNodeIds.some((nodeId) => !placements.has(nodeId))) {
    reasons.push("incomplete-path-plan");
  }
  const proposedPaths = input.candidate.placements.map((placement) => placement.proposedPath);
  const groupPaths = input.candidate.groups.map((group) => group.canonicalPath);
  if (
    new Set(proposedPaths).size !== proposedPaths.length ||
    new Set(groupPaths).size !== groupPaths.length
  )
    reasons.push("path-collision");
  return reasons.length === 0 ? { eligible: true, reasons: [] } : { eligible: false, reasons };
}

function memberships(
  groups: readonly IaTopologyGroup[],
  targets: ReadonlySet<string>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const group of groups) {
    const topologyKey = canonicalDigest({
      axis: group.axis,
      canonicalPath: group.canonicalPath,
      members: [...group.memberNodeIds].sort(compareText),
    });
    for (const nodeId of group.memberNodeIds) {
      if (!targets.has(nodeId)) continue;
      result.set(nodeId, [...(result.get(nodeId) ?? []), topologyKey]);
    }
  }
  return result;
}

function documentGraphEdges(
  index: ContentIndex,
  targets: ReadonlySet<string>,
): Array<readonly [string, string]> {
  const nodes = nodeById(index);
  const documents = new Map<string, string>();
  for (const node of index.nodes) {
    documents.set(node.id, node.kind === "document" ? node.id : node.documentId);
  }
  const uniqueEdges = new Map<string, readonly [string, string]>();
  for (const edge of index.edges) {
    if (edge.kind === "asset-link") continue;
    if (!GRAPH_EDGE_KINDS.has(edge.kind) || !nodes.has(edge.from) || !nodes.has(edge.to)) continue;
    const from = documents.get(edge.from);
    const to = documents.get(edge.to);
    if (!from || !to || from === to || !targets.has(from) || !targets.has(to)) continue;
    const pair: readonly [string, string] = compareText(from, to) <= 0 ? [from, to] : [to, from];
    uniqueEdges.set(`${pair[0]}\u0000${pair[1]}`, pair);
  }
  return [...uniqueEdges.values()].sort((left, right) => compareCanonical(left, right));
}

function cohesionScore(
  groups: readonly IaTopologyGroup[],
  edges: readonly (readonly [string, string])[],
  targets: ReadonlySet<string>,
): number {
  let numerator = 0;
  let denominator = 0;
  for (const group of groups) {
    const members = [...new Set(group.memberNodeIds.filter((member) => targets.has(member)))];
    denominator += members.length;
    if (members.length <= 1) {
      numerator += members.length;
      continue;
    }
    const memberSet = new Set(members);
    const adjacency = new Map(members.map((member) => [member, new Set<string>()]));
    for (const [from, to] of edges) {
      if (!memberSet.has(from) || !memberSet.has(to)) continue;
      adjacency.get(from)?.add(to);
      adjacency.get(to)?.add(from);
    }
    const components = connectedComponentCount(members, adjacency);
    numerator += members.length * ((members.length - components) / (members.length - 1));
  }
  return percentage(numerator, denominator);
}

function separationScore(
  edges: readonly (readonly [string, string])[],
  membership: ReadonlyMap<string, readonly string[]>,
): number {
  if (edges.length === 0) return 100;
  let separated = 0;
  for (const [from, to] of edges) {
    const fromGroups = membership.get(from) ?? [];
    const toGroups = new Set(membership.get(to) ?? []);
    if (fromGroups.some((group) => toGroups.has(group))) separated += 1;
  }
  return percentage(separated, edges.length);
}

function predictabilityScore(
  input: IaScoringInput,
  membership: ReadonlyMap<string, readonly string[]>,
  placements: ReadonlyMap<string, IaPathPlacement>,
): number {
  const axisConsistency = percentage(
    input.candidate.groups.filter((group) => group.axis === input.candidate.primaryAxis).length,
    input.candidate.groups.length,
  );
  const placementCompleteness = percentage(
    input.targetNodeIds.filter((nodeId) => membership.has(nodeId) && placements.has(nodeId)).length,
    input.targetNodeIds.length,
  );
  const proposed = [...placements.values()].map((placement) => placement.proposedPath);
  const pathUniqueness = percentage(new Set(proposed).size, proposed.length);
  return rounded(axisConsistency * 0.4 + placementCompleteness * 0.3 + pathUniqueness * 0.3);
}

function balanceScore(groups: readonly IaTopologyGroup[]): number {
  if (groups.length <= 1) return 100;
  const sizes = groups.map((group) => group.memberNodeIds.length);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total === 0) return 0;
  const entropy = -sizes.reduce((sum, size) => {
    const probability = size / total;
    return sum + (probability === 0 ? 0 : probability * Math.log(probability));
  }, 0);
  return bounded((100 * entropy) / Math.log(groups.length));
}

function weightedScore(
  components: IaComponentScores,
  weights: Readonly<Partial<Record<IaScoreComponent, number>>>,
): number {
  const entries = Object.entries(weights) as Array<[IaScoreComponent, number]>;
  const weightTotal = entries.reduce((sum, [, weight]) => sum + weight, 0);
  return bounded(
    entries.reduce((sum, [component, weight]) => sum + components[component] * weight, 0) /
      weightTotal,
  );
}

function connectedComponentCount(
  members: readonly string[],
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): number {
  const unseen = new Set(members);
  let count = 0;
  while (unseen.size > 0) {
    count += 1;
    const root = unseen.values().next().value as string;
    unseen.delete(root);
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!unseen.delete(neighbor)) continue;
        stack.push(neighbor);
      }
    }
  }
  return count;
}

function nodeById(index: ContentIndex): Map<string, ContentNode> {
  return new Map(index.nodes.map((node) => [node.id, node]));
}

function percentage(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : bounded((100 * numerator) / denominator);
}

function bounded(value: number): number {
  return rounded(Math.max(0, Math.min(100, value)));
}

function rounded(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCanonical(left: unknown, right: unknown): number {
  return compareText(JSON.stringify(left), JSON.stringify(right));
}

function id(value: string, path: string): void {
  if (value.length === 0 || value !== value.trim() || value !== value.normalize("NFC")) {
    fail("invalid-candidate", path);
  }
}

function safePath(value: string, path: string): void {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    fail("unsafe-path", path);
}

function unique(
  values: readonly string[],
  path: string,
  code: "invalid-index" | "invalid-candidate" | "invalid-target",
): void {
  if (new Set(values).size !== values.length) fail(code, path);
}

function fail(code: IaScoringError["code"], path: string): never {
  throw new IaScoringError(code, path);
}
