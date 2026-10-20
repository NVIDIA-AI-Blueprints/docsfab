// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-attempt model telemetry (finish reason, output against the allowance,
 * provider latency, provider error class) recorded by the real Pi session, and
 * its closed vocabularies. Every provider here is a scripted `fetch`; no
 * request leaves the host.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HarnessStepInput } from "../src/execution/contracts.js";
import { migrateLegacyInferenceAttemptEvidence } from "../src/execution/lease-contracts.js";
import { PiHarness, type PiHarnessOptions } from "../src/harness/pi.js";
import { EXECUTION_LEASE_DEFAULTS } from "../src/execution/lease-contracts.js";
import { canonicalDigest } from "../src/contract-kit/index.js";
import type { BoundModelExecutionProfile } from "../src/model/configuration.js";
import {
  DOCSFAB_SYSTEM_PROMPT,
  DOCSFAB_SYSTEM_PROMPT_SHA256,
} from "../src/model/request-policy.js";
import { grantedTurnOutputTokens } from "../src/model/context-budget.js";
import {
  classifyProviderError,
  normalizeModelFinishReason,
  observeLandedProviderTurn,
} from "../src/model/attempt-telemetry.js";
import { parseRetryPolicy } from "../src/config/retry-policy.js";
import { isDefinitiveConnectFailure } from "../src/model/endpoint-connect-failure.js";
import { createModelConnection, createProviderConnectionFactory } from "../src/model/provider.js";
import { providerErrorDisposition } from "../src/model/sent-provider-failure.js";
import { providerFailureReason } from "../src/live-agent/provider-failure.js";
import { buildRunHumanNextCommand } from "../src/operator/run-next-action.js";
import { formatRunFailureDiagnosticLines } from "../src/operator/run-summary.js";
import type { InferenceAttemptEvidence, RunRecord } from "../src/records/contracts.js";
import {
  isInferenceAttemptModelTelemetry,
  MODEL_FINISH_REASONS,
  PROVIDER_ERROR_CLASSES,
} from "../src/records/model-telemetry.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import { validModelConfig } from "./helpers.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillCrateDirectory = resolve(projectRoot, "skill-crate");
const temporaryDirectories: string[] = [];
const SLOW = testTimeoutMs(20_000);

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("normalizeModelFinishReason (#1185)", () => {
  it.each([
    // Raw provider tokens, across transport vocabularies.
    ["stop", "stop", "stop"],
    ["stop", "end_turn", "stop"],
    ["stop", "completed", "stop"],
    ["length", "length", "length"],
    ["length", "max_tokens", "length"],
    ["length", "MAX_TOKENS", "length"],
    ["length", "incomplete.max_output_tokens", "length"],
    ["toolUse", "tool_calls", "tool-use"],
    ["toolUse", "tool_use", "tool-use"],
    ["error", "content_filter", "content-filter"],
    ["error", "refusal", "content-filter"],
    ["error", "SAFETY", "content-filter"],
    ["error", "network_error", "error"],
    ["aborted", "cancelled", "aborted"],
    // A token no transport vocabulary declares is `unknown`, not Pi's guess.
    ["error", "brand_new_reason", "unknown"],
    // No raw token: Pi's own closed stop reason decides.
    ["stop", undefined, "stop"],
    ["length", undefined, "length"],
    ["toolUse", undefined, "tool-use"],
    ["error", undefined, "error"],
    ["aborted", undefined, "aborted"],
    ["deferred", undefined, "unknown"],
    [undefined, undefined, "unknown"],
  ])("maps stopReason=%s rawStopReason=%s to %s", (stopReason, raw, expected) => {
    expect(normalizeModelFinishReason(stopReason, raw)).toBe(expected);
  });

  it("covers every member of the closed finish-reason set", () => {
    const produced = new Set(
      [
        ["stop", "stop"],
        ["length", "length"],
        ["toolUse", "tool_calls"],
        ["error", "content_filter"],
        ["error", "network_error"],
        ["aborted", undefined],
        ["error", "not_a_known_token"],
      ].map(([stop, raw]) => normalizeModelFinishReason(stop, raw)),
    );
    expect([...produced].sort()).toEqual([...MODEL_FINISH_REASONS].sort());
  });
});

