// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Terminal phase of `WorkflowRunner.run`: `finalizeCompletedWorkflowRun` after
 * the step loop, and `settleThrownWorkflowRun` as the body of `run()`'s
 * `catch`.
 */

import type { RunRequest } from "../execution/contracts.js";
import type { RunRecord, RunStore } from "../records/contracts.js";
import type { FileRunStoreErrorCode } from "../records/file-store.js";
import type {
  WorkflowBranchEvidenceHost,
  WorkflowBranchSelectionEvidenceV1,
  WorkflowDefinition,
  WorkflowStep,
} from "../workflow-contracts/contracts.js";
import {
  authoringPhaseForStep,
  authoringPrefixPhaseForStep,
} from "../workflow-contracts/authoring-schedule.js";
import type { WorkflowOutcomeDecodeOptionsV1 } from "../workflow-contracts/outcome.js";
import {
  resealWorkflowOutcomeAfterRetainedReviewResult,
  ReviewResultTransitionError,
} from "../workflow-contracts/outcome.js";
import { canonicalJson } from "../content-ir/canonical.js";
import {
  decodeWorkflowBranchCoverageV1,
  WorkflowBranchCoverageError,
} from "../workflow-contracts/branch-coverage.js";
import { EditorialDecisionValidationError } from "../artifacts/editorial-decision.js";
import type { RepositoryDiscoveryInventoryV1 } from "../repository/inventory.js";
import { assertWorkflowActive, WORKFLOW_CANCELLED } from "../execution/cancellation.js";
import {
  createCompositionExecutionAggregate,
  workflowBranchCoverageDecodeOptionsV1,
  type CompositionExecutionEvidenceV1,
} from "../records/composition-execution.js";
import { createAuthoringPhaseEvidenceV1 } from "../records/authoring-execution.js";
import {
  classifyStepFailure,
  markRunAuthoringCandidateRejection,
  markRunEditorialFinalizationRejection,
  markRunFailure,
  markRunRefusal,
  markRunThrownFailure,
  runFailure,
  workflowOutcomeRejectionFailure,
} from "../operator/failure-classification.js";
import { workflowOutcomeRejection } from "./outcome-rejection.js";
import {
  applyWorkflowOutcome,
  boundedDocImprovementChangesMatch,
  deepFreezeSnapshot,
} from "./runner-evidence.js";
import {
  boundedDocImprovementScopeError,
  durationMs,
  emptyWriteResultError,
  impactPostflightError,
  markContextUnnecessary,
  patchPersistenceError,
  workflowOutcomePersistenceError,
  type ProgressEventInput,
  releaseExpectedRepository,
} from "./runner-schedule.js";
import { addUniqueArtifacts, normalizeArtifactUses, stepFailureMessage } from "./runner-step.js";
import { assessRequiredRepositoryChecks, type RepositoryInstructionV1 } from "./workflow-checks.js";
import { formatRequiredCheckLimitation } from "./required-check-limitation.js";
import { authoringCandidateRejectionOf } from "./authoring-candidate.js";
import { EditorialEvidenceHostError } from "./editorial-evidence-host.js";
import {
  EDITORIAL_FINALIZATION_UNCODED,
  editorialFinalizationRejection,
  type EditorialFinalizationRejectionV1,
} from "./editorial-finalization-rejection.js";
import type { AuthoringCandidateCaptureV1 } from "./authoring-workspace-host.js";
import type { AuthoringRevisionSessionV1 } from "./authoring-runtime.js";
import {
  authoringRevisionRejectionOf,
  REVISE_DOCUMENTATION_STEP_ID,
} from "./authoring-revision.js";
import {
  WorkflowRunnerBoundaryError,
  provenanceRejectionError,
  recognizedRunStoreErrorCode,
} from "./runner-ports.js";
import type { WorkflowRunnerOptions } from "./runner-ports.js";
import { RstRegionError } from "../rst-authoring/contracts.js";
import { retainOriginalReviewResult } from "../review-delivery/result-store.js";

