// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseRetryPolicy } from "../src/config/retry-policy.js";
import { retryEnvelopeLine, transportBudgetLine } from "../src/doctor.js";

/** Doctor reports only a timer actually attached to an execution profile. */
describe("doctor retry envelope line", () => {
  const environment = {};
  const policy = (overrides: Record<string, unknown> = {}) => ({
    maxRetries: 3,
    maxTimeoutRetries: 0,
    baseDelayMs: 1_000,
    maxDelayMs: 2_000,
    retryableCategories: ["timeout" as const],
    ...overrides,
  });
  const effectiveAttempt = { timeoutMs: 300_000, maxOutputTokens: 8_200 };

  it("does not invent an attempt timer, answer-now point, or finite worst case for normal mode", () => {
    expect(retryEnvelopeLine(policy(), { environment })).toBe(
      "Retry envelope: attempts=4, timeout attempts=1, cut-answer retries=0, no-progress retries=0; attempt-timeout=not configured, judgment answer-now=not armed (no attempt timer), step worst case=not derivable from retry counts (workflow deadlines still apply)",
    );
    expect(
      retryEnvelopeLine(policy(), {
        environment: { DOCSFAB_COMPOSITION_EXECUTION_TIMEOUT_MS: "300000" },
      }),
    ).toBe(retryEnvelopeLine(policy(), { environment }));
  });

  it("keeps the operator's timeout retry budget independent of an attempt timer", () => {
    expect(retryEnvelopeLine(policy({ maxTimeoutRetries: 2 }), { environment })).toContain(
      "timeout attempts=3",
    );
    expect(retryEnvelopeLine(policy({ maxTimeoutRetries: 9 }), { environment })).toContain(
      "timeout attempts=4",
    );
  });

  it("uses an effective 300 s composition policy when the caller supplies it", () => {
    const expected =
      "Retry envelope: attempts=4 x attempt-timeout=300000ms = 1200000ms (timeout attempts=1, cut-answer retries=0, no-progress retries=0, judgment answer-now at 120000ms)";
    expect(retryEnvelopeLine(policy(), { environment }, effectiveAttempt)).toBe(expected);
    expect(
      retryEnvelopeLine(
        policy(),
        { environment: { DOCSFAB_COMPOSITION_EXECUTION_TIMEOUT_MS: "600000" } },
        effectiveAttempt,
      ),
    ).toBe(expected);
  });

  it("uses effective output tokens for the judgment reserve", () => {
    const attempt = { timeoutMs: 170_000, maxOutputTokens: 1_000 };
    expect(retryEnvelopeLine(policy(), { environment }, attempt)).toContain(
      "judgment answer-now at 68000ms",
    );
    expect(
      retryEnvelopeLine(policy(), { environment }, { ...attempt, maxOutputTokens: 8_200 }),
    ).toContain("judgment answer-now at 17500ms");
  });

  it("names a supplied attempt timer that cannot hold the answer reserve", () => {
    expect(
      retryEnvelopeLine(policy(), { environment }, { ...effectiveAttempt, timeoutMs: 152_500 }),
    ).toContain(
      "judgment answer-now at not armed (attempt timeout 152500ms is not above the 152500ms answer reserve)",
    );
  });

  it("adds transport wall clock only when a real timer permits a finite envelope", () => {
    expect(retryEnvelopeLine(parseRetryPolicy({}), { environment })).toContain(
      "step worst case=not derivable from retry counts",
    );
    expect(retryEnvelopeLine(parseRetryPolicy({}), { environment }, effectiveAttempt)).toContain(
      "= 1200000ms + transport<=2460000ms = step worst case 3660000ms",
    );
  });

  it("states the transport retry budget the shipped policy applies", () => {
    expect(transportBudgetLine(parseRetryPolicy({}))).toBe(
      "Transport retry budget: transport-retries=6 outside max-retries (wait<=60000ms, elapsed<=3600000ms) for throttled,provider-transient; in-turn throttled requests=24 (wait<=380000ms)",
    );
    expect(
      transportBudgetLine(parseRetryPolicy({ DOCSFAB_READ_ONLY_MAX_TRANSPORT_RETRIES: "2" })),
    ).toContain("transport-retries=2 outside max-retries");
    expect(
      transportBudgetLine(parseRetryPolicy({ DOCSFAB_RETRYABLE_CATEGORIES: "malformed-response" })),
    ).toBe("Transport retry budget: none (no transport category is retryable)");
    expect(transportBudgetLine(policy())).toBeUndefined();
  });
});
