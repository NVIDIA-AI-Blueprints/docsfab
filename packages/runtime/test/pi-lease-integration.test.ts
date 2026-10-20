// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  EXECUTION_LEASE_DEFAULTS,
  createExecutionLeaseCoordinatorPolicy,
  createExecutionLeasePolicy,
  resolveLeaseShapeForTurns,
  type ExecutionResourceEnvelopeV1,
} from "../src/execution/index.js";
import { nextTranche } from "../src/harness/pi-offline.js";
import {
  PI_CHECKPOINT_PROMPT,
  PiAttemptBatchSettlementLedger,
  PiExecutionLeaseController,
  createPiBatchAuthoritySha256,
  digestPiToolCall,
  isPiUnexecutedToolBatchTurn,
  parseCheckpointRationale,
  recommendPiProgress,
  validatePiBatchCalls,
  validatePiBatchSettlement,
  type PiProgressRecommendationV1,
} from "../src/harness/pi-lease.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import { createModelConnection } from "../src/model/provider.js";
import { decodeExecutionLeaseRuntimeEvidence } from "../src/scorecard-record.js";
import { validModelConfig } from "./helpers.js";

const digest = (character: string): string => character.repeat(64);

/**
 * A distinct 64-hex tool-call digest per (group, index). Zero-padding to a
 * fixed width is injective; left-padding with a hex digit is not (index 0x0d
 * and 0xdd collide when padded with "d"), which silently shrinks a large
 * boundary fixture's distinct calls. The leading group character keeps
 * unrelated batches apart.
 */
function fixtureCallSha256(group: string, index: number): string {
  return `${group}${index.toString(16).padStart(63, "0")}`;
}

/**
 * The provider-turn budget every fixture in this file runs under. It is an
 * input, so it stays a literal; every lease number derived from it below is
 * computed, not pinned. `createExecutionLeaseCoordinatorPolicy` clamps the
 * budget to the shipped default and then shrinks the lease shape to fit, so
 * mirroring both steps keeps the fixtures tracking EXECUTION_LEASE_DEFAULTS.
 * A budget small enough to make one lease optimal would leave the renewal
 * fixtures unreachable; 256 yields the three-lease shape they are written
 * against.
 */
const PROVIDER_TURN_BUDGET = 256;
const BUDGETED_PROVIDER_TURNS = Math.min(
  EXECUTION_LEASE_DEFAULTS.maxProviderTurns,
  PROVIDER_TURN_BUDGET,
);
const LEASE = resolveLeaseShapeForTurns(EXECUTION_LEASE_DEFAULTS, BUDGETED_PROVIDER_TURNS);

const context = {
  status: "ready" as const,
  availableInputTokens: 100_000,
  requiredInputTokens: 1,
  authoritySha256: digest("c"),
};
const rationale = JSON.stringify({
  schemaVersion: 1,
  kind: "docsfab-execution-checkpoint-rationale",
  authority: "non-authoritative",
});

function controller(
  options: {
    pricing?: "known" | "unknown";
    maxProviderTurns?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    maxElapsedMs?: number;
    inferenceAttempt?: number;
    hardToolCallCeiling?: number;
  } = {},
) {
  const policy = createExecutionLeaseCoordinatorPolicy({
    maxCompactions: 4,
    providerLimits: {
      maxProviderTurns: options.maxProviderTurns ?? PROVIDER_TURN_BUDGET,
      maxCompactions: 4,
    },
    cumulative: {
      maxInputTokens: options.maxInputTokens ?? 10_000,
      maxOutputTokens: options.maxOutputTokens ?? 10_000,
      maxElapsedMs: options.maxElapsedMs ?? 10_000,
    },
    ...(options.hardToolCallCeiling === undefined
      ? {}
      : { workflowOverrides: { hardToolCallCeiling: options.hardToolCallCeiling } }),
  });
  return new PiExecutionLeaseController({
    policy,
    identity: {
      inferenceAttempt: options.inferenceAttempt ?? 1,
      retriesConsumed: (options.inferenceAttempt ?? 1) - 1,
      authorizationSha256: digest("a"),
      repositoryRevision: "b".repeat(40),
      contextPacketSha256: digest("d"),
      evidenceSha256: digest("e"),
      toolPolicySha256: digest("f"),
      contextAuthoritySha256: context.authoritySha256,
    },
    pricing:
      options.pricing === "unknown"
        ? { status: "unavailable", reason: "pricing-unknown", authoritySha256: digest("8") }
        : {
            status: "known",
            inputMicrousdPerMillionTokens: 100,
            outputMicrousdPerMillionTokens: 200,
            authoritySha256: digest("7"),
          },
    context,
  });
}

function runtimeEvidence(subject: PiExecutionLeaseController) {
  return subject.evidence({
    inferenceAttempt: subject.coordinator.identity.inferenceAttempt,
    retriesConsumed: subject.coordinator.identity.retriesConsumed,
    repositoryRevision: subject.coordinator.identity.repositoryRevision,
    providerTurnLedgerSha256: canonicalDigest({
      providerTurns: subject.coordinator.state.providerTurns,
    }),
    usageSha256: canonicalDigest({
      input: subject.coordinator.state.cumulativeInputTokens,
      output: subject.coordinator.state.cumulativeOutputTokens,
    }),
    toolsSha256: canonicalDigest(subject.coordinator.state.toolCalls),
  });
}

function usage(
  overrides: Partial<{
    inputTokens: number;
    outputTokens: number;
    elapsedMs: number;
    compactions: number;
  }> = {},
) {
  return {
    inputTokens: overrides.inputTokens ?? 1,
    outputTokens: overrides.outputTokens ?? 1,
    elapsedMs: overrides.elapsedMs ?? 1,
    compactions: overrides.compactions ?? 0,
    context,
  };
}

function reservation(toolCalls: number) {
  return {
    kind: "ordinary" as const,
    toolCalls,
    providerTurns: 1,
    compactions: 0,
    inputTokens: 1,
    outputTokens: 1,
    elapsedMs: 1,
    contextInputTokens: 1,
  };
}

function deniedOnlyReservation() {
  return {
    kind: "ordinary" as const,
    toolCalls: 0,
    providerTurns: 0,
    compactions: 0,
    inputTokens: 0,
    outputTokens: 0,
    elapsedMs: 0,
    contextInputTokens: 0,
  };
}

/**
 * The next lease's envelope, sized as `decideExecutionLeaseRenewal` sizes its
 * grant: `renew` rejects any tranche that does not equal `grantedToolCalls`.
 * One tool call costs one provider turn and one unit of each cumulative budget,
 * so the rest of the envelope follows from the same count.
 */
