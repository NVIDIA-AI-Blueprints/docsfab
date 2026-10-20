// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import { CONFIGURABLE_RETRY_CATEGORIES } from "../inference-attempt-taxonomy.js";
import type { RunRecord } from "../records/contracts.js";
import { TOOL_FAILURE_DISPOSITIONS } from "../records/contracts.js";
import {
  inferenceAttemptBudgetPositions,
  inferenceAttemptsWithinBudgets,
  isInferenceTransportRetryEvidence,
  isRecordedInferenceRetryBackoff,
} from "../records/inference-retry-disposition.js";
import {
  inferenceAttemptRulesConsistent,
  isInferenceConditionRetryEvidence,
} from "../records/inference-retry-rule.js";
import {
  admittedInferenceReplays,
  effectiveInferenceRetryCategories,
  replayKeepsConfiguredBudget,
} from "../records/inference-replay.js";
import type { WorkflowName } from "../workflow-contracts/contracts.js";
import { isWorkflowName } from "../workflow-registry/catalog.js";
import type {
  AssertionResult,
  EvaluationFixture,
  EvaluationJudge,
  EvaluationRubric,
  EvaluationResult,
  StructuralAssertion,
  StructuralEvaluation,
} from "./contracts.js";
import { buildSemanticEvidence, SEMANTIC_RUBRIC_V1 } from "./semantic.js";
import {
  decodeWorkflowOutcome,
  type WorkflowOutcomeDecodeOptionsV1,
} from "../workflow-contracts/outcome.js";
import { grantedTurnOutputTokens, producedTurnOutputTokenLimit } from "../model/context-budget.js";
import { isAdmissibleRequestPolicyRefusal } from "../model/request-policy-refusals.js";

/** Accepted evaluation workflows are the catalog, not a restated allowlist. */
export function isAcceptedEvaluationWorkflow(value: unknown): value is WorkflowName {
  return typeof value === "string" && isWorkflowName(value);
}

const turnDecisions = new Set(["proceed", "compact", "stop"]);
const turnReasons = new Set([
  "context-exhausted",
  "provider-turn-limit",
  "tool-call-limit",
  "compaction-limit",
  "compaction-ineffective",
  "evidence-preservation-required",
  "output-authority-exhausted",
]);
const attemptOutcomes = new Set([
  "succeeded",
  "blank-response",
  "malformed-response",
  "context-exhausted",
  "timeout",
  "throttled",
  "provider-transient",
  "invalid-request",
  "provider-terminal",
  "host-runtime-failure",
  "no-progress",
]);
// The taxonomy's own set, so a category a policy may list is listed once.
const configurableRetryOutcomes = new Set<string>(CONFIGURABLE_RETRY_CATEGORIES);
/** Exported so the closed set is assertable; see `outcome.ts` for the reason. */
export const toolFailureDispositions: ReadonlySet<string> = new Set(TOOL_FAILURE_DISPOSITIONS);

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function parseAssertion(value: unknown, index: number): StructuralAssertion {
  const assertion = object(value, `assertions[${index}]`);
  const type = assertion.type;
  if (type === "run-count") {
    if (!Number.isSafeInteger(assertion.minimum) || Number(assertion.minimum) <= 0) {
      throw new Error(`assertions[${index}].minimum must be a positive integer.`);
    }
    return { type, minimum: Number(assertion.minimum) };
  }
  if (type === "status") {
    if (assertion.equals !== "succeeded" && assertion.equals !== "failed") {
      throw new Error(`assertions[${index}].equals must be succeeded or failed.`);
    }
    return { type, equals: assertion.equals };
  }
  if (type === "workflow") {
    if (!isAcceptedEvaluationWorkflow(assertion.equals)) {
      throw new Error(`assertions[${index}].equals is not a known workflow.`);
    }
    return { type, equals: assertion.equals };
  }
  if (
    type === "all-steps-succeeded" ||
    type === "summaries-present" ||
    type === "governed-skill-evidence" ||
    type === "turn-governance-evidence" ||
    type === "evidence-identity-consistent" ||
    type === "governed-terminal-status" ||
    type === "record-shape-consistent"
  ) {
    return { type };
  }
  if (type === "step-skills") {
    if (
      !Array.isArray(assertion.equals) ||
      assertion.equals.some((item) => typeof item !== "string")
    ) {
      throw new Error(`assertions[${index}].equals must be an array of skill names.`);
    }
    return { type, equals: assertion.equals as string[] };
  }
  if (type === "allowed-tools" || type === "required-tools" || type === "forbidden-tools") {
    if (
      !Array.isArray(assertion.tools) ||
      assertion.tools.some((item) => typeof item !== "string" || !item.trim())
    ) {
      throw new Error(`assertions[${index}].tools must be an array of non-empty tool names.`);
    }
    return { type, tools: assertion.tools as string[] };
  }
  throw new Error(`assertions[${index}].type is not supported.`);
}

export function parseEvaluationFixture(value: unknown): EvaluationFixture {
  const fixture = object(value, "fixture");
  if (fixture.version !== 1) throw new Error("fixture.version must be 1.");
  if (typeof fixture.name !== "string" || !fixture.name.trim()) {
    throw new Error("fixture.name must be a non-empty string.");
  }
  if (!Array.isArray(fixture.assertions) || fixture.assertions.length === 0) {
    throw new Error("fixture.assertions must be a non-empty array.");
  }
  return {
    version: 1,
    name: fixture.name,
    assertions: fixture.assertions.map(parseAssertion),
  };
}

export async function loadEvaluationFixture(path: string): Promise<EvaluationFixture> {
  return parseEvaluationFixture(JSON.parse(await readFile(path, "utf8")) as unknown);
}

export interface LoadEvaluationRunRecordOptions {
  resolveWorkflowOutcomeDecodeOptions?: (
    record: RunRecord,
  ) => Promise<WorkflowOutcomeDecodeOptionsV1 | undefined>;
}

export type EvaluationWorkflowOutcomeDecodeOptions = (
  record: RunRecord,
) => WorkflowOutcomeDecodeOptionsV1 | undefined;

