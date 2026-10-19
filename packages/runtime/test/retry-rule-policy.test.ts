// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * One host-owned correction policy for structured-answer steps (#1733).
 *
 * Raise sites classify a failed attempt (`retryable`, `condition`); the one
 * decider (`projectRetryRules`, records/inference-retry-rule.ts) picks the
 * catalog retry rule, and the writer records it on the attempt. Every case
 * here drives the shipped writer, `executeInferenceStep`, with the failure
 * shape the harness raises; no request leaves the host.
 */
import { describe, expect, it } from "vitest";

import { limit } from "../src/config/limits.js";
import {
  decodeHostConfig,
  projectHostConfigToEnvironment,
} from "../src/config/profile-projection.js";
import { parseRetryPolicy } from "../src/config/retry-policy.js";
import { RETRY_RULES } from "../src/contracts/model-output.generated.js";
import type {
  HarnessStepInput,
  HarnessStepResult,
  InferenceRetryPolicy,
} from "../src/execution/contracts.js";
import { InferenceStepError } from "../src/execution/contracts.js";
import { markStitchedReplyRefusal } from "../src/harness/length-stop-continuation.js";
import { responseCorrectionInstruction } from "../src/harness/response-correction.js";
import { decideSentProviderFailure } from "../src/model/sent-provider-failure.js";
import {
  formatStepRetryDispositionSentence,
  INFERENCE_RETRY_DECISION_TOKENS,
  inferenceRetryDecisionToken,
  readTerminalRetryDisposition,
} from "../src/operator/retry-disposition.js";
import type {
  InferenceAttemptEvidence,
  InferenceExecutionEvidence,
  InferenceFailureCategory,
  InferenceFailureCondition,
} from "../src/records/contracts.js";
import {
  inferenceAttemptRulesConsistent,
  projectRetryRules,
  type RetryRuleAttempt,
  type RetryRuleExecution,
} from "../src/records/inference-retry-rule.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import {
  decodeVerificationResponse,
  wrapTechnicalReviewFailure,
} from "../src/workflow-execution/review-response.js";

const catalog = (name: string) => limit(name, { environment: {} }).value;
const MAX_RETRIES = catalog("retry.maxRetries");

const ALL_CATEGORIES: InferenceFailureCategory[] = [
  "blank-response",
  "malformed-response",
  "timeout",
  "throttled",
  "provider-transient",
];

/** The catalog policy, with zero waits so a test never sleeps. */
function policy(overrides: Partial<InferenceRetryPolicy> = {}): InferenceRetryPolicy {
  return { ...parseRetryPolicy({}), baseDelayMs: 0, maxDelayMs: 0, ...overrides };
}

const PROSE_REPLY = "I'll perform a fresh technical review of the page against the source.";

/** The error the harness raises for a prose reply to the verification contract. */
function proseRefusal(): InferenceStepError {
  try {
    decodeVerificationResponse(PROSE_REPLY);
  } catch (error) {
    return wrapTechnicalReviewFailure(error);
  }
  throw new Error("expected the prose reply to be refused");
}

function malformed(): InferenceStepError {
  return new InferenceStepError("contract refusal", "malformed-response", true, undefined, {
    code: "invalid-shape",
    location: "$",
  });
}

function cutAnswer(): InferenceStepError {
  return new InferenceStepError(
    "Provider turn failed: text-truncated.",
    "malformed-response",
    true,
    undefined,
    { code: "text-truncated", location: "$response" },
    { condition: "cut-answer" },
  );
}

function deadline(): InferenceStepError {
  return new InferenceStepError(
    "Model request failed [timeout; retryable=true]: attempt timed out.",
    "timeout",
    true,
    undefined,
    undefined,
    { condition: "attempt-deadline" },
  );
}

function providerTimeout(): InferenceStepError {
  return new InferenceStepError("Model request failed: 408 timed out.", "timeout", true);
}

function unsafeDisclosure(): InferenceStepError {
  return new InferenceStepError("disclosure", "malformed-response", false, undefined, {
    code: "unsafe-disclosure",
    location: "$",
  });
}

type Script = ReadonlyArray<(() => InferenceStepError) | "ok">;

