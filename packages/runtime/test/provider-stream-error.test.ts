// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A provider can answer HTTP 200 and then end the stream with a structured
 * error event, such as the NVIDIA API Catalog's
 * `data: {"error":{"message":"Service temporarily overloaded","type":"service_unavailable","code":503}}`.
 * The transport observes that event's declared status and type as closed
 * facts, so a declared server fault is a retryable `provider-transient`, while
 * a declared 429 with no transport status stays a terminal quota wall. Every
 * provider here is a scripted `fetch`; no request leaves the host.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HarnessStepInput, InferenceRetryPolicy } from "../src/execution/contracts.js";
import { PiHarness } from "../src/harness/pi.js";
import {
  classifyProviderError,
  observeLandedProviderTurn,
} from "../src/model/attempt-telemetry.js";
import { createModelConnection } from "../src/model/provider.js";
import {
  createProviderStreamErrorScanner,
  observeProviderStreamErrors,
  readProviderStreamErrorEvent,
} from "../src/model/provider-stream-error.js";
import { providerTurnFailureDisposition } from "../src/model/provider-turn-retry.js";
import {
  decideSentProviderFailure,
  sentProviderFailureDisposition,
} from "../src/model/sent-provider-failure.js";
import { InferenceStepError } from "../src/execution/contracts.js";
import { buildRunHumanNextCommand } from "../src/operator/run-next-action.js";
import { formatRunFailureDiagnosticLines } from "../src/operator/run-summary.js";
import type {
  InferenceAttemptEvidence,
  InferenceFailureCategory,
  RunRecord,
} from "../src/records/contracts.js";
import { isInferenceAttemptModelTelemetry } from "../src/records/model-telemetry.js";
import { decodeInference } from "../src/scorecard-record-decode.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import { validModelConfig } from "./helpers.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillCrateDirectory = resolve(projectRoot, "skill-crate");
const temporaryDirectories: string[] = [];
const SLOW = testTimeoutMs(20_000);
const encoder = new TextEncoder();

/** The event body a hosted provider sent on a 200 response. */
const OVERLOADED_EVENT =
  '{"error":{"message":"Service temporarily overloaded","type":"service_unavailable","code":503}}';
const OVERLOADED_BODY = `data: ${OVERLOADED_EVENT}\n\ndata: [DONE]\n\n`;
// Neutral type and message, so only the declared code can classify these.
const QUOTA_BODY = 'data: {"error":{"message":"x","type":"x","code":429}}\n\ndata: [DONE]\n\n';
const NEUTRAL_503_BODY =
  'data: {"error":{"code":503,"type":"x","message":"x"}}\n\ndata: [DONE]\n\n';

const retryableCategories: InferenceFailureCategory[] = [
  "blank-response",
  "malformed-response",
  "timeout",
  "throttled",
  "provider-transient",
];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("readProviderStreamErrorEvent", () => {
  it.each([
    ["an NVIDIA API Catalog 503", OVERLOADED_EVENT, { status: 503, serverFault: true }],
    [
      "a declared 429",
      '{"error":{"message":"x","type":"rate_limit","code":429}}',
      { status: 429, serverFault: false },
    ],
    [
      "an OpenAI server_error with a string code",
      '{"error":{"message":"x","type":"server_error","code":"internal"}}',
      { serverFault: true },
    ],
    [
      "an Anthropic overloaded_error",
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      { serverFault: true },
    ],
    [
      "a code that is no failing status",
      '{"error":{"message":"x","type":"other","code":200}}',
      { serverFault: false },
    ],
  ])("reads %s", (_label, data, expected) => {
    expect(readProviderStreamErrorEvent(data)).toEqual(expected);
  });

  it.each([
    ["an ordinary chunk", '{"id":"c","choices":[{"delta":{"content":"the \\"error\\" word"}}]}'],
    ["unparseable data", '{"error": {'],
    ["a string error", '{"error":"Service temporarily overloaded"}'],
    ["the stream terminator", "[DONE]"],
  ])("ignores %s", (_label, data) => {
    expect(readProviderStreamErrorEvent(data)).toBeUndefined();
  });
});

