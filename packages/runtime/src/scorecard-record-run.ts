// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  decodeModelEvidence,
  decodeTools,
  decodeUsage,
  ScorecardRecordError,
} from "./execution/inference-evidence.js";
import { decodeWorkUnitMachineContract } from "./maturity/work-unit-machine-contract.js";
import {
  readFailureClassification,
  type FailureClassificationV1,
} from "./operator/failure-class.js";
import type {
  ModelEvidence,
  RunRecord,
  SkillEvidence,
  TokenUsage,
  ToolActivitySummary,
} from "./records/contracts.js";
import { decodeCheckoutPersistenceOutcome } from "./records/checkout-persistence.js";
import { validateReleaseDocumentationReadinessArtifact } from "./release-documentation-readiness.js";
import type { ReleaseDocumentationExpectedRepositoryV1 } from "./release-documentation-rubric.js";
import type { RepositoryDiscoveryInventoryV1 } from "./repository/inventory.js";
import type {
  SecurityScanAuthorizationEvidence,
  SecurityScanReport,
} from "./security/contracts.js";
import {
  createDocumentationGapLedger,
  decodeDocumentationGapLedger,
  decodeDocumentationSearchFinding,
  documentationGapLedgerFromStepFindings,
  negativeDocumentationEvidence,
  projectDocumentationSearchFindings,
} from "./search/gap-ledger.js";
import {
  REVISION,
  array,
  canonical,
  exact,
  identifier,
  nonnegativeInteger,
  object,
  oneOf,
  optionalNonnegativeInteger,
  optionalText,
  optionalTimestamp,
  pattern,
  requireCondition,
  requireEqual,
  safeSum,
  safeText,
  timestamp,
  uniqueArray,
} from "./scorecard-record-parse.js";
import {
  decodeContextPreflight,
  decodeInference,
  decodeQualityPackEvidence,
  decodeSearchParticipation,
  decodeSecurityAuthorization,
  decodeSecurityDisposition,
  decodeSecurityScan,
  decodeSkillEvidence,
} from "./scorecard-record-decode.js";
import { getWorkflow } from "./workflow-registry/catalog.js";
import {
  RunRecordCompositionError,
  verifyRunRecordComposition,
} from "./records/composition-execution.js";
import { defineRunRecordReader, isReadOnlyRunChanges } from "./records/run-record-readers.js";
import { authorizeSecurityScan } from "./security/scan-override.js";
import { resolveSecurityScanEffectiveDisposition } from "./security/scan-disposition.js";
import { decodeWorkflowOutcome } from "./workflow-contracts/outcome.js";
import { decodeWorkflowSearchEvidence } from "./workflow-contracts/search.js";
import { decodeRunRecordRequestIntent } from "./request-intent/interpret-record.js";

const SECURITY_SCAN_POLICY = {
  authorizeSecurityScan,
  resolveSecurityScanEffectiveDisposition,
} as const;

export function parseScorecardRunRecord(value: unknown): RunRecord {
  try {
    return decodeRunRecord(value);
  } catch (error) {
    if (error instanceof ScorecardRecordError) throw error;
    throw scorecardRefusal(error);
  }
}

const UNVERIFIED = "unverified" as const;

