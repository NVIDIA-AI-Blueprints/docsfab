// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXECUTION_LEASE_DEFAULTS,
  ResolveLimitsOptions,
  bindModelExecutionProfile,
  createPiExecutionLeaseController,
  createRepository,
  limitDefinition,
  loadCompositionExecutionEnvelope,
  namedLimitDefinition,
  fixtureCompositionExecutionProfile,
  resetSharedTestState,
  resolveNamedLimit,
  stepInput,
  temporaryDirectories,
  validModelConfig,
} from "./support/pi-harness-session-fixtures.js";

afterEach(resetSharedTestState);

/**
 * Normal-mode cumulative admission uses two catalog entries with no
 * environment override (`execution.normalModeTokenBudgetTurns`,
 * `execution.normalModeMaxElapsedMs`), so only a host limits file keyed by the
 * entry name can move them. These rows drive that file through the factory and
 * assert the same number twice: as the resolved row `docsfab doctor --limits`
 * formats, and as the authority the controller admits.
 */
describe("normal-mode budget admission from a host limits file", () => {
  const budgetTurns = namedLimitDefinition("execution.normalModeTokenBudgetTurns");
  const elapsedBudget = namedLimitDefinition("execution.normalModeMaxElapsedMs");
  const normalMode = bindModelExecutionProfile(validModelConfig).profile;

  /** A host limits file keyed by entry name: the only tier these two entries have. */
  async function hostLimits(...assignments: readonly string[]): Promise<ResolveLimitsOptions> {
    const directory = await mkdtemp(resolve(tmpdir(), "docsfab-normal-mode-host-"));
    temporaryDirectories.push(directory);
    const hostFile = resolve(directory, "service.env");
    await writeFile(hostFile, `${assignments.join("\n")}\n`, "utf8");
    return { environment: {}, hostFile, projectFile: null };
  }

  async function admit(
    limits: ResolveLimitsOptions,
    model: Parameters<typeof createPiExecutionLeaseController>[1] = normalMode,
  ): Promise<{ maxInputTokens: number; maxOutputTokens: number; maxElapsedMs: number }> {
    const repositoryPath = await createRepository();
    const policy = createPiExecutionLeaseController(
      stepInput(repositoryPath),
      model,
      ["read"],
      limits,
    ).coordinator.policy;
    if (policy.schemaVersion !== 1) throw new Error("normal-mode admission requires finite policy");
    return policy.cumulative;
  }

  it("admits both entries at their declared maximum", async () => {
    // Positive control at the limit, so the lowered case below cannot pass by
    // admission ignoring the file in both directions.
    const limits = await hostLimits(
      `${budgetTurns.name}=${budgetTurns.max}`,
      `${elapsedBudget.name}=${elapsedBudget.max}`,
    );
    expect(resolveNamedLimit(budgetTurns.name, limits)).toMatchObject({
      value: budgetTurns.max,
      source: "host",
    });
    expect(resolveNamedLimit(elapsedBudget.name, limits)).toMatchObject({
      value: elapsedBudget.max,
      source: "host",
    });

    expect(await admit(limits)).toEqual({
      maxInputTokens: normalMode.profile.maxInputTokens * budgetTurns.max,
      maxOutputTokens: normalMode.profile.maxOutputTokens * budgetTurns.max,
      maxElapsedMs: elapsedBudget.max,
    });
  });

  it("applies a lowered host value to lease admission, not only to the resolver", async () => {
    // Reading `limitDefinition` at the call site would report the operator's
    // minimum in `docsfab doctor --limits` while the controller admits the
    // catalog default.
    const limits = await hostLimits(
      `${budgetTurns.name}=${budgetTurns.min}`,
      `${elapsedBudget.name}=${elapsedBudget.min}`,
    );
    const reported = {
      turns: resolveNamedLimit(budgetTurns.name, limits).value,
      elapsedMs: resolveNamedLimit(elapsedBudget.name, limits).value,
    };
    expect(reported).toEqual({ turns: budgetTurns.min, elapsedMs: elapsedBudget.min });

    const admitted = await admit(limits);
    expect(admitted).toEqual({
      maxInputTokens: normalMode.profile.maxInputTokens * reported.turns,
      maxOutputTokens: normalMode.profile.maxOutputTokens * reported.turns,
      maxElapsedMs: reported.elapsedMs,
    });
    // Once the host file lowers the entry, admission does not use the catalog
    // default.
    expect(admitted.maxOutputTokens).not.toBe(
      normalMode.profile.maxOutputTokens * budgetTurns.value,
    );
    expect(admitted.maxElapsedMs).not.toBe(elapsedBudget.value);
  });

  it.each([["execution.normalModeTokenBudgetTurns"], ["execution.normalModeMaxElapsedMs"]])(
    "refuses one past the declared maximum of %s by name",
    async (name) => {
      // Limit plus one. The refusal names the entry and its range.
      const definition = namedLimitDefinition(name);
      const limits = await hostLimits(`${definition.name}=${definition.max + 1}`);
      await expect(admit(limits)).rejects.toThrow(
        `${definition.name} must be an integer between ${definition.min} and ${definition.max}.`,
      );
    },
  );

  it("leaves a composition attempt on its own envelope and timeout", async () => {
    // A composition attempt takes its elapsed budget from `timeoutMs` and its
    // token budget from the sealed composition envelope, so the lowered host file
    // moves neither.
    const limits = await hostLimits(
      `${budgetTurns.name}=${budgetTurns.min}`,
      `${elapsedBudget.name}=${elapsedBudget.min}`,
    );
    const envelope = loadCompositionExecutionEnvelope();
    const execution = fixtureCompositionExecutionProfile({
      maxProviderTurns: EXECUTION_LEASE_DEFAULTS.maxProviderTurns,
      timeoutMs: elapsedBudget.max,
      maxResponseBytes: namedLimitDefinition("compositionExecution.maxResponseBytes").value,
    });

    expect(await admit(limits, execution)).toEqual({
      maxInputTokens: envelope.maxCumulativeInputTokens,
      maxOutputTokens: envelope.maxCumulativeOutputTokens,
      maxElapsedMs: execution.compositionPolicy!.timeoutMs,
    });
  });
});