describe("observeProviderStreamErrors", () => {
  it("passes an ordinary stream through byte for byte and reports nothing", async () => {
    const body = textTurnBody("The review is complete.", "stop");
    const seen: unknown[] = [];
    const observed = observeProviderStreamErrors(sseResponse(body), (event) => seen.push(event));
    expect(observed.status).toBe(200);
    expect(observed.headers.get("content-type")).toBe("text/event-stream");
    expect(await observed.text()).toBe(body);
    expect(seen).toEqual([]);
  });

  it("reports an error event split across chunks, including a split CRLF", async () => {
    const body = OVERLOADED_BODY.replaceAll("\n", "\r\n");
    const bytes = encoder.encode(body);
    // One byte per chunk splits every line terminator and the event itself.
    const chunks = [...bytes].map((byte) => Uint8Array.of(byte));
    const seen: unknown[] = [];
    const observed = observeProviderStreamErrors(chunkedResponse(chunks), (event) =>
      seen.push(event),
    );
    expect(await observed.text()).toBe(body);
    expect(seen).toEqual([{ status: 503, serverFault: true }]);
  });

  it("hands each chunk on as it arrives, before the next one exists", async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
    });
    const seen: unknown[] = [];
    const observed = observeProviderStreamErrors(
      new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } }),
      (event) => seen.push(event),
    );
    const reader = observed.body!.getReader();
    const first = encoder.encode(`data: ${OVERLOADED_EVENT}\n\n`);
    source.enqueue(first);
    const read = await reader.read();
    // The same chunk reaches the consumer, and the event is known by then.
    expect(read.value).toBe(first);
    expect(seen).toEqual([{ status: 503, serverFault: true }]);
    const second = encoder.encode("data: [DONE]\n\n");
    source.enqueue(second);
    expect((await reader.read()).value).toBe(second);
    source.close();
    expect((await reader.read()).done).toBe(true);
  });

  it("reports only the first error event and ignores an unterminated one", async () => {
    const seen: unknown[] = [];
    await observeProviderStreamErrors(
      sseResponse(`data: ${OVERLOADED_EVENT}\n\n${QUOTA_BODY}`),
      (event) => seen.push(event),
    ).text();
    expect(seen).toEqual([{ status: 503, serverFault: true }]);

    const unterminated: unknown[] = [];
    await observeProviderStreamErrors(sseResponse(`data: ${OVERLOADED_EVENT}`), (event) =>
      unterminated.push(event),
    ).text();
    expect(unterminated).toEqual([]);
  });

  it("carries a consumer's cancellation to the provider stream", async () => {
    let cancelled: unknown;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: {}\n\n"));
      },
      cancel(reason) {
        cancelled = reason;
      },
    });
    const observed = observeProviderStreamErrors(new Response(upstream), () => undefined);
    const reader = observed.body!.getReader();
    await reader.read();
    await reader.cancel("consumer stopped");
    expect(cancelled).toBe("consumer stopped");
  });

  it.each(["data: ", "event: "])(
    "examines a long unfinished %s line in time linear in the stream",
    (prefix) => {
      const seen: unknown[] = [];
      const scanner = createProviderStreamErrorScanner((event) => seen.push(event));
      const piece = encoder.encode("x".repeat(1_024));
      const pieces = 512;
      const tail = `\n\ndata: ${OVERLOADED_EVENT}\n\n`;
      const total = prefix.length + piece.length * pieces + tail.length;
      // Rescanning the held line on every chunk would examine about
      // `pieces / 2` times the stream; one pass per character stays within a
      // small multiple of the stream: the line-end search plus one read of the
      // event data.
      const examined = charactersExamined(() => {
        scanner.push(encoder.encode(prefix));
        for (let index = 0; index < pieces; index += 1) scanner.push(piece);
        scanner.push(encoder.encode(tail));
      });
      expect(seen).toEqual([{ status: 503, serverFault: true }]);
      expect(examined).toBeGreaterThanOrEqual(total);
      expect(examined).toBeLessThanOrEqual(total * 3);
    },
  );

  it("reports only the first error event when a later chunk carries another", () => {
    const seen: unknown[] = [];
    const scanner = createProviderStreamErrorScanner((event) => seen.push(event));
    scanner.push(encoder.encode(`data: ${OVERLOADED_EVENT}\n\n`));
    scanner.push(encoder.encode(QUOTA_BODY));
    expect(seen).toEqual([{ status: 503, serverFault: true }]);
  });

  it("keeps a CRLF split by an empty decoded chunk one line end", () => {
    const seen: unknown[] = [];
    const scanner = createProviderStreamErrorScanner((event) => seen.push(event));
    scanner.push(encoder.encode(`data: ${OVERLOADED_EVENT}\r`));
    scanner.push(new Uint8Array(0));
    // This LF completes the CRLF, so the event is not dispatched yet.
    scanner.push(encoder.encode("\n"));
    expect(seen).toEqual([]);
    scanner.push(encoder.encode("\r\n"));
    expect(seen).toEqual([{ status: 503, serverFault: true }]);
  });

  it("drops a non-data line's text once its field name is known", () => {
    const seen: unknown[] = [];
    const scanner = createProviderStreamErrorScanner((event) => seen.push(event));
    // An `event:` line and a comment line never become data, whatever they hold.
    scanner.push(encoder.encode(`event: ${OVERLOADED_EVENT}\n: ${OVERLOADED_EVENT}\n\n`));
    expect(seen).toEqual([]);
    scanner.push(encoder.encode(`data: ${OVERLOADED_EVENT}\n\n`));
    expect(seen).toEqual([{ status: 503, serverFault: true }]);
  });

  it("decodes a multi-byte character split across chunks", async () => {
    const event =
      '{"error":{"message":"Überlastet — 服务繁忙 🚦","type":"service_unavailable","code":503}}';
    const body = `data: ${event}\n\ndata: [DONE]\n\n`;
    const chunks = [...encoder.encode(body)].map((byte) => Uint8Array.of(byte));
    const seen: unknown[] = [];
    const observed = observeProviderStreamErrors(chunkedResponse(chunks), (item) =>
      seen.push(item),
    );
    expect(await observed.text()).toBe(body);
    expect(seen).toEqual([{ status: 503, serverFault: true }]);
  });

  it("keeps the stream intact when the observer throws", async () => {
    const observed = observeProviderStreamErrors(sseResponse(OVERLOADED_BODY), () => {
      throw new Error("observer failed");
    });
    expect(await observed.text()).toBe(OVERLOADED_BODY);
  });

  it("hands an upstream read error to the consumer", async () => {
    const failure = new TypeError("terminated");
    let pulls = 0;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(encoder.encode("data: {}\n\n"));
        else controller.error(failure);
      },
    });
    const observed = observeProviderStreamErrors(new Response(upstream), () => undefined);
    const reader = observed.body!.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await expect(reader.read()).rejects.toBe(failure);
  });
});

