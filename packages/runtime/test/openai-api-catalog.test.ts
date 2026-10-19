// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelEndpointConfig } from "../src/model/configuration.js";
import {
  OPENAI_API_CATALOG_SOURCE_PATH_PREFIX,
  OpenaiApiCatalogDiscoveryError,
  discoverOpenaiApiModelCatalog,
  type OpenaiApiCatalogDiscoveryInput,
} from "../src/model/openai-api-catalog.js";
import { OPENAI_API_ORIGIN } from "../src/model/catalog-serving-route.js";
import { validModelConfig } from "./helpers.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";

const HUB_BASE_URL = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];

const NOW = new Date("2026-08-04T12:34:56.789Z");
const MODEL_ID = "gpt-5.6-sol";
const OPENAI_KEY = `sk-${"A".repeat(24)}`;
const ANTHROPIC_KEY = `sk-ant-${"B".repeat(24)}`;
const NVIDIA_KEY = `nvapi-${"C".repeat(24)}`;
const HUB_KEY = `ihub_api_${"D".repeat(24)}`;
const CATALOG_URL = `${OPENAI_API_ORIGIN}${OPENAI_API_CATALOG_SOURCE_PATH_PREFIX}${MODEL_ID}`;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpenAI API model-catalog discovery", () => {
  it("normalizes the exact model retrieve into catalog evidence without Hub Metadata", async () => {
    const delegate = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      catalogResponse({
        id: MODEL_ID,
        object: "model",
        created: 1_704_067_200,
        owned_by: "openai-only-field",
        shutdown_date: "2026-10-23",
        description: "provider prose must not persist",
      }),
    );

    const result = await discoverOpenaiApiModelCatalog({
      config: openaiConfig(),
      purpose: "policy",
      fetch: delegate as typeof globalThis.fetch,
      clock: () => NOW,
    });

    expect(delegate).toHaveBeenCalledTimes(1);
    const [url, init] = delegate.mock.calls[0]!;
    expect(url).toBe(CATALOG_URL);
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${OPENAI_KEY}`);
    expect(new Headers(init?.headers).get("x-api-key")).toBeNull();
    expect(field(result, "activity")).toEqual({
      field: "activity",
      state: "observed",
      value: "active",
    });
    expect(field(result, "apiFormats")).toEqual({
      field: "apiFormats",
      state: "observed",
      value: ["chat_completions"],
    });
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
    expect(field(result, "contextWindow")).toEqual({
      field: "contextWindow",
      state: "unknown",
      reason: "missing",
    });
    expect(field(result, "limitSemantics")).toEqual({
      field: "limitSemantics",
      state: "unknown",
      reason: "not-authoritative",
    });
    expect(field(result, "origin")).toMatchObject({
      state: "observed",
      value: OPENAI_API_ORIGIN,
    });
    expect(result.observation.source).toEqual({
      id: "openai-api-model-catalog",
      adapter: { id: "adapter:openai-api-model-catalog", version: "1.0.0" },
      retrievedAt: NOW.toISOString(),
    });
    const durable = JSON.stringify(result);
    expect(durable).not.toContain("openai-only-field");
    expect(durable).not.toContain("provider prose");
    expect(durable).not.toContain(OPENAI_KEY);
    expect(durable).not.toContain("INFERENCE_HUB");
    expect(result.provenance.source).not.toHaveProperty("path");
  });

  it("does not treat undocumented retrieve limit fields as catalog evidence", async () => {
    const result = await discoverOpenaiApiModelCatalog({
      config: openaiConfig(),
      purpose: "policy",
      fetch: vi.fn(async () =>
        catalogResponse({
          id: MODEL_ID,
          object: "model",
          created: 1_704_067_200,
          owned_by: "openai",
          context_window: 8_192,
          max_input_tokens: 8_192,
          max_output_tokens: 4_096,
        }),
      ) as typeof globalThis.fetch,
      clock: () => NOW,
    });
    expect(field(result, "maxInputTokens")).toEqual({
      field: "maxInputTokens",
      state: "unknown",
      reason: "missing",
    });
    expect(field(result, "contextWindow")).toEqual({
      field: "contextWindow",
      state: "unknown",
      reason: "missing",
    });
  });

  it("keeps missing limits unknown without inventing zero", async () => {
    const result = await discoverOpenaiApiModelCatalog({
      config: openaiConfig(),
      purpose: "policy",
      fetch: vi.fn(async () =>
        catalogResponse({ id: MODEL_ID, object: "model" }),
      ) as unknown as typeof globalThis.fetch,
      clock: () => NOW,
    });
    expect(field(result, "maxInputTokens")).toEqual({
      field: "maxInputTokens",
      state: "unknown",
      reason: "missing",
    });
    expect(field(result, "contextWindow")).toEqual({
      field: "contextWindow",
      state: "unknown",
      reason: "missing",
    });
    expect(field(result, "limitSemantics")).toEqual({
      field: "limitSemantics",
      state: "unknown",
      reason: "not-authoritative",
    });
  });

  it("binds an immutable validated config and purpose across injected network I/O", async () => {
    const config = openaiConfig();
    const request: OpenaiApiCatalogDiscoveryInput = {
      config,
      purpose: "policy",
      clock: () => NOW,
    };
    request.fetch = async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${OPENAI_KEY}`);
      config.baseUrl = HUB_BASE_URL;
      config.providerId = "nvidia";
      config.modelId = "attacker/model";
      config.apiKey = HUB_KEY;
      request.purpose = "judge";
      request.clock = () => new Date("2099-01-01T00:00:00.000Z");
      return catalogResponse({
        id: MODEL_ID,
        object: "model",
        created: 1_704_067_200,
        owned_by: "openai",
      });
    };

    const result = await discoverOpenaiApiModelCatalog(request);

    expect(result.observation.purpose).toBe("policy");
    expect(field(result, "providerId")).toMatchObject({ state: "observed", value: "openai" });
    expect(field(result, "modelId")).toMatchObject({ state: "observed", value: MODEL_ID });
    expect(result.observation.source.retrievedAt).toBe(NOW.toISOString());
    expect(JSON.stringify(result)).not.toContain("attacker/model");
    expect(JSON.stringify(result)).not.toContain(HUB_KEY);
  });

  it("rejects NVIDIA, Hub, and Anthropic credentials before network I/O", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("must not fetch");
    });
    for (const apiKey of [NVIDIA_KEY, HUB_KEY, ANTHROPIC_KEY, "sk-short"]) {
      await expect(
        discoverOpenaiApiModelCatalog({
          config: openaiConfig({ apiKey }),
          purpose: "policy",
          fetch: fetch as typeof globalThis.fetch,
          clock: () => NOW,
        }),
      ).rejects.toMatchObject({
        name: "OpenaiApiCatalogDiscoveryError",
        code: "invalid-configuration",
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a messages transport on the OpenAI catalog adapter", async () => {
    await expect(
      discoverOpenaiApiModelCatalog({
        config: openaiConfig({
          apiFormat: "messages",
          profile: {
            ...openaiConfig().profile,
            compatibility: { ...openaiConfig().profile.compatibility, apiFormats: ["messages"] },
          },
        }),
        purpose: "policy",
        fetch: vi.fn(async () => {
          throw new Error("must not fetch");
        }) as typeof globalThis.fetch,
        clock: () => NOW,
      }),
    ).rejects.toBeInstanceOf(OpenaiApiCatalogDiscoveryError);
  });

  it("maps HTTP 404 to model-absent", async () => {
    await expect(
      discoverOpenaiApiModelCatalog({
        config: openaiConfig(),
        purpose: "policy",
        fetch: vi.fn(async () =>
          catalogResponse({ error: { message: "missing" } }, { status: 404 }),
        ) as unknown as typeof globalThis.fetch,
        clock: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "model-absent" });
  });
});

function openaiConfig(overrides: Partial<ModelEndpointConfig> = {}): ModelEndpointConfig {
  return {
    ...structuredClone(validModelConfig),
    providerId: "openai",
    baseUrl: `${OPENAI_API_ORIGIN}/v1`,
    modelId: MODEL_ID,
    apiKey: OPENAI_KEY,
    apiFormat: "chat_completions",
    profile: {
      ...structuredClone(validModelConfig.profile),
      input: ["text"],
      compatibility: {
        ...validModelConfig.profile.compatibility,
        apiFormats: ["chat_completions"],
      },
    },
    ...overrides,
  };
}

function catalogResponse(body: unknown, options: { status?: number; url?: string } = {}): Response {
  const response = new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: { "content-type": "application/json" },
  });
  Object.defineProperty(response, "url", {
    configurable: true,
    value: options.url ?? CATALOG_URL,
  });
  return response;
}

function field(result: Awaited<ReturnType<typeof discoverOpenaiApiModelCatalog>>, name: string) {
  return result.observation.fields.find((candidate) => candidate.field === name);
}
