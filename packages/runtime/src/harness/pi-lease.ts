// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ExecutionCheckpointTurnDisposition,
  ExecutionLeaseRuntimeEvidenceV1,
  ExecutionLeaseRuntimeTerminalDisposition,
} from "../execution/contracts.js";
import {
  createExecutionChargeableAttemptPolicy,
  createAbsentChargeableAttemptPolicyV2,
  executionLeaseChargeableAttemptCeiling,
  deriveStateBoundStopReasons,
  selectExecutionStopReason,
  createExecutionProgressObservation,
  prepareExecutionLeaseCoordinator,
  reduceExecutionLeaseCoordinator,
  type BoundExecutionPricingV1,
  type ExecutionContextObservationV1,
  type AnyExecutionCoordinatorDecision,
  type ExecutionLeaseCoordinatorV1,
  type AnyExecutionLeasePolicyV1OrV2,
  type ExecutionProgressObservationV1,
  type ExecutionResourceEnvelopeV1,
  type ExecutionTerminalReason,
  type ExecutionToolBatchCallV1,
  type ExecutionToolBatchResultV1,
} from "../execution/index.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import { canonicalDigest, sha256 } from "../content-ir/canonical.js";

const SHA256 = /^[a-f0-9]{64}$/u;
export const PI_CHECKPOINT_PROMPT = [
  "DocsFab execution checkpoint. Tools are unavailable for this turn.",
  "Return exactly one JSON object and no prose:",
  '{"schemaVersion":1,"kind":"docsfab-execution-checkpoint-rationale","authority":"non-authoritative"}',
  "Do not include prompts, repository content, tool arguments or results, credentials, paths, or permission requests.",
  "This JSON is optional telemetry only. The host decides whether execution continues.",
].join("\n");

export interface PiProviderTurnReservationV1 extends ExecutionResourceEnvelopeV1 {
  kind: "ordinary" | "checkpoint";
}

export interface PiProviderTurnUsageV1 {
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  compactions: number;
  context: ExecutionContextObservationV1;
}

export interface PiBatchAuthorityCallV1 {
  id: string;
  name: string;
  sha256: string;
}

export interface PiBatchSettlementResultV1 {
  toolCallId: string;
  isError: boolean;
}

/**
 * Content-minimized, attempt-local record of a settled Pi tool batch. The
 * ordinal is deliberate: a provider tool-call ID is not globally unique and
 * cannot identify a replay by itself.
 */
export interface PiBatchSettlementTombstoneV1 {
  authoritySha256: string;
  results: readonly {
    ordinal: number;
    callSha256: string;
    outcome: "succeeded" | "failed";
  }[];
}

export type PiBatchSettlementClassificationV1 =
  | { kind: "settle"; tombstone: PiBatchSettlementTombstoneV1 }
  | { kind: "duplicate-settle"; tombstone: PiBatchSettlementTombstoneV1 }
  | { kind: "conflict"; tombstone: PiBatchSettlementTombstoneV1 };

/** Attempt-local, content-free settlement event projection. */
export interface PiAttemptBatchSettlementEventV1 {
  kind: PiBatchSettlementClassificationV1["kind"];
  authoritySha256: string;
}

export interface PiProgressRecommendationV1 {
  observationSha256: string;
  recommendationSha256: string;
  recommendation: "renew" | "stop";
  renewable: boolean;
}

/** Deterministic host recommendation from attempt-local lease progress. */
export function recommendPiProgress(input: {
  readonly leaseNumber: number;
  readonly uniqueSuccessfulCalls: number;
  readonly failedCalls: number;
  readonly executedCalls: number;
  readonly experimentalAnswerRecordDiscoveryRenewal?: true;
}): PiProgressRecommendationV1 {
  const discoveryRenewal = input.experimentalAnswerRecordDiscoveryRenewal === true;
  const observationSha256 = canonicalDigest({
    kind: "docsfab-pi-progress-observation",
    leaseNumber: input.leaseNumber,
    uniqueSuccessfulCalls: input.uniqueSuccessfulCalls,
    failedCalls: input.failedCalls,
    executedCalls: input.executedCalls,
    renewalRationale: discoveryRenewal
      ? "experimental-answer-record-discovery-continues-correctable-refusals"
      : "requires-useful-success-in-current-lease",
  });
  const renewable = discoveryRenewal || input.uniqueSuccessfulCalls > 0;
  const recommendation = renewable ? "renew" : "stop";
  return {
    observationSha256,
    recommendation,
    renewable,
    recommendationSha256: canonicalDigest({
      observationSha256,
      recommendation,
      renewable,
      authority: "host-deterministic",
    }),
  };
}