async function run(script: Script, retryPolicy: InferenceRetryPolicy = policy()) {
  const corrections: Array<HarnessStepInput["responseCorrection"]> = [];
  const execution = await executeInferenceStep({
    mode: "read-only",
    policy: retryPolicy,
    sleep: async () => {},
    execute: async (attempt, correction): Promise<HarnessStepResult> => {
      corrections.push(correction);
      const step = script[attempt - 1];
      if (step === undefined) throw new Error(`no scripted attempt ${attempt}`);
      if (step === "ok") return { summary: "admitted", answerBytes: 42 };
      throw step();
    },
  });
  return { execution, corrections, rules: execution.evidence.attempts.map((a) => a.retryRule) };
}

describe("a prose reply to a JSON contract is re-asked, not declined", () => {
  it("records retried-unframed-reply and tells the retry to return only the object", async () => {
    const refusal = proseRefusal();
    // The raiser classifies; it no longer decides.
    expect(refusal.retryable).toBe(true);
    expect(refusal.condition).toBe("unframed-reply");

    const { execution, rules, corrections } = await run([proseRefusal, "ok"]);

    expect(execution.status).toBe("succeeded");
    expect(rules).toEqual(["retried-unframed-reply", "not-applicable"]);
    expect(execution.evidence.attempts[0]).toMatchObject({
      retryDecision: "retried",
      condition: "unframed-reply",
      rejection: { code: "json-unexpected-token", location: "$response" },
    });
    // The retry prompt carries the catalog statement, then the family rule.
    const feedback = responseCorrectionInstruction(corrections[1]);
    expect(feedback).toContain(RETRY_RULES["retried-unframed-reply"].statement!);
    expect(feedback).toContain("The previous response failed host rule json-unexpected-token");
    // The prose itself never reaches the retry.
    expect(feedback).not.toContain(PROSE_REPLY);
  });

  it("keeps a terminal refusal terminal (adjacent: unsafe-disclosure)", async () => {
    const { execution, rules } = await run([unsafeDisclosure]);
    expect(execution.status).toBe("failed");
    expect(rules).toEqual(["declined-host-refusal"]);
    expect(execution.evidence.attempts[0]?.retryDecision).toBe("declined");
  });
});

describe("a cut answer gets its own small budget", () => {
  it("retries one cut, then stops the next by name, while a malformed reply still retries", async () => {
    const { execution, rules, corrections } = await run([cutAnswer, malformed, cutAnswer]);
    expect(execution.status).toBe("failed");
    expect(rules).toEqual([
      "retried-cut-answer",
      "retried-contract-correction",
      "exhausted-cut-answer-budget",
    ]);
    expect(execution.evidence.attempts.at(-1)?.retryDecision).toBe("exhausted");
    expect(responseCorrectionInstruction(corrections[1])).toContain(
      RETRY_RULES["retried-cut-answer"].statement!,
    );
  });

  it("counts cut retries already scheduled, not the attempt ordinal", async () => {
    // A cut on contract attempt 3 is the first cut, so it still gets its retry.
    const { rules } = await run([malformed, malformed, cutAnswer, "ok"]);
    expect(rules).toEqual([
      "retried-contract-correction",
      "retried-contract-correction",
      "retried-cut-answer",
      "not-applicable",
    ]);
  });

  it("marks a refused stitched answer cut-answer and keeps the raiser's correctability", () => {
    const marked = markStitchedReplyRefusal(malformed(), 1) as InferenceStepError;
    expect(marked.condition).toBe("cut-answer");
    expect(marked.retryable).toBe(true);
  });

  it("declines by name when the cut budget is 0", async () => {
    const { rules } = await run([cutAnswer], policy({ maxCutAnswerRetries: 0 }));
    expect(rules).toEqual(["declined-no-cut-answer-allowance"]);
  });
});

describe("a timed-out attempt is retried once, and the record says which timer fired", () => {
  it("retries a host deadline that follows a malformed attempt (9e5c3a84's shape)", async () => {
    const { execution, rules, corrections } = await run([malformed, deadline, "ok"]);
    expect(execution.status).toBe("succeeded");
    expect(rules).toEqual([
      "retried-contract-correction",
      "retried-attempt-deadline",
      "not-applicable",
    ]);
    expect(execution.evidence.attempts[1]?.condition).toBe("attempt-deadline");
    // The retry carries only the deadline statement.
    expect(corrections[2]).toEqual({ condition: "attempt-deadline" });
    expect(responseCorrectionInstruction(corrections[2])).toContain(
      RETRY_RULES["retried-attempt-deadline"].statement!,
    );
  });

  it("records a provider timeout as distinct, with no feedback", async () => {
    const { execution, rules, corrections } = await run([providerTimeout, "ok"]);
    expect(rules).toEqual(["retried-provider-timeout", "not-applicable"]);
    expect(execution.evidence.attempts[0]?.condition).toBe("provider-timeout");
    expect(corrections[1]).toBeUndefined();
  });

  it("stops the second timeout by name", async () => {
    const { execution, rules } = await run([deadline, providerTimeout]);
    expect(execution.status).toBe("failed");
    expect(rules).toEqual(["retried-attempt-deadline", "exhausted-timeout-budget"]);
  });
});

