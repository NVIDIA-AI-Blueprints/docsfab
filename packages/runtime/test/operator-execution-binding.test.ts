// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../src/contract-kit/index.js";
import { loadCompositionRunRuntime } from "../src/cli/run/composition-runtime.js";
import type { RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import type { ModelEndpointConfig } from "../src/model/configuration.js";
import {
  loadInstalledModelCompositionAuthority,
  ModelCompositionError,
  resolveInstalledExecutableComposition,
  type BoundExecutableComposition,
} from "../src/model-composition/index.js";
import {
  formatUnmatchedByoOperatorNotice,
  resolveOperatorExecutionBinding,
  resolveOperatorExecutionIdentity,
  UNMATCHED_BYO_NEXT_COMMAND,
} from "../src/model/operator-execution-binding.js";
import { createProviderConnectionFactory } from "../src/model/provider.js";
import { DOCSFAB_SYSTEM_PROMPT } from "../src/model/request-policy.js";
import { validModelConfig } from "./helpers.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";

const HUB_BASE_URL = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];

const SUPER_V3 = {
  compositionId: "nvidia-inference-nemotron-3-super-v3-pi",
  providerId: "nvidia-inference-api",
  baseUrl: HUB_BASE_URL,
  modelId: "nvidia/nvidia/nemotron-3-super-v3",
} as const;

// Retired by operator decision (#1512): a raw profile still uniquely matches
// the record, and the binder refuses it by name.
const OPENAI_SOL = {
  compositionId: "openai-gpt-5.6-sol-pi",
  providerId: "openai-api",
  baseUrl: "https://api.openai.com/v1",
  modelId: "gpt-5.6-sol",
} as const;

// The live direct-provider lane on a non-chat-completions transport.
const ANTHROPIC_OPUS = {
  compositionId: "anthropic-claude-opus-4.7-pi",
  providerId: "anthropic-api",
  baseUrl: "https://api.anthropic.com/v1",
  modelId: "claude-opus-4-7",
} as const;

function anthropicEndpoint(
  profile: Partial<ModelEndpointConfig["profile"]> = {},
): ModelEndpointConfig {
  return endpoint({
    providerId: ANTHROPIC_OPUS.providerId,
    baseUrl: ANTHROPIC_OPUS.baseUrl,
    modelId: ANTHROPIC_OPUS.modelId,
    apiFormat: "messages",
    profile: {
      ...validModelConfig.profile,
      ...profile,
      compatibility: { ...validModelConfig.profile.compatibility, apiFormats: ["messages"] },
    },
  });
}

const BIND_ENV = { MODEL_API_KEY: "test-secret" } as const;

