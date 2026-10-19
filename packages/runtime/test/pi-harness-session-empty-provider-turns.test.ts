// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PiHarness,
  blankTurn,
  captureInferenceFailure,
  createAuditHarness,
  createInstantReplayAuditHarness,
  createRepository,
  expectDecodedAttemptEvidence,
  grantedTurnOutputTokens,
  hubUnavailableResponse,
  resetSharedTestState,
  scriptedProvider,
  stepInput,
  textTurn,
} from "./support/pi-harness-session-fixtures.js";

afterEach(resetSharedTestState);

/**
 * A single empty assistant turn from the provider is replayed within the turn
 * rather than treated as terminal.
 */
describe("PiHarness empty provider turns", () => {
  it("charges one held blank turn once when cancellation interrupts its backoff", async () => {
    const repositoryPath = await createRepository();
    const controller = new AbortController();
    const provider = vi.fn(scriptedProvider([blankTurn()]));
    vi.stubGlobal("fetch", provider);
    const harness = await createAuditHarness();

    const pending = captureInferenceFailure(harness, {
      ...stepInput(repositoryPath),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(provider).toHaveBeenCalledOnce());
    controller.abort();
    const error = await pending;

    expect(provider).toHaveBeenCalledOnce();
    expect(error.message).toContain("Workflow cancelled by user.");
    expect(error.evidence?.turns).toHaveLength(1);
    expect(error.evidence?.turns?.[0]).toMatchObject({ providerBlankTurns: 1 });
    expect(error.evidence?.turns?.[0]?.providerRetries).toBeUndefined();
    expect(error.evidence?.executionLease).toMatchObject({
      providerTurns: 1,
      cumulativeInputTokens: 700,
      terminalDisposition: "cancelled",
    });
  });

  it("replays an empty provider turn and finishes the step", async () => {
    const repositoryPath = await createRepository();
    const provider = vi.fn(scriptedProvider([blankTurn(), textTurn("The review is complete.")]));
    vi.stubGlobal("fetch", provider);
    const harness = await createInstantReplayAuditHarness();

    const result = await harness.runStep(stepInput(repositoryPath));

    expect(result.summary).toBe("The review is complete.");
    expect(provider).toHaveBeenCalledTimes(2);
    // One governed turn: the replay is the same request, not a second turn.
    expect(result.turns).toHaveLength(1);
    expect(result.turns?.[0]).toMatchObject({ providerRetries: 1, providerBlankTurns: 1 });
    expect(result.executionLease).toMatchObject({
      providerTurns: 1,
      terminalReason: "completed",
    });
    // The discarded attempt cost 700 input tokens at the provider; the landed
    // turn cost 10. A lease that charges only 10 has lost the replay's cost.
    expect(result.executionLease?.cumulativeInputTokens).toBe(710);
  });

  it("fails with the empty-turn streak once the replay budget is spent", async () => {
    const repositoryPath = await createRepository();
    const provider = vi.fn(scriptedProvider([blankTurn(), blankTurn(), blankTurn()]));
    vi.stubGlobal("fetch", provider);
    const harness = await createInstantReplayAuditHarness();

    const error = await captureInferenceFailure(harness, stepInput(repositoryPath));

    // Bounded at the runtime's three attempts.
    expect(provider).toHaveBeenCalledTimes(3);
    expect(error.message).toContain("3 blank provider turns");
    expect(error.message).toContain("stopReason=stop finish_reason=stop");
    expect(error.category).toBe("provider-terminal");
    expect(error.retryable).toBe(false);
    expect(error.evidence?.turns?.[0]).toMatchObject({
      providerRetries: 2,
      providerBlankTurns: 3,
    });
    expect(error.evidence?.executionLease).toMatchObject({
      providerTurns: 1,
      terminalDisposition: "blank",
    });
    // Two discarded attempts at 700 plus the terminal one: all three charged.
    expect(error.evidence?.executionLease?.cumulativeInputTokens).toBe(2_100);
  });

  it("keeps a hub 503 retryable after the in-turn replay is spent", async () => {
    // After the transport's replays, the step-level classifier must not read
    // DocsFab's own composed sentence as a terminal failure: an unavailable
    // route is transient.
    const repositoryPath = await createRepository();
    const provider = vi.fn(async () => hubUnavailableResponse());
    vi.stubGlobal("fetch", provider);
    const harness = await createInstantReplayAuditHarness();

    const error = await captureInferenceFailure(harness, stepInput(repositoryPath));

    // The transport window is eight attempts; the exhausted burst is named and
    // retryable at the step level.
    expect(provider).toHaveBeenCalledTimes(8);
    expect(error.category).toBe("provider-transient");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("provider-transient; retryable=true");
    expect(error.message).toContain("8 provider attempts");
    expect(error.message).toContain("litellm.ServiceUnavailableError");
    expect(error.evidence?.turns?.[0]?.providerRetries).toBe(7);
    expect(error.evidence?.turns?.[0]?.outputTokens).toBeUndefined();
    expect(error.evidence?.turns?.[0]?.outputTokens).not.toBe(
      grantedTurnOutputTokens(error.evidence!.turns![0]!),
    );
    // The lease still terminalizes on the failed attempt; the step-level
    // verdict decides whether the workflow may try again.
    expect(error.evidence?.executionLease).toMatchObject({
      terminalReason: "provider-terminal",
      terminalDisposition: "provider-failed",
    });
    expectDecodedAttemptEvidence(error.evidence ?? {}, "provider-transient", true);
  });
});
