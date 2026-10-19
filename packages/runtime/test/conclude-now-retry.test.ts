// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The no-progress retry row: an attempt the host stopped for re-reading
 * unchanged content is retried once, and that retry concludes now at its first
 * withheld re-read. Writer and decider cases drive `executeInferenceStep` with
 * the error the harness raises; no request leaves the host.
 */
import { describe, expect, it } from "vitest";

import { limit } from "../src/config/limits.js";
import { parseRetryPolicy } from "../src/config/retry-policy.js";
import { RETRY_RULES } from "../src/contracts/model-output.generated.js";
import { retryCategoriesPinLine } from "../src/doctor.js";
import type { InferenceRetryPolicy } from "../src/execution/contracts.js";
import { InferenceStepError } from "../src/execution/contracts.js";
import { responseCorrectionInstruction } from "../src/harness/response-correction.js";
import type { InferenceExecutionEvidence } from "../src/records/contracts.js";
import { inferenceConditionRetryability } from "../src/records/inference-retry-disposition.js";
import {
  inferenceAttemptRulesConsistent,
  projectRetryRules,
} from "../src/records/inference-retry-rule.js";
import { UNCODED_RESPONSE_CORRECTION } from "../src/harness/response-correction.js";
import type { RunRecord } from "../src/records/contracts.js";
import { evaluateStructure, parseEvaluationFixture } from "../src/quality-evaluation/structural.js";
import {
  concludeNowAfterTransportEvidence,
  readLoopStop,
  throttle,
  runScriptedInferenceStep,
  type ScriptedAttempt,
} from "./support/conclude-now-transport-record.js";

const catalog = (name: string) => limit(name, { environment: {} }).value;

function policy(overrides: Partial<InferenceRetryPolicy> = {}): InferenceRetryPolicy {
  return { ...parseRetryPolicy({}), baseDelayMs: 0, maxDelayMs: 0, ...overrides };
}

const noProgress = readLoopStop;

async function run(script: readonly ScriptedAttempt[], retryPolicy = policy()) {
  const { execution, corrections } = await runScriptedInferenceStep(script, retryPolicy);
  return { execution, corrections, rules: execution.evidence.attempts.map((a) => a.retryRule) };
}

/** The structural evaluator's turn-governance verdict on one step's evidence. */
function structuralGovernance(evidence: InferenceExecutionEvidence): string {
  const record = {
    id: "conclude-now-structural",
    repository: { revision: "a".repeat(40) },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "audit-documentation",
        status: "succeeded",
        mode: "read-only",
        inference: structuredClone(evidence),
      },
    ],
  } as unknown as RunRecord;
  const fixture = parseEvaluationFixture({
    version: 1,
    name: "conclude-now after transport",
    assertions: [{ type: "turn-governance-evidence" }],
  });
  return evaluateStructure(fixture, [record]).results[0]?.message ?? "";
}

