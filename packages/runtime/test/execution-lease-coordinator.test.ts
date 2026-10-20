// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  ExecutionLeaseCoordinatorError,
  createExecutionChargeableAttemptPolicy,
  createExecutionLeaseCoordinatorPolicy,
  createExecutionProgressObservation,
  decodeExecutionLeasePolicyV1,
  prepareExecutionLeaseCoordinator,
  reduceExecutionLeaseCoordinator,
  serializeExecutionCoordinatorDecision,
  type ExecutionCoordinatorDecisionV1,
  type BoundExecutionPricingV1,
  type ExecutionLeaseCoordinatorV1,
  type ExecutionResourceEnvelopeV1,
  type ExecutionToolBatchCallV1,
} from "../src/execution/index.js";
import {
  EXECUTION_LEASE_DEFAULTS,
  executionLeaseChargeableAttemptCeiling,
  resolveLeaseShapeForTurns,
  type ExecutionLeasePolicyV1,
} from "../src/execution/lease-contracts.js";

/**
 * The fixture provider-turn budget, not the shipped one
 * (`EXECUTION_LEASE_DEFAULTS.maxProviderTurns`, exercised by
 * `composition-lease-shape.test.ts`). A smaller budget makes a single lease
 * optimal and removes the lease boundary these fixtures exercise.
 */
const DEFAULT_PROVIDER_TURNS = 256;

/**
 * A distinct 64-hex tool-call digest per (group, index).
 *
 * Do not left-pad the index with a hex digit: with "d" padding, 0x0d and 0xdd
 * collide. Zero-padding to a fixed width is injective, and the leading group
 * character keeps unrelated batches apart.
 */
function fixtureCallSha256(group: string, index: number): string {
  return `${group}${index.toString(16).padStart(63, "0")}`;
}

/**
 * The base shape the coordinator derives, computed the way production computes
 * it. Do not restate it as literals: it is a function of the shipped defaults
 * and the turn budget, and a stale second copy is the defect this file catches.
 */
function resolvedBase(providerTurns: number): {
  callsPerLease: number;
  maxLeases: number;
  hardToolCallCeiling: number;
  maxProviderTurns: number;
} {
  const maxProviderTurns = Math.min(EXECUTION_LEASE_DEFAULTS.maxProviderTurns, providerTurns);
  return {
    ...resolveLeaseShapeForTurns(EXECUTION_LEASE_DEFAULTS, maxProviderTurns),
    maxProviderTurns,
  };
}

const BASE = resolvedBase(DEFAULT_PROVIDER_TURNS);

/**
 * The chargeable-attempt budget, derived as `pi-lease.ts` defaults it: the lease
 * policy's `hardToolCallCeiling`. A smaller pinned budget would bind first and
 * the boundary tests would stop exercising the ceiling they are named for.
 */
const MAX_CHARGEABLE_ATTEMPTS = BASE.hardToolCallCeiling;

/**
 * Where a one-executed-call-per-batch run stops, and how many leases it spans.
 *
 * A run stops at the first of: the per-lease allowance once no renewal is
 * admissible; the hard tool-call ceiling; the chargeable-attempt budget, which
 * funds both the calls and the renewals.
 *
 * `renew` grants exactly
 * `min(callsPerLease, ceiling - executed, remainingProviderTurns - 1)` and
 * rejects any other size, so a host holding fewer chargeable attempts than that
 * has no admissible request left.
 */
function scalarExecutionBoundary(
  leasePolicy: ExecutionLeasePolicyV1,
  maxChargeableAttempts: number,
): { executed: number; leases: number } {
  let executed = 0;
  for (let leases = 1; ; leases += 1) {
    const allowance = Math.min(
      leasePolicy.callsPerLease,
      leasePolicy.hardToolCallCeiling - executed,
    );
    executed += Math.min(allowance, maxChargeableAttempts - executed);
    const tranche = Math.min(
      leasePolicy.callsPerLease,
      leasePolicy.hardToolCallCeiling - executed,
      // One provider turn per executed call; renewals consume none.
      leasePolicy.maxProviderTurns - executed - 1,
    );
    if (
      leases >= leasePolicy.maxLeases ||
      tranche <= 0 ||
      maxChargeableAttempts - executed < tranche
    ) {
      return { executed, leases };
    }
  }
}

const digest = (character: string): string => character.repeat(64);
const context = {
  status: "ready" as const,
  availableInputTokens: 100_000,
  requiredInputTokens: 1,
  authoritySha256: digest("c"),
};
const pricing = {
  status: "known" as const,
  inputMicrousdPerMillionTokens: 100,
  outputMicrousdPerMillionTokens: 200,
  authoritySha256: digest("d"),
};

type V1CoordinatorFixture = Omit<ExecutionLeaseCoordinatorV1, "policy"> & {
  policy: ExecutionLeasePolicyV1;
};

function policy(
  overrides: Parameters<typeof createExecutionLeaseCoordinatorPolicy>[0] = {
    maxCompactions: 4,
    providerLimits: { maxProviderTurns: DEFAULT_PROVIDER_TURNS, maxCompactions: 4 },
    cumulative: {
      maxInputTokens: 1_000_000,
      maxOutputTokens: 1_000_000,
      maxElapsedMs: 1_000_000,
    },
  },
) {
  return createExecutionLeaseCoordinatorPolicy(overrides);
}

/** The stop point of `executeScalar` under the default fixture policy. */
const SCALAR = scalarExecutionBoundary(policy(), MAX_CHARGEABLE_ATTEMPTS);

/**
 * The executed-call count at which each lease of a scalar run fills: a full
 * tranche, or the remainder of the ceiling for the lease the ceiling lands in.
 */
const LEASE_FILL_POINTS = [
  ...new Set(
    Array.from({ length: BASE.maxLeases }, (_, index) =>
      Math.min((index + 1) * BASE.callsPerLease, BASE.hardToolCallCeiling),
    ).filter((point) => point <= SCALAR.executed),
  ),
];

