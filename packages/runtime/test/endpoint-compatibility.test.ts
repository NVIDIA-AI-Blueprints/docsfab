// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";
import { limit } from "../src/config/limits.js";
import {
  OUTBOUND_PROXY_DENIED_CODE,
  OUTBOUND_PROXY_UNREACHABLE_CODE,
  OutboundProxyRefusal,
  type OutboundProxyRefusalKind,
} from "../src/model/outbound-http-policy.js";
import {
  COMPATIBILITY_CAUSE_OWNERS,
  EndpointCompatibilityError,
  captureProxyRefusal,
  chatCompletionsProbeShape,
  classifyProviderRefusal,
  formatEndpointCompatibility,
  probeEndpointCompatibility,
  sanitizeProviderMessage,
  type EndpointCompatibilityCheck,
  type EndpointCompatibilityReport,
} from "../src/profile/endpoint-compatibility.js";
import {
  COMPATIBILITY_TOOL_NAME,
  boundedErrorBody,
  postChatCompletion,
  redactProviderText,
  type probeCompatibility,
} from "../src/profile/probe-core.js";
import {
  fixtureFetch,
  loadEndpointFixture,
  type EndpointFixtureName,
} from "./helpers/endpoint-compatibility-fixtures.js";

const API_KEY = `nvapi-${"T".repeat(40)}`;
const BASE_URL = "https://integrate.api.nvidia.com/v1";
const PROBE_LIMIT = 4096;
const CATALOG_SHAPE = chatCompletionsProbeShape({
  providerId: "nvidia-api-catalog",
  baseUrl: BASE_URL,
  requestPolicy: false,
  reasoning: false,
  supportsDeveloperRole: false,
});

/** The six diagnosis owner classes (Epic #1687); the probe may not add a seventh. */
const OWNER_CLASSES = [
  "provider-capacity",
  "output-limit",
  "contract-shape",
  "model-content",
  "operator-configuration",
  "docsfab-defect",
];

async function probeFixture(name: EndpointFixtureName) {
  const fixture = loadEndpointFixture(name);
  const replay = fixtureFetch(fixture);
  vi.stubGlobal("fetch", replay.fetch);
  const report = await probeEndpointCompatibility({
    modelId: fixture.model,
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    maxOutputTokens: fixture.maxOutputTokens ?? PROBE_LIMIT,
    outputLimitSource: "probe-default",
    shape: CATALOG_SHAPE,
  });
  return { report, requests: replay.requests };
}

