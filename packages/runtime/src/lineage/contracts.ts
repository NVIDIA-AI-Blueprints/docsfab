// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  WorkflowDefinition,
  WorkflowName,
  WorkflowTaskInput,
} from "../workflow-contracts/contracts.js";
import { createContractKit, createReceiptReplayGuard, deepFreeze } from "../contract-kit/index.js";
import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import {
  createAutoWorkflowTaskBinding,
  type AutoCycleWorkflowAccess,
} from "../autonomy/contracts.js";
import {
  internalTaskLineageHostVerifier,
  type InternalTaskLineageHostAuthority,
  type InternalTaskLineageHostVerifier,
} from "./authority-internal.js";

export const TASK_LINEAGE_SCHEMA_VERSION = 1 as const;

export interface TaskLineageWorkflowAccess extends AutoCycleWorkflowAccess {
  getWorkflow(name: WorkflowName): WorkflowDefinition;
}

export const TASK_ORIGIN_CLASSES = [
  "operator-directed",
  "docsfab-recommended-approved",
  "docsfab-autonomous",
  "historical-unknown",
] as const;
export type TaskOriginClass = (typeof TASK_ORIGIN_CLASSES)[number];

export const DECISION_LINEAGE_DOMAINS = [
  "task",
  "repository",
  "workflow",
  "scope",
  "path",
  "write",
  "validation",
  "tracker",
  "publication",
] as const;
export type DecisionLineageDomain = (typeof DECISION_LINEAGE_DOMAINS)[number];

export const DECISION_LINEAGE_ACTORS = [
  "operator",
  "host-policy",
  "deterministic-workflow",
  "model",
] as const;
export type DecisionLineageActor = (typeof DECISION_LINEAGE_ACTORS)[number];

export interface TaskLineageRepositoryBindingV1 {
  identitySha256: string;
  revision: string;
}

export interface BoundedTaskRequestIdentityV1 {
  kind: "bounded-instruction" | "structured-task";
  requestSha256: string;
  taskKind: WorkflowTaskInput["kind"] | "instruction-only" | "none";
  taskSha256: string;
}

export interface HistoricalTaskRequestIdentityV1 {
  kind: "historical-unavailable";
  requestSha256: null;
  taskKind: "historical-unknown";
  taskSha256: null;
}

export type TaskRequestIdentityV1 = BoundedTaskRequestIdentityV1 | HistoricalTaskRequestIdentityV1;

export interface OperatorTaskApprovalV1 {
  authorityId: string;
  operatorIdentitySha256: string;
  approvalSha256: string;
  approvedRequestSha256: string;
  approvedTaskSha256: string;
  /** Null for a directed request; exact recommendation identity otherwise. */
  approvedRecommendationSha256: string | null;
}

export interface DocsFabTaskRecommendationV1 {
  recommendationSha256: string;
  recommendedTaskSha256: string;
  evidenceSha256s: string[];
}

export interface AutonomousTaskSelectionV1 {
  requestSha256: string;
  assessmentSha256: string;
  decisionSha256: string;
  authorizationSha256: string;
  candidateSha256: string;
  selectedTaskSha256: string;
  maturityFindingSha256s: string[];
}

interface TaskOriginInputBaseV1 {
  lineageId: string;
  repository: TaskLineageRepositoryBindingV1;
  request: TaskRequestIdentityV1;
}

export interface OperatorDirectedTaskOriginInputV1 extends TaskOriginInputBaseV1 {
  origin: "operator-directed";
  selectedBy: "operator";
  approval: OperatorTaskApprovalV1;
  recommendation: null;
  autonomousSelection: null;
}

export interface RecommendedApprovedTaskOriginInputV1 extends TaskOriginInputBaseV1 {
  origin: "docsfab-recommended-approved";
  selectedBy: "operator";
  approval: OperatorTaskApprovalV1;
  recommendation: DocsFabTaskRecommendationV1;
  autonomousSelection: null;
}

export interface AutonomousTaskOriginInputV1 extends TaskOriginInputBaseV1 {
  origin: "docsfab-autonomous";
  selectedBy: "deterministic-workflow";
  approval: null;
  recommendation: null;
  autonomousSelection: AutonomousTaskSelectionV1;
}

export interface HistoricalUnknownTaskOriginInputV1 extends TaskOriginInputBaseV1 {
  origin: "historical-unknown";
  selectedBy: "unknown";
  request: HistoricalTaskRequestIdentityV1;
  approval: null;
  recommendation: null;
  autonomousSelection: null;
}

export type TaskOriginInputV1 =
  | OperatorDirectedTaskOriginInputV1
  | RecommendedApprovedTaskOriginInputV1
  | AutonomousTaskOriginInputV1
  | HistoricalUnknownTaskOriginInputV1;

export type TaskOriginV1 = TaskOriginInputV1 & {
  schemaVersion: 1;
  kind: "docsfab-task-origin";
  authorityStatus: "host-authenticated" | "historical-inert";
  observedAt: string | null;
  authorityReceiptSha256: string | null;
  originSha256: string;
};

interface TaskOriginBodyV1 {
  lineageId: string;
  repository: TaskLineageRepositoryBindingV1;
  origin: TaskOriginClass;
  selectedBy: "operator" | "deterministic-workflow" | "unknown";
  request: TaskRequestIdentityV1;
  approval: OperatorTaskApprovalV1 | null;
  recommendation: DocsFabTaskRecommendationV1 | null;
  autonomousSelection: AutonomousTaskSelectionV1 | null;
  authorityStatus: "host-authenticated" | "historical-inert";
  observedAt: string | null;
  authorityReceiptSha256: string | null;
}

export interface WorkflowLineageCandidateInputV1 {
  id: string;
  workflow: WorkflowName;
  taskSha256: string;
  prerequisiteIds: string[];
  prerequisiteEvidenceSha256s: string[];
  eligibility: "eligible" | "ineligible";
  reasonCode: string;
}

export interface WorkflowLineageCandidateV1 extends WorkflowLineageCandidateInputV1 {
  stepIds: string[];
  candidateSha256: string;
}

export interface RejectedWorkflowAlternativeInputV1 {
  candidateSha256: string;
  reasonCode: string;
  evidenceSha256s: string[];
}

