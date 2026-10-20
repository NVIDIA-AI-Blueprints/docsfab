// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createAnswerRecordDiscoveryLeasePolicyV2,
  createExecutionLeaseCoordinatorPolicy,
} from "../src/execution/index.js";
import {
  PiExecutionLeaseController,
  recommendPiProgress,
  type PiProviderTurnReservationV1,
} from "../src/harness/pi-lease.js";
import { nextTranche } from "../src/harness/pi-offline.js";
import { decodeExecutionLeaseRuntimeEvidence } from "../src/scorecard-record.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";

const digest = (character: string): string => character.repeat(64);
const context = {
  status: "ready" as const,
  availableInputTokens: 10_000,
  requiredInputTokens: 1,
  authoritySha256: digest("c"),
};
const pricing = {
  status: "unavailable" as const,
  reason: "pricing-unknown" as const,
  authoritySha256: digest("d"),
};
const identity = {
  inferenceAttempt: 1,
  retriesConsumed: 0,
  authorizationSha256: digest("a"),
  repositoryRevision: "b".repeat(40),
  contextPacketSha256: digest("e"),
  evidenceSha256: digest("f"),
  toolPolicySha256: digest("1"),
  contextAuthoritySha256: context.authoritySha256,
};

function reservation(toolCalls: number): PiProviderTurnReservationV1 {
  return {
    kind: "ordinary",
    toolCalls,
    providerTurns: 1,
    compactions: 0,
    inputTokens: 4,
    outputTokens: 2,
    elapsedMs: 1,
    contextInputTokens: 1,
  };
}

