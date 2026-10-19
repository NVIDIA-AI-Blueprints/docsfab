// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ModelEndpointConfig } from "../src/model/configuration.js";
import { temporaryRoots } from "./helpers/temp.js";

// Every internal-gateway site reads its origin from the route registry. With
// the registry moved to a test origin, each site must follow it, and the
// shipped gateway origin must no longer be special anywhere.
const REGISTRY_BASE_URL = "https://inference-gateway.example.test/v1";
const REGISTRY_ORIGIN = "https://inference-gateway.example.test";
const OTHER_ORIGIN = "https://inference-elsewhere.example.test";

vi.mock("../src/config/executable-route-urls.js", () => {
  const EXECUTABLE_ROUTE_BASE_URLS = Object.freeze({
    "nvidia-inference-api": "https://inference-gateway.example.test/v1",
    "nvidia-api-catalog": "https://catalog-gateway.example.test/v1",
    "openai-api": "https://openai-gateway.example.test/v1",
    "anthropic-api": "https://api.anthropic.com/v1",
  });
  return {
    EXECUTABLE_ROUTE_BASE_URLS,
    EXECUTABLE_ROUTE_ORIGINS: new Set(
      Object.values(EXECUTABLE_ROUTE_BASE_URLS).map((baseUrl) => new URL(baseUrl).origin),
    ),
    isExecutableRouteOrigin: (routeId: keyof typeof EXECUTABLE_ROUTE_BASE_URLS, origin: string) =>
      new URL(EXECUTABLE_ROUTE_BASE_URLS[routeId]).origin === origin,
  };
});

const { ROUTE_PROBE_TARGETS } = await import("../src/cli/profile-probe.js");
const { EXECUTABLE_ROUTE_BASE_URLS } = await import("../src/config/executable-route-urls.js");
const { NVIDIA_INFERENCE_CATALOG_ORIGIN, resolveModelCatalogAdapterSet } = await import(
  "../src/model/catalog-serving-route.js"
);
const { NVIDIA_INFERENCE_CATALOG_ENDPOINT, discoverNvidiaInferenceModelCatalog } = await import(
  "../src/model/nvidia-inference-catalog.js"
);
const { resolveEvalPresetFieldBlock, resolveProfileSeedPreset } = await import(
  "../src/model/profile-apply/eval-presets.js"
);
const {
  expand: expandMatrixValue,
  loadConfig: loadMatrixConfig,
  providerForModel,
} = await import("../scripts/model-matrix/lib.mjs");
const { inspectInferenceHubMetadata } = await import("../src/model/inference-hub-metadata.js");
const { reconcileModelCatalog } = await import("../src/model/catalog-reconciliation.js");
const { finalizeModelCatalogObservation } = await import("../src/model/catalog-contracts.js");
const { finalizeModelCatalogObservationProvenance } = await import(
  "../src/model/catalog-provenance.js"
);
const { createProviderConnectionFactory } = await import("../src/model/provider.js");
const { DOCSFAB_SYSTEM_PROMPT } = await import("../src/model/request-policy.js");
const { validModelConfig } = await import("./helpers.js");

const NOW = new Date("2026-08-04T12:00:00.000Z");
const RUNTIME_MODEL = "openai/gpt-5.4";
const QUALIFIED_MODEL = "azure/openai/gpt-5.4";
const INFERENCE_KEY = `nvapi-${"A".repeat(24)}`;
const METADATA_KEY = `ihub_api_${"B".repeat(24)}`;

function jsonResponse(value: unknown, url?: string): Response {
  const response = new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
  if (url) Object.defineProperty(response, "url", { configurable: true, value: url });
  return response;
}

