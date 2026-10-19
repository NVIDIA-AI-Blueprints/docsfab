// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

const testApi = process.env.VITEST ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;

import { validateDiscoveryRunIndex } from "./support/discovery/contract.ts";

const expectedManifestFixture = {
  family: "scope",
  results: [
    {
      id: "scope-generated",
      invariant: "INV-01",
      kind: "property",
      requiredCases: 100,
      junit: {
        file: "junit/scope.xml",
        suite: "discovery scope",
        name: "accepts generated scope cases",
      },
      requiredAssertionIds: ["scope.generated.authorized-paths"],
    },
    {
      id: "scope-fixed",
      invariant: "INV-03",
      kind: "fixed",
      requiredCases: 1,
      junit: {
        file: "junit/scope.xml",
        suite: "discovery scope",
        name: "rejects a fixed traversal case",
      },
      requiredAssertionIds: ["scope.fixed.traversal-rejected"],
    },
  ],
};

const passedIndexFixture = {
  schemaVersion: 1,
  evidenceClass: "deterministic-fixture",
  family: "scope",
  profile: "gate",
  identity: {
    sourceRevision: "50476171406f152ed1a275153971c847b8f06acd",
    sourceTree: "beb94392356b425de66ed98d830dbc769737e106",
    workingDiffSha256: "synthetic-working-diff-hash",
    generatedInputsSha256: "synthetic-input-manifest-hash",
    fixtureSha256: "synthetic-fixture-hash",
    generatorRevision: "scope-generator-v1",
    nodeVersion: "v22.19.0",
    vitestVersion: "4.1.11",
    fastCheckVersion: "4.3.0",
  },
  expected: { properties: 1, generatedCases: 100, fixedCases: 1 },
  executed: { properties: 1, generatedCases: 100, fixedCases: 1 },
  outcome: "passed",
  durationMs: 12,
  results: [
    {
      id: "scope-generated",
      invariant: "INV-01",
      kind: "property",
      expectedCases: 100,
      executedCases: 100,
      outcome: "passed",
      boundaryReached: "scope-binding",
      assertionIds: ["scope.generated.authorized-paths"],
      junit: {
        file: "junit/scope.xml",
        suite: "discovery scope",
        name: "accepts generated scope cases",
      },
      durationMs: 10,
      replay: { seed: 20260911, path: "", numRuns: 100 },
      artifactRefs: ["inputs/manifest.json"],
    },
    {
      id: "scope-fixed",
      invariant: "INV-03",
      kind: "fixed",
      expectedCases: 1,
      executedCases: 1,
      outcome: "passed",
      boundaryReached: "scope-binding",
      assertionIds: ["scope.fixed.traversal-rejected"],
      junit: {
        file: "junit/scope.xml",
        suite: "discovery scope",
        name: "rejects a fixed traversal case",
      },
      durationMs: 2,
      artifactRefs: ["fixtures/fixed-traversal.json"],
    },
  ],
};

function roundTrip(value) {
  return JSON.parse(JSON.stringify(value));
}

function inputs() {
  return {
    index: roundTrip(passedIndexFixture),
    manifest: roundTrip(expectedManifestFixture),
  };
}

function validateWithoutMutation(index, manifest) {
  const indexBefore = JSON.stringify(index);
  const manifestBefore = JSON.stringify(manifest);
  validateDiscoveryRunIndex(index, manifest);
  assert.equal(JSON.stringify(index), indexBefore);
  assert.equal(JSON.stringify(manifest), manifestBefore);
}

function rejectWithoutMutation(index, manifest, pattern) {
  const indexBefore = JSON.stringify(index);
  const manifestBefore = JSON.stringify(manifest);
  assert.throws(() => validateDiscoveryRunIndex(index, manifest), pattern);
  assert.equal(JSON.stringify(index), indexBefore);
  assert.equal(JSON.stringify(manifest), manifestBefore);
}

