// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testApi = process.env.VITEST ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;
const longIt = (name, body) =>
  process.env.VITEST ? it(name, body, 120_000) : it(name, { timeout: 120_000 }, body);

import { loadLimitDefinitions } from "./check-limits.mjs";
import {
  FAILURE_MESSAGE_CHARS_LIMIT,
  FAILURE_REPORT_ENTRIES_LIMIT,
  assertMergeEnvironment,
  assignShards,
  coverageExclusions,
  expectedLaneIds,
  fastShardFiles,
  inspectBlob,
  lanePlan,
  mergeLanes,
  readTimings,
  runLane,
  timingsFile,
  timingsFromReports,
  validateLaneSet,
} from "./coverage-shards.mjs";
import { takeShard } from "./vitest-ci.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitest = join(packageRoot, "node_modules", "vitest", "vitest.mjs");

const fullFiles = ["test/a.test.js", "test/b.test.js", "test/c.test.js"];
const plans = [
  { id: "fast-1", files: ["test/a.test.js"], plainFiles: [] },
  { id: "isolation-docs", files: ["test/b.test.js"], plainFiles: ["test/c.test.js"] },
];

function evidence(files, id, coveredSources = ["src/choice.js"]) {
  return {
    files,
    coveredSources,
    tests: files.map((_, index) => ({
      id: `${id}-task-${index}`,
      name: "repeated title",
      state: "pass",
      mode: "run",
    })),
  };
}

function manifest(plan, overrides = {}) {
  return {
    schemaVersion: 2,
    revision: "a".repeat(40),
    root: "/builds/docsfab/packages/runtime",
    lane: { id: plan.id, name: plan.id, index: 1, total: 1 },
    fullFiles,
    files: plan.files,
    plainFiles: plan.plainFiles,
    fingerprints: {
      source: "source",
      plan: "plan",
      config: "config",
      lock: "lock",
      toolchain: "toolchain",
    },
    complete: true,
    evidence: evidence(plan.files, plan.id),
    plainEvidence: evidence(plan.plainFiles, `${plan.id}-plain`, []),
    ...overrides,
  };
}

const [fast, docs] = plans;

describe("coverage lane evidence", () => {
  it("accepts lanes that run the full plan exactly once, with repeated display titles", () => {
    const reference = validateLaneSet([manifest(fast), manifest(docs)], plans);
    assert.equal(reference.fullFiles.length, 3);
  });

  it("rejects missing, extra, duplicate, and incomplete lane evidence", () => {
    assert.throws(() => validateLaneSet([manifest(fast)], plans), /missing or extra/u);
    const extra = { id: "fast-2", files: [], plainFiles: [] };
    assert.throws(
      () => validateLaneSet([manifest(fast), manifest(docs), manifest(extra)], plans),
      /missing or extra/u,
    );
    assert.throws(() => validateLaneSet([manifest(fast), manifest(fast)], plans), /duplicate/u);
    assert.throws(
      () => validateLaneSet([manifest(fast), manifest(docs, { complete: false })], plans),
      /incomplete/u,
    );
  });

  it("rejects revision, source, toolchain, root, membership, and execution drift", () => {
    for (const [changed, expected] of [
      [{ revision: "b".repeat(40) }, /revision mismatch/u],
      [{ root: "/different/root" }, /root mismatch/u],
      [{ schemaVersion: 1 }, /incompatible/u],
      [{ fingerprints: { ...manifest(docs).fingerprints, source: "changed" } }, /fingerprints/u],
      [{ fingerprints: { ...manifest(docs).fingerprints, toolchain: "changed" } }, /fingerprints/u],
      [{ files: ["test/a.test.js"] }, /membership differs/u],
      [{ plainFiles: [] }, /membership differs/u],
      [{ evidence: evidence(["test/a.test.js"], "docs") }, /execution differs/u],
      [{ plainEvidence: evidence([], "docs-plain", []) }, /execution differs/u],
      [
        { evidence: { ...evidence(["test/b.test.js"], "docs"), coveredSources: ["src/other.js"] } },
        /source membership/u,
      ],
      [{ evidence: evidence(["test/b.test.js"], "fast-1") }, /duplicate Vitest task/u],
    ]) {
      assert.throws(
        () => validateLaneSet([manifest(fast), manifest(docs, changed)], plans),
        expected,
      );
    }
  });

  it("rejects lanes that do not partition the full test plan", () => {
    const uncovered = plans.map((plan) => ({ ...plan }));
    uncovered[1].plainFiles = [];
    const lanes = [manifest(fast), manifest(uncovered[1])];
    assert.throws(() => validateLaneSet(lanes, uncovered), /partition/u);
  });

  it("rejects the shard-only threshold bypass environment", () => {
    assert.throws(() => assertMergeEnvironment({ DOCSFAB_COVERAGE_SHARD: "1" }), /COVERAGE_SHARD/u);
  });
});