/** Field policy of the release-documentation readiness scorecard reader. */
export const RELEASE_READINESS_RUN_READER = defineRunRecordReader({
  reader: "release-documentation-readiness-scorecard",
  workflows: ["release-documentation-readiness"],
  statuses: ["succeeded"],
  fields: {
    schemaVersion: "decoded",
    id: "admitted",
    workflow: "decoded",
    repository: "admitted",
    workspace: "admitted",
    instruction: "admitted",
    retryContext: UNVERIFIED,
    operatorTargetPaths: "admitted",
    instructionContext: UNVERIFIED,
    // Only create and update records bind sources; this reader reads neither.
    retainedEvidenceBindings: UNVERIFIED,
    readerEvidenceRequest: UNVERIFIED,
    // Only create and update records bind a change; this reader reads neither.
    changeSources: UNVERIFIED,
    reviewDeliverySnapshot: "producer-not-admitted",
    changeSourceRelease: UNVERIFIED,
    task: "admitted",
    taskLineage: UNVERIFIED,
    compositionExecution: "decoded",
    answerRecordDiscovery: UNVERIFIED,
    compositionExecutionAggregate: "decoded",
    modelSettings: "admitted",
    knowledgeResumeReceipt: UNVERIFIED,
    knowledgeContinuationReceipt: UNVERIFIED,
    knowledgeContinuationRecoveryAuthorization: UNVERIFIED,
    knowledgeContinuationSnapshotSha256: UNVERIFIED,
    knowledgeContinuationAcceptanceSha256: UNVERIFIED,
    status: "decoded",
    checkoutPersistence: "decoded",
    workflowOutcome: "decoded",
    workflowBranchCoverage: UNVERIFIED,
    authoringExecution: UNVERIFIED,
    releaseDocumentationReadiness: "decoded",
    workUnitMachineContracts: "decoded",
    error: "admitted",
    failure: "failed-run-only",
    workflowOutcomeRejection: "failed-run-only",
    authoringCandidateRejection: "failed-run-only",
    editorialFinalizationRejection: "failed-run-only",
    createdAt: "admitted",
    startedAt: "admitted",
    completedAt: "admitted",
    durationMs: "admitted",
    models: "admitted",
    skills: "admitted",
    qualityPack: "admitted",
    qualityProfileSelection: "producer-not-admitted",
    qualityArtifactValidation: "producer-not-admitted",
    usage: "admitted",
    tools: "admitted",
    artifacts: "admitted",
    searchFindings: "admitted",
    negativeEvidence: "admitted",
    gapLedger: "admitted",
    securityScan: "admitted",
    securityScanEffectiveDisposition: "admitted",
    securityScanAuthorization: "admitted",
    changes: "admitted",
    impactPostflight: "admitted",
    reviewScope: "producer-not-admitted",
    requestIntent: "decoded",
    // Written only on a needs-input run, which this reader never admits.
    firstPassContradiction: UNVERIFIED,
    firstPassContradictionAdmission: UNVERIFIED,
    firstPassReplay: UNVERIFIED,
    firstPassChoices: UNVERIFIED,
    liveAgentTurn: "producer-not-admitted",
    liveAgentTurnFailure: "producer-not-admitted",
    answerRecordContinuation: UNVERIFIED,
    // Optional per-run citation evidence; no readiness writer emits it yet.
    sourceCitations: "admitted",
    // Content-free findings (#1807): locations and rule ids only.
    credentialFindings: "admitted",
    evidenceWarnings: "admitted",
    steps: "admitted",
  },
});

/** Field policy of the source-readiness scorecard reader (`parseScorecardRunRecord`). */
export const READINESS_RUN_READER = defineRunRecordReader({
  reader: "readiness-scorecard",
  workflows: ["readiness"],
  statuses: ["succeeded", "failed"],
  fields: {
    schemaVersion: "decoded",
    id: "decoded",
    workflow: "decoded",
    repository: "decoded",
    workspace: "decoded",
    instruction: "decoded",
    retryContext: UNVERIFIED,
    operatorTargetPaths: "admitted",
    instructionContext: UNVERIFIED,
    // Only create and update records bind sources; this reader reads neither.
    retainedEvidenceBindings: UNVERIFIED,
    readerEvidenceRequest: UNVERIFIED,
    // Only create and update records bind a change; this reader reads neither.
    changeSources: UNVERIFIED,
    reviewDeliverySnapshot: "producer-not-admitted",
    changeSourceRelease: UNVERIFIED,
    task: UNVERIFIED,
    taskLineage: UNVERIFIED,
    compositionExecution: "decoded",
    answerRecordDiscovery: UNVERIFIED,
    compositionExecutionAggregate: "decoded",
    modelSettings: "admitted",
    knowledgeResumeReceipt: UNVERIFIED,
    knowledgeContinuationReceipt: UNVERIFIED,
    knowledgeContinuationRecoveryAuthorization: UNVERIFIED,
    knowledgeContinuationSnapshotSha256: UNVERIFIED,
    knowledgeContinuationAcceptanceSha256: UNVERIFIED,
    answerRecordContinuation: UNVERIFIED,
    status: "decoded",
    checkoutPersistence: "decoded",
    workflowOutcome: "decoded",
    workflowBranchCoverage: UNVERIFIED,
    authoringExecution: UNVERIFIED,
    releaseDocumentationReadiness: "producer-not-admitted",
    workUnitMachineContracts: "producer-not-admitted",
    error: "decoded",
    // The failed run's class, validated below.
    failure: "decoded",
    workflowOutcomeRejection: UNVERIFIED,
    authoringCandidateRejection: UNVERIFIED,
    editorialFinalizationRejection: UNVERIFIED,
    createdAt: "decoded",
    startedAt: "decoded",
    completedAt: "decoded",
    durationMs: "decoded",
    models: "decoded",
    skills: "decoded",
    qualityPack: "decoded",
    qualityProfileSelection: "producer-not-admitted",
    qualityArtifactValidation: "producer-not-admitted",
    usage: "decoded",
    tools: "decoded",
    artifacts: UNVERIFIED,
    searchFindings: "decoded",
    negativeEvidence: "decoded",
    gapLedger: "decoded",
    securityScan: "decoded",
    securityScanEffectiveDisposition: "decoded",
    securityScanAuthorization: "decoded",
    // The runner records the changed-file list for every run; a read-only run's is empty.
    changes: "decoded",
    impactPostflight: UNVERIFIED,
    reviewScope: "producer-not-admitted",
    requestIntent: "decoded",
    // Written only on a needs-input run, which this reader never admits.
    firstPassContradiction: UNVERIFIED,
    firstPassContradictionAdmission: UNVERIFIED,
    firstPassReplay: UNVERIFIED,
    firstPassChoices: UNVERIFIED,
    liveAgentTurn: "producer-not-admitted",
    liveAgentTurnFailure: "producer-not-admitted",
    // Optional per-run citation evidence (see above).
    sourceCitations: "admitted",
    // Content-free findings (#1807): locations and rule ids only.
    credentialFindings: "admitted",
    evidenceWarnings: "decoded",
    steps: "decoded",
  },
});

