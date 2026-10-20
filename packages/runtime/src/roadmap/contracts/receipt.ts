// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ROADMAP_LEDGER_SCHEMA_VERSION, type RoadmapLedger } from "./ledger.js";
import {
  issueIidFromTarget,
  type RoadmapMutationOperation,
  type RoadmapMutationPlan,
  type RoadmapMutationPrecondition,
} from "./mutation.js";
import {
  validateRoadmapMutationAuthorization,
  type RoadmapMutationAuthorization,
} from "./authorization.js";
import {
  RoadmapContractError,
  internalRoadmapDecode,
  roadmapDigest,
  type RoadmapContractErrorCode,
} from "./decode.js";

const {
  closed,
  array,
  identifier,
  externalIdentifier,
  timestamp,
  digest,
  positiveInteger,
  enumeration,
  freeze,
} = internalRoadmapDecode;

const requireValue: (
  condition: unknown,
  code: RoadmapContractErrorCode,
  path: string,
) => asserts condition = internalRoadmapDecode.requireValue;

export const ROADMAP_ATTEMPT_DISPOSITIONS = ["succeeded", "failed", "reused", "skipped"] as const;
export type RoadmapAttemptDisposition = (typeof ROADMAP_ATTEMPT_DISPOSITIONS)[number];

export interface RoadmapTrackerIdentity {
  targetKey: string;
  externalId: string;
  state: string;
  updatedAt: string;
  identityDigest: string;
}
export interface RoadmapMutationAttempt {
  operationKey: string;
  attempt: number;
  disposition: RoadmapAttemptDisposition;
  startedAt: string;
  completedAt: string;
  before?: RoadmapTrackerIdentity;
  after?: RoadmapTrackerIdentity;
  failureCode?: string;
  reusedOperationKey?: string;
}

export interface RoadmapMutationReceipt {
  kind: "roadmap-mutation-receipt";
  schemaVersion: typeof ROADMAP_LEDGER_SCHEMA_VERSION;
  id: string;
  planDigest: string;
  authorizationDigest: string;
  attempts: RoadmapMutationAttempt[];
  terminal: "complete" | "partial" | "failed";
  createdAt: string;
  completedAt: string;
  digest: string;
}

export function createRoadmapMutationReceipt(
  input: Omit<
    RoadmapMutationReceipt,
    "kind" | "schemaVersion" | "digest" | "planDigest" | "authorizationDigest"
  >,
  ledger: RoadmapLedger,
  plan: RoadmapMutationPlan,
  authorization: RoadmapMutationAuthorization,
): RoadmapMutationReceipt {
  const candidate = {
    kind: "roadmap-mutation-receipt" as const,
    schemaVersion: ROADMAP_LEDGER_SCHEMA_VERSION,
    ...input,
    planDigest: plan.digest,
    authorizationDigest: authorization.digest,
    digest: "0".repeat(64),
  };
  candidate.digest = roadmapDigest(candidate);
  return validateRoadmapMutationReceipt(candidate, ledger, plan, authorization);
}

