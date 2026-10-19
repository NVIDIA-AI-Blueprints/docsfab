// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  canonicalArtifactJson,
  createEditorialDecisionCandidateFromProposalV1,
  createEditorialDecisionPayloadV1,
  decodeEditorialDecisionProducerV1,
  decodeEditorialDecisionPayloadV1,
  editorialDecisionReferenceV3,
  validateArtifact,
  validateArtifactReference,
  validateEditorialDecisionProposalV1,
  ArtifactStoreError,
  type Artifact,
  type ArtifactReference,
  type DurableArtifactStore,
  type EditorialDecisionArtifactReferenceV3,
  type EditorialDecisionAssessmentRecommendationV1,
  type EditorialDecisionPayloadV1,
  type EditorialDecisionProducerProvenanceV1,
  type EditorialDecisionProposalV1,
  type ResolvedEditorialDecisionEvidenceV1,
  type ResolvedEditorialDecisionRationaleV1,
} from "../artifacts/index.js";
import { canonicalJson, decodeContentIndexV1 } from "../content-ir/index.js";
import type { ContentIndexV1 } from "../content-ir/contracts.js";
import { EditorialEvidenceHostError, fail, kit } from "./editorial-evidence-host/contract-kit.js";
import {
  loadContentIndex,
  persistContentIndex,
} from "./editorial-evidence-host/content-index-store.js";
import {
  associationLocator,
  recordLocator,
  repositoryIndexLocator,
} from "./editorial-evidence-host/record-locators.js";
import {
  readerContextProvenanceSha256,
  readerContextSha256,
  validateReaderContextComparisonV1,
  validateReaderContextInputV1,
  validateReaderContextProvenanceV1,
  validateReaderContextV1,
  type ReaderContextComparisonV1,
  type ReaderContextInputV1,
  type ReaderContextPolicyIdentityV1,
  type ReaderContextProvenanceSourceV1,
  type ReaderContextProvenanceV1,
  type ReaderContextV1,
} from "../context/reader-context.js";
import type { RunRecord, StepRunRecord } from "../records/contracts.js";
import { containsConfiguredCredential } from "../security/configured-credentials.js";
import type { ReaderTaskContextSourceBytesV1 } from "../execution/reader-task-admission.js";
import {
  SUPERSEDED_READER_IMPACT_BASELINE_SHA256S,
  type ReaderTaskContextAdmissionV1,
} from "../execution/task-context.js";
import type { ReaderTaskContextProjectionV1 } from "../execution/task-context.js";
import type {
  WorkflowBranchEvidenceHost,
  WorkflowBranchSelectionEvidenceV1,
  WorkflowDefinition,
} from "../workflow-contracts/contracts.js";
import { sha256 } from "../content-ir/canonical.js";
import type { InferenceRejectionReasonV1 } from "../execution/contracts.js";
import { isWorkflowOutcomeCode } from "../workflow-contracts/outcome.js";
import {
  EDITORIAL_ASSESSMENT_PROPOSAL_KEYS,
  EDITORIAL_ASSESSMENT_RECOMMENDATION_KEYS,
} from "../execution/response-contract-keys.js";
import {
  QUALITY_EVALUATION_NOT_APPLICABLE_LIMITATION,
  type EditorialDecisionRetainedPlanV1,
} from "../artifacts/editorial-decision.js";
import {
  documentationPlanWritePaths,
  validateAdmittedDocumentationPlanBinding,
} from "./plan-binding.js";
// Key sets live in one dependency-free module.
export {
  EDITORIAL_ASSESSMENT_PROPOSAL_KEYS,
  EDITORIAL_ASSESSMENT_RECOMMENDATION_KEYS,
} from "../execution/response-contract-keys.js";
export {
  EditorialEvidenceHostError,
  type EditorialEvidenceHostErrorCode,
} from "./editorial-evidence-host/contract-kit.js";

const ASSESSMENT_STEPS = [
  "verify-technical-accuracy",
  "review-documentation",
  "test-audience-understanding",
  "evaluate-document-quality",
] as const;
const SAFE_LIMITATION = /^[a-z0-9][a-z0-9._/-]{0,127}$/u;
const MAX_RATIONALE_CHARACTERS = 4_096;
const MAX_SOURCE_BYTES = 1024 * 1024;
const SOURCE_ROLES = [
  "public-contract",
  "changed-source",
  "current-documentation",
  "repository-instruction",
  "accepted-knowledge",
  "request",
] as const;

export type EditorialAssessmentStepIdV1 = (typeof ASSESSMENT_STEPS)[number];

/** Model-authored assessment content. It carries no producer, snapshot, phase, or seal. */
export interface EditorialAssessmentProposalV1 {
  schemaVersion: 1;
  kind: "docsfab-editorial-assessment-proposal";
  assessment: "accepted" | "rejected" | "not-applicable";
  rationale: string;
  evidenceRefs: ArtifactReference[];
  limitations: string[];
  recommendation: Omit<EditorialDecisionAssessmentRecommendationV1, "rationaleSha256"> | null;
}

export type EditorialEvidenceSourceBytesV1 = ReaderTaskContextSourceBytesV1;

export interface EditorialEvidenceHostOptionsV1 {
  store: DurableArtifactStore;
  index: ContentIndexV1;
  readerContextInput: ReaderContextInputV1;
  baselineSha256: string;
  policy: ReaderContextPolicyIdentityV1;
  comparison: ReaderContextComparisonV1;
  repositoryIdentitySha256: string;
  workspaceSnapshotSha256: string;
  observedAt: string;
  provenanceLimitations: readonly string[];
  sources: readonly EditorialEvidenceSourceBytesV1[];
  admittedArtifacts: readonly Artifact[];
  /**
   * Whether the run supplied the audience protocol the audience step needs.
   * Without it the host decides that step's assessment.
   */
  audienceProtocol: "supplied" | "not-supplied";
  projectCompletedReaderTaskContext(input: {
    readerContext: ReaderContextV1;
    provenance: ReaderContextProvenanceV1;
    admission: ReaderTaskContextAdmissionV1;
  }): ReaderTaskContextProjectionV1;
}

export interface EditorialEvidenceDecodeOptionsV1 {
  decodeEditorialDecision(
    reference: EditorialDecisionArtifactReferenceV3,
    stepId: string,
  ): EditorialDecisionPayloadV1;
}

export interface EditorialEvidenceReplayOptionsV1 {
  store: DurableArtifactStore;
  record: Readonly<RunRecord>;
  baselineSha256: string;
  policy: ReaderContextPolicyIdentityV1;
  admission: ReaderTaskContextAdmissionV1;
}

export interface EditorialEvidenceColdReplayOptionsV1 {
  store: DurableArtifactStore;
  record: Readonly<RunRecord>;
  baselineSha256: string;
  policy: ReaderContextPolicyIdentityV1;
}

/**
 * A model-authored assessment limitation or recommendation code outside
 * `WORKFLOW_OUTCOME_CODE_GRAMMAR`. The workflow outcome's findings admit these
 * codes under that grammar, so they are refused here, where the read-only
 * retry can correct them, rather than after every step succeeded.
 */
export const EDITORIAL_LIMITATION_CODE_REJECTIONS = Object.freeze({
  limitation: Object.freeze({
    code: "editorial-limitation-code-off-grammar",
    location: "$.editorialAssessmentProposal.limitations[]",
  }),
  recommendation: Object.freeze({
    code: "editorial-limitation-code-off-grammar",
    location: "$.editorialAssessmentProposal.recommendation.code",
  }),
} as const);

