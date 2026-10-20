// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type DocsFabConfig } from "../src/config/runtime-loader.js";
import { parseModelEndpoint, type ModelEndpointConfig } from "../src/model/configuration.js";
import {
  answerSubmissionProbeTarget,
  checkLiveModel,
  diagnose,
  formatDoctorFailure,
  formatDoctorResult,
  probeConfiguredEndpointCompatibility,
  resolveDoctorModelProfile,
  type DoctorResult,
} from "../src/doctor.js";
import { DOCSFAB_SYSTEM_PROMPT } from "../src/model/request-policy.js";
import {
  EndpointCompatibilityError,
  notCheckedReport,
  probeEndpointCompatibility,
} from "../src/profile/endpoint-compatibility.js";
import { fixtureFetch, loadEndpointFixture } from "./helpers/endpoint-compatibility-fixtures.js";
import { resolveOperatorExecutionBinding } from "../src/model/operator-execution-binding.js";
import { ModelCompositionError } from "../src/model-composition/types.js";
import { VIRTUAL_WORKSPACE_CWD } from "../src/harness/pi-session.js";
import { validModelConfig, validModelEnvironment } from "./helpers.js";
import { textTurn } from "./support/pi-harness-session-fixtures.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";

const HUB_BASE_URL = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];

const SUPER_V3 = {
  providerId: "nvidia-inference-api",
  baseUrl: HUB_BASE_URL,
  modelId: "nvidia/nvidia/nemotron-3-super-v3",
} as const;

const BIND_ENV = { MODEL_API_KEY: "test-secret" } as const;

function superV3Endpoint(contextWindow: number, maxOutputTokens: number): ModelEndpointConfig {
  return {
    ...validModelConfig,
    ...SUPER_V3,
    requestPolicy: {
      minimumOutputTokens: 16,
      reservedContextTokens: 16,
    },
    profile: {
      ...validModelConfig.profile,
      configuredLimits: {
        contextWindow,
        maxInputTokens: contextWindow,
        maxOutputTokens,
      },
      contextWindow,
      maxInputTokens: contextWindow,
      maxOutputTokens,
    },
  };
}

const config: DocsFabConfig = {
  projectRoot: process.cwd(),
  skillCrateDirectory: new URL("../skill-crate", import.meta.url).pathname,
  qualityDirectory: new URL("../quality", import.meta.url).pathname,
  qualityPackDirectory: new URL("../quality-pack", import.meta.url).pathname,
  stateDirectory: "/tmp/docsfab-test-runs",
  retryPolicy: {
    maxRetries: 1,
    baseDelayMs: 1_000,
    maxDelayMs: 4_000,
    retryableCategories: ["timeout", "throttled"],
  },
  model: validModelConfig,
};

describe("doctor live connectivity probe", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the virtual workspace cwd to the provider, never the install root", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "docsfab-doctor-install-"));
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_request: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return textTurn("DOCSFAB_OK");
    });
    try {
      await checkLiveModel({ projectRoot, model: validModelConfig } as DocsFabConfig, {
        probeCompatibility: async () => notCheckedReport("Checked in its own suite.", 1),
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(`<cwd>\\n${VIRTUAL_WORKSPACE_CWD}\\n</cwd>`);
    expect(bodies[0]).not.toContain(projectRoot);
  });
});

