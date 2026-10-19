// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A preset run, loaded by the real loader and bound by `--composition`, sends
 * each operator setting on the wire. A loopback upstream records the host it
 * was addressed as, whether the configured key arrived (never the key), and
 * the request body fields each case asserts.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadCompositionRunRuntime } from "../src/cli/run/composition-runtime.js";
import type { RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import { setCliModelSettings } from "../src/config/cli-model-settings.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";
import { canonicalDigest } from "../src/contract-kit/index.js";
import { loadConfig } from "../src/config/runtime-loader.js";
import { resolveOperatorExecutionBinding } from "../src/model/operator-execution-binding.js";
import { createProviderConnectionFactory, servedModelWarning } from "../src/model/provider.js";
import { toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";
import { createCompositionExecutionEvidence } from "../src/records/composition-execution.js";
import { temporaryRoots } from "./helpers/temp.js";
import {
  closeModelEndpointStubs,
  startModelUpstream,
  type ModelUpstream,
} from "./support/model-endpoint-stubs.js";

const roots = temporaryRoots();
const SONNET = "nvidia-inference-claude-sonnet-5-pi";
const HUB = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];
const SONNET_MODEL = "aws/anthropic/bedrock-claude-sonnet-5";
const QWEN = "nvidia-inference-qwen3-5-397b-a17b-pi";
const QWEN_MODEL = "nvidia/qwen/qwen3-5-397b-a17b";
const ANTHROPIC = "anthropic-claude-opus-4.7-pi";
/** A placeholder key: plain words, never shaped like a real credential. */
const KEY = "settings-wire-orchard-meadow-key";
const LOADER_VARIABLES =
  /^(?:MODEL_|JUDGE_|DOCSFAB_|OPENAI_API_KEY$|ANTHROPIC_API_KEY$|NVIDIA_API_KEY$|CORP_)/u;
let saved: NodeJS.ProcessEnv = {};

beforeEach(() => {
  saved = { ...process.env };
  for (const name of Object.keys(process.env)) {
    if (LOADER_VARIABLES.test(name)) delete process.env[name];
  }
});

afterEach(async () => {
  setCliModelSettings(undefined);
  await closeModelEndpointStubs();
  for (const name of Object.keys(process.env)) {
    if (!(name in saved)) delete process.env[name];
  }
  Object.assign(process.env, saved);
});

/** A configuration root naming `preset`, with optional settings, made current. */
async function useRoot(preset: string, settings: readonly string[] = []): Promise<string> {
  const root = await roots.create("docsfab-settings-wire-", { mode: 0o700 });
  await writeFile(
    join(root, "host.yaml"),
    [
      "schemaVersion: 1",
      "kind: docsfab-host-config",
      "active:",
      "  writing:",
      `    compositionId: ${preset}`,
      ...(settings.length > 0 ? ["    settings:", ...settings.map((line) => `      ${line}`)] : []),
      "",
    ].join("\n"),
  );
  await writeFile(join(root, "secrets.env"), `MODEL_API_KEY=${KEY}\n`, {
    mode: 0o600,
  });
  process.env.DOCSFAB_CONFIG_ROOT = root;
  process.env.HOME = root;
  return root;
}

function request(compositionId: string): RunRequestWithPublishProjection {
  return {
    workflow: "review-documentation",
    repositoryPath: "/tmp/docsfab-settings-wire-target",
    revision: "HEAD",
    allowWrite: false,
    releaseGate: false,
    verbose: false,
    json: false,
    showScan: false,
    compositionId,
  };
}

async function runOneTurn(
  compositionId: string,
  callerLevel?: "minimal" | "high",
  maxTokens?: number,
) {
  const runtime = await loadCompositionRunRuntime(request(compositionId));
  const connection = await runtime.providerConnectionFactory.create({
    profile: runtime.executionProfile,
    credential: runtime.credential,
  });
  const turn = await connection.runtime
    .streamSimple(
      connection.model,
      {
        systemPrompt: "Reply as instructed.",
        messages: [{ role: "user", content: "Reply with DOCSFAB_OK.", timestamp: 1 }],
      },
      // A Pi session passes its own default level; the bound profile decides.
      callerLevel || maxTokens
        ? {
            ...(callerLevel ? { reasoning: callerLevel } : {}),
            ...(maxTokens ? { maxTokens } : {}),
          }
        : undefined,
    )
    .result();
  return { runtime, turn };
}

function outputAllowance(upstream: ModelUpstream): unknown {
  const body = upstream.requests[0]?.body;
  return body?.max_completion_tokens ?? body?.max_tokens;
}

describe("a preset run sends the operator's settings on the wire", () => {
  it("sends the turn to the host.yaml endpoint, with the configured key and output allowance", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useRoot(SONNET, [`baseUrl: ${upstream.baseUrl}`, "maxOutputTokens: 65536"]);
    const { runtime, turn } = await runOneTurn(SONNET);

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]).toMatchObject({
      host: new URL(upstream.baseUrl).host,
      path: "/v1/chat/completions",
      credential: "the configured key",
    });
    expect(upstream.requests[0]!.body.model).toBe(SONNET_MODEL);
    expect(outputAllowance(upstream)).toBe(65536);
    expect(runtime.executionProfile.endpointSource).toBe("host-config");
    expect(runtime.modelSettings?.settings.baseUrl).toMatchObject({
      source: "host-config",
      presetValue: HUB,
    });
    expect(runtime.modelSettings?.settings.maxOutputTokens).toMatchObject({
      value: 65536,
      source: "host-config",
      presetValue: 32768,
    });
  });

  it("binds the preset's own endpoint and output allowance when nothing overrides them", async () => {
    await useRoot(SONNET);
    const runtime = await loadCompositionRunRuntime(request(SONNET));
    expect(runtime.executionProfile.baseUrl).toBe(HUB);
    expect(runtime.executionProfile.profile.maxOutputTokens).toBe(32768);
    expect(runtime.notes).toEqual([]);
  });

  it("sends reasoning_effort, with thinking on, when the operator sets an effort", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useRoot(SONNET, [`baseUrl: ${upstream.baseUrl}`]);
    process.env.MODEL_REASONING_EFFORT = "high";
    const { runtime, turn } = await runOneTurn(SONNET);

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    expect(upstream.requests[0]!.body.reasoning_effort).toBe("high");
    expect(upstream.requests[0]!.body).not.toHaveProperty("thinking");
    expect(runtime.executionProfile.reasoningEffort).toBe("high");
    expect(runtime.modelSettings?.settings.reasoningEffort).toMatchObject({
      value: "high",
      source: "environment",
    });
  });

  it("sends no reasoning effort and keeps Sonnet's thinking off when no effort is set", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useRoot(SONNET, [`baseUrl: ${upstream.baseUrl}`]);
    const { turn } = await runOneTurn(SONNET);

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    expect(upstream.requests[0]!.body).not.toHaveProperty("reasoning_effort");
    // The gateway origin is not the Hub's; thinking-off keys on the model id.
    expect(upstream.requests[0]!.body.thinking).toEqual({ type: "disabled" });
  });

  it("keeps thinking off and records the effort as dropped when reasoning is set false", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useRoot(SONNET, [`baseUrl: ${upstream.baseUrl}`, "reasoning: false"]);
    process.env.MODEL_REASONING_EFFORT = "high";
    const { runtime, turn } = await runOneTurn(SONNET);

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    expect(upstream.requests[0]!.body.thinking).toEqual({ type: "disabled" });
    expect(upstream.requests[0]!.body).not.toHaveProperty("reasoning_effort");
    expect(runtime.executionProfile).not.toHaveProperty("reasoningEffort");
    expect(runtime.notes).toContainEqual(
      expect.stringContaining("reasoningEffort = high is not sent: reasoning is set to false"),
    );
  });

  it("records a renamed served model and lets the turn finish", async () => {
    const upstream = await startModelUpstream({
      expectedKey: KEY,
      servedModel: "gateway/renamed",
    });
    await useRoot(SONNET, [`baseUrl: ${upstream.baseUrl}`]);
    const { runtime, turn } = await runOneTurn(SONNET);

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    expect(runtime.runNotes.list()).toEqual([
      servedModelWarning({
        expectedModel: SONNET_MODEL,
        servedModels: ["gateway/renamed"],
      }),
    ]);
  });

  it("runs another model on a policy preset without the policy, and says why", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useRoot(QWEN, [`baseUrl: ${upstream.baseUrl}`]);
    setCliModelSettings({
      writing: { modelId: "nvidia/other/model" },
      judge: {},
    });
    const { runtime, turn } = await runOneTurn(QWEN);

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    expect(upstream.requests[0]!.body.model).toBe("nvidia/other/model");
    expect(upstream.requests[0]!.body).not.toHaveProperty("chat_template_kwargs");
    expect(runtime.executionProfile.compositionRequestPolicy).toBeUndefined();
    expect(runtime.notes).toContainEqual(
      expect.stringContaining("request policy fixes model nvidia/qwen/qwen3-5-397b-a17b"),
    );
  });

  it("runs a policy preset without its policy when the operator turns reasoning on, and says why", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useRoot(QWEN, [`baseUrl: ${upstream.baseUrl}`, "reasoning: true"]);
    const { runtime, turn } = await runOneTurn(QWEN);

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    expect(upstream.requests[0]!.body.model).toBe(QWEN_MODEL);
    expect(upstream.requests[0]!.body).not.toHaveProperty("chat_template_kwargs");
    expect(runtime.executionProfile.compositionRequestPolicy).toBeUndefined();
    expect(runtime.notes).toContainEqual(
      expect.stringContaining(
        "this run's reasoning setting differs, so requests are sent without it",
      ),
    );
  });

  it("keeps the policy preset's request policy on its own model (control)", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useRoot(QWEN, [`baseUrl: ${upstream.baseUrl}`]);
    const { turn } = await runOneTurn(QWEN);

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    expect(upstream.requests[0]!.body.chat_template_kwargs).toEqual({
      thinking: false,
    });
  });

  describe("an operator's reasoning: false with an effort keeps thinking off", () => {
    const SURFACES = [
      [
        "--set",
        [],
        () =>
          setCliModelSettings({
            writing: { reasoning: false, reasoningEffort: "high" },
            judge: {},
          }),
      ],
      [
        "the environment",
        [],
        () =>
          Object.assign(process.env, { MODEL_REASONING: "false", MODEL_REASONING_EFFORT: "high" }),
      ],
      ["host.yaml", ["reasoning: false", "reasoningEffort: high"], () => undefined],
    ] as const;

    function expectEffortDropped(runtime: Awaited<ReturnType<typeof runOneTurn>>["runtime"]): void {
      expect(runtime.modelSettings?.settings.reasoning.value).toBe(false);
      expect(runtime.modelSettings?.settings.reasoningEffort.value).toBe("high");
      expect(runtime.notes).toContainEqual(
        expect.stringContaining("reasoningEffort = high is not sent: reasoning is set to false"),
      );
    }

    it.each(SURFACES)(
      "from %s, the Qwen preset keeps its thinking-off policy",
      async (_surface, settings, set) => {
        const upstream = await startModelUpstream({ expectedKey: KEY });
        await useRoot(QWEN, [`baseUrl: ${upstream.baseUrl}`, ...settings]);
        set();
        const { runtime, turn } = await runOneTurn(QWEN);

        expect(turn.stopReason, turn.errorMessage).toBe("stop");
        const body = upstream.requests[0]!.body;
        expect(body.chat_template_kwargs).toEqual({ thinking: false });
        expect(body).not.toHaveProperty("reasoning_effort");
        expect(runtime.executionProfile.compositionRequestPolicy).toBeDefined();
        expect(runtime.notes.join("\n")).not.toContain("so requests are sent without it");
        expectEffortDropped(runtime);
      },
    );

    it.each(SURFACES)(
      "from %s, the Sonnet preset keeps thinking off on its own transport and on Messages",
      async (_surface, settings, set) => {
        set();
        for (const messages of [false, true]) {
          const upstream = await startModelUpstream({ expectedKey: KEY });
          const transport = messages ? ["transport: anthropic-messages"] : [];
          await useRoot(SONNET, [`baseUrl: ${upstream.baseUrl}`, ...transport, ...settings]);
          const { runtime, turn } = await runOneTurn(SONNET);

          expect(turn.stopReason, turn.errorMessage).toBe("stop");
          const body = upstream.requests[0]!.body;
          // Claude Sonnet 5 thinks unless a request turns thinking off, on
          // the Hub's chat completions and on Anthropic Messages alike.
          expect(body.thinking).toEqual({ type: "disabled" });
          expect(body).not.toHaveProperty("output_config");
          expect(body).not.toHaveProperty("reasoning_effort");
          expectEffortDropped(runtime);
        }
      },
    );

    it("with reasoning: true instead, the effort turns thinking on without the policy (control)", async () => {
      const upstream = await startModelUpstream({ expectedKey: KEY });
      await useRoot(QWEN, [
        `baseUrl: ${upstream.baseUrl}`,
        "reasoning: true",
        "reasoningEffort: high",
      ]);
      const { runtime, turn } = await runOneTurn(QWEN);

      expect(turn.stopReason, turn.errorMessage).toBe("stop");
      expect(upstream.requests[0]!.body).not.toHaveProperty("chat_template_kwargs");
      expect(runtime.executionProfile.compositionRequestPolicy).toBeUndefined();
    });
  });

  it("sends a transport the route is not known to serve, and warns", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useRoot(SONNET, [`baseUrl: ${upstream.baseUrl}`, "transport: openai-responses"]);
    const runtime = await loadCompositionRunRuntime(request(SONNET));
    expect(runtime.executionProfile.transport).toBe("openai-responses");
    expect(runtime.notes).toContainEqual(
      expect.stringContaining(
        "Transport openai-responses is not one route nvidia-inference-api is known to serve",
      ),
    );
    const connection = await runtime.providerConnectionFactory.create({
      profile: runtime.executionProfile,
      credential: runtime.credential,
    });
    await connection.runtime
      .streamSimple(connection.model, {
        systemPrompt: "Reply as instructed.",
        messages: [{ role: "user", content: "Reply with DOCSFAB_OK.", timestamp: 1 }],
      })
      .result();
    expect(upstream.requests[0]).toMatchObject({
      path: "/v1/responses",
      credential: "the configured key",
    });
  });

  it("refuses plain HTTP to a host that is not this machine before any request", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useRoot(SONNET);
    process.env.MODEL_BASE_URL = "http://models.example.test/v1";
    await expect(loadCompositionRunRuntime(request(SONNET))).rejects.toMatchObject({
      code: "model-endpoint-insecure-transport",
    });
    expect(upstream.requests).toEqual([]);
  });

  it("refuses a credential variable the preset does not read, before any request", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useRoot(SONNET, [`baseUrl: ${upstream.baseUrl}`, "credentialEnv: CORP_LLM_KEY"]);
    process.env.CORP_LLM_KEY = KEY;
    const refusal = await loadCompositionRunRuntime(request(SONNET)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toMatchObject({
      name: "CompositionCredentialSourceError",
      message: `MODEL_CREDENTIAL_ENV (the credentialEnv setting) names CORP_LLM_KEY, which composition ${SONNET} does not read; it reads MODEL_API_KEY.`,
    });
    // The operator sees a catalog code and the preset's own variable to use.
    expect(toOperatorErrorEnvelope(refusal)).toMatchObject({
      code: "invalid-model-profile-configuration",
      nextAction:
        "Set credentialEnv to MODEL_API_KEY, or remove it, keep the key in that variable, and retry.",
    });
    expect(upstream.requests).toEqual([]);
  });

  it("reads the key from a credential variable the preset names (control)", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useRoot(SONNET, [`baseUrl: ${upstream.baseUrl}`, "credentialEnv: MODEL_API_KEY"]);
    const { runtime, turn } = await runOneTurn(SONNET);

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    expect(upstream.requests[0]!.credential).toBe("the configured key");
    expect(runtime.credentialSourceName).toBe("MODEL_API_KEY");
    expect(runtime.modelSettings?.settings.credentialEnv).toMatchObject({
      value: "MODEL_API_KEY",
      source: "host-config",
    });
  });

  it("refuses a model id with a colon by name", async () => {
    await useRoot(SONNET);
    setCliModelSettings({ writing: { modelId: "llama3:8b" }, judge: {} });
    await expect(loadCompositionRunRuntime(request(SONNET))).rejects.toMatchObject({
      code: "contract-invalid-value",
      message:
        'The configured model id "llama3:8b" contains ":", which DocsFab run records cannot hold yet.',
    });
  });

  it.each([
    ["an effort", { MODEL_REASONING_EFFORT: "high" }, []],
    ["reasoning alone", {}, ["reasoning: true"]],
  ] as const)(
    "writes v2 evidence when the only operator change is %s",
    async (_label, environment, settings) => {
      await useRoot(SONNET, settings);
      Object.assign(process.env, environment);
      const runtime = await loadCompositionRunRuntime(request(SONNET));
      // The preset's own endpoint, model, and windows: only reasoning differs.
      expect(runtime.executionProfile.baseUrl).toBe(HUB);
      const evidence = createCompositionExecutionEvidence({
        runId: "settings-wire-run",
        bound: runtime.bound,
        executionProfile: runtime.executionProfile,
        configuredLimits: runtime.configuredLimits,
        workflow: {
          id: runtime.bound.workflow.workflowId,
          sourceSha256: runtime.bound.workflow.sourceSha256,
        },
        repository: { identitySha256: "a".repeat(64), revision: "b".repeat(40) },
        ...(runtime.modelSettings ? { modelSettings: runtime.modelSettings } : {}),
      });
      expect(evidence.kind).toBe("docsfab-composition-execution-evidence/v2");
      expect(evidence.effective?.modelSettingsSha256).toBe(canonicalDigest(runtime.modelSettings));
    },
  );

  it("binds the settings record into v2 composition evidence by digest, with no endpoint URL", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useRoot(SONNET, [`baseUrl: ${upstream.baseUrl}`, "maxOutputTokens: 65536"]);
    const runtime = await loadCompositionRunRuntime(request(SONNET));
    const evidence = createCompositionExecutionEvidence({
      runId: "settings-wire-run",
      bound: runtime.bound,
      executionProfile: runtime.executionProfile,
      configuredLimits: runtime.configuredLimits,
      workflow: {
        id: runtime.bound.workflow.workflowId,
        sourceSha256: runtime.bound.workflow.sourceSha256,
      },
      repository: { identitySha256: "a".repeat(64), revision: "b".repeat(40) },
      ...(runtime.modelSettings ? { modelSettings: runtime.modelSettings } : {}),
    });
    expect(evidence.kind).toBe("docsfab-composition-execution-evidence/v2");
    expect(evidence.effective).toMatchObject({
      modelId: SONNET_MODEL,
      modelSettingsSha256: canonicalDigest(runtime.modelSettings),
    });
    expect(evidence.effective?.deploymentIdentitySha256).not.toBe(
      evidence.deployment.identitySha256,
    );
    expect(evidence.limits.effective.maxOutputTokens).toBe(65536);
    expect(evidence.limits.composition.maxOutputTokens).toBe(32768);
    expect(JSON.stringify(evidence)).not.toContain(new URL(upstream.baseUrl).host);
  });
});

