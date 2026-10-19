// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  assertLocalUserPublicationAuthorization,
  assertLocalUserPublicationPlan,
  containsConfiguredCredentialText,
  normalizeDeliveryValidationFailureEvidence,
  type DeliveryValidationFailureEvidence,
  type LocalUserPublicationAuthorizationV1,
  type LocalUserPublicationPlan,
  type LocalUserPublicationPlanV1,
  type LocalUserPublicationPlanV2,
  type LocalUserPublicationPlanV3,
} from "./contracts.js";
import type { DocumentationCheckStatus } from "./structural-documentation-validator.js";
import { documentationValidationKit } from "./validation-profile.js";
import {
  object,
  array,
  exact,
  enumeration,
  requireSha,
  token,
  revision,
  positiveInteger,
  timestamp,
  safeId,
  safeHost,
  safeProject,
  branch,
  safeUrl,
  sha256,
  requireCondition,
  freeze,
  ScmDeliveryContractError,
} from "./receipt/shape-primitives.js";
export { ScmDeliveryContractError } from "./receipt/shape-primitives.js";
import { validateScmDeliveryRecordRelations } from "./receipt/record-relations.js";
import { decodeScmDeliveryRecordShape } from "./receipt/record-codecs.js";
import {
  advanceLink,
  attempt,
  canonicalMergeRequestUrl,
  commitEvidence,
  deliveryValidationFailureEvidence,
  evidence,
  failure,
  mergeRequestEvidence,
  matchesMergeRequest,
  matchesObservedMergeRequest,
  observation,
  optionalDocumentationValidationEvidence,
  preparedEvidence,
  pushEvidence,
  recovery,
  validationEvidence,
} from "./receipt/record-codecs.js";
export { canonicalMergeRequestUrl } from "./receipt/record-codecs.js";

import {
  SCM_DELIVERY_DISPOSITIONS,
  SCM_DELIVERY_FAILURE_CODES,
  SCM_DELIVERY_NEXT_ACTIONS,
  SCM_DELIVERY_STATES,
  SCM_RECONCILIATION_DECISIONS,
} from "./receipt/schema.js";
import type {
  ScmDeliveryDisposition,
  ScmDeliveryFailureCode,
  ScmDeliveryNextAction,
  ScmDeliveryState,
  ScmReconciliationDecision,
} from "./receipt/schema.js";
export {
  SCM_DELIVERY_DISPOSITIONS,
  SCM_DELIVERY_FAILURE_CODES,
  SCM_DELIVERY_NEXT_ACTIONS,
  SCM_DELIVERY_STATES,
  SCM_RECONCILIATION_DECISIONS,
};
export type {
  ScmDeliveryDisposition,
  ScmDeliveryFailureCode,
  ScmDeliveryNextAction,
  ScmDeliveryState,
  ScmReconciliationDecision,
} from "./receipt/schema.js";

export interface ScmDeliveryPreparedEvidence {
  workspaceKey: string;
  baseRevision: string;
}

export interface ScmDeliveryValidationEvidence {
  commandSha256: string;
  summarySha256: string;
  checkCount: number;
  profileId?: string;
  profileVersion?: string;
  checkIds?: string[];
  selectorInputSha256?: string;
  validatorIdentity?: string;
  candidateTreeSha256?: string;
  checkSetSha256?: string;
  applicabilitySha256?: string;
  backendIdentity?: string;
  resultSha256?: string;
  results?: readonly { id: string; status: DocumentationCheckStatus }[];
}

/** Project only the verified ready-attestation validation evidence into a receipt transition. */
export function validationEvidenceFromReadyAttestation(validation: {
  commandSha256: string;
  stateSha256: string;
  profileId?: string;
  profileVersion?: string;
  checkIds?: readonly string[];
  selectorInputSha256?: string;
  validatorIdentity?: string;
  candidateTreeSha256?: string;
  checkSetSha256?: string;
  applicabilitySha256?: string;
  backendIdentity?: string;
  resultSha256?: string;
  results?: readonly { id: string; status: DocumentationCheckStatus }[];
}): ScmDeliveryValidationEvidence {
  return {
    commandSha256: validation.commandSha256,
    summarySha256: validation.stateSha256,
    checkCount: validation.checkIds?.length ?? 1,
    ...(validation.profileId === undefined ? {} : { profileId: validation.profileId }),
    ...(validation.profileVersion === undefined
      ? {}
      : { profileVersion: validation.profileVersion }),
    ...(validation.checkIds === undefined ? {} : { checkIds: [...validation.checkIds] }),
    ...(validation.selectorInputSha256 === undefined
      ? {}
      : { selectorInputSha256: validation.selectorInputSha256 }),
    ...(validation.validatorIdentity === undefined
      ? {}
      : { validatorIdentity: validation.validatorIdentity }),
    ...(validation.candidateTreeSha256 === undefined
      ? {}
      : { candidateTreeSha256: validation.candidateTreeSha256 }),
    ...(validation.checkSetSha256 === undefined
      ? {}
      : { checkSetSha256: validation.checkSetSha256 }),
    ...(validation.applicabilitySha256 === undefined
      ? {}
      : { applicabilitySha256: validation.applicabilitySha256 }),
    ...(validation.backendIdentity === undefined
      ? {}
      : { backendIdentity: validation.backendIdentity }),
    ...(validation.resultSha256 === undefined ? {} : { resultSha256: validation.resultSha256 }),
    ...(validation.results === undefined
      ? {}
      : {
          results: validation.results.map((result) => ({
            id: result.id,
            status: result.status,
          })),
        }),
  };
}

export interface ScmDeliveryCommitEvidence {
  sha: string;
}

export interface ScmDeliveryPushEvidence {
  remoteRevision: string;
}

export interface ScmDeliveryMergeRequestEvidence {
  iid: number;
  url: string;
  state: "opened";
  draft: true;
  sourceBranch: string;
  targetBranch: string;
  headRevision: string;
}

export interface ScmDeliveryEvidence {
  prepared?: ScmDeliveryPreparedEvidence;
  validation?: ScmDeliveryValidationEvidence;
  commit?: ScmDeliveryCommitEvidence;
  push?: ScmDeliveryPushEvidence;
  mergeRequest?: ScmDeliveryMergeRequestEvidence;
}

export interface ScmDeliveryFailure {
  code: ScmDeliveryFailureCode;
  lastConfirmedState: ScmDeliveryState;
  nextAction: ScmDeliveryNextAction;
  at: string;
  validation?: DeliveryValidationFailureEvidence;
}

export interface ScmDeliveryRecovery {
  mode: "patch-only";
  reasonCode:
    | "operator-requested"
    | "authentication-unavailable"
    | "external-drift"
    | "validation-failed";
  patchSha256: string;
  preserved: true;
  nextAction: "review-preserved-patch";
  at: string;
}