/** Production decoder for the distinct public release-documentation scorecard workflow. */
export function parseReleaseDocumentationReadinessRunRecord(
  value: unknown,
  expectedRepository: Readonly<ReleaseDocumentationExpectedRepositoryV1>,
  trustedInventory: RepositoryDiscoveryInventoryV1,
): RunRecord {
  try {
    const root = object(value);
    exact(root, [...RELEASE_READINESS_RUN_READER.admittedKeys]);
    if (root.checkoutPersistence !== undefined)
      decodeCheckoutPersistenceOutcome(root.checkoutPersistence);
    requireEqual(root.schemaVersion, 2);
    requireEqual(root.workflow, "release-documentation-readiness");
    requireEqual(root.status, "succeeded");
    requireCondition(root.releaseDocumentationReadiness !== undefined);
    requireCondition(root.workflowOutcome !== undefined);
    const record = structuredClone(root) as unknown as RunRecord;
    verifyRunRecordComposition(record, getWorkflow("release-documentation-readiness"));
    if (root.requestIntent !== undefined) {
      record.requestIntent = decodeRunRecordRequestIntent(root.requestIntent, root.instruction);
    }
    record.releaseDocumentationReadiness = validateReleaseDocumentationReadinessArtifact(
      root.releaseDocumentationReadiness,
      record,
      expectedRepository,
      trustedInventory,
    );
    record.workflowOutcome = decodeWorkflowOutcome(
      root.workflowOutcome,
      record,
      SECURITY_SCAN_POLICY,
    );
    if (root.workUnitMachineContracts !== undefined) {
      requireCondition(Array.isArray(root.workUnitMachineContracts));
      record.workUnitMachineContracts = root.workUnitMachineContracts.map((item) =>
        decodeWorkUnitMachineContract(item),
      );
    }
    return record;
  } catch (error) {
    if (error instanceof ScorecardRecordError) throw error;
    throw scorecardRefusal(error);
  }
}

/** Keep a composition binding's named refusal; any other failure is the generic one. */
function scorecardRefusal(error: unknown): ScorecardRecordError {
  return error instanceof RunRecordCompositionError
    ? new ScorecardRecordError("invalid-scorecard-run-record", error.code)
    : new ScorecardRecordError();
}

