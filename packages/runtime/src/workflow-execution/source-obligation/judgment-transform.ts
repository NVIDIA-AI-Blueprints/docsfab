// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  TECHNICAL_CORRECTION_EVIDENCE_KIND,
  TECHNICAL_CORRECTION_PROPOSAL_KIND,
  PROVISIONAL_RICH_JUDGMENT_KIND,
  TECHNICAL_RICH_JUDGMENT_KIND,
  PROVISIONAL_RICH_CANDIDATE_EVIDENCE_KIND,
  type ProvisionalRichCandidateV1,
  type ProvisionalRichCandidateEvidenceV1,
  type SourceObligationDimensionV1,
  type AdmittedSourceLineCountV1,
  type SourceObligationLedgerV1,
  type SourceObligationLedgerV2,
  type SourceObligationLedger,
  type ObligationAccountingRowV1,
  type TechnicalCorrectionResponseV1,
  type TechnicalCorrectionEvidenceV1,
  type TechnicalCorrectionEvidenceV2,
  type TechnicalCorrectionIssueJudgmentV3,
  type TechnicalCorrectionProposalV3,
  type TechnicalCorrectionResponseV3,
  type TechnicalCorrectionRichIssueV4,
  type TechnicalCorrectionEvidenceV4,
  type TechnicalCorrectionResponseV4,
  type TechnicalRichAssessmentV1,
  type TechnicalCorrectionEvidence,
} from ".././source-obligation/types.js";
import { degradesJudgmentModelContent } from ".././source-obligation/locator-degradation.js";
import { canonicalDigest } from "../../content-ir/canonical.js";
import { limit } from "../../config/limits.js";
import { type HarnessStepInput } from "../../execution/contracts.js";
import { rejectCorrectable, type LocationOf } from "../../contracts/model-output.generated.js";
import {
  OBLIGATION_REJECTION_CODES,
  parseTechnicalResponse,
  REVIEW_CATEGORIES,
  REVIEW_SEVERITIES,
  REVIEW_VERDICTS,
  rejectDimensionDemotion,
  rejectEmptiedApplicableDimensions,
  rejectIssueJudgmentVocabulary,
  rejectTechnicalCorrection,
  rejectTechnicalCorrectionFailure,
  rejectTechnicalJudgment,
  rejectUnknownObligationLinks,
  technicalCorrectionBoundary,
  normalizeRepositoryLocator,
  TECHNICAL_CORRECTION_BYTE_BOUNDS,
  TECHNICAL_FACT_DIMENSIONS,
  validateVerificationResult,
  type DimensionDemotionReason,
  type ObligationRejectionCode,
  type TechnicalFactDimension,
  type TechnicalSourceFact,
  type VerificationResult,
} from ".././review-response.js";
import { degradeJudgmentCoverage } from ".././judgment-coverage.js";
import {
  HOST_FILL_REASONS,
  hostRejectedObligationJudgment,
  type HostFillReason,
} from ".././host-judgment-rejection.js";
import { isDocumentationMarkupPath } from "../../repository/documentation-source-support.js";
import {
  admitOriginalSourceAuthorityChecks,
  validateOriginalSourceAuthorityEvidence,
  type OriginalSourceAuthorityAdmission,
  type OriginalSourceAuthorityEvidenceV1,
} from ".././source-obligation-authority.js";
import {
  TECHNICAL_CORRECTION_PROPOSAL_KEYS,
  TECHNICAL_CORRECTION_JUDGMENT_KEYS,
  TECHNICAL_CORRECTION_IGNORED_IDENTITY_KEYS,
  TECHNICAL_CORRECTION_ENVELOPE_KEYS,
  TECHNICAL_CORRECTION_PROPOSAL_ISSUE_JUDGMENT_KEYS,
  PROVISIONAL_RICH_JUDGMENT_ENVELOPE_KEYS,
  PROVISIONAL_RICH_CANDIDATE_KEYS,
  PROVISIONAL_RICH_PROPOSED_EDIT_KEYS,
  PROVISIONAL_RICH_REPLACEMENT_EDIT_KEYS,
  PROVISIONAL_RICH_EVIDENCE_CANDIDATE_KEYS,
  PROVISIONAL_RICH_CANDIDATE_EVIDENCE_KEYS,
} from "../../execution/response-contract-keys.js";
import {
  FACT_ID,
  DOCUMENTATION_DISPOSITIONS,
  SOURCE_OBLIGATION_FAILURES,
  fail,
  kit,
  compareCodePoints,
} from "./validation-kernel.js";
import {
  validateAccounting,
  withRejectedObligationLimitations,
  assertFactInventoryLimitationCount,
  demotionEvidencePrefix,
  demotionSupersededObligationIds,
  projectRejectedObligationLimitations,
  technicalCorrectionAuthorityPaths,
  validateSourceChecks,
  boundedText,
  boundedDigest,
} from "./ledger-codec.js";
import {
  assertCanonicalJsonByteBound,
  assertReviewScopeFitsProposalBound,
  byteBoundScope,
  canonicalJsonBytes,
  hostFilledCoverageBytes,
  ReviewScopeBoundError,
  type TechnicalCorrectionByteBoundScope,
} from "./judgment-byte-bounds.js";

export {
  assertCanonicalJsonByteBound,
  assertReviewScopeFitsProposalBound,
  byteBoundScope,
  canonicalJsonBytes,
  hostFilledCoverageBytes,
  ReviewScopeBoundError,
};
export type { TechnicalCorrectionByteBoundScope } from "./judgment-byte-bounds.js";

export function bindTechnicalCorrectionResponse(
  value: unknown,
  ledger: SourceObligationLedgerV1,
  validateVerification: (value: unknown) => VerificationResult,
): TechnicalCorrectionResponseV1 & { evidence: TechnicalCorrectionEvidenceV1 } {
  const root = correctionEnvelope(value, TECHNICAL_CORRECTION_ENVELOPE_KEYS);
  const candidateVerificationResult = technicalCorrectionBoundary(
    "invalid-review",
    () => validateVerification(root.verificationResult),
    "$.verificationResult",
  );
  const obligationAccounting = technicalCorrectionBoundary("invalid-accounting", () =>
    validateAccounting(root.obligationAccounting, ledger, candidateVerificationResult),
  );
  const verificationResult = projectRejectedObligationLimitations(
    candidateVerificationResult,
    obligationAccounting,
  );
  const evidenceContent = {
    kind: TECHNICAL_CORRECTION_EVIDENCE_KIND,
    schemaVersion: 1 as const,
    sourceObligationLedgerSha256: ledger.digest,
    verificationResultSha256: canonicalDigest(verificationResult),
    obligationAccounting,
  };
  return {
    verificationResult,
    obligationAccounting,
    evidence: Object.freeze({ ...evidenceContent, digest: canonicalDigest(evidenceContent) }),
  };
}

export async function bindTechnicalCorrectionResponseV2(
  value: unknown,
  ledger: SourceObligationLedgerV2,
  authority: OriginalSourceAuthorityAdmission,
  runId: string,
  validateVerification: (value: unknown) => VerificationResult,
): Promise<TechnicalCorrectionResponseV1 & { evidence: TechnicalCorrectionEvidenceV2 }> {
  const root = correctionEnvelope(value, TECHNICAL_CORRECTION_ENVELOPE_KEYS);
  const candidateVerificationResult = technicalCorrectionBoundary(
    "invalid-review",
    () => validateVerification(root.verificationResult),
    "$.verificationResult",
  );
  const obligationAccounting = technicalCorrectionBoundary("invalid-accounting", () =>
    validateAccounting(root.obligationAccounting, ledger, candidateVerificationResult, undefined),
  );
  const verificationResult = projectRejectedObligationLimitations(
    candidateVerificationResult,
    obligationAccounting,
  );
  const paths = technicalCorrectionAuthorityPaths(verificationResult, obligationAccounting);
  const admitted = await admitOriginalSourceAuthorityChecks(authority, {
    runId,
    descriptor: ledger.identity.originalSourceAuthority,
    paths,
  }).catch((error: unknown) => rejectTechnicalCorrectionFailure(error, "source-authority"));
  const evidenceContent = {
    kind: TECHNICAL_CORRECTION_EVIDENCE_KIND,
    schemaVersion: 2 as const,
    sourceObligationLedgerSha256: ledger.digest,
    verificationResultSha256: canonicalDigest(verificationResult),
    obligationAccounting,
    originalSourceAuthoritySha256: admitted.originalSourceAuthoritySha256,
    sourceChecks: admitted.sourceChecks,
  };
  return {
    verificationResult,
    obligationAccounting,
    evidence: Object.freeze({ ...evidenceContent, digest: canonicalDigest(evidenceContent) }),
  };
}

export async function bindTechnicalCorrectionResponseV3(
  value: unknown,
  ledger: SourceObligationLedgerV2,
  authority: OriginalSourceAuthorityAdmission,
  runId: string,
  targetPaths: readonly string[],
  lineCounts?: readonly AdmittedSourceLineCountV1[],
  coveragePolicy: JudgmentCoveragePolicy = REFUSING_JUDGMENT_COVERAGE_POLICY,
): Promise<TechnicalCorrectionResponseV3> {
  const proposal = hostFillTechnicalCorrectionProposalFromJudgmentV3(
    value,
    ledger,
    targetPaths,
    lineCounts,
    coveragePolicy,
  );
  return finishTechnicalCorrectionV3(
    proposal,
    ledger,
    authority,
    runId,
    targetPaths,
    byteBoundScope(ledger, targetPaths, judgmentOrigin(value, ledger, coveragePolicy), {
      hostFillsCoverage: coveragePolicy.degradeCoverage,
    }),
  );
}

/**
 * Admit a proposal the host already built. Model JSON uses
 * {@link bindTechnicalCorrectionResponseV3}, which requires obligation judgments
 * and does not treat a sealed envelope as authority.
 */
export async function bindHostOwnedTechnicalCorrectionProposalV3(
  value: unknown,
  ledger: SourceObligationLedgerV2,
  authority: OriginalSourceAuthorityAdmission,
  runId: string,
  targetPaths: readonly string[],
): Promise<TechnicalCorrectionResponseV3> {
  const proposal = validateTechnicalCorrectionProposalV3(value, ledger, targetPaths);
  return finishTechnicalCorrectionV3(
    proposal,
    ledger,
    authority,
    runId,
    targetPaths,
    byteBoundScope(ledger, targetPaths, "host"),
  );
}

export async function finishTechnicalCorrectionV3(
  proposal: TechnicalCorrectionProposalV3,
  ledger: SourceObligationLedgerV2,
  authority: OriginalSourceAuthorityAdmission,
  runId: string,
  targetPaths: readonly string[],
  scope: TechnicalCorrectionByteBoundScope,
): Promise<TechnicalCorrectionResponseV3> {
  const verificationResult = deriveTechnicalCorrectionVerificationResultV3(
    proposal,
    ledger,
    targetPaths,
    scope,
  );
  const paths = technicalCorrectionAuthorityPaths(
    verificationResult,
    proposal.obligationAccounting,
  );
  const admitted = await admitOriginalSourceAuthorityChecks(authority, {
    runId,
    descriptor: ledger.identity.originalSourceAuthority,
    paths,
  }).catch((error: unknown) => rejectTechnicalCorrectionFailure(error, "source-authority"));
  const evidenceContent = {
    kind: TECHNICAL_CORRECTION_EVIDENCE_KIND,
    schemaVersion: 3 as const,
    sourceObligationLedgerSha256: ledger.digest,
    verificationResultSha256: canonicalDigest(verificationResult),
    proposal,
    proposalSha256: canonicalDigest(proposal),
    originalSourceAuthoritySha256: admitted.originalSourceAuthoritySha256,
    sourceChecks: admitted.sourceChecks,
  };
  const evidence = Object.freeze({
    ...evidenceContent,
    digest: canonicalDigest(evidenceContent),
  });
  assertCanonicalJsonByteBound(evidence, "evidence", scope);
  return { proposal, verificationResult, evidence };
}

export function decodeTechnicalCorrectionResponse(
  response: string,
  ledger: SourceObligationLedgerV1,
  validateVerification: (value: unknown) => VerificationResult,
): TechnicalCorrectionResponseV1 & { evidence: TechnicalCorrectionEvidenceV1 } {
  const parsed = parseTechnicalResponse(response, "correction");
  return technicalCorrectionBoundary("invalid-shape", () =>
    bindTechnicalCorrectionResponse(parsed, ledger, validateVerification),
  );
}

