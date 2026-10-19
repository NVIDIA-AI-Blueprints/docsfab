// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  normalizeDeliveryValidationFailureEvidence,
  type DeliveryValidationFailureEvidence,
  type LocalUserPublicationPlan,
} from "../contracts.js";
import type { DocumentationCheckStatus } from "../structural-documentation-validator.js";
import { documentationValidationKit } from "../validation-profile.js";
import { validateScmDeliveryRecordRelations } from "./record-relations.js";
import { containsConfiguredCredentialText } from "../contracts.js";
import { freeze } from "./shape-primitives.js";
import {
  array,
  branch,
  enumeration,
  exact,
  object,
  positiveInteger,
  requireCondition,
  requireSha,
  revision,
  safeHost,
  safeId,
  safeProject,
  safeUrl,
  sha256,
  timestamp,
  token,
} from "./shape-primitives.js";
import {
  SCM_DELIVERY_DISPOSITIONS,
  SCM_DELIVERY_FAILURE_CODES,
  SCM_DELIVERY_NEXT_ACTIONS,
  SCM_DELIVERY_STATES,
} from "./schema.js";
import type {
  ScmDeliveryAdvanceLink,
  ScmDeliveryAttempt,
  ScmDeliveryCommitEvidence,
  ScmDeliveryDisposition,
  ScmDeliveryEvidence,
  ScmDeliveryFailure,
  ScmDeliveryFailureCode,
  ScmDeliveryMergeRequestEvidence,
  ScmDeliveryNextAction,
  ScmDeliveryObservationV1,
  ScmDeliveryPreparedEvidence,
  ScmDeliveryRecord,
  ScmDeliveryRecovery,
  ScmDeliveryState,
  ScmDeliveryValidationEvidence,
  ScmDeliveryPushEvidence,
} from "../receipt.js";

export function evidence(value: unknown, path: string, schemaVersion: 1 | 2): ScmDeliveryEvidence {
  const item = object(
    value,
    path,
    ["prepared", "validation", "commit", "push", "mergeRequest"],
    [],
  );
  return {
    ...(item.prepared === undefined
      ? {}
      : { prepared: preparedEvidence(item.prepared, `${path}.prepared`) }),
    ...(item.validation === undefined
      ? {}
      : {
          validation: validationEvidence(item.validation, `${path}.validation`, schemaVersion),
        }),
    ...(item.commit === undefined ? {} : { commit: commitEvidence(item.commit, `${path}.commit`) }),
    ...(item.push === undefined ? {} : { push: pushEvidence(item.push, `${path}.push`) }),
    ...(item.mergeRequest === undefined
      ? {}
      : {
          mergeRequest: mergeRequestEvidence(item.mergeRequest, `${path}.mergeRequest`),
        }),
  };
}

export function advanceLink(value: unknown, path: string): ScmDeliveryAdvanceLink {
  const item = object(value, path, [
    "parentReceiptSha256",
    "previousHead",
    "parentIdempotencyKey",
    "ordinal",
    "mergeRequestIid",
  ]);
  return {
    parentReceiptSha256: requireSha(item.parentReceiptSha256, `${path}.parentReceiptSha256`),
    previousHead: revision(item.previousHead, `${path}.previousHead`),
    parentIdempotencyKey: requireSha(item.parentIdempotencyKey, `${path}.parentIdempotencyKey`),
    ordinal: positiveInteger(item.ordinal, `${path}.ordinal`),
    mergeRequestIid: positiveInteger(item.mergeRequestIid, `${path}.mergeRequestIid`),
  };
}

export function preparedEvidence(value: unknown, path: string): ScmDeliveryPreparedEvidence {
  const item = object(value, path, ["workspaceKey", "baseRevision"]);
  return {
    workspaceKey: requireSha(item.workspaceKey, `${path}.workspaceKey`),
    baseRevision: revision(item.baseRevision, `${path}.baseRevision`),
  };
}

