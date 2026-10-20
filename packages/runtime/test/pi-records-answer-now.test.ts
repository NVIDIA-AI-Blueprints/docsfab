// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAnswerNowPolicy } from "../src/harness/answer-now.js";
import { limitDefinition } from "../src/config/limits.js";
import { QUALITY_ANSWER_RECORD_TOOL_NAME } from "../src/harness/answer-submission.js";
import type {
  QualityAnswerRecordCapabilityV1,
  QualityAnswerRecordProgressV1,
} from "../src/execution/contracts.js";
import type { InferenceProgressObservationV1 } from "../src/records/contracts.js";
import { PI_ANSWER_NOW_TOOL_REFUSAL } from "../src/harness/pi-session.js";
import { ProviderResponseLimitError } from "../src/model/provider.js";
import {
  captureInferenceFailure,
  createRepository,
  resetSharedTestState,
  textTurn,
} from "./support/pi-harness-session-fixtures.js";
import {
  FIXTURE_REPORT,
  chunkedTextTurn,
  qualityStepInput,
  rawToolCallTurn,
  toolPathHarness,
  toolResults,
  userText,
} from "./support/answer-submission-fixtures.js";

afterEach(async () => {
  await resetSharedTestState();
});

const fixtureRows = [
  {
    fixture: "fixture-a",
    group: 1,
    type: "dimension",
    key: "done",
    rawEnvelopeBytes: 100,
  },
  {
    fixture: "fixture-a",
    group: 2,
    type: "dimension",
    key: "remaining",
    rawEnvelopeBytes: 50,
  },
] as const;
const requiredKeys = ["dimension:done", "dimension:remaining"] as const;
const plan = {
  fixtureRows,
  fullPlanBytes: 150,
  fullPlanMessages: 2,
  dFullMs: 200_000,
  reportDecodeReserveMs: 50_000,
  qualifiedMessageBudget: 100,
  turnLatencyMs: 1_000,
  d3ResidualFires: false,
} as const;

function makeCapability(initial?: QualityAnswerRecordProgressV1, reportReadyOnComplete = true) {
  let progress: QualityAnswerRecordProgressV1 = initial ?? {
    requiredKeys,
    remainingKeys: [...requiredKeys],
    completedKeys: [],
    openSets: [],
    complete: false,
  };
  const ids = new Map<string, { type: string; key: string }>();
  let reportReady = false;
  const capability: QualityAnswerRecordCapabilityV1 = {
    answerNowProgress: () => progress,
    prepareBatch: async ({ toolCalls }) => {
      for (const call of toolCalls) {
        if (!call.rawArguments) continue;
        const parsed = JSON.parse(call.rawArguments) as { type?: unknown; key?: unknown };
        if (typeof parsed.type === "string") {
          ids.set(call.toolCallId, {
            type: parsed.type,
            key: typeof parsed.key === "string" ? parsed.key : parsed.type,
          });
        }
      }
    },
    receipt: (toolCallId) => {
      const item = ids.get(toolCallId);
      return {
        status: "admitted",
        type: item?.type ?? "dimension",
        key: item?.key ?? "remaining",
        remaining: progress.remainingKeys,
        complete: progress.complete,
      };
    },
    settle: async ({ authorizedToolCallIds, successfulToolCallIds }) => {
      if (successfulToolCallIds.length === 0) return;
      const completed = new Set(progress.completedKeys);
      for (const id of successfulToolCallIds) {
        const item = ids.get(id);
        if (item) {
          const identity =
            item.key === item.type && progress.requiredKeys.includes(item.type)
              ? item.type
              : `${item.type}:${item.key}`;
          completed.add(identity);
        }
      }
      const remaining = progress.requiredKeys.filter((key) => !completed.has(key));
      progress = {
        requiredKeys: progress.requiredKeys,
        remainingKeys: remaining,
        completedKeys: [...completed],
        openSets: [],
        complete: remaining.length === 0,
      };
      const terminalAuthorized = authorizedToolCallIds.at(-1);
      reportReady =
        reportReadyOnComplete &&
        progress.complete &&
        terminalAuthorized !== undefined &&
        successfulToolCallIds.includes(terminalAuthorized);
    },
    takeReportReadiness: () => {
      const ready = reportReady;
      reportReady = false;
      return ready;
    },
  };
  return { capability, progress: () => progress };
}