describe("classifyProviderError (#1185)", () => {
  it.each([
    [{ httpStatus: 429 }, "rate-limit"],
    [{ httpStatus: 401 }, "auth"],
    [{ httpStatus: 403 }, "auth"],
    [{ httpStatus: 408 }, "timeout"],
    [{ httpStatus: 504 }, "timeout"],
    [{ httpStatus: 500 }, "server"],
    [{ httpStatus: 503 }, "server"],
    [{ httpStatus: 400 }, "invalid-request"],
    [{ httpStatus: 422 }, "invalid-request"],
    // Several front doors send a safety refusal as a plain 400.
    [{ httpStatus: 400, message: '400: {"code":"content_filter"}' }, "content-filter"],
    [{ finishReason: "content-filter" as const }, "content-filter"],
    // No status reached the host: the message picks the class.
    [{ message: "Connection error." }, "network"],
    [{ message: "connect ECONNREFUSED 127.0.0.1:443" }, "network"],
    // The transport saw a definitive connect failure; the text would say network.
    [{ connectFailed: true, message: "Connection error." }, "unreachable"],
    [{ httpStatus: 503, connectFailed: true }, "server"],
    [{ message: "Request timed out." }, "timeout"],
    [{ message: "Rate limit reached for requests" }, "rate-limit"],
    [{ message: "Invalid API key provided" }, "auth"],
    [{ message: "something nobody anticipated" }, "unknown"],
    [{}, "unknown"],
  ])("classifies %j as %s", (input, expected) => {
    expect(classifyProviderError(input)).toBe(expected);
  });

  it("lets the observed status outrank a status the provider body names", () => {
    expect(classifyProviderError({ httpStatus: 503, message: "status 429 upstream" })).toBe(
      "server",
    );
  });

  it("reaches every member of the closed provider-error set", () => {
    const produced = new Set(
      [
        { httpStatus: 429 },
        { httpStatus: 401 },
        { httpStatus: 503 },
        { httpStatus: 408 },
        { finishReason: "content-filter" as const },
        { message: "Connection error." },
        { streamIncomplete: true },
        { connectFailed: true },
        { httpStatus: 400 },
        {},
      ].map((input) => classifyProviderError(input)),
    );
    expect([...produced].sort()).toEqual([...PROVIDER_ERROR_CLASSES].sort());
  });
});

describe("observeLandedProviderTurn (#1185)", () => {
  it("records no provider error for a request that never left the host", () => {
    // Whatever Pi's message says, an unsent request is DocsFab's refusal.
    for (const errorMessage of [
      "Provider turn stopped locally: reason=context-exhausted",
      "Connection error.",
      "503: a wording that looks like a provider failure",
    ]) {
      expect(
        observeLandedProviderTurn({ stopReason: "error", errorMessage }, { sent: false }),
      ).toEqual({
        finishReason: "error",
      });
    }
    expect(observeLandedProviderTurn({ stopReason: "error", errorMessage: "x" })).toEqual({
      finishReason: "error",
    });
  });

  it("keeps the transport's observed status and Retry-After", () => {
    expect(
      observeLandedProviderTurn(
        { stopReason: "error", errorMessage: "400 status code (no body)" },
        { sent: true, httpStatus: 429, retryAfterMs: 2_000 },
      ),
    ).toEqual({
      finishReason: "error",
      providerError: { class: "rate-limit", httpStatus: 429, retryAfterMs: 2_000 },
    });
  });

  it("never parses a status out of the message text", () => {
    expect(
      observeLandedProviderTurn(
        { stopReason: "error", errorMessage: "503: upstream down" },
        { sent: true },
      ),
    ).toEqual({ finishReason: "error", providerError: { class: "unknown" } });
  });

  it("records a completed turn's finish reason and no error", () => {
    expect(
      observeLandedProviderTurn({ stopReason: "length", rawStopReason: "length" }, { sent: true }),
    ).toEqual({ finishReason: "length" });
  });
});

describe("isInferenceAttemptModelTelemetry (#1185)", () => {
  const valid = {
    schemaVersion: 1,
    finishReason: "error",
    outputTokens: 0,
    outputAllowance: 16_384,
    providerLatencyMs: 12,
    providerError: { class: "rate-limit", httpStatus: 429, retryAfterMs: 2_000 },
  };

  it("admits closed values and integers", () => {
    expect(isInferenceAttemptModelTelemetry(valid, "throttled")).toBe(true);
    expect(
      isInferenceAttemptModelTelemetry({ schemaVersion: 1, providerLatencyMs: 0 }, "succeeded"),
    ).toBe(true);
  });

  it.each([
    ["an unknown key", { ...valid, rawStopReason: "stop" }],
    ["free text as the finish reason", { ...valid, finishReason: "the model stopped" }],
    ["free text as the error class", { ...valid, providerError: { class: "503: upstream down" } }],
    ["error text beside the class", { ...valid, providerError: { class: "server", message: "x" } }],
    ["an out-of-range status", { ...valid, providerError: { class: "server", httpStatus: 999 } }],
    ["a negative latency", { ...valid, providerLatencyMs: -1 }],
    ["a zero allowance", { ...valid, outputAllowance: 0 }],
    ["a provider error without a finish reason", { ...valid, finishReason: undefined }],
    ["another schema version", { ...valid, schemaVersion: 2 }],
  ])("refuses %s", (_label, value) => {
    expect(isInferenceAttemptModelTelemetry(value, "throttled")).toBe(false);
  });

  it("refuses a provider error on a succeeded attempt", () => {
    expect(isInferenceAttemptModelTelemetry(valid, "succeeded")).toBe(false);
  });

  it("is admitted by the lease migration only when valid", () => {
    const attempt = (modelTelemetry: unknown) =>
      ({
        attempt: 1,
        outcome: "throttled",
        retryable: true,
        retryScheduled: false,
        durationMs: 1,
        modelTelemetry,
      }) as unknown as InferenceAttemptEvidence;
    expect(() => migrateLegacyInferenceAttemptEvidence(attempt(valid))).not.toThrow();
    expect(() =>
      migrateLegacyInferenceAttemptEvidence(
        attempt({ ...valid, providerError: { class: "server", message: "provider body text" } }),
      ),
    ).toThrow();
  });
});