function prepared(
  leasePolicy = policy(),
  pricingValue: BoundExecutionPricingV1 = pricing,
  maxChargeableAttempts = executionLeaseChargeableAttemptCeiling(leasePolicy),
  chargeableCeiling = executionLeaseChargeableAttemptCeiling(leasePolicy),
): { coordinator: V1CoordinatorFixture; decision: ExecutionCoordinatorDecisionV1 } {
  const result = prepareExecutionLeaseCoordinator({
    policy: leasePolicy,
    chargeableAttemptPolicy: createExecutionChargeableAttemptPolicy(
      {
        maxChargeableAttempts,
      },
      chargeableCeiling,
    ),
    identity: {
      inferenceAttempt: 1,
      retriesConsumed: 0,
      authorizationSha256: digest("a"),
      repositoryRevision: "b".repeat(40),
      contextPacketSha256: digest("e"),
      evidenceSha256: digest("f"),
      toolPolicySha256: digest("1"),
      contextAuthoritySha256: context.authoritySha256,
    },
    pricing: pricingValue,
    context,
  });
  if (result.coordinator.policy.schemaVersion !== 1 || result.decision.schemaVersion !== 1) {
    throw new Error("finite coordinator fixtures require V1 policy and decision evidence");
  }
  const { coordinator, decision } = result;
  return {
    coordinator: { ...coordinator, policy: decodeExecutionLeasePolicyV1(coordinator.policy) },
    decision,
  };
}

function envelope(toolCalls: number, overrides: Partial<ExecutionResourceEnvelopeV1> = {}) {
  return {
    toolCalls,
    providerTurns: 1,
    compactions: 0,
    inputTokens: 1,
    outputTokens: 1,
    elapsedMs: 1,
    contextInputTokens: 1,
    ...overrides,
  };
}

function observation(
  coordinator: ExecutionLeaseCoordinatorV1,
  increments: {
    input?: number;
    output?: number;
    elapsed?: number;
    providerTurns?: number;
    compactions?: number;
    context?: typeof context;
  } = {},
) {
  return createExecutionProgressObservation({
    sequence: (coordinator.lastObservation?.sequence ?? 0) + 1,
    providerTurns: coordinator.state.providerTurns + (increments.providerTurns ?? 1),
    compactions: coordinator.state.compactions + (increments.compactions ?? 0),
    cumulativeInputTokens: coordinator.state.cumulativeInputTokens + (increments.input ?? 1),
    cumulativeOutputTokens: coordinator.state.cumulativeOutputTokens + (increments.output ?? 1),
    elapsedMs: coordinator.state.elapsedMs + (increments.elapsed ?? 1),
    context: increments.context ?? context,
  });
}

function reduce(
  coordinator: V1CoordinatorFixture,
  command: Parameters<typeof reduceExecutionLeaseCoordinator>[0]["command"],
): { coordinator: V1CoordinatorFixture; decision: ExecutionCoordinatorDecisionV1 } {
  const result = reduceExecutionLeaseCoordinator({
    coordinator,
    expectedCoordinatorSha256: coordinator.coordinatorSha256,
    command,
  });
  if (result.coordinator.policy.schemaVersion !== 1 || result.decision.schemaVersion !== 1) {
    throw new Error("finite coordinator fixtures require V1 policy and decision evidence");
  }
  const { coordinator: narrowedCoordinator, decision } = result;
  return {
    coordinator: {
      ...narrowedCoordinator,
      policy: decodeExecutionLeasePolicyV1(narrowedCoordinator.policy),
    },
    decision,
  };
}

function requestAndSettle(
  coordinator: V1CoordinatorFixture,
  calls: ExecutionToolBatchCallV1[],
  outcomes: Array<"succeeded" | "failed"> = [],
) {
  const requested = reduce(coordinator, {
    kind: "request-tool-batch",
    calls,
    envelope: envelope(calls.filter((call) => call.authorization === "execute").length),
  });
  if (requested.decision.authorizedToolCalls === 0) return requested;
  const authorized = calls
    .filter((call) => call.authorization === "execute")
    .slice(0, requested.decision.authorizedToolCalls);
  return reduce(requested.coordinator, {
    kind: "settle-tool-batch",
    results: authorized.map((call, index) => ({
      callSha256: call.callSha256,
      outcome: outcomes[index] ?? "succeeded",
    })),
    observation: observation(requested.coordinator),
  });
}

/**
 * The only tranche size `renew` admits. Clamped to one call so the envelope stays
 * executable when the grant would be zero; that renewal is denied anyway.
 */
function grantedTranche(coordinator: ExecutionLeaseCoordinatorV1): number {
  const { policy: leasePolicy, state } = coordinator;
  if (leasePolicy.schemaVersion !== 1) {
    throw new Error("finite renewal fixture requires a V1 lease policy");
  }
  return Math.max(
    1,
    Math.min(
      leasePolicy.callsPerLease,
      leasePolicy.hardToolCallCeiling - state.toolCalls.executed,
      leasePolicy.maxProviderTurns - state.providerTurns - 1,
    ),
  );
}

function renewIfRequired(coordinator: V1CoordinatorFixture) {
  return coordinator.phase === "checkpoint-required"
    ? reduce(coordinator, { kind: "renew", nextTranche: envelope(grantedTranche(coordinator)) })
    : undefined;
}

function executeScalar(total: number, leasePolicy = policy()) {
  let coordinator = prepared(leasePolicy).coordinator;
  let lastDecision: ExecutionCoordinatorDecisionV1 | undefined;
  for (let index = 0; index < total && coordinator.phase !== "terminal"; index += 1) {
    const renewal = renewIfRequired(coordinator);
    if (renewal) {
      coordinator = renewal.coordinator;
      lastDecision = renewal.decision;
      if (coordinator.phase === "terminal") break;
    }
    const settled = requestAndSettle(coordinator, [
      {
        callSha256: fixtureCallSha256("0", index),
        authorization: "execute",
      },
    ]);
    coordinator = settled.coordinator;
    lastDecision = settled.decision;
  }
  const finalRenewal = renewIfRequired(coordinator);
  if (finalRenewal) {
    coordinator = finalRenewal.coordinator;
    lastDecision = finalRenewal.decision;
  }
  return { coordinator, lastDecision };
}

