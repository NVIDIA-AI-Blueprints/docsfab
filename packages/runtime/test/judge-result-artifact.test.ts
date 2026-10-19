// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  bindJudgeResultEnvelope,
  parseJudgeResultArtifact,
  SEMANTIC_RUBRIC_ID,
  SEMANTIC_RUBRIC_IDENTITY,
  SEMANTIC_RUBRIC_VERSION,
} from "../src/judge-result-artifact.js";
import { SEMANTIC_RUBRIC_V1 } from "../src/quality-evaluation/semantic.js";

function artifact(override: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    acceptanceId: "acceptance-test",
    testedCommit: "a".repeat(40),
    judgeProfileStatus: "current",
    inputRecords: [
      { id: "one", sha256: "1".repeat(64) },
      { id: "two", sha256: "2".repeat(64) },
    ],
    fixture: { name: "MVP live readiness acceptance", version: 1 },
    structural: { passed: true, recordCount: 2 },
    judge: {
      status: "passed",
      rubric: { id: SEMANTIC_RUBRIC_ID, version: SEMANTIC_RUBRIC_VERSION },
      model: { provider: "judge", model: "model" },
      score: 0.9,
    },
    ...override,
  };
}

describe("judge result artifact binder", () => {
  it("shares SEMANTIC_RUBRIC_V1 identity with the published rubric constant", () => {
    expect(SEMANTIC_RUBRIC_V1.id).toBe(SEMANTIC_RUBRIC_ID);
    expect(SEMANTIC_RUBRIC_V1.version).toBe(SEMANTIC_RUBRIC_VERSION);
    expect(SEMANTIC_RUBRIC_IDENTITY).toEqual({
      id: SEMANTIC_RUBRIC_V1.id,
      version: SEMANTIC_RUBRIC_V1.version,
    });
  });

  it("accepts a decided acceptance artifact and projects exact known keys", () => {
    const parsed = parseJudgeResultArtifact(artifact());
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      acceptanceId: "acceptance-test",
      judge: {
        status: "passed",
        rubric: SEMANTIC_RUBRIC_IDENTITY,
        model: { provider: "judge", model: "model" },
        score: 0.9,
      },
    });
    expect(Object.keys(parsed ?? {}).sort()).toEqual(
      [
        "acceptanceId",
        "fixture",
        "inputRecords",
        "judge",
        "judgeProfileStatus",
        "schemaVersion",
        "structural",
        "testedCommit",
      ].sort(),
    );
  });

  it("rejects extra top-level, judge, rubric, and input-record keys", () => {
    expect(parseJudgeResultArtifact({ ...artifact(), rawOutput: "no" })).toBeUndefined();
    expect(
      parseJudgeResultArtifact(
        artifact({
          judge: {
            status: "passed",
            rubric: { id: SEMANTIC_RUBRIC_ID, version: SEMANTIC_RUBRIC_VERSION },
            model: { provider: "judge", model: "model" },
            score: 0.9,
            rawOutput: "no",
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      parseJudgeResultArtifact(
        artifact({
          judge: {
            status: "passed",
            rubric: { id: SEMANTIC_RUBRIC_ID, version: SEMANTIC_RUBRIC_VERSION, extra: true },
            model: { provider: "judge", model: "model" },
            score: 0.9,
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      parseJudgeResultArtifact(
        artifact({
          inputRecords: [
            { id: "one", sha256: "1".repeat(64), raw: "no" },
            { id: "two", sha256: "2".repeat(64) },
          ],
        }),
      ),
    ).toBeUndefined();
  });

  it("rejects a drifted semantic rubric identity", () => {
    expect(
      parseJudgeResultArtifact(
        artifact({
          judge: {
            status: "passed",
            rubric: { id: "other.rubric", version: 1 },
            model: { provider: "judge", model: "model" },
            score: 0.9,
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      parseJudgeResultArtifact(
        artifact({
          judge: {
            status: "passed",
            rubric: { id: SEMANTIC_RUBRIC_ID, version: 2 },
            model: { provider: "judge", model: "model" },
            score: 0.9,
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("allows skipped acceptance judges without a score and rejects a leftover score", () => {
    expect(
      parseJudgeResultArtifact(
        artifact({
          judge: {
            status: "skipped",
            rubric: { id: SEMANTIC_RUBRIC_ID, version: SEMANTIC_RUBRIC_VERSION },
          },
        }),
      )?.judge,
    ).toEqual({
      status: "skipped",
      rubric: SEMANTIC_RUBRIC_IDENTITY,
    });
    expect(
      parseJudgeResultArtifact(
        artifact({
          judge: {
            status: "skipped",
            rubric: { id: SEMANTIC_RUBRIC_ID, version: SEMANTIC_RUBRIC_VERSION },
            score: 0.1,
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("requires a current two-record decided artifact for campaign matching", () => {
    const valid = artifact();
    expect(parseJudgeResultArtifact(valid, "campaign-acceptance")?.acceptanceId).toBe(
      "acceptance-test",
    );
    expect(
      parseJudgeResultArtifact(artifact({ judgeProfileStatus: "stale" }), "campaign-acceptance"),
    ).toBeUndefined();
    // A legacy acceptance artifact with a stale judge
    // profile still decodes outside campaign matching.
    expect(
      parseJudgeResultArtifact(artifact({ judgeProfileStatus: "stale" }))?.judgeProfileStatus,
    ).toBe("stale");
    expect(
      parseJudgeResultArtifact(
        artifact({
          judge: {
            status: "skipped",
            rubric: { id: SEMANTIC_RUBRIC_ID, version: SEMANTIC_RUBRIC_VERSION },
          },
        }),
        "campaign-acceptance",
      ),
    ).toBeUndefined();
    expect(
      parseJudgeResultArtifact(
        artifact({
          inputRecords: [{ id: "one", sha256: "1".repeat(64) }],
          structural: { passed: true, recordCount: 1 },
        }),
        "campaign-acceptance",
      ),
    ).toBeUndefined();
  });

  it("names missing versus invalid live campaign envelopes", () => {
    expect(bindJudgeResultEnvelope(undefined).ok).toBe(false);
    expect(bindJudgeResultEnvelope(undefined)).toEqual({
      ok: false,
      code: "judge-result-missing",
    });
    expect(
      bindJudgeResultEnvelope({
        status: "skipped",
        rubric: SEMANTIC_RUBRIC_IDENTITY,
      }),
    ).toEqual({ ok: false, code: "judge-result-missing" });
    expect(
      bindJudgeResultEnvelope({
        status: "passed",
        rubric: { id: "other.rubric", version: 1 },
        model: { provider: "judge", model: "model" },
        score: 0.9,
      }),
    ).toEqual({ ok: false, code: "judge-result-invalid" });
    expect(
      bindJudgeResultEnvelope({
        status: "error",
        rubric: SEMANTIC_RUBRIC_IDENTITY,
        model: { provider: "judge", model: "model" },
      }),
    ).toEqual({
      ok: true,
      envelope: {
        status: "error",
        rubric: SEMANTIC_RUBRIC_IDENTITY,
        model: { provider: "judge", model: "model" },
      },
    });
  });
});
