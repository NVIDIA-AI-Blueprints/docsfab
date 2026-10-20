// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import {
  createModelConnection,
  createProviderBoundaryFetch,
  createProviderConnectionFactory,
} from "../src/model/provider.js";
import { classifyModelFailure } from "../src/model/context-budget.js";
import type { BoundModelExecutionProfile } from "../src/model/configuration.js";
import { CredentialBoundaryError } from "../src/security/credential-isolation.js";
import { validModelConfig } from "./helpers.js";

const baseUrl = "https://provider.example.test/v1";
const requestUrl = `${baseUrl}/chat/completions`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createProviderBoundaryFetch", () => {
  it.each([
    "https://foreign.example.test/v1/chat/completions",
    "http://provider.example.test/v1/chat/completions",
  ])("rejects an unapproved initial origin before I/O: %s", async (target) => {
    const delegate = vi.fn(async () => new Response(null, { status: 204 }));
    const boundaryFetch = createProviderBoundaryFetch(baseUrl, delegate as typeof globalThis.fetch);

    await expect(boundaryFetch(target)).rejects.toThrow(
      "Provider request rejected by the configured origin boundary.",
    );
    expect(delegate).not.toHaveBeenCalled();
  });

  it("rejects a configured plain-HTTP base that is not loopback before I/O", () => {
    const delegate = vi.fn(async () => new Response(null, { status: 204 }));

    expect(() =>
      createProviderBoundaryFetch(
        "http://provider.example.test/v1",
        delegate as typeof globalThis.fetch,
      ),
    ).toThrow("plain HTTP is allowed only to a loopback host (model-endpoint-insecure-transport)");
    expect(delegate).not.toHaveBeenCalled();
  });

  it("preserves request fields while forcing manual redirect handling", async () => {
    const controller = new AbortController();
    const response = new Response(null, { status: 204 });
    const delegate = vi.fn(async () => response);
    const boundaryFetch = createProviderBoundaryFetch(baseUrl, delegate as typeof globalThis.fetch);

    await expect(
      boundaryFetch(requestUrl, {
        method: "POST",
        body: "bounded body",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        redirect: "follow",
      }),
    ).resolves.toBe(response);
    expect(delegate).toHaveBeenCalledWith(
      requestUrl,
      expect.objectContaining({
        method: "POST",
        body: "bounded body",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        redirect: "manual",
      }),
    );
  });

  it("records raw physical response bytes and terminal dispositions without response content", async () => {
    const observations: unknown[] = [];
    const started: number[] = [];
    const responses = [new Response("abc", { status: 201 }), new Response(null, { status: 204 })];
    const boundaryFetch = createProviderBoundaryFetch(
      baseUrl,
      vi.fn(async () => responses.shift()!) as typeof globalThis.fetch,
      {
        onPhysicalRequestStart: (sequence) => started.push(sequence),
        onResponseObservation: (observation) => observations.push(observation),
        captureResponseDigest: true,
      },
    );

    const [first, second] = await Promise.all([
      boundaryFetch(requestUrl),
      boundaryFetch(requestUrl),
    ]);
    await second.arrayBuffer();
    await first.arrayBuffer();

    expect(started).toEqual([1, 2]);
    expect(observations).toEqual([
      { requestSequence: 2, disposition: "no-body", observedBytes: 0, httpStatus: 204 },
      {
        requestSequence: 1,
        disposition: "complete",
        observedBytes: 3,
        httpStatus: 201,
        bodySha256: createHash("sha256").update("abc").digest("hex"),
      },
    ]);
    expect(JSON.stringify(observations)).not.toContain("abc");
  });

  it("keeps cancellation and read failures partial and content-free", async () => {
    const observations: unknown[] = [];
    const bodies = [
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
        },
      }),
      new ReadableStream<Uint8Array>({
        pull() {
          throw new Error("provider body private detail");
        },
      }),
    ];
    const boundaryFetch = createProviderBoundaryFetch(
      baseUrl,
      vi.fn(async () => new Response(bodies.shift()!)) as typeof globalThis.fetch,
      { onResponseObservation: (observation) => observations.push(observation) },
    );

    const cancelledResponse = await boundaryFetch(requestUrl);
    const reader = cancelledResponse.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("partial");
    await reader.cancel();
    const failedResponse = await boundaryFetch(requestUrl);
    await expect(failedResponse.arrayBuffer()).rejects.toThrow("provider body private detail");

    expect(observations).toEqual([
      { requestSequence: 1, disposition: "cancelled", observedBytes: 7, httpStatus: 200 },
      { requestSequence: 2, disposition: "read-error", observedBytes: 0, httpStatus: 200 },
    ]);
    expect(JSON.stringify(observations)).not.toContain("private detail");
  });

  it("records a dispatched send failure as no-response", async () => {
    const observations: unknown[] = [];
    const boundaryFetch = createProviderBoundaryFetch(
      baseUrl,
      vi.fn(async () => {
        throw new Error("transport detail");
      }) as typeof globalThis.fetch,
      { onResponseObservation: (observation) => observations.push(observation) },
    );

    await expect(boundaryFetch(requestUrl)).rejects.toThrow("transport detail");
    expect(observations).toEqual([
      { requestSequence: 1, disposition: "no-response", observedBytes: 0 },
    ]);
  });

  it.each([301, 302, 303, 307, 308])(
    "rejects redirect status %i without following it",
    async (status) => {
      const delegate = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response("redirect body", {
            status,
            headers: { location: "https://foreign.example.test/private" },
          }),
      );
      const boundaryFetch = createProviderBoundaryFetch(
        baseUrl,
        delegate as typeof globalThis.fetch,
      );

      await expect(boundaryFetch(requestUrl)).rejects.toThrow(
        "Provider response rejected because redirects are not allowed.",
      );
      expect(delegate).toHaveBeenCalledTimes(1);
      expect(delegate.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    },
  );

  it("cancels a redirect response body and keeps cleanup failures content-free", async () => {
    const cancel = vi.fn(async () => {
      throw new Error("private response body cleanup detail");
    });
    const response = {
      status: 302,
      body: { cancel },
    } as unknown as Response;
    const boundaryFetch = createProviderBoundaryFetch(
      baseUrl,
      vi.fn(async () => response) as unknown as typeof globalThis.fetch,
    );

    let failure: unknown;
    try {
      await boundaryFetch(requestUrl);
    } catch (error) {
      failure = error;
    }
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(failure).toEqual(
      new Error("Provider response rejected because redirects are not allowed."),
    );
    expect(String(failure)).not.toContain("private response body cleanup detail");
  });

  it.each([400, 429, 500, 503])("passes through non-redirect HTTP status %i", async (status) => {
    const response = new Response(null, { status });
    const boundaryFetch = createProviderBoundaryFetch(
      baseUrl,
      vi.fn(async () => response) as unknown as typeof globalThis.fetch,
    );

    await expect(boundaryFetch(requestUrl)).resolves.toBe(response);
  });

  it("rejects an oversized declared response before exposing its body", async () => {
    const response = new Response("private-provider-response", {
      headers: { "content-length": "25" },
    });
    const boundaryFetch = createProviderBoundaryFetch(
      baseUrl,
      vi.fn(async () => response) as unknown as typeof globalThis.fetch,
      { maxResponseBytes: 8 },
    );

    let failure: unknown;
    try {
      await boundaryFetch(requestUrl);
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain("composition response byte limit");
    expect(String(failure)).not.toContain("private-provider-response");
  });

  it("counts streamed bytes and cancels the provider body at the boundary", async () => {
    const cancel = vi.fn();
    const providerBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("four"));
        controller.enqueue(new TextEncoder().encode("more"));
      },
      cancel,
    });
    const boundaryFetch = createProviderBoundaryFetch(
      baseUrl,
      vi.fn(async () => new Response(providerBody)) as unknown as typeof globalThis.fetch,
      { maxResponseBytes: 7 },
    );

    const bounded = await boundaryFetch(requestUrl);
    await expect(bounded.text()).rejects.toThrow("composition response byte limit");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["malformed", "not-a-length", "malformed"],
    ["oversized", "25", "oversized"],
  ] as const)(
    "preserves %s Content-Length refusal on a null-body response",
    async (_kind, length, error) => {
      const boundaryFetch = createProviderBoundaryFetch(
        baseUrl,
        vi.fn(
          async () => new Response(null, { status: 204, headers: { "content-length": length } }),
        ) as typeof globalThis.fetch,
        { maxResponseBytes: 8 },
      );
      await expect(boundaryFetch(requestUrl)).rejects.toThrow(
        error === "malformed"
          ? "Content-Length header was malformed"
          : "composition response byte limit",
      );
    },
  );

  it("rejects an uninstalled same-origin provider path before delegation", async () => {
    const delegate = vi.fn(async () => new Response("ok"));
    const boundaryFetch = createProviderBoundaryFetch(baseUrl, delegate, {
      maxResponseBytes: 1_024,
      allowedRequestPath: "/v1/responses",
    });

    await expect(boundaryFetch(`${new URL(baseUrl).origin}/uninstalled-route`)).rejects.toThrow(
      "configured origin boundary",
    );
    await expect(boundaryFetch(`${new URL(baseUrl).origin}/v1/responses`)).resolves.toBeInstanceOf(
      Response,
    );
    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it("permits only Anthropic's exact beta query on the pinned Messages path", async () => {
    const delegate = vi.fn(async () => new Response("ok"));
    const boundaryFetch = createProviderBoundaryFetch(baseUrl, delegate, {
      maxResponseBytes: 1_024,
      allowedRequestPath: "/v1/messages",
      allowAnthropicBetaQuery: true,
      transport: "anthropic-messages",
    });

    await expect(
      boundaryFetch(`${new URL(baseUrl).origin}/v1/messages?beta=true`),
    ).resolves.toBeInstanceOf(Response);
    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["duplicate beta parameter", "?beta=true&beta=true"],
    ["additional parameter", "?beta=true&extra=1"],
    ["encoded value", "?beta=%74rue"],
    ["encoded parameter", "?%62eta=true"],
    ["case variation", "?beta=True"],
    ["empty query", "?"],
    ["fragment", "?beta=true#fragment"],
    ["empty fragment", "?beta=true#"],
  ])("rejects %s beta query before delegation", async (_label, query) => {
    const delegate = vi.fn(async () => new Response("ok"));
    const boundaryFetch = createProviderBoundaryFetch(baseUrl, delegate, {
      allowedRequestPath: "/v1/messages",
      allowAnthropicBetaQuery: true,
      transport: "anthropic-messages",
    });

    await expect(boundaryFetch(`${new URL(baseUrl).origin}/v1/messages${query}`)).rejects.toThrow(
      "configured origin boundary",
    );
    expect(delegate).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong transport", "/v1/messages?beta=true", "openai-responses"],
    ["wrong path", "/v1/responses?beta=true", "anthropic-messages"],
  ] as const)("rejects %s route before delegation", async (_label, path, transport) => {
    const delegate = vi.fn(async () => new Response("ok"));
    const boundaryFetch = createProviderBoundaryFetch(baseUrl, delegate, {
      allowedRequestPath: "/v1/messages",
      allowAnthropicBetaQuery: true,
      transport,
    });

    await expect(boundaryFetch(`${new URL(baseUrl).origin}${path}`)).rejects.toThrow(
      "configured origin boundary",
    );
    expect(delegate).not.toHaveBeenCalled();
  });

  it("rejects credentials in the URL even when origin and path match", async () => {
    const delegate = vi.fn(async () => new Response("ok"));
    const boundaryFetch = createProviderBoundaryFetch(baseUrl, delegate, {
      allowedRequestPath: "/v1/messages",
      allowAnthropicBetaQuery: true,
      transport: "anthropic-messages",
    });

    await expect(
      boundaryFetch("https://user:password@provider.example.test/v1/messages?beta=true"),
    ).rejects.toThrow("configured origin boundary");
    expect(delegate).not.toHaveBeenCalled();
  });

  it("does not permit the beta query without explicit Anthropic boundary options", async () => {
    const delegate = vi.fn(async () => new Response("ok"));
    const boundaryFetch = createProviderBoundaryFetch(baseUrl, delegate, {
      allowedRequestPath: "/v1/messages",
      transport: "anthropic-messages",
    });

    await expect(boundaryFetch(`${new URL(baseUrl).origin}/v1/messages?beta=true`)).rejects.toThrow(
      "configured origin boundary",
    );
    expect(delegate).not.toHaveBeenCalled();
  });

  it("records provider-observed model drift and passes the response on", async () => {
    const body = [
      `data: ${JSON.stringify({ model: "substituted-model", choices: [] })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const observed: unknown[] = [];
    const boundaryFetch = createProviderBoundaryFetch(
      baseUrl,
      vi.fn(
        async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
      ) as unknown as typeof globalThis.fetch,
      {
        maxResponseBytes: 4_096,
        allowedRequestPath: "/v1/responses",
        expectedModel: "gpt-5.6-sol",
        transport: "openai-responses",
        onServedModel: (observation) => observed.push(observation),
      },
    );

    const response = await boundaryFetch(`${new URL(baseUrl).origin}/v1/responses`);
    expect(await response.text()).toBe(body);
    expect(observed).toEqual([
      { expectedModel: "gpt-5.6-sol", servedModels: ["substituted-model"] },
    ]);
  });

  it("reports nothing when the response names the requested model", async () => {
    const body = [
      `data: ${JSON.stringify({ model: "gpt-5.6-sol", choices: [] })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const observed: unknown[] = [];
    const boundaryFetch = createProviderBoundaryFetch(
      baseUrl,
      vi.fn(
        async () =>
          new Response(body, {
            headers: { "content-type": "text/event-stream" },
          }),
      ) as unknown as typeof globalThis.fetch,
      {
        maxResponseBytes: 4_096,
        allowedRequestPath: "/v1/responses",
        expectedModel: "gpt-5.6-sol",
        transport: "openai-responses",
        onServedModel: (observation) => observed.push(observation),
      },
    );

    await boundaryFetch(`${new URL(baseUrl).origin}/v1/responses`);
    expect(observed).toEqual([]);
  });

  it("rejects an exact selected credential echo even without a known token shape", async () => {
    const credential = "opaque-selected-credential-value-for-this-test";
    const body = [
      `data: ${JSON.stringify({
        model: "gpt-5.6-sol",
        choices: [{ delta: { content: credential } }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const boundaryFetch = createProviderBoundaryFetch(
      baseUrl,
      vi.fn(
        async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
      ) as unknown as typeof globalThis.fetch,
      {
        maxResponseBytes: 4_096,
        allowedRequestPath: "/v1/responses",
        expectedModel: "gpt-5.6-sol",
        transport: "openai-responses",
        forbiddenCredential: credential,
      },
    );

    let failure: unknown;
    try {
      await boundaryFetch(`${new URL(baseUrl).origin}/v1/responses`);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CredentialBoundaryError);
    expect(String(failure)).not.toContain(credential);
  });

  it("preserves a bounded non-success response that has no observed model", async () => {
    const boundaryFetch = createProviderBoundaryFetch(
      baseUrl,
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
            headers: { "content-type": "application/json" },
          }),
      ) as unknown as typeof globalThis.fetch,
      {
        maxResponseBytes: 4_096,
        allowedRequestPath: "/v1/responses",
        expectedModel: "gpt-5.6-sol",
        transport: "openai-responses",
        forbiddenCredential: "opaque-selected-credential-value-for-this-test",
      },
    );

    const response = await boundaryFetch(`${new URL(baseUrl).origin}/v1/responses`);

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: { message: "rate limited" } });
  });
});

describe("response-limit observation request identity", () => {
  it("does not let a delayed old stream poison a rejected next request", async () => {
    let latestRequestSequence = 0;
    let responseLimit: Error | undefined;
    let oldBodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const delegate = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              oldBodyController = controller;
              controller.enqueue(new Uint8Array(4));
            },
          }),
        ),
    );
    const boundaryFetch = createProviderBoundaryFetch(
      baseUrl,
      delegate as typeof globalThis.fetch,
      {
        maxResponseBytes: 7,
        onRequestStart: (sequence) => {
          latestRequestSequence = sequence;
          responseLimit = undefined;
        },
        onResponseLimit: (error, sequence) => {
          if (sequence === latestRequestSequence) responseLimit = error;
        },
      },
    );

    const oldResponse = await boundaryFetch(requestUrl);
    const oldBodyRead = oldResponse.text();
    await expect(boundaryFetch("https://foreign.example.test/v1/chat/completions")).rejects.toThrow(
      "configured origin boundary",
    );
    oldBodyController?.enqueue(new Uint8Array(4));
    await expect(oldBodyRead).rejects.toThrow("composition response byte limit");
    expect(responseLimit).toBeUndefined();
  });
});

describe("createModelConnection provider boundary", () => {
  it.each([false, true])("cannot be bypassed through %s stream options", async (governed) => {
    const providerFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, {
          status: 302,
          headers: { location: "https://foreign.example.test/private" },
        }),
    );
    const bypassFetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", providerFetch);
    const connection = await createModelConnection(
      validModelConfig,
      governed ? { evidenceIdentity: { repositoryRevision: "a".repeat(40) } } : undefined,
    );

    const result = await connection.runtime.completeSimple(
      connection.model,
      {
        systemPrompt: "Provider boundary integration test.",
        messages: [{ role: "user", content: "Reply once.", timestamp: 1 }],
      },
      {
        fetch: bypassFetch as typeof globalThis.fetch,
        maxRetries: 0,
      },
    );

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Connection error.");
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(providerFetch.mock.calls[0]?.[1]).toMatchObject({
      redirect: "manual",
    });
    expect(bypassFetch).not.toHaveBeenCalled();
  });
});

describe("provider response-limit capture across Pi's SDK stream", () => {
  const maxResponseBytes = 2_048;
  const responseProfile: BoundModelExecutionProfile = {
    routeId: "provider-response-limit-test",
    providerId: "response-limit-provider",
    baseUrl,
    modelId: "example/model",
    transport: "openai-chat-completions",
    apiFormat: "chat_completions",
    profile: validModelConfig.profile,
    requestPolicy: validModelConfig.requestPolicy,
    compositionPolicy: { maxProviderTurns: 4, timeoutMs: 300_000, maxResponseBytes },
  };

  const connectionWith = async (
    fetch: typeof globalThis.fetch,
    turnOptions?: Parameters<ReturnType<typeof createProviderConnectionFactory>["create"]>[1],
  ) =>
    createProviderConnectionFactory({
      routeId: responseProfile.routeId,
      transport: responseProfile.transport,
      fetch,
    }).create(
      {
        profile: responseProfile,
        credential: { family: "openai-compatible-api", apiKey: "synthetic-response-limit-key" },
      },
      turnOptions,
    );

  const complete = (connection: Awaited<ReturnType<typeof connectionWith>>) =>
    connection.runtime.completeSimple(
      connection.model,
      {
        systemPrompt: "Provider response-limit regression.",
        messages: [{ role: "user", content: "Reply once.", timestamp: 1 }],
      },
      { maxRetries: 0 },
    );

  const validStream = () => {
    const model = responseProfile.modelId;
    const chunks = [
      `data: ${JSON.stringify({ id: "response-limit", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "response-limit", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    return new Response(chunks, { headers: { "content-type": "text/event-stream" } });
  };

  it.each(["content-length header", "streamed body"])(
    "retains typed byte overflow from the %s after Pi flattens the stream error",
    async (kind) => {
      const overflow = new Uint8Array(maxResponseBytes + 1).fill(120);
      const fetch = vi.fn(async () =>
        kind === "content-length header"
          ? new Response(overflow, { headers: { "content-length": String(overflow.byteLength) } })
          : new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(overflow);
                  controller.close();
                },
              }),
            ),
      );
      const connection = await connectionWith(fetch as typeof globalThis.fetch);
      const result = await complete(connection);

      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toBe("Connection error.");
      expect(connection.providerTransport?.lastResponseLimitRefusal?.()).toMatchObject({
        code: "provider-response-too-large",
        maxResponseBytes,
      });
      expect(connection.providerTransport?.lastExchange()).toMatchObject({ sent: true });
    },
  );

  it("keeps a genuine connection failure transient", async () => {
    const connectionErrors = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const failedConnection = await connectionWith(connectionErrors as typeof globalThis.fetch, {
      evidenceIdentity: { repositoryRevision: "a".repeat(40) },
      providerTurnRetry: { maxAttempts: 1, maxBlankAttempts: 1 },
    });
    const failed = await complete(failedConnection);
    expect(failed.stopReason).toBe("error");
    expect(failedConnection.providerTransport?.lastResponseLimitRefusal?.()).toBeUndefined();
    expect(classifyModelFailure(failed.errorMessage ?? "").retryable).toBe(true);
  });

  it("clears a prior response limit on the next request", async () => {
    let requests = 0;
    const resetFetch = vi.fn(async () => {
      requests += 1;
      if (requests === 1) {
        const overflow = new Uint8Array(maxResponseBytes + 1).fill(120);
        return new Response(overflow, {
          headers: { "content-length": String(overflow.byteLength) },
        });
      }
      return validStream();
    });
    const resetConnection = await connectionWith(resetFetch as typeof globalThis.fetch);
    const first = await complete(resetConnection);
    expect(first.stopReason).toBe("error");
    expect(resetConnection.providerTransport?.lastResponseLimitRefusal?.()).toMatchObject({
      code: "provider-response-too-large",
    });
    const second = await complete(resetConnection);
    expect(
      second.stopReason,
      JSON.stringify({
        requests,
        secondError: second.errorMessage,
        responseLimit: resetConnection.providerTransport?.lastResponseLimitRefusal?.()?.code,
      }),
    ).toBe("stop");
    expect(resetConnection.providerTransport?.lastResponseLimitRefusal?.()).toBeUndefined();
  });

  it.each([
    [
      "provider-stream-error",
      'data: {"error":{"message":"synthetic failure","type":"server_error"}}\n\n',
    ],
    [
      "stream-incomplete",
      'data: {"id":"old","object":"chat.completion.chunk","model":"example/model","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    ],
  ])("keeps a delayed %s on its physical response after another request", async (kind, body) => {
    let oldController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let signalFirst!: () => void;
    const firstSent = new Promise<void>((resolve) => {
      signalFirst = resolve;
    });
    let sends = 0;
    const fetch = vi.fn(async () => {
      sends += 1;
      if (sends === 1)
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              oldController = controller;
              signalFirst();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      return validStream();
    });
    const streamError = vi.fn();
    const connection = await connectionWith(fetch as typeof globalThis.fetch, {
      evidenceIdentity: { repositoryRevision: "a".repeat(40) },
      aggregatePolicy: { kind: "absent" },
      aggregatePhysicalRequestLimit: { kind: "absent" },
      taskActivityObserver: {
        failed: vi.fn(),
        started: vi.fn(),
        settled: vi.fn(),
        streamError,
      },
    });
    const first = complete(connection);
    await firstSent;
    expect((await complete(connection)).stopReason).toBe("stop");
    oldController?.enqueue(new TextEncoder().encode(body));
    oldController?.close();
    await first;
    expect(streamError).toHaveBeenCalledWith(1, kind);
    expect(streamError).not.toHaveBeenCalledWith(2, kind);
  });
});
