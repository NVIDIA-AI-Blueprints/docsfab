// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  InferenceStepError,
  type HarnessStepInput,
  type HarnessStepResult,
} from "../../execution/contracts.js";
import { isQualityArtifactEvaluator } from "../editorial-response-contract.js";
import { deepFreeze } from "../../contract-kit/freeze.js";
import {
  admittedEditorialAssessmentProposal,
  isAdmittedQualityTextReply,
  qualityTextBinding,
  type EditorialAssessmentReplyAdmission,
} from "./editorial-assessment.js";
import {
  admitSubmittedQualityArtifact,
  decodeQualityArtifactResponse,
  decodeQualitySubmission,
  QualityArtifactEnvelopeError,
  type QualitySubmissionMembers,
} from "../quality-candidate-tool.js";
import { rejectOutput } from "../../contracts/model-output.generated.js";
import {
  answerKeySetCorrection,
  recordQualityResponseCorrection,
} from "../../workflow-execution/quality-response-correction.js";
import type { ReplyAdmissionContext } from "./context.js";

export interface QualityArtifactReplyAdmission {
  summary: string;
  qualityArtifactCandidate?: HarnessStepResult["qualityArtifactCandidate"];
}

interface QualityTextRefusal {
  readonly bindingSha256: string;
  readonly proposal: unknown;
  readonly skill: HarnessStepResult["skill"];
  readonly rejection: NonNullable<InferenceStepError["rejection"]>;
}

// Neither rejected reply bytes nor a fabricated candidate cross this boundary.
const qualityTextRefusals = new WeakMap<InferenceStepError, QualityTextRefusal>();

/**
 * The genuine final text admission behind this attempt's typed syntax refusal.
 * No code-string, cloned error, stale attempt or changed binding grants custody.
 */
export function qualityTextRefusalBehind(
  error: unknown,
  input: HarnessStepInput,
): QualityTextRefusal | undefined {
  if (
    !(error instanceof InferenceStepError) ||
    error.category !== "malformed-response" ||
    !error.retryable ||
    error.condition !== undefined ||
    error.hostFailureOrigin !== undefined
  )
    return undefined;
  const held = qualityTextRefusals.get(error);
  return held &&
    held.bindingSha256 === qualityTextBinding(input) &&
    error.rejection?.code === held.rejection.code &&
    error.rejection.location === held.rejection.location
    ? held
    : undefined;
}

/**
 * Admit the final quality evaluator's artifact envelope; its report becomes
 * the summary. Any other step keeps its summary and gains no candidate.
 */
export function admitQualityArtifactReply(
  input: HarnessStepInput,
  summary: string,
  { collectAttemptEvidence }: ReplyAdmissionContext,
  editorial?: {
    readonly admission: EditorialAssessmentReplyAdmission;
    readonly skill: HarnessStepResult["skill"];
  },
): QualityArtifactReplyAdmission {
  let qualityArtifactCandidate: HarnessStepResult["qualityArtifactCandidate"];
  if (isQualityArtifactEvaluator(input)) {
    try {
      qualityArtifactCandidate = decodeQualityArtifactResponse(
        summary,
        input.qualityProfileSelection!,
      );
      qualityArtifactCandidate = { ...qualityArtifactCandidate, answerPath: "text" };
      summary = qualityArtifactCandidate.reportMarkdown;
    } catch (error) {
      const failure = new InferenceStepError(
        "The final evaluator returned a malformed quality artifact envelope.",
        "malformed-response",
        true,
        collectAttemptEvidence(),
        // A refusal the envelope decoder did not code records `unknown` at the root.
        error instanceof QualityArtifactEnvelopeError
          ? { ...error.rejection }
          : { code: "unknown", location: "$" },
      );
      // Only a shape refusal of a parsed object knows which keys it had.
      if (error instanceof QualityArtifactEnvelopeError) {
        recordQualityResponseCorrection(failure, answerKeySetCorrection(error.receivedKeys));
        const proposal = admittedEditorialAssessmentProposal(input, editorial?.admission);
        const bindingSha256 = isAdmittedQualityTextReply(input, editorial?.admission)
          ? qualityTextBinding(input)
          : undefined;
        const createTextRefusal =
          input.workflow.name === "create-documentation" &&
          input.workflow.schemaVersion === 3 &&
          (error.rejection.code === "quality-envelope-json" ||
            error.rejection.code === "quality-envelope-shape");
        if (
          ((error.rejection.code === "quality-envelope-json" && proposal !== undefined) ||
            createTextRefusal) &&
          bindingSha256 &&
          editorial?.admission.summary === summary
        ) {
          qualityTextRefusals.set(
            failure,
            Object.freeze({
              bindingSha256,
              proposal,
              skill: editorial.skill ? deepFreeze(structuredClone(editorial.skill)) : undefined,
              rejection: Object.freeze({ ...error.rejection }),
            }),
          );
        }
      }
      throw failure;
    }
  }
  return { summary, qualityArtifactCandidate };
}