function checkOf(report: EndpointCompatibilityReport, id: EndpointCompatibilityCheck["id"]) {
  const found = report.checks.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing check ${id}`);
  return found;
}

function summary(report: EndpointCompatibilityReport): Record<string, string> {
  return Object.fromEntries(
    report.checks.map((entry) => [entry.id, `${entry.status}:${entry.finding}`]),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("endpoint compatibility from recorded exchanges", () => {
  it("passes every check for a native tool call and one JSON document", async () => {
    const { report, requests } = await probeFixture("ultra-tool-call-ok");
    expect(report.verdict).toBe("compatible");
    expect(summary(report)).toEqual({
      availability: "pass:served",
      streaming: "pass:event-stream",
      "tool-calls": "pass:native-tool-call",
      "structured-output": "pass:json-document",
      "output-limit": "pass:within-limit",
    });
    expect(
      report.checks.every(
        (entry) => entry.owner === null && entry.cause === null && entry.nextAction === null,
      ),
    ).toBe(true);
    // DocsFab's harness shape: streamed, usage-bearing, tools offered on the first turn.
    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toBe(`${BASE_URL}/chat/completions`);
    expect(requests[0]!.authorization).toBe(`Bearer ${API_KEY}`);
    for (const request of requests) {
      expect(request.body).toMatchObject({
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: PROBE_LIMIT,
      });
    }
    expect(requests[0]!.body.tool_choice).toBe("auto");
    expect(JSON.stringify(requests[0]!.body.tools)).toContain(COMPATIBILITY_TOOL_NAME);
    expect(requests[1]!.body).not.toHaveProperty("tools");
  });

  it("fails tool calls when the model answers a tool-bearing turn in text", async () => {
    const { report } = await probeFixture("tool-call-missing");
    expect(report.verdict).toBe("incompatible");
    const toolCalls = checkOf(report, "tool-calls");
    expect(toolCalls).toMatchObject({
      status: "fail",
      finding: "no-tool-call",
      cause: "reply-content-rejected",
      owner: "model-content",
    });
    expect(toolCalls.nextAction).toContain("native OpenAI `tool_calls`");
    expect(checkOf(report, "structured-output").status).toBe("pass");
    // The reply text stays in memory.
    expect(JSON.stringify(report)).not.toContain("The probe result is ok.");
  });

  it("fails the structured-output contract when the JSON request is answered in prose", async () => {
    const { report } = await probeFixture("json-contract-fail");
    expect(report.verdict).toBe("incompatible");
    expect(checkOf(report, "tool-calls").status).toBe("pass");
    const contract = checkOf(report, "structured-output");
    expect(contract).toMatchObject({
      status: "fail",
      finding: "malformed-json",
      cause: "reply-not-json",
      owner: "contract-shape",
    });
    expect(contract.detail).toContain("invalid-json");
    expect(JSON.stringify(report)).not.toContain("Sure. The result is ok");
  });

  it("quotes the provider's end-of-life notice and names the reselect command", async () => {
    const { report, requests } = await probeFixture("nano-end-of-life-410");
    expect(report.verdict).toBe("incompatible");
    const availability = checkOf(report, "availability");
    expect(availability).toMatchObject({
      status: "fail",
      finding: "end-of-life",
      cause: "provider-model-retired",
      owner: "operator-configuration",
      httpStatus: 410,
      providerMessage:
        "The model 'nvidia/nemotron-3-nano-30b-a3b' has reached its end of life on 2026-09-01T09:00:00Z and is no longer available.",
    });
    expect(availability.nextAction).toContain("docsfab setup --profile <composition-id>");
    expect(availability.nextAction).toContain("docsfab composition list");
    expect(report.checks.slice(1).every((entry) => entry.status === "not-checked")).toBe(true);
    // A refused first request ends the probe without spending on the second.
    expect(requests).toHaveLength(1);
    const lines = formatEndpointCompatibility(report).join("\n");
    expect(lines).toContain('Provider said: "The model');
    expect(lines).toContain("Owner: operator-configuration (cause provider-model-retired)");
    expect(lines).not.toContain("no body");
  });

  it("reports a 404 for a listed id as a model the credential cannot invoke", async () => {
    const { report } = await probeFixture("nano-not-found-404");
    expect(checkOf(report, "availability")).toMatchObject({
      status: "fail",
      finding: "model-not-found",
      cause: "provider-request-refused",
      owner: "operator-configuration",
      providerMessage:
        "Function '[redacted-function-id]': Not found for account '[redacted-account-id]'",
    });
  });

  it("reports a length cut as an output-limit failure, not a missing capability", async () => {
    const { report } = await probeFixture("lightning-length-cut");
    expect(report.verdict).toBe("incompatible");
    expect(report.maxOutputTokens).toBe(1024);
    expect(summary(report)).toEqual({
      availability: "pass:served",
      streaming: "pass:event-stream",
      "tool-calls": "inconclusive:cut-by-output-limit",
      "structured-output": "inconclusive:cut-by-output-limit",
      "output-limit": "fail:length-cut",
    });
    const outputLimit = checkOf(report, "output-limit");
    expect(outputLimit).toMatchObject({ owner: "output-limit", cause: "output-allowance-reached" });
    expect(outputLimit.detail).toContain("finish_reason=length at an output limit of 1024 tokens");
    expect(outputLimit.detail).toContain("most completion tokens 1024");
    expect(outputLimit.nextAction).toContain("1024 output tokens");
    expect(checkOf(report, "tool-calls").owner).toBe("output-limit");
  });

  it("bounds a long in-stream error message and marks it truncated", async () => {
    const maxChars = limit("endpointProbe.providerMessageMaxChars").value;
    const event = {
      error: { message: "overloaded ".repeat(maxChars), type: "service_unavailable", code: 503 },
    };
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const report = await probeEndpointCompatibility({
      modelId: "example/model",
      baseUrl: "https://inference.example.test/v1",
      apiKey: API_KEY,
      maxOutputTokens: PROBE_LIMIT,
      outputLimitSource: "configured",
      shape: CATALOG_SHAPE,
    });
    const streaming = checkOf(report, "streaming");
    expect(streaming.providerMessage!.length).toBeLessThanOrEqual(maxChars);
    expect(streaming.providerMessageTruncated).toBe(true);
  });

  it("attributes an in-stream 503 to provider capacity", async () => {
    const { report } = await probeFixture("super-stream-error-503");
    const streaming = checkOf(report, "streaming");
    expect(streaming).toMatchObject({
      status: "fail",
      finding: "stream-error-event",
      cause: "provider-stream-error",
      owner: "provider-capacity",
      httpStatus: 503,
      providerMessage: "Service temporarily overloaded",
    });
    expect(checkOf(report, "tool-calls").status).toBe("not-checked");
  });

  it("never carries the credential in a report", async () => {
    for (const name of ["ultra-tool-call-ok", "nano-end-of-life-410"] as const) {
      const { report } = await probeFixture(name);
      expect(JSON.stringify(report)).not.toContain(API_KEY);
    }
  });

  it("uses only the six diagnosis owner classes", () => {
    expect([...new Set(Object.values(COMPATIBILITY_CAUSE_OWNERS))].sort()).toEqual(
      [...OWNER_CLASSES].sort(),
    );
  });
});

describe("provider message sanitization", () => {
  it("redacts account and function identifiers from a raw provider body", () => {
    const check = classifyProviderRefusal(
      {
        status: 404,
        body: JSON.stringify({
          detail:
            "Function 'd7618e99-db93-4465-af4d-330213a7f51f': Not found for account 'aBcD3fGh1JkLmN0pQ'",
        }),
        bodyTruncated: false,
      },
      { maxOutputTokens: PROBE_LIMIT },
    );
    expect(check.providerMessage).toBe(
      "Function '[redacted-id]': Not found for account '[redacted-id]'",
    );
  });

  it.each([
    ["account_id: acct_9f8e7d6c", "account_id: [redacted-id]"],
    ["request-id=req_0a1b2c3d4e", "request-id=[redacted-id]"],
    ["denied for org org-7Hq2kLm9", "denied for org [redacted-id]"],
    ["invocation 3f9a2b7c1d0e", "invocation [redacted-id]"],
    ["NCA ID nca-abc123XYZ was denied", "NCA ID [redacted-id] was denied"],
    ["contact ops.lead+docs@example.com", "contact [redacted-email]"],
  ])("redacts %s", (raw, expected) => {
    expect(sanitizeProviderMessage(raw)).toBe(expected);
  });

  it("keeps prose that follows an identifier label", () => {
    expect(sanitizeProviderMessage("The account cannot invoke this function right now.")).toBe(
      "The account cannot invoke this function right now.",
    );
  });

  it("strips bidi, zero-width, and line-separator characters", () => {
    expect(sanitizeProviderMessage("safe\u202Egnp.exe\u200B text\u2028more\u2029end")).toBe(
      "safe gnp.exe text more end",
    );
  });

  it("strips control characters, including terminal escapes", () => {
    expect(sanitizeProviderMessage("gone\u001b[31m now\u0007\r\nretired")).toBe(
      "gone [31m now retired",
    );
  });

  it("removes the exact credential and marks a truncated body", () => {
    const check = classifyProviderRefusal(
      { status: 401, body: `invalid key ${API_KEY}`, bodyTruncated: true },
      { maxOutputTokens: PROBE_LIMIT, credential: API_KEY },
    );
    expect(check.finding).toBe("credential-rejected");
    expect(check.providerMessage).not.toContain(API_KEY);
    expect(check.providerMessageTruncated).toBe(true);
  });

  it("reads an OpenAI-shaped error body", () => {
    const check = classifyProviderRefusal(
      {
        status: 400,
        body: JSON.stringify({
          error: { message: "max_tokens must be at most 32768", type: "invalid_request_error" },
        }),
        bodyTruncated: false,
      },
      { maxOutputTokens: 65536 },
    );
    expect(check).toMatchObject({
      finding: "output-limit-rejected",
      cause: "provider-request-refused",
      owner: "operator-configuration",
      providerMessage: "max_tokens must be at most 32768",
    });
  });

  it("names the timeout limit and its value", () => {
    const check = classifyProviderRefusal(
      { status: 0, body: "AbortError: This operation was aborted", bodyTruncated: false },
      { maxOutputTokens: PROBE_LIMIT },
    );
    expect(check).toMatchObject({ finding: "timeout", owner: "provider-capacity" });
    expect(check.detail).toContain(
      `endpointProbe.requestTimeoutMs (${limit("endpointProbe.requestTimeoutMs").value} ms)`,
    );
  });
});

describe("credential redaction at the body bound", () => {
  // Arbitrary shape: no credential pattern recognizes it, so only exact redaction can.
  const KEY = "Zq9xTr4LmPw2Vb7NcK3sHd8YfJ6gUa1E";

  it("redacts before truncating, so a key crossing the bound never shows a prefix", async () => {
    const maxChars = limit("endpointProbe.providerMessageMaxChars").value;
    const body = `${"x".repeat(maxChars - 20)} rejected Bearer ${KEY} for this route`;
    vi.stubGlobal(
      "fetch",
      async () => new Response(body, { status: 401, headers: { "content-type": "text/plain" } }),
    );
    const report = await probeEndpointCompatibility({
      modelId: "example/model",
      baseUrl: "https://inference.example.test/v1",
      apiKey: KEY,
      maxOutputTokens: PROBE_LIMIT,
      outputLimitSource: "configured",
      shape: CATALOG_SHAPE,
    });
    const availability = checkOf(report, "availability");
    expect(availability.finding).toBe("credential-rejected");
    expect(availability.providerMessageTruncated).toBe(true);
    expect(JSON.stringify(report)).not.toContain(KEY.slice(0, 6));
  });

  // A key with `/` and `+`, which JSON encoders can escape as `\/`.
  const SLASHED_KEY = "Ab3/xY9+Qr7/Lm2Kp8Zt4Wv6Bn1Cd5Ef0Gh12";
  const ESCAPED_KEY = SLASHED_KEY.replaceAll("/", "\\/");

  async function refusedWith(body: string, contentType: string) {
    vi.stubGlobal(
      "fetch",
      async () => new Response(body, { status: 401, headers: { "content-type": contentType } }),
    );
    const report = await probeEndpointCompatibility({
      modelId: "example/model",
      baseUrl: "https://inference.example.test/v1",
      apiKey: SLASHED_KEY,
      maxOutputTokens: PROBE_LIMIT,
      outputLimitSource: "configured",
      shape: CATALOG_SHAPE,
    });
    return checkOf(report, "availability").providerMessage ?? "";
  }

  it.each([300, 360, 380, 390, 395, 399, 400, 420, 600])(
    "never prints a JSON-escaped key at offset %i of a long OpenAI-style body",
    async (offset) => {
      const message = `${"x".repeat(offset)} invalid key ${SLASHED_KEY} for this route ${"y".repeat(200)}`;
      const escapedJson = JSON.stringify({
        error: { message, type: "invalid_request_error" },
      }).replaceAll("/", "\\/");
      expect(escapedJson).toContain(ESCAPED_KEY);
      expect(escapedJson.length).toBeGreaterThan(
        limit("endpointProbe.providerMessageMaxChars").value,
      );
      for (const [body, type] of [
        [escapedJson, "application/json"],
        // Unparseable: the escaped form must still be redacted as written.
        [`${escapedJson.slice(0, -1)}`, "application/json"],
        [`gateway said: ${escapedJson}`, "text/plain"],
      ] as const) {
        const quoted = await refusedWith(body, type);
        expect(quoted).not.toContain(SLASHED_KEY.slice(0, 6));
        expect(quoted).not.toContain(ESCAPED_KEY.slice(0, 6));
        expect(quoted).not.toContain("Lm2Kp8");
      }
    },
  );

  const NVAPI_KEY = `nvapi-Ab3dE${"k".repeat(56)}`;

  it.each([
    ["an arbitrary key", KEY],
    ["an nvapi-shaped key", NVAPI_KEY],
  ])("reports a 2xx reply that is not JSON without quoting it, for %s", async (_label, key) => {
    const body = `${key} echoed back by a misconfigured gateway`;
    const result = await postChatCompletion({
      baseUrl: "https://inference.example.test/v1",
      credential: await releasedProbeCredential(key),
      body: { model: "example/model" },
      timeoutMs: limit("endpointProbe.requestTimeoutMs").value,
      errorBodyMaxChars: limit("endpointProbe.providerMessageMaxChars").value,
      credentialEchoMinChars: limit("endpointProbe.credentialEchoMinChars").value,
      fetch: async () =>
        new Response(body, { status: 200, headers: { "content-type": "text/plain" } }),
    });
    expect(result).toEqual({
      ok: false,
      status: 200,
      responseBytes: new TextEncoder().encode(body).byteLength,
      requestIdentifier: { present: false, source: null, sha256: null },
      body: `The reply was not valid JSON (${new TextEncoder().encode(body).byteLength} bytes).`,
    });
    expect(JSON.stringify(result)).not.toContain(key.slice(0, 6));
  });

  it("names an unrecognized finish reason without quoting the provider's text", async () => {
    const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(`${chunk({ content: "ok" }, null)}${chunk({}, KEY)}data: [DONE]\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const report = await probeEndpointCompatibility({
      modelId: "example/model",
      baseUrl: "https://inference.example.test/v1",
      apiKey: `other-${KEY}`,
      maxOutputTokens: PROBE_LIMIT,
      outputLimitSource: "configured",
      shape: CATALOG_SHAPE,
    });
    expect(checkOf(report, "output-limit").detail).toContain(
      "(finish reasons: unrecognized, unrecognized)",
    );
    expect(checkOf(report, "tool-calls").detail).toContain("(finish_reason=unrecognized)");
    expect(JSON.stringify(report)).not.toContain(KEY.slice(0, 6));
  });

  it("keeps the finish reasons DocsFab reads", async () => {
    const { report } = await probeFixture("ultra-tool-call-ok");
    expect(checkOf(report, "output-limit").detail).toContain("(finish reasons: tool_calls, stop");
  });

  it("removes a trailing partial echo without clipping the wording before it", () => {
    const echoMin = limit("endpointProbe.credentialEchoMinChars").value;
    const maxChars = limit("endpointProbe.providerMessageMaxChars").value;
    expect(boundedErrorBody(`denied ${KEY.slice(0, 12)}`, KEY, maxChars, echoMin).body).toBe(
      "denied [REDACTED]",
    );
    // A key that starts with the last letter of the wording keeps that letter.
    expect(boundedErrorBody("Forbidden", `n${KEY}`, maxChars, echoMin).body).toBe("Forbidden");
  });
});