export async function loadRunRecord(
  path: string,
  options: LoadEvaluationRunRecordOptions = {},
): Promise<RunRecord> {
  const value = object(JSON.parse(await readFile(path, "utf8")) as unknown, "run record");
  if (
    value.schemaVersion !== 2 ||
    typeof value.id !== "string" ||
    !isAcceptedEvaluationWorkflow(value.workflow) ||
    !value.repository ||
    typeof value.repository !== "object" ||
    !Array.isArray(value.steps)
  ) {
    throw new Error(`${path} is not a valid DocsFab run record.`);
  }
  const record = value as unknown as RunRecord;
  if (record.workflowOutcome !== undefined) {
    try {
      const decodeOptions = await options.resolveWorkflowOutcomeDecodeOptions?.(record);
      record.workflowOutcome = decodeWorkflowOutcome(record.workflowOutcome, record, decodeOptions);
    } catch {
      throw new Error(`${path} has an invalid DocsFab workflow outcome.`);
    }
  }
  return record;
}

function evaluateEachRecord(
  assertion: Exclude<
    StructuralAssertion,
    | { type: "run-count" }
    | { type: "record-shape-consistent" }
    | { type: "evidence-identity-consistent" }
  >,
  record: RunRecord,
): AssertionResult {
  if (assertion.type === "status") {
    const passed = record.status === assertion.equals;
    return {
      assertion,
      recordId: record.id,
      passed,
      message: passed
        ? `status is ${assertion.equals}`
        : `expected ${assertion.equals}, got ${record.status}`,
    };
  }
  if (assertion.type === "workflow") {
    const passed = record.workflow === assertion.equals;
    return {
      assertion,
      recordId: record.id,
      passed,
      message: passed
        ? `workflow is ${assertion.equals}`
        : `expected ${assertion.equals}, got ${record.workflow}`,
    };
  }
  if (assertion.type === "all-steps-succeeded") {
    const failed = record.steps
      .filter((step) => step.status !== "succeeded")
      .map((step) => step.id);
    return {
      assertion,
      recordId: record.id,
      passed: failed.length === 0 && record.steps.length > 0,
      message:
        failed.length === 0 && record.steps.length > 0
          ? "all steps succeeded"
          : `non-succeeded steps: ${failed.join(", ") || "record has no steps"}`,
    };
  }
  if (assertion.type === "summaries-present") {
    const missing = record.steps.filter((step) => !step.summary?.trim()).map((step) => step.id);
    return {
      assertion,
      recordId: record.id,
      passed: missing.length === 0 && record.steps.length > 0,
      message:
        missing.length === 0 && record.steps.length > 0
          ? "all step summaries are present"
          : `missing summaries: ${missing.join(", ") || "record has no steps"}`,
    };
  }
  if (assertion.type === "governed-skill-evidence") {
    const incomplete = record.skills.filter(
      (skill) =>
        !skill.source ||
        !skill.version ||
        !skill.license ||
        !skill.bundleSha256 ||
        !skill.inputs ||
        !skill.outputs ||
        !skill.toolPolicy ||
        !/^[a-f0-9]{64}$/.test(skill.contentSha256) ||
        !/^[a-f0-9]{64}$/.test(skill.bundleSha256),
    );
    const stepEvidence = record.steps
      .filter((step) => step.status !== "pending")
      .filter((step) => !step.skillEvidence);
    const passed = record.skills.length > 0 && incomplete.length === 0 && stepEvidence.length === 0;
    return {
      assertion,
      recordId: record.id,
      passed,
      message: passed
        ? "governed skill provenance is complete"
        : `incomplete governed evidence: ${
            [...incomplete.map((skill) => skill.id), ...stepEvidence.map((step) => step.id)].join(
              ", ",
            ) || "record has no governed skills"
          }`,
    };
  }
  if (assertion.type === "turn-governance-evidence") {
    const failures = validateTurnGovernance(record);
    return {
      assertion,
      recordId: record.id,
      passed: failures.length === 0,
      message:
        failures.length === 0
          ? "provider turns are locally governed and revision-bound"
          : `invalid turn governance: ${failures.join(", ")}`,
    };
  }
  if (assertion.type === "governed-terminal-status") {
    const failures = validateGovernedTerminalStatus(record);
    return {
      assertion,
      recordId: record.id,
      passed: failures.length === 0,
      message:
        failures.length === 0
          ? record.status === "succeeded"
            ? "run and all steps succeeded"
            : "run stopped at an explained terminal context boundary"
          : `invalid governed terminal status: ${failures.join(", ")}`,
    };
  }
  if (
    assertion.type === "allowed-tools" ||
    assertion.type === "required-tools" ||
    assertion.type === "forbidden-tools"
  ) {
    const toolEvidence = validateToolEvidence(record);
    const observed = toolEvidence.observed;
    const policy = new Set(assertion.tools);
    const violations =
      assertion.type === "allowed-tools"
        ? [...observed].filter((tool) => !policy.has(tool))
        : assertion.type === "required-tools"
          ? assertion.tools.filter((tool) => !observed.has(tool))
          : assertion.tools.filter((tool) => observed.has(tool));
    const passed = violations.length === 0 && toolEvidence.failures.length === 0;
    const label =
      assertion.type === "allowed-tools"
        ? "disallowed tools"
        : assertion.type === "required-tools"
          ? "missing required tools"
          : "forbidden tools used";
    return {
      assertion,
      recordId: record.id,
      passed,
      message: passed
        ? `${assertion.type} policy satisfied`
        : [
            ...(violations.length > 0 ? [`${label}: ${violations.join(", ")}`] : []),
            ...toolEvidence.failures,
          ].join(", "),
    };
  }
  const actual = record.steps.map((step) => step.skill);
  const passed = JSON.stringify(actual) === JSON.stringify(assertion.equals);
  return {
    assertion,
    recordId: record.id,
    passed,
    message: passed
      ? "step skills match"
      : `expected ${assertion.equals.join(", ")}; got ${actual.join(", ")}`,
  };
}

function valueShape(value: unknown): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const itemShapes = [...new Set(value.map((item) => JSON.stringify(valueShape(item))))]
      .sort()
      .map((item) => JSON.parse(item) as unknown);
    return { type: "array", items: itemShapes };
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, valueShape(item)]),
    );
  }
  return typeof value;
}

function evidenceShape(record: RunRecord): unknown {
  const { steps, ...runEvidence } = record;
  return {
    run: valueShape(runEvidence),
    steps: steps.map((step) => ({
      identity: {
        id: step.id,
        skill: step.skill,
        mode: step.mode,
      },
      fields: valueShape(step),
    })),
  };
}

