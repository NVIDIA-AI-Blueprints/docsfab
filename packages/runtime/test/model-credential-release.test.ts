// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { inspect } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runProfileProbe, ROUTE_PROBE_TARGETS } from "../src/cli/profile-probe.js";
import { loadCompositionRunRuntime } from "../src/cli/run/composition-runtime.js";
import type { RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";
import { loadConfig, type DocsFabConfig } from "../src/config/runtime-loader.js";
import { answerSubmissionProbeTarget, checkLiveModel } from "../src/doctor.js";
import { sealHostRuntimeComposition } from "../src/host-invoker/contracts.js";
import { discoverAnthropicApiModelCatalog } from "../src/model/anthropic-api-catalog.js";
import {
  ANTHROPIC_API_ORIGIN,
  NVIDIA_INFERENCE_CATALOG_ORIGIN,
  OPENAI_API_ORIGIN,
} from "../src/model/catalog-serving-route.js";
import {
  parseModelEndpoint,
  type BoundModelExecutionProfile,
  type ModelEndpointConfig,
  type ProviderCredential,
} from "../src/model/configuration.js";
import { discoverNvidiaInferenceModelCatalog } from "../src/model/nvidia-inference-catalog.js";
import { discoverOpenaiApiModelCatalog } from "../src/model/openai-api-catalog.js";
import { inspectModelEndpointProfile } from "../src/model/profile-inspection.js";
import { createModelConnection, createProviderConnectionFactory } from "../src/model/provider.js";
import { DEFAULT_NEXT_ACTIONS, toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";
import {
  chatCompletionsProbeShape,
  probeEndpointCompatibility,
} from "../src/profile/endpoint-compatibility.js";
import {
  CREDENTIAL_ENDPOINT_UNTRUSTED_CODE,
  CREDENTIAL_ENDPOINT_UNTRUSTED_NEXT_ACTION,
  CredentialEndpointUntrustedError,
  OPERATOR_ENDPOINT_SOURCES,
  ReleasedModelCredential,
  UNTRUSTED_ENDPOINT_KINDS,
  credentialForRequest,
  releaseModelCredential,
  type EndpointSource,
} from "../src/security/model-credential-release.js";
import { validModelConfig, validModelEnvironment } from "./helpers.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();

/** A placeholder key: plain words, never shaped like a real credential. */
const KEY = "release-fixture-orchard-meadow-key";
const ENDPOINT = "https://models.example.test/v1";
const UNTRUSTED_SOURCES = UNTRUSTED_ENDPOINT_KINDS.map(
  (kind) => `untrusted:${kind}` as const satisfies EndpointSource,
);
const TRUSTED_SOURCES: readonly (EndpointSource | undefined)[] = [
  undefined,
  ...OPERATOR_ENDPOINT_SOURCES,
];

/** What a fake upstream keeps of a credential header: never its value. */
type CredentialSeen = "absent" | "the configured key" | "another value";

interface UpstreamRequest {
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly credential: CredentialSeen;
}

function credentialSeen(value: string | null | undefined, expected: string): CredentialSeen {
  if (value === null || value === undefined) return "absent";
  return value === expected ? "the configured key" : "another value";
}

/**
 * A loopback OpenAI-compatible server. It answers the compatibility probe's
 * tool and JSON turns and a plain turn, and records each request's method,
 * path, and whether its `Authorization` header carried the configured key.
 */
async function startUpstream(modelId: string) {
  const requests: UpstreamRequest[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method,
        path: request.url,
        credential: credentialSeen(request.headers.authorization, `Bearer ${KEY}`),
      });
      const parsed = JSON.parse(body) as { tools?: unknown[]; messages?: unknown[] };
      const asksForJson = JSON.stringify(parsed.messages ?? []).includes("only this JSON object");
      const delta =
        (parsed.tools?.length ?? 0) > 0
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call-release",
                  type: "function",
                  function: { name: "record_probe_result", arguments: '{"result":"ok"}' },
                },
              ],
            }
          : {
              role: "assistant",
              content: asksForJson
                ? '{"result":"ok","checks":["tool-calls","structured-output"]}'
                : "DOCSFAB_OK",
            };
      const chunks = [
        {
          id: "release",
          object: "chat.completion.chunk",
          created: 1,
          model: modelId,
          choices: [{ index: 0, delta }],
        },
        {
          id: "release",
          object: "chat.completion.chunk",
          created: 1,
          model: modelId,
          choices: [
            { index: 0, delta: {}, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"].join(
          "",
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { requests, baseUrl: `http://127.0.0.1:${String(port)}/v1` };
}

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

const MODEL_ID = "example/model";

/** The operator's endpoint, loaded as `loadConfig` loads it, then labelled. */
function configuredEndpoint(baseUrl: string, endpointSource?: EndpointSource): ModelEndpointConfig {
  const parsed = parseModelEndpoint({
    ...validModelEnvironment,
    MODEL_BASE_URL: baseUrl,
    MODEL_ID,
    MODEL_API_KEY: KEY,
  });
  return endpointSource === undefined ? parsed : { ...parsed, endpointSource };
}

async function refusal(promise: Promise<unknown>): Promise<CredentialEndpointUntrustedError> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(CredentialEndpointUntrustedError);
  expect((caught as CredentialEndpointUntrustedError).code).toBe(
    CREDENTIAL_ENDPOINT_UNTRUSTED_CODE,
  );
  return caught as CredentialEndpointUntrustedError;
}

function refusalSync(fn: () => unknown): CredentialEndpointUntrustedError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CredentialEndpointUntrustedError);
  return caught as CredentialEndpointUntrustedError;
}

