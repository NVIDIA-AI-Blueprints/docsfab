// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/runtime-loader.js";
import type { RunRecord } from "../src/records/contracts.js";
import {
  buildSemanticEvidence,
  ConfiguredEvaluationJudge,
  SEMANTIC_RUBRIC_V1,
} from "../src/quality-evaluation/semantic.js";
import { evaluateRuns, parseEvaluationFixture } from "../src/quality-evaluation/structural.js";
import { validModelConfig } from "./helpers.js";

function record(
  id: string,
  summary = "The README lacks a supported installation example.",
): RunRecord {
  return {
    schemaVersion: 2,
    id,
    workflow: "readiness",
    repository: {
      sourcePath: "[OMITTED]",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    instruction: "Do not forward this requester text.",
    status: "succeeded",
    createdAt: "2026-08-03T00:00:00.000Z",
    models: [{ provider: "policy-provider", model: "policy-model" }],
    skills: [
      {
        id: "doc-context-analyzer",
        contentSha256: "b".repeat(64),
        bundleSha256: "c".repeat(64),
      },
    ],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      total: 2,
      turns: 1,
    },
    tools: {
      totalCalls: 1,
      failedCalls: 0,
      byTool: [{ name: "read", calls: 1, failures: 0 }],
    },
    securityScan: {
      ruleSet: "docsfab-local-v2",
      status: "passed",
      scannedFiles: 3,
      binaryFiles: 0,
      findings: [],
    },
    securityScanEffectiveDisposition: { status: "passed" },
    changes: {
      files: [{ path: "private/customer-name.md", status: "modified" }],
      patch: {
        sha256: "d".repeat(64),
        byteLength: 42,
        lineCount: 2,
        artifactPath: "[OMITTED]",
        format: "git-diff",
      },
    },
    steps: [
      {
        id: "readiness",
        title: "Readiness",
        skill: "doc-context-analyzer",
        mode: "read-only",
        status: "succeeded",
        summary,
      },
    ],
  };
}

const fixture = parseEvaluationFixture({
  version: 1,
  name: "semantic fixture",
  assertions: [
    { type: "run-count", minimum: 2 },
    { type: "status", equals: "succeeded" },
    { type: "summaries-present" },
  ],
});

