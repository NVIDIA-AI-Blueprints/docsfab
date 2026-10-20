// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { DurableArtifactStore, opaqueRecordDigest } from "../../artifacts/store.js";
import { canonicalDigest } from "../../contract-kit/index.js";
import type { DocsFabConfig } from "../../config/runtime-loader.js";
import { isRetainableInferenceRejection } from "../../config/inference-rejection-limits.js";
import { readQualityValidationRejection } from "../../evaluation-report/quality-validation-rejection.js";
import { isWorkflowManifestV2, workflowSelectedPath } from "../../workflow-contracts/contracts.js";
import { readWorkflowOutcomeRejection } from "../../workflow-execution/outcome-rejection.js";
import { isModelCorrectableQualityRejection } from "../../workflow-execution/quality-rejection-retryability.js";
import { readFailureClassification } from "../../operator/failure-class.js";
import type {
  AnswerRecordContinuationCheckpointEnvelopeV1,
  AnswerRecordContinuationReceiptV1,
  RunRecord,
  StepRunRecord,
} from "../../records/contracts.js";
import { FileRunStore } from "../../records/file-store.js";
import { FileRunStoreError } from "../../records/file-store.js";
import { getWorkflow } from "../../workflow-registry/catalog.js";
import { AnswerRecordContinuationClaimStore } from "../../records/answer-record-continuation-store.js";
import type { AnswerRecordContinuationClaimV1 } from "../../records/answer-record-continuation-store.js";
import { decodeRunRecordRequestIntent } from "../../request-intent/interpret-record.js";
import { AnswerRecordContinuationStoreError } from "../../records/answer-record-continuation-store.js";
import { OUTPUT_RECORD_CONTRACTS } from "../../contracts/model-output.generated.js";
import { isInferenceAttemptOutcome } from "../../inference-attempt-taxonomy.js";
import {
  answerRecordContinuationPrefixSha256,
  workflowBranchCoverageDecodeOptionsV1,
} from "../../records/composition-execution.js";
import { decodeWorkflowBranchCoverageV1 } from "../../workflow-contracts/branch-coverage.js";
import type { RunRequestWithPublishProjection } from "./request.js";

export interface LoadedAnswerRecordContinuation {
  readonly request: RunRequestWithPublishProjection;
  readonly answerRecordContinuation: {
    readonly logicalRunId: string;
    readonly sourceRunId: string;
    readonly checkpoint: {
      readonly record: AnswerRecordContinuationCheckpointEnvelopeV1;
      readonly sha256: string;
    };
    readonly resumeStepId: string;
    readonly completedPrefix: readonly StepRunRecord[];
    readonly selectedPathId?: string;
    readonly selectionEvidence?: {
      readonly workflowBranchCoverage?: RunRecord["workflowBranchCoverage"];
    };
    readonly sourceArtifacts?: RunRecord["artifacts"];
  };
  readonly source: RunRecord;
  readonly sourceRunRecordSha256: string;
  readonly requestIntent: import("../../request-intent/interpret-record.js").RunRecordRequestIntentV1;
  readonly claimAnswerRecordContinuation: (child?: RunRecord) => Promise<void>;
}

