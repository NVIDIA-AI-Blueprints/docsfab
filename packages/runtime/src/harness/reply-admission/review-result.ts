// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  InferenceStepError,
  type HarnessStepInput,
  type InferenceRejectionReasonV1,
} from "../../execution/contracts.js";
import {
  admitReviewResponse,
  copyRetainedTechnicalReviewState,
} from "../../workflow-execution/review-response.js";
import { requiresVerificationResult } from "../../workflow-execution/verification-result.js";
import { reviewResponsePlacement } from "../editorial-response-contract.js";
import type { ReplyAdmissionContext } from "./context.js";

/**
 * Admit a review result for every step that is not a verification step, which
 * the judgment admission already decoded. Returns the admitted summary.
 */
export function admitReviewResultReply(
  input: HarnessStepInput,
  summary: string,
  { collectAttemptEvidence }: ReplyAdmissionContext,
): string {
  try {
    if (!requiresVerificationResult(input)) summary = admitReviewResponse(input, summary);
  } catch (error) {
    if (error instanceof InferenceStepError) {
      throw copyRetainedTechnicalReviewState(
        error,
        new InferenceStepError(
          error.message,
          error.category,
          error.retryable,
          collectAttemptEvidence(),
          // Every host wrap copies the coded reason forward.
          reviewResultRejection(input, error.rejection),
        ),
      );
    }
    throw error;
  }
  return summary;
}

/**
 * The review result's rejection at its place in the reply. When the result is
 * nested as an editorial assessment envelope's summary, its root is `$.summary`.
 * A refusal no decoder coded records `unknown` at the root.
 */
function reviewResultRejection(
  input: HarnessStepInput,
  rejection: InferenceRejectionReasonV1 | undefined,
): InferenceRejectionReasonV1 {
  const root = reviewResponsePlacement(input) === "editorial-summary" ? "$.summary" : "$";
  if (!rejection) return { code: "unknown", location: root };
  if (root === "$" || !rejection.location.startsWith("$")) return { ...rejection };
  return {
    code: rejection.code,
    location: `${root}${rejection.location.slice(1)}`,
  };
}