export function validationEvidence(
  value: unknown,
  path: string,
  schemaVersion: 1 | 2,
): ScmDeliveryValidationEvidence {
  const item = object(
    value,
    path,
    [
      "commandSha256",
      "summarySha256",
      "checkCount",
      "profileId",
      "profileVersion",
      "checkIds",
      "selectorInputSha256",
      "validatorIdentity",
      "candidateTreeSha256",
      "checkSetSha256",
      "applicabilitySha256",
      "backendIdentity",
      "resultSha256",
      "results",
    ],
    ["commandSha256", "summarySha256", "checkCount"],
  );
  const validation: ScmDeliveryValidationEvidence = {
    commandSha256: requireSha(item.commandSha256, `${path}.commandSha256`),
    summarySha256: requireSha(item.summarySha256, `${path}.summarySha256`),
    checkCount: positiveInteger(item.checkCount, `${path}.checkCount`),
    ...optionalDocumentationValidationFields(item, path),
  };
  validateDocumentationValidationResultDigest(validation, schemaVersion, path);
  return validation;
}

export function optionalDocumentationValidationEvidence(
  evidence: ScmDeliveryValidationEvidence,
  plan: LocalUserPublicationPlan,
): Partial<ScmDeliveryValidationEvidence> {
  if (evidence.profileId === undefined) {
    requireCondition(
      plan.documentationValidation === undefined,
      "invalid-record",
      "$.evidence.validation.profileId",
    );
    return {};
  }
  requireCondition(
    plan.documentationValidation !== undefined &&
      evidence.profileId === plan.documentationValidation.profileId &&
      evidence.profileVersion === plan.documentationValidation.profileVersion &&
      evidence.validatorIdentity === plan.documentationValidation.validatorIdentity &&
      evidence.checkSetSha256 === plan.documentationValidation.checkSetSha256 &&
      evidence.selectorInputSha256 === plan.documentationValidation.selectorInputSha256 &&
      (plan.documentationValidation.schemaVersion === 2
        ? evidence.applicabilitySha256 === plan.documentationValidation.applicabilitySha256
        : evidence.applicabilitySha256 === undefined),
    "identity-mismatch",
    "$.evidence.profileId",
  );
  requireCondition(
    evidence.checkCount === plan.documentationValidation!.checkIds.length &&
      Array.isArray(evidence.checkIds) &&
      evidence.checkIds.length === plan.documentationValidation!.checkIds.length &&
      evidence.checkIds.every(
        (id, index) => id === plan.documentationValidation!.checkIds[index],
      ) &&
      typeof evidence.candidateTreeSha256 === "string" &&
      typeof evidence.resultSha256 === "string" &&
      Array.isArray(evidence.results) &&
      evidence.results.length === plan.documentationValidation!.checkIds.length &&
      evidence.results.every(
        (result, index) =>
          result.id === plan.documentationValidation!.checkIds[index] && result.status === "passed",
      ),
    "invalid-record",
    "$.evidence.validation",
  );
  const normalized = optionalDocumentationValidationFields(
    evidence as unknown as Record<string, unknown>,
    "$.evidence",
  );
  validateDocumentationValidationResultDigest(
    { ...evidence, ...normalized },
    plan.documentationValidation.schemaVersion,
    "$.evidence.validation",
  );
  return normalized;
}

export function validateDocumentationValidationResultDigest(
  evidence: ScmDeliveryValidationEvidence,
  schemaVersion: 1 | 2,
  path: string,
): void {
  if (schemaVersion !== 2 || evidence.profileId === undefined) return;
  requireCondition(
    evidence.resultSha256 !== undefined &&
      evidence.results !== undefined &&
      evidence.checkSetSha256 !== undefined &&
      evidence.candidateTreeSha256 !== undefined &&
      evidence.applicabilitySha256 !== undefined &&
      evidence.resultSha256 ===
        documentationValidationKit.canonicalDigest({
          results: evidence.results,
          stateSha256: evidence.summarySha256,
          checkSetSha256: evidence.checkSetSha256,
          candidateTreeSha256: evidence.candidateTreeSha256,
          applicabilitySha256: evidence.applicabilitySha256,
        }),
    "invalid-record",
    `${path}.resultSha256`,
  );
}