async function oneTurn(connection: Awaited<ReturnType<typeof createModelConnection>>) {
  return connection.runtime
    .streamSimple(connection.model, {
      systemPrompt: "Reply as instructed.",
      messages: [{ role: "user", content: "Reply with DOCSFAB_OK.", timestamp: 1 }],
    })
    .result();
}

describe("releaseModelCredential", () => {
  it.each(TRUSTED_SOURCES)(
    "releases the key for an endpoint from %s and reads it back for that origin",
    (endpointSource) => {
      const released = releaseModelCredential(
        { endpoint: ENDPOINT, endpointSource, apiKey: KEY },
        "model-connection",
      );
      expect(released.endpointOrigin).toBe("https://models.example.test");
      expect(released.endpointSource).toBe(endpointSource);
      expect(credentialForRequest(released, `${ENDPOINT}/chat/completions`)).toBe(KEY);
      expect(credentialForRequest(released, new URL("https://models.example.test/other"))).toBe(
        KEY,
      );
    },
  );

  it.each(UNTRUSTED_SOURCES)(
    "refuses an endpoint labelled %s with the code and next action",
    (endpointSource) => {
      const error = refusalSync(() =>
        releaseModelCredential(
          { endpoint: ENDPOINT, endpointSource, apiKey: KEY },
          "model-connection",
        ),
      );
      expect(error.message).toContain("DocsFab did not send the model key");
      expect(error.message).toContain("not from your configuration");
      expect(error.nextAction).toBe(CREDENTIAL_ENDPOINT_UNTRUSTED_NEXT_ACTION);
    },
  );

  it("refuses a label it does not recognize as an operator source", () => {
    for (const label of ["untrusted:constructor", "operator", "Environment", ""]) {
      const error = refusalSync(() =>
        releaseModelCredential(
          { endpoint: ENDPOINT, endpointSource: label as EndpointSource, apiKey: KEY },
          "model-connection",
        ),
      );
      expect(error.message).toContain("a source DocsFab does not recognize as your configuration");
    }
  });

  it.each([
    ["another host", "https://collector.example.test/v1/chat/completions"],
    ["another port", "https://models.example.test:8443/v1/chat/completions"],
    ["plain HTTP", "http://models.example.test/v1/chat/completions"],
    ["a relative path", "/v1/chat/completions"],
  ])("reads a released key back only for its own origin, not %s", (_label, requestUrl) => {
    const released = releaseModelCredential({ endpoint: ENDPOINT, apiKey: KEY }, "endpoint-probe");
    const error = refusalSync(() => credentialForRequest(released, requestUrl));
    expect(error.message).toContain("not to the configured endpoint https://models.example.test");
  });

  it("reads no key from anything that releaseModelCredential did not create", () => {
    const forged = Object.create(ReleasedModelCredential.prototype) as ReleasedModelCredential;
    for (const candidate of [forged, { endpointOrigin: ENDPOINT }, KEY, undefined]) {
      expect(() =>
        credentialForRequest(candidate as ReleasedModelCredential, `${ENDPOINT}/x`),
      ).toThrowError("A model credential reaches a request only through releaseModelCredential().");
    }
    const Constructor = ReleasedModelCredential as unknown as new (...args: unknown[]) => unknown;
    expect(
      () => new Constructor(Symbol("mint"), ENDPOINT, undefined, "model-connection"),
    ).toThrowError("Only releaseModelCredential() creates a released model credential.");
  });

  it("never prints or serializes the key", () => {
    const released = releaseModelCredential(
      { endpoint: ENDPOINT, endpointSource: "host-config", apiKey: KEY },
      "catalog-lookup",
    );
    for (const text of [
      JSON.stringify(released),
      JSON.stringify({ released }),
      String(released),
      `${released}`,
      inspect(released, { depth: 5, showHidden: true }),
      JSON.stringify(Object.getOwnPropertyNames(released)),
    ]) {
      expect(text).not.toContain(KEY);
    }
    expect(JSON.parse(JSON.stringify(released))).toEqual({
      kind: "released-model-credential",
      endpointOrigin: "https://models.example.test",
      purpose: "catalog-lookup",
    });
  });

  it("maps the refusal to its operator envelope and catalog next action", () => {
    const error = refusalSync(() =>
      releaseModelCredential(
        { endpoint: ENDPOINT, endpointSource: "untrusted:model-output", apiKey: KEY },
        "model-connection",
      ),
    );
    expect(DEFAULT_NEXT_ACTIONS[CREDENTIAL_ENDPOINT_UNTRUSTED_CODE]).toBe(
      CREDENTIAL_ENDPOINT_UNTRUSTED_NEXT_ACTION,
    );
    expect(toOperatorErrorEnvelope(error)).toMatchObject({
      code: CREDENTIAL_ENDPOINT_UNTRUSTED_CODE,
      nextAction: CREDENTIAL_ENDPOINT_UNTRUSTED_NEXT_ACTION,
      docsAnchor: "docs/about/security.md",
      failure: { class: "operator-input" },
    });
  });
});

