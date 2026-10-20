// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Harness-neutral producer for `docsfab auto --once`: at most one bounded
 * documentation workflow under one affirmative operator confirmation.
 *
 * The confirmation binds repository, revision, target branch, observe-only
 * tracker cap, documentation-only paths, the selected workflow, its validation,
 * and one draft-MR delivery. Task lineage is minted here so the run carries
 * operator-directed origin evidence.
 */

import type { RunRequest } from "../execution/contracts.js";
import type { RunRecord } from "../records/contracts.js";
import { canonicalDigest } from "../content-ir/canonical.js";
import {
  formatLimitRefusal,
  limit,
  refuseLimit,
  type ResolveLimitsOptions,
} from "../config/limits.js";
import * as workflowCatalog from "../workflow-registry/catalog.js";
import {
  createBoundedInstructionRequestIdentity,
  createTaskLineageArtifacts,
  createWorkflowLineageCandidate,
  evaluateRunPublicationLineageEligibility,
  mintTaskLineageHostCapability,
  type DecisionAttributionInputV1,
  type DecisionLineageInputV1,
  type OperatorTaskApprovalV1,
  type RunPublicationLineageEligibilityV1,
  type TaskLineageArtifactsV1,
  type TaskLineageRepositoryBindingV1,
  type TaskOriginInputV1,
} from "../lineage/index.js";
import { internalCreateTaskLineageHostAuthority } from "../lineage/authority-internal.js";
import { internalCreateAutoCycleHostAuthority } from "./authority-internal.js";
import {
  assertAutoCycleAuthorized,
  createAutoCycleAuthorization,
  createAutoCycleCheckpoint,
  createAutoCycleTerminalResult,
  mintAutoCycleHostCapability,
  projectAutoCycleAuthorization,
  type AutoAssessmentV1,
  type AutoCycleAuthorizationProjectionV1,
  type AutoCycleAuthorizationV1,
  type AutoCycleCheckpointV1,
  type AutoCycleHostCapability,
  type AutoCycleRequestV1,
  type AutoCycleTerminalEvidenceV1,
  type AutoCycleTerminalResultV1,
  type AutoValidationResultV1,
  type AutoWorkflowExecutionStatus,
  type ExecuteWorkflowDecisionV1,
  type WorkflowCandidateV1,
  type WorkflowDecisionV1,
} from "./contracts.js";

export const AUTO_CYCLE_ONCE_SCHEMA_VERSION = 1 as const;

function authorizationWindowLimit(options: ResolveLimitsOptions = {}) {
  return limit("autonomy.authorizationWindowMs", options);
}

function authorizationWindowDefaultLimit(options: ResolveLimitsOptions = {}) {
  return limit("autonomy.authorizationWindowDefaultMs", options);
}

authorizationWindowLimit();
authorizationWindowDefaultLimit();

/** Its digest is the operator approval that anchors the minted task lineage. */
export interface AutoCycleOnceConfirmationV1 {
  authorityId: string;
  operatorIdentitySha256: string;
  affirmed: true;
  windowMs?: number;
}

export type AutoCycleOnceDisposition =
  | "executed-succeeded"
  | "executed-failed"
  | "executed-needs-input"
  | "executed-needs-human-decision"
  | "no-action"
  | "needs-input"
  | "blocked"
  | "superseded";

export interface AutoCycleOnceAuthorizationWindowV1 {
  readonly requestedMs: number;
  readonly effectiveMs: number;
  readonly source: "confirmation" | "default";
}

/** Resumable cycle record persisted by the host. */
export interface AutoCycleOnceRecordV1 {
  schemaVersion: 1;
  kind: "docsfab-auto-cycle-once-record";
  cycleId: string;
  requestSha256: string;
  disposition: AutoCycleOnceDisposition;
  checkpoints: AutoCycleCheckpointV1[];
  terminalResult: AutoCycleTerminalResultV1;
  authorizationProjection: AutoCycleAuthorizationProjectionV1 | null;
  authorizationWindow: AutoCycleOnceAuthorizationWindowV1 | null;
  runRecordId: string | null;
  publicationEligibility: RunPublicationLineageEligibilityV1 | null;
}

