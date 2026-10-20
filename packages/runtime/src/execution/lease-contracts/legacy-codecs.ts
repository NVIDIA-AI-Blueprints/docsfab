// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isInferenceAnswerSubmissionEvidence } from "../../records/answer-submission-evidence.js";
import {
  isInferenceConcludeNowEvidence,
  isInferenceFailureCondition,
  isRetryRuleId,
} from "../../records/inference-retry-rule-vocabulary.js";
import {
  isLegacyHostPathDisclosure,
  isProviderResponseEvidenceV1,
  isInferenceEfficiencyEvidenceV1,
  type InferenceAttemptEvidence,
  type InferenceEvidenceIdentity,
  type InferenceTurnEvidence,
} from "../../records/contracts.js";
import {
  INFERENCE_CONDITION_RETRYABILITIES,
  INFERENCE_RETRY_DECISIONS,
} from "../../records/inference-retry-disposition.js";
import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../../json-evidence.js";
import {
  isRetainableInferenceRejection,
  MAX_INFERENCE_REJECTION_REASON_LENGTH,
} from "../../config/inference-rejection-limits.js";
import { decodeModelEvidence, decodeTools, decodeUsage } from "../inference-evidence.js";
import { isRejectedReplyExcerptOf } from "../rejected-reply-excerpt.js";
import { isInferenceRejectionSubject } from "../rejection-subject.js";
import { isInferenceRejectedReplyShape } from "../rejected-reply-shape.js";
import { isJudgmentRowKeyAudit } from "../judgment-row-key-audit-contract.js";
import { isInferenceAttemptModelTelemetry } from "../../records/model-telemetry.js";
import {
  INFERENCE_ATTEMPT_SUCCESS_OUTCOME,
  isMalformedResponseCategory,
} from "../../inference-attempt-taxonomy.js";
import {
  ExecutionLeaseContractError,
  INFERENCE_OUTCOMES,
  INFERENCE_TURN_DECISIONS,
  INFERENCE_TURN_REASONS,
  array,
  assertPlainJsonData,
  booleanValue,
  deepFreeze,
  digest,
  enumValue,
  exact,
  fail,
  legacyIdentifier,
  nonnegative,
  object,
  positive,
  revision,
  safeId,
  sha256,
} from "./codec-helpers.js";
import type { LegacyFixedGovernorCompatibilityV1 } from "../lease-contracts.js";

export function migrateLegacyInferenceAttemptEvidence(
  attempt: InferenceAttemptEvidence,
): LegacyFixedGovernorCompatibilityV1 {
  assertPlainJsonData(attempt, "invalid-record");
  const source = object(attempt, "invalid-record");
  exact(
    source,
    [
      "attempt",
      "outcome",
      "hostFailureOrigin",
      "retryable",
      "retryScheduled",
      "writeSettlement",
      // "Legacy" names the output format; the input is the current
      // `InferenceAttemptEvidence`, so current attempt fields must be admitted.
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
      // Closed host-path match metadata older hosts wrote; checked below.
      "hostPathDisclosure",
      "judgmentRowKeyAudit",
      "modelTelemetry",
      "providerResponses",
      "efficiency",
      "durationMs",
      "backoffMs",
      "model",
      "usage",
      "tools",
      "identity",
      "turns",
    ],
    "invalid-record",
    [
      "retryable",
      "retryScheduled",
      "writeSettlement",
      "conditionRetryability",
      "retryDecision",
      "retryRule",
      "condition",
      "answerBytes",
      "concludeNow",
      "answerSubmission",
      // Optional: succeeded attempts and older records carry no coded reason.
      "rejection",
      "rejectedReplyShape",
      "rejectedReplyExcerpt",
      "rejectionSubject",
      "hostPathDisclosure",
      "hostFailureOrigin",
      "judgmentRowKeyAudit",
      "modelTelemetry",
      "providerResponses",
      "efficiency",
      "durationMs",
      "backoffMs",
      "model",
      "usage",
      "tools",
      "identity",
      "turns",
    ],
  );
  validateLegacyAttemptFields(source);
  const turns = !Object.hasOwn(source, "turns") ? [] : array(source.turns, "invalid-record");
  const decodedTurns = turns.map((turn, index) => decodeLegacyTurn(turn, index));
  for (let index = 0; index < decodedTurns.length; index += 1) {
    const current = decodedTurns[index]!;
    const previous = decodedTurns[index - 1];
    if (
      (previous &&
        (current.toolCalls < previous.toolCalls || current.compactions < previous.compactions)) ||
      (current.decision === "stop" && index + 1 < decodedTurns.length)
    ) {
      fail("invalid-record");
    }
  }
  const lastTurn = decodedTurns.at(-1);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-fixed-governor-compatibility" as const,
    renewable: false as const,
    reason: "legacy-record-no-lease-authority" as const,
    attempt: positive(source.attempt, "invalid-record"),
    outcome: enumValue(source.outcome, INFERENCE_OUTCOMES, "invalid-record"),
    identity: !Object.hasOwn(source, "identity") ? null : decodeLegacyIdentity(source.identity),
    providerTurns: lastTurn ? lastTurn.turn - (lastTurn.decision === "stop" ? 1 : 0) : 0,
    toolCalls: lastTurn?.toolCalls ?? 0,
    compactions: lastTurn?.compactions ?? 0,
    turnEvidenceSha256: sha256(turns, "invalid-record"),
  };
  if (body.providerTurns < 0) fail("invalid-record");
  return decodeLegacyCompatibility({
    ...body,
    compatibilitySha256: sha256(body, "invalid-record"),
  });
}