describe("a model connection sends the key only to the configured endpoint", () => {
  it.each(TRUSTED_SOURCES)("sends one turn with the key to an endpoint from %s", async (source) => {
    const upstream = await startUpstream(MODEL_ID);
    const connection = await createModelConnection(configuredEndpoint(upstream.baseUrl, source));

    const turn = await oneTurn(connection);

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    expect(upstream.requests).toEqual([
      { method: "POST", path: "/v1/chat/completions", credential: "the configured key" },
    ]);
  });

  it.each(UNTRUSTED_SOURCES)(
    "stops before any request for an endpoint labelled %s",
    async (source) => {
      const upstream = await startUpstream(MODEL_ID);

      await refusal(createModelConnection(configuredEndpoint(upstream.baseUrl, source)));

      expect(upstream.requests).toEqual([]);
    },
  );

  it("keeps an empty label through the binder and stops before any request", async () => {
    const upstream = await startUpstream(MODEL_ID);

    await refusal(
      createModelConnection(configuredEndpoint(upstream.baseUrl, "" as EndpointSource)),
    );

    expect(upstream.requests).toEqual([]);
  });
});

describe("the endpoint probe sends the key only to the configured endpoint", () => {
  function probeTarget(baseUrl: string, endpointSource?: EndpointSource) {
    return {
      modelId: MODEL_ID,
      baseUrl,
      ...(endpointSource !== undefined ? { endpointSource } : {}),
      apiKey: KEY,
      maxOutputTokens: 256,
      outputLimitSource: "configured" as const,
      shape: chatCompletionsProbeShape({
        providerId: "test-provider",
        baseUrl,
        requestPolicy: false,
        reasoning: false,
        supportsDeveloperRole: true,
      }),
    };
  }

  it.each(["profile-file", "legacy-env-file", undefined] as const)(
    "probes an endpoint from %s with the key on both requests",
    async (source) => {
      const upstream = await startUpstream(MODEL_ID);

      const report = await probeEndpointCompatibility(probeTarget(upstream.baseUrl, source));

      expect(report.verdict).toBe("compatible");
      expect(upstream.requests.map((request) => request.credential)).toEqual([
        "the configured key",
        "the configured key",
      ]);
    },
  );

  it("stops before any request for an endpoint from request text", async () => {
    const upstream = await startUpstream(MODEL_ID);

    await refusal(
      probeEndpointCompatibility(probeTarget(upstream.baseUrl, "untrusted:request-text")),
    );

    expect(upstream.requests).toEqual([]);
  });
});

