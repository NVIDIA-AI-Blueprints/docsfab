// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Assemble one immutable admitted input; retry attempts add only attempt-scoped capabilities. */

import { canonicalDigest } from "../../content-ir/canonical.js";
import type { HarnessStepInput, RunRequest } from "../../execution/contracts.js";
import type { RunRecord, StepRunRecord } from "../../records/contracts.js";
import type {
  WorkflowBranchSelectionEvidenceV1,
  WorkflowDefinition,
  WorkflowStep,
} from "../../workflow-contracts/contracts.js";
import type { AuthoringPhaseInvocationBindingV1 } from "../../records/authoring-execution.js";
import type { AuthoringRevisionSessionV1 } from "../authoring-runtime.js";
import type { PreparedRstAuthoring } from "../../rst-authoring/workflow.js";
import type { WorkflowRunnerOptions } from "../runner-ports.js";
import type { SourceObligationSourceObserver } from "../source-obligation.js";
import type {
  OriginalSourceAuthorityCapture,
  OriginalSourceAuthorityEvidenceV1,
} from "../source-obligation-authority.js";
import { issueOriginalSourceAuthorityAdmission } from "../source-obligation-authority.js";
import {
  requiresTechnicalCorrection,
  fixedProvisionalRichCandidateContract,
  shouldDeliverPreservationBaseEvidence,
} from "../source-obligation.js";
import { sealedEvidenceBindings } from "../search-participation.js";
import { documentationPlanModeForWorkflow } from "../plan-binding.js";
import { plannedTargetExistence } from "./plan-admission.js";
import type { preflightContext } from "../runner-evidence.js";

export interface StepHarnessInputPort {
  readonly request: RunRequest;
  readonly record: RunRecord;
  readonly options: WorkflowRunnerOptions;
  readonly workflow: WorkflowDefinition;
  readonly step: WorkflowStep;
  readonly executionStep: WorkflowStep;
  readonly stepRecord: StepRunRecord;
  readonly workspacePath: string;
  readonly authoringRevisionSession?: AuthoringRevisionSessionV1;
  readonly context: Awaited<ReturnType<typeof preflightContext>>;
  readonly branchSelection?: WorkflowBranchSelectionEvidenceV1;
  readonly v2: boolean;
  readonly v3: boolean;
  readonly rstWriterToolCeiling?: HarnessStepInput["toolCeiling"];
  readonly stepEvidenceText?: string;
  readonly searchEvidence?: HarnessStepInput["searchEvidence"];
  readonly technicalVerificationSha256?: string;
  readonly provisionalRichCandidateEvidence?: HarnessStepInput["provisionalRichCandidateEvidence"];
  readonly authoringPhase?: AuthoringPhaseInvocationBindingV1;
  readonly stepEditorialEvidenceRefs?: HarnessStepInput["editorialEvidenceRefs"];
  readonly stepAnswerPath?: HarnessStepInput["answerSubmission"];
  readonly answerRecordsExecutionEnabled: boolean;
  readonly technicalVerification?: HarnessStepInput["technicalVerification"];
  readonly planBinding?: HarnessStepInput["planBinding"];
  readonly rstPrepared?: PreparedRstAuthoring;
  readonly plannerWriteGuidance?: HarnessStepInput["planWriteGuidance"];
  readonly stepTemplateGuidance?: HarnessStepInput["pageTemplateGuidance"];
  readonly preservationBaseEvidence?: HarnessStepInput["preservationBaseEvidence"];
  readonly stepPreservationSourceReader?: HarnessStepInput["preservationSourceReader"];
  readonly preservationSourceObservationCache?: HarnessStepInput["preservationSourceObservationCache"];
  readonly preservationSourceObservationEvidence?: HarnessStepInput["preservationSourceObservationEvidence"];
  readonly needsSourceObligationLedger: boolean;
  readonly sourceObligationLedger?: HarnessStepInput["sourceObligationLedger"];
  readonly admittedSourceLineCounts?: HarnessStepInput["admittedSourceLineCounts"];
  readonly verificationTargetPaths?: HarnessStepInput["verificationTargetPaths"];
  readonly originalSourceAuthorityCapture?: OriginalSourceAuthorityCapture;
  readonly originalSourceAuthorityEvidence?: OriginalSourceAuthorityEvidenceV1;
  readonly activeSourceObserver?: SourceObligationSourceObserver;
  readonly authoringRevisionInput?: HarnessStepInput["authoringRevisionInput"];
  readonly stepSourceReader?: HarnessStepInput["sourceReader"];
  readonly stepSourceSearcher?: HarnessStepInput["sourceSearcher"];
  readonly stepSourceCiter?: HarnessStepInput["sourceCiter"];
  readonly stepTrackedRepositoryPaths?: HarnessStepInput["trackedRepositoryPaths"];
  readonly admittedSourceProposalPaths: (
    stepRecord: StepRunRecord,
    authority: OriginalSourceAuthorityEvidenceV1,
  ) => string[];
}

