// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RepositoryIdentity } from "../../content-ir/contracts.js";
import type {
  RoadmapLedger,
  RoadmapProjectIdentity,
  RoadmapTrackerObservation,
} from "../contracts/ledger.js";
import type { RoadmapLedgerReference, RoadmapOperationKind } from "../contracts/mutation.js";
import type { RoadmapAttemptDisposition } from "../contracts/receipt.js";

export const ROADMAP_EXECUTION_SCHEMA_VERSION = 2 as const;

export const ROADMAP_EFFECT_KINDS = ["issue", "note", "link", "milestone"] as const;
export type RoadmapEffectKind = (typeof ROADMAP_EFFECT_KINDS)[number];

export type RoadmapMutationIntentV2 =
  | "create"
  | "update"
  | "comment"
  | "link"
  | "assign-label"
  | "assign-milestone"
  | "close"
  | "reopen";

export interface RoadmapMutationProposalV2 {
  kind: RoadmapOperationKind;
  intent: RoadmapMutationIntentV2;
  effectKind: RoadmapEffectKind;
}

export type RoadmapMutationTargetV2 =
  | { source: "project"; targetKey: string }
  | { source: "ledger-observation"; targetKey: string }
  | { source: "dependency-result"; operationKey: string; effectKind: RoadmapEffectKind };

export type RoadmapMutationPreconditionV2 =
  | {
      source: "ledger-observation";
      targetKey: string;
      observedAt: string;
      identityDigest: string;
    }
  | {
      source: "dependency-result";
      operationKey: string;
      effectKind: RoadmapEffectKind;
    };

export interface RoadmapMutationOperationV2 {
  key: string;
  kind: RoadmapOperationKind;
  findingIds: string[];
  dependsOnOperationKeys: string[];
  target: RoadmapMutationTargetV2;
  relatedTarget?: RoadmapMutationTargetV2;
  preconditions: RoadmapMutationPreconditionV2[];
  proposal: RoadmapMutationProposalV2;
  proposalDigest: string;
  materialDigest: string;
  materialBytes: number;
  expectedEffectKind: RoadmapEffectKind;
  idempotencyKey: string;
}

export interface RoadmapMutationPlanV2 {
  kind: "roadmap-mutation-plan";
  schemaVersion: typeof ROADMAP_EXECUTION_SCHEMA_VERSION;
  id: string;
  ledger: RoadmapLedgerReference;
  repository: RepositoryIdentity;
  project: RoadmapProjectIdentity;
  trackerObservedAt: string;
  operations: RoadmapMutationOperationV2[];
  generatedAt: string;
  expiresAt: string;
  digest: string;
}

export interface RoadmapMutationAuthorizationV2 {
  kind: "roadmap-mutation-authorization";
  schemaVersion: typeof ROADMAP_EXECUTION_SCHEMA_VERSION;
  id: string;
  planDigest: string;
  repository: RepositoryIdentity;
  project: RoadmapProjectIdentity;
  authorizedOperationKeys: string[];
  authority: { kind: "local-user" | "host-policy"; id: string };
  decision: "approved";
  issuedAt: string;
  expiresAt: string;
  digest: string;
}

interface RoadmapEffectIdentityBase {
  kind: RoadmapEffectKind;
  targetKey: string;
  externalId: string;
  updatedAt: string;
  identityDigest: string;
  operationProofDigest?: string;
}

export interface RoadmapIssueEffectIdentity extends RoadmapEffectIdentityBase {
  kind: "issue";
  state: "opened" | "closed";
}

export interface RoadmapNoteEffectIdentity extends RoadmapEffectIdentityBase {
  kind: "note";
  state: "present";
  subjectTargetKey: string;
}

export interface RoadmapLinkEffectIdentity extends RoadmapEffectIdentityBase {
  kind: "link";
  state: "present";
  subjectTargetKey: string;
  relatedTargetKey: string;
}

export interface RoadmapMilestoneEffectIdentity extends RoadmapEffectIdentityBase {
  kind: "milestone";
  state: "active" | "closed";
}

export type RoadmapEffectIdentity =
  | RoadmapIssueEffectIdentity
  | RoadmapNoteEffectIdentity
  | RoadmapLinkEffectIdentity
  | RoadmapMilestoneEffectIdentity;

export type RoadmapMutationAttemptDispositionV2 = RoadmapAttemptDisposition | "ambiguous";

export interface RoadmapMutationAttemptV2 {
  operationKey: string;
  attempt: number;
  idempotencyKey: string;
  phase: "mutation" | "reconciliation";
  disposition: RoadmapMutationAttemptDispositionV2;
  startedAt: string;
  completedAt: string;
  before?: RoadmapEffectIdentity;
  effect?: RoadmapEffectIdentity;
  failureCode?: string;
  reconcilesAttempt?: number;
}

export interface RoadmapMutationReceiptV2 {
  kind: "roadmap-mutation-receipt";
  schemaVersion: typeof ROADMAP_EXECUTION_SCHEMA_VERSION;
  id: string;
  planDigest: string;
  authorizationDigest: string;
  attempts: RoadmapMutationAttemptV2[];
  lastConfirmedOperationKey?: string;
  remainingOperationKeys: string[];
  terminal: "complete" | "partial" | "failed" | "ambiguous";
  createdAt: string;
  updatedAt: string;
  digest: string;
}

export interface RoadmapMutationMaterialEvidenceV2 {
  operationKey: string;
  proposalDigest: string;
  materialDigest: string;
  materialBytes: number;
}

export type RoadmapMutationOperationV2Input = Omit<
  RoadmapMutationOperationV2,
  "proposalDigest" | "idempotencyKey"
>;

export interface RoadmapOperationIdempotencyScopeV2 {
  ledgerDigest: string;
  repository: RepositoryIdentity;
  project: RoadmapProjectIdentity;
}
