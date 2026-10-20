// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../src/contract-kit/index.js";
import type {
  BoundModelExecutionProfile,
  ProviderCredentialFamily,
  ProviderTransport,
} from "../src/model/configuration.js";
import { createPayloadSendGate, createProviderConnectionFactory } from "../src/model/provider.js";
import { ProviderRequestPolicyError } from "../src/model/request-policy.js";
import { validModelConfig } from "./helpers.js";

/**
 * The payload send gate proves the bytes sent are the bytes the request policy
 * authorized. Pi's Anthropic SDK moves `betas` from the JSON body to the
 * `anthropic-beta` header on the beta Messages path; that one move is the only
 * accepted difference, and only on the Anthropic Messages transport.
 */

const INTERLEAVED_THINKING = "interleaved-thinking-2025-05-14";
const MISMATCH =
  "Provider request rejected by the installed request policy (payload-send: payload-send-mismatch).";

interface SentRequest {
  readonly url: URL;
  readonly headers: Headers;
  readonly rawBody: string;
  readonly body: Record<string, unknown>;
}

const ROUTES = {
  "anthropic-messages": {
    routeId: "direct-anthropic",
    family: "anthropic-api",
  },
  "openai-chat-completions": { routeId: "direct-openai", family: "openai-api" },
} as const satisfies Partial<
  Record<ProviderTransport, { routeId: string; family: ProviderCredentialFamily }>
>;
type RouteTransport = keyof typeof ROUTES;

/**
 * The bound profile decides whether a request thinks, so a turn without
 * reasoning binds a profile with reasoning off.
 */
function boundProfile(transport: RouteTransport, reasoning: boolean): BoundModelExecutionProfile {
  const apiFormat = transport === "anthropic-messages" ? "messages" : "chat_completions";
  return {
    routeId: ROUTES[transport].routeId,
    providerId: `provider-${ROUTES[transport].routeId}`,
    baseUrl: "https://models.example.test/v1",
    modelId: "model-under-test",
    transport,
    apiFormat,
    profile: {
      ...validModelConfig.profile,
      reasoning,
      compatibility: {
        ...validModelConfig.profile.compatibility,
        apiFormats: [apiFormat],
      },
    },
    requestPolicy: validModelConfig.requestPolicy,
  };
}

