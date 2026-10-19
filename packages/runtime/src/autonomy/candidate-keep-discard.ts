// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CANDIDATE_OBJECTIVE_DIMENSIONS,
  CANDIDATE_QUALITY_DIMENSIONS,
  candidateFail,
  objectivesPassed,
  type CandidateAttemptV1,
  type CandidateBaselineV1,
  type CandidateEvaluationVectorV1,
} from "./candidate-attempt.js";
import { createCandidateDialect, deepFreeze } from "./candidate-dialect.js";

const kit = createCandidateDialect(candidateFail);

export const CANDIDATE_DECISION_DISPOSITIONS = ["keep", "discard"] as const;
export type CandidateDecisionDisposition = (typeof CANDIDATE_DECISION_DISPOSITIONS)[number];

export const CANDIDATE_DECISION_REASON_CODES = [
  "objective-regression",
  "objective-gate-failed",
  "no-quality-improvement",
  "lexicographic-improvement",
  "identical-to-selected",
] as const;
export type CandidateDecisionReasonCode = (typeof CANDIDATE_DECISION_REASON_CODES)[number];

export interface CandidateKeepDiscardDecisionV1 {
  schemaVersion: 1;
  kind: "docsfab-candidate-keep-discard-decision";
  disposition: CandidateDecisionDisposition;
  reasonCode: CandidateDecisionReasonCode;
  attemptSha256: string;
  selectedCandidateSha256: string;
  priorSelectedCandidateSha256: string;
  /** Never altered by keep or discard. */
  sourceCheckoutSha256: string;
  /** Discarded after the decision. */
  disposableWorkspaceId: string;
  decisionSha256: string;
}

/**
 * Lexicographic keep/discard: objective failures always discard; quality
 * dimensions compare only after every objective gate passes. Style cannot
 * offset factual, citation, security, scope, or mechanical regressions.
 */
export function decideCandidateKeepDiscard(input: {
  attempt: CandidateAttemptV1;
  baseline: CandidateBaselineV1;
  /** Evaluation of the currently selected candidate (often baseline). */
  selectedEvaluation: CandidateEvaluationVectorV1;
  priorSelectedCandidateSha256: string;
}): CandidateKeepDiscardDecisionV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const { attempt, baseline } = input;
  if (attempt.sourceCheckoutSha256 !== baseline.sourceCheckoutSha256) {
    candidateFail("workspace-isolation");
  }
  if (attempt.baselineSha256 !== baseline.baselineSha256) {
    candidateFail("invalid-value");
  }
  const priorSelected = kit.hash(input.priorSelectedCandidateSha256);
  const selectedEvaluation = input.selectedEvaluation;

  if (!objectivesPassed(attempt.evaluation)) {
    return sealDecision({
      disposition: "discard",
      reasonCode: objectivesPassed(selectedEvaluation)
        ? "objective-regression"
        : "objective-gate-failed",
      attemptSha256: attempt.attemptSha256,
      selectedCandidateSha256: priorSelected,
      priorSelectedCandidateSha256: priorSelected,
      sourceCheckoutSha256: attempt.sourceCheckoutSha256,
      disposableWorkspaceId: attempt.disposableWorkspaceId,
    });
  }

  if (attempt.candidateSha256 === priorSelected) {
    return sealDecision({
      disposition: "discard",
      reasonCode: "identical-to-selected",
      attemptSha256: attempt.attemptSha256,
      selectedCandidateSha256: priorSelected,
      priorSelectedCandidateSha256: priorSelected,
      sourceCheckoutSha256: attempt.sourceCheckoutSha256,
      disposableWorkspaceId: attempt.disposableWorkspaceId,
    });
  }

  // Candidate cleared objectives while the selected candidate did not — keep.
  if (!objectivesPassed(selectedEvaluation)) {
    return sealDecision({
      disposition: "keep",
      reasonCode: "lexicographic-improvement",
      attemptSha256: attempt.attemptSha256,
      selectedCandidateSha256: attempt.candidateSha256,
      priorSelectedCandidateSha256: priorSelected,
      sourceCheckoutSha256: attempt.sourceCheckoutSha256,
      disposableWorkspaceId: attempt.disposableWorkspaceId,
    });
  }

  const comparison = compareLexicographicQuality(attempt.evaluation, selectedEvaluation);
  if (comparison > 0) {
    return sealDecision({
      disposition: "keep",
      reasonCode: "lexicographic-improvement",
      attemptSha256: attempt.attemptSha256,
      selectedCandidateSha256: attempt.candidateSha256,
      priorSelectedCandidateSha256: priorSelected,
      sourceCheckoutSha256: attempt.sourceCheckoutSha256,
      disposableWorkspaceId: attempt.disposableWorkspaceId,
    });
  }

  return sealDecision({
    disposition: "discard",
    reasonCode: "no-quality-improvement",
    attemptSha256: attempt.attemptSha256,
    selectedCandidateSha256: priorSelected,
    priorSelectedCandidateSha256: priorSelected,
    sourceCheckoutSha256: attempt.sourceCheckoutSha256,
    disposableWorkspaceId: attempt.disposableWorkspaceId,
  });
}

