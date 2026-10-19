// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { stepTruncationStop } from "../src/workflow-execution/runner-step.js";

const TOOL_CALL_CODE = "composition-execution-max-tool-calls-per-step-bound";
const SEALED_PROVIDER_TURN_CODE = "sealed-composition-execution-max-provider-turns-bound";

/**
 * Every case is built from `cleanStep()`, a step with nothing else wrong with
 * it, and then given exactly one defect, so no test passes because an
 * unrelated condition fired first. The positive control below proves the clean
 * fixture is clean.
 */
function cleanStep(overrides: {
  executed?: number;
  maxToolCalls?: number;
  governanceBlocked?: number;
  providerTurns?: number;
  maxProviderTurns?: number;
  turnCount?: number;
  omitLease?: boolean;
}) {
  const {
    executed = 10,
    maxToolCalls = 100,
    governanceBlocked = 0,
    providerTurns = 20,
    maxProviderTurns = 128,
    turnCount = 3,
    omitLease = false,
  } = overrides;
  return {
    inference: {
      attempts: [
        {
          ...(omitLease
            ? {}
            : {
                executionLease: {
                  providerTurns,
                  toolCalls: { executed, governanceBlocked },
                },
              }),
          turns: Array.from({ length: turnCount }, () => ({ maxProviderTurns, maxToolCalls })),
        },
      ],
    },
  };
}

describe("stepTruncationStop", () => {
  it("returns no reason for a step that finished inside every bound", () => {
    // Positive control: if this fails, every other case here is detecting the
    // fixture, not the defect.
    expect(stepTruncationStop(cleanStep({}))).toBeUndefined();
  });

  it("reports truncation when the step reached the hard tool-call ceiling", () => {
    expect(stepTruncationStop(cleanStep({ executed: 100, maxToolCalls: 100 }))).toMatchObject({
      code: TOOL_CALL_CODE,
      limit: "compositionExecution.maxToolCallsPerStep",
      unit: "calls",
      disposition: "stopped",
      configured: 100,
      observed: 100,
    });
  });

  it("reports truncation when the step consumed every provider turn allowed", () => {
    expect(
      stepTruncationStop(cleanStep({ providerTurns: 128, maxProviderTurns: 128, turnCount: 4 })),
    ).toMatchObject({
      // 128 is below the catalog's 512, so the sealed composition budget bound it.
      code: SEALED_PROVIDER_TURN_CODE,
      limit: "sealed.compositionLimits.maxProviderTurns",
      unit: "turns",
      configured: 128,
      observed: 128,
    });
  });

  it("does NOT fail a step whose parallel batch was blocked at a lease boundary", () => {
    // governanceBlocked is not a signal on its own. Blocked calls are charged
    // against the per-lease allowance, not the hard ceiling: with more than one
    // lease, a tool batch straddling a renewal has its suffix blocked, the lease
    // renews, and the step finishes normally. Failing that would break working
    // runs, a worse error than silence.
    expect(
      stepTruncationStop(cleanStep({ governanceBlocked: 3, executed: 25, maxToolCalls: 100 })),
    ).toBeUndefined();
  });

  it("still reports truncation when a block coincides with the hard ceiling", () => {
    // A block that really is terminal reaches the ceiling, so dropping the
    // standalone governanceBlocked signal loses no genuine detection.
    expect(
      stepTruncationStop(cleanStep({ governanceBlocked: 1, executed: 100, maxToolCalls: 100 }))
        ?.code,
    ).toBe(TOOL_CALL_CODE);
  });

  it("does not report truncation one call below the tool-call ceiling", () => {
    expect(stepTruncationStop(cleanStep({ executed: 99, maxToolCalls: 100 }))).toBeUndefined();
  });

  it("does not report truncation one turn below the provider-turn limit", () => {
    // The boundary matters: a run can use 63 of 64 turns, produce a document,
    // and complete. An off-by-one here fails legitimate work.
    expect(
      stepTruncationStop(cleanStep({ providerTurns: 127, maxProviderTurns: 128 })),
    ).toBeUndefined();
  });

  it("does not mistake an attempt that recorded no turns for an exhausted one", () => {
    // With no turn records there is no policy maximum to compare against, and
    // `executed >= undefined` must not coerce into a truncation claim.
    expect(
      stepTruncationStop(cleanStep({ executed: 0, providerTurns: 0, turnCount: 0 })),
    ).toBeUndefined();
  });

  it("returns no reason when the attempt carries no execution lease", () => {
    expect(stepTruncationStop(cleanStep({ omitLease: true }))).toBeUndefined();
  });

  it("ignores a superseded failed attempt when the retry succeeded", () => {
    // `attempts` accumulates every failed attempt a retry superseded, each with
    // its own lease evidence. Attempt 1 exhausts the ceiling and returns a
    // retryable blank-response; attempt 2 finishes in 7 calls. Reporting the
    // step as truncated would fail a run that succeeded inside its envelope,
    // the more expensive false positive.
    const step = {
      inference: {
        attempts: [
          {
            executionLease: {
              providerTurns: 40,
              toolCalls: { executed: 100, governanceBlocked: 0 },
            },
            turns: [{ maxProviderTurns: 128, maxToolCalls: 100 }],
          },
          {
            executionLease: { providerTurns: 9, toolCalls: { executed: 7, governanceBlocked: 0 } },
            turns: [{ maxProviderTurns: 128, maxToolCalls: 100 }],
          },
        ],
      },
    };
    expect(stepTruncationStop(step)).toBeUndefined();
  });

  it("still reports truncation when the LAST attempt is the exhausted one", () => {
    // The mirror of the case above: a first attempt that finished cleanly must
    // not mask a final attempt that was truncated. Together the two cases rule
    // out reading only the first or only the last attempt.
    const step = {
      inference: {
        attempts: [
          {
            executionLease: { providerTurns: 9, toolCalls: { executed: 7, governanceBlocked: 0 } },
            turns: [{ maxProviderTurns: 128, maxToolCalls: 100 }],
          },
          {
            executionLease: {
              providerTurns: 40,
              toolCalls: { executed: 100, governanceBlocked: 0 },
            },
            turns: [{ maxProviderTurns: 128, maxToolCalls: 100 }],
          },
        ],
      },
    };
    expect(stepTruncationStop(step)?.code).toBe(TOOL_CALL_CODE);
  });

  it("returns no reason for a step with no inference evidence at all", () => {
    expect(stepTruncationStop({})).toBeUndefined();
  });

  it("reproduces the three false successes recorded on 2026-08-26", () => {
    // Regression fixtures from the committed run records. All three reported
    // `status: "succeeded"` with no document; every step terminated at exactly
    // the 3-call ceiling and the lease still said `terminalReason: "completed"`.
    for (const model of ["nemotron-3-ultra", "qwen3-5-397b-a17b"]) {
      expect(
        stepTruncationStop(
          cleanStep({
            governanceBlocked: 1,
            executed: 3,
            maxToolCalls: 3,
            providerTurns: 2,
            maxProviderTurns: 4,
            turnCount: 2,
          }),
        )?.code,
        `${model} write-documentation step must not report success`,
      ).toBe(TOOL_CALL_CODE);
    }
    // nemotron-3-super-v3: nothing blocked, but all 4 provider turns consumed.
    expect(
      stepTruncationStop(
        cleanStep({
          governanceBlocked: 0,
          executed: 3,
          maxToolCalls: 3,
          providerTurns: 4,
          maxProviderTurns: 4,
          turnCount: 4,
        }),
      ),
    ).toBeDefined();
  });
});
