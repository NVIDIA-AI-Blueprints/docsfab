// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ScmDeliveryContractError,
  ScmDeliveryAdvanceLink,
  ScmDeliveryDisposition,
  ScmDeliveryEvidence,
  ScmDeliveryFailureCode,
  ScmDeliveryMergeRequestEvidence,
  ScmDeliveryNextAction,
  ScmDeliveryRecord,
  ScmDeliveryState,
} from "../receipt.js";

type Dependencies = {
  identityKey: (input: {
    provider: ScmDeliveryRecord["repository"]["provider"];
    run: ScmDeliveryRecord["run"];
    repository: Pick<ScmDeliveryRecord["repository"], "projectId" | "host" | "path">;
    baseRevision: string;
    targetBranch: string;
    patchSha256: string;
    advance?: ScmDeliveryAdvanceLink;
  }) => string;
  attemptId: (idempotencyKey: string, sequence: number) => string;
  recordSha256: (record: ScmDeliveryRecord) => string;
  matchesMergeRequest: (
    value: ScmDeliveryMergeRequestEvidence,
    record: ScmDeliveryRecord,
  ) => boolean;
  sha256: (value: unknown) => string;
  stateRank: ReadonlyMap<ScmDeliveryState, number>;
  nextState: Record<ScmDeliveryState, ScmDeliveryState | undefined>;
  failureAction: Record<ScmDeliveryFailureCode, ScmDeliveryNextAction>;
  evidenceField: (state: Exclude<ScmDeliveryState, "planned">) => keyof ScmDeliveryEvidence;
  failureAllowedAtState: (code: ScmDeliveryFailureCode, state: ScmDeliveryState) => boolean;
  requireCondition: (
    condition: unknown,
    code: ScmDeliveryContractError["code"],
    path: string,
  ) => asserts condition;
};

