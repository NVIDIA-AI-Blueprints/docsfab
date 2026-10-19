// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type DiscoveryInvariant =
  | "INV-01"
  | "INV-02"
  | "INV-03"
  | "INV-04"
  | "INV-05"
  | "INV-06"
  | "INV-07";

export interface DiscoveryCase<TInput, TExpected> {
  id: string;
  invariant: DiscoveryInvariant;
  family: string;
  input: TInput;
  expected: TExpected;
}

export interface DiscoveryReplay {
  seed: number;
  path?: string;
  numRuns: number;
}

export interface DiscoveryJunitIdentity {
  file: string;
  suite: string;
  name: string;
}

export interface DiscoveryRunResult {
  id: string;
  invariant: string;
  kind: "property" | "fixed";
  expectedCases: number;
  executedCases: number;
  outcome: "passed" | "failed" | "incomplete";
  boundaryReached: string;
  assertionIds: string[];
  junit: DiscoveryJunitIdentity;
  durationMs: number;
  replay?: DiscoveryReplay;
  counterexampleRef?: string;
  artifactRefs: string[];
}

export interface DiscoveryRunIndex {
  schemaVersion: 1;
  evidenceClass: "deterministic-fixture";
  family: string;
  profile: "gate" | "replay";
  identity: {
    sourceRevision: string;
    sourceTree: string;
    workingDiffSha256: string;
    generatedInputsSha256: string;
    fixtureSha256: string;
    generatorRevision: string;
    nodeVersion: string;
    vitestVersion: string;
    fastCheckVersion: string;
  };
  expected: DiscoveryRunCounts;
  executed: DiscoveryRunCounts;
  outcome: "passed" | "failed" | "incomplete";
  durationMs: number;
  results: DiscoveryRunResult[];
}

export interface DiscoveryRunCounts {
  properties: number;
  generatedCases: number;
  fixedCases: number;
}

export interface DiscoveryExpectedResult {
  id: string;
  invariant: DiscoveryInvariant;
  kind: "property" | "fixed";
  requiredCases: number;
  junit: DiscoveryJunitIdentity;
  requiredAssertionIds: string[];
}

export interface DiscoveryExpectedManifest {
  family: string;
  results: DiscoveryExpectedResult[];
}

const IDENTITY_FIELDS = [
  "sourceRevision",
  "sourceTree",
  "workingDiffSha256",
  "generatedInputsSha256",
  "fixtureSha256",
  "generatorRevision",
  "nodeVersion",
  "vitestVersion",
  "fastCheckVersion",
] as const;

function fail(field: string, detail: string): never {
  throw new Error(`invalid discovery run index at ${field}: ${detail}`);
}

function requireNonemptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(field, "must be a non-empty string");
  }
}

function requireNonnegativeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    fail(field, "must be a nonnegative integer");
  }
}

function requireInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isInteger(value)) {
    fail(field, "must be an integer");
  }
}

function requireNonnegativeNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(field, "must be a nonnegative finite number");
  }
}

function requirePositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    fail(field, "must be a positive integer");
  }
}

function requireSafeRelativeRef(value: unknown, field: string): asserts value is string {
  requireNonemptyString(value, field);
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes("\0") ||
    value.split(/[\\/]/u).some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(field, "must stay lexically below the report root");
  }
}

function requireStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value)) {
    fail(field, "must be an array");
  }
  for (const [position, item] of value.entries()) {
    requireNonemptyString(item, `${field}[${position}]`);
  }
}

function requireJunitIdentity(
  value: unknown,
  field: string,
): asserts value is DiscoveryJunitIdentity {
  if (typeof value !== "object" || value === null) {
    fail(field, "must be an object");
  }
  const junit = value as Record<string, unknown>;
  requireSafeRelativeRef(junit.file, `${field}.file`);
  requireNonemptyString(junit.suite, `${field}.suite`);
  requireNonemptyString(junit.name, `${field}.name`);
}

function requireCounts(value: unknown, field: string): asserts value is DiscoveryRunCounts {
  if (typeof value !== "object" || value === null) {
    fail(field, "must be an object");
  }
  const counts = value as Record<string, unknown>;
  requireNonnegativeInteger(counts.properties, `${field}.properties`);
  requireNonnegativeInteger(counts.generatedCases, `${field}.generatedCases`);
  requireNonnegativeInteger(counts.fixedCases, `${field}.fixedCases`);
}