/** Refuse a model-authored code with its closed rule and location. */
function refuseCode(rejection: InferenceRejectionReasonV1): never {
  throw new EditorialEvidenceHostError("invalid-value", rejection); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
}

/** Strictly decode untrusted assessment content before binding it to an actual step. */
export function decodeEditorialAssessmentProposalV1(
  value: unknown,
  admittedEvidenceRefs: readonly ArtifactReference[],
): EditorialAssessmentProposalV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, EDITORIAL_ASSESSMENT_PROPOSAL_KEYS);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-editorial-assessment-proposal") {
    fail("invalid-shape");
  }
  const evidenceRefs = kit
    .array(root.evidenceRefs)
    .map((value) => validateArtifactReference(value));
  if (evidenceRefs.length < 1 || evidenceRefs.length > 128) fail("invalid-value");
  const keys = evidenceRefs.map(referenceKey);
  kit.unique(keys);
  const admitted = new Set(admittedEvidenceRefs.map(referenceKey));
  if (keys.some((key) => !admitted.has(key))) fail("evidence-unavailable");
  const assessment = kit.enumeration(root.assessment, ["accepted", "rejected", "not-applicable"]);
  const recommendation = decodeAssessmentRecommendation(root.recommendation);
  if ((assessment === "rejected") !== (recommendation !== null)) fail("invalid-value");
  const decodedLimitations = limitations(root.limitations);
  if (decodedLimitations.some((code) => !isWorkflowOutcomeCode(code))) {
    refuseCode(EDITORIAL_LIMITATION_CODE_REJECTIONS.limitation);
  }
  if (
    assessment !== "rejected" &&
    decodedLimitations.some(
      (code) => code.startsWith("product-gap.") || code.startsWith("evidence-limitation."),
    )
  ) {
    fail("invalid-value");
  }
  return kit.deepFreeze({
    schemaVersion: 1,
    kind: "docsfab-editorial-assessment-proposal",
    assessment,
    rationale: rationale(root.rationale),
    evidenceRefs,
    limitations: decodedLimitations,
    recommendation,
  });
}

const AUDIENCE_STEP_ID = "test-audience-understanding" satisfies EditorialAssessmentStepIdV1;

/**
 * The rationale the host records for an audience assessment it decides. It
 * replaces the reply's rationale, so the record says who decided the verdict.
 */
export const HOST_AUDIENCE_ASSESSMENT_RATIONALE =
  "DocsFab host decision: this run supplied no audience protocol (target identity, versioned scenario corpus and oracle, representative participant, and run authority), so the audience step could not test the candidate. The host records this assessment as not-applicable; it is neither evidence for nor against the editorial candidate.";

/**
 * The audience step's assessment when the run supplied no audience protocol.
 * The step cannot test the candidate, so its assessment is `not-applicable`
 * whatever the reply proposes; the reply's rationale and codes are not kept.
 * The missing protocol is a standing limitation of the run, which the outcome
 * already records as `insufficient-evidence` on this step. It cannot reverse
 * the editorial candidate.
 */
function hostDerivedAudienceAssessment(
  proposal: EditorialAssessmentProposalV1,
): EditorialAssessmentProposalV1 {
  return kit.deepFreeze({
    ...proposal,
    assessment: "not-applicable",
    rationale: HOST_AUDIENCE_ASSESSMENT_RATIONALE,
    limitations: [],
    recommendation: null,
  });
}

function decodeAssessmentRecommendation(
  value: unknown,
): Omit<EditorialDecisionAssessmentRecommendationV1, "rationaleSha256"> | null {
  if (value === null) return null;
  const root = kit.object(value);
  kit.exact(root, EDITORIAL_ASSESSMENT_RECOMMENDATION_KEYS);
  const candidate = kit.enumeration(root.candidate, ["update", "insufficient-evidence"]);
  const kind = kit.enumeration(root.kind, ["product-gap", "evidence-limitation"]);
  const code = kit.string(root.code);
  if ((candidate === "update") !== (kind === "product-gap") || !code.startsWith(`${kind}.`)) {
    fail("invalid-value");
  }
  if (!isWorkflowOutcomeCode(code)) refuseCode(EDITORIAL_LIMITATION_CODE_REJECTIONS.recommendation);
  return { candidate, kind, code };
}

/**
 * Production branch host backed by genuine Artifact bytes and durable rationale/association records.
 * Create it with {@link createEditorialEvidenceHostV1}; the constructor is private.
 */
export class EditorialEvidenceHostV1 implements WorkflowBranchEvidenceHost {
  private readonly evidence = new Map<string, ResolvedEditorialDecisionEvidenceV1>();
  private readonly rationales = new Map<string, ResolvedEditorialDecisionRationaleV1>();
  private readonly decisionRationales = new Map<string, ResolvedEditorialDecisionRationaleV1>();
  private readonly assessments = new Map<
    EditorialAssessmentStepIdV1,
    EditorialAssessmentProposalV1
  >();
  private readonly decisionContexts = new Map<
    string,
    { payload: EditorialDecisionPayloadV1; producer: EditorialDecisionProducerProvenanceV1 }
  >();
  private readerContext?: ReaderContextV1;
  private readerProvenance?: ReaderContextProvenanceV1;
  private readerTaskContext?: ReaderTaskContextProjectionV1;
  private candidate?: EditorialDecisionPayloadV1;
  private candidateReference?: EditorialDecisionArtifactReferenceV3;
  private runId?: string;
  private record?: Readonly<RunRecord>;

  private constructor(private readonly options: NormalizedHostOptions) {
    for (const artifact of options.admittedArtifacts) {
      const reference = artifactReference(artifact);
      this.evidence.set(referenceKey(reference), {
        reference,
        bytes: new TextEncoder().encode(canonicalArtifactJson(artifact)),
        producers: [],
      });
    }
  }

  public static async create(
    options: EditorialEvidenceHostOptionsV1,
  ): Promise<EditorialEvidenceHostV1> {
    const normalized = normalizeOptions(options);
    const host = new EditorialEvidenceHostV1(normalized);
    await normalized.store.initialize();
    await persistContentIndex(normalized.store, normalized.index);
    await normalized.store.putRecord(
      repositoryIndexLocator(
        normalized.index.repository.revision,
        normalized.index.repository.contentDigest,
      ),
      {
        schemaVersion: 1,
        kind: "docsfab-editorial-repository-index",
        repositoryRevision: normalized.index.repository.revision,
        repositoryContentDigest: normalized.index.repository.contentDigest,
        indexDigest: normalized.index.indexDigest,
      },
    );
    for (const source of normalized.sources) {
      await normalized.store.putRecord(recordLocator("source-bytes", source.source.sha256), {
        schemaVersion: 1,
        kind: "docsfab-editorial-source-bytes",
        bytesBase64: Buffer.from(source.bytes).toString("base64"),
      });
    }
    for (const artifact of normalized.admittedArtifacts) {
      await normalized.store.put(artifact, { index: normalized.index });
    }
    return host;
  }