describe("in-stream provider error classification", () => {
  const overloaded = { stopReason: "error", errorMessage: "Service temporarily overloaded" };

  it("records a declared 503 as a server error with its in-stream status", () => {
    const exchange = { sent: true, streamError: { status: 503, serverFault: true } };
    expect(observeLandedProviderTurn(overloaded, exchange)).toEqual({
      finishReason: "error",
      providerError: { class: "server", streamErrorStatus: 503 },
    });
    // The same message with no structured event names no class.
    expect(observeLandedProviderTurn(overloaded, { sent: true }).providerError).toEqual({
      class: "unknown",
    });
  });

  it("records a declared server-fault type with no status as a server error", () => {
    expect(
      observeLandedProviderTurn(overloaded, { sent: true, streamError: { serverFault: true } })
        .providerError,
    ).toEqual({ class: "server" });
  });

  it("lets a transport status outrank an in-stream declaration and records only it", () => {
    expect(
      classifyProviderError({ httpStatus: 400, streamError: { status: 503, serverFault: true } }),
    ).toBe("invalid-request");
    expect(
      observeLandedProviderTurn(overloaded, {
        sent: true,
        httpStatus: 502,
        streamError: { status: 429, serverFault: false },
      }).providerError,
    ).toEqual({ class: "server", httpStatus: 502 });
  });

  // A neutral type and message leave the declared status as the only signal.
  const neutral = { stopReason: "error", errorMessage: "x" };
  it.each([
    [503, "server", { retryable: true, category: "provider-transient" }],
    [500, "server", { retryable: true, category: "provider-transient" }],
    [504, "timeout", { retryable: true, category: "timeout" }],
    [429, "rate-limit", { retryable: false, category: "provider-terminal" }],
    [401, "auth", { retryable: false, category: "invalid-request" }],
    [400, "invalid-request", { retryable: false, category: "invalid-request" }],
  ] as const)(
    "classifies a declared %i with a neutral type and message as %s",
    (status, errorClass, turnDisposition) => {
      const exchange = { sent: true, streamError: { status, serverFault: false } };
      expect(classifyProviderError({ streamError: exchange.streamError, message: "x" })).toBe(
        errorClass,
      );
      const providerError = observeLandedProviderTurn(neutral, exchange).providerError;
      expect(providerError).toEqual({ class: errorClass, streamErrorStatus: status });
      expect(providerTurnFailureDisposition(neutral, exchange)).toEqual(turnDisposition);
      expect(
        sentProviderFailureDisposition({
          schemaVersion: 1,
          finishReason: "error",
          providerLatencyMs: 1,
          ...(providerError ? { providerError } : {}),
        }),
      ).toEqual({ ...turnDisposition, providerErrorClass: errorClass });
    },
  );

  it("keeps a content-filter stop ahead of an in-stream status", () => {
    expect(
      classifyProviderError({
        finishReason: "content-filter",
        streamError: { status: 503, serverFault: true },
      }),
    ).toBe("content-filter");
  });

  it("replays a declared 503 in the turn and retries it at the step as provider-transient", () => {
    const exchange = { sent: true, streamError: { status: 503, serverFault: true } };
    expect(providerTurnFailureDisposition(overloaded, exchange)).toEqual({
      retryable: true,
      category: "provider-transient",
    });
    const telemetry = {
      schemaVersion: 1 as const,
      finishReason: "error" as const,
      providerLatencyMs: 602,
      providerError: { class: "server" as const, streamErrorStatus: 503 },
    };
    expect(sentProviderFailureDisposition(telemetry)).toEqual({
      category: "provider-transient",
      retryable: true,
      providerErrorClass: "server",
    });
    const decided = decideSentProviderFailure(
      new InferenceStepError(
        "Model request failed [provider-terminal; retryable=false]: Provider turn failed: provider-failed: Service temporarily overloaded.",
        "provider-terminal",
        false,
        { modelTelemetry: telemetry },
      ),
    );
    expect(decided).toMatchObject({ category: "provider-transient", retryable: true });
    expect(decided.message).toBe(
      "Model request failed [provider-transient; retryable=true]: the sent provider request ended with a server error (in-stream status 503).",
    );
  });

  it("keeps a declared 429 with no transport status a terminal quota wall", () => {
    const exchange = { sent: true, streamError: { status: 429, serverFault: false } };
    const quota = { stopReason: "error", errorMessage: "Too many requests" };
    const providerError = observeLandedProviderTurn(quota, exchange).providerError;
    expect(providerError).toEqual({ class: "rate-limit", streamErrorStatus: 429 });
    expect(providerTurnFailureDisposition(quota, exchange)).toEqual({
      retryable: false,
      category: "provider-terminal",
    });
    expect(
      sentProviderFailureDisposition({
        schemaVersion: 1,
        finishReason: "error",
        providerLatencyMs: 1,
        ...(providerError ? { providerError } : {}),
      }),
    ).toEqual({
      category: "provider-terminal",
      retryable: false,
      providerErrorClass: "rate-limit",
    });
  });
});

