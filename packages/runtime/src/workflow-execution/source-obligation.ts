// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SourceObligationLedgerV2 } from "./source-obligation/types.js";
import {
  SOURCE_OBLIGATION_RESPONSE_CONTRACT,
  TECHNICAL_CORRECTION_RESPONSE_CONTRACT,
  TECHNICAL_CORRECTION_RESPONSE_CONTRACT_V3,
  PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT,
} from "./source-obligation/response-contract.js";
import { type HarnessStepInput } from "../execution/contracts.js";
import { verificationTargetContract } from "./review-response.js";
import { isWorkflowManifestV3 } from "../workflow-contracts/contracts.js";
import { SUPPORTED_WORKFLOWS } from "./source-obligation/validation-kernel.js";
import {
  judgmentAnswerBudgetContract,
  sealedObligationIdContract,
  applicableDimensionContract,
} from "./source-obligation/judgment-transform.js";
export {
  SourceObligationSourceReferenceError,
  failSourceReference,
  sourceObligationFailureReason,
  SOURCE_OBLIGATION_REJECTION_CODES,
  SOURCE_OBLIGATION_REJECTION_RETRYABILITY_COVERAGE,
  SOURCE_OBLIGATION_REJECTION_LOCATIONS,
  SOURCE_OBLIGATION_REJECTION_ERROR,
  sourceObligationRejectionMessage,
  sourceObligationRejectionFromMessage,
  projectSourceObligationRejection,
  sourceObligationReasonCorrection,
  wrapSourceObligationFailure,
  sourceProposalRefusalError,
  SOURCE_OBLIGATION_KIT_REJECTION_CODES,
  rejectSourceObligationKit,
} from "./source-obligation/validation-kernel.js";
export type {
  SourceObligationRejectionCode,
  SourceObligationRejectionLocation,
  SourceObligationRecordedCode,
  SourceObligationKitRejectionCode,
} from "./source-obligation/validation-kernel.js";
export {
  expectedSourceObligationIdentity,
  sourceObligationScopeSha256,
  bindSourceObligationLedger,
  bindSourceObligationLedgerV2,
  validateSourceObligationLedger,
  validateSourceObligationProposal,
  validateSourceObligationRecordForAdmission,
  assertObservableUpdateSourceLocators,
  sourceObligationLocatorPaths,
  decodeSourceObligationResponse,
  canonicalSourceObligationProposal,
  hostMintObligationIdentity,
  assertSourceObligationSourceAuthority,
  sourceReferencePath,
  technicalCorrectionAuthorityPaths,
  sealedLedgerSourceEvidence,
} from "./source-obligation/ledger-codec.js";
export type {
  SourceObligationDecodeOptions,
  SourceAuthorityInput,
  SourceEvidenceTallyV1,
} from "./source-obligation/ledger-codec.js";
export {
  bindTechnicalCorrectionResponse,
  bindTechnicalCorrectionResponseV2,
  bindTechnicalCorrectionResponseV3,
  bindHostOwnedTechnicalCorrectionProposalV3,
  decodeTechnicalCorrectionResponse,
  decodeTechnicalCorrectionResponseV2,
  decodeTechnicalCorrectionResponseV3,
  decodeTechnicalCorrectionResponseV4,
  decodeProvisionalVerificationJudgment,
  decodeProvisionalRichJudgment,
  validateProvisionalRichCandidateEvidence,
  judgmentAnswerCharBudget,
  judgmentAnswerBudgetContract,
  sealedObligationIdContract,
  applicableDimensionObligationIds,
  applicableDimensionContract,
  admittedEvidencePathContract,
  REFUSING_JUDGMENT_COVERAGE_POLICY,
  judgmentCoveragePolicy,
  hostFillTechnicalCorrectionProposalFromJudgmentV3,
  hostFilledJudgmentCoreBytes,
  assertReviewLedgerFitsProposalCore,
  judgmentOrigin,
  hostFilledDimensionDemotionReason,
  hostCutDemotionEvidenceLimitation,
  dimensionDemotionReason,
  demotionEvidenceLimitation,
  reviewDocumentationTargetPaths,
  hostFilledCoverageBytes,
  assertReviewScopeFitsProposalBound,
  ReviewScopeBoundError,
  validateTechnicalCorrectionEvidence,
  validateTechnicalRichCandidateBinding,
} from "./source-obligation/judgment-transform.js";
export type {
  JudgmentCoveragePolicy,
  TechnicalCorrectionByteBoundScope,
} from "./source-obligation/judgment-transform.js";
export {
  SOURCE_OBLIGATION_LEDGER_KIND,
  TECHNICAL_CORRECTION_EVIDENCE_KIND,
  TECHNICAL_CORRECTION_PROPOSAL_KIND,
  PROVISIONAL_RICH_JUDGMENT_KIND,
  TECHNICAL_RICH_JUDGMENT_KIND,
  PROVISIONAL_RICH_CANDIDATE_EVIDENCE_KIND,
  type ProvisionalRichCandidateV1,
  type ProvisionalRichCandidateEvidenceV1,
  type SourceObligationEvidenceClass,
  type SourceObligationV1,
  type SourceObligationDimensionV1,
  type SourceObligationLedgerIdentityV1,
  type SourceObligationLedgerIdentityV2,
  type SourceObligationSourceIdentityV1,
  type AdmittedSourceLineCountV1,
  type SourceObligationSourceObserver,
  type PreservationBaseEvidence,
  type PreservationSourceReaderV1,
  type PreservationSourceReferenceV1,
  type PreservationSourceReadV1,
  type SourceObligationLedgerV1,
  type SourceObligationLedgerV2,
  type SourceObligationLedger,
  type SourceObligationLedgerProposalV1,
  type ObligationAccountingRowV1,
  type TechnicalCorrectionResponseV1,
  type TechnicalCorrectionEvidenceV1,
  type TechnicalCorrectionEvidenceV2,
  type TechnicalCorrectionIssueJudgmentV3,
  type TechnicalCorrectionProposalV3,
  type TechnicalCorrectionEvidenceV3,
  type TechnicalCorrectionResponseV3,
  type TechnicalCorrectionRichIssueV4,
  type TechnicalCorrectionEvidenceV4,
  type TechnicalCorrectionResponseV4,
  type TechnicalCorrectionEvidence,
  type SourceObligationSourceReferenceCode,
} from "./source-obligation/types.js";
export {
  SOURCE_OBLIGATION_CATALOG_CODES,
  SOURCE_OBLIGATION_CATALOG_RULES,
  SOURCE_OBLIGATION_RESPONSE_CONTRACT,
  TECHNICAL_CORRECTION_RESPONSE_CONTRACT,
  TECHNICAL_CORRECTION_RESPONSE_CONTRACT_V3,
  PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT,
  JUDGMENT_ISSUE_LINK_RULE,
  OBLIGATION_JUDGMENT_ACCOUNTING_CONTRACT,
  fixedProvisionalRichCandidateContract,
  type SourceObligationCatalogCode,
} from "./source-obligation/response-contract.js";
export {
  degradesJudgmentModelContent,
  withoutUnobservableSourceLocators,
} from "./source-obligation/locator-degradation.js";
// Key sets live in one dependency-free module.
export {
  TECHNICAL_CORRECTION_PROPOSAL_KEYS,
  TECHNICAL_CORRECTION_JUDGMENT_KEYS,
  TECHNICAL_CORRECTION_IGNORED_IDENTITY_KEYS,
  TECHNICAL_CORRECTION_ENVELOPE_KEYS,
  TECHNICAL_CORRECTION_ISSUE_JUDGMENT_KEYS,
  TECHNICAL_CORRECTION_PROPOSAL_ISSUE_JUDGMENT_KEYS,
  TECHNICAL_CORRECTION_OBLIGATION_JUDGMENT_KEYS,
  TECHNICAL_CORRECTION_REPLACEMENT_KEYS,
  OBLIGATION_ACCOUNTING_KEYS,
  SOURCE_OBLIGATION_PROPOSAL_KEYS,
  SOURCE_OBLIGATION_DIMENSION_KEYS,
  SOURCE_OBLIGATION_KEYS,
} from "../execution/response-contract-keys.js";
/**
 * Why the host writes judgment rows itself and demotes the dimensions they
 * empty: the answer was cut at the output limit, or the step's own checks
 * refused the reply with no retry left, or refused a reply completed by a
 * continuation without spending another whole attempt.
 */