export interface ScmDeliveryAttempt {
  sequence: number;
  id: string;
  source: "executed" | "host-policy";
  outcome: "confirmed" | "failed" | "recovered";
  fromState: ScmDeliveryState;
  toState: ScmDeliveryState;
  at: string;
  evidenceSha256?: string;
  failureCode?: ScmDeliveryFailureCode;
  /** Exact retry workspace for validator-issued failure evidence. */
  workspaceKey?: string;
}

export interface ScmDeliveryRecordV1 {
  schemaVersion: 1;
  kind: "docsfab-scm-delivery-record";
  deliveryMode: "local-user";
  idempotencyKey: string;
  planSha256: string;
  authorization: {
    kind: "docsfab-scm-publication-authorization";
    provider: "gitlab" | "github";
    planSha256: string;
  };
  run: {
    id: string;
    recordSha256: string;
  };
  repository: {
    provider: "gitlab" | "github";
    projectId: number;
    host: string;
    path: string;
    remoteName: string;
    remoteTransport: "ssh" | "https";
  };
  baseRevision: string;
  sourceBranch: string;
  targetBranch: string;
  patch: {
    sha256: string;
    byteLength: number;
    changedFileCount: number;
    preserved: true;
  };
  state: ScmDeliveryState;
  disposition: ScmDeliveryDisposition;
  evidence: ScmDeliveryEvidence;
  attempts: ScmDeliveryAttempt[];
  failure?: ScmDeliveryFailure;
  recovery?: ScmDeliveryRecovery;
  createdAt: string;
  updatedAt: string;
  sha256: string;
}

export interface ScmDeliveryRecordV2 extends Omit<ScmDeliveryRecordV1, "schemaVersion"> {
  schemaVersion: 2;
}

/** The revision chain link an advance receipt carries; its key binds the first two fields. */
export interface ScmDeliveryAdvanceLink {
  parentReceiptSha256: string;
  previousHead: string;
  parentIdempotencyKey: string;
  ordinal: number;
  mergeRequestIid: number;
}

export interface ScmDeliveryRecordV3 extends Omit<ScmDeliveryRecordV1, "schemaVersion"> {
  schemaVersion: 3;
  advance: ScmDeliveryAdvanceLink;
}

export type ScmDeliveryRecord = ScmDeliveryRecordV1 | ScmDeliveryRecordV2 | ScmDeliveryRecordV3;

export type ScmDeliveryProgressInput =
  | {
      toState: "prepared";
      source: "executed";
      at: string;
      evidence: ScmDeliveryPreparedEvidence;
    }
  | {
      toState: "validated";
      source: "executed";
      at: string;
      evidence: ScmDeliveryValidationEvidence;
    }
  | {
      toState: "committed";
      source: "executed";
      at: string;
      evidence: ScmDeliveryCommitEvidence;
    }
  | {
      toState: "pushed";
      source: "executed";
      at: string;
      evidence: ScmDeliveryPushEvidence;
    }
  | {
      toState: "opened";
      source: "executed";
      at: string;
      evidence: ScmDeliveryMergeRequestEvidence;
    };

export interface ScmDeliveryObservationV1 {
  schemaVersion: 1;
  kind: "docsfab-scm-delivery-observation";
  idempotencyKey: string;
  planSha256: string;
  authentication: "available" | "unavailable" | "revoked";
  worktree: "absent" | "matching" | "conflict";
  validation: "unknown" | "passed" | "failed";
  localCommit: { status: "absent" } | { status: "matching" | "conflict"; revision: string };
  remoteBranch:
    | { status: "absent" | "deleted" }
    | { status: "matching" | "conflict"; revision: string };
  mergeRequest:
    | { status: "absent" }
    | {
        status: "opened" | "closed" | "merged" | "conflict";
        iid: number;
        url: string;
        draft: true;
        sourceBranch: string;
        targetBranch: string;
        headRevision: string;
      };
}

export interface ScmDeliveryReconciliationV1 {
  schemaVersion: 1;
  kind: "docsfab-scm-delivery-reconciliation";
  idempotencyKey: string;
  recordSha256: string;
  observationSha256: string;
  decision: ScmReconciliationDecision;
  lastConfirmedState: ScmDeliveryState;
  nextAction: ScmDeliveryNextAction;
  failureCode?: ScmDeliveryFailureCode;
  sha256: string;
}

export interface ScmDeliveryObservationConfirmationV1 {
  schemaVersion: 1;
  kind: "docsfab-scm-delivery-observation-confirmation";
  recordSha256: string;
  observationSha256: string;
  reconciliationSha256: string;
}

/** Host-issued observation confirmations are ephemeral capabilities, never durable authority. */
const issuedObservationConfirmations = new WeakSet<object>();

export interface ScmDeliveryReplayEvidence {
  observation: ScmDeliveryObservationV1;
  confirmation: ScmDeliveryObservationConfirmationV1;
}

export interface ScmPublishedTerminalCapability {
  schemaVersion: 1;
  kind: "docsfab-scm-published-terminal-capability";
  recordSha256: string;
  planSha256: string;
}

export interface ScmPublishedTerminalEvidence {
  idempotencyKey: string;
  recordSha256: string;
  planSha256: string;
  run: { id: string; recordSha256: string };
  patch: { sha256: string; byteLength: number; changedFileCount: number };
  repository: {
    provider: "gitlab" | "github";
    projectId: number;
    host: string;
    path: string;
    remoteName: string;
    remoteTransport: "ssh" | "https";
  };
  baseRevision: string;
  sourceBranch: string;
  targetBranch: string;
  commitRevision: string;
  remoteRevision: string;
  mergeRequest: ScmDeliveryMergeRequestEvidence;
}

const issuedPublishedTerminalCapabilities = new WeakMap<object, ScmPublishedTerminalEvidence>();

const STATE_RANK = new Map(SCM_DELIVERY_STATES.map((state, index) => [state, index]));
const NEXT_STATE: Record<ScmDeliveryState, ScmDeliveryState | undefined> = {
  planned: "prepared",
  prepared: "validated",
  validated: "committed",
  committed: "pushed",
  pushed: "opened",
  opened: undefined,
};
const FAILURE_ACTION: Record<ScmDeliveryFailureCode, ScmDeliveryNextAction> = {
  "prepare-failed": "review-worktree",
  "validation-failed": "fix-validation",
  "validation-isolation-unavailable": "configure-validation-isolation",
  "commit-failed": "retry-commit",
  "push-failed": "retry-push",
  "merge-request-open-failed": "retry-open-draft-merge-request",
  "authentication-unavailable": "restore-authentication",
  "authentication-revoked": "restore-authentication",
  "remote-drift": "reconcile-external-state",
  "remote-branch-deleted": "restore-remote-branch",
  "merge-request-closed": "review-closed-merge-request",
  "merge-request-changed": "reconcile-external-state",
  "receipt-drift": "review-preserved-patch",
  "revision-mr-not-open": "reconcile-external-state",
  "git-identity-drift": "restore-git-identity",
  "git-configuration-refused": "remove-unsafe-git-configuration",
  "git-checkout-unverified": "repair-git-checkout",
};
/** The next action a receipt records for a failure code, for a failure reported without persisting it. */
export function scmDeliveryFailureNextAction(code: ScmDeliveryFailureCode): ScmDeliveryNextAction {
  return FAILURE_ACTION[code];
}
const PHASE_FAILURE_STATE: Partial<Record<ScmDeliveryFailureCode, ScmDeliveryState>> = {
  "prepare-failed": "planned",
  "validation-failed": "prepared",
  "validation-isolation-unavailable": "prepared",
  "commit-failed": "validated",
  "push-failed": "committed",
  "merge-request-open-failed": "pushed",
};

