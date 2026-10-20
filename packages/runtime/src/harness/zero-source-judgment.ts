// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The host-determined result of a judgment step whose sealed source-obligation
 * ledger admitted no source. The model could verify nothing and
 * `hostJudgmentVerdict` forces `human-review` anyway, so the host writes the
 * answer itself before any provider session exists.
 *
 * The condition is zero sources, not zero obligations: a ledger with an
 * admitted source and no obligation still has coverage claims a model can check.
 */
import type { HarnessStepInput, HarnessStepResult } from "../execution/contracts.js";
import { hostZeroSourceCoverage } from "../workflow-execution/judgment-coverage.js";
import {
  decodeProvisionalVerificationJudgment,
  decodeTechnicalCorrectionResponseV3,
  degradesJudgmentModelContent,
  requiresTechnicalCorrection,
  usesProvisionalVerificationJudgment,
  type JudgmentCoveragePolicy,
} from "../workflow-execution/source-obligation.js";
import {
  authoritativeReviewTargetPaths,
  rejectTechnicalCorrection,
} from "../workflow-execution/review-response.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";

/**
 * The host's judgment reply for a zero-source run: one unverified coverage
 * entry per approved target and no judgments. It goes through the step's own
 * decoder, so the host answer passes every contract a model answer must pass
 * and no second admission path exists.
 */
export function hostZeroSourceJudgmentReply(targetPaths: readonly string[]): string {
  return JSON.stringify({
    verdict: "human-review",
    coverage: hostZeroSourceCoverage(targetPaths).coverage,
    issueJudgments: [],
    obligationJudgments: [],
  });
}

/**
 * Whether this is a V2-ledger judgment step of a workflow that degrades model
 * content, over a ledger that admitted no source. CREATE refuses rather than
 * degrades, and a V1 ledger has no host-issued obligation identity.
 */
export function usesHostZeroSourceJudgment(input: HarnessStepInput): boolean {
  const ledger = input.sourceObligationLedger;
  if (!ledger || ledger.schemaVersion !== 2) return false;
  if (!degradesJudgmentModelContent(input)) return false;
  if (!usesProvisionalVerificationJudgment(input) && !requiresTechnicalCorrection(input)) {
    return false;
  }
  return ledger.identity.sources.length === 0;
}

/**
 * The host-determined step result, or `undefined` when this step is not one.
 * Spends no provider turn: the caller must reach it before it opens a
 * provider connection.
 */
export async function runHostZeroSourceJudgment(
  input: HarnessStepInput,
): Promise<
  | Pick<HarnessStepResult, "summary" | "verificationResult" | "technicalCorrectionEvidence">
  | undefined
> {
  if (!usesHostZeroSourceJudgment(input)) return undefined;
  const ledger = input.sourceObligationLedger!;
  if (ledger.schemaVersion !== 2) return undefined;
  const targetPaths =
    authoritativeReviewTargetPaths(input) ?? rejectTechnicalCorrection("target-authority");
  const reply = hostZeroSourceJudgmentReply(targetPaths);
  const coveragePolicy: JudgmentCoveragePolicy = {
    degradeCoverage: true,
    hostLimitations: hostZeroSourceCoverage(targetPaths).limitations,
  };
  if (requiresTechnicalCorrection(input)) {
    const correction = await decodeTechnicalCorrectionResponseV3(
      reply,
      ledger,
      input.originalSourceAuthorityAdmission ?? rejectTechnicalCorrection("source-authority"),
      input.runId ?? "",
      targetPaths,
      input.admittedSourceLineCounts,
      coveragePolicy,
    );
    return {
      summary: canonicalSummary(correction.verificationResult),
      verificationResult: correction.verificationResult,
      technicalCorrectionEvidence: correction.evidence,
    };
  }
  const verificationResult = decodeProvisionalVerificationJudgment(
    reply,
    ledger,
    targetPaths,
    input.admittedSourceLineCounts,
    coveragePolicy,
  );
  return { summary: canonicalSummary(verificationResult), verificationResult };
}

function canonicalSummary(verificationResult: unknown): string {
  return canonicalizeJsonEvidence(verificationResult as JsonEvidenceValue).trimEnd();
}