export function validateRoadmapMutationReceipt(
  value: unknown,
  ledger: RoadmapLedger,
  plan: RoadmapMutationPlan,
  authorization: RoadmapMutationAuthorization,
): RoadmapMutationReceipt {
  validateRoadmapMutationAuthorization(authorization, plan, ledger);
  const root = closed(value, "$", [
    "kind",
    "schemaVersion",
    "id",
    "planDigest",
    "authorizationDigest",
    "attempts",
    "terminal",
    "createdAt",
    "completedAt",
    "digest",
  ]);
  requireValue(
    root.kind === "roadmap-mutation-receipt" &&
      root.schemaVersion === ROADMAP_LEDGER_SCHEMA_VERSION,
    "invalid-value",
    "$",
  );
  const receipt: RoadmapMutationReceipt = {
    kind: "roadmap-mutation-receipt",
    schemaVersion: ROADMAP_LEDGER_SCHEMA_VERSION,
    id: identifier(root.id, "$.id"),
    planDigest: digest(root.planDigest, "$.planDigest"),
    authorizationDigest: digest(root.authorizationDigest, "$.authorizationDigest"),
    attempts: array(root.attempts, "$.attempts").map((item, index) =>
      attempt(item, `$.attempts[${index}]`),
    ),
    terminal: enumeration(root.terminal, ["complete", "partial", "failed"] as const, "$.terminal"),
    createdAt: timestamp(root.createdAt, "$.createdAt"),
    completedAt: timestamp(root.completedAt, "$.completedAt"),
    digest: digest(root.digest, "$.digest"),
  };
  requireValue(receipt.planDigest === plan.digest, "digest-mismatch", "$.planDigest");
  requireValue(
    receipt.authorizationDigest === authorization.digest,
    "digest-mismatch",
    "$.authorizationDigest",
  );
  requireValue(
    Date.parse(receipt.createdAt) <= Date.parse(receipt.completedAt),
    "invalid-time",
    "$.completedAt",
  );
  requireValue(
    Date.parse(plan.generatedAt) <= Date.parse(receipt.createdAt) &&
      Date.parse(receipt.completedAt) <= Date.parse(plan.expiresAt),
    "expired",
    "$.completedAt",
  );
  requireValue(
    Date.parse(authorization.issuedAt) <= Date.parse(receipt.createdAt) &&
      Date.parse(receipt.completedAt) <= Date.parse(authorization.expiresAt),
    "expired",
    "$.completedAt",
  );
  validateAttempts(receipt, ledger, plan, authorization);
  requireValue(roadmapDigest(receipt) === receipt.digest, "digest-mismatch", "$.digest");
  return freeze(receipt);
}