export async function decodeTechnicalCorrectionResponseV2(
  response: string,
  ledger: SourceObligationLedgerV2,
  authority: OriginalSourceAuthorityAdmission,
  runId: string,
  validateVerification: (value: unknown) => VerificationResult,
): Promise<TechnicalCorrectionResponseV1 & { evidence: TechnicalCorrectionEvidenceV2 }> {
  const parsed = parseTechnicalResponse(response, "correction");
  try {
    return await bindTechnicalCorrectionResponseV2(
      parsed,
      ledger,
      authority,
      runId,
      validateVerification,
    );
  } catch (error) {
    return rejectTechnicalCorrectionFailure(error, "invalid-shape");
  }
}

export async function decodeTechnicalCorrectionResponseV3(
  response: string,
  ledger: SourceObligationLedgerV2,
  authority: OriginalSourceAuthorityAdmission,
  runId: string,
  targetPaths: readonly string[],
  lineCounts?: readonly AdmittedSourceLineCountV1[],
  coveragePolicy: JudgmentCoveragePolicy = REFUSING_JUDGMENT_COVERAGE_POLICY,
): Promise<TechnicalCorrectionResponseV3> {
  const parsed = parseTechnicalResponse(response, "correction");
  try {
    return await bindTechnicalCorrectionResponseV3(
      parsed,
      ledger,
      authority,
      runId,
      targetPaths,
      lineCounts,
      coveragePolicy,
    );
  } catch (error) {
    return rejectTechnicalCorrectionFailure(error, "invalid-shape");
  }
}

/** Admit a fixed candidate only through the existing final technical call. */
export async function decodeTechnicalCorrectionResponseV4(
  response: string,
  ledger: SourceObligationLedgerV2,
  authority: OriginalSourceAuthorityAdmission,
  runId: string,
  targetPaths: readonly string[],
  candidates: ProvisionalRichCandidateEvidenceV1,
  lineCounts?: readonly AdmittedSourceLineCountV1[],
  coveragePolicy: JudgmentCoveragePolicy = REFUSING_JUDGMENT_COVERAGE_POLICY,
): Promise<TechnicalCorrectionResponseV4> {
  const parsed = parseTechnicalResponse(response, "correction");
  try {
    const root = correctionEnvelope(parsed, [
      "kind",
      "schemaVersion",
      "verdict",
      "coverage",
      "issueJudgments",
      "obligationJudgments",
      "richAssessments",
    ]);
    if (root.kind !== TECHNICAL_RICH_JUDGMENT_KIND || root.schemaVersion !== 1)
      return rejectTechnicalCorrection("invalid-shape");
    if (
      candidates.sourceObligationLedgerSha256 !== ledger.digest ||
      candidates.scopeSha256 !== ledger.identity.scopeSha256 ||
      candidates.repositoryRevision !== ledger.identity.repositoryRevision
    )
      return rejectTechnicalCorrection("invalid-shape");
    const judgment = {
      verdict: root.verdict,
      coverage: root.coverage,
      issueJudgments: root.issueJudgments,
      obligationJudgments: root.obligationJudgments,
    };
    const ordinary = await bindTechnicalCorrectionResponseV3(
      judgment,
      ledger,
      authority,
      runId,
      targetPaths,
      lineCounts,
      coveragePolicy,
    );
    const richIssues = normalizeTechnicalRichIssues(
      root.richAssessments,
      candidates,
      ledger,
      ordinary.proposal,
    );
    const {
      digest: _ordinaryDigest,
      schemaVersion: _ordinaryVersion,
      ...ordinaryContent
    } = ordinary.evidence;
    const content = {
      ...ordinaryContent,
      schemaVersion: 4 as const,
      provisionalRichCandidateSha256: candidates.digest,
      richAssessments: root.richAssessments as TechnicalRichAssessmentV1[],
      richIssues,
    };
    const evidence = Object.freeze({ ...content, digest: canonicalDigest(content) });
    assertCanonicalJsonByteBound(
      evidence,
      "evidence",
      byteBoundScope(ledger, targetPaths, judgmentOrigin(judgment, ledger, coveragePolicy), {
        hostFillsCoverage: coveragePolicy.degradeCoverage,
      }),
    );
    validateTechnicalRichCandidateBinding(evidence, candidates, ledger);
    return {
      proposal: ordinary.proposal,
      verificationResult: ordinary.verificationResult,
      evidence,
    };
  } catch (error) {
    return rejectTechnicalCorrectionFailure(error, "invalid-shape");
  }
}

/** Recompute normalized fact grounding from the sealed proposal and fixed candidates. */
function normalizeTechnicalRichIssues(
  value: unknown,
  candidates: ProvisionalRichCandidateEvidenceV1,
  ledger: SourceObligationLedgerV2,
  proposal: TechnicalCorrectionProposalV3,
): TechnicalCorrectionRichIssueV4[] {
  const rows = kit.array(value);
  if (rows.length !== candidates.candidates.length)
    return rejectTechnicalCorrection("invalid-shape");
  const byCandidate = new Map(
    candidates.candidates.map((candidate) => [candidate.issueId, candidate]),
  );
  const obligations = new Map(
    ledger.dimensions.flatMap((dimension) =>
      dimension.obligations.map((obligation) => [obligation.id, obligation] as const),
    ),
  );
  const facts = new Map(
    proposal.factInventory.dimensions.flatMap((dimension) =>
      dimension.facts.map((fact) => [fact.id, fact] as const),
    ),
  );
  const accounting = new Map(proposal.obligationAccounting.map((row) => [row.obligationId, row]));
  const assessments = new Map<
    string,
    {
      candidateSha256: string;
      grounds: Map<
        string,
        {
          status: "supported" | "contradicted" | "unresolved";
          rationale: string;
          sourceLocators: string[];
          uncertainty: string;
        }
      >;
    }
  >();
  for (const raw of rows) {
    const row = kit.object(raw);
    kit.exact(row, ["issueId", "candidateSha256", "grounds"]);
    const issueId = boundedJudgmentText(row.issueId, "technicalCorrection.identifierMaxChars");
    const candidate = byCandidate.get(issueId);
    if (!candidate || assessments.has(issueId) || row.candidateSha256 !== candidate.candidateSha256)
      return rejectTechnicalCorrection("invalid-shape");
    const groundRows = kit.array(row.grounds);
    if (groundRows.length !== candidate.obligationIds.length)
      return rejectTechnicalCorrection("invalid-shape");
    const grounds = new Map<
      string,
      {
        status: "supported" | "contradicted" | "unresolved";
        rationale: string;
        sourceLocators: string[];
        uncertainty: string;
      }
    >();
    for (const rawGround of groundRows) {
      const ground = kit.object(rawGround);
      kit.exact(ground, ["obligationId", "status", "rationale", "sourceLocators", "uncertainty"]);
      const obligationId = boundedJudgmentText(
        ground.obligationId,
        "technicalCorrection.identifierMaxChars",
      );
      const obligation = obligations.get(obligationId);
      if (
        !candidate.obligationIds.includes(obligationId) ||
        !obligation ||
        grounds.has(obligationId)
      )
        return rejectTechnicalCorrection("invalid-shape");
      const status = ground.status;
      if (status !== "supported" && status !== "contradicted" && status !== "unresolved")
        return rejectTechnicalCorrection("invalid-shape");
      const sourceLocators = kit
        .array(ground.sourceLocators)
        .map((entry) => boundedJudgmentText(entry, "technicalCorrection.fieldMaxChars"));
      if (
        sourceLocators.length === 0 ||
        new Set(sourceLocators).size !== sourceLocators.length ||
        sourceLocators.length !== obligation.sourceLocators.length ||
        sourceLocators.some((locator, index) => locator !== obligation.sourceLocators[index])
      )
        return rejectTechnicalCorrection("source-authority");
      grounds.set(obligationId, {
        status,
        rationale: boundedJudgmentText(ground.rationale, "technicalCorrection.proseMaxChars"),
        sourceLocators,
        uncertainty: boundedJudgmentText(ground.uncertainty, "technicalCorrection.proseMaxChars"),
      });
    }
    assessments.set(issueId, { candidateSha256: candidate.candidateSha256, grounds });
  }
  if (assessments.size !== candidates.candidates.length)
    return rejectTechnicalCorrection("invalid-shape");
  return proposal.issueJudgments.map((issue): TechnicalCorrectionRichIssueV4 => {
    const candidate = byCandidate.get(issue.id);
    if (!candidate) return { issueId: issue.id, status: "unavailable", reason: "candidate-absent" };
    const assessment = assessments.get(issue.id)!;
    const linked = candidate.obligationIds.flatMap((id) => accounting.get(id)?.factIds ?? []);
    if (
      linked.length !== issue.factIds.length ||
      [...linked]
        .sort(compareCodePoints)
        .some((id, index) => id !== [...issue.factIds].sort(compareCodePoints)[index])
    )
      return { issueId: issue.id, status: "unavailable", reason: "link-changed" };
    let unavailable: "contradicted" | "unresolved" | "qualification-unproven" | null = null;
    const grounding = candidate.obligationIds.flatMap((id) => {
      const ground = assessment.grounds.get(id)!;
      const obligation = obligations.get(id)!;
      if (ground.status === "contradicted") unavailable = "contradicted";
      else if (ground.status === "unresolved" && unavailable !== "contradicted")
        unavailable = "unresolved";
      if (ground.uncertainty !== obligation.uncertainty && unavailable === null)
        unavailable = "qualification-unproven";
      return (accounting.get(id)?.factIds ?? []).map((factId) => {
        const fact = facts.get(factId);
        if (!fact) return rejectTechnicalCorrection("invalid-fact-link");
        if (fact.uncertainty !== ground.uncertainty && unavailable === null)
          unavailable = "qualification-unproven";
        return {
          factId,
          qualification: fact.uncertainty,
          status: "supported" as const,
          rationale: ground.rationale,
          sourceLocators: ground.sourceLocators,
        };
      });
    });
    if (unavailable !== null)
      return { issueId: issue.id, status: "unavailable", reason: unavailable };
    return {
      issueId: issue.id,
      status: "admitted",
      candidateSha256: candidate.candidateSha256,
      title: candidate.title,
      readerConsequence: candidate.readerConsequence,
      proposedEdit: candidate.proposedEdit,
      grounding,
    };
  });
}

/** The live runner and cold reader both compare V4 rows to the same provisional bytes. */
export function validateTechnicalRichCandidateBinding(
  evidence: TechnicalCorrectionEvidenceV4,
  candidates: ProvisionalRichCandidateEvidenceV1,
  ledger: SourceObligationLedgerV2,
): void {
  const { digest: _digest, ...candidateContent } = candidates;
  if (
    candidates.kind !== PROVISIONAL_RICH_CANDIDATE_EVIDENCE_KIND ||
    candidates.schemaVersion !== 1 ||
    candidates.digest !== canonicalDigest(candidateContent) ||
    candidates.candidates.some(
      ({ candidateSha256, ...candidate }) =>
        candidateSha256 !==
        canonicalDigest({
          candidate,
          sourceObligationLedgerSha256: ledger.digest,
          scopeSha256: ledger.identity.scopeSha256,
          repositoryRevision: ledger.identity.repositoryRevision,
          verificationResultSha256: candidates.verificationResultSha256,
        }),
    )
  )
    return rejectTechnicalCorrection("invalid-shape");
  if (
    evidence.provisionalRichCandidateSha256 !== candidates.digest ||
    candidates.sourceObligationLedgerSha256 !== ledger.digest ||
    candidates.scopeSha256 !== ledger.identity.scopeSha256 ||
    candidates.repositoryRevision !== ledger.identity.repositoryRevision ||
    canonicalDigest(
      normalizeTechnicalRichIssues(evidence.richAssessments, candidates, ledger, evidence.proposal),
    ) !== canonicalDigest(evidence.richIssues)
  ) {
    return rejectTechnicalCorrection("invalid-shape");
  }
}

/**
 * Provisional verify uses the same judgment schema and fill as canonical V3.
 * It does not admit a sealed review envelope and it does not open a source-authority
 * correction record. The host derives review, coverage, and factInventory.
 */
export function decodeProvisionalVerificationJudgment(
  response: string,
  ledger: SourceObligationLedgerV2,
  targetPaths: readonly string[],
  lineCounts?: readonly AdmittedSourceLineCountV1[],
  coveragePolicy: JudgmentCoveragePolicy = REFUSING_JUDGMENT_COVERAGE_POLICY,
): VerificationResult {
  const parsed = parseTechnicalResponse(response, "review");
  try {
    const proposal = hostFillTechnicalCorrectionProposalFromJudgmentV3(
      parsed,
      ledger,
      targetPaths,
      lineCounts,
      coveragePolicy,
    );
    return deriveTechnicalCorrectionVerificationResultV3(
      proposal,
      ledger,
      targetPaths,
      byteBoundScope(ledger, targetPaths, judgmentOrigin(parsed, ledger, coveragePolicy), {
        hostFillsCoverage: coveragePolicy.degradeCoverage,
      }),
    );
  } catch (error) {
    return rejectTechnicalCorrectionFailure(error, "invalid-shape");
  }
}

