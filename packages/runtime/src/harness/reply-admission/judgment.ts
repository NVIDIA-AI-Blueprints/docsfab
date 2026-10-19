// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  InferenceStepError,
  type HarnessStepInput,
  type HarnessStepResult,
} from "../../execution/contracts.js";
import { auditJudgmentRowKeys } from "../../execution/judgment-row-key-audit.js";
import type { RejectedReplyShapePolicy } from "../../execution/rejected-reply-retention.js";
import { jsonEnvelopeBody } from "../../execution/json-envelope.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";
import { isAuthoringRevisionWriter } from "../../workflow-execution/authoring-revision.js";
import {
  rejectTechnicalCorrection,
  wrapTechnicalReviewFailure,
} from "../../workflow-execution/review-response.js";
import {
  canonicalSourceObligationProposal,
  decodeProvisionalVerificationJudgment,
  decodeProvisionalRichJudgment,
  PROVISIONAL_RICH_JUDGMENT_KIND,
  decodeSourceObligationResponse,
  decodeTechnicalCorrectionResponse,
  decodeTechnicalCorrectionResponseV3,
  decodeTechnicalCorrectionResponseV4,
  TECHNICAL_RICH_JUDGMENT_KIND,
  judgmentCoveragePolicy,
  requiresSourceObligationLedger,
  requiresTechnicalCorrection,
  usesProvisionalVerificationJudgment,
  wrapSourceObligationFailure,
  type JudgmentCoveragePolicy,
} from "../../workflow-execution/source-obligation.js";
import {
  authoritativeReviewTargetPaths,
  decodeVerificationResponse,
  requiresVerificationResult,
  validateVerificationResult,
} from "../../workflow-execution/verification-result.js";
import type { ReplyAdmissionContext } from "./context.js";

export interface JudgmentReplyAdmission {
  summary: string;
  verificationResult?: HarnessStepResult["verificationResult"];
  sourceObligationProposal?: HarnessStepResult["sourceObligationProposal"];
  technicalCorrectionEvidence?: HarnessStepResult["technicalCorrectionEvidence"];
  provisionalRichCandidateEvidence?: HarnessStepResult["provisionalRichCandidateEvidence"];
}

/**
 * Admit a judgment reply: a source-obligation ledger, else a technical
 * correction, else a verification result or provisional verification
 * judgment. At most one applies, in that order; any other step keeps its
 * summary and gains no judgment.
 *
 * `coveragePolicy` is the workflow's own policy unless the host completed a cut
 * answer, whose policy adds the host's limitation and the obligations it filled.
 * It reaches both judgment decoders and nothing else.
 */
