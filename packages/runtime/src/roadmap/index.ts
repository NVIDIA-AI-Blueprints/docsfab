// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export {
  RoadmapContractError,
  roadmapCanonicalJson,
  roadmapDigest,
  validateRoadmapSchemaMigrationRule,
  type RoadmapContractErrorCode,
  type RoadmapSchemaMigrationRule,
} from "./contracts/decode.js";
export {
  ROADMAP_LEDGER_SCHEMA_VERSION,
  ROADMAP_LIFECYCLE_STATES,
  ROADMAP_EVIDENCE_KINDS,
  createRoadmapLedger,
  roadmapFindingFingerprint,
  validateRoadmapLedger,
  type RoadmapLifecycleState,
  type RoadmapEvidenceKind,
  type RoadmapProjectIdentity,
  type RoadmapDiscoveryBoundary,
  type RoadmapTrackerObservation,
  type RoadmapEvidenceReference,
  type RoadmapFindingMaterial,
  type RoadmapFinding,
  type RoadmapWorkstream,
  type RoadmapDedupDecision,
  type RoadmapLifecycleTransition,
  type RoadmapSweep,
  type RoadmapCloseoutDecision,
  type RoadmapLedger,
} from "./contracts/ledger.js";
export {
  ROADMAP_OPERATION_KINDS,
  createRoadmapMutationPlan,
  createRoadmapRunArtifactReferences,
  validateRoadmapMutationPlan,
  validateRoadmapRunArtifactReferences,
  type RoadmapOperationKind,
  type RoadmapMutationPrecondition,
  type RoadmapSagaProposal,
  type RoadmapIssueProposal,
  type RoadmapUpdateProposal,
  type RoadmapCommentProposal,
  type RoadmapLinkProposal,
  type RoadmapMilestoneProposal,
  type RoadmapLabelProposal,
  type RoadmapClosureProposal,
  type RoadmapMutationProposal,
  type RoadmapMutationOperation,
  type RoadmapLedgerReference,
  type RoadmapMutationPlanReference,
  type RoadmapRunArtifactReferences,
  type RoadmapMutationPlan,
  type RoadmapMutationPlanValidationOptions,
} from "./contracts/mutation.js";
export {
  assertRoadmapOperationAuthorized,
  createRoadmapMutationAuthorization,
  validateRoadmapMutationAuthorization,
  type RoadmapMutationAuthorization,
} from "./contracts/authorization.js";
export {
  ROADMAP_ATTEMPT_DISPOSITIONS,
  createRoadmapMutationReceipt,
  validateRoadmapMutationReceipt,
  type RoadmapAttemptDisposition,
  type RoadmapTrackerIdentity,
  type RoadmapMutationAttempt,
  type RoadmapMutationReceipt,
} from "./contracts/receipt.js";
export * from "./execution-v2.js";
export * from "./gitlab-readonly.js";
export * from "./host-operation-request.js";
export * from "./issue-adapter.js";
export * from "./gitlab-issue-adapter.js";
export * from "./issue-lifecycle.js";
export * from "./issue-lock.js";
export * from "./managed-issue.js";
export * from "./managed-issue-observer.js";
export * from "./managed-issue-state.js";
export * from "./planning.js";
export * from "./planning-cli.js";