function tranche(subject: PiExecutionLeaseController): ExecutionResourceEnvelopeV1 {
  const state = subject.coordinator.state;
  const toolCalls = Math.min(
    LEASE.callsPerLease,
    LEASE.hardToolCallCeiling - state.toolCalls.executed,
    BUDGETED_PROVIDER_TURNS - state.providerTurns - 1,
  );
  return {
    toolCalls,
    providerTurns: toolCalls,
    compactions: 1,
    inputTokens: toolCalls,
    outputTokens: toolCalls,
    elapsedMs: toolCalls,
    contextInputTokens: 1,
  };
}

function recommendation(
  subject: PiExecutionLeaseController,
  renew = true,
): PiProgressRecommendationV1 {
  const observationSha256 = canonicalDigest({
    leaseNumber: subject.coordinator.state.leaseNumber,
    executed: subject.coordinator.state.toolCalls.executed,
  });
  return {
    observationSha256,
    recommendation: renew ? "renew" : "stop",
    renewable: renew,
    recommendationSha256: canonicalDigest({ observationSha256, renew }),
  };
}

function checkpoint(subject: PiExecutionLeaseController): void {
  expect(subject.checkpointRequired).toBe(true);
  const decision = subject.applyHostCheckpoint(recommendation(subject), tranche(subject));
  expect(decision.decision).toBe("renewed");
}

function execute(
  subject: PiExecutionLeaseController,
  count: number,
  outcome: "succeeded" | "failed" = "succeeded",
): void {
  for (let index = 0; index < count; index += 1) {
    if (subject.checkpointRequired) checkpoint(subject);
    const callSha256 = digestPiToolCall(`call-${index}`, "read", index);
    const decision = subject.requestToolBatch(
      [{ callSha256, authorization: "execute" }],
      reservation(1),
    );
    expect(decision.authorizedToolCalls).toBe(1);
    subject.settleToolBatch([{ callSha256, outcome }], usage());
  }
}

function finish(subject: PiExecutionLeaseController): void {
  subject.preflightProviderTurn(reservation(0));
  subject.settleOrdinaryProviderTurn(usage());
  subject.complete();
}