export interface PiCheckpointRationaleV1 {
  schemaVersion: 1;
  kind: "docsfab-execution-checkpoint-rationale";
  authority: "non-authoritative";
}

interface RuntimeCheckpoint {
  sequence: number;
  leaseNumber: number;
  disposition: ExecutionCheckpointTurnDisposition;
  outputSha256: string | null;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  progressObservationSha256: string | null;
  progressRecommendationSha256: string | null;
  coordinatorSha256: string;
}

export interface PiExecutionLeaseControllerOptions {
  policy: AnyExecutionLeasePolicyV1OrV2;
  identity: Parameters<typeof prepareExecutionLeaseCoordinator>[0]["identity"];
  pricing: BoundExecutionPricingV1;
  context: ExecutionContextObservationV1;
  requestCapacity?: { maxInputTokens: number; maxOutputTokens: number };
  maxChargeableAttempts?: number;
}

export interface PiExecutionLeaseEvidenceBindingV1 {
  inferenceAttempt: number;
  retriesConsumed: number;
  repositoryRevision: string;
  providerTurnLedgerSha256: string;
  usageSha256: string;
  toolsSha256: string;
}

/**
 * Attempt-scoped host adapter between Pi lifecycle boundaries and the execution
 * lease coordinator. It has no Pi types, so the lease contracts stay usable by
 * another harness.
 */
export class PiExecutionLeaseController {
  private coordinatorValue: ExecutionLeaseCoordinatorV1;
  private readonly transitions: AnyExecutionCoordinatorDecision[] = [];
  private readonly checkpointTurns: RuntimeCheckpoint[] = [];
  private checkpointProviderTurnsValue = 0;
  private readonly requestCapacity: { maxInputTokens: number; maxOutputTokens: number };
  private terminalDispositionValue: ExecutionLeaseRuntimeTerminalDisposition | undefined;

  public constructor(options: PiExecutionLeaseControllerOptions) {
    if (options.policy.schemaVersion === 2 && !options.requestCapacity) {
      throw new Error(
        "experimental discovery requires explicit per-request input and output capacities.",
      );
    }
    this.requestCapacity = options.requestCapacity ?? {
      maxInputTokens:
        options.policy.schemaVersion === 1
          ? options.policy.cumulative.maxInputTokens
          : options.context.availableInputTokens,
      maxOutputTokens:
        options.policy.schemaVersion === 1
          ? options.policy.cumulative.maxOutputTokens
          : options.context.requiredInputTokens,
    };
    const chargeableAttemptPolicy =
      options.policy.schemaVersion === 2
        ? createAbsentChargeableAttemptPolicyV2()
        : createExecutionChargeableAttemptPolicy(
            {
              maxChargeableAttempts:
                options.maxChargeableAttempts ??
                executionLeaseChargeableAttemptCeiling(options.policy),
            },
            executionLeaseChargeableAttemptCeiling(options.policy),
          );
    const prepared = prepareExecutionLeaseCoordinator({
      policy: options.policy,
      chargeableAttemptPolicy,
      identity: options.identity,
      pricing: options.pricing,
      context: options.context,
    });
    this.coordinatorValue = prepared.coordinator;
    this.transitions.push(prepared.decision);
    if (prepared.coordinator.terminalReason) {
      this.terminalDispositionValue = dispositionForReason(prepared.coordinator.terminalReason);
    }
  }

  public get coordinator(): ExecutionLeaseCoordinatorV1 {
    return this.coordinatorValue;
  }

  public get perRequestCapacity(): { maxInputTokens: number; maxOutputTokens: number } {
    return this.requestCapacity;
  }

  public get checkpointRequired(): boolean {
    return this.coordinatorValue.phase === "checkpoint-required";
  }

  public preflightProviderTurn(reservation: PiProviderTurnReservationV1): void {
    validateReservation(reservation);
    const coordinator = this.coordinatorValue;
    const expectedPhase = reservation.kind === "checkpoint" ? "checkpoint-required" : "active";
    if (coordinator.phase !== expectedPhase) fail("provider turn is not authorized");
    const { policy, state, context, pricing } = coordinator;
    if (
      (policy.schemaVersion === 1 &&
        (policy.maxProviderTurns - state.providerTurns < reservation.providerTurns ||
          policy.maxCompactions - state.compactions < reservation.compactions ||
          policy.cumulative.maxInputTokens - state.cumulativeInputTokens <
            reservation.inputTokens ||
          policy.cumulative.maxOutputTokens - state.cumulativeOutputTokens <
            reservation.outputTokens ||
          policy.cumulative.maxElapsedMs - state.elapsedMs < reservation.elapsedMs)) ||
      context.status !== "ready" ||
      context.availableInputTokens < reservation.contextInputTokens
    ) {
      fail("provider turn exceeds cumulative authority");
    }
    if (policy.schemaVersion === 1 && policy.cumulative.maxKnownCostMicrousd !== undefined) {
      if (pricing.status !== "known" || state.cost.status !== "known") {
        fail("provider turn has no current pricing authority");
      }
      const additional = costForReservation(pricing, reservation);
      if (policy.cumulative.maxKnownCostMicrousd - state.cost.microusd < additional) {
        fail("provider turn exceeds cumulative cost authority");
      }
    }
  }