export function optionalDocumentationValidationFields(
  item: Record<string, unknown>,
  path: string,
): Partial<ScmDeliveryValidationEvidence> {
  const extra: Partial<ScmDeliveryValidationEvidence> = {};
  if (item.profileId !== undefined) extra.profileId = token(item.profileId, `${path}.profileId`);
  if (item.profileVersion !== undefined) {
    extra.profileVersion = token(item.profileVersion, `${path}.profileVersion`);
  }
  if (item.checkIds !== undefined) {
    requireCondition(
      Array.isArray(item.checkIds) && item.checkIds.length > 0,
      "invalid-record",
      `${path}.checkIds`,
    );
    extra.checkIds = item.checkIds.map((id, index) => token(id, `${path}.checkIds[${index}]`));
  }
  if (item.selectorInputSha256 !== undefined) {
    extra.selectorInputSha256 = requireSha(item.selectorInputSha256, `${path}.selectorInputSha256`);
  }
  if (item.validatorIdentity !== undefined) {
    extra.validatorIdentity = token(item.validatorIdentity, `${path}.validatorIdentity`);
  }
  if (item.candidateTreeSha256 !== undefined) {
    extra.candidateTreeSha256 = requireSha(item.candidateTreeSha256, `${path}.candidateTreeSha256`);
  }
  if (item.checkSetSha256 !== undefined) {
    extra.checkSetSha256 = requireSha(item.checkSetSha256, `${path}.checkSetSha256`);
  }
  if (item.applicabilitySha256 !== undefined) {
    extra.applicabilitySha256 = requireSha(item.applicabilitySha256, `${path}.applicabilitySha256`);
  }
  if (item.backendIdentity !== undefined) {
    extra.backendIdentity = token(item.backendIdentity, `${path}.backendIdentity`);
  }
  if (item.resultSha256 !== undefined) {
    extra.resultSha256 = requireSha(item.resultSha256, `${path}.resultSha256`);
  }
  if (item.results !== undefined) {
    requireCondition(
      Array.isArray(item.results) && item.results.length > 0,
      "invalid-record",
      `${path}.results`,
    );
    extra.results = item.results.map((value, index) => {
      const result = object(value, `${path}.results[${index}]`, ["id", "status"]);
      const status = result.status;
      requireCondition(
        status === "passed" || status === "failed" || status === "limitation",
        "invalid-record",
        `${path}.results[${index}].status`,
      );
      return { id: token(result.id, `${path}.results[${index}].id`), status };
    });
  }
  return extra;
}

export function deliveryValidationFailureEvidence(
  value: DeliveryValidationFailureEvidence,
  plan: LocalUserPublicationPlan,
  failureCode: ScmDeliveryFailureCode,
  preparedWorkspaceKey: string | undefined,
): DeliveryValidationFailureEvidence {
  const validation = normalizeDeliveryValidationFailureEvidence(value);
  requireCondition(validation !== undefined, "invalid-record", "$.failure.validation");
  requireCondition(
    failureCode === "validation-failed" || failureCode === "validation-isolation-unavailable",
    "invalid-transition",
    "$.failure.validation",
  );
  requireCondition(
    validation.reasonCode === "validation-backend-unavailable"
      ? failureCode === "validation-isolation-unavailable"
      : failureCode === "validation-failed",
    "invalid-transition",
    "$.failure.validation.reasonCode",
  );
  if (validation.commandSha256 !== undefined) {
    requireCondition(
      validation.commandSha256 === sha256(plan.validationCommand),
      "identity-mismatch",
      "$.failure.validation.commandSha256",
    );
  }
  if (validation.candidateTreeSha256 !== undefined) {
    requireCondition(
      validation.planSha256 === plan.sha256 &&
        validation.runId === plan.run.id &&
        validation.runRecordSha256 === plan.run.recordSha256 &&
        validation.patchSha256 === plan.patch.sha256 &&
        validation.workspaceKey === preparedWorkspaceKey,
      "identity-mismatch",
      "$.failure.validation.candidateTreeSha256",
    );
  }
  if (validation.profileId !== undefined) {
    const binding = plan.documentationValidation;
    requireCondition(
      binding !== undefined &&
        validation.profileId === binding.profileId &&
        validation.profileVersion === binding.profileVersion &&
        validation.validatorIdentity === binding.validatorIdentity &&
        validation.checkSetSha256 === binding.checkSetSha256 &&
        validation.selectorInputSha256 === binding.selectorInputSha256 &&
        (binding.schemaVersion === 2
          ? validation.applicabilitySha256 === binding.applicabilitySha256
          : validation.applicabilitySha256 === undefined) &&
        Array.isArray(validation.checkIds) &&
        validation.checkIds.length === binding.checkIds.length &&
        validation.checkIds.every((id, index) => id === binding.checkIds[index]),
      "identity-mismatch",
      "$.failure.validation.profileId",
    );
  } else {
    requireCondition(
      validation.profileVersion === undefined &&
        validation.validatorIdentity === undefined &&
        validation.checkSetSha256 === undefined &&
        validation.selectorInputSha256 === undefined &&
        validation.applicabilitySha256 === undefined &&
        validation.checkIds === undefined,
      "invalid-record",
      "$.failure.validation.profileId",
    );
  }
  if (validation.results !== undefined) {
    requireCondition(
      validation.checkIds !== undefined &&
        validation.results.every((result) => validation.checkIds!.includes(result.id)),
      "identity-mismatch",
      "$.failure.validation.results",
    );
  }
  requireCondition(
    validation.reasonCode !== "validation-check-failed" || validation.results !== undefined,
    "invalid-record",
    "$.failure.validation.results",
  );
  return validation;
}