export function scmDeliveryIdempotencyKey(plan: LocalUserPublicationPlan): string {
  assertLocalUserPublicationPlan(plan);
  return scmDeliveryIdentityKey({
    provider: "gitlab",
    run: plan.run,
    repository: {
      projectId: plan.project.id,
      host: plan.project.host,
      path: plan.project.path,
    },
    baseRevision: plan.baseRevision,
    targetBranch: plan.targetBranch.name,
    patchSha256: plan.patch.sha256,
    ...(plan.schemaVersion === 3 ? { advance: advanceLinkFromPlan(plan) } : {}),
  });
}

export function scmDeliveryIdentityKey(input: {
  provider: "gitlab" | "github";
  run: { id: string; recordSha256: string };
  repository: { projectId: number; host: string; path: string };
  baseRevision: string;
  targetBranch: string;
  patchSha256: string;
  advance?: Pick<ScmDeliveryAdvanceLink, "parentReceiptSha256" | "previousHead">;
}): string {
  // The optional source-branch choice is plan-bound but deliberately omitted:
  // changing it on retry must collide with the existing delivery, not fork it.
  // An advance also binds the head it chains from and the parent receipt, so
  // two advances of one branch never share a delivery.
  return sha256({
    schemaVersion: 1,
    provider: input.provider,
    run: input.run,
    project: input.repository,
    baseRevision: input.baseRevision,
    targetBranch: input.targetBranch,
    patchSha256: input.patchSha256,
    ...(input.advance === undefined
      ? {}
      : {
          advance: {
            parentReceiptSha256: input.advance.parentReceiptSha256,
            previousHead: input.advance.previousHead,
          },
        }),
  });
}

/** The chain link a V3 plan binds into its receipt. */
export function advanceLinkFromPlan(plan: LocalUserPublicationPlanV3): ScmDeliveryAdvanceLink {
  return {
    parentReceiptSha256: plan.advance.parent.deliveryReceiptSha256,
    previousHead: plan.advance.lastRecordedHead,
    parentIdempotencyKey: plan.advance.parent.idempotencyKey,
    ordinal: plan.advance.ordinal,
    mergeRequestIid: plan.advance.mergeRequest.iid,
  };
}

export function scmDeliveryAttemptId(idempotencyKey: string, sequence: number): string {
  requireSha(idempotencyKey, "$.idempotencyKey");
  positiveInteger(sequence, "$.sequence");
  return sha256({ schemaVersion: 1, idempotencyKey, sequence });
}

export function scmDeliveryRecordSha256(
  recordValue: Omit<ScmDeliveryRecord, "sha256"> | ScmDeliveryRecord,
): string {
  const { sha256: _sha256, ...digestible } = recordValue as ScmDeliveryRecord;
  return sha256(digestible);
}

export function createScmDeliveryRecord(input: {
  plan: LocalUserPublicationPlanV1;
  authorization: LocalUserPublicationAuthorizationV1;
  createdAt: string;
}): ScmDeliveryRecordV1;
export function createScmDeliveryRecord(input: {
  plan: LocalUserPublicationPlanV2;
  authorization: LocalUserPublicationAuthorizationV1;
  createdAt: string;
}): ScmDeliveryRecordV2;
export function createScmDeliveryRecord(input: {
  plan: LocalUserPublicationPlanV3;
  authorization: LocalUserPublicationAuthorizationV1;
  createdAt: string;
}): ScmDeliveryRecordV3;
export function createScmDeliveryRecord(input: {
  plan: LocalUserPublicationPlan;
  authorization: LocalUserPublicationAuthorizationV1;
  createdAt: string;
}): ScmDeliveryRecord;
export function createScmDeliveryRecord(input: {
  plan: LocalUserPublicationPlan;
  authorization: LocalUserPublicationAuthorizationV1;
  createdAt: string;
}): ScmDeliveryRecord {
  assertScmDeliveryInputs(input);
  const createdAt = timestamp(input.createdAt, "$.createdAt");
  const candidate = {
    schemaVersion: input.plan.schemaVersion,
    kind: "docsfab-scm-delivery-record",
    deliveryMode: "local-user",
    idempotencyKey: scmDeliveryIdempotencyKey(input.plan),
    planSha256: input.plan.sha256,
    authorization: {
      kind: "docsfab-scm-publication-authorization",
      provider: "gitlab",
      planSha256: input.authorization.planSha256,
    },
    run: { ...input.plan.run },
    repository: {
      provider: "gitlab",
      projectId: input.plan.project.id,
      host: input.plan.project.host,
      path: input.plan.project.path,
      remoteName: input.plan.remote.name,
      remoteTransport: input.plan.remote.transport,
    },
    baseRevision: input.plan.baseRevision,
    sourceBranch: input.plan.proposedSourceBranch,
    targetBranch: input.plan.targetBranch.name,
    patch: {
      sha256: input.plan.patch.sha256,
      byteLength: input.plan.patch.byteLength,
      changedFileCount: input.plan.patch.changedFileCount,
      preserved: true,
    },
    state: "planned",
    disposition: "active",
    evidence: {},
    attempts: [],
    createdAt,
    updatedAt: createdAt,
    ...(input.plan.schemaVersion === 3 ? { advance: advanceLinkFromPlan(input.plan) } : {}),
    sha256: "0".repeat(64),
  } as ScmDeliveryRecord;
  candidate.sha256 = scmDeliveryRecordSha256(candidate);
  return assertScmDeliveryRecord(candidate, input.plan);
}

