// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { InstalledExecutionComposition } from "../model-composition/types.js";
import {
  RESEAL_COMPOSITION_DIGESTS_COMMAND,
  RESEAL_COMPOSITION_DIGESTS_SCRIPT,
  runProfileDraft,
} from "./profile-draft.js";
import { PREFIX_MATCHER_ERROR } from "./profile-probe.js";

const inferenceTemplate: InstalledExecutionComposition = {
  schemaVersion: 1,
  compositionId: "nvidia-inference-nemotron-3-ultra-pi",
  status: "active",
  executionClass: "pi-provider",
  model: {
    vendor: "nvidia",
    requestedId: "nvidia/nvidia/nemotron-3-ultra",
    resolvedId: "nvidia/nvidia/nemotron-3-ultra",
  },
  deployment: {
    bindingKind: "exact-origin",
    identitySha256: "aa".repeat(32),
    provider: "nvidia",
    region: null,
    routeId: "nvidia-inference-api",
    transport: "openai-chat-completions",
  },
  authentication: {
    credentialFamily: "nvidia-inference-api",
    mechanism: "host-secret-handle",
    route: "nvidia-inference-api",
    sourceNames: ["MODEL_API_KEY"],
  },
  harness: { id: "pi", policySha256: "bb".repeat(32) },
  adapters: {
    authentication: { id: "nvidia-inference-api-key", version: "1.0.0" },
    harness: { id: "pi-governed", version: "1.0.0" },
    providerConnection: { id: "pi-openai-compatible-nvidia-inference", version: "1.0.0" },
    routeEvidence: { id: "nvidia-inference-api-route", version: "1.0.0" },
  },
  compositionLimits: {
    contextWindow: 128000,
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
    maxProviderTurns: 128,
    maxResponseBytes: 4194304,
    timeoutMs: 300000,
  },
  limitations: ["not-technically-approved", "not-release-eligible"],
  compositionSha256: "cc".repeat(32),
};

describe("profile draft", () => {
  it("rejects gpt-5 prefix matchers with a stable error", async () => {
    await expect(
      runProfileDraft(
        {
          routeId: "nvidia-inference-api",
          modelId: "gpt-5",
          verdict: "harness-compatible",
          json: false,
        },
        { loadTemplate: async () => inferenceTemplate },
      ),
    ).rejects.toThrow(PREFIX_MATCHER_ERROR);
  });

  it("drafts a composition-shaped record with measured requestPolicy for reasoning-split-controllable", async () => {
    const draft = await runProfileDraft(
      {
        routeId: "nvidia-inference-api",
        modelId: "nvidia/nvidia/nemotron-3-ultra",
        verdict: "reasoning-split-controllable",
        json: true,
      },
      { loadTemplate: async () => inferenceTemplate },
    );
    expect(draft.kind).toBe("docsfab-profile-draft");
    expect(draft.composition.compositionId).toBe("nvidia-inference-nemotron-3-ultra-pi");
    expect(draft.composition.model.resolvedId).toBe("nvidia/nvidia/nemotron-3-ultra");
    expect(draft.composition.requestPolicy?.reasoningControl).toEqual({
      kind: "chat-template-kwarg",
      thinking: false,
    });
    expect(draft.composition.requestPolicy?.modelId).toBe("nvidia/nvidia/nemotron-3-ultra");
    expect(draft.composition.status).toBe("active");
  });

  it("omits requestPolicy for harness-compatible on an optional-policy route", async () => {
    const draft = await runProfileDraft(
      {
        routeId: "nvidia-inference-api",
        modelId: "azure/openai/gpt-5.4",
        verdict: "harness-compatible",
        json: true,
      },
      { loadTemplate: async () => inferenceTemplate },
    );
    expect(draft.composition.requestPolicy).toBeUndefined();
    expect(draft.composition.model.vendor).toBe("openai");
    expect(draft.composition.compositionId).toBe("nvidia-inference-gpt-5.4-pi");
  });

  it("names the reseal-composition-digests command without merging the registry", async () => {
    const draft = await runProfileDraft(
      {
        routeId: "nvidia-inference-api",
        modelId: "azure/openai/gpt-5.4",
        verdict: "harness-compatible",
        json: true,
      },
      { loadTemplate: async () => inferenceTemplate },
    );
    expect(draft.registryUnchanged).toBe(true);
    expect(draft.resealCommand).toBe(RESEAL_COMPOSITION_DIGESTS_COMMAND);
    expect(draft.resealScript).toBe(RESEAL_COMPOSITION_DIGESTS_SCRIPT);
    expect(draft.resealScript).toContain("reseal-composition-digests");
  });

  it("refuses unreachable probe verdicts", async () => {
    await expect(
      runProfileDraft(
        {
          routeId: "nvidia-inference-api",
          modelId: "azure/openai/gpt-5.4",
          verdict: "unreachable",
          json: false,
        },
        { loadTemplate: async () => inferenceTemplate },
      ),
    ).rejects.toThrow(
      "profile draft refuses unreachable probe verdicts and does not emit a composition.",
    );
  });
});