export interface AutoCycleOnceExecuteInputV1 {
  workflow: WorkflowCandidateV1["workflow"];
  allowWrite: boolean;
  task: RunRequest["task"] | null;
  taskLineage: TaskLineageArtifactsV1;
}

export interface AutoCycleOnceHost {
  now(): Date;
  confirmation: AutoCycleOnceConfirmationV1;
  mintCycle(input: {
    request: AutoCycleRequestV1;
    assessment: AutoAssessmentV1;
    decision: WorkflowDecisionV1;
  }): Promise<{ capability: AutoCycleHostCapability; observedAt: string }>;
  mintLineage(input: {
    origin: TaskOriginInputV1;
    lineage: Omit<DecisionLineageInputV1, "originSha256">;
  }): Promise<TaskLineageArtifactsV1>;
  execute(input: AutoCycleOnceExecuteInputV1): Promise<RunRecord>;
  validate(record: RunRecord, validationIds: readonly string[]): Promise<AutoValidationResultV1[]>;
  save(record: AutoCycleOnceRecordV1): Promise<void>;
  log?(message: string): void;
}

export type AutoCycleOnceErrorCode =
  | "unaffirmed-confirmation"
  | "decision-missing-candidate"
  | "run-not-terminal"
  | "invalid-authorization-window";

export class AutoCycleOnceError extends Error {
  public constructor(public readonly code: AutoCycleOnceErrorCode) {
    super(`One-cycle authorized execution rejected the request for reason: ${code}.`);
    this.name = "AutoCycleOnceError";
  }
}

function fail(code: AutoCycleOnceErrorCode): never {
  throw new AutoCycleOnceError(code);
}

export interface AutoCycleOnceOutcomeV1 {
  record: AutoCycleOnceRecordV1;
  runRecord: RunRecord | null;
}

/**
 * A non-execute decision performs no write and persists an assessment-only
 * disposition; an execute decision passes the write gate before one workflow runs.
 */
export async function runAutoCycleOnce(
  input: {
    request: AutoCycleRequestV1;
    assessment: AutoAssessmentV1;
    decision: WorkflowDecisionV1;
    repository: TaskLineageRepositoryBindingV1;
  },
  host: AutoCycleOnceHost,
  options: ResolveLimitsOptions = {},
): Promise<AutoCycleOnceOutcomeV1> {
  const { request, assessment, decision } = input;
  if (host.confirmation.affirmed !== true) {
    fail("unaffirmed-confirmation");
  }

  const assessingCheckpoint = createAutoCycleCheckpoint({
    cycleId: request.cycleId,
    sequence: 0,
    phase: "assessing",
    requestSha256: request.requestSha256,
    assessmentSha256: null,
    decisionSha256: null,
    authorizationSha256: null,
    workflowExecutionStatus: null,
    previousCheckpointSha256: null,
  });
  const decidedCheckpoint = createAutoCycleCheckpoint({
    cycleId: request.cycleId,
    sequence: 1,
    phase: "decided",
    requestSha256: request.requestSha256,
    assessmentSha256: assessment.assessmentSha256,
    decisionSha256: decision.decisionSha256,
    authorizationSha256: null,
    workflowExecutionStatus: null,
    previousCheckpointSha256: assessingCheckpoint.checkpointSha256,
  });

  if (decision.disposition !== "execute") {
    return finalizeNonExecute(input, host, [assessingCheckpoint, decidedCheckpoint]);
  }

  return executeCycle(
    { ...input, decision },
    host,
    [assessingCheckpoint, decidedCheckpoint],
    options,
  );
}

