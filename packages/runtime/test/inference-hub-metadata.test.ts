// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  InferenceHubMetadataError,
  inspectInferenceHubMetadata,
  type InferenceHubMetadataInspection,
} from "../src/model/inference-hub-metadata.js";

const KEY = `ihub_api_${"A".repeat(24)}`;
const LABEL = "azure/openai/gpt-5.4";
const ORIGIN = "https://metadata.example.test";
const NOW = new Date("2026-08-04T12:00:00.000Z");

function inspection(
  overrides: Partial<InferenceHubMetadataInspection> = {},
): InferenceHubMetadataInspection {
  return {
    requested: true,
    authority: "authenticated",
    purpose: "policy",
    label: LABEL,
    endpoint: {
      origin: ORIGIN,
      path: "/v1/catalog/search",
      mode: "search",
    },
    environment: { INFERENCE_HUB_METADATA_API_KEY: KEY },
    clock: () => NOW,
    ...overrides,
  };
}

function targetRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    label: LABEL,
    provider_id: "azure",
    status: "active",
    capabilities: {
      reasoning: true,
      chat: true,
      tool_use: true,
      input_modalities: ["text"],
      supports_developer_role: true,
      supports_reasoning_effort: true,
      supports_system_role: true,
    },
    limits: {
      context_length: 128_000,
      max_input_tokens: 96_000,
      max_output_tokens: 32_000,
      limit_semantics: "combined-context",
    },
    pricing: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    description: "discard this provider prose",
    snippets: [{ secretShape: "discard this snippet" }],
    image: "https://images.example.test/model.png",
    ...overrides,
  };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(body, { ...init, headers });
}

function field(result: Awaited<ReturnType<typeof inspectInferenceHubMetadata>>, name: string) {
  if (result.status !== "observed") throw new Error("fixture did not observe");
  return result.observation.fields.find((item) => item.field === name);
}

