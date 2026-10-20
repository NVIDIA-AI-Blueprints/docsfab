// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalDigest } from "../content-ir/canonical.js";
import { decodeCheckoutPersistenceOutcome } from "../records/checkout-persistence.js";
import { decodeRunRecordRequestIntent } from "../request-intent/interpret-record.js";
import { deepFreeze } from "../contract-kit/freeze.js";
import type { ContentIndexV1, ContentNode } from "../content-ir/contracts.js";
import {
  validateArtifact,
  validateArtifactUse,
  type Artifact,
  type ArtifactReference,
  type ArtifactUse,
  type IaPlanArtifact,
  type NavigationEvaluationArtifact,
} from "../artifacts/index.js";
import {
  isLegacyHostPathDisclosure,
  type InferenceAttemptEvidence,
  type InferenceFailureCategory,
  type InferenceTransportRetryEvidence,
  type ModelEvidence,
  type RunRecord,
  type SkillEvidence,
  type TokenUsage,
} from "../records/contracts.js";
import { validModelEvidenceProjection } from "../model/profile-evidence.js";
import { isRequestPolicyRefusal } from "../model/request-policy-refusals.js";
import { evaluateStructure } from "./structural.js";
import { detectCredentialRuleIds } from "../security/repository-scanner.js";
import {
  isRetainableInferenceRejection,
  MAX_INFERENCE_REJECTION_REASON_LENGTH,
} from "../config/inference-rejection-limits.js";
import { isRejectedReplyExcerptOf } from "../execution/rejected-reply-excerpt.js";
import { isInferenceRejectionSubject } from "../execution/rejection-subject.js";
import { isInferenceRejectedReplyShape } from "../execution/rejected-reply-shape.js";
import { isJudgmentRowKeyAudit } from "../execution/judgment-row-key-audit-contract.js";
import { isInferenceAttemptModelTelemetry } from "../records/model-telemetry.js";
import { decodeExecutionLeaseRuntimeEvidence } from "../scorecard-record.js";
import { object, exact, fail } from "./corpus-live/value-kit.js";
import {
  emptyUsage,
  emptyTools,
  parseUsage,
  comparableTools,
  toolNames,
} from "./corpus-live/usage-tools.js";
import { decodeWorkflowOutcome } from "../workflow-contracts/outcome.js";
import type { WorkflowName } from "../workflow-contracts/contracts.js";
import { getWorkflow } from "../workflow-registry/catalog.js";
import {
  RunRecordCompositionError,
  verifyRunRecordComposition,
} from "../records/composition-execution.js";
import { defineRunRecordReader, isReadOnlyRunChanges } from "../records/run-record-readers.js";
import { isInferenceAnswerSubmissionEvidence } from "../records/answer-submission-evidence.js";
import {
  inferenceAttemptRulesConsistent,
  isInferenceConcludeNowEvidence,
  isInferenceConditionRetryEvidence,
  isInferenceFailureCondition,
  isRetryRuleId,
  type RetryRuleExecution,
} from "../records/inference-retry-rule.js";
import {
  INFERENCE_ATTEMPT_SUCCESS_OUTCOME,
  isInferenceAttemptOutcome,
  isInferenceFailureCategory,
  isMalformedResponseCategory,
} from "../inference-attempt-taxonomy.js";
import {
  isInferenceConditionRetryability,
  isInferenceRetryDecision,
  isInferenceTransportRetryEvidence,
  isProviderTurnReplayVeto,
} from "../records/inference-retry-disposition.js";
import {
  type CorpusCase,
  type CorpusDestination,
  type CorpusLiveRunEvidence,
  type CorpusRunObservation,
} from "./corpus.js";

const derivedLiveRuns = new WeakMap<object, string>();

const GIT_REVISION = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const TPL_SKILL_CONTENT_SHA256 = "4232151a4aa963cf25bef72efe9759182f1831b596e80ef7c522e89b7026cf4c";
const TPL_SKILL_BUNDLE_SHA256 = "f8071a9b07a0f716d367350800531e32b59c7b788835a8c62417356a102aba73";
const TPL_SKILL_SOURCE_REVISION = "a9bd1e5692ad4f05cb2444d192920baa56f3d53d";
const TPL_SKILL_EVALUATION_SHA256 =
  "a064f6c9f528c0fcea5b4be8fa4673e2db5fe3088c2d84472f93c317f462a1a0";
/**
 * Names the Git URL the pinned tpl-design-ia evaluation was recorded from. The
 * operator who holds the archived live records supplies it; there is no default.
 */
export const CORPUS_SKILL_SOURCE_REPOSITORY_ENV = "DOCSFAB_CORPUS_SKILL_SOURCE_REPOSITORY";

export interface CorpusRawLiveRunInput {
  caseId: string;
  planningRunRecord: unknown;
  providerRunRecord: unknown;
  contentIndex: unknown;
  ontologyArtifact: unknown;
  candidateArtifact: unknown;
  evaluationArtifact: unknown;
  planArtifact: unknown;
  navigationArtifact: unknown;
}

/**
 * Derive one live observation exclusively from decoded private records and
 * validated artifacts. Callers never supply scored fields or result digests.
 */