async function finalizeNonExecute(
  input: {
    request: AutoCycleRequestV1;
    assessment: AutoAssessmentV1;
    decision: WorkflowDecisionV1;
  },
  host: AutoCycleOnceHost,
  checkpoints: [AutoCycleCheckpointV1, AutoCycleCheckpointV1],
): Promise<AutoCycleOnceOutcomeV1> {
  const { request, assessment, decision } = input;
  const finalCheckpoint = checkpoints[1];
  const evidence: AutoCycleTerminalEvidenceV1 = {
    authorization: null,
    checkpoints,
    run: null,
  };
  const terminalResult = createAutoCycleTerminalResult(
    {
      cycleId: request.cycleId,
      requestSha256: request.requestSha256,
      assessmentSha256: assessment.assessmentSha256,
      decisionSha256: decision.decisionSha256,
      decisionDisposition: decision.disposition,
      authorizationSha256: null,
      workflowExecutionStatus: "not-run",
      runRecordSha256: null,
      runEvidenceSha256: null,
      finalCheckpointSha256: finalCheckpoint.checkpointSha256,
      validation: [],
      completedAt: host.now().toISOString(),
    },
    request,
    assessment,
    decision,
    evidence,
    workflowCatalog,
  );
  const record: AutoCycleOnceRecordV1 = {
    schemaVersion: AUTO_CYCLE_ONCE_SCHEMA_VERSION,
    kind: "docsfab-auto-cycle-once-record",
    cycleId: request.cycleId,
    requestSha256: request.requestSha256,
    disposition: decision.disposition as AutoCycleOnceDisposition,
    checkpoints: [...checkpoints],
    terminalResult,
    authorizationProjection: null,
    authorizationWindow: null,
    runRecordId: null,
    publicationEligibility: null,
  };
  await host.save(record);
  host.log?.(`auto once: ${decision.disposition}; no write performed.`);
  return { record, runRecord: null };
}

