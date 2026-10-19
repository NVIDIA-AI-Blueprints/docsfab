// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The answer-submission qualification probe (#1707, `docsfab doctor --live
 * --answer-submission`) over offline SSE fixtures: every gate outcome, the
 * bound request shape, and the retained observation whose digest is the
 * recorded `evidenceSha256`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import { limit } from "../src/config/limits.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import {
  answerSubmissionProbeExitCode,
  answerSubmissionProbeResult,
  answerSubmissionProbeTarget,
  formatAnswerSubmissionProbe,
  probeConfiguredAnswerSubmission,
  resolveDoctorModelProfile,
} from "../src/doctor.js";
import { resolveOperatorExecutionBinding } from "../src/model/operator-execution-binding.js";
import { ProviderResponseLimitError } from "../src/model/provider.js";
import { parseDoctorArguments } from "../src/cli/profile-arguments.js";
import { QUALITY_SUBMISSION_TOOL_NAME } from "../src/harness/answer-submission.js";
import { DOCSFAB_SYSTEM_PROMPT } from "../src/model/request-policy.js";
import {
  ANSWER_SUBMISSION_PROBE_SEED,
  answerSubmissionProbeObject,
  probeAnswerSubmission,
  type AnswerSubmissionProbeVariant,
  type AnswerSubmissionProbeVerdict,
} from "../src/profile/answer-submission-probe.js";
import { parseChatCompletionStream, streamChatCompletion } from "../src/profile/probe-core.js";
import { validModelConfig } from "./helpers.js";
import { sseResponse } from "./support/pi-harness-session-fixtures.js";
import { releasedProbeProvider } from "./helpers/released-probe-provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Shell = "untyped" | "typed";

interface ProbeRequest {
  readonly variant: AnswerSubmissionProbeVariant;
  readonly shell: Shell;
  readonly evaluation: string;
  readonly body: Record<string, unknown>;
}

/** The variant and shell a probe request belongs to, read from its body. */
function classify(body: Record<string, unknown>): ProbeRequest {
  const messages = body.messages as Array<{ role: string; content: unknown }>;
  const prompt = String(messages.find((message) => message.role === "user")?.content ?? "");
  const evaluation = prompt.split("\n").slice(2).join("\n");
  const tool = (body.tools as Array<{ function: { parameters: Record<string, any> } }>)[0]!;
  const shell = tool.function.parameters.properties.evaluation.type ? "typed" : "untyped";
  const probe = /"probe":"(V[1-6])"/u.exec(evaluation)?.[1] as AnswerSubmissionProbeVariant;
  return { variant: probe === "V1" && shell === "typed" ? "V2" : probe, shell, evaluation, body };
}

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: "probe",
  object: "chat.completion.chunk",
  created: 1,
  model: "probe-model",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

function callReply(raw: string, finish = "tool_calls"): Response {
  return sseResponse([
    chunk({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "call-1",
          type: "function",
          function: { name: QUALITY_SUBMISSION_TOOL_NAME, arguments: raw },
        },
      ],
    }),
    { ...chunk({}, finish), usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ]);
}

function textReply(text: string): Response {
  return sseResponse([
    chunk({ role: "assistant", content: text }),
    { ...chunk({}, "stop"), usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ]);
}

/** A faithful route: every call echoes the requested value as strict JSON. */
function faithful(request: ProbeRequest): Response {
  return callReply(`{"evaluation":${request.evaluation},"qualityScore":null}`);
}

/** The requested value with its line breaks written raw, as a lenient parser might. */
function rawLineBreaks(request: ProbeRequest): Response {
  const parsed = JSON.parse(request.evaluation) as unknown;
  const loose = JSON.stringify(parsed).replaceAll("\\n", "\n");
  return callReply(`{"evaluation":${loose},"qualityScore":null}`);
}

/** Every member sent as a JSON string, as build.nvidia.com's untyped shell does (`null` too). */
function stringified(request: ProbeRequest): Response {
  return callReply(JSON.stringify({ evaluation: request.evaluation, qualityScore: "null" }));
}

/** The member encoded twice: a string whose one decode is still a string. */
function doubleEncoded(request: ProbeRequest): Response {
  return callReply(
    JSON.stringify({ evaluation: JSON.stringify(request.evaluation), qualityScore: null }),
  );
}

type Answer = (
  request: ProbeRequest,
  init: RequestInit | undefined,
  nth: number,
) => Response | Promise<Response>;

function route(answer: Answer): {
  fetch: typeof fetch;
  requests: ProbeRequest[];
} {
  const requests: ProbeRequest[] = [];
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    const request = classify(JSON.parse(String(init?.body)) as Record<string, unknown>);
    requests.push(request);
    // The request's ordinal within its variant and shell, from 0.
    const nth =
      requests.filter((sent) => sent.variant === request.variant && sent.shell === request.shell)
        .length - 1;
    return answer(request, init, nth);
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

async function probe(
  answer: Answer,
  options: {
    readonly transportRetries?: number;
    readonly largeVariantTimeoutMs?: number;
    readonly typedContingency?: boolean;
  } = {},
) {
  const replay = route(answer);
  const verdict = await probeAnswerSubmission({
    modelId: "probe-model",
    provider: releasedProbeProvider("https://probe.example.test/v1", "probe-key"),
    maxOutputTokens: 16_384,
    samplesPerVariant: 3,
    systemPrompt: DOCSFAB_SYSTEM_PROMPT,
    shape: { tokenField: "max_tokens", systemRole: "system", store: false },
    fetch: replay.fetch,
    timeoutMs: 5_000,
    largeVariantTimeoutMs: options.largeVariantTimeoutMs ?? 300_000,
    transportRetries: options.transportRetries ?? 2,
    typedContingency: options.typedContingency ?? false,
    errorBodyMaxChars: 400,
    credentialEchoMinChars: 6,
  });
  return { verdict, requests: replay.requests };
}

/** The probe with the typed-shell contingency opted into. */
function probeTyped(answer: Answer, options: Parameters<typeof probe>[1] = {}) {
  return probe(answer, { ...options, typedContingency: true });
}

function go(verdict: AnswerSubmissionProbeVerdict) {
  if (verdict.decision !== "go") throw new Error(`expected GO, got ${JSON.stringify(verdict)}`);
  return verdict;
}

function noGo(verdict: AnswerSubmissionProbeVerdict) {
  if (verdict.decision !== "no-go") throw new Error(`expected NO-GO, got ${verdict.decision}`);
  return verdict;
}

function inconclusive(verdict: AnswerSubmissionProbeVerdict) {
  if (verdict.decision !== "inconclusive") {
    throw new Error(`expected inconclusive, got ${verdict.decision}`);
  }
  return verdict;
}

const counts = (requests: readonly ProbeRequest[]) =>
  requests.map((request) => `${request.variant}:${request.shell}`);

describe("the answer-submission probe gate", () => {
  it("is GO with the untyped shell on a faithful route, and retains a content-free observation", async () => {
    const { verdict, requests } = await probe((request) =>
      request.variant === "V3"
        ? callReply(`{"evaluation":${request.evaluation},"qualityScore":null}`)
        : faithful(request),
    );

    const result = go(verdict);
    expect(result.capability).toEqual({
      kind: "host-tool-call",
      argumentShell: "untyped",
      duplicateKeys: "forwarded",
      reportTurnToolChoice: "auto",
      objectMembers: "object",
      evidenceSha256: result.evidenceSha256,
    });
    // V1, V3, V4, and V6 three times each: V2 is skipped when V1 is usable, and there is no V5.
    expect(counts(requests)).toEqual([
      ...Array(3).fill("V1:untyped"),
      ...Array(3).fill("V3:untyped"),
      ...Array(3).fill("V4:untyped"),
      ...Array(3).fill("V6:untyped"),
    ]);
    expect(result.evidenceSha256).toBe(canonicalDigest(result.observation));
    expect(result.observation.schemaVersion).toBe(2);
    expect(result.observation.samples).toHaveLength(12);
    expect(JSON.stringify(result.observation)).not.toContain('"probe":"V1"');
    const v6 = result.observation.samples.filter((sample) => sample.variant === "V6");
    expect(v6.every((sample) => sample.deepEqual === true && sample.rawBytes > 20 * 1024)).toBe(
      true,
    );
  });

  it("records unobserved duplicate keys when no V3 sample forwards the duplicate", async () => {
    const { verdict } = await probe((request) =>
      request.variant === "V3"
        ? callReply('{"evaluation":{"probe":"V3","key":"second"},"qualityScore":null}')
        : faithful(request),
    );
    const result = go(verdict);
    expect(result.capability.duplicateKeys).toBe("unobserved");
    expect(result.notes.join(" ")).toContain("Duplicate-key detection is unverified");
  });

  it("never sends V2 when V1 is usable", async () => {
    const { verdict, requests } = await probe(faithful);
    expect(go(verdict).capability.argumentShell).toBe("untyped");
    expect(requests.some((request) => request.variant === "V2")).toBe(false);
  });

  it("chooses untyped and records stringified members when every untyped member arrives as a JSON string", async () => {
    const { verdict, requests } = await probe(stringified);
    const result = go(verdict);
    expect(result.capability).toMatchObject({
      argumentShell: "untyped",
      objectMembers: "stringified",
      duplicateKeys: "forwarded",
    });
    expect(requests).toHaveLength(12);
    for (const sample of result.observation.samples) {
      expect(sample.memberEncoding).toEqual({ evaluation: "string", qualityScore: "string" });
    }
  });

  it("falls back to the typed shell when untyped members arrive double-encoded", async () => {
    const { verdict, requests } = await probeTyped((request) =>
      request.shell === "untyped" ? doubleEncoded(request) : faithful(request),
    );
    const result = go(verdict);
    expect(result.capability.argumentShell).toBe("typed");
    expect(counts(requests)).toEqual([
      ...Array(3).fill("V1:untyped"),
      ...Array(3).fill("V2:typed"),
      ...Array(3).fill("V3:typed"),
      ...Array(3).fill("V4:typed"),
      ...Array(3).fill("V6:typed"),
    ]);
  });

  it("re-sends V2, V3, V4, and V6 typed when untyped V4 fails, and is GO typed when they pass", async () => {
    const { verdict, requests } = await probeTyped((request) =>
      request.variant === "V4" && request.shell === "untyped"
        ? rawLineBreaks(request)
        : faithful(request),
    );
    const result = go(verdict);
    expect(result.capability.argumentShell).toBe("typed");
    expect(requests).toHaveLength(24);
    expect(
      result.observation.samples
        .filter((sample) => sample.round === "contingency")
        .map((sample) => sample.variant),
    ).toEqual(["V2", "V2", "V2", "V3", "V3", "V3", "V4", "V4", "V4", "V6", "V6", "V6"]);
  });

  it("is NO-GO when V6 stays non-strict under both shells", async () => {
    const { verdict } = await probeTyped((request) =>
      request.variant === "V6" ? rawLineBreaks(request) : faithful(request),
    );
    expect(noGo(verdict).cause).toBe("arguments-not-strict");
  });

  it("is NO-GO when V4 stays non-strict and the typed shell is not usable", async () => {
    const { verdict } = await probeTyped((request) =>
      request.variant === "V2"
        ? doubleEncoded(request)
        : request.variant === "V4"
          ? rawLineBreaks(request)
          : faithful(request),
    );
    expect(noGo(verdict).cause).toBe("arguments-not-strict");
  });

  it("is NO-GO when neither shell is usable", async () => {
    const { verdict, requests } = await probeTyped(doubleEncoded);
    const result = noGo(verdict);
    expect(result.cause).toBe("no-usable-shell");
    expect(result.stopClass).toBe("provider-compatibility");
    expect(result.nextAction).toContain("Keep the route on the text answer");
    expect(result.nextAction).not.toMatch(/#\d/u);
    expect(requests).toHaveLength(6);
  });

  // Strict JSON with an object `evaluation` is not enough: each sample is decided
  // by the production decoder, so a route whose bytes production refuses is never GO.
  it.each([
    {
      route: "drops qualityScore",
      arguments: (evaluation: string) => `{"evaluation":${evaluation}}`,
      location: "$",
    },
    {
      route: "adds a member",
      arguments: (evaluation: string) =>
        `{"evaluation":${evaluation},"qualityScore":null,"note":"extra"}`,
      location: "$",
    },
    {
      route: "coerces qualityScore to false",
      arguments: (evaluation: string) => `{"evaluation":${evaluation},"qualityScore":false}`,
      location: "$.qualityScore",
    },
  ])("is NO-GO when the route $route, as the production decoder refuses it", async (shape) => {
    const { verdict } = await probeTyped((request) =>
      callReply(shape.arguments(request.evaluation)),
    );
    const result = noGo(verdict);
    expect(result.cause).toBe("no-usable-shell");
    const decided = result.observation.samples;
    expect(decided.length).toBeGreaterThan(0);
    for (const sample of decided) {
      expect(sample).toMatchObject({
        parse: "ok",
        memberType: "object",
        decode: "quality-submission-shape",
        decodeLocation: shape.location,
      });
    }
  });

  it("records the production decoder's verdict on every admitted sample", async () => {
    const { verdict } = await probe(faithful);
    for (const sample of go(verdict).observation.samples) {
      if (sample.variant === "V3") expect(sample.decode).toBe("quality-submission-duplicate-key");
      else expect(sample).toMatchObject({ decode: "admitted", decodeLocation: null });
    }
  });

  it("is NO-GO when the route refuses the tools request", async () => {
    const { verdict, requests } = await probe(
      () =>
        new Response(JSON.stringify({ error: { message: "tools unsupported" } }), { status: 400 }),
    );
    expect(noGo(verdict).cause).toBe("provider-request-refused");
    expect(requests).toHaveLength(1);
  });

  it("is NO-GO when a required call never carries a tool call", async () => {
    const { verdict } = await probe(() => textReply("I would rather answer in text."));
    expect(noGo(verdict).cause).toBe("tool-call-not-returned");
  });

  it("is NO-GO when V6 is cut at the bound output limit", async () => {
    const { verdict } = await probe((request) =>
      request.variant === "V6"
        ? callReply('{"evaluation":{"probe":"V6","fin', "length")
        : faithful(request),
    );
    const result = noGo(verdict);
    expect(result.cause).toBe("output-allowance-reached");
    expect(result.nextAction).toContain("docsfab doctor --live --answer-submission again");
    expect(result.nextAction).not.toMatch(/#\d/u);
  });

  it("records report-turn tool_choice auto without sending a report-turn request", async () => {
    const { verdict, requests } = await probe(faithful);
    expect(go(verdict).capability.reportTurnToolChoice).toBe("auto");
    expect(requests.every((request) => request.body.tool_choice === "required")).toBe(true);
  });

  it("generates the V6 object from its seed, at least the realistic size and depth", () => {
    const object = answerSubmissionProbeObject(ANSWER_SUBMISSION_PROBE_SEED);
    expect(answerSubmissionProbeObject(ANSWER_SUBMISSION_PROBE_SEED)).toEqual(object);
    const text = JSON.stringify(object);
    expect(text.length).toBeGreaterThanOrEqual(20 * 1024);
    for (const needle of ['\\"', "\\\\", "```", "{inside}", "\\n"]) expect(text).toContain(needle);
    const depth = (value: unknown): number =>
      value && typeof value === "object"
        ? 1 + Math.max(0, ...Object.values(value as object).map(depth))
        : 0;
    expect(depth(object)).toBeGreaterThanOrEqual(5);
  });
});

