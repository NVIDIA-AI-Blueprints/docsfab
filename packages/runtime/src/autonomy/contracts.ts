// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RunStatus } from "../records/contracts.js";
import type {
  WorkflowDefinition,
  WorkflowName,
  WorkflowTaskInput,
} from "../workflow-contracts/contracts.js";
import { detectCredentialRuleIdsInValue } from "../security/repository-scanner.js";
import { normalizeWorkflowTaskInput } from "../workflow-contracts/task.js";
import {
  internalAutoCycleHostVerifier,
  type InternalAutoCycleHostAuthority,
  type InternalAutoCycleHostVerifier,
} from "./authority-internal.js";
import { LIMIT_DEFINITION_BY_NAME } from "../config/limits.generated.js";
import { deepFreeze } from "./dialect.js";
import {
  array,
  assertInert,
  canonicalDigest,
  canonicalJson,
  compare,
  decodeSealed,
  enumeration,
  exact,
  fail,
  fingerprintCompare,
  hash,
  idCompare,
  identifier,
  integer,
  noUnknown,
  normalizedHashes,
  normalizedIds,
  object,
  sourceSchemaVersion,
  string,
  stringArray,
  timestamp,
  unique,
} from "./contracts/codec-kit.js";
import {
  branch,
  normalizedPaths,
  relativePath,
  repositoryBinding,
  revision,
  runEvidence,
  validationResult,
  workflowName,
} from "./contracts/evidence-codecs.js";
import {
  AUTO_CYCLE_DELIVERY_MODES,
  AUTO_CYCLE_PATH_CLASSES,
  assertModeCompatible,
  seal,
} from "./contracts/scope-values.js";
import {
  createAutoAssessment,
  createAutoCycleRequest,
  createWorkflowCandidate,
  decodeAutoAssessment,
  decodeAutoCycleRequest,
  decodeWorkflowCandidate,
} from "./contracts/request-assessment-codecs.js";
export { AUTO_CYCLE_DELIVERY_MODES, AUTO_CYCLE_PATH_CLASSES };
export {
  createAutoAssessment,
  createAutoCycleRequest,
  createWorkflowCandidate,
  decodeAutoAssessment,
  decodeAutoCycleRequest,
  decodeWorkflowCandidate,
};
export { AutoCycleContractError } from "./contracts/codec-kit.js";
export type { AutoCycleContractErrorCode } from "./contracts/codec-kit.js";

export const AUTO_CYCLE_SCHEMA_VERSION = 1 as const;

const AUTHORIZATION_WINDOW_MS = limitDefinitionMax("autonomy.authorizationWindowMs");

function limitDefinitionMax(name: string): number {
  const definition = LIMIT_DEFINITION_BY_NAME[name];
  if (!definition) {
    throw new Error(`Unknown operational limit ${name} is not declared in config/limits.yaml.`);
  }
  return definition.max;
}

export interface AutoCycleWorkflowAccess {
  getWorkflow(name: WorkflowName): WorkflowDefinition;
  isRunnableWorkflowName(value: string): boolean;
}

export const AUTO_CYCLE_DECISION_DISPOSITIONS = [
  "execute",
  "no-action",
  "needs-input",
  "blocked",
  "superseded",
] as const;
export type AutoCycleDecisionDisposition = (typeof AUTO_CYCLE_DECISION_DISPOSITIONS)[number];

export type AutoCyclePathClass = (typeof AUTO_CYCLE_PATH_CLASSES)[number];

export type AutoCycleDeliveryMode = (typeof AUTO_CYCLE_DELIVERY_MODES)[number];

export type AutoEvidenceState = "sufficient" | "low-confidence" | "conflicting" | "blocked";
export type AutoPrerequisiteState = "satisfied" | "missing" | "conflicting" | "blocked";

export interface AutoRepositoryBindingV1 {
  identitySha256: string;
  revision: string;
}

export interface AutoTrackerObservationBindingV1 {
  projectIdentitySha256: string;
  observationSha256: string;
  observedAt: string;
  /** V1 observes tracker state but never grants tracker mutation authority. */
  authority: "observe-only";
}

export interface AutoWorkflowPrerequisiteRequirementV1 {
  workflow: WorkflowName;
  prerequisiteIds: string[];
}

export interface AutoWorkflowTaskBindingV1 {
  workflow: WorkflowName;
  taskKind: WorkflowTaskInput["kind"] | "none";
  taskSha256: string;
}

export interface AutoCycleBoundsV1 {
  workflowNames: WorkflowName[];
  pathClass: AutoCyclePathClass;
  pathPrefixes: string[];
  targetBranch: string;
  deliveryMode: AutoCycleDeliveryMode;
  requiredValidationIds: string[];
  workflowPrerequisites: AutoWorkflowPrerequisiteRequirementV1[];
  workflowTasks: AutoWorkflowTaskBindingV1[];
}

export interface AutoCycleRequestInputV1 {
  cycleId: string;
  repository: AutoRepositoryBindingV1;
  tracker: AutoTrackerObservationBindingV1;
  maturityFindingSha256s: string[];
  bounds: AutoCycleBoundsV1;
}

export interface AutoCycleRequestV1 extends AutoCycleRequestInputV1 {
  schemaVersion: 1;
  kind: "docsfab-auto-cycle-request";
  requestSha256: string;
}

export interface AutoMaturityFindingReferenceV1 {
  fingerprint: string;
  findingSha256: string;
  confidence: "confirmed" | "bounded" | "inconclusive";
  disposition:
    | "observed-absence"
    | "bounded-not-found"
    | "unknown"
    | "not-applicable"
    | "blocked"
    | "satisfied";
}

export interface AutoWorkflowPrerequisiteV1 {
  id: string;
  state: AutoPrerequisiteState;
  evidenceSha256s: string[];
}

