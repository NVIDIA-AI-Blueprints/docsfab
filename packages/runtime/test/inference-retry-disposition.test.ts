// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The vocabulary a recorded attempt uses to separate whether a failure
 * condition can be retried from what the run's policy did about it, and the
 * reading that keeps an older record without the split explicitly unavailable.
 * Run-record decoders cross-check records against this projection.
 */
import { describe, expect, it } from "vitest";

import {
  CONFIGURABLE_RETRY_CATEGORIES,
  INFERENCE_ATTEMPT_OUTCOMES,
} from "../src/inference-attempt-taxonomy.js";
import type { InferenceFailureCategory } from "../src/records/contracts.js";
import {
  INFERENCE_RETRY_DISPOSITION_UNAVAILABLE,
  inferenceConditionRetryability,
  projectInferenceRetryDecision,
  readInferenceRetryDisposition,
  remainingRetryBudget,
} from "../src/records/inference-retry-disposition.js";

/** The shipped retryable set, as `.env.example` lists it. */
const LISTED: readonly InferenceFailureCategory[] = [...CONFIGURABLE_RETRY_CATEGORIES];

describe("condition retryability (#480)", () => {
  it("answers for every outcome in the taxonomy and for nothing else", () => {
    const answered = INFERENCE_ATTEMPT_OUTCOMES.map((outcome) => [
      outcome,
      inferenceConditionRetryability(outcome, { noProgressRetry: true }),
    ]);

    expect(answered).toEqual([
      ["succeeded", "not-applicable"],
      ["blank-response", "eligible"],
      ["malformed-response", "eligible"],
      ["context-exhausted", "not-eligible"],
      ["timeout", "eligible"],
      ["throttled", "eligible"],
      ["provider-transient", "eligible"],
      ["provider-terminal", "not-eligible"],
      ["host-runtime-failure", "not-eligible"],
      ["invalid-request", "not-eligible"],
      // Eligible under a policy with a no-progress budget.
      ["no-progress", "eligible"],
    ]);
    // A record written before that budget keeps the stop terminal.
    expect(inferenceConditionRetryability("no-progress", { noProgressRetry: false })).toBe(
      "not-eligible",
    );
    // A deterministic response-size overflow classifies `provider-terminal`, so
    // it cannot read as an eligible transient however a harness flagged it.
    expect(inferenceConditionRetryability("provider-terminal", { noProgressRetry: true })).toBe(
      "not-eligible",
    );
  });
});

describe("retry decision projection (#480)", () => {
  const decide = (
    overrides: Partial<Parameters<typeof projectInferenceRetryDecision>[0]> = {},
  ): string =>
    projectInferenceRetryDecision({
      outcome: "throttled",
      attempt: 1,
      effectiveMaxRetries: 2,
      policyRetryableCategories: LISTED,
      retryScheduled: false,
      ...overrides,
    });

  it("reports what the runtime actually did before anything else", () => {
    expect(decide({ retryScheduled: true })).toBe("retried");
    expect(decide({ outcome: "succeeded" })).toBe("not-applicable");
    expect(decide({ outcome: "context-exhausted" })).toBe("not-applicable");
    expect(decide({ outcome: "provider-terminal" })).toBe("not-applicable");
  });

  it("declines an eligible condition the run's effective policy does not list", () => {
    expect(decide({ policyRetryableCategories: ["blank-response"] })).toBe("declined");
    // A write-capable step lists nothing, which is how its mode declines.
    expect(decide({ policyRetryableCategories: [], effectiveMaxRetries: 0 })).toBe("declined");
  });

  /**
   * A budget of zero is a decline, not an exhaustion: 0 is a valid configured
   * `DOCSFAB_READ_ONLY_MAX_RETRIES`, and `exhausted` would claim retries were
   * used up when none was possible.
   */
  it("declines rather than exhausts when no retry window ever opened", () => {
    expect(decide({ effectiveMaxRetries: 0 })).toBe("declined");
    // Control: the same listed, eligible condition with a real budget spent.
    expect(decide({ effectiveMaxRetries: 1, attempt: 2 })).toBe("exhausted");
  });

  /**
   * On the attempt that equals the budget a retry was still available and
   * something else declined it; only strictly past it did the budget stop the
   * retry.
   */
  it("exhausts only strictly past the last retry the budget allowed", () => {
    expect(decide({ effectiveMaxRetries: 2, attempt: 1 })).toBe("declined");
    expect(decide({ effectiveMaxRetries: 2, attempt: 2 })).toBe("declined");
    expect(decide({ effectiveMaxRetries: 2, attempt: 3 })).toBe("exhausted");
    expect(decide({ effectiveMaxRetries: 1, attempt: 1 })).toBe("declined");
    expect(decide({ effectiveMaxRetries: 1, attempt: 2 })).toBe("exhausted");
  });
});

describe("remaining retry budget", () => {
  it("keeps the full budget after a declined first attempt", () => {
    expect(
      remainingRetryBudget({ attempt: 1, effectiveMaxRetries: 3, retryScheduled: false }),
    ).toBe(3);
  });

  it("decrements only when a retry was actually scheduled", () => {
    expect(remainingRetryBudget({ attempt: 1, effectiveMaxRetries: 3, retryScheduled: true })).toBe(
      2,
    );
    expect(
      remainingRetryBudget({ attempt: 2, effectiveMaxRetries: 3, retryScheduled: false }),
    ).toBe(2);
    expect(
      remainingRetryBudget({ attempt: 4, effectiveMaxRetries: 3, retryScheduled: false }),
    ).toBe(0);
  });
});

describe("reading a recorded attempt (#480)", () => {
  it("reads an attempt written before the split as explicitly unavailable", () => {
    // An older attempt with the conflated pair "retryable, not scheduled".
    // Neither half may become a decision.
    const historical = { retryable: true, retryScheduled: false };

    expect(readInferenceRetryDisposition(historical)).toEqual({
      conditionRetryability: INFERENCE_RETRY_DISPOSITION_UNAVAILABLE,
      retryDecision: INFERENCE_RETRY_DISPOSITION_UNAVAILABLE,
    });
    expect(readInferenceRetryDisposition(historical).retryDecision).not.toBe("declined");
    expect(readInferenceRetryDisposition(historical).conditionRetryability).not.toBe("eligible");
  });

  it("reads a recorded pair back unchanged and refuses to half-read a broken one", () => {
    expect(
      readInferenceRetryDisposition({
        conditionRetryability: "eligible",
        retryDecision: "declined",
      }),
    ).toEqual({ conditionRetryability: "eligible", retryDecision: "declined" });

    for (const half of [
      { conditionRetryability: "eligible" as const },
      { retryDecision: "declined" as const },
      { conditionRetryability: "eligible" as const, retryDecision: undefined },
    ]) {
      expect(readInferenceRetryDisposition(half)).toEqual({
        conditionRetryability: INFERENCE_RETRY_DISPOSITION_UNAVAILABLE,
        retryDecision: INFERENCE_RETRY_DISPOSITION_UNAVAILABLE,
      });
    }
  });
});
