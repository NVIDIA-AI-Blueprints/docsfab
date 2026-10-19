// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Seal an admitted source proposal before later plan and quality settlement. */

import type { HarnessStepInput, HarnessStepResult } from "../../execution/contracts.js";
import type { StepRunRecord } from "../../records/contracts.js";
import type { RunRecord } from "../../records/contracts.js";
import type { QualityValidationSuccess } from "../../evaluation-report/quality-validator-host.js";
import { qualityCandidateAdmissionError } from "../../evaluation-report/quality-check-rejections.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";
import {
  assertReviewLedgerFitsProposalCore,
  bindSourceObligationLedgerV2,
  canonicalSourceObligationProposal,
  sourceObligationLocatorPaths,
  withoutUnobservableSourceLocators,
  type SourceObligationLedger,
  type SourceObligationLedgerProposalV1,
  type SourceObligationSourceObserver,
} from "../source-obligation.js";
import type { OriginalSourceAuthorityEvidenceV1 } from "../source-obligation-authority.js";
import { observableSourcePath } from "../source-obligation-observer.js";

/** The attempt's final evaluator admission, reused after result settlement. */
export type QualityCandidateAdmission =
  | { readonly evaluatorIdentitySha256: string; readonly validated: QualityValidationSuccess }
  | { readonly refusal: unknown };

export async function settleSourceObligationResult(input: {
  readonly workflowName: string;
  readonly stepInput: HarnessStepInput;
  readonly result: HarnessStepResult;
  readonly proposal?: SourceObligationLedgerProposalV1;
  readonly observer?: SourceObligationSourceObserver;
  readonly originalAuthority?: OriginalSourceAuthorityEvidenceV1;
  readonly verificationTargetPaths?: readonly string[];
  readonly stepRecord: StepRunRecord;
  readonly retainLedger: (ledger: SourceObligationLedger) => void;
}): Promise<HarnessStepResult> {
  const { result, proposal, observer, originalAuthority } = input;
  if (!result.sourceObligationProposal || !proposal || !observer) {
    throw new Error("The source-obligation step returned no admitted ledger proposal.");
  }
  const canonicalProposal = canonicalSourceObligationProposal(proposal);
  if (result.summary !== canonicalProposal) {
    throw new Error(
      "The source-obligation proposal summary does not match its canonical representation.",
    );
  }
  if (!originalAuthority) {
    throw new Error("The source-obligation step has no retained original authority.");
  }
  // Drop each locator the observer would refuse; an all-unverified ledger cites none.
  const sealedProposal = withoutUnobservableSourceLocators(
    proposal,
    input.stepInput,
    observableSourcePath(originalAuthority),
  );
  const locatorPaths = sourceObligationLocatorPaths(sealedProposal);
  const sources = locatorPaths.length === 0 ? [] : await observer.observe(locatorPaths);
  const ledger = bindSourceObligationLedgerV2(
    sealedProposal,
    input.stepInput,
    sources,
    originalAuthority,
  );
  input.retainLedger(ledger);
  const settled = {
    ...result,
    summary: canonicalizeJsonEvidence(ledger as unknown as JsonEvidenceValue).trimEnd(),
  };
  if (input.workflowName === "review-documentation") {
    input.stepRecord.summary = settled.summary;
    assertReviewLedgerFitsProposalCore(ledger, input.verificationTargetPaths ?? []);
  }
  return settled;
}

/** Bind the final quality report to the recorded evaluator identity. */
export function settleQualityResult(input: {
  readonly admission: QualityCandidateAdmission;
  readonly stepRecord: StepRunRecord;
  readonly record: RunRecord;
}): QualityValidationSuccess {
  const { admission } = input;
  if ("refusal" in admission) throw admission.refusal;
  if (
    admission.evaluatorIdentitySha256 !== input.stepRecord.evaluateEvidence?.evaluatorIdentitySha256
  ) {
    throw qualityCandidateAdmissionError(
      "quality-evaluator-identity-unbound",
      "The validated evaluator identity differs from the identity recorded for this step.",
    );
  }
  input.stepRecord.summary = admission.validated.reportMarkdown;
  input.record.qualityArtifactValidation = admission.validated.binding;
  return admission.validated;
}