export function evaluateStructure(
  fixture: EvaluationFixture,
  records: RunRecord[],
  workflowOutcomeDecodeOptions?: EvaluationWorkflowOutcomeDecodeOptions,
): StructuralEvaluation {
  const results: AssertionResult[] = [];
  const invalidOutcomeRecords = new Set<RunRecord>();
  for (const record of records) {
    if (record.workflowOutcome === undefined) continue;
    try {
      decodeWorkflowOutcome(record.workflowOutcome, record, workflowOutcomeDecodeOptions?.(record));
    } catch {
      invalidOutcomeRecords.add(record);
    }
  }
  for (const assertion of fixture.assertions) {
    if (assertion.type === "run-count") {
      const uniqueIds = new Set(records.map((record) => record.id));
      const unique = uniqueIds.size === records.length;
      const passed =
        invalidOutcomeRecords.size === 0 && unique && uniqueIds.size >= assertion.minimum;
      results.push({
        assertion,
        passed,
        message: passed
          ? `${uniqueIds.size} unique records meet minimum ${assertion.minimum}`
          : invalidOutcomeRecords.size > 0
            ? "campaign contains an invalid workflow outcome"
            : !unique
              ? "campaign records must have unique run IDs"
              : `expected at least ${assertion.minimum} unique records, got ${uniqueIds.size}`,
      });
      continue;
    }
    if (assertion.type === "record-shape-consistent") {
      const shapes = records.map((record) => JSON.stringify(evidenceShape(record)));
      const passed =
        invalidOutcomeRecords.size === 0 && shapes.length > 1 && new Set(shapes).size === 1;
      results.push({
        assertion,
        passed,
        message: passed
          ? "run evidence shapes are consistent"
          : invalidOutcomeRecords.size > 0
            ? "run evidence contains an invalid workflow outcome"
            : shapes.length < 2
              ? "record-shape-consistent requires at least two records"
              : "run evidence shapes differ",
      });
      continue;
    }
    if (assertion.type === "evidence-identity-consistent") {
      const uniqueIds = new Set(records.map((record) => record.id));
      const revisions = new Set(records.map((record) => record.repository.revision));
      const packetDigests = new Set<string>();
      const consultedNodeSets = new Set<string>();
      const evidenceDigests = new Set<string>();
      let complete = true;
      for (const record of records) {
        let recordHasIdentity = false;
        let recordHasTurnEvidence = false;
        for (const step of record.steps.filter((item) => item.kind !== "host-operation")) {
          for (const attempt of step.inference?.attempts ?? []) {
            const identity = attempt.identity;
            if (
              !identity?.contextPacketDigest ||
              !sha256(identity.contextPacketDigest) ||
              !identity.consultedNodeIds?.length ||
              identity.repositoryRevision !== record.repository.revision
            ) {
              complete = false;
              continue;
            }
            const expectedNodes = uniqueSorted(step.contextPreflight?.consultedNodeIds ?? []);
            if (
              step.contextPreflight?.packetDigest !== identity.contextPacketDigest ||
              expectedNodes.length === 0 ||
              JSON.stringify(identity.consultedNodeIds) !== JSON.stringify(expectedNodes)
            ) {
              complete = false;
            }
            recordHasIdentity = true;
            packetDigests.add(identity.contextPacketDigest);
            consultedNodeSets.add(JSON.stringify(uniqueSorted(identity.consultedNodeIds)));
            const expectedDigest = evidenceIdentityDigest(identity);
            if (!attempt.turns?.length) complete = false;
            for (const turn of attempt.turns ?? []) {
              recordHasTurnEvidence = true;
              evidenceDigests.add(turn.evidenceDigest);
              if (turn.evidenceDigest !== expectedDigest) complete = false;
            }
          }
        }
        if (!recordHasIdentity || !recordHasTurnEvidence) complete = false;
      }
      const passed =
        invalidOutcomeRecords.size === 0 &&
        records.length > 1 &&
        uniqueIds.size === records.length &&
        revisions.size === 1 &&
        packetDigests.size === 1 &&
        consultedNodeSets.size === 1 &&
        evidenceDigests.size === 1 &&
        evidenceDigests.size > 0 &&
        complete;
      results.push({
        assertion,
        passed,
        message: passed
          ? "repository revision and turn evidence identity are consistent"
          : invalidOutcomeRecords.size > 0
            ? "run evidence contains an invalid workflow outcome"
            : records.length < 2
              ? "evidence-identity-consistent requires at least two records"
              : "record ID, revision, packet, node, or turn evidence identity differs",
      });
      continue;
    }
    for (const record of records) {
      const result = evaluateEachRecord(assertion, record);
      results.push(
        invalidOutcomeRecords.has(record)
          ? {
              ...result,
              passed: false,
              message: "run evidence contains an invalid workflow outcome",
            }
          : result,
      );
    }
  }
  return {
    fixture: fixture.name,
    recordCount: records.length,
    passed: results.every((result) => result.passed),
    results,
  };
}