export interface WorkflowCandidateInputV1 {
  id: string;
  /** Content-free binding to the Task that the registered Workflow will execute. */
  taskSha256: string;
  workflow: WorkflowName;
  /** Must equal the registered Workflow's exact ordered Step IDs. */
  stepIds: string[];
  prerequisites: AutoWorkflowPrerequisiteV1[];
  maturityFindingFingerprints: string[];
  pathClass: AutoCyclePathClass;
  pathPrefixes: string[];
  deliveryMode: AutoCycleDeliveryMode;
  validationIds: string[];
}

export interface WorkflowCandidateV1 extends WorkflowCandidateInputV1 {
  schemaVersion: 1;
  kind: "docsfab-auto-workflow-candidate";
  candidateSha256: string;
}

export interface AutoAssessmentInputV1 {
  requestSha256: string;
  repository: AutoRepositoryBindingV1;
  trackerObservationSha256: string;
  evidenceState: AutoEvidenceState;
  maturityFindings: AutoMaturityFindingReferenceV1[];
  candidates: WorkflowCandidateInputV1[];
  openInputIds: string[];
}

export interface AutoAssessmentV1 extends Omit<AutoAssessmentInputV1, "candidates"> {
  schemaVersion: 1;
  kind: "docsfab-auto-assessment";
  candidates: WorkflowCandidateV1[];
  assessmentSha256: string;
}

interface WorkflowDecisionBaseV1 {
  schemaVersion: 1;
  kind: "docsfab-auto-workflow-decision";
  requestSha256: string;
  assessmentSha256: string;
  disposition: AutoCycleDecisionDisposition;
  decisionSha256: string;
}

export interface ExecuteWorkflowDecisionV1 extends WorkflowDecisionBaseV1 {
  disposition: "execute";
  candidateSha256: string;
  workflow: WorkflowName;
  reasonCode: "eligible-candidate-selected";
  openInputIds: [];
  supersedingRequestSha256: null;
}

export interface NonExecuteWorkflowDecisionV1 extends WorkflowDecisionBaseV1 {
  disposition: "no-action" | "needs-input" | "blocked" | "superseded";
  candidateSha256: null;
  workflow: null;
  reasonCode: string;
  openInputIds: string[];
  supersedingRequestSha256: string | null;
}

export type WorkflowDecisionV1 = ExecuteWorkflowDecisionV1 | NonExecuteWorkflowDecisionV1;

export interface AutoCycleAuthorizationInputV1 {
  requestSha256: string;
  assessmentSha256: string;
  decisionSha256: string;
  repository: AutoRepositoryBindingV1;
  trackerObservationSha256: string;
  workflow: WorkflowName;
  candidateSha256: string;
  pathClass: AutoCyclePathClass;
  pathPrefixes: string[];
  targetBranch: string;
  deliveryMode: AutoCycleDeliveryMode;
  validationIds: string[];
  authorizedAt: string;
  expiresAt: string;
}

export interface AutoCycleAuthorizationV1 extends AutoCycleAuthorizationInputV1 {
  schemaVersion: 1;
  kind: "docsfab-auto-cycle-authorization";
  authorizationSha256: string;
}

export type AutoCyclePhase = "assessing" | "decided" | "authorized" | "executing";

export interface AutoCycleCheckpointInputV1 {
  cycleId: string;
  sequence: number;
  phase: AutoCyclePhase;
  requestSha256: string;
  assessmentSha256: string | null;
  decisionSha256: string | null;
  authorizationSha256: string | null;
  workflowExecutionStatus: RunStatus | null;
  previousCheckpointSha256: string | null;
}

export interface AutoCycleCheckpointV1 extends AutoCycleCheckpointInputV1 {
  schemaVersion: 1;
  kind: "docsfab-auto-cycle-checkpoint";
  checkpointSha256: string;
}

export type AutoWorkflowExecutionStatus =
  | "not-run"
  | "succeeded"
  | "failed"
  | "needs-input"
  | "needs-human-decision";

export interface AutoValidationResultV1 {
  id: string;
  status: "passed" | "failed" | "not-run";
  evidenceSha256: string | null;
}

export interface AutoCycleTerminalResultInputV1 {
  cycleId: string;
  requestSha256: string;
  assessmentSha256: string;
  decisionSha256: string;
  decisionDisposition: AutoCycleDecisionDisposition;
  authorizationSha256: string | null;
  workflowExecutionStatus: AutoWorkflowExecutionStatus;
  runRecordSha256: string | null;
  runEvidenceSha256: string | null;
  finalCheckpointSha256: string;
  validation: AutoValidationResultV1[];
  completedAt: string;
}

export interface AutoCycleTerminalResultV1 extends AutoCycleTerminalResultInputV1 {
  schemaVersion: 1;
  kind: "docsfab-auto-cycle-terminal-result";
  terminalResultSha256: string;
}

export interface AutoCycleRunEvidenceV1 {
  id: string;
  recordSha256: string;
  workflow: WorkflowName;
  repository: AutoRepositoryBindingV1;
  taskSha256: string;
  status: Exclude<RunStatus, "queued" | "running">;
}

export interface AutoCycleTerminalEvidenceV1 {
  authorization: AutoCycleAuthorizationV1 | null;
  checkpoints: readonly AutoCycleCheckpointV1[];
  run: AutoCycleRunEvidenceV1 | null;
}

export interface AutoCycleAuthorizationProjectionV1 {
  schemaVersion: 1;
  kind: "docsfab-auto-cycle-authorization-projection";
  requestSha256: string;
  decisionSha256: string;
  authorizationSha256: string;
  repositoryIdentitySha256: string;
  repositoryRevision: string;
  trackerObservationSha256: string;
  workflow: WorkflowName;
  candidateSha256: string;
  pathClass: AutoCyclePathClass;
  pathPrefixSha256s: string[];
  targetBranchSha256: string;
  deliveryMode: AutoCycleDeliveryMode;
  validationIds: string[];
  projectionSha256: string;
}

