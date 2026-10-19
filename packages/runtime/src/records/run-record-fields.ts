// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WorkflowName } from "../workflow-contracts/contracts.js";
import type { RunRecord } from "./contracts.js";

/**
 * Every top-level field the run-record writer can emit, exhaustive against
 * `RunRecord` at compile time. The writer/reader parity test then requires
 * every strict reader to admit each field or state why it never reads it, so
 * a closed key list cannot silently reject an upgraded writer's records.
 */
const RUN_RECORD_FIELD_SET = {
  schemaVersion: true,
  id: true,
  workflow: true,
  repository: true,
  workspace: true,
  instruction: true,
  retryContext: true,
  operatorTargetPaths: true,
  instructionContext: true,
  readerEvidenceRequest: true,
  retainedEvidenceBindings: true,
  task: true,
  taskLineage: true,
  compositionExecution: true,
  answerRecordDiscovery: true,
  compositionExecutionAggregate: true,
  modelSettings: true,
  knowledgeResumeReceipt: true,
  knowledgeContinuationReceipt: true,
  knowledgeContinuationRecoveryAuthorization: true,
  knowledgeContinuationSnapshotSha256: true,
  answerRecordContinuation: true,
  knowledgeContinuationAcceptanceSha256: true,
  status: true,
  checkoutPersistence: true,
  workflowOutcome: true,
  workflowBranchCoverage: true,
  authoringExecution: true,
  releaseDocumentationReadiness: true,
  workUnitMachineContracts: true,
  error: true,
  failure: true,
  workflowOutcomeRejection: true,
  authoringCandidateRejection: true,
  editorialFinalizationRejection: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  durationMs: true,
  models: true,
  skills: true,
  qualityPack: true,
  qualityProfileSelection: true,
  qualityArtifactValidation: true,
  usage: true,
  tools: true,
  artifacts: true,
  searchFindings: true,
  negativeEvidence: true,
  gapLedger: true,
  securityScan: true,
  securityScanEffectiveDisposition: true,
  securityScanAuthorization: true,
  changes: true,
  impactPostflight: true,
  reviewScope: true,
  requestIntent: true,
  firstPassContradiction: true,
  firstPassContradictionAdmission: true,
  firstPassReplay: true,
  firstPassChoices: true,
  liveAgentTurn: true,
  liveAgentTurnFailure: true,
  sourceCitations: true,
  changeSources: true,
  reviewDeliverySnapshot: true,
  changeSourceRelease: true,
  credentialFindings: true,
  evidenceWarnings: true,
  steps: true,
} as const satisfies Record<keyof RunRecord, true>;

export const RUN_RECORD_FIELDS: readonly (keyof RunRecord)[] = Object.freeze(
  Object.keys(RUN_RECORD_FIELD_SET) as (keyof RunRecord)[],
);

/**
 * Fields only some workflows write, with those producers. A strict reader may
 * refuse such a field without a decoder only when it admits none of its
 * producers; the reader-policy test holds every reader to that.
 */
export const RUN_RECORD_FIELD_PRODUCERS: Readonly<
  Partial<Record<keyof RunRecord, readonly WorkflowName[]>>
> = Object.freeze({
  qualityProfileSelection: ["review-documentation", "create-documentation", "update-documentation"],
  qualityArtifactValidation: [
    "review-documentation",
    "create-documentation",
    "update-documentation",
  ],
  reviewScope: ["review-documentation"],
  reviewDeliverySnapshot: ["review-documentation"],
  // The publication boundary admits this read-only marker after validating its
  // closed shape and run binding; it is not a generic read-only exclusion.
  answerRecordDiscovery: ["review-documentation"],
  releaseDocumentationReadiness: ["release-documentation-readiness"],
  workUnitMachineContracts: ["release-documentation-readiness"],
  liveAgentTurn: ["live-agent-turn"],
  liveAgentTurnFailure: ["live-agent-turn"],
});

/**
 * Fields the writer leaves only on a failed run
 * (`attachRunFailureClassifications` removes them from every other record).
 */
export const RUN_RECORD_FAILED_RUN_FIELDS: readonly (keyof RunRecord)[] = Object.freeze([
  "failure",
  "workflowOutcomeRejection",
  "authoringCandidateRejection",
  "editorialFinalizationRejection",
]);

/** These first-pass fields cannot coexist on an ordinary succeeded site-bootstrap fixture. */
export const RUN_RECORD_FIRST_PASS_ONLY_FIELDS: readonly (keyof RunRecord)[] = Object.freeze([
  "firstPassContradiction",
  "firstPassContradictionAdmission",
  "firstPassReplay",
  "firstPassChoices",
]);