/** Admit the optional rich envelope without changing the ordinary V3 reply path. */
export function decodeProvisionalRichJudgment(
  response: string,
  ledger: SourceObligationLedgerV2,
  targetPaths: readonly string[],
  lineCounts?: readonly AdmittedSourceLineCountV1[],
  coveragePolicy: JudgmentCoveragePolicy = REFUSING_JUDGMENT_COVERAGE_POLICY,
): {
  verificationResult: VerificationResult;
  evidence: ProvisionalRichCandidateEvidenceV1;
} {
  const parsed = parseTechnicalResponse(response, "review");
  try {
    const root = correctionEnvelope(parsed, PROVISIONAL_RICH_JUDGMENT_ENVELOPE_KEYS);
    if (root.kind !== PROVISIONAL_RICH_JUDGMENT_KIND || root.schemaVersion !== 1) {
      return rejectTechnicalCorrection("invalid-shape");
    }
    const judgment = correctionEnvelope(root.judgment, TECHNICAL_CORRECTION_JUDGMENT_KEYS);
    const proposal = hostFillTechnicalCorrectionProposalFromJudgmentV3(
      judgment,
      ledger,
      targetPaths,
      lineCounts,
      coveragePolicy,
    );
    const verificationResult = deriveTechnicalCorrectionVerificationResultV3(
      proposal,
      ledger,
      targetPaths,
      byteBoundScope(ledger, targetPaths, judgmentOrigin(judgment, ledger, coveragePolicy), {
        hostFillsCoverage: coveragePolicy.degradeCoverage,
      }),
    );
    const links = new Map(
      kit.array(judgment.issueJudgments).map((raw) => {
        const row = kit.object(raw);
        return [row.id, row.obligationIds] as const;
      }),
    );
    const candidateRows = kit.array(root.richCandidates);
    assertTechnicalCorrectionLimit("technicalCorrection.maxIssueJudgments", candidateRows.length);
    const candidates = candidateRows.map((raw) => {
      const candidate = decodeProvisionalRichCandidate(raw);
      const linked = links.get(candidate.issueId);
      if (
        !Array.isArray(linked) ||
        canonicalDigest([...linked].sort()) !== canonicalDigest([...candidate.obligationIds].sort())
      ) {
        return rejectTechnicalCorrection("invalid-shape");
      }
      return {
        ...candidate,
        candidateSha256: canonicalDigest({
          candidate,
          sourceObligationLedgerSha256: ledger.digest,
          scopeSha256: ledger.identity.scopeSha256,
          repositoryRevision: ledger.identity.repositoryRevision,
          verificationResultSha256: canonicalDigest(verificationResult),
        }),
      };
    });
    if (new Set(candidates.map(({ issueId }) => issueId)).size !== candidates.length) {
      return rejectTechnicalCorrection("invalid-shape");
    }
    const content = {
      kind: PROVISIONAL_RICH_CANDIDATE_EVIDENCE_KIND,
      schemaVersion: 1 as const,
      sourceObligationLedgerSha256: ledger.digest,
      scopeSha256: ledger.identity.scopeSha256,
      repositoryRevision: ledger.identity.repositoryRevision,
      verificationResultSha256: canonicalDigest(verificationResult),
      candidates,
    };
    assertCanonicalJsonByteBound(content, "proposal", byteBoundScope(ledger, targetPaths, "reply"));
    const evidence = { ...content, digest: canonicalDigest(content) };
    assertCanonicalJsonByteBound(
      evidence,
      "evidence",
      byteBoundScope(ledger, targetPaths, "reply"),
    );
    return { verificationResult, evidence };
  } catch (error) {
    return rejectTechnicalCorrectionFailure(error, "invalid-shape");
  }
}

function exactUtf8(value: unknown, maxName: string, allowEmpty = false): string {
  if (typeof value !== "string") return rejectTechnicalCorrection("invalid-shape");
  const text = value;
  if (
    (!allowEmpty && text.length === 0) ||
    text.includes("\0") ||
    Buffer.from(text, "utf8").toString("utf8") !== text
  ) {
    return rejectTechnicalCorrection("invalid-shape");
  }
  assertTechnicalCorrectionLimit(maxName, text.length);
  return text;
}

function decodeProvisionalRichCandidate(value: unknown): ProvisionalRichCandidateV1 {
  const row = kit.object(value);
  kit.exact(row, PROVISIONAL_RICH_CANDIDATE_KEYS);
  const issueId = boundedJudgmentText(row.issueId, "technicalCorrection.identifierMaxChars");
  const obligationIds = boundedJudgmentIdList(
    row.obligationIds,
    "technicalCorrection.maxJudgmentFactIds",
  );
  if (obligationIds.length === 0) return rejectTechnicalCorrection("invalid-shape");
  const proposed = kit.object(row.proposedEdit);
  const kind = proposed.kind;
  if (kind !== "advice" && kind !== "replacement")
    return rejectTechnicalCorrection("invalid-shape");
  kit.exact(
    proposed,
    kind === "advice"
      ? PROVISIONAL_RICH_PROPOSED_EDIT_KEYS
      : PROVISIONAL_RICH_REPLACEMENT_EDIT_KEYS,
  );
  const text = exactUtf8(proposed.text, "runtime.contract.maxStringChars");
  const proposedEdit =
    kind === "advice"
      ? ({ kind, text } as const)
      : ({
          kind,
          text,
          path: boundedJudgmentText(proposed.path, "technicalCorrection.fieldMaxChars"),
          originalText: exactUtf8(proposed.originalText, "runtime.contract.maxStringChars"),
          replacementText: exactUtf8(
            proposed.replacementText,
            "runtime.contract.maxStringChars",
            true,
          ),
        } as const);
  return {
    issueId,
    obligationIds,
    title: boundedJudgmentText(row.title, "technicalCorrection.fieldMaxChars"),
    readerConsequence: boundedJudgmentText(
      row.readerConsequence,
      "technicalCorrection.proseMaxChars",
    ),
    proposedEdit,
  };
}

/** Revalidate a saved candidate set against its ledger and exact provisional result. */
export function validateProvisionalRichCandidateEvidence(
  value: unknown,
  ledger: SourceObligationLedgerV2,
  verificationResult: VerificationResult,
  targetPaths: readonly string[],
): ProvisionalRichCandidateEvidenceV1 {
  return technicalCorrectionBoundary("invalid-shape", () => {
    kit.assertInert(value);
    kit.rejectCredentials(value);
    const root = kit.object(value);
    kit.exact(root, PROVISIONAL_RICH_CANDIDATE_EVIDENCE_KEYS);
    if (root.kind !== PROVISIONAL_RICH_CANDIDATE_EVIDENCE_KIND || root.schemaVersion !== 1) {
      return rejectTechnicalCorrection("invalid-shape");
    }
    const ledgerObligationIds = new Set(
      ledger.dimensions.flatMap((dimension) =>
        dimension.obligations.map((obligation) => obligation.id),
      ),
    );
    const candidates = kit.array(root.candidates).map((raw) => {
      const row = kit.object(raw);
      kit.exact(row, PROVISIONAL_RICH_EVIDENCE_CANDIDATE_KEYS);
      const candidate = decodeProvisionalRichCandidate({
        issueId: row.issueId,
        obligationIds: row.obligationIds,
        title: row.title,
        readerConsequence: row.readerConsequence,
        proposedEdit: row.proposedEdit,
      });
      const candidateSha256 = boundedDigest(row.candidateSha256);
      if (
        candidateSha256 !==
          canonicalDigest({
            candidate,
            sourceObligationLedgerSha256: ledger.digest,
            scopeSha256: ledger.identity.scopeSha256,
            repositoryRevision: ledger.identity.repositoryRevision,
            verificationResultSha256: canonicalDigest(verificationResult),
          }) ||
        candidate.obligationIds.some((obligationId) => !ledgerObligationIds.has(obligationId)) ||
        !verificationResult.review.issues.some((issue) => issue.id === candidate.issueId)
      ) {
        return rejectTechnicalCorrection("invalid-shape");
      }
      return { ...candidate, candidateSha256 };
    });
    assertTechnicalCorrectionLimit("technicalCorrection.maxIssueJudgments", candidates.length);
    if (new Set(candidates.map(({ issueId }) => issueId)).size !== candidates.length) {
      return rejectTechnicalCorrection("invalid-shape");
    }
    const content = {
      kind: PROVISIONAL_RICH_CANDIDATE_EVIDENCE_KIND,
      schemaVersion: 1 as const,
      sourceObligationLedgerSha256: boundedDigest(root.sourceObligationLedgerSha256),
      scopeSha256: boundedDigest(root.scopeSha256),
      repositoryRevision: kit.string(root.repositoryRevision),
      verificationResultSha256: boundedDigest(root.verificationResultSha256),
      candidates,
    };
    const digest = boundedDigest(root.digest);
    if (
      content.sourceObligationLedgerSha256 !== ledger.digest ||
      content.scopeSha256 !== ledger.identity.scopeSha256 ||
      content.repositoryRevision !== ledger.identity.repositoryRevision ||
      content.verificationResultSha256 !== canonicalDigest(verificationResult) ||
      digest !== canonicalDigest(content)
    ) {
      return rejectTechnicalCorrection("invalid-shape");
    }
    assertCanonicalJsonByteBound(content, "proposal", byteBoundScope(ledger, targetPaths, "host"));
    const evidence = { ...content, digest };
    assertCanonicalJsonByteBound(evidence, "evidence", byteBoundScope(ledger, targetPaths, "host"));
    return evidence;
  });
}

/** The technical correction's closed envelope. */
export function correctionEnvelope(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  return technicalCorrectionBoundary("invalid-shape", () => {
    kit.assertInert(value);
    technicalCorrectionBoundary("unsafe-disclosure", () => kit.rejectCredentials(value));
    const root = kit.object(value);
    kit.exact(root, keys, optional);
    return root;
  });
}

/**
 * The characters one whole judgment answer may carry, as stated to the model:
 * the bound composition's effective per-turn output limit (not the registry
 * ceiling), times the first turn plus every length-stop continuation, times
 * the compact-JSON characters counted per output token. Both factors are
 * catalog entries, so the stated budget follows any override.
 */
export function judgmentAnswerCharBudget(outputTokens: number): number {
  const continuations = limit("inference.maxLengthStopContinuations").value;
  const charsPerToken = limit("technicalCorrection.answerCharsPerOutputToken").value;
  return outputTokens * (1 + continuations) * charsPerToken;
}

/**
 * The per-field ceilings the judgment decoders enforce, stated in the contract
 * the model reads so it can budget in advance. Rendered per call from the same
 * catalog entries the decoder resolves, so the stated numbers cannot drift.
 */
export function judgmentAnswerBudgetContract(outputTokens?: number): string {
  const fieldMaxChars = limit("technicalCorrection.fieldMaxChars").value;
  const proseMaxChars = limit("technicalCorrection.proseMaxChars").value;
  const maxJudgmentFactIds = limit("technicalCorrection.maxJudgmentFactIds").value;
  const maxIssueJudgments = limit("technicalCorrection.maxIssueJudgments").value;
  const coverageReasonMaxChars = limit("technicalCorrection.coverageReasonMaxChars").value;
  const coverageEvidenceMaxEntries = limit("technicalCorrection.coverageEvidenceMaxEntries").value;
  const coverageEvidenceEntryMaxChars = limit(
    "technicalCorrection.coverageEvidenceEntryMaxChars",
  ).value;
  return [
    "Answer budget (host-enforced ceilings, not targets):",
    `a statement or location is at most ${fieldMaxChars} characters;`,
    `an uncertainty or a rejection reason is at most ${proseMaxChars} characters;`,
    `one judgment names at most ${maxJudgmentFactIds} obligation IDs;`,
    `the answer carries at most ${maxIssueJudgments} issue judgments;`,
    `one coverage entry's reason is at most ${coverageReasonMaxChars} characters;`,
    `one coverage entry names at most ${coverageEvidenceMaxEntries} evidence locators, each at most ${coverageEvidenceEntryMaxChars} characters;`,
    // With no bound limit the sentence is omitted rather than overstated with
    // the registry ceiling.
    ...(outputTokens === undefined
      ? []
      : [`the whole answer is at most ${judgmentAnswerCharBudget(outputTokens)} characters.`]),
    "Serialize compact JSON without indentation. Keep every reason and uncertainty to the shortest sentence that names the establishing source locator and the reason it establishes or fails to establish the obligation; do not restate the ledger, the sources, or the documentation back to the host.",
    "Finish the whole object. An answer cut at the output limit is not accepted as complete.",
  ].join(" ");
}

