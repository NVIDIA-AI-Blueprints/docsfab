// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import {
  readerContextProvenanceSha256,
  readerContextSha256,
  READER_CONTEXT_CHANGED_SOURCE_INAPPLICABLE_LIMITATION,
  validateReaderContextComparisonV1,
  validateReaderContextProvenanceV1,
  validateReaderContextV1,
  type ReaderContextComparisonV1,
  type ReaderContextEvidenceReferenceV1,
  type ReaderContextImpactKindV1,
  type ReaderContextInputV1,
  type ReaderContextProvenanceV1,
  type ReaderContextProvenanceValidationOptions,
  type ReaderContextV1,
  type ReaderContextValidationOptions,
} from "../context/reader-context.js";
import {
  ARTIFACT_REFERENCE_KINDS,
  EDITORIAL_DECISION_CANDIDATES,
  type ArtifactReference,
  type EditorialDecisionArtifactResolverV1,
  type EditorialDecisionArtifactReferenceV3,
  type EditorialDecisionCandidateV1,
  type EditorialDecisionEvidenceValidatorV1,
  type EditorialDecisionPayloadV1,
  type EditorialDecisionProducerProvenanceV1,
  type EditorialDecisionProducerValidatorV1,
  type EditorialDecisionProposalV1,
} from "./contracts.js";
import { canonicalArtifactJson } from "./canonical.js";
import { sha256 } from "../content-ir/canonical.js";

export type EditorialDecisionValidationErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "credential-material"
  | "digest-mismatch"
  | "evidence-unavailable"
  | "producer-mismatch"
  | "identity-mismatch"
  | "independent-rejection";

export class EditorialDecisionValidationError extends Error {
  /**
   * The `$`-rooted decision member the refusing rule read, such as
   * `$.evidenceRefs[].producers[].assessment`; `$` when the rule names none.
   * Non-enumerable, so the error's identity stays its code.
   */
  public declare readonly location: string;

