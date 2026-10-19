// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseSetupArguments } from "../src/cli/commands/setup.js";
import { MODEL_PROVIDERS, type ModelProviderOption } from "../src/config/model-providers.js";
import { loadConfig } from "../src/config/runtime-loader.js";
import { ModelCompositionError } from "../src/model-composition/types.js";
import { resolveOperatorExecutionBinding } from "../src/model/operator-execution-binding.js";
import { createProviderConnectionFactory } from "../src/model/provider.js";
import type { ProviderTransport } from "../src/model/configuration.js";
import { formatSetupBootstrapResult, runSetupBootstrap } from "../src/setup/bootstrap.js";
import { runInteractiveSetup } from "../src/setup/interactive.js";
import { buildPolicyProfileFromEndpoint } from "../src/setup/split-layout-presets.js";
import { sealedCompositionContextWindow } from "./helpers/installed-composition-limits.js";
import { temporaryRoots } from "./helpers/temp.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";

const HUB_BASE_URL = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];

const roots = temporaryRoots();

/** An internal Inference Hub route that is also a closed setup preset. */
const HUB_PRESET_ROUTE = {
  modelId: "nvidia/nvidia/nemotron-3-super-v3",
  baseUrl: HUB_BASE_URL,
  compositionId: "nvidia-inference-nemotron-3-super-v3-pi",
} as const;

function configurationRoot(): Promise<string> {
  return roots.create("docsfab-public-provider-");
}

