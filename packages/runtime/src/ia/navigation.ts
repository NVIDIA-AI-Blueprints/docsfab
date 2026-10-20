// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  NavigationEvaluationPayload,
  NavigationMetrics,
  NavigationOutcome,
  NavigationResult,
  NavigationTask,
} from "../artifacts/contracts.js";
import { recomputeNavigationMetrics } from "../artifacts/validate.js";
import { canonicalDigest } from "../content-ir/canonical.js";
import type { ContentIndexV1, ContentNode } from "../content-ir/contracts.js";

export const NAVIGATION_CASE_KINDS = [
  "routine-task",
  "reference-lookup",
  "troubleshooting",
  "ambiguous-placement",
  "expected-no-result",
] as const;

export type NavigationCaseKind = (typeof NAVIGATION_CASE_KINDS)[number];

export interface NavigationDestinationExpectation {
  nodeId: string;
  /** Repository-relative public documentation URL, without a fragment. */
  url: string;
  /** An exact anchor expectation. `null` explicitly means the page root. */
  anchor: string | null;
}

export interface VersionedNavigationCase {
  id: string;
  kind: NavigationCaseKind;
  query: string;
  expected: NavigationDestinationExpectation[];
  acceptableAlternatives: NavigationDestinationExpectation[];
}

export interface VersionedNavigationSuite {
  schemaVersion: 1;
  id: string;
  version: string;
  cases: VersionedNavigationCase[];
}

export interface NavigationRankCandidate extends NavigationDestinationExpectation {
  /** A deterministic retrieval score. Larger values rank first. */
  score: number;
}

export type NavigationRankings = Readonly<Record<string, readonly NavigationRankCandidate[]>>;

export type NavigationFailureReason =
  | "ambiguous-placement-not-observed"
  | "expected-destination-not-first"
  | "location-mismatch"
  | "multiple-accepted-destinations"
  | "unexpected-result";

export interface NavigationCaseEvaluation {
  id: string;
  kind: NavigationCaseKind;
  task: NavigationTask;
  result: NavigationResult;
  rankedDestinations: NavigationDestinationExpectation[];
  deterministicPass: boolean;
  failureReasons: NavigationFailureReason[];
}

export interface VersionedNavigationEvaluation {
  schemaVersion: 1;
  suite: { id: string; version: string };
  index: {
    repositoryRevision: string;
    repositoryContentDigest: string;
    indexDigest: string;
  };
  navigation: NavigationEvaluationPayload;
  cases: NavigationCaseEvaluation[];
  deterministicPass: boolean;
  digest: string;
}

export interface NavigationCaseComparison {
  id: string;
  kind: NavigationCaseKind;
  currentOutcome: NavigationOutcome;
  proposedOutcome: NavigationOutcome;
  currentPass: boolean;
  proposedPass: boolean;
  change: "improved" | "regressed" | "unchanged-pass" | "unchanged-fail";
}

export interface NavigationComparison {
  schemaVersion: 1;
  suite: { id: string; version: string };
  index: VersionedNavigationEvaluation["index"];
  current: VersionedNavigationEvaluation;
  proposed: VersionedNavigationEvaluation;
  metricDeltas: NavigationMetrics;
  cases: NavigationCaseComparison[];
  deterministicPass: boolean;
  digest: string;
}

export interface NavigationJudgeRequest {
  schemaVersion: 1;
  /** Digests only: caller-controlled suite text never reaches the judge. */
  suite: { id: string; version: string };
  comparisonDigest: string;
  metricDeltas: NavigationMetrics;
  cases: Array<{
    id: string;
    kind: NavigationCaseKind;
    currentOutcome: NavigationOutcome;
    proposedOutcome: NavigationOutcome;
    currentPass: boolean;
    proposedPass: boolean;
  }>;
}

export interface NavigationJudge {
  evaluate(request: NavigationJudgeRequest): Promise<{ agrees: boolean }>;
}

export type NavigationJudgeDisposition =
  | { status: "not-run"; reason: "not-configured" | "deterministic-failed" }
  | { status: "agreed" }
  | { status: "disagreed" }
  | { status: "failed" };

export interface JudgedNavigationComparison {
  comparison: NavigationComparison;
  judge: NavigationJudgeDisposition;
  /** Always copied from the deterministic comparison, never from the judge. */
  deterministicPass: boolean;
}

/**
 * Orders retrieval candidates without relying on input array order. Exact ties
 * use only stable evidence fields, so labels and presentation order are inert.
 */
