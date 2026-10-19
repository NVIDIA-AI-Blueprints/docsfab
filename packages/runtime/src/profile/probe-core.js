// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The serving-route probe stack: one chat-completions client and the probes
 * built on it. `docsfab profile probe --live`, `docsfab doctor --live`, and the
 * model-matrix scripts share this module; do not add a second HTTP probe.
 *
 * Plain JavaScript so plain-node matrix scripts and the installed package
 * load the same bytes. Callers pass every bound, the credential released for
 * the probed endpoint, and the `fetch` that enforces their network boundary;
 * nothing here reads the environment or writes a response body out.
 */
import { createHash } from "node:crypto";

import { redactCredentialMaterial } from "../security/credential-material-core.js";
import { credentialForRequest } from "../security/model-credential-release.js";

function textField(value, key) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const field = value[key];
  return typeof field === "string" && field.trim().length > 0 ? field : undefined;
}

/** The provider's own sentence from a whole OpenAI, problem-details, or plain body. */
export function providerErrorMessage(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  const error = parsed?.error;
  return (
    textField(error, "message") ??
    (typeof error === "string" && error.trim().length > 0 ? error : undefined) ??
    textField(parsed, "detail") ??
    textField(parsed, "message") ??
    textField(parsed, "title") ??
    body
  );
}

// Invisible to a reader, or a break that does not change the token around it:
// controls (including line breaks), format characters (zero-width, bidi), and
// space, line, and paragraph separators.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Z}]/u;
const INVISIBLE_ALL = /[\p{Cc}\p{Cf}\p{Z}]/gu;
const JSON_ESCAPES = Object.freeze({
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
});

function hexAt(text, start, digits) {
  const hex = text.slice(start, start + digits);
  return hex.length === digits && /^[0-9A-Fa-f]+$/u.test(hex)
    ? String.fromCharCode(Number.parseInt(hex, 16))
    : undefined;
}

// An HTML numeric character reference, as an error page writes a reserved character.
const HTML_REFERENCE = /&#(?:[xX]([0-9A-Fa-f]{1,4})|([0-9]{1,5}));/y;

function htmlReferenceAt(text, index) {
  HTML_REFERENCE.lastIndex = index;
  const match = HTML_REFERENCE.exec(text);
  if (!match) return undefined;
  const code = match[1] === undefined ? Number(match[2]) : Number.parseInt(match[1], 16);
  // One UTF-16 unit, so each comparison character stays one unit wide.
  return code <= 0xffff ? [String.fromCharCode(code), match[0].length] : undefined;
}

/**
 * One reading of `text` as comparison characters, each with the source span
 * it came from. The decoded reading undoes percent-encoding, JSON escapes, and
 * HTML numeric character references.
 * Invisible characters are skipped, so a run that matches across them maps to
 * one span that includes them.
 */
function readingOf(text, decode) {
  let chars = "";
  const starts = [];
  const ends = [];
  let index = 0;
  while (index < text.length) {
    let char = text[index];
    let width = 1;
    if (decode && char === "%") {
      const decoded = hexAt(text, index + 1, 2);
      if (decoded !== undefined) [char, width] = [decoded, 3];
    } else if (decode && char === "&") {
      const decoded = htmlReferenceAt(text, index);
      if (decoded !== undefined) [char, width] = decoded;
    } else if (decode && char === "\\") {
      const next = text[index + 1];
      const decoded = next === "u" ? hexAt(text, index + 2, 4) : undefined;
      if (decoded !== undefined) [char, width] = [decoded, 6];
      else if (next !== undefined && Object.hasOwn(JSON_ESCAPES, next)) {
        [char, width] = [JSON_ESCAPES[next], 2];
      }
    }
    if (!INVISIBLE.test(char)) {
      chars += char;
      starts.push(index);
      ends.push(index + width);
    }
    index += width;
  }
  return { chars, starts, ends };
}

/**
 * Source spans of every run of at least `width` characters that also appears
 * in the credential. A run is covered by overlapping windows that each appear
 * there, so a stitched run is removed too: removing more is the safe error.
 */
function echoSpans(text, windows, width, decode) {
  const { chars, starts, ends } = readingOf(text, decode);
  const spans = [];
  let first = -1;
  let last = -1;
  for (let index = 0; index + width <= chars.length; index += 1) {
    if (!windows.has(chars.slice(index, index + width))) continue;
    if (first >= 0 && index <= last) {
      last = index + width;
      continue;
    }
    if (first >= 0) spans.push([starts[first], ends[last - 1]]);
    first = index;
    last = index + width;
  }
  if (first >= 0) spans.push([starts[first], ends[last - 1]]);
  return spans;
}

