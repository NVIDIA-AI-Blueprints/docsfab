// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Physical provider-attempt accounting under injected faults.
 *
 * `provider-turn-retry` proves the replay behaviour. This suite proves the
 * accounting on top of it: logical governed turns and physical provider
 * requests are two different numbers, the boundary that stopped a replay is
 * recorded rather than recomputed, a step-wide physical bound exists, and all
 * three reach the operator surface.
 *
 * The runner policy owns retries and native provider retry mechanics are not
 * used, so every physical request in these fixtures is one this runtime issued
 * and the counts can be complete rather than approximate.
 *
 * Fault classes exercised: throttling, transient failure, timeout, local
 * denial, partial stream, backoff cancellation, retry exhaustion.
 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { canonicalDigest } from "../src/contract-kit/index.js";
import {
  createRootTaskBudget,
  TASK_BUDGET_DIMENSIONS,
  projectTaskBudget,
  type TaskBudgetDimension,
  type TaskBudgetEnvelope,
} from "../src/execution/task-budget.js";
import type { BoundModelExecutionProfile, ProviderTransport } from "../src/model/configuration.js";
import {
  accountProviderAttempts,
  createPhysicalProviderAttemptLedger,
  maxPhysicalProviderRequestsPerStep,
  PROVIDER_ATTEMPT_ACCOUNTING_UNAVAILABLE,
  PROVIDER_ATTEMPT_BOUNDARIES,
  PROVIDER_ATTEMPT_BOUNDARY_VETOES,
  providerAttemptLimit,
  readTerminalReplayVeto,
} from "../src/model/provider-attempt.js";
import { createProviderConnectionFactory } from "../src/model/provider.js";
import {
  DEFAULT_PROVIDER_TURN_RETRY_POLICY,
  describeProviderTurnReplayVeto,
  withBoundedProviderTurnRetry,
  type ProviderPhysicalAttemptEvent,
  type ProviderTurnReplayVetoEvent,
} from "../src/model/provider-turn-retry.js";
import {
  DOCSFAB_SYSTEM_PROMPT,
  DOCSFAB_SYSTEM_PROMPT_SHA256,
} from "../src/model/request-policy.js";
import {
  formatInferenceRetryDispositionLine,
  formatProviderAttemptClause,
  readRunRetryDispositions,
} from "../src/operator/retry-disposition.js";
import { PROVIDER_TURN_REPLAY_VETOES } from "../src/records/inference-retry-disposition.js";
import type { InferenceTurnEvidence, RunRecord } from "../src/records/contracts.js";
import { validModelConfig } from "./helpers.js";

type StreamSimple = ModelRuntime["streamSimple"];
type ProviderEvent = {
  type: string;
  reason?: string;
  error?: { errorMessage?: string; stopReason?: string };
  message?: unknown;
};

/** Minimal stand-in for Pi's unexported AssistantMessageEventStream. */
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

const TRANSIENT_MESSAGE = "503: Connection error";
const TIMEOUT_MESSAGE = "408: litellm.Timeout: Connection timed out.";
const THROTTLE_MESSAGE = "429: Rate limit exceeded";

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

/** A turn that already published a tool call before the transport died. */
function committedToolCallStream(errorMessage: string): FakeEventStream {
  const stream = new FakeEventStream();
  stream.push({ type: "start" });
  stream.push({ type: "tool_call_delta" });
  stream.push({ type: "error", error: { errorMessage } });
  return stream;
}

/** The empty assistant turn. */
function blankStream(): FakeEventStream {
  const stream = new FakeEventStream();
  stream.push({ type: "start" });
  stream.push({
    type: "done",
    reason: "stop",
    message: { content: [], stopReason: "stop", usage: { input: 1_200, output: 0 } },
  });
  return stream;
}

async function collect(stream: unknown): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream as AsyncIterable<ProviderEvent>) events.push(event);
  return events;
}

interface WrapObservation {
  stream: StreamSimple;
  delegate: ReturnType<typeof vi.fn>;
  physical: ProviderPhysicalAttemptEvent[];
  vetoes: ProviderTurnReplayVetoEvent[];
  /** Ordered trace of delegate entry and stream completion, for overlap checks. */
  trace: string[];
}

