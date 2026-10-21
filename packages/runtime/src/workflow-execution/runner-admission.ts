// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Run-request admission for `WorkflowRunner.run`. `admitWorkflowRunRequest`
 * runs synchronously before the runner's first await and before any source
 * body, model call, or saved record. `createQueuedRunRecord` builds the queued
 * `RunRecord` after the runner takes its baseline repository-instruction
 * snapshot.
 */

import { createHash } from "node:crypto";

import type { RunRequest } from "../execution/contracts.js";
import type { RunRecord } from "../records/contracts.js";
import {
  isWorkflowManifestV2,
  isWorkflowManifestV3,
  type WorkflowDefinition,
} from "../workflow-contracts/contracts.js";
import { admitRunSourceBinding, type SourceRunCapabilityV1 } from "../inputs/source-resolver.js";
import { projectSourceRequestContext } from "../inputs/source-evidence.js";
import { assertPrReviewCitationAdmission } from "./pr-review-citation-admission.js";
import { stepAdmitsSourceRead } from "../inputs/source-step-policy.js";
import { getWorkflow } from "../workflow-registry/catalog.js";
import { validateTaskInput } from "./runner-schedule.js";
import { emptyTools, emptyUsage } from "./runner-step.js";
import { decodeTaskLineageRecoveryAuthorization } from "../lineage/contracts.js";
import { captureRunTaskLineage } from "../lineage/run-capture.js";
import {
  decodeKnowledgeContinuationReceipt,
  knowledgeContinuationAcceptanceSha256,
  matchesKnowledgeContinuationTargetConflictScope,
} from "../records/knowledge-continuation.js";
import { assertCompositionExecutionRequestBinding } from "../records/composition-execution.js";
import { assertAnswerRecordDiscoveryRunBindingV1 } from "../records/answer-record-discovery.js";
import { decodeKnowledgeResumeReceipt } from "../canon/from-knowledge-snapshot.js";
import { assertSourceObligationPhaseContract } from "./source-obligation.js";
import { validateFirstPassTargetControl } from "./runner-ports.js";
import { findConfiguredCredentialInValue } from "../security/configured-credentials.js";
import { CredentialBoundaryError } from "../security/credential-isolation.js";
import { assertCanonicalRstCapability } from "./rst-capability-admission.js";
import type { WorkflowRunnerOptions, FirstPassDocumentationTargetControl } from "./runner-ports.js";

/**
 * `options` is the runner's store-classifying copy, not the caller's raw
 * options. `id` and `timestamp` are thunks: the id generator runs only when
 * the request has no `runId`, and `createdAt` only when the record is built.
 */
export interface WorkflowRunAdmissionRunner {
  readonly options: WorkflowRunnerOptions;
  readonly id: () => string;
  readonly timestamp: () => string;
}

/**
 * Refuse a request whose recorded text holds one of DocsFab's own configured
 * credentials, before the first save (#1807). The queued record copies these
 * fields verbatim and later steps put them in prompts, so a screen at either
 * place would already have left the value in a saved record. Text that only
 * looks like a credential is a finding, never a refusal.
 */
function assertRecordedRequestCredentialFree(
  request: RunRequest,
  operatorTargetPaths: readonly string[] | undefined,
): void {
  const match = findConfiguredCredentialInValue({
    repository: request.repository,
    instruction: request.instruction,
    operatorTargetPaths,
    instructionContext: request.instructionContext,
    retryContext: request.retryContext,
    readerEvidenceRequest: request.readerEvidenceRequest,
    task: request.task,
    reviewScope: request.reviewScope,
  });
  if (match) {
    throw new CredentialBoundaryError("model-request", match); // hygiene: ok -- constructor renders the stable content-free boundary message
  }
}

