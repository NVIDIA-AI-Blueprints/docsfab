// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Public hosted-runtime wire surface; kind-owned modules live beside this barrel. */
export { HostRuntimeContractError } from "./contract-error.js";
// The host screens a retained attempt record with this exact terminal
// screen, never a copy of it.
export { canonicalJson, containsCredentialDeep, digest } from "./wire-decode.js";
export {
  sealHostRuntimeNativeCustody,
  parseHostRuntimeNativeCustody,
  describeHostRuntimeNativeInput,
  loadHostRuntimeNativeCustodyInput,
  loadHostRuntimeNativeBytes,
  parseHostRuntimeNativeSource,
  type HostRuntimeNativeCustodyV1,
} from "./native-custody.js";
// `packages/runtime/scripts/check-package-imports.mjs` admits only this barrel
// and `native-approval.ts` from `host-invoker/*` into host src. Widening that
// ratchet would let host code reach any runtime module.
export {
  HOST_RUNTIME_APPROVED_MODEL_BASELINE_BYTES_LIMIT,
  HOST_RUNTIME_APPROVED_MODEL_BASELINE_MAXIMUM_BYTES,
  parseHostRuntimeApprovedModelData,
  parseHostRuntimeApprovedModelReference,
  type HostRuntimeApprovedModelData,
  type HostRuntimeApprovedModelReferenceV1,
} from "./approved-model.js";
export {
  HOST_RUNTIME_NATIVE_TASK_KIND,
  HOST_RUNTIME_NATIVE_WORKFLOWS,
  sealHostRuntimeNativeTask,
  parseHostRuntimeNativeTask,
  parseHostRuntimeNativePlanReference,
  type HostRuntimeNativeWorkflow,
  type HostRuntimeNativeInputReferenceV1,
  type HostRuntimeResolvedNativeInputV1,
  type HostRuntimeNativeTaskPayloadV1,
  type HostRuntimeNativeTaskV1,
} from "./native-task.js";
export { HOST_RUNTIME_READER_REQUEST_MAXIMUM_BYTES } from "./reader-task-capacity.js";
// Exported so the host reads one supported ceiling instead of restating it.
export {
  HOSTED_OUTPUT_LINE_FRAME,
  HOSTED_OUTPUT_LINE_MAXIMUM_BYTES,
  HostedOutputCapacityError,
  serializeHostedOutputLine,
} from "./output-capacity.js";
export type { HostedOutputLineAccountingV1 } from "./output-capacity.js";
export { conservativeReaderContextInputTransport } from "../reader-task-transport.js";
export {
  HOST_RUNTIME_WRITE_AUTHORITY_KIND,
  HOST_RUNTIME_WRITE_AUTHORITY_SCHEMA_VERSION,
  HOST_RUNTIME_WRITE_OPERATIONS,
  HOST_RUNTIME_WRITE_FILE_MODE,
  HOST_RUNTIME_WRITE_MAXIMUM_TARGETS,
  HOST_RUNTIME_WRITE_MAXIMUM_PATCH_BYTES,
  HOST_RUNTIME_WRITE_MAXIMUM_CEILING_ENTRIES,
  sealHostRuntimeWriteAuthority,
  parseHostRuntimeWriteAuthority,
  assertHostRuntimeWriteAuthorityBinding,
  type HostRuntimeWriteOperation,
  type HostRuntimeWriteTargetV2,
  type HostRuntimeWriteAuthorityV2,
} from "./write-authority.js";
export {
  HOST_RUNTIME_READER_TASK_KIND,
  HOST_RUNTIME_READER_TASK_MAXIMUM_SOURCES,
  HOST_RUNTIME_READER_TASK_MAXIMUM_BYTES,
  HOST_RUNTIME_READER_EVIDENCE_MAXIMUM_CEILING_ENTRIES,
  sealHostRuntimeReaderTask,
  sealHostRuntimeReaderEvidencePolicy,
  parseHostRuntimeReaderEvidencePolicy,
  assertHostRuntimeReaderEvidenceNominations,
  parseHostRuntimeReaderTask,
  type HostRuntimeReaderTaskV1,
  type HostRuntimeReaderEvidencePolicyV1,
  type HostRuntimeReaderEvidencePolicyV2,
  type HostRuntimeReaderEvidencePolicy,
  type HostRuntimeReaderEvidenceNominationV1,
} from "./reader-task.js";
export {
  HOST_RUNTIME_PATCH_EVIDENCE_KIND,
  sealHostRuntimePatchEvidence,
  parseHostRuntimePatchEvidence,
  type HostRuntimePatchChangeV1,
  type HostRuntimePatchEvidenceV1,
} from "./patch-evidence.js";
export type {
  HostRuntimeCandidateReviewTargetV1,
  HostRuntimeCandidateReviewV1,
} from "./candidate-review-evidence.js";
export {
  HOST_RUNTIME_ROUTES,
  sealHostRuntimeComposition,
  parseHostRuntimeComposition,
  type HostRuntimeRoute,
  type HostRuntimeCompositionV1,
} from "./composition.js";
export {
  HOST_RUNTIME_REQUEST_KIND,
  parseHostRuntimeRequest,
  parseHostRuntimeRequestData,
  type HostRuntimeRequestV1,
  type HostRuntimeFrozenInputV1,
  type HostRuntimeReviewEventInputV1,
  type HostRuntimeReviewScopeV1,
  type HostRuntimeReviewScopeAccountingV1,
  type HostRuntimeReviewScopeReason,
  type HostRuntimeReviewScopeTargetReason,
} from "./request.js";
export {
  HOST_RUNTIME_EVENT_KIND,
  parseHostRuntimeProgress,
  type HostRuntimeProgressV1,
} from "./event.js";
export {
  HOST_RUNTIME_TERMINAL_KIND,
  HOSTED_RUN_RECORD_KIND,
  decodeRunEditorialOutcomeV1,
  sealHostRuntimeTerminal,
  parseHostRuntimeTerminal,
  parseHostRuntimeTerminalWire,
  type HostRuntimeTerminalV1,
  type HostRuntimeUnadmittedTerminalV1,
  type HostedRunBindingV1,
  type RunEditorialOutcomeV1,
  type HostEditorialOutcomeAuthorityV1,
  type HostedRunRecordV1,
} from "./terminal.js";
export {
  HOST_RUNTIME_SEMANTIC_MERGE_INTENTS,
  HOST_RUNTIME_SEMANTIC_SUGGESTIONS,
  HOST_RUNTIME_SEMANTIC_SOURCE_KINDS,
  admitHostRuntimeSemanticMergeMessage,
  assertHostRuntimeSemanticData,
  parseHostRuntimeAcceptedEffectAssessmentData,
  parseHostRuntimeAcceptedEffectRevalidationData,
  parseHostRuntimeCorrectiveProposalAssessmentData,
  parseHostRuntimeCorrectiveProposalRevalidationData,
  parseHostRuntimeOwnerInformationRequestData,
  parseHostRuntimeSemanticClaimCoreData,
  parseHostRuntimeSemanticComparisonChunk,
  parseHostRuntimeSemanticComparisonChunkData,
  parseHostRuntimeSemanticComparisonProposal,
  parseHostRuntimeSemanticComparisonProposalData,
  parseHostRuntimeSemanticGatherRequestData,
  qualifyHostRuntimeSemanticComparisonSources,
  sealHostRuntimeSemanticComparisonChunk,
  semanticAcceptedEffectFacets,
  semanticComparisonSourceProofInputs,
  type HostRuntimeAcceptedEffectAssessmentV1,
  type HostRuntimeAcceptedEffectClaim,
  type HostRuntimeAcceptedEffectFacet,
  type HostRuntimeAcceptedEffectRevalidation,
  type HostRuntimeAcceptedEffectRevalidationV1,
  type HostRuntimeAcceptedEffectRevalidationV2,
  type HostRuntimeAcceptedEffectRevalidationV3,
  type HostRuntimeCorrectiveProposalAssessmentV1,
  type HostRuntimeCorrectiveProposalRevalidationV1,
  type HostRuntimeOwnerInformationRequestV1,
  type HostRuntimeSemanticCitationV1,
  type HostRuntimeSemanticComparisonChunkV1,
  type HostRuntimeSemanticComparisonProposalV1,
  type HostRuntimeSemanticGatherRequestV1,
  type HostRuntimeSemanticMergeIntent,
  type HostRuntimeSemanticProposalOptions,
  type HostRuntimeSemanticSuggestion,
  type HostRuntimeSemanticMergeMessageV1,
  type HostRuntimeSemanticRepositoryRole,
} from "./semantic-comparison.js";

/** Source-bound projection records and pure byte carriers shared with the host. */
export {
  PRODUCT_REFERENCE_MODEL_TARGET_ID,
  parseSemanticDocumentTargets,
  parseSemanticDocumentProjection,
  bindSemanticDocumentProjection,
  semanticDocumentPolicySha256,
  semanticDocumentByteRanges,
  type SemanticDocumentTargets,
  type SemanticDocumentProjection,
} from "./semantic-document-projection.js";

// Shared semantic wire capacity for the host producer and installed worker.
export {
  SEMANTIC_INPUT_CAPACITY,
  hostedRequestMaximumBytes,
  semanticComparisonEvidenceBudget,
} from "../live-agent/input-capacity.js";
