// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ReviewReplyActionV2, ReviewReplyFeedbackDispositionV2 } from "./contracts.js";

type SimpleIntent = Exclude<ReviewReplyActionV2["intent"], "record-feedback">;

const SIMPLE_COMMANDS: ReadonlyMap<string, SimpleIntent> = new Map([
  ["/docsfab explain", "explain-evidence"],
  ["/docsfab recheck", "request-recheck"],
  ["/docsfab fix", "prepare-fix-handoff"],
]);

const FEEDBACK_DISPOSITIONS: readonly ReviewReplyFeedbackDispositionV2[] = [
  "useful",
  "incorrect",
  "irrelevant",
  "already-covered",
  "intentional",
  "deferred",
];

/**
 * Visits one exact, top-level command body. The callbacks receive only an
 * untrusted syntax classification, never an action binding or admission.
 */
export function visitExplicitReviewReplyCommand(
  body: unknown,
  visitor: {
    onIntent(intent: SimpleIntent): void;
    onFeedback(disposition: ReviewReplyFeedbackDispositionV2, reason: string): void;
  },
): boolean {
  if (typeof body !== "string") return false;
  const line = body.replace(/\r?\n$/u, "");
  if (/[\u0000-\u001f\u007f\u2028\u2029]/u.test(line)) return false;

  const intent = SIMPLE_COMMANDS.get(line);
  if (intent !== undefined) {
    visitor.onIntent(intent);
    return true;
  }

  const feedback = /^\/docsfab feedback ([a-z-]+): (.+)$/u.exec(line);
  if (feedback === null) return false;
  const disposition = feedback[1];
  const reason = feedback[2]?.trim();
  if (
    !FEEDBACK_DISPOSITIONS.includes(disposition as ReviewReplyFeedbackDispositionV2) ||
    !reason ||
    /\/docsfab/iu.test(reason)
  ) {
    return false;
  }
  visitor.onFeedback(disposition as ReviewReplyFeedbackDispositionV2, reason);
  return true;
}
