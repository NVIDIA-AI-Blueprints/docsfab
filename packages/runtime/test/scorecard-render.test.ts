// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assertSafeMvpScorecard,
  assertSanitizedScorecardArtifacts,
  prettyMvpScorecardJson,
  renderMvpScorecardMarkdown,
  ScorecardRenderError,
  serializeMvpScorecard,
} from "../src/scorecard-render.js";
import type { MvpScorecardV1, ScorecardFailureClass } from "../src/scorecard.js";

const SAMPLE_LIMITATION =
  "Five independent observations on one revision and model profile; this is not a confidence bound or shared-service SLO.";
const FAILURE_CLASSES: Array<Exclude<ScorecardFailureClass, "none">> = [
  "blank-response",
  "malformed-response",
  "context-exhausted",
  "timeout",
  "throttled",
  "provider-transient",
  "provider-terminal",
  "host-runtime-failure",
  "invalid-request",
  "no-progress",
  "policy-security-blocked",
  "policy-security-denied",
  "policy-scanner-failed",
  "policy-context-preflight",
  "unclassified",
];

describe("MVP scorecard renderer", () => {
  it("produces stable recursively sorted pretty JSON", () => {
    const scorecard = validScorecard();
    const reordered = reverseObjectKeys(scorecard) as MvpScorecardV1;

    const first = prettyMvpScorecardJson(scorecard);
    const second = serializeMvpScorecard(reordered);

    expect(first).toBe(second);
    expect(first).toMatch(/^\{\n  "campaign":/u);
    expect(first).toMatch(/\n  "schemaVersion": 1,\n  "structural": \{/u);
    expect(first).toMatch(/\n  \}\n\}\n$/u);
    expect(first.endsWith("\n")).toBe(true);
    expect(JSON.parse(first)).toEqual(JSON.parse(second));
  });

  it("renders a deterministic Markdown decision artifact solely from the scorecard", () => {
    const scorecard = validScorecard();
    const first = renderMvpScorecardMarkdown(scorecard);
    const second = renderMvpScorecardMarkdown(structuredClone(scorecard));

    expect(first).toBe(second);
    expect(first).toContain("Decision: **ready for internal MVP dogfood**");
    expect(first).toContain("Sample size: **n=5** independent observations.");
    expect(first).toContain(`Sample-size limitation (n=5): ${SAMPLE_LIMITATION}`);
    expect(first).toContain("| `blank-response` | 0 | 0 |");
    expect(first).toContain("| 5 | `run-5` | `555555555555`");
    expect(first).toContain("Raw records remain operator-private and are not committed.");
    expect(first).not.toContain("rationale");
    expect(first.endsWith("\n")).toBe(true);
  });

  it("binds JSON and Markdown as an exact reproducible artifact pair", () => {
    const scorecard = validScorecard();
    const json = serializeMvpScorecard(scorecard);
    const markdown = renderMvpScorecardMarkdown(scorecard);

    expect(() => assertSanitizedScorecardArtifacts(json, markdown)).not.toThrow();
    expect(() => assertSanitizedScorecardArtifacts(`${json} `, markdown)).toThrowError(
      ScorecardRenderError,
    );
    expect(() =>
      assertSanitizedScorecardArtifacts(json, `${markdown}unreviewed prose\n`),
    ).toThrowError(ScorecardRenderError);
  });

  it("renders every skipped judge gate with an explicit owner and reason", () => {
    const scorecard = validScorecard();
    scorecard.judge = {
      status: "skipped",
      owner: "docsfab-maintainers",
      issue: 5,
      reason: "judge-destination-not-approved",
      reviewOn: "2026-08-17",
    };
    scorecard.gates.semanticJudge = "contained";
    scorecard.decision = "ready with contained limitations";
    scorecard.decisionReasons = ["semantic-judge-contained"];

    const markdown = renderMvpScorecardMarkdown(scorecard);

    expect(markdown).toContain(
      "| Semantic judge | `contained` | `docsfab-maintainers` | `judge-destination-not-approved` |",
    );
    expect(markdown).toContain("- Owner: `docsfab-maintainers`");
    expect(markdown).toContain("- Reason: `judge-destination-not-approved`");
  });

  it.each([
    [
      "credential-like content",
      (value: MvpScorecardV1) => {
        value.inputs.structuralFixture.name = "glpat-1234567890abcdefghijk";
      },
    ],
    [
      "forbidden raw key",
      (value: MvpScorecardV1) => {
        (value as unknown as Record<string, unknown>).prompt = "MODEL_OUTPUT_SENTINEL";
      },
    ],
    [
      "absolute host path",
      (value: MvpScorecardV1) => {
        value.inputs.structuralFixture.name = "/Users/operator/PRIVATE_PATH_SENTINEL";
      },
    ],
    [
      "control character",
      (value: MvpScorecardV1) => {
        value.campaign.id = "campaign\u0000injected";
      },
    ],
    [
      "Markdown table injection",
      (value: MvpScorecardV1) => {
        value.runs[0]!.id = "run-1|forged-row";
      },
    ],
    [
      "judge rationale",
      (value: MvpScorecardV1) => {
        (value.judge as unknown as Record<string, unknown>).rationale =
          "PRIVATE_JUDGE_RATIONALE_SENTINEL";
      },
    ],
    [
      "unallowlisted decision prose",
      (value: MvpScorecardV1) => {
        value.decisionReasons = ["looks ready to me"];
      },
    ],
  ])("rejects %s without echoing rejected content", (_name, mutate) => {
    const scorecard = validScorecard();
    mutate(scorecard);
    let error: unknown;
    try {
      assertSafeMvpScorecard(scorecard);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ScorecardRenderError);
    expect(String(error)).not.toContain("MODEL_OUTPUT_SENTINEL");
    expect(String(error)).not.toContain("PRIVATE_PATH_SENTINEL");
    expect(String(error)).not.toContain("PRIVATE_JUDGE_RATIONALE_SENTINEL");
    expect(String(error)).not.toContain("glpat-");
  });

  it.each([
    [
      "campaign sample",
      (value: MvpScorecardV1) => {
        (value.campaign as { sampleSize: number }).sampleSize = 4;
      },
    ],
    [
      "reliability sample",
      (value: MvpScorecardV1) => {
        (value.reliability as { sampleSize: number }).sampleSize = 4;
      },
    ],
    [
      "reliability denominator",
      (value: MvpScorecardV1) => {
        (value.reliability.observedReliability as { denominator: number }).denominator = 4;
      },
    ],
    [
      "sample limitation",
      (value: MvpScorecardV1) => {
        (value.reliability as { sampleLimitation: string }).sampleLimitation =
          "Many observations prove production reliability.";
      },
    ],
    [
      "run count",
      (value: MvpScorecardV1) => {
        value.runs.pop();
      },
    ],
  ])("rejects a forged n=5 invariant in %s", (_name, mutate) => {
    const scorecard = validScorecard();
    mutate(scorecard);
    expect(() => renderMvpScorecardMarkdown(scorecard)).toThrowError(ScorecardRenderError);
    expect(() => serializeMvpScorecard(scorecard)).toThrowError(ScorecardRenderError);
  });

  it("rejects cross-field changes that could forge the decision", () => {
    const scorecard = validScorecard();
    scorecard.decision = "not ready";
    scorecard.decisionReasons = ["campaign-observed-failure"];

    expect(() => renderMvpScorecardMarkdown(scorecard)).toThrowError(
      new ScorecardRenderError("inconsistent-scorecard"),
    );
  });

  it("publishes an authentic zero-attempt local-policy failure as a strict no-go", () => {
    const scorecard = zeroAttemptPolicyFailureScorecard();

    expect(() => assertSafeMvpScorecard(scorecard)).not.toThrow();
    expect(serializeMvpScorecard(scorecard)).toContain('"attempts": 0');
    expect(renderMvpScorecardMarkdown(scorecard)).toContain(
      "| 5 | `run-5` | `555555555555` | `failed` | `policy-security-blocked` | failed | 50 | 0 | 0 |",
    );
  });

  it.each([
    [
      "nonzero usage",
      (value: MvpScorecardV1) => {
        value.runs[4]!.usage.input = 1;
        value.runs[4]!.usage.total = 1;
      },
    ],
    [
      "a retry",
      (value: MvpScorecardV1) => {
        value.runs[4]!.retries = 1;
      },
    ],
    [
      "a provider failure",
      (value: MvpScorecardV1) => {
        value.runs[4]!.failureClass = "provider-terminal";
        value.reliability.terminalFailures["policy-security-blocked"] = 0;
        value.reliability.terminalFailures["provider-terminal"] = 1;
      },
    ],
  ])("rejects a zero-attempt run with %s", (_label, mutate) => {
    const scorecard = zeroAttemptPolicyFailureScorecard();
    mutate(scorecard);

    expect(() => assertSafeMvpScorecard(scorecard)).toThrowError(
      new ScorecardRenderError("invalid-shape"),
    );
  });

  it("reconciles sub-micro costs with the core twelve-decimal convention", () => {
    const scorecard = validScorecard();
    scorecard.runs.forEach((run, index) => {
      run.usage.cost = (index + 1) / 10_000_000;
    });
    scorecard.reliability.usage.cost = 0.0000015;

    expect(() => assertSafeMvpScorecard(scorecard)).not.toThrow();
    expect(serializeMvpScorecard(scorecard)).toContain('"cost": 0.0000015');
  });

  it("rejects impossible dates with a renderer error instead of throwing RangeError", () => {
    const scorecard = validScorecard();
    scorecard.modelProfile.reviewAfter = "2026-99-99";

    expect(() => assertSafeMvpScorecard(scorecard)).toThrowError(
      new ScorecardRenderError("invalid-shape"),
    );
  });

  it("rejects an uppercase campaign id and uppercase artifact hash", () => {
    const mixedId = validScorecard();
    mixedId.campaign.id = "Campaign-1";
    expect(() => assertSafeMvpScorecard(mixedId)).toThrowError(ScorecardRenderError);

    const mixedHash = validScorecard();
    mixedHash.campaign.declarationSha256 = "A".repeat(64);
    expect(() => assertSafeMvpScorecard(mixedHash)).toThrowError(ScorecardRenderError);
  });

  it("does not publish a self-attested failed artifact-sanitization gate", () => {
    const scorecard = validScorecard();
    scorecard.gates.artifactSanitization = "failed";
    scorecard.decision = "not ready";
    scorecard.decisionReasons = ["local-verification-failed"];

    expect(() => serializeMvpScorecard(scorecard)).toThrowError(
      new ScorecardRenderError("invalid-shape"),
    );
  });

  it("finalizes the sanitization gate only while producing validated artifacts", () => {
    const scorecard = validScorecard();
    scorecard.gates.artifactSanitization = "pending";

    const json = serializeMvpScorecard(scorecard);
    const markdown = renderMvpScorecardMarkdown(scorecard);

    expect(JSON.parse(json).gates.artifactSanitization).toBe("passed");
    expect(markdown).toContain("| Artifact sanitization | `passed` |");
    expect(scorecard.gates.artifactSanitization).toBe("pending");
    expect(() => assertSanitizedScorecardArtifacts(json, markdown)).not.toThrow();
  });
});

