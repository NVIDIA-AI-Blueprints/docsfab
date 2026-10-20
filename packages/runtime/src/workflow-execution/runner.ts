// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * WorkflowRunner execution loop. Ports and policies: `./runner-ports.ts`
 * (re-exported here). Admission and the queued record: `./runner-admission.ts`.
 * One governed step: `./runner-step-loop.ts`. V2 editorial bind:
 * `./runner-editorial.ts`. Finalization and `run()`'s `catch`:
 * `./runner-terminal.ts`.
 */

import { randomUUID } from "node:crypto";

import type { RunRequest } from "../execution/contracts.js";
import { resolveEvidenceInputFormatPolicy } from "../harness/evidence-input-format.js";
import { isQualityCandidateValidationStep } from "../execution/contracts.js";
import type { ProgressEvent, RunRecord } from "../records/contracts.js";
import type {
  WorkflowBranchSelectionEvidenceV1,
  WorkflowBranchEvidenceHost,
} from "../workflow-contracts/contracts.js";
import {
  isWorkflowManifestV2,
  isWorkflowManifestV3,
  workflowSelectedPath,
} from "../workflow-contracts/contracts.js";
import {
  authoringPhaseForStep,
  authoringPrefixPhaseForStep,
  authoringSelectedPath,
} from "../workflow-contracts/authoring-schedule.js";
import {
  createWorkflowOutcome,
  workflowOutcomeArtifactEvidence,
  workflowOutcomeStepEvidence,
} from "../workflow-contracts/outcome.js";
import { authorizeSecurityScan } from "../security/scan-override.js";
import { collectCredentialLikeContent } from "../security/repository-credential-findings.js";
import { resolveSecurityScanEffectiveDisposition } from "../security/scan-disposition.js";
import type { HarnessStepResult } from "../execution/contracts.js";
import type { RepositoryDiscoveryInventoryV1 } from "../repository/inventory.js";
import { assertWorkflowActive, WORKFLOW_CANCELLED } from "../execution/cancellation.js";
import { canonicalDigest, sha256 } from "../content-ir/canonical.js";
import { GovernedSkillIntegrityError } from "../skills/roadmap-pack.js";
import { appendEvidenceWarnings, applyWorkflowOutcome, scanRepository } from "./runner-evidence.js";
import {
  admitReviewScopeCapacity,
  canContinueIndependentEvaluate,
  captureRequestLineage,
  durationMs,
  impactPostflightError,
  markContextUnnecessary,
  patchPersistenceError,
  type ProgressEventInput,
  releaseExpectedRepository,
  shouldContinueAfterTechnicalAdmissionStop,
  taskContextScope,
  taskContextTarget,
} from "./runner-schedule.js";
import { addTools, stepFailureMessage } from "./runner-step.js";
import { admitWorkflowRunRequest, createQueuedRunRecord } from "./runner-admission.js";
import { bindEditorialWorkflowBranch } from "./runner-editorial.js";
import { executeGovernedWorkflowStep } from "./runner-step-loop.js";
import { RunCandidateLifecycle } from "./run-lifecycle/candidates.js";
import { createRunFinalization } from "./run-lifecycle/finalization.js";
import {
  finalizeCompletedWorkflowRun,
  recognizedRstRegionErrorMessage,
  settleThrownWorkflowRun,
  type WorkflowRunTerminalSession,
} from "./runner-terminal.js";
import { observeCheckedSnapshot, type RepositoryInstructionV1 } from "./workflow-checks.js";
import {
  createSearchParticipationState,
  markAuthorizedWrite,
  type LastSearchObservation,
} from "./search-participation.js";
import {
  answerRecordContinuationPrefixSha256,
  workflowBranchCoverageDecodeOptionsV1,
} from "../records/composition-execution.js";
import { decodeWorkflowBranchCoverageV1 } from "../workflow-contracts/branch-coverage.js";
import {
  currentDocumentationGapFindings,
  decodeDocumentationGapLedger,
  negativeDocumentationEvidence,
  projectDocumentationSearchFindings,
} from "../search/gap-ledger.js";
import { decodeWorkflowSearchEvidence } from "../workflow-contracts/search.js";
import {
  documentationPlanPagePaths,
  type AdmittedDocumentationPlanBinding,
} from "./plan-binding.js";
import { requiresVerificationResult } from "./verification-result.js";
import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import { QualityArtifactValidationError } from "../evaluation-report/quality-validator-host.js";
import { QualityStepRejectionError } from "../evaluation-report/quality-check-rejections.js";
import {
  classifyingRunStore,
  serializingRunStore,
  classifyQualityValidationFailure,
  classifyStepFailure,
  markRunFailure,
} from "../operator/failure-classification.js";
import {
  decodeAdmittedVerificationSummary,
  requiresEditorialReviewResult,
  retainedTechnicalReviewFindings,
  technicalResponseDiagnosticFromMessage,
  validateEditorialReviewResult,
  type ReviewResult,
  type VerificationResult,
} from "./review-response.js";
import {
  AUTHORING_SOURCE_SUPPORT_CODES,
  authoringSourceSupportGaps,
  authoringSourceSupportStepError,
  selectAuthoringRevision,
  type AuthoringProducerBindingV1,
  type AuthoringRevisionValidationContextV1,
} from "./authoring-candidate.js";
import {
  authoringPhaseInvocationBindingV1,
  createAuthoringPhaseEvidenceV1,
} from "../records/authoring-execution.js";
import type { AuthoringCandidateCaptureV1 } from "./authoring-workspace-host.js";
import {
  authoringRevisionRejectionOf,
  REVISE_DOCUMENTATION_STEP_ID,
} from "./authoring-revision.js";
import {
  SourceObligationSourceReferenceError,
  type SourceObligationLedger,
} from "./source-obligation.js";
import type {
  OriginalSourceAuthorityCapture,
  OriginalSourceAuthorityEvidenceV1,
} from "./source-obligation-authority.js";

import { provenanceRejectionError } from "./runner-ports.js";
import type { WorkflowRunnerOptions, FirstPassDocumentationTargetControl } from "./runner-ports.js";

export {
  WorkflowRunnerBoundaryError,
  EvaluateStepPolicyError,
  assertEvaluateStepPolicy,
  admitCandidate0EditorialForCanonical,
  assertEvaluateCannotSoleFlipAcceptance,
  buildEvaluateStepEvidence,
  shouldHostBindDirectedUpdate,
  synthesizeEditorialInputAskSlots,
} from "./runner-ports.js";
export type {
  EvaluateStepRejectCode,
  EvaluateStepPolicyInput,
  SourceEvidenceRunnerBinding,
  EditorialAdmittedSourceV1,
  EditorialPlannedPageAdmissionV1,
  EditorialAdmissionControlV1,
  EditorialInputAskFillKindV1,
  EditorialInputAskSlotV1,
  WorkflowRunnerOptions,
  FirstPassDocumentationTargetControl,
} from "./runner-ports.js";

