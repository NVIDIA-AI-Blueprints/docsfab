// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OVER_CUMULATIVE_INPUT_TOKENS,
  PiHarness,
  captureInferenceFailure,
  createAuditHarness,
  createRepository,
  expectLeaseToolConsistency,
  forgedTurnEndFailure,
  resetSharedTestState,
  scriptedProvider,
  stepInput,
  textTurn,
  toolTurn,
} from "./support/pi-harness-session-fixtures.js";

afterEach(resetSharedTestState);

describe("PiHarness turns whose tool calls never reach host preflight", () => {
  it("accounts for an all-rejected first turn without claiming lease execution", async () => {
    const repositoryPath = await createRepository();
    vi.stubGlobal(
      "fetch",
      scriptedProvider([
        toolTurn([{ id: "rejected-0", name: "no_such_tool", arguments: {} }], 1),
        textTurn("The documentation audit is complete."),
      ]),
    );
    const harness = await createAuditHarness();

    const result = await harness.runStep(stepInput(repositoryPath));

    expect(result.tools.totalCalls).toBe(0);
    expect(result.tools.preExecutionRejections?.count).toBe(1);
    expect(result.executionLease?.toolCalls.executed).toBe(0);
  });
  // The granted definitions are lowercase; any other name is unregistered and
  // Pi answers it before the host hook runs. These names are representative.
  it.each([
    ["a tool name that differs only in case", { id: "call-1", name: "Read" }],
    ["an excluded tool name", { id: "call-1", name: "bash" }],
  ])("charges and continues past %s", async (_label, call) => {
    const repositoryPath = await createRepository();
    vi.stubGlobal(
      "fetch",
      scriptedProvider([
        toolTurn([{ id: "call-0", name: "ls", arguments: { path: "." } }], 1),
        toolTurn([{ ...call, arguments: { path: "README.md" } }], 2),
        textTurn("The documentation audit is complete."),
      ]),
    );
    const harness = await createAuditHarness();

    const result = await harness.runStep(stepInput(repositoryPath));

    expect(result.summary).toBe("The documentation audit is complete.");
    expect(result.tools.preExecutionRejections).toEqual({
      schemaVersion: 1,
      kind: "tool-pre-execution-rejections",
      count: 1,
    });
    expect(result.executionLease).toMatchObject({
      phase: "terminal",
      terminalReason: "completed",
      // Nothing executed for the rejected call, so it does not enter the lease's
      // executed-call accounting; the turn itself is still charged.
      toolCalls: { requested: 1, executed: 1, succeeded: 1, failed: 0 },
      providerTurns: 3,
    });
  });

  it("charges and continues past a batch truncated by the output-token limit", async () => {
    const repositoryPath = await createRepository();
    vi.stubGlobal(
      "fetch",
      scriptedProvider([
        toolTurn([{ id: "call-0", name: "ls", arguments: { path: "." } }], 1),
        toolTurn([{ id: "call-1", name: "read", arguments: { path: "README.md" } }], 2, "length"),
        textTurn("The documentation audit is complete."),
      ]),
    );
    const harness = await createAuditHarness();

    const result = await harness.runStep(stepInput(repositoryPath));

    expect(result.summary).toBe("The documentation audit is complete.");
    expect(result.tools.preExecutionRejections).toEqual({
      schemaVersion: 1,
      kind: "tool-pre-execution-rejections",
      count: 1,
    });
    expect(result.executionLease).toMatchObject({
      phase: "terminal",
      terminalReason: "completed",
      toolCalls: { requested: 1, executed: 1, succeeded: 1, failed: 0 },
      providerTurns: 3,
    });
  });

  it("does not call a pre-hook rejection an executed lease failure in a mixed batch", async () => {
    const repositoryPath = await createRepository();
    vi.stubGlobal(
      "fetch",
      scriptedProvider([
        toolTurn(
          [
            { id: "call-0", name: "ls", arguments: { path: "." } },
            { id: "call-1", name: "no_such_tool", arguments: {} },
          ],
          1,
        ),
        textTurn("The documentation audit is complete."),
      ]),
    );
    const harness = await createAuditHarness();

    const error = await captureInferenceFailure(harness, stepInput(repositoryPath));

    expect(error.evidence?.executionLease).toMatchObject({
      terminalReason: "evidence-preservation-required",
      terminalDisposition: "evidence-invalid",
    });
    expect(error.evidence?.tools?.preExecutionRejections).toBeUndefined();
  });

  // Each vector below satisfies every earlier clause of the predicate so the
  // named clause is the one under test. The count check alone must not be able
  // to account for a rejection labelled "claims a successful result".
  it.each([
    [
      "claims a successful result for an unauthorized call",
      [
        { toolCallId: "forged-0", isError: false },
        { toolCallId: "forged-1", isError: false },
      ],
    ],
    [
      "claims one successful result inside an otherwise failed vector",
      [
        { toolCallId: "forged-0", isError: true },
        { toolCallId: "forged-1", isError: false },
      ],
    ],
    [
      "replays a result vector under foreign identities",
      [
        { toolCallId: "forged-0", isError: true },
        { toolCallId: "other", isError: true },
      ],
    ],
    [
      "reorders the result vector",
      [
        { toolCallId: "forged-1", isError: true },
        { toolCallId: "forged-0", isError: true },
      ],
    ],
    [
      "duplicates one result identity",
      [
        { toolCallId: "forged-0", isError: true },
        { toolCallId: "forged-0", isError: true },
      ],
    ],
    ["answers only part of the proposed batch", [{ toolCallId: "forged-0", isError: true }]],
  ])("still rejects a batch the host never authorized that %s", async (_label, toolResults) => {
    const error = await forgedTurnEndFailure("turn_start", toolResults);

    expect(error.message).toContain("unknown or replayed tool batch");
    expect(error.evidence?.executionLease).toMatchObject({
      phase: "terminal",
      terminalReason: "evidence-preservation-required",
      terminalDisposition: "evidence-invalid",
      toolCalls: { requested: 0, executed: 0, succeeded: 0, failed: 0 },
    });
  });

  it("still rejects a settled-zero shape that arrives while a batch is pending", async () => {
    // Same all-error vector the predicate admits, but the coordinator is in
    // `batch-pending`. Only the phase gate separates the explicit rejection
    // from an invariant violation thrown inside the event subscriber.
    const error = await forgedTurnEndFailure("batch-pending", [
      { toolCallId: "forged-0", isError: true },
      { toolCallId: "forged-1", isError: true },
    ]);

    expect(error.message).toContain("unknown or replayed tool batch");
    expect(error.evidence?.executionLease).toMatchObject({
      phase: "terminal",
      terminalReason: "evidence-preservation-required",
      terminalDisposition: "evidence-invalid",
      toolCalls: { requested: 1 },
    });
  });

  it("still rejects a turn whose host preflight created an authority but no batch", async () => {
    // The fourth producer. `requestToolBatch` re-preflights with the turn's
    // actual usage, so a near-budget turn throws between `turnAuthorities.set`
    // and `batches.set`. Pi turns that host throw into an error result, making
    // the turn indistinguishable from a pre-preflight rejection except for the
    // authority the host already recorded.
    const repositoryPath = await createRepository();
    vi.stubGlobal(
      "fetch",
      scriptedProvider([
        toolTurn([{ id: "call-0", name: "ls", arguments: { path: "." } }], 1),
        toolTurn([{ id: "call-1", name: "read", arguments: { path: "README.md" } }], 2, undefined, {
          prompt_tokens: OVER_CUMULATIVE_INPUT_TOKENS,
          completion_tokens: 5,
          total_tokens: OVER_CUMULATIVE_INPUT_TOKENS + 5,
        }),
        textTurn("The documentation audit is complete."),
      ]),
    );
    const harness = await createAuditHarness();

    const error = await captureInferenceFailure(harness, stepInput(repositoryPath));

    expect(error.message).toContain("unknown or replayed tool batch");
    expect(error.evidence?.executionLease).toMatchObject({
      phase: "terminal",
      terminalReason: "evidence-preservation-required",
      terminalDisposition: "evidence-invalid",
      // Only the executed `ls`; the host authority failure credited nothing.
      toolCalls: { requested: 1, executed: 1, succeeded: 1, failed: 0 },
    });
  });

  it("fails closed with lease evidence when an admitted turn exhausts the budget", async () => {
    // An admitted turn charges usage the host never preflighted, so it can
    // cross a cumulative ceiling. The host then denies renewal, and the
    // coordinator goes terminal inside the reducer rather than through stop();
    // the attempt must still fail closed with its evidence.
    const repositoryPath = await createRepository();
    vi.stubGlobal(
      "fetch",
      scriptedProvider([
        toolTurn([{ id: "call-0", name: "ls", arguments: { path: "." } }], 1),
        toolTurn([{ id: "call-1", name: "Read", arguments: { path: "README.md" } }], 2, undefined, {
          prompt_tokens: OVER_CUMULATIVE_INPUT_TOKENS,
          completion_tokens: 5,
          total_tokens: OVER_CUMULATIVE_INPUT_TOKENS + 5,
        }),
        textTurn("The documentation audit is complete."),
      ]),
    );
    const harness = await createAuditHarness();

    const error = await captureInferenceFailure(harness, stepInput(repositoryPath));

    expect(error.message).toContain("checkpoint stopped without a host renew");
    expect(error.evidence?.executionLease).toMatchObject({
      phase: "terminal",
      toolCalls: { requested: 1, executed: 1, succeeded: 1, failed: 0 },
    });
    expect(error.evidence?.executionLease?.terminalReason).toBeDefined();
    expect(error.evidence?.executionLease?.terminalDisposition).toBeDefined();
    expectLeaseToolConsistency(error);
  });
});