describe("PiHarness per-attempt model telemetry (#1185)", () => {
  const allowance = (attempt: InferenceAttemptEvidence): number =>
    grantedTurnOutputTokens(attempt.turns!.filter((turn) => turn.decision !== "stop").at(-1)!);

  it(
    "records finish reason, output against the allowance, and latency on a succeeded attempt",
    async () => {
      const repositoryPath = await createRepository();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          await new Promise((settle) => setTimeout(settle, 40));
          return textTurn("The review is complete.", "stop", {
            prompt_tokens: 10,
            completion_tokens: 7,
            total_tokens: 17,
          });
        }),
      );
      const attempt = await runOneAttempt(stepInput(repositoryPath));

      expect(attempt.outcome).toBe("succeeded");
      expect(attempt.modelTelemetry).toMatchObject({
        schemaVersion: 1,
        finishReason: "stop",
        outputTokens: 7,
        outputAllowance: allowance(attempt),
      });
      expect(attempt.modelTelemetry?.providerError).toBeUndefined();
      // The provider held the response for 40 ms; the attempt's wall clock
      // bounds the provider's share from above.
      expect(attempt.modelTelemetry?.providerLatencyMs).toBeGreaterThanOrEqual(30);
      expect(attempt.modelTelemetry?.providerLatencyMs).toBeLessThanOrEqual(attempt.durationMs);
      expect(isInferenceAttemptModelTelemetry(attempt.modelTelemetry, attempt.outcome)).toBe(true);
    },
    SLOW,
  );

  it(
    "reports a JSON reply cut at the output limit as truncated, not as a shape rejection",
    async () => {
      const repositoryPath = await createRepository();
      const cut = '{"review":{"verdict":"needs-revision","issues":[{"severity":"major","summ';
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          textTurn(cut, "length", { prompt_tokens: 900, completion_tokens: 64, total_tokens: 964 }),
        ),
      );
      const attempt = await runOneAttempt(reviewStepInput(repositoryPath));

      expect(attempt.outcome).toBe("malformed-response");
      expect(attempt.rejection).toEqual({ code: "text-truncated", location: "$response" });
      expect(attempt.modelTelemetry).toMatchObject({
        finishReason: "length",
        outputTokens: 64,
        outputAllowance: allowance(attempt),
      });
      const lines = formatRunFailureDiagnosticLines(failedRecord(attempt));
      expect(lines).toContain("Rejected by text-truncated at $response.");
      expect(lines).toContain(
        `Model telemetry: finish reason length; output 64 of ${allowance(attempt)} allowed tokens;` +
          ` provider latency ${attempt.modelTelemetry!.providerLatencyMs} ms.`,
      );
      expect(lines.join("\n")).not.toContain("invalid-shape");
      expect(lines.join("\n")).not.toContain("json-unexpected-end");
    },
    SLOW,
  );

  it(
    "keeps the parser's code for the same cut JSON when the provider reported a normal stop",
    async () => {
      const repositoryPath = await createRepository();
      const cut = '{"review":{"verdict":"needs-revision","issues":[{"severity":"major","summ';
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => textTurn(cut, "stop")),
      );
      const attempt = await runOneAttempt(reviewStepInput(repositoryPath));

      expect(attempt.outcome).toBe("malformed-response");
      // The finish reason tells the two apart: a normal stop keeps the parser's
      // own syntax code.
      expect(attempt.rejection).toEqual({ code: "json-unexpected-end", location: "$response" });
      expect(attempt.modelTelemetry?.finishReason).toBe("stop");
    },
    SLOW,
  );

  it.each([
    ["rate-limit", 429, { "retry-after": "2" }, { retryAfterMs: 2_000 }],
    ["auth", 401, {}, {}],
    ["server", 503, {}, {}],
    ["timeout", 408, {}, {}],
    ["invalid-request", 400, {}, {}],
  ] as const)(
    "classifies a provider %s error (HTTP %i) from the status the host received",
    async (expectedClass, status, headers, extra) => {
      const repositoryPath = await createRepository();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => errorResponse(status, headers)),
      );
      const attempt = await runOneAttempt(stepInput(repositoryPath));

      expect(attempt.outcome).not.toBe("succeeded");
      expect(attempt.modelTelemetry).toMatchObject({
        finishReason: "error",
        providerError: { class: expectedClass, httpStatus: status, ...extra },
      });
      // The provider body never reaches the record.
      expect(JSON.stringify(attempt.modelTelemetry)).not.toContain("provider body text");
      expect(isInferenceAttemptModelTelemetry(attempt.modelTelemetry, attempt.outcome)).toBe(true);
    },
    SLOW,
  );

  it(
    "classifies a transport failure with no HTTP response as network",
    async () => {
      const repositoryPath = await createRepository();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("fetch failed");
        }),
      );
      const attempt = await runOneAttempt(stepInput(repositoryPath));

      expect(attempt.modelTelemetry?.finishReason).toBe("error");
      expect(attempt.modelTelemetry?.providerError).toEqual({ class: "network" });
    },
    SLOW,
  );

  it(
    "records a content-filter stop as its own finish reason and error class",
    async () => {
      const repositoryPath = await createRepository();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => textTurn("", "content_filter")),
      );
      const attempt = await runOneAttempt(stepInput(repositoryPath));

      expect(attempt.outcome).not.toBe("succeeded");
      expect(attempt.modelTelemetry).toMatchObject({
        finishReason: "content-filter",
        providerError: { class: "content-filter" },
      });
      expect(attempt.modelTelemetry?.providerError?.httpStatus).toBeUndefined();
    },
    SLOW,
  );

  it(
    "maps an unrecognized provider finish reason to unknown without retaining it",
    async () => {
      const repositoryPath = await createRepository();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => textTurn("", "novel_vendor_reason")),
      );
      const attempt = await runOneAttempt(stepInput(repositoryPath));

      expect(attempt.modelTelemetry?.finishReason).toBe("unknown");
      expect(JSON.stringify(attempt.modelTelemetry)).not.toContain("novel_vendor_reason");
    },
    SLOW,
  );
});

