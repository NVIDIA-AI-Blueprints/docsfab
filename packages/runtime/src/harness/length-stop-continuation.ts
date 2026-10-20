// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { limit, type ResolveLimitsOptions } from "../config/limits.js";
import { InferenceStepError } from "../execution/contracts.js";
import { isMalformedResponseCategory } from "../inference-attempt-taxonomy.js";
import { copyQualityResponseCorrection } from "../workflow-execution/quality-response-correction.js";
import { copyRetainedTechnicalReviewState } from "../workflow-execution/review-response.js";

/**
 * Bounded continuation of a structured answer cut at the output limit. A step
 * retry would pay the whole output budget again for the same cut, so the host
 * completes the answer inside the same attempt instead.
 */
export function resolveLengthStopContinuationPolicy(options?: ResolveLimitsOptions): {
  readonly maxLengthStopContinuations: number;
} {
  return {
    maxLengthStopContinuations: limit("inference.maxLengthStopContinuations", options).value,
  };
}

const CONTINUED_REPLY_REFUSAL_NOTE =
  "The answer was cut at the output limit and completed by a continuation before the host refused it.";

/**
 * Mark a `malformed-response` refusal of an answer stitched from at least one
 * continuation as the `cut-answer` condition. The attempt already paid the
 * whole output allowance plus a continuation, so the retry rule judges it
 * against the small cut-answer budget instead of the contract count. Its
 * `retryable` flag is the raiser's: a terminal refusal stays terminal.
 *
 * Other errors pass through: an unstitched refusal keeps its own condition, a
 * timeout or transport failure is not a refused answer, and a `blank-response`
 * is not a rejected answer either.
 *
 * Returns a new error because the condition is fixed at construction. The
 * reply-shape fingerprint is not copied: `retainRejectedReplyShape` attaches it
 * later, at the harness boundary.
 */
export function markStitchedReplyRefusal(error: unknown, continuations: number): unknown {
  if (
    continuations <= 0 ||
    !(error instanceof InferenceStepError) ||
    !isMalformedResponseCategory(error.category)
  ) {
    return error;
  }
  const marked = new InferenceStepError(
    `${error.message} ${CONTINUED_REPLY_REFUSAL_NOTE}`,
    error.category,
    error.retryable,
    error.evidence,
    error.rejection,
    {
      condition: "cut-answer",
      ...(error.rejectionSubject ? { rejectionSubject: error.rejectionSubject } : {}),
    },
  );
  // The retry's repair is keyed on the error object, so each keyed state moves
  // to the wrap: the quality key-set repair, and the technical review's
  // host-path match, closed rejection state, and retained findings.
  copyQualityResponseCorrection(error, marked);
  return copyRetainedTechnicalReviewState(error, marked);
}

/**
 * The continuation the host asks for after a retained cut. The host
 * concatenates the next message onto the retained text and decodes the result
 * against the same contract, so a continuation that restarts, fences, or drifts
 * fails that decode. `retainedChars` is zero when the cut turn carried only
 * reasoning content; the ask is then for the whole answer.
 */
export function lengthStopContinuationPrompt(
  outputTokenLimit: number,
  retainedChars: number,
): string {
  const cut = `Your previous message was cut off at the output limit of ${outputTokenLimit.toLocaleString("en-US")} tokens (finish_reason=length) before it ended.`;
  if (retainedChars === 0) {
    return [
      cut,
      "None of the answer itself arrived, so the host retained nothing of it and will decode your next message on its own against the same host contract stated above.",
      "Emit the whole answer now, from its first character.",
      "Do not add a Markdown fence, an apology, or any commentary.",
      "Keep the answer inside the limit: shorten optional prose and reasons rather than leaving it incomplete.",
    ].join(" ");
  }
  return [
    cut,
    "The host retained exactly the characters that arrived and will concatenate your next message onto them, then decode the concatenation against the same host contract stated above.",
    "Continue that same answer from its final character. Emit only the remaining characters.",
    "Do not repeat any character already sent, do not restart the answer, do not add a Markdown fence, an apology, or any commentary.",
    "Keep the remainder inside the limit: shorten optional prose and reasons rather than leaving the answer incomplete.",
  ].join(" ");
}