  public constructor(
    public readonly code: EditorialDecisionValidationErrorCode,
    location = "$",
  ) {
    super(`Editorial decision rejected: ${code}.`);
    this.name = "EditorialDecisionValidationError";
    Object.defineProperty(this, "location", {
      value: location,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
}

function fail(code: EditorialDecisionValidationErrorCode, location?: string): never {
  throw new EditorialDecisionValidationError(code, location);
}

const kit = createContractKit<EditorialDecisionValidationErrorCode>({
  fail: fail as ContractFail<EditorialDecisionValidationErrorCode>,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "invalid-shape",
  },
});

const BODY_KEYS = [
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
] as const;
const PRODUCER_STEPS = [
  "plan-documentation",
  "verify-technical-accuracy",
  "review-documentation",
  "test-audience-understanding",
  "evaluate-document-quality",
] as const;
const SAFE_LIMITATION = /^[a-z0-9][a-z0-9._/-]{0,127}$/u;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESOLVED_BYTES = 64 * 1024;
/** The evidence slots a planner judgment may cite; the editorial planner contract lists them. */
export const EDITORIAL_JUDGMENT_SLOT_IDS = [
  "current-documentation",
  "public-contract",
  "prd",
  "accepted-decision",
  "comparison",
  "request",
  "editorial-identity",
  "changed-source",
  "repository-instruction",
  "accepted-knowledge",
] as const;

/**
 * The page dispositions of the admitted plan binding a decision names, read by
 * the host from the run's sealed plan. A no-change candidate without source
 * coverage under a comparison rests on it.
 */
export interface EditorialDecisionRetainedPlanV1 {
  readonly planBindingSha256: string;
  readonly writePaths: readonly string[];
  readonly retainedPaths: readonly string[];
}

export interface EditorialDecisionDecodeContextV1 {
  repositoryRevision: string;
  repositoryContentDigest: string;
  resolver: EditorialDecisionArtifactResolverV1;
  evidenceValidator: EditorialDecisionEvidenceValidatorV1;
  producerValidator: EditorialDecisionProducerValidatorV1;
  producer: EditorialDecisionProducerProvenanceV1;
  readerContext: ReaderContextV1;
  readerContextValidation: ReaderContextValidationOptions;
  readerProvenance: ReaderContextProvenanceV1;
  readerProvenanceValidation: ReaderContextProvenanceValidationOptions;
  /** Absent when the host has no admitted plan; then only source coverage under a comparison can support no-change. */
  retainedPlan?: EditorialDecisionRetainedPlanV1;
}

export interface EditorialDecisionProposalValidationOptionsV1 {
  readerContextInput: ReaderContextInputV1;
  admittedReaderEvidence: readonly ReaderContextEvidenceReferenceV1[];
  admittedEvidenceRefs: readonly ArtifactReference[];
}

export interface EditorialDecisionCandidateBindingsV1 extends EditorialDecisionDecodeContextV1 {
  workspaceSnapshotSha256: string;
  planBindingSha256: string;
  policySha256: string;
  comparison: import("../context/reader-context.js").ReaderContextComparisonV1;
}

/** Admit only content from the planner; all execution identity stays host-owned. */
export function validateEditorialDecisionProposalV1(
  value: unknown,
  options: EditorialDecisionProposalValidationOptionsV1,
): EditorialDecisionProposalV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, [
    "schemaVersion",
    "kind",
    "candidate",
    "rationale",
    "evidenceRefs",
    "limitations",
    "impactBasis",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-editorial-decision-proposal") {
    fail("invalid-shape");
  }
  const candidate = kit.enumeration(root.candidate, EDITORIAL_DECISION_CANDIDATES);
  const rationale = substantiveRationaleText(root.rationale);
  const evidenceRefs = kit.array(root.evidenceRefs).map((reference) => decodeReference(reference));
  if (evidenceRefs.length < 1 || evidenceRefs.length > 128) fail("invalid-value");
  kit.unique(evidenceRefs.map((reference) => canonicalArtifactJson(reference)));
  const admitted = new Set(
    options.admittedEvidenceRefs.map((reference) =>
      canonicalArtifactJson(decodeReference(reference)),
    ),
  );
  if (evidenceRefs.some((reference) => !admitted.has(canonicalArtifactJson(reference)))) {
    fail("evidence-unavailable");
  }
  const limitations = decodeLimitations(root.limitations);
  if (
    limitations.some(
      (code) => code.startsWith("product-gap.") || code.startsWith("evidence-limitation."),
    )
  ) {
    fail("invalid-value");
  }
  const completed = validateReaderContextV1(
    { ...options.readerContextInput, impact_basis: root.impactBasis },
    { admittedEvidence: options.admittedReaderEvidence },
  );
  if (
    (candidate === "no-change" && completed.impact_basis.kind !== "none") ||
    (candidate === "update" &&
      !["public-behavior-change", "documentation-defect"].includes(completed.impact_basis.kind))
  ) {
    fail("invalid-value");
  }
  return kit.deepFreeze({
    schemaVersion: 1,
    kind: "docsfab-editorial-decision-proposal",
    candidate,
    rationale,
    evidenceRefs,
    limitations,
    impactBasis: completed.impact_basis,
  });
}

/** Bind one admitted proposal to host identities and retained rationale bytes. */
export function createEditorialDecisionCandidateFromProposalV1(
  proposal: EditorialDecisionProposalV1,
  bindings: EditorialDecisionCandidateBindingsV1,
): EditorialDecisionPayloadV1 {
  const completed = validateReaderContextV1(
    bindings.readerContext,
    bindings.readerContextValidation,
  );
  if (
    canonicalArtifactJson(completed.impact_basis) !== canonicalArtifactJson(proposal.impactBasis)
  ) {
    fail("identity-mismatch");
  }
  return createEditorialDecisionPayloadV1(
    {
      phase: "candidate",
      candidateArtifact: null,
      branchCoverage: null,
      candidate: proposal.candidate,
      repositoryRevision: bindings.repositoryRevision,
      workspaceSnapshotSha256: bindings.workspaceSnapshotSha256,
      readerProvenanceSha256: readerContextProvenanceSha256(
        validateReaderContextProvenanceV1(
          bindings.readerProvenance,
          bindings.readerProvenanceValidation,
        ),
      ),
      planBindingSha256: bindings.planBindingSha256,
      policySha256: bindings.policySha256,
      comparison: bindings.comparison,
      rationaleSha256: sha256(new TextEncoder().encode(proposal.rationale)),
      evidenceRefs: proposal.evidenceRefs,
      limitations: proposal.limitations,
    },
    bindings,
  );
}

/**
 * The host-owned limitations that name the basis of a no-change decision
 * without a comparison of two distinct commits: the plan's kept pages, or
 * source coverage the operator or model nominated. Each travels with the
 * decision to the editorial and product outcomes; only a commit comparison's
 * no-change carries none.
 */
export const NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION = "no-change-basis.kept-pages";
export const NO_CHANGE_NOMINATED_COVERAGE_BASIS_LIMITATION = "no-change-basis.nominated-coverage";

const HOST_OWNED_LIMITATION_PREFIX = "no-change-basis.";

/** Whether a limitation is one of the host-owned no-change basis codes. */
export function isNoChangeBasisLimitation(code: string): boolean {
  return code.startsWith(HOST_OWNED_LIMITATION_PREFIX);
}

/**
 * Discloses that the quality evaluator answered `not-applicable` to a
 * no-change: no page changed, so it judged no document quality. A final
 * no-change admits that answer only when its limitations carry this code.
 */
export const QUALITY_EVALUATION_NOT_APPLICABLE_LIMITATION = "quality-evaluation-not-applicable";

/** Where the no-change rule reads each independent assessment. */
export const NO_CHANGE_ASSESSMENT_LOCATION = "$.evidenceRefs[].producers[].assessment";

/**
 * Whether a comparison compares two distinct commits. A base and head
 * comparison of one commit declares no change, so source coverage under it
 * rests on nominated roles, as under a workspace comparison.
 */
export function comparesDistinctCommits(comparison: ReaderContextComparisonV1): boolean {
  return comparison.kind === "base-head" && comparison.base_revision !== comparison.head_revision;
}

/** The evidence basis that supports a no-change decision. */
type EditorialNoChangeBasisV1 = "commit-comparison" | "nominated-coverage" | "kept-pages";

/** The code a basis discloses, or `undefined` for a commit comparison's. */
function noChangeBasisLimitation(basis: EditorialNoChangeBasisV1 | undefined): string | undefined {
  return basis === "kept-pages"
    ? NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION
    : basis === "nominated-coverage"
      ? NO_CHANGE_NOMINATED_COVERAGE_BASIS_LIMITATION
      : undefined;
}

/**
 * The basis a no-change rests on, in words, when its limitations disclose one;
 * `undefined` when they carry no basis code, as a commit comparison's do.
 */
export function noChangeBasisPhrase(limitations: readonly string[]): string | undefined {
  if (limitations.includes(NO_CHANGE_KEPT_PAGE_BASIS_LIMITATION)) {
    return "kept pages, no commit comparison";
  }
  if (limitations.includes(NO_CHANGE_NOMINATED_COVERAGE_BASIS_LIMITATION)) {
    return "nominated source coverage, no commit comparison";
  }
  return undefined;
}

/** The limitations with every host-owned code replaced by the one the basis needs. */
function withHostBasisLimitation(
  limitations: readonly string[],
  basis: EditorialNoChangeBasisV1 | undefined,
): string[] {
  const code = noChangeBasisLimitation(basis);
  return [
    ...limitations.filter((item) => !isNoChangeBasisLimitation(item)),
    ...(code ? [code] : []),
  ];
}

export function editorialDecisionReferenceV3(
  payload: EditorialDecisionPayloadV1,
  repositoryContentDigest: string,
): EditorialDecisionArtifactReferenceV3 {
  return kit.deepFreeze({
    kind: "editorial-decision",
    schemaVersion: 3,
    digest: kit.hash(payload.decisionSha256),
    repositoryRevision: kit.revision(payload.repositoryRevision),
    repositoryContentDigest: kit.hash(repositoryContentDigest),
  });
}

/** Create the sealed domain body. Artifact-envelope creation is handled by the shared artifact path. */
export function createEditorialDecisionPayloadV1(
  value: Omit<EditorialDecisionPayloadV1, "schemaVersion" | "kind" | "decisionSha256">,
  context: EditorialDecisionDecodeContextV1,
): EditorialDecisionPayloadV1 {
  const sealed = kit.seal(
    "docsfab-editorial-decision",
    "decisionSha256",
    normalizeBody(value, context, "create"),
  );
  assertBodySize(sealed);
  return sealed;
}

/** Strictly decode the sealed body and resolve every evidence byte before returning it. */
export function decodeEditorialDecisionPayloadV1(
  value: unknown,
  context: EditorialDecisionDecodeContextV1,
): EditorialDecisionPayloadV1 {
  const decoded = kit.decodeSealed(
    value,
    "docsfab-editorial-decision",
    "decisionSha256",
    [...BODY_KEYS],
    (body) => normalizeBody(body, context, "decode"),
  );
  assertBodySize(decoded);
  return decoded;
}

export function decodeEditorialDecisionProducerV1(
  value: unknown,
): EditorialDecisionProducerProvenanceV1 {
  kit.assertInert(value);
  const root = kit.object(value);
  kit.exact(root, [
    "stepId",
    "skill",
    "mode",
    "status",
    "repositoryRevision",
    "workspaceSnapshotSha256",
    "assessment",
    "recommendation",
  ]);
  const stepId = kit.enumeration(root.stepId, PRODUCER_STEPS);
  const skill = kit.identifier(root.skill);
  if (skill !== stepId) fail("producer-mismatch");
  if (root.mode !== "read-only" || root.status !== "succeeded") fail("producer-mismatch");
  const assessment = kit.enumeration(root.assessment, ["accepted", "rejected", "not-applicable"]);
  const recommendation = decodeAssessmentRecommendation(root.recommendation);
  if ((assessment === "rejected") !== (recommendation !== null)) fail("producer-mismatch");
  return kit.deepFreeze({
    stepId,
    skill,
    mode: "read-only" as const,
    status: "succeeded" as const,
    repositoryRevision: kit.revision(root.repositoryRevision),
    workspaceSnapshotSha256: kit.hash(root.workspaceSnapshotSha256),
    assessment,
    recommendation,
  });
}

function decodeAssessmentRecommendation(
  value: unknown,
): import("./contracts.js").EditorialDecisionAssessmentRecommendationV1 | null {
  if (value === null) return null;
  const root = kit.object(value);
  kit.exact(root, ["candidate", "kind", "code", "rationaleSha256"]);
  const candidate = kit.enumeration(root.candidate, ["update", "insufficient-evidence"]);
  const kind = kit.enumeration(root.kind, ["product-gap", "evidence-limitation"]);
  if (
    (candidate === "update") !== (kind === "product-gap") ||
    typeof root.code !== "string" ||
    !SAFE_LIMITATION.test(root.code) ||
    !root.code.startsWith(`${kind}.`)
  ) {
    fail("producer-mismatch");
  }
  return kit.deepFreeze({
    candidate,
    kind,
    code: root.code,
    rationaleSha256: kit.hash(root.rationaleSha256),
  });
}

function normalizeBody(
  value: unknown,
  context: EditorialDecisionDecodeContextV1,
  mode: "create" | "decode",
): Omit<EditorialDecisionPayloadV1, "schemaVersion" | "kind" | "decisionSha256"> {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, [...BODY_KEYS]);
  const phase = kit.enumeration(root.phase, ["candidate", "validated"] as const);
  const candidateArtifact =
    root.candidateArtifact === null
      ? null
      : (decodeReference(
          root.candidateArtifact,
          "editorial-decision",
        ) as EditorialDecisionArtifactReferenceV3);
  if ((phase === "candidate") !== (candidateArtifact === null)) fail("invalid-value");
  const branchCoverage = decodeBranchCoverageReference(root.branchCoverage);
  if ((phase === "candidate") !== (branchCoverage === null)) fail("invalid-value");
  const candidate = kit.enumeration(root.candidate, EDITORIAL_DECISION_CANDIDATES);
  const repositoryRevision = kit.revision(root.repositoryRevision);
  const workspaceSnapshotSha256 = kit.hash(root.workspaceSnapshotSha256);
  if (
    repositoryRevision !== kit.revision(context.repositoryRevision) ||
    workspaceSnapshotSha256 !==
      decodeEditorialDecisionProducerV1(context.producer).workspaceSnapshotSha256
  ) {
    fail("identity-mismatch");
  }
  const producer = decodeEditorialDecisionProducerV1(context.producer);
  try {
    context.producerValidator.validate(producer, null);
  } catch {
    fail("producer-mismatch");
  }
  if (producer.repositoryRevision !== repositoryRevision) fail("identity-mismatch");
  if (
    (phase === "candidate" && producer.stepId !== "plan-documentation") ||
    (phase === "validated" && producer.stepId !== "evaluate-document-quality")
  ) {
    fail("producer-mismatch");
  }
  const comparison = validateReaderContextComparisonV1(root.comparison);
  const admittedReaderContext = validateReaderContextV1(
    context.readerContext,
    context.readerContextValidation,
  );
  const admittedReaderProvenance = validateReaderContextProvenanceV1(
    context.readerProvenance,
    context.readerProvenanceValidation,
  );
  const provenanceEvidence = new Set(
    admittedReaderProvenance.sources.map(({ uri, sha256 }) =>
      canonicalArtifactJson({ uri, sha256 }),
    ),
  );
  if (
    admittedReaderProvenance.reader_context_sha256 !== readerContextSha256(admittedReaderContext) ||
    canonicalArtifactJson(admittedReaderProvenance.comparison) !==
      canonicalArtifactJson(comparison) ||
    admittedReaderProvenance.policy.sha256 !== kit.hash(root.policySha256) ||
    readerContextProvenanceSha256(admittedReaderProvenance) !==
      kit.hash(root.readerProvenanceSha256) ||
    admittedReaderContext.impact_basis.evidence_refs.some(
      (reference) => !provenanceEvidence.has(canonicalArtifactJson(reference)),
    )
  ) {
    fail("identity-mismatch");
  }
  // A no-change candidate rests on one of three evidence bases: source
  // coverage under a comparison of two distinct commits; the same coverage
  // under a workspace comparison or a comparison of one commit, where it rests
  // on nominated roles; or, when no base and head comparison is declared, the
  // plan's kept pages. In every case the brief must hold no open question,
  // and the independent read-only suffix must still accept it.
  const basis =
    candidate === "no-change"
      ? noChangeEvidenceBasis(
          comparison,
          admittedReaderProvenance,
          context.retainedPlan,
          kit.hash(root.planBindingSha256),
        )
      : undefined;
  if (
    candidate === "no-change" &&
    (producer.assessment === "rejected" ||
      admittedReaderContext.impact_basis.kind !== "none" ||
      admittedReaderContext.unresolved_questions.length > 0 ||
      basis === undefined)
  ) {
    fail("independent-rejection");
  }
  const evidenceRefs = kit.array(root.evidenceRefs).map((reference) => decodeReference(reference));
  if (evidenceRefs.length < 1 || evidenceRefs.length > 128) fail("invalid-value");
  kit.unique(evidenceRefs.map((reference) => canonicalArtifactJson(reference)));
  const editorialReferences = evidenceRefs.filter(
    (reference): reference is EditorialDecisionArtifactReferenceV3 =>
      reference.kind === "editorial-decision",
  );
  if (
    (phase === "candidate" && editorialReferences.length !== 0) ||
    (phase === "validated" &&
      (editorialReferences.length !== 1 ||
        canonicalArtifactJson(editorialReferences[0]) !== canonicalArtifactJson(candidateArtifact)))
  ) {
    fail("invalid-value");
  }
  evidenceRefs.sort((left, right) =>
    canonicalArtifactJson(left).localeCompare(canonicalArtifactJson(right)),
  );
  // The decision names the basis of a no-change that no commit comparison
  // supports in its own limitations, so every surface that reads it discloses
  // the basis. The code is host-owned: creating a decision drops any copy and
  // writes the basis's own. A stored decision must carry exactly that code,
  // except that a nominated-coverage decision sealed before the disclosure
  // carries none; its readers disclose the basis for it.
  // A validated decision merges the candidate's and each assessment's codes,
  // and each list was bounded where it was admitted, so the merge adds no
  // count bound of its own.
  const bounded = phase !== "validated";
  const limitations = decodeLimitations(
    mode === "create"
      ? withHostBasisLimitation(decodeLimitations(root.limitations, bounded), basis)
      : root.limitations,
    bounded,
  );
  if (mode === "decode") {
    const expected = noChangeBasisLimitation(basis);
    const disclosed = limitations.filter(isNoChangeBasisLimitation);
    const disclosesBasis =
      expected === undefined
        ? disclosed.length === 0
        : disclosed.length === 1 && disclosed[0] === expected;
    const sealedBeforeDisclosure = basis === "nominated-coverage" && disclosed.length === 0;
    if (!disclosesBasis && !sealedBeforeDisclosure) fail("invalid-value");
  }
  if (
    phase === "candidate" &&
    limitations.some(
      (code) => code.startsWith("product-gap.") || code.startsWith("evidence-limitation."),
    )
  ) {
    fail("invalid-value");
  }
  const resolved = evidenceRefs.map((reference) => resolveEvidence(reference, context));
  const rationaleSha256 = kit.hash(root.rationaleSha256);
  const rationale = resolveRationale(rationaleSha256, evidenceRefs, resolved, context);
  if (phase === "candidate" && rationale.producer.stepId !== "plan-documentation") {
    fail("producer-mismatch");
  }
  if (phase === "validated" && rationale.producer.stepId !== "evaluate-document-quality") {
    fail("producer-mismatch");
  }
  if (sha256(rationale.bytes) !== rationaleSha256 || !substantiveRationale(rationale.bytes)) {
    fail("evidence-unavailable");
  }
  const body = {
    phase,
    candidateArtifact,
    branchCoverage,
    candidate,
    repositoryRevision,
    workspaceSnapshotSha256,
    readerProvenanceSha256: kit.hash(root.readerProvenanceSha256),
    planBindingSha256: kit.hash(root.planBindingSha256),
    policySha256: kit.hash(root.policySha256),
    comparison,
    rationaleSha256,
    evidenceRefs,
    limitations,
  };
  if (phase === "validated") validateFinalDecision(body, resolved, context);
  return body;
}