export function rankNavigationCandidates(
  candidates: readonly NavigationRankCandidate[],
): NavigationRankCandidate[] {
  const validated = candidates.map((candidate, index) => validateRankCandidate(candidate, index));
  const locations = new Set<string>();
  const nodeIds = new Set<string>();
  for (const candidate of validated) {
    const key = destinationKey(candidate);
    if (locations.has(key)) throw new Error(`Duplicate navigation candidate: ${key}.`);
    if (nodeIds.has(candidate.nodeId))
      throw new Error(`Duplicate ranked navigation node: ${candidate.nodeId}.`);
    locations.add(key);
    nodeIds.add(candidate.nodeId);
  }
  return validated.sort(
    (left, right) =>
      right.score - left.score ||
      compareText(left.nodeId, right.nodeId) ||
      compareText(left.url, right.url) ||
      compareText(left.anchor ?? "", right.anchor ?? ""),
  );
}

/** Produces a deterministic, version-bound known-answer evaluation. */
export function evaluateNavigationSuite(
  suiteValue: VersionedNavigationSuite,
  rankings: NavigationRankings,
  index: ContentIndexV1,
): VersionedNavigationEvaluation {
  const suite = validateNavigationSuiteAgainstIndex(suiteValue, index);
  const knownCaseIds = new Set(suite.cases.map((entry) => entry.id));
  for (const suppliedId of Object.keys(rankings)) {
    if (!knownCaseIds.has(suppliedId))
      throw new Error(`Unknown navigation case ranking: ${suppliedId}.`);
  }
  validateRankingsAgainstIndex(suite, rankings, index);

  const cases = suite.cases.map((entry) => evaluateCase(entry, rankings[entry.id] ?? []));
  const navigation: NavigationEvaluationPayload = {
    tasks: cases.map((entry) => entry.task),
    results: cases.map((entry) => entry.result),
    metrics: recomputeNavigationMetrics({
      tasks: cases.map((entry) => entry.task),
      results: cases.map((entry) => entry.result),
    }),
  };
  const deterministicPass = cases.every((entry) => entry.deterministicPass);
  const value = {
    schemaVersion: 1 as const,
    suite: { id: suite.id, version: suite.version },
    index: {
      repositoryRevision: index.repository.revision,
      repositoryContentDigest: index.repository.contentDigest,
      indexDigest: index.indexDigest,
    },
    navigation,
    cases,
    deterministicPass,
  };
  return { ...value, digest: canonicalDigest(value) };
}

/** Evaluates both structures under one exact suite and reports stable deltas. */
export function compareNavigationStructures(
  suite: VersionedNavigationSuite,
  currentRankings: NavigationRankings,
  proposedRankings: NavigationRankings,
  index: ContentIndexV1,
): NavigationComparison {
  const current = evaluateNavigationSuite(suite, currentRankings, index);
  const proposed = evaluateNavigationSuite(suite, proposedRankings, index);
  const cases = proposed.cases.map((proposedCase) => {
    const currentCase = current.cases.find((entry) => entry.id === proposedCase.id)!;
    return {
      id: proposedCase.id,
      kind: proposedCase.kind,
      currentOutcome: currentCase.result.outcome,
      proposedOutcome: proposedCase.result.outcome,
      currentPass: currentCase.deterministicPass,
      proposedPass: proposedCase.deterministicPass,
      change: comparisonChange(currentCase.deterministicPass, proposedCase.deterministicPass),
    };
  });
  const metricDeltas = subtractMetrics(current.navigation.metrics, proposed.navigation.metrics);
  const value = {
    schemaVersion: 1 as const,
    suite: proposed.suite,
    index: proposed.index,
    current,
    proposed,
    metricDeltas,
    cases,
    deterministicPass: proposed.deterministicPass,
  };
  return { ...value, digest: canonicalDigest(value) };
}

/** Binds all expected evidence to one exact structural index revision. */
export function validateNavigationSuiteAgainstIndex(
  suiteValue: VersionedNavigationSuite,
  index: ContentIndexV1,
): VersionedNavigationSuite {
  const suite = validateSuite(suiteValue);
  const nodes = navigationNodeMap(index);
  for (const entry of suite.cases) {
    for (const destination of [...entry.expected, ...entry.acceptableAlternatives]) {
      validateDestinationAgainstIndex(destination, nodes, `case ${entry.id}`);
    }
  }
  return suite;
}