/**
 * The exact obligation IDs the judgment decoder admits, rendered from the same
 * sealed ledger, stated once in the host contract rather than left to untrusted
 * earlier step results.
 */
export function sealedObligationIdContract(
  input: Pick<HarnessStepInput, "sourceObligationLedger">,
): string | undefined {
  const ledger = input.sourceObligationLedger;
  if (ledger?.schemaVersion !== 2) return undefined;
  const obligationIds = ledger.dimensions.flatMap((dimension) =>
    dimension.obligations.map(({ id }) => id),
  );
  return `Host-issued obligation IDs in the sealed ledger: ${JSON.stringify(obligationIds)}. These are the only valid obligationJudgments[].obligationId and issueJudgments[].obligationIds values. Fact IDs and issue IDs in earlier results are not obligation IDs.`;
}

/**
 * The obligation IDs of each applicable dimension in the sealed ledger, as a
 * JSON object in ledger order. `only` limits it to the named
 * dimensions. `undefined` without a version 2 ledger or a matching dimension.
 */
export function applicableDimensionObligationIds(
  input: Pick<HarnessStepInput, "sourceObligationLedger">,
  only?: readonly string[],
): string | undefined {
  const ledger = input.sourceObligationLedger;
  if (ledger?.schemaVersion !== 2) return undefined;
  const entries = ledger.dimensions
    .filter(
      ({ dimension, status }) =>
        status === "applicable" && (only === undefined || only.includes(dimension)),
    )
    .map(({ dimension, obligations }) => [dimension, obligations.map(({ id }) => id)] as const);
  return entries.length > 0 ? JSON.stringify(Object.fromEntries(entries)) : undefined;
}

/**
 * The accounting rule's applicable dimensions, rendered from the same sealed
 * ledger the judgment fill derives the fact inventory from.
 */
export function applicableDimensionContract(
  input: Pick<HarnessStepInput, "sourceObligationLedger" | "admittedSourceLineCounts">,
): string | undefined {
  const byDimension = applicableDimensionObligationIds(input);
  const admittedPaths = admittedEvidencePathContract(input);
  if (!byDimension || !admittedPaths) return undefined;
  return `Applicable dimensions in the sealed ledger, each with its host-issued obligation IDs: ${byDimension}. Keep at least one obligation of every listed dimension retained or refined, unless every rejection of that dimension is substantive as the accounting rule states. ${admittedPaths}`;
}

/**
 * The admitted source paths a substantive rejection's evidenceLocators must
 * point into, from the sealed ledger's host-observed source identities.
 * `undefined` without a version 2 ledger.
 */
export function admittedEvidencePathContract(
  input: Pick<HarnessStepInput, "sourceObligationLedger" | "admittedSourceLineCounts">,
): string | undefined {
  const ledger = input.sourceObligationLedger;
  if (ledger?.schemaVersion !== 2) return undefined;
  const paths = `Admitted source paths for evidenceLocators: ${JSON.stringify(ledger.identity.sources.map(({ path }) => path))}.`;
  const counts = input.admittedSourceLineCounts;
  if (!counts || counts.length === 0) return paths;
  // The host-observed line counts bound every cited line.
  return `${paths} Their line counts: ${JSON.stringify(Object.fromEntries(counts.map(({ path, lineCount }) => [path, lineCount])))}.`;
}

export function technicalCorrectionLimit(name: string) {
  return limit(name);
}

export function refuseTechnicalCorrectionLimit(name: string, observed: number): never {
  const resolved = technicalCorrectionLimit(name);
  return rejectTechnicalCorrection(
    "bounds-exceeded",
    `${resolved.refusal}: ${observed} exceeds ${resolved.name} = ${resolved.value} ${resolved.unit}. ${resolved.remediation} Follow the named remediation.`,
  );
}

export function assertTechnicalCorrectionLimit(name: string, observed: number): void {
  if (observed > technicalCorrectionLimit(name).value) {
    refuseTechnicalCorrectionLimit(name, observed);
  }
}

export function boundedJudgmentText(value: unknown, maxName: string, floor?: number): string {
  const text = kit.string(value);
  if (text !== text.trim()) return fail(SOURCE_OBLIGATION_FAILURES.boundedText);
  assertTechnicalCorrectionLimit(maxName, text.length);
  if (text.length === 0 || (floor !== undefined && text.length < floor)) {
    return fail(SOURCE_OBLIGATION_FAILURES.boundedText);
  }
  return text;
}

export function boundedJudgmentIdList(value: unknown, maxName: string): string[] {
  const values = kit.array(value);
  assertTechnicalCorrectionLimit(maxName, values.length);
  const identifiers = values.map((item) =>
    boundedJudgmentText(item, "technicalCorrection.identifierMaxChars"),
  );
  if (new Set(identifiers).size !== identifiers.length) {
    return fail(SOURCE_OBLIGATION_FAILURES.duplicateText);
  }
  return identifiers;
}

/**
 * Whether this step's judgment coverage degrades or refuses. The host fill
 * cannot read the workflow, so the caller resolves the gate through
 * {@link judgmentCoveragePolicy} and hands it down; no decoder infers the
 * workflow from its input.
 */
export interface JudgmentCoveragePolicy {
  readonly degradeCoverage: boolean;
  /**
   * Host-authored limitations beyond the degradation's own notes, such as the
   * zero-source and cut-answer notes, where the host wrote some of the answer.
   */
  readonly hostLimitations?: readonly string[];
  /**
   * The sealed obligations whose judgment rows the host wrote (see
   * `hostFillReason`). Host data only: a model reply cannot name itself into
   * this set. An applicable dimension this leaves with no fact is demoted with
   * the host as the reason, without the substantive-rejection precondition.
   */
  readonly hostFilledObligationIds?: ReadonlySet<string>;
  /** Named in each host demotion it causes. Absent reads as `answer-cut-at-output-limit`. */
  readonly hostFillReason?: HostFillReason;
}

/** The default for every caller that has no workflow to gate on. */
export const REFUSING_JUDGMENT_COVERAGE_POLICY: JudgmentCoveragePolicy = Object.freeze({
  degradeCoverage: false,
});

export function judgmentCoveragePolicy(
  input: Pick<HarnessStepInput, "workflow">,
): JudgmentCoveragePolicy {
  return degradesJudgmentModelContent(input)
    ? { degradeCoverage: true }
    : REFUSING_JUDGMENT_COVERAGE_POLICY;
}

/**
 * Planner-style host-fill for canonical technical correction. Model JSON is
 * retain/refine/reject plus findings bound to host-issued IDs. A sealed
 * proposal without obligation judgments is not a second admission path.
 * Minted obligation IDs, accounting rows, and fact-inventory identity are not
 * authority. The same V3 proposal decoder runs after fill.
 */
export function hostFillTechnicalCorrectionProposalFromJudgmentV3(
  judgment: unknown,
  ledger: SourceObligationLedgerV2,
  targetPaths: readonly string[],
  lineCounts?: readonly AdmittedSourceLineCountV1[],
  coveragePolicy: JudgmentCoveragePolicy = REFUSING_JUDGMENT_COVERAGE_POLICY,
): TechnicalCorrectionProposalV3 {
  const filled = technicalCorrectionBoundary("invalid-shape", () =>
    fillTechnicalCorrectionProposalFromJudgmentV3(
      judgment,
      ledger,
      targetPaths,
      lineCounts,
      coveragePolicy,
    ),
  );
  return validateTechnicalCorrectionProposalV3(
    filled,
    ledger,
    targetPaths,
    byteBoundScope(ledger, targetPaths, judgmentOrigin(judgment, ledger, coveragePolicy), {
      hostFillsCoverage: coveragePolicy.degradeCoverage,
    }),
  );
}

/**
 * Canonical byte lengths of the unavoidable all-host fallback core after a
 * source ledger has been sealed. Each family uses the real host rejection rows,
 * coverage degradation, inventory construction, and proposal normalization.
 * Future cut/refusal event notes alone are absent. The smallest family is a
 * necessary lower bound, not an admission of a later fully annotated proposal.
 */
export function hostFilledJudgmentCoreBytes(
  ledger: SourceObligationLedgerV2,
  targetPaths: readonly string[],
): { readonly minimumBytes: number; readonly byReason: Readonly<Record<HostFillReason, number>> } {
  const obligationIds = ledger.dimensions.flatMap((dimension) =>
    dimension.obligations.map((obligation) => obligation.id),
  );
  const byReason = {} as Record<HostFillReason, number>;
  for (const reason of HOST_FILL_REASONS) {
    const judgment = {
      verdict: "human-review",
      coverage: [],
      issueJudgments: [],
      obligationJudgments: obligationIds.map((id) => hostRejectedObligationJudgment(id, reason)),
    };
    const policy: JudgmentCoveragePolicy = {
      degradeCoverage: true,
      hostFilledObligationIds: new Set(obligationIds),
      hostFillReason: reason,
    };
    const filled = technicalCorrectionBoundary("invalid-shape", () =>
      fillTechnicalCorrectionProposalFromJudgmentV3(
        judgment,
        ledger,
        targetPaths,
        undefined,
        policy,
      ),
    );
    byReason[reason] = canonicalJsonBytes(
      normalizeTechnicalCorrectionProposalV3(filled, ledger, targetPaths),
    );
  }
  return { minimumBytes: Math.min(...Object.values(byReason)), byReason };
}

/**
 * Refuse only when even the smallest real fallback family cannot fit. The
 * eventual proposal still passes its ordinary exact byte admission, including
 * cut/refusal event notes that cannot exist yet at this post-ledger point.
 */
export function assertReviewLedgerFitsProposalCore(
  ledger: SourceObligationLedgerV2,
  targetPaths: readonly string[],
): void {
  const resolved = limit(TECHNICAL_CORRECTION_BYTE_BOUNDS.proposal.limit);
  const { minimumBytes } = hostFilledJudgmentCoreBytes(ledger, targetPaths);
  if (minimumBytes <= resolved.value) return;
  const obligations = ledger.dimensions.reduce(
    (count, dimension) => count + dimension.obligations.length,
    0,
  );
  throw new ReviewScopeBoundError(
    resolved,
    minimumBytes,
    `Scope: ${new Set(targetPaths).size} target pages and ${obligations} source obligations. Observed is the unavoidable serialized all-host proposal core after the sealed ledger, before any later judgment; it excludes future event notes. Narrow the review scope or split the documentation work while retaining every source obligation and its evidence. A core that fits still needs exact admission of the later full proposal.`,
  );
}

/**
 * `host` when the judgment carries no model content: the host wrote every
 * obligation row (a host-data set no reply can name itself into), and the
 * judgment has no coverage entry and no issue judgment. That is the all-host
 * floor; anything else is the model's reply. Exported for its unit test.
 */
export function judgmentOrigin(
  judgment: unknown,
  ledger: SourceObligationLedgerV2,
  coveragePolicy: JudgmentCoveragePolicy,
): TechnicalCorrectionByteBoundScope["origin"] {
  const hostRows = coveragePolicy.hostFilledObligationIds;
  if (!hostRows || typeof judgment !== "object" || judgment === null) return "reply";
  const { coverage, issueJudgments } = judgment as Record<string, unknown>;
  const everyRowHostWritten = ledger.dimensions.every((dimension) =>
    dimension.obligations.every((obligation) => hostRows.has(obligation.id)),
  );
  return everyRowHostWritten &&
    Array.isArray(coverage) &&
    coverage.length === 0 &&
    Array.isArray(issueJudgments) &&
    issueJudgments.length === 0
    ? "host"
    : "reply";
}

