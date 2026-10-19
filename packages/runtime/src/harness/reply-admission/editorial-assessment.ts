// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ArtifactValidationError } from "../../artifacts/contracts.js";
import { canonicalDigest } from "../../content-ir/canonical.js";
// The generated catalog table itself, a leaf, as plan-binding.ts imports it.
import { rejectCorrectable } from "../../contracts/model-output.generated.js";
import {
  InferenceStepError,
  type HarnessStepInput,
  type HarnessStepResult,
  type InferenceRejectionReasonV1,
} from "../../execution/contracts.js";
import { isAmbiguousJsonEnvelope } from "../../execution/json-envelope.js";
import { canonicalizeJsonEvidence, JsonEvidenceError } from "../../json-evidence.js";
import {
  assertModelResponseCredentialFree,
  CredentialBoundaryError,
} from "../../security/credential-isolation.js";
import {
  decodeEditorialAssessmentProposalV1,
  EditorialEvidenceHostError,
} from "../../workflow-execution/editorial-evidence-host.js";
import { requiresEditorialReviewResult } from "../../workflow-execution/review-response.js";
import type { SourceObligationRejectionCode } from "../../workflow-execution/source-obligation.js";
import { requiresVerificationResult } from "../../workflow-execution/verification-result.js";
import {
  decodeEditorialAssessmentResponseV1,
  EditorialAssessmentEnvelopeError,
  editorialAssessmentEvidenceRefsV1,
  isEditorialAssessmentStep,
  isQualityArtifactEvaluator,
} from "../editorial-response-contract.js";
import type { ReplyAdmissionContext } from "./context.js";

/** Coded, content-free reason for a reply outside the editorial assessment envelope. */
export const EDITORIAL_ENVELOPE_SHAPE_REJECTION = "editorial-envelope-shape";

export interface EditorialAssessmentReplyAdmission {
  summary: string;
  editorialAssessmentProposal?: HarnessStepResult["editorialAssessmentProposal"];
}

// Only this decoder can establish that the proposal accompanied this input's
// admitted summary. A caller-created object with the same fields is no receipt.
const admittedAssessments = new WeakMap<
  EditorialAssessmentReplyAdmission,
  {
    readonly input: HarnessStepInput;
    readonly bindingSha256: string | undefined;
    readonly proposal: unknown;
    readonly summary: string;
  }
>();

/** Snapshot the run, attempt and host inputs that can carry a final text refusal. */
export function qualityTextBinding(input: HarnessStepInput): string | undefined {
  const editorial = isEditorialAssessmentStep(input);
  const create =
    input.workflow.name === "create-documentation" && input.workflow.schemaVersion === 3;
  if (
    (!editorial && !create) ||
    !isQualityArtifactEvaluator(input) ||
    input.qualityAnswerRecords ||
    input.sourceObligationAnswerRecords ||
    (input.answerSubmission && input.answerSubmission.path !== "text-final")
  )
    return undefined;
  if (
    !input.runId ||
    !input.inferenceAttempt ||
    !input.evidenceIdentity ||
    (editorial && !input.editorialCandidate) ||
    (create && !input.qualityEvaluationTarget?.length)
  )
    return undefined;
  return canonicalDigest({
    runId: input.runId,
    attempt: input.inferenceAttempt,
    workflow: { name: input.workflow.name, schemaVersion: input.workflow.schemaVersion },
    step: {
      id: input.step.id,
      skill: input.step.skill,
      kind: input.step.kind ?? "inference",
      mode: input.step.mode,
    },
    evidenceIdentity: input.evidenceIdentity,
    candidate: input.editorialCandidate ?? null,
    selection: input.qualityProfileSelection ?? null,
    target: input.qualityEvaluationTarget ?? null,
  });
}

/** An original, unchanged text reply admitted for this exact quality attempt. */
export function isAdmittedQualityTextReply(
  input: HarnessStepInput,
  admission: EditorialAssessmentReplyAdmission | undefined,
): boolean {
  const held = admission && admittedAssessments.get(admission);
  return (
    held !== undefined &&
    held.input === input &&
    held.bindingSha256 !== undefined &&
    held.bindingSha256 === qualityTextBinding(input) &&
    held.proposal === admission?.editorialAssessmentProposal &&
    held.summary === admission?.summary
  );
}

/** The genuine proposal admitted with this exact reply, never a caller's copy. */
export function admittedEditorialAssessmentProposal(
  input: HarnessStepInput,
  admission: EditorialAssessmentReplyAdmission | undefined,
): unknown | undefined {
  const held = admission && admittedAssessments.get(admission);
  return held?.input === input &&
    held.bindingSha256 === qualityTextBinding(input) &&
    held.proposal === admission?.editorialAssessmentProposal &&
    held.summary === admission?.summary
    ? held.proposal
    : undefined;
}

/**
 * Admit the envelope of an independent editorial assessment step. Any other
 * step keeps its summary and gains no proposal.
 */