/** Load only the selected run's committed evaluator checkpoint; never discover one by scanning. */
export async function loadAnswerRecordContinuation(
  request: RunRequestWithPublishProjection,
  config: DocsFabConfig,
): Promise<LoadedAnswerRecordContinuation | undefined> {
  if (!request.resumeFrom) return undefined;
  let selected: Awaited<ReturnType<FileRunStore["getWithDigest"]>>;
  try {
    selected = await new FileRunStore(config.stateDirectory).getWithDigest(request.resumeFrom);
  } catch (error) {
    if (error instanceof FileRunStoreError && error.code === "record-not-found") return undefined;
    throw error;
  }
  const sourceValue = object(selected.record);
  if (!sourceValue || sourceValue.id !== request.resumeFrom || !Array.isArray(sourceValue.steps)) {
    // hygiene: envelope -- run failures are rendered by reportCommandFailure.
    throw new Error("The selected run is not a valid saved workflow record.");
  }
  const source = sourceValue as unknown as RunRecord;
  if (
    (source.answerRecordDiscovery !== undefined) !==
    (request.experimentalAnswerRecords === true)
  ) {
    fail("source-discovery-mode-mismatch");
  }
  if (
    request.experimentalAnswerRecords === true &&
    source.answerRecordDiscovery?.answerRecordRefusalPolicy !== "non-exhausting-per-key"
  ) {
    fail(
      "source-discovery-refusal-policy-mismatch",
      "The saved discovery run uses a legacy refusal policy; start a fresh experimental answer-record review run.",
    );
  }
  const sourceSteps = source.steps;
  const targetCandidates = sourceSteps.filter(
    (step) => isObject(step) && step.id === "evaluate-document-quality",
  );
  const hasAnswerRecordPointer = sourceSteps.some(
    (step) => isObject(step) && step.answerRecordCheckpoint !== undefined,
  );
  const hasAnswerRecordProgress = sourceSteps.some(
    (step) =>
      isObject(step) &&
      isObject(step.answerRecordLedger) &&
      (step.answerRecordLedger.checkpoint !== undefined ||
        step.answerRecordLedger.progress !== undefined),
  );
  if (!hasAnswerRecordPointer && !hasAnswerRecordProgress) return undefined;
  if (!hasAnswerRecordPointer) fail("checkpoint-pointer-mismatch");

  const claimStore = new AnswerRecordContinuationClaimStore(
    resolve(dirname(config.stateDirectory), "answer-record-continuations"),
  );
  const orphanProof =
    source.status === "running"
      ? await proveOrphanedContinuationSource(
          source,
          selected.sha256,
          claimStore,
          config.stateDirectory,
        )
      : undefined;
  if (source.status === "running" && !orphanProof) {
    fail(
      "selected-run-ineligible",
      "A running continuation can resume only when its saved local owner claim proves that the prior process exited.",
    );
  }

  await validateSelectedSource(request, source, selected.sha256, orphanProof !== undefined);
  const targetIndex = sourceSteps.findIndex(
    (step) => isObject(step) && step.id === "evaluate-document-quality",
  );
  if (targetIndex < 0 || targetCandidates.length !== 1) fail("selected-step-mismatch");
  const target = sourceSteps[targetIndex]!;
  const completedQualityRefusal =
    target.status === "succeeded" && canContinueCompletedQualityRefusal(source, target);
  if (
    target.id !== "evaluate-document-quality" ||
    target.kind !== "evaluate" ||
    target.mode !== "read-only" ||
    !(target.status === "running"
      ? orphanProof !== undefined
      : ["failed", "needs-input", "needs-human-decision"].includes(target.status) ||
        completedQualityRefusal)
  ) {
    fail("selected-step-ineligible");
  }
  if (
    !getWorkflow(source.workflow).steps.some(
      (step) => step.id === target.id && step.kind === "evaluate",
    )
  ) {
    fail("selected-step-mismatch");
  }
  const expectedSteps = selectedWorkflowSteps(source);
  if (
    expectedSteps.length !== sourceSteps.length ||
    expectedSteps.some(
      (step, index) =>
        sourceSteps[index]?.id !== step.id ||
        sourceSteps[index]?.kind !== step.kind ||
        sourceSteps[index]?.mode !== step.mode,
    )
  ) {
    fail("selected-step-sequence-mismatch");
  }
  const prefix = sourceSteps.slice(0, targetIndex);
  if (
    prefix.some((step) => step.status !== "succeeded") ||
    sourceSteps.slice(targetIndex + 1).some((step) => step.status !== "pending")
  ) {
    fail("selected-prefix-incomplete");
  }
  if (orphanProof && !validInheritedPrefix(source, prefix, orphanProof.parent)) {
    fail("source-receipt-invalid");
  }
  const pointer = decodeStepPointer(target.answerRecordCheckpoint);
  const ledgerIndex = object(target.answerRecordLedger);
  const hasLedgerPointer = ledgerIndex?.checkpoint !== undefined;
  if (hasLedgerPointer) {
    const ledgerPointer = decodeLedgerPointer(ledgerIndex.checkpoint);
    if (
      pointer.sha256 !== ledgerPointer.sha256 ||
      pointer.sequence !== ledgerPointer.sequence ||
      pointer.attempt !== ledgerPointer.attempt
    ) {
      fail("checkpoint-pointer-mismatch");
    }
  } else {
    assertLegacyLedgerIndexShape(ledgerIndex);
  }
  const artifactStore = new DurableArtifactStore(
    resolve(dirname(config.stateDirectory), "artifacts"),
  );
  const storedCheckpoint = await artifactStore.getRecord(pointer.sha256);
  if (opaqueRecordDigest(storedCheckpoint) !== pointer.sha256) fail("checkpoint-digest-mismatch");
  const checkpoint = decodeCheckpoint(storedCheckpoint);
  if (
    checkpoint.sourceRunId !== source.id ||
    checkpoint.logicalRunId !== sourceLogicalRunId(source) ||
    checkpoint.stepId !== target.id ||
    checkpoint.sequence !== pointer.sequence ||
    (checkpoint.sourceAttemptHighWater < pointer.attempt &&
      (hasLedgerPointer ||
        !isLegacyCopiedCheckpointAttempt(source, target, pointer, checkpoint))) ||
    checkpoint.bindingsSha256 !== canonicalDigest(checkpoint.bindings)
  ) {
    fail("checkpoint-binding-mismatch");
  }
  if (!hasLedgerPointer) {
    await validateLegacyLedgerProjection(ledgerIndex!, checkpoint, artifactStore);
  }
  let requestIntent: import("../../request-intent/interpret-record.js").RunRecordRequestIntentV1;
  try {
    requestIntent = decodeRunRecordRequestIntent(source.requestIntent, source.instruction);
  } catch {
    fail("source-request-intent-invalid");
  }
  const claimInput = {
    sourceRunId: source.id,
    sourceRunRecordSha256: selected.sha256,
    checkpointSha256: pointer.sha256,
    checkpointSequence: pointer.sequence,
    checkpointAttempt: pointer.attempt,
    logicalRunId: checkpoint.logicalRunId,
  };
  const previousClaim = await claimStore.inspect(claimInput);
  const childRunId = previousClaim?.childRunId ?? randomUUID();
  if (previousClaim && (await childRunExists(config.stateDirectory, childRunId))) {
    // hygiene: envelope -- stable claim code is rendered by the CLI boundary.
    throw new AnswerRecordContinuationStoreError("already-claimed", childRunId);
  }
  if (previousClaim && (await claimStore.isOwnerAlive(previousClaim))) {
    // hygiene: envelope -- stable claim code is rendered by the CLI boundary.
    throw new AnswerRecordContinuationStoreError("already-claimed", childRunId);
  }
  const receipt: AnswerRecordContinuationReceiptV1 = {
    schemaVersion: 1,
    kind: "docsfab-answer-record-continuation-receipt",
    sourceRunId: source.id,
    sourceRunRecordSha256: selected.sha256,
    checkpointSha256: pointer.sha256,
    checkpointSequence: pointer.sequence,
    checkpointAttempt: pointer.attempt,
    logicalRunId: checkpoint.logicalRunId,
    inheritedPrefixSha256: answerRecordContinuationPrefixSha256(prefix as StepRunRecord[]),
    ...(orphanProof ? { recoveryBasis: "same-host-owner-process-exited" as const } : {}),
  };
  const claimAnswerRecordContinuation = async (child?: RunRecord): Promise<void> => {
    const latestSource = await new FileRunStore(config.stateDirectory).getWithDigest(source.id);
    if (latestSource.sha256 !== selected.sha256) {
      // hygiene: envelope -- stable claim code is rendered by the CLI boundary.
      throw new AnswerRecordContinuationStoreError("already-claimed", childRunId);
    }
    if (orphanProof) {
      const latestOrphanProof = await proveOrphanedContinuationSource(
        source,
        selected.sha256,
        claimStore,
        config.stateDirectory,
      );
      if (
        !latestOrphanProof ||
        canonicalDigest(latestOrphanProof.claim) !== canonicalDigest(orphanProof.claim) ||
        canonicalDigest(latestOrphanProof.parent) !== canonicalDigest(orphanProof.parent)
      ) {
        // hygiene: envelope -- stable claim code is rendered by the CLI boundary.
        throw new AnswerRecordContinuationStoreError("already-claimed", childRunId);
      }
    }
    if (!child && (await childRunExists(config.stateDirectory, childRunId))) {
      // hygiene: envelope -- stable claim code is rendered by the CLI boundary.
      throw new AnswerRecordContinuationStoreError("already-claimed", childRunId);
    }
    if (child) {
      const persisted = await new FileRunStore(config.stateDirectory).getWithDigest(childRunId);
      const persistedRecord = persisted.record as RunRecord;
      const persistedReceipt = persistedRecord.answerRecordContinuation;
      if (
        child.id !== childRunId ||
        persistedRecord.id !== childRunId ||
        persistedReceipt === undefined ||
        canonicalDigest(persistedRecord) !== canonicalDigest(child) ||
        canonicalDigest(persistedReceipt) !== canonicalDigest(receipt)
      ) {
        // hygiene: envelope -- stable claim code is rendered by the CLI boundary.
        throw new AnswerRecordContinuationStoreError("already-claimed", childRunId);
      }
    }
    // In a real run the persisted placeholder is distinguished by exact
    // record identity. The journal claim excludes a competing resume.
    await claimStore.claim({ ...claimInput, childRunId });
  };
  const { resumeFrom: _resumeFrom, runId: _runId, ...requestWithoutSourceSelector } = request;
  const instruction = source.instruction ?? request.instruction;
  return {
    request: {
      ...requestWithoutSourceSelector,
      runId: childRunId,
      revision: source.repository.revision,
      ...(instruction !== undefined ? { instruction } : {}),
      answerRecordContinuationReceipt: receipt,
    },
    answerRecordContinuation: {
      logicalRunId: checkpoint.logicalRunId,
      sourceRunId: source.id,
      checkpoint: { record: checkpoint, sha256: pointer.sha256 },
      resumeStepId: target.id,
      completedPrefix: prefix as StepRunRecord[],
      ...(source.workflowBranchCoverage?.selection?.branchId
        ? { selectedPathId: source.workflowBranchCoverage.selection.branchId }
        : {}),
      ...(source.workflowBranchCoverage
        ? {
            selectionEvidence: {
              workflowBranchCoverage: structuredClone(source.workflowBranchCoverage),
            },
          }
        : {}),
      ...(source.artifacts ? { sourceArtifacts: structuredClone(source.artifacts) } : {}),
    },
    source,
    sourceRunRecordSha256: selected.sha256,
    requestIntent,
    claimAnswerRecordContinuation,
  };
}

