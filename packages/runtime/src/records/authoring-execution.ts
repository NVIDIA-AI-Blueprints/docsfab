// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Portable, closed record evidence for one bounded CREATE Manifest V3 run. */

import { sha256 } from "../content-ir/canonical.js";
import type { ChangeEvidence } from "../impact/contracts.js";
import { repositoryChangeWriteEffectPaths } from "../repository/contracts.js";
import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import {
  isAuthoringSourceSupportStepError,
  selectAuthoringRevision,
  type AuthoringCandidateV1,
  type AuthoringProducerBindingV1,
  type AuthoringRevisionSelection,
} from "../workflow-execution/authoring-candidate.js";
import {
  decodeAuthoringRevisionAccounting,
  validateAuthoringRevisionMutation,
  type AuthoringRevisionAccountingV1,
} from "../workflow-execution/authoring-revision.js";
import {
  documentationPlanPagePaths,
  documentationPlanWritePaths,
  validateAdmittedDocumentationPlanBinding,
} from "../workflow-execution/plan-binding.js";
import {
  decodeAdmittedVerificationSummary,
  validateEditorialReviewResult,
  type ReviewResult,
  type VerificationResult,
} from "../workflow-execution/review-response.js";
import {
  validateSourceObligationLedger,
  validateTechnicalCorrectionEvidence,
  assertSourceObligationSourceAuthority,
  sourceObligationScopeSha256,
  type SourceObligationLedger,
} from "../workflow-execution/source-obligation.js";
import {
  validateOriginalSourceAuthorityEvidence,
  validateSourceAuthorityProposalAdmissionV1,
} from "../workflow-execution/source-obligation-authority.js";
import { documentationAuditSearch } from "../maturity/audit-search-plan.js";
import { documentationObservationSearch } from "../search/observation-search-plan.js";
import {
  authoringPrefixPhaseForStep,
  authoringSelectedPath,
} from "../workflow-contracts/authoring-schedule.js";
import {
  type WorkflowAuthoringBranchIdV3,
  type WorkflowDefinition,
} from "../workflow-contracts/contracts.js";
import { decodeWorkflowSearchEvidence } from "../workflow-contracts/search.js";
import { parseWorkflowManifestSnapshot } from "../workflow-registry/manifest.js";
import { isTransportRetryCategory } from "./inference-retry-disposition.js";
import type { RunRecord, StepRunRecord } from "./contracts.js";

import {
  AuthoringExecutionError,
  exactObject,
  fail,
  kit,
  nullableHash,
  nonnegativeInteger,
  sameStrings,
} from "./authoring-execution/protocol.js";
import {
  AUTHORING_EXECUTION_KIND,
  AUTHORING_PARTIAL_KIND,
  AUTHORING_PHASE_KIND,
  AUTHORING_REVISION_ADMISSION_KIND,
  EXECUTION_BODY_KEYS,
  PHASE_BODY_KEYS,
  type AuthoringCandidateArtifactReferenceV1,
  type AuthoringCandidateHistoryEntryV1,
  type AuthoringCandidatePointerV1,
  type AuthoringExecutionBodyV1,
  type AuthoringExecutionEvidenceV1,
  type AuthoringFinalPatchBindingV1,
  type AuthoringPartialCandidateV1,
  type AuthoringPathSelectionV1,
  type AuthoringPhaseEvidenceBodyV1,
  type AuthoringPhaseEvidenceV1,
  type AuthoringPhaseInvocationBindingV1,
  type AuthoringProducerSummaryBindingV1,
  type AuthoringRevisionAdmissionBindingV1,
  type AuthoringSelectedProducerSetV1,
  type AuthoringSelectionInputV1,
  type CreateAuthoringExecutionEvidenceInputV1,
} from "./authoring-execution/schema.js";
import {
  candidatePointer,
  decodePartial,
  decodeRevisionAdmission,
  finalPatchBinding,
  normalizeExecution,
} from "./authoring-execution/execution-codec.js";
import {
  normalizePhase,
  phaseBody,
  resolvePhase,
  requireV3,
  tryResolvePhase,
} from "./authoring-execution/phase-codec.js";
export { AuthoringExecutionError } from "./authoring-execution/protocol.js";
export type { AuthoringExecutionErrorCode } from "./authoring-execution/protocol.js";
export {
  AUTHORING_EXECUTION_KIND,
  AUTHORING_PARTIAL_KIND,
  AUTHORING_PHASE_KIND,
  AUTHORING_REVISION_ADMISSION_KIND,
} from "./authoring-execution/schema.js";
export type {
  AuthoringCandidateArtifactReferenceV1,
  AuthoringCandidateHistoryEntryV1,
  AuthoringPartialCandidateV1,
  AuthoringCandidatePointerV1,
  AuthoringProducerSummaryBindingV1,
  AuthoringSelectionInputV1,
  AuthoringPathSelectionV1,
  AuthoringSelectedProducerSetV1,
  AuthoringFinalPatchBindingV1,
  AuthoringRevisionAdmissionBindingV1,
  AuthoringExecutionBodyV1,
  AuthoringExecutionEvidenceV1,
  AuthoringPhaseEvidenceBodyV1,
  AuthoringPhaseEvidenceV1,
  AuthoringPhaseInvocationBindingV1,
  CreateAuthoringExecutionEvidenceInputV1,
} from "./authoring-execution/schema.js";