export interface DecisionAttributionInputV1 {
  id: string;
  domain: DecisionLineageDomain;
  actor: DecisionLineageActor;
  effect: "authoritative" | "advisory";
  outcomeSha256: string;
  authoritySource: "operator-approval" | "host-policy" | "workflow-contract" | "none";
  authoritySha256: string | null;
  evidenceSha256s: string[];
  boundedByDecisionIds: string[];
  reasonCode: string;
}

export interface DecisionLineageInputV1 {
  lineageId: string;
  originSha256: string;
  candidates: WorkflowLineageCandidateInputV1[];
  selectedCandidateSha256: string | null;
  /** Source auto-candidate identity; distinct from this schema's selected candidate digest. */
  selectedSourceAutoCandidateSha256: string | null;
  rejectedAlternatives: RejectedWorkflowAlternativeInputV1[];
  decisions: DecisionAttributionInputV1[];
}

export interface DecisionLineageV1 extends Omit<DecisionLineageInputV1, "candidates"> {
  schemaVersion: 1;
  kind: "docsfab-decision-lineage";
  candidates: WorkflowLineageCandidateV1[];
  selectedWorkflow: WorkflowName | null;
  selectedSourceAutoCandidateSha256: string | null;
  authorityStatus: "host-authenticated" | "historical-inert";
  observedAt: string | null;
  authorityReceiptSha256: string | null;
  lineageSha256: string;
}

export interface TaskLineageAuthorityChallengeV1 {
  schemaVersion: 1;
  kind: "docsfab-task-lineage-authority-challenge";
  lineageId: string;
  repository: TaskLineageRepositoryBindingV1;
  originClass: Exclude<TaskOriginClass, "historical-unknown">;
  requestSha256: string;
  taskSha256: string;
  proposedOriginSha256: string;
  proposedLineageSha256: string;
  challengeSha256: string;
}

/** Non-serializable capability; private object identity, not fields, is authority. */
export interface TaskLineageHostCapability {
  readonly kind: "docsfab-task-lineage-host-capability";
}

export interface TaskLineageArtifactsV1 {
  origin: TaskOriginV1;
  lineage: DecisionLineageV1;
}

export interface TaskLineageProjectionV1 {
  schemaVersion: 1;
  kind: "docsfab-task-lineage-projection";
  lineageIdSha256: string;
  repositoryIdentitySha256: string;
  repositoryRevision: string;
  origin: TaskOriginClass;
  requestKind: TaskRequestIdentityV1["kind"];
  requestSha256: string | null;
  taskSha256: string | null;
  selectedWorkflow: WorkflowName | null;
  selectedCandidateSha256: string | null;
  selectedSourceAutoCandidateSha256: string | null;
  decisionResponsibility: Array<{
    domain: DecisionLineageDomain;
    actor: DecisionLineageActor;
    effect: "authoritative" | "advisory";
    decisionSha256: string;
  }>;
  originSha256: string;
  lineageSha256: string;
  authorityStatus: "host-authenticated" | "historical-inert";
  projectionSha256: string;
}

export const TASK_LINEAGE_MIGRATION_POLICY = deepFreeze({
  schemaVersion: 1 as const,
  kind: "docsfab-task-lineage-migration-policy" as const,
  currentSchemaVersion: 1 as const,
  acceptedSourceVersions: [1] as const,
  absentHistoricalLineage: "explicit-historical-unknown-only" as const,
  historicalAuthority: "none" as const,
  unknownVersion: "reject" as const,
});

export type TaskLineageContractErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "ambiguous-origin"
  | "authority-required"
  | "authority-replayed"
  | "selection-conflict"
  | "responsibility-expansion"
  | "migration-required";

export class TaskLineageContractError extends Error {
  public constructor(public readonly code: TaskLineageContractErrorCode) {
    super(`Task-lineage contract rejected: ${code}.`);
    this.name = "TaskLineageContractError";
  }
}

function fail(code: TaskLineageContractErrorCode): never {
  throw new TaskLineageContractError(code);
}

