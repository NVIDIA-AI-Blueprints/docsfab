// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * One-shot calls keep their own request policy: request interpretation, the
 * first-pass checks, the semantic judge, and the corpus judge send thinking
 * off, as on main, whatever reasoning the profile declares. Only an operator
 * setting for that model's slot turns their reasoning on. Pi-session turns,
 * which pass a level, follow the profile.
 */
import { afterEach, describe, expect, it } from "vitest";

import { createFirstPassSupportModelBridge } from "../src/cli/first-pass-support.js";
import {
  MODEL_SETTING_KEYS,
  type ModelSettingEntry,
  type ModelSettingKey,
  type ModelSlotSettingsV1,
} from "../src/config/model-settings.js";
import type { ModelEndpointConfig } from "../src/model/configuration.js";
import { createModelConnection } from "../src/model/provider.js";
import { configuredCorpusJudge } from "../src/quality-evaluation/corpus-cli.js";
import {
  ConfiguredEvaluationJudge,
  SEMANTIC_RUBRIC_V1,
} from "../src/quality-evaluation/semantic.js";
import { createRequestIntentModelPort } from "../src/request-intent/interpret-model.js";
import { validModelConfig } from "./helpers.js";
import {
  closeModelEndpointStubs,
  startModelUpstream,
  type ModelUpstream,
} from "./support/model-endpoint-stubs.js";

/** A placeholder key: plain words, never shaped like a real credential. */
const KEY = "one-shot-policy-orchard-meadow-key";

afterEach(async () => {
  await closeModelEndpointStubs();
});

type Route = "responses" | "messages";

/** A reasoning-on profile on one route, configured in code, so no operator set reasoning. */
function routeConfig(route: Route, baseUrl: string): ModelEndpointConfig {
  const messages = route === "messages";
  return {
    ...validModelConfig,
    providerId: messages
      ? "operator-configured-anthropic-compatible"
      : "operator-configured-openai-compatible",
    baseUrl,
    apiKey: KEY,
    modelId: messages ? "claude-opus-4-7" : "example/model",
    transport: messages ? "anthropic-messages" : "openai-responses",
    apiFormat: messages ? "messages" : "chat_completions",
    profile: {
      ...validModelConfig.profile,
      reasoning: true,
      compatibility: {
        ...validModelConfig.profile.compatibility,
        supportsReasoningEffort: false,
        apiFormats: [messages ? "messages" : "chat_completions"],
      },
    },
  };
}

/** The same profile with an operator's `reasoningEffort: high` for its slot. */
function withOperatorEffort(config: ModelEndpointConfig): ModelEndpointConfig {
  const settings = Object.fromEntries(
    MODEL_SETTING_KEYS.map((key) => [
      key,
      { value: null, source: "profile-file", origin: "profiles/byo.yaml" } as ModelSettingEntry,
    ]),
  ) as Record<ModelSettingKey, ModelSettingEntry>;
  settings.reasoningEffort = {
    value: "high",
    source: "environment",
    origin: "MODEL_REASONING_EFFORT",
  };
  const record: ModelSlotSettingsV1 = {
    schemaVersion: 1,
    slot: "writing",
    presetId: null,
    presetSource: null,
    settings,
    notes: [],
  };
  return { ...config, modelSettings: record };
}

/** Each one-shot caller, through its production entry point; a reply it rejects is fine. */
const CALLERS: Record<string, (config: ModelEndpointConfig) => Promise<unknown>> = {
  "request interpretation": (config) =>
    createRequestIntentModelPort({
      config: { model: config } as never,
      workflow: "review-documentation",
      repositoryRevision: "a".repeat(40),
      maxCalls: 1,
    })
      .call({
        systemPrompt: "Interpret the request.",
        prompt: "Review the documentation.",
        maxOutputTokens: 256,
      } as never)
      .catch(() => undefined),
  "first-pass checks": (config) =>
    createFirstPassSupportModelBridge({
      config: { retryPolicy: { maxRetries: 0 }, model: config } as never,
      repositoryRevision: "e".repeat(40),
      loadEvidenceFrameParser: async () => (() => []) as never,
    })
      .call({
        systemPrompt: "Assess repository support.",
        prompt: "Phase: obligation-decomposition\n\nReturn one bounded JSON result.",
        maxOutputTokens: 128,
        procedureId: "one-shot-policy",
        procedureSha256: "a".repeat(64),
        promptSha256: "b".repeat(64),
      })
      .catch(() => undefined),
  "semantic judge": (config) =>
    new ConfiguredEvaluationJudge(config)
      .grade({ rubric: SEMANTIC_RUBRIC_V1, evidence: {} } as never)
      .catch(() => undefined),
  "corpus judge": (config) =>
    configuredCorpusJudge(config)
      .evaluate({} as never)
      .catch(() => undefined),
};

function sent(upstream: ModelUpstream) {
  expect(upstream.requests).toHaveLength(1);
  return upstream.requests[0]!.body;
}

describe("a one-shot call keeps its own reasoning policy", () => {
  const cases = Object.keys(CALLERS).flatMap((caller) =>
    (["responses", "messages"] as const).map((route) => [caller, route] as const),
  );

  it.each(cases)("%s on %s sends thinking off, as on main", async (caller, route) => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await CALLERS[caller]!(routeConfig(route, upstream.baseUrl));

    const body = sent(upstream);
    if (route === "responses") {
      expect(body.reasoning).toEqual({ effort: "none" });
    } else {
      expect(body.thinking).toEqual({ type: "disabled" });
      expect(body).not.toHaveProperty("output_config");
    }
  });

  it.each(cases)(
    "%s on %s sends the effort an operator set for its slot",
    async (caller, route) => {
      const upstream = await startModelUpstream({ expectedKey: KEY });
      await CALLERS[caller]!(withOperatorEffort(routeConfig(route, upstream.baseUrl)));

      const body = sent(upstream);
      if (route === "responses") {
        expect(body.reasoning).toMatchObject({ effort: "high" });
      } else {
        expect(body.thinking).toMatchObject({ type: "adaptive" });
        expect(body.output_config).toEqual({ effort: "high" });
      }
    },
  );

  it.each(["responses", "messages"] as const)(
    "a Pi-session turn on %s follows the profile's reasoning (control)",
    async (route) => {
      const upstream = await startModelUpstream({ expectedKey: KEY });
      const connection = await createModelConnection(routeConfig(route, upstream.baseUrl));
      // A Pi session passes its level on every turn.
      await connection.runtime
        .completeSimple(
          connection.model,
          {
            systemPrompt: "Reply as instructed.",
            messages: [{ role: "user", content: "Reply with DOCSFAB_OK.", timestamp: 1 }],
          },
          { reasoning: "medium" },
        )
        .catch(() => undefined);

      const body = sent(upstream);
      if (route === "responses") {
        expect(body.reasoning).toMatchObject({ effort: "medium" });
      } else {
        expect(body.thinking).toMatchObject({ type: "adaptive" });
        expect(body.output_config).toEqual({ effort: "medium" });
      }
    },
  );
});