export function recordScmDeliveryProgress(
  recordValue: ScmDeliveryRecordV1,
  input: ScmDeliveryProgressInput,
  plan: LocalUserPublicationPlanV1,
  authorization?: LocalUserPublicationAuthorizationV1,
  replay?: ScmDeliveryReplayEvidence,
): ScmDeliveryRecordV1;
export function recordScmDeliveryProgress(
  recordValue: ScmDeliveryRecordV2,
  input: ScmDeliveryProgressInput,
  plan: LocalUserPublicationPlanV2,
  authorization?: LocalUserPublicationAuthorizationV1,
  replay?: ScmDeliveryReplayEvidence,
): ScmDeliveryRecordV2;
export function recordScmDeliveryProgress(
  recordValue: ScmDeliveryRecord,
  input: ScmDeliveryProgressInput,
  plan: LocalUserPublicationPlan,
  authorization?: LocalUserPublicationAuthorizationV1,
  replay?: ScmDeliveryReplayEvidence,
): ScmDeliveryRecord;
export function recordScmDeliveryProgress(
  recordValue: ScmDeliveryRecord,
  input: ScmDeliveryProgressInput,
  plan: LocalUserPublicationPlan,
  authorization?: LocalUserPublicationAuthorizationV1,
  replay?: ScmDeliveryReplayEvidence,
): ScmDeliveryRecord {
  const record = assertScmDeliveryRecord(recordValue, plan);
  requireCondition(input.source === "executed", "invalid-transition", "$.source");
  const at = timestamp(input.at, "$.at");
  const normalizedEvidence = progressEvidence(input, record, plan);
  const evidenceSha256 = sha256(normalizedEvidence);
  requireCondition(authorization !== undefined, "invalid-authorization", "$.authorization");
  assertScmDeliveryMutationAuthorized(record, plan, authorization);
  requireCondition(Date.parse(record.updatedAt) <= Date.parse(at), "invalid-transition", "$.at");
  const prior = record.attempts.find(
    (attempt) => attempt.outcome === "confirmed" && attempt.toState === input.toState,
  );
  if (prior) {
    requireCondition(prior.evidenceSha256 === evidenceSha256, "external-drift", "$.evidence");
    requireCondition(replay !== undefined, "external-drift", "$.replay");
    const reconciliation = assertObservationConfirmation(record, replay, plan);
    const expectedDecision: Record<
      Exclude<ScmDeliveryState, "planned">,
      ScmReconciliationDecision
    > = {
      prepared: "resume-validation",
      validated: "resume-commit",
      committed: "resume-push",
      pushed: "resume-open-merge-request",
      opened: "reuse-opened",
    };
    requireCondition(
      reconciliation.decision === expectedDecision[input.toState],
      "external-drift",
      "$.replay",
    );
    return record;
  }
  requireCondition(
    record.disposition !== "succeeded" && record.disposition !== "recovered",
    "invalid-transition",
    "$.disposition",
  );
  requireCondition(NEXT_STATE[record.state] === input.toState, "invalid-transition", "$.toState");
  const sequence = record.attempts.length + 1;
  const evidence = {
    ...record.evidence,
    [evidenceField(input.toState)]: normalizedEvidence,
  };
  const attempt: ScmDeliveryAttempt = {
    sequence,
    id: scmDeliveryAttemptId(record.idempotencyKey, sequence),
    source: input.source,
    outcome: "confirmed",
    fromState: record.state,
    toState: input.toState,
    at,
    evidenceSha256,
  };
  return rebuildRecord(
    record,
    {
      state: input.toState,
      disposition: input.toState === "opened" ? "succeeded" : "active",
      evidence,
      attempts: [...record.attempts, attempt],
      failure: undefined,
      recovery: undefined,
      updatedAt: at,
    },
    plan,
  );
}

export function assertScmDeliveryMutationAuthorized(
  recordValue: ScmDeliveryRecordV1,
  plan: LocalUserPublicationPlanV1,
  authorization: LocalUserPublicationAuthorizationV1,
): ScmDeliveryRecordV1;
export function assertScmDeliveryMutationAuthorized(
  recordValue: ScmDeliveryRecordV2,
  plan: LocalUserPublicationPlanV2,
  authorization: LocalUserPublicationAuthorizationV1,
): ScmDeliveryRecordV2;
export function assertScmDeliveryMutationAuthorized(
  recordValue: ScmDeliveryRecord,
  plan: LocalUserPublicationPlan,
  authorization: LocalUserPublicationAuthorizationV1,
): ScmDeliveryRecord;
export function assertScmDeliveryMutationAuthorized(
  recordValue: ScmDeliveryRecord,
  plan: LocalUserPublicationPlan,
  authorization: LocalUserPublicationAuthorizationV1,
): ScmDeliveryRecord {
  const record = assertScmDeliveryRecord(recordValue, plan);
  try {
    assertLocalUserPublicationAuthorization(authorization, plan);
  } catch {
    throw new ScmDeliveryContractError("invalid-authorization", "$.authorization");
  }
  requireCondition(
    record.authorization.provider === "gitlab" &&
      record.authorization.planSha256 === authorization.planSha256,
    "invalid-authorization",
    "$.authorization",
  );
  return record;
}

export function failScmDeliveryRecord(
  recordValue: ScmDeliveryRecordV1,
  input: {
    code: ScmDeliveryFailureCode;
    at: string;
    validation?: DeliveryValidationFailureEvidence;
    validationWorkspaceKey?: string;
  },
  plan: LocalUserPublicationPlanV1,
): ScmDeliveryRecordV1;
export function failScmDeliveryRecord(
  recordValue: ScmDeliveryRecordV2,
  input: {
    code: ScmDeliveryFailureCode;
    at: string;
    validation?: DeliveryValidationFailureEvidence;
    validationWorkspaceKey?: string;
  },
  plan: LocalUserPublicationPlanV2,
): ScmDeliveryRecordV2;
export function failScmDeliveryRecord(
  recordValue: ScmDeliveryRecord,
  input: {
    code: ScmDeliveryFailureCode;
    at: string;
    validation?: DeliveryValidationFailureEvidence;
    validationWorkspaceKey?: string;
  },
  plan: LocalUserPublicationPlan,
): ScmDeliveryRecord;
export function failScmDeliveryRecord(
  recordValue: ScmDeliveryRecord,
  input: {
    code: ScmDeliveryFailureCode;
    at: string;
    validation?: DeliveryValidationFailureEvidence;
    validationWorkspaceKey?: string;
  },
  plan: LocalUserPublicationPlan,
): ScmDeliveryRecord {
  const record = assertScmDeliveryRecord(recordValue, plan);
  requireCondition(
    record.disposition !== "succeeded" && record.disposition !== "recovered",
    "invalid-transition",
    "$.disposition",
  );
  const code = enumeration(input.code, SCM_DELIVERY_FAILURE_CODES, "$.code");
  requireCondition(failureAllowedAtState(code, record.state), "invalid-transition", "$.code");
  requireCondition(
    input.validation !== undefined || input.validationWorkspaceKey === undefined,
    "invalid-record",
    "$.validationWorkspaceKey",
  );
  const at = timestamp(input.at, "$.at");
  requireCondition(Date.parse(record.updatedAt) <= Date.parse(at), "invalid-transition", "$.at");
  const validation =
    input.validation === undefined
      ? undefined
      : deliveryValidationFailureEvidence(
          input.validation,
          plan,
          code,
          input.validationWorkspaceKey,
        );
  if (
    record.disposition === "failed" &&
    record.failure?.code === code &&
    (record.failure.validation === undefined
      ? validation === undefined
      : validation !== undefined && sha256(record.failure.validation) === sha256(validation))
  ) {
    return record;
  }
  const sequence = record.attempts.length + 1;
  const failure: ScmDeliveryFailure = {
    code,
    lastConfirmedState: record.state,
    nextAction: FAILURE_ACTION[code],
    at,
    ...(validation === undefined ? {} : { validation }),
  };
  const attempt: ScmDeliveryAttempt = {
    sequence,
    id: scmDeliveryAttemptId(record.idempotencyKey, sequence),
    source: "host-policy",
    outcome: "failed",
    fromState: record.state,
    toState: record.state,
    at,
    failureCode: code,
    ...(failure.validation === undefined ? {} : { evidenceSha256: sha256(failure.validation) }),
    ...(failure.validation?.workspaceKey === undefined
      ? {}
      : { workspaceKey: failure.validation.workspaceKey }),
  };
  return rebuildRecord(
    record,
    {
      disposition: "failed",
      attempts: [...record.attempts, attempt],
      failure,
      recovery: undefined,
      updatedAt: at,
    },
    plan,
  );
}