export const AUTO_CYCLE_MIGRATION_POLICY = deepFreeze({
  schemaVersion: 1 as const,
  kind: "docsfab-auto-cycle-migration-policy" as const,
  currentSchemaVersion: 1 as const,
  acceptedSourceVersions: [1] as const,
  v1: "identity-only" as const,
  unknownVersion: "reject" as const,
});

/**
 * Non-serializable host capability. Its private runtime identity, not its fields,
 * is authority; JSON authorization artifacts stay inert.
 */
export interface AutoCycleHostCapability {
  readonly kind: "docsfab-auto-cycle-host-capability";
}

export interface AutoCycleAuthorityChallengeV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-auto-cycle-authority-challenge";
  readonly requestSha256: string;
  readonly repository: AutoRepositoryBindingV1;
  readonly tracker: AutoTrackerObservationBindingV1;
  readonly maturityFindingSha256s: string[];
  readonly assessmentSha256: string;
  readonly decisionSha256: string;
  readonly ceilingSha256: string;
  readonly challengeSha256: string;
}

interface CapabilityState {
  request: AutoCycleRequestV1;
  assessment: AutoAssessmentV1;
  decision: ExecuteWorkflowDecisionV1;
  /** The registry view used to mint this capability; authorization must reuse it. */
  workflows: AutoCycleWorkflowAccess;
  ceilingSha256: string;
  challenge: AutoCycleAuthorityChallengeV1;
  verifier: InternalAutoCycleHostVerifier;
  verifiedAt: string;
  issuedAuthorization: {
    authorizationSha256: string;
    authorizedAt: string;
    expiresAt: string;
  } | null;
}

const capabilities = new WeakMap<object, CapabilityState>();

/**
 * Content-free identity of the exact task the WorkflowRunner must receive. The
 * task body stays out of persisted artifacts and is rechecked at execution.
 */
export function createAutoWorkflowTaskBinding(
  workflowValue: WorkflowName,
  task: WorkflowTaskInput | null,
  repository: AutoRepositoryBindingV1,
  workflows: AutoCycleWorkflowAccess,
): AutoWorkflowTaskBindingV1 {
  const workflow = workflowName(workflowValue, workflows);
  const definition = workflows.getWorkflow(workflow);
  assertInert(task);
  if (task !== null && detectCredentialRuleIdsInValue(task).length > 0) fail("invalid-value");
  let normalized: WorkflowTaskInput | null;
  try {
    normalized = normalizeWorkflowTaskInput({
      workflow,
      task,
      repository: repositoryBinding(repository),
      allowWrite: definition.steps.some((step) => step.mode === "write"),
    });
  } catch {
    fail("invalid-value");
  }
  return deepFreeze({
    workflow,
    taskKind: normalized?.kind ?? "none",
    taskSha256: canonicalDigest(normalized),
  });
}

export function assertAutoCycleExecutionTask(
  candidateValue: WorkflowCandidateV1,
  requestValue: AutoCycleRequestV1,
  task: WorkflowTaskInput | null,
  workflows: AutoCycleWorkflowAccess,
): void {
  const request = decodeAutoCycleRequest(requestValue, workflows);
  const candidate = decodeWorkflowCandidate(candidateValue, request, workflows);
  const expected = request.bounds.workflowTasks.find(
    (item) => item.workflow === candidate.workflow,
  );
  const observed = createAutoWorkflowTaskBinding(
    candidate.workflow,
    task,
    request.repository,
    workflows,
  );
  if (
    !expected ||
    expected.taskSha256 !== candidate.taskSha256 ||
    canonicalJson(expected) !== canonicalJson(observed)
  )
    fail("scope-expansion");
  if (task?.kind === "bounded-doc-improvement") {
    if (
      task.repositoryIdentitySha256 !== request.repository.identitySha256 ||
      task.testedCommit !== request.repository.revision ||
      task.intendedPaths.length === 0 ||
      task.intendedPaths.some(
        (path) =>
          !candidate.pathPrefixes.some(
            (prefix) => path === prefix || path.startsWith(`${prefix}/`),
          ),
      )
    )
      fail("scope-expansion");
  }
  if (
    task?.kind === "site-bootstrap" &&
    task.plan.repositoryRevision !== request.repository.revision
  )
    fail("scope-expansion");
}

export function createWorkflowDecision(
  input: {
    disposition: AutoCycleDecisionDisposition;
    candidateSha256?: string;
    reasonCode: string;
    openInputIds?: string[];
    supersedingRequestSha256?: string;
  },
  request: AutoCycleRequestV1,
  assessment: AutoAssessmentV1,
  workflows: AutoCycleWorkflowAccess,
): WorkflowDecisionV1 {
  const currentRequest = decodeAutoCycleRequest(request, workflows);
  const currentAssessment = decodeAutoAssessment(assessment, currentRequest, workflows);
  assertInert(input);
  noUnknown(object(input), [
    "disposition",
    "candidateSha256",
    "reasonCode",
    "openInputIds",
    "supersedingRequestSha256",
  ]);
  return normalizeDecision(input, currentRequest, currentAssessment);
}

export function decodeWorkflowDecision(
  value: unknown,
  request: AutoCycleRequestV1,
  assessment: AutoAssessmentV1,
  workflows: AutoCycleWorkflowAccess,
): WorkflowDecisionV1 {
  assertInert(value);
  const root = object(value);
  exact(root, [
    "schemaVersion",
    "kind",
    "requestSha256",
    "assessmentSha256",
    "disposition",
    "candidateSha256",
    "workflow",
    "reasonCode",
    "openInputIds",
    "supersedingRequestSha256",
    "decisionSha256",
  ]);
  const decision = createWorkflowDecision(
    {
      disposition: enumeration(root.disposition, AUTO_CYCLE_DECISION_DISPOSITIONS),
      ...(root.candidateSha256 === null ? {} : { candidateSha256: hash(root.candidateSha256) }),
      reasonCode: identifier(root.reasonCode),
      openInputIds: stringArray(root.openInputIds),
      ...(root.supersedingRequestSha256 === null
        ? {}
        : {
            supersedingRequestSha256: hash(root.supersedingRequestSha256),
          }),
    },
    request,
    assessment,
    workflows,
  );
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-auto-workflow-decision" ||
    canonicalJson(root) !== canonicalJson(decision)
  )
    fail("digest-mismatch");
  return decision;
}

