// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_CUT_USAGE,
  ModelTurnGovernanceOptions,
  PiHarness,
  bindModelExecutionProfile,
  captureInferenceFailure,
  createModelConnection,
  createPiExecutionLeaseController,
  createRepository,
  limitDefinition,
  resetSharedTestState,
  scriptedProvider,
  skillCrateDirectory,
  stepInput,
  testTimeoutMs,
  textTurn,
  toolTurn,
  validModelConfig,
} from "./support/pi-harness-session-fixtures.js";

afterEach(resetSharedTestState);

/**
 * Governance allowances for one governed step attempt (`governance.maxCompactions`,
 * `governance.minRecentToolTurns`, `governance.maxConsecutiveLengthStoppedToolTurns`),
 * driven through the real `PiHarness` step: the session gets the catalogued
 * value, an admitted override replaces it, and an override past the ceiling is
 * refused by the override's name rather than clamped.
 */
describe("PiHarness governed recovery allowances", () => {
  /** Instant-replay audit harness that records the governance limits handed over. */
  function capturingHarness(overrides: Record<string, string> = {}): {
    harness: PiHarness;
    captured: ModelTurnGovernanceOptions["limits"][];
  } {
    const captured: ModelTurnGovernanceOptions["limits"][] = [];
    const harness = new PiHarness({
      skillCrateDirectory,
      model: validModelConfig,
      limits: { environment: { ...process.env, ...overrides } },
      createConnection: (model, options) => {
        captured.push(options?.limits);
        return createModelConnection(
          model,
          options ? { ...options, providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 } } : options,
        );
      },
    });
    return { harness, captured };
  }

  it(
    "hands the session the catalogued compaction and preservation allowances",
    async () => {
      const repositoryPath = await createRepository();
      vi.stubGlobal("fetch", scriptedProvider([textTurn("The review is complete.")]));
      const { harness, captured } = capturingHarness();

      const result = await harness.runStep(stepInput(repositoryPath));

      expect(result.summary).toBe("The review is complete.");
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        maxCompactions: limitDefinition("governance.maxCompactions").value,
        minRecentToolTurns: limitDefinition("governance.minRecentToolTurns").value,
      });
    },
    testTimeoutMs(20_000),
  );

  it(
    "hands the session an admitted override in place of the catalogued default",
    async () => {
      const repositoryPath = await createRepository();
      vi.stubGlobal("fetch", scriptedProvider([textTurn("The review is complete.")]));
      // An admitted override that differs from the catalogued default, chosen
      // from the catalog's [min, max]. The compaction default sits at its
      // ceiling, so its override moves down while the preservation minimum
      // moves up from its floor.
      const compactionEntry = limitDefinition("governance.maxCompactions");
      const recentEntry = limitDefinition("governance.minRecentToolTurns");
      const compactions = compactionEntry.value - 1;
      const recentToolTurns = recentEntry.value + 1;
      expect(compactions).not.toBe(compactionEntry.value);
      expect(compactions).toBeGreaterThanOrEqual(compactionEntry.min);
      expect(recentToolTurns).not.toBe(recentEntry.value);
      expect(recentToolTurns).toBeLessThanOrEqual(recentEntry.max);
      const { harness, captured } = capturingHarness({
        DOCSFAB_GOVERNANCE_MAX_COMPACTIONS: String(compactions),
        DOCSFAB_GOVERNANCE_MIN_RECENT_TOOL_TURNS: String(recentToolTurns),
      });

      await harness.runStep(stepInput(repositoryPath));

      expect(captured[0]).toMatchObject({
        maxCompactions: compactions,
        minRecentToolTurns: recentToolTurns,
      });
    },
    testTimeoutMs(20_000),
  );

  it(
    "raises the execution lease allowance with the turn governor's from one catalog entry",
    async () => {
      const repositoryPath = await createRepository();
      // The execution lease and the turn governor must read the same allowance,
      // or the lease refuses a compaction `docsfab doctor --limits` reports as
      // allowed.
      const raised = 16;
      const entry = limitDefinition("governance.maxCompactions");
      // `raised` is neither the catalogued default nor 8, so neither a literal
      // nor a catalog-ignoring default can satisfy the assertions below.
      expect(raised).not.toBe(8);
      expect(entry.value).not.toBe(raised);
      expect(raised).toBeGreaterThanOrEqual(entry.min);
      expect(entry.max).toBeGreaterThanOrEqual(raised);
      const input = stepInput(repositoryPath);
      const { profile } = bindModelExecutionProfile(validModelConfig);

      // The lease coordinator's policy resolves the same entry through the
      // limits source the harness hands it.
      const lease = createPiExecutionLeaseController(input, profile, ["read"], {
        environment: { ...process.env, DOCSFAB_GOVERNANCE_MAX_COMPACTIONS: String(raised) },
      });
      const leasePolicy = lease.coordinator.policy;
      if (leasePolicy.schemaVersion !== 1) throw new Error("expected finite lease policy");
      expect(leasePolicy.maxCompactions).toBe(raised);

      // `runStep` hands the turn governor the same number and builds a lease
      // with an identical policy digest.
      const provider = vi.fn(scriptedProvider([textTurn("The review is complete.")]));
      vi.stubGlobal("fetch", provider);
      const { harness, captured } = capturingHarness({
        DOCSFAB_GOVERNANCE_MAX_COMPACTIONS: String(raised),
      });

      const result = await harness.runStep(input);

      expect(result.summary).toBe("The review is complete.");
      expect(captured[0]).toMatchObject({ maxCompactions: raised });
      expect(result.executionLease?.policySha256).toBe(lease.coordinator.policy.policySha256);

      // One past the catalogued ceiling is refused by the override's name while
      // the allowance is resolved, before any provider request.
      provider.mockClear();
      const past = capturingHarness({
        DOCSFAB_GOVERNANCE_MAX_COMPACTIONS: String(entry.max + 1),
      });
      await expect(past.harness.runStep(stepInput(repositoryPath))).rejects.toThrow(
        new RegExp(
          `DOCSFAB_GOVERNANCE_MAX_COMPACTIONS must be an integer from 0 through ${entry.max}\\.`,
          "u",
        ),
      );
      expect(provider).not.toHaveBeenCalled();
    },
    testTimeoutMs(20_000),
  );

  it.each([
    ["governance.maxCompactions", "DOCSFAB_GOVERNANCE_MAX_COMPACTIONS"],
    ["governance.minRecentToolTurns", "DOCSFAB_GOVERNANCE_MIN_RECENT_TOOL_TURNS"],
    [
      "governance.maxConsecutiveLengthStoppedToolTurns",
      "DOCSFAB_GOVERNANCE_MAX_LENGTH_STOPPED_TOOL_TURNS",
    ],
  ])(
    "admits %s at its catalogued ceiling and refuses one past it by name",
    async (name, variable) => {
      const repositoryPath = await createRepository();
      const ceiling = limitDefinition(name).max;
      const provider = vi.fn(scriptedProvider([textTurn("The review is complete.")]));
      vi.stubGlobal("fetch", provider);

      // One past the ceiling fails closed before any provider request, and the
      // message names the override and its admitted range.
      const past = capturingHarness({ [variable]: String(ceiling + 1) });
      await expect(past.harness.runStep(stepInput(repositoryPath))).rejects.toThrow(
        new RegExp(`${variable} must be an integer (?:from|between) `, "u"),
      );
      expect(provider).not.toHaveBeenCalled();

      // Exactly at the ceiling the override is admitted and the step completes.
      const atCeiling = capturingHarness({ [variable]: String(ceiling) });
      const result = await atCeiling.harness.runStep(stepInput(repositoryPath));

      expect(result.summary).toBe("The review is complete.");
      expect(provider).toHaveBeenCalledOnce();
    },
    testTimeoutMs(20_000),
  );

  it(
    "grants one more truncated-batch re-issue when the allowance is raised, then names the repeat",
    async () => {
      const repositoryPath = await createRepository();
      // This default sits at its ceiling, so the raised allowance is stated
      // explicitly and checked against the catalogued range.
      const allowance = 3;
      const truncationEntry = limitDefinition("governance.maxConsecutiveLengthStoppedToolTurns");
      expect(allowance).toBeGreaterThanOrEqual(truncationEntry.min);
      expect(allowance).toBeLessThanOrEqual(truncationEntry.max);
      const cut = (created: number) =>
        toolTurn(
          [{ id: `call-${created}`, name: "read", arguments: { path: "README.md" } }],
          created,
          "length",
          LIVE_CUT_USAGE,
        );
      const provider = vi.fn(scriptedProvider([cut(1), cut(2), cut(3), textTurn("never reached")]));
      vi.stubGlobal("fetch", provider);
      const { harness } = capturingHarness({
        DOCSFAB_GOVERNANCE_MAX_LENGTH_STOPPED_TOOL_TURNS: String(allowance),
      });

      const error = await captureInferenceFailure(harness, stepInput(repositoryPath));

      // With one more turn granted, the second consecutive cut is not named: the
      // harness asks for another re-issue and names the turn at the raised
      // allowance.
      expect(provider).toHaveBeenCalledTimes(allowance);
      expect(error.message).toContain(
        `tool-arguments-truncated: ${allowance} consecutive provider turns of step`,
      );
      expect(error.rejection).toEqual({ code: "tool-arguments-truncated", location: "$response" });
      expect(error.category).toBe("malformed-response");
      expect(error.retryable).toBe(false);
    },
    testTimeoutMs(20_000),
  );
});