/** Validates and binds one run request before anything is saved. */
export function admitWorkflowRunRequest(
  runner: WorkflowRunAdmissionRunner,
  request: RunRequest,
  firstPassTargetControl?: FirstPassDocumentationTargetControl,
) {
  assertRecordedRequestCredentialFree(request, runner.options.operatorTargetPaths);
  validateTaskInput(request);
  assertCanonicalRstCapability(runner.options, request);
  const validatedFirstPassTargetControl = validateFirstPassTargetControl(
    firstPassTargetControl,
    request,
  );
  const workflow = getWorkflow(request.workflow);
  const sourceObligationPhases = assertSourceObligationPhaseContract(workflow);
  if (sourceObligationPhases && !runner.options.sourceObligationObserver) {
    throw new Error("Source-obligation workflow phases require the exact-byte source observer.");
  }
  const knowledgeResumeReceipt = request.knowledgeResumeReceipt
    ? decodeKnowledgeResumeReceipt(request.knowledgeResumeReceipt)
    : undefined;
  const knowledgeContinuationReceipt = request.knowledgeContinuationReceipt
    ? decodeKnowledgeContinuationReceipt(request.knowledgeContinuationReceipt)
    : undefined;
  if (
    knowledgeResumeReceipt &&
    workflow.name !== "create-documentation" &&
    workflow.name !== "update-documentation"
  ) {
    throw new Error("A knowledge resume receipt requires a documentation create or update run.");
  }
  if (
    knowledgeContinuationReceipt &&
    (knowledgeContinuationReceipt.workflow !== workflow.name ||
      knowledgeContinuationReceipt.repositoryRevision !== request.repository.revision)
  ) {
    throw new Error("A durable knowledge continuation receipt does not match this run.");
  }
  if (knowledgeContinuationReceipt) {
    if (
      !request.taskLineage ||
      !request.knowledgeContinuationRecoveryAuthorization ||
      !request.knowledgeContinuationSnapshotSha256 ||
      !request.knowledgeContinuationAcceptanceSha256
    )
      throw new Error("A durable knowledge continuation is missing authenticated bindings.");
    const projection = captureRunTaskLineage(
      { workflow: request.workflow, repository: request.repository },
      request.taskLineage,
    );
    const recovery = decodeTaskLineageRecoveryAuthorization(
      request.knowledgeContinuationRecoveryAuthorization,
    );
    const targetConflictReceiptSha256 = knowledgeContinuationReceipt.targetConflictReceiptSha256;
    if (
      createHash("sha256").update(request.repository.sourcePath).digest("hex") !==
        knowledgeContinuationReceipt.repositoryIdentitySha256 ||
      projection.projectionSha256 !== knowledgeContinuationReceipt.taskLineageProjectionSha256 ||
      projection.originSha256 !== recovery.originalOriginSha256 ||
      projection.lineageSha256 !== recovery.originalLineageSha256 ||
      createHash("sha256")
        .update((request.instruction ?? "").normalize("NFC"), "utf8")
        .digest("hex") !== knowledgeContinuationReceipt.instructionSha256 ||
      !matchesKnowledgeContinuationTargetConflictScope(
        knowledgeContinuationReceipt.targetConflictReceipt,
        knowledgeResumeReceipt,
        request.knowledgeContinuationSnapshotSha256,
      ) ||
      request.knowledgeContinuationAcceptanceSha256 !==
        knowledgeContinuationAcceptanceSha256({
          receiptSha256: knowledgeContinuationReceipt.receiptSha256,
          recoveryAuthorizationSha256: recovery.authorizationSha256,
          snapshotSha256: request.knowledgeContinuationSnapshotSha256,
          targetConflictReceiptSha256,
        })
    )
      throw new Error("A durable knowledge continuation binding was substituted during execution.");
  }
  const runId = request.runId ?? runner.id();
  const compositionExecution = request.compositionExecution
    ? assertCompositionExecutionRequestBinding(request.compositionExecution, {
        runId,
        workflow,
        repository: request.repository,
      })
    : undefined;
  const answerRecordDiscovery = request.answerRecordDiscovery
    ? assertAnswerRecordDiscoveryRunBindingV1(request.answerRecordDiscovery, {
        runId,
        workflow: workflow.name,
        repositoryRevision: request.repository.revision,
        repositorySourcePath: request.repository.sourcePath,
      })
    : undefined;
  if (
    answerRecordDiscovery &&
    (workflow.name !== "review-documentation" || compositionExecution !== undefined)
  ) {
    throw new Error(
      "Experimental answer-record discovery requires review-documentation without qualified composition evidence.",
    );
  }
  // Source admission happens before any source body or model call. A
  // reference without a live service fails closed; a service without a
  // reference stays inert, so no-source runs are unchanged.
  const sourceEvidence = runner.options.sourceEvidence;
  const sourceRepository = {
    identitySha256: createHash("sha256").update(request.repository.sourcePath).digest("hex"),
    revision: request.repository.revision,
  };
  const sourceCapability: SourceRunCapabilityV1 | undefined = request.sourceBinding
    ? admitRunSourceBinding({
        reference: request.sourceBinding,
        service: sourceEvidence?.service,
        context: {
          runId,
          requestSha256: sourceEvidence
            ? projectSourceRequestContext(request as unknown as Record<string, unknown>, {
                runId,
                workspaceIdentitySha256: sourceEvidence.workspaceIdentitySha256,
                repository: sourceRepository,
              })
            : "",
          repository: sourceRepository,
          workspaceIdentitySha256: sourceEvidence?.workspaceIdentitySha256 ?? "",
          repositoryContentDigest: sourceEvidence?.repositoryContentDigest ?? "",
        },
      })
    : undefined;

  if (request.prReviewBasis || runner.options.prReviewCitationAdmission) {
    if (!request.prReviewBasis || !request.sourceBinding || !sourceEvidence || !sourceCapability) {
      throw new Error("PR review requires one live source binding and citation admission.");
    }
    assertPrReviewCitationAdmission({
      admission: runner.options.prReviewCitationAdmission,
      workflow,
      runId,
      requestSha256: projectSourceRequestContext(request as unknown as Record<string, unknown>, {
        runId,
        workspaceIdentitySha256: sourceEvidence.workspaceIdentitySha256,
        repository: sourceRepository,
      }),
      basisBinding: request.prReviewBasis,
      sourceBindingSha256: request.sourceBinding.digest,
      sourceEvidence,
    });
  }

  const v2 = isWorkflowManifestV2(workflow);
  const v3 = isWorkflowManifestV3(workflow);
  if (v3 && !runner.options.authoringCandidateLifecycle) {
    throw new Error("CREATE V3 requires the authenticated local authoring candidate lifecycle.");
  }
  // Preflight the source-read grant: in a source-aware run, a write step whose
  // locked skill is not in the sealed policy cannot satisfy the required-source
  // write gate, so refuse before opening sources or calling the model, naming
  // the missing skill.
  if (sourceCapability && sourceEvidence) {
    const scheduled = v2
      ? [
          ...workflow.branching.prefix.steps,
          ...workflow.branching.branches.flatMap((branch) => branch.steps),
        ]
      : v3
        ? [
            ...workflow.authoringSchedule.prefix.steps,
            ...workflow.authoringSchedule.branches.flatMap((branch) => branch.steps),
          ]
        : workflow.steps;
    const ungranted = [
      ...new Set(
        scheduled
          .filter(
            (step) => step.mode === "write" && !stepAdmitsSourceRead(sourceEvidence.policy, step),
          )
          .map((step) => step.skill),
      ),
    ].sort();
    if (ungranted.length > 0) {
      throw new Error(
        `Workflow "${workflow.name}" cannot run with bound sources because its locked write skills have no source-read grant (${ungranted.join(", ")}). ` +
          "Reinstall the locked skill set that grants the source reader to those skills, or run without --source.",
      );
    }
  }
  const selectedHasWriteStep = workflowWriteGrantedAtAdmission(workflow);
  if (selectedHasWriteStep && !request.allowWrite) {
    throw new Error(
      `Workflow "${workflow.name}" can modify files. Re-run with --allow-write after reviewing the plan.`,
    );
  }
  return {
    validatedFirstPassTargetControl,
    workflow,
    sourceObligationPhases,
    knowledgeResumeReceipt,
    knowledgeContinuationReceipt,
    runId,
    compositionExecution,
    answerRecordDiscovery,
    sourceEvidence,
    sourceCapability,
    selectedHasWriteStep,
  };
}