export function fillTechnicalCorrectionProposalFromJudgmentV3(
  judgment: unknown,
  ledger: SourceObligationLedgerV2,
  targetPaths: readonly string[],
  lineCounts: readonly AdmittedSourceLineCountV1[] | undefined,
  coveragePolicy: JudgmentCoveragePolicy,
): Record<string, unknown> {
  const root = correctionEnvelope(
    judgment,
    [...TECHNICAL_CORRECTION_JUDGMENT_KEYS, ...TECHNICAL_CORRECTION_IGNORED_IDENTITY_KEYS],
    TECHNICAL_CORRECTION_IGNORED_IDENTITY_KEYS,
  );
  const obligations = ledger.dimensions.flatMap((dimension) => dimension.obligations);
  const obligationsById = new Map(obligations.map((item) => [item.id, item]));
  const rows = kit.array(root.obligationJudgments);
  if (rows.length !== obligations.length) {
    return rejectTechnicalCorrection("invalid-accounting");
  }
  const seen = new Set<string>();
  const factsByObligationId = new Map<string, TechnicalSourceFact[]>();
  const rejectedRows = new Map<string, Record<string, unknown>>();
  const accounting: ObligationAccountingRowV1[] = [];
  let factSerial = 0;
  const nextFactId = (): string => {
    factSerial += 1;
    return `FACT-${factSerial}`;
  };
  for (const raw of rows) {
    const row = kit.object(raw);
    const obligationId = boundedJudgmentText(
      row.obligationId,
      "technicalCorrection.identifierMaxChars",
    );
    const obligation = obligationsById.get(obligationId);
    if (!obligation || seen.has(obligationId)) {
      return rejectTechnicalCorrection("invalid-accounting");
    }
    seen.add(obligationId);
    if (Object.hasOwn(row, "statement") && row.statement !== obligation.statement) {
      return rejectTechnicalCorrection("invalid-accounting");
    }
    if (Object.hasOwn(row, "uncertainty") && row.uncertainty !== obligation.uncertainty) {
      return rejectTechnicalCorrection("invalid-accounting");
    }
    if (Object.hasOwn(row, "dimension") && row.dimension !== obligation.dimension) {
      return rejectTechnicalCorrection("invalid-accounting");
    }
    if (row.disposition === "retained") {
      const documentationDisposition = readDocumentationDisposition(
        row.documentationDisposition,
        "$.obligationJudgments[].documentationDisposition",
      );
      // Issue links are derived from issueJudgments below; a reply's issueIds
      // field here is ignored, never matched.
      const fact: TechnicalSourceFact = {
        id: nextFactId(),
        dimension: obligation.dimension,
        sourceLocators: [...obligation.sourceLocators],
        statement: obligation.statement,
        documentationDisposition,
        uncertainty: obligation.uncertainty,
        issueIds: [],
      };
      factsByObligationId.set(obligationId, [fact]);
      accounting.push({
        obligationId,
        disposition: "retained",
        factIds: [fact.id],
      });
      continue;
    }
    if (row.disposition === "refined") {
      const replacements = kit.array(row.replacements);
      const facts = replacements.map((replacementValue) => {
        const replacement = kit.object(replacementValue);
        return {
          id: nextFactId(),
          dimension: obligation.dimension,
          sourceLocators: [...obligation.sourceLocators],
          statement: boundedJudgmentText(
            replacement.statement,
            "technicalCorrection.fieldMaxChars",
            8,
          ),
          documentationDisposition: readDocumentationDisposition(
            replacement.documentationDisposition,
            "$.obligationJudgments[].replacements[].documentationDisposition",
          ),
          uncertainty: boundedJudgmentText(
            replacement.uncertainty,
            "technicalCorrection.proseMaxChars",
          ),
          // Derived from issueJudgments below, as for a retained fact.
          issueIds: [],
        } satisfies TechnicalSourceFact;
      });
      factsByObligationId.set(obligationId, facts);
      accounting.push({
        obligationId,
        disposition: "refined",
        factIds: facts.map((fact) => fact.id),
        reason: boundedJudgmentText(row.reason, "technicalCorrection.proseMaxChars", 12),
        sourceLocators: [...obligation.sourceLocators],
      });
      continue;
    }
    if (row.disposition !== "rejected") {
      return rejectTechnicalCorrection("invalid-accounting");
    }
    factsByObligationId.set(obligationId, []);
    rejectedRows.set(obligationId, row);
    accounting.push({
      obligationId,
      disposition: "rejected",
      factIds: [],
      reason: boundedJudgmentText(row.reason, "technicalCorrection.proseMaxChars", 12),
      sourceLocators: [...obligation.sourceLocators],
    });
  }
  const rawIssueJudgments = kit.array(root.issueJudgments);
  assertTechnicalCorrectionLimit("technicalCorrection.maxIssueJudgments", rawIssueJudgments.length);
  const seenIssueIds = new Set<string>();
  for (const value of rawIssueJudgments) {
    const issueId = boundedJudgmentText(
      kit.object(value).id,
      "technicalCorrection.identifierMaxChars",
    );
    if (seenIssueIds.has(issueId)) return rejectTechnicalCorrection("invalid-shape");
    seenIssueIds.add(issueId);
  }
  // An off-vocabulary severity or category is a correctable content rule named
  // at its member. The V3 proposal validator keeps its own check for host-built
  // proposals.
  const issueRows = rawIssueJudgments.map((value) => kit.object(value));
  if (issueRows.some(({ category }) => !isReviewCategory(category))) {
    rejectIssueJudgmentVocabulary("category");
  }
  if (issueRows.some(({ severity }) => !isReviewSeverity(severity))) {
    rejectIssueJudgmentVocabulary("severity");
  }
  const linkedObligationIds = rawIssueJudgments.map((value) =>
    boundedJudgmentIdList(
      kit.object(value).obligationIds,
      "technicalCorrection.maxJudgmentFactIds",
    ),
  );
  // Every unissued ID across every judgment is named at once, so one bounded
  // retry can repair them all.
  const unknownObligationIds = linkedObligationIds
    .flat()
    .filter((obligationId) => !factsByObligationId.has(obligationId));
  if (unknownObligationIds.length > 0) rejectUnknownObligationLinks(unknownObligationIds);
  const issueJudgments = rawIssueJudgments.map((value, index) => {
    const judgmentRow = kit.object(value);
    const factIds: string[] = [];
    for (const obligationId of linkedObligationIds[index]!) {
      const facts = factsByObligationId.get(obligationId)!;
      for (const fact of facts) {
        if (fact.documentationDisposition === "documented") continue;
        if (!factIds.includes(fact.id)) factIds.push(fact.id);
      }
    }
    return {
      id: boundedJudgmentText(judgmentRow.id, "technicalCorrection.identifierMaxChars"),
      severity: judgmentRow.severity,
      category: judgmentRow.category,
      location: boundedJudgmentText(judgmentRow.location, "technicalCorrection.fieldMaxChars"),
      factIds,
    };
  });
  // A terminal authority refusal wins over the correctable link rule below.
  // The proposal validator repeats this check for host-built proposals.
  const targetPathSet = new Set(targetPaths);
  for (const { location } of issueJudgments) {
    assertJudgmentTargetAuthority(location, targetPathSet);
  }
  assertEveryJudgmentLinksAnOpenFact(issueJudgments);
  deriveFactIssueLinks(issueJudgments, factsByObligationId);
  const factInventory = hostFactInventoryFromLedger(
    ledger,
    factsByObligationId,
    rejectedRows,
    lineCounts,
    coveragePolicy.hostFilledObligationIds,
    coveragePolicy.hostFillReason,
  );
  // The coverage rule table, gated by the caller's policy: degrading workflows
  // repair malformed coverage; others pass the model's coverage through to the
  // validator that refuses it.
  const degraded = coveragePolicy.degradeCoverage
    ? degradeJudgmentCoverage(root.coverage, targetPaths)
    : undefined;
  for (const limitation of [
    ...(degraded?.limitations ?? []),
    ...(coveragePolicy.hostLimitations ?? []),
  ]) {
    if (!factInventory.limitations.includes(limitation)) {
      factInventory.limitations.push(limitation);
    }
  }
  const coverage = degraded?.coverage ?? root.coverage;
  // Count the final limitations (one per rejected obligation, plus the host's
  // coverage notes) so an overflow is refused by name, not at the validator.
  assertFactInventoryLimitationCount(
    withRejectedObligationLimitations(
      factInventory.limitations,
      accounting,
      demotionSupersededObligationIds(ledger, factInventory, accounting),
    ).length,
    "$.obligationJudgments",
  );
  assertEveryOpenFactLinked(factsByObligationId);
  return {
    kind: TECHNICAL_CORRECTION_PROPOSAL_KIND,
    schemaVersion: 3,
    verdict: hostJudgmentVerdict(root.verdict, coverage, factInventory),
    coverage,
    factInventory,
    issueJudgments,
    obligationAccounting: accounting,
  };
}

/**
 * The authoritative link direction of a judgment reply is
 * `issueJudgments[].obligationIds`. This writes each fact's `issueIds` from
 * the same judgments, so the V3 proposal validator's two-direction agreement
 * holds by construction.
 */
export function deriveFactIssueLinks(
  issueJudgments: readonly { readonly id: string; readonly factIds: readonly string[] }[],
  factsByObligationId: ReadonlyMap<string, TechnicalSourceFact[]>,
): void {
  for (const fact of [...factsByObligationId.values()].flat()) {
    fact.issueIds = issueJudgments
      .filter((judgment) => judgment.factIds.includes(fact.id))
      .map((judgment) => judgment.id)
      .sort(compareCodePoints);
    // A fact that too many judgments link is refused by name.
    assertTechnicalCorrectionLimit("technicalCorrection.maxJudgmentFactIds", fact.issueIds.length);
  }
}

/**
 * An issue judgment's location must resolve to one approved target page. This
 * is an authority refusal and is terminal.
 */
export function assertJudgmentTargetAuthority(
  location: string,
  targetPathSet: ReadonlySet<string>,
): void {
  const normalized = normalizeRepositoryLocator(location);
  if (normalized.malformed || !normalized.path || !targetPathSet.has(normalized.path)) {
    rejectTechnicalCorrection("target-authority");
  }
}

/**
 * An issue judgment whose linked obligations yield no non-documented fact has
 * nothing to support it. It is refused by name rather than dropped, and a
 * bounded retry restates the rule.
 */
export function assertEveryJudgmentLinksAnOpenFact(
  issueJudgments: readonly { readonly factIds: readonly string[] }[],
): void {
  if (issueJudgments.some((judgment) => judgment.factIds.length === 0)) {
    rejectTechnicalJudgment(
      rejectCorrectable("technical-judgment", "judgment-links-no-open-fact", "$.issueJudgments[]"),
    );
  }
}

/**
 * Every retained or replacement fact that is not documented needs an issue.
 * The model links it only through an issue judgment's `obligationIds`, so an
 * unlinked fact is refused there, not at a `$.factInventory` the reply never
 * carries.
 */
export function assertEveryOpenFactLinked(
  factsByObligationId: ReadonlyMap<string, readonly TechnicalSourceFact[]>,
): void {
  const unlinked = [...factsByObligationId.values()]
    .flat()
    .some((fact) => fact.documentationDisposition !== "documented" && fact.issueIds.length === 0);
  if (unlinked) {
    rejectTechnicalJudgment(
      rejectCorrectable(
        "technical-judgment",
        "judgment-fact-unlinked",
        "$.issueJudgments[].obligationIds",
      ),
    );
  }
}

/**
 * The verdict of a judgment reply when its evidence is unverified.
 *
 * The consistency rule requires "human-review" whenever the host-built
 * inventory has an unverified dimension or a coverage entry is unverified.
 * Dimension status is host-owned (copied from the sealed ledger), so the host
 * records that verdict instead of refusing every reply that does not guess it.
 *
 * This only selects the more conservative verdict. A value outside the review
 * vocabulary passes through for the schema to refuse, and every other verdict
 * still meets the consistency check.
 */
export function hostJudgmentVerdict(
  verdict: unknown,
  coverage: unknown,
  factInventory: VerificationResult["factInventory"],
): unknown {
  if (!(REVIEW_VERDICTS as readonly unknown[]).includes(verdict)) return verdict;
  const unverifiedDimension = factInventory.dimensions.some(
    ({ status }) => status === "unverified",
  );
  const unverifiedCoverage =
    Array.isArray(coverage) &&
    coverage.some(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as Record<string, unknown>).status === "unverified",
    );
  return unverifiedDimension || unverifiedCoverage ? "human-review" : verdict;
}

export function isReviewCategory(value: unknown): boolean {
  return (REVIEW_CATEGORIES as readonly unknown[]).includes(value);
}

export function isReviewSeverity(value: unknown): boolean {
  return (REVIEW_SEVERITIES as readonly unknown[]).includes(value);
}

/**
 * The documentation disposition one retained row or refined replacement of a
 * judgment reply names. Anything outside `DOCUMENTATION_DISPOSITIONS`,
 * a missing member included, is the catalog rule
 * `judgment-documentation-disposition-invalid`, recorded at the member the
 * model wrote, never at a `$.factInventory` the judgment reply does not carry.
 */
export function readDocumentationDisposition(
  value: unknown,
  location: LocationOf<"judgment-documentation-disposition-invalid">,
): TechnicalSourceFact["documentationDisposition"] {
  if (
    typeof value === "string" &&
    (DOCUMENTATION_DISPOSITIONS as readonly string[]).includes(value)
  ) {
    return value as TechnicalSourceFact["documentationDisposition"];
  }
  return rejectTechnicalJudgment(
    rejectCorrectable("technical-judgment", "judgment-documentation-disposition-invalid", location),
    "invalid-fact-inventory",
  );
}

