// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { canonicalDigest } from "../src/contract-kit/index.js";
import type { BoundModelExecutionProfile, ProviderTransport } from "../src/model/configuration.js";
import { grantedTurnOutputTokens } from "../src/model/context-budget.js";
import {
  createProviderConnectionFactory,
  type ProviderRetryNotice,
} from "../src/model/provider.js";
import { observeLandedProviderTurn } from "../src/model/attempt-telemetry.js";
import { providerFailureReason } from "../src/live-agent/provider-failure.js";
import { assistantTurnFailure } from "../src/harness/pi-offline.js";
import {
  appendLengthStopNudge,
  DEFAULT_PROVIDER_TURN_RETRY_POLICY,
  describeBlankProviderTurn,
  effectiveBlankAttemptBound,
  isLengthStop,
  isRetryableProviderTurnFailure,
  LENGTH_STOP_NUDGE_MAX_CHARS,
  lengthStopNudgeText,
  MAX_LENGTH_STOP_NUDGED_REPLAYS,
  observeBlankProviderTurn,
  providerTurnBackoffSleep,
  providerTurnRetryDelayMs,
  resolveProviderTurnRetryPolicy,
  RETRYABLE_PROVIDER_TURN_CATEGORIES,
  withBoundedProviderTurnRetry,
} from "../src/model/provider-turn-retry.js";
import {
  DOCSFAB_SYSTEM_PROMPT,
  DOCSFAB_SYSTEM_PROMPT_SHA256,
} from "../src/model/request-policy.js";
import { validModelConfig } from "./helpers.js";

type StreamSimple = ModelRuntime["streamSimple"];
type ProviderEvent = {
  type: string;
  reason?: string;
  error?: { errorMessage?: string; stopReason?: string };
  message?: unknown;
};

/**
 * Minimal stand-in for Pi's AssistantMessageEventStream, which Pi does not
 * export. The retry wrapper builds its output stream from the delegate's own
 * constructor, so the fake exercises the seam production uses.
 */
class FakeEventStream {
  private readonly queue: ProviderEvent[] = [];
  private readonly waiting: Array<(value: IteratorResult<ProviderEvent>) => void> = [];
  private complete = false;

  public push(event: ProviderEvent): void {
    if (this.complete) return;
    if (event.type === "done" || event.type === "error") this.complete = true;
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  public end(): void {
    this.complete = true;
    while (this.waiting.length > 0) {
      this.waiting.shift()!({ value: undefined as never, done: true });
    }
  }

  public async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.complete) return;
      const next = await new Promise<IteratorResult<ProviderEvent>>((resolve) =>
        this.waiting.push(resolve),
      );
      if (next.done) return;
      yield next.value;
    }
  }
}

function errorStream(errorMessage: string): FakeEventStream {
  const stream = new FakeEventStream();
  stream.push({ type: "start" });
  stream.push({ type: "error", error: { errorMessage } });
  return stream;
}

function doneStream(text: string): FakeEventStream {
  const stream = new FakeEventStream();
  stream.push({ type: "start" });
  stream.push({ type: "text_delta" });
  stream.push({ type: "done", message: { content: [{ type: "text", text }] } });
  return stream;
}

/**
 * An empty turn: the provider completed the stream with no content event and a
 * message carrying neither text nor a tool call.
 */
function blankStream(
  overrides: {
    reason?: string;
    stopReason?: string;
    rawStopReason?: string;
    errorMessage?: string;
    usage?: { input: number; output: number };
  } = {},
): FakeEventStream {
  const stream = new FakeEventStream();
  stream.push({ type: "start" });
  stream.push({
    type: "done",
    reason: overrides.reason ?? "stop",
    message: {
      content: [],
      stopReason: overrides.stopReason ?? overrides.reason ?? "stop",
      ...(overrides.rawStopReason === undefined ? {} : { rawStopReason: overrides.rawStopReason }),
      ...(overrides.errorMessage === undefined ? {} : { errorMessage: overrides.errorMessage }),
      usage: overrides.usage ?? { input: 1_200, output: 0 },
    },
  });
  return stream;
}

/**
 * An Inference Hub body from a LiteLLM front door reporting an unavailable
 * Bedrock backend; it carries no credential. "ServiceUnavailableError" and
 * "BedrockException" are body words, while 503 is the real status.
 */
const LITELLM_BEDROCK_503_BODY = JSON.stringify({
  error: {
    message:
      'litellm.ServiceUnavailableError: BedrockException - {"message":"Bedrock is unable to process your request."}',
    type: "None",
    param: "None",
    code: "503",
  },
});

/** The same unavailable front door, as the provider error message reads it. */
const ROUTE_503_MESSAGE = `503: ${LITELLM_BEDROCK_503_BODY}`;

function hubUnavailableResponse(): Response {
  return new Response(LITELLM_BEDROCK_503_BODY, {
    status: 503,
    statusText: "Service Unavailable",
    headers: { "content-type": "application/json" },
  });
}