export function deriveCorpusLiveRun(
  corpusCase: CorpusCase,
  input: CorpusRawLiveRunInput,
  now: Date,
): CorpusRunObservation {
  if (
    input.caseId !== corpusCase.id ||
    !corpusCase.planning ||
    corpusCase.expectedDisposition !== "recommendation-ready"
  )
    fail("live-case");
  const index = parseContentIndex(input.contentIndex, corpusCase);
  const planning = parsePlanningRecord(input.planningRunRecord);
  const provider = parseProviderRecord(input.providerRunRecord);
  if (
    planning.repository.revision !== provider.repository.revision ||
    planning.repository.revision !== index.repository.revision ||
    planning.contextPacketDigest !== provider.contextPacketDigest ||
    canonicalDigest(planning.consultedNodeIds) !== canonicalDigest(provider.consultedNodeIds) ||
    planning.taskDigest !== provider.taskDigest
  ) {
    fail("live-record-chain");
  }
  if (Date.parse(provider.completedAt) > Date.parse(planning.startedAt)) {
    fail("live-record-timeline-chain");
  }
  const ontology = validateArtifact(input.ontologyArtifact, { index, now });
  const candidates = validateArtifact(input.candidateArtifact, { index, now });
  const evaluation = validateArtifact(input.evaluationArtifact, { index, now });
  const plan = validateArtifact(input.planArtifact, {
    index,
    now,
    planAcceptance: "any",
  });
  const navigation = validateArtifact(input.navigationArtifact, { index, now });
  if (
    ontology.kind !== "ontology" ||
    candidates.kind !== "ia-candidates" ||
    evaluation.kind !== "ia-evaluation" ||
    plan.kind !== "ia-plan" ||
    navigation.kind !== "navigation-evaluation"
  ) {
    fail("live-artifact-kind");
  }
  assertArtifactReference(planning.outputPlan, plan);
  assertArtifactReference(plan.payload.candidateArtifact, candidates);
  if (!plan.payload.iaEvaluation) fail("live-incomplete-plan");
  assertArtifactReference(plan.payload.iaEvaluation, evaluation);
  assertArtifactReference(plan.payload.navigationEvaluation, navigation);
  assertCompleteArtifactUses(planning.artifacts, "plan-information-architecture", [
    { role: "input", artifact: ontology },
    { role: "input", artifact: candidates },
    { role: "input", artifact: evaluation },
    { role: "input", artifact: navigation },
    { role: "output", artifact: plan },
  ]);
  assertCompleteArtifactUses(provider.outputArtifacts, "analyze-information-architecture", [
    { role: "output", artifact: ontology },
    { role: "output", artifact: candidates },
    { role: "output", artifact: navigation },
  ]);
  if (planning.task.scope !== plan.payload.scope || planning.task.mode !== plan.payload.mode) {
    fail("live-task-artifact-chain");
  }
  if (
    plan.payload.approval.status !== "pending" ||
    plan.payload.approval.approvedAt !== undefined ||
    plan.payload.approval.approvedBy !== undefined ||
    Date.parse(plan.payload.expiresAt) <= now.valueOf() ||
    plan.payload.openDecisions.length !== 0 ||
    plan.payload.migrationDispositions?.some(
      (item) => item.disposition === "needs-human-decision",
    ) === true
  ) {
    fail("live-plan-terminal-state");
  }
  const recommended = candidates.payload.candidates.find(
    (item) => item.id === candidates.payload.recommendedCandidateId,
  );
  if (
    !recommended ||
    plan.payload.candidateId !== recommended.id ||
    canonicalDigest(plan.payload.groups) !== canonicalDigest(recommended.groups) ||
    plan.payload.primaryAxis !== recommended.primaryAxis ||
    canonicalDigest(plan.payload.secondaryAxes) !== canonicalDigest(recommended.secondaryAxes) ||
    evaluation.payload.candidateId !== recommended.id ||
    !evaluation.payload.eligible ||
    evaluation.payload.deterministicStatus !== "passed" ||
    !sameReference(evaluation.payload.candidateArtifact, plan.payload.candidateArtifact) ||
    !sameReference(evaluation.payload.navigationEvaluation, plan.payload.navigationEvaluation)
  ) {
    fail("live-artifact-chain");
  }

  const aliases = corpusAliasMap(corpusCase, index.nodes);
  assertNavigationSuiteBinding(corpusCase, navigation);
  const majorGroupings = plan.payload.groups
    .map((group) => group.members.flatMap((nodeId) => aliases.get(nodeId) ?? []))
    .filter((group) => group.length > 0);
  const grouped = majorGroupings.flat();
  const groupedSet = new Set(grouped);
  const duplicateCanonicalHomes = [...new Set(grouped)].flatMap((nodeId) => {
    const paths = plan.payload.groups
      .filter((group) => group.members.some((member) => aliases.get(member)?.includes(nodeId)))
      .map((group) => group.canonicalPath);
    return paths.length > 1 ? [{ nodeId, paths }] : [];
  });
  const orphanNodeIds = Object.keys(corpusCase.publicNodeSources).filter(
    (nodeId) => !groupedSet.has(nodeId),
  );
  const navigationResults = new Map(navigation.payload.results.map((item) => [item.taskId, item]));
  const rankings = corpusCase.knownAnswers.map((answer) => {
    const result = navigationResults.get(answer.id);
    if (!result) fail("live-navigation-task-coverage");
    return {
      answerId: answer.id,
      destinations: result.rankedNodeIds.map((nodeId) =>
        observedDestination(corpusCase, index.nodes, aliases, nodeId),
      ),
    };
  });
  const placements = rankings.map((ranking) => ({
    answerId: ranking.answerId,
    destination: ranking.destinations[0] ?? null,
  }));
  const completedAt = planning.completedAt;
  const startedAt = provider.startedAt;
  const runWithoutEvidence: Omit<CorpusRunObservation, "evidence"> = {
    id: planning.id,
    caseId: corpusCase.id,
    repositoryRevision: corpusCase.repository.revision,
    startedAt,
    completedAt,
    disposition: "recommendation-ready",
    artifactValid: true,
    evidenceNodeIds: [...new Set(grouped)],
    orphanNodeIds,
    duplicateCanonicalHomes,
    placements,
    rankings,
    majorGroupings,
    dynamicTools: provider.toolNames,
    provider: {
      outcome: "succeeded",
      model: {
        provider: provider.model.provider,
        model: provider.model.model,
        profileSha256: provider.model.profile!.sha256,
      },
    },
    metrics: {
      latencyMs: Date.parse(planning.completedAt) - Date.parse(provider.startedAt),
      usage: provider.usage,
    },
  };
  const resultDigest = liveRunResultDigest(runWithoutEvidence);
  const evidence: CorpusLiveRunEvidence = {
    source: "raw-record-artifact-chain",
    planningRunRecordDigest: canonicalDigest(input.planningRunRecord),
    providerRunRecordDigest: canonicalDigest(input.providerRunRecord),
    contentIndexDigest: index.indexDigest,
    ontologyArtifactDigest: ontology.digest,
    candidateArtifactDigest: candidates.digest,
    evaluationArtifactDigest: evaluation.digest,
    planArtifactDigest: plan.digest,
    navigationArtifactDigest: navigation.digest,
    actualRepositoryRevision: planning.repository.revision,
    actualRepositoryContentDigest: index.repository.contentDigest,
    providerRunId: provider.id,
    planningTaskDigest: planning.taskDigest,
    contextPacketDigest: planning.contextPacketDigest,
    consultedNodeIds: planning.consultedNodeIds,
    resultDigest,
  };
  const run = deepFreeze({ ...runWithoutEvidence, evidence });
  derivedLiveRuns.set(run, canonicalDigest(run));
  return run;
}

export function isDerivedCorpusLiveRun(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  const digest = derivedLiveRuns.get(value);
  return digest !== undefined && digest === canonicalDigest(value);
}

export function consumeDerivedCorpusLiveRun(value: object): void {
  if (!isDerivedCorpusLiveRun(value) || !derivedLiveRuns.delete(value)) {
    throw new Error("Live corpus evidence capability was already consumed.");
  }
}

function liveRunResultDigest(run: Omit<CorpusRunObservation, "evidence">): string {
  return canonicalDigest({
    caseId: run.caseId,
    repositoryRevision: run.repositoryRevision,
    disposition: run.disposition,
    artifactValid: run.artifactValid,
    evidenceNodeIds: run.evidenceNodeIds,
    orphanNodeIds: run.orphanNodeIds,
    duplicateCanonicalHomes: run.duplicateCanonicalHomes,
    placements: run.placements,
    rankings: run.rankings,
    majorGroupings: run.majorGroupings,
  });
}

interface DecodedPlanningRecord {
  id: string;
  repository: { revision: string };
  task: { scope: "site" | "section" | "page"; mode: "create" | "reevaluate" };
  taskDigest: string;
  contextPacketDigest: string;
  consultedNodeIds: string[];
  outputPlan: ArtifactReference<"ia-plan">;
  artifacts: ArtifactUse[];
  startedAt: string;
  completedAt: string;
}

interface DecodedProviderRecord {
  id: string;
  repository: { revision: string };
  startedAt: string;
  completedAt: string;
  durationMs: number;
  contextPacketDigest: string;
  consultedNodeIds: string[];
  taskDigest: string;
  model: ModelEvidence & { profile: NonNullable<ModelEvidence["profile"]> };
  usage: TokenUsage;
  toolNames: string[];
  outputArtifacts: ArtifactUse[];
}

function parsePlanningRecord(value: unknown): DecodedPlanningRecord {
  const record = runRecord(value, "planning");
  if (
    record.workflow !== "ia-plan" ||
    record.status !== "succeeded" ||
    record.task?.kind !== "ia-plan" ||
    record.steps.length !== 1
  )
    fail("live-planning-record");
  const step = record.steps[0]!;
  assertStepContractShape(step);
  if (
    step.id !== "plan-information-architecture" ||
    step.title !== "Plan information architecture" ||
    step.skill !== "tpl-design-ia" ||
    step.kind !== "host-operation" ||
    step.operation !== "ia-plan" ||
    step.mode !== "read-only" ||
    step.status !== "succeeded" ||
    step.model !== undefined ||
    step.usage !== undefined ||
    step.tools !== undefined ||
    step.inference !== undefined ||
    !step.startedAt ||
    !step.completedAt ||
    step.durationMs !== Date.parse(step.completedAt) - Date.parse(step.startedAt) ||
    Date.parse(step.startedAt) < Date.parse(record.startedAt!) ||
    Date.parse(step.completedAt) > Date.parse(record.completedAt!) ||
    typeof step.summary !== "string" ||
    !step.summary
  ) {
    fail("live-planning-step");
  }
  const context = readyContextEvidence(step.contextPreflight);
  const uses = artifactUses(step.artifacts);
  const outputs = uses.filter(
    (item) => item.role === "output" && item.reference.kind === "ia-plan",
  );
  if (outputs.length !== 1 || canonicalDigest(record.artifacts ?? []) !== canonicalDigest(uses)) {
    fail("live-planning-artifacts");
  }
  return {
    id: record.id,
    repository: { revision: record.repository.revision },
    task: { scope: record.task.scope, mode: record.task.mode },
    taskDigest: canonicalDigest(record.task),
    contextPacketDigest: context.packetDigest,
    consultedNodeIds: context.consultedNodeIds,
    outputPlan: outputs[0]!.reference as ArtifactReference<"ia-plan">,
    artifacts: uses,
    startedAt: record.startedAt!,
    completedAt: record.completedAt!,
  };
}