export function hostFactInventoryFromLedger(
  ledger: SourceObligationLedgerV2,
  factsByObligationId: ReadonlyMap<string, TechnicalSourceFact[]>,
  rejectedRows: ReadonlyMap<string, Record<string, unknown>>,
  lineCounts: readonly AdmittedSourceLineCountV1[] | undefined,
  hostFilledObligationIds: ReadonlySet<string> = new Set(),
  hostFillReason: HostFillReason = "answer-cut-at-output-limit",
): VerificationResult["factInventory"] {
  const factsByDimension = ledger.dimensions.map((dimension) =>
    dimension.obligations.flatMap((obligation) => factsByObligationId.get(obligation.id) ?? []),
  );
  const admittedPaths = new Set(ledger.identity.sources.map(({ path }) => path));
  // An applicable dimension left with no facts is demoted only when every one
  // of its obligations has a substantive rejection. Every other emptied
  // dimension is named at once, so one bounded retry can restore them all.
  const demotions = new Map<number, DimensionDemotion>();
  const emptied: TechnicalFactDimension[] = [];
  ledger.dimensions.forEach((dimension, index) => {
    if (dimension.status !== "applicable" || factsByDimension[index]!.length > 0) return;
    // An emptied applicable dimension that owns at least one host-filled
    // obligation is demoted with the host as the reason; one host row is
    // enough. An emptied dimension whose rows all arrived complete keeps the
    // substantive rule and the emptied-dimension refusal.
    const unjudged = dimension.obligations.filter(({ id }) => hostFilledObligationIds.has(id));
    if (unjudged.length > 0) {
      demotions.set(index, hostFilledDimensionDemotion(unjudged.length, hostFillReason));
      return;
    }
    const demotion = substantiveDimensionDemotion(dimension, rejectedRows, admittedPaths);
    if (demotion) demotions.set(index, demotion);
    else emptied.push(dimension.dimension);
  });
  if (emptied.length > 0) rejectEmptiedApplicableDimensions(emptied);
  // Admissibility checks stop a lazy model all-reject from skipping
  // verification. A host-filled demotion has no model rejection to check, and
  // a wholly cut answer demotes every applicable dimension, which
  // `everyApplicableDimension` would refuse.
  const substantive = new Map(
    [...demotions].filter(
      (entry): entry is [number, SubstantiveDimensionDemotion] => !("unjudged" in entry[1]),
    ),
  );
  if (substantive.size > 0) assertDemotionsAdmissible(ledger, substantive, lineCounts);
  const limitations = [...ledger.limitations];
  const addLimitation = (limitation: string): void => {
    if (!limitations.includes(limitation)) limitations.push(limitation);
  };
  return {
    completeness: "bounded-not-proven",
    dimensions: ledger.dimensions.map((dimension, index) => {
      const facts = factsByDimension[index]!;
      if (facts.length > 0) {
        return {
          dimension: dimension.dimension,
          status: "applicable" as const,
          reason: dimension.reason,
          sourceLocators: [],
          facts,
        };
      }
      const demotion = demotions.get(index);
      if (demotion && "unjudged" in demotion) {
        const reason = hostFilledDimensionDemotionReason(
          dimension.dimension,
          demotion.unjudged,
          dimension.obligations.length,
          demotion.reason,
        );
        addLimitation(reason);
        // Every obligation of a demoted dimension is a rejected row, and each
        // needs its own host evidence line, or `demotionSupersededObligationIds`
        // refuses the inventory as a host defect when the recorded proposal is
        // re-validated without this policy.
        for (const { id } of dimension.obligations) {
          addLimitation(
            hostCutDemotionEvidenceLimitation(
              dimension.dimension,
              id,
              hostFilledObligationIds.has(id),
              demotion.reason,
            ),
          );
        }
        return {
          dimension: dimension.dimension,
          status: "unverified" as const,
          reason,
          sourceLocators: [],
          facts: [],
        };
      }
      if (demotion) {
        const reason = dimensionDemotionReason(
          dimension.dimension,
          demotion.reason,
          demotion.rejectionCodes,
        );
        addLimitation(reason);
        for (const row of demotion.rows) {
          addLimitation(demotionEvidenceLimitation(dimension.dimension, row));
        }
        return {
          dimension: dimension.dimension,
          status: "unverified" as const,
          reason,
          sourceLocators: [...demotion.evidenceLocators],
          facts: [],
        };
      }
      return {
        dimension: dimension.dimension,
        status: dimension.status,
        reason: dimension.reason,
        sourceLocators: [...dimension.sourceLocators],
        facts: [],
      };
    }),
    limitations,
  };
}

/** One substantive rejection, as the host admitted it. */
export interface DemotionEvidenceRow {
  readonly obligationId: string;
  readonly rejectionCode: ObligationRejectionCode;
  readonly evidenceLocators: readonly string[];
}

/** The host's closed record of one demoted applicable dimension. */
export interface SubstantiveDimensionDemotion {
  readonly reason: DimensionDemotionReason;
  readonly rejectionCodes: readonly ObligationRejectionCode[];
  readonly evidenceLocators: readonly string[];
  readonly rows: readonly DemotionEvidenceRow[];
}

/**
 * A demotion record with no rejection behind it: the host itself is the reason
 * (`HOST_FILL_REASONS`). Host vocabulary in the reason text, never a model code.
 */
export interface HostFilledDimensionDemotion {
  readonly reason: HostFillReason;
  /** How many of the dimension's obligations the host filled. */
  readonly unjudged: number;
}

export type DimensionDemotion = SubstantiveDimensionDemotion | HostFilledDimensionDemotion;

export function hostFilledDimensionDemotion(
  unjudged: number,
  reason: HostFillReason,
): HostFilledDimensionDemotion {
  return { reason, unjudged };
}

/**
 * The host-authored reason of a dimension demoted because the host filled its
 * rows. Host vocabulary and counts only; it carries no model prose.
 */
export function hostFilledDimensionDemotionReason(
  dimension: TechnicalFactDimension,
  unjudged: number,
  obligations: number,
  reason: HostFillReason = "answer-cut-at-output-limit",
): string {
  if (reason === "judgment-reply-refused") {
    return `Host demotion ${reason}: the step's own checks refused the judgment reply with no retry left, so the host kept no judgment of ${unjudged} of the ${obligations} obligations of the applicable ledger dimension ${dimension}, no source-verified fact remains for it, and human review is required.`;
  }
  if (reason === "continued-judgment-reply-refused") {
    return `Host demotion ${reason}: the step's own checks refused the stitched judgment reply after a continuation, so the host kept no judgment of ${unjudged} of the ${obligations} obligations of the applicable ledger dimension ${dimension} and did not retry the whole step; no source-verified fact remains for it, and human review is required.`;
  }
  return `Host demotion ${reason}: the judgment answer was cut at the output limit before a complete judgment of ${unjudged} of the ${obligations} obligations of the applicable ledger dimension ${dimension} arrived, so no source-verified fact remains for it and human review is required.`;
}

/**
 * The host evidence line of one obligation of a host-demoted dimension. It
 * starts with the demotion evidence prefix, so the rejected-obligation
 * projection stands it in for the generic line.
 */
export function hostCutDemotionEvidenceLimitation(
  dimension: TechnicalFactDimension,
  obligationId: string,
  hostFilled: boolean,
  reason: HostFillReason = "answer-cut-at-output-limit",
): string {
  const how =
    reason === "judgment-reply-refused"
      ? hostFilled
        ? "the step's own checks refused the reply with no retry left, so the host kept none of it and filled it"
        : "its judgment row rejected it"
      : reason === "continued-judgment-reply-refused"
        ? hostFilled
          ? "the step's own checks refused the reply after a continuation, so the host kept none of it and filled it without retrying the whole step"
          : "its judgment row rejected it"
        : hostFilled
          ? "no complete judgment of it arrived before the cut, so the host filled it"
          : "its complete judgment row rejected it before the cut";
  const limitation = `${demotionEvidencePrefix(obligationId)}${dimension}): ${reason}, ${how}.`;
  assertTechnicalCorrectionLimit("technicalCorrection.fieldMaxChars", limitation.length);
  return limitation;
}

/**
 * Demote an applicable ledger dimension only when every one of its
 * obligations was rejected substantively in form: with a closed rejection
 * code and one or more evidence locators into the sealed ledger's admitted
 * sources. Otherwise `undefined`, and the dimension stays an emptied-dimension
 * refusal. The union of cited locators becomes the demoted dimension's
 * locators, within `technicalCorrection.maxDemotionEvidenceLocators`.
 * `assertDemotionsAdmissible` then checks the cited lines and the whole set.
 */
export function substantiveDimensionDemotion(
  dimension: SourceObligationDimensionV1,
  rejectedRows: ReadonlyMap<string, Record<string, unknown>>,
  admittedPaths: ReadonlySet<string>,
): SubstantiveDimensionDemotion | undefined {
  const rejectionCodes = new Set<ObligationRejectionCode>();
  const evidenceLocators = new Set<string>();
  const rows: DemotionEvidenceRow[] = [];
  for (const obligation of dimension.obligations) {
    const row = rejectedRows.get(obligation.id);
    if (!row || !isObligationRejectionCode(row.rejectionCode)) return undefined;
    const cited = admittedEvidenceLocators(row.evidenceLocators, admittedPaths);
    if (!cited) return undefined;
    rejectionCodes.add(row.rejectionCode);
    for (const locator of cited) evidenceLocators.add(locator);
    rows.push({
      obligationId: obligation.id,
      rejectionCode: row.rejectionCode,
      evidenceLocators: [...cited].sort(compareCodePoints),
    });
  }
  assertTechnicalCorrectionLimit(
    "technicalCorrection.maxDemotionEvidenceLocators",
    evidenceLocators.size,
  );
  return {
    reason: "all-obligations-rejected-with-evidence",
    rejectionCodes: [...rejectionCodes].sort(compareCodePoints),
    evidenceLocators: [...evidenceLocators].sort(compareCodePoints),
    rows,
  };
}

/**
 * The checks a demotion must pass beyond its form, so a well-formed lazy
 * all-reject cannot skip verification:
 *
 * 1. At least one applicable dimension keeps a retained or refined
 *    obligation. Demoting every one would leave no source-verified fact.
 * 2. Every cited locator is a line or line range inside the admitted source
 *    content the host observed: start at 1 or later, end at or before the
 *    source's last line.
 * 3. Each demoted dimension's rejections together cite at least two
 *    distinct source lines, so one citation repeated on every row, however
 *    spelled (`path:1` and `path:1-1` are one line), cannot demote it.
 *
 * Each failure is a retryable coded rejection with its own hint. Missing or
 * unbound host line evidence is a host authority failure, never retried.
 */
export function assertDemotionsAdmissible(
  ledger: SourceObligationLedgerV2,
  demotions: ReadonlyMap<number, SubstantiveDimensionDemotion>,
  lineCounts: readonly AdmittedSourceLineCountV1[] | undefined,
): void {
  const applicable = ledger.dimensions.filter(({ status }) => status === "applicable").length;
  if (demotions.size >= applicable) rejectDimensionDemotion("everyApplicableDimension");
  const lines = admittedSourceLineIndex(ledger, lineCounts);
  for (const demotion of demotions.values()) {
    for (const row of demotion.rows) {
      if (!row.evidenceLocators.every((locator) => citesAdmittedLines(locator, lines))) {
        rejectDimensionDemotion("unresolvedEvidence");
      }
    }
  }
  for (const demotion of demotions.values()) {
    if (!citesTwoDistinctLines(demotion.evidenceLocators)) {
      rejectDimensionDemotion("singleLine");
    }
  }
}

/**
 * Whether resolved line locators cite two or more distinct source lines
 * between them. A range of two or more lines does on its own.
 */
export function citesTwoDistinctLines(locators: readonly string[]): boolean {
  const lines = new Set<string>();
  for (const locator of locators) {
    const match = EVIDENCE_LINE_LOCATOR.exec(locator);
    if (!match) continue;
    const start = Number(match[2]);
    if (match[3] !== undefined && Number(match[3]) > start) return true;
    lines.add(`${match[1]}:${start}`);
    if (lines.size > 1) return true;
  }
  return false;
}

/** A line or line-range locator: `path:N` or `path:N-M`. */
export const EVIDENCE_LINE_LOCATOR =
  /^([A-Za-z0-9._][A-Za-z0-9._/-]{0,511}):([0-9]+)(?:-([0-9]+))?$/u;

export function citesAdmittedLines(locator: string, lines: ReadonlyMap<string, number>): boolean {
  const match = EVIDENCE_LINE_LOCATOR.exec(locator);
  const lineCount = match ? lines.get(match[1]!) : undefined;
  if (!match || lineCount === undefined) return false;
  const start = Number(match[2]);
  const end = match[3] === undefined ? start : Number(match[3]);
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 1 &&
    end >= start &&
    end <= lineCount
  );
}