export function createAuthoringExecutionEvidenceV1(
  input: CreateAuthoringExecutionEvidenceInputV1,
  workflow: WorkflowDefinition,
): AuthoringExecutionEvidenceV1 {
  const schedule = requireV3(workflow);
  const candidateEntries = input.candidates.map(({ candidate, revisionInputDigest }) => ({
    candidate,
    artifact: candidateArtifact(candidate),
    admittedByStepId:
      candidate.ordinal === 0
        ? ("write-documentation" as const)
        : ("revise-documentation" as const),
    revisionInputDigest,
  }));
  const selection = input.selection
    ? {
        ...input.selection,
        inputSha256: kit.canonicalDigest(input.selection.input),
        requiredStepIds: authoringSelectedPath(workflow, input.selection.branchId).steps.map(
          (step) => step.id,
        ),
        excludedStepIds: [
          ...authoringSelectedPath(workflow, input.selection.branchId).excludedStepIds,
        ],
      }
    : null;
  const selectedCandidate =
    input.selectedCandidateOrdinal === null
      ? null
      : candidatePointer(candidateEntries[input.selectedCandidateOrdinal]?.candidate);
  const finalPatch =
    input.includeFinalPatch && selectedCandidate
      ? finalPatchBinding(candidateEntries[selectedCandidate.ordinal]!.candidate)
      : null;
  const body: AuthoringExecutionBodyV1 = {
    runId: input.runId,
    workflow: "create-documentation",
    manifest: structuredClone(schedule.manifest),
    manifestSha256: kit.canonicalDigest(schedule.manifest),
    repositoryRevision: input.repositoryRevision,
    planDigest: input.planDigest,
    writePaths: [...input.writePaths],
    sourceSearchSnapshotSha256: input.sourceSearchSnapshotSha256,
    sourceObligationLedgerSha256: input.sourceObligationLedgerSha256,
    technicalCorrectionEvidenceSha256: input.technicalCorrectionEvidenceSha256,
    selection,
    candidates: candidateEntries,
    revisionAdmission: input.revisionAdmission,
    partialCandidate1: input.partialCandidate1,
    selectedCandidate,
    selectedProducers: input.selectedProducers,
    finalPatch,
  };
  return decodeAuthoringExecutionEvidenceV1(
    kit.seal(AUTHORING_EXECUTION_KIND, "executionSha256", body),
    workflow,
  );
}

export function createAuthoringRevisionAdmissionBindingV1(input: {
  readonly candidate0: AuthoringCandidateV1;
  readonly candidate1: AuthoringCandidateV1;
  readonly actualChangedPaths: readonly string[];
  readonly accounting: AuthoringRevisionAccountingV1;
}): AuthoringRevisionAdmissionBindingV1 {
  return decodeRevisionAdmission(
    kit.seal(AUTHORING_REVISION_ADMISSION_KIND, "admissionSha256", {
      candidate0Digest: input.candidate0.digest,
      candidate0WorkspaceSnapshotDigest: input.candidate0.workspaceSnapshotDigest,
      candidate1Digest: input.candidate1.digest,
      candidate1WorkspaceSnapshotDigest: input.candidate1.workspaceSnapshotDigest,
      changedPaths: [...input.actualChangedPaths].sort(kit.compare),
      accountingSha256: kit.canonicalDigest(input.accounting),
    }),
    [input.candidate0, input.candidate1],
  );
}

export function decodeAuthoringExecutionEvidenceV1(
  value: unknown,
  workflow: WorkflowDefinition,
): AuthoringExecutionEvidenceV1 {
  return kit.decodeSealed(
    value,
    AUTHORING_EXECUTION_KIND,
    "executionSha256",
    [...EXECUTION_BODY_KEYS],
    (root) => normalizeExecution(root, workflow),
  ) as AuthoringExecutionEvidenceV1;
}

/**
 * Reconstruct the exact closed CREATE V3 workflow retained inside portable
 * execution evidence. This does not compare the retained manifest with the
 * currently installed workflow; callers that possess that authority retain
 * responsibility for that separate check.
 */
export function decodeRetainedAuthoringWorkflowV1(value: unknown): WorkflowDefinition {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = exactObject(value, [
    "schemaVersion",
    "kind",
    ...EXECUTION_BODY_KEYS,
    "executionSha256",
  ]);
  const workflow = parseWorkflowManifestSnapshot(root.manifest, "create-documentation", {
    "documentation-audit": documentationAuditSearch,
    "documentation-observation": documentationObservationSearch,
  });
  decodeAuthoringExecutionEvidenceV1(value, workflow);
  return workflow;
}

