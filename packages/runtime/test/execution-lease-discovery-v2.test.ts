// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createAnswerRecordDiscoveryLeasePolicyV2,
  createExecutionProgressObservation,
  createAbsentChargeableAttemptPolicyV2,
  ExecutionLeaseCoordinatorError,
  prepareExecutionLeaseCoordinator,
  reduceExecutionLeaseCoordinator,
  serializeExecutionCoordinatorDecision,
  type ExecutionLeaseCoordinatorV1,
  type ExecutionResourceEnvelopeV1,
} from "../src/execution/index.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";

const digest = (ch: string) => ch.repeat(64);
const context = {
  status: "ready" as const,
  availableInputTokens: 100_000,
  requiredInputTokens: 1,
  authoritySha256: digest("c"),
};

function envelope(toolCalls: number): ExecutionResourceEnvelopeV1 {
  return {
    toolCalls,
    providerTurns: 1,
    compactions: 0,
    inputTokens: 10_000,
    outputTokens: 2_000,
    elapsedMs: 1,
    contextInputTokens: 1,
  };
}

function transition(
  coordinator: ExecutionLeaseCoordinatorV1,
  command: Parameters<typeof reduceExecutionLeaseCoordinator>[0]["command"],
) {
  return reduceExecutionLeaseCoordinator({
    coordinator,
    expectedCoordinatorSha256: coordinator.coordinatorSha256,
    command,
  });
}

function preparationInput() {
  const policy = createAnswerRecordDiscoveryLeasePolicyV2({ callsPerLease: 2 });
  return {
    policy,
    chargeableAttemptPolicy: createAbsentChargeableAttemptPolicyV2(),
    identity: {
      inferenceAttempt: 1,
      retriesConsumed: 0,
      authorizationSha256: digest("a"),
      repositoryRevision: "b".repeat(40),
      contextPacketSha256: digest("d"),
      evidenceSha256: digest("e"),
      toolPolicySha256: digest("f"),
      contextAuthoritySha256: context.authoritySha256,
    },
    pricing: {
      status: "unavailable" as const,
      reason: "pricing-unknown" as const,
      authoritySha256: digest("1"),
    },
    context,
  };
}

function prepare() {
  return prepareExecutionLeaseCoordinator(preparationInput());
}

describe("renewable experimental discovery policy V2", () => {
  it("serializes strict V2 decisions returned by coordinator transitions", () => {
    const initial = prepare();
    expect(initial.decision).toMatchObject({ schemaVersion: 2, decision: "grant" });
    const serialized = serializeExecutionCoordinatorDecision(initial.decision);
    expect(JSON.parse(serialized)).toEqual(initial.decision);
    expect(serialized).not.toContain("remainingChargeableAttempts");
    const invalidMixedShape = {
      ...initial.decision,
      remainingChargeableAttempts: 1,
    };
    const { decisionSha256: _discardedDigest, ...invalidBody } = invalidMixedShape;
    invalidMixedShape.decisionSha256 = createHash("sha256")
      .update(canonicalizeJsonEvidence(invalidBody as unknown as JsonEvidenceValue))
      .digest("hex");
    expect(() => serializeExecutionCoordinatorDecision(invalidMixedShape as never)).toThrow(
      ExecutionLeaseCoordinatorError,
    );
  });

  it("renews at cadence while retaining metered work beyond small aggregate V1-like limits", () => {
    let coordinator = prepare().coordinator;
    for (let callIndex = 0; callIndex < 8; callIndex += 1) {
      if (coordinator.phase === "checkpoint-required") {
        const renewed = transition(coordinator, {
          kind: "renew",
          nextTranche: envelope(2),
        });
        expect(renewed.decision).toMatchObject({ schemaVersion: 2, decision: "renewed" });
        coordinator = renewed.coordinator;
      }
      const callSha256 = `${callIndex.toString(16).padStart(63, "0")}a`;
      const request = transition(coordinator, {
        kind: "request-tool-batch",
        calls: [{ callSha256, authorization: "execute", scope: "answer-record" }],
        envelope: envelope(1),
      });
      coordinator = request.coordinator;
      const observation = createExecutionProgressObservation({
        sequence: (coordinator.lastObservation?.sequence ?? 0) + 1,
        providerTurns: coordinator.state.providerTurns + 1,
        compactions: coordinator.state.compactions,
        cumulativeInputTokens: coordinator.state.cumulativeInputTokens + 10_000,
        cumulativeOutputTokens: coordinator.state.cumulativeOutputTokens + 2_000,
        elapsedMs: coordinator.state.elapsedMs + 1_000,
        context,
      });
      coordinator = transition(coordinator, {
        kind: "settle-tool-batch",
        results: [{ callSha256, outcome: "succeeded" }],
        observation,
      }).coordinator;
    }

    expect(coordinator.phase).toBe("checkpoint-required");
    expect(coordinator.state).toMatchObject({
      leaseNumber: 4,
      toolCalls: { executed: 8, succeeded: 8 },
      toolCallsByScope: { answerRecord: 8 },
      cumulativeInputTokens: 80_000,
      cumulativeOutputTokens: 16_000,
      elapsedMs: 8_000,
      providerTurns: 8,
    });
    expect(coordinator.policy).toMatchObject({
      schemaVersion: 2,
      aggregatePolicy: { kind: "absent" },
    });
    expect("maxProviderTurns" in coordinator.policy).toBe(false);
    expect("cumulative" in coordinator.policy).toBe(false);
  });

  it("rejects a tampered absent policy and does not reinterpret it as V1", () => {
    const policy = createAnswerRecordDiscoveryLeasePolicyV2({ callsPerLease: 2 });
    const input = preparationInput();
    expect(() =>
      prepareExecutionLeaseCoordinator({
        ...input,
        policy: { ...policy, aggregatePolicy: { kind: "absent" as const }, callsPerLease: 3 },
      }),
    ).toThrow();
  });
});