function decodeBranchCoverageReference(
  value: unknown,
): import("./contracts.js").WorkflowBranchCoverageReferenceV1 | null {
  if (value === null) return null;
  const root = kit.object(value);
  kit.exact(root, ["schemaVersion", "kind", "coverageSha256"]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-workflow-branch-coverage-reference") {
    fail("invalid-shape");
  }
  return kit.deepFreeze({
    schemaVersion: 1,
    kind: "docsfab-workflow-branch-coverage-reference" as const,
    coverageSha256: kit.hash(root.coverageSha256),
  });
}

function validateFinalDecision(
  body: Omit<EditorialDecisionPayloadV1, "schemaVersion" | "kind" | "decisionSha256">,
  resolved: ReturnType<typeof resolveEvidence>[],
  context: EditorialDecisionDecodeContextV1,
): void {
  const candidateReference = body.candidateArtifact!;
  const matches = resolved.filter(
    (entry) => canonicalArtifactJson(entry.reference) === canonicalArtifactJson(candidateReference),
  );
  if (matches.length !== 1) fail("evidence-unavailable");
  const candidateEvidence = matches[0]!;
  const candidateBody = decodeResolvedCandidate(candidateEvidence, candidateReference, context);
  if (
    candidateBody.phase !== "candidate" ||
    candidateEvidence.producers.filter((producer) => producer.stepId === "plan-documentation")
      .length !== 1
  ) {
    fail("producer-mismatch");
  }
  for (const key of [
    "repositoryRevision",
    "workspaceSnapshotSha256",
    "readerProvenanceSha256",
    "planBindingSha256",
    "policySha256",
  ] as const) {
    if (candidateBody[key] !== body[key]) fail("identity-mismatch");
  }
  if (canonicalArtifactJson(candidateBody.comparison) !== canonicalArtifactJson(body.comparison)) {
    fail("identity-mismatch");
  }
  const coreIndependentSteps = [
    "verify-technical-accuracy",
    "review-documentation",
    "evaluate-document-quality",
  ] as const;
  const coreFindings = coreIndependentSteps.map((stepId) => {
    const matches = new Map(
      resolved
        .flatMap((entry) => entry.producers.filter((producer) => producer.stepId === stepId))
        .map((producer) => [canonicalArtifactJson(producer), producer]),
    );
    if (matches.size !== 1) fail("evidence-unavailable");
    return [...matches.values()][0]!;
  });
  const audienceFindings = new Map(
    resolved
      .flatMap((entry) =>
        entry.producers.filter((producer) => producer.stepId === "test-audience-understanding"),
      )
      .map((producer) => [canonicalArtifactJson(producer), producer]),
  );
  if (audienceFindings.size !== 1) fail("evidence-unavailable");
  const audienceFinding = [...audienceFindings.values()][0]!;
  const independentFindings = [...coreFindings, audienceFinding];
  const rejected = independentFindings.filter((producer) => producer.assessment === "rejected");
  const reservedLimitations = body.limitations.filter(
    (code) => code.startsWith("product-gap.") || code.startsWith("evidence-limitation."),
  );
  if (
    reservedLimitations.some(
      (code) =>
        !rejected.some(
          (producer) =>
            producer.recommendation?.candidate === body.candidate &&
            producer.recommendation.code === code,
        ),
    )
  ) {
    fail("independent-rejection");
  }
  if (candidateBody.candidate === "insufficient-evidence") fail("independent-rejection");
  if (body.candidate === "no-change") {
    if (candidateBody.candidate !== "no-change") fail("independent-rejection");
    if (
      rejected.length > 0 ||
      coreFindings.some((producer) => !confirmsNoChange(producer, body.limitations))
    ) {
      fail("independent-rejection", NO_CHANGE_ASSESSMENT_LOCATION);
    }
    return;
  }
  if (rejected.length === 0) {
    if (body.candidate !== candidateBody.candidate) fail("independent-rejection");
    return;
  }
  const supporting = rejected.filter(
    (producer) =>
      producer.recommendation?.candidate === body.candidate &&
      body.limitations.includes(producer.recommendation.code),
  );
  if (supporting.length === 0) {
    fail("independent-rejection");
  }
}

