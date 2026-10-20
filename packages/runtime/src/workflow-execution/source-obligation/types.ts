// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Stable ledger, proposal, and host observation shapes shared by the workflow. */
import type { HarnessStepInput } from "../../execution/contracts.js";
import type {
  REVIEW_CATEGORIES,
  REVIEW_SEVERITIES,
  TechnicalFactDimension,
  TechnicalSourceFact,
  VerificationResult,
} from "../review-response.js";
import type {
  OriginalSourceAuthorityCheckV1,
  OriginalSourceAuthorityCapture,
  OriginalSourceAuthorityDescriptorV1,
  OriginalSourceAuthorityEvidenceV1,
  SourceAuthorityProposalAdmissionV1,
  SourceAuthorityProposalV1,
} from "../source-obligation-authority.js";

export const SOURCE_OBLIGATION_LEDGER_KIND = "docsfab-source-obligation-ledger" as const;
export const TECHNICAL_CORRECTION_EVIDENCE_KIND = "docsfab-technical-correction-evidence" as const;
export const TECHNICAL_CORRECTION_PROPOSAL_KIND = "docsfab-technical-correction-proposal" as const;
export const PROVISIONAL_RICH_JUDGMENT_KIND = "docsfab-provisional-rich-judgment" as const;
export const TECHNICAL_RICH_JUDGMENT_KIND = "docsfab-technical-rich-judgment" as const;
export const PROVISIONAL_RICH_CANDIDATE_EVIDENCE_KIND =
  "docsfab-provisional-rich-candidate-evidence" as const;

export type ProvisionalRichProposedEditV1 =
  | { readonly kind: "advice"; readonly text: string }
  | {
      readonly kind: "replacement";
      readonly text: string;
      readonly path: string;
      readonly originalText: string;
      readonly replacementText: string;
    };

export interface ProvisionalRichCandidateV1 {
  readonly issueId: string;
  readonly obligationIds: readonly string[];
  readonly title: string;
  readonly readerConsequence: string;
  readonly proposedEdit: ProvisionalRichProposedEditV1;
}

export interface ProvisionalRichCandidateEvidenceV1 {
  readonly kind: typeof PROVISIONAL_RICH_CANDIDATE_EVIDENCE_KIND;
  readonly schemaVersion: 1;
  readonly sourceObligationLedgerSha256: string;
  readonly scopeSha256: string;
  readonly repositoryRevision: string;
  readonly verificationResultSha256: string;
  readonly candidates: readonly (ProvisionalRichCandidateV1 & {
    readonly candidateSha256: string;
  })[];
  readonly digest: string;
}

export type SourceObligationEvidenceClass = "source-observation" | "source-inference";

export interface SourceObligationV1 {
  id: string;
  dimension: TechnicalFactDimension;
  sourceLocators: string[];
  statement: string;
  evidenceClass: SourceObligationEvidenceClass;
  uncertainty: string;
}

export interface SourceObligationDimensionV1 {
  dimension: TechnicalFactDimension;
  status: "applicable" | "not-applicable" | "unverified";
  reason: string;
  sourceLocators: string[];
  obligations: SourceObligationV1[];
}

export interface SourceObligationLedgerIdentityV1 {
  repositoryRevision: string;
  scopeSha256: string;
  sourceEvidenceSha256: string;
  workspaceSnapshotSha256: string;
  sources: SourceObligationSourceIdentityV1[];
}

export interface SourceObligationLedgerIdentityV2 extends SourceObligationLedgerIdentityV1 {
  originalSourceAuthority: OriginalSourceAuthorityDescriptorV1;
}

export interface SourceObligationSourceIdentityV1 {
  path: string;
  sha256: string;
}

/**
 * The host-observed line count of one sealed-ledger source, bound to its
 * sealed digest. The judgment fill checks a demotion's evidence locators
 * against it.
 */
export interface AdmittedSourceLineCountV1 {
  readonly path: string;
  readonly sha256: string;
  readonly lineCount: number;
}