/** Minted only at the trusted host boundary after independently checking current observations. */
export async function mintAutoCycleHostCapability(
  input: {
    request: AutoCycleRequestV1;
    assessment: AutoAssessmentV1;
    decision: WorkflowDecisionV1;
  },
  authority: InternalAutoCycleHostAuthority,
  workflows: AutoCycleWorkflowAccess,
): Promise<AutoCycleHostCapability> {
  noUnknown(object(input), ["request", "assessment", "decision"]);
  const request = decodeAutoCycleRequest(input.request, workflows);
  const assessment = decodeAutoAssessment(input.assessment, request, workflows);
  const decision = decodeWorkflowDecision(input.decision, request, assessment, workflows);
  if (decision.disposition !== "execute") fail("authorization-required");
  const verifier = internalAutoCycleHostVerifier(authority);
  if (!verifier) fail("authorization-required");
  const ceilingSha256 = authorizationCeiling(request, assessment, decision);
  const challenge = createAuthorityChallenge(request, assessment, decision, ceilingSha256);
  const verifiedAt = await verifyHostCurrent(verifier, challenge);
  const capability = deepFreeze({ kind: "docsfab-auto-cycle-host-capability" as const });
  capabilities.set(capability, {
    request,
    assessment,
    decision,
    workflows,
    ceilingSha256,
    challenge,
    verifier,
    verifiedAt,
    issuedAuthorization: null,
  });
  return capability;
}

export function createAutoCycleAuthorization(
  input: Pick<AutoCycleAuthorizationInputV1, "authorizedAt" | "expiresAt">,
  capability: AutoCycleHostCapability,
): AutoCycleAuthorizationV1 {
  const state = capabilities.get(capability as object);
  if (!state) fail("authorization-required");
  assertInert(input);
  exact(object(input), ["authorizedAt", "expiresAt"]);
  const candidate = state.assessment.candidates.find(
    (item) => item.candidateSha256 === state.decision.candidateSha256,
  );
  if (!candidate) fail("decision-conflict");
  const authorizedAt = timestamp(input.authorizedAt);
  const expiresAt = timestamp(input.expiresAt);
  if (
    authorizedAt !== state.verifiedAt ||
    expiresAt <= authorizedAt ||
    Date.parse(expiresAt) - Date.parse(authorizedAt) > AUTHORIZATION_WINDOW_MS ||
    state.issuedAuthorization !== null
  )
    fail("authorization-required");
  const body: AutoCycleAuthorizationInputV1 = {
    requestSha256: state.request.requestSha256,
    assessmentSha256: state.assessment.assessmentSha256,
    decisionSha256: state.decision.decisionSha256,
    repository: state.request.repository,
    trackerObservationSha256: state.request.tracker.observationSha256,
    workflow: candidate.workflow,
    candidateSha256: candidate.candidateSha256,
    pathClass: candidate.pathClass,
    pathPrefixes: candidate.pathPrefixes,
    targetBranch: state.request.bounds.targetBranch,
    deliveryMode: candidate.deliveryMode,
    validationIds: candidate.validationIds,
    authorizedAt,
    expiresAt,
  };
  const authorization = seal("docsfab-auto-cycle-authorization", "authorizationSha256", body);
  state.issuedAuthorization = {
    authorizationSha256: authorization.authorizationSha256,
    authorizedAt,
    expiresAt,
  };
  return authorization;
}

/** Structural persistence decoder; it intentionally does not create execution authority. */
export function decodeAutoCycleAuthorization(
  value: unknown,
  workflows: AutoCycleWorkflowAccess,
): AutoCycleAuthorizationV1 {
  return decodeSealed(
    value,
    "docsfab-auto-cycle-authorization",
    "authorizationSha256",
    [
      "requestSha256",
      "assessmentSha256",
      "decisionSha256",
      "repository",
      "trackerObservationSha256",
      "workflow",
      "candidateSha256",
      "pathClass",
      "pathPrefixes",
      "targetBranch",
      "deliveryMode",
      "validationIds",
      "authorizedAt",
      "expiresAt",
    ],
    (root) => normalizeAuthorizationInput(root, workflows),
  );
}

/** Execution gate: a valid persisted artifact and the original private capability are both required. */
export async function assertAutoCycleAuthorized(
  authorizationValue: unknown,
  capability: AutoCycleHostCapability,
  executionTask: WorkflowTaskInput | null,
  workflows: AutoCycleWorkflowAccess,
): Promise<AutoCycleAuthorizationV1> {
  const state = capabilities.get(capability as object);
  // Resolve the capability before decoding caller input: the registry view is
  // part of the authorization boundary and cannot be swapped after minting.
  if (!state || workflows !== state.workflows) fail("authorization-required");
  const authorization = decodeAutoCycleAuthorization(authorizationValue, state.workflows);
  if (
    authorizationCeilingFromArtifact(authorization) !== state.ceilingSha256 ||
    !state.issuedAuthorization ||
    authorization.authorizationSha256 !== state.issuedAuthorization.authorizationSha256 ||
    authorization.authorizedAt !== state.issuedAuthorization.authorizedAt ||
    authorization.expiresAt !== state.issuedAuthorization.expiresAt
  ) {
    fail("authorization-required");
  }
  const candidate = state.assessment.candidates.find(
    (item) => item.candidateSha256 === state.decision.candidateSha256,
  );
  if (!candidate) fail("decision-conflict");
  assertAutoCycleExecutionTask(candidate, state.request, executionTask, state.workflows);
  const currentTime = await verifyHostCurrent(state.verifier, state.challenge);
  if (currentTime < authorization.authorizedAt || currentTime >= authorization.expiresAt) {
    fail("authorization-expired");
  }
  return authorization;
}