/**
 * Whether one core assessment confirms a no-change: `accepted`, or the
 * quality evaluator's `not-applicable` when the decision discloses it.
 * Technical verification and review must accept.
 */
function confirmsNoChange(
  producer: EditorialDecisionProducerProvenanceV1,
  limitations: readonly string[],
): boolean {
  return (
    producer.assessment === "accepted" ||
    (producer.stepId === "evaluate-document-quality" &&
      producer.assessment === "not-applicable" &&
      limitations.includes(QUALITY_EVALUATION_NOT_APPLICABLE_LIMITATION))
  );
}

function resolveEvidence(reference: ArtifactReference, context: EditorialDecisionDecodeContextV1) {
  let resolved;
  try {
    resolved = context.resolver.resolve(reference);
  } catch {
    return fail("evidence-unavailable");
  }
  if (
    canonicalArtifactJson(decodeReference(resolved.reference)) !==
      canonicalArtifactJson(reference) ||
    !(resolved.bytes instanceof Uint8Array) ||
    resolved.bytes.byteLength === 0 ||
    resolved.bytes.byteLength > MAX_RESOLVED_BYTES
  ) {
    fail("evidence-unavailable");
  }
  const producers = kit.array(resolved.producers).map((value) => {
    const producer = decodeEditorialDecisionProducerV1(value);
    if (
      producer.repositoryRevision !== context.repositoryRevision ||
      producer.workspaceSnapshotSha256 !== context.producer.workspaceSnapshotSha256
    ) {
      fail("identity-mismatch");
    }
    try {
      context.producerValidator.validate(producer, reference);
    } catch {
      fail("producer-mismatch");
    }
    return producer;
  });
  if (producers.length < 1) fail("producer-mismatch");
  kit.unique(producers.map((producer) => producer.stepId));
  if (reference.kind !== "editorial-decision") {
    try {
      context.evidenceValidator.validate(reference, resolved.bytes);
    } catch {
      fail("evidence-unavailable");
    }
  }
  return { ...resolved, producers };
}