async function childRunExists(stateDirectory: string, childRunId: string): Promise<boolean> {
  try {
    await new FileRunStore(stateDirectory).getWithDigest(childRunId);
    return true;
  } catch (error) {
    if (error instanceof FileRunStoreError && error.code === "record-not-found") return false;
    throw error;
  }
}

interface OrphanedContinuationProof {
  readonly claim: AnswerRecordContinuationClaimV1;
  readonly parent: RunRecord;
}

async function proveOrphanedContinuationSource(
  source: RunRecord,
  sourceSha256: string,
  claimStore: AnswerRecordContinuationClaimStore,
  stateDirectory: string,
): Promise<OrphanedContinuationProof | undefined> {
  const receipt = source.answerRecordContinuation;
  if (
    source.status !== "running" ||
    !isObject(source.repository) ||
    typeof source.repository.revision !== "string" ||
    typeof source.repository.sourcePath !== "string" ||
    !Array.isArray(source.steps) ||
    !receipt ||
    receipt.kind !== "docsfab-answer-record-continuation-receipt" ||
    receipt.schemaVersion !== 1 ||
    receipt.sourceRunId === source.id ||
    !isSafeId(receipt.sourceRunId) ||
    !isSafeId(receipt.logicalRunId) ||
    !isSha256(receipt.sourceRunRecordSha256) ||
    !isSha256(receipt.checkpointSha256) ||
    !isSha256(receipt.inheritedPrefixSha256) ||
    !positiveCount(receipt.checkpointSequence) ||
    !positiveCount(receipt.checkpointAttempt)
  ) {
    return undefined;
  }
  const localHost = `${process.platform}:${hostname()}`;
  const claimIdentity = {
    sourceRunId: receipt.sourceRunId,
    sourceRunRecordSha256: receipt.sourceRunRecordSha256,
    checkpointSha256: receipt.checkpointSha256,
    checkpointSequence: receipt.checkpointSequence,
    checkpointAttempt: receipt.checkpointAttempt,
    logicalRunId: receipt.logicalRunId,
  };
  const claim = await claimStore.inspect(claimIdentity);
  if (
    !claim ||
    claim.childRunId !== source.id ||
    claim.ownerHost !== localHost ||
    (await claimStore.isOwnerAlive(claim))
  ) {
    return undefined;
  }

  let parentRead: Awaited<ReturnType<FileRunStore["getWithDigest"]>>;
  try {
    parentRead = await new FileRunStore(stateDirectory).getWithDigest(receipt.sourceRunId);
  } catch (error) {
    if (error instanceof FileRunStoreError && error.code === "record-not-found") return undefined;
    throw error;
  }
  const parentObject = object(parentRead.record);
  if (
    !parentObject ||
    parentRead.sha256 !== receipt.sourceRunRecordSha256 ||
    parentObject.id !== receipt.sourceRunId ||
    parentObject.workflow !== source.workflow ||
    !Array.isArray(parentObject.steps) ||
    !isObject(parentObject.repository) ||
    parentObject.repository.revision !== source.repository.revision ||
    parentObject.repository.sourcePath !== source.repository.sourcePath
  ) {
    return undefined;
  }
  const parent = parentObject as unknown as RunRecord;
  if (sourceLogicalRunId(parent) !== receipt.logicalRunId) return undefined;
  const parentIndex = parent.steps.findIndex((step) => step.id === "evaluate-document-quality");
  const parentTarget = parent.steps[parentIndex];
  if (!parentTarget || parentIndex < 0) return undefined;
  let parentPointer: ReturnType<typeof decodeStepPointer>;
  try {
    parentPointer = decodeStepPointer(parentTarget.answerRecordCheckpoint);
  } catch {
    return undefined;
  }
  const parentLedgerIndex = object(parentTarget.answerRecordLedger);
  const parentHasLedgerPointer = parentLedgerIndex?.checkpoint !== undefined;
  if (parentHasLedgerPointer) {
    try {
      const ledgerPointer = decodeLedgerPointer(parentLedgerIndex.checkpoint);
      if (
        ledgerPointer.sha256 !== parentPointer.sha256 ||
        ledgerPointer.sequence !== parentPointer.sequence ||
        ledgerPointer.attempt !== parentPointer.attempt
      ) {
        return undefined;
      }
    } catch {
      return undefined;
    }
  } else {
    try {
      assertLegacyLedgerIndexShape(parentLedgerIndex);
    } catch {
      return undefined;
    }
  }
  if (
    parentPointer.sha256 !== receipt.checkpointSha256 ||
    parentPointer.sequence !== receipt.checkpointSequence ||
    parentPointer.attempt !== receipt.checkpointAttempt
  ) {
    return undefined;
  }
  const artifacts = new DurableArtifactStore(resolve(dirname(stateDirectory), "artifacts"));
  let parentCheckpoint: AnswerRecordContinuationCheckpointEnvelopeV1;
  try {
    const stored = await artifacts.getRecord(receipt.checkpointSha256);
    if (opaqueRecordDigest(stored) !== receipt.checkpointSha256) return undefined;
    parentCheckpoint = decodeCheckpoint(stored);
  } catch {
    return undefined;
  }
  if (!parentHasLedgerPointer) {
    try {
      await validateLegacyLedgerProjection(parentLedgerIndex!, parentCheckpoint, artifacts);
    } catch {
      return undefined;
    }
  }
  if (
    parentCheckpoint.sourceRunId !== parent.id ||
    parentCheckpoint.logicalRunId !== receipt.logicalRunId ||
    parentCheckpoint.sequence !== receipt.checkpointSequence ||
    (parentCheckpoint.sourceAttemptHighWater < receipt.checkpointAttempt &&
      (parentHasLedgerPointer ||
        !isLegacyCopiedCheckpointAttempt(parent, parentTarget, parentPointer, parentCheckpoint)))
  ) {
    return undefined;
  }
  if (!isSha256(sourceSha256)) return undefined;
  return { claim, parent };
}