export { HOST_FILL_REASONS, type HostFillReason } from "./host-judgment-rejection.js";

/** Whether the eager preservation snapshot belongs in this step's prompt. */
export function shouldDeliverPreservationBaseEvidence(input: {
  readonly workflowName: string;
  readonly stepId: string;
  readonly deliveryMode: "eager" | "stage-specific" | undefined;
}): boolean {
  return !(
    input.deliveryMode === "stage-specific" &&
    input.workflowName === "restructure-documentation" &&
    input.stepId === "test-audience-understanding"
  );
}

/** Pin A inventory step. Pin B skill is `verify-technical-accuracy` in inventory-only mode. */
export const SOURCE_OBLIGATION_STEP_ID = "derive-source-obligations" as const;
export const PROVISIONAL_TECHNICAL_STEP_ID = "provisional-technical-verification" as const;
export const CANONICAL_TECHNICAL_STEP_ID = "verify-technical-accuracy" as const;
export const REVISED_PROVISIONAL_TECHNICAL_STEP_ID =
  "provisional-revised-technical-verification" as const;
export const REVISED_CANONICAL_TECHNICAL_STEP_ID = "verify-revised-technical-accuracy" as const;

export function isSourceFactInventory(input: Pick<HarnessStepInput, "workflow" | "step">): boolean {
  return (
    (hasSourceObligationPhases(input.workflow) || hasInventoryBeforeWrite(input.workflow)) &&
    input.step.id === SOURCE_OBLIGATION_STEP_ID &&
    input.step.skill === CANONICAL_TECHNICAL_STEP_ID
  );
}