function decodeRunRecord(value: unknown): RunRecord {
  const root = object(value);
  exact(root, [...READINESS_RUN_READER.admittedKeys]);
  if (root.checkoutPersistence !== undefined)
    decodeCheckoutPersistenceOutcome(root.checkoutPersistence);

  requireEqual(root.schemaVersion, 2);
  const id = identifier(root.id);
  requireEqual(root.workflow, "readiness");
  requireCondition(root.releaseDocumentationReadiness === undefined);
  const repository = decodeRepository(root.repository);
  const workspace = decodeWorkspace(root.workspace);
  const instruction = optionalText(root.instruction, 1_000_000);
  const status = oneOf(root.status, ["succeeded", "failed"] as const);
  const error = optionalText(root.error, 65_536);
  const failure = optionalFailure(root.failure, status);
  const createdAt = timestamp(root.createdAt);
  const startedAt = optionalTimestamp(root.startedAt);
  const completedAt = timestamp(root.completedAt);
  const durationMs = nonnegativeInteger(root.durationMs);
  requireCondition(createdAt <= completedAt);
  if (startedAt !== undefined) {
    requireCondition(createdAt <= startedAt && startedAt <= completedAt);
  }
  requireCondition(Date.parse(completedAt) - Date.parse(startedAt ?? createdAt) === durationMs);

  const models = array(root.models).map(decodeModelEvidence);
  requireCondition(models.length <= 1);
  const skills = array(root.skills).map(decodeSkillEvidence);
  if (root.qualityPack !== undefined) decodeQualityPackEvidence(root.qualityPack);
  requireCondition(skills.length <= 1);
  const usage = decodeUsage(root.usage);
  const tools = decodeTools(root.tools);
  const securityScan =
    root.securityScan === undefined ? undefined : decodeSecurityScan(root.securityScan);
  const securityScanEffectiveDisposition =
    root.securityScanEffectiveDisposition === undefined
      ? undefined
      : decodeSecurityDisposition(root.securityScanEffectiveDisposition);
  const securityScanAuthorization =
    root.securityScanAuthorization === undefined
      ? undefined
      : decodeSecurityAuthorization(root.securityScanAuthorization);
  const evidenceWarnings =
    root.evidenceWarnings === undefined
      ? undefined
      : uniqueArray(root.evidenceWarnings, (item) => safeText(item, 1_024));
  const changes = root.changes === undefined ? undefined : decodeReadOnlyChanges(root.changes);
  const steps = array(root.steps).map((step) => decodeReadinessStep(step, repository));
  requireCondition(steps.length === 1);
  const step = steps[0]!;
  const searchFindings =
    root.searchFindings === undefined
      ? undefined
      : array(root.searchFindings).map(decodeDocumentationSearchFinding);
  const negativeEvidence =
    root.negativeEvidence === undefined
      ? undefined
      : array(root.negativeEvidence).map(decodeDocumentationSearchFinding);
  const gapLedger =
    root.gapLedger === undefined ? undefined : decodeDocumentationGapLedger(root.gapLedger);
  const rebuilt = documentationGapLedgerFromStepFindings({
    currentRevision: repository.revision,
    steps,
  });
  if (!rebuilt) {
    requireCondition(
      searchFindings === undefined && negativeEvidence === undefined && gapLedger === undefined,
    );
  } else {
    requireCondition(
      searchFindings !== undefined && negativeEvidence !== undefined && gapLedger !== undefined,
    );
    requireCondition(canonical(searchFindings) === canonical(rebuilt.searchFindings));
    requireCondition(canonical(negativeEvidence) === canonical(rebuilt.negativeEvidence));
    requireCondition(canonical(gapLedger) === canonical(rebuilt.gapLedger));
  }

  if (status === "succeeded") requireCondition(error === undefined);
  const runStart = startedAt ?? createdAt;
  if (step.startedAt !== undefined) requireCondition(step.startedAt >= runStart);
  if (step.completedAt !== undefined) requireCondition(step.completedAt <= completedAt);

  validateSecurityConsistency(
    securityScan,
    securityScanEffectiveDisposition,
    securityScanAuthorization,
    repository.revision,
  );
  validateTerminalShape(
    status,
    step,
    models,
    usage,
    tools,
    securityScan,
    securityScanEffectiveDisposition,
  );
  validateEvidenceBinding(repository.revision, step);
  validateModelAggregation(models, step);
  validateSkillAggregation(skills, step);
  validateRunArithmetic(usage, tools, step);

  const decoded: RunRecord = {
    schemaVersion: 2,
    id,
    workflow: "readiness",
    repository,
    workspace,
    ...(instruction === undefined ? {} : { instruction }),
    status,
    ...(error === undefined ? {} : { error }),
    ...(failure === undefined ? {} : { failure }),
    createdAt,
    ...(startedAt === undefined ? {} : { startedAt }),
    completedAt,
    durationMs,
    models,
    skills,
    usage,
    tools,
    ...(securityScan === undefined ? {} : { securityScan }),
    ...(securityScanEffectiveDisposition === undefined ? {} : { securityScanEffectiveDisposition }),
    ...(securityScanAuthorization === undefined ? {} : { securityScanAuthorization }),
    ...(evidenceWarnings === undefined ? {} : { evidenceWarnings }),
    ...(searchFindings === undefined ? {} : { searchFindings }),
    ...(negativeEvidence === undefined ? {} : { negativeEvidence }),
    ...(gapLedger === undefined ? {} : { gapLedger }),
    ...(changes === undefined ? {} : { changes }),
    steps,
  };
  // The aggregate seals the record as written, so it is checked against the
  // raw record rather than this decoder's projection of it.
  verifyRunRecordComposition(root as unknown as RunRecord, getWorkflow("readiness"));
  if (root.compositionExecution !== undefined) {
    decoded.compositionExecution = structuredClone(
      root.compositionExecution,
    ) as RunRecord["compositionExecution"];
  }
  if (root.compositionExecutionAggregate !== undefined) {
    decoded.compositionExecutionAggregate = structuredClone(
      root.compositionExecutionAggregate,
    ) as RunRecord["compositionExecutionAggregate"];
  }
  if (root.workflowOutcome !== undefined) {
    decoded.workflowOutcome = decodeWorkflowOutcome(
      root.workflowOutcome,
      decoded,
      SECURITY_SCAN_POLICY,
    );
  }
  if (root.requestIntent !== undefined) {
    decoded.requestIntent = decodeRunRecordRequestIntent(root.requestIntent, root.instruction);
  }
  return decoded;
}