/**
 * The record and the request agree on reasoning: a setting that turns
 * reasoning on puts it on the wire for each transport, with an off control,
 * and whatever the wire carries that the record does not say is a note.
 */
describe("reasoning on the wire matches the record", () => {
  const RESPONSES = "transport: openai-responses";

  it("chat completions: an effort is sent as reasoning_effort; reasoning alone sends no field", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useRoot(SONNET, [`baseUrl: ${upstream.baseUrl}`, "reasoning: true"]);
    const { runtime, turn } = await runOneTurn(SONNET);

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    const body = upstream.requests[0]!.body;
    // Reasoning on: neither an effort nor Sonnet's thinking-off is sent, so
    // the provider's default reasoning applies, as the record says.
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("thinking");
    expect(runtime.executionProfile.profile.reasoning).toBe(true);
    expect(runtime.modelSettings?.settings.reasoning).toMatchObject({
      value: true,
      source: "host-config",
    });
    // The default is what every run sends, so it is no warning.
    expect(runtime.notes.join("\n")).not.toMatch(/no reasoningEffort|default level/u);
  });

  it("responses: an effort is sent as reasoning.effort, never as reasoning_effort", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useRoot(SONNET, [`baseUrl: ${upstream.baseUrl}`, RESPONSES, "reasoningEffort: high"]);
    const { runtime, turn } = await runOneTurn(SONNET);

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    expect(upstream.requests[0]!.path).toBe("/v1/responses");
    expect(upstream.requests[0]!.body.reasoning).toMatchObject({ effort: "high" });
    expect(upstream.requests[0]!.body).not.toHaveProperty("reasoning_effort");
    expect(runtime.notes.join("\n")).not.toContain("Reasoning is on with no reasoningEffort");
  });

  it("responses: reasoning alone sends Pi's default effort, medium", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useRoot(SONNET, [`baseUrl: ${upstream.baseUrl}`, RESPONSES, "reasoning: true"]);
    const { runtime, turn } = await runOneTurn(SONNET);

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    // Before the fix Pi sent {effort: "none"} here while the record said on.
    expect(upstream.requests[0]!.body.reasoning).toMatchObject({ effort: "medium" });
    expect(runtime.executionProfile.profile.reasoning).toBe(true);
    expect(runtime.notes.join("\n")).not.toMatch(/no reasoningEffort|default level/u);
  });

  it("responses: with reasoning off, no reasoning field is sent (control)", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useRoot(SONNET, [`baseUrl: ${upstream.baseUrl}`, RESPONSES]);
    const { runtime, turn } = await runOneTurn(SONNET, "high");

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    expect(runtime.executionProfile.profile.reasoning).toBe(false);
    // A caller's level does not turn reasoning on: the bound profile decides.
    expect(upstream.requests[0]!.body).not.toHaveProperty("reasoning");
  });

  it("anthropic: an effort turns on adaptive thinking with output_config.effort", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useRoot(ANTHROPIC, [`baseUrl: ${upstream.baseUrl}`]);
    process.env.MODEL_REASONING_EFFORT = "high";
    const { runtime, turn } = await runOneTurn(ANTHROPIC);

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    expect(upstream.requests[0]!.path).toMatch(/^\/v1\/messages(?:\?|$)/u);
    expect(upstream.requests[0]!.credential).toBe("the configured key");
    expect(upstream.requests[0]!.body.thinking).toMatchObject({ type: "adaptive" });
    expect(upstream.requests[0]!.body.output_config).toEqual({ effort: "high" });
    expect(runtime.modelSettings?.settings.reasoning).toMatchObject({ value: true });
    expect(runtime.notes.join("\n")).not.toContain("not sent");
  });

  it("anthropic: reasoning alone turns on adaptive thinking at Pi's default effort", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useRoot(ANTHROPIC, [`baseUrl: ${upstream.baseUrl}`, "reasoning: true"]);
    const { runtime, turn } = await runOneTurn(ANTHROPIC);

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    // Before the fix the record said true while the body said thinking disabled.
    expect(upstream.requests[0]!.body.thinking).toMatchObject({ type: "adaptive" });
    expect(upstream.requests[0]!.body.output_config).toEqual({ effort: "medium" });
    expect(runtime.executionProfile.profile.reasoning).toBe(true);
  });

  it.each(["xhigh", "max"] as const)(
    "anthropic: reasoningEffort %s is sent as written, not as Pi's high",
    async (effort) => {
      const upstream = await startModelUpstream({ expectedKey: KEY });
      await useRoot(ANTHROPIC, [`baseUrl: ${upstream.baseUrl}`, `reasoningEffort: ${effort}`]);
      const { runtime, turn } = await runOneTurn(ANTHROPIC);

      expect(turn.stopReason, turn.errorMessage).toBe("stop");
      // Pi alone maps a level its model entry does not list to "high".
      expect(upstream.requests[0]!.body.thinking).toMatchObject({ type: "adaptive" });
      expect(upstream.requests[0]!.body.output_config).toEqual({ effort });
      expect(runtime.modelSettings?.settings.reasoningEffort).toMatchObject({ value: effort });
    },
  );

  it("anthropic: minimal is sent as low, and the note says so", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useRoot(ANTHROPIC, [`baseUrl: ${upstream.baseUrl}`, "reasoningEffort: minimal"]);
    const { runtime, turn } = await runOneTurn(ANTHROPIC);

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    expect(upstream.requests[0]!.body.output_config).toEqual({ effort: "low" });
    expect(runtime.notes).toContain(
      "reasoningEffort minimal is sent as low: Anthropic Messages efforts are low, medium, high, xhigh, and max.",
    );
  });

  it("anthropic: a model without adaptive thinking binds reasoning off, and the note says so", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useRoot(ANTHROPIC, [
      `baseUrl: ${upstream.baseUrl}`,
      "modelId: claude-sonnet-4-5",
      "reasoningEffort: high",
    ]);
    const { runtime, turn } = await runOneTurn(ANTHROPIC, "high");

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    // Claude Sonnet 4.5 has no adaptive thinking, and a thinking budget would
    // sit on top of the turn's output limit: the record and the wire say off.
    expect(runtime.executionProfile.profile.reasoning).toBe(false);
    expect(runtime.executionProfile).not.toHaveProperty("reasoningEffort");
    expect(upstream.requests[0]!.body).not.toHaveProperty("thinking");
    expect(upstream.requests[0]!.body).not.toHaveProperty("output_config");
    expect(runtime.notes).toContain(
      "Reasoning at reasoningEffort high is not sent: model claude-sonnet-4-5 has no adaptive thinking in Pi's catalog, and DocsFab sends Anthropic Messages thinking only as adaptive thinking, so requests keep thinking off.",
    );
  });

  it("anthropic: a caller's level never sizes a thinking budget for a model bound off", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useRoot(ANTHROPIC, [`baseUrl: ${upstream.baseUrl}`, "modelId: claude-sonnet-4-5"]);
    const { runtime, turn } = await runOneTurn(ANTHROPIC, "high", 64);

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    expect(runtime.executionProfile.profile.reasoning).toBe(false);
    // Pi would add a "high" budget on top of the caller's 64 output tokens.
    expect(upstream.requests[0]!.body.max_tokens).toBe(64);
    expect(upstream.requests[0]!.body).not.toHaveProperty("thinking");
  });

  it("anthropic: a gateway's id for an adaptive model gets adaptive thinking", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useRoot(ANTHROPIC, [
      `baseUrl: ${upstream.baseUrl}`,
      "modelId: aws/anthropic/bedrock-claude-sonnet-5",
      "reasoningEffort: high",
    ]);
    const { runtime, turn } = await runOneTurn(ANTHROPIC);

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    expect(upstream.requests[0]!.body.thinking).toMatchObject({ type: "adaptive" });
    expect(upstream.requests[0]!.body.output_config).toEqual({ effort: "high" });
    expect(runtime.notes.join("\n")).not.toContain("no adaptive thinking");
  });

  it("anthropic: with reasoning off, no thinking or effort is sent (control)", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useRoot(ANTHROPIC, [`baseUrl: ${upstream.baseUrl}`]);
    const { runtime, turn } = await runOneTurn(ANTHROPIC, "high");

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    expect(runtime.executionProfile.profile.reasoning).toBe(false);
    expect(upstream.requests[0]!.body).not.toHaveProperty("thinking");
    expect(upstream.requests[0]!.body).not.toHaveProperty("output_config");
  });

  it("chat completions: the profile's effort wins over a caller's level", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useRoot(SONNET, [`baseUrl: ${upstream.baseUrl}`, "reasoningEffort: low"]);
    const { turn } = await runOneTurn(SONNET, "high");

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    expect(upstream.requests[0]!.body.reasoning_effort).toBe("low");
  });
});