export function recognizedRstRegionErrorMessage(error: unknown): string | undefined {
  try {
    if (!(error instanceof RstRegionError)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    return descriptor && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    // A hostile thrown value must not prevent the failed record from being saved.
    return undefined;
  }
}

/**
 * What the terminal phase reads from one `WorkflowRunner.run` invocation.
 * `options` is the runner's store-classifying copy, not the caller's raw
 * options. `run()` builds one session before its `try` so the `catch` can see
 * it; fields `run()` reassigns later are read-only getters over its live `let`
 * bindings, and closures are passed by reference so their once-only state
 * stays shared with the step loop.
 */
export interface WorkflowRunTerminalSession {
  readonly options: WorkflowRunnerOptions;
  readonly timestamp: () => string;
  readonly request: RunRequest;
  readonly workflow: WorkflowDefinition;
  readonly compositionExecution: CompositionExecutionEvidenceV1 | undefined;
  readonly record: RunRecord;
  readonly v2: boolean;
  readonly v3: boolean;
  readonly authoringCaptures: readonly AuthoringCandidateCaptureV1[];
  readonly selectedHasWriteStep: boolean;
  readonly baselineRepositoryInstructions: readonly RepositoryInstructionV1[] | undefined;
  readonly releaseTrustedInventory: RepositoryDiscoveryInventoryV1 | undefined;
  readonly executionSteps: readonly WorkflowStep[];
  readonly branchSelection: WorkflowBranchSelectionEvidenceV1 | undefined;
  readonly editorialHost: WorkflowBranchEvidenceHost | undefined;
  readonly activeWorkspacePath: string;
  readonly authoringBranchId: "retain" | "revise" | null;
  readonly authoringSelectedOrdinal: 0 | 1 | null;
  readonly authoringRevisionSession: AuthoringRevisionSessionV1 | undefined;
  readonly writeExecutionStarted: boolean;
  readonly continueIndependentEvaluate: boolean;
  readonly finalizeMutationOnce: () => Promise<{
    impactSucceeded: boolean;
    evidenceCaptured: boolean;
    provenanceRejected: boolean;
  }>;
  readonly disposeAuthoringRevision: () => Promise<void>;
  readonly captureChangesOnce: () => Promise<boolean>;
  /** Typed RST preservation failure retained when final capture returns false. */
  readonly rstCaptureFailureMessage?: string;
  readonly materializeSelectedAuthoringCandidate: () => Promise<boolean>;
  readonly sealAuthoringCandidateZero: () => Promise<void>;
  readonly captureFailedAuthoringRevision: (failureCode: string) => Promise<void>;
  readonly authoringCandidates: () => AuthoringCandidateCaptureV1["candidate"][];
  readonly emit: (event: ProgressEventInput) => void;
  readonly workflowOutcomeDecodeOptions: () => WorkflowOutcomeDecodeOptionsV1;
}

/**
 * Finalizes a run whose steps all completed. `run()` awaits it inside its
 * `try`, so a failure here, including a run-store save failure, still reaches
 * `settleThrownWorkflowRun`.
 */
export async function finalizeCompletedWorkflowRun(
  session: WorkflowRunTerminalSession,
): Promise<RunRecord> {
  const {
    options,
    timestamp,
    request,
    workflow,
    compositionExecution,
    record,
    v2,
    v3,
    finalizeMutationOnce,
    disposeAuthoringRevision,
    emit,
    workflowOutcomeDecodeOptions,
  } = session;
  record.completedAt = timestamp();
  record.durationMs = durationMs(record.startedAt, record.completedAt);
  const { impactSucceeded, evidenceCaptured, provenanceRejected } = await finalizeMutationOnce();
  assertWorkflowActive(request.signal);
  const authorizedChanges = boundedDocImprovementChangesMatch(record, request);
  // Repository-required checks must have passed on the exact proposed tree
  // before a write can succeed. Only host lint-operation evidence counts. A
  // check that could not run there does not stop the write: the run records a
  // limitation that names the command for the operator to run (#1918).
  const requiredCheckGate =
    !v3 && !session.continueIndependentEvaluate && session.selectedHasWriteStep
      ? await assessRequiredRepositoryChecks({
          runId: record.id,
          workspacePath: session.activeWorkspacePath,
          baselineInstructions: session.baselineRepositoryInstructions,
          steps: record.steps,
        })
      : undefined;
  if (requiredCheckGate?.status === "limited") {
    // Evidence warnings stay unique; the publication record decoder requires it.
    const warnings = new Set(record.evidenceWarnings ?? []);
    for (const limitation of requiredCheckGate.limitations) {
      warnings.add(formatRequiredCheckLimitation(limitation));
    }
    record.evidenceWarnings = [...warnings];
  }
  // Trusted domain admission for a write run that finalized with no changed
  // file, consulted lazily so an earlier finalize failure still wins.
  let emptyWriteRefusalCode = "empty-write-result";
  const emptyWriteResultRefused = async (): Promise<boolean> => {
    const admission = (await options.emptyWriteResultAdmission?.admit(
      deepFreezeSnapshot(structuredClone(record)),
    )) ?? { admitted: false as const, code: emptyWriteRefusalCode };
    if (admission.admitted) return false;
    emptyWriteRefusalCode = admission.code;
    return true;
  };
  if (session.selectedHasWriteStep && !evidenceCaptured) {
    record.status = "failed";
    record.error =
      session.rstCaptureFailureMessage ??
      (provenanceRejected ? provenanceRejectionError : patchPersistenceError);
    markRunFailure(
      record,
      provenanceRejected ? "evidence-provenance-rejected" : "patch-persistence-failed",
    );
  } else if (!impactSucceeded) {
    record.status = "failed";
    record.error = impactPostflightError;
    markRunFailure(record, "impact-postflight-failed");
  } else if (!authorizedChanges) {
    record.status = "failed";
    record.error = boundedDocImprovementScopeError;
    markRunFailure(record, "write-outside-authorized-scope");
    const writeStep = [...record.steps].reverse().find((step) => step.mode === "write");
    if (writeStep) {
      writeStep.status = "failed";
      writeStep.error = boundedDocImprovementScopeError;
      writeStep.failure = runFailure("write-outside-authorized-scope");
    }
  } else if (
    !session.continueIndependentEvaluate &&
    session.selectedHasWriteStep &&
    (record.changes?.files.length ?? 0) === 0 &&
    (await emptyWriteResultRefused())
  ) {
    // A write workflow that changed nothing needs trusted domain admission:
    // `evidenceCaptured` only proves a patch persisted, and a zero-byte patch
    // persists too. (Continued independent evaluation keeps its earlier
    // technical admission failure instead.)
    //
    // The failure is run-level only. Every step did succeed, and marking the
    // write step failed would break the decoder invariant that every step after
    // a failed one is `pending`. A scope violation marks its step because it is
    // attributable to that step; an empty result is not.
    record.status = "failed";
    record.error = emptyWriteResultError;
    // The port's refusal code is classified through the operator tables; with
    // no port installed the code is `empty-write-result`.
    markRunRefusal(record, emptyWriteRefusalCode);
  } else if (v2 && session.branchSelection?.branchId === "assess-no-change" && record.changes) {
    record.status = "failed";
    record.error = "A no-change assessment produced repository change evidence.";
    markRunFailure(record, "no-change-produced-changes");
  } else if (requiredCheckGate?.status === "refused") {
    record.status = "failed";
    record.error = requiredCheckGate.message;
    // The inner code carries the class: a check that ran and failed is model
    // content; missing or stale evidence is contract shape.
    markRunFailure(record, requiredCheckGate.code);
  } else if (!session.continueIndependentEvaluate) {
    record.status = "succeeded";
  }
  if (v2 && record.status === "succeeded" && session.branchSelection) {
    await finalizeEditorialEvidence({
      workflow,
      record,
      selection: session.branchSelection,
      editorialHost: session.editorialHost,
    });
  }
  assertWorkflowActive(request.signal);
  await applyWorkflowOutcome({
    outcomeProjector: options.outcomeProjector,
    record,
    expectedRepository: releaseExpectedRepository(request),
    trustedInventory: session.releaseTrustedInventory,
    decodeOptions: workflowOutcomeDecodeOptions(),
  });
  assertWorkflowActive(request.signal);
  if (
    record.status === "succeeded" &&
    record.workflow === "review-documentation" &&
    (record.reviewDeliverySnapshot !== undefined || options.reviewResultRetention !== undefined)
  ) {
    try {
      const retention = options.reviewResultRetention;
      if (!retention)
        throw new Error("Original review result retention is unavailable for this review run.");
      const before = structuredClone(record);
      const prepared = await retention.prepare(deepFreezeSnapshot(structuredClone(before)));
      assertWorkflowActive(request.signal);
      if (canonicalJson(record) !== canonicalJson(before))
        throw new Error("Original review result producer changed the admitted run record.");
      const sourceReference = structuredClone(prepared.sourceReference);
      const originalResult = structuredClone(prepared.originalResult);
      deepFreezeSnapshot(sourceReference);
      deepFreezeSnapshot(originalResult);
      record.reviewDeliverySnapshot = sourceReference;
      const resultUse = await retainOriginalReviewResult({
        run: record,
        artifacts: retention.artifacts,
        result: originalResult,
      });
      assertWorkflowActive(request.signal);
      try {
        record.workflowOutcome = resealWorkflowOutcomeAfterRetainedReviewResult({
          before,
          after: record,
          sourceReference,
          resultUse,
          options: workflowOutcomeDecodeOptions(),
        });
      } catch (error) {
        if (error instanceof ReviewResultTransitionError) throw error;
        const rejection = workflowOutcomeRejection("admission", error);
        record.status = "failed";
        record.error = workflowOutcomePersistenceError;
        record.workflowOutcomeRejection = rejection;
        record.failure = workflowOutcomeRejectionFailure(rejection);
        clearUnsuccessfulReviewResult(record);
      }
    } catch (error) {
      if (request.signal?.aborted) throw error;
      // A missing or failed original-object write cannot become terminal success.
      record.status = "failed";
      record.error = "Original review evidence could not be retained and verified.";
      clearUnsuccessfulReviewResult(record);
      markRunFailure(record, "review-result-retention-failed");
    }
  }
  assertWorkflowActive(request.signal);
  if (record.workflow === "review-documentation" && record.status === "failed")
    clearUnsuccessfulReviewResult(record);
  else if (record.workflow === "review-documentation" && record.status !== "succeeded")
    clearReviewResultReferences(record);
  if (
    record.status === "succeeded" &&
    compositionExecution &&
    record.answerRecordContinuation === undefined
  ) {
    record.compositionExecutionAggregate = createCompositionExecutionAggregate({
      compositionExecution,
      run: record,
      workflow,
    });
  }
  await options.store.save(record);
  if (record.workflow === "review-documentation" && record.status === "succeeded")
    assertWorkflowActive(request.signal);
  emit({ type: "run-status", runId: record.id, status: record.status });
  await disposeAuthoringRevision();
  return record;
}

/** Remove failed-run authority from every location, even if the source pointer was already lost. */
function clearUnsuccessfulReviewResult(record: RunRecord): void {
  delete record.workflowOutcome;
  clearReviewResultReferences(record);
}

function clearReviewResultReferences(record: RunRecord): void {
  delete record.reviewDeliverySnapshot;
  delete record.compositionExecutionAggregate;
  for (const step of record.steps) {
    if (step.artifacts)
      step.artifacts = step.artifacts.filter((use) => use.reference.kind !== "review-result");
  }
  if (record.artifacts)
    record.artifacts = record.artifacts.filter((use) => use.reference.kind !== "review-result");
}

const FINAL_EDITORIAL_EVIDENCE_INADMISSIBLE = "Final editorial evidence could not be admitted.";

/**
 * Seals the final editorial decision of a V2 run whose steps all succeeded and
 * attaches it to the evaluator step. A refusal fails the run and records its
 * closed inner reason, so the stop always names its cause.
 */
export async function finalizeEditorialEvidence(input: {
  readonly workflow: WorkflowDefinition;
  readonly record: RunRecord;
  readonly selection: WorkflowBranchSelectionEvidenceV1;
  readonly editorialHost: WorkflowBranchEvidenceHost | undefined;
}): Promise<void> {
  const { workflow, record, selection, editorialHost } = input;
  const coverageSha256 = record.workflowBranchCoverage?.coverageSha256;
  if (!coverageSha256 || !editorialHost) {
    record.status = "failed";
    record.error = "Selected workflow branch coverage is unavailable.";
    markRunFailure(record, "branch-coverage-unavailable");
    return;
  }
  try {
    record.workflowBranchCoverage = decodeWorkflowBranchCoverageV1(
      record.workflowBranchCoverage,
      workflowBranchCoverageDecodeOptionsV1({
        workflow,
        record,
        requireComplete: true,
      }),
    );
    const validatedArtifact = await editorialHost.finalize({
      workflow,
      record: structuredClone(record),
      selection,
      coverageSha256,
    });
    if (validatedArtifact.kind !== "editorial-decision" || validatedArtifact.schemaVersion !== 3) {
      throw new Error("Final editorial evidence is invalid."); // hygiene: ok
    }
    const evaluator = record.steps.at(-1)!;
    const uses = normalizeArtifactUses(
      [{ role: "output", reference: validatedArtifact }],
      evaluator.id,
      record.repository.revision,
    );
    evaluator.artifacts ??= [];
    addUniqueArtifacts(evaluator.artifacts, uses);
    record.artifacts ??= [];
    addUniqueArtifacts(record.artifacts, uses);
  } catch (error) {
    record.status = "failed";
    record.error = FINAL_EDITORIAL_EVIDENCE_INADMISSIBLE;
    markRunEditorialFinalizationRejection(record, editorialFinalizationRejectionOf(error));
  }
}

/**
 * The closed inner reason for an error terminal editorial finalization threw:
 * the refusing contract and its own code, and the decision member its rule
 * read. An error no contract coded is uncoded. Never throws: a diagnostic must
 * not be able to fail the run it describes.
 */
export function editorialFinalizationRejectionOf(error: unknown): EditorialFinalizationRejectionV1 {
  try {
    if (error instanceof WorkflowBranchCoverageError) {
      return editorialFinalizationRejection("branch-coverage", error.code);
    }
    if (error instanceof EditorialEvidenceHostError) {
      return editorialFinalizationRejection("host", error.code);
    }
    if (error instanceof EditorialDecisionValidationError) {
      return editorialFinalizationRejection("decision", error.code, error.location);
    }
  } catch {
    // A hostile `code` or `location` getter reads as uncoded.
  }
  return EDITORIAL_FINALIZATION_UNCODED;
}

/**
 * Handles anything `run()`'s `try` threw: a CREATE V3 failure is recorded and
 * saved, a cancellation is recorded, a failure after a write finalizes
 * mutation evidence first, and a failure once a step has finished returns its
 * saved failed record, so callers read the record's own failure. A recognized
 * run-store failure becomes `WorkflowRunnerBoundaryError`; anything that leaves
 * no saved terminal record rethrows.
 */
export async function settleThrownWorkflowRun(
  session: WorkflowRunTerminalSession,
  error: unknown,
): Promise<RunRecord> {
  const {
    options,
    timestamp,
    request,
    workflow,
    record,
    v3,
    authoringCaptures,
    finalizeMutationOnce,
    disposeAuthoringRevision,
    captureChangesOnce,
    materializeSelectedAuthoringCandidate,
    sealAuthoringCandidateZero,
    captureFailedAuthoringRevision,
    authoringCandidates,
    emit,
  } = session;
  const storeCode = recognizedRunStoreErrorCode(error);
  const rstErrorMessage = recognizedRstRegionErrorMessage(error);
  if (record.workflow === "review-documentation") clearUnsuccessfulReviewResult(record);
  if (v3) {
    const pendingIndex = record.steps.findIndex((step) => step.status === "pending");
    const currentIndex = pendingIndex < 0 ? record.steps.length : pendingIndex;
    const revisionPreparationFailed =
      pendingIndex >= 0 &&
      record.steps[pendingIndex]?.id === "revise-documentation" &&
      session.authoringBranchId === "revise" &&
      session.authoringRevisionSession === undefined &&
      authoringCaptures.length === 1;
    const currentRecord =
      !revisionPreparationFailed && currentIndex > 0 ? record.steps[currentIndex - 1] : undefined;
    const currentDefinition = currentRecord
      ? session.executionSteps.find((step) => step.id === currentRecord.id)
      : undefined;
    const completedStepStoreFailure =
      storeCode !== undefined &&
      currentRecord?.status === "succeeded" &&
      currentDefinition !== undefined &&
      pendingIndex >= 0;
    if (
      completedStepStoreFailure &&
      currentRecord.id === "write-documentation" &&
      !authoringCaptures[0]
    ) {
      try {
        await sealAuthoringCandidateZero();
      } catch {
        // The original authenticated store failure remains authoritative.
      }
    }
    if (currentRecord && currentDefinition && pendingIndex >= 0 && !completedStepStoreFailure) {
      currentRecord.status = "failed";
      currentRecord.failure = classifyStepFailure({
        error,
        step: currentRecord,
        cancelled: Boolean(request.signal?.aborted),
      });
      // A refusal after candidate 1 was sealed records its code too.
      const revisionRejection =
        currentRecord.id === REVISE_DOCUMENTATION_STEP_ID
          ? authoringRevisionRejectionOf(error)
          : undefined;
      if (revisionRejection) currentRecord.authoringRevisionRejection = revisionRejection;
      currentRecord.error = request.signal?.aborted
        ? WORKFLOW_CANCELLED
        : stepFailureMessage(error instanceof Error ? error.message : String(error), currentRecord);
      currentRecord.completedAt ??= timestamp();
      currentRecord.durationMs = durationMs(currentRecord.startedAt, currentRecord.completedAt);
      const phase =
        authoringPrefixPhaseForStep(workflow, currentRecord.id) ??
        (session.authoringBranchId
          ? authoringPhaseForStep(workflow, session.authoringBranchId, currentRecord.id)
          : undefined);
      if (phase && currentRecord.authoringPhase === undefined) {
        currentRecord.authoringPhase = createAuthoringPhaseEvidenceV1({
          workflow,
          branchId: authoringPrefixPhaseForStep(workflow, currentRecord.id)
            ? null
            : session.authoringBranchId,
          stepId: currentRecord.id,
          candidates: authoringCandidates(),
          outputAdmitted: false,
          summary: currentRecord.summary ?? null,
        });
      }
    }
    if (
      completedStepStoreFailure &&
      currentRecord.authoringPhase === undefined &&
      (authoringPrefixPhaseForStep(workflow, currentRecord.id) ||
        (session.authoringBranchId &&
          authoringPhaseForStep(workflow, session.authoringBranchId, currentRecord.id)))
    ) {
      currentRecord.authoringPhase = createAuthoringPhaseEvidenceV1({
        workflow,
        branchId: authoringPrefixPhaseForStep(workflow, currentRecord.id)
          ? null
          : session.authoringBranchId,
        stepId: currentRecord.id,
        candidates: authoringCandidates(),
        outputAdmitted: true,
        summary: currentRecord.summary ?? null,
      });
    }
    if (session.authoringBranchId === "revise" && !authoringCaptures[1]) {
      await captureFailedAuthoringRevision(
        request.signal?.aborted ? "cancelled" : "revision-path-failed",
      );
    }
    const materialized =
      record.changes !== undefined && record.authoringExecution?.finalPatch
        ? true
        : await materializeSelectedAuthoringCandidate();
    // A refusal of the admitted candidate-zero evidence records its inner code
    // and location instead of the bare error code.
    markRunAuthoringCandidateRejection(record, authoringCandidateRejectionOf(error), {
      cancelled: Boolean(request.signal?.aborted),
      storeCode,
    });
    markRunThrownFailure(record, error, {
      cancelled: Boolean(request.signal?.aborted),
      storeCode,
    });
    record.status = "failed";
    const message = error instanceof Error ? error.message : String(error);
    record.error = storeCode
      ? "Workflow execution could not be completed."
      : request.signal?.aborted
        ? WORKFLOW_CANCELLED
        : currentRecord
          ? stepFailureMessage(message, currentRecord)
          : message;
    record.completedAt = timestamp();
    record.durationMs = durationMs(record.startedAt, record.completedAt);
    markContextUnnecessary(record, Math.max(0, currentIndex), "workflow-stopped-before-step");
    if (
      session.selectedHasWriteStep &&
      !materialized &&
      session.authoringSelectedOrdinal !== null
    ) {
      record.error = rstErrorMessage ?? session.rstCaptureFailureMessage ?? patchPersistenceError;
    }
    let retainedStoreCode = storeCode;
    try {
      await options.store.save(record);
    } catch (saveError) {
      retainedStoreCode ??= recognizedRunStoreErrorCode(saveError);
    }
    emit({ type: "run-status", runId: record.id, status: record.status });
    await disposeAuthoringRevision();
    if (retainedStoreCode) {
      throw new WorkflowRunnerBoundaryError(`run-store-${retainedStoreCode}`, record.error); // hygiene: ok -- closed machine code; the retained failure message remains unchanged.
    }
    return record;
  }
  if (request.signal?.aborted) {
    const evidenceCaptured = await captureChangesOnce();
    record.status = "failed";
    record.error = evidenceCaptured
      ? WORKFLOW_CANCELLED
      : (session.rstCaptureFailureMessage ?? patchPersistenceError);
    markRunFailure(record, "workflow-cancelled");
    record.completedAt = timestamp();
    record.durationMs = durationMs(record.startedAt, record.completedAt);
    markContextUnnecessary(record, 0, "workflow-stopped-before-step");
    await options.store.save(record);
    emit({ type: "run-status", runId: record.id, status: record.status });
    await disposeAuthoringRevision();
    return record;
  }
  if (!session.selectedHasWriteStep || !session.writeExecutionStarted) {
    // Once a step has finished, the stored record must not stay `running`:
    // record the stop and its classified cause, and return the saved record.
    // A run that stopped before any step finished, or inside one, keeps the
    // bare rethrow and its record is not rewritten.
    let settled: SettledSave | undefined;
    if (
      record.steps.some((step) => step.status !== "pending") &&
      !record.steps.some((step) => step.status === "running")
    ) {
      record.status = "failed";
      record.error = "Workflow execution could not be completed.";
      // A product outcome is never admitted for a failed run.
      delete record.workflowOutcome;
      delete record.reviewDeliverySnapshot;
      for (const step of record.steps) {
        if (step.artifacts)
          step.artifacts = step.artifacts.filter((use) => use.reference.kind !== "review-result");
      }
      if (record.artifacts)
        record.artifacts = record.artifacts.filter((use) => use.reference.kind !== "review-result");
      markRunThrownFailure(record, error, { cancelled: false, storeCode });
      record.completedAt = timestamp();
      record.durationMs = durationMs(record.startedAt, record.completedAt);
      markContextUnnecessary(record, 0, "workflow-stopped-before-step");
      settled = await saveSettledRecord(options.store, record);
      emit({ type: "run-status", runId: record.id, status: record.status });
    }
    await disposeAuthoringRevision();
    const retainedStoreCode = storeCode ?? settled?.storeCode;
    if (retainedStoreCode) {
      throw new WorkflowRunnerBoundaryError(`run-store-${retainedStoreCode}`); // hygiene: ok -- closed machine code; the constructor supplies the operator message.
    }
    if (settled?.saved) return record;
    if (settled) {
      throw new Error("Workflow execution could not be completed.", { cause: error }); // hygiene: ok -- preserve the existing operator message while retaining the sealed refusal as a cause.
    }
    throw new Error("Workflow execution could not be completed.");
  }

  const { evidenceCaptured, provenanceRejected } = await finalizeMutationOnce();
  record.status = "failed";
  markRunThrownFailure(record, error, { cancelled: false, storeCode });
  record.completedAt = timestamp();
  record.durationMs = durationMs(record.startedAt, record.completedAt);
  record.error =
    rstErrorMessage ??
    (session.rstCaptureFailureMessage
      ? session.rstCaptureFailureMessage
      : evidenceCaptured
        ? "Workflow execution could not be finalized after repository changes were preserved."
        : provenanceRejected
          ? provenanceRejectionError
          : patchPersistenceError);
  markContextUnnecessary(record, 0, "workflow-stopped-before-step");
  const settled = await saveSettledRecord(options.store, record);
  await disposeAuthoringRevision();
  const retainedStoreCode = storeCode ?? settled.storeCode;
  if (retainedStoreCode) {
    throw new WorkflowRunnerBoundaryError(`run-store-${retainedStoreCode}`, record.error); // hygiene: ok -- closed machine code; the retained finalization message remains unchanged.
  }
  if (settled.saved) return record;
  throw new Error(record.error);
}

interface SettledSave {
  readonly saved: boolean;
  /** A recognized run-store code from a save that failed. */
  readonly storeCode?: FileRunStoreErrorCode;
}

/**
 * Saves a settled failed record. Only a record that reached the store may be
 * returned to the caller; an unsaved one is never reported as the run's
 * terminal record.
 */
async function saveSettledRecord(store: RunStore, record: RunRecord): Promise<SettledSave> {
  try {
    await store.save(record);
    return { saved: true };
  } catch (saveError) {
    const storeCode = recognizedRunStoreErrorCode(saveError);
    return storeCode ? { saved: false, storeCode } : { saved: false };
  }
}