describe("credential echo redaction", () => {
  const KEY = "Zq9xTr4LmPw2Vb7NcK3sHd8YfJ6gUa1E";
  const NVAPI_KEY = ["nvapi", "Ab3dEk7QxkP2mW9sLt4Rv8Ny1Hc6Zj0Fg5Du3Ke7Ba2Xo9Qi4Ml8S"].join("-");
  const echoMin = () => limit("endpointProbe.credentialEchoMinChars").value;

  it("removes a run of exactly the minimum and keeps one character shorter", () => {
    const n = echoMin();
    expect(redactProviderText(`key ${KEY.slice(7, 7 + n)} denied`, KEY, n)).toBe(
      "key [REDACTED] denied",
    );
    expect(redactProviderText(`key ${KEY.slice(7, 7 + n - 1)} denied`, KEY, n)).toBe(
      `key ${KEY.slice(7, 7 + n - 1)} denied`,
    );
  });

  it.each([
    ["an arbitrary key", KEY],
    ["an nvapi-shaped key", NVAPI_KEY],
  ])("keeps ordinary provider wording for %s", (_label, key) => {
    for (const wording of [
      "The model is not available for this account; retry later.",
      "Send the key in the x-api-key header or as a Bearer token.",
      "max_tokens must be at most 32768",
    ]) {
      expect(redactProviderText(wording, key, echoMin())).toBe(wording);
    }
  });

  it("would remove route wording at a 4-character minimum, which is why it is larger", () => {
    expect(redactProviderText("Send the x-api-key header.", NVAPI_KEY, 4)).toContain("[REDACTED]");
  });

  it.each([
    ["percent-encoded", (key: string) => encodeURIComponent(key)],
    [
      "lowercase percent-encoded",
      (key: string) =>
        encodeURIComponent(key).replace(/%[0-9A-F]{2}/gu, (hex) => hex.toLowerCase()),
    ],
    ["JSON-escaped", (key: string) => JSON.stringify(key).slice(1, -1).replaceAll("/", "\\/")],
    [
      "\\u-escaped",
      (key: string) =>
        [...key].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
    ],
    [
      "as HTML character references for reserved characters",
      (key: string) =>
        key.replace(/[/+=]/gu, (char, offset: number) =>
          offset % 2 === 0 ? `&#x${char.charCodeAt(0).toString(16)};` : `&#${char.charCodeAt(0)};`,
        ),
    ],
    ["split by a zero-width space", (key: string) => `${key.slice(0, 9)}\u200B${key.slice(9)}`],
    ["split by a line break", (key: string) => `${key.slice(0, 9)}\r\n${key.slice(9)}`],
    ["split by a space", (key: string) => `${key.slice(0, 9)} ${key.slice(9)}`],
    ["split by a no-break space", (key: string) => `${key.slice(0, 9)}\u00A0${key.slice(9)}`],
  ])("removes a key written %s", (_label, encode) => {
    const key = "Zq9x/Tr4L+mPw2Vb7NcK3s/Hd8YfJ6gUa1E==";
    expect(redactProviderText(`denied ${encode(key)} here`, key, echoMin())).toBe(
      "denied [REDACTED] here",
    );
  });

  it("removes a key shorter than the minimum only when it appears whole", () => {
    const short = "Ab3d";
    expect(redactProviderText("key Ab3d and Ab3 seen", short, echoMin())).toBe(
      "key [REDACTED] and Ab3 seen",
    );
  });

  it("refuses a missing minimum instead of quoting unredacted text", () => {
    expect(() => redactProviderText("text", KEY, undefined as unknown as number)).toThrow(
      "redactProviderText needs a positive credential echo minimum.",
    );
  });
});