function parseProviderRecord(value: unknown): DecodedProviderRecord {
  const record = runRecord(value, "provider");
  if (
    record.workflow !== "ia-analysis" ||
    record.status !== "succeeded" ||
    record.task?.kind !== "ia-plan" ||
    record.steps.length !== 1 ||
    !record.startedAt ||
    !record.completedAt ||
    record.durationMs === undefined
  ) {
    fail("live-provider-record");
  }
  const step = record.steps[0]!;
  assertStepContractShape(step);
  if (
    step.id !== "analyze-information-architecture" ||
    step.title !== "Analyze information architecture" ||
    step.skill !== "tpl-design-ia" ||
    step.kind !== "inference" ||
    step.mode !== "read-only" ||
    step.status !== "succeeded" ||
    !step.model ||
    !step.usage ||
    !step.tools ||
    !step.inference ||
    step.inference.attempts.at(-1)?.outcome !== "succeeded" ||
    Date.parse(step.startedAt!) < Date.parse(record.startedAt) ||
    Date.parse(step.completedAt!) > Date.parse(record.completedAt)
  ) {
    fail("live-provider-step");
  }
  if (
    !validModelEvidenceProjection(step.model) ||
    record.models.length !== 1 ||
    canonicalDigest(record.models[0]) !== canonicalDigest(step.model) ||
    canonicalDigest(record.usage) !== canonicalDigest(step.usage) ||
    // `presented` is a per-step constant that is not aggregated to run level.
    canonicalDigest(comparableTools(record.tools)) !== canonicalDigest(comparableTools(step.tools))
  ) {
    fail("live-provider-aggregation");
  }
  assertModelEvidence(step.model);
  if (
    !step.skillEvidence ||
    record.skills.length !== 1 ||
    canonicalDigest(record.skills[0]) !== canonicalDigest(step.skillEvidence) ||
    step.skillEvidence.id !== "tpl-design-ia"
  )
    fail("live-provider-skill-aggregation");
  assertSkillEvidence(step.skillEvidence);
  const context = readyContextEvidence(step.contextPreflight);
  assertInferenceContractShape(step.inference, record.repository.revision, context.packetDigest);
  try {
    const structural = evaluateStructure(
      {
        version: 1,
        name: "living-documentation live provider record",
        assertions: [
          { type: "workflow", equals: "ia-analysis" },
          { type: "all-steps-succeeded" },
          { type: "turn-governance-evidence" },
          { type: "governed-terminal-status" },
        ],
      },
      [record],
    );
    if (!structural.passed) fail("live-provider-governance");
  } catch {
    fail("live-provider-governance");
  }
  const outputArtifacts = artifactUses(step.artifacts).filter((item) => item.role === "output");
  if (
    outputArtifacts.length !== 3 ||
    canonicalDigest(record.artifacts ?? []) !== canonicalDigest(artifactUses(step.artifacts))
  )
    fail("live-provider-artifacts");
  return {
    id: record.id,
    repository: { revision: record.repository.revision },
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    durationMs: record.durationMs,
    contextPacketDigest: context.packetDigest,
    consultedNodeIds: context.consultedNodeIds,
    taskDigest: canonicalDigest(record.task),
    model: step.model,
    usage: parseUsage(step.usage),
    toolNames: toolNames(step.tools),
    outputArtifacts,
  };
}

function assertStepContractShape(step: RunRecord["steps"][number]): void {
  const root = object(step, "live-step");
  exact(
    root,
    [
      "id",
      "title",
      "kind",
      "operation",
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
      "artifacts",
      "summary",
      "error",
    ],
    [
      "id",
      "title",
      "kind",
      "skill",
      "mode",
      "status",
      "startedAt",
      "completedAt",
      "durationMs",
      "contextPreflight",
      "artifacts",
      "summary",
    ],
  );
  if (
    typeof step.startedAt !== "string" ||
    typeof step.completedAt !== "string" ||
    !Number.isSafeInteger(step.durationMs) ||
    step.durationMs! < 0 ||
    Date.parse(step.completedAt) - Date.parse(step.startedAt) !== step.durationMs ||
    step.error !== undefined
  )
    fail("live-step-timeline");
}