  public async select(input: {
    workflow: WorkflowDefinition;
    record: Readonly<RunRecord>;
    proposal: unknown;
  }): Promise<WorkflowBranchSelectionEvidenceV1> {
    this.assertWorkflow(input.workflow, input.record);
    if (this.runId !== undefined) fail("conflicting-assessment");
    this.runId = input.record.id;
    this.record = structuredClone(input.record);
    const planner = producerFromRecord(
      input.record,
      "plan-documentation",
      this.options.workspaceSnapshotSha256,
      "accepted",
      null,
    );
    const proposal = validateEditorialDecisionProposalV1(input.proposal, {
      readerContextInput: this.options.readerContextInput,
      admittedReaderEvidence: this.options.sources.map(({ source }) => ({
        uri: source.uri,
        sha256: source.sha256,
      })),
      admittedEvidenceRefs: this.admittedReferences(),
    });
    this.readerContext = validateReaderContextV1(
      { ...this.options.readerContextInput, impact_basis: proposal.impactBasis },
      {
        admittedEvidence: this.options.sources.map(({ source }) => ({
          uri: source.uri,
          sha256: source.sha256,
        })),
      },
    );
    this.readerProvenance = this.createReaderProvenance(this.readerContext);
    this.readerTaskContext = this.options.projectCompletedReaderTaskContext({
      readerContext: this.readerContext,
      provenance: this.readerProvenance,
      admission: this.readerTaskContextAdmission(),
    });
    if (
      canonicalJson(this.readerTaskContext.readerContext) !== canonicalJson(this.readerContext) ||
      canonicalJson(this.readerTaskContext.provenance) !== canonicalJson(this.readerProvenance)
    ) {
      fail("identity-mismatch");
    }
    const bound = this.bindProposalEvidence(proposal, planner, input.record);
    const planBindingSha256 = plannerStep(input.record).planBinding!.digest;
    this.candidate = createEditorialDecisionCandidateFromProposalV1(proposal, {
      ...this.decodeContext(planner, input.record),
      workspaceSnapshotSha256: this.options.workspaceSnapshotSha256,
      planBindingSha256,
      policySha256: this.options.policy.sha256,
      comparison: this.options.comparison,
    });
    this.candidateReference = editorialDecisionReferenceV3(
      this.candidate,
      this.options.index.repository.contentDigest,
    );
    const candidateEvidence = {
      reference: this.candidateReference,
      bytes: new TextEncoder().encode(canonicalArtifactJson(this.candidate)),
      producers: [planner],
    };
    this.evidence.set(referenceKey(this.candidateReference), candidateEvidence);
    this.decisionContexts.set(this.candidateReference.digest, {
      payload: this.candidate,
      producer: planner,
    });
    await this.persistDecisionState(this.candidate, planner);
    await Promise.all(
      [...bound, this.candidateReference].map((reference) =>
        this.persistAssociation(
          input.record,
          reference,
          planner,
          this.candidate!.rationaleSha256,
          this.candidate!.limitations,
        ),
      ),
    );
    return {
      candidate: this.candidate.candidate,
      branchId:
        this.candidate.candidate === "update"
          ? "author"
          : this.candidate.candidate === "no-change"
            ? "assess-no-change"
            : null,
      workspaceSnapshotSha256: this.options.workspaceSnapshotSha256,
      candidateArtifact: this.candidateReference,
      readerTaskContext: this.readerTaskContext,
      readerContext: this.readerContext,
      readerContextProvenance: this.readerProvenance,
      editorialCandidate: {
        reference: this.candidateReference,
        proposal,
      },
    };
  }

  public async observeAssessment(input: {
    workflow: WorkflowDefinition;
    record: Readonly<RunRecord>;
    stepId: string;
    proposal: unknown;
  }): Promise<void> {
    this.assertWorkflow(input.workflow, input.record);
    const stepId = assessmentStepId(input.stepId);
    if (!this.candidateReference || !this.readerContext || !this.readerProvenance) {
      fail("evidence-unavailable");
    }
    if (this.assessments.has(stepId)) fail("conflicting-assessment");
    const decoded = decodeEditorialAssessmentProposalV1(input.proposal, this.admittedReferences());
    const proposal =
      stepId === AUDIENCE_STEP_ID && this.options.audienceProtocol === "not-supplied"
        ? hostDerivedAudienceAssessment(decoded)
        : decoded;
    this.record = structuredClone(input.record);
    const bytes = new TextEncoder().encode(proposal.rationale);
    const digest = sha256(bytes);
    const producer = producerFromRecord(
      input.record,
      stepId,
      this.options.workspaceSnapshotSha256,
      proposal.assessment,
      proposal.recommendation ? { ...proposal.recommendation, rationaleSha256: digest } : null,
    );
    for (const reference of proposal.evidenceRefs) {
      this.assertProducer(input.record, producer, reference);
      const entry = this.evidence.get(referenceKey(reference));
      if (!entry) fail("evidence-unavailable");
      if (entry.producers.some((candidate) => candidate.stepId === stepId)) {
        fail("conflicting-assessment");
      }
      entry.producers.push(producer);
    }
    this.rationales.set(rationaleKey(producer.stepId, digest), {
      bytes,
      boundReference: proposal.evidenceRefs[0]!,
      producer,
    });
    this.assessments.set(stepId, proposal);
    await this.persistRationale(digest, proposal.rationale);
    await Promise.all(
      proposal.evidenceRefs.map((reference) =>
        this.persistAssociation(input.record, reference, producer, digest, proposal.limitations),
      ),
    );
  }

  public async finalize(input: {
    workflow: WorkflowDefinition;
    record: Readonly<RunRecord>;
    selection: WorkflowBranchSelectionEvidenceV1;
    coverageSha256: string;
  }): Promise<EditorialDecisionArtifactReferenceV3> {
    this.assertWorkflow(input.workflow, input.record);
    if (
      !this.candidate ||
      !this.candidateReference ||
      !this.readerContext ||
      !this.readerProvenance ||
      input.selection.candidateArtifact?.digest !== this.candidateReference.digest ||
      input.selection.candidate !== this.candidate.candidate ||
      input.selection.workspaceSnapshotSha256 !== this.options.workspaceSnapshotSha256
    ) {
      fail("identity-mismatch");
    }
    const missing = ASSESSMENT_STEPS.filter((stepId) => !this.assessments.has(stepId));
    if (missing.length > 0) fail("evidence-unavailable");
    this.record = structuredClone(input.record);
    const evaluatorProposal = this.assessments.get("evaluate-document-quality")!;
    const evaluator = producerFromRecord(
      input.record,
      "evaluate-document-quality",
      this.options.workspaceSnapshotSha256,
      evaluatorProposal.assessment,
      evaluatorProposal.recommendation
        ? {
            ...evaluatorProposal.recommendation,
            rationaleSha256: sha256(new TextEncoder().encode(evaluatorProposal.rationale)),
          }
        : null,
    );
    const evaluatorRationaleSha256 = sha256(new TextEncoder().encode(evaluatorProposal.rationale));
    const evaluatorRationale = this.rationales.get(
      rationaleKey(evaluator.stepId, evaluatorRationaleSha256),
    );
    if (!evaluatorRationale || this.decisionRationales.has(evaluatorRationaleSha256)) {
      fail("conflicting-assessment");
    }
    this.decisionRationales.set(evaluatorRationaleSha256, evaluatorRationale);
    const evidenceRefs = uniqueReferences([
      this.candidateReference,
      ...ASSESSMENT_STEPS.flatMap((stepId) => this.assessments.get(stepId)!.evidenceRefs),
    ]);
    const rejectedAssessments = ASSESSMENT_STEPS.map(
      (stepId) => this.assessments.get(stepId)!,
    ).filter((proposal) => proposal.assessment === "rejected");
    const updateRecommendations = rejectedAssessments.filter(
      (proposal) => proposal.recommendation?.candidate === "update",
    );
    const supportingRecommendations =
      updateRecommendations.length > 0 ? updateRecommendations : rejectedAssessments;
    const finalCandidate =
      updateRecommendations.length > 0
        ? "update"
        : rejectedAssessments.length > 0
          ? "insufficient-evidence"
          : this.candidate.candidate;
    // A no-change changes no page, so the evaluator can find no quality to
    // judge. Its `not-applicable` confirms the no-change only as this label.
    const evaluatorNotApplicable =
      finalCandidate === "no-change" && evaluatorProposal.assessment === "not-applicable"
        ? [QUALITY_EVALUATION_NOT_APPLICABLE_LIMITATION]
        : [];
    const finalPayload = createEditorialDecisionPayloadV1(
      {
        phase: "validated",
        candidateArtifact: this.candidateReference,
        branchCoverage: {
          schemaVersion: 1,
          kind: "docsfab-workflow-branch-coverage-reference",
          coverageSha256: input.coverageSha256,
        },
        candidate: finalCandidate,
        repositoryRevision: this.options.index.repository.revision,
        workspaceSnapshotSha256: this.options.workspaceSnapshotSha256,
        readerProvenanceSha256: readerContextProvenanceSha256(this.readerProvenance),
        planBindingSha256: plannerStep(input.record).planBinding!.digest,
        policySha256: this.options.policy.sha256,
        comparison: this.options.comparison,
        rationaleSha256: evaluatorRationaleSha256,
        evidenceRefs,
        limitations:
          rejectedAssessments.length > 0
            ? limitations(
                supportingRecommendations.map(
                  (proposal) => proposal.recommendation?.code ?? fail("evidence-unavailable"),
                ),
              )
            : mergedLimitations([
                ...this.candidate.limitations,
                ...ASSESSMENT_STEPS.flatMap((stepId) => this.assessments.get(stepId)!.limitations),
                ...evaluatorNotApplicable,
              ]),
      },
      this.decodeContext(evaluator, input.record),
    );
    const reference = editorialDecisionReferenceV3(
      finalPayload,
      this.options.index.repository.contentDigest,
    );
    this.evidence.set(referenceKey(reference), {
      reference,
      bytes: new TextEncoder().encode(canonicalArtifactJson(finalPayload)),
      producers: [evaluator],
    });
    this.decisionContexts.set(reference.digest, { payload: finalPayload, producer: evaluator });
    await this.persistDecisionState(finalPayload, evaluator);
    return reference;
  }