function validateTurnGovernance(record: RunRecord): string[] {
  const failures = [...validateToolEvidence(record).failures];
  const inferenceSteps = record.steps.filter((step) => step.kind !== "host-operation");
  if (inferenceSteps.length === 0) return ["record has no inference steps"];
  for (const step of inferenceSteps) {
    const inference = step.inference;
    const attempts = inference?.attempts;
    if (!inference || !attempts?.length) {
      failures.push(`${step.id}: attempts missing`);
      continue;
    }
    const retryPolicyValid =
      Number.isSafeInteger(inference.configuredMaxRetries) &&
      inference.configuredMaxRetries >= 0 &&
      Number.isSafeInteger(inference.effectiveMaxRetries) &&
      inference.effectiveMaxRetries >= 0 &&
      inference.effectiveMaxRetries <= inference.configuredMaxRetries &&
      Number.isSafeInteger(inference.baseDelayMs) &&
      inference.baseDelayMs >= 0 &&
      Number.isSafeInteger(inference.maxDelayMs) &&
      inference.maxDelayMs >= inference.baseDelayMs &&
      Array.isArray(inference.retryableCategories) &&
      new Set(inference.retryableCategories).size === inference.retryableCategories.length &&
      inference.retryableCategories.every((category) => configurableRetryOutcomes.has(category)) &&
      (inference.transportRetry === undefined ||
        isInferenceTransportRetryEvidence(
          inference.transportRetry,
          effectiveInferenceRetryCategories(
            inference.replay,
            inference.retryableCategories,
            inference.transportRetry !== undefined,
          ),
        )) &&
      // Transport faults are judged by their own budget, the rest by
      // `effectiveMaxRetries`.
      inferenceAttemptsWithinBudgets(inference, attempts) &&
      // The replay the step may record decides its effective budget.
      admittedInferenceReplays(step).includes(inference.replay) &&
      (replayKeepsConfiguredBudget(inference.replay)
        ? inference.effectiveMaxRetries === inference.configuredMaxRetries
        : inference.effectiveMaxRetries === 0 &&
          (inference.replay === "disabled-write-step" || attempts.length === 1));
    if (!retryPolicyValid) failures.push(`${step.id}: invalid retry policy evidence`);
    if (
      (inference.conditionRetry !== undefined &&
        !isInferenceConditionRetryEvidence(
          inference.conditionRetry,
          inference.effectiveMaxRetries,
        )) ||
      !inferenceAttemptRulesConsistent(inference, attempts)
    ) {
      failures.push(`${step.id}: retry rules disagree with the retry policy`);
    }
    const positions = inferenceAttemptBudgetPositions(inference, attempts);
    for (const [attemptIndex, attempt] of attempts.entries()) {
      const position = positions[attemptIndex]!;
      const prefix = `${step.id}:attempt-${attempt.attempt}`;
      if (attempt.attempt !== attemptIndex + 1) {
        failures.push(`${prefix}: non-sequential attempt`);
      }
      if (!attemptOutcomes.has(attempt.outcome)) {
        failures.push(`${prefix}: unknown outcome`);
      }
      if (typeof attempt.retryable !== "boolean" || typeof attempt.retryScheduled !== "boolean") {
        failures.push(`${prefix}: retry disposition must be boolean`);
      }
      if (!Number.isSafeInteger(attempt.durationMs) || attempt.durationMs < 0) {
        failures.push(`${prefix}: invalid duration`);
      }
      if (
        attempt.answerBytes !== undefined &&
        (attempt.outcome !== "succeeded" ||
          !Number.isSafeInteger(attempt.answerBytes) ||
          attempt.answerBytes < 0)
      ) {
        failures.push(`${prefix}: answer bytes on an attempt that admitted no answer`);
      }
      const hasLaterAttempt = attemptIndex < attempts.length - 1;
      if (attempt.retryScheduled !== hasLaterAttempt) {
        failures.push(`${prefix}: retry schedule does not match attempt sequence`);
      }
      if (attempt.retryScheduled) {
        if (
          attempt.retryable !== true ||
          !effectiveInferenceRetryCategories(
            inference.replay,
            inference.retryableCategories,
            inference.transportRetry !== undefined,
          ).some((category) => category === attempt.outcome) ||
          !Number.isSafeInteger(attempt.backoffMs) ||
          // The writer's own formula, Retry-After included.
          !isRecordedInferenceRetryBackoff(position.backoff, attempt, position.ordinal)
        ) {
          failures.push(`${prefix}: scheduled retry is not policy-authorized`);
        }
      } else if (attempt.backoffMs !== undefined) {
        failures.push(`${prefix}: unscheduled attempt has backoff`);
      }
      if (
        attempt.outcome === "succeeded" &&
        (attempt.retryable !== false || attempt.retryScheduled !== false)
      ) {
        failures.push(`${prefix}: succeeded attempt cannot be retryable`);
      }
      if (
        attempt.outcome === "context-exhausted" &&
        (attempt.retryable !== false || attempt.retryScheduled !== false || hasLaterAttempt)
      ) {
        failures.push(`${prefix}: context exhaustion must be terminal and non-retryable`);
      }
      const identity = attempt.identity;
      if (!identity || identity.repositoryRevision !== record.repository.revision) {
        failures.push(`${prefix}: revision identity mismatch`);
      }
      const packetDigest = step.contextPreflight?.packetDigest;
      const consultedNodeIds = step.contextPreflight?.consultedNodeIds;
      if (
        record.workflow === "readiness" &&
        (step.contextPreflight?.status !== "ready" ||
          !packetDigest ||
          !sha256(packetDigest) ||
          !consultedNodeIds?.length)
      ) {
        failures.push(`${prefix}: readiness packet identity missing`);
      }
      if (
        packetDigest !== undefined &&
        (!sha256(packetDigest) || identity?.contextPacketDigest !== packetDigest)
      ) {
        failures.push(`${prefix}: packet identity mismatch`);
      }
      if (
        record.workflow === "readiness" &&
        (!identity?.contextPacketDigest ||
          !sha256(identity.contextPacketDigest) ||
          !identity.consultedNodeIds?.length)
      ) {
        failures.push(`${prefix}: inference evidence identity incomplete`);
      }
      const expectedNodes = uniqueSorted(consultedNodeIds ?? []);
      if (
        expectedNodes.some((nodeId) => typeof nodeId !== "string" || !nodeId.trim()) ||
        JSON.stringify(identity?.consultedNodeIds ?? []) !== JSON.stringify(expectedNodes)
      ) {
        failures.push(`${prefix}: consulted-node identity mismatch`);
      }
      const turns = attempt.turns;
      if (!turns?.length) {
        failures.push(`${prefix}: turn ledger missing`);
        continue;
      }
      const stablePolicy = turns[0] ? turnPolicy(turns[0]) : undefined;
      const profile = attempt.model?.profile;
      for (const [index, turn] of turns.entries()) {
        const label = `${prefix}:turn-${index + 1}`;
        if (
          profile &&
          ((profile.schemaVersion === 2) !== (turn.contextBudgetSchemaVersion === 2) ||
            turn.configuredMaxInputTokens !== profile.configuredMaxInputTokens ||
            turn.effectiveMaxInputTokens !== profile.effectiveMaxInputTokens)
        ) {
          failures.push(`${label}: input policy does not match model profile`);
        }
        if (turn.turn !== index + 1) failures.push(`${label}: non-sequential turn`);
        if (!turnDecisions.has(turn.decision)) {
          failures.push(`${label}: unknown decision`);
        }
        if (turn.reason !== undefined && !turnReasons.has(turn.reason)) {
          failures.push(`${label}: unknown reason`);
        }
        const numeric = [
          turn.toolCalls,
          turn.toolResults,
          ...(turn.maxProviderTurns === undefined ? [] : [turn.maxProviderTurns]),
          ...(turn.maxToolCalls === undefined ? [] : [turn.maxToolCalls]),
          turn.compactions,
          ...(turn.maxCompactions === undefined ? [] : [turn.maxCompactions]),
          turn.configuredContextWindow,
          turn.effectiveContextWindow,
          turn.configuredMaxOutputTokens,
          turn.effectiveMaxOutputTokens,
          turn.reservedTokens,
          turn.estimatedInputTokens,
          turn.availableOutputTokens,
          turn.requiredMinimumOutputTokens,
          ...(turn.configuredMaxInputTokens === undefined
            ? []
            : [
                turn.configuredMaxInputTokens,
                turn.effectiveMaxInputTokens,
                turn.availableInputTokens,
              ]),
        ];
        if (
          numeric.some(
            (value) => value === undefined || !Number.isSafeInteger(value) || value < 0,
          ) ||
          (turn.aggregatePolicy?.kind === "absent"
            ? turn.maxProviderTurns !== undefined ||
              turn.maxToolCalls !== undefined ||
              turn.maxCompactions !== undefined
            : turn.maxProviderTurns === undefined ||
              turn.maxToolCalls === undefined ||
              turn.maxCompactions === undefined ||
              turn.maxProviderTurns <= 0 ||
              turn.maxToolCalls <= 0) ||
          turn.configuredContextWindow <= 0 ||
          turn.effectiveContextWindow <= 0 ||
          turn.configuredMaxOutputTokens <= 0 ||
          turn.effectiveMaxOutputTokens <= 0 ||
          turn.requiredMinimumOutputTokens <= 0 ||
          (turn.requestedOutputTokens !== undefined &&
            (!Number.isSafeInteger(turn.requestedOutputTokens) || turn.requestedOutputTokens < 0))
        ) {
          failures.push(`${label}: invalid numeric policy`);
        }
        const expectedAvailable = Math.max(
          0,
          turn.effectiveContextWindow - turn.estimatedInputTokens - turn.reservedTokens,
        );
        const inputEvidenceCount = [
          turn.configuredMaxInputTokens,
          turn.effectiveMaxInputTokens,
          turn.availableInputTokens,
        ].filter((value) => value !== undefined).length;
        const inputEvidenceInvalid =
          turn.contextBudgetSchemaVersion === 2
            ? inputEvidenceCount !== 3
            : inputEvidenceCount !== 0;
        const inputPolicyInvalid =
          turn.configuredMaxInputTokens !== undefined &&
          turn.effectiveMaxInputTokens !== undefined &&
          turn.availableInputTokens !== undefined &&
          (turn.configuredMaxInputTokens > turn.configuredContextWindow ||
            turn.effectiveMaxInputTokens > turn.effectiveContextWindow ||
            turn.effectiveMaxInputTokens > turn.configuredMaxInputTokens ||
            turn.availableInputTokens !==
              Math.max(0, turn.effectiveMaxInputTokens - turn.reservedTokens));
        if (
          turn.effectiveContextWindow > turn.configuredContextWindow ||
          turn.effectiveMaxOutputTokens > turn.configuredMaxOutputTokens ||
          turn.requiredMinimumOutputTokens > turn.effectiveMaxOutputTokens ||
          turn.availableOutputTokens !== expectedAvailable ||
          inputEvidenceInvalid ||
          inputPolicyInvalid ||
          turn.toolResults > turn.toolCalls ||
          (turn.maxCompactions !== undefined && turn.compactions > turn.maxCompactions)
        ) {
          failures.push(`${label}: inconsistent effective policy`);
        }
        if (stablePolicy && JSON.stringify(turnPolicy(turn)) !== JSON.stringify(stablePolicy)) {
          failures.push(`${label}: policy changed within attempt`);
        }
        const previous = turns[index - 1];
        if (
          previous &&
          (turn.toolCalls < previous.toolCalls ||
            turn.toolResults < previous.toolResults ||
            turn.compactions !== previous.compactions + (previous.decision === "compact" ? 1 : 0))
        ) {
          failures.push(`${label}: non-monotonic counters`);
        }
        if (
          !sha256(turn.requestDigest) ||
          !sha256(turn.evidenceDigest) ||
          (identity && turn.evidenceDigest !== evidenceIdentityDigest(identity))
        ) {
          failures.push(`${label}: invalid digest`);
        }
        // Bounded in-turn provider attempts: a replay and an empty turn both
        // require a payload that was finalized and sent, and every empty turn
        // except the last was replaced by a replay.
        if (
          (turn.providerRetries !== undefined &&
            (!Number.isSafeInteger(turn.providerRetries) ||
              turn.providerRetries < 1 ||
              turn.finalPayloadSha256 === undefined)) ||
          (turn.providerBlankTurns !== undefined &&
            (!Number.isSafeInteger(turn.providerBlankTurns) ||
              turn.providerBlankTurns < 1 ||
              turn.finalPayloadSha256 === undefined ||
              turn.providerBlankTurns > (turn.providerRetries ?? 0) + 1))
        ) {
          failures.push(`${label}: invalid provider attempt counters`);
        }
        // An omission is counted on a policed payload that was sealed. A
        // refusal ends the attempt and must fit the row's phase.
        if (
          (turn.replayedReasoningOmitted !== undefined &&
            (!Number.isSafeInteger(turn.replayedReasoningOmitted) ||
              turn.replayedReasoningOmitted < 1 ||
              turn.requestPolicySha256 === undefined ||
              turn.finalPayloadSha256 === undefined)) ||
          (turn.requestPolicyRefusal !== undefined &&
            (index !== turns.length - 1 ||
              !isAdmissibleRequestPolicyRefusal(
                turn.requestPolicyRefusal,
                turn.finalPayloadSha256 !== undefined,
              )))
        ) {
          failures.push(`${label}: invalid request policy evidence`);
        }
        if (turn.decision === "stop") {
          if (
            !turn.reason ||
            turn.outputTokens !== undefined ||
            index !== turns.length - 1 ||
            attempt.outcome !== "context-exhausted" ||
            attempt.retryable !== false ||
            attempt.retryScheduled !== false
          ) {
            failures.push(`${label}: unexplained local stop`);
          }
          if (!stopReasonMatchesPolicy(turn)) {
            failures.push(`${label}: stop reason does not match policy`);
          }
        } else if (
          turn.reason ||
          (turn.outputTokens !== undefined &&
            (!Number.isSafeInteger(turn.outputTokens) ||
              turn.outputTokens < 0 ||
              turn.outputTokens > producedTurnOutputLimit(turn))) ||
          (turn.effectiveMaxInputTokens !== undefined &&
            (turn.reservedTokens > turn.effectiveMaxInputTokens ||
              turn.estimatedInputTokens > turn.effectiveMaxInputTokens - turn.reservedTokens)) ||
          turn.estimatedInputTokens + turn.reservedTokens + turnGrantedOutput(turn) >
            turn.effectiveContextWindow ||
          (turn.maxProviderTurns !== undefined && turn.turn > turn.maxProviderTurns) ||
          (turn.maxToolCalls !== undefined && turn.toolCalls > turn.maxToolCalls)
        ) {
          failures.push(`${label}: provider request was not proven to fit`);
        }
        if (
          (turn.outputAuthority !== undefined || turn.reason === "output-authority-exhausted") &&
          !outputAuthorityConsistent(turn)
        ) {
          failures.push(`${label}: output authority mismatch`);
        }
        if (turn.decision === "compact") {
          const compact = turn.compaction;
          if (
            !compact ||
            compact.afterRequestDigest !== turn.requestDigest ||
            !sha256(compact.beforeRequestDigest) ||
            !sha256(compact.afterRequestDigest) ||
            !sha256(compact.preservedCitationDigest) ||
            [
              compact.estimatedInputTokensBefore,
              compact.estimatedInputTokensAfter,
              compact.removedMessages,
              compact.retainedMessages,
              compact.preservedCitationCount,
            ].some((value) => !Number.isSafeInteger(value) || value < 0) ||
            compact.estimatedInputTokensAfter >= compact.estimatedInputTokensBefore ||
            compact.removedMessages <= 0 ||
            compact.retainedMessages <= 0
          ) {
            failures.push(`${label}: invalid compaction evidence`);
          }
        } else if (turn.compaction) {
          failures.push(`${label}: unexpected compaction evidence`);
        }
      }
      const stopped = turns.at(-1)?.decision === "stop";
      if ((attempt.outcome === "context-exhausted") !== stopped) {
        failures.push(`${prefix}: outcome/turn disposition mismatch`);
      }
    }
    if (record.status === "succeeded" && attempts.at(-1)?.outcome !== "succeeded") {
      failures.push(`${step.id}: succeeded run has no final succeeded attempt`);
    }
  }
  return failures;
}