  public requestToolBatch(
    calls: readonly ExecutionToolBatchCallV1[],
    reservation: PiProviderTurnReservationV1,
  ): AnyExecutionCoordinatorDecision {
    if (reservation.kind !== "ordinary") fail("checkpoint turns cannot dispatch tools");
    if (calls.every((call) => call.authorization === "denied")) {
      validateDeniedOnlyReservation(reservation);
      if (this.coordinatorValue.phase !== "active") fail("tool batch is not authorized");
    } else {
      this.preflightProviderTurn(reservation);
    }
    return this.reduce({
      kind: "request-tool-batch",
      calls: calls.map((call) => ({ ...call })),
      envelope: envelopeOf(reservation),
    });
  }

  public settleToolBatch(
    results: readonly ExecutionToolBatchResultV1[],
    usage: PiProviderTurnUsageV1,
  ): AnyExecutionCoordinatorDecision {
    return this.reduce({
      kind: "settle-tool-batch",
      results: results.map((result) => ({ ...result })),
      observation: this.nextObservation(usage),
    });
  }

  public failToolBatch(
    results: readonly ExecutionToolBatchResultV1[],
    usage: PiProviderTurnUsageV1,
    reason: Exclude<ExecutionTerminalReason, "completed">,
    lateDeniedCallSha256?: string,
  ): AnyExecutionCoordinatorDecision {
    if (lateDeniedCallSha256 !== undefined && !SHA256.test(lateDeniedCallSha256)) {
      fail("invalid late-denied tool call identity");
    }
    const decision = this.reduce({
      kind: "fail-tool-batch",
      results: results.map((result) => ({ ...result })),
      observation: this.nextObservation(usage),
      reason,
      ...(lateDeniedCallSha256 === undefined ? {} : { lateDeniedCallSha256 }),
    });
    this.terminalDispositionValue = dispositionForReason(reason);
    return decision;
  }

  public settleOrdinaryProviderTurn(usage: PiProviderTurnUsageV1): AnyExecutionCoordinatorDecision {
    return this.reduce({
      kind: "observe-provider-turn",
      observation: this.nextObservation(usage),
    });
  }

  /** Account an ordinary turn whose denied-only batch itself crossed a boundary. */
  public settleBoundaryProviderTurn(usage: PiProviderTurnUsageV1): AnyExecutionCoordinatorDecision {
    if (this.coordinatorValue.phase !== "checkpoint-required") {
      fail("boundary provider turn requires a checkpoint boundary");
    }
    return this.reduce({
      kind: "observe-checkpoint-turn",
      observation: this.nextObservation(usage),
    });
  }

  public settleCheckpointTurn(
    output: string,
    usage: PiProviderTurnUsageV1,
    recommendation: PiProgressRecommendationV1,
    nextTranche: ExecutionResourceEnvelopeV1,
  ): AnyExecutionCoordinatorDecision {
    const observed = this.reduce({
      kind: "observe-checkpoint-turn",
      observation: this.nextObservation(usage),
    });
    this.checkpointProviderTurnsValue += 1;
    const parsed = parseCheckpointRationale(output);
    validateRecommendation(recommendation);
    // Provider output is telemetry, separate from the host's renewal authority.
    // Its disposition is kept for diagnosis, never as a continuation gate.
    const disposition: ExecutionCheckpointTurnDisposition = !output.trim()
      ? "blank"
      : parsed === undefined
        ? "malformed"
        : "accepted";
    const checkpoint: RuntimeCheckpoint = {
      sequence: this.checkpointTurns.length + 1,
      leaseNumber: this.coordinatorValue.state.leaseNumber,
      disposition,
      outputSha256: output ? sha256(output) : null,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      elapsedMs: usage.elapsedMs,
      progressObservationSha256: recommendation.observationSha256,
      progressRecommendationSha256: recommendation.recommendationSha256,
      coordinatorSha256: observed.coordinatorSha256,
    };
    this.checkpointTurns.push(checkpoint);
    if (recommendation.renewable && recommendation.recommendation === "renew") {
      return this.renew(nextTranche);
    }
    return this.stop("checkpoint-not-renewable", "progress-stopped");
  }