/**
 * Provider text with the probe credential removed: every run of at least
 * `echoMinChars` characters copied from it, whether written raw, JSON-escaped,
 * percent-encoded, or as HTML character references, and split or not by
 * invisible characters, plus every
 * credential shape. Every path that carries provider text toward a report
 * calls this before it bounds or strips the text, so a cut cannot leave a
 * fragment the match would have caught.
 */
export function redactProviderText(text, apiKey, echoMinChars) {
  if (!Number.isSafeInteger(echoMinChars) || echoMinChars < 1) {
    throw new TypeError("redactProviderText needs a positive credential echo minimum.");
  }
  const key = typeof apiKey === "string" ? apiKey.replace(INVISIBLE_ALL, "") : "";
  let output = text;
  if (key.length > 0) {
    const width = Math.min(echoMinChars, key.length);
    const windows = new Set();
    for (let index = 0; index + width <= key.length; index += 1) {
      windows.add(key.slice(index, index + width));
    }
    const spans = [
      ...echoSpans(text, windows, width, false),
      ...echoSpans(text, windows, width, true),
    ].sort((left, right) => left[0] - right[0]);
    const merged = [];
    for (const [start, end] of spans) {
      const previous = merged.at(-1);
      if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
      else merged.push([start, end]);
    }
    output = "";
    let cursor = 0;
    for (const [start, end] of merged) {
      output += `${text.slice(cursor, start)}[REDACTED]`;
      cursor = end;
    }
    output += text.slice(cursor);
  }
  return redactCredentialMaterial(output);
}

/**
 * The provider's message from a whole refused body, redacted before the
 * character bound applies, so truncation cannot leave a key unrecognizable.
 */
export function boundedErrorBody(text, apiKey, maxChars, echoMinChars) {
  const redact = (value) => redactProviderText(value, apiKey, echoMinChars);
  const redacted = redact(providerErrorMessage(redact(text)));
  return { body: redacted.slice(0, maxChars), bodyTruncated: redacted.length > maxChars };
}

/**
 * Error codes, on any link of an error's `cause` chain, that mean the
 * connection was cut before the response finished. Undici reports a cut body
 * as `TypeError: terminated` and carries the socket's own error in `cause`.
 */
const RESET_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_ABORTED",
]);

/** The error and each `.cause` under it, once each. */
function causeChain(error) {
  const chain = [];
  const seen = new Set();
  for (let link = error; link && typeof link === "object" && !seen.has(link); link = link.cause) {
    seen.add(link);
    chain.push(link);
  }
  return chain;
}

/**
 * Closed class of a request that ended without an HTTP response (status 0).
 * `timeout` comes only from the probe's own timer, never from the error's
 * name; then the `cause` chain is read for the boundary fetch's byte bound
 * and for a cut connection. Anything else is `other`.
 */
export function transportErrorClass(error, timedOut) {
  if (timedOut) return "timeout";
  const chain = causeChain(error);
  if (chain.some((link) => link.code === "provider-response-too-large")) return "byte-bound";
  if (chain.some((link) => typeof link.code === "string" && RESET_CODES.has(link.code))) {
    return "reset";
  }
  return "other";
}

/** Read a response body, counting the bytes received as they arrive. */
async function readBody(response, counted) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    counted(new TextEncoder().encode(text).byteLength);
    return text;
  }
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    counted(value.byteLength);
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * POST one chat-completions request and return its status and body. A request
 * that ends without an HTTP response returns status 0 with `transport`: its
 * closed error class, the milliseconds it ran, and the response bytes that had
 * arrived. Only the error's name is kept there, never its message.
 */