export function serializeLegacyExecutionLeaseCompatibility(
  value: LegacyFixedGovernorCompatibilityV1,
): string {
  const decoded = decodeLegacyCompatibility(value);
  return canonicalizeJsonEvidence(decoded as unknown as JsonEvidenceValue);
}

export function parseLegacyExecutionLeaseCompatibility(
  input: string | Uint8Array | unknown,
): LegacyFixedGovernorCompatibilityV1 {
  const value =
    typeof input === "string" || input instanceof Uint8Array
      ? parseJsonEvidence(input, { requireCanonical: true })
      : input;
  return decodeLegacyCompatibility(value);
}

function validateLegacyAttemptFields(item: Record<string, unknown>): void {
  const retryable = Object.hasOwn(item, "retryable")
    ? booleanValue(item.retryable, "invalid-record")
    : undefined;
  const retryScheduled = Object.hasOwn(item, "retryScheduled")
    ? booleanValue(item.retryScheduled, "invalid-record")
    : undefined;
  if (Object.hasOwn(item, "durationMs")) nonnegative(item.durationMs, "invalid-record");
  if (Object.hasOwn(item, "backoffMs")) nonnegative(item.backoffMs, "invalid-record");
  if (retryable === false && retryScheduled === true) fail("invalid-record");
  if (retryScheduled === false && Object.hasOwn(item, "backoffMs")) fail("invalid-record");
  // Written together or not at all. Shape only: the record decoders own the
  // cross-check against policy.
  const hasRetryability = Object.hasOwn(item, "conditionRetryability");
  if (hasRetryability !== Object.hasOwn(item, "retryDecision")) fail("invalid-record");
  if (hasRetryability) {
    enumValue(item.conditionRetryability, INFERENCE_CONDITION_RETRYABILITIES, "invalid-record");
    enumValue(item.retryDecision, INFERENCE_RETRY_DECISIONS, "invalid-record");
  }
  const outcome = enumValue(item.outcome, INFERENCE_OUTCOMES, "invalid-record");
  if ((outcome === "host-runtime-failure") !== Object.hasOwn(item, "hostFailureOrigin")) {
    fail("invalid-record");
  }
  if (Object.hasOwn(item, "hostFailureOrigin")) {
    const origin = object(item.hostFailureOrigin, "invalid-record");
    exact(origin, ["schemaVersion", "origin", "code"], "invalid-record");
    if (
      origin.schemaVersion !== 1 ||
      origin.origin !== "execution-lease-coordinator" ||
      origin.code !== "invalid-execution-lease-coordinator"
    ) {
      fail("invalid-record");
    }
  }
  if (
    (outcome === "succeeded" || outcome === "context-exhausted") &&
    (retryable === true || retryScheduled === true)
  )
    fail("invalid-record");
  // Shape only: the code and location vocabularies belong to the decoders that
  // raise them.
  if (Object.hasOwn(item, "rejection")) validateLegacyRejection(item.rejection);
  if (
    Object.hasOwn(item, "judgmentRowKeyAudit") &&
    (outcome !== INFERENCE_ATTEMPT_SUCCESS_OUTCOME ||
      !isJudgmentRowKeyAudit(item.judgmentRowKeyAudit))
  ) {
    fail("invalid-record");
  }
  if (
    Object.hasOwn(item, "rejectedReplyShape") &&
    (!isMalformedResponseCategory(outcome) ||
      !isInferenceRejectedReplyShape(item.rejectedReplyShape))
  ) {
    fail("invalid-record");
  }
  // Closed vocabularies only; the decoders that own the decision re-derive it.
  if (Object.hasOwn(item, "retryRule") && !isRetryRuleId(item.retryRule)) fail("invalid-record");
  if (Object.hasOwn(item, "concludeNow") && !isInferenceConcludeNowEvidence(item.concludeNow)) {
    fail("invalid-record");
  }
  if (
    Object.hasOwn(item, "answerSubmission") &&
    !isInferenceAnswerSubmissionEvidence(item.answerSubmission)
  ) {
    fail("invalid-record");
  }
  if (Object.hasOwn(item, "condition") && !isInferenceFailureCondition(item.condition)) {
    fail("invalid-record");
  }
  if (
    Object.hasOwn(item, "answerBytes") &&
    (outcome !== INFERENCE_ATTEMPT_SUCCESS_OUTCOME ||
      !Number.isSafeInteger(item.answerBytes) ||
      (item.answerBytes as number) < 0)
  ) {
    fail("invalid-record");
  }
  if (
    Object.hasOwn(item, "rejectedReplyExcerpt") &&
    !isRejectedReplyExcerptOf(item.rejectedReplyExcerpt, item.rejectedReplyShape)
  ) {
    fail("invalid-record");
  }
  if (
    Object.hasOwn(item, "modelTelemetry") &&
    !isInferenceAttemptModelTelemetry(item.modelTelemetry, outcome)
  ) {
    fail("invalid-record");
  }
  if (
    Object.hasOwn(item, "providerResponses") &&
    !isProviderResponseEvidenceV1(item.providerResponses)
  ) {
    fail("invalid-record");
  }
  if (Object.hasOwn(item, "efficiency") && !isInferenceEfficiencyEvidenceV1(item.efficiency)) {
    fail("invalid-record");
  }
  // Paths the host knows, only beside the coded refusal they describe.
  if (
    Object.hasOwn(item, "rejectionSubject") &&
    (!isMalformedResponseCategory(outcome) ||
      !Object.hasOwn(item, "rejection") ||
      !isInferenceRejectionSubject(item.rejectionSubject))
  ) {
    fail("invalid-record");
  }
  if (
    Object.hasOwn(item, "hostPathDisclosure") &&
    (!isMalformedResponseCategory(outcome) || !isLegacyHostPathDisclosure(item.hostPathDisclosure))
  ) {
    fail("invalid-record");
  }
  if (Object.hasOwn(item, "model")) validateLegacyModel(item.model);
  if (Object.hasOwn(item, "usage")) validateWithScorecardDecoder(item.usage, decodeUsage);
  if (Object.hasOwn(item, "tools")) validateWithScorecardDecoder(item.tools, decodeTools);
}