/**
 * A profile slot is a default too: the operator's reasoning settings win over
 * the profile file, attested or not, and reach the wire.
 */
describe("a profile slot runs the operator's reasoning settings", () => {
  async function useProfileRoot(
    baseUrl: string,
    transport: "openai-chat-completions" | "openai-responses" | "anthropic-messages",
    /** The profile file's own reasoning; its metadata stays unattested. */
    reasoning = false,
  ): Promise<void> {
    const apiFormat = transport === "anthropic-messages" ? "messages" : "chat_completions";
    const root = await roots.create("docsfab-settings-wire-profile-", { mode: 0o700 });
    await writeFile(
      join(root, "host.yaml"),
      "schemaVersion: 1\nkind: docsfab-host-config\nactivePolicyProfile: profiles/byo.yaml\n",
    );
    await mkdir(join(root, "profiles"), { mode: 0o700 });
    await writeFile(
      join(root, "profiles", "byo.yaml"),
      [
        "schemaVersion: 1",
        "kind: docsfab-model-profile",
        "slot: policy",
        "provider: operator-configured-openai-compatible",
        `baseUrl: ${baseUrl}`,
        "modelId: example/model",
        `apiFormat: ${apiFormat}`,
        `transport: ${transport}`,
        "contextWindow: 128000",
        "maxInputTokens: 128000",
        "maxOutputTokens: 16384",
        "apiMinOutputTokens: 16",
        "contextReserveTokens: 1024",
        `reasoning: ${String(reasoning)}`,
        "inputTypes: text",
        "supportsDeveloperRole: false",
        "supportsReasoningEffort: false",
        `compatibleApiFormats: ${apiFormat}`,
        "inputCostPerMillion: unknown",
        "outputCostPerMillion: unknown",
        "cacheReadCostPerMillion: unknown",
        "cacheWriteCostPerMillion: unknown",
        "profileApprovedSource: unknown",
        "profileEffectiveDate: unknown",
        "profileReviewAfter: unknown",
        "",
      ].join("\n"),
    );
    await writeFile(join(root, "secrets.env"), `MODEL_API_KEY=${KEY}\n`, { mode: 0o600 });
    process.env.DOCSFAB_CONFIG_ROOT = root;
    process.env.HOME = root;
  }

  async function profileTurn() {
    const config = loadConfig(process.env);
    const binding = await resolveOperatorExecutionBinding({ model: config.model });
    const connection = await createProviderConnectionFactory({
      routeId: binding.profile.routeId,
      transport: binding.profile.transport,
    }).create({ profile: binding.profile, credential: binding.credential });
    const turn = await connection.runtime
      .streamSimple(connection.model, {
        systemPrompt: "Reply as instructed.",
        messages: [{ role: "user", content: "Reply with DOCSFAB_OK.", timestamp: 1 }],
      })
      .result();
    return { binding, turn };
  }

  it("--set reasoning=true turns reasoning on over unattested profile metadata", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useProfileRoot(upstream.baseUrl, "openai-responses");
    setCliModelSettings({ writing: { reasoning: true }, judge: {} });
    const { binding, turn } = await profileTurn();

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    expect(binding.match).toBe("unmatched-byo");
    // Before the fix the record said true and the bound profile said false.
    expect(binding.modelSettings?.settings.reasoning).toMatchObject({
      value: true,
      source: "cli-flag",
    });
    expect(binding.profile.profile.reasoning).toBe(true);
    expect(upstream.requests[0]!.body.reasoning).toMatchObject({ effort: "medium" });
  });

  it("an effort turns reasoning on for a profile slot and is sent", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useProfileRoot(upstream.baseUrl, "openai-chat-completions");
    process.env.MODEL_REASONING_EFFORT = "High";
    const { binding, turn } = await profileTurn();

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    expect(binding.profile.profile.reasoning).toBe(true);
    expect(binding.profile.reasoningEffort).toBe("high");
    expect(upstream.requests[0]!.body.reasoning_effort).toBe("high");
  });

  it.each([
    ["claude-sonnet-5", "turns its default thinking off", { type: "disabled" }, false],
    ["claude-opus-5-5", "cannot turn thinking off, and says so", undefined, true],
    ["claude-opus-4-7", "thinks only when asked (control)", undefined, false],
  ])("with reasoning off, Messages model %s %s", async (modelId, _what, thinking, warned) => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useProfileRoot(upstream.baseUrl, "anthropic-messages");
    setCliModelSettings({ writing: { modelId }, judge: {} });
    const { binding, turn } = await profileTurn();

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    expect(binding.profile.profile.reasoning).toBe(false);
    expect(upstream.requests[0]!.body.thinking).toEqual(thinking);
    expect(
      binding.notes.includes(
        `Model ${modelId} thinks by default on Anthropic Messages and cannot turn thinking off, so it may think although reasoning is recorded as off.`,
      ),
    ).toBe(warned);
  });

  it("--set reasoning=true binds off for a Messages model without adaptive thinking, and says so", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useProfileRoot(upstream.baseUrl, "anthropic-messages");
    setCliModelSettings({ writing: { reasoning: true }, judge: {} });
    const { binding, turn } = await profileTurn();

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    expect(binding.modelSettings?.settings.reasoning).toMatchObject({
      value: true,
      source: "cli-flag",
    });
    // The record never says on while the wire says off.
    expect(binding.profile.profile.reasoning).toBe(false);
    expect(upstream.requests[0]!.body).not.toHaveProperty("thinking");
    expect(binding.notes).toContain(
      "Reasoning is not sent: model example/model has no adaptive thinking in Pi's catalog, and DocsFab sends Anthropic Messages thinking only as adaptive thinking, so requests keep thinking off.",
    );
  });

  it("an unattested profile's own reasoning: true stays stripped without an operator setting", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useProfileRoot(upstream.baseUrl, "openai-responses", true);
    const { binding, turn } = await profileTurn();

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    // Only an operator's setting wins over the strip of unattested claims.
    expect(binding.modelSettings?.settings.reasoning).toMatchObject({
      value: true,
      source: "profile-file",
    });
    expect(binding.profile.profile.reasoning).toBe(false);
    expect(upstream.requests[0]!.body).not.toHaveProperty("reasoning");
  });

  it("the profile's own reasoning stays off without an operator setting (control)", async () => {
    const upstream = await startModelUpstream({ expectedKey: KEY });
    await useProfileRoot(upstream.baseUrl, "openai-responses");
    const { binding, turn } = await profileTurn();

    expect(turn.stopReason, turn.errorMessage).toBe("stop");
    expect(binding.profile.profile.reasoning).toBe(false);
    expect(upstream.requests[0]!.body).not.toHaveProperty("reasoning");
  });
});