function validateGovernedTerminalStatus(record: RunRecord): string[] {
  if (record.status === "succeeded") {
    const failures: string[] = [];
    if (record.steps.length === 0 || record.steps.some((step) => step.status !== "succeeded")) {
      failures.push("succeeded run has non-succeeded steps");
    }
    for (const step of record.steps.filter((item) => item.kind !== "host-operation")) {
      if (step.inference?.attempts.at(-1)?.outcome !== "succeeded") {
        failures.push(`${step.id}: succeeded step has no final succeeded attempt`);
      }
    }
    return failures;
  }
  if (record.status !== "failed") {
    return [`run status ${record.status} is not terminal`];
  }

  let explainedStops = 0;
  const failures: string[] = [];
  for (const step of record.steps) {
    if (step.status === "succeeded") continue;
    if (step.status === "pending") {
      if (step.contextPreflight?.reason !== "workflow-stopped-before-step") {
        failures.push(`${step.id}: pending step is unexplained`);
      }
      continue;
    }
    if (step.status !== "failed") {
      failures.push(`${step.id}: non-terminal step status ${step.status}`);
      continue;
    }
    const attempt = step.inference?.attempts.at(-1);
    const turn = attempt?.turns?.at(-1);
    if (
      attempt?.outcome === "context-exhausted" &&
      attempt.retryable === false &&
      attempt.retryScheduled === false &&
      turn?.decision === "stop" &&
      turn.reason !== undefined &&
      turnReasons.has(turn.reason)
    ) {
      explainedStops += 1;
    } else {
      failures.push(`${step.id}: failed step is not an explained context stop`);
    }
  }
  if (explainedStops !== 1) {
    failures.push(`expected exactly one explained context stop, got ${explainedStops}`);
  }
  return failures;
}

