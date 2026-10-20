// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadCompositionRunRuntime } from "../src/cli/run/composition-runtime.js";
import type { RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import { canonicalDigest } from "../src/contract-kit/index.js";
import type {
  BoundModelExecutionProfile,
  ProviderCredential,
  ProviderCredentialFamily,
  ProviderTransport,
} from "../src/model/configuration.js";
import { createProviderConnectionFactory } from "../src/model/provider.js";
import {
  parseHostRuntimeComposition,
  sealHostRuntimeComposition,
} from "../src/host-invoker/contracts.js";
import {
  DOCSFAB_SYSTEM_PROMPT,
  DOCSFAB_SYSTEM_PROMPT_SHA256,
} from "../src/model/request-policy.js";
import { validModelConfig } from "./helpers.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";

/**
 * Bounded reasoning on the Inference Hub's Claude Sonnet 5 lane.
 *
 * With no reasoning field, Sonnet 5 on this route thinks by default with its
 * thinking display omitted: the thinking is billed against
 * `max_completion_tokens` but never streamed. A route probe measured:
 *
 * - no reasoning field: a bare-integer answer billed all 16,384 completion
 *   tokens and surfaced 0 visible characters (`finish_reason=length`);
 * - `thinking: {type: "disabled"}`: 371 completion tokens, `stop`, answer
 *   visible, so the route forwards and honors it;
 * - `reasoning_effort: "none"`: HTTP 200 and inert (16,384 tokens, 0 visible),
 *   the same accepted-but-inert trap the Nemotron control union records;
 * - `reasoning_effort: "low"`: an immediate HTTP 408 from the gateway.
 *
 * DocsFab therefore sends exactly `thinking: {type: "disabled"}` on this lane
 * and no `reasoning_effort`, which is what the sealed profile's
 * `reasoning: false` declares. No other lane changes.
 */

const HUB_BASE_URL = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];
const SONNET_5 = "aws/anthropic/bedrock-claude-sonnet-5";
const OPUS_5 = "aws/anthropic/bedrock-claude-opus-5";
const SWITCHYARD_SOL = "switchyard/openai/gpt-5.6-sol";
const SONNET_5_COMPOSITION = "nvidia-inference-claude-sonnet-5-pi";
const OPUS_5_COMPOSITION = "nvidia-inference-claude-opus-5-pi";
const THINKING_OFF = { type: "disabled" } as const;

/** A recorded Sonnet 5 reply to `/docsfab ask` (see live-agent-turn.test.ts). */
const RECORDED_ANSWER = readFileSync(
  join(import.meta.dirname, "fixtures/real-model-20260924/live-agent-answer-write-grant-flag.txt"),
  "utf8",
).trim();

function hubProfile(
  input: {
    modelId?: string;
    baseUrl?: string;
    reasoning?: boolean;
    transport?: ProviderTransport;
  } = {},
): BoundModelExecutionProfile {
  return {
    routeId: "nvidia-inference-api",
    providerId: "nvidia-inference-api",
    baseUrl: input.baseUrl ?? HUB_BASE_URL,
    modelId: input.modelId ?? SONNET_5,
    transport: input.transport ?? "openai-chat-completions",
    apiFormat: "chat_completions",
    profile: {
      ...validModelConfig.profile,
      // The lane's sealed profile (config/profiles/claude-sonnet-5-nvidia-inference.yaml).
      reasoning: input.reasoning ?? false,
      compatibility: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        apiFormats: ["chat_completions"],
      },
    },
    requestPolicy: validModelConfig.requestPolicy,
  };
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

/** Token counts the fixture stream reports (fixture plumbing, not a bound). */
const STREAM_USAGE = { input: 12_418, output: 212 } as const;

/**
 * A stream framed the way the Hub's LiteLLM front door frames Bedrock Claude:
 * `chatcmpl-` id, `system_fingerprint: null`, one content delta per line of the
 * answer, a finish chunk, then the usage chunk with an empty `choices` array
 * and a `reasoning_tokens` count of 0 (the route reports 0 even when the model
 * thinks, so nothing here depends on it).
 */