export function createAuthoringPartialCandidateV1(input: {
  runId: string;
  inputCandidateDigest: string;
  revisionInputDigest: string;
  originalRevision: string;
  planDigest: string;
  writePaths: readonly string[];
  artifact: { sha256: string; byteLength: number } | null;
  workspaceSnapshotDigest: string | null;
  failureCode: string;
}): AuthoringPartialCandidateV1 {
  return decodePartial(
    kit.seal(AUTHORING_PARTIAL_KIND, "partialSha256", {
      runId: input.runId,
      ordinal: 1 as const,
      inputCandidateDigest: input.inputCandidateDigest,
      revisionInputDigest: input.revisionInputDigest,
      originalRevision: input.originalRevision,
      planDigest: input.planDigest,
      writePaths: [...input.writePaths],
      artifact: input.artifact
        ? {
            kind: "authoring-partial-patch" as const,
            name: "candidate-1.partial.patch" as const,
            ...input.artifact,
          }
        : null,
      workspaceSnapshotDigest: input.workspaceSnapshotDigest,
      disposition: "non-deliverable" as const,
      failureCode: input.failureCode,
    }),
  );
}

export function createAuthoringPhaseEvidenceV1(input: {
  workflow: WorkflowDefinition;
  branchId: WorkflowAuthoringBranchIdV3 | null;
  stepId: string;
  candidates: readonly AuthoringCandidateV1[];
  outputAdmitted: boolean;
  summary: string | null;
}): AuthoringPhaseEvidenceV1 {
  const phase = resolvePhase(input.workflow, input.branchId, input.stepId);
  const body = phaseBody(
    phase,
    authoringPrefixPhaseForStep(input.workflow, input.stepId) ? null : input.branchId,
    input.candidates,
    input.outputAdmitted,
    input.summary,
  );
  return decodeAuthoringPhaseEvidenceV1(kit.seal(AUTHORING_PHASE_KIND, "phaseSha256", body), {
    workflow: input.workflow,
    branchId: input.branchId,
    candidates: input.candidates,
  });
}

/**
 * Derive only facts known before invocation. Output candidate and summary
 * identity belong to the completed phase seal and are deliberately absent.
 */
export function authoringPhaseInvocationBindingV1(input: {
  workflow: WorkflowDefinition;
  branchId: WorkflowAuthoringBranchIdV3 | null;
  stepId: string;
  candidates: readonly AuthoringCandidateV1[];
  revisionInputDigest: string | null;
}): AuthoringPhaseInvocationBindingV1 {
  const phase = resolvePhase(input.workflow, input.branchId, input.stepId);
  const branchId = authoringPrefixPhaseForStep(input.workflow, input.stepId)
    ? null
    : input.branchId;
  if (phase.role === "writer") {
    const candidate =
      phase.inputCandidateOrdinal === null ? null : input.candidates[phase.inputCandidateOrdinal];
    if (phase.inputCandidateOrdinal !== null && !candidate) fail("candidate-mismatch");
    if ((phase.stepId === "revise-documentation") !== (input.revisionInputDigest !== null)) {
      fail("phase-mismatch");
    }
    return Object.freeze({
      branchId,
      stepId: phase.stepId,
      ordinal: phase.ordinal,
      role: phase.role,
      inputCandidateOrdinal: phase.inputCandidateOrdinal,
      inputCandidateDigest: candidate?.digest ?? null,
      assessedCandidateOrdinal: null,
      assessedCandidateDigest: null,
      workspaceSnapshotDigest: candidate?.workspaceSnapshotDigest ?? null,
      revisionInputDigest:
        input.revisionInputDigest === null ? null : kit.hash(input.revisionInputDigest),
    });
  }
  if (input.revisionInputDigest !== null) fail("phase-mismatch");
  const candidate = input.candidates[phase.candidateOrdinal];
  if (!candidate) fail("candidate-mismatch");
  return Object.freeze({
    branchId,
    stepId: phase.stepId,
    ordinal: phase.ordinal,
    role: phase.role,
    inputCandidateOrdinal: null,
    inputCandidateDigest: null,
    assessedCandidateOrdinal: phase.candidateOrdinal,
    assessedCandidateDigest: candidate.digest,
    workspaceSnapshotDigest: candidate.workspaceSnapshotDigest,
    revisionInputDigest: null,
  });
}

/** Decode a retained pre-inference identity against host-known schedule and candidates. */
export function decodeAuthoringPhaseInvocationBindingV1(
  value: unknown,
  context: {
    workflow: WorkflowDefinition;
    candidates: readonly AuthoringCandidateV1[];
  },
): AuthoringPhaseInvocationBindingV1 {
  const root = exactObject(value, [
    "branchId",
    "stepId",
    "ordinal",
    "role",
    "inputCandidateOrdinal",
    "inputCandidateDigest",
    "assessedCandidateOrdinal",
    "assessedCandidateDigest",
    "workspaceSnapshotDigest",
    "revisionInputDigest",
  ]);
  const branchId =
    root.branchId === null ? null : kit.enumeration(root.branchId, ["retain", "revise"] as const);
  const stepId = kit.identifier(root.stepId);
  const supplied: AuthoringPhaseInvocationBindingV1 = {
    branchId,
    stepId,
    ordinal: nonnegativeInteger(root.ordinal),
    role: kit.enumeration(root.role, [
      "writer",
      "lint",
      "provisional-technical",
      "canonical-technical",
      "editorial",
      "audience",
      "evaluation",
    ] as const),
    inputCandidateOrdinal:
      root.inputCandidateOrdinal === null
        ? null
        : root.inputCandidateOrdinal === 0
          ? 0
          : fail("phase-mismatch"),
    inputCandidateDigest: nullableHash(root.inputCandidateDigest),
    assessedCandidateOrdinal:
      root.assessedCandidateOrdinal === null
        ? null
        : root.assessedCandidateOrdinal === 0 || root.assessedCandidateOrdinal === 1
          ? root.assessedCandidateOrdinal
          : fail("phase-mismatch"),
    assessedCandidateDigest: nullableHash(root.assessedCandidateDigest),
    workspaceSnapshotDigest: nullableHash(root.workspaceSnapshotDigest),
    revisionInputDigest: nullableHash(root.revisionInputDigest),
  };
  const expected = authoringPhaseInvocationBindingV1({
    workflow: context.workflow,
    branchId,
    stepId,
    candidates: context.candidates,
    revisionInputDigest: supplied.revisionInputDigest,
  });
  if (kit.canonicalDigest(supplied) !== kit.canonicalDigest(expected)) fail("phase-mismatch");
  return expected;
}