function blankTurnSse(model: string, finishReason = "stop"): Response {
  const body = [
    `data: ${JSON.stringify({ id: "blank", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "blank", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 700, completion_tokens: 0, total_tokens: 700 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(stream: unknown): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream as AsyncIterable<ProviderEvent>) events.push(event);
  return events;
}

function wrap(
  factories: readonly (() => FakeEventStream)[],
  options: Parameters<typeof withBoundedProviderTurnRetry>[1] = {},
): {
  stream: StreamSimple;
  delegate: ReturnType<typeof vi.fn>;
  slept: number[];
  abortSignals: Array<AbortSignal | undefined>;
} {
  const slept: number[] = [];
  const abortSignals: Array<AbortSignal | undefined> = [];
  let index = 0;
  const delegate = vi.fn(() => {
    const factory = factories[Math.min(index, factories.length - 1)]!;
    index += 1;
    return factory();
  });
  const wrapped = withBoundedProviderTurnRetry(delegate as unknown as StreamSimple, {
    sleep: async (milliseconds, signal) => {
      slept.push(milliseconds);
      abortSignals.push(signal);
    },
    ...options,
  });
  return { stream: wrapped, delegate, slept, abortSignals };
}

function boundNvidiaProfile(): BoundModelExecutionProfile {
  const transport: ProviderTransport = "openai-chat-completions";
  const body = {
    schemaVersion: 1 as const,
    modelId: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
    routeId: "nvidia-api-catalog" as const,
    deploymentIdentitySha256: "a".repeat(64),
    transport,
    reasoningMode: "disabled" as const,
    reasoningControl: { kind: "system-directive" as const, directive: "/no_think" as const },
    installedSystemInstructionSha256: DOCSFAB_SYSTEM_PROMPT_SHA256,
    temperature: 0 as const,
    topP: 1 as const,
  };
  return {
    routeId: "nvidia-api-catalog",
    providerId: "nvidia-api-catalog",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    modelId: body.modelId,
    transport,
    apiFormat: "chat_completions",
    profile: {
      ...validModelConfig.profile,
      compatibility: {
        ...validModelConfig.profile.compatibility,
        apiFormats: ["chat_completions"],
      },
    },
    requestPolicy: validModelConfig.requestPolicy,
    compositionRequestPolicy: { ...body, policySha256: canonicalDigest(body) },
    compositionPolicy: { maxProviderTurns: 4, timeoutMs: 300_000, maxResponseBytes: 65_536 },
  };
}

/**
 * A chat-completions SSE body from bare choice fragments: each entry becomes
 * one `chat.completion.chunk` carrying that `delta`/`finish_reason` (and
 * `usage` when given), followed by `[DONE]`.
 */
function sseResponse(
  model: string,
  choices: ReadonlyArray<{
    delta: Record<string, unknown>;
    finish_reason: string | null;
    message?: Record<string, unknown>;
    usage?: Record<string, number>;
  }>,
): Response {
  const body = [
    ...choices.map(
      ({ usage, ...choice }) =>
        `data: ${JSON.stringify({
          id: "shape",
          object: "chat.completion.chunk",
          created: 1,
          model,
          choices: [{ index: 0, ...choice }],
          ...(usage ? { usage } : {}),
        })}\n\n`,
    ),
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function nvidiaSse(model: string): Response {
  const body = [
    `data: ${JSON.stringify({ id: "retry", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "retry", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("bounded provider turn retry policy", () => {
  it("defaults to eight transport attempts with bounded exponential backoff", () => {
    // The transport window is seven deterministic waits, 51,500 ms in total,
    // inside a 60,000 ms budget, so short route bursts do not exhaust it.
    expect(DEFAULT_PROVIDER_TURN_RETRY_POLICY).toEqual({
      maxAttempts: 8,
      baseDelayMs: 500,
      maxDelayMs: 20_000,
      maxTotalDelayMs: 60_000,
      maxThrottledAttempts: 24,
      maxThrottledTotalDelayMs: 380_000,
      maxBlankAttempts: 3,
    });
    const policy = resolveProviderTurnRetryPolicy();
    const waits = Array.from({ length: policy.maxAttempts - 1 }, (_, index) =>
      providerTurnRetryDelayMs(policy, index + 1),
    );
    expect(waits).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 20_000]);
    expect(waits.reduce((total, value) => total + value, 0)).toBe(51_500);
    expect(waits.reduce((total, value) => total + value, 0)).toBeLessThanOrEqual(
      policy.maxTotalDelayMs,
    );
    expect(providerTurnRetryDelayMs(policy, 9)).toBe(20_000);
  });

  it("keeps the empty-turn bound at three attempts, below the transport bound", () => {
    // An empty turn re-bills its whole input context on every replay; a
    // transport fault that never reached the model does not. Widening the
    // transport window must not widen the empty-turn window.
    const policy = resolveProviderTurnRetryPolicy();
    expect(effectiveBlankAttemptBound(policy)).toBe(3);
    expect(effectiveBlankAttemptBound(policy)).toBeLessThan(policy.maxAttempts);
    // The empty-turn bound cannot exceed the attempt bound it lives inside.
    expect(effectiveBlankAttemptBound(resolveProviderTurnRetryPolicy({ maxAttempts: 2 }))).toBe(2);
    expect(effectiveBlankAttemptBound(resolveProviderTurnRetryPolicy({ maxAttempts: 1 }))).toBe(1);
    expect(
      effectiveBlankAttemptBound(resolveProviderTurnRetryPolicy({ maxBlankAttempts: 5 })),
    ).toBe(5);
  });

  it("rejects a policy that cannot bound itself", () => {
    expect(() => resolveProviderTurnRetryPolicy({ maxAttempts: 0 })).toThrow(/at least 1/u);
    expect(() => resolveProviderTurnRetryPolicy({ maxBlankAttempts: 0 })).toThrow(
      /maxBlankAttempts must be at least 1/u,
    );
    expect(() => resolveProviderTurnRetryPolicy({ maxDelayMs: 1, baseDelayMs: 2 })).toThrow(
      /must not be below baseDelayMs/u,
    );
    expect(() => resolveProviderTurnRetryPolicy({ baseDelayMs: -1 })).toThrow(
      /non-negative safe integer/u,
    );
  });

  it("replays only the closed transport-fault categories", () => {
    expect([...RETRYABLE_PROVIDER_TURN_CATEGORIES]).toEqual([
      "provider-transient",
      "throttled",
      "timeout",
    ]);
    expect(isRetryableProviderTurnFailure("Connection error")).toEqual({
      retryable: true,
      category: "provider-transient",
    });
    // The shapes Pi actually emits: it builds the SDK client with maxRetries 0
    // and formats a non-2xx response status-first, with no keyword at all.
    expect(isRetryableProviderTurnFailure('503: {"message":"Service unavailable"}')).toEqual({
      retryable: true,
      category: "provider-transient",
    });
    expect(isRetryableProviderTurnFailure("503 status code (no body)")).toEqual({
      retryable: true,
      category: "provider-transient",
    });
    expect(
      isRetryableProviderTurnFailure("503 <html><body>503 Service Unavailable</body></html>"),
    ).toEqual({ retryable: true, category: "provider-transient" });
    expect(isRetryableProviderTurnFailure('429: {"message":"Rate limit exceeded"}')).toEqual({
      retryable: true,
      category: "throttled",
    });
    expect(isRetryableProviderTurnFailure("408 status code (no body)")).toEqual({
      retryable: true,
      category: "timeout",
    });
    expect(isRetryableProviderTurnFailure("425 status code (no body)")).toEqual({
      retryable: true,
      category: "provider-transient",
    });
    // Client errors are the model's or DocsFab's fault and do not replay.
    for (const terminal of [
      '400: {"message":"bad request"}',
      "401 status code (no body)",
      "404 not found",
    ]) {
      expect(isRetryableProviderTurnFailure(terminal).retryable).toBe(false);
    }
    expect(isRetryableProviderTurnFailure("HTTP status 503")).toEqual({
      retryable: true,
      category: "provider-transient",
    });
  });

  /**
   * The provider-controlled body travels inside the same message, so a status
   * the body mentions must not outrank the real one. A LiteLLM front door wraps
   * upstream failures as `Error code: NNN - {...}`.
   */
  it.each([
    [
      '503: {"message":"upstream failed","detail":"Error code: 400 - bad"}',
      true,
      "provider-transient",
    ],
    ['503: {"message":"backend said HTTP status 404"}', true, "provider-transient"],
    ['429: {"message":"upstream Error code: 400"}', true, "throttled"],
    ['400: {"message":"bad request","upstream":"HTTP status 503"}', false, "invalid-request"],
    ['401: {"message":"unauthorized; upstream status code 502"}', false, "invalid-request"],
    ['403: {"message":"forbidden; error code 500 downstream"}', false, "invalid-request"],
    ['404: {"message":"not found; status 503 upstream"}', false, "invalid-request"],
  ])(
    "ranks the leading status above any status inside the body: %s",
    (message, retryable, category) => {
      expect(isRetryableProviderTurnFailure(message)).toEqual({ retryable, category });
    },
  );

  it("replays the Inference Hub's LiteLLM 503 despite its Bedrock body words", () => {
    // The hub answered a step's first provider turn with a 503 whose body names
    // ServiceUnavailableError and BedrockException. Pi composes `${status}: ${body}`,
    // so the real status leads and must win over every word inside the body.
    expect(isRetryableProviderTurnFailure(`503: ${LITELLM_BEDROCK_503_BODY}`)).toEqual({
      retryable: true,
      category: "provider-transient",
    });
    // The same body behind a genuine client error stays terminal.
    expect(isRetryableProviderTurnFailure(`400: ${LITELLM_BEDROCK_503_BODY}`)).toEqual({
      retryable: false,
      category: "invalid-request",
    });
  });

  it("still reads DocsFab's own keyword-form diagnostics", () => {
    // These never begin with a three-digit code, so precedence cannot shadow them.
    expect(isRetryableProviderTurnFailure("Provider failed with HTTP status 503")).toEqual({
      retryable: true,
      category: "provider-transient",
    });
    expect(isRetryableProviderTurnFailure("unexpected end of JSON")).toEqual({
      retryable: false,
      category: "malformed-response",
    });
    expect(isRetryableProviderTurnFailure("HTTP status 400")).toEqual({
      retryable: false,
      category: "invalid-request",
    });
  });
});

describe("empty provider turn recognition", () => {
  it("recognizes an empty completed turn and reads its stop metadata", () => {
    expect(
      observeBlankProviderTurn({
        type: "done",
        reason: "stop",
        message: {
          content: [],
          stopReason: "stop",
          rawStopReason: "stop",
          usage: { input: 900, output: 0 },
        },
      } as never),
    ).toEqual({
      stopReason: "stop",
      rawStopReason: "stop",
      usage: { inputTokens: 900, outputTokens: 0 },
      replayable: true,
      lengthStopped: false,
    });
  });

  it("never calls a turn that carried content empty", () => {
    // A turn wrongly called empty would be replayed and its real content thrown
    // away. Thinking-only turns are the live shape this must protect: pi folds
    // a reasoning delta into a thinking block and `assistantText` reads it.
    for (const content of [
      [{ type: "text", text: "answer" }],
      [{ type: "text", text: "   " }],
      [{ type: "thinking", thinking: "reasoning only" }],
      [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
      [{ type: "unknown-block" }],
      "not-an-array",
    ]) {
      expect(
        observeBlankProviderTurn({
          type: "done",
          reason: "stop",
          message: { content, stopReason: "stop" },
        } as never),
      ).toBeUndefined();
    }
  });

  it("is not consulted for a stream that failed", () => {
    expect(
      observeBlankProviderTurn({ type: "error", error: { errorMessage: "boom" } } as never),
    ).toBeUndefined();
  });

  it("refuses to replay a deterministic stop and names it", () => {
    const lengthStop = observeBlankProviderTurn({
      type: "done",
      reason: "length",
      message: { content: [], stopReason: "length", rawStopReason: "length" },
    } as never);
    // Identical replay is pointless; a nudged replay is granted to this shape
    // alone.
    expect(lengthStop?.replayable).toBe(false);
    expect(lengthStop?.lengthStopped).toBe(true);
    expect(describeBlankProviderTurn(lengthStop!)).toBe("stopReason=length finish_reason=length");
    const filtered = observeBlankProviderTurn({
      type: "done",
      reason: "stop",
      message: { content: [], stopReason: "stop", rawStopReason: "content_filter" },
    } as never);
    expect(filtered?.replayable).toBe(false);
    expect(filtered?.lengthStopped).toBe(false);
    expect(describeBlankProviderTurn(filtered!)).toBe(
      "stopReason=stop finish_reason=content_filter",
    );
  });

  it("reads a length stop from either the mapped or the provider's own reason", () => {
    // Pi maps chat-completions `finish_reason: length` to `stopReason: length`;
    // a transport that preserves `max_tokens` says the same thing.
    expect(isLengthStop("length")).toBe(true);
    expect(isLengthStop("stop", "length")).toBe(true);
    expect(isLengthStop("stop", "max_tokens")).toBe(true);
    expect(isLengthStop("stop", "stop")).toBe(false);
    expect(isLengthStop("toolUse", "tool_calls")).toBe(false);
    expect(isLengthStop(undefined, undefined)).toBe(false);
    // A provider error body outranks the stop word: not a length verdict.
    const errored = observeBlankProviderTurn({
      type: "done",
      reason: "length",
      message: {
        content: [],
        stopReason: "length",
        rawStopReason: "length",
        errorMessage: "Provider finish_reason: content_filter",
      },
    } as never);
    expect(errored?.lengthStopped).toBe(false);
  });

  it("builds a bounded, vendor-neutral nudge that names the exact limit", () => {
    const text = lengthStopNudgeText(8_192);
    expect(text).toContain("8,192 tokens");
    expect(text).toContain("finish_reason=length");
    expect(text).toMatch(/tool call's arguments small/u);
    expect(text).toMatch(/terminal answer fits within 8,192 tokens/u);
    expect(text.length).toBeLessThanOrEqual(LENGTH_STOP_NUDGE_MAX_CHARS);
    expect(text).not.toMatch(/anthropic|openai|nvidia|bedrock|claude/iu);
    const nudged = appendLengthStopNudge(
      { messages: [{ role: "user", content: "Produce the report.", timestamp: 1 }] } as never,
      8_192,
      () => 42,
    );
    expect((nudged as { messages: unknown[] }).messages).toEqual([
      { role: "user", content: "Produce the report.", timestamp: 1 },
      { role: "user", content: [{ type: "text", text }], timestamp: 42 },
    ]);
  });
});

describe("bounded provider turn retry stream", () => {
  it("turns a transient failure followed by success into a successful turn", async () => {
    const retries: Array<{ attempt: number; category: string; delayMs: number }> = [];
    const { stream, delegate, slept } = wrap(
      [() => errorStream("Provider turn failed: Connection error"), () => doneStream("OK")],
      {
        onRetry: (event) =>
          retries.push({
            attempt: event.attempt,
            category: event.category,
            delayMs: event.delayMs,
          }),
      },
    );

    const events = await collect(stream({} as never, { messages: [] } as never));

    expect(delegate).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.type)).toEqual(["start", "text_delta", "done"]);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(retries).toEqual([{ attempt: 1, category: "provider-transient", delayMs: 500 }]);
    expect(slept).toEqual([500]);
  });

  it("still fails after the attempt bound when the transient failure persists", async () => {
    const { stream, delegate, slept } = wrap([() => errorStream("Connection error")]);

    const events = await collect(stream({} as never, { messages: [] } as never));

    expect(delegate).toHaveBeenCalledTimes(8);
    expect(events.at(-1)?.type).toBe("error");
    expect(events.at(-1)?.error?.errorMessage).toBe("Connection error");
    expect(slept).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 20_000]);
  });

  /**
   * The route answered `408: {"message":"litellm.Timeout: ... Connection timed
   * out ... time taken=0.003 seconds"}` several times within 1.5 s. The same body
   * with 200 OK behind it must be survived.
   */
  const ROUTE_408_MESSAGE =
    '408: {"message":"litellm.Timeout: BedrockException: Timeout Error - litellm.Timeout: Connection timed out. Timeout passed=Timeout(connect=5.0, read=360.0, write=360.0, pool=360.0), time taken=0.003 seconds"}';

  it("survives a burst of seven 408 faults and completes the turn on the eighth attempt", async () => {
    const retries: Array<{ attempt: number; category: string; delayMs: number }> = [];
    const burst = Array.from({ length: 7 }, () => () => errorStream(ROUTE_408_MESSAGE));
    const { stream, delegate, slept } = wrap([...burst, () => doneStream("OK")], {
      onRetry: (event) =>
        retries.push({ attempt: event.attempt, category: event.category, delayMs: event.delayMs }),
    });

    const events = await collect(stream({} as never, { messages: [] } as never));

    expect(delegate).toHaveBeenCalledTimes(8);
    expect(events.map((event) => event.type)).toEqual(["start", "text_delta", "done"]);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(retries.map((event) => event.category)).toEqual(Array(7).fill("timeout"));
    expect(retries.map((event) => event.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // Exponential, capped at 20,000 ms per wait, 51,500 ms across the turn.
    expect(slept).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 20_000]);
    expect(slept.reduce((total, value) => total + value, 0)).toBe(51_500);
  });

  it("fails a burst of eight 408 faults with the route's own error after the eighth attempt", async () => {
    const { stream, delegate, slept } = wrap([() => errorStream(ROUTE_408_MESSAGE)]);

    const events = await collect(stream({} as never, { messages: [] } as never));

    expect(delegate).toHaveBeenCalledTimes(8);
    expect(events.at(-1)?.type).toBe("error");
    expect(events.at(-1)?.error?.errorMessage).toBe(ROUTE_408_MESSAGE);
    expect(slept).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 20_000]);
    // The published failure is still the retryable timeout the harness names.
    expect(isRetryableProviderTurnFailure(events.at(-1)?.error?.errorMessage)).toEqual({
      retryable: true,
      category: "timeout",
    });
  });

  it("bounds the widened replay window by the composition attempt deadline", async () => {
    // A fake clock that advances with every wait: the deadline is 5,000 ms out,
    // so the waits 500 + 1,000 + 2,000 fit and the fourth (4,000) would cross it.
    let clock = 100_000;
    const { stream, delegate, slept } = wrap([() => errorStream(ROUTE_408_MESSAGE)], {
      now: () => clock,
      deadlineAt: () => 105_000,
      sleep: async (milliseconds) => {
        slept.push(milliseconds);
        clock += milliseconds;
      },
    });

    const events = await collect(stream({} as never, { messages: [] } as never));

    expect(slept).toEqual([500, 1_000, 2_000]);
    expect(delegate).toHaveBeenCalledTimes(4);
    expect(clock).toBeLessThan(105_000);
    expect(events.at(-1)?.type).toBe("error");
    expect(events.at(-1)?.error?.errorMessage).toBe(ROUTE_408_MESSAGE);
  });

  it("holds empty turns to three attempts while transport faults get seven", async () => {
    // Four transport faults, then three empty turns: the transport replays are
    // within the attempt bound, the third empty turn is terminal because the
    // empty-turn bound (3) is spent, not because the attempt bound (9) is.
    const retries: Array<{ attempt: number; category: string }> = [];
    const blanks: Array<{ attempt: number; replayed: boolean }> = [];
    const faults = Array.from({ length: 4 }, () => () => errorStream(ROUTE_408_MESSAGE));
    const { stream, delegate } = wrap([...faults, () => blankStream()], {
      policy: { maxAttempts: 9 },
      onRetry: (event) => retries.push({ attempt: event.attempt, category: event.category }),
      onBlankTurn: (event) => blanks.push({ attempt: event.attempt, replayed: event.replayed }),
    });

    const events = await collect(stream({} as never, { messages: [] } as never));

    expect(delegate).toHaveBeenCalledTimes(7);
    expect(retries.map((event) => event.category)).toEqual([
      "timeout",
      "timeout",
      "timeout",
      "timeout",
      "blank-response",
      "blank-response",
    ]);
    expect(blanks).toEqual([
      { attempt: 5, replayed: true },
      { attempt: 6, replayed: true },
      { attempt: 7, replayed: false },
    ]);
    expect(events.map((event) => event.type)).toEqual(["start", "done"]);
  });

  /** The build.nvidia.com throttle as the provider error message reads it. */
  const ROUTE_429_MESSAGE = '429: {"message":"Rate limit exceeded"}';

  it("outlasts twenty-three throttled replies and lands the turn on the twenty-fourth", async () => {
    const burst = Array.from({ length: 23 }, () => () => errorStream(ROUTE_429_MESSAGE));
    const { stream, delegate, slept } = wrap([...burst, () => doneStream("OK")]);

    const events = await collect(stream({} as never, { messages: [] } as never));

    expect(delegate).toHaveBeenCalledTimes(24);
    expect(events.map((event) => event.type)).toEqual(["start", "text_delta", "done"]);
    // The same capped exponential, 371,500 ms in all, inside the throttled
    // budget and past the 60,000 ms one other faults keep.
    expect(slept.slice(0, 7)).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 20_000]);
    expect(slept.reduce((total, value) => total + value, 0)).toBe(371_500);
  });

  it("ends a turn throttled twenty-four times with attempts-exhausted", async () => {
    const vetoes: Array<{ attempt: number; veto: string }> = [];
    const { stream, delegate } = wrap([() => errorStream(ROUTE_429_MESSAGE)], {
      onReplayVeto: (event) => vetoes.push({ attempt: event.attempt, veto: event.veto }),
    });

    const events = await collect(stream({} as never, { messages: [] } as never));

    expect(delegate).toHaveBeenCalledTimes(24);
    expect(vetoes).toEqual([{ attempt: 24, veto: "attempts-exhausted" }]);
    expect(events.at(-1)?.error?.errorMessage).toBe(ROUTE_429_MESSAGE);
  });

  it("counts throttled and other faults on one counter, bounded by the failure being decided", async () => {
    // Ten 429s spend attempts 1-10; the 503 on attempt 11 is judged by the
    // general bound of 8, so it is not replayed. Separate counters would
    // replay it.
    const vetoes: Array<{ attempt: number; veto: string }> = [];
    const throttles = Array.from({ length: 10 }, () => () => errorStream(ROUTE_429_MESSAGE));
    const { stream, delegate } = wrap(
      [...throttles, () => errorStream(ROUTE_503_MESSAGE), () => doneStream("OK")],
      { onReplayVeto: (event) => vetoes.push({ attempt: event.attempt, veto: event.veto }) },
    );

    const events = await collect(stream({} as never, { messages: [] } as never));

    expect(delegate).toHaveBeenCalledTimes(11);
    expect(vetoes).toEqual([{ attempt: 11, veto: "attempts-exhausted" }]);
    expect(events.at(-1)?.type).toBe("error");
  });

  it("narrows throttled replays with a caller's own attempt and wait bounds", async () => {
    const capped = wrap([() => errorStream(ROUTE_429_MESSAGE)], { policy: { maxAttempts: 3 } });
    await collect(capped.stream({} as never, { messages: [] } as never));
    expect(capped.delegate).toHaveBeenCalledTimes(3);

    // Adjacent: naming the throttled bound keeps it wider than the general one.
    const named = wrap([() => errorStream(ROUTE_429_MESSAGE)], {
      policy: { maxAttempts: 3, maxThrottledAttempts: 5 },
    });
    await collect(named.stream({} as never, { messages: [] } as never));
    expect(named.delegate).toHaveBeenCalledTimes(5);
    // A single general attempt still leaves room for throttled replays.
    const throttledOnly = wrap([() => errorStream(ROUTE_429_MESSAGE)], {
      policy: { maxAttempts: 1, maxThrottledAttempts: 3 },
    });
    await collect(throttledOnly.stream({} as never, { messages: [] } as never));
    expect(throttledOnly.delegate).toHaveBeenCalledTimes(3);

    expect(
      resolveProviderTurnRetryPolicy({ maxTotalDelayMs: 1_000 }).maxThrottledTotalDelayMs,
    ).toBe(1_000);
    expect(() =>
      resolveProviderTurnRetryPolicy({ maxAttempts: 8, maxThrottledAttempts: 7 }),
    ).toThrow("Provider turn retry maxThrottledAttempts must not be below maxAttempts.");
    expect(() => resolveProviderTurnRetryPolicy({ maxThrottledTotalDelayMs: 59_999 })).toThrow(
      "Provider turn retry maxThrottledTotalDelayMs must not be below maxTotalDelayMs.",
    );
  });

  it("stops a throttled turn once its own summed-wait budget is spent", async () => {
    const vetoes: string[] = [];
    const { stream, delegate, slept } = wrap([() => errorStream(ROUTE_429_MESSAGE)], {
      policy: { maxThrottledTotalDelayMs: 100_000 },
      onReplayVeto: (event) => vetoes.push(event.veto),
    });

    await collect(stream({} as never, { messages: [] } as never));

    // 51,500 + 20,000 + 20,000 = 91,500; one more 20,000 would cross 100,000.
    expect(slept.reduce((total, value) => total + value, 0)).toBe(91_500);
    expect(delegate).toHaveBeenCalledTimes(10);
    expect(vetoes).toEqual(["backoff-budget-exhausted"]);
  });

  it("does not replay a non-retryable provider failure", async () => {
    const { stream, delegate, slept } = wrap([
      () => errorStream("HTTP status 400 invalid request"),
    ]);

    const events = await collect(stream({} as never, { messages: [] } as never));

    expect(delegate).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.type).toBe("error");
    expect(slept).toEqual([]);
  });

  it("does not retry when the total backoff budget cannot absorb the next delay", async () => {
    const { stream, delegate } = wrap([() => errorStream("Connection error")], {
      policy: { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 4_000, maxTotalDelayMs: 1_500 },
    });

    await collect(stream({} as never, { messages: [] } as never));

    expect(delegate).toHaveBeenCalledTimes(2);
  });

  it("stops once the across-the-turn backoff budget is spent", async () => {
    // 500 + 1,000 + 2,000 + 4,000 + 8,000 + 16,000 + 20,000 = 51,500; the next
    // 20,000 would cross 60,000, so the budget stops the turn before the
    // attempt bound.
    const { stream, delegate, slept } = wrap([() => errorStream("Connection error")], {
      policy: { maxAttempts: 12 },
    });

    await collect(stream({} as never, { messages: [] } as never));

    expect(slept).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 20_000]);
    expect(slept.reduce((total, value) => total + value, 0)).toBeLessThanOrEqual(
      DEFAULT_PROVIDER_TURN_RETRY_POLICY.maxTotalDelayMs,
    );
    expect(delegate).toHaveBeenCalledTimes(8);
  });

  it("does not retry past the composition attempt deadline", async () => {
    const { stream, delegate } = wrap([() => errorStream("Connection error")], {
      now: () => 10_000,
      deadlineAt: () => 10_200,
    });

    await collect(stream({} as never, { messages: [] } as never));

    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const { stream, delegate } = wrap([() => errorStream("Connection error")]);

    await collect(
      stream({} as never, { messages: [] } as never, { signal: controller.signal } as never),
    );

    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it("does not replay a failure that arrives after the turn produced content", async () => {
    const partialThenFail = () => {
      const stream = new FakeEventStream();
      stream.push({ type: "start" });
      stream.push({ type: "text_delta" });
      stream.push({ type: "error", error: { errorMessage: "Connection error" } });
      return stream;
    };
    const { stream, delegate, slept } = wrap([partialThenFail]);

    const events = await collect(stream({} as never, { messages: [] } as never));

    expect(delegate).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toEqual(["start", "text_delta", "error"]);
    expect(slept).toEqual([]);
  });

  it("honours the host veto on a locally rejected request", async () => {
    const seen: unknown[] = [];
    const { stream, delegate, slept } = wrap([() => errorStream("Connection error")], {
      isReplayable: (streamOptions) => {
        seen.push(streamOptions);
        return false;
      },
    });

    const events = await collect(
      stream({} as never, { messages: [] } as never, { maxTokens: 64 } as never),
    );

    expect(delegate).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.error?.stopReason).toBeUndefined();
    expect(seen).toEqual([{ maxTokens: 64 }]);
    expect(events.at(-1)?.type).toBe("error");
    expect(slept).toEqual([]);
  });

  it("stops when cancellation arrives during the backoff window", async () => {
    // The pre-sleep check cannot cover this: a cancellation that lands while the
    // backoff is in flight must not still issue one more provider request.
    const controller = new AbortController();
    const { stream, delegate } = wrap([() => errorStream("Connection error")], {
      sleep: async () => {
        controller.abort();
      },
    });

    const events = await collect(
      stream({} as never, { messages: [] } as never, { signal: controller.signal } as never),
    );

    expect(delegate).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.type).toBe("error");
    expect(events.at(-1)?.error?.errorMessage).toBe("Connection error");
    // The turn did not fail at the provider; the caller withdrew it. Publishing
    // the held provider error unchanged records a cancellation as a transient
    // provider failure, because the consumer reads stopReason to decide.
    expect(events.at(-1)?.reason).toBe("aborted");
    expect(events.at(-1)?.error?.stopReason).toBe("aborted");
  });

  it("cancels a held blank turn without recording a replay or discarding its usage", async () => {
    const controller = new AbortController();
    const retries: Array<{ attempt: number; category: string }> = [];
    const blanks: Array<{ attempt: number; replayed: boolean; inputTokens: number }> = [];
    const { stream, delegate } = wrap([() => blankStream()], {
      sleep: async () => {
        controller.abort();
      },
      onRetry: (event) => retries.push({ attempt: event.attempt, category: event.category }),
      onBlankTurn: (event) =>
        blanks.push({
          attempt: event.attempt,
          replayed: event.replayed,
          inputTokens: event.usage.inputTokens,
        }),
    });

    const events = await collect(
      stream({} as never, { messages: [] } as never, { signal: controller.signal } as never),
    );

    expect(delegate).toHaveBeenCalledTimes(1);
    expect(retries).toEqual([]);
    expect(blanks).toEqual([{ attempt: 1, replayed: false, inputTokens: 1_200 }]);
    expect(events.map((event) => event.type)).toEqual(["start", "done"]);
    const terminal = events.at(-1);
    expect(terminal?.reason).toBe("aborted");
    expect((terminal?.message as { stopReason?: string } | undefined)?.stopReason).toBe("aborted");
    expect((terminal?.message as { usage?: unknown } | undefined)?.usage).toEqual({
      input: 1_200,
      output: 0,
    });
  });

  it("settles the real backoff the moment the signal aborts", async () => {
    // The wrapper's injected sleep cannot prove this: only the shipped sleep
    // decides whether a cancellation waits out the full delay.
    const controller = new AbortController();
    const started = Date.now();
    const waiting = providerTurnBackoffSleep(60_000, controller.signal);
    controller.abort();
    await waiting;
    expect(Date.now() - started).toBeLessThan(1_000);

    // An already-aborted signal never schedules a timer at all.
    await providerTurnBackoffSleep(60_000, controller.signal);
  });

  it("hands the caller's signal to the backoff so cancellation is not waited out", async () => {
    const controller = new AbortController();
    const { stream, abortSignals } = wrap([() => errorStream("Connection error")]);

    await collect(
      stream({} as never, { messages: [] } as never, { signal: controller.signal } as never),
    );

    expect(abortSignals).toContain(controller.signal);
  });

  it("replays an empty provider turn and lets the run continue", async () => {
    // An empty turn carries nothing, so replacing it costs nothing.
    const retries: Array<{ attempt: number; category: string }> = [];
    const blanks: Array<{ attempt: number; replayed: boolean; inputTokens: number }> = [];
    const { stream, delegate, slept } = wrap([() => blankStream(), () => doneStream("OK")], {
      onRetry: (event) => retries.push({ attempt: event.attempt, category: event.category }),
      onBlankTurn: (event) =>
        blanks.push({
          attempt: event.attempt,
          replayed: event.replayed,
          inputTokens: event.usage.inputTokens,
        }),
    });

    const events = await collect(stream({} as never, { messages: [] } as never));

    expect(delegate).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.type)).toEqual(["start", "text_delta", "done"]);
    expect(retries).toEqual([{ attempt: 1, category: "blank-response" }]);
    expect(blanks).toEqual([{ attempt: 1, replayed: true, inputTokens: 1_200 }]);
    expect(slept).toEqual([500]);
  });

  it("fails after exactly the attempt bound when every replay comes back empty", async () => {
    const blanks: Array<{ attempt: number; replayed: boolean }> = [];
    const { stream, delegate, slept } = wrap([() => blankStream()], {
      onBlankTurn: (event) => blanks.push({ attempt: event.attempt, replayed: event.replayed }),
    });

    const events = await collect(stream({} as never, { messages: [] } as never));

    // Bounded attempts, and the last empty turn is still published so the harness
    // fails the step on real evidence. The wider transport bound does not apply
    // to empty turns.
    expect(delegate).toHaveBeenCalledTimes(DEFAULT_PROVIDER_TURN_RETRY_POLICY.maxBlankAttempts);
    expect(delegate).toHaveBeenCalledTimes(3);
    expect(blanks).toEqual([
      { attempt: 1, replayed: true },
      { attempt: 2, replayed: true },
      { attempt: 3, replayed: false },
    ]);
    expect(events.map((event) => event.type)).toEqual(["start", "done"]);
    expect(slept).toEqual([500, 1_000]);
  });

  it.each([
    ["stop", "content_filter"],
    ["deferred", undefined],
  ] as const)(
    "does not replay an empty turn that stopped for reason %s/%s",
    async (reason, rawStopReason) => {
      const blanks: Array<{ attempt: number; replayed: boolean }> = [];
      const { stream, delegate, slept } = wrap(
        [() => blankStream({ reason, ...(rawStopReason ? { rawStopReason } : {}) })],
        {
          onBlankTurn: (event) => blanks.push({ attempt: event.attempt, replayed: event.replayed }),
        },
      );

      const events = await collect(stream({} as never, { messages: [] } as never));

      expect(delegate).toHaveBeenCalledTimes(1);
      expect(blanks).toEqual([{ attempt: 1, replayed: false }]);
      expect(events.at(-1)?.type).toBe("done");
      expect(slept).toEqual([]);
    },
  );

  /**
   * A turn that spent its whole output budget with nothing surfaced: blank with
   * finish_reason=length.
   */
  const lengthBlank = (): FakeEventStream =>
    blankStream({
      reason: "length",
      rawStopReason: "length",
      usage: { input: 52_486, output: 8_192 },
    });
  const request = () =>
    ({ messages: [{ role: "user", content: "Produce the report.", timestamp: 1 }] }) as never;

  it("replays a blank turn that stopped at the output limit once, with the length nudge appended", async () => {
    const retries: Array<{ attempt: number; category: string; nudged: boolean }> = [];
    const blanks: Array<{ attempt: number; replayed: boolean; outputTokens: number }> = [];
    const { stream, delegate, slept } = wrap([lengthBlank, () => doneStream("OK")], {
      now: () => 1_000,
      onRetry: (event) =>
        retries.push({ attempt: event.attempt, category: event.category, nudged: event.nudged }),
      onBlankTurn: (event) =>
        blanks.push({
          attempt: event.attempt,
          replayed: event.replayed,
          outputTokens: event.usage.outputTokens,
        }),
    });

    const events = await collect(
      stream({ maxTokens: 16_384 } as never, request(), { maxTokens: 8_192 } as never),
    );

    expect(delegate).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.type)).toEqual(["start", "text_delta", "done"]);
    expect(retries).toEqual([{ attempt: 1, category: "blank-response", nudged: true }]);
    expect(blanks).toEqual([{ attempt: 1, replayed: true, outputTokens: 8_192 }]);
    expect(slept).toEqual([500]);
    // The replay is not the identical request: the governed conversation plus
    // exactly one user message naming the authorized limit (the governor's
    // maxTokens, not the model ceiling), with the original context untouched.
    const contextOf = (call: number): { messages: unknown[] } =>
      (delegate.mock.calls[call] as unknown as [unknown, { messages: unknown[] }])[1];
    const replayContext = contextOf(1);
    expect(contextOf(0).messages).toHaveLength(1);
    expect(replayContext.messages).toHaveLength(2);
    expect(replayContext.messages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: lengthStopNudgeText(8_192) }],
      timestamp: 1_000,
    });
    expect(JSON.stringify(replayContext.messages[1])).toContain("8,192 tokens");
    expect(JSON.stringify(replayContext.messages[1])).not.toContain("16,384");
  });

  it("names the model ceiling when no governor set a per-turn limit", async () => {
    const { stream, delegate } = wrap([lengthBlank, () => doneStream("OK")]);

    await collect(stream({ maxTokens: 16_384 } as never, request()));

    const [, replayContext] = delegate.mock.calls[1] as unknown as [
      unknown,
      { messages: Array<{ content: unknown }> },
    ];
    expect(JSON.stringify(replayContext.messages[1]!.content)).toContain("16,384 tokens");
  });

  it("grants the length nudge exactly once and then publishes the second cut for the harness to name", async () => {
    const retries: Array<{ attempt: number; nudged: boolean }> = [];
    const blanks: Array<{ attempt: number; replayed: boolean }> = [];
    const { stream, delegate } = wrap([lengthBlank], {
      onRetry: (event) => retries.push({ attempt: event.attempt, nudged: event.nudged }),
      onBlankTurn: (event) => blanks.push({ attempt: event.attempt, replayed: event.replayed }),
    });

    const events = await collect(stream({} as never, request(), { maxTokens: 8_192 } as never));

    // Two requests, not three: the attempt bound (3) is not the bound here. A
    // third identical answer would cost another full output budget.
    expect(MAX_LENGTH_STOP_NUDGED_REPLAYS).toBe(1);
    expect(delegate).toHaveBeenCalledTimes(1 + MAX_LENGTH_STOP_NUDGED_REPLAYS);
    expect(retries).toEqual([{ attempt: 1, nudged: true }]);
    expect(blanks).toEqual([
      { attempt: 1, replayed: true },
      { attempt: 2, replayed: false },
    ]);
    expect(events.at(-1)?.type).toBe("done");
    // The published second cut still carries the length verdict, so the harness
    // classifies it as output-truncated, not as an ordinary blank.
    const published = (events.at(-1) as { message?: { stopReason?: string } }).message;
    expect(published?.stopReason).toBe("length");
  });

  it("keeps the nudge on every later replay of the turn, including after a transient fault", async () => {
    // Once nudged, the turn's request is the nudged one. Re-sending the original
    // after the nudge would fail the payload finalizer's re-sealed digest and turn
    // a hub 503 on the nudged attempt into turn-evidence-authority.
    const retries: Array<{ attempt: number; category: string; nudged: boolean }> = [];
    const { stream, delegate } = wrap(
      [lengthBlank, () => errorStream("Connection error"), () => doneStream("OK")],
      {
        now: () => 1_000,
        onRetry: (event) =>
          retries.push({ attempt: event.attempt, category: event.category, nudged: event.nudged }),
      },
    );

    const events = await collect(stream({} as never, request(), { maxTokens: 8_192 } as never));

    expect(delegate).toHaveBeenCalledTimes(3);
    expect(events.at(-1)?.type).toBe("done");
    expect(retries).toEqual([
      { attempt: 1, category: "blank-response", nudged: true },
      { attempt: 2, category: "provider-transient", nudged: false },
    ]);
    const contextOf = (call: number): { messages: unknown[] } =>
      (delegate.mock.calls[call] as unknown as [unknown, { messages: unknown[] }])[1];
    expect(contextOf(0).messages).toHaveLength(1);
    expect(contextOf(1).messages).toHaveLength(2);
    // The third request is the nudged request again, byte for byte.
    expect(contextOf(2)).toEqual(contextOf(1));
    // Still one nudge: the transient replay did not append a second.
    expect(contextOf(2).messages).toHaveLength(2);
  });

  it.each([
    ["the host veto", { isReplayable: () => false }],
    ["the attempt deadline", { deadlineAt: () => 1_000, now: () => 900 }],
    ["the backoff budget", { policy: { maxTotalDelayMs: 100 } }],
  ] as const)("does not nudge a length-stopped blank turn past %s", async (_label, options) => {
    const blanks: Array<{ attempt: number; replayed: boolean }> = [];
    const { stream, delegate } = wrap([lengthBlank, () => doneStream("OK")], {
      ...options,
      onBlankTurn: (event) => blanks.push({ attempt: event.attempt, replayed: event.replayed }),
    });

    const events = await collect(stream({} as never, request(), { maxTokens: 8_192 } as never));

    expect(delegate).toHaveBeenCalledTimes(1);
    expect(blanks).toEqual([{ attempt: 1, replayed: false }]);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("does not nudge a length-stopped blank turn once the caller aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { stream, delegate } = wrap([lengthBlank, () => doneStream("OK")]);

    await collect(
      stream({} as never, request(), { maxTokens: 8_192, signal: controller.signal } as never),
    );

    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it("leaves a committed turn that stopped at the output limit alone", async () => {
    // Once a content event has been published, a replay would put a second
    // message behind half of a first one, which is corruption, so the wrapper does
    // not nudge partial text. The harness keeps it as `text-truncated`.
    const textCut = (): FakeEventStream => {
      const stream = new FakeEventStream();
      stream.push({ type: "start" });
      stream.push({ type: "text_delta" });
      stream.push({
        type: "done",
        reason: "length",
        message: {
          content: [{ type: "text", text: "# Quality report\n\n## Findings\n1. The" }],
          stopReason: "length",
          rawStopReason: "length",
          usage: { input: 52_486, output: 8_192 },
        },
      });
      return stream;
    };
    // Streamed truncated tool call: Pi's own agent loop refuses to execute it
    // and asks the model to re-issue; the harness bounds that repeat.
    const toolCut = (): FakeEventStream => {
      const stream = new FakeEventStream();
      stream.push({ type: "start" });
      stream.push({ type: "toolcall_start" });
      stream.push({
        type: "done",
        reason: "length",
        message: {
          content: [
            {
              type: "toolCall",
              id: "call_1",
              name: "canon_submit_artifact",
              arguments: { artifact: "quality-report.md", content: "# Quality re" },
            },
          ],
          stopReason: "length",
          rawStopReason: "length",
          usage: { input: 52_486, output: 8_192 },
        },
      });
      return stream;
    };
    for (const factory of [textCut, toolCut]) {
      const retries: unknown[] = [];
      const blanks: unknown[] = [];
      const { stream, delegate } = wrap([factory, () => doneStream("OK")], {
        onRetry: (event) => retries.push(event),
        onBlankTurn: (event) => blanks.push(event),
      });

      const events = await collect(stream({} as never, request(), { maxTokens: 8_192 } as never));

      expect(delegate).toHaveBeenCalledTimes(1);
      expect(retries).toEqual([]);
      expect(blanks).toEqual([]);
      expect(events.at(-1)?.type).toBe("done");
      const published = (events.at(-1) as { message?: { content?: unknown[] } }).message;
      // The partial content is published, not discarded as blank.
      expect(published?.content).toHaveLength(1);
    }
  });

  /**
   * A veto is a decision about this occurrence, not a verdict about the
   * condition. Both stops below refuse to replay a fault the classifier calls
   * retryable, and the published failure keeps that verdict, so the record can
   * say "eligible, not retried" rather than "terminal".
   */
  it("vetoes the replay of a retryable condition without reclassifying it", async () => {
    const committedTransient = (): FakeEventStream => {
      const stream = new FakeEventStream();
      stream.push({ type: "start" });
      stream.push({ type: "text_delta" });
      stream.push({ type: "error", error: { errorMessage: ROUTE_503_MESSAGE } });
      return stream;
    };
    const vetoed = [
      // The partial-stream veto: content was already published.
      { label: "partial-stream", factory: committedTransient, options: {} },
      // The local-denial veto: DocsFab refused the request, so the provider
      // never answered and an identical replay would be refused identically.
      {
        label: "local-denial",
        factory: () => errorStream(ROUTE_503_MESSAGE),
        options: { isReplayable: () => false },
      },
    ] as const;

    for (const { label, factory, options } of vetoed) {
      const retries: unknown[] = [];
      const { stream, delegate } = wrap([factory, () => doneStream("OK")], {
        ...options,
        onRetry: (event) => retries.push(event),
      });

      const events = await collect(stream({} as never, { messages: [] } as never));

      expect(delegate, label).toHaveBeenCalledTimes(1);
      expect(retries, label).toEqual([]);
      expect(events.at(-1)?.type, label).toBe("error");
      // The published condition is unchanged: still the retryable transient.
      expect(isRetryableProviderTurnFailure(events.at(-1)?.error?.errorMessage)).toEqual({
        retryable: true,
        category: "provider-transient",
      });
    }

    // Positive control: without either veto the same condition is replayed to
    // the bound, so the assertions above are about the vetoes, not the fault.
    const { stream, delegate } = wrap([() => errorStream(ROUTE_503_MESSAGE)]);
    await collect(stream({} as never, { messages: [] } as never));
    expect(delegate).toHaveBeenCalledTimes(DEFAULT_PROVIDER_TURN_RETRY_POLICY.maxAttempts);
  });

  it("does not replay an empty turn that carried a provider error body", async () => {
    const { stream, delegate } = wrap([
      () => blankStream({ errorMessage: "Provider finish_reason: content_filter" }),
    ]);

    await collect(stream({} as never, { messages: [] } as never));

    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it("passes the stream through unchanged when retries are disabled", async () => {
    const { stream, delegate } = wrap([() => errorStream("Connection error")], {
      policy: { maxAttempts: 1 },
    });

    const events = await collect(stream({} as never, { messages: [] } as never));

    expect(delegate).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.type).toBe("error");
  });
});

describe("bounded provider turn retry evidence", () => {
  it("records the retry once on the governed turn without a second lease preflight", async () => {
    const profile = boundNvidiaProfile();
    let fetchCalls = 0;
    const leasePreflights: number[] = [];
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) throw new TypeError("fetch failed: Connection error");
        return nvidiaSse(profile.modelId);
      },
    });
    const connection = await factory.create(
      {
        profile,
        credential: { family: "nvidia-api-catalog", apiKey: "selected-provider-secret" },
      },
      {
        evidenceIdentity: { repositoryRevision: "d".repeat(40) },
        providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 },
        beforeProviderTurn: (turn) => leasePreflights.push(turn.turn),
      },
    );

    const stream = connection.runtime.streamSimple(connection.model, {
      systemPrompt: DOCSFAB_SYSTEM_PROMPT,
      messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
      tools: [],
    });
    const events = await collect(stream);

    expect(fetchCalls).toBe(2);
    expect(events.at(-1)?.type).toBe("done");
    expect(leasePreflights).toEqual([1]);
    const ledger = connection.turnGovernance?.evidence() ?? [];
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.providerRetries).toBe(1);
    expect(ledger[0]?.finalPayloadSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("counts every empty turn on the governed turn and holds its tokens for the lease", async () => {
    const profile = boundNvidiaProfile();
    let fetchCalls = 0;
    const leasePreflights: number[] = [];
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async () => {
        fetchCalls += 1;
        return fetchCalls === 1 ? blankTurnSse(profile.modelId) : nvidiaSse(profile.modelId);
      },
    });
    const connection = await factory.create(
      {
        profile,
        credential: { family: "nvidia-api-catalog", apiKey: "selected-provider-secret" },
      },
      {
        evidenceIdentity: { repositoryRevision: "b".repeat(40) },
        providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 },
        beforeProviderTurn: (turn) => leasePreflights.push(turn.turn),
      },
    );

    const events = await collect(
      connection.runtime.streamSimple(connection.model, {
        systemPrompt: DOCSFAB_SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
        tools: [],
      }),
    );

    expect(fetchCalls).toBe(2);
    expect(events.at(-1)?.type).toBe("done");
    // One governed turn, one lease preflight: the replay is not a new turn.
    expect(leasePreflights).toEqual([1]);
    const ledger = connection.turnGovernance?.evidence() ?? [];
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.providerRetries).toBe(1);
    expect(ledger[0]?.providerBlankTurns).toBe(1);
    // The discarded attempt's tokens are held for the harness to charge, and
    // draining is exact: a second drain must not charge them twice.
    expect(connection.discardedProviderUsage?.drain()).toEqual({
      turns: 1,
      inputTokens: 700,
      outputTokens: 0,
    });
    expect(connection.discardedProviderUsage?.drain()).toEqual({
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it("replays a hub 503 on the first provider turn and counts the attempts", async () => {
    const profile = boundNvidiaProfile();
    let fetchCalls = 0;
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async () => {
        fetchCalls += 1;
        return hubUnavailableResponse();
      },
    });
    const connection = await factory.create(
      {
        profile,
        credential: { family: "nvidia-api-catalog", apiKey: "selected-provider-secret" },
      },
      {
        evidenceIdentity: { repositoryRevision: "e".repeat(40) },
        providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 },
      },
    );

    const events = await collect(
      connection.runtime.streamSimple(connection.model, {
        systemPrompt: DOCSFAB_SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
        tools: [],
      }),
    );

    expect(fetchCalls).toBe(DEFAULT_PROVIDER_TURN_RETRY_POLICY.maxAttempts);
    expect(fetchCalls).toBe(8);
    expect(events.at(-1)?.type).toBe("error");
    expect(events.at(-1)?.error?.errorMessage).toContain("litellm.ServiceUnavailableError");
    const ledger = connection.turnGovernance?.evidence() ?? [];
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.providerRetries).toBe(7);
  });

  it("announces each replay before its backoff, with the failing status", async () => {
    const profile = boundNvidiaProfile();
    let fetchCalls = 0;
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async () => {
        fetchCalls += 1;
        return fetchCalls < 3 ? hubUnavailableResponse() : nvidiaSse(profile.modelId);
      },
    });
    const connection = await factory.create(
      {
        profile,
        credential: { family: "nvidia-api-catalog", apiKey: "selected-provider-secret" },
      },
      {
        evidenceIdentity: { repositoryRevision: "f".repeat(40) },
        providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 },
      },
    );
    const notices: unknown[] = [];
    const unsubscribe = connection.providerTransport!.onRetryBackoff((notice) =>
      notices.push(notice),
    );
    const request = {
      systemPrompt: DOCSFAB_SYSTEM_PROMPT,
      messages: [{ role: "user" as const, content: "Reply OK.", timestamp: 1 }],
      tools: [],
    };

    expect(
      (await collect(connection.runtime.streamSimple(connection.model, request))).at(-1)?.type,
    ).toBe("done");
    const notice = {
      maxAttempts: DEFAULT_PROVIDER_TURN_RETRY_POLICY.maxAttempts,
      category: "provider-transient",
      delayMs: 0,
      httpStatus: 503,
    };
    expect(notices).toEqual([
      { attempt: 1, ...notice },
      { attempt: 2, ...notice },
    ]);

    unsubscribe();
    fetchCalls = 0;
    await collect(connection.runtime.streamSimple(connection.model, request));
    expect(fetchCalls).toBe(3);
    expect(notices).toHaveLength(2);
  });

  it("keeps replaying when a backoff listener throws", async () => {
    const profile = boundNvidiaProfile();
    let fetchCalls = 0;
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async () => {
        fetchCalls += 1;
        return fetchCalls === 1 ? hubUnavailableResponse() : nvidiaSse(profile.modelId);
      },
    });
    const connection = await factory.create(
      {
        profile,
        credential: { family: "nvidia-api-catalog", apiKey: "selected-provider-secret" },
      },
      {
        evidenceIdentity: { repositoryRevision: "1".repeat(40) },
        providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 },
      },
    );
    connection.providerTransport!.onRetryBackoff(() => {
      throw new Error("display failed");
    });
    const events = await collect(
      connection.runtime.streamSimple(connection.model, {
        systemPrompt: DOCSFAB_SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
        tools: [],
      }),
    );
    expect(fetchCalls).toBe(2);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("names an exhausted spend budget from the 429 status, never its body", async () => {
    const profile = boundNvidiaProfile();
    const body = JSON.stringify({
      error: {
        message: "Budget has been exceeded! Key=PRIVATE-key-alias (sk-...PRIV) Max budget: 0.0",
        type: "budget_exceeded",
        code: "429",
      },
    });
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async () =>
        new Response(body, { status: 429, headers: { "content-type": "application/json" } }),
    });
    const connection = await factory.create(
      {
        profile,
        credential: { family: "nvidia-api-catalog", apiKey: "selected-provider-secret" },
      },
      {
        evidenceIdentity: { repositoryRevision: "0".repeat(40) },
        providerTurnRetry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      },
    );
    const notices: ProviderRetryNotice[] = [];
    connection.providerTransport!.onRetryBackoff((notice) => notices.push(notice));

    const events = await collect(
      connection.runtime.streamSimple(connection.model, {
        systemPrompt: DOCSFAB_SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
        tools: [],
      }),
    );

    expect(notices).toEqual([
      { attempt: 1, maxAttempts: 2, category: "throttled", delayMs: 0, httpStatus: 429 },
    ]);
    const failed = events.at(-1)?.error as object;
    const { providerError } = observeLandedProviderTurn(
      failed,
      connection.providerTransport!.lastExchange(),
    );
    expect(providerError).toEqual({ class: "rate-limit", httpStatus: 429 });
    const reason = providerFailureReason(providerError!, notices.length + 1);
    expect(reason).toContain("spend budget is used up (HTTP 429)");
    expect(reason).toContain("DocsFab tried 2 times.");
    expect(reason).not.toContain("PRIV");
  });

  /**
   * A route 408 through the real connection factory and pi-ai's real
   * chat-completions adapter. No credential; the vendor words are body text and
   * 408 is the status that decides.
   */
  const ROUTE_408_BODY = JSON.stringify({
    message:
      "litellm.Timeout: BedrockException: Timeout Error - litellm.Timeout: Connection timed out. Timeout passed=Timeout(connect=5.0, read=360.0, write=360.0, pool=360.0), time taken=0.003 seconds\n\nDeployment Info: request_timeout: None\ntimeout: None.",
  });
  const routeTimeoutResponse = (): Response =>
    new Response(ROUTE_408_BODY, {
      status: 408,
      statusText: "Request Timeout",
      headers: { "content-type": "application/json" },
    });

  async function runRouteTimeoutBurst(faults: number): Promise<{
    fetchCalls: number;
    events: ProviderEvent[];
    ledger: Array<{
      turn: number;
      providerRetries?: number;
      providerBlankTurns?: number;
      finalPayloadSha256?: string;
    }>;
  }> {
    const profile = boundNvidiaProfile();
    let fetchCalls = 0;
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async () => {
        fetchCalls += 1;
        return fetchCalls <= faults ? routeTimeoutResponse() : nvidiaSse(profile.modelId);
      },
    });
    const connection = await factory.create(
      {
        profile,
        credential: { family: "nvidia-api-catalog", apiKey: "selected-provider-secret" },
      },
      {
        evidenceIdentity: { repositoryRevision: "7".repeat(40) },
        // Backoff collapsed: these tests count requests, not seconds.
        providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 },
      },
    );
    const events = await collect(
      connection.runtime.streamSimple(connection.model, {
        systemPrompt: DOCSFAB_SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
        tools: [],
      }),
    );
    return { fetchCalls, events, ledger: connection.turnGovernance?.evidence() ?? [] };
  }

  it("lands a governed turn behind seven route 408 faults and records seven replays on one ledger row", async () => {
    const { fetchCalls, events, ledger } = await runRouteTimeoutBurst(7);

    expect(fetchCalls).toBe(8);
    expect(events.at(-1)?.type).toBe("done");
    expect(events.some((event) => event.type === "error")).toBe(false);
    // One ledger row, one governed turn: the replays are attempts, not turns.
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ turn: 1, providerRetries: 7 });
    expect(ledger[0]?.providerBlankTurns).toBeUndefined();
    expect(ledger[0]?.finalPayloadSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("names eight provider attempts and stays a retryable timeout when the burst outlasts the window", async () => {
    const { fetchCalls, events, ledger } = await runRouteTimeoutBurst(8);

    expect(fetchCalls).toBe(8);
    expect(events.at(-1)?.type).toBe("error");
    expect(ledger[0]?.providerRetries).toBe(7);
    // The harness composes the terminal line from the ledger's attempt count.
    const published = (events.at(-1) as { error?: object }).error!;
    const failure = assistantTurnFailure(published, {
      providerAttempts: (ledger[0]?.providerRetries ?? 0) + 1,
    });
    expect(failure?.disposition).toBe("provider-failed");
    expect(failure?.reason).toBe("provider-terminal");
    // pi-ai's chat-completions adapter renders the status first ("408 status
    // code ...") and does not echo a top-level `message` body. Both shapes lead
    // with the status, which is what decides.
    expect(failure?.detail).toMatch(/^8 provider attempts: 408\b/u);
    expect(failure?.classification).toEqual({ category: "timeout", retryable: true });
  });

  it("leaves the turn ledger byte-identical for a turn that needed no replay", async () => {
    // The retry policy must not change the record of an ordinary turn: the
    // default-policy ledger equals, as JSON, a ledger with replays disabled.
    const ledgers: string[] = [];
    for (const providerTurnRetry of [undefined, { maxAttempts: 1 }]) {
      const profile = boundNvidiaProfile();
      const factory = createProviderConnectionFactory({
        routeId: profile.routeId,
        transport: profile.transport,
        fetch: async () => nvidiaSse(profile.modelId),
      });
      const connection = await factory.create(
        {
          profile,
          credential: { family: "nvidia-api-catalog", apiKey: "selected-provider-secret" },
        },
        {
          evidenceIdentity: { repositoryRevision: "9".repeat(40) },
          ...(providerTurnRetry ? { providerTurnRetry } : {}),
        },
      );
      const events = await collect(
        connection.runtime.streamSimple(connection.model, {
          systemPrompt: DOCSFAB_SYSTEM_PROMPT,
          messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
          tools: [],
        }),
      );
      expect(events.at(-1)?.type).toBe("done");
      const ledger = connection.turnGovernance?.evidence() ?? [];
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).not.toHaveProperty("providerRetries");
      expect(ledger[0]).not.toHaveProperty("providerBlankTurns");
      ledgers.push(JSON.stringify(ledger));
    }
    expect(ledgers[0]).toBe(ledgers[1]);
  });

  it("records a terminal empty turn that no replay could fix", async () => {
    const profile = boundNvidiaProfile();
    let fetchCalls = 0;
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async () => {
        fetchCalls += 1;
        return blankTurnSse(profile.modelId);
      },
    });
    const connection = await factory.create(
      {
        profile,
        credential: { family: "nvidia-api-catalog", apiKey: "selected-provider-secret" },
      },
      {
        evidenceIdentity: { repositoryRevision: "c".repeat(40) },
        providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 },
      },
    );

    const events = await collect(
      connection.runtime.streamSimple(connection.model, {
        systemPrompt: DOCSFAB_SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
        tools: [],
      }),
    );

    // Empty turns keep their own three-attempt bound, separate from the transport
    // window: each one billed 700 input tokens.
    expect(fetchCalls).toBe(DEFAULT_PROVIDER_TURN_RETRY_POLICY.maxBlankAttempts);
    expect(fetchCalls).toBe(3);
    expect(events.at(-1)?.type).toBe("done");
    const ledger = connection.turnGovernance?.evidence() ?? [];
    // The last empty turn lands after the final payload hook ran, so it reaches
    // evidence only if the ledger entry is rewritten when it is observed.
    expect(ledger[0]?.providerRetries).toBe(2);
    expect(ledger[0]?.providerBlankTurns).toBe(3);
  });

  /**
   * A length-stopped blank turn through the real connection factory, payload
   * finalizer, and pi-ai chat-completions adapter: 8,192 output tokens billed,
   * finish_reason=length, no delta of any kind.
   */
  const LIVE_LENGTH_USAGE = {
    prompt_tokens: 52_486,
    completion_tokens: 8_192,
    total_tokens: 60_678,
  };
  const lengthBlankSse = (model: string): Response =>
    sseResponse(model, [
      { delta: { role: "assistant" }, finish_reason: null },
      { delta: {}, finish_reason: "length", usage: LIVE_LENGTH_USAGE },
    ]);
  const requestBodies = (
    calls: ReadonlyArray<readonly unknown[]>,
  ): Array<Record<string, unknown>> =>
    calls.map(
      ([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
    );

  it("sends the nudged replay of a length-stopped blank turn and reseals the payload digest to it", async () => {
    const profile = boundNvidiaProfile();
    const fetchSpy = vi.fn(async () =>
      fetchSpy.mock.calls.length === 1
        ? lengthBlankSse(profile.modelId)
        : nvidiaSse(profile.modelId),
    );
    const leasePreflights: number[] = [];
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const connection = await factory.create(
      {
        profile,
        credential: { family: "nvidia-api-catalog", apiKey: "selected-provider-secret" },
      },
      {
        evidenceIdentity: { repositoryRevision: "e".repeat(40) },
        providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 },
        beforeProviderTurn: (turn) => leasePreflights.push(turn.turn),
      },
    );

    const events = await collect(
      connection.runtime.streamSimple(connection.model, {
        systemPrompt: DOCSFAB_SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Produce the report.", timestamp: 1 }],
        tools: [],
      }),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(events.at(-1)?.type).toBe("done");
    // One governed turn, one lease preflight: the nudged replay is not a new turn.
    expect(leasePreflights).toEqual([1]);
    const [first, replay] = requestBodies(fetchSpy.mock.calls);
    const firstMessages = first!.messages as Array<Record<string, unknown>>;
    const replayMessages = replay!.messages as Array<Record<string, unknown>>;
    // The wire shows the nudge: same request plus exactly one trailing user
    // message naming the governed limit, and nothing else moved.
    expect(replayMessages).toHaveLength(firstMessages.length + 1);
    expect(replayMessages.slice(0, -1)).toEqual(firstMessages);
    expect(replayMessages.at(-1)).toMatchObject({ role: "user" });
    expect(JSON.stringify(replayMessages.at(-1))).toContain(
      `output limit of ${profile.profile.maxOutputTokens.toLocaleString("en-US")} tokens`,
    );
    expect(replay!.max_tokens).toBe(first!.max_tokens);
    const ledger = connection.turnGovernance?.evidence() ?? [];
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ providerRetries: 1, providerBlankTurns: 1 });
    // The ledger names the payload that produced the settled turn: the nudged
    // one, whose digest is the canonical digest of the exact bytes sent.
    expect(ledger[0]?.finalPayloadSha256).toBe(canonicalDigest(replay));
    expect(ledger[0]?.finalPayloadSha256).not.toBe(canonicalDigest(first));
    expect(ledger[0]?.requestPolicySha256).toBe(profile.compositionRequestPolicy?.policySha256);
    // The discarded cut's 8,192 output tokens are held for the lease.
    expect(connection.discardedProviderUsage?.drain()).toEqual({
      turns: 1,
      inputTokens: 52_486,
      outputTokens: 8_192,
    });
  });

  it("records both cuts, within the counter invariant, when the nudged replay also stops at the limit", async () => {
    const profile = boundNvidiaProfile();
    let fetchCalls = 0;
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async () => {
        fetchCalls += 1;
        return lengthBlankSse(profile.modelId);
      },
    });
    const connection = await factory.create(
      {
        profile,
        credential: { family: "nvidia-api-catalog", apiKey: "selected-provider-secret" },
      },
      {
        evidenceIdentity: { repositoryRevision: "2".repeat(40) },
        providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 },
      },
    );

    const events = await collect(
      connection.runtime.streamSimple(connection.model, {
        systemPrompt: DOCSFAB_SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Produce the report.", timestamp: 1 }],
        tools: [],
      }),
    );

    // Exactly one nudged replay; the three-attempt bound does not apply.
    expect(fetchCalls).toBe(2);
    expect(events.at(-1)?.type).toBe("done");
    const ledger = connection.turnGovernance?.evidence() ?? [];
    expect(ledger[0]).toMatchObject({ providerRetries: 1, providerBlankTurns: 2 });
    // providerBlankTurns <= providerRetries + 1, the invariant the run-record
    // validators pin; a second nudged replay would break it.
    expect(ledger[0]!.providerBlankTurns!).toBeLessThanOrEqual(ledger[0]!.providerRetries! + 1);
    // The published second cut carries the shape the harness names.
    const published = (events.at(-1) as { message?: object }).message!;
    const failure = assistantTurnFailure(published, {
      blankProviderTurns: ledger[0]?.providerBlankTurns,
      providerAttempts: (ledger[0]?.providerRetries ?? 0) + 1,
      outputTokenLimit: grantedTurnOutputTokens(ledger[0]!),
    });
    expect(failure?.disposition).toBe("provider-failed");
    expect(failure?.detail).toContain("output-truncated: 2 provider turns");
    expect(failure?.detail).toContain("last turn consumed 8,192 output tokens");
    expect(failure?.detail).toContain(
      `${profile.profile.maxOutputTokens.toLocaleString("en-US")}-token output limit`,
    );
    expect(failure?.classification).toEqual({ category: "malformed-response", retryable: true });
    expect(failure?.condition).toBe("cut-answer");
  });

  /**
   * After the nudged replay, any further replay (a hub 503 or an ordinary empty
   * stop) must be the nudged request. The original request's digest no longer
   * matches the re-sealed ledger and would fail as `turn-evidence-authority`.
   */
  it.each([
    [
      "a hub 503 on the nudged replay",
      () => hubUnavailableResponse(),
      { providerRetries: 2, providerBlankTurns: 1 },
    ],
    [
      "an ordinary empty stop on the nudged replay",
      (model: string) => blankTurnSse(model),
      { providerRetries: 2, providerBlankTurns: 2 },
    ],
  ] as const)(
    "replays the nudged request again after %s and lands",
    async (_label, second, counters) => {
      const profile = boundNvidiaProfile();
      const fetchSpy = vi.fn(async () => {
        const call = fetchSpy.mock.calls.length;
        return call === 1
          ? lengthBlankSse(profile.modelId)
          : call === 2
            ? second(profile.modelId)
            : nvidiaSse(profile.modelId);
      });
      const leasePreflights: number[] = [];
      const factory = createProviderConnectionFactory({
        routeId: profile.routeId,
        transport: profile.transport,
        fetch: fetchSpy as unknown as typeof fetch,
      });
      const connection = await factory.create(
        {
          profile,
          credential: { family: "nvidia-api-catalog", apiKey: "selected-provider-secret" },
        },
        {
          evidenceIdentity: { repositoryRevision: "5".repeat(40) },
          providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 },
          beforeProviderTurn: (turn) => leasePreflights.push(turn.turn),
        },
      );

      const events = await collect(
        connection.runtime.streamSimple(connection.model, {
          systemPrompt: DOCSFAB_SYSTEM_PROMPT,
          messages: [{ role: "user", content: "Produce the report.", timestamp: 1 }],
          tools: [],
        }),
      );

      // Three wire requests, a landed turn, one lease preflight.
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(events.at(-1)?.type).toBe("done");
      expect(leasePreflights).toEqual([1]);
      const [first, nudged, third] = requestBodies(fetchSpy.mock.calls);
      // The third request is the nudged request, byte for byte; not the original.
      expect(third).toEqual(nudged);
      expect(third).not.toEqual(first);
      expect((third!.messages as unknown[]).length).toBe((first!.messages as unknown[]).length + 1);
      const ledger = connection.turnGovernance?.evidence() ?? [];
      expect(ledger).toHaveLength(1);
      // Both retries are recorded, and the ledger names the nudged payload that
      // landed.
      expect(ledger[0]).toMatchObject(counters);
      expect(ledger[0]?.finalPayloadSha256).toBe(canonicalDigest(nudged));
      expect(ledger[0]!.providerBlankTurns!).toBeLessThanOrEqual(ledger[0]!.providerRetries! + 1);
    },
  );

  it("fails closed when the nudged replay reaches the wire without its nudge", async () => {
    // With the nudge dropped, the replay is the identical request the wrapper
    // promised not to send. The finalizer must refuse it as it refuses any other
    // divergence, instead of paying the same cut twice.
    const profile = boundNvidiaProfile();
    let payloadCalls = 0;
    const fetchSpy = vi.fn(async () => lengthBlankSse(profile.modelId));
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const connection = await factory.create(
      {
        profile,
        credential: { family: "nvidia-api-catalog", apiKey: "selected-provider-secret" },
      },
      {
        evidenceIdentity: { repositoryRevision: "3".repeat(40) },
        providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 },
      },
    );

    const events = await collect(
      connection.runtime.streamSimple(
        connection.model,
        {
          systemPrompt: DOCSFAB_SYSTEM_PROMPT,
          messages: [{ role: "user", content: "Produce the report.", timestamp: 1 }],
          tools: [],
        },
        {
          onPayload(payload: unknown) {
            payloadCalls += 1;
            if (payloadCalls === 1) return undefined;
            const raw = payload as { messages: unknown[] };
            return { ...(payload as Record<string, unknown>), messages: raw.messages.slice(0, -1) };
          },
        } as never,
      ),
    );

    expect(payloadCalls).toBe(2);
    // The second request never reached the wire.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.type).toBe("error");
    const ledger = connection.turnGovernance?.evidence() ?? [];
    expect(ledger).toHaveLength(1);
    // The first attempt's digest stands; nothing was re-sealed to a request
    // that never went out, and the cut that was observed is still counted.
    const [first] = requestBodies(fetchSpy.mock.calls);
    expect(ledger[0]?.finalPayloadSha256).toBe(canonicalDigest(first));
    // A replay the wrapper announced and the finalizer refused is one `fetch`,
    // not two requests. The blank turn is what this path observed, so it is the
    // counter written; a retry is promoted by the replay's own payload
    // finalization, which failed here.
    expect(ledger[0]?.providerRetries).toBeUndefined();
    expect(ledger[0]).toMatchObject({ providerBlankTurns: 1 });
    expect(ledger[0]?.requestPolicyRefusal).toBe("payload-authority");
  });

  /**
   * Which response shapes yield a blank length-stopped turn through pi-ai's real
   * chat-completions adapter. A streamed truncated tool call keeps its call, and
   * streamed text is not blank (though it is silently accepted). The blank arises
   * when no recognised delta reaches the adapter: a front door that withholds the
   * truncated call, or content in a field the adapter does not read.
   */
  const truncatedArgs =
    '{"artifact":"quality-report.md","content":"# Quality report\\n\\n## Findings\\n1. The';
  it.each([
    [
      "H1a streamed tool_calls deltas cut mid-JSON",
      [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "canon_submit_artifact", arguments: truncatedArgs.slice(0, 40) },
              },
            ],
          },
          finish_reason: null,
        },
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: truncatedArgs.slice(40) } }] },
          finish_reason: null,
        },
      ],
      { blank: false, contentTypes: ["toolCall"], failure: undefined },
    ],
    [
      "H1b no delta at all (front door withheld the cut) -- the live shape",
      [],
      { blank: true, contentTypes: [], failure: "output-truncated" },
    ],
    [
      "H2 streamed text deltas cut at the limit",
      [
        { delta: { content: "# Quality report\n\n" }, finish_reason: null },
        { delta: { content: "## Findings\n1. The" }, finish_reason: null },
      ],
      { blank: false, contentTypes: ["text"], failure: "text-truncated" },
    ],
    [
      "H3a content in choice.message.content, not delta",
      [
        {
          delta: {},
          message: { role: "assistant", content: "# Quality report" },
          finish_reason: null,
        },
      ],
      { blank: true, contentTypes: [], failure: "output-truncated" },
    ],
    [
      "H3c content in delta.refusal",
      [{ delta: { refusal: "# Quality report" }, finish_reason: null }],
      { blank: true, contentTypes: [], failure: "output-truncated" },
    ],
    [
      "H3d content in delta.reasoning_content",
      [{ delta: { reasoning_content: "# Quality report" }, finish_reason: null }],
      { blank: false, contentTypes: ["thinking"], failure: "text-truncated" },
    ],
  ] as const)("length-stopped shape: %s", async (_label, deltas, expected) => {
    const profile = boundNvidiaProfile();
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async () =>
        sseResponse(profile.modelId, [
          { delta: { role: "assistant" }, finish_reason: null },
          ...deltas,
          { delta: {}, finish_reason: "length", usage: LIVE_LENGTH_USAGE },
        ]),
    });
    const connection = await factory.create(
      {
        profile,
        credential: { family: "nvidia-api-catalog", apiKey: "selected-provider-secret" },
      },
      {
        evidenceIdentity: { repositoryRevision: "4".repeat(40) },
        // Attempt bound 1: observe the adapter's assembly of ONE response.
        providerTurnRetry: { maxAttempts: 1 },
      },
    );

    const events = await collect(
      connection.runtime.streamSimple(connection.model, {
        systemPrompt: DOCSFAB_SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Produce the report.", timestamp: 1 }],
        tools: [],
      }),
    );

    const terminal = events.at(-1) as { type: string; message?: Record<string, unknown> };
    expect(terminal.type).toBe("done");
    const message = terminal.message!;
    expect(message.stopReason).toBe("length");
    expect(message.rawStopReason).toBe("length");
    expect((message.usage as { output: number }).output).toBe(8_192);
    const content = message.content as Array<{ type: string }>;
    expect(content.map((block) => block.type)).toEqual([...expected.contentTypes]);
    expect(observeBlankProviderTurn(terminal as never) !== undefined).toBe(expected.blank);
    const failure = assistantTurnFailure(message, { outputTokenLimit: 8_192 });
    if (expected.failure === undefined) {
      // A streamed truncated tool call is Pi's agent loop's to refuse and
      // re-issue; the classifier leaves it alone.
      expect(failure).toBeUndefined();
    } else {
      expect(failure?.disposition).toBe("provider-failed");
      expect(failure?.detail?.startsWith(`${expected.failure}:`)).toBe(true);
      expect(failure?.detail).toContain("8,192-token output limit");
    }
  });

  it("refuses to send a replay whose payload would differ from the first attempt", async () => {
    const profile = boundNvidiaProfile();
    let fetchCalls = 0;
    let payloadCalls = 0;
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async () => {
        fetchCalls += 1;
        // Attempt 1 fails transiently. A second fetch would mean the divergent
        // replay was authorized, which must not happen.
        if (fetchCalls === 1) throw new TypeError("fetch failed: Connection error");
        return nvidiaSse(profile.modelId);
      },
    });
    const connection = await factory.create(
      {
        profile,
        credential: { family: "nvidia-api-catalog", apiKey: "selected-provider-secret" },
      },
      {
        evidenceIdentity: { repositoryRevision: "f".repeat(40) },
        providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 },
      },
    );

    const stream = connection.runtime.streamSimple(
      connection.model,
      {
        systemPrompt: DOCSFAB_SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
        tools: [],
      },
      {
        onPayload(payload: unknown) {
          payloadCalls += 1;
          if (payloadCalls === 1) return undefined;
          // The replay is no longer the same request.
          const raw = payload as { messages: unknown[] };
          return {
            ...(payload as Record<string, unknown>),
            messages: [...raw.messages, { role: "user", content: "divergent replay" }],
          };
        },
      } as never,
    );
    const events = await collect(stream);

    expect(payloadCalls).toBe(2);
    expect(fetchCalls).toBe(1);
    expect(events.at(-1)?.type).toBe("error");
    const ledger = connection.turnGovernance?.evidence() ?? [];
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.providerRetries).toBeUndefined();
    expect(ledger[0]?.finalPayloadSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(ledger[0]?.requestPolicyRefusal).toBe("payload-authority");
  });

  /**
   * The failure the bounded retry exists for is an endpoint's intermittent 503,
   * not a TCP reset. The provider never emits "HTTP status 503", so these run
   * real 5xx and 429 Response shapes through the real connection factory.
   */
  it.each([
    [
      "503 with a JSON body",
      () =>
        new Response(JSON.stringify({ message: "Service unavailable", type: "server_error" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    ],
    ["503 with no body", () => new Response(null, { status: 503 })],
    [
      "503 with an HTML body",
      () =>
        new Response("<html><body>503 Service Unavailable</body></html>", {
          status: 503,
          headers: { "content-type": "text/html" },
        }),
    ],
    [
      "429 with a JSON body",
      () =>
        new Response(JSON.stringify({ message: "Rate limit exceeded" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    ],
  ])("replays a %s and succeeds on the next attempt", async (_label, failure) => {
    const profile = boundNvidiaProfile();
    let fetchCalls = 0;
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async () => {
        fetchCalls += 1;
        return fetchCalls === 1 ? failure() : nvidiaSse(profile.modelId);
      },
    });
    const connection = await factory.create(
      {
        profile,
        credential: { family: "nvidia-api-catalog", apiKey: "selected-provider-secret" },
      },
      {
        evidenceIdentity: { repositoryRevision: "1".repeat(40) },
        providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 },
      },
    );

    const events = await collect(
      connection.runtime.streamSimple(connection.model, {
        systemPrompt: DOCSFAB_SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
        tools: [],
      }),
    );

    expect(fetchCalls).toBe(2);
    expect(events.at(-1)?.type).toBe("done");
    const ledger = connection.turnGovernance?.evidence() ?? [];
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.providerRetries).toBe(1);
  });

  it("replays a body that dies mid-transfer after the headers arrived", async () => {
    // A reset that lands while the body streams is buffered inside the fetch
    // boundary; DocsFab's own refusal prefix must not veto the replay.
    const profile = boundNvidiaProfile();
    let fetchCalls = 0;
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async () => {
        fetchCalls += 1;
        if (fetchCalls > 1) return nvidiaSse(profile.modelId);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: profile.modelId, choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}\n\n`,
                ),
              );
              controller.error(new Error("read ECONNRESET"));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const connection = await factory.create(
      {
        profile,
        credential: { family: "nvidia-api-catalog", apiKey: "selected-provider-secret" },
      },
      {
        evidenceIdentity: { repositoryRevision: "3".repeat(40) },
        providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 },
      },
    );

    const events = await collect(
      connection.runtime.streamSimple(connection.model, {
        systemPrompt: DOCSFAB_SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
        tools: [],
      }),
    );

    expect(fetchCalls).toBe(2);
    expect(events.at(-1)?.type).toBe("done");
    expect(connection.turnGovernance?.evidence()[0]?.providerRetries).toBe(1);
  });

  it("replays an undici terminated-socket body fault", async () => {
    const profile = boundNvidiaProfile();
    let fetchCalls = 0;
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async () => {
        fetchCalls += 1;
        if (fetchCalls > 1) return nvidiaSse(profile.modelId);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new TypeError("terminated", { cause: new Error("UND_ERR_SOCKET") }));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const connection = await factory.create(
      {
        profile,
        credential: { family: "nvidia-api-catalog", apiKey: "selected-provider-secret" },
      },
      {
        evidenceIdentity: { repositoryRevision: "4".repeat(40) },
        providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 },
      },
    );

    const events = await collect(
      connection.runtime.streamSimple(connection.model, {
        systemPrompt: DOCSFAB_SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
        tools: [],
      }),
    );

    expect(fetchCalls).toBe(2);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("replays a real 503 whose body names an upstream 4xx", async () => {
    const profile = boundNvidiaProfile();
    let fetchCalls = 0;
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async () => {
        fetchCalls += 1;
        return fetchCalls === 1
          ? new Response(
              JSON.stringify({ message: "litellm.BadRequestError: Error code: 400 - upstream" }),
              { status: 503, headers: { "content-type": "application/json" } },
            )
          : nvidiaSse(profile.modelId);
      },
    });
    const connection = await factory.create(
      {
        profile,
        credential: { family: "nvidia-api-catalog", apiKey: "selected-provider-secret" },
      },
      {
        evidenceIdentity: { repositoryRevision: "5".repeat(40) },
        providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 },
      },
    );

    const events = await collect(
      connection.runtime.streamSimple(connection.model, {
        systemPrompt: DOCSFAB_SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
        tools: [],
      }),
    );

    expect(fetchCalls).toBe(2);
    expect(events.at(-1)?.type).toBe("done");
    expect(connection.turnGovernance?.evidence()[0]?.providerRetries).toBe(1);
  });

  it("never replays a real 400 whose body names an upstream 5xx", async () => {
    const profile = boundNvidiaProfile();
    let fetchCalls = 0;
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async () => {
        fetchCalls += 1;
        return new Response(
          JSON.stringify({ message: "bad request; upstream returned HTTP status 503" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      },
    });
    const connection = await factory.create(
      {
        profile,
        credential: { family: "nvidia-api-catalog", apiKey: "selected-provider-secret" },
      },
      {
        evidenceIdentity: { repositoryRevision: "6".repeat(40) },
        providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 },
      },
    );

    const events = await collect(
      connection.runtime.streamSimple(connection.model, {
        systemPrompt: DOCSFAB_SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
        tools: [],
      }),
    );

    expect(fetchCalls).toBe(1);
    expect(events.at(-1)?.type).toBe("error");
  });

  it.each([
    [400, JSON.stringify({ message: "bad request" })],
    [404, JSON.stringify({ message: "not found" })],
  ])("never replays a %s client error", async (status, body) => {
    const profile = boundNvidiaProfile();
    let fetchCalls = 0;
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async () => {
        fetchCalls += 1;
        return new Response(body, { status, headers: { "content-type": "application/json" } });
      },
    });
    const connection = await factory.create(
      {
        profile,
        credential: { family: "nvidia-api-catalog", apiKey: "selected-provider-secret" },
      },
      {
        evidenceIdentity: { repositoryRevision: "2".repeat(40) },
        providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 },
      },
    );

    const events = await collect(
      connection.runtime.streamSimple(connection.model, {
        systemPrompt: DOCSFAB_SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
        tools: [],
      }),
    );

    expect(fetchCalls).toBe(1);
    expect(events.at(-1)?.type).toBe("error");
    expect(connection.turnGovernance?.evidence()[0]?.providerRetries).toBeUndefined();
  });

  it("never records a retry for a request DocsFab itself refused", async () => {
    const profile = boundNvidiaProfile();
    let fetchCalls = 0;
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async () => {
        fetchCalls += 1;
        return new Response(null, {
          status: 302,
          headers: { location: "https://foreign.example.test/private" },
        });
      },
    });
    const connection = await factory.create(
      {
        profile,
        credential: { family: "nvidia-api-catalog", apiKey: "selected-provider-secret" },
      },
      {
        evidenceIdentity: { repositoryRevision: "e".repeat(40) },
        providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 },
      },
    );

    const stream = connection.runtime.streamSimple(connection.model, {
      systemPrompt: DOCSFAB_SYSTEM_PROMPT,
      messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
      tools: [],
    });
    const events = await collect(stream);

    expect(fetchCalls).toBe(1);
    expect(events.at(-1)?.type).toBe("error");
    const ledger = connection.turnGovernance?.evidence() ?? [];
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.providerRetries).toBeUndefined();
  });
});

/**
 * Pins RFC 9110 `Retry-After` on a throttled response: real 429 `Response`
 * objects through the real factory, asserted on the wall clock, which is where
 * the honoured wait is observable. Every policy here clamps at or under 1.5 s.
 */
describe("provider turn retry honours Retry-After through the real boundary", () => {
  const throttled = (retryAfter: string): Response =>
    new Response(JSON.stringify({ message: "Rate limit exceeded" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": retryAfter },
    });

  async function runThrottled(
    retryAfter: string,
    retry: { baseDelayMs: number; maxDelayMs: number; maxTotalDelayMs: number },
  ): Promise<{ fetchCalls: number; events: ProviderEvent[]; elapsedMs: number }> {
    const profile = boundNvidiaProfile();
    let fetchCalls = 0;
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async () => {
        fetchCalls += 1;
        return fetchCalls === 1 ? throttled(retryAfter) : nvidiaSse(profile.modelId);
      },
    });
    const connection = await factory.create(
      {
        profile,
        credential: { family: "nvidia-api-catalog", apiKey: "selected-provider-secret" },
      },
      {
        evidenceIdentity: { repositoryRevision: "3".repeat(40) },
        providerTurnRetry: retry,
      },
    );

    const startedAt = Date.now();
    const events = await collect(
      connection.runtime.streamSimple(connection.model, {
        systemPrompt: DOCSFAB_SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
        tools: [],
      }),
    );
    return { fetchCalls, events, elapsedMs: Date.now() - startedAt };
  }

  it("waits the delta-seconds the throttling front door asked for", async () => {
    // baseDelayMs 0 means the policy's own backoff is nothing: every millisecond
    // of the observed wait came from the header.
    const result = await runThrottled("1", {
      baseDelayMs: 0,
      maxDelayMs: 1_500,
      maxTotalDelayMs: 8_000,
    });

    expect(result.fetchCalls).toBe(2);
    expect(result.events.at(-1)?.type).toBe("done");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(900);
  }, 15_000);

  it("clamps an absurd Retry-After to maxDelayMs instead of hanging the turn", async () => {
    // Twenty digits of seconds is ~3e12 years. Honouring it literally would
    // park the run forever, so maxDelayMs has to win.
    const result = await runThrottled("99999999999999999999", {
      baseDelayMs: 0,
      maxDelayMs: 300,
      maxTotalDelayMs: 8_000,
    });

    expect(result.fetchCalls).toBe(2);
    expect(result.events.at(-1)?.type).toBe("done");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(250);
    expect(result.elapsedMs).toBeLessThan(3_000);
  }, 15_000);

  it.each([
    ["a negative delta", "-5"],
    ["a non-numeric value", "abc"],
    ["an explicit zero", "0"],
    ["a fractional delta RFC 9110 does not allow", "5.5"],
    ["an HTTP-date already in the past", "Wed, 21 Oct 2015 07:28:00 GMT"],
  ])(
    "treats %s as no request at all rather than an instant replay",
    async (_label, header) => {
      const result = await runThrottled(header, {
        baseDelayMs: 0,
        maxDelayMs: 1_500,
        maxTotalDelayMs: 8_000,
      });

      expect(result.fetchCalls).toBe(2);
      expect(result.events.at(-1)?.type).toBe("done");
      expect(result.elapsedMs).toBeLessThan(700);
    },
    15_000,
  );

  it("honours an HTTP-date Retry-After that is still in the future", async () => {
    const result = await runThrottled(new Date(Date.now() + 1_500).toUTCString(), {
      baseDelayMs: 0,
      maxDelayMs: 1_500,
      maxTotalDelayMs: 8_000,
    });

    expect(result.fetchCalls).toBe(2);
    expect(result.events.at(-1)?.type).toBe("done");
    // toUTCString drops sub-second precision, so the parsed instant is between
    // ~0.5 s and 1.5 s out; anything under 400 ms means the date was ignored.
    expect(result.elapsedMs).toBeGreaterThanOrEqual(400);
  }, 15_000);

  it("refuses the replay when Retry-After exceeds the across-the-turn budget", async () => {
    // The server asked for 2 s and the turn may spend 1 s waiting in total. The
    // honoured wait is still bounded: the turn ends on the provider's own error
    // rather than overrunning the budget or silently ignoring the request.
    const result = await runThrottled("2", {
      baseDelayMs: 0,
      maxDelayMs: 4_000,
      maxTotalDelayMs: 1_000,
    });

    expect(result.fetchCalls).toBe(1);
    expect(result.events.at(-1)?.type).toBe("error");
    expect(result.elapsedMs).toBeLessThan(700);
  }, 15_000);
});

describe("provider turn backoff notices", () => {
  const request = {
    systemPrompt: "s",
    messages: [{ role: "user" as const, content: "Reply OK.", timestamp: 1 }],
  };

  it("announces a replay before its wait", async () => {
    const order: string[] = [];
    const { stream } = wrap([() => errorStream("Connection error."), () => doneStream("ok")], {
      sleep: async () => {
        order.push("sleep");
      },
      onBackoff: () => order.push("backoff"),
    });
    await collect(stream({} as never, request as never, {}));
    expect(order).toEqual(["backoff", "sleep"]);
  });

  it("names the throttled bound for a 429 and the general bound otherwise", async () => {
    const policy = DEFAULT_PROVIDER_TURN_RETRY_POLICY;
    expect(policy.maxThrottledAttempts).toBeGreaterThan(policy.maxAttempts);
    const bounds: number[] = [];
    const { stream } = wrap(
      [
        () => errorStream('429: {"message":"Rate limit exceeded"}'),
        () => errorStream("Connection error."),
        () => doneStream("ok"),
      ],
      { onBackoff: (event) => bounds.push(event.maxAttempts) },
    );
    await collect(stream({} as never, request as never, {}));
    expect(bounds).toEqual([policy.maxThrottledAttempts, policy.maxAttempts]);
  });

  it("bounds a blank replay by the blank attempts left after another failure", async () => {
    const policy = DEFAULT_PROVIDER_TURN_RETRY_POLICY;
    const blankBound = effectiveBlankAttemptBound(policy);
    const notices: Array<{ attempt: number; maxAttempts: number }> = [];
    const { stream, delegate } = wrap(
      [
        () => errorStream("Connection error."),
        () => blankStream(),
        () => blankStream(),
        () => doneStream("ok"),
      ],
      { onBackoff: ({ attempt, maxAttempts }) => notices.push({ attempt, maxAttempts }) },
    );
    await collect(stream({} as never, request as never, {}));
    expect(delegate).toHaveBeenCalledTimes(4);
    // Attempt 1 was a transport fault; attempts 2 and 3 were blank. The last
    // reachable attempt is fixed by the blank bound, and never exceeds it.
    const lastBlankAttempt = 1 + blankBound;
    expect(notices).toEqual([
      { attempt: 1, maxAttempts: policy.maxAttempts },
      { attempt: 2, maxAttempts: lastBlankAttempt },
      { attempt: 3, maxAttempts: lastBlankAttempt },
    ]);
    for (const notice of notices)
      expect(notice.attempt + 1).toBeLessThanOrEqual(notice.maxAttempts);
  });
});
