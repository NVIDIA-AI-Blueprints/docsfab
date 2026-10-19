// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Why the host writes a rejected judgment row in place of a complete reply. */
export const HOST_FILL_REASONS = [
  "answer-cut-at-output-limit",
  "judgment-reply-refused",
  "continued-judgment-reply-refused",
] as const;

export type HostFillReason = (typeof HOST_FILL_REASONS)[number];

/** A cut answer's host-written row has no asserted source fact. */
export const HOST_UNJUDGED_OBLIGATION_REASON =
  "Host-filled, not judged: the judgment answer was cut at the output limit before a complete judgment of this obligation arrived (its row, and the issue judgment its fact needs), so the host recorded no fact for it and it needs human review.";

/** A refused whole reply's host-written row has no asserted source fact. */
export const HOST_REFUSED_REPLY_OBLIGATION_REASON =
  "Host-filled, not judged: the step's own checks refused the judgment reply with no retry left, so the host kept none of that reply, recorded no fact for this obligation, and it needs human review.";

const HOST_CONTINUED_REFUSED_REPLY_OBLIGATION_REASON =
  "Host-filled, not judged: the step's own checks refused the stitched judgment reply after a continuation, so the host kept none of that reply, recorded no fact for this obligation, and it needs human review.";

/** The same complete rejected row is used by real fallback and its early core. */
export function hostRejectedObligationJudgment(
  obligationId: string,
  reason: HostFillReason,
): { readonly obligationId: string; readonly disposition: "rejected"; readonly reason: string } {
  return {
    obligationId,
    disposition: "rejected",
    reason:
      reason === "judgment-reply-refused"
        ? HOST_REFUSED_REPLY_OBLIGATION_REASON
        : reason === "continued-judgment-reply-refused"
          ? HOST_CONTINUED_REFUSED_REPLY_OBLIGATION_REASON
          : HOST_UNJUDGED_OBLIGATION_REASON,
  };
}