describe("the retry policy parse holds condition budgets under the read-only count", () => {
  it("starts a host that set DOCSFAB_READ_ONLY_MAX_RETRIES=0 alone, applying 0 to each subset", () => {
    const parsed = parseRetryPolicy({ DOCSFAB_READ_ONLY_MAX_RETRIES: "0" });
    expect(parsed.maxRetries).toBe(0);
    expect(parsed.maxTimeoutRetries).toBe(0);
    expect(parsed.maxCutAnswerRetries).toBe(0);
  });

  it("refuses an explicit cut override above the read-only count", () => {
    expect(() =>
      parseRetryPolicy({
        DOCSFAB_READ_ONLY_MAX_RETRIES: "1",
        DOCSFAB_READ_ONLY_MAX_CUT_ANSWER_RETRIES: "2",
      }),
    ).toThrow(
      "DOCSFAB_READ_ONLY_MAX_CUT_ANSWER_RETRIES must be less than or equal to DOCSFAB_READ_ONLY_MAX_RETRIES.",
    );
    // Adjacent: equal is admitted.
    expect(
      parseRetryPolicy({
        DOCSFAB_READ_ONLY_MAX_RETRIES: "1",
        DOCSFAB_READ_ONLY_MAX_CUT_ANSWER_RETRIES: "1",
      }).maxCutAnswerRetries,
    ).toBe(1);
    expect(parseRetryPolicy({}).maxCutAnswerRetries).toBe(catalog("retry.maxCutAnswerRetries"));
  });
});

describe("host configuration sets the cut-answer budget", () => {
  it("projects retryPolicy.readOnlyMaxCutAnswerRetries onto its override", () => {
    const host = decodeHostConfig({
      schemaVersion: 1,
      kind: "docsfab-host-config",
      activePolicyProfile: "default",
      retryPolicy: { readOnlyMaxRetries: 2, readOnlyMaxCutAnswerRetries: 2 },
    });
    const environment: NodeJS.ProcessEnv = {};
    projectHostConfigToEnvironment(host, environment);
    expect(environment.DOCSFAB_READ_ONLY_MAX_CUT_ANSWER_RETRIES).toBe("2");
    expect(parseRetryPolicy(environment).maxCutAnswerRetries).toBe(2);
  });
});