export function commitEvidence(value: unknown, path: string): ScmDeliveryCommitEvidence {
  const item = object(value, path, ["sha"]);
  return { sha: revision(item.sha, `${path}.sha`) };
}

export function pushEvidence(value: unknown, path: string): ScmDeliveryPushEvidence {
  const item = object(value, path, ["remoteRevision"]);
  return {
    remoteRevision: revision(item.remoteRevision, `${path}.remoteRevision`),
  };
}

export function mergeRequestEvidence(
  value: unknown,
  path: string,
): ScmDeliveryMergeRequestEvidence {
  const item = object(value, path, [
    "iid",
    "url",
    "state",
    "draft",
    "sourceBranch",
    "targetBranch",
    "headRevision",
  ]);
  return {
    iid: positiveInteger(item.iid, `${path}.iid`),
    url: safeUrl(item.url, `${path}.url`),
    state: exact(item.state, "opened", `${path}.state`),
    draft: exact(item.draft, true, `${path}.draft`),
    sourceBranch: branch(item.sourceBranch, `${path}.sourceBranch`),
    targetBranch: branch(item.targetBranch, `${path}.targetBranch`),
    headRevision: revision(item.headRevision, `${path}.headRevision`),
  };
}

export function attempt(value: unknown, path: string): ScmDeliveryAttempt {
  const item = object(
    value,
    path,
    [
      "sequence",
      "id",
      "source",
      "outcome",
      "fromState",
      "toState",
      "at",
      "evidenceSha256",
      "failureCode",
      "workspaceKey",
    ],
    ["sequence", "id", "source", "outcome", "fromState", "toState", "at"],
  );
  return {
    sequence: positiveInteger(item.sequence, `${path}.sequence`),
    id: requireSha(item.id, `${path}.id`),
    source: enumeration(item.source, ["executed", "host-policy"] as const, `${path}.source`),
    outcome: enumeration(
      item.outcome,
      ["confirmed", "failed", "recovered"] as const,
      `${path}.outcome`,
    ),
    fromState: enumeration(item.fromState, SCM_DELIVERY_STATES, `${path}.fromState`),
    toState: enumeration(item.toState, SCM_DELIVERY_STATES, `${path}.toState`),
    at: timestamp(item.at, `${path}.at`),
    ...(item.evidenceSha256 === undefined
      ? {}
      : {
          evidenceSha256: requireSha(item.evidenceSha256, `${path}.evidenceSha256`),
        }),
    ...(item.failureCode === undefined
      ? {}
      : {
          failureCode: enumeration(
            item.failureCode,
            SCM_DELIVERY_FAILURE_CODES,
            `${path}.failureCode`,
          ),
        }),
    ...(item.workspaceKey === undefined
      ? {}
      : { workspaceKey: requireSha(item.workspaceKey, `${path}.workspaceKey`) }),
  };
}