describe("semantic evaluation", () => {
  it("sends a minimized evidence contract, redacts credentials, and keeps path-shaped summaries", () => {
    const evidence = buildSemanticEvidence({ name: fixture.name, version: fixture.version }, [
      record("one", `${["api", "key"].join("_")}=${"x".repeat(24)}`),
      record("two", `Evidence found under ${["", "host", "workspace", "README.md"].join("/")}`),
    ]);
    const serialized = JSON.stringify(evidence);

    expect(evidence.records[0]?.steps[0]?.summary).toBe("[REDACTED: credential-like content]");
    expect(evidence.records[1]?.steps[0]?.summary).toBe(
      "Evidence found under /host/workspace/README.md",
    );
    expect(serialized).not.toContain("x".repeat(24));
    expect(serialized).not.toContain("sourcePath");
    expect(serialized).not.toContain("requestedRevision");
    expect(serialized).not.toContain("Do not forward");
    expect(serialized).not.toContain("customer-name.md");
    expect(serialized).not.toContain("artifactPath");
    expect(serialized).not.toContain("policy-provider");
    expect(evidence.records[0]?.security).toEqual({
      ruleSet: "docsfab-local-v2",
      status: "passed",
      effectiveStatus: "passed",
      ruleIds: [],
    });
  });

  it("records rubric and judge identities for a deterministic fake judge", async () => {
    const result = await evaluateRuns({
      fixture,
      records: [record("one"), record("two")],
      judge: {
        identity: { provider: "fixture", model: "judge-v1" },
        grade: async ({ rubric, evidence }) => {
          expect(rubric).toEqual(SEMANTIC_RUBRIC_V1);
          expect(evidence.records).toHaveLength(2);
          return { passed: true, score: 0.85, rationale: "Evidence is actionable." };
        },
      },
    });

    expect(result.passed).toBe(true);
    expect(result.judge).toEqual({
      status: "passed",
      rubric: {
        id: "docsfab.semantic-evidence-quality",
        version: 1,
      },
      model: { provider: "fixture", model: "judge-v1" },
      score: 0.85,
      rationale: "Evidence is actionable.",
    });
  });

  it("skips the judge after structural failure with an explicit reason", async () => {
    let calls = 0;
    const result = await evaluateRuns({
      fixture,
      records: [record("only-one")],
      judge: {
        identity: { provider: "fixture", model: "judge-v1" },
        grade: async () => {
          calls += 1;
          return { passed: true, score: 1, rationale: "unreachable" };
        },
      },
    });

    expect(calls).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.judge).toMatchObject({
      status: "skipped",
      reason: "structural evaluation failed",
    });
  });

  it("reports disagreement without erasing deterministic success", async () => {
    const result = await evaluateRuns({
      fixture,
      records: [record("one"), record("two")],
      judge: {
        identity: { provider: "fixture", model: "judge-v1" },
        grade: async () => ({
          passed: false,
          score: 0.2,
          rationale: "The summaries are not specific enough.",
        }),
      },
    });

    expect(result.structural.passed).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.judge?.status).toBe("disagreed");
  });

  it("collapses judge errors without storing provider or transcript details", async () => {
    const result = await evaluateRuns({
      fixture,
      records: [record("one"), record("two")],
      judge: {
        identity: { provider: "fixture", model: "judge-v1" },
        grade: async () => {
          throw new Error("provider internal detail that must be omitted");
        },
      },
    });

    expect(result.passed).toBe(true);
    expect(result.judge).toMatchObject({
      status: "error",
      reason: "semantic judge failed",
    });
    expect(JSON.stringify(result)).not.toContain("provider internal detail");
  });

  it("validates deterministic fake completions through the configured adapter", async () => {
    const judge = new ConfiguredEvaluationJudge(validModelConfig, async () =>
      JSON.stringify({
        passed: true,
        score: 0.75,
        rationale: "Supported by the supplied evidence.",
      }),
    );

    await expect(
      judge.grade({
        rubric: SEMANTIC_RUBRIC_V1,
        evidence: buildSemanticEvidence({ name: fixture.name, version: fixture.version }, [
          record("one"),
          record("two"),
        ]),
      }),
    ).resolves.toEqual({
      passed: true,
      score: 0.75,
      rationale: "Supported by the supplied evidence.",
    });
  });
});

describe("live semantic judge smoke", () => {
  it.skipIf(process.env.DOCSFAB_LIVE_JUDGE_SMOKE !== "true")(
    "uses the separately configured judge only behind the explicit live gate",
    async () => {
      const config = loadConfig();
      if (!config.judge) {
        throw new Error("DOCSFAB_LIVE_JUDGE_SMOKE requires JUDGE_ENABLED=true.");
      }
      const resultPath = process.env.DOCSFAB_LIVE_JUDGE_RESULT?.trim();
      if (!resultPath) {
        throw new Error(
          "DOCSFAB_LIVE_JUDGE_SMOKE requires an explicit DOCSFAB_LIVE_JUDGE_RESULT path.",
        );
      }
      const result = await evaluateRuns({
        fixture,
        records: [record("live-one"), record("live-two")],
        judge: new ConfiguredEvaluationJudge(config.judge),
      });
      expect(result.judge?.status).toBe("passed");
      await writeFile(
        resultPath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            fixture: { name: fixture.name, version: fixture.version },
            structural: {
              passed: result.structural.passed,
              recordCount: result.structural.recordCount,
            },
            judge: result.judge,
          },
          null,
          2,
        )}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    },
    60_000,
  );
});