function resolveRationale(
  rationaleSha256: string,
  evidenceRefs: readonly ArtifactReference[],
  resolvedEvidence: readonly ReturnType<typeof resolveEvidence>[],
  context: EditorialDecisionDecodeContextV1,
) {
  let resolved;
  try {
    resolved = context.resolver.resolveRationale(rationaleSha256);
  } catch {
    return fail("evidence-unavailable");
  }
  if (!(resolved.bytes instanceof Uint8Array) || resolved.bytes.byteLength === 0) {
    fail("evidence-unavailable");
  }
  const boundReference = decodeReference(resolved.boundReference);
  if (
    !evidenceRefs.some(
      (reference) => canonicalArtifactJson(reference) === canonicalArtifactJson(boundReference),
    )
  ) {
    fail("evidence-unavailable");
  }
  const producer = decodeEditorialDecisionProducerV1(resolved.producer);
  if (
    producer.repositoryRevision !== context.repositoryRevision ||
    producer.workspaceSnapshotSha256 !== context.producer.workspaceSnapshotSha256
  ) {
    fail("identity-mismatch");
  }
  const boundEvidence = resolvedEvidence.find(
    (entry) => canonicalArtifactJson(entry.reference) === canonicalArtifactJson(boundReference),
  );
  if (
    !boundEvidence?.producers.some(
      (candidate) => canonicalArtifactJson(candidate) === canonicalArtifactJson(producer),
    )
  ) {
    fail("producer-mismatch");
  }
  return { ...resolved, boundReference, producer };
}

