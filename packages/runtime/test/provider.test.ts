// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../src/contract-kit/index.js";
import { observeLandedProviderTurn } from "../src/model/attempt-telemetry.js";
import { classifyModelFailure } from "../src/model/context-budget.js";
import {
  parseModelEndpoint,
  type BoundModelExecutionProfile,
  type ProviderCredentialFamily,
  type ProviderTransport,
} from "../src/model/configuration.js";
import { ModelCompositionError } from "../src/model-composition/index.js";
import {
  createModelConnection,
  createProviderConnectionFactory,
  hasReportableUsageCost,
} from "../src/model/provider.js";
import {
  DOCSFAB_SYSTEM_PROMPT,
  DOCSFAB_SYSTEM_PROMPT_SHA256,
} from "../src/model/request-policy.js";
import { providerErrorDisposition } from "../src/model/sent-provider-failure.js";
import { validModelConfig } from "./helpers.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";

const HUB_BASE_URL = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];

function boundProfile(routeId: string, transport: ProviderTransport): BoundModelExecutionProfile {
  const apiFormat = transport === "anthropic-messages" ? "messages" : "chat_completions";
  const result: BoundModelExecutionProfile = {
    routeId,
    providerId: `provider-${routeId}`,
    baseUrl: `https://${routeId}.example.test/v1`,
    modelId: "model-under-test",
    transport,
    apiFormat,
    profile: {
      ...validModelConfig.profile,
      compatibility: {
        ...validModelConfig.profile.compatibility,
        apiFormats: [apiFormat],
      },
    },
    requestPolicy: validModelConfig.requestPolicy,
  };
  if (routeId !== "nvidia-api-catalog") return result;
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
    ...result,
    providerId: "nvidia-api-catalog",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    modelId: body.modelId,
    compositionRequestPolicy: { ...body, policySha256: canonicalDigest(body) },
    compositionPolicy: { maxProviderTurns: 4, timeoutMs: 300_000, maxResponseBytes: 65_536 },
  };
}