export function validateScmDeliveryRecordRelations(
  record: ScmDeliveryRecord,
  dependencies: Dependencies,
): void {
  const {
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
  } = dependencies;
  const requireCondition: Dependencies["requireCondition"] = dependencies.requireCondition;
  if (record.schemaVersion === 1) {
    requireCondition(
      record.evidence.validation?.applicabilitySha256 === undefined &&
        record.failure?.validation?.applicabilitySha256 === undefined,
      "invalid-record",
      "$.evidence.validation.applicabilitySha256",
    );
  }
  requireCondition(
    record.authorization.provider === record.repository.provider &&
      record.authorization.planSha256 === record.planSha256 &&
      record.idempotencyKey ===
        scmDeliveryIdentityKey({
          provider: record.repository.provider,
          run: record.run,
          repository: {
            projectId: record.repository.projectId,
            host: record.repository.host,
            path: record.repository.path,
          },
          baseRevision: record.baseRevision,
          targetBranch: record.targetBranch,
          patchSha256: record.patch.sha256,
          ...(record.schemaVersion === 3 ? { advance: record.advance } : {}),
        }),
    "identity-mismatch",
    "$.idempotencyKey",
  );
  // The advance-only failure never appears on a receipt that created its branch.
  requireCondition(
    record.schemaVersion === 3 ||
      (record.failure?.code !== "revision-mr-not-open" &&
        record.attempts.every((item) => item.failureCode !== "revision-mr-not-open")),
    "invalid-record",
    "$.failure",
  );
  requireCondition(
    Date.parse(record.createdAt) <= Date.parse(record.updatedAt),
    "invalid-record",
    "$.updatedAt",
  );
  const rank = STATE_RANK.get(record.state)!;
  const evidenceByRank: Array<keyof ScmDeliveryEvidence> = [
    "prepared",
    "validation",
    "commit",
    "push",
    "mergeRequest",
  ];
  evidenceByRank.forEach((field, index) => {
    requireCondition(
      (record.evidence[field] !== undefined) === rank >= index + 1,
      "invalid-record",
      `$.evidence.${field}`,
    );
  });
  requireCondition(
    record.evidence.prepared?.baseRevision === undefined ||
      record.evidence.prepared.baseRevision === record.baseRevision,
    "identity-mismatch",
    "$.evidence.prepared.baseRevision",
  );
  requireCondition(
    record.evidence.push?.remoteRevision === undefined ||
      record.evidence.push.remoteRevision === record.evidence.commit?.sha,
    "identity-mismatch",
    "$.evidence.push.remoteRevision",
  );
  if (record.evidence.mergeRequest)
    requireCondition(
      matchesMergeRequest(record.evidence.mergeRequest, record),
      "identity-mismatch",
      "$.evidence.mergeRequest",
    );
  if (record.schemaVersion === 3) {
    requireCondition(
      record.evidence.mergeRequest === undefined ||
        record.evidence.mergeRequest.iid === record.advance.mergeRequestIid,
      "identity-mismatch",
      "$.evidence.mergeRequest.iid",
    );
  }
  if (record.disposition === "succeeded")
    requireCondition(
      record.state === "opened" && record.failure === undefined && record.recovery === undefined,
      "invalid-record",
      "$.disposition",
    );
  if (record.state === "opened")
    requireCondition(record.disposition === "succeeded", "invalid-record", "$.disposition");
  if (record.disposition === "failed")
    requireCondition(
      record.failure?.lastConfirmedState === record.state &&
        record.failure.nextAction === FAILURE_ACTION[record.failure.code] &&
        record.failure.at === record.updatedAt &&
        record.recovery === undefined,
      "invalid-record",
      "$.failure",
    );
  if (record.disposition === "recovered")
    requireCondition(
      record.recovery?.patchSha256 === record.patch.sha256 &&
        record.recovery.at === record.updatedAt &&
        record.failure === undefined,
      "invalid-record",
      "$.recovery",
    );
  if (record.disposition === "active")
    requireCondition(
      record.failure === undefined && record.recovery === undefined && record.state !== "opened",
      "invalid-record",
      "$.disposition",
    );
  let state: ScmDeliveryState = "planned";
  let priorAt = record.createdAt;
  record.attempts.forEach((item, index) => {
    requireCondition(
      item.sequence === index + 1 &&
        item.id === scmDeliveryAttemptId(record.idempotencyKey, item.sequence),
      "invalid-record",
      `$.attempts[${index}]`,
    );
    requireCondition(
      item.fromState === state && Date.parse(priorAt) <= Date.parse(item.at),
      "invalid-record",
      `$.attempts[${index}]`,
    );
    if (item.outcome === "confirmed") {
      const confirmedEvidence =
        record.evidence[evidenceField(item.toState as Exclude<ScmDeliveryState, "planned">)];
      requireCondition(
        item.source !== "host-policy" &&
          NEXT_STATE[state] === item.toState &&
          item.evidenceSha256 !== undefined &&
          confirmedEvidence !== undefined &&
          item.evidenceSha256 === sha256(confirmedEvidence) &&
          item.failureCode === undefined &&
          item.workspaceKey === undefined,
        "invalid-transition",
        `$.attempts[${index}]`,
      );
      state = item.toState;
    } else if (item.outcome === "failed") {
      requireCondition(
        item.source === "host-policy" &&
          item.toState === state &&
          item.failureCode !== undefined &&
          (item.workspaceKey === undefined ||
            ((item.failureCode === "validation-failed" ||
              item.failureCode === "validation-isolation-unavailable") &&
              item.evidenceSha256 !== undefined)) &&
          failureAllowedAtState(item.failureCode, state),
        "invalid-transition",
        `$.attempts[${index}]`,
      );
    } else {
      requireCondition(
        item.source === "host-policy" &&
          item.toState === state &&
          item.failureCode === undefined &&
          item.evidenceSha256 !== undefined &&
          item.workspaceKey === undefined &&
          index === record.attempts.length - 1,
        "invalid-transition",
        `$.attempts[${index}]`,
      );
    }
    priorAt = item.at;
  });
  requireCondition(
    state === record.state && priorAt === record.updatedAt,
    "invalid-record",
    "$.attempts",
  );
  const lastAttempt = record.attempts.at(-1);
  const expectedDisposition: ScmDeliveryDisposition =
    lastAttempt?.outcome === "failed"
      ? "failed"
      : lastAttempt?.outcome === "recovered"
        ? "recovered"
        : lastAttempt?.outcome === "confirmed" && lastAttempt.toState === "opened"
          ? "succeeded"
          : "active";
  requireCondition(record.disposition === expectedDisposition, "invalid-record", "$.disposition");
  if (record.disposition === "failed")
    requireCondition(
      lastAttempt?.outcome === "failed" &&
        lastAttempt.failureCode === record.failure?.code &&
        lastAttempt.workspaceKey === record.failure?.validation?.workspaceKey &&
        lastAttempt.evidenceSha256 ===
          (record.failure?.validation === undefined
            ? undefined
            : sha256(record.failure.validation)),
      "invalid-record",
      "$.attempts",
    );
  if (record.disposition === "recovered")
    requireCondition(
      lastAttempt?.outcome === "recovered" &&
        lastAttempt.evidenceSha256 === sha256(record.recovery!),
      "invalid-record",
      "$.attempts",
    );
  if (record.disposition === "succeeded")
    requireCondition(
      lastAttempt?.outcome === "confirmed" && lastAttempt.toState === "opened",
      "invalid-record",
      "$.attempts",
    );
  requireCondition(scmDeliveryRecordSha256(record) === record.sha256, "invalid-record", "$.sha256");
}