  /**
   * Apply host renew/stop from executed-call accounting without a new provider
   * completion. Records no checkpoint row: there was no JSON turn to observe.
   */
  public applyHostCheckpoint(
    recommendation: PiProgressRecommendationV1,
    nextTranche: ExecutionResourceEnvelopeV1,
  ): AnyExecutionCoordinatorDecision {
    if (this.coordinatorValue.phase !== "checkpoint-required") {
      fail("host checkpoint requires a checkpoint boundary");
    }
    validateRecommendation(recommendation);
    if (recommendation.renewable && recommendation.recommendation === "renew") {
      return this.renew(nextTranche);
    }
    return this.stop("checkpoint-not-renewable", "progress-stopped");
  }

  public failCheckpointTurn(
    disposition: Exclude<ExecutionCheckpointTurnDisposition, "accepted" | "progress-stopped">,
    usage?: Partial<PiProviderTurnUsageV1>,
  ): AnyExecutionCoordinatorDecision {
    if (disposition === "blank" || disposition === "malformed") {
      // Normally settled by settleCheckpointTurn so provider usage is charged;
      // this path is for failures before a usable provider response exists.
    }
    this.checkpointTurns.push({
      sequence: this.checkpointTurns.length + 1,
      leaseNumber: this.coordinatorValue.state.leaseNumber,
      disposition,
      outputSha256: null,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      elapsedMs: usage?.elapsedMs ?? 0,
      progressObservationSha256: null,
      progressRecommendationSha256: null,
      coordinatorSha256: this.coordinatorValue.coordinatorSha256,
    });
    return this.stop(
      disposition === "cancelled"
        ? "cancellation-requested"
        : disposition === "context-exhausted"
          ? "context-exhausted"
          : disposition === "provider-failed"
            ? "provider-terminal"
            : "checkpoint-not-renewable",
      disposition,
    );
  }

  public failObservedCheckpointTurn(
    disposition: Exclude<ExecutionCheckpointTurnDisposition, "accepted" | "progress-stopped">,
    usage: PiProviderTurnUsageV1,
  ): AnyExecutionCoordinatorDecision {
    const observed = this.reduce({
      kind: "observe-checkpoint-turn",
      observation: this.nextObservation(usage),
    });
    this.checkpointProviderTurnsValue += 1;
    this.checkpointTurns.push({
      sequence: this.checkpointTurns.length + 1,
      leaseNumber: this.coordinatorValue.state.leaseNumber,
      disposition,
      outputSha256: null,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      elapsedMs: usage.elapsedMs,
      progressObservationSha256: null,
      progressRecommendationSha256: null,
      coordinatorSha256: observed.coordinatorSha256,
    });
    return this.stop(
      disposition === "cancelled"
        ? "cancellation-requested"
        : disposition === "context-exhausted"
          ? "context-exhausted"
          : disposition === "provider-failed"
            ? "provider-terminal"
            : "checkpoint-not-renewable",
      disposition,
    );
  }

  /**
   * End the attempt on a host no-progress decision. The terminal reason is the
   * one the lease contract derives for this state behind a host-requested
   * checkpoint, so a stop in the last lease, or at another state bound,
   * records that bound instead of a reason the contract would refuse.
   */
  public stopForNoProgress(): AnyExecutionCoordinatorDecision {
    const { policy, state } = this.coordinatorValue;
    const reason =
      selectExecutionStopReason(deriveStateBoundStopReasons(policy, state, "host-requested")) ??
      "checkpoint-not-renewable";
    return this.stop(
      reason,
      reason === "checkpoint-not-renewable" ? "progress-stopped" : dispositionForReason(reason),
    );
  }

  public complete(): AnyExecutionCoordinatorDecision {
    const decision = this.reduce({ kind: "complete" });
    this.terminalDispositionValue = "completed";
    return decision;
  }

  public stop(
    reason: ExecutionTerminalReason,
    disposition: ExecutionLeaseRuntimeTerminalDisposition = dispositionForReason(reason),
  ): AnyExecutionCoordinatorDecision {
    if (!terminalDispositionMatchesReason(reason, disposition)) {
      fail("terminal disposition does not match reason");
    }
    const decision = this.reduce({ kind: "stop", reason });
    this.terminalDispositionValue = disposition;
    return decision;
  }