  public decodeEditorialDecision(
    reference: EditorialDecisionArtifactReferenceV3,
    stepId: string,
  ): EditorialDecisionPayloadV1 {
    const normalized = validateArtifactReference(reference, {
      index: this.options.index,
      expectedKind: "editorial-decision",
    }) as EditorialDecisionArtifactReferenceV3;
    const retained = this.decisionContexts.get(normalized.digest);
    if (!retained || retained.producer.stepId !== stepId || !this.runId) {
      fail("evidence-unavailable");
    }
    return decodeEditorialDecisionPayloadV1(retained.payload, {
      ...this.decodeContext(retained.producer, this.record),
    });
  }

  private assertWorkflow(workflow: WorkflowDefinition, record: Readonly<RunRecord>): void {
    if (
      workflow.schemaVersion !== 2 ||
      workflow.name !== "update-documentation" ||
      record.workflow !== workflow.name ||
      record.repository.revision !== this.options.index.repository.revision
    ) {
      fail("identity-mismatch");
    }
  }

  private admittedReferences(): ArtifactReference[] {
    return [...this.evidence.values()]
      .map(({ reference }) => reference)
      .filter((reference) => reference.kind !== "editorial-decision");
  }

  private createReaderProvenance(readerContext: ReaderContextV1): ReaderContextProvenanceV1 {
    const candidate: ReaderContextProvenanceV1 = {
      schema_version: 1,
      reader_context_sha256: readerContextSha256(readerContext),
      baseline_sha256: this.options.baselineSha256,
      admitted_revision: this.options.index.repository.revision,
      workspace_snapshot_sha256: this.options.workspaceSnapshotSha256,
      repository_identity_sha256: this.options.repositoryIdentitySha256,
      policy: this.options.policy,
      comparison: this.options.comparison,
      sources: this.options.sources.map(({ source }) => source),
      observed_at: this.options.observedAt,
      limitations: [...this.options.provenanceLimitations],
    };
    return validateReaderContextProvenanceV1(candidate, {
      readerContextSha256: candidate.reader_context_sha256,
      baselineSha256: this.options.baselineSha256,
      admittedRevision: this.options.index.repository.revision,
      workspaceSnapshotSha256: this.options.workspaceSnapshotSha256,
      repositoryIdentitySha256: this.options.repositoryIdentitySha256,
      policy: this.options.policy,
      admittedSources: candidate.sources,
    });
  }

  private readerTaskContextAdmission(): ReaderTaskContextAdmissionV1 {
    return {
      admittedRevision: this.options.index.repository.revision,
      workspaceSnapshotSha256: this.options.workspaceSnapshotSha256,
      repositoryIdentitySha256: this.options.repositoryIdentitySha256,
      comparison: this.options.comparison,
      sources: this.options.sources.map(({ source }) => source),
      provenanceLimitations: [...this.options.provenanceLimitations],
    };
  }

  private bindProposalEvidence(
    proposal: EditorialDecisionProposalV1,
    producer: EditorialDecisionProducerProvenanceV1,
    record: Readonly<RunRecord>,
  ): ArtifactReference[] {
    for (const reference of proposal.evidenceRefs) {
      this.assertProducer(record, producer, reference);
      const evidence = this.evidence.get(referenceKey(reference));
      if (!evidence) fail("evidence-unavailable");
      evidence.producers.push(producer);
    }
    const bytes = new TextEncoder().encode(proposal.rationale);
    const digest = sha256(bytes);
    this.rationales.set(rationaleKey(producer.stepId, digest), {
      bytes,
      boundReference: proposal.evidenceRefs[0]!,
      producer,
    });
    if (this.decisionRationales.has(digest)) fail("conflicting-assessment");
    this.decisionRationales.set(
      digest,
      this.rationales.get(rationaleKey(producer.stepId, digest))!,
    );
    return proposal.evidenceRefs;
  }

  private decodeContext(
    producer: EditorialDecisionProducerProvenanceV1,
    record: Readonly<RunRecord> | undefined,
  ) {
    if (!this.readerContext || !this.readerProvenance) fail("evidence-unavailable");
    return {
      repositoryRevision: this.options.index.repository.revision,
      repositoryContentDigest: this.options.index.repository.contentDigest,
      resolver: {
        resolve: (reference: ArtifactReference) => {
          const resolved = this.evidence.get(referenceKey(reference));
          if (!resolved) fail("evidence-unavailable");
          return resolved;
        },
        resolveRationale: (digest: string) => {
          const resolved = this.decisionRationales.get(digest);
          if (!resolved) fail("evidence-unavailable");
          return resolved;
        },
      },
      evidenceValidator: {
        validate: (reference: ArtifactReference, bytes: Uint8Array) => {
          const artifact = validateArtifact(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
            {
              index: this.options.index,
            },
          );
          if (referenceKey(artifactReference(artifact)) !== referenceKey(reference)) {
            fail("identity-mismatch");
          }
        },
      },
      producerValidator: {
        validate: (
          candidate: EditorialDecisionProducerProvenanceV1,
          bound: ArtifactReference | null,
        ) => this.assertProducer(record, candidate, bound),
      },
      producer,
      ...retainedPlanContext(record),
      readerContext: this.readerContext,
      readerContextValidation: {
        admittedEvidence: this.options.sources.map(({ source }) => ({
          uri: source.uri,
          sha256: source.sha256,
        })),
      },
      readerProvenance: this.readerProvenance,
      readerProvenanceValidation: {
        readerContextSha256: readerContextSha256(this.readerContext),
        baselineSha256: this.options.baselineSha256,
        admittedRevision: this.options.index.repository.revision,
        workspaceSnapshotSha256: this.options.workspaceSnapshotSha256,
        repositoryIdentitySha256: this.options.repositoryIdentitySha256,
        policy: this.options.policy,
        admittedSources: this.options.sources.map(({ source }) => source),
      },
    };
  }