describe("doctor endpoint compatibility", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ULTRA = {
    ...validModelConfig,
    providerId: "nvidia-api-catalog",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    modelId: "nvidia/nemotron-3-ultra-550b-a55b",
    credentialEnv: "DOCSFAB_NVIDIA_API_KEY",
  };

  it("probes with the bound request policy and the effective output limit", async () => {
    const replay = fixtureFetch(loadEndpointFixture("ultra-tool-call-ok"));
    vi.stubGlobal("fetch", replay.fetch);
    const effective = (await resolveDoctorModelProfile(ULTRA)).maxOutputTokens;
    const report = await probeConfiguredEndpointCompatibility(ULTRA);
    expect(report.verdict).toBe("compatible");
    expect(report.maxOutputTokens).toBe(effective);
    expect(replay.requests).toHaveLength(2);
    for (const request of replay.requests) {
      expect(request.body).toMatchObject({
        model: ULTRA.modelId,
        stream: true,
        max_tokens: effective,
        temperature: 0,
        top_p: 1,
        chat_template_kwargs: { thinking: false },
      });
      const [system] = request.body.messages as { role: string; content: string }[];
      expect(system).toEqual({ role: "system", content: DOCSFAB_SYSTEM_PROMPT });
    }
  });

  /** Answers the probe's tool and JSON requests and the connectivity turn, recording each body. */
  function endpointReplay() {
    const bodies: Record<string, unknown>[] = [];
    const replay = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const tools = Array.isArray(body.tools) ? body.tools : [];
      const asksForJson = JSON.stringify(body.messages).includes("only this JSON object");
      const delta =
        tools.length > 0
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
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
      const chunk = (choice: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
        id: "chat",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [{ index: 0, ...choice }],
        ...extra,
      });
      const events = [
        chunk({ delta, finish_reason: null }),
        chunk(
          { delta: {}, finish_reason: tools.length > 0 ? "tool_calls" : "stop" },
          { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
        ),
      ];
      return new Response(
        `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };
    return { bodies, fetch: replay as typeof fetch };
  }

  const tokenFields = (body: Record<string, unknown>) =>
    ["max_tokens", "max_completion_tokens"].filter((field) => field in body);
  const instructionRole = (body: Record<string, unknown>) =>
    (body.messages as { role: string }[])[0]!.role;

  const THINKING_OFF = { thinking: false };

  it.each([
    [
      "NVIDIA Inference API without a policy (GPT-6 Sol)",
      {
        ...validModelConfig,
        providerId: "nvidia-inference-api",
        baseUrl: HUB_BASE_URL,
        modelId: "azure/openai/gpt-6-sol",
      },
      undefined,
    ],
    [
      "NVIDIA Inference API with a request policy",
      {
        ...validModelConfig,
        providerId: "nvidia-inference-api",
        baseUrl: HUB_BASE_URL,
        modelId: "nvidia/nvidia/nemotron-3-ultra",
      },
      THINKING_OFF,
    ],
    ["NVIDIA API Catalog with a request policy", ULTRA, THINKING_OFF],
    ["a bring-your-own OpenAI-compatible endpoint", validModelConfig, undefined],
    [
      // An unmatched endpoint serving a measured model gets the measured
      // reasoning control on every DocsFab request, so the probe must send it too.
      "an unmatched endpoint serving a model with a measured reasoning control",
      {
        ...validModelConfig,
        providerId: "operator-configured-openai-compatible",
        baseUrl: "https://nim.example.test/v1",
        modelId: "nvidia/nemotron-3-super-120b-a12b",
        transport: "openai-chat-completions",
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
      THINKING_OFF,
    ],
  ])(
    "probes %s with the token field, instruction role, and reasoning control of DocsFab's own request",
    async (_label, model, templateKwargs) => {
      const replay = endpointReplay();
      vi.stubGlobal("fetch", replay.fetch);
      const result = await checkLiveModel({ ...config, model } as DocsFabConfig);
      expect(result.compatibility?.verdict).toBe("compatible");
      // Two probe requests, then the provider's own connectivity turn.
      expect(replay.bodies).toHaveLength(3);
      const own = replay.bodies[2]!;
      expect(tokenFields(own)).toHaveLength(1);
      expect(own.chat_template_kwargs).toEqual(templateKwargs);
      for (const probe of replay.bodies.slice(0, 2)) {
        expect(tokenFields(probe)).toEqual(tokenFields(own));
        expect(instructionRole(probe)).toBe(instructionRole(own));
        expect("store" in probe).toBe("store" in own);
        expect(probe.chat_template_kwargs).toEqual(own.chat_template_kwargs);
      }
    },
  );

  it("refuses an incompatible endpoint before the connectivity turn", async () => {
    const replay = fixtureFetch(loadEndpointFixture("nano-end-of-life-410"));
    vi.stubGlobal("fetch", replay.fetch);
    const report = await probeEndpointCompatibility({
      modelId: "nvidia/nemotron-3-nano-30b-a3b",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiKey: validModelConfig.apiKey,
      maxOutputTokens: 4096,
      outputLimitSource: "configured",
      shape: { tokenField: "max_tokens", systemRole: "system", store: false },
    });
    const sent = replay.requests.length;
    await expect(
      checkLiveModel(config, { probeCompatibility: async () => report }),
    ).rejects.toBeInstanceOf(EndpointCompatibilityError);
    expect(replay.requests).toHaveLength(sent);
  });

  it("keeps the compatibility refusal and its fix through diagnose", async () => {
    const replay = fixtureFetch(loadEndpointFixture("nano-end-of-life-410"));
    vi.stubGlobal("fetch", replay.fetch);
    const report = await probeEndpointCompatibility({
      modelId: "nvidia/nemotron-3-nano-30b-a3b",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiKey: validModelConfig.apiKey,
      maxOutputTokens: 4096,
      outputLimitSource: "configured",
      shape: { tokenField: "max_tokens", systemRole: "system", store: false },
    });
    const refusal = diagnose(config, {
      live: true,
      liveChecker: async () => {
        throw new EndpointCompatibilityError(report);
      },
    });
    await expect(refusal).rejects.toBeInstanceOf(EndpointCompatibilityError);
    const rendered = formatDoctorFailure(await refusal.catch((error: unknown) => error));
    expect(rendered).toContain("availability failed (end-of-life)");
    expect(rendered).toContain("docsfab setup --profile <composition-id>");
  });

  it("prints the compatibility checks beside a ready live check", () => {
    const rendered = formatDoctorResult({
      provider: "nvidia-api-catalog",
      endpoint: "https://integrate.api.nvidia.com/v1",
      model: "nvidia/nemotron-3-ultra-550b-a55b",
      skills: [],
      contextSources: [],
      profile: validModelConfig.profile,
      requestPolicy: validModelConfig.requestPolicy,
      retryPolicy: config.retryPolicy,
      live: {
        latencyMs: 12,
        compatibility: {
          schemaVersion: 1,
          kind: "docsfab-endpoint-compatibility",
          verdict: "compatible",
          maxOutputTokens: 8192,
          checks: [
            {
              id: "tool-calls",
              status: "pass",
              finding: "native-tool-call",
              detail: "Native tool call with JSON arguments (finish_reason=tool_calls).",
              owner: null,
              nextAction: null,
            },
          ],
        },
      },
    });
    expect(rendered).toContain("Live inference: ready (12 ms)");
    expect(rendered).toContain("Endpoint compatibility: compatible (max output tokens 8192)");
    expect(rendered).toContain("  tool-calls: pass (native-tool-call).");
  });
});

describe("doctor endpoint compatibility on the Responses transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // What `docsfab setup --provider openai` writes: the Responses transport,
  // with `apiFormat` still reading `chat_completions`.
  const RESPONSES: ModelEndpointConfig = {
    ...validModelConfig,
    providerId: "openai-api",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-6-sol",
    apiFormat: "chat_completions",
    transport: "openai-responses",
    credentialEnv: "OPENAI_API_KEY",
  };

  /** Answers a Responses request with `DOCSFAB_OK`, refuses any other path, and records each path. */
  function responsesReplay() {
    const paths: string[] = [];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      paths.push(url.pathname);
      if (!url.pathname.endsWith("/responses")) {
        return new Response(JSON.stringify({ error: { message: "use /v1/responses" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      const body = JSON.parse(String(init?.body)) as { model: string };
      const item = {
        type: "message",
        id: "msg_ok",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "DOCSFAB_OK", annotations: [] }],
      };
      const events = [
        {
          type: "response.created",
          response: { id: "resp_ok", model: body.model, status: "in_progress", output: [] },
        },
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          item_id: "msg_ok",
          delta: "DOCSFAB_OK",
        },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: "resp_ok",
            model: body.model,
            status: "completed",
            output: [item],
            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
          },
        },
      ];
      return new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };
    return { paths, fetch };
  }

  it("does not probe chat completions for a Responses profile", async () => {
    const replay = responsesReplay();
    vi.stubGlobal("fetch", replay.fetch);
    const report = await probeConfiguredEndpointCompatibility(RESPONSES);
    expect(replay.paths).toEqual([]);
    expect(report.verdict).toBe("not-checked");
    for (const check of report.checks) {
      expect(check.status).toBe("not-checked");
      expect(check.detail).toContain("openai-responses");
    }
  });

  it("passes the live check over the Responses transport", async () => {
    const replay = responsesReplay();
    vi.stubGlobal("fetch", replay.fetch);
    const result = await checkLiveModel({ ...config, model: RESPONSES });
    expect(result.compatibility?.verdict).toBe("not-checked");
    expect(replay.paths).toEqual(["/v1/responses"]);
  });

  it("does not send the answer-submission probe to chat completions", async () => {
    const replay = responsesReplay();
    vi.stubGlobal("fetch", replay.fetch);
    await expect(answerSubmissionProbeTarget(RESPONSES)).resolves.toMatchObject({
      decision: "not-checked",
    });
    expect(replay.paths).toEqual([]);
  });
});

describe("diagnose", () => {
  it("shows the effective style profile and that no organization or target layer resolved", async () => {
    const result = await diagnose(config);
    const style = result.resolvedResources?.resources.find(
      (resource) => resource.kind === "style-profile",
    );
    expect(style).toMatchObject({ id: "profile:nvidia-technical-documentation", layer: "product" });
    const lines = formatDoctorResult(result).split("\n");
    expect(lines).toContain(
      `Resolved style-profile: profile:nvidia-technical-documentation@${style!.version} (layer product, sha256 ${style!.sha256})`,
    );
    expect(lines).toContain(
      "Unresolved resource layers: organization, target, request (not built; the product layer applies alone)",
    );
  });

  it("keeps a quality-pack refusal's code and remediation instead of the generic skill-loading error", async () => {
    const qualityDirectory = await mkdtemp(resolve(tmpdir(), "docsfab-doctor-quality-"));
    try {
      const installed = JSON.parse(
        await readFile(resolve(config.qualityDirectory, "lock.json"), "utf8"),
      );
      const { productDefaults: _productDefaults, ...legacy } = installed;
      await writeFile(
        resolve(qualityDirectory, "lock.json"),
        `${JSON.stringify({ ...legacy, schemaVersion: 1 })}\n`,
      );

      const refusal = await diagnose({ ...config, qualityDirectory }).catch(
        (error: unknown) => error,
      );

      expect(refusal).toMatchObject({ code: "migration-required" });
      const output = formatDoctorFailure(refusal);
      expect(output).toContain("migration-required");
      expect(output).toContain("npm run generate:quality-pack");
      expect(output).not.toContain(qualityDirectory);
    } finally {
      await rm(qualityDirectory, { recursive: true, force: true });
    }
  });

  it("remains offline unless live is explicitly requested", async () => {
    let calls = 0;
    const result = await diagnose(config, {
      liveChecker: async () => {
        calls += 1;
        return { latencyMs: 1 };
      },
    });

    expect(calls).toBe(0);
    expect(result.live).toBeUndefined();
    expect(result.profile.metadata).toEqual({
      approvedSource: "https://metadata.example.test/models/example-model",
      effectiveDate: "2020-01-01",
      reviewAfter: "2099-12-31",
      status: "current",
    });
  });

  it("prints configured and effective limits with independent profile status", () => {
    const unknownProfile = parseModelEndpoint({
      ...validModelEnvironment,
      MODEL_PROFILE_APPROVED_SOURCE: "unknown",
      MODEL_PROFILE_EFFECTIVE_DATE: "unknown",
      MODEL_PROFILE_REVIEW_AFTER: "unknown",
    }).profile;
    const output = formatDoctorResult({
      provider: "policy-provider",
      endpoint: "https://policy.example.test/v1",
      model: "policy/model",
      profile: unknownProfile,
      requestPolicy: validModelConfig.requestPolicy,
      retryPolicy: config.retryPolicy,
      judge: {
        provider: "judge-provider",
        endpoint: "https://judge.example.test/v1",
        model: "judge/model",
        profile: validModelConfig.profile,
        requestPolicy: validModelConfig.requestPolicy,
      },
      skills: ["audit-documentation"],
      contextSources: [],
    });

    expect(output).toMatchInlineSnapshot(`
      "DocsFab configuration: ready
      Read-only retry policy: max-retries=1, exponential-backoff=1000-4000ms, retryable=timeout,throttled
      Retry envelope: attempts=2, timeout attempts=1, cut-answer retries=0, no-progress retries=0; attempt-timeout=not configured, judgment answer-now=not armed (no attempt timer), step worst case=not derivable from retry counts (workflow deadlines still apply)
      Answer submission: DOCSFAB_ANSWER_SUBMISSION=recorded; route not-recorded; the final quality evaluator answers by text-final (not-recorded)
      Policy model:
        Provider: policy-provider
        Endpoint: https://policy.example.test (path withheld)
        Model: policy/model
        API key: configured
        Limits: configured-context=128000, configured-input=128000, configured-output=16384, effective-context=128000, effective-input=128000, effective-output=16384
        Request policy: minimum-output=16, context-reserve=4096
        Limit reason: metadata-unknown (no operator-approved provenance; DocsFab does not invent a host context ceiling)
        Limit clamps: none (no configured limit was reduced)
        Capabilities: reasoning=false, developer-role=false, reasoning-effort=false
        API compatibility: chat_completions
        Profile metadata: status=unknown, source-sha256=unknown, verification=not-performed, effective=unknown, review-after=unknown
        Cost per million tokens: input=unknown, output=unknown, cache-read=unknown, cache-write=unknown
      Judge model:
        Provider: judge-provider
        Endpoint: https://judge.example.test (path withheld)
        Model: judge/model
        API key: configured
        Limits: configured-context=128000, configured-input=128000, configured-output=16384, effective-context=128000, effective-input=128000, effective-output=16384
        Request policy: minimum-output=16, context-reserve=4096
        Limit reason: none (approved metadata is current)
        Limit clamps: none (no configured limit was reduced)
        Capabilities: reasoning=true, developer-role=true, reasoning-effort=true
        API compatibility: chat_completions
        Profile metadata: status=current, source-sha256=7596b67ed554ce5ed75d0064a0f68191d02d09c6a03569942d37ca45a098a25b, verification=not-performed, effective=2020-01-01, review-after=2099-12-31
        Cost per million tokens: input=1.25, output=10, cache-read=0.5, cache-write=unknown
      Skills (1): audit-documentation
      Context sources (0): none
      Live inference: not requested (use --live)"
    `);
    expect(output).not.toContain(validModelConfig.apiKey);
  });

  it("names the measured reasoning control an unmatched endpoint receives", () => {
    const render = (reasoningControl?: DoctorResult["reasoningControl"]) =>
      formatDoctorResult({
        provider: "operator-configured-openai-compatible",
        endpoint: "https://nim.example.test/v1",
        model: "nvidia/nemotron-3-super-120b-a12b",
        profile: validModelConfig.profile,
        requestPolicy: validModelConfig.requestPolicy,
        ...(reasoningControl ? { reasoningControl } : {}),
        retryPolicy: config.retryPolicy,
        skills: [],
        contextSources: [],
      });

    expect(
      render({
        control: { kind: "chat-template-kwarg", thinking: false },
        compositionIds: ["nvidia-nemotron-3-super-120b-a12b-pi"],
      }),
    ).toContain(
      "  Reasoning control: chat_template_kwargs.thinking=false (measured for this model by nvidia-nemotron-3-super-120b-a12b-pi)",
    );
    expect(render()).not.toContain("Reasoning control:");
  });

  it("names the absence of a host token lid on unknown metadata", () => {
    const renderFor = (profile: DocsFabConfig["model"]["profile"]) =>
      formatDoctorResult({
        provider: "policy-provider",
        endpoint: "https://policy.example.test/v1",
        model: "policy/model",
        profile,
        requestPolicy: validModelConfig.requestPolicy,
        retryPolicy: config.retryPolicy,
        skills: [],
        contextSources: [],
      });
    const unreduced = renderFor(
      parseModelEndpoint({
        ...validModelEnvironment,
        MODEL_PROFILE_APPROVED_SOURCE: "unknown",
        MODEL_PROFILE_EFFECTIVE_DATE: "unknown",
        MODEL_PROFILE_REVIEW_AFTER: "unknown",
      }).profile,
    );
    expect(unreduced).toContain("Limit clamps: none (no configured limit was reduced)");
    expect(unreduced).not.toContain("Limit clamp:");
    expect(unreduced).toContain("effective-context=128000");

    const current = renderFor(parseModelEndpoint(validModelEnvironment).profile);
    expect(current).toContain("Limit clamps: none (no configured limit was reduced)");
    expect(current).not.toContain("Limit clamp:");
  });

  it("runs attested windows above the preset unclamped and names no clamp", async () => {
    const renderFor = (profile: DocsFabConfig["model"]["profile"]) =>
      formatDoctorResult({
        provider: SUPER_V3.providerId,
        endpoint: SUPER_V3.baseUrl,
        model: SUPER_V3.modelId,
        profile,
        requestPolicy: { minimumOutputTokens: 16, reservedContextTokens: 16 },
        retryPolicy: config.retryPolicy,
        skills: [],
        contextSources: [],
      });
    const high = await resolveOperatorExecutionBinding({
      // Above the preset's sealed Hub Metadata limits (1,048,576 / 32,768).
      model: superV3Endpoint(2_000_000, 65_536),
      environment: BIND_ENV,
    });
    expect(high.match).toBe("installed-composition");
    expect(high.profile.profile.effectiveLimitReason).toBe("composition-candidate");
    // The operator's attested values win over the preset's; the preset's stay on the record.
    expect(high.profile.profile.contextWindow).toBe(2_000_000);
    expect(high.profile.profile.maxOutputTokens).toBe(65_536);
    expect(high.bound?.composition.compositionLimits.contextWindow).toBe(1_048_576);
    const profile = await resolveDoctorModelProfile(superV3Endpoint(2_000_000, 65_536), BIND_ENV);
    expect(renderFor(profile)).toContain("Limit clamps: none (no configured limit was reduced)");
  });

  it("keeps unmatched BYO YAML limits and refuses a failing unique composition bind", async () => {
    const unmatched = await resolveDoctorModelProfile(validModelConfig, BIND_ENV);
    expect(unmatched).toEqual(validModelConfig.profile);

    const retired = {
      ...validModelConfig,
      providerId: "nvidia-api-catalog",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      modelId: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
    };
    await expect(resolveDoctorModelProfile(retired, BIND_ENV)).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(ModelCompositionError);
      expect((error as ModelCompositionError).code).toBe("composition-retired");
      expect(String(error)).toMatch(/retired \(provider-end-of-life/u);
      const rendered = formatDoctorFailure(error);
      expect(rendered).toMatch(/retired \(provider-end-of-life/u);
      expect(rendered).toContain("Next action:");
      expect(rendered).not.toContain(`effective-context=${retired.profile.contextWindow}`);
      return true;
    });
  });

  it("keeps a retired selection's named refusal through model registration (#1512)", async () => {
    // doctor used to replace any registration error with a generic one, which
    // readiness then reported as provider-runtime-unavailable.
    const retired = {
      ...validModelConfig,
      providerId: "nvidia-api-catalog",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      modelId: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
    };
    await expect(diagnose({ ...config, model: retired })).rejects.toMatchObject({
      name: "ModelCompositionError",
      code: "composition-retired",
    });
  });

  it("keeps a retired judge selection's named refusal through judge registration (#1512)", async () => {
    // The policy model registers normally; the judge profile binds a retired
    // composition. doctor must surface composition-retired, not the generic
    // judge-registration error.
    const retiredJudge = {
      ...validModelConfig,
      providerId: "nvidia-api-catalog",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      modelId: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
    };
    await expect(diagnose({ ...config, judge: retiredJudge })).rejects.toMatchObject({
      name: "ModelCompositionError",
      code: "composition-retired",
    });
  });

  it("runs an injected live check only when requested", async () => {
    const result = await diagnose(config, {
      live: true,
      liveChecker: async () => ({ latencyMs: 42 }),
    });

    expect(result.live).toEqual({ latencyMs: 42 });
  });

  it("rejects request policies that cannot fit the effective model limits", async () => {
    await expect(
      diagnose({
        ...config,
        model: {
          ...validModelConfig,
          requestPolicy: {
            minimumOutputTokens: 16,
            reservedContextTokens: 127_990,
          },
        },
      }),
    ).rejects.toThrow("request policy cannot fit effective limits");
  });

  it("redacts credentials from live-check failures", async () => {
    await expect(
      diagnose(config, {
        live: true,
        liveChecker: async () => {
          throw new Error(`provider rejected ${validModelConfig.apiKey}`);
        },
      }),
    ).rejects.toThrow("Live model check failed without retaining provider diagnostics.");
  });

  it("shows only the endpoint host and withholds source URLs, credentials, and host paths", async () => {
    const credential = `nvapi-${"X".repeat(24)}`;
    const unsafe = {
      ...validModelConfig,
      baseUrl: `https://${credential}@private.example.test/v1?token=${credential}`,
      apiKey: credential,
      profile: {
        ...validModelConfig.profile,
        metadata: {
          ...validModelConfig.profile.metadata,
          approvedSource: `https://private.example.test/source?token=${credential}`,
        },
      },
    };
    const output = formatDoctorResult({
      provider: credential,
      endpoint: unsafe.baseUrl,
      model: credential,
      profile: unsafe.profile,
      requestPolicy: unsafe.requestPolicy,
      retryPolicy: config.retryPolicy,
      skills: ["audit-documentation"],
      contextSources: [],
    });
    expect(output).not.toContain(credential);
    // The endpoint shows its scheme and host only: no user name, path, or query.
    expect(output).toContain("Endpoint: https://private.example.test (path withheld)");
    expect(output).not.toContain("private.example.test/v1");
    expect(output).not.toContain("token=");
    expect(output).not.toContain(unsafe.baseUrl);
    expect(output).toContain("withheld-unsafe-identity");

    const hostPath = "/private/host/canary/skills";
    let message = "";
    try {
      await diagnose({ ...config, skillCrateDirectory: hostPath });
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain(hostPath);
  });

  it("reports content-free identities for effective instruction sources", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "docsfab-doctor-context-"));
    const marker = "PRIVATE_REPOSITORY_INSTRUCTION_MARKER";
    try {
      await writeFile(resolve(projectRoot, "AGENTS.md"), marker);
      const result = await diagnose({ ...config, projectRoot });

      expect(result.contextSources).toEqual([
        { kind: "product-instructions", id: "docsfab:product-instructions" },
        { kind: "repository-instructions", id: "repository:AGENTS.md" },
      ]);
      expect(JSON.stringify(result.contextSources)).not.toContain(marker);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

type ModelProfileFixture = DocsFabConfig["model"]["profile"];
type LimitReason = ModelProfileFixture["effectiveLimitReason"];

/**
 * Every member of the union, in assertion order. `tsconfig.json` excludes
 * `test/`, so exhaustiveness is enforced by the `never` guard in
 * `src/doctor.ts`; these cases assert the rendered text, not the type.
 */
const ALL_LIMIT_REASONS: readonly LimitReason[] = [
  "none",
  "metadata-unknown",
  "metadata-stale",
  "composition-candidate",
];

/**
 * Real parser output for the three reasons the model configuration derives
 * from `metadata.status`. The `composition-candidate` profile is built here:
 * configured limits preserved, effective limits clamped below them, metadata
 * carried through unchanged.
 */
function profileFor(reason: LimitReason): ModelProfileFixture {
  if (reason === "metadata-unknown") {
    return parseModelEndpoint({
      ...validModelEnvironment,
      MODEL_PROFILE_APPROVED_SOURCE: "unknown",
      MODEL_PROFILE_EFFECTIVE_DATE: "unknown",
      MODEL_PROFILE_REVIEW_AFTER: "unknown",
    }).profile;
  }
  const current = parseModelEndpoint(validModelEnvironment).profile;
  if (reason === "metadata-stale") {
    // The parser never emits `stale`; only a legacy profile (a hosted packet
    // decoded by `host-invoker/composition.ts`) carries it, in this stripped
    // shape.
    return {
      ...current,
      effectiveLimitReason: "metadata-stale",
      reasoning: false,
      input: ["text"],
      compatibility: {
        ...current.compatibility,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
      costPerMillionTokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
      metadata: { ...current.metadata, reviewAfter: "2021-01-01", status: "stale" },
    };
  }
  if (reason === "none") return current;
  return {
    ...current,
    contextWindow: 32_768,
    maxInputTokens: 32_768,
    maxOutputTokens: 8_192,
    effectiveLimitReason: "composition-candidate",
    reasoning: false,
    input: ["text"],
    costPerMillionTokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
  };
}

function renderDoctor(profile: ModelProfileFixture, asOf?: Date): string {
  return formatDoctorResult(
    {
      provider: "policy-provider",
      endpoint: "https://policy.example.test/v1",
      model: "policy/model",
      profile,
      requestPolicy: validModelConfig.requestPolicy,
      retryPolicy: config.retryPolicy,
      skills: ["audit-documentation"],
      contextSources: [],
    },
    undefined,
    asOf,
  );
}

function limitReasonLineOf(profile: ModelProfileFixture): string {
  return renderDoctor(profile)
    .split("\n")
    .find((line) => line.startsWith("  Limit reason: "))!;
}

const EXPECTED_LIMIT_REASON_LINES: Record<LimitReason, string> = {
  none: "  Limit reason: none (approved metadata is current)",
  "metadata-unknown":
    "  Limit reason: metadata-unknown (no operator-approved provenance; DocsFab does not invent a host context ceiling)",
  "metadata-stale":
    "  Limit reason: metadata-stale (review date passed; DocsFab does not invent a host context ceiling)",
  "composition-candidate":
    "  Limit reason: composition-candidate (bound executable composition; the preset's windows apply unless a setting replaces them)",
};

describe("doctor limit reason rendering", () => {
  it("names the executable composition clamp rather than a passed review date", () => {
    const line = limitReasonLineOf(profileFor("composition-candidate"));

    expect(line).not.toBe(EXPECTED_LIMIT_REASON_LINES["metadata-stale"]);
    expect(line).not.toContain("metadata-stale");
    expect(line).not.toContain("review date passed");
    expect(line).toBe(EXPECTED_LIMIT_REASON_LINES["composition-candidate"]);
  });

  it("renders its own accurate line for every effective limit reason", () => {
    const rendered = ALL_LIMIT_REASONS.map((reason) => limitReasonLineOf(profileFor(reason)));

    expect(rendered).toEqual(
      ALL_LIMIT_REASONS.map((reason) => EXPECTED_LIMIT_REASON_LINES[reason]),
    );
    expect(new Set(rendered).size).toBe(ALL_LIMIT_REASONS.length);
  });

  it("renders the metadata-stale line of a legacy profile without inventing a host ceiling", () => {
    const stale = profileFor("metadata-stale");

    expect(stale.metadata.status).toBe("stale");
    expect(stale.effectiveLimitReason).toBe("metadata-stale");
    expect(limitReasonLineOf(stale)).toBe(EXPECTED_LIMIT_REASON_LINES["metadata-stale"]);
  });

  it("refuses to render an effective limit reason it does not know", () => {
    const unknown = {
      ...profileFor("none"),
      effectiveLimitReason: "future-reason" as LimitReason,
    };

    expect(() => limitReasonLineOf(unknown)).toThrow(
      'Unhandled effective limit reason "future-reason".',
    );
  });
});

describe("doctor review-overdue advisory", () => {
  const REVIEW_AFTER = "2026-09-29";
  const environment = {
    ...validModelEnvironment,
    MODEL_CACHE_WRITE_COST_PER_MILLION: "0.75",
    MODEL_PROFILE_REVIEW_AFTER: REVIEW_AFTER,
  };
  const overdueLine = `  Review overdue: the profile review date ${REVIEW_AFTER} has passed. This is a reminder only; configured limits, capabilities, and prices still apply. Compare with provider metadata: docsfab profile inspect --catalog`;
  const reviewLines = (output: string) =>
    output.split("\n").filter((line) => line.includes("Review overdue"));

  it("prints the advisory after the review date and keeps the configured profile", () => {
    const asOf = new Date("2026-09-30T00:00:00Z");
    expect(REVIEW_AFTER < asOf.toISOString().slice(0, 10)).toBe(true);
    const profile = parseModelEndpoint(environment, "MODEL", asOf).profile;
    const output = renderDoctor(profile, asOf);

    expect(reviewLines(output)).toEqual([overdueLine]);
    expect(output).toContain("  Limit reason: none (approved metadata is current)");
    expect(output).toContain(
      "  Capabilities: reasoning=true, developer-role=true, reasoning-effort=true",
    );
    expect(output).toContain(
      "  Cost per million tokens: input=1.25, output=10, cache-read=0.5, cache-write=0.75",
    );
    expect(output).not.toContain("metadata-stale");
  });

  it("prints no advisory on the review date itself", () => {
    // Adjacent condition: the last second of the review day is not overdue.
    const asOf = new Date(`${REVIEW_AFTER}T23:59:59Z`);
    const profile = parseModelEndpoint(environment, "MODEL", asOf).profile;
    expect(reviewLines(renderDoctor(profile, asOf))).toEqual([]);
  });

  it("prints the judge advisory under the judge model only", () => {
    // Adjacent condition: the policy profile's review date has not passed, so
    // the one advisory line must come from the judge call site.
    const asOf = new Date("2026-09-30T00:00:00Z");
    const judgeProfile = parseModelEndpoint(environment, "MODEL", asOf).profile;
    const policyProfile = parseModelEndpoint(
      { ...environment, MODEL_PROFILE_REVIEW_AFTER: "2026-10-30" },
      "MODEL",
      asOf,
    ).profile;
    const output = formatDoctorResult(
      {
        provider: "policy-provider",
        endpoint: "https://policy.example.test/v1",
        model: "policy/model",
        profile: policyProfile,
        requestPolicy: validModelConfig.requestPolicy,
        retryPolicy: config.retryPolicy,
        skills: ["audit-documentation"],
        contextSources: [],
        judge: {
          provider: "judge-provider",
          endpoint: "https://judge.example.test/v1",
          model: "judge/model",
          profile: judgeProfile,
          requestPolicy: validModelConfig.requestPolicy,
        },
      },
      undefined,
      asOf,
    );
    const lines = output.split("\n");
    expect(reviewLines(output)).toEqual([overdueLine]);
    expect(lines.indexOf(overdueLine)).toBeGreaterThan(lines.indexOf("Judge model:"));
    expect(lines.indexOf("Judge model:")).toBeGreaterThan(lines.indexOf("Policy model:"));
  });

  it("prints no advisory for unknown metadata", () => {
    // Adjacent condition: absent provenance has no review date to be overdue.
    const asOf = new Date("2026-09-30T00:00:00Z");
    const output = renderDoctor(profileFor("metadata-unknown"), asOf);
    expect(output).toContain("review-after=unknown");
    expect(reviewLines(output)).toEqual([]);
  });
});