  public evidence(binding: PiExecutionLeaseEvidenceBindingV1): ExecutionLeaseRuntimeEvidenceV1 {
    validateEvidenceBinding(binding, this.coordinatorValue);
    const coordinator = this.coordinatorValue;
    if (
      (coordinator.phase === "terminal") !==
      (coordinator.terminalReason !== undefined && this.terminalDispositionValue !== undefined)
    ) {
      fail("terminal evidence disposition mismatch");
    }
    const body = {
      schemaVersion: 1 as const,
      kind: "docsfab-pi-execution-lease-evidence" as const,
      ...(coordinator.policy.schemaVersion === 2
        ? { policyVersion: 2 as const, aggregatePolicy: { kind: "absent" as const } }
        : {}),
      policySha256: coordinator.policy.policySha256,
      identitySha256: coordinator.identity.identitySha256,
      coordinatorSha256: coordinator.coordinatorSha256,
      phase: coordinator.phase,
      ...(coordinator.terminalReason ? { terminalReason: coordinator.terminalReason } : {}),
      ...(this.terminalDispositionValue
        ? { terminalDisposition: this.terminalDispositionValue }
        : {}),
      providerTurns: coordinator.state.providerTurns,
      checkpointProviderTurns: this.checkpointProviderTurnsValue,
      compactions: coordinator.state.compactions,
      cumulativeInputTokens: coordinator.state.cumulativeInputTokens,
      cumulativeOutputTokens: coordinator.state.cumulativeOutputTokens,
      elapsedMs: coordinator.state.elapsedMs,
      toolCalls: { ...coordinator.state.toolCalls },
      ...(coordinator.state.toolCallsByScope === undefined
        ? {}
        : {
            toolCallsByScope: { ...coordinator.state.toolCallsByScope },
            answerRecordCallsAdmitted: coordinator.state.answerRecordCallsAdmitted!,
            ...(coordinator.policy.schemaVersion === 1 &&
            coordinator.policy.answerRecordCallCeiling !== undefined
              ? {
                  toolCallCeilings: {
                    reading: coordinator.policy.hardToolCallCeiling,
                    answerRecord: coordinator.policy.answerRecordCallCeiling,
                  },
                }
              : {}),
            ...(coordinator.policy.sharedToolCallCapacity
              ? { toolCallCapacityMode: "shared" as const }
              : {}),
            ...(coordinator.chargeableAttemptPolicy.schemaVersion === 1
              ? {
                  chargeableAttemptCeiling:
                    coordinator.chargeableAttemptPolicy.maxChargeableAttempts,
                }
              : {}),
          }),
      checkpoints: this.checkpointTurns.map((checkpoint) => ({ ...checkpoint })),
      resume: {
        coordinatorSha256: coordinator.coordinatorSha256,
        stateSha256: coordinator.state.stateSha256,
        leaseCheckpointSha256: coordinator.checkpoints.at(-1)?.checkpointSha256 ?? null,
        coordinatorCheckpointSha256:
          coordinator.coordinatorCheckpoints.at(-1)?.checkpointSha256 ?? null,
        decisionSha256: this.transitions.at(-1)?.decisionSha256 ?? null,
      },
      binding: { ...binding },
    };
    return Object.freeze({ ...body, evidenceSha256: hash(body) });
  }

  /**
   * Ask the coordinator to renew, and record a terminal disposition when it
   * refuses. A denied renewal can leave the coordinator terminal without passing
   * through `stop()`, and `evidence()` refuses a terminal lease with no
   * disposition, so the failure path would otherwise throw with no lease evidence.
   */
  private renew(nextTranche: ExecutionResourceEnvelopeV1): AnyExecutionCoordinatorDecision {
    const decision = this.reduce({ kind: "renew", nextTranche });
    const reason = this.coordinatorValue.terminalReason;
    if (
      this.coordinatorValue.phase === "terminal" &&
      reason !== undefined &&
      this.terminalDispositionValue === undefined
    ) {
      this.terminalDispositionValue = dispositionForReason(reason);
    }
    return decision;
  }

  private nextObservation(usage: PiProviderTurnUsageV1): ExecutionProgressObservationV1 {
    validateUsage(usage);
    const state = this.coordinatorValue.state;
    return createExecutionProgressObservation({
      sequence: (this.coordinatorValue.lastObservation?.sequence ?? 0) + 1,
      providerTurns: state.providerTurns + 1,
      compactions: state.compactions + usage.compactions,
      cumulativeInputTokens: state.cumulativeInputTokens + usage.inputTokens,
      cumulativeOutputTokens: state.cumulativeOutputTokens + usage.outputTokens,
      elapsedMs: state.elapsedMs + usage.elapsedMs,
      context: usage.context,
    });
  }