export function recoverScmDeliveryPatch(
  recordValue: ScmDeliveryRecordV1,
  input: {
    reasonCode: ScmDeliveryRecovery["reasonCode"];
    at: string;
    patchBytes: Uint8Array;
  },
  plan: LocalUserPublicationPlanV1,
): ScmDeliveryRecordV1;
export function recoverScmDeliveryPatch(
  recordValue: ScmDeliveryRecordV2,
  input: {
    reasonCode: ScmDeliveryRecovery["reasonCode"];
    at: string;
    patchBytes: Uint8Array;
  },
  plan: LocalUserPublicationPlanV2,
): ScmDeliveryRecordV2;
export function recoverScmDeliveryPatch(
  recordValue: ScmDeliveryRecord,
  input: {
    reasonCode: ScmDeliveryRecovery["reasonCode"];
    at: string;
    patchBytes: Uint8Array;
  },
  plan: LocalUserPublicationPlan,
): ScmDeliveryRecord;
export function recoverScmDeliveryPatch(
  recordValue: ScmDeliveryRecord,
  input: {
    reasonCode: ScmDeliveryRecovery["reasonCode"];
    at: string;
    patchBytes: Uint8Array;
  },
  plan: LocalUserPublicationPlan,
): ScmDeliveryRecord {
  const record = assertScmDeliveryRecord(recordValue, plan);
  requireCondition(record.disposition !== "succeeded", "invalid-transition", "$.disposition");
  requireCondition(
    input.patchBytes instanceof Uint8Array &&
      input.patchBytes.byteLength === record.patch.byteLength &&
      createHash("sha256").update(input.patchBytes).digest("hex") === record.patch.sha256,
    "external-drift",
    "$.patchBytes",
  );
  const at = timestamp(input.at, "$.at");
  requireCondition(Date.parse(record.updatedAt) <= Date.parse(at), "invalid-transition", "$.at");
  const reasonCode = enumeration(
    input.reasonCode,
    [
      "operator-requested",
      "authentication-unavailable",
      "external-drift",
      "validation-failed",
    ] as const,
    "$.reasonCode",
  );
  if (record.disposition === "recovered") {
    requireCondition(
      record.recovery?.reasonCode === reasonCode,
      "invalid-transition",
      "$.reasonCode",
    );
    return record;
  }
  const sequence = record.attempts.length + 1;
  const recovery: ScmDeliveryRecovery = {
    mode: "patch-only",
    reasonCode,
    patchSha256: record.patch.sha256,
    preserved: true,
    nextAction: "review-preserved-patch",
    at,
  };
  const attempt: ScmDeliveryAttempt = {
    sequence,
    id: scmDeliveryAttemptId(record.idempotencyKey, sequence),
    source: "host-policy",
    outcome: "recovered",
    fromState: record.state,
    toState: record.state,
    at,
    evidenceSha256: sha256(recovery),
  };
  return rebuildRecord(
    record,
    {
      disposition: "recovered",
      attempts: [...record.attempts, attempt],
      failure: undefined,
      recovery,
      updatedAt: at,
    },
    plan,
  );
}