/**
 * Shape-check an attempt's coded rejection reason.
 *
 * The bound is what keeps a forged record from smuggling response bytes
 * through a field the contract promises is content-free.
 */
function validateLegacyRejection(value: unknown): void {
  const rejection = object(value, "invalid-record");
  exact(rejection, ["code", "location"], "invalid-record");
  for (const field of [rejection.code, rejection.location]) {
    if (
      typeof field !== "string" ||
      field.length === 0 ||
      field.length > MAX_INFERENCE_REJECTION_REASON_LENGTH
    ) {
      fail("invalid-record");
    }
  }
  // Grammar, not vocabulary: free prose in `code` and an indexed or path-shaped
  // `location` are the two ways a forged record could carry response content
  // through fields the contract promises are content-free.
  if (
    !isRetainableInferenceRejection({
      code: rejection.code as string,
      location: rejection.location as string,
    })
  ) {
    fail("invalid-record");
  }
}

function validateLegacyModel(value: unknown): void {
  const item = object(value, "invalid-record");
  exact(item, ["provider", "model", "profile"], "invalid-record", ["profile"]);
  if (!Object.hasOwn(item, "profile")) {
    legacyIdentifier(item.provider);
    legacyIdentifier(item.model);
    return;
  }
  validateWithScorecardDecoder(value, decodeModelEvidence);
}