export function failure(value: unknown, path: string): ScmDeliveryFailure {
  const item = object(
    value,
    path,
    ["code", "lastConfirmedState", "nextAction", "at", "validation"],
    ["code", "lastConfirmedState", "nextAction", "at"],
  );
  const validation = normalizeDeliveryValidationFailureEvidence(
    item.validation as DeliveryValidationFailureEvidence | undefined,
  );
  requireCondition(
    item.validation === undefined || validation !== undefined,
    "invalid-record",
    `${path}.validation`,
  );
  return {
    code: enumeration(item.code, SCM_DELIVERY_FAILURE_CODES, `${path}.code`),
    lastConfirmedState: enumeration(
      item.lastConfirmedState,
      SCM_DELIVERY_STATES,
      `${path}.lastConfirmedState`,
    ),
    nextAction: enumeration(item.nextAction, SCM_DELIVERY_NEXT_ACTIONS, `${path}.nextAction`),
    at: timestamp(item.at, `${path}.at`),
    ...(validation === undefined ? {} : { validation }),
  };
}

export function recovery(value: unknown, path: string): ScmDeliveryRecovery {
  const item = object(value, path, [
    "mode",
    "reasonCode",
    "patchSha256",
    "preserved",
    "nextAction",
    "at",
  ]);
  return {
    mode: exact(item.mode, "patch-only", `${path}.mode`),
    reasonCode: enumeration(
      item.reasonCode,
      [
        "operator-requested",
        "authentication-unavailable",
        "external-drift",
        "validation-failed",
      ] as const,
      `${path}.reasonCode`,
    ),
    patchSha256: requireSha(item.patchSha256, `${path}.patchSha256`),
    preserved: exact(item.preserved, true, `${path}.preserved`),
    nextAction: exact(item.nextAction, "review-preserved-patch", `${path}.nextAction`),
    at: timestamp(item.at, `${path}.at`),
  };
}

export function observation(value: unknown, record: ScmDeliveryRecord): ScmDeliveryObservationV1 {
  const root = object(value, "$", [
    "schemaVersion",
    "kind",
    "idempotencyKey",
    "planSha256",
    "authentication",
    "worktree",
    "validation",
    "localCommit",
    "remoteBranch",
    "mergeRequest",
  ]);
  requireCondition(
    root.schemaVersion === 1 && root.kind === "docsfab-scm-delivery-observation",
    "invalid-record",
    "$",
  );
  const local = object(root.localCommit, "$.localCommit", ["status", "revision"], ["status"]);
  const remote = object(root.remoteBranch, "$.remoteBranch", ["status", "revision"], ["status"]);
  const merge = object(
    root.mergeRequest,
    "$.mergeRequest",
    ["status", "iid", "url", "draft", "sourceBranch", "targetBranch", "headRevision"],
    ["status"],
  );
  const localStatus = enumeration(
    local.status,
    ["absent", "matching", "conflict"] as const,
    "$.localCommit.status",
  );
  const remoteStatus = enumeration(
    remote.status,
    ["absent", "matching", "deleted", "conflict"] as const,
    "$.remoteBranch.status",
  );
  const mergeStatus = enumeration(
    merge.status,
    ["absent", "opened", "closed", "merged", "conflict"] as const,
    "$.mergeRequest.status",
  );
  requireCondition(
    (localStatus === "absent") === (local.revision === undefined),
    "invalid-record",
    "$.localCommit.revision",
  );
  requireCondition(
    (["absent", "deleted"] as string[]).includes(remoteStatus) === (remote.revision === undefined),
    "invalid-record",
    "$.remoteBranch.revision",
  );
  requireCondition(
    (mergeStatus === "absent") === (Object.keys(merge).length === 1),
    "invalid-record",
    "$.mergeRequest",
  );
  const result: ScmDeliveryObservationV1 = {
    schemaVersion: 1,
    kind: "docsfab-scm-delivery-observation",
    idempotencyKey: requireSha(root.idempotencyKey, "$.idempotencyKey"),
    planSha256: requireSha(root.planSha256, "$.planSha256"),
    authentication: enumeration(
      root.authentication,
      ["available", "unavailable", "revoked"] as const,
      "$.authentication",
    ),
    worktree: enumeration(root.worktree, ["absent", "matching", "conflict"] as const, "$.worktree"),
    validation: enumeration(
      root.validation,
      ["unknown", "passed", "failed"] as const,
      "$.validation",
    ),
    localCommit:
      localStatus === "absent"
        ? { status: "absent" }
        : {
            status: localStatus,
            revision: revision(local.revision, "$.localCommit.revision"),
          },
    remoteBranch:
      remoteStatus === "absent" || remoteStatus === "deleted"
        ? { status: remoteStatus }
        : {
            status: remoteStatus,
            revision: revision(remote.revision, "$.remoteBranch.revision"),
          },
    mergeRequest:
      mergeStatus === "absent"
        ? { status: "absent" }
        : {
            status: mergeStatus,
            iid: positiveInteger(merge.iid, "$.mergeRequest.iid"),
            url: safeUrl(merge.url, "$.mergeRequest.url"),
            draft: exact(merge.draft, true, "$.mergeRequest.draft"),
            sourceBranch: branch(merge.sourceBranch, "$.mergeRequest.sourceBranch"),
            targetBranch: branch(merge.targetBranch, "$.mergeRequest.targetBranch"),
            headRevision: revision(merge.headRevision, "$.mergeRequest.headRevision"),
          },
  };
  requireCondition(
    result.validation === "unknown" || result.worktree === "matching",
    "invalid-record",
    "$.validation",
  );
  requireCondition(
    result.idempotencyKey === record.idempotencyKey && result.planSha256 === record.planSha256,
    "identity-mismatch",
    "$.idempotencyKey",
  );
  return result;
}

