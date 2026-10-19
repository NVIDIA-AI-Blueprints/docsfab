// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit } from "../contract-kit/index.js";
import type { TaskLineageRepositoryBindingV1 } from "../lineage/contracts.js";
import type { RunStatus } from "../records/contracts.js";
import type { WorkflowName } from "../workflow-contracts/contracts.js";

export const DELEGATED_TASK_RESULT_KIND = "docsfab-delegated-task-result" as const;
export const DELEGATED_TASK_RESULT_SCHEMA_VERSION = 1 as const;

export const DELEGATED_TASK_FULFILLMENTS = ["complete", "partial", "none"] as const;
export type DelegatedTaskFulfillment = (typeof DELEGATED_TASK_FULFILLMENTS)[number];

/**
 * `deadline-exceeded` is DocsFab's wall-clock budget: not an operator abort
 * (`cancelled`), and not a token or turn ceiling (`budget-exhausted`).
 */
export const DELEGATED_TASK_STOP_REASONS = [
  "finished",
  "needs-input",
  "failed",
  "cancelled",
  "budget-exhausted",
  "deadline-exceeded",
] as const;
export type DelegatedTaskStopReason = (typeof DELEGATED_TASK_STOP_REASONS)[number];

export const DELEGATED_TASK_DELIVERY_STATES = [
  "not-requested",
  "ineligible",
  "eligible",
  "attempted",
] as const;
export type DelegatedTaskDeliveryState = (typeof DELEGATED_TASK_DELIVERY_STATES)[number];

export const DELEGATED_TASK_PERSISTENCE_STATES = [
  "not-produced",
  "candidate",
  "applied",
  "persistence-failed",
] as const;
export type DelegatedTaskPersistenceState = (typeof DELEGATED_TASK_PERSISTENCE_STATES)[number];

export const DELEGATED_TASK_CHECK_STATES = [
  "not-requested",
  "not-run",
  "unknown",
  "incomplete",
  "passed",
  "failed",
] as const;
export type DelegatedTaskCheckState = (typeof DELEGATED_TASK_CHECK_STATES)[number];

export const DELEGATED_TASK_CHECK_OUTCOMES = ["not-run", "unknown", "passed", "failed"] as const;
export type DelegatedTaskCheckOutcome = (typeof DELEGATED_TASK_CHECK_OUTCOMES)[number];

export const DELEGATED_TASK_REQUIREMENT_KINDS = ["artifact", "check", "child-workflow"] as const;
export type DelegatedTaskRequirementKind = (typeof DELEGATED_TASK_REQUIREMENT_KINDS)[number];

export const DELEGATED_TASK_REQUIREMENT_STATUSES = ["met", "unmet", "unknown"] as const;
export type DelegatedTaskRequirementStatus = (typeof DELEGATED_TASK_REQUIREMENT_STATUSES)[number];

export const DELEGATED_TASK_ARTIFACT_PERSISTENCE = [
  "candidate",
  "applied",
  "persistence-failed",
] as const;
export type DelegatedTaskArtifactPersistence = (typeof DELEGATED_TASK_ARTIFACT_PERSISTENCE)[number];

export const DELEGATED_TASK_SUPPORT_CLASSES = ["supported", "unsupported-draft"] as const;
export type DelegatedTaskSupportClass = (typeof DELEGATED_TASK_SUPPORT_CLASSES)[number];

export const DELEGATED_TASK_QUALITY_CONCLUSIONS = ["not-established", "failed"] as const;
export type DelegatedTaskQualityConclusion = (typeof DELEGATED_TASK_QUALITY_CONCLUSIONS)[number];

export const DELEGATED_TASK_NEXT_ACTION_CODES = [
  "none",
  "resume-with-answers",
  "rerun-checks",
  "persist-candidate",
  "review-child-failure",
  "inspect-failure",
  "inspect-partial",
] as const;
export type DelegatedTaskNextActionCode = (typeof DELEGATED_TASK_NEXT_ACTION_CODES)[number];

export const DELEGATED_TASK_REQUEST_KINDS = ["bounded-instruction", "structured-task"] as const;
export const DELEGATED_TASK_TASK_KINDS = [
  "ia-plan",
  "site-bootstrap",
  "bounded-doc-improvement",
  "foundation-to-patch",
  "create-documentation",
  "update-documentation",
  "instruction-only",
  "none",
] as const;

