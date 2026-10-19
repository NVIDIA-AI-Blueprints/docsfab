// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { InferenceAttemptEvidence, InferenceTurnEvidence } from "../src/records/contracts.js";
import { InferenceStepError } from "../src/execution/contracts.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import {
  EXECUTION_STOP_REASON_PRECEDENCE,
  EXECUTION_LEASE_DEFAULTS,
  assertStateProgression,
  createExecutionCheckpoint,
  createExecutionLeaseIdentity,
  createExecutionLeasePolicy,
  createExecutionLeasePolicyV2,
  createExecutionLeaseRecord,
  createExecutionLeaseState,
  decodeExecutionLeasePolicy,
  decodeExecutionLeasePolicyV2,
  decideExecutionLeaseRenewal,
  migrateLegacyInferenceAttemptEvidence,
  parseExecutionLeaseRecord,
  parseLegacyExecutionLeaseCompatibility,
  selectExecutionStopReason,
  serializeExecutionLeaseRecord,
  serializeLegacyExecutionLeaseCompatibility,
  type ExecutionCostStateV1,
  type ExecutionLeasePolicyV1,
  type ExecutionLeaseStateV1,
  type ExecutionToolCallCountersV1,
} from "../src/execution/index.js";
import { configureCredential } from "./helpers/configured-credential.js";

const digest = (character: string): string => character.repeat(64);

function policy(
  overrides: Parameters<typeof createExecutionLeasePolicy>[0] = {
    maxCompactions: 2,
    cumulative: {
      maxInputTokens: 100_000,
      maxOutputTokens: 20_000,
      maxElapsedMs: 300_000,
      maxKnownCostMicrousd: 2_000_000,
    },
  },
): ExecutionLeasePolicyV1 {
  return createExecutionLeasePolicy(overrides);
}

const identity = createExecutionLeaseIdentity({
  inferenceAttempt: 2,
  retriesConsumed: 1,
  authorizationSha256: digest("a"),
  repositoryRevision: "b".repeat(40),
  contextPacketSha256: digest("c"),
  evidenceSha256: digest("d"),
  toolPolicySha256: digest("e"),
  contextAuthoritySha256: digest("f"),
  policySha256: policy().policySha256,
});

it("surfaces credential material at the execution lease boundary", () => {
  configureCredential(`glpat-${"x".repeat(24)}`);
  const {
    schemaVersion: _schemaVersion,
    kind: _kind,
    identitySha256: _identitySha256,
    ...input
  } = identity;
  expect(() =>
    createExecutionLeaseIdentity({
      ...input,
      repositoryRevision: `glpat-${"x".repeat(24)}`,
    }),
  ).toThrowError(expect.objectContaining({ code: "credential-material" }));
});

function legacyTurn(overrides: Partial<InferenceTurnEvidence> = {}): InferenceTurnEvidence {
  return {
    turn: 1,
    toolCalls: 0,
    toolResults: 0,
    maxProviderTurns: 8,
    maxToolCalls: 16,
    compactions: 0,
    maxCompactions: 1,
    configuredContextWindow: 128_000,
    effectiveContextWindow: 8_192,
    configuredMaxOutputTokens: 16_384,
    effectiveMaxOutputTokens: 4_096,
    reservedTokens: 128,
    estimatedInputTokens: 100,
    availableOutputTokens: 4_096,
    requiredMinimumOutputTokens: 16,
    outputTokens: 4_096,
    decision: "proceed",
    requestDigest: digest("7"),
    evidenceDigest: digest("8"),
    ...overrides,
  };
}

function counters(
  overrides: Partial<ExecutionToolCallCountersV1> = {},
): ExecutionToolCallCountersV1 {
  const succeeded = overrides.succeeded ?? overrides.executed ?? 0;
  const failed = overrides.failed ?? 0;
  const executed = overrides.executed ?? succeeded + failed;
  const denied = overrides.denied ?? 0;
  const governanceBlocked = overrides.governanceBlocked ?? 0;
  return {
    requested: overrides.requested ?? executed + denied + governanceBlocked,
    executed,
    succeeded,
    failed,
    denied,
    governanceBlocked,
  };
}

function state(
  leasePolicy: ExecutionLeasePolicyV1,
  overrides: Partial<Omit<ExecutionLeaseStateV1, "schemaVersion" | "kind" | "stateSha256">> = {},
  previous?: ExecutionLeaseStateV1,
): ExecutionLeaseStateV1 {
  return createExecutionLeaseState(
    {
      leaseNumber: 1,
      leaseExecutedToolCalls: 0,
      providerTurns: 0,
      compactions: 0,
      toolCalls: counters(),
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      elapsedMs: 0,
      cost: { status: "known", microusd: 0 },
      lastCheckpointSha256: null,
      ...overrides,
    },
    leasePolicy,
    previous,
  );
}

function exhaustedCheckpoint(
  leasePolicy: ExecutionLeasePolicyV1,
  overrides: {
    cost?: ExecutionCostStateV1;
    input?: number;
    output?: number;
    elapsed?: number;
    providerTurns?: number;
  } = {},
) {
  const exhausted = state(leasePolicy, {
    leaseExecutedToolCalls: leasePolicy.callsPerLease,
    providerTurns: overrides.providerTurns ?? leasePolicy.callsPerLease,
    toolCalls: counters({ executed: leasePolicy.callsPerLease }),
    cumulativeInputTokens: overrides.input ?? 5_000,
    cumulativeOutputTokens: overrides.output ?? 1_000,
    elapsedMs: overrides.elapsed ?? 10_000,
    cost: overrides.cost ?? { status: "known", microusd: 50_000 },
  });
  return createExecutionCheckpoint({
    policy: leasePolicy,
    identity,
    state: exhausted,
    reason: "lease-exhausted",
  });
}

