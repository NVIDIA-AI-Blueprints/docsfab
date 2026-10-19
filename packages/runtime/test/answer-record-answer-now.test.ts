// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { deriveRecordsAnswerNowFlip } from "../src/harness/answer-now.js";
import { deriveAnswerSubmissionRecordsFit } from "../src/model-composition/answer-submission-record-fit.js";

const qualifiedPlan = {
  attemptTimeoutMs: 300_000,
  elapsedShareBasisPoints: 4_000,
  dFullMs: 166_000,
  reportDecodeReserveMs: 45_000,
  openPlanBytes: 10_000,
  fullPlanBytes: 10_000,
  remainingMessages: 4,
  turnLatencyMs: 15_000,
  d3ResidualFires: false as const,
};

describe("records answer-now flip", () => {
  it("uses a synthetic qualified 300-second grouped-message plan and arms at its answer deadline", () => {
    const flip = deriveRecordsAnswerNowFlip(qualifiedPlan);

    expect(flip).toEqual({
      armed: true,
      flipAtMs: 44_000,
      remainingReserveMs: 256_000,
      d3ResidualSource: "observed-no-fire",
    });
  });

  it("arms a T* plan at the reading share with its D3 provenance reserve", () => {
    const answerReserveMs = 166_000 + (4 + 2 + 1) * 15_000;
    const timerStarMs = Math.ceil((answerReserveMs * 10_000) / 6_000);
    const flip = deriveRecordsAnswerNowFlip({
      ...qualifiedPlan,
      attemptTimeoutMs: timerStarMs,
      d3ResidualFires: "unknown",
    });

    expect(flip.armed).toBe(true);
    expect(flip.flipAtMs).toBe(Math.ceil((4_000 * timerStarMs) / 10_000));
    expect(flip.flipAtMs).toBe(timerStarMs - answerReserveMs);
    expect(flip.d3ResidualSource).toBe("unobserved-conservative-reserve");
  });

  it("recomputes the flip from partial and completed bytes and actual remaining groups", () => {
    const partial = deriveRecordsAnswerNowFlip({
      ...qualifiedPlan,
      openPlanBytes: 5_000,
      remainingMessages: 2,
      d3ResidualFires: "unknown",
    });
    const completedRecords = deriveRecordsAnswerNowFlip({
      ...qualifiedPlan,
      openPlanBytes: 0,
      remainingMessages: 0,
      d3ResidualFires: "unknown",
    });

    expect(partial).toEqual({
      armed: true,
      flipAtMs: 119_500,
      remainingReserveMs: 180_500,
      d3ResidualSource: "unobserved-conservative-reserve",
    });
    expect(completedRecords).toEqual({
      armed: true,
      flipAtMs: 120_000,
      remainingReserveMs: 90_000,
      d3ResidualSource: "unobserved-conservative-reserve",
    });
  });

  it("retains the fit's projected report decode reserve when no record bytes remain", () => {
    const fit = deriveAnswerSubmissionRecordsFit({
      groupEnvelopeBytes: [{ group: 1, maxBytes: 100 }],
      maxMessageBytes: 100,
      minimumQualifiedMessageBytes: 100,
      fullPlanEnvelopeBytes: 1_000,
      largestRecordEnvelopeBytes: 100,
      bytesPerTokenFloorMilli: 1_000,
      decodeTokensPerSecond: 100,
      projectedReportTokens: 200,
      lturnMs: 1_000,
      d3ResidualFires: false,
      readingTurnsP90: 0,
      maxProviderTurns: 5,
      effectiveTimeoutMs: 100_000,
      timerReviewLimitMs: 100_000,
      answerNowElapsedShareBasisPoints: 4_000,
    });
    const completed = deriveRecordsAnswerNowFlip({
      ...qualifiedPlan,
      dFullMs: fit.dFullMs,
      reportDecodeReserveMs: fit.reportDecodeReserveMs,
      fullPlanBytes: fit.fullPlanTokens,
      openPlanBytes: 0,
      remainingMessages: 0,
      turnLatencyMs: 1_000,
      d3ResidualFires: false,
    });

    expect(fit.reportDecodeReserveMs).toBe(2_000);
    expect(completed.remainingReserveMs).toBe(4_000);
  });

  it("does not arm when the remaining reserve equals the timer", () => {
    const flip = deriveRecordsAnswerNowFlip({
      ...qualifiedPlan,
      attemptTimeoutMs: 256_000,
    });

    expect(flip).toEqual({
      armed: false,
      remainingReserveMs: 256_000,
      d3ResidualSource: "observed-no-fire",
      unarmedReason: "answer-reserve-does-not-fit",
    });
  });

  it("does not arm when the attempt timer is missing", () => {
    const flip = deriveRecordsAnswerNowFlip({
      ...qualifiedPlan,
      attemptTimeoutMs: undefined,
    });

    expect(flip).toEqual({
      armed: false,
      remainingReserveMs: 256_000,
      d3ResidualSource: "observed-no-fire",
      unarmedReason: "missing-timer",
    });
  });

  it("rejects open-plan bytes beyond the qualified full plan", () => {
    expect(() =>
      deriveRecordsAnswerNowFlip({
        ...qualifiedPlan,
        openPlanBytes: 10_001,
      }),
    ).toThrow("The records answer-now flip inputs are invalid or unsupported.");
  });
});