export function assembleStepHarnessInput(input: StepHarnessInputPort): HarnessStepInput & {
  evidenceIdentity: NonNullable<HarnessStepInput["evidenceIdentity"]>;
} {
  const {
    request,
    record,
    options,
    workflow,
    step,
    executionStep,
    stepRecord,
    workspacePath,
    authoringRevisionSession,
    context,
    branchSelection,
    v2,
    v3,
    rstWriterToolCeiling,
    stepEvidenceText,
    searchEvidence,
    technicalVerificationSha256,
    provisionalRichCandidateEvidence,
    authoringPhase,
    stepEditorialEvidenceRefs,
    stepAnswerPath,
    answerRecordsExecutionEnabled,
    technicalVerification,
    planBinding,
    rstPrepared,
    plannerWriteGuidance,
    stepTemplateGuidance,
    preservationBaseEvidence,
    stepPreservationSourceReader,
    preservationSourceObservationCache,
    preservationSourceObservationEvidence,
    needsSourceObligationLedger,
    sourceObligationLedger,
    admittedSourceLineCounts,
    verificationTargetPaths,
    originalSourceAuthorityCapture,
    originalSourceAuthorityEvidence,
    activeSourceObserver,
    authoringRevisionInput,
    stepSourceReader,
    stepSourceSearcher,
    stepSourceCiter,
    stepTrackedRepositoryPaths,
    admittedSourceProposalPaths,
  } = input;
  return {
    signal: request.signal,
    runId: record.id,
    ...(rstWriterToolCeiling
      ? { toolCeiling: rstWriterToolCeiling }
      : options.toolCeiling
        ? { toolCeiling: options.toolCeiling }
        : {}),
    repositoryPath: workspacePath,
    ...(authoringRevisionSession
      ? { repositoryWorkspace: authoringRevisionSession.repositoryWorkspace }
      : {}),
    workflow,
    // Every attempt carries the sources the host read, so their bytes stay
    // charged to each attempt's read budget.
    step:
      stepEvidenceText || provisionalRichCandidateEvidence
        ? {
            ...executionStep,
            prompt: [
              executionStep.prompt,
              ...(stepEvidenceText ? ["", stepEvidenceText] : []),
              ...(provisionalRichCandidateEvidence
                ? ["", fixedProvisionalRichCandidateContract(provisionalRichCandidateEvidence)]
                : []),
            ].join("\n"),
          }
        : executionStep,
    evidenceIdentity: {
      repositoryRevision: record.repository.revision,
      ...(context.evidence.packetDigest
        ? { contextPacketDigest: context.evidence.packetDigest }
        : {}),
      ...(context.evidence.consultedNodeIds
        ? { consultedNodeIds: [...context.evidence.consultedNodeIds] }
        : {}),
      // Binds the lease identity to the exact inventory the step saw; a reused
      // observation is otherwise outside evidenceSha256 and identitySha256.
      ...(searchEvidence ? { searchEvidenceSha256: searchEvidence.evidenceSha256 } : {}),
      ...(technicalVerificationSha256 ? { technicalVerificationSha256 } : {}),
      ...(provisionalRichCandidateEvidence
        ? { provisionalRichCandidateSha256: provisionalRichCandidateEvidence.digest }
        : {}),
      ...(authoringPhase ? { authoringPhaseSha256: canonicalDigest(authoringPhase) } : {}),
    },
    ...(request.task ? { task: request.task } : {}),
    ...(context.packet ? { contextPacket: context.packet } : {}),
    ...(request.contextTarget ? { contextTarget: request.contextTarget } : {}),
    ...(v2 && request.readerContextInput ? { readerContextInput: request.readerContextInput } : {}),
    ...(v2 && (branchSelection?.readerTaskContext ?? request.readerTaskContext)
      ? {
          readerTaskContext: branchSelection?.readerTaskContext ?? request.readerTaskContext!,
        }
      : {}),
    ...(v2 && (branchSelection?.readerContext ?? request.readerContext)
      ? { readerContext: branchSelection?.readerContext ?? request.readerContext! }
      : {}),
    ...(v2 && (branchSelection?.readerContextProvenance ?? request.readerContextProvenance)
      ? {
          readerContextProvenance:
            branchSelection?.readerContextProvenance ?? request.readerContextProvenance!,
        }
      : {}),
    ...(v2 && stepEditorialEvidenceRefs
      ? { editorialEvidenceRefs: stepEditorialEvidenceRefs }
      : {}),
    ...(v2 && branchSelection ? { editorialCandidate: branchSelection.editorialCandidate } : {}),
    ...(searchEvidence ? { searchEvidence } : {}),
    ...(sealedEvidenceBindings(step, record)
      ? { sealedEvidence: sealedEvidenceBindings(step, record) }
      : {}),
    ...(options.qualityValidation
      ? {
          qualityProfileSelection: options.qualityValidation.selection.receipt,
          qualityEvaluationTarget: options.qualityValidation.selection.evaluationTarget,
        }
      : {}),
    ...(stepAnswerPath ? { answerSubmission: stepAnswerPath } : {}),
    ...(answerRecordsExecutionEnabled ? { qualityAnswerRecords: undefined } : {}),
    ...(technicalVerification ? { technicalVerification } : {}),
    ...(planBinding ? { planBinding } : {}),
    ...(rstPrepared ? { rstAuthoring: rstPrepared.input } : {}),
    ...(plannerWriteGuidance ? { planWriteGuidance: plannerWriteGuidance } : {}),
    ...(stepTemplateGuidance ? { pageTemplateGuidance: stepTemplateGuidance } : {}),
    ...(preservationBaseEvidence &&
    shouldDeliverPreservationBaseEvidence({
      deliveryMode: options.preservationBaseDelivery,
      workflowName: workflow.name,
      stepId: step.id,
    })
      ? { preservationBaseEvidence: preservationBaseEvidence }
      : {}),
    ...(stepPreservationSourceReader
      ? { preservationSourceReader: stepPreservationSourceReader }
      : {}),
    ...(stepPreservationSourceReader && preservationSourceObservationCache
      ? { preservationSourceObservationCache: preservationSourceObservationCache }
      : {}),
    ...(preservationSourceObservationEvidence ? { preservationSourceObservationEvidence } : {}),
    ...(needsSourceObligationLedger && sourceObligationLedger
      ? { sourceObligationLedger: sourceObligationLedger }
      : {}),
    ...(provisionalRichCandidateEvidence ? { provisionalRichCandidateEvidence } : {}),
    ...(admittedSourceLineCounts ? { admittedSourceLineCounts } : {}),
    ...(verificationTargetPaths ? { verificationTargetPaths } : {}),
    ...(requiresTechnicalCorrection({ workflow, step }) &&
    sourceObligationLedger?.schemaVersion === 2 &&
    originalSourceAuthorityCapture &&
    activeSourceObserver
      ? {
          originalSourceAuthorityAdmission: issueOriginalSourceAuthorityAdmission({
            capture: originalSourceAuthorityCapture,
            observer: activeSourceObserver,
            runId: record.id,
            repositoryRevision: record.repository.revision,
            scopeSha256: sourceObligationLedger.identity.scopeSha256,
            workspaceSnapshotSha256: sourceObligationLedger.identity.workspaceSnapshotSha256,
          }),
        }
      : {}),
    ...(step.id === "revise-documentation" && authoringRevisionInput
      ? { authoringRevisionInput }
      : {}),
    ...(request.instruction ? { instruction: request.instruction } : {}),
    ...(request.instructionContext ? { instructionContext: request.instructionContext } : {}),
    // Planner pages win over lexical reviewScope so using/exclude cannot
    // silently retarget a bound create/update/review job.
    ...(request.reviewScope && !planBinding ? { reviewScope: request.reviewScope } : {}),
    ...(request.sourceBinding ? { sourceBinding: request.sourceBinding } : {}),
    ...(stepSourceReader ? { sourceReader: stepSourceReader } : {}),
    ...(stepSourceSearcher ? { sourceSearcher: stepSourceSearcher } : {}),
    ...(stepSourceCiter ? { sourceCiter: stepSourceCiter } : {}),
    ...(stepTrackedRepositoryPaths ? { trackedRepositoryPaths: stepTrackedRepositoryPaths } : {}),
    ...(step.id === "derive-source-obligations" &&
    originalSourceAuthorityEvidence &&
    stepRecord.sourceProposalAdmissions?.some((receipt) => receipt.status === "admitted")
      ? {
          admittedSourceAuthorityPaths: admittedSourceProposalPaths(
            stepRecord,
            originalSourceAuthorityEvidence,
          ),
        }
      : {}),
    // The CREATE planner's reply admission asks which planned pages exist, so a
    // plan proposed as an UPDATE is admitted only when every page does.
    ...(v3 &&
    step.skill === "plan-documentation" &&
    documentationPlanModeForWorkflow(workflow.name) === "create" &&
    options.authoringCandidateLifecycle
      ? {
          planTargetExistence: plannedTargetExistence(options.authoringCandidateLifecycle),
        }
      : {}),
  };
}