export function decodeAuthoringPhaseEvidenceV1(
  value: unknown,
  context: {
    workflow: WorkflowDefinition;
    branchId: WorkflowAuthoringBranchIdV3 | null;
    candidates: readonly AuthoringCandidateV1[];
  },
): AuthoringPhaseEvidenceV1 {
  return kit.decodeSealed(
    value,
    AUTHORING_PHASE_KIND,
    "phaseSha256",
    [...PHASE_BODY_KEYS],
    (root) => normalizePhase(root, context),
  ) as AuthoringPhaseEvidenceV1;
}

export function validateAuthoringRunRecordV1(
  record: Readonly<RunRecord>,
  workflow: WorkflowDefinition,
  options: { requireTerminalSuccess?: boolean } = {},
): AuthoringExecutionEvidenceV1 {
  if (record.workflow !== "create-documentation" || record.id.length === 0)
    fail("subject-mismatch");
  const evidence = decodeAuthoringExecutionEvidenceV1(record.authoringExecution, workflow);
  if (evidence.runId !== record.id || evidence.repositoryRevision !== record.repository.revision) {
    fail("subject-mismatch");
  }
  const branchId = evidence.selection?.branchId ?? null;
  const requiredSteps = branchId
    ? authoringSelectedPath(workflow, branchId).steps
    : requireV3(workflow).prefix.steps;
  validateStepSequence(record.steps, requiredSteps, options.requireTerminalSuccess === true);
  validateOriginalAuthorityPlacement(record, workflow);
  validateStepPhases(record.steps, workflow, evidence, branchId);
  validateInitialWriterAdmission(record.steps, evidence);
  const retainedSelection = validateRetainedSelectionEvidence(record, workflow, evidence);
  validateRetainedRevisionAccounting(record.steps, evidence, retainedSelection);
  validateSelectionAgainstSteps(record.steps, evidence);
  validateSelectedProducers(record.steps, workflow, evidence, retainedSelection);
  validateFinalPatch(record.changes, evidence, options.requireTerminalSuccess === true);
  return evidence;
}

