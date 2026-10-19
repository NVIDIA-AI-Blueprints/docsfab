// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import { loadCompositionExecutionEnvelope } from "../src/config/runtime-loader.js";
import { loadCompositionRunRuntime } from "../src/cli/run/composition-runtime.js";
import type { RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import { InferenceStepError } from "../src/execution/contracts.js";
import { toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";
import { resolveCompositionLeaseShape } from "../src/harness/pi-offline.js";
import { ContextBudgetError, preflightContextBudget } from "../src/model/context-budget.js";
import { DOCUMENTATION_PLAN_FAILURES } from "../src/workflow-execution/plan-binding.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import {
  decodeSourceObligationResponse,
  sourceObligationRejectionMessage,
} from "../src/workflow-execution/source-obligation.js";
import { validModelConfig, validModelEnvironment } from "./helpers.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";
import {
  bindAnswerRecordDiscoveryExecutionV1,
  decodeAnswerRecordDiscoveryExecutionV1,
} from "../src/records/answer-record-discovery.js";

const HUB_BASE_URL = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];

/**
 * Executable lanes this file binds by their real identity. `apiFormat` is per
 * lane because the direct Anthropic route speaks `messages`, not
 * `chat_completions`; defaulting it would silently exclude the only non-OpenAI
 * transport from the negative side of the budget assertions.
 */
const LANE = {
  claudeSonnet5Hub: {
    compositionId: "nvidia-inference-claude-sonnet-5-pi",
    providerId: "nvidia-inference-api",
    baseUrl: HUB_BASE_URL,
    modelId: "aws/anthropic/bedrock-claude-sonnet-5",
  },
  claudeOpus5Hub: {
    compositionId: "nvidia-inference-claude-opus-5-pi",
    providerId: "nvidia-inference-api",
    baseUrl: HUB_BASE_URL,
    modelId: "aws/anthropic/bedrock-claude-opus-5",
  },
  nemotron120b: {
    compositionId: "nvidia-nemotron-3-super-120b-a12b-pi",
    providerId: "nvidia-api-catalog",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    modelId: "nvidia/nemotron-3-super-120b-a12b",
  },
  nemotron3SuperV3Hub: {
    compositionId: "nvidia-inference-nemotron-3-super-v3-pi",
    providerId: "nvidia-inference-api",
    baseUrl: HUB_BASE_URL,
    modelId: "nvidia/nvidia/nemotron-3-super-v3",
  },
  claudeOpus47Direct: {
    compositionId: "anthropic-claude-opus-4.7-pi",
    providerId: "anthropic-api",
    baseUrl: "https://api.anthropic.com/v1",
    modelId: "claude-opus-4-7",
    apiFormat: "messages" as const,
  },
} as const;

const REQUEST_BASE = {
  workflow: "review-documentation",
  repositoryPath: "/tmp/docsfab-composition-target",
  revision: "HEAD",
  allowWrite: false,
  releaseGate: false,
  verbose: false,
  json: false,
  showScan: false,
} as const;

function request(
  compositionId: string,
  experimentalAnswerRecords = false,
): RunRequestWithPublishProjection {
  return {
    ...REQUEST_BASE,
    compositionId,
    ...(experimentalAnswerRecords ? { experimentalAnswerRecords: true } : {}),
  };
}

function config(input: {
  providerId: string;
  baseUrl: string;
  modelId: string;
  apiFormat?: "chat_completions" | "messages";
  compatibleFormats: Array<"chat_completions" | "messages">;
  hostLimit?: number;
  outputLimit?: number;
}): DocsFabConfig {
  return {
    projectRoot: "/opt/docsfab/runtime",
    skillCrateDirectory: "/opt/docsfab/runtime/skill-crate",
    qualityDirectory: "/opt/docsfab/runtime/quality",
    qualityPackDirectory: "/opt/docsfab/runtime/quality-pack",
    stateDirectory: "/tmp/docsfab-state/runs",
    retryPolicy: {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
      retryableCategories: [
        "blank-response",
        "malformed-response",
        "timeout",
        "throttled",
        "provider-transient",
      ],
    },
    model: {
      ...validModelConfig,
      providerId: input.providerId,
      baseUrl: input.baseUrl,
      modelId: input.modelId,
      apiFormat: input.apiFormat ?? "chat_completions",
      apiKey: "selected-test-credential",
      profile: {
        ...validModelConfig.profile,
        configuredLimits: {
          contextWindow: input.hostLimit ?? 128_000,
          maxInputTokens: input.hostLimit ?? 128_000,
          maxOutputTokens: input.outputLimit ?? 16_384,
        },
        compatibility: {
          ...validModelConfig.profile.compatibility,
          apiFormats: input.compatibleFormats,
        },
      },
    },
  };
}