function hubStream(model: string, text: string): Response {
  const id = "chatcmpl-7d9e2c14-0b5a-4f7e-8c61-3a2f9b8e4d10";
  const created = 1_790_553_600;
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ id, created, model, object: "chat.completion.chunk", system_fingerprint: null, choices, ...extra })}\n\n`;
  const [first = "", ...rest] = text.split(/(?<=\n)/u);
  const body = [
    chunk([{ index: 0, delta: { role: "assistant", content: first }, finish_reason: null }]),
    ...rest.map((piece) => chunk([{ index: 0, delta: { content: piece }, finish_reason: null }])),
    chunk([{ index: 0, delta: {}, finish_reason: "stop" }]),
    chunk([], {
      usage: {
        prompt_tokens: STREAM_USAGE.input,
        completion_tokens: STREAM_USAGE.output,
        total_tokens: STREAM_USAGE.input + STREAM_USAGE.output,
        completion_tokens_details: { reasoning_tokens: 0 },
        prompt_tokens_details: { cached_tokens: 0 },
      },
    }),
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function connect(
  profile: BoundModelExecutionProfile,
  credential: ProviderCredential,
  answer: string,
) {
  const requests: Record<string, unknown>[] = [];
  const factory = createProviderConnectionFactory({
    routeId: profile.routeId,
    transport: profile.transport,
    fetch: async (_request, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return hubStream(profile.modelId, answer);
    },
  });
  const connection = await factory.create(
    { profile, credential },
    { evidenceIdentity: { repositoryRevision: "a".repeat(40) } },
  );
  return { requests, connection };
}

async function sendOneTurn(input: {
  profile: BoundModelExecutionProfile;
  family?: ProviderCredentialFamily;
  tools?: boolean;
  onPayload?: (payload: Record<string, unknown>) => Record<string, unknown>;
  credential?: ProviderCredential;
  answer?: string;
}) {
  const { requests, connection } = await connect(
    input.profile,
    input.credential ?? { family: input.family ?? "nvidia-inference-api", apiKey: "test-key" },
    input.answer ?? "OK",
  );
  const result = await connection.runtime
    .streamSimple(
      connection.model,
      {
        systemPrompt: DOCSFAB_SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
        tools: (input.tools === false ? [] : [readTool()]) as never,
      },
      {
        maxTokens: 64,
        ...(input.onPayload
          ? {
              onPayload: (payload: unknown) => input.onPayload!(payload as Record<string, unknown>),
            }
          : {}),
      },
    )
    .result();
  return { requests, result, connection };
}

function onlyRequest(requests: Record<string, unknown>[]): Record<string, unknown> {
  expect(requests).toHaveLength(1);
  return requests[0]!;
}

/** Bind an installed composition exactly as `docsfab run --composition` does. */
async function bindComposition(compositionId: string, modelId: string) {
  const request: RunRequestWithPublishProjection = {
    workflow: "review-documentation",
    repositoryPath: "/tmp/docsfab-composition-target",
    revision: "HEAD",
    allowWrite: false,
    releaseGate: false,
    verbose: false,
    json: false,
    showScan: false,
    compositionId,
  };
  const config: DocsFabConfig = {
    projectRoot: "/opt/docsfab/runtime",
    skillCrateDirectory: "/opt/docsfab/runtime/skill-crate",
    qualityDirectory: "/opt/docsfab/runtime/quality",
    qualityPackDirectory: "/opt/docsfab/runtime/quality-pack",
    stateDirectory: "/tmp/docsfab-state/runs",
    retryPolicy: {
      maxRetries: 0,
      baseDelayMs: 1,
      maxDelayMs: 1,
      retryableCategories: ["provider-transient"],
    },
    model: {
      ...validModelConfig,
      providerId: "nvidia-inference-api",
      baseUrl: HUB_BASE_URL,
      modelId,
      apiKey: "selected-test-credential",
      profile: hubProfile({ modelId }).profile,
    },
  };
  // The sealed values of the two Hub Claude records, so the connection
  // carries the same response-byte and model-identity guards a hosted job does.
  return loadCompositionRunRuntime(request, config, {
    DOCSFAB_COMPOSITION_EXECUTION_MAX_PROVIDER_TURNS: "512",
    DOCSFAB_COMPOSITION_EXECUTION_TIMEOUT_MS: "1800000",
    DOCSFAB_COMPOSITION_EXECUTION_MAX_RESPONSE_BYTES: "4194304",
  });
}

describe("Hub Claude Sonnet 5 bounded reasoning", () => {
  it("sends exactly thinking disabled on the lane, and hashes the body it sent", async () => {
    const { requests, result, connection } = await sendOneTurn({ profile: hubProfile() });

    expect(result.stopReason).toBe("stop");
    const sent = onlyRequest(requests);
    // The whole wire body: pi-ai's chat-completions shape for this lane plus
    // the one field this rule adds. Anything else appearing or disappearing
    // fails here by name.
    expect(sent).toEqual({
      model: SONNET_5,
      messages: [
        { role: "system", content: DOCSFAB_SYSTEM_PROMPT },
        { role: "user", content: "Reply OK." },
      ],
      stream: true,
      stream_options: { include_usage: true },
      store: false,
      max_completion_tokens: 64,
      tools: [
        {
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
        },
      ],
      thinking: THINKING_OFF,
    });
    expect(connection.turnGovernance?.evidence()[0]?.finalPayloadSha256).toBe(
      canonicalDigest(sent),
    );
  });

  it("sends it on a request that carries no tools", async () => {
    // The hidden budget burns on every turn, not only on tool turns, so the
    // rule must not be gated on tools (as the retired Switchyard rule was).
    const { requests } = await sendOneTurn({ profile: hubProfile(), tools: false });

    const sent = onlyRequest(requests);
    expect(sent).not.toHaveProperty("tools");
    expect(sent.thinking).toEqual(THINKING_OFF);
  });

  it.each([
    {
      name: 'reasoning_effort "none" (accepted and inert on this route)',
      field: { reasoning_effort: "none" },
    },
    {
      name: 'reasoning_effort "low" (refused with an immediate 408)',
      field: { reasoning_effort: "low" },
    },
    { name: "adaptive thinking", field: { thinking: { type: "adaptive" } } },
  ])("replaces $name from a payload hook with thinking disabled only", async ({ field }) => {
    const { requests, connection } = await sendOneTurn({
      profile: hubProfile(),
      onPayload: (payload) => ({ ...payload, ...field }),
    });

    const sent = onlyRequest(requests);
    expect(sent).not.toHaveProperty("reasoning_effort");
    expect(sent.thinking).toEqual(THINKING_OFF);
    expect(connection.turnGovernance?.evidence()[0]?.finalPayloadSha256).toBe(
      canonicalDigest(sent),
    );
  });

  it("disables thinking for Claude Sonnet 5 behind another origin, keyed on the model id", async () => {
    const { requests, result } = await sendOneTurn({
      profile: hubProfile({ baseUrl: "https://inference.example.test/v1" }),
    });

    expect(result.stopReason).toBe("stop");
    const sent = onlyRequest(requests);
    expect(sent.thinking).toEqual(THINKING_OFF);
    expect(sent).not.toHaveProperty("reasoning_effort");
  });

  it("disables thinking for a sealed hosted packet whose id the registry does not hold (control)", async () => {
    // The pilot's installed packets carry a snapshot id outside the registry;
    // packages/host/test/dispatcher-installed-composition.test.ts checks that
    // they declare this model, transport, and `reasoning: false`. Only those
    // inputs select thinking-off, never the composition id.
    const sealed = sealHostRuntimeComposition({
      compositionId: `${SONNET_5_COMPOSITION}-installed-snapshot`,
      route: "nvidia-inference-api",
      credentialFamily: "nvidia-inference-api",
      executionProfile: {
        ...hubProfile(),
        compositionPolicy: { maxProviderTurns: 4, timeoutMs: 30_000, maxResponseBytes: 1_048_576 },
      },
      declaredTools: ["read"],
    });
    const profile = parseHostRuntimeComposition(structuredClone(sealed)).executionProfile!;
    expect(profile.modelId).toBe(SONNET_5);
    expect(profile.profile.reasoning).toBe(false);

    const { requests, result } = await sendOneTurn({ profile });

    expect(result.stopReason).toBe("stop");
    const sent = onlyRequest(requests);
    expect(sent.model).toBe(SONNET_5);
    expect(sent.thinking).toEqual(THINKING_OFF);
    expect(sent).not.toHaveProperty("reasoning_effort");
  });

  it("sends the operator's reasoning effort, and no thinking field, when reasoning is on", async () => {
    const { requests, result } = await sendOneTurn({
      profile: { ...hubProfile({ reasoning: true }), reasoningEffort: "high" },
    });

    expect(result.stopReason).toBe("stop");
    const sent = onlyRequest(requests);
    expect(sent.reasoning_effort).toBe("high");
    expect(sent).not.toHaveProperty("thinking");
  });

  it.each([
    {
      name: "Claude Opus 5 on the same route",
      profile: () => hubProfile({ modelId: OPUS_5 }),
    },
    {
      name: "a Sonnet 5 profile that declares reasoning",
      profile: () => hubProfile({ reasoning: true }),
    },
  ])("leaves the body of $name without a thinking field", async ({ profile }) => {
    const { requests, result } = await sendOneTurn({ profile: profile() });

    expect(result.stopReason).toBe("stop");
    const sent = onlyRequest(requests);
    expect(sent).not.toHaveProperty("thinking");
    expect(sent).not.toHaveProperty("reasoning_effort");
    // Positive control for the comparison above: the request did reach the
    // wire with its tools, so the absence is the rule's, not a dropped body.
    expect(sent.tools).toHaveLength(1);
  });

  it("leaves a Sonnet 5 request over the Responses transport without a thinking field", async () => {
    const requests: Record<string, unknown>[] = [];
    const profile = hubProfile({ transport: "openai-responses" });
    const factory = createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async (_request, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return hubStream(profile.modelId, "OK");
      },
    });
    const connection = await factory.create({
      profile,
      credential: { family: "openai-compatible-api", apiKey: "test-key" },
    });
    await connection.runtime
      .streamSimple(
        connection.model,
        { messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }] },
        { maxTokens: 64 },
      )
      .result();

    expect(requests.length).toBeGreaterThan(0);
    for (const sent of requests) {
      // Positive control: this is the Responses body, not a chat-completions one.
      expect(sent).toHaveProperty("max_output_tokens", 64);
      expect(sent).not.toHaveProperty("thinking");
    }
  });

  it("leaves the installed request policy path untouched on the same model", async () => {
    const body = {
      schemaVersion: 1 as const,
      modelId: SONNET_5,
      routeId: "nvidia-inference-api" as const,
      deploymentIdentitySha256: "c".repeat(64),
      transport: "openai-chat-completions" as const,
      reasoningMode: "disabled" as const,
      reasoningControl: { kind: "chat-template-kwarg" as const, thinking: false as const },
      installedSystemInstructionSha256: DOCSFAB_SYSTEM_PROMPT_SHA256,
      temperature: 0 as const,
      topP: 1 as const,
    };
    const { requests, result } = await sendOneTurn({
      profile: {
        ...hubProfile(),
        compositionRequestPolicy: { ...body, policySha256: canonicalDigest(body) },
      },
    });

    expect(result.stopReason).toBe("stop");
    const sent = onlyRequest(requests);
    expect(sent).not.toHaveProperty("thinking");
    // Positive control: the installed policy's own control reached the wire.
    expect(sent.chat_template_kwargs).toEqual({ thinking: false });
  });

  it("adds neither reasoning_effort nor thinking for the retired Switchyard GPT-5.6 Sol id", async () => {
    // The Switchyard tool-reasoning workaround went with the model's
    // retirement (#1512); configuration now refuses the id (see provider.test.ts).
    // A hand-built profile still proves nothing is injected for it.
    const { requests } = await sendOneTurn({ profile: hubProfile({ modelId: SWITCHYARD_SOL }) });

    const sent = onlyRequest(requests);
    expect(sent).not.toHaveProperty("reasoning_effort");
    expect(sent).not.toHaveProperty("thinking");
    // Positive control: the tool request reached the wire.
    expect(sent.tools).toHaveLength(1);
  });

  it("reaches the wire through the installed Sonnet 5 composition record", async () => {
    // Shipped path: the registry record -> resolveOperatorExecutionBinding ->
    // createProviderConnectionFactory -> finalizeProviderPayload. The rule keys
    // on the record's own model id and route origin, not on this file's copy.
    const runtime = await bindComposition(SONNET_5_COMPOSITION, SONNET_5);
    expect(runtime.executionProfile.modelId).toBe(SONNET_5);
    expect(runtime.executionProfile).not.toHaveProperty("compositionRequestPolicy");

    const { requests, result } = await sendOneTurn({
      profile: runtime.executionProfile,
      credential: runtime.credential,
    });

    expect(result.stopReason).toBe("stop");
    const sent = onlyRequest(requests);
    expect(sent.model).toBe(SONNET_5);
    expect(sent.thinking).toEqual(THINKING_OFF);
    expect(sent).not.toHaveProperty("reasoning_effort");
  });

  it("decodes a recorded pilot answer exactly as the lane without the rule does", async () => {
    // Positive control with a real reply: a recorded Sonnet 5 answer, streamed
    // in the Hub's framing, through the installed Sonnet 5 composition (rule on)
    // and the installed Opus 5 composition (rule off), each with its sealed
    // response-byte and model-identity guards.
    const decoded = [];
    for (const [compositionId, modelId, ruleOn] of [
      [SONNET_5_COMPOSITION, SONNET_5, true],
      [OPUS_5_COMPOSITION, OPUS_5, false],
    ] as const) {
      const runtime = await bindComposition(compositionId, modelId);
      const { requests, result } = await sendOneTurn({
        profile: runtime.executionProfile,
        credential: runtime.credential,
        answer: RECORDED_ANSWER,
      });
      expect(onlyRequest(requests).thinking, compositionId).toEqual(
        ruleOn ? THINKING_OFF : undefined,
      );
      decoded.push({
        stopReason: result.stopReason,
        content: result.content,
        output: result.usage.output,
      });
    }

    expect(decoded[0]).toEqual({
      stopReason: "stop",
      content: [{ type: "text", text: RECORDED_ANSWER }],
      output: STREAM_USAGE.output,
    });
    expect(decoded[1]).toEqual(decoded[0]);
  });
});