export interface SourceObligationSourceObserver {
  capturePreservationBase?(paths: readonly string[]): Promise<PreservationBaseEvidence>;
  createPreservationSourceReader?(input: {
    runId: string;
    stepId: string;
    repositoryRevision: string;
    capture: OriginalSourceAuthorityCapture;
    authority: OriginalSourceAuthorityEvidenceV1;
    authorizedPaths: readonly string[];
  }): PreservationSourceReaderV1;
  /** Refuses any source whose current bytes no longer match the sealed digest. */
  lineCounts?(
    sources: readonly SourceObligationSourceIdentityV1[],
  ): Promise<readonly AdmittedSourceLineCountV1[]>;
  observe(paths: readonly string[]): Promise<SourceObligationSourceIdentityV1[]>;
  assertUnchanged(
    sources: readonly SourceObligationSourceIdentityV1[],
    allowedChangedPaths?: readonly string[],
  ): Promise<void>;
  /** The tracked regular files at the run's revision, for naming a refused citation. */
  trackedRegularPaths?(): Promise<ReadonlySet<string>>;
  /**
   * The pages a review with no named scope targets: the documentation pages
   * among the files {@link captureOriginalSourceAuthority} would admit.
   */
  reviewDocumentationTargetPaths?(): Promise<readonly string[]>;
  captureOriginalSourceAuthority?(input: {
    runId: string;
    workflow: HarnessStepInput["workflow"];
    repositoryRevision: string;
    scopeSha256: string;
    workspaceSnapshotSha256: string;
    authorizedPaths?: readonly string[];
  }): Promise<{
    capture: import("../source-obligation-authority.js").OriginalSourceAuthorityCapture;
    evidence: OriginalSourceAuthorityEvidenceV1;
  }>;
  /** Shared host admission path used by text replies and the later records adapter. */
  admitOriginalSourceAuthorityProposals?(input: {
    runId: string;
    repositoryRevision: string;
    capture: OriginalSourceAuthorityCapture;
    authority: OriginalSourceAuthorityEvidenceV1;
    originalPaths: readonly string[];
    writePaths: readonly string[];
    proposals: readonly SourceAuthorityProposalV1[];
    attempt: number;
  }): Promise<{
    capture?: OriginalSourceAuthorityCapture;
    evidence: OriginalSourceAuthorityEvidenceV1;
    admissions: readonly SourceAuthorityProposalAdmissionV1[];
  }>;
}

export interface PreservationBaseEvidence {
  readonly repositoryRevision: string;
  readonly sources: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly content: string;
  }[];
}

/** Host-issued, non-serializable access to exact ranges of admitted originals. */
export interface PreservationSourceReaderV1 {
  readonly kind: "docsfab-preservation-source-reader";
}