describe("host-owned execution lease coordinator", () => {
  it("uses safe defaults and accepts only tightening workflow/operator/provider bounds", () => {
    // The default policy is the shape resolved from the shipped defaults; literal
    // numbers would let a second hardcoded base drift in unnoticed.
    expect(policy()).toMatchObject({ ...BASE, maxCompactions: 4 });

    // Tightening in every dimension. The override ceiling must satisfy
    // `ceiling <= callsPerLease * maxLeases`, so it is clamped against the
    // tightened calls-per-lease.
    const tightenedTurns = 50;
    const tightenedBase = resolvedBase(tightenedTurns);
    const tightenedCallsPerLease = tightenedBase.callsPerLease - 1;
    const tightenedCeiling = Math.min(
      tightenedBase.hardToolCallCeiling - 1,
      tightenedCallsPerLease * tightenedBase.maxLeases,
    );
    expect(
      policy({
        maxCompactions: 4,
        providerLimits: { maxProviderTurns: tightenedTurns, maxCompactions: 3 },
        cumulative: { maxInputTokens: 100, maxOutputTokens: 100, maxElapsedMs: 100 },
        workflowOverrides: {
          callsPerLease: tightenedCallsPerLease,
          hardToolCallCeiling: tightenedCeiling,
        },
        operatorOverrides: { maxLeases: tightenedBase.maxLeases, maxCompactions: 2 },
      }),
    ).toMatchObject({
      callsPerLease: tightenedCallsPerLease,
      maxLeases: tightenedBase.maxLeases,
      hardToolCallCeiling: tightenedCeiling,
      maxProviderTurns: tightenedTurns,
      maxCompactions: 2,
    });
    for (const invalid of [
      // Each override is one past the base in the direction that widens it.
      { workflowOverrides: { callsPerLease: BASE.callsPerLease + 1 } },
      { operatorOverrides: { hardToolCallCeiling: BASE.hardToolCallCeiling + 1 } },
      // A provider-turn budget no lease shape fits: the smallest shape, one call
      // in one lease, needs two turns.
      { providerLimits: { maxProviderTurns: 1, maxCompactions: 4 } },
      // Too few leases to cover the base ceiling: the largest lease count for
      // which `ceiling > callsPerLease * maxLeases` still holds.
      {
        workflowOverrides: {
          maxLeases: Math.ceil(BASE.hardToolCallCeiling / BASE.callsPerLease) - 1,
        },
      },
    ]) {
      expect(() =>
        policy({
          maxCompactions: 4,
          providerLimits: { maxProviderTurns: DEFAULT_PROVIDER_TURNS, maxCompactions: 4 },
          cumulative: { maxInputTokens: 100, maxOutputTokens: 100, maxElapsedMs: 100 },
          ...invalid,
        }),
      ).toThrow();
    }
  });

  /**
   * The composition-data raise, derived for the reason `resolvedBase` gives. A
   * composition may only raise `callsPerLease`, up to the ceiling this turn
   * budget resolved to, so both ends of the legal range move with `BASE`.
   */
  const RAISED_CALLS_PER_LEASE = Math.min(BASE.callsPerLease + 5, BASE.hardToolCallCeiling);

  it("lets composition raise callsPerLease under remaining hard-ceiling math", () => {
    const hostBounds = {
      maxCompactions: 4,
      providerLimits: { maxProviderTurns: DEFAULT_PROVIDER_TURNS, maxCompactions: 4 },
      cumulative: {
        maxInputTokens: 1_000_000,
        maxOutputTokens: 1_000_000,
        maxElapsedMs: 1_000_000,
      },
    };
    // A raise changes nothing else: the hard ceiling and lease count stay as resolved.
    expect(
      policy({ ...hostBounds, compositionOverrides: { callsPerLease: RAISED_CALLS_PER_LEASE } }),
    ).toMatchObject({
      callsPerLease: RAISED_CALLS_PER_LEASE,
      maxLeases: BASE.maxLeases,
      hardToolCallCeiling: BASE.hardToolCallCeiling,
    });
    // The resolved base is the floor and the resolved ceiling the top; both inclusive.
    expect(
      policy({ ...hostBounds, compositionOverrides: { callsPerLease: BASE.callsPerLease } }),
    ).toMatchObject({ callsPerLease: BASE.callsPerLease });
    expect(
      policy({ ...hostBounds, compositionOverrides: { callsPerLease: BASE.hardToolCallCeiling } }),
    ).toMatchObject({ callsPerLease: BASE.hardToolCallCeiling });
    // Above the ceiling, below the floor (a composition may not tighten), and any
    // field other than callsPerLease are all rejected rather than clamped.
    expect(() =>
      policy({
        ...hostBounds,
        compositionOverrides: { callsPerLease: BASE.hardToolCallCeiling + 1 },
      }),
    ).toThrow();
    expect(() =>
      policy({ ...hostBounds, compositionOverrides: { callsPerLease: BASE.callsPerLease - 1 } }),
    ).toThrow();
    expect(() =>
      policy({
        ...hostBounds,
        compositionOverrides: {
          callsPerLease: RAISED_CALLS_PER_LEASE,
          maxLeases: BASE.maxLeases,
        } as never,
      }),
    ).toThrow();
  });

  it("keeps the composition floor on the resolved base, not the compiled default", () => {
    // With no composition data, callsPerLease must come from the base resolved
    // for this turn budget: the compiled default exceeds a shrunk ceiling at small
    // budgets, and the decoder would reject the coordinator's own policy.
    for (const providerTurns of [5, 10, 20, 25, 26, 40, DEFAULT_PROVIDER_TURNS]) {
      const expected = resolvedBase(providerTurns);
      expect(expected.callsPerLease).toBeLessThanOrEqual(expected.hardToolCallCeiling);
      expect(
        policy({
          maxCompactions: 4,
          providerLimits: { maxProviderTurns: providerTurns, maxCompactions: 4 },
          cumulative: {
            maxInputTokens: 1_000_000,
            maxOutputTokens: 1_000_000,
            maxElapsedMs: 1_000_000,
          },
        }),
      ).toMatchObject(expected);
    }
  });

  it("renews a composition-raised tranche and still stops at the hard ceiling", () => {
    const leasePolicy = policy({
      maxCompactions: 4,
      providerLimits: { maxProviderTurns: DEFAULT_PROVIDER_TURNS, maxCompactions: 4 },
      cumulative: {
        maxInputTokens: 1_000_000,
        maxOutputTokens: 1_000_000,
        maxElapsedMs: 1_000_000,
      },
      compositionOverrides: { callsPerLease: RAISED_CALLS_PER_LEASE },
    });
    expect(leasePolicy.callsPerLease).toBe(RAISED_CALLS_PER_LEASE);
    expect(leasePolicy.hardToolCallCeiling).toBe(BASE.hardToolCallCeiling);

    let coordinator = prepared(leasePolicy).coordinator;
    const settle = (index: number) =>
      requestAndSettle(coordinator, [
        {
          callSha256: fixtureCallSha256("0", index),
          authorization: "execute",
        },
      ]).coordinator;

    // The first lease fills at the raised allowance, not the compiled base.
    for (let index = 0; index < RAISED_CALLS_PER_LEASE - 1; index += 1) coordinator = settle(index);
    expect(coordinator.phase).toBe("active");
    coordinator = settle(RAISED_CALLS_PER_LEASE - 1);
    expect(coordinator.phase).toBe("checkpoint-required");
    expect(coordinator.state.toolCalls.executed).toBe(RAISED_CALLS_PER_LEASE);

    // `renew` grants exactly one size and rejects a tranche of any other.
    expect(() =>
      reduce(coordinator, { kind: "renew", nextTranche: envelope(RAISED_CALLS_PER_LEASE - 1) }),
    ).toThrow(ExecutionLeaseCoordinatorError);
    const renewed = reduce(coordinator, {
      kind: "renew",
      nextTranche: envelope(grantedTranche(coordinator)),
    });
    expect(renewed.decision.decision).toBe("renewed");

    // The run stops at the ceiling the composition cannot touch, and the terminal
    // denial names it.
    const boundary = scalarExecutionBoundary(leasePolicy, MAX_CHARGEABLE_ATTEMPTS);
    expect(boundary.executed).toBe(BASE.hardToolCallCeiling);
    const run = executeScalar(boundary.executed + 1, leasePolicy);
    expect(run.coordinator.state.toolCalls.executed).toBe(boundary.executed);
    expect(run.lastDecision).toMatchObject({
      decision: "denied",
      reason: "hard-tool-call-ceiling",
    });
  });

  it("fails before granting when pricing or context authority cannot support execution", () => {
    const costPolicy = policy({
      maxCompactions: 4,
      providerLimits: { maxProviderTurns: 64, maxCompactions: 4 },
      cumulative: {
        maxInputTokens: 100,
        maxOutputTokens: 100,
        maxElapsedMs: 100,
        maxKnownCostMicrousd: 100,
      },
    });
    expect(
      prepared(costPolicy, {
        status: "unavailable",
        reason: "pricing-stale",
        authoritySha256: digest("9"),
      }).decision,
    ).toMatchObject({ decision: "terminal", reason: "cost-unavailable" });

    let getterExecutions = 0;
    const malicious = { ...costPolicy } as Record<string, unknown>;
    Object.defineProperty(malicious, "maxLeases", {
      enumerable: true,
      get: () => {
        getterExecutions += 1;
        return 4;
      },
    });
    const trustedCeiling = executionLeaseChargeableAttemptCeiling(costPolicy);
    expect(() => prepared(malicious as never, pricing, trustedCeiling, trustedCeiling)).toThrow(
      ExecutionLeaseCoordinatorError,
    );
    expect(getterExecutions).toBe(0);
  });

  // Every lease boundary straddled.
  it.each([...new Set(LEASE_FILL_POINTS.flatMap((point) => [point - 1, point, point + 1]))])(
    "enforces the scalar boundary at %i executed calls",
    (requestedCalls) => {
      const { coordinator } = executeScalar(requestedCalls);
      expect(coordinator.state.toolCalls.executed).toBe(Math.min(requestedCalls, SCALAR.executed));
      // Neither governing bound may be crossed, whichever one binds first.
      expect(coordinator.state.toolCalls.executed).toBeLessThanOrEqual(BASE.hardToolCallCeiling);
      expect(coordinator.chargeableAttemptState.chargeableAttempts).toBeLessThanOrEqual(
        MAX_CHARGEABLE_ATTEMPTS,
      );
      if (requestedCalls >= SCALAR.executed) {
        expect(coordinator).toMatchObject({
          phase: "terminal",
          terminalReason: "hard-tool-call-ceiling",
        });
      } else {
        expect(coordinator.phase).toBe("active");
        expect(coordinator.state.leaseNumber).toBe(
          Math.floor(requestedCalls / BASE.callsPerLease) + 1,
        );
      }
    },
  );

  // One call short of each lease boundary.
  it.each(LEASE_FILL_POINTS.map((point) => point - 1))(
    "authorizes an ordered prefix and governance-blocks parallel overflow after %i calls",
    (before) => {
      let coordinator = executeScalar(before).coordinator;
      const lease = coordinator.state.leaseNumber;
      const batch = requestAndSettle(coordinator, [
        { callSha256: digest("7"), authorization: "execute" },
        { callSha256: digest("8"), authorization: "execute" },
      ]);
      coordinator = batch.coordinator;
      expect(batch.decision).toMatchObject({
        decision: "checkpoint-required",
        authorizedToolCalls: 1,
        governanceBlockedToolCalls: 1,
      });
      expect(coordinator.state).toMatchObject({
        leaseNumber: lease,
        // The allowance of the lease just filled: a full tranche, or the remainder
        // of the ceiling when the ceiling lands mid-lease.
        leaseExecutedToolCalls: Math.min(
          BASE.callsPerLease,
          BASE.hardToolCallCeiling - (lease - 1) * BASE.callsPerLease,
        ),
        toolCalls: {
          executed: before + 1,
          governanceBlocked: 1,
        },
      });
      expect(coordinator.state.toolCalls.requested).toBe(
        coordinator.state.toolCalls.executed +
          coordinator.state.toolCalls.denied +
          coordinator.state.toolCalls.governanceBlocked,
      );
    },
  );

  it("counts failed and re-dispatched calls as executed, but not denied or overflow calls", () => {
    let coordinator = prepared().coordinator;
    const first = requestAndSettle(
      coordinator,
      [
        { callSha256: digest("2"), authorization: "execute" },
        { callSha256: digest("3"), authorization: "denied" },
        { callSha256: digest("2"), authorization: "execute" },
      ],
      ["failed", "succeeded"],
    );
    coordinator = first.coordinator;
    expect(coordinator.state).toMatchObject({
      leaseExecutedToolCalls: 2,
      toolCalls: {
        requested: 3,
        executed: 2,
        succeeded: 1,
        failed: 1,
        denied: 1,
        governanceBlocked: 0,
      },
    });
  });

  it("records a denied-only batch without inventing execution or provider use", () => {
    const initial = prepared().coordinator;
    const denied = reduce(initial, {
      kind: "request-tool-batch",
      calls: [{ callSha256: digest("4"), authorization: "denied" }],
      envelope: {
        toolCalls: 0,
        providerTurns: 0,
        compactions: 0,
        inputTokens: 0,
        outputTokens: 0,
        elapsedMs: 0,
        contextInputTokens: 0,
      },
    });
    expect(denied.coordinator).toMatchObject({
      phase: "active",
      lastObservation: null,
      state: {
        providerTurns: 0,
        leaseExecutedToolCalls: 0,
        toolCalls: {
          requested: 1,
          executed: 0,
          denied: 1,
          governanceBlocked: 0,
        },
      },
    });
  });

  it("charges denied attempts up to the budget and governance-blocks the one past it", () => {
    const calls = Array.from({ length: MAX_CHARGEABLE_ATTEMPTS + 1 }, (_, index) => ({
      callSha256: fixtureCallSha256("d", index),
      authorization: "denied" as const,
    }));
    const boundary = reduce(prepared().coordinator, {
      kind: "request-tool-batch",
      calls,
      envelope: envelope(0, {
        providerTurns: 0,
        compactions: 0,
        inputTokens: 0,
        outputTokens: 0,
        elapsedMs: 0,
        contextInputTokens: 0,
      }),
    });
    expect(boundary.decision).toMatchObject({
      decision: "checkpoint-required",
      deniedToolCalls: MAX_CHARGEABLE_ATTEMPTS,
      governanceBlockedToolCalls: 1,
      reason: "hard-tool-call-ceiling",
    });
    expect(boundary.coordinator).toMatchObject({
      phase: "checkpoint-required",
      chargeableAttemptState: { chargeableAttempts: MAX_CHARGEABLE_ATTEMPTS },
      state: {
        toolCalls: {
          requested: MAX_CHARGEABLE_ATTEMPTS + 1,
          executed: 0,
          denied: MAX_CHARGEABLE_ATTEMPTS,
          governanceBlocked: 1,
        },
      },
    });
    const terminal = reduce(boundary.coordinator, {
      kind: "renew",
      nextTranche: envelope(grantedTranche(boundary.coordinator)),
    });
    expect(terminal.decision).toMatchObject({
      decision: "denied",
      reason: "hard-tool-call-ceiling",
    });
    expect(terminal.coordinator.coordinatorCheckpoints[0]).toMatchObject({
      sequence: 1,
      chargeableAttemptPolicySha256: terminal.coordinator.chargeableAttemptPolicy.policySha256,
      chargeableAttemptState: { chargeableAttempts: MAX_CHARGEABLE_ATTEMPTS },
    });
  });

  it("charges mixed denied/executed attempts while leaving overflow non-chargeable", () => {
    // Two full leases of executed calls plus enough denials to land the pair of
    // batches exactly on the chargeable-attempt budget, so the extra call in the
    // second batch is the first non-chargeable one.
    const deniedTotal = MAX_CHARGEABLE_ATTEMPTS - 2 * BASE.callsPerLease;
    const deniedFirst = Math.floor(deniedTotal / 2);
    const deniedSecond = deniedTotal - deniedFirst;
    expect(deniedTotal).toBeGreaterThanOrEqual(0);
    const firstCalls = [
      ...Array.from({ length: deniedFirst }, (_, index) => ({
        callSha256: fixtureCallSha256("a", index),
        authorization: "denied" as const,
      })),
      ...Array.from({ length: BASE.callsPerLease }, (_, index) => ({
        callSha256: fixtureCallSha256("b", index + 16),
        authorization: "execute" as const,
      })),
    ];
    let coordinator = requestAndSettle(prepared().coordinator, firstCalls).coordinator;
    expect(coordinator.chargeableAttemptState.chargeableAttempts).toBe(
      deniedFirst + BASE.callsPerLease,
    );
    coordinator = reduce(coordinator, {
      kind: "renew",
      nextTranche: envelope(grantedTranche(coordinator)),
    }).coordinator;

    const secondCalls = [
      ...Array.from({ length: deniedSecond }, (_, index) => ({
        callSha256: fixtureCallSha256("c", index + 32),
        authorization: "denied" as const,
      })),
      ...Array.from({ length: BASE.callsPerLease + 1 }, (_, index) => ({
        callSha256: fixtureCallSha256("e", index + 48),
        authorization: "execute" as const,
      })),
    ];
    coordinator = requestAndSettle(coordinator, secondCalls).coordinator;
    expect(coordinator).toMatchObject({
      phase: "checkpoint-required",
      chargeableAttemptState: { chargeableAttempts: MAX_CHARGEABLE_ATTEMPTS },
      state: {
        toolCalls: {
          requested: MAX_CHARGEABLE_ATTEMPTS + 1,
          executed: 2 * BASE.callsPerLease,
          denied: deniedTotal,
          governanceBlocked: 1,
        },
      },
    });
  });

  it("charges failed and repeated dispatches before blocking the attempt past the budget", () => {
    const executedFirst = 2;
    let coordinator = requestAndSettle(
      prepared().coordinator,
      [
        { callSha256: digest("2"), authorization: "execute" },
        { callSha256: digest("2"), authorization: "execute" },
      ],
      ["failed", "succeeded"],
    ).coordinator;
    // One denial past what the remaining budget can charge.
    const deniedCalls = Array.from(
      { length: MAX_CHARGEABLE_ATTEMPTS - executedFirst + 1 },
      (_, index) => ({
        callSha256: fixtureCallSha256("f", index + 1),
        authorization: "denied" as const,
      }),
    );
    coordinator = reduce(coordinator, {
      kind: "request-tool-batch",
      calls: deniedCalls,
      envelope: envelope(0, {
        providerTurns: 0,
        compactions: 0,
        inputTokens: 0,
        outputTokens: 0,
        elapsedMs: 0,
        contextInputTokens: 0,
      }),
    }).coordinator;
    expect(coordinator).toMatchObject({
      chargeableAttemptState: { chargeableAttempts: MAX_CHARGEABLE_ATTEMPTS },
      state: {
        toolCalls: {
          requested: MAX_CHARGEABLE_ATTEMPTS + 1,
          executed: executedFirst,
          failed: 1,
          succeeded: 1,
          denied: MAX_CHARGEABLE_ATTEMPTS - executedFirst,
          governanceBlocked: 1,
        },
      },
    });
  });

  it("supports a configured tightening chargeable-attempt ceiling", () => {
    // The cap `createExecutionChargeableAttemptPolicy` refuses to exceed is the
    // shipped ceiling itself, not this fixture's (turn-budget-clamped) budget.
    expect(() =>
      createExecutionChargeableAttemptPolicy({
        maxChargeableAttempts: EXECUTION_LEASE_DEFAULTS.hardToolCallCeiling + 1,
      }),
    ).toThrow(ExecutionLeaseCoordinatorError);
    const coordinator = prepared(policy(), pricing, 5).coordinator;
    const boundary = reduce(coordinator, {
      kind: "request-tool-batch",
      calls: Array.from({ length: 6 }, (_, index) => ({
        callSha256: fixtureCallSha256("1", index),
        authorization: "denied" as const,
      })),
      envelope: envelope(0, {
        providerTurns: 0,
        compactions: 0,
        inputTokens: 0,
        outputTokens: 0,
        elapsedMs: 0,
        contextInputTokens: 0,
      }),
    });
    expect(boundary.coordinator).toMatchObject({
      phase: "checkpoint-required",
      chargeableAttemptState: { chargeableAttempts: 5 },
      state: { toolCalls: { denied: 5, governanceBlocked: 1 } },
    });
  });

  it("requires CAS ownership, one pending batch, exact settlement, and monotonic observations", () => {
    const initial = prepared().coordinator;
    const request = reduce(initial, {
      kind: "request-tool-batch",
      calls: [{ callSha256: digest("4"), authorization: "execute" }],
      envelope: envelope(1),
    });
    expect(request.coordinator.phase).toBe("batch-pending");
    expect(() =>
      reduce(request.coordinator, {
        kind: "request-tool-batch",
        calls: [{ callSha256: digest("5"), authorization: "execute" }],
        envelope: envelope(1),
      }),
    ).toThrow(ExecutionLeaseCoordinatorError);
    expect(() =>
      reduceExecutionLeaseCoordinator({
        coordinator: request.coordinator,
        expectedCoordinatorSha256: initial.coordinatorSha256,
        command: {
          kind: "settle-tool-batch",
          results: [{ callSha256: digest("4"), outcome: "succeeded" }],
          observation: observation(request.coordinator),
        },
      }),
    ).toThrow(ExecutionLeaseCoordinatorError);
    expect(() =>
      reduce(request.coordinator, {
        kind: "settle-tool-batch",
        results: [{ callSha256: digest("6"), outcome: "succeeded" }],
        observation: observation(request.coordinator),
      }),
    ).toThrow(ExecutionLeaseCoordinatorError);

    const settled = reduce(request.coordinator, {
      kind: "settle-tool-batch",
      results: [{ callSha256: digest("4"), outcome: "succeeded" }],
      observation: observation(request.coordinator),
    });
    const regressed = createExecutionProgressObservation({
      sequence: 2,
      providerTurns: 0,
      compactions: 0,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      elapsedMs: 0,
      context,
    });
    expect(() =>
      reduce(settled.coordinator, {
        kind: "observe-provider-turn",
        observation: regressed,
      }),
    ).toThrow();
  });

  it("binds the exact granted resource envelope into pending and decision evidence", () => {
    const initial = prepared().coordinator;
    const calls = [{ callSha256: digest("6"), authorization: "execute" as const }];
    const first = reduce(initial, {
      kind: "request-tool-batch",
      calls,
      envelope: envelope(1, { inputTokens: 2, outputTokens: 3, elapsedMs: 4 }),
    });
    expect(first.decision.grantedEnvelope).toEqual({
      toolCalls: 1,
      providerTurns: 1,
      compactions: 0,
      inputTokens: 2,
      outputTokens: 3,
      elapsedMs: 4,
      contextInputTokens: 1,
      knownCostMicrousd: 1,
    });
    expect(first.coordinator.pendingBatch?.grantedEnvelope).toEqual(first.decision.grantedEnvelope);

    const changedBound = reduce(initial, {
      kind: "request-tool-batch",
      calls,
      envelope: envelope(1, { inputTokens: 3, outputTokens: 3, elapsedMs: 4 }),
    });
    expect(changedBound.decision.batchSha256).not.toBe(first.decision.batchSha256);
    expect(changedBound.coordinator.coordinatorSha256).not.toBe(
      first.coordinator.coordinatorSha256,
    );
  });

  it.each([
    ["provider turns", { providerTurns: 2 }],
    ["compactions", { compactions: 1 }],
    ["input tokens", { input: 2 }],
    ["output tokens", { output: 2 }],
    ["elapsed time", { elapsed: 2 }],
    [
      "context consumption",
      {
        context: { ...context, availableInputTokens: context.availableInputTokens - 2 },
      },
    ],
    [
      "context growth without compaction",
      {
        context: { ...context, availableInputTokens: context.availableInputTokens + 1 },
      },
    ],
  ] as const)("rejects settlement that overruns granted %s", (_name, increments) => {
    const initial = prepared().coordinator;
    const pending = reduce(initial, {
      kind: "request-tool-batch",
      calls: [{ callSha256: digest("7"), authorization: "execute" }],
      envelope: envelope(1),
    }).coordinator;
    expect(() =>
      reduce(pending, {
        kind: "settle-tool-batch",
        results: [{ callSha256: digest("7"), outcome: "succeeded" }],
        observation: observation(pending, increments),
      }),
    ).toThrow(ExecutionLeaseCoordinatorError);
    expect(pending.state.toolCalls.executed).toBe(0);
  });

  it("rejects missing bounds and permits unavailable pricing without a cost ceiling", () => {
    const initial = prepared().coordinator;
    const missingCompactionBound = envelope(1) as Record<string, unknown>;
    delete missingCompactionBound.compactions;
    expect(() =>
      reduce(initial, {
        kind: "request-tool-batch",
        calls: [{ callSha256: digest("8"), authorization: "execute" }],
        envelope: missingCompactionBound,
      } as never),
    ).toThrow(ExecutionLeaseCoordinatorError);

    const unpriced = prepared(policy(), {
      status: "unavailable",
      reason: "pricing-unknown",
      authoritySha256: digest("9"),
    }).coordinator;
    const granted = reduce(unpriced, {
      kind: "request-tool-batch",
      calls: [{ callSha256: digest("8"), authorization: "execute" }],
      envelope: envelope(1),
    });
    expect(granted.decision).toMatchObject({
      decision: "grant",
      authorizedToolCalls: 1,
      grantedEnvelope: { knownCostMicrousd: 0 },
    });
    const settled = reduce(granted.coordinator, {
      kind: "settle-tool-batch",
      results: [{ callSha256: digest("8"), outcome: "succeeded" }],
      observation: observation(granted.coordinator),
    });
    expect(settled.coordinator).toMatchObject({
      phase: "active",
      pricing: { status: "unavailable", reason: "pricing-unknown" },
      state: {
        cost: { status: "unavailable", reason: "pricing-unknown" },
        toolCalls: { requested: 1, executed: 1, succeeded: 1 },
      },
    });
  });

  it("rejects forged progress, context-authority substitution, gaps, and accepts exact replay", () => {
    const initial = prepared().coordinator;
    const observed = observation(initial);
    expect(() =>
      reduce(initial, {
        kind: "observe-provider-turn",
        observation: { ...observed, cumulativeInputTokens: 2 },
      }),
    ).toThrow(ExecutionLeaseCoordinatorError);

    const foreignAuthority = createExecutionProgressObservation({
      sequence: 1,
      providerTurns: 1,
      compactions: 0,
      cumulativeInputTokens: 1,
      cumulativeOutputTokens: 1,
      elapsedMs: 1,
      context: { ...context, authoritySha256: digest("9") },
    });
    expect(() =>
      reduce(initial, {
        kind: "observe-provider-turn",
        observation: foreignAuthority,
      }),
    ).toThrow(ExecutionLeaseCoordinatorError);

    const accepted = reduce(initial, { kind: "observe-provider-turn", observation: observed });
    const replay = reduce(accepted.coordinator, {
      kind: "observe-provider-turn",
      observation: observed,
    });
    expect(replay.coordinator.coordinatorSha256).toBe(accepted.coordinator.coordinatorSha256);
    const gap = createExecutionProgressObservation({
      sequence: 3,
      providerTurns: 2,
      compactions: 0,
      cumulativeInputTokens: 2,
      cumulativeOutputTokens: 2,
      elapsedMs: 2,
      context,
    });
    expect(() =>
      reduce(accepted.coordinator, {
        kind: "observe-provider-turn",
        observation: gap,
      }),
    ).toThrow(ExecutionLeaseCoordinatorError);
  });

  it("rejects unknown fields and sparse batches at every host boundary", () => {
    const policyInput = {
      maxCompactions: 4,
      providerLimits: { maxProviderTurns: 64, maxCompactions: 4 },
      cumulative: { maxInputTokens: 100, maxOutputTokens: 100, maxElapsedMs: 100 },
    };
    expect(() =>
      createExecutionLeaseCoordinatorPolicy({
        ...policyInput,
        unknown: true,
      } as never),
    ).toThrow(ExecutionLeaseCoordinatorError);
    expect(() =>
      createExecutionLeaseCoordinatorPolicy({
        ...policyInput,
        workflowOverrides: { callsPerLease: 10, unknown: true },
      } as never),
    ).toThrow(ExecutionLeaseCoordinatorError);
    expect(() =>
      createExecutionProgressObservation({
        sequence: 1,
        providerTurns: 1,
        compactions: 0,
        cumulativeInputTokens: 1,
        cumulativeOutputTokens: 1,
        elapsedMs: 1,
        context,
        unknown: true,
      } as never),
    ).toThrow(ExecutionLeaseCoordinatorError);
    expect(() =>
      createExecutionProgressObservation({
        sequence: 1,
        providerTurns: 1,
        compactions: 0,
        cumulativeInputTokens: 1,
        cumulativeOutputTokens: 1,
        elapsedMs: 1,
        context: { ...context, unknown: true },
      } as never),
    ).toThrow(ExecutionLeaseCoordinatorError);
    expect(() =>
      prepared(policy(), {
        ...pricing,
        unknown: true,
      } as never),
    ).toThrow(ExecutionLeaseCoordinatorError);

    const initial = prepared().coordinator;
    expect(() =>
      reduceExecutionLeaseCoordinator({
        coordinator: initial,
        expectedCoordinatorSha256: initial.coordinatorSha256,
        command: { kind: "complete" },
        unknown: true,
      } as never),
    ).toThrow(ExecutionLeaseCoordinatorError);
    expect(() =>
      reduce(initial, {
        kind: "complete",
        unknown: true,
      } as never),
    ).toThrow(ExecutionLeaseCoordinatorError);
    expect(() =>
      reduce(initial, {
        kind: "request-tool-batch",
        calls: [{ callSha256: digest("2"), authorization: "execute", unknown: true }],
        envelope: envelope(1),
      } as never),
    ).toThrow(ExecutionLeaseCoordinatorError);
    expect(() =>
      reduce(initial, {
        kind: "request-tool-batch",
        calls: [{ callSha256: digest("2"), authorization: "execute" }],
        envelope: { ...envelope(1), knownCostMicrousd: 0 },
      } as never),
    ).toThrow(ExecutionLeaseCoordinatorError);
    expect(() =>
      reduce(initial, {
        kind: "request-tool-batch",
        calls: new Array(1),
        envelope: envelope(1),
      }),
    ).toThrow(ExecutionLeaseCoordinatorError);

    const pending = reduce(initial, {
      kind: "request-tool-batch",
      calls: [{ callSha256: digest("7"), authorization: "execute" }],
      envelope: envelope(1),
    }).coordinator;
    expect(() =>
      reduce(pending, {
        kind: "settle-tool-batch",
        results: [{ callSha256: digest("7"), outcome: "succeeded", unknown: true }],
        observation: observation(pending),
      } as never),
    ).toThrow(ExecutionLeaseCoordinatorError);

    const grant = prepared().decision;
    expect(() =>
      serializeExecutionCoordinatorDecision({
        ...grant,
        unknown: true,
      } as never),
    ).toThrow(ExecutionLeaseCoordinatorError);
    expect(() =>
      serializeExecutionCoordinatorDecision({
        ...grant,
        authorizedToolCalls: 1,
      }),
    ).toThrow(ExecutionLeaseCoordinatorError);
  });

  it("rejects policy, coordinator, command, and nested-array proxies with zero traps", () => {
    let traps = 0;
    const handler: ProxyHandler<object> = {
      getPrototypeOf: (target) => {
        traps += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys: (target) => {
        traps += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor: (target, property) => {
        traps += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      get: (target, property, receiver) => {
        traps += 1;
        return Reflect.get(target, property, receiver);
      },
    };
    const policyInput = {
      maxCompactions: 4,
      providerLimits: { maxProviderTurns: 64, maxCompactions: 4 },
      cumulative: { maxInputTokens: 100, maxOutputTokens: 100, maxElapsedMs: 100 },
    };
    expect(() =>
      createExecutionLeaseCoordinatorPolicy(new Proxy(policyInput, handler) as never),
    ).toThrow(ExecutionLeaseCoordinatorError);
    expect(traps).toBe(0);

    const initial = prepared().coordinator;
    expect(() =>
      reduceExecutionLeaseCoordinator({
        coordinator: new Proxy(initial, handler as ProxyHandler<ExecutionLeaseCoordinatorV1>),
        expectedCoordinatorSha256: initial.coordinatorSha256,
        command: { kind: "complete" },
      }),
    ).toThrow(ExecutionLeaseCoordinatorError);
    expect(traps).toBe(0);

    expect(() =>
      reduceExecutionLeaseCoordinator({
        coordinator: initial,
        expectedCoordinatorSha256: initial.coordinatorSha256,
        command: new Proxy({ kind: "complete" }, handler) as never,
      }),
    ).toThrow(ExecutionLeaseCoordinatorError);
    expect(traps).toBe(0);

    const calls = [{ callSha256: digest("9"), authorization: "execute" as const }];
    expect(() =>
      reduce(initial, {
        kind: "request-tool-batch",
        calls: new Proxy(calls, handler as ProxyHandler<ExecutionToolBatchCallV1[]>),
        envelope: envelope(1),
      }),
    ).toThrow(ExecutionLeaseCoordinatorError);
    expect(traps).toBe(0);
  });

  it("derives tranche cost from bound pricing instead of caller assertions", () => {
    const costPolicy = policy({
      maxCompactions: 4,
      providerLimits: { maxProviderTurns: 64, maxCompactions: 4 },
      cumulative: {
        maxInputTokens: 100,
        maxOutputTokens: 100,
        maxElapsedMs: 100,
        maxKnownCostMicrousd: 1,
      },
    });
    const priced = prepared(costPolicy, {
      status: "known",
      inputMicrousdPerMillionTokens: 1_000_000,
      outputMicrousdPerMillionTokens: 0,
      authoritySha256: digest("8"),
    }).coordinator;
    const decision = reduce(priced, {
      kind: "request-tool-batch",
      calls: [{ callSha256: digest("3"), authorization: "execute" }],
      envelope: envelope(1, { inputTokens: 2 }),
    }).decision;
    expect(decision).toMatchObject({
      decision: "checkpoint-required",
      reason: "cumulative-cost-limit",
      authorizedToolCalls: 0,
    });
  });

  it("denies renewal when the next tranche cannot fit remaining host resources", () => {
    const boundedPolicy = policy({
      maxCompactions: 4,
      providerLimits: { maxProviderTurns: DEFAULT_PROVIDER_TURNS, maxCompactions: 4 },
      cumulative: { maxInputTokens: 10, maxOutputTokens: 10, maxElapsedMs: 10 },
    });
    // A full lease, so the coordinator is at a renewal boundary.
    const calls = Array.from({ length: boundedPolicy.callsPerLease }, (_, index) => ({
      callSha256: fixtureCallSha256("a", index),
      authorization: "execute" as const,
    }));
    const checkpoint = requestAndSettle(prepared(boundedPolicy).coordinator, calls).coordinator;
    expect(checkpoint.phase).toBe("checkpoint-required");
    const denied = reduce(checkpoint, {
      kind: "renew",
      nextTranche: envelope(grantedTranche(checkpoint), { inputTokens: 10 }),
    });
    expect(denied.decision).toMatchObject({
      decision: "denied",
      reason: "cumulative-input-limit",
    });
    expect(denied.coordinator.phase).toBe("terminal");
  });

  it("reconciles resource envelopes before admission and emits byte-stable evidence", () => {
    const leasePolicy = policy({
      maxCompactions: 1,
      providerLimits: { maxProviderTurns: 64, maxCompactions: 1 },
      cumulative: {
        maxInputTokens: 10,
        maxOutputTokens: 10,
        maxElapsedMs: 10,
        maxKnownCostMicrousd: 10,
      },
    });
    const initial = prepared(leasePolicy).coordinator;
    const command = {
      kind: "request-tool-batch" as const,
      calls: [{ callSha256: digest("5"), authorization: "execute" as const }],
      envelope: envelope(1, { inputTokens: 11 }),
    };
    const first = reduce(initial, command);
    const second = reduce(initial, command);
    expect(first.decision).toEqual(second.decision);
    if (initial.policy.schemaVersion !== 1) {
      throw new Error("stable decision serialization fixture requires a V1 policy");
    }
    expect(serializeExecutionCoordinatorDecision(first.decision)).toBe(
      serializeExecutionCoordinatorDecision(second.decision),
    );
    expect(first.decision).toMatchObject({
      decision: "checkpoint-required",
      reason: "cumulative-input-limit",
      authorizedToolCalls: 0,
    });
    expect(first.coordinator.state.toolCalls.requested).toBe(0);
  });

  it("builds causal #75 checkpoints for every renewal and denies the last at the boundary", () => {
    const { coordinator, lastDecision } = executeScalar(SCALAR.executed);
    expect(lastDecision).toMatchObject({ decision: "denied", reason: "hard-tool-call-ceiling" });
    // One checkpoint per lease the run spans: a grant at each renewal, then the denial.
    expect(coordinator.checkpoints).toHaveLength(SCALAR.leases);
    expect(
      coordinator.decisions.map((decision) =>
        decision.decision === "granted"
          ? `grant-${decision.leaseNumber}`
          : `deny-${decision.reason}`,
      ),
    ).toEqual([
      ...Array.from({ length: SCALAR.leases - 1 }, (_, index) => `grant-${index + 2}`),
      "deny-hard-tool-call-ceiling",
    ]);
  });

  it("binds ordinary completion into both checkpoint chains", () => {
    const completed = reduce(prepared().coordinator, { kind: "complete" });
    expect(completed.coordinator).toMatchObject({
      phase: "terminal",
      terminalReason: "completed",
      chargeableAttemptState: { chargeableAttempts: 0 },
    });
    expect(completed.coordinator.checkpoints).toHaveLength(1);
    expect(completed.coordinator.coordinatorCheckpoints).toHaveLength(1);
    expect(completed.coordinator.chargeableAttemptState.lastCheckpointSha256).toBe(
      completed.coordinator.coordinatorCheckpoints[0]?.checkpointSha256,
    );
  });
});