describe("versioned execution lease contracts", () => {
  it("round trips V2 aggregate absence without inventing finite ceilings", () => {
    const v2 = createExecutionLeasePolicyV2({
      callsPerLease: 2,
      sharedToolCallCapacity: true,
      aggregatePolicy: { kind: "absent" },
    });

    expect(v2).toMatchObject({
      schemaVersion: 2,
      callsPerLease: 2,
      aggregatePolicy: { kind: "absent" },
    });
    expect(v2).not.toHaveProperty("maxLeases");
    expect(v2).not.toHaveProperty("hardToolCallCeiling");
    expect(v2).not.toHaveProperty("maxProviderTurns");
    expect(v2).not.toHaveProperty("cumulative");
    expect(v2).not.toHaveProperty("maxCompactions");
    expect(decodeExecutionLeasePolicyV2(v2)).toEqual(v2);
    expect(() => decodeExecutionLeasePolicy(v2)).toThrow();
    expect(() => decodeExecutionLeasePolicyV2({ ...v2, sharedToolCallCapacity: false })).toThrow();
    expect(() =>
      decodeExecutionLeasePolicyV2({ ...v2, aggregatePolicy: { kind: "finite" } }),
    ).toThrow();

    const v2Identity = createExecutionLeaseIdentity({
      inferenceAttempt: 2,
      retriesConsumed: 1,
      authorizationSha256: digest("a"),
      repositoryRevision: "b".repeat(40),
      contextPacketSha256: digest("c"),
      evidenceSha256: digest("d"),
      toolPolicySha256: digest("e"),
      contextAuthoritySha256: digest("f"),
      policySha256: v2.policySha256,
    });
    const v2State = createExecutionLeaseState(
      {
        leaseNumber: 1,
        leaseExecutedToolCalls: 2,
        leaseToolCallAllowance: 2,
        leaseExecutedAnswerRecordCalls: 0,
        leaseAdmittedAnswerRecordCalls: 0,
        providerTurns: 600,
        compactions: 600,
        toolCalls: counters({ executed: 2 }),
        toolCallsByScope: { reading: 2, answerRecord: 0 },
        answerRecordCallsAdmitted: 0,
        cumulativeInputTokens: 40_000,
        cumulativeOutputTokens: 10_000,
        elapsedMs: 2_000_000,
        cost: { status: "known", microusd: 0 },
        lastCheckpointSha256: null,
      },
      v2,
    );
    const v2Checkpoint = createExecutionCheckpoint({
      policy: v2,
      identity: v2Identity,
      state: v2State,
      reason: "lease-exhausted",
    });
    const v2Grant = decideExecutionLeaseRenewal({
      policy: v2,
      identity: v2Identity,
      checkpoint: v2Checkpoint,
    });
    expect(v2Grant).toMatchObject({ schemaVersion: 2, decision: "granted", grantedToolCalls: 2 });
    expect(v2Grant).not.toHaveProperty("remainingProviderTurns");
    expect(v2Grant).not.toHaveProperty("remainingInputTokens");
  });

  // Every numeric expectation below derives from these, so the suite cannot drift
  // from the defaults it tests.
  const {
    callsPerLease: CALLS,
    maxLeases: LEASES,
    hardToolCallCeiling: CEILING,
    maxProviderTurns: TURNS,
  } = EXECUTION_LEASE_DEFAULTS;

  it("applies the shipped defaults and validates contradictory policies", () => {
    const leasePolicy = policy();
    expect(leasePolicy).toMatchObject(EXECUTION_LEASE_DEFAULTS);

    // Each entry violates exactly one decodeExecutionLeasePolicy invariant, by one.
    const invalidInputs = [
      { callsPerLease: 0 },
      { maxLeases: -1 },
      // callsPerLease <= hardToolCallCeiling
      { hardToolCallCeiling: CALLS - 1 },
      // hardToolCallCeiling <= callsPerLease * maxLeases
      { hardToolCallCeiling: CALLS * LEASES + 1 },
      // maxProviderTurns >= hardToolCallCeiling + maxLeases
      { maxProviderTurns: CEILING + LEASES - 1 },
      { callsPerLease: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const invalid of invalidInputs) {
      expect(() =>
        policy({
          maxCompactions: 2,
          cumulative: { maxInputTokens: 1, maxOutputTokens: 1, maxElapsedMs: 1 },
          ...invalid,
        }),
      ).toThrowError();
    }
  });

  it.each([
    ["schema version", { schemaVersion: 2 }],
    ["kind", { kind: "docsfab-legacy-execution-lease-policy" }],
  ])("requires migration for an incompatible lease policy %s", (_label, alteration) => {
    expect(() => decodeExecutionLeasePolicy({ ...policy(), ...alteration })).toThrowError(
      expect.objectContaining({ code: "migration-required" }),
    );
  });

  it("enforces exact requested/executed/result counter accounting", () => {
    const leasePolicy = policy();
    expect(() =>
      state(leasePolicy, {
        toolCalls: counters({ requested: 2, executed: 2, succeeded: 2, governanceBlocked: 1 }),
      }),
    ).toThrowError(/invalid-state/u);
    expect(() =>
      state(leasePolicy, {
        toolCalls: counters({ requested: 2, executed: 2, succeeded: 1 }),
      }),
    ).toThrowError(/invalid-state/u);
  });

  it("records a blocked overflow call without masquerading it as executed", () => {
    const leasePolicy = policy();
    // A lease consumed to its full allowance; the overflow call is blocked, not executed.
    const before = state(leasePolicy, {
      leaseExecutedToolCalls: CALLS,
      providerTurns: CALLS,
      toolCalls: counters({ executed: CALLS }),
    });
    const after = state(
      leasePolicy,
      {
        leaseExecutedToolCalls: CALLS,
        providerTurns: CALLS,
        toolCalls: counters({ executed: CALLS, governanceBlocked: 1 }),
      },
      before,
    );

    expect(after.toolCalls).toMatchObject({
      requested: CALLS + 1,
      executed: CALLS,
      governanceBlocked: 1,
    });
  });

  it("rejects regressions and requires a fully consumed lease before renewal", () => {
    const leasePolicy = policy();
    // One call short of the per-lease allowance, so the lease is not renewable yet.
    const partiallyConsumed = CALLS - 1;
    const previous = state(leasePolicy, {
      leaseExecutedToolCalls: partiallyConsumed,
      providerTurns: partiallyConsumed,
      toolCalls: counters({ executed: partiallyConsumed }),
      cumulativeInputTokens: 500,
    });
    const regressionCandidate = state(leasePolicy, {
      leaseExecutedToolCalls: partiallyConsumed,
      providerTurns: partiallyConsumed,
      toolCalls: counters({ executed: partiallyConsumed }),
      cumulativeInputTokens: 499,
    });
    expect(() => assertStateProgression(previous, regressionCandidate, leasePolicy)).toThrowError(
      /counter-regression/u,
    );

    expect(() =>
      state(
        leasePolicy,
        {
          leaseNumber: 2,
          leaseExecutedToolCalls: 0,
          providerTurns: partiallyConsumed,
          toolCalls: counters({ executed: partiallyConsumed }),
          cumulativeInputTokens: 500,
        },
        previous,
      ),
    ).toThrowError(/counter-regression/u);

    expect(() =>
      state(
        leasePolicy,
        {
          leaseExecutedToolCalls: partiallyConsumed,
          providerTurns: partiallyConsumed + 1,
          toolCalls: counters({ executed: partiallyConsumed + 1 }),
          cumulativeInputTokens: 500,
        },
        previous,
      ),
    ).toThrowError(/counter-regression/u);
  });

  it("grants the next lease without expanding any cumulative authority", () => {
    const leasePolicy = policy();
    const checkpoint = exhaustedCheckpoint(leasePolicy);
    const decision = decideExecutionLeaseRenewal({ policy: leasePolicy, identity, checkpoint });

    expect(decision).toMatchObject({
      decision: "granted",
      leaseNumber: 2,
      grantedToolCalls: CALLS,
      // exhaustedCheckpoint burns one provider turn per executed tool call.
      remainingProviderTurns: TURNS - CALLS,
      remainingInputTokens: 95_000,
      remainingOutputTokens: 19_000,
      remainingElapsedMs: 290_000,
      remainingKnownCostMicrousd: 1_950_000,
      identitySha256: identity.identitySha256,
      policySha256: leasePolicy.policySha256,
      checkpointSha256: checkpoint.checkpointSha256,
    });
  });

  it("renews causally through all four leases and rejects missing or substituted history", () => {
    const leasePolicy = policy();
    const initialState = state(leasePolicy);
    const checkpoints = [] as ReturnType<typeof createExecutionCheckpoint>[];
    const decisions = [] as ReturnType<typeof decideExecutionLeaseRenewal>[];
    let previousState = initialState;
    for (let leaseNumber = 1; leaseNumber <= leasePolicy.maxLeases; leaseNumber += 1) {
      const executed = leaseNumber * leasePolicy.callsPerLease;
      const exhausted = state(
        leasePolicy,
        {
          leaseNumber,
          leaseExecutedToolCalls: leasePolicy.callsPerLease,
          providerTurns: executed,
          toolCalls: counters({ executed }),
          cumulativeInputTokens: leaseNumber * 5_000,
          cumulativeOutputTokens: leaseNumber * 1_000,
          elapsedMs: leaseNumber * 10_000,
          cost: { status: "known", microusd: leaseNumber * 50_000 },
          lastCheckpointSha256: checkpoints.at(-1)?.checkpointSha256 ?? null,
        },
        previousState,
      );
      const checkpoint = createExecutionCheckpoint({
        policy: leasePolicy,
        identity,
        state: exhausted,
        reason: "lease-exhausted",
        ...(checkpoints.length === 0 ? {} : { previous: checkpoints.at(-1)! }),
      });
      checkpoints.push(checkpoint);
      const decision = decideExecutionLeaseRenewal({
        policy: leasePolicy,
        identity,
        checkpoint,
        ...(checkpoints.length === 1
          ? {}
          : {
              history: {
                checkpoints: checkpoints.slice(0, -1),
                decisions,
              },
            }),
      });
      decisions.push(decision);
      previousState = checkpoint.state;
    }

    // Every lease but the last grants the full per-lease allowance; the last exhausts
    // the hard ceiling (callsPerLease * maxLeases) and is denied there.
    expect(
      decisions.map((decision) =>
        decision.decision === "granted"
          ? `grant-${decision.leaseNumber}-${decision.grantedToolCalls}`
          : `deny-${decision.reason}`,
      ),
    ).toEqual([
      ...Array.from({ length: LEASES - 1 }, (_unused, index) => `grant-${index + 2}-${CALLS}`),
      "deny-hard-tool-call-ceiling",
    ]);
    expect(() =>
      decideExecutionLeaseRenewal({
        policy: leasePolicy,
        identity,
        checkpoint: checkpoints[1]!,
      }),
    ).toThrowError(/invalid-checkpoint/u);
    expect(() =>
      decideExecutionLeaseRenewal({
        policy: leasePolicy,
        identity,
        checkpoint: checkpoints[1]!,
        history: { checkpoints: [checkpoints[0]!], decisions: [] },
      }),
    ).toThrowError(/invalid-decision/u);

    const substitutedPredecessor = createExecutionCheckpoint({
      policy: leasePolicy,
      identity,
      state: checkpoints[0]!.state,
      reason: "budget-boundary",
    });
    expect(() =>
      decideExecutionLeaseRenewal({
        policy: leasePolicy,
        identity,
        checkpoint: checkpoints[1]!,
        history: { checkpoints: [substitutedPredecessor], decisions: [decisions[0]!] },
      }),
    ).toThrowError(/invalid-checkpoint|invalid-decision/u);
  });

  it("fails closed when configured pricing is unknown or stale, never treating it as zero", () => {
    const leasePolicy = policy();
    for (const reason of ["pricing-unknown", "pricing-stale"] as const) {
      const unavailable = state(leasePolicy, {
        cost: { status: "unavailable", reason },
      });
      const checkpoint = createExecutionCheckpoint({
        policy: leasePolicy,
        identity,
        state: unavailable,
        reason: "budget-boundary",
      });
      expect(
        decideExecutionLeaseRenewal({ policy: leasePolicy, identity, checkpoint }),
      ).toMatchObject({ decision: "denied", reason: "cost-unavailable" });

      expect(() =>
        state(leasePolicy, {
          leaseExecutedToolCalls: 1,
          providerTurns: 1,
          toolCalls: counters({ executed: 1 }),
          cumulativeInputTokens: 1,
          cost: { status: "unavailable", reason },
        }),
      ).toThrowError(/invalid-state/u);
    }
  });

  it("uses stable safety-first precedence for overlapping stop conditions", () => {
    expect(
      selectExecutionStopReason([
        "provider-unavailable",
        "cumulative-time-limit",
        "authorization-denied",
        "security-denied",
      ]),
    ).toBe("security-denied");
    expect(EXECUTION_STOP_REASON_PRECEDENCE).toEqual([
      "security-denied",
      "authorization-denied",
      "cancellation-requested",
      "evidence-preservation-required",
      "context-exhausted",
      "hard-tool-call-ceiling",
      "cumulative-input-limit",
      "cumulative-output-limit",
      "output-authority-exhausted",
      "cumulative-time-limit",
      "cost-unavailable",
      "cumulative-cost-limit",
      "provider-turn-limit",
      "lease-limit",
      "checkpoint-not-renewable",
      "provider-terminal",
      "provider-unavailable",
    ]);
    expect(() => selectExecutionStopReason(["lease-limit", "lease-limit"])).toThrowError(
      /invalid-decision/u,
    );
  });

  it("binds renewal to immutable attempt, authorization, revision, context, evidence, and tool identity", () => {
    const leasePolicy = policy();
    const checkpoint = exhaustedCheckpoint(leasePolicy);
    const alteredIdentity = createExecutionLeaseIdentity({
      inferenceAttempt: 3,
      retriesConsumed: identity.retriesConsumed,
      authorizationSha256: identity.authorizationSha256,
      repositoryRevision: identity.repositoryRevision,
      contextPacketSha256: identity.contextPacketSha256,
      evidenceSha256: identity.evidenceSha256,
      toolPolicySha256: identity.toolPolicySha256,
      contextAuthoritySha256: identity.contextAuthoritySha256,
      policySha256: leasePolicy.policySha256,
    });
    expect(() =>
      decideExecutionLeaseRenewal({
        policy: leasePolicy,
        identity: alteredIdentity,
        checkpoint,
      }),
    ).toThrowError(/invalid-checkpoint/u);
  });

  it("rejects policy substitution at identity, checkpoint, and decision boundaries", () => {
    const originalPolicy = policy();
    const checkpoint = exhaustedCheckpoint(originalPolicy);
    const expandedPolicy = policy({
      // Strictly more authority than the defaults in every dimension it names.
      maxProviderTurns: TURNS * 2,
      maxCompactions: 4,
      cumulative: {
        maxInputTokens: 200_000,
        maxOutputTokens: 40_000,
        maxElapsedMs: 600_000,
        maxKnownCostMicrousd: 4_000_000,
      },
    });
    const expandedIdentity = createExecutionLeaseIdentity({
      inferenceAttempt: identity.inferenceAttempt,
      retriesConsumed: identity.retriesConsumed,
      authorizationSha256: identity.authorizationSha256,
      repositoryRevision: identity.repositoryRevision,
      contextPacketSha256: identity.contextPacketSha256,
      evidenceSha256: identity.evidenceSha256,
      toolPolicySha256: identity.toolPolicySha256,
      contextAuthoritySha256: identity.contextAuthoritySha256,
      policySha256: expandedPolicy.policySha256,
    });

    expect(() =>
      decideExecutionLeaseRenewal({
        policy: expandedPolicy,
        identity,
        checkpoint,
      }),
    ).toThrowError(/invalid-decision/u);
    expect(() =>
      decideExecutionLeaseRenewal({
        policy: expandedPolicy,
        identity: expandedIdentity,
        checkpoint,
      }),
    ).toThrowError(/invalid-checkpoint/u);
  });

  it("requires a sequence-one checkpoint to originate in lease one", () => {
    const leasePolicy = policy();
    const leaseTwoState = state(leasePolicy, { leaseNumber: 2 });
    expect(() =>
      createExecutionCheckpoint({
        policy: leasePolicy,
        identity,
        state: leaseTwoState,
        reason: "host-requested",
      }),
    ).toThrowError(/invalid-checkpoint/u);
  });

  it("round-trips content-free boundary evidence with byte-stable canonical serialization", () => {
    const leasePolicy = policy();
    const initialState = state(leasePolicy);
    const checkpoint = exhaustedCheckpoint(leasePolicy);
    const decision = decideExecutionLeaseRenewal({ policy: leasePolicy, identity, checkpoint });
    const finalState = state(
      leasePolicy,
      {
        leaseNumber: 2,
        leaseExecutedToolCalls: 3,
        providerTurns: checkpoint.state.providerTurns + 3,
        compactions: checkpoint.state.compactions,
        toolCalls: counters({ executed: checkpoint.state.toolCalls.executed + 3 }),
        cumulativeInputTokens: checkpoint.state.cumulativeInputTokens + 600,
        cumulativeOutputTokens: checkpoint.state.cumulativeOutputTokens + 120,
        elapsedMs: checkpoint.state.elapsedMs + 500,
        cost: { status: "known", microusd: 55_000 },
        lastCheckpointSha256: checkpoint.checkpointSha256,
      },
      checkpoint.state,
    );
    const record = createExecutionLeaseRecord({
      policy: leasePolicy,
      identity,
      initialState,
      checkpoints: [checkpoint],
      decisions: [decision],
      finalState,
    });

    const first = serializeExecutionLeaseRecord(record);
    const parsed = parseExecutionLeaseRecord(first);
    expect(serializeExecutionLeaseRecord(parsed)).toBe(first);
    expect(parseExecutionLeaseRecord(JSON.parse(first))).toEqual(parsed);
    expect(() => parseExecutionLeaseRecord(` ${first}`)).toThrowError(/noncanonical-json/u);
    expect(() => parseExecutionLeaseRecord(new TextEncoder().encode(`\n${first}`))).toThrowError(
      /noncanonical-json/u,
    );
    const decoded = JSON.parse(first) as Record<string, unknown>;
    const reordered = JSON.stringify({ recordSha256: decoded.recordSha256, ...decoded });
    expect(() => parseExecutionLeaseRecord(reordered)).toThrowError(/noncanonical-json/u);
    expect(first).not.toContain("prompt");
    expect(first).not.toContain("workspacePath");
    expect(parsed.checkpoints[0]?.previousCheckpointSha256).toBeNull();
    expect(parsed.decisions[0]?.checkpointSha256).toBe(parsed.checkpoints[0]?.checkpointSha256);
  });

  it("requires a persisted grant for every lease-number transition", () => {
    const leasePolicy = policy();
    const initialState = state(leasePolicy);
    const checkpoint = exhaustedCheckpoint(leasePolicy);
    const renewed = state(
      leasePolicy,
      {
        leaseNumber: 2,
        leaseExecutedToolCalls: 1,
        providerTurns: checkpoint.state.providerTurns + 1,
        toolCalls: counters({ executed: checkpoint.state.toolCalls.executed + 1 }),
        cumulativeInputTokens: checkpoint.state.cumulativeInputTokens,
        cumulativeOutputTokens: checkpoint.state.cumulativeOutputTokens,
        elapsedMs: checkpoint.state.elapsedMs,
        cost: checkpoint.state.cost,
        lastCheckpointSha256: checkpoint.checkpointSha256,
      },
      checkpoint.state,
    );

    expect(() =>
      createExecutionLeaseRecord({
        policy: leasePolicy,
        identity,
        initialState,
        checkpoints: [checkpoint],
        decisions: [],
        finalState: renewed,
      }),
    ).toThrowError(/invalid-record/u);
  });

  it("requires a version-1 record to begin at lease one", () => {
    const leasePolicy = policy();
    const initialState = state(leasePolicy, { leaseNumber: 2 });

    expect(() =>
      createExecutionLeaseRecord({
        policy: leasePolicy,
        identity,
        initialState,
        checkpoints: [],
        decisions: [],
        finalState: initialState,
      }),
    ).toThrowError(/invalid-record/u);
  });

  it("requires an authoritative zero initial execution position", () => {
    const leasePolicy = policy();
    for (const initialState of [
      state(leasePolicy, {
        leaseExecutedToolCalls: CALLS,
        providerTurns: CALLS,
        toolCalls: counters({ executed: CALLS }),
        cumulativeInputTokens: 1_000,
        cumulativeOutputTokens: 100,
        elapsedMs: 500,
        cost: { status: "known", microusd: 10_000 },
      }),
      state(leasePolicy, { cost: { status: "known", microusd: 1 } }),
    ]) {
      expect(() =>
        createExecutionLeaseRecord({
          policy: leasePolicy,
          identity,
          initialState,
          checkpoints: [],
          decisions: [],
          finalState: initialState,
        }),
      ).toThrowError(/invalid-record/u);
    }
  });

  it("does not let a renewed lease exceed its exact provider-limited grant", () => {
    const leasePolicy = policy();
    const initialState = state(leasePolicy);
    // Provider turns, not callsPerLease or the hard ceiling, must be the binding
    // constraint: a grant is capped at remainingProviderTurns - 1.
    const providerLimitedGrant = 3;
    expect(providerLimitedGrant).toBeLessThan(Math.min(CALLS, CEILING - CALLS));
    const checkpoint = exhaustedCheckpoint(leasePolicy, {
      providerTurns: TURNS - (providerLimitedGrant + 1),
    });
    const decision = decideExecutionLeaseRenewal({ policy: leasePolicy, identity, checkpoint });
    expect(decision).toMatchObject({
      decision: "granted",
      grantedToolCalls: providerLimitedGrant,
    });

    const withinGrant = state(
      leasePolicy,
      {
        leaseNumber: 2,
        leaseExecutedToolCalls: providerLimitedGrant,
        providerTurns: checkpoint.state.providerTurns + providerLimitedGrant,
        toolCalls: counters({
          executed: checkpoint.state.toolCalls.executed + providerLimitedGrant,
        }),
        cumulativeInputTokens: checkpoint.state.cumulativeInputTokens,
        cumulativeOutputTokens: checkpoint.state.cumulativeOutputTokens,
        elapsedMs: checkpoint.state.elapsedMs,
        cost: checkpoint.state.cost,
        lastCheckpointSha256: checkpoint.checkpointSha256,
      },
      checkpoint.state,
    );
    expect(
      createExecutionLeaseRecord({
        policy: leasePolicy,
        identity,
        initialState,
        checkpoints: [checkpoint],
        decisions: [decision],
        finalState: withinGrant,
      }).finalState.leaseExecutedToolCalls,
    ).toBe(providerLimitedGrant);

    const overGrant = state(
      leasePolicy,
      {
        leaseNumber: 2,
        leaseExecutedToolCalls: providerLimitedGrant + 1,
        providerTurns: checkpoint.state.providerTurns + providerLimitedGrant + 1,
        toolCalls: counters({
          executed: checkpoint.state.toolCalls.executed + providerLimitedGrant + 1,
        }),
        cumulativeInputTokens: checkpoint.state.cumulativeInputTokens,
        cumulativeOutputTokens: checkpoint.state.cumulativeOutputTokens,
        elapsedMs: checkpoint.state.elapsedMs,
        cost: checkpoint.state.cost,
        lastCheckpointSha256: checkpoint.checkpointSha256,
      },
      checkpoint.state,
    );

    expect(() =>
      createExecutionLeaseRecord({
        policy: leasePolicy,
        identity,
        initialState,
        checkpoints: [checkpoint],
        decisions: [decision],
        finalState: overGrant,
      }),
    ).toThrowError(/invalid-record/u);
  });

  it("makes a denied renewal the matching terminal boundary", () => {
    const leasePolicy = policy();
    const initialState = state(leasePolicy, {
      cost: { status: "unavailable", reason: "pricing-stale" },
    });
    const checkpoint = createExecutionCheckpoint({
      policy: leasePolicy,
      identity,
      state: initialState,
      reason: "budget-boundary",
    });
    const denial = decideExecutionLeaseRenewal({ policy: leasePolicy, identity, checkpoint });
    const finalState = state(
      leasePolicy,
      {
        leaseNumber: checkpoint.state.leaseNumber,
        leaseExecutedToolCalls: checkpoint.state.leaseExecutedToolCalls,
        providerTurns: checkpoint.state.providerTurns,
        compactions: checkpoint.state.compactions,
        toolCalls: checkpoint.state.toolCalls,
        cumulativeInputTokens: checkpoint.state.cumulativeInputTokens,
        cumulativeOutputTokens: checkpoint.state.cumulativeOutputTokens,
        elapsedMs: checkpoint.state.elapsedMs,
        cost: checkpoint.state.cost,
        lastCheckpointSha256: checkpoint.checkpointSha256,
      },
      checkpoint.state,
    );

    expect(
      createExecutionLeaseRecord({
        policy: leasePolicy,
        identity,
        initialState,
        checkpoints: [checkpoint],
        decisions: [denial],
        finalState,
        terminalReason: "cost-unavailable",
      }).terminalReason,
    ).toBe("cost-unavailable");
    expect(() =>
      createExecutionLeaseRecord({
        policy: leasePolicy,
        identity,
        initialState,
        checkpoints: [checkpoint],
        decisions: [denial],
        finalState,
        terminalReason: "needs-human-decision",
      }),
    ).toThrowError(/invalid-record/u);
  });

  it("distinguishes an interrupted post-grant tail from workflow completion", () => {
    const leasePolicy = policy();
    const initialState = state(leasePolicy);
    const checkpoint = exhaustedCheckpoint(leasePolicy);
    const grant = decideExecutionLeaseRenewal({ policy: leasePolicy, identity, checkpoint });
    const interruptedState = state(
      leasePolicy,
      {
        leaseNumber: checkpoint.state.leaseNumber,
        leaseExecutedToolCalls: checkpoint.state.leaseExecutedToolCalls,
        providerTurns: checkpoint.state.providerTurns,
        compactions: checkpoint.state.compactions,
        toolCalls: checkpoint.state.toolCalls,
        cumulativeInputTokens: checkpoint.state.cumulativeInputTokens,
        cumulativeOutputTokens: checkpoint.state.cumulativeOutputTokens,
        elapsedMs: checkpoint.state.elapsedMs,
        cost: checkpoint.state.cost,
        lastCheckpointSha256: checkpoint.checkpointSha256,
      },
      checkpoint.state,
    );
    expect(
      createExecutionLeaseRecord({
        policy: leasePolicy,
        identity,
        initialState,
        checkpoints: [checkpoint],
        decisions: [grant],
        finalState: interruptedState,
      }).terminalReason,
    ).toBeUndefined();
    expect(() =>
      createExecutionLeaseRecord({
        policy: leasePolicy,
        identity,
        initialState,
        checkpoints: [checkpoint],
        decisions: [grant],
        finalState: interruptedState,
        terminalReason: "completed",
      }),
    ).toThrowError(/invalid-record/u);

    const completion = createExecutionCheckpoint({
      policy: leasePolicy,
      identity,
      state: initialState,
      reason: "workflow-completed",
    });
    const completedState = state(
      leasePolicy,
      {
        lastCheckpointSha256: completion.checkpointSha256,
      },
      completion.state,
    );
    expect(
      createExecutionLeaseRecord({
        policy: leasePolicy,
        identity,
        initialState,
        checkpoints: [completion],
        decisions: [],
        finalState: completedState,
        terminalReason: "completed",
      }).terminalReason,
    ).toBe("completed");
  });

  it.each([
    "hard-tool-call-ceiling",
    "cumulative-input-limit",
    "cumulative-output-limit",
    "cumulative-time-limit",
    "cumulative-cost-limit",
    "provider-turn-limit",
    "lease-limit",
  ] as const)("rejects impossible zero-state terminal reason %s", (terminalReason) => {
    const leasePolicy = policy();
    const initialState = state(leasePolicy);
    expect(() =>
      createExecutionLeaseRecord({
        policy: leasePolicy,
        identity,
        initialState,
        checkpoints: [],
        decisions: [],
        finalState: initialState,
        terminalReason,
      }),
    ).toThrowError(/invalid-record/u);
  });

  it("accepts a resource terminal reason only when final state deterministically proves it", () => {
    const leasePolicy = policy();
    const initialState = state(leasePolicy);
    const exhaustedInput = state(
      leasePolicy,
      {
        providerTurns: 1,
        cumulativeInputTokens: leasePolicy.cumulative.maxInputTokens,
        elapsedMs: 1,
      },
      initialState,
    );
    expect(
      createExecutionLeaseRecord({
        policy: leasePolicy,
        identity,
        initialState,
        checkpoints: [],
        decisions: [],
        finalState: exhaustedInput,
        terminalReason: "cumulative-input-limit",
      }).terminalReason,
    ).toBe("cumulative-input-limit");
    expect(() =>
      createExecutionLeaseRecord({
        policy: leasePolicy,
        identity,
        initialState,
        checkpoints: [],
        decisions: [],
        finalState: exhaustedInput,
        terminalReason: "cumulative-output-limit",
      }),
    ).toThrowError(/invalid-record/u);
  });

  it("admits a host-requested output-authority stop that ended short of the output limit", () => {
    // The host stops when the remaining output authority cannot carry one more
    // useful turn, before the spend reaches the limit: `cumulative-output-limit`
    // is state-bound and inadmissible there, while `output-authority-exhausted` is
    // the host's own reason and needs no state proof, like `provider-terminal`.
    const leasePolicy = policy();
    const initialState = state(leasePolicy);
    const short = state(
      leasePolicy,
      {
        providerTurns: 1,
        cumulativeOutputTokens: leasePolicy.cumulative.maxOutputTokens - 500,
        elapsedMs: 1,
      },
      initialState,
    );
    const record = (terminalReason: "output-authority-exhausted" | "cumulative-output-limit") =>
      createExecutionLeaseRecord({
        policy: leasePolicy,
        identity,
        initialState,
        checkpoints: [],
        decisions: [],
        finalState: short,
        terminalReason,
      });
    expect(record("output-authority-exhausted").terminalReason).toBe("output-authority-exhausted");
    expect(() => record("cumulative-output-limit")).toThrowError(/invalid-record/u);
    // Zero-state control: the host reason is admissible before any output is spent.
    expect(
      createExecutionLeaseRecord({
        policy: leasePolicy,
        identity,
        initialState,
        checkpoints: [],
        decisions: [],
        finalState: initialState,
        terminalReason: "output-authority-exhausted",
      }).terminalReason,
    ).toBe("output-authority-exhausted");
  });

  it("rejects malformed, reordered, sparse, accessor-backed, and digest-tampered evidence", () => {
    const leasePolicy = policy();
    const initialState = state(leasePolicy);
    const record = createExecutionLeaseRecord({
      policy: leasePolicy,
      identity,
      initialState,
      checkpoints: [],
      decisions: [],
      finalState: initialState,
    });
    const tampered = JSON.parse(serializeExecutionLeaseRecord(record)) as Record<string, unknown>;
    tampered.terminalReason = "needs-input";
    expect(() => parseExecutionLeaseRecord(tampered)).toThrowError(/invalid-record/u);
    expect(() => parseExecutionLeaseRecord('{"schemaVersion":1,"schemaVersion":1}')).toThrowError();

    const sparse = { ...record, checkpoints: new Array(1) };
    expect(() => parseExecutionLeaseRecord(sparse)).toThrowError(/invalid-record/u);

    const accessor = { ...record } as Record<string, unknown>;
    Object.defineProperty(accessor, "kind", { enumerable: true, get: () => record.kind });
    expect(() => parseExecutionLeaseRecord(accessor)).toThrowError(/invalid-record/u);

    const hidden = { ...record } as Record<string, unknown>;
    Object.defineProperty(hidden, "raw", { enumerable: false, value: "ignored" });
    expect(() => parseExecutionLeaseRecord(hidden)).toThrowError(/invalid-record/u);

    const symbolic = { ...record } as Record<PropertyKey, unknown>;
    symbolic[Symbol("raw")] = "ignored";
    expect(() => parseExecutionLeaseRecord(symbolic)).toThrowError(/invalid-record/u);
  });

  it("rejects every reviewed present-undefined field before projection or hashing", () => {
    const leasePolicy = policy();
    const policyWithUndefinedCost = {
      ...leasePolicy,
      cumulative: {
        ...leasePolicy.cumulative,
        maxKnownCostMicrousd: undefined,
      },
    };
    expect(policyWithUndefinedCost.policySha256).toBe(leasePolicy.policySha256);
    expect(() => decodeExecutionLeasePolicy(policyWithUndefinedCost)).toThrowError(
      /invalid-policy/u,
    );

    const initialState = state(leasePolicy);
    const record = createExecutionLeaseRecord({
      policy: leasePolicy,
      identity,
      initialState,
      checkpoints: [],
      decisions: [],
      finalState: initialState,
    });
    expect(() => parseExecutionLeaseRecord({ ...record, terminalReason: undefined })).toThrowError(
      /invalid-record/u,
    );
    expect(() =>
      createExecutionCheckpoint({
        policy: leasePolicy,
        identity,
        state: initialState,
        reason: "host-requested",
        previous: undefined,
      }),
    ).toThrowError(/invalid-checkpoint/u);
    expect(() =>
      decideExecutionLeaseRenewal({
        policy: leasePolicy,
        identity,
        checkpoint: exhaustedCheckpoint(leasePolicy),
        stopReasons: undefined,
      }),
    ).toThrowError(/invalid-decision/u);

    const legacyBase = {
      attempt: 1,
      outcome: "timeout",
      retryable: false,
      retryScheduled: false,
      durationMs: 1,
    };
    for (const malformed of [
      {
        ...legacyBase,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
          turns: 0,
          cost: undefined,
        },
      },
      {
        ...legacyBase,
        tools: {
          totalCalls: 0,
          failedCalls: 0,
          byTool: [],
          failureCategories: undefined,
        },
      },
      {
        ...legacyBase,
        identity: {
          repositoryRevision: "1".repeat(40),
          contextPacketDigest: undefined,
        },
      },
      {
        ...legacyBase,
        identity: {
          repositoryRevision: "1".repeat(40),
          consultedNodeIds: undefined,
        },
      },
      {
        ...legacyBase,
        model: {
          provider: "fixture",
          model: "model",
          profile: { approvedSourceSha256: undefined },
        },
      },
    ]) {
      expect(() =>
        migrateLegacyInferenceAttemptEvidence(malformed as unknown as InferenceAttemptEvidence),
      ).toThrowError(/invalid-record/u);
    }
  });

  it("rejects recursive accessors without executing them", () => {
    let executions = 0;
    const getterObject = (key: string, value: unknown): Record<string, unknown> => {
      const target: Record<string, unknown> = {};
      Object.defineProperty(target, key, {
        enumerable: true,
        get: () => {
          executions += 1;
          return value;
        },
      });
      return target;
    };
    const legacyBase = {
      attempt: 1,
      outcome: "timeout",
      retryable: false,
      retryScheduled: false,
      durationMs: 1,
    };
    for (const malformed of [
      { ...legacyBase, usage: getterObject("input", 0) },
      { ...legacyBase, tools: getterObject("totalCalls", 0) },
      {
        ...legacyBase,
        model: {
          provider: "fixture",
          model: "model",
          profile: getterObject("schemaVersion", 2),
        },
      },
      { ...legacyBase, identity: getterObject("repositoryRevision", "1".repeat(40)) },
    ]) {
      expect(() =>
        migrateLegacyInferenceAttemptEvidence(malformed as unknown as InferenceAttemptEvidence),
      ).toThrowError(/invalid-record/u);
      expect(executions).toBe(0);
    }

    const leasePolicy = policy();
    const initialState = state(leasePolicy);
    const record = createExecutionLeaseRecord({
      policy: leasePolicy,
      identity,
      initialState,
      checkpoints: [],
      decisions: [],
      finalState: initialState,
    });
    const recordAccessor = { ...record } as Record<string, unknown>;
    Object.defineProperty(recordAccessor, "terminalReason", {
      enumerable: true,
      get: () => {
        executions += 1;
        return "needs-input";
      },
    });
    expect(() => parseExecutionLeaseRecord(recordAccessor)).toThrowError(/invalid-record/u);

    const policyInput = {
      maxCompactions: 2,
      cumulative: getterObject("maxInputTokens", 100_000),
    };
    expect(() =>
      createExecutionLeasePolicy(
        policyInput as unknown as Parameters<typeof createExecutionLeasePolicy>[0],
      ),
    ).toThrowError(/invalid-policy/u);

    const checkpointInput = {
      policy: leasePolicy,
      identity,
      state: initialState,
    } as Record<string, unknown>;
    Object.defineProperty(checkpointInput, "reason", {
      enumerable: true,
      get: () => {
        executions += 1;
        return "host-requested";
      },
    });
    expect(() =>
      createExecutionCheckpoint(
        checkpointInput as unknown as Parameters<typeof createExecutionCheckpoint>[0],
      ),
    ).toThrowError(/invalid-checkpoint/u);

    const checkpoint = exhaustedCheckpoint(leasePolicy);
    const decisionInput = { policy: leasePolicy, identity, checkpoint } as Record<string, unknown>;
    Object.defineProperty(decisionInput, "stopReasons", {
      enumerable: true,
      get: () => {
        executions += 1;
        return [];
      },
    });
    expect(() =>
      decideExecutionLeaseRenewal(
        decisionInput as unknown as Parameters<typeof decideExecutionLeaseRenewal>[0],
      ),
    ).toThrowError(/invalid-decision/u);
    expect(executions).toBe(0);
  });

  it("rejects custom prototypes recursively in general and legacy evidence", () => {
    const nonplain = <T extends object>(value: T): T =>
      Object.assign(Object.create({ inherited: true }) as T, value);
    const leasePolicy = policy();
    expect(() =>
      decodeExecutionLeasePolicy({
        ...leasePolicy,
        cumulative: nonplain({ ...leasePolicy.cumulative }),
      }),
    ).toThrowError(/invalid-policy/u);

    const initialState = state(leasePolicy);
    const checkpoint = exhaustedCheckpoint(leasePolicy);
    expect(() =>
      createExecutionCheckpoint({
        policy: leasePolicy,
        identity,
        state: nonplain({ ...initialState }),
        reason: "host-requested",
      }),
    ).toThrowError(/invalid-checkpoint/u);
    expect(() =>
      decideExecutionLeaseRenewal({
        policy: leasePolicy,
        identity,
        checkpoint: nonplain({ ...checkpoint }),
      }),
    ).toThrowError(/invalid-decision/u);
    const customStopReasons: string[] = [];
    Object.setPrototypeOf(customStopReasons, { inherited: true });
    expect(() =>
      decideExecutionLeaseRenewal({
        policy: leasePolicy,
        identity,
        checkpoint,
        stopReasons: customStopReasons as never[],
      }),
    ).toThrowError(/invalid-decision/u);
    const record = createExecutionLeaseRecord({
      policy: leasePolicy,
      identity,
      initialState,
      checkpoints: [],
      decisions: [],
      finalState: initialState,
    });
    expect(() =>
      parseExecutionLeaseRecord({
        ...record,
        finalState: {
          ...record.finalState,
          toolCalls: nonplain({ ...record.finalState.toolCalls }),
        },
      }),
    ).toThrowError(/invalid-record/u);

    const legacyBase = {
      attempt: 1,
      outcome: "timeout",
      retryable: false,
      retryScheduled: false,
      durationMs: 1,
    };
    for (const malformed of [
      {
        ...legacyBase,
        usage: nonplain({
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
          turns: 0,
        }),
      },
      {
        ...legacyBase,
        tools: {
          totalCalls: 0,
          failedCalls: 0,
          byTool: [nonplain({ name: "read", calls: 0, failures: 0 })],
        },
      },
      {
        ...legacyBase,
        model: {
          provider: "fixture",
          model: "model",
          profile: nonplain({}),
        },
      },
      { ...legacyBase, identity: nonplain({ repositoryRevision: "1".repeat(40) }) },
    ]) {
      expect(() =>
        migrateLegacyInferenceAttemptEvidence(malformed as unknown as InferenceAttemptEvidence),
      ).toThrowError(/invalid-record/u);
    }
  });

  /**
   * "Legacy" names this function's output format; its input is the current
   * `InferenceAttemptEvidence`, and its closed key list must admit every key a
   * writer emits. Hand-written fixtures that omit the pair cannot show that.
   */
  it("migrates an attempt carrying the #480 condition/decision pair", async () => {
    const base: InferenceAttemptEvidence = {
      attempt: 1,
      outcome: "throttled",
      retryable: true,
      retryScheduled: false,
      durationMs: 7,
      identity: { repositoryRevision: "3".repeat(40) },
    };
    const withPair: InferenceAttemptEvidence = {
      ...base,
      conditionRetryability: "eligible",
      retryDecision: "declined",
    };

    // An attempt carrying the pair migrates.
    expect(migrateLegacyInferenceAttemptEvidence(withPair)).toEqual(
      // The pair changes nothing the fixed-governor projection reports.
      migrateLegacyInferenceAttemptEvidence(base),
    );

    // The same, built by the writer: hand-written fixtures omit optional fields
    // the runtime emits, so they pass whatever the key list says.
    const written = await executeInferenceStep({
      mode: "read-only",
      policy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: ["throttled"] },
      evidenceIdentity: { repositoryRevision: "3".repeat(40) },
      now: () => 0,
      execute: async () => {
        throw new InferenceStepError("throttled by the front door", "throttled", true);
      },
    });
    const emitted = written.evidence.attempts[0]!;
    expect(emitted.conditionRetryability).toBe("eligible");
    expect(emitted.retryDecision).toBe("declined");
    expect(() => migrateLegacyInferenceAttemptEvidence(emitted)).not.toThrow();

    // Still closed: the pair is written together, and to its own vocabulary.
    for (const malformed of [
      { ...base, conditionRetryability: "eligible" },
      { ...base, retryDecision: "declined" },
      { ...withPair, conditionRetryability: "retried" },
      { ...withPair, retryDecision: "eligible" },
      { ...withPair, retryDecision: "unavailable" },
      // The admitted answer's size belongs only to an attempt that admitted one.
      { ...withPair, answerBytes: 42 },
      { ...withPair, retryRule: "declined-unexplained" },
      { ...withPair, condition: "slow" },
    ]) {
      expect(() =>
        migrateLegacyInferenceAttemptEvidence(malformed as unknown as InferenceAttemptEvidence),
      ).toThrowError(/invalid-record/u);
    }
    // Accepting control: a recorded rule and condition on the same failed attempt.
    expect(() =>
      migrateLegacyInferenceAttemptEvidence({
        ...withPair,
        retryRule: "declined-no-allowance",
      }),
    ).not.toThrow();
  });

  it("migrates existing fixed-governor evidence without inventing renewable authority", () => {
    const attempt: InferenceAttemptEvidence = {
      attempt: 1,
      outcome: "succeeded",
      retryable: false,
      retryScheduled: false,
      durationMs: 123,
      identity: {
        repositoryRevision: "1".repeat(40),
        contextPacketDigest: digest("2"),
        consultedNodeIds: ["docs-guide"],
      },
    };
    const migrated = migrateLegacyInferenceAttemptEvidence(attempt);
    const currentResponseEvidence: NonNullable<InferenceAttemptEvidence["providerResponses"]> = {
      schemaVersion: 1,
      state: "complete",
      observations: [
        { requestSequence: 1, disposition: "complete", observedBytes: 37, httpStatus: 200 },
      ],
      pendingRequestSequences: [],
    };
    const migratedWithResponseEvidence = migrateLegacyInferenceAttemptEvidence({
      ...attempt,
      providerResponses: currentResponseEvidence,
    });
    const currentEfficiencyEvidence: NonNullable<InferenceAttemptEvidence["efficiency"]> = {
      schemaVersion: 1,
      requests: [{ requestSequence: 1, turn: 1, bodyBytes: 238, bodySha256: "a".repeat(64) }],
      sourceReuse: {
        hits: 1,
        misses: 0,
        seededRanges: 2,
        refusals: 0,
        invalidations: { authorityChange: 0, sourceChange: 0, snapshotChange: 0 },
        rangeMismatches: 0,
      },
    };
    const migratedWithEfficiencyEvidence = migrateLegacyInferenceAttemptEvidence({
      ...attempt,
      efficiency: currentEfficiencyEvidence,
    });

    // The current-field admission is validation only: legacy projection bytes
    // remain exactly the V1 bytes and never acquire the newer field.
    expect(migratedWithResponseEvidence).toEqual(migrated);
    expect(migratedWithEfficiencyEvidence).toEqual(migrated);
    expect(serializeLegacyExecutionLeaseCompatibility(migratedWithResponseEvidence)).toBe(
      serializeLegacyExecutionLeaseCompatibility(migrated),
    );
    expect(serializeLegacyExecutionLeaseCompatibility(migratedWithEfficiencyEvidence)).toBe(
      serializeLegacyExecutionLeaseCompatibility(migrated),
    );
    expect(() =>
      migrateLegacyInferenceAttemptEvidence({
        ...attempt,
        providerResponses: { ...currentResponseEvidence, body: "must not persist" },
      } as unknown as InferenceAttemptEvidence),
    ).toThrowError(/invalid-record/u);
    for (const efficiency of [
      { ...currentEfficiencyEvidence, body: "must not persist" },
      { ...currentEfficiencyEvidence, requests: undefined },
    ]) {
      expect(() =>
        migrateLegacyInferenceAttemptEvidence({
          ...attempt,
          efficiency,
        } as unknown as InferenceAttemptEvidence),
      ).toThrowError(/invalid-record/u);
    }

    expect(migrated).toMatchObject({
      renewable: false,
      reason: "legacy-record-no-lease-authority",
      providerTurns: 0,
      toolCalls: 0,
      compactions: 0,
    });
    const bytes = serializeLegacyExecutionLeaseCompatibility(migrated);
    expect(
      serializeLegacyExecutionLeaseCompatibility(parseLegacyExecutionLeaseCompatibility(bytes)),
    ).toBe(bytes);
    expect(parseLegacyExecutionLeaseCompatibility(JSON.parse(bytes))).toEqual(migrated);
    expect(() => parseLegacyExecutionLeaseCompatibility(` ${bytes}`)).toThrowError(
      /noncanonical-json/u,
    );
    expect(() =>
      parseLegacyExecutionLeaseCompatibility(new TextEncoder().encode(`\n${bytes}`)),
    ).toThrowError(/noncanonical-json/u);
  });

  it("preserves a new host failure outcome in the required V1 compatibility field", () => {
    const attempt: InferenceAttemptEvidence = {
      attempt: 1,
      outcome: "host-runtime-failure",
      hostFailureOrigin: {
        schemaVersion: 1,
        origin: "execution-lease-coordinator",
        code: "invalid-execution-lease-coordinator",
      },
      retryable: false,
      retryScheduled: false,
      durationMs: 12,
    };
    const migrated = migrateLegacyInferenceAttemptEvidence(attempt);
    expect(migrated.outcome).toBe("host-runtime-failure");
    expect(
      parseLegacyExecutionLeaseCompatibility(serializeLegacyExecutionLeaseCompatibility(migrated)),
    ).toEqual(migrated);
    expect(() =>
      migrateLegacyInferenceAttemptEvidence({
        ...attempt,
        hostFailureOrigin: { ...attempt.hostFailureOrigin, code: "provider-terminal" },
      } as unknown as InferenceAttemptEvidence),
    ).toThrowError(/invalid-record/u);
    expect(() =>
      migrateLegacyInferenceAttemptEvidence({
        ...attempt,
        hostFailureOrigin: undefined,
      } as unknown as InferenceAttemptEvidence),
    ).toThrowError(/invalid-record/u);
  });

  it("migrates a governor stop that refused an ineffective compaction", () => {
    // The governor's reason for refusing a compaction that cannot free enough of
    // the input budget; a record carrying it must decode.
    const stopTurn = (reason: string) => {
      const turn = legacyTurn({
        decision: "stop",
        reason: reason as InferenceTurnEvidence["reason"],
        estimatedInputTokens: 8_100,
        availableOutputTokens: 0,
      });
      delete turn.outputTokens;
      return turn;
    };
    const attempt = {
      attempt: 1,
      outcome: "context-exhausted",
      retryable: false,
      retryScheduled: false,
      durationMs: 12,
      turns: [stopTurn("compaction-ineffective")],
    } as unknown as InferenceAttemptEvidence;

    expect(migrateLegacyInferenceAttemptEvidence(attempt)).toMatchObject({
      reason: "legacy-record-no-lease-authority",
      providerTurns: 0,
    });
    // Negative control: the acceptance above is the enum entry, not a permissive decoder.
    expect(() =>
      migrateLegacyInferenceAttemptEvidence({
        ...attempt,
        turns: [stopTurn("compaction-unhelpful")],
      } as unknown as InferenceAttemptEvidence),
    ).toThrowError(/invalid-record/u);
  });

  it("migrates a bounded in-turn retry count only on a finalized turn", () => {
    const finalized = (overrides: Partial<InferenceTurnEvidence> = {}) =>
      legacyTurn({
        providerPayloadSchemaVersion: 1,
        finalPayloadSha256: digest("a"),
        ...overrides,
      });
    const attempt = (turn: InferenceTurnEvidence) => ({
      attempt: 1,
      outcome: "succeeded",
      turns: [turn],
    });

    // Accepting control: otherwise an unrelated invalid-record throw passes below.
    expect(
      migrateLegacyInferenceAttemptEvidence(
        attempt(finalized()) as unknown as InferenceAttemptEvidence,
      ),
    ).toMatchObject({ providerTurns: 1 });
    expect(
      migrateLegacyInferenceAttemptEvidence(
        attempt(finalized({ providerRetries: 2 })) as unknown as InferenceAttemptEvidence,
      ),
    ).toMatchObject({ providerTurns: 1 });

    for (const invalid of [
      finalized({ providerRetries: 0 }),
      finalized({ providerRetries: -1 }),
      finalized({ providerRetries: 1.5 }),
      // A retry replays a payload that was finalized and sent.
      legacyTurn({ providerRetries: 1 }),
    ]) {
      expect(() =>
        migrateLegacyInferenceAttemptEvidence(
          attempt(invalid) as unknown as InferenceAttemptEvidence,
        ),
      ).toThrowError(/invalid-record/u);
    }
  });

  it("migrates an empty-turn count only within providerRetries + 1 on a finalized turn", () => {
    // Pins both directions of the `<= providerRetries + 1` guard, mirroring the
    // providerRetries controls above.
    const finalized = (overrides: Partial<InferenceTurnEvidence> = {}) =>
      legacyTurn({
        providerPayloadSchemaVersion: 1,
        finalPayloadSha256: digest("a"),
        ...overrides,
      });
    const attempt = (turn: InferenceTurnEvidence) => ({
      attempt: 1,
      outcome: "succeeded",
      turns: [turn],
    });

    // Accepting controls: a single terminal blank, and a streak whose every
    // blank but the last was replaced by a replay.
    expect(
      migrateLegacyInferenceAttemptEvidence(
        attempt(finalized({ providerBlankTurns: 1 })) as unknown as InferenceAttemptEvidence,
      ),
    ).toMatchObject({ providerTurns: 1 });
    expect(
      migrateLegacyInferenceAttemptEvidence(
        attempt(
          finalized({ providerRetries: 2, providerBlankTurns: 3 }),
        ) as unknown as InferenceAttemptEvidence,
      ),
    ).toMatchObject({ providerTurns: 1 });
    // A blank turn cut at the output limit and its one nudged replay cut the same
    // way: two blanks, one retry, at the bound exactly.
    expect(
      migrateLegacyInferenceAttemptEvidence(
        attempt(
          finalized({ providerRetries: 1, providerBlankTurns: 2 }),
        ) as unknown as InferenceAttemptEvidence,
      ),
    ).toMatchObject({ providerTurns: 1 });

    for (const invalid of [
      // Every empty turn except the last was replaced by a replay, so the count
      // cannot outrun the retries.
      finalized({ providerRetries: 1, providerBlankTurns: 3 }),
      finalized({ providerBlankTurns: 2 }),
      // A recorded blank is a count of empty turns.
      finalized({ providerBlankTurns: 0 }),
      finalized({ providerBlankTurns: -1 }),
      finalized({ providerBlankTurns: 1.5 }),
      // An empty turn answers a payload that was finalized and sent.
      legacyTurn({ providerBlankTurns: 1 }),
    ]) {
      expect(() =>
        migrateLegacyInferenceAttemptEvidence(
          attempt(invalid) as unknown as InferenceAttemptEvidence,
        ),
      ).toThrowError(/invalid-record/u);
    }
  });

  it("migrates a turn the output authority clamped or stopped only when its arithmetic holds", () => {
    // `outputAuthority` is recorded only where the lease's remaining cumulative
    // output bound the turn; the decoder redoes the sums so a record cannot claim
    // a clamp it did not apply or an exhaustion with output to spare.
    const attempt = (turn: InferenceTurnEvidence, outcome = "succeeded") =>
      ({ attempt: 1, outcome, turns: [turn] }) as unknown as InferenceAttemptEvidence;
    const authority = (cumulativeOutputTokens: number) => ({
      maxOutputTokens: 10_000,
      cumulativeOutputTokens,
      floorOutputTokens: 16 + 1_024,
    });
    const exhaustedTurn = (overrides: Partial<InferenceTurnEvidence> = {}) => {
      const turn = legacyTurn({
        decision: "stop",
        reason: "output-authority-exhausted",
        ...overrides,
      });
      delete turn.outputTokens;
      return turn;
    };

    // Accepting controls: a clamp that requested exactly the 1,500 remaining
    // (below the 4,096 per-turn limit), and an exhaustion with 500 remaining.
    expect(
      migrateLegacyInferenceAttemptEvidence(
        attempt(
          legacyTurn({
            requestedOutputTokens: 1_500,
            outputTokens: 1_500,
            outputAuthority: authority(8_500),
          }),
        ),
      ),
    ).toMatchObject({ providerTurns: 1 });
    expect(
      migrateLegacyInferenceAttemptEvidence(
        attempt(exhaustedTurn({ outputAuthority: authority(9_500) }), "context-exhausted"),
      ),
    ).toMatchObject({ providerTurns: 0 });
    // Exactly the 1,040 floor remaining is still a clamp the governor sends.
    expect(
      migrateLegacyInferenceAttemptEvidence(
        attempt(
          legacyTurn({
            requestedOutputTokens: 1_040,
            outputTokens: 1_040,
            outputAuthority: authority(10_000 - 1_040),
          }),
        ),
      ),
    ).toMatchObject({ providerTurns: 1 });

    for (const invalid of [
      // A clamp requests exactly the remainder, no more and no less.
      legacyTurn({
        requestedOutputTokens: 1_499,
        outputTokens: 1_499,
        outputAuthority: authority(8_500),
      }),
      legacyTurn({ outputAuthority: authority(8_500) }),
      // A remainder that still covers the per-turn limit never binds.
      legacyTurn({
        requestedOutputTokens: 5_000,
        outputTokens: 4_096,
        outputAuthority: authority(5_000),
      }),
      // The floor sits above the provider minimum.
      legacyTurn({
        requestedOutputTokens: 1_500,
        outputTokens: 1_500,
        outputAuthority: { ...authority(8_500), floorOutputTokens: 16 },
      }),
      // A remainder under the floor is an exhaustion, not a clamp; the boundary is exact.
      legacyTurn({
        requestedOutputTokens: 500,
        outputTokens: 500,
        outputAuthority: authority(9_500),
      }),
      legacyTurn({
        requestedOutputTokens: 1_039,
        outputTokens: 1_039,
        outputAuthority: authority(10_000 - 1_039),
      }),
      legacyTurn({
        requestedOutputTokens: 1_500,
        outputTokens: 1_500,
        outputAuthority: { ...authority(8_500), extra: 1 } as never,
      }),
      legacyTurn({
        requestedOutputTokens: 1_500,
        outputTokens: 1_500,
        outputAuthority: { ...authority(8_500), cumulativeOutputTokens: -1 },
      }),
    ]) {
      expect(() => migrateLegacyInferenceAttemptEvidence(attempt(invalid))).toThrowError(
        /invalid-record/u,
      );
    }
    // An exhaustion names its authority, and an authority with a floor's worth
    // of output to spare is not exhausted.
    for (const invalid of [exhaustedTurn(), exhaustedTurn({ outputAuthority: authority(8_500) })]) {
      expect(() =>
        migrateLegacyInferenceAttemptEvidence(attempt(invalid, "context-exhausted")),
      ).toThrowError(/invalid-record/u);
    }
    // The governor checks an exhausted authority before the context budget, so
    // such a turn cannot have stopped for a budget reason. The accepting control
    // is the same budget stop on a clamped turn.
    for (const reason of [
      "context-exhausted",
      "compaction-limit",
      "compaction-ineffective",
    ] as const) {
      expect(() =>
        migrateLegacyInferenceAttemptEvidence(
          attempt(
            exhaustedTurn({ reason, outputAuthority: authority(9_500) }),
            "context-exhausted",
          ),
        ),
      ).toThrowError(/invalid-record/u);
      expect(
        migrateLegacyInferenceAttemptEvidence(
          attempt(
            exhaustedTurn({ reason, outputAuthority: authority(8_500) }),
            "context-exhausted",
          ),
        ),
      ).toMatchObject({ providerTurns: 0 });
    }
  });

  it("rejects malformed runtime legacy evidence before migration", () => {
    const attempt = {
      attempt: 1,
      outcome: "succeeded",
      turns: [legacyTurn()],
    };
    expect(
      migrateLegacyInferenceAttemptEvidence(attempt as unknown as InferenceAttemptEvidence),
    ).toMatchObject({ providerTurns: 1, toolCalls: 0, compactions: 0 });
    for (const malformed of [
      { ...attempt, outcome: "made-up" },
      { ...attempt, retryable: "false" },
      { ...attempt, retryable: undefined },
      { ...attempt, retryScheduled: 0 },
      { ...attempt, durationMs: -1 },
      { ...attempt, durationMs: undefined },
      { ...attempt, durationMs: Number.MAX_SAFE_INTEGER + 1 },
      { ...attempt, backoffMs: -1 },
      { ...attempt, retryable: true, retryScheduled: true },
      { ...attempt, retryable: false, retryScheduled: false, backoffMs: 1 },
      { ...attempt, rawProviderResponse: { raw: "must-not-be-ignored" } },
      { ...attempt, model: { provider: "fixture", model: "model", raw: "ignored" } },
      { ...attempt, model: { provider: "fixture", model: "model", profile: undefined } },
      {
        ...attempt,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          total: 99,
          turns: 1,
        },
      },
      { ...attempt, tools: { totalCalls: 0, failedCalls: 1, byTool: [] } },
      { ...attempt, turns: [{ ...attempt.turns[0], toolCalls: -1 }] },
      { ...attempt, turns: [{ ...attempt.turns[0], compactions: Number.MAX_SAFE_INTEGER + 1 }] },
      { ...attempt, identity: { repositoryRevision: "mutable-main" } },
      { ...attempt, identity: undefined },
      { ...attempt, turns: undefined },
      { ...attempt, turns: new Array(1) },
      {
        ...attempt,
        turns: [
          legacyTurn({ toolCalls: 1, toolResults: 1 }),
          legacyTurn({ turn: 2, toolCalls: 0, requestDigest: digest("9") }),
        ],
      },
    ]) {
      expect(() =>
        migrateLegacyInferenceAttemptEvidence(malformed as unknown as InferenceAttemptEvidence),
      ).toThrowError(/invalid-record/u);
    }

    const accessor = { ...attempt } as Record<string, unknown>;
    Object.defineProperty(accessor, "outcome", {
      enumerable: true,
      get: () => "succeeded",
    });
    expect(() =>
      migrateLegacyInferenceAttemptEvidence(accessor as unknown as InferenceAttemptEvidence),
    ).toThrowError(/invalid-record/u);
  });
});