function recordCall(id: string, key: string) {
  return {
    id,
    name: QUALITY_ANSWER_RECORD_TOOL_NAME,
    chunks: [JSON.stringify({ type: "dimension", key, record: { evidence: "fixture" } })],
  };
}

describe("Pi records answer-now integration", () => {
  it("seeds replayed rows as exact assistant/tool pairs without fresh tool-call usage", async () => {
    const repositoryPath = await createRepository();
    const input = await qualityStepInput(repositoryPath);
    const { answerSubmission: _answerSubmission, ...recordsInput } = input;
    const state = makeCapability({
      requiredKeys,
      remainingKeys: [],
      completedKeys: [...requiredKeys],
      openSets: [],
      complete: true,
    });
    const checkpointSha256 = "a".repeat(64);
    const replayPairs = [
      {
        toolCallId: "replay-keyed-dimension",
        type: "dimension",
        key: "dimension-one",
        record: { evidence: "retained keyed row" },
        toolArguments: {
          type: "dimension",
          key: "dimension-one",
          record: { evidence: "retained keyed row" },
        },
        sourceAttempt: 1,
        checkpointSha256,
      },
      {
        toolCallId: "replay-null-singleton",
        type: "quality-score",
        key: "singleton",
        record: null,
        toolArguments: { type: "quality-score", record: "null" },
        sourceAttempt: 1,
        checkpointSha256,
      },
    ] as const;
    const bodies: Record<string, unknown>[] = [];
    let registeredToolNames: string[] = [];
    let activeToolNames: string[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return textTurn(FIXTURE_REPORT);
    });

    const result = await toolPathHarness({
      timeoutMs: 300_000,
      now: () => 0,
      configureSession: (session) => {
        registeredToolNames = session.getAllTools().map((tool) => tool.name);
        activeToolNames = session.getActiveToolNames();
      },
    }).runStep({
      ...recordsInput,
      qualityAnswerRecords: state.capability,
      qualityAnswerRecordCallCeiling: 2,
      qualityAnswerRecordGuidance: "Use the host-provided answer-record plan.",
      qualityAnswerRecordProgress: state.progress,
      qualityAnswerRecordReplay: replayPairs,
      qualityAnswerRecordRemainingKeys: [],
      qualityAnswerNowRecordsPlan: plan,
    });

    expect(registeredToolNames).toContain(QUALITY_ANSWER_RECORD_TOOL_NAME);
    expect(activeToolNames).toContain(QUALITY_ANSWER_RECORD_TOOL_NAME);
    expect(registeredToolNames).not.toContain("canon_submit_artifact");
    expect(activeToolNames).not.toContain("canon_submit_artifact");
    expect(registeredToolNames).toContain("canon_query");
    expect(activeToolNames).toContain("canon_query");
    expect(bodies).toHaveLength(1);
    const messages = (bodies[0]!.messages ?? []) as Array<Record<string, unknown>>;
    const assistantToolCalls = messages
      .filter((message) => message.role === "assistant" && Array.isArray(message.tool_calls))
      .flatMap((message) => message.tool_calls as Array<Record<string, unknown>>);
    const replayCallById = new Map(
      assistantToolCalls.map((call) => [
        call.id,
        call.function as { name?: string; arguments?: string },
      ]),
    );
    const keyedArguments = JSON.parse(
      replayCallById.get("replay-keyed-dimension")!.arguments!,
    ) as Record<string, unknown>;
    const singletonArguments = JSON.parse(
      replayCallById.get("replay-null-singleton")!.arguments!,
    ) as Record<string, unknown>;
    expect(keyedArguments).toEqual({
      type: "dimension",
      key: "dimension-one",
      record: { evidence: "retained keyed row" },
    });
    expect(singletonArguments).toEqual({ type: "quality-score", record: "null" });
    expect(replayCallById.get("replay-keyed-dimension")?.name).toBe(
      QUALITY_ANSWER_RECORD_TOOL_NAME,
    );
    expect(replayCallById.get("replay-null-singleton")?.name).toBe(QUALITY_ANSWER_RECORD_TOOL_NAME);
    const receipts = toolResults(bodies[0]!);
    expect(receipts.get("replay-keyed-dimension")).toBe(
      JSON.stringify({ status: "admitted", type: "dimension", key: "dimension-one" }),
    );
    expect(receipts.get("replay-null-singleton")).toBe(
      JSON.stringify({ status: "admitted", type: "quality-score", key: "singleton" }),
    );
    expect(result.tools?.totalCalls).toBe(0);
    expect(result.executionLease?.toolCallsByScope).toMatchObject({ answerRecord: 0, reading: 0 });
  });

  it("recomputes the deadline from the live ledger and preserves record writes while denying reads", async () => {
    const repositoryPath = await createRepository();
    const input = await qualityStepInput(repositoryPath);
    const { answerSubmission: _answerSubmission, ...recordsInput } = input;
    const state = makeCapability();
    let elapsedMs = 0;
    const timeoutMs = 300_000;
    const policy = resolveAnswerNowPolicy();
    const initialFlip =
      timeoutMs - (plan.dFullMs + (plan.fullPlanMessages + 2) * plan.turnLatencyMs);
    const remainingFlip = Math.min(
      Math.floor((timeoutMs * policy.elapsedShareBasisPoints) / 10_000),
      timeoutMs -
        (plan.reportDecodeReserveMs +
          Math.ceil(((plan.dFullMs - plan.reportDecodeReserveMs) * 50) / plan.fullPlanBytes) +
          3 * plan.turnLatencyMs),
    );
    expect(remainingFlip).toBeGreaterThan(initialFlip);
    const betweenFlips = Math.floor((initialFlip + remainingFlip) / 2);
    const bodies: Record<string, unknown>[] = [];
    const responses = [
      rawToolCallTurn([recordCall("record-done", "done")]),
      rawToolCallTurn([
        { id: "read-midway", name: "read", chunks: [JSON.stringify({ path: "README.md" })] },
      ]),
      rawToolCallTurn([
        { id: "read-denied", name: "read", chunks: [JSON.stringify({ path: "README.md" })] },
        recordCall("record-remaining", "remaining"),
      ]),
      textTurn(FIXTURE_REPORT),
    ];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      const response = responses[bodies.length - 1];
      if (!response) throw new Error("Unexpected provider request.");
      if (bodies.length === 1) elapsedMs = betweenFlips;
      if (bodies.length === 2) elapsedMs = remainingFlip + 1;
      return response.clone();
    });

    const result = await toolPathHarness({ timeoutMs, now: () => elapsedMs }).runStep({
      ...recordsInput,
      qualityAnswerRecords: state.capability,
      qualityAnswerRecordCallCeiling: 2,
      qualityAnswerRecordProgress: state.progress,
      qualityAnswerRecordGuidance: "Use the two host-planned dimension keys.",
      qualityAnswerNowRecordsPlan: plan,
    });

    expect(bodies).toHaveLength(4);
    const userText = (body: Record<string, unknown>) =>
      ((body.messages ?? []) as Array<{ role?: string; content?: unknown }>)
        .filter((message) => message.role === "user")
        .map((message) => String(message.content ?? ""))
        .join("\n");
    expect(userText(bodies[1]!)).not.toContain(
      "finish submitting every remaining required answer record",
    );
    expect(userText(bodies[2]!)).toContain(
      "finish submitting every remaining required answer record",
    );
    expect(toolResults(bodies[3]!).get("read-denied")).toBe(PI_ANSWER_NOW_TOOL_REFUSAL);
    expect(toolResults(bodies[3]!).get("record-remaining")).toContain('"status":"admitted"');
    expect(result.qualityAnswerRecordReport).toBe(FIXTURE_REPORT);
  });

  it("continues after premature final text while required answer records remain", async () => {
    const repositoryPath = await createRepository();
    const input = await qualityStepInput(repositoryPath);
    const { answerSubmission: _answerSubmission, ...recordsInput } = input;
    const state = makeCapability({
      requiredKeys,
      remainingKeys: ["dimension:remaining"],
      completedKeys: ["dimension:done"],
      openSets: [],
      complete: false,
    });
    const bodies: Record<string, unknown>[] = [];
    const responses = [
      textTurn("# Premature report\nStill incomplete."),
      rawToolCallTurn([
        {
          id: "read-during-record-recovery",
          name: "read",
          chunks: [JSON.stringify({ path: "README.md" })],
        },
        recordCall("record-remaining-after-final", "remaining"),
      ]),
      textTurn(FIXTURE_REPORT),
    ];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      const response = responses[bodies.length - 1];
      if (!response) throw new Error("Unexpected provider request.");
      return response.clone();
    });

    const result = await toolPathHarness({ timeoutMs: 300_000, now: () => 0 }).runStep({
      ...recordsInput,
      qualityAnswerRecords: state.capability,
      qualityAnswerRecordCallCeiling: 2,
      qualityAnswerRecordProgress: state.progress,
      qualityAnswerRecordGuidance: "Use the two host-planned dimension keys.",
      qualityAnswerRecordRemainingKeys: ["dimension:remaining"],
    });

    expect(bodies).toHaveLength(3);
    expect(bodies[1]!.tool_choice ?? "auto").toBe("auto");
    const userText = (body: Record<string, unknown>) =>
      ((body.messages ?? []) as Array<{ role?: string; content?: unknown }>)
        .filter((message) => message.role === "user")
        .map((message) => String(message.content ?? ""))
        .join("\n");
    expect(userText(bodies[1]!)).toContain("dimension:remaining");
    expect(toolResults(bodies[2]!).get("record-remaining-after-final")).toContain(
      '"status":"admitted"',
    );
    const recoveryRead = toolResults(bodies[2]!).get("read-during-record-recovery");
    expect(recoveryRead).toBeDefined();
    expect(recoveryRead).not.toBe(PI_ANSWER_NOW_TOOL_REFUSAL);
    expect(state.progress().complete).toBe(true);
    expect(result.qualityAnswerRecordReport).toBe(FIXTURE_REPORT);
  });

  it("uses the plan's key shape after premature final text when a fixed key is literally singleton", async () => {
    const repositoryPath = await createRepository();
    const input = await qualityStepInput(repositoryPath);
    const { answerSubmission: _answerSubmission, ...recordsInput } = input;
    const state = makeCapability({
      requiredKeys: ["evaluation-note", "dimension:singleton"],
      remainingKeys: ["evaluation-note", "dimension:singleton"],
      completedKeys: [],
      openSets: [],
      complete: false,
    });
    const bodies: Record<string, unknown>[] = [];
    const responses = [
      textTurn("# Premature report\nStill incomplete."),
      rawToolCallTurn([
        {
          id: "read-during-record-recovery",
          name: "read",
          chunks: [JSON.stringify({ path: "README.md" })],
        },
        recordCall("record-fixed-singleton-key", "singleton"),
        {
          id: "record-actual-singleton",
          name: QUALITY_ANSWER_RECORD_TOOL_NAME,
          chunks: [JSON.stringify({ type: "evaluation-note", record: { evidence: "fixture" } })],
        },
      ]),
      textTurn(FIXTURE_REPORT),
    ];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      const response = responses[bodies.length - 1];
      if (!response) throw new Error("Unexpected provider request.");
      return response.clone();
    });

    const result = await toolPathHarness({ timeoutMs: 300_000, now: () => 0 }).runStep({
      ...recordsInput,
      qualityAnswerRecords: state.capability,
      qualityAnswerRecordCallCeiling: 2,
      qualityAnswerRecordProgress: state.progress,
      qualityAnswerRecordGuidance:
        "Quality answer-record guidance:\n- evaluation-note: required; singleton; omit key or use key null.\n- dimension: required; fixed planned key singleton.",
      qualityAnswerRecordRemainingKeys: ["evaluation-note", "dimension:singleton"],
    });

    expect(bodies).toHaveLength(3);
    expect(bodies[1]!.tool_choice ?? "auto").toBe("auto");
    expect(userText(bodies[1]!)).toContain('["evaluation-note","dimension:singleton"]');
    expect(userText(bodies[1]!)).toContain(
      "Use the matching record type in the host-provided answer-record guidance and schema",
    );
    expect(userText(bodies[1]!)).toContain(
      "use the exact planned key even when its value is `singleton`",
    );
    expect(userText(bodies[1]!)).not.toContain('A label ending in ":singleton"');
    expect(toolResults(bodies[2]!).get("record-fixed-singleton-key")).toContain(
      '"status":"admitted"',
    );
    expect(toolResults(bodies[2]!).get("record-actual-singleton")).toContain('"status":"admitted"');
    const recoveryRead = toolResults(bodies[2]!).get("read-during-record-recovery");
    expect(recoveryRead).toBeDefined();
    expect(recoveryRead).not.toBe(PI_ANSWER_NOW_TOOL_REFUSAL);
    expect(state.progress().complete).toBe(true);
    expect(result.qualityAnswerRecordReport).toBe(FIXTURE_REPORT);
  });

  it("asks for a Markdown report with tool choice disabled after settled completion", async () => {
    const repositoryPath = await createRepository();
    const recordsInput = await qualityStepInput(repositoryPath, {
      path: "text-final",
      reason: "not-recorded",
    });
    const state = makeCapability(undefined, true);
    const answerRecords = state.capability;
    const capability: QualityAnswerRecordCapabilityV1 = {
      ...answerRecords,
      receipt: (toolCallId) => {
        const receipt = answerRecords.receipt(toolCallId);
        return toolCallId === "record-refused" ? { ...receipt, status: "refused" } : receipt;
      },
    };
    const bodies: Record<string, unknown>[] = [];
    const observations: InferenceProgressObservationV1[] = [];
    const responses = [
      rawToolCallTurn([
        recordCall("record-refused", "refused"),
        recordCall("record-done", "done"),
        recordCall("record-remaining", "remaining"),
      ]),
      textTurn(FIXTURE_REPORT),
    ];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      const response = responses[bodies.length - 1];
      if (!response) throw new Error("Unexpected provider request.");
      return response.clone();
    });

    const result = await toolPathHarness({
      timeoutMs: 300_000,
      now: () => 0,
      capability: null,
    }).runStep({
      ...recordsInput,
      qualityAnswerRecords: capability,
      qualityAnswerRecordCallCeiling: 3,
      qualityAnswerRecordProgress: state.progress,
      qualityAnswerRecordGuidance: "Use the two host-planned dimension keys.",
      qualityAnswerRecordRemainingKeys: [...requiredKeys],
      onProgress: (observation) => observations.push(observation),
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ tool_choice: "none" });
    expect(toolResults(bodies[1]!).get("record-refused")).toContain('"status":"refused"');
    const messages = (bodies[1]!.messages ?? []) as Array<{
      role?: string;
      content?: unknown;
    }>;
    expect(
      messages
        .filter((message) => message.role === "user")
        .map((message) => String(message.content ?? ""))
        .join("\n"),
    ).toContain("Return the final evaluator report as Markdown only");
    expect(result.qualityAnswerRecordReport).toBe(FIXTURE_REPORT);
    expect(state.progress().complete).toBe(true);
    expect(result.answerSubmission).toEqual({
      path: "answer-records",
      reason: "record-ledger",
      submission: "not-applicable",
      reportTurn: "admitted",
    });
    const finalProgress = observations.at(-1)!;
    expect(finalProgress.toolActivity).toMatchObject({
      answerRecord: { started: 3, settled: 3, errorResults: 1 },
    });
  });

  it("does not require tools for a non-record text-final evaluator", async () => {
    const repositoryPath = await createRepository();
    const input = await qualityStepInput(repositoryPath, {
      path: "text-final",
      reason: "not-recorded",
    });
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return textTurn(FIXTURE_REPORT).clone();
    });

    await expect(
      toolPathHarness({ timeoutMs: 300_000, now: () => 0 }).runStep({
        ...input,
        experimentalAnswerRecordDiscoveryRenewal: true,
      }),
    ).rejects.toThrow("malformed quality artifact envelope");

    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.tool_choice ?? "auto").toBe("auto");
  });

  it("continues the answer-record Markdown report beyond the ordinary count across per-request byte ceilings", async () => {
    expect(limitDefinition("inference.maxLengthStopContinuations").value).toBe(1);
    const repositoryPath = await createRepository();
    const recordsInput = await qualityStepInput(repositoryPath, {
      path: "text-final",
      reason: "not-recorded",
    });
    const state = makeCapability(undefined, true);
    const maxResponseBytes = 2_048;
    const report = `${FIXTURE_REPORT}\n\n${"Additional report evidence remains available. ".repeat(80)}`;
    const chunkSize = Math.ceil(report.length / 4);
    const reportParts = Array.from({ length: 4 }, (_, index) =>
      report.slice(index * chunkSize, (index + 1) * chunkSize),
    );
    const responses = [
      rawToolCallTurn([
        recordCall("record-done", "done"),
        recordCall("record-remaining", "remaining"),
      ]),
      ...reportParts.map((part, index) =>
        chunkedTextTurn([part], index < reportParts.length - 1 ? "length" : "stop"),
      ),
    ];
    for (const response of responses.slice(1)) {
      expect(Buffer.byteLength(await response.clone().text(), "utf8")).toBeLessThan(
        maxResponseBytes,
      );
    }
    expect(Buffer.byteLength(report, "utf8")).toBeGreaterThan(maxResponseBytes);
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      const response = responses[bodies.length - 1];
      if (!response) throw new Error("Unexpected provider request.");
      return response.clone();
    });

    const result = await toolPathHarness({ maxResponseBytes }).runStep({
      ...recordsInput,
      qualityAnswerRecords: state.capability,
      qualityAnswerRecordCallCeiling: 2,
      qualityAnswerRecordProgress: state.progress,
      qualityAnswerRecordGuidance: "Use the two host-planned dimension keys.",
      qualityAnswerRecordRemainingKeys: [...requiredKeys],
      experimentalAnswerRecordDiscoveryRenewal: true,
    });

    expect(bodies).toHaveLength(5);
    expect(bodies[1]).toMatchObject({ tool_choice: "none" });
    expect(result.qualityAnswerRecordReport).toBe(report);
    expect(result.answerSubmission).toMatchObject({
      path: "answer-records",
      reportTurn: "admitted",
    });
  }, 60_000);

  it.each([
    {
      setting: "DOCSFAB_INFERENCE_MAX_LENGTH_STOP_CONTINUATIONS",
      value: "0",
      limit: "inference.maxLengthStopContinuations",
    },
    {
      setting: "DOCSFAB_GOVERNANCE_MAX_LENGTH_STOPPED_TOOL_TURNS",
      value: "1",
      limit: "governance.maxConsecutiveLengthStoppedToolTurns",
    },
  ])(
    "refuses the explicit $limit override before a discovery provider request",
    async ({ setting, value, limit: limitName }) => {
      const repositoryPath = await createRepository();
      const recordsInput = await qualityStepInput(repositoryPath, {
        path: "text-final",
        reason: "not-recorded",
      });
      const state = makeCapability();
      let providerRequests = 0;
      vi.stubGlobal("fetch", async () => {
        providerRequests += 1;
        return textTurn(FIXTURE_REPORT);
      });

      const harness = toolPathHarness({ environment: { [setting]: value } });
      let failure: unknown;
      try {
        await harness.runStep({
          ...recordsInput,
          qualityAnswerRecords: state.capability,
          qualityAnswerRecordCallCeiling: 2,
          qualityAnswerRecordProgress: state.progress,
          qualityAnswerRecordGuidance: "Use the two host-planned dimension keys.",
          qualityAnswerRecordRemainingKeys: [...requiredKeys],
          experimentalAnswerRecordDiscoveryRenewal: true,
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(
        "Experimental answer-record discovery requires absent aggregate limits",
      );
      expect((failure as Error).message).toContain(`${limitName} (host)`);
      expect(providerRequests).toBe(0);
    },
  );

  it("retains the per-request response byte refusal on the V2 answer-record report path", async () => {
    const repositoryPath = await createRepository();
    const recordsInput = await qualityStepInput(repositoryPath, {
      path: "text-final",
      reason: "not-recorded",
    });
    const state = makeCapability();
    const maxResponseBytes = 2_048;
    const privateResponse = "private-v2-report-response-".repeat(maxResponseBytes);
    const responses = [
      rawToolCallTurn([
        recordCall("record-done", "done"),
        recordCall("record-remaining", "remaining"),
      ]),
      textTurn(privateResponse),
    ];
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      const response = responses[bodies.length - 1];
      if (!response) throw new Error("Unexpected provider request.");
      return response.clone();
    });

    const error = await captureInferenceFailure(toolPathHarness({ maxResponseBytes }), {
      ...recordsInput,
      qualityAnswerRecords: state.capability,
      qualityAnswerRecordCallCeiling: 2,
      qualityAnswerRecordProgress: state.progress,
      qualityAnswerRecordGuidance: "Use the two host-planned dimension keys.",
      qualityAnswerRecordRemainingKeys: [...requiredKeys],
      experimentalAnswerRecordDiscoveryRenewal: true,
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ tool_choice: "none" });
    expect(error.category).toBe("provider-transient");
    const limitError =
      error.cause instanceof AggregateError
        ? error.cause.errors.find((cause) => cause instanceof ProviderResponseLimitError)
        : error.cause;
    expect(limitError).toBeInstanceOf(ProviderResponseLimitError);
    expect(limitError).toMatchObject({
      code: "provider-response-too-large",
      maxResponseBytes,
    });
    expect(error.message).not.toContain(privateResponse);
  }, 60_000);

  it("keeps an unasked records report distinct from an incomplete ledger", async () => {
    const repositoryPath = await createRepository();
    const input = await qualityStepInput(repositoryPath, {
      path: "text-final",
      reason: "not-recorded",
    });
    const state = makeCapability({
      requiredKeys,
      remainingKeys: ["dimension:remaining"],
      completedKeys: ["dimension:done"],
      openSets: [],
      complete: false,
    });
    vi.stubGlobal("fetch", async () => {
      return rawToolCallTurn([recordCall("record-done", "done")]);
    });

    const failure = await captureInferenceFailure(
      // A three-turn budget admits the record call and leaves a valid lease
      // shape while keeping the report unasked for the incomplete ledger.
      toolPathHarness({ maxProviderTurns: 3, now: () => 0 }),
      {
        ...input,
        qualityAnswerRecords: state.capability,
        qualityAnswerRecordCallCeiling: 2,
        qualityAnswerRecordProgress: state.progress,
        qualityAnswerRecordGuidance: "Use the two host-planned dimension keys.",
      },
    );

    expect(state.progress().complete).toBe(false);
    expect(failure.evidence?.answerSubmission).toEqual({
      path: "answer-records",
      reason: "record-ledger",
      submission: "not-applicable",
      reportTurn: "not-asked",
    });
  });

  it("records a settled ledger's report request as in-flight at the provider-turn ceiling", async () => {
    const repositoryPath = await createRepository();
    const input = await qualityStepInput(repositoryPath, {
      path: "text-final",
      reason: "not-recorded",
    });
    const state = makeCapability();
    vi.stubGlobal("fetch", async () =>
      rawToolCallTurn([
        recordCall("record-done", "done"),
        recordCall("record-remaining", "remaining"),
      ]),
    );

    const failure = await captureInferenceFailure(
      // Two record calls plus one report turn fit the lease-policy minimum.
      toolPathHarness({ maxProviderTurns: 3, now: () => 0 }),
      {
        ...input,
        qualityAnswerRecords: state.capability,
        qualityAnswerRecordCallCeiling: 2,
        qualityAnswerRecordProgress: state.progress,
        qualityAnswerRecordGuidance: "Use the two host-planned dimension keys.",
        qualityAnswerRecordRemainingKeys: [...requiredKeys],
      },
    );

    expect(state.progress().complete).toBe(true);
    expect(failure.evidence?.answerSubmission).toEqual({
      path: "answer-records",
      reason: "record-ledger",
      submission: "not-applicable",
      reportTurn: "in-flight",
      reportInFlightBytes: 0,
    });
  });

  it("does not arm a partial restored ledger when the sealed full-plan reserve cannot fit", async () => {
    const repositoryPath = await createRepository();
    const input = await qualityStepInput(repositoryPath);
    const { answerSubmission: _answerSubmission, ...recordsInput } = input;
    const partial: QualityAnswerRecordProgressV1 = {
      requiredKeys,
      remainingKeys: ["dimension:remaining"],
      completedKeys: ["dimension:done"],
      openSets: [],
      complete: false,
    };
    const state = makeCapability(partial);
    let elapsedMs = 0;
    const timeoutMs = 300_000;
    const unfitPlan = { ...plan, dFullMs: 300_000 };
    const bodies: Record<string, unknown>[] = [];
    const responses = [
      rawToolCallTurn([
        { id: "read-unfit", name: "read", chunks: [JSON.stringify({ path: "README.md" })] },
      ]),
      rawToolCallTurn([recordCall("record-after-unfit", "remaining")]),
      textTurn(FIXTURE_REPORT),
    ];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      const response = responses[bodies.length - 1];
      if (!response) throw new Error("Unexpected provider request.");
      if (bodies.length === 1) elapsedMs = 220_000;
      return response.clone();
    });

    const result = await toolPathHarness({ timeoutMs, now: () => elapsedMs }).runStep({
      ...recordsInput,
      qualityAnswerRecords: state.capability,
      qualityAnswerRecordCallCeiling: 2,
      qualityAnswerRecordProgress: state.progress,
      qualityAnswerRecordGuidance: "Use the two host-planned dimension keys.",
      qualityAnswerNowRecordsPlan: unfitPlan,
    });

    expect(bodies).toHaveLength(3);
    const second = (bodies[1]!.messages ?? []) as Array<{ role?: string; content?: unknown }>;
    expect(
      second
        .filter((message) => message.role === "user")
        .map((message) => String(message.content ?? ""))
        .join("\n"),
    ).not.toContain("finish submitting every remaining required answer record");
    expect(toolResults(bodies[1]!).get("read-unfit")).toBeDefined();
    expect(toolResults(bodies[1]!).get("read-unfit")).not.toBe(PI_ANSWER_NOW_TOOL_REFUSAL);
    expect(result.qualityAnswerRecordReport).toBe(FIXTURE_REPORT);
  });

  it("retains coded final-report rejection and provider usage on the records path", async () => {
    const repositoryPath = await createRepository();
    const input = await qualityStepInput(repositoryPath);
    const { answerSubmission: _answerSubmission, ...recordsInput } = input;
    const state = makeCapability({
      requiredKeys,
      remainingKeys: [],
      completedKeys: [...requiredKeys],
      openSets: [],
      complete: true,
    });
    vi.stubGlobal("fetch", async () =>
      textTurn("ordinary text without the required report heading"),
    );

    let failure: unknown;
    try {
      await toolPathHarness({ timeoutMs: 300_000, now: () => 0 }).runStep({
        ...recordsInput,
        qualityAnswerRecords: state.capability,
        qualityAnswerRecordCallCeiling: 2,
        qualityAnswerRecordGuidance: "Use the host-provided answer-record plan.",
        qualityAnswerRecordProgress: state.progress,
        qualityAnswerRecordRemainingKeys: [],
        qualityAnswerNowRecordsPlan: plan,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      category: "malformed-response",
      retryable: true,
      rejection: {
        code: "quality-submission-report",
        location: "$.reportMarkdown",
      },
      evidence: {
        usage: {
          input: 10,
          output: 5,
          total: 15,
          turns: 1,
        },
      },
    });
  });
});