describe("PiHarness provider-error attribution (#1185, !1116 review)", () => {
  it.each([
    ["step physical-attempt ledger", "maxPhysicalRequestsPerStep"],
    ["turn governor", "maxProviderTurns"],
  ] as const)(
    "records no provider error when the %s refuses a turn after sent turns",
    async (_label, bound) => {
      const repositoryPath = await createRepository();
      // One turn short of the hard tool-call ceiling; the bound then refuses the
      // next turn before any request, after a sent turn.
      const callsPerTurn = 5;
      const sentTurns = EXECUTION_LEASE_DEFAULTS.hardToolCallCeiling / callsPerTurn - 1;
      // Distinct pages: unchanged re-reads would be a read loop, which the host
      // stops long before any call ceiling.
      await mkdir(resolve(repositoryPath, "pages"), { recursive: true });
      await Promise.all(
        Array.from({ length: EXECUTION_LEASE_DEFAULTS.hardToolCallCeiling }, (_, index) =>
          writeFile(resolve(repositoryPath, "pages", `page-${index}.md`), `# Page ${index}\n`),
        ),
      );
      let call = 0;
      const provider = vi.fn(async () => {
        call += 1;
        return toolTurn(
          Array.from({ length: callsPerTurn }, (_, index) => ({
            id: `read-${call}-${index}`,
            name: "read",
            arguments: { path: `pages/page-${(call - 1) * callsPerTurn + index}.md` },
          })),
        );
      });
      vi.stubGlobal("fetch", provider);
      const attempt = await runOneAttempt(stepInput(repositoryPath), undefined, {
        [bound]: sentTurns,
      });

      expect(provider).toHaveBeenCalledTimes(sentTurns);
      expect(attempt.outcome).toBe("context-exhausted");
      // The telemetry is the last sent turn's; the refused turn sent nothing.
      expect(attempt.modelTelemetry?.finishReason).toBe("tool-use");
      expect(attempt.modelTelemetry?.providerError).toBeUndefined();
    },
    testTimeoutMs(60_000),
  );

  it(
    "records no provider error for DocsFab's own C-04 outbound credential refusal",
    async () => {
      const repositoryPath = await createRepository();
      // Turn 1 asks to read a path that holds one of DocsFab's own configured
      // credentials. The tool call carries it into turn 2's request, which the
      // outbound credential guard refuses before anything is sent. A
      // credential shape alone is not refused (#1807).
      const credential = configureCredential(["glpat", "Zq7Lm2Xv9Rt4Bn8Kc3Wd5Hj6"].join("-"));
      const provider = vi.fn(async () =>
        toolTurn([{ id: "call-0", name: "read", arguments: { path: `${credential}.md` } }]),
      );
      vi.stubGlobal("fetch", provider);
      const attempt = await runOneAttempt(stepInput(repositoryPath));

      expect(provider).toHaveBeenCalledTimes(1);
      expect(attempt.outcome).not.toBe("succeeded");
      expect(attempt.modelTelemetry?.finishReason).toBe("error");
      expect(attempt.modelTelemetry?.providerError).toBeUndefined();
    },
    SLOW,
  );

  it(
    "does not carry a replayed 503 onto a later failure after a 200 response",
    async () => {
      const repositoryPath = await createRepository();
      let call = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          call += 1;
          return call === 1 ? errorResponse(503, {}) : brokenStream();
        }),
      );
      const attempt = await runOneAttempt(stepInput(repositoryPath));

      expect(call).toBe(2);
      expect(attempt.outcome).not.toBe("succeeded");
      // A 200 stream that broke: a sent request with no error status, not the
      // 503 the replay absorbed.
      expect(attempt.modelTelemetry?.providerError).toEqual({ class: "network" });
    },
    SLOW,
  );

  it(
    "excludes tool execution time from provider latency",
    async () => {
      const repositoryPath = await createRepository();
      const toolHoldMs = 400;
      let call = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          call += 1;
          return call === 1
            ? toolTurn([{ id: "call-0", name: "ls", arguments: { path: "." } }])
            : textTurn("The review is complete.", "stop");
        }),
      );
      const attempt = await runOneAttempt(stepInput(repositoryPath), (session) => {
        session.subscribe((event) => {
          if (event.type !== "tool_execution_start") return;
          const until = Date.now() + toolHoldMs;
          while (Date.now() < until) {
            // Hold the tool so its time is measurable.
          }
        });
      });

      expect(attempt.outcome).toBe("succeeded");
      expect(attempt.durationMs).toBeGreaterThanOrEqual(toolHoldMs);
      expect(attempt.modelTelemetry!.providerLatencyMs).toBeLessThan(toolHoldMs);
    },
    SLOW,
  );
});