/** Maps a source file to DocsFab's explicit extensionless documentation URL. */
export function documentationUrlForSourcePath(sourcePath: string): string {
  const withoutDocs = sourcePath.startsWith("docs/")
    ? sourcePath.slice("docs/".length)
    : sourcePath;
  const withoutExtension = withoutDocs.replace(/\.(?:md|mdx)$/u, "");
  const withoutIndex =
    withoutExtension === "index"
      ? ""
      : withoutExtension.endsWith("/index")
        ? withoutExtension.slice(0, -"/index".length)
        : withoutExtension;
  return `/${withoutIndex}`;
}

/**
 * Runs an advisory semantic judge only after the proposed structure passes.
 * Its input omits queries, scores, node IDs, URLs, anchors, and repository text.
 */
export async function runOptionalNavigationJudge(
  comparison: NavigationComparison,
  judge?: NavigationJudge,
): Promise<JudgedNavigationComparison> {
  if (!comparison.deterministicPass) {
    return {
      comparison,
      judge: { status: "not-run", reason: "deterministic-failed" },
      deterministicPass: comparison.deterministicPass,
    };
  }
  if (!judge) {
    return {
      comparison,
      judge: { status: "not-run", reason: "not-configured" },
      deterministicPass: comparison.deterministicPass,
    };
  }
  const request: NavigationJudgeRequest = {
    schemaVersion: 1,
    suite: {
      id: canonicalDigest({ id: comparison.suite.id }),
      version: canonicalDigest({ version: comparison.suite.version }),
    },
    comparisonDigest: comparison.digest,
    metricDeltas: comparison.metricDeltas,
    cases: comparison.cases.map((entry) => ({
      id: canonicalDigest({ id: entry.id }),
      kind: entry.kind,
      currentOutcome: entry.currentOutcome,
      proposedOutcome: entry.proposedOutcome,
      currentPass: entry.currentPass,
      proposedPass: entry.proposedPass,
    })),
  };
  try {
    const response = await judge.evaluate(request);
    if (!response || typeof response.agrees !== "boolean")
      throw new Error("Invalid judge response.");
    return {
      comparison,
      judge: { status: response.agrees ? "agreed" : "disagreed" },
      deterministicPass: comparison.deterministicPass,
    };
  } catch {
    return {
      comparison,
      judge: { status: "failed" },
      deterministicPass: comparison.deterministicPass,
    };
  }
}

function evaluateCase(
  entry: VersionedNavigationCase,
  supplied: readonly NavigationRankCandidate[],
): NavigationCaseEvaluation {
  const ranked = rankNavigationCandidates(supplied);
  const expectedNodeIds = entry.expected.map((destination) => destination.nodeId);
  const acceptableNodeIds = entry.acceptableAlternatives.map((destination) => destination.nodeId);
  const task: NavigationTask = {
    id: entry.id,
    query: entry.query,
    expectedNodeIds,
    acceptableNodeIds,
  };
  const rankedNodeIds = ranked.map((candidate) => candidate.nodeId);
  const result: NavigationResult = {
    taskId: entry.id,
    rankedNodeIds,
    outcome: deriveOutcome(task, rankedNodeIds),
  };
  const accepted = [...entry.expected, ...entry.acceptableAlternatives];
  const exactAcceptedInTopThree = ranked
    .slice(0, 3)
    .filter((candidate) => accepted.some((destination) => sameDestination(destination, candidate)));
  const nodeAcceptedInTopThree = ranked
    .slice(0, 3)
    .filter((candidate) => accepted.some((destination) => destination.nodeId === candidate.nodeId));
  const failureReasons: NavigationFailureReason[] = [];

  if (entry.kind === "expected-no-result") {
    if (ranked.length > 0) failureReasons.push("unexpected-result");
  } else if (entry.kind === "ambiguous-placement") {
    if (new Set(exactAcceptedInTopThree.map((candidate) => destinationKey(candidate))).size < 2) {
      failureReasons.push("ambiguous-placement-not-observed");
    }
    if (nodeAcceptedInTopThree.length > exactAcceptedInTopThree.length) {
      failureReasons.push("location-mismatch");
    }
  } else {
    const first = ranked[0];
    if (!first || !accepted.some((destination) => sameDestination(destination, first))) {
      failureReasons.push("expected-destination-not-first");
    }
    if (
      first &&
      accepted.some((destination) => destination.nodeId === first.nodeId) &&
      !accepted.some((destination) => sameDestination(destination, first))
    ) {
      failureReasons.push("location-mismatch");
    }
    if (new Set(exactAcceptedInTopThree.map((candidate) => candidate.nodeId)).size > 1) {
      failureReasons.push("multiple-accepted-destinations");
    }
  }

  return {
    id: entry.id,
    kind: entry.kind,
    task,
    result,
    rankedDestinations: ranked.map(({ nodeId, url, anchor }) => ({ nodeId, url, anchor })),
    deterministicPass: failureReasons.length === 0,
    failureReasons,
  };
}