describe("a no-progress stop is retried once, and the retry concludes now", () => {
  it("records retried-no-progress and hands the retry its rule", async () => {
    const { execution, rules, corrections } = await run([noProgress, "ok"]);
    expect(execution.status).toBe("succeeded");
    expect(rules).toEqual(["retried-no-progress", "not-applicable"]);
    expect(execution.evidence.attempts[0]).toMatchObject({
      outcome: "no-progress",
      retryable: true,
      conditionRetryability: "eligible",
      retryDecision: "retried",
    });
    expect(corrections[1]).toEqual({ retryRule: "retried-no-progress" });
    // The retry's own record keeps when the host asked for the answer.
    expect(execution.evidence.attempts[1]?.concludeNow).toEqual({ trigger: "read-loop", turn: 3 });
    expect(inferenceAttemptRulesConsistent(execution.evidence, execution.evidence.attempts)).toBe(
      true,
    );
    expect(execution.evidence.conditionRetry).toMatchObject({
      maxNoProgressRetries: catalog("retry.maxNoProgressRetries"),
    });
  });

  it("stops the second no-progress by name, and keeps it off the timeout budget", async () => {
    const { rules } = await run([noProgress, noProgress]);
    expect(rules).toEqual(["retried-no-progress", "exhausted-no-progress-budget"]);
    // Adjacent: a no-progress stop after a timeout retry still has its own retry.
    const timeout = () =>
      new InferenceStepError("timed out", "timeout", true, undefined, undefined, {
        condition: "attempt-deadline",
      });
    expect((await run([timeout, noProgress, "ok"])).rules).toEqual([
      "retried-attempt-deadline",
      "retried-no-progress",
      "not-applicable",
    ]);
  });

  it("keeps the conclude-now record on a retry whose forced answer was refused", async () => {
    const refusedForcedAnswer = () =>
      new InferenceStepError(
        "contract refusal",
        "malformed-response",
        true,
        { concludeNow: { trigger: "read-loop", turn: 5 } },
        { code: "invalid-shape", location: "$" },
      );
    const { execution, corrections } = await run([noProgress, refusedForcedAnswer, "ok"]);
    expect(execution.evidence.attempts.map((attempt) => attempt.retryRule)).toEqual([
      "retried-no-progress",
      "retried-contract-correction",
      "not-applicable",
    ]);
    expect(execution.evidence.attempts[1]?.concludeNow).toEqual({ trigger: "read-loop", turn: 5 });
    // The contract retry corrects the refused answer, so it is no conclude-now retry.
    expect(corrections[2]?.retryRule).toBeUndefined();
    expect(execution.evidence.attempts[2]?.concludeNow).toBeUndefined();
    expect(inferenceAttemptRulesConsistent(execution.evidence, execution.evidence.attempts)).toBe(
      true,
    );
    // Only a transport retry passes the conclude-now correction on, so a
    // forced-answer marker after the contract retry is refused.
    const forged = structuredClone(execution.evidence);
    forged.attempts[2]!.concludeNow = { trigger: "read-loop", turn: 2 };
    expect(inferenceAttemptRulesConsistent(forged, forged.attempts)).toBe(false);
  });

  it("keeps the conclude-now retry across a transport retry, in a record every reader admits", async () => {
    const { execution, corrections, rules } = await run([noProgress, throttle, "ok"]);
    expect(rules).toEqual(["retried-no-progress", "retried-transport", "not-applicable"]);
    // The transport retry re-sends the conclude-now correction ...
    expect(corrections[2]).toEqual({ retryRule: "retried-no-progress" });
    // ... so the attempt after it withdraws the tools and says so.
    expect(execution.evidence.attempts[2]?.concludeNow).toEqual({ trigger: "read-loop", turn: 3 });
    // The structural evaluator re-derives the rules; the scorecard decoder,
    // which also needs the harness's per-attempt evidence, is covered in
    // pi-harness-read-loop, and the run-record and corpus readers in
    // evaluation-corpus-live.
    expect(structuralGovernance(execution.evidence)).not.toContain("retry rules disagree");
    expect(inferenceAttemptRulesConsistent(execution.evidence, execution.evidence.attempts)).toBe(
      true,
    );
    // The helper's clock is the script's, so a second run writes the same record.
    expect(await concludeNowAfterTransportEvidence()).toEqual(execution.evidence);
    // Adjacent: a transport fault on the first attempt carries no conclude-now ask.
    const first = await run([throttle, "ok"]);
    expect(first.corrections[1]).toBeUndefined();
    expect(first.execution.evidence.attempts[1]?.concludeNow).toBeUndefined();
  });

  it("declines by name when the no-progress budget is 0", async () => {
    const { rules } = await run([noProgress], policy({ maxNoProgressRetries: 0 }));
    expect(rules).toEqual(["declined-no-progress-allowance"]);
  });

  it("refuses a conclude-now record on an attempt no conclude-now rule scheduled", async () => {
    const { execution } = await run([noProgress, "ok"]);
    const evidence = structuredClone(execution.evidence);
    // Moved onto the first attempt, which no rule asked to conclude now.
    evidence.attempts[0]!.concludeNow = { trigger: "read-loop", turn: 2 };
    expect(inferenceAttemptRulesConsistent(evidence, evidence.attempts)).toBe(false);
    // A malformed shape is refused too.
    const malformed = structuredClone(execution.evidence);
    malformed.attempts[1]!.concludeNow = { trigger: "read-loop", turn: 0 };
    expect(inferenceAttemptRulesConsistent(malformed, malformed.attempts)).toBe(false);
  });

  it("puts the rule's statement in the retry prompt, not the generic contract text", () => {
    const feedback = responseCorrectionInstruction({ retryRule: "retried-no-progress" });
    expect(feedback).toContain(RETRY_RULES["retried-no-progress"].statement!);
    expect(feedback).not.toContain(UNCODED_RESPONSE_CORRECTION);
  });
});