function validInheritedPrefix(
  source: RunRecord,
  prefix: readonly StepRunRecord[],
  parent: RunRecord,
): boolean {
  const receipt = source.answerRecordContinuation;
  if (!receipt) return false;
  const parentIndex = parent.steps.findIndex((step) => step.id === "evaluate-document-quality");
  if (parentIndex < 0 || prefix.length !== parentIndex) return false;
  const parentPrefix = parent.steps.slice(0, parentIndex);
  return (
    prefix.every(
      (step) =>
        step.inheritedFrom?.sourceRunId === receipt.sourceRunId &&
        step.inheritedFrom.sourceRunRecordSha256 === receipt.sourceRunRecordSha256 &&
        step.inheritedFrom.sourceStepId === step.id,
    ) &&
    answerRecordContinuationPrefixSha256(prefix) ===
      answerRecordContinuationPrefixSha256(parentPrefix) &&
    answerRecordContinuationPrefixSha256(prefix) === receipt.inheritedPrefixSha256
  );
}

async function validateSelectedSource(
  request: RunRequestWithPublishProjection,
  source: RunRecord,
  sourceSha256: string,
  allowRunningOrphan = false,
): Promise<void> {
  const instructionValid =
    source.instruction === undefined
      ? source.workflow === "review-documentation"
      : typeof source.instruction === "string" && source.instruction.length > 0;
  if (
    source.schemaVersion !== 2 ||
    source.id !== request.resumeFrom ||
    source.workflow !== request.workflow ||
    !instructionValid ||
    (!(allowRunningOrphan && source.status === "running") &&
      !["failed", "needs-input", "needs-human-decision"].includes(source.status)) ||
    !isSha256(sourceSha256) ||
    !isObject(source.repository) ||
    typeof source.repository.sourcePath !== "string" ||
    typeof source.repository.revision !== "string"
  ) {
    fail("selected-run-ineligible");
  }
  const definition = getWorkflow(source.workflow);
  if (
    source.workflow !== "review-documentation" &&
    !(source.workflow === "update-documentation" && isWorkflowManifestV2(definition))
  ) {
    fail("selected-run-ineligible");
  }
  if (
    !definition.steps.some(
      (step) => step.id === "evaluate-document-quality" && step.kind === "evaluate",
    )
  ) {
    fail("selected-run-ineligible");
  }
  if (source.workflow === "update-documentation") {
    try {
      if (!isWorkflowManifestV2(definition) || !source.workflowBranchCoverage) {
        fail("selected-path-evidence-missing");
      }
      decodeWorkflowBranchCoverageV1(
        source.workflowBranchCoverage,
        workflowBranchCoverageDecodeOptionsV1({ workflow: definition, record: source }),
      );
    } catch {
      fail("selected-path-evidence-invalid");
    }
  }
  if (request.revisionExplicit && request.revision !== source.repository.revision) {
    fail("requested-revision-mismatch");
  }
  if (request.instruction !== undefined && request.instruction !== source.instruction) {
    fail("requested-instruction-mismatch");
  }
  const [requestedPath, selectedPath] = await Promise.all([
    realpath(resolve(request.repositoryPath)),
    realpath(resolve(source.repository.sourcePath)),
  ]);
  if (requestedPath !== selectedPath) fail("requested-repository-mismatch");
  if (!definition.steps.some((step) => step.id === "evaluate-document-quality")) {
    fail("selected-run-ineligible");
  }
  if (!isSha256(sourceSha256)) fail("selected-run-ineligible");
}