describe("composition runtime composition binding", () => {
  it("raises output only for explicit Nemotron 3 Super discovery and reads legacy evidence", async () => {
    const nemotron = {
      providerId: "nvidia-api-catalog",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      modelId: "nvidia/nemotron-3-super-120b-a12b",
      compatibleFormats: ["chat_completions"] satisfies ("chat_completions" | "messages")[],
      outputLimit: 32_768,
    };
    const sealed = await loadCompositionRunRuntime(
      request("nvidia-nemotron-3-super-120b-a12b-pi"),
      config(nemotron),
      {},
    );
    // The operator's configured output wins over the preset's 8,192 on the
    // composition path too; discovery keeps the hosted endpoint's own cap.
    expect(sealed.executionProfile.profile.maxOutputTokens).toBe(32_768);

    const discovery = await loadCompositionRunRuntime(
      request("nvidia-nemotron-3-super-120b-a12b-pi", true),
      config(nemotron),
      {},
    );
    const discoveryEvidence = discovery.answerRecordDiscovery;
    if (!discoveryEvidence) throw new Error("discovery evidence was not produced");
    expect(discovery.executionProfile.profile.maxOutputTokens).toBe(32_768);
    expect(discovery.answerRecordDiscovery?.bounds.effective.model.maxOutputTokens).toBe(32_768);
    expect(discovery.answerRecordDiscovery?.qualification).toBe("unqualified");
    expect(discoveryEvidence.bounds.effective.providerExecution).toEqual({
      policyVersion: 2,
      scope: "answer-record-evaluator-step",
      aggregatePolicy: { kind: "absent" },
      maxResponseBytes: Math.min(
        discoveryEvidence.bounds.configuredHost.maxResponseBytes,
        discoveryEvidence.bounds.packageCeiling.maxResponseBytes,
      ),
    });

    const draft = discoveryEvidence;
    const legacyDraft = {
      ...draft,
      bounds: {
        ...draft.bounds,
        effective: {
          ...draft.bounds.effective,
          providerExecution: {
            maxProviderTurns: Math.min(
              draft.bounds.configuredHost.maxProviderTurns,
              draft.bounds.packageCeiling.maxProviderTurns,
            ),
            timeoutMs: Math.min(
              draft.bounds.configuredHost.timeoutMs,
              draft.bounds.packageCeiling.timeoutMs,
            ),
            maxResponseBytes: draft.bounds.effective.providerExecution.maxResponseBytes,
          },
          model: { ...draft.bounds.effective.model, maxOutputTokens: 8_192 },
        },
      },
    };
    const binding = {
      runId: "run-output-capacity-test",
      workflow: "review-documentation",
      repositoryRevision: "HEAD",
      repositoryIdentitySha256: "a".repeat(64),
    };
    expect(
      decodeAnswerRecordDiscoveryExecutionV1(
        bindAnswerRecordDiscoveryExecutionV1(legacyDraft, binding),
      ).bounds.effective.model.maxOutputTokens,
    ).toBe(8_192);
    expect(
      decodeAnswerRecordDiscoveryExecutionV1(bindAnswerRecordDiscoveryExecutionV1(draft, binding))
        .bounds.effective.model.maxOutputTokens,
    ).toBe(32_768);

    const malformedTransportDraft = {
      ...draft,
      composition: {
        ...draft.composition,
        deployment: {
          ...draft.composition.deployment,
          transport: ["openai-chat-completions"],
        },
      },
    };
    expect(() =>
      decodeAnswerRecordDiscoveryExecutionV1(
        bindAnswerRecordDiscoveryExecutionV1(malformedTransportDraft as never, binding),
      ),
    ).toThrow("Answer-record discovery composition identity is invalid");

    const impossibleNewPolicyDraft = {
      ...draft,
      bounds: {
        ...draft.bounds,
        configuredHost: { ...draft.bounds.configuredHost, maxOutputTokens: 32_769 },
      },
    };
    expect(() =>
      decodeAnswerRecordDiscoveryExecutionV1(
        bindAnswerRecordDiscoveryExecutionV1(impossibleNewPolicyDraft, binding),
      ),
    ).toThrow("effective bounds do not match their sources");

    await expect(
      loadCompositionRunRuntime(
        request("nvidia-nemotron-3-super-120b-a12b-pi", true),
        config({ ...nemotron, outputLimit: 32_769 }),
        {},
      ),
    ).rejects.toMatchObject({
      code: "nemotron-3-super-hosted-output-tokens-bound",
      observed: 32_769,
    });

    const siblingDiscovery = await loadCompositionRunRuntime(
      request("nvidia-nemotron-3.5-lightning-30b-a3b-pi", true),
      config({
        ...nemotron,
        modelId: "nvidia/nemotron-3.5-lightning-30b-a3b",
      }),
      {},
    );
    // The sibling lane has no hosted discovery cap, so the operator's 32,768 stands.
    expect(siblingDiscovery.executionProfile.profile.maxOutputTokens).toBe(32_768);
  });

  it.each([
    {
      compositionId: "nvidia-nemotron-3-super-120b-a12b-pi",
      providerId: "nvidia-api-catalog",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      modelId: "nvidia/nemotron-3-super-120b-a12b",
      apiFormat: "chat_completions" as const,
      compatibleFormats: ["chat_completions"] as const,
      transport: "openai-chat-completions",
      credentialFamily: "nvidia-api-catalog",
      effectiveContextWindow: 128_000,
    },
    {
      // Claude through the Inference Hub: same OpenAI-compatible transport and
      // credential family as the Nemotron hub lanes, but no installed request
      // policy, so the provider-neutral finalizer drives it.
      compositionId: "nvidia-inference-claude-sonnet-5-pi",
      providerId: "nvidia-inference-api",
      baseUrl: HUB_BASE_URL,
      modelId: "aws/anthropic/bedrock-claude-sonnet-5",
      apiFormat: "chat_completions" as const,
      compatibleFormats: ["chat_completions"] as const,
      transport: "openai-chat-completions",
      credentialFamily: "nvidia-inference-api",
      effectiveContextWindow: 128_000,
    },
    {
      // GPT-6 Sol through the Inference Hub, the successor of the retired
      // direct OpenAI GPT-5.6 Sol record.
      compositionId: "nvidia-inference-gpt-6-sol-pi",
      providerId: "nvidia-inference-api",
      baseUrl: HUB_BASE_URL,
      modelId: "azure/openai/gpt-6-sol",
      apiFormat: "chat_completions" as const,
      compatibleFormats: ["chat_completions"] as const,
      transport: "openai-chat-completions",
      credentialFamily: "nvidia-inference-api",
      effectiveContextWindow: 128_000,
    },
    {
      compositionId: "anthropic-claude-opus-4.7-pi",
      providerId: "anthropic-api",
      baseUrl: "https://api.anthropic.com/v1",
      modelId: "claude-opus-4-7",
      apiFormat: "messages" as const,
      compatibleFormats: ["messages"] as const,
      transport: "anthropic-messages",
      credentialFamily: "anthropic-api",
      effectiveContextWindow: 65_536,
    },
  ])(
    "binds $compositionId without inferring route or credential family from the model",
    async ({
      compositionId,
      providerId,
      baseUrl,
      modelId,
      apiFormat,
      compatibleFormats,
      transport,
      credentialFamily,
      effectiveContextWindow,
    }) => {
      const runtime = await loadCompositionRunRuntime(
        request(compositionId),
        config({
          providerId,
          baseUrl,
          modelId,
          apiFormat,
          compatibleFormats: [...compatibleFormats],
        }),
        {
          DOCSFAB_COMPOSITION_EXECUTION_MAX_PROVIDER_TURNS: "3",
          DOCSFAB_COMPOSITION_EXECUTION_TIMEOUT_MS: "120000",
          DOCSFAB_COMPOSITION_EXECUTION_MAX_RESPONSE_BYTES: "32768",
        },
      );

      expect(runtime.bound.composition.compositionId).toBe(compositionId);
      expect(runtime.executionProfile).toMatchObject({
        routeId: runtime.bound.composition.deployment.routeId,
        modelId,
        transport,
        compositionPolicy: {
          maxProviderTurns: 3,
          timeoutMs: 120_000,
          maxResponseBytes: 32_768,
        },
      });
      expect(runtime.credential).toEqual({
        family: credentialFamily,
        apiKey: "selected-test-credential",
      });
      expect(runtime.configuredLimits).toEqual({
        contextWindow: 128_000,
        maxInputTokens: 128_000,
        maxOutputTokens: 16_384,
        maxProviderTurns: 3,
        timeoutMs: 120_000,
        maxResponseBytes: 32_768,
      });
      // The operator's configured windows win over each preset's own (8,192
      // output on most lanes, 65,536 context on Opus 4.7); the preset's values
      // stay on the bound record.
      void effectiveContextWindow;
      expect(runtime.executionProfile.profile).toMatchObject({
        contextWindow: 128_000,
        maxInputTokens: 128_000,
        maxOutputTokens: 16_384,
        effectiveLimitReason: "composition-candidate",
      });
      expect(runtime.bound.composition.compositionLimits.maxOutputTokens).toBeGreaterThan(0);
      // The execution profile carries the installed policy exactly when the
      // record declares one; a policyless record must not grow one here.
      if (runtime.bound.composition.requestPolicy) {
        expect(runtime.executionProfile.compositionRequestPolicy).toEqual(
          runtime.bound.composition.requestPolicy,
        );
      } else {
        expect(runtime.executionProfile).not.toHaveProperty("compositionRequestPolicy");
      }
      expect(runtime.executionProfile).not.toHaveProperty("apiKey");
      expect(runtime.config.retryPolicy).toEqual({
        maxRetries: 3,
        baseDelayMs: 1,
        maxDelayMs: 1,
        retryableCategories: [
          "blank-response",
          "malformed-response",
          "timeout",
          "throttled",
          "provider-transient",
        ],
      });
    },
  );

  it("runs endpoint, model, and route drift on the preset and warns, never refusing", async () => {
    const selected = request("anthropic-claude-opus-4.7-pi");
    const configured = config({
      providerId: "anthropic-api",
      baseUrl: "https://api.anthropic.com/v1",
      modelId: "claude-opus-4-7",
      apiFormat: "messages",
      compatibleFormats: ["messages"],
    });
    // The preset's own values, reasoning off included.
    const exact: DocsFabConfig = {
      ...configured,
      model: { ...configured.model, profile: { ...configured.model.profile, reasoning: false } },
    };

    // Control: the preset's own values bind with nothing to warn about.
    const bound = await loadCompositionRunRuntime(selected, exact, {});
    expect(bound.bound.composition.compositionId).toBe("anthropic-claude-opus-4.7-pi");
    expect(bound.notes).toEqual([]);

    const route = await loadCompositionRunRuntime(selected, {
      ...exact,
      model: { ...exact.model, providerId: "nvidia-inference-api" },
    });
    expect(route.executionProfile.routeId).toBe("anthropic-api");
    expect(route.notes).toContainEqual(
      expect.stringContaining("The configured provider route nvidia-inference-api is not preset"),
    );
    const endpoint = await loadCompositionRunRuntime(selected, {
      ...exact,
      model: { ...exact.model, baseUrl: "https://llm-gateway.example.test/v1" },
    });
    expect(endpoint.executionProfile.baseUrl).toBe("https://llm-gateway.example.test/v1");
    expect(endpoint.notes).toContainEqual(
      expect.stringContaining("endpoint https://llm-gateway.example.test differs from preset"),
    );
    const model = await loadCompositionRunRuntime(selected, {
      ...exact,
      model: { ...exact.model, modelId: "aws/anthropic/claude-opus-4-7" },
    });
    expect(model.executionProfile.modelId).toBe("aws/anthropic/claude-opus-4-7");
    expect(model.notes).toContainEqual(
      expect.stringContaining("model aws/anthropic/claude-opus-4-7 differs from preset"),
    );
  });

  it("refuses the retired direct OpenAI GPT-5.6 Sol composition before route binding", async () => {
    // #1512 retired this record by operator decision. Its exact historical
    // configuration must now stop at the retirement, naming the GPT-6 Sol
    // successor, before any route, model, or credential comparison runs.
    await expect(
      loadCompositionRunRuntime(
        request("openai-gpt-5.6-sol-pi"),
        config({
          providerId: "openai-api",
          baseUrl: "https://api.openai.com/v1",
          modelId: "gpt-5.6-sol",
          compatibleFormats: ["chat_completions"],
        }),
        {},
      ),
    ).rejects.toMatchObject({
      code: "composition-retired",
      message:
        'Composition "openai-gpt-5.6-sol-pi" is retired (superseded-by-operator-decision, effective 2026-09-28T00:00:00.000Z) and cannot be selected for a new execution.',
      nextAction: expect.stringContaining("nvidia-inference-gpt-6-sol-pi"),
    });
  });

  it("loads direct Anthropic from only its selected route credential", async () => {
    const environment = {
      ...validModelEnvironment,
      MODEL_PROVIDER: "anthropic-api",
      MODEL_BASE_URL: "https://api.anthropic.com/v1",
      MODEL_ID: "claude-opus-4-7",
      MODEL_API_FORMAT: "messages",
      MODEL_API_KEY: "",
      MODEL_COMPATIBLE_API_FORMATS: "messages",
      ANTHROPIC_API_KEY: "anthropic-selected-test-secret",
      JUDGE_ENABLED: "false",
    };

    const runtime = await loadCompositionRunRuntime(
      request("anthropic-claude-opus-4.7-pi"),
      undefined,
      environment,
    );

    expect(runtime.credentialSourceName).toBe("ANTHROPIC_API_KEY");
    expect(runtime.credential).toEqual({
      family: "anthropic-api",
      apiKey: "anthropic-selected-test-secret",
    });
    expect(runtime.executionProfile).toMatchObject({
      transport: "anthropic-messages",
      apiFormat: "messages",
    });

    await expect(
      loadCompositionRunRuntime(request("anthropic-claude-opus-4.7-pi"), undefined, {
        ...environment,
        MODEL_API_KEY: "second-test-secret",
      }),
    ).rejects.toThrow("ambiguous credential sources");
  });

  it("loads NVIDIA API Catalog from only DOCSFAB_NVIDIA_API_KEY", async () => {
    const environment = {
      ...validModelEnvironment,
      // Reasoning on would run without the preset's reasoning-off request policy.
      MODEL_REASONING: "false",
      MODEL_SUPPORTS_REASONING_EFFORT: "false",
      MODEL_PROVIDER: "nvidia-api-catalog",
      MODEL_BASE_URL: "https://integrate.api.nvidia.com/v1",
      MODEL_ID: "nvidia/nemotron-3-super-120b-a12b",
      MODEL_API_FORMAT: "chat_completions",
      MODEL_API_KEY: "ambient-model-secret",
      MODEL_COMPATIBLE_API_FORMATS: "chat_completions",
      NVIDIA_API_KEY: "ambient-nvidia-secret",
      NGC_API_KEY: "ambient-ngc-secret",
      DOCSFAB_NVIDIA_API_KEY: "catalog-selected-test-secret",
      JUDGE_ENABLED: "false",
    };

    const runtime = await loadCompositionRunRuntime(
      request("nvidia-nemotron-3-super-120b-a12b-pi"),
      undefined,
      environment,
    );

    expect(runtime.credentialSourceName).toBe("DOCSFAB_NVIDIA_API_KEY");
    expect(runtime.credential).toEqual({
      family: "nvidia-api-catalog",
      apiKey: "catalog-selected-test-secret",
    });
    expect(runtime.bound.composition.authentication.sourceNames).toEqual([
      "DOCSFAB_NVIDIA_API_KEY",
    ]);
    expect(runtime.executionProfile.compositionRequestPolicy).toEqual(
      runtime.bound.composition.requestPolicy,
    );
    expect(runtime.executionProfile.profile.compatibility.supportsDeveloperRole).toBe(false);

    await expect(
      loadCompositionRunRuntime(request("nvidia-nemotron-3-super-120b-a12b-pi"), undefined, {
        ...environment,
        DOCSFAB_NVIDIA_API_KEY: "",
      }),
    ).rejects.toThrow("selected executable composition credential is unavailable");
  });

  it("refuses the retired NVIDIA composition before credential or route binding", async () => {
    // The provider retired this model; the registry record is retained for
    // provenance, but a new execution must fail closed with the reason and
    // instant in the message.
    const nvidia = {
      providerId: "nvidia-api-catalog",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      modelId: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
      compatibleFormats: ["chat_completions"] as const,
    };
    await expect(
      loadCompositionRunRuntime(
        request("nvidia-llama-3.3-nemotron-super-49b-v1.5-pi"),
        config({ ...nvidia, compatibleFormats: [...nvidia.compatibleFormats] }),
        {},
      ),
    ).rejects.toThrow(
      'Composition "nvidia-llama-3.3-nemotron-super-49b-v1.5-pi" is retired (provider-end-of-life, effective 2026-08-26T09:00:00.000Z) and cannot be selected for a new execution.',
    );
    // Positive control: the same request shape against a live NVIDIA API
    // Catalog record binds, so the refusal above is the retirement and not a
    // broken fixture.
    const live = await loadCompositionRunRuntime(
      request("nvidia-nemotron-3-super-120b-a12b-pi"),
      config({
        ...nvidia,
        modelId: "nvidia/nemotron-3-super-120b-a12b",
        compatibleFormats: [...nvidia.compatibleFormats],
      }),
      {},
    );
    expect(live.bound.composition.status).toBe("active");
  });

  it("uses the operator's configured windows on every lane and records each preset's own", async () => {
    // Host configured above every sealed source: the operator's value wins,
    // and the record keeps the preset and package values beside it.
    const raised = await loadCompositionRunRuntime(
      request("nvidia-nemotron-3-super-120b-a12b-pi"),
      config({
        providerId: "nvidia-api-catalog",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        modelId: "nvidia/nemotron-3-super-120b-a12b",
        compatibleFormats: ["chat_completions"],
        hostLimit: 1_000_000,
      }),
      {},
    );
    // The operator's configured windows win on every lane; each preset's own
    // stays on the bound record.
    expect(raised.executionProfile.profile).toMatchObject({
      contextWindow: 1_000_000,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 16_384,
      configuredLimits: { contextWindow: 1_000_000, maxInputTokens: 1_000_000 },
    });
    expect(raised.bound.composition.compositionLimits.contextWindow).toBe(524_288);
    // The package ceiling is the registry maximum (GPT-6 Sol's Hub Metadata
    // 1,050,000 since #1454); the 120B lane stays at its own sealed 524,288.
    expect(raised.bound.compositionCeiling.contextWindow).toBe(1_050_000);

    const siblingLane = await loadCompositionRunRuntime(
      request("nvidia-nemotron-3.5-lightning-30b-a3b-pi"),
      config({
        providerId: "nvidia-api-catalog",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        modelId: "nvidia/nemotron-3.5-lightning-30b-a3b",
        compatibleFormats: ["chat_completions"],
        hostLimit: 1_000_000,
      }),
      {},
    );
    expect(siblingLane.executionProfile.profile).toMatchObject({
      contextWindow: 1_000_000,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 16_384,
    });
    expect(siblingLane.bound.composition.compositionLimits.contextWindow).toBe(128_000);

    const directLane = await loadCompositionRunRuntime(
      request("anthropic-claude-opus-4.7-pi"),
      config({
        providerId: "anthropic-api",
        baseUrl: "https://api.anthropic.com/v1",
        modelId: "claude-opus-4-7",
        apiFormat: "messages",
        compatibleFormats: ["messages"],
        hostLimit: 1_000_000,
      }),
      {},
    );
    expect(directLane.executionProfile.profile).toMatchObject({
      contextWindow: 1_000_000,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 16_384,
    });
    expect(directLane.bound.composition.compositionLimits.contextWindow).toBe(65_536);
  });

  /**
   * Resolve one lane as the product does and report both per-step budgets: the
   * attempt timer (`compositionPolicy.timeoutMs`, consumed in `harness/pi.ts`) and
   * the tool ceiling (`resolveCompositionLeaseShape`, the call
   * `createPiExecutionLeaseController` makes in `harness/pi-offline.ts`).
   *
   * The environment is `{}` so the loader returns the shipped host defaults, the
   * same `host` term a deployed host with no override gets. A hand-written limit
   * here would hide a wrong shipped default.
   */
  async function perStepBudgets(lane: (typeof LANE)[keyof typeof LANE]) {
    const apiFormat = "apiFormat" in lane ? lane.apiFormat : ("chat_completions" as const);
    const runtime = await loadCompositionRunRuntime(
      request(lane.compositionId),
      config({
        providerId: lane.providerId,
        baseUrl: lane.baseUrl,
        modelId: lane.modelId,
        apiFormat,
        compatibleFormats: [apiFormat],
      }),
      {},
    );
    const policy = runtime.executionProfile.compositionPolicy!;
    return {
      timeoutMs: policy.timeoutMs,
      maxProviderTurns: policy.maxProviderTurns,
      maxToolCalls: resolveCompositionLeaseShape(
        loadCompositionExecutionEnvelope({}),
        policy.maxProviderTurns,
      ).hardToolCallCeiling,
    };
  }

  it("gives the two hub Claude lanes the raised per-step budgets and no other lane", async () => {
    // A 300_000 ms step timer ends long hosted review steps while they are
    // still working. 1_800_000 is asserted as a literal rather than derived from
    // the four sources it is the minimum of: deriving it would re-run the
    // implementation's own `Math.min`, and the failure mode is one of those
    // sources silently staying at 300_000 and winning.
    for (const lane of [LANE.claudeSonnet5Hub, LANE.claudeOpus5Hub]) {
      const budgets = await perStepBudgets(lane);
      expect(budgets, lane.compositionId).toEqual({
        timeoutMs: 1_800_000,
        maxProviderTurns: 512,
        maxToolCalls: 400,
      });
    }

    // Lane scoping. These lanes seal 128 provider turns and 300_000 ms of their
    // own, so the raised host default and package ceiling do not affect them:
    // the minimum lands on their own sealed value. Their tool ceiling is neither
    // 100 nor 400: at 128 turns the shape search is bound by `turns - leases`,
    // which yields 126, pinned as a literal for the same reason as above.
    // One lane per executable route family: NVIDIA catalog, NVIDIA Inference Hub,
    // and Anthropic direct on `messages` (OpenAI direct has none since #1512).
    // The hub lane is load-bearing: it shares a route with the raised records,
    // so a route-scoped rather than record-scoped raise would wrongly lift it.
    for (const lane of [LANE.nemotron120b, LANE.nemotron3SuperV3Hub, LANE.claudeOpus47Direct]) {
      const budgets = await perStepBudgets(lane);
      expect(budgets, lane.compositionId).toEqual({
        timeoutMs: 300_000,
        maxProviderTurns: 128,
        maxToolCalls: 126,
      });
    }
  });

  it("keeps the repaired NVIDIA limit arithmetic fail-closed at every boundary", async () => {
    const runtime = await loadCompositionRunRuntime(
      request("nvidia-nemotron-3-super-120b-a12b-pi"),
      config({
        providerId: "nvidia-api-catalog",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        modelId: "nvidia/nemotron-3-super-120b-a12b",
        compatibleFormats: ["chat_completions"],
      }),
      {},
    );
    // The operator's configured 16,384 output wins over the preset's 8,192.
    expect(runtime.executionProfile.profile).toMatchObject({
      contextWindow: 128_000,
      maxInputTokens: 128_000,
      maxOutputTokens: 16_384,
    });

    const budget = (estimatedInputTokens: number) =>
      preflightContextBudget({
        configuredContextWindow: 128_000,
        effectiveContextWindow: runtime.executionProfile.profile.contextWindow,
        configuredMaxInputTokens: 128_000,
        effectiveMaxInputTokens: runtime.executionProfile.profile.maxInputTokens,
        configuredMaxOutputTokens: 16_384,
        effectiveMaxOutputTokens: runtime.executionProfile.profile.maxOutputTokens,
        reservedTokens: 4_096,
        estimatedInputTokens,
        requiredMinimumOutputTokens: 16,
      });

    expect(budget(59_048).outputTokens).toBe(16_384);
    expect(budget(115_712).outputTokens).toBe(8_192);
    expect(budget(123_888).outputTokens).toBe(16);
    expect(() => budget(123_889)).toThrow(ContextBudgetError);
    expect(() => budget(123_905)).toThrow(ContextBudgetError);

    const host65 = await loadCompositionRunRuntime(
      request("nvidia-nemotron-3-super-120b-a12b-pi"),
      config({
        providerId: "nvidia-api-catalog",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        modelId: "nvidia/nemotron-3-super-120b-a12b",
        compatibleFormats: ["chat_completions"],
        hostLimit: 65_536,
      }),
      {},
    );
    expect(host65.executionProfile.profile).toMatchObject({
      contextWindow: 65_536,
      maxInputTokens: 65_536,
      maxOutputTokens: 16_384,
    });
  });
});