function validateAttempts(
  receipt: RoadmapMutationReceipt,
  ledger: RoadmapLedger,
  plan: RoadmapMutationPlan,
  authorization: RoadmapMutationAuthorization,
): void {
  const operations = new Map(plan.operations.map((item) => [item.key, item]));
  const authorized = new Set(authorization.authorizedOperationKeys);
  const attemptsByOperation = new Map<string, RoadmapMutationAttempt[]>();
  const successfulAt = new Map<string, string>();
  for (const item of receipt.attempts) {
    requireValue(
      operations.has(item.operationKey) && authorized.has(item.operationKey),
      "operation-expansion",
      `$.attempts.${item.operationKey}`,
    );
    const entries = attemptsByOperation.get(item.operationKey) ?? [];
    requireValue(
      item.attempt === entries.length + 1,
      "invalid-value",
      `$.attempts.${item.operationKey}.attempt`,
    );
    requireValue(
      Date.parse(item.startedAt) <= Date.parse(item.completedAt),
      "invalid-time",
      `$.attempts.${item.operationKey}.completedAt`,
    );
    requireValue(
      item.attempt === 1 || entries.at(-1)?.disposition === "failed",
      "invalid-value",
      `$.attempts.${item.operationKey}.attempt`,
    );
    if (entries.length > 0) {
      requireValue(
        Date.parse(entries.at(-1)!.completedAt) <= Date.parse(item.startedAt),
        "invalid-time",
        `$.attempts.${item.operationKey}.startedAt`,
      );
    }
    requireValue(
      Date.parse(receipt.createdAt) <= Date.parse(item.startedAt) &&
        Date.parse(item.completedAt) <= Date.parse(receipt.completedAt),
      "invalid-time",
      `$.attempts.${item.operationKey}`,
    );
    requireValue(
      Date.parse(plan.generatedAt) <= Date.parse(item.startedAt) &&
        Date.parse(item.completedAt) <= Date.parse(plan.expiresAt),
      "expired",
      `$.attempts.${item.operationKey}`,
    );
    requireValue(
      Date.parse(authorization.issuedAt) <= Date.parse(item.startedAt) &&
        Date.parse(item.completedAt) <= Date.parse(authorization.expiresAt),
      "expired",
      `$.attempts.${item.operationKey}`,
    );
    validateAttemptDisposition(item, operations);
    if (item.disposition === "reused") {
      requireValue(
        item.reusedOperationKey === item.operationKey,
        "unresolved-dependency",
        `$.attempts.${item.operationKey}.reusedOperationKey`,
      );
      requireValue(
        item.before !== undefined && sameTrackerIdentity(item.before, item.after!),
        "tracker-drift",
        `$.attempts.${item.operationKey}`,
      );
      validateObservedReuse(item, operations.get(item.operationKey)!, ledger);
    }
    const operation = operations.get(item.operationKey)!;
    if (operation.precondition) {
      if (item.before)
        requireValue(
          matchesPrecondition(item.before, operation.precondition),
          "tracker-drift",
          `$.attempts.${item.operationKey}.before`,
        );
      if (item.disposition === "succeeded" || item.disposition === "reused") {
        requireValue(
          item.before !== undefined,
          "missing-field",
          `$.attempts.${item.operationKey}.before`,
        );
        const issueIid = issueIidFromTarget(operation.targetKey);
        const observed = ledger.tracker.find((entry) => entry.issueIid === issueIid);
        requireValue(
          observed !== undefined &&
            item.before.externalId === String(issueIid) &&
            item.before.state === observed.state,
          "tracker-drift",
          `$.attempts.${item.operationKey}.before`,
        );
      }
      if (item.after)
        requireValue(
          item.after.targetKey === operation.targetKey,
          "tracker-drift",
          `$.attempts.${item.operationKey}.after.targetKey`,
        );
    }
    validateAttemptTargetEvidence(item, operation, ledger);
    if (item.before && item.after) {
      requireValue(
        Date.parse(item.before.updatedAt) <= Date.parse(item.after.updatedAt),
        "tracker-drift",
        `$.attempts.${item.operationKey}.after.updatedAt`,
      );
    }
    if (item.before) {
      requireValue(
        Date.parse(item.before.updatedAt) <= Date.parse(item.completedAt),
        "invalid-time",
        `$.attempts.${item.operationKey}.before.updatedAt`,
      );
    }
    if (item.after) {
      requireValue(
        Date.parse(item.after.updatedAt) <= Date.parse(item.completedAt),
        "invalid-time",
        `$.attempts.${item.operationKey}.after.updatedAt`,
      );
    }
    if (item.disposition === "succeeded") {
      requireValue(
        Date.parse(item.startedAt) <= Date.parse(item.after!.updatedAt) &&
          Date.parse(item.after!.updatedAt) <= Date.parse(item.completedAt),
        "invalid-time",
        `$.attempts.${item.operationKey}.after.updatedAt`,
      );
    }
    if (item.disposition === "succeeded" || item.disposition === "reused") {
      for (const dependency of operation.dependsOnOperationKeys) {
        const completedAt = successfulAt.get(dependency);
        requireValue(
          completedAt !== undefined && Date.parse(completedAt) <= Date.parse(item.startedAt),
          "unresolved-dependency",
          `$.attempts.${item.operationKey}`,
        );
      }
      successfulAt.set(item.operationKey, item.completedAt);
    }
    entries.push(item);
    attemptsByOperation.set(item.operationKey, entries);
  }
  const terminalDispositions = [...attemptsByOperation.values()].map(
    (items) => items.at(-1)!.disposition,
  );
  const completed = authorization.authorizedOperationKeys.every((key) => {
    const disposition = attemptsByOperation.get(key)?.at(-1)?.disposition;
    return disposition === "succeeded" || disposition === "reused" || disposition === "skipped";
  });
  if (receipt.terminal === "complete")
    requireValue(completed, "unresolved-dependency", "$.terminal");
  if (receipt.terminal === "failed")
    requireValue(
      terminalDispositions.length > 0 && terminalDispositions.every((item) => item === "failed"),
      "invalid-value",
      "$.terminal",
    );
  if (receipt.terminal === "partial")
    requireValue(
      !completed && terminalDispositions.some((item) => item === "succeeded" || item === "reused"),
      "invalid-value",
      "$.terminal",
    );
}

