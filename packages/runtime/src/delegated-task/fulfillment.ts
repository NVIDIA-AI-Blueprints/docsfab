// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  DELEGATED_TASK_STOP_REASONS,
  aggregateDelegatedTaskCheckState,
  aggregateDelegatedTaskPersistence,
  computeDelegatedTaskFulfillment,
  computeDelegatedTaskNextAction,
  createDelegatedTaskResult,
  delegatedTaskContractKit,
  delegatedTaskRequirementIdentitySha256,
  delegatedTaskRequirementsIdentitySha256,
  failDelegatedTaskResult,
  type DelegatedTaskArtifactPersistence,
  type DelegatedTaskArtifactV1,
  type DelegatedTaskCheckOutcome,
  type DelegatedTaskCheckV1,
  type DelegatedTaskChildV1,
  type DelegatedTaskDeliveryState,
  type DelegatedTaskQualityConclusion,
  type DelegatedTaskRequestIdentityV1,
  type DelegatedTaskRequirementKind,
  type DelegatedTaskRequirementStatus,
  type DelegatedTaskRequirementV1,
  type DelegatedTaskResultV1,
  type DelegatedTaskStopReason,
  type DelegatedTaskSupportClass,
  type DelegatedTaskUsageV1,
} from "./result-contract.js";
import type { TaskLineageRepositoryBindingV1 } from "../lineage/contracts.js";
import type { RunStatus } from "../records/contracts.js";
import type { WorkflowName } from "../workflow-contracts/contracts.js";

const {
  assertInert,
  rejectCredentials,
  object,
  exact,
  array,
  identifier,
  hash,
  nullableHash,
  revision,
  enumeration,
  compare,
  unique,
} = delegatedTaskContractKit;

export interface DelegatedTaskRequirementInputV1 {
  id: string;
  kind: DelegatedTaskRequirementKind;
  originalSha256: string;
  targetLocator: string;
}

export interface DelegatedTaskArtifactEvidenceV1 {
  evidenceId: string;
  taskId: string;
  taskSha256: string;
  repositoryIdentitySha256: string;
  repositoryRevision: string;
  locator: string;
  digestSha256: string;
  boundRequirementIds: readonly string[];
  persistence: DelegatedTaskArtifactPersistence;
  supportClass: DelegatedTaskSupportClass;
}

export interface DelegatedTaskCheckEvidenceV1 {
  evidenceId: string;
  taskId: string;
  taskSha256: string;
  repositoryIdentitySha256: string;
  repositoryRevision: string;
  checkId: string;
  state: DelegatedTaskCheckOutcome;
  receiptSha256: string | null;
  boundRequirementIds: readonly string[];
}

export interface DelegatedTaskChildEvidenceV1 {
  childId: string;
  taskId: string;
  taskSha256: string;
  repositoryIdentitySha256: string;
  repositoryRevision: string;
  workflow: WorkflowName;
  status: RunStatus;
  failureCode: string | null;
  formalQuality: DelegatedTaskQualityConclusion;
  attemptedRequirementIds: readonly string[];
}

export interface DelegatedTaskFulfillmentInputV1 {
  taskId: string;
  request: DelegatedTaskRequestIdentityV1;
  repository: TaskLineageRepositoryBindingV1;
  originalRequirements: readonly DelegatedTaskRequirementInputV1[];
  planRequirementIds: readonly string[];
  stopReason: DelegatedTaskStopReason;
  deliveryState: DelegatedTaskDeliveryState;
  artifacts: readonly DelegatedTaskArtifactEvidenceV1[];
  checks: readonly DelegatedTaskCheckEvidenceV1[];
  children: readonly DelegatedTaskChildEvidenceV1[];
  pendingQuestions: readonly { questionId: string }[];
  usage: DelegatedTaskUsageV1;
}

/** Model prose and semantic scores cannot attest fulfillment; they are ignored. */
export interface DelegatedTaskIgnoredAttestationV1 {
  readonly modelProseClaim?: string;
  readonly semanticAssessment?: "pass" | "fail";
}

const INPUT_KEYS = [
  "taskId",
  "request",
  "repository",
  "originalRequirements",
  "planRequirementIds",
  "stopReason",
  "deliveryState",
  "artifacts",
  "checks",
  "children",
  "pendingQuestions",
  "usage",
] as const;

function identityMatches(
  evidence: {
    taskId: string;
    taskSha256: string;
    repositoryIdentitySha256: string;
    repositoryRevision: string;
  },
  taskId: string,
  request: DelegatedTaskRequestIdentityV1,
  repository: TaskLineageRepositoryBindingV1,
): boolean {
  return (
    evidence.taskId === taskId &&
    evidence.taskSha256 === request.taskSha256 &&
    evidence.repositoryIdentitySha256 === repository.identitySha256 &&
    evidence.repositoryRevision === repository.revision
  );
}