describe("Pi checkpointed execution-lease integration", () => {
  it("renews a zero-success correction tranche only for explicit answer-record discovery", () => {
    const discovery = controller();
    execute(discovery, LEASE.callsPerLease, "failed");
    const discoveryRecommendation = recommendPiProgress({
      leaseNumber: discovery.coordinator.state.leaseNumber,
      uniqueSuccessfulCalls: 0,
      failedCalls: LEASE.callsPerLease,
      executedCalls: discovery.coordinator.state.leaseExecutedToolCalls,
      experimentalAnswerRecordDiscoveryRenewal: true,
    });
    expect(discoveryRecommendation).toMatchObject({
      recommendation: "renew",
      renewable: true,
    });
    expect(
      discovery.applyHostCheckpoint(discoveryRecommendation, tranche(discovery)),
    ).toMatchObject({ decision: "renewed" });

    const ordinary = controller();
    execute(ordinary, LEASE.callsPerLease, "failed");
    const ordinaryRecommendation = recommendPiProgress({
      leaseNumber: ordinary.coordinator.state.leaseNumber,
      uniqueSuccessfulCalls: 0,
      failedCalls: LEASE.callsPerLease,
      executedCalls: ordinary.coordinator.state.leaseExecutedToolCalls,
    });
    expect(ordinaryRecommendation).toMatchObject({
      recommendation: "stop",
      renewable: false,
    });
    expect(ordinaryRecommendation.observationSha256).not.toBe(
      discoveryRecommendation.observationSha256,
    );
    expect(ordinary.applyHostCheckpoint(ordinaryRecommendation, tranche(ordinary))).toMatchObject({
      decision: "terminal",
      reason: "checkpoint-not-renewable",
    });
  });

  it("completes a run inside one lease, and a lease-crossing run, with no checkpoint provider turn", () => {
    // Two calls short of the lease allowance: no boundary is reached.
    const withinLease = LEASE.callsPerLease - 2;
    const short = controller();
    execute(short, withinLease);
    finish(short);
    expect(runtimeEvidence(short)).toMatchObject({
      phase: "terminal",
      terminalReason: "completed",
      providerTurns: withinLease + 1,
      checkpointProviderTurns: 0,
      toolCalls: { executed: withinLease },
      checkpoints: [],
    });

    // Two calls past it: one accounted host checkpoint, still charging no
    // provider turn of its own and recording no observed checkpoint turn.
    const crossingLease = LEASE.callsPerLease + 2;
    const renewed = controller();
    execute(renewed, crossingLease);
    expect(renewed.coordinator.state.leaseNumber).toBe(2);
    finish(renewed);
    expect(runtimeEvidence(renewed)).toMatchObject({
      phase: "terminal",
      terminalReason: "completed",
      providerTurns: crossingLease + 1,
      checkpointProviderTurns: 0,
      toolCalls: { executed: crossingLease },
      checkpoints: [],
    });
  });

  it("fills the hard tool-call ceiling with accounted host renewals, then ends at it", () => {
    const subject = controller();
    execute(subject, LEASE.hardToolCallCeiling);
    expect(subject.checkpointRequired).toBe(true);
    expect(subject.coordinator.state.leaseNumber).toBe(LEASE.maxLeases);
    // The host ends the attempt at the ceiling it derives, with no answer turn.
    subject.stopForNoProgress();
    const evidence = runtimeEvidence(subject);
    expect(evidence).toMatchObject({
      phase: "terminal",
      terminalReason: "hard-tool-call-ceiling",
      terminalDisposition: "budget-stopped",
      providerTurns: LEASE.hardToolCallCeiling,
      checkpointProviderTurns: 0,
      toolCalls: {
        requested: LEASE.hardToolCallCeiling,
        executed: LEASE.hardToolCallCeiling,
        governanceBlocked: 0,
      },
    });
    expect(evidence.checkpoints).toHaveLength(0);
    const cappedDiscovery = controller();
    execute(cappedDiscovery, LEASE.hardToolCallCeiling, "failed");
    const discoveryAtCeiling = recommendPiProgress({
      leaseNumber: cappedDiscovery.coordinator.state.leaseNumber,
      uniqueSuccessfulCalls: 0,
      failedCalls: LEASE.callsPerLease,
      executedCalls: cappedDiscovery.coordinator.state.leaseExecutedToolCalls,
      experimentalAnswerRecordDiscoveryRenewal: true,
    });
    expect(discoveryAtCeiling).toMatchObject({ recommendation: "renew", renewable: true });
    expect(cappedDiscovery.stopForNoProgress()).toMatchObject({
      decision: "terminal",
      reason: "hard-tool-call-ceiling",
    });
    expect(() =>
      subject.requestToolBatch(
        [{ callSha256: digest("6"), authorization: "execute" }],
        reservation(1),
      ),
    ).toThrow();
  });

  it("authorizes only the source-ordered prefix of a crossing parallel batch", () => {
    const subject = controller();
    // One call short of the lease allowance, so a three-call parallel batch
    // straddles the boundary.
    execute(subject, LEASE.callsPerLease - 1);
    const calls = [0, 1, 2].map((index) => ({
      callSha256: digestPiToolCall(`parallel-${index}`, "read", index),
      authorization: "execute" as const,
    }));
    const requested = subject.requestToolBatch(calls, reservation(3));
    expect(requested).toMatchObject({
      authorizedToolCalls: 1,
      governanceBlockedToolCalls: 2,
    });
    subject.settleToolBatch([{ callSha256: calls[0]!.callSha256, outcome: "failed" }], usage());
    expect(runtimeEvidence(subject).toolCalls).toMatchObject({
      requested: LEASE.callsPerLease + 2,
      executed: LEASE.callsPerLease,
      failed: 1,
      governanceBlocked: 2,
    });
  });

  it("scopes single-use batch authority and rejects duplicate, missing, foreign, or reordered artifacts", () => {
    const calls = [0, 1].map((index) => ({
      id: `batch-${index}`,
      name: "read",
      sha256: digestPiToolCall(`batch-${index}`, "read", index),
    }));
    expect(() => validatePiBatchCalls([calls[0]!, { ...calls[1]!, id: calls[0]!.id }])).toThrow();
    const authority = (providerTurn: number, sequence: number, inferenceAttempt = 1) =>
      createPiBatchAuthoritySha256({
        inferenceAttempt,
        providerTurn,
        sequence,
        assistantSha256: digest("4"),
        calls,
      });
    expect(
      new Set([authority(1, 1, 1), authority(2, 1, 1), authority(1, 2, 1), authority(1, 1, 2)]),
    ).toHaveLength(4);
    expect(
      validatePiBatchSettlement(
        calls,
        calls.map((call) => call.sha256),
        [
          { toolCallId: calls[0]!.id, isError: false },
          { toolCallId: calls[1]!.id, isError: true },
        ],
      ),
    ).toEqual([
      { callSha256: calls[0]!.sha256, outcome: "succeeded" },
      { callSha256: calls[1]!.sha256, outcome: "failed" },
    ]);
    expect(
      validatePiBatchSettlement(
        calls,
        [calls[1]!.sha256],
        [
          { toolCallId: calls[0]!.id, isError: true },
          { toolCallId: calls[1]!.id, isError: false },
        ],
      ),
    ).toEqual([{ callSha256: calls[1]!.sha256, outcome: "succeeded" }]);
    expect(() =>
      validatePiBatchSettlement(
        calls,
        [calls[1]!.sha256, calls[0]!.sha256],
        [
          { toolCallId: calls[0]!.id, isError: false },
          { toolCallId: calls[1]!.id, isError: false },
        ],
      ),
    ).toThrow();
    for (const malformed of [
      [{ toolCallId: calls[0]!.id, isError: false }],
      [
        { toolCallId: calls[0]!.id, isError: false },
        { toolCallId: calls[0]!.id, isError: false },
      ],
      [
        { toolCallId: calls[0]!.id, isError: false },
        { toolCallId: "foreign", isError: false },
      ],
      [
        { toolCallId: calls[1]!.id, isError: false },
        { toolCallId: calls[0]!.id, isError: false },
      ],
    ]) {
      expect(() =>
        validatePiBatchSettlement(
          calls,
          calls.map((call) => call.sha256),
          malformed,
        ),
      ).toThrow();
    }
  });

  it("settles host-observed results before classifying a duplicated turn_end without moving counters", () => {
    const subject = controller();
    const settlements = new PiAttemptBatchSettlementLedger();
    let replayResult: { callSha256: string; outcome: "succeeded" } | undefined;
    const authorityFor = (ordinal: number) => ordinal.toString(16).repeat(64);

    for (let ordinal = 0; ordinal < 13; ordinal += 1) {
      const result = {
        callSha256: digestPiToolCall(`settle-${ordinal}`, "read", 0),
        outcome: "succeeded" as const,
      };
      subject.requestToolBatch(
        [{ callSha256: result.callSha256, authorization: "execute" }],
        reservation(1),
      );
      subject.settleToolBatch([result], usage());
      const settled = settlements.settle(authorityFor(ordinal), [result]);
      expect(settled.kind).toBe("settle");
      if (ordinal === 12) {
        replayResult = result;
      }
    }
    const beforeReplay = runtimeEvidence(subject);
    const replay = settlements.settle(authorityFor(12), [replayResult!]);

    expect(replay.kind).toBe("duplicate-settle");
    expect(runtimeEvidence(subject)).toEqual(beforeReplay);
    subject.complete();
    expect(runtimeEvidence(subject)).toMatchObject({
      phase: "terminal",
      terminalReason: "completed",
      toolCalls: { executed: 13 },
    });
    expect(settlements.events.filter((event) => event.kind === "duplicate-settle")).toHaveLength(1);
    expect(
      settlements.settle(authorityFor(12), [{ ...replayResult!, outcome: "failed" }]).kind,
    ).toBe("conflict");
  });

  it("keeps reused provider call IDs separate by batch authority and ordinal", () => {
    const result = {
      callSha256: digestPiToolCall("call_0", "read", 0),
      outcome: "succeeded" as const,
    };
    const settlements = new PiAttemptBatchSettlementLedger();
    const first = settlements.settle(digest("a"), [result]);
    const replay = settlements.settle(digest("a"), [result]);
    const laterBatch = settlements.settle(digest("b"), [result]);

    expect(first.kind).toBe("settle");
    expect(replay.kind).toBe("duplicate-settle");
    expect(laterBatch.kind).toBe("settle");
  });

  it("bounds an oversized Pi event fixture to the calls remaining in the lease", () => {
    // Squeeze the ceiling down to a single lease's allowance, so the batch
    // overflow is a lease boundary rather than a mid-lease grant.
    const overflow = 5;
    const subject = controller({ hardToolCallCeiling: LEASE.callsPerLease });
    const calls = Array.from({ length: LEASE.callsPerLease + overflow }, (_, index) => ({
      callSha256: digestPiToolCall(`call_${index}`, "read", index),
      authorization: "execute" as const,
    }));

    const decision = subject.requestToolBatch(calls, reservation(calls.length));

    expect(decision).toMatchObject({
      decision: "grant",
      authorizedToolCalls: LEASE.callsPerLease,
      governanceBlockedToolCalls: overflow,
    });
    subject.settleToolBatch(
      calls.slice(0, LEASE.callsPerLease).map((call) => ({
        callSha256: call.callSha256,
        outcome: "succeeded" as const,
      })),
      usage(),
    );
    expect(runtimeEvidence(subject)).toMatchObject({
      phase: "checkpoint-required",
      toolCalls: {
        requested: LEASE.callsPerLease + overflow,
        executed: LEASE.callsPerLease,
        succeeded: LEASE.callsPerLease,
        governanceBlocked: overflow,
      },
    });
  });

  it("renews at lease exhaustion without an extra checkpoint provider turn", () => {
    const subject = controller();
    execute(subject, LEASE.callsPerLease);
    expect(subject.checkpointRequired).toBe(true);
    expect(runtimeEvidence(subject)).toMatchObject({
      phase: "checkpoint-required",
      providerTurns: LEASE.callsPerLease,
      checkpointProviderTurns: 0,
    });
    expect(subject.applyHostCheckpoint(recommendation(subject), tranche(subject))).toMatchObject({
      decision: "renewed",
    });
    expect(subject.coordinator).toMatchObject({
      phase: "active",
      state: { leaseNumber: 2, providerTurns: LEASE.callsPerLease },
    });
    expect(runtimeEvidence(subject)).toMatchObject({
      checkpointProviderTurns: 0,
      checkpoints: [],
    });
  });

  it("never sends a tool-free provider turn that follows tool history", async () => {
    // "Omit the tools field, never send tools: []" must hold on the wire, not
    // only on the object handed to Pi: pi-ai puts `tools: []` back whenever the
    // history holds a tool call, and the provider front door refuses that
    // request. This drives the real serializer and payload finalizer through a
    // capturing `fetch`.
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          [
            `data: ${JSON.stringify({ id: "checkpoint", object: "chat.completion.chunk", created: 1, model: validModelConfig.modelId, choices: [{ index: 0, delta: { role: "assistant", content: "{}" }, finish_reason: null }] })}\n\n`,
            `data: ${JSON.stringify({ id: "checkpoint", object: "chat.completion.chunk", created: 1, model: validModelConfig.modelId, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
            "data: [DONE]\n\n",
          ].join(""),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    try {
      const connection = await createModelConnection(validModelConfig);
      const checkpointAsk = { role: "user", content: PI_CHECKPOINT_PROMPT, timestamp: 4 };
      const afterToolHistory = await connection.runtime
        .streamSimple(connection.model, {
          messages: [
            { role: "user", content: "Read README.md.", timestamp: 1 },
            {
              role: "assistant",
              content: [
                { type: "toolCall", id: "call-0", name: "read", arguments: { path: "README.md" } },
              ],
              api: connection.model.api,
              provider: connection.model.provider,
              model: connection.model.id,
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "toolUse",
              timestamp: 2,
            },
            {
              role: "toolResult",
              toolCallId: "call-0",
              toolName: "read",
              content: [{ type: "text", text: "# Fixture" }],
              isError: false,
              timestamp: 3,
            },
            checkpointAsk,
          ] as never,
        })
        .result();
      expect(afterToolHistory.stopReason).toBe("error");
      expect(String(afterToolHistory.errorMessage)).toContain("(tool-history-without-tools:");
      expect(bodies).toHaveLength(0);

      // The adjacent turn: the same tool-free ask with no tool history is sent,
      // once, and carries no tools field at all.
      const withoutHistory = await connection.runtime
        .streamSimple(connection.model, { messages: [checkpointAsk] as never })
        .result();
      expect(withoutHistory.stopReason).toBe("stop");
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).not.toHaveProperty("tools");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a length-truncated Pi event isolated from its fresh retry", () => {
    const callSha256 = digestPiToolCall("call_0", "read", 0);
    const first = controller({ inferenceAttempt: 1 });
    first.requestToolBatch([{ callSha256, authorization: "execute" }], reservation(1));
    // The runtime stores only the terminal classification, not the raw
    // provider event or its partial tool payload.
    first.failToolBatch([], usage(), "provider-terminal");

    const retry = controller({ inferenceAttempt: 2 });
    retry.requestToolBatch([{ callSha256, authorization: "execute" }], reservation(1));
    retry.settleToolBatch([{ callSha256, outcome: "succeeded" }], usage());

    expect(first.coordinator.identity.identitySha256).not.toBe(
      retry.coordinator.identity.identitySha256,
    );
    expect(runtimeEvidence(first)).toMatchObject({
      terminalReason: "provider-terminal",
      binding: { inferenceAttempt: 1, retriesConsumed: 0 },
    });
    expect(runtimeEvidence(retry)).toMatchObject({
      phase: "active",
      binding: { inferenceAttempt: 2, retriesConsumed: 1 },
      toolCalls: { requested: 1, executed: 1, succeeded: 1 },
    });
  });

  it("records a zero-authorized batch before treating its repeat as a replay", () => {
    const subject = controller();
    const denied = digestPiToolCall("zero-authorized", "read", 0);
    const decision = subject.requestToolBatch(
      [{ callSha256: denied, authorization: "denied" }],
      deniedOnlyReservation(),
    );
    expect(decision.authorizedToolCalls).toBe(0);
    expect(subject.coordinator.phase).toBe("active");

    subject.settleOrdinaryProviderTurn(usage());
    const settlements = new PiAttemptBatchSettlementLedger();
    expect(settlements.settle(digest("c"), []).kind).toBe("settle");
    expect(settlements.settle(digest("c"), []).kind).toBe("duplicate-settle");
    expect(runtimeEvidence(subject).toolCalls).toMatchObject({ executed: 0, denied: 1 });
  });

  it("terminalizes malformed partial settlement without inventing successes", () => {
    const subject = controller();
    const calls = [0, 1].map((index) => ({
      callSha256: digestPiToolCall(`partial-${index}`, "read", index),
      authorization: "execute" as const,
    }));
    subject.requestToolBatch(calls, reservation(2));
    subject.failToolBatch(
      [{ callSha256: calls[0]!.callSha256, outcome: "failed" }],
      usage(),
      "evidence-preservation-required",
    );
    expect(runtimeEvidence(subject)).toMatchObject({
      phase: "terminal",
      terminalReason: "evidence-preservation-required",
      terminalDisposition: "evidence-invalid",
      toolCalls: {
        requested: 2,
        executed: 1,
        succeeded: 0,
        failed: 1,
        governanceBlocked: 1,
      },
    });
  });

  it("settles an executed prefix, one late denial, and the unexecuted suffix exactly", () => {
    const subject = controller();
    const calls = [0, 1, 2].map((index) => ({
      callSha256: digestPiToolCall(`late-denial-${index}`, "read", index),
      authorization: "execute" as const,
    }));
    subject.requestToolBatch(calls, reservation(3));
    subject.failToolBatch(
      [{ callSha256: calls[0]!.callSha256, outcome: "succeeded" }],
      usage(),
      "authorization-denied",
      calls[1]!.callSha256,
    );
    expect(runtimeEvidence(subject)).toMatchObject({
      phase: "terminal",
      terminalReason: "authorization-denied",
      terminalDisposition: "authorization-denied",
      toolCalls: {
        requested: 3,
        executed: 1,
        succeeded: 1,
        failed: 0,
        denied: 1,
        governanceBlocked: 1,
      },
    });
    expect(() => subject.failToolBatch([], usage(), "authorization-denied")).toThrow();
  });

  it("charges denied and failed calls without counting blocked overflow as executed", () => {
    const subject = controller();
    const denied = digestPiToolCall("denied", "read", 0);
    const failed = digestPiToolCall("failed", "grep", 1);
    const requested = subject.requestToolBatch(
      [
        { callSha256: denied, authorization: "denied" },
        { callSha256: failed, authorization: "execute" },
      ],
      reservation(1),
    );
    expect(requested).toMatchObject({ authorizedToolCalls: 1, deniedToolCalls: 1 });
    subject.settleToolBatch([{ callSha256: failed, outcome: "failed" }], usage());
    subject.requestToolBatch([{ callSha256: failed, authorization: "execute" }], reservation(1));
    subject.settleToolBatch([{ callSha256: failed, outcome: "succeeded" }], usage());
    expect(runtimeEvidence(subject).toolCalls).toMatchObject({
      requested: 3,
      executed: 2,
      succeeded: 1,
      failed: 1,
      denied: 1,
    });

    // One call past the hard ceiling, so exactly one call overflows.
    const boundary = controller();
    const overflowing = LEASE.hardToolCallCeiling + 1;
    const deniedCalls = Array.from({ length: overflowing }, (_, index) => ({
      callSha256: fixtureCallSha256("d", index),
      authorization: "denied" as const,
    }));
    expect(new Set(deniedCalls.map((call) => call.callSha256)).size).toBe(overflowing);
    expect(boundary.requestToolBatch(deniedCalls, deniedOnlyReservation())).toMatchObject({
      decision: "checkpoint-required",
      deniedToolCalls: LEASE.hardToolCallCeiling,
      governanceBlockedToolCalls: 1,
    });
    boundary.settleBoundaryProviderTurn(usage());
    expect(boundary.coordinator).toMatchObject({
      phase: "checkpoint-required",
      state: {
        providerTurns: 1,
        toolCalls: {
          requested: overflowing,
          denied: LEASE.hardToolCallCeiling,
          governanceBlocked: 1,
        },
      },
    });
  });

  it("uses host renewal authority while recording checkpoint JSON as telemetry", () => {
    expect(PI_CHECKPOINT_PROMPT).toContain("Tools are unavailable");
    expect(PI_CHECKPOINT_PROMPT).toContain("host decides whether execution continues");
    expect(PI_CHECKPOINT_PROMPT).not.toContain("detailSha256");
    expect(parseCheckpointRationale(rationale)).toMatchObject({
      authority: "non-authoritative",
    });
    expect(
      parseCheckpointRationale(
        JSON.stringify({
          ...JSON.parse(rationale),
          repositoryContent: "not allowed",
        }),
      ),
    ).toBeUndefined();

    for (const [output, disposition] of [
      ["", "blank"],
      ["{}", "malformed"],
    ] as const) {
      const subject = controller();
      execute(subject, LEASE.callsPerLease);
      const decision = subject.settleCheckpointTurn(
        output,
        usage(),
        recommendation(subject),
        tranche(subject),
      );
      expect(decision).toMatchObject({ decision: "renewed" });
      expect(subject.coordinator).toMatchObject({
        phase: "active",
        state: { leaseNumber: 2 },
      });
      expect(runtimeEvidence(subject).checkpoints[0]?.disposition).toBe(disposition);
    }

    const stopped = controller();
    execute(stopped, LEASE.callsPerLease);
    expect(
      stopped.settleCheckpointTurn("", usage(), recommendation(stopped, false), tranche(stopped)),
    ).toMatchObject({ decision: "terminal", reason: "checkpoint-not-renewable" });
    expect(runtimeEvidence(stopped)).toMatchObject({
      terminalDisposition: "progress-stopped",
      checkpoints: [{ disposition: "blank" }],
    });

    const accountedStop = controller();
    execute(accountedStop, LEASE.callsPerLease);
    expect(
      accountedStop.applyHostCheckpoint(
        recommendation(accountedStop, false),
        tranche(accountedStop),
      ),
    ).toMatchObject({ decision: "terminal", reason: "checkpoint-not-renewable" });
    expect(runtimeEvidence(accountedStop)).toMatchObject({
      terminalDisposition: "progress-stopped",
      providerTurns: LEASE.callsPerLease,
      checkpointProviderTurns: 0,
      checkpoints: [],
    });
  });

  it("records cancellation, provider failure, context exhaustion, and unknown pricing explicitly", () => {
    for (const [disposition, reason] of [
      ["cancelled", "cancellation-requested"],
      ["provider-failed", "provider-terminal"],
      ["context-exhausted", "context-exhausted"],
    ] as const) {
      const subject = controller();
      execute(subject, LEASE.callsPerLease);
      subject.failObservedCheckpointTurn(disposition, usage());
      expect(runtimeEvidence(subject)).toMatchObject({
        terminalReason: reason,
        terminalDisposition:
          disposition === "cancelled"
            ? "cancelled"
            : disposition === "context-exhausted"
              ? "context-exhausted"
              : "provider-failed",
        providerTurns: LEASE.callsPerLease + 1,
        checkpointProviderTurns: 1,
        checkpoints: [{ disposition }],
      });
    }

    const ordinary = controller();
    ordinary.settleOrdinaryProviderTurn(usage());
    ordinary.stop("provider-terminal", "provider-failed");
    expect(runtimeEvidence(ordinary)).toMatchObject({
      terminalReason: "provider-terminal",
      terminalDisposition: "provider-failed",
      providerTurns: 1,
    });

    const unpriced = controller({ pricing: "unknown" });
    const callSha256 = digestPiToolCall("unpriced", "read", 0);
    const decision = unpriced.requestToolBatch(
      [{ callSha256, authorization: "execute" }],
      reservation(1),
    );
    expect(decision).toMatchObject({
      decision: "grant",
      authorizedToolCalls: 1,
      grantedEnvelope: { knownCostMicrousd: 0 },
    });
    unpriced.settleToolBatch([{ callSha256, outcome: "succeeded" }], usage());
    expect(runtimeEvidence(unpriced)).toMatchObject({
      phase: "active",
      toolCalls: { requested: 1, executed: 1, succeeded: 1 },
    });
  });

  it("stops cumulative token, time, compaction, context, and attempt overflow before dispatch", () => {
    const subject = controller({
      maxInputTokens: 2,
      maxOutputTokens: 2,
      maxElapsedMs: 2,
    });
    const before = subject.coordinator.coordinatorSha256;
    for (const candidate of [
      { ...reservation(1), inputTokens: 3 },
      { ...reservation(1), outputTokens: 3 },
      { ...reservation(1), elapsedMs: 3 },
      { ...reservation(1), compactions: 5 },
      { ...reservation(1), contextInputTokens: context.availableInputTokens + 1 },
    ]) {
      expect(() => subject.preflightProviderTurn(candidate)).toThrow();
      expect(subject.coordinator.coordinatorSha256).toBe(before);
      expect(subject.coordinator.state.providerTurns).toBe(0);
      expect(subject.coordinator.state.toolCalls.requested).toBe(0);
    }
    // A turn budget one below the fixture's is not rejected: the policy builder
    // shrinks the lease shape to fit. The shape it builds must be the resolved
    // one, not a stale hardcoded base.
    const tightTurns = BUDGETED_PROVIDER_TURNS - 1;
    const tightShape = resolveLeaseShapeForTurns(EXECUTION_LEASE_DEFAULTS, tightTurns);
    expect(controller({ maxProviderTurns: tightTurns }).coordinator.policy).toMatchObject({
      ...tightShape,
      maxProviderTurns: tightTurns,
    });
    // A budget too small to host even one call and its lease is still rejected.
    expect(() => controller({ maxProviderTurns: 1 })).toThrow();
    expect(controller({ inferenceAttempt: 1 }).coordinator.identity.identitySha256).not.toBe(
      controller({ inferenceAttempt: 2 }).coordinator.identity.identitySha256,
    );
  });

  it("retains byte-stable resumable bindings without prompts, content, or arguments", () => {
    const subject = controller();
    execute(subject, LEASE.callsPerLease);
    checkpoint(subject);
    const first = runtimeEvidence(subject);
    const second = runtimeEvidence(subject);
    expect(first).toEqual(second);
    expect(decodeExecutionLeaseRuntimeEvidence(first)).toEqual(first);
    expect(first.resume).toMatchObject({
      coordinatorSha256: subject.coordinator.coordinatorSha256,
      stateSha256: subject.coordinator.state.stateSha256,
      leaseCheckpointSha256: subject.coordinator.checkpoints[0]?.checkpointSha256,
      coordinatorCheckpointSha256: subject.coordinator.coordinatorCheckpoints[0]?.checkpointSha256,
    });
    const durable = JSON.stringify(first);
    expect(durable).not.toContain(PI_CHECKPOINT_PROMPT);
    expect(durable).not.toContain("call-0");
    expect(durable).not.toContain("repositoryContent");
    expect(() =>
      decodeExecutionLeaseRuntimeEvidence({
        ...first,
        toolCalls: { ...first.toolCalls, executed: first.toolCalls.executed + 1 },
      }),
    ).toThrow();
  });

  it("rejects accessor, proxy, undefined, extra, and open-ended evidence fields inertly", () => {
    const subject = controller();
    execute(subject, 1);
    finish(subject);
    const evidence = runtimeEvidence(subject);

    let getterCalls = 0;
    const accessor = structuredClone(evidence);
    Object.defineProperty(accessor, "terminalReason", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "completed";
      },
    });
    expect(() => decodeExecutionLeaseRuntimeEvidence(accessor)).toThrow();
    expect(getterCalls).toBe(0);

    let proxyTraps = 0;
    const proxied = new Proxy(evidence, {
      get(target, property, receiver) {
        proxyTraps += 1;
        return Reflect.get(target, property, receiver);
      },
      ownKeys(target) {
        proxyTraps += 1;
        return Reflect.ownKeys(target);
      },
    });
    expect(() => decodeExecutionLeaseRuntimeEvidence(proxied)).toThrow();
    expect(proxyTraps).toBe(0);

    expect(() =>
      decodeExecutionLeaseRuntimeEvidence({
        ...evidence,
        extra: "field",
      }),
    ).toThrow();
    expect(() =>
      decodeExecutionLeaseRuntimeEvidence(
        Object.defineProperty(structuredClone(evidence), "extra", {
          enumerable: true,
          value: undefined,
        }),
      ),
    ).toThrow();
    expect(() =>
      decodeExecutionLeaseRuntimeEvidence({
        ...evidence,
        terminalReason: "invented-terminal-reason",
      }),
    ).toThrow();
    expect(() =>
      decodeExecutionLeaseRuntimeEvidence({
        ...evidence,
        terminalDisposition: "provider-failed",
      }),
    ).toThrow();
  });
});

describe("Pi unexecuted tool-batch turn classification", () => {
  const calls = [{ id: "call-0" }, { id: "call-1" }];

  it("admits one error result per proposed call in source order", () => {
    expect(
      isPiUnexecutedToolBatchTurn(calls, [
        { toolCallId: "call-0", isError: true },
        { toolCallId: "call-1", isError: true },
      ]),
    ).toBe(true);
  });

  it.each([
    [
      "a claimed successful execution",
      [
        { toolCallId: "call-0", isError: true },
        { toolCallId: "call-1", isError: false },
      ],
    ],
    [
      "a foreign result identity",
      [
        { toolCallId: "call-0", isError: true },
        { toolCallId: "call-2", isError: true },
      ],
    ],
    [
      "a reordered result vector",
      [
        { toolCallId: "call-1", isError: true },
        { toolCallId: "call-0", isError: true },
      ],
    ],
    ["a short result vector", [{ toolCallId: "call-0", isError: true }]],
    [
      "an extra result",
      [
        { toolCallId: "call-0", isError: true },
        { toolCallId: "call-1", isError: true },
        { toolCallId: "call-1", isError: true },
      ],
    ],
  ])("rejects %s", (_label, results) => {
    expect(isPiUnexecutedToolBatchTurn(calls, results)).toBe(false);
  });

  it("rejects duplicate call identities and an empty proposal", () => {
    expect(
      isPiUnexecutedToolBatchTurn(
        [{ id: "call-0" }, { id: "call-0" }],
        [
          { toolCallId: "call-0", isError: true },
          { toolCallId: "call-0", isError: true },
        ],
      ),
    ).toBe(false);
    expect(isPiUnexecutedToolBatchTurn([], [])).toBe(false);
  });
});

/**
 * The shipped renewal request, `pi-offline.ts nextTranche`, driven through the
 * real `applyHostCheckpoint` call site rather than re-derived here.
 *
 * `renew` rejects a request whose `toolCalls` differs from the grant it is
 * about to make, and that grant subtracts the reserved final provider turn.
 * The fixtures drive the state where the reserve term, not the per-lease
 * allowance or the hard ceiling, sizes the grant: provider turns spent
 * without executing a tool call. The compaction and truncated tool-batch
 * recovery allowances make that state reachable, so it is proved here.
 */
describe("host renewal request", () => {
  /** Calls lease one is allowed, the way `createRenewalDecision` computes it. */
  const LEASE_ALLOWANCE = Math.min(LEASE.callsPerLease, LEASE.hardToolCallCeiling);
  /** What the call terms alone would grant once lease one is exhausted. */
  const CALL_TERM = Math.min(LEASE.callsPerLease, LEASE.hardToolCallCeiling - LEASE_ALLOWANCE);

  function burnProviderTurn(subject: PiExecutionLeaseController): void {
    subject.preflightProviderTurn(reservation(0));
    subject.settleOrdinaryProviderTurn(usage());
  }

  function executeOne(subject: PiExecutionLeaseController, group: string, index: number): void {
    const callSha256 = digestPiToolCall(`${group}-${index}`, "read", index);
    expect(
      subject.requestToolBatch([{ callSha256, authorization: "execute" }], reservation(1)),
    ).toMatchObject({ authorizedToolCalls: 1 });
    subject.settleToolBatch([{ callSha256, outcome: "succeeded" }], usage());
  }

  /**
   * Exhaust lease one while burning `idleTurns` tool-free provider turns, so the
   * boundary is reached with more turns spent than calls executed. The burn has
   * to happen before the last call: once the lease allowance is filled the
   * coordinator is in `checkpoint-required` and refuses an ordinary turn.
   */
  function atRenewalBoundary(
    idleTurns: number,
    options: Parameters<typeof controller>[0] = {},
  ): PiExecutionLeaseController {
    const subject = controller(options);
    for (let index = 0; index < LEASE_ALLOWANCE - 1; index += 1) {
      executeOne(subject, "idle", index);
    }
    for (let burned = 0; burned < idleTurns; burned += 1) burnProviderTurn(subject);
    executeOne(subject, "idle", LEASE_ALLOWANCE - 1);
    expect(subject.checkpointRequired).toBe(true);
    expect(subject.coordinator.state.toolCalls.executed).toBe(LEASE_ALLOWANCE);
    return subject;
  }

  /** Idle turns that leave the reserve term one call short of the call terms. */
  const RESERVE_BINDS = BUDGETED_PROVIDER_TURNS - LEASE_ALLOWANCE - CALL_TERM;

  it("requests exactly the grant at the lease boundary, with no turns idled", () => {
    // Positive control: without this row every assertion below could pass
    // because renewal never happens.
    const subject = atRenewalBoundary(0);
    const request = nextTranche(subject);
    expect(request.toolCalls).toBe(CALL_TERM);
    const decision = subject.applyHostCheckpoint(recommendation(subject), request);
    expect(decision).toMatchObject({ decision: "renewed" });
    expect(subject.coordinator.state.leaseNumber).toBe(2);
  });

  it("holds the reserve when the remaining turns are exactly the call terms", () => {
    // At the limit: reserve term == call term, so the request is unchanged.
    const subject = atRenewalBoundary(RESERVE_BINDS - 1);
    const state = subject.coordinator.state;
    expect(BUDGETED_PROVIDER_TURNS - state.providerTurns - 1).toBe(CALL_TERM);
    const request = nextTranche(subject);
    expect(request.toolCalls).toBe(CALL_TERM);
    expect(subject.applyHostCheckpoint(recommendation(subject), request)).toMatchObject({
      decision: "renewed",
    });
    expect(subject.coordinator.state.leaseNumber).toBe(2);
  });

  it("asks for one call fewer when a spent provider turn takes the reserve past the limit", () => {
    // Limit plus one: the reserve, not the allowance or the ceiling, sizes the
    // grant. A request built from the call terms alone is one call too large and
    // `renew` rejects the whole transition.
    const subject = atRenewalBoundary(RESERVE_BINDS);
    const state = subject.coordinator.state;
    expect(BUDGETED_PROVIDER_TURNS - state.providerTurns - 1).toBe(CALL_TERM - 1);
    const request = nextTranche(subject);
    expect(request.toolCalls).toBe(CALL_TERM - 1);
    expect(request.providerTurns).toBe(request.toolCalls);
    expect(subject.applyHostCheckpoint(recommendation(subject), request)).toMatchObject({
      decision: "renewed",
    });
    expect(subject.coordinator.state.leaseNumber).toBe(2);
  });

  it("rejects the transition when a request drops the reserved final turn", () => {
    // Adjacent condition: the same state, asked for with the call terms only.
    // This is why the reserve term cannot be re-derived separately from
    // `renewalToolCallGrant`.
    const subject = atRenewalBoundary(RESERVE_BINDS);
    const callTermsOnly = { ...nextTranche(subject), toolCalls: CALL_TERM };
    expect(() => subject.applyHostCheckpoint(recommendation(subject), callTermsOnly)).toThrow(
      "Execution lease coordinator rejected the transition.",
    );
  });

  // One boundary per case: each fixture drives a full lease of tool calls, and
  // four inside one `it` can exceed the five-second deadline on a loaded host.
  it.each([0, 1, "reserve-limit", "reserve-limit-plus-one"] as const)(
    "never requests more of a cumulative budget than the attempt still holds (idle=%s)",
    (idle) => {
      // The demand is a share of the remainder, so it can only confirm what the
      // settled state already knows. A ceiling-rounded or unreserved share would
      // ask for the whole remainder and deny renewals the state admits. Distinct
      // output and elapsed budgets make an axis swap between the shares visible.
      const idleTurns =
        idle === "reserve-limit"
          ? RESERVE_BINDS - 1
          : idle === "reserve-limit-plus-one"
            ? RESERVE_BINDS
            : idle;
      const subject = atRenewalBoundary(idleTurns, {
        maxOutputTokens: 4_000,
        maxElapsedMs: 9_000,
      });
      const { policy, state } = subject.coordinator;
      if (policy.schemaVersion !== 1) {
        throw new Error("finite renewal test requires a V1 policy");
      }
      const remainingOutput = policy.cumulative.maxOutputTokens - state.cumulativeOutputTokens;
      const remainingElapsed = policy.cumulative.maxElapsedMs - state.elapsedMs;
      const request = nextTranche(subject);
      expect(remainingOutput).toBeGreaterThan(0);
      expect(request.outputTokens).toBeGreaterThanOrEqual(1);
      expect(request.outputTokens).toBeLessThanOrEqual(remainingOutput);
      expect(request.elapsedMs).toBeGreaterThanOrEqual(1);
      expect(request.elapsedMs).toBeLessThanOrEqual(remainingElapsed);
      expect(request.compactions).toBeLessThanOrEqual(policy.maxCompactions - state.compactions);
      // The two shares read different budgets; equal demands would mean one
      // axis is being measured with the other's remainder.
      expect(remainingOutput).not.toBe(remainingElapsed);
      expect(request.outputTokens).not.toBe(request.elapsedMs);
      expect(subject.applyHostCheckpoint(recommendation(subject), request)).toMatchObject({
        decision: "renewed",
      });
    },
  );

  it("still funds a renewal with a single output token left, and names the spent budget", () => {
    // At the limit: one token of output authority left. The share floors to one
    // unit, which the remainder covers exactly, so renewal is admitted.
    const oneLeft = atRenewalBoundary(0, {
      maxOutputTokens: LEASE_ALLOWANCE + 1,
    });
    expect(nextTranche(oneLeft).outputTokens).toBe(1);
    expect(
      oneLeft.applyHostCheckpoint(recommendation(oneLeft), nextTranche(oneLeft)),
    ).toMatchObject({ decision: "renewed" });

    // Limit plus one: the same run with the budget spent exactly. The floor of
    // one unit is more than nothing, so the request cannot be funded and the
    // coordinator names the cumulative output budget.
    const spent = atRenewalBoundary(0, { maxOutputTokens: LEASE_ALLOWANCE });
    const { policy, state } = spent.coordinator;
    if (policy.schemaVersion !== 1) {
      throw new Error("finite renewal test requires a V1 policy");
    }
    expect(policy.cumulative.maxOutputTokens - state.cumulativeOutputTokens).toBe(0);
    expect(nextTranche(spent).outputTokens).toBe(1);
    expect(spent.applyHostCheckpoint(recommendation(spent), nextTranche(spent))).toMatchObject({
      decision: "denied",
      reason: "cumulative-output-limit",
    });
  });
});

describe("batched answer-record renewal", () => {
  function recordController(shared?: boolean): PiExecutionLeaseController {
    const readOnly = shared === undefined;
    // Four leases keep the separate pool's read and record ceilings inside
    // the policy's combined lease capacity while exercising the same turn gap.
    const policy = createExecutionLeasePolicy({
      callsPerLease: 4,
      maxLeases: 4,
      hardToolCallCeiling: readOnly ? 12 : 4,
      ...(readOnly ? {} : { answerRecordCallCeiling: 12 }),
      ...(shared ? { sharedToolCallCapacity: true as const } : {}),
      maxProviderTurns: readOnly ? 16 : 8,
      maxCompactions: 4,
      cumulative: { maxInputTokens: 100, maxOutputTokens: 90, maxElapsedMs: 120 },
    });
    return new PiExecutionLeaseController({
      policy,
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
        status: "known",
        inputMicrousdPerMillionTokens: 100,
        outputMicrousdPerMillionTokens: 200,
        authoritySha256: digest("7"),
      },
      context,
    });
  }

  function recordBatch(
    subject: PiExecutionLeaseController,
    group: string,
    scope: "answer-record" | "reading" = "answer-record",
  ): void {
    const calls = Array.from({ length: subject.coordinator.policy.callsPerLease }, (_, index) => ({
      callSha256: digestPiToolCall(`${group}-${index}`, scope, index),
      authorization: "execute" as const,
      scope,
    }));
    expect(subject.requestToolBatch(calls, reservation(calls.length))).toMatchObject({
      authorizedToolCalls: calls.length,
    });
    subject.settleToolBatch(
      calls.map(({ callSha256 }) => ({ callSha256, outcome: "succeeded" as const })),
      usage(),
    );
    expect(subject.checkpointRequired).toBe(true);
  }

  function idleTurns(subject: PiExecutionLeaseController, count: number): void {
    for (let turn = 0; turn < count; turn += 1) {
      subject.preflightProviderTurn(reservation(0));
      subject.settleOrdinaryProviderTurn(usage());
    }
  }

  it.each([false, true])("renews a full batched record grant with shared=%s", (shared) => {
    const subject = recordController(shared);
    recordBatch(subject, "first");
    expect(
      subject.applyHostCheckpoint(recommendation(subject), nextTranche(subject)),
    ).toMatchObject({
      decision: "renewed",
    });
    idleTurns(subject, 3);
    recordBatch(subject, "second");

    const { policy, state } = subject.coordinator;
    const turnsLeft = policy.maxProviderTurns - state.providerTurns;
    expect(turnsLeft).toBe(3);
    const request = nextTranche(subject);
    expect(request.toolCalls).toBe(4);
    expect(request.providerTurns).toBeLessThanOrEqual(turnsLeft - 1);
    expect(request.compactions).toBeLessThanOrEqual(request.providerTurns);
    expect(request.outputTokens).toBe(
      Math.floor(
        ((policy.cumulative.maxOutputTokens - state.cumulativeOutputTokens) *
          request.providerTurns) /
          turnsLeft,
      ),
    );
    expect(request.elapsedMs).toBe(
      Math.floor(
        ((policy.cumulative.maxElapsedMs - state.elapsedMs) * request.providerTurns) / turnsLeft,
      ),
    );
    expect(subject.applyHostCheckpoint(recommendation(subject), request)).toMatchObject({
      decision: "renewed",
    });
    recordBatch(subject, "third");
    expect(subject.coordinator.state.providerTurns).toBeLessThan(policy.maxProviderTurns);
    expect(subject.coordinator.state.answerRecordCallsAdmitted).toBe(12);
    expect(subject.settleBoundaryProviderTurn(usage())).toMatchObject({
      decision: "checkpoint-required",
    });
    expect(subject.complete()).toMatchObject({ decision: "terminal", reason: "completed" });
  });

  it.each([false, true])(
    "refuses the one-turn boundary without spending pending records with shared=%s",
    (shared) => {
      const subject = recordController(shared);
      recordBatch(subject, "first");
      expect(
        subject.applyHostCheckpoint(recommendation(subject), nextTranche(subject)),
      ).toMatchObject({ decision: "renewed" });
      idleTurns(subject, 5);
      recordBatch(subject, "second");
      const pending =
        subject.coordinator.policy.answerRecordCallCeiling! -
        subject.coordinator.state.answerRecordCallsAdmitted!;
      expect(pending).toBe(4);
      const decision = subject.applyHostCheckpoint(recommendation(subject), nextTranche(subject));
      expect(decision).toMatchObject({ decision: "denied", reason: "provider-turn-limit" });
      expect(subject.coordinator.terminalReason).toBe("provider-turn-limit");
      expect(subject.coordinator.state.answerRecordCallsAdmitted).toBe(8);
      expect(subject.coordinator.state.toolCalls.executed).toBe(8);
      expect(
        subject.coordinator.policy.answerRecordCallCeiling! -
          subject.coordinator.state.answerRecordCallsAdmitted!,
      ).toBe(pending);
      expect(subject.coordinator.checkpoints.at(-1)?.state.answerRecordCallsAdmitted).toBe(8);
      expect(runtimeEvidence(subject)).toMatchObject({
        phase: "terminal",
        terminalReason: "provider-turn-limit",
        toolCalls: { executed: 8 },
      });
    },
  );

  it("keeps read-only renewal at one call per provider turn", () => {
    const subject = recordController();
    recordBatch(subject, "read-only", "reading");
    const request = nextTranche(subject);
    expect(request.toolCalls).toBe(4);
    expect(request.providerTurns).toBe(request.toolCalls);
    expect(subject.applyHostCheckpoint(recommendation(subject), request)).toMatchObject({
      decision: "renewed",
    });
  });
});