function validScorecard(): MvpScorecardV1 {
  const runs: MvpScorecardV1["runs"] = [1, 2, 3, 4, 5].map((slot) => ({
    slot,
    id: `run-${slot}`,
    sha256: String(slot).repeat(64),
    structuralPassed: true,
    successClass: "succeeded",
    failureClass: "none",
    durationMs: slot * 10,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 1,
      cacheWrite: 1,
      total: 4,
      turns: 1,
      cost: slot / 100,
    },
    attempts: 1,
    retries: 0,
  }));
  return {
    schemaVersion: 1,
    kind: "docsfab-mvp-stabilization-scorecard",
    campaign: {
      id: "campaign-1",
      evaluatedAt: "2026-08-04T04:00:00.000Z",
      testedCommit: "a".repeat(40),
      generatorRevision: "b".repeat(40),
      declarationSha256: "c".repeat(64),
      sampleSize: 5,
    },
    decision: "ready for internal MVP dogfood",
    decisionReasons: ["all-internal-mvp-gates-passed"],
    modelProfile: {
      provider: "nvidia-inference-api",
      model: "azure/openai/gpt-5.4",
      status: "current",
      sha256: "d".repeat(64),
      pricing: "known",
      reviewAfter: "2026-08-17",
    },
    inputs: {
      structuralFixture: {
        name: "Multi-turn governed live readiness",
        version: 1,
        sha256: "e".repeat(64),
      },
      acceptanceManifest: {
        sha256: "f".repeat(64),
        passed: true,
        live: true,
      },
      dependency: {
        advisoryId: "GHSA-mh99-v99m-4gvg",
        status: "resolved",
        owner: "docsfab-maintainers",
        packageStateSha256: "0".repeat(64),
      },
    },
    reliability: {
      sampleSize: 5,
      successes: 5,
      failures: 0,
      observedReliability: { numerator: 5, denominator: 5, percentage: 100 },
      firstAttemptSuccesses: 5,
      recoveredRuns: 0,
      incidents: zeroFailureCounts(),
      terminalFailures: zeroFailureCounts(),
      latencyMs: { minimum: 10, median: 30, maximum: 50, sum: 150, mean: 30 },
      usage: {
        input: 5,
        output: 5,
        cacheRead: 5,
        cacheWrite: 5,
        total: 20,
        turns: 5,
        cost: 0.15,
      },
      attempts: 5,
      retries: 0,
      scheduledBackoffMs: 0,
      sampleLimitation: SAMPLE_LIMITATION,
    },
    structural: { passed: true, failedCampaignAssertions: [] },
    runs,
    gates: {
      fiveRunCampaign: "passed",
      structuralEvaluation: "passed",
      packagedLiveAcceptance: "passed",
      modelProfileProvenance: "passed",
      dependencyAdvisory: "passed",
      semanticJudge: "passed",
      artifactSanitization: "passed",
      npmCheck: "passed",
      npmBuild: "passed",
      gitDiffCheck: "passed",
    },
    judge: {
      status: "passed",
      rubric: { id: "docsfab.semantic-evidence-quality", version: 1 },
      model: { provider: "judge-provider", model: "judge/model" },
      score: 0.9,
      evidenceSha256: "1".repeat(64),
    },
    remainingWork: [
      {
        issue: 7,
        scope: "shared-service",
        owner: "docsfab-maintainers",
        reason: "external-governance",
      },
      {
        issue: 28,
        scope: "issue-28-dogfood",
        owner: "docsfab-maintainers",
        reason: "product-validation",
      },
    ],
    rawRecords: { location: "operator-private", committed: false },
  };
}