describe("Pi discovery with absent aggregate ceilings", () => {
  it("renews at the cadence with zero aggregate elapsed authority", () => {
    const subject = new PiExecutionLeaseController({
      policy: createAnswerRecordDiscoveryLeasePolicyV2({ callsPerLease: 2 }),
      identity,
      pricing,
      context,
      requestCapacity: { maxInputTokens: 777, maxOutputTokens: 333 },
    });

    for (let index = 0; index < 2; index += 1) {
      const callSha256 = `${(index + 1).toString(16).padStart(64, "0")}`;
      subject.requestToolBatch(
        [{ callSha256, authorization: "execute", scope: "answer-record" }],
        reservation(1),
      );
      subject.settleToolBatch([{ callSha256, outcome: "succeeded" }], {
        inputTokens: 3,
        outputTokens: 2,
        elapsedMs: 5,
        compactions: 0,
        context,
      });
    }

    expect(subject.checkpointRequired).toBe(true);
    const recommendation = recommendPiProgress({
      leaseNumber: subject.coordinator.state.leaseNumber,
      uniqueSuccessfulCalls: 2,
      failedCalls: 0,
      executedCalls: 2,
      experimentalAnswerRecordDiscoveryRenewal: true,
    });
    expect(nextTranche(subject).elapsedMs).toBe(0);
    expect(() =>
      subject.applyHostCheckpoint(recommendation, {
        ...nextTranche(subject),
        outputTokens: 0,
      }),
    ).toThrow("Execution lease coordinator rejected the transition.");
    expect(subject.applyHostCheckpoint(recommendation, nextTranche(subject))).toMatchObject({
      decision: "renewed",
      leaseNumber: 2,
    });
    expect(subject.coordinator.state).toMatchObject({
      leaseNumber: 2,
      toolCalls: { executed: 2 },
      cumulativeInputTokens: 6,
      cumulativeOutputTokens: 4,
      elapsedMs: 10,
      providerTurns: 2,
    });
  });

  it("keeps explicit request capacities and cumulative usage through repeated checkpoint renewals", () => {
    const subject = new PiExecutionLeaseController({
      policy: createAnswerRecordDiscoveryLeasePolicyV2({ callsPerLease: 2 }),
      identity,
      pricing,
      context,
      requestCapacity: { maxInputTokens: 777, maxOutputTokens: 333 },
    });

    expect(subject.perRequestCapacity).toEqual({ maxInputTokens: 777, maxOutputTokens: 333 });
    for (let index = 0; index < 6; index += 1) {
      if (subject.checkpointRequired) {
        const state = subject.coordinator.state;
        const recommendation = recommendPiProgress({
          leaseNumber: state.leaseNumber,
          uniqueSuccessfulCalls: state.toolCalls.succeeded,
          failedCalls: state.toolCalls.failed,
          executedCalls: state.toolCalls.executed,
          experimentalAnswerRecordDiscoveryRenewal: true,
        });
        expect(subject.applyHostCheckpoint(recommendation, nextTranche(subject))).toMatchObject({
          decision: "renewed",
        });
      }

      const callSha256 = `${(index + 1).toString(16).padStart(64, "0")}`;
      expect(
        subject.requestToolBatch(
          [{ callSha256, authorization: "execute", scope: "answer-record" }],
          reservation(1),
        ),
      ).toMatchObject({ authorizedToolCalls: 1 });
      subject.settleToolBatch([{ callSha256, outcome: "succeeded" }], {
        inputTokens: 3,
        outputTokens: 2,
        elapsedMs: 5,
        compactions: 0,
        context,
      });
    }

    expect(subject.coordinator.phase).toBe("checkpoint-required");
    expect(subject.coordinator.state).toMatchObject({
      leaseNumber: 3,
      toolCalls: { executed: 6, succeeded: 6 },
      toolCallsByScope: { answerRecord: 6 },
      cumulativeInputTokens: 18,
      cumulativeOutputTokens: 12,
      elapsedMs: 30,
      providerTurns: 6,
    });
    expect(subject.coordinator.policy).toMatchObject({
      schemaVersion: 2,
      aggregatePolicy: { kind: "absent" },
    });
    expect("cumulative" in subject.coordinator.policy).toBe(false);
    expect("maxProviderTurns" in subject.coordinator.policy).toBe(false);

    const evidence = subject.evidence({
      inferenceAttempt: 1,
      retriesConsumed: 0,
      repositoryRevision: identity.repositoryRevision,
      providerTurnLedgerSha256: canonicalDigest({
        providerTurns: subject.coordinator.state.providerTurns,
      }),
      usageSha256: canonicalDigest({
        input: subject.coordinator.state.cumulativeInputTokens,
        output: subject.coordinator.state.cumulativeOutputTokens,
      }),
      toolsSha256: canonicalDigest(subject.coordinator.state.toolCalls),
    });
    expect(evidence).toMatchObject({
      policyVersion: 2,
      aggregatePolicy: { kind: "absent" },
      cumulativeInputTokens: 18,
      cumulativeOutputTokens: 12,
    });
    expect(decodeExecutionLeaseRuntimeEvidence(evidence)).toEqual(evidence);
  });

  it("retains finite aggregate enforcement for V1 policies", () => {
    const policy = createExecutionLeaseCoordinatorPolicy({
      maxCompactions: 0,
      providerLimits: { maxProviderTurns: 4, maxCompactions: 0 },
      cumulative: { maxInputTokens: 5, maxOutputTokens: 5, maxElapsedMs: 10 },
    });
    const subject = new PiExecutionLeaseController({ policy, identity, pricing, context });

    expect(() => subject.preflightProviderTurn({ ...reservation(1), inputTokens: 6 })).toThrow(
      "provider turn exceeds cumulative authority",
    );
  });

  it("retains positive elapsed renewal-envelope validation for finite V1 policies", () => {
    const policy = createExecutionLeaseCoordinatorPolicy({
      maxCompactions: 0,
      providerLimits: { maxProviderTurns: 64, maxCompactions: 0 },
      cumulative: { maxInputTokens: 100, maxOutputTokens: 100, maxElapsedMs: 1_000 },
      answerRecordCallCeiling: 4,
      sharedToolCallCapacity: true,
      workflowOverrides: {
        callsPerLease: 1,
        maxLeases: 4,
        hardToolCallCeiling: 4,
      },
    });
    const subject = new PiExecutionLeaseController({ policy, identity, pricing, context });
    const callSha256 = `${(1).toString(16).padStart(64, "0")}`;
    subject.requestToolBatch(
      [{ callSha256, authorization: "execute", scope: "answer-record" }],
      reservation(1),
    );
    subject.settleToolBatch([{ callSha256, outcome: "succeeded" }], {
      inputTokens: 3,
      outputTokens: 2,
      elapsedMs: 1,
      compactions: 0,
      context,
    });

    expect(subject.checkpointRequired).toBe(true);
    const recommendation = recommendPiProgress({
      leaseNumber: subject.coordinator.state.leaseNumber,
      uniqueSuccessfulCalls: 1,
      failedCalls: 0,
      executedCalls: 1,
    });
    expect(() =>
      subject.applyHostCheckpoint(recommendation, {
        ...nextTranche(subject),
        elapsedMs: 0,
      }),
    ).toThrow("Execution lease coordinator rejected the transition.");
  });
});
