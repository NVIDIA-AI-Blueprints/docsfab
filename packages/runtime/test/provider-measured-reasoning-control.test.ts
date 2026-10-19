// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { limitDefinition } from "../src/config/limits.js";
import {
  CONSERVATIVE_MODEL_FALLBACK,
  type ModelEndpointConfig,
} from "../src/model/configuration.js";
import { resolveOperatorExecutionBinding } from "../src/model/operator-execution-binding.js";
import { createProviderConnectionFactory } from "../src/model/provider.js";
import { ProviderRequestPolicyError, applyReasoningControl } from "../src/model/request-policy.js";
import { validModelConfig } from "./helpers.js";

/**
 * An OpenAI-compatible endpoint serving a model that an installed composition
 * measured, such as a hosted or self-hosted NVIDIA NIM for Nemotron 3 Super,
 * does not match that composition. Without the measured control its reasoning
 * is on by default and spends the output allowance: a captured hosted
 * `review-documentation` step spent all 4,096 output tokens in
 * `reasoning_content` before any answer.
 */

const NEMOTRON_SUPER = "nvidia/nemotron-3-super-120b-a12b";
const NEMOTRON_SUPER_COMPOSITION = "nvidia-nemotron-3-super-120b-a12b-pi";

/** The profile `docsfab setup --provider openai-compatible` writes: no attested metadata. */
function unmatchedCompatible(modelId: string, reasoning = false): ModelEndpointConfig {
  return {
    ...validModelConfig,
    providerId: "operator-configured-openai-compatible",
    baseUrl: "https://nim.example.test/v1",
    modelId,
    transport: "openai-chat-completions",
    profile: {
      ...validModelConfig.profile,
      reasoning,
      compatibility: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        apiFormats: ["chat_completions"],
      },
      metadata: {
        approvedSource: null,
        effectiveDate: null,
        reviewAfter: null,
        status: reasoning ? "current" : "unknown",
      },
    },
  };
}

/** Chunk framing sanitized from a captured hosted Nemotron 3 Super stream. */
function nimStream(model: string): Response {
  const chunk = (body: Record<string, unknown>) =>
    `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model, ...body })}\n\n`;
  return new Response(
    [
      chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "OK" } }] }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      chunk({
        choices: [],
        usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 },
      }),
      "data: [DONE]\n\n",
    ].join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function firstRequest(config: ModelEndpointConfig): Promise<Record<string, unknown>> {
  const bound = await resolveOperatorExecutionBinding({ model: config });
  const requests: Record<string, unknown>[] = [];
  const connection = await createProviderConnectionFactory({
    routeId: bound.profile.routeId,
    transport: bound.profile.transport,
    fetch: async (_request, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return nimStream(config.modelId);
    },
  }).create({ profile: bound.profile, credential: bound.credential });
  await connection.runtime
    .streamSimple(
      connection.model,
      {
        systemPrompt: "Reply OK.",
        messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
      },
      { maxTokens: 64 },
    )
    .result();
  expect(requests).toHaveLength(1);
  return requests[0]!;
}

describe("measured reasoning control on an unmatched compatible endpoint", () => {
  it("binds the control an installed composition measured for the same model", async () => {
    const bound = await resolveOperatorExecutionBinding({
      model: unmatchedCompatible(NEMOTRON_SUPER),
    });

    expect(bound.match).toBe("unmatched-byo");
    expect(bound.profile.compositionRequestPolicy).toBeUndefined();
    expect(bound.profile.measuredReasoningControl).toEqual({
      control: { kind: "chat-template-kwarg", thinking: false },
      compositionIds: [NEMOTRON_SUPER_COMPOSITION],
    });
  });

  it("sends chat_template_kwargs.thinking=false for that model", async () => {
    const request = await firstRequest(unmatchedCompatible(NEMOTRON_SUPER));

    expect(request.chat_template_kwargs).toEqual({ thinking: false });
    expect(request).not.toHaveProperty("reasoning_effort");
  });

  it("sends no reasoning control for a model no composition measured", async () => {
    const bound = await resolveOperatorExecutionBinding({
      model: unmatchedCompatible("example/unmeasured-model"),
    });
    const request = await firstRequest(unmatchedCompatible("example/unmeasured-model"));

    expect(bound.profile.measuredReasoningControl).toBeUndefined();
    expect(request).not.toHaveProperty("chat_template_kwargs");
  });

  it("leaves reasoning on when an attested profile declares it", async () => {
    const request = await firstRequest(unmatchedCompatible(NEMOTRON_SUPER, true));

    expect(request).not.toHaveProperty("chat_template_kwargs");
  });
});

describe("applyReasoningControl", () => {
  it("keeps other chat template arguments and sets thinking", () => {
    const payload: Record<string, unknown> = { chat_template_kwargs: { enable_tools: true } };
    applyReasoningControl(payload, { kind: "chat-template-kwarg", thinking: false });
    expect(payload.chat_template_kwargs).toEqual({ enable_tools: true, thinking: false });
  });

  it("prefixes the leading system message with a system directive", () => {
    const payload: Record<string, unknown> = {
      messages: [
        { role: "system", content: "Be DocsFab." },
        { role: "user", content: "Hi" },
      ],
    };
    applyReasoningControl(payload, { kind: "system-directive", directive: "/no_think" });
    expect(payload.messages).toEqual([
      { role: "system", content: "/no_think\nBe DocsFab." },
      { role: "user", content: "Hi" },
    ]);
  });

  it("refuses a directive without a leading string system message", () => {
    expect(() =>
      applyReasoningControl(
        { messages: [{ role: "user", content: "Hi" }] },
        { kind: "system-directive", directive: "/no_think" },
      ),
    ).toThrow(ProviderRequestPolicyError);
    expect(() =>
      applyReasoningControl(
        { chat_template_kwargs: "thinking" },
        { kind: "chat-template-kwarg", thinking: false },
      ),
    ).toThrow(ProviderRequestPolicyError);
  });
});

describe("unmatched endpoint output allowance", () => {
  // Output tokens of the longest single DocsFab answer recorded on a hosted
  // NIM: the evaluate-document-quality envelope from Nemotron 3 Super with
  // reasoning off. A smaller allowance cuts it and forces a continuation.
  const LONGEST_RECORDED_ANSWER_OUTPUT_TOKENS = 7_750;

  it("comes from the limits catalog and holds the longest recorded answer uncut", () => {
    expect(CONSERVATIVE_MODEL_FALLBACK).toEqual({
      contextWindow: limitDefinition("modelProfile.conservativeFallbackContextWindow").value,
      maxOutputTokens: limitDefinition("modelProfile.conservativeFallbackMaxOutputTokens").value,
    });
    expect(CONSERVATIVE_MODEL_FALLBACK.maxOutputTokens).toBeGreaterThanOrEqual(
      LONGEST_RECORDED_ANSWER_OUTPUT_TOKENS,
    );
    expect(CONSERVATIVE_MODEL_FALLBACK.contextWindow).toBeGreaterThanOrEqual(
      CONSERVATIVE_MODEL_FALLBACK.maxOutputTokens,
    );
  });
});
