// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The host's own attempt timer and a provider timeout are different
 * conditions (#1733, asked by #1735): the harness marks the first
 * `attempt-deadline`, so the attempt record names which timer fired.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { testTimeoutMs } from "./helpers/test-timeouts.js";
import {
  captureInferenceFailure,
  createProviderConnectionFactory,
  createRepository,
  fixtureCompositionExecutionProfile,
  PiHarness,
  resetSharedTestState,
  skillCrateDirectory,
  stepInput,
  validModelConfig,
} from "./support/pi-harness-session-fixtures.js";

afterEach(() => {
  vi.useRealTimers();
  resetSharedTestState();
});

/** A real Pi session start-up; the attempt timer runs on a fake clock. */
const SESSION = testTimeoutMs(20_000);

/** Longer than any start-up step the fake clock drives before the request is sent. */
const ATTEMPT_TIMER_MS = 60_000;

/** A provider that never answers until the request is aborted. */
function silentProvider() {
  const fetchMock = vi.fn(
    (_request: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => reject(signal?.reason ?? new Error("aborted"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function harnessWithAttemptTimer(timeoutMs: number): PiHarness {
  const executionProfile = fixtureCompositionExecutionProfile({
    maxProviderTurns: 4,
    timeoutMs,
    maxResponseBytes: 65_536,
  });
  return new PiHarness({
    skillCrateDirectory,
    executionProfile,
    credential: { family: "nvidia-inference-api", apiKey: validModelConfig.apiKey },
    providerConnectionFactory: createProviderConnectionFactory({
      routeId: executionProfile.routeId,
      transport: executionProfile.transport,
    }),
  });
}

describe("an attempt the host timer ends", () => {
  it(
    "is a timeout recorded with the attempt-deadline condition",
    async () => {
      const repositoryPath = await createRepository();
      const fetchMock = silentProvider();
      // The timer fires only once the request is in flight: the fake clock
      // steps until the provider is called, then runs out the attempt. On the
      // wall clock a loaded host could spend the whole timer before sending.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const failure = captureInferenceFailure(
        harnessWithAttemptTimer(ATTEMPT_TIMER_MS),
        stepInput(repositoryPath),
      );
      let stepped = 0;
      while (fetchMock.mock.calls.length === 0) {
        if ((stepped += 1) > ATTEMPT_TIMER_MS) throw new Error("the request was never sent");
        await vi.advanceTimersByTimeAsync(1);
      }
      await vi.advanceTimersByTimeAsync(ATTEMPT_TIMER_MS);
      const error = await failure;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(stepped).toBeLessThan(ATTEMPT_TIMER_MS);
      expect(error.category).toBe("timeout");
      expect(error.retryable).toBe(true);
      expect(error.condition).toBe("attempt-deadline");
    },
    SESSION,
  );
});