/**
 * A read-only run's change evidence: the runner records the changed-file list
 * for every run, and for a read-only workflow it must be empty with no patch.
 */
function decodeReadOnlyChanges(value: unknown): NonNullable<RunRecord["changes"]> {
  requireCondition(isReadOnlyRunChanges(value));
  return { files: [] };
}

function decodeRepository(value: unknown): RunRecord["repository"] {
  const item = object(value);
  exact(item, ["sourcePath", "requestedRevision", "revision"]);
  return {
    sourcePath: safeText(item.sourcePath, 16_384),
    requestedRevision: safeText(item.requestedRevision, 1_024),
    revision: pattern(item.revision, REVISION),
  };
}

function decodeWorkspace(value: unknown): RunRecord["workspace"] {
  const item = object(value);
  exact(item, ["strategy", "disposable"]);
  requireEqual(item.strategy, "tracked-export");
  requireEqual(item.disposable, true);
  return { strategy: "tracked-export", disposable: true };
}

function decodeReadinessStep(
  value: unknown,
  repository: RunRecord["repository"],
): RunRecord["steps"][number] {
  const item = object(value);
  exact(item, [
    "id",
    "title",
    "kind",
    "skill",
    "mode",
    "status",
    "startedAt",
    "completedAt",
    "durationMs",
    "model",
    "skillEvidence",
    "usage",
    "tools",
    "inference",
    "contextPreflight",
    "searchEvidence",
    "searchParticipation",
    "searchFindings",
    "negativeEvidence",
    "gapLedger",
    "summary",
    "error",
    "failure",
  ]);
  requireEqual(item.id, "assess-readiness");
  requireEqual(item.title, "Assess repository readiness");
  requireEqual(item.kind, "inference");
  const skill = oneOf(item.skill, [
    "doc-context-analyzer",
    "assess-documentation-readiness",
  ] as const);
  requireEqual(item.mode, "read-only");
  const status = oneOf(item.status, ["pending", "succeeded", "failed"] as const);
  const startedAt = optionalTimestamp(item.startedAt);
  const completedAt = optionalTimestamp(item.completedAt);
  const durationMs = optionalNonnegativeInteger(item.durationMs);
  if (startedAt !== undefined || completedAt !== undefined || durationMs !== undefined) {
    requireCondition(
      startedAt !== undefined && completedAt !== undefined && durationMs !== undefined,
    );
    requireCondition(startedAt <= completedAt);
    requireCondition(Date.parse(completedAt) - Date.parse(startedAt) === durationMs);
  }
  const model = item.model === undefined ? undefined : decodeModelEvidence(item.model);
  const skillEvidence =
    item.skillEvidence === undefined ? undefined : decodeSkillEvidence(item.skillEvidence);
  const usage = item.usage === undefined ? undefined : decodeUsage(item.usage);
  const tools = item.tools === undefined ? undefined : decodeTools(item.tools);
  const inference = item.inference === undefined ? undefined : decodeInference(item.inference);
  const contextPreflight = decodeContextPreflight(item.contextPreflight);
  const searchPlan = getWorkflow("readiness").steps[0]!.search;
  const searchEvidence =
    item.searchEvidence === undefined
      ? undefined
      : decodeWorkflowSearchEvidence(item.searchEvidence, searchPlan!, repository);
  const searchFindings =
    item.searchFindings === undefined
      ? undefined
      : array(item.searchFindings).map(decodeDocumentationSearchFinding);
  const negativeEvidence =
    item.negativeEvidence === undefined
      ? undefined
      : array(item.negativeEvidence).map(decodeDocumentationSearchFinding);
  const gapLedger =
    item.gapLedger === undefined ? undefined : decodeDocumentationGapLedger(item.gapLedger);
  const searchParticipation =
    item.searchParticipation === undefined
      ? undefined
      : // A readiness record has exactly one step, so nothing precedes it and a
        // `reuse` claim here is unsatisfiable by construction.
        decodeSearchParticipation(item.searchParticipation, searchEvidence, "assess-readiness", []);
  if (searchEvidence === undefined) {
    requireCondition(
      searchFindings === undefined &&
        negativeEvidence === undefined &&
        gapLedger === undefined &&
        searchParticipation === undefined,
    );
  } else {
    requireCondition(
      searchFindings !== undefined && negativeEvidence !== undefined && gapLedger !== undefined,
    );
    const expectedFindings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence: searchEvidence,
    });
    const expectedNegative = negativeDocumentationEvidence(expectedFindings);
    const expectedLedger = createDocumentationGapLedger({
      currentRevision: repository.revision,
      findings: expectedFindings,
    });
    requireCondition(canonical(searchFindings) === canonical(expectedFindings));
    requireCondition(canonical(negativeEvidence) === canonical(expectedNegative));
    requireCondition(canonical(gapLedger) === canonical(expectedLedger));
  }
  const summary = optionalText(item.summary, 1_000_000);
  const error = optionalText(item.error, 65_536);
  const failure = optionalFailure(item.failure, status);

  if (status === "pending") {
    requireCondition(
      startedAt === undefined &&
        completedAt === undefined &&
        durationMs === undefined &&
        model === undefined &&
        usage === undefined &&
        tools === undefined &&
        inference === undefined &&
        summary === undefined &&
        error === undefined,
    );
  } else {
    requireCondition(
      startedAt !== undefined && completedAt !== undefined && durationMs !== undefined,
    );
  }
  if (status === "succeeded") {
    requireCondition(inference !== undefined && inference.attempts.at(-1)?.outcome === "succeeded");
    requireCondition(
      model !== undefined && usage !== undefined && tools !== undefined && summary !== undefined,
    );
    requireCondition(
      error === undefined &&
        (contextPreflight.status === "ready" ||
          contextPreflight.status === "degraded" ||
          contextPreflight.status === "unnecessary"),
    );
  }
  if (status === "failed" && inference !== undefined) {
    requireCondition(inference.attempts.at(-1)?.outcome !== "succeeded");
  }

  return {
    id: "assess-readiness",
    title: "Assess repository readiness",
    kind: "inference",
    skill,
    mode: "read-only",
    status,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(model === undefined ? {} : { model }),
    ...(skillEvidence === undefined ? {} : { skillEvidence }),
    ...(usage === undefined ? {} : { usage }),
    ...(tools === undefined ? {} : { tools }),
    ...(inference === undefined ? {} : { inference }),
    contextPreflight,
    ...(searchEvidence === undefined ? {} : { searchEvidence }),
    ...(searchParticipation === undefined ? {} : { searchParticipation }),
    ...(searchFindings === undefined ? {} : { searchFindings }),
    ...(negativeEvidence === undefined ? {} : { negativeEvidence }),
    ...(gapLedger === undefined ? {} : { gapLedger }),
    ...(summary === undefined ? {} : { summary }),
    ...(error === undefined ? {} : { error }),
    ...(failure === undefined ? {} : { failure }),
  };
}

