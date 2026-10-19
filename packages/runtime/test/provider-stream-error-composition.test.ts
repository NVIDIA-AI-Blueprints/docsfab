// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * An installed composition route checks the model identity of every 2xx body.
 * A 200 stream that carries only a structured provider error event, such as
 * the NVIDIA API Catalog's
 * `data: {"error":{"message":"Service temporarily overloaded","type":"service_unavailable","code":503}}`,
 * has no model output to check. It reaches the transport's stream-error
 * observer and is classified exactly as on a compatible route. A body that
 * carries model output under another model is reported to the run, never
 * refused, and a body that names no model is still refused. Every provider
 * here is a scripted `fetch`; no request leaves the host.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalDigest } from "../src/contract-kit/index.js";
import type { HarnessStepInput, InferenceRetryPolicy } from "../src/execution/contracts.js";
import { PiHarness } from "../src/harness/pi.js";
import { observeLandedProviderTurn } from "../src/model/attempt-telemetry.js";
import type { BoundModelExecutionProfile } from "../src/model/configuration.js";
import {
  createProviderConnectionFactory,
  type ModelConnection,
  type ProviderConnectionFactory,
  type ServedModelObservation,
} from "../src/model/provider.js";
import {
  DOCSFAB_SYSTEM_PROMPT,
  DOCSFAB_SYSTEM_PROMPT_SHA256,
} from "../src/model/request-policy.js";
import { formatRunFailureDiagnosticLines } from "../src/operator/run-summary.js";
import type {
  InferenceAttemptEvidence,
  InferenceFailureCategory,
  RunRecord,
} from "../src/records/contracts.js";
import { decodeInference } from "../src/scorecard-record-decode.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import { validModelConfig } from "./helpers.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillCrateDirectory = resolve(projectRoot, "skill-crate");
const temporaryDirectories: string[] = [];
const SLOW = testTimeoutMs(20_000);

const CATALOG_MODEL = "nvidia/llama-3.3-nemotron-super-49b-v1.5";
const CATALOG_COMPOSITION_POLICY = {
  maxProviderTurns: 4,
  timeoutMs: 300_000,
  maxResponseBytes: 65_536,
};

/** The body the NVIDIA API Catalog sent on a 200 response. */
const OVERLOADED_BODY =
  'data: {"error":{"message":"Service temporarily overloaded","type":"service_unavailable","code":503}}\n\ndata: [DONE]\n\n';
// Neutral type and message, so only the declared code can classify these.
const errorOnlyBody = (code: number): string =>
  `data: {"error":{"message":"x","type":"x","code":${code}}}\n\ndata: [DONE]\n\n`;