export interface PreservationSourceReferenceV1 {
  readonly sourceId: string;
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface PreservationSourceReadV1 {
  readonly sourceId: string;
  readonly path: string;
  readonly sha256: string;
  readonly fromByte: number;
  readonly endByte: number;
  readonly nextFromByte: number | null;
  readonly text: string;
}

export interface SourceObligationLedgerV1 {
  kind: typeof SOURCE_OBLIGATION_LEDGER_KIND;
  schemaVersion: 1;
  identity: SourceObligationLedgerIdentityV1;
  completeness: "bounded-not-proven";
  dimensions: SourceObligationDimensionV1[];
  limitations: string[];
  digest: string;
}

export interface SourceObligationLedgerV2
  extends Omit<SourceObligationLedgerV1, "schemaVersion" | "identity"> {
  schemaVersion: 2;
  identity: SourceObligationLedgerIdentityV2;
  /**
   * Sorted, distinct SHA-256 digests an older host sealed into some ledgers.
   * They admit nothing now; the key is still read so those ledgers keep their
   * digest. No current binding writes it.
   */
  repositoryPathTokenSha256?: string[];
}

export type SourceObligationLedger = SourceObligationLedgerV1 | SourceObligationLedgerV2;

export type SourceObligationLedgerProposalV1 = Pick<
  SourceObligationLedgerV1,
  "completeness" | "dimensions" | "limitations"
> & {
  /** Model proposal metadata, removed before the host seals the final ledger. */
  readonly sourceProposals?: readonly SourceAuthorityProposalV1[];
};

export type ObligationAccountingRowV1 =
  | {
      obligationId: string;
      disposition: "retained";
      factIds: [string];
    }
  | {
      obligationId: string;
      disposition: "refined" | "rejected";
      factIds: string[];
      reason: string;
      sourceLocators: string[];
    };

export interface TechnicalCorrectionResponseV1 {
  verificationResult: VerificationResult;
  obligationAccounting: ObligationAccountingRowV1[];
}

export interface TechnicalCorrectionEvidenceV1 {
  kind: typeof TECHNICAL_CORRECTION_EVIDENCE_KIND;
  schemaVersion: 1;
  sourceObligationLedgerSha256: string;
  verificationResultSha256: string;
  obligationAccounting: ObligationAccountingRowV1[];
  digest: string;
}

export interface TechnicalCorrectionEvidenceV2
  extends Omit<TechnicalCorrectionEvidenceV1, "schemaVersion"> {
  schemaVersion: 2;
  originalSourceAuthoritySha256: string;
  sourceChecks: readonly OriginalSourceAuthorityCheckV1[];
}

export interface TechnicalCorrectionIssueJudgmentV3 {
  id: string;
  severity: (typeof REVIEW_SEVERITIES)[number];
  category: (typeof REVIEW_CATEGORIES)[number];
  location: string;
  factIds: string[];
}

export interface TechnicalCorrectionProposalV3 {
  kind: typeof TECHNICAL_CORRECTION_PROPOSAL_KIND;
  schemaVersion: 3;
  verdict: VerificationResult["review"]["verdict"];
  coverage: VerificationResult["coverage"];
  factInventory: VerificationResult["factInventory"];
  issueJudgments: TechnicalCorrectionIssueJudgmentV3[];
  obligationAccounting: ObligationAccountingRowV1[];
}

export interface TechnicalCorrectionEvidenceV3 {
  kind: typeof TECHNICAL_CORRECTION_EVIDENCE_KIND;
  schemaVersion: 3;
  sourceObligationLedgerSha256: string;
  verificationResultSha256: string;
  proposal: TechnicalCorrectionProposalV3;
  proposalSha256: string;
  originalSourceAuthoritySha256: string;
  sourceChecks: readonly OriginalSourceAuthorityCheckV1[];
  digest: string;
}

export interface TechnicalCorrectionResponseV3 {
  proposal: TechnicalCorrectionProposalV3;
  verificationResult: VerificationResult;
  evidence: TechnicalCorrectionEvidenceV3;
}

export type TechnicalCorrectionRichIssueV4 =
  | {
      readonly issueId: string;
      readonly status: "unavailable";
      readonly reason:
        | "candidate-absent"
        | "link-changed"
        | "contradicted"
        | "unresolved"
        | "source-unavailable"
        | "qualification-unproven";
    }
  | {
      readonly issueId: string;
      readonly status: "admitted";
      readonly candidateSha256: string;
      readonly title: string;
      readonly readerConsequence: string;
      readonly proposedEdit: ProvisionalRichProposedEditV1;
      readonly grounding: readonly {
        readonly factId: string;
        readonly qualification: string;
        readonly status: "supported";
        readonly rationale: string;
        readonly sourceLocators: readonly string[];
      }[];
    };

export interface TechnicalRichAssessmentV1 {
  readonly issueId: string;
  readonly candidateSha256: string;
  readonly grounds: readonly {
    readonly obligationId: string;
    readonly status: "supported" | "contradicted" | "unresolved";
    readonly rationale: string;
    readonly sourceLocators: readonly string[];
    readonly uncertainty: string;
  }[];
}

export interface TechnicalCorrectionEvidenceV4
  extends Omit<TechnicalCorrectionEvidenceV3, "schemaVersion"> {
  schemaVersion: 4;
  provisionalRichCandidateSha256: string;
  richAssessments: readonly TechnicalRichAssessmentV1[];
  richIssues: readonly TechnicalCorrectionRichIssueV4[];
}

export interface TechnicalCorrectionResponseV4 {
  proposal: TechnicalCorrectionProposalV3;
  verificationResult: VerificationResult;
  evidence: TechnicalCorrectionEvidenceV4;
}

export type TechnicalCorrectionEvidence =
  | TechnicalCorrectionEvidenceV1
  | TechnicalCorrectionEvidenceV2
  | TechnicalCorrectionEvidenceV3
  | TechnicalCorrectionEvidenceV4;

/** The recorded derivation codes a plan source reference refuses with. */
export type SourceObligationSourceReferenceCode =
  | "invalid-reference"
  | "revision-mismatch"
  | "source-write-intersection"
  | "source-untracked";