function decodeResolvedCandidate(
  resolved: ReturnType<typeof resolveEvidence>,
  reference: EditorialDecisionArtifactReferenceV3,
  context: EditorialDecisionDecodeContextV1,
): EditorialDecisionPayloadV1 {
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(resolved.bytes);
    parsed = JSON.parse(text);
  } catch {
    return fail("evidence-unavailable");
  }
  if (canonicalArtifactJson(parsed) !== text) fail("digest-mismatch");
  const planner = resolved.producers.find((producer) => producer.stepId === "plan-documentation");
  if (!planner) fail("producer-mismatch");
  const body = decodeEditorialDecisionPayloadV1(parsed, {
    ...context,
    producer: planner,
  });
  if (
    body.phase !== "candidate" ||
    body.decisionSha256 !== reference.digest ||
    body.repositoryRevision !== reference.repositoryRevision ||
    reference.repositoryContentDigest !== context.repositoryContentDigest
  ) {
    fail("identity-mismatch");
  }
  return body;
}

function decodeReference<K extends ArtifactReference["kind"]>(
  value: unknown,
  expectedKind?: K,
): ArtifactReference<K> {
  const root = kit.object(value);
  kit.exact(root, [
    "kind",
    "schemaVersion",
    "digest",
    "repositoryRevision",
    "repositoryContentDigest",
  ]);
  const kind = kit.enumeration(root.kind, ARTIFACT_REFERENCE_KINDS);
  if (expectedKind !== undefined && kind !== expectedKind) fail("invalid-value");
  const expectedVersion = kind === "editorial-decision" ? 3 : 1;
  if (root.schemaVersion !== expectedVersion) fail("invalid-value");
  return {
    kind: kind as K,
    schemaVersion: expectedVersion as ArtifactReference<K>["schemaVersion"],
    digest: kit.hash(root.digest),
    repositoryRevision: kit.revision(root.repositoryRevision),
    repositoryContentDigest: kit.hash(root.repositoryContentDigest),
  };
}

function hasNoChangeSourceCoverage(provenance: ReaderContextProvenanceV1): boolean {
  const roles = new Set(provenance.sources.map((source) => source.role));
  const changedSourceCovered =
    roles.has("changed-source") ||
    (provenance.comparison.kind === "base-head" &&
      provenance.comparison.base_revision === provenance.comparison.head_revision &&
      provenance.limitations.includes(READER_CONTEXT_CHANGED_SOURCE_INAPPLICABLE_LIMITATION));
  return roles.has("current-documentation") && roles.has("public-contract") && changedSourceCovered;
}

/**
 * The basis that supports a no-change decision, or `undefined` when none does.
 * Source coverage takes precedence: under a comparison of two distinct commits
 * it is the commit comparison's own; under a workspace comparison or a
 * comparison of one commit it rests on nominated roles. The kept-page basis
 * applies only when no base and head comparison is declared.
 */
function noChangeEvidenceBasis(
  comparison: ReaderContextComparisonV1,
  provenance: ReaderContextProvenanceV1,
  plan: EditorialDecisionRetainedPlanV1 | undefined,
  planBindingSha256: string,
): EditorialNoChangeBasisV1 | undefined {
  if (comparison.kind !== "unknown" && hasNoChangeSourceCoverage(provenance)) {
    return comparesDistinctCommits(comparison) ? "commit-comparison" : "nominated-coverage";
  }
  if (
    comparison.kind !== "base-head" &&
    hasRetainedPlanNoChangeEvidence(provenance, plan, planBindingSha256)
  ) {
    return "kept-pages";
  }
  return undefined;
}

/**
 * The kept-page no-change basis, for a run whose comparison declares no commit
 * range: the admitted plan the decision names writes no page and keeps
 * at least one unchanged, the host admitted every kept page as current
 * documentation, and the request that defines the assessment was admitted.
 * The independent read-only suffix must still accept the candidate before any
 * final no-change.
 */
function hasRetainedPlanNoChangeEvidence(
  provenance: ReaderContextProvenanceV1,
  plan: EditorialDecisionRetainedPlanV1 | undefined,
  planBindingSha256: string,
): boolean {
  if (
    !plan ||
    plan.planBindingSha256 !== planBindingSha256 ||
    plan.writePaths.length > 0 ||
    plan.retainedPaths.length === 0 ||
    !provenance.sources.some((source) => source.role === "request")
  ) {
    return false;
  }
  const currentDocumentation = new Set(
    provenance.sources
      .filter((source) => source.role === "current-documentation")
      .map((source) => source.uri),
  );
  return plan.retainedPaths.every((path) => currentDocumentation.has(path));
}