function stopReasonMatchesPolicy(
  turn: NonNullable<
    NonNullable<RunRecord["steps"][number]["inference"]>["attempts"][number]["turns"]
  >[number],
): boolean {
  if (!turn.reason || !turnReasons.has(turn.reason)) return false;
  const providerLimitReached =
    turn.maxProviderTurns !== undefined && turn.turn > turn.maxProviderTurns;
  const toolLimitReached = turn.maxToolCalls !== undefined && turn.toolCalls > turn.maxToolCalls;
  const inputExhausted =
    turn.effectiveMaxInputTokens !== undefined &&
    (turn.reservedTokens > turn.effectiveMaxInputTokens ||
      turn.estimatedInputTokens > turn.effectiveMaxInputTokens - turn.reservedTokens);
  const budgetExhausted =
    inputExhausted || turn.availableOutputTokens < turn.requiredMinimumOutputTokens;
  if (turn.reason === "provider-turn-limit") return providerLimitReached;
  if (providerLimitReached) return false;
  if (turn.reason === "tool-call-limit") return toolLimitReached;
  if (toolLimitReached) return false;
  // Run records omit raw call/result linkage, so an evidence-preservation stop
  // is admissible once the two numerically observable limits have not fired.
  if (turn.reason === "evidence-preservation-required") return true;
  // The governor checks output authority before the context budget, so an
  // exhausted authority rules out every budget reason below.
  const authorityExhausted = outputAuthorityExhausted(turn);
  if (turn.reason === "output-authority-exhausted") return authorityExhausted;
  if (authorityExhausted) return false;
  if (turn.reason === "compaction-limit") {
    return (
      turn.maxCompactions !== undefined &&
      budgetExhausted &&
      turn.compactions >= turn.maxCompactions
    );
  }
  // A refused compaction stops before the budget is spent, so unlike
  // `compaction-limit` it is admissible with compactions still left.
  if (turn.reason === "context-exhausted" || turn.reason === "compaction-ineffective") {
    return (
      budgetExhausted &&
      (turn.maxCompactions === undefined || turn.compactions < turn.maxCompactions)
    );
  }
  return false;
}

type StructuralTurn = NonNullable<
  NonNullable<RunRecord["steps"][number]["inference"]>["attempts"][number]["turns"]
>[number];

function turnGrantedOutput(turn: StructuralTurn): number {
  return grantedTurnOutputTokens({
    ...(turn.requestedOutputTokens === undefined
      ? {}
      : { requestedOutputTokens: turn.requestedOutputTokens }),
    effectiveMaxOutputTokens: turn.effectiveMaxOutputTokens,
    availableOutputTokens: turn.availableOutputTokens,
    requiredMinimumOutputTokens: turn.requiredMinimumOutputTokens,
  });
}

function producedTurnOutputLimit(turn: StructuralTurn): number {
  return producedTurnOutputTokenLimit({
    ...(turn.requestedOutputTokens === undefined
      ? {}
      : { requestedOutputTokens: turn.requestedOutputTokens }),
    effectiveMaxOutputTokens: turn.effectiveMaxOutputTokens,
    availableOutputTokens: turn.availableOutputTokens,
    requiredMinimumOutputTokens: turn.requiredMinimumOutputTokens,
    ...(turn.providerRetries === undefined ? {} : { providerRetries: turn.providerRetries }),
  });
}