export const DELEGATED_TASK_CHILD_WORKFLOWS = [
  "readiness",
  "release-documentation-readiness",
  "foundation",
  "bootstrap",
  "ia-analysis",
  "ia-plan",
  "site-bootstrap",
  "foundation-to-patch",
  "review-documentation",
  "create-documentation",
  "update-documentation",
  "restructure-documentation",
  "live-agent-turn",
] as const satisfies readonly WorkflowName[];

export const DELEGATED_TASK_CHILD_STATUSES = [
  "queued",
  "running",
  "needs-input",
  "needs-human-decision",
  "succeeded",
  "failed",
] as const satisfies readonly RunStatus[];

export type DelegatedTaskRequestIdentityV1 = {
  kind: (typeof DELEGATED_TASK_REQUEST_KINDS)[number];
  requestSha256: string;
  taskKind: (typeof DELEGATED_TASK_TASK_KINDS)[number];
  taskSha256: string;
};

export interface DelegatedTaskUsageV1 {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  turns: number;
}

export interface DelegatedTaskRequirementV1 {
  id: string;
  kind: DelegatedTaskRequirementKind;
  originalSha256: string;
  targetLocator: string;
  status: DelegatedTaskRequirementStatus;
  boundEvidenceId: string | null;
}

export interface DelegatedTaskArtifactV1 {
  evidenceId: string;
  locator: string;
  digestSha256: string;
  boundRequirementIds: readonly string[];
  persistence: DelegatedTaskArtifactPersistence;
  supportClass: DelegatedTaskSupportClass;
}

export interface DelegatedTaskCheckV1 {
  evidenceId: string;
  checkId: string;
  state: DelegatedTaskCheckOutcome;
  receiptSha256: string | null;
  boundRequirementIds: readonly string[];
}

export interface DelegatedTaskChildV1 {
  childId: string;
  workflow: WorkflowName;
  status: RunStatus;
  failureCode: string | null;
  formalQuality: DelegatedTaskQualityConclusion;
  attemptedRequirementIds: readonly string[];
}

export interface DelegatedTaskNextActionV1 {
  code: DelegatedTaskNextActionCode;
  command: string;
}

export interface DelegatedTaskResultBodyV1 {
  taskId: string;
  request: DelegatedTaskRequestIdentityV1;
  repository: TaskLineageRepositoryBindingV1;
  fulfillment: DelegatedTaskFulfillment;
  stopReason: DelegatedTaskStopReason;
  deliveryState: DelegatedTaskDeliveryState;
  persistenceState: DelegatedTaskPersistenceState;
  checkState: DelegatedTaskCheckState;
  requirements: readonly DelegatedTaskRequirementV1[];
  unmetRequirementIds: readonly string[];
  pendingQuestionIds: readonly string[];
  artifacts: readonly DelegatedTaskArtifactV1[];
  checks: readonly DelegatedTaskCheckV1[];
  children: readonly DelegatedTaskChildV1[];
  usage: DelegatedTaskUsageV1;
  nextAction: DelegatedTaskNextActionV1;
}

export type DelegatedTaskResultV1 = DelegatedTaskResultBodyV1 & {
  schemaVersion: typeof DELEGATED_TASK_RESULT_SCHEMA_VERSION;
  kind: typeof DELEGATED_TASK_RESULT_KIND;
  resultSha256: string;
};

export type DelegatedTaskResultErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required"
  | "identity-mismatch"
  | "contradictory-state";

export class DelegatedTaskResultError extends Error {
  public constructor(public readonly code: DelegatedTaskResultErrorCode) {
    super(`Delegated-task result rejected: ${code}.`);
    this.name = "DelegatedTaskResultError";
  }
}

export function failDelegatedTaskResult(code: DelegatedTaskResultErrorCode): never {
  throw new DelegatedTaskResultError(code);
}