/** Whether a planner stop may probe for a clean, patchless pre-write outcome. */
export function canProbeCleanPlannerStop(input: {
  readonly record: RunRecord;
  readonly stepId: string;
  readonly stepStatus: string;
  readonly writeExecutionStarted: boolean;
  readonly hasAnswerRecordContinuation: boolean;
  readonly authoringCaptureCount: number;
  readonly hasRepositoryEvidenceCollector: boolean;
}): boolean {
  const { record } = input;
  return (
    input.stepId === "plan-documentation" &&
    input.stepStatus === "needs-input" &&
    !input.writeExecutionStarted &&
    !input.hasAnswerRecordContinuation &&
    input.authoringCaptureCount === 0 &&
    input.hasRepositoryEvidenceCollector &&
    !record.changes?.patch &&
    (record.changes?.files.length ?? 0) === 0 &&
    !record.steps.some(
      (candidate) =>
        candidate.mode === "write" &&
        (candidate.startedAt !== undefined ||
          candidate.inheritedFrom !== undefined ||
          candidate.status === "succeeded" ||
          candidate.status === "failed" ||
          candidate.status === "running"),
    )
  );
}

export class WorkflowRunner {
  private readonly now: () => Date;
  private readonly id: () => string;

  private readonly options: WorkflowRunnerOptions;