function validateAttemptDisposition(
  item: RoadmapMutationAttempt,
  operations: Map<string, RoadmapMutationOperation>,
): void {
  if (item.disposition === "succeeded") {
    requireValue(
      item.after !== undefined &&
        item.failureCode === undefined &&
        item.reusedOperationKey === undefined,
      "invalid-value",
      `$.attempts.${item.operationKey}`,
    );
  } else if (item.disposition === "failed") {
    requireValue(
      item.failureCode !== undefined &&
        item.after === undefined &&
        item.reusedOperationKey === undefined,
      "invalid-value",
      `$.attempts.${item.operationKey}`,
    );
  } else if (item.disposition === "reused") {
    requireValue(
      item.before !== undefined &&
        item.after !== undefined &&
        item.reusedOperationKey !== undefined &&
        operations.has(item.reusedOperationKey),
      "invalid-value",
      `$.attempts.${item.operationKey}`,
    );
  } else {
    requireValue(
      item.failureCode !== undefined &&
        item.after === undefined &&
        item.reusedOperationKey === undefined,
      "invalid-value",
      `$.attempts.${item.operationKey}`,
    );
  }
}

function validateAttemptTargetEvidence(
  attemptItem: RoadmapMutationAttempt,
  operationItem: RoadmapMutationOperation,
  ledger: RoadmapLedger,
): void {
  if (attemptItem.disposition !== "succeeded" && attemptItem.disposition !== "reused") return;
  const after = attemptItem.after!;
  if (operationItem.kind === "issue" || operationItem.kind === "saga") {
    requireValue(
      /^issue:[1-9][0-9]*$/u.test(after.targetKey) &&
        after.targetKey === `issue:${after.externalId}` &&
        after.state === "opened",
      "tracker-drift",
      `$.attempts.${attemptItem.operationKey}.after`,
    );
    if (attemptItem.disposition === "succeeded") {
      requireValue(
        attemptItem.before === undefined,
        "invalid-value",
        `$.attempts.${attemptItem.operationKey}.before`,
      );
      requireValue(
        operationItem.findingIds.every(
          (findingId) =>
            ledger.dedup.find((item) => item.findingId === findingId)?.decision === "create",
        ),
        "unresolved-dependency",
        `$.attempts.${attemptItem.operationKey}.disposition`,
      );
    }
    return;
  }
  if (operationItem.kind === "milestone") {
    requireValue(
      /^milestone:[1-9][0-9]*$/u.test(after.targetKey) &&
        after.targetKey === `milestone:${after.externalId}` &&
        after.state === "active" &&
        attemptItem.before === undefined,
      "tracker-drift",
      `$.attempts.${attemptItem.operationKey}.after`,
    );
    return;
  }
  const issueIid = issueIidFromTarget(operationItem.targetKey);
  requireValue(
    issueIid !== undefined && after.externalId === String(issueIid),
    "tracker-drift",
    `$.attempts.${attemptItem.operationKey}.after.externalId`,
  );
  if (operationItem.proposal.kind === "closure") {
    const expectedState = operationItem.proposal.action === "close" ? "closed" : "opened";
    requireValue(
      after.state === expectedState,
      "tracker-drift",
      `$.attempts.${attemptItem.operationKey}.after.state`,
    );
  } else {
    requireValue(
      attemptItem.before !== undefined && after.state === attemptItem.before.state,
      "tracker-drift",
      `$.attempts.${attemptItem.operationKey}.after.state`,
    );
  }
}