function assertInferenceContractShape(
  value: unknown,
  repositoryRevision: string,
  contextPacketDigest: string,
): void {
  const inference = object(value, "live-inference");
  exact(
    inference,
    [
      "configuredMaxRetries",
      "effectiveMaxRetries",
      "baseDelayMs",
      "maxDelayMs",
      "retryableCategories",
      "replay",
      "attempts",
      // Optional: absent on older living-documentation records.
      "maxRetriesSource",
      // Optional: absent on records written before the transport budget.
      "transportRetry",
      // Optional: absent on records written before retry rules were recorded.
      "conditionRetry",
    ],
    [
      "configuredMaxRetries",
      "effectiveMaxRetries",
      "baseDelayMs",
      "maxDelayMs",
      "retryableCategories",
      "replay",
      "attempts",
    ],
  );
  if (
    inference.maxRetriesSource !== undefined &&
    inference.maxRetriesSource !== "config/limits.yaml" &&
    inference.maxRetriesSource !== "host" &&
    inference.maxRetriesSource !== "project"
  ) {
    fail("live-inference");
  }
  for (const key of [
    "configuredMaxRetries",
    "effectiveMaxRetries",
    "baseDelayMs",
    "maxDelayMs",
  ] as const) {
    if (!Number.isSafeInteger(inference[key]) || Number(inference[key]) < 0) fail("live-inference");
  }
  if (
    Number(inference.effectiveMaxRetries) > Number(inference.configuredMaxRetries) ||
    Number(inference.baseDelayMs) > Number(inference.maxDelayMs) ||
    !Array.isArray(inference.retryableCategories) ||
    inference.retryableCategories.some((item) => !isInferenceFailureCategory(String(item))) ||
    new Set(inference.retryableCategories).size !== inference.retryableCategories.length ||
    inference.replay !== "read-only" ||
    !Array.isArray(inference.attempts) ||
    inference.attempts.length === 0 ||
    (inference.transportRetry !== undefined &&
      !isInferenceTransportRetryEvidence(
        inference.transportRetry,
        inference.retryableCategories as InferenceFailureCategory[],
      )) ||
    inference.attempts.length >
      Number(inference.effectiveMaxRetries) +
        1 +
        Number(
          (inference.transportRetry as InferenceTransportRetryEvidence | undefined)?.maxRetries ??
            0,
        ) ||
    (inference.conditionRetry !== undefined &&
      !isInferenceConditionRetryEvidence(
        inference.conditionRetry,
        Number(inference.effectiveMaxRetries),
      ))
  )
    fail("live-inference");
  for (const [attemptIndex, attemptValue] of inference.attempts.entries()) {
    const attempt = object(attemptValue, "live-inference-attempt");
    exact(
      attempt,
      [
        "attempt",
        "outcome",
        "retryable",
        "retryScheduled",
        "writeSettlement",
        // The next thirteen keys are optional, absent on older records, and
        // checked below.
        "conditionRetryability",
        "retryDecision",
        "retryRule",
        "condition",
        "answerBytes",
        "concludeNow",
        "answerSubmission",
        "rejection",
        "rejectedReplyShape",
        "rejectedReplyExcerpt",
        "rejectionSubject",
        "hostPathDisclosure",
        "judgmentRowKeyAudit",
        "modelTelemetry",
        "durationMs",
        "backoffMs",
        "model",
        "usage",
        "tools",
        "identity",
        "turns",
        "executionLease",
      ],
      [
        "attempt",
        "outcome",
        "retryable",
        "retryScheduled",
        "durationMs",
        "model",
        "tools",
        "identity",
        "turns",
      ],
    );
    if (
      attempt.attempt !== attemptIndex + 1 ||
      !isInferenceAttemptOutcome(String(attempt.outcome)) ||
      typeof attempt.retryable !== "boolean" ||
      typeof attempt.retryScheduled !== "boolean" ||
      (attempt.writeSettlement !== undefined &&
        !["no-write", "write-executed", "unavailable"].includes(String(attempt.writeSettlement))) ||
      !Number.isSafeInteger(attempt.durationMs) ||
      Number(attempt.durationMs) < 0 ||
      (attempt.backoffMs !== undefined &&
        (!Number.isSafeInteger(attempt.backoffMs) || Number(attempt.backoffMs) < 0)) ||
      // Written together or not at all; a half-present disposition is malformed.
      (attempt.conditionRetryability === undefined) !== (attempt.retryDecision === undefined) ||
      (attempt.conditionRetryability !== undefined &&
        (!isInferenceConditionRetryability(attempt.conditionRetryability) ||
          !isInferenceRetryDecision(attempt.retryDecision)))
    ) {
      fail("live-inference-attempt");
    }
    if (attempt.rejection !== undefined) {
      // The bound stops a forged record smuggling response bytes through a
      // field the contract promises is content-free.
      const rejection = object(attempt.rejection, "live-inference-attempt");
      exact(rejection, ["code", "location"], ["code", "location"]);
      if (
        typeof rejection.code !== "string" ||
        typeof rejection.location !== "string" ||
        !rejection.code ||
        !rejection.location ||
        rejection.code.length > MAX_INFERENCE_REJECTION_REASON_LENGTH ||
        rejection.location.length > MAX_INFERENCE_REJECTION_REASON_LENGTH ||
        // Grammar, not vocabulary: refuses free prose and indexed locations.
        !isRetainableInferenceRejection({
          code: rejection.code,
          location: rejection.location,
        })
      ) {
        fail("live-inference-attempt");
      }
    }
    if (
      attempt.rejectedReplyShape !== undefined &&
      (!isMalformedResponseCategory(attempt.outcome) ||
        !isInferenceRejectedReplyShape(attempt.rejectedReplyShape))
    ) {
      fail("live-inference-attempt");
    }
    if (
      attempt.rejectedReplyExcerpt !== undefined &&
      !isRejectedReplyExcerptOf(attempt.rejectedReplyExcerpt, attempt.rejectedReplyShape)
    ) {
      fail("live-inference-attempt");
    }
    if (
      attempt.rejectionSubject !== undefined &&
      (attempt.rejection === undefined || !isInferenceRejectionSubject(attempt.rejectionSubject))
    ) {
      fail("live-inference-attempt");
    }
    if (
      (attempt.retryRule !== undefined && !isRetryRuleId(attempt.retryRule)) ||
      (attempt.concludeNow !== undefined && !isInferenceConcludeNowEvidence(attempt.concludeNow)) ||
      (attempt.answerSubmission !== undefined &&
        !isInferenceAnswerSubmissionEvidence(attempt.answerSubmission)) ||
      (attempt.condition !== undefined && !isInferenceFailureCondition(attempt.condition)) ||
      (attempt.answerBytes !== undefined &&
        (attempt.outcome !== INFERENCE_ATTEMPT_SUCCESS_OUTCOME ||
          !Number.isSafeInteger(attempt.answerBytes) ||
          Number(attempt.answerBytes) < 0))
    ) {
      fail("live-inference-attempt");
    }
    // Closed host-path match metadata older hosts wrote, only on a response-contract refusal.
    if (
      attempt.hostPathDisclosure !== undefined &&
      (!isMalformedResponseCategory(attempt.outcome) ||
        !isLegacyHostPathDisclosure(attempt.hostPathDisclosure))
    ) {
      fail("live-inference-attempt");
    }
    if (
      attempt.judgmentRowKeyAudit !== undefined &&
      (attempt.outcome !== INFERENCE_ATTEMPT_SUCCESS_OUTCOME ||
        !isJudgmentRowKeyAudit(attempt.judgmentRowKeyAudit))
    ) {
      fail("live-inference-attempt");
    }
    if (
      attempt.modelTelemetry !== undefined &&
      (!isInferenceAttemptOutcome(String(attempt.outcome)) ||
        !isInferenceAttemptModelTelemetry(
          attempt.modelTelemetry,
          attempt.outcome as InferenceAttemptEvidence["outcome"],
        ))
    ) {
      fail("live-inference-attempt");
    }
    if (attempt.model !== undefined) assertModelEvidence(attempt.model);
    if (attempt.usage !== undefined) parseUsage(attempt.usage);
    if (attempt.tools !== undefined) toolNames(attempt.tools);
    if (attempt.executionLease !== undefined) {
      decodeExecutionLeaseRuntimeEvidence(attempt.executionLease);
    }
    const identity = object(attempt.identity, "live-inference-identity");
    exact(
      identity,
      ["repositoryRevision", "contextPacketDigest", "consultedNodeIds"],
      ["repositoryRevision", "contextPacketDigest", "consultedNodeIds"],
    );
    if (
      identity.repositoryRevision !== repositoryRevision ||
      identity.contextPacketDigest !== contextPacketDigest ||
      !Array.isArray(identity.consultedNodeIds) ||
      identity.consultedNodeIds.some((item) => typeof item !== "string" || !item) ||
      new Set(identity.consultedNodeIds).size !== identity.consultedNodeIds.length
    ) {
      fail("live-inference-identity");
    }
    if (!Array.isArray(attempt.turns) || attempt.turns.length === 0) fail("live-inference-turns");
    const boundProfile = (attempt.model as ModelEvidence | undefined)?.profile;
    for (const turnValue of attempt.turns) {
      const turn = object(turnValue, "live-inference-turn");
      exact(
        turn,
        [
          "contextBudgetSchemaVersion",
          "turn",
          "toolCalls",
          "toolResults",
          "terminalPreExecutionRejections",
          "maxProviderTurns",
          "maxToolCalls",
          "compactions",
          "maxCompactions",
          "configuredContextWindow",
          "effectiveContextWindow",
          "configuredMaxInputTokens",
          "effectiveMaxInputTokens",
          "configuredMaxOutputTokens",
          "effectiveMaxOutputTokens",
          "reservedTokens",
          "estimatedInputTokens",
          "availableInputTokens",
          "availableOutputTokens",
          "requiredMinimumOutputTokens",
          "requestedOutputTokens",
          "outputTokens",
          "outputAuthority",
          "decision",
          "reason",
          "requestDigest",
          "providerPayloadSchemaVersion",
          "requestPolicySha256",
          "finalPayloadSha256",
          "providerRetries",
          "providerBlankTurns",
          "providerReplayVeto",
          "replayedReasoningOmitted",
          "requestPolicyRefusal",
          "rawStopReason",
          "evidenceDigest",
          "compaction",
        ],
        [
          "turn",
          "toolCalls",
          "toolResults",
          "maxProviderTurns",
          "maxToolCalls",
          "compactions",
          "maxCompactions",
          "configuredContextWindow",
          "effectiveContextWindow",
          "configuredMaxOutputTokens",
          "effectiveMaxOutputTokens",
          "reservedTokens",
          "estimatedInputTokens",
          "availableOutputTokens",
          "requiredMinimumOutputTokens",
          "decision",
          "requestDigest",
          "evidenceDigest",
        ],
      );
      for (const key of [
        "turn",
        "toolCalls",
        "toolResults",
        "maxProviderTurns",
        "maxToolCalls",
        "compactions",
        "maxCompactions",
        "configuredContextWindow",
        "effectiveContextWindow",
        "configuredMaxOutputTokens",
        "effectiveMaxOutputTokens",
        "reservedTokens",
        "estimatedInputTokens",
        "availableOutputTokens",
        "requiredMinimumOutputTokens",
      ] as const) {
        if (!Number.isSafeInteger(turn[key]) || Number(turn[key]) < (key === "turn" ? 1 : 0)) {
          fail("live-inference-turn");
        }
      }
      if (
        turn.terminalPreExecutionRejections !== undefined &&
        (!Number.isSafeInteger(turn.terminalPreExecutionRejections) ||
          Number(turn.terminalPreExecutionRejections) < 1)
      ) {
        fail("live-inference-turn");
      }
      const inputKeys = [
        "configuredMaxInputTokens",
        "effectiveMaxInputTokens",
        "availableInputTokens",
      ] as const;
      const inputEvidenceCount = inputKeys.filter((key) => turn[key] !== undefined).length;
      if (
        boundProfile &&
        ((boundProfile.schemaVersion === 2) !== (turn.contextBudgetSchemaVersion === 2) ||
          turn.configuredMaxInputTokens !== boundProfile.configuredMaxInputTokens ||
          turn.effectiveMaxInputTokens !== boundProfile.effectiveMaxInputTokens)
      ) {
        fail("live-inference-turn");
      }
      if (
        (turn.contextBudgetSchemaVersion === 2 && inputEvidenceCount !== 3) ||
        (turn.contextBudgetSchemaVersion === undefined && inputEvidenceCount !== 0) ||
        (turn.contextBudgetSchemaVersion !== undefined && turn.contextBudgetSchemaVersion !== 2)
      )
        fail("live-inference-turn");
      if (turn.contextBudgetSchemaVersion === 2) {
        for (const key of inputKeys) {
          if (!Number.isSafeInteger(turn[key]) || Number(turn[key]) < 0) {
            fail("live-inference-turn");
          }
        }
        if (
          Number(turn.configuredMaxInputTokens) > Number(turn.configuredContextWindow) ||
          Number(turn.effectiveMaxInputTokens) > Number(turn.effectiveContextWindow) ||
          Number(turn.effectiveMaxInputTokens) > Number(turn.configuredMaxInputTokens) ||
          Number(turn.availableInputTokens) !==
            Math.max(0, Number(turn.effectiveMaxInputTokens) - Number(turn.reservedTokens)) ||
          (turn.decision !== "stop" &&
            (Number(turn.reservedTokens) > Number(turn.effectiveMaxInputTokens) ||
              Number(turn.estimatedInputTokens) >
                Number(turn.effectiveMaxInputTokens) - Number(turn.reservedTokens)))
        ) {
          fail("live-inference-turn");
        }
      }
      if (
        !["proceed", "compact", "stop"].includes(String(turn.decision)) ||
        typeof turn.requestDigest !== "string" ||
        !SHA256.test(turn.requestDigest) ||
        (turn.providerPayloadSchemaVersion !== undefined &&
          turn.providerPayloadSchemaVersion !== 1) ||
        (turn.requestPolicySha256 !== undefined &&
          (typeof turn.requestPolicySha256 !== "string" ||
            !SHA256.test(turn.requestPolicySha256))) ||
        (turn.finalPayloadSha256 !== undefined &&
          (typeof turn.finalPayloadSha256 !== "string" || !SHA256.test(turn.finalPayloadSha256))) ||
        (turn.requestPolicySha256 !== undefined && turn.finalPayloadSha256 === undefined) ||
        (turn.providerPayloadSchemaVersion === undefined
          ? turn.requestPolicySha256 !== undefined || turn.finalPayloadSha256 !== undefined
          : turn.finalPayloadSha256 === undefined) ||
        typeof turn.evidenceDigest !== "string" ||
        !SHA256.test(turn.evidenceDigest) ||
        Number(turn.effectiveContextWindow) > Number(turn.configuredContextWindow) ||
        Number(turn.effectiveMaxOutputTokens) > Number(turn.configuredMaxOutputTokens) ||
        Number(turn.toolCalls) > Number(turn.maxToolCalls) ||
        Number(turn.compactions) > Number(turn.maxCompactions)
      )
        fail("live-inference-turn");
      for (const key of ["requestedOutputTokens", "outputTokens"] as const) {
        if (turn[key] !== undefined && (!Number.isSafeInteger(turn[key]) || Number(turn[key]) < 0))
          fail("live-inference-turn");
      }
      // Output authority is recorded only where it bound the turn: a clamp
      // requests exactly the remainder, an exhaustion had less than the floor.
      if (turn.outputAuthority !== undefined || turn.reason === "output-authority-exhausted") {
        const authority = object(turn.outputAuthority, "live-inference-turn");
        exact(authority, ["maxOutputTokens", "cumulativeOutputTokens", "floorOutputTokens"]);
        const maxOutputTokens = Number(authority.maxOutputTokens);
        const cumulativeOutputTokens = Number(authority.cumulativeOutputTokens);
        const floorOutputTokens = Number(authority.floorOutputTokens);
        const remaining = maxOutputTokens - cumulativeOutputTokens;
        if (
          !Number.isSafeInteger(authority.maxOutputTokens) ||
          maxOutputTokens < 1 ||
          !Number.isSafeInteger(authority.cumulativeOutputTokens) ||
          cumulativeOutputTokens < 0 ||
          !Number.isSafeInteger(authority.floorOutputTokens) ||
          floorOutputTokens <= Number(turn.requiredMinimumOutputTokens) ||
          remaining >= Number(turn.effectiveMaxOutputTokens) ||
          (turn.decision === "stop"
            ? turn.reason === "output-authority-exhausted" && remaining >= floorOutputTokens
            : remaining < floorOutputTokens || turn.requestedOutputTokens !== remaining)
        ) {
          fail("live-inference-turn");
        }
      }
      // Bounded in-turn provider retries replay a finalized payload, so the
      // count is positive and only meaningful on a turn that was actually sent.
      if (
        turn.providerRetries !== undefined &&
        (!Number.isSafeInteger(turn.providerRetries) ||
          Number(turn.providerRetries) < 1 ||
          turn.finalPayloadSha256 === undefined)
      ) {
        fail("live-inference-turn");
      }
      // Empty provider turns are counted on the same sent payload, and all but
      // the last one were replaced by a replay.
      if (
        turn.providerBlankTurns !== undefined &&
        (!Number.isSafeInteger(turn.providerBlankTurns) ||
          Number(turn.providerBlankTurns) < 1 ||
          turn.finalPayloadSha256 === undefined ||
          Number(turn.providerBlankTurns) > Number(turn.providerRetries ?? 0) + 1)
      ) {
        fail("live-inference-turn");
      }
      // Closed tokens only; the structural evaluator checks how they relate.
      if (
        (turn.providerReplayVeto !== undefined &&
          !isProviderTurnReplayVeto(turn.providerReplayVeto)) ||
        (turn.requestPolicyRefusal !== undefined &&
          !isRequestPolicyRefusal(turn.requestPolicyRefusal)) ||
        (turn.replayedReasoningOmitted !== undefined &&
          (!Number.isSafeInteger(turn.replayedReasoningOmitted) ||
            Number(turn.replayedReasoningOmitted) < 1 ||
            turn.finalPayloadSha256 === undefined))
      ) {
        fail("live-inference-turn");
      }
      if (turn.compaction !== undefined) {
        const compaction = object(turn.compaction, "live-inference-compaction");
        exact(compaction, [
          "beforeRequestDigest",
          "afterRequestDigest",
          "estimatedInputTokensBefore",
          "estimatedInputTokensAfter",
          "removedMessages",
          "retainedMessages",
          "preservedCitationCount",
          "preservedCitationDigest",
        ]);
        for (const key of [
          "beforeRequestDigest",
          "afterRequestDigest",
          "preservedCitationDigest",
        ] as const) {
          if (typeof compaction[key] !== "string" || !SHA256.test(compaction[key])) {
            fail("live-inference-compaction");
          }
        }
        for (const key of [
          "estimatedInputTokensBefore",
          "estimatedInputTokensAfter",
          "removedMessages",
          "retainedMessages",
          "preservedCitationCount",
        ] as const) {
          if (!Number.isSafeInteger(compaction[key]) || Number(compaction[key]) < 0) {
            fail("live-inference-compaction");
          }
        }
      }
    }
  }
  // Every recorded retry rule must be the one the shared decider derives.
  if (
    !inferenceAttemptRulesConsistent(
      inference as unknown as RetryRuleExecution,
      inference.attempts as unknown as Parameters<typeof inferenceAttemptRulesConsistent>[1],
    )
  ) {
    fail("live-inference-attempt");
  }
}

