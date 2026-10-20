// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessStepInput,
  HarnessStepResult,
  InferenceRetryPolicy,
} from "../execution/contracts.js";
import { setTimeout as wait } from "node:timers/promises";
import { assertWorkflowActive, WORKFLOW_CANCELLED } from "../execution/cancellation.js";
import {
  assertUsableHarnessStepResult,
  inferenceFailureConditionOf,
  InferenceStepError,
} from "../execution/contracts.js";
import type { InferenceRejectionReasonV1 } from "../execution/contracts.js";
import { isInferenceRejectionSubject } from "../execution/rejection-subject.js";
import { retainedInferenceRejection } from "../config/inference-rejection-limits.js";
import type {
  InferenceEvidenceIdentity,
  InferenceExecutionEvidence,
  InferenceFailureCategory,
  InferenceFailureCondition,
} from "../records/contracts.js";
import {
  inferenceAttemptBudgetPositions,
  inferenceConditionRetryability,
  recordRetriesNoProgress,
  inferenceRetryBackoffMs,
  isTransportRetryCategory,
} from "../records/inference-retry-disposition.js";
import {
  projectLastRetryRule,
  recordedFailureCondition,
  RETRY_RULES,
  retryRuleDecision,
  type RetryRuleAttempt,
  type RetryRuleId,
} from "../records/inference-retry-rule.js";
import type { InferenceTransportRetryEvidence } from "../records/contracts.js";
import { formatLimitObservation, limitDefinition } from "../config/limits.js";
import {
  effectiveInferenceRetryCategories,
  inferenceReplayFor,
} from "../records/inference-replay.js";
import { decideSentProviderFailure } from "../model/sent-provider-failure.js";
import type { StepMode } from "../workflow-contracts/contracts.js";
import { technicalResponseCorrection } from "./review-response.js";
import { sourceObligationReasonCorrection } from "./source-obligation.js";
import { qualityResponseCorrection } from "./quality-response-correction.js";

export type InferenceStepExecution =
  | {
      status: "succeeded";
      result: HarnessStepResult;
      evidence: InferenceExecutionEvidence;
    }
  | {
      status: "failed";
      error: Error;
      evidence: InferenceExecutionEvidence;
    };