describe("records written before the no-progress budget keep decoding", () => {
  /** A no-progress stop as a record from the read-loop release recorded it. */
  function legacyEvidence(conditionRetry?: InferenceExecutionEvidence["conditionRetry"]) {
    const evidence: InferenceExecutionEvidence = {
      configuredMaxRetries: 3,
      effectiveMaxRetries: 3,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryableCategories: [
        "blank-response",
        "malformed-response",
        "timeout",
        "throttled",
        "provider-transient",
      ],
      replay: "read-only",
      ...(conditionRetry ? { conditionRetry } : {}),
      attempts: [
        {
          attempt: 1,
          outcome: "no-progress",
          retryable: false,
          retryScheduled: false,
          conditionRetryability: "not-eligible",
          retryDecision: "not-applicable",
          ...(conditionRetry ? { retryRule: "not-applicable" as const } : {}),
          durationMs: 1,
        },
      ],
    };
    return evidence;
  }

  it("reads a record with no condition budgets as a terminal no-progress", () => {
    const evidence = legacyEvidence();
    expect(
      inferenceConditionRetryability("no-progress", {
        noProgressRetry: false,
      }),
    ).toBe("not-eligible");
    expect(inferenceAttemptRulesConsistent(evidence, evidence.attempts)).toBe(true);
  });

  it("reads a record with the two older condition budgets the same way", () => {
    const evidence = legacyEvidence({ maxTimeoutRetries: 1, maxCutAnswerRetries: 1 });
    expect(projectRetryRules(evidence, evidence.attempts)).toEqual(["not-applicable"]);
    expect(inferenceAttemptRulesConsistent(evidence, evidence.attempts)).toBe(true);
  });
});

describe("hosts that pinned the former default category list", () => {
  it("are told by name that the pin omits no-progress", () => {
    const pinned = parseRetryPolicy({
      DOCSFAB_RETRYABLE_CATEGORIES:
        "blank-response,malformed-response,timeout,throttled,provider-transient",
    });
    expect(retryCategoriesPinLine(pinned)).toContain("omits no-progress");
    // Adjacent: the default and a deliberately narrowed list say nothing.
    expect(retryCategoriesPinLine(parseRetryPolicy({}))).toBeUndefined();
    expect(
      retryCategoriesPinLine(parseRetryPolicy({ DOCSFAB_RETRYABLE_CATEGORIES: "timeout" })),
    ).toBeUndefined();
  });

  it("still start with retries off, applying 0 to the no-progress budget", () => {
    expect(parseRetryPolicy({ DOCSFAB_READ_ONLY_MAX_RETRIES: "0" }).maxNoProgressRetries).toBe(0);
    expect(() =>
      parseRetryPolicy({
        DOCSFAB_READ_ONLY_MAX_RETRIES: "1",
        DOCSFAB_READ_ONLY_MAX_NO_PROGRESS_RETRIES: "2",
      }),
    ).toThrow(
      "DOCSFAB_READ_ONLY_MAX_NO_PROGRESS_RETRIES must be less than or equal to DOCSFAB_READ_ONLY_MAX_RETRIES.",
    );
  });
});