function wrap(
  factories: readonly (() => FakeEventStream)[],
  options: Parameters<typeof withBoundedProviderTurnRetry>[1] = {},
): WrapObservation {
  const physical: ProviderPhysicalAttemptEvent[] = [];
  const vetoes: ProviderTurnReplayVetoEvent[] = [];
  const trace: string[] = [];
  let index = 0;
  const delegate = vi.fn(() => {
    const ordinal = index + 1;
    const factory = factories[Math.min(index, factories.length - 1)]!;
    index += 1;
    trace.push(`request-${ordinal}`);
    return factory();
  });
  const wrapped = withBoundedProviderTurnRetry(delegate as unknown as StreamSimple, {
    sleep: async () => {},
    ...options,
    onPhysicalAttempt: (event) => {
      trace.push(`attempt-${event.attempt}${event.replay ? "-replay" : "-first"}`);
      physical.push(event);
      options.onPhysicalAttempt?.(event);
    },
    onReplayVeto: (event) => {
      trace.push(`veto-${event.veto}`);
      vetoes.push(event);
      options.onReplayVeto?.(event);
    },
  });
  return { stream: wrapped, delegate, physical, vetoes, trace };
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

function landedSse(model: string): Response {
  const body = [
    `data: ${JSON.stringify({ id: "ok", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "ok", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const routeFault = (status: number, statusText: string): Response =>
  new Response(JSON.stringify({ message: `${statusText} from the front door` }), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });

interface LiveRun {
  fetchCalls: number;
  events: ProviderEvent[];
  ledger: InferenceTurnEvidence[];
  spent: number;
  remaining: number | null;
}

/** A blank chat-completions turn: no content, `finish_reason` stop. */
function blankSse(model: string): Response {
  const body = [
    `data: ${JSON.stringify({ id: "blank", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "blank", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1_200, completion_tokens: 0, total_tokens: 1_200 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface LiveConnection {
  /** One governed turn: a fresh `streamSimple` call on the same connection. */
  turn(streamOptions?: Record<string, unknown>): Promise<ProviderEvent[]>;
  /** The same call without collecting, for a turn expected to be refused. */
  startTurn(streamOptions?: Record<string, unknown>): unknown;
  fetchCalls(): number;
  ledger(): InferenceTurnEvidence[];
  spent(): number;
  remaining(): number | null;
}

/**
 * One attempt-scoped connection through the real connection factory and
 * pi-ai's real chat-completions adapter, on which any number of governed turns
 * can run. The step-wide bound is a property of the connection, so a helper
 * that ran one turn could not observe it.
 */
async function openLiveConnection(options: {
  respond: (call: number) => Response;
  maxPhysicalRequestsPerStep?: number;
  aggregateRequestLimit?: { readonly kind: "absent" };
}): Promise<LiveConnection> {
  const profile = boundNvidiaProfile();
  let fetchCalls = 0;
  const factory = createProviderConnectionFactory({
    routeId: profile.routeId,
    transport: profile.transport,
    fetch: async () => {
      fetchCalls += 1;
      return options.respond(fetchCalls);
    },
  });
  const connection = await factory.create(
    {
      profile,
      credential: { family: "nvidia-api-catalog", apiKey: "selected-provider-secret" },
    },
    {
      evidenceIdentity: { repositoryRevision: "b".repeat(40) },
      // Backoff collapsed: this suite counts requests, not seconds.
      providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 },
      ...(options.maxPhysicalRequestsPerStep === undefined
        ? {}
        : { maxPhysicalRequestsPerStep: options.maxPhysicalRequestsPerStep }),
      ...(options.aggregateRequestLimit
        ? { aggregatePhysicalRequestLimit: options.aggregateRequestLimit }
        : {}),
    },
  );
  const startTurn = (streamOptions?: Record<string, unknown>): unknown =>
    connection.runtime.streamSimple(
      connection.model,
      {
        systemPrompt: DOCSFAB_SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
        tools: [],
      },
      streamOptions as never,
    );
  return {
    startTurn,
    turn: async (streamOptions) => collect(startTurn(streamOptions)),
    fetchCalls: () => fetchCalls,
    ledger: () => connection.turnGovernance?.evidence() ?? [],
    spent: () => connection.physicalProviderAttempts?.spent() ?? -1,
    remaining: () => {
      const remaining = connection.physicalProviderAttempts?.remaining();
      return remaining === undefined ? -1 : remaining;
    },
  };
}

/**
 * One governed turn through the real connection factory and pi-ai's real
 * chat-completions adapter, with the front door answering `faults` failures
 * before it lands.
 */
async function runLiveTurn(options: {
  faults: number;
  status?: number;
  statusText?: string;
  maxPhysicalRequestsPerStep?: number;
  land?: boolean;
}): Promise<LiveRun> {
  const profile = boundNvidiaProfile();
  const status = options.status ?? 503;
  const statusText = options.statusText ?? "Service Unavailable";
  const live = await openLiveConnection({
    respond: (call) =>
      options.land === false || call <= options.faults
        ? routeFault(status, statusText)
        : landedSse(profile.modelId),
    ...(options.maxPhysicalRequestsPerStep === undefined
      ? {}
      : { maxPhysicalRequestsPerStep: options.maxPhysicalRequestsPerStep }),
  });
  const events = await live.turn();
  return {
    fetchCalls: live.fetchCalls(),
    events,
    ledger: live.ledger(),
    spent: live.spent(),
    remaining: live.remaining(),
  };
}

function envelope(
  overrides: Partial<Record<TaskBudgetDimension, number>> = {},
): TaskBudgetEnvelope {
  const values = {} as Record<TaskBudgetDimension, number>;
  for (const dimension of TASK_BUDGET_DIMENSIONS) values[dimension] = 0;
  return { ...values, "provider-turns": 8, ...overrides };
}

function turnRow(overrides: Partial<InferenceTurnEvidence> = {}): InferenceTurnEvidence {
  return {
    turn: 1,
    toolCalls: 0,
    toolResults: 0,
    maxProviderTurns: 12,
    maxToolCalls: 12,
    compactions: 0,
    maxCompactions: 8,
    configuredContextWindow: 128_000,
    effectiveContextWindow: 128_000,
    configuredMaxOutputTokens: 4_096,
    effectiveMaxOutputTokens: 4_096,
    reservedTokens: 1_024,
    estimatedInputTokens: 32,
    availableOutputTokens: 4_096,
    requiredMinimumOutputTokens: 256,
    decision: "proceed",
    requestDigest: "1".repeat(64),
    providerPayloadSchemaVersion: 1,
    finalPayloadSha256: "2".repeat(64),
    evidenceDigest: "3".repeat(64),
    ...overrides,
  };
}

describe("physical provider attempt bounds come from the limits catalog", () => {
  it("reads every in-turn retry default from config/limits.yaml", () => {
    // No numeric retry bound is written in TypeScript: the policy the wrapper
    // applies and the catalog `docsfab doctor --limits` prints are the same
    // declaration.
    expect(DEFAULT_PROVIDER_TURN_RETRY_POLICY).toEqual({
      maxAttempts: providerAttemptLimit("maxAttemptsPerTurn"),
      baseDelayMs: providerAttemptLimit("baseDelayMs"),
      maxDelayMs: providerAttemptLimit("maxDelayMs"),
      maxTotalDelayMs: providerAttemptLimit("maxTotalDelayMs"),
      maxThrottledAttempts: providerAttemptLimit("maxThrottledAttemptsPerTurn"),
      maxThrottledTotalDelayMs: providerAttemptLimit("maxThrottledTotalDelayMs"),
      maxBlankAttempts: providerAttemptLimit("maxBlankAttemptsPerTurn"),
    });
    // The shipped values, written out so a catalog edit has to be deliberate
    // rather than silently absorbed by the line above.
    expect(DEFAULT_PROVIDER_TURN_RETRY_POLICY).toEqual({
      maxAttempts: 8,
      baseDelayMs: 500,
      maxDelayMs: 20_000,
      maxTotalDelayMs: 60_000,
      maxThrottledAttempts: 24,
      maxThrottledTotalDelayMs: 380_000,
      maxBlankAttempts: 3,
    });
  });

  it("declares a step bound that the per-turn bound cannot reach on its own", () => {
    // The sealed composition ceiling is 512 governed turns; twenty-four
    // physical requests each, the wider throttled per-turn bound, is 12,288.
    // The step bound is that product, so a sealed composition cannot reach it
    // and a runaway still stops.
    expect(maxPhysicalProviderRequestsPerStep()).toBe(12_288);
    expect(maxPhysicalProviderRequestsPerStep()).toBe(
      512 * providerAttemptLimit("maxThrottledAttemptsPerTurn"),
    );
    expect(providerAttemptLimit("maxThrottledAttemptsPerTurn")).toBeGreaterThanOrEqual(
      providerAttemptLimit("maxAttemptsPerTurn"),
    );
  });

  it("refuses an undeclared limit name rather than defaulting", () => {
    expect(() =>
      providerAttemptLimit("maxAttemptsPerTurnn" as Parameters<typeof providerAttemptLimit>[0]),
    ).toThrowError(/is not declared in config\/limits\.yaml/u);
  });

  it("binds every named attempt boundary to a veto the decoder admits", () => {
    for (const boundary of PROVIDER_ATTEMPT_BOUNDARIES) {
      const veto = PROVIDER_ATTEMPT_BOUNDARY_VETOES[boundary];
      expect(PROVIDER_TURN_REPLAY_VETOES, boundary).toContain(veto);
    }
    // The step bound is the one veto that is not a per-attempt boundary; it is
    // still in the closed vocabulary the record decoder accepts.
    expect(PROVIDER_TURN_REPLAY_VETOES).toContain("step-physical-attempts-exhausted");
  });
});

describe("fault injection counts logical turns against physical requests", () => {
  const faults = [
    { label: "transient", message: TRANSIENT_MESSAGE },
    { label: "timeout", message: TIMEOUT_MESSAGE },
    { label: "throttling", message: THROTTLE_MESSAGE },
  ] as const;

  it("announces one physical attempt per request and replays only what it announced", async () => {
    for (const { label, message } of faults) {
      const { stream, delegate, physical, vetoes, trace } = wrap([
        () => errorStream(message),
        () => errorStream(message),
        () => doneStream("OK"),
      ]);

      const events = await collect(stream({} as never, { messages: [] } as never));

      expect(events.at(-1)?.type, label).toBe("done");
      // One logical turn, three physical requests.
      expect(delegate, label).toHaveBeenCalledTimes(3);
      expect(
        physical.map((event) => event.attempt),
        label,
      ).toEqual([1, 2, 3]);
      expect(
        physical.map((event) => event.replay),
        label,
      ).toEqual([false, true, true]);
      // A landed turn refused no replay, so no boundary is recorded.
      expect(vetoes, label).toEqual([]);
      // No stacked retries: every request is announced, issued, and finished
      // before the next is announced. A nested or concurrent replay would
      // interleave these tokens.
      expect(trace, label).toEqual([
        "attempt-1-first",
        "request-1",
        "attempt-2-replay",
        "request-2",
        "attempt-3-replay",
        "request-3",
      ]);
    }
  });

  it("records attempts-exhausted when the burst outlasts the per-turn window", async () => {
    const { stream, delegate, physical, vetoes } = wrap([() => errorStream(TIMEOUT_MESSAGE)]);

    const events = await collect(stream({} as never, { messages: [] } as never));

    expect(events.at(-1)?.type).toBe("error");
    expect(delegate).toHaveBeenCalledTimes(DEFAULT_PROVIDER_TURN_RETRY_POLICY.maxAttempts);
    expect(physical).toHaveLength(DEFAULT_PROVIDER_TURN_RETRY_POLICY.maxAttempts);
    expect(vetoes.map((event) => event.veto)).toEqual(["attempts-exhausted"]);
    expect(vetoes[0]?.attempt).toBe(DEFAULT_PROVIDER_TURN_RETRY_POLICY.maxAttempts);
  });

  it("records partial-stream and never replays a turn that already published", async () => {
    // No tool replay: the attempt published a tool call, so a replay would run
    // the same tool twice. That is corruption, not a retry.
    const { stream, delegate, physical, vetoes } = wrap([
      () => committedToolCallStream(TRANSIENT_MESSAGE),
      () => doneStream("second answer"),
    ]);

    const events = await collect(stream({} as never, { messages: [] } as never));

    expect(delegate).toHaveBeenCalledTimes(1);
    expect(physical.map((event) => event.attempt)).toEqual([1]);
    expect(vetoes.map((event) => event.veto)).toEqual(["partial-stream"]);
    expect(events.filter((event) => event.type === "tool_call_delta")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("error");
  });

  it("records local-denial for a request DocsFab itself refused", async () => {
    const { stream, delegate, physical, vetoes } = wrap([() => errorStream(TRANSIENT_MESSAGE)], {
      isReplayable: () => false,
    });

    await collect(stream({} as never, { messages: [] } as never));

    expect(delegate).toHaveBeenCalledTimes(1);
    expect(physical).toHaveLength(1);
    expect(vetoes.map((event) => event.veto)).toEqual(["local-denial"]);
  });

  it("records cancelled when the caller withdraws during the backoff", async () => {
    const controller = new AbortController();
    const { stream, delegate, physical, vetoes } = wrap([() => errorStream(TRANSIENT_MESSAGE)], {
      sleep: async () => {
        controller.abort();
      },
    });

    const events = await collect(
      stream({} as never, { messages: [] } as never, { signal: controller.signal } as never),
    );

    expect(delegate).toHaveBeenCalledTimes(1);
    expect(physical).toHaveLength(1);
    expect(vetoes.map((event) => event.veto)).toEqual(["cancelled"]);
    expect(events.at(-1)?.error?.stopReason).toBe("aborted");
  });

  it("records attempt-deadline when the next backoff would cross the deadline", async () => {
    const { stream, delegate, vetoes } = wrap([() => errorStream(TRANSIENT_MESSAGE)], {
      now: () => 1_000,
      deadlineAt: () => 1_000,
    });

    await collect(stream({} as never, { messages: [] } as never));

    expect(delegate).toHaveBeenCalledTimes(1);
    expect(vetoes.map((event) => event.veto)).toEqual(["attempt-deadline"]);
  });

  it("records blank-attempts-exhausted on the narrower empty-turn bound", async () => {
    const { stream, delegate, physical, vetoes } = wrap([() => blankStream()]);

    await collect(stream({} as never, { messages: [] } as never));

    expect(delegate).toHaveBeenCalledTimes(DEFAULT_PROVIDER_TURN_RETRY_POLICY.maxBlankAttempts);
    expect(physical).toHaveLength(DEFAULT_PROVIDER_TURN_RETRY_POLICY.maxBlankAttempts);
    expect(vetoes.map((event) => event.veto)).toEqual(["blank-attempts-exhausted"]);
  });

  it("orders the step bound immediately after the per-turn bound", () => {
    // The order is load-bearing: a step whose whole allowance is spent must not
    // be reported as merely out of per-turn attempts, and neither may outrank a
    // partial stream or a local refusal.
    const probe = {
      committed: false,
      conditionRetryable: true,
      attemptsRemaining: true,
      stepAttemptsRemaining: false,
      blankAttemptsRemaining: true,
      locallyDenied: () => false,
      backoffBudgetRemaining: true,
      withinDeadline: () => true,
      cancelled: () => false,
    };
    expect(describeProviderTurnReplayVeto(probe)).toBe("step-physical-attempts-exhausted");
    expect(describeProviderTurnReplayVeto({ ...probe, attemptsRemaining: false })).toBe(
      "attempts-exhausted",
    );
    expect(describeProviderTurnReplayVeto({ ...probe, committed: true })).toBe("partial-stream");
    // Positive control: with the step allowance intact the replay is authorized.
    expect(
      describeProviderTurnReplayVeto({ ...probe, stepAttemptsRemaining: true }),
    ).toBeUndefined();
  });
});

describe("the step-wide physical bound stops at the limit, not before it", () => {
  it("keeps an explicitly absent across-step request ceiling absent while metering requests", () => {
    const ledger = createPhysicalProviderAttemptLedger({
      aggregateRequestLimit: { kind: "absent" },
    });

    for (let request = 0; request < 130; request += 1) {
      expect(ledger.hasRemaining()).toBe(true);
      ledger.record();
    }

    expect(ledger.bound()).toBeNull();
    expect(ledger.remaining()).toBeNull();
    expect(ledger.spent()).toBe(130);
    expect(ledger.refusal()).toBeUndefined();
  });

  it("spends exactly the allowance and then refuses, at the limit and at limit plus one", async () => {
    for (const bound of [2, 3]) {
      const ledger = createPhysicalProviderAttemptLedger({
        maxPhysicalRequests: bound,
        effectScope: `physical-bound-${bound}`,
      });
      const { stream, delegate, physical, vetoes } = wrap([() => errorStream(TIMEOUT_MESSAGE)], {
        stepAttemptsRemaining: () => ledger.hasRemaining(),
        onPhysicalAttempt: () => ledger.record(),
      });

      await collect(stream({} as never, { messages: [] } as never));

      expect(delegate, `bound ${bound}`).toHaveBeenCalledTimes(bound);
      expect(physical, `bound ${bound}`).toHaveLength(bound);
      expect(ledger.spent(), `bound ${bound}`).toBe(bound);
      expect(
        vetoes.map((event) => event.veto),
        `bound ${bound}`,
      ).toEqual(["step-physical-attempts-exhausted"]);
    }
  });

  it("counts and bounds the whole step attempt at the shipped call site", async () => {
    // Limit: the step is allowed two physical requests and the front door fails
    // every one of them, so the second is the last.
    const atLimit = await runLiveTurn({
      faults: 8,
      land: false,
      status: 408,
      statusText: "Request Timeout",
      maxPhysicalRequestsPerStep: 2,
    });
    expect(atLimit.fetchCalls).toBe(2);
    expect(atLimit.spent).toBe(2);
    expect(atLimit.remaining).toBe(0);
    expect(atLimit.events.at(-1)?.type).toBe("error");
    expect(atLimit.ledger).toHaveLength(1);
    expect(atLimit.ledger[0]?.providerRetries).toBe(1);
    expect(atLimit.ledger[0]?.providerReplayVeto).toBe("step-physical-attempts-exhausted");

    // Limit plus one: the same fault burst with one more request allowed spends
    // exactly one more, so the bound is the thing that stopped it.
    const abovelimit = await runLiveTurn({
      faults: 8,
      land: false,
      status: 408,
      statusText: "Request Timeout",
      maxPhysicalRequestsPerStep: 3,
    });
    expect(abovelimit.fetchCalls).toBe(3);
    expect(abovelimit.spent).toBe(3);
    expect(abovelimit.ledger[0]?.providerRetries).toBe(2);
    expect(abovelimit.ledger[0]?.providerReplayVeto).toBe("step-physical-attempts-exhausted");
  });

  it("positive control: the same burst under the catalog bound stops on the per-turn bound", async () => {
    const run = await runLiveTurn({
      faults: 8,
      land: false,
      status: 408,
      statusText: "Request Timeout",
    });

    expect(run.fetchCalls).toBe(DEFAULT_PROVIDER_TURN_RETRY_POLICY.maxAttempts);
    expect(run.spent).toBe(DEFAULT_PROVIDER_TURN_RETRY_POLICY.maxAttempts);
    expect(run.remaining).toBe(
      maxPhysicalProviderRequestsPerStep() - DEFAULT_PROVIDER_TURN_RETRY_POLICY.maxAttempts,
    );
    expect(run.ledger[0]?.providerReplayVeto).toBe("attempts-exhausted");
  });

  it("records nothing new on a turn that landed first time", async () => {
    // Byte-identical evidence for the ordinary turn: the accounting costs a
    // healthy run nothing.
    const run = await runLiveTurn({ faults: 0 });

    expect(run.fetchCalls).toBe(1);
    expect(run.spent).toBe(1);
    expect(run.ledger).toHaveLength(1);
    expect(run.ledger[0]?.providerRetries).toBeUndefined();
    expect(run.ledger[0]?.providerReplayVeto).toBeUndefined();
    expect(accountProviderAttempts(run.ledger)).toMatchObject({
      logicalTurns: 1,
      physicalRequests: 1,
      replayedRequests: 0,
      coverage: "complete",
    });
  });

  it("stops the step at the bound across governed turns, at the limit and at limit plus one", async () => {
    // The bound must stop first requests too, not only replays: each governed
    // turn enters the replay wrapper afresh, so a step probe read only inside the
    // replay decision lets every later turn issue its first request. Healthy
    // turns here, so nothing but the step bound can stop them.
    const profile = boundNvidiaProfile();
    for (const bound of [2, 3]) {
      const live = await openLiveConnection({
        respond: () => landedSse(profile.modelId),
        maxPhysicalRequestsPerStep: bound,
      });

      for (let turn = 1; turn <= bound; turn += 1) {
        const events = await live.turn();
        expect(events.at(-1)?.type, `bound ${bound} turn ${turn}`).toBe("done");
        expect(live.fetchCalls(), `bound ${bound} turn ${turn}`).toBe(turn);
        expect(live.spent(), `bound ${bound} turn ${turn}`).toBe(turn);
      }
      expect(live.remaining(), `bound ${bound}`).toBe(0);

      // The turn after the allowance never reaches the transport, and the
      // refusal names the catalog entry, the count and the bound.
      expect(() => live.startTurn(), `bound ${bound}`).toThrowError(
        new RegExp(
          `Provider turn stopped locally: reason=step-physical-attempts-exhausted` +
            ` limit=providerAttempt\\.maxPhysicalRequestsPerStep` +
            ` physical-requests=${bound} physical-request-limit=${bound} budget-refused=false`,
          "u",
        ),
      );
      expect(live.fetchCalls(), `bound ${bound}`).toBe(bound);
      expect(live.spent(), `bound ${bound}`).toBe(bound);
      // The refused turn wrote no ledger row: it issued no request, so there is
      // nothing to account for and nothing reads as unaccounted.
      expect(live.ledger(), `bound ${bound}`).toHaveLength(bound);
      expect(accountProviderAttempts(live.ledger()), `bound ${bound}`).toMatchObject({
        logicalTurns: bound,
        physicalRequests: bound,
        unaccountedTurns: 0,
        coverage: "complete",
      });
    }
  });

  it("spends the allowance on replays and then refuses the next turn's first request", async () => {
    // Allowance 2, request 1 faults 503, everything after it lands. Governed
    // turn 1 spends both on a fault and its replay; governed turn 2 must not
    // spend a third.
    const profile = boundNvidiaProfile();
    const live = await openLiveConnection({
      respond: (call) =>
        call === 1 ? routeFault(503, "Service Unavailable") : landedSse(profile.modelId),
      maxPhysicalRequestsPerStep: 2,
    });

    const first = await live.turn();

    expect(first.at(-1)?.type).toBe("done");
    expect(live.fetchCalls()).toBe(2);
    expect(live.spent()).toBe(2);
    expect(live.remaining()).toBe(0);
    expect(live.ledger()[0]?.providerRetries).toBe(1);

    expect(() => live.startTurn()).toThrowError(/reason=step-physical-attempts-exhausted/u);
    expect(live.fetchCalls()).toBe(2);
    expect(live.spent()).toBe(2);
    expect(live.ledger()).toHaveLength(1);
  });

  it("positive control: the same governed turns under the catalog bound all land", async () => {
    const profile = boundNvidiaProfile();
    const live = await openLiveConnection({ respond: () => landedSse(profile.modelId) });

    for (let turn = 1; turn <= 3; turn += 1) expect((await live.turn()).at(-1)?.type).toBe("done");

    expect(live.fetchCalls()).toBe(3);
    expect(live.spent()).toBe(3);
    expect(live.remaining()).toBe(maxPhysicalProviderRequestsPerStep() - 3);
    expect(accountProviderAttempts(live.ledger())).toMatchObject({
      logicalTurns: 3,
      physicalRequests: 3,
      coverage: "complete",
    });
  });

  it("runs governed turns beyond a small aggregate when the limit is explicitly absent", async () => {
    const profile = boundNvidiaProfile();
    const live = await openLiveConnection({
      respond: () => landedSse(profile.modelId),
      aggregateRequestLimit: { kind: "absent" },
    });

    for (let turn = 1; turn <= 4; turn += 1) {
      expect((await live.turn()).at(-1)?.type).toBe("done");
    }

    expect(live.fetchCalls()).toBe(4);
    expect(live.spent()).toBe(4);
    expect(live.remaining()).toBeNull();
  });

  it("records the replays a landed turn needed and leaves no veto behind", async () => {
    const run = await runLiveTurn({ faults: 3 });

    expect(run.fetchCalls).toBe(4);
    expect(run.spent).toBe(4);
    expect(run.events.at(-1)?.type).toBe("done");
    expect(run.ledger[0]?.providerRetries).toBe(3);
    expect(run.ledger[0]?.providerReplayVeto).toBeUndefined();
    // One logical turn, four physical requests, read off the shipped ledger
    // rather than a fixture.
    expect(accountProviderAttempts(run.ledger)).toMatchObject({
      logicalTurns: 1,
      physicalRequests: 4,
      replayedRequests: 3,
      coverage: "complete",
    });
  });
});

describe("a request DocsFab refused is recorded as DocsFab's refusal", () => {
  /** An `onPayload` hook that makes the replay a different request. */
  const divergentReplay = (): Record<string, unknown> => {
    let payloadCalls = 0;
    return {
      calls: () => payloadCalls,
      onPayload(payload: unknown) {
        payloadCalls += 1;
        if (payloadCalls === 1) return undefined;
        const raw = payload as { messages: unknown[] };
        return {
          ...(payload as Record<string, unknown>),
          messages: [...raw.messages, { role: "user", content: "divergent replay" }],
        };
      },
    };
  };

  /** A length-stopped blank turn, which earns a nudged replay. */
  function lengthBlankSse(model: string): Response {
    const body = [
      `data: ${JSON.stringify({ id: "cut", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "cut", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 1_200, completion_tokens: 4_096, total_tokens: 5_296 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  it("records local-denial, not the classifier's verdict, for a payload it refused to reseal", async () => {
    // The refusal "Provider request rejected by the installed request policy
    // (payload-authority: turn-evidence-authority)." is DocsFab's own text, which the classifier
    // calls terminal. The veto must not read `condition-not-retryable` for a
    // request the provider never received.
    const profile = boundNvidiaProfile();
    const hook = divergentReplay();
    const live = await openLiveConnection({
      respond: (call) => {
        if (call === 1) throw new TypeError("fetch failed: Connection error");
        return landedSse(profile.modelId);
      },
    });

    const events = await live.turn(hook);

    expect((hook.calls as () => number)()).toBe(2);
    // The divergent replay never reached the wire.
    expect(live.fetchCalls()).toBe(1);
    expect(events.at(-1)?.type).toBe("error");
    const row = live.ledger()[0];
    expect(row?.providerReplayVeto).toBe("local-denial");
    // The refused replay is recorded on the sealed row by its closed reason.
    expect(row?.requestPolicyRefusal).toBe("payload-authority");
    // The shipped call site records the veto the binding table names for this
    // boundary.
    expect(row?.providerReplayVeto).toBe(PROVIDER_ATTEMPT_BOUNDARY_VETOES["finalized-payload"]);
    // Positive control on the same row: the attempt that did reach the wire is
    // not counted twice, and the operator line names the refusal.
    expect(row?.providerRetries).toBeUndefined();
    expect(accountProviderAttempts(live.ledger())).toMatchObject({
      logicalTurns: 1,
      physicalRequests: 1,
      replayedRequests: 0,
      coverage: "complete",
    });
    expect(readTerminalReplayVeto(live.ledger())).toBe("local-denial");
  });

  it("does not promote an unsent replay of a BLANK turn into providerRetries", async () => {
    // `recordProviderBlankTurn` runs after `onRetry` and before the replay's
    // payload hook, so refreshing every counter there would count a replay the
    // finalizer then refused: one `fetch` reported as two physical requests with
    // `coverage: "complete"`.
    const profile = boundNvidiaProfile();
    const hook = divergentReplay();
    const live = await openLiveConnection({ respond: () => blankSse(profile.modelId) });

    await live.turn(hook);

    expect((hook.calls as () => number)()).toBe(2);
    expect(live.fetchCalls()).toBe(1);
    const row = live.ledger()[0];
    expect(row?.providerRetries).toBeUndefined();
    expect(row?.providerBlankTurns).toBe(1);
    expect(row?.providerReplayVeto).toBe("local-denial");
    expect(row?.requestPolicyRefusal).toBe("payload-authority");
    expect(accountProviderAttempts(live.ledger())).toEqual({
      logicalTurns: 1,
      physicalRequests: 1,
      replayedRequests: 0,
      blankRequests: 1,
      governorStoppedTurns: 0,
      requestPolicyRefusedTurns: 0,
      unaccountedTurns: 0,
      coverage: "complete",
    });
  });

  it("does not promote an unsent NUDGED replay into providerRetries", async () => {
    // The production route to the same over-report, with no test hook: a nudged
    // replay whose nudge fails to change the payload digest is refused by
    // `finalizeTurnEvidence` after the blank counter was written.
    const profile = boundNvidiaProfile();
    let payloadCalls = 0;
    const live = await openLiveConnection({ respond: () => lengthBlankSse(profile.modelId) });

    await live.turn({
      onPayload(payload: unknown) {
        payloadCalls += 1;
        if (payloadCalls === 1) return undefined;
        // The nudge is dropped, so the replay is the identical request.
        const raw = payload as { messages: unknown[] };
        return { ...(payload as Record<string, unknown>), messages: raw.messages.slice(0, -1) };
      },
    });

    expect(payloadCalls).toBe(2);
    expect(live.fetchCalls()).toBe(1);
    expect(live.ledger()[0]?.providerRetries).toBeUndefined();
    expect(live.ledger()[0]?.providerBlankTurns).toBe(1);
    expect(live.ledger()[0]?.requestPolicyRefusal).toBe("payload-authority");
    expect(accountProviderAttempts(live.ledger())).toMatchObject({
      logicalTurns: 1,
      physicalRequests: 1,
      blankRequests: 1,
      coverage: "complete",
    });
  });

  it("positive control: a replay that DOES reach the wire is counted", async () => {
    // The same shape with a payload hook that leaves the replay alone. Without
    // this the tests above would pass on a build that never counted a replay.
    const profile = boundNvidiaProfile();
    const live = await openLiveConnection({
      respond: (call) => (call === 1 ? blankSse(profile.modelId) : landedSse(profile.modelId)),
    });

    await live.turn();

    expect(live.fetchCalls()).toBe(2);
    expect(live.ledger()[0]?.providerRetries).toBe(1);
    expect(live.ledger()[0]?.providerBlankTurns).toBe(1);
    expect(live.ledger()[0]?.providerReplayVeto).toBeUndefined();
    expect(Object.hasOwn(live.ledger()[0]!, "requestPolicyRefusal")).toBe(false);
    expect(accountProviderAttempts(live.ledger())).toMatchObject({
      logicalTurns: 1,
      physicalRequests: 2,
      replayedRequests: 1,
      blankRequests: 1,
      coverage: "complete",
    });
  });
});

describe("the accounting projection is honest about what it cannot read", () => {
  it("sums physical requests across turns and separates the logical count", () => {
    const accounting = accountProviderAttempts([
      turnRow({ turn: 1, providerRetries: 2 }),
      turnRow({ turn: 2 }),
      turnRow({ turn: 3, providerRetries: 1, providerBlankTurns: 2 }),
    ]);

    expect(accounting).toEqual({
      logicalTurns: 3,
      physicalRequests: 6,
      replayedRequests: 3,
      blankRequests: 2,
      governorStoppedTurns: 0,
      requestPolicyRefusedTurns: 0,
      unaccountedTurns: 0,
      coverage: "complete",
    });
  });

  it("treats a governor stop as a known zero and an unsealed row as unknown", () => {
    const accounting = accountProviderAttempts([
      turnRow({ turn: 1, providerRetries: 1 }),
      // The governor refused the turn, so no request left the process.
      {
        ...turnRow({ turn: 2 }),
        decision: "stop",
        reason: "provider-turn-limit",
        providerPayloadSchemaVersion: undefined,
        finalPayloadSha256: undefined,
      },
      // A record written before payload digests existed: requests were made and
      // this projection cannot say how many.
      {
        ...turnRow({ turn: 3 }),
        providerPayloadSchemaVersion: undefined,
        finalPayloadSha256: undefined,
      },
    ]);

    expect(accounting).toMatchObject({
      logicalTurns: 1,
      physicalRequests: 2,
      governorStoppedTurns: 1,
      unaccountedTurns: 1,
      coverage: "partial",
    });
    // The clause an operator reads says so rather than printing a clean total.
    expect(formatProviderAttemptClause(accounting)).toBe(
      "physical 2 across 1 governed turn (at least; 1 unaccounted)",
    );
  });

  it("answers unavailable for an absent or unreadable ledger", () => {
    expect(accountProviderAttempts(undefined)).toBe(PROVIDER_ATTEMPT_ACCOUNTING_UNAVAILABLE);
    expect(accountProviderAttempts("turns")).toBe(PROVIDER_ATTEMPT_ACCOUNTING_UNAVAILABLE);
    expect(formatProviderAttemptClause(PROVIDER_ATTEMPT_ACCOUNTING_UNAVAILABLE)).toBe(
      "physical unavailable",
    );
    // An array of junk is not unavailable: the ledger is readable and every row
    // in it is unaccounted, which is a different fact.
    expect(accountProviderAttempts([null, 7])).toMatchObject({
      logicalTurns: 0,
      physicalRequests: 0,
      unaccountedTurns: 2,
      coverage: "partial",
    });
  });

  it("reads the terminal veto and ignores rows that carry none", () => {
    expect(
      readTerminalReplayVeto([
        turnRow({ turn: 1, providerReplayVeto: "local-denial" }),
        turnRow({ turn: 2 }),
        turnRow({ turn: 3, providerReplayVeto: "attempts-exhausted" }),
      ]),
    ).toBe("attempts-exhausted");
    expect(readTerminalReplayVeto([turnRow({ turn: 1 })])).toBeUndefined();
    expect(readTerminalReplayVeto(undefined)).toBeUndefined();
    // A saved record is untrusted input. A token this build cannot name is not
    // returned as though it were a veto, and it does not hide the real one on
    // an earlier row either.
    expect(
      readTerminalReplayVeto([
        turnRow({ turn: 1, providerReplayVeto: "local-denial" }),
        turnRow({
          turn: 2,
          providerReplayVeto: "invented-veto" as InferenceTurnEvidence["providerReplayVeto"],
        }),
      ]),
    ).toBe("local-denial");
  });
});

describe("the physical count reaches the record contract and the operator surface", () => {
  function recordWithTurns(turns: InferenceTurnEvidence[]): RunRecord {
    return {
      schemaVersion: 2,
      id: "physical-attempts-run",
      workflow: "readiness",
      repository: { path: "/tmp/repository", revision: "c".repeat(40) },
      workspace: { strategy: "tracked-export", disposable: true },
      status: "failed",
      startedAt: "2026-09-22T00:00:00.000Z",
      steps: [
        {
          id: "assess-readiness",
          title: "Assess readiness",
          skill: "assess",
          mode: "read-only",
          status: "failed",
          inference: {
            configuredMaxRetries: 1,
            effectiveMaxRetries: 1,
            baseDelayMs: 0,
            maxDelayMs: 0,
            retryableCategories: ["timeout"],
            replay: "read-only",
            attempts: [
              {
                attempt: 1,
                outcome: "timeout",
                retryable: false,
                retryScheduled: false,
                conditionRetryability: "eligible",
                retryDecision: "declined",
                durationMs: 5,
                turns,
              },
            ],
          },
        },
      ],
    } as unknown as RunRecord;
  }

  it("prints the physical count and the refusing boundary beside the #480 pair", () => {
    const readings = readRunRetryDispositions(
      recordWithTurns([
        turnRow({ turn: 1, providerRetries: 7, providerReplayVeto: "attempts-exhausted" }),
      ]),
    );

    expect(readings).toHaveLength(1);
    expect(readings[0]?.physicalAttempts).toMatchObject({
      logicalTurns: 1,
      physicalRequests: 8,
    });
    expect(readings[0]?.replayVeto).toBe("attempts-exhausted");
    // The exact rendered line, written out rather than assembled from the source
    // under test.
    expect(formatInferenceRetryDispositionLine(readings[0]!)).toBe(
      "Step assess-readiness attempt 1: timeout; condition eligible;" +
        " retryable false;" +
        " decision declined-host-refusal (the harness reported the occurrence as not retryable);" +
        " retries remaining 1; condition eligible disagrees with retryable false;" +
        " physical 8 across 1 governed turn; replay stopped by attempts-exhausted",
    );
  });

  it("drops a veto token this build cannot name instead of printing it", () => {
    const readings = readRunRetryDispositions(
      recordWithTurns([
        turnRow({
          turn: 1,
          providerReplayVeto: "invented-veto" as InferenceTurnEvidence["providerReplayVeto"],
        }),
      ]),
    );

    expect(readings[0]?.replayVeto).toBeUndefined();
    expect(formatInferenceRetryDispositionLine(readings[0]!)).not.toContain("invented-veto");
  });
});

describe("the step ledger binds physical requests to the task budget", () => {
  it("settles exactly one provider-turns charge per physical request", () => {
    const budget = createRootTaskBudget({ envelope: envelope() });
    const ledger = createPhysicalProviderAttemptLedger({
      maxPhysicalRequests: 8,
      budget,
      effectScope: "physical-test-a",
    });

    ledger.record();
    ledger.record();
    ledger.record();

    expect(ledger.spent()).toBe(3);
    expect(ledger.refusal()).toBeUndefined();
    expect(projectTaskBudget(budget).settled["provider-turns"]).toBe(3);
    expect(projectTaskBudget(budget).remaining["provider-turns"]).toBe(5);
  });

  it("closes the ledger when the budget refuses a charge instead of throwing into the stream", () => {
    const budget = createRootTaskBudget({ envelope: envelope({ "provider-turns": 2 }) });
    const ledger = createPhysicalProviderAttemptLedger({
      maxPhysicalRequests: 8,
      budget,
      effectScope: "physical-test-b",
    });

    ledger.record();
    ledger.record();
    // The third request exceeds the reserved envelope. A counter that threw
    // here would lose an in-flight inference turn, so the refusal is recorded
    // and the next replay is vetoed instead.
    expect(() => ledger.record()).not.toThrow();
    expect(ledger.refusal()).toMatch(/Task budget exhausted \(provider-turns\)/u);
    expect(ledger.hasRemaining()).toBe(false);
    expect(ledger.remaining()).toBe(0);
    expect(projectTaskBudget(budget).settled["provider-turns"]).toBe(2);
  });

  it("stops at the step bound without a budget owner", () => {
    const ledger = createPhysicalProviderAttemptLedger({ maxPhysicalRequests: 2 });

    expect(ledger.hasRemaining()).toBe(true);
    ledger.record();
    expect(ledger.hasRemaining()).toBe(true);
    ledger.record();
    expect(ledger.hasRemaining()).toBe(false);
    expect(ledger.spent()).toBe(2);
    expect(ledger.remaining()).toBe(0);
  });

  it("refuses a bound that is not a positive integer", () => {
    expect(() => createPhysicalProviderAttemptLedger({ maxPhysicalRequests: 0 })).toThrowError(
      /positive integer request bound/u,
    );
    expect(() => createPhysicalProviderAttemptLedger({ maxPhysicalRequests: 1.5 })).toThrowError(
      /positive integer request bound/u,
    );
  });

  it("defaults to the catalog bound when no caller states one", () => {
    const ledger = createPhysicalProviderAttemptLedger();
    expect(ledger.remaining()).toBe(maxPhysicalProviderRequestsPerStep());
  });
});