export async function postChatCompletion({
  baseUrl,
  credential,
  body,
  timeoutMs,
  errorBodyMaxChars,
  credentialEchoMinChars,
  stream = false,
  fetch: send = globalThis.fetch,
  now = Date.now,
}) {
  const requestUrl = `${baseUrl.replace(/\/$/u, "")}/chat/completions`;
  // The probe client's one read of the key: for this request's origin only.
  const apiKey = credentialForRequest(credential, requestUrl);
  const controller = new AbortController();
  const startedAt = now();
  let timedOut = false;
  let streamedBytes = 0;
  let requestIdentifier = { present: false, source: null, sha256: null };
  const timer = setTimeout(() => {
    // Set before the abort, so the class never depends on the error it causes.
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await send(requestUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      // A redirect is reported, never followed: it would resend the credential.
      redirect: "manual",
      signal: controller.signal,
    });
    requestIdentifier = hashResponseIdentifier(response.headers);
    const text = await readBody(response, (bytes) => {
      streamedBytes += bytes;
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        responseBytes: streamedBytes,
        requestIdentifier,
        ...boundedErrorBody(text, apiKey, errorBodyMaxChars, credentialEchoMinChars),
      };
    }
    if (stream) {
      return {
        ok: true,
        status: response.status,
        contentType: response.headers?.get?.("content-type") ?? "",
        responseBytes: streamedBytes,
        requestIdentifier,
        text,
      };
    }
    try {
      return { ok: true, status: response.status, json: JSON.parse(text) };
    } catch {
      // The parser's message quotes the body's first characters, before any
      // redaction could run, so the report names only the byte count.
      const bytes = new TextEncoder().encode(text).byteLength;
      return {
        ok: false,
        status: response.status,
        responseBytes: streamedBytes,
        requestIdentifier,
        body: `The reply was not valid JSON (${bytes} bytes).`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      ...boundedErrorBody(
        `${error.name}: ${error.message}`,
        apiKey,
        errorBodyMaxChars,
        credentialEchoMinChars,
      ),
      responseBytes: streamedBytes,
      requestIdentifier,
      transport: {
        class: transportErrorClass(error, timedOut),
        errorName: typeof error?.name === "string" ? error.name : "Error",
        elapsedMs: Math.max(0, now() - startedAt),
        streamedBytes,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Hash a provider request identifier without retaining its raw value. */
function hashResponseIdentifier(headers) {
  for (const name of ["x-request-id", "request-id"]) {
    const value = headers?.get?.(name);
    if (typeof value === "string" && value.length > 0) {
      return {
        present: true,
        source: name,
        sha256: createHash("sha256").update(value, "utf8").digest("hex"),
      };
    }
  }
  return { present: false, source: null, sha256: null };
}

/**
 * Reasoning is prompt-dependent: nemotron-3-ultra returned reasoning_content
 * for "say hi" and plain content for "reply with one short sentence" on the
 * same endpoint minutes apart. Treat a split seen in ANY sample as present.
 */
export const DEFAULT_PROMPTS = [
  "Reply with one short sentence.",
  "A CLI resolves plugins across four layers: local, global, installed, builtin. A higher layer shadows a lower one. Which layer wins for an unqualified name, and why? Answer in two sentences.",
];

/**
 * Some models return text in `reasoning_content` and leave `content` empty.
 * The Pi harness reads `content`.
 */
export function shapeOf(json) {
  const message = json?.choices?.[0]?.message ?? {};
  const content = typeof message.content === "string" ? message.content : "";
  const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
  return {
    contentPopulated: content.trim().length > 0,
    reasoningPresent: reasoning.length > 0,
    keys: Object.keys(message).sort(),
    reasoningSplit: reasoning.length > 0 && content.trim().length === 0,
  };
}

export async function probeOnce(model, provider, promptText, extraBody, options) {
  const result = await postChatCompletion({
    baseUrl: provider.baseUrl,
    credential: provider.credential,
    timeoutMs: options.timeoutMs,
    errorBodyMaxChars: options.errorBodyMaxChars,
    credentialEchoMinChars: options.credentialEchoMinChars,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    body: {
      model,
      messages: [{ role: "user", content: promptText }],
      [options.tokenField ?? "max_tokens"]: options.sampleMaxTokens,
      ...extraBody,
    },
  });
  if (!result.ok) {
    return {
      reachable: false,
      status: result.status,
      error: result.body,
      errorTruncated: result.bodyTruncated === true,
    };
  }
  return { reachable: true, status: result.status, ...shapeOf(result.json) };
}

/** A client-side refusal that another prompt cannot change (not 408 or 429). */
function isTerminalRefusal(sample) {
  return (
    !sample.reachable &&
    sample.status >= 400 &&
    sample.status < 500 &&
    sample.status !== 408 &&
    sample.status !== 429
  );
}

/**
 * Worst case across prompts: any observed split makes the model split. A
 * terminal refusal, such as a retired model's 410, ends the samples.
 */
export async function probeOne(model, provider, extraBody, prompts, options) {
  const samples = [];
  for (const promptText of prompts) {
    const sample = await probeOnce(model, provider, promptText, extraBody, options);
    samples.push(sample);
    if (isTerminalRefusal(sample)) break;
  }
  const reachable = samples.filter((sample) => sample.reachable);
  if (reachable.length === 0) {
    return {
      reachable: false,
      status: samples[0]?.status ?? 0,
      error: samples[0]?.error,
      errorTruncated: samples[0]?.errorTruncated === true,
      samples,
    };
  }
  return {
    reachable: true,
    status: reachable[0].status,
    reasoningSplit: reachable.some((sample) => sample.reasoningSplit),
    reasoningPresent: reachable.some((sample) => sample.reasoningPresent),
    contentPopulated: reachable.every((sample) => sample.contentPopulated),
    keys: [...new Set(reachable.flatMap((sample) => sample.keys))].sort(),
    samples: reachable.length,
    splitSamples: reachable.filter((sample) => sample.reasoningSplit).length,
  };
}

export function decideVerdict(plain, noThink) {
  if (!plain.reachable) return "unreachable";
  if (plain.reasoningSplit) {
    return noThink?.contentPopulated
      ? "reasoning-split-controllable"
      : "reasoning-split-uncontrolled";
  }
  return "harness-compatible";
}

export const COMPATIBILITY_TOOL_NAME = "record_probe_result";

const COMPATIBILITY_TOOLS = Object.freeze([
  {
    type: "function",
    function: {
      name: COMPATIBILITY_TOOL_NAME,
      description: "Record the endpoint probe result.",
      parameters: {
        type: "object",
        properties: { result: { type: "string", enum: ["ok"] } },
        required: ["result"],
        additionalProperties: false,
      },
    },
  },
]);

export const COMPATIBILITY_TOOL_PROMPT = `Call the ${COMPATIBILITY_TOOL_NAME} tool with result "ok". Do not answer in text.`;

export const COMPATIBILITY_JSON_PROMPT =
  'Reply with only this JSON object and no other text: {"result":"ok","checks":["tool-calls","structured-output"]}';

/**
 * The two requests DocsFab's harness shape needs: a streamed tool-bearing turn
 * and a streamed JSON answer, each with the caller's output limit. The token
 * field, instruction role, and `store` flag follow the caller's route so the
 * probe sends what DocsFab's provider sends there.
 */
export function compatibilityRequestBodies(
  model,
  { maxTokens, systemPrompt, tokenField = "max_tokens", systemRole = "system", store = false },
) {
  const request = (prompt, tools) => ({
    model,
    messages: [
      { role: systemRole, content: systemPrompt },
      { role: "user", content: prompt },
    ],
    stream: true,
    stream_options: { include_usage: true },
    ...(store ? { store: false } : {}),
    [tokenField]: maxTokens,
    ...(tools ? { tools: structuredClone(tools), tool_choice: "auto" } : {}),
  });
  return {
    toolCall: request(COMPATIBILITY_TOOL_PROMPT, COMPATIBILITY_TOOLS),
    structuredOutput: request(COMPATIBILITY_JSON_PROMPT),
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function emptyTurn() {
  return {
    events: 0,
    done: false,
    malformedEvents: 0,
    errorEvent: undefined,
    content: "",
    reasoningPresent: false,
    toolCalls: [],
    streamObservation: emptyStreamObservation(),
    finishReason: null,
    completionTokens: null,
  };
}

/** Bounded counters only: production response bytes are capped at the shared response limit. */
function emptyStreamObservation() {
  return {
    streamClass: "empty",
    eventCount: 0,
    malformedEventCount: 0,
    doneMarkerPresent: false,
    toolCallDeltaCount: 0,
    callStartCount: 0,
    indexedDeltaCount: 0,
    indexlessDeltaCount: 0,
    distinctIndexCount: 0,
    lowestIndex: null,
    highestIndex: null,
    duplicateIndexDeltaCount: 0,
    identifiedDeltaCount: 0,
    unidentifiedDeltaCount: 0,
    distinctCallIdCount: 0,
    duplicateCallIdDeltaCount: 0,
    assembledCallCount: 0,
  };
}

function readErrorEvent(error) {
  return {
    message: typeof error.message === "string" ? error.message : "",
    type: typeof error.type === "string" ? error.type : "",
    code: typeof error.code === "number" ? error.code : null,
  };
}

const FINISH_REASONS = new Set(["stop", "length", "tool_calls", "content_filter", "function_call"]);

/**
 * The finish reason as a closed word. Any other provider string becomes
 * `unrecognized`, so provider text never reaches a report through it.
 */
function readFinishReason(value) {
  if (typeof value !== "string") return null;
  return FINISH_REASONS.has(value) ? value : "unrecognized";
}

function readCompletionTokens(usage) {
  return isRecord(usage) && Number.isSafeInteger(usage.completion_tokens)
    ? usage.completion_tokens
    : null;
}

/** Assemble one streamed chat completion from its server-sent events. */
export function parseChatCompletionStream(text) {
  const turn = emptyTurn();
  const calls = { entries: [], byIndex: new Map(), byId: new Map() };
  for (const block of text.split(/\r?\n\r?\n/u)) {
    const data = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /u, ""))
      .join("\n");
    if (data === "") continue;
    if (data === "[DONE]") {
      turn.done = true;
      continue;
    }
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      turn.malformedEvents += 1;
      continue;
    }
    turn.events += 1;
    if (!isRecord(chunk)) continue;
    if (isRecord(chunk.error)) {
      turn.errorEvent ??= readErrorEvent(chunk.error);
      continue;
    }
    turn.completionTokens = readCompletionTokens(chunk.usage) ?? turn.completionTokens;
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!isRecord(choice)) continue;
    const delta = isRecord(choice.delta) ? choice.delta : {};
    if (typeof delta.content === "string") turn.content += delta.content;
    for (const key of ["reasoning_content", "reasoning"]) {
      if (typeof delta[key] === "string" && delta[key].length > 0) turn.reasoningPresent = true;
    }
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      if (!isRecord(call)) continue;
      turn.streamObservation.toolCallDeltaCount += 1;
      const index = Number.isSafeInteger(call.index) ? call.index : undefined;
      const id = typeof call.id === "string" && call.id.length > 0 ? call.id : undefined;
      if (index === undefined) turn.streamObservation.indexlessDeltaCount += 1;
      else {
        turn.streamObservation.indexedDeltaCount += 1;
        if (calls.byIndex.has(index)) turn.streamObservation.duplicateIndexDeltaCount += 1;
        else {
          turn.streamObservation.lowestIndex =
            turn.streamObservation.lowestIndex === null
              ? index
              : Math.min(turn.streamObservation.lowestIndex, index);
          turn.streamObservation.highestIndex =
            turn.streamObservation.highestIndex === null
              ? index
              : Math.max(turn.streamObservation.highestIndex, index);
        }
      }
      if (id === undefined) turn.streamObservation.unidentifiedDeltaCount += 1;
      else {
        turn.streamObservation.identifiedDeltaCount += 1;
        if (calls.byId.has(id)) turn.streamObservation.duplicateCallIdDeltaCount += 1;
      }
      const startsBefore = calls.entries.length;
      const entry = toolCallEntry(calls, call);
      if (calls.entries.length > startsBefore) turn.streamObservation.callStartCount += 1;
      const fn = isRecord(call.function) ? call.function : {};
      if (typeof fn.name === "string") entry.name += fn.name;
      if (typeof fn.arguments === "string") entry.arguments += fn.arguments;
    }
    turn.finishReason = readFinishReason(choice.finish_reason) ?? turn.finishReason;
  }
  turn.toolCalls = calls.entries.map(({ name, arguments: args }) => ({ name, arguments: args }));
  turn.streamObservation = {
    ...turn.streamObservation,
    streamClass: turn.errorEvent
      ? "provider-error-event"
      : turn.malformedEvents > 0
        ? "malformed-event"
        : turn.done && turn.finishReason !== null
          ? "done-with-finish"
          : turn.done
            ? "done-without-finish"
            : turn.finishReason !== null
              ? "finish-without-done"
              : turn.events > 0
                ? "events-without-terminal"
                : "empty",
    eventCount: turn.events,
    malformedEventCount: turn.malformedEvents,
    doneMarkerPresent: turn.done,
    distinctIndexCount: calls.byIndex.size,
    distinctCallIdCount: calls.byId.size,
    assembledCallCount: calls.entries.length,
  };
  return turn;
}

/**
 * The streamed tool call a delta continues, keyed as Pi keys it: by `index`
 * when the delta carries one, else by `id`; a delta matching neither starts a
 * new call. Calls keep the order they started in.
 */
function toolCallEntry(calls, call) {
  const index = Number.isSafeInteger(call.index) ? call.index : undefined;
  const id = typeof call.id === "string" && call.id.length > 0 ? call.id : undefined;
  let entry = index !== undefined ? calls.byIndex.get(index) : undefined;
  if (!entry && id !== undefined) entry = calls.byId.get(id);
  if (!entry) {
    entry = { name: "", arguments: "" };
    calls.entries.push(entry);
  }
  if (index !== undefined && !calls.byIndex.has(index)) calls.byIndex.set(index, entry);
  if (id !== undefined) calls.byId.set(id, entry);
  return entry;
}

/** Read a non-streamed completion that arrived where a stream was requested. */
function parseCompletionDocument(text) {
  const turn = emptyTurn();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const choice = Array.isArray(json?.choices) ? json.choices[0] : undefined;
  if (!isRecord(choice)) return undefined;
  const message = isRecord(choice.message) ? choice.message : {};
  turn.content = typeof message.content === "string" ? message.content : "";
  turn.reasoningPresent =
    typeof message.reasoning_content === "string" && message.reasoning_content.length > 0;
  turn.toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : [])
    .filter((call) => isRecord(call) && isRecord(call.function))
    .map((call) => ({
      name: typeof call.function.name === "string" ? call.function.name : "",
      arguments: typeof call.function.arguments === "string" ? call.function.arguments : "",
    }));
  turn.streamObservation = {
    ...emptyStreamObservation(),
    streamClass: "non-sse-response",
    assembledCallCount: turn.toolCalls.length,
  };
  turn.finishReason = readFinishReason(choice.finish_reason);
  turn.completionTokens = readCompletionTokens(json.usage);
  return turn;
}

/**
 * POST one streamed chat-completions request and assemble its turn. The
 * answer-submission probe (`docsfab doctor --live --answer-submission`) sends
 * its own request bodies through this same client.
 */
export async function streamChatCompletion(provider, body, options) {
  return streamOnce(provider, body, options);
}

async function streamOnce(provider, body, options) {
  const result = await postChatCompletion({
    baseUrl: provider.baseUrl,
    credential: provider.credential,
    body,
    stream: true,
    timeoutMs: options.timeoutMs,
    errorBodyMaxChars: options.errorBodyMaxChars,
    credentialEchoMinChars: options.credentialEchoMinChars,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      body: result.body,
      bodyTruncated: result.bodyTruncated === true,
      responseBytes: result.responseBytes ?? result.transport?.streamedBytes ?? 0,
      requestIdentifier: result.requestIdentifier ?? { present: false, source: null, sha256: null },
      streamClass: result.status === 0 ? "transport-error" : "http-error",
      ...(result.transport ? { transport: result.transport } : {}),
    };
  }
  const eventStream =
    /text\/event-stream/iu.test(result.contentType) || /^\s*data:/u.test(result.text);
  const turn = eventStream
    ? parseChatCompletionStream(result.text)
    : (parseCompletionDocument(result.text) ?? emptyTurn());
  if (!eventStream && turn.streamObservation.streamClass === "empty") {
    turn.streamObservation = { ...turn.streamObservation, streamClass: "unparsed-response" };
  }
  return {
    ok: true,
    status: result.status,
    eventStream,
    responseBytes: result.responseBytes,
    requestIdentifier: result.requestIdentifier,
    ...turn,
  };
}

/**
 * Send the tool-bearing turn, then the JSON turn. A refused first request
 * ends the probe: the refusal is the finding, and a second request would only
 * spend on the same refusal.
 */
export async function probeCompatibility(model, provider, options) {
  const bodies = compatibilityRequestBodies(model, options);
  const finalize = options.finalizeBody ?? ((body) => body);
  const extraBody = options.extraBody ?? {};
  const toolCall = await streamOnce(
    provider,
    finalize({ ...bodies.toolCall, ...extraBody }),
    options,
  );
  if (!toolCall.ok) return { toolCall, structuredOutput: null };
  const structuredOutput = await streamOnce(
    provider,
    finalize({ ...bodies.structuredOutput, ...extraBody }),
    options,
  );
  return { toolCall, structuredOutput };
}