const {
  assertInert,
  rejectCredentials,
  object,
  exact,
  array,
  string,
  identifier,
  hash,
  nullableHash,
  revision,
  enumeration,
  compare,
  unique,
  seal,
  decodeSealed,
  canonicalDigest,
  canonicalJson,
} = createContractKit({
  fail: failDelegatedTaskResult,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

export const delegatedTaskContractKit = {
  assertInert,
  rejectCredentials,
  object,
  exact,
  array,
  string,
  identifier,
  hash,
  nullableHash,
  revision,
  enumeration,
  compare,
  unique,
  canonicalDigest,
  canonicalJson,
};

export const DELEGATED_TASK_RESULT_BODY_KEYS = [
  "taskId",
  "request",
  "repository",
  "fulfillment",
  "stopReason",
  "deliveryState",
  "persistenceState",
  "checkState",
  "requirements",
  "unmetRequirementIds",
  "pendingQuestionIds",
  "artifacts",
  "checks",
  "children",
  "usage",
  "nextAction",
] as const;

export function delegatedTaskRequirementIdentitySha256(input: {
  id: string;
  kind: DelegatedTaskRequirementKind;
  targetLocator: string;
}): string {
  return canonicalDigest({
    id: input.id,
    kind: input.kind,
    targetLocator: input.targetLocator,
  });
}

export function delegatedTaskRequirementsIdentitySha256(
  requirements: readonly Pick<
    DelegatedTaskRequirementV1,
    "id" | "kind" | "originalSha256" | "targetLocator"
  >[],
): string {
  return canonicalDigest({
    requirements: [...requirements]
      .map((requirement) => ({
        id: requirement.id,
        kind: requirement.kind,
        originalSha256: requirement.originalSha256,
        targetLocator: requirement.targetLocator,
      }))
      .sort((left, right) => compare(left.id, right.id)),
  });
}

function nonNegativeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    failDelegatedTaskResult("invalid-value");
  }
  return value;
}

function boundedCommand(value: unknown): string {
  const result = string(value);
  if (result.length === 0 || result.length > 512) failDelegatedTaskResult("invalid-value");
  return result;
}

export function decodeDelegatedTaskRequestIdentity(value: unknown): DelegatedTaskRequestIdentityV1 {
  const root = object(value);
  exact(root, ["kind", "requestSha256", "taskKind", "taskSha256"]);
  const kind = enumeration(root.kind, DELEGATED_TASK_REQUEST_KINDS);
  const taskKind = enumeration(root.taskKind, DELEGATED_TASK_TASK_KINDS);
  if (kind === "structured-task" && (taskKind === "instruction-only" || taskKind === "none")) {
    failDelegatedTaskResult("invalid-value");
  }
  return {
    kind,
    requestSha256: hash(root.requestSha256),
    taskKind,
    taskSha256: hash(root.taskSha256),
  };
}

export function decodeDelegatedTaskRepositoryBinding(
  value: unknown,
): TaskLineageRepositoryBindingV1 {
  const root = object(value);
  exact(root, ["identitySha256", "revision"]);
  return { identitySha256: hash(root.identitySha256), revision: revision(root.revision) };
}

function decodeUsage(value: unknown): DelegatedTaskUsageV1 {
  const root = object(value);
  exact(root, ["input", "output", "cacheRead", "cacheWrite", "total", "turns"]);
  return {
    input: nonNegativeInt(root.input),
    output: nonNegativeInt(root.output),
    cacheRead: nonNegativeInt(root.cacheRead),
    cacheWrite: nonNegativeInt(root.cacheWrite),
    total: nonNegativeInt(root.total),
    turns: nonNegativeInt(root.turns),
  };
}

function decodeRequirementIds(value: unknown): readonly string[] {
  const ids = array(value).map(identifier).sort(compare);
  unique(ids);
  return Object.freeze(ids);
}

function decodeRequirement(value: unknown): DelegatedTaskRequirementV1 {
  const root = object(value);
  exact(root, ["id", "kind", "originalSha256", "targetLocator", "status", "boundEvidenceId"]);
  const id = identifier(root.id);
  const kind = enumeration(root.kind, DELEGATED_TASK_REQUIREMENT_KINDS);
  const targetLocator = identifier(root.targetLocator);
  const originalSha256 = hash(root.originalSha256);
  if (originalSha256 !== delegatedTaskRequirementIdentitySha256({ id, kind, targetLocator })) {
    failDelegatedTaskResult("identity-mismatch");
  }
  const boundEvidenceId = root.boundEvidenceId === null ? null : identifier(root.boundEvidenceId);
  return {
    id,
    kind,
    originalSha256,
    targetLocator,
    status: enumeration(root.status, DELEGATED_TASK_REQUIREMENT_STATUSES),
    boundEvidenceId,
  };
}