/**
 * The attempt failure for a refused tool-call submission or its report:
 * model-correctable, coded, and with the key-set repair a shape
 * refusal of a parsed object carries, exactly as the text answer records it.
 */
export function qualitySubmissionFailure(
  error: unknown,
  evidence?: NonNullable<InferenceStepError["evidence"]>,
): InferenceStepError {
  const failure = new InferenceStepError(
    "The final evaluator's submitted quality artifact answer was refused.",
    "malformed-response",
    true,
    evidence,
    error instanceof QualityArtifactEnvelopeError
      ? { ...error.rejection }
      : { code: "unknown", location: "$" },
  );
  if (error instanceof QualityArtifactEnvelopeError) {
    recordQualityResponseCorrection(failure, answerKeySetCorrection(error.receivedKeys));
  }
  return failure;
}

/**
 * The attempt failure for a submission call cut at the output limit: never
 * continued, and retried under the cut-answer condition's own budget.
 */
export function qualitySubmissionCutFailure(outputTokenLimit: number): InferenceStepError {
  return new InferenceStepError(
    `The final evaluator's submit_quality_evaluation call was cut at the ${outputTokenLimit.toLocaleString("en-US")}-token output limit (finish_reason=length); a cut submission is never continued.`,
    "malformed-response",
    true,
    undefined,
    { ...rejectOutput("quality-submission-cut", "$") },
    { condition: "cut-answer" },
  );
}

/**
 * Decode one submission call's raw arguments at turn settlement, or the coded
 * failure that ends the attempt. The failure carries no evidence: the harness
 * records it as the attempt's session error and attaches evidence when the
 * attempt ends.
 */
export function decodeQualitySubmissionCall(
  raw: string | undefined,
): { readonly members: QualitySubmissionMembers } | { readonly failure: InferenceStepError } {
  try {
    return { members: decodeQualitySubmission(raw) };
  } catch (error) {
    return { failure: qualitySubmissionFailure(error) };
  }
}

/**
 * Admit the final evaluator's answer on the tool-call path: the admitted
 * submission's members and the reply to the report ask. Without an admitted
 * submission the reply is no answer, whatever it holds; the text decoder is
 * never tried.
 */
export function admitQualitySubmissionReply(
  input: HarnessStepInput,
  members: QualitySubmissionMembers | undefined,
  reply: string,
  { collectAttemptEvidence }: ReplyAdmissionContext,
): QualityArtifactReplyAdmission {
  if (!members) {
    throw new InferenceStepError(
      "The final evaluator answered without calling the submit_quality_evaluation tool.",
      "malformed-response",
      true,
      collectAttemptEvidence(),
      { ...rejectOutput("quality-submission-missing", "$") },
    );
  }
  try {
    const admitted = admitSubmittedQualityArtifact(members, reply, input.qualityProfileSelection!);
    const qualityArtifactCandidate = { ...admitted, answerPath: "tool-call" as const };
    return { summary: qualityArtifactCandidate.reportMarkdown, qualityArtifactCandidate };
  } catch (error) {
    throw qualitySubmissionFailure(error, collectAttemptEvidence());
  }
}