function validateOriginalAuthorityPlacement(
  record: Readonly<RunRecord>,
  workflow: WorkflowDefinition,
): void {
  const holders = record.steps.filter((step) => step.originalSourceAuthority !== undefined);
  const correctionHolders = record.steps.filter(
    (step) => step.technicalCorrectionEvidence !== undefined,
  );
  if (holders.some((step) => step.id !== "derive-source-obligations") || holders.length > 1) {
    fail("selection-mismatch");
  }
  const derive = record.steps.find((step) => step.id === "derive-source-obligations");
  if (!derive) {
    if (correctionHolders.length > 0) fail("selection-mismatch");
    return;
  }
  const plan = record.steps.find((step) => step.id === "plan-documentation")?.planBinding;
  if (!derive.originalSourceAuthority) {
    if (derive.sourceProposalAdmissions?.length) fail("selection-mismatch");
    if (derive.summary) {
      let parsed: JsonEvidenceValue;
      try {
        parsed = parseJsonEvidence(derive.summary);
      } catch {
        return;
      }
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        parsed.schemaVersion === 2
      ) {
        fail("selection-mismatch");
      }
    }
    return;
  }
  if (!plan || !derive.searchEvidence) fail("selection-mismatch");
  if (
    correctionHolders.some(
      (step) =>
        step.id !== "verify-technical-accuracy" && step.id !== "verify-revised-technical-accuracy",
    )
  ) {
    fail("selection-mismatch");
  }
  const scopeSha256 = sourceObligationScopeSha256({ workflow, planBinding: plan });
  const authority = validateOriginalSourceAuthorityEvidence(derive.originalSourceAuthority, {
    scope: "create-plan-sources",
    repositoryRevision: record.repository.revision,
    scopeSha256,
    workspaceSnapshotSha256: derive.searchEvidence.workspaceSnapshotSha256,
  });
  const expectedPaths = assertSourceObligationSourceAuthority({
    workflow,
    planBinding: plan,
    evidenceIdentity: { repositoryRevision: record.repository.revision },
  });
  const originalPaths = new Set(expectedPaths);
  const admittedPaths = new Set<string>();
  for (const raw of derive.sourceProposalAdmissions ?? []) {
    const row = validateSourceAuthorityProposalAdmissionV1(raw);
    if (row.status === "admitted") admittedPaths.add(row.path);
    const producingAttempt = derive.inference?.attempts.find(
      (attempt) => attempt.attempt === row.attempt,
    );
    if (
      !producingAttempt ||
      isTransportRetryCategory(producingAttempt.outcome) ||
      (producingAttempt.outcome !== "succeeded" &&
        producingAttempt.outcome !== "malformed-response")
    ) {
      fail("selection-mismatch");
    }
  }
  const expectedAuthorityPaths = [...new Set([...expectedPaths, ...admittedPaths])].sort();
  if (
    !sameStrings(
      authority.members.map((member) => member.path),
      expectedAuthorityPaths,
    )
  ) {
    fail("selection-mismatch");
  }
  if (
    (derive.sourceProposalAdmissions ?? []).some((raw) => {
      const row = validateSourceAuthorityProposalAdmissionV1(raw);
      return (
        row.status === "refused" && !originalPaths.has(row.path) && admittedPaths.has(row.path)
      );
    })
  ) {
    fail("selection-mismatch");
  }
  if (!derive.summary) {
    if (derive.status === "succeeded") fail("selection-mismatch");
    if (correctionHolders.length > 0) fail("selection-mismatch");
    return;
  }
  const definition = workflow.steps.find((step) => step.id === "derive-source-obligations");
  if (!definition?.search) fail("selection-mismatch");
  const searchEvidence = decodeWorkflowSearchEvidence(
    derive.searchEvidence,
    definition.search,
    record.repository,
  );
  const sourceInput = {
    workflow,
    evidenceIdentity: { repositoryRevision: record.repository.revision },
    searchEvidence,
    planBinding: plan,
    ...(record.reviewScope ? { reviewScope: record.reviewScope } : {}),
  };
  const ledger = validateSourceObligationLedger(
    parseJsonEvidence(derive.summary),
    sourceInput,
    authority,
  );
  if (ledger.schemaVersion !== 2) fail("selection-mismatch");
  const canonicalTechnicalSteps = record.steps.filter(
    (step) =>
      step.id === "verify-technical-accuracy" || step.id === "verify-revised-technical-accuracy",
  );
  if (
    canonicalTechnicalSteps.some(
      (step) => step.status === "succeeded" && step.technicalCorrectionEvidence === undefined,
    )
  ) {
    fail("selection-mismatch");
  }
  for (const technical of correctionHolders) {
    if (!technical.summary) fail("selection-mismatch");
    // A source-support InputAsk stop keeps the admitted correction on the
    // `needs-input` technical step; the evidence is still checked below.
    const admittedStop =
      technical.status === "needs-input" &&
      record.status === "needs-input" &&
      isAuthoringSourceSupportStepError(technical.error, technical.summary);
    if (technical.status !== "succeeded" && !admittedStop) fail("selection-mismatch");
    const result = decodeAdmittedVerificationSummary(
      technical.summary,
      documentationPlanPagePaths(plan),
    );
    if (!result) fail("selection-mismatch");
    validateTechnicalCorrectionEvidence(
      technical.technicalCorrectionEvidence,
      ledger,
      result,
      authority,
      documentationPlanPagePaths(plan),
    );
  }
}

export function authoringArtifactReadbackRequirements(
  evidence: AuthoringExecutionEvidenceV1,
): readonly (
  | AuthoringCandidateArtifactReferenceV1
  | NonNullable<AuthoringPartialCandidateV1["artifact"]>
)[] {
  return Object.freeze([
    ...evidence.candidates.map((entry) => entry.artifact),
    ...(evidence.partialCandidate1?.artifact ? [evidence.partialCandidate1.artifact] : []),
  ]);
}

function validateStepSequence(
  steps: readonly StepRunRecord[],
  required: readonly WorkflowDefinition["steps"][number][],
  requireSuccess: boolean,
): void {
  if (steps.length > required.length) fail("phase-mismatch");
  let frontierSeen = false;
  let pendingTailSeen = false;
  for (const [index, step] of steps.entries()) {
    const definition = required[index];
    if (
      !definition ||
      step.id !== definition.id ||
      step.title !== definition.title ||
      step.skill !== definition.skill ||
      step.mode !== definition.mode ||
      (step.kind ?? "inference") !== (definition.kind ?? "inference")
    ) {
      fail("phase-mismatch");
    }
    if (requireSuccess && step.status !== "succeeded") fail("phase-mismatch");
    if (step.status === "succeeded") {
      if (frontierSeen || pendingTailSeen) fail("phase-mismatch");
      continue;
    }
    if (step.status === "pending") {
      pendingTailSeen = true;
      continue;
    }
    if (frontierSeen || pendingTailSeen) fail("phase-mismatch");
    frontierSeen = true;
  }
  if (requireSuccess && steps.length !== required.length) fail("phase-mismatch");
}