/**
 * The host-observed line count of every sealed-ledger source, bound to its
 * sealed digest. Supplied only for the judgment steps; without it, or when it
 * does not describe exactly the sealed sources, a demotion is refused by
 * authority.
 */
export function admittedSourceLineIndex(
  ledger: SourceObligationLedgerV2,
  lineCounts: readonly AdmittedSourceLineCountV1[] | undefined,
): ReadonlyMap<string, number> {
  if (!lineCounts) return rejectTechnicalCorrection("source-authority");
  const sealed = new Map(ledger.identity.sources.map(({ path, sha256 }) => [path, sha256]));
  const lines = new Map<string, number>();
  for (const { path, sha256, lineCount } of lineCounts) {
    if (
      sealed.get(path) !== sha256 ||
      lines.has(path) ||
      !Number.isSafeInteger(lineCount) ||
      lineCount < 0
    ) {
      return rejectTechnicalCorrection("source-authority");
    }
    lines.set(path, lineCount);
  }
  if (lines.size !== sealed.size) return rejectTechnicalCorrection("source-authority");
  return lines;
}

export function isObligationRejectionCode(value: unknown): value is ObligationRejectionCode {
  return (OBLIGATION_REJECTION_CODES as readonly unknown[]).includes(value);
}

/**
 * A rejection's evidence locators, or `undefined` when they are not a
 * non-empty list of distinct, specific repository-relative locators without a
 * revision suffix, each into an admitted source path. A list longer than
 * `technicalCorrection.maxDemotionEvidenceLocators` is refused by name.
 */
export function admittedEvidenceLocators(
  value: unknown,
  admittedPaths: ReadonlySet<string>,
): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  assertTechnicalCorrectionLimit("technicalCorrection.maxDemotionEvidenceLocators", value.length);
  const locators: string[] = [];
  for (const locator of value) {
    // A section locator ("path: label") can end in a revision suffix the
    // line-locator grammar already refuses, so the suffix is refused here.
    if (typeof locator !== "string" || locator.includes("@") || locators.includes(locator)) {
      return undefined;
    }
    // The locator grammar refuses surrounding whitespace.
    const normalized = normalizeRepositoryLocator(locator);
    if (
      normalized.malformed ||
      !normalized.specific ||
      !normalized.path ||
      !admittedPaths.has(normalized.path)
    ) {
      return undefined;
    }
    locators.push(locator);
  }
  return locators;
}

/**
 * The host-authored reason of a demoted dimension: the closed demotion reason,
 * the dimension, and the closed rejection codes, with no model prose. The
 * fact-inventory rule copies it into limitations verbatim.
 */
export function dimensionDemotionReason(
  dimension: TechnicalFactDimension,
  reason: DimensionDemotionReason,
  rejectionCodes: readonly ObligationRejectionCode[],
): string {
  return `Host demotion ${reason}: every obligation of the applicable ledger dimension ${dimension} was rejected with admitted source evidence (rejection codes: ${rejectionCodes.join(", ")}), so no source-verified fact remains for it and human review is required.`;
}

/**
 * One demoted rejection's evidence, per obligation, as a host limitation: the
 * host-issued obligation ID, the dimension, the closed rejection code, and the
 * evidence locators the host resolved against admitted source lines, with no
 * model prose. Bounded by `technicalCorrection.fieldMaxChars`, refused by
 * name.
 */
export function demotionEvidenceLimitation(
  dimension: TechnicalFactDimension,
  row: DemotionEvidenceRow,
): string {
  const limitation = `${demotionEvidencePrefix(row.obligationId)}${dimension}): ${row.rejectionCode} at ${row.evidenceLocators.join("; ")}.`;
  assertTechnicalCorrectionLimit("technicalCorrection.fieldMaxChars", limitation.length);
  return limitation;
}

export function validateTechnicalCorrectionProposalV3(
  value: unknown,
  ledger: SourceObligationLedgerV2,
  targetPaths: readonly string[],
  scope: TechnicalCorrectionByteBoundScope = byteBoundScope(ledger, targetPaths, "host"),
): TechnicalCorrectionProposalV3 {
  const proposal = normalizeTechnicalCorrectionProposalV3(value, ledger, targetPaths);
  assertCanonicalJsonByteBound(proposal, "proposal", scope);
  return proposal;
}

/** Shared normalization for ordinary admission and the earlier lower-bound measurement. */
export function normalizeTechnicalCorrectionProposalV3(
  value: unknown,
  ledger: SourceObligationLedgerV2,
  targetPaths: readonly string[],
): TechnicalCorrectionProposalV3 {
  const root = correctionEnvelope(value, TECHNICAL_CORRECTION_PROPOSAL_KEYS);
  if (root.kind !== TECHNICAL_CORRECTION_PROPOSAL_KIND || root.schemaVersion !== 3) {
    return fail("Technical correction V3 proposal has an unsupported identity.");
  }
  const targetPathSet = new Set(targetPaths);
  const judgmentValues = kit.array(root.issueJudgments);
  assertTechnicalCorrectionLimit("technicalCorrection.maxIssueJudgments", judgmentValues.length);
  const parsedJudgments = judgmentValues.map((value) => {
    const judgment = kit.object(value);
    kit.exact(judgment, TECHNICAL_CORRECTION_PROPOSAL_ISSUE_JUDGMENT_KEYS);
    const id = boundedJudgmentText(judgment.id, "technicalCorrection.identifierMaxChars");
    const severity = judgment.severity;
    const category = judgment.category;
    const location = boundedJudgmentText(judgment.location, "technicalCorrection.fieldMaxChars");
    if (
      !REVIEW_SEVERITIES.includes(severity as TechnicalCorrectionIssueJudgmentV3["severity"]) ||
      !REVIEW_CATEGORIES.includes(category as TechnicalCorrectionIssueJudgmentV3["category"])
    ) {
      return fail("Technical correction V3 judgment metadata is invalid.");
    }
    assertJudgmentTargetAuthority(location, targetPathSet);
    const factIds = boundedJudgmentIdList(
      judgment.factIds,
      "technicalCorrection.maxJudgmentFactIds",
    );
    if (factIds.some((factId) => !FACT_ID.test(factId))) {
      return rejectTechnicalCorrection("invalid-fact-link", undefined, {
        code: "fact-link-malformed-fact-id",
        location: "$.issueJudgments[].factIds[]",
      });
    }
    return {
      id,
      severity: severity as TechnicalCorrectionIssueJudgmentV3["severity"],
      category: category as TechnicalCorrectionIssueJudgmentV3["category"],
      location,
      factIds,
    };
  });
  const validationResult = validateVerificationResult(
    {
      review: {
        verdict: root.verdict,
        issues: parsedJudgments.map((judgment) => ({
          id: judgment.id,
          severity: judgment.severity,
          category: judgment.category,
          location: judgment.location,
          finding: "Host derives this finding from the linked admitted facts.",
          evidence: {
            source_id: ledger.identity.repositoryRevision,
            locator: judgment.location,
          },
          required_change: "Host derives this action from the linked admitted facts.",
        })),
      },
      coverage: root.coverage,
      factInventory: root.factInventory,
    },
    targetPaths,
  );
  const facts = validationResult.factInventory.dimensions.flatMap((dimension) => dimension.facts);
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  if (new Set(parsedJudgments.map((judgment) => judgment.id)).size !== parsedJudgments.length) {
    return rejectTechnicalCorrection("invalid-shape");
  }
  const admittedJudgments: TechnicalCorrectionIssueJudgmentV3[] = [];
  for (const judgment of parsedJudgments) {
    if (judgment.factIds.length === 0) {
      if (facts.some((fact) => fact.issueIds.includes(judgment.id))) {
        return rejectTechnicalCorrection("invalid-fact-link", undefined, {
          code: "fact-link-judgment-omits-linked-facts",
          location: "$.issueJudgments[].factIds",
        });
      }
      continue;
    }
    for (const factId of judgment.factIds) {
      const fact = factsById.get(factId);
      if (!fact || fact.documentationDisposition === "documented") {
        return rejectTechnicalCorrection("invalid-fact-link", undefined, {
          code: fact ? "fact-link-documented-fact" : "fact-link-unknown-fact",
          location: "$.issueJudgments[].factIds[]",
        });
      }
    }
    const expectedFactIds = facts
      .filter((fact) => fact.issueIds.includes(judgment.id))
      .map((fact) => fact.id)
      .sort(compareCodePoints);
    if (
      expectedFactIds.length !== judgment.factIds.length ||
      [...judgment.factIds]
        .sort(compareCodePoints)
        .some((factId, index) => factId !== expectedFactIds[index])
    ) {
      return rejectTechnicalCorrection("invalid-fact-link", undefined, {
        code: "fact-link-judgment-fact-mismatch",
        location: "$.issueJudgments[].factIds",
      });
    }
    admittedJudgments.push(judgment);
  }
  const judgmentIds = new Set(admittedJudgments.map((judgment) => judgment.id));
  for (const fact of facts) {
    if (fact.documentationDisposition === "documented") continue;
    for (const issueId of fact.issueIds) {
      const judgment = admittedJudgments.find((candidate) => candidate.id === issueId);
      if (!judgmentIds.has(issueId) || !judgment?.factIds.includes(fact.id)) {
        return rejectTechnicalCorrection("invalid-fact-link", undefined, {
          code: judgmentIds.has(issueId)
            ? "fact-link-judgment-missing-fact"
            : "fact-link-unknown-issue",
          location: "$.factInventory.dimensions[].facts[].issueIds[]",
        });
      }
    }
  }
  const obligationAccounting = technicalCorrectionBoundary("invalid-accounting", () =>
    validateAccounting(root.obligationAccounting, ledger, validationResult, undefined, true),
  );
  const proposal: TechnicalCorrectionProposalV3 = {
    kind: TECHNICAL_CORRECTION_PROPOSAL_KIND,
    schemaVersion: 3,
    verdict: validationResult.review.verdict,
    coverage: validationResult.coverage,
    factInventory: validationResult.factInventory,
    issueJudgments: admittedJudgments,
    obligationAccounting,
  };
  return proposal;
}

export function deriveTechnicalCorrectionVerificationResultV3(
  proposal: TechnicalCorrectionProposalV3,
  ledger: SourceObligationLedgerV2,
  targetPaths: readonly string[],
  scope: TechnicalCorrectionByteBoundScope = byteBoundScope(ledger, targetPaths, "host"),
): VerificationResult {
  const repositoryRevision = ledger.identity.repositoryRevision;
  const dimensions = TECHNICAL_FACT_DIMENSIONS.map((dimension) => {
    const assessment = proposal.factInventory.dimensions.find(
      (candidate) => candidate.dimension === dimension,
    )!;
    return {
      ...assessment,
      sourceLocators: [...assessment.sourceLocators].sort(compareCodePoints),
      facts: [...assessment.facts]
        .sort((left, right) => compareCodePoints(left.id, right.id))
        .map((fact) => ({
          ...fact,
          sourceLocators: [...fact.sourceLocators].sort(compareCodePoints),
          issueIds: [...fact.issueIds].sort(compareCodePoints),
        })),
    };
  });
  const factsById = new Map(
    dimensions.flatMap((dimension) => dimension.facts).map((fact) => [fact.id, fact]),
  );
  const issues = [...proposal.issueJudgments]
    .sort((left, right) => compareCodePoints(left.id, right.id))
    .map((judgment) => {
      const facts = judgment.factIds.map((factId) => factsById.get(factId)!).sort(compareFacts);
      if (
        facts.length === 0 ||
        facts.some((fact) => fact.documentationDisposition === "documented")
      ) {
        return fail("Technical correction V3 judgment has insufficient supported action.");
      }
      const factSections = facts.map(
        (fact) =>
          `Fact ${fact.id} (${fact.documentationDisposition}): ${fact.statement}\n` +
          `Qualification: ${fact.uncertainty}`,
      );
      const requiredChanges = facts.map(
        (fact) =>
          `${requiredChangePrefix(fact.documentationDisposition)}\n` +
          `Fact ${fact.id} (${fact.documentationDisposition}): ${fact.statement}\n` +
          `Qualification: ${fact.uncertainty}`,
      );
      const locators = [...new Set(facts.flatMap((fact) => fact.sourceLocators))].sort(
        compareCodePoints,
      );
      return {
        id: judgment.id,
        severity: judgment.severity,
        category: judgment.category,
        location: judgment.location,
        finding: factSections.join("\n\n"),
        evidence: { source_id: repositoryRevision, locator: locators.join("; ") },
        required_change: requiredChanges.join("\n\n"),
      };
    });
  const coverage = proposal.coverage
    .map((entry) => ({ ...entry, evidence: [...entry.evidence].sort(compareCodePoints) }))
    .sort((left, right) => compareCodePoints(left.path, right.path));
  let verificationResult = validateVerificationResult(
    {
      review: { verdict: proposal.verdict, issues },
      coverage,
      factInventory: {
        completeness: proposal.factInventory.completeness,
        dimensions,
        limitations: [...proposal.factInventory.limitations].sort(compareCodePoints),
      },
    },
    targetPaths,
  );
  verificationResult = projectRejectedObligationLimitations(
    verificationResult,
    [...proposal.obligationAccounting]
      .sort((left, right) => compareCodePoints(left.obligationId, right.obligationId))
      .map((row) =>
        row.disposition === "retained"
          ? row
          : { ...row, sourceLocators: [...row.sourceLocators].sort(compareCodePoints) },
      ),
    demotionSupersededObligationIds(ledger, proposal.factInventory, proposal.obligationAccounting),
  );
  verificationResult = {
    ...verificationResult,
    factInventory: {
      ...verificationResult.factInventory,
      limitations: [...verificationResult.factInventory.limitations].sort(compareCodePoints),
    },
  };
  verificationResult = validateVerificationResult(verificationResult, targetPaths);
  assertCanonicalJsonByteBound(verificationResult, "derivedResult", scope);
  return verificationResult;
}