function sse(events: Record<string, unknown>[]): Response {
  return new Response(
    events
      .map(
        (event) =>
          `${event.type ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** Wire fixtures for a native tool call followed by an answer using its result. */
function reply(transport: ProviderTransport, model: string, tool: boolean): Response {
  if (transport === "anthropic-messages") {
    return sse([
      {
        type: "message_start",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model,
          content: [],
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: tool
          ? { type: "tool_use", id: "call_read", name: "read_document", input: {} }
          : { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: tool
          ? { type: "input_json_delta", partial_json: '{"path":"README.md"}' }
          : { type: "text_delta", text: "Reviewed the document." },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: tool ? "tool_use" : "end_turn" },
        usage: { output_tokens: 10 },
      },
      { type: "message_stop" },
    ]);
  }
  if (transport === "openai-responses") {
    const item = tool
      ? {
          type: "function_call",
          id: "fc_read",
          call_id: "call_read",
          name: "read_document",
          arguments: '{"path":"README.md"}',
        }
      : {
          type: "message",
          id: "msg_test",
          role: "assistant",
          content: [{ type: "output_text", text: "Reviewed the document.", annotations: [] }],
        };
    return sse([
      {
        type: "response.created",
        response: { id: "resp_test", model, status: "in_progress", output: [] },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, ...(tool ? { arguments: "" } : { content: [] }) },
      },
      ...(tool
        ? [
            {
              type: "response.function_call_arguments.delta",
              output_index: 0,
              item_id: "fc_read",
              delta: '{"path":"README.md"}',
            },
          ]
        : [
            {
              type: "response.output_text.delta",
              output_index: 0,
              content_index: 0,
              item_id: "msg_test",
              delta: "Reviewed the document.",
            },
          ]),
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: "resp_test",
          model,
          status: "completed",
          output: [item],
          usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
        },
      },
    ]);
  }
  return sse([
    {
      id: "chat_test",
      object: "chat.completion.chunk",
      model,
      created: 1,
      choices: [
        {
          index: 0,
          delta: tool
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_read",
                    type: "function",
                    function: { name: "read_document", arguments: '{"path":"README.md"}' },
                  },
                ],
              }
            : { role: "assistant", content: "Reviewed the document." },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chat_test",
      object: "chat.completion.chunk",
      model,
      created: 1,
      choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    },
  ]);
}

describe("public provider configuration", () => {
  describe.each(["model-profile", "composition"] as const)("%s path requests", (mode) => {
    it.each([
      ["openai", "openai-responses", "https://api.openai.com/v1", "/v1/responses"],
      ["openai", "openai-chat-completions", "https://api.openai.com/v1", "/v1/chat/completions"],
      [
        "openai-compatible",
        "openai-chat-completions",
        "https://gateway.example.test/custom/v1",
        "/custom/v1/chat/completions",
      ],
      [
        "openai-compatible",
        "openai-responses",
        "https://gateway.example.test/custom/v1",
        "/custom/v1/responses",
      ],
      ["anthropic", "anthropic-messages", "https://api.anthropic.com", "/v1/messages"],
      [
        "anthropic-compatible",
        "anthropic-messages",
        "https://gateway.example.test/v1",
        "/v1/messages",
      ],
      [
        "anthropic-compatible",
        "anthropic-messages",
        "https://gateway.example.test/custom",
        "/custom/v1/messages",
      ],
      [
        "anthropic-compatible",
        "anthropic-messages",
        "https://gateway.example.test/custom/v1",
        "/custom/v1/messages",
      ],
      [
        "anthropic-compatible",
        "anthropic-messages",
        "https://gateway.example.test/custom/v1/",
        "/custom/v1/messages",
      ],
      // A pasted request URL keeps one API path, not two.
      [
        "openai-compatible",
        "openai-responses",
        "https://gateway.example.test/custom/v1/responses",
        "/custom/v1/responses",
      ],
      [
        "openai-compatible",
        "openai-chat-completions",
        "https://gateway.example.test/custom/v1/chat/completions/",
        "/custom/v1/chat/completions",
      ],
      [
        "anthropic-compatible",
        "anthropic-messages",
        "https://gateway.example.test/custom/v1/messages",
        "/custom/v1/messages",
      ],
    ] as const)(
      "reloads %s with %s at %s and completes a streaming tool round trip",
      async (provider, transport, baseUrl, expectedPath) => {
        const root = await configurationRoot();
        const secret = "provider-test-placeholder";
        const envName = MODEL_PROVIDERS[provider].credentialEnv;
        const result = await runSetupBootstrap({
          model: { provider, transport, baseUrl, modelId: "model-under-test" },
          environment: { DOCSFAB_CONFIG_ROOT: root, [envName]: secret },
        });
        expect(result.status).toBe("ready");
        expect(formatSetupBootstrapResult(result)).not.toContain(secret);
        const expectedQuery = transport === "anthropic-messages" ? "?beta=true" : "";
        const expectedUrl = `${new URL(baseUrl).origin}${expectedPath}${expectedQuery}`;
        expect(result.profile?.requestUrl).toBe(expectedUrl);
        expect(formatSetupBootstrapResult(result)).toContain(`Request URL: ${expectedUrl}`);
        const config = loadConfig({
          DOCSFAB_CONFIG_ROOT: root,
          MODEL_API_KEY: "unrelated-old-key",
        });
        const bound = await resolveOperatorExecutionBinding({
          model: config.model,
          environment: {},
        });
        expect(bound.profile.transport).toBe(transport);
        expect(bound.credential.apiKey).toBe(secret);
        const requests: Array<{ url: URL; headers: Headers; body: Record<string, unknown> }> = [];
        const connection = await createProviderConnectionFactory({
          routeId: bound.profile.routeId,
          transport,
          fetch: async (url, init) => {
            requests.push({
              url: new URL(String(url)),
              headers: new Headers(init?.headers),
              body: JSON.parse(String(init?.body)),
            });
            return reply(transport, config.model.modelId, requests.length === 1);
          },
        }).create(
          mode === "composition"
            ? {
                ...bound,
                profile: {
                  ...bound.profile,
                  compositionPolicy: {
                    maxProviderTurns: 4,
                    timeoutMs: 300_000,
                    maxResponseBytes: 65_536,
                  },
                },
              }
            : bound,
        );
        const context = {
          systemPrompt: "Review the supplied document.",
          messages: [
            { role: "user" as const, content: "Read README.md and review it.", timestamp: 1 },
          ],
          tools: [
            {
              name: "read_document",
              description: "Read a document",
              parameters: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
              },
            },
          ],
        };
        const first = await connection.runtime.streamSimple(connection.model, context).result();
        expect(first.stopReason, first.errorMessage).toBe("toolUse");
        const call = first.content.find((item) => item.type === "toolCall");
        expect(call).toMatchObject({ name: "read_document", arguments: { path: "README.md" } });
        if (!call || call.type !== "toolCall") throw new Error("Expected a native tool call.");
        const final = await connection.runtime
          .streamSimple(connection.model, {
            ...context,
            messages: [
              ...context.messages,
              first,
              {
                role: "toolResult",
                toolCallId: call.id,
                toolName: call.name,
                content: [{ type: "text", text: "Document evidence from README.md" }],
                isError: false,
                timestamp: 2,
              },
            ],
          })
          .result();
        expect(final.stopReason, final.errorMessage).toBe("stop");
        expect(final.content).toContainEqual(
          expect.objectContaining({ type: "text", text: "Reviewed the document." }),
        );
        expect(requests).toHaveLength(2);
        for (const request of requests) {
          expect(request.url.origin).toBe(new URL(baseUrl).origin);
          expect(request.url.pathname).toBe(expectedPath);
          expect(request.url.search).toBe(expectedQuery);
          expect(
            request.headers.get(transport === "anthropic-messages" ? "x-api-key" : "authorization"),
          ).toBe(transport === "anthropic-messages" ? secret : `Bearer ${secret}`);
          expect(JSON.stringify(request.body)).not.toContain(secret);
        }
        expect(JSON.stringify(requests[1]!.body)).toContain("Document evidence from README.md");
      },
    );
  });

  it("keeps the internal NVIDIA endpoint usable through OpenAI-compatible", async () => {
    const root = await configurationRoot();
    await runSetupBootstrap({
      model: {
        provider: "openai-compatible",
        modelId: HUB_PRESET_ROUTE.modelId,
        baseUrl: HUB_PRESET_ROUTE.baseUrl,
      },
      environment: { DOCSFAB_CONFIG_ROOT: root, COMPATIBLE_API_KEY: "hub-test-placeholder" },
    });
    const config = loadConfig({ DOCSFAB_CONFIG_ROOT: root });
    const bound = await resolveOperatorExecutionBinding({ model: config.model, environment: {} });
    expect(bound.profile.transport).toBe("openai-chat-completions");
    expect(bound.profile.baseUrl).toBe(HUB_PRESET_ROUTE.baseUrl);
    expect(bound.profile.profile.contextWindow).toBe(
      await sealedCompositionContextWindow(HUB_PRESET_ROUTE.compositionId),
    );
  });

  it("switches an installed profile to a custom provider without retaining the writing composition", async () => {
    const root = await configurationRoot();
    await runSetupBootstrap({
      profile: "nvidia-inference-gpt-6-sol-pi",
      environment: { DOCSFAB_CONFIG_ROOT: root, MODEL_API_KEY: "previous-test-placeholder" },
    });
    await runSetupBootstrap({
      model: {
        provider: "anthropic-compatible",
        modelId: "custom-claude",
        baseUrl: "https://proxy.example.test",
      },
      environment: {
        DOCSFAB_CONFIG_ROOT: root,
        COMPATIBLE_ANTHROPIC_API_KEY: "new-test-placeholder",
      },
    });
    const config = loadConfig({ DOCSFAB_CONFIG_ROOT: root });
    expect(config.model.transport).toBe("anthropic-messages");
    expect(config.model.apiKey).toBe("new-test-placeholder");
    expect(await runSetupBootstrap({ environment: { DOCSFAB_CONFIG_ROOT: root } })).toMatchObject({
      status: "ready",
    });
  });

  it("does not reuse a saved key when changing to another compatible endpoint", async () => {
    const root = await configurationRoot();
    const model = {
      provider: "openai-compatible" as const,
      modelId: "custom-model",
      baseUrl: "https://first.example.test/v1",
    };
    await runSetupBootstrap({
      model,
      environment: { DOCSFAB_CONFIG_ROOT: root, COMPATIBLE_API_KEY: "first-test-placeholder" },
    });
    const before = await readFile(join(root, "host.yaml"), "utf8");
    await expect(
      runSetupBootstrap({
        model: { ...model, baseUrl: "https://second.example.test/v1" },
        environment: { DOCSFAB_CONFIG_ROOT: root },
      }),
    ).rejects.toThrow("Set COMPATIBLE_API_KEY");
    expect(await readFile(join(root, "host.yaml"), "utf8")).toBe(before);
    expect(loadConfig({ DOCSFAB_CONFIG_ROOT: root }).model.baseUrl).toBe(model.baseUrl);
  });

  it("refuses a missing selected key instead of falling back to another provider's key", async () => {
    const root = await configurationRoot();
    await runSetupBootstrap({
      model: {
        provider: "anthropic",
        modelId: "custom-model",
        baseUrl: MODEL_PROVIDERS.anthropic.baseUrl,
      },
      environment: { DOCSFAB_CONFIG_ROOT: root, ANTHROPIC_API_KEY: "test-placeholder" },
    });
    await writeFile(
      join(root, "secrets.env"),
      "MODEL_API_KEY=unrelated-test-placeholder\nOPENAI_API_KEY=unrelated-test-placeholder\n",
    );
    expect(() => loadConfig({ DOCSFAB_CONFIG_ROOT: root })).toThrowError(
      expect.objectContaining({
        reason: "missing-primary-credential",
        message: expect.stringContaining("ANTHROPIC_API_KEY"),
      }),
    );
    expect(await runSetupBootstrap({ environment: { DOCSFAB_CONFIG_ROOT: root } })).toMatchObject({
      status: "blocked-missing-credential",
      requiredSecretNames: ["ANTHROPIC_API_KEY"],
    });
  });

  // #1512 scope (coordinator under delegated authority, 2026-09-28): every
  // GPT-5.6 family id brought through a provider option is refused by setup
  // itself, before any write, whichever route or API it names.
  it.each([
    {
      provider: "openai",
      modelId: "gpt-5.6-sol",
      baseUrl: MODEL_PROVIDERS.openai.baseUrl,
      transport: "openai-responses",
    },
    {
      provider: "openai",
      modelId: "gpt-5.6-sol",
      baseUrl: MODEL_PROVIDERS.openai.baseUrl,
      transport: "openai-chat-completions",
    },
    {
      provider: "openai-compatible",
      modelId: "gpt-5.6-terra",
      baseUrl: "https://models.example.test/v1",
      transport: "openai-chat-completions",
    },
    {
      provider: "openai-compatible",
      modelId: "azure/openai/gpt-5.6-luna",
      baseUrl: HUB_BASE_URL,
      transport: "openai-chat-completions",
    },
  ] as const)(
    "refuses setup of GPT-5.6 $modelId through $provider / $transport before any write",
    async (model) => {
      const root = await configurationRoot();
      let thrown: unknown;
      try {
        // Setup alone: nothing after it can supply the refusal.
        await runSetupBootstrap({
          model,
          environment: {
            DOCSFAB_CONFIG_ROOT: root,
            OPENAI_API_KEY: "test-placeholder",
            COMPATIBLE_API_KEY: "test-placeholder",
          },
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ModelCompositionError);
      expect(thrown).toMatchObject({
        code: "composition-retired",
        nextAction:
          "GPT-5.6 is retired; run `docsfab setup --profile nvidia-inference-gpt-6-sol-pi` to move to GPT-6 Sol with `MODEL_API_KEY`, or choose another model with `docsfab setup` in a terminal.",
      });
      expect(await readdir(root)).toEqual([]);
    },
  );

  it("refuses an existing direct OpenAI gpt-5.6-sol chat-completions host at load", async () => {
    // The shape main's setup wrote for `--provider openai --model gpt-5.6-sol
    // --api openai-chat-completions`: previously unmatched bring-your-own.
    const root = await configurationRoot();
    await writeFile(
      join(root, "host.yaml"),
      "schemaVersion: 1\nkind: docsfab-host-config\nactivePolicyProfile: profiles/gpt-5.6-sol.yaml\n",
      { mode: 0o600 },
    );
    await mkdir(join(root, "profiles"), { mode: 0o700 });
    await writeFile(
      join(root, "profiles", "gpt-5.6-sol.yaml"),
      [
        "schemaVersion: 1",
        "kind: docsfab-model-profile",
        "slot: policy",
        "provider: openai-api",
        "baseUrl: https://api.openai.com/v1",
        "modelId: gpt-5.6-sol",
        "apiFormat: chat_completions",
        "transport: openai-chat-completions",
        "credentialEnv: OPENAI_API_KEY",
        "contextWindow: 128000",
        "maxInputTokens: 128000",
        "maxOutputTokens: 8192",
        "apiMinOutputTokens: 16",
        "contextReserveTokens: 1024",
        "reasoning: false",
        "inputTypes: text",
        "supportsDeveloperRole: false",
        "supportsReasoningEffort: false",
        "compatibleApiFormats: chat_completions",
        "inputCostPerMillion: unknown",
        "outputCostPerMillion: unknown",
        "cacheReadCostPerMillion: unknown",
        "cacheWriteCostPerMillion: unknown",
        "profileApprovedSource: unknown",
        "profileEffectiveDate: unknown",
        "profileReviewAfter: unknown",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    expect(() =>
      loadConfig({ DOCSFAB_CONFIG_ROOT: root, OPENAI_API_KEY: "test-placeholder" }),
    ).toThrowError(expect.objectContaining({ code: "composition-retired" }));
  });

  it("warns, without refusing, for another GPT-5.x id brought through openai-compatible", async () => {
    const root = await configurationRoot();
    const result = await runSetupBootstrap({
      model: {
        provider: "openai-compatible",
        modelId: "gpt-5.4",
        baseUrl: "https://models.example.test/v1",
        transport: "openai-chat-completions",
      },
      environment: { DOCSFAB_CONFIG_ROOT: root, COMPATIBLE_API_KEY: "test-placeholder" },
    });
    expect(result.status).toBe("ready");
    expect(result.warnings).toEqual([
      expect.stringContaining(
        "`docsfab setup --profile nvidia-inference-gpt-6-sol-pi` to use GPT-6 Sol",
      ),
    ]);
    expect(formatSetupBootstrapResult(result)).toContain(
      'Warning: Model "gpt-5.4" is a GPT-5.x model.',
    );
    const config = loadConfig({
      DOCSFAB_CONFIG_ROOT: root,
      COMPATIBLE_API_KEY: "test-placeholder",
    });
    const bound = await resolveOperatorExecutionBinding({ model: config.model, environment: {} });
    expect(bound.match).toBe("unmatched-byo");

    // A current model gets no warning.
    const clean = await runSetupBootstrap({
      model: {
        provider: "openai-compatible",
        modelId: "acme/documentation-model",
        baseUrl: "https://models.example.test/v1",
        transport: "openai-chat-completions",
      },
      environment: {
        DOCSFAB_CONFIG_ROOT: await configurationRoot(),
        COMPATIBLE_API_KEY: "test-placeholder",
      },
    });
    expect(clean.warnings).toBeUndefined();
  });

  it.each([
    {
      provider: "openai",
      transport: "anthropic-messages",
      baseUrl: MODEL_PROVIDERS.openai.baseUrl,
    },
    {
      provider: "anthropic",
      transport: "openai-responses",
      baseUrl: MODEL_PROVIDERS.anthropic.baseUrl,
    },
    {
      provider: "openai",
      transport: "openai-responses",
      baseUrl: "https://custom.example.test/v1",
    },
  ] as const)(
    "rejects a mismatched provider, API, or direct endpoint: $provider / $transport / $baseUrl",
    async (model) => {
      const root = await configurationRoot();
      await expect(
        runSetupBootstrap({
          model: { ...model, modelId: "model" },
          environment: {
            DOCSFAB_CONFIG_ROOT: root,
            OPENAI_API_KEY: "test-placeholder",
            ANTHROPIC_API_KEY: "test-placeholder",
          },
        }),
      ).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
    },
  );

  it.each([
    "http://proxy.example.test",
    "https://user:password@proxy.example.test",
    "https://proxy.example.test?key=value",
  ])("rejects invalid endpoint %s before saving configuration", async (baseUrl) => {
    const root = await configurationRoot();
    await expect(
      runSetupBootstrap({
        model: { provider: "openai-compatible", modelId: "model", baseUrl },
        environment: { DOCSFAB_CONFIG_ROOT: root, COMPATIBLE_API_KEY: "test-placeholder" },
      }),
    ).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it.each(Object.keys(MODEL_PROVIDERS) as ModelProviderOption[])(
    "offers %s during interactive setup",
    async (provider) => {
      const root = await configurationRoot();
      const result = await runInteractiveSetup({
        environment: { DOCSFAB_CONFIG_ROOT: root },
        prompter: {
          async readChoice(label, choices, fallback) {
            if (label === "Provider") {
              expect(choices.map((choice) => choice.value)).toEqual(Object.keys(MODEL_PROVIDERS));
              return provider;
            }
            expect(label).toBe("API");
            expect(choices.map((choice) => choice.value)).toEqual([
              "openai-responses",
              "openai-chat-completions",
            ]);
            return fallback;
          },
          async readValue(label, fallback) {
            if (label === "Model name") return "model-under-test";
            if (label === "Endpoint URL") return "https://custom.example.test";
            return fallback;
          },
          async readSecret() {
            return "interactive-test-placeholder";
          },
        },
      });
      expect(result.status).toBe("ready");
      expect(loadConfig({ DOCSFAB_CONFIG_ROOT: root }).model.transport).toBe(
        MODEL_PROVIDERS[provider].transport,
      );
    },
  );

  it("rejects missing, duplicate, or conflicting setup options", () => {
    for (const args of [
      ["--provider"],
      ["--provider", "openai", "--provider", "anthropic"],
      ["--model", "model"],
      ["--provider", "openai", "--profile", "anything"],
      ["--api", "invalid"],
    ]) {
      expect(() => parseSetupArguments(args)).toThrow();
    }
  });
});

describe("pasted request URLs", () => {
  it("accepts a fixed provider's full request URL as its base URL", () => {
    const base = {
      provider: "openai",
      transport: "openai-responses",
      modelId: "gpt-test",
    } as const;
    expect(
      buildPolicyProfileFromEndpoint({ ...base, baseUrl: "https://api.openai.com/v1/responses" }),
    ).toEqual(buildPolicyProfileFromEndpoint({ ...base, baseUrl: "https://api.openai.com/v1" }));
  });

  it("resolves a preset from its full request URL", () => {
    const base = {
      transport: "openai-chat-completions",
      modelId: HUB_PRESET_ROUTE.modelId,
    } as const;
    const preset = buildPolicyProfileFromEndpoint({ ...base, baseUrl: HUB_PRESET_ROUTE.baseUrl });
    expect(
      buildPolicyProfileFromEndpoint({
        ...base,
        baseUrl: `${HUB_PRESET_ROUTE.baseUrl}/chat/completions`,
      }),
    ).toEqual(preset);
  });
});