describe("a 2xx stream that closes before [DONE] (#1696)", () => {
  const PARTIAL = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n';

  async function closedBeforeDone(body: string | Response): Promise<number> {
    let reports = 0;
    const response = typeof body === "string" ? sseResponse(body) : body;
    const observed = observeProviderStreamErrors(
      response,
      () => undefined,
      () => {
        reports += 1;
      },
    );
    await observed.text();
    return reports;
  }

  it("reports a clean end of body with no [DONE] once", async () => {
    expect(await closedBeforeDone(PARTIAL)).toBe(1);
    expect(await closedBeforeDone("")).toBe(1);
  });

  it.each([
    ["a [DONE] event", `${PARTIAL}data: [DONE]\n\n`],
    ["a CRLF [DONE] event", `${PARTIAL}data: [DONE]\r\n\r\n`],
    ["a structured error event", `${PARTIAL}data: ${OVERLOADED_EVENT}\n\n`],
  ])("reports nothing for a body that ends with %s", async (_label, body) => {
    expect(await closedBeforeDone(body)).toBe(0);
  });

  it("reports an unterminated [DONE], which the consumer discards", async () => {
    expect(await closedBeforeDone(`${PARTIAL}data: [DONE]`)).toBe(1);
  });

  it("reports a [DONE] split across chunks as seen", async () => {
    const chunks = [...encoder.encode(`${PARTIAL}data: [DONE]\n\n`)].map((byte) =>
      Uint8Array.of(byte),
    );
    expect(await closedBeforeDone(chunkedResponse(chunks))).toBe(0);
  });

  it("reports nothing for a body that fails before its end", async () => {
    let reports = 0;
    let pulls = 0;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(encoder.encode(PARTIAL));
        else controller.error(new TypeError("terminated"));
      },
    });
    const observed = observeProviderStreamErrors(
      new Response(upstream),
      () => undefined,
      () => {
        reports += 1;
      },
    );
    await expect(observed.text()).rejects.toThrow("terminated");
    expect(reports).toBe(0);
  });

  it("keeps the stream intact when the end observer throws", async () => {
    const observed = observeProviderStreamErrors(
      sseResponse(PARTIAL),
      () => undefined,
      () => {
        throw new Error("observer failed");
      },
    );
    expect(await observed.text()).toBe(PARTIAL);
  });

  const cut = { stopReason: "error", errorMessage: "Stream ended without finish_reason" };
  const closed = { sent: true, streamClosedBeforeDone: true } as const;

  it("records a turn that ended with no finish reason as stream-incomplete", () => {
    expect(observeLandedProviderTurn(cut, closed)).toEqual({
      finishReason: "error",
      providerError: { class: "stream-incomplete" },
    });
    expect(providerTurnFailureDisposition(cut, closed)).toEqual({
      retryable: true,
      category: "provider-transient",
    });
    // Without the transport fact, Pi's message alone names no class.
    expect(observeLandedProviderTurn(cut, { sent: true }).providerError).toEqual({
      class: "unknown",
    });
  });

  it("does not read a turn the provider finished as stream-incomplete", () => {
    const finished = { ...cut, rawStopReason: "network_error" };
    expect(observeLandedProviderTurn(finished, closed).providerError).toEqual({
      class: "unknown",
    });
  });

  it("lets a status or a structured error event outrank the closed stream", () => {
    expect(
      classifyProviderError({ streamIncomplete: true, streamError: { serverFault: false } }),
    ).toBe("unknown");
    expect(classifyProviderError({ streamIncomplete: true, httpStatus: 503 })).toBe("server");
    expect(classifyProviderError({ streamIncomplete: true, finishReason: "content-filter" })).toBe(
      "content-filter",
    );
    expect(classifyProviderError({ streamIncomplete: true, message: "Connection error." })).toBe(
      "stream-incomplete",
    );
  });

  it("records no provider error for a request that never left the host", () => {
    expect(
      observeLandedProviderTurn(cut, { sent: false, streamClosedBeforeDone: true }).providerError,
    ).toBeUndefined();
  });
});