function decodeRequirementInput(value: unknown): DelegatedTaskRequirementInputV1 {
  const root = object(value);
  exact(root, ["id", "kind", "originalSha256", "targetLocator"]);
  const id = identifier(root.id);
  const kind = enumeration(root.kind, ["artifact", "check", "child-workflow"] as const);
  const targetLocator = identifier(root.targetLocator);
  const originalSha256 = hash(root.originalSha256);
  if (originalSha256 !== delegatedTaskRequirementIdentitySha256({ id, kind, targetLocator })) {
    failDelegatedTaskResult("identity-mismatch");
  }
  return { id, kind, originalSha256, targetLocator };
}

function decodeBoundIds(value: unknown): readonly string[] {
  const ids = array(value).map(identifier).sort(compare);
  unique(ids);
  return Object.freeze(ids);
}

function decodeArtifactEvidence(value: unknown): DelegatedTaskArtifactEvidenceV1 {
  const root = object(value);
  exact(root, [
    "evidenceId",
    "taskId",
    "taskSha256",
    "repositoryIdentitySha256",
    "repositoryRevision",
    "locator",
    "digestSha256",
    "boundRequirementIds",
    "persistence",
    "supportClass",
  ]);
  return {
    evidenceId: identifier(root.evidenceId),
    taskId: identifier(root.taskId),
    taskSha256: hash(root.taskSha256),
    repositoryIdentitySha256: hash(root.repositoryIdentitySha256),
    repositoryRevision: revision(root.repositoryRevision),
    locator: identifier(root.locator),
    digestSha256: hash(root.digestSha256),
    boundRequirementIds: decodeBoundIds(root.boundRequirementIds),
    persistence: enumeration(root.persistence, [
      "candidate",
      "applied",
      "persistence-failed",
    ] as const),
    supportClass: enumeration(root.supportClass, ["supported", "unsupported-draft"] as const),
  };
}

function decodeCheckEvidence(value: unknown): DelegatedTaskCheckEvidenceV1 {
  const root = object(value);
  exact(root, [
    "evidenceId",
    "taskId",
    "taskSha256",
    "repositoryIdentitySha256",
    "repositoryRevision",
    "checkId",
    "state",
    "receiptSha256",
    "boundRequirementIds",
  ]);
  const state = enumeration(root.state, ["not-run", "unknown", "passed", "failed"] as const);
  const receiptSha256 = nullableHash(root.receiptSha256);
  if (state === "passed" && receiptSha256 === null) failDelegatedTaskResult("invalid-value");
  if ((state === "not-run" || state === "unknown") && receiptSha256 !== null) {
    failDelegatedTaskResult("invalid-value");
  }
  return {
    evidenceId: identifier(root.evidenceId),
    taskId: identifier(root.taskId),
    taskSha256: hash(root.taskSha256),
    repositoryIdentitySha256: hash(root.repositoryIdentitySha256),
    repositoryRevision: revision(root.repositoryRevision),
    checkId: identifier(root.checkId),
    state,
    receiptSha256,
    boundRequirementIds: decodeBoundIds(root.boundRequirementIds),
  };
}

function decodeChildEvidence(value: unknown): DelegatedTaskChildEvidenceV1 {
  const root = object(value);
  exact(root, [
    "childId",
    "taskId",
    "taskSha256",
    "repositoryIdentitySha256",
    "repositoryRevision",
    "workflow",
    "status",
    "failureCode",
    "formalQuality",
    "attemptedRequirementIds",
  ]);
  const status = enumeration(root.status, [
    "queued",
    "running",
    "needs-input",
    "needs-human-decision",
    "succeeded",
    "failed",
  ] as const);
  const failureCode = root.failureCode === null ? null : identifier(root.failureCode);
  if (status === "failed" ? failureCode === null : failureCode !== null) {
    failDelegatedTaskResult("invalid-value");
  }
  return {
    childId: identifier(root.childId),
    taskId: identifier(root.taskId),
    taskSha256: hash(root.taskSha256),
    repositoryIdentitySha256: hash(root.repositoryIdentitySha256),
    repositoryRevision: revision(root.repositoryRevision),
    workflow: enumeration(root.workflow, [
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
    ] as const),
    status,
    failureCode,
    formalQuality: enumeration(root.formalQuality, ["not-established", "failed"] as const),
    attemptedRequirementIds: decodeBoundIds(root.attemptedRequirementIds),
  };
}

