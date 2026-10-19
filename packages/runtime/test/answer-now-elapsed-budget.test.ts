// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { limit } from "../src/config/limits.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";
import {
  ANSWER_PLAN_DEFAULT_LIMIT,
  answerNowAppliesTo,
  answerNowFlipAtMs,
  concludeBeforeDeadlineAppliesTo,
  concludeBeforeDeadlineAtMs,
  answerNowReserveMs,
  answerNowStepIds,
  answerPlanCoverage,
  formatAnswerPlanLines,
  stepAnswerNowPlan,
  stepAnswerPlanTokens,
  resolveAnswerNowPolicy,
  type AnswerNowPlan,
  type AnswerNowPolicy,
} from "../src/harness/answer-now.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import {
  requiresTechnicalCorrection,
  usesProvisionalVerificationJudgment,
} from "../src/workflow-execution/source-obligation.js";

/**
 * The soft elapsed budget's arithmetic on both sides of each governing term,
 * and the gate that decides which steps it applies to. Catalog numbers are read,
 * not restated, except where a literal oracle is the point.
 */
describe("answer-now elapsed budget", () => {
  const environment = {};
  const catalog = (name: string) => limit(name, { environment }).value;
  const SHARE = "compositionExecution.answerNowElapsedShareBasisPoints";
  const DECODE_RATE = "compositionExecution.answerNowDecodeTokensPerSecond";
  const TURN_LATENCY = "compositionExecution.answerNowTurnLatencyMs";
  /** Step 8, the largest planned answer. */
  const QUALITY = "evaluate-document-quality";
  /** A measured small-answer step. */
  const AUDIENCE = "test-audience-understanding";
  const PROVISIONAL = "provisional-technical-verification";
  /** The attempt timer the widest sealed composition carries. */
  const SEALED_ATTEMPT_TIMEOUT_MS = catalog("sealed.compositionLimits.timeoutMs");
  /** The attempt timer 13 of the 16 registered compositions seal. */
  const SHORT_ATTEMPT_TIMEOUT_MS = 300_000;
  const policy = (overrides: Partial<AnswerNowPolicy> = {}): AnswerNowPolicy => ({
    elapsedShareBasisPoints: catalog(SHARE),
    decodeTokensPerSecond: catalog(DECODE_RATE),
    turnLatencyMs: catalog(TURN_LATENCY),
    ...overrides,
  });
  const plan = (stepId: string, env: Record<string, string> = environment) =>
    stepAnswerNowPlan(stepId, undefined, { environment: env });
  /** A plan whose reserve is exactly `reserveMs` at one token per millisecond and no turn latency. */
  const reservePolicy = (overrides: Partial<AnswerNowPolicy> = {}) =>
    policy({ decodeTokensPerSecond: 1_000, turnLatencyMs: 0, ...overrides });
  const reservePlan = (reserveMs: number): AnswerNowPlan => ({
    answerOutputTokens: reserveMs,
    answerTurns: 1,
  });

  it("resolves the policy and each step's own answer plan from the catalog", () => {
    expect(resolveAnswerNowPolicy({ environment })).toEqual({
      elapsedShareBasisPoints: catalog(SHARE),
      decodeTokensPerSecond: catalog(DECODE_RATE),
      turnLatencyMs: catalog(TURN_LATENCY),
    });
    expect(stepAnswerPlanTokens(AUDIENCE, { environment })).toEqual({
      stepId: AUDIENCE,
      tokens: catalog("compositionExecution.answerPlan.testAudienceUnderstandingTokens"),
      limit: "compositionExecution.answerPlan.testAudienceUnderstandingTokens",
      declared: true,
    });
    expect(plan(AUDIENCE)).toEqual({
      answerOutputTokens: catalog(
        "compositionExecution.answerPlan.testAudienceUnderstandingTokens",
      ),
      answerTurns: 1 + catalog("inference.maxLengthStopContinuations"),
    });
    // Literals, as an oracle independent of the functions under test: at 80
    // tokens per second plus two 25,000 ms turns, step 8's 11,800 tokens need
    // 197,500 ms, the audience test's 2,900 need 86,250 ms, and the
    // provisional judgment's 8,200 need 152,500 ms.
    expect(catalog(SHARE)).toBe(4_000);
    expect(catalog(DECODE_RATE)).toBe(80);
    expect(catalog(TURN_LATENCY)).toBe(25_000);
    expect(catalog("inference.maxLengthStopContinuations")).toBe(1);
    expect(answerNowReserveMs(plan(QUALITY), policy())).toBe(197_500);
    expect(answerNowReserveMs(plan(AUDIENCE), policy())).toBe(86_250);
    expect(answerNowReserveMs(plan(PROVISIONAL), policy())).toBe(152_500);
  });

  it("gives a step with no plan of its own the declared default, and says so", () => {
    expect(stepAnswerPlanTokens("no-such-step", { environment })).toEqual({
      stepId: "no-such-step",
      tokens: catalog(ANSWER_PLAN_DEFAULT_LIMIT),
      limit: ANSWER_PLAN_DEFAULT_LIMIT,
      declared: false,
    });
    expect(catalog(ANSWER_PLAN_DEFAULT_LIMIT)).toBe(11_800);
  });

  it("lists every read-only model step's plan, naming the steps on the default", () => {
    const coverage = answerPlanCoverage({ environment });
    expect(coverage.filter((entry) => !entry.declared).map((entry) => entry.stepId)).toEqual([
      "analyze-information-architecture",
      "answer-question",
      "compare-product-behavior",
    ]);
    // Every per-step entry in the catalog names a step the coverage lists, so a
    // misspelled step cannot leave its entry unread.
    const covered = new Set(coverage.map((entry) => entry.limit));
    const entries = Object.keys(LIMIT_DEFINITION_BY_NAME).filter(
      (name) =>
        name.startsWith("compositionExecution.answerPlan.") && name !== ANSWER_PLAN_DEFAULT_LIMIT,
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const name of entries) expect(covered.has(name), name).toBe(true);
    const lines = formatAnswerPlanLines(coverage);
    expect(lines).toContain(
      `${AUDIENCE} | 2900 | compositionExecution.answerPlan.testAudienceUnderstandingTokens | step`,
    );
    expect(lines.at(-1)).toBe(
      `Steps using ${ANSWER_PLAN_DEFAULT_LIMIT}: analyze-information-architecture, answer-question, compare-product-behavior.`,
    );
  });

  it("arms on a 300 s composition, where a small-answer step reads longer than step 8", () => {
    // Step 8's reserve leaves 102,500 ms, before its 120,000 ms reading share.
    expect(answerNowFlipAtMs(SHORT_ATTEMPT_TIMEOUT_MS, policy(), plan(QUALITY))).toBe(102_500);
    // The audience test's reserve leaves 213,750 ms, so the share governs.
    expect(answerNowFlipAtMs(SHORT_ATTEMPT_TIMEOUT_MS, policy(), plan(AUDIENCE))).toBe(120_000);
    // Both judgment steps arm at their share on 300 s and on the widest timer.
    for (const stepId of answerNowStepIds()) {
      expect(answerNowFlipAtMs(SHORT_ATTEMPT_TIMEOUT_MS, policy(), plan(stepId)), stepId).toBe(
        120_000,
      );
      expect(answerNowFlipAtMs(SEALED_ATTEMPT_TIMEOUT_MS, policy(), plan(stepId)), stepId).toBe(
        720_000,
      );
    }
    expect(SEALED_ATTEMPT_TIMEOUT_MS).toBe(1_800_000);
  });

  it("follows the bound composition's per-turn output limit", () => {
    // The two planned turns of a 4,096-token composition carry 8,192 tokens,
    // under step 8's 11,800: 102,400 ms of decode plus 50,000 ms.
    const capped = stepAnswerNowPlan(QUALITY, 4_096, { environment });
    expect(capped).toEqual({ answerOutputTokens: 8_192, answerTurns: 2 });
    expect(answerNowReserveMs(capped, policy())).toBe(152_400);
    // A wider per-turn limit than the plan leaves the plan unchanged.
    expect(stepAnswerNowPlan(QUALITY, 384_000, { environment })).toEqual(plan(QUALITY));
  });

  it("moves the ask earlier under each override, never later", () => {
    const flip = (env: Record<string, string>) =>
      answerNowFlipAtMs(
        SHORT_ATTEMPT_TIMEOUT_MS,
        resolveAnswerNowPolicy({ environment: env }),
        plan(QUALITY, env),
      );
    const base = flip({});
    expect(
      flip({ DOCSFAB_COMPOSITION_EXECUTION_ANSWER_PLAN_EVALUATE_DOCUMENT_QUALITY_TOKENS: "12000" }),
    ).toBe(base! - 2_500);
    expect(flip({ DOCSFAB_COMPOSITION_EXECUTION_ANSWER_NOW_DECODE_TOKENS_PER_SECOND: "79" })).toBe(
      300_000 - Math.ceil((11_800 * 1_000) / 79) - 50_000,
    );
    expect(flip({ DOCSFAB_COMPOSITION_EXECUTION_ANSWER_NOW_TURN_LATENCY_MS: "26000" })).toBe(
      base! - 2_000,
    );
    expect(flip({ DOCSFAB_INFERENCE_MAX_LENGTH_STOP_CONTINUATIONS: "2" })).toBe(base! - 25_000);
    // The default moves only the steps on it.
    expect(
      stepAnswerPlanTokens("answer-question", {
        environment: { DOCSFAB_COMPOSITION_EXECUTION_ANSWER_PLAN_DEFAULT_TOKENS: "12000" },
      }).tokens,
    ).toBe(12_000);
    expect(
      plan(QUALITY, { DOCSFAB_COMPOSITION_EXECUTION_ANSWER_PLAN_DEFAULT_TOKENS: "12000" }),
    ).toEqual(plan(QUALITY));
    // Each override that would move the ask later is refused.
    for (const [name, value] of [
      ["DOCSFAB_COMPOSITION_EXECUTION_ANSWER_PLAN_EVALUATE_DOCUMENT_QUALITY_TOKENS", "11799"],
      ["DOCSFAB_COMPOSITION_EXECUTION_ANSWER_PLAN_DEFAULT_TOKENS", "11799"],
      ["DOCSFAB_COMPOSITION_EXECUTION_ANSWER_NOW_DECODE_TOKENS_PER_SECOND", "81"],
      ["DOCSFAB_COMPOSITION_EXECUTION_ANSWER_NOW_TURN_LATENCY_MS", "24999"],
    ] as const) {
      expect(() => flip({ [name]: value }), name).toThrow(name);
    }
  });

  it("takes the earlier of the reading share and the answer reserve, never their conjunction", () => {
    // Reserve-governed: the reserve leaves less than the share would spend.
    expect(answerNowFlipAtMs(1_800_000, reservePolicy(), reservePlan(1_100_000))).toBe(700_000);
    // Share-governed: a wider attempt makes the reserve the looser term.
    expect(answerNowFlipAtMs(3_000_000, reservePolicy(), reservePlan(1_100_000))).toBe(1_200_000);
    // A conjunction (share spent and reserve remaining) never fires at these
    // numbers: the share point leaves 1,080,000 ms, under the 1,100,000 ms reserve.
    expect(1_800_000 - Math.floor((1_800_000 * 4_000) / 10_000)).toBeLessThan(1_100_000);
  });

  it("moves by one millisecond on each side of each governing term", () => {
    // Reserve-governed at the boundary and one past it.
    expect(answerNowFlipAtMs(1_800_000, reservePolicy(), reservePlan(1_080_000))).toBe(720_000);
    expect(answerNowFlipAtMs(1_800_000, reservePolicy(), reservePlan(1_080_001))).toBe(719_999);
    // Share-governed at the boundary and one past it.
    expect(answerNowFlipAtMs(1_800_000, reservePolicy(), reservePlan(1_079_999))).toBe(720_000);
    expect(
      answerNowFlipAtMs(
        1_800_000,
        reservePolicy({ elapsedShareBasisPoints: 3_999 }),
        reservePlan(1_079_999),
      ),
    ).toBe(719_820);
  });

  it("charges every planned turn and rounds the decode time up", () => {
    // 3 tokens at 2 tokens per second is 1,500 ms; one more token is 2,000 ms.
    expect(
      answerNowReserveMs(
        { answerOutputTokens: 3, answerTurns: 4 },
        policy({ decodeTokensPerSecond: 2, turnLatencyMs: 10 }),
      ),
    ).toBe(1_540);
    expect(
      answerNowReserveMs(
        { answerOutputTokens: 1, answerTurns: 0 },
        policy({ decodeTokensPerSecond: 3, turnLatencyMs: 10 }),
      ),
    ).toBe(334);
  });

  it("does not arm when the attempt carries no timer or cannot hold the answer reserve", () => {
    // Normal mode: no attempt timer to take a share of.
    expect(answerNowFlipAtMs(undefined, policy(), plan(QUALITY))).toBeUndefined();
    // The attempt timer is at or under step 8's 197,500 ms reserve.
    expect(answerNowFlipAtMs(197_500, policy(), plan(QUALITY))).toBeUndefined();
    // One millisecond more than the reserve arms, at that one millisecond.
    expect(answerNowFlipAtMs(197_501, policy(), plan(QUALITY))).toBe(1);
  });

  it("puts the conclude-before-deadline point where only the step's own reserve remains", () => {
    // Step 8: 300,000 ms less its 197,500 ms reserve.
    expect(concludeBeforeDeadlineAtMs(SHORT_ATTEMPT_TIMEOUT_MS, policy(), plan(QUALITY))).toBe(
      102_500,
    );
    // A small-answer step keeps reading until 300,000 ms less 86,250 ms.
    expect(concludeBeforeDeadlineAtMs(SHORT_ATTEMPT_TIMEOUT_MS, policy(), plan(AUDIENCE))).toBe(
      213_750,
    );
    expect(concludeBeforeDeadlineAtMs(SEALED_ATTEMPT_TIMEOUT_MS, policy(), plan(QUALITY))).toBe(
      1_602_500,
    );
    // The answer-now flip is never later than this point.
    for (const stepId of answerNowStepIds()) {
      expect(
        answerNowFlipAtMs(SHORT_ATTEMPT_TIMEOUT_MS, policy(), plan(stepId)),
      ).toBeLessThanOrEqual(
        concludeBeforeDeadlineAtMs(SHORT_ATTEMPT_TIMEOUT_MS, policy(), plan(stepId))!,
      );
    }
    // No timer, or a reserve that does not fit, does not arm.
    expect(concludeBeforeDeadlineAtMs(undefined, policy(), plan(QUALITY))).toBeUndefined();
    expect(concludeBeforeDeadlineAtMs(197_500, policy(), plan(QUALITY))).toBeUndefined();
    expect(concludeBeforeDeadlineAtMs(197_501, policy(), plan(QUALITY))).toBe(1);
  });

  it("asks every read-only step to conclude before the deadline unless answer-now covers it", () => {
    const review = getWorkflow("review-documentation");
    const update = getWorkflow("update-documentation");
    const input = (
      workflow: ReturnType<typeof getWorkflow>,
      stepId: string,
      schemaVersion?: 1 | 2,
    ) => {
      const step = workflow.steps.find((candidate) => candidate.id === stepId)!;
      return {
        workflow,
        step,
        ...(schemaVersion
          ? {
              sourceObligationLedger: {
                schemaVersion,
              } as HarnessStepInput["sourceObligationLedger"],
            }
          : {}),
      };
    };
    // The non-judgment read-only steps the matrix saw run into the deadline.
    for (const stepId of [
      "test-audience-understanding",
      "evaluate-document-quality",
      "review-documentation",
    ]) {
      expect(input(review, stepId).step.mode, stepId).toBe("read-only");
      expect(concludeBeforeDeadlineAppliesTo(input(review, stepId)), stepId).toBe(true);
    }
    // The answer-now judgment steps keep their own, earlier flip.
    expect(
      concludeBeforeDeadlineAppliesTo(input(review, "provisional-technical-verification", 2)),
    ).toBe(false);
    // A write step keeps its tools until its timer ends.
    expect(input(update, "write-documentation").step.mode).toBe("write");
    expect(concludeBeforeDeadlineAppliesTo(input(update, "write-documentation"))).toBe(false);
  });

  describe("the retired fixed reserve", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("reports a retired reserve override once, naming its replacement, and never applies it", () => {
      const written: string[] = [];
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
      });
      const retired = {
        environment: {
          DOCSFAB_COMPOSITION_EXECUTION_ANSWER_NOW_MINIMUM_REMAINING_MS: "1700000",
        },
        hostFile: null,
        projectFile: null,
      };
      const flip = () =>
        answerNowFlipAtMs(
          SHORT_ATTEMPT_TIMEOUT_MS,
          resolveAnswerNowPolicy(retired),
          stepAnswerNowPlan(QUALITY, undefined, retired),
        );
      expect(flip()).toBe(102_500);
      flip();
      expect(written.filter((line) => line.startsWith("WARNING retired-limit-name:"))).toEqual([
        "WARNING retired-limit-name: the environment sets DOCSFAB_COMPOSITION_EXECUTION_ANSWER_NOW_MINIMUM_REMAINING_MS, which DocsFab no longer reads, so its value is ignored. Set the limits that replaced it instead: compositionExecution.answerPlan.provisionalTechnicalVerificationTokens or DOCSFAB_COMPOSITION_EXECUTION_ANSWER_PLAN_PROVISIONAL_TECHNICAL_VERIFICATION_TOKENS; compositionExecution.answerPlan.verifyTechnicalAccuracyTokens or DOCSFAB_COMPOSITION_EXECUTION_ANSWER_PLAN_VERIFY_TECHNICAL_ACCURACY_TOKENS.\n",
      ]);
    });
  });

  /** A step of one catalog workflow, with the ledger schema the gate reads. */
  function gateInput(
    workflowName: "review-documentation" | "create-documentation",
    stepId: string,
    schemaVersion?: 1 | 2,
  ): Pick<HarnessStepInput, "workflow" | "step" | "sourceObligationLedger"> {
    const workflow = getWorkflow(workflowName);
    const step = workflow.steps.find((candidate) => candidate.id === stepId);
    if (!step) throw new Error(`${workflowName} has no step ${stepId}`);
    return {
      workflow,
      step,
      ...(schemaVersion
        ? {
            sourceObligationLedger: {
              schemaVersion,
            } as HarnessStepInput["sourceObligationLedger"],
          }
        : {}),
    };
  }

  it("applies to the two review judgment steps and to no other step", () => {
    expect(
      answerNowAppliesTo(
        gateInput("review-documentation", "provisional-technical-verification", 2),
      ),
    ).toBe(true);
    expect(
      answerNowAppliesTo(gateInput("review-documentation", "verify-technical-accuracy", 2)),
    ).toBe(true);
    // Step 2 derives the ledger and step 6 is the editorial review: neither
    // answers the judgment shape the coverage table degrades.
    expect(
      answerNowAppliesTo(gateInput("review-documentation", "derive-source-obligations", 2)),
    ).toBe(false);
    expect(answerNowAppliesTo(gateInput("review-documentation", "review-documentation"))).toBe(
      false,
    );
    expect(answerNowAppliesTo(gateInput("review-documentation", "audit-documentation", 2))).toBe(
      false,
    );
    // Without a V2 ledger the provisional step keeps the full verification contract.
    expect(
      answerNowAppliesTo(gateInput("review-documentation", "provisional-technical-verification")),
    ).toBe(false);
  });

  it("does not apply to the correction step over a legacy ledger, matching the admission", () => {
    // `requiresTechnicalCorrection` ignores the ledger schema, but a V1
    // correction goes to the strict legacy validator, which refuses. The gate
    // carries the admission's `schemaVersion === 2` conjunct for that reason.
    const legacy = gateInput("review-documentation", "verify-technical-accuracy", 1);
    expect(requiresTechnicalCorrection(legacy)).toBe(true);
    expect(answerNowAppliesTo(legacy)).toBe(false);
    // Absent ledger: the admission fails the step before any reply is read.
    expect(answerNowAppliesTo(gateInput("review-documentation", "verify-technical-accuracy"))).toBe(
      false,
    );
  });

  it("never applies to create-documentation's own technical step, whose coverage refuses", () => {
    // `requiresTechnicalCorrection` ignores the workflow, so the workflow
    // conjunct keeps the flip off this step, whose coverage policy refuses: a
    // forced early answer would come back `invalid-coverage`.
    const createStep = gateInput("create-documentation", "verify-technical-accuracy", 2);
    expect(requiresTechnicalCorrection(createStep)).toBe(true);
    expect(answerNowAppliesTo(createStep)).toBe(false);
    const createProvisional = gateInput(
      "create-documentation",
      "provisional-technical-verification",
      2,
    );
    expect(usesProvisionalVerificationJudgment(createProvisional)).toBe(true);
    expect(answerNowAppliesTo(createProvisional)).toBe(false);
  });

  it("reads the answer-now steps from the gate itself", () => {
    expect(answerNowStepIds()).toEqual([
      "provisional-technical-verification",
      "verify-technical-accuracy",
    ]);
  });
});
