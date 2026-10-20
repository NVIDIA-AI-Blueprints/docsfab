// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { HarnessStepResult, InferenceRetryPolicy } from "../src/execution/contracts.js";
import type { InferenceFailureCategory, InferenceTurnEvidence } from "../src/records/contracts.js";
import { InferenceStepError } from "../src/execution/contracts.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import { remainingRetryBudget } from "../src/records/inference-retry-disposition.js";

const retryableCategories: InferenceFailureCategory[] = [
  "blank-response",
  "malformed-response",
  "timeout",
  "throttled",
  "provider-transient",
];

const policy: InferenceRetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 100,
  maxDelayMs: 150,
  retryableCategories,
};

const success: HarnessStepResult = { summary: "ready" };

function turn(
  turnNumber: number,
  decision: InferenceTurnEvidence["decision"] = "proceed",
  reason?: InferenceTurnEvidence["reason"],
): InferenceTurnEvidence {
  return {
    turn: turnNumber,
    toolCalls: turnNumber - 1,
    toolResults: turnNumber - 1,
    maxProviderTurns: 8,
    maxToolCalls: 16,
    compactions: 0,
    maxCompactions: 1,
    configuredContextWindow: 128_000,
    effectiveContextWindow: 8_192,
    configuredMaxOutputTokens: 16_384,
    effectiveMaxOutputTokens: 4_096,
    reservedTokens: 4_096,
    estimatedInputTokens: 2_000 + turnNumber,
    availableOutputTokens: 2_096 - turnNumber,
    requiredMinimumOutputTokens: 16,
    ...(decision === "stop" ? {} : { outputTokens: 2_096 - turnNumber }),
    decision,
    ...(reason ? { reason } : {}),
    requestDigest: String(turnNumber).repeat(64),
    evidenceDigest: "e".repeat(64),
  };
}

function failure(category: InferenceFailureCategory, retryable: boolean): InferenceStepError {
  return new InferenceStepError(`failed as ${category}`, category, retryable);
}