const COMPLETED_QUALITY_OUTCOME_REFUSAL = "workflow-outcome-admission-execution-product-mismatch";

/**
 * A final evaluator can have succeeded while the workflow failed to admit its
 * product. Continue that completed step only when its retained validation
 * refusal is model-correctable and no quality product was admitted.
 */
function canContinueCompletedQualityRefusal(source: RunRecord, target: StepRunRecord): boolean {
  const rejection = readQualityValidationRejection(target.qualityValidationRejection);
  const outcome = readWorkflowOutcomeRejection(source.workflowOutcomeRejection);
  const failure = readFailureClassification(source.failure);
  return (
    source.status === "failed" &&
    source.workflowOutcome === undefined &&
    outcome?.code === COMPLETED_QUALITY_OUTCOME_REFUSAL &&
    failure?.class === "contract-shape" &&
    failure.layer === "workflow" &&
    failure.code === outcome.code &&
    target.id === "evaluate-document-quality" &&
    target.kind === "evaluate" &&
    target.mode === "read-only" &&
    rejection !== null &&
    isModelCorrectableQualityRejection(rejection.code) &&
    source.qualityArtifactValidation === undefined &&
    !(target.artifacts ?? []).some((use) => use.role === "output") &&
    !(source.artifacts ?? []).some(
      (use) => use.role === "output" && use.stepId === "evaluate-document-quality",
    )
  );
}