/**
 * A failure class is optional (older records carry none), valid only on a
 * failed run or step, and exactly the closed shape.
 */
function optionalFailure(value: unknown, status: string): FailureClassificationV1 | undefined {
  if (value === undefined) return undefined;
  const failure = readFailureClassification(value);
  requireCondition(failure !== null && status === "failed");
  return failure!;
}

function validateSecurityConsistency(
  report: SecurityScanReport | undefined,
  disposition: RunRecord["securityScanEffectiveDisposition"],
  authorization: SecurityScanAuthorizationEvidence | undefined,
  revision: string,
): void {
  if (report === undefined && disposition === undefined && authorization === undefined) return;
  requireCondition(report !== undefined && disposition !== undefined);
  // Advisory is the new-run disposition; the scan carries no authority and never
  // records override authorization.
  if (disposition.status === "advisory") {
    requireCondition(authorization === undefined);
    return;
  }
  if (authorization) {
    requireCondition(authorization.overrides.every((override) => override.revision === revision));
  }
  const expected =
    report.status === "failed"
      ? "failed"
      : authorization?.status === "authorized"
        ? "authorized"
        : authorization?.status === "denied"
          ? "denied"
          : "passed";
  // Accept historical records that predate diagnostic-only source findings.
  requireCondition(
    disposition.status === expected ||
      (authorization === undefined && disposition.status === report.status),
  );
}