  private assertProducer(
    record: Readonly<RunRecord> | undefined,
    producer: EditorialDecisionProducerProvenanceV1,
    boundReference: ArtifactReference | null,
  ): void {
    if (!record) fail("producer-mismatch");
    if (record.id !== this.runId && this.runId !== undefined) fail("producer-mismatch");
    const matches = record.steps.filter((step) => step.id === producer.stepId);
    if (matches.length !== 1 || !matchesProducer(matches[0]!, producer)) {
      fail("producer-mismatch");
    }
    if (producer.stepId !== "plan-documentation") {
      const proposal = this.assessments.get(producer.stepId);
      if (proposal) {
        const digest = sha256(new TextEncoder().encode(proposal.rationale));
        const expected = producerFromRecord(
          record,
          producer.stepId,
          this.options.workspaceSnapshotSha256,
          proposal.assessment,
          proposal.recommendation ? { ...proposal.recommendation, rationaleSha256: digest } : null,
        );
        if (canonicalJson(expected) !== canonicalJson(producer)) fail("producer-mismatch");
      }
    }
    if (
      boundReference &&
      !(matches[0]!.artifacts ?? []).some(
        (use) => referenceKey(use.reference) === referenceKey(boundReference),
      )
    ) {
      fail("producer-mismatch");
    }
  }

  private async persistDecisionState(
    decision: EditorialDecisionPayloadV1,
    producer: EditorialDecisionProducerProvenanceV1,
  ): Promise<void> {
    await this.options.store.putRecord(
      recordLocator("editorial-decision", decision.decisionSha256),
      decision,
    );
    await this.options.store.putRecord(
      recordLocator("reader-context", readerContextSha256(this.readerContext!)),
      this.readerContext!,
    );
    await this.options.store.putRecord(
      recordLocator("reader-provenance", decision.readerProvenanceSha256),
      this.readerProvenance!,
    );
    const retained = this.rationales.get(rationaleKey(producer.stepId, decision.rationaleSha256));
    if (!retained) fail("evidence-unavailable");
    await this.persistRationale(decision.rationaleSha256, new TextDecoder().decode(retained.bytes));
  }

  private async persistRationale(digest: string, text: string): Promise<void> {
    await this.options.store.putRecord(recordLocator("editorial-rationale", digest), {
      schemaVersion: 1,
      kind: "docsfab-editorial-rationale",
      text,
    });
  }

  private async persistAssociation(
    record: Readonly<RunRecord>,
    reference: ArtifactReference,
    producer: EditorialDecisionProducerProvenanceV1,
    rationaleSha256: string,
    limitations: readonly string[],
  ): Promise<void> {
    const locator = associationLocator(record.id, producer.stepId, reference);
    await this.options.store.putRecord(locator, {
      schemaVersion: 1,
      kind: "docsfab-editorial-evidence-association",
      runId: record.id,
      boundReference: reference,
      producer,
      rationaleSha256,
      limitations: [...limitations],
    });
  }
}

/** Initialize the genuine-byte production adapter before the V2 runner starts. */
export async function createEditorialEvidenceHostV1(
  options: EditorialEvidenceHostOptionsV1,
): Promise<EditorialEvidenceHostV1> {
  return EditorialEvidenceHostV1.create(options);
}

/**
 * Rebuild the synchronous editorial decoder from durable bytes and an independently re-observed
 * admission. Every source, artifact, rationale, and step association is checked before return.
 */