describe("recorded in-stream error status", () => {
  const withError = (providerError: object) => ({
    schemaVersion: 1,
    finishReason: "error",
    providerLatencyMs: 1,
    providerError,
  });

  it("admits a failing in-stream status on its own", () => {
    expect(
      isInferenceAttemptModelTelemetry(
        withError({ class: "server", streamErrorStatus: 503 }),
        "provider-transient",
      ),
    ).toBe(true);
  });

  it.each([
    ["beside a transport status", { class: "server", httpStatus: 502, streamErrorStatus: 503 }],
    ["that is no failing status", { class: "server", streamErrorStatus: 200 }],
    ["that is not an integer status", { class: "server", streamErrorStatus: "503" }],
    [
      "as the only status for a Retry-After",
      {
        class: "server",
        streamErrorStatus: 503,
        retryAfterMs: 1_000,
      },
    ],
  ])("refuses one %s", (_label, providerError) => {
    expect(isInferenceAttemptModelTelemetry(withError(providerError), "provider-transient")).toBe(
      false,
    );
  });
});

describe("PiHarness with a 200 stream that ends in a provider error event (scripted fetch)", () => {
  const policy: InferenceRetryPolicy = {
    maxRetries: 2,
    baseDelayMs: 0,
    maxDelayMs: 0,
    retryableCategories,
  };

  it(
    "replays a declared 503 inside the turn and succeeds",
    async () => {
      const repositoryPath = await createRepository();
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          calls += 1;
          return calls === 1
            ? sseResponse(OVERLOADED_BODY)
            : sseResponse(textTurnBody("The review is complete.", "stop"));
        }),
      );
      const execution = await runStep(stepInput(repositoryPath), { ...policy, maxRetries: 0 });

      expect(calls).toBe(2);
      expect(execution.status).toBe("succeeded");
      expect(execution.evidence.attempts).toHaveLength(1);
      expect(execution.evidence.attempts[0]?.turns?.[0]?.providerRetries).toBe(1);
    },
    SLOW,
  );

  it(
    "retries a declared 503 at the step and records it truthfully",
    async () => {
      const repositoryPath = await createRepository();
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          calls += 1;
          return calls === 1
            ? sseResponse(OVERLOADED_BODY)
            : sseResponse(textTurnBody("The review is complete.", "stop"));
        }),
      );
      const execution = await runStep(stepInput(repositoryPath), policy, { inTurnAttempts: 1 });

      expect(calls).toBe(2);
      expect(execution.status).toBe("succeeded");
      const [overloaded, retried] = execution.evidence.attempts;
      expect(overloaded).toMatchObject({
        attempt: 1,
        outcome: "provider-transient",
        retryable: true,
        retryScheduled: true,
        modelTelemetry: {
          finishReason: "error",
          providerError: { class: "server", streamErrorStatus: 503 },
        },
      });
      expect(overloaded?.modelTelemetry?.providerError?.httpStatus).toBeUndefined();
      expect(retried).toMatchObject({ attempt: 2, outcome: "succeeded" });
      expect(JSON.stringify(execution.evidence)).not.toContain("overloaded");
      expect(() => decodeInference(structuredClone(execution.evidence))).not.toThrow();
    },
    SLOW,
  );

  it(
    "ends a provider that stays overloaded as transient, with no capability-wall advice",
    async () => {
      const repositoryPath = await createRepository();
      const provider = vi.fn(async () => sseResponse(OVERLOADED_BODY));
      vi.stubGlobal("fetch", provider);
      const execution = await runStep(stepInput(repositoryPath), policy, { inTurnAttempts: 1 });

      expect(provider).toHaveBeenCalledTimes(policy.maxRetries + 1);
      expect(execution.status).toBe("failed");
      const last = execution.evidence.attempts.at(-1)!;
      expect(last).toMatchObject({ outcome: "provider-transient", retryable: true });
      const record = failedRecord(last);
      const action = buildRunHumanNextCommand({
        record,
        recordPath: "/tmp/state/telemetry-run.json",
        repositoryPath,
        exitCode: 1,
      });
      expect(action?.reason).toContain("ended on a transient failure");
      expect(action?.reason).not.toContain("Do not retry the unchanged request");
      const lines = formatRunFailureDiagnosticLines(record);
      expect(lines).toContain("Failure class: flake (layer inference, code provider-transient).");
      expect(lines.find((line) => line.startsWith("Model telemetry:"))).toMatch(
        /; provider error server \(in-stream status 503\)\.$/u,
      );
    },
    SLOW,
  );

  it(
    "retries a declared 503 whose type and message name no fault",
    async () => {
      const repositoryPath = await createRepository();
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          calls += 1;
          return calls === 1
            ? sseResponse(NEUTRAL_503_BODY)
            : sseResponse(textTurnBody("The review is complete.", "stop"));
        }),
      );
      const execution = await runStep(stepInput(repositoryPath), policy, { inTurnAttempts: 1 });

      expect(calls).toBe(2);
      expect(execution.status).toBe("succeeded");
      expect(execution.evidence.attempts[0]).toMatchObject({
        outcome: "provider-transient",
        retryable: true,
        retryScheduled: true,
        modelTelemetry: { providerError: { class: "server", streamErrorStatus: 503 } },
      });
    },
    SLOW,
  );

  it(
    "retries at the step a declared 503 that arrives after content already streamed",
    async () => {
      const repositoryPath = await createRepository();
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          calls += 1;
          return calls === 1
            ? sseResponse(partialThenOverloadedBody())
            : sseResponse(textTurnBody("The review is complete.", "stop"));
        }),
      );
      const outputs: string[][] = [];
      const execution = await runStep(stepInput(repositoryPath), policy, { outputs });

      expect(calls).toBe(2);
      expect(execution.status).toBe("succeeded");
      const [overloaded, retried] = execution.evidence.attempts;
      expect(overloaded).toMatchObject({
        attempt: 1,
        outcome: "provider-transient",
        retryable: true,
        retryScheduled: true,
        modelTelemetry: { providerError: { class: "server", streamErrorStatus: 503 } },
      });
      // The consumer already owned text, so the turn could not replay it.
      expect(overloaded?.turns?.at(-1)?.providerReplayVeto).toBe("partial-stream");
      expect(outputs[0]?.join("")).toContain("partial");
      expect(outputs[1]?.join("")).not.toContain("partial");
      expect(retried).toMatchObject({ attempt: 2, outcome: "succeeded" });
      expect(() => decodeInference(structuredClone(execution.evidence))).not.toThrow();
    },
    SLOW,
  );

  it(
    "does not retry a declared 429 with no transport status",
    async () => {
      const repositoryPath = await createRepository();
      const provider = vi.fn(async () => sseResponse(QUOTA_BODY));
      vi.stubGlobal("fetch", provider);
      const execution = await runStep(stepInput(repositoryPath), policy);

      expect(provider).toHaveBeenCalledTimes(1);
      expect(execution.status).toBe("failed");
      expect(execution.evidence.attempts).toHaveLength(1);
      expect(execution.evidence.attempts[0]).toMatchObject({
        outcome: "provider-terminal",
        retryable: false,
        retryScheduled: false,
        modelTelemetry: { providerError: { class: "rate-limit", streamErrorStatus: 429 } },
      });
    },
    SLOW,
  );

  it(
    "keeps a non-2xx 503 a transport status with no in-stream status",
    async () => {
      const repositoryPath = await createRepository();
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          calls += 1;
          return calls === 1
            ? new Response(OVERLOADED_EVENT, {
                status: 503,
                headers: { "content-type": "application/json" },
              })
            : sseResponse(textTurnBody("The review is complete.", "stop"));
        }),
      );
      const execution = await runStep(stepInput(repositoryPath), policy, { inTurnAttempts: 1 });

      expect(calls).toBe(2);
      expect(execution.status).toBe("succeeded");
      expect(execution.evidence.attempts[0]?.modelTelemetry?.providerError).toEqual({
        class: "server",
        httpStatus: 503,
      });
    },
    SLOW,
  );
});