function assertCompleteArtifactUses(
  actual: ArtifactUse[],
  stepId: string,
  expected: Array<{ role: ArtifactUse["role"]; artifact: Artifact }>,
): void {
  const normalized = expected.map(({ role, artifact }) => ({
    role,
    stepId,
    reference: {
      kind: artifact.kind,
      schemaVersion: artifact.schemaVersion,
      digest: artifact.digest,
      repositoryRevision: artifact.repository.revision,
      repositoryContentDigest: artifact.repository.contentDigest,
    },
  }));
  if (canonicalDigest(actual) !== canonicalDigest(normalized)) fail("live-artifact-uses");
}

const CORPUS_LIVE_UNVERIFIED = "unverified" as const;

/** Field policy of the live corpus reader (IA planning and provider records). */
export const CORPUS_LIVE_RUN_READER = defineRunRecordReader({
  reader: "corpus-live",
  workflows: ["ia-plan", "ia-analysis"],
  statuses: ["succeeded"],
  fields: {
    schemaVersion: "decoded",
    id: "decoded",
    workflow: "admitted",
    repository: "decoded",
    workspace: "decoded",
    instruction: "admitted",
    retryContext: CORPUS_LIVE_UNVERIFIED,
    operatorTargetPaths: "admitted",
    instructionContext: CORPUS_LIVE_UNVERIFIED,
    // Only create and update records bind sources; this reader reads neither.
    retainedEvidenceBindings: CORPUS_LIVE_UNVERIFIED,
    readerEvidenceRequest: CORPUS_LIVE_UNVERIFIED,
    // Only create and update records bind a change; this reader reads neither.
    changeSources: CORPUS_LIVE_UNVERIFIED,
    reviewDeliverySnapshot: "producer-not-admitted",
    changeSourceRelease: CORPUS_LIVE_UNVERIFIED,
    task: "admitted",
    taskLineage: CORPUS_LIVE_UNVERIFIED,
    compositionExecution: "decoded",
    answerRecordDiscovery: CORPUS_LIVE_UNVERIFIED,
    compositionExecutionAggregate: "decoded",
    modelSettings: "admitted",
    knowledgeResumeReceipt: CORPUS_LIVE_UNVERIFIED,
    knowledgeContinuationReceipt: CORPUS_LIVE_UNVERIFIED,
    knowledgeContinuationRecoveryAuthorization: CORPUS_LIVE_UNVERIFIED,
    knowledgeContinuationSnapshotSha256: CORPUS_LIVE_UNVERIFIED,
    knowledgeContinuationAcceptanceSha256: CORPUS_LIVE_UNVERIFIED,
    answerRecordContinuation: CORPUS_LIVE_UNVERIFIED,
    status: "decoded",
    checkoutPersistence: "decoded",
    workflowOutcome: "decoded",
    workflowBranchCoverage: CORPUS_LIVE_UNVERIFIED,
    authoringExecution: CORPUS_LIVE_UNVERIFIED,
    releaseDocumentationReadiness: "producer-not-admitted",
    workUnitMachineContracts: "producer-not-admitted",
    error: "admitted",
    failure: "failed-run-only",
    workflowOutcomeRejection: "failed-run-only",
    authoringCandidateRejection: "failed-run-only",
    editorialFinalizationRejection: "failed-run-only",
    createdAt: "decoded",
    startedAt: "decoded",
    completedAt: "decoded",
    durationMs: "decoded",
    models: "decoded",
    skills: "decoded",
    qualityPack: CORPUS_LIVE_UNVERIFIED,
    qualityProfileSelection: "producer-not-admitted",
    qualityArtifactValidation: "producer-not-admitted",
    usage: "decoded",
    tools: "decoded",
    artifacts: "admitted",
    searchFindings: CORPUS_LIVE_UNVERIFIED,
    negativeEvidence: CORPUS_LIVE_UNVERIFIED,
    gapLedger: CORPUS_LIVE_UNVERIFIED,
    securityScan: "decoded",
    securityScanEffectiveDisposition: "decoded",
    securityScanAuthorization: "admitted",
    // A read-only run's change evidence is exactly `{ files: [] }`, checked below.
    changes: "decoded",
    impactPostflight: "admitted",
    reviewScope: "producer-not-admitted",
    prReviewBasis: "producer-not-admitted",
    requestIntent: "decoded",
    // Written only on a needs-input run, which this reader never admits.
    firstPassContradiction: CORPUS_LIVE_UNVERIFIED,
    firstPassContradictionAdmission: CORPUS_LIVE_UNVERIFIED,
    firstPassReplay: CORPUS_LIVE_UNVERIFIED,
    firstPassChoices: CORPUS_LIVE_UNVERIFIED,
    liveAgentTurn: "producer-not-admitted",
    liveAgentTurnFailure: "producer-not-admitted",
    // Optional per-run citation evidence.
    sourceCitations: "admitted",
    prReviewSourceCitations: "producer-not-admitted",
    // Content-free findings (#1807): locations and rule ids only.
    credentialFindings: "admitted",
    evidenceWarnings: "admitted",
    steps: "decoded",
  },
});