describe("request shape per route kind", () => {
  it.each([
    [
      "an installed request policy",
      { providerId: "nvidia-api-catalog", baseUrl: BASE_URL, requestPolicy: true },
      { tokenField: "max_tokens", systemRole: "system", store: false },
    ],
    [
      "NVIDIA API Catalog without a policy",
      { providerId: "nvidia-api-catalog", baseUrl: BASE_URL, requestPolicy: false },
      { tokenField: "max_tokens", systemRole: "developer", store: false },
    ],
    [
      "NVIDIA Inference API without a policy (GPT-6 Sol)",
      {
        providerId: "nvidia-inference-api",
        baseUrl: EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"],
        requestPolicy: false,
      },
      { tokenField: "max_completion_tokens", systemRole: "developer", store: true },
    ],
    [
      "a bring-your-own OpenAI-compatible endpoint",
      { providerId: "test-provider", baseUrl: "http://127.0.0.1:8000/v1", requestPolicy: false },
      { tokenField: "max_completion_tokens", systemRole: "developer", store: true },
    ],
  ])("matches the provider for %s", (_label, route, expected) => {
    expect(
      chatCompletionsProbeShape({ ...route, reasoning: true, supportsDeveloperRole: true }),
    ).toEqual(expected);
  });

  it("sends the route's token field and instruction role", async () => {
    const replay = fixtureFetch(loadEndpointFixture("ultra-tool-call-ok"));
    vi.stubGlobal("fetch", replay.fetch);
    await probeEndpointCompatibility({
      modelId: "azure/openai/gpt-6-sol",
      baseUrl: EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"],
      apiKey: API_KEY,
      maxOutputTokens: PROBE_LIMIT,
      outputLimitSource: "configured",
      shape: { tokenField: "max_completion_tokens", systemRole: "developer", store: true },
    });
    for (const request of replay.requests) {
      expect(request.body).toMatchObject({ max_completion_tokens: PROBE_LIMIT, store: false });
      expect(request.body).not.toHaveProperty("max_tokens");
      expect((request.body.messages as { role: string }[])[0]!.role).toBe("developer");
    }
  });
});

