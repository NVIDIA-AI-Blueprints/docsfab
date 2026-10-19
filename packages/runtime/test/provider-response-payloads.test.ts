// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The response boundary checks model identity on the payloads its own reader
 * finds, while Pi's consumers parse the same bytes with their own SSE readers.
 * Any payload a consumer can deliver that the boundary reader does not see
 * escapes the identity check. A different served model is reported, never
 * refused, so the check holds when every foreign-model payload a consumer can
 * deliver is reported. These tests feed seeded, generated SSE bodies through
 * the boundary and through the consumer Pi uses for each transport: the openai
 * SDK's decoder for the openai transports, and Pi's own anthropic-messages
 * parser for Anthropic messages.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { createProviderBoundaryFetch } from "../src/model/provider.js";
import { readProviderResponsePayloads } from "../src/model/provider-response-payloads.js";

interface SseMessage {
  readonly event: string | null;
  readonly data: string;
}
type IterSseMessages = (
  response: Response,
  controller: AbortController,
) => AsyncIterable<SseMessage>;
type AnthropicStream = (
  model: object,
  context: object,
  options: object,
) => { result(): Promise<{ model?: unknown; responseModel?: unknown }> };

// Resolve Pi's dependencies from Pi's own location, so a Pi upgrade tests its
// own consumers.
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));

function piDependencyDirectory(name: string): string {
  for (const base of piRequire.resolve.paths(name) ?? []) {
    const directory = join(base, name);
    if (existsSync(join(directory, "package.json"))) return directory;
  }
  throw new Error(`Pi dependency ${name} is not installed.`);
}

/** The openai SDK decoder behind Pi's openai-completions and openai-responses streams. */
const openaiSseMessages: IterSseMessages = piRequire("openai/core/streaming.js")._iterSSEMessages;

/** Pi's anthropic-messages stream, which parses SSE with its own reader. */
async function loadPiAnthropicStream(): Promise<AnthropicStream> {
  const file = join(
    piDependencyDirectory("@earendil-works/pi-ai"),
    "dist/api/anthropic-messages.js",
  );
  return (await import(pathToFileURL(file).href)).stream as AnthropicStream;
}

const SELECTED = "selected-model";
const FOREIGN = "foreign-model";
const BOM = "\uFEFF";
const BODIES = 300;
const SEED = 0x1676;

/** mulberry32: a small deterministic generator, so every run sees the same bodies. */
function seeded(seed: number): (bound: number) => number {
  let state = seed >>> 0;
  return (bound) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * bound);
  };
}

const pick = <T>(next: (bound: number) => number, items: readonly T[]): T =>
  items[next(items.length)]!;

const PREFIXES = ["", "", "", BOM, `${BOM}${BOM}`, " "];
const LINE_ENDS = ["\n", "\r", "\r\n"];

/** A truncated tail, as a stream cut mid-event leaves it. */
function maybeTruncate(next: (bound: number) => number, body: string): string {
  return next(5) === 0 ? body.slice(0, Math.max(0, body.length - 1 - next(4))) : body;
}

const OPENAI_PAYLOADS = [
  JSON.stringify({ model: FOREIGN, choices: [{ delta: { content: "SMUGGLED" } }] }),
  JSON.stringify({ model: SELECTED, choices: [{ delta: { content: "ok" } }] }),
  JSON.stringify({ choices: [{ delta: { content: "no model" } }] }),
  JSON.stringify({ error: { code: 503, type: "service_unavailable" } }),
  JSON.stringify({ type: "error", error: { code: 503 } }),
  "[DONE]",
  " [DONE]",
  "[DONE] ",
  "",
  "   ",
];
const OPENAI_FIELDS = [
  "data: ",
  "data:",
  "data:  ",
  "data:\t",
  "data",
  "event: thread.run",
  "event: error",
  ": comment",
  "id: 1",
];

function generateOpenaiBody(next: (bound: number) => number): string {
  let body = next(4) === 0 ? BOM : "";
  const events = 1 + next(6);
  for (let event = 0; event < events; event += 1) {
    const lines = 1 + next(3);
    for (let line = 0; line < lines; line += 1) {
      const field = pick(next, OPENAI_FIELDS);
      const value = field.startsWith("data") ? pick(next, OPENAI_PAYLOADS) : "";
      body += pick(next, PREFIXES) + field + value + pick(next, LINE_ENDS);
    }
    if (next(5) !== 0) body += pick(next, LINE_ENDS);
  }
  return maybeTruncate(next, body);
}

const messageStart = (model: string): string =>
  JSON.stringify({
    type: "message_start",
    message: { id: "m", model, usage: { input_tokens: 1, output_tokens: 0 } },
  });
