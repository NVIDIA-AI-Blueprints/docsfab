// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ArtifactReference,
  ArtifactUse,
  EditorialDecisionArtifactReferenceV3,
  EditorialDecisionPayloadV1,
} from "../artifacts/contracts.js";
import { validateArtifactReference, validateArtifactUse } from "../artifacts/validate.js";
import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import { canonicalDigest, canonicalJson, sha256 } from "../content-ir/canonical.js";
import {
  isConfigurableRetryCategory,
  isInferenceAttemptOutcome,
} from "../inference-attempt-taxonomy.js";
import {
  inferenceConditionRetryability,
  recordRetriesNoProgress,
  terminalInferenceCategories,
  inferenceAttemptBudgetPositions,
  inferenceAttemptsWithinBudgets,
  isInferenceTransportRetryEvidence,
  isRecordedInferenceRetryBackoff,
  projectBudgetedInferenceRetryDecision,
} from "../records/inference-retry-disposition.js";
import {
  inferenceAttemptRulesConsistent,
  isInferenceConditionRetryEvidence,
} from "../records/inference-retry-rule.js";
import {
  admittedInferenceReplays,
  effectiveInferenceRetryCategories,
  replayKeepsConfiguredBudget,
} from "../records/inference-replay.js";
import type {
  RunRecord,
  ToolActivitySummary,
  ToolFailureDisposition,
} from "../records/contracts.js";
import {
  EXECUTED_TOOL_FAILURE_CATEGORIES,
  NON_MATERIAL_TOOL_FAILURE_CATEGORIES,
  notReadyRecordedToolMissCategories,
  TOOL_FAILURE_DISPOSITIONS,
} from "../records/contracts.js";
import type {
  ProductDisposition,
  WorkflowOutcomeCandidateV1,
  WorkflowOutcomeEnvelopeV1,
  WorkflowOutcomeEvidenceV1,
  WorkflowOutcomeFindingV1,
  WorkflowOutcomeOpenDecisionV1,
  WorkflowBranchCoverageV1,
} from "./contracts.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;

/**
 * The grammar for every finding `code` and `limitations` entry. The editorial
 * assessment admission and response contract read this same pattern, so a
 * code its step admits can always become an outcome. Never widen it to admit a
 * code another contract let through.
 */
export const WORKFLOW_OUTCOME_CODE_GRAMMAR = /^[a-z0-9][a-z0-9.-]{0,127}$/u;

export function isWorkflowOutcomeCode(value: unknown): value is string {
  return typeof value === "string" && WORKFLOW_OUTCOME_CODE_GRAMMAR.test(value);
}
const DISPOSITIONS = [
  "ready",
  "not-ready",
  "needs-input",
  "inconclusive",
  "blocked",
] as const satisfies readonly ProductDisposition[];

/** Independent of draft applicability. */
export type OriginalRequestCompletionV1 = "complete" | "incomplete";

/** Host-held draft applicability. Not a ProductDisposition. */
export type DocumentationDraftApplicabilityV1 =
  | "useful-partial"
  | "scaffold-only"
  | "no-useful-deliverable"
  | "cancellation"
  | "execution-failure";

const FINDING_KINDS = [
  "product-gap",
  "missing-governed-input",
  "evidence-limitation",
  "blocked-dependency",
  "roadmap-gap",
] as const;
const SEVERITIES = ["info", "warning", "blocking"] as const;
const DECISION_KINDS = [
  "governed-input",
  "human-decision",
  "policy-approval",
  "dependency",
] as const;
/**
 * Re-exported from the record contract, its one source, so an outcome decodes
 * exactly the categories a record can carry.
 */
export { EXECUTED_TOOL_FAILURE_CATEGORIES };
const TOOL_FAILURE_CATEGORIES = TOOL_FAILURE_DISPOSITIONS;
/** Limitation that licenses in-policy withheld-tool categories on `not-ready`. */
export const EXPECTED_WITHHELD_TOOL_LIMITATION = "expected-withheld-tool";
/**
 * Host-reserved limitation for the run's recorded tool misses
 * (`notReadyRecordedToolMissCategories`). A `not-ready` outcome must carry it
 * when the run recorded one; no outcome may carry it otherwise.
 */
export const TOOL_MISSES_RECORDED_LIMITATION = "tool-misses-recorded";
/**
 * Host-reserved limitation for documentation sentences a citing write step
 * added with no verified source citation; the run record names each one by
 * page and line in `sourceCitations`.
 */
export const SOURCE_CITATION_GAPS_LIMITATION = "source-citation-gaps";
const EXPECTED_WITHHELD_TOOL_CATEGORIES = new Set([
  "denied-path",
  "governance-stop",
  "unknown-tool",
]);

export const WORKFLOW_OUTCOME_ERROR_CODES = [
  "invalid-outcome",
  "invalid-evidence",
  "contradictory-outcome",
  "execution-product-mismatch",
  "migration-required",
] as const;

export type WorkflowOutcomeErrorCode = (typeof WORKFLOW_OUTCOME_ERROR_CODES)[number];

/** The location a refusal carries when its rule reads the whole candidate or run. */
export const WORKFLOW_OUTCOME_ROOT_LOCATION = "$";

export class WorkflowOutcomeError extends Error {
  /**
   * The `$`-rooted candidate member the refusing rule read, such as
   * `$.findings[].code`. Array members are `[]`, never an index, so the
   * location does not reveal how much the candidate held. Non-enumerable, so an
   * error's identity stays its code.
   */
  public declare readonly location: string;