function substantiveRationale(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 16 || bytes.byteLength > MAX_RESOLVED_BYTES) return false;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text !== text.normalize("NFC") || text.includes("\0") || text.includes("\r")) return false;
  kit.rejectCredentials(text);
  return /\S/u.test(text);
}

function substantiveRationaleText(value: unknown): string {
  const text = kit.string(value);
  if (
    text.includes("\r") ||
    text !== text.normalize("NFC") ||
    !/\S/u.test(text) ||
    [...text].length < 16 ||
    [...text].length > 4_096
  ) {
    fail("invalid-value");
  }
  return text;
}

function decodeLimitations(value: unknown, bounded = true): string[] {
  const limitations = kit.array(value).map((item) => {
    const code = kit.string(item);
    if (!SAFE_LIMITATION.test(code)) fail("invalid-value");
    return code;
  });
  if (bounded && limitations.length > 32) fail("invalid-value");
  kit.unique(limitations);
  return limitations.sort((left, right) => left.localeCompare(right));
}

function assertBodySize(value: unknown): void {
  if (Buffer.byteLength(canonicalArtifactJson(value), "utf8") > MAX_BODY_BYTES) {
    fail("invalid-value");
  }
}

export interface HostOwnedEditorialIdentityV1 {
  readonly artifactEvidenceRefs: readonly ArtifactReference[];
  readonly sourceEvidence: readonly ReaderContextEvidenceReferenceV1[];
}

export interface EditorialDecisionJudgmentV1 {
  readonly candidate: EditorialDecisionCandidateV1;
  readonly rationale: string;
  readonly slotIds: readonly string[];
}

export interface EditorialDecisionHostFillOptionsV1
  extends EditorialDecisionProposalValidationOptionsV1 {
  readonly comparison?: ReaderContextComparisonV1;
}

/** Planner judgment only. Extra minted identity fields are not authority. */
export function readEditorialDecisionJudgmentV1(value: unknown): EditorialDecisionJudgmentV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  const candidate = kit.enumeration(root.candidate, EDITORIAL_DECISION_CANDIDATES);
  const rationale = substantiveRationaleText(root.rationale);
  const slotIds =
    root.slotIds === undefined
      ? []
      : kit.array(root.slotIds).map((item) => {
          const id = kit.string(item);
          if (!(EDITORIAL_JUDGMENT_SLOT_IDS as readonly string[]).includes(id)) {
            fail("invalid-value");
          }
          return id;
        });
  if (slotIds.length > 16) fail("invalid-value");
  kit.unique(slotIds);
  return kit.deepFreeze({ candidate, rationale, slotIds });
}

/**
 * Fill host-owned identity from the closed admission set, then run the same
 * proposal decoder. Model-minted sha256 and artifact refs are ignored.
 */
export function hostFillEditorialDecisionProposalFromJudgmentV1(
  judgment: unknown,
  options: EditorialDecisionHostFillOptionsV1,
): EditorialDecisionProposalV1 {
  const decoded = readEditorialDecisionJudgmentV1(judgment);
  const identity: HostOwnedEditorialIdentityV1 = {
    artifactEvidenceRefs: options.admittedEvidenceRefs,
    sourceEvidence: options.admittedReaderEvidence,
  };
  const readerEvidence = hostReaderEvidence(identity);
  return validateEditorialDecisionProposalV1(
    {
      schemaVersion: 1,
      kind: "docsfab-editorial-decision-proposal",
      candidate: decoded.candidate,
      rationale: decoded.rationale,
      evidenceRefs: identity.artifactEvidenceRefs.map((reference) => ({ ...reference })),
      limitations: [],
      impactBasis: {
        kind: hostImpactKind(decoded.candidate, options.comparison),
        rationale: decoded.rationale,
        evidence_refs: readerEvidence.map((source) => ({ uri: source.uri, sha256: source.sha256 })),
      },
    },
    {
      readerContextInput: options.readerContextInput,
      admittedReaderEvidence: readerEvidence,
      admittedEvidenceRefs: options.admittedEvidenceRefs,
    },
  );
}

function hostImpactKind(
  candidate: EditorialDecisionCandidateV1,
  comparison: ReaderContextComparisonV1 | undefined,
): ReaderContextImpactKindV1 {
  if (candidate === "no-change") return "none";
  if (candidate === "insufficient-evidence") return "unknown";
  return comparison !== undefined && comparison.kind !== "unknown"
    ? "public-behavior-change"
    : "documentation-defect";
}

/**
 * Prefer admitted source uri/sha256. When the planner step only carries
 * artifact refs, map those digests so the same decoder can run; select() still
 * rebinds real source identity from the closed admission set.
 */
function uniqueImpactEvidence(
  sources: readonly ReaderContextEvidenceReferenceV1[],
): ReaderContextEvidenceReferenceV1[] {
  const unique = new Map<string, ReaderContextEvidenceReferenceV1>();
  for (const source of sources) {
    const key = `${source.uri}\0${source.sha256}`;
    if (!unique.has(key)) unique.set(key, { uri: source.uri, sha256: source.sha256 });
    if (unique.size >= 32) break;
  }
  return [...unique.values()];
}

function hostReaderEvidence(
  identity: HostOwnedEditorialIdentityV1,
): ReaderContextEvidenceReferenceV1[] {
  if (identity.sourceEvidence.length > 0) {
    return uniqueImpactEvidence(identity.sourceEvidence);
  }
  return uniqueImpactEvidence(
    identity.artifactEvidenceRefs.map((reference) => ({
      uri: `docsfab:admitted-artifact/${reference.kind}/${reference.digest}`,
      sha256: reference.digest,
    })),
  );
}

