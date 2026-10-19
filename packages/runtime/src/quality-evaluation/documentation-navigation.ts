// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit } from "../contract-kit/index.js";
import { isRecord } from "../shared/primitives.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,127}$/u;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*[\0-\x1f\x7f\\])[^/]+(?:\/[^/]+)*$/u;

const { assertInert } = createContractKit({
  fail: invalidFixture,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-fixture",
    invalidValue: "invalid-fixture",
    digestMismatch: "invalid-fixture",
    credentialMaterial: "invalid-fixture",
    schemaMismatch: "migration-required",
  },
});

export interface DocumentationNavigationQueryV1 {
  id: string;
  query: string;
  expectedPaths: string[];
}

export interface DocumentationNavigationFixtureV1 {
  schemaVersion: 1;
  kind: "docsfab-documentation-navigation-fixture";
  version: string;
  recallAtK: 3;
  minimumRecall: number;
  queries: DocumentationNavigationQueryV1[];
}

export interface DocumentationNavigationQueryResultV1 {
  id: string;
  rankedPaths: string[];
  recalled: boolean;
}

export interface DocumentationNavigationEvaluationV1 {
  schemaVersion: 1;
  fixture: { kind: DocumentationNavigationFixtureV1["kind"]; version: string };
  recallAtK: 3;
  minimumRecall: number;
  recalledQueries: number;
  queryCount: number;
  recall: number;
  passed: boolean;
  results: DocumentationNavigationQueryResultV1[];
}

/**
 * Evaluates supplied deterministic rankings against the checked-in IA fixture.
 * A query is recalled when any canonical expected path appears in its top three
 * results; the suite passes only at the fixture's declared Recall@3 threshold.
 */
export function evaluateDocumentationNavigationFixture(
  fixtureValue: unknown,
  rankings: Readonly<Record<string, readonly string[]>>,
): DocumentationNavigationEvaluationV1 {
  const fixture = decodeDocumentationNavigationFixture(fixtureValue);
  const knownIds = new Set(fixture.queries.map((query) => query.id));
  for (const id of Object.keys(rankings)) {
    if (!knownIds.has(id)) invalidFixture();
  }
  const results = fixture.queries.map((query) => {
    const rankedPaths = [...(rankings[query.id] ?? [])];
    if (
      rankedPaths.some((path) => !SAFE_PATH.test(path)) ||
      new Set(rankedPaths).size !== rankedPaths.length
    )
      invalidFixture();
    return {
      id: query.id,
      rankedPaths: rankedPaths.slice(0, fixture.recallAtK),
      recalled: rankedPaths
        .slice(0, fixture.recallAtK)
        .some((path) => query.expectedPaths.includes(path)),
    };
  });
  const recalledQueries = results.filter((result) => result.recalled).length;
  const recall = recalledQueries / results.length;
  return {
    schemaVersion: 1,
    fixture: { kind: fixture.kind, version: fixture.version },
    recallAtK: fixture.recallAtK,
    minimumRecall: fixture.minimumRecall,
    recalledQueries,
    queryCount: results.length,
    recall,
    passed: recall >= fixture.minimumRecall,
    results,
  };
}

export function decodeDocumentationNavigationFixture(
  value: unknown,
): DocumentationNavigationFixtureV1 {
  assertInert(value);
  if (
    !isRecord(value) ||
    keys(value) !== "kind,minimumRecall,queries,recallAtK,schemaVersion,version" ||
    value.schemaVersion !== 1 ||
    value.kind !== "docsfab-documentation-navigation-fixture" ||
    typeof value.version !== "string" ||
    value.version.length === 0 ||
    value.recallAtK !== 3 ||
    typeof value.minimumRecall !== "number" ||
    value.minimumRecall !== 0.8 ||
    !Array.isArray(value.queries) ||
    value.queries.length === 0
  ) {
    invalidFixture();
  }
  const queryIds = new Set<string>();
  const queries = value.queries.map((candidate) => {
    if (
      !isRecord(candidate) ||
      keys(candidate) !== "expectedPaths,id,query" ||
      typeof candidate.id !== "string" ||
      !SAFE_ID.test(candidate.id) ||
      queryIds.has(candidate.id) ||
      typeof candidate.query !== "string" ||
      candidate.query.trim().length === 0 ||
      !Array.isArray(candidate.expectedPaths) ||
      candidate.expectedPaths.length === 0 ||
      candidate.expectedPaths.some((path) => typeof path !== "string" || !SAFE_PATH.test(path)) ||
      new Set(candidate.expectedPaths).size !== candidate.expectedPaths.length
    )
      invalidFixture();
    queryIds.add(candidate.id);
    return {
      id: candidate.id,
      query: candidate.query,
      expectedPaths: [...candidate.expectedPaths],
    };
  });
  return {
    schemaVersion: 1,
    kind: "docsfab-documentation-navigation-fixture",
    version: value.version,
    recallAtK: 3,
    minimumRecall: 0.8,
    queries,
  };
}

function keys(value: Record<string, unknown>): string {
  return Object.keys(value).sort().join(",");
}

function invalidFixture(): never {
  throw new Error("The documentation navigation fixture is invalid or unsafe.");
}