describe("every decision records the rule that made it", () => {
  const scripts: Record<string, Script> = {
    prose: [proseRefusal, proseRefusal, proseRefusal, proseRefusal],
    cut: [cutAnswer, cutAnswer],
    deadline: [deadline, deadline],
    terminal: [unsafeDisclosure],
    blank: [() => new InferenceStepError("blank", "blank-response", true), "ok"],
    transport: [() => new InferenceStepError("503", "provider-transient", true), "ok"],
    exhausted: [malformed, malformed, malformed, malformed],
    context: [() => new InferenceStepError("ctx", "context-exhausted", false)],
  };

  it.each(Object.entries(scripts))(
    "%s: names a rule on every attempt and never reads declined-unexplained",
    async (_name, script) => {
      const { execution } = await run(script);
      const evidence = execution.evidence;
      expect(evidence.conditionRetry).toEqual({
        maxTimeoutRetries: catalog("retry.maxTimeoutRetries"),
        maxCutAnswerRetries: catalog("retry.maxCutAnswerRetries"),
        maxNoProgressRetries: catalog("retry.maxNoProgressRetries"),
      });
      for (const attempt of evidence.attempts) {
        expect(attempt.retryRule).toBeDefined();
        const token = inferenceRetryDecisionToken(attempt, evidence);
        expect(token).toBe(attempt.retryRule);
        expect(["declined-unexplained", "unavailable", "retried"]).not.toContain(token);
      }
      // The validators' check admits what the writer wrote.
      expect(inferenceAttemptRulesConsistent(evidence, evidence.attempts)).toBe(true);
    },
  );

  it("records the admitted answer's byte length on the succeeded attempt only", async () => {
    const { execution } = await run([malformed, "ok"]);
    expect(execution.evidence.attempts.map((attempt) => attempt.answerBytes)).toEqual([
      undefined,
      42,
    ]);
  });

  it("refuses a record whose rule or decision was swapped", async () => {
    const { execution } = await run([malformed, "ok"]);
    const evidence = structuredClone(execution.evidence);
    const forged = (patch: Partial<InferenceAttemptEvidence>) => ({
      ...evidence,
      attempts: [{ ...evidence.attempts[0]!, ...patch }, evidence.attempts[1]!],
    });
    expect(
      inferenceAttemptRulesConsistent(
        forged({ retryRule: "retried-cut-answer" }),
        forged({ retryRule: "retried-cut-answer" }).attempts,
      ),
    ).toBe(false);
    const swappedDecision = forged({ retryDecision: "declined" });
    expect(inferenceAttemptRulesConsistent(swappedDecision, swappedDecision.attempts)).toBe(false);
    const misfiled = forged({ condition: "attempt-deadline" });
    expect(inferenceAttemptRulesConsistent(misfiled, misfiled.attempts)).toBe(false);
    // Adjacent: a record without condition budgets must not carry rules.
    const { conditionRetry: _dropped, ...legacy } = evidence;
    expect(inferenceAttemptRulesConsistent(legacy, legacy.attempts)).toBe(false);
  });

  it("requires write-settlement proof on legacy disabled-writer transport retries", () => {
    const legacyRecord = (
      writeSettlement?: InferenceAttemptEvidence["writeSettlement"],
      includeTransportBudget = true,
    ): InferenceExecutionEvidence => ({
      configuredMaxRetries: MAX_RETRIES,
      effectiveMaxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryableCategories: ALL_CATEGORIES,
      replay: "disabled-write-step",
      ...(includeTransportBudget
        ? {
            transportRetry: {
              maxRetries: 2,
              maxDelayMs: 0,
              maxElapsedMs: 1_000,
              categories: ["provider-transient"],
            },
          }
        : {}),
      attempts: [
        {
          attempt: 1,
          outcome: "provider-transient",
          retryable: true,
          retryScheduled: true,
          backoffMs: 0,
          durationMs: 0,
          ...(writeSettlement === undefined ? {} : { writeSettlement }),
        },
        {
          attempt: 2,
          outcome: "succeeded",
          retryable: false,
          retryScheduled: false,
          durationMs: 0,
        },
      ],
    });

    const safe = legacyRecord("no-write");
    const missing = legacyRecord();
    const wrote = legacyRecord("write-executed");
    const noBudget = legacyRecord("no-write", false);
    expect(inferenceAttemptRulesConsistent(safe, safe.attempts)).toBe(true);
    expect(inferenceAttemptRulesConsistent(missing, missing.attempts)).toBe(false);
    expect(inferenceAttemptRulesConsistent(wrote, wrote.attempts)).toBe(false);
    expect(inferenceAttemptRulesConsistent(noBudget, noBudget.attempts)).toBe(false);
  });

  it("reports no retries left once a condition budget is spent, whatever the count allows", async () => {
    const { execution } = await run([cutAnswer, cutAnswer]);
    const step = { id: "plan-documentation", inference: execution.evidence } as never;
    // Contract attempt 2 of 4: the count alone would leave 2.
    expect(readTerminalRetryDisposition(step)?.retriesRemaining).toBe(0);
    expect(formatStepRetryDispositionSentence(step)).toContain(
      "retry decision exhausted-cut-answer-budget on attempt 2",
    );
    expect(formatStepRetryDispositionSentence(step)).toContain("retries remaining 0");
    // Adjacent: a contract retry on attempt 1 still reports the count's remainder.
    const retried = (await run([malformed, "ok"])).execution.evidence;
    const first = {
      id: "plan-documentation",
      inference: { ...retried, attempts: [retried.attempts[0]!] },
    } as never;
    expect(readTerminalRetryDisposition(first)?.retriesRemaining).toBe(MAX_RETRIES - 1);
  });

  it("refuses a timeout that does not name which timer fired", async () => {
    const { execution } = await run([providerTimeout, "ok"]);
    const evidence = structuredClone(execution.evidence);
    expect(inferenceAttemptRulesConsistent(evidence, evidence.attempts)).toBe(true);
    // Same rule, same decision; only the condition is gone.
    delete evidence.attempts[0]!.condition;
    expect(inferenceAttemptRulesConsistent(evidence, evidence.attempts)).toBe(false);
  });

  it("still derives a legacy record's token from its other fields", () => {
    // Today's record of 9e5c3a84 attempt 2: an eligible timeout declined with
    // retries remaining, written before rules were recorded.
    const legacy: InferenceExecutionEvidence = {
      configuredMaxRetries: MAX_RETRIES,
      effectiveMaxRetries: MAX_RETRIES,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryableCategories: ALL_CATEGORIES,
      replay: "read-only",
      attempts: [
        {
          attempt: 1,
          outcome: "timeout",
          retryable: true,
          retryScheduled: false,
          conditionRetryability: "eligible",
          retryDecision: "declined",
          durationMs: 300_005,
        },
      ],
    };
    expect(inferenceRetryDecisionToken(legacy.attempts[0]!, legacy)).toBe("declined-unexplained");
  });

  it("publishes every catalog rule as an operator token", () => {
    for (const rule of Object.keys(RETRY_RULES)) {
      expect(INFERENCE_RETRY_DECISION_TOKENS).toContain(rule);
    }
  });
});

