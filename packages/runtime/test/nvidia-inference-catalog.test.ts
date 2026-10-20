// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config/runtime-loader.js";
import type { ModelEndpointConfig } from "../src/model/configuration.js";
import {
  NVIDIA_INFERENCE_CATALOG_ENDPOINT,
  NVIDIA_INFERENCE_CATALOG_MAX_BYTES,
  NVIDIA_INFERENCE_CATALOG_ORIGIN,
  NVIDIA_INFERENCE_CATALOG_TIMEOUT_MS,
  NvidiaInferenceCatalogDiscoveryError,
  discoverNvidiaInferenceModelCatalog,
  type NvidiaInferenceCatalogDiscoveryInput,
} from "../src/model/nvidia-inference-catalog.js";
import { createModelConnection, hasReportableUsageCost } from "../src/model/provider.js";
import { validModelConfig } from "./helpers.js";
import {
  assertCredentialFree,
  containsExactSecret,
  liveFailure,
  resolveInferenceLiveConfiguration,
} from "./live-catalog-guards.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";

const HUB_BASE_URL = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];

const NOW = new Date("2026-08-04T12:34:56.789Z");
const MODEL_ID = "openai/gpt-5.4";
const INFERENCE_KEY = `nvapi-${"A".repeat(24)}`;
const METADATA_KEY = `ihub_api_${"B".repeat(24)}`;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("NVIDIA Inference API model-catalog discovery", () => {
  it("normalizes the exact GPT-5.4 match into #59 and #63 evidence", async () => {
    const providerPayload = {
      object: "list",
      data: [
        { id: "other/model", max_input_tokens: 8_192 },
        {
          id: MODEL_ID,
          object: "model",
          owned_by: "provider-only-field",
          description: "provider prose must not persist",
          max_input_tokens: 1_050_000,
          max_output_tokens: 128_000,
        },
      ],
    };
    const delegate = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      catalogResponse(providerPayload),
    );

    const result = await discoverNvidiaInferenceModelCatalog({
      config: inferenceConfig(),
      purpose: "policy",
      fetch: delegate as typeof globalThis.fetch,
      clock: () => NOW,
    });

    expect(delegate).toHaveBeenCalledTimes(1);
    const [url, init] = delegate.mock.calls[0]!;
    expect(url).toBe(NVIDIA_INFERENCE_CATALOG_ENDPOINT);
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${INFERENCE_KEY}`);
    expect(field(result, "activity")).toEqual({
      field: "activity",
      state: "observed",
      value: "active",
    });
    expect(field(result, "maxInputTokens")).toEqual({
      field: "maxInputTokens",
      state: "observed",
      value: 1_050_000,
    });
    expect(field(result, "maxOutputTokens")).toEqual({
      field: "maxOutputTokens",
      state: "observed",
      value: 128_000,
    });
    expect(field(result, "contextWindow")).toEqual({
      field: "contextWindow",
      state: "unknown",
      reason: "not-authoritative",
    });
    expect(field(result, "origin")).toMatchObject({
      state: "observed",
      value: NVIDIA_INFERENCE_CATALOG_ORIGIN,
    });
    expect(result.observation.source).toEqual({
      id: "nvidia-inference-api-model-catalog",
      adapter: {
        id: "adapter:nvidia-inference-api-model-catalog",
        version: "1.0.0",
      },
      retrievedAt: NOW.toISOString(),
    });
    expect(result.provenance.source).toMatchObject({
      origin: NVIDIA_INFERENCE_CATALOG_ORIGIN,
      providerId: "nvidia",
      modelId: MODEL_ID,
      retrievedAt: NOW.toISOString(),
      providerUpdatedAt: null,
    });
    const durable = JSON.stringify(result);
    expect(durable).not.toContain("provider-only-field");
    expect(durable).not.toContain("provider prose");
    expect(durable).not.toContain(INFERENCE_KEY);
    expect(result.provenance.source).not.toHaveProperty("path");
  });

  it("binds an immutable validated config and purpose across injected network I/O", async () => {
    const config = inferenceConfig();
    const request: NvidiaInferenceCatalogDiscoveryInput = {
      config,
      purpose: "policy",
      clock: () => NOW,
    };
    request.fetch = async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${INFERENCE_KEY}`);
      config.baseUrl = "https://metadata.example.test/v1";
      config.providerId = "mutated-provider";
      config.modelId = "attacker/model";
      config.apiKey = METADATA_KEY;
      request.purpose = "judge";
      request.clock = () => new Date("2099-01-01T00:00:00.000Z");
      return catalogResponse({
        object: "list",
        data: [
          { id: MODEL_ID, max_input_tokens: 1_050_000, max_output_tokens: 128_000 },
          { id: "attacker/model", max_input_tokens: 1, max_output_tokens: 1 },
        ],
      });
    };

    const result = await discoverNvidiaInferenceModelCatalog(request);

    expect(result.observation.purpose).toBe("policy");
    expect(field(result, "providerId")).toMatchObject({
      state: "observed",
      value: "nvidia",
    });
    expect(field(result, "modelId")).toMatchObject({
      state: "observed",
      value: MODEL_ID,
    });
    expect(field(result, "maxInputTokens")).toMatchObject({ value: 1_050_000 });
    expect(result.observation.source.retrievedAt).toBe(NOW.toISOString());
    expect(JSON.stringify(result)).not.toContain("attacker/model");
    expect(JSON.stringify(result)).not.toContain(METADATA_KEY);
  });

  it("keeps missing or null limits unknown without inventing zero", async () => {
    for (const model of [
      { id: MODEL_ID },
      { id: MODEL_ID, max_input_tokens: null, max_output_tokens: null },
    ]) {
      const result = await discover([model]);
      expect(field(result, "maxInputTokens")).toEqual({
        field: "maxInputTokens",
        state: "unknown",
        reason: "missing",
      });
      expect(field(result, "maxOutputTokens")).toEqual({
        field: "maxOutputTokens",
        state: "unknown",
        reason: "missing",
      });
      expect(JSON.stringify(result)).not.toContain('"value":0');
    }
  });

  it.each([
    ["model-absent", [{ id: "other/model" }]],
    ["model-duplicate", [{ id: MODEL_ID }, { id: MODEL_ID }]],
    ["malformed-response", [{ id: MODEL_ID, max_input_tokens: "1050000" }]],
    ["malformed-response", [{ id: MODEL_ID, max_output_tokens: 0 }]],
    ["malformed-response", [{ id: 42 }]],
  ] as const)("fails closed with %s for ambiguous or malformed selections", async (code, data) => {
    await expect(discover([...data])).rejects.toMatchObject({ code });
  });

  it.each([
    ["malformed-response", '{"object":"list","object":"list","data":[]}'],
    ["malformed-response", '{"object":"list","data":'],
    ["malformed-response", { object: "collection", data: [{ id: MODEL_ID }] }],
    ["malformed-response", { object: "list", data: "not-an-array" }],
  ] as const)("rejects strict JSON/schema failure as %s", async (code, body) => {
    const fetch = vi.fn(async () => catalogResponse(body));
    await expect(
      discoverNvidiaInferenceModelCatalog({
        config: inferenceConfig(),
        purpose: "policy",
        fetch,
        clock: () => NOW,
      }),
    ).rejects.toMatchObject({ code });
  });

  it("rejects redirects, cross-origin responses, HTTP failures, and oversized bodies", async () => {
    await expect(
      discoverWithResponse(
        catalogResponse("", {
          status: 302,
          headers: { location: "https://metadata.example.test/private" },
        }),
      ),
    ).rejects.toMatchObject({ code: "redirected-response" });

    await expect(
      discoverWithResponse(
        catalogResponse(
          { object: "list", data: [{ id: MODEL_ID }] },
          { url: "https://metadata.example.test/v1/models" },
        ),
      ),
    ).rejects.toMatchObject({ code: "cross-origin-response" });

    await expect(
      discoverWithResponse(
        catalogResponse("private status body", {
          status: 503,
        }),
      ),
    ).rejects.toMatchObject({ code: "http-status" });

    await expect(
      discoverWithResponse(
        catalogResponse("", {
          headers: { "content-length": String(NVIDIA_INFERENCE_CATALOG_MAX_BYTES + 1) },
        }),
      ),
    ).rejects.toMatchObject({ code: "oversized-response" });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(NVIDIA_INFERENCE_CATALOG_MAX_BYTES + 1));
        controller.close();
      },
    });
    await expect(discoverWithResponse(catalogResponse(stream))).rejects.toMatchObject({
      code: "oversized-response",
    });

    const forgedFinalUrl = catalogResponse({ object: "list", data: [{ id: MODEL_ID }] });
    Object.defineProperty(forgedFinalUrl, "redirected", {
      configurable: true,
      value: true,
    });
    await expect(discoverWithResponse(forgedFinalUrl)).rejects.toMatchObject({
      code: "redirected-response",
    });
  });

  it("does not await a hanging redirect-body cancellation", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const response = customResponse({
      status: 302,
      body: { cancel },
    });
    let failure: unknown;
    void discoverWithResponse(response).catch((error: unknown) => {
      failure = error;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(failure).toMatchObject({ code: "redirected-response" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("starts content-free body cleanup on every rejected response envelope", async () => {
    const cases: Array<[Response, string]> = [
      [
        catalogResponse("private", { url: "https://metadata.example.test/v1/models" }),
        "cross-origin-response",
      ],
      [catalogResponse("private", { status: 500 }), "http-status"],
      [
        catalogResponse("private", { headers: { "content-type": "text/plain" } }),
        "malformed-response",
      ],
      [catalogResponse("private", { headers: { "content-length": "01" } }), "malformed-response"],
      [
        catalogResponse("private", {
          headers: { "content-length": String(NVIDIA_INFERENCE_CATALOG_MAX_BYTES + 1) },
        }),
        "oversized-response",
      ],
    ];
    for (const [response, code] of cases) {
      const cancel = vi
        .spyOn(response.body!, "cancel")
        .mockRejectedValue(new Error("provider-private cleanup detail"));
      await expect(discoverWithResponse(response)).rejects.toMatchObject({ code });
      expect(cancel).toHaveBeenCalledTimes(1);
    }
  });

  it("enforces a real timeout and cancels a response that arrives late", async () => {
    vi.useFakeTimers();
    const response = catalogResponse({ object: "list", data: [{ id: MODEL_ID }] });
    const cancel = vi.spyOn(response.body!, "cancel");
    const fetch = vi.fn(async () => {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, NVIDIA_INFERENCE_CATALOG_TIMEOUT_MS + 1),
      );
      return response;
    });
    const discovery = discoverNvidiaInferenceModelCatalog({
      config: inferenceConfig(),
      purpose: "policy",
      fetch,
      clock: () => NOW,
    });
    const rejected = expect(discovery).rejects.toMatchObject({ code: "timeout" });

    await vi.advanceTimersByTimeAsync(NVIDIA_INFERENCE_CATALOG_TIMEOUT_MS);
    await rejected;
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
  });

  it("cancels the active reader when a locked stream stalls past the deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const releaseLock = vi.fn();
    const reader = {
      read: vi.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined)),
      cancel,
      releaseLock,
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const bodyCancel = vi.fn(async () => {
      throw new TypeError("stream is locked");
    });
    const response = customResponse({
      body: { getReader: () => reader, cancel: bodyCancel },
    });
    const discovery = discoverWithResponse(response);
    const rejected = expect(discovery).rejects.toMatchObject({ code: "timeout" });

    await vi.advanceTimersByTimeAsync(NVIDIA_INFERENCE_CATALOG_TIMEOUT_MS);
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(bodyCancel).not.toHaveBeenCalled();
  });

  it("rejects zero-length and excessive streamed chunks without timer starvation", async () => {
    let reads = 0;
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const reader = {
      read: vi.fn(async () => {
        reads += 1;
        return { done: false, value: new Uint8Array(0) } as ReadableStreamReadResult<Uint8Array>;
      }),
      cancel,
      releaseLock,
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const response = customResponse({ body: { getReader: () => reader } });

    await expect(discoverWithResponse(response)).rejects.toMatchObject({
      code: "malformed-response",
    });
    expect(reads).toBe(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("fails streamed oversize promptly even when reader cancellation never settles", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const releaseLock = vi.fn();
    const reader = {
      read: vi.fn(
        async () =>
          ({
            done: false,
            value: new Uint8Array(NVIDIA_INFERENCE_CATALOG_MAX_BYTES + 1),
          }) as ReadableStreamReadResult<Uint8Array>,
      ),
      cancel,
      releaseLock,
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const response = customResponse({ body: { getReader: () => reader } });

    await expect(discoverWithResponse(response)).rejects.toMatchObject({
      code: "oversized-response",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("never sends an inference key to a metadata or caller-selected origin", async () => {
    const metadataDelegate = vi.fn(async () => catalogResponse({ object: "list", data: [] }));
    await expect(
      discoverNvidiaInferenceModelCatalog({
        config: inferenceConfig({ baseUrl: "https://metadata.example.test/v1" }),
        purpose: "policy",
        fetch: metadataDelegate as typeof globalThis.fetch,
        clock: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "invalid-configuration" });
    expect(metadataDelegate).not.toHaveBeenCalled();

    const wrongCredentialDelegate = vi.fn(async () =>
      catalogResponse({ object: "list", data: [] }),
    );
    await expect(
      discoverNvidiaInferenceModelCatalog({
        config: inferenceConfig({ apiKey: METADATA_KEY }),
        purpose: "policy",
        fetch: wrongCredentialDelegate as typeof globalThis.fetch,
        clock: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "invalid-configuration" });
    expect(wrongCredentialDelegate).not.toHaveBeenCalled();

    const requestOrigins: string[] = [];
    const delegate = vi.fn(async (input: string | URL | Request) => {
      requestOrigins.push(
        new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
          .origin,
      );
      return catalogResponse(
        { object: "list", data: [{ id: MODEL_ID }] },
        { url: "https://metadata.example.test/v1/models" },
      );
    });
    await expect(
      discoverNvidiaInferenceModelCatalog({
        config: inferenceConfig(),
        purpose: "policy",
        fetch: delegate as typeof globalThis.fetch,
        clock: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "cross-origin-response" });
    expect(requestOrigins).toEqual([NVIDIA_INFERENCE_CATALOG_ORIGIN]);
  });

  it.each([
    `(${INFERENCE_KEY})`,
    `!${INFERENCE_KEY}`,
    `${INFERENCE_KEY}.suffix`,
    `prefix-${INFERENCE_KEY}`,
  ])("rejects a wrapped inference token before network I/O: %s", async (apiKey) => {
    const delegate = vi.fn(async () => catalogResponse({ object: "list", data: [] }));
    await expect(
      discoverNvidiaInferenceModelCatalog({
        config: inferenceConfig({ apiKey }),
        purpose: "policy",
        fetch: delegate as typeof globalThis.fetch,
        clock: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "invalid-configuration" });
    expect(delegate).not.toHaveBeenCalled();
  });

  it("uses bounded credential-free diagnostics for provider-controlled failures", async () => {
    const canary = `nvapi-${"Z".repeat(24)}`;
    const fetch = vi.fn(async () => catalogResponse(`{"private":"${canary}"`));
    let failure: unknown;
    try {
      await discoverNvidiaInferenceModelCatalog({
        config: inferenceConfig(),
        purpose: "policy",
        fetch,
        clock: () => NOW,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(NvidiaInferenceCatalogDiscoveryError);
    expect(String(failure)).toBe(
      "NvidiaInferenceCatalogDiscoveryError: " +
        "NVIDIA Inference model catalog discovery failed: malformed-response.",
    );
    expect(String(failure)).not.toContain(canary);
    expect(String(failure).length).toBeLessThan(160);
  });

  it("does not mutate or invalidate a current approved profile when discovery fails", async () => {
    const config = inferenceConfig();
    const before = structuredClone(config.profile);
    const reportUsageCostBefore = hasReportableUsageCost(config);
    await expect(
      discoverNvidiaInferenceModelCatalog({
        config,
        purpose: "policy",
        fetch: vi.fn(async () =>
          catalogResponse({ object: "list", data: [] }),
        ) as unknown as typeof globalThis.fetch,
        clock: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "model-absent" });
    expect(config.profile).toEqual(before);
    expect(config.profile.metadata.status).toBe("current");
    expect(config.profile.contextWindow).toBe(128_000);
    expect(config.profile.maxOutputTokens).toBe(16_384);
    expect(hasReportableUsageCost(config)).toBe(reportUsageCostBefore);
  });

  it("does not run discovery during ordinary model registration", async () => {
    let fetchCalls = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCalls += 1;
      throw new Error("ordinary registration must not perform HTTP");
    });
    await expect(createModelConnection(inferenceConfig())).resolves.toMatchObject({
      reportUsageCost: false,
    });
    // Keep a raw request out of Vitest's failure rendering. A spy assertion can
    // print credential-bearing request arguments when this boundary regresses.
    expect(fetchCalls).toBe(0);
  });
});

const inferenceLiveConfiguration = resolveInferenceLiveConfiguration(process.env, loadConfig);

describe("live NVIDIA Inference catalog guard", () => {
  it("cleanly declines an opted-in but incomplete or invalid full profile", () => {
    let loads = 0;
    const invalid = resolveInferenceLiveConfiguration(
      {
        DOCSFAB_LIVE_NVIDIA_INFERENCE_CATALOG_SMOKE: "authorized",
        MODEL_API_KEY: INFERENCE_KEY,
        MODEL_BASE_URL: HUB_BASE_URL,
        MODEL_ID,
      },
      () => {
        loads += 1;
        throw new Error("full policy or judge profile validation failed");
      },
    );
    expect(invalid).toBeNull();
    expect(loads).toBe(1);
    expect(
      resolveInferenceLiveConfiguration({}, () => {
        throw new Error("loader must remain unreachable without opt-in");
      }),
    ).toBeNull();
  });

  it("detects nested secret-bearing failures without exposing inspected values", () => {
    const structuredFailure = { cause: new Error(`provider retained ${INFERENCE_KEY}`) };
    expect(containsExactSecret(structuredFailure, INFERENCE_KEY)).toBe(true);
    expect(containsExactSecret(new Error("content-free provider failure"), INFERENCE_KEY)).toBe(
      false,
    );
    expect(() =>
      assertCredentialFree(structuredFailure, INFERENCE_KEY, "NVIDIA Inference catalog"),
    ).toThrowError(
      "NVIDIA Inference catalog live smoke rejected secret-bearing diagnostic material.",
    );
  });
});

describe("live NVIDIA Inference catalog smoke", () => {
  it.skipIf(!inferenceLiveConfiguration)(
    "runs only with explicit authorization and the configured runtime inference key",
    async () => {
      const config = inferenceLiveConfiguration!;
      try {
        const result = await discoverNvidiaInferenceModelCatalog({
          config,
          purpose: "policy",
        });
        expect(field(result, "modelId")).toMatchObject({
          state: "observed",
          value: config.modelId,
        });
        expect(field(result, "activity")).toMatchObject({
          state: "observed",
          value: "active",
        });
        assertCredentialFree(result, config.apiKey, "NVIDIA Inference catalog");
      } catch (error) {
        assertCredentialFree(error, config.apiKey, "NVIDIA Inference catalog");
        throw liveFailure("NVIDIA Inference catalog");
      }
    },
    15_000,
  );
});

function inferenceConfig(overrides: Partial<ModelEndpointConfig> = {}): ModelEndpointConfig {
  return {
    ...structuredClone(validModelConfig),
    providerId: "nvidia",
    baseUrl: `${NVIDIA_INFERENCE_CATALOG_ORIGIN}/v1`,
    modelId: MODEL_ID,
    apiKey: INFERENCE_KEY,
    ...overrides,
  };
}

async function discover(data: unknown[]) {
  return discoverNvidiaInferenceModelCatalog({
    config: inferenceConfig(),
    purpose: "policy",
    fetch: vi.fn(async () =>
      catalogResponse({ object: "list", data }),
    ) as unknown as typeof globalThis.fetch,
    clock: () => NOW,
  });
}

async function discoverWithResponse(response: Response) {
  return discoverNvidiaInferenceModelCatalog({
    config: inferenceConfig(),
    purpose: "policy",
    fetch: vi.fn(async () => response) as unknown as typeof globalThis.fetch,
    clock: () => NOW,
  });
}

function catalogResponse(
  body: unknown,
  options: {
    status?: number;
    headers?: HeadersInit;
    url?: string;
  } = {},
): Response {
  const headers = new Headers(options.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  const response = new Response(
    body instanceof ReadableStream ? body : typeof body === "string" ? body : JSON.stringify(body),
    { status: options.status ?? 200, headers },
  );
  Object.defineProperty(response, "url", {
    configurable: true,
    value: options.url ?? NVIDIA_INFERENCE_CATALOG_ENDPOINT,
  });
  return response;
}

function customResponse(options: {
  status?: number;
  redirected?: boolean;
  url?: string;
  headers?: HeadersInit;
  body: unknown;
}): Response {
  return {
    status: options.status ?? 200,
    redirected: options.redirected ?? false,
    url: options.url ?? NVIDIA_INFERENCE_CATALOG_ENDPOINT,
    headers: new Headers({ "content-type": "application/json", ...options.headers }),
    body: options.body,
  } as unknown as Response;
}

function field(
  result: Awaited<ReturnType<typeof discoverNvidiaInferenceModelCatalog>>,
  name: string,
) {
  return result.observation.fields.find((candidate) => candidate.field === name);
}