const retryableCategories: InferenceFailureCategory[] = [
  "blank-response",
  "malformed-response",
  "timeout",
  "throttled",
  "provider-transient",
];
const policy: InferenceRetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 0,
  maxDelayMs: 0,
  retryableCategories,
};

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("installed composition route: one request whose 200 body is only an error event", () => {
  it("keeps pending requests explicit and sorts terminal byte observations after out-of-order Pi completion", async () => {
    let resolveFirstFetch!: () => void;
    let resolveSecondFetch!: () => void;
    const firstFetched = new Promise<void>((resolve) => (resolveFirstFetch = resolve));
    const secondFetched = new Promise<void>((resolve) => (resolveSecondFetch = resolve));
    let call = 0;
    const sentBodies: Uint8Array[] = [];
    let firstBody!: ReadableStreamDefaultController<Uint8Array>;
    let secondBody!: ReadableStreamDefaultController<Uint8Array>;
    const factory = createProviderConnectionFactory({
      routeId: "nvidia-api-catalog",
      transport: "openai-chat-completions",
      fetch: async (_input, init) => {
        sentBodies.push(new TextEncoder().encode(String(init?.body)));
        call += 1;
        if (call === 1) resolveFirstFetch();
        else resolveSecondFetch();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            if (call === 1) firstBody = controller;
            else secondBody = controller;
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const connection = await factory.create(
      {
        profile: catalogProfile(),
        credential: { family: "nvidia-api-catalog", apiKey: CREDENTIAL },
      },
      { evidenceIdentity: { repositoryRevision: "a".repeat(40) } },
    );
    const request = (content: string) =>
      connection.runtime
        .streamSimple(
          connection.model,
          {
            systemPrompt: DOCSFAB_SYSTEM_PROMPT,
            messages: [{ role: "user" as const, content, timestamp: 1 }],
            tools: [],
          },
          { maxTokens: 64 },
        )
        .result();

    const firstResult = request("first request");
    await firstFetched;
    const secondResult = request("second request");
    await secondFetched;
    const measuredRequests = connection.providerRequests?.();
    expect(measuredRequests).toEqual(
      sentBodies.map((body, index) => ({
        requestSequence: index + 1,
        turn: expect.any(Number),
        bodyBytes: body.byteLength,
        bodySha256: createHash("sha256").update(body).digest("hex"),
      })),
    );
    expect(measuredRequests?.map((request) => request.turn)).toEqual([1, 2]);
    expect(connection.providerResponses?.()).toEqual({
      schemaVersion: 1,
      state: "pending",
      observations: [],
      pendingRequestSequences: [1, 2],
    });

    const secondBytes = new TextEncoder().encode(catalogTurnBody("second done"));
    secondBody.enqueue(secondBytes);
    secondBody.close();
    await secondResult;
    expect(connection.providerResponses?.()).toMatchObject({
      state: "pending",
      observations: [{ requestSequence: 2, disposition: "complete" }],
      pendingRequestSequences: [1],
    });

    const firstBytes = new TextEncoder().encode(catalogTurnBody("first done"));
    firstBody.enqueue(firstBytes);
    firstBody.close();
    await firstResult;
    expect(connection.providerResponses?.()).toMatchObject({
      state: "complete",
      observations: [
        { requestSequence: 1, disposition: "complete", observedBytes: firstBytes.byteLength },
        { requestSequence: 2, disposition: "complete", observedBytes: secondBytes.byteLength },
      ],
      pendingRequestSequences: [],
    });
  });

  it("is sent, observed, and classified by its declared status", async () => {
    const run = await oneRequest(() => [sseResponse(OVERLOADED_BODY)]);

    expect(run.calls).toBe(1);
    expect(run.exchange).toEqual({
      sent: true,
      bodyReceived: true,
      streamError: { status: 503, serverFault: true },
    });
    expect(run.observed).toEqual({
      finishReason: "error",
      providerError: { class: "server", streamErrorStatus: 503 },
    });
    expect(run.errorMessage).not.toMatch(/connection error|rejected/iu);
  });

  it.each([
    [504, "timeout"],
    [429, "rate-limit"],
  ] as const)("records a declared %i as %s", async (code, errorClass) => {
    const run = await oneRequest(() => [sseResponse(errorOnlyBody(code))]);

    expect(run.exchange).toMatchObject({
      sent: true,
      bodyReceived: true,
      streamError: { status: code },
    });
    expect(run.observed.providerError).toEqual({
      class: errorClass,
      streamErrorStatus: code,
    });
  });

  it("keeps a content-filter message a content filter", async () => {
    const body =
      'data: {"error":{"message":"Blocked by the content filter","type":"x","code":400}}\n\n';
    const run = await oneRequest(() => [sseResponse(body)]);

    expect(run.observed.providerError).toEqual({
      class: "content-filter",
      streamErrorStatus: 400,
    });
  });

  it("replays a declared 503 inside the turn and lands the replay", async () => {
    const run = await oneRequest(
      () => [sseResponse(OVERLOADED_BODY), catalogTurn("The review is complete.")],
      { inTurnAttempts: 2 },
    );

    expect(run.calls).toBe(2);
    expect(run.stopReason).toBe("stop");
    expect(run.exchange).toEqual({ sent: true, bodyReceived: true });
    expect(run.requests.map((request) => [request.requestSequence, request.turn])).toEqual([
      [1, 1],
      [2, 1],
    ]);
    expect(run.requests[0]?.bodySha256).toBe(run.requests[1]?.bodySha256);
  });

  it("admits an error event that also types itself as an error", async () => {
    const body =
      'data: {"type":"error","error":{"type":"service_unavailable","code":503}}\n\ndata: [DONE]\n\n';
    const run = await oneRequest(() => [sseResponse(body)]);

    expect(run.observed.providerError).toEqual({ class: "server", streamErrorStatus: 503 });
  });

  it("still classifies a declared 503 that follows model chunks", async () => {
    const run = await oneRequest(() => [
      sseResponse(`${modelChunk(CATALOG_MODEL)}${OVERLOADED_BODY}`),
    ]);

    expect(run.exchange).toEqual({
      sent: true,
      bodyReceived: true,
      streamError: { status: 503, serverFault: true },
    });
    expect(run.observed.providerError).toEqual({
      class: "server",
      streamErrorStatus: 503,
    });
  });

  it.each([
    ["model chunks from another model", modelChunk("substituted-model")],
    // The boundary inspects a line behind any number of byte order marks, more
    // than a consumer that drops one per line or none.
    [
      "model chunks from another model behind two byte order marks",
      `: c\n\n\uFEFF\uFEFF${modelChunk("substituted-model")}`,
    ],
  ])("reports %s before an error event, and classifies the error", async (_label, prefix) => {
    const run = await oneRequest(() => [sseResponse(`${prefix}${OVERLOADED_BODY}`)]);

    expect(run.calls).toBe(1);
    expect(run.observations).toEqual([
      { expectedModel: CATALOG_MODEL, servedModels: ["substituted-model"] },
    ]);
    expect(run.exchange).toMatchObject({
      sent: true,
      bodyReceived: true,
      streamError: { status: 503 },
    });
    expect(run.observed.providerError).toEqual({ class: "server", streamErrorStatus: 503 });
  });

  it.each([
    ["a content chunk with no model", modelChunk(undefined)],
    [
      "an error envelope that also carries model output",
      'data: {"error":{"code":503},"choices":[{"index":0,"delta":{"content":"x"}}]}\n\n',
    ],
    [
      "an error envelope typed as another event",
      'data: {"type":"content_block_delta","error":{"code":503}}\n\n',
    ],
  ])("refuses an error event mixed with %s", async (_label, prefix) => {
    const run = await oneRequest(() => [sseResponse(`${prefix}${OVERLOADED_BODY}`)]);

    expect(run.calls).toBe(1);
    expect(run.exchange).toEqual({ sent: false, bodyReceived: true });
    expect(run.observed.providerError).toBeUndefined();
  });

  it.each([
    ["a JSON error body that is not a stream", '{"error":{"code":503,"type":"x"}}'],
    ["a stream with no event but its terminator", "data: [DONE]\n\n"],
    ["a null error", 'data: {"error":null}\n\ndata: [DONE]\n\n'],
    ["a string error", 'data: {"error":"x"}\n\ndata: [DONE]\n\n'],
    ["an array error", 'data: {"error":[]}\n\ndata: [DONE]\n\n'],
    [
      "an error event that arrives only after the terminator",
      'data: [DONE]\n\ndata: {"error":{"code":503,"type":"x"}}\n\n',
    ],
  ])("still refuses %s", async (_label, body) => {
    const run = await oneRequest(() => [sseResponse(body)]);

    expect(run.exchange).toEqual({ sent: false, bodyReceived: true });
    expect(run.observed.providerError).toBeUndefined();
  });

  // The SSE consumer also ends a line at a bare CR, so these chunks reach Pi
  // even though a reader that splits only at LF sees one comment line.
  const hiddenTurn = (model: string): string =>
    [
      ": c",
      `data: ${JSON.stringify({ id: "hidden", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "SMUGGLED" }, finish_reason: null }] })}`,
      "",
      `data: ${JSON.stringify({ id: "hidden", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
      "",
      "data: [DONE]",
      "",
      "",
    ].join("\r");

  it.each([
    ["an error event", 'data: {"error":{"code":503,"type":"x"}}\n\n'],
    ["a chunk from the selected model", modelChunk(CATALOG_MODEL)],
  ])(
    "reports another model's turn hidden by bare-CR line ends before %s",
    async (_label, visible) => {
      const run = await oneRequest(() => [sseResponse(`${hiddenTurn("evil-model")}\n${visible}`)]);

      // The boundary still sees the hidden turn: it is reported, never missed.
      expect(run.calls).toBe(1);
      expect(run.observations).toEqual([
        { expectedModel: CATALOG_MODEL, servedModels: expect.arrayContaining(["evil-model"]) },
      ]);
      expect(run.exchange).toMatchObject({ sent: true, bodyReceived: true });
    },
  );

  // The SSE consumer decodes each line on its own, which drops one leading
  // byte order mark from every line, not only from the start of the body.
  const bomHiddenTurn = (model: string): string =>
    hiddenTurn(model)
      .split("\r")
      .map((line) => (line.startsWith("data:") ? `\uFEFF${line}` : line))
      .join("\n");

  it.each([
    ["an error event", 'data: {"error":{"code":503,"type":"x"}}\n\n'],
    ["a chunk from the selected model", modelChunk(CATALOG_MODEL)],
  ])(
    "reports another model's turn hidden by per-line byte order marks before %s",
    async (_label, visible) => {
      const run = await oneRequest(() => [
        sseResponse(`${bomHiddenTurn("evil-model")}\n${visible}`),
      ]);

      // The boundary still sees the hidden turn: it is reported, never missed.
      expect(run.calls).toBe(1);
      expect(run.observations).toEqual([
        { expectedModel: CATALOG_MODEL, servedModels: expect.arrayContaining(["evil-model"]) },
      ]);
      expect(run.exchange).toMatchObject({ sent: true, bodyReceived: true });
    },
  );

  it.each([
    [
      "on every line after a comment",
      `: c\n\n\uFEFFdata: {"error":{"code":503,"type":"x"}}\n\n\uFEFFdata: [DONE]\n\n`,
    ],
    [
      "at the start of the body",
      `\uFEFFdata: {"error":{"code":503,"type":"x"}}\n\ndata: [DONE]\n\n`,
    ],
  ])("classifies an error-only body with a byte order mark %s", async (_label, body) => {
    const run = await oneRequest(() => [sseResponse(body)]);

    expect(run.exchange).toEqual({
      sent: true,
      bodyReceived: true,
      streamError: { status: 503, serverFault: false },
    });
    expect(run.observed.providerError).toEqual({ class: "server", streamErrorStatus: 503 });
  });

  it("lands a bare-CR stream from the selected model", async () => {
    const run = await oneRequest(() => [sseResponse(hiddenTurn(CATALOG_MODEL))]);

    expect(run.exchange).toEqual({ sent: true, bodyReceived: true });
    expect(run.stopReason).toBe("stop");
    expect(run.content).toContain("SMUGGLED");
  });

  it("still refuses a credential inside an error-only body", async () => {
    const body = `data: {"error":{"message":"key ${CREDENTIAL}","type":"x","code":503}}\n\n`;
    const run = await oneRequest(() => [sseResponse(body)]);

    expect(run.exchange).toEqual({ sent: false, bodyReceived: true });
    expect(run.observed.providerError).toBeUndefined();
    expect(run.errorMessage).not.toContain(CREDENTIAL);
  });
});

describe("installed composition route: a step whose provider answers an error-only 200", () => {
  it(
    "preserves retryable classification for a response-byte overflow after Pi flattens the stream error",
    async () => {
      const repositoryPath = await createRepository();
      const connections: ModelConnection[] = [];
      const provider = vi.fn(
        async () =>
          new Response(new Uint8Array(CATALOG_COMPOSITION_POLICY.maxResponseBytes + 1), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      );
      vi.stubGlobal("fetch", provider);
      const execution = await runStep(stepInput(repositoryPath), policy, {
        inTurnAttempts: 1,
        onConnection: (connection) => connections.push(connection),
      });

      expect(
        provider.mock.calls.length,
        JSON.stringify({
          attempts: execution.evidence.attempts.map((attempt) => ({
            attempt: attempt.attempt,
            outcome: attempt.outcome,
            retryable: attempt.retryable,
            retryScheduled: attempt.retryScheduled,
          })),
          finalError:
            "error" in execution
              ? (() => {
                  const error = execution.error as Error & {
                    category?: unknown;
                    rejection?: { code?: unknown };
                    retryable?: unknown;
                  };
                  const causeNames: string[] = [];
                  let cause: unknown = error;
                  for (let depth = 0; depth < 4 && cause instanceof Error; depth += 1) {
                    cause = (cause as Error & { cause?: unknown }).cause;
                    if (cause instanceof Error) causeNames.push(cause.name);
                  }
                  return {
                    name: error.name,
                    category: error.category,
                    retryable: error.retryable,
                    rejectionCode: error.rejection?.code,
                    causeNames,
                  };
                })()
              : undefined,
          responseLimitCodes: connections.map(
            (connection) => connection.providerTransport?.lastResponseLimitRefusal?.()?.code,
          ),
        }),
      ).toBe(policy.maxRetries + 1);
      expect(execution.status).toBe("failed");
      expect(execution.evidence.attempts).toHaveLength(policy.maxRetries + 1);
      expect(
        execution.evidence.attempts
          .slice(0, -1)
          .every(
            (attempt) =>
              attempt.outcome === "provider-transient" &&
              attempt.retryable &&
              attempt.retryScheduled,
          ),
      ).toBe(true);
      expect(execution.evidence.attempts.at(-1)).toMatchObject({
        outcome: "provider-transient",
        retryable: true,
        retryScheduled: false,
      });
      expect(execution.evidence.attempts.every((attempt) => attempt.usage?.turns === 1)).toBe(true);
      expect(connections).toHaveLength(execution.evidence.attempts.length);
      expect(
        connections.map(
          (connection) => connection.providerTransport?.lastResponseLimitRefusal?.()?.code,
        ),
      ).toEqual(
        Array.from(
          { length: execution.evidence.attempts.length },
          () => "provider-response-too-large",
        ),
      );
      expect(
        execution.evidence.attempts.every(
          (attempt) => attempt.modelTelemetry?.finishReason === "error",
        ),
      ).toBe(true);
      expect(
        execution.evidence.attempts.every(
          (attempt) => attempt.modelTelemetry?.providerError === undefined,
        ),
      ).toBe(true);
      expect(execution.evidence.attempts.at(-1)?.modelTelemetry).toMatchObject({
        finishReason: "error",
      });
      expect(JSON.stringify(execution.evidence)).not.toContain("provider-response-too-large");
    },
    SLOW,
  );

  it(
    "retries a declared 503 at the step and records it truthfully",
    async () => {
      const repositoryPath = await createRepository();
      const connections: ModelConnection[] = [];
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          calls += 1;
          return calls === 1
            ? sseResponse(OVERLOADED_BODY)
            : catalogTurn("The review is complete.");
        }),
      );
      const execution = await runStep(stepInput(repositoryPath), policy, {
        inTurnAttempts: 1,
        onConnection: (connection) => connections.push(connection),
      });

      expect(calls).toBe(2);
      expect(execution.status).toBe("succeeded");
      const [overloaded, retried] = execution.evidence.attempts;
      expect(overloaded).toMatchObject({
        attempt: 1,
        outcome: "provider-transient",
        retryable: true,
        retryScheduled: true,
        modelTelemetry: {
          finishReason: "error",
          providerError: { class: "server", streamErrorStatus: 503 },
        },
      });
      expect(overloaded?.turns?.at(-1)?.providerReplayVeto).not.toBe("local-denial");
      expect(retried).toMatchObject({ attempt: 2, outcome: "succeeded" });
      expect(overloaded?.providerResponses?.observations).toEqual([
        {
          requestSequence: 1,
          disposition: "complete",
          observedBytes: Buffer.byteLength(OVERLOADED_BODY),
          httpStatus: 200,
        },
      ]);
      expect(retried?.providerResponses?.observations).toEqual([
        {
          requestSequence: 1,
          disposition: "complete",
          observedBytes: Buffer.byteLength(catalogTurnBody("The review is complete.")),
          httpStatus: 200,
        },
      ]);
      expect(connections.map((connection) => connection.providerResponses?.())).toEqual([
        overloaded?.providerResponses,
        retried?.providerResponses,
      ]);
      expect(JSON.stringify(execution.evidence)).not.toContain("overloaded");
      expect(() => decodeInference(structuredClone(execution.evidence))).not.toThrow();
    },
    SLOW,
  );

  it(
    "ends a provider that stays overloaded as a transient flake, not a connection error",
    async () => {
      const repositoryPath = await createRepository();
      const provider = vi.fn(async () => sseResponse(OVERLOADED_BODY));
      vi.stubGlobal("fetch", provider);
      const execution = await runStep(stepInput(repositoryPath), policy, {
        inTurnAttempts: 1,
      });

      expect(provider).toHaveBeenCalledTimes(policy.maxRetries + 1);
      expect(execution.status).toBe("failed");
      const last = execution.evidence.attempts.at(-1)!;
      expect(last).toMatchObject({
        outcome: "provider-transient",
        retryable: true,
      });
      const lines = formatRunFailureDiagnosticLines(failedRecord(last));
      expect(lines).toContain("Failure class: flake (layer inference, code provider-transient).");
      expect(lines.find((line) => line.startsWith("Model telemetry:"))).toMatch(
        /; provider error server \(in-stream status 503\)\.$/u,
      );
      expect(lines.join("\n")).not.toMatch(/connection error|local-denial/iu);
    },
    SLOW,
  );

  it(
    "does not retry a declared 429 with no transport status",
    async () => {
      const repositoryPath = await createRepository();
      const provider = vi.fn(async () => sseResponse(errorOnlyBody(429)));
      vi.stubGlobal("fetch", provider);
      const execution = await runStep(stepInput(repositoryPath), policy);

      expect(provider).toHaveBeenCalledTimes(1);
      expect(execution.status).toBe("failed");
      expect(execution.evidence.attempts).toHaveLength(1);
      expect(execution.evidence.attempts[0]).toMatchObject({
        outcome: "provider-terminal",
        retryable: false,
        retryScheduled: false,
        modelTelemetry: {
          providerError: { class: "rate-limit", streamErrorStatus: 429 },
        },
      });
    },
    SLOW,
  );
});

const CREDENTIAL = "nvapi-composition-stream-error-test-credential";

/** An installed NVIDIA API Catalog profile: the composition boundary checks identity and size. */
function catalogProfile(): BoundModelExecutionProfile {
  const body = {
    schemaVersion: 1 as const,
    modelId: CATALOG_MODEL,
    routeId: "nvidia-api-catalog" as const,
    deploymentIdentitySha256: "a".repeat(64),
    transport: "openai-chat-completions" as const,
    reasoningMode: "disabled" as const,
    reasoningControl: {
      kind: "system-directive" as const,
      directive: "/no_think" as const,
    },
    installedSystemInstructionSha256: DOCSFAB_SYSTEM_PROMPT_SHA256,
    temperature: 0 as const,
    topP: 1 as const,
  };
  return {
    routeId: "nvidia-api-catalog",
    providerId: "nvidia-api-catalog",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    modelId: body.modelId,
    transport: "openai-chat-completions",
    apiFormat: "chat_completions",
    profile: {
      ...validModelConfig.profile,
      compatibility: {
        ...validModelConfig.profile.compatibility,
        apiFormats: ["chat_completions"],
      },
    },
    requestPolicy: validModelConfig.requestPolicy,
    compositionRequestPolicy: { ...body, policySha256: canonicalDigest(body) },
    compositionPolicy: CATALOG_COMPOSITION_POLICY,
  };
}

/** A factory whose connections replay a failed turn with no backoff. */
function catalogFactory(
  options: {
    fetch?: typeof globalThis.fetch;
    inTurnAttempts?: number;
    onConnection?: (connection: ModelConnection) => void;
    onServedModel?: (observation: ServedModelObservation) => void;
  } = {},
): ProviderConnectionFactory {
  const factory = createProviderConnectionFactory({
    routeId: "nvidia-api-catalog",
    transport: "openai-chat-completions",
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.onServedModel ? { onServedModel: options.onServedModel } : {}),
  });
  return {
    routeId: factory.routeId,
    transport: factory.transport,
    create: async (input, turnOptions) => {
      const connection = await factory.create(input, {
        ...turnOptions,
        providerTurnRetry: {
          baseDelayMs: 0,
          maxDelayMs: 0,
          ...(options.inTurnAttempts === undefined
            ? {}
            : { maxAttempts: options.inTurnAttempts, maxBlankAttempts: 1 }),
        },
      } as never);
      options.onConnection?.(connection);
      return connection;
    },
  };
}

/** One governed turn on a fresh catalog connection, and what it observed. */
async function oneRequest(responses: () => Response[], options: { inTurnAttempts?: number } = {}) {
  const queue = responses();
  let calls = 0;
  const observations: ServedModelObservation[] = [];
  const factory = catalogFactory({
    onServedModel: (observation) => observations.push(observation),
    inTurnAttempts: options.inTurnAttempts ?? 1,
    fetch: async () => {
      calls += 1;
      const next = queue.shift();
      if (!next) throw new Error("The scripted provider has no response left.");
      return next;
    },
  });
  const connection = await factory.create(
    {
      profile: catalogProfile(),
      credential: { family: "nvidia-api-catalog", apiKey: CREDENTIAL },
    },
    { evidenceIdentity: { repositoryRevision: "a".repeat(40) } },
  );
  const result = (await connection.runtime
    .streamSimple(
      connection.model,
      {
        systemPrompt: DOCSFAB_SYSTEM_PROMPT,
        messages: [{ role: "user" as const, content: "Reply OK.", timestamp: 1 }],
        tools: [],
      },
      { maxTokens: 64 },
    )
    .result()) as { stopReason?: unknown; errorMessage?: unknown; content?: unknown };
  const exchange = connection.providerTransport!.lastExchange();
  return {
    calls,
    requests: connection.providerRequests?.() ?? [],
    observations,
    exchange,
    stopReason: result.stopReason,
    content: JSON.stringify(result.content ?? []),
    errorMessage: typeof result.errorMessage === "string" ? result.errorMessage : "",
    observed: observeLandedProviderTurn(result, exchange),
  };
}

async function runStep(
  input: HarnessStepInput,
  retryPolicy: InferenceRetryPolicy,
  options: {
    inTurnAttempts?: number;
    onConnection?: (connection: ModelConnection) => void;
  } = {},
) {
  const harness = new PiHarness({
    skillCrateDirectory,
    executionProfile: catalogProfile(),
    credential: { family: "nvidia-api-catalog", apiKey: CREDENTIAL },
    providerConnectionFactory: catalogFactory(options),
  });
  return executeInferenceStep({
    mode: "read-only",
    policy: retryPolicy,
    evidenceIdentity: input.evidenceIdentity,
    sleep: async () => undefined,
    execute: (attempt) =>
      harness.runStep({
        ...input,
        inferenceAttempt: attempt,
        retriesConsumed: attempt - 1,
      }),
  });
}

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function modelChunk(model: string | undefined): string {
  const chunk = {
    id: "catalog-partial",
    object: "chat.completion.chunk",
    created: 1,
    ...(model === undefined ? {} : { model }),
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "partial" },
        finish_reason: null,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function catalogTurn(value: string): Response {
  return sseResponse(catalogTurnBody(value));
}

function catalogTurnBody(value: string): string {
  const chunk = (delta: object, finish: string | null, extra: object = {}) => ({
    id: "catalog-turn",
    object: "chat.completion.chunk",
    created: 1,
    model: CATALOG_MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  });
  return [
    chunk({ role: "assistant", content: value }, null),
    chunk({}, "stop", {
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  ]
    .map((item) => `data: ${JSON.stringify(item)}\n\n`)
    .concat("data: [DONE]\n\n")
    .join("");
}

async function createRepository(): Promise<string> {
  const repositoryPath = await mkdtemp(resolve(tmpdir(), "docsfab-composition-stream-error-"));
  temporaryDirectories.push(repositoryPath);
  await writeFile(resolve(repositoryPath, "README.md"), "# Fixture\n");
  return repositoryPath;
}

function stepInput(repositoryPath: string): HarnessStepInput {
  const workflow = getWorkflow("review-documentation");
  return {
    runId: "composition-stream-error-run",
    repositoryPath,
    workflow,
    step: workflow.steps[0]!,
    evidenceIdentity: { repositoryRevision: "a".repeat(40) },
  };
}

function failedRecord(attempt: InferenceAttemptEvidence): RunRecord {
  return {
    schemaVersion: 2,
    id: "composition-telemetry-run",
    workflow: "review-documentation",
    repository: {
      sourcePath: "/fixture",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "failed",
    createdAt: "2026-09-30T12:00:00.000Z",
    models: [],
    skills: [],
    steps: [
      {
        id: "provisional-technical-verification",
        title: "Technical verification",
        skill: "verify-technical-accuracy",
        mode: "read-only",
        status: "failed",
        inference: {
          configuredMaxRetries: 2,
          effectiveMaxRetries: 2,
          baseDelayMs: 0,
          maxDelayMs: 0,
          retryableCategories,
          replay: "read-only",
          attempts: [attempt],
        },
      },
    ],
  } as unknown as RunRecord;
}