describe("the decider is total over category x retryable x condition x budgets", () => {
  const conditions: Array<InferenceFailureCondition | undefined> = [
    undefined,
    "unframed-reply",
    "cut-answer",
    "attempt-deadline",
    "provider-timeout",
  ];
  const outcomes: InferenceAttemptEvidence["outcome"][] = [
    ...ALL_CATEGORIES,
    "context-exhausted",
    "invalid-request",
    "provider-terminal",
    "succeeded",
  ];
  const replays: RetryRuleExecution["replay"][] = [
    "read-only",
    "reset-write-step",
    "disabled-write-step",
  ];

  it("returns a catalog rule whose decision fits every combination", () => {
    for (const replay of replays) {
      for (const budget of [0, 1, MAX_RETRIES]) {
        const execution: RetryRuleExecution = {
          effectiveMaxRetries: replay === "disabled-write-step" ? 0 : budget,
          baseDelayMs: 0,
          maxDelayMs: 0,
          retryableCategories: ALL_CATEGORIES,
          replay,
          transportRetry: {
            maxRetries: budget,
            maxDelayMs: 0,
            maxElapsedMs: 1_000,
            categories: ["throttled", "provider-transient"],
          },
          conditionRetry: {
            maxTimeoutRetries: Math.min(1, budget),
            maxCutAnswerRetries: Math.min(1, budget),
          },
        };
        for (const outcome of outcomes) {
          for (const retryable of [true, false]) {
            for (const condition of conditions) {
              const attempt: RetryRuleAttempt = {
                outcome,
                retryable,
                ...(condition === undefined ? {} : { condition }),
                durationMs: 0,
              };
              const [rule] = projectRetryRules(execution, [attempt]);
              expect(rule && Object.hasOwn(RETRY_RULES, rule)).toBe(true);
              if (outcome === "succeeded") expect(rule).toBe("not-applicable");
              if (RETRY_RULES[rule!].decision === "retried") {
                expect(retryable).toBe(true);
                expect(replay).not.toBe("disabled-write-step");
              }
            }
          }
        }
      }
    }
  });
});

describe("the condition survives every rewrap on the way to the decider", () => {
  it("drops a condition the typed provider re-decision no longer describes", () => {
    // The host deadline fired, but the attempt's last landed turn was a 429:
    // the typed verdict re-decides the category, and the condition named the
    // old one.
    const original = new InferenceStepError(
      "timed out",
      "timeout",
      true,
      {
        modelTelemetry: {
          schemaVersion: 1,
          finishReason: "error",
          providerError: { class: "rate-limit", httpStatus: 429 },
        },
      } as InferenceStepError["evidence"],
      undefined,
      { condition: "attempt-deadline" },
    );
    const decided = decideSentProviderFailure(original);
    expect(decided.category).toBe("throttled");
    expect(decided.condition).toBeUndefined();
    // Adjacent: a verdict that keeps the category returns the failure as raised.
    const kept = new InferenceStepError(
      "timed out",
      "timeout",
      true,
      {
        modelTelemetry: {
          schemaVersion: 1,
          finishReason: "error",
          providerError: { class: "timeout" },
        },
      } as InferenceStepError["evidence"],
      undefined,
      { condition: "attempt-deadline" },
    );
    expect(decideSentProviderFailure(kept).condition).toBe("attempt-deadline");
  });

  it("keeps the unframed condition through the technical review wrap", () => {
    expect(proseRefusal().condition).toBe("unframed-reply");
    expect(wrapTechnicalReviewFailure(proseRefusal()).condition).toBe("unframed-reply");
  });
});