export function matchesMergeRequest(
  value: ScmDeliveryMergeRequestEvidence,
  record: ScmDeliveryRecord,
): boolean {
  return (
    value.url === canonicalMergeRequestUrl(record, value.iid) &&
    value.sourceBranch === record.sourceBranch &&
    value.targetBranch === record.targetBranch &&
    value.headRevision === record.evidence.commit?.sha &&
    value.draft === true
  );
}

export function matchesObservedMergeRequest(
  value: Exclude<ScmDeliveryObservationV1["mergeRequest"], { status: "absent" }>,
  record: ScmDeliveryRecord,
  observed: ScmDeliveryObservationV1,
): boolean {
  const expectedHead =
    record.evidence.commit?.sha ??
    (observed.localCommit.status === "matching" ? observed.localCommit.revision : undefined) ??
    (observed.remoteBranch.status === "matching" ? observed.remoteBranch.revision : undefined);
  return (
    expectedHead !== undefined &&
    value.url === canonicalMergeRequestUrl(record, value.iid) &&
    value.sourceBranch === record.sourceBranch &&
    value.targetBranch === record.targetBranch &&
    value.headRevision === expectedHead &&
    value.draft === true &&
    (observed.remoteBranch.status !== "matching" || observed.remoteBranch.revision === expectedHead)
  );
}

export function canonicalMergeRequestUrl(record: ScmDeliveryRecord, iid: number): string {
  positiveInteger(iid, "$.iid");
  return record.repository.provider === "gitlab"
    ? `https://${record.repository.host}/${record.repository.path}/-/merge_requests/${iid}`
    : `https://${record.repository.host}/${record.repository.path}/pull/${iid}`;
}

