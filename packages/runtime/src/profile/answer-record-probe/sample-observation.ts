// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { canonicalDigest } from "../../content-ir/canonical.js";
import {
  ANSWER_RECORD_TOOL_NAME,
  answerRecordTool,
  decodeAnswerRecordArguments,
  type AnswerRecordType,
} from "./codecs.js";
import type { PlannedCall, PlannedRequest } from "./planning.js";
import type {
  AnswerRecordProbeCall,
  AnswerRecordProbeFailure,
  AnswerRecordProbePhase,
  AnswerRecordProbeSample,
  AnswerRecordProbeTarget,
} from "../answer-record-probe.js";
import type { CompatibilityTurn } from "../probe-core.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

interface StreamTiming {
  ttftMs: number | null;
  firstArgumentDeltaMs: number | null;
  lastArgumentDeltaMs: number | null;
  argumentBytes: number;
  argumentBytesAfterFirstDelta: number;
  promptTokens: number | null;
  cachedPromptTokens: number | null;
}

function emptyTiming(): StreamTiming {
  return {
    ttftMs: null,
    firstArgumentDeltaMs: null,
    lastArgumentDeltaMs: null,
    argumentBytes: 0,
    argumentBytesAfterFirstDelta: 0,
    promptTokens: null,
    cachedPromptTokens: null,
  };
}

/** UTF-8 bytes of tool-call argument text in one streamed chunk. */
function argumentDeltaBytes(chunk: unknown): number {
  if (!isPlainObject(chunk) || !Array.isArray(chunk.choices)) return 0;
  const delta = isPlainObject(chunk.choices[0]) ? chunk.choices[0].delta : undefined;
  if (!isPlainObject(delta) || !Array.isArray(delta.tool_calls)) return 0;
  return delta.tool_calls.reduce<number>((sum, call) => {
    const text =
      isPlainObject(call) && isPlainObject(call.function) ? call.function.arguments : undefined;
    return typeof text === "string" ? sum + Buffer.byteLength(text, "utf8") : sum;
  }, 0);
}

function contentDelta(chunk: unknown): boolean {
  if (!isPlainObject(chunk) || !Array.isArray(chunk.choices)) return false;
  const delta = isPlainObject(chunk.choices[0]) ? chunk.choices[0].delta : undefined;
  if (!isPlainObject(delta)) return false;
  return (
    ["content", "reasoning_content", "reasoning"].some(
      (member) => typeof delta[member] === "string" && (delta[member] as string).length > 0,
    ) ||
    (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0)
  );
}

function readUsage(chunk: unknown, timing: StreamTiming): void {
  if (!isPlainObject(chunk) || !isPlainObject(chunk.usage)) return;
  const usage = chunk.usage;
  if (typeof usage.prompt_tokens === "number") timing.promptTokens = usage.prompt_tokens;
  const details = usage.prompt_tokens_details;
  if (isPlainObject(details) && typeof details.cached_tokens === "number") {
    timing.cachedPromptTokens = details.cached_tokens;
  }
}

/**
 * Wrap `send` so each response's event stream is read as it passes: the time
 * to the first content delta, when the tool-call argument text arrived and how
 * much of it came after the first, and the usage the provider reports. The
 * bytes are passed on unchanged; nothing of their text is kept.
 */