  public constructor(options: WorkflowRunnerOptions) {
    // Every record this runner saves carries its failure classes.
    this.options = {
      ...options,
      store: classifyingRunStore(serializingRunStore(options.store)),
    };
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  public async run(
    request: RunRequest,
    firstPassTargetControl?: FirstPassDocumentationTargetControl,
  ): Promise<RunRecord> {
    // The CLI loads DocsFab's environment before entering WorkflowRunner;
    // embedding hosts may pass their already-resolved effective policy.
    const evidenceInputFormatPolicy =
      this.options.evidenceInputFormatPolicy ?? resolveEvidenceInputFormatPolicy();
    const admissionRunner = {
      options: this.options,
      id: () => this.id(),
      timestamp: () => this.timestamp(),
    };
    const admission = admitWorkflowRunRequest(admissionRunner, request, firstPassTargetControl);
    const {
      validatedFirstPassTargetControl,
      workflow,
      sourceObligationPhases,
      knowledgeResumeReceipt,
      runId,
      compositionExecution,
      sourceEvidence,
      sourceCapability,
    } = admission;
    const v2 = isWorkflowManifestV2(workflow);
    const v3 = isWorkflowManifestV3(workflow);
    let selectedHasWriteStep = admission.selectedHasWriteStep;
    // Read repository instructions from the admitted tree before any write, so
    // a candidate cannot remove a check requirement governing its own proposal.
    // `undefined` means unobservable, which fails the write closed.
    let baselineRepositoryInstructions: readonly RepositoryInstructionV1[] | undefined;
    if (!v3 && request.allowWrite) {
      try {
        baselineRepositoryInstructions = (
          await observeCheckedSnapshot(request.workspacePath, { digest: false })
        ).instructions;
      } catch {
        baselineRepositoryInstructions = undefined;
      }
    }

    const record = createQueuedRunRecord(admissionRunner, request, admission);
    appendEvidenceWarnings(record, this.options.firstPassNotices ?? []);
    const lineageAccepted = await captureRequestLineage({
      store: this.options.store,
      record,
      request,
      completedAt: this.timestamp(),
    });
    if (!lineageAccepted) return record;
    let releaseTrustedInventory: RepositoryDiscoveryInventoryV1 | undefined;
    let executionSteps = [
      ...(v2
        ? workflow.branching.prefix.steps
        : v3
          ? workflow.authoringSchedule.prefix.steps
          : workflow.steps),
    ];
    let executionContextPolicy = v2
      ? workflow.branching.prefix.contextPolicy
      : v3
        ? workflow.authoringSchedule.prefix.contextPolicy
        : workflow.contextPolicy;
    const answerRecordContinuation = this.options.answerRecordContinuation;
    if (answerRecordContinuation) {
      const receipt = request.answerRecordContinuationReceipt;
      if (v2) {
        const branchId = answerRecordContinuation.selectedPathId;
        const sourceCoverage = answerRecordContinuation.selectionEvidence?.workflowBranchCoverage;
        if (
          (branchId !== "author" && branchId !== "assess-no-change") ||
          sourceCoverage?.selection?.branchId !== branchId
        ) {
          throw new Error("The selected answer-record continuation path is not authenticated.");
        }
        const selected = workflowSelectedPath(workflow, branchId);
        executionSteps = [...selected.steps];
        executionContextPolicy = selected.contextPolicy;
        selectedHasWriteStep = selected.steps.some((step) => step.mode === "write");
        record.workflowBranchCoverage = structuredClone(sourceCoverage);
        if (answerRecordContinuation.sourceArtifacts) {
          record.artifacts = structuredClone(answerRecordContinuation.sourceArtifacts);
        }
        record.steps = selected.steps.map((step) => ({
          id: step.id,
          title: step.title,
          kind: step.kind ?? "inference",
          ...(step.operation ? { operation: step.operation } : {}),
          skill: step.skill,
          mode: step.mode,
          status: "pending",
        }));
      } else if (v3) {
        throw new Error("Process continuation of CREATE V3 authoring workflows is not supported.");
      } else if (answerRecordContinuation.selectedPathId !== undefined) {
        throw new Error("The selected answer-record continuation path is not applicable.");
      }
      const resumeIndex = executionSteps.findIndex(
        (step) => step.id === answerRecordContinuation.resumeStepId,
      );
      if (
        !receipt ||
        receipt.sourceRunId !== answerRecordContinuation.sourceRunId ||
        receipt.logicalRunId !== answerRecordContinuation.logicalRunId ||
        resumeIndex < 0 ||
        answerRecordContinuation.completedPrefix.length !== resumeIndex ||
        record.steps.length !== executionSteps.length
      ) {
        throw new Error("The selected answer-record continuation step prefix is invalid.");
      }
      for (let index = 0; index < resumeIndex; index += 1) {
        const step = executionSteps[index]!;
        const inherited = answerRecordContinuation.completedPrefix[index]!;
        if (
          inherited.id !== step.id ||
          inherited.status !== "succeeded" ||
          inherited.skill !== step.skill ||
          inherited.mode !== step.mode
        ) {
          throw new Error("The selected answer-record continuation step prefix is invalid.");
        }
        record.steps[index] = {
          ...structuredClone(inherited),
          inheritedFrom: {
            sourceRunId: answerRecordContinuation.sourceRunId,
            sourceRunRecordSha256: receipt.sourceRunRecordSha256,
            sourceStepId: inherited.id,
          },
        };
        if (inherited.tools) addTools(record.tools, inherited.tools);
      }
    }
    const contextTarget = taskContextTarget(request);
    const contextScope = taskContextScope(request);
    // A one-page focused review uses that page's structural neighbourhood. A
    // multi-page focused review keeps the catalog's corpus/expand policy but
    // forwards its page set (`contextScope`): every page must bind or the
    // preflight fails. A documentation-set review stays unscoped. The narrow
    // policy is not in the catalog because untargeted consumers would then
    // report `target-not-applicable`.
    if (request.workflow === "review-documentation" && contextTarget) {
      executionContextPolicy = {
        schemaVersion: 1,
        steps: executionContextPolicy.steps.map((policy) => ({
          ...policy,
          level: "change-scoped" as const,
          query: "get-neighborhood" as const,
        })),
      };
    }
    let branchSelection: WorkflowBranchSelectionEvidenceV1 | undefined;
    let editorialHost = this.options.workflowBranchEvidence;
    let editorialAdmissionState = this.options.editorialAdmission;
    let admittedEditorialEvidenceRefs = [
      ...(this.options.editorialAdmission?.editorialEvidenceRefs ??
        request.editorialEvidenceRefs ??
        []),
    ];
    const workflowOutcomeDecodeOptions = () => ({
      authorizeSecurityScan,
      resolveSecurityScanEffectiveDisposition,
      ...(v2 && editorialHost
        ? {
            decodeEditorialDecision: (
              reference: Parameters<WorkflowBranchEvidenceHost["decodeEditorialDecision"]>[0],
              stepId: string,
            ) => editorialHost!.decodeEditorialDecision(reference, stepId),
            decodeWorkflowBranchCoverage: (value: unknown, candidateRecord: Readonly<RunRecord>) =>
              decodeWorkflowBranchCoverageV1(
                value,
                workflowBranchCoverageDecodeOptionsV1({
                  workflow,
                  record: candidateRecord,
                  requireComplete: candidateRecord.status === "succeeded",
                }),
              ),
          }
        : {}),
    });
    const retainEditorialNeedsInputOutcome = (inputId: string, code: string): void => {
      const plannerEvidence = workflowOutcomeStepEvidence(
        record,
        workflow.branching!.selection.afterStepId,
      );
      const candidateUse = (record.artifacts ?? []).find(
        (use) =>
          use.role === "output" &&
          use.stepId === workflow.branching!.selection.afterStepId &&
          use.reference.kind === "editorial-decision",
      );
      if (!candidateUse) {
        throw new Error(
          "Editorial candidate evidence is unavailable for workflow outcome binding.",
        );
      }
      const candidateEvidence = workflowOutcomeArtifactEvidence(record, candidateUse);
      const evidence = [plannerEvidence, candidateEvidence];
      record.workflowOutcome = createWorkflowOutcome(
        {
          disposition: "needs-input",
          findings: [
            {
              id: `finding:editorial:${code}`,
              kind: "missing-governed-input",
              severity: "warning",
              code,
              inputId,
              evidenceIds: evidence.map((item) => item.id),
            },
          ],
          evidence,
          limitations: [],
          openDecisions: [
            {
              id: `decision:editorial:${inputId}`,
              kind: "governed-input",
              inputId,
              evidenceIds: evidence.map((item) => item.id),
            },
          ],
          producedArtifacts: [candidateUse.reference],
        },
        record,
        workflowOutcomeDecodeOptions(),
      );
    };
    let progressSequence = 0;
    const searchParticipation = createSearchParticipationState();
    if (answerRecordContinuation) {
      const receipt = request.answerRecordContinuationReceipt;
      const prefix = answerRecordContinuation.completedPrefix;
      const target = executionSteps.find(
        (step) => step.id === answerRecordContinuation.resumeStepId,
      );
      if (
        !receipt ||
        receipt.inheritedPrefixSha256 !== answerRecordContinuationPrefixSha256(prefix)
      ) {
        throw new Error("The inherited continuation prefix does not match its receipt.");
      }
      if (target?.search && (target.searchMode === "reuse" || target.searchMode === "revalidate")) {
        const inheritedRecords = record.steps.slice(0, prefix.length);
        const observerIndex = inheritedRecords.findIndex((step, index) => {
          const participation = step.searchParticipation;
          return (
            step.status === "succeeded" &&
            step.inheritedFrom?.sourceRunId === answerRecordContinuation.sourceRunId &&
            step.inheritedFrom.sourceRunRecordSha256 === receipt.sourceRunRecordSha256 &&
            step.inheritedFrom.sourceStepId === step.id &&
            step.id === prefix[index]?.id &&
            participation?.schemaVersion === 1 &&
            participation.kind === "docsfab-step-search-participation" &&
            participation.planId === target.search!.id &&
            (participation.searchMode === "observe" || participation.searchMode === "revalidate") &&
            participation.observedByStepId === step.id
          );
        });
        if (observerIndex < 0) {
          throw new Error(
            `The inherited continuation prefix has no authenticated observation for search plan "${target.search.id}".`,
          );
        }
        const observer = inheritedRecords[observerIndex]!;
        const participation = observer.searchParticipation!;
        if (!observer.searchEvidence || !observer.searchFindings || !observer.gapLedger) {
          throw new Error("The inherited search observation is missing its sealed evidence.");
        }
        const searchEvidence = decodeWorkflowSearchEvidence(
          observer.searchEvidence,
          target.search,
          record.repository,
        );
        if (
          participation.searchEvidenceSha256 !== searchEvidence.evidenceSha256 ||
          participation.workspaceSnapshotSha256 !== searchEvidence.workspaceSnapshotSha256
        ) {
          throw new Error("The inherited search participation does not bind its evidence.");
        }
        const expectedFindings = projectDocumentationSearchFindings({
          workflow: workflow.name,
          stepId: observer.id,
          evidence: searchEvidence,
        });
        if (canonicalDigest(observer.searchFindings) !== canonicalDigest(expectedFindings)) {
          throw new Error("The inherited search finding projection does not match its evidence.");
        }
        const gapLedger = decodeDocumentationGapLedger(observer.gapLedger);
        if (
          gapLedger.currentRevision !== record.repository.revision ||
          canonicalDigest(currentDocumentationGapFindings(gapLedger)) !==
            canonicalDigest(expectedFindings)
        ) {
          throw new Error(
            "The inherited search gap ledger does not match this repository revision.",
          );
        }
        const observation: LastSearchObservation = {
          stepId: observer.id,
          observedByStepId: observer.id,
          searchMode: participation.searchMode,
          planId: participation.planId,
          workspaceSnapshotSha256: searchEvidence.workspaceSnapshotSha256,
          searchEvidence,
          searchFindings: expectedFindings,
          gapLedger,
          ...(observer.repositoryBatchAuthority
            ? { repositoryBatchAuthority: observer.repositoryBatchAuthority }
            : {}),
        };
        searchParticipation.lastByPlanId.set(target.search.id, observation);
        searchParticipation.writeSinceLastSearch = inheritedRecords
          .slice(observerIndex + 1)
          .some((step) => step.status === "succeeded" && step.mode === "write");
        record.gapLedger = gapLedger;
        record.searchFindings = currentDocumentationGapFindings(gapLedger);
        record.negativeEvidence = negativeDocumentationEvidence(record.searchFindings);
      }
    }
    const planBindings = new Map<string, AdmittedDocumentationPlanBinding>();
    let sourceObligationLedger: SourceObligationLedger | undefined;
    let originalSourceAuthorityCapture: OriginalSourceAuthorityCapture | undefined;
    let originalSourceAuthorityEvidence: OriginalSourceAuthorityEvidenceV1 | undefined;
    let preservationBaseEvidence:
      | import("./source-obligation.js").PreservationBaseEvidence
      | undefined;
    let preservationSourceObservationCache:
      | import("./preservation-source-observation-cache.js").PreservationSourceObservationCacheV1
      | undefined;
    let navigationIndexBases: ReadonlyMap<string, readonly string[]> | undefined;
    let sourceObligationInput:
      | AuthoringRevisionValidationContextV1["sourceObligationInput"]
      | undefined;
    let activeWorkspacePath = request.workspacePath;
    let activeWorkflowSearch = this.options.workflowSearch;
    let activeSourceObserver = this.options.sourceObligationObserver;
    let activeHostOperations = this.options.hostOperations;
    let activeRepositoryEvidence = this.options.repositoryEvidence;
    let authoringQualityValidation: WorkflowRunnerOptions["qualityValidation"];
    const finalization = createRunFinalization({
      request,
      record,
      options: this.options,
      workspacePath: () => activeWorkspacePath,
      repositoryEvidence: () => activeRepositoryEvidence,
      writeExecutionStarted: () => writeExecutionStarted,
      selectedHasWriteStep: () => selectedHasWriteStep,
      assessNoChange: () => v2 && branchSelection?.branchId === "assess-no-change",
    });
    const candidate = new RunCandidateLifecycle({
      options: this.options,
      request,
      record,
      workflow,
      isV3: v3,
      planBindings,
      sourceLedger: () => sourceObligationLedger,
      sourceInput: () => sourceObligationInput,
      workspacePath: () => activeWorkspacePath,
      resetActiveWorkspace: () => {
        activeWorkspacePath = request.workspacePath;
        activeWorkflowSearch = this.options.workflowSearch;
        activeSourceObserver = this.options.sourceObligationObserver;
        activeHostOperations = this.options.hostOperations;
        activeRepositoryEvidence = this.options.repositoryEvidence;
      },
      activateRevisionSession: (revisionSession) => {
        activeWorkspacePath = revisionSession.workspacePath;
        activeWorkflowSearch = revisionSession.search;
        activeSourceObserver = revisionSession.sourceObserver;
        activeHostOperations = revisionSession.hostOperations;
        activeRepositoryEvidence = revisionSession.repositoryEvidence;
      },
      noteMaterialization: finalization.noteCandidateMaterialization,
    });
    const authoringProducerSummary = (
      stepId: string,
      selected: AuthoringCandidateCaptureV1["candidate"],
    ) => {
      const producer = record.steps.find((step) => step.id === stepId);
      if (!producer?.summary || producer.status !== "succeeded") {
        throw new Error(`Selected CREATE V3 producer "${stepId}" has no admitted summary.`);
      }
      return {
        stepId,
        summarySha256: sha256(producer.summary),
        candidateOrdinal: selected.ordinal,
        candidateDigest: selected.digest,
        workspaceSnapshotDigest: selected.workspaceSnapshotDigest,
      };
    };
    const emit = (event: ProgressEventInput): void => {
      this.options.onProgress?.({ ...event, sequence: ++progressSequence } as ProgressEvent);
    };
    let writeExecutionStarted = false;
    let continueIndependentEvaluate = false;
    const captureChangesOnce = finalization.captureChangesOnce;
    const captureAuthorizedWritePaths = finalization.captureAuthorizedWritePaths;
    const finalizeMutationOnce = finalization.finalizeMutationOnce;
    const disposeAuthoringRevision = () => candidate.disposeRevision();
    const refreshAuthoringExecution = (includeFinalPatch = false) =>
      candidate.refreshExecution(includeFinalPatch);
    const sealAuthoringCandidateZero = () => candidate.sealCandidateZero();
    const captureFailedAuthoringRevision = (failureCode: string) =>
      candidate.captureFailedRevision(failureCode);
    const materializeSelectedAuthoringCandidate = () => candidate.materializeSelected();
    const authoringCandidates = () => candidate.candidates();

    const terminal: WorkflowRunTerminalSession = {
      options: this.options,
      timestamp: () => this.timestamp(),
      request,
      workflow,
      compositionExecution,
      record,
      v2,
      v3,
      authoringCaptures: candidate.captures,
      get selectedHasWriteStep() {
        return selectedHasWriteStep;
      },
      get baselineRepositoryInstructions() {
        return baselineRepositoryInstructions;
      },
      get releaseTrustedInventory() {
        return releaseTrustedInventory;
      },
      get executionSteps() {
        return executionSteps;
      },
      get branchSelection() {
        return branchSelection;
      },
      get editorialHost() {
        return editorialHost;
      },
      get activeWorkspacePath() {
        return activeWorkspacePath;
      },
      get authoringBranchId() {
        return candidate.branchId;
      },
      get authoringSelectedOrdinal() {
        return candidate.selectedOrdinal;
      },
      get authoringRevisionSession() {
        return candidate.revisionSession;
      },
      get writeExecutionStarted() {
        return writeExecutionStarted;
      },
      get continueIndependentEvaluate() {
        return continueIndependentEvaluate;
      },
      finalizeMutationOnce,
      disposeAuthoringRevision,
      captureChangesOnce,
      get rstCaptureFailureMessage() {
        return finalization.rstCaptureFailureMessage;
      },
      materializeSelectedAuthoringCandidate,
      sealAuthoringCandidateZero,
      captureFailedAuthoringRevision,
      authoringCandidates,
      emit,
      workflowOutcomeDecodeOptions,
    };
    try {
      await this.options.store.save(record);
      assertWorkflowActive(request.signal);
      const scopeAdmitted = await admitReviewScopeCapacity({
        store: this.options.store,
        record,
        request,
        workflow,
        ...(activeSourceObserver ? { observer: activeSourceObserver } : {}),
        completedAt: () => this.timestamp(),
      });
      if (!scopeAdmitted) {
        emit({ type: "run-status", runId: record.id, status: record.status });
        return record;
      }

      // The repository credential scan is advisory: secret enforcement is CI's
      // responsibility, so scanner output does not gate workflow eligibility,
      // writes, or publication. It is kept as content-free diagnostics.
      record.securityScan = await scanRepository(
        this.options.repositoryScanner,
        activeWorkspacePath,
      );
      record.securityScanEffectiveDisposition = { status: "advisory" };
      assertWorkflowActive(request.signal);
      if (record.securityScan.status !== "passed") {
        record.evidenceWarnings = [
          ...(record.evidenceWarnings ?? []),
          `Repository credential scan is advisory (status ${record.securityScan.status}, ${record.securityScan.findings.length} finding(s)); repository secret enforcement is CI's responsibility and does not gate DocsFab execution.`,
        ];
      }
      // Credential-like content is flagged for the maintainers and the run
      // continues (#1807); only a configured credential stops it, elsewhere.
      const credentialLikeContent = await collectCredentialLikeContent({
        runId: record.id,
        report: record.securityScan,
        workspacePath: activeWorkspacePath,
        requestText: record.instruction,
      });
      if (credentialLikeContent.warning !== undefined) {
        record.credentialFindings = credentialLikeContent.findings;
        record.evidenceWarnings = [
          ...(record.evidenceWarnings ?? []),
          credentialLikeContent.warning,
        ];
      }

      record.status = "running";
      record.startedAt = this.timestamp();
      emit({ type: "run-status", runId: record.id, status: record.status });
      await this.options.store.save(record);

      for (let index = 0; index < executionSteps.length; index += 1) {
        const step = executionSteps[index]!;
        if (answerRecordContinuation && index < answerRecordContinuation.completedPrefix.length) {
          continue;
        }
        let completedStepResult: HarnessStepResult | undefined;
        assertWorkflowActive(request.signal);
        const stepRecord = record.steps[index];
        if (!stepRecord) {
          throw new Error(`Missing run record for workflow step ${step.id}`);
        }
        if (continueIndependentEvaluate && !canContinueIndependentEvaluate(step, record)) {
          markContextUnnecessary(record, index, "workflow-stopped-before-step", index + 1);
          continue;
        }
        if (v2 && step.mode === "write" && !request.allowWrite) {
          stepRecord.status = "needs-input";
          record.status = "needs-input";
          record.completedAt = this.timestamp();
          record.durationMs = durationMs(record.startedAt, record.completedAt);
          retainEditorialNeedsInputOutcome("allow-write", "write-grant-required");
          markContextUnnecessary(record, index + 1, "workflow-stopped-before-step");
          await this.options.store.save(record);
          emit({
            type: "step-status",
            runId: record.id,
            stepId: step.id,
            status: stepRecord.status,
          });
          emit({ type: "run-status", runId: record.id, status: record.status });
          return record;
        }

        stepRecord.status = "running";
        stepRecord.startedAt = this.timestamp();
        emit({
          type: "step-status",
          runId: record.id,
          stepId: step.id,
          status: stepRecord.status,
        });
        await this.options.store.save(record);

        const authoringPhaseDefinition = v3
          ? (authoringPrefixPhaseForStep(workflow, step.id) ??
            (candidate.branchId
              ? authoringPhaseForStep(workflow, candidate.branchId, step.id)
              : undefined))
          : undefined;
        const authoringPhase = authoringPhaseDefinition
          ? authoringPhaseInvocationBindingV1({
              workflow,
              branchId: authoringPrefixPhaseForStep(workflow, step.id) ? null : candidate.branchId,
              stepId: step.id,
              candidates: authoringCandidates(),
              revisionInputDigest:
                step.id === "revise-documentation"
                  ? (candidate.revisionInput?.digest ?? null)
                  : null,
            })
          : undefined;
        if (
          step.id === "evaluate-document-quality" &&
          selectedHasWriteStep &&
          (workflow.name === "create-documentation" || workflow.name === "update-documentation") &&
          this.options.prepareAuthoringQualityValidation
        ) {
          const plan = planBindings.get("plan-documentation");
          if (!plan || !activeRepositoryEvidence)
            throw new Error("Authoring quality requires its admitted plan and patch collector.");
          const capture = v3
            ? candidate.captures[authoringPhase?.assessedCandidateOrdinal ?? 0]
            : undefined;
          authoringQualityValidation = await this.options.prepareAuthoringQualityValidation({
            workflow,
            record,
            workspacePath: activeWorkspacePath,
            targetPaths: [...documentationPlanPagePaths(plan)].sort(),
            repositoryEvidence: activeRepositoryEvidence,
            ...(capture ? { capture } : {}),
            ...(candidate.revisionSession
              ? { repositoryWorkspace: candidate.revisionSession.repositoryWorkspace }
              : {}),
          });
          record.qualityProfileSelection = authoringQualityValidation.selection.receipt;
        }
        const stepOptions = authoringQualityValidation
          ? { ...this.options, qualityValidation: authoringQualityValidation }
          : this.options;
        const gatesQualityText = isQualityCandidateValidationStep({
          workflow,
          step,
          qualityArtifactBound: stepOptions.qualityValidation !== undefined,
        });
        try {
          try {
            completedStepResult = await executeGovernedWorkflowStep({
              options: stepOptions,
              evidenceInputFormatPolicy,
              now: () => this.now(),
              timestamp: () => this.timestamp(),
              emit,
              request,
              workflow,
              step,
              stepRecord,
              record,
              executionContextPolicy,
              contextTarget,
              contextScope,
              activeWorkspacePath,
              activeWorkflowSearch,
              activeSourceObserver,
              activeHostOperations,
              searchParticipation,
              planBindings,
              authoringCaptures: candidate.captures,
              authoringBranchId: candidate.branchId,
              authoringRevisionSession: candidate.revisionSession,
              authoringRevisionInput: candidate.revisionInput,
              authoringPhase,
              gatesQualityText,
              branchSelection,
              admittedEditorialEvidenceRefs,
              editorialHost,
              sourceCapability,
              sourceEvidence,
              sourceObligationPhases,
              selectedHasWriteStep,
              validatedFirstPassTargetControl,
              knowledgeResumeReceipt,
              session: {
                get releaseTrustedInventory() {
                  return releaseTrustedInventory;
                },
                set releaseTrustedInventory(value) {
                  releaseTrustedInventory = value;
                },
                get sourceObligationLedger() {
                  return sourceObligationLedger;
                },
                set sourceObligationLedger(value) {
                  sourceObligationLedger = value;
                },
                get sourceObligationInput() {
                  return sourceObligationInput;
                },
                set sourceObligationInput(value) {
                  sourceObligationInput = value;
                },
                get admittedCandidate0Editorial() {
                  return candidate.admittedCandidate0Editorial;
                },
                set admittedCandidate0Editorial(value) {
                  candidate.admittedCandidate0Editorial = value;
                },
                get originalSourceAuthorityCapture() {
                  return originalSourceAuthorityCapture;
                },
                set originalSourceAuthorityCapture(value) {
                  originalSourceAuthorityCapture = value;
                },
                get originalSourceAuthorityEvidence() {
                  return originalSourceAuthorityEvidence;
                },
                set originalSourceAuthorityEvidence(value) {
                  originalSourceAuthorityEvidence = value;
                },
                get preservationBaseEvidence() {
                  return preservationBaseEvidence;
                },
                set preservationBaseEvidence(value) {
                  preservationBaseEvidence = value;
                },
                get preservationSourceObservationCache() {
                  return preservationSourceObservationCache;
                },
                set preservationSourceObservationCache(value) {
                  preservationSourceObservationCache = value;
                },
                get navigationIndexBases() {
                  return navigationIndexBases;
                },
                set navigationIndexBases(value) {
                  navigationIndexBases = value;
                },
                get writeExecutionStarted() {
                  return writeExecutionStarted;
                },
                set writeExecutionStarted(value) {
                  writeExecutionStarted = value;
                },
              },
            });
            stepRecord.status = completedStepResult.outcome ?? "succeeded";
          } catch (error) {
            if (error instanceof GovernedSkillIntegrityError && error.code === "lock-unavailable") {
              throw new GovernedSkillIntegrityError("lock-unavailable");
            }
            if (error instanceof Error) {
              if (error.message === "Governed skill resolver returned an unexpected identity.") {
                throw new Error(`Governed skill resolver returned an unexpected identity.`);
              }
              if (error.message === "Governed skill inspection returned an unexpected identity.") {
                throw new Error(`Governed skill inspection returned an unexpected identity.`);
              }
              if (error.message === "Workflow step returned an unexpected skill identity.") {
                throw new Error(`Workflow step returned an unexpected skill identity.`);
              }
              if (error.message === "Governed skill identity changed during execution.") {
                throw new Error(`Governed skill identity changed during execution.`);
              }
            }
            throw error;
          }
        } catch (error) {
          if (error instanceof QualityArtifactValidationError) {
            stepRecord.status = "failed";
            stepRecord.error = error.message;
            stepRecord.failure = classifyQualityValidationFailure({
              failureCode: error.code,
              ...(error.rejection ? { rejectionCode: error.rejection.code } : {}),
            });
            if (error.reportMarkdown) {
              stepRecord.summary = error.reportMarkdown;
              emit({
                type: "text",
                runId: record.id,
                stepId: step.id,
                text: error.reportMarkdown,
              });
            } else {
              delete stepRecord.summary;
              stepRecord.error = error.message;
            }
            record.qualityArtifactValidation = error.binding;
            stepRecord.qualityValidationRejection = { ...error.rejection };
          } else {
            stepRecord.status = "failed";
            if (gatesQualityText) delete stepRecord.summary;
            // A quality-path refusal with no validation binding still records its code.
            if (error instanceof QualityStepRejectionError) {
              stepRecord.qualityValidationRejection = { ...error.rejection };
            }
            const revisionRejection =
              step.id === REVISE_DOCUMENTATION_STEP_ID
                ? authoringRevisionRejectionOf(error)
                : undefined;
            if (revisionRejection) stepRecord.authoringRevisionRejection = revisionRejection;
            stepRecord.failure = classifyStepFailure({
              error,
              step: stepRecord,
              cancelled: Boolean(request.signal?.aborted),
            });
            stepRecord.error = request.signal?.aborted
              ? WORKFLOW_CANCELLED
              : stepFailureMessage(
                  error instanceof Error ? error.message : String(error),
                  stepRecord,
                );
            const retainedFindings = retainedTechnicalReviewFindings(error);
            if (
              retainedFindings &&
              !gatesQualityText &&
              (requiresVerificationResult({ workflow, step }) ||
                requiresEditorialReviewResult({ workflow, step }))
            ) {
              stepRecord.summary = canonicalizeJsonEvidence(
                retainedFindings as unknown as JsonEvidenceValue,
              ).trimEnd();
            }
          }
          stepRecord.completedAt = this.timestamp();
          stepRecord.durationMs = durationMs(stepRecord.startedAt, stepRecord.completedAt);
          record.status = "failed";
          record.error = request.signal?.aborted
            ? WORKFLOW_CANCELLED
            : stepFailureMessage(
                error instanceof Error ? error.message : String(error),
                stepRecord,
              );
          const continueIndependent = shouldContinueAfterTechnicalAdmissionStop({
            aborted: Boolean(request.signal?.aborted),
            step,
            error,
          });
          if (continueIndependent) {
            continueIndependentEvaluate = true;
          } else {
            markContextUnnecessary(record, index + 1, "workflow-stopped-before-step");
            record.completedAt = this.timestamp();
            record.durationMs = durationMs(record.startedAt, record.completedAt);
          }
          if (v3 && authoringPhase) {
            if (step.id === "revise-documentation") {
              await captureFailedAuthoringRevision(
                request.signal?.aborted ? "cancelled" : "revision-writer-failed",
              );
            }
            stepRecord.authoringPhase = createAuthoringPhaseEvidenceV1({
              workflow,
              branchId: authoringPrefixPhaseForStep(workflow, step.id) ? null : candidate.branchId,
              stepId: step.id,
              candidates: authoringCandidates(),
              outputAdmitted: false,
              summary: stepRecord.summary ?? null,
            });
            await materializeSelectedAuthoringCandidate();
          }
          emit({
            type: "step-status",
            runId: record.id,
            stepId: step.id,
            status: stepRecord.status,
          });
          if (!continueIndependent) {
            emit({ type: "run-status", runId: record.id, status: record.status });
          }
          const { impactSucceeded, evidenceCaptured, provenanceRejected } =
            await finalizeMutationOnce();
          const sourceReferencePreflightFailed =
            error instanceof SourceObligationSourceReferenceError && !writeExecutionStarted;
          const closedTechnicalRejection = technicalResponseDiagnosticFromMessage(
            error instanceof Error ? error.message : undefined,
          );
          if (selectedHasWriteStep && !evidenceCaptured && !sourceReferencePreflightFailed) {
            if (!closedTechnicalRejection) {
              record.error =
                recognizedRstRegionErrorMessage(error) ??
                finalization.rstCaptureFailureMessage ??
                (provenanceRejected ? provenanceRejectionError : patchPersistenceError);
            }
          } else if (!impactSucceeded && !closedTechnicalRejection) {
            record.error = impactPostflightError;
          }
          await this.options.store.save(record);
          if (continueIndependent) {
            continue;
          }
          await disposeAuthoringRevision();
          return record;
        }

        await this.options.store.save(record);
        if (step.mode === "write" && stepRecord.status === "succeeded") {
          markAuthorizedWrite(searchParticipation);
          if (activeWorkflowSearch) {
            await captureAuthorizedWritePaths();
          }
        }
        if (v3 && authoringPhase) {
          const plan = planBindings.get("plan-documentation");
          if (!plan) {
            throw new Error("CREATE V3 phase evidence requires the admitted documentation plan.");
          }
          // A writer that stopped (for example on a plan-scope stop) has no
          // admitted output: like a failed writer, it seals no candidate, and a
          // stopped reviser leaves candidate zero selected with a
          // non-deliverable partial. Its stop then keeps the selected result.
          const outputAdmitted = stepRecord.status === "succeeded";
          if (!outputAdmitted) {
            if (step.id === "revise-documentation") {
              await captureFailedAuthoringRevision(
                stepRecord.planScopeStop?.code ?? "revision-writer-stopped",
              );
            }
          } else if (step.id === "write-documentation") {
            await sealAuthoringCandidateZero();
          } else if (step.id === "revise-documentation") {
            if (!completedStepResult?.authoringRevisionAccounting) {
              throw new Error(
                "CREATE V3 candidate one requires its sealed revision input and workspace.",
              );
            }
            await candidate.sealCandidateOne({
              plan,
              accounting: completedStepResult.authoringRevisionAccounting,
              stepRecord,
            });
          }
          stepRecord.authoringPhase = createAuthoringPhaseEvidenceV1({
            workflow,
            branchId: authoringPrefixPhaseForStep(workflow, step.id) ? null : candidate.branchId,
            stepId: step.id,
            candidates: authoringCandidates(),
            outputAdmitted: stepRecord.status === "succeeded",
            summary: stepRecord.summary ?? null,
          });
          if (!outputAdmitted) {
            refreshAuthoringExecution();
            await materializeSelectedAuthoringCandidate();
          }
          await this.options.store.save(record);
        }
        for (const artifact of stepRecord.artifacts ?? []) {
          emit({
            type: "artifact-reference",
            runId: record.id,
            stepId: step.id,
            status: "referenced",
            artifact: structuredClone(artifact),
          });
        }
        emit({
          type: "step-status",
          runId: record.id,
          stepId: step.id,
          status: stepRecord.status,
        });
        if (v3 && step.id === workflow.authoringSchedule.selection.afterStepId) {
          const candidate0 = candidate.captures[0]?.candidate;
          const plan = planBindings.get("plan-documentation");
          const technicalStep = record.steps.find(
            (candidate) => candidate.id === "verify-technical-accuracy",
          );
          const editorialStep = record.steps.find(
            (candidate) => candidate.id === "review-documentation",
          );
          if (
            !candidate0 ||
            !plan ||
            !sourceObligationInput ||
            !sourceObligationLedger ||
            !candidate.originalSourceSearchSnapshotSha256 ||
            !technicalStep?.summary ||
            !technicalStep.technicalCorrectionEvidence ||
            !editorialStep?.summary
          ) {
            throw new Error("CREATE V3 revision selection is missing admitted candidate evidence.");
          }
          const targetPaths = documentationPlanPagePaths(plan);
          const technicalResult = decodeAdmittedVerificationSummary(
            technicalStep.summary,
            targetPaths,
          );
          if (!technicalResult) {
            throw new Error("CREATE V3 revision selection has no admitted technical result.");
          }
          const editorial =
            candidate.admittedCandidate0Editorial ??
            ({
              summary: editorialStep.summary,
              summaryDigest: sha256(editorialStep.summary),
              producerId: editorialStep.id,
              candidateDigest: candidate0.digest,
              candidateOrdinal: 0,
              workspaceSnapshotDigest: candidate0.workspaceSnapshotDigest,
              result: validateEditorialReviewResult(parseJsonEvidence(editorialStep.summary)),
            } satisfies AuthoringProducerBindingV1<ReviewResult>);
          if (
            editorial.summary !== editorialStep.summary ||
            editorial.summaryDigest !== sha256(editorialStep.summary) ||
            editorial.candidateDigest !== candidate0.digest ||
            editorial.workspaceSnapshotDigest !== candidate0.workspaceSnapshotDigest
          ) {
            throw new Error("CREATE V3 revision selection rejected changed editorial evidence.");
          }
          const technical: AuthoringProducerBindingV1<VerificationResult> = {
            summary: technicalStep.summary,
            summaryDigest: sha256(technicalStep.summary),
            producerId: technicalStep.id,
            candidateDigest: candidate0.digest,
            candidateOrdinal: 0,
            workspaceSnapshotDigest: candidate0.workspaceSnapshotDigest,
            result: technicalResult,
          };
          const selectionContext: AuthoringRevisionValidationContextV1 = {
            candidate0,
            originalRevision: record.repository.revision,
            planDigest: plan.digest,
            writePaths: targetPaths,
            technical,
            editorial,
            sourceObligationInput,
            sourceObligationLedger,
            technicalCorrectionEvidence: technicalStep.technicalCorrectionEvidence,
            originalSourceAuthority: originalSourceAuthorityEvidence,
          };
          // A source the bound evidence lacks stops CREATE as named InputAsk
          // slots, not a completed or dead-end run.
          const sourceSupportGaps = authoringSourceSupportGaps(selectionContext);
          if (sourceSupportGaps.length > 0) {
            await materializeSelectedAuthoringCandidate();
            stepRecord.status = "needs-input";
            const stopCode = sourceSupportGaps.some(
              (gap) => gap.code === AUTHORING_SOURCE_SUPPORT_CODES.coverage,
            )
              ? AUTHORING_SOURCE_SUPPORT_CODES.coverage
              : AUTHORING_SOURCE_SUPPORT_CODES.dimension;
            stepRecord.error = authoringSourceSupportStepError(stopCode, technical.summary);
            record.status = "needs-input";
            record.completedAt = this.timestamp();
            record.durationMs = durationMs(record.startedAt, record.completedAt);
            markContextUnnecessary(record, index + 1, "workflow-stopped-before-step");
            const evidence = [
              workflowOutcomeStepEvidence(record, "derive-source-obligations"),
              workflowOutcomeStepEvidence(record, step.id),
            ];
            const evidenceIds = evidence.map((item) => item.id);
            record.workflowOutcome = createWorkflowOutcome(
              {
                disposition: "needs-input",
                findings: sourceSupportGaps.map((gap) => ({
                  id: `finding:source-support:${gap.dimension}:${gap.pagePath}`,
                  kind: "missing-governed-input" as const,
                  severity: "blocking" as const,
                  code: gap.code,
                  inputId: gap.inputId,
                  evidenceIds,
                })),
                evidence,
                limitations: [],
                openDecisions: sourceSupportGaps.map((gap) => ({
                  id: `decision:source-support:${gap.dimension}:${gap.pagePath}`,
                  kind: "governed-input" as const,
                  inputId: gap.inputId,
                  evidenceIds,
                })),
                producedArtifacts: [],
              },
              record,
              workflowOutcomeDecodeOptions(),
            );
            await this.options.store.save(record);
            emit({ type: "step-status", runId: record.id, stepId: step.id, status: "needs-input" });
            emit({ type: "run-status", runId: record.id, status: record.status });
            await disposeAuthoringRevision();
            return record;
          }
          const selected = selectAuthoringRevision(selectionContext);
          if (selected.kind === "revise" && this.options.rstCaptureBinding?.receipt) {
            throw new Error(
              "rst-edit-region-unsupported: RST patch-only updates do not admit a second writer revision.",
            );
          }
          candidate.branchId = selected.kind === "revise" ? "revise" : "retain";
          candidate.revisionInput = selected.kind === "revise" ? selected.input : undefined;
          candidate.selectedOrdinal = 0;
          candidate.selection = {
            branchId: candidate.branchId,
            input: {
              candidate0Digest: candidate0.digest,
              candidate0WorkspaceSnapshotDigest: candidate0.workspaceSnapshotDigest,
              originalRevision: record.repository.revision,
              planDigest: plan.digest,
              writePaths: targetPaths,
              sourceSearchSnapshotSha256: candidate.originalSourceSearchSnapshotSha256,
              sourceObligationLedgerSha256: sourceObligationLedger.digest,
              technicalCorrectionEvidenceSha256: technicalStep.technicalCorrectionEvidence.digest,
              technical: {
                stepId: technicalStep.id,
                summarySha256: technical.summaryDigest,
                candidateOrdinal: 0,
                candidateDigest: candidate0.digest,
                workspaceSnapshotDigest: candidate0.workspaceSnapshotDigest,
              },
              editorial: {
                stepId: editorialStep.id,
                summarySha256: editorial.summaryDigest,
                candidateOrdinal: 0,
                candidateDigest: candidate0.digest,
                workspaceSnapshotDigest: candidate0.workspaceSnapshotDigest,
              },
            },
            revisionInputDigest: candidate.revisionInput?.digest ?? null,
          };
          const selectedPath = authoringSelectedPath(workflow, candidate.branchId);
          const suffix = selectedPath.steps.slice(workflow.authoringSchedule.prefix.steps.length);
          for (const suffixStep of suffix) {
            record.steps.push({
              id: suffixStep.id,
              title: suffixStep.title,
              kind: suffixStep.kind ?? "inference",
              ...(suffixStep.operation ? { operation: suffixStep.operation } : {}),
              skill: suffixStep.skill,
              mode: suffixStep.mode,
              status: "pending",
            });
          }
          if (candidate.branchId === "revise") {
            await candidate.prepareRevision(sourceObligationLedger);
          }
          executionSteps = [...executionSteps, ...suffix];
          executionContextPolicy = selectedPath.contextPolicy;
          refreshAuthoringExecution();
          await this.options.store.save(record);
        }
        const editorialBind = await bindEditorialWorkflowBranch({
          options: this.options,
          timestamp: () => this.timestamp(),
          emit,
          request,
          workflow,
          step,
          stepRecord,
          record,
          completedStepResult,
          planBindings,
          validatedFirstPassTargetControl,
          decodeOptions: workflowOutcomeDecodeOptions,
          session: {
            get editorialHost() {
              return editorialHost;
            },
            set editorialHost(value) {
              editorialHost = value;
            },
            get editorialAdmissionState() {
              return editorialAdmissionState;
            },
            set editorialAdmissionState(value) {
              editorialAdmissionState = value;
            },
            get admittedEditorialEvidenceRefs() {
              return admittedEditorialEvidenceRefs;
            },
            set admittedEditorialEvidenceRefs(value) {
              admittedEditorialEvidenceRefs = value;
            },
            get branchSelection() {
              return branchSelection;
            },
            set branchSelection(value) {
              branchSelection = value;
            },
            get executionSteps() {
              return executionSteps;
            },
            set executionSteps(value) {
              executionSteps = value;
            },
            get executionContextPolicy() {
              return executionContextPolicy;
            },
            set executionContextPolicy(value) {
              executionContextPolicy = value;
            },
            get selectedHasWriteStep() {
              return selectedHasWriteStep;
            },
            set selectedHasWriteStep(value) {
              selectedHasWriteStep = value;
            },
          },
        });
        if (editorialBind.kind === "return") {
          return editorialBind.record;
        }
        if (stepRecord.status === "needs-input" || stepRecord.status === "needs-human-decision") {
          markContextUnnecessary(record, index + 1, "workflow-stopped-before-step");
          record.status = stepRecord.status;
          record.completedAt = this.timestamp();
          record.durationMs = durationMs(record.startedAt, record.completedAt);
          const cleanPlannerProbeAllowed = canProbeCleanPlannerStop({
            record,
            stepId: step.id,
            stepStatus: stepRecord.status,
            writeExecutionStarted,
            hasAnswerRecordContinuation: answerRecordContinuation !== undefined,
            authoringCaptureCount: candidate.captures.length,
            hasRepositoryEvidenceCollector: activeRepositoryEvidence !== undefined,
          });
          const cleanPlannerProbe = cleanPlannerProbeAllowed
            ? await finalization.captureCleanPlannerProbe()
            : undefined;
          const cleanPlannerStop =
            cleanPlannerProbe?.captured === true &&
            record.changes?.files.length === 0 &&
            record.changes.patch === undefined;
          const plannerFinalization = cleanPlannerStop
            ? { impactSucceeded: true, evidenceCaptured: true, provenanceRejected: false }
            : await finalizeMutationOnce();
          const impactSucceeded = plannerFinalization.impactSucceeded;
          const evidenceCaptured =
            plannerFinalization.evidenceCaptured && cleanPlannerProbe?.captured !== false;
          const provenanceRejected =
            plannerFinalization.provenanceRejected ||
            cleanPlannerProbe?.provenanceRejected === true;
          if (selectedHasWriteStep && !evidenceCaptured) {
            record.status = "failed";
            record.error = provenanceRejected ? provenanceRejectionError : patchPersistenceError;
            markRunFailure(
              record,
              provenanceRejected ? "evidence-provenance-rejected" : "patch-persistence-failed",
            );
          } else if (!impactSucceeded) {
            record.status = "failed";
            record.error = impactPostflightError;
            markRunFailure(record, "impact-postflight-failed");
          }
          await applyWorkflowOutcome({
            outcomeProjector: this.options.outcomeProjector,
            record,
            expectedRepository: releaseExpectedRepository(request),
            trustedInventory: releaseTrustedInventory,
            decodeOptions: workflowOutcomeDecodeOptions(),
          });
          await this.options.store.save(record);
          emit({ type: "run-status", runId: record.id, status: record.status });
          await disposeAuthoringRevision();
          return record;
        }
      }

      if (v3 && !continueIndependentEvaluate) {
        if (
          !candidate.branchId ||
          candidate.selectedOrdinal === null ||
          !this.options.authoringCandidateLifecycle
        ) {
          throw new Error("CREATE V3 completed without an admitted selected candidate path.");
        }
        const selected = candidate.captures[candidate.selectedOrdinal];
        if (!selected) {
          throw new Error("The CREATE V3 selected candidate evidence is unavailable.");
        }
        const selectedPath = authoringSelectedPath(workflow, candidate.branchId);
        const lintStepId =
          candidate.selectedOrdinal === 0 ? "lint-documentation" : "lint-revised-documentation";
        candidate.selectedProducers = {
          lint: authoringProducerSummary(lintStepId, selected.candidate),
          technical: authoringProducerSummary(
            selectedPath.technicalProducerStepId,
            selected.candidate,
          ),
          editorial: authoringProducerSummary(
            selectedPath.editorialProducerStepId,
            selected.candidate,
          ),
        };
        if (!(await materializeSelectedAuthoringCandidate())) {
          throw new Error("Selected CREATE V3 candidate could not be materialized for delivery.");
        }
      }
      return await finalizeCompletedWorkflowRun(terminal);
    } catch (error) {
      return await settleThrownWorkflowRun(terminal, error);
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}
