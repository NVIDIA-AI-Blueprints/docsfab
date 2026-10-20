// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The runner keeps each attempt's history citations and copies them, in
 * attempt order, onto the step record the strict readers decode; the run
 * total never carries them, because citations are not a summable count.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentHarness, HarnessStepInput } from "../src/execution/contracts.js";
import { limitDefinition } from "../src/config/limits.js";
import { decodeTools } from "../src/execution/inference-evidence.js";
import type { HistoryReadCitationV1, RunRecord, RunStore } from "../src/records/contracts.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { readyContextPreflight } from "./helpers.js";
import { verificationFixture } from "./helpers/verification.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const CITATION: HistoryReadCitationV1 = {
  tool: "docsfab_history_diff",
  revisions: ["a".repeat(40), "b".repeat(40)],
  paths: ["src/app.ts"],
  ranges: [{ path: "src/app.ts", unit: "bytes", start: 0, end: 120 }],
  labels: ["history-paths-excluded"],
  sha256: "c".repeat(64),
  excludedPathCount: 1,
};

class HistoryHarness implements AgentHarness {
  public async runStep(input: HarnessStepInput): ReturnType<AgentHarness["runStep"]> {
    return {
      summary: `ran ${input.step.skill}`,
      ...(await verificationFixture(input)),
      model: { provider: "hosted", model: "test-model" },
      skill: { id: input.step.skill, contentSha256: "a".repeat(64) },
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, turns: 1 },
      tools: {
        totalCalls: 1,
        failedCalls: 0,
        byTool: [{ name: "docsfab_history_diff", calls: 1, failures: 0 }],
        historyReads: [structuredClone(CITATION)],
      },
    };
  }
}

describe("history citations on the run record", () => {
  it("copies an attempt's citations onto its step and leaves them off the run total", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "docsfab-history-run-"));
    directories.push(workspace);
    const saved: RunRecord[] = [];
    const store: RunStore = { save: async (record) => void saved.push(structuredClone(record)) };
    const runner = new WorkflowRunner({
      harness: new HistoryHarness(),
      store,
      repositoryScanner: {
        scan: async () => ({
          ruleSet: "test-v1",
          status: "passed",
          scannedFiles: 1,
          binaryFiles: 0,
          findings: [],
        }),
      },
      contextPreflight: readyContextPreflight,
      repositoryEvidence: { capture: async () => ({ files: [] }) },
      id: () => "run-history",
      now: () => new Date("2026-10-06T12:00:00.000Z"),
    });

    const record = await runner.run({
      workflow: "readiness",
      workspacePath: workspace,
      repository: { sourcePath: "/tmp/repo", requestedRevision: "HEAD", revision: "abc123" },
      allowWrite: false,
    });

    expect(record.status, JSON.stringify(record.error)).toBe("succeeded");
    const [step] = record.steps;
    expect(step!.inference!.attempts.map((attempt) => attempt.tools?.historyReads)).toEqual([
      [CITATION],
    ]);
    expect(step!.tools!.historyReads).toEqual([CITATION]);
    expect(decodeTools(step!.tools).historyReads).toEqual([CITATION]);
    expect(record.tools.historyReads).toBeUndefined();
    expect(saved.at(-1)!.steps[0]!.tools!.historyReads).toEqual([CITATION]);
  });
});

describe("history citation units", () => {
  const tools = (citation: unknown) => ({
    totalCalls: 1,
    failedCalls: 0,
    byTool: [{ name: (citation as { tool: string }).tool, calls: 1, failures: 0 }],
    historyReads: [citation],
  });
  const blame = {
    tool: "docsfab_history_blame",
    revisions: ["a".repeat(40)],
    paths: ["docs/guide.md"],
    ranges: [{ path: "docs/guide.md", unit: "lines", start: 1, end: 1 }],
    labels: ["history-paths-excluded", "history-shallow"],
    sha256: "c".repeat(64),
  };

  it("admits lines only from blame, from line 1, for the one path it blamed", () => {
    expect(decodeTools(tools(blame)).historyReads).toEqual([blame]);
    for (const [label, citation] of [
      [
        "show in lines",
        {
          ...CITATION,
          tool: "docsfab_history_show",
          revisions: ["a".repeat(40)],
          excludedPathCount: undefined,
          labels: [],
          ranges: [{ path: "src/app.ts", unit: "lines", start: 1, end: 1 }],
        },
      ],
      ["blame from line 0", { ...blame, ranges: [{ ...blame.ranges[0], start: 0 }] }],
      ["blame of another path", { ...blame, ranges: [{ ...blame.ranges[0], path: "src/app.ts" }] }],
      ["blame of two ranges", { ...blame, ranges: [blame.ranges[0], blame.ranges[0]] }],
      ["blame of two paths", { ...blame, paths: [blame.paths[0], "src/app.ts"] }],
      ["blame in entries", { ...blame, ranges: [{ ...blame.ranges[0], unit: "entries" }] }],
      ["blame of two revisions", { ...blame, revisions: ["a".repeat(40), "b".repeat(40)] }],
    ] as const) {
      expect(() => decodeTools(tools(JSON.parse(JSON.stringify(citation)))), label).toThrow();
    }
  });

  it("admits a search's served commits, each once, within its window and the catalogued maximum", () => {
    const scanMaximum = limitDefinition("gitHistory.pickaxeMaxCommitsScanned").max;
    const id = (index: number) => index.toString(16).padStart(40, "0");
    const search = {
      tool: "docsfab_history_search",
      revisions: ["a".repeat(40)],
      paths: ["docs"],
      ranges: [{ path: null, unit: "entries", start: 0, end: 3 }],
      labels: ["history-shallow"],
      matchedCommits: [id(1), id(2)],
      sha256: "c".repeat(64),
      nextCursor: "hc-0",
    };
    const atMaximum = {
      ...search,
      ranges: [{ path: null, unit: "entries", start: 0, end: scanMaximum }],
      matchedCommits: Array.from({ length: scanMaximum }, (_, index) => id(index + 1)),
    };
    for (const citation of [search, { ...search, matchedCommits: [] }, atMaximum]) {
      expect(decodeTools(tools(citation)).historyReads).toEqual([citation]);
    }
    for (const [label, citation] of [
      ["no served commits", { ...search, matchedCommits: undefined }],
      ["a commit twice", { ...search, matchedCommits: [id(1), id(1)] }],
      [
        "more than the catalogued maximum",
        {
          ...atMaximum,
          ranges: [{ path: null, unit: "entries", start: 0, end: scanMaximum + 1 }],
          matchedCommits: Array.from({ length: scanMaximum + 1 }, (_, index) => id(index + 1)),
        },
      ],
      ["more than the window", { ...search, matchedCommits: [id(1), id(2), id(3), id(4)] }],
      ["an abbreviated commit", { ...search, matchedCommits: [id(1).slice(0, 12)] }],
      ["a commit of another length", { ...search, matchedCommits: ["b".repeat(64)] }],
      ["a window with a path", { ...search, ranges: [{ ...search.ranges[0], path: "docs" }] }],
      ["a window in bytes", { ...search, ranges: [{ ...search.ranges[0], unit: "bytes" }] }],
      ["two windows", { ...search, ranges: [search.ranges[0], search.ranges[0]] }],
      [
        "an excluded count",
        { ...search, labels: ["history-paths-excluded"], excludedPathCount: 1 },
      ],
      ["served commits on a log", { ...search, tool: "docsfab_history_log" }],
    ] as const) {
      expect(() => decodeTools(tools(JSON.parse(JSON.stringify(citation)))), label).toThrow();
    }
  });
});