describe("coverage lane plan", () => {
  it("matches the CI lanes: fast shards, isolation domains, uninstrumented exclusions", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-coverage-plan-")));
    try {
      await mkdir(join(root, "scripts", "ci-heavy"), { recursive: true });
      const [excludedHeavy, excludedFast] = coverageExclusions;
      await writeFile(
        join(root, "scripts", "ci-heavy", "delivery.txt"),
        `# comment\n${excludedHeavy}\ntest/heavy.test.ts\n`,
      );
      await writeFile(join(root, "scripts", "ci-heavy", "profile.txt"), "");
      await writeFile(join(root, "scripts", "ci-heavy", "docs.txt"), "test/docs.test.ts\n");
      const inventory = [
        excludedHeavy,
        excludedFast,
        "test/docs.test.ts",
        "test/heavy.test.ts",
        ...Array.from({ length: 9 }, (_, index) => `test/fast-${index}.test.ts`),
      ].sort();
      const lanes = expectedLaneIds(3).map((id) => {
        const fastIndex = /^fast-(\d+)$/u.exec(id);
        return lanePlan(
          root,
          inventory,
          fastIndex
            ? { lane: "fast", index: Number(fastIndex[1]), total: 3 }
            : { lane: `isolation:${id.slice("isolation-".length)}` },
        );
      });
      assert.deepEqual(
        lanes.map((lane) => lane.id),
        ["fast-1", "fast-2", "fast-3", "isolation-delivery", "isolation-profile", "isolation-docs"],
      );
      const planned = lanes.flatMap((lane) => [...lane.files, ...lane.plainFiles]);
      assert.deepEqual([...planned].sort(), inventory);
      const delivery = lanes.find((lane) => lane.id === "isolation-delivery");
      assert.deepEqual(delivery.files, ["test/heavy.test.ts"]);
      assert.deepEqual(delivery.plainFiles, [excludedHeavy]);
      const fastLanes = lanes.filter((lane) => lane.id.startsWith("fast-"));
      assert.deepEqual(
        fastLanes.flatMap((lane) => lane.plainFiles),
        [excludedFast],
      );
      for (const lane of fastLanes) assert.ok(lane.files.length + lane.plainFiles.length >= 3);

      assert.throws(
        () =>
          lanePlan(
            root,
            inventory.filter((file) => file !== "test/docs.test.ts"),
            {
              lane: "isolation:docs",
            },
          ),
        /undiscovered files: test\/docs\.test\.ts/u,
      );
      assert.throws(() => lanePlan(root, inventory, { lane: "isolation:other" }), /unknown/u);
      assert.throws(
        () => lanePlan(root, inventory, { lane: "fast", index: 4, total: 3 }),
        /invalid/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("splits the fast lanes by the recorded timings file", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-coverage-timed-")));
    try {
      await mkdir(join(root, "scripts", "ci-heavy"), { recursive: true });
      for (const domain of ["delivery", "profile", "docs"]) {
        await writeFile(join(root, "scripts", "ci-heavy", `${domain}.txt`), "");
      }
      const inventory = Array.from({ length: 9 }, (_, index) => `test/fast-${index}.test.ts`);
      const files = Object.fromEntries(inventory.map((file) => [file, 10]));
      files["test/fast-5.test.ts"] = 1000;
      await writeFile(join(root, timingsFile), JSON.stringify({ schemaVersion: 1, files }));
      const lanes = [1, 2, 3].map((index) =>
        lanePlan(root, inventory, { lane: "fast", index, total: 3 }),
      );
      assert.deepEqual(lanes[0].files, ["test/fast-5.test.ts"]);
      assert.equal(lanes[1].files.length, 4);
      assert.equal(lanes[2].files.length, 4);
      assert.deepEqual(lanes.flatMap((lane) => lane.files).sort(), inventory);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("timed fast-lane split", () => {
  const files = Array.from({ length: 23 }, (_, index) => `test/file-${index}.test.ts`);
  const timings = Object.fromEntries(
    files.slice(0, 20).map((file, index) => [file, ((index * 7919) % 97) * 100 + 50]),
  );

  it("assigns every file to exactly one shard for every shard count", () => {
    for (const total of [1, 2, 3, 4, 7, 23, 30]) {
      const shards = assignShards(files, total, timings);
      assert.equal(shards.length, total);
      const assigned = shards.flatMap((shard) => shard.files);
      assert.equal(new Set(assigned).size, assigned.length);
      assert.deepEqual([...assigned].sort(), [...files].sort());
    }
    assert.deepEqual(
      assignShards([], 4, timings).map((shard) => shard.files),
      [[], [], [], []],
    );
    assert.throws(() => assignShards(files, 0, timings), /invalid shard total/u);
  });

  it("computes the same assignment whatever the input order", () => {
    const expected = assignShards(files, 4, timings);
    const reversed = assignShards([...files].reverse(), 4, timings);
    const reordered = Object.fromEntries(Object.entries(timings).reverse());
    assert.deepEqual(reversed, expected);
    assert.deepEqual(assignShards(files, 4, reordered), expected);
    for (const shard of expected) assert.deepEqual(shard.files, [...shard.files].sort());
  });

  it("balances recorded time within the longest file", () => {
    const shards = assignShards(files, 4, timings);
    const loads = shards.map((shard) => shard.ms);
    const longest = Math.max(...Object.values(timings));
    assert.ok(Math.max(...loads) - Math.min(...loads) <= longest, JSON.stringify(loads));
    const exact = assignShards(["a", "b", "c", "d", "e", "f"], 2, {
      a: 6,
      b: 5,
      c: 4,
      d: 3,
      e: 2,
      f: 1,
    });
    assert.deepEqual(
      exact.map((shard) => shard.ms),
      [11, 10],
    );
  });

  it("weighs unrecorded files by the median recorded time", () => {
    const shards = assignShards(
      ["test/new.test.ts", "test/a.test.ts", "test/b.test.ts", "test/c.test.ts"],
      2,
      {
        "test/a.test.ts": 100,
        "test/b.test.ts": 30,
        "test/c.test.ts": 10,
        "test/gone.test.ts": 900,
      },
    );
    // new weighs 30, the median of the files in this split; gone is not in it.
    assert.deepEqual(shards, [
      { ms: 100, files: ["test/a.test.ts"] },
      { ms: 70, files: ["test/b.test.ts", "test/c.test.ts", "test/new.test.ts"] },
    ]);
  });

  it("spreads files evenly by count without timings or with zero times", () => {
    for (const recorded of [{}, Object.fromEntries(files.map((file) => [file, 0]))]) {
      const counts = assignShards(files, 4, recorded).map((shard) => shard.files.length);
      assert.deepEqual(counts, [6, 6, 6, 5]);
    }
  });

  it("reads a valid timings file, none, and refuses a malformed one", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-coverage-timings-")));
    try {
      assert.deepEqual(readTimings(root), {});
      await mkdir(join(root, "scripts"), { recursive: true });
      const write = (value) => writeFile(join(root, timingsFile), JSON.stringify(value));
      await write({ schemaVersion: 1, files: { "test/a.test.ts": 12 } });
      assert.deepEqual(readTimings(root), { "test/a.test.ts": 12 });
      for (const invalid of [
        { schemaVersion: 2, files: {} },
        { schemaVersion: 1 },
        { schemaVersion: 1, files: [] },
      ]) {
        await write(invalid);
        assert.throws(() => readTimings(root), /not a schemaVersion 1 timings file/u);
      }
      for (const ms of [-1, 1.5, "12"]) {
        await write({ schemaVersion: 1, files: { "test/a.test.ts": ms } });
        assert.throws(() => readTimings(root), /invalid duration for test\/a\.test\.ts/u);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds timings from JUnit reports: mean per file, public inventory only", () => {
    const report = (suites) =>
      [
        '<?xml version="1.0" encoding="UTF-8" ?>',
        '<testsuites name="vitest tests" tests="3" time="9.9">',
        ...suites.map(
          ([name, time]) =>
            `    <testsuite name="${name}" timestamp="2026-10-12T19:20:29.327Z" tests="1" time="${time}">\n    </testsuite>`,
        ),
        "</testsuites>",
      ].join("\n");
    const timings = timingsFromReports(
      [
        report([
          ["test/a.test.ts", "1.2"],
          ["test/r&amp;d.test.ts", "0.0004"],
          ["test/gone.test.ts", "5"],
          ["test/record.internal.test.ts", "3"],
        ]),
        report([["test/a.test.ts", "2.4005"]]),
      ],
      new Set([
        "test/a.test.ts",
        "test/r&d.test.ts",
        "test/unrun.test.ts",
        "test/record.internal.test.ts",
      ]),
    );
    assert.deepEqual(timings, {
      schemaVersion: 1,
      files: { "test/a.test.ts": 1800, "test/r&d.test.ts": 0 },
    });
    assert.throws(
      () => timingsFromReports(["<testsuites></testsuites>"], new Set()),
      /no testsuite/u,
    );
    assert.throws(
      () => timingsFromReports([report([["test/a.test.ts", "soon"]])], new Set()),
      /valid time/u,
    );
  });

  it("takes vitest-ci's --shard argument in both forms and refuses bad values", () => {
    const joined = ["--reporter=dot", "--shard=2/4"];
    assert.deepEqual(takeShard(joined), { index: 2, total: 4 });
    assert.deepEqual(joined, ["--reporter=dot"]);
    const separate = ["--shard", "4/4", "--bail"];
    assert.deepEqual(takeShard(separate), { index: 4, total: 4 });
    assert.deepEqual(separate, ["--bail"]);
    assert.equal(takeShard(["--reporter=dot"]), null);
    for (const bad of [["--shard=0/4"], ["--shard=5/4"], ["--shard=a/b"], ["--shard"]]) {
      assert.throws(() => takeShard(bad), /is not k\/n/u);
    }
  });
});

// Encode a value the way Vitest's blob reporter (flatted) does: every object,
// array, and string lives in one array and is referenced by its index.
function flattedBlob(value) {
  const output = [];
  const visit = (item) => {
    if (item === null || (typeof item !== "object" && typeof item !== "string")) return item;
    const index = output.length;
    output.push(null);
    if (typeof item === "string") {
      output[index] = item;
      return String(index);
    }
    const node = Array.isArray(item) ? [] : {};
    output[index] = node;
    for (const [key, child] of Object.entries(item)) node[key] = visit(child);
    return String(index);
  };
  visit(value);
  return JSON.stringify(output);
}

describe("coverage shard failure reporting", () => {
  it("names each failed or incomplete file, test, and unhandled error and counts omissions", async () => {
    const definitions = loadLimitDefinitions();
    const maxEntries = definitions.find((entry) => entry.name === FAILURE_REPORT_ENTRIES_LIMIT);
    const maxChars = definitions.find((entry) => entry.name === FAILURE_MESSAGE_CHARS_LIMIT);
    const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-coverage-blob-")));
    const blob = join(root, "blob.json");
    const write = (files, errors) =>
      writeFile(
        blob,
        flattedBlob(["4.1.11", files, errors, { [join(root, "src", "covered.ts")]: {} }, 12.5]),
      );
    const failing = (index) => ({
      type: "test",
      id: `case-${index}`,
      name: `case ${index}`,
      mode: "run",
      result: {
        state: "fail",
        errors: [{ name: "AssertionError", message: `expected ${index} to be -1\nsecond line` }],
      },
    });
    const brokenFile = {
      filepath: join(root, "test", "broken.test.ts"),
      mode: "run",
      result: { state: "fail", errors: [{ name: "SyntaxError", message: "Unexpected token" }] },
      tasks: [],
    };
    try {
      await write(
        [
          {
            filepath: join(root, "test", "store.test.ts"),
            mode: "run",
            result: { state: "fail" },
            tasks: [
              {
                type: "suite",
                id: "suite",
                name: "receipt store",
                mode: "run",
                result: { state: "fail" },
                tasks: [
                  {
                    type: "test",
                    id: "passes",
                    name: "passes",
                    mode: "run",
                    result: { state: "pass" },
                  },
                  {
                    type: "test",
                    id: "skipped",
                    name: "skipped",
                    mode: "skip",
                    result: { state: "skip" },
                  },
                  {
                    type: "test",
                    id: "wrapped",
                    name: "wraps its cause",
                    mode: "run",
                    result: {
                      state: "fail",
                      errors: [
                        {
                          name: "AssertionError",
                          message: "promise rejected instead of resolving",
                          cause: { message: "SCM delivery receipt store failed (unsafe-root)." },
                        },
                      ],
                    },
                  },
                  {
                    type: "test",
                    id: "long",
                    name: "long message",
                    mode: "run",
                    result: {
                      state: "fail",
                      errors: [{ message: "x".repeat(maxChars.value + 7) }],
                    },
                  },
                  { type: "test", id: "unfinished", name: "never finished", mode: "run" },
                  ...Array.from({ length: maxEntries.value }, (_, index) => failing(index)),
                ],
              },
            ],
          },
          brokenFile,
        ],
        [{ name: "Error", message: "unhandled rejection" }],
      );
      await assert.rejects(inspectBlob(blob, root), (error) => {
        const lines = error.message.split("\n");
        const failedTests = maxEntries.value + 3;
        assert.equal(
          lines[0],
          `Vitest blob contains failed or incomplete tests: 2 file(s), ${failedTests} test(s), 1 unhandled error(s).`,
        );
        assert.deepEqual(lines.slice(1, 6), [
          `- file test/store.test.ts: fail: ${failedTests} failed or incomplete test(s) listed below`,
          "- test test/store.test.ts > receipt store > wraps its cause: fail: AssertionError: promise rejected instead of resolving (cause: SCM delivery receipt store failed (unsafe-root).)",
          `- test test/store.test.ts > receipt store > long message: fail: ${"x".repeat(maxChars.value)}... (7 more characters omitted; ${maxChars.name} = ${maxChars.value} ${maxChars.unit})`,
          "- test test/store.test.ts > receipt store > never finished: not-run: no error recorded",
          "- test test/store.test.ts > receipt store > case 0: fail: AssertionError: expected 0 to be -1",
        ]);
        // One file line, every failed test, the broken file, and the unhandled error.
        const entries = 1 + failedTests + 1 + 1;
        assert.equal(lines.length, 1 + maxEntries.value + 1);
        assert.equal(
          lines.at(-1),
          `- ${entries - maxEntries.value} more failed or incomplete entries omitted (${maxEntries.name} = ${maxEntries.value} ${maxEntries.unit}); open the lane blob artifact for the rest.`,
        );
        return true;
      });

      await write([brokenFile], [{ name: "Error", message: "unhandled rejection\nstack" }]);
      await assert.rejects(inspectBlob(blob, root), (error) => {
        assert.equal(
          error.message,
          [
            "Vitest blob contains failed or incomplete tests: 1 file(s), 0 test(s), 1 unhandled error(s).",
            "- file test/broken.test.ts: fail: SyntaxError: Unexpected token",
            "- error unhandled: error: Error: unhandled rejection",
          ].join("\n"),
        );
        return true;
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("coverage artifact path safety", () => {
  it("rejects symlinked lane and merge parents without deleting outside markers", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-coverage-root-")));
    const outside = await realpath(await mkdtemp(join(tmpdir(), "docsfab-coverage-outside-")));
    const shardMarker = join(outside, "fast-1", "keep.txt");
    const mergeMarker = join(outside, "coverage-merge", "keep.txt");
    const outerShard = process.env.DOCSFAB_COVERAGE_SHARD;
    delete process.env.DOCSFAB_COVERAGE_SHARD;
    try {
      await mkdir(join(outside, "fast-1"), { recursive: true });
      await writeFile(shardMarker, "keep shard\n");
      await symlink(outside, join(root, "coverage-lanes"), "dir");
      await assert.rejects(
        runLane({
          root,
          lane: "fast",
          index: 1,
          total: 1,
          output: "coverage-lanes/fast-1",
          junit: "ci-results/fast-1",
          measure: false,
        }),
        /symbolic link/u,
      );
      await assert.rejects(
        mergeLanes({
          root,
          input: "coverage-lanes",
          fastTotal: 1,
          output: "ci-results/coverage-merge",
          measure: false,
        }),
        /symbolic link/u,
      );
      assert.equal(await readFile(shardMarker, "utf8"), "keep shard\n");

      await rm(join(root, "coverage-lanes"));
      await mkdir(join(root, "coverage-lanes"));
      await mkdir(join(outside, "coverage-merge"));
      await writeFile(mergeMarker, "keep merge\n");
      await symlink(outside, join(root, "ci-results"), "dir");
      await assert.rejects(
        mergeLanes({
          root,
          input: "coverage-lanes",
          fastTotal: 1,
          output: "ci-results/coverage-merge",
          measure: false,
        }),
        /symbolic link/u,
      );
      assert.equal(await readFile(mergeMarker, "utf8"), "keep merge\n");
    } finally {
      if (outerShard === undefined) delete process.env.DOCSFAB_COVERAGE_SHARD;
      else process.env.DOCSFAB_COVERAGE_SHARD = outerShard;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });
});

const uninstrumentedFile = coverageExclusions.find((file) => file.includes("content-ir"));
const fixtureLanes = [
  { lane: "fast", index: 1, total: 2, junit: "ci-results/fast-1" },
  { lane: "fast", index: 2, total: 2, junit: "ci-results/fast-2" },
  { lane: "isolation:delivery", junit: "ci-results/isolation-delivery" },
  { lane: "isolation:profile", junit: "ci-results/isolation-profile" },
  { lane: "isolation:docs", junit: "ci-results/isolation-docs" },
];

async function createFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-coverage-shards-")));
  await Promise.all([
    mkdir(join(root, "src"), { recursive: true }),
    mkdir(join(root, "test"), { recursive: true }),
    mkdir(join(root, "test", "helpers"), { recursive: true }),
    mkdir(join(root, "scripts"), { recursive: true }),
    mkdir(join(root, "ci-results"), { recursive: true }),
  ]);
  await writeFile(
    join(root, "src", "choice.js"),
    [
      "export function choice(value) {",
      '  if (value) return "yes";',
      '  return "no";',
      "}",
      "export function uncovered() { return 7; }",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "test", "a.test.js"),
    [
      'import { choice } from "../src/choice.js";',
      "test.each([true, true])('repeated title', (value) => expect(choice(value)).toBe('yes'));",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "test", "b.test.js"),
    [
      'import { choice } from "../src/choice.js";',
      "test('covers false', () => expect(choice(false)).toBe('no'));",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "vitest.config.ts"),
    [
      "export default { test: { globals: true, coverage: {",
      "  provider: 'v8', include: ['src/**/*.js'],",
      "  reporter: ['json-summary'], reportsDirectory: './coverage',",
      "  ...(process.env.FIXTURE_DISABLE_THRESHOLDS === '1' || process.env.DOCSFAB_COVERAGE_SHARD === '1' ? {} : {",
      "    thresholds: { lines: 50, branches: 50, functions: 50, statements: 50 },",
      "  }),",
      "} } };",
      "",
    ].join("\n"),
  );
  await writeFile(join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(join(root, "npm-shrinkwrap.json"), '{"lockfileVersion":3}\n');
  await writeFile(join(root, "scripts", "coverage-shards.mjs"), "fixture orchestration input\n");
  await writeFile(
    join(root, timingsFile),
    `${JSON.stringify({ schemaVersion: 1, files: { "test/a.test.js": 40 } })}\n`,
  );
  // b runs in the docs isolation lane; the excluded file runs uninstrumented
  // in a fast lane; the delivery and profile lanes are empty.
  await mkdir(join(root, "scripts", "ci-heavy"), { recursive: true });
  await writeFile(join(root, "scripts", "ci-heavy", "docs.txt"), "test/b.test.js\n");
  await writeFile(join(root, "scripts", "ci-heavy", "delivery.txt"), "");
  await writeFile(join(root, "scripts", "ci-heavy", "profile.txt"), "");
  await mkdir(dirname(join(root, uninstrumentedFile)), { recursive: true });
  await writeFile(
    join(root, uninstrumentedFile),
    "test('runs without coverage', () => expect(1).toBe(1));\n",
  );
  await writeFile(join(root, "scripts", "vitest-coverage-module-offset.mjs"), "fixture shim\n");
  await writeFile(
    join(root, "test", "helpers", "coverage-module-offset.setup.mjs"),
    "fixture setup\n",
  );
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Coverage Test",
      "-c",
      "user.email=coverage@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: root },
  );
  return root;
}

function runVitest(root, args) {
  return spawnSync(process.execPath, [vitest, ...args], {
    cwd: root,
    env: { ...process.env, DOCSFAB_COVERAGE_SHARD: "0" },
    encoding: "utf8",
  });
}

describe("coverage shard entry point", () => {
  let fastInventory;
  for (const variant of ["joined empty", "separate empty", "nonempty"]) {
    longIt(`the fast launcher preserves the planned ${variant} shard`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "docsfab-fast-shard-cli-"));
      const capture = join(directory, "dispatch.json");
      const observer = join(directory, "observe-dispatch.mjs");
      try {
        // Keep real discovery and replace only final execution with Vitest's
        // native selection oracle, so a regression cannot run the entire suite.
        await writeFile(
          observer,
          `
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
const actual = cp.spawnSync;
cp.spawnSync = function(command, args, options) {
  if (command === "npx" && args[0] === "vitest" && args[1] === "run") {
    const result = actual(process.execPath,
      [join(options.cwd, "node_modules/vitest/vitest.mjs"), "list", "--filesOnly", "--json", ...args.slice(2)],
      { ...options, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
      args, status: result.status, stderr: result.stderr,
      selected: result.status === 0 ? JSON.parse(result.stdout).map(({ file }) => relative(options.cwd, file).split(sep).join("/")).sort() : null,
    }));
    return { status: result.status, signal: result.signal };
  }
  return actual.call(this, command, args, options);
};
syncBuiltinESMExports();
`,
        );
        const files = await (fastInventory ??= fastShardFiles({ index: 1, total: 1 }));
        assert.ok(files.length > 0, "the adjacent nonempty selection must be reachable");
        const total = files.length + 1;
        const invoke = (args) =>
          spawnSync(
            process.execPath,
            ["--import", observer, join(packageRoot, "scripts/vitest-ci.mjs"), "fast", ...args],
            { cwd: packageRoot, encoding: "utf8" },
          );
        if (variant !== "nonempty") {
          const args =
            variant === "joined empty"
              ? [`--shard=${total}/${total}`]
              : ["--shard", `${total}/${total}`];
          const result = invoke(args);
          assert.equal(result.status, 0, result.stderr);
          assert.equal(
            existsSync(capture),
            false,
            "an empty planned shard must not dispatch Vitest run",
          );
          assert.ok(
            result.stdout.includes(`fast shard ${total}/${total}: 0 assigned files; no tests run`),
            result.stdout,
          );
        } else {
          const expected = assignShards(files, total, readTimings(packageRoot))[0].files.sort();
          assert.ok(expected.length > 0);
          const result = invoke(["--shard", `1/${total}`]);
          assert.equal(result.status, 0, result.stderr);
          assert.ok(existsSync(capture), "nonempty shard must dispatch its planned files");
          const observed = JSON.parse(await readFile(capture, "utf8"));
          assert.equal(observed.status, 0, observed.stderr);
          assert.deepEqual(
            observed.selected,
            expected,
            "nonempty shard must dispatch exactly the planned files",
          );
          assert.equal(
            observed.args.some((arg) => arg === "--shard" || arg.startsWith("--shard=")),
            false,
          );
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  it("runs main through a symlinked invocation path and stays silent when imported", async () => {
    const script = join(packageRoot, "scripts", "coverage-shards.mjs");
    const directory = await mkdtemp(join(tmpdir(), "docsfab-coverage-entry-"));
    try {
      const link = join(directory, "linked-coverage-shards.mjs");
      await symlink(script, link, "file");

      // Positive control: invoked by its canonical path, the script reaches
      // main() and refuses an unknown command by name.
      const direct = spawnSync(process.execPath, [script], { encoding: "utf8" });
      assert.equal(direct.status, 1, direct.stderr);
      assert.match(direct.stderr, /usage: coverage-shards\.mjs lane/u);

      // The guarded condition is "Node started with this file as its main
      // module". argv[1] here is a symlink to the script, inside a tmpdir that
      // is itself a symlink on macOS: an un-realpathed comparison skips main()
      // and exits 0 with no output.
      const linked = spawnSync(process.execPath, [link], { encoding: "utf8" });
      assert.equal(linked.status, 1, `${linked.stdout}${linked.stderr}`);
      assert.match(linked.stderr, /usage: coverage-shards\.mjs lane/u);

      // Adjacent condition the guard must NOT handle: the module imported by a
      // different entry point must not run main().
      const importer = join(directory, "importer.mjs");
      await writeFile(importer, `import ${JSON.stringify(pathToFileURL(link).href)};\n`);
      const imported = spawnSync(process.execPath, [importer], { encoding: "utf8" });
      assert.equal(imported.status, 0, imported.stderr);
      assert.equal(imported.stderr, "");
      assert.equal(imported.stdout, "");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("native Vitest coverage lane integration", () => {
  longIt(
    "preserves V8 counts when another test leaves the same module import pending",
    async () => {
      const root = await createFixture();
      try {
        const pendingTest = join(root, "pending.test.ts");
        const primitives = join(packageRoot, "src/contract-kit/primitives.ts");
        await writeFile(
          pendingTest,
          [
            'import { expect, it, vi } from "vitest";',
            "const state = vi.hoisted(() => ({ entered: false }));",
            `vi.mock(${JSON.stringify(join(packageRoot, "src/security/configured-credentials.js"))}, async () => {`,
            "  state.entered = true;",
            "  return new Promise(() => {});",
            "});",
            'it("leaves a dependency import pending", async () => {',
            `  void import(${JSON.stringify(primitives)});`,
            "  await vi.waitFor(() => expect(state.entered).toBe(true));",
            "});",
            "",
          ].join("\n"),
        );
        await writeFile(
          join(root, "sequencer.mjs"),
          [
            `import { BaseSequencer } from ${JSON.stringify(pathToFileURL(join(packageRoot, "node_modules/vitest/dist/node.js")).href)};`,
            "export class StableSequencer extends BaseSequencer {",
            "  async sort(specs) { return [...specs].sort((a, b) => Number(a.moduleId.endsWith('pending.test.ts')) - Number(b.moduleId.endsWith('pending.test.ts'))); }",
            "}",
            "",
          ].join("\n"),
        );
        const contractTest = join(packageRoot, "test/contract-kit.test.ts");
        const config = (setupFiles, tests) =>
          [
            `import base from ${JSON.stringify(pathToFileURL(join(packageRoot, "vitest.config.ts")).href)};`,
            'import { StableSequencer } from "./sequencer.mjs";',
            `export default { ...base, root: ${JSON.stringify(packageRoot)}, test: { ...base.test,`,
            `  include: ${JSON.stringify(tests)},`,
            "  fileParallelism: false, maxWorkers: 1, sequence: { sequencer: StableSequencer },",
            `  setupFiles: ${JSON.stringify(setupFiles)},`,
            "  coverage: { ...base.test.coverage, processingConcurrency: 1, reporter: ['json'],",
            `    reportsDirectory: ${JSON.stringify(join(root, "coverage"))},`,
            "  },",
            "} };",
            "",
          ].join("\n");
        const configPath = join(root, "vitest.config.ts");
        const args = [
          "run",
          "--config",
          configPath,
          "--coverage",
          "--reporter=json",
          `--outputFile=${join(root, "tests.json")}`,
        ];
        const passedTests = async (run) => {
          const reportPath = join(root, "tests.json");
          if (!existsSync(reportPath)) {
            assert.fail(
              `focused Vitest run wrote no JSON report (status ${run.status}, signal ${run.signal}): ${run.stdout}${run.stderr}`,
            );
          }
          const report = JSON.parse(await readFile(reportPath, "utf8"));
          assert.ok(report.numPassedTests > 1);
          assert.equal(report.numFailedTests, 0);
          assert.equal(report.numPendingTests, 0);
          return report.numPassedTests;
        };
        const functionCounts = (entry) =>
          Object.fromEntries(
            Object.entries(entry.fnMap).map(([key, fn]) => [fn.name, entry.f[key]]),
          );
        // A pending import need not corrupt counts on every runtime. Compare
        // the hooked aggregate to the same tests without a pending import.
        await writeFile(configPath, config([], [contractTest]));
        const reference = runVitest(packageRoot, args);
        const referencePassed = await passedTests(reference);
        const referenceCoverage = JSON.parse(
          await readFile(join(root, "coverage/coverage-final.json"), "utf8"),
        )[primitives];
        assert.equal(
          reference.status,
          1,
          "focused run must retain the canonical whole-suite thresholds",
        );
        const referenceCounts = functionCounts(referenceCoverage);
        const measuredFunctions = ["hash", "seal"];
        for (const name of measuredFunctions) {
          assert.ok(referenceCounts[name] > 0, `standalone tests must exercise ${name}`);
        }

        await writeFile(
          configPath,
          config(
            [join(packageRoot, "test/helpers/coverage-module-offset.setup.mjs")],
            [contractTest, pendingTest],
          ),
        );
        const repaired = runVitest(packageRoot, args);
        assert.equal(
          repaired.status,
          1,
          "focused run must retain the canonical whole-suite thresholds",
        );
        assert.equal(await passedTests(repaired), referencePassed + 1);
        const after = JSON.parse(
          await readFile(join(root, "coverage/coverage-final.json"), "utf8"),
        )[primitives];
        const repairedCounts = functionCounts(after);
        for (const name of measuredFunctions) {
          assert.equal(
            repairedCounts[name],
            referenceCounts[name],
            `pending import must preserve the standalone ${name} count`,
          );
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  longIt(
    "matches an unsharded report, enforces thresholds, detects failure, and rejects tampering",
    async () => {
      const root = await createFixture();
      const outerShard = process.env.DOCSFAB_COVERAGE_SHARD;
      const outerRevision = process.env.CI_COMMIT_SHA;
      delete process.env.DOCSFAB_COVERAGE_SHARD;
      delete process.env.CI_COMMIT_SHA;
      const merge = () =>
        mergeLanes({
          root,
          input: "coverage-lanes",
          output: "ci-results/coverage-merge",
          measure: false,
        });
      try {
        const single = runVitest(root, [
          "run",
          "--coverage",
          "--coverage.reportsDirectory=coverage-single",
        ]);
        assert.equal(single.status, 0, single.stderr);

        const manifests = [];
        for (const lane of fixtureLanes) {
          manifests.push(await runLane({ root, ...lane, measure: false }));
        }
        assert.deepEqual(
          manifests.map((manifest) => manifest.lane.id),
          expectedLaneIds(2),
        );
        const plain = manifests.find((manifest) => manifest.plainFiles.length > 0);
        assert.deepEqual(plain.plainEvidence.files, [uninstrumentedFile]);
        assert.deepEqual(plain.plainEvidence.coveredSources, []);
        await readFile(join(root, "ci-results", `${plain.lane.id}-plain-junit.xml`), "utf8");
        await readFile(join(root, "ci-results", "isolation-docs-junit.xml"), "utf8");

        await merge();
        const [singleSummary, mergedSummary] = await Promise.all([
          readFile(join(root, "coverage-single", "coverage-summary.json"), "utf8"),
          readFile(join(root, "coverage", "coverage-summary.json"), "utf8"),
        ]);
        assert.deepEqual(JSON.parse(mergedSummary), JSON.parse(singleSummary));

        for (const path of [
          "scripts/vitest-coverage-module-offset.mjs",
          "test/helpers/coverage-module-offset.setup.mjs",
        ]) {
          const absolute = join(root, path);
          const original = await readFile(absolute);
          await writeFile(absolute, "changed coverage compatibility input\n");
          await assert.rejects(merge(), /config, lock, or toolchain changed before merge/u);
          await writeFile(absolute, original);
        }
        // New timings that keep this fixture's split still change the inputs
        // the lanes were planned from.
        const timingsPath = join(root, timingsFile);
        const recordedTimings = await readFile(timingsPath);
        await writeFile(
          timingsPath,
          JSON.stringify({ schemaVersion: 1, files: { "test/a.test.js": 41 } }),
        );
        await assert.rejects(merge(), /config, lock, or toolchain changed before merge/u);
        await writeFile(timingsPath, recordedTimings);

        const threshold = runVitest(root, [
          "--merge-reports=ci-results/coverage-merge/verified-blobs",
          "--coverage",
          "--coverage.thresholds.lines=100",
        ]);
        assert.notEqual(threshold.status, 0, "uncovered source must fail a merged threshold");

        process.env.FIXTURE_DISABLE_THRESHOLDS = "1";
        await assert.rejects(merge(), /no enforced coverage thresholds/u);
        delete process.env.FIXTURE_DISABLE_THRESHOLDS;

        const extra = join(root, "coverage-lanes", "isolation-docs", "extra.json");
        await writeFile(extra, "{}\n");
        await assert.rejects(merge(), /unexpected coverage lane artifact/u);
        await rm(extra);

        const docsLane = join(root, "coverage-lanes", "isolation-docs");
        const parked = join(root, "parked-docs-lane");
        await rename(docsLane, parked);
        await assert.rejects(merge(), /missing or extra coverage lane manifest/u);
        await rename(parked, docsLane);

        for (const blob of [
          join(docsLane, "blob-isolation-docs.json"),
          join(root, "coverage-lanes", plain.lane.id, `plain-${plain.lane.id}.json`),
        ]) {
          const original = await readFile(blob);
          await writeFile(blob, Buffer.concat([original, Buffer.from("\n")]));
          await assert.rejects(merge(), /digest/u);
          await writeFile(blob, original);
        }

        const blob = join(docsLane, "blob-isolation-docs.json");
        const original = await readFile(blob);
        const outside = await realpath(await mkdtemp(join(tmpdir(), "docsfab-blob-outside-")));
        const outsideBlob = join(outside, "keep.json");
        await writeFile(outsideBlob, original);
        await rm(blob);
        await symlink(outsideBlob, blob, "file");
        await assert.rejects(merge(), /symbolic link/u);
        assert.deepEqual(await readFile(outsideBlob), original);
        await rm(blob);
        await writeFile(blob, original);
        await rm(outside, { recursive: true, force: true });
        await merge();

        const fastManifest = join(root, "coverage-lanes", "fast-1", "manifest.json");
        const recorded = await readFile(fastManifest, "utf8");
        const disagreeing = JSON.parse(recorded);
        disagreeing.lane.total = 3;
        await writeFile(fastManifest, JSON.stringify(disagreeing));
        await assert.rejects(merge(), /fast coverage lanes disagree/u);
        await writeFile(fastManifest, recorded);

        const commit = async (message) => {
          execFileSync("git", ["add", "."], { cwd: root });
          execFileSync(
            "git",
            [
              "-c",
              "user.name=Coverage Test",
              "-c",
              "user.email=coverage@example.invalid",
              "commit",
              "-qm",
              message,
            ],
            { cwd: root },
          );
        };
        await writeFile(
          join(root, uninstrumentedFile),
          "test('uninstrumented failure evidence', () => expect(1).toBe(2));\n",
        );
        await commit("uninstrumented failure");
        await assert.rejects(
          runLane({ root, ...fixtureLanes[0], index: 1, total: 1, measure: false }),
          /uninstrumented run: [\s\S]*uninstrumented failure evidence: fail: AssertionError: expected 1 to be 2/u,
        );

        await writeFile(
          join(root, "test", "failure.test.js"),
          "test('failed test evidence', () => expect(1).toBe(2));\n",
        );
        await commit("failure");
        await assert.rejects(
          runLane({ root, ...fixtureLanes[0], index: 1, total: 1, measure: false }),
          /instrumented run: [\s\S]*- test test\/failure\.test\.js > failed test evidence: fail: AssertionError: expected 1 to be 2/u,
        );
      } finally {
        if (outerShard === undefined) delete process.env.DOCSFAB_COVERAGE_SHARD;
        else process.env.DOCSFAB_COVERAGE_SHARD = outerShard;
        if (outerRevision === undefined) delete process.env.CI_COMMIT_SHA;
        else process.env.CI_COMMIT_SHA = outerRevision;
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