export function reconcileScmDelivery(
  recordValue: ScmDeliveryRecord,
  observationValue: ScmDeliveryObservationV1,
  plan: LocalUserPublicationPlan,
): ScmDeliveryReconciliationV1 {
  const record = assertScmDeliveryRecord(recordValue, plan);
  const observed = observation(observationValue, record);
  const observationSha256 = sha256(observed);
  let decision: ScmReconciliationDecision;
  const lastConfirmedState = record.state;
  let nextAction: ScmDeliveryNextAction;
  let failureCode: ScmDeliveryFailureCode | undefined;

  const blocked = (code: ScmDeliveryFailureCode, action = FAILURE_ACTION[code]): void => {
    decision = "blocked";
    nextAction = action;
    failureCode = code;
  };

  if (record.disposition === "recovered") {
    decision = "recover-patch-only";
    nextAction = "review-preserved-patch";
  } else if (
    record.disposition === "failed" &&
    record.failure?.code === "validation-isolation-unavailable"
  ) {
    blocked("validation-isolation-unavailable");
  } else if (observed.authentication !== "available") {
    failureCode =
      observed.authentication === "revoked"
        ? "authentication-revoked"
        : "authentication-unavailable";
    if (record.disposition === "succeeded") {
      decision = "blocked";
      nextAction = "restore-authentication";
    } else {
      decision = "recover-patch-only";
      nextAction = "review-preserved-patch";
    }
  } else if (record.schemaVersion === 3) {
    const advanced = reconcileAdvance(record, observed);
    decision = advanced.decision;
    nextAction = advanced.nextAction;
    failureCode = advanced.failureCode;
  } else if (observed.mergeRequest.status === "conflict") {
    blocked("merge-request-changed");
  } else if (
    observed.worktree === "conflict" ||
    observed.localCommit.status === "conflict" ||
    observed.remoteBranch.status === "conflict"
  ) {
    blocked("remote-drift");
  } else if (
    STATE_RANK.get(record.state)! >= STATE_RANK.get("prepared")! &&
    observed.worktree === "matching" &&
    observed.validation === "failed"
  ) {
    blocked("validation-failed");
  } else if (
    record.disposition === "failed" &&
    record.failure?.code === "validation-failed" &&
    observed.worktree === "matching" &&
    observed.validation !== "passed"
  ) {
    blocked("validation-failed");
  } else if (
    STATE_RANK.get(record.state)! >= STATE_RANK.get("committed")! &&
    (observed.localCommit.status !== "matching" ||
      observed.localCommit.revision !== record.evidence.commit?.sha)
  ) {
    blocked("receipt-drift");
  } else if (
    STATE_RANK.get(record.state)! >= STATE_RANK.get("committed")! &&
    observed.remoteBranch.status === "deleted"
  ) {
    blocked(observed.localCommit.status === "matching" ? "remote-branch-deleted" : "receipt-drift");
  } else if (
    STATE_RANK.get(record.state)! >= STATE_RANK.get("pushed")! &&
    (observed.remoteBranch.status !== "matching" ||
      observed.remoteBranch.revision !== record.evidence.push?.remoteRevision)
  ) {
    blocked("receipt-drift");
  } else if (
    observed.mergeRequest.status !== "absent" &&
    !matchesObservedMergeRequest(observed.mergeRequest, record, observed)
  ) {
    blocked("merge-request-changed");
  } else if (observed.mergeRequest.status === "closed") {
    blocked("merge-request-closed");
  } else if (observed.mergeRequest.status === "merged") {
    blocked("merge-request-changed");
  } else if (
    observed.mergeRequest.status !== "absent" &&
    observed.remoteBranch.status !== "matching"
  ) {
    blocked("merge-request-changed");
  } else if (
    observed.remoteBranch.status === "matching" &&
    (observed.localCommit.status !== "matching" ||
      observed.remoteBranch.revision !== observed.localCommit.revision)
  ) {
    blocked("remote-drift");
  } else if (record.state === "opened") {
    const mergeRequest = observed.mergeRequest;
    if (mergeRequest.status === "opened") {
      decision = "reuse-opened";
      nextAction = "none";
    } else {
      blocked("receipt-drift");
    }
  } else {
    switch (record.state) {
      case "planned":
        decision = "resume-prepare";
        nextAction = "prepare-worktree";
        break;
      case "prepared":
        decision = observed.worktree === "matching" ? "resume-validation" : "resume-prepare";
        nextAction = observed.worktree === "matching" ? "run-validation" : "prepare-worktree";
        break;
      case "validated":
        if (observed.worktree !== "matching") {
          decision = "resume-prepare";
          nextAction = "prepare-worktree";
        } else if (observed.validation !== "passed") {
          decision = "resume-validation";
          nextAction = "run-validation";
        } else {
          decision = "resume-commit";
          nextAction = "create-commit";
        }
        break;
      case "committed":
        decision = "resume-push";
        nextAction = "push-branch";
        break;
      case "pushed":
        decision = "resume-open-merge-request";
        nextAction = "open-draft-merge-request";
        break;
    }
  }

  const result: Omit<ScmDeliveryReconciliationV1, "sha256"> = {
    schemaVersion: 1,
    kind: "docsfab-scm-delivery-reconciliation",
    idempotencyKey: record.idempotencyKey,
    recordSha256: record.sha256,
    observationSha256,
    decision: decision!,
    lastConfirmedState,
    nextAction: nextAction!,
    ...(failureCode === undefined ? {} : { failureCode }),
  };
  return freeze({ ...result, sha256: sha256(result) });
}

/**
 * Reconcile an advance receipt. The branch and MR already exist, so before the
 * push both name the observed head the lease expects, and after it the child
 * commit. An MR head still at the observed head after the push is a pending
 * GitLab refresh, not drift, until the receipt records the MR as opened.
 */
function reconcileAdvance(
  record: ScmDeliveryRecordV3,
  observed: ScmDeliveryObservationV1,
): Pick<ScmDeliveryReconciliationV1, "decision" | "nextAction" | "failureCode"> {
  const blocked = (
    code: ScmDeliveryFailureCode,
  ): Pick<ScmDeliveryReconciliationV1, "decision" | "nextAction" | "failureCode"> => ({
    decision: "blocked",
    nextAction: FAILURE_ACTION[code],
    failureCode: code,
  });
  const rank = STATE_RANK.get(record.state)!;
  const base = record.baseRevision;
  const commit = record.evidence.commit?.sha;
  if (observed.worktree === "conflict" || observed.localCommit.status === "conflict") {
    return blocked("remote-drift");
  }
  if (
    rank >= STATE_RANK.get("committed")! &&
    (observed.localCommit.status !== "matching" || observed.localCommit.revision !== commit)
  ) {
    return blocked("receipt-drift");
  }
  const remote = observed.remoteBranch;
  const remoteRevision = "revision" in remote ? remote.revision : undefined;
  const remoteAt =
    remoteRevision === undefined
      ? "missing"
      : commit !== undefined && remoteRevision === commit
        ? "commit"
        : remoteRevision === base
          ? "base"
          : "elsewhere";
  if (remoteAt === "missing") {
    return blocked(rank >= STATE_RANK.get("committed")! ? "remote-branch-deleted" : "remote-drift");
  }
  if (remoteAt === "elsewhere") return blocked("remote-drift");
  if (remoteAt === "base" && rank >= STATE_RANK.get("pushed")!) return blocked("receipt-drift");
  const mergeRequest = observed.mergeRequest;
  if (
    mergeRequest.status === "absent" ||
    mergeRequest.status === "conflict" ||
    mergeRequest.iid !== record.advance.mergeRequestIid ||
    mergeRequest.url !== canonicalMergeRequestUrl(record, mergeRequest.iid) ||
    mergeRequest.sourceBranch !== record.sourceBranch ||
    mergeRequest.targetBranch !== record.targetBranch ||
    mergeRequest.draft !== true
  ) {
    return blocked("merge-request-changed");
  }
  if (mergeRequest.status === "closed") return blocked("merge-request-closed");
  if (mergeRequest.status === "merged") return blocked("merge-request-changed");
  const headMatches =
    remoteAt === "base"
      ? mergeRequest.headRevision === base
      : mergeRequest.headRevision === commit ||
        (record.state !== "opened" && mergeRequest.headRevision === base);
  if (!headMatches) return blocked("merge-request-changed");
  switch (record.state) {
    case "opened":
      return { decision: "reuse-opened", nextAction: "none" };
    case "pushed":
      return {
        decision: "resume-open-merge-request",
        nextAction: "open-draft-merge-request",
      };
    case "committed":
      return { decision: "resume-push", nextAction: "push-branch" };
    case "validated":
      if (observed.worktree !== "matching") {
        return { decision: "resume-prepare", nextAction: "prepare-worktree" };
      }
      return observed.validation === "passed"
        ? { decision: "resume-commit", nextAction: "create-commit" }
        : { decision: "resume-validation", nextAction: "run-validation" };
    case "prepared":
      return observed.worktree === "matching"
        ? { decision: "resume-validation", nextAction: "run-validation" }
        : { decision: "resume-prepare", nextAction: "prepare-worktree" };
    case "planned":
      return { decision: "resume-prepare", nextAction: "prepare-worktree" };
  }
}

/**
 * Convert one trusted host observation into an opaque capability. A serialized
 * observation or confirmation cannot authorize replay by itself.
 */
