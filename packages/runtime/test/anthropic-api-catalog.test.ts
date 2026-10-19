// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelEndpointConfig } from "../src/model/configuration.js";
import {
  ANTHROPIC_API_CATALOG_SOURCE_PATH_PREFIX,
  ANTHROPIC_API_VERSION,
  AnthropicApiCatalogDiscoveryError,
  discoverAnthropicApiModelCatalog,
  type AnthropicApiCatalogDiscoveryInput,
} from "../src/model/anthropic-api-catalog.js";
import { ANTHROPIC_API_ORIGIN } from "../src/model/catalog-serving-route.js";
import { validModelConfig } from "./helpers.js";

const NOW = new Date("2026-08-04T12:34:56.789Z");
const MODEL_ID = "claude-opus-4-7";
const ANTHROPIC_KEY = `sk-ant-${"A".repeat(24)}`;
const OPENAI_KEY = `sk-${"B".repeat(24)}`;
const NVIDIA_KEY = `nvapi-${"C".repeat(24)}`;
const HUB_KEY = `ihub_api_${"D".repeat(24)}`;
const CATALOG_URL = `${ANTHROPIC_API_ORIGIN}${ANTHROPIC_API_CATALOG_SOURCE_PATH_PREFIX}${MODEL_ID}`;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Anthropic API model-catalog discovery", () => {
  it("normalizes the exact model retrieve into catalog evidence without Hub Metadata", async () => {
    const delegate = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      catalogResponse({
        id: MODEL_ID,
        type: "model",
        created_at: "2026-01-15T00:00:00.000Z",
        max_input_tokens: 200_000,
        max_tokens: 8_192,
        display_name: "provider prose must not persist",
      }),
    );

    const result = await discoverAnthropicApiModelCatalog({
      config: anthropicConfig(),
      purpose: "policy",
      fetch: delegate as typeof globalThis.fetch,
      clock: () => NOW,
    });

    expect(delegate).toHaveBeenCalledTimes(1);
    const [url, init] = delegate.mock.calls[0]!;
    expect(url).toBe(CATALOG_URL);
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    const headers = new Headers(init?.headers);
    expect(headers.get("x-api-key")).toBe(ANTHROPIC_KEY);
    expect(headers.get("anthropic-version")).toBe(ANTHROPIC_API_VERSION);
    expect(headers.get("authorization")).toBeNull();
    expect(field(result, "apiFormats")).toEqual({
      field: "apiFormats",
      state: "observed",
      value: ["messages"],
    });
    expect(field(result, "maxInputTokens")).toEqual({
      field: "maxInputTokens",
      state: "observed",
      value: 200_000,
    });
    expect(field(result, "maxOutputTokens")).toEqual({
      field: "maxOutputTokens",
      state: "observed",
      value: 8_192,
    });
    expect(field(result, "contextWindow")).toEqual({
      field: "contextWindow",
      state: "observed",
      value: 208_192,
    });
    expect(field(result, "limitSemantics")).toEqual({
      field: "limitSemantics",
      state: "observed",
      value: "combined-context",
    });
    expect(field(result, "origin")).toMatchObject({
      state: "observed",
      value: ANTHROPIC_API_ORIGIN,
    });
    expect(result.observation.source).toEqual({
      id: "anthropic-api-model-catalog",
      adapter: { id: "adapter:anthropic-api-model-catalog", version: "1.0.0" },
      retrievedAt: NOW.toISOString(),
    });
    const durable = JSON.stringify(result);
    expect(durable).not.toContain("provider prose");
    expect(durable).not.toContain(ANTHROPIC_KEY);
    expect(durable).not.toContain("INFERENCE_HUB");
  });

  it("binds an immutable validated config across injected network I/O", async () => {
    const config = anthropicConfig();
    const request: AnthropicApiCatalogDiscoveryInput = {
      config,
      purpose: "policy",
      clock: () => NOW,
    };
    request.fetch = async (_url, init) => {
      expect(new Headers(init?.headers).get("x-api-key")).toBe(ANTHROPIC_KEY);
      config.baseUrl = "https://api.openai.com/v1";
      config.providerId = "openai";
      config.modelId = "attacker-model";
      config.apiKey = HUB_KEY;
      request.purpose = "judge";
      return catalogResponse({
        id: MODEL_ID,
        type: "model",
        created_at: "2026-01-15T00:00:00.000Z",
        max_input_tokens: 200_000,
        max_tokens: 8_192,
      });
    };

    const result = await discoverAnthropicApiModelCatalog(request);
    expect(result.observation.purpose).toBe("policy");
    expect(field(result, "providerId")).toMatchObject({ state: "observed", value: "anthropic" });
    expect(field(result, "modelId")).toMatchObject({ state: "observed", value: MODEL_ID });
    expect(JSON.stringify(result)).not.toContain("attacker-model");
    expect(JSON.stringify(result)).not.toContain(HUB_KEY);
  });

  it("does not treat undocumented retrieve limit fields as catalog evidence", async () => {
    const result = await discoverAnthropicApiModelCatalog({
      config: anthropicConfig(),
      purpose: "policy",
      fetch: vi.fn(async () =>
        catalogResponse({
          id: MODEL_ID,
          type: "model",
          created_at: "2026-01-15T00:00:00.000Z",
          context_window: 200_000,
          max_output_tokens: 8_192,
        }),
      ) as typeof globalThis.fetch,
      clock: () => NOW,
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
  });

  it("rejects OpenAI, NVIDIA, and Hub credentials before network I/O", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("must not fetch");
    });
    for (const apiKey of [OPENAI_KEY, NVIDIA_KEY, HUB_KEY, "sk-ant-short"]) {
      await expect(
        discoverAnthropicApiModelCatalog({
          config: anthropicConfig({ apiKey }),
          purpose: "policy",
          fetch: fetch as typeof globalThis.fetch,
          clock: () => NOW,
        }),
      ).rejects.toMatchObject({
        name: "AnthropicApiCatalogDiscoveryError",
        code: "invalid-configuration",
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects chat_completions on the Anthropic catalog adapter", async () => {
    await expect(
      discoverAnthropicApiModelCatalog({
        config: anthropicConfig({ apiFormat: "chat_completions" }),
        purpose: "policy",
        fetch: vi.fn(async () => {
          throw new Error("must not fetch");
        }) as typeof globalThis.fetch,
        clock: () => NOW,
      }),
    ).rejects.toBeInstanceOf(AnthropicApiCatalogDiscoveryError);
  });

  it("maps HTTP 404 to model-absent", async () => {
    await expect(
      discoverAnthropicApiModelCatalog({
        config: anthropicConfig(),
        purpose: "policy",
        fetch: vi.fn(async () =>
          catalogResponse({ type: "error" }, { status: 404 }),
        ) as typeof globalThis.fetch,
        clock: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "model-absent" });
  });
});

function anthropicConfig(overrides: Partial<ModelEndpointConfig> = {}): ModelEndpointConfig {
  const base = structuredClone(validModelConfig);
  return {
    ...base,
    providerId: "anthropic",
    baseUrl: `${ANTHROPIC_API_ORIGIN}/v1`,
    modelId: MODEL_ID,
    apiKey: ANTHROPIC_KEY,
    apiFormat: "messages",
    profile: {
      ...base.profile,
      input: ["text"],
      compatibility: {
        ...base.profile.compatibility,
        apiFormats: ["messages"],
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

function field(result: Awaited<ReturnType<typeof discoverAnthropicApiModelCatalog>>, name: string) {
  return result.observation.fields.find((candidate) => candidate.field === name);
}