async function runStep(
  input: HarnessStepInput,
  policy: InferenceRetryPolicy,
  options: { inTurnAttempts?: number; outputs?: string[][] } = {},
) {
  const harness = new PiHarness({
    skillCrateDirectory,
    model: validModelConfig,
    // Instant in-turn replay, so a retryable provider error spends no wall time.
    createConnection: (model, connectionOptions) =>
      createModelConnection(
        model,
        connectionOptions
          ? {
              ...connectionOptions,
              providerTurnRetry: {
                baseDelayMs: 0,
                maxDelayMs: 0,
                ...(options.inTurnAttempts === undefined
                  ? {}
                  : { maxAttempts: options.inTurnAttempts, maxBlankAttempts: 1 }),
              },
            }
          : connectionOptions,
      ),
  });
  return executeInferenceStep({
    mode: "read-only",
    policy,
    evidenceIdentity: input.evidenceIdentity,
    sleep: async () => undefined,
    execute: (attempt) => {
      const output: string[] = [];
      options.outputs?.push(output);
      return harness.runStep({
        ...input,
        inferenceAttempt: attempt,
        retriesConsumed: attempt - 1,
        onText: (text) => output.push(text),
      });
    },
  });
}

/** A 200 stream that commits text and then ends in a declared 503 event. */
function partialThenOverloadedBody(): string {
  const first = {
    id: "completion-stream-error-partial",
    object: "chat.completion.chunk",
    created: 1,
    model: validModelConfig.modelId,
    choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }],
  };
  return `data: ${JSON.stringify(first)}\n\n${OVERLOADED_BODY}`;
}

