// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HarnessStepResult } from "../src/execution/contracts.js";
import { projectRunIndexRows, type RunIndexRowV1 } from "../src/records/run-index.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import {
  LIVE_CUT_USAGE,
  createInstantReplayAuditHarness,
  createRepository,
  resetSharedTestState,
  scriptedProvider,
  stepInput,
  textTurn,
  toolTurn,
} from "./support/pi-harness-session-fixtures.js";

afterEach(resetSharedTestState);

/** A real Pi session per case, as the other harness suites budget it. */
const HARNESS_TEST_BUDGET_MS = 20_000;

/** The attempt row a run record holding this one succeeded attempt projects to. */
function attemptRowOf(attempt: Record<string, unknown>): RunIndexRowV1 {
  const projection = projectRunIndexRows(
    {
      schemaVersion: 2,
      id: "run-attempt-output",
      workflow: "review-documentation",
      status: "succeeded",
      createdAt: "2026-10-01T09:00:00.000Z",
      steps: [
        {
          id: "audit-documentation",
          status: "succeeded",
          inference: {
            attempts: [{ attempt: 1, retryable: false, durationMs: 1, ...attempt }],
          },
        },
      ],
    },
    {
      origin: "import",
      snapshotId: "snapshot-attempt-output",
      indexedAt: "2026-10-01T09:00:00.000Z",
      recordSha256: "a".repeat(64),
      fieldMaxChars: 512,
    },
  );
  if (!projection.ok) throw new Error(`fixture record refused: ${projection.reason}`);
  const row = projection.rows.find((candidate) => candidate.rowKind === "attempt");
  if (!row) throw new Error("fixture record projected no attempt row");
  return row;
}

/** The record's attempt evidence for a step the real Pi harness ran. */
function attemptOf(result: HarnessStepResult): Record<string, unknown> {
  return {
    outcome: "succeeded",
    turns: result.turns,
    usage: result.usage,
    modelTelemetry: result.modelTelemetry,
  };
}

/**
 * A turn cut at the output limit is followed by another turn both when the
 * host continues a cut answer and when Pi re-issues a cut tool call. These run
 * the real Pi session so the turn ledger the projection reads is the one the
 * harness writes.
 */
describe("run index attempt output totals over a real turn ledger", () => {
  it(
    "does not count a re-issued cut tool call as a continued answer",
    async () => {
      vi.stubEnv("DOCSFAB_GOVERNANCE_MAX_LENGTH_STOPPED_TOOL_TURNS", "2");
      const repositoryPath = await createRepository();
      const cutCall = toolTurn(
        [{ id: "call-1", name: "read", arguments: { path: "README.md" } }],
        1,
        "length",
        LIVE_CUT_USAGE,
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(scriptedProvider([cutCall, textTurn("The review is complete.")])),
      );

      const result = await (await createInstantReplayAuditHarness()).runStep(
        stepInput(repositoryPath),
      );

      // The ledger the harness wrote: a cut turn, then the answer on its own.
      expect(result.turns?.map((turn) => turn.rawStopReason)).toEqual(["length", "stop"]);
      expect(result.turns![1]!.toolCalls).toBeGreaterThan(result.turns![0]!.toolCalls);
      expect(attemptRowOf(attemptOf(result))).toMatchObject({
        finishReason: "stop",
        continuations: 0,
        firstFinishReason: "stop",
        answerOutputTokens: result.turns![1]!.outputTokens,
        attemptOutputTokens: result.usage?.output,
      });
    },
    testTimeoutMs(HARNESS_TEST_BUDGET_MS),
  );

  it(
    "reads an answer that fits in one turn as one uncut turn",
    async () => {
      const repositoryPath = await createRepository();
      vi.stubGlobal("fetch", vi.fn(scriptedProvider([textTurn("The review is complete.")])));

      const result = await (await createInstantReplayAuditHarness()).runStep(
        stepInput(repositoryPath),
      );

      expect(attemptRowOf(attemptOf(result))).toMatchObject({
        finishReason: "stop",
        continuations: 0,
        firstFinishReason: "stop",
        answerOutputTokens: result.turns![0]!.outputTokens,
      });
    },
    testTimeoutMs(HARNESS_TEST_BUDGET_MS),
  );
});

/**
 * Ledgers shaped like recorded ones. The first is Ultra run `e2f4c3d4` on the
 * 2026-10-01 matrix: an 18,428-token attempt whose plan answer was cut at
 * 16,384 tokens and finished by a 285-token continuation.
 */