describe("the probe's streamed tool calls", () => {
  const sse = (deltas: readonly Record<string, unknown>[]) =>
    deltas
      .map((delta) => `data: ${JSON.stringify(chunk(delta))}\n\n`)
      .concat("data: [DONE]\n\n")
      .join("");

  it("keys each delta by index, else by id, as Pi does", () => {
    const turn = parseChatCompletionStream(
      sse([
        { tool_calls: [{ index: 0, id: "a", function: { name: "first", arguments: '{"x"' } }] },
        { tool_calls: [{ index: 1, id: "b", function: { name: "second", arguments: "{" } }] },
        // No index: the id names the call it continues.
        { tool_calls: [{ id: "a", function: { arguments: ":1}" } }] },
        { tool_calls: [{ index: 1, function: { arguments: "}" } }] },
      ]),
    );
    expect(turn.toolCalls).toEqual([
      { name: "first", arguments: '{"x":1}' },
      { name: "second", arguments: "{}" },
    ]);
  });

  it("records bounded SSE call structure separately from assembled calls", () => {
    const first = Array.from({ length: 9 }, (_, index) => ({
      index,
      id: `private-call-id-${String(index)}`,
      type: "function",
      function: { name: "submit_answer_record", arguments: `{"part":${String(index)}` },
    }));
    const fragments = [...first].reverse().map(({ index, function: fn }) => ({
      index,
      function: { arguments: `${fn.arguments}}` },
    }));
    const deltas = [
      { tool_calls: first },
      { tool_calls: fragments },
      // Same index with a new id is observable as a duplicate index delta.
      {
        tool_calls: [
          {
            index: 0,
            id: "private-duplicate-id",
            function: { arguments: " " },
          },
          // Repeated provider ID is counted without retaining the ID itself.
          {
            index: 0,
            id: "private-call-id-0",
            function: { arguments: " " },
          },
          // No index or id cannot be correlated with an earlier call.
          { function: { name: "submit_answer_record", arguments: "private-fragment" } },
        ],
      },
    ];
    const text = [
      ...deltas.map((delta) => `data: ${JSON.stringify(chunk(delta))}\n\n`),
      `data: ${JSON.stringify(chunk({}, "tool_calls"))}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const turn = parseChatCompletionStream(text);

    expect(turn.streamObservation).toEqual({
      streamClass: "done-with-finish",
      eventCount: 4,
      malformedEventCount: 0,
      doneMarkerPresent: true,
      toolCallDeltaCount: 21,
      callStartCount: 10,
      indexedDeltaCount: 20,
      indexlessDeltaCount: 1,
      distinctIndexCount: 9,
      lowestIndex: 0,
      highestIndex: 8,
      duplicateIndexDeltaCount: 11,
      identifiedDeltaCount: 11,
      unidentifiedDeltaCount: 10,
      distinctCallIdCount: 10,
      duplicateCallIdDeltaCount: 1,
      assembledCallCount: 10,
    });
    const summary = JSON.stringify(turn.streamObservation);
    expect(summary).not.toContain("private-call-id");
    expect(summary).not.toContain("private-fragment");
  });

  it("distinguishes malformed, complete, and finish-without-DONE streams without guessing cause", () => {
    const malformed = parseChatCompletionStream("data: {not-json}\n\n");
    expect(malformed.streamObservation).toMatchObject({
      streamClass: "malformed-event",
      malformedEventCount: 1,
      doneMarkerPresent: false,
      assembledCallCount: 0,
    });

    const finished = parseChatCompletionStream(
      `data: ${JSON.stringify(chunk({}, "tool_calls"))}\n\n`,
    );
    expect(finished.streamObservation).toMatchObject({
      streamClass: "finish-without-done",
      malformedEventCount: 0,
      doneMarkerPresent: false,
      eventCount: 1,
    });
  });

  it("hashes a response request identifier and retains no raw identifier", async () => {
    const response = sseResponse([
      chunk({
        tool_calls: [{ index: 0, id: "call-id", function: { name: "x", arguments: "{}" } }],
      }),
      chunk({}, "tool_calls"),
    ]);
    const withId = new Response(response.body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "x-request-id": "private-request-id",
      },
    });
    const turn = await streamChatCompletion(
      releasedProbeProvider("https://probe.example.test/v1", "probe-key"),
      {},
      {
        fetch: (async () => withId) as typeof globalThis.fetch,
        timeoutMs: 5_000,
        errorBodyMaxChars: 400,
        credentialEchoMinChars: 6,
      },
    );

    expect(turn.ok).toBe(true);
    if (!turn.ok) throw new Error("expected successful probe response");
    expect(turn.requestIdentifier).toEqual({
      present: true,
      source: "x-request-id",
      sha256: createHash("sha256").update("private-request-id").digest("hex"),
    });
    expect(JSON.stringify(turn)).not.toContain("private-request-id");
    expect(turn.streamObservation?.streamClass).toBe("done-with-finish");
  });
});

describe("docsfab doctor --live --answer-submission", () => {
  it("adds answerSubmission to the parsed arguments only when the flag is given", () => {
    expect(parseDoctorArguments(["--live", "--answer-submission"])).toEqual({
      live: true,
      answerSubmission: true,
      catalog: false,
      purpose: "policy",
      json: false,
    });
    expect(parseDoctorArguments(["--live"])).not.toHaveProperty("answerSubmission");
    expect(parseDoctorArguments(["--live", "--answer-submission"])).not.toHaveProperty(
      "answerSubmissionTypedContingency",
    );
  });

  it("takes the typed-contingency opt-in only with --answer-submission", () => {
    expect(
      parseDoctorArguments([
        "--live",
        "--answer-submission",
        "--answer-submission-typed-contingency",
      ]),
    ).toMatchObject({ answerSubmission: true, answerSubmissionTypedContingency: true });
    expect(() => parseDoctorArguments(["--live", "--answer-submission-typed-contingency"])).toThrow(
      "requires --live --answer-submission",
    );
  });

  const ULTRA = {
    ...validModelConfig,
    providerId: "nvidia-api-catalog",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    modelId: "nvidia/nemotron-3-ultra-550b-a55b",
    credentialEnv: "DOCSFAB_NVIDIA_API_KEY",
  };

  it("sends every variant with the bound request policy and the effective output limit", async () => {
    const replay = route(faithful);
    vi.stubGlobal("fetch", replay.fetch);
    const effective = (await resolveDoctorModelProfile(ULTRA)).maxOutputTokens;

    const verdict = await probeConfiguredAnswerSubmission(ULTRA);

    expect(verdict.decision).toBe("go");
    expect(replay.requests).toHaveLength(12);
    for (const request of replay.requests) {
      expect(request.body).toMatchObject({
        model: ULTRA.modelId,
        stream: true,
        max_tokens: effective,
        temperature: 0,
        top_p: 1,
        chat_template_kwargs: { thinking: false },
        tool_choice: "required",
      });
      const [system] = request.body.messages as Array<{ role: string; content: string }>;
      expect(system).toEqual({ role: "system", content: DOCSFAB_SYSTEM_PROMPT });
    }
    expect(formatAnswerSubmissionProbe(verdict, "/state/probe.json").join("\n")).toContain(
      "Answer submission probe: GO (12 requests",
    );
  });
});

/** A rejected fetch: the request never got an HTTP response. */
function transportFailure(error: unknown): Promise<Response> {
  return Promise.reject(error);
}

/** A cut connection, as undici reports one: `TypeError: terminated` with the socket error in `cause`. */
function connectionReset(): Promise<Response> {
  return transportFailure(
    new TypeError("terminated", {
      cause: Object.assign(new Error("other side closed"), { code: "ECONNRESET" }),
    }),
  );
}

/**
 * A streamed response that sends `prefix`, then stalls until the request is
 * aborted, which errors the body.
 */
function stalled(init: RequestInit | undefined, prefix = ""): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix) controller.enqueue(new TextEncoder().encode(prefix));
      init?.signal?.addEventListener("abort", () => {
        controller.error(
          Object.assign(new Error("The operation was aborted."), { name: "AbortError" }),
        );
      });
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const STREAMED_PREFIX = `data: ${JSON.stringify(chunk({ role: "assistant" }))}\n\n`;

describe("the probe gate's cause precedence (T-S12)", () => {
  it("names a V6 shell failure before a V6 transport failure in the same variant", async () => {
    const { verdict } = await probeTyped((request, _init, nth) =>
      request.variant !== "V6"
        ? faithful(request)
        : nth === 0
          ? doubleEncoded(request)
          : nth === 1
            ? connectionReset()
            : faithful(request),
    );
    const result = noGo(verdict);
    expect(result.cause).toBe("arguments-not-strict");
    expect(result.stopClass).toBe("provider-compatibility");
    const v6 = result.observation.samples.filter((sample) => sample.variant === "V6");
    expect(v6.some((sample) => sample.transportError === "reset")).toBe(true);
  });

  it("replays the first qualification probe: typed V6 stringified-but-invalid, then HTTP 0", async () => {
    const { verdict } = await probeTyped((request, _init, nth) =>
      request.shell === "untyped"
        ? doubleEncoded(request)
        : request.variant !== "V6"
          ? faithful(request)
          : nth === 0
            ? doubleEncoded(request)
            : connectionReset(),
    );
    expect(noGo(verdict).cause).toBe("arguments-not-strict");
  });

  it("names a missing tool call before an HTTP refusal, and a refusal before transport", async () => {
    const silent = await probe((request, _init, nth) =>
      request.variant === "V3" && nth === 0
        ? new Response("{}", { status: 503 })
        : request.variant === "V3"
          ? textReply("No tool.")
          : faithful(request),
    );
    // V3 stopped at its refusal; the refusal is the cause.
    expect(noGo(silent.verdict).cause).toBe("provider-request-refused");
    // Nothing is sent after the refusal: not the rest of V3, not V4 or V6.
    expect(counts(silent.requests)).toEqual([...Array(3).fill("V1:untyped"), "V3:untyped"]);

    const refusedThenTransport = await probe((request, _init, nth) =>
      request.variant === "V4" && nth === 0
        ? connectionReset()
        : request.variant === "V4" && nth === 1
          ? new Response("{}", { status: 500 })
          : faithful(request),
    );
    expect(noGo(refusedThenTransport.verdict).cause).toBe("provider-request-refused");
    expect(counts(refusedThenTransport.requests)).toEqual([
      ...Array(3).fill("V1:untyped"),
      ...Array(3).fill("V3:untyped"),
      "V4:untyped",
      "V4:untyped",
    ]);
  });

  it("records objectMembers mixed when only some samples of the chosen shell stringify", async () => {
    const { verdict } = await probe((request) =>
      request.variant === "V1" ? stringified(request) : faithful(request),
    );
    expect(go(verdict).capability.objectMembers).toBe("mixed");
  });

  it("counts a duplicate key inside a stringified V3 member as forwarded", async () => {
    const { verdict } = await probe((request) =>
      request.variant === "V3"
        ? callReply(JSON.stringify({ evaluation: request.evaluation, qualityScore: null }))
        : faithful(request),
    );
    const result = go(verdict);
    expect(result.capability.duplicateKeys).toBe("forwarded");
    for (const sample of result.observation.samples.filter((entry) => entry.variant === "V3")) {
      expect(sample).toMatchObject({
        parse: "ok",
        decode: "quality-submission-duplicate-key",
        decodeLocation: "$.evaluation",
        duplicatePresent: true,
      });
    }
  });
});

describe("HTTP 0: transport classes through the cause chain (T-S13)", () => {
  const provider = releasedProbeProvider("https://probe.example.test/v1", "probe-key");
  const options = (fetch: typeof globalThis.fetch, timeoutMs = 5_000, now?: () => number) => ({
    fetch,
    timeoutMs,
    errorBodyMaxChars: 400,
    credentialEchoMinChars: 6,
    ...(now ? { now } : {}),
  });
  async function transportOf(error: unknown) {
    const turn = await streamChatCompletion(
      provider,
      {},
      options((() => Promise.reject(error)) as unknown as typeof globalThis.fetch),
    );
    if (turn.ok || turn.status !== 0) throw new Error("expected HTTP 0");
    return turn.transport!;
  }

  it("classifies a byte bound wrapped in a TypeError", async () => {
    expect(
      (
        await transportOf(
          new TypeError("fetch failed", { cause: new ProviderResponseLimitError(4_096) }),
        )
      ).class,
    ).toBe("byte-bound");
  });

  it.each(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CLOSED", "UND_ERR_ABORTED"])(
    "classifies %s under TypeError('terminated') as reset",
    async (code) => {
      const failure = await transportOf(
        new TypeError("terminated", { cause: Object.assign(new Error("socket"), { code }) }),
      );
      expect(failure).toMatchObject({ class: "reset", errorName: "TypeError" });
    },
  );

  it("classifies a top-level socket code as reset", async () => {
    expect(
      (await transportOf(Object.assign(new Error("socket"), { code: "UND_ERR_SOCKET" }))).class,
    ).toBe("reset");
  });

  it("never infers a timeout from the error's name", async () => {
    for (const name of ["AbortError", "TimeoutError"]) {
      const failure = await transportOf(Object.assign(new Error("aborted"), { name }));
      expect(failure).toMatchObject({ class: "other", errorName: name });
    }
  });

  it("keeps an unknown error as other, by name only", async () => {
    const failure = await transportOf(new RangeError("a secret-looking message"));
    expect(failure).toEqual({
      class: "other",
      errorName: "RangeError",
      elapsedMs: expect.any(Number),
      streamedBytes: 0,
    });
    expect(JSON.stringify(failure)).not.toContain("secret-looking");
  });

  it("classifies the probe's own timer as timeout, whatever error the abort raises, with elapsed time and streamed bytes", async () => {
    let clock = 1_000;
    const fetch = (async (_url: unknown, init?: RequestInit) => {
      clock += 7;
      return stalled(init, STREAMED_PREFIX);
    }) as typeof globalThis.fetch;
    const turn = await streamChatCompletion(
      provider,
      {},
      options(fetch, 20, () => (clock += 5)),
    );
    if (turn.ok || turn.status !== 0) throw new Error("expected HTTP 0");
    expect(turn.transport).toEqual({
      class: "timeout",
      errorName: "AbortError",
      elapsedMs: 12,
      streamedBytes: Buffer.byteLength(STREAMED_PREFIX, "utf8"),
    });
  });

  it("counts the bytes a cut stream delivered before a reset", async () => {
    const fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(STREAMED_PREFIX));
          },
          // The first read takes the prefix; the next finds the connection cut.
          pull(controller) {
            controller.error(
              new TypeError("terminated", {
                cause: Object.assign(new Error("closed"), { code: "UND_ERR_CLOSED" }),
              }),
            );
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-request-id": "private-reset-request-id",
          },
        },
      )) as unknown as typeof globalThis.fetch;
    const turn = await streamChatCompletion(provider, {}, options(fetch));
    if (turn.ok || turn.status !== 0) throw new Error("expected HTTP 0");
    expect(turn.transport).toMatchObject({
      class: "reset",
      streamedBytes: Buffer.byteLength(STREAMED_PREFIX, "utf8"),
    });
    expect(turn.requestIdentifier).toEqual({
      present: true,
      source: "x-request-id",
      sha256: createHash("sha256").update("private-reset-request-id").digest("hex"),
    });
    expect(JSON.stringify(turn)).not.toContain("private-reset-request-id");
  });

  it("sends V6 on the bound attempt timer and every other variant on the request timeout", async () => {
    const { verdict, requests } = await probe(
      (request, init) =>
        request.variant === "V6" ? stalled(init, STREAMED_PREFIX) : faithful(request),
      { largeVariantTimeoutMs: 40, transportRetries: 0 },
    );
    const result = inconclusive(verdict);
    expect(requests.filter((request) => request.variant === "V6")).toHaveLength(3);
    for (const sample of result.observation.samples.filter((entry) => entry.variant === "V6")) {
      expect(sample.transportError).toBe("timeout");
      expect(sample.elapsedMs).toBeGreaterThanOrEqual(39);
      expect(sample.streamedBytes).toBe(Buffer.byteLength(STREAMED_PREFIX, "utf8"));
    }
  });
});

describe("V6 transport retries, timer fit, and inconclusive (T-S15)", () => {
  it("re-sends a V6 transport failure once and is GO when the re-send completes", async () => {
    const { verdict, requests } = await probe((request, _init, nth) =>
      request.variant === "V6" && nth === 0 ? connectionReset() : faithful(request),
    );
    const result = go(verdict);
    expect(requests).toHaveLength(13);
    const samples = result.observation.samples;
    const failed = samples.findIndex((sample) => sample.transportError === "reset");
    expect(samples[failed]).toMatchObject({ variant: "V6", retried: true, retryOf: null });
    expect(samples[failed + 1]).toMatchObject({ variant: "V6", retried: false, retryOf: failed });
  });

  it("spends at most answerSubmissionTransportRetries re-sends, then is inconclusive", async () => {
    expect(limit("endpointProbe.answerSubmissionTransportRetries").value).toBe(2);
    const { verdict, requests } = await probe((request) =>
      request.variant === "V6" ? connectionReset() : faithful(request),
    );
    const result = inconclusive(verdict);
    // Three V6 samples, and two of them re-sent once each.
    expect(requests.filter((request) => request.variant === "V6")).toHaveLength(5);
    expect(result.transportErrors).toHaveLength(5);
    expect(result.transportErrors.filter((failure) => failure.retried)).toHaveLength(2);
    expect(result.nextAction).toBe("Probe again later; transport failures prevented a verdict.");
    expect(result).not.toHaveProperty("stopClass");
  });

  it.each(["V1", "V3", "V4"] as const)(
    "never re-sends a %s transport failure, and is inconclusive",
    async (variant) => {
      const { verdict, requests } = await probe((request, _init, nth) =>
        request.variant === variant && nth === 0 ? connectionReset() : faithful(request),
      );
      inconclusive(verdict);
      expect(requests.filter((request) => request.variant === variant)).toHaveLength(3);
      expect(requests.some((request) => request.variant === "V2")).toBe(false);
    },
  );

  it("is NO-GO timer-fit when a V6 timeout recurs on its re-send while output was streaming", async () => {
    const { verdict, requests } = await probe(
      (request, init) =>
        request.variant === "V6" ? stalled(init, STREAMED_PREFIX) : faithful(request),
      { largeVariantTimeoutMs: 20 },
    );
    const result = noGo(verdict);
    expect(result.cause).toBe("timer-fit");
    expect(requests.filter((request) => request.variant === "V6")).toHaveLength(2);
  });

  it("is inconclusive when V6 stalls with nothing streamed and the budget is spent", async () => {
    const { verdict } = await probe(
      (request, init) => (request.variant === "V6" ? stalled(init) : faithful(request)),
      { largeVariantTimeoutMs: 20 },
    );
    const result = inconclusive(verdict);
    expect(result.transportErrors.every((failure) => failure.class === "timeout")).toBe(true);
    expect(result.transportErrors.every((failure) => failure.streamedBytes === 0)).toBe(true);
  });

  it("never re-sends a byte bound, which is NO-GO", async () => {
    const { verdict, requests } = await probe((request) =>
      request.variant === "V6"
        ? transportFailure(
            new TypeError("fetch failed", { cause: new ProviderResponseLimitError(4_096) }),
          )
        : faithful(request),
    );
    expect(noGo(verdict).cause).toBe("response-byte-bound");
    expect(requests.filter((request) => request.variant === "V6")).toHaveLength(1);
  });
});

describe("doctor's inconclusive verdict (T-S16)", () => {
  it("prints the classes and the observation, emits JSON with no stop class, and exits 1", async () => {
    const { verdict } = await probe((request) =>
      request.variant === "V6" ? connectionReset() : faithful(request),
    );
    const result = inconclusive(verdict);

    const lines = formatAnswerSubmissionProbe(result, "/state/probe.json").join("\n");
    expect(lines).toContain("Answer submission probe: INCONCLUSIVE (14 requests");
    expect(lines).toContain("Transport: V6 reset after");
    expect(lines).toContain(
      "Next action: Probe again later; transport failures prevented a verdict.",
    );
    expect(lines).toContain(
      `Observation: /state/probe.json (evidenceSha256 ${result.evidenceSha256})`,
    );
    expect(lines).not.toContain("provider-compatibility");

    const json = answerSubmissionProbeResult(result, "/state/probe.json");
    expect(json).toMatchObject({
      kind: "docsfab-answer-submission-probe-result",
      decision: "inconclusive",
      reason: result.reason,
      transportErrors: result.transportErrors,
      nextAction: result.nextAction,
      evidenceSha256: result.evidenceSha256,
      observationPath: "/state/probe.json",
    });
    expect(json).not.toHaveProperty("stopClass");
    expect(json).not.toHaveProperty("cause");
    expect(json).not.toHaveProperty("capability");
    expect(answerSubmissionProbeExitCode(result)).toBe(1);
    expect(answerSubmissionProbeExitCode(noGo((await probeTyped(doubleEncoded)).verdict))).toBe(1);
    expect(answerSubmissionProbeExitCode(go((await probe(faithful)).verdict))).toBe(0);
  });

  it("probes V6 on the bound composition's attempt timer, and retries within the limit", async () => {
    const ULTRA_MODEL = {
      ...validModelConfig,
      providerId: "nvidia-api-catalog",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      modelId: "nvidia/nemotron-3-ultra-550b-a55b",
      credentialEnv: "DOCSFAB_NVIDIA_API_KEY",
    };
    const target = await answerSubmissionProbeTarget(ULTRA_MODEL);
    if ("decision" in target) throw new Error("expected a probe target");
    const binding = await resolveOperatorExecutionBinding({ model: ULTRA_MODEL });
    expect(target.largeVariantTimeoutMs).toBe(
      binding.bound!.composition.compositionLimits.timeoutMs,
    );
    expect(target.timeoutMs).toBe(limit("endpointProbe.requestTimeoutMs").value);
    expect(target.transportRetries).toBe(2);
    // The typed-shell contingency is off unless the operator opts in.
    expect(target.typedContingency).toBe(false);
    const optedIn = await answerSubmissionProbeTarget(ULTRA_MODEL, { typedContingency: true });
    if ("decision" in optedIn) throw new Error("expected a probe target");
    expect(optedIn.typedContingency).toBe(true);
  });
});

/** The worst routes a probe can meet, for the spend bound. */
const SPEND_ROUTES: ReadonlyArray<readonly [string, Answer]> = [
  ["faithful", faithful],
  ["every member stringified", stringified],
  [
    "double-encoded untyped members",
    (request) => (request.shell === "untyped" ? doubleEncoded(request) : faithful(request)),
  ],
  ["double-encoded everywhere", doubleEncoded],
  [
    "untyped V4 non-strict",
    (request) =>
      request.variant === "V4" && request.shell === "untyped"
        ? rawLineBreaks(request)
        : faithful(request),
  ],
  [
    "untyped V4 non-strict and every V6 reset",
    (request) =>
      request.variant === "V6"
        ? connectionReset()
        : request.variant === "V4" && request.shell === "untyped"
          ? rawLineBreaks(request)
          : faithful(request),
  ],
  [
    "every V6 reset",
    (request) => (request.variant === "V6" ? connectionReset() : faithful(request)),
  ],
  [
    "V6 in text",
    (request, _init, nth) =>
      request.variant === "V6" && nth === 1 ? textReply("No tool.") : faithful(request),
  ],
  [
    "V1 partly in text",
    (request, _init, nth) =>
      request.variant === "V1" && nth === 0 ? textReply("No tool.") : faithful(request),
  ],
  [
    "V6 cut",
    (request) =>
      request.variant === "V6"
        ? callReply('{"evaluation":{"probe":"V6","fin', "length")
        : faithful(request),
  ],
];

describe("the typed-shell contingency needs an explicit opt-in (B1)", () => {
  it("stops before V2 when V1 is not usable, naming the contingency and its spend", async () => {
    const { verdict, requests } = await probe((request) =>
      request.shell === "untyped" ? doubleEncoded(request) : faithful(request),
    );
    if (verdict.decision !== "contingency-required") throw new Error(verdict.decision);
    expect(counts(requests)).toEqual(Array(3).fill("V1:untyped"));
    expect(verdict.contingencyRequests).toBe(14);
    // A rerun may find V1 usable and then fail untyped V4 or V6, so its bound
    // is the whole plan; 17 is only what a rerun sends if V1 is unusable again.
    expect(verdict.rerunMaxRequests).toBe(26);
    expect(verdict.nextAction).toContain(
      "a rerun sends at most 26 in all (17 if V1 is unusable again)",
    );
    expect(verdict.reason).toContain("V1");
    expect(verdict.nextAction).toContain("--answer-submission-typed-contingency");
    expect(verdict).not.toHaveProperty("stopClass");
    expect(answerSubmissionProbeExitCode(verdict)).toBe(2);
    const json = answerSubmissionProbeResult(verdict, "/state/probe.json");
    expect(json).toMatchObject({
      decision: "contingency-required",
      contingencyRequests: 14,
      rerunMaxRequests: 26,
    });
    expect(json).not.toHaveProperty("stopClass");
    expect(json).not.toHaveProperty("capability");
    expect(formatAnswerSubmissionProbe(verdict, "/state/probe.json").join("\n")).toContain(
      "Answer submission probe: CONTINGENCY REQUIRED (3 requests",
    );
  });

  it.each([
    [
      "V4",
      (request: ProbeRequest) =>
        request.variant === "V4" && request.shell === "untyped"
          ? rawLineBreaks(request)
          : faithful(request),
    ],
    [
      "V6",
      (request: ProbeRequest) =>
        request.variant === "V6" && request.shell === "untyped"
          ? doubleEncoded(request)
          : faithful(request),
    ],
  ] as const)(
    "stops before V2 when V1 is usable but untyped %s is not",
    async (_variant, answer) => {
      const { verdict, requests } = await probe(answer);
      if (verdict.decision !== "contingency-required") throw new Error(verdict.decision);
      expect(requests).toHaveLength(12);
      expect(requests.some((request) => request.shell === "typed")).toBe(false);
      expect(verdict.contingencyRequests).toBe(14);
      // A rerun with the flag re-sends the untyped round before the contingency.
      expect(verdict.rerunMaxRequests).toBe(26);
      expect(verdict.reason).toContain("V4 or V6");
    },
  );

  it.each(SPEND_ROUTES)("sends at most 14 requests without the flag: %s", async (_name, answer) => {
    const { requests } = await probe(answer, { largeVariantTimeoutMs: 20 });
    expect(requests.length).toBeLessThanOrEqual(14);
  });

  it.each(SPEND_ROUTES)("sends at most 26 requests with the flag: %s", async (_name, answer) => {
    const { requests } = await probeTyped(answer, { largeVariantTimeoutMs: 20 });
    expect(requests.length).toBeLessThanOrEqual(26);
  });

  it("sends the expected 17, within the reported 26, when a rerun finds V1 unusable again", async () => {
    const answer: Answer = (request) =>
      request.variant === "V6"
        ? connectionReset()
        : request.shell === "untyped"
          ? doubleEncoded(request)
          : faithful(request);
    const stopped = await probe(answer);
    if (stopped.verdict.decision !== "contingency-required")
      throw new Error(stopped.verdict.decision);
    const { verdict, requests } = await probeTyped(answer);
    expect(stopped.verdict.rerunMaxRequests).toBe(26);
    expect(requests).toHaveLength(17);
    expect(requests.length).toBeLessThanOrEqual(stopped.verdict.rerunMaxRequests);
    inconclusive(verdict);
  });

  it("reaches exactly the reported 26 when a rerun finds V1 usable and untyped V4 failing", async () => {
    // The first run: V1 is unusable, so the probe stops at the shell choice.
    const stopped = await probe((request) =>
      request.shell === "untyped" ? doubleEncoded(request) : faithful(request),
    );
    if (stopped.verdict.decision !== "contingency-required") {
      throw new Error(stopped.verdict.decision);
    }
    expect(stopped.verdict.rerunMaxRequests).toBe(26);
    // The rerun: the route now serves V1 usably, fails untyped V4, and resets
    // every untyped V6 until the retries are spent; typed V6 then completes.
    const { verdict, requests } = await probeTyped((request) =>
      request.variant === "V4" && request.shell === "untyped"
        ? rawLineBreaks(request)
        : request.variant === "V6" && request.shell === "untyped"
          ? connectionReset()
          : faithful(request),
    );
    expect(requests).toHaveLength(stopped.verdict.rerunMaxRequests);
    expect(go(verdict).capability.argumentShell).toBe("typed");
  });

  it("reaches exactly 26 with the flag when untyped V4 fails and every V6 resets", async () => {
    const { verdict, requests } = await probeTyped(SPEND_ROUTES[5]![1]);
    expect(requests).toHaveLength(26);
    inconclusive(verdict);
  });
});

describe("every V4 and V6 sample must be usable (B2)", () => {
  it.each(["V4", "V6"] as const)(
    "is never GO when one completed %s sample answers in text",
    async (variant) => {
      const answer: Answer = (request, _init, nth) =>
        request.variant === variant && nth === 0 ? textReply("No tool.") : faithful(request);
      const untypedOnly = await probe(answer);
      expect(untypedOnly.verdict.decision).toBe("contingency-required");
      const withTyped = await probeTyped(answer);
      expect(noGo(withTyped.verdict).cause).toBe("arguments-not-strict");
    },
  );

  it("names tool-call-not-returned when every completed V6 sample answers in text", async () => {
    const { verdict } = await probeTyped((request) =>
      request.variant === "V6" ? textReply("No tool.") : faithful(request),
    );
    expect(noGo(verdict).cause).toBe("tool-call-not-returned");
  });
});

describe("a V1 sample with no tool call (N6)", () => {
  const partial: Answer = (request, _init, nth) =>
    request.variant === "V1" && nth === 0 ? textReply("No tool.") : faithful(request);

  it("asks for the contingency instead of a transport-free inconclusive", async () => {
    const { verdict } = await probe(partial);
    if (verdict.decision !== "contingency-required") throw new Error(verdict.decision);
    expect(verdict.reason).toContain("no submission call");
  });

  it("qualifies the typed shell with the flag, or names no usable shell", async () => {
    expect(go((await probeTyped(partial)).verdict).capability.argumentShell).toBe("typed");
    const neither = await probeTyped((request, _init, nth) =>
      (request.variant === "V1" || request.variant === "V2") && nth === 0
        ? textReply("No tool.")
        : faithful(request),
    );
    expect(noGo(neither.verdict).cause).toBe("no-usable-shell");
  });
});