function sse(events: Record<string, unknown>[]): Response {
  return new Response(
    events
      .map(
        (event) =>
          `${typeof event.type === "string" ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** The same wire shapes `public-provider-setup.test.ts` replays, text only. */
function reply(transport: RouteTransport, model: string): Response {
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
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "OK" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
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
          delta: { role: "assistant", content: "OK" },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chat_test",
      object: "chat.completion.chunk",
      model,
      created: 1,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    },
  ]);
}

/**
 * One governed turn through the shipped connection: Pi builds the request, the
 * request policy finalizes and records it, Pi's SDK sends it through the send
 * gate, and the provider fetch below is the target.
 */
async function sendOneTurn(input: {
  transport: RouteTransport;
  reasoning: boolean;
  headers?: Record<string, string>;
  onPayload?: (payload: Record<string, unknown>) => Record<string, unknown>;
}) {
  const profile = boundProfile(input.transport, input.reasoning);
  const requests: SentRequest[] = [];
  const connection = await createProviderConnectionFactory({
    routeId: profile.routeId,
    transport: input.transport,
    fetch: async (url, init) => {
      const rawBody = String(init?.body);
      requests.push({
        url: new URL(String(url)),
        headers: new Headers(init?.headers),
        rawBody,
        body: JSON.parse(rawBody) as Record<string, unknown>,
      });
      return reply(input.transport, profile.modelId);
    },
  }).create(
    {
      profile,
      credential: {
        family: ROUTES[input.transport].family,
        apiKey: "provider-test-placeholder",
      },
    },
    { evidenceIdentity: { repositoryRevision: "d".repeat(40) } },
  );
  const result = await connection.runtime
    .streamSimple(
      connection.model,
      {
        systemPrompt: "Payload send gate integration test.",
        messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
      },
      {
        ...(input.reasoning ? { reasoning: "medium" as const } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
        ...(input.onPayload
          ? {
              onPayload: (payload: unknown) => input.onPayload!(payload as Record<string, unknown>),
            }
          : {}),
      },
    )
    .result();
  const evidence = connection.turnGovernance?.evidence()[0];
  return { requests, result, evidence };
}

describe("payload send gate on the shipped provider stream", () => {
  it("sends a thinking request with betas moved to the anthropic-beta header (T1)", async () => {
    const { requests, result, evidence } = await sendOneTurn({
      transport: "anthropic-messages",
      reasoning: true,
    });

    expect(evidence?.requestPolicyRefusal).toBeUndefined();
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(requests).toHaveLength(1);
    const [sent] = requests;
    expect(sent!.url.pathname).toBe("/v1/messages");
    expect(sent!.url.search).toBe("?beta=true");
    expect(sent!.body).not.toHaveProperty("betas");
    expect(sent!.body.thinking).toMatchObject({ type: "enabled" });
    expect(sent!.headers.get("anthropic-beta")).toBe(INTERLEAVED_THINKING);
    // The evidence digest is the authorized payload, betas included; the wire
    // body is exactly that payload with only `betas` removed.
    const authorized = { ...sent!.body, betas: [INTERLEAVED_THINKING] };
    expect(evidence?.finalPayloadSha256).toBe(canonicalDigest(authorized));
    expect(sent!.rawBody).toBe(JSON.stringify(sent!.body));
  });

  it("still sends a request without betas byte-exactly, with no beta header (T5)", async () => {
    const { requests, result, evidence } = await sendOneTurn({
      transport: "anthropic-messages",
      reasoning: false,
    });

    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(requests).toHaveLength(1);
    const [sent] = requests;
    expect(sent!.body).not.toHaveProperty("betas");
    expect(sent!.headers.has("anthropic-beta")).toBe(false);
    expect(evidence?.finalPayloadSha256).toBe(canonicalDigest(sent!.body));
  });

  it("keeps configured betas in order across the move", async () => {
    const { requests, result, evidence } = await sendOneTurn({
      transport: "anthropic-messages",
      reasoning: false,
      onPayload: (payload) => ({
        ...payload,
        betas: ["zeta-beta", "alpha-beta"],
      }),
    });

    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get("anthropic-beta")).toBe("zeta-beta,alpha-beta");
    expect(evidence?.finalPayloadSha256).toBe(
      canonicalDigest({
        ...requests[0]!.body,
        betas: ["zeta-beta", "alpha-beta"],
      }),
    );
  });

  // Adjacent conditions: the SDK moves other fields too. Only `betas` is
  // accepted, so each of these still refuses before any byte reaches the target.
  it.each([
    {
      name: "workspace_id moved to its header",
      edit: (payload: Record<string, unknown>) => ({
        ...payload,
        workspace_id: "wrkspc_test",
      }),
    },
    {
      name: "output_format rewritten to output_config",
      edit: (payload: Record<string, unknown>) => ({
        ...payload,
        output_format: { type: "json_schema", schema: { type: "object" } },
      }),
    },
    {
      name: "a beta value that names two betas in the header",
      edit: (payload: Record<string, unknown>) => ({
        ...payload,
        betas: ["alpha-beta,zeta-beta"],
      }),
    },
    {
      name: "a beta value with whitespace the header would not keep",
      edit: (payload: Record<string, unknown>) => ({ ...payload, betas: ["alpha beta"] }),
    },
    {
      name: "a betas field that is not a list",
      edit: (payload: Record<string, unknown>) => ({
        ...payload,
        betas: "alpha-beta",
      }),
    },
    {
      name: "an empty betas list",
      edit: (payload: Record<string, unknown>) => ({ ...payload, betas: [] }),
    },
  ])("refuses $name with payload-send-mismatch (T2)", async ({ edit }) => {
    const { requests, result, evidence } = await sendOneTurn({
      transport: "anthropic-messages",
      reasoning: true,
      onPayload: edit,
    });

    expect(result.stopReason).toBe("error");
    expect(evidence?.requestPolicyRefusal).toBe("payload-send");
    expect(requests).toHaveLength(0);
  });

  it("refuses an anthropic-beta header the authorized payload does not carry (T3)", async () => {
    // A caller header reaches the SDK's default headers; with `betas` removed
    // before authorization, the SDK still sends it as an unauthorized beta.
    const { requests, result, evidence } = await sendOneTurn({
      transport: "anthropic-messages",
      reasoning: false,
      headers: { "anthropic-beta": "alpha-beta" },
      onPayload: ({ betas: _betas, ...payload }) => payload,
    });

    expect(result.stopReason).toBe("error");
    expect(evidence?.requestPolicyRefusal).toBe("payload-send");
    expect(requests).toHaveLength(0);
  });

  it("sends betas in the body unchanged on a non-Anthropic transport (T4)", async () => {
    const { requests, result, evidence } = await sendOneTurn({
      transport: "openai-chat-completions",
      reasoning: false,
      onPayload: (payload) => ({ ...payload, betas: [INTERLEAVED_THINKING] }),
    });

    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.betas).toEqual([INTERLEAVED_THINKING]);
    expect(evidence?.finalPayloadSha256).toBe(canonicalDigest(requests[0]!.body));
  });
});

describe("createPayloadSendGate", () => {
  const authorized = Object.freeze({
    model: "model-under-test",
    max_tokens: 64,
    stream: true,
    betas: Object.freeze(["zeta-beta", "alpha-beta"]),
    messages: Object.freeze([{ role: "user", content: "Reply OK." }]),
  });
  const { betas: _betas, ...wire } = authorized;
  const url = "https://models.example.test/v1/messages?beta=true";

  function gate(transport: ProviderTransport) {
    const sent: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const sendGate = createPayloadSendGate(async (input, init) => {
      sent.push({ input, ...(init ? { init } : {}) });
      return new Response(null, { status: 204 });
    }, transport);
    sendGate.authorize(authorized, canonicalDigest(authorized));
    return { sendGate, sent };
  }

  it("sends its own serialization of the wire form, not the supplied bytes", async () => {
    const { sendGate, sent } = gate("anthropic-messages");
    // Canonically equal, but not the bytes the gate serializes.
    const supplied = JSON.stringify(
      {
        messages: wire.messages,
        stream: true,
        max_tokens: 64,
        model: wire.model,
      },
      null,
      1,
    );
    await sendGate.fetch(url, {
      method: "POST",
      headers: { "anthropic-beta": "zeta-beta,alpha-beta" },
      body: supplied,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.init?.body).toBe(JSON.stringify(wire));
    expect(new Headers(sent[0]!.init?.headers).get("anthropic-beta")).toBe("zeta-beta,alpha-beta");
  });

  it("reads the beta header from a Request when init carries no headers", async () => {
    const { sendGate, sent } = gate("anthropic-messages");
    await sendGate.fetch(
      new Request(url, {
        method: "POST",
        headers: { "anthropic-beta": "zeta-beta,alpha-beta" },
        body: JSON.stringify(wire),
      }),
    );

    expect(sent).toHaveLength(1);
  });

  it.each([
    { name: "missing", headers: {} as Record<string, string> },
    {
      name: "reordered",
      headers: { "anthropic-beta": "alpha-beta,zeta-beta" },
    },
    {
      name: "carrying an extra value",
      headers: { "anthropic-beta": "zeta-beta,alpha-beta,x" },
    },
    { name: "altered", headers: { "anthropic-beta": "zeta-beta,alpha-betA" } },
    { name: "spaced", headers: { "anthropic-beta": "zeta-beta, alpha-beta" } },
  ])("refuses a beta header $name (T3)", async ({ headers }) => {
    const { sendGate, sent } = gate("anthropic-messages");

    await expect(
      sendGate.fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(wire),
      }),
    ).rejects.toThrow(MISMATCH);
    expect(sent).toHaveLength(0);
  });

  it("refuses another field change even when the betas move is exact (T2)", async () => {
    const { sendGate, sent } = gate("anthropic-messages");

    await expect(
      sendGate.fetch(url, {
        method: "POST",
        headers: { "anthropic-beta": "zeta-beta,alpha-beta" },
        body: JSON.stringify({ ...wire, max_tokens: 65 }),
      }),
    ).rejects.toThrow(MISMATCH);
    expect(sent).toHaveLength(0);
  });

  it("refuses betas left in the body on the Anthropic transport", async () => {
    const { sendGate, sent } = gate("anthropic-messages");

    await expect(
      sendGate.fetch(url, {
        method: "POST",
        headers: { "anthropic-beta": "zeta-beta,alpha-beta" },
        body: JSON.stringify(authorized),
      }),
    ).rejects.toThrow(MISMATCH);
    expect(sent).toHaveLength(0);
  });

  it.each(["openai-chat-completions", "openai-responses"] as const)(
    "refuses betas moved to the header on %s (T4)",
    async (transport) => {
      const { sendGate, sent } = gate(transport);

      await expect(
        sendGate.fetch(url, {
          method: "POST",
          headers: { "anthropic-beta": "zeta-beta,alpha-beta" },
          body: JSON.stringify(wire),
        }),
      ).rejects.toThrow(MISMATCH);
      expect(sent).toHaveLength(0);
    },
  );

  it("sends a non-Anthropic body byte-exactly without reading its headers", async () => {
    const { sendGate, sent } = gate("openai-chat-completions");
    await sendGate.fetch(url, {
      method: "POST",
      headers: { "anthropic-beta": "unrelated" },
      body: JSON.stringify(authorized),
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.init?.body).toBe(JSON.stringify(authorized));
  });

  it("refuses a second send of the same authorization", async () => {
    const { sendGate } = gate("anthropic-messages");
    const init = {
      method: "POST",
      headers: { "anthropic-beta": "zeta-beta,alpha-beta" },
      body: JSON.stringify(wire),
    };
    await sendGate.fetch(url, init);

    await expect(sendGate.fetch(url, init)).rejects.toBeInstanceOf(ProviderRequestPolicyError);
  });
});