export type WorkflowRunAdmission = ReturnType<typeof admitWorkflowRunRequest>;

/**
 * Whether admission itself refuses this workflow without `--allow-write`. A
 * branching (V2) manifest stops at its write step instead, after its
 * read-only steps ran.
 */
export function workflowWriteGrantedAtAdmission(workflow: WorkflowDefinition): boolean {
  return !isWorkflowManifestV2(workflow) && workflow.steps.some((step) => step.mode === "write");
}

/**
 * Builds the queued `RunRecord` for an admitted request. The caller takes the
 * baseline repository-instruction snapshot first, so `createdAt` is read after
 * that await.
 */
export function createQueuedRunRecord(
  runner: WorkflowRunAdmissionRunner,
  request: RunRequest,
  admission: WorkflowRunAdmission,
): RunRecord {
  const {
    workflow,
    runId,
    compositionExecution,
    answerRecordDiscovery,
    knowledgeResumeReceipt,
    knowledgeContinuationReceipt,
  } = admission;
  const v2 = isWorkflowManifestV2(workflow);
  const v3 = isWorkflowManifestV3(workflow);
  const createdAt = runner.timestamp();
  const record: RunRecord = {
    schemaVersion: 2,
    id: runId,
    workflow: workflow.name,
    repository: request.repository,
    workspace: {
      strategy: "tracked-export",
      disposable: true,
    },
    ...(request.instruction ? { instruction: request.instruction } : {}),
    ...(request.retryContext ? { retryContext: request.retryContext } : {}),
    ...(runner.options.operatorTargetPaths?.length
      ? { operatorTargetPaths: [...runner.options.operatorTargetPaths] }
      : {}),
    ...(request.instructionContext ? { instructionContext: request.instructionContext } : {}),
    // From the queued save, so every stop, including an editorial InputAsk,
    // keeps what a continuation must re-admit.
    ...(request.readerEvidenceRequest
      ? { readerEvidenceRequest: structuredClone(request.readerEvidenceRequest) }
      : {}),
    // From the queued save, so an InputAsk stop keeps the pins its
    // continuation binds again.
    ...(runner.options.retainedEvidenceBindings
      ? { retainedEvidenceBindings: structuredClone(runner.options.retainedEvidenceBindings) }
      : {}),
    ...(request.task ? { task: structuredClone(request.task) } : {}),
    // Recorded from the queued save, so a focused run is identifiable as
    // focused even if it never reaches a terminal state.
    ...(request.reviewScope ? { reviewScope: structuredClone(request.reviewScope) } : {}),
    ...(request.prReviewBasis ? { prReviewBasis: structuredClone(request.prReviewBasis) } : {}),
    // From the queued save, so every stop shows how the request was read.
    ...(request.requestIntent ? { requestIntent: structuredClone(request.requestIntent) } : {}),
    ...(request.firstPassChoices?.length
      ? { firstPassChoices: structuredClone(request.firstPassChoices) }
      : {}),
    // From the queued save, so every runner stop cites the change it bound.
    ...(runner.options.changeSources
      ? { changeSources: structuredClone(runner.options.changeSources) }
      : {}),
    ...(runner.options.changeSourceRelease
      ? { changeSourceRelease: structuredClone(runner.options.changeSourceRelease) }
      : {}),
    ...(compositionExecution ? { compositionExecution } : {}),
    ...(answerRecordDiscovery ? { answerRecordDiscovery } : {}),
    // From the queued save, so every stop shows the settings the run bound.
    ...(request.modelSettings ? { modelSettings: structuredClone(request.modelSettings) } : {}),
    ...(knowledgeResumeReceipt ? { knowledgeResumeReceipt } : {}),
    ...(knowledgeContinuationReceipt ? { knowledgeContinuationReceipt } : {}),
    ...(request.answerRecordContinuationReceipt
      ? { answerRecordContinuation: structuredClone(request.answerRecordContinuationReceipt) }
      : {}),
    ...(request.knowledgeContinuationRecoveryAuthorization
      ? {
          knowledgeContinuationRecoveryAuthorization:
            request.knowledgeContinuationRecoveryAuthorization,
        }
      : {}),
    ...(request.knowledgeContinuationSnapshotSha256
      ? { knowledgeContinuationSnapshotSha256: request.knowledgeContinuationSnapshotSha256 }
      : {}),
    ...(request.knowledgeContinuationAcceptanceSha256
      ? {
          knowledgeContinuationAcceptanceSha256: request.knowledgeContinuationAcceptanceSha256,
        }
      : {}),
    status: "queued",
    createdAt,
    models: [],
    skills: [],
    ...(runner.options.qualityPackEvidence
      ? { qualityPack: structuredClone(runner.options.qualityPackEvidence) }
      : {}),
    ...(runner.options.qualityValidation
      ? {
          qualityProfileSelection: structuredClone(
            runner.options.qualityValidation.selection.receipt,
          ),
          evidenceWarnings: [
            ...(runner.options.qualityValidation.selection.discoveryLimitations ?? []),
          ],
        }
      : {}),
    usage: emptyUsage(),
    tools: emptyTools(),
    steps: (v2
      ? workflow.branching.prefix.steps
      : v3
        ? workflow.authoringSchedule.prefix.steps
        : workflow.steps
    ).map((step) => ({
      id: step.id,
      title: step.title,
      kind: step.kind ?? "inference",
      ...(step.operation ? { operation: step.operation } : {}),
      skill: step.skill,
      mode: step.mode,
      status: "pending",
    })),
  };
  return record;
}
