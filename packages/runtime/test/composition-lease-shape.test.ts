// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { COMPOSITION_EXECUTION_ENVELOPE } from "../src/config/runtime-loader.js";
import { createExecutionLeaseCoordinatorPolicy } from "../src/execution/index.js";
import { EXECUTION_LEASE_DEFAULTS } from "../src/execution/lease-contracts.js";
import { resolveCompositionLeaseShape } from "../src/harness/pi-offline.js";

const envelope = {
  callsPerLease: COMPOSITION_EXECUTION_ENVELOPE.callsPerLease.default,
  maxLeases: COMPOSITION_EXECUTION_ENVELOPE.maxLeases.default,
  maxToolCallsPerStep: COMPOSITION_EXECUTION_ENVELOPE.maxToolCallsPerStep.default,
};

/** The three invariants `decodeExecutionLeasePolicy` enforces, restated here. */
function violations(
  shape: { callsPerLease: number; maxLeases: number; hardToolCallCeiling: number },
  maxProviderTurns: number,
): string[] {
  const problems: string[] = [];
  if (shape.callsPerLease > shape.hardToolCallCeiling) problems.push("callsPerLease > ceiling");
  if (shape.hardToolCallCeiling > shape.callsPerLease * shape.maxLeases) {
    problems.push("ceiling > callsPerLease * maxLeases");
  }
  if (maxProviderTurns < shape.hardToolCallCeiling + shape.maxLeases) {
    problems.push("maxProviderTurns < ceiling + maxLeases");
  }
  return problems;
}

describe("shipped composition execution envelope", () => {
  // The same guard the sibling COMPOSITION_EXECUTION_LIMITS table carries.
  // `boundedOptionalPositiveInteger` returns the default before range-checking
  // it, so a maximum below its default ships silently and makes the documented
  // override unable to express the value it overrides.
  it("ships every override maximum at or above its default", () => {
    const entries = Object.entries(COMPOSITION_EXECUTION_ENVELOPE);
    // An empty table would satisfy the loop vacuously.
    expect(entries).toHaveLength(5);

    for (const [field, bounds] of entries) {
      expect(bounds.max, `${field}: max must be >= default`).toBeGreaterThanOrEqual(bounds.default);
    }
  });
});