function validateTerminalShape(
  status: RunRecord["status"],
  step: RunRecord["steps"][number],
  models: ModelEvidence[],
  usage: TokenUsage,
  tools: ToolActivitySummary,
  scan: SecurityScanReport | undefined,
  disposition: RunRecord["securityScanEffectiveDisposition"],
): void {
  if (status === "succeeded") {
    requireCondition(step.status === "succeeded" && step.inference !== undefined);
    requireCondition(
      disposition === undefined ||
        disposition.status === "advisory" ||
        disposition.status === "passed" ||
        disposition.status === "authorized",
    );
    return;
  }
  requireCondition(step.status === "pending" || step.status === "failed");
  if (step.inference === undefined) {
    const localFailure =
      disposition?.status === "blocked" ||
      disposition?.status === "denied" ||
      disposition?.status === "failed" ||
      scan?.status === "failed" ||
      step.contextPreflight?.status === "failed";
    requireCondition(
      localFailure &&
        models.length === 0 &&
        usage.total === 0 &&
        usage.turns === 0 &&
        tools.totalCalls === 0,
    );
  }
}

function validateModelAggregation(models: ModelEvidence[], step: RunRecord["steps"][number]): void {
  const attemptModels = step.inference?.attempts.map((attempt) => attempt.model) ?? [];
  if (attemptModels.length === 0) {
    requireCondition(models.length === 0 && step.model === undefined);
    return;
  }
  const expected = attemptModels.at(-1)!;
  requireCondition(models.length === 1 && sameModel(models[0]!, expected));
  requireCondition(step.model !== undefined && sameModel(step.model, expected));
  requireCondition(attemptModels.every((model) => sameModel(model!, expected)));
}

function validateEvidenceBinding(
  repositoryRevision: string,
  step: RunRecord["steps"][number],
): void {
  const attempts = step.inference?.attempts ?? [];
  if (attempts.length === 0) return;
  const preflight = step.contextPreflight;
  requireCondition(
    preflight !== undefined &&
      (preflight.status === "unnecessary" ||
        ((preflight.status === "ready" || preflight.status === "degraded") &&
          preflight.packetDigest !== undefined &&
          preflight.consultedNodeIds !== undefined &&
          preflight.consultedNodeIds.length > 0) ||
        // A step that ran without a packet names the budget no packet fit,
        // or the cause that left it none.
        (preflight.status === "degraded" &&
          preflight.packetDigest === undefined &&
          preflight.consultedNodeIds === undefined &&
          (preflight.limit !== undefined || preflight.cause !== undefined))),
  );
  for (const attempt of attempts) {
    requireCondition(
      attempt.identity?.repositoryRevision === repositoryRevision &&
        attempt.identity.contextPacketDigest === preflight.packetDigest &&
        (preflight.consultedNodeIds === undefined
          ? attempt.identity.consultedNodeIds === undefined
          : canonical(attempt.identity.consultedNodeIds) === canonical(preflight.consultedNodeIds)),
    );
  }
}

function validateSkillAggregation(skills: SkillEvidence[], step: RunRecord["steps"][number]): void {
  if (step.skillEvidence === undefined) {
    requireCondition(skills.length === 0);
  } else {
    requireCondition(skills.length === 1 && canonical(skills[0]) === canonical(step.skillEvidence));
  }
}