export async function loadEditorialEvidenceDecodeOptionsV1(
  input: EditorialEvidenceReplayOptionsV1,
): Promise<EditorialEvidenceDecodeOptionsV1> {
  const installedBaselineSha256 = kit.hash(input.baselineSha256);
  const admission = normalizeReplayAdmission(input.admission);
  const policy = normalizePolicy(input.policy);
  const uses = (input.record.artifacts ?? []).filter(
    (use) => use.role === "output" && use.reference.kind === "editorial-decision",
  );
  const references = uses.map(
    (use) =>
      validateArtifactReference(use.reference, {
        expectedKind: "editorial-decision",
      }) as EditorialDecisionArtifactReferenceV3,
  );
  kit.unique(references.map(referenceKey));
  const decisionValues = new Map<string, unknown>();
  for (const reference of references) {
    decisionValues.set(
      referenceKey(reference),
      await input.store.getRecord(recordLocator("editorial-decision", reference.digest)),
    );
  }
  if (references.length === 0) {
    return {
      decodeEditorialDecision: () => fail("evidence-unavailable"),
    };
  }
  const repositoryIdentity = references[0]!;
  if (
    references.some(
      (reference) =>
        reference.repositoryRevision !== repositoryIdentity.repositoryRevision ||
        reference.repositoryContentDigest !== repositoryIdentity.repositoryContentDigest,
    ) ||
    repositoryIdentity.repositoryRevision !== input.record.repository.revision ||
    admission.admittedRevision !== input.record.repository.revision
  ) {
    fail("identity-mismatch");
  }
  const indexBinding = decodeRepositoryIndexBinding(
    await input.store.getRecord(
      repositoryIndexLocator(
        repositoryIdentity.repositoryRevision,
        repositoryIdentity.repositoryContentDigest,
      ),
    ),
  );
  const index = await loadContentIndex(input.store, indexBinding.indexDigest);
  if (
    index.repository.revision !== repositoryIdentity.repositoryRevision ||
    index.repository.contentDigest !== repositoryIdentity.repositoryContentDigest
  ) {
    fail("identity-mismatch");
  }

  const decisionHints = [...decisionValues.entries()].map(
    ([key, value]) => [key, decodeDecisionReplayHint(value)] as const,
  );
  const provenanceDigests = [
    ...new Set(decisionHints.map(([, hint]) => hint.readerProvenanceSha256)),
  ];
  if (provenanceDigests.length !== 1) fail("identity-mismatch");
  const readerProvenanceValue = await input.store.getRecord(
    recordLocator("reader-provenance", provenanceDigests[0]!),
  );
  const provenanceRoot = kit.object(readerProvenanceValue);
  // A run recorded under a superseded locked baseline replays against the
  // baseline it retained; new runs always read the installed one.
  const baselineSha256 = kit.hash(provenanceRoot.baseline_sha256);
  if (
    baselineSha256 !== installedBaselineSha256 &&
    !SUPERSEDED_READER_IMPACT_BASELINE_SHA256S.includes(baselineSha256)
  ) {
    fail("identity-mismatch");
  }
  const readerContextDigest = kit.hash(provenanceRoot.reader_context_sha256);
  const readerContext = validateReaderContextV1(
    await input.store.getRecord(recordLocator("reader-context", readerContextDigest)),
    {
      admittedEvidence: admission.sources.map(({ uri, sha256 }) => ({ uri, sha256 })),
    },
  );
  const readerProvenance = validateReaderContextProvenanceV1(readerProvenanceValue, {
    readerContextSha256: readerContextSha256(readerContext),
    baselineSha256,
    admittedRevision: admission.admittedRevision,
    workspaceSnapshotSha256: admission.workspaceSnapshotSha256,
    repositoryIdentitySha256: admission.repositoryIdentitySha256,
    policy,
    admittedSources: admission.sources,
  });
  if (
    readerContextDigest !== readerContextSha256(readerContext) ||
    provenanceDigests[0] !== readerContextProvenanceSha256(readerProvenance) ||
    canonicalJson(readerProvenance.comparison) !== canonicalJson(admission.comparison)
  ) {
    fail("identity-mismatch");
  }
  await validateRetainedSourceBytes(input.store, admission.sources);

  const allReferences = uniqueReferences([
    ...references,
    ...decisionHints.flatMap(([, hint]) => hint.evidenceRefs),
  ]);
  const evidence = new Map<string, ResolvedEditorialDecisionEvidenceV1>();
  for (const reference of allReferences) {
    const bytes = await resolveReplayEvidenceBytes(input.store, reference, index, decisionValues);
    const producers: EditorialDecisionProducerProvenanceV1[] = [];
    for (const stepId of ["plan-documentation", ...ASSESSMENT_STEPS] as const) {
      const association = await loadAssociationIfPresent(
        input.store,
        input.record.id,
        stepId,
        reference,
      );
      if (!association) continue;
      assertReplayProducer(input.record, association.producer, reference, admission);
      producers.push(association.producer);
    }
    evidence.set(referenceKey(reference), { reference, bytes, producers });
  }

  const rationales = new Map<string, ResolvedEditorialDecisionRationaleV1>();
  const decisionProducers = new Map<string, EditorialDecisionProducerProvenanceV1>();
  for (const [key, hint] of decisionHints) {
    const producerStep =
      hint.phase === "candidate" ? "plan-documentation" : "evaluate-document-quality";
    const matches: ReplayAssociation[] = [];
    for (const reference of hint.evidenceRefs) {
      const association = await loadAssociationIfPresent(
        input.store,
        input.record.id,
        producerStep,
        reference,
      );
      if (association?.rationaleSha256 === hint.rationaleSha256) matches.push(association);
    }
    const byProducer = new Map(
      matches.map((association) => [canonicalJson(association.producer), association]),
    );
    if (byProducer.size !== 1 || rationales.has(hint.rationaleSha256)) {
      fail("evidence-unavailable");
    }
    const association = [...byProducer.values()][0]!;
    const rationaleBytes = await loadRationaleBytes(input.store, hint.rationaleSha256);
    rationales.set(hint.rationaleSha256, {
      bytes: rationaleBytes,
      boundReference: association.boundReference,
      producer: association.producer,
    });
    decisionProducers.set(key, association.producer);
  }

  const decoded = new Map<
    string,
    { payload: EditorialDecisionPayloadV1; producer: EditorialDecisionProducerProvenanceV1 }
  >();
  for (const [key, hint] of decisionHints) {
    const reference = references.find((candidate) => referenceKey(candidate) === key)!;
    const producer = decisionProducers.get(key) ?? fail("evidence-unavailable");
    const payload = decodeEditorialDecisionPayloadV1(decisionValues.get(key), {
      repositoryRevision: index.repository.revision,
      repositoryContentDigest: index.repository.contentDigest,
      resolver: {
        resolve: (candidate) =>
          evidence.get(referenceKey(candidate)) ?? fail("evidence-unavailable"),
        resolveRationale: (digest) => rationales.get(digest) ?? fail("evidence-unavailable"),
      },
      evidenceValidator: {
        validate: (candidate, bytes) => validateReplayArtifact(candidate, bytes, index),
      },
      producerValidator: {
        validate: (candidate, bound) =>
          assertReplayProducer(input.record, candidate, bound, admission),
      },
      producer,
      ...retainedPlanContext(input.record),
      readerContext,
      readerContextValidation: {
        admittedEvidence: admission.sources.map(({ uri, sha256 }) => ({ uri, sha256 })),
      },
      readerProvenance,
      readerProvenanceValidation: {
        readerContextSha256: readerContextSha256(readerContext),
        baselineSha256,
        admittedRevision: admission.admittedRevision,
        workspaceSnapshotSha256: admission.workspaceSnapshotSha256,
        repositoryIdentitySha256: admission.repositoryIdentitySha256,
        policy,
        admittedSources: admission.sources,
      },
    });
    if (
      payload.decisionSha256 !== reference.digest ||
      payload.planBindingSha256 !== plannerStep(input.record).planBinding!.digest
    ) {
      fail("identity-mismatch");
    }
    decoded.set(key, { payload, producer });
  }
  return {
    decodeEditorialDecision(reference, stepId) {
      const normalized = validateArtifactReference(reference, {
        index,
        expectedKind: "editorial-decision",
      }) as EditorialDecisionArtifactReferenceV3;
      const retained = decoded.get(referenceKey(normalized));
      if (!retained || retained.producer.stepId !== stepId) fail("evidence-unavailable");
      return retained.payload;
    },
  };
}

/** Rebuild replay inputs from retained provenance, checked against installed locked policy. */
export async function loadEditorialEvidenceDecodeOptionsFromStoreV1(
  input: EditorialEvidenceColdReplayOptionsV1,
): Promise<EditorialEvidenceDecodeOptionsV1> {
  await input.store.initialize();
  const first = (input.record.artifacts ?? []).find(
    (use) => use.role === "output" && use.reference.kind === "editorial-decision",
  );
  if (!first) fail("evidence-unavailable");
  const reference = validateArtifactReference(first.reference, {
    expectedKind: "editorial-decision",
  }) as EditorialDecisionArtifactReferenceV3;
  const decision = decodeDecisionReplayHint(
    await input.store.getRecord(recordLocator("editorial-decision", reference.digest)),
  );
  const retainedProvenance = kit.object(
    await input.store.getRecord(
      recordLocator("reader-provenance", decision.readerProvenanceSha256),
    ),
  );
  const admission = normalizeReplayAdmission({
    admittedRevision: retainedProvenance.admitted_revision,
    workspaceSnapshotSha256: retainedProvenance.workspace_snapshot_sha256,
    repositoryIdentitySha256: retainedProvenance.repository_identity_sha256,
    comparison: retainedProvenance.comparison,
    sources: retainedProvenance.sources,
    provenanceLimitations: retainedProvenance.limitations,
  } as ReaderTaskContextAdmissionV1);
  return loadEditorialEvidenceDecodeOptionsV1({
    store: input.store,
    record: input.record,
    baselineSha256: input.baselineSha256,
    policy: input.policy,
    admission,
  });
}

interface NormalizedHostOptions
  extends Omit<EditorialEvidenceHostOptionsV1, "sources" | "admittedArtifacts"> {
  sources: EditorialEvidenceSourceBytesV1[];
  admittedArtifacts: Artifact[];
}