describe("provider connection exchange observation (#1185, !1116 review)", () => {
  it("marks a payload-hook refusal unsent and records no provider error", async () => {
    const run = await secondRequest(() => new Response(null, { status: 500 }), {
      onPayloadThrows: true,
    });
    expect(run.calls).toBe(1);
    expect(run.exchange).toEqual({ sent: false });
    expect(run.observed.providerError).toBeUndefined();
  });

  it.each([
    [
      // A renamed model is reported, never refused; a response naming none is.
      "a response that names no model",
      () =>
        new Response(
          'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      { sent: false, bodyReceived: true },
      false,
    ],
    [
      "a response over the byte limit",
      () =>
        new Response("x".repeat(CATALOG_COMPOSITION_POLICY.maxResponseBytes + 1), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      { sent: true, bodyReceived: true },
      true,
    ],
    [
      "a redirect",
      () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } }),
      { sent: false },
      false,
    ],
  ] as const)(
    "records whether the request was sent when the boundary refuses %s",
    async (_label, second, exchange, responseLimitRefused) => {
      const run = await secondRequest(second);
      expect(run.calls).toBe(2);
      expect(run.exchange).toEqual(exchange);
      expect(run.responseLimitRefusal !== undefined).toBe(responseLimitRefused);
      if (!responseLimitRefused) expect(run.observed.providerError).toBeUndefined();
    },
  );

  it("marks an in-turn replay refused before sending unsent, not the 503 it replays", async () => {
    const profile = catalogProfile();
    let calls = 0;
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: "down" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const connection = await factory.create(
      { profile, credential: { family: "nvidia-api-catalog", apiKey: "test-key" } },
      {
        evidenceIdentity: { repositoryRevision: "a".repeat(40) },
        providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 },
      },
    );
    let payloads = 0;
    const result = await connection.runtime
      .streamSimple(
        connection.model,
        {
          systemPrompt: DOCSFAB_SYSTEM_PROMPT,
          messages: [{ role: "user" as const, content: "Reply OK.", timestamp: 1 }],
          tools: [],
        },
        {
          maxTokens: 64,
          // The first request is sent and answered 503; the host refuses the replay.
          onPayload: (payload) => {
            payloads += 1;
            if (payloads > 1) throw new Error("The test payload hook refused this replay.");
            return payload;
          },
        },
      )
      .result();
    const exchange = connection.providerTransport!.lastExchange();
    expect(calls).toBe(1);
    expect(payloads).toBe(2);
    expect(exchange).toEqual({ sent: false });
    expect(observeLandedProviderTurn(result, exchange).providerError).toBeUndefined();
  });

  it("marks a governor-refused turn unsent after a sent one", async () => {
    const run = await secondRequest(() => new Response(null, { status: 500 }), {
      maxProviderTurns: 1,
    });
    expect(run.calls).toBe(1);
    expect(run.exchange).toEqual({ sent: false });
    expect(run.observed.providerError).toBeUndefined();
  });

  it("marks a non-2xx response sent with its status and Retry-After", async () => {
    const run = await secondRequest(
      () =>
        new Response(JSON.stringify({ error: { message: "down" } }), {
          status: 503,
          headers: { "content-type": "application/json", "retry-after": "3" },
        }),
    );
    expect(run.exchange).toEqual({
      sent: true,
      bodyReceived: true,
      httpStatus: 503,
      retryAfterMs: 3_000,
    });
    expect(run.observed.providerError).toEqual({
      class: "server",
      httpStatus: 503,
      retryAfterMs: 3_000,
    });
  });

  it("marks a network failure sent, even when its text mimics a DocsFab refusal", async () => {
    // Refusals are recognized by type, never by wording.
    const run = await secondRequest(() => {
      throw new TypeError("Provider response rejected by an upstream proxy: fetch failed");
    });
    expect(run.exchange).toEqual({ sent: true });
    expect(run.responseLimitRefusal).toBeUndefined();
    expect(run.observed.providerError).toEqual({ class: "network" });
  });

  it(
    "does not report a locally capped response as a provider network failure",
    async () => {
      const repositoryPath = await createRepository();
      const profile = catalogProfile();
      const provider = vi.fn(
        async () =>
          new Response("x".repeat(CATALOG_COMPOSITION_POLICY.maxResponseBytes + 1), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      );
      const harness = new PiHarness({
        skillCrateDirectory,
        executionProfile: profile,
        credential: { family: "nvidia-api-catalog", apiKey: "test-key" },
        providerConnectionFactory: createProviderConnectionFactory({
          routeId: profile.routeId,
          transport: profile.transport,
          fetch: provider,
        }),
      });
      const input = stepInput(repositoryPath);
      const execution = await executeInferenceStep({
        mode: "read-only",
        policy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
        evidenceIdentity: input.evidenceIdentity,
        execute: () => harness.runStep(input),
      });
      const attempt = execution.evidence.attempts.at(-1);

      expect(provider).toHaveBeenCalled();
      expect(attempt?.outcome).not.toBe("succeeded");
      expect(attempt?.modelTelemetry?.providerError).toBeUndefined();
    },
    SLOW,
  );
});