function projectArtifactRequirement(
  requirement: DelegatedTaskRequirementInputV1,
  artifacts: readonly DelegatedTaskArtifactV1[],
): Pick<DelegatedTaskRequirementV1, "status" | "boundEvidenceId"> {
  const candidates = artifacts.filter(
    (artifact) =>
      artifact.boundRequirementIds.includes(requirement.id) &&
      artifact.locator === requirement.targetLocator,
  );
  const satisfying = candidates.filter(
    (artifact) => artifact.supportClass === "supported" && artifact.persistence === "applied",
  );
  if (satisfying.length > 1) failDelegatedTaskResult("invalid-value");
  if (satisfying.length === 1) return { status: "met", boundEvidenceId: satisfying[0]!.evidenceId };
  return { status: "unmet", boundEvidenceId: candidates[0]?.evidenceId ?? null };
}

function projectCheckRequirement(
  requirement: DelegatedTaskRequirementInputV1,
  checks: readonly DelegatedTaskCheckV1[],
): Pick<DelegatedTaskRequirementV1, "status" | "boundEvidenceId"> {
  const candidates = checks.filter(
    (check) =>
      check.boundRequirementIds.includes(requirement.id) &&
      check.checkId === requirement.targetLocator,
  );
  if (candidates.length > 1) failDelegatedTaskResult("invalid-value");
  const check = candidates[0];
  if (!check) return { status: "unmet", boundEvidenceId: null };
  if (check.state === "passed" && check.receiptSha256 !== null) {
    return { status: "met", boundEvidenceId: check.evidenceId };
  }
  const status: DelegatedTaskRequirementStatus = check.state === "unknown" ? "unknown" : "unmet";
  return { status, boundEvidenceId: check.evidenceId };
}

function projectChildRequirement(
  requirement: DelegatedTaskRequirementInputV1,
  children: readonly DelegatedTaskChildV1[],
): Pick<DelegatedTaskRequirementV1, "status" | "boundEvidenceId"> {
  const candidates = children.filter(
    (child) =>
      child.attemptedRequirementIds.includes(requirement.id) &&
      child.workflow === requirement.targetLocator,
  );
  const satisfying = candidates.filter((child) => child.status === "succeeded");
  if (satisfying.length > 1) failDelegatedTaskResult("invalid-value");
  if (satisfying.length === 1) {
    return { status: "met", boundEvidenceId: satisfying[0]!.childId };
  }
  return { status: "unmet", boundEvidenceId: candidates[0]?.childId ?? null };
}

/**
 * Project an honest sealed task result from original requirements and retained
 * operation, artifact, child, check, and delivery evidence. Ignored attestations
 * never satisfy a requirement.
 */