function zeroAttemptPolicyFailureScorecard(): MvpScorecardV1 {
  const scorecard = validScorecard();
  scorecard.runs[4] = {
    ...scorecard.runs[4]!,
    structuralPassed: false,
    successClass: "failed",
    failureClass: "policy-security-blocked",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      turns: 0,
    },
    attempts: 0,
    retries: 0,
  };
  scorecard.reliability.successes = 4;
  scorecard.reliability.failures = 1;
  scorecard.reliability.observedReliability = {
    numerator: 4,
    denominator: 5,
    percentage: 80,
  };
  scorecard.reliability.firstAttemptSuccesses = 4;
  scorecard.reliability.terminalFailures["policy-security-blocked"] = 1;
  scorecard.reliability.usage = {
    input: 4,
    output: 4,
    cacheRead: 4,
    cacheWrite: 4,
    total: 16,
    turns: 4,
  };
  scorecard.reliability.attempts = 4;
  scorecard.structural.passed = false;
  scorecard.gates.fiveRunCampaign = "failed";
  scorecard.gates.structuralEvaluation = "failed";
  scorecard.decision = "not ready";
  scorecard.decisionReasons = [
    "campaign-observed-failure",
    "campaign-structural-failure",
    "pricing-unknown",
  ];
  return scorecard;
}

function zeroFailureCounts(): MvpScorecardV1["reliability"]["incidents"] {
  return Object.fromEntries(
    FAILURE_CLASSES.map((item) => [item, 0]),
  ) as MvpScorecardV1["reliability"]["incidents"];
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, item]) => [key, reverseObjectKeys(item)]),
  );
}