/** The closed key list `CORPUS_LIVE_RUN_READER` derives. */
export const CORPUS_LIVE_RUN_KEYS: readonly string[] = CORPUS_LIVE_RUN_READER.admittedKeys;

const CORPUS_LIVE_REQUIRED_RUN_KEYS: readonly string[] = Object.freeze([
  "schemaVersion",
  "id",
  "workflow",
  "repository",
  "workspace",
  "status",
  "createdAt",
  "models",
  "skills",
  "usage",
  "tools",
  "steps",
]);

function runRecord(value: unknown, code: string): RunRecord {
  const root = object(value, `live-${code}-record`);
  exact(root, [...CORPUS_LIVE_RUN_KEYS], [...CORPUS_LIVE_REQUIRED_RUN_KEYS]);
  if (root.checkoutPersistence !== undefined) {
    try {
      decodeCheckoutPersistenceOutcome(root.checkoutPersistence);
    } catch {
      fail(`live-${code}-record`);
    }
  }
  if (
    root.schemaVersion !== 2 ||
    typeof root.id !== "string" ||
    !root.id ||
    !Array.isArray(root.models) ||
    !Array.isArray(root.skills) ||
    !Array.isArray(root.steps)
  ) {
    fail(`live-${code}-record`);
  }
  const repository = object(root.repository, `live-${code}-repository`);
  exact(repository, ["sourcePath", "requestedRevision", "revision"]);
  if (
    typeof repository.sourcePath !== "string" ||
    typeof repository.requestedRevision !== "string" ||
    typeof repository.revision !== "string" ||
    !GIT_REVISION.test(repository.revision)
  ) {
    fail(`live-${code}-repository`);
  }
  const workspace = object(root.workspace, `live-${code}-workspace`);
  exact(workspace, ["strategy", "disposable"]);
  if (workspace.strategy !== "tracked-export" || workspace.disposable !== true) {
    fail(`live-${code}-workspace`);
  }
  if (
    root.status !== "succeeded" ||
    typeof root.createdAt !== "string" ||
    typeof root.startedAt !== "string" ||
    typeof root.completedAt !== "string" ||
    !Number.isSafeInteger(root.durationMs) ||
    Number(root.durationMs) < 0 ||
    root.instruction !== undefined ||
    root.error !== undefined ||
    (root.changes !== undefined && !isReadOnlyRunChanges(root.changes)) ||
    root.impactPostflight !== undefined ||
    root.evidenceWarnings !== undefined ||
    root.securityScanAuthorization !== undefined
  ) {
    fail(`live-${code}-terminal`);
  }
  timestamp(root.createdAt);
  timestamp(root.startedAt);
  timestamp(root.completedAt);
  if (
    Date.parse(root.createdAt) > Date.parse(root.startedAt) ||
    Date.parse(root.startedAt) > Date.parse(root.completedAt) ||
    root.durationMs !== Date.parse(root.completedAt) - Date.parse(root.startedAt)
  ) {
    fail(`live-${code}-timeline`);
  }
  assertAdvisorySecurity(root.securityScan, root.securityScanEffectiveDisposition);
  if (detectCredentialRuleIds(JSON.stringify(value)).length > 0) fail(`live-${code}-credential`);
  const record = structuredClone(value) as RunRecord;
  try {
    if (!CORPUS_LIVE_RUN_READER.workflows.includes(record.workflow as WorkflowName)) {
      throw new Error("Live corpus record names a workflow this reader does not admit.");
    }
    verifyRunRecordComposition(record, getWorkflow(record.workflow as WorkflowName));
    if (record.requestIntent !== undefined) {
      decodeRunRecordRequestIntent(record.requestIntent, record.instruction);
    }
  } catch (error) {
    // Keep a composition binding's named refusal under this record's prefix.
    fail(
      error instanceof RunRecordCompositionError
        ? `live-${code}-${error.code}`
        : `live-${code}-composition`,
    );
  }
  if (record.workflowOutcome !== undefined) {
    try {
      record.workflowOutcome = decodeWorkflowOutcome(record.workflowOutcome, record);
    } catch {
      fail(`live-${code}-outcome`);
    }
  }
  for (const model of record.models) assertModelEvidence(model);
  for (const skill of record.skills) assertSkillEvidence(skill);
  parseUsage(record.usage);
  toolNames(record.tools);
  if (code === "planning" || code === "provider") {
    const task = object(root.task, "live-planning-task");
    exact(task, ["kind", "scope", "mode", "target"], ["kind", "scope", "mode"]);
    if (
      task.kind !== "ia-plan" ||
      !["site", "section", "page"].includes(String(task.scope)) ||
      !["create", "reevaluate"].includes(String(task.mode)) ||
      (task.scope === "site") === (task.target !== undefined)
    )
      fail("live-planning-task");
    if (task.target !== undefined) assertTaskTarget(task.target);
    if (
      code === "planning" &&
      (record.models.length !== 0 ||
        record.skills.length !== 0 ||
        !emptyUsage(record.usage) ||
        !emptyTools(record.tools))
    )
      fail("live-planning-aggregation");
  }
  return record;
}