async function reconcileAt(runtimeOrigin: string) {
  const metadata = await inspectInferenceHubMetadata({
    requested: true,
    authority: "authenticated",
    purpose: "policy",
    label: QUALIFIED_MODEL,
    endpoint: {
      origin: "https://metadata.example.test",
      path: "/v1/catalog/search",
      mode: "search",
    },
    environment: { INFERENCE_HUB_METADATA_API_KEY: METADATA_KEY },
    clock: () => NOW,
    fetch: async () =>
      jsonResponse({
        data: [
          {
            label: QUALIFIED_MODEL,
            provider_id: "azure",
            status: "active",
            capabilities: {
              chat: true,
              reasoning: true,
              tool_use: true,
              input_modalities: ["text"],
              supports_developer_role: true,
              supports_reasoning_effort: true,
              supports_system_role: true,
            },
            limits: {
              context_length: 1_000_000,
              limit_semantics: "combined-context",
            },
            pricing: null,
            updated_at: "2026-08-01T00:00:00.000Z",
          },
        ],
      }),
  });
  if (metadata.status !== "observed") throw new Error("metadata fixture failed");
  const config: ModelEndpointConfig = {
    ...structuredClone(validModelConfig),
    providerId: "nvidia",
    baseUrl: REGISTRY_BASE_URL,
    modelId: RUNTIME_MODEL,
    apiKey: INFERENCE_KEY,
  };
  const inference = await discoverNvidiaInferenceModelCatalog({
    config,
    purpose: "policy",
    clock: () => NOW,
    fetch: async () =>
      jsonResponse(
        {
          object: "list",
          data: [
            {
              id: RUNTIME_MODEL,
              max_input_tokens: 1_050_000,
              max_output_tokens: 128_000,
            },
          ],
        },
        NVIDIA_INFERENCE_CATALOG_ENDPOINT,
      ),
  });
  let observation = inference.observation;
  let provenance = inference.provenance;
  // Only the adjacent case moves the observed runtime origin off the registry.
  if (runtimeOrigin !== REGISTRY_ORIGIN) {
    observation = finalizeModelCatalogObservation({
      id: `${observation.id}:moved-origin`,
      purpose: observation.purpose,
      source: {
        ...observation.source,
        adapter: { ...observation.source.adapter },
      },
      fields: observation.fields.map((field) =>
        field.field === "origin"
          ? { field: "origin", state: "observed", value: runtimeOrigin }
          : structuredClone(field),
      ),
    });
    provenance = finalizeModelCatalogObservationProvenance({
      observation,
      sourcePath: "/v1/models",
    });
  }
  return reconcileModelCatalog({
    purpose: "policy",
    observationSetId: "observation-set:registry-origin",
    observationSetCompletedAt: "2026-08-04T12:01:00.000Z",
    proposalId: "proposal:registry-origin",
    proposalCreatedAt: "2026-08-04T12:02:00.000Z",
    decisionId: "decision:registry-origin",
    observations: [metadata.observation, observation],
    observationProvenance: [metadata.provenance, provenance],
  });
}

const SONNET_5 = "aws/anthropic/bedrock-claude-sonnet-5";