  private reduce(
    command: Parameters<typeof reduceExecutionLeaseCoordinator>[0]["command"],
  ): AnyExecutionCoordinatorDecision {
    const result = reduceExecutionLeaseCoordinator({
      coordinator: this.coordinatorValue,
      expectedCoordinatorSha256: this.coordinatorValue.coordinatorSha256,
      command,
    });
    this.coordinatorValue = result.coordinator;
    this.transitions.push(result.decision);
    return result.decision;
  }
}

export function digestPiToolCall(id: string, name: string, ordinal: number): string {
  if (!id || !name || !Number.isSafeInteger(ordinal) || ordinal < 0) {
    fail("invalid tool call identity");
  }
  return hash({ kind: "docsfab-pi-tool-call", idSha256: sha256(id), name, ordinal });
}

export function createPiBatchAuthoritySha256(input: {
  inferenceAttempt: number;
  providerTurn: number;
  sequence: number;
  assistantSha256: string;
  calls: readonly PiBatchAuthorityCallV1[];
}): string {
  if (
    !Number.isSafeInteger(input.inferenceAttempt) ||
    input.inferenceAttempt <= 0 ||
    !Number.isSafeInteger(input.providerTurn) ||
    input.providerTurn <= 0 ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence <= 0 ||
    !SHA256.test(input.assistantSha256)
  )
    fail("invalid batch authority");
  validatePiBatchCalls(input.calls);
  return hash({
    kind: "docsfab-pi-tool-batch-authority",
    inferenceAttempt: input.inferenceAttempt,
    providerTurn: input.providerTurn,
    sequence: input.sequence,
    assistantSha256: input.assistantSha256,
    calls: input.calls.map((call, ordinal) => ({
      ordinal,
      idSha256: sha256(call.id),
      name: call.name,
      callSha256: call.sha256,
    })),
  });
}

export function validatePiBatchCalls(calls: readonly PiBatchAuthorityCallV1[]): void {
  if (
    calls.length === 0 ||
    new Set(calls.map((call) => call.id)).size !== calls.length ||
    new Set(calls.map((call) => call.sha256)).size !== calls.length ||
    calls.some(
      (call, ordinal) =>
        !call.id ||
        !call.name ||
        !SHA256.test(call.sha256) ||
        call.sha256 !== digestPiToolCall(call.id, call.name, ordinal),
    )
  ) {
    fail("duplicate or invalid tool call identity");
  }
}

/** Validate Pi's source-order result artifacts before any coordinator settlement. */
export function validatePiBatchSettlement(
  calls: readonly PiBatchAuthorityCallV1[],
  authorizedSha256: readonly string[],
  results: readonly PiBatchSettlementResultV1[],
): ExecutionToolBatchResultV1[] {
  validatePiBatchCalls(calls);
  const authorizedPositions: number[] = [];
  let previousPosition = -1;
  for (const digest of authorizedSha256) {
    const position = calls.findIndex((call) => call.sha256 === digest);
    if (position <= previousPosition) fail("invalid authorized batch order");
    authorizedPositions.push(position);
    previousPosition = position;
  }
  if (new Set(authorizedSha256).size !== authorizedSha256.length) {
    fail("invalid authorized batch prefix");
  }
  if (
    results.length !== calls.length ||
    new Set(results.map((result) => result.toolCallId)).size !== results.length ||
    results.some(
      (result, index) =>
        result.toolCallId !== calls[index]?.id || typeof result.isError !== "boolean",
    )
  ) {
    fail("missing, duplicate, foreign, or reordered tool result");
  }
  return authorizedPositions.map((position) => ({
    callSha256: calls[position]!.sha256,
    outcome: results[position]!.isError ? "failed" : "succeeded",
  }));
}

/**
 * Recognize a provider turn whose tool calls never reached host preflight, so
 * no batch was requested. Pi resolves a call to an error result before
 * `beforeToolCall` when the tool is unregistered, the arguments fail its
 * schema, or the message was cut at the output-token limit.
 *
 * Security: admits only one error result per proposed call, in source order,
 * under this turn's exact distinct call IDs, so a forged or replayed batch
 * cannot get a successful result credited.
 *
 * Necessary, not sufficient: an executed batch can also fail every call.
 * Callers must also confirm no batch authority exists for this turn, then
 * settle it as an ordinary provider turn with zero executed tool calls.
 */
export function isPiUnexecutedToolBatchTurn(
  calls: readonly { id: string }[],
  results: readonly PiBatchSettlementResultV1[],
): boolean {
  return (
    calls.length > 0 &&
    results.length === calls.length &&
    new Set(calls.map((call) => call.id)).size === calls.length &&
    results.every(
      (result, index) => result.isError === true && result.toolCallId === calls[index]?.id,
    )
  );
}