export function timedFetch(
  send: typeof globalThis.fetch,
  now: () => number,
): { readonly fetch: typeof globalThis.fetch; take(): StreamTiming } {
  let timing = emptyTiming();
  const fetch = (async (input, init) => {
    const startedAt = now();
    timing = emptyTiming();
    const current = timing;
    const response = await send(input, init);
    if (!response.ok || !response.body) return response;
    const decoder = new TextDecoder();
    let pending = "";
    const readLines = (final: boolean) => {
      const lines = pending.split(/\r?\n/u);
      pending = final ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice("data:".length).trim();
        if (data === "" || data === "[DONE]") continue;
        let chunk: unknown;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        const at = Math.max(0, now() - startedAt);
        if (current.ttftMs === null && contentDelta(chunk)) current.ttftMs = at;
        const argumentBytes = argumentDeltaBytes(chunk);
        if (argumentBytes > 0) {
          current.firstArgumentDeltaMs ??= at;
          current.lastArgumentDeltaMs = at;
          current.argumentBytes += argumentBytes;
          if (at > current.firstArgumentDeltaMs) {
            current.argumentBytesAfterFirstDelta += argumentBytes;
          }
        }
        readUsage(chunk, current);
      }
    };
    const tap = new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        pending += decoder.decode(bytes, { stream: true });
        readLines(false);
        controller.enqueue(bytes);
      },
      flush() {
        pending += decoder.decode();
        readLines(true);
      },
    });
    return new Response(response.body.pipeThrough(tap), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof globalThis.fetch;
  return { fetch, take: () => timing };
}

function callFindings(
  raw: string,
  expected: readonly PlannedCall[],
  matched: Set<number>,
  target: AnswerRecordProbeTarget,
  keys: ReadonlyMap<AnswerRecordType, ReadonlySet<string>>,
): AnswerRecordProbeCall {
  const tool = answerRecordTool(target.selection === "typed" ? "typed" : "untyped").function;
  let piValidation: AnswerRecordProbeCall["piValidation"] = "ok";
  try {
    target.pi.validateToolArguments(tool, {
      type: "toolCall",
      id: "probe-call",
      name: ANSWER_RECORD_TOOL_NAME,
      arguments: target.pi.parseStreamingJson(raw),
    });
  } catch {
    piValidation = "refused";
  }
  const decoded = decodeAnswerRecordArguments(raw, keys);
  let plannedIndex: number | null = null;
  if (decoded.decode === "admitted") {
    const digest = canonicalDigest(decoded.envelope);
    const index = expected.findIndex(
      (call, position) => !matched.has(position) && canonicalDigest(call.envelope) === digest,
    );
    if (index >= 0) {
      matched.add(index);
      plannedIndex = index;
    }
  }
  return {
    piValidation,
    decode: decoded.decode,
    decodeLocation: decoded.decode === "admitted" ? null : decoded.location,
    recordEncoding: decoded.decode === "admitted" ? decoded.recordEncoding : null,
    rawBytes: Buffer.byteLength(raw, "utf8"),
    rawSha256: sha256(raw),
    deepEqual: plannedIndex !== null,
    plannedIndex,
  };
}