const DOCTOR_ASSETS = {
  projectRoot: process.cwd(),
  skillCrateDirectory: new URL("../skill-crate", import.meta.url).pathname,
  qualityDirectory: new URL("../quality", import.meta.url).pathname,
  qualityPackDirectory: new URL("../quality-pack", import.meta.url).pathname,
} as const;

/** A legacy configuration root: one `.env` file holding the profile and the key. */
async function legacyConfigurationRoot(baseUrl: string): Promise<string> {
  const root = await roots.create("docsfab-release-legacy-");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lines = Object.entries({
    ...validModelEnvironment,
    MODEL_BASE_URL: baseUrl,
    MODEL_ID,
    MODEL_API_KEY: KEY,
  }).map(([name, value]) => `${name}=${value}`);
  await writeFile(join(root, ".env"), `${lines.join("\n")}\n`, { mode: 0o600 });
  return root;
}

describe("docsfab doctor --live sends the key only to the configured endpoint", () => {
  it.each(["legacy-env-file", "profile-file", undefined] as const)(
    "reaches a legacy .env endpoint labelled %s with the key on every request",
    async (source) => {
      const upstream = await startUpstream(MODEL_ID);
      const root = await legacyConfigurationRoot(upstream.baseUrl);
      const loaded = loadConfig({ DOCSFAB_CONFIG_ROOT: root });
      expect(loaded.model.baseUrl).toBe(upstream.baseUrl);
      const config: DocsFabConfig = {
        ...loaded,
        ...DOCTOR_ASSETS,
        model: source ? { ...loaded.model, endpointSource: source } : loaded.model,
      };

      await expect(checkLiveModel(config)).resolves.toMatchObject({
        compatibility: { verdict: "compatible" },
      });

      // Two compatibility requests, then the connectivity turn.
      expect(upstream.requests.map((request) => request.credential)).toEqual([
        "the configured key",
        "the configured key",
        "the configured key",
      ]);
    },
  );

  it("stops before any request when the loaded endpoint is labelled as repository content", async () => {
    const upstream = await startUpstream(MODEL_ID);
    const root = await legacyConfigurationRoot(upstream.baseUrl);
    const loaded = loadConfig({ DOCSFAB_CONFIG_ROOT: root });

    await refusal(
      checkLiveModel({
        ...loaded,
        ...DOCTOR_ASSETS,
        model: { ...loaded.model, endpointSource: "untrusted:repository" },
      }),
    );
    await refusal(
      answerSubmissionProbeTarget({ ...loaded.model, endpointSource: "untrusted:repository" }),
    );

    expect(upstream.requests).toEqual([]);
  });

  it("builds the answer-submission target with a key released for the configured origin only", async () => {
    const upstream = await startUpstream(MODEL_ID);
    const target = await answerSubmissionProbeTarget(
      configuredEndpoint(upstream.baseUrl, "secrets-env"),
    );
    if ("decision" in target) throw new Error(target.reason);

    expect(target.provider.credential.endpointOrigin).toBe(new URL(upstream.baseUrl).origin);
    expect(
      credentialForRequest(target.provider.credential, `${upstream.baseUrl}/chat/completions`),
    ).toBe(KEY);
    refusalSync(() =>
      credentialForRequest(target.provider.credential, "https://collector.example.test/v1"),
    );
    expect(upstream.requests).toEqual([]);
  });
});