function decodeArtifact(value: unknown): DelegatedTaskArtifactV1 {
  const root = object(value);
  exact(root, [
    "evidenceId",
    "locator",
    "digestSha256",
    "boundRequirementIds",
    "persistence",
    "supportClass",
  ]);
  return {
    evidenceId: identifier(root.evidenceId),
    locator: identifier(root.locator),
    digestSha256: hash(root.digestSha256),
    boundRequirementIds: decodeRequirementIds(root.boundRequirementIds),
    persistence: enumeration(root.persistence, DELEGATED_TASK_ARTIFACT_PERSISTENCE),
    supportClass: enumeration(root.supportClass, DELEGATED_TASK_SUPPORT_CLASSES),
  };
}

function decodeCheck(value: unknown): DelegatedTaskCheckV1 {
  const root = object(value);
  exact(root, ["evidenceId", "checkId", "state", "receiptSha256", "boundRequirementIds"]);
  const state = enumeration(root.state, DELEGATED_TASK_CHECK_OUTCOMES);
  const receiptSha256 = nullableHash(root.receiptSha256);
  if (state === "passed" && receiptSha256 === null) failDelegatedTaskResult("invalid-value");
  if ((state === "not-run" || state === "unknown") && receiptSha256 !== null) {
    failDelegatedTaskResult("invalid-value");
  }
  return {
    evidenceId: identifier(root.evidenceId),
    checkId: identifier(root.checkId),
    state,
    receiptSha256,
    boundRequirementIds: decodeRequirementIds(root.boundRequirementIds),
  };
}

function decodeChild(value: unknown): DelegatedTaskChildV1 {
  const root = object(value);
  exact(root, [
    "childId",
    "workflow",
    "status",
    "failureCode",
    "formalQuality",
    "attemptedRequirementIds",
  ]);
  const status = enumeration(root.status, DELEGATED_TASK_CHILD_STATUSES);
  const failureCode = root.failureCode === null ? null : identifier(root.failureCode);
  if (status === "failed" ? failureCode === null : failureCode !== null) {
    failDelegatedTaskResult("invalid-value");
  }
  return {
    childId: identifier(root.childId),
    workflow: enumeration(root.workflow, DELEGATED_TASK_CHILD_WORKFLOWS),
    status,
    failureCode,
    formalQuality: enumeration(root.formalQuality, DELEGATED_TASK_QUALITY_CONCLUSIONS),
    attemptedRequirementIds: decodeRequirementIds(root.attemptedRequirementIds),
  };
}

function decodeNextAction(value: unknown): DelegatedTaskNextActionV1 {
  const root = object(value);
  exact(root, ["code", "command"]);
  return {
    code: enumeration(root.code, DELEGATED_TASK_NEXT_ACTION_CODES),
    command: boundedCommand(root.command),
  };
}

export function aggregateDelegatedTaskPersistence(
  artifacts: readonly DelegatedTaskArtifactV1[],
): DelegatedTaskPersistenceState {
  if (artifacts.some((artifact) => artifact.persistence === "persistence-failed")) {
    return "persistence-failed";
  }
  if (artifacts.some((artifact) => artifact.persistence === "applied")) return "applied";
  if (artifacts.some((artifact) => artifact.persistence === "candidate")) return "candidate";
  return "not-produced";
}

export function aggregateDelegatedTaskCheckState(
  requirements: readonly DelegatedTaskRequirementV1[],
  checks: readonly DelegatedTaskCheckV1[],
): DelegatedTaskCheckState {
  const required = requirements.filter((requirement) => requirement.kind === "check");
  if (required.length === 0) return "not-requested";
  const states = required.map((requirement) => {
    const bound = checks.find(
      (check) =>
        check.checkId === requirement.targetLocator &&
        check.boundRequirementIds.includes(requirement.id),
    );
    return bound?.state ?? "not-run";
  });
  if (states.some((state) => state === "failed")) return "failed";
  if (states.every((state) => state === "passed")) return "passed";
  if (states.every((state) => state === "not-run")) return "not-run";
  if (states.every((state) => state === "unknown")) return "unknown";
  return "incomplete";
}