function validateInitialWriterAdmission(
  steps: readonly StepRunRecord[],
  evidence: AuthoringExecutionEvidenceV1,
): void {
  const candidate0 = evidence.candidates[0]?.candidate;
  if (!candidate0) return;
  const writer = steps.find((step) => step.id === "write-documentation");
  const phase = writer?.authoringPhase;
  if (
    writer?.status !== "succeeded" ||
    phase?.role !== "writer" ||
    phase.outputCandidateOrdinal !== 0 ||
    phase.outputCandidateDigest !== candidate0.digest ||
    phase.workspaceSnapshotDigest !== candidate0.workspaceSnapshotDigest
  ) {
    fail("candidate-mismatch");
  }
}

function validateStepPhases(
  steps: readonly StepRunRecord[],
  workflow: WorkflowDefinition,
  evidence: AuthoringExecutionEvidenceV1,
  branchId: WorkflowAuthoringBranchIdV3 | null,
): void {
  const candidates = evidence.candidates.map((entry) => entry.candidate);
  for (const step of steps) {
    const expected = tryResolvePhase(workflow, branchId, step.id);
    if (!expected) {
      if (step.authoringPhase !== undefined) fail("phase-mismatch");
      if (
        step.inference?.attempts.some(
          (attempt) => attempt.identity?.authoringPhaseSha256 !== undefined,
        )
      ) {
        fail("phase-mismatch");
      }
      continue;
    }
    if (step.status === "pending") {
      if (step.authoringPhase !== undefined) fail("phase-mismatch");
      continue;
    }
    const phase = decodeAuthoringPhaseEvidenceV1(step.authoringPhase, {
      workflow,
      branchId:
        expected.stepId === "write-documentation" || expected.ordinal <= 7 ? null : branchId,
      candidates,
    });
    if (step.summary === undefined) {
      if (phase.summarySha256 !== null) fail("phase-mismatch");
    } else if (phase.summarySha256 !== sha256(step.summary)) {
      fail("phase-mismatch");
    }
    if (
      step.status === "succeeded" &&
      expected.role === "writer" &&
      phase.outputCandidateDigest === null
    ) {
      fail("candidate-mismatch");
    }
    if (
      step.status !== "succeeded" &&
      expected.role === "writer" &&
      phase.outputCandidateDigest !== null
    ) {
      fail("candidate-mismatch");
    }
    if ((step.kind ?? "inference") !== "host-operation") {
      const invocationCandidates =
        expected.role === "writer"
          ? expected.stepId === "write-documentation"
            ? []
            : candidates.slice(0, 1)
          : candidates.slice(0, expected.candidateOrdinal + 1);
      const revisionInputDigest =
        expected.stepId === "revise-documentation"
          ? (evidence.selection?.revisionInputDigest ?? fail("phase-mismatch"))
          : null;
      const invocationSha256 = kit.canonicalDigest(
        authoringPhaseInvocationBindingV1({
          workflow,
          branchId:
            expected.stepId === "write-documentation" || expected.ordinal <= 7 ? null : branchId,
          stepId: step.id,
          candidates: invocationCandidates,
          revisionInputDigest,
        }),
      );
      const attempts = step.inference?.attempts;
      const preInferenceFailure = step.status === "failed" && step.inference === undefined;
      if (
        (!preInferenceFailure && !attempts?.length) ||
        attempts?.some((attempt) => attempt.identity?.authoringPhaseSha256 !== invocationSha256)
      ) {
        fail("phase-mismatch");
      }
    }
  }
}

function validateSelectionAgainstSteps(
  steps: readonly StepRunRecord[],
  evidence: AuthoringExecutionEvidenceV1,
): void {
  const selection = evidence.selection;
  if (!selection) return;
  const technical = steps.find((step) => step.id === "verify-technical-accuracy")?.authoringPhase;
  const editorial = steps.find((step) => step.id === "review-documentation")?.authoringPhase;
  if (
    !technical ||
    !editorial ||
    technical.summarySha256 !== selection.input.technical.summarySha256 ||
    editorial.summarySha256 !== selection.input.editorial.summarySha256
  ) {
    fail("selection-mismatch");
  }
  if (
    selection.branchId === "revise" &&
    ((evidence.candidates[1] !== undefined &&
      evidence.candidates[1].revisionInputDigest !== selection.revisionInputDigest) ||
      (evidence.partialCandidate1 !== null &&
        evidence.partialCandidate1.revisionInputDigest !== selection.revisionInputDigest))
  ) {
    fail("selection-mismatch");
  }
}