/** The recorded output authority left less than one floor's worth of output. */
function outputAuthorityExhausted(turn: StructuralTurn): boolean {
  const authority = turn.outputAuthority;
  return (
    authority !== undefined &&
    authority.maxOutputTokens - authority.cumulativeOutputTokens < authority.floorOutputTokens
  );
}

/**
 * `outputAuthority` is recorded only where it bound the turn, and its arithmetic
 * must hold from the record alone: a clamp requested exactly the remainder, an
 * exhaustion had less than the floor, and the floor sits above the provider
 * minimum.
 */
function outputAuthorityConsistent(turn: StructuralTurn): boolean {
  const authority = turn.outputAuthority;
  if (
    !authority ||
    typeof authority !== "object" ||
    Object.keys(authority).sort().join(",") !==
      "cumulativeOutputTokens,floorOutputTokens,maxOutputTokens" ||
    !Number.isSafeInteger(authority.maxOutputTokens) ||
    authority.maxOutputTokens < 1 ||
    !Number.isSafeInteger(authority.cumulativeOutputTokens) ||
    authority.cumulativeOutputTokens < 0 ||
    !Number.isSafeInteger(authority.floorOutputTokens) ||
    authority.floorOutputTokens <= turn.requiredMinimumOutputTokens
  ) {
    return false;
  }
  const remaining = authority.maxOutputTokens - authority.cumulativeOutputTokens;
  if (remaining >= turn.effectiveMaxOutputTokens) return false;
  if (turn.decision === "stop") {
    return turn.reason !== "output-authority-exhausted" || remaining < authority.floorOutputTokens;
  }
  return remaining >= authority.floorOutputTokens && turn.requestedOutputTokens === remaining;
}

interface NormalizedToolSummary {
  totalCalls: number;
  failedCalls: number;
  byTool: Map<string, { calls: number; failures: number }>;
}

function validateToolEvidence(record: RunRecord): {
  failures: string[];
  observed: Set<string>;
} {
  const failures: string[] = [];
  const observed = new Set<string>();
  const run = inspectToolSummary(record.tools, "record.tools", true, failures, observed);
  const stepSummaries: NormalizedToolSummary[] = [];
  for (const step of record.steps) {
    const attempts = step.inference?.attempts ?? [];
    const attemptSummaries: NormalizedToolSummary[] = [];
    let turnActivity = false;
    for (const attempt of attempts) {
      const finalTurn = attempt.turns?.at(-1);
      const active = Boolean(finalTurn && (finalTurn.toolCalls > 0 || finalTurn.toolResults > 0));
      turnActivity ||= active;
      const summary = inspectToolSummary(
        attempt.tools,
        `${step.id}:attempt-${attempt.attempt}.tools`,
        active,
        failures,
        observed,
      );
      if (summary) {
        attemptSummaries.push(summary);
        // A host stop after a settled tool turn (a read loop, or the hard
        // tool-call ceiling) records no later turn that counts that turn's
        // calls, so its last turn may count fewer, never more.
        const governanceStops =
          attempt.tools?.failureCategories?.find((entry) => entry.category === "governance-stop")
            ?.count ?? 0;
        const preExecutionRejections = attempt.tools?.preExecutionRejections?.count ?? 0;
        const terminalRejections = finalTurn?.terminalPreExecutionRejections ?? 0;
        if (
          attempt.turns
            ?.slice(0, -1)
            .some((turn) => turn.terminalPreExecutionRejections !== undefined) ||
          (terminalRejections !== 0 &&
            (!Number.isSafeInteger(terminalRejections) ||
              terminalRejections < 1 ||
              terminalRejections > preExecutionRejections ||
              attempt.outcome !== "malformed-response" ||
              attempt.rejection?.code !== "quality-submission-shape" ||
              attempt.answerSubmission?.path !== "tool-call" ||
              attempt.answerSubmission.submission !== "refused" ||
              attempt.answerSubmission.reportTurn !== "not-asked" ||
              attempt.executionLease?.phase !== "terminal" ||
              attempt.executionLease.terminalReason !== "completed"))
        ) {
          failures.push(
            `${step.id}:attempt-${attempt.attempt}: invalid terminal rejection evidence`,
          );
        }
        const stoppedAfterToolTurn = attempt.outcome === "no-progress";
        if (
          finalTurn &&
          (stoppedAfterToolTurn
            ? finalTurn.toolCalls > summary.totalCalls + governanceStops + preExecutionRejections
            : finalTurn.toolCalls + terminalRejections !==
              summary.totalCalls + governanceStops + preExecutionRejections)
        ) {
          failures.push(
            `${step.id}:attempt-${attempt.attempt}: final tool count does not match summary`,
          );
        }
        if (finalTurn && finalTurn.toolResults > summary.totalCalls) {
          failures.push(`${step.id}:attempt-${attempt.attempt}: final tool results exceed summary`);
        }
      }
    }
    const stepSummary = inspectToolSummary(
      step.tools,
      `${step.id}.tools`,
      turnActivity,
      failures,
      observed,
    );
    if (stepSummary) {
      stepSummaries.push(stepSummary);
      if (
        step.inference &&
        !toolSummariesEqual(stepSummary, aggregateToolSummaries(attemptSummaries))
      ) {
        failures.push(`${step.id}: step tools do not reconcile with attempts`);
      }
    }
  }
  if (run && !toolSummariesEqual(run, aggregateToolSummaries(stepSummaries))) {
    failures.push("record tools do not reconcile with steps");
  }
  return { failures, observed };
}