async function executeCycle(
  input: {
    request: AutoCycleRequestV1;
    assessment: AutoAssessmentV1;
    decision: ExecuteWorkflowDecisionV1;
    repository: TaskLineageRepositoryBindingV1;
  },
  host: AutoCycleOnceHost,
  base: [AutoCycleCheckpointV1, AutoCycleCheckpointV1],
  options: ResolveLimitsOptions = {},
): Promise<AutoCycleOnceOutcomeV1> {
  const { request, assessment, decision, repository } = input;
  const candidate = assessment.candidates.find(
    (item) => item.candidateSha256 === decision.candidateSha256,
  );
  if (!candidate) fail("decision-missing-candidate");

  const { capability, observedAt } = await host.mintCycle({
    request,
    assessment,
    decision,
  });
  const window = resolveAuthorizationWindow(host.confirmation.windowMs, host, options);
  const expiresAt = new Date(Date.parse(observedAt) + window.effectiveMs).toISOString();
  const authorization = createAutoCycleAuthorization(
    { authorizedAt: observedAt, expiresAt },
    capability,
  );

  const task = null;
  const lineageInputs = buildOperatorDirectedLineage({
    candidate,
    request,
    decision,
    authorization,
    repository,
    confirmation: host.confirmation,
  });
  const artifacts = await host.mintLineage(lineageInputs);

  const authorizedCheckpoint = createAutoCycleCheckpoint({
    cycleId: request.cycleId,
    sequence: 2,
    phase: "authorized",
    requestSha256: request.requestSha256,
    assessmentSha256: assessment.assessmentSha256,
    decisionSha256: decision.decisionSha256,
    authorizationSha256: authorization.authorizationSha256,
    workflowExecutionStatus: null,
    previousCheckpointSha256: base[1].checkpointSha256,
  });

  // Rejects stale repository or tracker evidence, path expansion, and workflow
  // substitution before any write.
  await assertAutoCycleAuthorized(authorization, capability, task, workflowCatalog);

  const runRecord = await host.execute({
    workflow: candidate.workflow,
    allowWrite: candidate.pathClass === "documentation-write",
    task,
    taskLineage: artifacts,
  });

  const executionStatus = runExecutionStatus(runRecord.status);
  const validation = await host.validate(runRecord, candidate.validationIds);
  const runRecordSha256 = canonicalDigest(runRecord);
  const run = {
    id: runRecord.id,
    recordSha256: runRecordSha256,
    workflow: candidate.workflow,
    repository: request.repository,
    taskSha256: candidate.taskSha256,
    status: executionStatus,
  };
  const runEvidenceSha256 = canonicalDigest(run);

  const executingCheckpoint = createAutoCycleCheckpoint({
    cycleId: request.cycleId,
    sequence: 3,
    phase: "executing",
    requestSha256: request.requestSha256,
    assessmentSha256: assessment.assessmentSha256,
    decisionSha256: decision.decisionSha256,
    authorizationSha256: authorization.authorizationSha256,
    workflowExecutionStatus: executionStatus,
    previousCheckpointSha256: authorizedCheckpoint.checkpointSha256,
  });
  const checkpoints: AutoCycleCheckpointV1[] = [...base, authorizedCheckpoint, executingCheckpoint];
  const evidence: AutoCycleTerminalEvidenceV1 = {
    authorization,
    checkpoints,
    run,
  };
  const terminalResult = createAutoCycleTerminalResult(
    {
      cycleId: request.cycleId,
      requestSha256: request.requestSha256,
      assessmentSha256: assessment.assessmentSha256,
      decisionSha256: decision.decisionSha256,
      decisionDisposition: "execute",
      authorizationSha256: authorization.authorizationSha256,
      workflowExecutionStatus: executionStatus,
      runRecordSha256,
      runEvidenceSha256,
      finalCheckpointSha256: executingCheckpoint.checkpointSha256,
      validation,
      completedAt: host.now().toISOString(),
    },
    request,
    assessment,
    decision,
    evidence,
    workflowCatalog,
  );

  const publicationEligibility = evaluateRunPublicationLineageEligibility(runRecord);
  const record: AutoCycleOnceRecordV1 = {
    schemaVersion: AUTO_CYCLE_ONCE_SCHEMA_VERSION,
    kind: "docsfab-auto-cycle-once-record",
    cycleId: request.cycleId,
    requestSha256: request.requestSha256,
    disposition: executeDisposition(executionStatus),
    checkpoints,
    terminalResult,
    authorizationProjection: projectAutoCycleAuthorization(authorization, workflowCatalog),
    authorizationWindow: window,
    runRecordId: runRecord.id,
    publicationEligibility,
  };
  await host.save(record);
  host.log?.(
    `auto once: ${record.disposition}; run ${runRecord.id}; ` +
      `publication ${publicationEligibility.eligible ? "eligible" : "ineligible"}; ` +
      `authorization window requested ${window.requestedMs} ms, effective ${window.effectiveMs} ms ` +
      `(${window.source}).`,
  );
  return { record, runRecord };
}

function resolveAuthorizationWindow(
  windowMs: number | undefined,
  host: AutoCycleOnceHost,
  options: ResolveLimitsOptions = {},
): AutoCycleOnceAuthorizationWindowV1 {
  const ceiling = authorizationWindowLimit(options);
  const fallback = authorizationWindowDefaultLimit(options);
  if (windowMs === undefined) {
    const effectiveMs = fallback.value;
    return { requestedMs: effectiveMs, effectiveMs, source: "default" };
  }
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
    fail("invalid-authorization-window");
  }
  if (windowMs > ceiling.value) {
    host.log?.(
      `auto once: Recover. requested authorization window ${windowMs} ms, ` +
        `effective ceiling ${ceiling.value} ms. ${formatLimitRefusal(ceiling, windowMs)}`,
    );
    refuseLimit(ceiling, windowMs);
  }
  return { requestedMs: windowMs, effectiveMs: windowMs, source: "confirmation" };
}

function runExecutionStatus(
  status: RunRecord["status"],
): Exclude<AutoWorkflowExecutionStatus, "not-run"> {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "needs-input":
      return "needs-input";
    case "needs-human-decision":
      return "needs-human-decision";
    default:
      fail("run-not-terminal");
  }
}