function validateRetainedSelectionEvidence(
  record: Readonly<RunRecord>,
  workflow: WorkflowDefinition,
  evidence: AuthoringExecutionEvidenceV1,
): { selection: AuthoringRevisionSelection; ledger: SourceObligationLedger } | null {
  if (!evidence.selection) return null;
  try {
    const planStep = succeededStep(record.steps, "plan-documentation");
    const plan = validateAdmittedDocumentationPlanBinding(planStep.planBinding, {
      expectedMode: "create",
    });
    if (
      plan.digest !== evidence.planDigest ||
      !sameStrings(documentationPlanWritePaths(plan), evidence.writePaths)
    ) {
      fail("selection-mismatch");
    }

    const derive = succeededStep(record.steps, "derive-source-obligations");
    if (!derive.summary || !derive.searchEvidence) fail("selection-mismatch");
    const deriveDefinition = requireV3(workflow).prefix.steps.find(
      (step) => step.id === "derive-source-obligations",
    );
    if (!deriveDefinition?.search) fail("selection-mismatch");
    const searchEvidence = decodeWorkflowSearchEvidence(
      derive.searchEvidence,
      deriveDefinition.search,
      record.repository,
    );
    const sourceObligationInput = {
      workflow,
      evidenceIdentity: { repositoryRevision: evidence.repositoryRevision },
      searchEvidence,
      planBinding: plan,
      ...(record.reviewScope ? { reviewScope: record.reviewScope } : {}),
    };
    const parsedLedger = parseJsonEvidence(derive.summary);
    const authority = derive.originalSourceAuthority;
    const ledger = validateSourceObligationLedger(parsedLedger, sourceObligationInput, authority);
    if (
      canonicalizeJsonEvidence(ledger as unknown as JsonEvidenceValue).trimEnd() !==
        derive.summary ||
      ledger.digest !== evidence.sourceObligationLedgerSha256 ||
      ledger.identity.workspaceSnapshotSha256 !== evidence.sourceSearchSnapshotSha256 ||
      ledger.identity.sourceEvidenceSha256 !== searchEvidence.evidenceSha256 ||
      ledger.identity.workspaceSnapshotSha256 !== searchEvidence.workspaceSnapshotSha256
    ) {
      fail("selection-mismatch");
    }

    const technicalStep = succeededStep(record.steps, "verify-technical-accuracy");
    const technicalResult = decodeAdmittedVerificationSummary(
      technicalStep.summary,
      evidence.writePaths,
    );
    if (!technicalResult || !technicalStep.summary || !technicalStep.technicalCorrectionEvidence) {
      fail("selection-mismatch");
    }
    const correction = validateTechnicalCorrectionEvidence(
      technicalStep.technicalCorrectionEvidence,
      ledger,
      technicalResult,
      authority,
      evidence.writePaths,
    );
    if (correction.digest !== evidence.technicalCorrectionEvidenceSha256) {
      fail("selection-mismatch");
    }

    const editorialStep = succeededStep(record.steps, "review-documentation");
    if (!editorialStep.summary) fail("selection-mismatch");
    const editorialResult = validateEditorialReviewResult(parseJsonEvidence(editorialStep.summary));
    if (
      canonicalizeJsonEvidence(editorialResult as unknown as JsonEvidenceValue).trimEnd() !==
      editorialStep.summary
    ) {
      fail("selection-mismatch");
    }

    const candidate0 = evidence.candidates[0]?.candidate;
    if (!candidate0) fail("selection-mismatch");
    const recomputed = selectAuthoringRevision({
      candidate0,
      originalRevision: evidence.repositoryRevision,
      planDigest: plan.digest,
      writePaths: evidence.writePaths,
      technical: retainedProducerBinding(
        candidate0,
        technicalStep,
        technicalResult,
        "verify-technical-accuracy",
      ),
      editorial: retainedProducerBinding(
        candidate0,
        editorialStep,
        editorialResult,
        "review-documentation",
      ),
      sourceObligationInput,
      sourceObligationLedger: ledger,
      technicalCorrectionEvidence: correction,
      ...(authority ? { originalSourceAuthority: authority } : {}),
    });
    const expectedBranch = recomputed.kind === "revise" ? "revise" : "retain";
    if (
      evidence.selection.branchId !== expectedBranch ||
      (recomputed.kind === "revise"
        ? evidence.selection.revisionInputDigest !== recomputed.input.digest
        : evidence.selection.revisionInputDigest !== null)
    ) {
      fail("selection-mismatch");
    }
    return { selection: recomputed, ledger };
  } catch (error) {
    if (error instanceof AuthoringExecutionError) throw error;
    fail("selection-mismatch");
  }
}

function validateRetainedRevisionAccounting(
  steps: readonly StepRunRecord[],
  evidence: AuthoringExecutionEvidenceV1,
  retainedSelection: {
    selection: AuthoringRevisionSelection;
    ledger: SourceObligationLedger;
  } | null,
): void {
  for (const step of steps) {
    if (step.id !== "revise-documentation" && step.authoringRevisionAccounting !== undefined) {
      fail("phase-mismatch");
    }
  }
  const writer = steps.find((step) => step.id === "revise-documentation");
  if (!writer) return;
  if (writer.status !== "succeeded") {
    if (writer.authoringRevisionAccounting !== undefined || evidence.revisionAdmission !== null) {
      fail("phase-mismatch");
    }
    return;
  }
  if (
    retainedSelection?.selection.kind !== "revise" ||
    writer.authoringRevisionAccounting === undefined ||
    evidence.candidates.length !== 2 ||
    evidence.revisionAdmission === null
  ) {
    fail("selection-mismatch");
  }
  try {
    const encoded = canonicalizeJsonEvidence(
      writer.authoringRevisionAccounting as unknown as JsonEvidenceValue,
    ).trimEnd();
    const accounting = decodeAuthoringRevisionAccounting(
      encoded,
      retainedSelection.selection.input,
    );
    if (
      canonicalizeJsonEvidence(accounting as unknown as JsonEvidenceValue).trimEnd() !== encoded
    ) {
      fail("selection-mismatch");
    }
    if (kit.canonicalDigest(accounting) !== evidence.revisionAdmission.accountingSha256) {
      fail("selection-mismatch");
    }
    validateAuthoringRevisionMutation({
      accounting,
      actualChangedPaths: evidence.revisionAdmission.changedPaths,
      candidate0PatchSha256: evidence.candidates[0]!.candidate.patchDigestSha256,
      candidate1PatchSha256: evidence.candidates[1]!.candidate.patchDigestSha256,
    });
  } catch (error) {
    if (error instanceof AuthoringExecutionError) throw error;
    fail("selection-mismatch");
  }
}