function endpoint(overrides: Partial<ModelEndpointConfig> = {}): ModelEndpointConfig {
  return {
    ...validModelConfig,
    ...overrides,
    profile: {
      ...validModelConfig.profile,
      ...(overrides.profile ?? {}),
      compatibility: {
        ...validModelConfig.profile.compatibility,
        ...(overrides.profile?.compatibility ?? {}),
      },
    },
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

describe("omitted-mode operator execution binding", () => {
  it("resolves an installed identity without reading the configured credential", async () => {
    const model = endpoint({
      providerId: SUPER_V3.providerId,
      baseUrl: SUPER_V3.baseUrl,
      modelId: SUPER_V3.modelId,
    });
    Object.defineProperty(model, "apiKey", {
      configurable: true,
      get() {
        throw new Error("identity binding must not read a provider credential");
      },
    });

    const identity = await resolveOperatorExecutionIdentity({ model, environment: {} });

    expect(identity.match).toBe("installed-composition");
    expect(identity.bound?.composition.compositionId).toBe(SUPER_V3.compositionId);
    expect(identity).not.toHaveProperty("credential");
  });

  it("resolves an unmatched identity without reading the configured credential", async () => {
    const model = endpoint({
      providerId: "operator-configured-openai-compatible",
      baseUrl: "https://models.example.test/v1",
      modelId: "acme/documentation-model",
    });
    Object.defineProperty(model, "apiKey", {
      configurable: true,
      get() {
        throw new Error("identity binding must not read a provider credential");
      },
    });

    const identity = await resolveOperatorExecutionIdentity({ model, environment: {} });

    expect(identity.match).toBe("unmatched-byo");
    expect(identity.profile.contextAdmission).toBe("host-window");
    expect(identity).not.toHaveProperty("credential");
  });

  it("keeps explicit credentials on the live binding wrapper", async () => {
    const credential = { family: "nvidia-inference-api" as const, apiKey: "approved-test-secret" };
    const binding = await resolveOperatorExecutionBinding({
      model: endpoint({
        providerId: SUPER_V3.providerId,
        baseUrl: SUPER_V3.baseUrl,
        modelId: SUPER_V3.modelId,
      }),
      credential,
      environment: {},
    });

    expect(binding.credential).toEqual(credential);
    expect(binding.match).toBe("installed-composition");
  });

  it("still fails a live installed binding when its required credential is absent", async () => {
    const model = endpoint({
      providerId: SUPER_V3.providerId,
      baseUrl: SUPER_V3.baseUrl,
      modelId: SUPER_V3.modelId,
      apiKey: "",
    });

    await expect(resolveOperatorExecutionBinding({ model, environment: {} })).rejects.toThrow(
      "The matched composition credential is unavailable.",
    );
  });

  it("runs a preset on its own route when the configured route differs, and warns", async () => {
    const model = endpoint({
      providerId: "openai-api",
      baseUrl: SUPER_V3.baseUrl,
      modelId: SUPER_V3.modelId,
    });

    const binding = await resolveOperatorExecutionIdentity({
      model,
      compositionId: SUPER_V3.compositionId,
      environment: {},
    });
    expect(binding.profile.routeId).toBe(SUPER_V3.providerId);
    expect(binding.notes).toEqual([
      `The configured provider route openai-api is not preset ${SUPER_V3.compositionId}'s route; the run uses the preset's route ${SUPER_V3.providerId}. Select a preset for that route to change it.`,
    ]);
  });

  it("refuses a preset endpoint that is not a plain URL, and records a different one", async () => {
    for (const baseUrl of [
      HUB_BASE_URL.replace("https://", "https://user:secret@"),
      `${HUB_BASE_URL}?key=value`,
      `${HUB_BASE_URL}#fragment`,
    ]) {
      await expect(
        resolveOperatorExecutionIdentity({
          model: endpoint({
            providerId: SUPER_V3.providerId,
            baseUrl,
            modelId: SUPER_V3.modelId,
          }),
          compositionId: SUPER_V3.compositionId,
          environment: {},
        }),
      ).rejects.toMatchObject({ code: "deployment-binding-mismatch" });
    }
    await expect(
      resolveOperatorExecutionIdentity({
        model: endpoint({
          providerId: SUPER_V3.providerId,
          baseUrl: "http://models.example.test/v1",
          modelId: SUPER_V3.modelId,
        }),
        compositionId: SUPER_V3.compositionId,
        environment: {},
      }),
    ).rejects.toMatchObject({ code: "model-endpoint-insecure-transport" });
    const loopback = await resolveOperatorExecutionIdentity({
      model: endpoint({
        providerId: SUPER_V3.providerId,
        baseUrl: "http://127.0.0.1:9/v1",
        modelId: SUPER_V3.modelId,
      }),
      compositionId: SUPER_V3.compositionId,
      environment: {},
    });
    expect(loopback.profile.baseUrl).toBe("http://127.0.0.1:9/v1");
    const gateway = await resolveOperatorExecutionIdentity({
      model: endpoint({
        providerId: SUPER_V3.providerId,
        baseUrl: "https://llm-gateway.example.test/v1",
        modelId: SUPER_V3.modelId,
      }),
      compositionId: SUPER_V3.compositionId,
      environment: {},
    });
    expect(gateway.profile.baseUrl).toBe("https://llm-gateway.example.test/v1");
    expect(gateway.match).toBe("installed-composition");
  });

  it("keeps a loaded host composition selection authoritative when its endpoint drifts", async () => {
    const selected = endpoint({
      providerId: SUPER_V3.providerId,
      baseUrl: SUPER_V3.baseUrl,
      modelId: SUPER_V3.modelId,
      compositionId: SUPER_V3.compositionId,
    });
    const accepted = await resolveOperatorExecutionIdentity({ model: selected, environment: {} });
    expect(accepted.bound?.composition.compositionId).toBe(SUPER_V3.compositionId);

    // Another model on the selected route runs as configured with a warning,
    // and the loaded selection still decides the composition (#2193 MR2).
    const drifted = await resolveOperatorExecutionIdentity({
      model: { ...selected, modelId: "operator-stale-model" },
      environment: {},
    });
    expect(drifted.bound?.composition.compositionId).toBe(SUPER_V3.compositionId);
    expect(drifted.profile.modelId).toBe("operator-stale-model");
    expect(drifted.notes).toContain(
      `The configured model operator-stale-model differs from preset ${SUPER_V3.compositionId}'s ${drifted.bound!.composition.model.resolvedId}; DocsFab runs it as configured.`,
    );
  });

  it("refuses an unqualified output clamp on any records-capable binding before credential resolution", async () => {
    const { authority } = await loadInstalledModelCompositionAuthority();
    const installed = resolveInstalledExecutableComposition({
      authority,
      compositionId: SUPER_V3.compositionId,
      workflowId: "review-documentation",
    });
    const bound = {
      ...installed,
      composition: {
        ...installed.composition,
        answerSubmissionRecords: {
          phaseBMaxAdmittedMessageBytes: 18_743,
          minimumQualifiedMessageBytes: 6_144,
          maxMessageBytes: 18_743,
          groupEnvelopeBytes: [{ group: 1, maxBytes: 10_000 }],
          fullPlanEnvelopeBytes: 10_000,
          largestRecordEnvelopeBytes: 3_000,
          lturnMs: 8_000,
          decodeTokensPerSecond: 100,
          readingTurnsP90: 2,
          step8TurnEvidence: {
            projectedReportTokens: 2_700,
            samples: [{ d3ResidualFires: "unknown" }],
          },
        },
      },
    } as unknown as BoundExecutableComposition;
    const model = endpoint({
      providerId: SUPER_V3.providerId,
      baseUrl: SUPER_V3.baseUrl,
      modelId: SUPER_V3.modelId,
      profile: {
        ...validModelConfig.profile,
        configuredLimits: {
          contextWindow: 128_000,
          maxInputTokens: 128_000,
          maxOutputTokens: 1_024,
        },
        maxOutputTokens: 1_024,
      },
    });
    let failure: unknown;
    try {
      await resolveOperatorExecutionBinding({
        model,
        bound,
        workflowId: "review-documentation",
        environment: {},
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ModelCompositionError);
    expect((failure as ModelCompositionError).code).toBe("timer-fit-predicted");
    expect((failure as Error).message).toContain("smallest qualified phase-B rung");
    expect((failure as Error).message).not.toContain("test-secret");
  });

  it("attaches Super v3 requestPolicy on omitted-mode YAML/config match so the payload sends chat_template_kwargs", async () => {
    const binding = await resolveOperatorExecutionBinding({
      model: endpoint({
        providerId: SUPER_V3.providerId,
        baseUrl: SUPER_V3.baseUrl,
        modelId: SUPER_V3.modelId,
      }),
      environment: BIND_ENV,
    });

    expect(binding.match).toBe("installed-composition");
    expect(binding.bound?.composition.compositionId).toBe(SUPER_V3.compositionId);
    expect(binding.profile.transport).toBe("openai-chat-completions");
    expect(binding.credential.family).toBe("nvidia-inference-api");
    expect(binding.profile.profile.effectiveLimitReason).toBe("composition-candidate");
    expect(binding.profile.profile.effectiveLimitReason).not.toBe("metadata-unknown");
    expect(binding.profile.compositionRequestPolicy).toEqual(
      binding.bound?.composition.requestPolicy,
    );
    expect(binding.profile.compositionRequestPolicy?.reasoningControl).toEqual({
      kind: "chat-template-kwarg",
      thinking: false,
    });
    expect(binding.profile).not.toHaveProperty("compositionPolicy");

    const requests: Record<string, unknown>[] = [];
    const factory = createProviderConnectionFactory({
      routeId: binding.profile.routeId,
      transport: binding.profile.transport,
      fetch: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return nvidiaSse(SUPER_V3.modelId);
      },
    });
    const connection = await factory.create(
      { profile: binding.profile, credential: binding.credential },
      { evidenceIdentity: { repositoryRevision: "a".repeat(40) } },
    );
    for await (const _event of connection.runtime.streamSimple(
      connection.model,
      {
        systemPrompt: DOCSFAB_SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
        tools: [],
      },
      { maxTokens: 64 },
    )) {
      // Consumption drives Pi's lazy onPayload and provider fetch.
    }

    expect(requests).toHaveLength(1);
    expect(requests[0]?.chat_template_kwargs).toEqual({ thinking: false });
    expect(requests[0]?.model).toBe(SUPER_V3.modelId);
    expect(connection.turnGovernance?.evidence()[0]?.requestPolicySha256).toBe(
      binding.profile.compositionRequestPolicy?.policySha256,
    );
    expect(connection.turnGovernance?.evidence()[0]?.finalPayloadSha256).toBe(
      canonicalDigest(requests[0]),
    );
  });

  it("refuses Direct OpenAI Sol YAML/config by naming its retirement and successor", async () => {
    let caught: unknown;
    try {
      await resolveOperatorExecutionBinding({
        model: endpoint({
          providerId: OPENAI_SOL.providerId,
          baseUrl: OPENAI_SOL.baseUrl,
          modelId: OPENAI_SOL.modelId,
        }),
        environment: BIND_ENV,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ModelCompositionError);
    expect((caught as ModelCompositionError).code).toBe("composition-retired");
    expect((caught as ModelCompositionError).message).toContain(
      `"${OPENAI_SOL.compositionId}" is retired (superseded-by-operator-decision`,
    );
    expect((caught as ModelCompositionError).nextAction).toContain(
      "`nvidia-inference-gpt-6-sol-pi`",
    );
  });

  it("binds Direct Anthropic Opus YAML/config to anthropic-messages", async () => {
    const binding = await resolveOperatorExecutionBinding({
      model: anthropicEndpoint(),
      environment: BIND_ENV,
    });

    expect(binding.match).toBe("installed-composition");
    expect(binding.bound?.composition.compositionId).toBe(ANTHROPIC_OPUS.compositionId);
    expect(binding.profile.transport).toBe("anthropic-messages");
    expect(binding.credential.family).toBe("anthropic-api");
    expect(binding.profile.profile.effectiveLimitReason).not.toBe("metadata-unknown");
    expect(binding.profile).not.toHaveProperty("compositionRequestPolicy");
  });

  it("does not inherit unattested YAML 8192 when Direct Anthropic Opus uniquely matches", async () => {
    const binding = await resolveOperatorExecutionBinding({
      model: anthropicEndpoint({
        configuredLimits: {
          contextWindow: 8_192,
          maxInputTokens: 8_192,
          maxOutputTokens: 4_096,
        },
        contextWindow: 8_192,
        maxInputTokens: 8_192,
        maxOutputTokens: 4_096,
        effectiveLimitReason: "metadata-unknown",
        metadata: {
          approvedSource: null,
          effectiveDate: null,
          reviewAfter: null,
          status: "unknown",
        },
      }),
      environment: BIND_ENV,
    });

    expect(binding.match).toBe("installed-composition");
    expect(binding.bound?.composition.compositionId).toBe(ANTHROPIC_OPUS.compositionId);
    expect(binding.profile.contextAdmission).toBe("host-window");
    expect(binding.profile.profile.contextWindow).toBeGreaterThan(8_192);
    expect(binding.profile.profile.contextWindow).toBe(
      Math.min(
        binding.bound!.candidate.proposedLimits.contextWindow,
        binding.bound!.composition.compositionLimits.contextWindow,
        binding.bound!.compositionCeiling.contextWindow,
      ),
    );
  });

  it("skips DocsFab context admission and one NEXT for unmatched unattested YAML", async () => {
    const model = endpoint({
      providerId: "operator-configured-openai-compatible",
      baseUrl: "https://models.example.test/v1",
      modelId: "acme/documentation-model",
      profile: {
        ...validModelConfig.profile,
        configuredLimits: {
          contextWindow: 128_000,
          maxInputTokens: 128_000,
          maxOutputTokens: 16_384,
        },
        contextWindow: 128_000,
        maxInputTokens: 128_000,
        maxOutputTokens: 16_384,
        effectiveLimitReason: "metadata-unknown",
        metadata: {
          approvedSource: null,
          effectiveDate: null,
          reviewAfter: null,
          status: "unknown",
        },
      },
    });
    const binding = await resolveOperatorExecutionBinding({ model, environment: BIND_ENV });

    expect(binding.match).toBe("unmatched-byo");
    expect(binding.profile.contextAdmission).toBe("provider");
    expect(binding.profile.transport).toBe("openai-chat-completions");
    expect(binding.credential.family).toBe("legacy-configured-endpoint");
    expect(binding.profile).not.toHaveProperty("compositionRequestPolicy");
    expect(binding.profile.profile.contextWindow).toBe(128_000);
    expect(binding.profile.profile.maxOutputTokens).toBe(16_384);
    expect(binding.operatorNotice).toBe(formatUnmatchedByoOperatorNotice(binding.profile.profile));
    expect(binding.operatorNotice).toContain("not applying a host context ceiling");
    expect(binding.operatorNotice).not.toContain("8192");
    expect(binding.operatorNotice).toContain(`NEXT ${UNMATCHED_BYO_NEXT_COMMAND}`);
    expect(binding.operatorNotice?.split("\n").filter((line) => line.startsWith("NEXT "))).toEqual([
      `NEXT ${UNMATCHED_BYO_NEXT_COMMAND}`,
    ]);
  });

  it("admits occupancy above unattested YAML 8192 on unique Super v3 match", async () => {
    const binding = await resolveOperatorExecutionBinding({
      model: endpoint({
        providerId: SUPER_V3.providerId,
        baseUrl: SUPER_V3.baseUrl,
        modelId: SUPER_V3.modelId,
        profile: {
          ...validModelConfig.profile,
          configuredLimits: {
            contextWindow: 8_192,
            maxInputTokens: 8_192,
            maxOutputTokens: 4_096,
          },
          contextWindow: 8_192,
          maxInputTokens: 8_192,
          maxOutputTokens: 4_096,
          effectiveLimitReason: "metadata-unknown",
          metadata: {
            approvedSource: null,
            effectiveDate: null,
            reviewAfter: null,
            status: "unknown",
          },
        },
      }),
      environment: BIND_ENV,
    });
    expect(binding.match).toBe("installed-composition");
    expect(binding.profile.profile.contextWindow).toBeGreaterThan(8_192);

    const factory = createProviderConnectionFactory({
      routeId: binding.profile.routeId,
      transport: binding.profile.transport,
      fetch: async () => nvidiaSse(SUPER_V3.modelId),
    });
    const connection = await factory.create({
      profile: binding.profile,
      credential: binding.credential,
    });
    for await (const _event of connection.runtime.streamSimple(
      connection.model,
      {
        systemPrompt: "x".repeat(40_000),
        messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
        tools: [],
      },
      { maxTokens: 64 },
    )) {
      // Consumption drives Pi's lazy onPayload and provider fetch.
    }
  });

  it("admits occupancy above 8192 when unmatched YAML skips host admission", async () => {
    const model = endpoint({
      providerId: "operator-configured-openai-compatible",
      baseUrl: "https://models.example.test/v1",
      modelId: "acme/documentation-model",
      profile: {
        ...validModelConfig.profile,
        configuredLimits: {
          contextWindow: 8_192,
          maxInputTokens: 8_192,
          maxOutputTokens: 4_096,
        },
        contextWindow: 8_192,
        maxInputTokens: 8_192,
        maxOutputTokens: 4_096,
        effectiveLimitReason: "metadata-unknown",
        metadata: {
          approvedSource: null,
          effectiveDate: null,
          reviewAfter: null,
          status: "unknown",
        },
      },
    });
    const binding = await resolveOperatorExecutionBinding({ model, environment: BIND_ENV });
    expect(binding.profile.contextAdmission).toBe("provider");
    const factory = createProviderConnectionFactory({
      routeId: binding.profile.routeId,
      transport: binding.profile.transport,
      fetch: async () => nvidiaSse(model.modelId),
    });
    const connection = await factory.create({
      profile: binding.profile,
      credential: binding.credential,
    });
    for await (const _event of connection.runtime.streamSimple(
      connection.model,
      {
        systemPrompt: "x".repeat(40_000),
        messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
        tools: [],
      },
      { maxTokens: 64 },
    )) {
      // Consumption drives Pi's lazy onPayload and provider fetch.
    }
  });

  it("uses the same binder for --composition and the model-profile unique match", async () => {
    const model = endpoint({
      providerId: SUPER_V3.providerId,
      baseUrl: SUPER_V3.baseUrl,
      modelId: SUPER_V3.modelId,
    });
    const omitted = await resolveOperatorExecutionBinding({ model, environment: BIND_ENV });
    const request = {
      compositionId: SUPER_V3.compositionId,
      workflow: "review-documentation",
      repositoryPath: "/tmp/docsfab-composition-target",
      revision: "HEAD",
      allowWrite: false,
      releaseGate: false,
      verbose: false,
      json: false,
      showScan: false,
    } as const satisfies RunRequestWithPublishProjection;
    const composed = await loadCompositionRunRuntime(request, {
      projectRoot: "/opt/docsfab/runtime",
      skillCrateDirectory: "/opt/docsfab/runtime/skill-crate",
      qualityDirectory: "/opt/docsfab/runtime/quality",
      qualityPackDirectory: "/opt/docsfab/runtime/quality-pack",
      stateDirectory: "/tmp/docsfab-state/runs",
      retryPolicy: {
        maxRetries: 3,
        baseDelayMs: 1,
        maxDelayMs: 1,
        retryableCategories: [],
      },
      model,
    });

    expect(omitted.profile.compositionRequestPolicy).toEqual(
      composed.executionProfile.compositionRequestPolicy,
    );
    expect(omitted.profile.transport).toBe(composed.executionProfile.transport);
    expect(omitted.profile.routeId).toBe(composed.executionProfile.routeId);
    expect(omitted.credential.family).toBe(composed.credential.family);
    expect(composed.executionProfile.compositionPolicy).toBeDefined();
    expect(omitted.profile).not.toHaveProperty("compositionPolicy");
  });

  it("does not crash or print NEXT when omitted-mode config has no profile yet", async () => {
    const binding = await resolveOperatorExecutionBinding({
      model: { apiKey: "test-secret" } as never,
      environment: BIND_ENV,
    });
    expect(binding.match).toBe("unmatched-byo");
    expect(binding.operatorNotice).toBeUndefined();
  });

  it("fails closed when unique YAML/config match is a retired composition", async () => {
    await expect(
      resolveOperatorExecutionBinding({
        model: endpoint({
          providerId: "nvidia-api-catalog",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          modelId: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
        }),
        environment: BIND_ENV,
      }),
    ).rejects.toThrow(/retired \(provider-end-of-life/u);
  });
});