describe("run index attempt output totals over recorded ledger shapes", () => {
  const turn = (
    rawStopReason: string | undefined,
    outputTokens: number | undefined,
    toolCalls: number,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    decision: "proceed",
    toolCalls,
    compactions: 0,
    ...(rawStopReason === undefined ? {} : { rawStopReason }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...extra,
  });
  const telemetry = (finishReason: string, outputTokens: number) => ({
    schemaVersion: 1,
    finishReason,
    outputTokens,
    outputAllowance: 16_384,
    providerLatencyMs: 251_067,
  });
  const ultraTurns = [
    turn("tool_calls", 82, 0),
    turn("tool_calls", 101, 3),
    turn("tool_calls", 120, 6),
    turn("tool_calls", 59, 9),
    turn("tool_calls", 57, 11),
    turn("tool_calls", 30, 13),
    turn("tool_calls", 1_310, 14),
    turn("length", 16_384, 15),
    turn("stop", 285, 15),
  ];

  it("reads the cut and its continuation behind a last turn that finished normally", () => {
    expect(
      attemptRowOf({
        outcome: "malformed-response",
        turns: ultraTurns,
        usage: { output: 18_428 },
        modelTelemetry: telemetry("stop", 285),
      }),
    ).toMatchObject({
      finishReason: "stop",
      outputTokens: 285,
      continuations: 1,
      firstFinishReason: "length",
      answerOutputTokens: 16_384 + 285,
      attemptOutputTokens: 18_428,
    });
  });

  it("reads a Responses API cut token as a cut", () => {
    const turns = [turn("max_output_tokens", 16_384, 4), turn("completed", 300, 4)];
    expect(
      attemptRowOf({
        outcome: "succeeded",
        turns,
        modelTelemetry: telemetry("stop", 300),
      }),
    ).toMatchObject({
      continuations: 1,
      firstFinishReason: "length",
      answerOutputTokens: 16_684,
    });
  });

  it("reads a cut that ended the attempt as uncontinued", () => {
    const turns = [turn("tool_calls", 50, 0), turn("length", 16_384, 2)];
    expect(
      attemptRowOf({
        outcome: "malformed-response",
        turns,
        modelTelemetry: telemetry("length", 16_384),
      }),
    ).toMatchObject({
      continuations: 0,
      firstFinishReason: "length",
      answerOutputTokens: 16_384,
    });
  });

  it("counts every continuation of a twice-cut answer and skips a turn the governor stopped", () => {
    const turns = [
      turn("tool_calls", 40, 0),
      turn("length", 16_384, 1),
      turn("length", 16_384, 1),
      turn("stop", 120, 1),
      { decision: "stop", toolCalls: 1, compactions: 0 },
    ];
    expect(
      attemptRowOf({
        outcome: "succeeded",
        turns,
        modelTelemetry: telemetry("stop", 120),
      }),
    ).toMatchObject({
      continuations: 2,
      firstFinishReason: "length",
      answerOutputTokens: 16_384 * 2 + 120,
    });
  });

  it("reads unknown, not zero, when the ledger cannot say how an earlier turn stopped", () => {
    const turns = [turn(undefined, 16_384, 0), turn("stop", 200, 0)];
    expect(
      attemptRowOf({
        outcome: "succeeded",
        turns,
        usage: { output: 16_584 },
        modelTelemetry: telemetry("stop", 200),
      }),
    ).toMatchObject({
      attemptOutputTokens: 16_584,
      continuations: null,
      firstFinishReason: null,
      answerOutputTokens: null,
      omittedFields: [],
    });
  });

  it("reads unknown when a compaction falls between a cut and the next turn", () => {
    const turns = [turn("length", 16_384, 2), turn("stop", 200, 2, { compactions: 1 })];
    expect(
      attemptRowOf({
        outcome: "succeeded",
        turns,
        modelTelemetry: telemetry("stop", 200),
      }),
    ).toMatchObject({ continuations: null, answerOutputTokens: null });
  });

  it("never sums an answer whose delimiting turn names no stop, as a grant-era ledger", () => {
    // Before turns recorded their stop, `outputTokens` could hold the grant.
    const turns = [turn("tool_calls", 50, 0), turn(undefined, 16_384, 1), turn("stop", 16_384, 1)];
    const row = attemptRowOf({
      outcome: "succeeded",
      turns,
      modelTelemetry: telemetry("stop", 16_384),
    });
    expect(row.answerOutputTokens).toBeNull();
  });

  it.each([
    ["a single grant-era turn", [turn(undefined, 16_384, 0)]],
    [
      "a last turn that names no stop after a tool turn",
      [turn("tool_calls", 50, 0), turn(undefined, 16_384, 1)],
    ],
  ])("never sums the answer when %s", (_label, turns) => {
    // Earlier turns all name their stop, so only the answer guard can refuse.
    const row = attemptRowOf({
      outcome: "succeeded",
      turns,
      modelTelemetry: telemetry("stop", 300),
    });
    expect(row).toMatchObject({
      continuations: 0,
      firstFinishReason: "stop",
      answerOutputTokens: null,
    });
  });

  it.each([
    ["missing", undefined],
    ["negative", -1],
    ["not a number", Number.NaN],
    ["fractional", 12.5],
  ])("never sums an answer turn whose output tokens are %s", (_label, outputTokens) => {
    const turns = [
      turn("length", 16_384, 2),
      { ...turn("stop", undefined, 2), ...(outputTokens === undefined ? {} : { outputTokens }) },
    ];
    expect(
      attemptRowOf({ outcome: "succeeded", turns, modelTelemetry: telemetry("stop", 300) }),
    ).toMatchObject({ continuations: 1, firstFinishReason: "length", answerOutputTokens: null });
  });

  it("leaves every total unavailable without a ledger, and refuses a malformed one by name", () => {
    expect(attemptRowOf({ outcome: "succeeded" })).toMatchObject({
      attemptOutputTokens: null,
      continuations: null,
      firstFinishReason: null,
      answerOutputTokens: null,
      omittedFields: [],
    });
    expect(
      attemptRowOf({
        outcome: "succeeded",
        turns: ["not-a-turn"],
        usage: { output: 9 },
      }),
    ).toMatchObject({
      attemptOutputTokens: 9,
      continuations: null,
      omittedFields: ["continuations", "firstFinishReason", "answerOutputTokens"],
    });
  });
});