const ANTHROPIC_EVENTS: ReadonlyArray<readonly [string, string]> = [
  ["message_start", messageStart(SELECTED)],
  ["message_start", messageStart(FOREIGN)],
  [
    "content_block_start",
    JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
  ],
  [
    "content_block_delta",
    JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "SMUGGLED" },
    }),
  ],
  [
    "message_delta",
    JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 1 },
    }),
  ],
  ["message_stop", JSON.stringify({ type: "message_stop" })],
  ["error", JSON.stringify({ type: "error", error: { type: "overloaded_error", code: 503 } })],
];

function generateAnthropicBody(next: (bound: number) => number): string {
  let body = next(4) === 0 ? BOM : "";
  const events = 1 + next(7);
  for (let index = 0; index < events; index += 1) {
    if (next(6) === 0) body += `: comment${pick(next, LINE_ENDS)}`;
    const [name, payload] = pick(next, ANTHROPIC_EVENTS);
    body += `${pick(next, PREFIXES)}event: ${name}${pick(next, LINE_ENDS)}`;
    if (next(6) === 0) {
      // One payload split across two data lines, which the consumer joins.
      const cut = 1 + next(payload.length - 1);
      body += `${pick(next, PREFIXES)}data: ${payload.slice(0, cut)}${pick(next, LINE_ENDS)}`;
      body += `${pick(next, PREFIXES)}data: ${payload.slice(cut)}${pick(next, LINE_ENDS)}`;
    } else {
      body += `${pick(next, PREFIXES)}data: ${payload}${pick(next, LINE_ENDS)}`;
    }
    // The consumer also delivers a final event with no closing blank line.
    if (index < events - 1 || next(3) !== 0) body += pick(next, LINE_ENDS);
  }
  return maybeTruncate(next, body);
}