export function sampleOf(
  request: PlannedRequest,
  turn: CompatibilityTurn,
  timing: StreamTiming,
  elapsedMs: number,
  retryOf: number | null,
  target: AnswerRecordProbeTarget,
  keys: ReadonlyMap<AnswerRecordType, ReadonlySet<string>>,
): AnswerRecordProbeSample {
  const base = {
    phase: request.phase,
    ...(request.contextTypes ? { contextTypes: request.contextTypes } : {}),
    rungBytes: request.rungBytes,
    seed: request.seed,
    expectedCalls: request.calls.length,
    plannedBytes: request.plannedBytes,
    escapesPerKiB: request.escapesPerKiB,
    paddingChars: request.paddingChars,
    estimatedInputTokens: request.estimatedInputTokens,
    httpStatus: turn.status,
    retried: false,
    retryOf,
    retryWithheld: null,
    promptTokens: timing.promptTokens,
    cachedPromptTokens: timing.cachedPromptTokens,
    ttftMs: timing.ttftMs,
    firstArgumentDeltaMs: timing.firstArgumentDeltaMs,
    lastArgumentDeltaMs: timing.lastArgumentDeltaMs,
    argumentBytes: timing.argumentBytes,
    argumentBytesAfterFirstDelta: timing.argumentBytesAfterFirstDelta,
  };
  if (!turn.ok) {
    const transport = turn.status === 0 ? turn.transport : undefined;
    return {
      ...base,
      transportError: turn.status === 0 ? (transport?.class ?? "other") : null,
      streamedBytes: turn.status === 0 ? (transport?.streamedBytes ?? 0) : null,
      elapsedMs: transport?.elapsedMs ?? elapsedMs,
      outputTokens: null,
      finishReason: null,
      transportObservation: {
        responseBytes: turn.responseBytes ?? 0,
        requestIdentifier: turn.requestIdentifier ?? { present: false, source: null, sha256: null },
        streamClass: turn.streamClass ?? (turn.status === 0 ? "transport-error" : "http-error"),
      },
      otherToolCalls: 0,
      calls: [],
      inPlannedOrder: null,
      admitted: false,
      failure: turn.status === 0 ? "transport" : "http-refused",
    };
  }
  const matched = new Set<number>();
  const own = turn.toolCalls.filter((call) => call.name === ANSWER_RECORD_TOOL_NAME);
  const calls = own.map((call) =>
    callFindings(call.arguments, request.calls, matched, target, keys),
  );
  const failure: AnswerRecordProbeFailure | null =
    turn.finishReason === "length"
      ? "length"
      : calls.length === 0
        ? "no-tool-call"
        : calls.some((call) => call.piValidation === "refused")
          ? "pi-validation"
          : calls.some((call) => call.decode !== "admitted")
            ? "decode"
            : calls.length !== request.calls.length || own.length !== turn.toolCalls.length
              ? "call-count"
              : shortCopy(calls, request.calls) &&
                  !isExactContextNullCopy(request.phase, calls, request.calls)
                ? "short-copy"
                : // Phase K and the typed context group settle whether every
                  // prompted call was copied, even when all returned calls fit.
                  (request.phase === "K" || request.phase === "A-t-context") &&
                    matched.size !== request.calls.length
                  ? "copy"
                  : null;
  const order = calls.map((call) => call.plannedIndex);
  return {
    ...base,
    transportError: null,
    streamedBytes: null,
    elapsedMs,
    outputTokens: turn.completionTokens,
    finishReason: turn.finishReason,
    transportObservation: {
      responseBytes: turn.responseBytes ?? 0,
      requestIdentifier: turn.requestIdentifier ?? { present: false, source: null, sha256: null },
      streamClass: turn.streamObservation?.streamClass ?? "unparsed-response",
      ...(turn.streamObservation ? { stream: turn.streamObservation } : {}),
    },
    otherToolCalls: turn.toolCalls.length - own.length,
    calls,
    inPlannedOrder:
      matched.size === request.calls.length && order.length === request.calls.length
        ? order.every((index, position) => index === position)
        : null,
    admitted: failure === null,
    failure,
  };
}

/**
 * A call carried fewer raw bytes than the call it copies. The prompt asks for
 * compact JSON, the shortest form, so a faithful copy is never shorter; a
 * shorter one dropped content and proves nothing about the planned size.
 * Calls and plan are compared smallest to smallest, whatever their order.
 */
function shortCopy(calls: readonly AnswerRecordProbeCall[], planned: readonly PlannedCall[]) {
  const returned = calls.map((call) => call.rawBytes).sort((left, right) => left - right);
  const asked = planned.map((call) => call.bytes).sort((left, right) => left - right);
  return returned.some((bytes, index) => bytes < asked[index]!);
}

/**
 * Pi's validator drops an optional null property before validating this
 * generic object|string tool schema. The strict raw decoder still sees the
 * canonical null value, so this typed-context spelling is semantically exact
 * even though it is two bytes shorter than the planned JSON string. Ordinary
 * A/A-t size-rung comparisons remain byte-based.
 */
function isExactContextNullCopy(
  phase: AnswerRecordProbePhase,
  calls: readonly AnswerRecordProbeCall[],
  planned: readonly PlannedCall[],
): boolean {
  return (
    phase === "A-t-context" &&
    calls.length === 1 &&
    planned.length === 1 &&
    planned[0]!.envelope.type === "quality-score" &&
    planned[0]!.envelope.record === null &&
    calls[0]!.recordEncoding === "null" &&
    calls[0]!.deepEqual
  );
}