function nvidiaSse(model: string): Response {
  const body = [
    `data: ${JSON.stringify({ id: "capture", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "capture", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("createModelConnection", () => {
  it("runs under the provider-offline Vitest boundary", () => {
    expect(process.env.PI_OFFLINE).toBe("1");
  });

  it("registers the configured model without network access", async () => {
    const connection = await createModelConnection(validModelConfig);

    expect(connection.model.provider).toBe("test-provider");
    expect(connection.model.id).toBe("example/model");
    expect(connection.runtime.hasConfiguredAuth("test-provider")).toBe(true);
    expect(connection.model.contextWindow).toBe(128_000);
    expect(connection.model.maxTokens).toBe(16_384);
    expect(connection.model.reasoning).toBe(true);
    expect(connection.model.cost.input).toBe(1.25);
    expect(connection.model.cost.cacheWrite).toBe(0);
    expect(connection.reportUsageCost).toBe(false);
  });

  it("does not refresh an unrelated ambient OAuth credential when PI_OFFLINE is absent", async () => {
    const agentDirectory = await mkdtemp(join(tmpdir(), "docsfab-provider-auth-"));
    const priorAgentDirectory = process.env.PI_CODING_AGENT_DIR;
    const priorOffline = process.env.PI_OFFLINE;
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    try {
      await writeFile(
        join(agentDirectory, "auth.json"),
        `${JSON.stringify({
          anthropic: {
            type: "oauth",
            access: "synthetic-expired-access",
            refresh: "synthetic-expired-refresh",
            expires: 0,
          },
        })}\n`,
        { mode: 0o600 },
      );
      process.env.PI_CODING_AGENT_DIR = agentDirectory;
      delete process.env.PI_OFFLINE;
      globalThis.fetch = (async () => {
        fetchCalls += 1;
        throw new Error("ambient provider network is forbidden");
      }) as typeof fetch;

      await expect(createModelConnection(validModelConfig)).resolves.toMatchObject({
        reportUsageCost: false,
      });
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      if (priorAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = priorAgentDirectory;
      if (priorOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = priorOffline;
      await rm(agentDirectory, { recursive: true, force: true });
    }
  });

  it("rejects an assembled oversized request before provider I/O", async () => {
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("provider transport should not be invoked");
    }) as typeof fetch;
    try {
      const connection = await createModelConnection({
        ...validModelConfig,
        profile: {
          ...validModelConfig.profile,
          contextWindow: 8_192,
          maxInputTokens: 8_192,
          maxOutputTokens: 4_096,
        },
      });

      expect(() =>
        connection.runtime.streamSimple(connection.model, {
          systemPrompt: "x".repeat(16_500),
          messages: [],
        }),
      ).toThrow("Context budget exhausted before provider invocation");
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports cost only when current metadata supplies every rate", () => {
    expect(hasReportableUsageCost(validModelConfig)).toBe(false);
    expect(
      hasReportableUsageCost({
        ...validModelConfig,
        profile: {
          ...validModelConfig.profile,
          costPerMillionTokens: {
            ...validModelConfig.profile.costPerMillionTokens,
            cacheWrite: 0,
          },
        },
      }),
    ).toBe(true);
    expect(
      hasReportableUsageCost({
        ...validModelConfig,
        profile: {
          ...validModelConfig.profile,
          metadata: { ...validModelConfig.profile.metadata, status: "stale" },
          costPerMillionTokens: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      }),
    ).toBe(false);
  });

  it("rejects incompatible programmatic configurations before registration", async () => {
    await expect(
      createModelConnection({
        ...validModelConfig,
        profile: {
          ...validModelConfig.profile,
          compatibility: {
            ...validModelConfig.profile.compatibility,
            apiFormats: ["messages"],
          },
        },
      }),
    ).rejects.toThrow("incompatible with API format chat_completions");
  });
});

describe("createProviderConnectionFactory", () => {
  it.each([
    {
      routeId: "nvidia-inference-api",
      transport: "openai-chat-completions" as const,
      family: "nvidia-inference-api" as const,
      piApi: "openai-completions",
      authHeader: true,
    },
    {
      routeId: "nvidia-api-catalog",
      transport: "openai-chat-completions" as const,
      family: "nvidia-api-catalog" as const,
      piApi: "openai-completions",
      authHeader: true,
    },
    {
      routeId: "direct-openai",
      transport: "openai-responses" as const,
      family: "openai-api" as const,
      piApi: "openai-responses",
      authHeader: false,
    },
    {
      routeId: "direct-anthropic",
      transport: "anthropic-messages" as const,
      family: "anthropic-api" as const,
      piApi: "anthropic-messages",
      authHeader: false,
    },
  ])(
    "registers $transport with its transport-native authentication semantics",
    async ({ routeId, transport, family, piApi, authHeader }) => {
      const profile = boundProfile(routeId, transport);
      const fetchCalls: unknown[] = [];
      const factory = createProviderConnectionFactory({
        routeId,
        transport,
        fetch: async (...args) => {
          fetchCalls.push(args);
          throw new Error("provider-offline test forbids network access");
        },
      });

      const connection = await factory.create({
        profile,
        credential: { family, apiKey: "selected-provider-secret" },
      });

      expect(connection.model.api).toBe(piApi);
      expect(connection.runtime.getRegisteredProviderConfig(profile.providerId)).toMatchObject({
        api: piApi,
        authHeader,
      });
      expect(connection.runtime.hasConfiguredAuth(profile.providerId)).toBe(true);
      expect(fetchCalls).toHaveLength(0);
    },
  );

  it("rejects route, transport, and API-format drift without fallback", async () => {
    const profile = boundProfile("direct-openai", "openai-responses");
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
    });
    let wrongCredentialRead = false;
    const wrongCredential = {
      family: "anthropic-api" as ProviderCredentialFamily,
      get apiKey() {
        wrongCredentialRead = true;
        return "credential-must-not-be-read";
      },
    };

    await expect(
      factory.create({
        profile: { ...profile, routeId: "another-route" },
        credential: wrongCredential,
      }),
    ).rejects.toThrow("route does not match");
    await expect(
      factory.create({
        profile: { ...profile, transport: "anthropic-messages" },
        credential: wrongCredential,
      }),
    ).rejects.toThrow("transport does not match");
    await expect(
      factory.create({
        profile: { ...profile, apiFormat: "messages" },
        credential: { family: "openai-api", apiKey: "selected-provider-secret" },
      }),
    ).rejects.toThrow("API format does not match");
    expect(wrongCredentialRead).toBe(false);
  });

  it("runs a credential family over a transport an operator chose for its route", async () => {
    // The family stays bound to the route by the binder; the wire protocol is
    // a setting, so a preset's own key may travel over another transport.
    const profile = boundProfile("nvidia-inference-api", "openai-responses");
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
    });
    await expect(
      factory.create({
        profile,
        credential: { family: "nvidia-inference-api", apiKey: "selected-provider-secret" },
      }),
    ).resolves.toBeDefined();
  });

  it("finalizes and authorizes the exact NVIDIA payload before provider fetch", async () => {
    const profile = boundProfile("nvidia-api-catalog", "openai-chat-completions");
    const order: string[] = [];
    const requestBodies: Array<Record<string, unknown>> = [];
    const finalizedTurns: Array<Record<string, unknown>> = [];
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async (_input, init) => {
        order.push("fetch");
        requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return nvidiaSse(profile.modelId);
      },
    });
    const connection = await factory.create(
      {
        profile,
        credential: { family: "nvidia-api-catalog", apiKey: "selected-provider-secret" },
      },
      {
        evidenceIdentity: { repositoryRevision: "a".repeat(40) },
        toolChoice: () => "required",
        beforeProviderTurn(turn) {
          order.push("preflight");
          finalizedTurns.push(structuredClone(turn) as unknown as Record<string, unknown>);
        },
      },
    );

    const stream = connection.runtime.streamSimple(
      connection.model,
      {
        systemPrompt: DOCSFAB_SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
        tools: [
          {
            name: "read",
            description: "Read one governed file.",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
      },
      {
        maxTokens: 64,
        temperature: 0.8,
        toolChoice: "auto",
        onPayload(payload) {
          order.push("prior-hook");
          return { ...(payload as Record<string, unknown>), temperature: 0.9, top_p: 0.2 };
        },
      },
    );
    for await (const _event of stream) {
      // Consumption drives Pi's lazy onPayload and provider fetch.
    }

    expect(order).toEqual(["prior-hook", "preflight", "fetch"]);
    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).toMatchObject({
      model: profile.modelId,
      temperature: 0,
      top_p: 1,
      max_tokens: 64,
      tool_choice: "required",
    });
    const messages = requestBodies[0]?.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({
      role: "system",
      content: `/no_think\n${DOCSFAB_SYSTEM_PROMPT}`,
    });
    expect(finalizedTurns).toHaveLength(1);
    expect(finalizedTurns[0]?.requestPolicySha256).toBe(
      profile.compositionRequestPolicy?.policySha256,
    );
    expect(finalizedTurns[0]?.finalPayloadSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(connection.turnGovernance?.evidence()[0]?.finalPayloadSha256).toBe(
      finalizedTurns[0]?.finalPayloadSha256,
    );
  });

  it("does not forward the recovery-only tool choice on the OpenAI Responses transport", async () => {
    const profile = boundProfile("direct-openai", "openai-responses");
    let requestBody: Record<string, unknown> | undefined;
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const connection = await factory.create(
      { profile, credential: { family: "openai-api", apiKey: "selected-provider-secret" } },
      {
        evidenceIdentity: { repositoryRevision: "c".repeat(40) },
        toolChoice: () => "required",
      },
    );
    try {
      await connection.runtime
        .streamSimple(
          connection.model,
          {
            systemPrompt: DOCSFAB_SYSTEM_PROMPT,
            messages: [
              { role: "user", content: "Continue the records-only recovery.", timestamp: 1 },
            ],
            tools: [],
          },
          { maxTokens: 64 },
        )
        .result();
    } catch {
      // The synthetic body is not a complete Responses event stream. The
      // assertion below concerns dispatch behavior before response parsing.
    }

    expect(requestBody).toBeDefined();
    expect(requestBody).not.toHaveProperty("tool_choice");
  });

  it("lets the final host lease stop NVIDIA egress before fetch", async () => {
    const profile = boundProfile("nvidia-api-catalog", "openai-chat-completions");
    let fetchCalls = 0;
    let leaseCalls = 0;
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async () => {
        fetchCalls += 1;
        return nvidiaSse(profile.modelId);
      },
    });
    const connection = await factory.create(
      {
        profile,
        credential: { family: "nvidia-api-catalog", apiKey: "selected-provider-secret" },
      },
      {
        evidenceIdentity: { repositoryRevision: "b".repeat(40) },
        beforeProviderTurn() {
          leaseCalls += 1;
          throw new Error("synthetic lease boundary");
        },
      },
    );
    const stream = connection.runtime.streamSimple(connection.model, {
      systemPrompt: DOCSFAB_SYSTEM_PROMPT,
      messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
      tools: [],
    });
    for await (const _event of stream) {
      // The provider library projects the local hook failure into its event stream.
    }
    expect(leaseCalls).toBe(1);
    expect(fetchCalls).toBe(0);
  });

  it.each([
    ["nvidia-api-catalog", "openai-chat-completions", "nvidia-api-catalog", "max_tokens"],
    ["direct-openai", "openai-responses", "openai-api", "max_output_tokens"],
    ["direct-anthropic", "anthropic-messages", "anthropic-api", "max_tokens"],
  ] as const)(
    "rejects final %s output expansion beyond the exact turn authority",
    async (routeId, transport, family, outputField) => {
      const profile = boundProfile(routeId, transport);
      let fetchCalls = 0;
      const factory = createProviderConnectionFactory({
        routeId,
        transport,
        fetch: async () => {
          fetchCalls += 1;
          throw new Error("provider fetch must not run");
        },
      });
      const connection = await factory.create(
        {
          profile,
          credential: { family, apiKey: "selected-provider-secret" },
        },
        { evidenceIdentity: { repositoryRevision: "c".repeat(40) } },
      );
      const stream = connection.runtime.streamSimple(
        connection.model,
        {
          systemPrompt:
            routeId === "nvidia-api-catalog"
              ? DOCSFAB_SYSTEM_PROMPT
              : "Provider-neutral direct route.",
          messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
          tools: [],
        },
        {
          maxTokens: 64,
          onPayload(payload) {
            return {
              ...(payload as Record<string, unknown>),
              [outputField]: 1024,
            };
          },
        },
      );
      for await (const _event of stream) {
        // Consume the projected local policy failure.
      }
      expect(fetchCalls).toBe(0);
    },
  );

  it.each([
    ["nvidia-inference-api", "openai-chat-completions", "nvidia-inference-api"],
    ["direct-openai", "openai-responses", "openai-api"],
    ["direct-anthropic", "anthropic-messages", "anthropic-api"],
  ] as const)("applies C-04 before %s provider I/O", async (routeId, transport, family) => {
    let fetchCalls = 0;
    const profile = boundProfile(routeId, transport);
    const factory = createProviderConnectionFactory({
      routeId,
      transport,
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("provider transport should not be invoked");
      },
    });
    const connection = await factory.create({
      profile,
      credential: { family, apiKey: "provider-key-not-pattern-shaped" },
    });

    expect(() =>
      connection.runtime.streamSimple(connection.model, {
        systemPrompt: "Provider-neutral C-04 test.",
        messages: [
          {
            role: "user",
            content: "provider-key-not-pattern-shaped",
            timestamp: 1,
          },
        ],
      }),
    ).toThrow("governed credential-isolation boundary");
    expect(fetchCalls).toBe(0);
  });
});

describe("retired Switchyard tool reasoning workaround", () => {
  // The GPT-5.6 Sol id retired (#1512) and the workaround that forced
  // `reasoning_effort: "none"` on its tool requests went with it. The
  // configuration boundary is where the model id now stops.
  it("refuses to configure the retired Switchyard GPT-5.6 Sol model id at all", () => {
    for (const [prefix, variable] of [
      ["MODEL", "MODEL_ID"],
      ["JUDGE", "JUDGE_MODEL_ID"],
    ] as const) {
      let caught: unknown;
      try {
        parseModelEndpoint({ [variable]: "switchyard/openai/gpt-5.6-sol" }, prefix);
      } catch (error) {
        caught = error;
      }
      expect(caught, prefix).toBeInstanceOf(ModelCompositionError);
      expect((caught as ModelCompositionError).code).toBe("composition-retired");
      expect((caught as ModelCompositionError).nextAction).toContain(
        "`docsfab setup --profile nvidia-inference-gpt-6-sol-pi`",
      );
    }
  });

  // A hand-built bound profile bypasses configuration, so this still proves
  // the connection adds nothing on its own: the payload is exactly what the
  // caller built, with no injected `reasoning_effort`.
  it.each([
    { name: "omitted effort", effort: undefined, tools: true, expected: undefined },
    { name: "explicit effort", effort: "medium", tools: true, expected: "medium" },
    {
      name: "credential-contaminated effort",
      effort: "test-key",
      tools: true,
      expected: undefined,
      blocked: true,
    },
    { name: "no tools", effort: "medium", tools: false, expected: "medium" },
    {
      name: "another model",
      effort: "medium",
      tools: true,
      modelId: "azure/openai/gpt-5.6-sol",
      expected: "medium",
    },
    {
      name: "another origin",
      effort: "medium",
      tools: true,
      baseUrl: "https://inference.example.test/v1",
      expected: "medium",
    },
  ])("preserves the admitted request boundary for $name", async (row) => {
    const profile = boundProfile("nvidia-inference-api", "openai-chat-completions");
    profile.modelId = row.modelId ?? "switchyard/openai/gpt-5.6-sol";
    profile.baseUrl = row.baseUrl ?? HUB_BASE_URL;
    profile.profile.compatibility.supportsReasoningEffort = false;
    const requests: Record<string, unknown>[] = [];
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return nvidiaSse(profile.modelId);
      },
    });
    const connection = await factory.create(
      { profile, credential: { family: "nvidia-inference-api", apiKey: "test-key" } },
      { evidenceIdentity: { repositoryRevision: "a".repeat(40) } },
    );
    const result = await connection.runtime
      .streamSimple(
        connection.model,
        {
          messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
          tools: row.tools
            ? [
                {
                  name: "read",
                  description: "Read a repository file.",
                  parameters: { type: "object", properties: {} },
                },
              ]
            : [],
        },
        {
          reasoning: "medium",
          maxTokens: 64,
          onPayload: (payload) => ({
            ...(payload as Record<string, unknown>),
            ...(row.effort ? { reasoning_effort: row.effort } : {}),
          }),
        },
      )
      .result();

    if (row.blocked) {
      expect(result.stopReason).toBe("error");
      expect(requests).toHaveLength(0);
      return;
    }
    expect(result.stopReason).toBe("stop");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: profile.modelId });
    if (row.expected === undefined) {
      expect(requests[0]).not.toHaveProperty("reasoning_effort");
    } else {
      expect(requests[0]?.reasoning_effort).toBe(row.expected);
    }
    expect(connection.turnGovernance?.evidence()[0]?.finalPayloadSha256).toBe(
      canonicalDigest(requests[0]),
    );
  });
});

describe("policy-carrying routes", () => {
  // `boundProfile` returns early for every route but nvidia-api-catalog, so
  // the nvidia-inference-api rows above run with compositionRequestPolicy
  // undefined. These pin all four legs of the relaxed rule.
  function inferencePolicy(routeId: "nvidia-api-catalog" | "nvidia-inference-api") {
    const body = {
      schemaVersion: 1 as const,
      modelId: "nvidia/nvidia/nemotron-3-super-v3",
      routeId,
      deploymentIdentitySha256: "b".repeat(64),
      transport: "openai-chat-completions" as const,
      reasoningMode: "disabled" as const,
      reasoningControl: { kind: "chat-template-kwarg" as const, thinking: false as const },
      installedSystemInstructionSha256: DOCSFAB_SYSTEM_PROMPT_SHA256,
      temperature: 0 as const,
      topP: 1 as const,
    };
    return { ...body, policySha256: canonicalDigest(body) };
  }

  function connect(input: {
    routeId: "nvidia-api-catalog" | "nvidia-inference-api";
    policyRoute?: "nvidia-api-catalog" | "nvidia-inference-api";
    family: "nvidia-api-catalog" | "nvidia-inference-api";
  }) {
    // boundProfile attaches a policy for the catalog route, so strip it when the
    // case under test is "policy absent"; otherwise that leg is unreachable.
    const { compositionRequestPolicy: _drop, ...base } = boundProfile(
      input.routeId,
      "openai-chat-completions",
    );
    const factory = createProviderConnectionFactory({
      routeId: input.routeId,
      transport: "openai-chat-completions",
      fetch: async () => nvidiaSse("nvidia/nvidia/nemotron-3-super-v3"),
    });
    return factory.create({
      profile: {
        ...base,
        providerId: input.routeId,
        baseUrl: HUB_BASE_URL,
        modelId: "nvidia/nvidia/nemotron-3-super-v3",
        ...(input.policyRoute
          ? { compositionRequestPolicy: inferencePolicy(input.policyRoute) }
          : {}),
      },
      credential: { family: input.family, apiKey: "test-key" },
    });
  }

  it("accepts a policy whose route matches the connection route", async () => {
    await expect(
      connect({
        routeId: "nvidia-inference-api",
        policyRoute: "nvidia-inference-api",
        family: "nvidia-inference-api",
      }),
    ).resolves.toBeDefined();
  });

  it("rejects a policy declared for a different route than the connection", async () => {
    await expect(
      connect({
        routeId: "nvidia-inference-api",
        policyRoute: "nvidia-api-catalog",
        family: "nvidia-inference-api",
      }),
    ).rejects.toThrow(/request policy does not match the selected route/u);
  });

  it("permits an omitted-mode connection with no policy on nvidia-inference-api", async () => {
    // Requiring a policy here would break every ordinary omitted-mode run on this
    // route. Presence is the composition contract's job, not the provider's.
    await expect(
      connect({ routeId: "nvidia-inference-api", family: "nvidia-inference-api" }),
    ).resolves.toBeDefined();
  });

  it("runs a connection with no policy on nvidia-api-catalog", async () => {
    // A preset on the catalog runs without its policy when the operator
    // changes its model or reasoning; the binder warns about it.
    await expect(
      connect({ routeId: "nvidia-api-catalog", family: "nvidia-api-catalog" }),
    ).resolves.toBeDefined();
  });
});

/**
 * The Inference Hub's LiteLLM chat-completions front door forwards
 * `tools[].function.strict` into a Bedrock tool spec that has no such field and
 * refuses the whole request (400, invalid-request, no retry).
 *
 * pi-ai adds the field to every tools-bearing request unless the registered
 * model's compat block says otherwise. DocsFab can emit only `false`: no
 * DocsFab tool declares `constrainedSampling`, and `PI_EXPERIMENTAL` (which
 * turns it on for Pi's own tools) is not set here, so
 * `resolveJsonSchemaStrictSampling` returns `undefined` and the `?? false`
 * fallback applies. An always-false field changes nothing for a provider that
 * accepts it, so it is dropped for every route.
 */
describe("provider tool strict compatibility", () => {
  const PILOT_MODEL_ID = "aws/anthropic/bedrock-claude-sonnet-5";
  /** The exact front-door body, from a run record. */
  const BEDROCK_STRICT_REJECTION =
    'litellm.BadRequestError: BedrockException - {"message":"The model returned the following errors: tools.0.custom.strict: Extra inputs are not permitted"}';

  function pilotProfile(): BoundModelExecutionProfile {
    const profile = boundProfile("nvidia-inference-api", "openai-chat-completions");
    profile.modelId = PILOT_MODEL_ID;
    profile.baseUrl = HUB_BASE_URL;
    return profile;
  }

  function pilotTool(constrainedSampling?: {
    type: "json_schema";
    strict: "require" | "prefer";
  }): Record<string, unknown> {
    return {
      name: "read",
      description: "Read one governed repository file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      ...(constrainedSampling ? { constrainedSampling } : {}),
    };
  }

  /** The tool declarations of the one request the turn sent. */
  function sentTools(requests: Record<string, unknown>[]): Array<Record<string, unknown>> {
    const [request] = requests;
    expect(request).toBeDefined();
    return (request?.tools ?? []) as Array<Record<string, unknown>>;
  }

  async function streamOneTurn(input: {
    profile?: BoundModelExecutionProfile;
    tools?: Record<string, unknown>[];
    respond?: () => Response;
    /**
     * Zero the in-turn replay's backoff only, leaving its attempt and total
     * budgets at their catalog defaults, so an unwanted replay happens at once
     * and is counted rather than hidden behind the shipped delay.
     */
    instantReplay?: boolean;
  }) {
    const profile = input.profile ?? pilotProfile();
    const requests: Record<string, unknown>[] = [];
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return input.respond ? input.respond() : nvidiaSse(profile.modelId);
      },
    });
    const connection = await factory.create(
      { profile, credential: { family: "nvidia-inference-api", apiKey: "test-key" } },
      {
        evidenceIdentity: { repositoryRevision: "a".repeat(40) },
        ...(input.instantReplay ? { providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 } } : {}),
      },
    );
    const result = await connection.runtime
      .streamSimple(
        connection.model,
        {
          systemPrompt: DOCSFAB_SYSTEM_PROMPT,
          messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
          tools: (input.tools ?? [pilotTool()]) as never,
        },
        { maxTokens: 64 },
      )
      .result();
    return { requests, result, connection };
  }

  it("sends no strict flag on a tool declaration to the pilot Bedrock route", async () => {
    const { requests } = await streamOneTurn({});

    const tools = sentTools(requests);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.function).not.toHaveProperty("strict");
  });

  it("still sends the whole tool declaration, and hashes exactly what it sent", async () => {
    const { requests, result, connection } = await streamOneTurn({});

    expect(result.stopReason).toBe("stop");
    expect(requests).toHaveLength(1);
    expect(sentTools(requests)[0]).toEqual({
      type: "function",
      function: {
        name: "read",
        description: "Read one governed repository file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    });
    expect(connection.turnGovernance?.evidence()[0]?.finalPayloadSha256).toBe(
      canonicalDigest(requests[0]),
    );
  });

  it("refuses a tool that REQUIRES strict sampling rather than sending it unconstrained", async () => {
    // The adjacent condition the flag must not silently swallow: a tool whose
    // `constrainedSampling.strict` is "require" cannot be served by a route that
    // takes no strict flag, and pi-ai refuses it by name. No DocsFab tool
    // declares that, but if one arrives this must stay loud.
    const { requests, result } = await streamOneTurn({
      tools: [pilotTool({ type: "json_schema", strict: "require" })],
    });

    expect(result.stopReason).toBe("error");
    expect(String((result as { errorMessage?: unknown }).errorMessage)).toContain(
      'Tool "read" requires JSON-schema constrained sampling, but strict tools are unsupported.',
    );
    expect(requests).toHaveLength(0);
  });

  it("keeps a strict-shaped 400 from the front door terminal and unretried", async () => {
    const { requests, result, connection } = await streamOneTurn({
      instantReplay: true,
      respond: () =>
        new Response(JSON.stringify({ error: { message: BEDROCK_STRICT_REJECTION } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    });

    expect(result.stopReason).toBe("error");
    expect(requests).toHaveLength(1);
    const exchange = connection.providerTransport?.lastExchange();
    expect(exchange).toMatchObject({ sent: true, httpStatus: 400 });
    const telemetry = observeLandedProviderTurn(result as object, exchange);
    expect(telemetry.providerError).toEqual({ class: "invalid-request", httpStatus: 400 });
    expect(providerErrorDisposition(telemetry.providerError)).toEqual({
      category: "invalid-request",
      retryable: false,
    });
  });

  it("sends no strict flag through the installed request policy either", async () => {
    const profile = pilotProfile();
    const body = {
      schemaVersion: 1 as const,
      modelId: PILOT_MODEL_ID,
      routeId: "nvidia-inference-api" as const,
      deploymentIdentitySha256: "c".repeat(64),
      transport: "openai-chat-completions" as const,
      reasoningMode: "disabled" as const,
      reasoningControl: { kind: "chat-template-kwarg" as const, thinking: false as const },
      installedSystemInstructionSha256: DOCSFAB_SYSTEM_PROMPT_SHA256,
      temperature: 0 as const,
      topP: 1 as const,
    };
    const { requests, result, connection } = await streamOneTurn({
      profile: {
        ...profile,
        providerId: "nvidia-inference-api",
        compositionRequestPolicy: { ...body, policySha256: canonicalDigest(body) },
      },
    });

    expect(result.stopReason).toBe("stop");
    expect(requests).toHaveLength(1);
    // Count first: a policy that dropped the tools entirely would satisfy
    // "no strict property" without proving anything.
    expect(sentTools(requests)).toHaveLength(1);
    const [sentTool] = sentTools(requests);
    expect(sentTool?.function).not.toHaveProperty("strict");
    // The policy hashes the payload as sent, so a preserved `strict` would be a
    // different run: attribution holds by construction.
    const digest = connection.turnGovernance?.evidence()[0]?.finalPayloadSha256;
    expect(digest).toBe(canonicalDigest(requests[0]));
    const withStrict = structuredClone(requests[0]) as {
      tools: Array<{ function: Record<string, unknown> }>;
    };
    withStrict.tools[0]!.function.strict = false;
    expect(canonicalDigest(withStrict)).not.toBe(digest);
  });
});

/**
 * A turn with earlier tool calls and results but no `tools` makes pi-ai send
 * `tools: []`, which the Inference Hub front door refuses with HTTP 400
 * (`litellm.UnsupportedParamsError: Bedrock doesn't support tool calling
 * without tools= param specified`), not retried. The omitted-`tools` shape
 * fails the same guard. A scripted `fetch` accepts both, so both payload
 * finalizers refuse the shape locally, by name, before anything is sent.
 */
describe("provider tool history without tools", () => {
  const PILOT_MODEL_ID = "aws/anthropic/bedrock-claude-sonnet-5";
  const HISTORY_CALL_ID = "call-history-1";

  function pilotProfile(): BoundModelExecutionProfile {
    const profile = boundProfile("nvidia-inference-api", "openai-chat-completions");
    profile.modelId = PILOT_MODEL_ID;
    profile.baseUrl = HUB_BASE_URL;
    return profile;
  }

  function readTool(): Record<string, unknown> {
    return {
      name: "read",
      description: "Read one governed repository file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    };
  }

  /** One earlier turn that called `read`, its result, and the next user ask. */
  function toolHistory(profile: BoundModelExecutionProfile): unknown[] {
    return [
      { role: "user", content: "Read README.md.", timestamp: 1 },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: HISTORY_CALL_ID,
            name: "read",
            arguments: { path: "README.md" },
          },
        ],
        api: "openai-completions",
        provider: profile.providerId,
        model: profile.modelId,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: HISTORY_CALL_ID,
        toolName: "read",
        content: [{ type: "text", text: "# Fixture" }],
        isError: false,
        timestamp: 3,
      },
      { role: "user", content: "Return the final answer now.", timestamp: 4 },
    ];
  }

  async function streamOneTurn(input: {
    profile: BoundModelExecutionProfile;
    family: "nvidia-inference-api" | "nvidia-api-catalog";
    history: boolean;
    tools?: Record<string, unknown>[];
    /** Rewrites the serialized payload before the finalizer sees it. */
    rewrite?: (payload: Record<string, unknown>) => Record<string, unknown>;
  }) {
    const requests: Record<string, unknown>[] = [];
    let payloadHookCalls = 0;
    const factory = createProviderConnectionFactory({
      routeId: input.profile.routeId,
      transport: input.profile.transport,
      fetch: async (_request, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return nvidiaSse(input.profile.modelId);
      },
    });
    const connection = await factory.create(
      { profile: input.profile, credential: { family: input.family, apiKey: "test-key" } },
      {
        evidenceIdentity: { repositoryRevision: "e".repeat(40) },
        // Backoff zeroed, attempt budgets left at their catalog defaults, so an
        // unwanted replay would happen at once and be seen.
        providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 },
      },
    );
    const result = await connection.runtime
      .streamSimple(
        connection.model,
        {
          systemPrompt: DOCSFAB_SYSTEM_PROMPT,
          messages: (input.history
            ? toolHistory(input.profile)
            : [{ role: "user", content: "Reply OK.", timestamp: 1 }]) as never,
          ...(input.tools ? { tools: input.tools as never } : {}),
        },
        {
          maxTokens: 64,
          onPayload: (payload) => {
            payloadHookCalls += 1;
            const record = payload as Record<string, unknown>;
            return input.rewrite ? input.rewrite({ ...record }) : undefined;
          },
        },
      )
      .result();
    return { requests, result, connection, payloadHookCalls: () => payloadHookCalls };
  }

  const errorText = (result: unknown): string =>
    String((result as { errorMessage?: unknown }).errorMessage);

  const withoutTools = (payload: Record<string, unknown>) => {
    const { tools: _tools, ...rest } = payload;
    return rest;
  };

  it.each([
    ["the empty array pi-ai inserts", undefined],
    ["an omitted field", withoutTools],
  ] as const)(
    "refuses tool history sent with %s before anything is sent",
    async (_label, rewrite) => {
      const { requests, result, payloadHookCalls } = await streamOneTurn({
        profile: pilotProfile(),
        family: "nvidia-inference-api",
        history: true,
        ...(rewrite ? { rewrite } : {}),
      });

      expect(requests).toHaveLength(0);
      expect(result.stopReason).toBe("error");
      expect(errorText(result)).toContain(
        "Provider request rejected by the installed request policy (tool-history-without-tools:",
      );
      // The exact condition, by message position and tools state, and nothing from
      // the conversation itself.
      expect(errorText(result)).toContain("message 2 is a tool call");
      expect(errorText(result)).not.toContain("README.md");
      // DocsFab's own refusal is deterministic: not replayed in the turn and not
      // retried by the step.
      expect(payloadHookCalls()).toBe(1);
      expect(classifyModelFailure(errorText(result))).toEqual({
        category: "provider-terminal",
        retryable: false,
      });
    },
  );

  it("sends the same tool history once when it carries the tools, and hashes what it sent", async () => {
    // The positive control: the ordinary tools-bearing turn the route accepts.
    const { requests, result, connection } = await streamOneTurn({
      profile: pilotProfile(),
      family: "nvidia-inference-api",
      history: true,
      tools: [readTool()],
    });

    expect(result.stopReason).toBe("stop");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools).toHaveLength(1);
    const roles = ((requests[0]?.messages ?? []) as Array<{ role?: unknown }>).map(
      ({ role }) => role,
    );
    expect(roles).toContain("tool");
    expect(connection.turnGovernance?.evidence()[0]?.finalPayloadSha256).toBe(
      canonicalDigest(requests[0]),
    );
  });

  it.each([
    ["no tools field", undefined],
    ["an empty tools array", (payload: Record<string, unknown>) => ({ ...payload, tools: [] })],
  ] as const)(
    "keeps a first-turn request with %s and no tool history legal",
    async (_label, rewrite) => {
      // The adjacent condition the refusal must not handle: nothing in the
      // conversation is a tool call or a tool result.
      const { requests, result } = await streamOneTurn({
        profile: pilotProfile(),
        family: "nvidia-inference-api",
        history: false,
        ...(rewrite ? { rewrite } : {}),
      });

      expect(result.stopReason).toBe("stop");
      expect(requests).toHaveLength(1);
      expect(Array.isArray(requests[0]?.tools) ? requests[0]?.tools : []).toHaveLength(0);
    },
  );

  it("refuses the same shape through the installed request policy, and sends it with tools", async () => {
    const profile = boundProfile("nvidia-api-catalog", "openai-chat-completions");

    const refused = await streamOneTurn({ profile, family: "nvidia-api-catalog", history: true });
    expect(refused.requests).toHaveLength(0);
    expect(errorText(refused.result)).toContain("(tool-history-without-tools:");

    const sent = await streamOneTurn({
      profile,
      family: "nvidia-api-catalog",
      history: true,
      tools: [readTool()],
    });
    expect(sent.result.stopReason).toBe("stop");
    expect(sent.requests).toHaveLength(1);
    expect(sent.requests[0]?.tools).toHaveLength(1);
    expect(sent.connection.turnGovernance?.evidence()[0]?.finalPayloadSha256).toBe(
      canonicalDigest(sent.requests[0]),
    );

    // The policy always sends the array, so its first turn goes out as `[]`.
    const firstTurn = await streamOneTurn({
      profile,
      family: "nvidia-api-catalog",
      history: false,
    });
    expect(firstTurn.result.stopReason).toBe("stop");
    expect(firstTurn.requests).toHaveLength(1);
    expect(firstTurn.requests[0]?.tools).toEqual([]);
  });
});

describe("a 2xx stream that closes before it finishes (#1696)", () => {
  const sse = (events: readonly string[]) =>
    new Response(events.join(""), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

  async function closeMidAnswer(
    routeId: string,
    transport: ProviderTransport,
    family: ProviderCredentialFamily,
    body: (modelId: string) => Response,
  ) {
    // Reasoning off, as the binder binds it for a model without adaptive
    // thinking: the bound profile decides whether a request thinks.
    const bound = boundProfile(routeId, transport);
    const profile = { ...bound, profile: { ...bound.profile, reasoning: false } };
    const factory = createProviderConnectionFactory({
      routeId,
      transport,
      fetch: async () => body(profile.modelId),
    });
    const connection = await factory.create(
      { profile, credential: { family, apiKey: "selected-provider-secret" } },
      {
        evidenceIdentity: { repositoryRevision: "f".repeat(40) },
        providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 1 },
      },
    );
    const result = await connection.runtime
      .streamSimple(
        connection.model,
        {
          systemPrompt: DOCSFAB_SYSTEM_PROMPT,
          messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
          tools: [],
        },
        { maxTokens: 64 },
      )
      .result();
    const exchange = connection.providerTransport?.lastExchange();
    return { result, exchange, observed: observeLandedProviderTurn(result as object, exchange) };
  }

  it("records stream-incomplete through the installed composition route's response boundary", async () => {
    const { result, exchange, observed } = await closeMidAnswer(
      "nvidia-api-catalog",
      "openai-chat-completions",
      "nvidia-api-catalog",
      (model) =>
        sse([
          `data: ${JSON.stringify({
            id: "c",
            object: "chat.completion.chunk",
            created: 1,
            model,
            choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
          })}\n\n`,
        ]),
    );
    expect(result.stopReason).toBe("error");
    expect(exchange).toEqual({ sent: true, streamClosedBeforeDone: true, bodyReceived: true });
    expect(observed.providerError).toEqual({ class: "stream-incomplete" });
  });

  it("leaves an Anthropic stream that ends before message_stop unclassified", async () => {
    // Anthropic streams never send [DONE]; their end marker is not observed.
    const { result, exchange, observed } = await closeMidAnswer(
      "direct-anthropic",
      "anthropic-messages",
      "anthropic-api",
      (model) =>
        sse([
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: {
              id: "m",
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          })}\n\n`,
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "partial" },
          })}\n\n`,
        ]),
    );
    expect(result.stopReason).toBe("error");
    expect(exchange).toEqual({ sent: true, bodyReceived: true });
    expect(observed.providerError).toEqual({ class: "unknown" });
  });
});
