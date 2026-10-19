// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  BYTES_PER_TOKEN_FLOOR_MILLI,
  envelopeOf,
  plannedCall,
  PROJECTED_GROUP_SIZES,
  PROJECTED_REPORT_TOKENS,
} from "./planning.js";
import type { AnswerRecordCorpus } from "./codecs.js";
import type {
  AnswerRecordProjection,
  AnswerRecordProbeSample,
  AnswerRecordProbeTarget,
} from "../answer-record-probe.js";

export type AnswerRecordDecodeRateSource = "stream-window" | "end-to-end";

/** Nearest-rank percentile of `values`; null when empty. */
export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]!;
}

const BASIS_POINTS = 10_000;

/** One sample's decode rate and where it came from. */
export interface AnswerRecordDecodeRate {
  readonly tokensPerSecond: number;
  readonly source: AnswerRecordDecodeRateSource;
}

/**
 * A completed sample's decode rate. The window from the first to the last
 * tool-call argument text gives it when that window covers at least
 * `windowMinBasisPoints` of the elapsed time and text arrived after the first
 * delta: the output tokens are prorated by the argument bytes that arrived
 * inside the window. Otherwise the route sent its arguments in a burst (on
 * build.nvidia.com Super they arrive at the end, so TTFT ≈ elapsed), and the
 * rate is end to end, output tokens over elapsed time, prefill included.
 * Null when the sample has no output to rate.
 */
export function sampleDecodeRate(
  sample: Pick<
    AnswerRecordProbeSample,
    | "httpStatus"
    | "outputTokens"
    | "elapsedMs"
    | "firstArgumentDeltaMs"
    | "lastArgumentDeltaMs"
    | "argumentBytes"
    | "argumentBytesAfterFirstDelta"
  >,
  windowMinBasisPoints: number,
): AnswerRecordDecodeRate | null {
  const { outputTokens, elapsedMs } = sample;
  if (sample.httpStatus < 200 || sample.httpStatus >= 300) return null;
  if (outputTokens === null || outputTokens <= 0 || elapsedMs === null || elapsedMs <= 0) {
    return null;
  }
  const first = sample.firstArgumentDeltaMs;
  const last = sample.lastArgumentDeltaMs;
  if (
    first !== null &&
    last !== null &&
    last > first &&
    sample.argumentBytes > 0 &&
    sample.argumentBytesAfterFirstDelta > 0 &&
    (last - first) * BASIS_POINTS >= windowMinBasisPoints * elapsedMs
  ) {
    const decoded = (outputTokens * sample.argumentBytesAfterFirstDelta) / sample.argumentBytes;
    return {
      tokensPerSecond: (decoded * 1000) / (last - first),
      source: "stream-window",
    };
  }
  return {
    tokensPerSecond: (outputTokens * 1000) / elapsedMs,
    source: "end-to-end",
  };
}

/**
 * M at k records per message for each corpus fixture (one step 8 answer):
 * the sum over its groups of ⌈records / k⌉, since a message never crosses a
 * group (§4.1). `messages` is the larger fixture's.
 */
export function recordMessages(
  corpus: AnswerRecordCorpus,
  recordsPerMessage: number,
): {
  readonly messages: number;
  readonly byFixture: Readonly<Record<string, number>>;
} {
  const counts = new Map<string, Map<number, number>>();
  for (const entry of corpus.records) {
    const groups = counts.get(entry.fixture) ?? new Map<number, number>();
    groups.set(entry.group, (groups.get(entry.group) ?? 0) + 1);
    counts.set(entry.fixture, groups);
  }
  const byFixture = Object.fromEntries(
    [...counts].map(([fixture, groups]) => [
      fixture,
      [...groups.values()].reduce((sum, count) => sum + Math.ceil(count / recordsPerMessage), 0),
    ]),
  );
  return { messages: Math.max(0, ...Object.values(byFixture)), byFixture };
}

/**
 * The step 8 records phase at k = 1, 2 and 3, projected from the measured
 * r, Lturn and padded prompt: record-turn input M × prompt (cached share
 * apart), A = D_full + (M + 2) × Lturn with D_full the larger fixture's
 * records, the report and one resent largest record at ρ_floor (§4.2),
 * T* = A / (1 − s), and the reading turns maxProviderTurns − (2M + 1)
 * leaves (§4.4). Empty when an input is unmeasured.
 */
export function projectRecordsPhase(
  target: AnswerRecordProbeTarget,
  measured: {
    readonly decodeTokensPerSecond: number | null;
    readonly ttftP90Ms: number | null;
    readonly paddedPromptTokens: number | null;
    readonly paddedCachedPromptTokens: number | null;
    readonly largestRecordBytes: number;
  },
): AnswerRecordProjection[] {
  const rate = measured.decodeTokensPerSecond;
  const turnMs = measured.ttftP90Ms;
  const prompt = measured.paddedPromptTokens;
  if (rate === null || rate <= 0 || turnMs === null || prompt === null) return [];
  const tokensOf = (bytes: number) => Math.ceil((bytes * 1000) / BYTES_PER_TOKEN_FLOOR_MILLI);
  const fixtureBytes = new Map<string, number>();
  for (const entry of target.corpus.records) {
    fixtureBytes.set(
      entry.fixture,
      (fixtureBytes.get(entry.fixture) ?? 0) + plannedCall(envelopeOf(entry)).bytes,
    );
  }
  const decodeTokens =
    tokensOf(Math.max(0, ...fixtureBytes.values())) +
    PROJECTED_REPORT_TOKENS +
    tokensOf(measured.largestRecordBytes);
  const decodeSeconds = decodeTokens / rate;
  return PROJECTED_GROUP_SIZES.map((size) => {
    const { messages } = recordMessages(target.corpus, size);
    const answerSeconds = decodeSeconds + ((messages + 2) * turnMs) / 1000;
    return {
      recordsPerMessage: size,
      messages,
      recordTurnInputTokens: messages * prompt,
      cachedInputTokens: messages * (measured.paddedCachedPromptTokens ?? 0),
      answerSeconds: Math.round(answerSeconds),
      timerSeconds: Math.round(
        (answerSeconds * BASIS_POINTS) / (BASIS_POINTS - target.answerNowShareBasisPoints),
      ),
      maxProviderTurns: target.maxProviderTurns,
      readingTurnsLeft: target.maxProviderTurns - (2 * messages + 1),
    };
  });
}