/** Content-minimized projection for run records; paths and branch names become hashes. */
export function projectAutoCycleAuthorization(
  authorizationValue: unknown,
  workflows: AutoCycleWorkflowAccess,
): AutoCycleAuthorizationProjectionV1 {
  const authorization = decodeAutoCycleAuthorization(authorizationValue, workflows);
  const body = {
    requestSha256: authorization.requestSha256,
    decisionSha256: authorization.decisionSha256,
    authorizationSha256: authorization.authorizationSha256,
    repositoryIdentitySha256: authorization.repository.identitySha256,
    repositoryRevision: authorization.repository.revision,
    trackerObservationSha256: authorization.trackerObservationSha256,
    workflow: authorization.workflow,
    candidateSha256: authorization.candidateSha256,
    pathClass: authorization.pathClass,
    pathPrefixSha256s: authorization.pathPrefixes.map(canonicalDigest).sort(compare),
    targetBranchSha256: canonicalDigest(authorization.targetBranch),
    deliveryMode: authorization.deliveryMode,
    validationIds: authorization.validationIds,
  };
  return seal("docsfab-auto-cycle-authorization-projection", "projectionSha256", body);
}

export function createAutoCycleCheckpoint(
  input: AutoCycleCheckpointInputV1,
): AutoCycleCheckpointV1 {
  assertInert(input);
  return seal("docsfab-auto-cycle-checkpoint", "checkpointSha256", normalizeCheckpoint(input));
}

export function decodeAutoCycleCheckpoint(value: unknown): AutoCycleCheckpointV1 {
  return decodeSealed(
    value,
    "docsfab-auto-cycle-checkpoint",
    "checkpointSha256",
    [
      "cycleId",
      "sequence",
      "phase",
      "requestSha256",
      "assessmentSha256",
      "decisionSha256",
      "authorizationSha256",
      "workflowExecutionStatus",
      "previousCheckpointSha256",
    ],
    (root) => normalizeCheckpoint(root as unknown as AutoCycleCheckpointInputV1),
  );
}

/** Validate an independently persisted resume chain; checkpoints never confer authority. */
export function validateAutoCycleCheckpointChain(
  values: readonly unknown[],
): AutoCycleCheckpointV1[] {
  if (values.length === 0 || values.length > 10_000) fail("invalid-value");
  const checkpoints = values.map(decodeAutoCycleCheckpoint);
  for (const [index, checkpoint] of checkpoints.entries()) {
    const previous = checkpoints[index - 1];
    if (!previous) {
      if (checkpoint.sequence !== 0 || checkpoint.previousCheckpointSha256 !== null) {
        fail("invalid-value");
      }
      continue;
    }
    if (
      checkpoint.sequence !== previous.sequence + 1 ||
      checkpoint.previousCheckpointSha256 !== previous.checkpointSha256 ||
      checkpoint.cycleId !== previous.cycleId ||
      checkpoint.requestSha256 !== previous.requestSha256 ||
      phaseRank(checkpoint.phase) < phaseRank(previous.phase) ||
      !monotonicNullableDigest(previous.assessmentSha256, checkpoint.assessmentSha256) ||
      !monotonicNullableDigest(previous.decisionSha256, checkpoint.decisionSha256) ||
      !monotonicNullableDigest(previous.authorizationSha256, checkpoint.authorizationSha256) ||
      !monotonicExecutionStatus(
        previous.workflowExecutionStatus,
        checkpoint.workflowExecutionStatus,
      )
    )
      fail("invalid-value");
  }
  return deepFreeze(checkpoints);
}

export function createAutoCycleTerminalResult(
  input: AutoCycleTerminalResultInputV1,
  request: AutoCycleRequestV1,
  assessment: AutoAssessmentV1,
  decision: WorkflowDecisionV1,
  evidence: AutoCycleTerminalEvidenceV1,
  workflows: AutoCycleWorkflowAccess,
): AutoCycleTerminalResultV1 {
  assertInert(input);
  const currentRequest = decodeAutoCycleRequest(request, workflows);
  const currentAssessment = decodeAutoAssessment(assessment, currentRequest, workflows);
  const currentDecision = decodeWorkflowDecision(
    decision,
    currentRequest,
    currentAssessment,
    workflows,
  );
  return seal(
    "docsfab-auto-cycle-terminal-result",
    "terminalResultSha256",
    normalizeTerminal(
      input,
      currentRequest,
      currentAssessment,
      currentDecision,
      evidence,
      workflows,
    ),
  );
}

export function decodeAutoCycleTerminalResult(
  value: unknown,
  request: AutoCycleRequestV1,
  assessment: AutoAssessmentV1,
  decision: WorkflowDecisionV1,
  evidence: AutoCycleTerminalEvidenceV1,
  workflows: AutoCycleWorkflowAccess,
): AutoCycleTerminalResultV1 {
  return decodeSealed(
    value,
    "docsfab-auto-cycle-terminal-result",
    "terminalResultSha256",
    [
      "cycleId",
      "requestSha256",
      "assessmentSha256",
      "decisionSha256",
      "decisionDisposition",
      "authorizationSha256",
      "workflowExecutionStatus",
      "runRecordSha256",
      "runEvidenceSha256",
      "finalCheckpointSha256",
      "validation",
      "completedAt",
    ],
    (root) =>
      normalizeTerminal(
        root as unknown as AutoCycleTerminalResultInputV1,
        decodeAutoCycleRequest(request, workflows),
        decodeAutoAssessment(assessment, request, workflows),
        decodeWorkflowDecision(decision, request, assessment, workflows),
        evidence,
        workflows,
      ),
  );
}

