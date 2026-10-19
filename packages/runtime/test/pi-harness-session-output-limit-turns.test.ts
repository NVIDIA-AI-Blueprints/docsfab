// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_CUT_USAGE,
  PiHarness,
  blankTurn,
  captureInferenceFailure,
  createInstantReplayAuditHarness,
  createRepository,
  expectDecodedAttemptEvidence,
  grantedTurnOutputTokens,
  hubUnavailableResponse,
  resetSharedTestState,
  scriptedProvider,
  stepInput,
  textTurn,
  toolTurn,
  validModelConfig,
} from "./support/pi-harness-session-fixtures.js";

afterEach(resetSharedTestState);

/**
 * A terminal turn can bill the whole output budget with finish_reason=length
 * and surface no text and no tool call. These run the real Pi session against
 * that response shape and its neighbours.
 */
describe("PiHarness turns stopped at the output limit", () => {
  const limit = validModelConfig.profile.maxOutputTokens.toLocaleString("en-US");

  it("replays a withheld cut once with the length nudge and finishes the step", async () => {
    const repositoryPath = await createRepository();
    const provider = vi.fn(
      scriptedProvider([blankTurn("length", LIVE_CUT_USAGE), textTurn("The review is complete.")]),
    );
    vi.stubGlobal("fetch", provider);
    const harness = await createInstantReplayAuditHarness();

    const result = await harness.runStep(stepInput(repositoryPath));

    expect(result.summary).toBe("The review is complete.");
    expect(provider).toHaveBeenCalledTimes(2);
    // The wire carries the nudge: the second request is the first plus one
    // trailing user message naming the governed limit, and nothing else moved.
    const bodies = provider.mock.calls.map(
      ([, init]) =>
        JSON.parse(String((init as RequestInit).body)) as {
          messages: unknown[];
          max_tokens: number;
        },
    );
    expect(bodies[1]!.messages).toHaveLength(bodies[0]!.messages.length + 1);
    expect(bodies[1]!.messages.slice(0, -1)).toEqual(bodies[0]!.messages);
    expect(JSON.stringify(bodies[1]!.messages.at(-1))).toContain(
      `output limit of ${limit} tokens (finish_reason=length)`,
    );
    expect(bodies[1]!.max_tokens).toBe(bodies[0]!.max_tokens);
    // One governed turn: the nudged replay is the same turn, not a second one.
    expect(result.turns).toHaveLength(1);
    expect(result.turns?.[0]).toMatchObject({ providerRetries: 1, providerBlankTurns: 1 });
    expect(result.executionLease).toMatchObject({ providerTurns: 1, terminalReason: "completed" });
    // The discarded cut's 8,192 output tokens plus the landed turn's 5.
    expect(result.executionLease?.cumulativeOutputTokens).toBe(8_192 + 5);
    expect(result.executionLease?.cumulativeInputTokens).toBe(52_486 + 10);
  });

  it("records discarded-plus-landed production that crosses one request grant", async () => {
    const grant = validModelConfig.profile.maxOutputTokens;
    const perAttempt = 12_000;
    expect(perAttempt).toBeLessThan(grant);
    expect(perAttempt * 2).toBeGreaterThan(grant);
    const usage = {
      prompt_tokens: 10,
      completion_tokens: perAttempt,
      total_tokens: 10 + perAttempt,
    };
    const repositoryPath = await createRepository();
    const provider = vi.fn(
      scriptedProvider([
        blankTurn("length", usage),
        textTurn("The review is complete.", validModelConfig.modelId, "stop", usage),
      ]),
    );
    vi.stubGlobal("fetch", provider);
    const harness = await createInstantReplayAuditHarness();

    const result = await harness.runStep(stepInput(repositoryPath));

    expect(result.summary).toBe("The review is complete.");
    expect(provider).toHaveBeenCalledTimes(2);
    const bodies = provider.mock.calls.map(
      ([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
    );
    const requestedOutput = (body: Record<string, unknown>) =>
      body.max_tokens ?? body.max_completion_tokens;
    expect(bodies.map(requestedOutput)).toEqual([grant, grant]);
    const turn = result.turns?.[0];
    expect(turn).toMatchObject({ providerRetries: 1, providerBlankTurns: 1 });
    expect(turn?.outputTokens).toBe(perAttempt * 2);
    expect(turn?.outputTokens).toBeGreaterThan(grantedTurnOutputTokens(turn!));
    expect(result.executionLease).toMatchObject({
      providerTurns: 1,
      terminalReason: "completed",
      cumulativeOutputTokens: perAttempt * 2,
    });
    expectDecodedAttemptEvidence(result, "succeeded", false);
  });

  /**
   * A 503 or an ordinary empty stop on the nudged replay must be replayed with
   * the nudged request, not the original, which the installed request policy
   * refuses (`turn-evidence-authority`).
   */
  it.each([
    [
      "a hub 503",
      () => hubUnavailableResponse(),
      { providerRetries: 2, providerBlankTurns: 1 },
      // The 503 carries no usage: the discarded cut (8,192) plus the landed turn (5).
      8_192 + 5,
    ],
    [
      "an ordinary empty stop",
      () => blankTurn(),
      { providerRetries: 2, providerBlankTurns: 2 },
      // Cut 8,192, empty stop 0, landed 5.
      8_192 + 5,
    ],
  ] as const)(
    "replays the nudged request again when %s lands on it and finishes the step",
    async (_label, second, counters, cumulativeOutputTokens) => {
      const repositoryPath = await createRepository();
      const provider = vi.fn(
        scriptedProvider([
          blankTurn("length", LIVE_CUT_USAGE),
          second(),
          textTurn("The review is complete."),
        ]),
      );
      vi.stubGlobal("fetch", provider);
      const harness = await createInstantReplayAuditHarness();

      const result = await harness.runStep(stepInput(repositoryPath));

      expect(result.summary).toBe("The review is complete.");
      expect(provider).toHaveBeenCalledTimes(3);
      const bodies = provider.mock.calls.map(
        ([, init]) => JSON.parse(String((init as RequestInit).body)) as { messages: unknown[] },
      );
      // Third request equals the nudged second one, and is one message longer
      // than the original: the nudge stays, and is not appended twice.
      expect(bodies[2]).toEqual(bodies[1]);
      expect(bodies[2]!.messages).toHaveLength(bodies[0]!.messages.length + 1);
      expect(result.turns).toHaveLength(1);
      expect(result.turns?.[0]).toMatchObject(counters);
      expect(result.executionLease).toMatchObject({
        providerTurns: 1,
        terminalReason: "completed",
      });
      expect(result.executionLease?.cumulativeOutputTokens).toBe(cumulativeOutputTokens);
    },
  );

  it("names the shape and the limit when the nudged replay is cut the same way", async () => {
    const repositoryPath = await createRepository();
    const provider = vi.fn(
      scriptedProvider([blankTurn("length", LIVE_CUT_USAGE), blankTurn("length", LIVE_CUT_USAGE)]),
    );
    vi.stubGlobal("fetch", provider);
    const harness = await createInstantReplayAuditHarness();

    const error = await captureInferenceFailure(harness, stepInput(repositoryPath));

    // Exactly one nudged replay, not the three-attempt bound: the second cut
    // is the model answering the nudge the same way.
    expect(provider).toHaveBeenCalledTimes(2);
    expect(error.message).toContain(
      `Provider turn failed: provider-failed: output-truncated: 2 provider turns of step audit-documentation hit the ${limit}-token output limit (finish_reason=length), last turn consumed 8,192 output tokens, no text or tool call surfaced`,
    );
    expect(error.message).not.toContain("blank provider turn");
    expect(error.category).toBe("malformed-response");
    // The cut is the `cut-answer` condition; the retry rule decides, not the harness.
    expect(error.retryable).toBe(true);
    expect(error.condition).toBe("cut-answer");
    expect(error.evidence?.turns?.[0]).toMatchObject({ providerRetries: 1, providerBlankTurns: 2 });
    expect(error.evidence?.executionLease).toMatchObject({
      providerTurns: 1,
      terminalReason: "provider-terminal",
      terminalDisposition: "provider-failed",
    });
    // Both cuts charged.
    expect(error.evidence?.executionLease?.cumulativeOutputTokens).toBe(2 * 8_192);
  });

  it("keeps a terminal answer cut mid-text and refuses to accept it as complete", async () => {
    const repositoryPath = await createRepository();
    const partial = "# Documentation audit\n\n## Findings\n\n1. The README's install section";
    const provider = vi.fn(
      scriptedProvider([textTurn(partial, validModelConfig.modelId, "length")]),
    );
    vi.stubGlobal("fetch", provider);
    const harness = await createInstantReplayAuditHarness();

    const error = await captureInferenceFailure(harness, stepInput(repositoryPath));

    // Not replayed: the text was published as it streamed, and a second
    // message behind half of a first one is corruption, not a retry.
    expect(provider).toHaveBeenCalledTimes(1);
    expect(error.message).toContain(
      `Provider turn failed: provider-failed: text-truncated: step audit-documentation answer cut at the ${limit}-token output limit (finish_reason=length) after ${partial.length} characters, last turn consumed 5 output tokens`,
    );
    expect(error.message).toContain("not accepted as complete");
    expect(error.category).toBe("malformed-response");
    // The cut is the `cut-answer` condition; the retry rule decides, not the harness.
    expect(error.retryable).toBe(true);
    expect(error.condition).toBe("cut-answer");
    expect(error.evidence?.turns?.[0]?.providerRetries).toBeUndefined();
    expect(error.evidence?.turns?.[0]?.providerBlankTurns).toBeUndefined();
    expect(error.evidence?.executionLease).toMatchObject({
      providerTurns: 1,
      terminalDisposition: "provider-failed",
    });
  });

  it("lets Pi re-issue a streamed truncated tool call once under an explicit two-turn allowance", async () => {
    vi.stubEnv("DOCSFAB_GOVERNANCE_MAX_LENGTH_STOPPED_TOOL_TURNS", "2");
    const repositoryPath = await createRepository();
    const cut = (created: number) =>
      toolTurn(
        [{ id: `call-${created}`, name: "read", arguments: { path: "README.md" } }],
        created,
        "length",
        LIVE_CUT_USAGE,
      );
    const provider = vi.fn(scriptedProvider([cut(1), cut(2), textTurn("never reached")]));
    vi.stubGlobal("fetch", provider);
    const harness = await createInstantReplayAuditHarness();

    const error = await captureInferenceFailure(harness, stepInput(repositoryPath));

    // Turn 1: Pi refuses the cut batch and asks for a re-issue (charged, no
    // call executed). Turn 2: the same cut again -- named, not paid a third time.
    expect(provider).toHaveBeenCalledTimes(2);
    expect(error.message).toContain(
      `Tool-batch provider turn failed: provider-failed: tool-arguments-truncated: 2 consecutive provider turns of step audit-documentation hit the ${limit}-token output limit (finish_reason=length) with truncated tool arguments, last turn consumed 8,192 output tokens`,
    );
    expect(error.category).toBe("malformed-response");
    expect(error.retryable).toBe(false);
    // The cut is coded, and the attempt telemetry says it was the limit.
    expect(error.rejection).toEqual({ code: "tool-arguments-truncated", location: "$response" });
    expect(error.evidence?.modelTelemetry).toMatchObject({
      finishReason: "length",
      outputTokens: 8_192,
    });
    expect(error.evidence?.executionLease).toMatchObject({
      providerTurns: 2,
      terminalReason: "provider-terminal",
      terminalDisposition: "provider-failed",
      toolCalls: { requested: 0, executed: 0, succeeded: 0, failed: 0 },
    });
  });
});