function selectedWorkflowSteps(source: RunRecord) {
  const workflow = getWorkflow(source.workflow);
  if (isWorkflowManifestV2(workflow)) {
    const branchId = source.workflowBranchCoverage?.selection?.branchId;
    return branchId
      ? workflowSelectedPath(workflow, branchId).steps
      : workflow.branching.prefix.steps;
  }
  return workflow.steps;
}

function sourceLogicalRunId(source: RunRecord): string {
  const receipt = source.answerRecordContinuation;
  if (receipt !== undefined) {
    if (
      receipt.kind !== "docsfab-answer-record-continuation-receipt" ||
      receipt.schemaVersion !== 1 ||
      !isSafeId(receipt.logicalRunId)
    ) {
      fail("source-receipt-invalid");
    }
    return receipt.logicalRunId;
  }
  return source.id;
}

function decodeStepPointer(value: unknown): { sha256: string; sequence: number; attempt: number } {
  if (
    !isObject(value) ||
    !isSha256(value.sha256) ||
    !positiveCount(value.sequence) ||
    !positiveCount(value.attempt)
  ) {
    fail("checkpoint-pointer-mismatch");
  }
  return { sha256: value.sha256, sequence: value.sequence, attempt: value.attempt };
}

function decodeLedgerPointer(value: unknown): {
  sha256: string;
  sequence: number;
  attempt: number;
} {
  return decodeStepPointer(value);
}

function assertLegacyLedgerIndexShape(
  value: Record<string, unknown> | undefined,
): asserts value is Record<string, unknown> {
  if (
    !value ||
    !hasExactKeys(value, ["schemaVersion", "kind", "contractId", "bindingsSha256", "rows"]) ||
    value.schemaVersion !== 1 ||
    value.kind !== "docsfab-answer-record-ledger-index" ||
    value.contractId !== "quality-evaluation" ||
    !isSha256(value.bindingsSha256) ||
    !Array.isArray(value.rows)
  ) {
    fail("checkpoint-pointer-mismatch");
  }
}