describe("the catalog lookups send the key only to the configured provider", () => {
  const OPENAI_KEY = `sk-${"A".repeat(24)}`;
  const ANTHROPIC_KEY = `sk-ant-${"B".repeat(24)}`;
  const INFERENCE_KEY = `nvapi-${"C".repeat(24)}`;

  function recordingFetch(expectedHeader: "authorization" | "x-api-key", expected: string) {
    const seen: { url: string; credential: CredentialSeen }[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seen.push({
        url,
        credential: credentialSeen(new Headers(init?.headers).get(expectedHeader), expected),
      });
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    });
    return { seen, fetch: fetch as unknown as typeof globalThis.fetch };
  }

  const CATALOGS = [
    {
      name: "OpenAI",
      header: "authorization" as const,
      expected: `Bearer ${OPENAI_KEY}`,
      config: (endpointSource?: EndpointSource): ModelEndpointConfig => ({
        ...structuredClone(validModelConfig),
        providerId: "openai",
        baseUrl: `${OPENAI_API_ORIGIN}/v1`,
        modelId: "gpt-5.6-sol",
        apiKey: OPENAI_KEY,
        profile: {
          ...structuredClone(validModelConfig.profile),
          input: ["text"],
        },
        ...(endpointSource !== undefined ? { endpointSource } : {}),
      }),
      discover: discoverOpenaiApiModelCatalog,
      origin: OPENAI_API_ORIGIN,
    },
    {
      name: "Anthropic",
      header: "x-api-key" as const,
      expected: ANTHROPIC_KEY,
      config: (endpointSource?: EndpointSource): ModelEndpointConfig => ({
        ...structuredClone(validModelConfig),
        providerId: "anthropic",
        baseUrl: `${ANTHROPIC_API_ORIGIN}/v1`,
        modelId: "claude-opus-4-7",
        apiKey: ANTHROPIC_KEY,
        apiFormat: "messages",
        profile: {
          ...structuredClone(validModelConfig.profile),
          input: ["text"],
          compatibility: { ...validModelConfig.profile.compatibility, apiFormats: ["messages"] },
        },
        ...(endpointSource !== undefined ? { endpointSource } : {}),
      }),
      discover: discoverAnthropicApiModelCatalog,
      origin: ANTHROPIC_API_ORIGIN,
    },
    {
      name: "NVIDIA Inference",
      header: "authorization" as const,
      expected: `Bearer ${INFERENCE_KEY}`,
      config: (endpointSource?: EndpointSource): ModelEndpointConfig => ({
        ...structuredClone(validModelConfig),
        providerId: "nvidia",
        baseUrl: `${NVIDIA_INFERENCE_CATALOG_ORIGIN}/v1`,
        modelId: "openai/gpt-5.4",
        apiKey: INFERENCE_KEY,
        ...(endpointSource !== undefined ? { endpointSource } : {}),
      }),
      discover: discoverNvidiaInferenceModelCatalog,
      origin: NVIDIA_INFERENCE_CATALOG_ORIGIN,
    },
  ];

  it.each(CATALOGS)(
    "$name sends its one lookup with the key to the provider's origin",
    async (catalog) => {
      for (const source of ["host-config", undefined] as const) {
        const recorded = recordingFetch(catalog.header, catalog.expected);
        await catalog
          .discover({ config: catalog.config(source), purpose: "policy", fetch: recorded.fetch })
          .catch(() => undefined);
        expect(recorded.seen.map((request) => request.credential)).toEqual(["the configured key"]);
        expect(new URL(recorded.seen[0]!.url).origin).toBe(catalog.origin);
      }
    },
  );

  it.each(CATALOGS)("$name stops before its lookup for an endpoint from chat", async (catalog) => {
    const recorded = recordingFetch(catalog.header, catalog.expected);

    await refusal(
      catalog.discover({
        config: catalog.config("untrusted:chat"),
        purpose: "policy",
        fetch: recorded.fetch,
      }),
    );

    expect(recorded.seen).toEqual([]);
  });

  it.each(CATALOGS)(
    "$name: profile inspection stops with the code instead of reporting the catalog unavailable",
    async (catalog) => {
      const recorded = recordingFetch(catalog.header, catalog.expected);

      await refusal(
        inspectModelEndpointProfile(catalog.config("untrusted:forge-text"), "policy", {
          catalog: true,
          fetch: recorded.fetch,
          environment: {},
        }),
      );

      expect(recorded.seen).toEqual([]);
    },
  );

  it.each(CATALOGS)(
    "$name: profile inspection keeps an empty label and stops before its lookup",
    async (catalog) => {
      const recorded = recordingFetch(catalog.header, catalog.expected);

      await refusal(
        inspectModelEndpointProfile(catalog.config("" as EndpointSource), "policy", {
          catalog: true,
          fetch: recorded.fetch,
          environment: {},
        }),
      );

      expect(recorded.seen).toEqual([]);
    },
  );
});