export function requiresSourceObligationLedger(
  input: Pick<HarnessStepInput, "workflow" | "step">,
): boolean {
  return isSourceFactInventory(input);
}

export function isProvisionalTechnicalVerification(
  input: Pick<HarnessStepInput, "workflow" | "step">,
): boolean {
  if (!hasSourceObligationPhases(input.workflow)) return false;
  if (input.step.skill !== CANONICAL_TECHNICAL_STEP_ID) return false;
  return (
    input.step.id === PROVISIONAL_TECHNICAL_STEP_ID ||
    (isWorkflowManifestV3(input.workflow) &&
      input.step.id === REVISED_PROVISIONAL_TECHNICAL_STEP_ID)
  );
}

/**
 * The single selector for the provisional judgment-only response mode. Prompt
 * binding and response decoding both select on it, so the contract the model
 * sees is the shape the host admits. Only a V2 ledger carries the host-issued
 * obligation identity judgment host-fill requires.
 */
export function usesProvisionalVerificationJudgment<
  T extends Pick<HarnessStepInput, "workflow" | "step" | "sourceObligationLedger">,
>(input: T): input is T & { sourceObligationLedger: SourceObligationLedgerV2 } {
  return (
    isProvisionalTechnicalVerification(input) && input.sourceObligationLedger?.schemaVersion === 2
  );
}

export function isCanonicalTechnicalAdmission(
  input: Pick<HarnessStepInput, "workflow" | "step">,
): boolean {
  if (input.step.skill !== CANONICAL_TECHNICAL_STEP_ID) return false;
  return (
    input.step.id === CANONICAL_TECHNICAL_STEP_ID ||
    (isWorkflowManifestV3(input.workflow) && input.step.id === REVISED_CANONICAL_TECHNICAL_STEP_ID)
  );
}

export function requiresTechnicalCorrection(
  input: Pick<HarnessStepInput, "workflow" | "step">,
): boolean {
  return hasSourceObligationPhases(input.workflow) && isCanonicalTechnicalAdmission(input);
}

/**
 * Update authoring and restructure schedule inventory-only verify before write.
 * That Pin A step is not the create/review provisional-then-correction pair.
 */
export function hasInventoryBeforeWrite(workflow: HarnessStepInput["workflow"]): boolean {
  if (workflow.name !== "update-documentation" && workflow.name !== "restructure-documentation") {
    return false;
  }
  const deriveIndexes = workflow.steps.flatMap((step, index) =>
    step.id === SOURCE_OBLIGATION_STEP_ID &&
    step.skill === CANONICAL_TECHNICAL_STEP_ID &&
    (step.kind ?? "inference") === "evaluate" &&
    step.mode === "read-only"
      ? [index]
      : [],
  );
  const writerIndexes = workflow.steps.flatMap((step, index) =>
    step.id === "write-documentation" &&
    step.skill === "write-documentation" &&
    (step.kind ?? "inference") === "inference" &&
    step.mode === "write"
      ? [index]
      : [],
  );
  return (
    deriveIndexes.length === 1 &&
    writerIndexes.length === 1 &&
    deriveIndexes[0]! < writerIndexes[0]! &&
    workflow.steps.every((step) => step.id !== PROVISIONAL_TECHNICAL_STEP_ID)
  );
}