async function createRepository(): Promise<string> {
  const repositoryPath = await mkdtemp(resolve(tmpdir(), "docsfab-stream-error-"));
  temporaryDirectories.push(repositoryPath);
  await writeFile(resolve(repositoryPath, "README.md"), "# Fixture\n");
  return repositoryPath;
}

function stepInput(repositoryPath: string): HarnessStepInput {
  const workflow = getWorkflow("review-documentation");
  return {
    runId: "stream-error-run",
    repositoryPath,
    workflow,
    step: workflow.steps[0]!,
    evidenceIdentity: { repositoryRevision: "a".repeat(40) },
  };
}

function failedRecord(attempt: InferenceAttemptEvidence): RunRecord {
  return {
    schemaVersion: 2,
    id: "telemetry-run",
    workflow: "review-documentation",
    repository: { sourcePath: "/fixture", requestedRevision: "HEAD", revision: "a".repeat(40) },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "failed",
    createdAt: "2026-09-30T12:00:00.000Z",
    models: [],
    skills: [],
    steps: [
      {
        id: "provisional-technical-verification",
        title: "Technical verification",
        skill: "verify-technical-accuracy",
        mode: "read-only",
        status: "failed",
        inference: {
          configuredMaxRetries: 2,
          effectiveMaxRetries: 2,
          baseDelayMs: 0,
          maxDelayMs: 0,
          retryableCategories,
          replay: "read-only",
          attempts: [attempt],
        },
      },
    ],
  } as unknown as RunRecord;
}