describe("docsfab profile probe releases the key for the route's own endpoint", () => {
  it("sends every probe request with the key to the preset origin", async () => {
    const routeOrigin = new URL(ROUTE_PROBE_TARGETS["nvidia-api-catalog"].baseUrl).origin;
    const seen: { origin: string; credential: CredentialSeen }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seen.push({
        origin: new URL(url).origin,
        credential: credentialSeen(
          new Headers(init?.headers).get("authorization"),
          `Bearer ${KEY}`,
        ),
      });
      return new Response(JSON.stringify({ error: { message: "denied" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });

    await runProfileProbe(
      {
        routeId: "nvidia-api-catalog",
        modelId: "nvidia/nemotron-3-ultra-550b-a55b",
        live: true,
        json: true,
      },
      { environment: { DOCSFAB_NVIDIA_API_KEY: KEY } },
    );

    expect(seen.length).toBeGreaterThan(0);
    expect(seen).toEqual(
      seen.map(() => ({ origin: routeOrigin, credential: "the configured key" })),
    );
  });

  it("labels the release as the preset and binds it to the route's origin", async () => {
    const providers: { credential: ReleasedModelCredential }[] = [];
    await runProfileProbe(
      { routeId: "openai-api", modelId: "gpt-5.6-sol", live: true, json: true },
      {
        environment: { OPENAI_API_KEY: KEY },
        probeOne: (async (_model: string, provider: { credential: ReleasedModelCredential }) => {
          providers.push(provider);
          return { reachable: false, status: 401, error: "denied" };
        }) as never,
      },
    );

    expect(providers).toHaveLength(1);
    const released = providers[0]!.credential;
    expect(released.endpointSource).toBe("preset");
    expect(released.endpointOrigin).toBe(new URL(EXECUTABLE_ROUTE_BASE_URLS["openai-api"]).origin);
    refusalSync(() => credentialForRequest(released, "http://127.0.0.1:9/v1/chat/completions"));
  });
});

/** A packet execution profile, as the host seals it into a hosted composition. */
function packetProfile(
  routeId: "openai-direct" | "anthropic-direct" | "nvidia-api-catalog" | "nvidia-inference-api",
): BoundModelExecutionProfile {
  const anthropic = routeId === "anthropic-direct";
  return {
    routeId,
    providerId: routeId,
    baseUrl: "https://models.example.test/v1",
    modelId: "model-fixture",
    transport: anthropic ? "anthropic-messages" : "openai-chat-completions",
    apiFormat: anthropic ? "messages" : "chat_completions",
    profile: {
      configuredLimits: { contextWindow: 8192, maxInputTokens: 4096, maxOutputTokens: 2048 },
      contextWindow: 8192,
      maxInputTokens: 4096,
      maxOutputTokens: 2048,
      effectiveLimitReason: "composition-candidate",
      reasoning: false,
      input: ["text"],
      compatibility: {
        supportsDeveloperRole: true,
        supportsReasoningEffort: false,
        apiFormats: [anthropic ? "messages" : "chat_completions"],
      },
      costPerMillionTokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
      metadata: { approvedSource: null, effectiveDate: null, reviewAfter: null, status: "unknown" },
    },
    requestPolicy: { minimumOutputTokens: 16, reservedContextTokens: 512 },
  };
}

const PACKET_ROUTES = [
  ["openai-direct", "openai-api"],
  ["anthropic-direct", "anthropic-api"],
  ["nvidia-api-catalog", "nvidia-api-catalog"],
  ["nvidia-inference-api", "nvidia-inference-api"],
] as const;

describe("a hosted composition serves its key only to its own family's route", () => {
  it.each(PACKET_ROUTES)(
    "refuses %s with any other family as credential-route-mismatch",
    (route, family) => {
      for (const [, otherFamily] of PACKET_ROUTES) {
        if (otherFamily === family) continue;
        expect(() =>
          sealHostRuntimeComposition({
            compositionId: `${route}-v1`,
            route,
            credentialFamily: otherFamily,
            executionProfile: packetProfile(route),
            declaredTools: ["read"],
          }),
        ).toThrowError(expect.objectContaining({ code: "credential-route-mismatch" }));
      }
    },
  );

  it("runs a turn for the matching family, with the key on the packet's own endpoint", async () => {
    const composition = sealHostRuntimeComposition({
      compositionId: "openai-direct-v1",
      route: "openai-direct",
      credentialFamily: "openai-api",
      executionProfile: packetProfile("openai-direct"),
      declaredTools: ["read"],
    });
    const profile = composition.executionProfile!;
    // A packet carries no endpoint label: the host supplied its endpoint.
    expect(profile).not.toHaveProperty("endpointSource");
    const seen: { origin: string; credential: CredentialSeen }[] = [];
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        seen.push({
          origin: new URL(url).origin,
          credential: credentialSeen(
            new Headers(init?.headers).get("authorization"),
            `Bearer ${KEY}`,
          ),
        });
        return sseTurn(profile.modelId);
      },
    });
    const credential: ProviderCredential = {
      family: composition.credentialFamily as ProviderCredential["family"],
      apiKey: KEY,
    };
    const connection = await factory.create({ profile, credential });

    const turn = await oneTurn(connection);

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    expect(seen).toEqual([
      { origin: "https://models.example.test", credential: "the configured key" },
    ]);
  });

  it("cannot seal an endpoint label into a packet", () => {
    expect(() =>
      sealHostRuntimeComposition({
        compositionId: "openai-direct-v1",
        route: "openai-direct",
        credentialFamily: "openai-api",
        executionProfile: { ...packetProfile("openai-direct"), endpointSource: "untrusted:chat" },
        declaredTools: ["read"],
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-shape" }));
  });
});

function sseTurn(model: string): Response {
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ id: "release", created: 1, model, object: "chat.completion.chunk", choices, ...extra })}\n\n`;
  return new Response(
    [
      chunk([
        { index: 0, delta: { role: "assistant", content: "DOCSFAB_OK" }, finish_reason: null },
      ]),
      chunk([{ index: 0, delta: {}, finish_reason: "stop" }], {
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
      "data: [DONE]\n\n",
    ].join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("docsfab run --composition carries the endpoint label to the release", () => {
  const SONNET_5 = "aws/anthropic/bedrock-claude-sonnet-5";

  async function bind(endpointSource: EndpointSource | undefined) {
    const request: RunRequestWithPublishProjection = {
      workflow: "review-documentation",
      repositoryPath: "/tmp/docsfab-composition-target",
      revision: "HEAD",
      allowWrite: false,
      releaseGate: false,
      verbose: false,
      json: false,
      showScan: false,
      compositionId: "nvidia-inference-claude-sonnet-5-pi",
    };
    const config: DocsFabConfig = {
      ...DOCTOR_ASSETS,
      stateDirectory: "/tmp/docsfab-state/runs",
      retryPolicy: {
        maxRetries: 0,
        baseDelayMs: 1,
        maxDelayMs: 1,
        retryableCategories: ["provider-transient"],
      },
      model: {
        ...validModelConfig,
        providerId: "nvidia-inference-api",
        baseUrl: EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"],
        ...(endpointSource !== undefined ? { endpointSource } : {}),
        modelId: SONNET_5,
        apiKey: KEY,
        profile: {
          ...validModelConfig.profile,
          reasoning: false,
          compatibility: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            apiFormats: ["chat_completions"],
          },
        },
      },
    };
    return loadCompositionRunRuntime(request, config, {
      DOCSFAB_COMPOSITION_EXECUTION_MAX_PROVIDER_TURNS: "512",
      DOCSFAB_COMPOSITION_EXECUTION_TIMEOUT_MS: "1800000",
      DOCSFAB_COMPOSITION_EXECUTION_MAX_RESPONSE_BYTES: "4194304",
    });
  }

  function recordingFactory(profile: BoundModelExecutionProfile) {
    const seen: CredentialSeen[] = [];
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async (_input, init) => {
        seen.push(credentialSeen(new Headers(init?.headers).get("authorization"), `Bearer ${KEY}`));
        return sseTurn(profile.modelId);
      },
    });
    return { seen, factory };
  }

  it("sends the composition's turn with the key for a preset endpoint", async () => {
    const runtime = await bind("preset");
    expect(runtime.executionProfile.endpointSource).toBe("preset");
    const { seen, factory } = recordingFactory(runtime.executionProfile);

    const connection = await factory.create({
      profile: runtime.executionProfile,
      credential: runtime.credential,
    });
    const turn = await oneTurn(connection);

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    expect(seen).toEqual(["the configured key"]);
  });

  it("stops before any request for a composition endpoint taken from model output", async () => {
    const runtime = await bind("untrusted:model-output");
    const { seen, factory } = recordingFactory(runtime.executionProfile);

    await refusal(
      factory.create({ profile: runtime.executionProfile, credential: runtime.credential }),
    );

    expect(seen).toEqual([]);
  });

  it("keeps an empty label on the composition profile and stops before any request", async () => {
    const runtime = await bind("" as EndpointSource);
    expect(runtime.executionProfile.endpointSource).toBe("");
    const { seen, factory } = recordingFactory(runtime.executionProfile);

    await refusal(
      factory.create({ profile: runtime.executionProfile, credential: runtime.credential }),
    );

    expect(seen).toEqual([]);
  });
});