/** A loopback port nothing listens on: bound, then released. */
async function closedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle));
  const { port } = server.address() as { port: number };
  await new Promise<void>((settle) => server.close(() => settle()));
  return port;
}

/** The error Node's own fetch raises for a refused loopback connection. */
async function refusedFetchError(): Promise<unknown> {
  const port = await closedLoopbackPort();
  try {
    await realFetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST" });
  } catch (error) {
    return error;
  }
  throw new Error("Expected the closed loopback port to refuse the connection.");
}

const realFetch = globalThis.fetch;

describe("unreachable model endpoint", () => {
  it("recognizes a refused loopback connection and a failed lookup by errno code", async () => {
    expect(isDefinitiveConnectFailure(await refusedFetchError())).toBe(true);
    const coded = (code: string) =>
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error(`getaddrinfo ${code} model.invalid`), { code }),
      });
    expect(isDefinitiveConnectFailure(coded("ENOTFOUND"))).toBe(true);
    expect(isDefinitiveConnectFailure(coded("EHOSTUNREACH"))).toBe(true);
    // Faults a fresh attempt can clear keep the transport-retry ladder.
    for (const code of ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_SOCKET"]) {
      expect(isDefinitiveConnectFailure(coded(code))).toBe(false);
    }
    // Message text alone never decides.
    expect(isDefinitiveConnectFailure(new Error("connect ECONNREFUSED 127.0.0.1:9"))).toBe(false);
  });

  it("is a terminal verdict, never a transport retry", () => {
    expect(providerErrorDisposition({ class: "unreachable" })).toEqual({
      category: "provider-terminal",
      retryable: false,
    });
  });

  it("observes a refused connection as a sent request that never connected", async () => {
    const error = await refusedFetchError();
    const run = await secondRequest(() => {
      throw error;
    });
    expect(run.exchange).toEqual({ sent: true, connectFailed: true });
    expect(run.observed.providerError).toEqual({ class: "unreachable" });
  });

  it(
    "ends a read-only step after one refused request under the default transport budget",
    async () => {
      const repositoryPath = await createRepository();
      const provider = vi.fn(async () => {
        throw await refusedFetchError();
      });
      vi.stubGlobal("fetch", provider);
      const harness = new PiHarness({
        skillCrateDirectory,
        model: validModelConfig,
        createConnection: (model, options) => createModelConnection(model, options),
      });
      const input = stepInput(repositoryPath);
      const policy = parseRetryPolicy({});
      // The default policy retries transport faults; this one must not use it.
      expect(policy.transport?.maxRetries).toBeGreaterThan(0);
      const sleep = vi.fn(async () => undefined);
      const execution = await executeInferenceStep({
        mode: "read-only",
        policy,
        evidenceIdentity: input.evidenceIdentity,
        execute: () => harness.runStep(input),
        sleep,
      });

      expect(execution.status).toBe("failed");
      expect(provider).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(execution.evidence.attempts).toHaveLength(1);
      const attempt = execution.evidence.attempts[0]!;
      expect(attempt).toMatchObject({
        outcome: "provider-terminal",
        retryable: false,
        retryScheduled: false,
      });
      expect(attempt.modelTelemetry?.providerError).toEqual({ class: "unreachable" });
      expect(isInferenceAttemptModelTelemetry(attempt.modelTelemetry, attempt.outcome)).toBe(true);
      const message = execution.status === "failed" ? execution.error.message : "";
      expect(message).not.toContain("rate limit");
      expect(message).not.toContain("retry-max-transport-retries-bound");

      const record = failedRecord(attempt);
      const next = buildRunHumanNextCommand({
        record,
        recordPath: `/state/${record.id}.json`,
        repositoryPath: "/private/checkout",
        exitCode: 1,
      });
      expect(next?.command).toContain("docsfab doctor");
      expect(next?.command).toContain("--live");
      expect(next?.reason).toContain("endpoint URL");
      expect(next?.reason).not.toMatch(/rate limit|capability or policy wall/u);
    },
    SLOW,
  );

  it("tells the operator to check the endpoint and run doctor --live", () => {
    const reason = providerFailureReason({ class: "unreachable" }, 1);
    expect(reason).toContain("docsfab doctor --live");
    expect(reason).toContain("endpoint URL");
    expect(reason).not.toContain("rate");
  });
});