function validateSuite(value: VersionedNavigationSuite): VersionedNavigationSuite {
  if (!value || value.schemaVersion !== 1)
    throw new Error("Unsupported navigation suite schema version.");
  const id = normalizedText(value.id, "suite id");
  const version = normalizedText(value.version, "suite version");
  if (!Array.isArray(value.cases)) throw new Error("Navigation suite cases must be an array.");
  const ids = new Set<string>();
  const kinds = new Set<NavigationCaseKind>();
  const cases = value.cases
    .map((entry, index) => {
      const validated = validateCase(entry, index);
      if (ids.has(validated.id)) throw new Error(`Duplicate navigation case: ${validated.id}.`);
      ids.add(validated.id);
      kinds.add(validated.kind);
      return validated;
    })
    .sort((left, right) => compareText(left.id, right.id));
  for (const kind of NAVIGATION_CASE_KINDS) {
    if (!kinds.has(kind)) throw new Error(`Navigation suite is missing a ${kind} case.`);
  }
  return { schemaVersion: 1, id, version, cases };
}

function validateCase(value: VersionedNavigationCase, index: number): VersionedNavigationCase {
  if (!value || typeof value !== "object")
    throw new Error(`Invalid navigation case at index ${index}.`);
  const id = normalizedText(value.id, `case ${index} id`);
  const query = normalizedText(value.query, `case ${id} query`);
  if (!NAVIGATION_CASE_KINDS.includes(value.kind))
    throw new Error(`Invalid navigation case kind: ${String(value.kind)}.`);
  if (!Array.isArray(value.expected) || !Array.isArray(value.acceptableAlternatives)) {
    throw new Error(`Navigation case ${id} must declare expected destinations and alternatives.`);
  }
  const expected = value.expected
    .map((entry, destinationIndex) =>
      validateDestination(entry, `${id}.expected[${destinationIndex}]`),
    )
    .sort(compareDestinations);
  const acceptableAlternatives = value.acceptableAlternatives
    .map((entry, destinationIndex) =>
      validateDestination(entry, `${id}.acceptableAlternatives[${destinationIndex}]`),
    )
    .sort(compareDestinations);
  const destinations = [...expected, ...acceptableAlternatives];
  if (new Set(destinations.map(destinationKey)).size !== destinations.length) {
    throw new Error(`Navigation case ${id} has duplicate destinations.`);
  }
  if (new Set(destinations.map((destination) => destination.nodeId)).size !== destinations.length) {
    throw new Error(`Navigation case ${id} has duplicate destination node IDs.`);
  }
  if (value.kind === "expected-no-result" && destinations.length !== 0) {
    throw new Error(`Expected-no-result case ${id} cannot declare destinations.`);
  }
  if (value.kind === "ambiguous-placement" && destinations.length < 2) {
    throw new Error(`Ambiguous-placement case ${id} requires at least two destinations.`);
  }
  if (
    value.kind !== "expected-no-result" &&
    value.kind !== "ambiguous-placement" &&
    expected.length === 0
  ) {
    throw new Error(`Navigation case ${id} requires an expected destination.`);
  }
  return { id, kind: value.kind, query, expected, acceptableAlternatives };
}

function validateRankCandidate(
  value: NavigationRankCandidate,
  index: number,
): NavigationRankCandidate {
  const destination = validateDestination(value, `ranking[${index}]`);
  if (typeof value.score !== "number" || !Number.isFinite(value.score)) {
    throw new Error(`Navigation ranking score at index ${index} must be finite.`);
  }
  return { ...destination, score: value.score };
}

function validateRankingsAgainstIndex(
  suite: VersionedNavigationSuite,
  rankings: NavigationRankings,
  index: ContentIndexV1,
): void {
  const nodes = navigationNodeMap(index);
  for (const entry of suite.cases) {
    for (const [rank, destination] of (rankings[entry.id] ?? []).entries()) {
      validateDestinationAgainstIndex(destination, nodes, `ranking ${entry.id}[${rank}]`);
    }
  }
}