function validateWithScorecardDecoder(
  value: unknown,
  decoder: (candidate: unknown) => unknown,
): void {
  try {
    decoder(value);
  } catch {
    fail("invalid-record");
  }
}

function decodeLegacyCompatibility(value: unknown): LegacyFixedGovernorCompatibilityV1 {
  assertPlainJsonData(value, "invalid-record");
  const item = object(value, "invalid-record");
  exact(
    item,
    [
      "schemaVersion",
      "kind",
      "renewable",
      "reason",
      "attempt",
      "outcome",
      "identity",
      "providerTurns",
      "toolCalls",
      "compactions",
      "turnEvidenceSha256",
      "compatibilitySha256",
    ],
    "invalid-record",
  );
  if (item.schemaVersion !== 1 || item.kind !== "docsfab-fixed-governor-compatibility") {
    fail("migration-required");
  }
  if (item.renewable !== false || item.reason !== "legacy-record-no-lease-authority") {
    fail("invalid-record");
  }
  const outcome = enumValue(item.outcome, INFERENCE_OUTCOMES, "invalid-record");
  const identity = item.identity === null ? null : decodeLegacyIdentity(item.identity);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-fixed-governor-compatibility" as const,
    renewable: false as const,
    reason: "legacy-record-no-lease-authority" as const,
    attempt: positive(item.attempt, "invalid-record"),
    outcome,
    identity,
    providerTurns: nonnegative(item.providerTurns, "invalid-record"),
    toolCalls: nonnegative(item.toolCalls, "invalid-record"),
    compactions: nonnegative(item.compactions, "invalid-record"),
    turnEvidenceSha256: digest(item.turnEvidenceSha256, "invalid-record"),
  };
  digest(item.compatibilitySha256, "invalid-record");
  if (item.compatibilitySha256 !== sha256(body, "invalid-record")) fail("invalid-record");
  return deepFreeze({ ...body, compatibilitySha256: item.compatibilitySha256 });
}

function decodeLegacyIdentity(value: unknown): InferenceEvidenceIdentity {
  const item = object(value, "invalid-record");
  exact(
    item,
    [
      "repositoryRevision",
      "contextPacketDigest",
      "consultedNodeIds",
      "technicalVerificationSha256",
      "authoringPhaseSha256",
    ],
    "invalid-record",
    [
      "contextPacketDigest",
      "consultedNodeIds",
      "technicalVerificationSha256",
      "authoringPhaseSha256",
    ],
  );
  const consulted =
    item.consultedNodeIds === undefined
      ? undefined
      : array(item.consultedNodeIds, "invalid-record").map((node) => safeId(node));
  if (consulted && new Set(consulted).size !== consulted.length) fail("invalid-record");
  return deepFreeze({
    repositoryRevision: revision(item.repositoryRevision, "invalid-record"),
    ...(item.contextPacketDigest === undefined
      ? {}
      : { contextPacketDigest: digest(item.contextPacketDigest, "invalid-record") }),
    ...(consulted ? { consultedNodeIds: consulted } : {}),
    ...(item.technicalVerificationSha256 === undefined
      ? {}
      : {
          technicalVerificationSha256: digest(item.technicalVerificationSha256, "invalid-record"),
        }),
    ...(item.authoringPhaseSha256 === undefined
      ? {}
      : { authoringPhaseSha256: digest(item.authoringPhaseSha256, "invalid-record") }),
  });
}