async function runOneAttempt(
  input: HarnessStepInput,
  configureSession?: PiHarnessOptions["configureSession"],
  connection: {
    maxPhysicalRequestsPerStep?: number;
    maxProviderTurns?: number;
  } = {},
): Promise<InferenceAttemptEvidence> {
  const harness = new PiHarness({
    skillCrateDirectory,
    model: validModelConfig,
    ...(configureSession ? { configureSession } : {}),
    // Instant in-turn replay, so a retryable provider error spends no wall time.
    createConnection: (model, options) =>
      createModelConnection(
        model,
        options
          ? {
              ...options,
              ...(connection.maxPhysicalRequestsPerStep === undefined
                ? {}
                : { maxPhysicalRequestsPerStep: connection.maxPhysicalRequestsPerStep }),
              ...(connection.maxProviderTurns === undefined
                ? {}
                : {
                    limits: { ...options.limits, maxProviderTurns: connection.maxProviderTurns },
                  }),
              providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 },
            }
          : options,
      ),
  });
  const execution = await executeInferenceStep({
    mode: "read-only",
    policy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
    evidenceIdentity: input.evidenceIdentity,
    execute: () => harness.runStep(input),
  });
  const attempt = execution.evidence.attempts.at(-1);
  if (!attempt) throw new Error("Expected one recorded attempt.");
  return attempt;
}

function failedRecord(attempt: InferenceAttemptEvidence): RunRecord {
  return {
    schemaVersion: 2,
    id: "telemetry-run",
    workflow: "review-documentation",
    repository: { sourcePath: "/fixture", requestedRevision: "HEAD", revision: "a".repeat(40) },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "failed",
    createdAt: "2026-09-23T12:00:00.000Z",
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
          configuredMaxRetries: 0,
          effectiveMaxRetries: 0,
          baseDelayMs: 0,
          maxDelayMs: 0,
          retryableCategories: [],
          replay: "read-only",
          attempts: [attempt],
        },
      },
    ],
  } as unknown as RunRecord;
}

async function createRepository(): Promise<string> {
  const repositoryPath = await mkdtemp(resolve(tmpdir(), "docsfab-attempt-telemetry-"));
  temporaryDirectories.push(repositoryPath);
  await writeFile(resolve(repositoryPath, "README.md"), "# Fixture\n");
  return repositoryPath;
}

function stepInput(repositoryPath: string): HarnessStepInput {
  const workflow = getWorkflow("review-documentation");
  return {
    runId: "attempt-telemetry-run",
    repositoryPath,
    workflow,
    step: workflow.steps[0]!,
    evidenceIdentity: { repositoryRevision: "a".repeat(40) },
  };
}

function reviewStepInput(repositoryPath: string): HarnessStepInput {
  const workflow = getWorkflow("review-documentation");
  return {
    runId: "attempt-telemetry-review-run",
    repositoryPath,
    workflow,
    step: workflow.steps.find((step) => step.id === "provisional-technical-verification")!,
    evidenceIdentity: { repositoryRevision: "a".repeat(40) },
    reviewScope: {
      scope: "focused-set",
      reason: "operator-named",
      targetPaths: ["README.md"],
      deferredPaths: [],
      scopeSha256: "b".repeat(64),
      corpusFileCount: 1,
    },
  };
}