export async function admitJudgmentReply(
  input: HarnessStepInput,
  summary: string,
  { collectAttemptEvidence }: ReplyAdmissionContext,
  coveragePolicy: JudgmentCoveragePolicy = judgmentCoveragePolicy(input),
): Promise<JudgmentReplyAdmission> {
  let verificationResult: HarnessStepResult["verificationResult"];
  let sourceObligationProposal: HarnessStepResult["sourceObligationProposal"];
  let technicalCorrectionEvidence: HarnessStepResult["technicalCorrectionEvidence"];
  let provisionalRichCandidateEvidence: HarnessStepResult["provisionalRichCandidateEvidence"];
  if (requiresSourceObligationLedger(input)) {
    try {
      sourceObligationProposal = decodeSourceObligationResponse(
        summary,
        // The locator rule strips a revision suffix only when it names this
        // run's revision, so the decoder needs to know which that is.
        input.evidenceIdentity?.repositoryRevision,
        // A locator with no line span is re-asked while a retry remains; the
        // citation authority is the step's own, checked in the attempt.
        { finalAttempt: input.finalInferenceAttempt === true, input },
      );
      summary = canonicalSourceObligationProposal(sourceObligationProposal);
    } catch (error) {
      // Keep the decoder's coded reason; otherwise unrelated defects all read as
      // one indistinguishable `malformed-response`.
      if (error instanceof InferenceStepError) {
        throw wrapSourceObligationFailure(error, collectAttemptEvidence());
      }
      throw error;
    }
  } else if (requiresTechnicalCorrection(input)) {
    if (!input.sourceObligationLedger) {
      throw new InferenceStepError(
        "Technical correction requires the admitted source-obligation ledger for this workflow.",
        "malformed-response",
        false,
        collectAttemptEvidence(),
      );
    }
    try {
      let richFinalEnvelope = false;
      try {
        const parsed = JSON.parse(jsonEnvelopeBody(summary)) as unknown;
        richFinalEnvelope =
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed) &&
          (parsed as { kind?: unknown }).kind === TECHNICAL_RICH_JUDGMENT_KIND;
      } catch {
        // The selected correction decoder owns malformed-reply classification.
      }
      if (
        richFinalEnvelope &&
        (input.sourceObligationLedger.schemaVersion !== 2 ||
          !input.provisionalRichCandidateEvidence)
      )
        throw rejectTechnicalCorrection("invalid-shape");
      const correction =
        input.sourceObligationLedger.schemaVersion === 2
          ? richFinalEnvelope
            ? await decodeTechnicalCorrectionResponseV4(
                summary,
                input.sourceObligationLedger,
                input.originalSourceAuthorityAdmission ??
                  rejectTechnicalCorrection("source-authority"),
                input.runId ?? "",
                authoritativeReviewTargetPaths(input) ??
                  rejectTechnicalCorrection("target-authority"),
                input.provisionalRichCandidateEvidence!,
                input.admittedSourceLineCounts,
                coveragePolicy,
              )
            : await decodeTechnicalCorrectionResponseV3(
                summary,
                input.sourceObligationLedger,
                input.originalSourceAuthorityAdmission ??
                  (() => {
                    return rejectTechnicalCorrection("source-authority");
                  })(),
                input.runId ?? "",
                authoritativeReviewTargetPaths(input) ??
                  (() => {
                    return rejectTechnicalCorrection("target-authority");
                  })(),
                input.admittedSourceLineCounts,
                // Resolved once from the step input, so both judgment decoders
                // read the same policy and neither infers the workflow itself.
                coveragePolicy,
              )
          : decodeTechnicalCorrectionResponse(summary, input.sourceObligationLedger, (value) =>
              validateVerificationResult(value, authoritativeReviewTargetPaths(input)),
            );
      verificationResult = correction.verificationResult;
      technicalCorrectionEvidence = correction.evidence;
      summary = canonicalizeJsonEvidence(
        verificationResult as unknown as JsonEvidenceValue,
      ).trimEnd();
    } catch (error) {
      throw wrapTechnicalReviewFailure(error, collectAttemptEvidence());
    }
  } else if (requiresVerificationResult(input)) {
    try {
      let richEnvelope = false;
      if (usesProvisionalVerificationJudgment(input)) {
        try {
          const parsed = JSON.parse(jsonEnvelopeBody(summary)) as unknown;
          richEnvelope =
            typeof parsed === "object" &&
            parsed !== null &&
            !Array.isArray(parsed) &&
            (parsed as { kind?: unknown }).kind === PROVISIONAL_RICH_JUDGMENT_KIND;
        } catch {
          // The ordinary decoder owns malformed-reply classification.
        }
      }
      if (richEnvelope && input.sourceObligationLedger?.schemaVersion !== 2) {
        throw rejectTechnicalCorrection("invalid-shape");
      }
      if (richEnvelope && input.sourceObligationLedger?.schemaVersion === 2) {
        const rich = decodeProvisionalRichJudgment(
          summary,
          input.sourceObligationLedger,
          authoritativeReviewTargetPaths(input) ??
            (() => {
              return rejectTechnicalCorrection("target-authority");
            })(),
          input.admittedSourceLineCounts,
          coveragePolicy,
        );
        verificationResult = rich.verificationResult;
        provisionalRichCandidateEvidence = rich.evidence;
      } else {
        verificationResult = usesProvisionalVerificationJudgment(input)
          ? decodeProvisionalVerificationJudgment(
              summary,
              input.sourceObligationLedger,
              authoritativeReviewTargetPaths(input) ??
                (() => {
                  return rejectTechnicalCorrection("target-authority");
                })(),
              input.admittedSourceLineCounts,
              coveragePolicy,
            )
          : decodeVerificationResponse(summary, authoritativeReviewTargetPaths(input));
      }
      summary = canonicalizeJsonEvidence(
        verificationResult as unknown as JsonEvidenceValue,
      ).trimEnd();
    } catch (error) {
      throw wrapTechnicalReviewFailure(error, collectAttemptEvidence());
    }
  }
  return {
    summary,
    verificationResult,
    sourceObligationProposal,
    technicalCorrectionEvidence,
    provisionalRichCandidateEvidence,
  };
}

/**
 * The span of a rejected reply the step's own decoder parsed, so a refusal's
 * fingerprint matches the document it was raised against. The authoring
 * revision writer's decoder parses the raw reply, so its span is the raw text.
 */
export function admittedReplySpan(
  input: HarnessStepInput,
  reply: string | undefined,
): string | undefined {
  if (reply === undefined) return undefined;
  return isAuthoringRevisionWriter(input) ? reply : jsonEnvelopeBody(reply);
}

/**
 * Undeclared judgment-row key counts for an accepted provisional or V3
 * correction judgment. Measurement only; the decoders stay lenient.
 */
export function judgmentRowKeyEvidence(
  input: HarnessStepInput,
  reply: string | undefined,
  policy: RejectedReplyShapePolicy,
): Pick<HarnessStepResult, "judgmentRowKeyAudit"> {
  const judgment =
    usesProvisionalVerificationJudgment(input) ||
    (requiresTechnicalCorrection(input) && input.sourceObligationLedger?.schemaVersion === 2);
  if (!judgment || reply === undefined) return {};
  const judgmentRowKeyAudit = auditJudgmentRowKeys(reply, policy.isDeclared);
  return judgmentRowKeyAudit ? { judgmentRowKeyAudit } : {};
}