function validateRunArithmetic(
  usage: TokenUsage,
  tools: ToolActivitySummary,
  step: RunRecord["steps"][number],
): void {
  const attempts = step.inference?.attempts ?? [];
  const attemptUsage = attempts.flatMap((attempt) => (attempt.usage ? [attempt.usage] : []));
  const summedUsage = sumUsage(attemptUsage);
  const attemptTools = attempts
    .map((attempt) => attempt.tools)
    .filter((item): item is ToolActivitySummary => item !== undefined);
  const summedTools = sumTools(attemptTools);
  if (attempts.length === 0) {
    requireCondition(step.usage === undefined && step.tools === undefined);
  } else {
    requireCondition(attemptUsage.length === attempts.length && step.usage !== undefined);
    requireCondition(canonical(step.usage) === canonical(summedUsage));
    // Compare tool counts, excluding `presented`: the tool set the step was
    // offered is a per-step constant, not a summable quantity, and `sumTools`
    // does not reconstruct it.
    requireCondition(
      step.tools !== undefined && comparableTools(step.tools) === comparableTools(summedTools),
    );
    requireCondition(
      step.durationMs! >=
        safeSum(attempts.map((attempt) => attempt.durationMs + (attempt.backoffMs ?? 0))),
    );
  }
  requireCondition(canonical(usage) === canonical(summedUsage));
  requireCondition(canonical(tools) === canonical(summedTools));
}

function sameModel(left: ModelEvidence, right: ModelEvidence): boolean {
  return canonical(left) === canonical(right);
}

function sumUsage(values: TokenUsage[]): TokenUsage {
  const output: TokenUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    turns: 0,
  };
  let cost = 0;
  let completeCost = values.length > 0;
  for (const value of values) {
    output.input = safeSum([output.input, value.input]);
    output.output = safeSum([output.output, value.output]);
    output.cacheRead = safeSum([output.cacheRead, value.cacheRead]);
    output.cacheWrite = safeSum([output.cacheWrite, value.cacheWrite]);
    output.total = safeSum([output.total, value.total]);
    output.turns = safeSum([output.turns, value.turns]);
    if (value.cost === undefined) completeCost = false;
    else cost = roundedCost(cost + value.cost);
  }
  if (completeCost) output.cost = cost;
  return output;
}

/**
 * Canonical form for step-vs-attempt-sum tool comparison, with `presented`
 * removed. See the call site: it is a per-step constant, not a summable count.
 */
function comparableTools(value: ToolActivitySummary): string {
  const {
    presented: _presented,
    toolResultArchive: _archive,
    readEvidence: _readEvidence,
    historyReads: _historyReads,
    toolRefusals: _toolRefusals,
    toolArgumentFiller: _toolArgumentFiller,
    ...comparable
  } = value;
  return canonical(comparable);
}

function sumTools(values: ToolActivitySummary[]): ToolActivitySummary {
  type ToolFailureCategory = NonNullable<
    ToolActivitySummary["failureCategories"]
  >[number]["category"];
  const byTool = new Map<string, { calls: number; failures: number }>();
  const categories = new Map<ToolFailureCategory, number>();
  let totalCalls = 0;
  let failedCalls = 0;
  let preExecutionRejections = 0;
  let sawCategories = false;
  for (const value of values) {
    totalCalls = safeSum([totalCalls, value.totalCalls]);
    failedCalls = safeSum([failedCalls, value.failedCalls]);
    preExecutionRejections = safeSum([
      preExecutionRejections,
      value.preExecutionRejections?.count ?? 0,
    ]);
    for (const entry of value.byTool) {
      const current = byTool.get(entry.name) ?? { calls: 0, failures: 0 };
      current.calls = safeSum([current.calls, entry.calls]);
      current.failures = safeSum([current.failures, entry.failures]);
      byTool.set(entry.name, current);
    }
    if (value.failureCategories !== undefined) {
      sawCategories = true;
      for (const entry of value.failureCategories) {
        categories.set(entry.category, safeSum([categories.get(entry.category) ?? 0, entry.count]));
      }
    }
  }
  return {
    totalCalls,
    failedCalls,
    ...(preExecutionRejections > 0
      ? {
          preExecutionRejections: {
            schemaVersion: 1,
            kind: "tool-pre-execution-rejections",
            count: preExecutionRejections,
          } as const,
        }
      : {}),
    byTool: [...byTool.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, activity]) => ({ name, ...activity })),
    ...(sawCategories
      ? {
          failureCategories: [...categories.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([category, count]) => ({
              category,
              count,
            })),
        }
      : {}),
  };
}

function roundedCost(value: number): number {
  return Number(value.toFixed(12));
}