function executeDisposition(
  status: Exclude<AutoWorkflowExecutionStatus, "not-run">,
): AutoCycleOnceDisposition {
  switch (status) {
    case "succeeded":
      return "executed-succeeded";
    case "failed":
      return "executed-failed";
    case "needs-input":
      return "executed-needs-input";
    case "needs-human-decision":
      return "executed-needs-human-decision";
  }
}

/**
 * The confirmation owns the task decision, host policy owns every scope ceiling,
 * and the workflow contract owns the workflow choice. No field comes from prose.
 */
function buildOperatorDirectedLineage(input: {
  candidate: WorkflowCandidateV1;
  request: AutoCycleRequestV1;
  decision: ExecuteWorkflowDecisionV1;
  authorization: AutoCycleAuthorizationV1;
  repository: TaskLineageRepositoryBindingV1;
  confirmation: AutoCycleOnceConfirmationV1;
}): {
  origin: TaskOriginInputV1;
  lineage: Omit<DecisionLineageInputV1, "originSha256">;
} {
  const { candidate, request, decision, authorization, repository, confirmation } = input;
  const lineageId = `auto-once:${request.cycleId}`;
  const instruction =
    `Execute one bounded ${candidate.workflow} documentation cycle on ` +
    `revision ${repository.revision} under one affirmative operator confirmation.`;
  const requestIdentity = createBoundedInstructionRequestIdentity(
    instruction,
    null,
    candidate.workflow,
    repository,
  );
  const approvalSha256 = canonicalDigest({
    kind: "docsfab-auto-cycle-operator-confirmation",
    cycleId: request.cycleId,
    requestSha256: request.requestSha256,
    decisionSha256: decision.decisionSha256,
    authorizationSha256: authorization.authorizationSha256,
    authorityId: confirmation.authorityId,
    operatorIdentitySha256: confirmation.operatorIdentitySha256,
    affirmed: true,
  });
  const approval: OperatorTaskApprovalV1 = {
    authorityId: confirmation.authorityId,
    operatorIdentitySha256: confirmation.operatorIdentitySha256,
    approvalSha256,
    approvedRequestSha256: requestIdentity.requestSha256,
    approvedTaskSha256: requestIdentity.taskSha256,
    approvedRecommendationSha256: null,
  };
  const origin: TaskOriginInputV1 = {
    lineageId,
    repository,
    origin: "operator-directed",
    selectedBy: "operator",
    request: requestIdentity,
    approval,
    recommendation: null,
    autonomousSelection: null,
  };

  const prerequisiteEvidenceSha256 = candidate.candidateSha256;
  const lineageCandidate = createWorkflowLineageCandidate({
    id: `auto-once-candidate:${candidate.workflow}`,
    workflow: candidate.workflow,
    taskSha256: requestIdentity.taskSha256,
    prerequisiteIds: ["auto-cycle-authorization"],
    prerequisiteEvidenceSha256s: [prerequisiteEvidenceSha256],
    eligibility: "eligible",
    reasonCode: "auto-cycle-authorized",
  });

  const hostDigest = (label: string): string =>
    canonicalDigest({
      kind: "docsfab-auto-cycle-host-policy-ceiling",
      label,
      authorizationSha256: authorization.authorizationSha256,
    });

  const taskDecision: DecisionAttributionInputV1 = {
    id: "decision:task",
    domain: "task",
    actor: "operator",
    effect: "authoritative",
    outcomeSha256: requestIdentity.taskSha256,
    authoritySource: "operator-approval",
    authoritySha256: approvalSha256,
    evidenceSha256s: [requestIdentity.requestSha256],
    boundedByDecisionIds: [],
    reasonCode: "operator-directed",
  };
  const repositoryDecision: DecisionAttributionInputV1 = {
    id: "decision:repository",
    domain: "repository",
    actor: "host-policy",
    effect: "authoritative",
    outcomeSha256: repository.identitySha256,
    authoritySource: "host-policy",
    authoritySha256: hostDigest("repository"),
    evidenceSha256s: [request.tracker.observationSha256],
    boundedByDecisionIds: [],
    reasonCode: "workspace-ceiling",
  };
  const workflowDecision: DecisionAttributionInputV1 = {
    id: "decision:workflow",
    domain: "workflow",
    actor: "deterministic-workflow",
    effect: "authoritative",
    outcomeSha256: lineageCandidate.candidateSha256,
    authoritySource: "workflow-contract",
    authoritySha256: decision.decisionSha256,
    evidenceSha256s: [prerequisiteEvidenceSha256],
    boundedByDecisionIds: [],
    reasonCode: "eligible-candidate-selected",
  };

  const hostPolicyDecision = (
    id: string,
    domain: DecisionAttributionInputV1["domain"],
    reasonCode: string,
  ): DecisionAttributionInputV1 => ({
    id,
    domain,
    actor: "host-policy",
    effect: "authoritative",
    outcomeSha256: hostDigest(`${domain}:outcome`),
    authoritySource: "host-policy",
    authoritySha256: hostDigest(`${domain}:authority`),
    evidenceSha256s: [authorization.authorizationSha256],
    boundedByDecisionIds: [],
    reasonCode,
  });

  const lineage: Omit<DecisionLineageInputV1, "originSha256"> = {
    lineageId,
    candidates: [
      {
        id: lineageCandidate.id,
        workflow: lineageCandidate.workflow,
        taskSha256: lineageCandidate.taskSha256,
        prerequisiteIds: lineageCandidate.prerequisiteIds,
        prerequisiteEvidenceSha256s: lineageCandidate.prerequisiteEvidenceSha256s,
        eligibility: lineageCandidate.eligibility,
        reasonCode: lineageCandidate.reasonCode,
      },
    ],
    selectedCandidateSha256: lineageCandidate.candidateSha256,
    selectedSourceAutoCandidateSha256: null,
    rejectedAlternatives: [],
    decisions: [
      taskDecision,
      repositoryDecision,
      workflowDecision,
      hostPolicyDecision("decision:scope", "scope", "workflow-scope-ceiling"),
      hostPolicyDecision("decision:path", "path", "documentation-path-ceiling"),
      hostPolicyDecision("decision:write", "write", "single-write-ceiling"),
      hostPolicyDecision("decision:validation", "validation", "required-validation-ceiling"),
      hostPolicyDecision("decision:tracker", "tracker", "tracker-observe-only-ceiling"),
      hostPolicyDecision("decision:publication", "publication", "single-draft-mr-ceiling"),
    ],
  };
  return { origin, lineage };
}