export function confirmScmDeliveryObservation(input: {
  record: ScmDeliveryRecord;
  observation: ScmDeliveryObservationV1;
  plan: LocalUserPublicationPlan;
  authorization: LocalUserPublicationAuthorizationV1;
}): ScmDeliveryObservationConfirmationV1 {
  const record = assertScmDeliveryMutationAuthorized(input.record, input.plan, input.authorization);
  const normalized = observation(input.observation, record);
  const reconciliation = reconcileScmDelivery(record, normalized, input.plan);
  const confirmation: ScmDeliveryObservationConfirmationV1 = freeze({
    schemaVersion: 1,
    kind: "docsfab-scm-delivery-observation-confirmation",
    recordSha256: record.sha256,
    observationSha256: sha256(normalized),
    reconciliationSha256: reconciliation.sha256,
  });
  issuedObservationConfirmations.add(confirmation);
  return confirmation;
}

function assertObservationConfirmation(
  record: ScmDeliveryRecord,
  replay: ScmDeliveryReplayEvidence,
  plan: LocalUserPublicationPlan,
): ScmDeliveryReconciliationV1 {
  requireCondition(
    issuedObservationConfirmations.has(replay.confirmation),
    "external-drift",
    "$.replay.confirmation",
  );
  issuedObservationConfirmations.delete(replay.confirmation);
  const normalized = observation(replay.observation, record);
  const reconciliation = reconcileScmDelivery(record, normalized, plan);
  requireCondition(
    replay.confirmation.schemaVersion === 1 &&
      replay.confirmation.kind === "docsfab-scm-delivery-observation-confirmation" &&
      replay.confirmation.recordSha256 === record.sha256 &&
      replay.confirmation.observationSha256 === sha256(normalized) &&
      replay.confirmation.reconciliationSha256 === reconciliation.sha256,
    "external-drift",
    "$.replay.confirmation",
  );
  return reconciliation;
}

/**
 * Issue the only authority that may retire private delivery material after a
 * verified push and opened draft merge request. Durable receipt JSON is never
 * sufficient authority for cleanup.
 */
export function issueScmPublishedTerminalCapability(input: {
  record: ScmDeliveryRecord;
  plan: LocalUserPublicationPlan;
  authorization: LocalUserPublicationAuthorizationV1;
  replay: ScmDeliveryReplayEvidence;
}): ScmPublishedTerminalCapability {
  const record = assertScmDeliveryMutationAuthorized(input.record, input.plan, input.authorization);
  requireCondition(
    record.state === "opened" && record.disposition === "succeeded",
    "invalid-transition",
    "$.record.disposition",
  );
  const reconciliation = assertObservationConfirmation(record, input.replay, input.plan);
  requireCondition(reconciliation.decision === "reuse-opened", "external-drift", "$.replay");
  const commitRevision = record.evidence.commit?.sha;
  const remoteRevision = record.evidence.push?.remoteRevision;
  const mergeRequest = record.evidence.mergeRequest;
  requireCondition(
    commitRevision !== undefined &&
      remoteRevision === commitRevision &&
      mergeRequest !== undefined &&
      mergeRequest.headRevision === commitRevision,
    "invalid-record",
    "$.record.evidence",
  );
  const evidence: ScmPublishedTerminalEvidence = freeze({
    idempotencyKey: record.idempotencyKey,
    recordSha256: record.sha256,
    planSha256: record.planSha256,
    run: { ...record.run },
    patch: {
      sha256: record.patch.sha256,
      byteLength: record.patch.byteLength,
      changedFileCount: record.patch.changedFileCount,
    },
    repository: { ...record.repository },
    baseRevision: record.baseRevision,
    sourceBranch: record.sourceBranch,
    targetBranch: record.targetBranch,
    commitRevision,
    remoteRevision,
    mergeRequest: { ...mergeRequest },
  });
  const capability: ScmPublishedTerminalCapability = freeze({
    schemaVersion: 1,
    kind: "docsfab-scm-published-terminal-capability",
    recordSha256: record.sha256,
    planSha256: record.planSha256,
  });
  issuedPublishedTerminalCapabilities.set(capability, evidence);
  return capability;
}

export function assertScmPublishedTerminalCapability(
  capability: ScmPublishedTerminalCapability,
  plan: LocalUserPublicationPlan,
  authorization: LocalUserPublicationAuthorizationV1,
): ScmPublishedTerminalEvidence {
  assertScmDeliveryInputs({ plan, authorization });
  const evidence = issuedPublishedTerminalCapabilities.get(capability);
  requireCondition(
    evidence !== undefined &&
      capability.schemaVersion === 1 &&
      capability.kind === "docsfab-scm-published-terminal-capability" &&
      capability.recordSha256 === evidence.recordSha256 &&
      capability.planSha256 === plan.sha256 &&
      evidence.planSha256 === plan.sha256 &&
      evidence.run.id === plan.run.id &&
      evidence.run.recordSha256 === plan.run.recordSha256 &&
      evidence.patch.sha256 === plan.patch.sha256 &&
      evidence.patch.byteLength === plan.patch.byteLength &&
      evidence.patch.changedFileCount === plan.patch.changedFileCount &&
      evidence.repository.provider === "gitlab" &&
      evidence.repository.projectId === plan.project.id &&
      evidence.repository.host === plan.project.host &&
      evidence.repository.path === plan.project.path &&
      evidence.repository.remoteName === plan.remote.name &&
      evidence.repository.remoteTransport === plan.remote.transport &&
      evidence.baseRevision === plan.baseRevision &&
      evidence.sourceBranch === plan.proposedSourceBranch &&
      evidence.targetBranch === plan.targetBranch.name,
    "invalid-authorization",
    "$.capability",
  );
  return evidence;
}

export function assertScmDeliveryRecord(
  value: unknown,
  plan: LocalUserPublicationPlanV1,
): ScmDeliveryRecordV1;
export function assertScmDeliveryRecord(
  value: unknown,
  plan: LocalUserPublicationPlanV2,
): ScmDeliveryRecordV2;
export function assertScmDeliveryRecord(
  value: unknown,
  plan: LocalUserPublicationPlan,
): ScmDeliveryRecord;
export function assertScmDeliveryRecord(
  value: unknown,
  plan: LocalUserPublicationPlan,
): ScmDeliveryRecord {
  assertLocalUserPublicationPlan(plan);
  const record = assertScmDeliveryRecordShape(value);
  validateRecordPlanBinding(record, plan);
  return record;
}

/** Strict provider-neutral durable-shape validator for future SCM adapters. */
export function assertScmDeliveryRecordShape(value: unknown): ScmDeliveryRecord {
  return decodeScmDeliveryRecordShape(value, {
    identityKey: scmDeliveryIdentityKey,
    attemptId: scmDeliveryAttemptId,
    recordSha256: scmDeliveryRecordSha256,
    matchesMergeRequest,
    sha256,
    stateRank: STATE_RANK,
    nextState: NEXT_STATE,
    failureAction: FAILURE_ACTION,
    evidenceField,
    failureAllowedAtState,
    requireCondition,
  });
}

