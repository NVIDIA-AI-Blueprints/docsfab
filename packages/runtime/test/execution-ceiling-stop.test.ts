// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The shape a host stop at the hard tool-call ceiling leaves on an attempt,
 * and the catalog-derived code sets diagnosis reads. Record decoders admit the
 * `tool-call-ceiling` condition on a `no-progress` attempt only in this shape.
 */
import { describe, expect, it } from "vitest";

import {
  attemptEndedAtToolCallCeiling,
  READ_LOOP_STOP_CODES,
  STEP_EXECUTION_CEILING_CODES,
} from "../src/config/execution-limit-stops.js";
import { stepExecutionCeilingSource } from "../src/config/execution-ceiling-source.js";
import { limitDefinition } from "../src/config/limits.js";
import { stepFailureMessage } from "../src/workflow-execution/runner-step.js";

const CEILING = 126;
const lease = {
  terminalReason: "hard-tool-call-ceiling",
  terminalDisposition: "budget-stopped",
  providerTurns: 26,
  toolCalls: { executed: CEILING },
};
const lastTurn = { decision: "proceed", maxToolCalls: CEILING, maxProviderTurns: 128 } as const;

describe("attemptEndedAtToolCallCeiling", () => {
  it("admits the host stop at the ceiling the last turn records", () => {
    expect(attemptEndedAtToolCallCeiling(lease, lastTurn)).toBe(true);
  });

  it("refuses every adjacent shape", () => {
    // Another disposition, a lease reason that is not the tool ceiling, a
    // provider-turn stop, a count below the ceiling, a governor stop turn, and
    // no lease at all.
    for (const [label, candidate, turn] of [
      ["disposition", { ...lease, terminalDisposition: "progress-stopped" }, lastTurn],
      ["reason", { ...lease, terminalReason: "checkpoint-not-renewable" }, lastTurn],
      ["provider turns", { ...lease, terminalReason: "provider-turn-limit" }, lastTurn],
      ["below", { ...lease, toolCalls: { executed: CEILING - 1 } }, lastTurn],
      ["governor stop", lease, { ...lastTurn, decision: "stop" }],
      ["no lease", undefined, lastTurn],
    ] as const) {
      expect(attemptEndedAtToolCallCeiling(candidate, turn), label).toBe(false);
    }
  });
});

describe("progress stop code sets", () => {
  it("are the catalog refusals of the read-loop and ceiling limits", () => {
    expect([...READ_LOOP_STOP_CODES].sort()).toEqual([
      limitDefinition("execution.readLoopUnchangedReReads").refusal,
      limitDefinition("execution.readLoopWithheldReads").refusal,
    ]);
    expect(Object.fromEntries(STEP_EXECUTION_CEILING_CODES)).toEqual({
      [limitDefinition("compositionExecution.maxToolCallsPerStep").refusal]: "tool-calls",
      [limitDefinition("compositionExecution.maxProviderTurns").refusal]: "provider-turns",
      [limitDefinition("sealed.compositionLimits.maxProviderTurns").refusal]: "provider-turns",
    });
  });
});

describe("stepFailureMessage at the hard tool-call ceiling", () => {
  const step = {
    id: "review-documentation",
    failure: { code: "composition-execution-max-tool-calls-per-step-bound" },
    inference: {
      attempts: [
        {
          executionLease: { ...lease, providerTurns: 126 },
          turns: [{ ...lastTurn }],
        },
      ],
    },
  };
  const line = `composition-execution-max-tool-calls-per-step-bound: workflow step "review-documentation" used all of its tool-call ceiling of ${CEILING} calls (observed ${CEILING} calls).`;

  it("names the ceiling once when the host's stop already wrote it", () => {
    const hostMessage = stepFailureMessage("placeholder", step);
    expect(hostMessage.startsWith(`placeholder ${line}`)).toBe(true);
    const fromHost = `Model request failed [no-progress; retryable=true]: ${hostMessage.slice("placeholder ".length)}`;
    expect(stepFailureMessage(fromHost, step)).toBe(fromHost);
    expect(stepFailureMessage(fromHost, step).split(line)).toHaveLength(2);
  });
});

describe("stepExecutionCeilingSource", () => {
  const catalog = (name: string) => limitDefinition(name).value;
  const hostTurns = catalog("compositionExecution.maxProviderTurns");
  const toolCeiling = catalog("compositionExecution.maxToolCallsPerStep");
  /** A sealed 128-turn composition on a host at its catalog value. */
  const sealed128 = { configured: hostTurns, sealed: 128 };
  /** The same composition on a host whose override lowered the limit to 64. */
  const override64 = { configured: 64, sealed: 128 };

  it("reads what set each ceiling from the recorded limits and the catalog", () => {
    const cases = [
      // The tool-call ceiling the catalog lease shape fits to the sealed budget.
      [
        { ceiling: "tool-calls", configured: 126, providerTurnBudget: 128 },
        sealed128,
        "sealed-budget",
      ],
      // Lower than that fit: an override lowered the tool-call ceiling.
      [
        { ceiling: "tool-calls", configured: 50, providerTurnBudget: 128 },
        sealed128,
        "operator-override",
      ],
      [{ ceiling: "tool-calls", configured: 50 }, sealed128, "operator-override"],
      // Fitted to the run host's configured value, which an override lowered.
      [
        { ceiling: "tool-calls", configured: 63, providerTurnBudget: 64 },
        override64,
        "operator-override",
      ],
      [
        { ceiling: "tool-calls", configured: toolCeiling, providerTurnBudget: hostTurns },
        undefined,
        "host-limit",
      ],
      [{ ceiling: "provider-turns", configured: 128 }, sealed128, "sealed-budget"],
      [{ ceiling: "provider-turns", configured: 64 }, override64, "operator-override"],
      [
        { ceiling: "provider-turns", configured: hostTurns },
        { configured: hostTurns, sealed: hostTurns + 1 },
        "host-limit",
      ],
      // Without the recorded limits a sealed budget and an override look alike.
      [{ ceiling: "provider-turns", configured: 128 }, undefined, "limits-not-recorded"],
      [
        { ceiling: "tool-calls", configured: 126, providerTurnBudget: 128 },
        undefined,
        "limits-not-recorded",
      ],
      // A budget the recorded limits do not explain.
      [{ ceiling: "provider-turns", configured: 100 }, sealed128, "codes-mismatch"],
      [
        { ceiling: "compactions", configured: catalog("governance.maxCompactions") },
        undefined,
        "host-limit",
      ],
      [{ ceiling: "compactions", configured: 1 }, undefined, "operator-override"],
    ] as const;
    for (const [stop, recorded, source] of cases) {
      expect(stepExecutionCeilingSource(stop, recorded), JSON.stringify(stop)).toBe(source);
    }
  });
});