export function migrateAutoCycleRequest(
  value: unknown,
  workflows: AutoCycleWorkflowAccess,
): AutoCycleRequestV1 {
  if (sourceSchemaVersion(value) !== 1) fail("migration-required");
  return decodeAutoCycleRequest(value, workflows);
}

export function migrateWorkflowCandidate(
  value: unknown,
  request: AutoCycleRequestV1,
  workflows: AutoCycleWorkflowAccess,
): WorkflowCandidateV1 {
  if (sourceSchemaVersion(value) !== 1) fail("migration-required");
  return decodeWorkflowCandidate(value, request, workflows);
}

export function migrateAutoAssessment(
  value: unknown,
  request: AutoCycleRequestV1,
  workflows: AutoCycleWorkflowAccess,
): AutoAssessmentV1 {
  if (sourceSchemaVersion(value) !== 1) fail("migration-required");
  return decodeAutoAssessment(value, request, workflows);
}

export function migrateWorkflowDecision(
  value: unknown,
  request: AutoCycleRequestV1,
  assessment: AutoAssessmentV1,
  workflows: AutoCycleWorkflowAccess,
): WorkflowDecisionV1 {
  if (sourceSchemaVersion(value) !== 1) fail("migration-required");
  return decodeWorkflowDecision(value, request, assessment, workflows);
}

export function migrateAutoCycleAuthorization(
  value: unknown,
  workflows: AutoCycleWorkflowAccess,
): AutoCycleAuthorizationV1 {
  if (sourceSchemaVersion(value) !== 1) fail("migration-required");
  return decodeAutoCycleAuthorization(value, workflows);
}

export function migrateAutoCycleCheckpoint(value: unknown): AutoCycleCheckpointV1 {
  if (sourceSchemaVersion(value) !== 1) fail("migration-required");
  return decodeAutoCycleCheckpoint(value);
}

export function migrateAutoCycleTerminalResult(
  value: unknown,
  request: AutoCycleRequestV1,
  assessment: AutoAssessmentV1,
  decision: WorkflowDecisionV1,
  evidence: AutoCycleTerminalEvidenceV1,
  workflows: AutoCycleWorkflowAccess,
): AutoCycleTerminalResultV1 {
  if (sourceSchemaVersion(value) !== 1) fail("migration-required");
  return decodeAutoCycleTerminalResult(value, request, assessment, decision, evidence, workflows);
}

function normalizeDecision(
  input: {
    disposition: AutoCycleDecisionDisposition;
    candidateSha256?: string;
    reasonCode: string;
    openInputIds?: string[];
    supersedingRequestSha256?: string;
  },
  request: AutoCycleRequestV1,
  assessment: AutoAssessmentV1,
): WorkflowDecisionV1 {
  const disposition = enumeration(input.disposition, AUTO_CYCLE_DECISION_DISPOSITIONS);
  const openInputIds = normalizedIds(input.openInputIds ?? [], false);
  const reasonCode = identifier(input.reasonCode);
  let selected: WorkflowCandidateV1 | undefined;
  if (disposition === "execute") {
    if (
      assessment.evidenceState !== "sufficient" ||
      assessment.openInputIds.length > 0 ||
      openInputIds.length > 0 ||
      !input.candidateSha256
    )
      fail("decision-conflict");
    selected = assessment.candidates.find((item) => item.candidateSha256 === input.candidateSha256);
    if (!selected) fail("decision-conflict");
    if (selected.prerequisites.some((item) => item.state !== "satisfied")) {
      fail("prerequisite-unsatisfied");
    }
    const findingsByFingerprint = new Map(
      assessment.maturityFindings.map((finding) => [finding.fingerprint, finding]),
    );
    if (
      selected.maturityFindingFingerprints.length === 0 ||
      selected.maturityFindingFingerprints.some((fingerprint) => {
        const finding = findingsByFingerprint.get(fingerprint);
        return (
          !finding ||
          finding.confidence === "inconclusive" ||
          (finding.disposition !== "observed-absence" &&
            finding.disposition !== "bounded-not-found")
        );
      })
    )
      fail("decision-conflict");
    if (reasonCode !== "eligible-candidate-selected") fail("decision-conflict");
  } else if (disposition === "needs-input") {
    if (
      !(
        assessment.evidenceState === "low-confidence" ||
        assessment.evidenceState === "conflicting" ||
        assessment.openInputIds.length > 0 ||
        assessment.candidates.some((candidate) =>
          candidate.prerequisites.some(
            (item) => item.state === "missing" || item.state === "conflicting",
          ),
        )
      )
    ) {
      fail("decision-conflict");
    }
    if (openInputIds.length === 0) fail("decision-conflict");
  } else if (disposition === "blocked") {
    if (
      assessment.evidenceState !== "blocked" &&
      !assessment.candidates.some((candidate) =>
        candidate.prerequisites.some((item) => item.state === "blocked"),
      )
    )
      fail("decision-conflict");
  } else if (disposition === "no-action") {
    if (
      assessment.evidenceState !== "sufficient" ||
      assessment.candidates.length > 0 ||
      assessment.openInputIds.length > 0
    )
      fail("decision-conflict");
  } else if (!input.supersedingRequestSha256) {
    fail("decision-conflict");
  }
  const body = {
    requestSha256: request.requestSha256,
    assessmentSha256: assessment.assessmentSha256,
    disposition,
    candidateSha256: selected?.candidateSha256 ?? null,
    workflow: selected?.workflow ?? null,
    reasonCode,
    openInputIds,
    supersedingRequestSha256:
      disposition === "superseded" ? hash(input.supersedingRequestSha256) : null,
  };
  return seal("docsfab-auto-workflow-decision", "decisionSha256", body) as WorkflowDecisionV1;
}