/**
 * Classify a complete normalized result vector against this attempt's immutable
 * tombstone. Accepts no provider IDs, payloads, paths, or tool bytes: authority
 * plus source ordinal and result bit identify a settled batch.
 */
export function classifyPiBatchSettlement(
  authoritySha256: string,
  results: readonly { callSha256: string; outcome: "succeeded" | "failed" }[],
  tombstone?: PiBatchSettlementTombstoneV1,
): PiBatchSettlementClassificationV1 {
  if (!SHA256.test(authoritySha256)) fail("invalid batch tombstone authority");
  const normalized = results.map((result, ordinal) => {
    if (
      !SHA256.test(result.callSha256) ||
      (result.outcome !== "succeeded" && result.outcome !== "failed")
    ) {
      fail("invalid batch tombstone result");
    }
    return Object.freeze({ ordinal, callSha256: result.callSha256, outcome: result.outcome });
  });
  if (new Set(normalized.map((result) => result.callSha256)).size !== normalized.length) {
    fail("duplicate batch tombstone result");
  }
  const candidate: PiBatchSettlementTombstoneV1 = Object.freeze({
    authoritySha256,
    results: Object.freeze(normalized),
  });
  if (!tombstone) return { kind: "settle", tombstone: candidate };
  if (
    !SHA256.test(tombstone.authoritySha256) ||
    tombstone.results.some(
      (result, ordinal) =>
        result.ordinal !== ordinal ||
        !SHA256.test(result.callSha256) ||
        (result.outcome !== "succeeded" && result.outcome !== "failed"),
    ) ||
    new Set(tombstone.results.map((result) => result.callSha256)).size !== tombstone.results.length
  ) {
    fail("invalid batch tombstone");
  }
  const matches =
    tombstone.authoritySha256 === candidate.authoritySha256 &&
    tombstone.results.length === candidate.results.length &&
    tombstone.results.every(
      (result, ordinal) =>
        result.ordinal === candidate.results[ordinal]?.ordinal &&
        result.callSha256 === candidate.results[ordinal]?.callSha256 &&
        result.outcome === candidate.results[ordinal]?.outcome,
    );
  return matches ? { kind: "duplicate-settle", tombstone } : { kind: "conflict", tombstone };
}

/**
 * The Pi adapter's attempt-scoped reducer. It retains tombstones only for the
 * lifetime of this object, records no provider IDs or payloads, and exposes a
 * content-free event stream for the harness to classify turn_end replays.
 */
export class PiAttemptBatchSettlementLedger {
  private readonly tombstones = new Map<string, PiBatchSettlementTombstoneV1>();
  private readonly eventsValue: PiAttemptBatchSettlementEventV1[] = [];

  public get events(): readonly PiAttemptBatchSettlementEventV1[] {
    return this.eventsValue;
  }

  public settle(
    authoritySha256: string,
    results: readonly { callSha256: string; outcome: "succeeded" | "failed" }[],
  ): PiBatchSettlementClassificationV1 {
    const classification = classifyPiBatchSettlement(
      authoritySha256,
      results,
      this.tombstones.get(authoritySha256),
    );
    if (classification.kind === "settle") {
      this.tombstones.set(authoritySha256, classification.tombstone);
    }
    this.eventsValue.push(
      Object.freeze({
        kind: classification.kind,
        authoritySha256: classification.tombstone.authoritySha256,
      }),
    );
    return classification;
  }
}

export function parseCheckpointRationale(output: string): PiCheckpointRationaleV1 | undefined {
  if (!output.trim()) return undefined;
  try {
    const value = JSON.parse(output) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const item = value as Record<string, unknown>;
    const keys = Object.keys(item).sort();
    const expected = ["authority", "kind", "schemaVersion"].sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
      return undefined;
    }
    if (
      item.schemaVersion !== 1 ||
      item.kind !== "docsfab-execution-checkpoint-rationale" ||
      item.authority !== "non-authoritative"
    ) {
      return undefined;
    }
    return Object.freeze(value as PiCheckpointRationaleV1);
  } catch {
    return undefined;
  }
}

function validateRecommendation(value: PiProgressRecommendationV1): void {
  if (
    !SHA256.test(value.observationSha256) ||
    !SHA256.test(value.recommendationSha256) ||
    (value.recommendation !== "renew" && value.recommendation !== "stop") ||
    typeof value.renewable !== "boolean" ||
    value.renewable !== (value.recommendation === "renew")
  ) {
    fail("invalid progress recommendation");
  }
}