describe("executeInferenceStep", () => {
  it("retains content-free request diagnostics on a failed attempt", async () => {
    const efficiency = {
      schemaVersion: 1 as const,
      requests: [{ requestSequence: 1, turn: 1, bodyBytes: 123, bodySha256: "e".repeat(64) }],
      sourceReuse: null,
    };
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy: { ...policy, maxRetries: 0 },
      execute: async () => {
        throw new InferenceStepError("response refused", "malformed-response", false, {
          efficiency,
        });
      },
    });

    expect(execution.status).toBe("failed");
    expect(execution.evidence.attempts[0]?.efficiency).toEqual(efficiency);
  });

  it("keeps actual reply accounting and rejection when cancellation stops the attempt", async () => {
    const controller = new AbortController();
    const evidence = {
      model: { provider: "offline", model: "fixture" },
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, turns: 1 },
      turns: [turn(1)],
    };
    const rejection = { code: "quality-envelope-json", location: "$.evaluation" };
    const actual = new InferenceStepError(
      "A typed reply refusal.",
      "malformed-response",
      true,
      evidence,
      rejection,
    );
    let calls = 0;
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy,
      signal: controller.signal,
      sleep: async () => {
        throw new Error("Cancellation must not schedule a retry.");
      },
      execute: async () => {
        calls += 1;
        controller.abort();
        throw actual;
      },
    });
    expect(execution.status).toBe("failed");
    if (execution.status !== "failed") throw new Error("Cancellation unexpectedly succeeded.");
    expect(execution.error.message).toBe("Workflow cancelled by user.");
    expect(calls).toBe(1);
    expect(execution.evidence.attempts).toEqual([
      expect.objectContaining({
        outcome: "provider-terminal",
        retryable: false,
        retryScheduled: false,
        rejection,
        ...evidence,
      }),
    ]);
    expect(execution.evidence.attempts[0]?.condition).toBeUndefined();
  });

  it.each([
    [{ code: "json-unexpected-end", location: "$response" }, "json-unexpected-end"],
    [{ code: "inventory-fact-locators", location: "$.factInventory" }, "inventory-fact-locators"],
    [{ code: "editorial-envelope-shape", location: "$" }, "editorial-envelope-shape"],
    [{ code: "unknown-private-code", location: "$response" }, "unknown-private-code"],
    // Off-grammar reasons reach the retry only as the host placeholder.
    [{ code: "private response text", location: "$response" }, "unretainable-reason-off-grammar"],
  ])("passes the bounded retry the coded rejection %j", async (rejection, code) => {
    const received: unknown[] = [];
    const result = await executeInferenceStep({
      mode: "read-only",
      policy: { ...policy, maxRetries: 1 },
      sleep: async () => {},
      execute: async (attempt, feedback) => {
        received.push(feedback);
        if (attempt === 1)
          throw new InferenceStepError(
            "private response must not be forwarded",
            "malformed-response",
            true,
            undefined,
            rejection,
          );
        return success;
      },
    });
    expect(result.status).toBe("succeeded");
    expect(received[0]).toBeUndefined();
    expect(received[1]).toEqual({
      rejection: { code, location: code === rejection.code ? rejection.location : "$response" },
    });
    expect(JSON.stringify(received)).not.toContain("private response");
    expect(result.evidence.attempts).toHaveLength(2);
  });

  it("passes an empty correction when the refusing decoder recorded no reason", async () => {
    const received: unknown[] = [];
    await executeInferenceStep({
      mode: "read-only",
      policy: { ...policy, maxRetries: 1 },
      sleep: async () => {},
      execute: async (attempt, feedback) => {
        received.push(feedback);
        if (attempt === 1)
          throw new InferenceStepError("private response text", "malformed-response", true);
        return success;
      },
    });
    expect(received).toEqual([undefined, {}]);
  });

  it("fails an unparsed literal tool call instead of recording success", async () => {
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy,
      execute: async () => ({
        summary: '<tool_call><function=find>{"pattern":"title"}</function></tool_call>',
      }),
    });

    expect(execution.status).toBe("failed");
    if (execution.status !== "failed") throw new Error("expected failed execution");
    expect(execution.error).toMatchObject({
      category: "malformed-response",
      retryable: true,
    });
    expect(execution.evidence.attempts.at(-1)).toMatchObject({
      outcome: "malformed-response",
      retryScheduled: false,
    });
  });

  it("fails when a step reports that its requested skill is unavailable", async () => {
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy,
      execute: async () => ({
        summary: "The requested skill is not available in this repository.",
      }),
    });

    expect(execution.status).toBe("failed");
    if (execution.status !== "failed") throw new Error("expected failed execution");
    expect(execution.error).toMatchObject({
      category: "provider-terminal",
      retryable: false,
    });
    expect(execution.evidence.attempts).toMatchObject([
      {
        outcome: "provider-terminal",
        retryScheduled: false,
      },
    ]);
  });

  it("retries configured read-only failures with capped exponential backoff", async () => {
    const outcomes: Array<InferenceStepError | HarnessStepResult> = [
      failure("throttled", true),
      failure("timeout", true),
      success,
    ];
    const delays: number[] = [];
    let calls = 0;
    let clock = 0;
    const execution = await executeInferenceStep({
      mode: "read-only",
      // `timeout` has its own, smaller budget, which defaults to declining it.
      // The backoff schedule under test is the same for every retried class, so
      // this policy grants the timeout the same budget the other classes have
      // rather than swapping the class out of the case.
      policy: { ...policy, maxTimeoutRetries: policy.maxRetries },
      now: () => {
        clock += 10;
        return clock;
      },
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      execute: async () => {
        const outcome = outcomes[calls++];
        if (outcome instanceof Error) throw outcome;
        if (!outcome) throw new Error("Missing scripted outcome.");
        return outcome;
      },
    });

    expect(execution.status).toBe("succeeded");
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 150]);
    expect(execution.evidence).toMatchObject({
      configuredMaxRetries: 2,
      effectiveMaxRetries: 2,
      replay: "read-only",
      attempts: [
        {
          attempt: 1,
          outcome: "throttled",
          retryable: true,
          retryScheduled: true,
          durationMs: 10,
          backoffMs: 100,
        },
        {
          attempt: 2,
          outcome: "timeout",
          retryable: true,
          retryScheduled: true,
          durationMs: 10,
          backoffMs: 150,
        },
        {
          attempt: 3,
          outcome: "succeeded",
          retryable: false,
          retryScheduled: false,
          durationMs: 10,
        },
      ],
    });
  });

  it.each([
    ["invalid-request", false],
    ["context-exhausted", false],
    ["provider-terminal", false],
  ] as const)("does not retry terminal %s failures", async (category, retryable) => {
    let calls = 0;
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy,
      sleep: async () => {
        throw new Error("sleep must not run");
      },
      execute: async () => {
        calls += 1;
        throw failure(category, retryable);
      },
    });

    expect(execution.status).toBe("failed");
    expect(calls).toBe(1);
    expect(execution.evidence.attempts).toMatchObject([
      { outcome: category, retryable: false, retryScheduled: false },
    ]);
  });

  it("honors the configured retryable-category allowlist", async () => {
    let calls = 0;
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy: { ...policy, retryableCategories: ["timeout"] },
      execute: async () => {
        calls += 1;
        throw failure("throttled", true);
      },
    });

    expect(execution.status).toBe("failed");
    expect(calls).toBe(1);
    expect(execution.evidence.attempts[0]).toMatchObject({
      outcome: "throttled",
      retryable: true,
      retryScheduled: false,
    });
  });

  it("stops exactly at the configured retry bound", async () => {
    let calls = 0;
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy: { ...policy, maxRetries: 1 },
      sleep: async () => undefined,
      execute: async () => {
        calls += 1;
        throw failure("provider-transient", true);
      },
    });

    expect(execution.status).toBe("failed");
    expect(calls).toBe(2);
    expect(execution.evidence.attempts).toMatchObject([
      { attempt: 1, retryable: true, retryScheduled: true },
      { attempt: 2, retryable: true, retryScheduled: false },
    ]);
  });

  it.each([
    ["blank-response", { summary: "   " }],
    ["malformed-response", {}],
  ] as const)("distinguishes and retries %s", async (category, firstResult) => {
    let calls = 0;
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy,
      sleep: async () => undefined,
      execute: async () => {
        calls += 1;
        return calls === 1 ? (firstResult as HarnessStepResult) : success;
      },
    });

    expect(execution.status).toBe("succeeded");
    expect(execution.evidence.attempts.map((attempt) => attempt.outcome)).toEqual([
      category,
      "succeeded",
    ]);
  });

  it("never replays a write step", async () => {
    let mutations = 0;
    const execution = await executeInferenceStep({
      mode: "write",
      policy,
      sleep: async () => {
        throw new Error("sleep must not run");
      },
      execute: async () => {
        mutations += 1;
        throw failure("throttled", true);
      },
    });

    expect(execution.status).toBe("failed");
    expect(mutations).toBe(1);
    expect(execution.evidence).toMatchObject({
      configuredMaxRetries: 2,
      effectiveMaxRetries: 0,
      replay: "disabled-write-step",
      attempts: [
        {
          outcome: "throttled",
          retryable: true,
          retryScheduled: false,
        },
      ],
    });
  });

  it("replays a host-reset write step only for a retryable malformed reply (#1266)", async () => {
    const rejection = {
      code: "revision-accounting-changed-path-mismatch",
      location: "$.changedPaths",
    };
    const corrections: unknown[] = [];
    const replayed = await executeInferenceStep({
      mode: "write",
      hostResetsWrites: true,
      policy,
      sleep: async () => undefined,
      execute: async (attempt, correction) => {
        corrections.push(correction);
        if (attempt === 1) {
          throw new InferenceStepError(
            "coded refusal",
            "malformed-response",
            true,
            undefined,
            rejection,
          );
        }
        return success;
      },
    });

    expect(replayed.status).toBe("succeeded");
    expect(corrections).toEqual([undefined, { rejection }]);
    expect(replayed.evidence).toMatchObject({
      configuredMaxRetries: 2,
      effectiveMaxRetries: 2,
      replay: "reset-write-step",
      retryableCategories,
      attempts: [
        {
          outcome: "malformed-response",
          retryable: true,
          retryScheduled: true,
          retryDecision: "retried",
          rejection,
        },
        { outcome: "succeeded" },
      ],
    });

    for (const [category, retryable] of [
      ["throttled", true],
      ["malformed-response", false],
    ] as const) {
      let mutations = 0;
      const declined = await executeInferenceStep({
        mode: "write",
        hostResetsWrites: true,
        policy,
        sleep: async () => {
          throw new Error("sleep must not run");
        },
        execute: async () => {
          mutations += 1;
          throw failure(category, retryable);
        },
      });
      expect(declined.status, category).toBe("failed");
      expect(mutations, category).toBe(1);
      expect(declined.evidence.attempts, category).toMatchObject([
        { outcome: category, retryScheduled: false, retryDecision: "declined" },
      ]);
    }
  });

  it("retains content-free turn ledgers and evidence identity for failed and successful attempts", async () => {
    let calls = 0;
    const identity = {
      repositoryRevision: "revision-1",
      contextPacketDigest: "c".repeat(64),
      consultedNodeIds: ["node-a", "node-b"],
    };
    const failedTurns = [turn(1)];
    const successfulTurns = [turn(1), turn(2, "compact")];
    successfulTurns[1]!.compaction = {
      beforeRequestDigest: "1".repeat(64),
      afterRequestDigest: "2".repeat(64),
      estimatedInputTokensBefore: 6_000,
      estimatedInputTokensAfter: 3_000,
      removedMessages: 4,
      retainedMessages: 3,
      preservedCitationCount: 2,
      preservedCitationDigest: "3".repeat(64),
    };

    const execution = await executeInferenceStep({
      mode: "read-only",
      policy: { ...policy, maxRetries: 1, retryableCategories: ["throttled"] },
      evidenceIdentity: identity,
      sleep: async () => undefined,
      execute: async () => {
        calls += 1;
        if (calls === 1) {
          throw new InferenceStepError("provider throttled", "throttled", true, {
            turns: failedTurns,
          });
        }
        return { summary: "ready", turns: successfulTurns };
      },
    });

    expect(execution.status).toBe("succeeded");
    expect(execution.evidence.attempts).toMatchObject([
      {
        attempt: 1,
        outcome: "throttled",
        identity,
        turns: failedTurns,
      },
      {
        attempt: 2,
        outcome: "succeeded",
        identity,
        turns: successfulTurns,
      },
    ]);
  });

  it("never retries context exhaustion even when policy and caller mark it retryable", async () => {
    let calls = 0;
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy: {
        ...policy,
        retryableCategories: ["context-exhausted"],
      },
      sleep: async () => {
        throw new Error("context exhaustion must not schedule sleep");
      },
      execute: async () => {
        calls += 1;
        throw new InferenceStepError("local context exhausted", "context-exhausted", true, {
          turns: [turn(1, "stop", "context-exhausted")],
        });
      },
    });

    expect(execution.status).toBe("failed");
    expect(calls).toBe(1);
    expect(execution.evidence.attempts).toMatchObject([
      {
        outcome: "context-exhausted",
        retryable: false,
        retryScheduled: false,
        turns: [{ decision: "stop", reason: "context-exhausted" }],
      },
    ]);
  });

  it("retries a retryable source-obligation malformed-response and not a terminal authority rejection", async () => {
    const sourceObligationMessage =
      "Source-obligation response did not satisfy the host-owned contract.";
    let retryableCalls = 0;
    const retried = await executeInferenceStep({
      mode: "read-only",
      policy: { ...policy, maxRetries: 1 },
      sleep: async () => undefined,
      execute: async () => {
        retryableCalls += 1;
        throw new InferenceStepError(sourceObligationMessage, "malformed-response", true);
      },
    });
    expect(retried.status).toBe("failed");
    expect(retryableCalls).toBe(2);
    if (retried.status !== "failed") throw new Error("expected failed retryable decode");
    expect(retried.error).toMatchObject({
      message: sourceObligationMessage,
      category: "malformed-response",
      retryable: true,
    });
    expect(retried.evidence).toMatchObject({
      configuredMaxRetries: 1,
      effectiveMaxRetries: 1,
      attempts: [
        { attempt: 1, outcome: "malformed-response", retryable: true, retryScheduled: true },
        { attempt: 2, outcome: "malformed-response", retryable: true, retryScheduled: false },
      ],
    });

    let terminalCalls = 0;
    const terminal = await executeInferenceStep({
      mode: "read-only",
      policy: { ...policy, maxRetries: 1 },
      sleep: async () => {
        throw new Error("terminal authority rejection must not schedule sleep");
      },
      execute: async () => {
        terminalCalls += 1;
        throw new InferenceStepError(
          "Source-obligation evidence cites a path outside the original source authority.",
          "malformed-response",
          false,
        );
      },
    });
    expect(terminal.status).toBe("failed");
    expect(terminalCalls).toBe(1);
    if (terminal.status !== "failed") throw new Error("expected failed terminal authority");
    expect(terminal.evidence.attempts).toMatchObject([
      {
        attempt: 1,
        outcome: "malformed-response",
        retryable: false,
        retryScheduled: false,
      },
    ]);
  });

  it("records an eligible host-refused malformed-response as declined with unspent retries", async () => {
    let calls = 0;
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy: { ...policy, maxRetries: 3 },
      sleep: async () => {
        throw new Error("eligible host refusal must not schedule sleep");
      },
      execute: async () => {
        calls += 1;
        throw failure("malformed-response", false);
      },
    });

    expect(execution.status).toBe("failed");
    expect(calls).toBe(1);
    expect(execution.evidence).toMatchObject({
      configuredMaxRetries: 3,
      effectiveMaxRetries: 3,
      attempts: [
        {
          attempt: 1,
          outcome: "malformed-response",
          conditionRetryability: "eligible",
          retryable: false,
          retryDecision: "declined",
          retryScheduled: false,
        },
      ],
    });
    expect(
      remainingRetryBudget({
        attempt: 1,
        effectiveMaxRetries: execution.evidence.effectiveMaxRetries,
        retryScheduled: false,
      }),
    ).toBe(3);
  });
});