/**
 * Characters that string searches examine while `run` executes: each regular
 * expression match counts from its start index to the end of its input, and
 * each search-style string method counts its whole receiver.
 */
function charactersExamined(run: () => void): number {
  let examined = 0;
  const exec = RegExp.prototype.exec;
  const spies: { mockRestore(): void }[] = [
    vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (this: RegExp, input: string) {
      const from = this.global || this.sticky ? this.lastIndex : 0;
      examined += Math.max(0, String(input).length - from);
      return exec.call(this, input);
    }),
  ];
  const methods = [
    "indexOf",
    "lastIndexOf",
    "includes",
    "search",
    "match",
    "split",
    "replace",
    "replaceAll",
  ] as const;
  for (const method of methods) {
    const original = String.prototype[method] as (...args: unknown[]) => unknown;
    spies.push(
      vi.spyOn(String.prototype, method).mockImplementation(function (
        this: string,
        ...args: unknown[]
      ) {
        examined += this.length;
        return original.apply(this, args);
      } as never),
    );
  }
  try {
    run();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return examined;
}

function sseResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chunkedResponse(chunks: readonly Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function textTurnBody(value: string, finishReason: string): string {
  const chunk = (delta: object, finish: string | null, extra: object = {}) => ({
    id: "completion-stream-error-turn",
    object: "chat.completion.chunk",
    created: 1,
    model: validModelConfig.modelId,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  });
  return [
    chunk({ role: "assistant", content: value }, null),
    chunk({}, finishReason, {
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  ]
    .map((item) => `data: ${JSON.stringify(item)}\n\n`)
    .concat("data: [DONE]\n\n")
    .join("");
}