function navigationNodeMap(index: ContentIndexV1): ReadonlyMap<string, ContentNode> {
  if (!index || index.schemaVersion !== 1 || !Array.isArray(index.nodes)) {
    throw new Error("Invalid content index for navigation evidence.");
  }
  const nodes = new Map<string, ContentNode>();
  for (const node of index.nodes) {
    if (nodes.has(node.id)) throw new Error(`Duplicate content-index node: ${node.id}.`);
    nodes.set(node.id, node);
  }
  return nodes;
}

function validateDestinationAgainstIndex(
  destination: NavigationDestinationExpectation,
  nodes: ReadonlyMap<string, ContentNode>,
  path: string,
): void {
  const node = nodes.get(destination.nodeId);
  if (!node) throw new Error(`Unknown navigation node at ${path}: ${destination.nodeId}.`);
  const expectedUrl = documentationUrlForSourcePath(node.sourcePath);
  if (destination.url !== expectedUrl) {
    throw new Error(`Navigation URL mismatch at ${path}: expected ${expectedUrl}.`);
  }
  if (node.kind === "section") {
    if (destination.anchor !== node.anchor) {
      throw new Error(`Navigation anchor mismatch at ${path}: expected ${node.anchor}.`);
    }
  } else if (destination.anchor !== null && !node.anchors.includes(destination.anchor)) {
    throw new Error(`Unknown navigation anchor at ${path}: ${destination.anchor}.`);
  }
}

function validateDestination(
  value: NavigationDestinationExpectation,
  path: string,
): NavigationDestinationExpectation {
  if (!value || typeof value !== "object")
    throw new Error(`Invalid navigation destination at ${path}.`);
  const nodeId = normalizedText(value.nodeId, `${path}.nodeId`);
  const url = normalizedText(value.url, `${path}.url`);
  if (!url.startsWith("/") || url.includes("#")) {
    throw new Error(
      `Navigation destination URL at ${path} must be root-relative and fragment-free.`,
    );
  }
  if (
    value.anchor !== null &&
    (typeof value.anchor !== "string" ||
      value.anchor.length === 0 ||
      value.anchor !== value.anchor.normalize("NFC") ||
      value.anchor.startsWith("#"))
  ) {
    throw new Error(`Invalid navigation anchor at ${path}.`);
  }
  return { nodeId, url, anchor: value.anchor };
}

function normalizedText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.normalize("NFC")) {
    throw new Error(`Invalid ${field}.`);
  }
  return value;
}

function deriveOutcome(task: NavigationTask, rankedNodeIds: readonly string[]): NavigationOutcome {
  if (rankedNodeIds.length === 0) return "no-result";
  const accepted = new Set([...task.expectedNodeIds, ...task.acceptableNodeIds]);
  const acceptedResults = new Set(rankedNodeIds.filter((nodeId) => accepted.has(nodeId)));
  if (acceptedResults.size > 1) return "ambiguous";
  return acceptedResults.size === 1 ? "matched" : "missed";
}

function sameDestination(
  left: NavigationDestinationExpectation,
  right: NavigationDestinationExpectation,
): boolean {
  return destinationKey(left) === destinationKey(right);
}

function destinationKey(destination: NavigationDestinationExpectation): string {
  return `${destination.nodeId}\u0000${destination.url}\u0000${destination.anchor ?? ""}`;
}

function compareDestinations(
  left: NavigationDestinationExpectation,
  right: NavigationDestinationExpectation,
): number {
  return compareText(destinationKey(left), destinationKey(right));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparisonChange(
  currentPass: boolean,
  proposedPass: boolean,
): NavigationCaseComparison["change"] {
  if (!currentPass && proposedPass) return "improved";
  if (currentPass && !proposedPass) return "regressed";
  return proposedPass ? "unchanged-pass" : "unchanged-fail";
}

function subtractMetrics(
  current: NavigationMetrics,
  proposed: NavigationMetrics,
): NavigationMetrics {
  return {
    taskCount: proposed.taskCount - current.taskCount,
    agreementRate: proposed.agreementRate - current.agreementRate,
    recallAt3: proposed.recallAt3 - current.recallAt3,
    meanReciprocalRank: proposed.meanReciprocalRank - current.meanReciprocalRank,
    noResultRate: proposed.noResultRate - current.noResultRate,
    ambiguousPlacementRate: proposed.ambiguousPlacementRate - current.ambiguousPlacementRate,
  };
}
