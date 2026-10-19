// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  SearchCitationV1,
  SearchDisposition,
  SearchLimitationV1,
  SearchProbeV1,
  SearchSaturationBindingV1,
  SearchTargetV1,
} from "./bounded-search-contracts.js";

export type SearchProgressEventCategory =
  | "evidence-produced"
  | "no-new-evidence"
  | "tool-failure"
  | "authorization-denied"
  | "governance-denied"
  | "unsupported-operation"
  | "governed-asset-defect"
  | "governed-tool-defect";

export type SearchRemainingWorkCategory =
  | "required-probes"
  | "alternative-bounded-probe"
  | "verification"
  | "none";

export type SearchProgressReasonCategory =
  | "blocking-limitation"
  | "declining-yield-saturated"
  | "hard-ceiling"
  | "new-evidence"
  | "new-required-probe-coverage"
  | "positive-match"
  | "repeated-equivalent-zero-yield"
  | "required-probes-complete"
  | "required-probes-remaining"
  | "zero-yield-lease-limit"
  | "execution-denied"
  | "execution-budget-terminal"
  | "workflow-completed";

export interface SearchProgressPolicyV1 {
  schemaVersion: 1;
  kind: "docsfab-search-progress-policy";
  repeatedEquivalentCallLimit: number;
  consecutiveZeroYieldLeaseLimit: number;
  decliningYieldWindow: number;
  policySha256: string;
}

export interface SearchProgressCheckpointBindingV1 {
  leaseNumber: number;
  checkpointSha256: string;
  stateSha256: string;
  identitySha256: string;
  policySha256: string;
}

interface SearchExecutionLeaseCumulativePolicyV1 {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxElapsedMs: number;
  maxKnownCostMicrousd?: number;
}

interface SearchExecutionLeasePolicyV1 {
  schemaVersion: 1;
  kind: "docsfab-execution-lease-policy";
  callsPerLease: number;
  maxLeases: number;
  hardToolCallCeiling: number;
  maxProviderTurns: number;
  maxCompactions: number;
  cumulative: SearchExecutionLeaseCumulativePolicyV1;
  policySha256: string;
}

interface SearchExecutionLeaseIdentityV1 {
  schemaVersion: 1;
  kind: "docsfab-execution-lease-identity";
  inferenceAttempt: number;
  retriesConsumed: number;
  authorizationSha256: string | null;
  repositoryRevision: string;
  contextPacketSha256: string | null;
  evidenceSha256: string;
  toolPolicySha256: string;
  contextAuthoritySha256: string;
  policySha256: string;
  identitySha256: string;
}

interface SearchExecutionToolCallCountersV1 {
  requested: number;
  executed: number;
  succeeded: number;
  failed: number;
  denied: number;
  governanceBlocked: number;
}

type SearchExecutionCostStateV1 =
  | { status: "known"; microusd: number }
  | { status: "unavailable"; reason: "pricing-unknown" | "pricing-stale" };

interface SearchExecutionLeaseStateV1 {
  schemaVersion: 1;
  kind: "docsfab-execution-lease-state";
  leaseNumber: number;
  leaseExecutedToolCalls: number;
  providerTurns: number;
  compactions: number;
  toolCalls: SearchExecutionToolCallCountersV1;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  elapsedMs: number;
  cost: SearchExecutionCostStateV1;
  lastCheckpointSha256: string | null;
  stateSha256: string;
}

type SearchExecutionCheckpointReason =
  | "lease-exhausted"
  | "budget-boundary"
  | "host-requested"
  | "provider-requested"
  | "workflow-completed";

interface SearchExecutionCheckpointV1 {
  schemaVersion: 1;
  kind: "docsfab-execution-checkpoint";
  sequence: number;
  reason: SearchExecutionCheckpointReason;
  identitySha256: string;
  policySha256: string;
  previousCheckpointSha256: string | null;
  state: SearchExecutionLeaseStateV1;
  checkpointSha256: string;
}

type SearchExecutionStopReason =
  | "security-denied"
  | "authorization-denied"
  | "cancellation-requested"
  | "evidence-preservation-required"
  | "context-exhausted"
  | "hard-tool-call-ceiling"
  | "cumulative-input-limit"
  | "cumulative-output-limit"
  | "output-authority-exhausted"
  | "cumulative-time-limit"
  | "cost-unavailable"
  | "cumulative-cost-limit"
  | "provider-turn-limit"
  | "lease-limit"
  | "checkpoint-not-renewable"
  | "provider-terminal"
  | "provider-unavailable";