function validateRecordPlanBinding(
  record: ScmDeliveryRecord,
  plan: LocalUserPublicationPlan,
): void {
  requireCondition(
    record.schemaVersion === plan.schemaVersion &&
      record.repository.provider === "gitlab" &&
      record.authorization.provider === "gitlab" &&
      record.idempotencyKey === scmDeliveryIdempotencyKey(plan) &&
      record.planSha256 === plan.sha256 &&
      record.authorization.planSha256 === plan.sha256,
    "identity-mismatch",
    "$.planSha256",
  );
  requireCondition(
    record.run.id === plan.run.id && record.run.recordSha256 === plan.run.recordSha256,
    "identity-mismatch",
    "$.run",
  );
  requireCondition(
    record.schemaVersion !== 3 ||
      (plan.schemaVersion === 3 && sha256(record.advance) === sha256(advanceLinkFromPlan(plan))),
    "identity-mismatch",
    "$.advance",
  );
  requireCondition(
    record.repository.projectId === plan.project.id &&
      record.repository.host === plan.project.host &&
      record.repository.path === plan.project.path &&
      record.repository.remoteName === plan.remote.name &&
      record.repository.remoteTransport === plan.remote.transport,
    "identity-mismatch",
    "$.repository",
  );
  requireCondition(
    record.baseRevision === plan.baseRevision &&
      record.sourceBranch === plan.proposedSourceBranch &&
      record.targetBranch === plan.targetBranch.name,
    "identity-mismatch",
    "$.baseRevision",
  );
  requireCondition(
    record.patch.sha256 === plan.patch.sha256 &&
      record.patch.byteLength === plan.patch.byteLength &&
      record.patch.changedFileCount === plan.patch.changedFileCount,
    "identity-mismatch",
    "$.patch",
  );
  requireCondition(
    record.evidence.validation?.commandSha256 === undefined ||
      record.evidence.validation.commandSha256 === sha256(plan.validationCommand),
    "identity-mismatch",
    "$.evidence.validation.commandSha256",
  );
  requireCondition(
    plan.documentationValidation === undefined ||
      record.evidence.validation === undefined ||
      record.evidence.validation.profileId !== undefined,
    "identity-mismatch",
    "$.evidence.validation.profileId",
  );
  if (record.evidence.validation?.profileId !== undefined) {
    requireCondition(
      plan.documentationValidation !== undefined &&
        record.evidence.validation.profileId === plan.documentationValidation.profileId &&
        record.evidence.validation.profileVersion === plan.documentationValidation.profileVersion &&
        record.evidence.validation.validatorIdentity ===
          plan.documentationValidation.validatorIdentity &&
        record.evidence.validation.checkSetSha256 === plan.documentationValidation.checkSetSha256 &&
        record.evidence.validation.selectorInputSha256 ===
          plan.documentationValidation.selectorInputSha256 &&
        (plan.documentationValidation.schemaVersion === 2
          ? record.evidence.validation.applicabilitySha256 ===
            plan.documentationValidation.applicabilitySha256
          : record.evidence.validation.applicabilitySha256 === undefined),
      "identity-mismatch",
      "$.evidence.validation.profileId",
    );
  }
  if (record.failure?.validation !== undefined) {
    deliveryValidationFailureEvidence(
      record.failure.validation,
      plan,
      record.failure.code,
      record.attempts.at(-1)?.workspaceKey,
    );
  }
}

function progressEvidence(
  input: ScmDeliveryProgressInput,
  record: ScmDeliveryRecord,
  plan: LocalUserPublicationPlan,
): object {
  if (input.toState === "prepared") {
    return {
      workspaceKey: requireSha(input.evidence.workspaceKey, "$.evidence.workspaceKey"),
      baseRevision: exact(
        input.evidence.baseRevision,
        record.baseRevision,
        "$.evidence.baseRevision",
      ),
    };
  }
  if (input.toState === "validated") {
    const validation: ScmDeliveryValidationEvidence = {
      commandSha256: exact(
        requireSha(input.evidence.commandSha256, "$.evidence.commandSha256"),
        sha256(plan.validationCommand),
        "$.evidence.commandSha256",
      ),
      summarySha256: requireSha(input.evidence.summarySha256, "$.evidence.summarySha256"),
      checkCount: positiveInteger(input.evidence.checkCount, "$.evidence.checkCount"),
      ...optionalDocumentationValidationEvidence(input.evidence, plan),
    };
    return validation;
  }
  if (input.toState === "committed") return { sha: revision(input.evidence.sha, "$.evidence.sha") };
  if (input.toState === "pushed") {
    const commitSha = record.evidence.commit?.sha;
    requireCondition(commitSha !== undefined, "invalid-transition", "$.evidence.commit");
    return {
      remoteRevision: exact(
        revision(input.evidence.remoteRevision, "$.evidence.remoteRevision"),
        commitSha,
        "$.evidence.remoteRevision",
      ),
    };
  }
  const evidence = mergeRequestEvidence(input.evidence, "$.evidence");
  requireCondition(matchesMergeRequest(evidence, record), "identity-mismatch", "$.evidence");
  return evidence;
}

function rebuildRecord(
  record: ScmDeliveryRecord,
  changes: Partial<ScmDeliveryRecord>,
  plan: LocalUserPublicationPlan,
): ScmDeliveryRecord {
  const mutable = { ...record, ...changes } as ScmDeliveryRecord & {
    failure?: ScmDeliveryFailure;
    recovery?: ScmDeliveryRecovery;
  };
  if (changes.failure === undefined) delete mutable.failure;
  if (changes.recovery === undefined) delete mutable.recovery;
  mutable.sha256 = scmDeliveryRecordSha256(mutable);
  return assertScmDeliveryRecord(mutable, plan);
}

function evidenceField(state: Exclude<ScmDeliveryState, "planned">): keyof ScmDeliveryEvidence {
  return (
    {
      prepared: "prepared",
      validated: "validation",
      committed: "commit",
      pushed: "push",
      opened: "mergeRequest",
    } as const
  )[state];
}

function failureAllowedAtState(code: ScmDeliveryFailureCode, state: ScmDeliveryState): boolean {
  if (code === "validation-failed" || code === "validation-isolation-unavailable") {
    return state !== "planned";
  }
  const phaseState = PHASE_FAILURE_STATE[code];
  if (phaseState !== undefined) return state === phaseState;
  if (code === "remote-branch-deleted") return state === "committed" || state === "pushed";
  return true;
}

/** Map plan and authorization validation failures to a content-free contract error. */
export function assertScmDeliveryInputs(input: {
  plan: LocalUserPublicationPlan;
  authorization: LocalUserPublicationAuthorizationV1;
}): void {
  try {
    assertLocalUserPublicationPlan(input.plan);
    assertLocalUserPublicationAuthorization(input.authorization, input.plan);
  } catch {
    throw new ScmDeliveryContractError("invalid-authorization", "$.authorization");
  }
}
