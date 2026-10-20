// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ModelEndpointConfig } from "../src/model/configuration.js";
import type { ContextPreflightService } from "../src/context/contracts.js";

export const readyContextPreflight: ContextPreflightService = {
  preflight: async () => ({
    status: "ready",
    packetDigest: "a".repeat(64),
    consultedNodeIds: [],
    ontologyVersion: "test-ontology-v1",
    effectiveDecisionIds: [],
    measurements: {
      byteLength: 0,
      estimatedTokens: 0,
      latencyMs: 0,
      nodeCount: 0,
      edgeCount: 0,
      pathCount: 0,
    },
    cache: {
      disposition: "disabled",
      rebuildAttempted: true,
    },
    packet: {
      schemaVersion: 1,
      digest: "a".repeat(64),
    },
  }),
};

export const validModelEnvironment = {
  MODEL_PROVIDER: "test-provider",
  MODEL_BASE_URL: "https://inference.example.test/v1/",
  MODEL_ID: "example/model",
  MODEL_API_FORMAT: "chat_completions",
  MODEL_API_KEY: "test-secret",
  MODEL_CONTEXT_WINDOW: "128000",
  MODEL_MAX_OUTPUT_TOKENS: "16384",
  MODEL_API_MIN_OUTPUT_TOKENS: "16",
  MODEL_CONTEXT_RESERVE_TOKENS: "4096",
  MODEL_REASONING: "true",
  MODEL_INPUT_TYPES: "text,image",
  MODEL_SUPPORTS_DEVELOPER_ROLE: "true",
  MODEL_SUPPORTS_REASONING_EFFORT: "true",
  MODEL_COMPATIBLE_API_FORMATS: "chat_completions",
  MODEL_INPUT_COST_PER_MILLION: "1.25",
  MODEL_OUTPUT_COST_PER_MILLION: "10",
  MODEL_CACHE_READ_COST_PER_MILLION: "0.5",
  MODEL_CACHE_WRITE_COST_PER_MILLION: "unknown",
  MODEL_PROFILE_APPROVED_SOURCE: "https://metadata.example.test/models/example-model",
  MODEL_PROFILE_EFFECTIVE_DATE: "2020-01-01",
  MODEL_PROFILE_REVIEW_AFTER: "2099-12-31",
};

export const validModelConfig: ModelEndpointConfig = {
  providerId: "test-provider",
  baseUrl: "https://inference.example.test/v1",
  modelId: "example/model",
  apiFormat: "chat_completions",
  api: "openai-completions",
  apiKey: "test-secret",
  requestPolicy: {
    minimumOutputTokens: 16,
    reservedContextTokens: 4_096,
  },
  profile: {
    configuredLimits: {
      contextWindow: 128_000,
      maxInputTokens: 128_000,
      maxOutputTokens: 16_384,
    },
    contextWindow: 128_000,
    maxInputTokens: 128_000,
    maxOutputTokens: 16_384,
    effectiveLimitReason: "none",
    reasoning: true,
    input: ["text", "image"],
    compatibility: {
      supportsDeveloperRole: true,
      supportsReasoningEffort: true,
      apiFormats: ["chat_completions"],
    },
    costPerMillionTokens: {
      input: 1.25,
      output: 10,
      cacheRead: 0.5,
      cacheWrite: null,
    },
    metadata: {
      approvedSource: "https://metadata.example.test/models/example-model",
      effectiveDate: "2020-01-01",
      reviewAfter: "2099-12-31",
      status: "current",
    },
  },
};