function decodeLegacyTurn(
  value: unknown,
  index: number,
): Pick<InferenceTurnEvidence, "turn" | "decision" | "toolCalls" | "compactions"> {
  const item = object(value, "invalid-record");
  exact(
    item,
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
      "rawStopReason",
      "evidenceDigest",
      "compaction",
    ],
    "invalid-record",
    [
      "contextBudgetSchemaVersion",
      "configuredMaxInputTokens",
      "effectiveMaxInputTokens",
      "availableInputTokens",
      "requestedOutputTokens",
      "outputTokens",
      "outputAuthority",
      "terminalPreExecutionRejections",
      "reason",
      "providerPayloadSchemaVersion",
      "requestPolicySha256",
      "finalPayloadSha256",
      "providerRetries",
      "providerBlankTurns",
      "rawStopReason",
      "compaction",
    ],
  );
  const turn = positive(item.turn, "invalid-record");
  const toolCalls = nonnegative(item.toolCalls, "invalid-record");
  const toolResults = nonnegative(item.toolResults, "invalid-record");
  if (item.terminalPreExecutionRejections !== undefined)
    positive(item.terminalPreExecutionRejections, "invalid-record");
  const maxProviderTurns = positive(item.maxProviderTurns, "invalid-record");
  const maxToolCalls = positive(item.maxToolCalls, "invalid-record");
  const compactions = nonnegative(item.compactions, "invalid-record");
  const maxCompactions = nonnegative(item.maxCompactions, "invalid-record");
  const configuredContextWindow = positive(item.configuredContextWindow, "invalid-record");
  const effectiveContextWindow = positive(item.effectiveContextWindow, "invalid-record");
  const configuredMaxOutputTokens = positive(item.configuredMaxOutputTokens, "invalid-record");
  const effectiveMaxOutputTokens = positive(item.effectiveMaxOutputTokens, "invalid-record");
  nonnegative(item.reservedTokens, "invalid-record");
  nonnegative(item.estimatedInputTokens, "invalid-record");
  nonnegative(item.availableOutputTokens, "invalid-record");
  const requiredMinimumOutputTokens = nonnegative(
    item.requiredMinimumOutputTokens,
    "invalid-record",
  );
  if (item.requestedOutputTokens !== undefined) {
    positive(item.requestedOutputTokens, "invalid-record");
  }
  if (item.outputTokens !== undefined) nonnegative(item.outputTokens, "invalid-record");
  const decision = enumValue(item.decision, INFERENCE_TURN_DECISIONS, "invalid-record");
  const reason =
    item.reason === undefined
      ? undefined
      : enumValue(item.reason, INFERENCE_TURN_REASONS, "invalid-record");
  if (item.outputAuthority !== undefined) {
    decodeLegacyOutputAuthority(item, {
      decision,
      reason,
      effectiveMaxOutputTokens,
      requiredMinimumOutputTokens,
    });
  } else if (reason === "output-authority-exhausted") {
    fail("invalid-record");
  }
  digest(item.requestDigest, "invalid-record");
  if (item.providerPayloadSchemaVersion !== undefined && item.providerPayloadSchemaVersion !== 1) {
    fail("invalid-record");
  }
  if (item.requestPolicySha256 !== undefined) {
    digest(item.requestPolicySha256, "invalid-record");
    if (item.finalPayloadSha256 === undefined) fail("invalid-record");
  }
  if (item.finalPayloadSha256 !== undefined) {
    digest(item.finalPayloadSha256, "invalid-record");
  }
  if (item.providerRetries !== undefined) {
    positive(item.providerRetries, "invalid-record");
    // A bounded in-turn retry replays a finalized payload; without one there is
    // nothing that could have been retried.
    if (item.finalPayloadSha256 === undefined) fail("invalid-record");
  }
  if (item.providerBlankTurns !== undefined) {
    positive(item.providerBlankTurns, "invalid-record");
    // An empty provider turn also requires a payload that was finalized and
    // sent, and every empty turn except the last was replaced by a replay.
    if (
      item.finalPayloadSha256 === undefined ||
      Number(item.providerBlankTurns) > Number(item.providerRetries ?? 0) + 1
    ) {
      fail("invalid-record");
    }
  }
  if (
    item.providerPayloadSchemaVersion === undefined
      ? item.requestPolicySha256 !== undefined || item.finalPayloadSha256 !== undefined
      : item.finalPayloadSha256 === undefined
  ) {
    fail("invalid-record");
  }
  digest(item.evidenceDigest, "invalid-record");
  const v2Fields = [
    item.configuredMaxInputTokens,
    item.effectiveMaxInputTokens,
    item.availableInputTokens,
  ];
  if (item.contextBudgetSchemaVersion === undefined) {
    if (v2Fields.some((field) => field !== undefined)) fail("invalid-record");
  } else {
    if (item.contextBudgetSchemaVersion !== 2 || v2Fields.some((field) => field === undefined)) {
      fail("invalid-record");
    }
    const configuredMaxInputTokens = positive(item.configuredMaxInputTokens, "invalid-record");
    const effectiveMaxInputTokens = positive(item.effectiveMaxInputTokens, "invalid-record");
    nonnegative(item.availableInputTokens, "invalid-record");
    if (
      effectiveMaxInputTokens > configuredMaxInputTokens ||
      effectiveMaxInputTokens > effectiveContextWindow
    )
      fail("invalid-record");
  }
  if (
    turn !== index + 1 ||
    turn > maxProviderTurns + 1 ||
    toolCalls > maxToolCalls ||
    toolResults > toolCalls ||
    compactions > maxCompactions ||
    effectiveContextWindow > configuredContextWindow ||
    effectiveMaxOutputTokens > configuredMaxOutputTokens ||
    effectiveMaxOutputTokens > effectiveContextWindow ||
    (decision === "stop") !== (reason !== undefined) ||
    (decision === "stop") === (item.outputTokens !== undefined)
  )
    fail("invalid-record");
  if (item.compaction !== undefined) decodeLegacyCompaction(item.compaction);
  if ((decision === "compact") !== (item.compaction !== undefined)) fail("invalid-record");
  return { turn, decision, toolCalls, compactions };
}