function normalizeOptions(options: EditorialEvidenceHostOptionsV1): NormalizedHostOptions {
  kit.assertInert(options.readerContextInput);
  const index = decodeContentIndexV1(options.index);
  const readerContextInput = validateReaderContextInputV1(options.readerContextInput);
  const baselineSha256 = kit.hash(options.baselineSha256);
  const repositoryIdentitySha256 = kit.hash(options.repositoryIdentitySha256);
  const workspaceSnapshotSha256 = kit.hash(options.workspaceSnapshotSha256);
  const policy = {
    id: kit.identifier(options.policy.id),
    version: kit.identifier(options.policy.version),
    sha256: kit.hash(options.policy.sha256),
  };
  const comparison = structuredClone(options.comparison);
  const provenanceLimitations = limitations(options.provenanceLimitations);
  const sources = options.sources.map((value) => {
    const bytes = Uint8Array.from(value.bytes);
    // An empty tracked file, such as an empty instruction file or page, is
    // admitted evidence: its digest binds the emptiness.
    if (bytes.byteLength > MAX_SOURCE_BYTES) fail("invalid-value");
    if (sha256(bytes) !== value.source.sha256) fail("identity-mismatch");
    // Only a configured credential stops evidence (#1807); a credential shape
    // in repository content is a finding, not a refusal.
    if (containsConfiguredCredential(Buffer.from(bytes).toString("utf8"))) {
      fail("credential-material");
    }
    return { source: structuredClone(value.source), bytes };
  });
  if (sources.length < 1 || sources.length > 128) fail("invalid-value");
  kit.unique(sources.map(({ source }) => canonicalJson(source)));
  const admittedArtifacts = options.admittedArtifacts.map((artifact) =>
    validateArtifact(artifact, { index }),
  );
  if (admittedArtifacts.length < 1 || admittedArtifacts.length > 128) fail("invalid-value");
  kit.unique(admittedArtifacts.map((artifact) => artifact.digest));
  if (typeof options.projectCompletedReaderTaskContext !== "function") fail("invalid-value");
  return {
    store: options.store,
    index,
    readerContextInput,
    baselineSha256,
    policy,
    comparison,
    repositoryIdentitySha256,
    workspaceSnapshotSha256,
    observedAt: kit.timestamp(options.observedAt),
    provenanceLimitations,
    sources,
    admittedArtifacts,
    audienceProtocol: kit.enumeration(options.audienceProtocol, ["supplied", "not-supplied"]),
    projectCompletedReaderTaskContext: options.projectCompletedReaderTaskContext,
  };
}

function producerFromRecord(
  record: Readonly<RunRecord>,
  stepId: EditorialDecisionProducerProvenanceV1["stepId"],
  workspaceSnapshotSha256: string,
  assessment: EditorialDecisionProducerProvenanceV1["assessment"],
  recommendation: EditorialDecisionProducerProvenanceV1["recommendation"],
): EditorialDecisionProducerProvenanceV1 {
  const matches = record.steps.filter((step) => step.id === stepId);
  if (matches.length !== 1) fail("producer-mismatch");
  const step = matches[0]!;
  if (step.skill !== stepId || step.mode !== "read-only" || step.status !== "succeeded") {
    fail("producer-mismatch");
  }
  return {
    stepId,
    skill: step.skill,
    mode: "read-only",
    status: "succeeded",
    repositoryRevision: record.repository.revision,
    workspaceSnapshotSha256,
    assessment,
    recommendation,
  };
}

function matchesProducer(
  step: Readonly<StepRunRecord>,
  producer: EditorialDecisionProducerProvenanceV1,
): boolean {
  return (
    step.id === producer.stepId &&
    step.skill === producer.skill &&
    step.mode === producer.mode &&
    step.status === producer.status
  );
}

/**
 * The page dispositions of the run's admitted update plan, re-validated from
 * its sealed binding so a tampered record cannot claim kept pages. Without one
 * admitted plan, no retained-plan no-change basis exists.
 */
function retainedPlanContext(record: Readonly<RunRecord> | undefined): {
  retainedPlan?: EditorialDecisionRetainedPlanV1;
} {
  const planners = (record?.steps ?? []).filter((step) => step.id === "plan-documentation");
  if (planners.length !== 1 || !planners[0]!.planBinding) return {};
  let binding;
  try {
    binding = validateAdmittedDocumentationPlanBinding(planners[0]!.planBinding, {
      expectedMode: "update",
    });
  } catch {
    return {};
  }
  return {
    retainedPlan: {
      planBindingSha256: binding.digest,
      writePaths: documentationPlanWritePaths(binding),
      retainedPaths: binding.pages
        .filter((page) => page.disposition === "retain")
        .map((page) => page.path),
    },
  };
}

function plannerStep(record: Readonly<RunRecord>): Readonly<StepRunRecord> {
  const matches = record.steps.filter((step) => step.id === "plan-documentation");
  if (matches.length !== 1 || !matches[0]!.planBinding) fail("producer-mismatch");
  return matches[0]!;
}

function assessmentStepId(value: string): EditorialAssessmentStepIdV1 {
  return kit.enumeration(value, ASSESSMENT_STEPS);
}

function artifactReference(artifact: Artifact): ArtifactReference {
  return {
    kind: artifact.kind,
    schemaVersion: 1,
    digest: artifact.digest,
    repositoryRevision: artifact.repository.revision,
    repositoryContentDigest: artifact.repository.contentDigest,
  };
}

function referenceKey(reference: ArtifactReference): string {
  return canonicalArtifactJson(validateArtifactReference(reference));
}

function uniqueReferences(references: readonly ArtifactReference[]): ArtifactReference[] {
  const byKey = new Map(references.map((reference) => [referenceKey(reference), reference]));
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, reference]) => reference);
}

function rationale(value: unknown): string {
  const text = kit.string(value);
  if (
    text !== text.normalize("NFC") ||
    text.includes("\r") ||
    text.includes("\0") ||
    [...text].length < 16 ||
    [...text].length > MAX_RATIONALE_CHARACTERS
  ) {
    fail("invalid-value");
  }
  return text;
}

function limitations(value: unknown): string[];
function limitations(value: readonly string[]): string[];
function limitations(value: unknown | readonly string[]): string[] {
  const result = kit.array(value).map((entry) => kit.string(entry));
  if (result.length > 32 || result.some((entry) => !SAFE_LIMITATION.test(entry))) {
    fail("invalid-value");
  }
  return [...new Set(result)].sort();
}

/**
 * The distinct codes of lists that were each bounded where they were
 * admitted, sorted. Assessors may repeat each other's codes, and the merge
 * adds no count bound of its own.
 */
function mergedLimitations(values: readonly string[]): string[] {
  if (values.some((entry) => !SAFE_LIMITATION.test(entry))) fail("invalid-value");
  return [...new Set(values)].sort();
}

function rationaleKey(stepId: string, digest: string): string {
  return `${stepId}\0${digest}`;
}

interface DecisionReplayHint {
  phase: "candidate" | "validated";
  readerProvenanceSha256: string;
  rationaleSha256: string;
  evidenceRefs: ArtifactReference[];
}

interface ReplayAssociation {
  boundReference: ArtifactReference;
  producer: EditorialDecisionProducerProvenanceV1;
  rationaleSha256: string;
}

function normalizeReplayAdmission(
  value: ReaderTaskContextAdmissionV1,
): ReaderTaskContextAdmissionV1 {
  kit.assertInert(value);
  const root = kit.object(value);
  kit.exact(root, [
    "admittedRevision",
    "workspaceSnapshotSha256",
    "repositoryIdentitySha256",
    "comparison",
    "sources",
    "provenanceLimitations",
  ]);
  const sources = kit.array(root.sources).map((candidate) => {
    const source = kit.object(candidate);
    kit.exact(source, ["uri", "role", "sha256"]);
    return {
      uri: replaySourceUri(source.uri),
      role: kit.enumeration(source.role, SOURCE_ROLES),
      sha256: kit.hash(source.sha256),
    };
  });
  if (sources.length < 1 || sources.length > 128) fail("invalid-value");
  kit.unique(sources.map((source) => canonicalJson(source)));
  return {
    admittedRevision: kit.revision(root.admittedRevision),
    workspaceSnapshotSha256: kit.hash(root.workspaceSnapshotSha256),
    repositoryIdentitySha256: kit.hash(root.repositoryIdentitySha256),
    comparison: validateReaderContextComparisonV1(root.comparison),
    sources,
    provenanceLimitations: limitations(root.provenanceLimitations),
  };
}