interface SearchExecutionLeaseGrantV1 {
  schemaVersion: 1;
  kind: "docsfab-execution-lease-decision";
  decision: "granted";
  leaseNumber: number;
  grantedToolCalls: number;
  remainingProviderTurns: number;
  remainingInputTokens: number;
  remainingOutputTokens: number;
  remainingElapsedMs: number;
  remainingKnownCostMicrousd?: number;
  identitySha256: string;
  policySha256: string;
  checkpointSha256: string;
  consideredStopReasons: [];
  decisionSha256: string;
}

interface SearchExecutionLeaseDenialV1 {
  schemaVersion: 1;
  kind: "docsfab-execution-lease-decision";
  decision: "denied";
  leaseNumber: number;
  reason: SearchExecutionStopReason;
  identitySha256: string;
  policySha256: string;
  checkpointSha256: string;
  consideredStopReasons: SearchExecutionStopReason[];
  decisionSha256: string;
}

type SearchExecutionLeaseDecisionV1 = SearchExecutionLeaseGrantV1 | SearchExecutionLeaseDenialV1;

export interface SearchProgressExecutionAuthorityV1 {
  schemaVersion: 1;
  kind: "docsfab-search-progress-execution-authority";
  policy: SearchExecutionLeasePolicyV1;
  identity: SearchExecutionLeaseIdentityV1;
  checkpoints: SearchExecutionCheckpointV1[];
  decisions: SearchExecutionLeaseDecisionV1[];
  authoritySha256: string;
}

export interface SearchProgressEventV1 {
  schemaVersion: 1;
  kind: "docsfab-search-progress-event";
  sequence: number;
  category: SearchProgressEventCategory;
  operationSha256: string;
  probeId: string | null;
  probeSha256: string | null;
  evidenceSha256: string | null;
  limitationSha256: string | null;
  citations: SearchCitationV1[];
  eventSha256: string;
}

export interface SearchProgressCategoryCountsV1 {
  evidenceProduced: number;
  noNewEvidence: number;
  toolFailure: number;
  authorizationDenied: number;
  governanceDenied: number;
  unsupportedOperation: number;
  governedAssetDefect: number;
  governedToolDefect: number;
}

export interface SearchProgressObservationV1 {
  schemaVersion: 1;
  kind: "docsfab-search-progress-observation";
  targetSha256: string;
  checkpoint: SearchProgressCheckpointBindingV1;
  previousObservationSha256: string | null;
  events: SearchProgressEventV1[];
  categoryCounts: SearchProgressCategoryCountsV1;
  newUniqueEvidenceCount: number;
  newlyCompletedRequiredProbeIds: string[];
  completedRequiredProbeIds: string[];
  remainingRequiredProbeIds: string[];
  repeatedEquivalentCallCount: number;
  zeroYieldCallCount: number;
  yieldScore: number;
  operationSha256s: string[];
  evidenceSha256s: string[];
  limitationSha256s: string[];
  citations: SearchCitationV1[];
  observationSha256: string;
}

export interface SearchRemainingWorkRationaleV1 {
  schemaVersion: 1;
  kind: "docsfab-search-remaining-work-rationale";
  targetSha256: string;
  authority: "non-authoritative";
  category: SearchRemainingWorkCategory;
  remainingRequiredProbeIds: string[];
  remainingWorkCount: number;
  detailSha256: string;
  citations: SearchCitationV1[];
  rationaleSha256: string;
}

export interface SearchProgressRecommendationV1 {
  schemaVersion: 1;
  kind: "docsfab-search-progress-recommendation";
  targetSha256: string;
  policySha256: string;
  checkpointSha256: string;
  observationSha256: string;
  rationaleSha256: string;
  rationaleAuthority: "non-authoritative";
  renewable: boolean;
  recommendation: "renew" | "stop";
  disposition: SearchDisposition;
  saturation: SearchSaturationBindingV1;
  reasonCategories: SearchProgressReasonCategory[];
  recommendationSha256: string;
}

export interface SearchProgressEvidenceV1 {
  schemaVersion: 1;
  kind: "docsfab-search-progress-evidence";
  policy: SearchProgressPolicyV1;
  execution: SearchProgressExecutionAuthorityV1;
  target: SearchTargetV1;
  probes: SearchProbeV1[];
  limitations: SearchLimitationV1[];
  observations: SearchProgressObservationV1[];
  rationale: SearchRemainingWorkRationaleV1;
  recommendation: SearchProgressRecommendationV1;
  evidenceSha256: string;
}

export interface CreateSearchProgressEventInput {
  sequence: number;
  category: SearchProgressEventCategory;
  operationSha256: string;
  probeId: string | null;
  probeSha256: string | null;
  evidenceSha256: string | null;
  limitationSha256: string | null;
  citations: SearchCitationV1[];
}