/** One minimal chat-completions stream: a reply, a finish chunk, and usage. */
function chatStream(model: string): Response {
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ id: "chatcmpl-registry", created: 1, model, object: "chat.completion.chunk", choices, ...extra })}\n\n`;
  const body = [
    chunk([{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }]),
    chunk([{ index: 0, delta: {}, finish_reason: "stop" }]),
    chunk([], { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** The request body one Sonnet 5 turn sends to a hub-route base URL. */
async function sonnetRequestAt(baseUrl: string): Promise<Record<string, unknown>> {
  const requests: Record<string, unknown>[] = [];
  const factory = createProviderConnectionFactory({
    routeId: "nvidia-inference-api",
    transport: "openai-chat-completions",
    fetch: async (_request, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return chatStream(SONNET_5);
    },
  });
  const connection = await factory.create(
    {
      profile: {
        routeId: "nvidia-inference-api",
        providerId: "nvidia-inference-api",
        baseUrl,
        modelId: SONNET_5,
        transport: "openai-chat-completions",
        apiFormat: "chat_completions",
        profile: {
          ...validModelConfig.profile,
          reasoning: false,
          compatibility: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            apiFormats: ["chat_completions"],
          },
        },
        requestPolicy: validModelConfig.requestPolicy,
      },
      credential: { family: "nvidia-inference-api", apiKey: "test-key" },
    },
    { evidenceIdentity: { repositoryRevision: "a".repeat(40) } },
  );
  await connection.runtime
    .streamSimple(
      connection.model,
      {
        systemPrompt: DOCSFAB_SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
        tools: [] as never,
      },
      { maxTokens: 64 },
    )
    .result();
  expect(requests).toHaveLength(1);
  return requests[0]!;
}

describe("internal-gateway origins read from the route registry", () => {
  it("disables Sonnet 5 thinking at the registry origin and behind any other origin", async () => {
    expect((await sonnetRequestAt(REGISTRY_BASE_URL)).thinking).toEqual({
      type: "disabled",
    });
    // Keyed on the model id, so a gateway in front of the Hub keeps it.
    const elsewhere = await sonnetRequestAt(`${OTHER_ORIGIN}/v1`);
    expect(elsewhere.thinking).toEqual({ type: "disabled" });
    expect(elsewhere.model).toBe(SONNET_5);
  });

  it("derives the catalog origin and endpoint from the registry", () => {
    expect(NVIDIA_INFERENCE_CATALOG_ORIGIN).toBe(REGISTRY_ORIGIN);
    expect(NVIDIA_INFERENCE_CATALOG_ENDPOINT).toBe(`${REGISTRY_BASE_URL}/models`);
  });

  it("probes each route at its registry base URL", () => {
    expect(ROUTE_PROBE_TARGETS["nvidia-inference-api"].baseUrl).toBe(REGISTRY_BASE_URL);
    expect(ROUTE_PROBE_TARGETS["nvidia-api-catalog"].baseUrl).toBe(
      "https://catalog-gateway.example.test/v1",
    );
    expect(ROUTE_PROBE_TARGETS["openai-api"].baseUrl).toBe(
      "https://openai-gateway.example.test/v1",
    );
  });

  it("seeds preset field blocks with registry base URLs", () => {
    const hub = new Map(
      resolveEvalPresetFieldBlock("nvidia/nvidia/nemotron-3-super-v3").assignments,
    );
    const catalog = new Map(
      resolveEvalPresetFieldBlock("nvidia/llama-3.3-nemotron-super-49b-v1.5").assignments,
    );
    const internalSeed = new Map(resolveProfileSeedPreset("azure/openai/gpt-6-sol").assignments);
    expect(hub.get("MODEL_BASE_URL")).toBe(REGISTRY_BASE_URL);
    expect(catalog.get("MODEL_BASE_URL")).toBe("https://catalog-gateway.example.test/v1");
    expect(internalSeed.get("MODEL_BASE_URL")).toBe(REGISTRY_BASE_URL);
  });

  it("selects the NVIDIA catalog adapter only for the registry origin", () => {
    expect(
      resolveModelCatalogAdapterSet({
        providerId: "nvidia",
        baseUrl: REGISTRY_BASE_URL,
      }),
    ).toBe("nvidia-inference-api");
    expect(
      resolveModelCatalogAdapterSet({
        providerId: "nvidia",
        baseUrl: `${OTHER_ORIGIN}/v1`,
      }),
    ).toBe("unimplemented");
  });

  it("reconciles the Hub and Metadata pair at the registry origin", async () => {
    const result = await reconcileAt(REGISTRY_ORIGIN);

    expect(result.decision.reasons).toContainEqual(
      expect.objectContaining({
        code: "runtime-boundary-selected",
        field: "origin",
      }),
    );
    expect(result.decision.reasons).not.toContainEqual(
      expect.objectContaining({ code: "irreconcilable-endpoint" }),
    );
    if (result.status !== "proposed") throw new Error("expected a proposal");
    const origin = result.proposal.fields.find((field) => field.field === "origin");
    expect(origin).toMatchObject({ state: "observed", value: REGISTRY_ORIGIN });
  });

  it("blocks the Hub and Metadata pair at any origin the registry does not name", async () => {
    const result = await reconcileAt(OTHER_ORIGIN);

    expect(result.status).toBe("blocked");
    expect(result.decision.reasons).toContainEqual(
      expect.objectContaining({
        code: "irreconcilable-endpoint",
        severity: "blocking",
        field: "origin",
      }),
    );
  });
});

describe("model-matrix configs read route origins from the registry", () => {
  const roots = temporaryRoots();

  it("loads an independently owned provider, model override and judge from named public routes", async () => {
    const directory = await roots.create("docsfab-public-matrix-config-", { realpath: true });
    const configPath = join(directory, "operator-owned.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        provider: { providerId: "public-example", baseUrl: "${route:nvidia-api-catalog}" },
        models: [
          { id: "public-default", family: "catalog-example" },
          {
            id: "public-override",
            family: "openai-example",
            provider: { baseUrl: "${route:openai-api}" },
          },
        ],
        judge: { baseUrl: "${route:anthropic-api}" },
      }),
    );

    const config = await loadMatrixConfig(configPath);
    expect(
      config.models.map((model: { id: string }) => ({
        id: model.id,
        baseUrl: providerForModel(config, model).baseUrl,
      })),
    ).toEqual([
      { id: "public-default", baseUrl: EXECUTABLE_ROUTE_BASE_URLS["nvidia-api-catalog"] },
      { id: "public-override", baseUrl: EXECUTABLE_ROUTE_BASE_URLS["openai-api"] },
    ]);
    expect(config.judge.baseUrl).toBe(EXECUTABLE_ROUTE_BASE_URLS["anthropic-api"]);
  });

  it("refuses a retained-content declaration before expanding any benchmark configuration", async () => {
    const directory = await roots.create("docsfab-retained-matrix-declaration-", {
      realpath: true,
    });
    const configPath = join(directory, "retained.config.json");
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 1, contentAvailability: "internal-only" }),
    );

    await expect(loadMatrixConfig(configPath)).rejects.toMatchObject({
      code: "internal-content-unavailable",
      message:
        "internal-content-unavailable: the benchmark configuration and inputs are retained internally. Use the authorized internal checkout or supply an independently owned corpus configuration.",
    });
  });

  it("expands a named route and leaves variable expansion to the environment and overrides", () => {
    expect(expandMatrixValue("${route:nvidia-api-catalog}")).toBe(
      "https://catalog-gateway.example.test/v1",
    );
    expect(expandMatrixValue("${ROUTE_BASE}/models", { ROUTE_BASE: OTHER_ORIGIN })).toBe(
      `${OTHER_ORIGIN}/models`,
    );
  });

  it("refuses a route id the registry does not name, and an undefined variable, by name", () => {
    expect(() => expandMatrixValue("${route:inference-gateway}")).toThrow(
      "${route:inference-gateway} names no route in the executable route registry. Use one of: nvidia-inference-api, nvidia-api-catalog, openai-api, anthropic-api.",
    );
    expect(() => expandMatrixValue("${MATRIX_UNSET_VARIABLE_FOR_TEST}")).toThrow(
      "${MATRIX_UNSET_VARIABLE_FOR_TEST} is not defined in the environment or overrides.",
    );
  });
});