function assertTaskTarget(value: unknown): void {
  const target = object(value, "live-task-target");
  exact(target, ["sourcePath", "anchor", "candidateParentNodeId"], ["sourcePath"]);
  if (
    typeof target.sourcePath !== "string" ||
    !target.sourcePath ||
    target.sourcePath.includes("\\") ||
    target.sourcePath.startsWith("/") ||
    target.sourcePath.split("/").some((part) => !part || part === "." || part === "..") ||
    (target.anchor !== undefined && (typeof target.anchor !== "string" || !target.anchor)) ||
    (target.candidateParentNodeId !== undefined &&
      (typeof target.candidateParentNodeId !== "string" || !target.candidateParentNodeId))
  ) {
    fail("live-task-target");
  }
}

function assertAdvisorySecurity(reportValue: unknown, dispositionValue: unknown): void {
  // The whole-repository scan is advisory: a self-run over DocsFab's own
  // credential fixtures reports blocked findings, which must not disqualify
  // the record. Validate the content-free shape and the advisory disposition.
  const report = object(reportValue, "live-security-scan");
  exact(report, ["ruleSet", "status", "scannedFiles", "binaryFiles", "findings"]);
  const disposition = object(dispositionValue, "live-security-disposition");
  exact(disposition, ["status"]);
  if (
    typeof report.ruleSet !== "string" ||
    !report.ruleSet ||
    !["passed", "blocked", "failed"].includes(String(report.status)) ||
    !Number.isSafeInteger(report.scannedFiles) ||
    Number(report.scannedFiles) < 0 ||
    !Number.isSafeInteger(report.binaryFiles) ||
    Number(report.binaryFiles) < 0 ||
    !Array.isArray(report.findings) ||
    (report.status === "passed") !== (report.findings.length === 0) ||
    disposition.status !== "advisory"
  )
    fail("live-security-scan");
}

// Refuses only an unset or empty variable; a configured value that differs
// from the record is the live-skill-source mismatch, not this refusal.
function pinnedSkillSourceRepository(): string {
  const repository = process.env[CORPUS_SKILL_SOURCE_REPOSITORY_ENV];
  if (!repository) {
    throw new Error(
      `Living-documentation raw evidence rejected (live-skill-source-unconfigured): set ${CORPUS_SKILL_SOURCE_REPOSITORY_ENV} to the Git URL the pinned tpl-design-ia skill was recorded from.`,
    );
  }
  return repository;
}

function assertModelEvidence(value: unknown): asserts value is ModelEvidence {
  const model = object(value, "live-model");
  exact(model, ["provider", "model", "profile"], ["provider", "model", "profile"]);
  if (!validModelEvidenceProjection(value as ModelEvidence)) fail("live-model");
}

function assertSkillEvidence(value: unknown): asserts value is SkillEvidence {
  const skill = object(value, "live-skill");
  exact(skill, [
    "id",
    "contentSha256",
    "bundleSha256",
    "version",
    "license",
    "provenanceStatus",
    "source",
    "inputs",
    "outputs",
    "toolPolicy",
    "evaluation",
  ]);
  if (
    skill.id !== "tpl-design-ia" ||
    skill.contentSha256 !== TPL_SKILL_CONTENT_SHA256 ||
    skill.bundleSha256 !== TPL_SKILL_BUNDLE_SHA256 ||
    skill.version !== "0.1.0-local.1" ||
    skill.license !== "UNLICENSED" ||
    skill.provenanceStatus !== "docsfab-local"
  ) {
    fail("live-skill");
  }
  const source = object(skill.source, "live-skill-source");
  exact(source, ["repository", "revision", "path"]);
  if (
    source.repository !== pinnedSkillSourceRepository() ||
    source.revision !== TPL_SKILL_SOURCE_REVISION ||
    source.path !== "skills/tpl-design-ia/SKILL.md"
  )
    fail("live-skill-source");
  for (const [name, fields] of [
    ["inputs", skill.inputs],
    ["outputs", skill.outputs],
  ] as const) {
    if (!Array.isArray(fields)) fail(`live-skill-${name}`);
    for (const fieldValue of fields) {
      const field = object(fieldValue, `live-skill-${name}`);
      exact(field, ["name", "description"]);
      if (
        typeof field.name !== "string" ||
        !field.name ||
        typeof field.description !== "string" ||
        !field.description
      )
        fail(`live-skill-${name}`);
    }
  }
  const inputs = skill.inputs as NonNullable<SkillEvidence["inputs"]>;
  const outputs = skill.outputs as NonNullable<SkillEvidence["outputs"]>;
  if (
    canonicalDigest(inputs.map((field) => field.name)) !==
      canonicalDigest([
        "scope",
        "mode",
        "repository_index",
        "target_node_id",
        "prior_decisions",
        "navigation_queries",
      ]) ||
    canonicalDigest(outputs.map((field) => field.name)) !== canonicalDigest(["analysis_submission"])
  )
    fail("live-skill-interface");
  if (skill.toolPolicy !== undefined) {
    const policy = object(skill.toolPolicy, "live-skill-tools");
    exact(policy, ["declared", "granted", "withheld"]);
    for (const key of ["declared", "granted", "withheld"] as const) {
      if (
        !Array.isArray(policy[key]) ||
        policy[key].some((item) => typeof item !== "string" || !item)
      ) {
        fail("live-skill-tools");
      }
    }
  }
  const toolPolicy = skill.toolPolicy as {
    declared: string[];
    granted: string[];
    withheld: string[];
  };
  if (
    canonicalDigest(toolPolicy.declared) !== canonicalDigest(["Read", "Grep", "Glob"]) ||
    canonicalDigest(toolPolicy.granted) !== canonicalDigest(["read", "grep", "find", "ls"]) ||
    toolPolicy.withheld.length !== 0
  )
    fail("live-skill-tools");
  const evaluation = object(skill.evaluation, "live-skill-evaluation");
  exact(evaluation, ["id", "version", "path", "sha256"]);
  if (
    evaluation.id !== "tpl-design-ia.behavior" ||
    evaluation.version !== 1 ||
    evaluation.path !== "evaluations/manifest.json" ||
    evaluation.sha256 !== TPL_SKILL_EVALUATION_SHA256
  ) {
    fail("live-skill-evaluation");
  }
}