export function admitEditorialAssessmentReply(
  input: HarnessStepInput,
  summary: string,
  { collectAttemptEvidence }: ReplyAdmissionContext,
): EditorialAssessmentReplyAdmission {
  let editorialAssessmentProposal: HarnessStepResult["editorialAssessmentProposal"];
  if (isEditorialAssessmentStep(input)) {
    try {
      const nestedReviewResult =
        requiresVerificationResult(input) || requiresEditorialReviewResult(input);
      const envelope = decodeEditorialAssessmentResponseV1(summary, { nestedReviewResult });
      // Nested results and the proposal are screened for credentials by their
      // own decoders; a text summary has no other screen, so it is screened here.
      if (!nestedReviewResult) assertModelResponseCredentialFree(envelope.summary);
      editorialAssessmentProposal = decodeEditorialAssessmentProposalV1(
        envelope.editorialAssessmentProposal,
        editorialAssessmentEvidenceRefsV1(input),
      );
      summary =
        typeof envelope.summary === "string"
          ? envelope.summary
          : canonicalizeJsonEvidence(envelope.summary).trimEnd();
    } catch (error) {
      throw new InferenceStepError(
        error instanceof EditorialEvidenceHostError
          ? `Editorial assessment response rejected: ${error.code}.`
          : error instanceof CredentialBoundaryError
            ? "Editorial assessment response rejected: credential-material."
            : "The independent editorial step returned a malformed assessment envelope.",
        "malformed-response",
        !(
          error instanceof CredentialBoundaryError ||
          (error instanceof EditorialEvidenceHostError && error.code === "credential-material")
        ),
        collectAttemptEvidence(),
        editorialAssessmentRejection(error, summary),
      );
    }
  } else if (qualityTextBinding(input) !== undefined) {
    // CREATE has no outer editorial decoder to screen its final text. A
    // malformed answer still crosses the credential boundary before custody.
    try {
      assertModelResponseCredentialFree(summary);
    } catch (error) {
      if (!(error instanceof CredentialBoundaryError)) throw error;
      throw new InferenceStepError(
        "The final quality response was rejected for containing configured credential material.",
        "malformed-response",
        false,
        collectAttemptEvidence(),
        { code: "credential-material", location: "$" },
      );
    }
  }
  const admission = { summary, editorialAssessmentProposal };
  if (editorialAssessmentProposal || qualityTextBinding(input) !== undefined) {
    admittedAssessments.set(
      admission,
      Object.freeze({
        input,
        bindingSha256: qualityTextBinding(input),
        proposal: editorialAssessmentProposal,
        summary,
      }),
    );
  }
  return admission;
}

/**
 * A shared rejection code at an envelope or proposal location. The type limits it
 * to codes the shared class and retry-hint tables already state.
 */
function sharedRejection(
  code: SourceObligationRejectionCode,
  location: string,
): InferenceRejectionReasonV1 {
  return Object.freeze({ code, location });
}

const PROPOSAL = "$.editorialAssessmentProposal";

/**
 * The rule an editorial assessment refusal broke, and where, for every refusal
 * path. It does not affect the admission decision or its retryability.
 */
function editorialAssessmentRejection(error: unknown, reply: string): InferenceRejectionReasonV1 {
  if (error instanceof EditorialAssessmentEnvelopeError) {
    return { code: EDITORIAL_ENVELOPE_SHAPE_REJECTION, location: "$" };
  }
  // The envelope parses the shared policy's span, so a refusal here is a reply
  // with no JSON document, or with two the policy will not choose between.
  if (error instanceof JsonEvidenceError) {
    return isAmbiguousJsonEnvelope(reply)
      ? rejectCorrectable("reply-json", "reply-json-wrapped", "$")
      : sharedRejection("invalid-json", "$");
  }
  // Only a text summary is screened here.
  if (error instanceof CredentialBoundaryError) {
    return sharedRejection("credential-material", "$.summary");
  }
  if (error instanceof EditorialEvidenceHostError) {
    if (error.rejection) return error.rejection;
    switch (error.code) {
      case "invalid-shape":
      case "invalid-value":
      case "credential-material":
        return sharedRejection(error.code, PROPOSAL);
      case "evidence-unavailable":
        return rejectCorrectable(
          "editorial-assessment",
          "editorial-assessment-evidence-unavailable",
          "$.editorialAssessmentProposal.evidenceRefs[]",
        );
      // Host-owned identity and cross-step checks the proposal does not author.
      case "identity-mismatch":
      case "producer-mismatch":
      case "conflicting-assessment":
        return sharedRejection("unknown", PROPOSAL);
    }
  }
  // A model-cited artifact reference outside the reference grammar.
  if (error instanceof ArtifactValidationError) {
    return sharedRejection("invalid-value", "$.editorialAssessmentProposal.evidenceRefs[]");
  }
  // A host fault, not a rule the reply broke: no finer rule is established.
  return sharedRejection("unknown", "$");
}