export function computeDelegatedTaskFulfillment(input: {
  requirements: readonly DelegatedTaskRequirementV1[];
  artifacts: readonly DelegatedTaskArtifactV1[];
  checks: readonly DelegatedTaskCheckV1[];
  pendingQuestionIds: readonly string[];
  stopReason: DelegatedTaskStopReason;
  persistenceState: DelegatedTaskPersistenceState;
  checkState: DelegatedTaskCheckState;
}): DelegatedTaskFulfillment {
  const allMet =
    input.requirements.length > 0 &&
    input.requirements.every((requirement) => requirement.status === "met");
  const anyUseful =
    input.requirements.some((requirement) => requirement.status === "met") ||
    input.artifacts.length > 0 ||
    input.checks.some((check) => check.state === "passed");
  const checksOk = input.checkState === "passed" || input.checkState === "not-requested";
  const artifactRequired = input.requirements.some(
    (requirement) => requirement.kind === "artifact",
  );
  if (
    allMet &&
    input.pendingQuestionIds.length === 0 &&
    input.stopReason === "finished" &&
    checksOk &&
    input.persistenceState !== "persistence-failed" &&
    (!artifactRequired || input.persistenceState === "applied")
  ) {
    return "complete";
  }
  return anyUseful ? "partial" : "none";
}

export function computeDelegatedTaskNextAction(input: {
  taskId: string;
  fulfillment: DelegatedTaskFulfillment;
  stopReason: DelegatedTaskStopReason;
  persistenceState: DelegatedTaskPersistenceState;
  checkState: DelegatedTaskCheckState;
  children: readonly DelegatedTaskChildV1[];
}): DelegatedTaskNextActionV1 {
  if (input.stopReason === "needs-input") {
    return {
      code: "resume-with-answers",
      command: `docsfab do --resume ${input.taskId} --answers <json-file>`,
    };
  }
  if (input.fulfillment === "complete" && input.stopReason === "finished") {
    return { code: "none", command: "none" };
  }
  if (input.persistenceState === "persistence-failed") {
    return { code: "persist-candidate", command: `inspect-persistence:${input.taskId}` };
  }
  if (
    input.checkState === "not-run" ||
    input.checkState === "incomplete" ||
    input.checkState === "unknown"
  ) {
    return { code: "rerun-checks", command: `rerun-checks:${input.taskId}` };
  }
  if (
    input.children.some((child) => child.status === "failed" || child.formalQuality === "failed")
  ) {
    return { code: "review-child-failure", command: `review-child:${input.taskId}` };
  }
  if (
    input.stopReason === "cancelled" ||
    input.stopReason === "budget-exhausted" ||
    input.stopReason === "deadline-exceeded"
  ) {
    return { code: "inspect-partial", command: `inspect-partial:${input.taskId}` };
  }
  return { code: "inspect-failure", command: `inspect-failure:${input.taskId}` };
}