describe("resolveCompositionLeaseShape", () => {
  it("grants the full intended ceiling at the shipped turn budget", () => {
    // Positive control: at the real defaults nothing should clamp. If this
    // fails, the sealed turn budget and the envelope have drifted apart and every
    // other assertion here is measuring a clamp rather than the intended shape.
    const shape = resolveCompositionLeaseShape(envelope, EXECUTION_LEASE_DEFAULTS.maxProviderTurns);
    expect(shape.hardToolCallCeiling).toBe(EXECUTION_LEASE_DEFAULTS.hardToolCallCeiling);
  });

  it("clears the observed P100 of 54 tool calls per step", () => {
    // A single step can reach 54 tool calls; a ceiling at or below that
    // truncates real work.
    const shape = resolveCompositionLeaseShape(envelope, EXECUTION_LEASE_DEFAULTS.maxProviderTurns);
    expect(shape.hardToolCallCeiling).toBeGreaterThan(54);
  });

  it("degrades to the historical ceiling of 3 at a turn budget of 4", () => {
    // A hand-lowered turn budget must not produce a worse shape than the
    // simple per-lease formula.
    expect(resolveCompositionLeaseShape(envelope, 4)).toEqual({
      callsPerLease: 3,
      maxLeases: 1,
      hardToolCallCeiling: 3,
    });
  });

  it("holds every lease-policy invariant across the whole turn range", () => {
    for (let turns = 2; turns <= 256; turns += 1) {
      const shape = resolveCompositionLeaseShape(envelope, turns);
      expect(violations(shape, turns), `turns=${turns} ${JSON.stringify(shape)}`).toEqual([]);
    }
  });

  it("never lowers the ceiling as the turn budget grows", () => {
    // Monotonicity: the naive "take every lease" version returned a ceiling of 1
    // at four turns, below what three turns yielded.
    let previous = 0;
    for (let turns = 2; turns <= 256; turns += 1) {
      const { hardToolCallCeiling } = resolveCompositionLeaseShape(envelope, turns);
      expect(hardToolCallCeiling, `ceiling fell at turns=${turns}`).toBeGreaterThanOrEqual(
        previous,
      );
      previous = hardToolCallCeiling;
    }
  });

  it("chooses the lease count that maximises the ceiling, not the largest allowed", () => {
    // At 150 turns, 4 leases would give 146 and 2 leases give 148, so taking the
    // envelope maximum is the wrong choice. The turn budget must leave an
    // interior optimum: with `callsPerLease` of 100, a budget at or below 101
    // makes one lease optimal. The point is that the best lease count is
    // searched, not that it equals any particular literal.
    const shape = resolveCompositionLeaseShape(envelope, 150);
    expect(shape.maxLeases).toBe(2);
    expect(shape.hardToolCallCeiling).toBe(148);
    expect(shape.maxLeases).toBeLessThan(envelope.maxLeases);
    expect(shape.maxLeases).toBeGreaterThan(1);
    // The claim stated directly: no other admissible lease count does better.
    for (let leases = 1; leases <= envelope.maxLeases; leases += 1) {
      const ceiling = Math.min(
        envelope.maxToolCallsPerStep,
        envelope.callsPerLease * leases,
        150 - leases,
      );
      expect(ceiling, `leases=${leases}`).toBeLessThanOrEqual(shape.hardToolCallCeiling);
    }
  });

  it("breaks ties toward fewer leases", () => {
    // One lease and two both yield a ceiling of 1 here; fewer renewal boundaries
    // for the same budget is the better shape.
    expect(resolveCompositionLeaseShape({ ...envelope, maxToolCallsPerStep: 1 }, 8).maxLeases).toBe(
      1,
    );
  });

  it("builds a real coordinator policy at the SHIPPED budget, not a fixture value", () => {
    // Test fixtures pin maxProviderTurns to small numbers, so this is the case
    // that asks the coordinator for the budget the product ships. A second
    // hardcoded copy of the base disagreeing with EXECUTION_LEASE_DEFAULTS would
    // make every composition run throw ExecutionLeaseCoordinatorError while every
    // small-budget fixture still passed.
    const turns = EXECUTION_LEASE_DEFAULTS.maxProviderTurns;
    const shape = resolveCompositionLeaseShape(envelope, turns);
    const policy = createExecutionLeaseCoordinatorPolicy({
      maxCompactions: 8,
      providerLimits: { maxProviderTurns: turns, maxCompactions: 8 },
      workflowOverrides: { ...shape, maxProviderTurns: turns },
      cumulative: {
        maxInputTokens: COMPOSITION_EXECUTION_ENVELOPE.maxCumulativeInputTokens.default,
        maxOutputTokens: COMPOSITION_EXECUTION_ENVELOPE.maxCumulativeOutputTokens.default,
        maxElapsedMs: 300_000,
      },
    });
    expect(policy).toMatchObject({
      callsPerLease: shape.callsPerLease,
      maxLeases: shape.maxLeases,
      hardToolCallCeiling: shape.hardToolCallCeiling,
      maxProviderTurns: turns,
    });
    // A step can make enough tool calls.
    expect(policy.hardToolCallCeiling).toBeGreaterThan(54);
  });

  it("throws rather than returning a shape the coordinator would reject", () => {
    // A zero-lease envelope cannot satisfy `ceiling <= callsPerLease * maxLeases`
    // for any positive ceiling. Failing here names the numbers; failing inside a
    // live run surfaces only an opaque ExecutionLeaseCoordinatorError.
    expect(() =>
      resolveCompositionLeaseShape({ callsPerLease: 0, maxLeases: 0, maxToolCallsPerStep: 0 }, 1),
    ).toThrow(/invariants/);
  });
});
