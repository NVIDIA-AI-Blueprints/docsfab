// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Attempts whose reading the host cut short: it withdrew the tools and asked
 * for the answer before the model finished reading. An answer from
 * partial reading is clipping the operator must see, so the run summary and
 * `docsfab runs show` count it under LIMITATIONS, read from each attempt's
 * `concludeNow` record.
 */
import type { InferenceConcludeNowTrigger, RunRecord } from "../records/contracts.js";
import { isInferenceConcludeNowEvidence } from "../records/inference-retry-rule-vocabulary.js";

export interface AnswerAskedEarlyReading {
  readonly stepId: string;
  readonly attempt: number;
  readonly trigger: InferenceConcludeNowTrigger;
  /** The governed provider turn the answer was asked for after. */
  readonly turn: number;
  /** The attempt's recorded outcome, so a refused forced answer reads as such. */
  readonly outcome: string;
}

/** Why the host asked, in the operator's words. */
export const ANSWER_ASKED_EARLY_REASONS: Readonly<Record<InferenceConcludeNowTrigger, string>> =
  Object.freeze({
    "read-loop": "it re-read unchanged content on a conclude-now retry",
    "reading-budget": "its judgment reading budget was spent",
    "attempt-deadline": "only its answer reserve was left before the attempt deadline",
  });

/** Every attempt that recorded a `concludeNow` ask, in step and attempt order. */
export function readAnswersAskedEarly(
  record: Pick<RunRecord, "steps">,
): readonly AnswerAskedEarlyReading[] {
  if (!Array.isArray(record.steps)) return [];
  return record.steps.flatMap((step) => {
    if (step === null || typeof step !== "object") return [];
    const attempts = Array.isArray(step.inference?.attempts) ? step.inference.attempts : [];
    // A saved record is read defensively: a malformed attempt is skipped here
    // and refused by the record's own reader, never thrown on.
    return attempts.flatMap((attempt) =>
      attempt !== null &&
      typeof attempt === "object" &&
      isInferenceConcludeNowEvidence(attempt.concludeNow)
        ? [
            {
              stepId: step.id,
              attempt: attempt.attempt,
              trigger: attempt.concludeNow.trigger,
              turn: attempt.concludeNow.turn,
              outcome: attempt.outcome,
            },
          ]
        : [],
    );
  });
}

/** The LIMITATIONS lines: a count, then one line per attempt. Empty when none. */
export function formatAnswerAskedEarlyLines(
  readings: readonly AnswerAskedEarlyReading[],
): string[] {
  if (readings.length === 0) return [];
  const count = readings.length;
  return [
    `Answers asked early: ${String(count)} ${count === 1 ? "attempt was" : "attempts were"} asked to answer from what the model had read, so ${count === 1 ? "its" : "their"} reading was cut short.`,
    ...readings.map(
      (reading) =>
        `Asked early: ${reading.stepId} attempt ${String(reading.attempt)} after turn ${String(reading.turn)}, because ${ANSWER_ASKED_EARLY_REASONS[reading.trigger]} (outcome ${reading.outcome}).`,
    ),
  ];
}