function inspectToolSummary(
  value: unknown,
  label: string,
  required: boolean,
  failures: string[],
  observed: Set<string>,
): NormalizedToolSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (required) failures.push(`${label}: authoritative tool summary missing`);
    return undefined;
  }
  const summary = value as Record<string, unknown>;
  const totalCalls = summary.totalCalls;
  const failedCalls = summary.failedCalls;
  let valid =
    Number.isSafeInteger(totalCalls) &&
    Number(totalCalls) >= 0 &&
    Number.isSafeInteger(failedCalls) &&
    Number(failedCalls) >= 0 &&
    Number(failedCalls) <= Number(totalCalls);
  const byTool = new Map<string, { calls: number; failures: number }>();
  if (!Array.isArray(summary.byTool)) {
    valid = false;
  } else {
    for (const rawEntry of summary.byTool) {
      if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
        valid = false;
        continue;
      }
      const entry = rawEntry as Record<string, unknown>;
      if (
        typeof entry.name !== "string" ||
        !entry.name.trim() ||
        byTool.has(entry.name) ||
        !Number.isSafeInteger(entry.calls) ||
        Number(entry.calls) < 0 ||
        !Number.isSafeInteger(entry.failures) ||
        Number(entry.failures) < 0 ||
        Number(entry.failures) > Number(entry.calls)
      ) {
        valid = false;
        continue;
      }
      observed.add(entry.name);
      byTool.set(entry.name, {
        calls: Number(entry.calls),
        failures: Number(entry.failures),
      });
    }
  }
  const summedCalls = [...byTool.values()].reduce((total, item) => total + item.calls, 0);
  const summedFailures = [...byTool.values()].reduce((total, item) => total + item.failures, 0);
  if (summedCalls !== totalCalls || summedFailures !== failedCalls) valid = false;
  if (summary.failureCategories !== undefined) {
    if (!Array.isArray(summary.failureCategories)) {
      valid = false;
    } else {
      const seen = new Set<string>();
      let categorized = 0;
      for (const rawCategory of summary.failureCategories) {
        if (!rawCategory || typeof rawCategory !== "object" || Array.isArray(rawCategory)) {
          valid = false;
          continue;
        }
        const category = rawCategory as Record<string, unknown>;
        if (
          typeof category.category !== "string" ||
          !toolFailureDispositions.has(category.category) ||
          seen.has(category.category) ||
          !Number.isSafeInteger(category.count) ||
          Number(category.count) < 0
        ) {
          valid = false;
          continue;
        }
        seen.add(category.category);
        categorized += Number(category.count);
      }
      if (categorized !== failedCalls) valid = false;
    }
  }
  if (!valid) {
    failures.push(`${label}: malformed or internally inconsistent tool summary`);
    return undefined;
  }
  return { totalCalls: Number(totalCalls), failedCalls: Number(failedCalls), byTool };
}

function aggregateToolSummaries(
  summaries: readonly NormalizedToolSummary[],
): NormalizedToolSummary {
  const aggregate: NormalizedToolSummary = {
    totalCalls: 0,
    failedCalls: 0,
    byTool: new Map(),
  };
  for (const summary of summaries) {
    aggregate.totalCalls += summary.totalCalls;
    aggregate.failedCalls += summary.failedCalls;
    for (const [name, entry] of summary.byTool) {
      const current = aggregate.byTool.get(name) ?? { calls: 0, failures: 0 };
      aggregate.byTool.set(name, {
        calls: current.calls + entry.calls,
        failures: current.failures + entry.failures,
      });
    }
  }
  return aggregate;
}

function toolSummariesEqual(left: NormalizedToolSummary, right: NormalizedToolSummary): boolean {
  if (
    left.totalCalls !== right.totalCalls ||
    left.failedCalls !== right.failedCalls ||
    left.byTool.size !== right.byTool.size
  )
    return false;
  return [...left.byTool].every(([name, entry]) => {
    const other = right.byTool.get(name);
    return other?.calls === entry.calls && other.failures === entry.failures;
  });
}

function turnPolicy(
  turn: NonNullable<
    NonNullable<RunRecord["steps"][number]["inference"]>["attempts"][number]["turns"]
  >[number],
): unknown {
  return {
    contextBudgetSchemaVersion: turn.contextBudgetSchemaVersion,
    aggregatePolicy: turn.aggregatePolicy,
    maxProviderTurns: turn.maxProviderTurns,
    maxToolCalls: turn.maxToolCalls,
    maxCompactions: turn.maxCompactions,
    configuredContextWindow: turn.configuredContextWindow,
    effectiveContextWindow: turn.effectiveContextWindow,
    configuredMaxInputTokens: turn.configuredMaxInputTokens,
    effectiveMaxInputTokens: turn.effectiveMaxInputTokens,
    configuredMaxOutputTokens: turn.configuredMaxOutputTokens,
    effectiveMaxOutputTokens: turn.effectiveMaxOutputTokens,
    reservedTokens: turn.reservedTokens,
    requiredMinimumOutputTokens: turn.requiredMinimumOutputTokens,
  };
}

function sha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function evidenceIdentityDigest(
  identity: NonNullable<
    NonNullable<RunRecord["steps"][number]["inference"]>["attempts"][number]["identity"]
  >,
): string {
  const normalized = {
    repositoryRevision: identity.repositoryRevision,
    ...(identity.contextPacketDigest ? { contextPacketDigest: identity.contextPacketDigest } : {}),
    ...(identity.consultedNodeIds
      ? { consultedNodeIds: [...new Set(identity.consultedNodeIds)].sort() }
      : {}),
    ...(identity.technicalVerificationSha256
      ? { technicalVerificationSha256: identity.technicalVerificationSha256 }
      : {}),
    ...(identity.authoringPhaseSha256
      ? { authoringPhaseSha256: identity.authoringPhaseSha256 }
      : {}),
  };
  return createHash("sha256")
    .update(JSON.stringify(normalized, Object.keys(normalized).sort()))
    .digest("hex");
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export async function evaluateRuns(input: {
  fixture: EvaluationFixture;
  records: RunRecord[];
  judge?: EvaluationJudge;
  rubric?: EvaluationRubric;
  workflowOutcomeDecodeOptions?: EvaluationWorkflowOutcomeDecodeOptions;
}): Promise<EvaluationResult> {
  const structural = evaluateStructure(
    input.fixture,
    input.records,
    input.workflowOutcomeDecodeOptions,
  );
  const rubric = input.rubric ?? SEMANTIC_RUBRIC_V1;
  let judge: EvaluationResult["judge"];
  if (input.judge && !structural.passed) {
    judge = {
      status: "skipped",
      rubric: { id: rubric.id, version: rubric.version },
      model: input.judge.identity,
      reason: "structural evaluation failed",
    };
  } else if (input.judge) {
    try {
      const decision = await input.judge.grade({
        rubric,
        evidence: buildSemanticEvidence(
          { name: input.fixture.name, version: input.fixture.version },
          input.records,
        ),
      });
      judge = {
        status: decision.passed ? "passed" : "disagreed",
        rubric: { id: rubric.id, version: rubric.version },
        model: input.judge.identity,
        score: decision.score,
        rationale: decision.rationale,
      };
    } catch {
      judge = {
        status: "error",
        rubric: { id: rubric.id, version: rubric.version },
        model: input.judge.identity,
        reason: "semantic judge failed",
      };
    }
  }
  return {
    structural,
    ...(judge ? { judge } : {}),
    passed: structural.passed,
  };
}