describe("Inference Hub Metadata API discovery", () => {
  it("does not read environment or perform I/O until inspection is requested", async () => {
    let metadataReads = 0;
    const environment = new Proxy({} as NodeJS.ProcessEnv, {
      get: (_target, property) => {
        if (property === "INFERENCE_HUB_METADATA_API_KEY") metadataReads += 1;
        return undefined;
      },
    });
    const delegate = vi.fn();

    await expect(
      inspectInferenceHubMetadata(
        inspection({
          requested: false,
          environment,
          fetch: delegate,
          // These are intentionally invalid: no configuration should be touched.
          label: "",
          endpoint: { origin: "http://invalid", path: "//foreign/path", mode: "search" },
        }),
      ),
    ).resolves.toEqual({ status: "not-requested" });
    expect(metadataReads).toBe(0);
    expect(delegate).not.toHaveBeenCalled();
  });

  it("returns an actionable optional-capability diagnostic without inference-key fallback", async () => {
    const delegate = vi.fn();
    const result = await inspectInferenceHubMetadata(
      inspection({
        environment: { NVIDIA_API_KEY: `nvapi-${"B".repeat(24)}` },
        fetch: delegate,
      }),
    );

    expect(result).toEqual({
      status: "optional-capability-unavailable",
      diagnostic: {
        code: "metadata-api-key-missing",
        message: expect.stringContaining("INFERENCE_HUB_METADATA_API_KEY"),
      },
    });
    expect(
      result.status === "optional-capability-unavailable" && result.diagnostic.message,
    ).toContain("Inference-provider credentials are not substitutes");
    expect(delegate).not.toHaveBeenCalled();
  });

  it("rejects an inference credential assigned to the metadata variable content-free", async () => {
    const inferenceKey = `nvapi-${"C".repeat(24)}`;
    let failure: unknown;
    try {
      await inspectInferenceHubMetadata(
        inspection({
          environment: { INFERENCE_HUB_METADATA_API_KEY: inferenceKey },
        }),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(InferenceHubMetadataError);
    expect((failure as InferenceHubMetadataError).code).toBe("invalid-metadata-credential");
    expect(String(failure)).not.toContain(inferenceKey);
  });

  it("suppresses an injected environment accessor failure before network I/O", async () => {
    const canary = "private environment accessor detail";
    const delegate = vi.fn();
    const environment = new Proxy({} as NodeJS.ProcessEnv, {
      get: () => {
        throw new Error(canary);
      },
    });
    let message = "";
    try {
      await inspectInferenceHubMetadata(inspection({ environment, fetch: delegate }));
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("distinct ihub_api_ credential");
    expect(message).not.toContain(canary);
    expect(delegate).not.toHaveBeenCalled();
  });

  it("rejects non-string metadata values without touching attacker-controlled length", async () => {
    let lengthReads = 0;
    const hostileValue = new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === "length") lengthReads += 1;
          throw new Error("hostile metadata value detail");
        },
      },
    );
    for (const value of [null, {}, hostileValue]) {
      const delegate = vi.fn();
      let message = "";
      try {
        await inspectInferenceHubMetadata(
          inspection({
            environment: {
              INFERENCE_HUB_METADATA_API_KEY: value,
            } as unknown as NodeJS.ProcessEnv,
            fetch: delegate,
          }),
        );
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("distinct ihub_api_ credential");
      expect(message).not.toContain("hostile metadata value detail");
      expect(delegate).not.toHaveBeenCalled();
    }
    expect(lengthReads).toBe(0);
  });

  it("selects the exact slash-bearing label across bounded pages and returns only normalized evidence", async () => {
    const rawCanary = "RAW_RESPONSE_CANARY_NOT_DURABLE";
    const delegate = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = new URL(request instanceof Request ? request.url : String(request));
      expect(url.origin).toBe(ORIGIN);
      expect(url.searchParams.get("search")).toBe(LABEL);
      expect(init).toMatchObject({ method: "GET", redirect: "manual" });
      expect(new Headers(init?.headers).get("x-api-key")).toBe(KEY);
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return url.searchParams.get("cursor") === null
        ? jsonResponse({
            models: [{ label: "azure/openai/gpt-5.4-mini", provider_id: "azure" }],
            next_cursor: "opaque-page-2",
            prose: rawCanary,
          })
        : jsonResponse({ models: [targetRecord({ description: rawCanary })], next_cursor: null });
    });

    const result = await inspectInferenceHubMetadata(inspection({ fetch: delegate }));

    expect(delegate).toHaveBeenCalledTimes(2);
    const secondUrl = new URL(String(delegate.mock.calls[1]?.[0]));
    expect(String(delegate.mock.calls[0]?.[0])).toContain("azure%2Fopenai%2Fgpt-5.4");
    expect(secondUrl.searchParams.get("cursor")).toBe("opaque-page-2");
    expect(result.status).toBe("observed");
    expect(field(result, "modelId")).toMatchObject({ state: "observed", value: LABEL });
    expect(field(result, "providerId")).toMatchObject({ state: "observed", value: "azure" });
    expect(field(result, "origin")).toMatchObject({ state: "observed", value: ORIGIN });
    expect(field(result, "activity")).toMatchObject({ state: "observed", value: "active" });
    expect(field(result, "reasoning")).toMatchObject({ state: "observed", value: true });
    expect(field(result, "toolUse")).toMatchObject({ state: "observed", value: true });
    expect(field(result, "apiFormats")).toMatchObject({
      state: "observed",
      value: ["chat_completions"],
    });
    expect(field(result, "contextWindow")).toMatchObject({ state: "observed", value: 128_000 });
    expect(field(result, "providerUpdatedAt")).toMatchObject({
      state: "observed",
      value: "2026-08-01T00:00:00.000Z",
    });
    for (const price of ["inputPrice", "outputPrice", "cacheReadPrice", "cacheWritePrice"]) {
      expect(field(result, price)).toEqual({ field: price, state: "unknown", reason: "missing" });
    }
    expect(field(result, "billingInterpretation")).toEqual({
      field: "billingInterpretation",
      state: "unknown",
      reason: "missing",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain(rawCanary);
    expect(serialized).not.toContain("description");
    expect(serialized).not.toContain("snippets");
    expect(serialized).not.toContain("image");
    expect(serialized).not.toContain("opaque-page-2");
  });

  it("samples the host retrieval clock only after the bounded response arrives", async () => {
    let responseArrived = false;
    const result = await inspectInferenceHubMetadata(
      inspection({
        fetch: async () => {
          responseArrived = true;
          return jsonResponse({ data: [targetRecord()] });
        },
        clock: () => {
          expect(responseArrived).toBe(true);
          return NOW;
        },
      }),
    );

    expect(result.status).toBe("observed");
    if (result.status !== "observed") throw new Error("expected observation");
    expect(result.observation.source.retrievedAt).toBe(NOW.toISOString());
  });

  it("normalizes present pricing without converting null economics to zero", async () => {
    const result = await inspectInferenceHubMetadata(
      inspection({
        fetch: async () =>
          jsonResponse({
            data: [
              targetRecord({
                pricing: {
                  billing_interpretation: "internal-chargeback",
                  input: {
                    amount_microunits: 1_250_000,
                    currency: "USD",
                    unit: "per-million-tokens",
                  },
                  output: null,
                },
              }),
            ],
          }),
      }),
    );

    expect(field(result, "billingInterpretation")).toMatchObject({
      state: "observed",
      value: "internal-chargeback",
    });
    expect(field(result, "inputPrice")).toMatchObject({
      state: "observed",
      value: { amountMicrounits: 1_250_000, currency: "USD", unit: "per-million-tokens" },
    });
    expect(field(result, "outputPrice")).toMatchObject({ state: "unknown" });
  });

  it("does not infer economic authority or a free rate from pricing object presence", async () => {
    const empty = await inspectInferenceHubMetadata(
      inspection({
        fetch: async () => jsonResponse({ models: [targetRecord({ pricing: {} })] }),
      }),
    );
    expect(field(empty, "billingInterpretation")).toEqual({
      field: "billingInterpretation",
      state: "unknown",
      reason: "missing",
    });

    const zeroWithoutSemantics = await inspectInferenceHubMetadata(
      inspection({
        fetch: async () =>
          jsonResponse({
            models: [
              targetRecord({
                pricing: {
                  input: { amount_microunits: 0, currency: "USD", unit: "per-million-tokens" },
                },
              }),
            ],
          }),
      }),
    );
    expect(field(zeroWithoutSemantics, "billingInterpretation")).toMatchObject({
      state: "unknown",
    });
    expect(field(zeroWithoutSemantics, "inputPrice")).toEqual({
      field: "inputPrice",
      state: "unknown",
      reason: "not-authoritative",
    });

    await expect(
      inspectInferenceHubMetadata(
        inspection({
          fetch: async () =>
            jsonResponse({
              models: [
                targetRecord({
                  pricing: {
                    billing_interpretation: "explicitly-free",
                    input: { amount_microunits: 1, currency: "USD", unit: "per-million-tokens" },
                  },
                }),
              ],
            }),
        }),
      ),
    ).rejects.toMatchObject({ code: "response-rejected" });
  });

  it("rejects duplicate exact labels even when their records are identical", async () => {
    const record = targetRecord();
    await expect(
      inspectInferenceHubMetadata(
        inspection({
          fetch: async () => jsonResponse({ items: [record, structuredClone(record)] }),
        }),
      ),
    ).rejects.toMatchObject({ code: "duplicate-model-label" });
  });

  it("rejects redirects before reading bodies and always requests manual handling", async () => {
    const cancel = vi.fn(async () => undefined);
    const delegate = vi.fn(
      async (_request: string | URL | Request, init?: RequestInit) =>
        ({
          status: 302,
          redirected: false,
          url: "",
          headers: new Headers({ location: "https://foreign.example.test/steal" }),
          body: { cancel },
        }) as unknown as Response,
    );

    await expect(
      inspectInferenceHubMetadata(inspection({ fetch: delegate })),
    ).rejects.toMatchObject({ code: "response-rejected" });
    expect(delegate.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not let a redirect body's hanging cleanup defeat the deadline", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const operation = inspectInferenceHubMetadata(
      inspection({
        fetch: async () =>
          ({
            status: 302,
            redirected: false,
            url: "",
            headers: new Headers({ location: "https://foreign.example.test/steal" }),
            body: { cancel },
          }) as unknown as Response,
        limits: { timeoutMs: 20 },
      }),
    ).then(
      () => "resolved",
      (error: unknown) => error,
    );
    const result = await Promise.race([
      operation,
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100)),
    ]);
    expect(result).not.toBe("hung");
    expect(result).toMatchObject({ code: "response-rejected" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    { origin: "http://metadata.example.test", path: "/v1/catalog", mode: "search" as const },
    {
      origin: "https://user:pass@metadata.example.test",
      path: "/v1/catalog",
      mode: "search" as const,
    },
    { origin: `${ORIGIN}/v1`, path: "/catalog", mode: "search" as const },
    { origin: ORIGIN, path: "//foreign.example.test/catalog", mode: "search" as const },
    { origin: ORIGIN, path: "/v1//catalog", mode: "search" as const },
    { origin: ORIGIN, path: "/v1/%2e%2e/catalog", mode: "search" as const },
    { origin: ORIGIN, path: "/catalog?next=https://foreign.example.test", mode: "search" as const },
  ])("rejects an unsafe endpoint configuration before I/O: $origin$path", async (endpoint) => {
    const delegate = vi.fn();
    await expect(
      inspectInferenceHubMetadata(inspection({ endpoint, fetch: delegate })),
    ).rejects.toMatchObject({ code: "invalid-configuration" });
    expect(delegate).not.toHaveBeenCalled();
  });

  it("rejects any supported credential family in a configured label before network I/O", async () => {
    const delegate = vi.fn();
    await expect(
      inspectInferenceHubMetadata(
        inspection({
          label: `azure/${`glpat-${"G".repeat(24)}`}`,
          fetch: delegate,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid-configuration" });
    expect(delegate).not.toHaveBeenCalled();
  });

  it("rejects a credential-shaped provider identity before creating durable evidence", async () => {
    await expect(
      inspectInferenceHubMetadata(
        inspection({
          fetch: async () =>
            jsonResponse({
              models: [
                targetRecord({
                  provider_id: `sk-${"H".repeat(24)}`,
                }),
              ],
            }),
        }),
      ),
    ).rejects.toMatchObject({ code: "response-rejected" });
  });

  it("rejects response-provided next URLs instead of following them", async () => {
    const delegate = vi.fn(async () =>
      jsonResponse({
        models: [],
        next: "https://foreign.example.test/private",
      }),
    );
    await expect(
      inspectInferenceHubMetadata(inspection({ fetch: delegate })),
    ).rejects.toMatchObject({ code: "pagination-rejected" });
    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it("rejects cyclic, malformed, oversized, and overlong pagination content", async () => {
    const cases: Array<{
      fetch: typeof globalThis.fetch;
      code: string;
    }> = [
      {
        fetch: async () => jsonResponse('{"models":[],"models":[]}'),
        code: "response-rejected",
      },
      {
        fetch: async () => jsonResponse({ models: [], next_cursor: "A".repeat(513) }),
        code: "pagination-rejected",
      },
      {
        fetch: async () =>
          jsonResponse(
            { models: [] },
            {
              headers: { "content-length": String(1024 * 1024 + 1) },
            },
          ),
        code: "response-rejected",
      },
    ];
    for (const testCase of cases) {
      await expect(
        inspectInferenceHubMetadata(inspection({ fetch: testCase.fetch })),
      ).rejects.toMatchObject({ code: testCase.code });
    }

    let calls = 0;
    await expect(
      inspectInferenceHubMetadata(
        inspection({
          fetch: async () => {
            calls += 1;
            return jsonResponse({ models: [], next_cursor: "same-cursor" });
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "pagination-rejected" });
    expect(calls).toBe(2);
  });

  it("treats slash/plus cursor text as opaque and only encodes it on the pinned query", async () => {
    const cursor = "opaque+/=cursor/path";
    const delegate = vi.fn(async (request: string | URL | Request) => {
      const url = new URL(request instanceof Request ? request.url : String(request));
      return url.searchParams.has("cursor")
        ? jsonResponse({ models: [targetRecord()] })
        : jsonResponse({ models: [], next_cursor: cursor });
    });
    await expect(
      inspectInferenceHubMetadata(inspection({ fetch: delegate })),
    ).resolves.toMatchObject({ status: "observed" });
    const second = String(delegate.mock.calls[1]?.[0]);
    expect(new URL(second).searchParams.get("cursor")).toBe(cursor);
    expect(second).toContain("cursor=opaque%2B%2F%3Dcursor%2Fpath");
    expect(new URL(second).origin).toBe(ORIGIN);
  });

  it("bounds the whole request including a stalled response stream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"models":['));
      },
    });
    await expect(
      inspectInferenceHubMetadata(
        inspection({
          fetch: async () =>
            new Response(stream, {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          limits: { timeoutMs: 10 },
        }),
      ),
    ).rejects.toMatchObject({ code: "request-timeout" });
  });

  it("does not await hanging body cleanup on timeout or an oversized envelope", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"models":['));
      },
      cancel: () => new Promise<void>(() => undefined),
    });
    const timedOperation = inspectInferenceHubMetadata(
      inspection({
        fetch: async () =>
          new Response(stalled, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        limits: { timeoutMs: 10 },
      }),
    ).then(
      () => "resolved",
      (error: unknown) => error,
    );
    const timedResult = await Promise.race([
      timedOperation,
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100)),
    ]);
    expect(timedResult).not.toBe("hung");
    expect(timedResult).toMatchObject({ code: "request-timeout" });

    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const oversizeOperation = inspectInferenceHubMetadata(
      inspection({
        fetch: async () =>
          ({
            status: 200,
            redirected: false,
            url: "",
            headers: new Headers({
              "content-type": "application/json",
              "content-length": String(1024 * 1024 + 1),
            }),
            body: { cancel },
          }) as unknown as Response,
        limits: { timeoutMs: 20 },
      }),
    ).then(
      () => "resolved",
      (error: unknown) => error,
    );
    const oversizeResult = await Promise.race([
      oversizeOperation,
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100)),
    ]);
    expect(oversizeResult).not.toBe("hung");
    expect(oversizeResult).toMatchObject({ code: "response-rejected" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects zero-byte and excess response chunks under the byte ceiling", async () => {
    const zero = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array());
        controller.close();
      },
    });
    await expect(
      inspectInferenceHubMetadata(
        inspection({
          fetch: async () =>
            new Response(zero, {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        }),
      ),
    ).rejects.toMatchObject({ code: "response-rejected" });

    const many = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([123]));
        controller.enqueue(new Uint8Array([125]));
        controller.enqueue(new Uint8Array([10]));
        controller.close();
      },
    });
    await expect(
      inspectInferenceHubMetadata(
        inspection({
          fetch: async () =>
            new Response(many, {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          limits: { maxResponseChunks: 2 },
        }),
      ),
    ).rejects.toMatchObject({ code: "response-rejected" });
  });

  it("uses one end-to-end deadline across all pages", async () => {
    let calls = 0;
    await expect(
      inspectInferenceHubMetadata(
        inspection({
          fetch: async () => {
            calls += 1;
            await new Promise((resolve) => setTimeout(resolve, 25));
            return jsonResponse({
              models: [],
              next_cursor: `page-${calls}`,
            });
          },
          limits: { timeoutMs: 40 },
        }),
      ),
    ).rejects.toMatchObject({ code: "request-timeout" });
    expect(calls).toBe(2);
  });

  it("cancels a fetch response that resolves after the inspection deadline", async () => {
    const cancel = vi.fn(async () => undefined);
    const lateResponse = {
      status: 200,
      redirected: false,
      url: "",
      headers: new Headers({ "content-type": "application/json" }),
      body: { cancel },
    } as unknown as Response;
    await expect(
      inspectInferenceHubMetadata(
        inspection({
          fetch: async () => {
            await new Promise((resolve) => setTimeout(resolve, 25));
            return lateResponse;
          },
          limits: { timeoutMs: 10 },
        }),
      ),
    ).rejects.toMatchObject({ code: "request-timeout" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("requires an exact requested response URL when the transport reports one", async () => {
    const response = jsonResponse({ models: [targetRecord()] });
    Object.defineProperty(response, "url", {
      configurable: true,
      value: `${ORIGIN}/v1/catalog/other`,
    });
    await expect(
      inspectInferenceHubMetadata(inspection({ fetch: async () => response })),
    ).rejects.toMatchObject({ code: "response-rejected" });
  });

  it("keeps the public label endpoint descriptive-only and never reads or sends a key", async () => {
    let metadataReads = 0;
    const environment = new Proxy({} as NodeJS.ProcessEnv, {
      get: (_target, property) => {
        if (property === "INFERENCE_HUB_METADATA_API_KEY") metadataReads += 1;
        return KEY;
      },
    });
    const delegate = vi.fn(async (_request: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return jsonResponse(
        targetRecord({
          status: "active",
          capabilities: {
            reasoning: true,
            chat: true,
            tool_use: true,
            input_modalities: ["text", "image"],
          },
          limits: { context_length: 999_999, max_output_tokens: 999_999 },
          pricing: {
            input: { amount_microunits: 0, currency: "USD", unit: "per-million-tokens" },
          },
        }),
      );
    });
    const result = await inspectInferenceHubMetadata(
      inspection({
        authority: "public-preview",
        environment,
        fetch: delegate,
        endpoint: { origin: ORIGIN, path: "/v1/labels", mode: "slim" },
      }),
    );

    expect(metadataReads).toBe(0);
    expect(field(result, "modelId")).toMatchObject({ state: "observed", value: LABEL });
    expect(field(result, "providerId")).toMatchObject({ state: "observed", value: "azure" });
    expect(field(result, "origin")).toMatchObject({ state: "observed", value: ORIGIN });
    for (const name of [
      "activity",
      "reasoning",
      "toolUse",
      "apiFormats",
      "inputModalities",
      "contextWindow",
      "maxInputTokens",
      "maxOutputTokens",
      "inputPrice",
      "outputPrice",
      "providerCreatedAt",
      "providerUpdatedAt",
    ]) {
      expect(field(result, name)).toEqual({
        field: name,
        state: "unknown",
        reason: "not-authoritative",
      });
    }
    expect(result.status === "observed" && result.observation.source.id).toContain(
      "public-preview",
    );
    expect(result.status === "observed" && result.provenance.source.origin).toBe(ORIGIN);
  });

  it("binds an immutable authority and clock snapshot across injected network I/O", async () => {
    const later = () => new Date("2030-01-01T00:00:00.000Z");
    let publicInput: InferenceHubMetadataInspection;
    const publicFetch = vi.fn(async (_request: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(new Headers(init?.headers).has("x-api-key")).toBe(false);
      publicInput.authority = "authenticated";
      publicInput.clock = later;
      return jsonResponse(targetRecord());
    });
    publicInput = inspection({
      authority: "public-preview",
      endpoint: { origin: ORIGIN, path: "/v1/labels", mode: "slim" },
      fetch: publicFetch,
    });
    const publicResult = await inspectInferenceHubMetadata(publicInput);
    expect(publicResult).toMatchObject({ status: "observed", authority: "public-preview" });
    expect(field(publicResult, "reasoning")).toEqual({
      field: "reasoning",
      state: "unknown",
      reason: "not-authoritative",
    });
    expect(publicResult.status === "observed" && publicResult.observation.source.retrievedAt).toBe(
      NOW.toISOString(),
    );

    let authenticatedInput: InferenceHubMetadataInspection;
    const authenticatedFetch = vi.fn(
      async (_request: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("x-api-key")).toBe(KEY);
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        authenticatedInput.authority = "public-preview";
        authenticatedInput.clock = later;
        return jsonResponse({ models: [targetRecord()] });
      },
    );
    authenticatedInput = inspection({ fetch: authenticatedFetch });
    const authenticatedResult = await inspectInferenceHubMetadata(authenticatedInput);
    expect(authenticatedResult).toMatchObject({ status: "observed", authority: "authenticated" });
    expect(field(authenticatedResult, "reasoning")).toMatchObject({
      state: "observed",
      value: true,
    });
    expect(
      authenticatedResult.status === "observed" &&
        authenticatedResult.observation.source.retrievedAt,
    ).toBe(NOW.toISOString());
  });

  it("normalizes strict RFC 3339 provider timestamps into the catalog millisecond form", async () => {
    const result = await inspectInferenceHubMetadata(
      inspection({
        fetch: async () =>
          jsonResponse({
            models: [
              targetRecord({
                created_at: "2026-07-01T00:00:00Z",
                updated_at: "2026-08-01T00:00:00.123456Z",
              }),
            ],
          }),
      }),
    );
    expect(field(result, "providerCreatedAt")).toMatchObject({
      state: "observed",
      value: "2026-07-01T00:00:00.000Z",
    });
    expect(field(result, "providerUpdatedAt")).toMatchObject({
      state: "observed",
      value: "2026-08-01T00:00:00.123Z",
    });
  });

  it("does not leak key, URL, status body, or delegate errors through failures", async () => {
    const bodyCanary = "private response body detail";
    const failures: Array<typeof globalThis.fetch> = [
      async () => jsonResponse({ error: bodyCanary }, { status: 401 }),
      async () => {
        throw new Error(`${KEY} ${bodyCanary}`);
      },
    ];
    for (const delegate of failures) {
      let message = "";
      try {
        await inspectInferenceHubMetadata(inspection({ fetch: delegate }));
      } catch (error) {
        message = String(error);
      }
      expect(message).not.toContain(KEY);
      expect(message).not.toContain(bodyCanary);
      expect(message).not.toContain(ORIGIN);
    }
  });
});

// The `inference-backend.nvidia.com/api/v1/models` record shape observed live on
// 2026-09-28 (#1454): top-level `supports_*` flags, a descriptive `capabilities`
// tag list, `is_active`/`is_draft`, offset-less timestamps, and bare
// `price_1m_*` rates. Values are copied from the recorded Metadata record for
// `azure/openai/gpt-6-sol`; no credential or prose is part of the fixture.
const BACKEND_ORIGIN = "https://inference-backend.nvidia.com";
const BACKEND_LABEL = "azure/openai/gpt-6-sol";

function backendRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    label: BACKEND_LABEL,
    name: "GPT-6 Sol",
    category: "llm",
    team: "llmg",
    company: "OpenAI",
    provider: "Azure",
    cost_tier: "premium",
    "short-description": "discard this provider prose",
    description: "discard this provider prose",
    json_code_snippet: "discard this snippet",
    id: "6ab2ea46a9f0f493012a3ca7",
    created_at: "2026-09-22T20:51:18.738000",
    updated_at: "2026-09-22T21:59:22.658000",
    categories: ["chat", "reasoning", "tool-use", "vision"],
    capabilities: ["chat", "reasoning", "tool-use"],
    tags: ["openai"],
    frameworks: [],
    references: [],
    endpoints: [],
    sizes: [],
    popular: true,
    featured: false,
    is_draft: false,
    is_active: true,
    supports_reasoning: true,
    supports_embedding: false,
    supports_chat: true,
    supports_rerank: false,
    supports_vlm: true,
    supports_audio: false,
    supports_video: false,
    supports_tool_use: true,
    context_length_tokens: 1_050_000,
    max_input_tokens: 1_050_000,
    max_output_tokens: 128_000,
    source_id: null,
    "company homogenous": null,
    median_output_tokens_per_second: null,
    pricing: {
      price_1m_input_tokens: 1.4,
      price_1m_output_tokens: 7.0,
      price_1m_cache_read_input_tokens: 0.14,
      price_1m_blended_3_to_1: 2.8,
    },
    ...overrides,
  };
}