function normalizePolicy(value: ReaderContextPolicyIdentityV1): ReaderContextPolicyIdentityV1 {
  kit.assertInert(value);
  const root = kit.object(value);
  kit.exact(root, ["id", "version", "sha256"]);
  return {
    id: kit.identifier(root.id),
    version: kit.identifier(root.version),
    sha256: kit.hash(root.sha256),
  };
}

function decodeRepositoryIndexBinding(value: unknown): {
  repositoryRevision: string;
  repositoryContentDigest: string;
  indexDigest: string;
} {
  kit.assertInert(value);
  const root = kit.object(value);
  kit.exact(root, [
    "schemaVersion",
    "kind",
    "repositoryRevision",
    "repositoryContentDigest",
    "indexDigest",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-editorial-repository-index") {
    fail("invalid-shape");
  }
  return {
    repositoryRevision: kit.revision(root.repositoryRevision),
    repositoryContentDigest: kit.hash(root.repositoryContentDigest),
    indexDigest: kit.hash(root.indexDigest),
  };
}

function decodeDecisionReplayHint(value: unknown): DecisionReplayHint {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, [
    "schemaVersion",
    "kind",
    "phase",
    "candidateArtifact",
    "branchCoverage",
    "candidate",
    "repositoryRevision",
    "workspaceSnapshotSha256",
    "readerProvenanceSha256",
    "planBindingSha256",
    "policySha256",
    "comparison",
    "rationaleSha256",
    "evidenceRefs",
    "limitations",
    "decisionSha256",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-editorial-decision") {
    fail("invalid-shape");
  }
  const evidenceRefs = kit
    .array(root.evidenceRefs)
    .map((reference) => validateArtifactReference(reference));
  if (evidenceRefs.length < 1 || evidenceRefs.length > 128) fail("invalid-value");
  kit.unique(evidenceRefs.map(referenceKey));
  return {
    phase: kit.enumeration(root.phase, ["candidate", "validated"]),
    readerProvenanceSha256: kit.hash(root.readerProvenanceSha256),
    rationaleSha256: kit.hash(root.rationaleSha256),
    evidenceRefs,
  };
}

async function validateRetainedSourceBytes(
  store: DurableArtifactStore,
  sources: readonly ReaderContextProvenanceSourceV1[],
): Promise<void> {
  for (const source of sources) {
    const value = await store.getRecord(recordLocator("source-bytes", source.sha256));
    // This flat byte envelope uses the admission byte limit, not the generic
    // 64 KiB text-field limit. Strict object/exact checks still reject active values.
    const root = kit.object(value);
    kit.exact(root, ["schemaVersion", "kind", "bytesBase64"]);
    if (root.schemaVersion !== 1 || root.kind !== "docsfab-editorial-source-bytes") {
      fail("invalid-shape");
    }
    const encoded = kit.string(root.bytesBase64);
    if (encoded.length > Math.ceil(MAX_SOURCE_BYTES / 3) * 4) fail("evidence-unavailable");
    const bytes = Buffer.from(encoded, "base64");
    if (
      bytes.byteLength > MAX_SOURCE_BYTES ||
      bytes.toString("base64") !== encoded ||
      sha256(bytes) !== source.sha256 ||
      containsConfiguredCredential(bytes.toString("utf8"))
    ) {
      fail("evidence-unavailable");
    }
  }
}

async function resolveReplayEvidenceBytes(
  store: DurableArtifactStore,
  reference: ArtifactReference,
  index: ContentIndexV1,
  decisions: ReadonlyMap<string, unknown>,
): Promise<Uint8Array> {
  if (reference.kind === "editorial-decision") {
    const value =
      decisions.get(referenceKey(reference)) ??
      (await store.getRecord(recordLocator("editorial-decision", reference.digest)));
    return new TextEncoder().encode(canonicalArtifactJson(value));
  }
  const artifact = await store.get(reference.digest, { index });
  if (referenceKey(artifactReference(artifact)) !== referenceKey(reference)) {
    fail("identity-mismatch");
  }
  return new TextEncoder().encode(canonicalArtifactJson(artifact));
}

async function loadAssociationIfPresent(
  store: DurableArtifactStore,
  runId: string,
  stepId: string,
  reference: ArtifactReference,
): Promise<ReplayAssociation | undefined> {
  let value: unknown;
  try {
    value = await store.getRecord(associationLocator(runId, stepId, reference));
  } catch (error) {
    if (error instanceof ArtifactStoreError && error.code === "not-found") return undefined;
    throw error;
  }
  kit.assertInert(value);
  const root = kit.object(value);
  kit.exact(root, [
    "schemaVersion",
    "kind",
    "runId",
    "boundReference",
    "producer",
    "rationaleSha256",
    "limitations",
  ]);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-editorial-evidence-association" ||
    root.runId !== runId
  ) {
    fail("invalid-shape");
  }
  const boundReference = validateArtifactReference(root.boundReference);
  if (referenceKey(boundReference) !== referenceKey(reference)) fail("identity-mismatch");
  limitations(root.limitations);
  const producer = decodeEditorialDecisionProducerV1(root.producer);
  const rationaleSha256 = kit.hash(root.rationaleSha256);
  if (producer.recommendation && producer.recommendation.rationaleSha256 !== rationaleSha256) {
    fail("identity-mismatch");
  }
  await loadRationaleBytes(store, rationaleSha256);
  return {
    boundReference,
    producer,
    rationaleSha256,
  };
}

async function loadRationaleBytes(
  store: DurableArtifactStore,
  digest: string,
): Promise<Uint8Array> {
  const value = await store.getRecord(recordLocator("editorial-rationale", digest));
  kit.assertInert(value);
  const root = kit.object(value);
  kit.exact(root, ["schemaVersion", "kind", "text"]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-editorial-rationale") {
    fail("invalid-shape");
  }
  const text = rationale(root.text);
  const bytes = new TextEncoder().encode(text);
  if (sha256(bytes) !== digest) fail("identity-mismatch");
  return bytes;
}

function assertReplayProducer(
  record: Readonly<RunRecord>,
  producerValue: EditorialDecisionProducerProvenanceV1,
  boundReference: ArtifactReference | null,
  admission: ReaderTaskContextAdmissionV1,
): void {
  const producer = decodeEditorialDecisionProducerV1(producerValue);
  if (
    producer.repositoryRevision !== record.repository.revision ||
    producer.workspaceSnapshotSha256 !== admission.workspaceSnapshotSha256
  ) {
    fail("producer-mismatch");
  }
  const matches = record.steps.filter((step) => step.id === producer.stepId);
  if (matches.length !== 1 || !matchesProducer(matches[0]!, producer)) {
    fail("producer-mismatch");
  }
  if (
    boundReference &&
    !(matches[0]!.artifacts ?? []).some(
      (use) => referenceKey(use.reference) === referenceKey(boundReference),
    )
  ) {
    fail("producer-mismatch");
  }
}

function validateReplayArtifact(
  reference: ArtifactReference,
  bytes: Uint8Array,
  index: ContentIndexV1,
): void {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("evidence-unavailable");
  }
  const artifact = validateArtifact(value, { index });
  if (referenceKey(artifactReference(artifact)) !== referenceKey(reference)) {
    fail("identity-mismatch");
  }
}

function replaySourceUri(value: unknown): string {
  const uri = kit.string(value);
  if (
    uri.length < 1 ||
    uri.length > 4_096 ||
    uri !== uri.normalize("NFC") ||
    uri.includes("\0") ||
    uri.includes("\\") ||
    uri.startsWith("/") ||
    /^[A-Za-z]:/u.test(uri) ||
    uri.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    fail("invalid-value");
  }
  return uri;
}