// The fenced fixture does not parse, so the recorded reason is the strict
// JSON parser's own `malformed-json` over the whole response.
const SOURCE_OBLIGATION_MALFORMED = sourceObligationRejectionMessage("malformed-json", "$response");
const PLANNER_INVALID_JSON = DOCUMENTATION_PLAN_FAILURES["invalid-json"];

const READ_ONLY_RETRY_POLICY = {
  maxRetries: 1,
  baseDelayMs: 1,
  maxDelayMs: 1,
  retryableCategories: [
    "blank-response",
    "malformed-response",
    "timeout",
    "throttled",
    "provider-transient",
  ],
} as const;

async function runCompositionReadOnlyStep(
  policy: DocsFabConfig["retryPolicy"],
  execute: () => Promise<{ summary: string }>,
) {
  return executeInferenceStep({
    mode: "read-only",
    policy,
    sleep: async () => undefined,
    execute,
  });
}

function throwPlannerInvalidJson(): never {
  throw new InferenceStepError(PLANNER_INVALID_JSON, "malformed-response", true);
}

function decodeMalformedSourceObligation(): never {
  // A fence whose body is not strict JSON. A fence around a valid document is
  // unwrapped and admitted, so the fixture is malformed in the body, not the
  // envelope.
  decodeSourceObligationResponse("```json\n{oops}\n```");
  throw new Error("expected malformed source-obligation decode to throw");
}