function validateObservedReuse(
  attemptItem: RoadmapMutationAttempt,
  operationItem: RoadmapMutationOperation,
  ledger: RoadmapLedger,
): void {
  requireValue(
    operationItem.kind === "issue" || operationItem.kind === "saga",
    "invalid-value",
    `$.attempts.${attemptItem.operationKey}.disposition`,
  );
  const decisions = operationItem.findingIds.map((findingId) =>
    ledger.dedup.find((item) => item.findingId === findingId),
  );
  requireValue(
    decisions.every((item) => item?.decision === "reuse" && item.issueIid !== undefined),
    "unresolved-dependency",
    `$.attempts.${attemptItem.operationKey}.disposition`,
  );
  const issueIids = new Set(decisions.map((item) => item!.issueIid!));
  requireValue(
    issueIids.size === 1,
    "unresolved-dependency",
    `$.attempts.${attemptItem.operationKey}.disposition`,
  );
  const issueIid = [...issueIids][0]!;
  const observed = ledger.tracker.find((item) => item.issueIid === issueIid);
  requireValue(
    observed !== undefined &&
      attemptItem.before !== undefined &&
      attemptItem.before.targetKey === `issue:${issueIid}` &&
      attemptItem.before.externalId === String(issueIid) &&
      attemptItem.before.updatedAt === observed.updatedAt &&
      attemptItem.before.identityDigest === observed.identityDigest &&
      attemptItem.before.state === observed.state,
    "tracker-drift",
    `$.attempts.${attemptItem.operationKey}.before`,
  );
}

function matchesPrecondition(
  identity: RoadmapTrackerIdentity,
  expected: RoadmapMutationPrecondition,
): boolean {
  return (
    identity.targetKey === expected.targetKey &&
    identity.updatedAt === expected.observedAt &&
    identity.identityDigest === expected.identityDigest
  );
}

function sameTrackerIdentity(left: RoadmapTrackerIdentity, right: RoadmapTrackerIdentity): boolean {
  return (
    left.targetKey === right.targetKey &&
    left.externalId === right.externalId &&
    left.state === right.state &&
    left.updatedAt === right.updatedAt &&
    left.identityDigest === right.identityDigest
  );
}

function attempt(value: unknown, path: string): RoadmapMutationAttempt {
  const item = closed(
    value,
    path,
    [
      "operationKey",
      "attempt",
      "disposition",
      "startedAt",
      "completedAt",
      "before",
      "after",
      "failureCode",
      "reusedOperationKey",
    ],
    ["operationKey", "attempt", "disposition", "startedAt", "completedAt"],
  );
  return {
    operationKey: identifier(item.operationKey, `${path}.operationKey`),
    attempt: positiveInteger(item.attempt, `${path}.attempt`),
    disposition: enumeration(item.disposition, ROADMAP_ATTEMPT_DISPOSITIONS, `${path}.disposition`),
    startedAt: timestamp(item.startedAt, `${path}.startedAt`),
    completedAt: timestamp(item.completedAt, `${path}.completedAt`),
    ...(item.before === undefined
      ? {}
      : { before: trackerIdentity(item.before, `${path}.before`) }),
    ...(item.after === undefined ? {} : { after: trackerIdentity(item.after, `${path}.after`) }),
    ...(item.failureCode === undefined
      ? {}
      : { failureCode: identifier(item.failureCode, `${path}.failureCode`) }),
    ...(item.reusedOperationKey === undefined
      ? {}
      : { reusedOperationKey: identifier(item.reusedOperationKey, `${path}.reusedOperationKey`) }),
  };
}

function trackerIdentity(value: unknown, path: string): RoadmapTrackerIdentity {
  const item = closed(value, path, [
    "targetKey",
    "externalId",
    "state",
    "updatedAt",
    "identityDigest",
  ]);
  return {
    targetKey: identifier(item.targetKey, `${path}.targetKey`),
    externalId: externalIdentifier(item.externalId, `${path}.externalId`),
    state: identifier(item.state, `${path}.state`),
    updatedAt: timestamp(item.updatedAt, `${path}.updatedAt`),
    identityDigest: digest(item.identityDigest, `${path}.identityDigest`),
  };
}