function backendInspection(
  overrides: Partial<InferenceHubMetadataInspection> = {},
): InferenceHubMetadataInspection {
  return inspection({
    label: BACKEND_LABEL,
    endpoint: { origin: BACKEND_ORIGIN, path: "/api/v1/models", mode: "search" },
    ...overrides,
  });
}

describe("Inference Hub Metadata inference-backend record shape", () => {
  it("sends the key only as x-api-key and searches with the `search` parameter by default", async () => {
    const delegate = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = new URL(request instanceof Request ? request.url : String(request));
      expect(url.origin).toBe(BACKEND_ORIGIN);
      expect(url.pathname).toBe("/api/v1/models");
      expect(url.searchParams.get("search")).toBe(BACKEND_LABEL);
      expect(url.searchParams.has("query")).toBe(false);
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe(KEY);
      expect(headers.has("authorization")).toBe(false);
      expect(init).toMatchObject({ method: "GET", redirect: "manual" });
      return jsonResponse({ models: [backendRecord()] });
    });

    const result = await inspectInferenceHubMetadata(backendInspection({ fetch: delegate }));

    expect(delegate).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("observed");
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("accepts every closed label parameter and rejects any other before I/O", async () => {
    for (const labelParameter of ["label", "q", "query", "search"] as const) {
      const delegate = vi.fn(async (request: string | URL | Request) => {
        const url = new URL(request instanceof Request ? request.url : String(request));
        expect(url.searchParams.get(labelParameter)).toBe(BACKEND_LABEL);
        return jsonResponse({ models: [backendRecord()] });
      });
      await expect(
        inspectInferenceHubMetadata(
          backendInspection({
            endpoint: {
              origin: BACKEND_ORIGIN,
              path: "/api/v1/models",
              mode: "search",
              labelParameter,
            },
            fetch: delegate,
          }),
        ),
      ).resolves.toMatchObject({ status: "observed" });
    }
    const delegate = vi.fn();
    await expect(
      inspectInferenceHubMetadata(
        backendInspection({
          endpoint: {
            origin: BACKEND_ORIGIN,
            path: "/api/v1/models",
            mode: "search",
            labelParameter: "name" as unknown as "search",
          },
          fetch: delegate,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid-configuration" });
    expect(delegate).not.toHaveBeenCalled();
  });

  it("selects the byte-exact label when search returns sibling routes of the same model", async () => {
    const result = await inspectInferenceHubMetadata(
      backendInspection({
        fetch: async () =>
          jsonResponse({
            models: [
              backendRecord({ label: "openai/openai/gpt-6-sol", provider: "OpenAI" }),
              backendRecord({ label: "azure/openai/gpt-6-sol-mini", max_output_tokens: 1 }),
              backendRecord(),
            ],
          }),
      }),
    );
    expect(field(result, "modelId")).toMatchObject({ state: "observed", value: BACKEND_LABEL });
    expect(field(result, "providerId")).toMatchObject({ state: "observed", value: "Azure" });
    expect(field(result, "maxOutputTokens")).toMatchObject({ state: "observed", value: 128_000 });
  });

  it("normalizes the recorded gpt-6-sol record into catalog evidence", async () => {
    const result = await inspectInferenceHubMetadata(
      backendInspection({
        fetch: async () => jsonResponse({ models: [backendRecord()] }),
      }),
    );

    expect(field(result, "modelId")).toMatchObject({ state: "observed", value: BACKEND_LABEL });
    expect(field(result, "origin")).toMatchObject({ state: "observed", value: BACKEND_ORIGIN });
    expect(field(result, "activity")).toMatchObject({ state: "observed", value: "active" });
    expect(field(result, "contextWindow")).toMatchObject({
      state: "observed",
      value: 1_050_000,
    });
    expect(field(result, "maxInputTokens")).toMatchObject({
      state: "observed",
      value: 1_050_000,
    });
    expect(field(result, "maxOutputTokens")).toMatchObject({ state: "observed", value: 128_000 });
    expect(field(result, "reasoning")).toMatchObject({ state: "observed", value: true });
    expect(field(result, "toolUse")).toMatchObject({ state: "observed", value: true });
    expect(field(result, "apiFormats")).toMatchObject({
      state: "observed",
      value: ["chat_completions"],
    });
    expect(field(result, "inputModalities")).toMatchObject({
      state: "observed",
      value: ["image", "text"],
    });
    // The record states no limit semantics; nothing is inferred from equal
    // context and input limits.
    expect(field(result, "limitSemantics")).toEqual({
      field: "limitSemantics",
      state: "unknown",
      reason: "missing",
    });
    // Offset-less timestamps name no instant.
    for (const name of ["providerCreatedAt", "providerUpdatedAt"]) {
      expect(field(result, name)).toEqual({
        field: name,
        state: "unknown",
        reason: "not-authoritative",
      });
    }
    // Bare `price_1m_*` rates carry no currency, so they are read and
    // validated but never become authoritative prices.
    for (const name of ["inputPrice", "outputPrice", "cacheReadPrice"]) {
      expect(field(result, name)).toEqual({
        field: name,
        state: "unknown",
        reason: "not-authoritative",
      });
    }
    expect(field(result, "cacheWritePrice")).toEqual({
      field: "cacheWritePrice",
      state: "unknown",
      reason: "missing",
    });
    const serialized = JSON.stringify(result);
    for (const discarded of [
      "6ab2ea46a9f0f493012a3ca7",
      "discard this",
      "premium",
      "llmg",
      "1.4",
      "2.8",
    ]) {
      expect(serialized).not.toContain(discarded);
    }
  });

  it.each([
    { name: "draft wins over active", overrides: { is_draft: true }, value: "draft" },
    { name: "inactive", overrides: { is_active: false }, value: "inactive" },
  ])("maps record lifecycle flags: $name", async ({ overrides, value }) => {
    const result = await inspectInferenceHubMetadata(
      backendInspection({
        fetch: async () => jsonResponse({ models: [backendRecord(overrides)] }),
      }),
    );
    expect(field(result, "activity")).toMatchObject({ state: "observed", value });
  });

  it("leaves activity unknown when only is_draft:false is present", async () => {
    const record = backendRecord();
    delete record.is_active;
    const result = await inspectInferenceHubMetadata(
      backendInspection({ fetch: async () => jsonResponse({ models: [record] }) }),
    );
    expect(field(result, "activity")).toEqual({
      field: "activity",
      state: "unknown",
      reason: "missing",
    });
  });

  it("ignores unfamiliar or repeated capability tags instead of rejecting the record", async () => {
    const result = await inspectInferenceHubMetadata(
      backendInspection({
        fetch: async () =>
          jsonResponse({
            models: [
              backendRecord({
                capabilities: ["chat", "chat", "Vision Pro"],
                supports_tool_use: undefined,
              }),
            ],
          }),
      }),
    );
    expect(field(result, "reasoning")).toMatchObject({ state: "observed", value: true });
    // No flag and no `tool-use` tag: absence of a tag is not evidence of false.
    expect(field(result, "toolUse")).toEqual({
      field: "toolUse",
      state: "unknown",
      reason: "missing",
    });
  });

  it("leaves input modalities unknown when an audio or video flag is set", async () => {
    const result = await inspectInferenceHubMetadata(
      backendInspection({
        fetch: async () => jsonResponse({ models: [backendRecord({ supports_audio: true })] }),
      }),
    );
    expect(field(result, "inputModalities")).toEqual({
      field: "inputModalities",
      state: "unknown",
      reason: "missing",
    });
  });

  it.each([
    {
      name: "a capability flag contradicting the record's own tag list",
      overrides: { supports_tool_use: false },
    },
    { name: "a non-string capability tag", overrides: { capabilities: ["chat", 1] } },
    {
      name: "a status that contradicts the lifecycle flags",
      overrides: { status: "deprecated" },
    },
    {
      name: "a negative bare rate",
      overrides: { pricing: { price_1m_input_tokens: -1 } },
    },
    {
      name: "a non-numeric bare rate",
      overrides: { pricing: { price_1m_output_tokens: "7.00" } },
    },
    {
      name: "a bare rate beside a structured price for the same field",
      overrides: {
        pricing: {
          price_1m_input_tokens: 1.4,
          input: { amount_microunits: 1_400_000, currency: "USD", unit: "per-million-tokens" },
        },
      },
    },
    { name: "a malformed timestamp", overrides: { created_at: "2026-09-22 20:51:18" } },
    { name: "a non-integer context length", overrides: { context_length_tokens: 1.5 } },
    {
      name: "a context length beside a second context alias",
      overrides: { context_window: 1_050_000 },
    },
  ])("rejects $name content-free", async ({ overrides }) => {
    let failure: unknown;
    try {
      await inspectInferenceHubMetadata(
        backendInspection({
          fetch: async () => jsonResponse({ models: [backendRecord(overrides)] }),
        }),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(InferenceHubMetadataError);
    expect((failure as InferenceHubMetadataError).code).toBe("response-rejected");
    expect(String(failure)).not.toContain(BACKEND_LABEL);
    expect(String(failure)).not.toContain(KEY);
  });
});