async function validateLegacyLedgerProjection(
  value: Record<string, unknown>,
  checkpoint: AnswerRecordContinuationCheckpointEnvelopeV1,
  artifactStore: DurableArtifactStore,
): Promise<void> {
  if (value.bindingsSha256 !== checkpoint.bindingsSha256 || !Array.isArray(value.rows)) {
    fail("checkpoint-ledger-mismatch");
  }
  const checkpointRows = new Map<
    string,
    AnswerRecordContinuationCheckpointEnvelopeV1["rows"][number]
  >();
  for (const row of checkpoint.rows) {
    if (
      !isQualityAnswerRecordType(row.type) ||
      !isRecordKey(row.key) ||
      !isSha256(row.recordSha256) ||
      !isSha256(row.payloadSha256) ||
      !positiveCount(row.originalAttempt) ||
      row.originalAttempt > checkpoint.sourceAttemptHighWater
    ) {
      fail("checkpoint-ledger-mismatch");
    }
    const id = ledgerRowId(row.type, row.key);
    if (checkpointRows.has(id)) fail("checkpoint-ledger-mismatch");
    checkpointRows.set(id, row);
  }

  const seen = new Set<string>();
  const matchedCheckpointRows = new Set<string>();
  const releasedIds = new Set<string>();
  for (const candidate of value.rows) {
    const row = object(candidate);
    if (
      !row ||
      !hasExactKeys(row, ["type", "key", "recordSha256", "state", "attempt"]) ||
      !isQualityAnswerRecordType(row.type) ||
      !isRecordKey(row.key) ||
      !isSha256(row.recordSha256) ||
      !positiveCount(row.attempt) ||
      (row.state !== "admitted" && row.state !== "released")
    ) {
      fail("checkpoint-ledger-mismatch");
    }
    const id = ledgerRowId(row.type, row.key);
    if (seen.has(id)) fail("checkpoint-ledger-mismatch");
    seen.add(id);
    if (row.state === "admitted") {
      const checkpointRow = checkpointRows.get(id);
      if (
        !checkpointRow ||
        checkpointRow.recordSha256 !== row.recordSha256 ||
        checkpointRow.originalAttempt !== row.attempt
      ) {
        fail("checkpoint-ledger-mismatch");
      }
      matchedCheckpointRows.add(id);
    } else {
      if (checkpointRows.has(id)) fail("checkpoint-ledger-mismatch");
      await validateReleasedLedgerRow(row, checkpoint, artifactStore);
      releasedIds.add(id);
    }
  }
  if (matchedCheckpointRows.size !== checkpointRows.size) fail("checkpoint-ledger-mismatch");

  const releaseTombstones = new Set<string>();
  for (const candidate of checkpoint.tombstones) {
    const tombstone = object(candidate);
    if (!tombstone || tombstone.reasonCode !== "released") continue;
    if (
      !hasExactKeys(tombstone, ["type", "key", "reasonCode", "settlementSequence"]) ||
      !isQualityAnswerRecordType(tombstone.type) ||
      !isRecordKey(tombstone.key) ||
      !positiveCount(tombstone.settlementSequence) ||
      tombstone.settlementSequence > checkpoint.settledBatchHighWater
    ) {
      fail("checkpoint-ledger-mismatch");
    }
    const id = ledgerRowId(tombstone.type, tombstone.key);
    releaseTombstones.add(id);
  }
  for (const id of releasedIds) {
    if (!releaseTombstones.has(id)) fail("checkpoint-ledger-mismatch");
  }
}

async function validateReleasedLedgerRow(
  row: Record<string, unknown>,
  checkpoint: AnswerRecordContinuationCheckpointEnvelopeV1,
  artifactStore: DurableArtifactStore,
): Promise<void> {
  const digest = row.recordSha256;
  let stored: unknown;
  try {
    stored = await artifactStore.getRecord(digest as string);
  } catch {
    fail("checkpoint-ledger-mismatch");
  }
  const sealed = object(stored);
  if (
    !sealed ||
    !hasExactKeys(sealed, [
      "schemaVersion",
      "kind",
      "recordSha256",
      "contractId",
      "contractVersion",
      "runId",
      "stepId",
      "attempt",
      "type",
      "key",
      "state",
      "bindings",
      "payloadSha256",
      "payload",
    ]) ||
    opaqueRecordDigest(sealed) !== digest ||
    sealed.schemaVersion !== 1 ||
    sealed.kind !== "docsfab-answer-record" ||
    sealed.recordSha256 !==
      canonicalDigest(
        Object.fromEntries(Object.entries(sealed).filter(([key]) => key !== "recordSha256")),
      ) ||
    sealed.contractId !== "quality-evaluation" ||
    sealed.contractVersion !== OUTPUT_RECORD_CONTRACTS["quality-evaluation"].version ||
    sealed.runId !== checkpoint.logicalRunId ||
    sealed.stepId !== checkpoint.stepId ||
    sealed.attempt !== row.attempt ||
    Number(row.attempt) > checkpoint.sourceAttemptHighWater ||
    sealed.type !== row.type ||
    sealed.key !== row.key ||
    sealed.state !== "released" ||
    !isSha256(sealed.payloadSha256) ||
    canonicalDigest(sealed.payload) !== sealed.payloadSha256
  ) {
    fail("checkpoint-ledger-mismatch");
  }
  const bindings = object(sealed.bindings);
  if (!bindings) fail("checkpoint-ledger-mismatch");
  if (canonicalDigest(bindings) !== checkpoint.bindingsSha256) {
    fail("checkpoint-ledger-mismatch");
  }
}