/** Historical/direct workflows keep their existing technical response contract. */
export function hasSourceObligationPhases(workflow: HarnessStepInput["workflow"]): boolean {
  if (!SUPPORTED_WORKFLOWS.has(workflow.name)) return false;
  const indices = (
    id: string,
    skill: string,
    kind: "evaluate" | "host-operation" | "inference",
    mode: "read-only" | "write",
  ) =>
    workflow.steps.flatMap((step, index) =>
      step.id === id &&
      step.skill === skill &&
      (step.kind ?? "inference") === kind &&
      step.mode === mode
        ? [index]
        : [],
    );
  const derive = indices(
    SOURCE_OBLIGATION_STEP_ID,
    CANONICAL_TECHNICAL_STEP_ID,
    "evaluate",
    "read-only",
  );
  const provisional = indices(
    PROVISIONAL_TECHNICAL_STEP_ID,
    CANONICAL_TECHNICAL_STEP_ID,
    "evaluate",
    "read-only",
  );
  const final = indices(
    CANONICAL_TECHNICAL_STEP_ID,
    CANONICAL_TECHNICAL_STEP_ID,
    "evaluate",
    "read-only",
  );
  if (isWorkflowManifestV3(workflow)) {
    const revisedProvisional = indices(
      REVISED_PROVISIONAL_TECHNICAL_STEP_ID,
      CANONICAL_TECHNICAL_STEP_ID,
      "evaluate",
      "read-only",
    );
    const revisedFinal = indices(
      REVISED_CANONICAL_TECHNICAL_STEP_ID,
      CANONICAL_TECHNICAL_STEP_ID,
      "evaluate",
      "read-only",
    );
    const legacyExpected = [
      ["plan-documentation", "plan-documentation", "evaluate", "read-only"],
      [SOURCE_OBLIGATION_STEP_ID, CANONICAL_TECHNICAL_STEP_ID, "evaluate", "read-only"],
      ["write-documentation", "write-documentation", "inference", "write"],
      ["lint-documentation", "lint-documentation", "host-operation", "read-only"],
      [PROVISIONAL_TECHNICAL_STEP_ID, CANONICAL_TECHNICAL_STEP_ID, "evaluate", "read-only"],
      [CANONICAL_TECHNICAL_STEP_ID, CANONICAL_TECHNICAL_STEP_ID, "evaluate", "read-only"],
      ["review-documentation", "review-documentation", "evaluate", "read-only"],
      ["revise-documentation", "write-documentation", "inference", "write"],
      ["lint-revised-documentation", "lint-documentation", "host-operation", "read-only"],
      [REVISED_PROVISIONAL_TECHNICAL_STEP_ID, CANONICAL_TECHNICAL_STEP_ID, "evaluate", "read-only"],
      [REVISED_CANONICAL_TECHNICAL_STEP_ID, CANONICAL_TECHNICAL_STEP_ID, "evaluate", "read-only"],
      ["review-revised-documentation", "review-documentation", "evaluate", "read-only"],
      ["test-audience-understanding", "test-audience-understanding", "evaluate", "read-only"],
      ["evaluate-document-quality", "evaluate-document-quality", "evaluate", "read-only"],
    ] as const;
    const correctedExpected = [
      ...legacyExpected.slice(0, 5),
      legacyExpected[6]!,
      legacyExpected[5]!,
      ...legacyExpected.slice(7),
    ] as const;
    const matches = (
      expected: readonly (readonly [
        string,
        string,
        "evaluate" | "host-operation" | "inference",
        "read-only" | "write",
      ])[],
    ) =>
      expected.every(([id, skill, kind, mode], index) => {
        const found = indices(id, skill, kind, mode);
        return found.length === 1 && found[0] === index;
      });
    return (
      workflow.name === "create-documentation" &&
      (matches(legacyExpected) || matches(correctedExpected)) &&
      workflow.steps.filter((step) => step.mode === "write").length === 2 &&
      revisedProvisional.length === 1 &&
      revisedFinal.length === 1
    );
  }
  if (derive.length !== 1 || provisional.length !== 1 || final.length !== 1) return false;
  if (workflow.name === "create-documentation") {
    const plan = indices("plan-documentation", "plan-documentation", "evaluate", "read-only");
    const writer = indices("write-documentation", "write-documentation", "inference", "write");
    const writeSteps = workflow.steps.flatMap((step, index) =>
      step.mode === "write" ? [index] : [],
    );
    return (
      plan.length === 1 &&
      writer.length === 1 &&
      writeSteps.length === 1 &&
      writeSteps[0] === writer[0] &&
      plan[0]! < derive[0]! &&
      derive[0]! < writer[0]! &&
      writer[0]! < provisional[0]! &&
      provisional[0]! < final[0]!
    );
  }
  const audit = indices("audit-documentation", "audit-documentation", "evaluate", "read-only");
  const writeSteps = workflow.steps.filter((step) => step.mode === "write");
  return (
    audit.length === 1 &&
    writeSteps.length === 0 &&
    audit[0]! < derive[0]! &&
    derive[0]! < provisional[0]! &&
    provisional[0]! < final[0]!
  );
}