/**
 * The context-budget stop reasons the governor checks only after the output
 * authority: an exhausted authority stops the turn by its own name first, so a
 * turn carrying one cannot have stopped for any of these.
 */
const OUTPUT_AUTHORITY_OUTRANKED_REASONS: readonly string[] = [
  "context-exhausted",
  "compaction-limit",
  "compaction-ineffective",
];

/**
 * `outputAuthority` appears only on a turn the lease's cumulative output
 * authority bound: the remainder was below the per-turn output limit and either
 * became the request (`requestedOutputTokens` equals it) or, under the floor,
 * stopped the turn as `output-authority-exhausted`. The arithmetic is re-done
 * so a record cannot claim a clamp, exhaustion, or context-budget stop it did
 * not earn.
 */
function decodeLegacyOutputAuthority(
  item: Record<string, unknown>,
  turn: {
    decision: string;
    reason: string | undefined;
    effectiveMaxOutputTokens: number;
    requiredMinimumOutputTokens: number;
  },
): void {
  const authority = object(item.outputAuthority, "invalid-record");
  exact(
    authority,
    ["maxOutputTokens", "cumulativeOutputTokens", "floorOutputTokens"],
    "invalid-record",
  );
  const maxOutputTokens = positive(authority.maxOutputTokens, "invalid-record");
  const cumulativeOutputTokens = nonnegative(authority.cumulativeOutputTokens, "invalid-record");
  const floorOutputTokens = positive(authority.floorOutputTokens, "invalid-record");
  const remaining = maxOutputTokens - cumulativeOutputTokens;
  if (
    floorOutputTokens <= turn.requiredMinimumOutputTokens ||
    remaining >= turn.effectiveMaxOutputTokens
  ) {
    fail("invalid-record");
  }
  if (turn.decision === "stop") {
    if (turn.reason === "output-authority-exhausted") {
      if (remaining >= floorOutputTokens) fail("invalid-record");
    } else if (
      remaining < floorOutputTokens &&
      turn.reason !== undefined &&
      OUTPUT_AUTHORITY_OUTRANKED_REASONS.includes(turn.reason)
    ) {
      fail("invalid-record");
    }
    return;
  }
  if (remaining < floorOutputTokens || item.requestedOutputTokens !== remaining) {
    fail("invalid-record");
  }
}

function decodeLegacyCompaction(value: unknown): void {
  const item = object(value, "invalid-record");
  exact(
    item,
    [
      "beforeRequestDigest",
      "afterRequestDigest",
      "estimatedInputTokensBefore",
      "estimatedInputTokensAfter",
      "removedMessages",
      "retainedMessages",
      "preservedCitationCount",
      "preservedCitationDigest",
    ],
    "invalid-record",
  );
  digest(item.beforeRequestDigest, "invalid-record");
  digest(item.afterRequestDigest, "invalid-record");
  nonnegative(item.estimatedInputTokensBefore, "invalid-record");
  nonnegative(item.estimatedInputTokensAfter, "invalid-record");
  positive(item.removedMessages, "invalid-record");
  nonnegative(item.retainedMessages, "invalid-record");
  nonnegative(item.preservedCitationCount, "invalid-record");
  digest(item.preservedCitationDigest, "invalid-record");
}