describe("serialized discovery report contract", () => {
  it("RV01 accepts a complete passed index with distinct property and fixed JUnit cases", () => {
    const { index, manifest } = inputs();
    validateWithoutMutation(index, manifest);
  });

  it("RV02 accepts truthful incomplete data without relabeling it passed", () => {
    const { index, manifest } = inputs();
    index.outcome = "incomplete";
    index.executed.generatedCases = 72;
    index.results[0].executedCases = 72;
    index.results[0].outcome = "incomplete";
    validateWithoutMutation(index, manifest);
    assert.equal(index.outcome, "incomplete");
  });

  it("RV03 rejects a missing required result ID", () => {
    const { index, manifest } = inputs();
    index.results.pop();
    rejectWithoutMutation(index, manifest, /missing required result ID "scope-fixed"/u);
  });

  it("RV04 rejects a duplicate result ID", () => {
    const { index, manifest } = inputs();
    index.results.push(roundTrip(index.results[0]));
    rejectWithoutMutation(index, manifest, /duplicate result ID "scope-generated"/u);
  });

  it("RV05 rejects an unplanned additional result ID", () => {
    const { index, manifest } = inputs();
    index.results.push({ ...roundTrip(index.results[1]), id: "scope-unplanned" });
    rejectWithoutMutation(index, manifest, /unplanned result ID "scope-unplanned"/u);
  });

  it("RV06 rejects a passed result that executed zero required cases", () => {
    const { index, manifest } = inputs();
    index.results[0].executedCases = 0;
    index.executed.properties = 0;
    index.executed.generatedCases = 0;
    rejectWithoutMutation(index, manifest, /passed result must execute every expected case/u);
  });

  it("RV07 rejects a passed result with an execution shortfall", () => {
    const { index, manifest } = inputs();
    index.results[0].executedCases = 99;
    index.executed.generatedCases = 99;
    rejectWithoutMutation(index, manifest, /passed result must execute every expected case/u);
  });

  it("RV08 rejects aggregate counts that disagree with independent inventory", () => {
    for (const [section, count, value] of [
      ["expected", "properties", 2],
      ["expected", "generatedCases", 101],
      ["expected", "fixedCases", 2],
      ["executed", "properties", 0],
      ["executed", "generatedCases", 99],
      ["executed", "fixedCases", 0],
    ]) {
      const { index, manifest } = inputs();
      index[section][count] = value;
      rejectWithoutMutation(index, manifest, new RegExp(`${section}\\.${count}`, "u"));
    }
  });

  it("RV09 rejects a passed index containing a failed result", () => {
    const { index, manifest } = inputs();
    index.results[1].outcome = "failed";
    rejectWithoutMutation(index, manifest, /passed index cannot contain failed or incomplete/u);
  });

  it("RV10 rejects a passed index containing an incomplete result", () => {
    const { index, manifest } = inputs();
    index.results[1].outcome = "incomplete";
    index.results[1].executedCases = 0;
    index.executed.fixedCases = 0;
    rejectWithoutMutation(index, manifest, /passed index cannot contain failed or incomplete/u);
  });

  it("RV11 rejects an empty required identity field as malformed supplied data", () => {
    const { index, manifest } = inputs();
    index.identity.sourceTree = "";
    rejectWithoutMutation(index, manifest, /identity\.sourceTree: must be a non-empty string/u);
  });

  it("RV12 rejects a JUnit tuple that differs from the independent manifest", () => {
    const { index, manifest } = inputs();
    index.results[0].junit.name = "some other native testcase";
    rejectWithoutMutation(index, manifest, /results\[0\]\.junit\.name/u);
  });

  it("RV13 rejects a missing required assertion identity", () => {
    const { index, manifest } = inputs();
    index.results[0].assertionIds = [];
    rejectWithoutMutation(index, manifest, /missing required assertion ID/u);
  });

  it("RV14 rejects artifact references that lexically escape the report root", () => {
    const { index, manifest } = inputs();
    index.results[0].artifactRefs = ["../outside"];
    rejectWithoutMutation(index, manifest, /must stay lexically below the report root/u);
  });

  it("RV15 rejects an invalid nonnegative integer execution count", () => {
    for (const invalidCount of [-1, 1.5]) {
      const { index, manifest } = inputs();
      index.results[0].executedCases = invalidCount;
      rejectWithoutMutation(index, manifest, /executedCases: must be a nonnegative integer/u);
    }
  });

  it("RV16 accepts truthful failed data with bounded execution counts", () => {
    const { index, manifest } = inputs();
    index.outcome = "failed";
    index.executed.fixedCases = 0;
    index.results[1].executedCases = 0;
    index.results[1].outcome = "failed";
    index.results[1].counterexampleRef = "counterexamples/traversal.json";
    validateWithoutMutation(index, manifest);
    assert.equal(index.outcome, "failed");
  });
});