function succeededStep(steps: readonly StepRunRecord[], stepId: string): StepRunRecord {
  const step = steps.find((candidate) => candidate.id === stepId);
  if (!step || step.status !== "succeeded") fail("selection-mismatch");
  return step;
}

function retainedProducerBinding<T extends VerificationResult | ReviewResult>(
  candidate: AuthoringCandidateV1,
  step: StepRunRecord,
  result: T,
  producerId: "verify-technical-accuracy" | "review-documentation",
): AuthoringProducerBindingV1<T> {
  if (!step.summary) fail("selection-mismatch");
  return {
    summary: step.summary,
    summaryDigest: sha256(step.summary),
    producerId,
    candidateDigest: candidate.digest,
    candidateOrdinal: 0,
    workspaceSnapshotDigest: candidate.workspaceSnapshotDigest,
    result,
  };
}

function validateSelectedProducers(
  steps: readonly StepRunRecord[],
  workflow: WorkflowDefinition,
  evidence: AuthoringExecutionEvidenceV1,
  retainedSelection: {
    selection: AuthoringRevisionSelection;
    ledger: SourceObligationLedger;
  } | null,
): void {
  const producers = evidence.selectedProducers;
  if (!producers) return;
  const selected = evidence.selectedCandidate;
  if (!selected) fail("candidate-mismatch");
  const path = authoringSelectedPath(workflow, selected.ordinal === 0 ? "retain" : "revise");
  const ids = [producers.lint.stepId, producers.technical.stepId, producers.editorial.stepId];
  if (
    producers.technical.stepId !== path.technicalProducerStepId ||
    producers.editorial.stepId !== path.editorialProducerStepId ||
    ids.some((id) => !path.steps.some((step) => step.id === id))
  ) {
    fail("candidate-mismatch");
  }
  for (const producer of [producers.lint, producers.technical, producers.editorial]) {
    const step = steps.find((candidate) => candidate.id === producer.stepId);
    if (!step?.authoringPhase || step.authoringPhase.summarySha256 !== producer.summarySha256) {
      fail("candidate-mismatch");
    }
  }
  if (selected.ordinal === 1) {
    try {
      if (!retainedSelection || retainedSelection.selection.kind !== "revise") {
        fail("selection-mismatch");
      }
      const technical = succeededStep(steps, path.technicalProducerStepId);
      if (!technical.summary || !technical.technicalCorrectionEvidence) {
        fail("selection-mismatch");
      }
      const result = decodeAdmittedVerificationSummary(technical.summary, evidence.writePaths);
      if (!result) fail("selection-mismatch");
      validateTechnicalCorrectionEvidence(
        technical.technicalCorrectionEvidence,
        retainedSelection.ledger,
        result,
        steps.find((step) => step.id === "derive-source-obligations")?.originalSourceAuthority,
        evidence.writePaths,
      );
    } catch (error) {
      if (error instanceof AuthoringExecutionError) throw error;
      fail("selection-mismatch");
    }
  }
}

function validateFinalPatch(
  changes: ChangeEvidence | undefined,
  evidence: AuthoringExecutionEvidenceV1,
  requireSuccess: boolean,
): void {
  if (evidence.finalPatch) {
    if (
      changes?.patch?.sha256 !== evidence.finalPatch.sha256 ||
      changes.patch.byteLength !== evidence.finalPatch.byteLength ||
      !sameStrings(
        [...repositoryChangeWriteEffectPaths(changes.files)].sort(),
        evidence.finalPatch.writePaths,
      )
    ) {
      fail("patch-mismatch");
    }
  }
  if (!requireSuccess) return;
  const branch = evidence.selection?.branchId;
  const expectedOrdinal = branch === "retain" ? 0 : branch === "revise" ? 1 : null;
  if (
    expectedOrdinal === null ||
    evidence.selectedCandidate?.ordinal !== expectedOrdinal ||
    !evidence.selectedProducers ||
    !evidence.finalPatch
  ) {
    fail("selection-mismatch");
  }
}

function candidateArtifact(candidate: AuthoringCandidateV1): AuthoringCandidateArtifactReferenceV1 {
  return {
    kind: "authoring-candidate-patch",
    name: candidate.ordinal === 0 ? "candidate-0.patch" : "candidate-1.patch",
    sha256: candidate.patchDigestSha256,
    byteLength: candidate.patchBytes,
  };
}