function parseContentIndex(value: unknown, corpusCase: CorpusCase): ContentIndexV1 {
  const root = object(value, "live-content-index");
  exact(root, ["schemaVersion", "repository", "indexDigest", "nodes", "edges", "evidence"]);
  const repository = object(root.repository, "live-index-repository");
  exact(repository, ["revision", "contentDigest"]);
  if (
    root.schemaVersion !== 1 ||
    typeof repository.revision !== "string" ||
    !GIT_REVISION.test(repository.revision) ||
    repository.contentDigest !== corpusCase.repository.contentDigest ||
    !Array.isArray(root.nodes) ||
    !Array.isArray(root.edges) ||
    typeof root.indexDigest !== "string" ||
    !SHA256.test(root.indexDigest)
  )
    fail("live-content-index");
  const expectedDigest = canonicalDigest({
    schemaVersion: 1,
    repository,
    nodes: root.nodes,
    edges: root.edges,
  });
  if (root.indexDigest !== expectedDigest) fail("live-content-index-digest");
  const evidence = object(root.evidence, "live-index-evidence");
  exact(evidence, [
    "repositoryRevision",
    "contentDigest",
    "indexDigest",
    "documentCount",
    "sectionCount",
    "edgeCount",
  ]);
  const nodes = root.nodes as ContentNode[];
  if (
    evidence.repositoryRevision !== repository.revision ||
    evidence.contentDigest !== repository.contentDigest ||
    evidence.indexDigest !== root.indexDigest ||
    evidence.documentCount !== nodes.filter((item) => item.kind === "document").length ||
    evidence.sectionCount !== nodes.filter((item) => item.kind === "section").length ||
    evidence.edgeCount !== root.edges.length
  )
    fail("live-index-evidence");
  const allowedPaths = new Set(corpusCase.sources.map((source) => source.path));
  if (nodes.some((node) => !allowedPaths.has(node.sourcePath))) fail("live-index-source-scope");
  return structuredClone(value) as ContentIndexV1;
}

function corpusAliasMap(corpusCase: CorpusCase, nodes: ContentNode[]): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  for (const [nodeId, location] of Object.entries(corpusCase.publicNodeLocations)) {
    const matched = nodes.filter(
      (node) =>
        node.sourcePath === location.path &&
        (nodeId.startsWith("document:")
          ? node.kind === "document"
          : node.kind === "section" && node.anchor === location.anchor),
    );
    if (matched.length !== 1) fail("live-node-location");
    const existing = aliases.get(matched[0]!.id) ?? [];
    aliases.set(matched[0]!.id, [...existing, nodeId]);
  }
  return aliases;
}

function assertNavigationSuiteBinding(
  corpusCase: CorpusCase,
  navigation: NavigationEvaluationArtifact,
): void {
  if (
    new Set(navigation.payload.tasks.map((task) => task.id)).size !==
    navigation.payload.tasks.length
  ) {
    fail("live-navigation-task-coverage");
  }
  for (const answer of corpusCase.knownAnswers) {
    const tasks = navigation.payload.tasks.filter((item) => item.id === answer.id);
    if (tasks.length !== 1 || tasks[0]!.query !== answer.query) {
      fail("live-navigation-task-binding");
    }
  }
}

function observedDestination(
  corpusCase: CorpusCase,
  nodes: ContentNode[],
  aliases: Map<string, string[]>,
  indexNodeId: string,
): CorpusDestination {
  const node = nodes.find((item) => item.id === indexNodeId);
  if (!node) fail("live-navigation-node");
  const semanticIds = aliases.get(indexNodeId) ?? [];
  if (semanticIds.length > 1) fail("live-navigation-node-ambiguous");
  const semanticId = semanticIds[0];
  if (semanticId) {
    const canonical = corpusCase.knownAnswers
      .flatMap((answer) => [
        ...answer.expected,
        ...answer.acceptableAlternatives,
        ...answer.negativeExpectations,
      ])
      .find(
        (item) =>
          item.nodeId === semanticId &&
          item.path === node.sourcePath &&
          item.anchor === (node.kind === "section" ? node.anchor : null),
      );
    if (canonical) return structuredClone(canonical);
    const location = corpusCase.publicNodeLocations[semanticId]!;
    return {
      nodeId: semanticId,
      path: location.path,
      url: `/${location.path.replace(/\.(?:md|mdx)$/iu, "")}`,
      anchor: location.anchor,
    };
  }
  return {
    nodeId: `unscored:${indexNodeId}`,
    path: node.sourcePath,
    url: `/${node.sourcePath.replace(/\.(?:md|mdx)$/iu, "")}`,
    anchor: node.kind === "section" ? node.anchor : null,
  };
}

function destinationFor(corpusCase: CorpusCase, nodeId: string): CorpusDestination[] {
  return corpusCase.knownAnswers
    .flatMap((answer) => [...answer.expected, ...answer.acceptableAlternatives])
    .filter((item) => item.nodeId === nodeId)
    .slice(0, 1)
    .map((item) => structuredClone(item));
}

function assertArtifactReference(reference: ArtifactReference, artifact: Artifact): void {
  if (
    !sameReference(reference, {
      kind: artifact.kind,
      schemaVersion: artifact.schemaVersion,
      digest: artifact.digest,
      repositoryRevision: artifact.repository.revision,
      repositoryContentDigest: artifact.repository.contentDigest,
    })
  )
    fail("live-artifact-reference");
}

function sameReference(left: ArtifactReference, right: ArtifactReference): boolean {
  return canonicalDigest(left) === canonicalDigest(right);
}

function artifactUses(value: unknown): ArtifactUse[] {
  if (!Array.isArray(value)) fail("live-artifact-uses");
  return value.map((item) => validateArtifactUse(item));
}

function readyContextEvidence(value: unknown): {
  packetDigest: string;
  consultedNodeIds: string[];
} {
  const root = object(value, "live-context-preflight");
  // A packet trimmed to its budget is still the step's packet; its record also
  // names the budget (`limit`) and any requested page the trim left out.
  exact(
    root,
    [
      "status",
      "packetDigest",
      "consultedNodeIds",
      "ontologyVersion",
      "effectiveDecisionIds",
      "measurements",
      "cache",
      "reason",
      "limit",
      "unboundTargets",
      "unboundTargetsOmitted",
    ],
    ["status", "packetDigest", "consultedNodeIds"],
  );
  if (
    (root.status !== "ready" && root.status !== "degraded") ||
    typeof root.packetDigest !== "string" ||
    !SHA256.test(root.packetDigest) ||
    !Array.isArray(root.consultedNodeIds) ||
    root.consultedNodeIds.length === 0 ||
    root.consultedNodeIds.some((item) => typeof item !== "string" || !item) ||
    new Set(root.consultedNodeIds).size !== root.consultedNodeIds.length
  ) {
    fail("live-context-preflight");
  }
  if (root.measurements !== undefined) {
    const measurements = object(root.measurements, "live-context-measurements");
    exact(
      measurements,
      ["byteLength", "estimatedTokens", "latencyMs", "nodeCount", "edgeCount", "pathCount"],
      ["byteLength", "estimatedTokens", "latencyMs"],
    );
    for (const key of Object.keys(measurements)) {
      if (!Number.isSafeInteger(measurements[key]) || Number(measurements[key]) < 0) {
        fail("live-context-measurements");
      }
    }
  }
  if (root.cache !== undefined) {
    const cache = object(root.cache, "live-context-cache");
    exact(
      cache,
      ["disposition", "keyDigest", "rebuildAttempted"],
      ["disposition", "rebuildAttempted"],
    );
    if (
      !["disabled", "hit", "miss", "rejected"].includes(String(cache.disposition)) ||
      typeof cache.rebuildAttempted !== "boolean" ||
      (cache.keyDigest !== undefined &&
        (typeof cache.keyDigest !== "string" || !SHA256.test(cache.keyDigest)))
    ) {
      fail("live-context-cache");
    }
  }
  return {
    packetDigest: root.packetDigest,
    consultedNodeIds: [...root.consultedNodeIds] as string[],
  };
}

function timestamp(value: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) fail("live-timestamp");
}