function textTurn(
  value: string,
  finishReason: string,
  usage: Record<string, number> = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
): Response {
  const chunk = (delta: object, finish: string | null, extra: object = {}) => ({
    id: "completion-telemetry-turn",
    object: "chat.completion.chunk",
    created: 1,
    model: validModelConfig.modelId,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  });
  const body = [
    chunk({ role: "assistant", ...(value ? { content: value } : {}) }, null),
    chunk({}, finishReason, { usage }),
  ]
    .map((item) => `data: ${JSON.stringify(item)}\n\n`)
    .concat("data: [DONE]\n\n")
    .join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function errorResponse(status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: { message: "provider body text" } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function toolTurn(calls: readonly { id: string; name: string; arguments: object }[]): Response {
  const chunk = (delta: object, finish: string | null, extra: object = {}) => ({
    id: "completion-telemetry-tool-turn",
    object: "chat.completion.chunk",
    created: 1,
    model: validModelConfig.modelId,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  });
  const toolCalls = calls.map((call, index) => ({
    index,
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  }));
  const body = [
    chunk({ role: "assistant", tool_calls: toolCalls }, null),
    chunk({}, "tool_calls", {
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  ]
    .map((item) => `data: ${JSON.stringify(item)}\n\n`)
    .concat("data: [DONE]\n\n")
    .join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A 200 stream that sends one partial chunk and then breaks mid-flight. */
function brokenStream(): Response {
  const encoder = new TextEncoder();
  const first = {
    id: "completion-telemetry-broken",
    object: "chat.completion.chunk",
    created: 1,
    model: validModelConfig.modelId,
    choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }],
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(first)}\n\n`));
      setTimeout(() => controller.error(new TypeError("terminated")), 5);
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const CATALOG_COMPOSITION_POLICY = {
  maxProviderTurns: 4,
  timeoutMs: 300_000,
  maxResponseBytes: 65_536,
};

/** An installed NVIDIA API Catalog profile: the composition boundary checks identity and size. */
function catalogProfile(): BoundModelExecutionProfile {
  const body = {
    schemaVersion: 1 as const,
    modelId: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
    routeId: "nvidia-api-catalog" as const,
    deploymentIdentitySha256: "a".repeat(64),
    transport: "openai-chat-completions" as const,
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
    transport: "openai-chat-completions",
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
    compositionPolicy: CATALOG_COMPOSITION_POLICY,
  };
}

function catalogSse(model: string): Response {
  const chunk = (delta: object, finish: string | null, extra: object = {}) => ({
    id: "catalog-turn",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  });
  const body = [
    chunk({ role: "assistant", content: "OK" }, null),
    chunk({}, "stop", { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
  ]
    .map((item) => `data: ${JSON.stringify(item)}\n\n`)
    .concat("data: [DONE]\n\n")
    .join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * Send one request that the provider answers normally, then a second whose
 * transport answer is `second`, and read what the connection observed of it.
 */
async function secondRequest(
  second: () => Response | Promise<Response>,
  options: { onPayloadThrows?: boolean; maxProviderTurns?: number } = {},
) {
  const profile = catalogProfile();
  let calls = 0;
  const factory = createProviderConnectionFactory({
    routeId: profile.routeId,
    transport: profile.transport,
    fetch: async () => {
      calls += 1;
      return calls === 1 ? catalogSse(profile.modelId) : second();
    },
  });
  const connection = await factory.create(
    { profile, credential: { family: "nvidia-api-catalog", apiKey: "test-key" } },
    {
      evidenceIdentity: { repositoryRevision: "a".repeat(40) },
      providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0, maxRetries: 0 } as never,
      ...(options.maxProviderTurns
        ? { limits: { maxProviderTurns: options.maxProviderTurns } }
        : {}),
    },
  );
  const context = {
    systemPrompt: DOCSFAB_SYSTEM_PROMPT,
    messages: [{ role: "user" as const, content: "Reply OK.", timestamp: 1 }],
    tools: [],
  };
  const first = await connection.runtime
    .streamSimple(connection.model, context, { maxTokens: 64 })
    .result();
  expect(first.stopReason).toBe("stop");
  expect(connection.providerTransport?.lastExchange()).toEqual({
    sent: true,
    bodyReceived: true,
  });
  let result: object;
  try {
    result = await connection.runtime
      .streamSimple(
        connection.model,
        {
          ...context,
          messages: [
            ...context.messages,
            first as never,
            { role: "user" as const, content: "Again.", timestamp: 2 },
          ],
        },
        {
          maxTokens: 64,
          ...(options.onPayloadThrows
            ? {
                onPayload: () => {
                  throw new Error("The test payload hook refused this request.");
                },
              }
            : {}),
        },
      )
      .result();
  } catch (error) {
    result = { stopReason: "error", errorMessage: String((error as Error).message) };
  }
  const exchange = connection.providerTransport!.lastExchange();
  const responseLimitRefusal = connection.providerTransport?.lastResponseLimitRefusal?.();
  return {
    calls,
    exchange,
    responseLimitRefusal,
    observed: observeLandedProviderTurn(result, exchange),
  };
}