function normalizeAuthorizationInput(
  value: Record<string, unknown>,
  workflows: AutoCycleWorkflowAccess,
): AutoCycleAuthorizationInputV1 {
  const workflow = workflowName(value.workflow, workflows);
  const pathClass = enumeration(value.pathClass, AUTO_CYCLE_PATH_CLASSES);
  const deliveryMode = enumeration(value.deliveryMode, AUTO_CYCLE_DELIVERY_MODES);
  assertModeCompatible(pathClass, deliveryMode);
  const authorizedAt = timestamp(value.authorizedAt);
  const expiresAt = timestamp(value.expiresAt);
  if (expiresAt <= authorizedAt) fail("invalid-value");
  return {
    requestSha256: hash(value.requestSha256),
    assessmentSha256: hash(value.assessmentSha256),
    decisionSha256: hash(value.decisionSha256),
    repository: repositoryBinding(value.repository),
    trackerObservationSha256: hash(value.trackerObservationSha256),
    workflow,
    candidateSha256: hash(value.candidateSha256),
    pathClass,
    pathPrefixes: normalizedPaths(value.pathPrefixes, pathClass),
    targetBranch: branch(value.targetBranch),
    deliveryMode,
    validationIds: normalizedIds(value.validationIds, true),
    authorizedAt,
    expiresAt,
  };
}

function normalizeCheckpoint(value: AutoCycleCheckpointInputV1): AutoCycleCheckpointInputV1 {
  const root = object(value);
  exact(root, [
    "cycleId",
    "sequence",
    "phase",
    "requestSha256",
    "assessmentSha256",
    "decisionSha256",
    "authorizationSha256",
    "workflowExecutionStatus",
    "previousCheckpointSha256",
  ]);
  const phase = enumeration(root.phase, [
    "assessing",
    "decided",
    "authorized",
    "executing",
  ] as const);
  const sequence = integer(root.sequence);
  if (sequence < 0) fail("invalid-value");
  const nullableHash = (item: unknown) => (item === null ? null : hash(item));
  const assessmentSha256 = nullableHash(root.assessmentSha256);
  const decisionSha256 = nullableHash(root.decisionSha256);
  const authorizationSha256 = nullableHash(root.authorizationSha256);
  const status =
    root.workflowExecutionStatus === null
      ? null
      : enumeration(root.workflowExecutionStatus, [
          "queued",
          "running",
          "needs-input",
          "needs-human-decision",
          "succeeded",
          "failed",
        ] as const);
  if (
    (phase === "assessing" &&
      (assessmentSha256 || decisionSha256 || authorizationSha256 || status)) ||
    (phase === "decided" &&
      (!assessmentSha256 || !decisionSha256 || authorizationSha256 || status)) ||
    (phase === "authorized" &&
      (!assessmentSha256 || !decisionSha256 || !authorizationSha256 || status)) ||
    (phase === "executing" &&
      (!assessmentSha256 || !decisionSha256 || !authorizationSha256 || !status))
  )
    fail("invalid-value");
  return {
    cycleId: identifier(root.cycleId),
    sequence,
    phase,
    requestSha256: hash(root.requestSha256),
    assessmentSha256,
    decisionSha256,
    authorizationSha256,
    workflowExecutionStatus: status,
    previousCheckpointSha256: nullableHash(root.previousCheckpointSha256),
  };
}

function normalizeTerminal(
  input: AutoCycleTerminalResultInputV1,
  request: AutoCycleRequestV1,
  assessment: AutoAssessmentV1,
  decision: WorkflowDecisionV1,
  evidence: AutoCycleTerminalEvidenceV1,
  workflows: AutoCycleWorkflowAccess,
): AutoCycleTerminalResultInputV1 {
  assertInert(evidence);
  const root = object(input);
  exact(root, [
    "cycleId",
    "requestSha256",
    "assessmentSha256",
    "decisionSha256",
    "decisionDisposition",
    "authorizationSha256",
    "workflowExecutionStatus",
    "runRecordSha256",
    "runEvidenceSha256",
    "finalCheckpointSha256",
    "validation",
    "completedAt",
  ]);
  const disposition = enumeration(root.decisionDisposition, AUTO_CYCLE_DECISION_DISPOSITIONS);
  if (
    identifier(root.cycleId) !== request.cycleId ||
    hash(root.requestSha256) !== request.requestSha256 ||
    hash(root.assessmentSha256) !== assessment.assessmentSha256 ||
    hash(root.decisionSha256) !== decision.decisionSha256 ||
    disposition !== decision.disposition
  ) {
    fail("decision-conflict");
  }
  const executionStatus = enumeration(root.workflowExecutionStatus, [
    "not-run",
    "succeeded",
    "failed",
    "needs-input",
    "needs-human-decision",
  ] as const);
  const authorizationSha256 =
    root.authorizationSha256 === null ? null : hash(root.authorizationSha256);
  const runRecordSha256 = root.runRecordSha256 === null ? null : hash(root.runRecordSha256);
  const runEvidenceSha256 = root.runEvidenceSha256 === null ? null : hash(root.runEvidenceSha256);
  const validation = array(root.validation).map(validationResult).sort(idCompare);
  unique(validation.map((item) => item.id));
  const checkpoints = validateAutoCycleCheckpointChain(evidence.checkpoints);
  const finalCheckpoint = checkpoints.at(-1)!;
  const finalCheckpointSha256 = hash(root.finalCheckpointSha256);
  if (
    finalCheckpointSha256 !== finalCheckpoint.checkpointSha256 ||
    finalCheckpoint.cycleId !== request.cycleId ||
    finalCheckpoint.requestSha256 !== request.requestSha256 ||
    finalCheckpoint.assessmentSha256 !== assessment.assessmentSha256 ||
    finalCheckpoint.decisionSha256 !== decision.decisionSha256
  )
    fail("decision-conflict");
  if (disposition === "execute") {
    if (
      !authorizationSha256 ||
      executionStatus === "not-run" ||
      !runRecordSha256 ||
      !runEvidenceSha256 ||
      !evidence.authorization ||
      !evidence.run
    ) {
      fail("decision-conflict");
    }
    const candidate = assessment.candidates.find(
      (item) => item.candidateSha256 === decision.candidateSha256,
    )!;
    const authorization = decodeAutoCycleAuthorization(evidence.authorization, workflows);
    if (
      authorization.authorizationSha256 !== authorizationSha256 ||
      authorization.requestSha256 !== request.requestSha256 ||
      authorization.assessmentSha256 !== assessment.assessmentSha256 ||
      authorization.decisionSha256 !== decision.decisionSha256 ||
      authorization.candidateSha256 !== candidate.candidateSha256 ||
      authorizationCeilingFromArtifact(authorization) !==
        authorizationCeiling(request, assessment, decision as ExecuteWorkflowDecisionV1) ||
      finalCheckpoint.authorizationSha256 !== authorizationSha256 ||
      finalCheckpoint.phase !== "executing" ||
      finalCheckpoint.workflowExecutionStatus !== executionStatus
    )
      fail("authorization-required");
    const run = runEvidence(evidence.run, workflows);
    const expectedRunEvidenceSha256 = canonicalDigest(run);
    if (
      runEvidenceSha256 !== expectedRunEvidenceSha256 ||
      run.recordSha256 !== runRecordSha256 ||
      run.workflow !== candidate.workflow ||
      canonicalJson(run.repository) !== canonicalJson(request.repository) ||
      run.taskSha256 !== candidate.taskSha256 ||
      run.status !== executionStatus
    ) {
      fail("decision-conflict");
    }
    if (canonicalJson(validation.map((item) => item.id)) !== canonicalJson(candidate.validationIds))
      fail("scope-expansion");
    if (executionStatus === "succeeded" && validation.some((item) => item.status !== "passed"))
      fail("decision-conflict");
  } else if (
    authorizationSha256 ||
    executionStatus !== "not-run" ||
    runRecordSha256 ||
    runEvidenceSha256 ||
    evidence.authorization ||
    evidence.run ||
    finalCheckpoint.authorizationSha256 !== null ||
    finalCheckpoint.workflowExecutionStatus !== null ||
    finalCheckpoint.phase !== "decided" ||
    validation.length !== 0
  )
    fail("decision-conflict");
  return {
    cycleId: request.cycleId,
    requestSha256: request.requestSha256,
    assessmentSha256: assessment.assessmentSha256,
    decisionSha256: decision.decisionSha256,
    decisionDisposition: disposition,
    authorizationSha256,
    workflowExecutionStatus: executionStatus,
    runRecordSha256,
    runEvidenceSha256,
    finalCheckpointSha256,
    validation,
    completedAt: timestamp(root.completedAt),
  };
}