/** Positive when left is strictly better; meaningful only after objectives pass. */
export function compareLexicographicQuality(
  left: CandidateEvaluationVectorV1,
  right: CandidateEvaluationVectorV1,
): number {
  if (!objectivesPassed(left) || !objectivesPassed(right)) {
    candidateFail("objective-regression");
  }
  for (const dimension of CANDIDATE_QUALITY_DIMENSIONS) {
    const delta = left.quality[dimension] - right.quality[dimension];
    if (delta !== 0) return delta;
  }
  return 0;
}

export function decodeCandidateKeepDiscardDecision(value: unknown): CandidateKeepDiscardDecisionV1 {
  return kit.decodeSealed(
    value,
    "docsfab-candidate-keep-discard-decision",
    "decisionSha256",
    [
      "disposition",
      "reasonCode",
      "attemptSha256",
      "selectedCandidateSha256",
      "priorSelectedCandidateSha256",
      "sourceCheckoutSha256",
      "disposableWorkspaceId",
    ],
    (root) => {
      const sealed = sealDecision({
        disposition: root.disposition as CandidateDecisionDisposition,
        reasonCode: root.reasonCode as CandidateDecisionReasonCode,
        attemptSha256: root.attemptSha256 as string,
        selectedCandidateSha256: root.selectedCandidateSha256 as string,
        priorSelectedCandidateSha256: root.priorSelectedCandidateSha256 as string,
        sourceCheckoutSha256: root.sourceCheckoutSha256 as string,
        disposableWorkspaceId: root.disposableWorkspaceId as string,
      });
      const {
        schemaVersion: _schemaVersion,
        kind: _kind,
        decisionSha256: _decisionSha256,
        ...body
      } = sealed;
      return body;
    },
  );
}

function sealDecision(input: {
  disposition: CandidateDecisionDisposition;
  reasonCode: CandidateDecisionReasonCode;
  attemptSha256: string;
  selectedCandidateSha256: string;
  priorSelectedCandidateSha256: string;
  sourceCheckoutSha256: string;
  disposableWorkspaceId: string;
}): CandidateKeepDiscardDecisionV1 {
  const disposition = kit.enumeration(input.disposition, CANDIDATE_DECISION_DISPOSITIONS);
  const reasonCode = kit.enumeration(input.reasonCode, CANDIDATE_DECISION_REASON_CODES);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-candidate-keep-discard-decision" as const,
    disposition,
    reasonCode,
    attemptSha256: kit.hash(input.attemptSha256),
    selectedCandidateSha256: kit.hash(input.selectedCandidateSha256),
    priorSelectedCandidateSha256: kit.hash(input.priorSelectedCandidateSha256),
    sourceCheckoutSha256: kit.hash(input.sourceCheckoutSha256),
    disposableWorkspaceId: kit.identifier(input.disposableWorkspaceId),
  };
  // Objective dimensions stay documented for decoder identity / audits.
  void CANDIDATE_OBJECTIVE_DIMENSIONS;
  return deepFreeze({
    ...body,
    decisionSha256: kit.canonicalDigest(body),
  });
}
