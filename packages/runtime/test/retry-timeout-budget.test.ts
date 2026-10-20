// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { limit } from "../src/config/limits.js";
import { parseRetryPolicy } from "../src/config/retry-policy.js";
import { InferenceStepError } from "../src/execution/contracts.js";
import type { HarnessStepResult, InferenceRetryPolicy } from "../src/execution/contracts.js";
import { classifyModelFailure } from "../src/model/context-budget.js";
import { executeInferenceStep, retryBudgetForCategory } from "../src/workflow-execution/retry.js";

/**
 * An attempt that expires against its own attempt timer must not get the same
 * retry budget as a malformed reply: four long attempts can spend the whole
 * job deadline, leaving no terminal and no run record. The attempt timeout
 * still reports itself retryable, truthfully; the policy's budget for that
 * one category is what differs.
 */
describe("attempt-timeout retry budget", () => {
  /** The sealed attempt timeout and the exact message the harness's timer raises for it. */
  const SEALED_ATTEMPT_TIMEOUT_MS = limit("sealed.compositionLimits.timeoutMs", {
    environment: {},
  }).value;
  const TIMEOUT_MESSAGE = `Composition model attempt timed out after ${SEALED_ATTEMPT_TIMEOUT_MS}ms.`;
  const success: HarnessStepResult = { summary: "ready" };

  const basePolicy: InferenceRetryPolicy = {
    maxRetries: 3,
    maxTimeoutRetries: 0,
    baseDelayMs: 0,
    maxDelayMs: 0,
    retryableCategories: [
      "blank-response",
      "malformed-response",
      "timeout",
      "throttled",
      "provider-transient",
    ],
  };

  /** The failure the harness wraps its expired attempt in, classified by the real classifier. */
  function attemptTimeout(): InferenceStepError {
    const classified = classifyModelFailure(new Error(TIMEOUT_MESSAGE));
    expect(classified).toEqual({ category: "timeout", retryable: true });
    return new InferenceStepError(
      `Model request failed [${classified.category}; retryable=${classified.retryable}]: ${TIMEOUT_MESSAGE}`,
      classified.category,
      classified.retryable,
    );
  }

  async function runWith(policy: InferenceRetryPolicy, error: () => InferenceStepError) {
    const attemptsRun: number[] = [];
    return {
      attemptsRun,
      execution: await executeInferenceStep({
        mode: "read-only",
        policy,
        sleep: async () => {},
        execute: async (attempt) => {
          attemptsRun.push(attempt);
          if (attempt === 1) throw error();
          return success;
        },
      }),
    };
  }

  it("does not schedule a retry for an expired attempt at the catalog default", async () => {
    const { attemptsRun, execution } = await runWith(basePolicy, attemptTimeout);

    expect(execution.status).toBe("failed");
    expect(execution.error?.message).toContain(TIMEOUT_MESSAGE);
    // One attempt only: the remaining three of the read-only budget were not
    // spent, so the step fails by name inside the attempt timer instead of
    // running the job deadline out.
    expect(attemptsRun).toEqual([1]);
    expect(execution.evidence?.attempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: "timeout",
        // The condition stays retryable: the harness reported it truthfully, and
        // only the policy declined the retry. The two facts are recorded
        // separately.
        retryable: true,
        retryScheduled: false,
        conditionRetryability: "eligible",
        retryDecision: "declined",
      }),
    ]);
    expect(execution.evidence?.configuredMaxRetries).toBe(3);
  });

  it("schedules the retry once an operator raises the timeout budget", async () => {
    const { attemptsRun, execution } = await runWith(
      { ...basePolicy, maxTimeoutRetries: 1 },
      attemptTimeout,
    );

    expect(execution.status).toBe("succeeded");
    expect(attemptsRun).toEqual([1, 2]);
    expect(execution.evidence?.attempts[0]).toMatchObject({
      outcome: "timeout",
      retryable: true,
      retryScheduled: true,
    });
  });

  it("keeps the full read-only budget for every other retryable class", async () => {
    // Positive control: the timeout budget must not touch `provider-transient`.
    const { attemptsRun, execution } = await runWith(
      basePolicy,
      () => new InferenceStepError("provider connection reset", "provider-transient", true),
    );

    expect(execution.status).toBe("succeeded");
    expect(attemptsRun).toEqual([1, 2]);
    expect(execution.evidence?.attempts[0]).toMatchObject({
      outcome: "provider-transient",
      retryScheduled: true,
    });
  });

  it("holds the timeout budget under the read-only budget and reads an absent field as zero", () => {
    expect(retryBudgetForCategory(basePolicy, "timeout")).toBe(0);
    expect(retryBudgetForCategory(basePolicy, "provider-transient")).toBe(3);
    // Adjacent: a raise past the read-only budget cannot admit a fifth attempt.
    expect(retryBudgetForCategory({ ...basePolicy, maxTimeoutRetries: 9 }, "timeout")).toBe(3);
    expect(retryBudgetForCategory({ ...basePolicy, maxTimeoutRetries: 3 }, "timeout")).toBe(3);
    // A policy constructed without this field carries no timeout budget, and
    // inheriting `maxRetries` would be inventing one.
    const { maxTimeoutRetries: _absent, ...legacy } = basePolicy;
    expect(retryBudgetForCategory(legacy, "timeout")).toBe(0);
    expect(retryBudgetForCategory(legacy, "malformed-response")).toBe(3);
  });

  it("parses the catalog default and refuses a budget above the read-only count", () => {
    const parsed = parseRetryPolicy({});
    expect(parsed.maxTimeoutRetries).toBe(
      limit("retry.maxTimeoutRetries", { environment: {} }).value,
    );
    expect(parsed.maxTimeoutRetries).toBe(1);
    expect(() =>
      parseRetryPolicy({
        DOCSFAB_READ_ONLY_MAX_RETRIES: "1",
        DOCSFAB_READ_ONLY_MAX_TIMEOUT_RETRIES: "2",
      }),
    ).toThrow(
      "DOCSFAB_READ_ONLY_MAX_TIMEOUT_RETRIES must be less than or equal to DOCSFAB_READ_ONLY_MAX_RETRIES.",
    );
    // Adjacent: equal is admitted, and so is the catalog maximum under the
    // unchanged read-only count.
    expect(
      parseRetryPolicy({
        DOCSFAB_READ_ONLY_MAX_RETRIES: "1",
        DOCSFAB_READ_ONLY_MAX_TIMEOUT_RETRIES: "1",
      }).maxTimeoutRetries,
    ).toBe(1);
    expect(parseRetryPolicy({ DOCSFAB_READ_ONLY_MAX_TIMEOUT_RETRIES: "3" }).maxTimeoutRetries).toBe(
      3,
    );
  });
});
