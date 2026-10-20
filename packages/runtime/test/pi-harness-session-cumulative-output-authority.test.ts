// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BoundModelExecutionProfile,
  OUTPUT_AUTHORITY_FLOOR_TOKENS,
  PiHarness,
  captureInferenceFailure,
  createProviderConnectionFactory,
  createRepository,
  expectLeaseToolConsistency,
  loadCompositionExecutionEnvelope,
  fixtureCompositionExecutionProfile,
  resetSharedTestState,
  scriptedProvider,
  skillCrateDirectory,
  stepInput,
  textTurn,
  toolTurn,
  validModelConfig,
} from "./support/pi-harness-session-fixtures.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";

afterEach(resetSharedTestState);

/**
 * A per-turn output request larger than the remaining cumulative lease is
 * clamped to the remainder, and the step ends by name when the remainder is
 * below the floor. These drive the real harness, governor, lease and stream
 * wrapper over a scripted provider that reports the spent output on turn one,
 * then assert on the `max_tokens` sent for turn two and on the stop evidence.
 */
describe("PiHarness cumulative output authority", () => {
  const perTurnOutput = 32_768;
  // A fixed envelope, not a shipped-default pin, so a larger cumulative
  // allowance does not make the scripted first turn exceed its model context.
  const leaseOutput = 128_000;
  const floor = validModelConfig.requestPolicy.minimumOutputTokens + OUTPUT_AUTHORITY_FLOOR_TOKENS;
  /** Default `textTurn` completion_tokens: tokens produced, not the allowance. */
  const restProduced = 5;

  beforeEach(() => {
    vi.stubEnv("DOCSFAB_COMPOSITION_EXECUTION_MAX_CUMULATIVE_OUTPUT_TOKENS", String(leaseOutput));
    expect(loadCompositionExecutionEnvelope().maxCumulativeOutputTokens).toBe(leaseOutput);
  });
  afterEach(() => vi.unstubAllEnvs());

  function outputAuthorityHarness(): PiHarness {
    const base = fixtureCompositionExecutionProfile({
      maxProviderTurns: 8,
      timeoutMs: 30_000,
      maxResponseBytes: 65_536,
    });
    const executionProfile: BoundModelExecutionProfile = {
      ...base,
      profile: {
        ...base.profile,
        configuredLimits: {
          contextWindow: 524_288,
          maxInputTokens: 524_288,
          maxOutputTokens: perTurnOutput,
        },
        contextWindow: 524_288,
        maxInputTokens: 524_288,
        maxOutputTokens: perTurnOutput,
      },
    };
    return new PiHarness({
      skillCrateDirectory,
      executionProfile,
      // A random-looking key: the provider registers the model key in use as a
      // configured credential, and pieces of a word-like key such as
      // "output-authority" would match DocsFab's own refusal text (#1807).
      credential: { family: "nvidia-inference-api", apiKey: plantedCredentialValue(61, 32) },
      providerConnectionFactory: createProviderConnectionFactory({
        routeId: executionProfile.routeId,
        transport: executionProfile.transport,
      }),
    });
  }

  /**
   * One tool turn whose usage reports `spent` output tokens, then `rest` (a
   * final answer unless given). Request bodies are captured so the test asserts
   * on the `max_tokens` that left, not a ledger's account of it.
   */
  function scriptSpentOutput(
    spent: number,
    rest: readonly Response[] = [textTurn("The documentation audit is complete.")],
  ): Array<Record<string, unknown>> {
    const bodies: Array<Record<string, unknown>> = [];
    const scripted = scriptedProvider([
      toolTurn([{ id: "call-0", name: "ls", arguments: { path: "." } }], 1, "tool_calls", {
        prompt_tokens: 10,
        completion_tokens: spent,
        total_tokens: 10 + spent,
      }),
      ...rest,
    ]);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return scripted(input, init);
    });
    return bodies;
  }
  const requestedOutput = (body: Record<string, unknown>) =>
    body.max_tokens ?? body.max_completion_tokens;

  it("records tokens produced on a turn, not the output allowance", async () => {
    const repositoryPath = await createRepository();
    const produced = 1_000;
    const bodies = scriptSpentOutput(produced);

    const result = await outputAuthorityHarness().runStep(stepInput(repositoryPath));

    expect(result.summary).toBe("The documentation audit is complete.");
    expect(bodies.map(requestedOutput)).toEqual([perTurnOutput, perTurnOutput]);
    const sent = (result.turns ?? []).filter((turn) => turn.decision !== "stop");
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      outputTokens: produced,
      effectiveMaxOutputTokens: perTurnOutput,
    });
    expect(sent[1]).toMatchObject({
      outputTokens: restProduced,
      effectiveMaxOutputTokens: perTurnOutput,
    });
    expect(sent[0]!.outputTokens).not.toBe(sent[0]!.effectiveMaxOutputTokens);
    expect(sent[1]!.outputTokens).not.toBe(sent[1]!.effectiveMaxOutputTokens);
    const turnOutput = sent.reduce((sum, turn) => sum + (turn.outputTokens ?? 0), 0);
    expect(result.usage?.output).toBe(turnOutput);
    expect(result.executionLease).toMatchObject({
      terminalDisposition: "completed",
      cumulativeOutputTokens: produced + restProduced,
    });
  });

  it("sends the full per-turn output while the remaining authority covers it", async () => {
    const repositoryPath = await createRepository();
    const spent = leaseOutput - 40_000;
    const bodies = scriptSpentOutput(spent);

    const result = await outputAuthorityHarness().runStep(stepInput(repositoryPath));

    expect(result.summary).toBe("The documentation audit is complete.");
    expect(bodies.map(requestedOutput)).toEqual([perTurnOutput, perTurnOutput]);
    expect(result.turns?.[1]).toMatchObject({
      decision: "proceed",
      outputTokens: restProduced,
      effectiveMaxOutputTokens: perTurnOutput,
    });
    expect(result.turns?.[1]?.outputAuthority).toBeUndefined();
    expect(result.executionLease).toMatchObject({
      terminalDisposition: "completed",
      cumulativeOutputTokens: spent + 5,
    });
  });

  it("keeps the model per-turn output limit under the larger current execution allowance", async () => {
    // Clear the fixture override and use the current default, so the model's
    // 32,768 per-turn allowance binds rather than the cumulative lease.
    vi.stubEnv("DOCSFAB_COMPOSITION_EXECUTION_MAX_CUMULATIVE_OUTPUT_TOKENS", undefined);
    const currentLeaseOutput = loadCompositionExecutionEnvelope().maxCumulativeOutputTokens;
    const spent = 95_704;
    expect(currentLeaseOutput - spent).toBeGreaterThan(perTurnOutput);
    const repositoryPath = await createRepository();
    const bodies = scriptSpentOutput(spent);

    const result = await outputAuthorityHarness().runStep(stepInput(repositoryPath));

    expect(result.summary).toBe("The documentation audit is complete.");
    expect(bodies.map(requestedOutput)).toEqual([perTurnOutput, perTurnOutput]);
    expect(result.turns?.[1]).toMatchObject({
      decision: "proceed",
      outputTokens: restProduced,
      effectiveMaxOutputTokens: perTurnOutput,
    });
    expect(result.turns?.[1]?.outputAuthority).toBeUndefined();
    expect(result.executionLease).toMatchObject({
      terminalDisposition: "completed",
      providerTurns: 2,
      cumulativeOutputTokens: spent + 5,
    });
  });

  it("replays live defect 28: the next request is clamped to the 32,296 remaining and the step completes", async () => {
    const repositoryPath = await createRepository();
    const spent = 95_704;
    const bodies = scriptSpentOutput(spent);

    const result = await outputAuthorityHarness().runStep(stepInput(repositoryPath));

    expect(result.summary).toBe("The documentation audit is complete.");
    expect(bodies.map(requestedOutput)).toEqual([perTurnOutput, leaseOutput - spent]);
    expect(result.turns?.[1]).toMatchObject({
      decision: "proceed",
      requestedOutputTokens: leaseOutput - spent,
      outputTokens: restProduced,
      outputAuthority: {
        maxOutputTokens: leaseOutput,
        cumulativeOutputTokens: spent,
        floorOutputTokens: floor,
      },
    });
    expect(result.executionLease).toMatchObject({
      terminalDisposition: "completed",
      providerTurns: 2,
      cumulativeOutputTokens: spent + 5,
    });
  });

  it("clamps the request to a 10,000-token remainder and records the clamp on the turn", async () => {
    const repositoryPath = await createRepository();
    const spent = leaseOutput - 10_000;
    const bodies = scriptSpentOutput(spent);

    const result = await outputAuthorityHarness().runStep(stepInput(repositoryPath));

    expect(bodies.map(requestedOutput)).toEqual([perTurnOutput, 10_000]);
    expect(result.turns?.[1]).toMatchObject({
      requestedOutputTokens: 10_000,
      outputTokens: restProduced,
      outputAuthority: {
        maxOutputTokens: leaseOutput,
        cumulativeOutputTokens: spent,
        floorOutputTokens: floor,
      },
    });
    expect(result.executionLease?.terminalDisposition).toBe("completed");
  });

  it("ends the step by name when the remaining authority is below the floor", async () => {
    const repositoryPath = await createRepository();
    const spent = leaseOutput - 500;
    const bodies = scriptSpentOutput(spent);
    const harness = outputAuthorityHarness();

    const error = await captureInferenceFailure(harness, stepInput(repositoryPath));

    // No second request left the host.
    expect(bodies).toHaveLength(1);
    expect(error.message).toContain(
      `Output authority exhausted [output-authority-exhausted]: step audit-documentation used ${spent} of ${leaseOutput} cumulative output tokens; the 500 remaining are below the ${floor}-token floor, so no further provider turn was requested.`,
    );
    expect(error.category).toBe("context-exhausted");
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain("provider-terminal");
    expect(error.message).not.toContain("exceeds cumulative authority");
    expect(error.evidence?.executionLease).toMatchObject({
      phase: "terminal",
      terminalReason: "output-authority-exhausted",
      terminalDisposition: "budget-stopped",
      cumulativeOutputTokens: spent,
      toolCalls: { requested: 1, executed: 1, succeeded: 1, failed: 0 },
    });
    const turns = error.evidence?.turns ?? [];
    expect(turns.at(-1)).toMatchObject({
      decision: "stop",
      reason: "output-authority-exhausted",
      outputAuthority: {
        maxOutputTokens: leaseOutput,
        cumulativeOutputTokens: spent,
        floorOutputTokens: floor,
      },
    });
    // The stop sent nothing, so the lease charged nothing for it.
    expect(error.evidence?.executionLease?.providerTurns).toBe(
      turns.filter((turn) => turn.decision !== "stop").length,
    );
    expectLeaseToolConsistency(error);
  });

  it("sends exactly the floor when that is all the authority has left", async () => {
    // The lower boundary of the clamp: exactly the floor is still a turn worth
    // sending, and what leaves the host is the floor, not a stop.
    const repositoryPath = await createRepository();
    const spent = leaseOutput - floor;
    const bodies = scriptSpentOutput(spent);

    const result = await outputAuthorityHarness().runStep(stepInput(repositoryPath));

    expect(result.summary).toBe("The documentation audit is complete.");
    expect(bodies.map(requestedOutput)).toEqual([perTurnOutput, floor]);
    expect(result.turns?.[1]).toMatchObject({
      decision: "proceed",
      requestedOutputTokens: floor,
      outputTokens: restProduced,
      outputAuthority: {
        maxOutputTokens: leaseOutput,
        cumulativeOutputTokens: spent,
        floorOutputTokens: floor,
      },
    });
    expect(result.executionLease).toMatchObject({
      terminalDisposition: "completed",
      providerTurns: 2,
      cumulativeOutputTokens: spent + 5,
    });
  });

  it("sends the full per-turn output unchanged when the remainder equals it exactly", async () => {
    // The upper boundary of the clamp: a remainder of exactly the per-turn
    // limit fits, so the request is not clamped and no authority is recorded;
    // validators refuse a recorded authority at this remainder.
    const repositoryPath = await createRepository();
    const spent = leaseOutput - perTurnOutput;
    const bodies = scriptSpentOutput(spent);

    const result = await outputAuthorityHarness().runStep(stepInput(repositoryPath));

    expect(result.summary).toBe("The documentation audit is complete.");
    expect(bodies.map(requestedOutput)).toEqual([perTurnOutput, perTurnOutput]);
    expect(result.turns?.[1]).toMatchObject({
      decision: "proceed",
      outputTokens: restProduced,
      effectiveMaxOutputTokens: perTurnOutput,
    });
    expect(result.turns?.[1]?.outputAuthority).toBeUndefined();
    expect(result.turns?.[1]?.requestedOutputTokens).toBeUndefined();
    expect(result.executionLease).toMatchObject({
      terminalDisposition: "completed",
      providerTurns: 2,
      cumulativeOutputTokens: spent + 5,
    });
  });

  /**
   * A request clamped to the lease remainder can be cut at that remainder
   * (finish_reason=length). The composition's `maxOutputTokens` was not the
   * binding limit, so the truncation hint must name the lease clamp instead of
   * telling the operator to raise a knob that cannot move the limit.
   */
  const leaseLabel = `${leaseOutput.toLocaleString("en-US")}-token cumulative output lease`;

  it("names the lease clamp, not maxOutputTokens, when a clamped terminal answer is cut", async () => {
    const repositoryPath = await createRepository();
    const spent = leaseOutput - 10_000;
    const partial = "# Documentation audit\n\n## Findings\n\n1. The README's install section";
    const bodies = scriptSpentOutput(spent, [
      textTurn(partial, validModelConfig.modelId, "length"),
    ]);

    const error = await captureInferenceFailure(
      outputAuthorityHarness(),
      stepInput(repositoryPath),
    );

    // The cut turn is the clamped one: 10,000 left, 10,000 requested.
    expect(bodies.map(requestedOutput)).toEqual([perTurnOutput, 10_000]);
    expect(error.message).toContain(
      `Provider turn failed: provider-failed: text-truncated: step audit-documentation answer cut at the 10,000-token output limit (finish_reason=length) after ${partial.length} characters, last turn consumed 5 output tokens; partial text retained, not accepted as complete. Shorten the answer; the limit was the 10,000 output tokens left of the ${leaseLabel}, not maxOutputTokens.`,
    );
    expect(error.message).not.toContain("raise maxOutputTokens");
    expect(error.category).toBe("malformed-response");
    // The cut is the `cut-answer` condition; the retry rule decides, not the harness.
    expect(error.retryable).toBe(true);
    expect(error.condition).toBe("cut-answer");
    expect(error.evidence?.turns?.[1]).toMatchObject({
      requestedOutputTokens: 10_000,
      outputTokens: restProduced,
      outputAuthority: { maxOutputTokens: leaseOutput, cumulativeOutputTokens: spent },
    });
    expect(error.evidence?.executionLease).toMatchObject({
      providerTurns: 2,
      terminalDisposition: "provider-failed",
    });
  });

  it("names the lease clamp, not maxOutputTokens, when a clamped tool call is cut twice", async () => {
    vi.stubEnv("DOCSFAB_GOVERNANCE_MAX_LENGTH_STOPPED_TOOL_TURNS", "2");
    const repositoryPath = await createRepository();
    const spent = leaseOutput - 20_000;
    const cutUsage = { prompt_tokens: 52_486, completion_tokens: 8_192, total_tokens: 60_678 };
    const cut = (created: number) =>
      toolTurn(
        [{ id: `call-${created}`, name: "read", arguments: { path: "README.md" } }],
        created,
        "length",
        cutUsage,
      );
    const bodies = scriptSpentOutput(spent, [cut(2), cut(3), textTurn("never reached")]);

    const error = await captureInferenceFailure(
      outputAuthorityHarness(),
      stepInput(repositoryPath),
    );

    // Turn 2 is clamped to the 20,000 left and cut; its 8,192 are charged, so
    // the re-issue (turn 3) is clamped to the 11,808 then left and cut again.
    const left = 20_000 - cutUsage.completion_tokens;
    expect(bodies.map(requestedOutput)).toEqual([perTurnOutput, 20_000, left]);
    expect(error.message).toContain(
      `Tool-batch provider turn failed: provider-failed: tool-arguments-truncated: 2 consecutive provider turns of step audit-documentation hit the ${left.toLocaleString("en-US")}-token output limit (finish_reason=length) with truncated tool arguments, last turn consumed 8,192 output tokens; the re-issued call repeated the cut. Keep tool arguments within the limit; the limit was the ${left.toLocaleString("en-US")} output tokens left of the ${leaseLabel}, not maxOutputTokens.`,
    );
    expect(error.message).not.toContain("raise maxOutputTokens");
    expect(error.category).toBe("malformed-response");
    expect(error.retryable).toBe(false);
    expect(error.evidence?.turns?.[2]).toMatchObject({
      requestedOutputTokens: left,
      outputAuthority: {
        maxOutputTokens: leaseOutput,
        cumulativeOutputTokens: spent + cutUsage.completion_tokens,
      },
    });
    expect(error.evidence?.executionLease).toMatchObject({
      providerTurns: 3,
      terminalReason: "provider-terminal",
      terminalDisposition: "provider-failed",
    });
  });
});