export interface ExecuteInferenceStepOptions {
  signal?: AbortSignal;
  mode: StepMode;
  /**
   * Set only for a write step whose `execute` restores the step's sealed
   * workspace at the start of every retry. Such a step replays a retryable
   * malformed reply within the budget; other write steps are never replayed.
   */
  hostResetsWrites?: boolean;
  policy: InferenceRetryPolicy;
  /** Content-free revision/context binding copied to every attempt. */
  evidenceIdentity?: InferenceEvidenceIdentity;
  execute: (
    attempt: number,
    correction?: HarnessStepInput["responseCorrection"],
    budget?: InferenceAttemptBudgetContext,
  ) => Promise<HarnessStepResult>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

/** Where the attempt about to run sits in the step's contract-correction count. */
export interface InferenceAttemptBudgetContext {
  /**
   * 1-based count of the attempts whose answer the contract could judge,
   * including this one. Transport-failed attempts do not advance it, so it is
   * the attempt number only when no transport fault occurred.
   */
  contractAttempt: number;
}

const terminalPolicy: InferenceRetryPolicy = {
  maxRetries: 0,
  baseDelayMs: 0,
  maxDelayMs: 0,
  retryableCategories: [],
};

function normalizeFailure(error: unknown): InferenceStepError {
  if (error instanceof InferenceStepError) return error;
  const normalized = new InferenceStepError(
    error instanceof Error ? error.message : String(error),
    "provider-terminal",
    false,
  );
  // Keep the thrown error so the failure class is read from its own
  // catalogued code, not this wrap's category. Non-enumerable, so enumerating
  // serializers do not copy it into a record or log.
  Object.defineProperty(normalized, "cause", {
    value: error,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return normalized;
}

/**
 * Admit a decoder's coded reason onto the attempt record.
 *
 * Record decoders refuse an over-long or off-grammar reason, so persisting one
 * verbatim would make the whole record unreadable. A non-conforming reason is
 * replaced, not dropped, because absence means "no reason recorded"; the
 * in-grammar placeholder says a reason existed and why it did not survive.
 *
 * Nothing here throws: a diagnostic must not be able to fail the step it
 * describes.
 */
function retainableRejection(
  rejection: InferenceStepError["rejection"],
): { rejection: InferenceRejectionReasonV1 } | Record<string, never> {
  if (!rejection) return {};
  return { rejection: retainedInferenceRejection(rejection) };
}

/**
 * The correction a bounded retry receives for a malformed response. The coded
 * reason passes the attempt record's grammar, so a reason the record would
 * refuse reaches the prompt only as the host's placeholder. A rule-specific
 * `detail` comes only from host-owned decoder state, never the error message.
 */
function responseCorrectionFor(
  failure: InferenceStepError,
): NonNullable<HarnessStepInput["responseCorrection"]> {
  const detail =
    sourceObligationReasonCorrection(failure) ??
    technicalResponseCorrection(failure) ??
    qualityResponseCorrection(failure);
  return Object.freeze({
    ...(failure.rejection
      ? { rejection: Object.freeze(retainedInferenceRejection(failure.rejection)) }
      : {}),
    ...(detail ? { detail } : {}),
  });
}

/**
 * What the next attempt is told after a retry `rule`. A contract refusal gets
 * its coded rejection and the rule's statement; a timeout gets only the rule's
 * statement; a blank reply gets nothing. A transport retry keeps the correction
 * the last judged attempt earned, because the contract saw no new answer.
 */
function correctionAfter(
  rule: RetryRuleId,
  failure: InferenceStepError,
  condition: InferenceFailureCondition | undefined,
  previous: HarnessStepInput["responseCorrection"],
): HarnessStepInput["responseCorrection"] {
  if (rule === "retried-transport") return previous;
  // A conclude-now retry names its rule: the harness reads the catalog to
  // withdraw the tools, and the prompt carries the rule's statement.
  if (RETRY_RULES[rule].concludeNow) {
    return Object.freeze({ retryRule: rule, ...(condition === undefined ? {} : { condition }) });
  }
  if (failure.category === "malformed-response") {
    return Object.freeze({
      ...responseCorrectionFor(failure),
      ...(condition === undefined ? {} : { condition }),
    });
  }
  if (RETRY_RULES[rule].statement !== null && condition !== undefined) {
    return Object.freeze({ condition });
  }
  return undefined;
}

/**
 * The exponential wait, lengthened to the failed attempt's observed
 * `Retry-After` (honoured only beside the HTTP status it came with) and
 * bounded by the judging budget's ceiling: `retry.maxDelayMs`, or
 * `retry.transportMaxDelayMs` for a transport retry. The record validators
 * derive the recorded `backoffMs` through the same function.
 */
function delayFor(
  policy: { baseDelayMs: number; maxDelayMs: number },
  failedAttempt: number,
  failure: InferenceStepError,
): number {
  return inferenceRetryBackoffMs(
    policy,
    failedAttempt,
    failure.evidence?.modelTelemetry?.providerError,
  );
}

/**
 * The transport budget this step applies, or `undefined` when its policy has
 * none or retries no transport category. Write steps keep this separate
 * budget, but a non-reset writer needs attempt-wide host proof before retry.
 */
function transportRetryFor(
  policy: InferenceRetryPolicy,
): InferenceTransportRetryEvidence | undefined {
  if (!policy.transport) return undefined;
  const categories = policy.retryableCategories.filter(isTransportRetryCategory);
  if (categories.length === 0) return undefined;
  return {
    maxRetries: policy.transport.maxRetries,
    maxDelayMs: policy.transport.maxDelayMs,
    maxElapsedMs: policy.transport.maxElapsedMs,
    categories,
  };
}

interface TransportBudgetStop {
  name: "retry.maxTransportRetries" | "retry.transportMaxElapsedMs";
  observed: number;
  applied: number;
}

/**
 * The named stop for a transport fault that got no further retry because its
 * budget ran out: the limit's refusal code, the observed value, this step's
 * scope, and the catalog remediation.
 */
function transportBudgetStop(
  failure: InferenceStepError,
  stop: TransportBudgetStop,
): InferenceStepError {
  // The value this step applied, which a host override may have lowered; the
  // code, unit, and remediation come from the catalog entry.
  const bound = { ...limitDefinition(stop.name), value: stop.applied };
  const stopped = new InferenceStepError(
    `${failure.message} Transport retries for this step stopped: ${formatLimitObservation(bound, stop.observed)}`,
    failure.category,
    failure.retryable,
    failure.evidence,
    failure.rejection,
    inferenceFailureConditionOf(failure),
  );
  if (failure.rejectedReplyShape) stopped.rejectedReplyShape = failure.rejectedReplyShape;
  Object.defineProperty(stopped, "cause", {
    value: failure,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return stopped;
}

/**
 * The named transport stop for a rule that ended the step's transport retries,
 * with the value this step observed and the bound it applied.
 */
function transportStopFor(
  rule: RetryRuleId,
  position: ReturnType<typeof inferenceAttemptBudgetPositions>[number],
  transport: InferenceTransportRetryEvidence | undefined,
): TransportBudgetStop | undefined {
  if (!transport) return undefined;
  if (rule === "exhausted-transport-count" || rule === "declined-no-transport-allowance") {
    return {
      name: "retry.maxTransportRetries",
      observed: position.ordinal,
      applied: transport.maxRetries,
    };
  }
  if (rule === "exhausted-transport-elapsed") {
    return {
      name: "retry.transportMaxElapsedMs",
      observed: position.transportElapsedMs,
      applied: transport.maxElapsedMs,
    };
  }
  return undefined;
}

/**
 * The retry budget the failed category is judged against.
 *
 * Every `timeout` attempt costs a whole attempt timer, so it has its own
 * smaller budget; other classes keep `maxRetries`. The timeout budget is
 * clamped to `maxRetries` here because a policy may be constructed directly,
 * bypassing the parse. A policy without the field reads as zero.
 */
export function retryBudgetForCategory(
  policy: InferenceRetryPolicy,
  category: InferenceFailureCategory,
): number {
  if (category !== "timeout") return policy.maxRetries;
  return Math.min(policy.maxTimeoutRetries ?? 0, policy.maxRetries);
}

function isConfiguredRetryable(
  policy: InferenceRetryPolicy,
  category: InferenceFailureCategory,
  retryable: boolean,
): boolean {
  return (
    category !== "context-exhausted" && retryable && policy.retryableCategories.includes(category)
  );
}

type EffectiveRetryPolicyOptions = Pick<
  ExecuteInferenceStepOptions,
  "mode" | "hostResetsWrites" | "policy"
>;

/** The replay mode and the policy {@link executeInferenceStep} actually applies. */
function effectiveInferenceRetryPolicy(options: EffectiveRetryPolicyOptions): {
  replay: ReturnType<typeof inferenceReplayFor>;
  policy: InferenceRetryPolicy;
} {
  const replay = inferenceReplayFor(options.mode, options.hostResetsWrites === true);
  const policy: InferenceRetryPolicy =
    replay === "disabled-write-step"
      ? {
          ...terminalPolicy,
          ...(options.policy.transport ? { transport: options.policy.transport } : {}),
          retryableCategories: effectiveInferenceRetryCategories(
            replay,
            options.policy.retryableCategories,
            options.policy.transport !== undefined,
          ),
        }
      : {
          ...options.policy,
          retryableCategories: effectiveInferenceRetryCategories(
            replay,
            options.policy.retryableCategories,
            options.policy.transport !== undefined,
          ),
        };
  return { replay, policy };
}

/**
 * Whether {@link executeInferenceStep} would schedule no retry after a
 * retryable `malformed-response` refusal of `attempt`: the category's budget
 * is spent, or the effective policy does not retry it (a write step the host
 * does not reset, or a policy without it). It reads the same effective policy
 * as the loop, so neither side infers the other's budget.
 *
 * It answers for the contract count only. The judgment floor and the step-8
 * quality decline act on contract refusals; a cut answer on a judgment step is
 * host-completed in the harness, and a refused stitched answer spends the
 * separate cut-answer budget, which this does not read.
 */
export function isFinalMalformedResponseAttempt(
  options: EffectiveRetryPolicyOptions,
  /** The attempt's `InferenceAttemptBudgetContext.contractAttempt`. */
  contractAttempt: number,
): boolean {
  const { policy } = effectiveInferenceRetryPolicy(options);
  return !(
    contractAttempt <= retryBudgetForCategory(policy, "malformed-response") &&
    isConfiguredRetryable(policy, "malformed-response", true)
  );
}

export async function executeInferenceStep(
  options: ExecuteInferenceStepOptions,
): Promise<InferenceStepExecution> {
  const { replay, policy } = effectiveInferenceRetryPolicy(options);
  const maxRetriesSource = options.policy.maxRetriesSource;
  const transport = transportRetryFor(policy);
  const evidencePolicy = {
    configuredMaxRetries: options.policy.maxRetries,
    effectiveMaxRetries: policy.maxRetries,
    baseDelayMs: options.policy.baseDelayMs,
    maxDelayMs: options.policy.maxDelayMs,
    retryableCategories: [...options.policy.retryableCategories],
    replay,
    ...(maxRetriesSource !== undefined ? { maxRetriesSource } : {}),
    ...(transport ? { transportRetry: structuredClone(transport) } : {}),
    // The applied condition budgets, each held under the effective count.
    conditionRetry: {
      maxTimeoutRetries: Math.min(policy.maxTimeoutRetries ?? 0, policy.maxRetries),
      maxCutAnswerRetries: Math.min(policy.maxCutAnswerRetries ?? 0, policy.maxRetries),
      maxNoProgressRetries: Math.min(policy.maxNoProgressRetries ?? 0, policy.maxRetries),
    },
  };
  const sleep =
    options.sleep ?? ((milliseconds) => wait(milliseconds, undefined, { signal: options.signal }));
  const now = options.now ?? Date.now;
  const attempts: InferenceExecutionEvidence["attempts"] = [];

  let correction: HarnessStepInput["responseCorrection"];
  // Every failed attempt advances exactly one of the two counts, and the rule
  // for each count stops the loop past its own budget, so the loop is bounded
  // by their sum.
  let contractAttempts = 0;
  for (let attempt = 1; ; attempt += 1) {
    const startedAt = now();
    const contractAttempt = contractAttempts + 1;
    try {
      assertWorkflowActive(options.signal);
      const result = assertUsableHarnessStepResult(
        await options.execute(attempt, correction, { contractAttempt }),
      );
      assertWorkflowActive(options.signal);
      attempts.push({
        attempt,
        outcome: "succeeded",
        retryable: false,
        retryScheduled: false,
        // A succeeded attempt has no failure condition or decision, but both
        // facts are still written: an absent pair is reserved for older records.
        conditionRetryability: inferenceConditionRetryability("succeeded", {
          noProgressRetry: recordRetriesNoProgress(evidencePolicy),
        }),
        retryDecision: retryRuleDecision("not-applicable"),
        retryRule: "not-applicable",
        ...(result.answerBytes === undefined ? {} : { answerBytes: result.answerBytes }),
        ...(result.concludeNow ? { concludeNow: structuredClone(result.concludeNow) } : {}),
        ...(result.answerSubmission
          ? { answerSubmission: structuredClone(result.answerSubmission) }
          : {}),
        durationMs: Math.max(0, now() - startedAt),
        ...(result.model ? { model: result.model } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.tools ? { tools: result.tools } : {}),
        ...(result.writeSettlement === undefined
          ? {}
          : { writeSettlement: result.writeSettlement }),
        ...(options.evidenceIdentity
          ? { identity: structuredClone(options.evidenceIdentity) }
          : {}),
        ...(result.turns ? { turns: structuredClone(result.turns) } : {}),
        ...(result.judgmentRowKeyAudit
          ? { judgmentRowKeyAudit: structuredClone(result.judgmentRowKeyAudit) }
          : {}),
        // Finish reason, output against the allowance, provider latency.
        ...(result.modelTelemetry
          ? { modelTelemetry: structuredClone(result.modelTelemetry) }
          : {}),
        ...(result.providerResponses
          ? { providerResponses: structuredClone(result.providerResponses) }
          : {}),
        ...(result.efficiency ? { efficiency: structuredClone(result.efficiency) } : {}),
        ...(result.executionLease
          ? { executionLease: structuredClone(result.executionLease) }
          : {}),
      });
      return {
        status: "succeeded",
        result,
        evidence: { ...evidencePolicy, attempts },
      };
    } catch (error) {
      const hostCheckpointFailure =
        error instanceof InferenceStepError && error.category === "host-runtime-failure";
      const failure =
        options.signal?.aborted && !hostCheckpointFailure
          ? new InferenceStepError(
              WORKFLOW_CANCELLED,
              "provider-terminal",
              false,
              error instanceof InferenceStepError ? error.evidence : undefined,
              error instanceof InferenceStepError ? error.rejection : undefined,
            )
          : // A sent request's failure is decided by the transport's typed class
            // before any message-text rule. The telemetry is the attempt's last
            // landed turn, so it may only decide a failure that is that provider
            // answer; see `decideSentProviderFailure`.
            decideSentProviderFailure(normalizeFailure(error));
      if (
        options.signal?.aborted &&
        !hostCheckpointFailure &&
        error instanceof InferenceStepError
      ) {
        failure.rejectedReplyShape = error.rejectedReplyShape;
        failure.rejectedReplyExcerpt = error.rejectedReplyExcerpt;
      }
      const durationMs = Math.max(0, now() - startedAt);
      const failureRetryable = failure.category === "context-exhausted" ? false : failure.retryable;
      // The one decider: the same projection every record validator runs over
      // the recorded attempts, applied to the attempts so far plus this one.
      const condition = recordedFailureCondition(failure.category, failure.condition);
      const judged: RetryRuleAttempt = {
        outcome: failure.category,
        retryable: failureRetryable,
        ...(condition === undefined ? {} : { condition }),
        durationMs,
        ...(failure.evidence?.modelTelemetry
          ? { modelTelemetry: failure.evidence.modelTelemetry }
          : {}),
        ...(failure.evidence?.writeSettlement === undefined
          ? {}
          : { writeSettlement: failure.evidence.writeSettlement }),
      };
      const rule = projectLastRetryRule(evidencePolicy, [...attempts, judged]);
      const retry = retryRuleDecision(rule) === "retried";
      const position = inferenceAttemptBudgetPositions(evidencePolicy, [...attempts, judged]).at(
        -1,
      )!;
      // Backoff follows the budget that judged the attempt: the contract
      // ordinal for every contract and condition retry, the transport ordinal
      // and ceiling for a transport retry.
      const backoffMs = retry ? delayFor(position.backoff, position.ordinal, failure) : undefined;
      const transported = position.budget === "transport";
      // A refusal nobody may retry is not a budget stop, whichever count it hit.
      const stop = failureRetryable ? transportStopFor(rule, position, transport) : undefined;
      if (!transported) contractAttempts += 1;
      attempts.push({
        attempt,
        outcome: failure.category,
        ...(failure.hostFailureOrigin === undefined
          ? {}
          : { hostFailureOrigin: structuredClone(failure.hostFailureOrigin) }),
        retryable: failureRetryable,
        retryScheduled: retry,
        // `retryable` is the reporting party's flag and `retryScheduled` cannot
        // tell a declined retry from an exhausted budget, so the condition's
        // retryability and the policy's decision are recorded as separate
        // derived facts. The operator surface derives remaining retries from
        // effectiveMaxRetries, attempt, and retryScheduled.
        conditionRetryability: inferenceConditionRetryability(failure.category, {
          noProgressRetry: recordRetriesNoProgress(evidencePolicy),
        }),
        retryDecision: retryRuleDecision(rule),
        // The catalog rule behind the decision, so no reader has to guess it.
        retryRule: rule,
        ...(condition === undefined ? {} : { condition }),
        durationMs,
        // `outcome` carries only the retry category; this names which
        // validation refused the response.
        ...retainableRejection(failure.rejection),
        // The rejected reply's structural fingerprint (keys, value types,
        // lengths, parse position), never its text.
        ...(failure.rejectedReplyShape
          ? { rejectedReplyShape: structuredClone(failure.rejectedReplyShape) }
          : {}),
        // Bounded head, tail, and parse-position text, redacted at capture.
        ...(failure.rejectedReplyExcerpt
          ? { rejectedReplyExcerpt: structuredClone(failure.rejectedReplyExcerpt) }
          : {}),
        // What the rule refused, as paths the host knows; never reply text.
        ...(failure.rejectionSubject && isInferenceRejectionSubject(failure.rejectionSubject)
          ? { rejectionSubject: structuredClone(failure.rejectionSubject) }
          : {}),
        // How the provider ended this attempt, including its error class.
        ...(failure.evidence?.modelTelemetry
          ? { modelTelemetry: structuredClone(failure.evidence.modelTelemetry) }
          : {}),
        ...(failure.evidence?.providerResponses
          ? { providerResponses: structuredClone(failure.evidence.providerResponses) }
          : {}),
        ...(failure.evidence?.efficiency
          ? { efficiency: structuredClone(failure.evidence.efficiency) }
          : {}),
        ...(backoffMs === undefined ? {} : { backoffMs }),
        ...(failure.evidence?.model ? { model: failure.evidence.model } : {}),
        ...(failure.evidence?.usage ? { usage: failure.evidence.usage } : {}),
        ...(failure.evidence?.tools ? { tools: failure.evidence.tools } : {}),
        ...(failure.evidence?.writeSettlement === undefined
          ? {}
          : { writeSettlement: failure.evidence.writeSettlement }),
        ...(options.evidenceIdentity
          ? { identity: structuredClone(options.evidenceIdentity) }
          : {}),
        ...(failure.evidence?.turns ? { turns: structuredClone(failure.evidence.turns) } : {}),
        ...(failure.evidence?.executionLease
          ? { executionLease: structuredClone(failure.evidence.executionLease) }
          : {}),
        // A forced answer that was then refused still records that the host
        // asked for it.
        ...(failure.evidence?.concludeNow
          ? { concludeNow: structuredClone(failure.evidence.concludeNow) }
          : {}),
        // Where the host's own attempt timer found the attempt.
        ...(failure.evidence?.deadlineTurn && condition === "attempt-deadline"
          ? { deadlineTurn: failure.evidence.deadlineTurn }
          : {}),
        // Which answer path the refused or stopped attempt took, and how far
        // its submission and report got.
        ...(failure.evidence?.answerSubmission
          ? { answerSubmission: structuredClone(failure.evidence.answerSubmission) }
          : {}),
      });
      if (!retry) {
        return {
          status: "failed",
          error: stop ? transportBudgetStop(failure, stop) : failure,
          evidence: { ...evidencePolicy, attempts },
        };
      }
      if (backoffMs === undefined) {
        throw new Error("Retry scheduling did not produce a bounded delay.");
      }
      // Pass the coded host rejection, never rejected text or an error message.
      // The prompt builder maps it onto the host-owned rule-hint catalog. A
      // transport fault gave the contract no new answer to judge, so the
      // correction the last judged attempt earned still applies.
      correction = correctionAfter(rule, failure, condition, correction);
      try {
        await sleep(backoffMs);
      } catch (error) {
        assertWorkflowActive(options.signal);
        throw error;
      }
      assertWorkflowActive(options.signal);
    }
  }
}