describe("probe transport", () => {
  it("reports a redirect as reaching the endpoint, and does not follow it", async () => {
    const targets: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      targets.push(`${String(input)} ${String(init?.redirect)}`);
      return new Response(null, {
        status: 307,
        headers: { location: "https://elsewhere.example.test/v1/chat/completions" },
      });
    });
    const report = await probeEndpointCompatibility({
      modelId: "example/model",
      baseUrl: "https://inference.example.test/v1",
      apiKey: API_KEY,
      maxOutputTokens: PROBE_LIMIT,
      outputLimitSource: "configured",
      shape: CATALOG_SHAPE,
    });
    expect(targets).toEqual(["https://inference.example.test/v1/chat/completions manual"]);
    const availability = checkOf(report, "availability");
    expect(availability).toMatchObject({
      status: "fail",
      finding: "redirected",
      cause: "provider-request-refused",
      owner: "operator-configuration",
    });
    expect(availability.detail).toContain("with its credential, reached the configured endpoint");
  });
});

describe("endpoint compatibility error", () => {
  it("carries the first failed check's next action", async () => {
    const { report } = await probeFixture("nano-end-of-life-410");
    const error = new EndpointCompatibilityError(report);
    expect(error.code).toBe("endpoint-incompatible");
    expect(error.message).toBe(
      "Endpoint compatibility: availability failed (end-of-life). HTTP 410: the provider no longer serves this model.",
    );
    expect(error.nextAction).toContain("docsfab setup --profile <composition-id>");
  });
});