describe("composition runtime step retry policy", () => {
  it("keeps the configured read-only retry bound instead of clamping to a single attempt", async () => {
    const injected = config({
      providerId: "nvidia-inference-api",
      baseUrl: HUB_BASE_URL,
      modelId: "aws/anthropic/bedrock-claude-sonnet-5",
      compatibleFormats: ["chat_completions"],
    });
    const runtime = await loadCompositionRunRuntime(
      request("nvidia-inference-claude-sonnet-5-pi"),
      { ...injected, retryPolicy: { ...READ_ONLY_RETRY_POLICY } },
    );

    expect(runtime.config.retryPolicy).toEqual(READ_ONLY_RETRY_POLICY);
    expect(runtime.config.retryPolicy.maxRetries).toBe(1);
  });

  it("records the observed single-attempt malformed-response stop when maxRetries is 0", async () => {
    const clamped = { ...READ_ONLY_RETRY_POLICY, maxRetries: 0 };
    let sourceCalls = 0;
    const sourceExecution = await runCompositionReadOnlyStep(clamped, async () => {
      sourceCalls += 1;
      decodeMalformedSourceObligation();
    });
    let plannerCalls = 0;
    const plannerExecution = await runCompositionReadOnlyStep(clamped, async () => {
      plannerCalls += 1;
      throwPlannerInvalidJson();
    });

    expect(sourceExecution.status).toBe("failed");
    expect(plannerExecution.status).toBe("failed");
    if (sourceExecution.status !== "failed" || plannerExecution.status !== "failed") {
      throw new Error("expected failed executions");
    }
    expect(sourceExecution.error).toMatchObject({
      message: SOURCE_OBLIGATION_MALFORMED,
      category: "malformed-response",
      retryable: true,
    });
    expect(plannerExecution.error).toMatchObject({
      message: PLANNER_INVALID_JSON,
      category: "malformed-response",
      retryable: true,
    });
    expect(sourceCalls).toBe(1);
    expect(plannerCalls).toBe(1);
    expect(sourceExecution.evidence).toMatchObject({
      configuredMaxRetries: 0,
      effectiveMaxRetries: 0,
      attempts: [
        {
          attempt: 1,
          outcome: "malformed-response",
          retryable: true,
          retryScheduled: false,
        },
      ],
    });
    expect(plannerExecution.evidence).toMatchObject({
      configuredMaxRetries: 0,
      effectiveMaxRetries: 0,
      attempts: [
        {
          attempt: 1,
          outcome: "malformed-response",
          retryable: true,
          retryScheduled: false,
        },
      ],
    });
  });

  it("retries composition read-only malformed-response failures up to the configured bound", async () => {
    const runtime = await loadCompositionRunRuntime(
      request("nvidia-inference-claude-sonnet-5-pi"),
      config({
        providerId: "nvidia-inference-api",
        baseUrl: HUB_BASE_URL,
        modelId: "aws/anthropic/bedrock-claude-sonnet-5",
        compatibleFormats: ["chat_completions"],
      }),
    );
    const policy = { ...runtime.config.retryPolicy, ...READ_ONLY_RETRY_POLICY };
    let sourceCalls = 0;
    const sourceExecution = await runCompositionReadOnlyStep(policy, async () => {
      sourceCalls += 1;
      decodeMalformedSourceObligation();
    });
    let plannerCalls = 0;
    const plannerExecution = await runCompositionReadOnlyStep(policy, async () => {
      plannerCalls += 1;
      throwPlannerInvalidJson();
    });

    expect(runtime.config.retryPolicy.maxRetries).toBe(3);
    expect(sourceExecution.status).toBe("failed");
    expect(plannerExecution.status).toBe("failed");
    if (sourceExecution.status !== "failed" || plannerExecution.status !== "failed") {
      throw new Error("expected failed executions");
    }
    expect(sourceExecution.error).toMatchObject({
      message: SOURCE_OBLIGATION_MALFORMED,
      category: "malformed-response",
    });
    expect(plannerExecution.error).toMatchObject({
      message: PLANNER_INVALID_JSON,
      category: "malformed-response",
    });
    expect(sourceCalls).toBe(2);
    expect(plannerCalls).toBe(2);
    expect(sourceExecution.evidence.configuredMaxRetries).toBe(1);
    expect(sourceExecution.evidence.effectiveMaxRetries).toBe(1);
    expect(sourceExecution.evidence.attempts).toHaveLength(2);
    expect(sourceExecution.evidence.attempts).toMatchObject([
      {
        attempt: 1,
        outcome: "malformed-response",
        retryable: true,
        retryScheduled: true,
      },
      {
        attempt: 2,
        outcome: "malformed-response",
        retryable: true,
        retryScheduled: false,
      },
    ]);
    expect(plannerExecution.evidence.attempts).toMatchObject([
      {
        attempt: 1,
        outcome: "malformed-response",
        retryable: true,
        retryScheduled: true,
      },
      {
        attempt: 2,
        outcome: "malformed-response",
        retryable: true,
        retryScheduled: false,
      },
    ]);
  });

  it("terminates a non-retryable context-exhausted composition step on the first attempt", async () => {
    const runtime = await loadCompositionRunRuntime(
      request("nvidia-inference-claude-sonnet-5-pi"),
      config({
        providerId: "nvidia-inference-api",
        baseUrl: HUB_BASE_URL,
        modelId: "aws/anthropic/bedrock-claude-sonnet-5",
        compatibleFormats: ["chat_completions"],
      }),
    );
    let calls = 0;
    const execution = await runCompositionReadOnlyStep(
      { ...runtime.config.retryPolicy, ...READ_ONLY_RETRY_POLICY },
      async () => {
        calls += 1;
        throw new InferenceStepError("local context exhausted", "context-exhausted", true);
      },
    );

    expect(execution.status).toBe("failed");
    if (execution.status !== "failed") throw new Error("expected failed execution");
    expect(calls).toBe(1);
    expect(execution.evidence).toMatchObject({
      configuredMaxRetries: 1,
      effectiveMaxRetries: 1,
      attempts: [
        {
          attempt: 1,
          outcome: "context-exhausted",
          retryable: false,
          retryScheduled: false,
        },
      ],
    });
  });
});