function assertResultInvariants(body: DelegatedTaskResultBodyV1): void {
  const requirementIds = body.requirements.map((requirement) => requirement.id);
  unique(requirementIds);
  unique(body.artifacts.map((artifact) => artifact.evidenceId));
  unique(body.checks.map((check) => check.evidenceId));
  unique(body.children.map((child) => child.childId));
  const knownIds = new Set(requirementIds);
  for (const artifact of body.artifacts) {
    if (artifact.boundRequirementIds.some((id) => !knownIds.has(id))) {
      failDelegatedTaskResult("invalid-value");
    }
  }
  for (const check of body.checks) {
    if (check.boundRequirementIds.some((id) => !knownIds.has(id))) {
      failDelegatedTaskResult("invalid-value");
    }
  }
  for (const child of body.children) {
    if (child.attemptedRequirementIds.some((id) => !knownIds.has(id))) {
      failDelegatedTaskResult("invalid-value");
    }
  }
  const expectedUnmet = body.requirements
    .filter((requirement) => requirement.status !== "met")
    .map((requirement) => requirement.id)
    .sort(compare);
  if (body.unmetRequirementIds.join("\0") !== expectedUnmet.join("\0")) {
    failDelegatedTaskResult("contradictory-state");
  }
  const persistenceState = aggregateDelegatedTaskPersistence(body.artifacts);
  const checkState = aggregateDelegatedTaskCheckState(body.requirements, body.checks);
  if (body.persistenceState !== persistenceState || body.checkState !== checkState) {
    failDelegatedTaskResult("contradictory-state");
  }
  const pending = body.pendingQuestionIds.length > 0;
  if (pending !== (body.stopReason === "needs-input")) {
    failDelegatedTaskResult("contradictory-state");
  }
  const fulfillment = computeDelegatedTaskFulfillment({
    requirements: body.requirements,
    artifacts: body.artifacts,
    checks: body.checks,
    pendingQuestionIds: body.pendingQuestionIds,
    stopReason: body.stopReason,
    persistenceState,
    checkState,
  });
  if (body.fulfillment !== fulfillment) failDelegatedTaskResult("contradictory-state");
  if (body.fulfillment === "complete" && body.stopReason !== "finished") {
    failDelegatedTaskResult("contradictory-state");
  }
  const nextAction = computeDelegatedTaskNextAction({
    taskId: body.taskId,
    fulfillment: body.fulfillment,
    stopReason: body.stopReason,
    persistenceState,
    checkState,
    children: body.children,
  });
  if (body.nextAction.code !== nextAction.code || body.nextAction.command !== nextAction.command) {
    failDelegatedTaskResult("contradictory-state");
  }
  const expectedTaskSha256 = delegatedTaskRequirementsIdentitySha256(body.requirements);
  if (body.request.taskSha256 !== expectedTaskSha256) {
    failDelegatedTaskResult("identity-mismatch");
  }
}

function normalizeBody(root: Record<string, unknown>): DelegatedTaskResultBodyV1 {
  const requirements = array(root.requirements)
    .map(decodeRequirement)
    .sort((left, right) => compare(left.id, right.id));
  unique(requirements.map((requirement) => requirement.id));
  const artifacts = array(root.artifacts)
    .map(decodeArtifact)
    .sort((left, right) => compare(left.evidenceId, right.evidenceId));
  const checks = array(root.checks)
    .map(decodeCheck)
    .sort((left, right) => compare(left.evidenceId, right.evidenceId));
  const children = array(root.children)
    .map(decodeChild)
    .sort((left, right) => compare(left.childId, right.childId));
  const body: DelegatedTaskResultBodyV1 = {
    taskId: identifier(root.taskId),
    request: decodeDelegatedTaskRequestIdentity(root.request),
    repository: decodeDelegatedTaskRepositoryBinding(root.repository),
    fulfillment: enumeration(root.fulfillment, DELEGATED_TASK_FULFILLMENTS),
    stopReason: enumeration(root.stopReason, DELEGATED_TASK_STOP_REASONS),
    deliveryState: enumeration(root.deliveryState, DELEGATED_TASK_DELIVERY_STATES),
    persistenceState: enumeration(root.persistenceState, DELEGATED_TASK_PERSISTENCE_STATES),
    checkState: enumeration(root.checkState, DELEGATED_TASK_CHECK_STATES),
    requirements: Object.freeze(requirements),
    unmetRequirementIds: decodeRequirementIds(root.unmetRequirementIds),
    pendingQuestionIds: decodeRequirementIds(root.pendingQuestionIds),
    artifacts: Object.freeze(artifacts),
    checks: Object.freeze(checks),
    children: Object.freeze(children),
    usage: decodeUsage(root.usage),
    nextAction: decodeNextAction(root.nextAction),
  };
  assertResultInvariants(body);
  return body;
}

export function createDelegatedTaskResult(input: DelegatedTaskResultBodyV1): DelegatedTaskResultV1 {
  assertInert(input);
  rejectCredentials(input);
  const root = object(input);
  exact(root, [...DELEGATED_TASK_RESULT_BODY_KEYS]);
  return seal(
    DELEGATED_TASK_RESULT_KIND,
    "resultSha256",
    normalizeBody(root),
  ) as DelegatedTaskResultV1;
}

export function decodeDelegatedTaskResult(value: unknown): DelegatedTaskResultV1 {
  return decodeSealed(
    value,
    DELEGATED_TASK_RESULT_KIND,
    "resultSha256",
    [...DELEGATED_TASK_RESULT_BODY_KEYS],
    normalizeBody,
  ) as DelegatedTaskResultV1;
}