function boundAdmittedImpactEvidence(
  impactRefs: readonly unknown[],
  sourceEvidence: readonly ReaderContextEvidenceReferenceV1[],
): ReaderContextEvidenceReferenceV1[] {
  const admitted = new Set(sourceEvidence.map((source) => `${source.uri}\0${source.sha256}`));
  const fromProposal: ReaderContextEvidenceReferenceV1[] = [];
  for (const reference of impactRefs) {
    if (!reference || typeof reference !== "object" || Array.isArray(reference)) continue;
    const item = reference as Record<string, unknown>;
    if (typeof item.uri !== "string" || typeof item.sha256 !== "string") continue;
    if (!admitted.has(`${item.uri}\0${item.sha256}`)) continue;
    fromProposal.push({ uri: item.uri, sha256: item.sha256 });
  }
  const uniqueProposed = uniqueImpactEvidence(fromProposal);
  return uniqueProposed.length > 0 ? uniqueProposed : uniqueImpactEvidence(sourceEvidence);
}

function sameImpactRefList(
  actual: readonly unknown[],
  expected: readonly ReaderContextEvidenceReferenceV1[],
): boolean {
  if (actual.length !== expected.length) return false;
  return expected.every((source, index) => {
    const item = actual[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return record.uri === source.uri && record.sha256 === source.sha256;
  });
}

function impactKindForBoundCandidate(
  candidate: unknown,
  currentKind: unknown,
  hasImpactRefs: boolean,
): unknown {
  if (candidate === "no-change") return hasImpactRefs ? "none" : "unknown";
  if (candidate === "insufficient-evidence") return "unknown";
  if (candidate === "update") {
    if (currentKind === "public-behavior-change" || currentKind === "documentation-defect") {
      return currentKind;
    }
    return "documentation-defect";
  }
  return currentKind;
}

/** Replace model-minted evidence identities with host-admitted refs. Keep judgment. */
export function bindHostOwnedEditorialProposalIdentityV1(
  proposal: unknown,
  identity: HostOwnedEditorialIdentityV1,
): unknown {
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) return proposal;
  const root = proposal as Record<string, unknown>;
  const admittedArtifacts = identity.artifactEvidenceRefs.map((reference) =>
    canonicalArtifactJson(reference),
  );
  const evidenceRefs = Array.isArray(root.evidenceRefs) ? root.evidenceRefs : [];
  const needsArtifactRewrite =
    evidenceRefs.length === 0 ||
    evidenceRefs.some((reference) => {
      try {
        return !admittedArtifacts.includes(canonicalArtifactJson(decodeReference(reference)));
      } catch {
        return true;
      }
    });
  const impactBasis =
    root.impactBasis && typeof root.impactBasis === "object" && !Array.isArray(root.impactBasis)
      ? (root.impactBasis as Record<string, unknown>)
      : undefined;
  const impactRefs = Array.isArray(impactBasis?.evidence_refs) ? impactBasis.evidence_refs : [];
  const boundImpactRefs = boundAdmittedImpactEvidence(impactRefs, identity.sourceEvidence);
  const nextKind = impactKindForBoundCandidate(
    root.candidate,
    impactBasis?.kind,
    boundImpactRefs.length > 0,
  );
  const needsImpactRewrite =
    boundImpactRefs.length > 0 &&
    (!impactBasis ||
      impactBasis.kind !== nextKind ||
      !sameImpactRefList(impactRefs, boundImpactRefs));
  if (!needsArtifactRewrite && !needsImpactRewrite) return proposal;
  return {
    ...root,
    ...(needsArtifactRewrite && identity.artifactEvidenceRefs.length > 0
      ? { evidenceRefs: identity.artifactEvidenceRefs.map((reference) => ({ ...reference })) }
      : {}),
    ...(needsImpactRewrite
      ? {
          impactBasis: {
            ...(impactBasis ?? {
              rationale:
                typeof root.rationale === "string"
                  ? root.rationale
                  : "Host-admitted reader evidence.",
            }),
            kind: nextKind,
            evidence_refs: boundImpactRefs,
          },
        }
      : {}),
  };
}

/** Closing admission for an operator-directed update when comparison is unknown. */
export function hostBindDirectedUpdateProposalV1(
  identity: HostOwnedEditorialIdentityV1,
  instruction: string,
): EditorialDecisionProposalV1 {
  const rationale = hostOwnedUpdateRationale(instruction);
  const evidenceRefs = identity.artifactEvidenceRefs;
  if (evidenceRefs.length < 1) fail("evidence-unavailable");
  const sources =
    identity.sourceEvidence.length > 0
      ? uniqueImpactEvidence(identity.sourceEvidence)
      : fail("evidence-unavailable");
  return {
    schemaVersion: 1,
    kind: "docsfab-editorial-decision-proposal",
    candidate: "update",
    rationale,
    evidenceRefs: evidenceRefs.map((reference) => ({ ...reference })),
    limitations: [],
    impactBasis: {
      kind: "documentation-defect",
      rationale,
      evidence_refs: sources.map((source) => ({ uri: source.uri, sha256: source.sha256 })),
    },
  };
}

function hostOwnedUpdateRationale(instruction: string): string {
  const text = instruction.normalize("NFC").trim();
  if (
    text.length >= 16 &&
    text.length <= 4_096 &&
    !text.includes("\0") &&
    !text.includes("\r") &&
    /\S/u.test(text)
  ) {
    try {
      kit.rejectCredentials(text);
      return `The operator directed this documentation update: ${text}`.slice(0, 4_096);
    } catch {
      // Fall through to the host-owned sentence when instruction bytes are unsafe.
    }
  }
  return "The operator directed an update of the planned documentation pages.";
}