export function requiredChangePrefix(
  disposition: VerificationResult["factInventory"]["dimensions"][number]["facts"][number]["documentationDisposition"],
): string {
  switch (disposition) {
    case "omitted":
      return "Document this source-supported behavior and preserve its qualifications.";
    case "conflicting":
      return "Correct the documentation to this source-supported behavior and preserve its qualifications.";
    case "unverified-policy":
      return "Obtain approved governing authority for this assertion before presenting it as established policy; preserve the stated uncertainty.";
    case "product-defect":
      return "Document this source-observed product defect and its qualification as a limitation; request a product-owner decision; do not present a product fix as completed.";
    case "documented":
      return fail("Technical correction V3 documented fact cannot yield a correction action.");
  }
}

export function compareFacts(
  left: VerificationResult["factInventory"]["dimensions"][number]["facts"][number],
  right: VerificationResult["factInventory"]["dimensions"][number]["facts"][number],
): number {
  const dimensionOrder =
    TECHNICAL_FACT_DIMENSIONS.indexOf(left.dimension) -
    TECHNICAL_FACT_DIMENSIONS.indexOf(right.dimension);
  return dimensionOrder || compareCodePoints(left.id, right.id);
}

/**
 * The review targets among admitted source paths: every documentation page,
 * sorted. The run-start scope check and the sealed authority share it.
 */
export function reviewDocumentationTargetPaths(paths: Iterable<string>): string[] {
  return [...paths].filter(isDocumentationMarkupPath).sort();
}

export function validateTechnicalCorrectionEvidence(
  value: unknown,
  ledger: SourceObligationLedger,
  verificationResult: VerificationResult,
  authorityEvidence?: OriginalSourceAuthorityEvidenceV1,
  authoritativeTargetPaths?: readonly string[],
): TechnicalCorrectionEvidence {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  if (root.schemaVersion === 4) {
    if (ledger.schemaVersion !== 2 || !authorityEvidence)
      return fail(
        "Technical correction evidence version does not match its ledger authority.",
        false,
      );
    kit.exact(root, [
      "kind",
      "schemaVersion",
      "sourceObligationLedgerSha256",
      "verificationResultSha256",
      "proposal",
      "proposalSha256",
      "originalSourceAuthoritySha256",
      "sourceChecks",
      "provisionalRichCandidateSha256",
      "richAssessments",
      "richIssues",
      "digest",
    ]);
    if (root.kind !== TECHNICAL_CORRECTION_EVIDENCE_KIND)
      return fail("Technical correction evidence has an unsupported identity.");
    const authority = validateOriginalSourceAuthorityEvidence(authorityEvidence);
    const targetPaths =
      authoritativeTargetPaths ?? verificationResult.coverage.map((entry) => entry.path);
    const proposal = validateTechnicalCorrectionProposalV3(root.proposal, ledger, targetPaths);
    const derived = deriveTechnicalCorrectionVerificationResultV3(proposal, ledger, targetPaths);
    const requiredPaths = technicalCorrectionAuthorityPaths(derived, proposal.obligationAccounting);
    const sourceChecks = validateSourceChecks(root.sourceChecks, requiredPaths, authority);
    const richAssessments = kit.array(root.richAssessments) as TechnicalRichAssessmentV1[];
    const richIssues = kit.array(root.richIssues) as TechnicalCorrectionRichIssueV4[];
    if (
      richIssues.length !== proposal.issueJudgments.length ||
      richIssues.some((row, index) => row?.issueId !== proposal.issueJudgments[index]?.id)
    )
      return rejectTechnicalCorrection("invalid-shape");
    const content = {
      kind: TECHNICAL_CORRECTION_EVIDENCE_KIND,
      schemaVersion: 4 as const,
      sourceObligationLedgerSha256: boundedDigest(root.sourceObligationLedgerSha256),
      verificationResultSha256: boundedDigest(root.verificationResultSha256),
      proposal,
      proposalSha256: boundedDigest(root.proposalSha256),
      originalSourceAuthoritySha256: boundedDigest(root.originalSourceAuthoritySha256),
      sourceChecks,
      provisionalRichCandidateSha256: boundedDigest(root.provisionalRichCandidateSha256),
      richAssessments,
      richIssues,
    };
    if (
      content.sourceObligationLedgerSha256 !== ledger.digest ||
      content.verificationResultSha256 !== canonicalDigest(verificationResult) ||
      canonicalDigest(derived) !== canonicalDigest(verificationResult) ||
      content.proposalSha256 !== canonicalDigest(proposal) ||
      content.originalSourceAuthoritySha256 !== authority.digest ||
      canonicalDigest(ledger.identity.originalSourceAuthority) !==
        canonicalDigest(authority.descriptor) ||
      root.digest !== canonicalDigest(content)
    )
      return fail(
        "Technical correction V4 evidence is not bound to its proposal, result, ledger, and original authority.",
        false,
      );
    const evidence = Object.freeze({ ...content, digest: root.digest as string });
    assertCanonicalJsonByteBound(evidence, "evidence", byteBoundScope(ledger, targetPaths, "host"));
    return evidence;
  }
  if (root.schemaVersion === 3) {
    if (ledger.schemaVersion !== 2 || !authorityEvidence) {
      return fail(
        "Technical correction evidence version does not match its ledger authority.",
        false,
      );
    }
    kit.exact(root, [
      "kind",
      "schemaVersion",
      "sourceObligationLedgerSha256",
      "verificationResultSha256",
      "proposal",
      "proposalSha256",
      "originalSourceAuthoritySha256",
      "sourceChecks",
      "digest",
    ]);
    if (root.kind !== TECHNICAL_CORRECTION_EVIDENCE_KIND) {
      return fail("Technical correction evidence has an unsupported identity.");
    }
    const authority = validateOriginalSourceAuthorityEvidence(authorityEvidence);
    const targetPaths =
      authoritativeTargetPaths ?? verificationResult.coverage.map((entry) => entry.path);
    const proposal = validateTechnicalCorrectionProposalV3(root.proposal, ledger, targetPaths);
    const derived = deriveTechnicalCorrectionVerificationResultV3(proposal, ledger, targetPaths);
    const requiredPaths = technicalCorrectionAuthorityPaths(derived, proposal.obligationAccounting);
    const sourceChecks = validateSourceChecks(root.sourceChecks, requiredPaths, authority);
    const content = {
      kind: TECHNICAL_CORRECTION_EVIDENCE_KIND,
      schemaVersion: 3 as const,
      sourceObligationLedgerSha256: boundedDigest(root.sourceObligationLedgerSha256),
      verificationResultSha256: boundedDigest(root.verificationResultSha256),
      proposal,
      proposalSha256: boundedDigest(root.proposalSha256),
      originalSourceAuthoritySha256: boundedDigest(root.originalSourceAuthoritySha256),
      sourceChecks,
    };
    if (
      content.sourceObligationLedgerSha256 !== ledger.digest ||
      content.verificationResultSha256 !== canonicalDigest(verificationResult) ||
      canonicalDigest(derived) !== canonicalDigest(verificationResult) ||
      content.proposalSha256 !== canonicalDigest(proposal) ||
      content.originalSourceAuthoritySha256 !== authority.digest ||
      canonicalDigest(ledger.identity.originalSourceAuthority) !==
        canonicalDigest(authority.descriptor) ||
      root.digest !== canonicalDigest(content)
    ) {
      return fail(
        "Technical correction V3 evidence is not bound to its proposal, derived result, ledger, and original authority.",
        false,
      );
    }
    const evidence = Object.freeze({ ...content, digest: root.digest as string });
    assertCanonicalJsonByteBound(evidence, "evidence", byteBoundScope(ledger, targetPaths, "host"));
    return evidence;
  }
  if (root.schemaVersion === 2) {
    if (ledger.schemaVersion !== 2 || !authorityEvidence) {
      return fail(
        "Technical correction evidence version does not match its ledger authority.",
        false,
      );
    }
    kit.exact(root, [
      "kind",
      "schemaVersion",
      "sourceObligationLedgerSha256",
      "verificationResultSha256",
      "obligationAccounting",
      "originalSourceAuthoritySha256",
      "sourceChecks",
      "digest",
    ]);
    if (root.kind !== TECHNICAL_CORRECTION_EVIDENCE_KIND) {
      return fail("Technical correction evidence has an unsupported identity.");
    }
    const authority = validateOriginalSourceAuthorityEvidence(authorityEvidence);
    const obligationAccounting = validateAccounting(
      root.obligationAccounting,
      ledger,
      verificationResult,
      undefined,
    );
    if (
      canonicalDigest(
        projectRejectedObligationLimitations(verificationResult, obligationAccounting),
      ) !== canonicalDigest(verificationResult)
    ) {
      return fail(
        "Technical correction final limitations omit rejected source-obligation evidence.",
      );
    }
    const requiredPaths = technicalCorrectionAuthorityPaths(
      verificationResult,
      obligationAccounting,
    );
    const sourceChecks = validateSourceChecks(root.sourceChecks, requiredPaths, authority);
    const content = {
      kind: TECHNICAL_CORRECTION_EVIDENCE_KIND,
      schemaVersion: 2 as const,
      sourceObligationLedgerSha256: boundedDigest(root.sourceObligationLedgerSha256),
      verificationResultSha256: boundedDigest(root.verificationResultSha256),
      obligationAccounting,
      originalSourceAuthoritySha256: boundedDigest(root.originalSourceAuthoritySha256),
      sourceChecks,
    };
    if (
      content.sourceObligationLedgerSha256 !== ledger.digest ||
      content.verificationResultSha256 !== canonicalDigest(verificationResult) ||
      content.originalSourceAuthoritySha256 !== authority.digest ||
      canonicalDigest(ledger.identity.originalSourceAuthority) !==
        canonicalDigest(authority.descriptor) ||
      root.digest !== canonicalDigest(content)
    ) {
      return fail(
        "Technical correction evidence is not bound to the ledger and original authority.",
        false,
      );
    }
    return Object.freeze({ ...content, digest: root.digest as string });
  }
  if (ledger.schemaVersion !== 1) {
    return fail(
      "Technical correction evidence version does not match its ledger authority.",
      false,
    );
  }
  kit.exact(root, [
    "kind",
    "schemaVersion",
    "sourceObligationLedgerSha256",
    "verificationResultSha256",
    "obligationAccounting",
    "digest",
  ]);
  if (root.kind !== TECHNICAL_CORRECTION_EVIDENCE_KIND || root.schemaVersion !== 1) {
    return fail("Technical correction evidence has an unsupported identity.");
  }
  const obligationAccounting = validateAccounting(
    root.obligationAccounting,
    ledger,
    verificationResult,
  );
  if (
    canonicalDigest(
      projectRejectedObligationLimitations(verificationResult, obligationAccounting),
    ) !== canonicalDigest(verificationResult)
  ) {
    return fail("Technical correction final limitations omit rejected source-obligation evidence.");
  }
  const content = {
    kind: TECHNICAL_CORRECTION_EVIDENCE_KIND,
    schemaVersion: 1 as const,
    sourceObligationLedgerSha256: boundedDigest(root.sourceObligationLedgerSha256),
    verificationResultSha256: boundedDigest(root.verificationResultSha256),
    obligationAccounting,
  };
  if (
    content.sourceObligationLedgerSha256 !== ledger.digest ||
    content.verificationResultSha256 !== canonicalDigest(verificationResult) ||
    root.digest !== canonicalDigest(content)
  ) {
    return fail(
      "Technical correction evidence is not bound to the ledger and final result.",
      false,
    );
  }
  return Object.freeze({ ...content, digest: root.digest as string });
}