function requireEqual(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) {
    fail(field, `expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function requireValidManifest(
  manifest: DiscoveryExpectedManifest,
): Map<string, DiscoveryExpectedResult> {
  requireNonemptyString(manifest.family, "expectedManifest.family");
  if (!Array.isArray(manifest.results) || manifest.results.length === 0) {
    fail("expectedManifest.results", "must be a non-empty array");
  }

  const expectedById = new Map<string, DiscoveryExpectedResult>();
  for (const [position, result] of manifest.results.entries()) {
    const field = `expectedManifest.results[${position}]`;
    requireNonemptyString(result.id, `${field}.id`);
    if (expectedById.has(result.id)) {
      fail(`${field}.id`, `duplicate expected result ID ${JSON.stringify(result.id)}`);
    }
    if (!/^INV-0[1-7]$/u.test(result.invariant)) {
      fail(`${field}.invariant`, "must be INV-01 through INV-07");
    }
    if (result.kind !== "property" && result.kind !== "fixed") {
      fail(`${field}.kind`, "must be property or fixed");
    }
    requirePositiveInteger(result.requiredCases, `${field}.requiredCases`);
    requireJunitIdentity(result.junit, `${field}.junit`);
    requireStringArray(result.requiredAssertionIds, `${field}.requiredAssertionIds`);
    expectedById.set(result.id, result);
  }
  return expectedById;
}

/**
 * Checks only the supplied serialized inventory and its internal relations.
 * It does not inspect Git, files, JUnit XML, tool versions, or test execution.
 */
export function validateDiscoveryRunIndex(
  index: DiscoveryRunIndex,
  expectedManifest: DiscoveryExpectedManifest,
): void {
  const expectedById = requireValidManifest(expectedManifest);

  requireEqual(index.schemaVersion, 1, "schemaVersion");
  requireEqual(index.evidenceClass, "deterministic-fixture", "evidenceClass");
  requireNonemptyString(index.family, "family");
  requireEqual(index.family, expectedManifest.family, "family");
  if (index.profile !== "gate" && index.profile !== "replay") {
    fail("profile", "must be gate or replay");
  }
  if (typeof index.identity !== "object" || index.identity === null) {
    fail("identity", "must be an object");
  }
  for (const field of IDENTITY_FIELDS) {
    requireNonemptyString(index.identity[field], `identity.${field}`);
  }
  requireCounts(index.expected, "expected");
  requireCounts(index.executed, "executed");
  if (index.outcome !== "passed" && index.outcome !== "failed" && index.outcome !== "incomplete") {
    fail("outcome", "must be passed, failed, or incomplete");
  }
  requireNonnegativeNumber(index.durationMs, "durationMs");
  if (!Array.isArray(index.results)) {
    fail("results", "must be an array");
  }

  const actualById = new Map<string, DiscoveryRunResult>();
  let executedProperties = 0;
  let executedGeneratedCases = 0;
  let executedFixedCases = 0;
  let hasFailed = false;
  let hasIncomplete = false;

  for (const [position, result] of index.results.entries()) {
    const field = `results[${position}]`;
    requireNonemptyString(result.id, `${field}.id`);
    if (actualById.has(result.id)) {
      fail(`${field}.id`, `duplicate result ID ${JSON.stringify(result.id)}`);
    }
    const expected = expectedById.get(result.id);
    if (!expected) {
      fail(`${field}.id`, `unplanned result ID ${JSON.stringify(result.id)}`);
    }
    actualById.set(result.id, result);

    requireEqual(result.invariant, expected.invariant, `${field}.invariant`);
    requireEqual(result.kind, expected.kind, `${field}.kind`);
    requireNonnegativeInteger(result.expectedCases, `${field}.expectedCases`);
    requireEqual(result.expectedCases, expected.requiredCases, `${field}.expectedCases`);
    requireNonnegativeInteger(result.executedCases, `${field}.executedCases`);
    if (result.executedCases > result.expectedCases) {
      fail(`${field}.executedCases`, "cannot exceed expectedCases");
    }
    if (
      result.outcome !== "passed" &&
      result.outcome !== "failed" &&
      result.outcome !== "incomplete"
    ) {
      fail(`${field}.outcome`, "must be passed, failed, or incomplete");
    }
    if (result.outcome === "passed" && result.executedCases !== result.expectedCases) {
      fail(`${field}.executedCases`, "a passed result must execute every expected case");
    }
    if (result.outcome === "incomplete" && result.executedCases >= result.expectedCases) {
      fail(`${field}.outcome`, "incomplete requires an execution shortfall");
    }
    requireNonemptyString(result.boundaryReached, `${field}.boundaryReached`);
    requireStringArray(result.assertionIds, `${field}.assertionIds`);
    for (const assertionId of expected.requiredAssertionIds) {
      if (!result.assertionIds.includes(assertionId)) {
        fail(
          `${field}.assertionIds`,
          `missing required assertion ID ${JSON.stringify(assertionId)}`,
        );
      }
    }
    requireJunitIdentity(result.junit, `${field}.junit`);
    requireEqual(result.junit.file, expected.junit.file, `${field}.junit.file`);
    requireEqual(result.junit.suite, expected.junit.suite, `${field}.junit.suite`);
    requireEqual(result.junit.name, expected.junit.name, `${field}.junit.name`);
    requireNonnegativeNumber(result.durationMs, `${field}.durationMs`);

    if (result.replay !== undefined) {
      requireInteger(result.replay.seed, `${field}.replay.seed`);
      requirePositiveInteger(result.replay.numRuns, `${field}.replay.numRuns`);
      if (result.replay.path !== undefined && typeof result.replay.path !== "string") {
        fail(`${field}.replay.path`, "must be a string when supplied");
      }
    }
    if (result.counterexampleRef !== undefined) {
      requireSafeRelativeRef(result.counterexampleRef, `${field}.counterexampleRef`);
    }
    if (!Array.isArray(result.artifactRefs)) {
      fail(`${field}.artifactRefs`, "must be an array");
    }
    for (const [referencePosition, reference] of result.artifactRefs.entries()) {
      requireSafeRelativeRef(reference, `${field}.artifactRefs[${referencePosition}]`);
    }

    if (result.kind === "property") {
      executedProperties += result.executedCases > 0 ? 1 : 0;
      executedGeneratedCases += result.executedCases;
    } else {
      executedFixedCases += result.executedCases;
    }
    hasFailed ||= result.outcome === "failed";
    hasIncomplete ||= result.outcome === "incomplete";
  }

  for (const resultId of expectedById.keys()) {
    if (!actualById.has(resultId)) {
      fail("results", `missing required result ID ${JSON.stringify(resultId)}`);
    }
  }

  const expectedProperties = expectedManifest.results.filter(
    ({ kind }) => kind === "property",
  ).length;
  const expectedGeneratedCases = expectedManifest.results
    .filter(({ kind }) => kind === "property")
    .reduce((total, { requiredCases }) => total + requiredCases, 0);
  const expectedFixedCases = expectedManifest.results
    .filter(({ kind }) => kind === "fixed")
    .reduce((total, { requiredCases }) => total + requiredCases, 0);

  requireEqual(index.expected.properties, expectedProperties, "expected.properties");
  requireEqual(index.expected.generatedCases, expectedGeneratedCases, "expected.generatedCases");
  requireEqual(index.expected.fixedCases, expectedFixedCases, "expected.fixedCases");
  requireEqual(index.executed.properties, executedProperties, "executed.properties");
  requireEqual(index.executed.generatedCases, executedGeneratedCases, "executed.generatedCases");
  requireEqual(index.executed.fixedCases, executedFixedCases, "executed.fixedCases");

  if (index.outcome === "passed" && (hasFailed || hasIncomplete)) {
    fail("outcome", "passed index cannot contain failed or incomplete results");
  }
  if (index.outcome === "passed" && index.results.some(({ outcome }) => outcome !== "passed")) {
    fail("outcome", "passed index requires every result to pass");
  }
  if (index.outcome === "failed" && !hasFailed) {
    fail("outcome", "failed index requires a failed result");
  }
  if (index.outcome === "incomplete" && (!hasIncomplete || hasFailed)) {
    fail("outcome", "incomplete index requires an incomplete result and no failed result");
  }
}