/**
 * The verifier's wall-clock instant becomes `authorizedAt`. A replayed
 * observation that no longer matches the challenge digest is rejected.
 */
export function createHostAuthorityCycleMint(now: () => Date): AutoCycleOnceHost["mintCycle"] {
  return async (input) => {
    let observedAt = "";
    const authority = internalCreateAutoCycleHostAuthority({
      async verifyCurrent(challenge) {
        observedAt = now().toISOString();
        return {
          status: "current" as const,
          challengeSha256: challenge.challengeSha256,
          observedAt,
        };
      },
    });
    const capability = await mintAutoCycleHostCapability(input, authority, workflowCatalog);
    return { capability, observedAt };
  };
}

export function createHostAuthorityLineageMint(now: () => Date): AutoCycleOnceHost["mintLineage"] {
  return async (input) => {
    const authority = internalCreateTaskLineageHostAuthority({
      async verifyCurrent(challenge) {
        return {
          status: "current" as const,
          challengeSha256: challenge.challengeSha256,
          observedAt: now().toISOString(),
          authorityReceiptSha256: canonicalDigest({
            kind: "docsfab-auto-once-lineage-receipt",
            challengeSha256: challenge.challengeSha256,
          }),
        };
      },
    });
    const capability = await mintTaskLineageHostCapability(input as never, authority);
    return createTaskLineageArtifacts(capability);
  };
}