describe("doctor's live probe keeps a proxy refusal it captured", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const PASSING = {
    ok: true,
    status: 200,
    eventStream: true,
    events: 3,
    done: true,
    malformedEvents: 0,
    errorEvent: undefined,
    reasoningPresent: false,
    completionTokens: 20,
  } as const;

  function refusalOf(kind: OutboundProxyRefusalKind): OutboundProxyRefusal {
    return new OutboundProxyRefusal(kind, `Scripted proxy refusal (outbound-proxy-${kind}).`);
  }

  /**
   * Global fetch answers the probe's requests in order. The probe sends both
   * requests through the shipped probe fetch and, like the real probe, keeps
   * a thrown request error as an observation instead of rethrowing it.
   */
  function scripted(replies: ReadonlyArray<() => Response>, after?: () => never) {
    const send = vi.fn(async () => {
      const reply = replies[send.mock.calls.length - 1];
      if (!reply) throw new Error("the probe sent more requests than the case scripted");
      return reply();
    });
    vi.stubGlobal("fetch", send);
    const probe: typeof probeCompatibility = async (_model, provider, options) => {
      for (let index = 0; index < replies.length; index += 1) {
        await options.fetch!(`${provider.baseUrl}/chat/completions`, { method: "POST" }).catch(
          () => undefined,
        );
      }
      after?.();
      return {
        toolCall: {
          ...PASSING,
          content: "",
          toolCalls: [{ name: COMPATIBILITY_TOOL_NAME, arguments: '{"result":"ok"}' }],
          finishReason: "tool_calls",
        },
        structuredOutput: {
          ...PASSING,
          content: '{"result":"ok","checks":["tool-calls","structured-output"]}',
          toolCalls: [],
          finishReason: "stop",
        },
      };
    };
    const run = () =>
      probeEndpointCompatibility(
        {
          modelId: "example/model",
          baseUrl: BASE_URL,
          apiKey: API_KEY,
          maxOutputTokens: PROBE_LIMIT,
          outputLimitSource: "configured",
          shape: CATALOG_SHAPE,
        },
        probe,
      );
    return { send, run };
  }

  const ok = () => new Response("{}", { status: 200 });
  const refused = (kind: OutboundProxyRefusalKind) => () => {
    throw refusalOf(kind);
  };

  it("a refusal followed by a successful request still throws the refusal", async () => {
    const { send, run } = scripted([refused("unreachable"), ok]);
    const error = await run().catch((caught: unknown) => caught);
    expect(send).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(OutboundProxyRefusal);
    expect((error as OutboundProxyRefusal).code).toBe(OUTBOUND_PROXY_UNREACHABLE_CODE);
  });

  it("the first of two refusals wins", async () => {
    const { run } = scripted([refused("denied"), refused("unreachable")]);
    const error = await run().catch((caught: unknown) => caught);
    expect((error as OutboundProxyRefusal).code).toBe(OUTBOUND_PROXY_DENIED_CODE);
  });

  it("a refusal before a probe defect names the refusal, not the defect", async () => {
    const { run } = scripted([refused("denied")], () => {
      throw new Error("probe defect after the refusal");
    });
    const error = await run().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OutboundProxyRefusal);
    expect((error as OutboundProxyRefusal).code).toBe(OUTBOUND_PROXY_DENIED_CODE);
  });

  it("adjacent: a probe defect with no refusal stays the defect report", async () => {
    const { run } = scripted([ok], () => {
      throw new Error("probe defect");
    });
    const report = await run();
    expect(checkOf(report, "availability").finding).toBe("probe-defect");
  });

  it("adjacent: a non-proxy request error followed by success is not thrown", async () => {
    const { run } = scripted([
      () => {
        throw new TypeError("fetch failed");
      },
      ok,
    ]);
    const report = await run();
    expect(report.verdict).toBe("compatible");
  });

  it("positive control: a clean probe classifies the endpoint", async () => {
    const { run } = scripted([ok, ok]);
    const report = await run();
    expect(report.verdict).toBe("compatible");
  });

  it("the capture passes a refusal through to its caller and keeps it", async () => {
    const thrown = refusalOf("auth-required");
    const capture = captureProxyRefusal(async () => {
      throw thrown;
    });
    capture.throwIfRefused();
    await expect(capture.fetch("https://models.example.test/v1/chat/completions")).rejects.toBe(
      thrown,
    );
    expect(() => capture.throwIfRefused()).toThrow(thrown);
  });
});

/** The key released for the probed endpoint, as every shipped caller releases it. */
async function releasedProbeCredential(apiKey: string) {
  // Imported here, not at the top, so the registered fixture lines above keep their numbers.
  const { releaseModelCredential } = await import("../src/security/model-credential-release.js");
  return releaseModelCredential(
    { endpoint: "https://inference.example.test/v1", apiKey },
    "endpoint-probe",
  );
}