export function assertSourceObligationPhaseContract(
  workflow: HarnessStepInput["workflow"],
): boolean {
  // V1 snapshots bind the Pin A step to the retired catalog identity, which is
  // not the inventory-only contract; they keep the older technical-response
  // decoder.
  if (
    !isWorkflowManifestV3(workflow) &&
    workflow.steps.some(
      (step) => step.id === SOURCE_OBLIGATION_STEP_ID && step.skill === SOURCE_OBLIGATION_STEP_ID,
    )
  ) {
    return false;
  }
  const markers = workflow.steps.filter(
    (step) =>
      step.id === SOURCE_OBLIGATION_STEP_ID ||
      step.skill === SOURCE_OBLIGATION_STEP_ID ||
      step.id === PROVISIONAL_TECHNICAL_STEP_ID ||
      step.id === REVISED_PROVISIONAL_TECHNICAL_STEP_ID ||
      step.id === REVISED_CANONICAL_TECHNICAL_STEP_ID,
  );
  if (markers.length === 0) return false;
  if (hasSourceObligationPhases(workflow)) return true;
  if (
    hasInventoryBeforeWrite(workflow) &&
    markers.every(
      (step) => step.id === SOURCE_OBLIGATION_STEP_ID && step.skill === CANONICAL_TECHNICAL_STEP_ID,
    )
  ) {
    return false;
  }
  throw new Error("Workflow contains an incomplete or misordered source-obligation phase set.");
}

export function bindProvisionalVerificationJudgmentContract(
  input: HarnessStepInput,
  outputTokens?: number,
): HarnessStepInput {
  if (!usesProvisionalVerificationJudgment(input)) return input;
  const targetContract = verificationTargetContract(input);
  const obligationIdContract = sealedObligationIdContract(input);
  const dimensionContract = applicableDimensionContract(input);
  return {
    ...input,
    step: {
      ...input.step,
      prompt: [
        input.step.prompt,
        "",
        PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT,
        judgmentAnswerBudgetContract(outputTokens),
        ...(targetContract ? [targetContract] : []),
        ...(obligationIdContract ? [obligationIdContract] : []),
        ...(dimensionContract ? [dimensionContract] : []),
      ].join("\n"),
    },
  };
}

export function bindSourceObligationResponseContract(
  input: HarnessStepInput,
  outputTokens?: number,
): HarnessStepInput {
  if (input.sourceObligationAnswerRecords) {
    return {
      ...input,
      step: {
        ...input.step,
        prompt: [
          input.step.prompt,
          "",
          input.sourceObligationAnswerRecordGuidance ??
            "Submit separate per-dimension and per-obligation source-obligation records.",
        ].join("\n"),
      },
    };
  }
  const contract = requiresSourceObligationLedger(input)
    ? SOURCE_OBLIGATION_RESPONSE_CONTRACT
    : requiresTechnicalCorrection(input)
      ? input.sourceObligationLedger?.schemaVersion === 2
        ? TECHNICAL_CORRECTION_RESPONSE_CONTRACT_V3
        : TECHNICAL_CORRECTION_RESPONSE_CONTRACT
      : undefined;
  if (!contract) return input;
  const targetContract = requiresTechnicalCorrection(input)
    ? verificationTargetContract(input)
    : undefined;
  const judgmentContract = contract === TECHNICAL_CORRECTION_RESPONSE_CONTRACT_V3;
  const obligationIdContract = judgmentContract ? sealedObligationIdContract(input) : undefined;
  const dimensionContract = judgmentContract ? applicableDimensionContract(input) : undefined;
  return {
    ...input,
    step: {
      ...input.step,
      prompt: [
        input.step.prompt,
        "",
        contract,
        // The V3 correction answers the same judgment shape as the provisional
        // step, so it gets the same budget.
        ...(judgmentContract ? [judgmentAnswerBudgetContract(outputTokens)] : []),
        ...(targetContract ? [targetContract] : []),
        ...(obligationIdContract ? [obligationIdContract] : []),
        ...(dimensionContract ? [dimensionContract] : []),
      ].join("\n"),
    },
  };
}