const {
  canonicalDigest,
  canonicalJson,
  assertInert,
  rejectCredentials,
  object,
  exact,
  noUnknown,
  pick,
  array,
  string,
  identifier,
  hash,
  nullableHash,
  revision,
  timestamp,
  nullableTimestamp,
  enumeration,
  compare,
  unique,
  normalizedHashes,
  normalizedIds,
  seal,
  decodeSealed,
  sourceVersion,
} = createContractKit({
  fail,
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

const receiptGuard = createReceiptReplayGuard(fail, "authority-replayed");
const recoveryReceiptGuard = createReceiptReplayGuard(fail, "authority-replayed");

interface CapabilityState {
  origin: TaskOriginV1;
  lineage: DecisionLineageV1;
}

const capabilities = new WeakMap<object, CapabilityState>();
const authenticOrigins = new WeakMap<object, string>();
const authenticLineages = new WeakMap<object, string>();

export function createBoundedInstructionRequestIdentity(
  instruction: string,
  task: WorkflowTaskInput | null,
  workflow: WorkflowName,
  repository: TaskLineageRepositoryBindingV1,
  workflows: TaskLineageWorkflowAccess,
): BoundedTaskRequestIdentityV1 {
  assertInert(task);
  if (
    typeof instruction !== "string" ||
    instruction !== instruction.normalize("NFC") ||
    instruction.length === 0 ||
    instruction.length > 1_000_000 ||
    instruction.includes("\0")
  ) {
    fail("invalid-value");
  }
  rejectCredentials({ instruction, task });
  const binding = createAutoWorkflowTaskBinding(
    workflow,
    task,
    repositoryBinding(repository),
    workflows,
  );
  return deepFreeze({
    kind: "bounded-instruction" as const,
    requestSha256: canonicalDigest({
      repository: repositoryBinding(repository),
      workflow,
      instruction,
      task: binding,
    }),
    taskKind: binding.taskKind === "none" ? "instruction-only" : binding.taskKind,
    taskSha256: binding.taskSha256,
  });
}

export function createStructuredTaskRequestIdentity(
  task: WorkflowTaskInput,
  workflow: WorkflowName,
  repository: TaskLineageRepositoryBindingV1,
  workflows: TaskLineageWorkflowAccess,
): BoundedTaskRequestIdentityV1 {
  assertInert(task);
  rejectCredentials(task);
  const binding = createAutoWorkflowTaskBinding(
    workflow,
    task,
    repositoryBinding(repository),
    workflows,
  );
  if (binding.taskKind === "none") fail("invalid-value");
  return deepFreeze({
    kind: "structured-task" as const,
    requestSha256: canonicalDigest({
      repository: repositoryBinding(repository),
      workflow,
      binding,
    }),
    taskKind: binding.taskKind,
    taskSha256: binding.taskSha256,
  });
}

/** Canonical candidate constructor used before selecting or rejecting a candidate. */
export function createWorkflowLineageCandidate(
  input: WorkflowLineageCandidateInputV1,
  workflows: TaskLineageWorkflowAccess,
): WorkflowLineageCandidateV1 {
  assertInert(input);
  rejectCredentials(input);
  return workflowCandidate(input, workflows);
}

/**
 * Mint exact current lineage only after a trusted host independently verifies
 * the content-free challenge. Caller- or model-authored lookalikes are inert.
 */
export async function mintTaskLineageHostCapability(
  input: {
    origin: Exclude<TaskOriginInputV1, HistoricalUnknownTaskOriginInputV1>;
    lineage: Omit<DecisionLineageInputV1, "originSha256">;
  },
  authority: InternalTaskLineageHostAuthority,
  workflows: TaskLineageWorkflowAccess,
): Promise<TaskLineageHostCapability> {
  assertInert(input);
  exact(object(input), ["origin", "lineage"]);
  rejectCredentials(input);
  const verifier = internalTaskLineageHostVerifier(authority);
  if (!verifier) fail("authority-required");
  const originBody = normalizeOriginInput(
    input.origin,
    "host-authenticated",
    "1970-01-01T00:00:00.000Z",
    "0".repeat(64),
  );
  const provisionalOrigin = sealOrigin(originBody);
  const lineageBody = normalizeLineageInput(
    {
      ...input.lineage,
      originSha256: provisionalOrigin.originSha256,
    },
    provisionalOrigin,
    "host-authenticated",
    provisionalOrigin.observedAt,
    provisionalOrigin.authorityReceiptSha256,
    workflows,
  );
  const provisionalLineage = seal("docsfab-decision-lineage", "lineageSha256", lineageBody);
  const request = provisionalOrigin.request;
  if (request.kind === "historical-unavailable") fail("ambiguous-origin");
  const challengeBody = {
    lineageId: provisionalOrigin.lineageId,
    repository: provisionalOrigin.repository,
    originClass: provisionalOrigin.origin as Exclude<TaskOriginClass, "historical-unknown">,
    requestSha256: request.requestSha256,
    taskSha256: request.taskSha256,
    proposedOriginSha256: provisionalOrigin.originSha256,
    proposedLineageSha256: provisionalLineage.lineageSha256,
  };
  const challenge = seal(
    "docsfab-task-lineage-authority-challenge",
    "challengeSha256",
    challengeBody,
  );
  const verified = await verifier.verifyCurrent(challenge);
  assertInert(verified);
  exact(object(verified), ["status", "challengeSha256", "observedAt", "authorityReceiptSha256"]);
  if (verified.status !== "current" || verified.challengeSha256 !== challenge.challengeSha256) {
    fail("authority-required");
  }
  const observedAt = timestamp(verified.observedAt);
  const receipt = hash(verified.authorityReceiptSha256);
  consumeReceipt(verifier, receipt);
  // Never reread caller-owned input after the asynchronous host check. The
  // provisional artifacts are already normalized, detached, and deeply frozen.
  const origin = sealOrigin({
    lineageId: provisionalOrigin.lineageId,
    repository: provisionalOrigin.repository,
    origin: provisionalOrigin.origin,
    selectedBy: provisionalOrigin.selectedBy,
    request: provisionalOrigin.request,
    approval: provisionalOrigin.approval,
    recommendation: provisionalOrigin.recommendation,
    autonomousSelection: provisionalOrigin.autonomousSelection,
    authorityStatus: "host-authenticated",
    observedAt,
    authorityReceiptSha256: receipt,
  });
  const lineage = seal("docsfab-decision-lineage", "lineageSha256", {
    lineageId: provisionalLineage.lineageId,
    originSha256: origin.originSha256,
    candidates: provisionalLineage.candidates,
    selectedCandidateSha256: provisionalLineage.selectedCandidateSha256,
    selectedSourceAutoCandidateSha256: provisionalLineage.selectedSourceAutoCandidateSha256,
    rejectedAlternatives: provisionalLineage.rejectedAlternatives,
    decisions: provisionalLineage.decisions,
    selectedWorkflow: provisionalLineage.selectedWorkflow,
    authorityStatus: "host-authenticated" as const,
    observedAt,
    authorityReceiptSha256: receipt,
  });
  const capability = deepFreeze({ kind: "docsfab-task-lineage-host-capability" as const });
  capabilities.set(capability, { origin, lineage });
  return capability;
}

export function createTaskLineageArtifacts(
  capability: TaskLineageHostCapability,
): TaskLineageArtifactsV1 {
  const state = capabilities.get(capability as object);
  if (!state) fail("authority-required");
  authenticOrigins.set(state.origin, state.origin.originSha256);
  authenticLineages.set(state.lineage, state.lineage.lineageSha256);
  return deepFreeze({ origin: state.origin, lineage: state.lineage });
}

/** Structural decoder only. Successfully decoded persisted JSON grants no authority. */
export function decodeTaskOrigin(value: unknown): TaskOriginV1 {
  return decodeSealed(
    value,
    "docsfab-task-origin",
    "originSha256",
    [
      "lineageId",
      "repository",
      "origin",
      "selectedBy",
      "request",
      "approval",
      "recommendation",
      "autonomousSelection",
      "authorityStatus",
      "observedAt",
      "authorityReceiptSha256",
    ],
    (root) =>
      normalizeOriginInput(
        pick(root, [
          "lineageId",
          "repository",
          "origin",
          "selectedBy",
          "request",
          "approval",
          "recommendation",
          "autonomousSelection",
        ]) as unknown as TaskOriginInputV1,
        authorityStatus(root.authorityStatus),
        nullableTimestamp(root.observedAt),
        nullableHash(root.authorityReceiptSha256),
      ),
  ) as TaskOriginV1;
}

export function decodeDecisionLineage(
  value: unknown,
  originValue: unknown,
  workflows: TaskLineageWorkflowAccess,
): DecisionLineageV1 {
  const origin = decodeTaskOrigin(originValue);
  return decodeSealed(
    value,
    "docsfab-decision-lineage",
    "lineageSha256",
    [
      "lineageId",
      "originSha256",
      "candidates",
      "selectedCandidateSha256",
      "selectedSourceAutoCandidateSha256",
      "rejectedAlternatives",
      "decisions",
      "selectedWorkflow",
      "authorityStatus",
      "observedAt",
      "authorityReceiptSha256",
    ],
    (root) =>
      normalizeLineageInput(
        pick(root, [
          "lineageId",
          "originSha256",
          "candidates",
          "selectedCandidateSha256",
          "selectedSourceAutoCandidateSha256",
          "rejectedAlternatives",
          "decisions",
        ]) as unknown as DecisionLineageInputV1,
        origin,
        authorityStatus(root.authorityStatus),
        nullableTimestamp(root.observedAt),
        nullableHash(root.authorityReceiptSha256),
        workflows,
      ),
  );
}

export function serializeTaskOrigin(value: unknown): string {
  return canonicalizeJsonEvidence(decodeTaskOrigin(value) as unknown as JsonEvidenceValue);
}

export function serializeDecisionLineage(
  value: unknown,
  origin: unknown,
  workflows: TaskLineageWorkflowAccess,
): string {
  return canonicalizeJsonEvidence(
    decodeDecisionLineage(value, origin, workflows) as unknown as JsonEvidenceValue,
  );
}

export function decodePersistedTaskOrigin(value: string | Uint8Array): TaskOriginV1 {
  try {
    return decodeTaskOrigin(parseJsonEvidence(value, { requireCanonical: true }));
  } catch (error) {
    if (error instanceof TaskLineageContractError) throw error;
    fail("invalid-shape");
  }
}

export function decodePersistedDecisionLineage(
  value: string | Uint8Array,
  originValue: unknown,
  workflows: TaskLineageWorkflowAccess,
): DecisionLineageV1 {
  try {
    return decodeDecisionLineage(
      parseJsonEvidence(value, { requireCanonical: true }),
      originValue,
      workflows,
    );
  } catch (error) {
    if (error instanceof TaskLineageContractError) throw error;
    fail("invalid-shape");
  }
}

/** Re-authenticate exact persisted artifacts against their original host capability. */
export function restoreTaskLineageArtifacts(
  value: { origin: unknown; lineage: unknown },
  capability: TaskLineageHostCapability,
  workflows: TaskLineageWorkflowAccess,
): TaskLineageArtifactsV1 {
  assertInert(value);
  exact(object(value), ["origin", "lineage"]);
  const state = capabilities.get(capability as object);
  if (!state) fail("authority-required");
  const origin = decodeTaskOrigin(value.origin);
  const lineage = decodeDecisionLineage(value.lineage, origin, workflows);
  if (
    canonicalJson(origin) !== canonicalJson(state.origin) ||
    canonicalJson(lineage) !== canonicalJson(state.lineage)
  )
    fail("authority-required");
  authenticOrigins.set(state.origin, state.origin.originSha256);
  authenticLineages.set(state.lineage, state.lineage.lineageSha256);
  return deepFreeze({ origin: state.origin, lineage: state.lineage });
}

export interface TaskLineageRecoveryAuthorizationV1 {
  schemaVersion: 1;
  kind: "docsfab-task-lineage-recovery-authorization";
  originalOriginSha256: string;
  originalLineageSha256: string;
  challengeSha256: string;
  authorizedAt: string;
  authorityReceiptSha256: string;
  authorizationSha256: string;
}

export function decodeTaskLineageRecoveryAuthorization(
  value: unknown,
): TaskLineageRecoveryAuthorizationV1 {
  assertInert(value);
  const root = object(value);
  exact(root, [
    "schemaVersion",
    "kind",
    "originalOriginSha256",
    "originalLineageSha256",
    "challengeSha256",
    "authorizedAt",
    "authorityReceiptSha256",
    "authorizationSha256",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-task-lineage-recovery-authorization")
    fail("invalid-shape");
  const authorizationSha256 = hash(root.authorizationSha256);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-task-lineage-recovery-authorization" as const,
    originalOriginSha256: hash(root.originalOriginSha256),
    originalLineageSha256: hash(root.originalLineageSha256),
    challengeSha256: hash(root.challengeSha256),
    authorizedAt: timestamp(root.authorizedAt),
    authorityReceiptSha256: hash(root.authorityReceiptSha256),
  };
  if (authorizationSha256 !== canonicalDigest(body)) fail("digest-mismatch");
  return deepFreeze({ ...body, authorizationSha256 });
}

/**
 * Re-authenticate exact historical lineage in a new process. The trusted host
 * verifies a fresh challenge, while the returned artifacts retain their
 * original issuance timestamp and receipt byte-for-byte. Current recovery
 * authorization is separate evidence and never replaces historical issuance.
 */
export async function recoverTaskLineageArtifacts(
  value: { origin: unknown; lineage: unknown },
  authority: InternalTaskLineageHostAuthority,
  workflows: TaskLineageWorkflowAccess,
): Promise<{
  artifacts: TaskLineageArtifactsV1;
  authorization: TaskLineageRecoveryAuthorizationV1;
}> {
  assertInert(value);
  exact(object(value), ["origin", "lineage"]);
  const verifier = internalTaskLineageHostVerifier(authority);
  if (!verifier) fail("authority-required");
  const origin = decodeTaskOrigin(value.origin);
  const lineage = decodeDecisionLineage(value.lineage, origin, workflows);
  if (
    origin.authorityStatus !== "host-authenticated" ||
    lineage.authorityStatus !== "host-authenticated"
  )
    fail("authority-required");
  if (origin.origin === "historical-unknown" || origin.request.kind === "historical-unavailable")
    fail("authority-required");
  const request = origin.request;
  const challengeBody = {
    lineageId: origin.lineageId,
    repository: origin.repository,
    originClass: origin.origin as Exclude<TaskOriginClass, "historical-unknown">,
    requestSha256: request.requestSha256,
    taskSha256: request.taskSha256,
    proposedOriginSha256: origin.originSha256,
    proposedLineageSha256: lineage.lineageSha256,
  };
  const challenge = seal(
    "docsfab-task-lineage-authority-challenge",
    "challengeSha256",
    challengeBody,
  );
  const verified = await verifier.verifyCurrent(challenge);
  assertInert(verified);
  exact(object(verified), ["status", "challengeSha256", "observedAt", "authorityReceiptSha256"]);
  if (verified.status !== "current" || verified.challengeSha256 !== challenge.challengeSha256)
    fail("authority-required");
  const authorizedAt = timestamp(verified.observedAt);
  const authorityReceiptSha256 = hash(verified.authorityReceiptSha256);
  recoveryReceiptGuard.consume(verifier, authorityReceiptSha256);
  const authorizationBody = {
    schemaVersion: 1 as const,
    kind: "docsfab-task-lineage-recovery-authorization" as const,
    originalOriginSha256: origin.originSha256,
    originalLineageSha256: lineage.lineageSha256,
    challengeSha256: challenge.challengeSha256,
    authorizedAt,
    authorityReceiptSha256,
  };
  const authorization = deepFreeze({
    ...authorizationBody,
    authorizationSha256: canonicalDigest(authorizationBody),
  });
  authenticOrigins.set(origin, origin.originSha256);
  authenticLineages.set(lineage, lineage.lineageSha256);
  return deepFreeze({ artifacts: { origin, lineage }, authorization });
}

export function assertTaskLineageAuthentic(
  value: TaskLineageArtifactsV1,
  workflows: TaskLineageWorkflowAccess,
): void {
  const origin = decodeTaskOrigin(value.origin);
  const lineage = decodeDecisionLineage(value.lineage, origin, workflows);
  if (
    authenticOrigins.get(value.origin as object) !== origin.originSha256 ||
    authenticLineages.get(value.lineage as object) !== lineage.lineageSha256
  ) {
    fail("authority-required");
  }
}

/** Explicit historical state. It is readable and digest-bound but always inert. */
export function createHistoricalUnknownTaskLineage(input: {
  lineageId: string;
  repository: TaskLineageRepositoryBindingV1;
}): TaskLineageArtifactsV1 {
  assertInert(input);
  exact(object(input), ["lineageId", "repository"]);
  rejectCredentials(input);
  const originInput: HistoricalUnknownTaskOriginInputV1 = {
    lineageId: identifier(input.lineageId),
    repository: repositoryBinding(input.repository),
    origin: "historical-unknown",
    selectedBy: "unknown",
    request: {
      kind: "historical-unavailable",
      requestSha256: null,
      taskKind: "historical-unknown",
      taskSha256: null,
    },
    approval: null,
    recommendation: null,
    autonomousSelection: null,
  };
  const origin = sealOrigin(normalizeOriginInput(originInput, "historical-inert", null, null));
  const lineageInput: DecisionLineageInputV1 = {
    lineageId: origin.lineageId,
    originSha256: origin.originSha256,
    candidates: [],
    selectedCandidateSha256: null,
    selectedSourceAutoCandidateSha256: null,
    rejectedAlternatives: [],
    decisions: [],
  };
  const lineage = seal(
    "docsfab-decision-lineage",
    "lineageSha256",
    normalizeLineageInput(lineageInput, origin, "historical-inert", null, null),
  );
  return deepFreeze({ origin, lineage });
}

export function projectTaskLineage(
  originValue: unknown,
  lineageValue: unknown,
  workflows: TaskLineageWorkflowAccess,
): TaskLineageProjectionV1 {
  const origin = decodeTaskOrigin(originValue);
  const lineage = decodeDecisionLineage(lineageValue, origin, workflows);
  const body = {
    lineageIdSha256: canonicalDigest(origin.lineageId),
    repositoryIdentitySha256: origin.repository.identitySha256,
    repositoryRevision: origin.repository.revision,
    origin: origin.origin,
    requestKind: origin.request.kind,
    requestSha256: origin.request.requestSha256,
    taskSha256: origin.request.taskSha256,
    selectedWorkflow: lineage.selectedWorkflow,
    selectedCandidateSha256: lineage.selectedCandidateSha256,
    selectedSourceAutoCandidateSha256: lineage.selectedSourceAutoCandidateSha256,
    decisionResponsibility: lineage.decisions.map((decision) => ({
      domain: decision.domain,
      actor: decision.actor,
      effect: decision.effect,
      decisionSha256: canonicalDigest(decision),
    })),
    originSha256: origin.originSha256,
    lineageSha256: lineage.lineageSha256,
    authorityStatus: origin.authorityStatus,
  };
  return seal("docsfab-task-lineage-projection", "projectionSha256", body);
}

/**
 * Validate a previously projected, persisted task-lineage projection and return a
 * freshly re-sealed copy. This is the read side of {@link projectTaskLineage}:
 * publication rendering consumes the projection recorded on a run record rather
 * than re-minting authenticated artifacts, so the projection body must re-seal
 * byte-for-byte. Any tampered digest, injected field, or free-form lookalike is
 * rejected before a downstream narrative can quote it.
 */
export function assertTaskLineageProjection(value: unknown): TaskLineageProjectionV1 {
  assertInert(value);
  rejectCredentials(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-shape");
  }
  const root = value as TaskLineageProjectionV1;
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-task-lineage-projection") {
    fail("migration-required");
  }
  if (
    typeof root.projectionSha256 !== "string" ||
    typeof root.repositoryRevision !== "string" ||
    typeof root.repositoryIdentitySha256 !== "string" ||
    typeof root.lineageIdSha256 !== "string" ||
    !Array.isArray(root.decisionResponsibility)
  ) {
    fail("invalid-shape");
  }
  const { schemaVersion: _schemaVersion, kind: _kind, projectionSha256: _digest, ...body } = root;
  const resealed = seal("docsfab-task-lineage-projection", "projectionSha256", body);
  if (canonicalJson(root) !== canonicalJson(resealed)) fail("digest-mismatch");
  return resealed;
}

export function migrateTaskOrigin(value: unknown): TaskOriginV1 {
  if (sourceVersion(value) !== 1) fail("migration-required");
  return decodeTaskOrigin(value);
}

export function migrateDecisionLineage(
  value: unknown,
  origin: unknown,
  workflows: TaskLineageWorkflowAccess,
): DecisionLineageV1 {
  if (sourceVersion(value) !== 1) fail("migration-required");
  return decodeDecisionLineage(value, origin, workflows);
}

function normalizeOriginInput(
  value: TaskOriginInputV1,
  status: "host-authenticated" | "historical-inert",
  observedAt: string | null,
  receipt: string | null,
): TaskOriginBodyV1 {
  const root = object(value);
  exact(root, [
    "lineageId",
    "repository",
    "origin",
    "selectedBy",
    "request",
    "approval",
    "recommendation",
    "autonomousSelection",
  ]);
  const origin = enumeration(root.origin, TASK_ORIGIN_CLASSES);
  const request = requestIdentity(root.request);
  const historical = origin === "historical-unknown";
  if (
    historical !== (status === "historical-inert") ||
    historical !== (request.kind === "historical-unavailable") ||
    historical !== (observedAt === null) ||
    historical !== (receipt === null)
  ) {
    fail("ambiguous-origin");
  }
  let selectedBy: TaskOriginV1["selectedBy"];
  let approval: OperatorTaskApprovalV1 | null = null;
  let recommendation: DocsFabTaskRecommendationV1 | null = null;
  let autonomousSelection: AutonomousTaskSelectionV1 | null = null;
  if (origin === "operator-directed") {
    selectedBy = literal(root.selectedBy, "operator");
    approval = operatorApproval(root.approval, request);
    if (
      approval.approvedRecommendationSha256 !== null ||
      root.recommendation !== null ||
      root.autonomousSelection !== null
    )
      fail("ambiguous-origin");
  } else if (origin === "docsfab-recommended-approved") {
    selectedBy = literal(root.selectedBy, "operator");
    recommendation = taskRecommendation(root.recommendation, request);
    approval = operatorApproval(root.approval, request);
    if (
      approval.approvedTaskSha256 !== recommendation.recommendedTaskSha256 ||
      approval.approvedRecommendationSha256 !== recommendation.recommendationSha256 ||
      root.autonomousSelection !== null
    )
      fail("ambiguous-origin");
  } else if (origin === "docsfab-autonomous") {
    selectedBy = literal(root.selectedBy, "deterministic-workflow");
    autonomousSelection = autonomousTaskSelection(root.autonomousSelection, request);
    if (root.approval !== null || root.recommendation !== null) fail("ambiguous-origin");
  } else {
    selectedBy = literal(root.selectedBy, "unknown");
    if (root.approval !== null || root.recommendation !== null || root.autonomousSelection !== null)
      fail("ambiguous-origin");
  }
  return {
    lineageId: identifier(root.lineageId),
    repository: repositoryBinding(root.repository),
    origin,
    selectedBy,
    request,
    approval,
    recommendation,
    autonomousSelection,
    authorityStatus: status,
    observedAt,
    authorityReceiptSha256: receipt,
  };
}

function normalizeLineageInput(
  value: DecisionLineageInputV1,
  origin: TaskOriginV1,
  status: "host-authenticated" | "historical-inert",
  observedAt: string | null,
  receipt: string | null,
  workflows?: TaskLineageWorkflowAccess,
): Omit<DecisionLineageV1, "schemaVersion" | "kind" | "lineageSha256"> {
  const root = object(value);
  exact(root, [
    "lineageId",
    "originSha256",
    "candidates",
    "selectedCandidateSha256",
    "selectedSourceAutoCandidateSha256",
    "rejectedAlternatives",
    "decisions",
  ]);
  if (
    identifier(root.lineageId) !== origin.lineageId ||
    hash(root.originSha256) !== origin.originSha256 ||
    status !== origin.authorityStatus ||
    observedAt !== origin.observedAt ||
    receipt !== origin.authorityReceiptSha256
  )
    fail("selection-conflict");
  const candidates = array(root.candidates)
    .map((value) => {
      if (!workflows) fail("invalid-value");
      return workflowCandidate(value, workflows);
    })
    .sort(candidateCompare);
  unique(candidates.map((candidate) => candidate.candidateSha256));
  unique(candidates.map((candidate) => candidate.id));
  const selectedCandidateSha256 = nullableHash(root.selectedCandidateSha256);
  const selectedSourceAutoCandidateSha256 = nullableHash(root.selectedSourceAutoCandidateSha256);
  const rejectedAlternatives = array(root.rejectedAlternatives)
    .map(rejectedAlternative)
    .sort(rejectionCompare);
  unique(rejectedAlternatives.map((entry) => entry.candidateSha256));
  const decisions = array(root.decisions).map(decisionAttribution).sort(decisionCompare);
  unique(decisions.map((decision) => decision.id));
  validateDecisionReferences(decisions);
  const historical = origin.origin === "historical-unknown";
  if (historical) {
    if (
      candidates.length !== 0 ||
      selectedCandidateSha256 !== null ||
      selectedSourceAutoCandidateSha256 !== null ||
      rejectedAlternatives.length !== 0 ||
      decisions.length !== 0
    )
      fail("ambiguous-origin");
    return {
      lineageId: origin.lineageId,
      originSha256: origin.originSha256,
      candidates,
      selectedCandidateSha256,
      selectedSourceAutoCandidateSha256,
      rejectedAlternatives,
      decisions,
      selectedWorkflow: null,
      authorityStatus: status,
      observedAt,
      authorityReceiptSha256: receipt,
    };
  }
  if (candidates.length === 0 || selectedCandidateSha256 === null) fail("selection-conflict");
  const selected = candidates.find(
    (candidate) => candidate.candidateSha256 === selectedCandidateSha256,
  );
  if (
    !selected ||
    selected.eligibility !== "eligible" ||
    selected.taskSha256 !== origin.request.taskSha256
  )
    fail("selection-conflict");
  if (
    origin.origin === "docsfab-autonomous"
      ? selectedSourceAutoCandidateSha256 !== origin.autonomousSelection.candidateSha256
      : selectedSourceAutoCandidateSha256 !== null
  )
    fail("selection-conflict");
  const rejectedCandidateDigests = candidates
    .filter((candidate) => candidate.candidateSha256 !== selectedCandidateSha256)
    .map((candidate) => candidate.candidateSha256)
    .sort(compare);
  if (
    canonicalJson(rejectedAlternatives.map((entry) => entry.candidateSha256)) !==
    canonicalJson(rejectedCandidateDigests)
  )
    fail("selection-conflict");
  for (const rejected of rejectedAlternatives) {
    const candidate = candidates.find(
      (entry) => entry.candidateSha256 === rejected.candidateSha256,
    );
    if (
      !candidate ||
      !rejected.evidenceSha256s.every((evidence) =>
        candidate.prerequisiteEvidenceSha256s.includes(evidence),
      )
    )
      fail("selection-conflict");
  }
  for (const domain of DECISION_LINEAGE_DOMAINS) {
    if (
      decisions.filter(
        (decision) => decision.domain === domain && decision.effect === "authoritative",
      ).length !== 1
    ) {
      fail("responsibility-expansion");
    }
  }
  const taskDecision = decisions.find(
    (decision) => decision.domain === "task" && decision.effect === "authoritative",
  );
  const repositoryDecision = decisions.find(
    (decision) => decision.domain === "repository" && decision.effect === "authoritative",
  );
  const workflowDecision = decisions.find(
    (decision) => decision.domain === "workflow" && decision.effect === "authoritative",
  );
  const expectedTaskAuthority =
    origin.origin === "docsfab-autonomous"
      ? origin.autonomousSelection.decisionSha256
      : origin.approval.approvalSha256;
  if (
    !taskDecision ||
    !repositoryDecision ||
    !workflowDecision ||
    taskDecision.outcomeSha256 !== origin.request.taskSha256 ||
    taskDecision.authoritySha256 !== expectedTaskAuthority ||
    !taskDecision.evidenceSha256s.includes(origin.request.requestSha256) ||
    repositoryDecision.outcomeSha256 !== origin.repository.identitySha256 ||
    workflowDecision.outcomeSha256 !== selectedCandidateSha256 ||
    !selected.prerequisiteEvidenceSha256s.every((evidence) =>
      workflowDecision.evidenceSha256s.includes(evidence),
    ) ||
    taskDecision.actor !== origin.selectedBy ||
    taskDecision.effect !== "authoritative" ||
    workflowDecision.effect !== "authoritative"
  )
    fail("responsibility-expansion");
  return {
    lineageId: origin.lineageId,
    originSha256: origin.originSha256,
    candidates,
    selectedCandidateSha256,
    selectedSourceAutoCandidateSha256,
    rejectedAlternatives,
    decisions,
    selectedWorkflow: selected.workflow,
    authorityStatus: status,
    observedAt,
    authorityReceiptSha256: receipt,
  };
}

function requestIdentity(value: unknown): TaskRequestIdentityV1 {
  const root = object(value);
  exact(root, ["kind", "requestSha256", "taskKind", "taskSha256"]);
  if (root.kind === "historical-unavailable") {
    if (
      root.requestSha256 !== null ||
      root.taskKind !== "historical-unknown" ||
      root.taskSha256 !== null
    )
      fail("ambiguous-origin");
    return {
      kind: "historical-unavailable",
      requestSha256: null,
      taskKind: "historical-unknown",
      taskSha256: null,
    };
  }
  const kind = enumeration(root.kind, ["bounded-instruction", "structured-task"] as const);
  const taskKind = enumeration(root.taskKind, [
    "ia-plan",
    "site-bootstrap",
    "bounded-doc-improvement",
    "instruction-only",
    "none",
  ] as const);
  if (kind === "structured-task" && (taskKind === "instruction-only" || taskKind === "none")) {
    fail("invalid-value");
  }
  return {
    kind,
    requestSha256: hash(root.requestSha256),
    taskKind,
    taskSha256: hash(root.taskSha256),
  };
}

function operatorApproval(value: unknown, request: TaskRequestIdentityV1): OperatorTaskApprovalV1 {
  if (request.kind === "historical-unavailable") fail("ambiguous-origin");
  const root = object(value);
  exact(root, [
    "authorityId",
    "operatorIdentitySha256",
    "approvalSha256",
    "approvedRequestSha256",
    "approvedTaskSha256",
    "approvedRecommendationSha256",
  ]);
  const result = {
    authorityId: identifier(root.authorityId),
    operatorIdentitySha256: hash(root.operatorIdentitySha256),
    approvalSha256: hash(root.approvalSha256),
    approvedRequestSha256: hash(root.approvedRequestSha256),
    approvedTaskSha256: hash(root.approvedTaskSha256),
    approvedRecommendationSha256: nullableHash(root.approvedRecommendationSha256),
  };
  if (
    result.approvedRequestSha256 !== request.requestSha256 ||
    result.approvedTaskSha256 !== request.taskSha256
  )
    fail("ambiguous-origin");
  return result;
}

function taskRecommendation(
  value: unknown,
  request: TaskRequestIdentityV1,
): DocsFabTaskRecommendationV1 {
  if (request.kind === "historical-unavailable") fail("ambiguous-origin");
  const root = object(value);
  exact(root, ["recommendationSha256", "recommendedTaskSha256", "evidenceSha256s"]);
  const result = {
    recommendationSha256: hash(root.recommendationSha256),
    recommendedTaskSha256: hash(root.recommendedTaskSha256),
    evidenceSha256s: normalizedHashes(root.evidenceSha256s, true),
  };
  if (result.recommendedTaskSha256 !== request.taskSha256) fail("ambiguous-origin");
  return result;
}

function autonomousTaskSelection(
  value: unknown,
  request: TaskRequestIdentityV1,
): AutonomousTaskSelectionV1 {
  if (request.kind === "historical-unavailable") fail("ambiguous-origin");
  const root = object(value);
  exact(root, [
    "requestSha256",
    "assessmentSha256",
    "decisionSha256",
    "authorizationSha256",
    "candidateSha256",
    "selectedTaskSha256",
    "maturityFindingSha256s",
  ]);
  const result = {
    requestSha256: hash(root.requestSha256),
    assessmentSha256: hash(root.assessmentSha256),
    decisionSha256: hash(root.decisionSha256),
    authorizationSha256: hash(root.authorizationSha256),
    candidateSha256: hash(root.candidateSha256),
    selectedTaskSha256: hash(root.selectedTaskSha256),
    maturityFindingSha256s: normalizedHashes(root.maturityFindingSha256s, true),
  };
  if (result.selectedTaskSha256 !== request.taskSha256) fail("ambiguous-origin");
  return result;
}

function workflowCandidate(
  value: unknown,
  workflows: TaskLineageWorkflowAccess,
): WorkflowLineageCandidateV1 {
  const root = object(value);
  noUnknown(root, [
    "id",
    "workflow",
    "taskSha256",
    "prerequisiteIds",
    "prerequisiteEvidenceSha256s",
    "eligibility",
    "reasonCode",
    "stepIds",
    "candidateSha256",
  ]);
  for (const required of [
    "id",
    "workflow",
    "taskSha256",
    "prerequisiteIds",
    "prerequisiteEvidenceSha256s",
    "eligibility",
    "reasonCode",
  ]) {
    if (!(required in root)) fail("invalid-shape");
  }
  const workflow = workflowName(root.workflow, workflows);
  const body = {
    id: identifier(root.id),
    workflow,
    taskSha256: hash(root.taskSha256),
    prerequisiteIds: normalizedIds(root.prerequisiteIds),
    prerequisiteEvidenceSha256s: normalizedHashes(
      root.prerequisiteEvidenceSha256s,
      root.eligibility === "eligible",
    ),
    eligibility: enumeration(root.eligibility, ["eligible", "ineligible"] as const),
    reasonCode: identifier(root.reasonCode),
    stepIds: workflows.getWorkflow(workflow).steps.map((step) => step.id),
  };
  const candidate = { ...body, candidateSha256: canonicalDigest(body) };
  if ("stepIds" in root && canonicalJson(root.stepIds) !== canonicalJson(candidate.stepIds)) {
    fail("digest-mismatch");
  }
  if ("candidateSha256" in root && root.candidateSha256 !== candidate.candidateSha256) {
    fail("digest-mismatch");
  }
  return deepFreeze(candidate);
}

function rejectedAlternative(value: unknown): RejectedWorkflowAlternativeInputV1 {
  const root = object(value);
  exact(root, ["candidateSha256", "reasonCode", "evidenceSha256s"]);
  return {
    candidateSha256: hash(root.candidateSha256),
    reasonCode: identifier(root.reasonCode),
    evidenceSha256s: normalizedHashes(root.evidenceSha256s, true),
  };
}

function decisionAttribution(value: unknown): DecisionAttributionInputV1 {
  const root = object(value);
  exact(root, [
    "id",
    "domain",
    "actor",
    "effect",
    "outcomeSha256",
    "authoritySource",
    "authoritySha256",
    "evidenceSha256s",
    "boundedByDecisionIds",
    "reasonCode",
  ]);
  const actor = enumeration(root.actor, DECISION_LINEAGE_ACTORS);
  const effect = enumeration(root.effect, ["authoritative", "advisory"] as const);
  const authoritySource = enumeration(root.authoritySource, [
    "operator-approval",
    "host-policy",
    "workflow-contract",
    "none",
  ] as const);
  const result = {
    id: identifier(root.id),
    domain: enumeration(root.domain, DECISION_LINEAGE_DOMAINS),
    actor,
    effect,
    outcomeSha256: hash(root.outcomeSha256),
    authoritySource,
    authoritySha256: nullableHash(root.authoritySha256),
    evidenceSha256s: normalizedHashes(root.evidenceSha256s, true),
    boundedByDecisionIds: normalizedIds(root.boundedByDecisionIds),
    reasonCode: identifier(root.reasonCode),
  };
  const expectedSource =
    actor === "operator"
      ? "operator-approval"
      : actor === "host-policy"
        ? "host-policy"
        : actor === "deterministic-workflow"
          ? "workflow-contract"
          : "none";
  if (
    authoritySource !== expectedSource ||
    (actor === "model") !== (effect === "advisory") ||
    (authoritySource === "none") !== (result.authoritySha256 === null) ||
    (actor === "model" && result.boundedByDecisionIds.length === 0) ||
    (actor !== "model" && result.boundedByDecisionIds.length !== 0)
  ) {
    fail("responsibility-expansion");
  }
  return result;
}

function validateDecisionReferences(decisions: DecisionAttributionInputV1[]): void {
  const byId = new Map(decisions.map((decision) => [decision.id, decision]));
  for (const decision of decisions) {
    for (const ceilingId of decision.boundedByDecisionIds) {
      const ceiling = byId.get(ceilingId);
      if (
        !ceiling ||
        ceiling.effect !== "authoritative" ||
        ceiling.actor === "model" ||
        ceiling.domain !== decision.domain
      )
        fail("responsibility-expansion");
    }
  }
}

function repositoryBinding(value: unknown): TaskLineageRepositoryBindingV1 {
  const root = object(value);
  exact(root, ["identitySha256", "revision"]);
  return { identitySha256: hash(root.identitySha256), revision: revision(root.revision) };
}

function consumeReceipt(verifier: InternalTaskLineageHostVerifier, receipt: string): void {
  receiptGuard.consume(verifier as object, receipt);
}

function sealOrigin(body: TaskOriginBodyV1): TaskOriginV1 {
  return seal("docsfab-task-origin", "originSha256", body) as TaskOriginV1;
}

function authorityStatus(value: unknown): "host-authenticated" | "historical-inert" {
  return enumeration(value, ["host-authenticated", "historical-inert"] as const);
}

function workflowName(value: unknown, workflows: TaskLineageWorkflowAccess): WorkflowName {
  const result = string(value);
  try {
    workflows.getWorkflow(result as WorkflowName);
  } catch {
    fail("invalid-value");
  }
  return result as WorkflowName;
}

function literal<const T extends string>(value: unknown, expected: T): T {
  if (value !== expected) fail("ambiguous-origin");
  return expected;
}

function candidateCompare(left: WorkflowLineageCandidateV1, right: WorkflowLineageCandidateV1) {
  return compare(left.candidateSha256, right.candidateSha256);
}
function rejectionCompare(
  left: RejectedWorkflowAlternativeInputV1,
  right: RejectedWorkflowAlternativeInputV1,
) {
  return compare(left.candidateSha256, right.candidateSha256);
}
function decisionCompare(left: DecisionAttributionInputV1, right: DecisionAttributionInputV1) {
  return compare(left.id, right.id);
}