export function projectDelegatedTaskFulfillment(
  input: DelegatedTaskFulfillmentInputV1,
  _ignoredAttestation?: DelegatedTaskIgnoredAttestationV1,
): DelegatedTaskResultV1 {
  assertInert(input);
  rejectCredentials(input);
  const root = object(input);
  exact(root, [...INPUT_KEYS]);
  const taskId = identifier(root.taskId);
  const request = object(root.request);
  exact(request, ["kind", "requestSha256", "taskKind", "taskSha256"]);
  const repository = object(root.repository);
  exact(repository, ["identitySha256", "revision"]);
  const normalizedRequest: DelegatedTaskRequestIdentityV1 = {
    kind: enumeration(request.kind, ["bounded-instruction", "structured-task"] as const),
    requestSha256: hash(request.requestSha256),
    taskKind: enumeration(request.taskKind, [
      "ia-plan",
      "site-bootstrap",
      "bounded-doc-improvement",
      "foundation-to-patch",
      "create-documentation",
      "update-documentation",
      "instruction-only",
      "none",
    ] as const),
    taskSha256: hash(request.taskSha256),
  };
  if (
    normalizedRequest.kind === "structured-task" &&
    (normalizedRequest.taskKind === "instruction-only" || normalizedRequest.taskKind === "none")
  ) {
    failDelegatedTaskResult("invalid-value");
  }
  const normalizedRepository: TaskLineageRepositoryBindingV1 = {
    identitySha256: hash(repository.identitySha256),
    revision: revision(repository.revision),
  };
  const originalRequirements = array(root.originalRequirements)
    .map(decodeRequirementInput)
    .sort((left, right) => compare(left.id, right.id));
  unique(originalRequirements.map((requirement) => requirement.id));
  if (originalRequirements.length === 0) failDelegatedTaskResult("invalid-value");
  const planRequirementIds = array(root.planRequirementIds).map(identifier).sort(compare);
  unique(planRequirementIds);
  const originalIds = originalRequirements.map((requirement) => requirement.id);
  if (planRequirementIds.join("\0") !== originalIds.join("\0")) {
    failDelegatedTaskResult("identity-mismatch");
  }
  const expectedTaskSha256 = delegatedTaskRequirementsIdentitySha256(originalRequirements);
  if (normalizedRequest.taskSha256 !== expectedTaskSha256) {
    failDelegatedTaskResult("identity-mismatch");
  }
  const knownIds = new Set(originalIds);
  const artifacts = array(root.artifacts)
    .map(decodeArtifactEvidence)
    .filter((artifact) =>
      identityMatches(artifact, taskId, normalizedRequest, normalizedRepository),
    )
    .map(
      (artifact): DelegatedTaskArtifactV1 => ({
        evidenceId: artifact.evidenceId,
        locator: artifact.locator,
        digestSha256: artifact.digestSha256,
        boundRequirementIds: Object.freeze(
          artifact.boundRequirementIds.filter((id) => knownIds.has(id)),
        ),
        persistence: artifact.persistence,
        supportClass: artifact.supportClass,
      }),
    )
    .sort((left, right) => compare(left.evidenceId, right.evidenceId));
  unique(artifacts.map((artifact) => artifact.evidenceId));
  const checks = array(root.checks)
    .map(decodeCheckEvidence)
    .filter((check) => identityMatches(check, taskId, normalizedRequest, normalizedRepository))
    .map(
      (check): DelegatedTaskCheckV1 => ({
        evidenceId: check.evidenceId,
        checkId: check.checkId,
        state: check.state,
        receiptSha256: check.receiptSha256,
        boundRequirementIds: Object.freeze(
          check.boundRequirementIds.filter((id) => knownIds.has(id)),
        ),
      }),
    )
    .sort((left, right) => compare(left.evidenceId, right.evidenceId));
  unique(checks.map((check) => check.evidenceId));
  const children = array(root.children)
    .map(decodeChildEvidence)
    .filter((child) => identityMatches(child, taskId, normalizedRequest, normalizedRepository))
    .map(
      (child): DelegatedTaskChildV1 => ({
        childId: child.childId,
        workflow: child.workflow,
        status: child.status,
        failureCode: child.failureCode,
        formalQuality: child.formalQuality,
        attemptedRequirementIds: Object.freeze(
          child.attemptedRequirementIds.filter((id) => knownIds.has(id)),
        ),
      }),
    )
    .sort((left, right) => compare(left.childId, right.childId));
  unique(children.map((child) => child.childId));
  const pendingQuestionIds = array(root.pendingQuestions)
    .map((value) => {
      const question = object(value);
      exact(question, ["questionId"]);
      return identifier(question.questionId);
    })
    .sort(compare);
  unique(pendingQuestionIds);
  // The result contract owns this list; a local copy could drift from it.
  const stopReason = enumeration(root.stopReason, DELEGATED_TASK_STOP_REASONS);
  if (pendingQuestionIds.length > 0 !== (stopReason === "needs-input")) {
    failDelegatedTaskResult("contradictory-state");
  }
  const requirements = originalRequirements.map((requirement): DelegatedTaskRequirementV1 => {
    const projected =
      requirement.kind === "artifact"
        ? projectArtifactRequirement(requirement, artifacts)
        : requirement.kind === "check"
          ? projectCheckRequirement(requirement, checks)
          : projectChildRequirement(requirement, children);
    return { ...requirement, ...projected };
  });
  const unmetRequirementIds = requirements
    .filter((requirement) => requirement.status !== "met")
    .map((requirement) => requirement.id)
    .sort(compare);
  const persistenceState = aggregateDelegatedTaskPersistence(artifacts);
  const checkState = aggregateDelegatedTaskCheckState(requirements, checks);
  const fulfillment = computeDelegatedTaskFulfillment({
    requirements,
    artifacts,
    checks,
    pendingQuestionIds,
    stopReason,
    persistenceState,
    checkState,
  });
  const nextAction = computeDelegatedTaskNextAction({
    taskId,
    fulfillment,
    stopReason,
    persistenceState,
    checkState,
    children,
  });
  return createDelegatedTaskResult({
    taskId,
    request: normalizedRequest,
    repository: normalizedRepository,
    fulfillment,
    stopReason,
    deliveryState: enumeration(root.deliveryState, [
      "not-requested",
      "ineligible",
      "eligible",
      "attempted",
    ] as const),
    persistenceState,
    checkState,
    requirements: Object.freeze(requirements),
    unmetRequirementIds: Object.freeze(unmetRequirementIds),
    pendingQuestionIds: Object.freeze(pendingQuestionIds),
    artifacts: Object.freeze(artifacts),
    checks: Object.freeze(checks),
    children: Object.freeze(children),
    usage: input.usage,
    nextAction,
  });
}