/** The body as a stream cut at the given byte offsets, as a network delivers it. */
function chunkedResponse(bytes: Uint8Array, cuts: readonly number[]): Response {
  const offsets = [...new Set(cuts.filter((cut) => cut > 0 && cut < bytes.length))].sort(
    (left, right) => left - right,
  );
  const chunks: Uint8Array[] = [];
  let previous = 0;
  for (const offset of [...offsets, bytes.length]) {
    chunks.push(bytes.slice(previous, offset));
    previous = offset;
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * Every payload the openai SDK decoder can hand to its consumer: each event's
 * data that parses as JSON. Stopping at `[DONE]` or at a parse failure, as the
 * SDK does, only removes payloads, so this is a superset of what it delivers.
 */
async function openaiPayloads(bytes: Uint8Array, cuts: readonly number[]): Promise<string[]> {
  const payloads: string[] = [];
  for await (const message of openaiSseMessages(
    chunkedResponse(bytes, cuts),
    new AbortController(),
  )) {
    try {
      payloads.push(JSON.stringify(JSON.parse(message.data)));
    } catch {
      // Not JSON, so the SDK delivers no payload for it.
    }
  }
  return payloads;
}

/** The body text as the boundary decodes it. */
function boundaryText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * The response the real boundary admits for `bytes`, or `undefined` when it
 * refuses, and whether it reported the foreign model as served.
 */
async function throughBoundary(
  bytes: Uint8Array,
  transport: "openai-chat-completions" | "anthropic-messages",
): Promise<{ response: Response | undefined; reportedForeign: boolean }> {
  let reportedForeign = false;
  const boundary = createProviderBoundaryFetch(
    "https://provider.test/v1",
    async () => chunkedResponse(bytes, []),
    {
      expectedModel: SELECTED,
      transport,
      maxResponseBytes: 65_536,
      onServedModel: (observation) => {
        if (observation.servedModels.includes(FOREIGN)) reportedForeign = true;
      },
    },
  );
  try {
    return {
      response: await boundary("https://provider.test/v1/messages", {}),
      reportedForeign,
    };
  } catch {
    return { response: undefined, reportedForeign };
  }
}

describe("readProviderResponsePayloads", () => {
  it.each([
    ["a bare CR", `data: {"a":1}\rdata: {"b":2}\r\r`, [{ a: 1 }, { b: 2 }]],
    ["a per-line byte order mark", `: c\n\n${BOM}data: {"a":1}\n\n`, [{ a: 1 }]],
    ["a body-start byte order mark", `${BOM}data: {"a":1}\n\n`, [{ a: 1 }]],
    ["two byte order marks", `: c\n\n${BOM}${BOM}data: {"a":1}\n\n`, [{ a: 1 }]],
  ])("reads a data line after %s", (_label, text, payloads) => {
    expect(readProviderResponsePayloads(text)?.payloads).toEqual(payloads);
  });

  it("flags data after the terminator and still reads it", () => {
    expect(readProviderResponsePayloads('data: [DONE]\n\ndata: {"a":1}\n\n')).toEqual({
      stream: true,
      payloads: [{ a: 1 }],
      dataAfterDone: true,
    });
  });
});

describe("the boundary against the openai SDK decoder Pi uses (seeded differential)", () => {
  it("sees every payload the decoder can deliver, across chunk splits", async () => {
    const next = seeded(SEED);
    const encoder = new TextEncoder();
    let compared = 0;
    const missed: string[] = [];
    for (let index = 0; index < BODIES; index += 1) {
      const bytes = encoder.encode(generateOpenaiBody(next));
      const read = readProviderResponsePayloads(boundaryText(bytes));
      const cuts = [next(bytes.length + 1), next(bytes.length + 1), next(bytes.length + 1)];
      // A refused body reaches no consumer.
      if (read === undefined) continue;
      compared += 1;
      const seen = new Set(read.payloads.map((payload) => JSON.stringify(payload)));
      for (const payload of await openaiPayloads(bytes, cuts)) {
        if (!seen.has(payload)) missed.push(`body ${index}: ${payload}`);
      }
    }
    expect(missed).toEqual([]);
    // Positive control: the generator produced bodies the reader admits.
    expect(compared).toBeGreaterThan(BODIES / 4);
  });

  it("reports every foreign model's chunk the decoder can deliver through the real boundary", async () => {
    const next = seeded(SEED + 1);
    const encoder = new TextEncoder();
    const unreported: string[] = [];
    let admitted = 0;
    let deliveredForeign = 0;
    for (let index = 0; index < BODIES; index += 1) {
      const { response, reportedForeign } = await throughBoundary(
        encoder.encode(generateOpenaiBody(next)),
        "openai-chat-completions",
      );
      if (!response) continue;
      admitted += 1;
      const passed = new Uint8Array(await response.arrayBuffer());
      const cuts = [next(passed.length + 1), next(passed.length + 1)];
      for (const payload of await openaiPayloads(passed, cuts)) {
        if ((JSON.parse(payload) as { model?: unknown }).model !== FOREIGN) continue;
        deliveredForeign += 1;
        if (!reportedForeign) unreported.push(`body ${index}: ${payload}`);
      }
    }
    expect(unreported).toEqual([]);
    // Positive controls: bodies were admitted, and some delivered a foreign chunk.
    expect(admitted).toBeGreaterThan(BODIES / 10);
    expect(deliveredForeign).toBeGreaterThan(0);
  });
});

describe("the boundary against Pi's anthropic-messages parser (seeded differential)", () => {
  it("reports every foreign model's message Pi can land through the real boundary", async () => {
    const piStream = await loadPiAnthropicStream();
    const model = {
      id: SELECTED,
      name: SELECTED,
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://provider.test/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_192,
      maxTokens: 64,
    };
    const context = {
      systemPrompt: "Reply.",
      messages: [{ role: "user", content: "Reply.", timestamp: 1 }],
      tools: [],
    };
    const next = seeded(SEED + 2);
    const encoder = new TextEncoder();
    const unreported: string[] = [];
    let admitted = 0;
    let landedSelected = 0;
    let landedForeign = 0;
    for (let index = 0; index < BODIES; index += 1) {
      const body = generateAnthropicBody(next);
      // Pi reads exactly the response the boundary hands on.
      const { response, reportedForeign } = await throughBoundary(
        encoder.encode(body),
        "anthropic-messages",
      );
      if (!response) continue;
      admitted += 1;
      // Pi sends through the SDK's beta messages client.
      const create = () => ({ asResponse: async () => response });
      const client = { beta: { messages: { create } }, messages: { create } };
      const message = await piStream(model, context, { client }).result();
      // Pi keeps the requested id in `model` and puts a different
      // `message_start` model in `responseModel`.
      if (message.responseModel === FOREIGN) {
        landedForeign += 1;
        if (!reportedForeign) unreported.push(`body ${index}: ${JSON.stringify(body)}`);
      }
      if (message.model === SELECTED) landedSelected += 1;
    }
    expect(unreported).toEqual([]);
    // Positive controls: bodies were admitted, and Pi parsed each identity from some.
    expect(admitted).toBeGreaterThan(BODIES / 10);
    expect(landedSelected).toBeGreaterThan(0);
    expect(landedForeign).toBeGreaterThan(0);
  });
});