  public constructor(
    public readonly code: WorkflowOutcomeErrorCode,
    location: string = WORKFLOW_OUTCOME_ROOT_LOCATION,
  ) {
    super(`Workflow outcome rejected: ${code}.`);
    this.name = "WorkflowOutcomeError";
    Object.defineProperty(this, "location", {
      value: location,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
}

function fail(code: WorkflowOutcomeErrorCode, location?: string): never {
  throw new WorkflowOutcomeError(code, location);
}

/**
 * Run `check`, and give any refusal inside it that named no member of its own
 * the member `location`. The innermost `at` wins, so a rule nested in an
 * element check keeps its narrower location.
 */
function at<T>(location: string, check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (
      error instanceof WorkflowOutcomeError &&
      error.location === WORKFLOW_OUTCOME_ROOT_LOCATION
    ) {
      throw new WorkflowOutcomeError(error.code, location);
    }
    throw error;
  }
}

const OUTCOME_KIND = "docsfab-workflow-outcome" as const;
const OUTCOME_BODY_KEYS = [
  "disposition",
  "findings",
  "evidence",
  "limitations",
  "openDecisions",
  "producedArtifacts",
] as const;

const { assertInert, object, exact, array, rejectCredentials, seal, decodeSealed } =
  createContractKit({
    fail: fail as ContractFail<WorkflowOutcomeErrorCode>,
    inertMode: "strict",
    codes: {
      invalidShape: "invalid-outcome",
      invalidValue: "invalid-outcome",
      digestMismatch: "invalid-outcome",
      credentialMaterial: "invalid-outcome",
      schemaMismatch: "migration-required",
    },
  });

export interface WorkflowOutcomeExitPolicyV1 {
  schemaVersion: 1;
  mode: "interactive" | "release-gate";
  failOn: ProductDisposition[];
}

export type WorkflowOutcomeState =
  | { state: "legacy-no-product-disposition" }
  | { state: "current"; outcome: WorkflowOutcomeEnvelopeV1 };

export type RunRecordEditorialEvidenceV1 =
  | { state: "editorial-evidence-unavailable" }
  | { state: "current-preselection"; coverage: WorkflowBranchCoverageV1 }
  | {
      state: "current";
      candidate: EditorialDecisionPayloadV1;
      candidateReference: EditorialDecisionArtifactReferenceV3;
      validated?: EditorialDecisionPayloadV1;
      validatedReference?: EditorialDecisionArtifactReferenceV3;
      coverage: WorkflowBranchCoverageV1;
    };

export interface WorkflowOutcomeDecodeOptionsV1 {
  /** Must strictly decode retained decision bytes with actual producer evidence. */
  decodeEditorialDecision?: (
    reference: EditorialDecisionArtifactReferenceV3,
    stepId: string,
  ) => EditorialDecisionPayloadV1;
  /** Must invoke the runtime-owned manifest/path decoder. There is no accepting default. */
  decodeWorkflowBranchCoverage?: (
    value: unknown,
    record: Readonly<RunRecord>,
  ) => WorkflowBranchCoverageV1;
  /** Reconstructs override authorization; the decoder never imports security policy. */
  authorizeSecurityScan?: (
    report: NonNullable<RunRecord["securityScan"]>,
    overrides: readonly {
      ruleId: string;
      revision: string;
      reason: string;
      expiresAt: string;
    }[],
    expectedRevision: string,
    now: Date,
  ) => NonNullable<RunRecord["securityScanAuthorization"]>;
  /** When provided, the decoder reconstructs the disposition instead of trusting the record. */
  resolveSecurityScanEffectiveDisposition?: (
    report: NonNullable<RunRecord["securityScan"]>,
    authorization?: RunRecord["securityScanAuthorization"],
  ) => NonNullable<RunRecord["securityScanEffectiveDisposition"]>;
}

/** Content-free identity for a completed step used by a product finding. */
export function workflowOutcomeStepEvidence(
  record: RunRecord,
  stepId: string,
): Extract<WorkflowOutcomeEvidenceV1, { kind: "step" }> {
  const step = record.steps.find((candidate) => candidate.id === stepId);
  if (!step || !isTerminalStep(step.status)) fail("invalid-evidence");
  const body = {
    schemaVersion: 1,
    kind: "docsfab-workflow-outcome-step-evidence",
    repositoryRevision: record.repository.revision,
    workflow: record.workflow,
    stepId: step.id,
    skill: step.skill,
    mode: step.mode,
    status: step.status,
    summarySha256: step.summary === undefined ? null : sha256(step.summary),
    searchEvidenceSha256: step.searchEvidence?.evidenceSha256 ?? null,
    artifacts: (step.artifacts ?? []).map(contentFreeArtifactUse).sort(compareCanonical),
  };
  return {
    id: `step:${step.id}`,
    kind: "step",
    stepId: step.id,
    sha256: canonicalDigest(body),
  };
}

/** Exact target-level search evidence reference for a product finding. */
export function workflowOutcomeSearchEvidence(
  record: RunRecord,
  stepId: string,
  targetId: string,
): Extract<WorkflowOutcomeEvidenceV1, { kind: "search" }> {
  const step = record.steps.find((candidate) => candidate.id === stepId);
  const search = step?.searchEvidence?.searches.find(
    (candidate) => candidate.targetId === targetId,
  );
  if (
    !step ||
    !search ||
    search.bounded.target.repository.revision !== record.repository.revision ||
    search.progress.target.repository.revision !== record.repository.revision
  ) {
    fail("invalid-evidence");
  }
  return {
    id: `search:${stepId}:${targetId}`,
    kind: "search",
    stepId,
    targetId,
    sha256: search.bounded.evidenceSha256,
  };
}

/** Exact produced/consumed artifact reference already admitted by the run. */
export function workflowOutcomeArtifactEvidence(
  record: RunRecord,
  use: ArtifactUse,
): Extract<WorkflowOutcomeEvidenceV1, { kind: "artifact" }> {
  const admitted = (record.artifacts ?? []).find(
    (candidate) => canonicalJson(candidate) === canonicalJson(use),
  );
  if (!admitted?.stepId) fail("invalid-evidence");
  if (admitted.reference.repositoryRevision !== record.repository.revision) {
    fail("invalid-evidence");
  }
  const boundUse = { ...admitted, stepId: admitted.stepId };
  return {
    id: artifactEvidenceId(boundUse),
    kind: "artifact",
    stepId: boundUse.stepId,
    role: admitted.role,
    reference: structuredClone(admitted.reference),
  };
}

/** Seal and validate a harness-neutral product result against one exact run. */
export function createWorkflowOutcome(
  candidateValue: WorkflowOutcomeCandidateV1,
  record: RunRecord,
  options: WorkflowOutcomeDecodeOptionsV1 = {},
): WorkflowOutcomeEnvelopeV1 {
  assertInert(candidateValue);
  return seal(
    OUTCOME_KIND,
    "outcomeSha256",
    admitWorkflowOutcome(recordSourceCitationGaps(candidateValue, record), record, options),
  );
}

/**
 * Release projection gate: any execution or governance failure rejects the
 * artifact. The whole-repository credential scan is advisory and can neither
 * grant nor deny publication authority, so no scan disposition is required.
 */
export function assertSuccessfulGovernedWorkflowExecution(
  record: RunRecord,
  options: WorkflowOutcomeDecodeOptionsV1 = {},
): void {
  validateExecutionRecord(record, "ready", undefined, options);
  if (
    record.status !== "succeeded" ||
    record.tools.failedCalls !== 0 ||
    record.steps.some(
      (step) =>
        step.status !== "succeeded" ||
        step.contextPreflight?.status !== "ready" ||
        (step.tools?.failedCalls ?? 0) !== 0 ||
        (step.inference?.attempts ?? []).some(
          (attempt) => attempt.outcome !== "succeeded" || (attempt.tools?.failedCalls ?? 0) !== 0,
        ),
    )
  ) {
    fail("execution-product-mismatch");
  }
}

/** Strict decoder for persisted current records; unknown fields fail closed. */
export function decodeWorkflowOutcome(
  value: unknown,
  record: RunRecord,
  options: WorkflowOutcomeDecodeOptionsV1 = {},
): WorkflowOutcomeEnvelopeV1 {
  return decodeSealed(value, OUTCOME_KIND, "outcomeSha256", [...OUTCOME_BODY_KEYS], (body) =>
    admitWorkflowOutcome(body, record, options),
  );
}

/** A pre-outcome or result-use transition failed before product re-admission began. */
export class ReviewResultTransitionError extends Error {
  public constructor() {
    super("The retained review result did not match the admitted terminal run transition.");
    this.name = "ReviewResultTransitionError";
  }
}

/** Admit exactly one verified terminal result use after a previously sealed review outcome. */
export function resealWorkflowOutcomeAfterRetainedReviewResult(input: {
  readonly before: Readonly<RunRecord>;
  readonly after: RunRecord;
  readonly sourceReference: NonNullable<RunRecord["reviewDeliverySnapshot"]>;
  readonly resultUse: ArtifactUse;
  readonly options?: WorkflowOutcomeDecodeOptionsV1;
}): WorkflowOutcomeEnvelopeV1 {
  let transitionAdmitted = false;
  try {
    const before = structuredClone(input.before);
    if (
      before.workflow !== "review-documentation" ||
      before.status !== "succeeded" ||
      before.workflowOutcome === undefined
    )
      fail("invalid-evidence");
    const previous = decodeWorkflowOutcome(before.workflowOutcome, before, input.options);
    const step = before.steps.at(-1);
    if (
      step?.id !== "evaluate-document-quality" ||
      step.skill !== "evaluate-document-quality" ||
      step.kind !== "evaluate" ||
      step.mode !== "read-only" ||
      step.status !== "succeeded" ||
      before.steps.filter((item) => item.id === step.id).length !== 1 ||
      (before.artifacts ?? []).some((item) => item.reference.kind === "review-result") ||
      before.steps.some((item) =>
        (item.artifacts ?? []).some((use) => use.reference.kind === "review-result"),
      )
    )
      fail("invalid-evidence");
    // The result store strictly decoded this reference before returning its verified use.
    const source = input.sourceReference;
    if (
      source.runId !== before.id ||
      source.reviewedHeadSha !== before.repository.revision ||
      (before.reviewDeliverySnapshot !== undefined &&
        canonicalJson(before.reviewDeliverySnapshot) !== canonicalJson(source))
    )
      fail("invalid-evidence");
    const use = validateArtifactUse(input.resultUse);
    if (
      use.role !== "output" ||
      use.stepId !== step.id ||
      use.reference.kind !== "review-result" ||
      use.reference.repositoryRevision !== before.repository.revision ||
      use.reference.repositoryContentDigest !== source.snapshotSha256
    )
      fail("invalid-evidence");
    const expected = {
      ...before,
      reviewDeliverySnapshot: source,
      steps: before.steps.map((item, index) =>
        index === before.steps.length - 1
          ? { ...item, artifacts: [...(item.artifacts ?? []), use] }
          : item,
      ),
      artifacts: [...(before.artifacts ?? []), use],
    };
    if (canonicalJson(expected) !== canonicalJson(input.after)) fail("invalid-evidence");
    transitionAdmitted = true;
    const candidate: WorkflowOutcomeCandidateV1 = {
      disposition: previous.disposition,
      findings: previous.findings,
      evidence: previous.evidence.map((item) =>
        item.kind === "step" && item.stepId === step.id
          ? workflowOutcomeStepEvidence(input.after, step.id)
          : item,
      ),
      limitations: previous.limitations,
      openDecisions: previous.openDecisions,
      producedArtifacts: [...previous.producedArtifacts, use.reference],
    };
    const sealed = createWorkflowOutcome(candidate, input.after, input.options);
    return decodeWorkflowOutcome(sealed, input.after, input.options);
  } catch (error) {
    if (!transitionAdmitted) throw new ReviewResultTransitionError();
    throw error;
  }
}

function admitWorkflowOutcome(
  candidateValue: unknown,
  record: RunRecord,
  options: WorkflowOutcomeDecodeOptionsV1,
): WorkflowOutcomeCandidateV1 {
  // Each rule names the candidate member it checks, including rules that
  // compare a member with the run's evidence.
  const requestedDisposition = at("$.disposition", () =>
    choice(object(candidateValue).disposition, DISPOSITIONS),
  );
  const editorial = at("$.evidence", () => decodeRunRecordEditorialEvidence(record, options));
  at("$.disposition", () => {
    validateExecutionRecord(record, requestedDisposition, editorial, options);
    validateExecutionCombination(record.status, requestedDisposition, editorial);
  });
  const candidate = normalizeCandidate(candidateValue, record);
  at("$.disposition", () => validateDisposition(candidate));
  at("$.findings", () => {
    validateNotReadyToolFailures(candidate, record);
    validateRecordedToolMisses(candidate, record);
    validateSearchPrecedence(candidate, record);
    validateRoadmapBindings(candidate);
  });
  validateEditorialOutcome(candidate, editorial, record);
  return candidate;
}

/** Explicitly distinguish historical schema-v2 records from current outcomes. */
export function workflowOutcomeState(
  record: RunRecord,
  options: WorkflowOutcomeDecodeOptionsV1 = {},
): WorkflowOutcomeState {
  if (record.workflowOutcome === undefined) {
    return { state: "legacy-no-product-disposition" };
  }
  return {
    state: "current",
    outcome: decodeWorkflowOutcome(record.workflowOutcome, record, options),
  };
}

/**
 * Strict projection for operator, live, and host consumers. Historical absence
 * is explicit unavailable evidence, never an inferred no-change.
 */
export function decodeRunRecordEditorialEvidence(
  record: Readonly<RunRecord>,
  options: WorkflowOutcomeDecodeOptionsV1 = {},
): RunRecordEditorialEvidenceV1 {
  let coverage: WorkflowBranchCoverageV1 | undefined;
  if (record.workflowBranchCoverage !== undefined) {
    if (!options.decodeWorkflowBranchCoverage) fail("invalid-evidence");
    try {
      coverage = options.decodeWorkflowBranchCoverage(record.workflowBranchCoverage, record);
    } catch {
      return fail("invalid-evidence");
    }
    if (
      coverage.repositoryRevision !== record.repository.revision ||
      coverage.workflow !== record.workflow
    ) {
      fail("invalid-evidence");
    }
  }
  const uses = (record.artifacts ?? []).filter(
    (use) => use.role === "output" && use.reference.kind === "editorial-decision",
  );
  if (uses.length === 0) {
    if (coverage === undefined) return { state: "editorial-evidence-unavailable" };
    assertRunRecordEditorialLifetime(record.status, coverage, undefined, undefined);
    return { state: "current-preselection", coverage };
  }
  if (!options.decodeEditorialDecision) fail("invalid-evidence");
  const decisions = uses.map((use) => {
    if (!use.stepId || use.reference.schemaVersion !== 3) fail("invalid-evidence");
    const reference = use.reference as EditorialDecisionArtifactReferenceV3;
    let decision: EditorialDecisionPayloadV1;
    try {
      decision = options.decodeEditorialDecision!(reference, use.stepId);
    } catch {
      return fail("invalid-evidence");
    }
    if (
      decision.decisionSha256 !== reference.digest ||
      decision.repositoryRevision !== reference.repositoryRevision ||
      reference.repositoryRevision !== record.repository.revision ||
      (decision.phase === "candidate" && use.stepId !== "plan-documentation") ||
      (decision.phase === "validated" && use.stepId !== "evaluate-document-quality")
    ) {
      fail("invalid-evidence");
    }
    return { reference, decision };
  });
  const candidates = decisions.filter((item) => item.decision.phase === "candidate");
  const validated = decisions.filter((item) => item.decision.phase === "validated");
  if (candidates.length !== 1 || validated.length > 1) {
    fail("invalid-evidence");
  }
  const candidate = candidates[0]!;
  const final = validated[0];
  if (!coverage) fail("invalid-evidence");
  const completed = record.status === "succeeded" || outcomeRefusedAfterEveryStep(record);
  assertRunRecordEditorialLifetime(
    record.status,
    coverage,
    candidate.decision,
    final?.decision,
    completed,
  );
  const admittedPlanBindings = new Set(
    record.steps
      .filter((step) => step.id === "plan-documentation" && step.status === "succeeded")
      .flatMap((step) => (step.planBinding ? [step.planBinding.digest] : [])),
  );
  if (
    admittedPlanBindings.size !== 1 ||
    !admittedPlanBindings.has(candidate.decision.planBindingSha256) ||
    (final && !admittedPlanBindings.has(final.decision.planBindingSha256))
  ) {
    fail("invalid-evidence");
  }
  if (
    final &&
    canonicalJson(final.decision.candidateArtifact) !== canonicalJson(candidate.reference)
  ) {
    fail("invalid-evidence");
  }
  if (coverage.workspaceSnapshotSha256 !== candidate.decision.workspaceSnapshotSha256) {
    fail("invalid-evidence");
  }
  if (coverage.selection !== null) {
    if (
      canonicalJson(coverage.selection.candidateArtifact) !== canonicalJson(candidate.reference) ||
      (final && final.decision.branchCoverage?.coverageSha256 !== coverage.coverageSha256)
    ) {
      fail("invalid-evidence");
    }
  }
  if (final?.decision.candidate === "no-change") {
    if (
      record.workflow !== "update-documentation" ||
      !completed ||
      record.changes !== undefined ||
      record.impactPostflight !== undefined ||
      record.steps.some((step) => step.mode === "write") ||
      !coverage
    ) {
      fail("execution-product-mismatch");
    }
    if (
      coverage.selection?.branchId !== "assess-no-change" ||
      canonicalJson(coverage.selection.candidateArtifact) !== canonicalJson(candidate.reference) ||
      coverage.repositoryRevision !== final.decision.repositoryRevision ||
      coverage.workspaceSnapshotSha256 !== final.decision.workspaceSnapshotSha256
    ) {
      fail("invalid-evidence");
    }
  }
  return {
    state: "current",
    candidate: candidate.decision,
    candidateReference: candidate.reference,
    ...(final ? { validated: final.decision, validatedReference: final.reference } : {}),
    coverage,
  };
}

/**
 * Every step succeeded and the run failed only because its product outcome was
 * refused. Its completed editorial evidence stays readable, so operator
 * surfaces report the recorded refusal rather than a second `invalid-evidence`
 * error. No outcome is admitted for a failed run.
 */
function outcomeRefusedAfterEveryStep(record: Readonly<RunRecord>): boolean {
  return (
    record.status === "failed" &&
    record.workflowOutcomeRejection !== undefined &&
    record.steps.length > 0 &&
    record.steps.every((step) => step.status === "succeeded")
  );
}

function assertRunRecordEditorialLifetime(
  status: RunRecord["status"],
  coverage: WorkflowBranchCoverageV1,
  candidate: EditorialDecisionPayloadV1 | undefined,
  final: EditorialDecisionPayloadV1 | undefined,
  completed = status === "succeeded",
): void {
  const selected = coverage.selection?.branchId;
  if (!candidate) {
    if (final || selected !== undefined || !isEditorialPreselectionStatus(status)) {
      fail("invalid-evidence");
    }
    return;
  }
  if (selected === undefined) {
    if (
      final ||
      candidate.candidate !== "insufficient-evidence" ||
      !isEditorialSelectedPartialStatus(status)
    ) {
      fail("invalid-evidence");
    }
    return;
  }
  const expectedCandidate =
    selected === "author"
      ? "update"
      : selected === "assess-no-change"
        ? "no-change"
        : fail("invalid-evidence");
  if (candidate.candidate !== expectedCandidate) fail("invalid-evidence");
  if (final) {
    if (!completed) fail("invalid-evidence");
    return;
  }
  if (!isEditorialSelectedPartialStatus(status)) fail("invalid-evidence");
}

function validateEditorialOutcome(
  outcome: WorkflowOutcomeCandidateV1,
  editorial: RunRecordEditorialEvidenceV1,
  record: RunRecord,
): void {
  if (
    editorial.state === "editorial-evidence-unavailable" ||
    editorial.state === "current-preselection"
  ) {
    return;
  }
  const final = editorial.validated;
  if (!final) {
    if (
      editorial.candidate.candidate === "no-change" &&
      (outcome.disposition !== "inconclusive" ||
        !outcome.limitations.includes("insufficient-evidence"))
    ) {
      fail("contradictory-outcome", "$.limitations[]");
    }
    return;
  }
  const coverage = editorial.coverage;
  if (!coverage?.selection) fail("invalid-evidence", "$.evidence");
  for (const stepId of coverage.requiredStepIds) {
    const expected = workflowOutcomeStepEvidence(record, stepId);
    const found = outcome.evidence.some(
      (evidence) => evidence.kind === "step" && canonicalJson(evidence) === canonicalJson(expected),
    );
    if (!found) fail("invalid-evidence", "$.evidence[]");
  }
  const requiredReferences = [editorial.candidateReference, editorial.validatedReference!];
  for (const reference of requiredReferences) {
    const found = outcome.evidence.some(
      (evidence) =>
        evidence.kind === "artifact" &&
        canonicalJson(evidence.reference) === canonicalJson(reference),
    );
    if (!found) fail("invalid-evidence", "$.evidence[]");
  }
  if (final.candidate === "update") {
    const reversed = editorial.candidate.candidate !== "update";
    const gapCodes = final.limitations.filter((code) => code.startsWith("product-gap."));
    if (!reversed && gapCodes.length === 0) {
      if (outcome.disposition !== "inconclusive") fail("contradictory-outcome", "$.disposition");
      return;
    }
    const finalEvidence = outcome.evidence.find(
      (evidence) =>
        evidence.kind === "artifact" &&
        canonicalJson(evidence.reference) === canonicalJson(editorial.validatedReference),
    );
    const supportedGap = outcome.findings.some(
      (finding) =>
        finding.kind === "product-gap" &&
        finding.severity === "blocking" &&
        gapCodes.includes(finding.code) &&
        finalEvidence !== undefined &&
        finding.evidenceIds.includes(finalEvidence.id),
    );
    if (outcome.disposition !== "not-ready") fail("contradictory-outcome", "$.disposition");
    if (!supportedGap) fail("contradictory-outcome", "$.findings[]");
    return;
  }
  if (outcome.disposition !== "inconclusive") fail("contradictory-outcome", "$.disposition");
  if (final.candidate === "insufficient-evidence" && final.limitations.length === 0) {
    fail("contradictory-outcome", "$.limitations");
  }
  // The host owns `source-citation-gaps`: `recordSourceCitationGaps` replaces or
  // drops a model-authored copy, so the decision's copy is not required here.
  const required = final.limitations.filter(
    (code) => !code.startsWith("product-gap.") && code !== SOURCE_CITATION_GAPS_LIMITATION,
  );
  for (const limitation of required) {
    const finding = outcome.findings.find(
      (candidate) =>
        candidate.kind === "evidence-limitation" &&
        candidate.severity === "warning" &&
        candidate.code === limitation,
    );
    if (!outcome.limitations.includes(limitation)) {
      fail("contradictory-outcome", "$.limitations[]");
    }
    if (!finding) fail("contradictory-outcome", "$.findings[]");
  }
}

function isEditorialPreselectionStatus(status: RunRecord["status"]): boolean {
  return (
    status === "queued" ||
    status === "running" ||
    status === "failed" ||
    status === "needs-input" ||
    status === "needs-human-decision"
  );
}

function isEditorialSelectedPartialStatus(status: RunRecord["status"]): boolean {
  return (
    status === "running" ||
    status === "failed" ||
    status === "needs-input" ||
    status === "needs-human-decision"
  );
}

/** Honest default until a workflow-specific typed product projector is configured. */
export function defaultInconclusiveWorkflowOutcome(record: RunRecord): WorkflowOutcomeCandidateV1 {
  if (record.status !== "succeeded") fail("execution-product-mismatch");
  const terminal = [...record.steps].reverse().find((step) => isTerminalStep(step.status));
  if (!terminal) fail("invalid-evidence");
  const evidence = workflowOutcomeStepEvidence(record, terminal.id);
  return {
    disposition: "inconclusive",
    findings: [
      {
        id: "finding:structured-product-evidence-unavailable",
        kind: "evidence-limitation",
        severity: "warning",
        code: "structured-product-evidence-unavailable",
        evidenceIds: [evidence.id],
      },
    ],
    evidence: [evidence],
    limitations: ["structured-product-evidence-unavailable"],
    openDecisions: [],
    producedArtifacts: recordOutputArtifacts(record),
  };
}

export function interactiveWorkflowOutcomePolicy(): WorkflowOutcomeExitPolicyV1 {
  return { schemaVersion: 1, mode: "interactive", failOn: [] };
}

export function releaseGateWorkflowOutcomePolicy(): WorkflowOutcomeExitPolicyV1 {
  return {
    schemaVersion: 1,
    mode: "release-gate",
    failOn: ["blocked", "inconclusive", "needs-input", "not-ready"],
  };
}

/** 1 is execution failure; 2 is a successful execution rejected by product policy. */
export function workflowOutcomeExitCode(
  record: RunRecord,
  policyValue: WorkflowOutcomeExitPolicyV1,
  options: WorkflowOutcomeDecodeOptionsV1 = {},
): 0 | 1 | 2 {
  const policy = validateExitPolicy(policyValue);
  if (record.status === "failed" || record.status === "queued" || record.status === "running") {
    return 1;
  }
  const state = workflowOutcomeState(record, options);
  if (state.state === "legacy-no-product-disposition") {
    return policy.mode === "release-gate" ? 2 : 0;
  }
  return policy.failOn.includes(state.outcome.disposition) ? 2 : 0;
}

const OPERATOR_FACING_WEB_URL = /\bhttps?:\/\/[^\s"'`,)]+/giu;
const OPERATOR_FACING_PATH =
  /(?:^|[\s"'`(=:])(?:\/[^\s"'`,)]+|[A-Za-z]:[\\/][^\s"'`,)]+|~[\\/][^\s"'`,)]+|\\\\[^\s"'`,)]+|file:\/\/[^\s"'`,)]+)/gu;
const OPERATOR_FACING_HASH = /\b[a-f0-9]{64}\b/giu;

/** Redact path-shaped, URL, and hash tokens without deleting `why` or `label`. */
export function redactOperatorFacingSummaryV1(summary: string): string {
  const withoutUrls = summary.replace(OPERATOR_FACING_WEB_URL, "[redacted-url]");
  try {
    const parsed: unknown = JSON.parse(withoutUrls);
    if (parsed && typeof parsed === "object") {
      return JSON.stringify(redactOperatorFacingValue(parsed));
    }
  } catch {
    // Keep the operator-facing sentence and redact tokens in place.
  }
  return redactOperatorFacingTokens(withoutUrls);
}

function redactOperatorFacingValue(value: unknown): unknown {
  if (typeof value === "string") return redactOperatorFacingTokens(value);
  if (Array.isArray(value)) return value.map(redactOperatorFacingValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      redactOperatorFacingValue(nested),
    ]),
  );
}

function redactOperatorFacingTokens(text: string): string {
  return text
    .replace(OPERATOR_FACING_HASH, "[redacted-digest]")
    .replace(OPERATOR_FACING_PATH, (match) => {
      const prefix = /^[\s"'`(=:]/u.test(match[0] ?? "") ? match[0] : "";
      return `${prefix}[redacted-path]`;
    });
}

function normalizeCandidate(value: unknown, record: RunRecord): WorkflowOutcomeCandidateV1 {
  const root = object(value);
  exact(root, [...OUTCOME_BODY_KEYS]);
  rejectCredentials(value);
  const disposition = at("$.disposition", () => choice(root.disposition, DISPOSITIONS));
  const evidence = at("$.evidence", () =>
    array(root.evidence)
      .map((item) => at("$.evidence[]", () => normalizeEvidence(item, record)))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
  unique(
    evidence.map((item) => item.id),
    "invalid-evidence",
    "$.evidence[].id",
  );
  if (evidence.length === 0 || evidence.length > 256) fail("invalid-evidence", "$.evidence");
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const findings = at("$.findings", () =>
    array(root.findings)
      .map((item) => normalizeFinding(item, evidenceIds))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
  unique(
    findings.map((item) => item.id),
    "invalid-outcome",
    "$.findings[].id",
  );
  const limitations = at("$.limitations", () =>
    array(root.limitations)
      .map((item) => at("$.limitations[]", () => safeCode(item)))
      .sort((left, right) => left.localeCompare(right)),
  );
  unique(limitations, "invalid-outcome", "$.limitations[]");
  const openDecisions = at("$.openDecisions", () =>
    array(root.openDecisions)
      .map((item) => normalizeDecision(item, evidenceIds))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
  unique(
    openDecisions.map((item) => item.id),
    "invalid-outcome",
    "$.openDecisions[].id",
  );
  if (disposition !== "ready") {
    const usedEvidence = new Set([
      ...findings.flatMap((item) => item.evidenceIds),
      ...openDecisions.flatMap((item) => item.evidenceIds),
    ]);
    if (evidence.some((item) => !usedEvidence.has(item.id))) {
      fail("invalid-evidence", "$.evidence[].id");
    }
  }
  const limitationCodes = new Set(
    findings.filter((item) => item.kind === "evidence-limitation").map((item) => item.code),
  );
  if (limitations.some((code) => !limitationCodes.has(code))) {
    fail("invalid-outcome", "$.limitations[]");
  }
  const producedArtifacts = at("$.producedArtifacts", () =>
    array(root.producedArtifacts)
      .map((item) => {
        try {
          return validateArtifactReference(item);
        } catch {
          return fail("invalid-evidence", "$.producedArtifacts[]");
        }
      })
      .sort(compareCanonical),
  );
  unique(
    producedArtifacts.map((item) => canonicalJson(item)),
    "invalid-evidence",
    "$.producedArtifacts[]",
  );
  for (const reference of producedArtifacts) {
    const admitted = (record.artifacts ?? []).some(
      (use) => use.role === "output" && canonicalJson(use.reference) === canonicalJson(reference),
    );
    if (!admitted) fail("invalid-evidence", "$.producedArtifacts[]");
  }
  if (canonicalJson(producedArtifacts) !== canonicalJson(recordOutputArtifacts(record))) {
    fail("invalid-evidence", "$.producedArtifacts");
  }
  if (
    findings.length > 256 ||
    limitations.length > 256 ||
    openDecisions.length > 256 ||
    producedArtifacts.length > 256
  )
    fail("invalid-outcome");
  return { disposition, findings, evidence, limitations, openDecisions, producedArtifacts };
}

function normalizeEvidence(value: unknown, record: RunRecord): WorkflowOutcomeEvidenceV1 {
  const item = object(value);
  if (item.kind === "step") {
    exact(item, ["id", "kind", "stepId", "sha256"]);
    const expected = workflowOutcomeStepEvidence(record, safeId(item.stepId));
    if (item.id !== expected.id || item.sha256 !== expected.sha256) fail("invalid-evidence");
    return expected;
  }
  if (item.kind === "search") {
    exact(item, ["id", "kind", "stepId", "targetId", "sha256"]);
    const expected = workflowOutcomeSearchEvidence(
      record,
      safeId(item.stepId),
      safeId(item.targetId),
    );
    if (item.id !== expected.id || item.sha256 !== expected.sha256) fail("invalid-evidence");
    return expected;
  }
  if (item.kind === "artifact") {
    exact(item, ["id", "kind", "stepId", "role", "reference"]);
    const reference = (() => {
      try {
        return validateArtifactReference(item.reference);
      } catch {
        return fail("invalid-evidence");
      }
    })();
    const stepId = safeId(item.stepId);
    const role = choice(item.role, ["input", "output"] as const);
    const use: ArtifactUse = { role, stepId, reference };
    const expected = workflowOutcomeArtifactEvidence(record, use);
    if (item.id !== expected.id) fail("invalid-evidence");
    return expected;
  }
  return fail("invalid-evidence");
}

function normalizeFinding(
  value: unknown,
  admittedEvidence: ReadonlySet<string>,
): WorkflowOutcomeFindingV1 {
  return at("$.findings[]", () => {
    const item = object(value);
    exact(item, ["id", "kind", "severity", "code", "inputId", "evidenceIds"], ["inputId"]);
    const kind = at("$.findings[].kind", () => choice(item.kind, FINDING_KINDS));
    const inputId = at("$.findings[].inputId", () =>
      item.inputId === undefined ? undefined : safeId(item.inputId),
    );
    if ((kind === "missing-governed-input") !== (inputId !== undefined)) {
      fail("invalid-outcome", "$.findings[].inputId");
    }
    const evidenceIds = at("$.findings[].evidenceIds", () =>
      normalizeEvidenceIds(item.evidenceIds, admittedEvidence),
    );
    return {
      id: at("$.findings[].id", () => safeId(item.id)),
      kind,
      severity: at("$.findings[].severity", () => choice(item.severity, SEVERITIES)),
      code: at("$.findings[].code", () => safeCode(item.code)),
      ...(inputId === undefined ? {} : { inputId }),
      evidenceIds,
    };
  });
}

function normalizeEvidenceIds(value: unknown, admittedEvidence: ReadonlySet<string>): string[] {
  const evidenceIds = array(value)
    .map((entry) => safeId(entry))
    .sort((left, right) => left.localeCompare(right));
  unique(evidenceIds, "invalid-evidence");
  if (evidenceIds.length === 0 || evidenceIds.some((id) => !admittedEvidence.has(id))) {
    fail("invalid-evidence");
  }
  return evidenceIds;
}

function normalizeDecision(
  value: unknown,
  admittedEvidence: ReadonlySet<string>,
): WorkflowOutcomeOpenDecisionV1 {
  return at("$.openDecisions[]", () => {
    const item = object(value);
    exact(item, ["id", "kind", "inputId", "evidenceIds"], ["inputId"]);
    const kind = at("$.openDecisions[].kind", () => choice(item.kind, DECISION_KINDS));
    const inputId = at("$.openDecisions[].inputId", () =>
      item.inputId === undefined ? undefined : safeId(item.inputId),
    );
    if ((kind === "governed-input") !== (inputId !== undefined)) {
      fail("invalid-outcome", "$.openDecisions[].inputId");
    }
    const evidenceIds = at("$.openDecisions[].evidenceIds", () =>
      normalizeEvidenceIds(item.evidenceIds, admittedEvidence),
    );
    return {
      id: at("$.openDecisions[].id", () => safeId(item.id)),
      kind,
      ...(inputId === undefined ? {} : { inputId }),
      evidenceIds,
    };
  });
}

function validateDisposition(candidate: WorkflowOutcomeCandidateV1): void {
  const kinds = new Set(candidate.findings.map((finding) => finding.kind));
  const blocking = candidate.findings.filter((finding) => finding.severity === "blocking");
  switch (candidate.disposition) {
    case "ready":
      if (
        candidate.findings.length > 0 ||
        candidate.limitations.length > 0 ||
        candidate.openDecisions.length > 0
      )
        fail("contradictory-outcome");
      break;
    case "not-ready":
      if (
        blocking.length === 0 ||
        !blocking.some(
          (finding) => finding.kind === "product-gap" || finding.kind === "roadmap-gap",
        ) ||
        kinds.has("missing-governed-input")
      )
        fail("contradictory-outcome");
      break;
    case "needs-input":
      if (!kinds.has("missing-governed-input") || !exactGovernedInputBindings(candidate)) {
        fail("contradictory-outcome");
      }
      break;
    case "inconclusive":
      if (
        !kinds.has("evidence-limitation") ||
        candidate.limitations.length === 0 ||
        blocking.some((finding) => finding.kind === "product-gap" || finding.kind === "roadmap-gap")
      ) {
        fail("contradictory-outcome");
      }
      break;
    case "blocked":
      if (
        !kinds.has("blocked-dependency") ||
        blocking.length === 0 ||
        !candidate.openDecisions.some(
          (decision) =>
            decision.kind === "dependency" ||
            decision.kind === "policy-approval" ||
            decision.kind === "human-decision",
        )
      )
        fail("contradictory-outcome");
      break;
  }
}

/**
 * A `not-ready` outcome fails on a material tool failure. Recorded tool misses
 * are not material to it; `validateRecordedToolMisses` requires the outcome to
 * name them instead.
 */
function validateNotReadyToolFailures(
  candidate: WorkflowOutcomeCandidateV1,
  record: RunRecord,
): void {
  if (candidate.disposition !== "not-ready") return;
  const withheldLicensed = candidate.limitations.includes(EXPECTED_WITHHELD_TOOL_LIMITATION);
  if (notReadyMaterialToolFailures(record, withheldLicensed).length > 0) {
    fail("execution-product-mismatch");
  }
}

/** A step whose tool evidence a `not-ready` outcome cannot carry. */
export interface NotReadyMaterialToolFailure {
  readonly stepId: string;
  /** Distinct and sorted. */
  readonly categories: readonly ToolFailureDisposition[];
}

/**
 * The steps whose tool evidence carries a category material to a `not-ready`
 * outcome, each with those categories: not non-material, not a recorded miss
 * for the step's mode, and, when `withheldLicensed`, not licensed by
 * `expected-withheld-tool`. The run total is not read: `validateExecutionRecord`
 * holds it equal to the sum of the step totals, and only a step knows its mode.
 */
export function notReadyMaterialToolFailures(
  record: RunRecord,
  withheldLicensed = false,
): NotReadyMaterialToolFailure[] {
  return record.steps.flatMap((step) => {
    const misses = notReadyRecordedToolMissCategories(step.mode);
    const categories = new Set<ToolFailureDisposition>();
    for (const summary of stepToolSummaries(step)) {
      for (const entry of summary.failureCategories ?? []) {
        if (NON_MATERIAL_TOOL_FAILURE_CATEGORIES.includes(entry.category)) continue;
        if (misses.includes(entry.category)) continue;
        if (withheldLicensed && EXPECTED_WITHHELD_TOOL_CATEGORIES.has(entry.category)) continue;
        categories.add(entry.category);
      }
    }
    return categories.size === 0
      ? []
      : [
          {
            stepId: step.id,
            categories: [...categories].sort((left, right) => left.localeCompare(right)),
          },
        ];
  });
}

/**
 * The categories `step` records as `not-ready` tool misses. When the outcome
 * carries `expected-withheld-tool`, that limitation licenses its own
 * categories, so they are not counted as misses too.
 */
function recordedToolMissCategories(
  step: RunRecord["steps"][number],
  candidate: WorkflowOutcomeCandidateV1,
): readonly string[] {
  const misses = notReadyRecordedToolMissCategories(step.mode);
  return candidate.limitations.includes(EXPECTED_WITHHELD_TOOL_LIMITATION)
    ? misses.filter((category) => !EXPECTED_WITHHELD_TOOL_CATEGORIES.has(category))
    : misses;
}

/** A step's own tool summary and each of its attempts' summaries. */
function stepToolSummaries(step: RunRecord["steps"][number]): ToolActivitySummary[] {
  return [
    ...(step.tools === undefined ? [] : [step.tools]),
    ...(step.inference?.attempts ?? []).flatMap((attempt) =>
      attempt.tools === undefined ? [] : [attempt.tools],
    ),
  ];
}

/**
 * The run's recorded tool misses cannot be hidden from a `not-ready` outcome:
 * its `tool-misses-recorded` finding cites every step that recorded one. No
 * outcome may claim misses the run did not record.
 */
function validateRecordedToolMisses(
  candidate: WorkflowOutcomeCandidateV1,
  record: RunRecord,
): void {
  const steps = stepsWithRecordedToolMisses(record, candidate);
  const claimed = candidate.limitations.includes(TOOL_MISSES_RECORDED_LIMITATION);
  if (claimed && steps.length === 0) fail("execution-product-mismatch", "$.limitations[]");
  if (candidate.disposition !== "not-ready" || steps.length === 0) return;
  if (!claimed) fail("execution-product-mismatch", "$.limitations");
  // The limitation's finding exists: `normalizeCandidate` requires one per code.
  const cited = new Set(
    candidate.findings
      .filter(
        (finding) =>
          finding.kind === "evidence-limitation" &&
          finding.code === TOOL_MISSES_RECORDED_LIMITATION,
      )
      .flatMap((finding) => finding.evidenceIds),
  );
  for (const step of steps) {
    if (!cited.has(workflowOutcomeStepEvidence(record, step.id).id)) {
      fail("execution-product-mismatch", "$.findings[].evidenceIds");
    }
  }
}

/** Steps whose own or attempt tool evidence records a `not-ready` tool miss. */
function stepsWithRecordedToolMisses(
  record: RunRecord,
  candidate: WorkflowOutcomeCandidateV1,
): RunRecord["steps"] {
  return record.steps.filter((step) => {
    const misses = recordedToolMissCategories(step, candidate);
    return stepToolSummaries(step).some((summary) =>
      (summary.failureCategories ?? []).some((entry) => misses.includes(entry.category)),
    );
  });
}

/**
 * Add the `tool-misses-recorded` limitation to a `not-ready` candidate whose
 * run recorded model tool misses, citing each affected step. Any other
 * candidate, or one that already carries the limitation, is returned as is.
 */
export function recordNotReadyToolMisses(
  candidate: WorkflowOutcomeCandidateV1,
  record: RunRecord,
): WorkflowOutcomeCandidateV1 {
  if (
    candidate.disposition !== "not-ready" ||
    candidate.limitations.includes(TOOL_MISSES_RECORDED_LIMITATION)
  ) {
    return candidate;
  }
  const steps = stepsWithRecordedToolMisses(record, candidate);
  if (steps.length === 0) return candidate;
  const evidence = steps.map((step) => workflowOutcomeStepEvidence(record, step.id));
  const held = new Set(candidate.evidence.map((item) => item.id));
  return {
    ...candidate,
    findings: [
      ...candidate.findings,
      {
        id: `finding:${TOOL_MISSES_RECORDED_LIMITATION}`,
        kind: "evidence-limitation",
        severity: "warning",
        code: TOOL_MISSES_RECORDED_LIMITATION,
        evidenceIds: evidence.map((item) => item.id),
      },
    ],
    evidence: [...candidate.evidence, ...evidence.filter((item) => !held.has(item.id))],
    limitations: [...candidate.limitations, TOOL_MISSES_RECORDED_LIMITATION],
  };
}

/** A candidate whose members the label can read; anything else is left to admission. */
function labelableCandidate(value: unknown): value is WorkflowOutcomeCandidateV1 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Record<keyof WorkflowOutcomeCandidateV1, unknown>>;
  return (
    typeof candidate.disposition === "string" &&
    Array.isArray(candidate.findings) &&
    Array.isArray(candidate.evidence) &&
    Array.isArray(candidate.limitations) &&
    Array.isArray(candidate.openDecisions) &&
    candidate.findings.every(
      (finding) => !!finding && typeof finding === "object" && Array.isArray(finding.evidenceIds),
    ) &&
    candidate.openDecisions.every(
      (decision) =>
        !!decision && typeof decision === "object" && Array.isArray(decision.evidenceIds),
    )
  );
}

/**
 * The host's `source-citation-gaps` label. Any copy the candidate carries is
 * replaced by one built from the record: present, citing each citing write step
 * that left added sentences uncited, exactly when the record holds such a step.
 * A `ready` candidate that gains it becomes `inconclusive`, because an
 * unverified claim is never ready. `createWorkflowOutcome` applies it, so every
 * outcome path carries the label and no model output can supply or suppress it.
 * It never refuses: a copy whose removal would leave an `inconclusive` candidate
 * without any evidence limitation is kept.
 */
export function recordSourceCitationGaps(
  candidate: WorkflowOutcomeCandidateV1,
  record: RunRecord,
): WorkflowOutcomeCandidateV1 {
  if (!labelableCandidate(candidate)) return candidate;
  const carried = candidate.findings.filter(
    (finding) => finding.code === SOURCE_CITATION_GAPS_LIMITATION,
  );
  let base = candidate;
  if (carried.length > 0 || candidate.limitations.includes(SOURCE_CITATION_GAPS_LIMITATION)) {
    const findings = candidate.findings.filter(
      (finding) => finding.code !== SOURCE_CITATION_GAPS_LIMITATION,
    );
    const used = new Set([
      ...findings.flatMap((finding) => finding.evidenceIds),
      ...candidate.openDecisions.flatMap((decision) => decision.evidenceIds),
    ]);
    const freed = new Set(
      carried.flatMap((finding) => finding.evidenceIds).filter((id) => !used.has(id)),
    );
    base = {
      ...candidate,
      findings,
      evidence: candidate.evidence.filter((item) => !freed.has(item.id)),
      limitations: candidate.limitations.filter((code) => code !== SOURCE_CITATION_GAPS_LIMITATION),
    };
  }
  const gapSteps = (record.sourceCitations?.steps ?? []).filter(
    (step) => (step.uncitedClaims?.length ?? 0) > 0,
  );
  if (gapSteps.length === 0) {
    const emptied =
      base.disposition === "inconclusive" &&
      !base.findings.some((finding) => finding.kind === "evidence-limitation");
    return emptied ? candidate : base;
  }
  const evidence = gapSteps.map((step) => workflowOutcomeStepEvidence(record, step.stepId));
  const held = new Set(base.evidence.map((item) => item.id));
  return {
    ...base,
    disposition: base.disposition === "ready" ? "inconclusive" : base.disposition,
    findings: [
      ...base.findings,
      {
        id: `finding:${SOURCE_CITATION_GAPS_LIMITATION}`,
        kind: "evidence-limitation",
        severity: "warning",
        code: SOURCE_CITATION_GAPS_LIMITATION,
        evidenceIds: evidence.map((item) => item.id),
      },
    ],
    evidence: [...base.evidence, ...evidence.filter((item) => !held.has(item.id))],
    limitations: [...base.limitations, SOURCE_CITATION_GAPS_LIMITATION],
  };
}

function validateSearchPrecedence(candidate: WorkflowOutcomeCandidateV1, record: RunRecord): void {
  const dispositions = candidate.evidence.flatMap((reference) => {
    if (reference.kind !== "search") return [];
    const step = record.steps.find((item) => item.id === reference.stepId);
    const search = step?.searchEvidence?.searches.find(
      (item) => item.targetId === reference.targetId,
    );
    const disposition = search?.bounded.confidence.disposition;
    return disposition ? [disposition] : fail("invalid-evidence");
  });
  if (dispositions.length === 0) return;
  const incomplete = dispositions.some(
    (item) => item === "search-incomplete" || item === "stopped-no-progress",
  );
  const hardCeiling = dispositions.includes("stopped-hard-ceiling");
  const blocked = dispositions.some((item) => item === "search-blocked");
  switch (candidate.disposition) {
    case "ready":
      if (dispositions.some((item) => item !== "found")) fail("contradictory-outcome");
      break;
    case "not-ready":
      if (incomplete || hardCeiling || blocked) fail("contradictory-outcome");
      break;
    case "needs-input":
      if (blocked || hardCeiling) {
        fail("contradictory-outcome");
      }
      break;
    case "inconclusive":
      if (!incomplete || hardCeiling || blocked) fail("contradictory-outcome");
      break;
    case "blocked":
      if (!blocked && !hardCeiling) {
        fail("contradictory-outcome");
      }
      break;
  }
}

function exactGovernedInputBindings(candidate: WorkflowOutcomeCandidateV1): boolean {
  const findings = candidate.findings.filter(
    (finding) => finding.kind === "missing-governed-input",
  );
  const decisions = candidate.openDecisions.filter(
    (decision) => decision.kind === "governed-input",
  );
  if (findings.length !== decisions.length || findings.length === 0) return false;
  if (
    new Set(findings.map((finding) => finding.inputId)).size !== findings.length ||
    new Set(decisions.map((decision) => decision.inputId)).size !== decisions.length
  ) {
    return false;
  }
  return (
    findings.every((finding) =>
      decisions.some(
        (decision) =>
          decision.inputId === finding.inputId &&
          canonicalJson(decision.evidenceIds) === canonicalJson(finding.evidenceIds),
      ),
    ) &&
    decisions.every((decision) =>
      findings.some(
        (finding) =>
          finding.inputId === decision.inputId &&
          canonicalJson(finding.evidenceIds) === canonicalJson(decision.evidenceIds),
      ),
    )
  );
}

function validateRoadmapBindings(candidate: WorkflowOutcomeCandidateV1): void {
  const byId = new Map(candidate.evidence.map((item) => [item.id, item]));
  for (const finding of candidate.findings) {
    if (finding.kind !== "roadmap-gap") continue;
    const hasLedger = finding.evidenceIds.some((id) => {
      const evidence = byId.get(id);
      return evidence?.kind === "artifact" && evidence.reference.kind === "roadmap-ledger";
    });
    if (!hasLedger) fail("invalid-evidence");
  }
}

function validateExecutionCombination(
  status: RunRecord["status"],
  disposition: ProductDisposition,
  editorial?: RunRecordEditorialEvidenceV1,
): void {
  const valid =
    status === "succeeded" ||
    (status === "needs-input" && disposition === "needs-input") ||
    (status === "needs-input" &&
      disposition === "inconclusive" &&
      editorial?.state === "current" &&
      editorial.candidate.candidate === "insufficient-evidence" &&
      editorial.validated === undefined &&
      editorial.coverage.selection === null) ||
    (status === "needs-human-decision" &&
      (disposition === "needs-input" || disposition === "blocked"));
  if (!valid) fail("execution-product-mismatch");
}

function validateExecutionRecord(
  record: RunRecord,
  disposition: ProductDisposition,
  editorial?: RunRecordEditorialEvidenceV1,
  options: WorkflowOutcomeDecodeOptionsV1 = {},
): void {
  if (
    record.status === "succeeded" &&
    (record.error !== undefined ||
      record.steps.length === 0 ||
      record.steps.some((step) => step.status !== "succeeded"))
  ) {
    fail("execution-product-mismatch");
  }
  if (
    record.status === "needs-input" &&
    !record.steps.some((step) => step.status === "needs-input") &&
    !(
      editorial?.state === "current" &&
      editorial.candidate.candidate === "insufficient-evidence" &&
      editorial.validated === undefined &&
      editorial.coverage.selection === null
    )
  ) {
    fail("execution-product-mismatch");
  }
  if (
    record.status === "needs-human-decision" &&
    !record.steps.some((step) => step.status === "needs-human-decision")
  ) {
    fail("execution-product-mismatch");
  }
  validateScannerEvidence(record, options);
  validateToolSummary(record.tools, disposition);
  for (const step of record.steps) {
    if (step.inference !== undefined) validateInferenceEvidence(step.inference, step);
    const inferenceOutcome = step.inference?.attempts.at(-1)?.outcome;
    if (
      step.status === "succeeded" &&
      inferenceOutcome !== undefined &&
      inferenceOutcome !== "succeeded"
    )
      fail("execution-product-mismatch");
    if (step.tools !== undefined) validateToolSummary(step.tools, disposition);
    for (const attempt of step.inference?.attempts ?? []) {
      if (attempt.tools !== undefined) validateToolSummary(attempt.tools, disposition);
    }
  }
  const stepTools = record.steps.flatMap((step) => (step.tools === undefined ? [] : [step.tools]));
  if (
    canonicalJson(normalizeToolSummary(record.tools)) !==
    canonicalJson(aggregateToolSummaries(stepTools))
  ) {
    fail("execution-product-mismatch");
  }
  for (const step of record.steps) {
    if (step.inference === undefined) continue;
    const attemptTools = step.inference.attempts.flatMap((attempt) =>
      attempt.tools === undefined ? [] : [attempt.tools],
    );
    const stepSummary =
      step.tools === undefined ? aggregateToolSummaries([]) : normalizeToolSummary(step.tools);
    if (canonicalJson(stepSummary) !== canonicalJson(aggregateToolSummaries(attemptTools))) {
      fail("execution-product-mismatch");
    }
  }
}

function validateScannerEvidence(record: RunRecord, options: WorkflowOutcomeDecodeOptionsV1): void {
  const report = record.securityScan;
  const effective = record.securityScanEffectiveDisposition;
  const authorization = record.securityScanAuthorization;
  if (report === undefined) {
    if (effective !== undefined || authorization !== undefined) {
      fail("execution-product-mismatch");
    }
    return;
  }
  // An advisory scan carries no product authority, so its content-free report
  // (including the scanner-unavailable sentinel) needs no strict check here.
  if (effective?.status === "advisory") {
    if (authorization !== undefined) fail("execution-product-mismatch");
    return;
  }
  if (
    !(["passed", "blocked", "failed"] as const).includes(report.status) ||
    !nonnegativeInteger(report.scannedFiles) ||
    !nonnegativeInteger(report.binaryFiles) ||
    report.binaryFiles > report.scannedFiles ||
    !Array.isArray(report.findings) ||
    (report.status === "passed" && report.findings.length !== 0) ||
    (report.status === "blocked" && report.findings.length === 0)
  ) {
    fail("execution-product-mismatch");
  }
  const authorize = options.authorizeSecurityScan;
  const resolveDisposition = options.resolveSecurityScanEffectiveDisposition;
  // A recorded non-advisory disposition is untrusted; omitting either policy
  // callback fails closed rather than turning the retained value into authority.
  if (!authorize || !resolveDisposition) {
    fail("execution-product-mismatch");
  }
  for (const finding of report.findings) {
    if (
      typeof finding.path !== "string" ||
      finding.path.length === 0 ||
      finding.path.startsWith("/") ||
      finding.path.includes("\\") ||
      finding.path.split("/").some((part) => part === "" || part === "." || part === "..") ||
      typeof finding.ruleId !== "string" ||
      finding.ruleId.length === 0
    ) {
      fail("execution-product-mismatch");
    }
  }
  let reconstructedAuthorization: RunRecord["securityScanAuthorization"] = authorization;
  if (authorization !== undefined) {
    if (record.startedAt === undefined || !Number.isFinite(Date.parse(record.startedAt))) {
      fail("execution-product-mismatch");
    }
    try {
      const overrides = authorization.overrides.map(({ ruleId, reason, expiresAt }) => ({
        ruleId,
        revision: record.repository.revision,
        reason,
        expiresAt,
      }));
      reconstructedAuthorization =
        overrides.length === 0
          ? undefined
          : authorize(report, overrides, record.repository.revision, new Date(record.startedAt));
    } catch {
      fail("execution-product-mismatch");
    }
    if (canonicalJson(authorization) !== canonicalJson(reconstructedAuthorization)) {
      fail("execution-product-mismatch");
    }
  }
  const expected = resolveDisposition(report, reconstructedAuthorization);
  if (
    effective === undefined ||
    canonicalJson(effective) !== canonicalJson(expected) ||
    (effective.status !== "passed" && effective.status !== "authorized")
  ) {
    fail("execution-product-mismatch");
  }
}

function validateInferenceEvidence(
  inference: NonNullable<RunRecord["steps"][number]["inference"]>,
  step: Pick<RunRecord["steps"][number], "id" | "mode">,
): void {
  if (
    !nonnegativeInteger(inference.configuredMaxRetries) ||
    !nonnegativeInteger(inference.effectiveMaxRetries) ||
    inference.effectiveMaxRetries > inference.configuredMaxRetries ||
    !nonnegativeInteger(inference.baseDelayMs) ||
    !nonnegativeInteger(inference.maxDelayMs) ||
    inference.baseDelayMs > inference.maxDelayMs ||
    !Array.isArray(inference.retryableCategories) ||
    new Set(inference.retryableCategories).size !== inference.retryableCategories.length ||
    inference.retryableCategories.some((category) => !isConfigurableRetryCategory(category))
  ) {
    fail("execution-product-mismatch");
  }
  // The replay mode the step may record decides its effective policy.
  const replay = inference.replay;
  if (
    !admittedInferenceReplays(step).includes(replay) ||
    (replayKeepsConfiguredBudget(replay)
      ? inference.effectiveMaxRetries !== inference.configuredMaxRetries
      : inference.effectiveMaxRetries !== 0)
  ) {
    fail("execution-product-mismatch");
  }
  const effectiveRetryableCategories = effectiveInferenceRetryCategories(
    replay,
    inference.retryableCategories,
    inference.transportRetry !== undefined,
  );
  if (
    inference.transportRetry !== undefined &&
    !isInferenceTransportRetryEvidence(inference.transportRetry, effectiveRetryableCategories)
  ) {
    fail("execution-product-mismatch");
  }
  if (
    inference.conditionRetry !== undefined &&
    !isInferenceConditionRetryEvidence(inference.conditionRetry, inference.effectiveMaxRetries)
  ) {
    fail("execution-product-mismatch");
  }
  const attempts = inference.attempts;
  if (!Array.isArray(attempts) || attempts.length === 0) fail("execution-product-mismatch");
  // Every recorded retry rule must be the one the shared decider derives.
  if (!inferenceAttemptRulesConsistent(inference, attempts)) fail("execution-product-mismatch");
  // Each attempt is judged by the budget its outcome belongs to: transport
  // faults by `transportRetry`, everything else by `effectiveMaxRetries`.
  if (!inferenceAttemptsWithinBudgets(inference, attempts)) {
    fail("execution-product-mismatch");
  }
  const positions = inferenceAttemptBudgetPositions(inference, attempts);
  // Per record: a no-progress stop is terminal where the policy had no budget for it.
  const terminal = new Set<string>(terminalInferenceCategories(inference));
  for (const [index, attempt] of attempts.entries()) {
    const final = index === attempts.length - 1;
    const position = positions[index]!;
    if (
      attempt.attempt !== index + 1 ||
      !nonnegativeInteger(attempt.durationMs) ||
      !isInferenceAttemptOutcome(attempt.outcome) ||
      typeof attempt.retryable !== "boolean" ||
      typeof attempt.retryScheduled !== "boolean"
    ) {
      fail("execution-product-mismatch");
    }
    // Condition retryability and retry decision are both absent on older
    // records. When present, both must agree with the shipped taxonomy and this
    // record's effective policy.
    const conditionRetryability = attempt.conditionRetryability;
    const retryDecision = attempt.retryDecision;
    if ((conditionRetryability === undefined) !== (retryDecision === undefined)) {
      fail("execution-product-mismatch");
    }
    if (
      conditionRetryability !== undefined &&
      (conditionRetryability !==
        inferenceConditionRetryability(attempt.outcome, {
          noProgressRetry: recordRetriesNoProgress(inference),
        }) ||
        // A record with condition budgets was checked rule by rule above.
        (inference.conditionRetry === undefined &&
          retryDecision !==
            projectBudgetedInferenceRetryDecision({
              outcome: attempt.outcome,
              position,
              retryable: attempt.retryable,
              // A write-capable step declined every category rather than
              // exhausting a budget it never had; a host-reset writer retries
              // transport only when its separate transport budget is present.
              policyRetryableCategories: effectiveRetryableCategories,
              retryScheduled: attempt.retryScheduled,
            })))
    ) {
      fail("execution-product-mismatch");
    }
    // The admitted reply span is measured only for an answer the step accepted.
    if (
      attempt.answerBytes !== undefined &&
      (attempt.outcome !== "succeeded" || !nonnegativeInteger(attempt.answerBytes))
    ) {
      fail("execution-product-mismatch");
    }
    if (attempt.outcome === "succeeded") {
      if (
        !final ||
        attempt.retryable !== false ||
        attempt.retryScheduled !== false ||
        attempt.backoffMs !== undefined
      ) {
        fail("execution-product-mismatch");
      }
      continue;
    }
    if (terminal.has(attempt.outcome) && attempt.retryable) {
      fail("execution-product-mismatch");
    }
    if (final) {
      if (attempt.retryScheduled || attempt.backoffMs !== undefined) {
        fail("execution-product-mismatch");
      }
      continue;
    }
    if (
      !attempt.retryScheduled ||
      !attempt.retryable ||
      !effectiveRetryableCategories.includes(attempt.outcome) ||
      // The writer's own formula, Retry-After included.
      !isRecordedInferenceRetryBackoff(position.backoff, attempt, position.ordinal)
    ) {
      fail("execution-product-mismatch");
    }
  }
  if (replay === "disabled-write-step") {
    const attempt = attempts[0];
    if (
      attempts.length !== 1 ||
      attempt?.outcome !== "succeeded" ||
      attempt.retryable ||
      attempt.retryScheduled ||
      attempt.backoffMs !== undefined
    ) {
      fail("execution-product-mismatch");
    }
  }
}

function validateToolSummary(summary: ToolActivitySummary, disposition: ProductDisposition): void {
  if (
    !nonnegativeInteger(summary.totalCalls) ||
    !nonnegativeInteger(summary.failedCalls) ||
    summary.failedCalls > summary.totalCalls ||
    !Array.isArray(summary.byTool)
  ) {
    fail("execution-product-mismatch");
  }
  const names = new Set<string>();
  let calls = 0;
  let failures = 0;
  for (const entry of summary.byTool) {
    if (
      typeof entry.name !== "string" ||
      !SAFE_ID.test(entry.name) ||
      entry.name.includes(":/") ||
      names.has(entry.name) ||
      !nonnegativeInteger(entry.calls) ||
      !nonnegativeInteger(entry.failures) ||
      entry.failures > entry.calls
    )
      fail("execution-product-mismatch");
    names.add(entry.name);
    calls += entry.calls;
    failures += entry.failures;
    if (!Number.isSafeInteger(calls) || !Number.isSafeInteger(failures)) {
      fail("execution-product-mismatch");
    }
  }
  if (calls !== summary.totalCalls || failures !== summary.failedCalls) {
    fail("execution-product-mismatch");
  }
  const categories = summary.failureCategories;
  if (categories === undefined) {
    if (summary.failedCalls > 0) fail("execution-product-mismatch");
    return;
  }
  if (!Array.isArray(categories)) fail("execution-product-mismatch");
  const seen = new Set<string>();
  let categorizedExecutedFailures = 0;
  for (const entry of categories) {
    if (
      !TOOL_FAILURE_CATEGORIES.includes(entry.category) ||
      seen.has(entry.category) ||
      !positiveInteger(entry.count)
    ) {
      fail("execution-product-mismatch");
    }
    seen.add(entry.category);
    if (entry.category !== "governance-stop") {
      categorizedExecutedFailures += entry.count;
      if (!Number.isSafeInteger(categorizedExecutedFailures)) fail("execution-product-mismatch");
    }
    if (disposition === "ready" && !NON_MATERIAL_TOOL_FAILURE_CATEGORIES.includes(entry.category)) {
      fail("execution-product-mismatch");
    }
  }
  if (categorizedExecutedFailures !== summary.failedCalls) fail("execution-product-mismatch");
}

function normalizeToolSummary(summary: ToolActivitySummary): ToolActivitySummary {
  return {
    totalCalls: summary.totalCalls,
    failedCalls: summary.failedCalls,
    byTool: [...summary.byTool]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => ({ ...entry })),
    ...((summary.failureCategories?.length ?? 0) === 0
      ? {}
      : {
          failureCategories: [...summary.failureCategories!]
            .sort((left, right) => left.category.localeCompare(right.category))
            .map((entry) => ({ ...entry })),
        }),
  };
}

function aggregateToolSummaries(summaries: readonly ToolActivitySummary[]): ToolActivitySummary {
  const byTool = new Map<string, { calls: number; failures: number }>();
  const categories = new Map<
    NonNullable<ToolActivitySummary["failureCategories"]>[number]["category"],
    number
  >();
  let totalCalls = 0;
  let failedCalls = 0;
  for (const summary of summaries) {
    totalCalls += summary.totalCalls;
    failedCalls += summary.failedCalls;
    if (!Number.isSafeInteger(totalCalls) || !Number.isSafeInteger(failedCalls)) {
      fail("execution-product-mismatch");
    }
    for (const entry of summary.byTool) {
      const current = byTool.get(entry.name) ?? { calls: 0, failures: 0 };
      current.calls += entry.calls;
      current.failures += entry.failures;
      if (!Number.isSafeInteger(current.calls) || !Number.isSafeInteger(current.failures)) {
        fail("execution-product-mismatch");
      }
      byTool.set(entry.name, current);
    }
    for (const entry of summary.failureCategories ?? []) {
      const count = (categories.get(entry.category) ?? 0) + entry.count;
      if (!Number.isSafeInteger(count)) fail("execution-product-mismatch");
      categories.set(entry.category, count);
    }
  }
  return {
    totalCalls,
    failedCalls,
    byTool: [...byTool]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, counts]) => ({ name, ...counts })),
    ...(categories.size === 0
      ? {}
      : {
          failureCategories: [...categories]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([category, count]) => ({ category, count })),
        }),
  };
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && !Object.is(value, -0);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validateExitPolicy(value: WorkflowOutcomeExitPolicyV1): WorkflowOutcomeExitPolicyV1 {
  assertInert(value);
  const item = object(value);
  exact(item, ["schemaVersion", "mode", "failOn"]);
  if (item.schemaVersion !== 1) fail("invalid-outcome");
  const mode = choice(item.mode, ["interactive", "release-gate"] as const);
  const failOn = array(item.failOn)
    .map((entry) => choice(entry, DISPOSITIONS))
    .sort((left, right) => left.localeCompare(right));
  unique(failOn, "invalid-outcome");
  if (mode === "interactive" && failOn.length > 0) fail("invalid-outcome");
  return { schemaVersion: 1, mode, failOn };
}

function artifactEvidenceId(use: ArtifactUse & { stepId: string }): string {
  return `artifact:${use.stepId}:${use.role}:${use.reference.kind}:${use.reference.digest}`;
}

function contentFreeArtifactUse(use: ArtifactUse): unknown {
  return { role: use.role, stepId: use.stepId ?? null, reference: use.reference };
}

function recordOutputArtifacts(record: RunRecord): ArtifactReference[] {
  const output: ArtifactReference[] = [];
  for (const use of record.artifacts ?? []) {
    if (
      use.role !== "output" ||
      output.some((item) => canonicalJson(item) === canonicalJson(use.reference))
    )
      continue;
    try {
      output.push(validateArtifactReference(use.reference));
    } catch {
      fail("invalid-evidence");
    }
  }
  return output.sort(compareCanonical);
}

function isTerminalStep(status: RunRecord["steps"][number]["status"]): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "needs-input" ||
    status === "needs-human-decision"
  );
}

function compareCanonical(left: unknown, right: unknown): number {
  return canonicalJson(left).localeCompare(canonicalJson(right));
}

function safeId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value) || value.includes(":/")) {
    fail("invalid-outcome");
  }
  return value;
}

function safeCode(value: unknown): string {
  if (!isWorkflowOutcomeCode(value)) fail("invalid-outcome");
  return value;
}

function choice<const T extends readonly string[]>(value: unknown, choices: T): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) fail("invalid-outcome");
  return value as T[number];
}

function unique(
  values: readonly string[],
  code: WorkflowOutcomeErrorCode,
  location?: string,
): void {
  if (new Set(values).size !== values.length) fail(code, location);
}