function isLegacyCopiedCheckpointAttempt(
  source: RunRecord,
  step: StepRunRecord,
  pointer: { readonly attempt: number },
  checkpoint: AnswerRecordContinuationCheckpointEnvelopeV1,
): boolean {
  if (
    step.status !== "succeeded" ||
    !canContinueCompletedQualityRefusal(source, step) ||
    checkpoint.sourceAttemptHighWater >= pointer.attempt
  ) {
    return false;
  }
  const inference = object(step.inference);
  const attempts = inference?.attempts;
  if (!Array.isArray(attempts) || attempts.length !== pointer.attempt) return false;
  return attempts.every((candidate, index) => {
    const attempt = object(candidate);
    return (
      attempt?.attempt === index + 1 &&
      isInferenceAttemptOutcome(attempt.outcome) &&
      (index < attempts.length - 1 || attempt.outcome === "succeeded")
    );
  });
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
}

function isQualityAnswerRecordType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    OUTPUT_RECORD_CONTRACTS["quality-evaluation"].records.some((record) => record.type === value)
  );
}

function isRecordKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function ledgerRowId(type: string, key: string): string {
  return `${type}\u0000${key}`;
}

function decodeCheckpoint(value: unknown): AnswerRecordContinuationCheckpointEnvelopeV1 {
  if (!isObject(value)) fail("checkpoint-shape-invalid");
  const { recordSha256, ...checkpointBody } = value;
  if (!isSha256(recordSha256) || recordSha256 !== canonicalDigest(checkpointBody)) {
    fail("checkpoint-shape-invalid");
  }
  const required = [
    "schemaVersion",
    "kind",
    "continuationId",
    "sequence",
    "predecessorCheckpointSha256",
    "sourceRunId",
    "logicalRunId",
    "stepId",
    "sourceAttemptHighWater",
    "bindingsSha256",
    "bindings",
    "rows",
    "issuedKeyHighWater",
    "tombstones",
    "refusalCounts",
    "refusalExhaustion",
    "settledBatchHighWater",
    "complete",
  ];
  const hasRefusalDiagnostics = Object.hasOwn(checkpointBody, "refusalDiagnostics");
  if (
    Object.keys(checkpointBody).length !== required.length + Number(hasRefusalDiagnostics) ||
    required.some((key) => !Object.hasOwn(checkpointBody, key)) ||
    checkpointBody.schemaVersion !== 1 ||
    checkpointBody.kind !== "docsfab-answer-record-continuation-checkpoint" ||
    !isSafeId(checkpointBody.continuationId) ||
    !positiveCount(checkpointBody.sequence) ||
    !(
      checkpointBody.predecessorCheckpointSha256 === null ||
      isSha256(checkpointBody.predecessorCheckpointSha256)
    ) ||
    !isSafeId(checkpointBody.sourceRunId) ||
    !isSafeId(checkpointBody.logicalRunId) ||
    checkpointBody.stepId !== "evaluate-document-quality" ||
    !positiveCount(checkpointBody.sourceAttemptHighWater) ||
    !isSha256(checkpointBody.bindingsSha256) ||
    !isObject(checkpointBody.bindings) ||
    !Array.isArray(checkpointBody.rows) ||
    !isObject(checkpointBody.issuedKeyHighWater) ||
    !Array.isArray(checkpointBody.tombstones) ||
    !isObject(checkpointBody.refusalCounts) ||
    !(checkpointBody.refusalExhaustion === null || isObject(checkpointBody.refusalExhaustion)) ||
    !Number.isSafeInteger(checkpointBody.settledBatchHighWater) ||
    Number(checkpointBody.settledBatchHighWater) < 0 ||
    (hasRefusalDiagnostics && !isValidRefusalDiagnostics(checkpointBody.refusalDiagnostics)) ||
    typeof checkpointBody.complete !== "boolean"
  ) {
    fail("checkpoint-shape-invalid");
  }
  // Keep the verified envelope intact for the admission host, whose
  // decodeSealed contract compares the complete canonical envelope.
  return value as unknown as AnswerRecordContinuationCheckpointEnvelopeV1;
}

function isValidRefusalDiagnostics(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  for (const diagnostic of value) {
    if (
      !isObject(diagnostic) ||
      Object.keys(diagnostic).sort().join("\u0000") !== "code\u0000count\u0000location" ||
      typeof diagnostic.code !== "string" ||
      typeof diagnostic.location !== "string" ||
      !positiveCount(diagnostic.count) ||
      !isRetainableInferenceRejection({ code: diagnostic.code, location: diagnostic.location })
    ) {
      return false;
    }
    const id = `${diagnostic.code}\u0000${diagnostic.location}`;
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function positiveCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function fail(code: string, remediation = "Select a valid stopped run."): never {
  // hygiene: envelope -- run failures are rendered by reportCommandFailure.
  throw new Error(`The selected answer-record continuation was refused (${code}). ${remediation}`);
}
