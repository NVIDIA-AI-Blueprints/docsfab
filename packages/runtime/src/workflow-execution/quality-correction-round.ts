// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The final quality evaluator's correction round.
 *
 * The runner validates the evaluator's artifact inside each inference attempt.
 * A refusal on a model-correctable code fails the attempt as a
 * `malformed-response` carrying the coded rejection; the bounded retry
 * (`retry.ts`) decides within `retry.maxRetries`, and the retry prompt states
 * the rule through the host rule-hint catalog. Every attempt is validated in
 * full; nothing here relaxes a check.
 *
 * A terminal code never becomes an attempt failure: the step stops on the
 * host's refusal, so a host fault is not recorded as a malformed reply.
 *
 * The refusal behind a correction failure is kept in host-owned private
 * state, not on the error, so serializers cannot copy validator state into a
 * record. When the budget ends on a correctable refusal, the runner declines
 * the step's structured artifact with {@link declinedQualityReportNote}
 * instead of failing the review (`runner-step-loop.ts`): it keeps the
 * refused candidate's own `reportMarkdown` narrative (never fabricated) and
 * discards only the `evaluation`/`qualityScore` object the validator
 * rejected -- the same fail-open shape `hostFillRefusedJudgment` already
 * gives the other two judgment steps once their own retry budget is spent.
 */

import { QualityArtifactValidationError } from "../evaluation-report/quality-validator-host.js";
import { InferenceStepError, type HarnessStepResult } from "../execution/contracts.js";
import { isModelCorrectableQualityRejection } from "./quality-rejection-retryability.js";
import {
  evaluationRequiredKeyCorrection,
  recordQualityResponseCorrection,
  traceFactIdsCorrection,
} from "./quality-response-correction.js";
import type { VerificationResult } from "./verification-result.js";

/** Fixed host text; the coded rejection, not this message, names the rule. */
export const QUALITY_CORRECTION_FAILURE_MESSAGE =
  "Quality validation refused the final evaluator's artifact on a model-correctable rule.";

const refusals = new WeakMap<InferenceStepError, QualityArtifactValidationError>();

/**
 * The attempt failure for a model-correctable quality refusal, or `undefined`
 * when the step must stop on `error` as it is. The failure carries the
 * attempt's provider evidence so the retained attempt keeps model and usage.
 */
export function qualityCorrectionFailure(
  error: unknown,
  result: HarnessStepResult,
  technicalVerification?: VerificationResult,
): InferenceStepError | undefined {
  if (!(error instanceof QualityArtifactValidationError)) return undefined;
  // A refusal built without its inner reason names no rule, so it stays terminal.
  const rejection = error.rejection as QualityArtifactValidationError["rejection"] | undefined;
  if (!rejection || !isModelCorrectableQualityRejection(rejection.code)) return undefined;
  const failure = new InferenceStepError(
    QUALITY_CORRECTION_FAILURE_MESSAGE,
    "malformed-response",
    true,
    {
      ...(result.model ? { model: result.model } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.tools ? { tools: result.tools } : {}),
      ...(result.turns ? { turns: result.turns } : {}),
      ...(result.executionLease ? { executionLease: result.executionLease } : {}),
      ...(result.modelTelemetry ? { modelTelemetry: result.modelTelemetry } : {}),
      ...(result.providerResponses ? { providerResponses: result.providerResponses } : {}),
      ...(result.efficiency ? { efficiency: result.efficiency } : {}),
    },
    { code: rejection.code, location: rejection.location },
  );
  refusals.set(failure, error);
  const evaluation = result.qualityArtifactCandidate?.evaluation;
  recordQualityResponseCorrection(
    failure,
    evaluationRequiredKeyCorrection(rejection, evaluation) ??
      traceFactIdsCorrection(rejection, evaluation, technicalVerification),
  );
  return failure;
}

/** The quality refusal a correction failure stands for, if `error` is one. */
export function qualityRefusalBehind(error: unknown): QualityArtifactValidationError | undefined {
  return error instanceof InferenceStepError ? refusals.get(error) : undefined;
}

/** Prefix of the one host note a declined quality report carries, so one search finds them all. */
export const QUALITY_REPORT_DECLINE_STEM = "Host report decline:";

/**
 * The one content-free host note appended after a declined `evaluate-
 * document-quality` step's own kept narrative, when the correction round's
 * retry budget ends on a model-correctable schema or evidence refusal: no
 * amount of model correction produced a schema-valid `evaluation`, so the
 * host discards only that structured object (never fabricating one) and
 * records no quality score for this review. The review result still carries
 * every other step's findings (`review/run-result.ts` treats this decline as
 * a disclosed absence, not a reason to refuse the whole result).
 */
export function declinedQualityReportNote(attemptsSpent: number, rejectionCode: string): string {
  const attempts = attemptsSpent === 1 ? "1 attempt" : `${attemptsSpent} attempts`;
  return (
    `${QUALITY_REPORT_DECLINE_STEM} the evaluate-document-quality step's own checks refused the ` +
    `evaluator's structured evaluation with no retry left (${attempts} spent, rejection code ` +
    `${rejectionCode}); no quality score is recorded for this review. The rest of this step's own ` +
    "report, above, and every other step's findings are unaffected."
  );
}

/** A syntax refusal admits no report narrative and cannot retain a quality score. */
export function declinedQualityEnvelopeNote(
  attemptsSpent: number,
  rejectionCode: string,
  editorialAssessmentRetained = true,
): string {
  const attempts = attemptsSpent === 1 ? "1 attempt" : `${attemptsSpent} attempts`;
  return (
    `${QUALITY_REPORT_DECLINE_STEM} the evaluate-document-quality step could not decode the ` +
    `evaluator's quality answer with no retry left (${attempts} spent, rejection code ` +
    `${rejectionCode}); no quality evaluation, report narrative or quality score is recorded. ` +
    (editorialAssessmentRetained
      ? "The independently admitted editorial assessment and every other step's findings are retained."
      : "Every other step's findings and the preserved patch are unaffected.")
  );
}