function authorizationCeiling(
  request: AutoCycleRequestV1,
  assessment: AutoAssessmentV1,
  decision: ExecuteWorkflowDecisionV1,
): string {
  const candidate = assessment.candidates.find(
    (item) => item.candidateSha256 === decision.candidateSha256,
  );
  if (!candidate) fail("decision-conflict");
  return canonicalDigest({
    requestSha256: request.requestSha256,
    assessmentSha256: assessment.assessmentSha256,
    decisionSha256: decision.decisionSha256,
    repository: request.repository,
    trackerObservationSha256: request.tracker.observationSha256,
    workflow: candidate.workflow,
    candidateSha256: candidate.candidateSha256,
    pathClass: candidate.pathClass,
    pathPrefixes: candidate.pathPrefixes,
    targetBranch: request.bounds.targetBranch,
    deliveryMode: candidate.deliveryMode,
    validationIds: candidate.validationIds,
  });
}

function authorizationCeilingFromArtifact(value: AutoCycleAuthorizationV1): string {
  const {
    authorizedAt: _authorizedAt,
    expiresAt: _expiresAt,
    authorizationSha256: _authorizationSha256,
    schemaVersion: _schemaVersion,
    kind: _kind,
    ...ceiling
  } = value;
  return canonicalDigest(ceiling);
}

function createAuthorityChallenge(
  request: AutoCycleRequestV1,
  assessment: AutoAssessmentV1,
  decision: ExecuteWorkflowDecisionV1,
  ceilingSha256: string,
): AutoCycleAuthorityChallengeV1 {
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-auto-cycle-authority-challenge" as const,
    requestSha256: request.requestSha256,
    repository: request.repository,
    tracker: request.tracker,
    maturityFindingSha256s: request.maturityFindingSha256s,
    assessmentSha256: assessment.assessmentSha256,
    decisionSha256: decision.decisionSha256,
    ceilingSha256,
  };
  return deepFreeze({ ...body, challengeSha256: canonicalDigest(body) });
}

async function verifyHostCurrent(
  verifier: InternalAutoCycleHostVerifier,
  challenge: AutoCycleAuthorityChallengeV1,
): Promise<string> {
  let result: Awaited<ReturnType<InternalAutoCycleHostVerifier["verifyCurrent"]>>;
  try {
    result = await verifier.verifyCurrent(challenge);
  } catch {
    fail("authorization-required");
  }
  const root = object(result);
  exact(root, ["status", "challengeSha256", "observedAt"]);
  if (root.status !== "current" || hash(root.challengeSha256) !== challenge.challengeSha256) {
    fail("authorization-required");
  }
  return timestamp(root.observedAt);
}

function phaseRank(value: AutoCyclePhase): number {
  return ["assessing", "decided", "authorized", "executing"].indexOf(value);
}

function monotonicNullableDigest(previous: string | null, current: string | null): boolean {
  return previous === null || previous === current;
}

function monotonicExecutionStatus(previous: RunStatus | null, current: RunStatus | null): boolean {
  if (previous === null) return true;
  if (current === null) return false;
  if (previous === current) return true;
  if (previous === "queued")
    return ["running", "needs-input", "needs-human-decision", "failed"].includes(current);
  if (previous === "running")
    return ["needs-input", "needs-human-decision", "succeeded", "failed"].includes(current);
  return false;
}