export function decodeScmDeliveryRecordShape(
  value: unknown,
  relationDependencies: Parameters<typeof validateScmDeliveryRecordRelations>[1],
): ScmDeliveryRecord {
  const root = object(
    value,
    "$",
    [
      "schemaVersion",
      "kind",
      "deliveryMode",
      "idempotencyKey",
      "planSha256",
      "authorization",
      "run",
      "repository",
      "baseRevision",
      "sourceBranch",
      "targetBranch",
      "patch",
      "state",
      "disposition",
      "evidence",
      "attempts",
      "failure",
      "recovery",
      "createdAt",
      "updatedAt",
      "advance",
      "sha256",
    ],
    [
      "schemaVersion",
      "kind",
      "deliveryMode",
      "idempotencyKey",
      "planSha256",
      "authorization",
      "run",
      "repository",
      "baseRevision",
      "sourceBranch",
      "targetBranch",
      "patch",
      "state",
      "disposition",
      "evidence",
      "attempts",
      "createdAt",
      "updatedAt",
      "sha256",
    ],
  );
  requireCondition(
    (root.schemaVersion === 1 || root.schemaVersion === 2 || root.schemaVersion === 3) &&
      root.kind === "docsfab-scm-delivery-record" &&
      root.deliveryMode === "local-user",
    "invalid-record",
    "$",
  );
  // Only an advance receipt carries the chain link, and it always does.
  requireCondition(
    (root.schemaVersion === 3) === (root.advance !== undefined),
    "invalid-record",
    "$.advance",
  );
  const authorization = object(root.authorization, "$.authorization", [
    "kind",
    "provider",
    "planSha256",
  ]);
  const run = object(root.run, "$.run", ["id", "recordSha256"]);
  const repository = object(root.repository, "$.repository", [
    "provider",
    "projectId",
    "host",
    "path",
    "remoteName",
    "remoteTransport",
  ]);
  const patch = object(root.patch, "$.patch", [
    "sha256",
    "byteLength",
    "changedFileCount",
    "preserved",
  ]);
  const record = {
    schemaVersion: root.schemaVersion as 1 | 2 | 3,
    kind: "docsfab-scm-delivery-record",
    deliveryMode: "local-user",
    idempotencyKey: requireSha(root.idempotencyKey, "$.idempotencyKey"),
    planSha256: requireSha(root.planSha256, "$.planSha256"),
    authorization: {
      kind: exact(
        authorization.kind,
        "docsfab-scm-publication-authorization",
        "$.authorization.kind",
      ),
      provider: enumeration(
        authorization.provider,
        ["gitlab", "github"] as const,
        "$.authorization.provider",
      ),
      planSha256: requireSha(authorization.planSha256, "$.authorization.planSha256"),
    },
    run: {
      id: safeId(run.id, "$.run.id"),
      recordSha256: requireSha(run.recordSha256, "$.run.recordSha256"),
    },
    repository: {
      provider: enumeration(
        repository.provider,
        ["gitlab", "github"] as const,
        "$.repository.provider",
      ),
      projectId: positiveInteger(repository.projectId, "$.repository.projectId"),
      host: safeHost(repository.host, "$.repository.host"),
      path: safeProject(repository.path, "$.repository.path"),
      remoteName: safeId(repository.remoteName, "$.repository.remoteName"),
      remoteTransport: enumeration(
        repository.remoteTransport,
        ["ssh", "https"] as const,
        "$.repository.remoteTransport",
      ),
    },
    baseRevision: revision(root.baseRevision, "$.baseRevision"),
    sourceBranch: branch(root.sourceBranch, "$.sourceBranch"),
    targetBranch: branch(root.targetBranch, "$.targetBranch"),
    patch: {
      sha256: requireSha(patch.sha256, "$.patch.sha256"),
      byteLength: positiveInteger(patch.byteLength, "$.patch.byteLength"),
      changedFileCount: positiveInteger(patch.changedFileCount, "$.patch.changedFileCount"),
      preserved: exact(patch.preserved, true, "$.patch.preserved"),
    },
    state: enumeration(root.state, SCM_DELIVERY_STATES, "$.state"),
    disposition: enumeration(root.disposition, SCM_DELIVERY_DISPOSITIONS, "$.disposition"),
    evidence: evidence(root.evidence, "$.evidence", root.schemaVersion === 1 ? 1 : 2),
    attempts: array(root.attempts, "$.attempts").map((item, index) =>
      attempt(item, `$.attempts[${index}]`),
    ),
    ...(root.failure === undefined ? {} : { failure: failure(root.failure, "$.failure") }),
    ...(root.recovery === undefined ? {} : { recovery: recovery(root.recovery, "$.recovery") }),
    createdAt: timestamp(root.createdAt, "$.createdAt"),
    updatedAt: timestamp(root.updatedAt, "$.updatedAt"),
    ...(root.advance === undefined ? {} : { advance: advanceLink(root.advance, "$.advance") }),
    sha256: requireSha(root.sha256, "$.sha256"),
  } as ScmDeliveryRecord;
  validateScmDeliveryRecordRelations(record, relationDependencies);
  const serialized = JSON.stringify(record);
  requireCondition(
    !containsConfiguredCredentialText(serialized, "delivery-receipt") &&
      !/(?:[A-Za-z]:\\|\/(?:Users|home|private|tmp)\/)/u.test(serialized),
    "invalid-record",
    "$.sanitization",
  );
  return freeze(record);
}