function validateReservation(value: PiProviderTurnReservationV1): void {
  if (
    (value.kind !== "ordinary" && value.kind !== "checkpoint") ||
    value.providerTurns !== 1 ||
    value.toolCalls < 0 ||
    value.compactions < 0 ||
    value.inputTokens <= 0 ||
    value.outputTokens <= 0 ||
    value.elapsedMs <= 0 ||
    value.contextInputTokens <= 0 ||
    ![
      value.toolCalls,
      value.compactions,
      value.inputTokens,
      value.outputTokens,
      value.elapsedMs,
      value.contextInputTokens,
    ].every(Number.isSafeInteger)
  ) {
    fail("invalid provider turn reservation");
  }
  if (value.kind === "checkpoint" && value.toolCalls !== 0) {
    fail("checkpoint turn requested tools");
  }
}

function validateDeniedOnlyReservation(value: PiProviderTurnReservationV1): void {
  if (
    value.kind !== "ordinary" ||
    [
      value.toolCalls,
      value.providerTurns,
      value.compactions,
      value.inputTokens,
      value.outputTokens,
      value.elapsedMs,
      value.contextInputTokens,
    ].some((item) => item !== 0)
  ) {
    fail("invalid denied-only reservation");
  }
}

function validateUsage(value: PiProviderTurnUsageV1): void {
  if (
    ![value.inputTokens, value.outputTokens, value.elapsedMs, value.compactions].every(
      (item) => Number.isSafeInteger(item) && item >= 0,
    )
  ) {
    fail("invalid provider turn usage");
  }
}

function envelopeOf(value: PiProviderTurnReservationV1): ExecutionResourceEnvelopeV1 {
  return {
    toolCalls: value.toolCalls,
    providerTurns: value.providerTurns,
    compactions: value.compactions,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    elapsedMs: value.elapsedMs,
    contextInputTokens: value.contextInputTokens,
  };
}

function costForReservation(
  pricing: Extract<BoundExecutionPricingV1, { status: "known" }>,
  reservation: PiProviderTurnReservationV1,
): number {
  return Math.ceil(
    (reservation.inputTokens * pricing.inputMicrousdPerMillionTokens +
      reservation.outputTokens * pricing.outputMicrousdPerMillionTokens) /
      1_000_000,
  );
}

function validateEvidenceBinding(
  value: PiExecutionLeaseEvidenceBindingV1,
  coordinator: ExecutionLeaseCoordinatorV1,
): void {
  if (
    !Number.isSafeInteger(value.inferenceAttempt) ||
    value.inferenceAttempt <= 0 ||
    !Number.isSafeInteger(value.retriesConsumed) ||
    value.retriesConsumed < 0 ||
    value.retriesConsumed !== value.inferenceAttempt - 1 ||
    value.inferenceAttempt !== coordinator.identity.inferenceAttempt ||
    value.retriesConsumed !== coordinator.identity.retriesConsumed ||
    value.repositoryRevision !== coordinator.identity.repositoryRevision ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.repositoryRevision) ||
    !SHA256.test(value.providerTurnLedgerSha256) ||
    !SHA256.test(value.usageSha256) ||
    !SHA256.test(value.toolsSha256)
  ) {
    fail("invalid attempt evidence binding");
  }
}

function dispositionForReason(
  reason: ExecutionTerminalReason,
): ExecutionLeaseRuntimeTerminalDisposition {
  if (reason === "completed") return "completed";
  if (reason === "needs-input") return "needs-input";
  if (reason === "needs-human-decision") return "needs-human-decision";
  if (reason === "cancellation-requested") return "cancelled";
  if (reason === "context-exhausted") return "context-exhausted";
  if (reason === "provider-terminal" || reason === "provider-unavailable") {
    return "provider-failed";
  }
  if (reason === "authorization-denied" || reason === "security-denied") {
    return "authorization-denied";
  }
  if (reason === "evidence-preservation-required") return "evidence-invalid";
  if (reason === "checkpoint-not-renewable") return "malformed";
  return "budget-stopped";
}

function terminalDispositionMatchesReason(
  reason: ExecutionTerminalReason,
  disposition: ExecutionLeaseRuntimeTerminalDisposition,
): boolean {
  if (reason === "checkpoint-not-renewable") {
    return (
      disposition === "blank" || disposition === "malformed" || disposition === "progress-stopped"
    );
  }
  if (reason === "provider-terminal") {
    return disposition === "provider-failed" || disposition === "blank";
  }
  return disposition === dispositionForReason(reason);
}

function hash(value: unknown): string {
  return sha256(canonicalizeJsonEvidence(value as JsonEvidenceValue));
}

function fail(reason: string): never {
  throw new Error(`Pi execution lease rejected: ${reason}.`);
}
